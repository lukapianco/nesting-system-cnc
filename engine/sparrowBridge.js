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
 *          sheet?:{outer:{x,y}[], holes:{x,y}[][], border:number}}} o - sheet: chapa desenhada (coordenadas da chapa)
 */
function buildInstance(types, o) {
  const g = o.gap / 2 + SAFETY;
  const prumoSheet = o.sheet ? {
    outer: o.sheet.outer.map(p => [p.x, p.y]),
    holes: (o.sheet.holes || []).map(h => h.map(p => [p.x, p.y])),
    offset: o.sheet.border - g,
    shift: [-(o.sheet.border - g), -(o.sheet.border - g)]
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
 * Devolve { best, lines, stderrTail, exitCode }. stop() pede parada cooperativa (fica com a melhor).
 */
function runSparrow(instance, { timeS = 60, seed = 1, workers = 1, early = false, bin = findSparrowBinary(), onSolution = null, onSpawn = null, onExit = null } = {}) {
  if (!bin) return { promise: Promise.reject(new Error('prumo-sparrow não encontrado (compile native/prumo-sparrow ou defina PRUMO_SPARROW_BIN)')), stop() {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prumo-sparrow-'));
  const file = path.join(dir, 'instancia.json');
  fs.writeFileSync(file, JSON.stringify(instance));
  const args = ['--input', file, '--time', String(timeS), '--seed', String(Math.max(0, Math.floor(seed))), '--workers', String(Math.max(1, workers))];
  if (early) args.push('--early');
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  if (onSpawn && child.pid) onSpawn(child.pid);
  let best = null, buf = '', stderrTail = '', errorMsg = null;
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
      }
    });
    child.stderr.on('data', d => { stderrTail = (stderrTail + d.toString('utf8')).slice(-4000); });
    child.on('error', reject);
    child.on('close', code => {
      if (onExit && child.pid) onExit(child.pid);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* temporário */ }
      if (errorMsg || (code !== 0 && !best)) reject(new Error(errorMsg || `prumo-sparrow saiu com código ${code}: ${stderrTail.slice(-400)}`));
      else resolve({ best, exitCode: code, stderrTail });
    });
  });
  return { promise, stop() { try { child.stdin.write('stop\n'); } catch (_) { /* já terminou */ } }, kill() { child.kill(); } };
}

module.exports = { SAFETY, findSparrowBinary, buildInstance, transformRing, runSparrow, orientationFor };
