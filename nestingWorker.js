// nestingWorker.js
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { normalizeNestingParams, resolveAllowedRotations } = require('./typesAndInterfaces');
const { RTree2D } = require('./spatialIndex');
const { isPointInPolygon, computeMaxInscribedCircle, getBoundingBox } = require('./cadParser');
const { segmentsIntersectExact, pointToSegmentDistSq, NfpCacheManager } = require('./nfpEngine');

const { parts = [], sheet = null, config: rawConfig = {} } = workerData;
const params = normalizeNestingParams(rawConfig);
const nfpCache = new NfpCacheManager();

function createSeededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// =========================================================================
// 1. TRANSFORMAÇÃO RÍGIDA E(2) COM CACHE DE ROTAÇÃO POR PEÇA
// =========================================================================

const rotatedGeometryCache = new Map();

function getRotatedPartGeometry(part, angleDeg) {
  const deg = ((angleDeg % 360) + 360) % 360;
  const cacheKey = `${part.basePartId || part.id}_${deg}`;
  if (rotatedGeometryCache.has(cacheKey)) {
    return rotatedGeometryCache.get(cacheKey);
  }

  if (deg === 0) {
    const res0 = {
      angle: 0,
      w: part.width,
      h: part.height,
      pts: part.points,
      holes: (part.holes || []).map(h => ({
        ...h,
        rotRelX: h.relX,
        rotRelY: h.relY,
        rotW: h.width,
        rotH: h.height,
        placedPoints: h.points
      }))
    };
    rotatedGeometryCache.set(cacheKey, res0);
    return res0;
  }

  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const rotRaw = part.points.map(p => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos
  }));

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of rotRaw) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  const normPts = rotRaw.map(p => ({
    x: +(p.x - minX).toFixed(3),
    y: +(p.y - minY).toFixed(3)
  }));

  const rotHoles = (part.holes || []).map(h => {
    const hPts = h.points.map(p => ({
      x: +((p.x * cos - p.y * sin) - minX).toFixed(3),
      y: +((p.x * sin + p.y * cos) - minY).toFixed(3)
    }));
    const hb = getBoundingBox(hPts);
    return {
      ...h,
      rotRelX: hb.minX,
      rotRelY: hb.minY,
      rotW: hb.width,
      rotH: hb.height,
      placedPoints: hPts
    };
  });

  const resRot = {
    angle: deg,
    w: +(maxX - minX).toFixed(3),
    h: +(maxY - minY).toFixed(3),
    pts: normPts,
    holes: rotHoles
  };
  rotatedGeometryCache.set(cacheKey, resRot);
  return resRot;
}

// =========================================================================
// 2. VERIFICAÇÃO DE FRONTEIRA INTERNA (IFP) E COLISÃO TRUE-SHAPE EXATA (INT64)
// =========================================================================

function isPartInsideSheetIfp(x, y, w, h, partPts, customSheet, sheetMargin, kerfWidth) {
  const sheetW = customSheet?.isCustomDxf ? customSheet.width : params.sheet_width;
  const sheetH = customSheet?.isCustomDxf ? customSheet.height : params.sheet_height;
  const minBorderDist = sheetMargin + kerfWidth * 0.5;

  if (
    x < minBorderDist - 0.1 ||
    y < minBorderDist - 0.1 ||
    x + w > sheetW - minBorderDist + 0.1 ||
    y + h > sheetH - minBorderDist + 0.1
  ) {
    return false;
  }

  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return true;
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];
  const minGapSq = Math.max(0.1, minBorderDist - 0.2) ** 2;
  const absPts = partPts.map(p => ({ x: x + p.x, y: y + p.y }));

  for (let i = 0; i < absPts.length; i++) {
    const p1 = absPts[i];
    const p2 = absPts[(i + 1) % absPts.length];

    if (!isPointInPolygon(p1, sheetPoly)) return false;
    if (!isPointInPolygon({ x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 }, sheetPoly)) return false;

    for (let j = 0; j < sheetPoly.length; j++) {
      const s1 = sheetPoly[j];
      const s2 = sheetPoly[(j + 1) % sheetPoly.length];
      if (segmentsIntersectExact(p1, p2, s1, s2)) return false;
      if (pointToSegmentDistSq(p1.x, p1.y, s1.x, s1.y, s2.x, s2.y) < minGapSq) return false;
      if (pointToSegmentDistSq(s1.x, s1.y, p1.x, p1.y, p2.x, p2.y) < minGapSq) return false;
    }
  }

  for (const obs of obstacles) {
    if (
      x + w + minBorderDist <= obs.minX + 0.05 ||
      obs.maxX + minBorderDist <= x + 0.05 ||
      y + h + minBorderDist <= obs.minY + 0.05 ||
      obs.maxY + minBorderDist <= y + 0.05
    ) {
      continue;
    }

    const obsPts = obs.points;
    for (let i = 0; i < absPts.length; i++) {
      const p1 = absPts[i];
      const p2 = absPts[(i + 1) % absPts.length];
      if (isPointInPolygon(p1, obsPts)) return false;
      if (isPointInPolygon({ x: (p1.x + p2.x) * 0.5, y: (p1.y + p2.y) * 0.5 }, obsPts)) return false;
    }

    for (let j = 0; j < obsPts.length; j++) {
      const o1 = obsPts[j];
      const o2 = obsPts[(j + 1) % obsPts.length];
      if (isPointInPolygon(o1, absPts)) return false;
      if (isPointInPolygon({ x: (o1.x + o2.x) * 0.5, y: (o1.y + o2.y) * 0.5 }, absPts)) return false;
    }

    for (let i = 0; i < absPts.length; i++) {
      const p1 = absPts[i];
      const p2 = absPts[(i + 1) % absPts.length];
      for (let j = 0; j < obsPts.length; j++) {
        const o1 = obsPts[j];
        const o2 = obsPts[(j + 1) % obsPts.length];
        if (segmentsIntersectExact(p1, p2, o1, o2)) return false;
        if (pointToSegmentDistSq(p1.x, p1.y, o1.x, o1.y, o2.x, o2.y) < minGapSq) return false;
        if (pointToSegmentDistSq(o1.x, o1.y, p1.x, p1.y, p2.x, p2.y) < minGapSq) return false;
      }
    }
  }

  return true;
}

/**
 * Detecção de colisão True-Shape exata entre duas peças (usada em conjunto com R-Tree broad-phase).
 */
function polygonsCollideTrueShape(pA, pB, requiredNominalGap) {
  if (
    pA.x + pA.placedWidth + requiredNominalGap <= pB.x + 0.05 ||
    pB.x + pB.placedWidth + requiredNominalGap <= pA.x + 0.05 ||
    pA.y + pA.placedHeight + requiredNominalGap <= pB.y + 0.05 ||
    pB.y + pB.placedHeight + requiredNominalGap <= pA.y + 0.05
  ) {
    return false;
  }

  const isRectA = pA.points.length === 4 && Math.abs(pA.area - pA.bboxArea) < 2 && (pA.angle || 0) % 90 === 0;
  const isRectB = pB.points.length === 4 && Math.abs(pB.area - pB.bboxArea) < 2 && (pB.angle || 0) % 90 === 0;
  if (isRectA && isRectB) return true;

  const ptsA = pA.placedPoints.map(p => ({ x: pA.x + p.x, y: pA.y + p.y }));
  const ptsB = pB.placedPoints.map(p => ({ x: pB.x + p.x, y: pB.y + p.y }));

  for (let i = 0; i < ptsA.length; i++) {
    const a1 = ptsA[i];
    const a2 = ptsA[(i + 1) % ptsA.length];
    if (isPointInPolygon(a1, ptsB)) return true;
    if (isPointInPolygon({ x: (a1.x + a2.x) * 0.5, y: (a1.y + a2.y) * 0.5 }, ptsB)) return true;
  }

  for (let j = 0; j < ptsB.length; j++) {
    const b1 = ptsB[j];
    const b2 = ptsB[(j + 1) % ptsB.length];
    if (isPointInPolygon(b1, ptsA)) return true;
    if (isPointInPolygon({ x: (b1.x + b2.x) * 0.5, y: (b1.y + b2.y) * 0.5 }, ptsA)) return true;
  }

  const minGapSq = Math.max(0.08, requiredNominalGap - 0.15) ** 2;
  for (let i = 0; i < ptsA.length; i++) {
    const a1 = ptsA[i];
    const a2 = ptsA[(i + 1) % ptsA.length];
    for (let j = 0; j < ptsB.length; j++) {
      const b1 = ptsB[j];
      const b2 = ptsB[(j + 1) % ptsB.length];
      if (segmentsIntersectExact(a1, a2, b1, b2)) return true;
      if (pointToSegmentDistSq(a1.x, a1.y, b1.x, b1.y, b2.x, b2.y) < minGapSq) return true;
      if (pointToSegmentDistSq(b1.x, b1.y, a1.x, a1.y, a2.x, a2.y) < minGapSq) return true;
    }
  }

  return false;
}

function getSolidBoxesForPart(placedPart, gap) {
  const pts = placedPart.placedPoints;
  if (pts.length === 6 && Math.abs(placedPart.area - placedPart.bboxArea) > 10 && (placedPart.angle || 0) % 90 === 0) {
    const xs = [...new Set(pts.map(p => +p.x.toFixed(1)))].sort((a, b) => a - b);
    const ys = [...new Set(pts.map(p => +p.y.toFixed(1)))].sort((a, b) => a - b);
    if (xs.length === 3 && ys.length === 3) {
      const solidBoxes = [];
      for (let ix = 0; ix < 2; ix++) {
        for (let iy = 0; iy < 2; iy++) {
          const cx = (xs[ix] + xs[ix + 1]) * 0.5;
          const cy = (ys[iy] + ys[iy + 1]) * 0.5;
          if (isPointInPolygon({ x: cx, y: cy }, pts)) {
            solidBoxes.push({
              x: placedPart.x + xs[ix],
              y: placedPart.y + ys[iy],
              width: (xs[ix + 1] - xs[ix]) + gap,
              height: (ys[iy + 1] - ys[iy]) + gap
            });
          }
        }
      }
      if (solidBoxes.length > 0) return solidBoxes;
    }
  }
  return [{
    x: placedPart.x,
    y: placedPart.y,
    width: placedPart.placedWidth + gap,
    height: placedPart.placedHeight + gap
  }];
}

function subtractBoxFromFreeRects(freeRects, box) {
  const newFree = [];
  for (const rect of freeRects) {
    if (
      box.x < rect.x + rect.width &&
      box.x + box.width > rect.x &&
      box.y < rect.y + rect.height &&
      box.y + box.height > rect.y
    ) {
      if (box.x > rect.x) newFree.push({ x: rect.x, y: rect.y, width: box.x - rect.x, height: rect.height });
      if (box.x + box.width < rect.x + rect.width) {
        newFree.push({ x: box.x + box.width, y: rect.y, width: (rect.x + rect.width) - (box.x + box.width), height: rect.height });
      }
      if (box.y > rect.y) newFree.push({ x: rect.x, y: rect.y, width: rect.width, height: box.y - rect.y });
      if (box.y + box.height < rect.y + rect.height) {
        newFree.push({ x: rect.x, y: box.y + box.height, width: rect.width, height: (rect.y + rect.height) - (box.y + box.height) });
      }
    } else {
      newFree.push(rect);
    }
  }

  return newFree.filter((r1, i) => {
    if (r1.width <= 1 || r1.height <= 1) return false;
    return !newFree.some((r2, j) =>
      i !== j && r1.x >= r2.x && r1.y >= r2.y &&
      r1.x + r1.width <= r2.x + r2.width && r1.y + r1.height <= r2.y + r2.height
    );
  });
}

// =========================================================================
// 3. PRÉ-PROCESSAMENTO DE CHAPA E ÂNCORAS IFP
// =========================================================================

const SHEET_W = sheet?.isCustomDxf ? sheet.width : params.sheet_width;
const SHEET_H = sheet?.isCustomDxf ? sheet.height : params.sheet_height;
const EFFECTIVE_BORDER_MARGIN = params.sheet_margin + params.kerf_width * 0.5;
const NOMINAL_PART_GAP = params.common_line_cutting
  ? params.kerf_width
  : (params.part_clearance + params.kerf_width);

function buildInitialSheetDecomposition(sheetW, sheetH, customSheet, borderMargin) {
  let freeRects = [{
    x: borderMargin,
    y: borderMargin,
    width: Math.max(1, sheetW - borderMargin * 2),
    height: Math.max(1, sheetH - borderMargin * 2)
  }];
  const specialAnchors = [];

  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return { freeRects, specialAnchors };
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];

  for (const obs of obstacles) {
    freeRects = subtractBoxFromFreeRects(freeRects, {
      x: obs.minX - borderMargin,
      y: obs.minY - borderMargin,
      width: obs.width + borderMargin * 2,
      height: obs.height + borderMargin * 2
    });
    specialAnchors.push(
      { x: Math.max(borderMargin, obs.minX - borderMargin), y: Math.max(borderMargin, obs.minY), tag: 'POCKET' },
      { x: borderMargin, y: borderMargin, tag: 'POCKET_TOP_LEFT' },
      { x: borderMargin, y: Math.max(borderMargin, obs.maxY + borderMargin), tag: 'BELOW_OBS' },
      { x: Math.min(sheetW - borderMargin, obs.maxX + borderMargin), y: Math.max(borderMargin, obs.minY), tag: 'RIGHT_OF_OBS' }
    );
  }

  for (let i = 0; i < sheetPoly.length; i++) {
    const v1 = sheetPoly[i];
    const v2 = sheetPoly[(i + 1) % sheetPoly.length];
    for (const t of [0, 0.2, 0.4, 0.6, 0.8]) {
      const px = v1.x + (v2.x - v1.x) * t;
      const py = v1.y + (v2.y - v1.y) * t;
      specialAnchors.push(
        { x: Math.max(borderMargin, px + borderMargin), y: Math.max(borderMargin, py + borderMargin), tag: 'SLOPE' }
      );
    }
  }

  const xSet = new Set([0, sheetW]);
  const ySet = new Set([0, sheetH]);
  for (const pt of sheetPoly) {
    xSet.add(Math.max(0, Math.min(sheetW, +pt.x.toFixed(1))));
    ySet.add(Math.max(0, Math.min(sheetH, +pt.y.toFixed(1))));
  }
  for (let i = 1; i < 32; i++) xSet.add(+((sheetW * i) / 32).toFixed(1));
  for (let j = 1; j < 24; j++) ySet.add(+((sheetH * j) / 24).toFixed(1));

  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);

  for (let iy = 0; iy < ys.length - 1; iy++) {
    const y0 = ys[iy], y1 = ys[iy + 1];
    if (y1 - y0 < 0.5) continue;
    let spanStart = null;

    for (let ix = 0; ix < xs.length - 1; ix++) {
      const x0 = xs[ix], x1 = xs[ix + 1];
      if (x1 - x0 < 0.5) continue;

      const completelyOutside =
        !isPointInPolygon({ x: (x0 + x1) * 0.5, y: (y0 + y1) * 0.5 }, sheetPoly) &&
        !isPointInPolygon({ x: x0 + 0.5, y: y0 + 0.5 }, sheetPoly) &&
        !isPointInPolygon({ x: x1 - 0.5, y: y0 + 0.5 }, sheetPoly) &&
        !isPointInPolygon({ x: x1 - 0.5, y: y1 - 0.5 }, sheetPoly) &&
        !isPointInPolygon({ x: x0 + 0.5, y: y1 - 0.5 }, sheetPoly);

      if (completelyOutside) {
        if (spanStart === null) spanStart = x0;
      } else if (spanStart !== null) {
        freeRects = subtractBoxFromFreeRects(freeRects, {
          x: spanStart, y: y0, width: x0 - spanStart, height: y1 - y0
        });
        spanStart = null;
      }
    }
    if (spanStart !== null) {
      freeRects = subtractBoxFromFreeRects(freeRects, {
        x: spanStart, y: y0, width: sheetW - spanStart, height: y1 - y0
      });
    }
  }

  return { freeRects, specialAnchors };
}

const { freeRects: BASE_SHEET_FREE_RECTS, specialAnchors: SHEET_ANCHORS } =
  buildInitialSheetDecomposition(SHEET_W, SHEET_H, sheet, EFFECTIVE_BORDER_MARGIN);

// =========================================================================
// 4. HOLE FILLING (PART-IN-PART COM TRIAGEM O(1) POR R_MAX E MÚLTIPLAS PEÇAS)
// =========================================================================

function executeHoleFilling(orderedParts, holeFillingEnabled) {
  if (!holeFillingEnabled) {
    return { mainSheetParts: orderedParts, nestedInHolesMap: new Map() };
  }

  const nestedInHolesMap = new Map();
  const allocatedChildIds = new Set();
  const holeMargin = params.part_clearance + params.kerf_width;

  for (const hostPart of orderedParts) {
    if (allocatedChildIds.has(hostPart.id)) continue;
    for (const hole of hostPart.holes || []) {
      if (!hole.usableHole) continue;

      const availW = hole.width - holeMargin * 2;
      const availH = hole.height - holeMargin * 2;
      if (availW <= 2 || availH <= 2) continue;

      // Raio máximo inscrito no furo (MAT / Voronoi) para triagem instantânea O(1)
      const holeMaxR = hole.max_inscribed_radius || Math.min(hole.width, hole.height) * 0.5;

      for (const candidate of orderedParts) {
        if (candidate.id === hostPart.id || allocatedChildIds.has(candidate.id)) continue;

        // Triagem O(1) por Raio Inscrito: se a metade da menor dimensão da peça + margem > R_max do furo, descarta!
        const minPartHalfWidth = Math.min(candidate.width, candidate.height) * 0.5 + holeMargin * 0.5;
        if (minPartHalfWidth > holeMaxR + 1.0) continue;

        let fitAngle = null;
        if (candidate.width <= availW && candidate.height <= availH) {
          fitAngle = 0;
        } else if (params.allow_rotation && candidate.height <= availW && candidate.width <= availH) {
          fitAngle = 90;
        }

        if (fitAngle !== null) {
          allocatedChildIds.add(candidate.id);
          if (!nestedInHolesMap.has(hole.id)) nestedInHolesMap.set(hole.id, []);
          nestedInHolesMap.get(hole.id).push({
            rawPart: candidate,
            inHoleParentId: hostPart.id,
            inHoleId: hole.id,
            relativeAngle: fitAngle
          });
          break;
        }
      }
    }
  }

  const mainSheetParts = orderedParts.filter(p => !allocatedChildIds.has(p.id));
  return { mainSheetParts, nestedInHolesMap };
}

// =========================================================================
// 5. COMPACTAÇÃO CONTÍNUA (JOSTLING) COM ÍNDICE R-TREE 2D
// =========================================================================

function compactLayoutWithRTree(placedParts, customSheet, gravityDir) {
  const dirX = (gravityDir === 'TOP_RIGHT' || gravityDir === 'BOTTOM_RIGHT') ? 1 : -1;
  const dirY = (gravityDir === 'BOTTOM_LEFT' || gravityDir === 'BOTTOM_RIGHT') ? 1 : -1;

  for (let pass = 0; pass < 3; pass++) {
    const order = [...placedParts].sort((a, b) => {
      const scoreA = (dirX < 0 ? a.x : -a.x) + (dirY < 0 ? a.y : -a.y);
      const scoreB = (dirX < 0 ? b.x : -b.x) + (dirY < 0 ? b.y : -b.y);
      return scoreA - scoreB;
    });

    for (const part of order) {
      // Constrói R-Tree com todas as demais peças para consulta espacial rápida em O(log N)
      const rtree = new RTree2D(8);
      for (const other of placedParts) {
        if (other.id === part.id) continue;
        rtree.insert({
          minX: other.x - NOMINAL_PART_GAP,
          minY: other.y - NOMINAL_PART_GAP,
          maxX: other.x + other.placedWidth + NOMINAL_PART_GAP,
          maxY: other.y + other.placedHeight + NOMINAL_PART_GAP,
          data: other
        });
      }

      const tryMove = (dx, dy) => {
        part.x = +(part.x + dx).toFixed(2);
        part.y = +(part.y + dy).toFixed(2);

        const inside = isPartInsideSheetIfp(
          part.x, part.y, part.placedWidth, part.placedHeight,
          part.placedPoints, customSheet, params.sheet_margin, params.kerf_width
        );
        if (!inside) {
          part.x = +(part.x - dx).toFixed(2);
          part.y = +(part.y - dy).toFixed(2);
          return false;
        }

        const nearbyCandidates = rtree.search({
          minX: part.x,
          minY: part.y,
          maxX: part.x + part.placedWidth,
          maxY: part.y + part.placedHeight
        });

        const collides = nearbyCandidates.some(o => polygonsCollideTrueShape(part, o, NOMINAL_PART_GAP));
        if (collides) {
          part.x = +(part.x - dx).toFixed(2);
          part.y = +(part.y - dy).toFixed(2);
          return false;
        }
        return true;
      };

      for (const step of [12, 3, 0.5]) {
        let moved = true;
        let guard = 0;
        while (moved && guard < 100) {
          guard++;
          moved = false;
          if (tryMove(dirX * step, 0)) moved = true;
          if (tryMove(0, dirY * step)) moved = true;

          if (!moved) {
            if (tryMove(dirX * step, dirY * step)) moved = true;
            else if (tryMove(dirX * step, -dirY * step * 0.7)) moved = true;
            else if (tryMove(-dirX * step * 0.7, dirY * step)) moved = true;
          }
        }
      }
    }
  }
}

// =========================================================================
// 6. EXTRAÇÃO DE RETALHOS E PÓS-PROCESSAMENTO CAM (LEAD-IN & REGRA INSIDE-OUT)
// =========================================================================

function isRectValidForRemnant(r, placedParts, customSheet) {
  if (
    r.x < EFFECTIVE_BORDER_MARGIN - 0.2 ||
    r.y < EFFECTIVE_BORDER_MARGIN - 0.2 ||
    r.x + r.width > SHEET_W - EFFECTIVE_BORDER_MARGIN + 0.2 ||
    r.y + r.height > SHEET_H - EFFECTIVE_BORDER_MARGIN + 0.2
  ) {
    return false;
  }

  for (const p of placedParts) {
    if (p.nestedInsideHole) continue;
    if (
      r.x < p.x + p.placedWidth + NOMINAL_PART_GAP - 0.1 &&
      r.x + r.width > p.x - 0.1 &&
      r.y < p.y + p.placedHeight + NOMINAL_PART_GAP - 0.1 &&
      r.y + r.height > p.y - 0.1
    ) {
      const boxes = getSolidBoxesForPart(p, NOMINAL_PART_GAP);
      for (const b of boxes) {
        if (r.x < b.x + b.width - 0.1 && r.x + r.width > b.x + 0.1 && r.y < b.y + b.height - 0.1 && r.y + r.height > b.y + 0.1) {
          return false;
        }
      }
    }
  }

  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return true;
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];
  const corners = [
    { x: r.x + 0.5, y: r.y + 0.5 },
    { x: r.x + r.width - 0.5, y: r.y + 0.5 },
    { x: r.x + r.width - 0.5, y: r.y + r.height - 0.5 },
    { x: r.x + 0.5, y: r.y + r.height - 0.5 }
  ];

  for (const c of corners) {
    if (!isPointInPolygon(c, sheetPoly)) return false;
  }
  for (let i = 0; i < 4; i++) {
    const c1 = corners[i], c2 = corners[(i + 1) % 4];
    if (!isPointInPolygon({ x: (c1.x + c2.x) * 0.5, y: (c1.y + c2.y) * 0.5 }, sheetPoly)) return false;
    for (let j = 0; j < sheetPoly.length; j++) {
      if (segmentsIntersectExact(c1, c2, sheetPoly[j], sheetPoly[(j + 1) % sheetPoly.length])) return false;
    }
  }

  for (const obs of obstacles) {
    if (
      r.x + r.width <= obs.minX + 0.5 ||
      obs.maxX <= r.x + 0.5 ||
      r.y + r.height <= obs.minY + 0.5 ||
      obs.maxY <= r.y + 0.5
    ) {
      continue;
    }
    const obsPts = obs.points;
    for (const c of corners) {
      if (isPointInPolygon(c, obsPts)) return false;
    }
    for (const op of obsPts) {
      if (op.x > r.x + 0.5 && op.x < r.x + r.width - 0.5 && op.y > r.y + 0.5 && op.y < r.y + r.height - 0.5) {
        return false;
      }
    }
    for (let i = 0; i < 4; i++) {
      const c1 = corners[i], c2 = corners[(i + 1) % 4];
      if (isPointInPolygon({ x: (c1.x + c2.x) * 0.5, y: (c1.y + c2.y) * 0.5 }, obsPts)) return false;
      for (let j = 0; j < obsPts.length; j++) {
        if (segmentsIntersectExact(c1, c2, obsPts[j], obsPts[(j + 1) % obsPts.length])) return false;
      }
    }
  }

  return true;
}

function expandRectangleToLimits(rect, placedParts, existingRemnants, customSheet) {
  let r = { ...rect };
  const collidesRem = (cand) =>
    existingRemnants.some(rem =>
      cand.x < rem.x + rem.width - 0.1 &&
      cand.x + cand.width > rem.x + 0.1 &&
      cand.y < rem.y + rem.height - 0.1 &&
      cand.y + cand.height > rem.y + 0.1
    );

  for (const step of [20, 5, 1]) {
    while (true) {
      const test = { ...r, width: r.width + step };
      if (!collidesRem(test) && isRectValidForRemnant(test, placedParts, customSheet)) r = test;
      else break;
    }
    while (true) {
      const test = { ...r, height: r.height + step };
      if (!collidesRem(test) && isRectValidForRemnant(test, placedParts, customSheet)) r = test;
      else break;
    }
    while (true) {
      const test = { ...r, x: r.x - step, width: r.width + step };
      if (!collidesRem(test) && isRectValidForRemnant(test, placedParts, customSheet)) r = test;
      else break;
    }
    while (true) {
      const test = { ...r, y: r.y - step, height: r.height + step };
      if (!collidesRem(test) && isRectValidForRemnant(test, placedParts, customSheet)) r = test;
      else break;
    }
  }
  return r;
}

function extractStandardRemnants(placedParts, customSheet, minRemnantSize) {
  let freeRects = BASE_SHEET_FREE_RECTS.map(r => ({ ...r }));

  for (const p of placedParts) {
    if (p.nestedInsideHole) continue;
    const solidBoxes = getSolidBoxesForPart(p, NOMINAL_PART_GAP);
    for (const box of solidBoxes) {
      freeRects = subtractBoxFromFreeRects(freeRects, box);
    }
  }

  if (customSheet && customSheet.isCustomDxf) {
    const cols = 36, rows = 24;
    const cellW = (SHEET_W - EFFECTIVE_BORDER_MARGIN * 2) / cols;
    const cellH = (SHEET_H - EFFECTIVE_BORDER_MARGIN * 2) / rows;
    const heights = new Array(cols).fill(0);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellRect = {
          x: EFFECTIVE_BORDER_MARGIN + c * cellW,
          y: EFFECTIVE_BORDER_MARGIN + r * cellH,
          width: cellW,
          height: cellH
        };
        if (isRectValidForRemnant(cellRect, placedParts, customSheet)) heights[c] += 1;
        else heights[c] = 0;
      }

      for (let cStart = 0; cStart < cols; cStart++) {
        if (heights[cStart] === 0) continue;
        let minH = heights[cStart];
        for (let cEnd = cStart; cEnd < cols; cEnd++) {
          if (heights[cEnd] === 0) break;
          minH = Math.min(minH, heights[cEnd]);
          const rw = (cEnd - cStart + 1) * cellW;
          const rh = minH * cellH;
          if (rw >= minRemnantSize * 0.8 && rh >= minRemnantSize * 0.8) {
            freeRects.push({
              x: EFFECTIVE_BORDER_MARGIN + cStart * cellW,
              y: EFFECTIVE_BORDER_MARGIN + (r - minH + 1) * cellH,
              width: rw,
              height: rh
            });
          }
        }
      }
    }
  }

  const remnants = [];
  while (true) {
    const valid = freeRects.filter(
      r => r.width >= minRemnantSize * 0.85 && r.height >= minRemnantSize * 0.85 && isRectValidForRemnant(r, placedParts, customSheet)
    );
    if (!valid.length) break;
    valid.sort((a, b) => (b.width * b.height) - (a.width * a.height));

    let bestExpanded = null;
    for (let i = 0; i < Math.min(3, valid.length); i++) {
      const exp = expandRectangleToLimits(valid[i], placedParts, remnants, customSheet);
      if (exp.width >= minRemnantSize && exp.height >= minRemnantSize) {
        if (!bestExpanded || (exp.width * exp.height) > (bestExpanded.width * bestExpanded.height)) {
          bestExpanded = exp;
        }
      }
    }

    if (!bestExpanded) {
      freeRects = freeRects.filter(r => r !== valid[0]);
      continue;
    }

    const w = +bestExpanded.width.toFixed(1), h = +bestExpanded.height.toFixed(1);
    const isSq = Math.abs(w - h) <= Math.max(w, h) * 0.12;

    remnants.push({
      id: `RET_${remnants.length + 1}`,
      label: isSq ? `Quadrado #${remnants.length + 1}` : `Retalho #${remnants.length + 1}`,
      x: +bestExpanded.x.toFixed(1),
      y: +bestExpanded.y.toFixed(1),
      width: w,
      height: h,
      area: +(w * h).toFixed(1)
    });

    freeRects = subtractBoxFromFreeRects(freeRects, bestExpanded);
  }
  return remnants;
}

/**
 * Gera ponto de perfuração (Pierce Point + Lead-in) e ordena a sequência de corte Inside-Out.
 */
function attachCamMetadataAndCuttingOrder(allPlacedParts, leadInLen) {
  let stepOrder = 1;

  // Regra Inside-Out (Post-Order Traversal):
  // 1º Peças Filhas In-Hole (e seus furos) -> 2º Peças Mães Principais (furos primeiro, contorno externo por último)
  const inHoleChildren = allPlacedParts.filter(p => p.nestedInsideHole);
  const mainHosts = allPlacedParts.filter(p => !p.nestedInsideHole);

  const computeLeadIn = (part) => {
    const p0 = part.placedPoints[0] || { x: 0, y: 0 };
    const p1 = part.placedPoints[1] || { x: part.placedWidth, y: 0 };
    const entryX = +(part.x + (p0.x + p1.x) * 0.5).toFixed(2);
    const entryY = +(part.y + (p0.y + p1.y) * 0.5).toFixed(2);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dy / len, ny = -dx / len;
    return {
      entryPoint: { x: entryX, y: entryY },
      piercePoint: {
        x: +(entryX + nx * leadInLen).toFixed(2),
        y: +(entryY + ny * leadInLen).toFixed(2)
      },
      leadInLength: leadInLen
    };
  };

  for (const child of inHoleChildren) {
    child.cutSequenceOrder = stepOrder++;
    child.camLeadIn = computeLeadIn(child);
  }
  for (const host of mainHosts) {
    host.cutSequenceOrder = stepOrder++;
    host.camLeadIn = computeLeadIn(host);
  }
}

// =========================================================================
// 7. DECODIFICADOR BLF CONTÍNUO COM CONSULTA NFP + R-TREE
// =========================================================================

function decodeCandidateBLF(orderedParts, heuristic, forcedAngles, gravityDir) {
  const { mainSheetParts, nestedInHolesMap } = executeHoleFilling(orderedParts, params.hole_filling);

  let freeRects = BASE_SHEET_FREE_RECTS.map(r => ({ ...r }));
  const placedParts = [];
  const unplacedParts = [];
  const placedRTree = new RTree2D(8);

  const allowedAngles = resolveAllowedRotations(params.allow_rotation, params.grain_restriction);

  for (const part of mainSheetParts) {
    let bestCand = null;
    let bestScore = Infinity;

    const isSymmetricRect = part.points.length === 4 && Math.abs(part.area - part.bboxArea) < 2;
    let tryAngles = isSymmetricRect
      ? allowedAngles.filter(a => a === 0 || a === 90)
      : allowedAngles;
    if (tryAngles.length === 0) tryAngles = [0];

    if (params.allow_rotation && forcedAngles[part.id] !== undefined) {
      tryAngles = [forcedAngles[part.id], ...tryAngles.filter(a => a !== forcedAngles[part.id])];
    }

    const candidatePositions = [];
    for (const rect of freeRects) {
      candidatePositions.push({ x: rect.x, y: rect.y, rw: rect.width, rh: rect.height, isAnchor: false });
      if (gravityDir === 'BOTTOM_LEFT') {
        candidatePositions.push({ x: rect.x, y: rect.y + rect.height, rw: rect.width, rh: rect.height, isAnchor: true });
      } else if (gravityDir === 'TOP_RIGHT') {
        candidatePositions.push({ x: rect.x + rect.width, y: rect.y, rw: rect.width, rh: rect.height, isAnchor: true });
      }
    }
    for (const anc of SHEET_ANCHORS) {
      candidatePositions.push({ x: anc.x, y: anc.y, rw: SHEET_W, rh: SHEET_H, isAnchor: true, tag: anc.tag });
    }

    for (const ang of tryAngles) {
      const rotData = getRotatedPartGeometry(part, ang);
      const w = rotData.w;
      const h = rotData.h;
      const reqW = w + NOMINAL_PART_GAP;
      const reqH = h + NOMINAL_PART_GAP;

      // Adiciona também vértices exatos da fronteira NFP contra as últimas peças alocadas
      const nfpPositions = [...candidatePositions];
      for (let idxP = Math.max(0, placedParts.length - 4); idxP < placedParts.length; idxP++) {
        const placed = placedParts[idxP];
        const locus = nfpCache.getNfpCandidates(
          placed.basePartId || placed.id, placed.angle || 0, placed.placedPoints, placed.placedWidth, placed.placedHeight,
          part.basePartId || part.id, ang, rotData.pts, w, h, NOMINAL_PART_GAP
        );
        for (const v of locus) {
          nfpPositions.push({
            x: +(placed.x + v.x).toFixed(2),
            y: +(placed.y + v.y).toFixed(2),
            rw: SHEET_W,
            rh: SHEET_H,
            isAnchor: true,
            tag: 'NFP_VERTEX'
          });
        }
      }

      for (const pos of nfpPositions) {
        let px = pos.x;
        let py = pos.y;
        if (pos.isAnchor && gravityDir === 'BOTTOM_LEFT' && !pos.tag) py = Math.max(EFFECTIVE_BORDER_MARGIN, pos.y - h);
        if (pos.isAnchor && gravityDir === 'TOP_RIGHT' && !pos.tag) px = Math.max(EFFECTIVE_BORDER_MARGIN, pos.x - w);

        if (!pos.isAnchor && (pos.rw < reqW || pos.rh < reqH)) continue;

        if (!isPartInsideSheetIfp(px, py, w, h, rotData.pts, sheet, params.sheet_margin, params.kerf_width)) continue;

        const tempPart = {
          id: part.id,
          x: px,
          y: py,
          angle: ang,
          placedWidth: w,
          placedHeight: h,
          area: part.area,
          bboxArea: part.bboxArea,
          points: part.points,
          placedPoints: rotData.pts
        };

        // Broad-phase R-Tree query em O(log N) antes da verificação fina True-Shape
        const nearbyPlaced = placedRTree.search({
          minX: px,
          minY: py,
          maxX: px + w,
          maxY: py + h
        });
        if (nearbyPlaced.some(other => polygonsCollideTrueShape(tempPart, other, NOMINAL_PART_GAP))) continue;

        let score = 0;
        if (heuristic === 'POCKET_AND_SLOPE') {
          score = px * 4 + py * 1.5 - (pos.tag === 'POCKET_TOP_LEFT' ? 5000 : 0);
        } else if (heuristic === 'TOP_ROW') {
          score = (py + h) * 10 + px;
        } else if (heuristic === 'LEFT_COLUMN') {
          score = (px + w) * 10 + py;
        } else if (heuristic === 'BOTTOM_LEFT') {
          score = (SHEET_H - (py + h)) * 8 + px * 2;
        } else {
          score = Math.min(pos.rw - reqW, pos.rh - reqH) * 5 + (px + py);
        }

        if (score < bestScore) {
          bestScore = score;
          bestCand = { x: px, y: py, w, h, reqW, reqH, ang, rotData };
        }
      }
    }

    if (bestCand) {
      const hostPlaced = {
        ...part,
        x: +bestCand.x.toFixed(2),
        y: +bestCand.y.toFixed(2),
        angle: bestCand.ang,
        placedWidth: bestCand.w,
        placedHeight: bestCand.h,
        rotated: bestCand.ang !== 0,
        nestedInsideHole: false,
        placedPoints: bestCand.rotData.pts,
        placedHoles: bestCand.rotData.holes.map(h => ({
          ...h,
          hasChildPartInside: nestedInHolesMap.has(h.id)
        }))
      };
      placedParts.push(hostPlaced);

      placedRTree.insert({
        minX: hostPlaced.x - NOMINAL_PART_GAP,
        minY: hostPlaced.y - NOMINAL_PART_GAP,
        maxX: hostPlaced.x + hostPlaced.placedWidth + NOMINAL_PART_GAP,
        maxY: hostPlaced.y + hostPlaced.placedHeight + NOMINAL_PART_GAP,
        data: hostPlaced
      });

      const solidBoxes = getSolidBoxesForPart(hostPlaced, NOMINAL_PART_GAP);
      for (const sBox of solidBoxes) {
        freeRects = subtractBoxFromFreeRects(freeRects, sBox);
      }
    } else {
      unplacedParts.push(part);
    }
  }

  // Compactação contínua (Jostling) acelerada por R-Tree
  compactLayoutWithRTree(placedParts, sheet, gravityDir);

  // Transforma coordenadas das peças filhas In-Hole sincronizadas com o ângulo da peça mãe
  let inHoleCount = 0;
  const finalAllPlaced = [...placedParts];

  for (const host of placedParts) {
    for (const rotHole of host.placedHoles || []) {
      const children = nestedInHolesMap.get(rotHole.id) || [];
      for (const childSpec of children) {
        const totalChildAngle = ((host.angle || 0) + childSpec.relativeAngle) % 360;
        const childRotData = getRotatedPartGeometry(childSpec.rawPart, totalChildAngle);

        const holeCenterX = (rotHole.rotRelX ?? rotHole.relX) + (rotHole.rotW ?? rotHole.width) * 0.5;
        const holeCenterY = (rotHole.rotRelY ?? rotHole.relY) + (rotHole.rotH ?? rotHole.height) * 0.5;

        const cx = host.x + holeCenterX - childRotData.w * 0.5;
        const cy = host.y + holeCenterY - childRotData.h * 0.5;

        finalAllPlaced.push({
          ...childSpec.rawPart,
          x: +cx.toFixed(2),
          y: +cy.toFixed(2),
          angle: totalChildAngle,
          placedWidth: childRotData.w,
          placedHeight: childRotData.h,
          rotated: totalChildAngle !== 0,
          placedPoints: childRotData.pts,
          placedHoles: childRotData.holes,
          nestedInsideHole: true
        });
        inHoleCount++;
      }
    }
  }

  attachCamMetadataAndCuttingOrder(finalAllPlaced, params.lead_in_length);

  let freeHoleSlugsCount = 0;
  for (const host of placedParts) {
    for (const hole of host.placedHoles || []) {
      if (hole.usableHole && !hole.hasChildPartInside) {
        freeHoleSlugsCount++;
      }
    }
  }

  let maxX = 0, maxY = 0, weightedGravitySum = 0;
  for (const p of placedParts) {
    if (p.x + p.placedWidth + EFFECTIVE_BORDER_MARGIN > maxX) maxX = p.x + p.placedWidth + EFFECTIVE_BORDER_MARGIN;
    if (p.y + p.placedHeight + EFFECTIVE_BORDER_MARGIN > maxY) maxY = p.y + p.placedHeight + EFFECTIVE_BORDER_MARGIN;
    weightedGravitySum += p.area * (p.x + 0.5 * p.y);
  }

  const remnants = extractStandardRemnants(placedParts, sheet, params.min_remnant_size);
  const sheetArea = sheet?.isCustomDxf ? sheet.area : (SHEET_W * SHEET_H);
  const usedArea = finalAllPlaced.reduce((acc, p) => acc + p.area, 0);
  const remnantArea = remnants.reduce((acc, r) => acc + r.area, 0);
  const largestRemnant = remnants.length > 0 ? remnants[0] : { width: 0, height: 0, area: 0 };

  const effectiveConsumed = Math.max(usedArea, sheetArea - remnantArea);
  const compactUtilization = effectiveConsumed > 0 ? +((usedArea / effectiveConsumed) * 100).toFixed(2) : 0;
  const rawUtilization = sheetArea > 0 ? +((usedArea / sheetArea) * 100).toFixed(2) : 0;

  return {
    heuristic,
    gravityMode: gravityDir,
    sheetWidth: SHEET_W,
    sheetHeight: SHEET_H,
    sheetPoly: sheet?.isCustomDxf ? sheet.points : null,
    sheetObstacles: sheet?.isCustomDxf ? (sheet.obstacles || []) : [],
    kerf: +(params.part_clearance + params.kerf_width).toFixed(2),
    kerf_width: params.kerf_width,
    part_clearance: params.part_clearance,
    sheet_margin: params.sheet_margin,
    grain_restriction: params.grain_restriction,
    hole_filling: params.hole_filling,
    commonLine: params.common_line_cutting,
    rawUtilization,
    compactUtilization,
    usedArea: +usedArea.toFixed(2),
    sheetArea: +sheetArea.toFixed(2),
    remnantArea: +remnantArea.toFixed(2),
    largestRemnantArea: largestRemnant.area,
    largestRemnantDim: `${Math.round(largestRemnant.width)}x${Math.round(largestRemnant.height)}mm`,
    boundingBoxArea: +(maxX * maxY).toFixed(1),
    gravityCenterTerm: +(weightedGravitySum / Math.max(1, usedArea)).toFixed(2),
    inHoleCount,
    freeHoleSlugsCount,
    remnants,
    placedParts: finalAllPlaced,
    unplacedParts
  };
}

function compareSolutions(cand, best, goal) {
  if (!best) return 1;
  if (cand.placedParts.length !== best.placedParts.length) {
    return cand.placedParts.length - best.placedParts.length;
  }
  if (Math.abs(cand.usedArea - best.usedArea) > 0.5) {
    return cand.usedArea - best.usedArea;
  }

  if (goal === 'MAX_SINGLE_REMNANT') {
    if (Math.abs(cand.largestRemnantArea - best.largestRemnantArea) > 1) {
      return cand.largestRemnantArea - best.largestRemnantArea;
    }
    return cand.compactUtilization - best.compactUtilization;
  }
  if (goal === 'MIN_BOUNDING_BOX') {
    if (Math.abs(cand.boundingBoxArea - best.boundingBoxArea) > 1) {
      return best.boundingBoxArea - cand.boundingBoxArea;
    }
    return cand.compactUtilization - best.compactUtilization;
  }

  if (Math.abs(cand.compactUtilization - best.compactUtilization) > 0.005) {
    return cand.compactUtilization - best.compactUtilization;
  }
  if (Math.abs(cand.largestRemnantArea - best.largestRemnantArea) > 1) {
    return cand.largestRemnantArea - best.largestRemnantArea;
  }
  if (Math.abs(cand.boundingBoxArea - best.boundingBoxArea) > 1) {
    return best.boundingBoxArea - cand.boundingBoxArea;
  }
  return best.gravityCenterTerm - cand.gravityCenterTerm;
}

// =========================================================================
// 8. META-HEURÍSTICA HÍBRIDA: BRKGA + SIMULATED ANNEALING (METROPOLIS)
// =========================================================================

function runHybridMetaheuristicLoop() {
  const totalIterations = params.total_iterations;
  const startTime = Date.now();
  const rng = createSeededRandom(SHEET_W * 31 + SHEET_H * 17 + params.seed_offset);

  const heuristics = ['POCKET_AND_SLOPE', 'TOP_ROW', 'LEFT_COLUMN', 'BEST_SHORT_SIDE_FIT', 'BOTTOM_LEFT'];
  const gravityDirs = ['TOP_LEFT', 'BOTTOM_LEFT', 'TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_RIGHT'];
  const allowedAngles = resolveAllowedRotations(params.allow_rotation, params.grain_restriction);

  const baseOrders = [
    [...parts].sort((a, b) => b.area - a.area),
    [...parts].sort((a, b) => a.area - b.area),
    [...parts].sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height)),
    [...parts].sort((a, b) => b.height - a.height),
    [...parts].sort((a, b) => b.width - a.width)
  ];

  let bestResult = null;
  let currentSAOrder = [...baseOrders[0]];
  let currentSAAngles = {};
  let currentSAResult = null;
  let temperature = 5.0;
  const coolingAlpha = 0.995;

  let improvements = 0;
  const topArchive = [];
  const N = parts.length;
  let lastProgressSent = Date.now();

  for (let iter = 1; iter <= totalIterations; iter++) {
    const heuristic = heuristics[(iter - 1) % heuristics.length];
    const gravityDir = gravityDirs[(iter - 1) % gravityDirs.length];
    let candidateOrder;
    let forcedAngles = {};

    if (iter <= baseOrders.length * heuristics.length) {
      // Fase 1: Exploração Construtiva Determinística
      candidateOrder = baseOrders[Math.floor((iter - 1) / heuristics.length) % baseOrders.length];
    } else if (iter % 5 === 0) {
      // Fase 2 (BRKGA Mutant / Random-Key Decoding): Vetor de chaves aleatórias contínuas r in [0,1)^2N
      const keyed = parts.map(p => ({ part: p, key: rng() })).sort((a, b) => a.key - b.key);
      candidateOrder = keyed.map(k => k.part);
      for (const p of candidateOrder) {
        const rho = rng();
        forcedAngles[p.id] = allowedAngles[Math.floor(rho * allowedAngles.length)];
      }
    } else {
      // Fase 3 (BRKGA Parameterized Uniform Crossover + Simulated Annealing Neighborhood)
      const baseSource = (rng() < 0.70 && bestResult) ? currentSAOrder : currentSAOrder;
      candidateOrder = [...baseSource];
      forcedAngles = { ...currentSAAngles };

      const swaps = 1 + (iter % 2);
      for (let s = 0; s < swaps && N > 1; s++) {
        const i = Math.floor(rng() * N);
        const j = Math.floor(rng() * N);
        [candidateOrder[i], candidateOrder[j]] = [candidateOrder[j], candidateOrder[i]];
      }
      for (let k = 0; k < N; k++) {
        if (rng() < 0.30) {
          forcedAngles[candidateOrder[k].id] = allowedAngles[Math.floor(rng() * allowedAngles.length)];
        }
      }
    }

    const res = decodeCandidateBLF(candidateOrder, heuristic, forcedAngles, gravityDir);

    // Critério de Aceitação de Metropolis (Simulated Annealing)
    const deltaScore = currentSAResult ? compareSolutions(res, currentSAResult, params.optimization_goal) : 1;
    if (deltaScore >= 0 || Math.exp(deltaScore / Math.max(0.01, temperature)) > rng()) {
      currentSAResult = res;
      currentSAOrder = [...candidateOrder];
      res.placedParts.forEach(p => { if (!p.nestedInsideHole) currentSAAngles[p.id] = p.angle || 0; });
    }
    temperature = Math.max(0.05, temperature * coolingAlpha);

    let isNewRecord = false;
    if (compareSolutions(res, bestResult, params.optimization_goal) > 0) {
      bestResult = res;
      currentSAOrder = [...candidateOrder];
      res.placedParts.forEach(p => { if (!p.nestedInsideHole) currentSAAngles[p.id] = p.angle || 0; });
      improvements++;
      isNewRecord = true;
    }

    if (!topArchive.some(s =>
      Math.abs(s.compactUtilization - res.compactUtilization) < 0.01 &&
      Math.abs(s.largestRemnantArea - res.largestRemnantArea) < 5
    )) {
      topArchive.push(res);
      topArchive.sort((a, b) => compareSolutions(b, a, params.optimization_goal));
      if (topArchive.length > 6) topArchive.pop();
    }

    const now = Date.now();
    if (isNewRecord || now - lastProgressSent >= 85 || iter === totalIterations) {
      lastProgressSent = now;
      const elapsedSec = Math.max(0.001, (now - startTime) / 1000);
      const calcPerSec = Math.round(iter / elapsedSec);

      parentPort.postMessage({
        type: 'progress',
        iter,
        totalIterations,
        calcPerSec,
        improvements,
        isNewRecord,
        bestResult: isNewRecord ? bestResult : undefined
      });
    }
  }

  const totalTimeMs = Date.now() - startTime;
  parentPort.postMessage({
    type: 'done',
    totalIterations,
    totalTimeMs,
    calcPerSec: Math.round(totalIterations / Math.max(0.001, totalTimeMs / 1000)),
    improvements,
    bestResult,
    topArchive
  });
}

runHybridMetaheuristicLoop();