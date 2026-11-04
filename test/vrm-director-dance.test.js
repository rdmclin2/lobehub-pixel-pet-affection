'use strict';
// The dance layer D in the VRM director (docs/vrm-dance.md §3): it takes the whole body (the dance's clip as
// the base, nothing laid over it, the alive layer's bones off, facing the camera), cues in over 0.6 s before
// it asks for the music and clock, and handles the interruptions of §3.4 — lifted (pause + hold.lift, back
// 0.6 s after being put down, stop after 10 s), touched (a face, no reaction), talking (keeps dancing, music
// ducked), the microphone, fed (stop), celebrations and cues (dropped) — then fades back to the idle over
// 0.5 s (T-2829). The app side is a small stand-in for renderer/vrm-dance.js that obeys plan.dance.request.
// The renderer's clip layer on the real three mixer (external clock, loop seam, back to the idle) is at the end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
const I = require('../src/core/vrm-intent');
const M = require('../src/core/vrm-motion');
const B = require('../scripts/lib/vrm-bake-core');
const { runtimeMeta } = require('../scripts/vrm-bake');

const ROOT = path.join(__dirname, '..');
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
const holdsOf = (o = {}) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: true, facing: 'right', dance: null, recording: false, ...o });
function make() {
  const index = bakedIndex();
  return D.createDirector({ style: S.resolveStyle({ packStyle: { base: 'female' } }), index, loaded: new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id)), rand: D.seeded(3) });
}

// the app: holds what is danced and its clock, does what the director asks
function app(d, { duration = 6, loop = false } = {}) {
  const A = { id: null, t: 0, playing: false, paused: null, loop, duration, stops: [], plans: [], now: 0 };
  A.play = (id) => Object.assign(A, { id, t: 0, playing: false, paused: null });
  A.stop = (why) => { A.stops.push(why); A.id = null; };
  A.step = (dt, extra = {}, events = []) => {
    A.now += dt;
    const dance = A.id ? { id: A.id, t: A.t, duration: A.duration, loop: A.loop, ready: true, playing: A.playing, paused: A.paused } : null;
    const plan = d.update(dt, { holds: holdsOf({ ...extra, dance }), events });
    const r = plan.dance.request;
    if (r === 'start') A.playing = true;
    if (r === 'pause') A.paused = 'lift';
    if (r === 'resume') A.paused = null;
    if (r === 'stop') A.stop('director');
    if (A.id && A.playing && !A.paused) {
      A.t += dt;
      if (A.t >= A.duration) { if (A.loop) A.t = 0; else A.stop('end'); }
    }
    const rec = { ...plan, at: A.now, appT: A.t };
    A.plans.push(rec);
    return rec;
  };
  A.run = (seconds, extra, dt = 0.05) => { const out = []; for (let t = 0; t < seconds - 1e-9; t += dt) out.push(A.step(dt, typeof extra === 'function' ? extra(t) : extra)); return out; };
  return A;
}

test('starting: the base fades to the dance (0.6 s, frozen on its first frame), then the music and clock start; the whole body is the dance', () => {
  const d = make();
  const A = app(d);
  A.run(3); // her idle first
  const idleBase = d.state.base.id;
  assert.ok(idleBase && !idleBase.startsWith('dance:'));
  A.play('test');
  let p = A.step(0.05);
  assert.equal(p.dance.state, 'cueing');
  assert.equal(p.base.id, 'dance:test');
  assert.equal(p.base.dance, true);
  assert.equal(p.base.clock, 'external');
  assert.equal(p.base.fade, D.DANCE.fadeIn);
  assert.equal(p.dance.request, null, 'no music while she gets into the first pose');
  assert.equal(A.playing, false);
  const cue = A.run(0.5);
  assert.ok(cue.every((x) => x.dance.state === 'cueing' && x.dance.t === 0));
  const go = A.run(0.2);
  assert.ok(go.some((x) => x.dance.state === 'in' && x.dance.request === 'start'), go.map((x) => x.dance.state).join(' '));
  assert.equal(A.playing, true);
  p = A.step(0.05);
  assert.equal(p.dance.state, 'on');
  const on = A.run(2);
  for (const x of on) {
    assert.equal(x.dance.state, 'on');
    assert.equal(x.dance.exclusive, true);
    assert.deepEqual(x.overlays, [], 'nothing laid over the dance');
    assert.equal(x.reaction, null);
    assert.equal(x.hold, null);
    assert.equal(x.life.dance, true, 'the alive layer keeps only the eyes');
    assert.equal(x.turnLead, 0);
    assert.equal(x.gaze.kind, 'dance', 'she looks at you');
    assert.equal(x.busy, true, 'the full frame rate');
    assert.equal(x.base.id, 'dance:test', 'the idle schedule does not take the base back');
  }
  assert.ok(Math.abs(on[on.length - 1].facingYaw) < 0.5, `faces the camera: ${on[on.length - 1].facingYaw}`);
  assert.ok(Math.abs(on[on.length - 1].dance.t - A.t) < 0.06, 'the plan carries the app\'s clock');
  assert.ok(on[0].face.happy > 0, 'a light smile without a face track');
});

test('a dance with its own face track: the director leaves the face to it', () => {
  const d = make();
  const p = d.update(0.05, { holds: holdsOf({ dance: { id: 'f', t: 0, playing: true, paused: null, faceTrack: true } }), events: [] });
  assert.deepEqual(p.face, {});
});

test('lifted: paused with hold.lift, the clock frozen; put down: back to dancing 0.6 s later from where it stopped', () => {
  const d = make();
  const A = app(d, { duration: 20 });
  A.play('test');
  A.run(2);
  const before = A.t;
  const held = A.run(1.5, { lift: true });
  assert.ok(held.slice(1).every((x) => x.dance.state === 'paused'), held.map((x) => x.dance.state).join(' '));
  assert.ok(Math.abs(A.t - before) < 0.06, `frozen: ${before} → ${A.t}`);
  const last = held[held.length - 1];
  assert.deepEqual(last.overlays.map((o) => o.slot), ['hold.lift'], 'only the lift over the dance');
  assert.equal(last.hold, 'lift');
  const down = A.run(1.2);
  const back = down.findIndex((x) => x.dance.state === 'on');
  assert.ok(back > 0, 'back on');
  const at = down[back].at - held[held.length - 1].at;
  assert.ok(at >= D.DANCE.resumeAfter - 0.06 && at <= D.DANCE.resumeAfter + 0.15, `resumed ${at.toFixed(2)} s after being put down`);
  assert.ok(down.slice(0, back).every((x) => x.dance.state === 'paused'));
  assert.ok(down.slice(back - 1).some((x) => x.dance.request === 'resume'));
  assert.ok(A.t > before && A.t < before + 1, `went on from ${before.toFixed(2)}: ${A.t.toFixed(2)}`);
  assert.deepEqual(A.stops, []);
});

test('lifted for more than 10 s: she stops dancing', () => {
  const d = make();
  const A = app(d, { duration: 60 });
  A.play('test');
  A.run(1.5);
  A.run(11, { lift: true });
  assert.deepEqual(A.stops, ['director']);
  const after = A.run(1);
  assert.ok(after.some((x) => x.dance.state === 'out') || after.every((x) => x.dance.state === 'off'));
});

test('touched while dancing: her face answers, no reaction clip; celebrations and cues are dropped (not queued for later)', () => {
  const d = make();
  const A = app(d, { duration: 8 });
  A.play('test');
  A.run(1.5);
  const n = d.reactions().length;
  let p = A.step(0.05, {}, [{ type: 'touch', zone: 'head', mood: 'happy', streak: 0 }]);
  p = A.step(0.05);
  assert.equal(p.reaction, null);
  assert.deepEqual(p.overlays, []);
  assert.ok(p.face.relaxed > 0 || p.face.happy > 0.3, JSON.stringify(p.face));
  A.step(0.05, {}, [{ type: 'touch', zone: 'face', mood: 'angry', streak: 6 }]);
  p = A.step(0.05);
  assert.ok(p.face.angry > 0.5, `the mood's face: ${JSON.stringify(p.face)}`);
  A.step(0.05, {}, [{ type: 'celebrate', name: 'evolve' }, { type: 'cue', name: 'play' }]);
  assert.equal(d.reactions().length, n, 'no reaction started');
  A.run(8); // the dance ends, she is back in her idle
  assert.equal(d.state.queued, null, 'the celebration was not kept for after the dance');
  assert.equal(d.reactions().length, n);
});

test('talking: she keeps dancing, the music ducks to 30 %; the microphone ducks it to 15 %; thinking does not', () => {
  const d = make();
  const A = app(d, { duration: 20 });
  A.play('test');
  A.run(1.5);
  let p = A.run(0.5, { talk: true }).pop();
  assert.equal(p.dance.state, 'on');
  assert.equal(p.dance.duck, D.DANCE.duckTalk);
  assert.equal(p.hold, null);
  assert.deepEqual(p.overlays, []);
  p = A.run(0.2, { recording: true }).pop();
  assert.equal(p.dance.duck, D.DANCE.duckMic);
  p = A.run(0.2, { think: true }).pop();
  assert.equal(p.dance.duck, 1);
  assert.equal(p.dance.state, 'on');
});

test('fed while dancing: the dance stops first', () => {
  const d = make();
  const A = app(d, { duration: 20 });
  A.play('test');
  A.run(1.5);
  A.step(0.05, { eat: 'rice' });
  assert.deepEqual(A.stops, ['director']);
});

test('the end: out (the base fades back to the idle over DANCE.fadeOut (0.5 s)) → off; the idle schedule takes over again', () => {
  const d = make();
  const A = app(d, { duration: 2 });
  A.play('test');
  A.run(0.8);
  const rest = A.run(4);
  const outAt = rest.findIndex((x) => x.dance.state === 'out');
  assert.ok(outAt > 0);
  const out = rest[outAt];
  assert.ok(!out.base.id.startsWith('dance:'), 'the idle is the base again');
  assert.equal(out.base.fade, D.DANCE.fadeOut);
  const offAt = rest.findIndex((x) => x.dance.state === 'off' && x.at > out.at);
  assert.ok(Math.abs(rest[offAt].at - out.at - D.DANCE.fadeOut) < 0.11, `off ${(rest[offAt].at - out.at).toFixed(2)} s after out`);
  assert.equal(rest[offAt].dance.on, false, 'nothing stuck on');
  assert.equal(rest[rest.length - 1].life.dance, false);
  assert.equal(A.stops[0], 'end');
});

test('loop: never goes out, the clock comes round to 0', () => {
  const d = make();
  const A = app(d, { duration: 2, loop: true });
  A.play('test');
  const all = A.run(6);
  assert.ok(all.slice(20).every((x) => x.dance.state === 'on'), 'no out while it loops');
  const ts = all.map((x) => x.dance.t);
  assert.ok(ts.some((t, i) => i > 0 && t < ts[i - 1] - 1), 'the time came round');
});

test('another dance while one plays: straight from one to the other (cue again), never through the idle', () => {
  const d = make();
  const A = app(d, { duration: 20 });
  A.play('one');
  A.run(2);
  A.play('two');
  const p = A.step(0.05);
  assert.equal(p.dance.state, 'cueing');
  assert.equal(p.base.id, 'dance:two');
  assert.equal(p.base.fade, D.DANCE.fadeIn);
});

test('intent: snap.dance as holds.dance, start / stop edges as events, the microphone', () => {
  const a = I.fromSnapshot({ dance: { id: 'x', t: 1.5, duration: 6, loop: true, playing: true, paused: null }, recording: true }, {});
  assert.deepEqual(a.holds.dance, { id: 'x', t: 1.5, duration: 6, loop: true, ready: true, playing: true, paused: null, faceTrack: false });
  assert.equal(a.holds.recording, true);
  assert.deepEqual(a.events, [{ type: 'dance', what: 'start', id: 'x' }]);
  const b = I.fromSnapshot({}, { dance: { id: 'x' } });
  assert.deepEqual(b.events, [{ type: 'dance', what: 'stop', id: 'x' }]);
  assert.equal(b.holds.dance, null);
  assert.match(I.summary(a), /dance:x .*dance:start/);
});

// ---------- the renderer's clip layer (renderer/vrm-anim.js) on the real mixer ----------
let runtime = null;
const R = () => runtime || (runtime = vm.runInThisContext(`(() => {${fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'vendor', 'vrm', 'three-vrm.min.js'), 'utf8')}; return PetVrmRuntime; })()`));
const qz = (deg) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];
async function layersWith() {
  const ctx = { window: { PetVrmMotion: M } };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'vrm-anim.js'), 'utf8'), ctx);
  const RT = R();
  const T = RT.THREE;
  const root = new T.Object3D();
  const arm = new T.Object3D();
  arm.name = 'leftUpperArm';
  const hips = new T.Object3D();
  hips.name = 'hips';
  root.add(hips, arm);
  const nodeOf = (n) => ({ leftUpperArm: arm, hips }[n] || null);
  const vrm = { scene: root, meta: { metaVersion: '1' }, humanoid: { getNormalizedBoneNode: nodeOf, normalizedRestPose: { hips: { position: [0, 0.9, 0] } } }, expressionManager: null, lookAt: null };
  const load = async (clip) => {
    const buf = B.writeVrma(clip);
    const loader = new RT.GLTFLoader();
    loader.register((parser) => new RT.VRMAnimationLoaderPlugin(parser));
    const g = await loader.parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), '');
    return RT.createVRMAnimationClip(g.userData.vrmAnimations[0], vrm);
  };
  const still = (deg) => ({ duration: 1, bones: { hips: { times: [0, 1], values: [[0, 0, 0, 1], [0, 0, 0, 1]] }, leftUpperArm: { times: [0, 1], values: [qz(deg), qz(deg)] } }, hips: null, restHipsY: 0.9, rest: { hips: [0, 0.9, 0] } });
  // a 4 s "dance": the arm angle is 10° × t (0° → 40°), so the time shown can be read off the arm
  const times = [0, 1, 2, 3, 4];
  const dance = { duration: 4, bones: { hips: { times, values: times.map(() => [0, 0, 0, 1]) }, leftUpperArm: { times, values: times.map((t) => qz(-10 * t)) } }, hips: null, restHipsY: 0.9, rest: { hips: [0, 0.9, 0] } };
  return { layers: ctx.window.PetVrmAnim.createAnimLayers(RT, vrm, ['leftUpperArm']), arm, idle: await load(still(-70)), dance: await load(dance) };
}
const armAngle = (arm) => (2 * Math.acos(Math.min(1, Math.abs(arm.quaternion.w))) * 180) / Math.PI;

test('vrm-anim: the dance on an external clock — fades in from the idle at its first frame, follows seekBase whatever the frame rate, blends the loop seam, fades back; weights always 1', async () => {
  const { layers, arm, idle, dance } = await layersWith();
  layers.add('idle', idle);
  layers.add('dance:t', dance);
  layers.setBase('idle', 0);
  layers.update(1 / 30);
  assert.ok(Math.abs(armAngle(arm) - 70) < 0.05);
  layers.setBase('dance:t', 0.6, { clock: 'external', time: 0 });
  assert.equal(layers.external(), true);
  for (let i = 0; i < 24; i++) {
    layers.seekBase(0);
    layers.update(1 / 30);
    assert.ok(Math.abs(layers.weightSum() - 1) < 1e-9, layers.summary());
  }
  assert.equal(layers.summary(), 'dance:t:1.00');
  assert.ok(Math.abs(armAngle(arm)) < 0.05, `at the dance's first frame: ${armAngle(arm)}`);
  // the clock is the caller's: uneven frames, a stall, a jump — the pose is always the time asked for
  for (const [t, dt] of [[0.5, 1 / 12], [1.0, 1 / 60], [1.0, 0.25], [2.5, 1 / 30], [3.2, 0.1]]) {
    layers.seekBase(t);
    layers.update(dt);
    assert.ok(Math.abs(layers.baseTime() - t) < 1e-6);
    assert.ok(Math.abs(armAngle(arm) - 10 * t) < 0.05, `t ${t}: arm ${armAngle(arm).toFixed(2)}`);
  }
  // the loop: from 3.9 s back to 0.1 s blends over 0.5 s on two actions, never a snap, weights 1
  layers.seekBase(3.9);
  layers.update(1 / 30);
  const seam = [];
  for (let i = 0; i < 20; i++) {
    layers.seekBase(0.1 + i / 30, { blend: true });
    layers.update(1 / 30);
    assert.ok(Math.abs(layers.weightSum() - 1) < 1e-9, layers.summary());
    seam.push(armAngle(arm));
  }
  for (let i = 1; i < seam.length; i++) assert.ok(Math.abs(seam[i] - seam[i - 1]) < 8, `no snap at the seam: ${seam.map((x) => x.toFixed(1)).join(' ')}`);
  assert.equal(layers.summary(), 'dance:t:1.00');
  assert.ok(Math.abs(armAngle(arm) - 10 * (0.1 + 19 / 30)) < 0.1);
  // any other jump (a seek) is a cut
  layers.seekBase(0.5);
  layers.update(1 / 30);
  assert.equal(layers.summary(), 'dance:t:1.00');
  assert.ok(Math.abs(armAngle(arm) - 5) < 0.05);
  // back to the idle over 0.8 s
  layers.setBase('idle', 0.8);
  for (let i = 0; i < 30; i++) { layers.update(1 / 30); assert.ok(Math.abs(layers.weightSum() - 1) < 1e-9); }
  assert.equal(layers.summary(), 'idle:1.00');
  assert.ok(Math.abs(armAngle(arm) - 70) < 0.05);
  // let the dance go
  assert.equal(layers.remove('dance:t'), true);
  assert.equal(layers.has('dance:t'), false);
  assert.equal(layers.remove('idle'), false, 'not the clip playing');
});
