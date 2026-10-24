// engine/collision.js — colisão true-shape exata entre duas peças posicionadas (folga mínima entre contornos).
// Extraído do nestingWorker.js (modularização, passo 0.1): função pura, testável isoladamente.
'use strict';

const { RTree2D } = require('../spatialIndex');
const { orient2dRobust, pointToSegmentDistSq } = require('../geometry/primitives');

// Índice de arestas por anel (R-tree), criado sob demanda e reaproveitado: os pontos rotacionados vêm do
// cache de geometria e são compartilhados por todas as cópias/candidatos com o mesmo ângulo.
const EDGE_INDEX = new WeakMap();
const EDGE_INDEX_MIN_VERTS = 24; // abaixo disso a força bruta é mais barata que a árvore

function edgeIndexOf(pts) {
  let idx = EDGE_INDEX.get(pts);
  if (idx) return idx;
  const entries = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    entries[i] = { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y), data: i };
  }
  const tree = new RTree2D(16);
  tree.loadBulk(entries);
  idx = { tree };
  EDGE_INDEX.set(pts, idx);
  return idx;
}

/** Ponto (em coordenadas do mundo) dentro do anel posicionado em (ox, oy)? */
function pointInPlacedRing(px, py, ring, ox, oy) {
  let inside = false;
  const x = px - ox, y = py - oy;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) inside = !inside;
  }
  return inside;
}

/**
 * Detecção de colisão True-Shape EXATA entre duas peças (folga mínima requiredNominalGap entre contornos).
 *
 * Mesmo resultado da versão por força bruta, em O(n log n) em vez de O(n·m):
 *  1. Fronteiras: há colisão se alguma aresta de A cruza uma de B ou se a distância entre elas é menor que a
 *     folga. A distância mínima entre dois segmentos que não se cruzam ocorre numa extremidade, então os
 *     testes ponto-segmento nos dois sentidos são completos. Só pares cujas caixas (expandidas pela folga) se
 *     tocam podem falhar — esses pares vêm da R-tree de arestas.
 *  2. Contenção: se as fronteiras não se cruzam nem se aproximam, um anel está inteiro dentro do outro ou
 *     inteiro fora; então basta testar UM vértice de cada anel (antes: todos os vértices e pontos médios).
 */
function polygonsCollideTrueShape(pA, pB, requiredNominalGap) {
  if (
    pA.x + pA.placedWidth + requiredNominalGap <= pB.x + 0.01 ||
    pB.x + pB.placedWidth + requiredNominalGap <= pA.x + 0.01 ||
    pA.y + pA.placedHeight + requiredNominalGap <= pB.y + 0.01 ||
    pB.y + pB.placedHeight + requiredNominalGap <= pA.y + 0.01
  ) {
    return false;
  }

  const isRectA = pA.points.length === 4 && Math.abs(pA.area - pA.bboxArea) < 2 && (pA.angle || 0) % 90 === 0;
  const isRectB = pB.points.length === 4 && Math.abs(pB.area - pB.bboxArea) < 2 && (pB.angle || 0) % 90 === 0;
  if (isRectA && isRectB) return true;

  const A = pA.placedPoints, B = pB.placedPoints;
  const ax = pA.x, ay = pA.y, bx = pB.x, by = pB.y;

  // 2. contenção (um vértice de cada lado; exato quando combinado com o teste de fronteiras abaixo).
  //    Ponto fora da caixa do outro anel não pode estar dentro dele.
  const pax = ax + A[0].x, pay = ay + A[0].y, pbx = bx + B[0].x, pby = by + B[0].y;
  if (pax >= bx && pax <= bx + pB.placedWidth && pay >= by && pay <= by + pB.placedHeight &&
      pointInPlacedRing(pax, pay, B, bx, by)) return true;
  if (pbx >= ax && pbx <= ax + pA.placedWidth && pby >= ay && pby <= ay + pA.placedHeight &&
      pointInPlacedRing(pbx, pby, A, ax, ay)) return true;

  // 1. fronteiras
  const minGap = Math.max(0.01, requiredNominalGap - 0.01);
  const minGapSq = minGap * minGap;

  if (A.length < EDGE_INDEX_MIN_VERTS && B.length < EDGE_INDEX_MIN_VERTS) {
    // força bruta (todos os pares cobrem todas as extremidades: 3 testes por par bastam)
    for (let i = 0; i < A.length; i++) {
      const a2 = A[(i + 1) % A.length];
      const a1x = ax + A[i].x, a1y = ay + A[i].y, a2x = ax + a2.x, a2y = ay + a2.y;
      for (let j = 0; j < B.length; j++) {
        const b2 = B[(j + 1) % B.length];
        const b1x = bx + B[j].x, b1y = by + B[j].y, b2x = bx + b2.x, b2y = by + b2.y;
        if (segmentsCross(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y)) return true;
        if (pointToSegmentDistSq(a1x, a1y, b1x, b1y, b2x, b2y) < minGapSq) return true;
        if (pointToSegmentDistSq(b1x, b1y, a1x, a1y, a2x, a2y) < minGapSq) return true;
      }
    }
    return false;
  }

  // Só arestas de A dentro da caixa de B (expandida pela folga) podem colidir, e vice-versa:
  // pega essas arestas na R-tree de A e, para cada uma, as vizinhas na R-tree de B.
  const treeA = edgeIndexOf(A).tree, treeB = edgeIndexOf(B).tree;
  const qa = {
    minX: bx - minGap - ax, minY: by - minGap - ay,
    maxX: bx + pB.placedWidth + minGap - ax, maxY: by + pB.placedHeight + minGap - ay
  };
  const edgesA = treeA.search(qa);
  const q = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const nA = A.length, nB = B.length;
  for (let t = 0; t < edgesA.length; t++) {
    const i = edgesA[t];
    const a1 = A[i], a2 = A[(i + 1) % nA];
    const a1x = ax + a1.x, a1y = ay + a1.y, a2x = ax + a2.x, a2y = ay + a2.y;
    q.minX = Math.min(a1x, a2x) - minGap - bx; q.maxX = Math.max(a1x, a2x) + minGap - bx;
    q.minY = Math.min(a1y, a2y) - minGap - by; q.maxY = Math.max(a1y, a2y) + minGap - by;
    const hits = treeB.search(q);
    for (let k = 0; k < hits.length; k++) {
      const j = hits[k];
      const b1 = B[j], b2 = B[(j + 1) % nB];
      const b1x = bx + b1.x, b1y = by + b1.y, b2x = bx + b2.x, b2y = by + b2.y;
      if (segmentsCross(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y)) return true;
      // as 4 extremidades contra o outro segmento (o par vizinho pode ter sido podado pela caixa)
      if (pointToSegmentDistSq(a1x, a1y, b1x, b1y, b2x, b2y) < minGapSq) return true;
      if (pointToSegmentDistSq(a2x, a2y, b1x, b1y, b2x, b2y) < minGapSq) return true;
      if (pointToSegmentDistSq(b1x, b1y, a1x, a1y, a2x, a2y) < minGapSq) return true;
      if (pointToSegmentDistSq(b2x, b2y, a1x, a1y, a2x, a2y) < minGapSq) return true;
    }
  }
  return false;
}

/** Cruzamento próprio de segmentos (mesmo predicado de segmentsIntersectExact, sem alocar objetos). */
function segmentsCross(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y) {
  const o1 = orient2dRobust(a1x, a1y, a2x, a2y, b1x, b1y);
  const o2 = orient2dRobust(a1x, a1y, a2x, a2y, b2x, b2y);
  if (o1 === o2) return false;
  const o3 = orient2dRobust(b1x, b1y, b2x, b2y, a1x, a1y);
  const o4 = orient2dRobust(b1x, b1y, b2x, b2y, a2x, a2y);
  return o3 !== o4;
}

module.exports = { polygonsCollideTrueShape, segmentsCross, EDGE_INDEX_MIN_VERTS };
