const { runCase } = require('./ab');
(async () => {
  const CFG = { sheetWidth: 1100, sheetHeight: 600, kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, min_hole_size: 60, min_remnant_size: 100 };
  await runCase('C) industrial em chapa retangular 1100x600 — variantes da V5.1', {
    parts: 'industrial', config: CFG, iterations: 2500, seeds: 3,
    versions: ['V5', 'V5.1 atual(rápido,gene=1)', 'V5.1 gene=0', 'V5.1 precisa,gene=0', 'V5.1 precisa,gene=.3'],
    extra: {
      'V5.1 atual(rápido,gene=1)': { evaluation_mode: 'FAST', angle_gene_strictness: 1 },
      'V5.1 gene=0': { evaluation_mode: 'FAST', angle_gene_strictness: 0 },
      'V5.1 precisa,gene=0': { evaluation_mode: 'PRECISE', angle_gene_strictness: 0 },
      'V5.1 precisa,gene=.3': { evaluation_mode: 'PRECISE', angle_gene_strictness: 0.3 }
    }
  });
})();
