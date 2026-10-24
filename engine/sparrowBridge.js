// engine/sparrowBridge.js — ponte entre o Prumo e o otimizador externo prumo-sparrow (native/prumo-sparrow).
//
// O otimizador (sparrow 0.3.0, MIT, + jagua-rs 1.1.0, MPL-2.0) roda como PROCESSO separado: recebe uma instância de
// strip packing em JSON, devolve soluções viáveis como linhas JSON no stdout e para quando recebe "stop" no stdin.
// Nada aqui decide se um layout é válido: quem decide é o validador independente (validator.js), sempre.
//
// Convenções geométricas (ADR 006):
//  * o otimizador enxerga o contorno EXTERNO de cada peça, inflado por g = D_nom/2 + SAFETY (Clipper2, junta redonda);
//    furos e filhas Part-in-Part voltam depois, com a mesma transformação;
//  * a faixa tem altura H' = H − 2·b + 2·g (b = margem efetiva da chapa) e começa em (b − g, b − g) na chapa;
//  * a transformação devolvida vale para as coordenadas ORIGINAIS da peça: girar em torno da origem, depois transladar;
//  * chapa desenhada: o que fica fora do contorno (dentro da caixa da chapa) e os furos/defeitos viram obstáculos fixos,
//    inflados por b − g (assim a peça inflada que não os toca fica a ≥ b deles), calculados no executável com Clipper2.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Margem de segurança somada ao meio-espaçamento (mm). Cobre: corda do arco no offset (tolerância 0,002), f32 do
// otimizador (~0,0005 mm em 6 m) e o arredondamento a 0,001 mm das coordenadas do Prumo. Não é "folga extra" de projeto.
const SAFETY = 0.005;

function binaryCandidates() {
  const root = path.join(__dirname, '..', 'native', 'prumo-sparrow');
  const exe = process.platform === 'win32' ? 'prumo-sparrow.exe' : 'prumo-sparrow';
  return [process.env.PRUMO_SPARROW_BIN, path.join(root, 'target', 'release', exe), path.join(root, 'bin', exe)].filter(Boolean);
}

/** Caminho do executável ou null (motor indisponível: o Prumo usa o motor clássico e avisa). */
function findSparrowBinary() {
  for (const p of binaryCandidates()) {
    try { if (fs.statSync(p).isFile()) return p; } catch (_) { /* próximo */ }
  }
  return null;
}

/** Ângulos permitidos do Prumo → orientação do jagua-rs. */
function orientationFor(allowedAngles) {
  const angles = [...new Set(allowedAngles.map(a => ((a % 360) + 360) % 360))].sort((a, b) => a - b);
  return { rotation: { mode: 'discrete', angles } };
}

/**
 * Monta a instância de strip packing.
 * @param {{key:string, points:{x,y}[], demand:number}[]} types - um item por TIPO de peça (contorno externo, ângulo 0)
 * @param {{stripHeight:number, gap:number, allowedAngles:number[], name?:string,
 *          sheet?:{outer:{x,y}[], holes:{x,y}[][], border:number, fixed?:{points:{x,y}[], offset:number}[]}}} o
 *          sheet: chapa desenhada (coordenadas da chapa); fixed: peças já colocadas que viram obstáculos (V5.8)
 */
function buildInstance(types, o) {
  const g = o.gap / 2 + SAFETY;
  const prumoSheet = o.sheet ? {
    outer: o.sheet.outer.map(p => [p.x, p.y]),
    holes: (o.sheet.holes || []).map(h => h.map(p => [p.x, p.y])),
    offset: o.sheet.border - g,
    shift: [-(o.sheet.border - g), -(o.sheet.border - g)],
    // V5.8: peças já colocadas nesta chapa (reabastecimento), contorno nominal em coordenadas da chapa
    ...(o.sheet.fixed && o.sheet.fixed.length ? { fixed: o.sheet.fixed.map(f => ({ ring: f.points.map(p => [p.x, p.y]), offset: f.offset })) } : {})
  } : undefined;
  return {
    instance: {
      name: o.name || 'prumo',
      strip_height: o.stripHeight + 2 * g,
      prumo_inflate: g,
      ...(prumoSheet ? { prumo_sheet: prumoSheet } : {}),
      items: types.map((t, i) => ({
        id: i,
        demand: t.demand,
        orientation: orientationFor(o.allowedAngles),
        shape: { type: 'simple_polygon', data: t.points.map(p => [p.x, p.y]) },
        min_quality: null
      }))
    },
    inflate: g
  };
}

/** Aplica a transformação (graus, translação) a um anel de pontos originais. */
function transformRing(points, tr) {
  const rad = (tr.rotation * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  const [tx, ty] = tr.translation;
  return points.map(p => ({ x: p.x * c - p.y * s + tx, y: p.x * s + p.y * c + ty }));
}

/**
 * Roda o otimizador. onSolution(sol) é chamado a cada solução viável que melhora a faixa.
 * budget (V5.7): orçamento em passos em vez de tempo; com a mesma semente, workers e budget, o resultado é o mesmo em
 * qualquer máquina (timeS vira teto de segurança). Devolve { best, exitCode, stderrTail, steps, reproducible }.
 * stop() pede parada cooperativa (fica com a melhor).
 */
function runSparrow(instance, { timeS = 60, seed = 1, workers = 1, early = false, budget = null, bin = findSparrowBinary(), onSolution = null, onSpawn = null, onExit = null } = {}) {
  if (!bin) return { promise: Promise.reject(new Error('prumo-sparrow não encontrado (compile native/prumo-sparrow ou defina PRUMO_SPARROW_BIN)')), stop() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prumo-sparrow-'));
  const file = path.join(dir, 'instancia.json');
  fs.writeFileSync(file, JSON.stringify(instance));
  const args = ['--input', file, '--time', String(timeS), '--seed', String(Math.max(0, Math.floor(seed))), '--workers', String(Math.max(1, workers))];
  if (early) args.push('--early');
  if (budget) args.push('--budget', String(Math.max(2, Math.floor(budget))));
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  if (onSpawn && child.pid) onSpawn(child.pid);
  let best = null, buf = '', stderrTail = '', errorMsg = null, doneMsg = null;
  const promise = new Promise((resolve, reject) => {
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.type === 'solution') {
          if (!best || m.solution.strip_width <= best.strip_width) best = { ...m.solution, elapsed_s: m.elapsed_s, phase: m.phase };
          if (onSolution) onSolution(best);
        } else if (m.type === 'error') errorMsg = m.message;
        else if (m.type === 'done') doneMsg = m;
      }
    });
    child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString('utf8')).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => {
      if (onExit && child.pid) onExit(child.pid);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temporário */ }
      if (errorMsg || (code !== 0 && !best)) reject(new Error(errorMsg || `prumo-sparrow saiu com código ${code}: ${stderrTail.slice(-400)}`));
      else resolve({ best, exitCode: code, stderrTail, steps: doneMsg ? doneMsg.steps : null, reproducible: !!(doneMsg && doneMsg.reproducible) });
    });
  });
  return { promise, stop() { try { child.stdin.write('stop\n'); } catch (_) { /* já terminou */ } }, kill() { child.kill(); } };
}

/** Semente de cada busca paralela: a busca 0 usa a semente pedida (igual à V5.6); as outras ficam longe dela, para que
 *  "Calcular de novo" (semente + 1) não repita buscas da rodada anterior. */
/** Threads do modo reproduzível: fixas, para que o plano não dependa da máquina (numa máquina com menos núcleos ele
 *  só demora mais). 6 = 2 buscas × 3 threads com a política automática (V5.8). */
const REPRODUCIBLE_THREADS = 6;

function searchSeed(seed, i) { return i === 0 ? seed : seed + i * 100003; }

/**
 * Divide as threads de um job entre buscas independentes (sementes diferentes, ao mesmo tempo) e threads por busca.
 * Política medida na V5.7 (ADR 008): ver bench/paralelo.js. Com orçamento em passos, a divisão também entra no
 * resultado, então ela depende só de `threads` (nunca da carga do momento).
 */
function splitThreads(threads, searches = 0) {
  const t = Math.max(1, Math.floor(threads));
  if (searches > 0) { const k = Math.min(t, Math.floor(searches)); return { searches: k, workers: Math.max(1, Math.floor(t / k)) }; }
  // automático (V5.8, medido num i5-12400 com 11 threads, 60 s, 3 sementes, 4 instâncias): buscas de 3 threads
  // ganharam (3×3: 79,14% de média; 5×2: 78,75; 2×4: 78,69; 1×11: 78,62; 11×1: 77,53). As threads que sobram
  // da divisão vão para as buscas (7 threads = 2 buscas de 3; 4 threads = 1 busca de 4)
  const k = Math.max(1, Math.floor(t / 3));
  return { searches: k, workers: Math.max(1, Math.floor(t / k)) };
}

/**
 * Várias buscas independentes ao mesmo tempo (multi-start), cada uma com a sua semente. onSolution(sol, i) recebe as
 * melhorias de cada busca i. Devolve { runs: [{ best, steps, reproducible, error }], best, bestIndex, reproducible }:
 * best = a menor faixa entre as buscas (empate: a de menor índice), então o resultado não depende de qual terminou antes.
 */
function runSparrowMulti(instance, { searches = 1, seed = 1, onSolution = null, ...rest } = {}) {
  const runs = Array.from({ length: Math.max(1, searches) }, (_, i) => runSparrow(instance, {
    ...rest, seed: searchSeed(seed, i), onSolution: onSolution ? (sol) => onSolution(sol, i) : null
  }));
  const promise = Promise.allSettled(runs.map(r => r.promise)).then(rs => {
    const out = rs.map(r => r.status === 'fulfilled' ? r.value : { best: null, error: r.reason && r.reason.message });
    let bestIndex = -1;
    out.forEach((r, i) => { if (r.best && (bestIndex < 0 || r.best.strip_width < out[bestIndex].best.strip_width)) bestIndex = i; });
    if (bestIndex < 0) throw new Error(out.map(r => r.error).filter(Boolean)[0] || 'nenhuma busca terminou com solução');
    return { runs: out, best: out[bestIndex].best, bestIndex, reproducible: out.every(r => r.reproducible) };
  });
  return {
    promise,
    stop() { runs.forEach(r => r.stop()); },
    kill() { runs.forEach(r => r.kill && r.kill()); }
  };
}

module.exports = { SAFETY, REPRODUCIBLE_THREADS, findSparrowBinary, buildInstance, transformRing, runSparrow, runSparrowMulti, splitThreads, searchSeed, orientationFor };
