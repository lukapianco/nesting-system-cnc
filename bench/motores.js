// bench/motores.js — clássico × sparrow em chapas REAIS (tamanho fixo), mesmo tempo, mesma régua.
//   node bench/motores.js [--time 10] [--seeds 3]
// KPIs de produção (não de strip packing): todas as peças na chapa? layout aprovado pelo validador? comprimento usado
// da chapa (quanto menor, maior a sobra contínua no fim) e maior retalho útil. A régua de retalhos é a mesma nos dois
// motores (bench/metrics.js), calculada fora do motor.
'use strict';
const fs = require('fs');
const path = require('path');
const { runPreset } = require('../test/harness');
const { evaluate } = require('./metrics');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1]) : d; };
const TIME = opt('time', 10), SEEDS = opt('seeds', 3);
const FIX = (n) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', n), 'utf8');
const BASE = { kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, min_hole_size: 60, min_remnant_size: 100, total_iterations: 250000, time_limit_s: TIME };
const CASES = [
  { nome: 'trueshape ×1, 1200×800', parts: 'trueshape', qty: 1, config: { sheetWidth: 1200, sheetHeight: 800 } },
  { nome: 'industrial ×1, 1200×800', parts: 'industrial', qty: 1, config: { sheetWidth: 1200, sheetHeight: 800 } },
  { nome: 'icamento ×8, 500×300', parts: 'icamento', qty: 8, config: { sheetWidth: 500, sheetHeight: 300, min_remnant_size: 40, min_hole_size: 10 } },
  { nome: 'Modelo 1 (22 peças), 2000×1200', dxfText: FIX('Modelo_1_c_moldura.dxf'), qty: 1, config: { sheetWidth: 2000, sheetHeight: 1200 } },
  { nome: 'Modelo 2 (87 gomos), 3000×1200', dxfText: FIX('Modelo_2_c_moldura.dxf'), qty: 1, config: { sheetWidth: 3000, sheetHeight: 1200 } }
];

(async () => {
  const rows = [];
  for (const c of CASES) {
    for (const engine of ['CLASSICO', 'SPARROW']) {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = await runPreset({ parts: c.parts, dxfText: c.dxfText, qty: c.qty, config: { ...BASE, ...c.config, engine, seed_offset: seed }, hardware: { totalCores: 1, maxWorkers: 1 } });
        const b = r.done.bestResult;
        const tops = b.placedParts.filter(p => !p.nestedInsideHole);
        const used = tops.reduce((m, p) => Math.max(m, p.x + p.placedWidth), 0);
        const m = evaluate(b, { gap: BASE.part_clearance + BASE.kerf_width, margin: BASE.sheet_margin, minRemnant: c.config.min_remnant_size || BASE.min_remnant_size });
        rows.push({
          caso: c.nome, motor: r.done.engine, pedido: engine, semente: seed, valido: b.validation.ok,
          pecas: `${b.placedParts.length}/${r.job.expandedParts.length}`, comprimento_usado_mm: +used.toFixed(1),
          sobra_continua_pct: +(100 * (1 - used / c.config.sheetWidth)).toFixed(1),
          maior_retalho_m2: +(m.largestRemnantMm2 / 1e6).toFixed(4), retalho_util_m2: +(m.usableRemnantMm2 / 1e6).toFixed(4), nota: r.done.engineNote || ''
        });
        const x = rows[rows.length - 1];
        console.log(`${c.nome.padEnd(32)} ${engine.padEnd(8)} s${seed}: ${x.valido ? 'válido' : 'INVÁLIDO'} ${x.pecas} usado ${x.comprimento_usado_mm} mm (sobra ${x.sobra_continua_pct}%) maior retalho ${x.maior_retalho_m2} m² ${x.motor !== engine ? '[' + x.motor + ': ' + x.nota + ']' : ''}`);
      }
    }
  }
  const out = path.join(__dirname, 'results');
  fs.mkdirSync(out, { recursive: true });
  const ver = require('../package.json').version;
  fs.writeFileSync(path.join(out, `motores_v${ver}_${TIME}s.json`), JSON.stringify({ tempo_s: TIME, sementes: SEEDS, data: new Date().toISOString(), rows }, null, 1));
  // resumo: média por caso e motor
  const groups = {};
  for (const r of rows) (groups[`${r.caso}|${r.pedido}`] = groups[`${r.caso}|${r.pedido}`] || []).push(r);
  console.table(Object.entries(groups).map(([k, rs]) => ({
    caso: k.split('|')[0], motor: k.split('|')[1], validos: `${rs.filter(r => r.valido).length}/${rs.length}`,
    todas_pecas: rs.every(r => r.pecas.split('/')[0] === r.pecas.split('/')[1]),
    usado_mm_medio: +(rs.reduce((s, r) => s + r.comprimento_usado_mm, 0) / rs.length).toFixed(1),
    maior_retalho_m2_medio: +(rs.reduce((s, r) => s + r.maior_retalho_m2, 0) / rs.length).toFixed(4),
    retalho_util_m2_medio: +(rs.reduce((s, r) => s + r.retalho_util_m2, 0) / rs.length).toFixed(4)
  })));
})().catch(e => { console.error(e); process.exit(1); });
