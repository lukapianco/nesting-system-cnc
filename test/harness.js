// test/harness.js — executa jobs reais (parser -> worker) sem HTTP
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { buildSampleDxf } = require('../presets');
const { buildJob } = require('../jobBuilder');
const { parseDxf, extractContoursFromDxf, buildCustomSheetFromContours } = require('../cadParser');

function parsePreset(name) {
  return parseDxf(buildSampleDxf(name));
}

function parseText(dxfText) {
  return parseDxf(dxfText);
}

function sheetFromPreset(name, tol = 0.03) {
  return buildCustomSheetFromContours(extractContoursFromDxf(parsePreset(name), tol, { frameMode: 'part' }));
}

/** @returns {Promise<{done:Object, records:number, job:Object, ms:number}>} */
/** qty multiplica as cópias encontradas no desenho (x1 = o desenho como está). */
function runPreset({ parts = 'icamento', dxfText = null, sheet = null, config = {}, qty = 1, importOptions = {} }) {
  const parsed = dxfText ? parseText(dxfText) : parsePreset(parts);
  const probe = buildJob({ parsedDxf: parsed, config, quantities: {}, importOptions });
  const quantities = {};
  probe.catalogParts.forEach(p => { quantities[p.id] = (typeof qty === 'function' ? qty(p) : qty) * (p.quantity_detected || 1); });
  const sheetObj = sheet ? sheetFromPreset(sheet) : null;
  const job = buildJob({ parsedDxf: parsed, sheet: sheetObj, config, quantities, importOptions });

  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let records = 0;
    const w = new Worker(path.join(__dirname, '..', 'nestingWorker.js'), {
      workerData: { parts: job.expandedParts, sheet: job.sheet, config: job.normalizedConfig, hardware: {} }
    });
    w.on('message', (m) => {
      if (m.type === 'progress' && m.isNewRecord) records++;
      if (m.type === 'done') { resolve({ done: m, records, job, ms: Date.now() - t0 }); w.terminate(); }
    });
    w.on('error', reject);
  });
}

module.exports = { runPreset, parsePreset, parseText, sheetFromPreset };
