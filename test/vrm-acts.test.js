'use strict';
// 吃饭 / 玩耍 / 睡觉 have a body (T-2831): core/vrm-acts.js poses the bones procedurally (no animation file), the
// director (core/vrm-director.js) decides when and how strongly, the renderer lays them over the clips with
// PetVrmActs.apply. Checked on a real three.js skeleton (the vendored three, human proportions): after eat / play /
// sleep is triggered her bones really move away from the idle (not only the face) — the hand at her mouth, the arms
// up and the hops, the head down and the knees giving —, and after the act ends (or is stopped, or interrupted)
// every bone is back on the idle pose and the action state is idle. With and without the motion library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../src/core/vrm-acts');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
const M = require('../src/core/vrm-motion');
const I = require('../src/core/vrm-intent');
const { runtimeMeta } = require('../scripts/vrm-bake');

const ROOT = path.join(__dirname, '..');
let runtime = null;
const RT = () => runtime || (runtime = vm.runInThisContext(`(() => {${fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'vendor', 'vrm', 'three-vrm.min.js'), 'utf8')}; return PetVrmRuntime; })()`));
const DEG = Math.PI / 180;

// a VRM 1.0 normalized skeleton with human proportions (m): she faces +Z, her left arm points +X, T-pose = identity
function skeleton() {
  const T = RT().THREE;
  const nodes = {};
  const bone = (name, parent, p) => { const o = new T.Object3D(); o.name = name; o.position.set(...p); (parent ? nodes[parent] : null)?.add(o); nodes[name] = o; return o; };
  const root = bone('hips', null, [0, 0.95, 0]);
  bone('spine', 'hips', [0, 0.1, 0]);
  bone('chest', 'spine', [0, 0.12, 0]);
  bone('upperChest', 'chest', [0, 0.12, 0]);
  bone('neck', 'upperChest', [0, 0.1, 0]);
  bone('head', 'neck', [0, 0.08, 0]);
  bone('mouth', 'head', [0, 0.06, 0.09]); // not a humanoid bone: where her mouth is
  for (const [s, k] of [['left', 1], ['right', -1]]) {
    bone(`${s}Shoulder`, 'upperChest', [0.04 * k, 0.06, 0]);
    bone(`${s}UpperArm`, `${s}Shoulder`, [0.13 * k, 0, 0]);
    bone(`${s}LowerArm`, `${s}UpperArm`, [0.26 * k, 0, 0]);
    bone(`${s}Hand`, `${s}LowerArm`, [0.24 * k, 0, 0]);
    bone(`${s}UpperLeg`, 'hips', [0.09 * k, -0.05, 0]);
    bone(`${s}LowerLeg`, `${s}UpperLeg`, [0, -0.42, 0]);
    bone(`${s}Foot`, `${s}LowerLeg`, [0, -0.4, 0]);
  }
  const nodeOf = (n) => (n === 'mouth' ? null : nodes[n] || null);
  // the idle: the arms-down rest pose (what the renderer's rest clip holds), everything else identity
  const rest = M.restPoseFor('1');
  const toRest = () => {
    for (const n of Object.values(nodes)) n.quaternion.identity();
    for (const [b, r] of Object.entries(rest)) nodes[b].rotation.set(r.x * DEG, r.y * DEG, r.z * DEG);
  };
  const world = (n) => { root.updateMatrixWorld(true); return nodes[n].getWorldPosition(new T.Vector3()); };
  const snapshot = () => Object.fromEntries(A.BONES.filter((b) => nodes[b]).map((b) => [b, nodes[b].quaternion.clone()]));
  toRest();
  return { T, nodes, nodeOf, toRest, world, snapshot, idle: snapshot() };
}
// how far (deg) bone `b` is turned away from the idle pose
const offIdle = (sk, b) => (2 * Math.acos(Math.min(1, Math.abs(sk.nodes[b].quaternion.dot(sk.idle[b]))))) / DEG;
const maxOff = (sk) => Math.max(...A.BONES.filter((b) => sk.nodes[b]).map((b) => offIdle(sk, b)));
// one frame as the renderer does it: the clip layer puts the base pose back, then the acts on top
const frame = (sk, acts, opts = {}) => { sk.toRest(); return A.apply(sk.T, sk.nodeOf, acts, { set: 'female', amplitude: 1, ...opts }); };

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-library.json'), 'utf8'));
function bakedIndex() {
  const clips = {};
  for (const [id, e] of Object.entries(manifest.clips)) {
    const { slot, style } = L.parseId(id);
    const duration = e.kind === 'posture' || e.still ? 1 : e.kind === 'idle' ? 10 : 2.5;
    clips[id] = e.src ? { kind: e.kind, style, label: e.label, file: `${style}/${slot}.vrma`, duration, ...(e.sit ? { sit: true } : {}), ...(e.loop ? { loop: true } : {}), ...runtimeMeta(e) } : { kind: e.kind, style, cycle: e.cycle, every: e.every };
  }
  return L.cleanIndex({ clips });
}
function director(lib, base = 'female') {
  const style = S.resolveStyle({ packStyle: { base } });
  if (!lib) return D.createDirector({ style, index: { clips: {} }, loaded: new Set(), rand: D.seeded(5) });
  const index = bakedIndex();
  return D.createDirector({ style, index, loaded: new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id)), rand: D.seeded(5) });
}
const holdsOf = (o = {}) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: true, facing: 'right', dance: null, recording: false, ...o });
// the app around the director: its holds, events, and the skeleton drawn every frame
function world(lib, base = 'female') {
  const d = director(lib, base);
  const sk = skeleton();
  const W = { d, sk, extra: {}, events: [], last: null, peak: {} };
  W.step = (dt = 1 / 30) => {
    const p = d.update(dt, { holds: holdsOf(W.extra), events: W.events.splice(0) });
    const out = frame(sk, p.acts, { set: base, sit: p.actSit });
    for (const a of p.acts) W.peak[a.name] = Math.max(W.peak[a.name] || 0, maxOff(sk));
    W.last = { plan: p, out, off: maxOff(sk) };
    return W.last;
  };
  W.run = (s, dt = 1 / 30) => { const out = []; for (let i = 0; i < Math.round(s / dt); i++) out.push(W.step(dt)); return out; };
  return W;
}
const actsOf = (p) => p.acts.map((a) => a.name).join(',');
function assertIdle(W, label) {
  const p = W.last.plan;
  assert.equal(p.action.state, 'idle', `${label}: action ${p.action.state}`);
  assert.deepEqual(p.acts, [], `${label}: acts ${JSON.stringify(p.acts)}`);
  assert.ok(W.last.off < 0.01, `${label}: a bone still ${W.last.off.toFixed(3)}° off the idle`);
  assert.deepEqual(W.last.out.bones, [], `${label}: no act bone moved`);
}

// ---------- the poses ----------
test('eat: the food goes to her mouth — the hand(s) within a few cm of the mouth at the bite, back down while she chews', () => {
  const sk = skeleton();
  const mouth = () => { sk.nodes.hips.updateMatrixWorld(true); return sk.nodes.mouth.getWorldPosition(new sk.T.Vector3()); };
  const restHand = sk.world('rightHand').distanceTo(mouth());
  // the bite: 0.4 of the period
  frame(sk, [{ name: 'eat', w: 1, time: A.EAT.period * 0.4 }]);
  const bite = { r: sk.world('rightHand').distanceTo(mouth()), l: sk.world('leftHand').distanceTo(mouth()), arm: offIdle(sk, 'rightUpperArm'), elbow: offIdle(sk, 'rightLowerArm'), head: offIdle(sk, 'head') };
  frame(sk, [{ name: 'eat', w: 1, time: A.EAT.period * 0.9 }]);
  const chew = sk.world('rightHand').distanceTo(mouth());
  assert.ok(restHand > 0.5, `idle: the hand hangs ${restHand.toFixed(2)} m from the mouth`);
  assert.ok(bite.r < 0.15, `bite: right hand ${bite.r.toFixed(3)} m from the mouth`);
  assert.ok(bite.l < 0.15, `female: both hands hold it (left ${bite.l.toFixed(3)} m)`);
  assert.ok(bite.arm > 40 && bite.elbow > 90, `the arm moves, not the face: upper arm ${bite.arm.toFixed(0)}°, elbow ${bite.elbow.toFixed(0)}° off the idle`);
  assert.ok(bite.head > 3, `the head leans in to bite (${bite.head.toFixed(1)}°)`);
  assert.ok(chew > bite.r + 0.04 && chew < 0.35, `chewing: the hand a little lower (${chew.toFixed(3)} m), still up`);
  // male: one hand
  frame(sk, [{ name: 'eat', w: 1, time: A.EAT.period * 0.4 }], { set: 'male' });
  assert.ok(sk.world('rightHand').distanceTo(mouth()) < 0.15);
  assert.ok(offIdle(sk, 'leftUpperArm') < 0.01, 'male: the left arm is the posture\'s');
});

test('play: hops (air, knees dipping between), sways, the arms up waving — female both arms in turn, male the right', () => {
  const sk = skeleton();
  const sh = () => sk.world('rightUpperArm').y;
  let air = 0, knee = 0, aboveR = 0, aboveL = 0, sway = 0;
  const samples = [];
  for (let t = 0; t < 3.2; t += 0.05) {
    const out = frame(sk, [{ name: 'play', w: 1, time: t }]);
    air = Math.max(air, out.air);
    knee = Math.max(knee, offIdle(sk, 'leftLowerLeg'));
    aboveR = Math.max(aboveR, sk.world('rightHand').y - sh());
    aboveL = Math.max(aboveL, sk.world('leftHand').y - sk.world('leftUpperArm').y);
    sway = Math.max(sway, offIdle(sk, 'spine'));
    samples.push(sk.world('rightHand').x);
  }
  assert.ok(air > 0.03, `hops: up to ${air.toFixed(3)} × her hip height`);
  assert.ok(knee > 25, `the knees dip between the hops (${knee.toFixed(0)}°)`);
  assert.ok(aboveR > 0.3 && aboveL > 0.3, `both hands go above the shoulders (${aboveR.toFixed(2)}, ${aboveL.toFixed(2)} m)`);
  assert.ok(Math.max(...samples) - Math.min(...samples) > 0.08, 'the right hand waves side to side');
  assert.ok(sway > 3, `she sways (${sway.toFixed(1)}°)`);
  let maleL = 0, maleAir = 0;
  for (let t = 0; t < 3.2; t += 0.05) { const out = frame(sk, [{ name: 'play', w: 1, time: t }], { set: 'male' }); maleL = Math.max(maleL, offIdle(sk, 'leftUpperArm')); maleAir = Math.max(maleAir, out.air); }
  assert.ok(maleL < 0.01, 'male: the left arm stays');
  assert.ok(maleAir < air && maleAir > 0.015, `male: smaller hops (${maleAir.toFixed(3)} < ${air.toFixed(3)})`);
});

test('sleep: the head drops and lolls, the back slumps, a slow breath; standing the knees give and the arms hang loose, seated only head and back move', () => {
  const sk = skeleton();
  const headY0 = sk.world('head').y;
  const out = frame(sk, [{ name: 'sleep', w: 1, time: 5 }]);
  const fwd = new sk.T.Vector3(0, 0, 1).applyQuaternion(sk.nodes.head.getWorldQuaternion(new sk.T.Quaternion()));
  const pitch = Math.asin(-fwd.y) / DEG; // + = looking down
  assert.ok(pitch > 30, `the head hangs: her face turned ${pitch.toFixed(0)}° down`);
  assert.ok(sk.world('head').y < headY0 - 0.01, 'the head is lower (slumped)');
  assert.ok(offIdle(sk, 'leftLowerLeg') > 10, 'standing: the knees give');
  assert.ok(offIdle(sk, 'rightUpperArm') > 5, 'the arms hang loose');
  assert.equal(out.air, 0);
  // the breath: the chest moves slowly (a period of ~6 s), not at the awake rate
  const chest = [];
  for (let t = 2; t < 8.25; t += 0.25) { frame(sk, [{ name: 'sleep', w: 1, time: t }]); chest.push(offIdle(sk, 'chest')); }
  assert.ok(Math.max(...chest) - Math.min(...chest) > 2, 'the chest rises and falls');
  assert.ok(Math.abs(1 / A.SLEEP.breathHz - 6.25) < 0.01, 'one breath every 6.25 s');
  // seated (sit.doze has its own arms and legs on the seat)
  frame(sk, [{ name: 'sleep', w: 1, time: 5 }], { sit: true });
  assert.ok(offIdle(sk, 'head') > 15);
  for (const b of ['rightUpperArm', 'leftUpperArm', 'leftUpperLeg', 'rightLowerLeg']) assert.ok(offIdle(sk, b) < 0.01, `seated: ${b} is the posture's`);
});

test('apply: weight 0 is the idle exactly, the weight scales the pose, VRM 0.x mirrors x / z', () => {
  const sk = skeleton();
  for (const name of A.ACTS) { frame(sk, [{ name, w: 0, time: 1 }]); assert.ok(maxOff(sk) < 0.01, name); }
  frame(sk, [{ name: 'eat', w: 1, time: 1 }]);
  const full = offIdle(sk, 'rightUpperArm');
  frame(sk, [{ name: 'eat', w: 0.5, time: 1 }]);
  const half = offIdle(sk, 'rightUpperArm');
  assert.ok(half > full * 0.3 && half < full * 0.7, `half weight, about half the turn (${half.toFixed(1)} of ${full.toFixed(1)}°)`);
  // 0.x: the same Euler with x and z negated (rotateVRM0 faces the bones −Z)
  frame(sk, [{ name: 'sleep', w: 1, time: 3 }], { v0: -1 });
  const e = new sk.T.Euler().setFromQuaternion(sk.nodes.head.quaternion);
  frame(sk, [{ name: 'sleep', w: 1, time: 3 }]);
  const e1 = new sk.T.Euler().setFromQuaternion(sk.nodes.head.quaternion);
  assert.ok(Math.abs(e.x + e1.x) < 1e-6 && Math.abs(e.z + e1.z) < 1e-6 && Math.abs(e.y - e1.y) < 1e-6, '0.x mirrors x and z');
  assert.deepEqual(frame(sk, [{ name: 'dance', w: 1, time: 1 }]).bones, [], 'an unknown act does nothing');
});

// ---------- in the state machine: trigger → a body that is not the idle → the end → idle ----------
for (const lib of [true, false]) {
  const tag = lib ? 'library' : 'no library';

  test(`[${tag}] eat: while the meal lasts her bones are off the idle (hold eat + the eat body); when it ends she fades back to the exact idle`, () => {
    const W = world(lib);
    W.run(1);
    assertIdle(W, 'before');
    W.extra = { eat: 'rice' };
    const on = W.run(2);
    const p = on[on.length - 1].plan;
    assert.equal(p.action.state, 'eat');
    assert.equal(p.hold, 'eat');
    assert.equal(actsOf(p), 'eat');
    assert.ok(p.acts[0].w > 0.99, `full weight ${p.acts[0].w}`);
    assert.ok(W.peak.eat > 60, `the bones move ${W.peak.eat.toFixed(0)}° off the idle (not only the face)`);
    W.extra = {};
    const off = W.run(1.5);
    assert.ok(off.some((f) => f.plan.action.state === 'returning'), 'it fades out (returning), no snap');
    assertIdle(W, 'after the meal');
  });

  test(`[${tag}] play: the 玩耍 order is a ${D.ACT.play.dur} s one-shot of hops and waves, then the idle on its own`, () => {
    const W = world(lib);
    W.run(1);
    W.events.push({ type: 'play', n: 1 });
    const on = W.run(1);
    assert.equal(on[on.length - 1].plan.action.state, 'play');
    assert.ok(on.some((f) => f.out && f.out.air > 0.02), 'she hops');
    assert.ok(W.peak.play > 60, `the arms go up (${W.peak.play.toFixed(0)}°)`);
    assert.ok(/happy/.test(Object.keys(on[on.length - 1].plan.face).join()), 'and smiles');
    W.run(D.ACT.play.dur + 0.8 - 1);
    assertIdle(W, 'after play');
    // the idle cue 'play' alone is a hint (a smile or a small cheer), not the one-shot
    W.events.push({ type: 'cue', name: 'play' });
    W.run(0.3);
    assert.ok(!W.last.plan.acts.some((a) => a.name === 'play'), 'the cue does not play the play body');
  });

  test(`[${tag}] sleep: asleep she dozes (head down, slumped, slow breath); woken she comes back to the idle`, () => {
    const W = world(lib);
    W.run(1);
    W.extra = { mood: 'sleep' };
    const on = W.run(4);
    const p = on[on.length - 1].plan;
    assert.equal(p.action.state, 'sleep');
    assert.equal(actsOf(p), 'sleep');
    assert.equal(p.actSit, lib, lib ? 'with the library she sits (sit.doze): the act leaves arms and legs to it' : 'without it she dozes standing');
    assert.ok(W.peak.sleep > 20, `the bones move ${W.peak.sleep.toFixed(0)}° off the idle`);
    assert.equal(p.life.sleep, true, 'the alive layer breathes at the sleep rate too');
    W.extra = {};
    W.run(lib ? 3 : 1.5); // (with the library the sit.doze posture fades back too)
    assertIdle(W, 'woken');
  });

  test(`[${tag}] stop(): play, a meal and sleep all fade back to the idle; the next meal / sleep plays again`, () => {
    for (const how of ['play', 'eat', 'sleep']) {
      const W = world(lib);
      W.run(0.5);
      if (how === 'play') W.events.push({ type: 'play', n: 1 });
      else W.extra = how === 'eat' ? { eat: 'cookie' } : { mood: 'sleep' };
      W.run(1.5);
      assert.equal(W.last.plan.action.state, how);
      const r = W.d.stop('user');
      assert.equal(r.stopped, how);
      W.run(lib && how === 'sleep' ? 3 : 1.2); // the app still holds the meal / sleep
      assertIdle(W, `${how} stopped`);
      if (how !== 'play') {
        W.extra = {};
        W.run(0.2);
        W.extra = how === 'eat' ? { eat: 'fruit' } : { mood: 'sleep' };
        W.run(1.5);
        assert.equal(W.last.plan.action.state, how, `the next ${how} plays again`);
        assert.ok(W.last.plan.acts.some((a) => a.name === how));
      }
    }
  });

  test(`[${tag}] interrupted: a touch / a meal / the lift end play; the lift and a reaction take over from eat and sleep; it all ends in the idle`, () => {
    const W = world(lib);
    W.run(0.5);
    // play → a touch: the reaction wins, play is over (not resumed after it)
    W.events.push({ type: 'play', n: 1 });
    W.run(0.8);
    W.events.push({ type: 'touch', zone: 'head', mood: 'happy', streak: 0 });
    W.run(0.6);
    assert.equal(W.last.plan.action.state, 'touch');
    W.run(4);
    assert.ok(!W.last.plan.acts.length, 'play does not come back after the touch');
    // play → a meal
    W.events.push({ type: 'play', n: 2 });
    W.run(0.8);
    W.extra = { eat: 'rice' };
    W.run(1);
    assert.equal(W.last.plan.action.state, 'eat');
    assert.equal(actsOf(W.last.plan), 'eat', 'play faded out under the meal');
    // eat → a touch: the reaction's clip on top, the eat body ducks under it and comes back
    W.events.push({ type: 'touch', zone: 'head', mood: 'happy', streak: 0 });
    const t = W.run(0.5);
    assert.ok(t.some((f) => f.plan.acts[0] && f.plan.acts[0].w < 0.5), 'eat ducks under the reaction');
    W.run(4);
    assert.equal(W.last.plan.action.state, 'eat');
    assert.ok(W.last.plan.acts[0].w > 0.99, 'and comes back');
    // sleep → lifted: the lift wins (no dozing in the air); put down she dozes again
    W.extra = { mood: 'sleep' };
    W.run(2);
    W.extra = { mood: 'sleep', lift: true };
    W.run(1.5);
    assert.equal(W.last.plan.action.state, 'lift');
    assert.ok(!W.last.plan.acts.some((a) => a.name === 'sleep'), 'no sleep body while lifted');
    W.extra = { mood: 'sleep' };
    W.run(2.5);
    assert.ok(W.last.plan.acts.some((a) => a.name === 'sleep' && a.w > 0.9), 'put down, she dozes again');
    // everything let go
    W.extra = {};
    W.run(4);
    assertIdle(W, 'all let go');
  });
}

test('intent: the app\'s play count is the `play` event (before the cue of the same frame); unchanged → nothing', () => {
  const a = I.fromSnapshot({ status: 'idle', play: 0 }, null);
  assert.equal(a.events.length, 0);
  const prev = { status: 'idle', play: 0 };
  const b = I.fromSnapshot({ status: 'idle', play: 1, shot: 'play' }, prev);
  assert.deepEqual(b.events.map((e) => e.type), ['play', 'cue']);
  assert.match(I.summary(b), /play/);
  assert.equal(I.fromSnapshot({ status: 'idle', play: 1 }, { status: 'idle', play: 1 }).events.length, 0);
  // the same frame through the director: the one-shot plays, the cue only smiles (no cheer reaction over it)
  const d = director(true);
  for (let i = 0; i < 30; i++) d.update(1 / 30, { holds: holdsOf(), events: [] });
  const p = d.update(1 / 30, { holds: holdsOf(), events: b.events });
  assert.equal(p.reaction, null);
  assert.equal(p.action.state, 'play');
});
