// bench/multichapa.js — lote que precisa de várias chapas: motor clássico × Automático (sparrow), mesmo tempo por chapa.
//
//   node bench/multichapa.js [--time 20] [--only trueshape10,industrial6]
//
// Mede, fora do motor: chapas usadas, aproveitamento do conjunto (área das peças ÷ área das chapas usadas), peças que
// faltaram e o maior retalho da ÚLTIMA chapa (a sobra que volta ao estoque). Cada chapa passa pelo validador.
// Saída: bench/results/multichapa_<versão>_<tempo>s.json + tabela no terminal.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const TIME = Number(opt('time', 20));
const FIX = (n) => fs.readFileSync(path.join(ROOT, 'test', 'fixtures', n));
const CASES = {
  trueshape10: { preset: 'trueshape', mult: 10, sheet: [1200, 800], extra: { min_hole_size: 60, min_remnant_size: 100 } },
  industrial6: { preset: 'industrial', mult: 6, sheet: [1200, 800], extra: { min_hole_size: 60, min_remnant_size: 100 } },
  modelo1x3: { file: 'Modelo_1_c_moldura.dxf', mult: 3, sheet: [2000, 1200], extra: {} },
  modelo2x3: { file: 'Modelo_2_c_moldura.dxf', mult: 3, sheet: [3000, 1200], extra: {} }
};
const only = (opt('only', '') || Object.keys(CASES).join(',')).split(',');

(async () => {
  const express = require('express');
  const orig = express.application.listen;
  let server;
  express.application.listen = function () { server = orig.call(this, 0, () => {}); return server; };
  require(path.join(ROOT, 'index.js'));
  express.application.listen = orig;
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const rows = [];
  for (const name of only) {
    const c = CASES[name];
    if (!c) continue;
    const fd = new FormData();
    const buf = c.file ? FIX(c.file) : Buffer.from(require(path.join(ROOT, 'presets')).buildSampleDxf(c.preset));
    fd.append('dxfFile', new Blob([buf]), (c.file || c.preset + '.dxf'));
    const up = await (await fetch(base + '/api/upload-dxf', { method: 'POST', body: fd })).json();
    const quantities = {};
    for (const p of up.catalogParts) quantities[p.id] = (p.quantity_detected || 1) * c.mult;
    for (const engine of ['CLASSICO', 'AUTO']) {
      const job = await post('/api/start-job', { uploadId: up.uploadId, quantities, config: {
        sheet_width: c.sheet[0], sheet_height: c.sheet[1], kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6,
        engine, external_time_s: TIME, time_limit_s: TIME, total_iterations: 250000, stock_full_sheets: 12, seed_offset: 1, ...c.extra } });
      const t0 = Date.now();
      const txt = await (await fetch(`${base}/api/stream/${job.jobId}`)).text();
      const msgs = txt.split('\n\n').map(b => b.replace(/^data: /, '')).filter(b => b.startsWith('{')).map(b => JSON.parse(b));
      const d = msgs.find(m => m.type === 'done');
      if (!d) { console.log(name, engine, 'sem resultado', msgs.find(m => m.type === 'error')); continue; }
      const sheets = d.multi ? d.sheets : [{ bestResult: d.bestResult, engine: d.engine }];
      const valid = sheets.every(s => s.bestResult.validation && s.bestResult.validation.ok);
      const used = sheets.reduce((s, x) => s + x.bestResult.usedArea, 0);
      const area = sheets.reduce((s, x) => s + x.bestResult.sheetArea, 0);
      const last = sheets[sheets.length - 1].bestResult;
      const row = {
        caso: name, motor: engine, pecas: job.expandedCount, chapas: sheets.length,
        aproveitamento: +(used / area * 100).toFixed(2),
        faltaram: d.multi ? d.unplacedParts.length : d.bestResult.unplacedParts.length,
        ultima_chapa_maior_retalho_m2: +((last.largestRemnantArea || 0) / 1e6).toFixed(3),
        ultima_chapa_comprimento_mm: +(last.stripLength || 0).toFixed(1),
        motores_por_chapa: sheets.map(s => s.engine === 'SPARROW' ? 'S' : 'C').join(''),
        validas: valid, segundos: +((Date.now() - t0) / 1000).toFixed(1)
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
  server.close();
  const pkg = require(path.join(ROOT, 'package.json'));
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  const out = path.join(__dirname, 'results', `multichapa_v${pkg.version}_${TIME}s.json`);
  fs.writeFileSync(out, JSON.stringify({ versao: pkg.version, data: new Date().toISOString(), tempo_por_chapa_s: TIME,
    cpu: require('os').cpus()[0] && require('os').cpus()[0].model, linhas: rows }, null, 1) + '\n');
  console.table(rows);
  console.log('salvo em', path.relative(ROOT, out));
  process.exit(rows.every(r => r.validas) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
