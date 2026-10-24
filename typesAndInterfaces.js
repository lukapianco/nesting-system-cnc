// typesAndInterfaces.js
'use strict';

/**
 * @typedef {Object} Vec2
 * @property {number} x - Coordenada métrica X (mm)
 * @property {number} y - Coordenada métrica Y (mm)
 */

/**
 * @typedef {Object} AABB
 * @property {number} min_x
 * @property {number} min_y
 * @property {number} max_x
 * @property {number} max_y
 * @property {number} width
 * @property {number} height
 * @property {number} area
 */

/**
 * @typedef {Object} PolygonRing
 * @property {Vec2[]} vertices - Vértices locais (CCW para externo As > 0, CW para furo As < 0)
 * @property {Vec2[]} edge_normals - Vetores normais unitários externos pré-calculados
 * @property {AABB} bounding_box - Envelope axial rápido
 * @property {number} signed_area - Área algébrica com sinal (Fórmula de Gauss / Shoelace)
 * @property {number} area - Área absoluta (mm²)
 * @property {number} max_inscribed_radius - Raio máximo inscrito R_max (via Eixo Medial / MAT)
 * @property {Vec2} inscribed_center - Centro do maior círculo inscrito
 */

/**
 * @typedef {Object} PartGeometry
 * @property {string} id - Identificador único da peça
 * @property {string} name - Nome de exibição da peça
 * @property {PolygonRing} outer_contour - Contorno nominal externo (CCW, As > 0)
 * @property {PolygonRing} offset_outer_contour - Expandido por (part_clearance + kerf_width) / 2
 * @property {PolygonRing[]} inner_holes - Todos os furos internos (CW, As < 0)
 * @property {PolygonRing[]} usable_holes - Furos contraídos viáveis para Part-in-Part (hole_filling)
 * @property {number[]} allowed_rotations_deg - Ângulos permitidos conforme allow_rotation e grain_restriction
 * @property {boolean} allow_mirroring
 * @property {number} quantity_required
 */

/**
 * @typedef {Object} MandatoryNestingParams
 * @property {number} kerf_width - Espessura da fenda do feixe de corte K (mm)
 * @property {number} part_clearance - Ponte/distância mínima entre peças C_pp (mm)
 * @property {number} sheet_margin - Margem de segurança da borda da chapa C_borda (mm)
 * @property {boolean} allow_rotation - Habilita rotação da peça
 * @property {'NONE'|'FIXED_0'|'GRAIN_X'|'GRAIN_Y'|'ORTHOGONAL'|'FREE_45'|'FREE_15'} grain_restriction - Restrição mecânica de laminação/fibra
 * @property {boolean} hole_filling - Habilita inserção de peças menores dentro de furos (Part-in-Part)
 * @property {number} chordal_tolerance - Tolerância máxima de flecha delta_max (mm) p/ discretização de curvas
 * @property {number} min_hole_size - Dimensão mínima (mm) para um furo atuar como sub-chapa
 * @property {number} min_remnant_size - Dimensão mínima (mm) para rastreamento de retalhos reutilizáveis
 * @property {boolean} common_line_cutting - Habilita fusão de arestas colineares (distância = kerf_width)
 * @property {number} lead_in_length - Comprimento de entrada de perfuração Lead-in (mm)
 * @property {number} total_iterations - Orçamento de avaliações no Worker
 * @property {'MAX_UTILIZATION'|'MAX_SINGLE_REMNANT'|'MIN_BOUNDING_BOX'} optimization_goal
 */

/**
 * Normaliza e garante que todos os parâmetros mandatórios existam com tipagem estrita,
 * mantendo retrocompatibilidade com os campos enviados pelo frontend.
 * @param {Object} rawConfig
 * @returns {MandatoryNestingParams}
 */
function normalizeNestingParams(rawConfig = {}) {
  const kerf_width = Number(
    rawConfig.kerf_width ?? rawConfig.laserBeamWidth ?? 0.4
  );

  // Retrocompatibilidade: se o front enviou apenas "kerf" (que antes representava distância total),
  // decompomos em part_clearance + kerf_width conforme D_nom = C_pp + K
  const legacyTotalGap = Number(rawConfig.kerf ?? 6.0);
  const part_clearance = Number(
    rawConfig.part_clearance ?? Math.max(0, +(legacyTotalGap - kerf_width).toFixed(3))
  );

  const sheet_margin = Number(
    rawConfig.sheet_margin ?? rawConfig.part_clearance ?? legacyTotalGap
  );

  const allow_rotation = Boolean(
    rawConfig.allow_rotation ?? rawConfig.allowRotation ?? true
  );

  let grain_restriction = rawConfig.grain_restriction || 'ORTHOGONAL';
  if (!allow_rotation) {
    grain_restriction = 'FIXED_0';
  } else if (rawConfig.allowFreeAngles && grain_restriction === 'ORTHOGONAL') {
    grain_restriction = 'FREE_45';
  }

  const hole_filling = Boolean(
    rawConfig.hole_filling ?? rawConfig.enableInHole ?? true
  );

  return {
    sheet_width: Math.max(20, Number(rawConfig.sheet_width ?? rawConfig.sheetWidth ?? 1200)),
    sheet_height: Math.max(20, Number(rawConfig.sheet_height ?? rawConfig.sheetHeight ?? 800)),
    kerf_width: Math.max(0, kerf_width),
    part_clearance: Math.max(0, part_clearance),
    sheet_margin: Math.max(0, sheet_margin),
    allow_rotation,
    grain_restriction,
    hole_filling,
    chordal_tolerance: Math.max(0.005, Number(rawConfig.chordal_tolerance ?? 0.03)),
    min_hole_size: Math.max(1, Number(rawConfig.min_hole_size ?? rawConfig.minHoleSize ?? 15)),
    min_remnant_size: Math.max(10, Number(rawConfig.min_remnant_size ?? rawConfig.minRemnantSize ?? 40)),
    // CLC desativado (plano 0.2): só reduzia o espaçamento e o DXF saía com corte duplo. Volta na fase 3 (CLC real).
    // O valor pedido fica em common_line_requested para a interface avisar.
    common_line_cutting: false,
    common_line_requested: Boolean(rawConfig.common_line_cutting ?? rawConfig.commonLine ?? false),
    lead_in_length: Math.max(0, Number(rawConfig.lead_in_length ?? 2.5)),
    lead_in_type: ['ARC', 'LINE_45', 'LINE_90'].includes(rawConfig.lead_in_type) ? rawConfig.lead_in_type : 'ARC',
    pierce_radius: Math.max(0, Number(rawConfig.pierce_radius ?? rawConfig.pierceRadius ?? 1.0)),
    hole_clearance: Math.max(0, Number(rawConfig.hole_clearance ?? rawConfig.holeClearance ?? 2.0)),
    // PRECISE = retalhos com varredura fina em TODA avaliação; FAST = proxy rápido + varredura só nos promissores
    // 0 = sem limite; >0 encerra a otimização ao atingir o tempo, mantendo o melhor resultado
    time_limit_s: Math.max(0, Number(rawConfig.time_limit_s ?? 0)),
    evaluation_mode: rawConfig.evaluation_mode === 'FAST' ? 'FAST' : 'PRECISE',
    // fração dos genes de rotação (BRKGA) tratados como restritivos; o resto deixa o BLF escolher o melhor ângulo
    angle_gene_strictness: Math.min(1, Math.max(0, Number(rawConfig.angle_gene_strictness ?? 0.3))),
    hole_clearance: Math.max(0, Number(rawConfig.hole_clearance ?? rawConfig.holeClearance ?? 2.0)),
    // PRECISE = retalhos com varredura fina em TODA avaliação; FAST = proxy rápido + varredura só nos promissores
    evaluation_mode: rawConfig.evaluation_mode === 'FAST' ? 'FAST' : 'PRECISE',
    // fração dos genes de rotação (BRKGA) tratados como restritivos; o resto deixa o BLF escolher o melhor ângulo
    angle_gene_strictness: Math.min(1, Math.max(0, Number(rawConfig.angle_gene_strictness ?? 0.3))),
    pierce_radius: Math.max(0, Number(rawConfig.pierce_radius ?? rawConfig.pierceRadius ?? 1.0)),
    lead_in_type: ['ARC', 'LINE_45', 'LINE_90'].includes(rawConfig.lead_in_type) ? rawConfig.lead_in_type : 'ARC',
    total_iterations: Math.max(50, Math.min(250000, Number(rawConfig.total_iterations ?? rawConfig.totalIterations ?? 15000))),
    optimization_goal: rawConfig.optimization_goal || rawConfig.goal || 'MAX_UTILIZATION',
    seed_offset: Number(rawConfig.seed_offset ?? rawConfig.seedOffset ?? 1),
    // motor de posicionamento (ADR 006): AUTO = otimizador externo prumo-sparrow quando instalado e aplicável,
    // senão o clássico (BRKGA + BLF); CLASSICO e SPARROW forçam (SPARROW cai no clássico se não se aplicar)
    engine: ['AUTO', 'CLASSICO', 'SPARROW'].includes(String(rawConfig.engine ?? rawConfig.motor ?? 'AUTO').toUpperCase())
      ? String(rawConfig.engine ?? rawConfig.motor ?? 'AUTO').toUpperCase() : 'AUTO',
    // tempo do otimizador externo quando não há limite de tempo (o clássico usa o número de avaliações)
    external_time_s: Math.min(3600, Math.max(2, Number(rawConfig.external_time_s ?? 30))),
    // V5.7 (ADR 008): modo reproduzível = orçamento do otimizador externo em PASSOS (não em tempo) e divisão fixa de
    // threads; mesma entrada + mesma semente = mesmo plano em qualquer servidor (o tempo vira só teto de segurança)
    reproducible: rawConfig.reproducible === true || rawConfig.reproducible === 'true',
    external_budget: Math.min(200000, Math.max(20, Math.floor(Number(rawConfig.external_budget ?? 540)))),
    // buscas independentes ao mesmo tempo (sementes diferentes); 0 = automático pelas threads do job
    parallel_searches: Math.min(64, Math.max(0, Math.floor(Number(rawConfig.parallel_searches ?? 0))))
  };
}

/**
 * Retorna a lista discreta de ângulos permitidos (em graus) segundo allow_rotation e grain_restriction.
 * @param {boolean} allow_rotation
 * @param {string} grain_restriction
 * @returns {number[]}
 */
function resolveAllowedRotations(allow_rotation, grain_restriction) {
  if (!allow_rotation || grain_restriction === 'FIXED_0') {
    return [0];
  }
  switch (grain_restriction) {
    case 'GRAIN_X':
      return [0, 180]; // Mantém alinhado ao sentido de laminação longitudinal (0° e 180°)
    case 'GRAIN_Y':
      return [90, 270]; // Alinhado transversalmente à fibra
    case 'FREE_15':
      return Array.from({ length: 24 }, (_, k) => k * 15);
    case 'FREE_45':
      return [0, 45, 90, 135, 180, 225, 270, 315];
    case 'ORTHOGONAL':
    case 'NONE':
    default:
      return [0, 90, 180, 270];
  }
}

/**
 * Rotações RELATIVAS (filha dentro de furo) que mantêm o ângulo total da filha dentro do conjunto permitido
 * para QUALQUER ângulo permitido da peça-mãe. Ex.: GRAIN_Y {90,270} -> relativas {0,180}.
 * @param {number[]} allowed
 * @returns {number[]}
 */
function resolveRelativeRotations(allowed) {
  const set = new Set(allowed.map(a => ((a % 360) + 360) % 360));
  const rels = [];
  for (let r = 0; r < 360; r += 15) {
    if (allowed.every(h => set.has((((h + r) % 360) + 360) % 360))) rels.push(r);
  }
  return rels.length ? rels : [0];
}

module.exports = {
  normalizeNestingParams,
  resolveAllowedRotations,
  resolveRelativeRotations
};
