// geometry/congruence.js — peças idênticas a menos de translação e rotação (e, opcionalmente, espelho).
//
// Usado para transformar "87 cópias desenhadas" em "1 peça × 87". A verificação é geométrica (distância de
// Hausdorff entre contornos depois de alinhar centróides e eixos principais), não por nome de bloco: duas
// peças de blocos diferentes mas iguais são agrupadas; dois blocos com o mesmo nome e geometria diferente não.
'use strict';

const { computeSignedArea, polygonPerimeter, pointToRingDist } = require('./primitives');

function areaCentroid(r) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-12) return { x: r[0].x, y: r[0].y };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Segundos momentos de área em torno do centróide (anel simples, qualquer orientação). */
function secondMoments(r, c) {
  let ixx = 0, iyy = 0, ixy = 0, A = 0;
  for (let i = 0; i < r.length; i++) {
    const x0 = r[i].x - c.x, y0 = r[i].y - c.y;
    const x1 = r[(i + 1) % r.length].x - c.x, y1 = r[(i + 1) % r.length].y - c.y;
    const f = x0 * y1 - x1 * y0;
    A += f;
    ixx += (y0 * y0 + y0 * y1 + y1 * y1) * f;
    iyy += (x0 * x0 + x0 * x1 + x1 * x1) * f;
    ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * f;
  }
  const s = A < 0 ? -1 : 1;
  return { ixx: s * ixx / 12, iyy: s * iyy / 12, ixy: s * ixy / 24 };
}

/** Descritor de uma peça (contorno externo + furos), em coordenadas quaisquer. */
function describe(outer, holes = []) {
  const area = Math.abs(computeSignedArea(outer)) - holes.reduce((s, h) => s + Math.abs(computeSignedArea(h)), 0);
  const perim = polygonPerimeter(outer) + holes.reduce((s, h) => s + polygonPerimeter(h), 0);
  // momentos do material (externo menos furos), para o eixo principal
  const c = areaCentroid(outer);
  const m = secondMoments(outer, c);
  for (const h of holes) {
    const mh = secondMoments(h, c);
    m.ixx -= mh.ixx; m.iyy -= mh.iyy; m.ixy -= mh.ixy;
  }
  const phi = 0.5 * Math.atan2(2 * m.ixy, m.iyy - m.ixx); // eixo principal (covariância: Sxx = iyy, Syy = ixx)
  const tr = m.ixx + m.iyy;
  const aniso = tr > 0 ? Math.hypot(m.ixx - m.iyy, 2 * m.ixy) / tr : 0;
  let far = 0, farAng = 0;
  for (const p of outer) {
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d > far) { far = d; farAng = Math.atan2(p.y - c.y, p.x - c.x); }
  }
  return { outer, holes, area, perim, c, phi, aniso, far, farAng, holeAreas: holes.map(h => Math.abs(computeSignedArea(h))).sort((a, b) => a - b) };
}

function sample(r, max = 160) {
  if (r.length <= max) return r;
  const step = r.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(r[Math.floor(i * step)]);
  return out;
}

function transform(pts, cFrom, cTo, theta, mirror) {
  const co = Math.cos(theta), si = Math.sin(theta);
  return pts.map(p => {
    let x = p.x - cFrom.x, y = p.y - cFrom.y;
    if (mirror) x = -x;
    return { x: cTo.x + co * x - si * y, y: cTo.y + si * x + co * y };
  });
}

function ringsClose(A, B, tol) {
  for (const p of sample(A)) if (pointToRingDist(p.x, p.y, B) > tol) return false;
  for (const p of sample(B)) if (pointToRingDist(p.x, p.y, A) > tol) return false;
  return true;
}

/**
 * Testa se B é cópia de A. Devolve { theta (rad), mirror } ou null.
 * @param {ReturnType<typeof describe>} A
 * @param {ReturnType<typeof describe>} B
 */
function matchParts(A, B, { tol = 0.1, allowMirror = false } = {}) {
  if (A.holes.length !== B.holes.length) return null;
  const relA = Math.max(A.area, B.area);
  if (Math.abs(A.area - B.area) > 2e-3 * relA + 1) return null;
  if (Math.abs(A.perim - B.perim) > 2e-3 * Math.max(A.perim, B.perim) + 0.5) return null;
  if (Math.abs(A.far - B.far) > tol * 2 + 1e-3 * A.far) return null;
  for (let i = 0; i < A.holeAreas.length; i++) {
    if (Math.abs(A.holeAreas[i] - B.holeAreas[i]) > 2e-3 * Math.max(A.holeAreas[i], B.holeAreas[i]) + 1) return null;
  }

  const tryPose = (mirror) => {
    const cands = [];
    const phiA = mirror ? Math.PI - A.phi : A.phi;
    if (A.aniso > 2e-3 && B.aniso > 2e-3) {
      cands.push(B.phi - phiA, B.phi - phiA + Math.PI);
    } else {
      // forma quase isotrópica (círculo, quadrado, polígono regular): alinhar o vértice mais distante
      const farA = mirror ? Math.PI - A.farAng : A.farAng;
      for (const p of B.outer) {
        const d = Math.hypot(p.x - B.c.x, p.y - B.c.y);
        if (d >= B.far - Math.max(tol, 1e-4 * B.far)) cands.push(Math.atan2(p.y - B.c.y, p.x - B.c.x) - farA);
        if (cands.length >= 48) break;
      }
      if (!cands.length) cands.push(0);
    }
    for (const th of cands) {
      const outerT = transform(A.outer, A.c, B.c, th, mirror);
      if (!ringsClose(outerT, B.outer, tol)) continue;
      let ok = true;
      const usedH = new Set();
      for (const h of A.holes) {
        const hT = transform(h, A.c, B.c, th, mirror);
        const hc = areaCentroid(hT);
        let found = false;
        for (let j = 0; j < B.holes.length; j++) {
          if (usedH.has(j)) continue;
          const bc = areaCentroid(B.holes[j]);
          if (Math.hypot(bc.x - hc.x, bc.y - hc.y) > tol * 4 + 1e-3 * B.far) continue;
          if (ringsClose(hT, B.holes[j], tol)) { usedH.add(j); found = true; break; }
        }
        if (!found) { ok = false; break; }
      }
      if (ok) return { theta: th, mirror };
    }
    return null;
  };

  return tryPose(false) || (allowMirror ? tryPose(true) : null);
}

module.exports = { describe, matchParts, areaCentroid, secondMoments };
