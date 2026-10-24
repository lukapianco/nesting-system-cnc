// dxfWriter.js
'use strict';

/**
 * Escritor de DXF ASCII (AutoCAD R12 / AC1009).
 *
 * Por que R12: é o dialeto lido por praticamente qualquer CAD/CAM (AutoCAD, LibreCAD, SigmaNEST,
 * controladores CNC antigos). Usa POLYLINE/VERTEX/SEQEND em vez de LWPOLYLINE, não exige handles
 * nem tabelas BLOCK_RECORD, e cada par "código de grupo / valor" fica SEMPRE em linhas separadas.
 *
 * Convenção de coordenadas: o motor trabalha em Y-para-cima (mesma orientação do DXF de entrada),
 * logo a exportação NÃO inverte eixo algum — as peças saem com a mesma quiralidade do desenho original
 * (a versão anterior fazia H - y, o que espelhava cada peça).
 */

/**
 * Convenção de camadas (documentada em docs/FORMATO_DXF_EXPORTADO.md). Só as camadas de CORTE trazem peças;
 * as demais são referência e por padrão NÃO são exportadas, porque outros sistemas que classificam peças por
 * contenção (sem olhar camada) entendem o contorno da chapa como uma peça gigante com as peças como furos,
 * retalhos como peças e lead-ins como contornos abertos.
 */
const LAYERS = [
  { name: '0', color: 7, role: 'none' },
  { name: '0_CHAPA_LIMITE', color: 7, role: 'sheet' },
  { name: '0_CHAPA_FUROS_OBSTACULOS', color: 30, role: 'sheet_obstacle' },
  { name: '1_CORTE_PECAS', color: 5, role: 'cut' },
  { name: '1_PECA_IN_HOLE', color: 3, role: 'cut' },
  { name: '2_CORTE_FUROS', color: 2, role: 'cut' },
  { name: '3_RETALHOS_UTEIS', color: 6, role: 'remnant' },
  { name: '4_CAM_LEAD_IN', color: 1, role: 'cam' },
  { name: '5_TEXTO_PECAS', color: 8, role: 'text' }
];
const LAYER_ROLE = Object.fromEntries(LAYERS.map(l => [l.name, l.role]));

/** Opções padrão: só geometria de corte (lida corretamente por qualquer sistema). */
const DEFAULT_EXPORT = { includeSheet: false, includeRemnants: false, includeLeadIn: false, includeLabels: false };

function fmt(v) {
  const n = Math.round(Number(v) * 10000) / 10000;
  if (!Number.isFinite(n)) throw new Error('Coordenada inválida na exportação DXF.');
  return String(Object.is(n, -0) ? 0 : n);
}

class DxfBuilder {
  constructor() {
    this.lines = [];
    this.minX = Infinity; this.minY = Infinity; this.maxX = -Infinity; this.maxY = -Infinity;
  }

  g(code, value) {
    this.lines.push(String(code), String(value));
  }

  track(x, y) {
    if (x < this.minX) this.minX = x;
    if (y < this.minY) this.minY = y;
    if (x > this.maxX) this.maxX = x;
    if (y > this.maxY) this.maxY = y;
  }

  polyline(layer, pts, closed) {
    if (!pts || pts.length < 2) return;
    this.g(0, 'POLYLINE');
    this.g(8, layer);
    this.g(66, 1);
    this.g(10, 0); this.g(20, 0); this.g(30, 0);
    this.g(70, closed ? 1 : 0);
    for (const p of pts) {
      this.track(p.x, p.y);
      this.g(0, 'VERTEX');
      this.g(8, layer);
      this.g(10, fmt(p.x)); this.g(20, fmt(p.y)); this.g(30, 0);
    }
    this.g(0, 'SEQEND');
    this.g(8, layer);
  }

  text(layer, x, y, height, value) {
    this.track(x, y);
    this.g(0, 'TEXT');
    this.g(8, layer);
    this.g(10, fmt(x)); this.g(20, fmt(y)); this.g(30, 0);
    this.g(40, fmt(height));
    this.g(1, String(value).replace(/[\r\n]+/g, ' ').slice(0, 250));
  }

  line(layer, a, b) {
    this.track(a.x, a.y); this.track(b.x, b.y);
    this.g(0, 'LINE');
    this.g(8, layer);
    this.g(10, fmt(a.x)); this.g(20, fmt(a.y)); this.g(30, 0);
    this.g(11, fmt(b.x)); this.g(21, fmt(b.y)); this.g(31, 0);
  }
}

function absPts(part, pts) {
  return pts.map((p) => ({ x: part.x + p.x, y: part.y + p.y }));
}

/**
 * @param {Object} layout - resultado do worker (placedParts, sheetPoly, sheetObstacles, remnants, cam...)
 * @param {{includeSheet?: boolean, includeRemnants?: boolean, includeLeadIn?: boolean, includeLabels?: boolean}} opts
 *        Padrão: tudo falso = só contornos de corte (peças, furos, peças dentro de furos), em ordem de corte.
 * @returns {string}
 */
function buildDxf(layout, opts = {}) {
  const o = { ...DEFAULT_EXPORT, ...(opts || {}) };
  const includeRemnants = !!o.includeRemnants;
  const includeLeadIn = !!o.includeLeadIn;
  const W = layout.sheetWidth;
  const H = layout.sheetHeight;
  const b = new DxfBuilder();

  // ---- ENTITIES (acumuladas primeiro, para conhecer o EXTMIN/EXTMAX) ----
  if (o.includeSheet) {
    const sheetPts = layout.sheetPoly || [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    b.polyline('0_CHAPA_LIMITE', sheetPts, true);
    for (const obs of layout.sheetObstacles || []) b.polyline('0_CHAPA_FUROS_OBSTACULOS', obs.points, true);
  }

  const partById = new Map((layout.placedParts || []).map((p) => [p.id, p]));
  const emittedRings = new Set();
  const ringLayer = (part, kind) =>
    kind === 'HOLE' ? '2_CORTE_FUROS' : (part.nestedInsideHole ? '1_PECA_IN_HOLE' : '1_CORTE_PECAS');

  const emitRing = (part, kind, holeId) => {
    const key = `${part.id}|${kind}|${holeId || ''}`;
    if (emittedRings.has(key)) return;
    emittedRings.add(key);
    if (kind === 'HOLE') {
      const h = (part.placedHoles || []).find((x) => x.id === holeId);
      if (h) b.polyline(ringLayer(part, 'HOLE'), absPts(part, h.placedPoints), true);
    } else {
      b.polyline(ringLayer(part, 'OUTER'), absPts(part, part.placedPoints), true);
    }
  };

  const ops = (layout.cam && layout.cam.ops) || [];
  if (ops.length > 0) {
    // Escrita na ORDEM DE CORTE real (Inside-Out + vizinho mais próximo)
    for (const op of ops) {
      const part = partById.get(op.partId);
      if (!part) continue;
      emitRing(part, op.kind, op.holeId);
      if (includeLeadIn && op.leadPath && op.leadPath.length >= 2) {
        if (op.leadPath.length === 2) b.line('4_CAM_LEAD_IN', op.leadPath[0], op.leadPath[1]);
        else b.polyline('4_CAM_LEAD_IN', op.leadPath, false);
      }
    }
  }
  // Garante que nenhuma peça fique de fora mesmo sem plano CAM
  for (const part of layout.placedParts || []) {
    for (const h of part.placedHoles || []) emitRing(part, 'HOLE', h.id);
    emitRing(part, 'OUTER');
  }

  if (includeRemnants) {
    for (const r of layout.remnants || []) {
      b.polyline('3_RETALHOS_UTEIS', [
        { x: r.x, y: r.y }, { x: r.x + r.width, y: r.y },
        { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }
      ], true);
    }
  }

  if (o.includeLabels) {
    // Nome da peça no centro do retângulo envolvente (camada de texto; não é geometria de corte)
    for (const part of layout.placedParts || []) {
      const h = Math.max(2, Math.min(12, Math.min(part.placedWidth, part.placedHeight) * 0.12));
      b.text('5_TEXTO_PECAS', part.x + part.placedWidth * 0.1, part.y + part.placedHeight / 2, h, String(part.name || part.id).replace(/ \(\d+\/\d+\)$/, ''));
    }
  }

  return wrapDocument(b, W, H);
}

/**
 * DXF só com os retalhos úteis: cada retalho é um contorno fechado (camada 3_RETALHOS_UTEIS) com um texto de
 * medidas. Feito para sistemas de estoque/rastreio de sobras (cada retalho vira um item).
 * @param {{includeLabels?: boolean, includeSheet?: boolean}} opts
 */
function buildRemnantsDxf(layout, opts = {}) {
  const b = new DxfBuilder();
  const W = layout.sheetWidth, H = layout.sheetHeight;
  if (opts.includeSheet) b.polyline('0_CHAPA_LIMITE', layout.sheetPoly || [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], true);
  for (const r of layout.remnants || []) {
    b.polyline('3_RETALHOS_UTEIS', [
      { x: r.x, y: r.y }, { x: r.x + r.width, y: r.y },
      { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }
    ], true);
    if (opts.includeLabels !== false) {
      const h = Math.max(2, Math.min(25, Math.min(r.width, r.height) * 0.08));
      b.text('5_TEXTO_PECAS', r.x + h, r.y + r.height / 2, h, `${r.label || r.id} ${r.width}x${r.height} mm`);
    }
  }
  return wrapDocument(b, W, H);
}

function wrapDocument(b, W, H) {
  const out = new DxfBuilder();
  const ex = Number.isFinite(b.minX) ? b : { minX: 0, minY: 0, maxX: W || 0, maxY: H || 0 };
  out.g(0, 'SECTION'); out.g(2, 'HEADER');
  out.g(9, '$ACADVER'); out.g(1, 'AC1009');
  out.g(9, '$INSUNITS'); out.g(70, 4);
  out.g(9, '$EXTMIN'); out.g(10, fmt(ex.minX)); out.g(20, fmt(ex.minY)); out.g(30, 0);
  out.g(9, '$EXTMAX'); out.g(10, fmt(ex.maxX)); out.g(20, fmt(ex.maxY)); out.g(30, 0);
  out.g(0, 'ENDSEC');

  out.g(0, 'SECTION'); out.g(2, 'TABLES');
  out.g(0, 'TABLE'); out.g(2, 'LTYPE'); out.g(70, 1);
  out.g(0, 'LTYPE'); out.g(2, 'CONTINUOUS'); out.g(70, 0); out.g(3, 'Solid line'); out.g(72, 65); out.g(73, 0); out.g(40, 0.0);
  out.g(0, 'ENDTAB');
  out.g(0, 'TABLE'); out.g(2, 'LAYER'); out.g(70, LAYERS.length);
  for (const l of LAYERS) {
    out.g(0, 'LAYER'); out.g(2, l.name); out.g(70, 0); out.g(62, l.color); out.g(6, 'CONTINUOUS');
  }
  out.g(0, 'ENDTAB');
  out.g(0, 'ENDSEC');

  out.g(0, 'SECTION'); out.g(2, 'ENTITIES');
  out.lines.push(...b.lines);
  out.g(0, 'ENDSEC');
  out.g(0, 'EOF');

  return out.lines.join('\r\n') + '\r\n';
}

module.exports = { buildDxf, buildRemnantsDxf, LAYERS, LAYER_ROLE, DEFAULT_EXPORT };
