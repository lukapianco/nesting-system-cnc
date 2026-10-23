// jobBuilder.js
'use strict';

const { normalizeNestingParams } = require('./typesAndInterfaces');
const { extractContoursFromDxf, classifyPartsAndHoles } = require('./cadParser');

const MAX_QTY_PER_PART = 500;
const MAX_EXPANDED_PARTS = 2000;

function expandPartsByQuantities(catalogParts, quantitiesMap = {}) {
  const expanded = [];
  for (const part of catalogParts) {
    const qty = Math.max(0, Math.min(MAX_QTY_PER_PART, Math.floor(Number(quantitiesMap[part.id] ?? 1)) || 0));
    for (let c = 1; c <= qty; c++) {
      expanded.push({
        ...part,
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
 * Monta um job completo a partir do DXF já parseado: a tolerância de flecha (chordal_tolerance) agora
 * é aplicada AQUI, a cada job (antes o upload fixava 0.03 e o campo da interface não fazia nada).
 */
function buildJob({ parsedDxf, sheet = null, config = {}, quantities = {} }) {
  const normalizedConfig = normalizeNestingParams(config);
  const contours = extractContoursFromDxf(parsedDxf, normalizedConfig.chordal_tolerance);
  const catalogParts = classifyPartsAndHoles(contours, normalizedConfig.min_hole_size, normalizedConfig);
  const expandedParts = expandPartsByQuantities(catalogParts, quantities);
  return { catalogParts, expandedParts, normalizedConfig, sheet, warnings: contours.warnings || [] };
}

module.exports = { expandPartsByQuantities, buildJob, MAX_QTY_PER_PART };
