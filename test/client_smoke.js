// test/client_smoke.js — carrega public/index.html + app.js (jsdom) contra o servidor real.
// Requer: npm i -D jsdom   (se ausente, o teste é ignorado)
'use strict';
const assert = require('assert');
let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = require('jsdom')); } catch (_) { console.log('  - jsdom ausente: teste de cliente ignorado'); process.exit(0); }
const fs = require('fs');
const path = require('path');

(async () => {
  const express = require('express');
  const origListen = express.application.listen;
  let server;
  express.application.listen = function () { server = origListen.call(this, 0, () => {}); return server; };
  require('../index.js');
  express.application.listen = origListen;
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(String(e.detail || e.message || e)));
  vc.on('error', e => errors.push(String(e)));

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace('<script src="app.js"></script>', '');
  const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;

  // polyfills mínimos: canvas (no-op), fetch absoluto, FormData/File do Node e EventSource via fetch streaming
  const noop = new Proxy(function () {}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : noop), apply: () => noop, set: () => true });
  w.HTMLCanvasElement.prototype.getContext = () => noop;
  w.fetch = (u, o) => fetch(new URL(u, base), o);
  w.FormData = FormData; w.File = File; w.Blob = Blob;
  w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
  let esCreated = 0, esOpen = 0, esDone = 0;
  w.EventSource = class {
    constructor(url) {
      esCreated++; esOpen++; this.closed = false;
      (async () => {
        const res = await fetch(new URL(url, base));
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
        while (!this.closed) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            if (chunk.startsWith('data: ') && this.onmessage && !this.closed) { if (chunk.includes('"type":"done"')) esDone++; this.onmessage({ data: chunk.slice(6) }); }
          }
        }
        if (!this.closed && this.onerror) this.onerror();
      })().catch(() => this.onerror && this.onerror());
    }
    close() { if (!this.closed) { this.closed = true; esOpen--; } }
  };
  w.setInterval = () => 0; // evita timers de hardware pendurados
  const doc = w.document;
  doc.getElementById('iterationsInput').value = '200';

  w.eval(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8') + '\n;window.__start = startBackendSseOptimization;');
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));

  const waitFor = async (cond, ms = 60000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 100)); } };

  let ok = 0; const check = (name, fn) => { try { fn(); ok++; console.log(`  ✔ ${name}`); } catch (e) { console.log(`  ✖ ${name}: ${e.message}`); process.exitCode = 1; } };

  // 1) fluxo normal: preset carrega, job roda, validação aparece
  await waitFor(() => /APROVADO|REPROVADO/.test(doc.getElementById('metricValidation').textContent));
  check('preset carrega, job conclui e a validação aparece como APROVADO', () => assert(/APROVADO/.test(doc.getElementById('metricValidation').textContent)));
  check('KPIs de CAM preenchidos (pierces e G00)', () => { assert(/\d+ \(/.test(doc.getElementById('metricPierces').textContent)); assert(/m \/ /.test(doc.getElementById('metricRapid').textContent)); });
  check('botão Exportar habilitado só ao final', () => assert(!doc.getElementById('btnExportDxf').disabled));

  // 2) corrida: duas execuções disparadas em sequência => só UM stream pode existir (antes: dois, e elites misturadas)
  const before = esCreated;
  w.__start(); w.__start();
  check('histórico de elites é limpo ao iniciar nova execução', () => assert(doc.getElementById('candidatesList').children.length === 0 && doc.getElementById('candidatesBar').classList.contains('hidden')));
  await waitFor(() => /APROVADO|REPROVADO/.test(doc.getElementById('metricValidation').textContent) && !doc.getElementById('btnRecalculate').disabled);
  check('duas chamadas seguidas criam apenas 1 EventSource (sem streams duplicados)', () => assert.strictEqual(esCreated - before, 1, `criados ${esCreated - before}`));
  check('nenhum EventSource fica aberto ao final', () => assert.strictEqual(esOpen, 0, `abertos ${esOpen}`));

  check('sem erros de JavaScript no cliente', () => assert.strictEqual(errors.length, 0, errors.slice(0, 3).join(' | ')));
  console.log(`\n${ok} verificações do cliente aprovadas`);
  server.close(); process.exit(process.exitCode || 0);
})().catch(e => { console.error('ERRO', e); process.exit(1); });
