'use strict';
// T-5092: the automatic posture guard (scripts/lib/vrm-pose-guard.js) and the MMD arm fixes it found — 肩C cancelling
// 肩P for the arm (src/core/vmd-retarget.js), standmix2's level-arm stretch trimmed out of the idle index — checked on
// clips built here (no assets needed); with the baked library on this machine (~/vrm-assets/baked-v2) the whole
// library too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('../scripts/lib/vrm-pose-guard');
const VMD = require('../src/core/vmd');
const R = require('../src/core/vmd-retarget');
const W = require('../src/core/vrma-write');
const B = require('../scripts/lib/vrm-bake-core');
const L = require('../src/core/vrm-library');
const Sel = require('../scripts/vrm-motion-select');

const ROOT = path.join(__dirname, '..');
const rad = (d) => (d * Math.PI) / 180;
const qx = (d) => W.qaxis([1, 0, 0], rad(d));
const qy = (d) => W.qaxis([0, 1, 0], rad(d));
const qz = (d) => W.qaxis([0, 0, 1], rad(d));
const ID = [0, 0, 0, 1];
// a clip holding one pose for `seconds` (VRM normalized: identity = the T-pose)
const held = (pose, seconds = 1) => ({ duration: seconds, bones: Object.fromEntries(Object.entries(pose).map(([b, q]) => [b, { times: [0, seconds], values: [q, q] }])) });
// arms hanging by `down` degrees from level (the left arm along +X turns down about +Z by −θ, the right mirrored)
const arms = (down, extra = {}) => ({ leftUpperArm: qz(-down), rightUpperArm: qz(down), ...extra });

test('pose guard: the T-pose and arms held level (to the side or in front) are hits; hanging, overhead, folded forearms, a bow are not', () => {
  const at = (pose) => G.armsAt(held(pose).bones, 0.5);
  // the T-pose itself: both arms level (down 90° from the torso and the vertical), elbows straight
  const t = at({});
  assert.ok(Math.abs(t.left.down - 90) < 1e-6 && Math.abs(t.right.vert - 90) < 1e-6 && t.left.elbow < 1e-6);
  assert.equal(G.checkClip(held({})).suspect, true, 'T-pose');
  assert.equal(G.checkClip(held(arms(75))).suspect, false, 'arms hanging 15° from the body');
  assert.equal(G.checkClip(held(arms(10))).suspect, true, 'arms 10° below level: still "near horizontal" (> 75° from vertical)');
  // both arms straight out in front, level (the standmix2 stretch): a hit too
  const front = { leftUpperArm: qy(-90), rightUpperArm: qy(90) };
  const f = at(front);
  assert.ok(f.left.side < 0.05 && Math.abs(f.left.down - 90) < 1e-6, `in front: side ${f.left.side}`);
  assert.equal(G.checkClip(held(front)).suspect, true, 'arms held level in front');
  // arms straight up (a cheer): not level
  assert.equal(G.checkClip(held(arms(-70))).suspect, false, 'over the head');
  // level upper arms with the forearms folded up to the head: hands at the head, not a T
  assert.equal(G.checkClip(held({ leftUpperArm: ID, rightUpperArm: ID, leftLowerArm: qy(-120), rightLowerArm: qy(120) })).suspect, false, 'forearms folded');
  // a deep bow with the arms hanging straight down: level to the torso, not to the world
  const bow = at({ spine: qx(60), leftUpperArm: W.qmul(qx(-60), qz(-90)), rightUpperArm: W.qmul(qx(-60), qz(90)) });
  assert.ok(bow.left.down > 50 && bow.left.vert < 5, `bow: ${bow.left.down.toFixed(0)}° from the torso, ${bow.left.vert.toFixed(0)}° from the vertical`);
  assert.equal(G.checkClip(held({ spine: qx(60), leftUpperArm: W.qmul(qx(-60), qz(-90)), rightUpperArm: W.qmul(qx(-60), qz(90)) })).suspect, false, 'a bow');
  // a pass through level shorter than holdS: counted frames, not a hit
  const sweep = { duration: 0.5, bones: { leftUpperArm: { times: [0, 0.5], values: [qz(-80), qz(80)] }, rightUpperArm: { times: [0, 0.5], values: [qz(80), qz(-80)] } } };
  const s = G.checkClip(sweep);
  assert.ok(s.tposeFrames > 0 && s.longestS < G.TPOSE.holdS && !s.suspect, JSON.stringify(s));
  // a one-sided wave is never a T-pose
  assert.equal(G.checkClip(held({ leftUpperArm: ID, rightUpperArm: qz(80) })).suspect, false, 'one arm');
});

test('pose guard reads clips back from .vrma and sums a library: hits, armsOut within its maxS allowed, every kind counted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-guard-'));
  const write = (file, clip0) => { const clip = { ...clip0, bones: { hips: { times: [0, clip0.duration], values: [ID, ID] }, ...clip0.bones } }; fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), B.writeVrma({ ...clip, hips: null, restHipsY: 1, rest: {} }, { name: 'x' })); };
  write('female/idle.ok.vrma', held(arms(75), 2));
  write('female/idle.tpose.vrma', held({}, 2));
  write('dances/d1/dance.vrma', held({}, 0.5));
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ clips: {
    'idle.ok@female': { kind: 'idle', category: 'idle', style: 'female', file: 'female/idle.ok.vrma', src: 'motions/x.vmd' },
    'idle.tpose@female': { kind: 'idle', category: 'idle', style: 'female', file: 'female/idle.tpose.vrma', src: 'mixamo/y.fbx' },
  } }));
  fs.mkdirSync(path.join(dir, 'dances'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'dances', 'library.json'), JSON.stringify({ dances: { d1: { file: 'd1/dance.vrma', src: { motion: 'd.vmd' }, armsOut: { maxS: 1, why: 'a figure' } } } }));
  const sum = G.checkLibrary(dir);
  assert.equal(sum.clips, 3);
  assert.deepEqual(sum.hitList.map((r) => r.id), ['idle.tpose@female']);
  assert.deepEqual(sum.allowedList.map((r) => r.id), ['d1']);
  assert.equal(sum.byKind.idle.vmd, 1);
  assert.equal(sum.byKind.idle.mixamo, 1);
  const lines = G.formatReport(sum);
  assert.match(lines[lines.length - 1], /1 T-pose hit, 1 stiff hit in 3 clips — FAILED/, 'a held T-pose is stiff with its arms out too');
  // the bake's guard: armsOut covers runs up to its maxS only
  const { poseGuard } = require('../scripts/vrm-bake');
  const g = poseGuard(dir, dir, { clips: {}, dances: {} });
  assert.equal(g.sum.hits, 1);
  fs.writeFileSync(path.join(dir, 'dances', 'library.json'), JSON.stringify({ dances: { d1: { file: 'd1/dance.vrma', src: { motion: 'd.vmd' }, armsOut: { maxS: 0.2, why: 'too short' } } } }));
  assert.equal(poseGuard(dir, dir, { clips: {}, dances: {} }).sum.hits, 2, 'a run longer than maxS is a hit again');
});

test('T-5098 pose guard: arms held out stiff (penguin_stand) — ≥ 35° out to the side, elbows open, still ≥ 2 s; moving, folded, seated or annotated is not a hit', () => {
  // penguin_stand: both upper arms ~50° out from hanging (40° below level), held 10 s
  const penguin = G.checkClip(held(arms(40), 10), { kind: 'idle' });
  assert.equal(penguin.suspect, false, 'not a T-pose');
  assert.equal(penguin.stiff, true, JSON.stringify(penguin));
  assert.ok(penguin.stiffS >= 9.9 && Math.abs(penguin.stiffOutDeg - 50) < 0.5, JSON.stringify(penguin));
  // the arms hanging (15° out) still for 10 s: a calm idle, not stiff
  assert.equal(G.checkClip(held(arms(75), 10), { kind: 'idle' }).stiff, false);
  // the same spread, but swinging ±20° every second: moving, not stiff
  const t = []; const L = []; const Rr = [];
  for (let i = 0; i <= 40; i++) { t.push(i * 0.25); const d = 40 + 20 * Math.sin(i * Math.PI / 2); L.push(qz(-d)); Rr.push(qz(d)); }
  assert.equal(G.checkClip({ duration: 10, bones: { leftUpperArm: { times: t, values: L }, rightUpperArm: { times: t, values: Rr } } }, { kind: 'idle' }).stiff, false, 'swinging');
  // shorter than holdS: not a hit
  assert.equal(G.checkClip(held(arms(40), 1.5), { kind: 'reaction' }).stiff, false);
  // hands on the hips (elbows bent 90°): a rest pose, not arms held out
  assert.equal(G.checkClip(held(arms(40, { leftLowerArm: qy(-90), rightLowerArm: qy(90) }), 10), { kind: 'idle' }).stiff, false, 'akimbo');
  // arms forward (reaching to the knees): not spread to the side
  assert.equal(G.checkClip(held({ leftUpperArm: W.qmul(qy(-60), qz(-40)), rightUpperArm: W.qmul(qy(60), qz(40)) }, 10), { kind: 'idle' }).stiff, false, 'forward');
  // a posture (one held pose, 1 s) with the arms out is stiff, standing or kneeling; leaning back on bent arms is not
  assert.equal(G.checkClip(held(arms(40), 1), { kind: 'posture', group: 'stand' }).stiff, true);
  assert.equal(G.checkClip(held(arms(40), 1), { kind: 'posture', group: 'crouch' }).stiff, true);
  assert.equal(G.checkClip(held(arms(40, { leftLowerArm: qy(-120), rightLowerArm: qy(120) }), 1), { kind: 'posture', group: 'sit' }).stiff, false);
  // a dance annotated armsOut.stiffS covers a hold up to that long (reported as allowed)
  const row = { id: 'd', kind: 'dance', src: 'd.vmd', ...G.checkClip(held(arms(40), 2.2), { kind: 'dance' }) };
  assert.equal(G.summarize([{ ...row, armsOut: { maxS: 0.5, stiffS: 2.4, why: 'a figure' } }]).stiffHits, 0);
  assert.equal(G.summarize([{ ...row, armsOut: { maxS: 0.5, stiffS: 1, why: 'too short' } }]).stiffHits, 1);
  assert.equal(G.summarize([row]).stiffHits, 1);
});

// MMD keys (MMD axes) for a dance written with the VMD writer
const mmdQ = (q) => R.qToRH(q);
function bakeVmd(bones, last = 30) {
  const all = [...bones, { name: 'センター', frame: last }, { name: '上半身', frame: 0 }];
  return VMD.writeVmd({ modelName: 'test', bones: all, morphs: [], ik: [] });
}

test('MMD 肩P / 肩C (T-5092): a lifted shoulder P moves the shoulder, not the whole arm — the arm keeps its direction', () => {
  const none = R.retargetVmd(bakeVmd([{ name: '左腕', frame: 0 }]), { stage: false, staticDeg: -1 }).clip;
  const lift = R.retargetVmd(bakeVmd([{ name: '左肩P', frame: 0, rot: mmdQ(qz(40)) }, { name: '右肩P', frame: 0, rot: mmdQ(qz(-40)) }]), { stage: false, staticDeg: -1 }).clip;
  const chain = (clip, bones) => bones.reduce((q, b) => W.qmul(q, B.sampleTrack(clip.bones[b], 0, true)), ID);
  for (const s of ['left', 'right']) {
    const arm = (clip) => W.qrot(chain(clip, ['chest', 'upperChest', `${s}Shoulder`, `${s}UpperArm`]), [s === 'left' ? 1 : -1, 0, 0]);
    const a0 = arm(none); const a1 = arm(lift);
    const ang = (Math.acos(Math.min(1, a0[0] * a1[0] + a0[1] * a1[1] + a0[2] * a1[2])) * 180) / Math.PI;
    assert.ok(ang < 1e-3, `${s}: the upper arm points the same way with 肩P lifted (${ang.toFixed(3)}° apart)`);
    assert.ok(W.qangle(B.sampleTrack(lift.bones[`${s}Shoulder`], 0, true), ID) > 39, `${s}: the shoulder takes 肩P`);
  }
  assert.equal(R.BAKED_WITH, 'vmd-retarget@2');
});

test('MMD arm check: the bake equals an independent MMD forward kinematics (A-pose, twist bones, 肩P/肩C, the mirror)', () => {
  const twist = W.qaxis(W.qrot(R.A_POSE.left, [1, 0, 0]), rad(35));
  const buf = bakeVmd([
    { name: '上半身2', frame: 0, rot: mmdQ(qx(8)) }, { name: '上半身2', frame: 30, rot: mmdQ(qy(-12)) },
    { name: '左肩P', frame: 0, rot: mmdQ(qz(25)) }, { name: '左肩P', frame: 30, rot: mmdQ(qz(-10)) },
    { name: '左肩', frame: 0, rot: mmdQ(qz(10)) },
    { name: '左腕', frame: 0, rot: mmdQ(qz(-40)) }, { name: '左腕', frame: 30, rot: mmdQ(W.qmul(qy(30), qz(50))) },
    { name: '左腕捩', frame: 0, rot: mmdQ(twist) },
    { name: '左ひじ', frame: 0, rot: mmdQ(qy(-70)) }, { name: '左ひじ', frame: 30, rot: mmdQ(qy(-20)) },
    { name: '左手捩', frame: 0, rot: mmdQ(W.qaxis([1, 0, 0], rad(30))) },
    { name: '右肩P', frame: 15, rot: mmdQ(qz(-30)) }, { name: '右腕', frame: 15, rot: mmdQ(qz(45)) }, { name: '右ひじ', frame: 15, rot: mmdQ(qy(60)) },
  ]);
  const r = G.vmdArmCheck(buf, { step: 1 });
  assert.ok(r.samples >= 60, JSON.stringify(r));
  assert.ok(r.maxUpperDeg < 0.5 && r.maxForeDeg < 0.5, `bake vs MMD FK: ${JSON.stringify(r)}`);
});

test('standmix2 (idle.v01@female / @neutral, idle.v03@male) starts after its level-arm stretch; every style keeps ≥ 6 idles; armsOut is bounded', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-motion-index.json'), 'utf8'));
  const sm = Object.entries(idx.clips).filter(([, e]) => /standmix2/.test(e.src || ''));
  assert.deepEqual(sm.map(([id]) => id).sort(), ['idle.v01@female', 'idle.v01@neutral', 'idle.v03@male']);
  for (const [id, e] of sm) assert.ok(e.trim[0] >= 7.3 && e.duration > 20, `${id}: trim ${e.trim}, ${e.duration} s`);
  for (const style of L.SETS) {
    const n = Object.values(idx.clips).filter((e) => e.kind === 'idle' && e.style === style && e.src).length;
    assert.ok(n >= 6, `${style}: ${n} idle clips`);
  }
  for (const [id, a] of Object.entries(Sel.ARMS_OUT)) {
    assert.ok(idx.dances[id], `${id} is a dance of the index`);
    assert.deepEqual(idx.dances[id].armsOut, a);
    assert.ok(a.maxS > 0 && a.maxS <= 2 && a.why, `${id}: bounded with a reason`);
  }
  // besides dances, only the reactions named by source are waived — never an idle, posture, talk or walk
  for (const e of Object.values(idx.clips)) if (e.armsOut) assert.ok(Sel.ARMS_OUT_SRC[e.src] && e.kind === 'reaction', `${e.src}`);
  assert.ok(Object.values(idx.clips).some((e) => e.armsOut));
});

const LIB = path.join(os.homedir(), 'vrm-assets', 'baked-v2');
test('the baked library on this machine: 0 T-pose hits over every clip and dance (skipped without ~/vrm-assets/baked-v2)', { skip: !fs.existsSync(path.join(LIB, 'library.json')) }, () => {
  const sum = G.checkLibrary(LIB);
  for (const r of sum.rows) if (r.suspect && r.armsOut && !(r.longestS <= r.armsOut.maxS)) r.armsOut = null;
  const s2 = G.summarize(sum.rows);
  assert.ok(s2.clips >= 300, `${s2.clips} clips`);
  assert.equal(s2.hits, 0, G.formatReport(s2).join('\n'));
  for (const k of ['posture', 'idle', 'reaction', 'emotion', 'talk', 'walk', 'dance']) assert.ok(s2.byKind[k] && s2.byKind[k].clips > 0, k);
  assert.equal(s2.byKind.idle.levelFrames, 0, 'no idle frame with both arms over 75° from the vertical');
});
