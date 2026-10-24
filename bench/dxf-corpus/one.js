// bench/dxf-corpus/one.js — lê UM arquivo pelo mesmo caminho do upload e imprime um resumo JSON (processo isolado).
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { parseDxf, buildCatalogFromDxf } = require(path.join(ROOT, 'cadParser'));
const { normalizeNestingParams } = require(path.join(ROOT, 'typesAndInterfaces'));
const file = process.argv[2];
const t0 = Date.now();
try {
  const parsed = parseDxf(fs.readFileSync(file));
  const { catalogParts, report, frames } = buildCatalogFromDxf(parsed, normalizeNestingParams({ chordal_tolerance: 0.03 }), {});
  const sev = {};
  for (const it of report.items || []) sev[it.severity] = (sev[it.severity] || 0) + 1;
  process.stdout.write(JSON.stringify({
    status: catalogParts.length ? 'pecas' : 'sem_pecas', ms: Date.now() - t0,
    parts: catalogParts.length, copies: catalogParts.reduce((s, p) => s + (p.quantity_detected || 1), 0),
    frames: (frames || []).length, closed: report.summary && report.summary.closedContours, severities: sev,
    codes: [...new Set((report.items || []).map(i => i.code))].slice(0, 12)
  }));
} catch (e) {
  // DxfReadError = arquivo inválido com mensagem para o usuário (HTTP 422): resposta CORRETA. Outro erro = defeito do Prumo.
  process.stdout.write(JSON.stringify({ status: e && e.name === 'DxfReadError' ? 'recusado_com_motivo' : 'FALHA_INTERNA', ms: Date.now() - t0, error: String(e && e.message).slice(0, 300), stack: e && e.name !== 'DxfReadError' ? String(e.stack).split('\n').slice(0, 4).join(' | ') : undefined }));
}
