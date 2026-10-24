// bench/public/run.js — benchmark do Prumo nas instâncias públicas de strip packing (ESICUP, via sparrow).
//
//   bash bench/public/fetch-instances.sh
//   node bench/public/run.js --time 60 --seeds 5 --parallel 2 [--only albano,shirts] [--out bench/public/results]
//
// Protocolo (missão, seção 8.4): altura fixa = strip_height, comprimento livre, objetivo MIN_STRIP_LENGTH,
// kerf = folga = margem = 0, rotações da instância. Densidade = Σ área das peças ÷ (altura × comprimento usado),
// medida AQUI a partir dos polígonos da instância e das posições finais (não usa nenhum KPI do motor).
// Cada solução passa pelo validador independente (sobreposição = reprovação) e pela contagem de peças.
// As instâncias são escaladas para altura 1000 (densidade não muda; as tolerâncias do motor ficam em mm).
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const ROOT = path.join(__dirname, '..', '..');
const { classifyPartsAndHoles } = require(path.join(ROOT, 'cadParser'));
const { expandPartsByQuantities } = require(path.join(ROOT, 'jobBuilder'));
const { normalizeNestingParams } = require(path.join(ROOT, 'typesAndInterfaces'));
const { getBoundingBox, computeSignedArea } = require(path.join(ROOT, 'geometry', 'primitives'));

// Referências publicadas (rodapé dos SVG em sparrow/data/records; "melhor já obtido", não ótimo provado)
const INSTANCES = ['albano', 'blaz1', 'dagli', 'fu', 'jakobs1', 'jakobs2', 'mao', 'marques', 'shapes0', 'shapes1', 'shirts', 'swim', 'trousers'];

function args() {
  const a = process.argv.slice(2), o = { engine: 'classico', workers: 1, searches: 1, budget: 0, tag: '', merge: false, strict: false, time: 60, seeds: 5, parallel: Math.max(1, os.cpus().length - 1), only: null, out: path.join(__dirname, 'results'), widthFactor: 2.5 };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, ''), v = a[i + 1];
    if (k === 'strict' || k === 'merge') { o[k] = true; }
    else if (k === 'rebuild') { o.merge = true; o.only = []; } // só refaz tabela/CSV a partir do JSON salvo
    else if (k === 'only') { o.only = v.split(','); i++; } else if (k in o) { o[k] = (k === 'out' || k === 'engine' || k === 'tag') ? v : Number(v); i++; }
  }
  return o;
}

function readReference(dir, name) {
  try {
    const svg = fs.readFileSync(path.join(dir, 'records', `final_best_${name}.svg`), 'utf8');
    const m = svg.match(/(?:usage|density):\s*([\d.]+)%/); // o rodapé do sparrow usa os dois rótulos
    return m ? Number(m[1]) : null;
  } catch (_) { return null; }
}

function loadInstance(dir, name) {
  const inst = JSON.parse(fs.readFileSync(path.join(dir, 'input', `${name}.json`), 'utf8'));
  const scale = 1000 / inst.strip_height;
  const angleSets = new Set();
  const contours = [];
  const quantities = {};
  let totalArea = 0;
  inst.items.forEach((it, idx) => {
    if (!it.shape || it.shape.type !== 'simple_polygon') throw new Error(`${name}: forma ${it.shape && it.shape.type} não suportada`);
    let pts = it.shape.data.map(([x, y]) => ({ x: x * scale, y: y * scale }));
    if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
    const bbox = getBoundingBox(pts);
    const area = Math.abs(computeSignedArea(pts));
    // contornos separados (sem contenção entre itens): cada um é uma peça de nível 0
    contours.push({ id: `I_${idx}`, points: pts, bbox, signedArea: computeSignedArea(pts), trueArea: area, parentId: null });
    totalArea += area * it.demand;
    const rot = it.orientation && it.orientation.rotation;
    angleSets.add(rot && rot.mode === 'discrete' ? JSON.stringify(rot.angles.map(a => ((a % 360) + 360) % 360).sort((p, q) => p - q)) : 'continuous');
  });
  if (angleSets.size !== 1) throw new Error(`${name}: rotações diferentes por peça ainda não suportadas`);
  const angles = [...angleSets][0];
  const grain = { '[0]': 'FIXED_0', '[0,180]': 'GRAIN_X', '[0,90,180,270]': 'ORTHOGONAL' }[angles];
  if (!grain) throw new Error(`${name}: conjunto de rotações ${angles} não mapeado`);
  const cfg = {
    sheet_width: 0, sheet_height: 1000, kerf_width: 0, part_clearance: 0, sheet_margin: 0,
    grain_restriction: grain, allow_rotation: grain !== 'FIXED_0', hole_filling: false,
    optimization_goal: 'MIN_STRIP_LENGTH', evaluation_mode: 'FAST', min_remnant_size: 1e9, min_hole_size: 1e9,
    lead_in_length: 0, pierce_radius: 0, hole_clearance: 0
  };
  const catalog = classifyPartsAndHoles(contours, 1e9, normalizeNestingParams(cfg));
  // classifyPartsAndHoles ordena por caixa: refaz o vínculo item -> peça pelo contorno de origem
  catalog.forEach(p => { quantities[p.id] = inst.items[Number(p.sourceContourId.slice(2))].demand; });
  return { name, inst, scale, cfg, catalog, quantities, totalArea, grain };
}

/** Densidade e validade medidas fora do motor. */
function measure(layout, problem, params) {
  const { validateLayout } = require(path.join(ROOT, 'validator'));
  let used = 0;
  for (const p of layout.placedParts) for (const q of p.placedPoints) used = Math.max(used, p.x + q.x);
  const placedArea = layout.placedParts.reduce((s, p) => s + Math.abs(computeSignedArea(p.placedPoints)), 0);
  // só geometria (sobreposição, margem, contagem): com folga 0 não há sucata para perfurar, o CAM não se aplica
  const v = validateLayout({ ...layout, cam: null, remnants: [] }, params, {});
  const expected = Object.values(problem.quantities).reduce((s, q) => s + q, 0);
  return {
    density: placedArea / (1000 * used) * 100,
    usedLength: used,
    placed: layout.placedParts.length,
    expected,
    // conferência de sanidade (peça perdida/duplicada mudaria a área em %; o arredondamento de coordenadas a 0,001 mm
    // muda ~1e-5): a contagem exata de peças já é verificada acima
    valid: v.ok && layout.placedParts.length === expected && Math.abs(placedArea - problem.totalArea) < 1e-3 * problem.totalArea,
    errors: v.errors.slice(0, 3).map(e => e.msg)
  };
}

/** Motor externo (ADR 006): mesma instância, mesma régua independente. `searches` buscas independentes ao mesmo tempo
 *  (V5.7, ADR 008), cada uma com `workers` threads; vale a melhor. `budget` > 0 = orçamento em passos (reproduzível). */
async function runOneSparrow(problem, seed, timeS, workers, searches = 1, budget = 0) {
  const S = require(path.join(ROOT, 'engine', 'sparrowBridge'));
  const sc = problem.scale;
  const types = problem.inst.items.map(it => {
    const pts = it.shape.data.map(([x, y]) => ({ x: x * sc, y: y * sc }));
    if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
    return { points: pts, demand: it.demand };
  });
  const angles = { FIXED_0: [0], GRAIN_X: [0, 180], ORTHOGONAL: [0, 90, 180, 270] }[problem.grain];
  const { instance, inflate } = S.buildInstance(types, { stripHeight: 1000, gap: 0, allowedAngles: angles, name: problem.name });
  const t0 = Date.now();
  const curve = [];
  let bestLen = Infinity;
  const run = S.runSparrowMulti(instance, { searches, timeS, seed, workers, budget: budget || null, onSolution: b => {
    if (b.strip_width < bestLen) { bestLen = b.strip_width; curve.push({ t: +((Date.now() - t0) / 1000).toFixed(1), len: b.strip_width }); }
  } });
  const { best, reproducible } = await run.promise;
  // peças nominais na chapa: faixa começa em (b − g, b − g), com b = 0 no benchmark
  const placedParts = best.layout.placed_items.map((pi, k) => {
    const ring = S.transformRing(types[pi.item_id].points, pi.transformation).map(p => ({ x: p.x - inflate, y: p.y - inflate }));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of ring) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x); maxY = Math.max(maxY, q.y); }
    return { id: `P${k}`, name: `item ${pi.item_id} #${k}`, x: minX, y: minY, angle: pi.transformation.rotation, placedWidth: maxX - minX, placedHeight: maxY - minY,
      placedPoints: ring.map(q => ({ x: q.x - minX, y: q.y - minY })), placedHoles: [] };
  });
  const layout = { placedParts, unplacedParts: [], sheetWidth: Math.ceil(best.strip_width + 10), sheetHeight: 1000, sheetPoly: null };
  const params = normalizeNestingParams({ ...problem.cfg, sheet_width: layout.sheetWidth });
  const meas = measure(layout, problem, params);
  return { seed, evals: null, seconds: +((Date.now() - t0) / 1000).toFixed(1), ...meas, curve, largura_folga: null, tentativa: 1, engine: 'sparrow', reproducible };
}

/** Faixa folgada = fator × (área ÷ altura). Se nem todas as peças couberem (densidade baixa, ex.: shapes0/1), a MESMA
 *  semente roda de novo com a faixa 1,6× maior (até 2 vezes); o fator usado fica registrado em cada resultado. */
async function runSeed(problem, seed, timeS, widthFactor) {
  let wf = widthFactor, r;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await runOne(problem, seed, timeS, wf);
    r.largura_folga = +wf.toFixed(3);
    r.tentativa = attempt;
    if (r.placed === r.expected) break;
    wf *= 1.6;
  }
  return r;
}

function runOne(problem, seed, timeS, widthFactor) {
  const width = Math.ceil(widthFactor * problem.totalArea / 1000);
  const config = normalizeNestingParams({ ...problem.cfg, engine: 'CLASSICO', sheet_width: width, total_iterations: 250000, time_limit_s: timeS, seed_offset: seed });
  config.sheet_width = width; // normalize aplica mínimo de 20; a largura folgada é a do problema
  const parts = expandPartsByQuantities(problem.catalog, problem.quantities);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const curve = [];
    const w = new Worker(path.join(ROOT, 'nestingWorker.js'), { workerData: { parts, sheet: null, config, hardware: {} } });
    w.on('message', m => {
      if (m.type === 'progress' && m.bestResult && m.bestResult.placedParts.length === parts.length) {
        curve.push({ t: +((Date.now() - t0) / 1000).toFixed(1), len: m.bestResult.stripLength });
      }
      if (m.type === 'done') {
        const meas = measure(m.bestResult, problem, config);
        resolve({ seed, evals: m.totalIterations, seconds: +(m.totalTimeMs / 1000).toFixed(1), ...meas, curve });
        w.terminate();
      }
    });
    w.on('error', reject);
  });
}

async function main() {
  const o = args();
  const dir = path.join(__dirname, 'instances', 'sparrow', 'data');
  if (!fs.existsSync(dir)) { console.error('Instâncias ausentes: rode bash bench/public/fetch-instances.sh'); process.exit(2); }
  const names0 = o.only || INSTANCES;
  fs.mkdirSync(o.out, { recursive: true });
  const queue = [];
  const problems = {};
  for (const n of names0) { problems[n] = loadInstance(dir, n); for (let s = 1; s <= o.seeds; s++) queue.push([n, s]); }
  const results = {};
  let next = 0;
  const workers = Array.from({ length: Math.min(o.parallel, queue.length) }, async () => {
    while (next < queue.length) {
      const [n, s] = queue[next++];
      const r = o.engine === 'sparrow' ? await runOneSparrow(problems[n], s, o.time, o.workers, o.searches, o.budget) : await runSeed(problems[n], s, o.time, o.widthFactor);
      (results[n] = results[n] || []).push(r);
      console.log(`${n.padEnd(9)} semente ${s}: densidade ${r.density.toFixed(2)}% ${r.valid ? 'válida' : 'INVÁLIDA ' + JSON.stringify(r.errors)} (${r.placed}/${r.expected} peças${r.evals != null ? `, ${r.evals} avaliações` : ''})`);
    }
  });
  await Promise.all(workers);

  const pkg = require(path.join(ROOT, 'package.json'));
  const stamp = `v${pkg.version}_${o.budget ? o.budget + 'passos' : o.time + 's'}${o.engine === 'sparrow' ? '_sparrow' : ''}${o.tag ? '_' + o.tag : ''}`;
  // --merge: refaz só as instâncias pedidas e mantém as outras da última rodada com o mesmo carimbo (versão + tempo)
  let names = names0, prevMeta = null;
  const prevFile = path.join(o.out, `public_${stamp}.json`);
  if (o.merge && fs.existsSync(prevFile)) {
    const prev = JSON.parse(fs.readFileSync(prevFile, 'utf8'));
    prevMeta = prev.meta;
    for (const [n, rs] of Object.entries(prev.raw || {})) if (!results[n]) results[n] = rs.map(r => ({ largura_folga: prev.meta.largura_folga, tentativa: 1, ...r }));
    names = INSTANCES.filter(n => results[n]);
    for (const n of names) if (!problems[n]) problems[n] = loadInstance(dir, n);
  }

  const rows = names.map(n => {
    const rs = (results[n] || []).filter(r => r.valid);
    if (!rs.length) return { instancia: n, rotacoes: problems[n].grain, validas: `0/${(results[n] || []).length}` };
    const ds = rs.map(r => r.density);
    const mean = ds.reduce((s, d) => s + d, 0) / Math.max(1, ds.length);
    const sd = Math.sqrt(ds.reduce((s, d) => s + (d - mean) ** 2, 0) / Math.max(1, ds.length - 1));
    const ref = readReference(dir, n);
    return {
      instancia: n, rotacoes: problems[n].grain, pecas: problems[n].catalog.length + ' tipos / ' + Object.values(problems[n].quantities).reduce((s, q) => s + q, 0),
      validas: `${rs.length}/${(results[n] || []).length}`,
      media: +mean.toFixed(2), melhor: +Math.max(...ds).toFixed(2), pior: +Math.min(...ds).toFixed(2), desvio: +sd.toFixed(2),
      referencia_sparrow: ref, gap_pp: ref ? +(ref - Math.max(...ds)).toFixed(2) : null,
      avaliacoes_media: rs.every(r => r.evals != null) ? Math.round(rs.reduce((s, r) => s + r.evals, 0) / Math.max(1, rs.length)) : null,
      largura_folga: rs.every(r => r.largura_folga == null) ? null : [...new Set(rs.map(r => r.largura_folga))].join('/')
    };
  });
  const metaNow = { versao: pkg.version, data: new Date().toISOString(), tempo_s: o.time, sementes: o.seeds, nucleos_paralelos: o.parallel, cpu: os.cpus()[0] && os.cpus()[0].model, motor: o.engine, threads_por_execucao: o.engine === 'sparrow' ? o.workers * o.searches : 1, buscas_paralelas: o.engine === 'sparrow' ? o.searches : undefined, threads_por_busca: o.engine === 'sparrow' ? o.workers : undefined, orcamento_passos: o.budget || undefined, largura_folga: o.engine === 'sparrow' ? null : o.widthFactor, refeitas_nesta_rodada: o.merge ? names0 : undefined };
  // numa mescla, a rodada original manda (data, paralelismo, CPU); só a lista de refeitas é desta
  const meta = prevMeta ? { ...prevMeta, refeitas_nesta_rodada: names0, tabela_refeita_em: metaNow.data } : metaNow;
  fs.writeFileSync(path.join(o.out, `public_${stamp}.json`), JSON.stringify({ meta, rows, raw: results }, null, 1));
  const head = Object.keys(rows.find(r => 'media' in r) || rows[0]);
  fs.writeFileSync(path.join(o.out, `public_${stamp}.csv`), [head.join(';'), ...rows.map(r => head.map(h => String(r[h] ?? '').replace('.', ',')).join(';'))].join('\r\n') + '\r\n');
  console.log('\n' + JSON.stringify(meta));
  console.table(rows);
  const invalid = Object.values(results).flat().filter(r => !r.valid).length;
  if (invalid) console.log(`${invalid} solução(ões) inválida(s)`);
  process.exit(o.strict && invalid ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
