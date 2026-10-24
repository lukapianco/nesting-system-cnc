// bench/ab.js — A/B: V5 original (/tmp/v5orig) x V5.1 (este repositório), mesma régua independente.
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const DxfParser = require('dxf-parser');
const { evaluate } = require('./metrics');
const { buildSampleDxf } = require('../presets');
const { expandPartsByQuantities } = require('../jobBuilder');

const V5 = process.env.V5_DIR || '/tmp/v5orig'; // cópia da V5.0 original (typesAndInterfaces, spatialIndex, cadParser, nfpEngine, nestingWorker)
const mine = require('../jobBuilder');

function sheetDxf(w, h, holes) {
  const poly = (pts) => `0\nLWPOLYLINE\n8\n0\n90\n${pts.length}\n70\n1\n` + pts.map(([x, y]) => `10\n${x}\n20\n${y}`).join('\n');
  const rect = (x, y, a, b) => poly([[x, y], [x + a, y], [x + a, y + b], [x, y + b]]);
  return `0\nSECTION\n2\nENTITIES\n${[rect(0, 0, w, h), ...holes.map(o => rect(...o))].join('\n')}\n0\nENDSEC\n0\nEOF`;
}

function runWorker(file, data) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const w = new Worker(file, { workerData: data });
    w.on('message', (m) => { if (m.type === 'done') { w.terminate(); resolve({ done: m, ms: Date.now() - t0 }); } });
    w.on('error', reject);
  });
}

async function runCase(label, c) {
  const parsedParts = new DxfParser().parseSync(c.dxf || buildSampleDxf(c.parts));
  const rows = [];
  for (const version of c.versions) {
    for (let seed = 1; seed <= c.seeds; seed++) {
      const cfg = { ...c.config, seed_offset: seed, total_iterations: c.iterations, ...(c.extra && c.extra[version] || {}) };
      let r, layoutOf, reported;
      if (version === 'V5') {
        const T = require(`${V5}/typesAndInterfaces`), C = require(`${V5}/cadParser`);
        const norm = T.normalizeNestingParams(cfg);
        const cat = C.classifyPartsAndHoles(C.extractContoursFromDxf(parsedParts, 0.03), norm.min_hole_size, norm); const q = {}; cat.forEach(p => { q[p.id] = c.qty || 1; });
        const parts = expandPartsByQuantities(cat, q);
        const sheet = c.sheetDxf ? C.buildCustomSheetFromContours(C.extractContoursFromDxf(new DxfParser().parseSync(c.sheetDxf), 0.03)) : null;
        r = await runWorker(`${V5}/nestingWorker.js`, { parts, sheet, config: norm, hardware: {} });
      } else {
        const sheetObj = c.sheetDxf ? require('../cadParser').buildCustomSheetFromContours(require('../cadParser').extractContoursFromDxf(require('../cadParser').parseDxf(c.sheetDxf), 0.03, { frameMode: 'part' })) : null;
        // V5.3+: leitor próprio; cópias idênticas viram quantidade, então multiplica pela contagem detectada
        const myParsed = require('../cadParser').parseDxf(c.dxf || buildSampleDxf(c.parts));
        const probe = mine.buildJob({ parsedDxf: myParsed, config: cfg, quantities: {} }); const q = {}; probe.catalogParts.forEach(p => { q[p.id] = (c.qty || 1) * (p.quantity_detected || 1); });
        const job = mine.buildJob({ parsedDxf: myParsed, sheet: sheetObj, config: cfg, quantities: q });
        r = await runWorker(path.join(__dirname, '..', 'nestingWorker.js'), { parts: job.expandedParts, sheet: job.sheet, config: job.normalizedConfig, hardware: {} });
      }
      layoutOf = r.done.bestResult; reported = layoutOf.compactUtilization;
      const m = evaluate(layoutOf, { gap: c.config.part_clearance + c.config.kerf_width, margin: c.config.sheet_margin, minRemnant: c.config.min_remnant_size });
      rows.push({ version, seed, ms: r.ms, reported, ...m });
    }
  }
  console.log(`\n=== ${label} (${c.iterations} aval., ${c.seeds} sementes) ===`);
  console.log('versão  seed   tempo  KPI_do_motor  peças  útil_líq%  retalho_útil_total  maior_retalho        nº  envelope%');
  for (const x of rows) console.log(`${x.version.padEnd(7)} ${String(x.seed).padEnd(5)} ${(x.ms / 1000).toFixed(1).padStart(5)}s ${String(x.reported + '%').padStart(10)}  ${String(x.placed).padStart(5)}  ${String(x.netUtilPct).padStart(8)}  ${String(x.usableRemnantMm2).padStart(16)}  ${(x.largestRemnantMm2 + ' (' + x.largestRemnantDim + ')').padEnd(20)} ${String(x.remnantCount).padStart(2)}  ${String(x.envelopeUtilPct).padStart(8)}`);
  const agg = {};
  for (const x of rows) { (agg[x.version] ||= []).push(x); }
  for (const [v, a] of Object.entries(agg)) {
    const avg = (k) => (a.reduce((s, x) => s + x[k], 0) / a.length);
    console.log(`  média ${v.padEnd(5)} KPI_motor=${avg('reported').toFixed(2)}%  retalho_útil_total=${Math.round(avg('usableRemnantMm2'))}  maior_retalho=${Math.round(avg('largestRemnantMm2'))}  envelope=${avg('envelopeUtilPct').toFixed(1)}%`);
  }
  return rows;
}

module.exports = { runCase, sheetDxf };

if (require.main === module) {
  (async () => {
    const BIG = { sheetWidth: 1200, sheetHeight: 800, kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, min_hole_size: 60, min_remnant_size: 100 };
    await runCase('A) trueshape 1200x800 (imagens 1 e 2)', { parts: 'trueshape', config: BIG, iterations: 3000, seeds: 3, versions: ['V5', 'V5.1'] });
    const S = sheetDxf(1072.695, 544.456, [[34, 375.5, 237, 135], [810, 76.5, 90, 95]]);
    await runCase('B) industrial + chapa 1072x544 c/ 2 furos (imagens 5 e 6)', { parts: 'industrial', sheetDxf: S, config: { ...BIG, sheetWidth: 1072.695, sheetHeight: 544.456 }, iterations: 1500, seeds: 3, versions: ['V5', 'V5.1'] });
  })();
}
