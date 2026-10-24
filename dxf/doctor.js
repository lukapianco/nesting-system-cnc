// dxf/doctor.js — "DXF Doctor": do documento lido aos contornos prontos para o motor, com diagnóstico.
//
// Etapas: unidades e achatamento (flatten) -> política de layers -> discretização -> costura (heal)
// -> árvore de contenção -> detecção de MOLDURA (contorno de chapa desenhado em volta das peças)
// -> rótulos de texto -> verificação de cruzamentos -> relatório.
//
// Nada aqui decide em silêncio: toda exclusão, fechamento de gap ou moldura detectada vai para o relatório.
'use strict';

const { flattenDxf } = require('./flatten');
const { pathPoints } = require('./curves');
const { healPaths, findSelfIntersections, bboxOf } = require('./heal');
const { computeSignedArea, isPointInPolygon, pointToRingDist, getBoundingBox, segmentsIntersectExact } = require('../geometry/primitives');
const { RTree2D } = require('../spatialIndex');

const SEVERITY_ORDER = { erro: 0, alto: 1, medio: 2, baixo: 3, info: 4 };

const DEFAULT_IMPORT = {
  units: 'auto',          // auto | mm | cm | m | in | ft
  joinTol: 0.25,          // mm: pontas a esta distância são a mesma (costura)
  maxGapHeal: 1.0,        // mm: gaps maiores que joinTol e até este valor são fechados (e relatados); 0 desliga
  frameMode: 'auto',      // auto: detecta moldura e não a trata como peça | part: tudo é peça
  includeDashed: false,   // linhas tracejadas/de centro entram como geometria de corte?
  includeHiddenLayers: false, // layers congeladas/desligadas/não plotáveis entram?
  excludeLayers: [],      // nomes de layer a excluir
  includeLayers: null,    // se informado, SÓ estas layers entram
  onlyFrames: null,       // ids de molduras: só as peças dentro delas entram
  forceLayers: [],        // layers que entram mesmo se a regra automática as excluiria (oculta, tracejada, auxiliar)
  minFeature: 0.5         // mm: contornos com largura E altura menores que isto são ruído
};

// Papel das camadas que o próprio motor exporta (docs/FORMATO_DXF_EXPORTADO.md): reler o DXF exportado
// reproduz as peças (a chapa é moldura, retalhos e lead-ins não são peças).
const KNOWN_LAYER_ROLE = {
  '0_CHAPA_LIMITE': 'sheet',
  '0_CHAPA_FUROS_OBSTACULOS': 'sheet_obstacle',
  '3_RETALHOS_UTEIS': 'remnant',
  '4_CAM_LEAD_IN': 'aux',
  '5_TEXTO_PECAS': 'aux'
};
// Nomes usuais de camadas que não são geometria de corte (comparação sem acento e sem caixa)
const AUX_LAYER_RE = /(^|[^a-z])(cota|cotas|cotagem|dim|dims|dimension|dimensions|dimensao|dimensoes|texto|textos|text|anotacao|anotacoes|hatch|hachura|hachuras|lead ?in|lead ?out|leadin|leadout|centro|center|centerline|eixo|eixos|construcao|construction|aux|auxiliar|auxiliares|carimbo|legenda|titulo|title|titleblock|viewport|vport)([^a-z]|$)/;
const normName = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[_\-.]+/g, ' ');
function layerRole(name) {
  if (KNOWN_LAYER_ROLE[name]) return KNOWN_LAYER_ROLE[name];
  return AUX_LAYER_RE.test(normName(name)) ? 'aux' : 'cut';
}

function normalizeImportOptions(o = {}) {
  const r = { ...DEFAULT_IMPORT, ...(o || {}) };
  r.joinTol = Math.max(0.001, Math.min(5, Number(r.joinTol) || DEFAULT_IMPORT.joinTol));
  r.maxGapHeal = Math.max(0, Math.min(20, Number(r.maxGapHeal ?? DEFAULT_IMPORT.maxGapHeal)));
  r.minFeature = Math.max(0, Math.min(10, Number(r.minFeature ?? DEFAULT_IMPORT.minFeature)));
  r.frameMode = ['auto', 'part'].includes(r.frameMode) ? r.frameMode : 'auto';
  r.excludeLayers = Array.isArray(r.excludeLayers) ? r.excludeLayers.map(String) : [];
  r.includeLayers = Array.isArray(r.includeLayers) && r.includeLayers.length ? r.includeLayers.map(String) : null;
  r.onlyFrames = Array.isArray(r.onlyFrames) && r.onlyFrames.length ? r.onlyFrames.map(String) : null;
  r.includeDashed = !!r.includeDashed;
  r.includeHiddenLayers = !!r.includeHiddenLayers;
  r.forceLayers = Array.isArray(r.forceLayers) ? r.forceLayers.map(String) : [];
  return r;
}

// ---------------------------------------------------------------------------
// Contenção robusta: vota com vários vértices do filho, ignorando os que caem na borda do pai.
// ---------------------------------------------------------------------------
function ringInside(child, parent, tol = 1e-6) {
  const n = child.length;
  const step = Math.max(1, Math.floor(n / 7));
  let ins = 0, out = 0;
  for (let i = 0; i < n && ins + out < 7; i += step) {
    const p = child[i];
    if (pointToRingDist(p.x, p.y, parent) <= tol) continue;
    if (isPointInPolygon(p, parent)) ins++; else out++;
  }
  if (ins + out === 0) {
    // todos os vértices sobre a borda: usa o centróide
    const c = centroid(child);
    return isPointInPolygon(c, parent);
  }
  return ins > out;
}

function centroid(r) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const s = r.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: s.x / r.length, y: s.y / r.length };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

function isAxisRectangle(r, bb) {
  const area = Math.abs(computeSignedArea(r));
  const bArea = (bb.maxX - bb.minX) * (bb.maxY - bb.minY);
  if (bArea <= 0) return false;
  if (Math.abs(area - bArea) > 1e-3 * bArea) return false;
  // todos os vértices na borda da caixa
  const tol = 1e-3 * Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY);
  return r.every(p => Math.abs(p.x - bb.minX) < tol || Math.abs(p.x - bb.maxX) < tol || Math.abs(p.y - bb.minY) < tol || Math.abs(p.y - bb.maxY) < tol);
}

function isCircleLike(r) {
  if (r.length < 12) return false;
  const c = centroid(r);
  let mn = Infinity, mx = -Infinity;
  for (const p of r) { const d = Math.hypot(p.x - c.x, p.y - c.y); if (d < mn) mn = d; if (d > mx) mx = d; }
  return mx > 0 && (mx - mn) / mx < 0.01;
}

function isConvex(r) {
  let sign = 0;
  const n = r.length;
  for (let i = 0; i < n; i++) {
    const a = r[i], b = r[(i + 1) % n], c = r[(i + 2) % n];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cr) < 1e-9) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

/**
 * Forma "de furo" típica: círculo, retângulo (mesmo girado), oblongo/rasgo, elipse ou polígono convexo
 * com poucos lados. Peças aninhadas costumam ser não convexas ou mais elaboradas.
 */
function isSimpleHoleShape(r) {
  if (isCircleLike(r)) return true;
  if (!isConvex(r)) return false;
  if (r.length <= 12) return true;
  const c = centroid(r);
  // extensão ao longo do eixo de maior comprimento (pelo vértice mais distante) e na perpendicular
  let far = r[0], fd = 0;
  for (const p of r) { const d = Math.hypot(p.x - c.x, p.y - c.y); if (d > fd) { fd = d; far = p; } }
  const ux = (far.x - c.x) / (fd || 1), uy = (far.y - c.y) / (fd || 1);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of r) {
    const s = (p.x - c.x) * ux + (p.y - c.y) * uy, t = -(p.x - c.x) * uy + (p.y - c.y) * ux;
    a0 = Math.min(a0, s); a1 = Math.max(a1, s); b0 = Math.min(b0, t); b1 = Math.max(b1, t);
  }
  const L = a1 - a0, W = b1 - b0;
  const area = Math.abs(computeSignedArea(r));
  const close = (x) => Math.abs(area - x) <= 0.02 * area;
  return close(L * W) || close((L - W) * W + Math.PI * W * W / 4) || close(Math.PI * L * W / 4);
}

const FRAME_LAYER_RE = /(moldura|chapa|sheet|frame|border|borda|limite|formato|retalho|stock|plate)/i;
const FRAME_TEXT_RE = /(chapa|sheet|\d+([.,]\d+)?\s*[x×]\s*\d+([.,]\d+)?\s*(m|mm)?\b|#\s*\d|esp\.?|espessura|aisi|inox|a[çc]o|alum)/i;

/**
 * @param {Object} doc   saída de readDxf
 * @param {{chordTol?:number}} geom
 * @param {Object} importOptions  ver DEFAULT_IMPORT
 */
function analyzeDxf(doc, geom = {}, importOptions = {}) {
  const opt = normalizeImportOptions(importOptions);
  const chordTol = Math.max(0.001, Number(geom.chordTol) || 0.03);
  const items = [];   // { severity, code, message, where? }
  const add = (severity, code, message, where) => items.push({ severity, code, message, ...(where ? { where } : {}) });

  for (const w of doc.warnings || []) add(w.severity || 'medio', w.code, w.message);

  // ---- 1. achatamento
  const flat = flattenDxf(doc, { units: opt.units });
  for (const w of flat.warnings) add(w.severity || 'medio', w.code, w.message);

  // ---- 2. política de layers
  const layerStats = new Map();
  const touchLayer = (name) => {
    if (!layerStats.has(name)) {
      const L = doc.layers.get(name);
      layerStats.set(name, {
        name,
        paths: 0, included: 0,
        frozen: !!(L && L.frozen), off: !!(L && L.off), plot: L ? L.plot : true,
        color: L ? L.color : 7,
        role: layerRole(name),
        reasons: new Set()
      });
    }
    return layerStats.get(name);
  };
  const included = [];
  let dashedExcluded = 0, hiddenExcluded = 0, invisibleExcluded = 0;
  const auxExcluded = new Map(), remnantPaths = [], obstaclePaths = [];
  for (const p of flat.paths) {
    const ls = touchLayer(p.layer);
    ls.paths++;
    let reason = null;
    const forced = opt.forceLayers.includes(p.layer);
    if (opt.includeLayers && !opt.includeLayers.includes(p.layer)) reason = 'fora da lista de layers escolhidas';
    else if (opt.excludeLayers.includes(p.layer)) reason = 'excluída pelo usuário';
    else if (forced) reason = null;
    else if (!opt.includeHiddenLayers && (ls.frozen || ls.off)) { reason = ls.frozen ? 'layer congelada' : 'layer desligada'; hiddenExcluded++; }
    else if (!opt.includeHiddenLayers && (!ls.plot || p.layer.toUpperCase() === 'DEFPOINTS')) { reason = 'layer não plotável (auxiliar)'; hiddenExcluded++; }
    else if (ls.role === 'remnant') { reason = 'camada de retalhos (não são peças)'; remnantPaths.push(p); }
    else if (ls.role === 'sheet_obstacle') { reason = 'furos/defeitos da chapa (não são peças)'; obstaclePaths.push(p); }
    else if (ls.role === 'aux') { reason = 'camada auxiliar (cota, texto, eixo, lead-in…)'; auxExcluded.set(p.layer, (auxExcluded.get(p.layer) || 0) + 1); }
    else if (p.invisible) { reason = 'entidade invisível'; invisibleExcluded++; }
    else if (p.dashed && !opt.includeDashed && !forced) { reason = `tipo de linha tracejado/centro (${p.linetype})`; dashedExcluded++; }
    if (reason) { ls.reasons.add(reason); continue; }
    ls.included++;
    included.push(p);
  }
  if (dashedExcluded) add('medio', 'DASHED_EXCLUDED', `${dashedExcluded} entidade(s) com linha tracejada/de centro foram tratadas como linhas auxiliares (não cortadas). Se forem corte, ative "incluir tracejadas".`);
  if (hiddenExcluded) add('medio', 'HIDDEN_LAYERS', `${hiddenExcluded} entidade(s) em layers congeladas, desligadas ou não plotáveis foram ignoradas (não aparecem no CAD).`);
  if (invisibleExcluded) add('baixo', 'INVISIBLE', `${invisibleExcluded} entidade(s) marcadas como invisíveis foram ignoradas.`);
  if (auxExcluded.size) add('baixo', 'AUX_LAYERS', `Camadas auxiliares ignoradas (não são corte): ${[...auxExcluded].map(([l, n]) => `${l} (${n})`).join(', ')}. Se alguma tiver peças, marque-a na lista de layers.`);
  const remnantInfo = remnantPaths.map(p => { const b = bboxOf(pathPoints(p, chordTol)); return { w: +(b.maxX - b.minX).toFixed(1), h: +(b.maxY - b.minY).toFixed(1) }; });
  if (remnantInfo.length) add('info', 'REMNANTS_IN_FILE', `${remnantInfo.length} retalho(s) desenhado(s) na camada de retalhos (não entram como peças): ${remnantInfo.slice(0, 8).map(r => `${r.w}×${r.h}`).join(', ')}${remnantInfo.length > 8 ? '…' : ''} mm.`);
  if (obstaclePaths.length) add('info', 'SHEET_OBSTACLES_IN_FILE', `${obstaclePaths.length} furo(s)/defeito(s) de chapa na camada própria (não entram como peças).`);

  // ---- 3. discretização + costura
  const disc = included.map(p => ({ pts: pathPoints(p, chordTol), closed: p.closed, meta: p }));
  const healed = healPaths(disc, { joinTol: opt.joinTol, maxGapHeal: opt.maxGapHeal, chordTol });
  const hs = healed.stats;
  if (hs.duplicatesRemoved) add('medio', 'DUPLICATES', `${hs.duplicatesRemoved} entidade(s)/contorno(s) duplicado(s) sobreposto(s) removido(s) (seriam cortados duas vezes).`);
  if (hs.gapsHealed.length) {
    const mx = Math.max(...hs.gapsHealed.map(g => g.gap));
    add('medio', 'GAPS_HEALED', `${hs.gapsHealed.length} abertura(s) entre ${opt.joinTol} e ${opt.maxGapHeal} mm foram fechadas (maior: ${mx.toFixed(3)} mm). Confira no CAD se o contorno deveria mesmo ser fechado.`,
      hs.gapsHealed.slice(0, 20));
  }
  if (hs.zeroAreaDropped) add('baixo', 'ZERO_AREA', `${hs.zeroAreaDropped} contorno(s) de área nula descartado(s).`);
  if (hs.ambiguousNodes) add('baixo', 'AMBIGUOUS_NODES', `${hs.ambiguousNodes} ponto(s) onde 3 ou mais linhas se encontram (peças encostadas ou linhas sobrepostas); a costura escolheu a continuação mais provável.`);

  const open = healed.openChains;
  if (open.length) {
    // relevante = parece contorno de peça (não marca de canto/traço curto): extensão >= 15 mm
    const big = open.filter(c => Math.max(c.bbox.maxX - c.bbox.minX, c.bbox.maxY - c.bbox.minY) >= 15);
    const totalLen = open.reduce((s, c) => s + c.length, 0);
    const where = open.slice().sort((a, b) => b.length - a.length).slice(0, 20).map(c => ({
      x: +((c.bbox.minX + c.bbox.maxX) / 2).toFixed(2), y: +((c.bbox.minY + c.bbox.maxY) / 2).toFixed(2),
      length: +c.length.toFixed(2), gap: +Math.hypot(c.pts[0].x - c.pts[c.pts.length - 1].x, c.pts[0].y - c.pts[c.pts.length - 1].y).toFixed(3),
      layer: c.metas[0] && c.metas[0].layer
    }));
    add(big.length ? 'alto' : 'baixo', 'OPEN_CONTOURS',
      `${open.length} linha(s)/contorno(s) aberto(s) ignorado(s) (${totalLen.toFixed(1)} mm no total)` +
      (big.length ? `; ${big.length} com 15 mm ou mais de extensão — se forem peças, feche-as no CAD (JOIN) ou aumente a tolerância de fechamento.` : ' (marcas/linhas auxiliares curtas).'),
      where);
  }

  // ---- 4. anéis com metadados
  let rings = healed.rings.map((r, i) => {
    const bb = bboxOf(r.pts);
    const area = computeSignedArea(r.pts);
    const layers = [...new Set(r.sources.map(s => s && s.layer).filter(Boolean))];
    const blocks = [...new Set(r.sources.map(s => s && s.partBlock).filter(Boolean))];
    const instances = [...new Set(r.sources.map(s => s && s.instance).filter(Boolean))];
    const types = [...new Set(r.sources.map(s => s && s.entityType).filter(Boolean))];
    return { idx: i, pts: r.pts, bb, absArea: Math.abs(area), layers, blocks, instances, types, healed: r.healed, parent: -1, children: [], depth: 0 };
  });

  // ruído minúsculo
  const tiny = rings.filter(r => (r.bb.maxX - r.bb.minX) < opt.minFeature && (r.bb.maxY - r.bb.minY) < opt.minFeature);
  if (tiny.length) {
    add('baixo', 'TINY', `${tiny.length} contorno(s) menor(es) que ${opt.minFeature} mm descartado(s) como ruído de desenho.`);
    rings = rings.filter(r => !tiny.includes(r));
    rings.forEach((r, i) => { r.idx = i; });
  }

  // ---- 5. árvore de contenção (pai = menor anel que contém)
  const order = rings.slice().sort((a, b) => b.absArea - a.absArea);
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    let best = null;
    for (let j = i - 1; j >= 0; j--) {
      const p = order[j];
      if (p.absArea <= c.absArea) continue;
      if (c.bb.minX < p.bb.minX - 1e-6 || c.bb.maxX > p.bb.maxX + 1e-6 || c.bb.minY < p.bb.minY - 1e-6 || c.bb.maxY > p.bb.maxY + 1e-6) continue;
      if (ringInside(c.pts, p.pts)) { best = p; break; } // ordem decrescente de área, de trás p/ frente: o 1º achado é o menor
    }
    if (best) { c.parent = best.idx; best.children.push(c.idx); }
  }
  const setDepth = (r, d) => { r.depth = d; for (const ci of r.children) setDepth(rings[ci], d + 1); };
  rings.filter(r => r.parent < 0).forEach(r => setDepth(r, 0));

  // ---- 6. textos (rótulos)
  const texts = flat.texts.map(t => ({ ...t, ring: -1 }));
  for (const t of texts) {
    let best = null;
    for (const r of rings) {
      if (t.x < r.bb.minX || t.x > r.bb.maxX || t.y < r.bb.minY || t.y > r.bb.maxY) continue;
      if (!isPointInPolygon(t, r.pts)) continue;
      if (!best || r.absArea < best.absArea) best = r;
    }
    if (best) t.ring = best.idx;
  }

  // ---- 7. molduras
  const frames = [];
  const possibleFrames = [];
  if (opt.frameMode === 'auto') {
    for (const r of rings) {
      // contorno na camada de chapa do próprio motor: é a chapa (mesmo irregular ou vazia)
      const onSheetLayer = r.layers.length > 0 && r.layers.every(l => layerRole(l) === 'sheet');
      if (r.depth !== 0 || (!r.children.length && !onSheetLayer)) continue;
      if (!isAxisRectangle(r.pts, r.bb) && !onSheetLayer) continue;
      const kids = r.children.map(ci => rings[ci]);
      const n = kids.length;
      const fill = n ? kids.reduce((s, k) => s + k.absArea, 0) / r.absArea : 0;
      const grandkids = kids.some(k => k.children.length > 0);
      const circles = n ? kids.filter(k => isCircleLike(k.pts)).length / n : 0;
      const complexFrac = n ? kids.filter(k => !isSimpleHoleShape(k.pts)).length / n : 0;
      const w = r.bb.maxX - r.bb.minX, h = r.bb.maxY - r.bb.minY;
      const ownTexts = texts.filter(t => t.ring === r.idx).map(t => t.text);
      const layerCue = r.layers.some(l => FRAME_LAYER_RE.test(l));
      const textCue = ownTexts.some(t => FRAME_TEXT_RE.test(t));
      const frameInst = r.instances.length === 1 ? r.instances[0] : null;
      const sameInstance = frameInst && frameInst !== 'M' && kids.every(k => k.instances.length === 1 && k.instances[0] === frameInst);
      const fromInserts = n ? kids.filter(k => k.instances.some(i => i !== 'M' && i !== frameInst)).length / n : 0;
      const reasons = [];
      if (layerCue) reasons.push(`layer "${r.layers.join(', ')}"`);
      if (textCue) reasons.push('texto de chapa/material dentro dele');
      // "contorno dentro de contorno dentro do retângulo" também é placa com peça aninhada no recorte
      // (Part-in-Part): só conta junto com conteúdo com forma de peça
      if (grandkids && complexFrac >= 0.5 && n >= 2) reasons.push('contornos internos têm forma de peça e furos próprios');
      if (fill >= 0.25 && complexFrac >= 0.5) reasons.push(`${Math.round(complexFrac * 100)}% dos contornos internos têm forma de peça e ocupam ${Math.round(fill * 100)}% do retângulo`);
      else if (fill >= 0.25 && fromInserts >= 0.5 && n >= 2) reasons.push(`contornos internos vêm de blocos/matrizes e ocupam ${Math.round(fill * 100)}% do retângulo`);
      const sheetLayer = r.layers.length > 0 && r.layers.every(l => layerRole(l) === 'sheet');
      if (sheetLayer) reasons.unshift(`camada ${r.layers.join(', ')} (contorno da chapa)`);
      const strong = layerCue || textCue || sheetLayer;
      // círculos sozinhos parecem chapa perfurada; com sinal forte (arruelas com furo, layer/texto de chapa) é moldura
      const isFrame = sheetLayer || (!sameInstance && reasons.length > 0 && (n >= 2 || strong) && (circles < 0.8 || strong));
      if (!isFrame) {
        if (n >= 3 && fill >= 0.25 && circles < 0.8) possibleFrames.push({ w, h, n, fill });
        continue;
      }
      frames.push({
        id: `MOLDURA_${frames.length + 1}`,
        ringIdx: r.idx,
        width: +w.toFixed(3),
        height: +h.toFixed(3),
        minX: r.bb.minX, minY: r.bb.minY,
        partContours: n,
        labels: ownTexts,
        layers: r.layers,
        reasons
      });
    }
  }
  for (const pf of possibleFrames) {
    add('medio', 'POSSIBLE_FRAME', `Retângulo ${pf.w.toFixed(0)} × ${pf.h.toFixed(0)} mm com ${pf.n} contornos simples dentro (${Math.round(pf.fill * 100)}% da área) foi tratado como PEÇA com furos. Se for a moldura/chapa de um nesting, coloque-o numa layer "MOLDURA" ou "CHAPA".`);
  }
  const frameIdx = new Set(frames.map(f => f.ringIdx));
  for (const f of frames) {
    add('info', 'FRAME', `Moldura ${f.width.toFixed(0)} × ${f.height.toFixed(0)} mm detectada (${f.reasons.join('; ')}). ` +
      `Tratada como contorno da chapa, não como peça${f.labels.length ? ` — rótulo: "${f.labels.join(' / ').replace(/\n/g, ' ')}"` : ''}.`);
  }

  // filtro por moldura escolhida
  let keep = rings.filter(r => !frameIdx.has(r.idx));
  if (opt.onlyFrames && frames.length) {
    const chosen = new Set(frames.filter(f => opt.onlyFrames.includes(f.id)).map(f => f.ringIdx));
    const under = (r) => { let p = r.parent; while (p >= 0) { if (chosen.has(p)) return true; p = rings[p].parent; } return false; };
    keep = keep.filter(under);
  }
  // pai efetivo (pulando molduras) para a classificação peça/furo
  const effParent = (r) => { let p = r.parent; while (p >= 0 && frameIdx.has(p)) p = rings[p].parent; return p; };

  // ---- 8. auto-interseção e cruzamento entre contornos
  const selfX = [];
  for (const r of keep) {
    const hits = findSelfIntersections(r.pts, 3);
    if (hits.length) { r.selfIntersections = hits; selfX.push({ x: +hits[0].x.toFixed(2), y: +hits[0].y.toFixed(2) }); }
  }
  for (const h of hs.selfIntersectingDropped || []) selfX.push({ x: +h.x.toFixed(2), y: +h.y.toFixed(2), descartado: true });
  if (selfX.length) add('alto', 'SELF_INTERSECTION', `${selfX.length} contorno(s) cruzam a si mesmos (laço/"oito"). O corte pode sair errado; corrija no CAD.` + (selfX.some(x => x.descartado) ? ' Os de área líquida nula foram descartados.' : ''), selfX.slice(0, 20));

  const crossings = findRingCrossings(keep, 20);
  if (crossings.length) add('alto', 'RINGS_CROSS', `${crossings.length}+ ponto(s) onde contornos diferentes se cruzam (peças sobrepostas no desenho ou furo invadindo a borda). Confira esses pontos.`, crossings);

  // ---- 9. saída no formato que o classificador espera
  const contours = keep.map(r => {
    const bbox = getBoundingBox(r.pts);
    const signedArea = computeSignedArea(r.pts);
    return {
      id: `R_${r.idx}`,
      type: r.types.length === 1 ? r.types[0] : 'CHAINED_RING',
      points: r.pts.map(p => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4) })),
      bbox,
      signedArea,
      trueArea: +Math.abs(signedArea).toFixed(2),
      parentId: effParent(r) >= 0 ? `R_${effParent(r)}` : null,
      frameId: (() => { let p = r.parent; while (p >= 0) { const f = frames.find(fr => fr.ringIdx === p); if (f) return f.id; p = rings[p].parent; } return null; })(),
      layers: r.layers,
      blockName: r.blocks.length === 1 ? r.blocks[0] : null,
      instances: r.instances,
      labels: texts.filter(t => t.ring === r.idx).map(t => t.text),
      healedGaps: r.healed.length,
      selfIntersecting: !!r.selfIntersections
    };
  });

  // ---- 10. escala suspeita e conteúdo vazio
  if (!contours.length) {
    add('erro', 'NO_CONTOURS', 'Nenhum contorno fechado foi encontrado. Verifique se as peças estão no espaço do modelo, em layers visíveis, e se os contornos fecham.');
  } else {
    const maxDim = Math.max(...contours.map(c => Math.max(c.bbox.width, c.bbox.height)));
    if (maxDim < 2) add('alto', 'SCALE_SMALL', `A maior peça mede ${maxDim.toFixed(3)} mm: escala suspeita (desenho em metros?). Confira a unidade.`);
    if (maxDim > 20000) add('alto', 'SCALE_LARGE', `A maior peça mede ${(maxDim / 1000).toFixed(1)} m: escala suspeita (desenho em mícrons ou unidade errada?). Confira a unidade.`);
    if (flat.units.code === 0 && maxDim < 100 && doc.header.measurement !== 1) {
      add('medio', 'MAYBE_INCHES', `Arquivo sem unidade e peças pequenas (maior: ${maxDim.toFixed(2)}): se o desenho estiver em polegadas, escolha a unidade "in".`);
    }
  }

  // blocos definidos mas não usados com geometria (ex.: sobras de copiar/colar)
  const used = new Set();
  const markUsed = (ents, depth) => {
    if (depth > 40) return;
    for (const e of ents) if (e.type === 'INSERT' && !used.has(e.name) && doc.blocks.has(e.name)) { used.add(e.name); markUsed(doc.blocks.get(e.name).entities, depth + 1); }
  };
  markUsed(doc.entities, 0);
  const unusedWithGeom = [...doc.blocks.values()].filter(b => !used.has(b.name) && !/^\*(MODEL|PAPER)_SPACE/i.test(b.name) &&
    !/^\*[DTX]/i.test(b.name) && b.entities.some(e => ['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'SPLINE', 'ELLIPSE', 'INSERT'].includes(e.type)));
  if (unusedWithGeom.length) {
    const named = unusedWithGeom.filter(b => !b.anonymous);
    const anon = unusedWithGeom.length - named.length;
    const describeBlk = (b) => {
      const t = b.entities.find(e => (e.type === 'MTEXT' || e.type === 'TEXT') && e.text);
      return t ? `${b.name} ("${t.text.replace(/\n/g, ' ').slice(0, 60)}")` : b.name;
    };
    // blocos com texto primeiro (costumam ser os "esquecidos" que o usuário procura)
    named.sort((a, b) => Number(!!b.entities.find(e => e.text)) - Number(!!a.entities.find(e => e.text)));
    const list = named.slice(0, 6).map(describeBlk).join(', ') + (named.length > 6 ? '…' : '');
    add('info', 'UNUSED_BLOCKS', `${unusedWithGeom.length} definição(ões) de bloco com geometria não estão inseridas no desenho e foram ignoradas` +
      ` (normal após copiar/colar, matrizes editadas ou apagar)${named.length ? ': ' + list : ''}${anon ? ` e ${anon} bloco(s) anônimo(s)` : ''}.` +
      ' Se uma peça deveria entrar, insira o bloco no espaço do modelo.');
  }

  items.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const report = {
    file: {
      version: doc.version,
      encoding: doc.encoding,
      units: `${flat.units.name} (${flat.units.source})`,
      unitScaleToMm: flat.units.mm,
      sections: doc.sections
    },
    summary: {
      entities: flat.stats.entitiesByType,
      ignored: flat.stats.ignoredByType,
      inserts: flat.stats.inserts,
      blockDepth: flat.stats.insertDepthMax,
      mirroredInserts: flat.stats.mirroredInserts,
      paths: flat.paths.length,
      pathsUsed: included.length,
      closedContours: contours.length,
      openContours: open.length,
      frames: frames.length,
      texts: texts.length
    },
    layers: [...layerStats.values()].map(l => ({
      name: l.name, paths: l.paths, included: l.included, frozen: l.frozen, off: l.off, plot: l.plot, color: l.color,
      excludedBecause: [...l.reasons]
    })),
    frames: frames.map(f => ({ id: f.id, width: f.width, height: f.height, partContours: f.partContours, labels: f.labels, reasons: f.reasons })),
    items,
    importOptions: opt,
    ok: !items.some(i => i.severity === 'erro')
  };

  contours.report = report;
  contours.frames = frames;
  contours.warnings = items.filter(i => SEVERITY_ORDER[i.severity] <= SEVERITY_ORDER.medio).map(i => i.message);
  return contours;
}

/** Cruzamentos próprios entre arestas de contornos diferentes (R-tree de arestas). */
function findRingCrossings(rings, limit = 20) {
  const entries = [];
  rings.forEach((r, ri) => {
    const pts = r.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      entries.push({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y), data: { ri, a, b } });
    }
  });
  if (!entries.length) return [];
  const tree = new RTree2D(16);
  tree.loadBulk(entries);
  const out = [];
  const seenPairs = new Set();
  for (const e of entries) {
    if (out.length >= limit) break;
    const { ri, a, b } = e.data;
    for (const f of tree.search(e)) {
      if (f.ri <= ri) continue;
      const key = ri + '_' + f.ri;
      if (seenPairs.has(key)) continue;
      if (segmentsIntersectExact(a, b, f.a, f.b)) {
        seenPairs.add(key);
        out.push({ x: +((a.x + b.x) / 2).toFixed(2), y: +((a.y + b.y) / 2).toFixed(2) });
        break;
      }
    }
  }
  return out;
}

module.exports = { analyzeDxf, normalizeImportOptions, DEFAULT_IMPORT, ringInside, centroid };
