'use strict';
// The motion bake (scripts/lib/vrm-bake-core.js, docs/vrm-motion-system.md §3.7) and the clip layers that play
// it (src/renderer/vrm-anim.js): retargeting maths, Mixamo bone names, trim / loop / hold / mirror / amplitude /
// centring, the .vrma writer — checked with the app's own vendored three-vrm-animation loader — and the
// cross-fade, run on the real AnimationMixer: weights always add up to 1, so no T-pose shows mid-fade.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const B = require('../scripts/lib/vrm-bake-core');
const V = require('../src/core/vrm');
const M = require('../src/core/vrm-motion');

const ROOT = path.join(__dirname, '..');
const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps) || a.every((v, i) => Math.abs(v + b[i]) < eps);
const qz = (deg) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];
const qy = (deg) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
let runtime = null;
const R = () => runtime || (runtime = vm.runInThisContext(`(() => {${fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'vendor', 'vrm', 'three-vrm.min.js'), 'utf8')}; return PetVrmRuntime; })()`));

// a two-bone clip: hips (+ translation) and the left upper arm
function clip(armKeys, { times = null, hipsY = 0.9 } = {}) {
  const t = times || armKeys.map((_, i) => i);
  const id = [0, 0, 0, 1];
  return {
    duration: t[t.length - 1],
    bones: { hips: { times: t.slice(), values: t.map(() => id) }, leftUpperArm: { times: t.slice(), values: armKeys } },
    hips: { times: t.slice(), values: t.map((_, i) => [0.1 + i * 0.01, hipsY, 0.02]) },
    restHipsY: hipsY,
    rest: { hips: [0, hipsY, 0], leftUpperArm: [0.2, 1.4, 0] },
  };
}

test('retargeting: identity rests keep the key; a rotated rest is carried into world axes', () => {
  const q = B.qnorm([0.1, 0.2, 0.3, 0.9]);
  assert.ok(near(B.retargetQ(q, [0, 0, 0, 1], [0, 0, 0, 1]), q));
  // a bone whose rest is turned 90° about y (parent unturned): a key equal to its rest is no rotation in VRM terms
  assert.ok(near(B.retargetQ(qy(90), [0, 0, 0, 1], qy(90)), [0, 0, 0, 1]));
  // parent rest P, own rest W = P·r: q = r·d  →  P·r·d·r⁻¹·P⁻¹ (the delta d seen in world axes)
  const P = qz(30);
  const r = qy(40);
  const d = qz(-25);
  const got = B.retargetQ(B.qmul(r, d), P, B.qmul(P, r));
  const want = B.qmul(B.qmul(B.qmul(P, r), d), B.qinv(B.qmul(P, r)));
  assert.ok(near(got, B.qnorm(want)));
  assert.ok(Math.abs(B.qangle(got, [0, 0, 0, 1]) - 25) < 1e-6, 'the size of the turn is kept');
});

test('Mixamo names → VRM humanoid: every required bone, fingers, the mixamorig prefixes', () => {
  const mapped = new Set(Object.values(B.MIXAMO_TO_VRM));
  for (const b of B.VRM_REQUIRED) assert.ok(mapped.has(b), b);
  for (const n of ['mixamorig:Hips', 'mixamorigHips', 'mixamorig1:Hips']) assert.equal(B.vrmBoneOf(n), 'hips');
  assert.equal(B.vrmBoneOf('mixamorigLeftHandPinky2'), 'leftLittleIntermediate');
  assert.equal(B.vrmBoneOf('mixamorigRightHandThumb1'), 'rightThumbMetacarpal');
  assert.equal(B.vrmBoneOf('mixamorigHeadTop_End'), null);
  for (const b of mapped) assert.ok(B.VRM_PARENT[b] !== undefined, `${b} has a place in the tree`);
});

test('bake parameters: trim, hold, loop, mirror, amplitude, in place, centring', () => {
  const c = clip([qz(-70), qz(-50), qz(-30), qz(-60), qz(-72)], { times: [0, 1, 2, 3, 4] });
  const t = B.trimClip(c, 1.5, 3.5);
  assert.equal(t.duration, 2);
  assert.ok(Math.abs(B.qangle(B.sampleTrack(t.bones.leftUpperArm, 0, true), qz(-40))) < 1e-6, 'starts at the cut');
  const h = B.holdClip(c, 1);
  assert.deepEqual(h.bones.leftUpperArm.times, [0, 1]);
  assert.ok(near(h.bones.leftUpperArm.values[1], qz(-70)), 'a pose: the first frame held');
  const l = B.loopClip(c, 1);
  assert.ok(near(l.bones.leftUpperArm.values[4], qz(-70)), 'the end meets the start');
  assert.ok(near(l.bones.leftUpperArm.values[2], qz(-30)), 'before the blend: untouched');
  const m = B.mirrorClip(c);
  assert.ok(m.bones.rightUpperArm && !m.bones.leftUpperArm);
  assert.ok(near(m.bones.rightUpperArm.values[0], qz(70)), 'a left arm down is a right arm down');
  assert.equal(m.hips.values[0][0], -c.hips.values[0][0]);
  assert.ok(near(B.mirrorClip(m).bones.leftUpperArm.values[2], c.bones.leftUpperArm.values[2]), 'mirror twice = the clip');
  const a = B.amplitudeClip(c, 0.5);
  assert.ok(Math.abs(B.qangle(a.bones.leftUpperArm.values[2], qz(-50))) < 1e-6, 'half the way from the first frame');
  const ip = B.inPlaceClip(c);
  assert.ok(ip.hips.values.every((p) => p[0] === c.hips.values[0][0] && p[2] === c.hips.values[0][2]));
  const ce = B.centerClip(c);
  const mean = ce.hips.values.reduce((s, p) => s + p[0], 0) / ce.hips.values.length;
  assert.ok(Math.abs(mean) < 1e-9 && Math.abs(ce.hips.values[4][0] - ce.hips.values[0][0] - 0.04) < 1e-9, 'centred, the sway kept');
  // the library entry decides: a posture is held, an idle is looped and centred
  assert.equal(B.bakeParams(c, { kind: 'posture' }).duration, 1);
  const idle = B.bakeParams(c, { kind: 'idle', loop: true, mirror: true, amplitude: 0.8, trim: [0, 4] });
  assert.ok(idle.bones.rightUpperArm && Math.abs(idle.hips.values.reduce((s, p) => s + p[0], 0)) < 1e-9);
});

test('loop seam: the end eases into the start slowly enough for the gap (no 40° head snap every loop, T-2684)', () => {
  const times = Array.from({ length: 211 }, (_, i) => i / 30); // 7 s at 30 fps
  const turn = (t) => qz(-20 + (40 * t) / 7); // drifts 40° over the clip: the end is 40° from the start
  const c = clip(times.map(turn), { times });
  assert.ok(Math.abs(B.seamAngle(c) - 40) < 0.5, `seam ${B.seamAngle(c)}`);
  assert.ok(Math.abs(B.seamBlend(c) - 40 / B.SEAM_SPEED) < 0.02, 'blend = gap / speed');
  assert.equal(B.seamBlend(clip(times.map(() => qz(-70)), { times })), 0.25, 'a matching seam keeps the short blend');
  assert.ok(Math.abs(B.seamBlend(clip([qz(0), qz(170)], { times: [0, 1.5] })) - 0.5) < 1e-9, 'at most a third of the clip');
  const l = B.bakeParams(c, { kind: 'idle', loop: true, center: false });
  const v = l.bones.leftUpperArm.values;
  assert.ok(near(v[v.length - 1], v[0]), 'the end meets the start');
  let fastest = 0;
  for (let i = 1; i < v.length; i++) fastest = Math.max(fastest, B.qangle(v[i], v[i - 1]) * 30);
  // smoothstep peaks at 1.5× its mean slope: the blend never turns a bone faster than 1.5 × SEAM_SPEED
  assert.ok(fastest <= B.SEAM_SPEED * 1.5 + 1, `fastest turn ${fastest.toFixed(1)}°/s`);
  // the old fixed 0.25 s blend turned it at ~240°/s
  const old = B.loopClip(c, 0.25).bones.leftUpperArm.values;
  let oldFast = 0;
  for (let i = 1; i < old.length; i++) oldFast = Math.max(oldFast, B.qangle(old[i], old[i - 1]) * 30);
  assert.ok(oldFast > 200, `fixed 0.25 s blend: ${oldFast.toFixed(0)}°/s`);
});

test('the .vrma: a glTF the app accepts (inspectVrmaJson) and three-vrm-animation plays as written', async () => {
  const c = clip([qz(-72), qz(-40), qz(-72)], { times: [0, 0.5, 1] });
  const buf = B.writeVrma(c, { name: 't' });
  assert.equal(buf.readUInt32LE(0), 0x46546c67);
  const json = V.readGlbJson(buf);
  const info = V.inspectVrmaJson(json);
  assert.equal(info.ok, true);
  assert.deepEqual(info.humanoid.sort(), ['hips', 'leftUpperArm']);
  const back = B.readVrma(buf);
  assert.deepEqual(back.tracks['leftUpperArm.rotation'].times, [0, 0.5, 1]);
  assert.ok(back.json.nodes.every((n) => !n.rotation), 'the rest pose is the identity (VRMA T-pose)');
  // the app's runtime loads it and the mixer poses the arm as baked
  const RT = R();
  const T = RT.THREE;
  const loader = new RT.GLTFLoader();
  loader.register((parser) => new RT.VRMAnimationLoaderPlugin(parser));
  const gltf = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '');
  const anim = gltf.userData.vrmAnimations[0];
  assert.ok(Math.abs(anim.restHipsPosition.y - 0.9) < 1e-6);
  const root = new T.Object3D();
  const arm = new T.Object3D();
  arm.name = 'leftUpperArm';
  const hips = new T.Object3D();
  hips.name = 'hips';
  root.add(hips, arm);
  const nodeOf = (n) => ({ leftUpperArm: arm, hips }[n] || null);
  const vrm = { scene: root, meta: { metaVersion: '1' }, humanoid: { getNormalizedBoneNode: nodeOf, normalizedRestPose: { hips: { position: [0, 0.9, 0] } } }, expressionManager: null, lookAt: null };
  const tc = RT.createVRMAnimationClip(anim, vrm);
  const mixer = new T.AnimationMixer(root);
  mixer.clipAction(tc).play();
  mixer.update(0.5);
  assert.ok(Math.abs(B.qangle(arm.quaternion.toArray(), qz(-40))) < 0.01, `arm at 0.5 s: ${arm.quaternion.toArray()}`);
});

// the renderer's clip layers (an IIFE on window) with the vendored runtime; clips are held poses baked by
// writeVrma and loaded the way the app loads them
async function animLayers(keep = ['leftUpperArm']) {
  const ctx = { window: { PetVrmMotion: M } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'vrm-anim.js'), 'utf8'), ctx);
  const RT = R();
  const T = RT.THREE;
  const root = new T.Object3D();
  const arm = new T.Object3D();
  arm.name = 'leftUpperArm';
  const hipsN = new T.Object3D();
  hipsN.name = 'hips';
  root.add(hipsN, arm);
  const nodeOf = (n) => ({ leftUpperArm: arm, hips: hipsN }[n] || null);
  const vrm = { scene: root, meta: { metaVersion: '1' }, humanoid: { getNormalizedBoneNode: nodeOf, normalizedRestPose: { hips: { position: [0, 0.9, 0] } } }, expressionManager: null, lookAt: null };
  const hold = async (deg) => {
    const buf = B.writeVrma(B.holdClip(clip([qz(deg), qz(deg)]), 1));
    const loader = new RT.GLTFLoader();
    loader.register((parser) => new RT.VRMAnimationLoaderPlugin(parser));
    const g = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '');
    return RT.createVRMAnimationClip(g.userData.vrmAnimations[0], vrm);
  };
  return { layers: ctx.window.PetVrmAnim.createAnimLayers(RT, vrm, keep), arm, hold, T };
}
const armAngle = (arm) => (2 * Math.acos(Math.min(1, Math.abs(arm.quaternion.w))) * 180) / Math.PI;

test('cross-fade on the real mixer: the first clip at once, weights sum to 1 throughout, never towards the T-pose', async () => {
  const { layers, arm, hold } = await animLayers();
  layers.add('down', await hold(-72));
  layers.add('out', await hold(-40));
  layers.add('mid', await hold(-60));
  assert.equal(layers.setBase('nope', 1), false, 'an unknown clip is refused, nothing breaks');
  layers.setBase('down', 1);
  layers.update(1 / 30);
  assert.ok(Math.abs(armAngle(arm) - 72) < 0.01, `first frame already the clip (no fade from the T-pose): ${armAngle(arm)}`);
  layers.setBase('out', 1);
  const seen = [];
  for (let i = 0; i < 45; i++) {
    if (i === 15) layers.setBase('mid', 1); // re-targeted mid-fade
    layers.update(1 / 30);
    assert.ok(Math.abs(layers.weightSum() - 1) < 1e-9, `weights ${layers.summary()}`);
    seen.push(armAngle(arm));
  }
  assert.ok(Math.min(...seen) >= 40 - 0.01 && Math.max(...seen) <= 72 + 0.01, `the arm stays between the poses: ${Math.min(...seen).toFixed(1)}–${Math.max(...seen).toFixed(1)}°`);
  for (let i = 0; i < 40; i++) layers.update(1 / 30);
  assert.equal(layers.summary(), 'mid:1.00');
  assert.equal(layers.fading(), false);
  assert.ok(Math.abs(armAngle(arm) - 60) < 0.01);
});

test('a held pose with the alive layer on top: the offset does not pile up over 10 minutes (no drift)', async () => {
  const { layers, arm, hold, T } = await animLayers();
  layers.add('down', await hold(-72));
  layers.setBase('down', 0);
  const off = new T.Quaternion().setFromEuler(new T.Euler(0, 0, (3 * Math.PI) / 180));
  for (let i = 0; i < 12 * 600; i++) { layers.update(1 / 12); arm.quaternion.multiply(off); }
  assert.ok(Math.abs(armAngle(arm) - 69) < 0.01, `after 10 min at 12 fps: ${armAngle(arm).toFixed(2)}° (clip 72° − offset 3°)`);
});
