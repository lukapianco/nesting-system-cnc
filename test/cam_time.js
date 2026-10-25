// test/cam_time.js — sequência de corte e tempo de máquina (passo 3 do plano): node test/cam_time.js
'use strict';
const assert = require('assert');
const { runPreset } = require('./harness');
const { planCam, estimateMachineTime } = require('../camPlanner');
const { normalizeNestingParams } = require('../typesAndInterfaces');
const { validateLayout } = require('../validator');
const S = require('../engine/sparrowBridge');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✖ ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}
const BASE = { kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, sheetWidth: 1200, sheetHeight: 800, min_hole_size: 60, min_remnant_size: 100 };
const near = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg}: ${a} != ${b}`);

(async () => {
  console.log('\n[TEMPO DE MÁQUINA] estimativa e sequência de corte');
  await test('estimativa: corte + entradas na velocidade de corte, perfurações e deslocamento em vazio', () => {
    const p = normalizeNestingParams({ cut_speed_mm_min: 3000, rapid_speed_mm_min: 20000, pierce_time_s: 1.5 });
    const t = estimateMachineTime({ cutLength: 2900, leadLength: 100, rapidLength: 10000, pierceCount: 4 }, p);
    near(t.cutS, 60, 0.05, 'corte');
    near(t.pierceS, 6, 0.05, 'perfurações');
    near(t.rapidS, 30, 0.05, 'em vazio');
    near(t.totalS, 96, 0.05, 'total');
    assert(t.estimate === true, 'tem que vir marcada como estimativa');
  });
  await test('padrões só de partida e limites: velocidade 0 ou negativa não quebra a conta', () => {
    const p = normalizeNestingParams({ cut_speed_mm_min: 0, rapid_speed_mm_min: -5, pierce_time_s: -1 });
    assert(p.cut_speed_mm_min >= 10 && p.rapid_speed_mm_min >= 100 && p.pierce_time_s === 0);
    const d = normalizeNestingParams({});
    assert.deepStrictEqual([d.cut_speed_mm_min, d.rapid_speed_mm_min, d.pierce_time_s], [3000, 20000, 1]);
  });

  const r = await runPreset({ parts: 'trueshape', qty: 3, config: { ...BASE, engine: 'CLASSICO', total_iterations: 400 } });
  const lay = r.done.bestResult;
  await test('sequência coerente: um G00 por perfuração, soma dos G00 = comprimento informado, tempo = soma das partes', () => {
    const cam = lay.cam;
    assert.strictEqual(cam.rapids.length, cam.metrics.pierceCount);
    const sum = cam.rapids.reduce((s, q) => s + Math.hypot(q.x2 - q.x1, q.y2 - q.y1), 0);
    near(sum, cam.metrics.rapidLength, 0.2, 'G00');
    const te = cam.timeEstimate;
    near(te.cutS + te.pierceS + te.rapidS, te.totalS, 0.2, 'tempo');
    assert.strictEqual(cam.metrics.rapidCrossings, cam.rapids.filter(q => q.crossesCut).length);
  });
  await test('replanejar o mesmo layout dá o mesmo resultado (determinístico) e o layout continua válido', () => {
    const p = normalizeNestingParams(r.job.normalizedConfig);
    const a = JSON.parse(JSON.stringify(lay)), b = JSON.parse(JSON.stringify(lay));
    planCam(a, p); planCam(b, p);
    assert.deepStrictEqual(a.cam.metrics, b.cam.metrics);
    assert.deepStrictEqual(a.cam.ops.map(o => [o.partId, o.kind, o.pierce.x, o.pierce.y]), b.cam.ops.map(o => [o.partId, o.kind, o.pierce.x, o.pierce.y]));
    assert(validateLayout(a, p, { allowedRotations: [0, 90, 180, 270] }).ok);
  });
  await test('velocidade de corte em dobro: o tempo de corte cai pela metade e a sequência não muda', async () => {
    const p1 = normalizeNestingParams({ ...r.job.normalizedConfig, cut_speed_mm_min: 3000 });
    const p2 = normalizeNestingParams({ ...r.job.normalizedConfig, cut_speed_mm_min: 6000 });
    const a = JSON.parse(JSON.stringify(lay)), b = JSON.parse(JSON.stringify(lay));
    planCam(a, p1); planCam(b, p2);
    near(b.cam.timeEstimate.cutS * 2, a.cam.timeEstimate.cutS, 0.3, 'corte');
    assert.strictEqual(a.cam.metrics.rapidLength, b.cam.metrics.rapidLength);
  });
  await test('objetivo "menos tempo de máquina" (clássico): o plano escolhido não é mais lento que as alternativas com as mesmas peças', async () => {
    const t = await runPreset({ parts: 'trueshape', qty: 2, config: { ...BASE, engine: 'CLASSICO', total_iterations: 600, optimization_goal: 'MIN_MACHINE_TIME' } });
    const best = t.done.bestResult;
    assert(best.cam && best.cam.timeEstimate, 'sem estimativa de tempo');
    for (const alt of t.done.topArchive) {
      if (alt.placedParts.length !== best.placedParts.length || Math.abs(alt.usedArea - best.usedArea) > 0.5 || !alt.cam) continue;
      assert(best.cam.timeEstimate.totalS <= alt.cam.timeEstimate.totalS + 0.5, `${best.cam.timeEstimate.totalS} > ${alt.cam.timeEstimate.totalS}`);
    }
  });
  if (S.findSparrowBinary()) {
    await test('objetivo "menos tempo de máquina" (sparrow): o plano escolhido é o mais rápido entre as alternativas válidas', async () => {
      const t = await runPreset({ parts: 'trueshape', qty: 2, config: { ...BASE, engine: 'SPARROW', external_time_s: 6, optimization_goal: 'MIN_MACHINE_TIME' },
        hardware: { totalCores: 2, maxWorkers: 1, threadsForJob: 2 } });
      assert.strictEqual(t.done.engine, 'SPARROW', t.done.engineNote);
      const best = t.done.bestResult;
      for (const alt of t.done.topArchive) {
        if (alt.placedParts.length !== best.placedParts.length) continue;
        assert(best.cam.timeEstimate.totalS <= alt.cam.timeEstimate.totalS + 0.5, `${best.cam.timeEstimate.totalS} > ${alt.cam.timeEstimate.totalS}`);
      }
    });
  }

  console.log(`\n${passed} aprovados, ${failed} reprovados`);
  process.exit(failed ? 1 : 0);
})();
