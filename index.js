// server.js
'use strict';

const express = require('express');
const multer = require('multer');
const DxfParser = require('dxf-parser');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Worker } = require('worker_threads');

const { normalizeNestingParams } = require('./typesAndInterfaces');
const {
  extractContoursFromDxf,
  classifyPartsAndHoles,
  buildCustomSheetFromContours
} = require('./cadParser');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

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
const pendingJobs = new Map();

// =========================================================
// 2. POOL DE WORKER_THREADS COM FILA FIFO
// =========================================================
function enqueueJob(job, res) {
  job.res = res;
  job.aborted = false;

  res.on('close', () => {
    job.aborted = true;
    if (job.worker) job.worker.terminate();
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

function expandPartsByQuantities(catalogParts, quantitiesMap = {}) {
  const expanded = [];
  for (const part of catalogParts) {
    const qty = Math.max(0, Math.min(500, Number(quantitiesMap[part.id] ?? 1)));
    for (let c = 1; c <= qty; c++) {
      const instanceId = qty > 1 ? `${part.id}_COPY_${c}` : part.id;
      const instanceName = qty > 1 ? `${part.name} (${c}/${qty})` : part.name;
      expanded.push({
        ...part,
        basePartId: part.id,
        id: instanceId,
        name: instanceName,
        copyIndex: c,
        totalCopies: qty,
        holes: (part.holes || []).map((h, hIdx) => ({
          ...h,
          id: `${h.id}_C${c}_${hIdx}`
        }))
      });
    }
  }
  return expanded;
}

// =========================================================
// 3. ROTAS HTTP + STREAM SSE
// =========================================================
app.get('/api/hardware', (req, res) => res.json({ ...HARDWARE, activeWorkers, queueSize: jobQueue.length }));

app.post('/api/upload-dxf', upload.single('dxfFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo DXF enviado.' });
    const parser = new DxfParser();
    const parsed = parser.parseSync(req.file.buffer.toString('utf-8'));
    const contours = extractContoursFromDxf(parsed, 0.03);
    const catalogParts = classifyPartsAndHoles(contours, 15);
    res.json({ contours, catalogParts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload-sheet-dxf', upload.single('sheetDxfFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo DXF de chapa enviado.' });
    const parser = new DxfParser();
    const parsed = parser.parseSync(req.file.buffer.toString('utf-8'));
    const contours = extractContoursFromDxf(parsed, 0.03);
    const sheet = buildCustomSheetFromContours(contours);
    res.json({ sheet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/start-job', (req, res) => {
  try {
    const { contours = [], sheet = null, config = {}, quantities = {} } = req.body;
    const normalizedConfig = normalizeNestingParams(config);
    const catalogParts = classifyPartsAndHoles(contours, normalizedConfig.min_hole_size, normalizedConfig);
    const expandedParts = expandPartsByQuantities(catalogParts, quantities);
    const jobId = `J_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    pendingJobs.set(jobId, { parts: expandedParts, sheet, config: normalizedConfig });
    res.json({ jobId, catalogParts, expandedCount: expandedParts.length, normalizedConfig });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/stream/:jobId', (req, res) => {
  const job = pendingJobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  pendingJobs.delete(req.params.jobId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  enqueueJob(job, res);
});

// PRESETS DE ENGENHARIA (PEÇAS E CHAPAS IRREGULARES)
app.get('/api/sample-dxf', (req, res) => {
  const preset = req.query.preset || 'icamento';
  const poly = (pts) => `0\nLWPOLYLINE\n8\n0\n90\n${pts.length}\n70\n1\n` + pts.map(([x, y]) => `10\n${x}\n20\n${y}`).join('\n');
  const rect = (x, y, w, h) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  const circle = (cx, cy, r) => `0\nCIRCLE\n8\n0\n10\n${cx}\n20\n${cy}\n40\n${r}`;

  let entities = [];
  if (preset === 'sheet_stepped') {
    entities = [
      poly([[0, 0], [1200, 0], [1200, 340], [880, 340], [880, 800], [0, 800]]),
      rect(460, 380, 160, 130),
      circle(1040, 170, 45)
    ];
  } else if (preset === 'sheet_ramp_hole') {
    entities = [
      poly([[420, 0], [2012, 0], [1980, 691], [0, 560]]),
      circle(1190, 360, 176.5)
    ];
  } else if (preset === 'sheet_tooth_slot') {
    entities = [
      poly([[0, 0], [450, 0], [722, 240], [722, 438], [0, 438]]),
      rect(10, 8, 12, 180)
    ];
  } else if (preset === 'icamento') {
    entities = [
      poly([[0, 0], [58, 0], [76.66, 12], [76.66, 28], [58, 40], [0, 40]]),
      circle(52, 20, 12.5),
      poly([[90, 0], [148, 0], [166.66, 12], [166.66, 28], [148, 40], [90, 40]]),
      circle(142, 20, 12.5),
      rect(0, 55, 14, 14),
      rect(25, 55, 14, 14)
    ];
  } else if (preset === 'trueshape') {
    entities = [
      rect(0, 0, 420, 320), rect(80, 70, 260, 180),
      poly([[450, 0], [750, 0], [750, 110], [560, 110], [560, 300], [450, 300]]),
      poly([[780, 0], [1080, 0], [1080, 300], [970, 300], [970, 110], [780, 110]]),
      rect(0, 360, 220, 140),
      rect(260, 360, 190, 140),
      rect(480, 360, 160, 120)
    ];
  } else {
    entities = [
      rect(0, 0, 450, 320), rect(125, 90, 200, 140), circle(50, 50, 15), circle(400, 270, 15),
      rect(500, 0, 340, 340), circle(670, 170, 85),
      rect(0, 400, 520, 160), rect(190, 445, 120, 70),
      rect(600, 400, 260, 220),
      rect(900, 0, 170, 115),
      rect(900, 180, 210, 110)
    ];
  }

  const dxfString = `0\nSECTION\n2\nENTITIES\n${entities.join('\n')}\n0\nENDSEC\n0\nEOF`;
  res.setHeader('Content-Type', 'application/dxf');
  res.send(dxfString);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Backend CAD/CAM Modular V5 (R-Tree + NFP + BRKGA) ativo em http://localhost:${PORT}`);
});