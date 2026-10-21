// cadParser.js
'use strict';

const { RTree2D } = require('./spatialIndex');
const { resolveAllowedRotations } = require('./typesAndInterfaces');

// =========================================================================
// 1. ÁLGEBRA DE POLÍGONOS, FÓRMULA DE GAUSS (SHOELACE) E NORMALS
// =========================================================================

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

/**
 * Fórmula de Gauss (Shoelace): Retorna a área algébrica sinalizada As.
 * As > 0 => Anti-Horário (CCW); As < 0 => Horário (CW).
 */
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
// 2. DISCRETIZAÇÃO ADAPTATIVA DE ARCOS, BULGES, BÉZIER E NURBS (SPLINE)
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
  const maxStepRad = Math.max(0.05, 2 * Math.acos(1 - safeRatio));
  const numSegs = Math.max(6, Math.min(180, Math.ceil(absSweep / maxStepRad)));

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
 * Converte um segmento com fator bulge b = tan(DeltaTheta / 4) de LWPOLYLINE em arco discretizado.
 */
function discretizeBulgeSegment(p1, p2, bulge, deltaMax = 0.03) {
  if (!bulge || Math.abs(bulge) < 1e-6) return [p1, p2];

  const chordDx = p2.x - p1.x;
  const chordDy = p2.y - p1.y;
  const chordLen = Math.hypot(chordDx, chordDy);
  if (chordLen < 1e-6) return [p1];

  const radius = (chordLen * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
  const sweepAngle = 4 * Math.atan(Math.abs(bulge));
  const halfChord = chordLen * 0.5;
  const apothem = Math.sqrt(Math.max(0, radius * radius - halfChord * halfChord));

  const midX = (p1.x + p2.x) * 0.5;
  const midY = (p1.y + p2.y) * 0.5;
  const sign = (bulge > 0 ? 1 : -1) * (Math.abs(bulge) <= 1 ? 1 : -1);

  const nx = -chordDy / chordLen;
  const ny = chordDx / chordLen;
  const cx = midX + sign * apothem * nx;
  const cy = midY + sign * apothem * ny;

  const startAng = Math.atan2(p1.y - cy, p1.x - cx);
  const endAng = startAng + (bulge > 0 ? sweepAngle : -sweepAngle);

  return discretizeArcAdaptive(cx, cy, radius, startAng, endAng, bulge > 0, deltaMax);
}

/**
 * Subdivisão Recursiva de De Casteljau com Teste de Planicidade (Flatness <= deltaMax).
 */
function deCasteljauCubicAdaptive(p0, p1, p2, p3, deltaMax = 0.03, depth = 0) {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  const len = Math.hypot(dx, dy) || 1e-9;

  const d1 = Math.abs(dx * (p1.y - p0.y) - dy * (p1.x - p0.x)) / len;
  const d2 = Math.abs(dx * (p2.y - p0.y) - dy * (p2.x - p0.x)) / len;

  if (0.75 * Math.max(d1, d2) <= deltaMax || depth >= 10) {
    return [p0, p3];
  }

  const q0 = p0;
  const q1 = { x: (p0.x + p1.x) * 0.5, y: (p0.y + p1.y) * 0.5 };
  const m = { x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 };
  const r2 = { x: (p2.x + p3.x) * 0.5, y: (p2.y + p3.y) * 0.5 };
  const q2 = { x: (q1.x + m.x) * 0.5, y: (q1.y + m.y) * 0.5 };
  const r1 = { x: (m.x + r2.x) * 0.5, y: (m.y + r2.y) * 0.5 };
  const q3 = { x: (q2.x + r1.x) * 0.5, y: (q2.y + r1.y) * 0.5 };

  const left = deCasteljauCubicAdaptive(q0, q1, q2, q3, deltaMax, depth + 1);
  const right = deCasteljauCubicAdaptive(q3, r1, r2, p3, deltaMax, depth + 1);
  return [...left.slice(0, -1), ...right];
}

/**
 * Avaliação de B-Spline / NURBS (Entidade SPLINE do DXF) via Recorrência de Cox-de Boor.
 */
function evaluateNurbsPoint(u, degree, controlPoints, knots, weights) {
  const n = controlPoints.length - 1;
  const basis = new Float64Array(n + 1);

  for (let i = 0; i <= n; i++) {
    basis[i] = (u >= knots[i] && u < knots[i + 1]) || (Math.abs(u - knots[knots.length - 1]) < 1e-9 && i === n) ? 1.0 : 0.0;
  }

  for (let p = 1; p <= degree; p++) {
    for (let i = 0; i <= n - p; i++) {
      const d1 = knots[i + p] - knots[i];
      const d2 = knots[i + p + 1] - knots[i + 1];
      const t1 = d1 > 1e-9 ? ((u - knots[i]) / d1) * basis[i] : 0;
      const t2 = d2 > 1e-9 ? ((knots[i + p + 1] - u) / d2) * basis[i + 1] : 0;
      basis[i] = t1 + t2;
    }
  }

  let wx = 0, wy = 0, wSum = 0;
  for (let i = 0; i <= n; i++) {
    const w = (weights && weights[i] !== undefined) ? weights[i] : 1.0;
    const bw = basis[i] * w;
    wx += bw * controlPoints[i].x;
    wy += bw * controlPoints[i].y;
    wSum += bw;
  }
  const denom = wSum || 1.0;
  return { x: +(wx / denom).toFixed(4), y: +(wy / denom).toFixed(4) };
}

function discretizeSplineEntity(ent, deltaMax = 0.03) {
  const ctrl = ent.controlPoints || ent.fitPoints || [];
  if (ctrl.length < 2) return [];
  if (ctrl.length === 4 && (!ent.knotValues || ent.knotValues.length === 0)) {
    return deCasteljauCubicAdaptive(ctrl[0], ctrl[1], ctrl[2], ctrl[3], deltaMax);
  }

  const degree = ent.degreeOfSplineCurve || Math.min(3, ctrl.length - 1);
  let knots = ent.knotValues;
  if (!knots || knots.length !== ctrl.length + degree + 1) {
    knots = [];
    for (let i = 0; i <= degree; i++) knots.push(0);
    const internal = ctrl.length - degree - 1;
    for (let i = 1; i <= internal; i++) knots.push(i / (internal + 1));
    for (let i = 0; i <= degree; i++) knots.push(1);
  }

  const uMin = knots[degree];
  const uMax = knots[knots.length - degree - 1];
  const pts = [];

  const subdivideSegment = (u0, p0, u1, p1, depth) => {
    const uMid = (u0 + u1) * 0.5;
    const pMid = evaluateNurbsPoint(uMid, degree, ctrl, knots, ent.weights);
    const chordMidX = (p0.x + p1.x) * 0.5;
    const chordMidY = (p0.y + p1.y) * 0.5;
    const sagitta = Math.hypot(pMid.x - chordMidX, pMid.y - chordMidY);

    if (sagitta <= deltaMax || depth >= 8) {
      pts.push(p1);
    } else {
      subdivideSegment(u0, p0, uMid, pMid, depth + 1);
      subdivideSegment(uMid, pMid, u1, p1, depth + 1);
    }
  };

  const pStart = evaluateNurbsPoint(uMin, degree, ctrl, knots, ent.weights);
  const pEnd = evaluateNurbsPoint(uMax, degree, ctrl, knots, ent.weights);
  pts.push(pStart);
  subdivideSegment(uMin, pStart, uMax, pEnd, 0);
  return pts;
}

// =========================================================================
// 3. CAD HEALING: ENCADEAMENTO DE SEGMENTOS VIA R-TREE (CHAINING & WELDING)
// =========================================================================

function chainLooseSegmentsRTree(rawSegments, epsChain = 0.25, epsDegenerate = 0.02) {
  // 1. Filtra segmentos degenerados (comprimento < epsDegenerate)
  const validSegs = rawSegments.filter(
    s => Math.hypot(s.p2.x - s.p1.x, s.p2.y - s.p1.y) >= epsDegenerate
  ).map((s, idx) => ({ id: idx, p1: s.p1, p2: s.p2, used: false }));

  if (validSegs.length === 0) return [];

  // 2. Indexa todas as extremidades na R-Tree para busca de vizinhos em O(log V)
  const endpointTree = new RTree2D(8);
  const entries = [];
  for (const seg of validSegs) {
    entries.push({
      minX: seg.p1.x - epsChain, minY: seg.p1.y - epsChain,
      maxX: seg.p1.x + epsChain, maxY: seg.p1.y + epsChain,
      data: { seg, end: 1, pt: seg.p1 }
    });
    entries.push({
      minX: seg.p2.x - epsChain, minY: seg.p2.y - epsChain,
      maxX: seg.p2.x + epsChain, maxY: seg.p2.y + epsChain,
      data: { seg, end: 2, pt: seg.p2 }
    });
  }
  endpointTree.loadBulk(entries);

  const polygons = [];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  for (let i = 0; i < validSegs.length; i++) {
    const startSeg = validSegs[i];
    if (startSeg.used) continue;
    startSeg.used = true;

    const ring = [startSeg.p1, startSeg.p2];
    let closed = false;

    while (!closed) {
      const tail = ring[ring.length - 1];
      const candidates = endpointTree.search({
        minX: tail.x - epsChain, minY: tail.y - epsChain,
        maxX: tail.x + epsChain, maxY: tail.y + epsChain
      });

      let bestMatch = null;
      let bestDist = Infinity;

      for (const cand of candidates) {
        if (cand.seg.used) continue;
        const d = dist(tail, cand.pt);
        if (d <= epsChain && d < bestDist) {
          bestDist = d;
          bestMatch = cand;
        }
      }

      if (bestMatch) {
        bestMatch.seg.used = true;
        const nextPt = bestMatch.end === 1 ? bestMatch.seg.p2 : bestMatch.seg.p1;
        ring.push(nextPt);
        if (ring.length >= 3 && dist(ring[0], nextPt) <= epsChain) {
          ring.pop(); // Fecha sem duplicar o vértice inicial
          closed = true;
        }
      } else {
        if (ring.length >= 3 && dist(ring[0], tail) <= epsChain * 2) {
          ring.pop();
          closed = true;
        }
        break;
      }
    }

    if (ring.length >= 3) {
      polygons.push(simplifyCollinearVertices(ring));
    }
  }

  return polygons;
}

/**
 * Remove vértices redundantes ou colineares sobrepostos em varredura angular.
 */
function simplifyCollinearVertices(pts, epsDist = 0.02, epsCross = 1e-3) {
  if (pts.length <= 3) return pts;
  const cleaned = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    if (!prev || Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) > epsDist) {
      cleaned.push(pts[i]);
    }
  }
  if (cleaned.length <= 3) return cleaned;

  const result = [];
  const n = cleaned.length;
  for (let i = 0; i < n; i++) {
    const pPrev = cleaned[(i - 1 + n) % n];
    const pCurr = cleaned[i];
    const pNext = cleaned[(i + 1) % n];
    const v1x = pCurr.x - pPrev.x, v1y = pCurr.y - pPrev.y;
    const v2x = pNext.x - pCurr.x, v2y = pNext.y - pCurr.y;
    const cross = Math.abs(v1x * v2y - v1y * v2x);
    if (cross > epsCross) {
      result.push(pCurr);
    }
  }
  return result.length >= 3 ? result : cleaned;
}

// =========================================================================
// 4. EXTRAÇÃO UNIFICADA DE CONTORNOS DXF
// =========================================================================

function extractContoursFromDxf(dxf, deltaMax = 0.03) {
  const contours = [];
  const looseSegments = [];
  const entities = dxf.entities || [];

  entities.forEach((ent, idx) => {
    if ((ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && ent.vertices && ent.vertices.length >= 2) {
      const vList = ent.vertices;
      const pts = [];
      const isClosed = Boolean(ent.shape || ent.closed || (vList.length >= 3 && Math.hypot(vList[0].x - vList[vList.length - 1].x, vList[0].y - vList[vList.length - 1].y) < 0.2));

      const count = isClosed ? vList.length : vList.length - 1;
      for (let i = 0; i < count; i++) {
        const v1 = vList[i];
        const v2 = vList[(i + 1) % vList.length];
        if (v1.bulge && Math.abs(v1.bulge) > 1e-5) {
          const arcPts = discretizeBulgeSegment(v1, v2, v1.bulge, deltaMax);
          pts.push(...arcPts.slice(0, -1));
        } else {
          pts.push({ x: v1.x, y: v1.y });
        }
      }

      if (isClosed && pts.length >= 3) {
        if (Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.05) {
          pts.pop();
        }
        const bbox = getBoundingBox(pts);
        const signedArea = computeSignedArea(pts);
        const trueArea = +(Math.abs(signedArea)).toFixed(2) || bbox.area;
        contours.push({ id: `C_${idx}`, type: 'POLYLINE', points: pts, bbox, signedArea, trueArea });
      } else {
        for (let i = 0; i < pts.length - 1; i++) {
          looseSegments.push({ p1: pts[i], p2: pts[i + 1] });
        }
      }
    } else if (ent.type === 'CIRCLE' && ent.center && ent.radius) {
      const pts = discretizeArcAdaptive(ent.center.x, ent.center.y, ent.radius, 0, Math.PI * 2, true, deltaMax);
      pts.pop(); // Remove ponto final coincidente com 0 rad
      const bbox = getBoundingBox(pts);
      const trueArea = +(Math.PI * ent.radius * ent.radius).toFixed(2);
      contours.push({ id: `C_${idx}`, type: 'CIRCLE', radius: ent.radius, points: pts, bbox, signedArea: trueArea, trueArea });
    } else if (ent.type === 'ARC' && ent.center && ent.radius) {
      const startRad = ent.startAngle > Math.PI * 2 ? (ent.startAngle * Math.PI) / 180 : ent.startAngle;
      const endRad = ent.endAngle > Math.PI * 2 ? (ent.endAngle * Math.PI) / 180 : ent.endAngle;
      const arcPts = discretizeArcAdaptive(ent.center.x, ent.center.y, ent.radius, startRad, endRad, true, deltaMax);
      for (let i = 0; i < arcPts.length - 1; i++) {
        looseSegments.push({ p1: arcPts[i], p2: arcPts[i + 1] });
      }
    } else if (ent.type === 'SPLINE') {
      const spPts = discretizeSplineEntity(ent, deltaMax);
      if (spPts.length >= 3 && Math.hypot(spPts[0].x - spPts[spPts.length - 1].x, spPts[0].y - spPts[spPts.length - 1].y) < 0.25) {
        spPts.pop();
        const bbox = getBoundingBox(spPts);
        const signedArea = computeSignedArea(spPts);
        contours.push({ id: `SP_${idx}`, type: 'SPLINE', points: spPts, bbox, signedArea, trueArea: +(Math.abs(signedArea)).toFixed(2) });
      } else {
        for (let i = 0; i < spPts.length - 1; i++) {
          looseSegments.push({ p1: spPts[i], p2: spPts[i + 1] });
        }
      }
    } else if (ent.type === 'LINE' && ent.vertices && ent.vertices.length === 2) {
      looseSegments.push({
        p1: { x: ent.vertices[0].x, y: ent.vertices[0].y },
        p2: { x: ent.vertices[1].x, y: ent.vertices[1].y }
      });
    }
  });

  if (looseSegments.length > 0) {
    const chainedPolys = chainLooseSegmentsRTree(looseSegments);
    chainedPolys.forEach((pts, idx) => {
      const bbox = getBoundingBox(pts);
      const signedArea = computeSignedArea(pts);
      contours.push({
        id: `ST_${idx}`,
        type: 'CHAINED_RING',
        points: pts,
        bbox,
        signedArea,
        trueArea: +(Math.abs(signedArea)).toFixed(2) || bbox.area
      });
    });
  }

  return contours.filter(c => c.bbox.width > 0.5 && c.bbox.height > 0.5);
}

// =========================================================================
// 5. OFFSET POLIGONAL (MITER / BEVEL JOIN) E EIXO MEDIAL (RAIO INSCRITO R_MAX)
// =========================================================================

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

function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

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
// 6. ÁRVORE TOPOLÓGICA DE PEÇAS E FUROS (CONTOUR CONTAINMENT TREE)
// =========================================================================

function classifyPartsAndHoles(rawContours, minHoleSize, nestingParams = {}) {
  const kerf_width = Number(nestingParams.kerf_width ?? 0.4);
  const part_clearance = Number(nestingParams.part_clearance ?? 5.6);
  const deltaExp = (part_clearance + kerf_width) * 0.5;
  const allowedRotations = resolveAllowedRotations(
    nestingParams.allow_rotation ?? true,
    nestingParams.grain_restriction ?? 'ORTHOGONAL'
  );

  const sorted = [...rawContours].sort((a, b) => b.bbox.area - a.bbox.area);
  const parentsMap = new Map();

  for (let i = 0; i < sorted.length; i++) {
    parentsMap.set(sorted[i].id, []);
    for (let j = 0; j < i; j++) {
      const p = sorted[j], c = sorted[i];
      if (
        c.bbox.minX >= p.bbox.minX - 0.1 && c.bbox.maxX <= p.bbox.maxX + 0.1 &&
        c.bbox.minY >= p.bbox.minY - 0.1 && c.bbox.maxY <= p.bbox.maxY + 0.1 &&
        isPointInPolygon(c.points[0], p.points)
      ) {
        parentsMap.get(c.id).push(p.id);
      }
    }
  }

  const parts = [];
  const holeToParent = new Map();

  sorted.forEach(c => {
    const anc = parentsMap.get(c.id) || [];
    if (anc.length % 2 === 0) {
      // Nível Par (0, 2...): Contorno Externo de Peça -> Força orientação Anti-Horária (CCW, As > 0)
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

      parts.push({
        id: `PECA_${parts.length + 1}`,
        name: `Peça #${parts.length + 1}`,
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
        quantity_required: 1
      });
    } else {
      // Nível Ímpar (1, 3...): Furo Interno -> Vincula à peça mãe imediata
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

    // Furo interno recebe orientação Horária (CW, As < 0)
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

  return parts;
}

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
  getBoundingBox,
  computeSignedArea,
  enforceWindingOrder,
  computeEdgeNormals,
  isPointInPolygon,
  pointToSegmentDist,
  computeMaxInscribedCircle,
  offsetPolygonRing,
  extractContoursFromDxf,
  classifyPartsAndHoles,
  buildCustomSheetFromContours
};