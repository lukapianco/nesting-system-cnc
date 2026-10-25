// bench/cam.js — sequência de corte: deslocamento em vazio (G00), G00 sobre peça já solta e perfurações em lugar
// estreito, medidos sobre os MESMOS layouts com o planejador de CAM atual e (opcional) com outro arquivo de planejador.
//
//   node bench/cam.js [--time 8] [--compare caminho/para/camPlanner_antigo.js]
//
// Os layouts vêm do motor (sparrow se instalado, senão o clássico) com semente fixa; o CAM é refeito sobre cópias.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { runPreset } = require(path.join(ROOT, 'test', 'harness'));
const { planCam } = require(path.join(ROOT, 'camPlanner'));
const { normalizeNestingParams } = require(path.join(ROOT, 'typesAndInterfaces'));

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const TIME = Number(opt('time', 8));
const other = opt('compare', null) ? require(path.resolve(opt('compare'))).planCam : null;
const FIX = (n) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', n));
const BASE = { kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, external_time_s: TIME, total_iterations: 3000, seed_offset: 1, engine: 'AUTO' };
const CASES = [
  ['trueshape ×3, 1200×800', { parts: 'trueshape', qty: 3, config: { ...BASE, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100 } }],
  ['industrial ×2, 1200×800', { parts: 'industrial', qty: 2, config: { ...BASE, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100 } }],
  ['içamento ×8, 500×300', { parts: 'icamento', qty: 8, config: { ...BASE, sheetWidth: 500, sheetHeight: 300, min_hole_size: 10, min_remnant_size: 35 } }],
  ['Modelo 1 (22 peças)', { dxfText: FIX('Modelo_1_c_moldura.dxf'), qty: 1, config: { ...BASE, sheetWidth: 2000, sheetHeight: 1200 } }],
  ['Modelo 2 (87 gomos)', { dxfText: FIX('Modelo_2_c_moldura.dxf'), qty: 1, config: { ...BASE, sheetWidth: 3000, sheetHeight: 1200 } }],
  ['Modelo 3 (12 anéis, chapa usada)', { dxfText: FIX('Modelo_3_s_moldura.dxf'), qty: 1, importOptions: { sheetContour: 'CHAPA_1' }, config: { ...BASE, sheetWidth: 3000, sheetHeight: 1200 } }]
];

const clone = (o) => JSON.parse(JSON.stringify(o));
(async () => {
  const rows = [];
  for (const [name, o] of CASES) {
    const r = await runPreset({ ...o, hardware: { totalCores: 2, maxWorkers: 1, threadsForJob: 2 } });
    const lay = r.done.bestResult;
    const params = normalizeNestingParams({ ...r.job.normalizedConfig });
    const measure = (fn) => {
      const L = clone(lay); delete L.cam;
      const t0 = Date.now(); fn(L, params); const ms = Date.now() - t0;
      const m = L.cam.metrics;
      return { g00_m: +(m.rapidLength / 1000).toFixed(2), sobre_peca: m.rapidCrossings, estreitas: m.narrowWebPierces, perfuracoes: m.pierceCount, ms };
    };
    const now = measure(planCam);
    const row = { caso: name, motor: r.done.engine, pecas: lay.placedParts.length, ...Object.fromEntries(Object.entries(now).map(([k, v]) => ['atual_' + k, v])) };
    if (other) Object.assign(row, Object.fromEntries(Object.entries(measure(other)).map(([k, v]) => ['antigo_' + k, v])));
    rows.push(row);
    console.log(JSON.stringify(row));
  }
  const pkg = require(path.join(ROOT, 'package.json'));
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  const out = path.join(__dirname, 'results', `cam_v${pkg.version}_${TIME}s.json`);
  fs.writeFileSync(out, JSON.stringify({ versao: pkg.version, data: new Date().toISOString(), tempo_layout_s: TIME, linhas: rows }, null, 1) + '\n');
  console.table(rows);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
