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
// 1. GEOMETRIA COMPUTACIONAL EXATA (PONTO-POLÍGONO, ARESTAS E DISTÂNCIAS)
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

// Distância ao quadrado entre um ponto (px, py) e um segmento de reta (x1,y1)-(x2,y2)
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

// Verifica se dois segmentos de reta (a1-a2) e (b1-b2) se cruzam
function segmentsIntersect(a1, a2, b1, b2) {
  const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
  return (ccw(a1, b1, b2) !== ccw(a2, b1, b2)) && (ccw(a1, a2, b1) !== ccw(a1, a2, b2));
}

// Verifica se todo o polígono da peça (vértices e arestas) está estritamente dentro da Chapa .DXF
function isPartInsideCustomSheet(x, y, w, h, partPts, sheetPoly, kerf) {
  if (!sheetPoly || !sheetPoly.length) return true;

  const absPts = partPts.map(p => ({ x: x + p.x, y: y + p.y }));
  for (let i = 0; i < absPts.length; i++) {
    const p1 = absPts[i];
    const p2 = absPts[(i + 1) % absPts.length];
    if (!isPointInPoly(p1.x, p1.y, sheetPoly)) return false;
    // Ponto médio da aresta também deve estar dentro da chapa (evita atravessar degrau côncavo)
    if (!isPointInPoly((p1.x + p2.x) * 0.5, (p1.y + p2.y) * 0.5, sheetPoly)) return false;

    for (let j = 0; j < sheetPoly.length; j++) {
      const s1 = sheetPoly[j];
      const s2 = sheetPoly[(j + 1) % sheetPoly.length];
      if (segmentsIntersect(p1, p2, s1, s2)) return false;
      if (pointToSegmentDistSq(p1.x, p1.y, s1.x, s1.y, s2.x, s2.y) < (kerf - 0.2) ** 2) return false;
    }
  }
  return true;
}

// Colisão True-Shape Completa: Testa AABB, Inclusão de Vértices, Cruzamento de Arestas e Distância Ponto-Segmento
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

  // 1. Verifica vértices e pontos médios das arestas de A dentro de B
  for (let i = 0; i < ptsA.length; i++) {
    const a1 = ptsA[i];
    const a2 = ptsA[(i + 1) % ptsA.length];
    if (isPointInPoly(a1.x, a1.y, ptsB)) return true;
    if (isPointInPoly((a1.x + a2.x) * 0.5, (a1.y + a2.y) * 0.5, ptsB)) return true;
  }

  // 2. Verifica vértices e pontos médios das arestas de B dentro de A
  for (let j = 0; j < ptsB.length; j++) {
    const b1 = ptsB[j];
    const b2 = ptsB[(j + 1) % ptsB.length];
    if (isPointInPoly(b1.x, b1.y, ptsA)) return true;
    if (isPointInPoly((b1.x + b2.x) * 0.5, (b1.y + b2.y) * 0.5, ptsA)) return true;
  }

  // 3. Verifica cruzamento de segmentos (arestas em "T" ou "+") e distância mínima (gap/Kerf) entre quinas e paredes
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

// Decompõe peças côncavas ortogonais (ex.: Peças em "L" de 6 vértices) em retângulos sólidos exatos
// Isso libera o vão vazio do "L" no MaxRects sem permitir que outras peças invadam as pernas do "L"!
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
            // Posição e geometria no referencial NÃO rotacionado (0°) da peça mãe
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
// 3. COMPACTAÇÃO TRUE-SHAPE + EXTRAÇÃO DE RETALHOS
// =========================================================================

function compactTrueShapeAndCommonLine(placedParts, sheetPoly, kerf, commonLineEnabled, laserBeamWidth, gravityMode) {
  const effectiveGap = commonLineEnabled ? Number(laserBeamWidth || 0.4) : kerf;

  for (let pass = 0; pass < 3; pass++) {
    const order = [...placedParts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    for (const part of order) {
      const stepSlide = (axis) => {
        for (const step of [8, 2]) {
          while (part[axis] - step >= kerf) {
            part[axis] -= step;
            const insideSheet = isPartInsideCustomSheet(
              part.x, part.y, part.placedWidth, part.placedHeight, part.placedPoints, sheetPoly, kerf
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

function isRectStrictlyInsideSheet(r, sheetPoly) {
  if (!sheetPoly || !sheetPoly.length) return true;
  const corners = [
    { x: r.x + 1, y: r.y + 1 },
    { x: r.x + r.width - 1, y: r.y + 1 },
    { x: r.x + r.width - 1, y: r.y + r.height - 1 },
    { x: r.x + 1, y: r.y + r.height - 1 }
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
  return true;
}

function extractStandardRemnants(placedParts, sheetW, sheetH, sheetPoly, kerf, minRemnantSize) {
  let freeRects = [{ x: kerf, y: kerf, width: sheetW - kerf * 2, height: sheetH - kerf * 2 }];

  // Se a chapa possuir recorte (ex.: chapa em degrau L), subtrai a caixa do degrau vazio para fatiar retalhos exatos
  if (sheetPoly && sheetPoly.length === 6) {
    const xs = [...new Set(sheetPoly.map(p => +p.x.toFixed(1)))].sort((a, b) => a - b);
    const ys = [...new Set(sheetPoly.map(p => +p.y.toFixed(1)))].sort((a, b) => a - b);
    if (xs.length === 3 && ys.length === 3) {
      for (let ix = 0; ix < 2; ix++) {
        for (let iy = 0; iy < 2; iy++) {
          const cx = (xs[ix] + xs[ix + 1]) * 0.5;
          const cy = (ys[iy] + ys[iy + 1]) * 0.5;
          if (!isPointInPoly(cx, cy, sheetPoly)) {
            freeRects = subtractBoxFromFreeRects(freeRects, {
              x: xs[ix] - kerf,
              y: ys[iy] - kerf,
              width: (xs[ix + 1] - xs[ix]) + kerf * 2,
              height: (ys[iy + 1] - ys[iy]) + kerf * 2
            });
          }
        }
      }
    }
  }

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
      r => r.width >= minRemnantSize && r.height >= minRemnantSize && isRectStrictlyInsideSheet(r, sheetPoly)
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
  const sheetW = sheet?.isCustomDxf ? sheet.width : Number(config.sheetWidth);
  const sheetH = sheet?.isCustomDxf ? sheet.height : Number(config.sheetHeight);
  const sheetPoly = sheet?.isCustomDxf ? sheet.points : null;
  const kerf = Number(config.kerf);
  const effectiveGap = config.commonLine ? Number(config.laserBeamWidth || 0.4) : kerf;

  const { mainSheetParts, nestedInHolesMap } = tryNestingInHoles(
    orderedParts,
    kerf,
    config.allowRotation,
    config.enableInHole !== false
  );

  let freeRects = [{ x: kerf, y: kerf, width: sheetW - kerf * 2, height: sheetH - kerf * 2 }];
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

          if (!isPartInsideCustomSheet(rect.x, rect.y, w, h, candPts, sheetPoly, kerf)) continue;

          // Verifica colisão True-Shape com peças já posicionadas
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

      // Subtrai apenas as caixas sólidas reais (liberando o vão interno de peças em "L"!)
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
    sheetPoly,
    kerf,
    Boolean(config.commonLine),
    Number(config.laserBeamWidth || 0.4),
    gravityMode
  );

  // CORREÇÃO DEFINITIVA: Quando a peça mãe (host) gira 90°, a peça filha (In-Hole) gira 90° junto com o furo!
  let inHoleCount = 0;
  const finalAllPlaced = [...placedParts];

  for (const host of placedParts) {
    for (const hole of host.holes || []) {
      const children = nestedInHolesMap.get(hole.id) || [];
      for (const child of children) {
        let cx, cy, finalW, finalH, finalRot, finalPts, finalHoles;

        if (host.rotated) {
          // Host girou 90° via (x, y) -> (y, host.width - x): gira a peça filha sincronizadamente!
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

  const remnants = extractStandardRemnants(placedParts, sheetW, sheetH, sheetPoly, kerf, Number(config.minRemnantSize));
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
  const totalIterations = Math.max(50, Math.min(2000000, Number(config.totalIterations) || 20000));
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