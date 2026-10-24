// test/multi_sheet.js — várias chapas e retalhos no mesmo cálculo (ADR 009): node test/multi_sheet.js
// Roda pela API (como a tela). Sem o executável do sparrow, as chapas usam o motor clássico; com ele, o Automático.
'use strict';
const assert = require('assert');
const { buildStock, partFitsSheet } = require('../engine/multiSheet');
const { normalizeNestingParams } = require('../typesAndInterfaces');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✖ ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}

(async () => {
  console.log('\n[VÁRIAS CHAPAS] ordem do estoque e pulo de chapa inútil');
  await test('ordem: chapa desenhada, retalhos do menor para o maior, chapas inteiras', () => {
    const st = buildStock({ isCustomDxf: true, width: 2000, height: 1000 }, {
      sheet_width: 3000, sheet_height: 1500, stock_full_sheets: 2,
      stock_remnants: [{ width: 800, height: 600, quantity: 2 }, { width: 400, height: 300 }]
    });
    assert.deepStrictEqual(st.map(s => s.kind), ['desenhada', 'retalho', 'retalho', 'retalho', 'chapa', 'chapa']);
    assert.deepStrictEqual(st.slice(1, 4).map(s => `${s.width}x${s.height}`), ['400x300', '800x600', '800x600']);
    assert.deepStrictEqual(st.map(s => s.index), [0, 1, 2, 3, 4, 5]);
  });
  await test('compatível com antes: sem estoque = a chapa da tela; com chapa desenhada e nada pedido = só ela', () => {
    assert.deepStrictEqual(buildStock(null, { sheet_width: 1200, sheet_height: 800 }).map(s => s.label), ['chapa 1200 × 800']);
    assert.deepStrictEqual(buildStock(null, { sheet_width: 1200, sheet_height: 800, stock_full_sheets: 0 }).map(s => s.kind), ['chapa']);
    assert.deepStrictEqual(buildStock({ isCustomDxf: true, width: 900, height: 500 }, {}).map(s => s.kind), ['desenhada']);
  });
  await test('peça que não cabe pela caixa (nem girada, se o giro é permitido) pula a chapa', () => {
    const cfg = normalizeNestingParams({ sheet_margin: 5, kerf_width: 0, allow_rotation: true, grain_restriction: 'NONE' });
    const spec = { width: 410, height: 210 };
    assert(partFitsSheet({ width: 400, height: 200 }, spec, cfg));
    assert(partFitsSheet({ width: 200, height: 400 }, spec, cfg), 'girada a 90° cabe');
    assert(!partFitsSheet({ width: 401, height: 200 }, spec, cfg));
    const fixo = normalizeNestingParams({ sheet_margin: 5, kerf_width: 0, allow_rotation: false });
    assert(!partFitsSheet({ width: 200, height: 400 }, spec, fixo), 'sem giro não cabe');
  });
  await test('estoque inválido é limpo: medidas absurdas e quantidade 0 saem, no máximo 50 por linha', () => {
    const c = normalizeNestingParams({ stock_remnants: [{ width: 5, height: 300 }, { width: 500, height: 300, quantity: 0 }, { width: 500, height: 300, quantity: 999 }, 'lixo'] });
    assert.deepStrictEqual(c.stock_remnants.map(r => [r.width, r.height, r.quantity]), [[500, 300, 50]]);
  });

  console.log('\n[VÁRIAS CHAPAS] cálculo completo pela API');
  const express = require('express');
  const orig = express.application.listen;
  let server;
  express.application.listen = function () { server = orig.call(this, 0, () => {}); return server; };
  require('../index.js');
  express.application.listen = orig;
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const fd = new FormData();
  fd.append('dxfFile', new Blob([require('../presets').buildSampleDxf('trueshape')]), 'trueshape.dxf');
  const up = await (await fetch(base + '/api/upload-dxf', { method: 'POST', body: fd })).json();
  const quantities = {};
  for (const p of up.catalogParts) quantities[p.id] = (p.quantity_detected || 1) * 4;
  const run = async (stockCfg, engine = 'CLASSICO') => {
    const job = await post('/api/start-job', { uploadId: up.uploadId, quantities, config: {
      sheet_width: 1200, sheet_height: 800, kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, min_hole_size: 60, min_remnant_size: 100,
      engine, external_time_s: 4, total_iterations: 400, ...stockCfg } });
    const txt = await (await fetch(`${base}/api/stream/${job.jobId}`)).text();
    const msgs = txt.split('\n\n').map(b => b.replace(/^data: /, '')).filter(b => b.startsWith('{')).map(b => JSON.parse(b));
    return { job, msgs, done: msgs.find(m => m.type === 'done'), error: msgs.find(m => m.type === 'error') };
  };
  try {
    await test('24 peças, 1 retalho 600×400 + 3 chapas: retalho primeiro, cada chapa válida, nenhuma peça repetida ou perdida', async () => {
      const { job, done, error, msgs } = await run({ stock_full_sheets: 3, stock_remnants: [{ width: 600, height: 400, quantity: 1 }] });
      assert(!error, error && error.error);
      assert.deepStrictEqual(job.stock.map(s => s.kind), ['retalho', 'chapa', 'chapa', 'chapa']);
      assert(done && done.multi, 'resposta sem multi');
      assert.strictEqual(done.sheets[0].kind, 'retalho', 'o retalho tem que ser usado primeiro');
      const seen = new Set();
      for (const sh of done.sheets) {
        assert(sh.bestResult.validation.ok, `chapa ${sh.index}: ` + sh.bestResult.validation.errors.map(e => e.msg).join(' | '));
        for (const p of sh.bestResult.placedParts) { assert(!seen.has(p.id), `peça ${p.id} em duas chapas`); seen.add(p.id); }
        if (sh.kind === 'retalho') assert.deepStrictEqual([sh.bestResult.sheetWidth, sh.bestResult.sheetHeight], [600, 400]);
      }
      assert.strictEqual(seen.size + done.unplacedParts.length, job.expandedCount, 'contabilidade das peças');
      assert.strictEqual(done.summary.placed, seen.size);
      assert(msgs.some(m => m.type === 'sheet-start'), 'a tela não soube que chapa estava calculando');
    });
    await test('estoque que acaba: o que sobrou volta como "faltaram", com as chapas usadas válidas', async () => {
      const { job, done } = await run({ stock_full_sheets: 0, stock_remnants: [{ width: 600, height: 400, quantity: 1 }, { width: 500, height: 500, quantity: 1 }] });
      assert(done && done.multi);
      assert(done.unplacedParts.length > 0, 'com só dois retalhos, sobra peça');
      assert(done.sheets.every(sh => sh.bestResult.validation.ok));
      assert.strictEqual(done.summary.placed + done.unplacedParts.length, job.expandedCount);
    });
    await test('retalho pequeno demais para qualquer peça é pulado sem calcular', async () => {
      const { done } = await run({ stock_full_sheets: 2, stock_remnants: [{ width: 60, height: 40, quantity: 1 }] });
      assert(done.skipped.some(k => k.kind === 'retalho' && /nenhuma peça/.test(k.why)), JSON.stringify(done.skipped));
      assert(!done.sheets.some(sh => sh.kind === 'retalho'));
    });
    if (require('../engine/sparrowBridge').findSparrowBinary()) {
      await test('Automático com o sparrow: retalho + chapas, todas válidas, nada repetido', async () => {
        const { job, done } = await run({ stock_full_sheets: 3, stock_remnants: [{ width: 600, height: 400, quantity: 1 }] }, 'AUTO');
        assert(done && done.multi);
        const seen = new Set();
        for (const sh of done.sheets) {
          assert(sh.bestResult.validation.ok, sh.bestResult.validation.errors.map(e => e.msg).join(' | '));
          for (const p of sh.bestResult.placedParts) { assert(!seen.has(p.id)); seen.add(p.id); }
        }
        assert.strictEqual(seen.size + done.unplacedParts.length, job.expandedCount);
        assert(done.sheets.some(sh => sh.engine === 'SPARROW'), 'nenhuma chapa usou o sparrow');
      });
    }
  } finally { server.close(); }

  console.log(`\n${passed} aprovados, ${failed} reprovados`);
  process.exit(failed ? 1 : 0);
})();
