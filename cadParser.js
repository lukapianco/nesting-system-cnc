// cadParser.js — DXF -> catálogo de peças (contorno externo CCW + furos CW), pronto para o motor.
//
// Desde a V5.3 a leitura do DXF é feita pelo "DXF Doctor" (pasta dxf/): leitor próprio, blocos INSERT
// aninhados, OCS, ELLIPSE, SPLINE, unidades, layers, costura de contornos, molduras e relatório.
// Este módulo classifica peça/furo, agrupa cópias idênticas em quantidades e prepara a geometria do motor.
'use strict';

const { resolveAllowedRotations } = require('./typesAndInterfaces');
const {
  getBoundingBox,
  computeSignedArea,
  isPointInPolygon,
  pointToSegmentDist
} = require('./geometry/primitives');
const { evaluateNurbs } = require('./dxf/curves');
const { readDxf } = require('./dxf/reader');
const { analyzeDxf, normalizeImportOptions } = require('./dxf/doctor');
const { describe, matchParts } = require('./geometry/congruence');

// =========================================================================
// 1. ORIENTAÇÃO E NORMAIS
// =========================================================================

/**
 * Impõe orientação canônica: CCW (As > 0) para contornos externos, CW (As < 0) para furos.
 */
function enforceWindingOrder(pts, shouldBeCCW = true) {
  const signedArea = computeSignedArea(pts);
  const isCCW = signedArea > 0;
  if (isCCW !== shouldBeCCW) {
    return [...pts].reverse();
  }
  return [...pts];
}

/**
 * Calcula os vetores normais unitários externos para cada aresta de um anel poligonal.
 */
function computeEdgeNormals(pts) {
  const normals = [];
  const n = pts.length;
  const sign = computeSignedArea(pts) >= 0 ? 1 : -1;

  for (let i = 0; i < n; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    normals.push({
      x: +(sign * (dy / len)).toFixed(6),
      y: +(sign * (-dx / len)).toFixed(6)
    });
  }
  return normals;
}

// =========================================================================
// 2. CURVAS (API mantida por compatibilidade; o pipeline novo usa dxf/curves.js)
// =========================================================================

/**
 * Discretiza um arco circular respeitando a tolerância máxima de flecha (delta_max).
 */
function discretizeArcAdaptive(cx, cy, radius, startAngleRad, endAngleRad, ccw = true, deltaMax = 0.03) {
  let dTheta = endAngleRad - startAngleRad;
  if (ccw && dTheta <= 0) dTheta += Math.PI * 2;
  if (!ccw && dTheta >= 0) dTheta -= Math.PI * 2;

  const absSweep = Math.abs(dTheta);
  const safeRatio = Math.min(0.9999, Math.max(1e-6, deltaMax / Math.max(radius, deltaMax * 1.01)));
  const maxStepRad = Math.max(1e-3, 2 * Math.acos(1 - safeRatio)); // flecha d = R(1-cos(dθ/2)) <= delta_max
  const numSegs = Math.max(6, Math.min(2000, Math.ceil(absSweep / maxStepRad)));

  const pts = [];
  for (let i = 0; i <= numSegs; i++) {
    const theta = startAngleRad + (dTheta * i) / numSegs;
    pts.push({
      x: +(cx + Math.cos(theta) * radius).toFixed(4),
      y: +(cy + Math.sin(theta) * radius).toFixed(4)
    });
  }
  return pts;
}

/**
 * Avaliação de NURBS (de Boor em coordenadas homogêneas). Mantida para compatibilidade: delega a dxf/curves.
 */
function evaluateNurbsPoint(u, degree, controlPoints, knots, weights) {
  const p = evaluateNurbs(u, degree, controlPoints, knots, weights || null);
  return { x: +p.x.toFixed(4), y: +p.y.toFixed(4) };
}

// =========================================================================
// 3. LEITURA DO DXF (DXF Doctor)
// =========================================================================

/** Lê bytes/texto DXF (leitor próprio, sem dependências). */
function parseDxf(input) {
  return readDxf(input);
}

/**
 * DXF lido -> contornos fechados (em mm, mundo) com metadados e relatório (`.report`, `.frames`, `.warnings`).
 * @param {Object} doc  saída de parseDxf/readDxf
 * @param {number} deltaMax  flecha máxima (mm)
 * @param {Object} importOptions  ver dxf/doctor.js DEFAULT_IMPORT
 */
function extractContoursFromDxf(doc, deltaMax = 0.03, importOptions = {}) {
  if (!doc || !(doc.blocks instanceof Map)) {
    throw new Error('extractContoursFromDxf espera o documento do leitor próprio (parseDxf). O formato do pacote dxf-parser não é mais aceito aqui.');
  }
  return analyzeDxf(doc, { chordTol: deltaMax }, importOptions);
}

// =========================================================================
// 4. RAIO INSCRITO E OFFSET
// =========================================================================

/**
 * Calcula o Raio Máximo Inscrito R_max (Transformada do Eixo Medial / Voronoi Interno)
 * usando busca multi-resolução (Pole of Inaccessibility) para triagem Part-in-Part em O(1).
 */
function computeMaxInscribedCircle(pts, bbox) {
  let bestX = (bbox.min_x + bbox.max_x) * 0.5;
  let bestY = (bbox.min_y + bbox.max_y) * 0.5;
  let bestR = 0;

  const distToBoundary = (px, py) => {
    if (!isPointInPolygon({ x: px, y: py }, pts)) return -1;
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % pts.length];
      const d = pointToSegmentDist(px, py, p1.x, p1.y, p2.x, p2.y);
      if (d < minD) minD = d;
    }
    return minD;
  };

  let minX = bbox.min_x, maxX = bbox.max_x, minY = bbox.min_y, maxY = bbox.max_y;
  for (let pass = 0; pass < 3; pass++) {
    const steps = 8;
    const dx = (maxX - minX) / steps;
    const dy = (maxY - minY) / steps;
    if (dx < 0.05 || dy < 0.05) break;

    for (let ix = 1; ix < steps; ix++) {
      for (let iy = 1; iy < steps; iy++) {
        const cx = minX + ix * dx;
        const cy = minY + iy * dy;
        const r = distToBoundary(cx, cy);
        if (r > bestR) {
          bestR = r;
          bestX = cx;
          bestY = cy;
        }
      }
    }
    minX = Math.max(bbox.min_x, bestX - dx * 1.5);
    maxX = Math.min(bbox.max_x, bestX + dx * 1.5);
    minY = Math.max(bbox.min_y, bestY - dy * 1.5);
    maxY = Math.min(bbox.max_y, bestY + dy * 1.5);
  }

  return {
    radius: +bestR.toFixed(2),
    center: { x: +bestX.toFixed(2), y: +bestY.toFixed(2) }
  };
}

/**
 * Desloca um polígono orientado por uma distância d (Offset com Miter Limit = 2.0).
 * d > 0 expande para fora; d < 0 contrai para dentro.
 */
function offsetPolygonRing(pts, offsetDist, miterLimit = 2.0) {
  if (Math.abs(offsetDist) < 1e-5 || pts.length < 3) return [...pts];
  const normals = computeEdgeNormals(pts);
  const n = pts.length;
  const outPts = [];

  for (let i = 0; i < n; i++) {
    const nPrev = normals[(i - 1 + n) % n];
    const nCurr = normals[i];
    const v = pts[i];

    const dot = nPrev.x * nCurr.x + nPrev.y * nCurr.y;
    const denom = 1 + dot;

    if (denom > 0.25) {
      const factor = Math.min(miterLimit, 1 / denom);
      outPts.push({
        x: +(v.x + offsetDist * (nPrev.x + nCurr.x) * factor).toFixed(3),
        y: +(v.y + offsetDist * (nPrev.y + nCurr.y) * factor).toFixed(3)
      });
    } else {
      // Canto agudo severo: aplica chanfro duplo (Bevel Join) evitando espinhos no NFP
      outPts.push(
        { x: +(v.x + offsetDist * nPrev.x).toFixed(3), y: +(v.y + offsetDist * nPrev.y).toFixed(3) },
        { x: +(v.x + offsetDist * nCurr.x).toFixed(3), y: +(v.y + offsetDist * nCurr.y).toFixed(3) }
      );
    }
  }
  return outPts;
}

// =========================================================================
// 5. ÁRVORE TOPOLÓGICA DE PEÇAS E FUROS
// =========================================================================

/**
 * Classifica contornos em peças (nível par) e furos (nível ímpar). Quando o contorno traz `parentId`
 * (calculado pelo DXF Doctor com teste de contenção robusto e molduras já removidas), usa-o; senão,
 * calcula a contenção aqui (caixa + ponto em polígono).
 */
function classifyPartsAndHoles(rawContours, minHoleSize, nestingParams = {}) {
  const kerf_width = Number(nestingParams.kerf_width ?? 0.4);
  const part_clearance = Number(nestingParams.part_clearance ?? 5.6);
  const deltaExp = (part_clearance + kerf_width) * 0.5;
  const allowedRotations = resolveAllowedRotations(
    nestingParams.allow_rotation ?? true,
    nestingParams.grain_restriction ?? 'ORTHOGONAL'
  );

  const sorted = [...rawContours].sort((a, b) => b.bbox.area - a.bbox.area);
  const byId = new Map(sorted.map(c => [c.id, c]));
  const hasTree = sorted.length > 0 && sorted.every(c => c.parentId !== undefined);
  const ancestorsOf = new Map();

  if (hasTree) {
    for (const c of sorted) {
      const anc = [];
      let p = c.parentId;
      while (p && byId.has(p)) { anc.unshift(p); p = byId.get(p).parentId; }
      ancestorsOf.set(c.id, anc);
    }
  } else {
    for (let i = 0; i < sorted.length; i++) {
      ancestorsOf.set(sorted[i].id, []);
      for (let j = 0; j < i; j++) {
        const p = sorted[j], c = sorted[i];
        if (
          c.bbox.minX >= p.bbox.minX - 0.1 && c.bbox.maxX <= p.bbox.maxX + 0.1 &&
          c.bbox.minY >= p.bbox.minY - 0.1 && c.bbox.maxY <= p.bbox.maxY + 0.1 &&
          isPointInPolygon(c.points[0], p.points)
        ) {
          ancestorsOf.get(c.id).push(p.id);
        }
      }
    }
  }

  const parts = [];
  const holeToParent = new Map();

  sorted.forEach(c => {
    const anc = ancestorsOf.get(c.id) || [];
    if (anc.length % 2 === 0) {
      // Nível par (0, 2...): contorno externo de peça -> anti-horário (CCW, As > 0)
      const normRaw = c.points.map(p => ({
        x: +(p.x - c.bbox.minX).toFixed(3),
        y: +(p.y - c.bbox.minY).toFixed(3)
      }));
      const ccwPts = enforceWindingOrder(normRaw, true);
      const bbox = getBoundingBox(ccwPts);
      const signedArea = computeSignedArea(ccwPts);
      const mat = computeMaxInscribedCircle(ccwPts, bbox);
      const offsetPts = offsetPolygonRing(ccwPts, deltaExp, 2.0);

      /** @type {import('./typesAndInterfaces').PolygonRing} */
      const outer_contour = {
        vertices: ccwPts,
        edge_normals: computeEdgeNormals(ccwPts),
        bounding_box: bbox,
        signed_area: +signedArea.toFixed(2),
        area: c.trueArea,
        max_inscribed_radius: mat.radius,
        inscribed_center: mat.center
      };

      const offset_outer_contour = {
        vertices: offsetPts,
        edge_normals: computeEdgeNormals(offsetPts),
        bounding_box: getBoundingBox(offsetPts),
        signed_area: +computeSignedArea(offsetPts).toFixed(2),
        area: +Math.abs(computeSignedArea(offsetPts)).toFixed(2),
        max_inscribed_radius: +(mat.radius + deltaExp).toFixed(2),
        inscribed_center: mat.center
      };

      const n = parts.length + 1;
      parts.push({
        id: `PECA_${n}`,
        name: `Peça #${n}`,
        sourceContourId: c.id,
        origin: 'DXF Original',
        width: bbox.width,
        height: bbox.height,
        bboxArea: bbox.area,
        area: c.trueArea,
        origMinX: c.bbox.minX,
        origMinY: c.bbox.minY,
        points: ccwPts,
        outer_contour,
        offset_outer_contour,
        inner_holes: [],
        usable_holes: [],
        holes: [],
        allowed_rotations_deg: allowedRotations,
        allow_mirroring: false,
        quantity_required: 1,
        blockName: c.blockName || null,
        labels: c.labels || [],
        layers: c.layers || [],
        frameId: c.frameId || null,
        selfIntersecting: !!c.selfIntersecting
      });
    } else {
      // Nível ímpar (1, 3...): furo -> vincula à peça mãe imediata
      holeToParent.set(c.id, anc[anc.length - 1]);
    }
  });

  sorted.forEach(c => {
    if (!holeToParent.has(c.id)) return;
    const parentPart = parts.find(p => p.sourceContourId === holeToParent.get(c.id));
    if (!parentPart) return;

    const relRaw = c.points.map(p => ({
      x: +(p.x - parentPart.origMinX).toFixed(3),
      y: +(p.y - parentPart.origMinY).toFixed(3)
    }));

    // Furo interno: horário (CW, As < 0)
    const cwPts = enforceWindingOrder(relRaw, false);
    const hb = getBoundingBox(cwPts);
    const mat = computeMaxInscribedCircle(cwPts, hb);
    const meetsMin = c.bbox.width >= minHoleSize && c.bbox.height >= minHoleSize;

    const holeRing = {
      id: `FURO_${parentPart.holes.length + 1}_${parentPart.id}`,
      vertices: cwPts,
      edge_normals: computeEdgeNormals(cwPts),
      bounding_box: hb,
      signed_area: +computeSignedArea(cwPts).toFixed(2),
      area: c.trueArea,
      max_inscribed_radius: mat.radius,
      inscribed_center: mat.center,
      width: c.bbox.width,
      height: c.bbox.height,
      relX: hb.minX,
      relY: hb.minY,
      usableHole: meetsMin,
      points: cwPts
    };

    parentPart.inner_holes.push(holeRing);
    parentPart.holes.push(holeRing);
    if (meetsMin) {
      parentPart.usable_holes.push(holeRing);
    }
  });

  // Área líquida de material: contorno externo menos furos
  parts.forEach(pt => {
    const holesArea = pt.holes.reduce((acc, h) => acc + h.area, 0);
    pt.netArea = +Math.max(0, pt.area - holesArea).toFixed(2);
  });

  return parts;
}

// =========================================================================
// 6. CÓPIAS IDÊNTICAS -> UMA PEÇA COM QUANTIDADE
// =========================================================================

/**
 * Agrupa peças congruentes (mesma forma e furos, a menos de translação e rotação). A primeira ocorrência
 * vira o representante; `quantity_detected` = número de cópias no desenho; `instances` guarda onde e com
 * que giro cada cópia estava (para relatório e, no futuro, reproduzir o layout original).
 * Peças espelhadas NÃO são agrupadas (cortar o espelho exige virar a chapa); são apenas apontadas em `mirrorOf`.
 */
/** Ângulo em [0, 360) arredondado a 0,01° (evita "360" por ruído numérico). */
function normDeg(d) {
  let a = Math.round(d * 100) / 100;
  a = ((a % 360) + 360) % 360;
  return a >= 359.995 ? 0 : +a.toFixed(2);
}

function groupIdenticalParts(parts, { tol = 0.1 } = {}) {
  const classes = [];
  for (const p of parts) {
    const d = describe(p.points, p.holes.map(h => h.points));
    let hit = null, how = null;
    for (const cl of classes) {
      const m = matchParts(cl.desc, d, { tol });
      if (m) { hit = cl; how = m; break; }
    }
    if (hit) hit.members.push({ part: p, theta: how.theta, desc: d });
    else classes.push({ desc: d, members: [{ part: p, theta: 0, desc: d }] });
  }
  // Representante = cópia com a menor caixa alinhada aos eixos (orientação "mais deitada"; é a partir dela
  // que o motor aplica os giros permitidos). Empate: ordem do desenho.
  const order = (m) => Number(String(m.part.sourceContourId || '').replace(/\D/g, '')) || 0;
  for (const cl of classes) {
    let best = cl.members[0];
    for (const m of cl.members) {
      const a = m.part.bboxArea, b = best.part.bboxArea;
      if (a < b - 1e-6 * Math.max(a, b) || (Math.abs(a - b) <= 1e-6 * Math.max(a, b) && order(m) < order(best))) best = m;
    }
    cl.rep = best.part;
    cl.desc = best.desc;
    cl.instances = cl.members
      .slice().sort((a, b) => order(a) - order(b))
      .map(m => ({
        sourceContourId: m.part.sourceContourId,
        x: m.part.origMinX, y: m.part.origMinY,
        rotationDeg: normDeg((m.theta - best.theta) * 180 / Math.PI),
        frameId: m.part.frameId || null
      }));
  }

  // espelhos (só informativo)
  for (let i = 0; i < classes.length; i++) {
    for (let j = 0; j < i; j++) {
      if (classes[i].mirrorOf) break;
      const m = matchParts(classes[j].desc, classes[i].desc, { tol, allowMirror: true });
      if (m && m.mirror) classes[i].mirrorOf = j;
    }
  }

  // nomes: rótulo de texto dentro da peça > nome do bloco > "Peça #n"
  const usedNames = new Map();
  const out = classes.map((cl, idx) => {
    const n = idx + 1;
    const rep = cl.rep;
    let base = (rep.labels && rep.labels[0]) ? rep.labels[0].split('\n')[0].trim().slice(0, 40) : (rep.blockName || '');
    if (!base) base = `Peça #${n}`;
    const k = (usedNames.get(base) || 0) + 1;
    usedNames.set(base, k);
    const name = k > 1 ? `${base} (${k})` : base;
    const holes = rep.holes.map((h, hi) => ({ ...h, id: `FURO_${hi + 1}_PECA_${n}` }));
    return {
      ...rep,
      id: `PECA_${n}`,
      name,
      holes,
      inner_holes: holes,
      usable_holes: holes.filter(h => h.usableHole),
      quantity_detected: cl.instances.length,
      instances: cl.instances,
      mirrorOf: cl.mirrorOf !== undefined ? `PECA_${cl.mirrorOf + 1}` : null
    };
  });
  return out;
}

/**
 * Pipeline completo de catálogo: documento DXF -> contornos (Doctor) -> peças/furos -> cópias agrupadas.
 * @returns {{catalogParts:Array, report:Object, frames:Array, warnings:string[]}}
 */
function buildCatalogFromDxf(doc, nestingParams = {}, importOptions = {}) {
  const opt = normalizeImportOptions(importOptions);
  const tol = Number(nestingParams.chordal_tolerance) || 0.03;
  const contours = extractContoursFromDxf(doc, tol, opt);
  let parts = classifyPartsAndHoles(contours, Number(nestingParams.min_hole_size ?? 15), nestingParams);
  const report = contours.report;
  const rawCount = parts.length;
  if (importOptions.groupIdentical !== false && parts.length > 1) {
    parts = groupIdenticalParts(parts, { tol: Math.max(0.1, 3 * tol) });
    const grouped = parts.filter(p => p.quantity_detected > 1);
    if (grouped.length) {
      report.items.push({
        severity: 'info', code: 'IDENTICAL_GROUPED',
        message: `${rawCount} peças desenhadas = ${parts.length} peça(s) diferente(s); quantidades preenchidas pelas cópias: ` +
          parts.map(p => `${p.name} ×${p.quantity_detected}`).join(', ') + '.'
      });
    }
    const mirrors = parts.filter(p => p.mirrorOf);
    if (mirrors.length) {
      report.items.push({
        severity: 'info', code: 'MIRRORED_PARTS',
        message: `Peças espelhadas entre si (mantidas separadas): ` + mirrors.map(p => `${p.name} ↔ ${parts.find(q => q.id === p.mirrorOf).name}`).join(', ') + '.'
      });
    }
  } else {
    parts.forEach(p => { p.quantity_detected = 1; p.instances = [{ sourceContourId: p.sourceContourId, x: p.origMinX, y: p.origMinY, rotationDeg: 0, frameId: p.frameId }]; });
  }
  const selfX = parts.filter(p => p.selfIntersecting);
  if (selfX.length) {
    report.items.push({ severity: 'alto', code: 'SELF_INTERSECTING_PARTS', message: `Peças com contorno que cruza a si mesmo: ${selfX.map(p => p.name).join(', ')}. Corrija no CAD antes de cortar.` });
  }
  report.summary.catalogParts = parts.length;
  report.summary.partInstances = parts.reduce((s, p) => s + (p.quantity_detected || 1), 0);
  return { catalogParts: parts, report, frames: contours.frames || [], warnings: contours.warnings || [] };
}

// =========================================================================
// 7. CHAPA CUSTOMIZADA
// =========================================================================

/**
 * Extrai a topologia completa da Chapa Principal via .DXF (Contorno Externo CCW + Obstáculos CW).
 */
function buildCustomSheetFromContours(contours) {
  if (!contours || !contours.length) {
    throw new Error('DXF da chapa sem contorno fechado.');
  }

  const sorted = [...contours].sort((a, b) => b.bbox.area - a.bbox.area);
  const outer = sorted[0];

  const normPts = enforceWindingOrder(
    outer.points.map(p => ({
      x: +(p.x - outer.bbox.minX).toFixed(3),
      y: +(p.y - outer.bbox.minY).toFixed(3)
    })),
    true
  );

  const rawObstacles = sorted.slice(1).filter(c => {
    const bboxInside =
      c.bbox.minX >= outer.bbox.minX - 0.5 &&
      c.bbox.maxX <= outer.bbox.maxX + 0.5 &&
      c.bbox.minY >= outer.bbox.minY - 0.5 &&
      c.bbox.maxY <= outer.bbox.maxY + 0.5;
    return bboxInside && isPointInPolygon(c.points[0], outer.points);
  });

  const normObstacles = rawObstacles.map((obs, idx) => {
    const pts = enforceWindingOrder(
      obs.points.map(p => ({
        x: +(p.x - outer.bbox.minX).toFixed(3),
        y: +(p.y - outer.bbox.minY).toFixed(3)
      })),
      false
    );
    const obBbox = getBoundingBox(pts);
    return {
      id: `OBS_CHAPA_${idx + 1}`,
      name: `Furo/Recorte da Chapa #${idx + 1}`,
      minX: obBbox.minX,
      minY: obBbox.minY,
      maxX: obBbox.maxX,
      maxY: obBbox.maxY,
      width: obBbox.width,
      height: obBbox.height,
      area: obs.trueArea,
      points: pts
    };
  });

  const obstaclesAreaSum = normObstacles.reduce((acc, o) => acc + o.area, 0);
  const netArea = Math.max(1, +(outer.trueArea - obstaclesAreaSum).toFixed(2));

  return {
    isCustomDxf: true,
    width: outer.bbox.width,
    height: outer.bbox.height,
    area: netArea,
    points: normPts,
    obstacles: normObstacles
  };
}

module.exports = {
  // geometria (reexportada de geometry/primitives para compatibilidade)
  getBoundingBox,
  computeSignedArea,
  isPointInPolygon,
  pointToSegmentDist,
  enforceWindingOrder,
  computeEdgeNormals,
  // curvas
  discretizeArcAdaptive,
  evaluateNurbsPoint,
  // DXF
  parseDxf,
  extractContoursFromDxf,
  // peças
  computeMaxInscribedCircle,
  offsetPolygonRing,
  classifyPartsAndHoles,
  groupIdenticalParts,
  buildCatalogFromDxf,
  buildCustomSheetFromContours
};
