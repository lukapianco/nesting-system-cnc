// dxf/curves.js — discretização de curvas exatas com flecha máxima (tolerância cordal) garantida.
// Módulo sem dependências do projeto.
'use strict';

const TWO_PI = Math.PI * 2;

// ---------------------------------------------------------------------------
// Arco elíptico afim P(t) = c + u cos t + v sin t
// ---------------------------------------------------------------------------

/** Maior valor singular de [u v] (= semieixo maior da elipse imagem). */
function semiMajor(u, v) {
  const a = u.x * u.x + u.y * u.y, b = u.x * v.x + u.y * v.y, d = v.x * v.x + v.y * v.y;
  const tr = a + d, det = a * d - b * b;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  return Math.sqrt(tr / 2 + disc);
}

/**
 * Flecha garantida: a corda de um passo Δt desvia no máximo a·(1 − cos(Δt/2)) da curva, onde a é o
 * semieixo maior (para círculo, a = R; para elipse/afim é um limite superior conservador).
 */
function arcPoints(seg, tol, maxSegs = 8192) {
  const { c, u, v, t0, t1 } = seg;
  const a = semiMajor(u, v);
  const sweep = t1 - t0;
  const ratio = Math.min(0.9999, Math.max(1e-9, tol / Math.max(a, tol * 1.01)));
  const dtMax = 2 * Math.acos(1 - ratio);
  let n = Math.ceil(Math.abs(sweep) / dtMax);
  n = Math.max(n, Math.ceil(Math.abs(sweep) / (Math.PI / 4)), 1);
  n = Math.min(n, maxSegs);
  const pts = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    pts[i] = { x: c.x + u.x * Math.cos(t) + v.x * Math.sin(t), y: c.y + u.y * Math.cos(t) + v.y * Math.sin(t) };
  }
  if (seg.pStart) pts[0] = { x: seg.pStart.x, y: seg.pStart.y };
  if (seg.pEnd) pts[n] = { x: seg.pEnd.x, y: seg.pEnd.y };
  return pts;
}

// ---------------------------------------------------------------------------
// NURBS (de Boor em coordenadas homogêneas)
// ---------------------------------------------------------------------------

function findKnotSpan(n, degree, u, knots) {
  if (u >= knots[n + 1]) return n;
  if (u <= knots[degree]) return degree;
  let lo = degree, hi = n + 1, mid = (lo + hi) >> 1;
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) hi = mid; else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

function evaluateNurbs(u, degree, ctrl, knots, weights) {
  const n = ctrl.length - 1;
  const p = degree;
  const k = findKnotSpan(n, p, u, knots);
  const d = new Array(p + 1);
  for (let j = 0; j <= p; j++) {
    const idx = k - p + j;
    const w = weights ? weights[idx] : 1;
    d[j] = { x: ctrl[idx].x * w, y: ctrl[idx].y * w, w };
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j;
      const denom = knots[i + p - r + 1] - knots[i];
      const a = denom > 1e-14 ? (u - knots[i]) / denom : 0;
      d[j] = {
        x: (1 - a) * d[j - 1].x + a * d[j].x,
        y: (1 - a) * d[j - 1].y + a * d[j].y,
        w: (1 - a) * d[j - 1].w + a * d[j].w
      };
    }
  }
  const w = d[p].w || 1;
  return { x: d[p].x / w, y: d[p].y / w };
}

/** Normaliza grau e vetor de nós de uma SPLINE lida do DXF (corrige arquivos com contagem errada). */
function normalizeSpline(seg) {
  const ctrl = seg.ctrl;
  let degree = Math.max(1, Math.min(seg.degree || 3, ctrl.length - 1));
  let knots = seg.knots && seg.knots.length ? seg.knots.slice() : null;
  let repaired = false;
  if (!knots || knots.length !== ctrl.length + degree + 1) {
    repaired = !!(knots && knots.length);
    knots = [];
    for (let i = 0; i <= degree; i++) knots.push(0);
    const internal = ctrl.length - degree - 1;
    for (let i = 1; i <= internal; i++) knots.push(i / (internal + 1));
    for (let i = 0; i <= degree; i++) knots.push(1);
  }
  for (let i = 1; i < knots.length; i++) if (knots[i] < knots[i - 1]) { knots[i] = knots[i - 1]; repaired = true; }
  let weights = seg.weights && seg.weights.length === ctrl.length ? seg.weights : null;
  if (weights && weights.some(w => !(w > 0))) { weights = null; repaired = true; }
  return { degree, knots, weights, ctrl, repaired };
}

/**
 * Discretização adaptativa por vão de nós: cada vão começa com 4 subintervalos e subdivide enquanto a flecha
 * medida em 1/4, 1/2 e 3/4 do subintervalo exceder a tolerância (a versão anterior media só o ponto médio
 * de um único intervalo e podia "achatar" curvas em S simétricas).
 */
function nurbsPoints(seg, tol) {
  const { degree, knots, weights, ctrl } = normalizeSpline(seg);
  const uMin = knots[degree];
  const uMax = knots[ctrl.length];
  const spans = [];
  for (let i = degree; i < ctrl.length; i++) if (knots[i + 1] - knots[i] > 1e-14) spans.push([knots[i], knots[i + 1]]);
  if (!spans.length) spans.push([uMin, uMax]);
  const ev = (u) => evaluateNurbs(Math.min(u, uMax - 1e-12 * Math.max(1, Math.abs(uMax))), degree, ctrl, knots, weights);
  const evEnd = (u) => (u >= uMax ? evaluateNurbs(uMax, degree, ctrl, knots, weights) : ev(u));
  const out = [evaluateNurbs(uMin, degree, ctrl, knots, weights)];

  const distToChord = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    if (L2 < 1e-24) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  const refine = (u0, p0, u1, p1, depth) => {
    const q1 = ev(u0 + (u1 - u0) * 0.25), q2 = ev((u0 + u1) * 0.5), q3 = ev(u0 + (u1 - u0) * 0.75);
    const err = Math.max(distToChord(q1, p0, p1), distToChord(q2, p0, p1), distToChord(q3, p0, p1));
    if (err <= tol || depth >= 16) { out.push(p1); return; }
    const um = (u0 + u1) * 0.5;
    refine(u0, p0, um, q2, depth + 1);
    refine(um, q2, u1, p1, depth + 1);
  };
  for (const [a, b] of spans) {
    let uPrev = a, pPrev = out[out.length - 1];
    for (let s = 1; s <= 4; s++) {
      const uu = a + ((b - a) * s) / 4;
      const pp = s === 4 && b >= uMax ? evEnd(uu) : ev(uu);
      refine(uPrev, pPrev, uu, pp, 0);
      uPrev = uu; pPrev = pp;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SPLINE só com pontos de ajuste: interpolação global cúbica (Piegl & Tiller), parâmetros por corda,
// condições de contorno: tangentes do DXF (códigos 12/13) quando existirem; senão, natural (C'' = 0).
// ---------------------------------------------------------------------------

function basisFuns(span, u, p, U) {
  const N = new Array(p + 1).fill(0), left = new Array(p + 1), right = new Array(p + 1);
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const temp = den !== 0 ? N[r] / den : 0;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

function solveDense(A, B) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...B[i]]);
  const m = B[0].length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-14) throw new Error('sistema singular');
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c < n + m; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row.slice(n).map(v => v / M[i][i]));
}

function interpolateFitSpline(fit, startTangent, endTangent) {
  // remove pontos repetidos
  const Q = [];
  for (const p of fit) if (!Q.length || Math.hypot(p.x - Q[Q.length - 1].x, p.y - Q[Q.length - 1].y) > 1e-9) Q.push(p);
  const n = Q.length - 1;
  if (n < 1) return null;
  if (n === 1) return { degree: 1, ctrl: Q, knots: [0, 0, 1, 1], weights: null };
  const p = 3;
  const d = [];
  let total = 0;
  for (let k = 1; k <= n; k++) { const L = Math.hypot(Q[k].x - Q[k - 1].x, Q[k].y - Q[k - 1].y); d.push(L); total += L; }
  const ub = [0];
  for (let k = 1; k < n; k++) ub.push(ub[k - 1] + d[k - 1] / total);
  ub.push(1);
  const U = [0, 0, 0, 0, ...ub.slice(1, n), 1, 1, 1, 1];
  const nc = n + 3; // pontos de controle
  const A = Array.from({ length: nc }, () => new Array(nc).fill(0));
  const B = Array.from({ length: nc }, () => [0, 0]);
  let row = 0;
  for (let k = 0; k <= n; k++) {
    const u = ub[k];
    const span = findKnotSpan(nc - 1, p, u, U);
    const N = basisFuns(span, u, p, U);
    for (let j = 0; j <= p; j++) A[row][span - p + j] = N[j];
    B[row] = [Q[k].x, Q[k].y];
    row++;
  }
  const u4 = U[p + 1], u5 = U[p + 2];
  const um4 = U[nc - 1], um5 = U[nc - 2]; // U[m-p-1], U[m-p-2] com m = nc + p
  if (startTangent && Math.hypot(startTangent.x, startTangent.y) > 1e-12) {
    const s = total / Math.hypot(startTangent.x, startTangent.y);
    // C'(0) = p/u4 (P1 - P0)
    A[row][0] = -p / u4; A[row][1] = p / u4; B[row] = [startTangent.x * s, startTangent.y * s];
  } else {
    // C''(0) = 0  =>  (P2 - P1)/u5 - (P1 - P0)/u4 = 0
    A[row][0] = 1 / u4; A[row][1] = -1 / u4 - 1 / u5; A[row][2] = 1 / u5; B[row] = [0, 0];
  }
  row++;
  if (endTangent && Math.hypot(endTangent.x, endTangent.y) > 1e-12) {
    const s = total / Math.hypot(endTangent.x, endTangent.y);
    A[row][nc - 2] = -p / (1 - um4); A[row][nc - 1] = p / (1 - um4); B[row] = [endTangent.x * s, endTangent.y * s];
  } else {
    A[row][nc - 1] = 1 / (1 - um4); A[row][nc - 2] = -1 / (1 - um4) - 1 / (1 - um5); A[row][nc - 3] = 1 / (1 - um5); B[row] = [0, 0];
  }
  // reordena: as condições de contorno ficam junto das linhas vizinhas (melhor condicionamento)
  try {
    const X = solveDense(A, B);
    return { degree: p, ctrl: X.map(r => ({ x: r[0], y: r[1] })), knots: U, weights: null };
  } catch (_) {
    return { degree: 1, ctrl: Q, knots: [0, ...ub, 1], weights: null };
  }
}

function splinePoints(seg, tol) {
  if (seg.fit && !seg.ctrl) {
    const s = interpolateFitSpline(seg.fit, seg.startTangent, seg.endTangent);
    if (!s) return [];
    if (s.degree === 1) return s.ctrl.map(p => ({ x: p.x, y: p.y }));
    return nurbsPoints(s, tol);
  }
  return nurbsPoints(seg, tol);
}

// ---------------------------------------------------------------------------
// Caminho -> polilinha
// ---------------------------------------------------------------------------

function segmentPoints(seg, tol) {
  if (seg.kind === 'line') return [seg.a, seg.b];
  if (seg.kind === 'arc') return arcPoints(seg, tol);
  if (seg.kind === 'spline') return splinePoints(seg, tol);
  return [];
}

/** Discretiza um caminho; devolve pontos sem repetir junções (e sem repetir o 1º ponto se fechado). */
function pathPoints(path, tol) {
  const out = [];
  for (const seg of path.segs) {
    const pts = segmentPoints(seg, tol);
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i];
      const last = out[out.length - 1];
      if (last && Math.hypot(q.x - last.x, q.y - last.y) < 1e-9) continue;
      out.push({ x: q.x, y: q.y });
    }
  }
  return out;
}

function segmentStart(seg) {
  if (seg.kind === 'line') return seg.a;
  if (seg.kind === 'arc') return seg.pStart || { x: seg.c.x + seg.u.x * Math.cos(seg.t0) + seg.v.x * Math.sin(seg.t0), y: seg.c.y + seg.u.y * Math.cos(seg.t0) + seg.v.y * Math.sin(seg.t0) };
  return null;
}

module.exports = {
  TWO_PI,
  semiMajor,
  arcPoints,
  evaluateNurbs,
  normalizeSpline,
  nurbsPoints,
  interpolateFitSpline,
  splinePoints,
  segmentPoints,
  pathPoints,
  segmentStart
};
