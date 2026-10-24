// test/engine_sparrow.js — otimizador externo prumo-sparrow (ADR 006): node test/engine_sparrow.js
// Sem o executável (native/prumo-sparrow não compilado e PRUMO_SPARROW_BIN vazio), só o caminho de reserva é testado.
'use strict';
const assert = require('assert');
const { runPreset } = require('./harness');
const S = require('../engine/sparrowBridge');
const { buildDxf } = require('../dxfWriter');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✖ ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}

const HW = { totalCores: 2, maxWorkers: 1 };
const SMALL = { sheetWidth: 180, sheetHeight: 120, kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, total_iterations: 300, external_time_s: 3 };
const BIG = { ...SMALL, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100 };

function checkLayout(r) {
  const b = r.done.bestResult;
  assert(b, 'sem layout');
  assert.strictEqual(b.placedParts.length + b.unplacedParts.length, r.job.expandedParts.length, 'contabilidade de peças');
  assert(b.validation.ok, 'validação reprovou: ' + b.validation.errors.map(e => e.msg).join(' | '));
  assert.strictEqual(b.cam.metrics.invalidLeads, 0, 'lead-in sem espaço');
  return b;
}

/** Leitor "ingênuo" do DXF exportado: conta contornos fechados de nível par (peças) por contenção. */
function naivePartCount(dxf) {
  const L = dxf.split(/\r?\n/);
  const rings = [];
  let cur = null, inVertex = false;
  for (let i = 0; i < L.length - 1; i += 2) {
    const c = L[i].trim(), v = L[i + 1].trim();
    if (c === '0') {
      inVertex = v === 'VERTEX';
      if (v === 'POLYLINE') cur = [];
      else if (v === 'SEQEND') { if (cur && cur.length > 2) rings.push(cur); cur = null; }
    } else if (cur && inVertex && c === '10') cur.push({ x: +v, y: 0 });
    else if (cur && inVertex && c === '20') cur[cur.length - 1].y = +v;
  }
  const pip = (p, r) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };
  return rings.filter(r => rings.filter(o => o !== r && pip(r[0], o)).length % 2 === 0).length;
}

(async () => {
  const bin = S.findSparrowBinary();
  console.log(`\n[SPARROW] executável: ${bin || 'não encontrado — testando só a reserva para o motor clássico'}`);

  if (bin) {
    await test('icamento x2 (Automático): sparrow posiciona, buchas seguem nos furos dos olhais, layout válido', async () => {
      const r = await runPreset({ parts: 'icamento', qty: 2, config: { ...SMALL, engine: 'AUTO' }, hardware: HW });
      assert.strictEqual(r.done.engine, 'SPARROW', `motor usado: ${r.done.engine} (${r.done.engineNote})`);
      const b = checkLayout(r);
      assert.strictEqual(b.unplacedParts.length, 0);
      assert(b.inHoleCount >= 2, `filhas In-Hole: ${b.inHoleCount}`);
      assert(r.done.topArchive.length >= 1 && r.done.topArchive.every(a => a.validation.ok), 'alternativas reprovadas');
    });

    for (const parts of ['trueshape', 'industrial']) {
      await test(`${parts} 1200×800 (SPARROW): layout válido, todas as peças, exportação lida igual`, async () => {
        const r = await runPreset({ parts, qty: 1, config: { ...BIG, engine: 'SPARROW' }, hardware: HW });
        assert.strictEqual(r.done.engine, 'SPARROW', `motor usado: ${r.done.engine} (${r.done.engineNote})`);
        const b = checkLayout(r);
        assert.strictEqual(b.unplacedParts.length, 0);
        assert.strictEqual(naivePartCount(buildDxf(b)), b.placedParts.length, 'leitor ingênuo contou outro número de peças');
      });
    }

    await test('fibra X: sparrow só usa 0° e 180°', async () => {
      const r = await runPreset({ parts: 'industrial', qty: 1, config: { ...BIG, engine: 'SPARROW', grain_restriction: 'GRAIN_X' }, hardware: HW });
      const b = checkLayout(r);
      assert(b.placedParts.filter(p => !p.nestedInsideHole).every(p => [0, 180].includes(p.angle)), 'ângulo proibido');
    });

    await test('"Parar e manter o melhor": encerra cedo e entrega layout válido', async () => {
      const r = await runPreset({ parts: 'trueshape', qty: 1, config: { ...BIG, engine: 'SPARROW', external_time_s: 60 }, hardware: HW, stopAfterMs: 1500 });
      assert.strictEqual(r.done.engine, 'SPARROW');
      assert(r.done.stoppedByUser, 'não registrou a parada');
      assert(r.ms < 20000, `demorou ${r.ms} ms para parar`);
      checkLayout(r);
    });

    await test('cancelar o job (fechar o stream, como ao trocar peça/chapa na tela) encerra o processo do sparrow', async () => {
      const http = require('http');
      const { execSync } = require('child_process');
      // processos vivos (um zumbi já encerrado, à espera de ser recolhido, não consome CPU e não conta).
      // Windows não tem ps nem zumbi: conta pelo tasklist (V5.7; antes o teste falhava lá por falta do ps)
      const win = process.platform === 'win32';
      const count = () => win
        ? execSync('tasklist /FI "IMAGENAME eq prumo-sparrow.exe" /FO CSV /NH', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/).filter(l => /prumo-sparrow/i.test(l)).length
        : Number(execSync("ps -eo stat=,comm= | grep -v '^Z' | grep -c 'prumo-sparrow' || true").toString().trim());
      const zombies = () => win ? 0 : Number(execSync("ps -eo stat=,comm= | grep '^Z' | grep -c 'prumo-sparrow' || true").toString().trim());
      const before = count(), zBefore = zombies();
      const express = require('express');
      const orig = express.application.listen;
      let server;
      express.application.listen = function () { server = orig.call(this, 0, () => {}); return server; };
      delete require.cache[require.resolve('../index.js')];
      require('../index.js');
      express.application.listen = orig;
      await new Promise(r => (server.listening ? r() : server.once('listening', r)));
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
      const fd = new FormData();
      fd.append('dxfFile', new Blob([require('../presets').buildSampleDxf('trueshape')]), 'trueshape.dxf');
      const up = await (await fetch(base + '/api/upload-dxf', { method: 'POST', body: fd })).json();
      const job = await post('/api/start-job', { uploadId: up.uploadId, config: { ...BIG, engine: 'SPARROW', external_time_s: 60 } });
      const req = http.get(`${base}/api/stream/${job.jobId}`);
      await new Promise(r => setTimeout(r, 2500));
      const during = count();
      req.destroy();
      await new Promise(r => setTimeout(r, 1500));
      const after = count(), zAfter = zombies();
      const hw = await (await fetch(base + '/api/hardware')).json();
      server.close();
      assert.strictEqual(hw.externalOptimizer.running, 0, `o servidor ainda acha que há ${hw.externalOptimizer.running} processo(s) do otimizador rodando`);
      assert(during > before, `o sparrow não chegou a rodar (${before} → ${during})`);
      assert.strictEqual(after, before, `processo do sparrow continuou rodando depois do cancelamento (${after} > ${before})`);
      assert.strictEqual(zAfter, zBefore, 'o cancelamento deixou um processo zumbi (o worker não recolheu o filho)');
    });

    await test('lote maior que a chapa: volta para o motor clássico e explica o motivo', async () => {
      const r = await runPreset({ parts: 'icamento', qty: 12, config: { ...SMALL, engine: 'AUTO' }, hardware: HW });
      assert.strictEqual(r.done.engine, 'CLASSICO');
      assert(/não cabem|chapa/.test(r.done.engineNote || ''), `nota: ${r.done.engineNote}`);
      checkLayout(r);
    });

    for (const [parts, sheet, qty] of [['trueshape', 'sheet_stepped', 1], ['industrial', 'sheet_ramp_hole', 1], ['icamento', 'sheet_ramp_hole', 3]]) {
      await test(`chapa desenhada ${sheet} (${parts} ×${qty}): sparrow com contorno e furos da chapa como obstáculos, layout válido`, async () => {
        const r = await runPreset({ parts, sheet, qty, config: { ...BIG, engine: 'AUTO' }, hardware: HW });
        assert.strictEqual(r.done.engine, 'SPARROW', `motor usado: ${r.done.engine} (${r.done.engineNote})`);
        const b = checkLayout(r);
        assert.strictEqual(b.unplacedParts.length, 0);
        assert(b.sheetPoly && b.sheetPoly.length > 3, 'layout sem o contorno da chapa');
      });
    }

    const sig = (b) => b.placedParts.map(p => `${p.id}@${p.x.toFixed(3)},${p.y.toFixed(3)},${p.angle}`).sort().join(';');
    await test('modo reproduzível: mesma semente = mesmo plano, mesmo com outro número de threads no servidor (ADR 008)', async () => {
      const cfg = { ...BIG, engine: 'SPARROW', reproducible: true, external_budget: 120, external_time_s: 20, seed_offset: 3 };
      const a = await runPreset({ parts: 'trueshape', config: cfg, hardware: { ...HW, threadsForJob: 2 } });
      const b = await runPreset({ parts: 'trueshape', config: cfg, hardware: { ...HW, threadsForJob: 1 } });
      for (const r of [a, b]) {
        assert.strictEqual(r.done.engine, 'SPARROW', r.done.engineNote);
        assert(r.done.search && r.done.search.reproducible, 'o orçamento de passos não terminou antes do teto de tempo: ' + JSON.stringify(r.done.search));
        checkLayout(r);
      }
      assert.strictEqual(sig(a.done.bestResult), sig(b.done.bestResult), 'mesma semente deu planos diferentes');
    });
    await test('várias buscas em paralelo: 3 sementes ao mesmo tempo, vale a melhor, layout válido', async () => {
      const r = await runPreset({ parts: 'trueshape', config: { ...BIG, engine: 'SPARROW', parallel_searches: 3, external_time_s: 4 }, hardware: { ...HW, threadsForJob: 3 } });
      assert.strictEqual(r.done.engine, 'SPARROW', r.done.engineNote);
      assert.strictEqual(r.done.search.searches, 3, JSON.stringify(r.done.search));
      checkLayout(r);
      assert(r.done.topArchive.every(x => x.validation.ok));
    });
    await test('Modelo 3: chapa já usada desenhada junto vira a chapa (5 recortes) e os 12 anéis entram nela', async () => {
      const txt = require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'Modelo_3_s_moldura.dxf'));
      const r = await runPreset({ dxfText: txt, qty: 1, importOptions: { sheetContour: 'CHAPA_1' }, config: { ...BIG, sheetWidth: 3000, sheetHeight: 1200, engine: 'AUTO', external_time_s: 6 }, hardware: HW });
      assert.strictEqual(r.done.engine, 'SPARROW', `motor usado: ${r.done.engine} (${r.done.engineNote})`);
      const b = checkLayout(r);
      assert.strictEqual(b.placedParts.length, 12);
      assert.strictEqual((b.sheetObstacles || []).length, 5, 'recortes da chapa');
    });
  }

  await test('CLASSICO explícito: nunca chama o otimizador externo e não deixa nota', async () => {
    const r = await runPreset({ parts: 'icamento', qty: 1, config: { ...SMALL, engine: 'CLASSICO' }, hardware: HW });
    assert.strictEqual(r.done.engine, 'CLASSICO');
    assert.strictEqual(r.done.engineNote, null);
    checkLayout(r);
  });

  await test('executável ausente: Automático usa o clássico e diz por quê', async () => {
    const prev = process.env.PRUMO_SPARROW_BIN;
    process.env.PRUMO_SPARROW_BIN = '/nao/existe/prumo-sparrow';
    try {
      // o worker herda o ambiente do processo; o caminho padrão (native/.../target) pode existir, então só vale sem ele
      const r = await runPreset({ parts: 'icamento', qty: 1, config: { ...SMALL, engine: 'AUTO' }, hardware: HW });
      if (r.done.engine === 'CLASSICO') assert(/não instalado/.test(r.done.engineNote || ''), `nota: ${r.done.engineNote}`);
      checkLayout(r);
    } finally {
      if (prev === undefined) delete process.env.PRUMO_SPARROW_BIN; else process.env.PRUMO_SPARROW_BIN = prev;
    }
  });

  await test('divisão de threads e sementes das buscas paralelas', () => {
    assert.deepStrictEqual([1, 2, 3, 4, 12].map(t => S.splitThreads(t)), [
      { searches: 1, workers: 1 }, { searches: 1, workers: 2 }, { searches: 1, workers: 2 }, { searches: 2, workers: 2 }, { searches: 6, workers: 2 }]);
    assert.deepStrictEqual(S.splitThreads(12, 4), { searches: 4, workers: 3 });
    assert.deepStrictEqual(S.splitThreads(2, 8), { searches: 2, workers: 1 }, 'nunca mais buscas que threads');
    assert.strictEqual(S.searchSeed(7, 0), 7, 'a primeira busca usa a semente pedida');
    const seeds = new Set(); for (let s = 1; s <= 20; s++) for (let i = 0; i < 6; i++) seeds.add(S.searchSeed(s, i));
    assert.strictEqual(seeds.size, 120, '"Calcular de novo" (semente + 1) não repete buscas');
  });
  await test('instância do otimizador: faixa = altura − 2·margem + 2·g, g = D/2 + segurança, ângulos da fibra', () => {
    const { instance, inflate } = S.buildInstance([{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }], demand: 3 }], { stripHeight: 100, gap: 6, allowedAngles: [0, 180, 360] });
    assert.strictEqual(inflate, 3 + S.SAFETY);
    assert(Math.abs(instance.strip_height - (100 + 2 * inflate)) < 1e-9);
    assert.deepStrictEqual(instance.items[0].orientation.rotation.angles, [0, 180]);
    assert.strictEqual(instance.items[0].demand, 3);
    const ring = S.transformRing([{ x: 1, y: 0 }], { rotation: 90, translation: [5, 5] });
    assert(Math.abs(ring[0].x - 5) < 1e-9 && Math.abs(ring[0].y - 6) < 1e-9);
  });

  console.log(`\n${passed} aprovados, ${failed} reprovados`);
  process.exit(failed ? 1 : 0);
})();
