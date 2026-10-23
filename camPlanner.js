// camPlanner.js
'use strict';

const { isPointInPolygon } = require('./cadParser');

/**
 * Planejamento CAM de um layout já posicionado.
 *
 * Para CADA contorno de corte (furos E contornos externos, incluindo peças filhas In-Hole):
 *   1. gera candidatos de ponto de entrada (aresta + lead-in ARC / 45° / 90°);
 *   2. valida o ponto de perfuração e o caminho do lead-in: dentro da chapa, em SUCATA
 *      (nunca sobre material de peça), com distância mínima das demais peças e longe da própria aresta;
 *   3. ordena o corte: Inside-Out (filhas -> furo -> contorno da mãe), peça a peça, com o
 *      vizinho mais próximo, e escolhe o candidato que minimiza o deslocamento G00.
 *
 * Convenção de anéis (mantida pelo motor): contorno externo CCW (A>0), furos CW (A<0).
 * Com isso a normal à DIREITA da aresta (dy, -dx) aponta sempre para a SUCATA
 * (fora da peça no contorno externo; para dentro do vazio no furo).
 */

const TYPE_ORDER = ['ARC', 'LINE_45', 'LINE_90'];
const MAX_EDGES_PER_RING = 20;
const MAX_CANDS_PER_OP = 6;
const GRID_CELL = 50;

// ---------------------------------------------------------------- geometria básica
function segDistSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return (px - x1) ** 2 + (py - y1) ** 2;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
}

function ringDist(px, py, ring) {
  let m = Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const d = segDistSq(px, py, a.x, a.y, b.x, b.y);
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}

function bboxOf(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

const inBox = (b, x, y, pad = 0) => x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
const boxGap = (b, x, y) => Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minY - y, 0, y - b.maxY));

function ringPerimeter(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  // cruzamento PRÓPRIO: encostar no contorno (ponto de partida sobre a peça recém-cortada) não conta
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function segmentCrossesRing(a, b, ring) {
  for (let i = 0, n = ring.length; i < n; i++) {
    if (segmentsCross(a, b, ring[i], ring[(i + 1) % n])) return true;
  }
  return false;
}

const absRing = (part, pts) => pts.map((p) => ({ x: part.x + p.x, y: part.y + p.y }));

// ---------------------------------------------------------------- contexto espacial
function buildContext(res, params) {
  const items = [];
  for (const part of res.placedParts) {
    const outer = absRing(part, part.placedPoints);
    const holes = (part.placedHoles || []).map((h) => {
      const ring = absRing(part, h.placedPoints);
      return { id: h.id, ring, bbox: bboxOf(ring) };
    });
    items.push({ part, id: part.id, outer, outerBox: bboxOf(outer), holes, nested: !!part.nestedInsideHole });
  }

  const grid = new Map();
  const cellsOf = (b) => {
    const c = [];
    for (let cx = Math.floor(b.minX / GRID_CELL); cx <= Math.floor(b.maxX / GRID_CELL); cx++) {
      for (let cy = Math.floor(b.minY / GRID_CELL); cy <= Math.floor(b.maxY / GRID_CELL); cy++) c.push(`${cx},${cy}`);
    }
    return c;
  };
  for (const it of items) {
    for (const k of cellsOf(it.outerBox)) {
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(it);
    }
  }

  const near = (x, y, r) => {
    const out = new Set();
    for (let cx = Math.floor((x - r) / GRID_CELL); cx <= Math.floor((x + r) / GRID_CELL); cx++) {
      for (let cy = Math.floor((y - r) / GRID_CELL); cy <= Math.floor((y + r) / GRID_CELL); cy++) {
        const l = grid.get(`${cx},${cy}`);
        if (l) for (const it of l) out.add(it);
      }
    }
    return out;
  };

  return { items, near, res, params };
}

/** Ponto de sucata = fora de todo material de peça (contorno externo menos furos). */
function isScrap(ctx, x, y) {
  for (const it of ctx.near(x, y, 0.5)) {
    if (!inBox(it.outerBox, x, y)) continue;
    if (!isPointInPolygon({ x, y }, it.outer)) continue;
    let inHole = false;
    for (const h of it.holes) {
      if (inBox(h.bbox, x, y) && isPointInPolygon({ x, y }, h.ring)) { inHole = true; break; }
    }
    if (!inHole) return false;
  }
  return true;
}

/** Menor distância do ponto a qualquer contorno que NÃO seja o próprio (até `cap`). */
function minDistOthers(ctx, x, y, cap, ownKey) {
  let m = cap;
  for (const it of ctx.near(x, y, cap)) {
    if (`${it.id}|O` !== ownKey && boxGap(it.outerBox, x, y) < m) {
      const d = ringDist(x, y, it.outer);
      if (d < m) m = d;
    }
    for (const h of it.holes) {
      if (`${it.id}|H|${h.id}` === ownKey || boxGap(h.bbox, x, y) >= m) continue;
      const d = ringDist(x, y, h.ring);
      if (d < m) m = d;
    }
  }
  return m;
}

function insideSheet(ctx, x, y, edgeClear) {
  const r = ctx.res;
  if (r.sheetPoly) {
    if (!isPointInPolygon({ x, y }, r.sheetPoly)) return false;
    if (ringDist(x, y, r.sheetPoly) < edgeClear) return false;
    for (const o of r.sheetObstacles || []) {
      if (!inBox(o, x, y, edgeClear)) continue;
      if (isPointInPolygon({ x, y }, o.points) || ringDist(x, y, o.points) < edgeClear) return false;
    }
    return true;
  }
  return x >= edgeClear && y >= edgeClear && x <= r.sheetWidth - edgeClear && y <= r.sheetHeight - edgeClear;
}

function inRemnant(res, x, y) {
  for (const r of res.remnants || []) {
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return true;
  }
  return false;
}

// ---------------------------------------------------------------- lead-in
function makeLead(type, E, t, n, L) {
  if (L <= 0.01) return [{ x: E.x, y: E.y }];
  if (type === 'LINE_90') return [{ x: E.x + n.x * L, y: E.y + n.y * L }, { x: E.x, y: E.y }];
  if (type === 'LINE_45') {
    const k = Math.SQRT1_2 * L;
    return [{ x: E.x + n.x * k - t.x * k, y: E.y + n.y * k - t.y * k }, { x: E.x, y: E.y }];
  }
  // ARC tangente: centro C = E + n*R; P(β) = C + R(-n cosβ - t sinβ), β: 90° -> 0 (termina em E, tangente a t)
  const R = L, steps = 8, pts = [];
  for (let s = 0; s <= steps; s++) {
    const beta = (Math.PI / 2) * (1 - s / steps);
    pts.push({
      x: E.x + n.x * R + R * (-n.x * Math.cos(beta) - t.x * Math.sin(beta)),
      y: E.y + n.y * R + R * (-n.y * Math.cos(beta) - t.y * Math.sin(beta))
    });
  }
  pts[pts.length - 1] = { x: E.x, y: E.y };
  return pts;
}

function validateLead(ctx, path, E, ownKey, ownRing) {
  const { params } = ctx;
  const kerfHalf = params.kerf_width / 2;
  const pierce = path[0];
  if (path.length === 1) return { ok: true, clear: 0 };

  const pierceEdgeClear = Math.min(3, Math.max(1, params.sheet_margin / 2));
  if (!insideSheet(ctx, pierce.x, pierce.y, pierceEdgeClear)) return { ok: false };
  const samples = [];
  for (let i = 0; i < path.length - 1; i++) {
    samples.push(path[i]);
    const a = path[i], b = path[i + 1];
    samples.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  }
  for (const q of samples) {
    if (!insideSheet(ctx, q.x, q.y, 0.3)) return { ok: false };
    if (Math.hypot(q.x - E.x, q.y - E.y) < 0.3) continue; // junto da aresta: ambíguo, ignora
    if (!isScrap(ctx, q.x, q.y)) return { ok: false };
  }
  const clear = minDistOthers(ctx, pierce.x, pierce.y, 12, ownKey);
  if (clear < params.pierce_radius + kerfHalf + 0.3) return { ok: false };
  for (let i = 1; i < path.length - 1; i++) {
    if (minDistOthers(ctx, path[i].x, path[i].y, 3, ownKey) < kerfHalf + 0.2) return { ok: false };
  }
  if (ringDist(pierce.x, pierce.y, ownRing) < params.pierce_radius + 0.3) return { ok: false };
  return { ok: true, clear };
}

function pickEdges(ring) {
  const n = ring.length;
  let edges = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= 1.0) edges.push({ i, len });
  }
  if (edges.length === 0) {
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 1e-6) edges.push({ i, len });
    }
  }
  if (edges.length <= MAX_EDGES_PER_RING) return edges;
  const stride = Math.ceil(edges.length / (MAX_EDGES_PER_RING - 3));
  const picked = new Map();
  edges.forEach((e, k) => { if (k % stride === 0) picked.set(e.i, e); });
  [...edges].sort((a, b) => b.len - a.len).slice(0, 3).forEach((e) => picked.set(e.i, e));
  return [...picked.values()];
}

function candidatesForRing(ctx, ring, ownKey) {
  const { params, res } = ctx;
  const L0 = params.lead_in_length;
  const types = [params.lead_in_type, ...TYPE_ORDER.filter((x) => x !== params.lead_in_type)];
  const lengths = L0 > 0.01 ? [L0, L0 * 0.6] : [0];
  const cands = [];
  const edges = pickEdges(ring);

  const build = (e, frac, relaxed) => {
    const a = ring[e.i], b = ring[(e.i + 1) % ring.length];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const t = { x: dx / len, y: dy / len };
    const n = { x: t.y, y: -t.x }; // normal à direita = lado da sucata
    const E = { x: a.x + dx * frac, y: a.y + dy * frac };
    for (const type of (relaxed ? ['LINE_90'] : types)) {
      for (const L of lengths) {
        const path = makeLead(type, E, t, n, L);
        const v = relaxed ? { ok: true, clear: minDistOthers(ctx, path[0].x, path[0].y, 12, ownKey) } : validateLead(ctx, path, E, ownKey, ring);
        if (!v.ok) continue;
        const remnantHit = inRemnant(res, path[0].x, path[0].y);
        const quality = Math.min(v.clear, 12) + Math.min(e.len, 20) * 0.15
          + (type === params.lead_in_type ? 1 : 0) + (L === lengths[0] ? 1 : 0) - (remnantHit ? 10 : 0);
        return { entry: E, t, n, leadPath: path, leadType: type, leadLen: L, pierce: path[0], clear: v.clear, quality, invalid: !!relaxed };
      }
    }
    return null;
  };

  for (const e of edges) {
    const fracs = e.len >= 14 ? [0.3, 0.5, 0.7] : [0.5];
    for (const f of fracs) { const c = build(e, f, false); if (c) cands.push(c); }
  }
  if (cands.length === 0) {
    // Sem candidato válido: devolve o de maior folga, marcado como inválido (aviso ao operador)
    let best = null;
    for (const e of edges) { const c = build(e, 0.5, true); if (c && (!best || c.clear > best.clear)) best = c; }
    if (best) cands.push(best);
  }
  cands.sort((x, y) => y.quality - x.quality);
  return cands.slice(0, MAX_CANDS_PER_OP);
}

// ---------------------------------------------------------------- sequenciamento
function planCam(res, params) {
  const ctx = buildContext(res, params);
  const home = { x: 0, y: 0 };
  const warnings = [];

  const makeOp = (it, kind, hole) => {
    const ring = kind === 'HOLE' ? hole.ring : it.outer;
    const ownKey = kind === 'HOLE' ? `${it.id}|H|${hole.id}` : `${it.id}|O`;
    return {
      kind, item: it, holeId: hole ? hole.id : undefined, ring, ownKey,
      perimeter: ringPerimeter(ring), cands: candidatesForRing(ctx, ring, ownKey)
    };
  };

  const info = new Map();
  for (const it of ctx.items) {
    info.set(it.id, { outer: makeOp(it, 'OUTER', null), holes: new Map(it.holes.map((h) => [h.id, makeOp(it, 'HOLE', h)])) });
  }
  const childrenByHole = new Map();
  for (const it of ctx.items) {
    if (!it.nested) continue;
    const key = it.part.inHoleId;
    if (!childrenByHole.has(key)) childrenByHole.set(key, []);
    childrenByHole.get(key).push(it);
  }

  const seq = [];
  const usedPierces = [];
  // duas crateras (raio R) precisam de >= 2R + folga entre si, senão a segunda cai na poça da primeira
  const minPierceSpacing = 2 * params.pierce_radius + 1.0;
  const spacingPenalty = (c) => (usedPierces.some((u) => Math.hypot(u.x - c.pierce.x, u.y - c.pierce.y) < minPierceSpacing) ? 120 : 0);
  const rapids = [];
  const finished = []; // contornos externos já cortados (peças soltas sobre a mesa)
  let pos = home;
  let rapidLen = 0, cutLen = 0, crossings = 0, invalid = 0;
  const skipCrossCheck = ctx.items.length > 250;

  const CROSS_PENALTY = 60; // mm equivalentes: evita G00 por cima de peça já solta (risco de tombamento)
  const crossesFinished = (a, b) => {
    if (skipCrossCheck || finished.length === 0) return false;
    const sMinX = Math.min(a.x, b.x), sMaxX = Math.max(a.x, b.x);
    const sMinY = Math.min(a.y, b.y), sMaxY = Math.max(a.y, b.y);
    return finished.some((f) =>
      f.box.minX <= sMaxX && f.box.maxX >= sMinX && f.box.minY <= sMaxY && f.box.maxY >= sMinY &&
      segmentCrossesRing(a, b, f.ring));
  };
  const legCost = (a, b) => Math.hypot(b.x - a.x, b.y - a.y) + (crossesFinished(a, b) ? CROSS_PENALTY : 0);

  const opDist = (p, op) => {
    let m = Infinity;
    for (const c of op.cands) m = Math.min(m, legCost(p, c.pierce));
    return m;
  };

  const emit = (op) => {
    if (op.cands.length === 0) { warnings.push(`Sem ponto de perfuração para ${op.item.part.name}`); return; }
    let best = null, bestScore = Infinity;
    for (const c of op.cands) {
      const s = legCost(pos, c.pierce) - c.quality * 0.2 + spacingPenalty(c);
      if (s < bestScore) { bestScore = s; best = c; }
    }
    const crosses = crossesFinished(pos, best.pierce);
    const len = Math.hypot(best.pierce.x - pos.x, best.pierce.y - pos.y);
    rapids.push({ x1: pos.x, y1: pos.y, x2: best.pierce.x, y2: best.pierce.y, crossesCut: crosses });
    rapidLen += len;
    if (crosses) crossings++;
    if (best.invalid) { invalid++; warnings.push(`Lead-in sem espaço livre validado em ${op.item.part.name}${op.kind === 'HOLE' ? ' (furo)' : ''}`); }
    cutLen += op.perimeter;
    seq.push({
      seq: seq.length + 1, kind: op.kind, partId: op.item.id, partName: op.item.part.name, holeId: op.holeId,
      entry: best.entry, pierce: best.pierce, leadPath: best.leadPath, leadType: best.leadType,
      leadLen: best.leadLen, perimeter: +op.perimeter.toFixed(2), invalid: best.invalid || undefined
    });
    usedPierces.push(best.pierce);
    if (op.kind === 'OUTER') finished.push({ ring: op.ring, box: op.item.outerBox });
    pos = best.entry;
  };

  const hosts = ctx.items.filter((it) => !it.nested);
  const remaining = new Set(hosts);

  const unitsOf = (host) => host.holes.map((h) => ({
    holeOp: info.get(host.id).holes.get(h.id),
    kids: childrenByHole.get(h.id) || []
  }));
  const unitStartOp = (u) => (u.kids.length
    ? (info.get(u.kids[0].id).holes.size ? [...info.get(u.kids[0].id).holes.values()][0] : info.get(u.kids[0].id).outer)
    : u.holeOp);

  while (remaining.size > 0) {
    // 1) próxima peça mãe: a mais próxima do cabeçote
    let nextHost = null, nd = Infinity;
    for (const h of remaining) {
      const units = unitsOf(h);
      const d = units.length ? Math.min(...units.map((u) => opDist(pos, unitStartOp(u)))) : opDist(pos, info.get(h.id).outer);
      if (d < nd) { nd = d; nextHost = h; }
    }
    remaining.delete(nextHost);

    // 2) furos da mãe (cada um precedido por suas filhas In-Hole), sempre o mais próximo
    const units = unitsOf(nextHost);
    while (units.length > 0) {
      let bi = 0, bd = Infinity;
      units.forEach((u, i) => { const d = opDist(pos, unitStartOp(u)); if (d < bd) { bd = d; bi = i; } });
      const u = units.splice(bi, 1)[0];
      for (const kid of u.kids) {
        for (const kh of info.get(kid.id).holes.values()) emit(kh);
        emit(info.get(kid.id).outer);
      }
      emit(u.holeOp);
    }
    // 3) contorno externo da mãe por último
    emit(info.get(nextHost.id).outer);
  }

  // ordem de corte por peça (para rótulos e hover)
  let k = 0;
  const orderByPart = new Map();
  for (const op of seq) if (op.kind === 'OUTER') orderByPart.set(op.partId, ++k);
  for (const p of res.placedParts) p.cutSequenceOrder = orderByPart.get(p.id) || 0;

  res.cam = {
    home,
    ops: seq,
    rapids,
    warnings: [...new Set(warnings)].slice(0, 20),
    metrics: {
      pierceCount: seq.length,
      cutLength: +cutLen.toFixed(1),
      rapidLength: +rapidLen.toFixed(1),
      rapidCrossings: crossings,
      invalidLeads: invalid,
      crossCheckSkipped: skipCrossCheck
    }
  };
  return res.cam;
}

module.exports = { planCam };
