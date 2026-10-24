// engine/multiSheet.js — várias chapas e retalhos no mesmo cálculo (V5.8, ADR 009).
//
// O Prumo continua só no nesting: quem tem o estoque (o sistema de gestão, ou a pessoa na bancada) manda a lista de
// chapas; aqui só se decide a ORDEM de uso e quais peças vão em cada uma. O cálculo é chapa a chapa:
//   1. chapa desenhada (a sobra que a pessoa escolheu), se houver;
//   2. retalhos do estoque, do menor para o maior (gasta primeiro o que é mais difícil de aproveitar); um retalho em
//      que nenhuma peça que falta cabe é pulado sem calcular;
//   3. chapas inteiras, quantas forem informadas.
// Cada chapa é um cálculo comum (o mesmo worker, o mesmo validador) só com as peças que ainda faltam; o que não
// coube passa para a próxima. Com lote maior que a chapa, o worker decide o que entra (ADR 009).
'use strict';
const { normalizeNestingParams, resolveAllowedRotations } = require('../typesAndInterfaces');

const MAX_STOCK_SHEETS = 60;

/**
 * Lista ordenada de chapas a usar.
 * @param {Object|null} drawnSheet - chapa desenhada (isCustomDxf) ou null
 * @param {Object} rawConfig - config do job (normalizada ou não)
 * @returns {{index:number, kind:'desenhada'|'retalho'|'chapa', label:string, width:number, height:number, sheet:Object|null}[]}
 */
function buildStock(drawnSheet, rawConfig) {
  const cfg = normalizeNestingParams(rawConfig);
  const out = [];
  if (drawnSheet && drawnSheet.isCustomDxf) {
    out.push({ kind: 'desenhada', label: `chapa desenhada ${Math.round(drawnSheet.width)} × ${Math.round(drawnSheet.height)}`, width: drawnSheet.width, height: drawnSheet.height, sheet: drawnSheet });
  }
  const rem = (cfg.stock_remnants || []).slice().sort((a, b) => a.width * a.height - b.width * b.height);
  for (const s of rem) {
    for (let q = 0; q < s.quantity && out.length < MAX_STOCK_SHEETS; q++) {
      out.push({ kind: 'retalho', label: `retalho ${s.width} × ${s.height}`, width: s.width, height: s.height, sheet: null, remnantRef: s.ref || null });
    }
  }
  // chapas inteiras: o número pedido; com chapa desenhada e nada pedido, nenhuma (como antes da V5.8)
  let n = drawnSheet && drawnSheet.isCustomDxf && (rawConfig.stock_full_sheets == null) ? 0 : cfg.stock_full_sheets;
  if (!out.length && n < 1) n = 1; // sem estoque nenhum: a chapa da tela
  for (let i = 0; i < n && out.length < MAX_STOCK_SHEETS; i++) {
    out.push({ kind: 'chapa', label: `chapa ${cfg.sheet_width} × ${cfg.sheet_height}`, width: cfg.sheet_width, height: cfg.sheet_height, sheet: null });
  }
  return out.map((s, index) => ({ ...s, index }));
}

/** A peça cabe na chapa pela caixa, em algum dos giros permitidos (0°/90°)? Só serve para pular chapa inútil. */
function partFitsSheet(part, spec, cfg) {
  const b = cfg.sheet_margin + cfg.kerf_width * 0.5;
  const W = spec.width - 2 * b, H = spec.height - 2 * b;
  const allowed = resolveAllowedRotations(cfg.allow_rotation, cfg.grain_restriction);
  const turn = allowed.some(a => ((a % 180) + 180) % 180 === 90);
  const w = part.width, h = part.height;
  if (w <= W + 1e-6 && h <= H + 1e-6) return true;
  return turn && h <= W + 1e-6 && w <= H + 1e-6;
}

/**
 * Roda o cálculo chapa a chapa.
 * @param {{parts:Object[], stock:Object[], config:Object,
 *          runSheet:(parts:Object[], sheet:Object|null, config:Object, spec:Object)=>Promise<Object|null>,
 *          shouldStop?:()=>boolean, onSkip?:(spec:Object, why:string)=>void}} o
 *   runSheet devolve a mensagem final do worker ({type:'done', bestResult, ...}) ou null (cancelado).
 * @returns {Promise<{sheets:{spec:Object, done:Object}[], skipped:{spec:Object, why:string}[], unplaced:Object[], cancelled:boolean}>}
 */
async function runMultiSheet({ parts, stock, config, runSheet, shouldStop = () => false, onSkip = null }) {
  const cfg = normalizeNestingParams(config);
  let remaining = parts.slice();
  const sheets = [], skipped = [];
  const skip = (spec, why) => { skipped.push({ spec, why }); if (onSkip) onSkip(spec, why); };
  for (const spec of stock) {
    if (!remaining.length) break;
    if (shouldStop()) { skip(spec, 'cálculo parado antes desta chapa'); continue; }
    const fits = remaining.filter(p => partFitsSheet(p, spec, cfg));
    if (!fits.length) { skip(spec, 'nenhuma peça que falta cabe nesta chapa'); continue; }
    // cada chapa com uma semente diferente; as medidas da chapa retangular vêm da lista de estoque
    const sheetCfg = { ...config, sheet_width: spec.width, sheet_height: spec.height, seed_offset: (cfg.seed_offset || 1) + spec.index * 101 };
    const done = await runSheet(fits, spec.sheet, sheetCfg, spec);
    if (!done) return { sheets, skipped, unplaced: remaining, cancelled: true };
    if (done.type !== 'done' || !done.bestResult) { skip(spec, done.error ? `erro: ${done.error}` : 'sem plano'); continue; }
    const placedIds = new Set(done.bestResult.placedParts.map(p => p.id));
    if (!placedIds.size) { skip(spec, 'nenhuma peça coube'); continue; }
    sheets.push({ spec, done });
    remaining = remaining.filter(p => !placedIds.has(p.id));
  }
  return { sheets, skipped, unplaced: remaining, cancelled: false };
}

/** Resumo do conjunto: chapas usadas, peças, aproveitamento total (área das peças ÷ área das chapas usadas). */
function summarizeMulti(result, totalParts) {
  let used = 0, area = 0, placed = 0;
  for (const { done } of result.sheets) {
    used += done.bestResult.usedArea || 0;
    area += done.bestResult.sheetArea || 0;
    placed += done.bestResult.placedParts.length;
  }
  return {
    sheetsUsed: result.sheets.length,
    remnantsUsed: result.sheets.filter(s => s.spec.kind === 'retalho').length,
    placed,
    unplaced: result.unplaced.length,
    totalParts,
    usedArea: +used.toFixed(2),
    sheetArea: +area.toFixed(2),
    utilization: area > 0 ? +((used / area) * 100).toFixed(2) : 0
  };
}

module.exports = { buildStock, partFitsSheet, runMultiSheet, summarizeMulti, MAX_STOCK_SHEETS };
