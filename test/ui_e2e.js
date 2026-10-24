// test/ui_e2e.js — interface real no Chromium (Playwright): npm run test:ui
// Requer Playwright com Chromium (npm i -D playwright && npx playwright install chromium). Se ausente, é ignorado.
'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
let chromium;
try { ({ chromium } = require('playwright')); } catch (_) { console.log('  - playwright ausente: teste de interface ignorado'); process.exit(0); }

(async () => {
  const express = require('express');
  const origListen = express.application.listen;
  let server;
  express.application.listen = function () { server = origListen.call(this, 0, () => {}); return server; };
  require('../index.js');
  express.application.listen = origListen;
  await new Promise(r => (server.listening ? r() : server.once('listening', r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const FIX = (n) => path.join(__dirname, 'fixtures', n);

  let browser;
  try { browser = await chromium.launch(); } catch (e) { console.log('  - Chromium indisponível: teste de interface ignorado'); server.close(); process.exit(0); }
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/status of 422/.test(m.text())) errors.push(m.text()); });

  let ok = 0;
  const check = async (name, fn) => { try { await fn(); ok++; console.log(`  ✔ ${name}`); } catch (e) { console.log(`  ✖ ${name}: ${e.message}`); process.exitCode = 1; } };
  const text = (sel) => page.$eval(sel, el => el.textContent);
  const stopIfRunning = async () => { if (await page.isVisible('#btnStopKeepBest')) await page.click('#btnStopKeepBest'); };

  await page.goto(base + '/');
  await page.waitForTimeout(1000);

  console.log('\n[UI] Modelo 1 (blocos aninhados + moldura)');
  await page.setInputFiles('#dxfInput', FIX('Modelo_1_c_moldura.dxf'));
  await page.waitForFunction(() => document.querySelector('#dxfReportFile').textContent.includes('Modelo_1'), null, { timeout: 30000 });
  await check('diagnóstico aparece e o arquivo é lido', async () => assert.strictEqual(await text('#dxfReportStatus'), 'lido'));
  await check('moldura detectada e chapa ajustada para 2000 × 1200', async () => {
    assert(/2000 × 1200/.test(await text('#dxfFrameBanner')));
    assert.strictEqual(await page.inputValue('#sheetWidth'), '2000');
    assert.strictEqual(await page.inputValue('#sheetHeight'), '1200');
  });
  await check('3 peças diferentes com as quantidades do desenho (8, 8, 6)', async () => {
    const vals = await page.$$eval('#sidebarQtyList .qty-number-input', els => els.map(e => e.value));
    assert.deepStrictEqual(vals, ['8', '8', '6']);
  });
  await page.waitForSelector('#btnStopKeepBest:not(.hidden)', { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.click('#btnStopKeepBest');
  await page.waitForFunction(() => /parado pelo usuário/.test(document.querySelector('#progressStatusText').textContent), null, { timeout: 60000 });
  await check('"Parar e manter o melhor" entrega layout validado e exportável', async () => {
    assert(/APROVADO/.test(await text('#metricValidation')));
    assert(!(await page.isDisabled('#btnExportDxf')));
  });
  await check('motor usado aparece na tela (sparrow instalado → "Otimizador sparrow"; senão, aviso de não instalado)', async () => {
    const hw = await (await fetch(base + '/api/hardware')).json();
    if (hw.externalOptimizer && hw.externalOptimizer.installed) assert(/Otimizador sparrow/.test(await text('#progressStatusText')), await text('#progressStatusText'));
    else assert(/não instalado/.test(await text('#engineStatus')), await text('#engineStatus'));
  });
  // camadas das entidades do DXF baixado (código de grupo 8 depois de ENTITIES)
  const entityLayers = (txt) => {
    const L = txt.split(/\r?\n/), s = L.findIndex((l, i) => l.trim() === 'ENTITIES' && L[i - 1].trim() === '2');
    const set = new Set();
    for (let i = s + 1; i < L.length - 1; i += 2) if (L[i].trim() === '8') set.add(L[i + 1].trim());
    return [...set].sort();
  };
  const download = async (sel) => {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(sel)]);
    return fs.readFileSync(await d.path(), 'utf8');
  };
  await check('exportação padrão só tem camadas de corte; "Incluir chapa" acrescenta 0_CHAPA_LIMITE', async () => {
    const def = entityLayers(await download('#btnExportDxf'));
    assert(def.length > 0 && def.every(l => /^(1_CORTE_PECAS|1_PECA_IN_HOLE|2_CORTE_FUROS)$/.test(l)), 'padrão: ' + def.join(','));
    await page.check('#exportIncludeSheet');
    const withSheet = entityLayers(await download('#btnExportDxf'));
    await page.uncheck('#exportIncludeSheet');
    assert(withSheet.includes('0_CHAPA_LIMITE'), 'com chapa: ' + withSheet.join(','));
  });
  await page.click('#dxfFrameBanner [data-frame-act="part"]');
  await page.waitForFunction(() => document.querySelectorAll('.part-card').length === 1, null, { timeout: 30000 });
  await check('"Tratar como peça" reanalisa: 1 peça (a moldura) com 22 furos', async () => {
    const holes = await page.$$eval('.part-card .hole-tag', els => els.length);
    assert.strictEqual(holes, 22);
  });
  await stopIfRunning();
  await page.waitForTimeout(1500);

  console.log('\n[UI] Modelo 2 (splines em matriz)');
  await page.click('#dxfOptions summary');
  await page.selectOption('#dxfFrameModeSelect', 'auto');
  await page.waitForTimeout(800);
  await stopIfRunning();
  await page.setInputFiles('#dxfInput', FIX('Modelo_2_c_moldura.dxf'));
  await page.waitForFunction(() => document.querySelector('#dxfReportFile').textContent.includes('Modelo_2'), null, { timeout: 60000 });
  await check('1 peça × 87 e chapa 3000 × 1200', async () => {
    const vals = await page.$$eval('#sidebarQtyList .qty-number-input', els => els.map(e => e.value));
    assert.deepStrictEqual(vals, ['87']);
    assert.strictEqual(await page.inputValue('#sheetWidth'), '3000');
  });
  await check('bloco não usado com rótulo "87 Gomos" é citado no diagnóstico', async () => assert(/87 Gomos/.test(await text('#dxfReportItems'))));
  await stopIfRunning();
  await page.waitForTimeout(3000);

  console.log('\n[UI] arquivo errado');
  const fake = path.join(os.tmpdir(), `prumo_fake_${process.pid}.dxf`);
  fs.writeFileSync(fake, Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(300, 0)]));
  await page.setInputFiles('#dxfInput', fake);
  await page.waitForFunction(() => document.querySelector('#dxfReportStatus').textContent === 'não lido', null, { timeout: 20000 });
  await check('DWG enviado como DXF mostra instrução clara', async () => assert(/DWG/.test(await text('#dxfReportItems'))));
  fs.unlinkSync(fake);

  await check('sem erros de JavaScript na página', async () => assert.strictEqual(errors.length, 0, errors.slice(0, 3).join(' | ')));
  console.log(`\n${ok} verificações de interface aprovadas`);
  await browser.close();
  server.close();
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('ERRO', e); process.exit(1); });
