// processProfiles.js
'use strict';

/**
 * Valores INICIAIS por processo de corte e espessura.
 *
 * ATENÇÃO: são pontos de partida conservadores derivados de regras práticas de chão de fábrica (e do relatório
 * técnico do projeto), NÃO dados de fabricante. Kerf, ponte e lead-in variam com máquina, bico, gás, potência,
 * velocidade e material. Sempre valide com um corte de teste e ajuste conforme a tabela de corte da máquina.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

const PROCESSES = {
  LASER_FIBRA: {
    label: 'Laser de fibra',
    description: 'Aço carbono, inox e alumínio de baixa/média espessura. Kerf fino, pontes curtas, lead-in curto em arco.',
    recommend: (t) => ({
      kerf_width: r2(clamp(0.12 + 0.012 * t, 0.15, 0.45)),
      part_clearance: r1(Math.max(1.5, 1.0 * t)),
      sheet_margin: r1(clamp(5 + 0.3 * t, 5, 12)),
      lead_in_length: r1(clamp(Math.max(1.5, 1.0 * t), 1.5, 8)),
      pierce_radius: r1(clamp(0.5 + 0.3 * t, 0.8, 4)),
      min_hole_size: Math.round(Math.max(15, 4 * t))
    })
  },
  LASER_CO2: {
    label: 'Laser CO₂',
    description: 'Aço, inox, acrílico e madeira. Kerf um pouco maior que o de fibra; perfuração mais lenta em chapas grossas.',
    recommend: (t) => ({
      kerf_width: r2(clamp(0.2 + 0.015 * t, 0.2, 0.6)),
      part_clearance: r1(Math.max(2.0, 1.0 * t)),
      sheet_margin: r1(clamp(6 + 0.3 * t, 6, 14)),
      lead_in_length: r1(clamp(Math.max(2, 1.0 * t), 2, 10)),
      pierce_radius: r1(clamp(0.8 + 0.3 * t, 1, 5)),
      min_hole_size: Math.round(Math.max(15, 4 * t))
    })
  },
  PLASMA: {
    label: 'Plasma',
    description: 'Aço carbono/inox de média e alta espessura. Kerf largo, ZTA considerável: pontes largas, lead-in longo, margem maior.',
    recommend: (t) => ({
      kerf_width: r2(clamp(1.2 + 0.08 * t, 1.5, 4.0)),
      part_clearance: r1(Math.max(5, 1.0 * t)),
      sheet_margin: r1(clamp(8 + 0.3 * t, 10, 20)),
      lead_in_length: r1(clamp(Math.max(5, 1.0 * t), 5, 15)),
      pierce_radius: r1(clamp(1.5 + 0.1 * t, 2, 5)),
      min_hole_size: Math.round(Math.max(30, 3 * t))
    })
  },
  OXICORTE: {
    label: 'Oxicorte',
    description: 'Aço carbono grosso. Pré-aquecimento e perfuração com grande cratera: pontes e margens bem maiores.',
    recommend: (t) => ({
      kerf_width: r2(clamp(1.5 + 0.04 * t, 1.5, 3.0)),
      part_clearance: r1(Math.max(10, 0.5 * t)),
      sheet_margin: r1(clamp(10 + 0.2 * t, 15, 30)),
      lead_in_length: r1(clamp(Math.max(8, 0.5 * t), 8, 25)),
      pierce_radius: r1(clamp(2 + 0.05 * t, 3, 8)),
      min_hole_size: Math.round(Math.max(40, 3 * t))
    })
  },
  JATO_AGUA: {
    label: 'Jato d\'água',
    description: 'Qualquer material, sem ZTA. Pontes curtas; cuidado com delaminação (cerâmica, compósitos, vidro) na perfuração.',
    recommend: (t) => ({
      kerf_width: r2(clamp(0.8 + 0.005 * t, 0.8, 1.2)),
      part_clearance: r1(Math.max(3, 0.25 * t)),
      sheet_margin: r1(clamp(8 + 0.1 * t, 8, 15)),
      lead_in_length: r1(clamp(Math.max(3, 0.3 * t), 3, 12)),
      pierce_radius: r1(clamp(1.5 + 0.05 * t, 1.5, 4)),
      min_hole_size: Math.round(Math.max(15, 3 * t))
    })
  },
  ROUTER: {
    label: 'Router CNC',
    description: 'Madeira, MDF, acrílico, alumínio. O kerf é o diâmetro da fresa; ponte e lead-in dependem dela.',
    recommend: (t, o = {}) => {
      const d = clamp(Number(o.toolDiameter) || 6, 1, 25);
      return {
        kerf_width: r2(d),
        part_clearance: r1(Math.max(4, d)),
        sheet_margin: r1(Math.max(10, 2 * d)),
        lead_in_length: r1(Math.max(d, 6)),
        pierce_radius: r1(d / 2),
        min_hole_size: Math.round(Math.max(2 * d, 15))
      };
    }
  }
};

/**
 * @param {string} process chave de PROCESSES
 * @param {number} thickness espessura em mm (> 0)
 * @param {{toolDiameter?: number}} opts
 */
function recommendParams(process, thickness, opts = {}) {
  const p = PROCESSES[process];
  if (!p) throw new Error(`Processo desconhecido: ${process}`);
  const t = Number(thickness);
  if (!Number.isFinite(t) || t <= 0 || t > 200) throw new Error('Espessura deve estar entre 0 e 200 mm.');
  const v = p.recommend(t, opts);
  v.lead_in_type = 'ARC';
  // folga peça-filha/furo: kerf + metade do lead-in + 1 mm (o lead-in da filha precisa caber no anel de sucata)
  v.hole_clearance = r1(Math.max(2.0, v.kerf_width + 0.5 * v.lead_in_length + 1.0));
  const notes = [
    'Valores iniciais conservadores — valide com um corte de teste e ajuste pela tabela de corte da sua máquina.',
    `Ponte entre peças = ${v.part_clearance} mm (distância nominal entre contornos = ponte + kerf = ${r2(v.part_clearance + v.kerf_width)} mm).`
  ];
  if (t >= 12 && process.startsWith('LASER')) notes.push('Chapa grossa para laser: considere aumentar a ponte para até 1,2× a espessura se houver empenamento.');
  if (process === 'JATO_AGUA') notes.push('Materiais frágeis (vidro, cerâmica, pedra): aumente o raio de cratera e use lead-in em arco longo.');
  return { process, label: p.label, thickness: t, params: v, notes };
}

function listProcesses() {
  return Object.entries(PROCESSES).map(([key, p]) => ({ key, label: p.label, description: p.description }));
}

module.exports = { recommendParams, listProcesses, PROCESSES };
