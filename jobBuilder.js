// jobBuilder.js
'use strict';

const { normalizeNestingParams } = require('./typesAndInterfaces');
const { buildCatalogFromDxf } = require('./cadParser');

const MAX_QTY_PER_PART = 500;
const MAX_EXPANDED_PARTS = 2000;

function expandPartsByQuantities(catalogParts, quantitiesMap = {}) {
  const expanded = [];
  for (const part of catalogParts) {
    // Sem quantidade informada: usa as cópias encontradas no desenho (DXF Doctor), senão 1.
    const qty = Math.max(0, Math.min(MAX_QTY_PER_PART, Math.floor(Number(quantitiesMap[part.id] ?? part.quantity_detected ?? 1)) || 0));
    for (let c = 1; c <= qty; c++) {
      expanded.push({
        ...part,
        instances: undefined, // posições no desenho original: só para catálogo/relatório, não vão ao worker
        basePartId: part.id,
        id: qty > 1 ? `${part.id}_COPY_${c}` : part.id,
        name: qty > 1 ? `${part.name} (${c}/${qty})` : part.name,
        copyIndex: c,
        totalCopies: qty,
        holes: (part.holes || []).map((h, hIdx) => ({ ...h, id: `${h.id}_C${c}_${hIdx}` }))
      });
    }
  }
  if (expanded.length > MAX_EXPANDED_PARTS) {
    throw new Error(`Lote com ${expanded.length} peças excede o limite de ${MAX_EXPANDED_PARTS}.`);
  }
  return expanded;
}

/**
 * Monta um job completo a partir do DXF já lido (parseDxf): a tolerância de flecha (chordal_tolerance) é
 * aplicada AQUI, a cada job, e as opções de importação (layers, molduras, unidade, costura) também.
 */
function buildJob({ parsedDxf, sheet = null, config = {}, quantities = {}, importOptions = {} }) {
  const normalizedConfig = normalizeNestingParams(config);
  const { catalogParts, report, frames, warnings } = buildCatalogFromDxf(parsedDxf, normalizedConfig, importOptions);
  const expandedParts = expandPartsByQuantities(catalogParts, quantities);
  return { catalogParts, expandedParts, normalizedConfig, sheet, warnings, report, frames };
}

module.exports = { expandPartsByQuantities, buildJob, MAX_QTY_PER_PART };
