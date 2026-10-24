// nestingWorker.js
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { normalizeNestingParams, resolveAllowedRotations, resolveRelativeRotations } = require('./typesAndInterfaces');
const { RTree2D } = require('./spatialIndex');
const { isPointInPolygon, getBoundingBox } = require('./geometry/primitives');
const { polygonsCollideTrueShape } = require('./engine/collision');
const { computeMaxInscribedCircle } = require('./cadParser');
const { segmentsIntersectExact, pointToSegmentDistSq, NfpCacheManager } = require('./nfpEngine');
const { planCam } = require('./camPlanner');
const { validateLayout } = require('./validator');

const { parts = [], sheet = null, config: rawConfig = {}, stopFlag = null, hardware = {} } = workerData;
// "Parar e manter o melhor": o servidor grava 1 neste SharedArrayBuffer; o laço confere a cada avaliação
// (o laço é síncrono, então mensagens não chegariam até o fim) e encerra finalizando o melhor layout.
const STOP_VIEW = stopFlag ? new Int32Array(stopFlag) : null;
const stopRequested = () => !!STOP_VIEW && Atomics.load(STOP_VIEW, 0) === 1;
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

function slimRotatedHole(h, i, extra) {
  return {
    id: h.id,
    holeIndex: i,
    usableHole: h.usableHole,
    area: h.area,
    max_inscribed_radius: h.max_inscribed_radius,
    ...extra
  };
}

/**
 * Geometria da peça rotada em torno da origem local, normalizada para min = (0,0).
 * offX/offY = deslocamento de normalização (necessário p/ transformar peças filhas junto com a mãe).
 * ATENÇÃO: os furos em cache pertencem à PRIMEIRA cópia a pedir a geometria; os ids por instância
 * devem ser reaplicados com rotHolesForInstance().
 */
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
      offX: 0,
      offY: 0,
      pts: part.points,
      holes: (part.holes || []).map((h, i) => slimRotatedHole(h, i, {
        rotRelX: h.relX, rotRelY: h.relY, rotW: h.width, rotH: h.height, placedPoints: h.points
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

  const rotHoles = (part.holes || []).map((h, i) => {
    const hPts = h.points.map(p => ({
      x: +((p.x * cos - p.y * sin) - minX).toFixed(3),
      y: +((p.x * sin + p.y * cos) - minY).toFixed(3)
    }));
    const hb = getBoundingBox(hPts);
    return slimRotatedHole(h, i, {
      rotRelX: hb.minX, rotRelY: hb.minY, rotW: hb.width, rotH: hb.height, placedPoints: hPts
    });
  });

  const resRot = {
    angle: deg,
    w: +(maxX - minX).toFixed(3),
    h: +(maxY - minY).toFixed(3),
    offX: minX,
    offY: minY,
    pts: normPts,
    holes: rotHoles
  };
  rotatedGeometryCache.set(cacheKey, resRot);
  return resRot;
}

/** Reaplica os ids de furo da INSTÂNCIA (o cache guarda os da primeira cópia). */
function rotHolesForInstance(rotData, part) {
  return rotData.holes.map((h, i) => ({ ...h, id: part.holes && part.holes[i] ? part.holes[i].id : h.id }));
}

// =========================================================================
// 2. VERIFICAÇÃO DE FRONTEIRA INTERNA (IFP) E COLISÃO TRUE-SHAPE EXATA (INT64)
// =========================================================================

function isPartInsideSheetIfp(x, y, w, h, partPts, customSheet, sheetMargin, kerfWidth) {
  const sheetW = customSheet?.isCustomDxf ? customSheet.width : params.sheet_width;
  const sheetH = customSheet?.isCustomDxf ? customSheet.height : params.sheet_height;
  const minBorderDist = sheetMargin + kerfWidth * 0.5;

  if (
    x < minBorderDist - 0.01 ||
    y < minBorderDist - 0.01 ||
    x + w > sheetW - minBorderDist + 0.01 ||
    y + h > sheetH - minBorderDist + 0.01
  ) {
    return false;
  }

  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return true;
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];
  const minGapSq = Math.max(0.05, minBorderDist - 0.01) ** 2;
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

/**
 * Caixas que um RETALHO não pode invadir: material da peça + folga D_nom em TODOS os lados.
 * (Para posicionar peças, getSolidBoxesForPart soma a folga só à direita/acima — correto ali, porque a peça
 * seguinte começa no fim da caixa. Para retalhos isso deixava o retalho encostado na peça pela esquerda/baixo:
 * o corte do retalho passaria pela peça.)
 */
function getRemnantBlockBoxes(placedPart, gap) {
  return getSolidBoxesForPart(placedPart, gap).map(b => ({ x: b.x - gap, y: b.y - gap, width: b.width + gap, height: b.height + gap }));
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
// 4. HOLE FILLING (PART-IN-PART TRUE-SHAPE, COM CACHE DE ENCAIXE POR TIPO DE PEÇA)
// =========================================================================

const ALLOWED_ROTATIONS = resolveAllowedRotations(params.allow_rotation, params.grain_restriction);
// Rotação RELATIVA filha/mãe que mantém o ângulo final dentro do permitido pela fibra
const RELATIVE_ROTATIONS = params.allow_rotation ? resolveRelativeRotations(ALLOWED_ROTATIONS) : [0];

const baseIndexMap = new Map();
for (const p of parts) {
  const b = p.basePartId || p.id;
  if (!baseIndexMap.has(b)) baseIndexMap.set(b, baseIndexMap.size);
  p._bidx = baseIndexMap.get(b);
}

function minDistSqRings(A, B, limitSq) {
  let m = Infinity;
  for (let i = 0; i < A.length; i++) {
    const a = A[i];
    for (let j = 0; j < B.length; j++) {
      const b1 = B[j], b2 = B[(j + 1) % B.length];
      const d = pointToSegmentDistSq(a.x, a.y, b1.x, b1.y, b2.x, b2.y);
      if (d < m) { m = d; if (m < limitSq) return m; }
    }
  }
  for (let j = 0; j < B.length; j++) {
    const b = B[j];
    for (let i = 0; i < A.length; i++) {
      const a1 = A[i], a2 = A[(i + 1) % A.length];
      const d = pointToSegmentDistSq(b.x, b.y, a1.x, a1.y, a2.x, a2.y);
      if (d < m) { m = d; if (m < limitSq) return m; }
    }
  }
  return m;
}

/** A peça (anel A) cabe inteira no furo (anel H) com folga >= margin? Teste de forma REAL, não de caixa. */
function ringFitsInHole(A, H, margin) {
  for (let i = 0; i < A.length; i++) {
    const p = A[i], q = A[(i + 1) % A.length];
    if (!isPointInPolygon(p, H)) return false;
    if (!isPointInPolygon({ x: (p.x + q.x) * 0.5, y: (p.y + q.y) * 0.5 }, H)) return false;
  }
  const limitSq = Math.max(0, margin - 0.01) ** 2;
  if (minDistSqRings(A, H, limitSq) < limitSq) return false;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < H.length; j++) {
      if (segmentsIntersectExact(A[i], A[(i + 1) % A.length], H[j], H[(j + 1) % H.length])) return false;
    }
  }
  return true;
}

const holeFitCache = new Map();

/** Posição (tx,ty) do canto da filha no referencial LOCAL da mãe (ângulo 0), ou null se não couber. */
function getHoleFit(host, hi, child, rel) {
  const key = ((host._bidx * 64 + hi) * 4096 + child._bidx) * 360 + rel;
  if (holeFitCache.has(key)) return holeFitCache.get(key);

  const hole = host.holes[hi];
  const geo = getRotatedPartGeometry(child, rel);
  const margin = params.hole_clearance;
  const hb = hole.bounding_box;
  let fit = null;

  const childR = child.outer_contour?.max_inscribed_radius || 0;
  const holeR = hole.max_inscribed_radius || 0;
  const spanX = (hb.maxX - hb.minX) - geo.w - 2 * margin;
  const spanY = (hb.maxY - hb.minY) - geo.h - 2 * margin;

  if (spanX >= -1e-6 && spanY >= -1e-6 && childR + margin <= holeR + 1.0) {
    const nx = Math.min(40, Math.max(0, Math.ceil(spanX / 0.5)));
    const ny = Math.min(40, Math.max(0, Math.ceil(spanY / 0.5)));
    const cx = hole.inscribed_center ? hole.inscribed_center.x : (hb.minX + hb.maxX) / 2;
    const cy = hole.inscribed_center ? hole.inscribed_center.y : (hb.minY + hb.maxY) / 2;
    const positions = [];
    for (let ix = 0; ix <= nx; ix++) {
      for (let iy = 0; iy <= ny; iy++) {
        const tx = hb.minX + margin + (nx === 0 ? Math.max(0, spanX) / 2 : (spanX * ix) / nx);
        const ty = hb.minY + margin + (ny === 0 ? Math.max(0, spanY) / 2 : (spanY * iy) / ny);
        positions.push({ tx, ty, d: Math.hypot(tx + geo.w / 2 - cx, ty + geo.h / 2 - cy) });
      }
    }
    positions.sort((a, b) => a.d - b.d); // prefere o centro do maior círculo inscrito
    for (const pos of positions) {
      const abs = geo.pts.map(p => ({ x: p.x + pos.tx, y: p.y + pos.ty }));
      if (ringFitsInHole(abs, hole.points, margin)) { fit = { tx: pos.tx, ty: pos.ty }; break; }
    }
  }
  holeFitCache.set(key, fit);
  return fit;
}

function executeHoleFilling(orderedParts, holeFillingEnabled) {
  if (!holeFillingEnabled) {
    return { mainSheetParts: orderedParts, nestedInHolesMap: new Map() };
  }

  const nestedInHolesMap = new Map();
  const allocatedChildIds = new Set();
  const hostIds = new Set();

  for (const hostPart of orderedParts) {
    if (allocatedChildIds.has(hostPart.id) || !hostPart.holes || !hostPart.holes.length) continue;

    hostPart.holes.forEach((hole, hi) => {
      if (!hole.usableHole) return;
      for (const cand of orderedParts) {
        if (cand.id === hostPart.id || allocatedChildIds.has(cand.id) || hostIds.has(cand.id)) continue;
        if (cand.area >= hole.area) continue;

        const rels = (cand.points.length === 4 && Math.abs(cand.area - cand.bboxArea) < 2)
          ? RELATIVE_ROTATIONS.filter(r => r < 180) // retângulo: r e r+180 são idênticos
          : RELATIVE_ROTATIONS;
        let found = null, foundRel = 0;
        for (const rel of rels) {
          found = getHoleFit(hostPart, hi, cand, rel);
          if (found) { foundRel = rel; break; }
        }
        if (!found) continue;

        allocatedChildIds.add(cand.id);
        hostIds.add(hostPart.id);
        nestedInHolesMap.set(hole.id, [{
          rawPart: cand,
          inHoleParentId: hostPart.id,
          inHoleId: hole.id,
          relativeAngle: foundRel,
          tx: found.tx,
          ty: found.ty
        }]);
        break;
      }
    });
  }

  const mainSheetParts = orderedParts.filter(p => !allocatedChildIds.has(p.id));
  return { mainSheetParts, nestedInHolesMap };
}

// =========================================================================
// 5. COMPACTAÇÃO CONTÍNUA (JOSTLING) COM ÍNDICE R-TREE 2D
// =========================================================================

// Folga extra nas consultas de vizinhos à R-tree. As caixas guardadas já somam D_nom, mas com folga ~0 (benchmark de
// strip packing) um erro de ponto flutuante (133,32 + 199,98 = 333,29999999999995 < 333,3) fazia a consulta não
// encontrar uma peça ENCOSTADA, e o teste de colisão nem rodava. O teste de colisão é exato, então vizinhos a mais
// nunca mudam a resposta correta; com as folgas usuais (>= 0,02 mm) os layouts são os mesmos.
const QUERY_PAD = 0.02;

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
          minX: part.x - QUERY_PAD,
          minY: part.y - QUERY_PAD,
          maxX: part.x + part.placedWidth + QUERY_PAD,
          maxY: part.y + part.placedHeight + QUERY_PAD
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

  const EPS = 1e-6; // sem folga: o validador independente confere a distância D_nom do retalho às peças
  for (const p of placedParts) {
    if (p.nestedInsideHole) continue;
    if (
      r.x < p.x + p.placedWidth + NOMINAL_PART_GAP - EPS &&
      r.x + r.width > p.x - NOMINAL_PART_GAP + EPS &&
      r.y < p.y + p.placedHeight + NOMINAL_PART_GAP - EPS &&
      r.y + r.height > p.y - NOMINAL_PART_GAP + EPS
    ) {
      for (const bx of getRemnantBlockBoxes(p, NOMINAL_PART_GAP)) {
        if (r.x < bx.x + bx.width - EPS && r.x + r.width > bx.x + EPS && r.y < bx.y + bx.height - EPS && r.y + r.height > bx.y + EPS) {
          return false;
        }
      }
    }
  }

  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return true;
  }

  // Chapa irregular: o retalho fica dentro do contorno e longe dos furos/defeitos com a mesma margem das peças.
  // Teste exato (segmento × retângulo expandido), sem a "folga" de 0,5 mm para dentro que deixava o retalho
  // atravessar a borda de um furo da chapa.
  const m = EFFECTIVE_BORDER_MARGIN;
  const ex = { x0: r.x - m + EPS, y0: r.y - m + EPS, x1: r.x + r.width + m - EPS, y1: r.y + r.height + m - EPS };
  const sheetPoly = customSheet.points;
  const corners = [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
  for (const c of corners) if (!isPointInPolygon(c, sheetPoly)) return false;
  if (ringTouchesBox(sheetPoly, ex)) return false;
  for (const obs of customSheet.obstacles || []) {
    if (obs.maxX < ex.x0 || obs.minX > ex.x1 || obs.maxY < ex.y0 || obs.minY > ex.y1) continue;
    if (ringTouchesBox(obs.points, ex)) return false;
    if (isPointInPolygon({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, obs.points)) return false;
  }
  return true;
}

/** Algum segmento do anel toca o retângulo alinhado [x0,x1]×[y0,y1]? (recorte de Liang–Barsky) */
function ringTouchesBox(ring, bx) {
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    if (segmentTouchesBox(ring[j].x, ring[j].y, ring[i].x, ring[i].y, bx)) return true;
  }
  return false;
}
function segmentTouchesBox(x1, y1, x2, y2, bx) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
    return true;
  };
  return clip(-dx, x1 - bx.x0) && clip(dx, bx.x1 - x1) && clip(-dy, y1 - bx.y0) && clip(dy, bx.y1 - y1) && t0 <= t1;
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

/** Arredonda o retalho a 0,1 mm PARA DENTRO (nunca invade a folga por arredondamento). */
function roundRemnantInward(b) {
  const x0 = Math.ceil(b.x * 10 - 1e-6) / 10, y0 = Math.ceil(b.y * 10 - 1e-6) / 10;
  const x1 = Math.floor((b.x + b.width) * 10 + 1e-6) / 10, y1 = Math.floor((b.y + b.height) * 10 + 1e-6) / 10;
  return { x: x0, y: y0, width: +(x1 - x0).toFixed(1), height: +(y1 - y0).toFixed(1) };
}

function extractStandardRemnants(placedParts, customSheet, minRemnantSize, opts = {}) {
  let freeRects = BASE_SHEET_FREE_RECTS.map(r => ({ ...r }));

  for (const p of placedParts) {
    if (p.nestedInsideHole) continue;
    for (const box of getRemnantBlockBoxes(p, NOMINAL_PART_GAP)) {
      freeRects = subtractBoxFromFreeRects(freeRects, box);
    }
  }

  // MODO RÁPIDO (proxy de fitness dentro do laço): apenas decomposição em retângulos livres máximos
  // (subtractBoxFromFreeRects), sem varredura de histograma nem expansão passo-a-passo.
  // A varredura fina só roda quando um candidato bate/empata o recorde (upgradeToFull).
  if (opts.fast) {
    let pool = freeRects.filter(r => r.width >= minRemnantSize && r.height >= minRemnantSize);
    const fastOut = [];
    while (pool.length > 0) {
      pool.sort((a, b) => (b.width * b.height) - (a.width * a.height));
      const b = pool[0];
      const rr = roundRemnantInward(b);
      const w = rr.width, h = rr.height;
      const isSq = Math.abs(w - h) <= Math.max(w, h) * 0.12;
      fastOut.push({
        id: `RET_${fastOut.length + 1}`,
        label: isSq ? `Quadrado #${fastOut.length + 1}` : `Retalho #${fastOut.length + 1}`,
        x: rr.x, y: rr.y, width: w, height: h, area: +(w * h).toFixed(1)
      });
      pool = subtractBoxFromFreeRects(pool, b).filter(r => r.width >= minRemnantSize && r.height >= minRemnantSize);
    }
    return fastOut;
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

    const rr = roundRemnantInward(bestExpanded);
    const w = rr.width, h = rr.height;
    const isSq = Math.abs(w - h) <= Math.max(w, h) * 0.12;

    remnants.push({
      id: `RET_${remnants.length + 1}`,
      label: isSq ? `Quadrado #${remnants.length + 1}` : `Retalho #${remnants.length + 1}`,
      x: rr.x,
      y: rr.y,
      width: w,
      height: h,
      area: +(w * h).toFixed(1)
    });

    freeRects = subtractBoxFromFreeRects(freeRects, bestExpanded);
  }
  return remnants;
}

// =========================================================================
// 6. DECODIFICADOR CONSTRUTIVO BLF (COM PART-IN-PART TRUE-SHAPE)
// =========================================================================

function placementScore(heuristic, pos, px, py, w, h, reqW, reqH) {
  if (heuristic === 'POCKET_AND_SLOPE') return px * 4 + py * 1.5 - (pos.tag === 'POCKET_TOP_LEFT' ? 5000 : 0);
  if (heuristic === 'TOP_ROW') return (py + h) * 10 + px;
  if (heuristic === 'LEFT_COLUMN') return (px + w) * 10 + py;
  if (heuristic === 'BOTTOM_LEFT') return (SHEET_H - (py + h)) * 8 + px * 2;
  return Math.min(pos.rw - reqW, pos.rh - reqH) * 5 + (px + py);
}

/**
 * Escolhe a posição de menor pontuação que cabe na chapa e não colide.
 * Equivalente exato à varredura "testa tudo e guarda o menor": os candidatos são pontuados primeiro,
 * ordenados de forma ESTÁVEL (empates mantêm a ordem original, como o `<` estrito da versão anterior) e o
 * primeiro válido vence — sem pagar os testes de colisão dos candidatos que não poderiam ganhar.
 */
function findBestPlacement(part, tryAngles, candidatePositions, placedParts, placedRTree, heuristic, gravityDir) {
  const cands = [];

  for (const ang of tryAngles) {
    const rotData = getRotatedPartGeometry(part, ang);
    const w = rotData.w;
    const h = rotData.h;
    const reqW = w + NOMINAL_PART_GAP;
    const reqH = h + NOMINAL_PART_GAP;

    // Vértices candidatos da fronteira NFP contra as últimas peças alocadas
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
      cands.push({ score: placementScore(heuristic, pos, px, py, w, h, reqW, reqH), px, py, w, h, reqW, reqH, ang, rotData });
    }
  }

  cands.sort((a, b) => a.score - b.score); // Array.prototype.sort é estável (ES2019)

  for (const c of cands) {
    if (!isPartInsideSheetIfp(c.px, c.py, c.w, c.h, c.rotData.pts, sheet, params.sheet_margin, params.kerf_width)) continue;
    const tempPart = {
      id: part.id, x: c.px, y: c.py, angle: c.ang, placedWidth: c.w, placedHeight: c.h,
      area: part.area, bboxArea: part.bboxArea, points: part.points, placedPoints: c.rotData.pts
    };
    const nearbyPlaced = placedRTree.search({ minX: c.px - QUERY_PAD, minY: c.py - QUERY_PAD, maxX: c.px + c.w + QUERY_PAD, maxY: c.py + c.h + QUERY_PAD });
    if (nearbyPlaced.some(other => polygonsCollideTrueShape(tempPart, other, NOMINAL_PART_GAP))) continue;
    return { x: c.px, y: c.py, w: c.w, h: c.h, reqW: c.reqW, reqH: c.reqH, ang: c.ang, rotData: c.rotData };
  }
  return null;
}

/**
 * Posiciona uma filha In-Hole: o polígono é montado no referencial LOCAL da mãe (ângulo 0), na posição
 * (tx,ty) validada pelo encaixe true-shape, e então recebe a MESMA transformação rígida da mãe
 * (rotação + normalização + translação). Assim filha e mãe giram sempre juntas, em qualquer ângulo.
 */
function placeChildInHost(host, spec) {
  const hostAngle = host.angle || 0;
  const hostGeo = getRotatedPartGeometry(host, hostAngle);
  const childRel = getRotatedPartGeometry(spec.rawPart, spec.relativeAngle);
  const rad = (hostAngle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const toHostFrame = (p) => {
    const lx = p.x + spec.tx, ly = p.y + spec.ty;
    return { x: lx * cos - ly * sin - hostGeo.offX, y: lx * sin + ly * cos - hostGeo.offY };
  };

  const outerH = childRel.pts.map(toHostFrame);
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  for (const p of outerH) {
    if (p.x < mnX) mnX = p.x; if (p.y < mnY) mnY = p.y;
    if (p.x > mxX) mxX = p.x; if (p.y > mxY) mxY = p.y;
  }
  const localize = (p) => ({ x: +(p.x - mnX).toFixed(3), y: +(p.y - mnY).toFixed(3) });
  const total = (hostAngle + spec.relativeAngle) % 360;

  return {
    ...spec.rawPart,
    x: +(host.x + mnX).toFixed(3),
    y: +(host.y + mnY).toFixed(3),
    angle: total,
    placedWidth: +(mxX - mnX).toFixed(3),
    placedHeight: +(mxY - mnY).toFixed(3),
    rotated: total !== 0,
    placedPoints: outerH.map(localize),
    placedHoles: rotHolesForInstance(childRel, spec.rawPart).map(h => ({
      ...h,
      hasChildPartInside: false,
      placedPoints: h.placedPoints.map(toHostFrame).map(localize)
    })),
    nestedInsideHole: true,
    inHoleParentId: spec.inHoleParentId,
    inHoleId: spec.inHoleId
  };
}

function applyRemnantMetrics(res, remnants) {
  const largest = remnants.length > 0 ? remnants[0] : { width: 0, height: 0, area: 0 };
  const remnantArea = remnants.reduce((acc, r) => acc + r.area, 0);
  const effectiveConsumed = Math.max(res.usedArea, res.sheetArea - remnantArea);
  res.remnants = remnants;
  res.remnantArea = +remnantArea.toFixed(2);
  res.largestRemnantArea = largest.area;
  res.largestRemnantDim = `${Math.round(largest.width)}x${Math.round(largest.height)}mm`;
  res.compactUtilization = effectiveConsumed > 0 ? +((res.usedArea / effectiveConsumed) * 100).toFixed(2) : 0;
}

const metricsOf = (res) => res._fastSnap || res;

/** Varredura fina de retalhos (histograma + expansão): só para candidatos que batem o recorde. */
function upgradeToFull(res) {
  if (res.metricsFull) return res;
  res._fastSnap = {
    placedParts: res.placedParts, usedArea: res.usedArea, compactUtilization: res.compactUtilization,
    largestRemnantArea: res.largestRemnantArea, boundingBoxArea: res.boundingBoxArea,
    gravityCenterTerm: res.gravityCenterTerm, remnantArea: res.remnantArea, stripLength: res.stripLength
  };
  const hosts = res.placedParts.filter(p => !p.nestedInsideHole);
  applyRemnantMetrics(res, extractStandardRemnants(hosts, sheet, params.min_remnant_size, { fast: false }));
  res.metricsFull = true;
  return res;
}

function decodeCandidateBLF(orderedParts, heuristic, forcedAngles, gravityDir) {
  const { mainSheetParts, nestedInHolesMap } = executeHoleFilling(orderedParts, params.hole_filling);

  let freeRects = BASE_SHEET_FREE_RECTS.map(r => ({ ...r }));
  const placedParts = [];
  const unplacedParts = [];
  const placedRTree = new RTree2D(8);

  for (const part of mainSheetParts) {
    const isSymmetricRect = part.points.length === 4 && Math.abs(part.area - part.bboxArea) < 2;
    let tryAngles = isSymmetricRect
      ? ALLOWED_ROTATIONS.filter(a => a === 0 || a === 90)
      : ALLOWED_ROTATIONS;
    if (tryAngles.length === 0) tryAngles = [0];

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

    // O gene de rotação é RESTRITIVO: tenta primeiro só o ângulo sorteado; se não couber, libera todos.
    let bestCand = null;
    const forced = params.allow_rotation ? forcedAngles[part.id] : undefined;
    if (forced !== undefined && tryAngles.includes(forced)) {
      bestCand = findBestPlacement(part, [forced], candidatePositions, placedParts, placedRTree, heuristic, gravityDir);
    }
    if (!bestCand) {
      bestCand = findBestPlacement(part, tryAngles, candidatePositions, placedParts, placedRTree, heuristic, gravityDir);
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
        placedHoles: rotHolesForInstance(bestCand.rotData, part).map(h => ({
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

      for (const sBox of getSolidBoxesForPart(hostPlaced, NOMINAL_PART_GAP)) {
        freeRects = subtractBoxFromFreeRects(freeRects, sBox);
      }
    } else {
      unplacedParts.push(part);
    }
  }

  // Compactação contínua (Jostling) acelerada por R-Tree
  compactLayoutWithRTree(placedParts, sheet, gravityDir);

  return assembleResult(placedParts, nestedInHolesMap, unplacedParts, heuristic, gravityDir);
}

/**
 * Monta o resultado a partir das mães já posicionadas: filhas In-Hole (mesma transformação da mãe), métricas e
 * retalhos. Usado pelo decodificador BLF e pelo otimizador externo (engine/sparrowBridge, ADR 006).
 */
function assembleResult(placedParts, nestedInHolesMap, unplacedParts, heuristic, gravityDir) {
  // Filhas In-Hole: transformadas junto com a mãe. Filhas de mães NÃO alocadas vão para as não-alocadas
  // (antes sumiam silenciosamente do layout e da contagem).
  let inHoleCount = 0;
  const finalAllPlaced = [...placedParts];
  const placedHostIds = new Set(placedParts.map(p => p.id));

  for (const host of placedParts) {
    for (const rotHole of host.placedHoles || []) {
      for (const spec of nestedInHolesMap.get(rotHole.id) || []) {
        finalAllPlaced.push(placeChildInHost(host, spec));
        inHoleCount++;
      }
    }
  }
  for (const kids of nestedInHolesMap.values()) {
    for (const spec of kids) {
      if (!placedHostIds.has(spec.inHoleParentId)) unplacedParts.push(spec.rawPart);
    }
  }

  let freeHoleSlugsCount = 0;
  for (const host of placedParts) {
    for (const hole of host.placedHoles || []) {
      if (hole.usableHole && !hole.hasChildPartInside) freeHoleSlugsCount++;
    }
  }

  let maxX = 0, maxY = 0, weightedGravitySum = 0;
  for (const p of placedParts) {
    if (p.x + p.placedWidth + EFFECTIVE_BORDER_MARGIN > maxX) maxX = p.x + p.placedWidth + EFFECTIVE_BORDER_MARGIN;
    if (p.y + p.placedHeight + EFFECTIVE_BORDER_MARGIN > maxY) maxY = p.y + p.placedHeight + EFFECTIVE_BORDER_MARGIN;
    weightedGravitySum += p.area * (p.x + 0.5 * p.y);
  }

  const sheetArea = sheet?.isCustomDxf ? sheet.area : (SHEET_W * SHEET_H);
  // Área LÍQUIDA (contorno menos furos) — antes a mãe contava o furo como "material aproveitado"
  const usedArea = finalAllPlaced.reduce((acc, p) => acc + (p.netArea ?? p.area), 0);
  const rawUtilization = sheetArea > 0 ? +((usedArea / sheetArea) * 100).toFixed(2) : 0;

  const res = {
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
    hole_clearance: params.hole_clearance,
    grain_restriction: params.grain_restriction,
    hole_filling: params.hole_filling,
    commonLine: params.common_line_cutting,
    rawUtilization,
    usedArea: +usedArea.toFixed(2),
    sheetArea: +sheetArea.toFixed(2),
    boundingBoxArea: +(maxX * maxY).toFixed(1),
    // comprimento usado da faixa (objetivo MIN_STRIP_LENGTH): maior X ocupado por peça, sem margem
    stripLength: +placedParts.reduce((m, p) => Math.max(m, p.x + p.placedWidth), 0).toFixed(4),
    gravityCenterTerm: +(weightedGravitySum / Math.max(1, usedArea)).toFixed(2),
    inHoleCount,
    freeHoleSlugsCount,
    placedParts: finalAllPlaced,
    unplacedParts,
    metricsFull: false
  };
  const hostsOnly = placedParts; // retalhos consideram só as mães
  const precise = params.evaluation_mode === 'PRECISE';
  applyRemnantMetrics(res, extractStandardRemnants(hostsOnly, sheet, params.min_remnant_size, { fast: !precise }));
  res.metricsFull = precise;
  return res;
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
  if (goal === 'MIN_STRIP_LENGTH') {
    // strip packing (benchmark público): altura fixa, minimizar o comprimento usado
    if (Math.abs(cand.stripLength - best.stripLength) > 1e-6 * SHEET_W) return best.stripLength - cand.stripLength;
    return best.gravityCenterTerm - cand.gravityCenterTerm;
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

/** Escalar normalizado (em "pontos percentuais") para o critério de Metropolis. */
function scalarFitness(res) {
  const m = metricsOf(res);
  const base = res.placedParts.length * 100;
  const sa = Math.max(1, res.sheetArea);
  if (params.optimization_goal === 'MAX_SINGLE_REMNANT') {
    return base + (m.largestRemnantArea / sa) * 100 + m.compactUtilization * 0.01;
  }
  if (params.optimization_goal === 'MIN_STRIP_LENGTH') {
    return base + (1 - m.stripLength / Math.max(1, SHEET_W)) * 100;
  }
  if (params.optimization_goal === 'MIN_BOUNDING_BOX') {
    return base - (m.boundingBoxArea / Math.max(1, SHEET_W * SHEET_H)) * 100 + m.compactUtilization * 0.01;
  }
  return base + m.compactUtilization + (m.largestRemnantArea / sa) * 0.5;
}

// =========================================================================
// 7. SERIALIZAÇÃO ENXUTA (só o que o cliente/exportador precisam)
// =========================================================================

function slimPart(p) {
  return {
    id: p.id, name: p.name, basePartId: p.basePartId, x: p.x, y: p.y, angle: p.angle || 0,
    placedWidth: p.placedWidth, placedHeight: p.placedHeight, area: p.area, netArea: p.netArea ?? p.area,
    nestedInsideHole: !!p.nestedInsideHole, inHoleParentId: p.inHoleParentId, inHoleId: p.inHoleId,
    cutSequenceOrder: p.cutSequenceOrder || 0, placedPoints: p.placedPoints,
    placedHoles: (p.placedHoles || []).map(h => ({
      id: h.id, usableHole: h.usableHole, hasChildPartInside: !!h.hasChildPartInside, placedPoints: h.placedPoints
    }))
  };
}

function slimResult(res) {
  const out = {};
  for (const k of Object.keys(res)) {
    if (k.startsWith('_') || k === 'placedParts' || k === 'unplacedParts') continue;
    out[k] = res[k];
  }
  out.placedParts = res.placedParts.map(slimPart);
  out.unplacedParts = res.unplacedParts.map(p => ({ id: p.id, name: p.name, width: p.width, height: p.height, area: p.area }));
  return out;
}

// =========================================================================
// 8. META-HEURÍSTICA HÍBRIDA: BRKGA (POPULAÇÃO ELITE + CROSSOVER) + SA (METROPOLIS)
// =========================================================================

function thinAngleGenes(genes, rng) {
  const s = params.angle_gene_strictness;
  if (s >= 1) return genes;
  const out = {};
  for (const k of Object.keys(genes)) if (rng() < s) out[k] = genes[k];
  return out;
}

function runHybridMetaheuristicLoop(engineNote = null) {
  const totalIterations = params.total_iterations;
  const startTime = Date.now();
  const rng = createSeededRandom(SHEET_W * 31 + SHEET_H * 17 + params.seed_offset);
  const goal = params.optimization_goal;

  const heuristics = ['POCKET_AND_SLOPE', 'TOP_ROW', 'LEFT_COLUMN', 'BEST_SHORT_SIDE_FIT', 'BOTTOM_LEFT'];
  const gravityDirs = ['TOP_LEFT', 'BOTTOM_LEFT', 'TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_RIGHT'];
  const allowedAngles = ALLOWED_ROTATIONS;

  const baseOrders = [
    [...parts].sort((a, b) => b.area - a.area),
    [...parts].sort((a, b) => a.area - b.area),
    [...parts].sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height)),
    [...parts].sort((a, b) => b.height - a.height),
    [...parts].sort((a, b) => b.width - a.width)
  ];

  const anglesOf = (res) => {
    const m = {};
    res.placedParts.forEach(p => { if (!p.nestedInsideHole) m[p.id] = p.angle || 0; });
    return m;
  };

  // BRKGA: cruzamento uniforme parametrizado sobre chaves (posição normalizada na sequência)
  const crossover = (elite, cur) => {
    const N = cur.order.length;
    const posE = new Map(elite.order.map((p, i) => [p.id, i / Math.max(1, N)]));
    const posC = new Map(cur.order.map((p, i) => [p.id, i / Math.max(1, N)]));
    const keyed = cur.order.map(p => ({
      p, key: (rng() < 0.7 ? posE.get(p.id) : posC.get(p.id)) + rng() * 1e-6
    })).sort((a, b) => a.key - b.key);
    const angles = {};
    for (const p of cur.order) {
      const ea = elite.angles[p.id], ca = cur.angles[p.id];
      const pick = rng() < 0.7 ? ea : ca;
      if (pick !== undefined) angles[p.id] = pick;
    }
    return { order: keyed.map(k => k.p), angles };
  };

  let bestResult = null;
  let currentSAOrder = [...baseOrders[0]];
  let currentSAAngles = {};
  let currentSAResult = null;
  let currentFit = -Infinity;
  let temperature = 1.5; // pontos percentuais
  const coolingAlpha = Math.pow(0.02 / 1.5, 1 / Math.max(1, totalIterations));

  let improvements = 0;
  const topArchive = [];
  const elite = [];
  const N = parts.length;
  let lastProgressSent = Date.now();
  const timeLimitMs = params.time_limit_s > 0 ? params.time_limit_s * 1000 : 0;
  let executed = 0;
  let stoppedByUser = false;

  for (let iter = 1; iter <= totalIterations; iter++) {
    executed = iter;
    const heuristic = heuristics[(iter - 1) % heuristics.length];
    const gravityDir = gravityDirs[(iter - 1) % gravityDirs.length];
    let candidateOrder;
    let forcedAngles = {};

    if (iter <= baseOrders.length * heuristics.length) {
      candidateOrder = baseOrders[Math.floor((iter - 1) / heuristics.length) % baseOrders.length];
    } else if (iter % 5 === 0) {
      // BRKGA mutante: vetor de chaves aleatórias r in [0,1)^2N
      const keyed = parts.map(p => ({ part: p, key: rng() })).sort((a, b) => a.key - b.key);
      candidateOrder = keyed.map(k => k.part);
      for (const p of candidateOrder) {
        forcedAngles[p.id] = allowedAngles[Math.floor(rng() * allowedAngles.length)];
      }
      forcedAngles = thinAngleGenes(forcedAngles, rng);
    } else {
      // Pai elite (70%) cruzado com a solução corrente, ou vizinhança SA da corrente
      const cur = { order: currentSAOrder, angles: currentSAAngles };
      let base;
      if (elite.length > 0 && rng() < 0.7) {
        const e = elite[Math.floor(rng() * elite.length)];
        base = rng() < 0.5 ? crossover(e, cur) : { order: [...e.order], angles: { ...e.angles } };
      } else {
        base = { order: [...cur.order], angles: { ...cur.angles } };
      }
      candidateOrder = base.order;
      forcedAngles = thinAngleGenes(base.angles, rng);

      const swaps = 1 + (iter % 2);
      for (let s = 0; s < swaps && N > 1; s++) {
        const i = Math.floor(rng() * N);
        let j = Math.floor(rng() * N);
        // trocar cópias idênticas não muda o layout: busca um tipo diferente
        for (let t = 0; t < 4 && candidateOrder[i]._bidx === candidateOrder[j]._bidx; t++) j = Math.floor(rng() * N);
        [candidateOrder[i], candidateOrder[j]] = [candidateOrder[j], candidateOrder[i]];
      }
      for (let k = 0; k < N; k++) {
        if (rng() < 0.2) forcedAngles[candidateOrder[k].id] = allowedAngles[Math.floor(rng() * allowedAngles.length)];
      }
    }

    const res = decodeCandidateBLF(candidateOrder, heuristic, forcedAngles, gravityDir);
    res._order = candidateOrder;
    res._angles = anglesOf(res);

    // Metropolis com ΔE normalizado (a versão anterior comparava mm² com T≈5: nunca aceitava piora)
    const fit = scalarFitness(res);
    const dE = fit - currentFit;
    if (!currentSAResult || dE >= 0 || Math.exp(dE / Math.max(1e-6, temperature)) > rng()) {
      currentSAResult = res;
      currentFit = fit;
      currentSAOrder = [...candidateOrder];
      currentSAAngles = { ...res._angles };
    }
    temperature = Math.max(0.02, temperature * coolingAlpha);

    // Recorde: pontua com a métrica rápida; só os promissores pagam a varredura fina de retalhos
    let isNewRecord = false;
    const cmpFast = compareSolutions(res, bestResult ? metricsOf(bestResult) : null, goal);
    if (cmpFast > 0 || (cmpFast === 0 && rng() < 0.05)) {
      upgradeToFull(res);
      if (compareSolutions(res, bestResult, goal) > 0) {
        bestResult = res;
        currentSAOrder = [...candidateOrder];
        currentSAAngles = { ...res._angles };
        improvements++;
        isNewRecord = true;
        planCam(res, params);
      }
    }

    const m = metricsOf(res);
    if (!topArchive.some(s => {
      const sm = metricsOf(s);
      return Math.abs(sm.compactUtilization - m.compactUtilization) < 0.01 &&
             Math.abs(sm.largestRemnantArea - m.largestRemnantArea) < 5;
    })) {
      topArchive.push(res);
      topArchive.sort((a, b) => compareSolutions(metricsOf(b), metricsOf(a), goal));
      if (topArchive.length > 6) topArchive.pop();
      elite.length = 0;
      topArchive.forEach(r => elite.push({ order: r._order, angles: r._angles }));
    }

    const now = Date.now();
    const userStop = stopRequested();
    if (userStop) stoppedByUser = true;
    const outOfTime = (timeLimitMs > 0 && now - startTime >= timeLimitMs) || userStop;
    if (isNewRecord || now - lastProgressSent >= 85 || iter === totalIterations || outOfTime) {
      lastProgressSent = now;
      const elapsedSec = Math.max(0.001, (now - startTime) / 1000);
      parentPort.postMessage({
        type: 'progress',
        iter,
        totalIterations,
        fraction: Math.min(1, Math.max(iter / totalIterations, timeLimitMs ? (now - startTime) / timeLimitMs : 0)),
        calcPerSec: Math.round(iter / elapsedSec),
        improvements,
        isNewRecord,
        bestResult: isNewRecord ? slimResult(bestResult) : undefined
      });
    }
    if (outOfTime) break;
  }

  // Finalização: retalhos finos + plano CAM + validação independente de cada solução enviada
  const expectedIds = parts.map(p => p.id);
  const finalize = (res) => {
    upgradeToFull(res);
    planCam(res, params);
    res.validation = validateLayout(res, params, { expectedIds, allowedRotations: ALLOWED_ROTATIONS });
    return res;
  };

  if (bestResult) finalize(bestResult);
  const finals = [];
  for (const r of topArchive) {
    if (r !== bestResult) finalize(r);
    finals.push(r);
  }
  if (bestResult && !finals.includes(bestResult)) finals.unshift(bestResult);
  finals.sort((a, b) => compareSolutions(b, a, goal));

  const totalTimeMs = Date.now() - startTime;
  parentPort.postMessage({
    type: 'done',
    totalIterations: executed,
    plannedIterations: totalIterations,
    stoppedByTimeLimit: executed < totalIterations && !stoppedByUser,
    stoppedByUser,
    totalTimeMs,
    calcPerSec: Math.round(executed / Math.max(0.001, totalTimeMs / 1000)),
    improvements,
    bestResult: bestResult ? slimResult(bestResult) : null,
    topArchive: finals.map(slimResult),
    engine: 'CLASSICO',
    engineNote
  });
}

// =========================================================================
// 8. OTIMIZADOR EXTERNO prumo-sparrow (ADR 006)
// =========================================================================
// O sparrow (minimização de sobreposição + compressão da faixa) posiciona as MÃES pelo contorno externo inflado;
// filhas In-Hole, métricas, retalhos, CAM e validação são os mesmos do motor clássico (assembleResult/finalize).
// Qualquer coisa fora do que ele resolve (chapa desenhada, lote que não cabe, layout reprovado) volta para o clássico.

const sparrowBridge = require('./engine/sparrowBridge');

function polygonPerimeter(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += Math.hypot(b.x - a.x, b.y - a.y); }
  return s;
}

/** Motivo para NÃO usar o otimizador externo neste job (null = usar). */
function sparrowNotApplicable() {
  if (params.engine === 'CLASSICO') return null; // escolha explícita: nada a avisar
  if (!sparrowBridge.findSparrowBinary()) return 'otimizador externo (prumo-sparrow) não instalado neste servidor';
  if (sheet?.isCustomDxf) return 'chapa desenhada (contorno irregular ou com furos) ainda usa o motor clássico';
  if (!parts.length) return 'sem peças';
  const b = EFFECTIVE_BORDER_MARGIN, g = NOMINAL_PART_GAP / 2 + sparrowBridge.SAFETY;
  const H = SHEET_H - 2 * b, W = SHEET_W - 2 * b;
  if (H <= 0 || W <= 0) return 'margem maior que a chapa';
  // área inflada (contorno + faixa de meia folga) maior que a chapa útil: não cabe tudo numa chapa
  const need = parts.reduce((s, p) => s + p.area + polygonPerimeter(p.points) * g + Math.PI * g * g, 0);
  if (need > (W + 2 * g) * (H + 2 * g)) return 'as peças não cabem numa chapa (área); o motor clássico posiciona o máximo possível';
  return null;
}

const snapAngle = (a) => {
  let best = ALLOWED_ROTATIONS[0], d = Infinity;
  for (const r of ALLOWED_ROTATIONS) {
    const diff = Math.abs(((((a - r) % 360) + 540) % 360) - 180);
    if (diff < d) { d = diff; best = r; }
  }
  return best;
};

async function runSparrowEngine() {
  const startTime = Date.now();
  const goal = params.optimization_goal;
  const ordered = [...parts].sort((a, b) => b.area - a.area);
  const { mainSheetParts, nestedInHolesMap } = executeHoleFilling(ordered, params.hole_filling);

  // um item do otimizador por TIPO de mãe (as cópias viram demanda); contorno no referencial da peça (ângulo 0)
  const typeOf = new Map(), types = [];
  for (const p of mainSheetParts) {
    const key = p.basePartId || p.id;
    if (!typeOf.has(key)) { typeOf.set(key, types.length); types.push({ points: p.points, demand: 0, instances: [] }); }
    const t = types[typeOf.get(key)];
    t.demand++; t.instances.push(p);
  }
  const b = EFFECTIVE_BORDER_MARGIN;
  const { instance, inflate } = sparrowBridge.buildInstance(types, {
    stripHeight: SHEET_H - 2 * b, gap: NOMINAL_PART_GAP, allowedAngles: ALLOWED_ROTATIONS, name: 'prumo'
  });
  const maxStrip = SHEET_W - 2 * b + 2 * inflate + 1e-6;
  const off = b - inflate;

  const toResult = (sol) => {
    const used = new Map();
    const placed = sol.layout.placed_items.map((pi) => {
      const t = types[pi.item_id];
      const k = used.get(pi.item_id) || 0; used.set(pi.item_id, k + 1);
      const part = t.instances[k];
      const ang = snapAngle(pi.transformation.rotation);
      const rot = getRotatedPartGeometry(part, ang);
      const [tx, ty] = pi.transformation.translation;
      return {
        ...part,
        x: +(rot.offX + tx + off).toFixed(3),
        y: +(rot.offY + ty + off).toFixed(3),
        angle: ang,
        placedWidth: rot.w,
        placedHeight: rot.h,
        rotated: ang !== 0,
        nestedInsideHole: false,
        placedPoints: rot.pts,
        placedHoles: rotHolesForInstance(rot, part).map(h => ({ ...h, hasChildPartInside: nestedInHolesMap.has(h.id) }))
      };
    });
    const res = assembleResult(placed, nestedInHolesMap, [], 'SPARROW', 'TOP_LEFT');
    res.engine = 'SPARROW';
    res.sparrowStripWidth = sol.strip_width;
    return res;
  };

  const expectedIds = parts.map(p => p.id);
  const finalize = (res) => {
    upgradeToFull(res);
    planCam(res, params);
    res.validation = validateLayout(res, params, { expectedIds, allowedRotations: ALLOWED_ROTATIONS });
    return res;
  };

  const timeS = params.time_limit_s > 0 ? params.time_limit_s : params.external_time_s;
  const workers = Math.max(1, Math.floor((hardware.totalCores || 2) / Math.max(1, hardware.maxWorkers || 1)));
  const fitting = []; // soluções que cabem na chapa, na ordem em que chegaram (cada uma melhor que a anterior)
  let improvements = 0, lastSent = 0, stoppedByUser = false;
  const run = sparrowBridge.runSparrow(instance, {
    timeS, seed: params.seed_offset, workers,
    onSolution: (sol) => {
      if (sol.strip_width > maxStrip) return;
      if (fitting.length && sol.strip_width >= fitting[fitting.length - 1].strip_width) return;
      fitting.push(sol);
      improvements++;
      const now = Date.now();
      if (now - lastSent < 400) return;
      lastSent = now;
      const res = toResult(sol);
      upgradeToFull(res);
      planCam(res, params);
      parentPort.postMessage({
        type: 'progress', engine: 'SPARROW', iter: improvements, totalIterations: improvements,
        fraction: Math.min(1, (now - startTime) / (timeS * 1000)), calcPerSec: 0, improvements, isNewRecord: true,
        bestResult: slimResult(res)
      });
    }
  });
  const poll = setInterval(() => {
    if (stopRequested() && !stoppedByUser) { stoppedByUser = true; run.stop(); }
    parentPort.postMessage({ type: 'progress', engine: 'SPARROW', iter: improvements, totalIterations: Math.max(1, improvements), fraction: Math.min(1, (Date.now() - startTime) / (timeS * 1000)), calcPerSec: 0, improvements, isNewRecord: false });
  }, 250);
  let failure = null;
  try { await run.promise; } catch (e) { failure = e.message; }
  clearInterval(poll);

  // as últimas soluções (as melhores) viram o arquivo de alternativas; só entram as aprovadas pelo validador
  const finals = [];
  for (const sol of fitting.slice(-6).reverse()) {
    const res = finalize(toResult(sol));
    if (res.validation.ok) finals.push(res);
  }
  finals.sort((a, c) => compareSolutions(c, a, goal));

  if (!finals.length) {
    const why = failure ? `otimizador externo falhou (${failure})`
      : fitting.length ? 'nenhuma solução do otimizador externo passou no validador'
        : 'o otimizador externo não conseguiu pôr todas as peças numa chapa';
    return runHybridMetaheuristicLoop(`${why}; resultado do motor clássico`);
  }
  const best = finals[0];
  const totalTimeMs = Date.now() - startTime;
  parentPort.postMessage({
    type: 'done',
    engine: 'SPARROW',
    engineNote: null,
    totalIterations: improvements,
    plannedIterations: improvements,
    stoppedByTimeLimit: !stoppedByUser,
    stoppedByUser,
    totalTimeMs,
    calcPerSec: 0,
    improvements,
    bestResult: slimResult(best),
    topArchive: finals.map(slimResult)
  });
}

const notApplicable = params.engine === 'CLASSICO' ? 'n/a' : sparrowNotApplicable();
if (notApplicable === null) {
  runSparrowEngine().catch(e => parentPort.postMessage({ type: 'error', error: `otimizador externo: ${e.message}` }));
} else {
  runHybridMetaheuristicLoop(params.engine === 'CLASSICO' ? null : notApplicable);
}
