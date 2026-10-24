// bench/equivalencia.js — prova de equivalência exata entre versões do motor (mesmos layouts, posição a posição).
//
//   node bench/equivalencia.js gerar antes.json      (na versão antiga)
//   node bench/equivalencia.js gerar depois.json     (na versão nova)
//   node bench/equivalencia.js comparar antes.json depois.json
//
// Use para mudanças que NÃO deveriam alterar o resultado (otimizações de desempenho, refatorações).
'use strict';
const fs = require('fs');
const path = require('path');

const BASE = { sheetWidth: 1200, sheetHeight: 800, kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, total_iterations: 400, min_hole_size: 60, min_remnant_size: 100 };
const CASES = [
  ['icamento', null, 2, { ...BASE, sheetWidth: 180, sheetHeight: 120 }],
  ['trueshape', null, 1, BASE], ['industrial', null, 2, BASE], ['industrial', 'sheet_ramp_hole', 1, BASE],
  ['trueshape', 'sheet_stepped', 1, BASE], ['icamento', null, 6, { ...BASE, sheetWidth: 400, sheetHeight: 300, grain_restriction: 'FREE_45' }]
];

async function gerar(out) {
  const { runPreset } = require(path.join(__dirname, '..', 'test', 'harness'));
  const res = {};
  for (const [parts, sheet, qty, cfg] of CASES) {
    for (const seed of [1, 2]) {
      const t0 = Date.now();
      const r = await runPreset({ parts, sheet, qty, config: { ...cfg, seed_offset: seed } });
      const b = r.done.bestResult;
      const key = `${parts}|${sheet}|${qty}|${seed}`;
      res[key] = { ms: Date.now() - t0, placed: b.placedParts.map(p => [p.id, p.x, p.y, p.angle]).sort(), util: b.rawUtilization, ok: b.validation.ok };
      console.log(key, `${res[key].ms} ms`, `${res[key].util}%`, res[key].ok ? 'válido' : 'REPROVADO');
    }
  }
  fs.writeFileSync(out, JSON.stringify(res, null, 1));
}

function comparar(a, b) {
  const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
  let diff = 0;
  for (const k of Object.keys(A)) {
    const eq = B[k] && JSON.stringify(A[k].placed) === JSON.stringify(B[k].placed);
    if (!eq) diff++;
    console.log(eq ? 'IGUAL ' : 'DIFERE', k, `${A[k].ms} → ${B[k] ? B[k].ms : '?'} ms`);
  }
  console.log(diff ? `${diff} caso(s) diferente(s)` : 'todos os layouts idênticos');
  process.exit(diff ? 1 : 0);
}

const [cmd, x, y] = process.argv.slice(2);
if (cmd === 'gerar' && x) gerar(x).then(() => process.exit(0));
else if (cmd === 'comparar' && x && y) comparar(x, y);
else { console.log('uso: gerar <saida.json> | comparar <a.json> <b.json>'); process.exit(2); }
