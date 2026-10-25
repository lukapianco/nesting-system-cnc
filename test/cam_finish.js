// test/cam_finish.js — acabamento do corte e relatório (passo 4, ADR 011): node test/cam_finish.js
// Saída de corte, sobrepasse e microjuntas NÃO foram testados em máquina; aqui se testa a geometria e o arquivo.
'use strict';
const assert = require('assert');
const { runPreset } = require('./harness');
const { planCam } = require('../camPlanner');
const { normalizeNestingParams } = require('../typesAndInterfaces');
const { validateLayout } = require('../validator');
const { buildDxf } = require('../dxfWriter');
const { buildReportPdf, pdfText } = require('../pdfReport');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✖ ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}
const BASE = { kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100, engine: 'CLASSICO', total_iterations: 300 };
const clone = (o) => JSON.parse(JSON.stringify(o));
/** Entidades do DXF por camada: [{layer, closed}] */
function entities(dxf) {
  const L = dxf.split(/\r?\n/); const out = [];
  const s = L.findIndex((l, i) => l.trim() === 'ENTITIES' && L[i - 1].trim() === '2');
  let cur = null;
  for (let i = s + 1; i < L.length - 1; i += 2) {
    const c = L[i].trim(), v = L[i + 1].trim();
    if (c === '0') { if (cur) out.push(cur); cur = (v === 'POLYLINE' || v === 'LINE' || v === 'TEXT') ? { type: v, layer: null, closed: false } : null; }
    else if (cur && c === '8' && cur.layer == null) cur.layer = v;
    else if (cur && cur.type === 'POLYLINE' && c === '70') cur.closed = (Number(v) & 1) === 1;
  }
  return out;
}

(async () => {
  console.log('\n[ACABAMENTO] saída, sobrepasse, microjuntas, DXF e relatório');
  const r = await runPreset({ parts: 'trueshape', qty: 2, config: BASE });
  const lay = r.done.bestResult;
  const P0 = normalizeNestingParams(r.job.normalizedConfig);
  const P = normalizeNestingParams({ ...r.job.normalizedConfig, lead_out_length: 4, overburn_length: 1, tab_width: 1.5, tabs_per_part: 2 });
  const fin = clone(lay); planCam(fin, P);

  await test('padrão desligado: sem saída, sobrepasse nem microjunta (o corte é o mesmo de antes)', () => {
    const a = clone(lay); planCam(a, P0);
    assert(a.cam.ops.every(o => !o.leadOutPath && !o.overburnPath && !o.tabs));
    assert.deepStrictEqual([a.cam.metrics.leadOutLength, a.cam.metrics.tabCount, a.cam.metrics.overburnLength], [0, 0, 0]);
  });
  await test('ligado: toda operação tem sobrepasse; saída onde há espaço; 2 microjuntas por peça; validador aprova', () => {
    assert(fin.cam.ops.every(o => o.overburnPath && o.overburnPath.length >= 2));
    const withOut = fin.cam.ops.filter(o => o.leadOutPath).length;
    assert.strictEqual(withOut + fin.cam.metrics.leadOutsWithoutSpace, fin.cam.ops.length);
    const outers = fin.cam.ops.filter(o => o.kind === 'OUTER');
    assert(outers.every(o => o.tabs && o.tabs.length === 2), 'cada peça com 2 microjuntas');
    assert(fin.cam.ops.filter(o => o.kind === 'HOLE').every(o => !o.tabs), 'furo não leva microjunta');
    const v = validateLayout(fin, P, {});
    assert(v.ok, v.errors.map(e => e.msg).join(' | '));
    assert.strictEqual(fin.cam.finishing.testedOnMachine, false);
  });
  await test('"só em peças até X mm": peças maiores ficam sem microjunta', () => {
    const big = Math.max(...lay.placedParts.map(p => Math.max(p.placedWidth, p.placedHeight)));
    const small = Math.min(...lay.placedParts.map(p => Math.max(p.placedWidth, p.placedHeight)));
    const lim = (big + small) / 2;
    const b = clone(lay); planCam(b, normalizeNestingParams({ ...r.job.normalizedConfig, tab_width: 1.5, tabs_per_part: 2, tab_max_part_size: lim }));
    for (const o of b.cam.ops.filter(x => x.kind === 'OUTER')) {
      const p = b.placedParts.find(q => q.id === o.partId);
      const m = Math.max(p.placedWidth, p.placedHeight);
      assert.strictEqual(!!(o.tabs && o.tabs.length), m <= lim, `${p.name} (${m.toFixed(0)} mm)`);
    }
  });
  await test('validador independente pega saída sobre peça e microjunta fora do contorno', () => {
    const bad = clone(fin);
    const op = bad.cam.ops.find(o => o.leadOutPath && o.kind === 'OUTER');
    const other = bad.placedParts.find(p => p.id !== op.partId && !p.nestedInsideHole);
    op.leadOutPath.push({ x: other.x + other.placedPoints[0].x * 0.5 + other.placedWidth / 2, y: other.y + other.placedHeight / 2 });
    const ins = { x: other.x + other.placedWidth / 2, y: other.y + other.placedHeight / 2 };
    op.leadOutPath[op.leadOutPath.length - 1] = ins;
    const t = bad.cam.ops.find(o => o.tabs).tabs[0];
    t.start = { x: t.start.x + 5, y: t.start.y + 5 };
    const v = validateLayout(bad, P, {});
    const codes = v.errors.map(e => e.type);
    assert(codes.includes('MICROJUNTA_FORA_DO_CONTORNO'), codes.join(','));
    assert(codes.includes('SAIDA_EM_MATERIAL'), codes.join(','));
  });
  await test('DXF: padrão sem as camadas novas; opções acrescentam 6_CAM_SAIDA e 7_MICROJUNTAS; "abrir nas juntas" parte o contorno', () => {
    const def = entities(buildDxf(fin));
    assert(!def.some(e => /^(6_CAM_SAIDA|7_MICROJUNTAS)$/.test(e.layer)));
    assert(def.filter(e => e.layer === '1_CORTE_PECAS').every(e => e.closed), 'padrão: contorno fechado');
    const all = entities(buildDxf(fin, { includeLeadOut: true, includeTabs: true }));
    assert(all.some(e => e.layer === '6_CAM_SAIDA') && all.filter(e => e.layer === '7_MICROJUNTAS').length === fin.cam.metrics.tabCount);
    const open = entities(buildDxf(fin, { openAtTabs: true }));
    const outerOpen = open.filter(e => e.layer === '1_CORTE_PECAS' || e.layer === '1_PECA_IN_HOLE');
    assert(outerOpen.every(e => !e.closed), 'aberto nas juntas');
    assert.strictEqual(outerOpen.length, fin.cam.metrics.tabCount, 'um trecho entre cada par de juntas');
  });
  await test('relatório PDF: arquivo PDF válido, uma página por chapa e uma de resumo; texto com acento e parênteses', async () => {
    const pdf = buildReportPdf([{ layout: fin, label: 'chapa (1)' }, { layout: fin, label: 'retalho' }], { fileName: 'peças.dxf', summary: { utilization: 70, placed: 20, totalParts: 20, unplaced: 0 } });
    const s = pdf.toString('latin1');
    assert(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF'));
    assert.strictEqual((s.match(/\/Type \/Page /g) || []).length, 3);
    assert(s.includes('pe\xE7as.dxf'), 'acento em WinAnsi');
    assert.strictEqual(pdfText('a(b)c\\'), 'a\\(b\\)c\\\\');
    const xref = Number(s.match(/startxref\n(\d+)/)[1]);
    assert(s.slice(xref).startsWith('xref'), 'tabela xref no lugar certo');
  });
  await test('relatório pela API: /api/report-pdf devolve application/pdf', async () => {
    const express = require('express');
    const orig = express.application.listen; let server;
    express.application.listen = function () { server = orig.call(this, 0, () => {}); return server; };
    require('../index.js');
    express.application.listen = orig;
    await new Promise(res => (server.listening ? res() : server.once('listening', res)));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/report-pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheets: [{ layout: fin, label: 'chapa' }] }) });
      assert.strictEqual(res.status, 200);
      assert(/application\/pdf/.test(res.headers.get('content-type')));
      assert((await res.arrayBuffer()).byteLength > 1000);
      const bad = await fetch(`http://127.0.0.1:${server.address().port}/api/report-pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheets: [] }) });
      assert.strictEqual(bad.status, 400);
    } finally { server.close(); }
  });

  console.log(`\n${passed} aprovados, ${failed} reprovados`);
  process.exit(failed ? 1 : 0);
})();
