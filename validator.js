// validator.js
'use strict';

/**
 * Validador INDEPENDENTE de layouts. Não importa nenhum predicado do motor (nfpEngine, worker):
 * reimplementa a geometria de propósito, para que um bug do motor não consiga validar a si mesmo.
 *
 * Verifica: peças perdidas/duplicadas, sobreposição, folga mínima D_nom entre peças, margem da chapa e
 * obstáculos, peças filhas dentro do furo (com folga de furo), retalhos fora das peças (com folga D_nom),
 * rotação permitida (fibra) e pierce em sucata.
 */

const TOL = 0.02; // mm

function segDistSq(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
  if (l2 === 0) return (px - x1) ** 2 + (py - y1) ** 2;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return (px - x1 - t * dx) ** 2 + (py - y1 - t * dy) ** 2;
}

function orient(ax, ay, bx, by, cx, cy) {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 1e-12 ? 1 : (v < -1e-12 ? -1 : 0);
}

function segsIntersect(a, b, c, d) {
  const o1 = orient(a.x, a.y, b.x, b.y, c.x, c.y), o2 = orient(a.x, a.y, b.x, b.y, d.x, d.y);
  const o3 = orient(c.x, c.y, d.x, d.y, a.x, a.y), o4 = orient(c.x, c.y, d.x, d.y, b.x, b.y);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function pip(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function bbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Distância mínima entre dois anéis (0 se cruzam). `contained` = um está dentro do outro. */
function ringsRelation(A, B) {
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i], a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      if (segsIntersect(a1, a2, B[j], B[(j + 1) % B.length])) return { dist: 0, crossing: true, contained: false };
    }
  }
  let m = Infinity;
  for (const p of A) for (let j = 0; j < B.length; j++) {
    const q = B[j], r = B[(j + 1) % B.length];
    const d = segDistSq(p.x, p.y, q.x, q.y, r.x, r.y);
    if (d < m) m = d;
  }
  for (const p of B) for (let i = 0; i < A.length; i++) {
    const q = A[i], r = A[(i + 1) % A.length];
    const d = segDistSq(p.x, p.y, q.x, q.y, r.x, r.y);
    if (d < m) m = d;
  }
  const contained = pip(A[0], B) || pip(B[0], A);
  return { dist: Math.sqrt(m), crossing: false, contained };
}

function ringDist(p, ring) {
  let m = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const d = segDistSq(p.x, p.y, a.x, a.y, b.x, b.y);
    if (d < m) m = d;
  }
  return Math.sqrt(m);
}

const abs = (part, pts) => pts.map((p) => ({ x: part.x + p.x, y: part.y + p.y }));
const norm360 = (a) => ((Math.round(a) % 360) + 360) % 360;

/**
 * @param {Object} res - layout (placedParts, unplacedParts, sheet*, cam)
 * @param {Object} params - parâmetros normalizados
 * @param {{expectedIds?: string[], allowedRotations?: number[]}} ctx
 */
function validateLayout(res, params, ctx = {}) {
  const errors = [];
  const warnings = [];
  const add = (list, type, msg, extra = {}) => list.push({ type, msg, ...extra });
  const parts = res.placedParts || [];

  // ---- 1) contabilidade de peças ----
  const seen = new Set();
  for (const p of parts) {
    if (seen.has(p.id)) add(errors, 'PECA_DUPLICADA', `Peça ${p.name} aparece mais de uma vez no layout.`, { partA: p.id });
    seen.add(p.id);
    if (![p.x, p.y].every(Number.isFinite)) add(errors, 'COORDENADA_INVALIDA', `Coordenada inválida em ${p.name}.`, { partA: p.id });
  }
  if (ctx.expectedIds) {
    const unplaced = new Set((res.unplacedParts || []).map((p) => p.id));
    const lost = ctx.expectedIds.filter((id) => !seen.has(id) && !unplaced.has(id));
    if (lost.length) add(errors, 'PECA_PERDIDA', `${lost.length} peça(s) sumiram (nem posicionadas nem listadas como não alocadas).`, { value: lost.slice(0, 5) });
  }

  const items = parts.map((p) => {
    const outer = abs(p, p.placedPoints);
    return {
      part: p, outer, box: bbox(outer),
      holes: (p.placedHoles || []).map((h) => ({ id: h.id, ring: abs(p, h.placedPoints) }))
    };
  });
  const byId = new Map(items.map((it) => [it.part.id, it]));
  const gap = params.common_line_cutting ? params.kerf_width : (params.part_clearance + params.kerf_width);
  const border = params.sheet_margin + params.kerf_width / 2;
  const top = items.filter((it) => !it.part.nestedInsideHole);
  const kids = items.filter((it) => it.part.nestedInsideHole);

  // ---- 2) chapa: limites, margem e obstáculos ----
  for (const it of top) {
    const p = it.part;
    if (res.sheetPoly) {
      for (const v of it.outer) {
        if (!pip(v, res.sheetPoly)) { add(errors, 'FORA_DA_CHAPA', `${p.name} sai do contorno da chapa.`, { partA: p.id }); break; }
      }
      const rel = ringsRelation(it.outer, res.sheetPoly);
      if (rel.dist < border - TOL) add(errors, 'MARGEM_CHAPA', `${p.name} a ${rel.dist.toFixed(2)} mm da borda (mín. ${border.toFixed(2)}).`, { partA: p.id, value: +rel.dist.toFixed(3) });
      for (const o of res.sheetObstacles || []) {
        const r = ringsRelation(it.outer, o.points);
        if (r.crossing || r.contained || r.dist < border - TOL) add(errors, 'OBSTACULO', `${p.name} invade/encosta em furo-obstáculo da chapa.`, { partA: p.id });
      }
    } else {
      const b = it.box;
      if (b.minX < border - TOL || b.minY < border - TOL || b.maxX > res.sheetWidth - border + TOL || b.maxY > res.sheetHeight - border + TOL) {
        add(errors, 'MARGEM_CHAPA', `${p.name} viola a margem da chapa (${border.toFixed(2)} mm).`, { partA: p.id });
      }
    }
  }

  // ---- 3) peça x peça (apenas contornos externos de peças não aninhadas) ----
  let pairs = 0;
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const A = top[i], B = top[j];
      if (A.box.minX - gap > B.box.maxX || B.box.minX - gap > A.box.maxX ||
          A.box.minY - gap > B.box.maxY || B.box.minY - gap > A.box.maxY) continue;
      pairs++;
      const rel = ringsRelation(A.outer, B.outer);
      if (rel.crossing || rel.contained) {
        add(errors, 'SOBREPOSICAO', `${A.part.name} e ${B.part.name} se sobrepõem.`, { partA: A.part.id, partB: B.part.id });
      } else if (rel.dist < gap - TOL) {
        add(errors, 'FOLGA_INSUFICIENTE', `${A.part.name} ↔ ${B.part.name}: ${rel.dist.toFixed(3)} mm (mín. ${gap.toFixed(2)}).`, { partA: A.part.id, partB: B.part.id, value: +rel.dist.toFixed(3) });
      }
    }
  }

  // ---- 4) peças filhas (Part-in-Part) ----
  for (const k of kids) {
    const p = k.part;
    const host = byId.get(p.inHoleParentId);
    if (!host) { add(errors, 'FILHA_ORFA', `${p.name} (In-Hole) sem peça mãe posicionada.`, { partA: p.id }); continue; }
    const hole = host.holes.find((h) => h.id === p.inHoleId);
    if (!hole) { add(errors, 'FILHA_SEM_FURO', `${p.name}: furo de destino não existe na mãe.`, { partA: p.id }); continue; }
    if (!k.outer.every((v) => pip(v, hole.ring))) {
      add(errors, 'FILHA_FORA_DO_FURO', `${p.name} não está inteira dentro do furo da mãe.`, { partA: p.id, partB: host.part.id });
      continue;
    }
    const rel = ringsRelation(k.outer, hole.ring);
    if (rel.crossing || rel.dist < params.hole_clearance - TOL) {
      add(errors, 'FOLGA_FURO', `${p.name} a ${rel.dist.toFixed(2)} mm da parede do furo (mín. ${params.hole_clearance}).`, { partA: p.id, value: +rel.dist.toFixed(3) });
    }
    for (const o of kids) {
      if (o === k) continue;
      const r2 = ringsRelation(k.outer, o.outer);
      if (r2.crossing || r2.contained || r2.dist < gap - TOL) add(errors, 'FILHAS_SE_TOCAM', `${p.name} e ${o.part.name} sem folga entre si.`, { partA: p.id, partB: o.part.id });
    }
  }

  // ---- 5b) retalhos úteis: são recortados da chapa como uma peça, então não podem invadir peça nem obstáculo
  //          e precisam da mesma folga D_nom (senão o corte do retalho passaria pela peça)
  for (const r of res.remnants || []) {
    const R = [{ x: r.x, y: r.y }, { x: r.x + r.width, y: r.y }, { x: r.x + r.width, y: r.y + r.height }, { x: r.x, y: r.y + r.height }];
    const rb = bbox(R);
    for (const it of top) {
      if (it.box.minX - gap > rb.maxX || rb.minX - gap > it.box.maxX || it.box.minY - gap > rb.maxY || rb.minY - gap > it.box.maxY) continue;
      const rel = ringsRelation(R, it.outer);
      if (rel.crossing || rel.contained) {
        add(errors, 'RETALHO_SOBRE_PECA', `${r.label || r.id} (${r.width}×${r.height}) invade ${it.part.name}.`, { partA: it.part.id });
      } else if (rel.dist < gap - TOL) {
        add(errors, 'RETALHO_FOLGA', `${r.label || r.id} a ${rel.dist.toFixed(2)} mm de ${it.part.name} (mín. ${gap.toFixed(2)}): o corte do retalho atingiria a peça.`, { partA: it.part.id, value: +rel.dist.toFixed(3) });
      }
    }
    for (const o of res.sheetObstacles || []) {
      const rel = ringsRelation(R, o.points);
      if (rel.crossing || rel.contained) add(errors, 'RETALHO_SOBRE_OBSTACULO', `${r.label || r.id} invade furo/defeito da chapa.`);
    }
  }

  // ---- 5) rotação permitida (fibra) ----
  if (ctx.allowedRotations) {
    const allowed = new Set(ctx.allowedRotations.map(norm360));
    for (const p of parts) {
      if (!allowed.has(norm360(p.angle || 0))) add(errors, 'ROTACAO_PROIBIDA', `${p.name} em ${norm360(p.angle || 0)}° viola a restrição de fibra.`, { partA: p.id });
    }
  }

  // ---- 6) CAM: perfuração em sucata ----
  if (res.cam && res.cam.ops) {
    const isMaterial = (pt) => items.some((it) => {
      if (pt.x < it.box.minX || pt.x > it.box.maxX || pt.y < it.box.minY || pt.y > it.box.maxY) return false;
      return pip(pt, it.outer) && !it.holes.some((h) => pip(pt, h.ring));
    });
    for (const op of res.cam.ops) {
      if (op.invalid) { add(warnings, 'LEAD_IN_SEM_ESPACO', `Lead-in sem espaço validado em ${op.partName}.`, { partA: op.partId }); continue; }
      if (op.pierce && isMaterial(op.pierce)) add(errors, 'PIERCE_EM_MATERIAL', `Perfuração de ${op.partName} cairia sobre material de peça.`, { partA: op.partId });
    }
    // V5.10: saída de corte (lead-out) só em sucata e dentro da chapa; microjunta sobre o contorno externo da própria
    // peça e com a largura pedida (um erro aqui quer dizer que a máquina cortaria onde não deve)
    const inSheet = (pt) => res.sheetPoly ? pip(pt, res.sheetPoly) : (pt.x >= 0 && pt.y >= 0 && pt.x <= res.sheetWidth && pt.y <= res.sheetHeight);
    const partById = new Map(items.map((it) => [it.part.id, it]));
    for (const op of res.cam.ops) {
      const path = op.leadOutPath || [];
      for (let i = 1; i < path.length; i++) {
        const q = path[i];
        if (!inSheet(q)) { add(errors, 'SAIDA_FORA_DA_CHAPA', `Saída de corte de ${op.partName} sai da chapa.`, { partA: op.partId }); break; }
        if (Math.hypot(q.x - path[0].x, q.y - path[0].y) > 0.3 && isMaterial(q)) { add(errors, 'SAIDA_EM_MATERIAL', `Saída de corte de ${op.partName} passaria sobre material de peça.`, { partA: op.partId }); break; }
      }
      if (op.tabs && op.tabs.length) {
        const it = partById.get(op.partId);
        if (op.kind !== 'OUTER' || !it) { add(errors, 'MICROJUNTA_FORA_DO_CONTORNO', `Microjunta fora do contorno externo em ${op.partName}.`, { partA: op.partId }); continue; }
        for (const t of op.tabs) {
          const off = Math.max(ringDist(t.start, it.outer), ringDist(t.end, it.outer));
          if (off > 0.05) add(errors, 'MICROJUNTA_FORA_DO_CONTORNO', `Microjunta de ${op.partName} não está sobre o contorno (${off.toFixed(3)} mm).`, { partA: op.partId });
          let len = 0;
          for (let i = 1; i < t.path.length; i++) len += Math.hypot(t.path[i].x - t.path[i - 1].x, t.path[i].y - t.path[i - 1].y);
          if (params.tab_width > 0 && Math.abs(len - params.tab_width) > 0.05) add(errors, 'MICROJUNTA_LARGURA', `Microjunta de ${op.partName} com ${len.toFixed(2)} mm (pedido ${params.tab_width} mm).`, { partA: op.partId });
        }
      }
    }
    if (res.cam.metrics && res.cam.metrics.leadOutsWithoutSpace > 0) {
      add(warnings, 'SAIDA_SEM_ESPACO', `${res.cam.metrics.leadOutsWithoutSpace} contorno(s) sem espaço para a saída de corte.`);
    }
    if (res.cam.metrics && res.cam.metrics.rapidCrossings > 0) {
      add(warnings, 'G00_SOBRE_PECA_CORTADA', `${res.cam.metrics.rapidCrossings} deslocamento(s) G00 passam sobre peça já cortada.`);
    }
  }

  return {
    ok: errors.length === 0,
    errorCount: errors.length,
    errors: errors.slice(0, 30),
    warnings: warnings.slice(0, 20),
    checkedParts: parts.length,
    checkedPairs: pairs
  };
}

module.exports = { validateLayout };
