'use strict';
// MMD dance → VRM clip → .vrma (src/core/vmd-retarget.js, docs/vrm-dance.md §2): motions built here with the VMD
// writer, baked, and checked by forward kinematics on the VRM side (the reference rest): handedness, the A-pose,
// the bone map (twist bones, 上半身 under 下半身, the thumb order), the hips travel and its stage limit, the leg IK
// (reach, knee direction, straight when out of reach, IK switches, FK-baked dances), the expressions, and the written
// .vrma through the app's own check (inspectVrmaJson) and its vendored loader / createVRMAnimationClip.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const VMD = require('../src/core/vmd');
const R = require('../src/core/vmd-retarget');
const W = require('../src/core/vrma-write');
const B = require('../scripts/lib/vrm-bake-core');
const V = require('../src/core/vrm');

const ROOT = path.join(__dirname, '..');
const ID = [0, 0, 0, 1];
const deg = (r) => (r * 180) / Math.PI;
const qaxisDeg = (axis, d) => W.qaxis(axis, (d * Math.PI) / 180);
const qx = (d) => qaxisDeg([1, 0, 0], d);
const qy = (d) => qaxisDeg([0, 1, 0], d);
const qz = (d) => qaxisDeg([0, 0, 1], d);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const len = (a) => Math.hypot(...a);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
let runtime = null;
const RT = () => runtime || (runtime = vm.runInThisContext(`(() => {${fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'vendor', 'vrm', 'three-vrm.min.js'), 'utf8')}; return PetVrmRuntime; })()`));

// A dance from keys given in MMD terms (MMD axes, as a VMD stores them), baked without thinning so every frame is a key.
function bake(bones, { morphs = [], ik = [], stage = false, last = 30, ...opts } = {}) {
  const all = [...bones];
  if (!all.some((k) => k.frame === last)) all.push({ name: 'センター', frame: last });
  if (!all.some((k) => k.name === '上半身')) all.push({ name: '上半身', frame: 0 }); // a dancer, not a prop
  const buf = VMD.writeVmd({ modelName: 'test', bones: all, morphs, ik });
  return R.retargetVmd(buf, { stage, staticDeg: -1, ...opts });
}
// a VRM bone's rotation / the hips position at time t
const rotAt = (clip, b, t = 0) => B.sampleTrack(clip.bones[b], t, true);
const hipsAt = (clip, t = 0) => B.sampleTrack(clip.hips, t, false);
// world position of the end of a VRM bone chain (reference rest positions, metres)
function fkPos(clip, chain, t = 0) {
  const rest = clip.rest;
  let p = hipsAt(clip, t);
  let q = rotAt(clip, 'hips', t);
  let prev = 'hips';
  for (const b of chain) {
    p = p.map((v, i) => v + W.qrot(q, sub(rest[b], rest[prev]))[i]);
    q = W.qmul(q, rotAt(clip, b, t));
    prev = b;
  }
  return p;
}
const ARM = (s) => ['spine', 'chest', 'upperChest', `${s}Shoulder`, `${s}UpperArm`, `${s}LowerArm`, `${s}Hand`];
const LEG = (s) => [`${s}UpperLeg`, `${s}LowerLeg`, `${s}Foot`];
const SHOULDER = (s) => ['spine', 'chest', 'upperChest', `${s}Shoulder`, `${s}UpperArm`];
// a reference joint in clip space (metres, the rest hips over the origin)
const refAt = (n, add = [0, 0, 0]) => [R.REF[n][0] + add[0] - R.REF.下半身[0], R.REF[n][1] + add[1], R.REF[n][2] + add[2] - R.REF.下半身[2]].map((v) => v * R.UNIT);
// MMD-axes rotation for a rotation written in our axes (the mirror is its own inverse)
const mmdQ = (q) => R.qToRH(q);

test('handedness (§2.6): MMD left-handed / faces −Z → ours right-handed / faces +Z, her left at +X', () => {
  assert.deepEqual(R.toRH([1, 2, 3]), [1, 2, -3]);
  assert.deepEqual(R.qToRH([0.1, 0.2, 0.3, 0.9]), [-0.1, -0.2, 0.3, 0.9]);
  // the reference skeleton after the change: left arm on +X, toes in front (+Z)
  assert.ok(R.REF.左腕[0] > 0 && R.REF.右腕[0] < 0);
  assert.ok(R.REF.左つま先[2] > R.REF.左足首[2], 'toes point forward (+Z)');
  // bowing in MMD (上半身 about x by −20° in MMD numbers: the head goes towards −Z, MMD's front) → the head moves to +Z
  const { clip } = bake([{ name: '上半身', frame: 0, rot: qx(-20) }]);
  const head = fkPos(clip, ['spine', 'chest', 'upperChest', 'neck', 'head']);
  const hips = hipsAt(clip);
  assert.ok(head[2] - hips[2] > 0.1, `she bows forward, towards the viewer: head z ${head[2].toFixed(3)} vs hips ${hips[2].toFixed(3)}`);
  // turning: センター about y by +30° in MMD numbers turns her the other way round in ours (y is negated) — the
  // mirror of a turn to her left is a turn to her left: her left hand ends up further back (−Z)
  const turn = bake([{ name: 'センター', frame: 0, rot: qy(30) }]).clip;
  const lh = fkPos(turn, ARM('left'));
  assert.ok(lh[2] > 0.05, `MMD +30° yaw (her right turn seen from the front) brings her left hand forward: z ${lh[2].toFixed(3)}`);
});

test('A-pose (§2.4): angle from the reference skeleton, all-zero keys hang the arms down, +θ makes the VRM arm level', () => {
  const th = R.aPoseDeg('left');
  assert.ok(th > 33 && th < 42, `reference A-pose ${th.toFixed(1)}° (not a hard-coded 30°)`);
  assert.ok(Math.abs(R.aPoseDeg('right') - th) < 1e-6);
  const zero = bake([{ name: '左腕', frame: 0 }, { name: '右腕', frame: 0 }]).clip;
  // standing still: the hips right over the origin at the rest height
  assert.ok(len(sub(hipsAt(zero), [0, zero.restHipsY, 0])) < 1e-9, `hips ${hipsAt(zero)}`);
  // no keys → the VRM arms are turned down by θ (an A, not a T)
  assert.ok(Math.abs(W.qangle(rotAt(zero, 'leftUpperArm'), ID) - th) < 0.01);
  assert.ok(Math.abs(W.qangle(rotAt(zero, 'leftLowerArm'), ID)) < 0.01, 'the forearm follows its parent, no extra bend');
  for (const s of ['left', 'right']) {
    const sh = fkPos(zero, SHOULDER(s));
    const hand = fkPos(zero, ARM(s));
    const drop = deg(Math.atan2(sh[1] - hand[1], Math.abs(hand[0] - sh[0])));
    assert.ok(Math.abs(drop - th) < 2, `${s} arm hangs ${drop.toFixed(1)}° below level`);
    assert.ok(s === 'left' ? hand[0] > sh[0] : hand[0] < sh[0], `${s} hand on its own side`);
  }
  // the key that lifts the MMD arm by exactly the A-pose → the VRM arm is level: identity
  const level = bake([{ name: '左腕', frame: 0, rot: mmdQ(W.qinv(R.A_POSE.left)) }, { name: '右腕', frame: 0, rot: mmdQ(W.qinv(R.A_POSE.right)) }]).clip;
  assert.ok(W.qangle(rotAt(level, 'leftUpperArm'), ID) < 1e-3);
  assert.ok(W.qangle(rotAt(level, 'rightUpperArm'), ID) < 1e-3);
  // a plain z turn by +θ (left) gets within a degree or two (the reference arm also leans forward a little)
  const approx = bake([{ name: '左腕', frame: 0, rot: mmdQ(qz(th)) }]).clip;
  assert.ok(W.qangle(rotAt(approx, 'leftUpperArm'), ID) < 3);
  // the hand / fingers carry the same A-pose both ways: a zero key is the identity in VRM
  assert.ok(W.qangle(rotAt(zero, 'leftHand'), ID) < 1e-6);
});

test('raising the left arm (左腕) lifts leftUpperArm with the hand on +X; the right arm mirrors it', () => {
  const up = 60; // degrees above the A-pose, i.e. above level
  const { clip } = bake([{ name: '左腕', frame: 0, rot: mmdQ(qz(up)) }, { name: '右腕', frame: 0, rot: mmdQ(qz(-up)) }]);
  for (const s of ['left', 'right']) {
    const sh = fkPos(clip, SHOULDER(s));
    const hand = fkPos(clip, ARM(s));
    assert.ok(hand[1] > sh[1] + 0.05, `${s} hand above the shoulder: ${hand[1].toFixed(3)} > ${sh[1].toFixed(3)}`);
    assert.ok(s === 'left' ? hand[0] > 0.2 : hand[0] < -0.2, `${s} hand x ${hand[0].toFixed(3)}`);
  }
});

test('bone map (§2.3): every VRM bone gets a track; twist bones fold into the arm; 上半身 under 下半身; thumb order', () => {
  // the map covers the humanoid: every target is a VRM bone the writer knows (IK targets / the root are notes)
  for (const [mmd, role] of Object.entries(R.BONE_ROLE)) {
    const vrm = role.split(' ')[0];
    assert.ok(W.VRM_PARENT[vrm] !== undefined, `${mmd} → ${role}`);
  }
  for (const b of B.VRM_REQUIRED) assert.ok(R.VRM_BONES.includes(b), `${b} is written`);
  assert.equal(R.VRM_BONES.length, 52);
  for (const n of ['センター', 'グルーブ', '腰', '下半身', '上半身', '上半身2', '上半身3', '首', '頭', '左肩P', '左肩', '左腕', '左腕捩', '左ひじ', '左手捩', '左手首', '左親指0', '左親指1', '左親指2', '左人指1', '左中指2', '左薬指3', '左小指1', '左足', '左ひざ', '左足首', '左つま先', '左足D', '左ひざD', '左足首D', '左足IK', '左つま先IK', '左足IK親']) {
    assert.ok(R.BONE_ROLE[n] || R.BONE_ROLE[n.replace('左', '右')], `${n} is read`);
    assert.ok(R.BONE_ROLE[n.replace(/^左/, '右')], `${n.replace(/^左/, '右')} is read`);
  }
  const twist = qaxisDeg(W.qrot(R.A_POSE.left, [1, 0, 0]), 40); // about the A-posed arm's own axis
  const { clip, report } = bake([
    { name: '下半身', frame: 0, rot: mmdQ(qy(15)) },
    { name: '上半身', frame: 0, rot: mmdQ(qx(10)) },
    { name: '左腕捩', frame: 0, rot: mmdQ(twist) },
    { name: '左ひじ', frame: 0, rot: mmdQ(qy(-30)) },
    { name: '左手捩', frame: 0, rot: mmdQ(qaxisDeg([1, 0, 0], 25)) },
    { name: '左親指0', frame: 0, rot: mmdQ(qx(5)) },
    { name: '左親指1', frame: 0, rot: mmdQ(qx(15)) },
    { name: '左親指2', frame: 0, rot: mmdQ(qx(25)) },
    { name: '左人指1', frame: 0, rot: mmdQ(qz(-20)) },
    { name: '前髪', frame: 0, rot: mmdQ(qx(10)) },
    { name: '左足先EX', frame: 0, rot: mmdQ(qx(12)) },
  ]);
  assert.equal(Object.keys(clip.bones).length, 52);
  // hips = 下半身; spine = 下半身⁻¹ · 上半身 (vidol left the spine at the identity)
  assert.ok(W.qangle(rotAt(clip, 'hips'), qy(15)) < 1e-4);
  assert.ok(W.qangle(rotAt(clip, 'spine'), W.qmul(W.qinv(qy(15)), qx(10))) < 1e-4);
  assert.ok(W.qangle(rotAt(clip, 'spine'), ID) > 5, 'the spine moves');
  assert.ok(W.qangle(rotAt(clip, 'leftToes'), qx(12)) < 1e-4, '足先EX → toes');
  // twist folded: upperArm = 腕 · 腕捩 · A
  assert.ok(W.qangle(rotAt(clip, 'leftUpperArm'), W.qmul(twist, R.A_POSE.left)) < 1e-4);
  const conj = (q) => W.qmul(W.qmul(W.qinv(R.A_POSE.left), q), R.A_POSE.left);
  assert.ok(W.qangle(rotAt(clip, 'leftLowerArm'), conj(W.qmul(qy(-30), qaxisDeg([1, 0, 0], 25)))) < 1e-4, 'ひじ · 手捩, in T-pose axes');
  // thumb 0/1/2 → metacarpal / proximal / distal (vidol had them one segment off)
  assert.ok(W.qangle(rotAt(clip, 'leftThumbMetacarpal'), conj(qx(5))) < 1e-4);
  assert.ok(W.qangle(rotAt(clip, 'leftThumbProximal'), conj(qx(15))) < 1e-4);
  assert.ok(W.qangle(rotAt(clip, 'leftThumbDistal'), conj(qx(25))) < 1e-4);
  assert.ok(W.qangle(rotAt(clip, 'leftIndexProximal'), conj(qz(-20))) < 1e-4);
  assert.ok(W.qangle(rotAt(clip, 'leftMiddleProximal'), ID) < 1e-6, 'a finger without keys stays at the VRM rest');
  // the right hand has no finger keys at all: relaxed (the L4 curl), not straight
  assert.ok(W.qangle(rotAt(clip, 'rightIndexProximal'), ID) > 1);
  assert.deepEqual(report.fingers, { left: 'keys', right: 'relaxed' });
  assert.deepEqual(report.bones.unmapped, ['前髪'], 'hair is not a humanoid bone: reported, not an error');
});

test('hips (§2.6): センター + グルーブ travel, Z mirrored, rest hips height from the reference, Bézier kept', () => {
  const ease = new Uint8Array(64);
  for (let c = 0; c < 4; c++) { ease[c] = 127; ease[c + 4] = 0; ease[c + 8] = 127; ease[c + 12] = 127; }
  const { clip } = bake([
    { name: 'センター', frame: 0, pos: [0, 0, 0] },
    { name: 'センター', frame: 30, pos: [10, -2, 5], interp: ease },
    { name: 'グルーブ', frame: 0, pos: [0, -1, 0] },
  ]);
  assert.ok(Math.abs(clip.restHipsY - R.MMD_REF.下半身.p[1] * R.UNIT) < 1e-9);
  const p0 = hipsAt(clip, 0);
  assert.ok(Math.abs(p0[1] - (R.MMD_REF.下半身.p[1] - 1) * R.UNIT) < 1e-6, 'グルーブ lowers her by 1 unit');
  const p1 = hipsAt(clip, 1);
  assert.ok(Math.abs(p1[0] - p0[0] - 10 * R.UNIT) < 1e-6, 'x: 10 units = 0.8 m');
  assert.ok(Math.abs(p1[2] - p0[2] + 5 * R.UNIT) < 1e-6, 'z mirrored: MMD +5 (backwards) → −0.4 m');
  assert.ok(Math.abs(p1[1] - p0[1] + 2 * R.UNIT) < 1e-6);
  const mid = hipsAt(clip, 0.5);
  assert.ok(mid[0] - p0[0] < 0.3 * 10 * R.UNIT, `the ease-in curve is kept at 30 fps (half time: ${((mid[0] - p0[0]) / R.UNIT).toFixed(2)} of 10 units)`);
});

// a leg's numbers from the clip: FK ankle, knee flexion and how far ahead of the hip–ankle line the knee is
function legInfo(clip, s, t = 0) {
  const hip = fkPos(clip, [`${s}UpperLeg`], t);
  const knee = fkPos(clip, [`${s}UpperLeg`, `${s}LowerLeg`], t);
  const ankle = fkPos(clip, LEG(s), t);
  const line = sub(ankle, hip).map((v) => v / len(sub(ankle, hip)));
  const off = sub(sub(knee, hip), line.map((v) => v * dot(sub(knee, hip), line)));
  const th = sub(knee, hip);
  const sh = sub(ankle, knee);
  const flex = deg(Math.acos(Math.max(-1, Math.min(1, dot(th, sh) / (len(th) * len(sh))))));
  return { hip, knee, ankle, flex, ahead: off[2] };
}

test('two-bone IK (§2.5): reachable targets are hit exactly, the knee only bends forward, out of reach → straight', () => {
  const rest = { hip: R.REF.左足, knee: R.REF.左ひざ, ankle: R.REF.左足首 };
  const a = len(sub(rest.knee, rest.hip));
  const b = len(sub(rest.ankle, rest.knee));
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 200; i++) {
    const dir = [rnd() - 0.5, -0.4 - rnd(), rnd() - 0.5];
    const n = len(dir);
    const d = (a + b) * (0.35 + 0.6 * rnd());
    const target = rest.hip.map((v, j) => v + (dir[j] / n) * d);
    const pole = [0.3 * (rnd() - 0.5), 0, 1];
    const r = R.solveLegIK({ hip: rest.hip, target, pole, rest });
    assert.ok(r.reach);
    const reached = rest.hip.map((v, j) => v + W.qrot(r.thigh, sub(rest.knee, rest.hip))[j] + W.qrot(r.shin, sub(rest.ankle, rest.knee))[j]);
    assert.ok(len(sub(reached, target)) * R.UNIT < 1e-6, `FK of the solution hits the target (< 1 µm): ${len(sub(reached, target)) * R.UNIT} m`);
    // the knee is on the pole's side of the hip–target line (bends forward, never backward)
    const line = sub(target, rest.hip).map((v) => v / d);
    const kOff = sub(sub(r.knee, rest.hip), line.map((v) => v * dot(sub(r.knee, rest.hip), line)));
    assert.ok(dot(kOff, pole) > 0, 'knee forward');
    // the knee joint is a hinge: the shin's turn relative to the thigh is about the knee's side axis
    const local = W.qmul(W.qinv(r.thigh), r.shin);
    const axisLen = Math.hypot(local[0], local[1], local[2]);
    if (axisLen > 0.05) assert.ok(Math.abs(local[0]) / axisLen > 0.97, `hinge about the leg's x axis: ${local.map((v) => v.toFixed(3))}`);
  }
  // out of reach: the leg points at the target, straight
  const far = rest.hip.map((v, j) => v + [0.2, -1, 0.3][j] * (a + b) * 2);
  const r = R.solveLegIK({ hip: rest.hip, target: far, pole: [0, 0, 1], rest });
  assert.equal(r.reach, false);
  assert.ok(W.qangle(W.qmul(W.qinv(r.thigh), r.shin), ID) < 0.1, 'straight');
  const toFar = sub(far, rest.hip).map((v) => v / len(sub(far, rest.hip)));
  assert.ok(dot(sub(r.ankle, rest.hip).map((v) => v / len(sub(r.ankle, rest.hip))), toFar) > 0.99999, 'reaching towards it');
});

test('foot IK in a dance: a squat (足ＩＫ down, センター down) bends both knees forward, ankles on the targets', () => {
  const { clip, report } = bake([
    { name: 'センター', frame: 0 },
    { name: 'センター', frame: 30, pos: [0, -3, 0] },
    { name: '左足ＩＫ', frame: 0 },
    { name: '左足ＩＫ', frame: 30, pos: [0, 0, 0] },
    { name: '右足ＩＫ', frame: 0 },
    { name: '右足ＩＫ', frame: 30, pos: [0, 0, 0] },
  ]);
  assert.equal(report.ik, 'on');
  assert.ok(report.ikStats.maxErrorMm < 1, `FK error ${report.ikStats.maxErrorMm} mm`);
  for (const s of ['left', 'right']) {
    const stand = legInfo(clip, s, 0);
    const squat = legInfo(clip, s, 1);
    assert.ok(stand.flex < 1, `${s} standing leg straight: ${stand.flex.toFixed(2)}°`);
    assert.ok(squat.flex > 30, `${s} knee bends in the squat: ${squat.flex.toFixed(1)}°`);
    assert.ok(squat.ahead > 0.05, `${s} knee in front (+Z): ${squat.ahead.toFixed(3)} m`);
    const j = s === 'left' ? '左' : '右';
    const target = refAt(`${j}足首`);
    assert.ok(len(sub(squat.ankle, target)) < 1e-3, `${s} ankle stays planted (${(len(sub(squat.ankle, target)) * 1000).toFixed(3)} mm)`);
    assert.ok(rotAt(clip, `${s}LowerLeg`, 1)[0] > 0, 'the knee turn is +x (shin back) in VRM axes');
  }
  // a foot stepped forward: 左足ＩＫ z −4 (MMD: towards the front) → the left ankle comes forward (+Z) and the knee leads
  const step = bake([{ name: 'センター', frame: 0, pos: [0, -1, 0] }, { name: '左足ＩＫ', frame: 0, pos: [0, 1.5, -4] }]).clip;
  const l = legInfo(step, 'left');
  assert.ok(l.ankle[2] > 0.25, `left ankle forward: z ${l.ankle[2].toFixed(3)}`);
  assert.ok(l.ahead > 0, 'knee forward');
  assert.ok(Math.abs(l.ankle[2] - refAt('左足首', [0, 0, 4])[2]) < 1e-3);
});

test('IK switches: off → the FK keys drive the leg; IK never animated but FK keys → FK (an FK-baked dance)', () => {
  const fkKeys = [{ name: '左足', frame: 0, rot: mmdQ(qx(-40)) }, { name: '左ひざ', frame: 0, rot: mmdQ(qx(70)) }];
  const off = bake([...fkKeys, { name: '左足ＩＫ', frame: 0, pos: [0, 2, 0] }, { name: '左足ＩＫ', frame: 30, pos: [0, 3, 0] }], { ik: [{ frame: 0, states: { '左足ＩＫ': false } }] });
  assert.ok(W.qangle(rotAt(off.clip, 'leftUpperLeg'), qx(-40)) < 1e-4, 'FK thigh');
  assert.ok(W.qangle(rotAt(off.clip, 'leftLowerLeg'), qx(70)) < 1e-4, 'FK knee');
  assert.equal(off.report.ik, 'mixed', 'left FK, right IK');
  const baked = bake([...fkKeys, { name: '左足ＩＫ', frame: 0 }, { name: '右足ＩＫ', frame: 0 }, { name: '右足', frame: 0, rot: mmdQ(qx(-10)) }], { ik: [{ frame: 0, states: { '左足ＩＫ': true, '右足ＩＫ': true } }] });
  assert.deepEqual(baked.report.legs, { left: 'fk (IK never animated)', right: 'fk (IK never animated)' });
  assert.ok(W.qangle(rotAt(baked.clip, 'leftLowerLeg'), qx(70)) < 1e-4);
  // the switch turning on mid-dance
  const mid = bake([...fkKeys, { name: '左足ＩＫ', frame: 0, pos: [0, 2, -1] }, { name: '左足ＩＫ', frame: 60, pos: [0, 2, -1] }], { last: 60, ik: [{ frame: 0, states: { '左足ＩＫ': false } }, { frame: 30, states: { '左足ＩＫ': true } }] });
  assert.ok(W.qangle(rotAt(mid.clip, 'leftLowerLeg', 0.5), qx(70)) < 1e-4, 'FK before frame 30');
  const l = legInfo(mid.clip, 'left', 1.5);
  const target = refAt('左足首', [0, 2, 1]); // MMD (0, 2, −1) in our axes
  assert.ok(len(sub(l.ankle, target)) < 1e-3, 'IK after it');
});

test('stage limit (§3.6): the slow drift is held near the centre, the rhythm kept, the feet shifted with the hips', () => {
  const H = R.MMD_REF.下半身.p[1];
  // she walks 40 units (3.2 m) to her left over 4 s while bouncing side to side ±1 unit at 2 Hz
  const keys = [];
  for (let f = 0; f <= 120; f += 2) {
    const x = (40 * f) / 120 + Math.sin((2 * Math.PI * 2 * f) / 30);
    keys.push({ name: 'センター', frame: f, pos: [x, 0, 0] });
    keys.push({ name: '左足ＩＫ', frame: f, pos: [x, 0, 0] }, { name: '右足ＩＫ', frame: f, pos: [x, 0, 0] });
  }
  const free = bake(keys, { last: 120 });
  const held = bake(keys, { last: 120, stage: {} });
  const R0 = 0.15 * H * R.UNIT;
  const maxX = (c) => Math.max(...Array.from({ length: 121 }, (_, i) => Math.abs(hipsAt(c, i / 30)[0])));
  assert.ok(maxX(free.clip) > 3, `unlimited: ${maxX(free.clip).toFixed(2)} m`);
  assert.ok(maxX(held.clip) < R0 + 0.35 * H * R.UNIT, `limited: ${maxX(held.clip).toFixed(3)} m`);
  assert.ok(held.report.stage.clampHits > 0.5);
  // the bounce survives: frame-to-frame motion in the middle of the walk is still there
  const wiggle = (c) => { let s = 0; for (let i = 40; i < 80; i++) s += Math.abs(hipsAt(c, (i + 1) / 30)[0] - hipsAt(c, i / 30)[0]); return s; };
  assert.ok(wiggle(held.clip) > 0.4 * wiggle(free.clip) - 0.001, 'the rhythm is kept');
  // the feet moved with the hips: the legs are as straight as before (no splits, no stretch), ankles under the hips
  for (const i of [30, 60, 90]) {
    const t = i / 30;
    for (const s of ['left', 'right']) {
      const l = legInfo(held.clip, s, t);
      assert.ok(l.flex < 2, `${s} leg at ${t}s: ${l.flex.toFixed(2)}°`);
      assert.ok(Math.abs(l.ankle[0] - l.hip[0]) < 0.02, 'ankle under the hip');
    }
  }
});

test('expressions (§2.9): あ → aa, 笑い → happy × 0.6, ウィンク → blinkLeft, unknown morphs reported; face: false drops them', () => {
  const morphs = [
    { name: 'あ', frame: 0, weight: 0 }, { name: 'あ', frame: 10, weight: 1 },
    { name: '笑い', frame: 0, weight: 1 },
    { name: 'ウィンク', frame: 0, weight: 0 }, { name: 'ウィンク', frame: 20, weight: 1 },
    { name: 'てへぺろ', frame: 0, weight: 1 },
    { name: 'い', frame: 0, weight: 0 }, // never on: not a track
  ];
  const { clip, report } = bake([], { morphs });
  assert.deepEqual(Object.keys(clip.expressions).sort(), ['aa', 'blinkLeft', 'happy']);
  assert.ok(Math.abs(B.sampleTrack({ times: clip.expressions.aa.times, values: clip.expressions.aa.values.map((v) => [v]) }, 10 / 30, false)[0] - 1) < 1e-6);
  assert.ok(Math.abs(clip.expressions.happy.values[0] - 0.6) < 1e-6);
  assert.deepEqual(report.morphs.unmapped, ['てへぺろ']);
  assert.equal(R.MORPH_MAP.ウィンク右[0], 'blinkRight');
  const none = bake([], { morphs, face: false });
  assert.deepEqual(Object.keys(none.clip.expressions), []);
});

test('the .vrma: passes inspectVrmaJson, loads in the app runtime, the mixer poses bones and expressions as baked', async () => {
  const buf = VMD.writeVmd({
    bones: [
      { name: 'センター', frame: 0 }, { name: 'センター', frame: 30, pos: [0, -2, 0] },
      { name: '上半身', frame: 0 }, { name: '左腕', frame: 0 }, { name: '左腕', frame: 30, rot: R.qToRH(qz(60)) },
      { name: '左足ＩＫ', frame: 0 }, { name: '右足ＩＫ', frame: 0 },
    ],
    morphs: [{ name: 'あ', frame: 0, weight: 0 }, { name: 'あ', frame: 30, weight: 1 }],
  });
  const { vrma, report, clip } = R.bakeVmd(buf, { name: 'test-dance' });
  const jl = vrma.readUInt32LE(12);
  const json = JSON.parse(vrma.subarray(20, 20 + jl).toString('utf8'));
  const check = V.inspectVrmaJson(json);
  assert.equal(check.ok, true);
  assert.equal(check.specVersion, '1.0');
  assert.equal(check.humanoid.length, 52);
  assert.deepEqual(check.expressions, ['aa']);
  assert.equal(report.duration, 1);
  assert.equal(report.frames, 31);
  assert.equal(report.bakedWith, 'vmd-retarget@1');
  const back = W.readVrma(vrma);
  assert.ok(back.tracks['hips.translation'] && back.tracks['expression.aa.translation']);
  assert.ok(back.json.nodes.filter((n) => json.extensions.VRMC_vrm_animation.humanoid.humanBones[n.name]).every((n) => !n.rotation), 'rest = identity (VRMA T-pose)');
  // the app's runtime
  const rt = RT();
  const T = rt.THREE;
  const loader = new rt.GLTFLoader();
  loader.register((parser) => new rt.VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.parseAsync(vrma.buffer.slice(vrma.byteOffset, vrma.byteOffset + vrma.length), '');
  const anim = gltf.userData.vrmAnimations[0];
  assert.ok(Math.abs(anim.restHipsPosition.y - clip.restHipsY) < 1e-6);
  assert.ok(Math.abs(anim.duration - 1) < 1e-6);
  assert.equal(anim.humanoidTracks.rotation.size, 52);
  assert.ok(anim.expressionTracks.preset.has('aa'));
  const root = new T.Object3D();
  const nodes = {};
  for (const b of ['hips', 'leftUpperArm']) { nodes[b] = new T.Object3D(); nodes[b].name = `n_${b}`; root.add(nodes[b]); }
  const exprHolder = { aa: 0 };
  const vrm = {
    scene: root,
    meta: { metaVersion: '1' },
    humanoid: { getNormalizedBoneNode: (n) => nodes[n] || null, normalizedRestPose: { hips: { position: [0, 2 * clip.restHipsY, 0] } } },
    expressionManager: { getExpressionTrackName: (n) => (n === 'aa' ? 'exprAa.weight' : null) },
    lookAt: null,
  };
  const exprNode = new T.Object3D();
  exprNode.name = 'exprAa';
  Object.defineProperty(exprNode, 'weight', { get: () => exprHolder.aa, set: (v) => { exprHolder.aa = v; } });
  root.add(exprNode);
  const tc = rt.createVRMAnimationClip(anim, vrm);
  const mixer = new T.AnimationMixer(root);
  mixer.clipAction(tc).play();
  const t = 0.9; // (at exactly the duration a repeating action wraps to 0)
  mixer.update(t);
  assert.ok(W.qangle(nodes.leftUpperArm.quaternion.toArray(), rotAt(clip, 'leftUpperArm', t)) < 0.05, 'arm as baked');
  assert.ok(W.qangle(nodes.leftUpperArm.quaternion.toArray(), rotAt(clip, 'leftUpperArm', 0)) > 40, 'and it moved from the first frame');
  // the hips travel scaled to the model: a model with twice the hips height moves twice as far
  const dy = nodes.hips.position.y - 2 * hipsAt(clip, t)[1];
  assert.ok(Math.abs(dy) < 1e-4, `hips scaled by the model's hips height (${nodes.hips.position.y} vs ${2 * hipsAt(clip, t)[1]})`);
  assert.ok(Math.abs(exprHolder.aa - t) < 1e-3, `the mouth opens with あ: ${exprHolder.aa}`);
});

test('refusals: a camera VMD, a prop, an empty file are not dances', () => {
  assert.throws(() => R.retargetVmd(VMD.writeVmd({ cameras: [{ frame: 0 }] })), (e) => e.code === 'vmd-camera');
  assert.throws(() => R.retargetVmd(VMD.writeVmd({ bones: [{ name: '椅子', frame: 0 }] })), (e) => e.code === 'vmd-prop');
  assert.throws(() => R.retargetVmd(VMD.writeVmd({})), (e) => e.code === 'vmd-empty');
});

test('the bake core keeps its exports: the shared writer is the same function (no second copy)', () => {
  assert.equal(B.writeVrma, W.writeVrma);
  assert.equal(B.readVrma, W.readVrma);
  assert.equal(B.qslerp, W.qslerp);
  assert.equal(B.VRM_PARENT, W.VRM_PARENT);
});
