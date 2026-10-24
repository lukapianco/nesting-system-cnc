// test/dxfSynth.js — gerador de DXF ASCII sintético para testes do leitor (cenários do mundo real).
'use strict';

const g = (code, value) => `${code}\n${value}`;

function ent(type, layer, fields, opts = {}) {
  const out = [g(0, type), g(8, layer)];
  if (opts.linetype) out.push(g(6, opts.linetype));
  if (opts.paperSpace) out.push(g(67, 1));
  if (opts.extrusion) out.push(g(210, opts.extrusion[0]), g(220, opts.extrusion[1]), g(230, opts.extrusion[2]));
  for (const [c, v] of fields) out.push(g(c, v));
  return out.join('\n');
}

const line = (x1, y1, x2, y2, layer = '0', opts) => ent('LINE', layer, [[10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]], opts);
const circle = (cx, cy, r, layer = '0', opts) => ent('CIRCLE', layer, [[10, cx], [20, cy], [30, 0], [40, r]], opts);
const arc = (cx, cy, r, a0, a1, layer = '0', opts) => ent('ARC', layer, [[10, cx], [20, cy], [30, 0], [40, r], [50, a0], [51, a1]], opts);
function lwpoly(pts, closed = true, layer = '0', opts) {
  const f = [[90, pts.length], [70, closed ? 1 : 0]];
  for (const p of pts) { f.push([10, p[0]], [20, p[1]]); if (p[2]) f.push([42, p[2]]); }
  return ent('LWPOLYLINE', layer, f, opts);
}
const rect = (x, y, w, h, layer, opts) => lwpoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, layer, opts);
function ellipse(cx, cy, mx, my, ratio, t0 = 0, t1 = Math.PI * 2, layer = '0') {
  return ent('ELLIPSE', layer, [[10, cx], [20, cy], [30, 0], [11, mx], [21, my], [31, 0], [40, ratio], [41, t0], [42, t1]]);
}
function spline({ degree = 3, ctrl = [], knots = [], fit = [], closed = false, layer = '0' }) {
  const f = [[70, (closed ? 1 : 0) | 8], [71, degree], [72, knots.length], [73, ctrl.length], [74, fit.length]];
  for (const k of knots) f.push([40, k]);
  for (const p of ctrl) f.push([10, p[0]], [20, p[1]], [30, 0]);
  for (const p of fit) f.push([11, p[0]], [21, p[1]], [31, 0]);
  return ent('SPLINE', layer, f);
}
function insert(name, x, y, { sx = 1, sy = 1, rot = 0, cols = 1, rows = 1, dx = 0, dy = 0, layer = '0', extrusion } = {}) {
  const f = [[2, name], [10, x], [20, y], [30, 0]];
  if (sx !== 1) f.push([41, sx]);
  if (sy !== 1) f.push([42, sy]);
  if (rot) f.push([50, rot]);
  if (cols > 1) f.push([70, cols], [44, dx]);
  if (rows > 1) f.push([71, rows], [45, dy]);
  return ent('INSERT', layer, f, { extrusion });
}
function polyline2d(verts, closed = true, layer = '0') {
  // POLYLINE antigo (R12): POLYLINE + VERTEX... + SEQEND
  const out = [ent('POLYLINE', layer, [[66, 1], [10, 0], [20, 0], [30, 0], [70, closed ? 1 : 0]])];
  for (const v of verts) out.push(ent('VERTEX', layer, [[10, v[0]], [20, v[1]], [30, 0], ...(v[2] ? [[42, v[2]]] : [])]));
  out.push(g(0, 'SEQEND'));
  return out.join('\n');
}
const mtext = (x, y, text, layer = '0') => ent('MTEXT', layer, [[10, x], [20, y], [30, 0], [40, 10], [1, text]]);

/**
 * Monta um DXF completo.
 * @param {{entities:string[], blocks?:Object<string,{base?:number[], entities:string[]}>, insunits?:number|null,
 *          measurement?:number, layers?:Array<{name:string, frozen?:boolean, off?:boolean, plot?:boolean, linetype?:string}>,
 *          linetypes?:Array<{name:string, dashed:boolean}>, eof?:boolean}} spec
 */
function buildDxf(spec) {
  const parts = [];
  parts.push(g(0, 'SECTION'), g(2, 'HEADER'), g(9, '$ACADVER'), g(1, 'AC1015'));
  if (spec.insunits !== null && spec.insunits !== undefined) parts.push(g(9, '$INSUNITS'), g(70, spec.insunits));
  if (spec.measurement !== undefined) parts.push(g(9, '$MEASUREMENT'), g(70, spec.measurement));
  parts.push(g(0, 'ENDSEC'));
  parts.push(g(0, 'SECTION'), g(2, 'TABLES'));
  parts.push(g(0, 'TABLE'), g(2, 'LTYPE'));
  for (const lt of spec.linetypes || []) {
    parts.push(g(0, 'LTYPE'), g(2, lt.name), g(70, 0), g(72, 65), g(73, lt.dashed ? 2 : 0), g(40, lt.dashed ? 10 : 0));
    if (lt.dashed) parts.push(g(49, 6), g(74, 0), g(49, -4), g(74, 0));
  }
  parts.push(g(0, 'ENDTAB'));
  parts.push(g(0, 'TABLE'), g(2, 'LAYER'));
  for (const L of spec.layers || []) {
    parts.push(g(0, 'LAYER'), g(2, L.name), g(70, L.frozen ? 1 : 0), g(62, L.off ? -7 : 7), g(6, L.linetype || 'CONTINUOUS'));
    if (L.plot === false) parts.push(g(290, 0));
  }
  parts.push(g(0, 'ENDTAB'), g(0, 'ENDSEC'));
  parts.push(g(0, 'SECTION'), g(2, 'BLOCKS'));
  for (const [name, b] of Object.entries(spec.blocks || {})) {
    const base = b.base || [0, 0];
    parts.push(g(0, 'BLOCK'), g(8, '0'), g(2, name), g(70, name.startsWith('*') ? 1 : 0), g(10, base[0]), g(20, base[1]), g(30, 0), g(3, name));
    parts.push(...b.entities);
    parts.push(g(0, 'ENDBLK'), g(8, '0'));
  }
  parts.push(g(0, 'ENDSEC'));
  parts.push(g(0, 'SECTION'), g(2, 'ENTITIES'), ...spec.entities, g(0, 'ENDSEC'));
  if (spec.eof !== false) parts.push(g(0, 'EOF'));
  return parts.join('\n') + '\n';
}

module.exports = { buildDxf, line, circle, arc, lwpoly, rect, ellipse, spline, insert, polyline2d, mtext, ent };
