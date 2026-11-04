'use strict';
// A homemade dance library for the e2e (docs/vrm-dance.md §7.3): an MMD motion written here with the VMD
// writer (known keys, no third-party motion), baked by the same code as real dances (src/core/vmd-retarget.js),
// a 6 s WAV with a beep on every second and a generated PNG cover, and library.json in the format
// scripts/vrm-bake.js --dance writes. Two dances:
//   e2e-test    6 s with music: t = 1 s the right arm level, t = 2 s the left arm level, t = 3 s the centre
//               30 units to her side (the stage limit holds her in), t = 4 s a squat (足ＩＫ held, センター down:
//               the knees bend forward), あ on its mouth around 2 s
//   e2e-silent  3 s without music (loops by default: short and silent)
//
//   node scripts/make-test-dance.js <out dir>      (or require it: writeTestDances(dir))

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const VMD = require('../src/core/vmd');
const R = require('../src/core/vmd-retarget');
const W = require('../src/core/vrma-write');

const FPS = 30;
const ID = [0, 0, 0, 1];
const levelR = R.qToRH(W.qinv(R.A_POSE.right)); // lifts the MMD right arm by its A-pose: level
const levelL = R.qToRH(W.qinv(R.A_POSE.left));

function testVmd() {
  const k = (name, s, extra = {}) => ({ name, frame: Math.round(s * FPS), ...extra });
  const bones = [
    k('上半身', 0, { rot: ID }), k('上半身', 6, { rot: ID }),
    k('右腕', 0, { rot: ID }), k('右腕', 0.8, { rot: levelR }), k('右腕', 1.3, { rot: levelR }), k('右腕', 1.8, { rot: ID }), k('右腕', 6, { rot: ID }),
    k('左腕', 0, { rot: ID }), k('左腕', 1.5, { rot: ID }), k('左腕', 1.9, { rot: levelL }), k('左腕', 2.3, { rot: levelL }), k('左腕', 2.7, { rot: ID }), k('左腕', 6, { rot: ID }),
    k('センター', 0, { pos: [0, 0, 0] }), k('センター', 2.6, { pos: [0, 0, 0] }), k('センター', 3.0, { pos: [30, 0, 0] }), k('センター', 3.5, { pos: [30, 0, 0] }), k('センター', 3.7, { pos: [0, 0, 0] }),
    k('センター', 3.8, { pos: [0, 0, 0] }), k('センター', 4.0, { pos: [0, -3, 0] }), k('センター', 4.3, { pos: [0, -3, 0] }), k('センター', 4.6, { pos: [0, 0, 0] }), k('センター', 6, { pos: [0, 0, 0] }),
    k('左足ＩＫ', 0, { pos: [0, 0, 0] }), k('左足ＩＫ', 6, { pos: [0, 0, 0] }), k('右足ＩＫ', 0, { pos: [0, 0, 0] }), k('右足ＩＫ', 6, { pos: [0, 0, 0] }),
  ];
  const morphs = [k('あ', 0, { weight: 0 }), k('あ', 1.8, { weight: 0 }), k('あ', 2.1, { weight: 1 }), k('あ', 2.5, { weight: 0 })];
  return VMD.writeVmd({ modelName: 'e2e', bones, morphs, ik: [{ frame: 0, states: { '左足ＩＫ': true, '右足ＩＫ': true } }] });
}
function silentVmd() {
  const k = (name, s, extra = {}) => ({ name, frame: Math.round(s * FPS), ...extra });
  return VMD.writeVmd({ modelName: 'e2e', bones: [k('上半身', 0, { rot: ID }), k('上半身', 3, { rot: ID }), k('右腕', 0, { rot: ID }), k('右腕', 1.5, { rot: levelR }), k('右腕', 3, { rot: ID })] });
}

// 6 s of 16-bit mono, a 0.1 s 880 Hz beep at the start of every second
function beepWav(seconds = 6, rate = 22050) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8, 'latin1'); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1'); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const t = i / rate; const on = t % 1 < 0.1; buf.writeInt16LE(on ? Math.round(Math.sin(2 * Math.PI * 880 * t) * 12000) : 0, 44 + i * 2); }
  return buf;
}

// a 64×64 PNG: a violet square with a lighter disc
function coverPng(size = 64) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const d = Math.hypot(x - size / 2, y - size / 2) < size / 3; const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = d ? 200 : 110; raw[o + 1] = d ? 180 : 80; raw[o + 2] = d ? 255 : 200; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Writes <dir>/<id>/{dance.vrma, audio.wav, cover.png} and <dir>/library.json; returns { index, reports }.
function writeTestDances(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const index = { schema: 1, dances: {} };
  const reports = {};
  const add = (id, name, vmd, { audio = null, cover = null, at }) => {
    const { vrma, report } = R.bakeVmd(vmd, { name: id });
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'dance.vrma'), vrma);
    if (audio) fs.writeFileSync(path.join(dir, id, 'audio.wav'), audio);
    if (cover) fs.writeFileSync(path.join(dir, id, 'cover.png'), cover);
    index.dances[id] = {
      name, file: `${id}/dance.vrma`, ...(audio ? { audio: `${id}/audio.wav`, audioDuration: (audio.length - 44) / 2 / 22050 } : {}), ...(cover ? { cover: `${id}/cover.png` } : {}),
      duration: report.duration, offset: 0, loop: !audio && report.duration <= 15, credit: 'e2e (generated)', face: !!report.face, ik: report.ik,
      ...(report.stage ? { stage: { radius: report.stage.radius, clampHits: report.stage.clampHits } } : {}), extent: report.extent, ground: report.ground,
      source: 'vmd', bakedWith: R.BAKED_WITH, importedAt: at,
    };
    reports[id] = report;
  };
  add('e2e-test', 'E2E 测试舞', testVmd(), { audio: beepWav(6), cover: coverPng(), at: '2026-11-03T10:00:00.000Z' });
  add('e2e-silent', 'E2E 无音乐小舞', silentVmd(), { at: '2026-11-02T10:00:00.000Z' });
  fs.writeFileSync(path.join(dir, 'library.json'), `${JSON.stringify(index, null, 2)}\n`);
  return { index, reports };
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node scripts/make-test-dance.js <out dir>'); process.exit(1); }
  const { index, reports } = writeTestDances(path.resolve(out));
  for (const [id, e] of Object.entries(index.dances)) console.log(`${id}: ${e.duration} s, ik ${e.ik}, face ${e.face}, extent ${JSON.stringify(e.extent)}, stage ${JSON.stringify(e.stage)}, expressions ${reports[id].expressions.join(' ')}`);
}
module.exports = { writeTestDances, testVmd, beepWav, coverPng };
