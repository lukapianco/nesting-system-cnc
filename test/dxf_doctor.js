// test/dxf_doctor.js — leitura robusta de DXF (DXF Doctor): node test/dxf_doctor.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('./dxfSynth');
const { readDxf } = require('../dxf/reader');
const { pathPoints } = require('../dxf/curves');
const { flattenDxf } = require('../dxf/flatten');
const { parseDxf, extractContoursFromDxf, buildCatalogFromDxf } = require('../cadParser');
const { normalizeNestingParams } = require('../typesAndInterfaces');
const { pointToRingDist, computeSignedArea } = require('../geometry/primitives');
const { runPreset } = require('./harness');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✖ ${name}\n      ${String(e.stack || e.message).split('\n').slice(0, 4).join('\n      ')}`); }
}

const TOL = 0.03;
const cfg = (o = {}) => normalizeNestingParams({ chordal_tolerance: TOL, min_hole_size: 10, ...o });
const contoursOf = (text, opt = {}) => extractContoursFromDxf(parseDxf(text), TOL, opt);
const catalogOf = (text, opt = {}, c = {}) => buildCatalogFromDxf(parseDxf(text), cfg(c), opt);
const codes = (report) => report.items.map(i => i.code);
const near = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg}: ${a} != ${b} (±${eps})`);
const FIX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n));

/** Flecha real: amostras densas da curva exata devem estar a <= tol do contorno discretizado. */
function maxDeviation(samples, ring) {
  let mx = 0;
  for (const p of samples) mx = Math.max(mx, pointToRingDist(p.x, p.y, ring));
  return mx;
}

(async () => {
  console.log('\n[LEITOR] arquivos ruins dão erro claro, não exceção genérica');
  await test('DWG enviado por engano → erro DWG com instrução', () => {
    const buf = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(200, 0)]);
    assert.throws(() => readDxf(buf), e => e.name === 'DxfReadError' && e.code === 'DWG' && /DXF/.test(e.message));
  });
  await test('DXF binário → erro BINARY_DXF', () => {
    const buf = Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00', 'latin1'), Buffer.alloc(50, 0)]);
    assert.throws(() => readDxf(buf), e => e.code === 'BINARY_DXF');
  });
  await test('vazio, PDF e texto qualquer → erros EMPTY / NOT_DXF / BAD_GROUP_CODE', () => {
    assert.throws(() => readDxf(Buffer.alloc(0)), e => e.code === 'EMPTY');
    assert.throws(() => readDxf(Buffer.from('%PDF-1.7 ...')), e => e.code === 'NOT_DXF');
    assert.throws(() => readDxf('olá, isto não é dxf\nlinha 2\n'), e => e.code === 'BAD_GROUP_CODE' && /linha 1/.test(e.message));
  });
  await test('code page 1252 (layer "Peças"), escape \\U+00E7, vírgula decimal, quebras CR, sem EOF', () => {
    const txt = S.buildDxf({
      layers: [{ name: 'Peças' }, { name: 'Pe\\U+00E7as2' }],
      entities: [S.rect(0, 0, 100, 50, 'Peças'), S.rect(200, 0, 100, 50, 'Pe\\U+00E7as2'),
        S.ent('LINE', 'Peças', [[10, '1,5'], [20, 0], [11, '9,5'], [21, 0]])],
      insunits: 4, eof: false
    });
    const doc = readDxf(Buffer.from(txt.replace(/\n/g, '\r'), 'latin1'));
    assert(doc.layers.has('Peças') && doc.layers.has('Peças2'), [...doc.layers.keys()].join(','));
    const ln = doc.entities.find(e => e.type === 'LINE');
    near(ln.p1.x, 1.5, 1e-12, 'vírgula decimal');
    assert(doc.warnings.some(w => w.code === 'DECIMAL_COMMA'));
    assert(doc.warnings.some(w => w.code === 'NO_EOF'));
  });

  console.log('\n[BLOCOS] INSERT aninhado, espelhado, girado, MINSERT, OCS');
  const Lshape = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 40], [0, 40]];
  await test('INSERT aninhado (2 níveis) com ponto base, rotação 90° e escala -1 cai na posição exata', () => {
    const txt = S.buildDxf({
      insunits: 4,
      blocks: {
        L: { entities: [S.lwpoly(Lshape)] },
        PAR: { base: [5, 5], entities: [S.insert('L', 5, 5), S.insert('L', 105, 5, { sx: -1 })] }
      },
      entities: [S.insert('PAR', 1000, 500, { rot: 90 })]
    });
    const c = contoursOf(txt);
    assert.strictEqual(c.length, 2, `contornos: ${c.length}`);
    const byY = [...c].sort((a, b) => a.bbox.minY - b.bbox.minY);
    near(byY[0].bbox.minX, 960, 1e-6, 'L1 minX'); near(byY[0].bbox.maxX, 1000, 1e-6, 'L1 maxX');
    near(byY[0].bbox.minY, 500, 1e-6, 'L1 minY'); near(byY[0].bbox.maxY, 530, 1e-6, 'L1 maxY');
    near(byY[1].bbox.minX, 960, 1e-6, 'L2 minX'); near(byY[1].bbox.minY, 570, 1e-6, 'L2 minY'); near(byY[1].bbox.maxY, 600, 1e-6, 'L2 maxY');
    // vértice específico: (30,0) do L1 -> (1000,530)
    assert(c.some(r => r.points.some(p => Math.hypot(p.x - 1000, p.y - 530) < 1e-6)), 'vértice transformado ausente');
    const cat = catalogOf(txt);
    assert.strictEqual(cat.catalogParts.length, 2, 'espelho não pode ser agrupado com o original');
    assert(cat.catalogParts.some(p => p.mirrorOf), 'espelho deveria ser apontado');
    assert(codes(cat.report).includes('MIRRORED_PARTS'));
  });
  await test('MINSERT 3×2 vira 1 peça × 6 com as posições de cada cópia', () => {
    const txt = S.buildDxf({ insunits: 4, blocks: { SQ: { entities: [S.lwpoly(Lshape)] } },
      entities: [S.insert('SQ', 0, 0, { cols: 3, rows: 2, dx: 50, dy: 60 })] });
    const cat = catalogOf(txt);
    assert.strictEqual(cat.catalogParts.length, 1);
    const p = cat.catalogParts[0];
    assert.strictEqual(p.quantity_detected, 6);
    const xs = [...new Set(p.instances.map(i => i.x))].sort((a, b) => a - b), ys = [...new Set(p.instances.map(i => i.y))].sort((a, b) => a - b);
    assert.deepStrictEqual(xs, [0, 50, 100]); assert.deepStrictEqual(ys, [0, 60]);
    assert.strictEqual(p.name, 'SQ', 'nome deve vir do bloco');
  });
  await test('OCS com extrusão (0,0,-1): CIRCLE e ARC espelhados no X saem no lugar certo', () => {
    const ext = { extrusion: [0, 0, -1] };
    const txt = S.buildDxf({ insunits: 4, entities: [
      S.circle(30, 40, 10, '0', ext),
      S.arc(0, 0, 10, 270, 90, '0', ext), S.line(0, -10, 0, 10) // meio disco à ESQUERDA no mundo
    ] });
    const c = contoursOf(txt);
    assert.strictEqual(c.length, 2, `contornos ${c.length}`);
    const circ = c.find(r => r.bbox.minY > 20);
    near((circ.bbox.minX + circ.bbox.maxX) / 2, -30, TOL, 'centro X do círculo (polígono inscrito: até 1 flecha)');
    const half = c.find(r => r !== circ);
    near(half.bbox.minX, -10, 0.05, 'meio disco minX'); near(half.bbox.maxX, 0, 1e-6, 'meio disco maxX');
    near(half.trueArea, Math.PI * 100 / 2, (2 / 3) * TOL * Math.PI * 10 + 1e-6, 'área do meio disco');
  });
  await test('bloco recursivo, bloco inexistente e XREF são relatados (sem travar)', () => {
    const txt = S.buildDxf({ insunits: 4, blocks: { A: { entities: [S.insert('A', 1, 1), S.rect(0, 0, 10, 10)] } },
      entities: [S.insert('A', 0, 0), S.insert('NAO_EXISTE', 0, 0)] });
    const c = contoursOf(txt);
    assert(codes(c.report).includes('RECURSIVE_BLOCK') && codes(c.report).includes('MISSING_BLOCK'), codes(c.report).join(','));
    assert.strictEqual(c.length, 1);
  });

  console.log('\n[CURVAS] ELLIPSE, SPLINE (controle e ajuste), bulge, POLYLINE antiga — flecha garantida');
  await test('ELLIPSE girada: área e flecha <= tolerância', () => {
    const txt = S.buildDxf({ insunits: 4, entities: [S.ellipse(100, 100, 30, 40, 0.5)] });
    const c = contoursOf(txt);
    assert.strictEqual(c.length, 1);
    near(c[0].trueArea, Math.PI * 50 * 25, 10, 'área');
    const ux = 30, uy = 40, vx = -40 * 0.5, vy = 30 * 0.5;
    const samples = Array.from({ length: 2000 }, (_, i) => { const t = (i / 2000) * 2 * Math.PI; return { x: 100 + ux * Math.cos(t) + vx * Math.sin(t), y: 100 + uy * Math.cos(t) + vy * Math.sin(t) }; });
    const dev = maxDeviation(samples, c[0].points);
    assert(dev <= TOL + 1e-6, `flecha ${dev.toFixed(4)} > ${TOL}`);
  });
  await test('SPLINE cúbica em S simétrico (bug antigo: achatava) respeita a flecha', () => {
    const P = [[0, 0], [50, 60], [50, -60], [100, 0]];
    const txt = S.buildDxf({ insunits: 4, entities: [
      S.spline({ ctrl: P, knots: [0, 0, 0, 0, 1, 1, 1, 1] }), S.lwpoly([[100, 0], [100, -80], [0, -80], [0, 0]], false)] });
    const c = contoursOf(txt);
    assert.strictEqual(c.length, 1, `contornos ${c.length}`);
    const bern = (t) => { const b = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3]; return { x: b.reduce((s, w, i) => s + w * P[i][0], 0), y: b.reduce((s, w, i) => s + w * P[i][1], 0) }; };
    const dev = maxDeviation(Array.from({ length: 1001 }, (_, i) => bern(i / 1000)), c[0].points);
    assert(dev <= TOL + 1e-6, `flecha ${dev.toFixed(4)}`);
  });
  await test('SPLINE só com pontos de ajuste passa pelos pontos (e avisa)', () => {
    const fit = [[0, 0], [25, 20], [50, 0], [75, -20], [100, 0]];
    const txt = S.buildDxf({ insunits: 4, entities: [S.spline({ fit }), S.lwpoly([[100, 0], [100, -80], [0, -80], [0, 0]], false)] });
    const c = contoursOf(txt);
    assert.strictEqual(c.length, 1);
    for (const [x, y] of fit) assert(pointToRingDist(x, y, c[0].points) < 1e-6, `não passa por (${x},${y})`);
    assert(codes(c.report).includes('FIT_SPLINE'));
  });
  await test('LWPOLYLINE com bulge e POLYLINE antiga (VERTEX/SEQEND) com bulge', () => {
    // retângulo 100x40 com lados curtos em semicírculo (oblongo): área = 60*40 + π*20²
    const ob = [[20, 0, 0], [80, 0, 1], [80, 40, 0], [20, 40, 1]];
    const txt = S.buildDxf({ insunits: 4, entities: [S.lwpoly(ob), S.polyline2d(ob.map(([x, y, b]) => [x + 200, y, b]))] });
    const c = contoursOf(txt);
    assert.strictEqual(c.length, 2);
    // polígono inscrito perde ~(2/3)·flecha·comprimento do arco de área
    for (const r of c) near(r.trueArea, 60 * 40 + Math.PI * 400, (2 / 3) * TOL * 2 * Math.PI * 20 * 1.05, 'área do oblongo');
  });

  console.log('\n[UNIDADES]');
  await test('$INSUNITS = polegada converte para mm; arquivo sem unidade avisa; unidade escolhida pelo usuário prevalece', () => {
    const inch = contoursOf(S.buildDxf({ insunits: 1, entities: [S.rect(0, 0, 2, 1)] }));
    near(inch[0].bbox.width, 50.8, 1e-9, 'largura'); near(inch[0].bbox.height, 25.4, 1e-9, 'altura');
    const none = contoursOf(S.buildDxf({ insunits: null, measurement: 0, entities: [S.rect(0, 0, 10, 5)] }));
    const w = none.report.items.find(i => i.code === 'UNITLESS');
    assert(w && w.severity === 'alto', 'sem unidade + imperial deve ser alerta alto');
    const cm = contoursOf(S.buildDxf({ insunits: null, entities: [S.rect(0, 0, 10, 5)] }), { units: 'cm' });
    near(cm[0].bbox.width, 100, 1e-9, 'cm→mm');
    assert(/centímetro/.test(cm.report.file.units));
  });

  console.log('\n[LAYERS] congeladas, desligadas, não plotáveis, Defpoints, tracejadas');
  await test('só a geometria de corte visível entra; opções incluem o resto; exclusão manual funciona', () => {
    const spec = {
      insunits: 4,
      linetypes: [{ name: 'CENTER', dashed: true }],
      layers: [{ name: 'CORTE' }, { name: 'AUX', frozen: true }, { name: 'DESL', off: true }, { name: 'NAOPLOT', plot: false },
        { name: 'Defpoints' }, { name: 'EIXO', linetype: 'CENTER' }],
      entities: [S.rect(0, 0, 50, 50, 'CORTE'), S.rect(100, 0, 50, 50, 'AUX'), S.rect(200, 0, 50, 50, 'DESL'), S.rect(300, 0, 50, 50, 'NAOPLOT'),
        S.rect(400, 0, 50, 50, 'Defpoints'), S.rect(500, 0, 50, 50, 'EIXO'), S.rect(600, 0, 50, 50, 'CORTE', { linetype: 'HIDDEN' }),
        S.rect(700, 0, 50, 50, 'CORTE', { paperSpace: true })]
    };
    const txt = S.buildDxf(spec);
    const c = contoursOf(txt);
    assert.strictEqual(c.length, 1, `entrou: ${c.map(x => x.layers.join('/')).join(', ')}`);
    assert(['HIDDEN_LAYERS', 'DASHED_EXCLUDED'].every(k => codes(c.report).includes(k)), codes(c.report).join(','));
    assert(readDxf(txt).warnings.some(w => w.code === 'PAPER_SPACE'));
    assert.strictEqual(contoursOf(txt, { includeHiddenLayers: true, includeDashed: true }).length, 7);
    const none = contoursOf(txt, { excludeLayers: ['CORTE'] });
    assert.strictEqual(none.length, 0);
    assert(codes(none.report).includes('NO_CONTOURS') && none.report.ok === false);
    const L = c.report.layers.find(l => l.name === 'AUX');
    assert(L && L.frozen && L.excludedBecause.includes('layer congelada'));
  });

  console.log('\n[COSTURA] contornos abertos, gaps, duplicatas');
  const rectLines = (gap) => [S.line(0, 0, 100 - gap, 0), S.line(100, 0, 100, 50 - gap), S.line(100, 50, gap, 50), S.line(0, 50, 0, gap)];
  await test('gap de 0,1 mm fecha em silêncio; 0,6 mm fecha e é relatado; 3 mm fica aberto (alerta alto)', () => {
    const a = contoursOf(S.buildDxf({ insunits: 4, entities: rectLines(0.1) }));
    assert.strictEqual(a.length, 1); assert(!codes(a.report).includes('GAPS_HEALED'));
    const b = contoursOf(S.buildDxf({ insunits: 4, entities: rectLines(0.6) }));
    assert.strictEqual(b.length, 1); assert(codes(b.report).includes('GAPS_HEALED'));
    const gi = b.report.items.find(i => i.code === 'GAPS_HEALED');
    assert(gi.where.length === 4 && gi.where.every(g => g.gap > 0.5 && g.gap < 0.7), JSON.stringify(gi.where));
    const c = contoursOf(S.buildDxf({ insunits: 4, entities: rectLines(3) }));
    assert.strictEqual(c.length, 0);
    const oc = c.report.items.find(i => i.code === 'OPEN_CONTOURS');
    assert(oc && oc.severity === 'alto');
    assert.strictEqual(contoursOf(S.buildDxf({ insunits: 4, entities: rectLines(0.6) }), { maxGapHeal: 0 }).length, 0, 'maxGapHeal=0 desliga o fechamento');
  });
  await test('linhas duplicadas e contorno colado duas vezes não geram corte duplo', () => {
    const a = contoursOf(S.buildDxf({ insunits: 4, entities: [...rectLines(0), ...rectLines(0)] }));
    assert.strictEqual(a.length, 1); assert(codes(a.report).includes('DUPLICATES'));
    const b = contoursOf(S.buildDxf({ insunits: 4, entities: [S.rect(0, 0, 80, 40), S.rect(0, 0, 80, 40)] }));
    assert.strictEqual(b.length, 1);
  });
  await test('contorno feito de 2 polilinhas abertas (como a moldura do Modelo 2) e de LINE + ARC é costurado', () => {
    const a = contoursOf(S.buildDxf({ insunits: 4, entities: [S.lwpoly([[100, 0], [0, 0], [0, 50], [100, 50]], false), S.lwpoly([[100, 50], [200, 50], [200, 0], [100, 0]], false)] }));
    assert.strictEqual(a.length, 1); near(a[0].trueArea, 200 * 50, 1e-6, 'área');
    const b = contoursOf(S.buildDxf({ insunits: 4, entities: [S.line(0, 0, 60, 0), S.arc(60, 20, 20, 270, 90), S.line(60, 40, 0, 40), S.line(0, 40, 0, 0)] }));
    assert.strictEqual(b.length, 1); near(b[0].trueArea, 60 * 40 + Math.PI * 200, (2 / 3) * TOL * Math.PI * 20 * 1.05, 'área');
  });
  await test('contorno que cruza a si mesmo é apontado (com e sem área líquida)', () => {
    const cat = catalogOf(S.buildDxf({ insunits: 4, entities: [S.lwpoly([[0, 0], [100, 100], [100, 0], [0, 60]])] }));
    assert(codes(cat.report).includes('SELF_INTERSECTION') && codes(cat.report).includes('SELF_INTERSECTING_PARTS'), codes(cat.report).join(','));
    const eight = catalogOf(S.buildDxf({ insunits: 4, entities: [S.lwpoly([[0, 0], [100, 100], [100, 0], [0, 100]])] }));
    assert(codes(eight.report).includes('SELF_INTERSECTION') && !codes(eight.report).includes('ZERO_AREA'), codes(eight.report).join(','));
  });

  console.log('\n[MOLDURA] contorno de chapa desenhado em volta das peças');
  const bigL = (x, y) => S.lwpoly([[0, 0], [450, 0], [450, 120], [120, 120], [120, 300], [0, 300]].map(([a, b]) => [a + x, b + y]));
  const frameSpec = (extra = {}) => ({ insunits: 4, entities: [S.rect(0, 0, 1000, 700), bigL(20, 20), bigL(520, 20), bigL(20, 360)], ...extra });
  await test('retângulo com peças dentro é moldura (não peça com furos); quantidades e chapa sugerida', () => {
    const cat = catalogOf(S.buildDxf(frameSpec()));
    assert.strictEqual(cat.frames.length, 1, 'moldura não detectada');
    near(cat.frames[0].width, 1000, 1e-6, 'largura'); near(cat.frames[0].height, 700, 1e-6, 'altura');
    assert.strictEqual(cat.catalogParts.length, 1); assert.strictEqual(cat.catalogParts[0].quantity_detected, 3);
    assert.strictEqual(cat.catalogParts[0].holes.length, 0);
  });
  await test('frameMode "part": o mesmo desenho vira 1 peça com 3 furos', () => {
    const cat = catalogOf(S.buildDxf(frameSpec()), { frameMode: 'part' });
    assert.strictEqual(cat.frames.length, 0);
    assert.strictEqual(cat.catalogParts.length, 1); assert.strictEqual(cat.catalogParts[0].holes.length, 3);
  });
  await test('placa com recorte e furos de parafuso (preset "industrial") NÃO é moldura', () => {
    const { buildSampleDxf } = require('../presets');
    const cat = catalogOf(buildSampleDxf('industrial'));
    assert.strictEqual(cat.frames.length, 0);
    assert.strictEqual(cat.catalogParts.length, 6);
    assert(cat.catalogParts.some(p => p.holes.length === 3), 'a placa 450×320 deve manter seus 3 furos');
  });
  await test('moldura com arruelas (círculos com furo) e rótulo de chapa é moldura; onlyFrames filtra a moldura escolhida', () => {
    const washer = (x, y) => [S.circle(x, y, 40), S.circle(x, y, 15)];
    const txt = S.buildDxf({ insunits: 4, entities: [
      S.rect(0, 0, 300, 200), ...washer(60, 60), ...washer(160, 60), S.mtext(200, 150, 'CHAPA 3mm AISI 304'),
      S.rect(500, 0, 300, 200), S.lwpoly([[520, 20], [700, 20], [700, 60], [560, 60], [560, 120], [520, 120]]), S.lwpoly([[600, 80], [780, 80], [780, 180], [740, 180], [740, 120], [600, 120]])
    ] });
    const cat = catalogOf(txt);
    assert.strictEqual(cat.frames.length, 2, `molduras ${cat.frames.length}`);
    assert(cat.frames.some(f => f.labels.some(l => /CHAPA/.test(l))), 'rótulo da moldura');
    const only = catalogOf(txt, { onlyFrames: [cat.frames.find(f => f.labels.length).id] });
    assert.strictEqual(only.catalogParts.length, 1); assert.strictEqual(only.catalogParts[0].quantity_detected, 2);
    assert.strictEqual(only.catalogParts[0].holes.length, 1);
  });

  console.log('\n[CÓPIAS] peças idênticas viram quantidade');
  await test('mesma peça em 0°, 90° e 37° (com furo) = 1 peça × 3; peça diferente por 1 mm não agrupa', () => {
    const P = [[0, 0], [60, 0], [60, 15], [20, 15], [20, 40], [0, 40]];
    const blk = { entities: [S.lwpoly(P), S.circle(45, 7.5, 4)] };
    const P2 = P.map(([x, y]) => [x === 60 ? 61 : x, y]);
    const txt = S.buildDxf({ insunits: 4, blocks: { PECA: blk, OUTRA: { entities: [S.lwpoly(P2), S.circle(45, 7.5, 4)] } },
      entities: [S.insert('PECA', 0, 0), S.insert('PECA', 200, 0, { rot: 90 }), S.insert('PECA', 400, 0, { rot: 37 }), S.insert('OUTRA', 600, 0)] });
    const cat = catalogOf(txt);
    assert.strictEqual(cat.catalogParts.length, 2, cat.catalogParts.map(p => p.name + '×' + p.quantity_detected).join(','));
    const p = cat.catalogParts.find(x => x.name === 'PECA');
    assert.strictEqual(p.quantity_detected, 3);
    assert.deepStrictEqual(p.instances.map(i => Math.round(i.rotationDeg)).sort((a, b) => a - b), [0, 37, 90]);
    assert.strictEqual(p.holes.length, 1);
    assert.strictEqual(catalogOf(txt, { groupIdentical: false }).catalogParts.length, 4);
  });

  console.log('\n[REAL] os dois DXF enviados (corpus real)');
  await test('Modelo 1: moldura 2000×1200, 22 peças de blocos/matrizes = sd×8, b×8, xscd×6', () => {
    const cat = buildCatalogFromDxf(parseDxf(FIX('Modelo_1_c_moldura.dxf')), cfg(), {});
    assert.deepStrictEqual(cat.frames.map(f => [f.width, f.height]), [[2000, 1200]]);
    assert.deepStrictEqual(cat.catalogParts.map(p => `${p.name}×${p.quantity_detected}`), ['sd×8', 'b×8', 'xscd×6']);
    assert(cat.report.summary.blockDepth >= 3, 'blocos aninhados');
    assert(cat.report.ok);
  });
  await test('Modelo 2: moldura 3000×1200, 87 gomos (SPLINE+LINE em matriz) = 1 peça × 87; blocos não usados relatados', () => {
    const cat = buildCatalogFromDxf(parseDxf(FIX('Modelo_2_c_moldura.dxf')), cfg(), {});
    assert.deepStrictEqual(cat.frames.map(f => [f.width, f.height]), [[3000, 1200]]);
    assert.strictEqual(cat.catalogParts.length, 1); assert.strictEqual(cat.catalogParts[0].quantity_detected, 87);
    const ub = cat.report.items.find(i => i.code === 'UNUSED_BLOCKS');
    assert(ub && /87 Gomos/.test(ub.message), 'o bloco com o rótulo "87 Gomos" deveria ser citado');
    // gomo: largura ~94,5 mm, altura ~380,6 mm (medida no CAD a partir do desenho)
    near(Math.min(cat.catalogParts[0].width, cat.catalogParts[0].height), 94.529, 0.01, 'largura do gomo');
  });
  await test('Modelo 1 pelo motor: layout validado, nenhuma peça perdida', async () => {
    const r = await runPreset({ dxfText: FIX('Modelo_1_c_moldura.dxf'), qty: 1,
      config: { sheetWidth: 2000, sheetHeight: 1200, kerf_width: 0.4, part_clearance: 5.6, sheet_margin: 6, total_iterations: 50, min_remnant_size: 100 } });
    const b = r.done.bestResult;
    assert.strictEqual(r.job.expandedParts.length, 22);
    assert.strictEqual(b.placedParts.length + b.unplacedParts.length, 22);
    assert(b.placedParts.length >= 18, `só ${b.placedParts.length} alocadas`);
    assert(b.validation.ok, b.validation.errors.map(e => e.msg).join(' | '));
  });

  console.log('\n[SERVIDOR] upload, reanálise, erros 422 e parada');
  await test('upload devolve diagnóstico/molduras; reanálise muda opções sem reenviar; DWG dá 422; parar job inexistente dá 404', async () => {
    const express = require('express');
    const origListen = express.application.listen;
    let server;
    express.application.listen = function () { server = origListen.call(this, 0, () => {}); return server; };
    require('../index.js');
    express.application.listen = origListen;
    await new Promise(r => (server.listening ? r() : server.once('listening', r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const fd = new FormData();
      fd.append('dxfFile', new Blob([FIX('Modelo_1_c_moldura.dxf')]), 'Modelo_1.dxf');
      const up = await (await fetch(`${base}/api/upload-dxf`, { method: 'POST', body: fd })).json();
      assert(up.uploadId && up.report && up.report.ok, 'upload sem relatório');
      assert.deepStrictEqual([up.suggestedSheet.width, up.suggestedSheet.height], [2000, 1200]);
      assert.deepStrictEqual(up.catalogParts.map(p => p.quantity_detected), [8, 8, 6]);
      const re = await (await fetch(`${base}/api/reanalyze-dxf`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: up.uploadId, importOptions: { frameMode: 'part' } }) })).json();
      assert.strictEqual(re.catalogParts.length, 1); assert.strictEqual(re.catalogParts[0].holes.length, 22); assert.strictEqual(re.suggestedSheet, null);
      const gone = await fetch(`${base}/api/reanalyze-dxf`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: 'x' }) });
      assert.strictEqual(gone.status, 410);
      const bad = new FormData(); bad.append('dxfFile', new Blob([Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(200, 0)])]), 'p.dxf');
      const r422 = await fetch(`${base}/api/upload-dxf`, { method: 'POST', body: bad });
      assert.strictEqual(r422.status, 422); assert.strictEqual((await r422.json()).code, 'DWG');
      assert.strictEqual((await fetch(`${base}/api/stop/nao-existe`, { method: 'POST' })).status, 404);
      // job real: inicia, para, recebe "done" com stoppedByUser e layout validado
      const init = await (await fetch(`${base}/api/start-job`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId: up.uploadId, config: { sheet_width: 2000, sheet_height: 1200, total_iterations: 50000 }, importOptions: {} }) })).json();
      assert.strictEqual(init.expandedCount, 22, 'quantidades padrão = cópias do desenho');
      const stream = fetch(`${base}/api/stream/${init.jobId}`).then(r => r.text());
      await new Promise(r => setTimeout(r, 2500));
      const st = await (await fetch(`${base}/api/stop/${init.jobId}`, { method: 'POST' })).json();
      assert(st.stopping, JSON.stringify(st));
      const txt = await stream;
      const done = txt.split('\n\n').map(b => b.replace(/^data: /, '')).filter(b => b.startsWith('{')).map(b => JSON.parse(b)).find(m => m.type === 'done');
      assert(done && done.stoppedByUser && done.totalIterations < 50000, 'parada não respeitada');
      assert(done.bestResult.validation.ok, 'layout após parar deve estar validado');
    } finally { server.close(); }
  });

  console.log(`\n${passed} aprovados, ${failed} reprovados`);
  process.exit(failed ? 1 : 0);
})();
