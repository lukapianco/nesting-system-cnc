// public/app.js
let currentContours = [];
let catalogParts = [];
let partQuantities = {}; // { PECA_1: 1, PECA_2: 1, ... }
let customSheetDxf = null;
let bestSolutionGlobal = null;
let activeEventSource = null;
let seedCounter = 1;

// Estado de Zoom e Pan do Canvas
let viewZoom = 1;
let viewPanX = 0;
let viewPanY = 0;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let lastRenderTransform = { startX: 0, startY: 0, scale: 1 };

const dxfInput = document.getElementById('dxfInput');
const sheetDxfInput = document.getElementById('sheetDxfInput');
const fileNameLabel = document.getElementById('fileNameLabel');
const sheetFileNameLabel = document.getElementById('sheetFileNameLabel');
const btnClearCustomSheet = document.getElementById('btnClearCustomSheet');
const presetSelect = document.getElementById('presetSelect');
const sheetPresetSelect = document.getElementById('sheetPresetSelect');

const sheetWidthInput = document.getElementById('sheetWidth');
const sheetHeightInput = document.getElementById('sheetHeight');
const kerfInput = document.getElementById('kerfInput');
const minHoleSizeInput = document.getElementById('minHoleSize');
const minRemnantSizeInput = document.getElementById('minRemnantSize');
const iterationsInput = document.getElementById('iterationsInput');
const optimizationGoalSelect = document.getElementById('optimizationGoal');
const allowRotationInput = document.getElementById('allowRotation');
const allowFreeAnglesInput = document.getElementById('allowFreeAngles');
const enableInHoleInput = document.getElementById('enableInHole');
const commonLineInput = document.getElementById('commonLineInput');
const showRemnantsInput = document.getElementById('showRemnants');
const exportIncludeRemnantsInput = document.getElementById('exportIncludeRemnants');

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
      `<strong>CPU:</strong> ${hw.cpuModel} (${hw.totalCores} núcleos)<br>` +
      `<strong>Pool VPS:</strong> Máx ${hw.maxWorkers} Workers simultâneos (Ativos: ${hw.activeWorkers} | Fila: ${hw.queueSize})<br>` +
      `<strong>GPU:</strong> ${hw.gpu.name}`;
  } catch (_) {}
}

// =========================================================
// 1. CONTROLE INTUITIVO DE QUANTIDADES (MULTIPLICADOR DE LOTE)
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
  if (triggerSim) startBackendSseOptimization();
}

function syncQuantityViews() {
  const totalCount = catalogParts.reduce((acc, p) => acc + (partQuantities[p.id] || 0), 0);
  document.getElementById('totalPartsBadge').textContent = `Total: ${totalCount} pçs`;

  // Renderiza a lista rápida na barra lateral
  const sidebarList = document.getElementById('sidebarQtyList');
  sidebarList.innerHTML = '';

  catalogParts.forEach(part => {
    const q = partQuantities[part.id] ?? 1;
    const row = document.createElement('div');
    row.className = 'qty-item-row';
    row.innerHTML = `
      <div class="qty-item-info">
        <span class="qty-item-name">${part.name}</span>
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

  // Atualiza também os inputs nos cards inferiores se já existirem
  catalogParts.forEach(part => {
    const cardInput = document.getElementById(`card_qty_${part.id}`);
    if (cardInput) cardInput.value = partQuantities[part.id] ?? 1;
  });

  // Eventos nos botões da barra lateral
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

// Botões rápidos: Tudo 1x, 2x, 5x, 10x
document.querySelectorAll('.quick-batch-bar .chip-btn[data-mult]').forEach(btn => {
  btn.addEventListener('click', () => {
    const mult = Number(btn.dataset.mult);
    catalogParts.forEach(p => { partQuantities[p.id] = mult; });
    syncQuantityViews();
    startBackendSseOptimization();
  });
});

// Botão "Auto-Lotar Chapa": calcula proporcionalmente quantas peças cabem na chapa atual!
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
  startBackendSseOptimization();
});

// =========================================================
// 2. UPLOAD DE PEÇAS, CHAPAS E PRESETS DE TESTE
// =========================================================

dxfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  fileNameLabel.textContent = file.name;
  const fd = new FormData();
  fd.append('dxfFile', file);
  const res = await fetch('/api/upload-dxf', { method: 'POST', body: fd });
  const data = await res.json();
  currentContours = data.contours || [];
  catalogParts = data.catalogParts || [];
  initDefaultQuantities(catalogParts);
  renderSeparatedParts(catalogParts);
  startBackendSseOptimization();
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
    sheetFileNameLabel.textContent = `Chapa DXF: ${file.name} (${obsCount} furo(s) interno(s))`;
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
    sheetFileNameLabel.textContent = `Chapa Preset: ${val} (${obsCount} furo(s))`;
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

  const fd = new FormData();
  fd.append('dxfFile', file);
  const res = await fetch('/api/upload-dxf', { method: 'POST', body: fd });
  const data = await res.json();
  currentContours = data.contours || [];
  catalogParts = data.catalogParts || [];
  initDefaultQuantities(catalogParts);
  renderSeparatedParts(catalogParts);
  resetZoom();
  startBackendSseOptimization();
}

btnLoadSample.addEventListener('click', loadSelectedPreset);
presetSelect.addEventListener('change', loadSelectedPreset);
btnRecalculate.addEventListener('click', () => {
  seedCounter++;
  startBackendSseOptimization();
});
showRemnantsInput.addEventListener('change', () => {
  if (bestSolutionGlobal) drawSheetNesting(bestSolutionGlobal);
});

// =========================================================
// 3. COMUNICAÇÃO SSE COM WORKER_THREADS NO BACKEND
// =========================================================

async function startBackendSseOptimization() {
  if (!currentContours.length) return;
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  btnRecalculate.disabled = true;
  progressPanel.classList.remove('hidden');
  progressBarFill.style.width = '0%';
  progressPercentText.textContent = '0%';
  progressStatusText.textContent = 'Enviando lote para Worker Thread no Backend...';

  const config = {
    sheetWidth: Number(sheetWidthInput.value),
    sheetHeight: Number(sheetHeightInput.value),
    kerf: Number(kerfInput.value),
    minHoleSize: Number(minHoleSizeInput.value),
    minRemnantSize: Number(minRemnantSizeInput.value),
    totalIterations: Number(iterationsInput.value) || 15000,
    goal: optimizationGoalSelect.value,
    allowRotation: allowRotationInput.checked,
    allowFreeAngles: allowFreeAnglesInput.checked,
    enableInHole: enableInHoleInput.checked,
    commonLine: commonLineInput.checked,
    laserBeamWidth: 0.4,
    seedOffset: seedCounter
  };

  const initRes = await fetch('/api/start-job', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contours: currentContours,
      sheet: customSheetDxf,
      config,
      quantities: partQuantities
    })
  });
  const { jobId, expandedCount } = await initRes.json();

  const es = new EventSource(`/api/stream/${jobId}`);
  activeEventSource = es;

  es.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'queued') {
      progressStatusText.textContent = `Fila VPS: Posição #${msg.position} (${msg.activeWorkers}/${msg.maxWorkers} Workers)...`;
      return;
    }

    if (msg.type === 'progress') {
      const pct = Math.round((msg.iter / msg.totalIterations) * 100);
      progressBarFill.style.width = `${pct}%`;
      progressPercentText.textContent = `${pct}%`;
      progressStatusText.textContent = `Worker Backend: ${msg.iter.toLocaleString()} de ${msg.totalIterations.toLocaleString()} simulações...`;
      progressStrategyText.textContent = `Velocidade: ${msg.calcPerSec.toLocaleString()} cálc/seg | Workers: ${msg.activeWorkers}/${msg.maxWorkers}`;

      if (msg.bestResult) {
        bestSolutionGlobal = msg.bestResult;
        progressBestText.textContent = `Recorde: ${bestSolutionGlobal.compactUtilization}% (${msg.improvements} avanços)`;
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
      progressBarFill.style.width = '100%';
      progressPercentText.textContent = '100%';
      progressStatusText.textContent = `${msg.totalIterations.toLocaleString()} Cálculos Concluídos em ${(msg.totalTimeMs / 1000).toFixed(2)}s!`;
      progressStrategyText.textContent = `Taxa Média: ${msg.calcPerSec.toLocaleString()} cálculos/seg no Worker Thread`;
      progressBestText.textContent = `Campeão Travado: ${bestSolutionGlobal.compactUtilization}%`;

      drawSheetNesting(bestSolutionGlobal, false);
      updateMetrics(expandedCount, bestSolutionGlobal);
      renderArchiveButtons(msg.topArchive || [], bestSolutionGlobal, expandedCount);
    }
  };

  es.onerror = () => {
    es.close();
    btnRecalculate.disabled = false;
  };
}

// =========================================================
// 4. ZOOM, PAN E RENDERIZAÇÃO NO CANVAS 2D
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

  const { startX, startY, scale } = lastRenderTransform;
  const sheetX = (mx - startX) / scale;
  const sheetY = (my - startY) / scale;

  const hitPart = bestSolutionGlobal.placedParts.find(
    p => sheetX >= p.x && sheetX <= p.x + p.placedWidth && sheetY >= p.y && sheetY <= p.y + p.placedHeight
  );
  if (hitPart) {
    hoverInspector.textContent = `${hitPart.name} | Giro: ${hitPart.angle || 0}° | Dim: ${hitPart.placedWidth}x${hitPart.placedHeight}mm | Pos: X=${hitPart.x}mm, Y=${hitPart.y}mm`;
    return;
  }

  const hitRem = (bestSolutionGlobal.remnants || []).find(
    r => sheetX >= r.x && sheetX <= r.x + r.width && sheetY >= r.y && sheetY <= r.y + r.height
  );
  if (hitRem) {
    hoverInspector.textContent = `${hitRem.label} (Sobra Útil) | Dim: ${hitRem.width}x${hitRem.height}mm | Área: ${(hitRem.area / 100).toFixed(1)} cm²`;
    return;
  }

  hoverInspector.textContent = `Cursor na Chapa: X=${Math.round(sheetX)}mm, Y=${Math.round(sheetY)}mm (Zoom: ${Math.round(viewZoom * 100)}%)`;
});

function drawPolygon(context, points, offsetX, offsetY, scale) {
  if (!points || !points.length) return;
  context.beginPath();
  points.forEach((pt, idx) => {
    const px = offsetX + pt.x * scale;
    const py = offsetY + pt.y * scale;
    if (idx === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  });
  context.closePath();
}

function drawSheetNesting(nesting, isHighlight = false) {
  if (!nesting) return;
  const pad = 36;
  const availW = nestingCanvas.width - pad * 2;
  const availH = nestingCanvas.height - pad * 2;
  const baseScale = Math.min(availW / nesting.sheetWidth, availH / nesting.sheetHeight);
  const scale = baseScale * viewZoom;

  const drawW = nesting.sheetWidth * scale;
  const drawH = nesting.sheetHeight * scale;
  const startX = (nestingCanvas.width - drawW) / 2 + viewPanX;
  const startY = (nestingCanvas.height - drawH) / 2 + viewPanY;

  lastRenderTransform = { startX, startY, scale };

  ctx.clearRect(0, 0, nestingCanvas.width, nestingCanvas.height);

  ctx.save();
  if (nesting.sheetPoly && nesting.sheetPoly.length > 0) {
    drawPolygon(ctx, nesting.sheetPoly, startX, startY, scale);
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
    ctx.beginPath(); ctx.moveTo(startX + x * scale, startY); ctx.lineTo(startX + x * scale, startY + drawH); ctx.stroke();
  }
  for (let y = 0; y <= nesting.sheetHeight; y += stepGrid) {
    ctx.beginPath(); ctx.moveTo(startX, startY + y * scale); ctx.lineTo(startX + drawW, startY + y * scale); ctx.stroke();
  }

  // Furos/Obstáculos internos da Chapa Principal
  if (nesting.sheetObstacles && nesting.sheetObstacles.length > 0) {
    nesting.sheetObstacles.forEach((obs) => {
      drawPolygon(ctx, obs.points, startX, startY, scale);
      ctx.fillStyle = '#0f172a';
      ctx.fill();

      ctx.strokeStyle = '#f97316';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      const ocx = startX + (obs.minX + obs.width / 2) * scale;
      const ocy = startY + (obs.minY + obs.height / 2) * scale;
      ctx.fillStyle = '#fdba74';
      ctx.font = 'bold 9.5px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Furo/Recorte da Chapa', ocx, ocy - 2);
      ctx.font = '9px monospace';
      ctx.fillText(`${Math.round(obs.width)}x${Math.round(obs.height)}mm`, ocx, ocy + 9);
      ctx.textAlign = 'left';
    });
  }

  // Retalhos padronizados da chapa
  if (showRemnantsInput.checked && nesting.remnants) {
    nesting.remnants.forEach(rem => {
      const rx = startX + rem.x * scale, ry = startY + rem.y * scale;
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

  // Peças alocadas
  nesting.placedParts.forEach(part => {
    const ox = startX + part.x * scale;
    const oy = startY + part.y * scale;

    drawPolygon(ctx, part.placedPoints, ox, oy, scale);
    ctx.fillStyle = part.nestedInsideHole ? 'rgba(52, 211, 153, 0.95)' : 'rgba(56, 189, 248, 0.92)';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    (part.placedHoles || []).forEach(hole => {
      drawPolygon(ctx, hole.placedPoints, ox, oy, scale);
      ctx.fillStyle = hole.usableHole ? '#fde047' : '#f87171';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    });

    const pw = part.placedWidth * scale;
    const ph = part.placedHeight * scale;
    if (pw > 26 && ph > 16) {
      const cx = ox + pw / 2;
      const cy = oy + ph / 2;
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 9.5px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`${part.name}${part.angle ? ` (${part.angle}°)` : ''}`, cx, cy - 1);
      if (ph > 28) {
        ctx.font = '8.5px monospace';
        ctx.fillText(`${Math.round(part.placedWidth)}x${Math.round(part.placedHeight)}`, cx, cy + 9);
      }
      ctx.textAlign = 'left';
    }
  });
  ctx.restore();

  // Contorno externo da chapa
  ctx.strokeStyle = isHighlight ? '#34d399' : '#94a3b8';
  ctx.lineWidth = isHighlight ? 3.5 : 2;
  if (nesting.sheetPoly && nesting.sheetPoly.length > 0) {
    drawPolygon(ctx, nesting.sheetPoly, startX, startY, scale);
    ctx.stroke();
  } else {
    ctx.strokeRect(startX, startY, drawW, drawH);
  }
}

function updateMetrics(totalExpandedCount, nesting) {
  document.getElementById('kpiUtilization').textContent = `${nesting.compactUtilization}%`;
  document.getElementById('kpiRawRatio').textContent =
    `Bruto na chapa líquida: ${nesting.rawUtilization}% | Estratégia: ${nesting.heuristic} (${nesting.gravityMode})`;
  document.getElementById('metricSheetArea').textContent = `${(nesting.sheetArea / 100).toFixed(1)} cm²`;
  document.getElementById('metricUsedArea').textContent = `${(nesting.usedArea / 100).toFixed(1)} cm²`;
  document.getElementById('metricPlacedCount').textContent = `${nesting.placedParts.length} / ${totalExpandedCount}`;
  document.getElementById('metricRemnantArea').textContent =
    `${(nesting.remnantArea / 100).toFixed(1)} cm² (${nesting.remnants.length} retalhos)`;
  document.getElementById('metricInHoleParts').textContent = nesting.inHoleCount || 0;
  document.getElementById('metricFreeSlugs').textContent = `${nesting.freeHoleSlugsCount || 0} (Custo Zero)`;

  const obsCount = (nesting.sheetObstacles || []).length;
  document.getElementById('sheetSpecText').textContent =
    `Chapa: ${nesting.sheetWidth}x${nesting.sheetHeight}mm ${nesting.sheetPoly ? `(DXF Customizado c/ ${obsCount} furo(s)/recorte(s) interno(s))` : ''}`;

  const alertBox = document.getElementById('unplacedAlert');
  if (nesting.unplacedParts && nesting.unplacedParts.length > 0) {
    alertBox.classList.remove('hidden');
    alertBox.textContent = `Atenção: ${nesting.unplacedParts.length} peça(s) do lote não couberam na área líquida disponível da chapa.`;
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
    const isAct =
      Math.abs(sol.compactUtilization - active.compactUtilization) < 0.01 &&
      Math.abs(sol.largestRemnantArea - active.largestRemnantArea) < 5;
    b.className = `candidate-chip ${isAct ? 'active' : ''}`;
    b.textContent = `Opção #${i + 1}: ${sol.compactUtilization}% (Maior Retalho: ${sol.largestRemnantDim})`;
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
    const card = document.createElement('div');
    card.className = 'part-card';
    const holesHtml = (part.holes || []).map((h, i) => `
      <div class="hole-tag ${h.usableHole ? 'promoted' : 'scrap'}">
        Furo #${i + 1}: ${h.width}x${h.height}mm —
        ${h.usableHole ? 'Sub-Chapa In-Hole / Miolo Útil' : 'Descarte'}
      </div>
    `).join('');

    card.innerHTML = `
      <div>
        <div class="part-card-header"><span>${part.name}</span><span class="part-badge">DXF Original</span></div>
        <div class="part-preview"><canvas width="180" height="110" id="prev_${part.id}"></canvas></div>
        <div class="part-meta">
          <div><strong>Dimensões:</strong> ${part.width} x ${part.height} mm</div>
          <div><strong>Área Poligonal:</strong> ${(part.area / 100).toFixed(2)} cm²</div>
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
    drawPolygon(mCtx, part.points, ox, oy, s);
    mCtx.fillStyle = '#38bdf8'; mCtx.fill(); mCtx.stroke();
    (part.holes || []).forEach(h => {
      drawPolygon(mCtx, h.points, ox, oy, s);
      mCtx.fillStyle = h.usableHole ? '#fde047' : '#f87171';
      mCtx.fill(); mCtx.stroke();
    });
  });
}

// 5. EXPORTAÇÃO .DXF FINAL
function buildLwPoly(pts, layer, color) {
  const v = pts.map(p => `10\n${(+p.x).toFixed(3)}\n20\n${(+p.y).toFixed(3)}`).join('\n');
  return `0\nLWPOLYLINE\n8\n${layer}\n62\n${color}\n90\n${pts.length}\n70\n1\n${v}`;
}

btnExportDxf.addEventListener('click', () => {
  if (!bestSolutionGlobal) return;
  const n = bestSolutionGlobal;
  const H = n.sheetHeight;
  const toCad = (pts, ox, oy) => pts.map(p => ({ x: ox + p.x, y: H - (oy + p.y) }));
  const ents = [];

  const sheetPts = n.sheetPoly || [{ x: 0, y: 0 }, { x: n.sheetWidth, y: 0 }, { x: n.sheetWidth, y: H }, { x: 0, y: H }];
  ents.push(buildLwPoly(toCad(sheetPts, 0, 0), '0_CHAPA_LIMITE', 7));

  if (n.sheetObstacles && n.sheetObstacles.length > 0) {
    n.sheetObstacles.forEach(obs => {
      ents.push(buildLwPoly(toCad(obs.points, 0, 0), '0_CHAPA_FUROS_OBSTACULOS', 30));
    });
  }

  n.placedParts.forEach(p => {
    ents.push(buildLwPoly(toCad(p.placedPoints, p.x, p.y), p.nestedInsideHole ? '1_PECA_IN_HOLE' : '1_CORTE_PECAS', p.nestedInsideHole ? 3 : 5));
    (p.placedHoles || []).forEach(h => {
      ents.push(buildLwPoly(toCad(h.placedPoints, p.x, p.y), '2_CORTE_FUROS', h.usableHole ? 2 : 1));
    });
  });

  if (exportIncludeRemnantsInput.checked && n.remnants) {
    n.remnants.forEach(r => {
      ents.push(buildLwPoly(toCad([{ x: 0, y: 0 }, { x: r.width, y: 0 }, { x: r.width, y: r.height }, { x: 0, y: r.height }], r.x, r.y), '3_RETALHOS_UTEIS', 6));
    });
  }

  const dxf = `0\nSECTION\n2\nENTITIES\n${ents.join('\n')}\n0\nENDSEC\n0\nEOF`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([dxf], { type: 'application/dxf' }));
  a.download = `nesting_final_${n.sheetWidth}x${n.sheetHeight}.dxf`;
  a.click();
});

window.addEventListener('DOMContentLoaded', () => {
  refreshHardwareStatus();
  loadSelectedPreset();
});