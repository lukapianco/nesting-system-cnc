// test/harness.js — executa jobs reais (parser -> worker) sem HTTP
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const DxfParser = require('dxf-parser');
const { buildSampleDxf } = require('../presets');
const { buildJob } = require('../jobBuilder');
const { extractContoursFromDxf, buildCustomSheetFromContours } = require('../cadParser');

function parsePreset(name) {
  return new DxfParser().parseSync(buildSampleDxf(name));
}

function parseText(dxfText) {
  return new DxfParser().parseSync(dxfText);
}

function sheetFromPreset(name, tol = 0.03) {
  return buildCustomSheetFromContours(extractContoursFromDxf(parsePreset(name), tol));
}

/** @returns {Promise<{done:Object, records:number, job:Object, ms:number}>} */
function runPreset({ parts = 'icamento', dxfText = null, sheet = null, config = {}, qty = 1 }) {
  const parsed = dxfText ? parseText(dxfText) : parsePreset(parts);
  const probe = buildJob({ parsedDxf: parsed, config, quantities: {} });
  const quantities = {};
  probe.catalogParts.forEach(p => { quantities[p.id] = typeof qty === 'function' ? qty(p) : qty; });
  const sheetObj = sheet ? sheetFromPreset(sheet) : null;
  const job = buildJob({ parsedDxf: parsed, sheet: sheetObj, config, quantities });

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
