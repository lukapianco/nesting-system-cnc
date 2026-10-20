// nestingWorker.js
const { parentPort, workerData } = require('worker_threads');

let rustEngine = null;
try {
  rustEngine = require('./rust-engine/pkg/rust_nesting.js');
} catch (_) {
  // Fallback automático para Motor V8 Nativo
}

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
// 1. GEOMETRIA COMPUTACIONAL EXATA (PONTO-POLÍGONO, ARESTAS E OBSTÁCULOS)
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
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return (px - projX) ** 2 + (py - projY) ** 2;
}

function segmentsIntersect(a1, a2, b1, b2) {
  const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
  return (ccw(a1, b1, b2) !== ccw(a2, b1, b2)) && (ccw(a1, a2, b1) !== ccw(a1, a2, b2));
}

// CORREÇÃO 2: Valida se a peça respeita o contorno externo da chapa E todos os furos/obstáculos internos (sheet.obstacles)
function isPartInsideCustomSheet(x, y, w, h, partPts, customSheet, kerf) {
  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return true;
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];
  const minGapSq = Math.max(0.1, kerf - 0.2) ** 2;
  const absPts = partPts.map(p => ({ x: x + p.x, y: y + p.y }));

  // a) Todos os vértices e pontos médios devem estar DENTRO de sheet.points e respeitar kerf das bordas
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

  // b) Nenhum vértice/aresta da peça pode invadir ou ficar a menos de kerf dos furos da chapa (sheet.obstacles)
  for (const obs of obstacles) {
    // Filtro rápido por Bounding Box acrescido de kerf
    if (
      x + w + kerf <= obs.minX + 0.05 ||
      obs.maxX + kerf <= x + 0.05 ||
      y + h + kerf <= obs.minY + 0.05 ||
      obs.maxY + kerf <= y + 0.05
    ) {
      continue;
    }

    const obsPts = obs.points;

    // Vértices e pontos médios da peça não podem cair dentro do furo da chapa
    for (let i = 0; i < absPts.length; i++) {
      const p1 = absPts[i];
      const p2 = absPts[(i + 1) % absPts.length];
      if (isPointInPoly(p1.x, p1.y, obsPts)) return false;
      if (isPointInPoly((p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5, obsPts)) return false;
    }

    // Vértices e pontos médios do furo da chapa não podem cair dentro da peça (evita que a peça engula o furo)
    for (let j = 0; j < obsPts.length; j++) {
      const o1 = obsPts[j];
      const o2 = obsPts[(j + 1) % obsPts.length];
      if (isPointInPoly(o1.x, o1.y, absPts)) return false;
      if (isPointInPoly((o1.x + o2.x) * 0.5, (o1.y + o2.y) * 0.5, absPts)) return false;
    }

    // Arestas não podem se cruzar nem ficar a menos de kerf
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

  const isRectA = pA.points.length === 4 && Math.abs(pA.area - pA.bboxArea) < 2;
  const isRectB = pB.points.length === 4 && Math.abs(pB.area - pB.bboxArea) < 2;
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
  if (pts.length === 6 && Math.abs(placedPart.area - placedPart.bboxArea) > 10) {
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
// CORREÇÃO 3: DECOMPOSIÇÃO INICIAL DO FREERECTS DA CHAPA CUSTOMIZADA (.DXF)
// Funciona para qualquer formato (L, U, T, chanfrado) e subtrai todos os furos da chapa
// =========================================================================

function buildInitialFreeRectsForSheet(sheetW, sheetH, customSheet, kerf) {
  let freeRects = [{ x: kerf, y: kerf, width: sheetW - kerf * 2, height: sheetH - kerf * 2 }];

  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return freeRects;
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];

  // 1. Subtrai as Bounding Boxes (acrescidas de kerf) de todos os furos internos da chapa (sheet.obstacles)
  for (const obs of obstacles) {
    freeRects = subtractBoxFromFreeRects(freeRects, {
      x: obs.minX - kerf,
      y: obs.minY - kerf,
      width: obs.width + kerf * 2,
      height: obs.height + kerf * 2
    });
  }

  // 2. Varredura de grade/células externas ao polígono sheet.points (qualquer formato: L, U, T, degraus, chanfros)
  const xSet = new Set([0, sheetW]);
  const ySet = new Set([0, sheetH]);

  // Inclui todas as coordenadas de vértices do polígono externo da chapa para precisão exata em degraus ortogonais
  for (const pt of sheetPoly) {
    xSet.add(Math.max(0, Math.min(sheetW, +pt.x.toFixed(1))));
    ySet.add(Math.max(0, Math.min(sheetH, +pt.y.toFixed(1))));
  }

  // Adiciona subdivisão de grade para capturar chanfros diagonais ou curvas externas
  const gridCols = 16;
  const gridRows = 12;
  for (let i = 1; i < gridCols; i++) xSet.add(+((sheetW * i) / gridCols).toFixed(1));
  for (let j = 1; j < gridRows; j++) ySet.add(+((sheetH * j) / gridRows).toFixed(1));

  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);

  // Agrupa células externas contíguas em cada linha (Run-Length Encoding horizontal)
  let activeOutsideBands = [];
  const mergedOutsideBoxes = [];

  for (let iy = 0; iy < ys.length - 1; iy++) {
    const y0 = ys[iy], y1 = ys[iy + 1];
    if (y1 - y0 < 0.5) continue;
    const cy = (y0 + y1) * 0.5;

    const rowSpans = [];
    let currentSpan = null;

    for (let ix = 0; ix < xs.length - 1; ix++) {
      const x0 = xs[ix], x1 = xs[ix + 1];
      if (x1 - x0 < 0.5) continue;
      const cx = (x0 + x1) * 0.5;

      const isOutside = !isPointInPoly(cx, cy, sheetPoly);
      if (isOutside) {
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

    // Mescla verticalmente faixas externas idênticas entre linhas adjacentes
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

    for (const finished of activeOutsideBands) {
      mergedOutsideBoxes.push(finished);
    }
    activeOutsideBands = nextBands;
  }

  for (const finished of activeOutsideBands) {
    mergedOutsideBoxes.push(finished);
  }

  // Subtrai todas as caixas vazias externas (acrescidas de kerf) do freeRects inicial
  for (const outBox of mergedOutsideBoxes) {
    freeRects = subtractBoxFromFreeRects(freeRects, {
      x: outBox.x0 - kerf,
      y: outBox.y0 - kerf,
      width: (outBox.x1 - outBox.x0) + kerf * 2,
      height: (outBox.y1 - outBox.y0) + kerf * 2
    });
  }

  return freeRects;
}

// Pré-calcula as ilhas livres iniciais da chapa uma única vez para máxima velocidade nas 20.000+ iterações
const SHEET_W = sheet?.isCustomDxf ? sheet.width : Number(config.sheetWidth);
const SHEET_H = sheet?.isCustomDxf ? sheet.height : Number(config.sheetHeight);
const BASE_SHEET_FREE_RECTS = buildInitialFreeRectsForSheet(SHEET_W, SHEET_H, sheet, Number(config.kerf));

// =========================================================================
// 2. NESTING IN-HOLE (COM ROTAÇÃO SINCRONIZADA DE 90° JUNTO COM A PEÇA MÃE)
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

        let fitRot = null;
        if (candidate.width <= availW && candidate.height <= availH) {
          fitRot = false;
        } else if (allowRotation && candidate.height <= availW && candidate.width <= availH) {
          fitRot = true;
        }

        if (fitRot !== null) {
          allocatedChildIds.add(candidate.id);
          const cw = fitRot ? candidate.height : candidate.width;
          const ch = fitRot ? candidate.width : candidate.height;
          const transformPts = (pts) =>
            pts.map(p => fitRot ? ({ x: p.y, y: candidate.width - p.x }) : ({ x: p.x, y: p.y }));

          if (!nestedInHolesMap.has(hole.id)) nestedInHolesMap.set(hole.id, []);
          nestedInHolesMap.get(hole.id).push({
            ...candidate,
            inHoleParentId: hostPart.id,
            inHoleId: hole.id,
            relXInHost: +(hole.relX + (hole.width - cw) / 2).toFixed(2),
            relYInHost: +(hole.relY + (hole.height - ch) / 2).toFixed(2),
            basePlacedWidth: cw,
            basePlacedHeight: ch,
            baseRotated: fitRot,
            basePlacedPoints: transformPts(candidate.points),
            basePlacedHoles: (candidate.holes || []).map(h => ({ ...h, placedPoints: transformPts(h.points) }))
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
// CORREÇÃO 4: COMPACTAÇÃO GRAVITACIONAL E EXTRAÇÃO DE RETALHOS RESPEITANDO FUROS DA CHAPA
// =========================================================================

function compactTrueShapeAndCommonLine(placedParts, customSheet, kerf, commonLineEnabled, laserBeamWidth, gravityMode) {
  const effectiveGap = commonLineEnabled ? Number(laserBeamWidth || 0.4) : kerf;

  for (let pass = 0; pass < 3; pass++) {
    const order = [...placedParts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    for (const part of order) {
      const stepSlide = (axis) => {
        for (const step of [8, 2]) {
          while (part[axis] - step >= kerf) {
            part[axis] -= step;
            // Respeita tanto o contorno externo quanto os furos/obstáculos internos da chapa a kerf mm
            const insideSheet = isPartInsideCustomSheet(
              part.x, part.y, part.placedWidth, part.placedHeight, part.placedPoints, customSheet, kerf
            );
            const collides = !insideSheet || placedParts.some(
              o => o.id !== part.id && polygonsCollideTrueShape(part, o, effectiveGap)
            );
            if (collides) {
              part[axis] += step;
              break;
            }
          }
        }
      };

      if (gravityMode === 'X_FIRST') {
        stepSlide('x'); stepSlide('y');
      } else {
        stepSlide('y'); stepSlide('x');
      }
    }
  }
}

function isRectStrictlyInsideSheet(r, customSheet) {
  if (!customSheet || !customSheet.isCustomDxf || !customSheet.points || !customSheet.points.length) {
    return true;
  }

  const sheetPoly = customSheet.points;
  const obstacles = customSheet.obstacles || [];

  const corners = [
    { x: r.x + 1, y: r.y + 1 },
    { x: r.x + r.width - 1, y: r.y + 1 },
    { x: r.x + r.width - 1, y: r.y + r.height - 1 },
    { x: r.x + 1, y: r.y + r.height - 1 }
  ];

  // 1. Verifica se o retalho está estritamente dentro do contorno externo da chapa
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

  // 2. Garante que o retalho NUNCA se sobreponha ou cruze qualquer furo interno da chapa (sheet.obstacles)
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

function extractStandardRemnants(placedParts, customSheet, kerf, minRemnantSize) {
  // Parte das ilhas livres já descontando recortes externos e furos internos da chapa
  let freeRects = BASE_SHEET_FREE_RECTS.map(r => ({ ...r }));

  for (const p of placedParts) {
    if (p.nestedInsideHole) continue;
    const solidBoxes = getSolidBoxesForPart(p, kerf);
    for (const box of solidBoxes) {
      freeRects = subtractBoxFromFreeRects(freeRects, box);
    }
  }

  const remnants = [];
  while (true) {
    const valid = freeRects.filter(
      r => r.width >= minRemnantSize && r.height >= minRemnantSize && isRectStrictlyInsideSheet(r, customSheet)
    );
    if (!valid.length) break;
    valid.sort((a, b) => (b.width * b.height) - (a.width * a.height));

    const chosen = valid[0];
    const w = +chosen.width.toFixed(1), h = +chosen.height.toFixed(1);
    const isSq = Math.abs(w - h) <= Math.max(w, h) * 0.12;

    remnants.push({
      id: `RET_${remnants.length + 1}`,
      label: isSq ? `Quadrado #${remnants.length + 1}` : `Retalho #${remnants.length + 1}`,
      x: +chosen.x.toFixed(1),
      y: +chosen.y.toFixed(1),
      width: w,
      height: h,
      area: +(w * h).toFixed(1)
    });

    freeRects = subtractBoxFromFreeRects(freeRects, chosen);
  }
  return remnants;
}

// =========================================================================
// 4. AVALIAÇÃO DE 1 CANDIDATO COMPLETO
// =========================================================================

function evaluateCandidate(orderedParts, heuristic, forcedRotations, gravityMode) {
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

  // Inicia o freeRects já com os furos internos e recortes côncavos da chapa subtraídos!
  let freeRects = BASE_SHEET_FREE_RECTS.map(r => ({ ...r }));
  const placedParts = [];
  const unplacedParts = [];

  for (const part of mainSheetParts) {
    let bestCand = null;
    let bestScore = Infinity;

    const orientations = [false];
    if (config.allowRotation && part.width !== part.height) orientations.push(true);
    const hasForced = config.allowRotation && forcedRotations[part.id] !== undefined && part.width !== part.height;
    const tryOrients = hasForced ? [forcedRotations[part.id]] : orientations;

    for (const rect of freeRects) {
      for (const rot of tryOrients) {
        const w = rot ? part.height : part.width;
        const h = rot ? part.width : part.height;
        const reqW = w + effectiveGap;
        const reqH = h + effectiveGap;

        if (rect.width >= reqW && rect.height >= reqH) {
          const transformPts = (pts) => pts.map(p => rot ? ({ x: p.y, y: part.width - p.x }) : ({ x: p.x, y: p.y }));
          const candPts = transformPts(part.points);

          if (!isPartInsideCustomSheet(rect.x, rect.y, w, h, candPts, sheet, kerf)) continue;

          const tempPart = {
            id: part.id,
            x: rect.x,
            y: rect.y,
            placedWidth: w,
            placedHeight: h,
            area: part.area,
            bboxArea: part.bboxArea,
            points: part.points,
            placedPoints: candPts
          };
          if (placedParts.some(other => polygonsCollideTrueShape(tempPart, other, effectiveGap))) continue;

          let score = 0;
          if (heuristic === 'TOP_ROW') score = (rect.y + h) * 10 + rect.x;
          else if (heuristic === 'LEFT_COLUMN') score = (rect.x + w) * 10 + rect.y;
          else if (heuristic === 'BOTTOM_LEFT') score = rect.y * 3 + rect.x;
          else if (heuristic === 'BEST_AREA_FIT') score = (rect.width * rect.height) - (reqW * reqH) + (rect.x + rect.y);
          else score = Math.min(rect.width - reqW, rect.height - reqH) * 10 + (rect.x + rect.y);

          if (score < bestScore) {
            bestScore = score;
            bestCand = { x: rect.x, y: rect.y, w, h, reqW, reqH, rot, candPts, transformPts };
          }
        }
      }
    }

    if (bestCand) {
      const hostPlaced = {
        ...part,
        x: +bestCand.x.toFixed(2),
        y: +bestCand.y.toFixed(2),
        placedWidth: bestCand.w,
        placedHeight: bestCand.h,
        rotated: bestCand.rot,
        nestedInsideHole: false,
        placedPoints: bestCand.candPts,
        placedHoles: (part.holes || []).map(h => ({
          ...h,
          hasChildPartInside: nestedInHolesMap.has(h.id),
          placedPoints: bestCand.transformPts(h.points)
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

  compactTrueShapeAndCommonLine(
    placedParts,
    sheet,
    kerf,
    Boolean(config.commonLine),
    Number(config.laserBeamWidth || 0.4),
    gravityMode
  );

  let inHoleCount = 0;
  const finalAllPlaced = [...placedParts];

  for (const host of placedParts) {
    for (const hole of host.holes || []) {
      const children = nestedInHolesMap.get(hole.id) || [];
      for (const child of children) {
        let cx, cy, finalW, finalH, finalRot, finalPts, finalHoles;

        if (host.rotated) {
          const rotRelX = child.relYInHost;
          const rotRelY = host.width - (child.relXInHost + child.basePlacedWidth);
          cx = host.x + rotRelX;
          cy = host.y + rotRelY;
          finalW = child.basePlacedHeight;
          finalH = child.basePlacedWidth;
          finalRot = !child.baseRotated;
          const rotChildPts = (pts) => pts.map(p => ({ x: p.y, y: child.basePlacedWidth - p.x }));
          finalPts = rotChildPts(child.basePlacedPoints);
          finalHoles = (child.basePlacedHoles || []).map(h => ({ ...h, placedPoints: rotChildPts(h.placedPoints) }));
        } else {
          cx = host.x + child.relXInHost;
          cy = host.y + child.relYInHost;
          finalW = child.basePlacedWidth;
          finalH = child.basePlacedHeight;
          finalRot = child.baseRotated;
          finalPts = child.basePlacedPoints;
          finalHoles = child.basePlacedHoles;
        }

        finalAllPlaced.push({
          ...child,
          x: +cx.toFixed(2),
          y: +cy.toFixed(2),
          placedWidth: finalW,
          placedHeight: finalH,
          rotated: finalRot,
          placedPoints: finalPts,
          placedHoles: finalHoles,
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
    gravityMode,
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

function isBetter(cand, best, goal) {
  if (!best) return true;
  if (cand.placedParts.length !== best.placedParts.length) return cand.placedParts.length > best.placedParts.length;
  if (Math.abs(cand.usedArea - best.usedArea) > 0.5) return cand.usedArea > best.usedArea;

  if (goal === 'MAX_SINGLE_REMNANT') {
    if (Math.abs(cand.largestRemnantArea - best.largestRemnantArea) > 1) return cand.largestRemnantArea > best.largestRemnantArea;
    return cand.compactUtilization > best.compactUtilization;
  }
  if (goal === 'MIN_BOUNDING_BOX') {
    if (Math.abs(cand.boundingBoxArea - best.boundingBoxArea) > 1) return cand.boundingBoxArea < best.boundingBoxArea;
    return cand.compactUtilization > best.compactUtilization;
  }
  if (Math.abs(cand.compactUtilization - best.compactUtilization) > 0.005) return cand.compactUtilization > best.compactUtilization;
  if (Math.abs(cand.largestRemnantArea - best.largestRemnantArea) > 1) return cand.largestRemnantArea > best.largestRemnantArea;
  return cand.boundingBoxArea < best.boundingBoxArea;
}

// =========================================================================
// 5. LOOP PRINCIPAL DE ALTA VELOCIDADE NO WORKER THREAD
// =========================================================================

function runOptimizationLoop() {
  const totalIterations = Math.max(50, Math.min(200000, Number(config.totalIterations) || 20000));
  const startTime = Date.now();
  const rng = createSeededRandom(Number(config.sheetWidth) * 31 + Number(config.sheetHeight) * 17 + (config.seedOffset || 1));

  const heuristics = ['TOP_ROW', 'LEFT_COLUMN', 'BEST_SHORT_SIDE_FIT', 'BEST_AREA_FIT', 'BOTTOM_LEFT'];
  const baseOrders = [
    [...parts].sort((a, b) => b.area - a.area),
    [...parts].sort((a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height)),
    [...parts].sort((a, b) => (b.width + b.height) - (a.width + a.height)),
    [...parts].sort((a, b) => b.height - a.height),
    [...parts].sort((a, b) => b.width - a.width)
  ];

  let bestResult = null;
  let bestOrder = [...baseOrders[0]];
  let bestRotations = {};
  let improvements = 0;
  const topArchive = [];
  const N = parts.length;
  let lastProgressSent = Date.now();

  for (let iter = 1; iter <= totalIterations; iter++) {
    const heuristic = heuristics[(iter - 1) % heuristics.length];
    const gravityMode = iter % 2 === 0 ? 'X_FIRST' : 'Y_FIRST';
    let candidateOrder;
    let forcedRotations = {};

    if (iter <= baseOrders.length * heuristics.length) {
      candidateOrder = baseOrders[Math.floor((iter - 1) / heuristics.length) % baseOrders.length];
    } else {
      candidateOrder = [...bestOrder];
      forcedRotations = { ...bestRotations };
      const swaps = 1 + (iter % 3);
      for (let s = 0; s < swaps; s++) {
        const i = Math.floor(rng() * N);
        const j = Math.floor(rng() * N);
        [candidateOrder[i], candidateOrder[j]] = [candidateOrder[j], candidateOrder[i]];
      }
      for (let k = 0; k < N; k++) {
        if (rng() < 0.35) forcedRotations[candidateOrder[k].id] = rng() < 0.5;
      }
    }

    const res = evaluateCandidate(candidateOrder, heuristic, forcedRotations, gravityMode);

    let isNewRecord = false;
    if (isBetter(res, bestResult, config.goal)) {
      bestResult = res;
      bestOrder = [...candidateOrder];
      res.placedParts.forEach(p => { if (!p.nestedInsideHole) bestRotations[p.id] = p.rotated; });
      improvements++;
      isNewRecord = true;

      if (!topArchive.some(s => Math.abs(s.compactUtilization - res.compactUtilization) < 0.01)) {
        topArchive.push(res);
        topArchive.sort((a, b) => b.compactUtilization - a.compactUtilization);
        if (topArchive.length > 6) topArchive.pop();
      }
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