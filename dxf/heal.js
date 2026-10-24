// dxf/heal.js — "CAD healing": de caminhos discretizados a anéis fechados.
//
// 1. Caminhos fechados (ou com pontas coincidentes) viram anéis direto.
// 2. Caminhos abertos são costurados por um GRAFO de extremidades (tolerância de junção), não segmento a
//    segmento. Em nós ambíguos (3+ pontas: peças que se tocam num vértice), prefere continuar na mesma
//    instância de bloco/entidade e, depois, na menor mudança de direção.
// 3. Duplicatas exatas (linhas/arcos repetidos, peças coladas duas vezes) são removidas.
// 4. Gaps maiores que a junção e até `maxGapHeal` são fechados entre pontas mutuamente mais próximas, e
//    cada fechamento é relatado com posição e tamanho.
// 5. Anéis degenerados (área ~0) são descartados; auto-interseções são detectadas e relatadas.
'use strict';

const { computeSignedArea, segmentsIntersectExact } = require('../geometry/primitives');
const { RTree2D } = require('../spatialIndex');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function polyLength(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Remove pontos repetidos e vértices exatamente colineares (desvio < epsDev mm). Não toca em arcos finos. */
function cleanRing(pts, epsDup = 1e-6, epsDev = 1e-6) {
  const a = [];
  for (const p of pts) if (!a.length || dist(a[a.length - 1], p) > epsDup) a.push(p);
  while (a.length > 1 && dist(a[0], a[a.length - 1]) <= epsDup) a.pop();
  if (a.length < 4) return a;
  let changed = true;
  let ring = a;
  while (changed && ring.length > 3) {
    changed = false;
    const out = [];
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p = ring[(i - 1 + n) % n], q = ring[i], r = ring[(i + 1) % n];
      const dx = r.x - p.x, dy = r.y - p.y;
      const L = Math.hypot(dx, dy);
      const dev = L > 1e-12 ? Math.abs(dx * (q.y - p.y) - dy * (q.x - p.x)) / L : dist(p, q);
      // colinear E entre os vizinhos (não remove "espinhos" de ida e volta)
      const between = ((q.x - p.x) * dx + (q.y - p.y) * dy) >= 0 && ((r.x - q.x) * dx + (r.y - q.y) * dy) >= 0;
      if (dev < epsDev && between && out.length + (n - i) > 3) { changed = true; continue; }
      out.push(q);
    }
    ring = out;
  }
  return ring;
}

/** Interseções próprias entre arestas não adjacentes do anel (R-tree). Devolve até `limit` pontos. */
function findSelfIntersections(ring, limit = 5) {
  const n = ring.length;
  if (n < 4) return [];
  const tree = new RTree2D(16);
  const entries = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    entries.push({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y), data: i });
  }
  tree.loadBulk(entries);
  const hits = [];
  for (let i = 0; i < n && hits.length < limit; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const cand = tree.search({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) });
    for (const j of cand) {
      if (j <= i) continue;
      if (j === (i + 1) % n || i === (j + 1) % n) continue;
      const c = ring[j], d = ring[(j + 1) % n];
      if (segmentsIntersectExact(a, b, c, d)) {
        hits.push({ x: (a.x + b.x + c.x + d.x) / 4, y: (a.y + b.y + c.y + d.y) / 4 });
        if (hits.length >= limit) break;
      }
    }
  }
  return hits;
}

/** Índice de pontos por grade (para agrupar extremidades dentro da tolerância). */
class PointGrid {
  constructor(cell) { this.cell = Math.max(cell, 1e-9); this.map = new Map(); }
  key(ix, iy) { return ix + ',' + iy; }
  near(p, tol) {
    const ix = Math.floor(p.x / this.cell), iy = Math.floor(p.y / this.cell);
    let best = null, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const arr = this.map.get(this.key(ix + dx, iy + dy));
      if (!arr) continue;
      for (const it of arr) { const d = dist(p, it.p); if (d <= tol && d < bestD) { bestD = d; best = it; } }
    }
    return best;
  }
  add(p, data) {
    const k = this.key(Math.floor(p.x / this.cell), Math.floor(p.y / this.cell));
    if (!this.map.has(k)) this.map.set(k, []);
    const it = { p, data };
    this.map.get(k).push(it);
    return it;
  }
}

function dirAt(pts, atEnd) {
  // direção de saída do caminho na ponta (usa um trecho de comprimento razoável para evitar ruído)
  if (atEnd) {
    const b = pts[pts.length - 1];
    for (let i = pts.length - 2; i >= 0; i--) if (dist(pts[i], b) > 1e-6) return { x: b.x - pts[i].x, y: b.y - pts[i].y };
  } else {
    const a = pts[0];
    for (let i = 1; i < pts.length; i++) if (dist(pts[i], a) > 1e-6) return { x: pts[i].x - a.x, y: pts[i].y - a.y };
  }
  return { x: 1, y: 0 };
}
function turnAngle(din, dout) {
  const a = Math.atan2(din.y, din.x), b = Math.atan2(dout.y, dout.x);
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/** Duas polilinhas abertas são a mesma curva (em qualquer sentido)? */
function sameOpenCurve(A, B, tol) {
  const la = polyLength(A), lb = polyLength(B);
  if (Math.abs(la - lb) > tol + 1e-3 * Math.max(la, lb)) return false;
  const sample = (P, f) => {
    const target = polyLength(P) * f;
    let s = 0;
    for (let i = 1; i < P.length; i++) {
      const d = dist(P[i - 1], P[i]);
      if (s + d >= target) { const t = d > 0 ? (target - s) / d : 0; return { x: P[i - 1].x + (P[i].x - P[i - 1].x) * t, y: P[i - 1].y + (P[i].y - P[i - 1].y) * t }; }
      s += d;
    }
    return P[P.length - 1];
  };
  const fwd = dist(A[0], B[0]) <= tol && dist(A[A.length - 1], B[B.length - 1]) <= tol;
  const rev = dist(A[0], B[B.length - 1]) <= tol && dist(A[A.length - 1], B[0]) <= tol;
  if (!fwd && !rev) return false;
  for (const f of [0.25, 0.5, 0.75]) {
    const pa = sample(A, f), pb = sample(B, rev && !fwd ? 1 - f : f);
    if (dist(pa, pb) > tol * 2 + 1e-6) return false;
  }
  return true;
}

function ringSignature(r) {
  const area = Math.abs(computeSignedArea(r));
  const bb = bboxOf(r);
  return { area, bb };
}
function sameRing(A, sA, B, sB, tol) {
  if (Math.abs(sA.area - sB.area) > tol * 10 + 1e-4 * Math.max(sA.area, sB.area)) return false;
  if (Math.abs(sA.bb.minX - sB.bb.minX) > tol || Math.abs(sA.bb.minY - sB.bb.minY) > tol ||
      Math.abs(sA.bb.maxX - sB.bb.maxX) > tol || Math.abs(sA.bb.maxY - sB.bb.maxY) > tol) return false;
  // todo vértice de A (amostra) perto do contorno de B
  const step = Math.max(1, Math.floor(A.length / 24));
  for (let i = 0; i < A.length; i += step) {
    let best = Infinity;
    for (let j = 0, k = B.length - 1; j < B.length; k = j++) {
      const a = B[k], b = B[j];
      const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((A[i].x - a.x) * dx + (A[i].y - a.y) * dy) / L2)) : 0;
      const d = Math.hypot(A[i].x - (a.x + t * dx), A[i].y - (a.y + t * dy));
      if (d < best) best = d;
      if (best <= tol) break;
    }
    if (best > tol * 2) return false;
  }
  return true;
}

/**
 * @param {Array<{pts:Array<{x,y}>, closed:boolean, meta:Object}>} items  caminhos discretizados
 * @param {{joinTol?:number, maxGapHeal?:number, chordTol?:number}} opt
 */
function healPaths(items, opt = {}) {
  const joinTol = opt.joinTol ?? 0.25;
  const maxGapHeal = Math.max(opt.maxGapHeal ?? 1.0, 0);
  const dupTol = Math.max(0.01, (opt.chordTol ?? 0.03) * 2);
  const stats = { duplicatesRemoved: 0, zeroAreaDropped: 0, ambiguousNodes: 0, gapsHealed: [], selfClosed: 0, inputPaths: items.length };

  const rings = [];       // { pts, sources:[meta], healed:[] }
  const open = [];        // { pts, metas:[meta] }

  // ---- 1. separa fechados / abertos
  for (const it of items) {
    if (!it.pts || it.pts.length < 2) continue;
    const pts = it.pts;
    if (it.closed || (pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) <= joinTol)) {
      rings.push({ pts: pts.slice(), sources: [it.meta], healed: [] });
    } else {
      open.push({ pts, metas: [it.meta] });
    }
  }

  // ---- 2. remove abertos duplicados
  const grid = new PointGrid(joinTol * 2);
  const nodeOf = (p) => {
    const hit = grid.near(p, joinTol);
    if (hit) return hit.data;
    const node = { id: nodeList.length, p };
    nodeList.push(node);
    grid.add(p, node);
    return node;
  };
  const nodeList = [];
  const edges = open.map((o, idx) => ({ idx, o, a: null, b: null, used: false, dead: false }));
  for (const e of edges) { e.a = nodeOf(e.o.pts[0]); e.b = nodeOf(e.o.pts[e.o.pts.length - 1]); }

  const byPair = new Map();
  for (const e of edges) {
    const k = Math.min(e.a.id, e.b.id) + '_' + Math.max(e.a.id, e.b.id);
    if (!byPair.has(k)) byPair.set(k, []);
    const bucket = byPair.get(k);
    if (bucket.some(f => sameOpenCurve(f.o.pts, e.o.pts, dupTol))) { e.dead = true; stats.duplicatesRemoved++; continue; }
    bucket.push(e);
  }

  // ---- 3. grafo e caminhada
  const adj = new Map();
  for (const e of edges) {
    if (e.dead) continue;
    if (!adj.has(e.a.id)) adj.set(e.a.id, []);
    if (!adj.has(e.b.id)) adj.set(e.b.id, []);
    adj.get(e.a.id).push({ e, atA: true });
    adj.get(e.b.id).push({ e, atA: false });
  }
  for (const [, list] of adj) if (list.length > 2) stats.ambiguousNodes++;

  const instanceOf = (m) => (m && m.instance) || '';
  /** Escolhe a próxima aresta num nó: mesma instância de bloco primeiro, depois a menor mudança de direção. */
  const choose = (list, inst, din) => {
    if (list.length === 1) return list[0];
    let pick = list[0], best = Infinity;
    for (const c of list) {
      const cp = c.atA ? c.e.o.pts : c.e.o.pts.slice().reverse();
      const score = (instanceOf(c.e.o.metas[0]) === inst ? 0 : 10) + turnAngle(din, dirAt(cp, false));
      if (score < best) { best = score; pick = c; }
    }
    return pick;
  };
  const chains = [];
  for (const start of edges) {
    if (start.dead || start.used) continue;
    start.used = true;
    let pts = start.o.pts.slice();
    let metas = [...start.o.metas];
    let head = start.a, tail = start.b;
    let closed = head === tail;
    // estende pela cauda
    while (!closed) {
      const list = (adj.get(tail.id) || []).filter(x => !x.e.used);
      if (!list.length) break;
      const pick = choose(list, instanceOf(metas[metas.length - 1]), dirAt(pts, true));
      pick.e.used = true;
      const seg = pick.atA ? pick.e.o.pts : pick.e.o.pts.slice().reverse();
      pts = pts.concat(seg.slice(1));
      metas = metas.concat(pick.e.o.metas);
      tail = pick.atA ? pick.e.b : pick.e.a;
      if (tail === head) closed = true;
    }
    // estende pela cabeça (caminho começou no meio de uma cadeia aberta)
    while (!closed) {
      const list = (adj.get(head.id) || []).filter(x => !x.e.used);
      if (!list.length) break;
      const d0 = dirAt(pts, false);
      const pick = choose(list, instanceOf(metas[0]), { x: -d0.x, y: -d0.y });
      pick.e.used = true;
      const segOut = pick.atA ? pick.e.o.pts : pick.e.o.pts.slice().reverse(); // sai da cabeça
      pts = segOut.slice().reverse().slice(0, -1).concat(pts);
      metas = pick.e.o.metas.concat(metas);
      head = pick.atA ? pick.e.b : pick.e.a;
      if (head === tail) closed = true;
    }
    if (closed) {
      if (pts.length > 1 && dist(pts[0], pts[pts.length - 1]) <= joinTol) pts.pop();
      rings.push({ pts, sources: metas, healed: [] });
    } else {
      chains.push({ pts, metas });
    }
  }

  // ---- 4. fechamento de gaps entre pontas soltas (mutuamente mais próximas, <= maxGapHeal)
  const stillOpen = [];
  if (maxGapHeal > joinTol && chains.length) {
    const ends = [];
    chains.forEach((c, ci) => {
      ends.push({ ci, atEnd: false, p: c.pts[0] });
      ends.push({ ci, atEnd: true, p: c.pts[c.pts.length - 1] });
    });
    const nearest = ends.map((e, i) => {
      let best = -1, bd = Infinity;
      for (let j = 0; j < ends.length; j++) {
        if (j === i) continue;
        const f = ends[j];
        if (f.ci === e.ci && polyLength(chains[e.ci].pts) < maxGapHeal * 4) continue; // não fecha fiapos sobre si
        const d = dist(e.p, f.p);
        if (d < bd) { bd = d; best = j; }
      }
      return { j: best, d: bd };
    });
    const link = new Array(ends.length).fill(-1);
    for (let i = 0; i < ends.length; i++) {
      const { j, d } = nearest[i];
      if (j >= 0 && d <= maxGapHeal && nearest[j].j === i) link[i] = j;
    }
    const usedChain = new Array(chains.length).fill(false);
    for (let ci = 0; ci < chains.length; ci++) {
      if (usedChain[ci]) continue;
      // anda para frente seguindo links a partir da ponta final; começa do início "livre" se houver
      let startCi = ci, startAtEnd = false;
      // procura início sem link (cadeia aberta) para não começar no meio
      {
        let cur = ci, fromEnd = false, guard = 0;
        for (;;) {
          const endIdx = cur * 2 + (fromEnd ? 1 : 0);
          const l = link[endIdx];
          if (l < 0 || guard++ > chains.length) break;
          const nxt = ends[l];
          cur = nxt.ci; fromEnd = !nxt.atEnd;
          if (cur === ci) break;
        }
        startCi = cur; startAtEnd = fromEnd;
      }
      let pts = [], metas = [], healed = [];
      let cur = startCi, enterAtEnd = startAtEnd, closedLoop = false;
      for (let guard = 0; guard <= chains.length; guard++) {
        usedChain[cur] = true;
        const c = chains[cur];
        const seg = enterAtEnd ? c.pts.slice().reverse() : c.pts;
        if (pts.length) {
          const gap = dist(pts[pts.length - 1], seg[0]);
          healed.push({ x: +((pts[pts.length - 1].x + seg[0].x) / 2).toFixed(3), y: +((pts[pts.length - 1].y + seg[0].y) / 2).toFixed(3), gap: +gap.toFixed(4) });
        }
        pts = pts.concat(seg);
        metas = metas.concat(c.metas);
        const exitIdx = cur * 2 + (enterAtEnd ? 0 : 1);
        const l = link[exitIdx];
        if (l < 0) break;
        const nxt = ends[l];
        if (nxt.ci === startCi && (nxt.atEnd === startAtEnd)) {
          const gap = dist(pts[pts.length - 1], pts[0]);
          healed.push({ x: +((pts[pts.length - 1].x + pts[0].x) / 2).toFixed(3), y: +((pts[pts.length - 1].y + pts[0].y) / 2).toFixed(3), gap: +gap.toFixed(4) });
          closedLoop = true;
          break;
        }
        if (usedChain[nxt.ci]) break;
        cur = nxt.ci; enterAtEnd = nxt.atEnd;
      }
      if (closedLoop) {
        stats.gapsHealed.push(...healed);
        rings.push({ pts, sources: metas, healed });
      } else {
        stillOpen.push({ pts, metas });
      }
    }
  } else {
    for (const c of chains) stillOpen.push({ pts: c.pts, metas: c.metas });
  }

  // ---- 5. limpeza dos anéis, duplicatas e degenerados
  const outRings = [];
  const sigs = [];
  for (const r of rings) {
    const pts = cleanRing(r.pts);
    if (pts.length < 3 || Math.abs(computeSignedArea(pts)) < 1e-6) {
      // "oito" simétrico tem área líquida zero: é auto-interseção, não ruído
      const hits = pts.length >= 4 ? findSelfIntersections(pts, 1) : [];
      if (hits.length) (stats.selfIntersectingDropped = stats.selfIntersectingDropped || []).push(hits[0]);
      else stats.zeroAreaDropped++;
      continue;
    }
    const sig = ringSignature(pts);
    let dup = false;
    for (let k = 0; k < outRings.length; k++) {
      if (sameRing(pts, sig, outRings[k].pts, sigs[k], dupTol)) { dup = true; break; }
    }
    if (dup) { stats.duplicatesRemoved++; continue; }
    sigs.push(sig);
    outRings.push({ pts, sources: r.sources, healed: r.healed });
  }

  const openChains = stillOpen.map(c => ({ pts: c.pts, metas: c.metas, length: polyLength(c.pts), bbox: bboxOf(c.pts) }));
  return { rings: outRings, openChains, stats };
}

module.exports = { healPaths, cleanRing, findSelfIntersections, polyLength, bboxOf };
