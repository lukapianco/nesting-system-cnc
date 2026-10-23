// server.js
'use strict';

const express = require('express');
const multer = require('multer');
const DxfParser = require('dxf-parser');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Worker } = require('worker_threads');

const { extractContoursFromDxf, buildCustomSheetFromContours, classifyPartsAndHoles } = require('./cadParser');
const { buildJob } = require('./jobBuilder');
const { buildSampleDxf } = require('./presets');
const { buildDxf } = require('./dxfWriter');

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
const uploadCache = new Map();      // uploadId -> { parsed, createdAt }  (evita reenviar contornos a cada job)
const jobsByIp = new Map();
const MAX_JOBS_PER_IP = 3;
const PENDING_TTL_MS = 2 * 60 * 1000;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_UPLOADS = 100;

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of pendingJobs) if (now - j.createdAt > PENDING_TTL_MS) pendingJobs.delete(id);
  for (const [id, u] of uploadCache) if (now - u.createdAt > UPLOAD_TTL_MS) uploadCache.delete(id);
}, 60 * 1000).unref();

function rememberUpload(parsed) {
  if (uploadCache.size >= MAX_CACHED_UPLOADS) uploadCache.delete(uploadCache.keys().next().value);
  const id = `U_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  uploadCache.set(id, { parsed, createdAt: Date.now() });
  return id;
}

function parseDxfBuffer(buffer) {
  // DXF antigos (R12) costumam vir em cp1252; se houver caracteres inválidos em UTF-8, usa latin1
  let text = buffer.toString('utf-8');
  if (text.includes('\uFFFD')) text = buffer.toString('latin1');
  return new DxfParser().parseSync(text);
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
    job.aborted = true;
    if (job.worker) job.worker.terminate();
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

  const worker = new Worker(path.join(__dirname, 'nestingWorker.js'), {
    workerData: {
      parts: job.parts,
      sheet: job.sheet,
      config: job.config,
      hardware: HARDWARE
    }
  });
  job.worker = worker;

  worker.on('message', (msg) => {
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
app.get('/api/hardware', (req, res) => res.json({ ...HARDWARE, activeWorkers, queueSize: jobQueue.length }));

app.post('/api/upload-dxf', upload.single('dxfFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo DXF enviado.' });
    const parsed = parseDxfBuffer(req.file.buffer);
    const tol = Math.max(0.005, Math.min(0.5, Number(req.query.tol) || 0.03));
    const contours = extractContoursFromDxf(parsed, tol);
    const catalogParts = classifyPartsAndHoles(contours, 15);
    res.json({ uploadId: rememberUpload(parsed), contourCount: contours.length, catalogParts, warnings: contours.warnings || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload-sheet-dxf', upload.single('sheetDxfFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo DXF de chapa enviado.' });
    const parsed = parseDxfBuffer(req.file.buffer);
    const tol = Math.max(0.005, Math.min(0.5, Number(req.query.tol) || 0.03));
    const sheet = buildCustomSheetFromContours(extractContoursFromDxf(parsed, tol));
    res.json({ sheet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/start-job', (req, res) => {
  try {
    const { uploadId, sheet = null, config = {}, quantities = {} } = req.body;
    const cached = uploadCache.get(uploadId);
    if (!cached) {
      return res.status(410).json({ error: 'Upload expirado ou desconhecido (o servidor pode ter reiniciado). Envie o .DXF das peças novamente.' });
    }
    const job = buildJob({ parsedDxf: cached.parsed, sheet, config, quantities });
    const jobId = `J_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    pendingJobs.set(jobId, { parts: job.expandedParts, sheet, config: job.normalizedConfig, createdAt: Date.now(), ip: req.ip });
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

  enqueueJob(job, res);
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

// PRESETS DE ENGENHARIA (PEÇAS E CHAPAS IRREGULARES)
app.get('/api/sample-dxf', (req, res) => {
  res.setHeader('Content-Type', 'application/dxf');
  res.send(buildSampleDxf(req.query.preset || 'icamento'));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`Backend CAD/CAM Modular V5 (R-Tree + NFP + BRKGA) ativo em http://localhost:${PORT}`);
});
