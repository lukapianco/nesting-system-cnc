// test/run.js — suíte de regressão: node test/run.js  (npm test)
'use strict';
const assert = require('assert');
const http = require('http');
const DxfParser = require('dxf-parser');
const { runPreset } = require('./harness');
const { buildDxf } = require('../dxfWriter');
const cad = require('../cadParser');
const { validateLayout } = require('../validator');
const { normalizeNestingParams } = require('../typesAndInterfaces');
const { recommendParams, PROCESSES } = require('../processProfiles');
const { evaluate } = require('../bench/metrics');

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`); }
}

const signedArea = (p) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0) / 2;
const BASE = { sheetWidth: 180, sheetHeight: 120, kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, total_iterations: 300 };

(async () => {
  console.log('\n[CAD] discretização e curvas');
  await test('arco R=176,5 respeita a flecha de 0,03 mm (antes: 0,055)', () => {
    const R = 176.5, delta = 0.03;
    const pts = cad.discretizeArcAdaptive(0, 0, R, 0, Math.PI * 2, true, delta);
    let sag = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      sag = Math.max(sag, R - Math.hypot((pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2));
    }
    assert(sag <= delta + 1e-3, `flecha ${sag.toFixed(4)} > ${delta}`);
  });

  await test('NURBS cúbica com nós de Bézier reproduz a Bézier (Bernstein)', () => {
    const P = [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 40, y: 30 }, { x: 50, y: 0 }];
    const K = [0, 0, 0, 0, 1, 1, 1, 1];
    for (const u of [0.1, 0.35, 0.5, 0.8, 0.99]) {
      const b = [(1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3];
      const ex = b.reduce((s, w, i) => s + w * P[i].x, 0), ey = b.reduce((s, w, i) => s + w * P[i].y, 0);
      const r = cad.evaluateNurbsPoint(u, 3, P, K, null);
      assert(Math.hypot(r.x - ex, r.y - ey) < 1e-3, `u=${u}: (${r.x},${r.y}) != (${ex.toFixed(3)},${ey.toFixed(3)})`);
    }
  });

  await test('NURBS com 7 pontos de controle: curva contínua e dentro do casco convexo (antes: erro de 25 mm)', () => {
    const P = [{ x: 0, y: 0 }, { x: 10, y: 30 }, { x: 30, y: 35 }, { x: 50, y: 10 }, { x: 70, y: 40 }, { x: 90, y: 5 }, { x: 110, y: 0 }];
    const K = [0, 0, 0, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1];
    let prev = cad.evaluateNurbsPoint(0, 3, P, K, null), maxJump = 0;
    for (let i = 1; i <= 200; i++) {
      const q = cad.evaluateNurbsPoint(Math.min(0.99999, i / 200), 3, P, K, null);
      maxJump = Math.max(maxJump, Math.hypot(q.x - prev.x, q.y - prev.y));
      prev = q;
    }
    assert(maxJump < 3, `salto de ${maxJump.toFixed(2)} mm entre amostras vizinhas`);
    const end = cad.evaluateNurbsPoint(0.99999, 3, P, K, null);
    assert(Math.hypot(end.x - 110, end.y - 0) < 0.5, 'curva clamped deve terminar no último ponto de controle');
  });

  console.log('\n[DXF] exportação');
  await test('DXF exportado é lido pelo dxf-parser, com camadas e sem espelhar a peça "L"', () => {
    const L = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 40 }, { x: 0, y: 40 }];
    const layout = {
      sheetWidth: 100, sheetHeight: 100, remnants: [{ x: 50, y: 0, width: 50, height: 100 }],
      placedParts: [{ id: 'A', name: 'A', x: 5, y: 5, placedPoints: L, placedHoles: [] }]
    };
    const text = buildDxf(layout);
    assert(!/\n\n/.test(text.replace(/\r/g, '')), 'não pode haver linha em branco');
    const lines = text.trim().split(/\r?\n/);
    assert(lines.length % 2 === 0, 'DXF precisa ter pares código/valor (nº par de linhas)');
    for (let i = 0; i < lines.length; i += 2) assert(/^\s*-?\d+$/.test(lines[i]), `código de grupo inválido na linha ${i + 1}: "${lines[i]}"`);
    assert.strictEqual(lines[lines.length - 1], 'EOF');
    const parsed = new DxfParser().parseSync(text);
    const piece = parsed.entities.find(e => e.layer === '1_CORTE_PECAS');
    assert(piece && piece.vertices.length === 6, 'peça deve ter 6 vértices');
    assert(signedArea(piece.vertices) > 0, 'peça exportada está espelhada (área assinada negativa)');
    assert(parsed.entities.some(e => e.layer === '3_RETALHOS_UTEIS'), 'camada de retalhos ausente');
  });

  console.log('\n[MOTOR] ponta a ponta (parser → worker → CAM → validador independente)');
  const matrix = [
    ['icamento', null, 1], ['icamento', null, 2], ['trueshape', null, 1], ['industrial', null, 1],
    ['industrial', 'sheet_ramp_hole', 1], ['trueshape', 'sheet_stepped', 1]
  ];
  for (const [parts, sheet, qty] of matrix) {
    await test(`${parts}${sheet ? ' + ' + sheet : ''} x${qty}: layout válido, nenhuma peça perdida`, async () => {
      const cfg = sheet ? { ...BASE, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100 } :
        (parts === 'icamento' ? BASE : { ...BASE, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100 });
      const r = await runPreset({ parts, sheet, qty, config: cfg });
      const b = r.done.bestResult;
      assert.strictEqual(b.placedParts.length + b.unplacedParts.length, r.job.expandedParts.length, 'contabilidade de peças');
      assert(b.validation.ok, 'validação reprovou: ' + b.validation.errors.map(e => e.msg).join(' | '));
      assert.strictEqual(b.cam.metrics.invalidLeads, 0, 'há lead-in sem espaço validado');
      const holes = b.placedParts.reduce((n, p) => n + (p.placedHoles || []).length, 0);
      const outers = b.placedParts.length;
      assert.strictEqual(b.cam.ops.length, holes + outers, 'todo contorno (furos E externos) precisa de perfuração');
    });
  }

  await test('buchas 14x14 entram no furo Ø25 (Part-in-Part) com folga de furo 2 mm', async () => {
    const r = await runPreset({ parts: 'icamento', qty: 1, config: BASE });
    assert(r.done.bestResult.inHoleCount >= 2, `inHole=${r.done.bestResult.inHoleCount}`);
  });

  await test('bucha 18x18 NÃO entra no furo Ø25 (a diagonal 25,5 invadiria a parede)', async () => {
    const circle = (cx, cy, r) => `0\nCIRCLE\n8\n0\n10\n${cx}\n20\n${cy}\n40\n${r}`;
    const poly = (pts) => `0\nLWPOLYLINE\n8\n0\n90\n${pts.length}\n70\n1\n` + pts.map(([x, y]) => `10\n${x}\n20\n${y}`).join('\n');
    const dxf = `0\nSECTION\n2\nENTITIES\n${poly([[0, 0], [58, 0], [76.66, 12], [76.66, 28], [58, 40], [0, 40]])}\n${circle(52, 20, 12.5)}\n${poly([[90, 0], [108, 0], [108, 18], [90, 18]])}\n0\nENDSEC\n0\nEOF`;
    const r = await runPreset({ dxfText: dxf, qty: 1, config: { ...BASE, part_clearance: 3.0 } });
    const b = r.done.bestResult;
    assert.strictEqual(b.inHoleCount, 0, 'bucha 18x18 foi aninhada num furo Ø25');
    assert(b.validation.ok, b.validation.errors.map(e => e.msg).join(' | '));
  });

  await test('restrição de fibra GRAIN_X: nenhuma peça (nem filha) em ângulo proibido', async () => {
    const r = await runPreset({ parts: 'icamento', qty: 2, config: { ...BASE, grain_restriction: 'GRAIN_X' } });
    const b = r.done.bestResult;
    assert(b.validation.ok, b.validation.errors.map(e => e.msg).join(' | '));
    for (const p of b.placedParts) assert([0, 180].includes(p.angle), `${p.name} em ${p.angle}°`);
  });

  await test('cópias múltiplas com furos: filhas não somem nem duplicam (bug do cache de ids de furo)', async () => {
    const r = await runPreset({ parts: 'icamento', qty: 3, config: BASE });
    const b = r.done.bestResult;
    const ids = b.placedParts.map(p => p.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'ids duplicados no layout');
    assert.strictEqual(ids.length + b.unplacedParts.length, r.job.expandedParts.length);
  });

  await test('área líquida: mãe com furo não conta o furo como material aproveitado', async () => {
    const r = await runPreset({ parts: 'trueshape', qty: 1, config: { ...BASE, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100 } });
    const b = r.done.bestResult;
    const gross = b.placedParts.reduce((s, p) => s + p.area, 0);
    assert(b.usedArea < gross - 1, `usedArea=${b.usedArea} deveria ser menor que a área bruta ${gross.toFixed(1)}`);
  });

  console.log('\n[CAM] pierce e lead-in');
  await test('todos os pierces estão em sucata e a ordem é Inside-Out (furo antes do contorno da mesma peça)', async () => {
    const r = await runPreset({ parts: 'industrial', qty: 1, config: { ...BASE, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100 } });
    const b = r.done.bestResult;
    const pos = new Map();
    b.cam.ops.forEach(o => { if (o.kind === 'OUTER') pos.set(o.partId, o.seq); });
    for (const o of b.cam.ops) if (o.kind === 'HOLE') assert(o.seq < pos.get(o.partId), `furo de ${o.partName} cortado depois do contorno`);
    // filhas In-Hole antes do contorno da mãe
    for (const p of b.placedParts.filter(x => x.nestedInsideHole)) {
      assert(pos.get(p.id) < pos.get(p.inHoleParentId), `${p.name} cortada depois da mãe`);
    }
    assert(b.validation.errors.every(e => e.type !== 'PIERCE_EM_MATERIAL'));
  });

  await test('crateras de perfuração respeitam espaçamento mínimo (2R + 1 mm) e a borda da chapa', async () => {
    const r = await runPreset({ parts: 'icamento', qty: 2, config: BASE });
    const b = r.done.bestResult;
    const ps = b.cam.ops.map(o => o.pierce);
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
      assert(d >= 3.0 - 1e-6, `pierces #${i + 1} e #${j + 1} a ${d.toFixed(2)} mm`);
    }
    for (const p of ps) assert(p.x >= 3 && p.y >= 3 && p.x <= b.sheetWidth - 3 && p.y <= b.sheetHeight - 3, `pierce (${p.x.toFixed(1)},${p.y.toFixed(1)}) muito perto da borda`);
  });

  await test('validador independente detecta sobreposição e folga insuficiente (teste negativo)', () => {
    const sq = (s) => [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
    const mk = (id, x, y) => ({ id, name: id, x, y, angle: 0, placedPoints: sq(20), placedHoles: [] });
    const params = normalizeNestingParams({ kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6 });
    const overlap = validateLayout({ sheetWidth: 200, sheetHeight: 200, placedParts: [mk('A', 10, 10), mk('B', 20, 15)], unplacedParts: [] }, params);
    assert(!overlap.ok && overlap.errors.some(e => e.type === 'SOBREPOSICAO'));
    const tight = validateLayout({ sheetWidth: 200, sheetHeight: 200, placedParts: [mk('A', 10, 10), mk('B', 33, 10)], unplacedParts: [] }, params);
    assert(!tight.ok && tight.errors.some(e => e.type === 'FOLGA_INSUFICIENTE'));
    const lost = validateLayout({ sheetWidth: 200, sheetHeight: 200, placedParts: [mk('A', 10, 10)], unplacedParts: [] }, params, { expectedIds: ['A', 'B'] });
    assert(lost.errors.some(e => e.type === 'PECA_PERDIDA'));
  });

  console.log('\n[QUALIDADE] KPIs, modos e perfis');
  const ROOMY = { ...BASE, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100, total_iterations: 1500 };

  await test('KPI "aproveitamento líquido" do motor coincide com a régua independente (raster)', async () => {
    const r = await runPreset({ parts: 'trueshape', qty: 1, config: ROOMY });
    const b = r.done.bestResult;
    const m = evaluate(b, { gap: 6, margin: 6, minRemnant: 100 });
    assert(Math.abs(m.netUtilPct - b.rawUtilization) < 0.1, `motor=${b.rawUtilization}% régua=${m.netUtilPct}%`);
    // o retalho útil do motor não pode divergir mais de 5% da régua (antes a V5 inflava o KPI em ~15 pontos)
    const engineRem = b.remnants.reduce((s, x) => s + x.area, 0);
    assert(Math.abs(engineRem - m.usableRemnantMm2) / m.usableRemnantMm2 < 0.05, `retalho motor=${engineRem} régua=${m.usableRemnantMm2}`);
  });

  await test('limite de tempo encerra a otimização cedo e mantém um layout válido', async () => {
    const r = await runPreset({ parts: 'industrial', qty: 1, config: { ...ROOMY, total_iterations: 500000, time_limit_s: 2 } });
    assert(r.done.stoppedByTimeLimit, 'deveria ter parado por tempo');
    assert(r.ms < 15000, `demorou ${r.ms} ms`);
    assert(r.done.bestResult.validation.ok);
  });

  await test('perfurações: maioria em sucata aberta e deslocamento G00 coerente (kit industrial 1200x800)', async () => {
    const r = await runPreset({ parts: 'industrial', qty: 1, config: ROOMY });
    const m = r.done.bestResult.cam.metrics;
    assert(m.narrowWebPierces <= Math.ceil(m.pierceCount * 0.4), `${m.narrowWebPierces}/${m.pierceCount} em alma estreita`);
    assert(m.rapidCrossings <= 2, `${m.rapidCrossings} G00 sobre peça solta`);
    assert(m.rapidLength < 3000, `G00 de ${m.rapidLength} mm`);
  });

  await test('perfis de processo: valores válidos, ponte cresce com a espessura e kerf do plasma > laser', () => {
    for (const key of Object.keys(PROCESSES)) {
      let prev = 0;
      for (const t of [1, 3, 6, 12, 25]) {
        const p = recommendParams(key, t).params;
        for (const k of ['kerf_width', 'part_clearance', 'sheet_margin', 'lead_in_length', 'pierce_radius', 'hole_clearance', 'min_hole_size']) {
          assert(Number.isFinite(p[k]) && p[k] > 0, `${key} t=${t} ${k}=${p[k]}`);
        }
        assert(p.part_clearance >= prev, `${key}: ponte diminuiu com a espessura`);
        prev = p.part_clearance;
      }
    }
    assert(recommendParams('PLASMA', 6).params.kerf_width > recommendParams('LASER_FIBRA', 6).params.kerf_width);
    assert.throws(() => recommendParams('LASER_FIBRA', 0));
    assert.throws(() => recommendParams('XYZ', 3));
  });

  console.log('\n[SERVIDOR] HTTP + SSE + exportação');
  await test('upload → job → SSE → export-dxf devolve DXF lido pelo parser (e job com uploadId inválido dá 410)', async () => {
    process.env.PORT = '0';
    const path = require('path');
    delete require.cache[require.resolve('../index.js')];
    const origListen = require('express').application.listen;
    let server;
    require('express').application.listen = function (...args) { server = origListen.call(this, 0, () => {}); return server; };
    require('../index.js');
    require('express').application.listen = origListen;
    await new Promise(r => server.listening ? r() : server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const sample = await (await fetch(`${base}/api/sample-dxf?preset=icamento`)).text();
      const fd = new FormData(); fd.append('dxfFile', new Blob([sample]), 'p.dxf');
      const up = await (await fetch(`${base}/api/upload-dxf`, { method: 'POST', body: fd })).json();
      assert(up.uploadId, 'sem uploadId');
      const bad = await fetch(`${base}/api/start-job`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: 'nope', config: {}, quantities: {} }) });
      assert.strictEqual(bad.status, 410);
      const q = {}; up.catalogParts.forEach(p => { q[p.id] = 1; });
      const init = await (await fetch(`${base}/api/start-job`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: up.uploadId, config: { ...BASE, total_iterations: 150 }, quantities: q }) })).json();
      const stream = await fetch(`${base}/api/stream/${init.jobId}`);
      const text = await stream.text();
      const done = text.split('\n\n').map(b => b.replace(/^data: /, '')).filter(b => b.startsWith('{')).map(b => JSON.parse(b)).find(m => m.type === 'done');
      assert(done && done.bestResult.validation.ok, 'job não concluiu com validação ok');
      const exp = await fetch(`${base}/api/export-dxf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: done.bestResult, options: {} }) });
      assert.strictEqual(exp.status, 200);
      const dxf = await exp.text();
      const parsed = new DxfParser().parseSync(dxf);
      assert(parsed.entities.length > 5);
      const blocked = await fetch(`${base}/api/export-dxf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ layout: { ...done.bestResult, validation: { ok: false, errors: [{ msg: 'x' }] } } }) });
      assert.strictEqual(blocked.status, 422, 'layout reprovado deve bloquear a exportação');
      const prof = await (await fetch(`${base}/api/recommend-params?process=PLASMA&thickness=10`)).json();
      assert(prof.params && prof.params.kerf_width > 1, 'endpoint de perfis');
      assert.strictEqual((await fetch(`${base}/api/recommend-params?process=PLASMA&thickness=-1`)).status, 400);
    } finally { server.close(); }
  });

  console.log(`\n${passed} aprovados, ${failed} reprovados`);
  process.exit(failed ? 1 : 0);
})();
