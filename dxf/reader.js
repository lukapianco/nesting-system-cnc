// dxf/reader.js — leitor DXF ASCII próprio (sem dependências), tolerante a arquivos do mundo real.
//
// Responsabilidade: bytes -> documento estruturado (cabeçalho, layers, tipos de linha, blocos, entidades).
// NÃO faz geometria: isso é do dxf/flatten.js. Erros fatais lançam DxfReadError com mensagem para o operador;
// problemas não fatais vão para doc.warnings (código + mensagem), para o relatório do "DXF Doctor".
'use strict';

class DxfReadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DxfReadError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 1. Bytes -> texto (detecção de DWG/binário e de codificação)
// ---------------------------------------------------------------------------

const CODEPAGE_TO_ENCODING = {
  ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258', DOS437: 'ibm437', DOS850: 'ibm850', ISO8859_1: 'iso-8859-1'
};

function decodeDxfBytes(input) {
  if (typeof input === 'string') return { text: input, encoding: 'string' };
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length === 0) throw new DxfReadError('EMPTY', 'Arquivo vazio.');

  const head = buf.subarray(0, 32).toString('latin1');
  if (head.startsWith('AutoCAD Binary DXF')) {
    throw new DxfReadError('BINARY_DXF',
      'DXF binário não é suportado. No CAD, salve como DXF ASCII (texto), versão R12 ou superior.');
  }
  if (/^AC10\d\d/.test(head) && buf.subarray(0, 128).includes(0)) {
    throw new DxfReadError('DWG', 'O arquivo é um DWG (formato nativo do AutoCAD), não um DXF. Exporte como DXF (comando DXFOUT / Salvar como > DXF).');
  }
  if (/^%PDF/.test(head) || /^\x89PNG/.test(head) || /^PK\x03\x04/.test(head)) {
    throw new DxfReadError('NOT_DXF', 'O arquivo não é um DXF (parece PDF, imagem ou ZIP).');
  }

  let start = 0;
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) start = 3; // BOM UTF-8
  if ((buf[0] === 0xFF && buf[1] === 0xFE) || (buf[0] === 0xFE && buf[1] === 0xFF)) {
    const le = buf[0] === 0xFF;
    const text = new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(buf.subarray(2));
    return { text, encoding: le ? 'utf-16le' : 'utf-16be' };
  }
  const body = buf.subarray(start);

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { text, encoding: 'utf-8' };
  } catch (_) { /* não é UTF-8 válido: DXF antigo em code page */ }

  const probe = body.subarray(0, 65536).toString('latin1');
  const m = probe.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n([^\r\n]+)/);
  const cp = m ? m[1].trim().toUpperCase() : 'ANSI_1252';
  const enc = CODEPAGE_TO_ENCODING[cp] || 'windows-1252';
  try {
    return { text: new TextDecoder(enc).decode(body), encoding: enc };
  } catch (_) {
    return { text: body.toString('latin1'), encoding: 'latin1' };
  }
}

/** Decodifica escapes de texto do DXF: \U+00E7 e %%c/%%d/%%p. */
function decodeDxfString(s) {
  if (!s) return s;
  return s
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±');
}

/** Remove formatação de MTEXT (\P, \A1;, {\fArial|b0;...}) deixando o texto legível. */
function stripMtextFormatting(s) {
  if (!s) return '';
  return decodeDxfString(s)
    .replace(/\\P/g, '\n')
    .replace(/\\[ACcFfHhQqTtWw][^;\\{}]*;/g, '')
    .replace(/\\[LlOoKkNn]/g, '')
    .replace(/\\S([^;]*);/g, (_, f) => f.replace(/[#^]/g, '/'))
    .replace(/\\~/g, ' ')
    .replace(/\\([\\{}])/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// ---------------------------------------------------------------------------
// 2. Texto -> pares (código de grupo, valor)
// ---------------------------------------------------------------------------

function tokenize(text, warnings) {
  const lines = text.split(/\r\n|\n|\r/);
  const codes = [];
  const values = [];
  let i = 0;
  const n = lines.length;
  // pula linhas vazias iniciais
  while (i < n && lines[i].trim() === '') i++;
  for (; i + 1 < n; i += 2) {
    const cl = lines[i].trim();
    if (cl === '' && i + 2 >= n) break;
    if (!/^-?\d+$/.test(cl)) {
      // Linha em branco extra no meio (arquivo editado à mão): tenta realinhar uma vez
      if (cl === '' && /^-?\d+$/.test((lines[i + 1] || '').trim())) { i -= 1; continue; }
      throw new DxfReadError('BAD_GROUP_CODE',
        `DXF corrompido: na linha ${i + 1} era esperado um código de grupo numérico e veio "${cl.slice(0, 40)}".`);
    }
    codes.push(parseInt(cl, 10));
    values.push(lines[i + 1]);
    // "0 / EOF" encerra o DXF: o que vier depois (lixo de editor, outro arquivo colado) é ignorado, como no AutoCAD
    if (codes[codes.length - 1] === 0 && values[values.length - 1].trim() === 'EOF') {
      if (lines.slice(i + 2).some(l => l.trim() !== '')) warnings.push({ code: 'TRAILING_DATA', message: 'Há conteúdo depois do marcador EOF; foi ignorado.' });
      break;
    }
  }
  if (!codes.length) throw new DxfReadError('NOT_DXF', 'Nenhum par código/valor encontrado: o arquivo não parece ser DXF.');
  if (codes[codes.length - 1] !== 0 || values[values.length - 1].trim() !== 'EOF') {
    warnings.push({ code: 'NO_EOF', message: 'Arquivo sem marcador EOF (possivelmente truncado). Conferir se todas as peças foram lidas.' });
  }
  return { codes, values };
}

// ---------------------------------------------------------------------------
// 3. Leitura de valores tolerante
// ---------------------------------------------------------------------------

function makeNum(stats) {
  return function num(v, def = 0) {
    if (v === undefined || v === null) return def;
    const t = String(v).trim();
    if (t === '') return def;
    let x = Number(t);
    if (Number.isNaN(x) && /^[-+]?\d+,\d+([eE][-+]?\d+)?$/.test(t)) { x = Number(t.replace(',', '.')); stats.decimalCommaValues++; }
    if (!Number.isFinite(x)) { stats.badNumbers++; return def; }
    return x;
  };
}

// ---------------------------------------------------------------------------
// 4. Entidades: grupos crus -> objeto normalizado
// ---------------------------------------------------------------------------

/** Separa grupos "de dados" dos grupos de aplicação ({ACAD_REACTORS...}) e XDATA (>= 1000). */
function cleanGroups(groups) {
  const out = [];
  let depth = 0;
  for (const g of groups) {
    const c = g[0];
    if (c === 102) {
      const v = String(g[1]).trim();
      if (v.startsWith('{')) depth++; else if (v === '}' && depth > 0) depth--;
      continue;
    }
    if (depth > 0) continue;
    if (c >= 1000) break; // XDATA no fim da entidade
    out.push(g);
  }
  return out;
}

function firstVal(groups, code) {
  for (const g of groups) if (g[0] === code) return g[1];
  return undefined;
}

function parseCommon(type, groups, num) {
  const e = { type };
  e.handle = firstVal(groups, 5);
  e.layer = decodeDxfString(String(firstVal(groups, 8) ?? '0').trim()) || '0';
  const lt = firstVal(groups, 6);
  e.linetype = lt !== undefined ? decodeDxfString(String(lt).trim()) : 'BYLAYER';
  e.color = num(firstVal(groups, 62), 256);
  e.paperSpace = num(firstVal(groups, 67), 0) === 1;
  e.invisible = num(firstVal(groups, 60), 0) === 1;
  e.extrusion = {
    x: num(firstVal(groups, 210), 0),
    y: num(firstVal(groups, 220), 0),
    z: num(firstVal(groups, 230), 1)
  };
  return e;
}

function pt3(groups, cx, num, def) {
  const x = firstVal(groups, cx), y = firstVal(groups, cx + 10), z = firstVal(groups, cx + 20);
  if (x === undefined && y === undefined) return def;
  return { x: num(x), y: num(y), z: num(z) };
}

function parseEntity(type, rawGroups, num) {
  const groups = cleanGroups(rawGroups);
  const e = parseCommon(type, groups, num);
  switch (type) {
    case 'LINE':
      e.p1 = pt3(groups, 10, num, { x: 0, y: 0, z: 0 });
      e.p2 = pt3(groups, 11, num, { x: 0, y: 0, z: 0 });
      break;
    case 'CIRCLE':
      e.center = pt3(groups, 10, num, { x: 0, y: 0, z: 0 });
      e.radius = num(firstVal(groups, 40));
      break;
    case 'ARC':
      e.center = pt3(groups, 10, num, { x: 0, y: 0, z: 0 });
      e.radius = num(firstVal(groups, 40));
      e.startDeg = num(firstVal(groups, 50));
      e.endDeg = num(firstVal(groups, 51), 360);
      break;
    case 'ELLIPSE':
      e.center = pt3(groups, 10, num, { x: 0, y: 0, z: 0 });
      e.major = pt3(groups, 11, num, { x: 1, y: 0, z: 0 });
      e.ratio = num(firstVal(groups, 40), 1);
      e.startParam = num(firstVal(groups, 41), 0);
      e.endParam = num(firstVal(groups, 42), Math.PI * 2);
      break;
    case 'LWPOLYLINE': {
      e.flags = num(firstVal(groups, 70), 0);
      e.closed = (e.flags & 1) === 1;
      e.elevation = num(firstVal(groups, 38), 0);
      e.constWidth = num(firstVal(groups, 43), 0);
      e.vertices = [];
      let cur = null;
      for (const [c, v] of groups) {
        if (c === 10) { cur = { x: num(v), y: 0, bulge: 0 }; e.vertices.push(cur); }
        else if (!cur) continue;
        else if (c === 20) cur.y = num(v);
        else if (c === 42) cur.bulge = num(v);
        else if (c === 40) cur.startWidth = num(v);
        else if (c === 41) cur.endWidth = num(v);
      }
      break;
    }
    case 'POLYLINE':
      e.flags = num(firstVal(groups, 70), 0);
      e.closed = (e.flags & 1) === 1;
      e.is3d = (e.flags & 8) === 8;
      e.isMesh = (e.flags & 16) === 16;
      e.isPolyface = (e.flags & 64) === 64;
      e.splineFit = (e.flags & 4) === 4;
      e.elevation = num(firstVal(groups, 30), 0);
      e.vertices = [];
      break;
    case 'VERTEX':
      e.x = num(firstVal(groups, 10));
      e.y = num(firstVal(groups, 20));
      e.z = num(firstVal(groups, 30));
      e.bulge = num(firstVal(groups, 42), 0);
      e.vflags = num(firstVal(groups, 70), 0);
      break;
    case 'SPLINE': {
      e.flags = num(firstVal(groups, 70), 0);
      e.closed = (e.flags & 1) === 1;
      e.periodic = (e.flags & 2) === 2;
      e.rational = (e.flags & 4) === 4;
      e.degree = num(firstVal(groups, 71), 3);
      e.knots = []; e.weights = []; e.ctrl = []; e.fit = [];
      let curC = null, curF = null;
      for (const [c, v] of groups) {
        if (c === 40) e.knots.push(num(v));
        else if (c === 41) e.weights.push(num(v));
        else if (c === 10) { curC = { x: num(v), y: 0, z: 0 }; e.ctrl.push(curC); }
        else if (c === 20 && curC) curC.y = num(v);
        else if (c === 30 && curC) curC.z = num(v);
        else if (c === 11) { curF = { x: num(v), y: 0, z: 0 }; e.fit.push(curF); }
        else if (c === 21 && curF) curF.y = num(v);
        else if (c === 31 && curF) curF.z = num(v);
      }
      e.startTangent = pt3(groups, 12, num, null);
      e.endTangent = pt3(groups, 13, num, null);
      break;
    }
    case 'INSERT':
      e.name = decodeDxfString(String(firstVal(groups, 2) ?? '').trim());
      e.position = pt3(groups, 10, num, { x: 0, y: 0, z: 0 });
      e.sx = num(firstVal(groups, 41), 1);
      e.sy = num(firstVal(groups, 42), 1);
      e.sz = num(firstVal(groups, 43), 1);
      e.rotationDeg = num(firstVal(groups, 50), 0);
      e.cols = Math.max(1, Math.round(num(firstVal(groups, 70), 1)));
      e.rows = Math.max(1, Math.round(num(firstVal(groups, 71), 1)));
      e.colSpacing = num(firstVal(groups, 44), 0);
      e.rowSpacing = num(firstVal(groups, 45), 0);
      e.hasAttribs = num(firstVal(groups, 66), 0) === 1;
      break;
    case 'TEXT':
    case 'ATTRIB':
      e.position = pt3(groups, 10, num, { x: 0, y: 0, z: 0 });
      e.height = num(firstVal(groups, 40), 0);
      e.text = decodeDxfString(String(firstVal(groups, 1) ?? ''));
      e.ocs = true;
      break;
    case 'MTEXT': {
      e.position = pt3(groups, 10, num, { x: 0, y: 0, z: 0 });
      e.height = num(firstVal(groups, 40), 0);
      let t = '';
      for (const [c, v] of groups) if (c === 3) t += v;
      t += String(firstVal(groups, 1) ?? '');
      e.text = stripMtextFormatting(t);
      e.ocs = false;
      break;
    }
    default:
      break;
  }
  return e;
}

// ---------------------------------------------------------------------------
// 5. Estrutura do arquivo: seções, tabelas, blocos, entidades
// ---------------------------------------------------------------------------

/**
 * Lê um DXF ASCII.
 * @param {Buffer|string} input
 * @returns {{version:string, header:Object, layers:Map, blocks:Map, entities:Array, encoding:string,
 *            warnings:Array<{code:string,message:string}>, stats:Object}}
 */
function readDxf(input) {
  const warnings = [];
  const { text, encoding } = decodeDxfBytes(input);
  const { codes, values } = tokenize(text, warnings);
  const stats = { decimalCommaValues: 0, badNumbers: 0, paperSpaceEntities: 0, groups: codes.length };
  const num = makeNum(stats);
  const N = codes.length;

  const header = {};
  const layers = new Map();
  const linetypes = new Map();
  const blockRecords = new Map();
  const blocks = new Map();
  const entities = [];
  const sectionsSeen = [];

  let i = 0;
  const str = (k) => String(values[k]).trim();

  /** Lê grupos de uma entidade a partir de i (que aponta para o código 0 da entidade). */
  function readEntityGroups() {
    const type = str(i);
    const groups = [];
    i++;
    while (i < N && codes[i] !== 0) { groups.push([codes[i], values[i]]); i++; }
    return { type, groups };
  }

  /** Lê uma sequência de entidades até ENDSEC (seção ENTITIES) ou ENDBLK (bloco). */
  function readEntityList(stopTokens, out) {
    while (i < N) {
      if (codes[i] !== 0) { i++; continue; }
      const t = str(i);
      if (stopTokens.includes(t)) return t;
      const { type, groups } = readEntityGroups();
      const ent = parseEntity(type, groups, num);
      if (type === 'POLYLINE') {
        // VERTEX ... SEQEND
        while (i < N && codes[i] === 0 && str(i) === 'VERTEX') {
          const vg = readEntityGroups();
          ent.vertices.push(parseEntity('VERTEX', vg.groups, num));
        }
        if (i < N && codes[i] === 0 && str(i) === 'SEQEND') readEntityGroups();
      } else if (type === 'INSERT' && ent.hasAttribs) {
        ent.attribs = [];
        while (i < N && codes[i] === 0 && str(i) === 'ATTRIB') {
          const ag = readEntityGroups();
          ent.attribs.push(parseEntity('ATTRIB', ag.groups, num));
        }
        if (i < N && codes[i] === 0 && str(i) === 'SEQEND') readEntityGroups();
      }
      out.push(ent);
    }
    return null;
  }

  function readHeader() {
    let name = null;
    while (i < N && !(codes[i] === 0 && str(i) === 'ENDSEC')) {
      if (codes[i] === 9) { name = str(i); header[name] = {}; }
      else if (name) header[name][codes[i]] = values[i];
      i++;
    }
  }

  function readTables() {
    while (i < N && !(codes[i] === 0 && str(i) === 'ENDSEC')) {
      if (codes[i] === 0 && (str(i) === 'LAYER' || str(i) === 'LTYPE' || str(i) === 'BLOCK_RECORD')) {
        const { type, groups } = readEntityGroups();
        const g = cleanGroups(groups);
        const nm = decodeDxfString(String(firstVal(g, 2) ?? '').trim());
        if (type === 'LAYER') {
          const flags = num(firstVal(g, 70), 0);
          const color = num(firstVal(g, 62), 7);
          layers.set(nm, {
            name: nm,
            frozen: (flags & 1) === 1,
            locked: (flags & 4) === 4,
            off: color < 0,
            color: Math.abs(color),
            linetype: decodeDxfString(String(firstVal(g, 6) ?? 'CONTINUOUS').trim()),
            plot: num(firstVal(g, 290), 1) !== 0,
            xref: (flags & 16) === 16
          });
        } else if (type === 'LTYPE') {
          const pattern = g.filter(x => x[0] === 49).map(x => num(x[1]));
          linetypes.set(nm.toUpperCase(), { name: nm, dashed: pattern.some(v => v < 0) || pattern.length > 1 });
        } else if (type === 'BLOCK_RECORD') {
          blockRecords.set(nm, { name: nm, units: num(firstVal(g, 70), 0), handle: firstVal(groups, 5) });
        }
        continue;
      }
      i++;
    }
  }

  function readBlocks() {
    while (i < N && !(codes[i] === 0 && str(i) === 'ENDSEC')) {
      if (codes[i] === 0 && str(i) === 'BLOCK') {
        const { groups } = readEntityGroups();
        const g = cleanGroups(groups);
        const name = decodeDxfString(String(firstVal(g, 2) ?? firstVal(g, 3) ?? '').trim());
        const flags = num(firstVal(g, 70), 0);
        const blk = {
          name,
          flags,
          anonymous: (flags & 1) === 1 || name.startsWith('*'),
          isXref: (flags & 4) === 4 || (flags & 32) === 32,
          xrefPath: firstVal(g, 1) ? String(firstVal(g, 1)).trim() : '',
          base: pt3(g, 10, num, { x: 0, y: 0, z: 0 }),
          layer: decodeDxfString(String(firstVal(g, 8) ?? '0').trim()),
          entities: []
        };
        const stop = readEntityList(['ENDBLK', 'ENDSEC'], blk.entities);
        if (stop === 'ENDBLK') readEntityGroups();
        if (blocks.has(name)) warnings.push({ code: 'DUP_BLOCK', message: `Bloco "${name}" definido mais de uma vez; usada a última definição.` });
        blocks.set(name, blk);
        continue;
      }
      i++;
    }
  }

  while (i < N) {
    if (codes[i] === 0 && str(i) === 'SECTION') {
      i++;
      const secName = codes[i] === 2 ? str(i) : '?';
      sectionsSeen.push(secName);
      i++;
      if (secName === 'HEADER') readHeader();
      else if (secName === 'TABLES') readTables();
      else if (secName === 'BLOCKS') readBlocks();
      else if (secName === 'ENTITIES') readEntityList(['ENDSEC'], entities);
      else { while (i < N && !(codes[i] === 0 && str(i) === 'ENDSEC')) i++; }
      i++; // ENDSEC
      continue;
    }
    if (codes[i] === 0 && str(i) === 'EOF') break;
    i++;
  }

  if (!sectionsSeen.includes('ENTITIES') && !sectionsSeen.includes('BLOCKS')) {
    throw new DxfReadError('NO_ENTITIES', 'O DXF não tem seção ENTITIES nem BLOCKS: nada para ler.');
  }

  const modelEntities = [];
  for (const e of entities) {
    if (e.paperSpace) { stats.paperSpaceEntities++; continue; }
    modelEntities.push(e);
  }
  if (stats.paperSpaceEntities) {
    warnings.push({ code: 'PAPER_SPACE', message: `${stats.paperSpaceEntities} entidade(s) no espaço de papel (layout) foram ignoradas; só o espaço do modelo é lido.` });
  }
  if (stats.decimalCommaValues) {
    warnings.push({ code: 'DECIMAL_COMMA', message: `${stats.decimalCommaValues} número(s) com vírgula decimal (fora do padrão DXF) foram interpretados como decimais.` });
  }
  if (stats.badNumbers) {
    warnings.push({ code: 'BAD_NUMBERS', message: `${stats.badNumbers} valor(es) numérico(s) inválido(s) foram tratados como 0.` });
  }

  const hv = (name, code) => (header[name] ? header[name][code] : undefined);
  const doc = {
    version: hv('$ACADVER', 1) ? String(hv('$ACADVER', 1)).trim() : 'desconhecida',
    header: {
      insunits: hv('$INSUNITS', 70) !== undefined ? num(hv('$INSUNITS', 70)) : null,
      measurement: hv('$MEASUREMENT', 70) !== undefined ? num(hv('$MEASUREMENT', 70)) : null,
      codepage: hv('$DWGCODEPAGE', 3) ? String(hv('$DWGCODEPAGE', 3)).trim() : null,
      extmin: header.$EXTMIN ? { x: num(hv('$EXTMIN', 10)), y: num(hv('$EXTMIN', 20)) } : null,
      extmax: header.$EXTMAX ? { x: num(hv('$EXTMAX', 10)), y: num(hv('$EXTMAX', 20)) } : null
    },
    layers,
    linetypes,
    blockRecords,
    blocks,
    entities: modelEntities,
    encoding,
    sections: sectionsSeen,
    warnings,
    stats
  };
  return doc;
}

module.exports = { readDxf, decodeDxfBytes, decodeDxfString, stripMtextFormatting, DxfReadError };
