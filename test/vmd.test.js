'use strict';
// The VMD reader (src/core/vmd.js, docs/vrm-dance.md §2.1, §2.7): motions built here byte by byte (Shift-JIS names,
// bone / morph / camera keys, the IK switch section), read back; the Bézier curves; the 30 fps sampler; the camera
// and prop checks the dance import uses. No assets needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const VMD = require('../src/core/vmd');

const close = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;
const qx = (deg) => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)];
// one bone key's 64 interpolation bytes with the same curve on every channel, or per channel
function interp(curves) {
  const b = new Uint8Array(64);
  for (let c = 0; c < 4; c++) {
    const [x1, y1, x2, y2] = Array.isArray(curves[0]) ? curves[c] : curves;
    b[c] = x1; b[c + 4] = y1; b[c + 8] = x2; b[c + 12] = y2;
  }
  return b;
}
const EASE_IN = [127, 0, 127, 127]; // slow start
const EASE_OUT = [0, 0, 0, 127]; // fast start

test('a VMD written byte by byte reads back: header, Shift-JIS names, bone / morph / camera keys, IK switches', () => {
  const buf = VMD.writeVmd({
    modelName: '初音ミク',
    bones: [
      { name: 'センター', frame: 0, pos: [0, 0, 0] },
      { name: 'センター', frame: 30, pos: [1.5, -2, 3.25], rot: qx(30) },
      { name: '左足ＩＫ', frame: 10, pos: [0, 1, 0] }, // full-width IK, as MMD writes it
      { name: '右ひじ', frame: 5, rot: qx(-45), interp: interp(EASE_IN) },
    ],
    morphs: [{ name: 'まばたき', frame: 12, weight: 0.75 }, { name: 'あ', frame: 3, weight: 1 }],
    cameras: [{ frame: 0 }, { frame: 60 }],
    ik: [{ frame: 0, states: { '左足ＩＫ': true, '右足ＩＫ': true } }, { frame: 40, states: { '左足ＩＫ': false } }],
  });
  // 30 + 20 + 4 + 4×111 + 4 + 2×23 + 4 + 2×61 + 4 + 4 + 4 + (9 + 2×21) + (9 + 21)
  assert.equal(buf.length, 30 + 20 + 4 + 4 * 111 + 4 + 2 * 23 + 4 + 2 * 61 + 4 + 4 + 4 + 9 + 42 + 9 + 21);
  assert.equal(buf.subarray(0, 25).toString('latin1'), 'Vocaloid Motion Data 0002');
  // the bone name really is Shift-JIS on disk: センター = 83 5A 83 93 83 5E 81 5B
  assert.deepEqual([...buf.subarray(54, 62)], [0x83, 0x5a, 0x83, 0x93, 0x83, 0x5e, 0x81, 0x5b]);
  const v = VMD.parseVmd(buf);
  assert.equal(v.version, 2);
  assert.equal(v.modelName, '初音ミク');
  assert.equal(v.bones.length, 4);
  assert.equal(v.bones[1].name, 'センター');
  assert.equal(v.bones[1].frame, 30);
  assert.deepEqual(v.bones[1].pos, [1.5, -2, 3.25]);
  assert.ok(v.bones[1].rot.every((x, i) => close(x, qx(30)[i])));
  assert.equal(v.bones[2].name, '左足ＩＫ', 'names are kept as written');
  assert.equal(VMD.normName(v.bones[2].name), '左足IK', 'and folded for matching (NFKC: ＩＫ → IK)');
  assert.equal(VMD.normName('左親指０'), '左親指0');
  assert.equal(VMD.normName('ﾈｸﾀｲ '), 'ネクタイ');
  assert.deepEqual([...v.bones[3].interp.subarray(0, 16)], [127, 127, 127, 127, 0, 0, 0, 0, 127, 127, 127, 127, 127, 127, 127, 127]);
  assert.deepEqual(v.morphs.map((m) => [m.name, m.frame, m.weight]), [['まばたき', 12, 0.75], ['あ', 3, 1]]);
  assert.equal(v.cameras.length, 2);
  assert.deepEqual(v.ik.map((k) => k.frame), [0, 40]);
  assert.deepEqual(v.ik[0].states, { 左足IK: true, 右足IK: true });
  assert.equal(VMD.lastFrame(v), 30, 'the last bone / morph key (the camera does not count)');
});

test('names: a multi-byte character cut by the 15-byte field is dropped, bytes after the NUL are ignored', () => {
  const sj = VMD.encodeShiftJis('左人指１左人指２'); // 16 bytes: the 8th character is cut in half by a 15-byte field
  assert.equal(sj.length, 16);
  const field = Buffer.alloc(15);
  sj.copy(field, 0, 0, 15);
  assert.equal(VMD.decodeName(field), '左人指１左人指');
  const junk = Buffer.from([...VMD.encodeShiftJis('頭'), 0, 0xfd, 0xfd, 0x41]);
  assert.equal(VMD.decodeName(junk), '頭');
  assert.throws(() => VMD.encodeShiftJis('😀'), /no Shift-JIS/);
});

test('old version header, files that stop after the morphs, and things that are not VMD', () => {
  // version 1: 10-byte model name; the file ends after the morph section (no camera / light / IK sections)
  const head = Buffer.alloc(30);
  head.write('Vocaloid Motion Data file', 'latin1');
  const name = Buffer.alloc(10);
  VMD.encodeShiftJis('ミク').copy(name);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const v = VMD.parseVmd(Buffer.concat([head, name, u32(0), u32(0)]));
  assert.equal(v.version, 1);
  assert.equal(v.modelName, 'ミク');
  assert.deepEqual([v.bones.length, v.morphs.length, v.cameras.length, v.ik.length], [0, 0, 0, 0]);
  assert.throws(() => VMD.parseVmd(Buffer.alloc(100)), /not a VMD/);
  assert.throws(() => VMD.parseVmd(Buffer.from('short')), /not a VMD/);
  // a count that promises more records than the file holds
  const bad = Buffer.concat([VMD.writeVmd({}).subarray(0, 50), u32(1000), Buffer.alloc(111)]);
  assert.throws(() => VMD.parseVmd(bad), /truncated/);
});

test('Bézier curves: the default line is linear, ease-in starts slow, ease-out starts fast, ends are fixed', () => {
  for (const x of [0, 0.1, 0.25, 0.5, 0.9, 1]) assert.ok(close(VMD.bezierY(20, 20, 107, 107, x), x), `linear at ${x}`);
  // control points off the line but symmetric: still through the middle
  assert.ok(close(VMD.bezierY(64, 0, 64, 127, 0.5), 0.5, 1e-2));
  const ein = VMD.bezierY(...EASE_IN, 0.5);
  const eout = VMD.bezierY(...EASE_OUT, 0.5);
  assert.ok(ein < 0.3, `ease-in at half time: ${ein}`);
  assert.ok(eout > 0.7, `ease-out at half time: ${eout}`);
  assert.equal(VMD.bezierY(...EASE_IN, 0), 0);
  assert.equal(VMD.bezierY(...EASE_IN, 1), 1);
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.05) { const y = VMD.bezierY(...EASE_IN, x); assert.ok(y >= prev - 1e-9, 'monotonic'); prev = y; }
});

test('the bone sampler: each channel follows the curve stored on the key that ends the segment, held outside the keys', () => {
  const keys = [
    { frame: 0, pos: [0, 0, 0], rot: [0, 0, 0, 1], interp: VMD.LINEAR_INTERP },
    // x eases in, y is linear, z eases out, the rotation eases in
    { frame: 30, pos: [10, 10, 10], rot: qx(90), interp: interp([EASE_IN, [20, 20, 107, 107], EASE_OUT, EASE_IN]) },
  ];
  const s = VMD.boneSampler(keys);
  const mid = s(15);
  assert.ok(mid.pos[0] < 3, `x eases in: ${mid.pos[0]}`);
  assert.ok(close(mid.pos[1], 5), `y linear: ${mid.pos[1]}`);
  assert.ok(mid.pos[2] > 7, `z eases out: ${mid.pos[2]}`);
  const ang = (2 * Math.acos(mid.rot[3]) * 180) / Math.PI;
  assert.ok(ang < 30, `the rotation eases in too: ${ang}°`);
  assert.deepEqual(s(-5).pos, [0, 0, 0], 'held before the first key');
  assert.deepEqual(s(99).pos, [10, 10, 10], 'held after the last key');
  // walking backwards still finds the right segment
  const s2 = VMD.boneSampler([{ frame: 0, pos: [0, 0, 0], rot: [0, 0, 0, 1] }, { frame: 10, pos: [10, 0, 0], rot: [0, 0, 0, 1] }, { frame: 20, pos: [0, 0, 0], rot: [0, 0, 0, 1] }]);
  assert.ok(close(s2(15).pos[0], 5));
  assert.ok(close(s2(5).pos[0], 5));
  assert.ok(close(s2(10).pos[0], 10));
});

test('keys grouped by folded name and sorted; a second key on a frame replaces the first; morphs are linear', () => {
  const g = VMD.groupKeys([{ name: '左足ＩＫ', frame: 20, pos: [2, 0, 0] }, { name: '左足IK', frame: 0, pos: [0, 0, 0] }, { name: '左足ＩＫ', frame: 20, pos: [3, 0, 0] }]);
  assert.deepEqual([...g.keys()], ['左足IK']);
  assert.deepEqual(g.get('左足IK').map((k) => [k.frame, k.pos[0]]), [[0, 0], [20, 3]]);
  const m = VMD.morphSampler([{ frame: 0, weight: 0 }, { frame: 10, weight: 1 }, { frame: 20, weight: 0 }]);
  assert.ok(close(m(5), 0.5));
  assert.ok(close(m(15), 0.5));
  assert.equal(m(30), 0);
});

test('IK switches are a step function of the frame; a bone the file never mentions is undefined (MMD: on)', () => {
  const ik = [{ frame: 0, states: { 左足IK: true } }, { frame: 40, states: { 左足IK: false } }, { frame: 80, states: { 左足IK: true } }];
  assert.equal(VMD.ikEnabled(ik, '左足ＩＫ', 0), true);
  assert.equal(VMD.ikEnabled(ik, '左足IK', 39), true);
  assert.equal(VMD.ikEnabled(ik, '左足IK', 40), false);
  assert.equal(VMD.ikEnabled(ik, '左足IK', 79), false);
  assert.equal(VMD.ikEnabled(ik, '左足IK', 200), true);
  assert.equal(VMD.ikEnabled(ik, '右足IK', 50), undefined);
});

test('what a VMD holds: a dancer, a camera, a prop, nothing', () => {
  const read = (m) => VMD.classifyVmd(VMD.parseVmd(VMD.writeVmd(m)));
  assert.equal(read({ bones: [{ name: 'センター', frame: 0 }, { name: '左腕', frame: 0 }, { name: '前髪', frame: 0 }] }), 'motion');
  assert.equal(read({ cameras: [{ frame: 0 }, { frame: 30 }] }), 'camera');
  assert.equal(read({ bones: [{ name: '椅子', frame: 0 }, { name: '椅子', frame: 30, pos: [0, 1, 0] }] }), 'prop');
  assert.equal(read({ bones: [{ name: 'センター', frame: 0 }] }), 'prop', 'one body bone is not a dancer');
  assert.equal(read({ morphs: [{ name: 'あ', frame: 0, weight: 1 }] }), 'motion', 'a face-only motion still drives her');
  assert.equal(read({}), 'empty');
});

test('English bone and morph names (PMX standard English names, mmd_tools / MMD4Mecanim spellings) fold onto the Japanese ones', () => {
  const cases = {
    master: '全ての親', center: 'センター', groove: 'グルーブ', waist: '腰', 'lower body': '下半身', 'upper body': '上半身', 'upper body2': '上半身2', 'Upper_Body3': '上半身3',
    neck: '首', head: '頭', eyes: '両目', shoulderP_L: '左肩P', shoulder_R: '右肩', arm_L: '左腕', 'arm twist_L': '左腕捩', elbow_R: '右ひじ', 'wrist twist_R': '右手捩', wrist_L: '左手首',
    thumb0_L: '左親指0', thumb2_R: '右親指2', fore1_L: '左人指1', 'index3.R': '右人指3', middle2_L: '左中指2', third1_R: '右薬指1', ring3_L: '左薬指3', little1_L: '左小指1', 'pinky2 R': '右小指2',
    leg_L: '左足', knee_R: '右ひざ', ankle_L: '左足首', toe_R: '右つま先', 'leg IK_L': '左足IK', 'leg ＩＫ_R': '右足IK', 'toe IK_L': '左つま先IK', 'leg IKP_R': '右足IK親',
    'waist cancel_L': '腰キャンセル左', leg_L_D: '左足D', 'knee D_R': '右ひざD', 'toe EX_L': '左足先EX', LeftElbow: '左ひじ', right_arm: '右腕',
  };
  for (const [en, ja] of Object.entries(cases)) assert.equal(VMD.boneName(en), ja, en);
  // Japanese names and anything unknown pass through (only folded)
  assert.equal(VMD.boneName('左足ＩＫ'), '左足IK');
  assert.equal(VMD.boneName('hair_L'), 'hair_L');
  assert.equal(VMD.morphName('A'), 'あ');
  assert.equal(VMD.morphName('blink'), 'まばたき');
  assert.equal(VMD.morphName('wink_R'), 'ウィンク右');
  assert.equal(VMD.morphName('smile'), '笑い');
  // grouping, the IK switch section and the dancer check all see the folded names
  const v = VMD.parseVmd(VMD.writeVmd({ bones: [{ name: 'center', frame: 0 }, { name: 'センター', frame: 10 }, { name: 'arm_L', frame: 0 }], ik: [{ frame: 0, states: { 'leg IK_L': false } }] }));
  assert.deepEqual([...VMD.groupKeys(v.bones, VMD.boneName).keys()], ['センター', '左腕']);
  assert.equal(VMD.groupKeys(v.bones, VMD.boneName).get('センター').length, 2);
  assert.equal(VMD.ikEnabled(v.ik, '左足ＩＫ', 5), false);
  assert.equal(VMD.classifyVmd(v), 'motion', 'an English-named dancer is a dancer, not a prop');
});
