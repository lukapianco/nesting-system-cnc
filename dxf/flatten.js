// dxf/flatten.js — documento DXF -> caminhos geométricos exatos no plano XY do mundo, em milímetros.
//
// * Expande INSERT aninhados (inclusive matrizes associativas e blocos dinâmicos, que o AutoCAD grava como
//   blocos anônimos *U), MINSERT (linhas x colunas), escala negativa (espelhamento), rotação e ponto base.
// * Aplica o OCS (vetor de extrusão, "Arbitrary Axis Algorithm"): ARC/CIRCLE/LWPOLYLINE/INSERT com extrusão
//   (0,0,-1) — comum em peças espelhadas — saem no lugar certo.
// * Converte unidades ($INSUNITS) para mm.
// * Mantém as curvas EXATAS (reta, arco/elipse paramétrica, NURBS); a discretização por flecha é feita
//   depois (dxf/curves.js), com a tolerância de cada job.
'use strict';

// ---------------------------------------------------------------------------
// Unidades ($INSUNITS) -> fator para mm
// ---------------------------------------------------------------------------
const INSUNITS = {
  0: { name: 'sem unidade', mm: 1 },
  1: { name: 'polegada', mm: 25.4 },
  2: { name: 'pé', mm: 304.8 },
  3: { name: 'milha', mm: 1609344 },
  4: { name: 'milímetro', mm: 1 },
  5: { name: 'centímetro', mm: 10 },
  6: { name: 'metro', mm: 1000 },
  7: { name: 'quilômetro', mm: 1e6 },
  8: { name: 'micropolegada', mm: 25.4e-6 },
  9: { name: 'mil (milésimo de polegada)', mm: 0.0254 },
  10: { name: 'jarda', mm: 914.4 },
  11: { name: 'ångström', mm: 1e-7 },
  12: { name: 'nanômetro', mm: 1e-6 },
  13: { name: 'mícron', mm: 1e-3 },
  14: { name: 'decímetro', mm: 100 },
  15: { name: 'decâmetro', mm: 1e4 },
  16: { name: 'hectômetro', mm: 1e5 },
  17: { name: 'gigâmetro', mm: 1e12 },
  18: { name: 'unidade astronômica', mm: 1.495978707e14 },
  19: { name: 'ano-luz', mm: 9.4607304725808e18 },
  20: { name: 'parsec', mm: 3.0856775814913673e19 },
  21: { name: 'pé (US survey)', mm: 304.8006096 },
  22: { name: 'polegada (US survey)', mm: 25.4000508 },
  23: { name: 'jarda (US survey)', mm: 914.4018288 },
  24: { name: 'milha (US survey)', mm: 1609347.2187 }
};
const UNIT_OVERRIDES = { mm: 4, cm: 5, m: 6, in: 1, ft: 2 };

function resolveUnits(doc, override, warnings) {
  if (override && override !== 'auto') {
    const code = UNIT_OVERRIDES[override];
    if (code === undefined) throw new Error(`Unidade "${override}" desconhecida (use auto, mm, cm, m, in, ft).`);
    return { code, ...INSUNITS[code], source: 'escolhida pelo usuário' };
  }
  const code = doc.header.insunits;
  if (code === null || code === undefined || code === 0 || !INSUNITS[code]) {
    const imperial = doc.header.measurement === 0;
    warnings.push({
      code: 'UNITLESS',
      severity: imperial ? 'alto' : 'medio',
      message: imperial
        ? 'O DXF não declara unidade ($INSUNITS) e o desenho está em sistema imperial ($MEASUREMENT=0): pode estar em POLEGADAS. Assumido milímetro; confira as medidas ou escolha a unidade.'
        : 'O DXF não declara unidade ($INSUNITS). Assumido milímetro; confira uma cota conhecida.'
    });
    return { code: 0, ...INSUNITS[0], mm: 1, source: 'assumida (arquivo sem unidade)' };
  }
  return { code, ...INSUNITS[code], source: 'declarada no arquivo ($INSUNITS)' };
}

// ---------------------------------------------------------------------------
// Álgebra afim 3D (matriz 3x4 em linha: [a00 a01 a02 a03, a10 ..., a20 ...])
// ---------------------------------------------------------------------------
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function mul(A, B) {
  const R = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let s = A[r * 4 + 0] * B[0 * 4 + c] + A[r * 4 + 1] * B[1 * 4 + c] + A[r * 4 + 2] * B[2 * 4 + c];
      if (c === 3) s += A[r * 4 + 3];
      R[r * 4 + c] = s;
    }
  }
  return R;
}
const translate = (x, y, z = 0) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const scale = (sx, sy, sz = 1) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0];
function rotateZ(rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}
function apply(M, p) {
  const z = p.z || 0;
  return {
    x: M[0] * p.x + M[1] * p.y + M[2] * z + M[3],
    y: M[4] * p.x + M[5] * p.y + M[6] * z + M[7],
    z: M[8] * p.x + M[9] * p.y + M[10] * z + M[11]
  };
}
function applyLinear(M, v) {
  const z = v.z || 0;
  return {
    x: M[0] * v.x + M[1] * v.y + M[2] * z,
    y: M[4] * v.x + M[5] * v.y + M[6] * z,
    z: M[8] * v.x + M[9] * v.y + M[10] * z
  };
}
const proj = (p) => ({ x: p.x, y: p.y });

function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function norm(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/** Matriz OCS -> WCS pelo "Arbitrary Axis Algorithm" do DXF. */
function ocsMatrix(ext) {
  if (!ext) return IDENTITY;
  const N = norm(ext);
  if (Math.abs(N.x) < 1e-12 && Math.abs(N.y) < 1e-12 && N.z > 0) return IDENTITY;
  const Ax = (Math.abs(N.x) < 1 / 64 && Math.abs(N.y) < 1 / 64)
    ? norm(cross({ x: 0, y: 1, z: 0 }, N))
    : norm(cross({ x: 0, y: 0, z: 1 }, N));
  const Ay = norm(cross(N, Ax));
  return [Ax.x, Ay.x, N.x, 0, Ax.y, Ay.y, N.y, 0, Ax.z, Ay.z, N.z, 0];
}

/** Determinante da parte linear 2x2 projetada (sinal < 0 => espelhado no plano XY). */
function det2(M) {
  return M[0] * M[5] - M[1] * M[4];
}

// ---------------------------------------------------------------------------
// Construtores de segmentos (no plano XY do mundo)
// ---------------------------------------------------------------------------

/** Arco elíptico afim: P(t) = c + u cos t + v sin t, t de t0 a t1 (t1 pode ser < t0). */
function makeArc(M, center, r, t0, t1) {
  const c = proj(apply(M, center));
  const u = proj(applyLinear(M, { x: r, y: 0, z: 0 }));
  const v = proj(applyLinear(M, { x: 0, y: r, z: 0 }));
  return finishArc(c, u, v, t0, t1);
}
function finishArc(c, u, v, t0, t1) {
  const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y);
  const dot = (u.x * v.x + u.y * v.y) / ((lu * lv) || 1);
  const isCircle = Math.abs(lu - lv) <= 1e-9 * Math.max(lu, lv, 1) && Math.abs(dot) < 1e-9;
  const seg = { kind: 'arc', c, u, v, t0, t1 };
  if (isCircle) {
    // círculo/arco verdadeiro (transformação de semelhança): guardado para exportar ARC/CIRCLE no futuro
    const ccwFrame = (u.x * v.y - u.y * v.x) > 0;
    const base = Math.atan2(u.y, u.x);
    const a0 = ccwFrame ? base + t0 : base - t0;
    const a1 = ccwFrame ? base + t1 : base - t1;
    seg.circle = { r: lu, a0, a1 };
  }
  return seg;
}

function bulgeArc(M, p1, p2, bulge, z) {
  const theta = 4 * Math.atan(bulge);
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const c = Math.hypot(dx, dy);
  if (c < 1e-12) return null;
  const r = c / (2 * Math.abs(Math.sin(theta / 2)));
  const d = (c / 2) / Math.tan(theta / 2);
  const nx = -dy / c, ny = dx / c; // normal à esquerda da corda
  const cx = (p1.x + p2.x) / 2 + nx * d;
  const cy = (p1.y + p2.y) / 2 + ny * d;
  const a0 = Math.atan2(p1.y - cy, p1.x - cx);
  const seg = makeArc(M, { x: cx, y: cy, z }, r, a0, a0 + theta);
  // ancora as extremidades exatamente nos vértices (evita micro-gaps numéricos)
  seg.pStart = proj(apply(M, { x: p1.x, y: p1.y, z }));
  seg.pEnd = proj(apply(M, { x: p2.x, y: p2.y, z }));
  return seg;
}

function lineSeg(M, a, b) {
  return { kind: 'line', a: proj(apply(M, a)), b: proj(apply(M, b)) };
}

/** Caminho de vértices com bulge (LWPOLYLINE / POLYLINE 2D). */
function polylinePath(M, verts, closed, z) {
  const segs = [];
  const n = verts.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const v1 = verts[i], v2 = verts[(i + 1) % n];
    const a = { x: v1.x, y: v1.y, z: v1.z !== undefined && v1.z !== null ? v1.z : z };
    const b = { x: v2.x, y: v2.y, z: v2.z !== undefined && v2.z !== null ? v2.z : z };
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-12) continue; // vértice repetido
    if (v1.bulge && Math.abs(v1.bulge) > 1e-9) {
      const s = bulgeArc(M, a, b, v1.bulge, a.z);
      if (s) segs.push(s);
    } else {
      segs.push(lineSeg(M, a, b));
    }
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Achatamento
// ---------------------------------------------------------------------------

const NON_GEOMETRIC = new Set(['TEXT', 'MTEXT', 'ATTRIB', 'ATTDEF', 'DIMENSION', 'ARC_DIMENSION', 'LEADER', 'MLEADER',
  'MULTILEADER', 'HATCH', 'POINT', 'SOLID', '3DFACE', 'VIEWPORT', 'IMAGE', 'WIPEOUT', 'OLE2FRAME', 'OLEFRAME',
  'ACAD_TABLE', 'XLINE', 'RAY', 'TOLERANCE', 'SHAPE', 'SEQEND', 'VERTEX', 'ENDBLK', 'LIGHT', 'SUN',
  'PDFUNDERLAY', 'DWFUNDERLAY', 'DGNUNDERLAY', 'ACAD_PROXY_ENTITY', 'GEOPOSITIONMARKER', 'CAMERA']);
const UNSUPPORTED_GEOMETRY = new Set(['REGION', '3DSOLID', 'BODY', 'SURFACE', 'PLANESURFACE', 'EXTRUDEDSURFACE',
  'LOFTEDSURFACE', 'REVOLVEDSURFACE', 'SWEPTSURFACE', 'NURBSSURFACE', 'MESH', 'MLINE', 'HELIX', 'TRACE', 'POLYFACE']);

/**
 * @param {Object} doc  saída de readDxf
 * @param {{units?:string, maxDepth?:number, maxSegments?:number}} options
 * @returns {{paths:Array, texts:Array, units:Object, stats:Object, warnings:Array}}
 */
function flattenDxf(doc, options = {}) {
  const warnings = [];
  const units = resolveUnits(doc, options.units, warnings);
  const maxDepth = options.maxDepth || 32;
  const maxSegments = options.maxSegments || 3000000;

  const paths = [];
  const texts = [];
  const stats = {
    entitiesByType: {},
    ignoredByType: {},
    unsupportedByType: {},
    inserts: 0,
    insertDepthMax: 0,
    mirroredInserts: 0,
    minsertCells: 0,
    missingBlocks: new Set(),
    xrefBlocks: new Set(),
    recursiveBlocks: new Set(),
    outOfPlane: 0,
    meshesSkipped: 0,
    fitOnlySplines: 0,
    widePolylines: 0,
    segments: 0
  };
  let insertSeq = 0;

  const layerInfo = (name) => doc.layers.get(name) || null;
  const ltDashed = (name) => {
    if (!name) return false;
    const u = name.toUpperCase();
    if (u === 'CONTINUOUS' || u === 'BYLAYER' || u === 'BYBLOCK') return false;
    const lt = doc.linetypes.get(u);
    if (lt) return lt.dashed;
    return /(CENTER|HIDDEN|DASH|PHANTOM|DOT|DIVIDE|BORDER|CENTRO|TRACEJ|OCULTA|EIXO)/.test(u);
  };

  /** Resolve atributos efetivos (layer 0 e BYBLOCK herdam do INSERT). */
  function resolveMeta(e, ctx) {
    let layer = e.layer;
    if (layer === '0' && ctx.layer) layer = ctx.layer;
    let lt = e.linetype || 'BYLAYER';
    const ltU = lt.toUpperCase();
    if (ltU === 'BYBLOCK') lt = ctx.linetype || 'CONTINUOUS';
    else if (ltU === 'BYLAYER') {
      const L = layerInfo(layer);
      lt = L ? L.linetype : 'CONTINUOUS';
    }
    return { layer, linetype: lt, dashed: ltDashed(lt) };
  }

  function pushPath(e, ctx, M, segs, closed, extra = {}) {
    if (!segs.length) return;
    stats.segments += segs.length;
    if (stats.segments > maxSegments) {
      throw new Error(`O DXF expande para mais de ${maxSegments.toLocaleString('pt-BR')} segmentos (blocos aninhados demais?). Arquivo recusado por segurança.`);
    }
    const meta = resolveMeta(e, ctx);
    paths.push({
      id: paths.length,
      segs,
      closed,
      entityType: e.type,
      handle: e.handle,
      layer: meta.layer,
      linetype: meta.linetype,
      dashed: meta.dashed,
      invisible: !!e.invisible,
      blockPath: ctx.path.join(' > '),
      partBlock: ctx.namedBlock || null,
      instance: ctx.instance,
      mirrored: det2(M) < 0,
      ...extra
    });
  }

  function checkPlane(Mfull) {
    // normal do plano local transformada; se não for paralela a Z, a projeção distorce a peça
    const n = applyLinear(Mfull, { x: 0, y: 0, z: 1 });
    const l = Math.hypot(n.x, n.y, n.z);
    if (l > 0 && Math.abs(n.z) / l < 0.9999) stats.outOfPlane++;
  }

  function emitEntity(e, ctx) {
    const M = ctx.M;
    stats.entitiesByType[e.type] = (stats.entitiesByType[e.type] || 0) + 1;
    switch (e.type) {
      case 'LINE':
        pushPath(e, ctx, M, [lineSeg(M, e.p1, e.p2)], false);
        return;
      case 'CIRCLE': {
        if (!(e.radius > 0)) return;
        const Mo = mul(M, ocsMatrix(e.extrusion));
        checkPlane(Mo);
        pushPath(e, ctx, Mo, [makeArc(Mo, e.center, e.radius, 0, Math.PI * 2)], true);
        return;
      }
      case 'ARC': {
        if (!(e.radius > 0)) return;
        const Mo = mul(M, ocsMatrix(e.extrusion));
        checkPlane(Mo);
        const a0 = e.startDeg * Math.PI / 180;
        let a1 = e.endDeg * Math.PI / 180;
        while (a1 <= a0) a1 += Math.PI * 2;
        while (a1 - a0 > Math.PI * 2 + 1e-12) a1 -= Math.PI * 2;
        const full = Math.abs(a1 - a0 - Math.PI * 2) < 1e-9;
        pushPath(e, ctx, Mo, [makeArc(Mo, e.center, e.radius, a0, a1)], full);
        return;
      }
      case 'ELLIPSE': {
        const N = norm(e.extrusion);
        const minor = cross(N, e.major);
        const k = e.ratio;
        const c = proj(apply(M, e.center));
        const u = proj(applyLinear(M, e.major));
        const v = proj(applyLinear(M, { x: minor.x * k, y: minor.y * k, z: minor.z * k }));
        checkPlane(M);
        let t0 = e.startParam, t1 = e.endParam;
        while (t1 <= t0) t1 += Math.PI * 2;
        while (t1 - t0 > Math.PI * 2 + 1e-12) t1 -= Math.PI * 2;
        const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-9;
        pushPath(e, ctx, M, [finishArc(c, u, v, t0, t1)], full);
        return;
      }
      case 'LWPOLYLINE': {
        if (!e.vertices || e.vertices.length < 2) return;
        const Mo = mul(M, ocsMatrix(e.extrusion));
        checkPlane(Mo);
        if (e.constWidth > 0 || e.vertices.some(v => (v.startWidth || 0) > 0 || (v.endWidth || 0) > 0)) stats.widePolylines++;
        const segs = polylinePath(Mo, e.vertices, e.closed, e.elevation);
        pushPath(e, ctx, Mo, segs, e.closed);
        return;
      }
      case 'POLYLINE': {
        if (e.isMesh || e.isPolyface) { stats.meshesSkipped++; return; }
        let verts = e.vertices || [];
        if (e.splineFit) {
          const fitted = verts.filter(v => (v.vflags & 8) === 8);
          verts = fitted.length >= 2 ? fitted : verts.filter(v => (v.vflags & 16) !== 16);
        } else {
          verts = verts.filter(v => (v.vflags & 16) !== 16);
        }
        if (verts.length < 2) return;
        if (e.is3d) {
          const vv = verts.map(v => ({ x: v.x, y: v.y, z: v.z, bulge: 0 }));
          pushPath(e, ctx, M, polylinePath(M, vv, e.closed, 0), e.closed);
        } else {
          const Mo = mul(M, ocsMatrix(e.extrusion));
          checkPlane(Mo);
          const vv = verts.map(v => ({ x: v.x, y: v.y, z: null, bulge: v.bulge }));
          pushPath(e, ctx, Mo, polylinePath(Mo, vv, e.closed, e.elevation), e.closed);
        }
        return;
      }
      case 'SPLINE': {
        const useCtrl = e.ctrl.length >= 2;
        if (!useCtrl && e.fit.length < 2) return;
        if (!useCtrl) stats.fitOnlySplines++;
        const seg = { kind: 'spline', degree: e.degree, closed: e.closed, periodic: e.periodic };
        if (useCtrl) {
          seg.ctrl = e.ctrl.map(p => proj(apply(M, p)));
          seg.knots = e.knots.slice();
          seg.weights = e.rational && e.weights.length === e.ctrl.length ? e.weights.slice() : null;
        } else {
          seg.fit = e.fit.map(p => proj(apply(M, p)));
          seg.startTangent = e.startTangent ? proj(applyLinear(M, e.startTangent)) : null;
          seg.endTangent = e.endTangent ? proj(applyLinear(M, e.endTangent)) : null;
        }
        pushPath(e, ctx, M, [seg], e.closed || e.periodic);
        return;
      }
      case 'INSERT':
        expandInsert(e, ctx);
        return;
      case 'TEXT':
      case 'MTEXT': {
        stats.ignoredByType[e.type] = (stats.ignoredByType[e.type] || 0) + 1;
        const Mo = e.ocs ? mul(M, ocsMatrix(e.extrusion)) : M;
        const p = proj(apply(Mo, e.position));
        if (e.text && e.text.trim()) texts.push({ text: e.text.trim(), x: p.x, y: p.y, layer: resolveMeta(e, ctx).layer, blockPath: ctx.path.join(' > ') });
        return;
      }
      default:
        if (UNSUPPORTED_GEOMETRY.has(e.type)) stats.unsupportedByType[e.type] = (stats.unsupportedByType[e.type] || 0) + 1;
        else stats.ignoredByType[e.type] = (stats.ignoredByType[e.type] || 0) + 1;
    }
  }

  function expandInsert(e, ctx) {
    stats.inserts++;
    const blk = doc.blocks.get(e.name);
    if (!blk) { stats.missingBlocks.add(e.name); return; }
    if (blk.isXref) { stats.xrefBlocks.add(e.name); return; }
    if (ctx.stack.includes(e.name)) { stats.recursiveBlocks.add(e.name); return; }
    if (ctx.stack.length >= maxDepth) { stats.recursiveBlocks.add(e.name); return; }
    stats.insertDepthMax = Math.max(stats.insertDepthMax, ctx.stack.length + 1);

    const insLayer = e.layer === '0' && ctx.layer ? ctx.layer : e.layer;
    const L = layerInfo(insLayer);
    if (L && L.frozen) {
      // Bloco inserido em layer congelada não aparece no CAD: não é cortado.
      stats.ignoredByType['INSERT (layer congelada)'] = (stats.ignoredByType['INSERT (layer congelada)'] || 0) + 1;
      return;
    }
    let lt = e.linetype || 'BYLAYER';
    if (lt.toUpperCase() === 'BYBLOCK') lt = ctx.linetype || 'CONTINUOUS';
    else if (lt.toUpperCase() === 'BYLAYER') lt = L ? L.linetype : 'CONTINUOUS';

    const Mo = ocsMatrix(e.extrusion);
    const base = blk.base || { x: 0, y: 0, z: 0 };
    const rot = e.rotationDeg * Math.PI / 180;
    const cols = Math.min(e.cols, 10000), rows = Math.min(e.rows, 10000);
    if (cols * rows > 1) stats.minsertCells += cols * rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // M_ins = OCS · T(pos) · R(rot) · T(célula) · S(escala) · T(-base)
        let Mi = mul(Mo, translate(e.position.x, e.position.y, e.position.z));
        Mi = mul(Mi, rotateZ(rot));
        if (cols * rows > 1) Mi = mul(Mi, translate(c * e.colSpacing, r * e.rowSpacing, 0));
        Mi = mul(Mi, scale(e.sx, e.sy, e.sz));
        Mi = mul(Mi, translate(-base.x, -base.y, -base.z));
        const M = mul(ctx.M, Mi);
        if (det2(M) * det2(ctx.M) < 0) stats.mirroredInserts++;
        const id = ++insertSeq;
        const child = {
          M,
          layer: insLayer,
          linetype: lt,
          stack: [...ctx.stack, e.name],
          path: [...ctx.path, e.name + (cols * rows > 1 ? `[${r},${c}]` : '')],
          namedBlock: blk.anonymous ? ctx.namedBlock : e.name,
          instance: `${ctx.instance}/${id}`
        };
        for (const be of blk.entities) emitEntity(be, child);
      }
    }
    if (e.attribs) {
      for (const a of e.attribs) {
        const p = proj(apply(mul(ctx.M, ocsMatrix(a.extrusion)), a.position));
        if (a.text && a.text.trim()) texts.push({ text: a.text.trim(), x: p.x, y: p.y, layer: a.layer, blockPath: ctx.path.join(' > ') });
      }
    }
  }

  const root = { M: scale(units.mm, units.mm, units.mm), layer: null, linetype: null, stack: [], path: [], namedBlock: null, instance: 'M' };
  for (const e of doc.entities) emitEntity(e, root);

  // ---- avisos para o relatório
  if (stats.missingBlocks.size) warnings.push({ code: 'MISSING_BLOCK', severity: 'alto', message: `INSERT referencia bloco inexistente: ${[...stats.missingBlocks].slice(0, 8).join(', ')}.` });
  if (stats.xrefBlocks.size) warnings.push({ code: 'XREF', severity: 'alto', message: `Referência externa (XREF) não resolvida: ${[...stats.xrefBlocks].slice(0, 8).join(', ')}. Use BIND/insira o desenho antes de exportar.` });
  if (stats.recursiveBlocks.size) warnings.push({ code: 'RECURSIVE_BLOCK', severity: 'alto', message: `Bloco recursivo ou aninhado demais (> ${maxDepth} níveis): ${[...stats.recursiveBlocks].slice(0, 8).join(', ')}.` });
  if (stats.outOfPlane) warnings.push({ code: 'OUT_OF_PLANE', severity: 'alto', message: `${stats.outOfPlane} entidade(s) fora do plano XY (vista 3D/inclinada): a projeção distorce as medidas. Desenhe as peças planas, vistas de cima.` });
  if (stats.meshesSkipped) warnings.push({ code: 'MESH', severity: 'medio', message: `${stats.meshesSkipped} malha(s) 3D/polyface ignorada(s).` });
  const unsup = Object.entries(stats.unsupportedByType);
  if (unsup.length) warnings.push({ code: 'UNSUPPORTED', severity: 'alto', message: `Geometria não suportada ignorada: ${unsup.map(([t, n]) => `${n}× ${t}`).join(', ')}. Use EXPLODE no CAD (REGION/3DSOLID viram linhas e arcos).` });
  if (stats.fitOnlySplines) warnings.push({ code: 'FIT_SPLINE', severity: 'baixo', message: `${stats.fitOnlySplines} SPLINE(s) só com pontos de ajuste: curva reconstruída por interpolação cúbica (pode diferir levemente do CAD).` });
  if (stats.widePolylines) warnings.push({ code: 'WIDE_POLYLINE', severity: 'baixo', message: `${stats.widePolylines} polilinha(s) com espessura de traço: usada a linha de centro (a espessura do traço não é geometria de corte).` });

  return { paths, texts, units, stats, warnings };
}

module.exports = { flattenDxf, INSUNITS, ocsMatrix, finishArc, makeArc };
