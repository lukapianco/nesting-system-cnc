// bench/metrics.js — RÉGUA INDEPENDENTE de qualidade de nesting (raster). Não usa nenhuma métrica do motor.
'use strict';

const shoelace = (p) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0) / 2;

function fillPolygon(mask, nx, ny, res, ring, ox, oy, value = 1) {
  const pts = ring.map(p => ({ x: p.x + ox, y: p.y + oy }));
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  for (let j = Math.max(0, Math.floor(minY / res)); j <= Math.min(ny - 1, Math.floor(maxY / res)); j++) {
    const y = (j + 0.5) * res, xs = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      for (let i = Math.max(0, Math.round(xs[k] / res)); i < Math.min(nx, Math.round(xs[k + 1] / res)); i++) mask[j * nx + i] = value;
    }
  }
}

function dilate(mask, nx, ny, d) {
  if (d <= 0) return mask;
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {            // horizontal
    if (!mask[j * nx + i]) continue;
    for (let k = Math.max(0, i - d); k <= Math.min(nx - 1, i + d); k++) tmp[j * nx + k] = 1;
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {            // vertical
    if (!tmp[j * nx + i]) continue;
    for (let k = Math.max(0, j - d); k <= Math.min(ny - 1, j + d); k++) out[k * nx + i] = 1;
  }
  return out;
}

function largestRect(blocked, nx, ny, res, minDim) {
  const h = new Int32Array(nx);
  let best = null;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) h[i] = blocked[j * nx + i] ? 0 : h[i] + 1;
    const st = [];
    for (let i = 0; i <= nx; i++) {
      const cur = i === nx ? 0 : h[i];
      let start = i;
      while (st.length && st[st.length - 1].h >= cur) {
        const t = st.pop(); start = t.s;
        const w = (i - t.s) * res, hh = t.h * res;
        if (w >= minDim && hh >= minDim && (!best || w * hh > best.area)) best = { area: w * hh, w, h: hh, i0: t.s, i1: i, j0: j - t.h + 1, j1: j + 1 };
      }
      st.push({ h: cur, s: start });
    }
  }
  return best;
}

/**
 * @param layout {placedParts:[{x,y,placedPoints,placedHoles,nestedInsideHole}], sheetWidth, sheetHeight, sheetPoly?, sheetObstacles?}
 * @param o {gap, margin, minRemnant, res}
 */
function evaluate(layout, o) {
  const res = o.res || 2;
  const W = layout.sheetWidth, H = layout.sheetHeight;
  const nx = Math.ceil(W / res), ny = Math.ceil(H / res);

  // área líquida de peças (contorno - furos), independente de qualquer campo do motor
  let netParts = 0;
  for (const p of layout.placedParts) {
    netParts += Math.abs(shoelace(p.placedPoints)) - (p.placedHoles || []).reduce((s, h) => s + Math.abs(shoelace(h.placedPoints)), 0);
  }
  let sheetNet = W * H;
  if (layout.sheetPoly) sheetNet = Math.abs(shoelace(layout.sheetPoly)) - (layout.sheetObstacles || []).reduce((s, ob) => s + Math.abs(shoelace(ob.points)), 0);

  // máscara de material de peça (só mães; filhas estão dentro do furo da mãe)
  const parts = new Uint8Array(nx * ny);
  for (const p of layout.placedParts) if (!p.nestedInsideHole) fillPolygon(parts, nx, ny, res, p.placedPoints, p.x, p.y);
  // máscara de chapa (fora do contorno + obstáculos)
  const sheetMask = new Uint8Array(nx * ny);
  if (layout.sheetPoly) {
    const inside = new Uint8Array(nx * ny);
    fillPolygon(inside, nx, ny, res, layout.sheetPoly, 0, 0);
    for (let k = 0; k < sheetMask.length; k++) sheetMask[k] = inside[k] ? 0 : 1;
    for (const ob of layout.sheetObstacles || []) fillPolygon(sheetMask, nx, ny, res, ob.points, 0, 0);
  } else {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if ((i + 1) * res > W || (j + 1) * res > H) sheetMask[j * nx + i] = 1;
  }
  const pm = dilate(parts, nx, ny, Math.ceil(o.gap / res));
  const sm = dilate(sheetMask, nx, ny, Math.ceil(o.margin / res));
  const blocked = new Uint8Array(nx * ny);
  for (let k = 0; k < blocked.length; k++) blocked[k] = pm[k] | sm[k];

  const rects = [];
  for (let it = 0; it < 30; it++) {
    const r = largestRect(blocked, nx, ny, res, o.minRemnant);
    if (!r) break;
    rects.push({ w: r.w, h: r.h, area: r.area });
    for (let j = r.j0; j < r.j1; j++) for (let i = r.i0; i < r.i1; i++) blocked[j * nx + i] = 1;
  }

  let extentX = 0, extentY = 0;
  for (const p of layout.placedParts) {
    if (p.nestedInsideHole) continue;
    let mx = 0, my = 0; for (const q of p.placedPoints) { mx = Math.max(mx, q.x); my = Math.max(my, q.y); }
    extentX = Math.max(extentX, p.x + mx); extentY = Math.max(extentY, p.y + my);
  }
  return {
    placed: layout.placedParts.length,
    netUtilPct: +(netParts / sheetNet * 100).toFixed(2),
    usableRemnantMm2: Math.round(rects.reduce((s, r) => s + r.area, 0)),
    largestRemnantMm2: Math.round(rects[0] ? rects[0].area : 0),
    largestRemnantDim: rects[0] ? `${Math.round(rects[0].w)}x${Math.round(rects[0].h)}` : '-',
    remnantCount: rects.length,
    envelopeUtilPct: +(netParts / Math.max(1, extentX * extentY) * 100).toFixed(2)
  };
}

module.exports = { evaluate, shoelace };
