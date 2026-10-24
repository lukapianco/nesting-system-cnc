// bench/paralelo.js — compara jeitos de usar as threads da máquina no otimizador sparrow (ADR 008).
//
//   node bench/paralelo.js                       # usa todas as threads lógicas menos 1, 60 s, 3 sementes
//   node bench/paralelo.js --threads 11 --time 60 --seeds 3 --only jakobs2,swim,blaz1,shapes1
//   node bench/paralelo.js --configs 1x11,5x2,11x1
//
// Cada configuração "KxW" = K buscas independentes (sementes diferentes) ao mesmo tempo, cada uma com W threads;
// vale a melhor. Todas usam o mesmo tempo de relógio e quase o mesmo total de threads, então a pergunta é só
// "como dividir": uma busca com muitas threads ou várias buscas com poucas.
// Precisa das instâncias (bash bench/public/fetch-instances.sh) e do executável (npm run build:sparrow).
// Saída: bench/public/results/paralelo_<cpu>_<threads>t_<tempo>s.json + tabela no terminal.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d; };
const threads = Number(opt('threads', Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1)));
const time = Number(opt('time', 60));
const seeds = Number(opt('seeds', 3));
const only = opt('only', 'jakobs2,swim,blaz1,shapes1');

function defaultConfigs(t) {
  const set = new Set([`1x${t}`, `${t}x1`]);
  for (const w of [2, 3, 4]) if (t >= w * 2) set.add(`${Math.floor(t / w)}x${w}`);
  return [...set];
}
const configs = (opt('configs', '') || defaultConfigs(threads).join(',')).split(',').filter(Boolean);

const outDir = path.join(__dirname, 'public', 'results', 'paralelo');
fs.mkdirSync(outDir, { recursive: true });
const runJs = path.join(__dirname, 'public', 'run.js');
const pkg = require(path.join(__dirname, '..', 'package.json'));
const table = {};
console.log(`${configs.length} configurações × ${only.split(',').length} instâncias × ${seeds} sementes × ${time} s` +
  ` ≈ ${Math.ceil(configs.length * only.split(',').length * seeds * time * 1.05 / 60)} min (uma de cada vez, para não disputarem CPU)`);
for (const cfg of configs) {
  const [k, w] = cfg.split('x').map(Number);
  console.log(`\n== ${k} busca(s) × ${w} thread(s) ==`);
  const r = spawnSync(process.execPath, [runJs, '--engine', 'sparrow', '--searches', String(k), '--workers', String(w), '--parallel', '1',
    '--time', String(time), '--seeds', String(seeds), '--only', only, '--out', outDir, '--tag', cfg], { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`configuração ${cfg} falhou`); continue; }
  const f = path.join(outDir, `public_v${pkg.version}_${time}s_sparrow_${cfg}.json`);
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const row of d.rows) (table[row.instancia] = table[row.instancia] || {})[cfg] = row.media;
}
const rows = Object.entries(table).map(([inst, v]) => ({ instancia: inst, ...v }));
const means = {};
for (const cfg of configs) {
  const vals = rows.map(r => r[cfg]).filter(x => typeof x === 'number');
  means[cfg] = vals.length ? +(vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(2) : null;
}
rows.push({ instancia: 'média', ...means });
const cpu = (os.cpus()[0] && os.cpus()[0].model || 'cpu').replace(/[^\w]+/g, '_').slice(0, 40);
const file = path.join(outDir, `paralelo_${cpu}_${threads}t_${time}s.json`);
fs.writeFileSync(file, JSON.stringify({ versao: pkg.version, data: new Date().toISOString(), cpu: os.cpus()[0] && os.cpus()[0].model, threads, tempo_s: time, sementes: seeds, densidade_media_por_config: rows }, null, 1));
console.log('\nDensidade média (%) por configuração (K buscas × W threads):');
console.table(rows);
console.log(`Salvo em ${path.relative(process.cwd(), file)}. Mande esse arquivo para registrar no benchmark.`);
