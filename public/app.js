// public/app.js
'use strict';

let currentUploadId = null;
let currentArchive = [];
let runToken = 0;          // identifica a execução vigente; mensagens de execuções antigas são descartadas
let startDebounce = null;
let catalogParts = [];
let partQuantities = {};
let customSheetDxf = null;
let bestSolutionGlobal = null;
let activeEventSource = null;
let seedCounter = 1;

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

// Regra do produto: qualidade > velocidade. O modo define o ORÇAMENTO de busca, nunca a correção do resultado.
const QUALITY_MODES = {
  RASCUNHO: { iterations: 3000, evaluation_mode: 'FAST' },
  PADRAO: { iterations: 15000, evaluation_mode: 'PRECISE' },
  PRODUCAO: { iterations: 60000, evaluation_mode: 'PRECISE' }
};

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

async function refreshHardwareStatus() {
  try {
    const res = await fetch('/api/hardware');
    const hw = await res.json();
    document.getElementById('hwInfoBox').innerHTML =
      `<strong>CPU:</strong> ${hw.cpuModel} (${hw.totalCores} threads)<br>` +
      `<strong>Worker Pool VPS:</strong> Máx ${hw.maxWorkers} simultâneos (Ativos: ${hw.activeWorkers} | Fila: ${hw.queueSize})<br>` +
      `<strong>Aceleração:</strong> ${hw.gpu.name}`;
  } catch (_) {}
}

// =========================================================
// 1. MULTIPLICADOR DE LOTE E QUANTIDADES SINCRONIZADAS
// =========================================================

function initDefaultQuantities(partsList) {
  partQuantities = {};
  partsList.forEach(p => { partQuantities[p.id] = 1; });
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
  document.getElementById('totalPartsBadge').textContent = `Total: ${totalCount} pçs`;

  const sidebarList = document.getElementById('sidebarQtyList');
  sidebarList.innerHTML = '';

  catalogParts.forEach(part => {
    const q = partQuantities[part.id] ?? 1;
    const row = document.createElement('div');
    row.className = 'qty-item-row';
    row.innerHTML = `
      <div class="qty-item-info">
        <span class="qty-item-name">${esc(part.name)}</span>
        <span class="qty-item-dim">${Math.round(part.width)}x${Math.round(part.height)}mm</span>
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

document.querySelectorAll('.quick-batch-bar .chip-btn[data-mult]').forEach(btn => {
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

function scheduleOptimization(delay = 400) {
  clearTimeout(startDebounce);
  startDebounce = setTimeout(startBackendSseOptimization, delay);
}

// =========================================================
// 2. INGESTÃO .DXF DE PEÇAS E CHAPAS IRREGULARES
// =========================================================

/** Envia o DXF das peças; o servidor guarda o parse (uploadId) e a tolerância de flecha é aplicada a cada job. */
async function uploadPartsFile(file) {
  const fd = new FormData();
  fd.append('dxfFile', file);
  const res = await fetch(`/api/upload-dxf?tol=${encodeURIComponent(chordalToleranceInput.value || 0.03)}`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Falha no upload (HTTP ${res.status})`);
  currentUploadId = data.uploadId || null;
  catalogParts = data.catalogParts || [];
  initDefaultQuantities(catalogParts);
  renderSeparatedParts(catalogParts);
  if (data.warnings && data.warnings.length) showCamMessage(data.warnings.join(' | '));
}

dxfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  fileNameLabel.textContent = file.name;
  try {
    await uploadPartsFile(file);
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
  const data = await res.json();
  if (data.sheet) {
    customSheetDxf = data.sheet;
    const obsCount = (customSheetDxf.obstacles || []).length;
    sheetFileNameLabel.textContent = `Chapa DXF: ${file.name} (${obsCount} furo(s) CW)`;
    sheetWidthInput.value = Math.round(customSheetDxf.width);
    sheetHeightInput.value = Math.round(customSheetDxf.height);
    btnClearCustomSheet.classList.remove('hidden');
    resetZoom();
    startBackendSseOptimization();
  }
});

btnClearCustomSheet.addEventListener('click', () => {
  customSheetDxf = null;
  sheetPresetSelect.value = 'rect';
  sheetFileNameLabel.textContent = '2º (Opcional) Enviar .DXF da Chapa Principal';
  btnClearCustomSheet.classList.add('hidden');
  resetZoom();
  startBackendSseOptimization();
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
    sheetFileNameLabel.textContent = `Chapa Preset: ${val} (${obsCount} furo(s) CW)`;
    sheetWidthInput.value = Math.round(customSheetDxf.width);
    sheetHeightInput.value = Math.round(customSheetDxf.height);
    btnClearCustomSheet.classList.remove('hidden');
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
  fileNameLabel.textContent = `${file.name} (Ativo)`;
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
btnRecalculate.addEventListener('click', () => {
  seedCounter++;
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
  showCamMessage('');
  document.getElementById('unplacedAlert').classList.add('hidden');
  ctx.clearRect(0, 0, nestingCanvas.width, nestingCanvas.height);
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
  progressStatusText.textContent = 'Inicializando Matriz NFP/IFP e R-Tree no Worker...';

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
      body: JSON.stringify({ uploadId: currentUploadId, sheet: customSheetDxf, config, quantities: partQuantities })
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

  const es = new EventSource(`/api/stream/${jobId}`);
  activeEventSource = es;

  es.onmessage = (event) => {
    if (myRun !== runToken) { es.close(); return; } // descarta mensagens de execuções antigas
    const msg = JSON.parse(event.data);

    if (msg.type === 'queued') {
      progressStatusText.textContent = `Fila VPS: Posição #${msg.position} (${msg.activeWorkers}/${msg.maxWorkers} Workers)...`;
      return;
    }

    if (msg.type === 'error') {
      es.close();
      activeEventSource = null;
      btnRecalculate.disabled = false;
      progressStatusText.textContent = `Erro no motor: ${msg.error || 'falha desconhecida'}`;
      return;
    }

    if (msg.type === 'progress') {
      const pct = Math.round((msg.fraction ?? (msg.iter / msg.totalIterations)) * 100);
      progressBarFill.style.width = `${pct}%`;
      progressPercentText.textContent = `${pct}%`;
      progressStatusText.textContent = `BRKGA + SA: ${msg.iter.toLocaleString()} de ${msg.totalIterations.toLocaleString()} avaliações BLF...`;
      progressStrategyText.textContent = `Taxa: ${msg.calcPerSec.toLocaleString()} layouts/seg | Workers: ${msg.activeWorkers}/${msg.maxWorkers}`;

      if (msg.bestResult) {
        bestSolutionGlobal = msg.bestResult;
        progressBestText.textContent = `Recorde Elite: ${bestSolutionGlobal.compactUtilization}% (${msg.improvements} avanços)`;
        drawSheetNesting(bestSolutionGlobal, true);
        updateMetrics(expandedCount, bestSolutionGlobal);
      }
    }

    if (msg.type === 'done') {
      es.close();
      activeEventSource = null;
      btnRecalculate.disabled = false;
      refreshHardwareStatus();

      bestSolutionGlobal = msg.bestResult;
      currentArchive = msg.topArchive || [];
      progressBarFill.style.width = '100%';
      progressPercentText.textContent = '100%';
      progressStatusText.textContent = `${msg.totalIterations.toLocaleString()} Avaliações ${msg.stoppedByTimeLimit ? '(limite de tempo atingido)' : 'Concluídas'} em ${(msg.totalTimeMs / 1000).toFixed(2)}s!`;
      progressStrategyText.textContent = `Velocidade Média: ${msg.calcPerSec.toLocaleString()} layouts/seg`;
      if (!bestSolutionGlobal) { progressBestText.textContent = 'Nenhum layout gerado.'; return; }
      progressBestText.textContent = `Campeão Travado: ${bestSolutionGlobal.compactUtilization}%`;

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
    btnRecalculate.disabled = false;
  };
}

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
  const mx = (e.clientX - rect.left) * (nestingCanvas.width / rect.width);
  const my = (e.clientY - rect.top) * (nestingCanvas.height / rect.height);

  // Eixo Y do viewport = eixo Y do CAD (para cima)
  const { startX, startY, scale, H } = lastRenderTransform;
  const sheetX = (mx - startX) / scale;
  const sheetY = H - (my - startY) / scale;

  // Hit-test por POLÍGONO real (filhas In-Hole primeiro, pois estão sobre o furo da mãe)
  const inPart = (p) => pointInPoly(sheetX - p.x, sheetY - p.y, p.placedPoints);
  const parts = bestSolutionGlobal.placedParts;
  const hitPart = parts.filter(p => p.nestedInsideHole).find(inPart) || parts.find(inPart);
  if (hitPart) {
    const seq = hitPart.cutSequenceOrder ? `Ordem Corte: #${hitPart.cutSequenceOrder}` : '';
    hoverInspector.textContent = `${hitPart.name} [${seq}] | Giro: ${hitPart.angle || 0}° | Dim: ${hitPart.placedWidth}x${hitPart.placedHeight}mm | Pos: (${hitPart.x}, ${hitPart.y})`;
    return;
  }

  const hitRem = (bestSolutionGlobal.remnants || []).find(
    r => sheetX >= r.x && sheetX <= r.x + r.width && sheetY >= r.y && sheetY <= r.y + r.height
  );
  if (hitRem) {
    hoverInspector.textContent = `${hitRem.label} (Sobra Útil) | Dim: ${hitRem.width}x${hitRem.height}mm | Área: ${(hitRem.area / 100).toFixed(1)} cm²`;
    return;
  }

  hoverInspector.textContent = `Coordenada Mesa CNC: X=${Math.round(sheetX)}mm, Y=${Math.round(sheetY)}mm (Zoom: ${Math.round(viewZoom * 100)}%)`;
});

function drawSheetNesting(nesting, isHighlight = false) {
  if (!nesting) return;
  const pad = 36;
  const availW = nestingCanvas.width - pad * 2;
  const availH = nestingCanvas.height - pad * 2;
  const baseScale = Math.min(availW / nesting.sheetWidth, availH / nesting.sheetHeight);
  const scale = baseScale * viewZoom;
  const H = nesting.sheetHeight;

  const drawW = nesting.sheetWidth * scale;
  const drawH = H * scale;
  const startX = (nestingCanvas.width - drawW) / 2 + viewPanX;
  const startY = (nestingCanvas.height - drawH) / 2 + viewPanY;

  lastRenderTransform = { startX, startY, scale, H };

  // Mapeamento mesa CNC -> tela: X para a direita, Y PARA CIMA (idêntico ao DXF; nada fica espelhado)
  const sx = (x) => startX + x * scale;
  const sy = (y) => startY + (H - y) * scale;
  const ring = (pts, ox = 0, oy = 0) => {
    if (!pts || !pts.length) return;
    ctx.beginPath();
    pts.forEach((pt, idx) => {
      if (idx === 0) ctx.moveTo(sx(ox + pt.x), sy(oy + pt.y));
      else ctx.lineTo(sx(ox + pt.x), sy(oy + pt.y));
    });
    ctx.closePath();
  };

  ctx.clearRect(0, 0, nestingCanvas.width, nestingCanvas.height);

  ctx.save();
  if (nesting.sheetPoly && nesting.sheetPoly.length > 0) {
    ring(nesting.sheetPoly);
    ctx.fillStyle = '#1e293b';
    ctx.fill();
    ctx.clip();
  } else {
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(startX, startY, drawW, drawH);
  }

  // Grade milimetrada
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1;
  const stepGrid = nesting.sheetWidth <= 300 ? 20 : 100;
  for (let x = 0; x <= nesting.sheetWidth; x += stepGrid) {
    ctx.beginPath(); ctx.moveTo(sx(x), startY); ctx.lineTo(sx(x), startY + drawH); ctx.stroke();
  }
  for (let y = 0; y <= H; y += stepGrid) {
    ctx.beginPath(); ctx.moveTo(startX, sy(y)); ctx.lineTo(startX + drawW, sy(y)); ctx.stroke();
  }

  // Furos/Obstáculos internos da Chapa Principal (CW)
  (nesting.sheetObstacles || []).forEach((obs) => {
    ring(obs.points);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const ocx = sx(obs.minX + obs.width / 2);
    const ocy = sy(obs.minY + obs.height / 2);
    ctx.fillStyle = '#fdba74';
    ctx.font = 'bold 9.5px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Furo/Recorte da Chapa', ocx, ocy - 2);
    ctx.font = '9px monospace';
    ctx.fillText(`${Math.round(obs.width)}x${Math.round(obs.height)}mm`, ocx, ocy + 9);
    ctx.textAlign = 'left';
  });

  // Retalhos padronizados da chapa
  if (showRemnantsInput.checked && nesting.remnants) {
    nesting.remnants.forEach(rem => {
      const rx = sx(rem.x), ry = sy(rem.y + rem.height);
      const rw = rem.width * scale, rh = rem.height * scale;
      ctx.fillStyle = 'rgba(168, 85, 247, 0.24)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = '#c084fc';
      ctx.lineWidth = 1.8;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
      ctx.setLineDash([]);

      if (rw > 44 && rh > 24) {
        ctx.fillStyle = '#e9d5ff';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(rem.label, rx + rw / 2, ry + rh / 2 - 2);
        ctx.font = '10px monospace';
        ctx.fillText(`${Math.round(rem.width)}x${Math.round(rem.height)}mm`, rx + rw / 2, ry + rh / 2 + 10);
        ctx.textAlign = 'left';
      }
    });
  }

  // Peças alocadas (mães primeiro, filhas In-Hole por cima)
  const drawOrder = [...nesting.placedParts].sort((a, b) => (a.nestedInsideHole ? 1 : 0) - (b.nestedInsideHole ? 1 : 0));
  drawOrder.forEach(part => {
    ring(part.placedPoints, part.x, part.y);
    ctx.fillStyle = part.nestedInsideHole ? 'rgba(52, 211, 153, 0.95)' : 'rgba(56, 189, 248, 0.92)';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    (part.placedHoles || []).forEach(hole => {
      ring(hole.placedPoints, part.x, part.y);
      ctx.fillStyle = hole.usableHole ? '#fde047' : '#f87171';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    });

    const pw = part.placedWidth * scale;
    const ph = part.placedHeight * scale;
    if (pw > 26 && ph > 16) {
      const cx = sx(part.x + part.placedWidth / 2);
      const cy = sy(part.y + part.placedHeight / 2);
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 9.5px sans-serif';
      ctx.textAlign = 'center';
      const seqLabel = (showCamToolpathInput.checked && part.cutSequenceOrder) ? `[${part.cutSequenceOrder}º] ` : '';
      ctx.fillText(`${seqLabel}${part.name}${part.angle ? ` (${part.angle}°)` : ''}`, cx, cy - 1);
      if (ph > 28) {
        ctx.font = '8.5px monospace';
        ctx.fillText(`${Math.round(part.placedWidth)}x${Math.round(part.placedHeight)}`, cx, cy + 9);
      }
      ctx.textAlign = 'left';
    }
  });

  // Visualização CAM: sequência REAL de corte (Inside-Out), G00 e perfuração de cada contorno (furos incluídos)
  const cam = nesting.cam;
  if (showCamToolpathInput.checked && cam && cam.ops && cam.ops.length) {
    // Avanço rápido G00 (laranja = passa por cima de peça já solta)
    ctx.lineWidth = 1.3;
    ctx.setLineDash([4, 4]);
    (cam.rapids || []).forEach(r => {
      ctx.strokeStyle = r.crossesCut ? 'rgba(249, 115, 22, 0.95)' : 'rgba(250, 204, 21, 0.75)';
      ctx.beginPath();
      ctx.moveTo(sx(r.x1), sy(r.y1));
      ctx.lineTo(sx(r.x2), sy(r.y2));
      ctx.stroke();
    });
    ctx.setLineDash([]);

    const showNumbers = cam.ops.length <= 80;
    cam.ops.forEach(op => {
      const color = op.invalid ? '#f59e0b' : '#ef4444';
      // Lead-in (reta ou arco) do ponto de perfuração até a aresta
      if (op.leadPath && op.leadPath.length > 1) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        op.leadPath.forEach((q, i) => (i === 0 ? ctx.moveTo(sx(q.x), sy(q.y)) : ctx.lineTo(sx(q.x), sy(q.y))));
        ctx.stroke();
      }
      // Cratera de perfuração
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx(op.pierce.x), sy(op.pierce.y), op.kind === 'HOLE' ? 3.6 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      if (op.kind === 'HOLE') {
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      if (showNumbers) {
        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 9px sans-serif';
        ctx.fillText(String(op.seq), sx(op.pierce.x) + 5, sy(op.pierce.y) - 4);
      }
    });
  }

  ctx.restore();

  // Contorno externo da chapa
  ctx.strokeStyle = isHighlight ? '#34d399' : '#94a3b8';
  ctx.lineWidth = isHighlight ? 3.5 : 2;
  if (nesting.sheetPoly && nesting.sheetPoly.length > 0) {
    ring(nesting.sheetPoly);
    ctx.stroke();
  } else {
    ctx.strokeRect(startX, startY, drawW, drawH);
  }
}

function updateMetrics(totalExpandedCount, nesting) {
  document.getElementById('kpiUtilization').textContent = `${nesting.compactUtilization}%`;
  document.getElementById('kpiRawRatio').textContent =
    `Bruto na chapa líquida: ${nesting.rawUtilization}% | Fibra: ${nesting.grain_restriction || 'ORTHOGONAL'}`;
  document.getElementById('metricNetUtil').textContent = `${nesting.rawUtilization}%`;
  document.getElementById('metricLargestRemnant').textContent = nesting.largestRemnantArea ? `${nesting.largestRemnantDim} (${(nesting.largestRemnantArea / 100).toFixed(1)} cm²)` : '—';
  document.getElementById('metricSheetArea').textContent = `${(nesting.sheetArea / 100).toFixed(1)} cm²`;
  document.getElementById('metricUsedArea').textContent = `${(nesting.usedArea / 100).toFixed(1)} cm²`;
  document.getElementById('metricPlacedCount').textContent = `${nesting.placedParts.length} / ${totalExpandedCount}`;

  const dNom = nesting.commonLine
    ? `${nesting.kerf_width} mm (CLC Ativo)`
    : `${nesting.kerf} mm (${nesting.part_clearance} + ${nesting.kerf_width})`;
  document.getElementById('metricNominalGap').textContent = dNom;

  document.getElementById('metricRemnantArea').textContent =
    `${(nesting.remnantArea / 100).toFixed(1)} cm² (${nesting.remnants.length} retalhos)`;
  document.getElementById('metricInHoleParts').textContent = nesting.inHoleCount || 0;
  document.getElementById('metricFreeSlugs').textContent = `${nesting.freeHoleSlugsCount || 0} (Custo Zero)`;

  const obsCount = (nesting.sheetObstacles || []).length;
  document.getElementById('sheetSpecText').textContent =
    `Chapa: ${nesting.sheetWidth}x${nesting.sheetHeight}mm | Margem Borda: ${nesting.sheet_margin ?? 6}mm ${nesting.sheetPoly ? `| DXF c/ ${obsCount} obstáculo(s)` : ''}`;

  // Telemetria CAM
  const m = nesting.cam && nesting.cam.metrics;
  document.getElementById('metricPierces').textContent = m ? `${m.pierceCount} (${m.narrowWebPierces || 0} em alma estreita, ${m.invalidLeads} sem espaço)` : '—';
  document.getElementById('metricRapid').textContent = m ? `${(m.rapidLength / 1000).toFixed(2)} m / ${(m.cutLength / 1000).toFixed(2)} m` : '—';

  // Validação independente do layout (só disponível no resultado final)
  const vEl = document.getElementById('metricValidation');
  const v = nesting.validation;
  if (!v) {
    vEl.textContent = 'validando ao final…';
    vEl.style.color = '';
  } else if (v.ok) {
    vEl.textContent = `APROVADO (${v.checkedPairs} pares)`;
    vEl.style.color = '#15803d';
  } else {
    vEl.textContent = `REPROVADO (${v.errorCount})`;
    vEl.style.color = '#b91c1c';
  }

  const notes = [];
  if (v && !v.ok) notes.push(...v.errors.slice(0, 4).map(e => e.msg));
  if (nesting.cam && nesting.cam.warnings) notes.push(...nesting.cam.warnings.slice(0, 3));
  if (v && v.warnings) notes.push(...v.warnings.filter(w => w.type === 'G00_SOBRE_PECA_CORTADA').map(w => w.msg));
  showCamMessage(notes.join(' | '));

  const alertBox = document.getElementById('unplacedAlert');
  if (nesting.unplacedParts && nesting.unplacedParts.length > 0) {
    alertBox.classList.remove('hidden');
    alertBox.textContent = `Atenção: ${nesting.unplacedParts.length} peça(s) do lote excederam o Inner-Fit Polygon (IFP) da chapa atual.`;
  } else {
    alertBox.classList.add('hidden');
  }
}

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
    const ok = sol.validation ? (sol.validation.ok ? '✔ ' : '✖ ') : '';
    b.textContent = `${ok}Elite #${i + 1}: ${sol.compactUtilization}% (Maior Retalho: ${sol.largestRemnantDim})`;
    b.onclick = () => {
      bestSolutionGlobal = sol;
      drawSheetNesting(sol, false);
      updateMetrics(totalExpandedCount, sol);
      renderArchiveButtons(archive, sol, totalExpandedCount);
    };
    candidatesList.appendChild(b);
  });
}

function renderSeparatedParts(parts) {
  const grid = document.getElementById('partsGrid');
  grid.innerHTML = '';
  parts.forEach(part => {
    const q = partQuantities[part.id] ?? 1;
    const rMaxOuter = part.outer_contour?.max_inscribed_radius ?? 0;
    const card = document.createElement('div');
    card.className = 'part-card';
    const holesHtml = (part.holes || []).map((h, i) => `
      <div class="hole-tag ${h.usableHole ? 'promoted' : 'scrap'}">
        Furo CW #${i + 1}: ${h.width}x${h.height}mm (R_max=${h.max_inscribed_radius || 0}mm) —
        ${h.usableHole ? 'Sub-Chapa Part-in-Part' : 'Sucata'}
      </div>
    `).join('');

    card.innerHTML = `
      <div>
        <div class="part-card-header"><span>${esc(part.name)}</span><span class="part-badge">CCW (As > 0)</span></div>
        <div class="part-preview"><canvas width="180" height="110" id="prev_${part.id}"></canvas></div>
        <div class="part-meta">
          <div><strong>Envelope AABB:</strong> ${part.width} x ${part.height} mm</div>
          <div><strong>Área Shoelace:</strong> ${(part.area / 100).toFixed(2)} cm² (R_max=${rMaxOuter}mm)</div>
          ${holesHtml ? `<div class="hole-tag-list">${holesHtml}</div>` : ''}
        </div>
      </div>
      <div class="card-qty-footer">
        <span>Qtd no Lote:</span>
        <div class="qty-stepper">
          <button type="button" class="qty-btn" data-card-act="dec" data-id="${part.id}">−</button>
          <input type="number" id="card_qty_${part.id}" class="qty-number-input" value="${q}" min="0" max="500" />
          <button type="button" class="qty-btn" data-card-act="inc" data-id="${part.id}">+</button>
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
    const mCtx = c.getContext('2d');
    const s = Math.min(150 / part.width, 86 / part.height);
    const ox = (180 - part.width * s) / 2, oy = (110 - part.height * s) / 2;
    const prevRing = (pts) => {
      mCtx.beginPath();
      pts.forEach((pt, i) => {
        const px = ox + pt.x * s, py = oy + (part.height - pt.y) * s; // Y para cima, como no CAD
        if (i === 0) mCtx.moveTo(px, py); else mCtx.lineTo(px, py);
      });
      mCtx.closePath();
    };
    prevRing(part.points);
    mCtx.fillStyle = '#38bdf8'; mCtx.fill(); mCtx.stroke();
    (part.holes || []).forEach(h => {
      prevRing(h.points);
      mCtx.fillStyle = h.usableHole ? '#fde047' : '#f87171';
      mCtx.fill(); mCtx.stroke();
    });
  });
}

// =========================================================
// 5. EXPORTAÇÃO .DXF FINAL MULTI-LAYER (GERADA NO SERVIDOR: R12 UNIVERSAL, SEM ESPELHAMENTO)
// =========================================================

btnExportDxf.addEventListener('click', async () => {
  if (!bestSolutionGlobal) return;
  btnExportDxf.disabled = true;
  try {
    const r = await fetch('/api/export-dxf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        layout: bestSolutionGlobal,
        options: { includeRemnants: exportIncludeRemnantsInput.checked, includeLeadIn: exportIncludeLeadInInput.checked }
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
  refreshHardwareStatus();
  loadSelectedPreset();
});

setTimeout(() => refreshHardwareStatus(), 5000)
