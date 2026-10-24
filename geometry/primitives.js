// geometry/primitives.js — predicados e medidas geométricas básicas.
// MÓDULO FOLHA: não pode fazer require() de nenhum outro módulo do projeto.
// (Garante grafo de dependências acíclico; ver test/run.js "[ESTRUTURA]" e docs/adr/001.)
'use strict';

function getBoundingBox(pts) {
  let min_x = Infinity, min_y = Infinity, max_x = -Infinity, max_y = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < min_x) min_x = p.x;
    if (p.y < min_y) min_y = p.y;
    if (p.x > max_x) max_x = p.x;
    if (p.y > max_y) max_y = p.y;
  }
  const width = +(max_x - min_x).toFixed(3);
  const height = +(max_y - min_y).toFixed(3);
  return {
    min_x: +min_x.toFixed(3),
    min_y: +min_y.toFixed(3),
    max_x: +max_x.toFixed(3),
    max_y: +max_y.toFixed(3),
    minX: +min_x.toFixed(3),
    minY: +min_y.toFixed(3),
    maxX: +max_x.toFixed(3),
    maxY: +max_y.toFixed(3),
    width,
    height,
    area: +(width * height).toFixed(2)
  };
}

/** Fórmula de Gauss (Shoelace): área sinalizada. > 0 = anti-horário (CCW); < 0 = horário (CW). */
function computeSignedArea(pts) {
  let sum = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    sum += (p1.x * p2.y - p2.x * p1.y);
  }
  return sum * 0.5;
}

function polygonPerimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

/** Ponto em polígono (regra par-ímpar). Ponto exatamente na borda: resultado indefinido. */
function isPointInPolygon(pt, vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointToSegmentDistSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - x1) ** 2 + (py - y1) ** 2;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
}

function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  return Math.sqrt(pointToSegmentDistSq(px, py, x1, y1, x2, y2));
}

/** Menor distância de um ponto à fronteira de um anel fechado. */
function pointToRingDist(px, py, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = pointToSegmentDistSq(px, py, ring[j].x, ring[j].y, ring[i].x, ring[i].y);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// Escala inteira de 64 bits (nanômetro) para orientação exata no caso quase colinear
const INT_SCALE = 1000000;
function toFixedInt(val) {
  return BigInt(Math.round(val * INT_SCALE));
}

/** Orientação exata em inteiros: > 0 CCW, < 0 CW, 0 colinear. */
function orient2dExactInt64(ax, ay, bx, by, cx, cy) {
  const det = (toFixedInt(bx - ax) * toFixedInt(cy - ay)) -
              (toFixedInt(by - ay) * toFixedInt(cx - ax));
  return det > 0n ? 1 : (det < 0n ? -1 : 0);
}

// Limite de erro do determinante 2x2 em double (Shewchuk: (3 + 16ε)ε, ε = 2^-53)
const ORIENT_ERR_BOUND = 3.3306690738754716e-16;

/** Orientação com filtro de ponto flutuante; só cai no cálculo inteiro quando o double é duvidoso. */
function orient2dRobust(ax, ay, bx, by, cx, cy) {
  const detL = (bx - ax) * (cy - ay);
  const detR = (by - ay) * (cx - ax);
  const det = detL - detR;
  const err = ORIENT_ERR_BOUND * (Math.abs(detL) + Math.abs(detR));
  if (det > err) return 1;
  if (-det > err) return -1;
  return orient2dExactInt64(ax, ay, bx, by, cx, cy);
}

/** Interseção própria de segmentos (cruzamento estrito; toque colinear/extremidade não conta). */
function segmentsIntersectExact(a1, a2, b1, b2) {
  const o1 = orient2dRobust(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const o2 = orient2dRobust(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  const o3 = orient2dRobust(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const o4 = orient2dRobust(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  return (o1 !== o2) && (o3 !== o4);
}

module.exports = {
  getBoundingBox,
  computeSignedArea,
  polygonPerimeter,
  isPointInPolygon,
  pointToSegmentDistSq,
  pointToSegmentDist,
  pointToRingDist,
  orient2dExactInt64,
  orient2dRobust,
  segmentsIntersectExact
};
