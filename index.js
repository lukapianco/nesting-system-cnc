// server.js
'use strict';

const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Worker } = require('worker_threads');

const { parseDxf, extractContoursFromDxf, buildCustomSheetFromContours, buildCatalogFromDxf } = require('./cadParser');
const { normalizeNestingParams } = require('./typesAndInterfaces');
const { buildJob } = require('./jobBuilder');
const { buildSampleDxf } = require('./presets');
const { buildDxf, buildRemnantsDxf } = require('./dxfWriter');
const { findSparrowBinary } = require('./engine/sparrowBridge');
const { recommendParams, listProcesses } = require('./processProfiles');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '35mb' }));

// =========================================================
// 1. INSPETOR DE HARDWARE (CPU CORES & GPU)
// =========================================================
function detectHardware() {
  const cpus = os.cpus() || [];
  const totalCores = cpus.length || 2;
  const maxWorkers = Math.max(1, totalCores - 1);
  let gpu = { detected: false, name: 'Ausente (Modo CPU Int64/R-Tree Worker Threads Ativo)' };

  try {
    const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }).toString().trim();
    if (out) gpu = { detected: true, name: out.split('\n')[0] };
  } catch (_) {}

  return {
    cpuModel: cpus[0] ? cpus[0].model.trim() : 'CPU Server',
    totalCores,
    maxWorkers,
    gpu
  };
}

const HARDWARE = detectHardware();
let activeWorkers = 0;
const jobQueue = [];
const pendingJobs = new Map();      // jobId -> { ..., createdAt }
const liveJobs = new Map();         // jobId -> job (na fila ou rodando): permite "Parar e manter o melhor"
const uploadCache = new Map();      // uploadId -> { parsed, createdAt }  (evita reenviar contornos a cada job)
const jobsByIp = new Map();
// processos do otimizador externo por job: terminar o worker NÃO encerra o processo filho (ele foi criado dentro do
// worker); o servidor encerra explicitamente quando o job é cancelado, trocado ou termina
const childProcesses = new Map();   // pid -> jobId
/** Cancela o job: o worker com otimizador externo encerra o processo filho e sai sozinho; o motor clássico (laço
 *  síncrono) não lê mensagens, então o worker é terminado depois de um curto prazo de qualquer jeito. */
function cancelWorker(job) {
  const w = job.worker;
  if (!w) return;
  if (job.childPids && job.childPids.size) {
    try { w.postMessage({ type: 'cancel' }); } catch (_) { /* já saiu */ }
    setTimeout(() => { w.terminate(); killJobChildren(job); }, 1500).unref();
  } else {
    w.terminate();
  }
}

function killJobChildren(job) {
  for (const pid of job.childPids || []) {
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* já terminou */ }
    childProcesses.delete(pid);
  }
  if (job.childPids) job.childPids.clear();
}
const MAX_JOBS_PER_IP = 3;
const PENDING_TTL_MS = 2 * 60 * 1000;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_UPLOADS = 100;

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of pendingJobs) if (now - j.createdAt > PENDING_TTL_MS) pendingJobs.delete(id);
  for (const [id, u] of uploadCache) if (now - u.createdAt > UPLOAD_TTL_MS) uploadCache.delete(id);
}, 60 * 1000).unref();

function rememberUpload(parsed, fileName = '') {
  if (uploadCache.size >= MAX_CACHED_UPLOADS) uploadCache.delete(uploadCache.keys().next().value);
  const id = `U_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  uploadCache.set(id, { parsed, fileName, createdAt: Date.now() });
  return id;
}

function parseDxfBuffer(buffer) {
  // Leitor próprio: detecta DWG/binário, codificação (UTF-8 ou code page do $DWGCODEPAGE) e unidades.
  return parseDxf(buffer);
}

/** Erros de leitura de DXF são do arquivo do usuário (422), não do servidor (500). */
function sendError(res, e, fallbackStatus = 500) {
  const status = e && e.name === 'DxfReadError' ? 422 : fallbackStatus;
  res.status(status).json({ error: e.message, code: e.code || undefined });
}

function parseImportOptions(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

/** Monta a resposta de catálogo (upload e reanálise) a partir do DXF lido. */
function catalogResponse(uploadId, parsed, tol, importOptions, configRaw) {
  const config = normalizeNestingParams({ ...(configRaw || {}), chordal_tolerance: tol });
  const { catalogParts, report, frames, warnings, drawnSheet } = buildCatalogFromDxf(parsed, config, importOptions);
  const suggestedSheet = frames.length
    ? { width: frames[0].width, height: frames[0].height, source: frames[0].id, labels: frames[0].labels }
    : null;
  return { uploadId, contourCount: report.summary.closedContours, catalogParts, warnings, report, frames: report.frames, suggestedSheet, sheetCandidates: report.sheetCandidates || [], drawnSheet };
}

// =========================================================
// 2. POOL DE WORKER_THREADS COM FILA FIFO
// =========================================================
function enqueueJob(job, res) {
  job.res = res;
  job.aborted = false;

  // Heartbeat: proxies (nginx/Cloudflare) derrubam SSE ocioso, principalmente enquanto o job está na fila
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

  res.on('close', () => {
    clearInterval(heartbeat);
    if (job.jobId) liveJobs.delete(job.jobId);
    job.aborted = true;
    cancelWorker(job);
    if (job.ip) jobsByIp.set(job.ip, Math.max(0, (jobsByIp.get(job.ip) || 1) - 1));
  });

  if (activeWorkers < HARDWARE.maxWorkers) {
    runWorker(job);
  } else {
    jobQueue.push(job);
    res.write(`data: ${JSON.stringify({
      type: 'queued',
      position: jobQueue.length,
      activeWorkers,
      maxWorkers: HARDWARE.maxWorkers
    })}\n\n`);
  }
}

function runWorker(job) {
  if (job.aborted) return checkQueue();
  activeWorkers++;

  job.stopFlag = new SharedArrayBuffer(4);
  if (job.stopRequested) Atomics.store(new Int32Array(job.stopFlag), 0, 1);
  const worker = new Worker(path.join(__dirname, 'nestingWorker.js'), {
    workerData: {
      parts: job.parts,
      sheet: job.sheet,
      config: job.config,
      hardware: HARDWARE,
      stopFlag: job.stopFlag
    }
  });
  job.worker = worker;

  worker.on('message', (msg) => {
    if (msg.type === 'child') { // pid do otimizador externo (interno: não vai para a tela)
      (job.childPids = job.childPids || new Set()).add(msg.pid);
      childProcesses.set(msg.pid, job.jobId);
      if (job.aborted) cancelWorker(job);
      return;
    }
    if (msg.type === 'child-exit') { if (job.childPids) job.childPids.delete(msg.pid); childProcesses.delete(msg.pid); return; }
    if (!job.aborted) {
      job.res.write(`data: ${JSON.stringify({
        ...msg,
        activeWorkers,
        maxWorkers: HARDWARE.maxWorkers,
        queueSize: jobQueue.length
      })}\n\n`);
      if (msg.type === 'done' || msg.type === 'error') job.res.end();
    }
  });

  worker.on('error', (err) => {
    if (!job.aborted) {
      job.res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      job.res.end();
    }
  });

  worker.on('exit', () => {
    killJobChildren(job);
    if (job.jobId) liveJobs.delete(job.jobId);
    activeWorkers = Math.max(0, activeWorkers - 1);
    checkQueue();
  });
}

function checkQueue() {
  while (jobQueue.length > 0 && activeWorkers < HARDWARE.maxWorkers) {
    const next = jobQueue.shift();
    if (!next.aborted) runWorker(next);
  }
}

// =========================================================
// 3. ROTAS HTTP + STREAM SSE
// =========================================================
// Uso de CPU medido aqui (diferença dos tempos de os.cpus() a cada segundo): o painel da tela mostra o servidor
// trabalhando de verdade, não só a configuração.
let cpuSample = { at: Date.now(), times: os.cpus().map(c => ({ ...c.times })) };
let cpuUsage = { total: 0, perCore: [] };
setInterval(() => {
  const now = os.cpus().map(c => ({ ...c.times }));
  const per = now.map((t, i) => {
    const p = cpuSample.times[i] || t;
    const busy = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.irq - p.irq);
    const all = busy + (t.idle - p.idle);
    return all > 0 ? Math.round((busy / all) * 100) : 0;
  });
  cpuUsage = { total: per.length ? Math.round(per.reduce((s, v) => s + v, 0) / per.length) : 0, perCore: per };
  cpuSample = { at: Date.now(), times: now };
}, 1000).unref();

app.get('/api/hardware', (req, res) => res.json({
  ...HARDWARE, activeWorkers, queueSize: jobQueue.length,
  // otimizador externo (ADR 006): instalado = o motor Automático usa o sparrow quando ele se aplica
  externalOptimizer: { name: 'prumo-sparrow', installed: !!findSparrowBinary(), running: childProcesses.size },
  usage: {
    cpuPct: cpuUsage.total,
    cpuPerCore: cpuUsage.perCore,
    memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    memTotalGb: +(os.totalmem() / 2 ** 30).toFixed(1),
    serverRssMb: Math.round(process.memoryUsage().rss / 2 ** 20),
    load1: +os.loadavg()[0].toFixed(2),
    jobsRunning: activeWorkers,
    jobsQueued: jobQueue.length,
    at: Date.now()
  }
}));

app.post('/api/upload-dxf', upload.single('dxfFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo DXF enviado.' });
    const parsed = parseDxfBuffer(req.file.buffer);
    const tol = Math.max(0.005, Math.min(0.5, Number(req.query.tol) || 0.03));
    const importOptions = parseImportOptions(req.body && req.body.importOptions);
    const uploadId = rememberUpload(parsed, req.file.originalname);
    res.json({ ...catalogResponse(uploadId, parsed, tol, importOptions, null), fileName: req.file.originalname });
  } catch (e) {
    sendError(res, e);
  }
});

// Reanalisa um upload em cache com outras opções de importação (layers, unidade, moldura, costura)
app.post('/api/reanalyze-dxf', (req, res) => {
  try {
    const { uploadId, importOptions = {}, tol, config = {} } = req.body || {};
    const cached = uploadCache.get(uploadId);
    if (!cached) return res.status(410).json({ error: 'Upload expirado ou desconhecido. Envie o .DXF das peças novamente.' });
    const t = Math.max(0.005, Math.min(0.5, Number(tol) || 0.03));
    res.json({ ...catalogResponse(uploadId, cached.parsed, t, importOptions, config), fileName: cached.fileName });
  } catch (e) {
    sendError(res, e, 400);
  }
});

app.post('/api/upload-sheet-dxf', upload.single('sheetDxfFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo DXF de chapa enviado.' });
    const parsed = parseDxfBuffer(req.file.buffer);
    const tol = Math.max(0.005, Math.min(0.5, Number(req.query.tol) || 0.03));
    // Na chapa, o retângulo externo É a chapa: sem detecção de moldura.
    const contours = extractContoursFromDxf(parsed, tol, { frameMode: 'part' });
    const sheet = buildCustomSheetFromContours(contours);
    res.json({ sheet, report: contours.report });
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/start-job', (req, res) => {
  try {
    const { uploadId, sheet = null, config = {}, quantities = {}, importOptions = {} } = req.body;
    const cached = uploadCache.get(uploadId);
    if (!cached) {
      return res.status(410).json({ error: 'Upload expirado ou desconhecido (o servidor pode ter reiniciado). Envie o .DXF das peças novamente.' });
    }
    const job = buildJob({ parsedDxf: cached.parsed, sheet, config, quantities, importOptions });
    const jobId = `J_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    pendingJobs.set(jobId, { jobId, parts: job.expandedParts, sheet: job.sheet, config: job.normalizedConfig, createdAt: Date.now(), ip: req.ip });
    res.json({ jobId, catalogParts: job.catalogParts, expandedCount: job.expandedParts.length, normalizedConfig: job.normalizedConfig, warnings: job.warnings });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/stream/:jobId', (req, res) => {
  const job = pendingJobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  pendingJobs.delete(req.params.jobId);

  if ((jobsByIp.get(job.ip) || 0) >= MAX_JOBS_PER_IP) {
    return res.status(429).json({ error: 'Limite de jobs simultâneos por cliente atingido.' });
  }
  jobsByIp.set(job.ip, (jobsByIp.get(job.ip) || 0) + 1);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  liveJobs.set(job.jobId, job);
  enqueueJob(job, res);
});

// "Parar e manter o melhor": encerra a busca; o worker finaliza (retalhos, CAM, validação) e envia o melhor layout
app.post('/api/stop/:jobId', (req, res) => {
  const job = liveJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado (já terminou?).' });
  job.stopRequested = true;
  if (job.stopFlag) {
    Atomics.store(new Int32Array(job.stopFlag), 0, 1);
    return res.json({ stopping: true });
  }
  // ainda na fila: sai da fila sem resultado
  const qi = jobQueue.indexOf(job);
  if (qi >= 0) jobQueue.splice(qi, 1);
  job.aborted = true;
  if (!job.res.writableEnded) {
    job.res.write(`data: ${JSON.stringify({ type: 'error', error: 'Cancelado pelo usuário antes de começar.' })}\n\n`);
    job.res.end();
  }
  liveJobs.delete(job.jobId);
  res.json({ cancelled: true });
});

app.get('/api/process-profiles', (req, res) => res.json({ processes: listProcesses() }));

app.get('/api/recommend-params', (req, res) => {
  try {
    res.json(recommendParams(String(req.query.process || ''), Number(req.query.thickness), { toolDiameter: Number(req.query.toolDiameter) }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Exportação DXF gerada no servidor (testável; R12 universal, sem espelhamento, em ordem de corte)
app.post('/api/export-dxf', (req, res) => {
  try {
    const { layout, options = {} } = req.body;
    if (!layout || !Array.isArray(layout.placedParts)) return res.status(400).json({ error: 'Layout inválido.' });
    if (layout.validation && layout.validation.ok === false) {
      return res.status(422).json({ error: 'Layout reprovado na validação independente; exportação bloqueada.', validation: layout.validation });
    }
    const dxf = buildDxf(layout, options);
    res.setHeader('Content-Type', 'application/dxf; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="nesting_cam_${Math.round(layout.sheetWidth)}x${Math.round(layout.sheetHeight)}.dxf"`);
    res.send(dxf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DXF só dos retalhos úteis (para estoque/rastreio de sobras): cada retalho vira um contorno fechado + texto
app.post('/api/export-remnants-dxf', (req, res) => {
  try {
    const { layout, options = {} } = req.body;
    if (!layout || !Array.isArray(layout.remnants)) return res.status(400).json({ error: 'Layout inválido.' });
    if (layout.validation && layout.validation.ok === false) {
      return res.status(422).json({ error: 'Layout reprovado na validação independente; exportação bloqueada.', validation: layout.validation });
    }
    if (!layout.remnants.length) return res.status(422).json({ error: 'Este layout não tem retalhos úteis (acima do Retalho Mín.).' });
    res.setHeader('Content-Type', 'application/dxf; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="retalhos_${Math.round(layout.sheetWidth)}x${Math.round(layout.sheetHeight)}.dxf"`);
    res.send(buildRemnantsDxf(layout, options));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PRESETS DE ENGENHARIA (PEÇAS E CHAPAS IRREGULARES)
app.get('/api/sample-dxf', (req, res) => {
  res.setHeader('Content-Type', 'application/dxf');
  res.send(buildSampleDxf(req.query.preset || 'icamento'));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Prumo (motor de nesting) ativo em http://localhost:${PORT}`);
});
