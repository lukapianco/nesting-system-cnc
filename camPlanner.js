// camPlanner.js
'use strict';

const { isPointInPolygon } = require('./geometry/primitives');

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

  const openClear = params.pierce_radius + params.kerf_width / 2 + 1.5 * params.lead_in_length + 2.0;
  const edgeOpen = Math.min(6, Math.max(3, params.sheet_margin * 0.8));
  return { items, near, res, params, openClear, edgeOpen };
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

function sheetEdgeDist(ctx, x, y) {
  const r = ctx.res;
  if (r.sheetPoly) {
    let m = ringDist(x, y, r.sheetPoly);
    for (const o of r.sheetObstacles || []) m = Math.min(m, ringDist(x, y, o.points));
    return m;
  }
  return Math.min(x, y, r.sheetWidth - x, r.sheetHeight - y);
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
        const edgeD = sheetEdgeDist(ctx, path[0].x, path[0].y);
        // TIER 0 = sucata ABERTA (longe de outras peças e da borda, fora de retalho útil); TIER 1 = alma estreita / borda / retalho
        const open = !relaxed && v.clear >= ctx.openClear && edgeD >= ctx.edgeOpen && !remnantHit;
        const quality = Math.min(v.clear, 12) + Math.min(e.len, 20) * 0.15
          + (type === params.lead_in_type ? 1 : 0) + (L === lengths[0] ? 1 : 0) - (remnantHit ? 10 : 0);
        return { entry: E, t, n, edgeIndex: e.i, frac, leadPath: path, leadType: type, leadLen: L, pierce: path[0], clear: v.clear, quality, tier: open ? 0 : 1, invalid: !!relaxed };
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
  cands.sort((x, y) => (x.tier - y.tier) || (y.quality - x.quality));
  return cands.slice(0, MAX_CANDS_PER_OP);
}

// ---------------------------------------------------------------- sequenciamento
/**
 * Sequência de corte:
 *   - regra física Inside-Out dentro de cada peça mãe (filhas -> furo -> ... -> contorno externo);
 *   - peça a peça (a peça é concluída antes de passar para a próxima);
 *   - ORDEM DAS PEÇAS otimizada (vizinho mais próximo + Or-opt iterativo sobre o percurso G00 real),
 *     com penalidade para G00 que passa por cima de peça já solta.
 */
function planCam(res, params) {
  const ctx = buildContext(res, params);
  const home = { x: 0, y: 0 };
  const warnings = [];

  const finishOp = (op) => {
    const bestTier = op.cands.length ? Math.min(...op.cands.map((c) => c.tier)) : 1;
    op.cands = op.cands.filter((c) => c.tier === bestTier);
    return op;
  };
  const makeOp = (it, kind, hole) => {
    const ring = kind === 'HOLE' ? hole.ring : it.outer;
    const ownKey = kind === 'HOLE' ? `${it.id}|H|${hole.id}` : `${it.id}|O`;
    return finishOp({
      kind, item: it, holeId: hole ? hole.id : undefined, ring, ownKey,
      perimeter: ringPerimeter(ring), cands: candidatesForRing(ctx, ring, ownKey)
    });
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
  const hosts = ctx.items.filter((it) => !it.nested);
  const skipCrossCheck = ctx.items.length > 250;
  const CROSS_PENALTY = 60;
  const minPierceSpacing = 2 * params.pierce_radius + 1.0;

  const unitsOf = (host) => host.holes.map((h) => ({
    holeOp: info.get(host.id).holes.get(h.id),
    kids: childrenByHole.get(h.id) || []
  }));
  const unitStartOp = (u) => (u.kids.length
    ? ([...info.get(u.kids[0].id).holes.values()][0] || info.get(u.kids[0].id).outer)
    : u.holeOp);

  /** Gera a sequência completa para uma ORDEM de peças mães. */
  function runSequence(order, forced = null) {
    const seq = [], rapids = [], usedPierces = [], finished = [], groups = [], opsOrder = [], chosen = [];
    let pos = home, rapidLen = 0, cutLen = 0, crossings = 0, invalid = 0, narrow = 0, closePierces = 0;
    const warn = new Set();

    const crossesFinished = (a, b) => {
      if (skipCrossCheck || finished.length === 0) return false;
      const sMinX = Math.min(a.x, b.x), sMaxX = Math.max(a.x, b.x);
      const sMinY = Math.min(a.y, b.y), sMaxY = Math.max(a.y, b.y);
      return finished.some((f) =>
        f.box.minX <= sMaxX && f.box.maxX >= sMinX && f.box.minY <= sMaxY && f.box.maxY >= sMinY &&
        segmentCrossesRing(a, b, f.ring));
    };
    const legCost = (a, b) => Math.hypot(b.x - a.x, b.y - a.y) + (crossesFinished(a, b) ? CROSS_PENALTY : 0);
    const spacingPenalty = (c) => (usedPierces.some((u) => Math.hypot(u.x - c.pierce.x, u.y - c.pierce.y) < minPierceSpacing) ? 120 : 0);
    const opDist = (p, op) => {
      let m = Infinity;
      for (const c of op.cands) m = Math.min(m, legCost(p, c.pierce));
      return m;
    };

    const emit = (op) => {
      if (op.cands.length === 0) { warn.add(`Sem ponto de perfuração para ${op.item.part.name}`); return; }
      let best = forced && forced.get(op), bestScore = Infinity;
      if (!best) for (const c of op.cands) {
        const sc = legCost(pos, c.pierce) - c.quality * 0.2 + spacingPenalty(c);
        if (sc < bestScore) { bestScore = sc; best = c; }
      }
      opsOrder.push(op);
      chosen.push(best);
      if (spacingPenalty(best) > 0) closePierces++;
      const crosses = crossesFinished(pos, best.pierce);
      rapids.push({ x1: pos.x, y1: pos.y, x2: best.pierce.x, y2: best.pierce.y, crossesCut: crosses });
      rapidLen += Math.hypot(best.pierce.x - pos.x, best.pierce.y - pos.y);
      if (crosses) crossings++;
      if (best.invalid) { invalid++; warn.add(`Lead-in sem espaço livre validado em ${op.item.part.name}${op.kind === 'HOLE' ? ' (furo)' : ''}`); }
      if (best.tier === 1) narrow++;
      cutLen += op.perimeter;
      seq.push({
        seq: seq.length + 1, kind: op.kind, partId: op.item.id, partName: op.item.part.name, holeId: op.holeId,
        entry: best.entry, pierce: best.pierce, leadPath: best.leadPath, leadType: best.leadType,
        leadLen: best.leadLen, perimeter: +op.perimeter.toFixed(2), invalid: best.invalid || undefined,
        zone: best.tier === 0 ? 'ABERTA' : 'ESTREITA'
      });
      usedPierces.push(best.pierce);
      if (op.kind === 'OUTER') finished.push({ ring: op.ring, box: op.item.outerBox });
      pos = best.entry;
    };

    for (const host of order) {
      const startIdx = seq.length;
      const units = unitsOf(host);
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
      emit(info.get(host.id).outer);
      if (seq.length > startIdx) {
        groups.push({ host, start: seq[startIdx].pierce, end: seq[seq.length - 1].entry });
      }
    }
    return { seq, rapids, rapidLen, cutLen, crossings, invalid, narrow, closePierces, warnings: warn, groups, opsOrder, chosen };
  }

  // 1) ordem inicial: várias estratégias, fica a de menor custo real (G00 + penalidade por passar sobre peça solta)
  //    a) vizinho mais próximo a partir da origem (a única até a V5.8);
  //    b) "serpentina" por colunas e por linhas, com 2 a 8 faixas: a cabeça anda numa direção e não volta sobre o que
  //       já cortou, que é como programadores de corte costumam sequenciar (menos G00 sobre peça solta).
  const nearestPierceDist = (p, host) => {
    const units = unitsOf(host);
    const ops = units.length ? units.map(unitStartOp) : [info.get(host.id).outer];
    let m = Infinity;
    for (const op of ops) for (const c of op.cands) m = Math.min(m, Math.hypot(c.pierce.x - p.x, c.pierce.y - p.y));
    return m;
  };
  const nnOrder = () => {
    const out = [], rem = new Set(hosts);
    let p = home;
    while (rem.size) {
      let nb = null, nd = Infinity;
      for (const h of rem) { const d = nearestPierceDist(p, h); if (d < nd) { nd = d; nb = h; } }
      rem.delete(nb); out.push(nb);
      const ops = unitsOf(nb).map(unitStartOp);
      const o = ops[0] || info.get(nb.id).outer;
      if (o.cands[0]) p = o.cands[0].pierce;
    }
    return out;
  };
  const center = (h) => ({ x: (h.outerBox.minX + h.outerBox.maxX) / 2, y: (h.outerBox.minY + h.outerBox.maxY) / 2 });
  const snakeOrder = (axis, bands) => {
    // axis 'x': faixas verticais (colunas) percorridas em X, dentro de cada uma sobe/desce em Y alternando
    const W = axis === 'x' ? res.sheetWidth : res.sheetHeight;
    const step = W / bands;
    const keyed = hosts.map((h) => {
      const c = center(h);
      const along = axis === 'x' ? c.x : c.y, across = axis === 'x' ? c.y : c.x;
      const band = Math.min(bands - 1, Math.max(0, Math.floor(along / step)));
      return { h, band, k: band % 2 === 0 ? across : -across };
    });
    keyed.sort((a, b) => (a.band - b.band) || (a.k - b.k));
    return keyed.map((e) => e.h);
  };
  const scoreOf = (r) => r.rapidLen + r.crossings * CROSS_PENALTY;
  const starts = [nnOrder()];
  if (hosts.length > 2 && hosts.length <= 400) {
    for (const bands of [2, 3, 4, 6, 8]) { starts.push(snakeOrder('x', bands)); starts.push(snakeOrder('y', bands)); }
  }
  let order = starts[0], result = runSequence(order);
  for (const st of starts.slice(1)) {
    const r = runSequence(st);
    if (scoreOf(r) < scoreOf(result) - 1e-6) { result = r; order = st; }
  }

  // 2) Or-opt sobre a ordem das peças, usando os pontos reais de entrada/saída de cada grupo
  const MAX_OROPT_GROUPS = 80;
  if (order.length > 2 && order.length <= MAX_OROPT_GROUPS) {
    for (let pass = 0; pass < 4; pass++) {
      const ends = new Map(result.groups.map((g) => [g.host, g]));
      const cost = (ord) => {
        let c = 0, prev = home;
        for (const h of ord) { const g = ends.get(h); if (!g) continue; c += Math.hypot(g.start.x - prev.x, g.start.y - prev.y); prev = g.end; }
        return c;
      };
      let improved = true, guard = 0;
      let cur = order.slice(), curCost = cost(cur);
      while (improved && guard++ < 50) {
        improved = false;
        for (let i = 0; i < cur.length; i++) {
          const item = cur[i];
          const rest = cur.slice(0, i).concat(cur.slice(i + 1));
          for (let j = 0; j <= rest.length; j++) {
            if (j === i) continue;
            const cand = rest.slice(0, j).concat([item], rest.slice(j));
            const cc = cost(cand);
            if (cc < curCost - 1e-6) { cur = cand; curCost = cc; improved = true; break; }
          }
          if (improved) break;
        }
      }
      const next = runSequence(cur);
      if (scoreOf(next) < scoreOf(result) - 1e-6) {
        result = next; order = cur;
      } else break;
    }
  }

  // 3) ponto de entrada de cada contorno escolhido olhando a ida E a volta (V5.8, passo 3 do plano): o corte de um
  //    contorno termina onde começou, então a entrada boa é a que deixa a cabeça perto do próximo contorno e sem
  //    passar sobre a peça que acabou de soltar. Programação dinâmica sobre a ordem já decidida (ótima para ela).
  if (result.opsOrder.length > 1 && result.opsOrder.length <= 600) {
    const ops = result.opsOrder.filter((op) => op.cands.length);
    const fin = []; // contornos externos já cortados antes de cada passo
    const finRings = [];
    for (const op of ops) { fin.push(finRings.length); if (op.kind === 'OUTER') finRings.push({ ring: op.ring, box: op.item.outerBox }); }
    const crosses = (a, b, upto) => {
      if (skipCrossCheck) return false;
      const sMinX = Math.min(a.x, b.x), sMaxX = Math.max(a.x, b.x), sMinY = Math.min(a.y, b.y), sMaxY = Math.max(a.y, b.y);
      for (let f = 0; f < upto; f++) {
        const F = finRings[f];
        if (F.box.minX <= sMaxX && F.box.maxX >= sMinX && F.box.minY <= sMaxY && F.box.maxY >= sMinY && segmentCrossesRing(a, b, F.ring)) return true;
      }
      return false;
    };
    const leg = (a, c, i) => Math.hypot(c.pierce.x - a.x, c.pierce.y - a.y) + (crosses(a, c.pierce, fin[i]) ? CROSS_PENALTY : 0) - c.quality * 0.2;
    const D = ops.map((op) => op.cands.map(() => Infinity)), B = ops.map((op) => op.cands.map(() => -1));
    ops[0].cands.forEach((c, j) => { D[0][j] = leg(home, c, 0); });
    for (let i = 1; i < ops.length; i++) {
      ops[i].cands.forEach((c, j) => {
        ops[i - 1].cands.forEach((pc, k) => {
          const v = D[i - 1][k] + leg(pc.entry, c, i);
          if (v < D[i][j]) { D[i][j] = v; B[i][j] = k; }
        });
      });
    }
    let j = D[ops.length - 1].indexOf(Math.min(...D[ops.length - 1]));
    const forced = new Map();
    for (let i = ops.length - 1; i >= 0; i--) { forced.set(ops[i], ops[i].cands[j]); j = B[i][j]; }
    const refined = runSequence(order, forced);
    // perfurações muito próximas (calor acumulado) não podem aumentar
    if (scoreOf(refined) < scoreOf(result) - 1e-6 && refined.closePierces <= result.closePierces && refined.invalid <= result.invalid) result = refined;
  }

  // 4) acabamento do corte (V5.10, passo 4 do plano; NÃO testado em máquina): sobrepasse, saída e microjuntas
  const finishing = applyFinishing(ctx, result, params, home, skipCrossCheck);
  for (const w of finishing.warnings) warnings.push(w);
  const { seq, rapids } = result;
  for (const w of result.warnings) warnings.push(w);

  let k = 0;
  const orderByPart = new Map();
  for (const op of seq) if (op.kind === 'OUTER') orderByPart.set(op.partId, ++k);
  for (const p of res.placedParts) p.cutSequenceOrder = orderByPart.get(p.id) || 0;

  const leadLen = seq.reduce((acc, op) => {
    let l = 0;
    const p = op.leadPath || [];
    for (let i = 1; i < p.length; i++) l += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    return acc + l;
  }, 0);
  res.cam = {
    home,
    ops: seq,
    rapids,
    warnings: [...new Set(warnings)].slice(0, 20),
    finishing: finishing.settings,
    timeEstimate: estimateMachineTime({ cutLength: result.cutLen - finishing.tabLen + finishing.overburnLen, leadLength: leadLen + finishing.leadOutLen, rapidLength: result.rapidLen, pierceCount: seq.length }, params),
    metrics: {
      leadLength: +leadLen.toFixed(1),
      leadOutLength: +finishing.leadOutLen.toFixed(1),
      overburnLength: +finishing.overburnLen.toFixed(1),
      tabCount: finishing.tabCount,
      tabLength: +finishing.tabLen.toFixed(1),
      leadOutsWithoutSpace: finishing.noSpace,
      pierceCount: seq.length,
      cutLength: +result.cutLen.toFixed(1),
      rapidLength: +result.rapidLen.toFixed(1),
      rapidCrossings: result.crossings,
      invalidLeads: result.invalid,
      narrowWebPierces: result.narrow,
      crossCheckSkipped: skipCrossCheck
    }
  };
  return res.cam;
}

// ---------------------------------------------------------------- acabamento do corte (V5.10)
/** Ponto e tangente a uma distância `s` (ao longo do anel, no sentido do corte) a partir da aresta i, fração f. */
function walkRing(ring, i, f, s) {
  const n = ring.length;
  let a = ring[i], b = ring[(i + 1) % n];
  let len = Math.hypot(b.x - a.x, b.y - a.y);
  let pos = f * len, k = i, guard = 0;
  const pts = [{ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }];
  let left = s;
  while (left > 1e-9 && guard++ < 4 * n) {
    const rest = len - pos;
    if (rest >= left) {
      pos += left; left = 0;
      pts.push({ x: a.x + (b.x - a.x) * (pos / len), y: a.y + (b.y - a.y) * (pos / len) });
      break;
    }
    left -= rest;
    pts.push({ x: b.x, y: b.y });
    k = (k + 1) % n; a = ring[k]; b = ring[(k + 1) % n];
    len = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9; pos = 0;
  }
  const t = { x: (b.x - a.x) / (len || 1), y: (b.y - a.y) / (len || 1) };
  return { pts, end: pts[pts.length - 1], t, n: { x: t.y, y: -t.x }, edge: k };
}

/** Distância ao longo do anel do início do anel até (aresta i, fração f). */
function arcPos(ring, i, f) {
  let s = 0;
  for (let k = 0; k < i; k++) s += Math.hypot(ring[k + 1].x - ring[k].x, ring[k + 1].y - ring[k].y);
  const a = ring[i], b = ring[(i + 1) % ring.length];
  return s + f * Math.hypot(b.x - a.x, b.y - a.y);
}

/** Converte posição ao longo do anel em (aresta, fração). */
function locate(ring, s, P) {
  let x = ((s % P) + P) % P;
  for (let k = 0, n = ring.length; k < n; k++) {
    const a = ring[k], b = ring[(k + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (x <= len || k === n - 1) return { i: k, f: len > 0 ? Math.min(1, x / len) : 0, len };
    x -= len;
  }
  return { i: 0, f: 0, len: 0 };
}

/**
 * Sobrepasse (overburn): o corte passa do ponto de entrada por `overburn_length` mm, ao longo do contorno, para
 * fechar sem marca. Saída (lead-out): sai do contorno para a sucata, em arco ou reta, com `lead_out_length` mm; se
 * não houver espaço livre, tenta a metade e, por fim, sai sem saída (aviso). Microjuntas (tabs): trechos de
 * `tab_width` mm NÃO cortados no contorno externo, `tabs_per_part` por peça, distribuídos ao longo do perímetro
 * longe da entrada e de preferência em arestas retas; só em peças até `tab_max_part_size` mm (0 = todas).
 * Furos não recebem microjunta (o miolo tem que cair). Nada disso foi testado em máquina.
 */
function applyFinishing(ctx, result, params, home, skipCrossCheck) {
  const out = { warnings: [], leadOutLen: 0, overburnLen: 0, tabLen: 0, tabCount: 0, noSpace: 0,
    settings: { lead_out_length: params.lead_out_length, overburn_length: params.overburn_length, tab_width: params.tab_width,
      tabs_per_part: params.tabs_per_part, tab_max_part_size: params.tab_max_part_size, testedOnMachine: false } };
  const wantOut = params.lead_out_length > 0.01, wantOb = params.overburn_length > 0.01, wantTabs = params.tab_width > 0.01 && params.tabs_per_part > 0;
  if (!wantOut && !wantOb && !wantTabs) return out;
  const { seq, opsOrder, chosen } = result;
  for (let i = 0; i < seq.length; i++) {
    const op = opsOrder[i], c = chosen[i], s = seq[i];
    if (!c || c.edgeIndex == null) continue;
    const ring = op.ring, P = op.perimeter;
    // sobrepasse ao longo do contorno, no sentido do corte
    let exitPt = c.entry, exitT = c.t, exitN = c.n, overPath = null;
    if (wantOb) {
      const w = walkRing(ring, c.edgeIndex, c.frac, Math.min(params.overburn_length, P * 0.25));
      overPath = w.pts; exitPt = w.end; exitT = w.t; exitN = w.n;
      out.overburnLen += Math.min(params.overburn_length, P * 0.25);
      s.overburnPath = overPath;
    }
    // saída para a sucata (o caminho é validado como uma entrada ao contrário)
    if (wantOut) {
      let done = false;
      for (const L of [params.lead_out_length, params.lead_out_length * 0.5]) {
        const back = makeLead(params.lead_in_type, exitPt, { x: -exitT.x, y: -exitT.y }, exitN, L);
        const v = validateLead(ctx, back, exitPt, op.ownKey, ring);
        if (!v.ok) continue;
        const path = back.slice().reverse();
        s.leadOutPath = path;
        for (let k = 1; k < path.length; k++) out.leadOutLen += Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y);
        done = true;
        break;
      }
      if (!done) { out.noSpace++; out.warnings.push(`Saída de corte sem espaço livre em ${op.item.part.name}${op.kind === 'HOLE' ? ' (furo)' : ''}: sai sem saída`); }
    }
    // microjuntas no contorno externo de peças pequenas o bastante
    if (wantTabs && op.kind === 'OUTER') {
      const part = op.item.part;
      const big = Math.max(part.placedWidth || 0, part.placedHeight || 0);
      if (params.tab_max_part_size > 0 && big > params.tab_max_part_size) continue;
      const k = Math.min(params.tabs_per_part, Math.floor(P / (4 * params.tab_width)));
      if (k < 1) continue;
      const sE = arcPos(ring, c.edgeIndex, c.frac);
      const tw = params.tab_width, tabs = [];
      for (let j = 0; j < k; j++) {
        let target = sE + (P * (j + 1)) / (k + 1);
        // prefere aresta reta com folga para a junta: procura a aresta longa mais próxima (até 1/(2k) do perímetro)
        let loc = locate(ring, target, P);
        if (loc.len < 2 * tw) {
          let best = null;
          for (let d = 1; d <= ring.length; d++) {
            for (const sign of [1, -1]) {
              const idx = ((loc.i + sign * d) % ring.length + ring.length) % ring.length;
              const a = ring[idx], b = ring[(idx + 1) % ring.length];
              if (Math.hypot(b.x - a.x, b.y - a.y) >= 2 * tw) { best = idx; break; }
            }
            if (best != null) break;
          }
          if (best != null) {
            const center = arcPos(ring, best, 0.5);
            const dist = Math.min(Math.abs(center - target), P - Math.abs(center - target));
            if (dist <= P / (2 * k)) { target = center; loc = locate(ring, target, P); }
          }
        }
        const w = walkRing(ring, loc.i, loc.f, 0);
        const a = walkRing(ring, locate(ring, target - tw / 2, P).i, locate(ring, target - tw / 2, P).f, tw);
        tabs.push({ start: a.pts[0], end: a.end, path: a.pts, center: w.end });
      }
      if (tabs.length) {
        s.tabs = tabs; out.tabCount += tabs.length; out.tabLen += tabs.length * tw;
      }
    }
  }
  // os deslocamentos agora saem do fim da saída (ou do sobrepasse), não do ponto de entrada
  let pos = home, rapidLen = 0, crossings = 0;
  const rapids = [], finished = [];
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i];
    const crosses = !skipCrossCheck && finished.some((f) => segmentCrossesRing(pos, s.pierce, f));
    rapids.push({ x1: pos.x, y1: pos.y, x2: s.pierce.x, y2: s.pierce.y, crossesCut: crosses });
    rapidLen += Math.hypot(s.pierce.x - pos.x, s.pierce.y - pos.y);
    if (crosses) crossings++;
    if (s.kind === 'OUTER') finished.push(opsOrder[i].ring);
    pos = s.leadOutPath ? s.leadOutPath[s.leadOutPath.length - 1] : (s.overburnPath ? s.overburnPath[s.overburnPath.length - 1] : s.entry);
  }
  result.rapids = rapids; result.rapidLen = rapidLen; result.crossings = crossings;
  return out;
}

/**
 * Tempo de máquina ESTIMADO (V5.8): corte (contornos + entradas) na velocidade de corte, perfurações pelo tempo de
 * perfuração e deslocamentos em vazio na velocidade de G00. Os valores padrão (3.000 mm/min, 1 s, 20.000 mm/min)
 * são só ponto de partida, NÃO dados de fabricante: trocar pelos da tabela de corte da máquina. Não conta acelerações,
 * cantos nem troca de chapa.
 */
function estimateMachineTime(m, params) {
  const vc = Math.max(1, params.cut_speed_mm_min), vr = Math.max(1, params.rapid_speed_mm_min), tp = Math.max(0, params.pierce_time_s);
  const cutS = ((m.cutLength + m.leadLength) / vc) * 60;
  const pierceS = m.pierceCount * tp;
  const rapidS = (m.rapidLength / vr) * 60;
  return { cutS: +cutS.toFixed(1), pierceS: +pierceS.toFixed(1), rapidS: +rapidS.toFixed(1), totalS: +(cutS + pierceS + rapidS).toFixed(1),
    basis: { cut_speed_mm_min: vc, rapid_speed_mm_min: vr, pierce_time_s: tp }, estimate: true };
}

module.exports = { planCam, estimateMachineTime };
