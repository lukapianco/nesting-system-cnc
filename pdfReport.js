// pdfReport.js — relatório de corte em PDF, uma página por chapa (V5.10, passo 4 do plano; ADR 011).
//
// Sem dependências: escreve o PDF à mão (PDF 1.4, fontes padrão Helvetica, WinAnsi). Cada página traz o desenho da
// chapa com a ordem de corte, os números do plano, os retalhos e a lista de peças. É o documento do operador e do
// histórico; o arquivo que vai para a máquina continua sendo o DXF.
'use strict';

const PAGE_W = 842, PAGE_H = 595; // A4 deitada, em pontos
const WINANSI = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

/** Texto → bytes WinAnsi (latin1), com escape de PDF. Caractere fora da tabela vira "?". */
function pdfText(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    let c = ch.codePointAt(0);
    if (WINANSI[ch]) c = WINANSI[ch];
    else if (ch === '→') { out += '->'; continue; }
    else if (c > 255) c = 63;
    const k = String.fromCharCode(c);
    out += (k === '(' || k === ')' || k === '\\') ? '\\' + k : k;
  }
  return out;
}
const n2 = (v) => (Math.round(v * 100) / 100).toString();
const fmtNum = (v, d = 1) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtDur = (s) => {
  const t = Math.round(s || 0);
  if (t < 60) return `${t} s`;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(r).padStart(2, '0')} s`;
};
/** Largura aproximada do texto em Helvetica (média 0,52 em; suficiente para alinhar à direita e cortar nomes). */
const textW = (s, size) => String(s).length * size * 0.52;

class Page {
  constructor() { this.ops = []; }
  raw(s) { this.ops.push(s); return this; }
  color(r, g, b, stroke = false) { return this.raw(`${n2(r)} ${n2(g)} ${n2(b)} ${stroke ? 'RG' : 'rg'}`); }
  width(w) { return this.raw(`${n2(w)} w`); }
  dash(on, off) { return this.raw(on ? `[${n2(on)} ${n2(off)}] 0 d` : '[] 0 d'); }
  poly(pts, close, mode) { // mode: 'S' traço, 'f' preenche, 'B' os dois
    if (!pts.length) return this;
    let s = `${n2(pts[0].x)} ${n2(pts[0].y)} m`;
    for (let i = 1; i < pts.length; i++) s += ` ${n2(pts[i].x)} ${n2(pts[i].y)} l`;
    if (close) s += ' h';
    return this.raw(`${s} ${mode}`);
  }
  rect(x, y, w, h, mode) { return this.raw(`${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re ${mode}`); }
  text(x, y, size, s, bold = false) { return this.raw(`BT /${bold ? 'F2' : 'F1'} ${n2(size)} Tf ${n2(x)} ${n2(y)} Td (${pdfText(s)}) Tj ET`); }
  textRight(xRight, y, size, s, bold = false) { return this.text(xRight - textW(s, size), y, size, s, bold); }
  body() { return this.ops.join('\n'); }
}

function buildPdf(pages) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const catalog = add(null), pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of pages) {
    const body = p.body();
    const content = add(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const abs = (part, pts) => pts.map(p => ({ x: part.x + p.x, y: part.y + p.y }));

/** Página de uma chapa. */
function sheetPage(sheet, k, total, meta) {
  const L = sheet.layout;
  const pg = new Page();
  const title = total > 1 ? `Plano de corte — chapa ${k + 1} de ${total}` : 'Plano de corte';
  pg.color(0.1, 0.15, 0.11).text(36, PAGE_H - 40, 15, title, true);
  pg.color(0.3, 0.35, 0.32).text(36, PAGE_H - 56, 9, [meta.fileName, sheet.label, meta.date].filter(Boolean).join('  ·  '));

  // ---- desenho ----
  const box = { x: 36, y: 70, w: 520, h: PAGE_H - 140 };
  const W = L.sheetWidth, H = L.sheetHeight;
  const sc = Math.min(box.w / W, box.h / H);
  const ox = box.x + (box.w - W * sc) / 2, oy = box.y + (box.h - H * sc) / 2;
  const T = (p) => ({ x: ox + p.x * sc, y: oy + p.y * sc });
  const TP = (pts) => pts.map(T);
  const sheetPts = L.sheetPoly || [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  pg.color(0.96, 0.97, 0.95).poly(TP(sheetPts), true, 'f');
  pg.color(0.85, 0.45, 0.1, true).width(0.8).poly(TP(sheetPts), true, 'S');
  for (const o of L.sheetObstacles || []) pg.color(1, 1, 1).color(0.85, 0.45, 0.1, true).poly(TP(o.points), true, 'B');
  // retalhos
  pg.dash(3, 2).width(0.6);
  (L.remnants || []).forEach((r, i) => {
    const a = T({ x: r.x, y: r.y });
    pg.color(0.93, 0.91, 1).color(0.45, 0.36, 0.75, true).rect(a.x, a.y, r.width * sc, r.height * sc, 'B');
    const lbl = `R${i + 1}`;
    if (r.width * sc > 18 && r.height * sc > 10) pg.color(0.35, 0.27, 0.6).text(a.x + 3, a.y + 3, 7, lbl, true);
  });
  pg.dash(0);
  // peças (mães primeiro, filhas por cima)
  const parts = [...(L.placedParts || [])].sort((a, b) => (a.nestedInsideHole ? 1 : 0) - (b.nestedInsideHole ? 1 : 0));
  pg.width(0.5);
  for (const p of parts) {
    if (p.nestedInsideHole) pg.color(0.78, 0.93, 0.85); else pg.color(0.80, 0.89, 0.96);
    pg.color(0.1, 0.2, 0.3, true).poly(TP(abs(p, p.placedPoints)), true, 'B');
    for (const h of p.placedHoles || []) pg.color(1, 1, 1).poly(TP(abs(p, h.placedPoints)), true, 'B');
  }
  // CAM: entradas (vermelho), saídas (vermelho tracejado), microjuntas (traço grosso)
  const ops = (L.cam && L.cam.ops) || [];
  pg.color(0.85, 0.15, 0.12, true).width(0.6);
  for (const op of ops) if (op.leadPath && op.leadPath.length > 1) pg.poly(TP(op.leadPath), false, 'S');
  pg.dash(1.5, 1);
  for (const op of ops) if (op.leadOutPath && op.leadOutPath.length > 1) pg.poly(TP(op.leadOutPath), false, 'S');
  pg.dash(0).color(0.05, 0.05, 0.05, true).width(2.2);
  for (const op of ops) for (const t of op.tabs || []) pg.poly(TP(t.path), false, 'S');
  // ordem de corte no centro de cada peça
  for (const p of parts) {
    if (!p.cutSequenceOrder) continue;
    const c = T({ x: p.x + p.placedWidth / 2, y: p.y + p.placedHeight / 2 });
    const s = String(p.cutSequenceOrder), size = Math.max(5, Math.min(9, Math.min(p.placedWidth, p.placedHeight) * sc * 0.35));
    pg.color(0.1, 0.12, 0.12).text(c.x - textW(s, size) / 2, c.y - size / 3, size, s, true);
  }
  pg.color(0.3, 0.35, 0.32).text(box.x, box.y - 14, 7.5, `${fmtNum(W, 0)} × ${fmtNum(H, 0)} mm. Números = ordem de corte das peças. Vermelho = entrada; tracejado = saída; traço preto = microjunta.`);

  // ---- coluna da direita ----
  let y = PAGE_H - 92;
  const X0 = 580, X1 = PAGE_W - 36;
  const row = (label, value, bold = false) => {
    pg.color(0.2, 0.25, 0.22).text(X0, y, 8.5, label);
    pg.color(0.08, 0.12, 0.1).textRight(X1, y, 8.5, value, bold);
    pg.color(0.82, 0.86, 0.8, true).width(0.4).poly([{ x: X0, y: y - 4 }, { x: X1, y: y - 4 }], false, 'S');
    y -= 15;
  };
  const head = (s) => { y -= 4; pg.color(0.1, 0.29, 0.2).text(X0, y, 10, s, true); y -= 15; };
  head('Números do plano');
  const m = (L.cam && L.cam.metrics) || {};
  row('Peças nesta chapa', String((L.placedParts || []).length), true);
  row('Material usado vira peça', `${fmtNum(L.compactUtilization ?? L.rawUtilization, 1)}%`, true);
  row('Chapa inteira', `${fmtNum(L.rawUtilization, 1)}%`);
  row('Área das peças', `${fmtNum((L.usedArea || 0) / 1e6, 3)} m²`);
  row('Conferência', L.validation ? (L.validation.ok ? 'APROVADO' : `REPROVADO (${L.validation.errorCount})`) : '—', true);
  row('Perfurações', String(m.pierceCount ?? '—'));
  row('Corte / em vazio', `${fmtNum((m.cutLength || 0) / 1000, 2)} m / ${fmtNum((m.rapidLength || 0) / 1000, 2)} m`);
  row('Em vazio sobre peça solta', String(m.rapidCrossings ?? 0));
  if (m.tabCount) row('Microjuntas', `${m.tabCount} × ${fmtNum(L.cam.finishing.tab_width, 1)} mm`);
  const te = L.cam && L.cam.timeEstimate;
  if (te) row('Tempo de máquina (estimativa)', fmtDur(te.totalS), true);

  head('Retalhos para o estoque');
  const rems = L.remnants || [];
  if (!rems.length) row('nenhum', '');
  rems.slice(0, 6).forEach((r, i) => row(`R${i + 1}`, `${fmtNum(r.width, 0)} × ${fmtNum(r.height, 0)} mm`));
  if (rems.length > 6) row(`+ ${rems.length - 6} retalhos`, '');

  head('Peças');
  const groups = new Map();
  for (const p of L.placedParts || []) {
    const name = String(p.name || p.id).replace(/ \(\d+\/\d+\)$/, '');
    const g = groups.get(name) || { name, n: 0, w: p.width ?? p.placedWidth, h: p.height ?? p.placedHeight };
    g.n++; groups.set(name, g);
  }
  const list = [...groups.values()];
  const maxRows = Math.max(1, Math.floor((y - 60) / 15));
  for (const g of list.slice(0, maxRows)) {
    const nm = g.name.length > 24 ? g.name.slice(0, 23) + '…' : g.name;
    row(`${g.n} × ${nm}`, `${fmtNum(g.w, 0)} × ${fmtNum(g.h, 0)}`);
  }
  if (list.length > maxRows) row(`+ ${list.length - maxRows} tipos de peça`, '');

  // ---- rodapé ----
  pg.color(0.4, 0.42, 0.4).text(36, 24, 7.2,
    'Prumo. Tempo de máquina = estimativa com os valores informados (não dado de fabricante). Saída, sobrepasse e microjuntas: não testados em máquina; confira no primeiro corte.');
  return pg;
}

/** Página de resumo de um conjunto de chapas. */
function summaryPage(sheets, meta) {
  const pg = new Page();
  pg.color(0.1, 0.15, 0.11).text(36, PAGE_H - 40, 15, 'Conjunto de chapas', true);
  pg.color(0.3, 0.35, 0.32).text(36, PAGE_H - 56, 9, [meta.fileName, meta.date].filter(Boolean).join('  ·  '));
  const sm = meta.summary || {};
  let y = PAGE_H - 92;
  const line = (cols, bold = false) => {
    const xs = [36, 66, 270, 380, 470, 560, 680];
    cols.forEach((c, i) => pg.color(0.1, 0.12, 0.11).text(xs[i], y, 9, c, bold));
    pg.color(0.82, 0.86, 0.8, true).width(0.4).poly([{ x: 36, y: y - 4 }, { x: PAGE_W - 36, y: y - 4 }], false, 'S');
    y -= 16;
  };
  line(['#', 'Chapa', 'Medidas (mm)', 'Peças', 'Aproveitamento', 'Retalho maior', 'Tempo (estim.)'], true);
  let tt = 0;
  sheets.forEach((s, i) => {
    const L = s.layout, te = L.cam && L.cam.timeEstimate;
    tt += te ? te.totalS : 0;
    const big = (L.remnants || []).reduce((m, r) => (r.width * r.height > m.a ? { a: r.width * r.height, r } : m), { a: 0, r: null }).r;
    line([String(i + 1), s.label || '', `${fmtNum(L.sheetWidth, 0)} × ${fmtNum(L.sheetHeight, 0)}`, String(L.placedParts.length),
      `${fmtNum(L.rawUtilization, 1)}%`, big ? `${fmtNum(big.width, 0)} × ${fmtNum(big.height, 0)}` : '—', te ? fmtDur(te.totalS) : '—']);
  });
  y -= 8;
  pg.color(0.1, 0.29, 0.2).text(36, y, 11, `Aproveitamento do conjunto: ${fmtNum(sm.utilization ?? 0, 1)}%   ·   Peças: ${sm.placed ?? '—'} de ${sm.totalParts ?? '—'}   ·   Faltaram: ${sm.unplaced ?? 0}   ·   Tempo total (estimativa): ${fmtDur(tt)}`, true);
  pg.color(0.4, 0.42, 0.4).text(36, 24, 7.2, 'Prumo. Cada chapa tem a sua página a seguir. Tempo de máquina = estimativa com os valores informados (não dado de fabricante).');
  return pg;
}

/**
 * @param {{layout:Object, label?:string}[]} sheets
 * @param {{fileName?:string, date?:string, summary?:Object}} meta
 * @returns {Buffer}
 */
function buildReportPdf(sheets, meta = {}) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('Nenhuma chapa para o relatório.');
  for (const s of sheets) if (!s || !s.layout || !Array.isArray(s.layout.placedParts)) throw new Error('Layout inválido no relatório.');
  const pages = [];
  if (sheets.length > 1) pages.push(summaryPage(sheets, meta));
  sheets.forEach((s, i) => pages.push(sheetPage(s, i, sheets.length, meta)));
  return buildPdf(pages);
}

module.exports = { buildReportPdf, pdfText };
