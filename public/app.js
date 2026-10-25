// public/app.js
'use strict';

let currentUploadId = null;
let currentArchive = [];
let runToken = 0;          // identifica a execução vigente; mensagens de execuções antigas são descartadas
let startDebounce = null;
let catalogParts = [];
let partQuantities = {};
let customSheetDxf = null;
let multiResult = null, activeSheet = 0, sheetRunPrefix = ''; // cálculo com várias chapas (V5.8)
let bestSolutionGlobal = null;
let activeEventSource = null;
let seedCounter = 1;
let currentJobId = null;
let lastDxfReport = null;
let excludedLayers = new Set();      // layers que o usuário desmarcou no diagnóstico
let onlyFrames = null;               // ids de moldura escolhidos (null = todas)
let sheetBeforeFrame = null;         // medidas da chapa antes de aplicar a moldura (para desfazer)
let sheetContour = null;             // candidato a chapa escolhido no próprio desenho (ex.: CHAPA_1)

// Estado de Viewport (Zoom & Pan)
let viewZoom = 1;
let viewPanX = 0;
let viewPanY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let lastRenderTransform = { startX: 0, startY: 0, scale: 1, H: 0 };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Seletores de DOM
const dxfInput = document.getElementById('dxfInput');
const sheetDxfInput = document.getElementById('sheetDxfInput');
const fileNameLabel = document.getElementById('fileNameLabel');
const sheetFileNameLabel = document.getElementById('sheetFileNameLabel');
const btnClearCustomSheet = document.getElementById('btnClearCustomSheet');
const presetSelect = document.getElementById('presetSelect');
const sheetPresetSelect = document.getElementById('sheetPresetSelect');

// Parâmetros Mandatórios CAM
const sheetWidthInput = document.getElementById('sheetWidth');
const sheetHeightInput = document.getElementById('sheetHeight');
const kerfWidthInput = document.getElementById('kerfWidthInput');
const partClearanceInput = document.getElementById('partClearanceInput');
const sheetMarginInput = document.getElementById('sheetMarginInput');
const leadInLengthInput = document.getElementById('leadInLengthInput');
const minHoleSizeInput = document.getElementById('minHoleSize');
const minRemnantSizeInput = document.getElementById('minRemnantSize');
const chordalToleranceInput = document.getElementById('chordalToleranceInput');
const iterationsInput = document.getElementById('iterationsInput');
const grainRestrictionSelect = document.getElementById('grainRestrictionSelect');
const optimizationGoalSelect = document.getElementById('optimizationGoal');
const holeClearanceInput = document.getElementById('holeClearanceInput');
const pierceRadiusInput = document.getElementById('pierceRadiusInput');
const leadInTypeSelect = document.getElementById('leadInTypeSelect');
const qualityModeSelect = document.getElementById('qualityModeSelect');
const timeLimitInput = document.getElementById('timeLimitInput');
const processSelect = document.getElementById('processSelect');
const thicknessInput = document.getElementById('thicknessInput');
const btnApplyProfile = document.getElementById('btnApplyProfile');
const profileNotes = document.getElementById('profileNotes');

// Diagnóstico do DXF (DXF Doctor)
const dxfReportBox = document.getElementById('dxfReport');
const dxfReportStatus = document.getElementById('dxfReportStatus');
const dxfReportFile = document.getElementById('dxfReportFile');
const dxfFrameBanner = document.getElementById('dxfFrameBanner');
const dxfReportItems = document.getElementById('dxfReportItems');
const dxfLayerList = document.getElementById('dxfLayerList');
const dxfUnitsSelect = document.getElementById('dxfUnitsSelect');
const dxfFrameModeSelect = document.getElementById('dxfFrameModeSelect');
const dxfJoinTolInput = document.getElementById('dxfJoinTolInput');
const dxfMaxGapInput = document.getElementById('dxfMaxGapInput');
const dxfGroupIdentical = document.getElementById('dxfGroupIdentical');
const dxfIncludeDashed = document.getElementById('dxfIncludeDashed');
const dxfIncludeHidden = document.getElementById('dxfIncludeHidden');
const btnStopKeepBest = document.getElementById('btnStopKeepBest');

// Regra do produto: qualidade > velocidade. O modo define o ORÇAMENTO de busca, nunca a correção do resultado.
const QUALITY_MODES = {
  // external_budget: passos do otimizador no modo reproduzível (ADR 008). Medido na V5.7: uma busca de 2 threads num
  // Xeon 2,1 GHz faz ~18 passos/s, então os passos duram perto do tempo do modo numa máquina com 4 threads livres;
  // com menos threads (o modo usa sempre 2 buscas × 3 threads desde a V5.8) demora mais, numa CPU mais rápida termina antes
  RASCUNHO: { iterations: 3000, evaluation_mode: 'FAST', external_time_s: 10, external_budget: 180 },
  PADRAO: { iterations: 15000, evaluation_mode: 'PRECISE', external_time_s: 30, external_budget: 540 },
  PRODUCAO: { iterations: 60000, evaluation_mode: 'PRECISE', external_time_s: 120, external_budget: 2160 }
};
const engineSelect = document.getElementById('engineSelect');

const allowRotationInput = document.getElementById('allowRotation');
const enableInHoleInput = document.getElementById('enableInHole');
const commonLineInput = document.getElementById('commonLineInput');
const showRemnantsInput = document.getElementById('showRemnants');
const showCamToolpathInput = document.getElementById('showCamToolpath');
const exportIncludeRemnantsInput = document.getElementById('exportIncludeRemnants');
const exportIncludeLeadInInput = document.getElementById('exportIncludeLeadIn');

const btnRecalculate = document.getElementById('btnRecalculate');
const btnLoadSample = document.getElementById('btnLoadSample');
const btnExportDxf = document.getElementById('btnExportDxf');
const btnAutoFillSheet = document.getElementById('btnAutoFillSheet');

const progressPanel = document.getElementById('progressPanel');
const progressStatusText = document.getElementById('progressStatusText');
const progressPercentText = document.getElementById('progressPercentText');
const progressBarFill = document.getElementById('progressBarFill');
const progressStrategyText = document.getElementById('progressStrategyText');
const progressBestText = document.getElementById('progressBestText');

const candidatesBar = document.getElementById('candidatesBar');
const candidatesList = document.getElementById('candidatesList');
const nestingCanvas = document.getElementById('nestingCanvas');
const hoverInspector = document.getElementById('hoverInspector');
const ctx = nestingCanvas.getContext('2d');

const pct = (v) => `${Math.max(0, Math.min(100, Math.round(v)))}%`;
async function refreshHardwareStatus() {
  try {
    const res = await fetch('/api/hardware');
    const hw = await res.json();
    const u = hw.usage || {};
    const ext = hw.externalOptimizer || {};
    const cores = (u.cpuPerCore || []).map(v => `<i style="--h:${pct(v)}" title="núcleo: ${pct(v)}"></i>`).join('');
    document.getElementById('hwInfoBox').innerHTML =
      `<div class="meter-row"><span>Processador</span><span class="meter ${u.cpuPct > 85 ? 'hot' : ''}"><i style="width:${pct(u.cpuPct || 0)}"></i></span><b>${pct(u.cpuPct || 0)}</b></div>` +
      (cores ? `<div class="cores">${cores}</div>` : '') +
      `<div class="meter-row"><span>Memória</span><span class="meter"><i style="width:${pct(u.memUsedPct || 0)}"></i></span><b>${pct(u.memUsedPct || 0)}</b></div>` +
      `<div class="server-line">Cálculos: <b>${u.jobsRunning ?? hw.activeWorkers}</b> rodando de ${hw.maxWorkers} ao mesmo tempo, <b>${u.jobsQueued ?? hw.queueSize}</b> na fila</div>` +
      `<div class="server-line">Otimizador sparrow: <b>${ext.installed ? (ext.running ? `rodando (${ext.running})` : 'instalado') : 'não instalado'}</b></div>` +
      `<div class="server-line">${esc(hw.cpuModel)}, ${hw.totalCores} núcleos${u.memTotalGb ? `, ${u.memTotalGb} GB` : ''}</div>`;
    document.getElementById('engineStatus').textContent = ext.installed
      ? 'Otimizador sparrow instalado neste servidor.'
      : 'Otimizador sparrow não instalado: o Automático usa o motor clássico.';
  } catch (_) { /* servidor fora do ar: o painel fica com o último valor */ }
}
// Atualiza a cada 2 s enquanto a aba está visível (o painel mostra o servidor trabalhando, não só a configuração)
setInterval(() => { if (!document.hidden) refreshHardwareStatus(); }, 2000);

// =========================================================
// 1. MULTIPLICADOR DE LOTE E QUANTIDADES SINCRONIZADAS
// =========================================================

function initDefaultQuantities(partsList) {
  // Cópias idênticas encontradas no desenho já chegam como quantidade (o usuário pode mudar)
  partQuantities = {};
  partsList.forEach(p => { partQuantities[p.id] = p.quantity_detected || 1; });
  syncQuantityViews();
}

function setPartQuantity(partId, newQty, triggerSim = true) {
  const cleanQty = Math.max(0, Math.min(500, Number(newQty) || 0));
  partQuantities[partId] = cleanQty;
  syncQuantityViews();
  if (triggerSim) scheduleOptimization();
}

function syncQuantityViews() {
  const totalCount = catalogParts.reduce((acc, p) => acc + (partQuantities[p.id] || 0), 0);
  document.getElementById('totalPartsBadge').textContent = `${totalCount} ${totalCount === 1 ? 'peça' : 'peças'}`;
  updateJobLine();

  const sidebarList = document.getElementById('sidebarQtyList');
  sidebarList.innerHTML = '';

  catalogParts.forEach(part => {
    const q = partQuantities[part.id] ?? 1;
    const row = document.createElement('div');
    row.className = 'qty-item-row';
    row.innerHTML = `
      <div class="qty-item-info">
        <span class="qty-item-name">${esc(part.name)}</span>
        <span class="qty-item-dim">${Math.round(part.width)} × ${Math.round(part.height)} mm</span>
        ${part.quantity_detected > 1 ? `<span class="qty-item-detected">${part.quantity_detected} no desenho</span>` : ''}
      </div>
      <div class="qty-stepper">
        <button type="button" class="qty-btn" data-act="dec" data-id="${part.id}">−</button>
        <input type="number" class="qty-number-input" value="${q}" min="0" max="500" data-id="${part.id}" />
        <button type="button" class="qty-btn" data-act="inc" data-id="${part.id}">+</button>
      </div>
    `;
    sidebarList.appendChild(row);
  });

  catalogParts.forEach(part => {
    const cardInput = document.getElementById(`card_qty_${part.id}`);
    if (cardInput) cardInput.value = partQuantities[part.id] ?? 1;
  });

  sidebarList.querySelectorAll('.qty-btn').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      const cur = partQuantities[id] ?? 1;
      setPartQuantity(id, btn.dataset.act === 'inc' ? cur + 1 : cur - 1);
    };
  });

  sidebarList.querySelectorAll('.qty-number-input').forEach(inp => {
    inp.onchange = () => setPartQuantity(inp.dataset.id, inp.value);
  });
}

document.querySelectorAll('.qty-quick [data-mult]').forEach(btn => {
  btn.addEventListener('click', () => {
    const mult = Number(btn.dataset.mult);
    catalogParts.forEach(p => { partQuantities[p.id] = mult; });
    syncQuantityViews();
    scheduleOptimization();
  });
});

btnAutoFillSheet.addEventListener('click', () => {
  if (!catalogParts.length) return;
  const sheetArea = customSheetDxf
    ? customSheetDxf.area
    : Number(sheetWidthInput.value) * Number(sheetHeightInput.value);

  const singleSetArea = catalogParts.reduce((acc, p) => acc + p.bboxArea * 1.15, 0);
  if (singleSetArea <= 0) return;

  const targetSets = Math.max(1, Math.min(80, Math.floor((sheetArea * 0.72) / singleSetArea)));
  catalogParts.forEach(p => { partQuantities[p.id] = targetSets; });
  syncQuantityViews();
  scheduleOptimization();
});

/** Para o cálculo em andamento já (o servidor encerra o worker e o processo do otimizador) e invalida as mensagens dele. */
function cancelActiveRun(reason = '') {
  runToken++;
  if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
  btnStopKeepBest.classList.add('hidden');
  btnRecalculate.disabled = false;
  if (reason) {
    progressPanel.classList.remove('hidden');
    progressStatusText.textContent = reason;
    progressStrategyText.textContent = '';
  }
}

function scheduleOptimization(delay = 400) {
  clearTimeout(startDebounce);
  // a entrada mudou: o cálculo antigo não vale mais e não pode continuar ocupando o servidor
  if (activeEventSource) cancelActiveRun('Entrada mudou: o cálculo anterior foi parado, recalculando…');
  startDebounce = setTimeout(startBackendSseOptimization, delay);
}

// Mudou chapa, corte ou busca: recalcula (e para o cálculo anterior na hora)
['sheetWidth', 'sheetHeight', 'kerfWidthInput', 'partClearanceInput', 'sheetMarginInput', 'holeClearanceInput', 'leadInLengthInput',
  'pierceRadiusInput', 'leadInTypeSelect', 'grainRestrictionSelect', 'allowRotation', 'enableInHole', 'minHoleSize', 'minRemnantSize',
  'engineSelect', 'qualityModeSelect', 'timeLimitInput', 'iterationsInput', 'optimizationGoal', 'cutSpeedInput', 'pierceTimeInput', 'rapidSpeedInput'
].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', () => { if (currentUploadId) { updateHints(); scheduleOptimization(500); } });
});

function updateHints() {
  const w = Number(sheetWidthInput.value), h = Number(sheetHeightInput.value);
  document.getElementById('sheetHint').textContent = customSheetDxf
    ? `desenhada, ${Math.round(customSheetDxf.width)} × ${Math.round(customSheetDxf.height)}`
    : `${w} × ${h} mm`;
  document.getElementById('cutHint').textContent = `kerf ${kerfWidthInput.value}, ponte ${partClearanceInput.value}`;
  const mode = { RASCUNHO: 'rascunho', PADRAO: 'padrão', PRODUCAO: 'produção', MANUAL: 'manual' }[qualityModeSelect.value];
  const eng = { AUTO: 'automático', SPARROW: 'sparrow', CLASSICO: 'clássico' }[engineSelect.value];
  document.getElementById('searchHint').textContent = `${eng}, ${mode}${document.getElementById('reproducibleInput').checked ? ', reproduzível' : ''}`;
}

let currentFileName = '';
function updateJobLine() {
  const el = document.getElementById('jobLine');
  if (!currentFileName) { el.textContent = 'Nenhum desenho carregado'; return; }
  const total = catalogParts.reduce((acc, p) => acc + (partQuantities[p.id] || 0), 0);
  el.innerHTML = `<strong>${esc(currentFileName)}</strong>, ${catalogParts.length} ${catalogParts.length === 1 ? 'peça diferente' : 'peças diferentes'}, ${total} no lote`;
}

// =========================================================
// 2. INGESTÃO .DXF DE PEÇAS E CHAPAS IRREGULARES
// =========================================================

/** Opções de importação escolhidas na tela (enviadas no upload, na reanálise e em cada job). */
function currentImportOptions() {
  return {
    units: dxfUnitsSelect.value,
    frameMode: dxfFrameModeSelect.value,
    joinTol: Number(dxfJoinTolInput.value) || 0.25,
    maxGapHeal: Math.max(0, Number(dxfMaxGapInput.value) || 0),
    groupIdentical: dxfGroupIdentical.checked,
    includeDashed: dxfIncludeDashed.checked,
    includeHiddenLayers: dxfIncludeHidden.checked,
    excludeLayers: [...excludedLayers],
    onlyFrames,
    sheetContour
  };
}

/** Envia o DXF das peças; o servidor guarda o arquivo lido (uploadId) e devolve catálogo + diagnóstico. */
async function uploadPartsFile(file) {
  cancelActiveRun('Lendo o arquivo novo…');
  excludedLayers = new Set();
  onlyFrames = null;
  if (sheetContour) { sheetContour = null; if (customSheetDxf && customSheetDxf.fromDrawing) clearCustomSheet(false); }
  currentFileName = file.name;
  const fd = new FormData();
  fd.append('dxfFile', file);
  fd.append('importOptions', JSON.stringify(currentImportOptions()));
  const res = await fetch(`/api/upload-dxf?tol=${encodeURIComponent(chordalToleranceInput.value || 0.03)}`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    renderDxfError(file.name, data.error || `Falha no upload (HTTP ${res.status})`);
    throw new Error(data.error || `Falha no upload (HTTP ${res.status})`);
  }
  currentUploadId = data.uploadId || null;
  applyCatalogResponse(data, true);
}

/** Reanalisa o mesmo upload com outras opções (layers, unidade, moldura, costura) sem reenviar o arquivo. */
let reanalyzeTimer = null;
function scheduleReanalyze() {
  clearTimeout(reanalyzeTimer);
  reanalyzeTimer = setTimeout(reanalyzeDxf, 350);
}
async function reanalyzeDxf() {
  if (!currentUploadId) return;
  dxfReportStatus.textContent = 'reanalisando…';
  dxfReportStatus.className = 'dxf-status warn';
  try {
    const res = await fetch('/api/reanalyze-dxf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: currentUploadId, importOptions: currentImportOptions(), tol: Number(chordalToleranceInput.value) || 0.03 })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    applyCatalogResponse(data, false);
    startBackendSseOptimization();
  } catch (err) {
    renderDxfError('', err.message);
  }
}

function applyCatalogResponse(data, isNewFile) {
  catalogParts = data.catalogParts || [];
  // chapa escolhida no próprio desenho (contorno com recortes): vira a chapa do trabalho
  if (data.drawnSheet) {
    customSheetDxf = data.drawnSheet;
    sheetWidthInput.value = Math.round(customSheetDxf.width);
    sheetHeightInput.value = Math.round(customSheetDxf.height);
    sheetFileNameLabel.textContent = `Chapa do próprio desenho (${(customSheetDxf.obstacles || []).length} recortes)`;
    btnClearCustomSheet.classList.remove('hidden');
    setDrawnSheetStock(true);
  } else if (customSheetDxf && customSheetDxf.fromDrawing) {
    clearCustomSheet(false);
  }
  lastDxfReport = data.report || null;
  initDefaultQuantities(catalogParts);
  renderSeparatedParts(catalogParts);
  renderDxfReport(data, isNewFile);
  renderSheetCandidates(data);
  updateHints();
  updateJobLine();
  const big = catalogParts.reduce((m, p) => Math.max(m, Math.min(p.width, p.height)), 0);
  const sheetMin = Math.min(Number(sheetWidthInput.value) || 0, Number(sheetHeightInput.value) || 0);
  if (!customSheetDxf && big > sheetMin && sheetMin > 0) {
    const li = document.createElement('li');
    li.className = 'sev-alto';
    li.innerHTML = `<span class="sev">Alerta.</span> A peça maior tem ${big.toFixed(0)} mm no lado menor e a chapa ` +
      `(${esc(sheetWidthInput.value)} × ${esc(sheetHeightInput.value)} mm) não comporta: ajuste a chapa.`;
    dxfReportItems.prepend(li);
  }
}

const SEVERITY_LABEL = { erro: 'Erro.', alto: 'Alerta.', medio: 'Aviso.', baixo: 'Nota.', info: '' };

function renderDxfError(fileName, message) {
  dxfReportBox.classList.remove('hidden');
  dxfReportStatus.textContent = 'não lido';
  dxfReportStatus.className = 'dxf-status err';
  dxfReportFile.textContent = fileName || '';
  dxfFrameBanner.classList.add('hidden');
  dxfReportItems.innerHTML = `<li class="sev-erro"><span class="sev">Erro.</span> ${esc(message)}</li>`;
  dxfLayerList.innerHTML = '';
}

function renderDxfReport(data, isNewFile) {
  const r = data.report;
  if (!r) { dxfReportBox.classList.add('hidden'); return; }
  dxfReportBox.classList.remove('hidden');
  const worst = r.items.reduce((w, i) => Math.min(w, ['erro', 'alto', 'medio', 'baixo', 'info'].indexOf(i.severity)), 9);
  dxfReportStatus.textContent = worst === 0 ? 'com erro' : worst === 1 ? 'conferir' : 'lido';
  dxfReportStatus.className = `dxf-status ${worst === 0 ? 'err' : worst === 1 ? 'warn' : 'ok'}`;

  const sm = r.summary || {};
  const ents = Object.entries(sm.entities || {}).map(([k, v]) => `${v} ${k}`).join(', ');
  dxfReportFile.innerHTML = `${(data.fileName || currentFileName) ? `<span class="report-name">${esc(data.fileName || currentFileName)}</span>` : ''}<strong>${sm.closedContours || 0}</strong> contornos fechados viraram <strong>${sm.catalogParts ?? catalogParts.length}</strong> ` +
    `${(sm.catalogParts ?? catalogParts.length) === 1 ? 'peça' : 'peças diferentes'} (${sm.partInstances ?? catalogParts.length} no desenho).<br>` +
    `<span title="${esc(ents)}">DXF ${esc(r.file.version)}, em ${esc(r.file.units)}${sm.inserts ? `, ${sm.inserts} blocos inseridos` : ''}.</span>`;

  // Moldura(s) detectada(s): chapa sugerida + filtro por moldura
  const frames = data.frames || r.frames || [];
  if (frames.length) {
    const f = frames[0];
    if (isNewFile && !customSheetDxf && data.suggestedSheet) {
      sheetBeforeFrame = { w: sheetWidthInput.value, h: sheetHeightInput.value };
      sheetWidthInput.value = Math.round(data.suggestedSheet.width);
      sheetHeightInput.value = Math.round(data.suggestedSheet.height);
      resetZoom();
    }
    const label = (fr) => fr.labels && fr.labels.length ? ` — "${esc(fr.labels.join(' / ').replace(/\n/g, ' '))}"` : '';
    let html = `Moldura ${Math.round(f.width)} × ${Math.round(f.height)} mm encontrada${label(f)}: é o contorno da chapa, não uma peça.`;
    if (sheetBeforeFrame) html += ` Chapa ajustada para ${Math.round(f.width)} × ${Math.round(f.height)} mm.`;
    html += '<br>';
    if (sheetBeforeFrame) html += `<button type="button" class="btn btn-small btn-quiet" data-frame-act="undo">Voltar para ${esc(sheetBeforeFrame.w)} × ${esc(sheetBeforeFrame.h)}</button>`;
    else html += `<button type="button" class="btn btn-small btn-quiet" data-frame-act="use">Usar moldura como chapa</button>`;
    html += `<button type="button" class="btn btn-small btn-quiet" data-frame-act="part">Tratar como peça</button>`;
    if (frames.length > 1) {
      html += `<div style="margin-top:6px;">O arquivo tem ${frames.length} molduras. Usar as peças de:</div>`;
      html += `<label class="check"><input type="radio" name="frameFilter" value="" ${!onlyFrames ? 'checked' : ''}/> todas</label>`;
      frames.forEach(fr => {
        html += `<label class="check"><input type="radio" name="frameFilter" value="${esc(fr.id)}" ${onlyFrames && onlyFrames[0] === fr.id ? 'checked' : ''}/> ` +
          `${Math.round(fr.width)} × ${Math.round(fr.height)} (${fr.partContours} contornos)${label(fr)}</label>`;
      });
    }
    dxfFrameBanner.innerHTML = html;
    dxfFrameBanner.classList.remove('hidden');
  } else {
    dxfFrameBanner.classList.add('hidden');
    dxfFrameBanner.innerHTML = '';
  }

  dxfReportItems.innerHTML = r.items.filter(i => i.code !== 'FRAME').map(i => {
    const where = Array.isArray(i.where) && i.where.length
      ? `<span class="where">em: ${i.where.slice(0, 6).map(w => `(${w.x}, ${w.y})${w.gap !== undefined ? ` abertura ${w.gap} mm` : ''}${w.length !== undefined ? ` ${w.length} mm` : ''}`).join(' · ')}${i.where.length > 6 ? ' …' : ''}</span>` : '';
    const lab = SEVERITY_LABEL[i.severity];
    return `<li class="sev-${esc(i.severity)}">${lab ? `<span class="sev">${lab}</span> ` : ''}${esc(i.message)}${where}</li>`;
  }).join('') || '<li class="sev-info">Nenhum problema encontrado.</li>';

  // Layers: marcar/desmarcar entra na reanálise
  dxfLayerList.innerHTML = (r.layers || []).length ? '<strong>Camadas</strong>' + r.layers.map(L => {
    const auto = L.excludedBecause.filter(x => x !== 'excluída pelo usuário');
    const checked = !excludedLayers.has(L.name) && (L.included > 0 || !auto.length);
    return `<label class="check"><input type="checkbox" data-layer="${esc(L.name)}" ${checked ? 'checked' : ''} ${auto.length && !L.included ? 'disabled' : ''}/>` +
      `<span>${esc(L.name)} <small>${L.included} de ${L.paths} entidades${auto.length ? ', ' + esc(auto.join(', ')) : ''}</small></span></label>`;
  }).join('') : '';
}

/** "Chapa já usada" desenhada junto com as peças: oferece usá-la como chapa (ou voltar a tratá-la como peça). */
function renderSheetCandidates(data) {
  const box = document.getElementById('sheetCandidateBanner');
  const cands = (data.sheetCandidates || (data.report && data.report.sheetCandidates) || []);
  if (!cands.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  const c = cands.find(x => x.chosen) || cands[0];
  box.innerHTML = c.chosen
    ? `O contorno de ${Math.round(c.width)} × ${Math.round(c.height)} mm com ${c.cutouts} recortes está sendo usado como chapa; as outras peças são encaixadas nele.<br>` +
      `<button type="button" class="btn btn-small btn-quiet" data-sheet-act="undo">Tratar como peça</button>`
    : `O contorno de ${Math.round(c.width)} × ${Math.round(c.height)} mm com ${c.cutouts} recortes parece uma chapa já usada.<br>` +
      `<button type="button" class="btn btn-small btn-primary" data-sheet-act="use" data-id="${esc(c.id)}">Usar como chapa</button>`;
  box.classList.remove('hidden');
}
document.getElementById('sheetCandidateBanner').addEventListener('click', (e) => {
  const act = e.target && e.target.dataset ? e.target.dataset.sheetAct : null;
  if (!act) return;
  sheetContour = act === 'use' ? e.target.dataset.id : null;
  resetZoom();
  reanalyzeDxf();
});

dxfFrameBanner.addEventListener('click', (e) => {
  const act = e.target && e.target.dataset ? e.target.dataset.frameAct : null;
  if (!act) return;
  const frames = (lastDxfReport && lastDxfReport.frames) || [];
  if (act === 'undo' && sheetBeforeFrame) {
    sheetWidthInput.value = sheetBeforeFrame.w; sheetHeightInput.value = sheetBeforeFrame.h; sheetBeforeFrame = null;
  } else if (act === 'use' && frames[0]) {
    sheetBeforeFrame = { w: sheetWidthInput.value, h: sheetHeightInput.value };
    sheetWidthInput.value = Math.round(frames[0].width); sheetHeightInput.value = Math.round(frames[0].height);
  } else if (act === 'part') {
    dxfFrameModeSelect.value = 'part';
    if (sheetBeforeFrame) { sheetWidthInput.value = sheetBeforeFrame.w; sheetHeightInput.value = sheetBeforeFrame.h; sheetBeforeFrame = null; }
    reanalyzeDxf();
    return;
  }
  resetZoom();
  if (lastDxfReport) renderDxfReport({ report: lastDxfReport, frames, fileName: currentFileName }, false);
  startBackendSseOptimization();
});
dxfFrameBanner.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'frameFilter') {
    onlyFrames = e.target.value ? [e.target.value] : null;
    scheduleReanalyze();
  }
});
dxfLayerList.addEventListener('change', (e) => {
  const name = e.target && e.target.dataset ? e.target.dataset.layer : null;
  if (name === undefined || name === null) return;
  if (e.target.checked) excludedLayers.delete(name); else excludedLayers.add(name);
  scheduleReanalyze();
});
[dxfUnitsSelect, dxfFrameModeSelect, dxfJoinTolInput, dxfMaxGapInput, dxfGroupIdentical, dxfIncludeDashed, dxfIncludeHidden]
  .forEach(el => el.addEventListener('change', scheduleReanalyze));

const dropzone = document.getElementById('dropzone');
['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, () => dropzone.classList.remove('over')));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files[0];
  if (file) openPartsFile(file);
});

async function openPartsFile(file) {
  fileNameLabel.textContent = file.name;
  try {
    await uploadPartsFile(file);
    resetZoom();
    startBackendSseOptimization();
  } catch (err) {
    showCamMessage(`Não foi possível ler o DXF das peças: ${err.message}`);
  }
}

dxfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  fileNameLabel.textContent = file.name;
  try {
    await uploadPartsFile(file);
    resetZoom();
    startBackendSseOptimization();
  } catch (err) {
    showCamMessage(`Erro ao ler o DXF das peças: ${err.message}`);
  }
});

sheetDxfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('sheetDxfFile', file);
  const res = await fetch('/api/upload-sheet-dxf', { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showCamMessage(`Erro ao ler o DXF da chapa: ${data.error || `HTTP ${res.status}`}`); return; }
  if (data.sheet) {
    customSheetDxf = data.sheet;
    const obsCount = (customSheetDxf.obstacles || []).length;
    sheetFileNameLabel.textContent = `${file.name}${obsCount ? ` (${obsCount} ${obsCount === 1 ? 'recorte' : 'recortes'})` : ''}`;
    updateHints();
    sheetWidthInput.value = Math.round(customSheetDxf.width);
    sheetHeightInput.value = Math.round(customSheetDxf.height);
    btnClearCustomSheet.classList.remove('hidden');
    setDrawnSheetStock(true);
    resetZoom();
    startBackendSseOptimization();
  }
});

// Estoque (V5.8): com chapa desenhada, chapas inteiras começam em 0 (a desenhada é a sobra que se quer gastar);
// sem ela, 1 (a chapa da tela). A pessoa pode mudar o número depois.
function setDrawnSheetStock(active) {
  const input = document.getElementById('fullSheetsInput');
  const label = document.getElementById('fullSheetsLabel');
  if (!input) return;
  input.value = active ? 0 : Math.max(1, Number(input.value) || 0);
  label.textContent = active ? 'Chapas inteiras depois da desenhada (medidas acima)' : 'Chapas inteiras com estas medidas';
}

function clearCustomSheet(rerun = true) {
  customSheetDxf = null;
  setDrawnSheetStock(false);
  sheetPresetSelect.value = 'rect';
  sheetFileNameLabel.textContent = 'Usar uma chapa desenhada (DXF)';
  btnClearCustomSheet.classList.add('hidden');
  updateHints();
  if (rerun) { resetZoom(); startBackendSseOptimization(); }
}
btnClearCustomSheet.addEventListener('click', () => {
  if (sheetContour) { sheetContour = null; clearCustomSheet(false); reanalyzeDxf(); return; }
  clearCustomSheet(true);
});

sheetPresetSelect.addEventListener('change', async () => {
  const val = sheetPresetSelect.value;
  if (val === 'rect') {
    btnClearCustomSheet.click();
    return;
  }

  const dxfRes = await fetch(`/api/sample-dxf?preset=${encodeURIComponent(val)}`);
  const blob = await dxfRes.blob();
  const file = new File([blob], `${val}.dxf`);
  const fd = new FormData();
  fd.append('sheetDxfFile', file);
  const res = await fetch('/api/upload-sheet-dxf', { method: 'POST', body: fd });
  const data = await res.json();
  if (data.sheet) {
    customSheetDxf = data.sheet;
    const obsCount = (customSheetDxf.obstacles || []).length;
    sheetFileNameLabel.textContent = `Exemplo: ${sheetPresetSelect.options[sheetPresetSelect.selectedIndex].text}${obsCount ? ` (${obsCount} ${obsCount === 1 ? 'recorte' : 'recortes'})` : ''}`;
    updateHints();
    sheetWidthInput.value = Math.round(customSheetDxf.width);
    sheetHeightInput.value = Math.round(customSheetDxf.height);
    btnClearCustomSheet.classList.remove('hidden');
    setDrawnSheetStock(true);
    resetZoom();
    startBackendSseOptimization();
  }
});

async function loadSelectedPreset() {
  const preset = presetSelect.value;
  if (preset === 'icamento' && !customSheetDxf) {
    sheetWidthInput.value = 180;
    sheetHeightInput.value = 120;
    minHoleSizeInput.value = 10;
    minRemnantSizeInput.value = 35;
  } else if (!customSheetDxf) {
    sheetWidthInput.value = 1200;
    sheetHeightInput.value = 800;
    minHoleSizeInput.value = 60;
    minRemnantSizeInput.value = 100;
  }

  const dxfRes = await fetch(`/api/sample-dxf?preset=${encodeURIComponent(preset)}`);
  const blob = await dxfRes.blob();
  const file = new File([blob], `exemplo_${preset}.dxf`);
  fileNameLabel.textContent = file.name;
  try {
    await uploadPartsFile(file);
    resetZoom();
    startBackendSseOptimization();
  } catch (err) {
    showCamMessage(`Erro ao carregar o preset: ${err.message}`);
  }
}

btnLoadSample.addEventListener('click', loadSelectedPreset);
presetSelect.addEventListener('change', loadSelectedPreset);
const seedInput = document.getElementById('seedInput');
const reproducibleInput = document.getElementById('reproducibleInput');
seedInput.addEventListener('change', () => {
  seedCounter = Math.max(1, Math.floor(Number(seedInput.value) || 1));
  seedInput.value = seedCounter;
  if (currentUploadId) scheduleOptimization(500);
});
reproducibleInput.addEventListener('change', () => { if (currentUploadId) { updateHints(); scheduleOptimization(500); } });
btnRecalculate.addEventListener('click', () => {
  seedCounter++;
  seedInput.value = seedCounter;
  startBackendSseOptimization();
});

[showRemnantsInput, showCamToolpathInput].forEach(el => {
  el.addEventListener('change', () => {
    if (bestSolutionGlobal) drawSheetNesting(bestSolutionGlobal);
  });
});

// =========================================================
// 3. ORQUESTRAÇÃO SSE COM MOTOR BACKEND V5 (PARÂMETROS MANDATÓRIOS)
// =========================================================

function resetRunUi() {
  // Tudo que pertence à execução ANTERIOR é descartado: elites, melhor solução e avisos
  currentArchive = [];
  candidatesList.innerHTML = '';
  candidatesBar.classList.add('hidden');
  bestSolutionGlobal = null;
  multiResult = null;
  sheetRunPrefix = '';
  document.getElementById('sheetTabs').classList.add('hidden');
  document.getElementById('multiSummary').classList.add('hidden');
  document.getElementById('btnExportAllDxf').classList.add('hidden');
  document.getElementById('resultTitle').textContent = 'Resultado';
  showCamMessage('');
  document.getElementById('unplacedAlert').classList.add('hidden');
  const { W: cw, H: ch } = fitCanvas();
  ctx.fillStyle = '#0F2E1F';
  ctx.fillRect(0, 0, cw, ch);
}

function showCamMessage(text) {
  const box = document.getElementById('camWarnings');
  if (!box) return;
  box.textContent = text || '';
  box.classList.toggle('hidden', !text);
}

async function startBackendSseOptimization() {
  if (!currentUploadId) return;
  const myRun = ++runToken;
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  resetRunUi();

  btnRecalculate.disabled = true;
  btnExportDxf.disabled = true;
  progressPanel.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressPercentText.textContent = '0%';
  progressStatusText.textContent = 'Preparando o cálculo…';
  progressStrategyText.textContent = '';
  progressBestText.textContent = '';

  const config = {
    sheet_width: Number(sheetWidthInput.value),
    sheet_height: Number(sheetHeightInput.value),
    kerf_width: Number(kerfWidthInput.value),
    part_clearance: Number(partClearanceInput.value),
    sheet_margin: Number(sheetMarginInput.value),
    lead_in_length: Number(leadInLengthInput.value),
    lead_in_type: leadInTypeSelect.value,
    pierce_radius: Number(pierceRadiusInput.value),
    hole_clearance: Number(holeClearanceInput.value),
    chordal_tolerance: Number(chordalToleranceInput.value),
    min_hole_size: Number(minHoleSizeInput.value),
    min_remnant_size: Number(minRemnantSizeInput.value),
    total_iterations: (QUALITY_MODES[qualityModeSelect.value] || {}).iterations || Number(iterationsInput.value) || 15000,
    evaluation_mode: (QUALITY_MODES[qualityModeSelect.value] || {}).evaluation_mode || 'PRECISE',
    time_limit_s: Number(timeLimitInput.value) || 0,
    engine: engineSelect.value,
    external_time_s: (QUALITY_MODES[qualityModeSelect.value] || {}).external_time_s || 30,
    reproducible: reproducibleInput.checked,
    cut_speed_mm_min: Number(document.getElementById('cutSpeedInput').value) || 3000,
    pierce_time_s: Number(document.getElementById('pierceTimeInput').value) || 0,
    rapid_speed_mm_min: Number(document.getElementById('rapidSpeedInput').value) || 20000,
    stock_full_sheets: Math.max(0, Math.floor(Number(document.getElementById('fullSheetsInput').value) || 0)),
    stock_remnants: readRemnants(),
    external_budget: (QUALITY_MODES[qualityModeSelect.value] || QUALITY_MODES.PADRAO).external_budget,
    allow_rotation: allowRotationInput.checked,
    grain_restriction: grainRestrictionSelect.value,
    hole_filling: enableInHoleInput.checked,
    common_line_cutting: commonLineInput.checked,
    optimization_goal: optimizationGoalSelect.value,
    seed_offset: seedCounter
  };

  let init;
  try {
    const initRes = await fetch('/api/start-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: currentUploadId, sheet: customSheetDxf, config, quantities: partQuantities, importOptions: currentImportOptions() })
    });
    init = await initRes.json().catch(() => ({}));
    if (!initRes.ok) throw new Error(init.error || `HTTP ${initRes.status}`);
  } catch (err) {
    if (myRun === runToken) {
      progressStatusText.textContent = `Erro ao iniciar: ${err.message}`;
      btnRecalculate.disabled = false;
    }
    return;
  }
  if (myRun !== runToken) return; // uma execução mais nova assumiu enquanto esperávamos o servidor

  const { jobId, catalogParts: updatedCatalog, expandedCount } = init;
  if (updatedCatalog) {
    catalogParts = updatedCatalog;
    renderSeparatedParts(catalogParts);
  }
  currentJobId = jobId;
  btnStopKeepBest.disabled = false;
  btnStopKeepBest.textContent = 'Parar e manter o melhor';
  btnStopKeepBest.classList.remove('hidden');

  const es = new EventSource(`/api/stream/${jobId}`);
  activeEventSource = es;

  es.onmessage = (event) => {
    if (myRun !== runToken) { es.close(); return; } // descarta mensagens de execuções antigas
    const msg = JSON.parse(event.data);

    if (msg.type === 'queued') {
      progressStatusText.textContent = `Na fila do servidor, posição ${msg.position} (${msg.activeWorkers} de ${msg.maxWorkers} cálculos rodando)…`;
      return;
    }

    if (msg.type === 'error') {
      es.close();
      activeEventSource = null;
      btnStopKeepBest.classList.add('hidden');
      btnRecalculate.disabled = false;
      progressStatusText.textContent = `O cálculo falhou: ${msg.error || 'erro sem mensagem'}`;
      return;
    }

    if (msg.type === 'sheet-start') {
      sheetRunPrefix = `Chapa ${msg.sheetIndex + 1} de ${msg.sheetCount} (${msg.sheetLabel}, ${msg.partsLeft} ${msg.partsLeft === 1 ? 'peça restante' : 'peças restantes'}): `;
      progressStatusText.textContent = sheetRunPrefix + 'começando…';
      return;
    }

    if (msg.type === 'progress') {
      const pct = Math.round((msg.fraction ?? (msg.iter / msg.totalIterations)) * 100);
      progressBarFill.style.width = `${pct}%`;
      progressPercentText.textContent = `${pct}%`;
      if (msg.engine === 'SPARROW') {
        progressStatusText.textContent = `${sheetRunPrefix}Otimizador sparrow procurando, ${msg.improvements.toLocaleString('pt-BR')} ${msg.improvements === 1 ? 'plano melhor' : 'planos melhores'} até agora`;
        progressStrategyText.textContent = 'Separa as peças sobrepostas e aperta o plano contra o início da chapa';
      } else {
        progressStatusText.textContent = `${sheetRunPrefix}Motor clássico, ${msg.iter.toLocaleString('pt-BR')} de ${msg.totalIterations.toLocaleString('pt-BR')} arranjos testados`;
        progressStrategyText.textContent = `${msg.calcPerSec.toLocaleString('pt-BR')} arranjos por segundo`;
      }

      if (msg.bestResult) {
        bestSolutionGlobal = msg.bestResult;
        progressBestText.textContent = `melhor até agora: ${fmtPct(bestSolutionGlobal.compactUtilization)}`;
        drawSheetNesting(bestSolutionGlobal, true);
        updateMetrics(expandedCount, bestSolutionGlobal);
      }
    }

    if (msg.type === 'done') {
      es.close();
      activeEventSource = null;
      btnStopKeepBest.classList.add('hidden');
      btnRecalculate.disabled = false;
      refreshHardwareStatus();

      bestSolutionGlobal = msg.bestResult;
      currentArchive = msg.topArchive || [];
      sheetRunPrefix = '';
      if (msg.multi) { finishMulti(msg, expandedCount); return; }
      progressBarFill.style.width = '100%';
      progressPercentText.textContent = '100%';
      const secs = (msg.totalTimeMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
      const how = msg.stoppedByUser ? 'parado pelo usuário, melhor plano mantido' : msg.stoppedByTimeLimit ? 'tempo de busca encerrado' : 'busca concluída';
      if (msg.engine === 'SPARROW') {
        const se = msg.search || {};
        const how2 = se.reproducible ? 'orçamento de passos concluído, plano reproduzível' : se.budget && !msg.stoppedByUser ? 'teto de tempo atingido antes dos passos: este plano pode não se repetir' : how;
        progressStatusText.textContent = `Pronto em ${secs} s com o otimizador sparrow (${how2})`;
        const buscas = se.searches > 1 ? `${se.searches} buscas em paralelo, ${se.workersPerSearch} thread${se.workersPerSearch > 1 ? 's' : ''} cada; ` : '';
        progressStrategyText.textContent = `${buscas}semente ${seedCounter}; plano conferido pelo validador independente`;
      } else {
        progressStatusText.textContent = `Pronto em ${secs} s com o motor clássico (${how})`;
        progressStrategyText.textContent = msg.engineNote ? `Motor clássico porque ${msg.engineNote}` : `${msg.totalIterations.toLocaleString('pt-BR')} arranjos testados`;
      }
      if (!bestSolutionGlobal) { progressBestText.textContent = 'Nenhum plano gerado.'; return; }
      progressBestText.textContent = '';

      drawSheetNesting(bestSolutionGlobal, false);
      updateMetrics(expandedCount, bestSolutionGlobal);
      renderArchiveButtons(currentArchive, bestSolutionGlobal, expandedCount);
      btnExportDxf.disabled = false;
    }
  };

  es.onerror = () => {
    if (myRun !== runToken) return;
    es.close();
    activeEventSource = null;
    btnStopKeepBest.classList.add('hidden');
    btnRecalculate.disabled = false;
  };
}

btnStopKeepBest.addEventListener('click', async () => {
  if (!currentJobId) return;
  btnStopKeepBest.disabled = true;
  btnStopKeepBest.textContent = 'Parando…';
  try {
    await fetch(`/api/stop/${encodeURIComponent(currentJobId)}`, { method: 'POST' });
  } catch (_) { /* o stream informa o fim */ }
});

// =========================================================
// 4. VIEWPORT CAD/CAM: RENDERIZAÇÃO DE PEÇAS, LEAD-IN E TRAJETÓRIA INSIDE-OUT
// =========================================================

function resetZoom() {
  viewZoom = 1;
  viewPanX = 0;
  viewPanY = 0;
  if (bestSolutionGlobal) drawSheetNesting(bestSolutionGlobal);
}

document.getElementById('btnZoomIn').onclick = () => {
  viewZoom = Math.min(6, viewZoom * 1.25);
  if (bestSolutionGlobal) drawSheetNesting(bestSolutionGlobal);
};
document.getElementById('btnZoomOut').onclick = () => {
  viewZoom = Math.max(0.5, viewZoom / 1.25);
  if (bestSolutionGlobal) drawSheetNesting(bestSolutionGlobal);
};
document.getElementById('btnZoomReset').onclick = resetZoom;

nestingCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 0.87;
  viewZoom = Math.max(0.5, Math.min(8, viewZoom * factor));
  if (bestSolutionGlobal) drawSheetNesting(bestSolutionGlobal);
});

nestingCanvas.addEventListener('mousedown', (e) => {
  isPanning = true;
  panStartX = e.clientX - viewPanX;
  panStartY = e.clientY - viewPanY;
});

window.addEventListener('mouseup', () => { isPanning = false; });

function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

nestingCanvas.addEventListener('mousemove', (e) => {
  if (isPanning) {
    viewPanX = e.clientX - panStartX;
    viewPanY = e.clientY - panStartY;
    if (bestSolutionGlobal) drawSheetNesting(bestSolutionGlobal);
    return;
  }

  if (!bestSolutionGlobal) return;
  const rect = nestingCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  // Eixo Y do viewport = eixo Y do CAD (para cima)
  const { startX, startY, scale, H } = lastRenderTransform;
  const sheetX = (mx - startX) / scale;
  const sheetY = H - (my - startY) / scale;

  // Hit-test por POLÍGONO real (filhas In-Hole primeiro, pois estão sobre o furo da mãe)
  const inPart = (p) => pointInPoly(sheetX - p.x, sheetY - p.y, p.placedPoints);
  const parts = bestSolutionGlobal.placedParts;
  const hitPart = parts.filter(p => p.nestedInsideHole).find(inPart) || parts.find(inPart);
  if (hitPart) {
    const seq = hitPart.cutSequenceOrder ? `, cortada em ${hitPart.cutSequenceOrder}º` : '';
    hoverInspector.textContent = `${hitPart.name}: ${Math.round(hitPart.placedWidth)} × ${Math.round(hitPart.placedHeight)} mm, girada ${hitPart.angle || 0}°${seq}${hitPart.nestedInsideHole ? ', dentro do furo de outra peça' : ''}`;
    return;
  }

  const hitRem = (bestSolutionGlobal.remnants || []).find(
    r => sheetX >= r.x && sheetX <= r.x + r.width && sheetY >= r.y && sheetY <= r.y + r.height
  );
  if (hitRem) {
    hoverInspector.textContent = `Retalho ${Math.round(hitRem.width)} × ${Math.round(hitRem.height)} mm (${fmtArea(hitRem.area)}), canto em X ${Math.round(hitRem.x)}, Y ${Math.round(hitRem.y)}`;
    return;
  }

  hoverInspector.textContent = `X ${Math.round(sheetX)} mm, Y ${Math.round(sheetY)} mm`;
});

// Canvas em alta densidade: desenha em coordenadas lógicas (px CSS) e escala pelo devicePixelRatio
const DPR = Math.min(2, window.devicePixelRatio || 1);
function fitCanvas() {
  const w = Math.max(320, nestingCanvas.clientWidth || 960);
  const h = Math.round(w * 0.6);
  if (nestingCanvas.width !== Math.round(w * DPR) || nestingCanvas.height !== Math.round(h * DPR)) {
    nestingCanvas.width = Math.round(w * DPR);
    nestingCanvas.height = Math.round(h * DPR);
  }
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  return { W: w, H: h };
}
window.addEventListener('resize', () => { if (bestSolutionGlobal) drawSheetNesting(bestSolutionGlobal); });

// Cores da mesa (iguais às do style.css)
const C = {
  mesa: '#0F2E1F', chapa: '#163D2A', grade: 'rgba(221, 232, 213, 0.07)', gradeForte: 'rgba(221, 232, 213, 0.14)',
  regua: 'rgba(221, 232, 213, 0.55)', limite: '#F97316', peca: '#38BDF8', filha: '#34D399', furo: '#FDE047',
  // furo sem aproveitamento: cinza hachurado (antes vermelho-claro, que se confundia com a entrada de corte vermelha)
  sucata: '#7C8A99', sucataRisco: '#C9D3DD', furoOcupado: 'rgba(253, 224, 71, 0.30)', retalhoFundo: 'rgba(167, 139, 250, 0.20)', retalho: '#C4B5FD', lead: '#EF4444', leadRuim: '#F59E0B',
  g00: 'rgba(253, 224, 71, 0.55)', g00Ruim: 'rgba(249, 115, 22, 0.95)', texto: '#0F2E1F', textoClaro: '#E8F0E2'
};
const niceStep = (mmPerPx) => {
  const target = mmPerPx * 70; // ~70 px entre marcas principais
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  return [1, 2, 5, 10].map(k => k * p).find(v => v >= target) || 10 * p;
};

// hachura do furo sem aproveitamento (cinza com riscos diagonais): lê como "sobra que cai", sem parecer entrada de corte
let _scrapPattern = null;
function scrapPattern() {
  if (_scrapPattern) return _scrapPattern;
  const t = document.createElement('canvas');
  const k = Math.max(1, Math.round(window.devicePixelRatio || 1));
  t.width = t.height = 8 * k;
  const g = t.getContext('2d');
  g.fillStyle = C.sucata; g.fillRect(0, 0, t.width, t.height);
  g.strokeStyle = C.sucataRisco; g.lineWidth = 1.2 * k;
  g.beginPath(); g.moveTo(0, t.height); g.lineTo(t.width, 0); g.moveTo(-t.width / 2, t.height / 2); g.lineTo(t.width / 2, -t.height / 2);
  g.moveTo(t.width / 2, t.height * 1.5); g.lineTo(t.width * 1.5, t.height / 2); g.stroke();
  const p = ctx.createPattern(t, 'repeat');
  if (p && p.setTransform && window.DOMMatrix) p.setTransform(new DOMMatrix().scale(1 / k));
  _scrapPattern = p;
  return p;
}

function drawSheetNesting(nesting, isHighlight = false) {
  if (!nesting) return;
  const { W: CW, H: CH } = fitCanvas();
  const padL = 46, padT = 30, padR = 18, padB = 18; // espaço das réguas
  const availW = CW - padL - padR;
  const availH = CH - padT - padB;
  const baseScale = Math.min(availW / nesting.sheetWidth, availH / nesting.sheetHeight);
  const scale = baseScale * viewZoom;
  const H = nesting.sheetHeight;
  const drawW = nesting.sheetWidth * scale;
  const drawH = H * scale;
  const startX = padL + (availW - drawW) / 2 + viewPanX;
  const startY = padT + (availH - drawH) / 2 + viewPanY;
  lastRenderTransform = { startX, startY, scale, H };

  // Mesa CNC -> tela: X para a direita, Y PARA CIMA (igual ao DXF; nada fica espelhado)
  const sx = (x) => startX + x * scale;
  const sy = (y) => startY + (H - y) * scale;
  const ring = (pts, ox = 0, oy = 0) => {
    if (!pts || !pts.length) return;
    ctx.beginPath();
    pts.forEach((pt, idx) => { if (idx === 0) ctx.moveTo(sx(ox + pt.x), sy(oy + pt.y)); else ctx.lineTo(sx(ox + pt.x), sy(oy + pt.y)); });
    ctx.closePath();
  };

  ctx.fillStyle = C.mesa;
  ctx.fillRect(0, 0, CW, CH);

  // chapa + grade em escala real
  ctx.save();
  if (nesting.sheetPoly && nesting.sheetPoly.length) ring(nesting.sheetPoly); else { ctx.beginPath(); ctx.rect(startX, startY, drawW, drawH); }
  ctx.fillStyle = C.chapa;
  ctx.fill();
  ctx.clip();
  const step = niceStep(1 / scale);
  ctx.lineWidth = 1;
  for (let x = 0, k = 0; x <= nesting.sheetWidth; x += step / 5, k++) {
    ctx.strokeStyle = k % 5 === 0 ? C.gradeForte : C.grade;
    ctx.beginPath(); ctx.moveTo(Math.round(sx(x)) + 0.5, startY); ctx.lineTo(Math.round(sx(x)) + 0.5, startY + drawH); ctx.stroke();
  }
  for (let y = 0, k = 0; y <= H; y += step / 5, k++) {
    ctx.strokeStyle = k % 5 === 0 ? C.gradeForte : C.grade;
    ctx.beginPath(); ctx.moveTo(startX, Math.round(sy(y)) + 0.5); ctx.lineTo(startX + drawW, Math.round(sy(y)) + 0.5); ctx.stroke();
  }

  // recortes e defeitos da chapa
  (nesting.sheetObstacles || []).forEach((obs) => {
    ring(obs.points);
    ctx.fillStyle = C.mesa;
    ctx.fill();
    ctx.strokeStyle = C.limite;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  // retalhos: etiqueta de estoque (número e medidas)
  if (showRemnantsInput.checked && nesting.remnants) {
    nesting.remnants.forEach((rem, k) => {
      const rx = sx(rem.x), ry = sy(rem.y + rem.height), rw = rem.width * scale, rh = rem.height * scale;
      ctx.fillStyle = C.retalhoFundo;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = C.retalho;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      ctx.setLineDash([]);
      // etiqueta no centro do retalho, só se couber inteira nele
      const tag = `R${k + 1}  ${Math.round(rem.width)} × ${Math.round(rem.height)}`;
      ctx.font = '600 11px ' + getComputedStyle(document.body).fontFamily;
      const tw = ctx.measureText(tag).width + 12;
      if (rw > tw + 8 && rh > 26) {
        const tx = rx + (rw - tw) / 2, ty = ry + (rh - 18) / 2;
        ctx.fillStyle = C.retalho;
        ctx.fillRect(tx, ty, tw, 18);
        ctx.fillStyle = C.texto;
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, tx + 6, ty + 9.5);
        ctx.textBaseline = 'alphabetic';
      }
    });
  }

  // peças (mães primeiro, filhas por cima)
  const font = getComputedStyle(document.body).fontFamily;
  const drawOrder = [...nesting.placedParts].sort((a, b) => (a.nestedInsideHole ? 1 : 0) - (b.nestedInsideHole ? 1 : 0));
  drawOrder.forEach(part => {
    ring(part.placedPoints, part.x, part.y);
    ctx.fillStyle = part.nestedInsideHole ? C.filha : C.peca;
    ctx.fill();
    ctx.strokeStyle = C.mesa;
    ctx.lineWidth = 1;
    ctx.stroke();
    (part.placedHoles || []).forEach(hole => {
      ring(hole.placedPoints, part.x, part.y);
      if (hole.hasChildPartInside) {
        // furo útil que recebeu peça: continua amarelo (contorno forte + fundo claro); a filha verde vem por cima
        ctx.fillStyle = C.chapa; // o furo é vazio: primeiro a cor da mesa, depois o amarelo claro por cima
        ctx.fill();
        ctx.fillStyle = C.furoOcupado;
        ctx.fill();
        ctx.strokeStyle = C.furo; ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = C.mesa; ctx.lineWidth = 1;
      } else if (hole.usableHole) {
        ctx.fillStyle = C.furo;
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = scrapPattern() || C.sucata;
        ctx.fill();
        ctx.stroke();
      }
    });
  });
  // nomes por último (filhas não cobrem o nome da mãe); com fundo para ler sobre furo ou peça
  ctx.font = `600 11px ${font}`;
  drawOrder.forEach(part => {
    const pw = part.placedWidth * scale, ph = part.placedHeight * scale;
    const seqLabel = (showCamToolpathInput.checked && part.cutSequenceOrder) ? `${part.cutSequenceOrder}. ` : '';
    const label = `${seqLabel}${part.name.replace(/ \(\d+\/\d+\)$/, '')}`;
    const tw = ctx.measureText(label).width + 8;
    if (pw < tw + 6 || ph < 22) return;
    const cx = sx(part.x + part.placedWidth / 2), cy = sy(part.y + part.placedHeight / 2);
    ctx.fillStyle = 'rgba(232, 240, 226, 0.88)';
    ctx.fillRect(cx - tw / 2, cy - 8, tw, 16);
    ctx.fillStyle = C.texto;
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, cy + 4);
    ctx.textAlign = 'left';
  });

  // CAM: deslocamentos G00, entradas de corte e perfurações na ordem real
  const cam = nesting.cam;
  if (showCamToolpathInput.checked && cam && cam.ops && cam.ops.length) {
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    (cam.rapids || []).forEach(r => {
      ctx.strokeStyle = r.crossesCut ? C.g00Ruim : C.g00;
      ctx.beginPath(); ctx.moveTo(sx(r.x1), sy(r.y1)); ctx.lineTo(sx(r.x2), sy(r.y2)); ctx.stroke();
    });
    ctx.setLineDash([]);
    cam.ops.forEach(op => {
      const color = op.invalid ? C.leadRuim : C.lead;
      if (op.leadPath && op.leadPath.length > 1) {
        ctx.strokeStyle = color; ctx.lineWidth = 1.6;
        ctx.beginPath();
        op.leadPath.forEach((q, i) => (i === 0 ? ctx.moveTo(sx(q.x), sy(q.y)) : ctx.lineTo(sx(q.x), sy(q.y))));
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(sx(op.pierce.x), sy(op.pierce.y), 2.6, 0, Math.PI * 2); ctx.fill();
    });
  }
  ctx.restore();

  // contorno da chapa
  ctx.strokeStyle = isHighlight ? C.filha : C.limite;
  ctx.lineWidth = 1.5;
  if (nesting.sheetPoly && nesting.sheetPoly.length) { ring(nesting.sheetPoly); ctx.stroke(); }
  else ctx.strokeRect(Math.round(startX) + 0.5, Math.round(startY) + 0.5, Math.round(drawW), Math.round(drawH));

  // réguas em mm (topo e esquerda), na escala da chapa
  ctx.fillStyle = C.mesa;
  ctx.fillRect(0, 0, CW, padT - 6);
  ctx.fillRect(0, 0, padL - 6, CH);
  ctx.strokeStyle = C.regua; ctx.fillStyle = C.regua;
  ctx.lineWidth = 1;
  ctx.font = `10.5px ${font}`;
  ctx.textAlign = 'center';
  for (let x = 0; x <= nesting.sheetWidth + 1e-6; x += step / 5) {
    const X = Math.round(sx(x)) + 0.5;
    if (X < padL - 6 || X > CW) continue;
    const major = Math.abs(x / step - Math.round(x / step)) < 1e-6;
    ctx.beginPath(); ctx.moveTo(X, padT - 7); ctx.lineTo(X, padT - (major ? 15 : 10)); ctx.stroke();
    if (major) ctx.fillText(String(Math.round(x)), X, padT - 18);
  }
  ctx.textAlign = 'right';
  for (let y = 0; y <= H + 1e-6; y += step / 5) {
    const Y = Math.round(sy(y)) + 0.5;
    if (Y < padT - 6 || Y > CH) continue;
    const major = Math.abs(y / step - Math.round(y / step)) < 1e-6;
    ctx.beginPath(); ctx.moveTo(padL - 7, Y); ctx.lineTo(padL - (major ? 15 : 10), Y); ctx.stroke();
    if (major) ctx.fillText(String(Math.round(y)), padL - 18, Y + 3.5);
  }
  ctx.textAlign = 'left';
  ctx.fillText('mm', 8, 14);
}

const fmtPct = (v) => `${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
const fmtArea = (mm2) => `${(mm2 / 1e6).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 })} m²`;
const fmtDuration = (s) => {
  const t = Math.round(s);
  if (t < 60) return `${t} s`;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(r).padStart(2, '0')} s`;
};
const dimTxt = (d) => String(d || '').replace(/(\d+)x(\d+)mm/, '$1 × $2 mm');

function updateMetrics(totalExpandedCount, nesting, opts = {}) {
  document.getElementById('kpiUtilization').textContent = fmtPct(nesting.compactUtilization);
  document.getElementById('kpiRawRatio').textContent = 'conta o que sobra como retalho de estoque como material não usado';
  document.getElementById('metricNetUtil').textContent = fmtPct(nesting.rawUtilization);
  document.getElementById('metricLargestRemnant').textContent = nesting.largestRemnantArea ? dimTxt(nesting.largestRemnantDim) : 'nenhum';
  document.getElementById('metricSheetArea').textContent = fmtArea(nesting.sheetArea);
  document.getElementById('metricUsedArea').textContent = fmtArea(nesting.usedArea);
  const all = nesting.placedParts.length === totalExpandedCount;
  const placedEl = document.getElementById('metricPlacedCount');
  placedEl.textContent = opts.multi ? `${nesting.placedParts.length} nesta chapa` : `${nesting.placedParts.length} de ${totalExpandedCount}`;
  placedEl.className = all || opts.multi ? '' : 'bad';
  document.getElementById('metricNominalGap').textContent = `${nesting.kerf} mm`;
  document.getElementById('metricNominalGap').title = `ponte ${nesting.part_clearance} mm + kerf ${nesting.kerf_width} mm`;
  document.getElementById('metricRemnantArea').textContent = nesting.remnants.length
    ? `${nesting.remnants.length} (${fmtArea(nesting.remnantArea)})` : 'nenhum';
  document.getElementById('metricInHoleParts').textContent = nesting.inHoleCount || 0;
  document.getElementById('metricFreeSlugs').textContent = nesting.freeHoleSlugsCount || 0;

  const obsCount = (nesting.sheetObstacles || []).length;
  document.getElementById('sheetSpecText').textContent =
    `Chapa de ${nesting.sheetWidth} × ${nesting.sheetHeight} mm${nesting.sheetPoly ? `, desenhada${obsCount ? ` com ${obsCount} ${obsCount === 1 ? 'recorte' : 'recortes'}` : ''}` : ''}, ` +
    `margem de ${nesting.sheet_margin ?? 6} mm. Eixo Y para cima, como no CAD.`;

  // Telemetria CAM
  const m = nesting.cam && nesting.cam.metrics;
  document.getElementById('metricPierces').textContent = m ? String(m.pierceCount) : '—';
  document.getElementById('metricPierces').title = m ? `${m.narrowWebPierces || 0} em alma estreita, ${m.invalidLeads} sem espaço para o lead-in` : '';
  const te = nesting.cam && nesting.cam.timeEstimate;
  document.getElementById('metricMachineTime').textContent = te ? fmtDuration(te.totalS) : '—';
  document.getElementById('metricMachineTime').title = te ? `corte ${fmtDuration(te.cutS)}, perfurações ${fmtDuration(te.pierceS)}, em vazio ${fmtDuration(te.rapidS)}` : '';
  document.getElementById('metricCrossings').textContent = m ? (m.rapidCrossings ? `${m.rapidCrossings} ${m.rapidCrossings === 1 ? 'vez' : 'vezes'}` : 'nenhum') : '—';
  document.getElementById('metricRapid').textContent = m ? `${(m.rapidLength / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} m / ${(m.cutLength / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} m` : '—';

  // Validação independente do layout (só disponível no resultado final)
  const vEl = document.getElementById('metricValidation');
  const v = nesting.validation;
  if (!v) {
    vEl.textContent = 'ao terminar';
    vEl.className = '';
  } else if (v.ok) {
    vEl.textContent = 'APROVADO';
    vEl.title = `${v.checkedPairs} pares de peças conferidos pelo validador independente`;
    vEl.className = 'ok';
  } else {
    vEl.textContent = `REPROVADO (${v.errorCount})`;
    vEl.className = 'bad';
  }

  const notes = [];
  if (v && !v.ok) notes.push(...v.errors.slice(0, 4).map(e => e.msg));
  if (nesting.cam && nesting.cam.warnings) notes.push(...nesting.cam.warnings.slice(0, 3));
  if (v && v.warnings) notes.push(...v.warnings.filter(w => w.type === 'G00_SOBRE_PECA_CORTADA').map(w => w.msg));
  showCamMessage(notes.join(' | '));

  const alertBox = document.getElementById('unplacedAlert');
  if (opts.multi) {
    alertBox.classList.add('hidden'); // no conjunto, o que não coube numa chapa foi para a próxima (ver "Faltaram")
  } else if (nesting.unplacedParts && nesting.unplacedParts.length > 0) {
    alertBox.classList.remove('hidden');
    alertBox.textContent = `${nesting.unplacedParts.length} ${nesting.unplacedParts.length === 1 ? 'peça não coube' : 'peças não couberam'} nesta chapa. Aumente a chapa, reduza o lote ou informe mais chapas e retalhos no estoque (passo 2).`;
  } else {
    alertBox.classList.add('hidden');
  }
}

// ---------- várias chapas e retalhos (V5.8, ADR 009) ----------
const remnantListEl = document.getElementById('remnantList');
function readRemnants() {
  return [...remnantListEl.querySelectorAll('.remnant-row')].map(r => ({
    width: Number(r.querySelector('[data-k="w"]').value), height: Number(r.querySelector('[data-k="h"]').value),
    quantity: Math.max(1, Math.floor(Number(r.querySelector('[data-k="q"]').value) || 1))
  })).filter(r => r.width >= 20 && r.height >= 20);
}
function renderRemnantEmpty() {
  if (!remnantListEl.querySelector('.remnant-row')) remnantListEl.innerHTML = '<span class="remnant-empty">Nenhum. Retalhos entram antes das chapas inteiras.</span>';
}
function addRemnantRow(w = 600, h = 400, q = 1) {
  const empty = remnantListEl.querySelector('.remnant-empty');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'remnant-row';
  row.innerHTML = `<input type="number" data-k="w" min="20" step="10" value="${w}" aria-label="Comprimento do retalho (mm)" />` +
    `<span class="x">×</span><input type="number" data-k="h" min="20" step="10" value="${h}" aria-label="Largura do retalho (mm)" />` +
    `<span class="x">qtd</span><input type="number" data-k="q" min="1" max="50" step="1" value="${q}" aria-label="Quantidade" />` +
    `<button type="button" class="del" title="Tirar este retalho" aria-label="Tirar este retalho">×</button>`;
  row.querySelectorAll('input').forEach(i => i.addEventListener('change', () => { if (currentUploadId) scheduleOptimization(500); }));
  row.querySelector('.del').addEventListener('click', () => { row.remove(); renderRemnantEmpty(); if (currentUploadId) scheduleOptimization(300); });
  remnantListEl.appendChild(row);
}
document.getElementById('btnAddRemnant').addEventListener('click', () => { addRemnantRow(); if (currentUploadId) scheduleOptimization(500); });
document.getElementById('fullSheetsInput').addEventListener('change', () => { if (currentUploadId) scheduleOptimization(500); });
renderRemnantEmpty();

const KIND_TXT = { desenhada: 'chapa desenhada', retalho: 'retalho', chapa: 'chapa inteira' };
function finishMulti(msg, expandedCount) {
  multiResult = msg;
  const sm = msg.summary || {};
  progressBarFill.style.width = '100%';
  progressPercentText.textContent = '100%';
  const secs = (msg.totalTimeMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  progressStatusText.textContent = `Pronto em ${secs} s: ${sm.sheetsUsed} ${sm.sheetsUsed === 1 ? 'chapa' : 'chapas'}` +
    `${sm.remnantsUsed ? ` (${sm.remnantsUsed} ${sm.remnantsUsed === 1 ? 'retalho' : 'retalhos'} do estoque)` : ''}, ${fmtPct(sm.utilization)} de aproveitamento no conjunto` +
    `${msg.stoppedByUser ? ', parado pelo usuário' : ''}`;
  progressStrategyText.textContent = sm.unplaced
    ? `Faltaram ${sm.unplaced} ${sm.unplaced === 1 ? 'peça' : 'peças'}: o estoque informado acabou. Cada chapa foi conferida pelo validador independente.`
    : 'Todas as peças cortadas. Cada chapa foi conferida pelo validador independente.';
  progressBestText.textContent = '';

  document.getElementById('multiSummary').classList.remove('hidden');
  document.getElementById('multiUtil').textContent = fmtPct(sm.utilization);
  document.getElementById('multiSheets').textContent = `${sm.sheetsUsed} de ${(msg.stock || []).length}`;
  document.getElementById('multiRemnants').textContent = String(sm.remnantsUsed || 0);
  document.getElementById('multiPlaced').textContent = `${sm.placed} de ${sm.totalParts}`;
  const un = document.getElementById('multiUnplaced');
  un.textContent = sm.unplaced ? `${sm.unplaced} ${sm.unplaced === 1 ? 'peça' : 'peças'}` : 'nenhuma';
  un.className = sm.unplaced ? 'bad' : 'ok';
  const totalT = msg.sheets.reduce((acc, sh) => acc + ((sh.bestResult.cam && sh.bestResult.cam.timeEstimate) ? sh.bestResult.cam.timeEstimate.totalS : 0), 0);
  document.getElementById('multiMachineTime').textContent = totalT ? fmtDuration(totalT) : '—';
  document.getElementById('multiSkipped').textContent = (msg.skipped || []).length
    ? 'Não usadas: ' + msg.skipped.map(k => `${k.label} (${k.why})`).join('; ') + '.' : '';
  document.getElementById('btnExportAllDxf').classList.toggle('hidden', msg.sheets.length < 2);

  const tabs = document.getElementById('sheetTabs');
  tabs.innerHTML = '';
  msg.sheets.forEach((sh, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sheet-tab kind-${sh.kind}`;
    b.setAttribute('role', 'tab');
    b.innerHTML = `<b>${i + 1}. ${esc(KIND_TXT[sh.kind] || sh.kind)}</b><small>${Math.round(sh.width)} × ${Math.round(sh.height)}, ${sh.bestResult.placedParts.length} peças, ${fmtPct(sh.bestResult.rawUtilization)} da chapa</small>`;
    b.onclick = () => selectSheet(i, expandedCount);
    tabs.appendChild(b);
  });
  tabs.classList.remove('hidden');
  btnExportDxf.disabled = false;
  selectSheet(0, expandedCount);
}

function selectSheet(i, expandedCount) {
  if (!multiResult) return;
  activeSheet = i;
  const sh = multiResult.sheets[i];
  [...document.querySelectorAll('#sheetTabs .sheet-tab')].forEach((t, k) => t.setAttribute('aria-selected', k === i ? 'true' : 'false'));
  document.getElementById('resultTitle').textContent = `Chapa ${i + 1}: ${sh.label}`;
  bestSolutionGlobal = sh.bestResult;
  currentArchive = sh.topArchive || [];
  resetZoom();
  drawSheetNesting(bestSolutionGlobal, false);
  updateMetrics(expandedCount, bestSolutionGlobal, { multi: true });
  renderArchiveButtons(currentArchive, bestSolutionGlobal, expandedCount);
}

async function downloadLayoutDxf(layout, fileName) {
  const r = await fetch('/api/export-dxf', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layout, options: currentExportOptions() })
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const detail = err.validation ? ' ' + err.validation.errors.slice(0, 3).map(e => e.msg).join(' | ') : '';
    showCamMessage(`Exportação bloqueada (${fileName}): ${err.error || `HTTP ${r.status}`}${detail}`);
    return false;
  }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return true;
}
document.getElementById('btnExportAllDxf').addEventListener('click', async (ev) => {
  if (!multiResult) return;
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    for (let i = 0; i < multiResult.sheets.length; i++) {
      const sh = multiResult.sheets[i];
      await downloadLayoutDxf(sh.bestResult, `chapa${i + 1}_${sh.kind}_${Math.round(sh.width)}x${Math.round(sh.height)}.dxf`);
      await new Promise(r => setTimeout(r, 350)); // o navegador bloqueia downloads seguidos rápidos demais
    }
  } finally { btn.disabled = false; }
});

function renderArchiveButtons(archive, active, totalExpandedCount) {
  if (archive.length <= 1) {
    candidatesBar.classList.add('hidden');
    return;
  }
  candidatesBar.classList.remove('hidden');
  candidatesList.innerHTML = '';
  archive.forEach((sol, i) => {
    const b = document.createElement('button');
    b.className = `candidate-chip ${sol === active ? 'active' : ''}`;
    const bad = sol.validation && !sol.validation.ok ? ' (reprovado)' : '';
    const rem = sol.largestRemnantArea > 0 && sol.largestRemnantDim ? `retalho ${dimTxt(sol.largestRemnantDim)}` : 'sem retalho';
    b.textContent = `${i + 1}: ${fmtPct(sol.compactUtilization)}, ${rem}${bad}`;
    b.title = sol.engine === 'SPARROW' ? 'plano do otimizador sparrow' : 'plano do motor clássico';
    b.onclick = () => {
      bestSolutionGlobal = sol;
      drawSheetNesting(sol, false);
      updateMetrics(totalExpandedCount, sol, { multi: !!multiResult });
      renderArchiveButtons(archive, sol, totalExpandedCount);
      if (multiResult) multiResult.sheets[activeSheet].bestResult = sol; // a escolha vale para esta chapa (exportar todas)
    };
    candidatesList.appendChild(b);
  });
}

function renderSeparatedParts(parts) {
  const grid = document.getElementById('partsGrid');
  grid.innerHTML = '';
  parts.forEach(part => {
    const q = partQuantities[part.id] ?? 1;
    const card = document.createElement('div');
    card.className = 'part-card';
    const holes = part.holes || [];
    const usable = holes.filter(h => h.usableHole).length;
    const holesHtml = holes.map((h, i) => `
      <div class="hole-tag ${h.usableHole ? 'promoted' : 'scrap'}">Furo ${i + 1}: ${Math.round(h.width)} × ${Math.round(h.height)} mm, ${h.usableHole ? 'pode receber peça' : 'vira sucata'}</div>
    `).join('');
    const rot = part.instances ? [...new Set(part.instances.map(i => i.rotationDeg))].slice(0, 6) : [];
    card.innerHTML = `
      <div class="part-card-header"><span>${esc(part.name)}</span><span class="part-dims">${Math.round(part.width)} × ${Math.round(part.height)} mm</span></div>
      <div class="part-preview"><canvas width="200" height="110" id="prev_${part.id}"></canvas></div>
      <div class="part-meta">
        <div>Área <strong>${(part.area / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 4 })} m²</strong></div>
        ${part.quantity_detected > 1 ? `<div><strong>${part.quantity_detected}</strong> cópias no desenho${rot.length > 1 ? `, giradas ${rot.join('°, ')}°` : ''}</div>` : ''}
        ${part.blockName ? `<div>Bloco <strong>${esc(part.blockName)}</strong></div>` : ''}
        ${part.mirrorOf ? `<div>Espelho de <strong>${esc((catalogParts.find(c => c.id === part.mirrorOf) || {}).name || part.mirrorOf)}</strong></div>` : ''}
        ${holes.length ? `<details class="part-holes"><summary>${holes.length} ${holes.length === 1 ? 'furo' : 'furos'}${usable ? `, ${usable} ${usable === 1 ? 'aproveitável' : 'aproveitáveis'}` : ''}</summary>${holesHtml}</details>` : '<div>Sem furos</div>'}
      </div>
      <div class="card-qty-footer">
        <span>No lote</span>
        <div class="qty-stepper">
          <button type="button" class="qty-btn" data-card-act="dec" data-id="${part.id}" aria-label="menos">−</button>
          <input type="number" id="card_qty_${part.id}" class="qty-number-input" value="${q}" min="0" max="500" aria-label="quantidade" />
          <button type="button" class="qty-btn" data-card-act="inc" data-id="${part.id}" aria-label="mais">+</button>
        </div>
      </div>
    `;
    grid.appendChild(card);

    card.querySelectorAll('.qty-btn').forEach(btn => {
      btn.onclick = () => {
        const cur = partQuantities[part.id] ?? 1;
        setPartQuantity(part.id, btn.dataset.cardAct === 'inc' ? cur + 1 : cur - 1);
      };
    });
    const inp = card.querySelector('.qty-number-input');
    inp.onchange = () => setPartQuantity(part.id, inp.value);

    const c = document.getElementById(`prev_${part.id}`);
    const pc = c.getContext('2d');
    c.width = 200 * DPR; c.height = 110 * DPR; c.style.width = '200px'; c.style.height = '110px';
    pc.setTransform(DPR, 0, 0, DPR, 0, 0);
    const s = Math.min(176 / part.width, 92 / part.height);
    const ox = (200 - part.width * s) / 2, oy = (110 - part.height * s) / 2;
    const prevRing = (pts) => {
      pc.beginPath();
      pts.forEach((pt, i) => {
        const px = ox + pt.x * s, py = oy + (part.height - pt.y) * s; // Y para cima, como no CAD
        if (i === 0) pc.moveTo(px, py); else pc.lineTo(px, py);
      });
      pc.closePath();
    };
    pc.strokeStyle = '#0F2E1F';
    prevRing(part.points);
    pc.fillStyle = '#38BDF8'; pc.fill(); pc.stroke();
    holes.forEach(h => {
      prevRing(h.points);
      pc.fillStyle = h.usableHole ? '#FDE047' : '#163D2A';
      pc.fill(); pc.stroke();
    });
  });
}

// =========================================================
// 5. EXPORTAÇÃO .DXF FINAL MULTI-LAYER (GERADA NO SERVIDOR: R12 UNIVERSAL, SEM ESPELHAMENTO)
// =========================================================

function currentExportOptions() {
  return {
    includeSheet: document.getElementById('exportIncludeSheet').checked,
    includeRemnants: exportIncludeRemnantsInput.checked,
    includeLeadIn: exportIncludeLeadInInput.checked,
    includeLabels: document.getElementById('exportIncludeLabels').checked
  };
}

document.getElementById('btnExportRemnantsDxf').addEventListener('click', async () => {
  if (!bestSolutionGlobal) return;
  const btn = document.getElementById('btnExportRemnantsDxf');
  btn.disabled = true;
  try {
    const r = await fetch('/api/export-remnants-dxf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: bestSolutionGlobal, options: { includeLabels: true } })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      showCamMessage(`Retalhos: ${err.error || `HTTP ${r.status}`}`);
      return;
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `retalhos_${Math.round(bestSolutionGlobal.sheetWidth)}x${Math.round(bestSolutionGlobal.sheetHeight)}.dxf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } finally {
    btn.disabled = false;
  }
});

btnExportDxf.addEventListener('click', async () => {
  if (!bestSolutionGlobal) return;
  btnExportDxf.disabled = true;
  try {
    const r = await fetch('/api/export-dxf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: bestSolutionGlobal,
        options: currentExportOptions()
      })
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const detail = err.validation ? ' ' + err.validation.errors.slice(0, 3).map(e => e.msg).join(' | ') : '';
      showCamMessage(`Exportação bloqueada: ${err.error || `HTTP ${r.status}`}${detail}`);
      return;
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nesting_cam_${Math.round(bestSolutionGlobal.sheetWidth)}x${Math.round(bestSolutionGlobal.sheetHeight)}.dxf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  } finally {
    btnExportDxf.disabled = false;
  }
});

async function initProcessProfiles() {
  try {
    const r = await fetch('/api/process-profiles');
    const data = await r.json();
    (data.processes || []).forEach((p) => {
      const o = document.createElement('option');
      o.value = p.key; o.textContent = p.label; o.title = p.description;
      processSelect.appendChild(o);
    });
  } catch (_) { /* perfis são opcionais */ }
}

btnApplyProfile.addEventListener('click', async () => {
  if (!processSelect.value) { profileNotes.textContent = 'Escolha um processo de corte.'; return; }
  try {
    const r = await fetch(`/api/recommend-params?process=${encodeURIComponent(processSelect.value)}&thickness=${encodeURIComponent(thicknessInput.value)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const p = data.params;
    kerfWidthInput.value = p.kerf_width;
    partClearanceInput.value = p.part_clearance;
    sheetMarginInput.value = p.sheet_margin;
    leadInLengthInput.value = p.lead_in_length;
    pierceRadiusInput.value = p.pierce_radius;
    holeClearanceInput.value = p.hole_clearance;
    minHoleSizeInput.value = p.min_hole_size;
    leadInTypeSelect.value = p.lead_in_type;
    profileNotes.textContent = data.notes.join(' ');
  } catch (err) {
    profileNotes.textContent = `Erro: ${err.message}`;
  }
});

window.addEventListener('DOMContentLoaded', () => {
  initProcessProfiles();
  updateHints();
  refreshHardwareStatus();
  loadSelectedPreset();
});

