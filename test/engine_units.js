// test/engine_units.js — testes unitários do motor e da estrutura: node test/engine_units.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { polygonsCollideTrueShape } = require('../engine/collision');
const { isPointInPolygon, segmentsIntersectExact, pointToSegmentDistSq } = require('../geometry/primitives');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✖ ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}

/** ORÁCULO: implementação por força bruta da V5.2 (todos os vértices/pontos médios e todos os pares). */
function collideBruteForceV52(pA, pB, requiredNominalGap) {
  // atalho por caixas com a MESMA folga mínima do teste exato (V5.2 usava "folga − 0,01": igual para folga >= 0,02 mm,
  // inconsistente para folga 0 — corrigido na V5.4; ver engine/collision.js)
  const mg = Math.max(0.01, requiredNominalGap - 0.01);
  if (pA.x + pA.placedWidth + mg <= pB.x || pB.x + pB.placedWidth + mg <= pA.x ||
      pA.y + pA.placedHeight + mg <= pB.y || pB.y + pB.placedHeight + mg <= pA.y) return false;
  const isRectA = pA.points.length === 4 && Math.abs(pA.area - pA.bboxArea) < 2 && (pA.angle || 0) % 90 === 0;
  const isRectB = pB.points.length === 4 && Math.abs(pB.area - pB.bboxArea) < 2 && (pB.angle || 0) % 90 === 0;
  if (isRectA && isRectB) return true;
  const ptsA = pA.placedPoints.map(p => ({ x: pA.x + p.x, y: pA.y + p.y }));
  const ptsB = pB.placedPoints.map(p => ({ x: pB.x + p.x, y: pB.y + p.y }));
  for (let i = 0; i < ptsA.length; i++) {
    const a1 = ptsA[i], a2 = ptsA[(i + 1) % ptsA.length];
    if (isPointInPolygon(a1, ptsB)) return true;
    if (isPointInPolygon({ x: (a1.x + a2.x) * 0.5, y: (a1.y + a2.y) * 0.5 }, ptsB)) return true;
  }
  for (let j = 0; j < ptsB.length; j++) {
    const b1 = ptsB[j], b2 = ptsB[(j + 1) % ptsB.length];
    if (isPointInPolygon(b1, ptsA)) return true;
    if (isPointInPolygon({ x: (b1.x + b2.x) * 0.5, y: (b1.y + b2.y) * 0.5 }, ptsA)) return true;
  }
  const minGapSq = Math.max(0.01, requiredNominalGap - 0.01) ** 2;
  for (let i = 0; i < ptsA.length; i++) {
    const a1 = ptsA[i], a2 = ptsA[(i + 1) % ptsA.length];
    for (let j = 0; j < ptsB.length; j++) {
      const b1 = ptsB[j], b2 = ptsB[(j + 1) % ptsB.length];
      if (segmentsIntersectExact(a1, a2, b1, b2)) return true;
      if (pointToSegmentDistSq(a1.x, a1.y, b1.x, b1.y, b2.x, b2.y) < minGapSq) return true;
      if (pointToSegmentDistSq(b1.x, b1.y, a1.x, a1.y, a2.x, a2.y) < minGapSq) return true;
    }
  }
  return false;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** Polígono estrelado aleatório (simples), normalizado para min = (0,0) como placedPoints do motor. */
function randomPart(r, n, R) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rad = R * (0.45 + 0.55 * r());
    pts.push({ x: Math.cos(t) * rad, y: Math.sin(t) * rad });
  }
  const mx = Math.min(...pts.map(p => p.x)), my = Math.min(...pts.map(p => p.y));
  const placedPoints = pts.map(p => ({ x: p.x - mx, y: p.y - my }));
  const w = Math.max(...placedPoints.map(p => p.x)), h = Math.max(...placedPoints.map(p => p.y));
  let area = 0;
  for (let i = 0; i < n; i++) { const a = placedPoints[i], b = placedPoints[(i + 1) % n]; area += a.x * b.y - b.x * a.y; }
  return { points: placedPoints, placedPoints, placedWidth: w, placedHeight: h, area: Math.abs(area / 2), bboxArea: w * h, angle: 0 };
}

(async () => {
  console.log('\n[COLISÃO] versão indexada = força bruta da V5.2 (teste de propriedade)');
  await test('8.000 pares aleatórios (6 a 400 vértices, folgas 0 a 12 mm): mesmas respostas', () => {
    const r = rng(12345);
    let collide = 0, diffs = [];
    for (let k = 0; k < 8000; k++) {
      const nA = r() < 0.3 ? 6 + Math.floor(r() * 20) : 24 + Math.floor(r() * 380);
      const nB = r() < 0.3 ? 6 + Math.floor(r() * 20) : 24 + Math.floor(r() * 380);
      const A = randomPart(r, nA, 20 + r() * 80), B = randomPart(r, nB, 20 + r() * 80);
      A.x = r() * 50; A.y = r() * 50;
      // B perto de A: às vezes sobreposto, às vezes encostado, às vezes longe; às vezes dentro (contenção)
      const mode = r();
      const gap = r() < 0.1 ? 0 : r() < 0.2 ? 0.02 : r() * 12;
      if (mode < 0.15) { B.x = A.x + (A.placedWidth - B.placedWidth) / 2; B.y = A.y + (A.placedHeight - B.placedHeight) / 2; }
      else { B.x = A.x + A.placedWidth * (0.6 + r() * 0.8) + (r() - 0.5) * 20; B.y = A.y + (r() - 0.5) * A.placedHeight; }
      const got = polygonsCollideTrueShape(A, B, gap), exp = collideBruteForceV52(A, B, gap);
      if (exp) collide++;
      if (got !== exp) diffs.push({ k, nA, nB, gap, got, exp });
      const got2 = polygonsCollideTrueShape(B, A, gap);
      if (got2 !== exp) diffs.push({ k, sym: true, got2, exp });
    }
    assert.strictEqual(diffs.length, 0, `divergências: ${JSON.stringify(diffs.slice(0, 3))}`);
    assert(collide > 1500 && collide < 6500, `amostra desbalanceada: ${collide} colisões`);
  });
  await test('peça inteira dentro da outra (sem tocar bordas) é colisão; distância exatamente = folga não é', () => {
    const sq = (s) => ({ points: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }], placedPoints: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }], placedWidth: s, placedHeight: s, area: s * s, bboxArea: s * s, angle: 45 });
    const big = { ...sq(100), x: 0, y: 0 }, small = { ...sq(10), x: 45, y: 45 };
    assert.strictEqual(polygonsCollideTrueShape(big, small, 6), true);
    const a = { ...sq(10), x: 0, y: 0 }, b = { ...sq(10), x: 16, y: 0 };
    assert.strictEqual(polygonsCollideTrueShape(a, b, 6), false);
    assert.strictEqual(polygonsCollideTrueShape(a, { ...b, x: 15.9 }, 6), true);
  });

  console.log('\n[FOLGA ZERO] strip packing / peças encostadas (benchmark público)');
  await test('folga 0: nenhuma sobreposição nem contato (erro de ponto flutuante na consulta de vizinhos)', async () => {
    const { runPreset } = require('./harness');
    const S = require('./dxfSynth');
    const { validateLayout } = require('../validator');
    const { normalizeNestingParams } = require('../typesAndInterfaces');
    // medidas do blaz1 escalado (133,32 = 2 × 66,66): somas como 133,32 + 199,98 não são exatas em double
    const txt = S.buildDxf({ insunits: 4, entities: [S.rect(0, 0, 133.32, 133.32), S.rect(200, 0, 266.64, 199.98), S.rect(500, 0, 266.64, 266.64), S.rect(800, 0, 199.98, 133.32)] });
    const cfg = { sheetWidth: 1400, sheetHeight: 1000, kerf_width: 0, part_clearance: 0, sheet_margin: 0, total_iterations: 120, hole_filling: false, min_remnant_size: 1e9 };
    for (const seed of [1, 2, 3]) {
      const r = await runPreset({ dxfText: txt, qty: 4, config: { ...cfg, seed_offset: seed } });
      const b = r.done.bestResult;
      const v = validateLayout({ ...b, cam: null, remnants: [] }, normalizeNestingParams(cfg), {});
      assert(v.ok, `semente ${seed}: ` + v.errors.slice(0, 2).map(e => e.msg).join(' | '));
      for (let i = 0; i < b.placedParts.length; i++) for (let j = i + 1; j < b.placedParts.length; j++) {
        const A = b.placedParts[i], B = b.placedParts[j];
        const sepX = Math.max(B.x - (A.x + A.placedWidth), A.x - (B.x + B.placedWidth));
        const sepY = Math.max(B.y - (A.y + A.placedHeight), A.y - (B.y + B.placedHeight));
        assert(Math.max(sepX, sepY) >= 0.0099, `semente ${seed}: ${A.name} e ${B.name} encostadas (${Math.max(sepX, sepY)})`);
      }
    }
  });

  console.log('\n[ESTRUTURA] dependências');
  const ROOT = path.join(__dirname, '..');
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      if (['node_modules', '.git', 'test', 'bench', 'public', 'docs'].includes(f)) continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) files.push(p);
    }
  })(ROOT);
  const graph = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const deps = [...src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].map(m => {
      let p = path.resolve(path.dirname(f), m[1]);
      if (!p.endsWith('.js')) p += '.js';
      return p;
    });
    graph.set(f, deps);
  }
  await test('grafo de require() sem ciclos (a causa dos avisos "circular dependency")', () => {
    const state = new Map();
    const cycles = [];
    const dfs = (n, stack) => {
      state.set(n, 1); stack.push(n);
      for (const d of graph.get(n) || []) {
        if (state.get(d) === 1) cycles.push([...stack.slice(stack.indexOf(d)), d].map(x => path.relative(ROOT, x)).join(' → '));
        else if (!state.get(d)) dfs(d, stack);
      }
      stack.pop(); state.set(n, 2);
    };
    for (const n of graph.keys()) if (!state.get(n)) dfs(n, []);
    assert.strictEqual(cycles.length, 0, 'ciclos: ' + cycles.join(' | '));
  });
  await test('módulos folha não importam nada do projeto; ninguém importa o nestingWorker', () => {
    for (const leaf of ['geometry/primitives.js', 'dxf/curves.js', 'dxf/reader.js', 'spatialIndex.js']) {
      assert.deepStrictEqual(graph.get(path.join(ROOT, leaf)), [], `${leaf} importa: ${(graph.get(path.join(ROOT, leaf)) || []).join(', ')}`);
    }
    for (const [f, deps] of graph) assert(!deps.includes(path.join(ROOT, 'nestingWorker.js')), `${path.relative(ROOT, f)} importa o worker`);
  });

  console.log(`\n${passed} aprovados, ${failed} reprovados`);
  process.exit(failed ? 1 : 0);
})();
