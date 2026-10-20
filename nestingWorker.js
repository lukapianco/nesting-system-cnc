// nestingWorker.js
const { parentPort, workerData } = require('worker_threads');

const { parts, sheet, config } = workerData;

function createSeededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// =========================================================================
// 1. GEOMETRIA VETORIAL EXATA E ROTAÇÃO MULTIDIRECIONAL (0°, 90°, 180°, 270°, 45°)
// =========================================================================

function isPointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function pointToSegmentDistSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (px - x1) ** 2 + (py - y1) ** 2;
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return (px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2;
}

function segmentsIntersect(a1, a2, b1, b2) {
  const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
  return (ccw(a1, b1, b2) !== ccw(a2, b1, b2)) && (ccw(a1, a2, b1) !== ccw(a1, a2, b2));
}

// Rotaciona um conjunto de pontos em qualquer ângulo (em graus) e normaliza para (0,0)
function rotateAndNormalizePart(part, angleDeg) {
  const deg = ((angleDeg % 360) + 360) % 360;
  if (deg === 0) {
    return {
      angle: 0,
      w: part.width,
      h: part.height,
      pts: part.points,
      holes: (part.holes || []).map(h => ({ ...h, placedPoints: h.points }))
    };
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
    x: +(p.x - minX).toFixed(2),
    y: +(p.y - minY).toFixed(2)
  }));

  const rotHoles = (part.holes || []).map(h => {
    const hPts = h.points.map(p => ({
      x: +((p.x * cos - p.y * sin) - minX).toFixed(2),
      y: +((p.x * sin + p.y * cos) - minY).toFixed(2)
    }));
    let hMinX = Infinity, hMinY = Infinity, hMaxX = -Infinity, hMaxY = -Infinity;
    for (const hp of hPts) {
      if (hp.x < hMinX) hMinX = hp.x;
      if (hp.y < hMinY) hMinY = hp.y;
      if (hp.x > hMaxX) hMaxX = hp.x;
      if (hp.y > hMaxY) hMaxY = hp.y;
    }
    return {
      ...h,
      rotRelX: +hMinX.toFixed(2),
      rotRelY: +hMinY.toFixed(2),
      rotW: +(hMaxX - hMinX).toFixed(2),
      rotH: +(hMaxY - hMinY).toFixed(2),
      placedPoints: hPts
    };
  });

  return {
    angle: deg,
    w: +(maxX - minX).toFixed(2),
    h: +(maxY - minY).toFixed(2),
    pts: normPts,
    holes: rotHoles,
    minXOffset: minX,
    minYOffset: minY
  };
}

// Valida se a peça respeita o contorno externo da chapa E todos os furos/obstáculos internos (sheet.obstacles)
function isPartInsideCustomSheet(x, y, w, h, partPts, customSheet, kerf) {
  const sheetW = customSheet?.isCustomDxf ? customSheet.width : Number(config.sheetWidth);
  const sheetH = customSheet?.isCustomDxf ? customSheet.height : Number(config.sheetHeight);

  if (x < kerf - 0.1 || y < kerf - 0.1 || x + w > sheetW - kerf + 0.1 || y + h > sheetH - kerf + 0.1) {
    return false;
  }

  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return true;
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];
  const minGapSq = Math.max(0.1, kerf - 0.2) ** 2;
  const absPts = partPts.map(p => ({ x: x + p.x, y: y + p.y }));

  for (let i = 0; i < absPts.length; i++) {
    const p1 = absPts[i];
    const p2 = absPts[(i + 1) % absPts.length];

    if (!isPointInPoly(p1.x, p1.y, sheetPoly)) return false;
    if (!isPointInPoly((p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5, sheetPoly)) return false;

    for (let j = 0; j < sheetPoly.length; j++) {
      const s1 = sheetPoly[j];
      const s2 = sheetPoly[(j + 1) % sheetPoly.length];
      if (segmentsIntersect(p1, p2, s1, s2)) return false;
      if (pointToSegmentDistSq(p1.x, p1.y, s1.x, s1.y, s2.x, s2.y) < minGapSq) return false;
      if (pointToSegmentDistSq(s1.x, s1.y, p1.x, p1.y, p2.x, p2.y) < minGapSq) return false;
    }
  }

  for (const obs of obstacles) {
    if (
      x + w + kerf <= obs.minX + 0.05 ||
      obs.maxX + kerf <= x + 0.05 ||
      y + h + kerf <= obs.minY + 0.05 ||
      obs.maxY + kerf <= y + 0.05
    ) {
      continue;
    }

    const obsPts = obs.points;
    for (let i = 0; i < absPts.length; i++) {
      const p1 = absPts[i];
      const p2 = absPts[(i + 1) % absPts.length];
      if (isPointInPoly(p1.x, p1.y, obsPts)) return false;
      if (isPointInPoly((p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5, obsPts)) return false;
    }

    for (let j = 0; j < obsPts.length; j++) {
      const o1 = obsPts[j];
      const o2 = obsPts[(j + 1) % obsPts.length];
      if (isPointInPoly(o1.x, o1.y, absPts)) return false;
      if (isPointInPoly((o1.x + o2.x) * 0.5, (o1.y + o2.y) * 0.5, absPts)) return false;
    }

    for (let i = 0; i < absPts.length; i++) {
      const p1 = absPts[i];
      const p2 = absPts[(i + 1) % absPts.length];
      for (let j = 0; j < obsPts.length; j++) {
        const o1 = obsPts[j];
        const o2 = obsPts[(j + 1) % obsPts.length];
        if (segmentsIntersect(p1, p2, o1, o2)) return false;
        if (pointToSegmentDistSq(p1.x, p1.y, o1.x, o1.y, o2.x, o2.y) < minGapSq) return false;
        if (pointToSegmentDistSq(o1.x, o1.y, p1.x, p1.y, p2.x, p2.y) < minGapSq) return false;
      }
    }
  }

  return true;
}

function polygonsCollideTrueShape(pA, pB, gap) {
  if (
    pA.x + pA.placedWidth + gap <= pB.x + 0.05 ||
    pB.x + pB.placedWidth + gap <= pA.x + 0.05 ||
    pA.y + pA.placedHeight + gap <= pB.y + 0.05 ||
    pB.y + pB.placedHeight + gap <= pA.y + 0.05
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
    if (isPointInPoly(a1.x, a1.y, ptsB)) return true;
    if (isPointInPoly((a1.x + a2.x) * 0.5, (a1.y + a2.y) * 0.5, ptsB)) return true;
  }

  for (let j = 0; j < ptsB.length; j++) {
    const b1 = ptsB[j];
    const b2 = ptsB[(j + 1) % ptsB.length];
    if (isPointInPoly(b1.x, b1.y, ptsA)) return true;
    if (isPointInPoly((b1.x + b2.x) * 0.5, (b1.y + b2.y) * 0.5, ptsA)) return true;
  }

  const minGapSq = Math.max(0.1, gap - 0.15) ** 2;
  for (let i = 0; i < ptsA.length; i++) {
    const a1 = ptsA[i];
    const a2 = ptsA[(i + 1) % ptsA.length];
    for (let j = 0; j < ptsB.length; j++) {
      const b1 = ptsB[j];
      const b2 = ptsB[(j + 1) % ptsB.length];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
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
          if (isPointInPoly(cx, cy, pts)) {
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
// 2. DECOMPOSIÇÃO DE ALTA RESOLUÇÃO + ÂNCORAS EM RAMPAS E BOLSÕES DA CHAPA
// =========================================================================

function buildInitialFreeRectsAndAnchors(sheetW, sheetH, customSheet, kerf) {
  let freeRects = [{ x: kerf, y: kerf, width: sheetW - kerf * 2, height: sheetH - kerf * 2 }];
  const specialAnchors = [];

  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return { freeRects, specialAnchors };
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];

  // 1. Subtrai as Bounding Boxes (acrescidas de kerf) dos furos internos da chapa
  for (const obs of obstacles) {
    freeRects = subtractBoxFromFreeRects(freeRects, {
      x: obs.minX - kerf,
      y: obs.minY - kerf,
      width: obs.width + kerf * 2,
      height: obs.height + kerf * 2
    });

    // Cria âncoras coladas ao redor dos 4 lados de cada furo da chapa (inclusive em corredores estreitos!)
    specialAnchors.push(
      { x: Math.max(kerf, obs.minX - kerf), y: Math.max(kerf, obs.minY), tag: 'POCKET' },
      { x: kerf, y: kerf, tag: 'POCKET_TOP_LEFT' },
      { x: kerf, y: Math.max(kerf, obs.maxY + kerf), tag: 'BELOW_OBS' },
      { x: Math.min(sheetW - kerf, obs.maxX + kerf), y: Math.max(kerf, obs.minY), tag: 'RIGHT_OF_OBS' }
    );
  }

  // 2. Gera âncoras ao longo de todas as arestas e vértices (inclusive rampas diagonais!)
  for (let i = 0; i < sheetPoly.length; i++) {
    const v1 = sheetPoly[i];
    const v2 = sheetPoly[(i + 1) % sheetPoly.length];
    for (const t of [0, 0.15, 0.3, 0.5, 0.7, 0.85]) {
      const px = v1.x + (v2.x - v1.x) * t;
      const py = v1.y + (v2.y - v1.y) * t;
      specialAnchors.push(
        { x: Math.max(kerf, px + kerf), y: Math.max(kerf, py + kerf), tag: 'SLOPE' },
        { x: Math.max(kerf, px + kerf * 2), y: Math.max(kerf, py - kerf * 4), tag: 'SLOPE_UP' }
      );
    }
  }

  // 3. Subdivisão de alta resolução sem comer a borda interna de rampas diagonais
  const xSet = new Set([0, sheetW]);
  const ySet = new Set([0, sheetH]);
  for (const pt of sheetPoly) {
    xSet.add(Math.max(0, Math.min(sheetW, +pt.x.toFixed(1))));
    ySet.add(Math.max(0, Math.min(sheetH, +pt.y.toFixed(1))));
  }
  const gridCols = 32;
  const gridRows = 24;
  for (let i = 1; i < gridCols; i++) xSet.add(+((sheetW * i) / gridCols).toFixed(1));
  for (let j = 1; j < gridRows; j++) ySet.add(+((sheetH * j) / gridRows).toFixed(1));

  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);

  let activeOutsideBands = [];
  const mergedOutsideBoxes = [];

  for (let iy = 0; iy < ys.length - 1; iy++) {
    const y0 = ys[iy], y1 = ys[iy + 1];
    if (y1 - y0 < 0.5) continue;

    const rowSpans = [];
    let currentSpan = null;

    for (let ix = 0; ix < xs.length - 1; ix++) {
      const x0 = xs[ix], x1 = xs[ix + 1];
      if (x1 - x0 < 0.5) continue;

      // Só considera a célula 100% fora se os 4 cantos E o centro estiverem fora do polígono!
      // Assim células que cruzam uma rampa diagonal permanecem abertas para receber peças pequenas!
      const completelyOutside =
        !isPointInPoly((x0 + x1) * 0.5, (y0 + y1) * 0.5, sheetPoly) &&
        !isPointInPoly(x0 + 0.5, y0 + 0.5, sheetPoly) &&
        !isPointInPoly(x1 - 0.5, y0 + 0.5, sheetPoly) &&
        !isPointInPoly(x1 - 0.5, y1 - 0.5, sheetPoly) &&
        !isPointInPoly(x0 + 0.5, y1 - 0.5, sheetPoly);

      if (completelyOutside) {
        if (currentSpan && Math.abs(currentSpan.x1 - x0) < 0.1) {
          currentSpan.x1 = x1;
        } else {
          if (currentSpan) rowSpans.push(currentSpan);
          currentSpan = { x0, x1, y0, y1 };
        }
      } else if (currentSpan) {
        rowSpans.push(currentSpan);
        currentSpan = null;
      }
    }
    if (currentSpan) rowSpans.push(currentSpan);

    const nextBands = [];
    for (const span of rowSpans) {
      const matchIdx = activeOutsideBands.findIndex(
        b => Math.abs(b.x0 - span.x0) < 0.1 && Math.abs(b.x1 - span.x1) < 0.1 && Math.abs(b.y1 - span.y0) < 0.1
      );
      if (matchIdx !== -1) {
        const matched = activeOutsideBands[matchIdx];
        matched.y1 = span.y1;
        nextBands.push(matched);
        activeOutsideBands.splice(matchIdx, 1);
      } else {
        nextBands.push(span);
      }
    }
    for (const finished of activeOutsideBands) mergedOutsideBoxes.push(finished);
    activeOutsideBands = nextBands;
  }
  for (const finished of activeOutsideBands) mergedOutsideBoxes.push(finished);

  for (const outBox of mergedOutsideBoxes) {
    freeRects = subtractBoxFromFreeRects(freeRects, {
      x: outBox.x0,
      y: outBox.y0,
      width: outBox.x1 - outBox.x0,
      height: outBox.y1 - outBox.y0
    });
  }

  return { freeRects, specialAnchors };
}

const SHEET_W = sheet?.isCustomDxf ? sheet.width : Number(config.sheetWidth);
const SHEET_H = sheet?.isCustomDxf ? sheet.height : Number(config.sheetHeight);
const { freeRects: BASE_SHEET_FREE_RECTS, specialAnchors: SHEET_ANCHORS } =
  buildInitialFreeRectsAndAnchors(SHEET_W, SHEET_H, sheet, Number(config.kerf));

// =========================================================================
// 3. NESTING IN-HOLE (SINCRONIZADO COM QUALQUER ÂNGULO DA PEÇA MÃE)
// =========================================================================

function tryNestingInHoles(orderedParts, kerf, allowRotation, enableInHole) {
  if (!enableInHole) {
    return { mainSheetParts: orderedParts, nestedInHolesMap: new Map() };
  }

  const nestedInHolesMap = new Map();
  const allocatedChildIds = new Set();

  for (const hostPart of orderedParts) {
    if (allocatedChildIds.has(hostPart.id)) continue;
    for (const hole of hostPart.holes || []) {
      if (!hole.usableHole) continue;

      const availW = hole.width - kerf * 2;
      const availH = hole.height - kerf * 2;
      if (availW <= 2 || availH <= 2) continue;

      for (const candidate of orderedParts) {
        if (candidate.id === hostPart.id || allocatedChildIds.has(candidate.id)) continue;

        let fitAngle = null;
        if (candidate.width <= availW && candidate.height <= availH) {
          fitAngle = 0;
        } else if (allowRotation && candidate.height <= availW && candidate.width <= availH) {
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
// 4. COMPACTAÇÃO GRAVITACIONAL MULTI-CANTO + DESLIZE EM RAMPA DIAGONAL
// =========================================================================

function compactTrueShapeAndCommonLine(placedParts, customSheet, kerf, commonLineEnabled, laserBeamWidth, gravityDir) {
  const effectiveGap = commonLineEnabled ? Number(laserBeamWidth || 0.4) : kerf;

  // Define a direção dos vetores de gravidade (suporta puxar para qualquer canto + deslizar em rampas diagonais!)
  const dirX = (gravityDir === 'TOP_RIGHT' || gravityDir === 'BOTTOM_RIGHT') ? 1 : -1;
  const dirY = (gravityDir === 'BOTTOM_LEFT' || gravityDir === 'BOTTOM_RIGHT') ? 1 : -1;

  for (let pass = 0; pass < 3; pass++) {
    const order = [...placedParts].sort((a, b) => {
      const scoreA = (dirX < 0 ? a.x : -a.x) + (dirY < 0 ? a.y : -a.y);
      const scoreB = (dirX < 0 ? b.x : -b.x) + (dirY < 0 ? b.y : -b.y);
      return scoreA - scoreB;
    });

    for (const part of order) {
      const tryMove = (dx, dy) => {
        part.x = +(part.x + dx).toFixed(2);
        part.y = +(part.y + dy).toFixed(2);
        const inside = isPartInsideCustomSheet(
          part.x, part.y, part.placedWidth, part.placedHeight, part.placedPoints, customSheet, kerf
        );
        const collides = !inside || placedParts.some(
          o => o.id !== part.id && polygonsCollideTrueShape(part, o, effectiveGap)
        );
        if (collides) {
          part.x = +(part.x - dx).toFixed(2);
          part.y = +(part.y - dy).toFixed(2);
          return false;
        }
        return true;
      };

      // Passos do grosso ao sub-milimétrico (12mm -> 3mm -> 0.5mm)
      for (const step of [12, 3, 0.5]) {
        let moved = true;
        let guard = 0;
        while (moved && guard < 120) {
          guard++;
          moved = false;
          // 1. Tenta deslizar nos eixos principais X e Y
          if (tryMove(dirX * step, 0)) moved = true;
          if (tryMove(0, dirY * step)) moved = true;

          // 2. Se travou numa parede inclinada/rampa, tenta deslizar DIAGONALMENTE acompanhando a rampa!
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
// 5. EXTRATOR DE RETALHOS POR EXPANSÃO MÁXIMA INSCRITA (MAXIMAL INSCRIBED RECTANGLE)
// Encontra retalhos em qualquer região da chapa (ex.: à direita do furo circular!)
// =========================================================================

function isRectStrictlyValidForRemnant(r, placedParts, customSheet, kerf) {
  if (r.x < kerf - 0.2 || r.y < kerf - 0.2 || r.x + r.width > SHEET_W - kerf + 0.2 || r.y + r.height > SHEET_H - kerf + 0.2) {
    return false;
  }

  // Não pode colidir com nenhuma peça posicionada
  for (const p of placedParts) {
    if (p.nestedInsideHole) continue;
    if (
      r.x < p.x + p.placedWidth + kerf - 0.1 &&
      r.x + r.width > p.x - 0.1 &&
      r.y < p.y + p.placedHeight + kerf - 0.1 &&
      r.y + r.height > p.y - 0.1
    ) {
      // Se for peça em L, verifica contra as caixas sólidas reais do L
      const boxes = getSolidBoxesForPart(p, kerf);
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
    if (!isPointInPoly(c.x, c.y, sheetPoly)) return false;
  }
  for (let i = 0; i < 4; i++) {
    const c1 = corners[i], c2 = corners[(i + 1) % 4];
    if (!isPointInPoly((c1.x + c2.x) * 0.5, (c1.y + c2.y) * 0.5, sheetPoly)) return false;
    for (let j = 0; j < sheetPoly.length; j++) {
      if (segmentsIntersect(c1, c2, sheetPoly[j], sheetPoly[(j + 1) % sheetPoly.length])) return false;
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
      if (isPointInPoly(c.x, c.y, obsPts)) return false;
    }
    for (const op of obsPts) {
      if (op.x > r.x + 0.5 && op.x < r.x + r.width - 0.5 && op.y > r.y + 0.5 && op.y < r.y + r.height - 0.5) {
        return false;
      }
    }
    for (let i = 0; i < 4; i++) {
      const c1 = corners[i], c2 = corners[(i + 1) % 4];
      if (isPointInPoly((c1.x + c2.x) * 0.5, (c1.y + c2.y) * 0.5, obsPts)) return false;
      for (let j = 0; j < obsPts.length; j++) {
        if (segmentsIntersect(c1, c2, obsPts[j], obsPts[(j + 1) % obsPts.length])) return false;
      }
    }
  }

  return true;
}

// Expande as 4 bordas de um retângulo candidato até encostar no limite real da chapa/peças/furos
function expandRectangleToLimits(rect, placedParts, existingRemnants, customSheet, kerf) {
  let r = { ...rect };
  const collidesWithExistingRemnants = (cand) =>
    existingRemnants.some(rem =>
      cand.x < rem.x + rem.width - 0.1 &&
      cand.x + cand.width > rem.x + 0.1 &&
      cand.y < rem.y + rem.height - 0.1 &&
      cand.y + cand.height > rem.y + 0.1
    );

  for (const step of [20, 5, 1]) {
    // Expande Direita
    while (true) {
      const test = { ...r, width: r.width + step };
      if (!collidesWithExistingRemnants(test) && isRectStrictlyValidForRemnant(test, placedParts, customSheet, kerf)) r = test;
      else break;
    }
    // Expande Base
    while (true) {
      const test = { ...r, height: r.height + step };
      if (!collidesWithExistingRemnants(test) && isRectStrictlyValidForRemnant(test, placedParts, customSheet, kerf)) r = test;
      else break;
    }
    // Expande Esquerda
    while (true) {
      const test = { ...r, x: r.x - step, width: r.width + step };
      if (!collidesWithExistingRemnants(test) && isRectStrictlyValidForRemnant(test, placedParts, customSheet, kerf)) r = test;
      else break;
    }
    // Expande Topo
    while (true) {
      const test = { ...r, y: r.y - step, height: r.height + step };
      if (!collidesWithExistingRemnants(test) && isRectStrictlyValidForRemnant(test, placedParts, customSheet, kerf)) r = test;
      else break;
    }
  }
  return r;
}

function extractStandardRemnants(placedParts, customSheet, kerf, minRemnantSize) {
  let freeRects = BASE_SHEET_FREE_RECTS.map(r => ({ ...r }));

  for (const p of placedParts) {
    if (p.nestedInsideHole) continue;
    const solidBoxes = getSolidBoxesForPart(p, kerf);
    for (const box of solidBoxes) {
      freeRects = subtractBoxFromFreeRects(freeRects, box);
    }
  }

  // Se a chapa for customizada (.DXF com rampa inclinada ou furo circular), gera candidatos extras via Maior Retângulo de Histograma 2D
  if (customSheet && customSheet.isCustomDxf) {
    const cols = 36, rows = 24;
    const cellW = (SHEET_W - kerf * 2) / cols;
    const cellH = (SHEET_H - kerf * 2) / rows;
    const heights = new Array(cols).fill(0);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellRect = { x: kerf + c * cellW, y: kerf + r * cellH, width: cellW, height: cellH };
        if (isRectStrictlyValidForRemnant(cellRect, placedParts, customSheet, kerf)) {
          heights[c] += 1;
        } else {
          heights[c] = 0;
        }
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
              x: kerf + cStart * cellW,
              y: kerf + (r - minH + 1) * cellH,
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
      r => r.width >= minRemnantSize * 0.85 && r.height >= minRemnantSize * 0.85 && isRectStrictlyValidForRemnant(r, placedParts, customSheet, kerf)
    );
    if (!valid.length) break;
    valid.sort((a, b) => (b.width * b.height) - (a.width * a.height));

    // Pega os 3 melhores candidatos, expande suas 4 bordas até o limite exato e escolhe o maior
    let bestExpanded = null;
    for (let i = 0; i < Math.min(3, valid.length); i++) {
      const exp = expandRectangleToLimits(valid[i], placedParts, remnants, customSheet, kerf);
      if (exp.width >= minRemnantSize && exp.height >= minRemnantSize) {
        if (!bestExpanded || (exp.width * exp.height) > (bestExpanded.width * bestExpanded.height)) {
          bestExpanded = exp;
        }
      }
    }

    if (!bestExpanded) {
      // Remove o primeiro que não atingiu o tamanho mínimo após expansão
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

// =========================================================================
// 6. AVALIAÇÃO DE 1 CANDIDATO COMPLETO
// =========================================================================

function evaluateCandidate(orderedParts, heuristic, forcedAngles, gravityDir) {
  const sheetW = SHEET_W;
  const sheetH = SHEET_H;
  const sheetPoly = sheet?.isCustomDxf ? sheet.points : null;
  const sheetObstacles = sheet?.isCustomDxf ? (sheet.obstacles || []) : [];
  const kerf = Number(config.kerf);
  const effectiveGap = config.commonLine ? Number(config.laserBeamWidth || 0.4) : kerf;

  const { mainSheetParts, nestedInHolesMap } = tryNestingInHoles(
    orderedParts,
    kerf,
    config.allowRotation,
    config.enableInHole !== false
  );

  let freeRects = BASE_SHEET_FREE_RECTS.map(r => ({ ...r }));
  const placedParts = [];
  const unplacedParts = [];

  // Lista de ângulos permitidos (0, 90, 180, 270 + 45/135/225/315 se allowFreeAngles estiver ativo)
  let baseAngles = [0];
  if (config.allowRotation) {
    baseAngles = [0, 90, 180, 270];
    if (config.allowFreeAngles) {
      baseAngles = [0, 45, 90, 135, 180, 225, 270, 315];
    }
  }

  for (const part of mainSheetParts) {
    let bestCand = null;
    let bestScore = Infinity;

    const isSymmetricRect = part.points.length === 4 && Math.abs(part.area - part.bboxArea) < 2;
    let tryAngles = isSymmetricRect
      ? (config.allowRotation ? (part.width === part.height ? [0] : [0, 90]) : [0])
      : baseAngles;

    if (config.allowRotation && forcedAngles[part.id] !== undefined) {
      tryAngles = [forcedAngles[part.id], ...tryAngles.filter(a => a !== forcedAngles[part.id])];
    }

    // Pontos candidatos: todos os cantos de freeRects + âncoras especiais de bolsões e rampas!
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
      candidatePositions.push({ x: anc.x, y: anc.y, rw: sheetW, rh: sheetH, isAnchor: true, tag: anc.tag });
    }

    for (const pos of candidatePositions) {
      for (const ang of tryAngles) {
        const rotData = rotateAndNormalizePart(part, ang);
        const w = rotData.w;
        const h = rotData.h;
        const reqW = w + effectiveGap;
        const reqH = h + effectiveGap;

        let px = pos.x;
        let py = pos.y;
        if (pos.isAnchor && gravityDir === 'BOTTOM_LEFT' && !pos.tag) py = Math.max(kerf, pos.y - h);
        if (pos.isAnchor && gravityDir === 'TOP_RIGHT' && !pos.tag) px = Math.max(kerf, pos.x - w);

        if (!pos.isAnchor && (pos.rw < reqW || pos.rh < reqH)) continue;

        if (!isPartInsideCustomSheet(px, py, w, h, rotData.pts, sheet, kerf)) continue;

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
        if (placedParts.some(other => polygonsCollideTrueShape(tempPart, other, effectiveGap))) continue;

        let score = 0;
        if (heuristic === 'POCKET_AND_SLOPE') {
          // Prioriza colocar peças pequenas nos bolsões estreitos e pontas de rampas (salva o salão principal!)
          score = px * 4 + py * 1.5 - (pos.tag === 'POCKET_TOP_LEFT' ? 5000 : 0);
        } else if (heuristic === 'TOP_ROW') {
          score = (py + h) * 10 + px;
        } else if (heuristic === 'LEFT_COLUMN') {
          score = (px + w) * 10 + py;
        } else if (heuristic === 'BOTTOM_LEFT') {
          score = (sheetH - (py + h)) * 8 + px * 2;
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

      const solidBoxes = getSolidBoxesForPart(hostPlaced, effectiveGap);
      for (const sBox of solidBoxes) {
        freeRects = subtractBoxFromFreeRects(freeRects, sBox);
      }
    } else {
      unplacedParts.push(part);
    }
  }

  // Compactação Gravitacional Multidirecional + Deslize em Rampa Diagonal
  compactTrueShapeAndCommonLine(
    placedParts,
    sheet,
    kerf,
    Boolean(config.commonLine),
    Number(config.laserBeamWidth || 0.4),
    gravityDir
  );

  // Posiciona as peças filhas (In-Hole) girando exatamente no mesmo ângulo final da peça mãe!
  let inHoleCount = 0;
  const finalAllPlaced = [...placedParts];

  for (const host of placedParts) {
    for (const rotHole of host.placedHoles || []) {
      const children = nestedInHolesMap.get(rotHole.id) || [];
      for (const childSpec of children) {
        const totalChildAngle = ((host.angle || 0) + childSpec.relativeAngle) % 360;
        const childRotData = rotateAndNormalizePart(childSpec.rawPart, totalChildAngle);

        const holeCenterX = (rotHole.rotRelX !== undefined ? rotHole.rotRelX : rotHole.relX) +
                            (rotHole.rotW !== undefined ? rotHole.rotW : rotHole.width) * 0.5;
        const holeCenterY = (rotHole.rotRelY !== undefined ? rotHole.rotRelY : rotHole.relY) +
                            (rotHole.rotH !== undefined ? rotHole.rotH : rotHole.height) * 0.5;

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

  let freeHoleSlugsCount = 0;
  for (const host of placedParts) {
    for (const hole of host.placedHoles || []) {
      if (hole.usableHole && !hole.hasChildPartInside) {
        freeHoleSlugsCount++;
      }
    }
  }

  let maxX = 0, maxY = 0;
  for (const p of placedParts) {
    if (p.x + p.placedWidth + kerf > maxX) maxX = p.x + p.placedWidth + kerf;
    if (p.y + p.placedHeight + kerf > maxY) maxY = p.y + p.placedHeight + kerf;
  }

  const remnants = extractStandardRemnants(placedParts, sheet, kerf, Number(config.minRemnantSize));
  const sheetArea = sheet?.isCustomDxf ? sheet.area : (sheetW * sheetH);
  const usedArea = finalAllPlaced.reduce((acc, p) => acc + p.area, 0);
  const remnantArea = remnants.reduce((acc, r) => acc + r.area, 0);
  const largestRemnant = remnants.length > 0 ? remnants[0] : { width: 0, height: 0, area: 0 };

  const effectiveConsumed = Math.max(usedArea, sheetArea - remnantArea);
  const compactUtilization = effectiveConsumed > 0 ? +((usedArea / effectiveConsumed) * 100).toFixed(2) : 0;
  const rawUtilization = sheetArea > 0 ? +((usedArea / sheetArea) * 100).toFixed(2) : 0;

  return {
    heuristic,
    gravityMode: gravityDir,
    sheetWidth: sheetW,
    sheetHeight: sheetH,
    sheetPoly,
    sheetObstacles,
    kerf,
    commonLine: Boolean(config.commonLine),
    rawUtilization,
    compactUtilization,
    usedArea: +usedArea.toFixed(2),
    sheetArea: +sheetArea.toFixed(2),
    remnantArea: +remnantArea.toFixed(2),
    largestRemnantArea: largestRemnant.area,
    largestRemnantDim: `${Math.round(largestRemnant.width)}x${Math.round(largestRemnant.height)}mm`,
    boundingBoxArea: +(maxX * maxY).toFixed(1),
    inHoleCount,
    freeHoleSlugsCount,
    remnants,
    placedParts: finalAllPlaced,
    unplacedParts
  };
}

// Juiz 100% Unificado (Usado tanto pelo Campeão Travado quanto pelo Top Archive)
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
  return best.boundingBoxArea - cand.boundingBoxArea;
}

// =========================================================================
// 7. LOOP DE OTIMIZAÇÃO NO WORKER THREAD
// =========================================================================

function runOptimizationLoop() {
  const totalIterations = Math.max(50, Math.min(200000, Number(config.totalIterations) || 20000));
  const startTime = Date.now();
  const rng = createSeededRandom(Number(config.sheetWidth) * 31 + Number(config.sheetHeight) * 17 + (config.seedOffset || 1));

  const heuristics = ['POCKET_AND_SLOPE', 'TOP_ROW', 'LEFT_COLUMN', 'BEST_SHORT_SIDE_FIT', 'BOTTOM_LEFT'];
  const gravityDirs = ['TOP_LEFT', 'BOTTOM_LEFT', 'TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_RIGHT'];

  const baseOrders = [
    [...parts].sort((a, b) => b.area - a.area),
    [...parts].sort((a, b) => a.area - b.area), // Peças menores primeiro para entrar em bolsões estreitos!
    [...parts].sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height)),
    [...parts].sort((a, b) => b.height - a.height),
    [...parts].sort((a, b) => b.width - a.width)
  ];

  let bestResult = null;
  let bestOrder = [...baseOrders[0]];
  let bestAngles = {};
  let improvements = 0;
  const topArchive = [];
  const N = parts.length;
  let lastProgressSent = Date.now();

  const availableAngles = config.allowRotation
    ? (config.allowFreeAngles ? [0, 45, 90, 135, 180, 225, 270, 315] : [0, 90, 180, 270])
    : [0];

  for (let iter = 1; iter <= totalIterations; iter++) {
    const heuristic = heuristics[(iter - 1) % heuristics.length];
    const gravityDir = gravityDirs[(iter - 1) % gravityDirs.length];
    let candidateOrder;
    let forcedAngles = {};

    if (iter <= baseOrders.length * heuristics.length) {
      candidateOrder = baseOrders[Math.floor((iter - 1) / heuristics.length) % baseOrders.length];
    } else {
      candidateOrder = [...bestOrder];
      forcedAngles = { ...bestAngles };
      const swaps = 1 + (iter % 3);
      for (let s = 0; s < swaps && N > 1; s++) {
        const i = Math.floor(rng() * N);
        const j = Math.floor(rng() * N);
        [candidateOrder[i], candidateOrder[j]] = [candidateOrder[j], candidateOrder[i]];
      }
      for (let k = 0; k < N; k++) {
        if (rng() < 0.35) {
          forcedAngles[candidateOrder[k].id] = availableAngles[Math.floor(rng() * availableAngles.length)];
        }
      }
    }

    const res = evaluateCandidate(candidateOrder, heuristic, forcedAngles, gravityDir);

    let isNewRecord = false;
    if (compareSolutions(res, bestResult, config.goal) > 0) {
      bestResult = res;
      bestOrder = [...candidateOrder];
      res.placedParts.forEach(p => { if (!p.nestedInsideHole) bestAngles[p.id] = p.angle || 0; });
      improvements++;
      isNewRecord = true;
    }

    // Atualiza o Top Archive usando o mesmo comparador estrito do Campeão
    if (!topArchive.some(s =>
      Math.abs(s.compactUtilization - res.compactUtilization) < 0.01 &&
      Math.abs(s.largestRemnantArea - res.largestRemnantArea) < 5
    )) {
      topArchive.push(res);
      topArchive.sort((a, b) => compareSolutions(b, a, config.goal));
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

runOptimizationLoop();