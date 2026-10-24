// presets.js
'use strict';

/** Gera o texto DXF dos presets de engenharia (peças e chapas irregulares). */
function buildSampleDxf(preset = 'icamento') {
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

  // Cabeçalho com $INSUNITS = 4 (mm): o leitor não precisa assumir a unidade.
  const header = '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n9\n$MEASUREMENT\n70\n1\n0\nENDSEC\n';
  return `${header}0\nSECTION\n2\nENTITIES\n${entities.join('\n')}\n0\nENDSEC\n0\nEOF`;
}

module.exports = { buildSampleDxf };
