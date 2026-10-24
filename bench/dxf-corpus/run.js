// bench/dxf-corpus/run.js — robustez do leitor de DXF num corpus público (fase 1 do plano, portão P1 parcial).
//   bash bench/dxf-corpus/fetch.sh && node bench/dxf-corpus/run.js [--timeout 60] [--mutate] [--strict] [--dir ...]
// Cada arquivo é lido num processo separado com limite de tempo. Critério: nenhum arquivo trava (timeout) nem
// quebra o leitor com erro interno; arquivo ruim tem de ser recusado com motivo (o mesmo 422 da API).
// Observação: o corpus é de exemplos de bibliotecas DXF (cotas, textos, hachuras, 3D), não de peças para corte; a
// métrica "% lido sem intervenção" do portão P1 só vale com DXF reais de clientes.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const dir = path.resolve(opt('dir', path.join(__dirname, 'files')));
const timeoutS = Number(opt('timeout', 60));
const strict = argv.includes('--strict');
if (!fs.existsSync(dir)) { console.error('Corpus ausente: rode bash bench/dxf-corpus/fetch.sh'); process.exit(2); }

const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const st = fs.statSync(p); if (st.isDirectory()) { if (f !== '.git') walk(p); } else if (/\.dxf$/i.test(f)) files.push(p); } })(dir);
files.sort();

const rows = [];
const t0 = Date.now();
for (const f of files) {
  const rel = path.relative(dir, f);
  let r;
  try {
    const out = execFileSync(process.execPath, ['--max-old-space-size=2048', path.join(__dirname, 'one.js'), f], { timeout: timeoutS * 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    r = JSON.parse(out);
  } catch (e) {
    r = e.killed || e.signal === 'SIGTERM' ? { status: 'TIMEOUT', ms: timeoutS * 1000 } : { status: 'FALHA_INTERNA', error: String(e.stderr || e.message).slice(0, 300) };
  }
  rows.push({ arquivo: rel, kb: Math.round(fs.statSync(f).size / 1024), ...r });
  if (/FALHA|TIMEOUT/.test(r.status)) console.log(`  ✖ ${rel}: ${r.status} ${r.error || ''}`);
}
// --mutate: estresse com arquivos truncados (25/50/75%) e corrompidos (bytes trocados ao acaso, semente fixa) a partir
// dos que tinham peças. Critério igual: nada trava nem quebra; o resto é "lido" ou "recusado com motivo".
if (argv.includes('--mutate')) {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prumo-mut-'));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const base = rows.filter(r => r.status === 'pecas').map(r => r.arquivo);
  for (const rel of base) {
    const buf = fs.readFileSync(path.join(dir, rel));
    const variants = [0.25, 0.5, 0.75].map(f => ['trunc' + Math.round(f * 100), buf.subarray(0, Math.floor(buf.length * f))]);
    for (let k = 0; k < 2; k++) {
      const b = Buffer.from(buf);
      for (let m = 0; m < 12; m++) b[Math.floor(rnd() * b.length)] = 32 + Math.floor(rnd() * 90);
      variants.push(['corromp' + k, b]);
    }
    for (const [tag, data] of variants) {
      const f = path.join(tmp, `${tag}_${rel.replace(/[\\/]/g, '_')}`);
      fs.writeFileSync(f, data);
      let r;
      try {
        r = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'one.js'), f], { timeout: timeoutS * 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      } catch (e) {
        r = e.killed || e.signal === 'SIGTERM' ? { status: 'TIMEOUT' } : { status: 'FALHA_INTERNA', error: String(e.stderr || e.message).slice(0, 300) };
      }
      rows.push({ arquivo: `${tag}:${rel}`, mutacao: tag, kb: Math.round(data.length / 1024), ...r });
      if (/FALHA|TIMEOUT/.test(r.status)) console.log(`  ✖ ${tag}:${rel}: ${r.status} ${r.error || ''} ${r.stack || ''}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

const count = (s) => rows.filter(r => r.status === s).length;
const summary = {
  arquivos: rows.filter(r => !r.mutacao).length, variantes_mutadas: rows.filter(r => r.mutacao).length, com_pecas: count('pecas'), sem_pecas: count('sem_pecas'), recusados_com_motivo: count('recusado_com_motivo'),
  falha_interna: count('FALHA_INTERNA'), timeout: count('TIMEOUT'),
  tempo_total_s: +((Date.now() - t0) / 1000).toFixed(1), mais_lento_ms: Math.max(0, ...rows.map(r => r.ms || 0))
};
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'corpus.json'), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(strict && (summary.falha_interna || summary.timeout) ? 1 : 0);
