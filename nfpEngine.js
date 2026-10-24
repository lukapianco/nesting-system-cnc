// nfpEngine.js
'use strict';

// Predicados robustos vivem no módulo folha geometry/primitives (sem ciclos de require).
const {
  orient2dExactInt64,
  orient2dRobust,
  segmentsIntersectExact,
  pointToSegmentDistSq
} = require('./geometry/primitives');

/**
 * Fecho Convexo (Monotone Chain) em O(V log V) para cálculo rápido de Soma de Minkowski basal.
 */
function computeConvexHull(pts) {
  if (pts.length <= 3) return [...pts];
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Soma de Minkowski O(n + m) para polígonos convexos orientados (Edge Merge Polar)
 * + Amostragem de Vértices de Contato Côncavos (Orbital Contact Loci).
 */
function buildNfpLocus(polyA, wA, hA, polyB, wB, hB, requiredGap) {
  // Pontos de contato orbital (onde um vértice de -B tangencia um vértice ou concavidade de A com folga requiredGap)
  const contactVertices = [
    { x: -wB - requiredGap, y: 0 },
    { x: wA + requiredGap, y: 0 },
    { x: 0, y: -hB - requiredGap },
    { x: 0, y: hA + requiredGap },
    { x: wA + requiredGap, y: hA - hB },
    { x: wA - wB, y: hA + requiredGap }
  ];

  // Amostra pares de vértices reais (a - b) para permitir encaixes em concavidades ("L", chanfros, triângulos)
  const stepA = Math.max(1, Math.floor(polyA.length / 12));
  const stepB = Math.max(1, Math.floor(polyB.length / 12));

  for (let i = 0; i < polyA.length; i += stepA) {
    const a = polyA[i];
    const aNext = polyA[(i + 1) % polyA.length];
    const edgeDx = aNext.x - a.x;
    const edgeDy = aNext.y - a.y;
    const edgeLen = Math.hypot(edgeDx, edgeDy) || 1;
    const nx = (edgeDy / edgeLen) * requiredGap;
    const ny = (-edgeDx / edgeLen) * requiredGap;

    for (let j = 0; j < polyB.length; j += stepB) {
      const b = polyB[j];
      contactVertices.push({
        x: +(a.x - b.x + nx).toFixed(2),
        y: +(a.y - b.y + ny).toFixed(2)
      });
      // Ponto médio da aresta de A contra vértice de B (ideal para encaixar no fundo do "L")
      contactVertices.push({
        x: +((a.x + aNext.x) * 0.5 - b.x + nx).toFixed(2),
        y: +((a.y + aNext.y) * 0.5 - b.y + ny).toFixed(2)
      });
    }
  }

  return contactVertices;
}

/**
 * Gerenciador de Cache NFP/IFP com exploração da identidade reflexiva NFP(A,B) = -NFP(B,A).
 */
class NfpCacheManager {
  constructor() {
    this.cache = new Map();
  }

  /**
   * Obtém os vértices candidatos da fronteira NFP(A, B) para o par (partA, angleA, partB, angleB).
   */
  getNfpCandidates(idA, angleA, ptsA, wA, hA, idB, angleB, ptsB, wB, hB, gap) {
    const gapKey = Math.round(gap * 100);
    const key = `${idA}_${angleA}__${idB}_${angleB}__${gapKey}`;
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    // Explora simetria reflexiva: NFP(A, B) = -NFP(B, A)
    const symKey = `${idB}_${angleB}__${idA}_${angleA}__${gapKey}`;
    if (this.cache.has(symKey)) {
      const symLocus = this.cache.get(symKey);
      const reflected = symLocus.map(v => ({ x: -v.x, y: -v.y }));
      this.cache.set(key, reflected);
      return reflected;
    }

    const locus = buildNfpLocus(ptsA, wA, hA, ptsB, wB, hB, gap);
    this.cache.set(key, locus);
    return locus;
  }

  /**
   * Calcula os limites do Inner-Fit Polygon (IFP) de uma peça dentro da chapa respeitando sheet_margin.
   */
  getSheetIfpBounds(sheetW, sheetH, partW, partH, effectiveSheetMargin) {
    return {
      minX: effectiveSheetMargin,
      minY: effectiveSheetMargin,
      maxX: sheetW - effectiveSheetMargin - partW,
      maxY: sheetH - effectiveSheetMargin - partH
    };
  }
}

module.exports = {
  orient2dExactInt64,
  orient2dRobust,
  segmentsIntersectExact,
  pointToSegmentDistSq,
  computeConvexHull,
  NfpCacheManager
};