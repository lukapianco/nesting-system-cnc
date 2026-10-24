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

    await test('lote maior que a chapa: volta para o motor clássico e explica o motivo', async () => {
      const r = await runPreset({ parts: 'icamento', qty: 12, config: { ...SMALL, engine: 'AUTO' }, hardware: HW });
      assert.strictEqual(r.done.engine, 'CLASSICO');
      assert(/não cabem|chapa/.test(r.done.engineNote || ''), `nota: ${r.done.engineNote}`);
      checkLayout(r);
    });

    await test('chapa desenhada (irregular): motor clássico com aviso', async () => {
      const r = await runPreset({ parts: 'trueshape', sheet: 'sheet_stepped', qty: 1, config: { ...BIG, engine: 'AUTO' }, hardware: HW });
      assert.strictEqual(r.done.engine, 'CLASSICO');
      assert(/chapa desenhada/.test(r.done.engineNote || ''), `nota: ${r.done.engineNote}`);
      checkLayout(r);
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
