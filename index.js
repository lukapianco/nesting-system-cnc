// server.js
const express = require('express');
const multer = require('multer');
const DxfParser = require('dxf-parser');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { Worker } = require('worker_threads');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '25mb' }));

// =========================================================
// 1. DETECÇÃO DE HARDWARE (CPU CORES & GPU)
// =========================================================
function detectHardware() {
  const cpus = os.cpus() || [];
  const totalCores = cpus.length || 2;
  const maxWorkers = Math.max(1, totalCores - 1);
  let gpu = { detected: false, name: 'Ausente (Modo CPU Float64 Worker Threads Ativo)' };

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
// 2. POOL DE WORKER_THREADS COM FILA PARA ESCALABILIDADE NA VPS
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

// =========================================================
// 3. GEOMETRIA E PARSER DXF (PEÇAS E CHAPAS CUSTOMIZADAS)
// =========================================================
function getBoundingBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const width = +(maxX - minX).toFixed(2);
  const height = +(maxY - minY).toFixed(2);
  return { minX, minY, maxX, maxY, width, height, area: +(width * height).toFixed(2) };
}

function calcPolygonArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return Math.abs(a / 2);
}

function isPointInPolygon(pt, vs) {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y, xj = vs[j].x, yj = vs[j].y;
    const intersect = ((yi > pt.y) !== (yj > pt.y)) &&
      (pt.x < (xj - xi) * (pt.y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function stitchLinesToPolygons(lines, tol = 0.5) {
  const segs = lines.map(l => ({
    p1: { x: l.vertices[0].x, y: l.vertices[0].y },
    p2: { x: l.vertices[1].x, y: l.vertices[1].y },
    used: false
  }));
  const polys = [];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  for (let i = 0; i < segs.length; i++) {
    if (segs[i].used) continue;
    segs[i].used = true;
    const poly = [segs[i].p1, segs[i].p2];
    let closed = false, found = true;
    while (found && !closed) {
      found = false;
      const tail = poly[poly.length - 1];
      for (let j = 0; j < segs.length; j++) {
        if (segs[j].used) continue;
        if (dist(tail, segs[j].p1) <= tol) {
          segs[j].used = true; poly.push(segs[j].p2); found = true; break;
        } else if (dist(tail, segs[j].p2) <= tol) {
          segs[j].used = true; poly.push(segs[j].p1); found = true; break;
        }
      }
      if (poly.length >= 3 && dist(poly[0], poly[poly.length - 1]) <= tol) closed = true;
    }
    if (poly.length >= 3) polys.push(poly);
  }
  return polys;
}

function extractContoursFromDxf(dxf) {
  const contours = [];
  const looseLines = [];
  (dxf.entities || []).forEach((ent, idx) => {
    if ((ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') && ent.vertices && ent.vertices.length >= 3) {
      const pts = ent.vertices.map(v => ({ x: v.x, y: v.y }));
      const bbox = getBoundingBox(pts);
      contours.push({ id: `C_${idx}`, points: pts, bbox, trueArea: +(calcPolygonArea(pts)).toFixed(2) || bbox.area });
    } else if (ent.type === 'CIRCLE' && ent.center && ent.radius) {
      const pts = [];
      for (let i = 0; i < 32; i++) {
        const ang = (i / 32) * Math.PI * 2;
        pts.push({ x: ent.center.x + Math.cos(ang) * ent.radius, y: ent.center.y + Math.sin(ang) * ent.radius });
      }
      const bbox = getBoundingBox(pts);
      contours.push({ id: `C_${idx}`, points: pts, bbox, trueArea: +(Math.PI * ent.radius ** 2).toFixed(2) });
    } else if (ent.type === 'LINE' && ent.vertices && ent.vertices.length === 2) {
      looseLines.push(ent);
    }
  });

  if (looseLines.length > 0) {
    stitchLinesToPolygons(looseLines).forEach((pts, idx) => {
      const bbox = getBoundingBox(pts);
      contours.push({ id: `ST_${idx}`, points: pts, bbox, trueArea: +(calcPolygonArea(pts)).toFixed(2) || bbox.area });
    });
  }
  return contours.filter(c => c.bbox.width > 0.5 && c.bbox.height > 0.5);
}

// Classifica peças e furos sem duplicar furos como peças externas
function classifyPartsAndHoles(rawContours, minHoleSize) {
  const sorted = [...rawContours].sort((a, b) => b.bbox.area - a.bbox.area);
  const parentsMap = new Map();

  for (let i = 0; i < sorted.length; i++) {
    parentsMap.set(sorted[i].id, []);
    for (let j = 0; j < i; j++) {
      const p = sorted[j], c = sorted[i];
      if (
        c.bbox.minX > p.bbox.minX && c.bbox.maxX < p.bbox.maxX &&
        c.bbox.minY > p.bbox.minY && c.bbox.maxY < p.bbox.maxY &&
        isPointInPolygon(c.points[0], p.points)
      ) {
        parentsMap.get(c.id).push(p.id);
      }
    }
  }

  const parts = [];
  const holeToParent = new Map();

  sorted.forEach(c => {
    const anc = parentsMap.get(c.id) || [];
    if (anc.length % 2 === 0) {
      const normPts = c.points.map(p => ({ x: +(p.x - c.bbox.minX).toFixed(2), y: +(p.y - c.bbox.minY).toFixed(2) }));
      parts.push({
        id: `PECA_${parts.length + 1}`,
        name: `Peça #${parts.length + 1}`,
        sourceContourId: c.id,
        width: c.bbox.width,
        height: c.bbox.height,
        bboxArea: c.bbox.area,
        area: c.trueArea,
        origMinX: c.bbox.minX,
        origMinY: c.bbox.minY,
        points: normPts,
        holes: []
      });
    } else {
      holeToParent.set(c.id, anc[anc.length - 1]);
    }
  });

  sorted.forEach(c => {
    if (!holeToParent.has(c.id)) return;
    const parentPart = parts.find(p => p.sourceContourId === holeToParent.get(c.id));
    if (!parentPart) return;

    const meetsMin = c.bbox.width >= minHoleSize && c.bbox.height >= minHoleSize;
    const relPts = c.points.map(p => ({
      x: +(p.x - parentPart.origMinX).toFixed(2),
      y: +(p.y - parentPart.origMinY).toFixed(2)
    }));
    const hb = getBoundingBox(relPts);

    parentPart.holes.push({
      id: `FURO_${parentPart.holes.length + 1}_${parentPart.id}`,
      width: c.bbox.width,
      height: c.bbox.height,
      area: c.trueArea,
      relX: hb.minX,
      relY: hb.minY,
      usableHole: meetsMin,
      points: relPts
    });
  });

  return parts;
}

// CORREÇÃO 1: Identifica o contorno externo da Chapa e mapeia TODOS os furos/obstáculos internos da Chapa
function buildCustomSheetFromContours(contours) {
  if (!contours || !contours.length) {
    throw new Error('DXF da chapa sem contorno fechado.');
  }

  const sorted = [...contours].sort((a, b) => b.bbox.area - a.bbox.area);
  const outer = sorted[0];

  const normPts = outer.points.map(p => ({
    x: +(p.x - outer.bbox.minX).toFixed(2),
    y: +(p.y - outer.bbox.minY).toFixed(2)
  }));

  // Filtra todos os contornos internos contidos dentro do polígono externo da chapa (furos/defeitos/recortes internos)
  const rawObstacles = sorted.slice(1).filter(c => {
    const bboxInside =
      c.bbox.minX >= outer.bbox.minX &&
      c.bbox.maxX <= outer.bbox.maxX &&
      c.bbox.minY >= outer.bbox.minY &&
      c.bbox.maxY <= outer.bbox.maxY;
    return bboxInside && isPointInPolygon(c.points[0], outer.points);
  });

  const normObstacles = rawObstacles.map((obs, idx) => {
    const pts = obs.points.map(p => ({
      x: +(p.x - outer.bbox.minX).toFixed(2),
      y: +(p.y - outer.bbox.minY).toFixed(2)
    }));
    const obBbox = getBoundingBox(pts);
    return {
      id: `OBS_CHAPA_${idx + 1}`,
      name: `Furo/Recorte da Chapa #${idx + 1}`,
      minX: obBbox.minX,
      minY: obBbox.minY,
      maxX: obBbox.maxX,
      maxY: obBbox.maxY,
      width: obBbox.width,
      height: obBbox.height,
      area: obs.trueArea,
      points: pts
    };
  });

  const obstaclesAreaSum = normObstacles.reduce((acc, o) => acc + o.area, 0);
  const netArea = Math.max(1, +(outer.trueArea - obstaclesAreaSum).toFixed(2));

  return {
    isCustomDxf: true,
    width: outer.bbox.width,
    height: outer.bbox.height,
    area: netArea,
    points: normPts,
    obstacles: normObstacles
  };
}

// =========================================================
// 4. ROTAS HTTP + STREAM SSE
// =========================================================
app.get('/api/hardware', (req, res) => res.json({ ...HARDWARE, activeWorkers, queueSize: jobQueue.length }));

app.post('/api/upload-dxf', upload.single('dxfFile'), (req, res) => {
  try {
    const parser = new DxfParser();
    const contours = extractContoursFromDxf(parser.parseSync(req.file.buffer.toString('utf-8')));
    res.json({ contours });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/upload-sheet-dxf', upload.single('sheetDxfFile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo DXF de chapa enviado.' });
    const parser = new DxfParser();
    const contours = extractContoursFromDxf(parser.parseSync(req.file.buffer.toString('utf-8')));
    const sheet = buildCustomSheetFromContours(contours);
    res.json({ sheet });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/start-job', (req, res) => {
  const { contours = [], sheet = null, config = {} } = req.body;
  const parts = classifyPartsAndHoles(contours, Number(config.minHoleSize || 20));
  const jobId = `J_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  pendingJobs.set(jobId, { parts, sheet, config });
  res.json({ jobId, parts });
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

// GERADOR DE EXEMPLOS (COM FURO/OBSTÁCULO INTERNO NA CHAPA EM DEGRAU)
app.get('/api/sample-dxf', (req, res) => {
  const preset = req.query.preset || 'icamento';
  const poly = (pts) => `0\nLWPOLYLINE\n8\n0\n90\n${pts.length}\n70\n1\n` + pts.map(([x, y]) => `10\n${x}\n20\n${y}`).join('\n');
  const rect = (x, y, w, h) => poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
  const circle = (cx, cy, r) => `0\nCIRCLE\n8\n0\n10\n${cx}\n20\n${cy}\n40\n${r}`;

  let entities = [];
  if (preset === 'sheet_stepped') {
    // Chapa em formato de Degrau ("L") + 2 Furos/Obstáculos Internos da própria chapa para teste visual de desvio!
    entities = [
      poly([[0, 0], [1200, 0], [1200, 340], [880, 340], [880, 800], [0, 800]]),
      rect(460, 380, 160, 130), // Obstáculo #1: Recorte retangular interno (160x130mm) no meio da chapa
      circle(1040, 170, 45)     // Obstáculo #2: Furo circular interno (D=90mm) na aba direita da chapa
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

app.listen(3000, () => console.log(`Servidor Multi-Thread SSE rodando em http://localhost:3000`));