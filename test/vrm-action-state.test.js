'use strict';
// The action state machine of a VRM figure (T-2829): idle ↔ a one-shot action (dance, a reaction — touch,
// celebrate, play —, a hold — eat, think —, sleep) → returning → idle. The director (core/vrm-director.js) keeps
// the state; the renderer's clip layer (renderer/vrm-anim.js, on the real three mixer) plays its base and always
// has somewhere to fade back to — the rest clip — so nothing (a dance's last frame, above all) stays frozen on her.
// Covered: the default state is idle; an action that ends → idle; stop → idle; switching to another action
// midway; a long run of interruptions ends in the same clean idle; with and without a motion library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
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
// lib: the motion library on the dev machine; none: the installed app (no library ships, docs §6.2)
function make(lib = true, seed = 3) {
  const style = S.resolveStyle({ packStyle: { base: 'female' } });
  if (!lib) return D.createDirector({ style, index: { clips: {} }, loaded: new Set(), rand: D.seeded(seed) });
  const index = bakedIndex();
  return D.createDirector({ style, index, loaded: new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id)), rand: D.seeded(seed) });
}

// the app around the director: holds the dance and its clock and obeys plan.dance.request (as renderer/vrm-dance.js),
// holds a meal / sleep / the chat as the app does
function app(d) {
  const A = { id: null, t: 0, playing: false, paused: null, duration: 4, extra: {}, events: [], stops: [], now: 0, last: null };
  A.dance = (id, duration = 4) => Object.assign(A, { id, t: 0, playing: false, paused: null, duration });
  A.stopDance = (why = 'user') => { if (A.id) A.stops.push(why); A.id = null; };
  A.step = (dt = 1 / 30) => {
    A.now += dt;
    const dance = A.id ? { id: A.id, t: A.t, duration: A.duration, loop: false, ready: true, playing: A.playing, paused: A.paused } : null;
    const plan = d.update(dt, { holds: holdsOf({ ...A.extra, dance }), events: A.events.splice(0) });
    const r = plan.dance.request;
    if (r === 'start') A.playing = true;
    if (r === 'pause') A.paused = 'lift';
    if (r === 'resume') A.paused = null;
    if (r === 'stop') A.stopDance('director');
    if (A.id && A.playing && !A.paused) { A.t += dt; if (A.t >= A.duration) A.stopDance('end'); }
    A.last = plan;
    return plan;
  };
  A.run = (s, dt = 1 / 30) => { const out = []; for (let i = 0; i < Math.round(s / dt); i++) out.push(A.step(dt)); return out; };
  return A;
}
const touch = (zone = 'head') => ({ type: 'touch', zone, mood: 'happy' });
// nothing of any action left on her: the clean idle
function assertCleanIdle(d, plan, label) {
  assert.equal(plan.action.state, 'idle', `${label}: action ${plan.action.state}`);
  assert.equal(plan.dance.state, 'off', `${label}: dance ${plan.dance.state}`);
  assert.equal(plan.dance.on, false);
  assert.ok(!(plan.base && plan.base.dance), `${label}: the base is not a dance`);
  assert.ok(!plan.base || !plan.base.id || !plan.base.id.startsWith('dance:'), `${label}: base ${plan.base && plan.base.id}`);
  assert.deepEqual(plan.overlays, [], `${label}: overlays ${JSON.stringify(plan.overlays)}`);
  assert.equal(plan.hold, null);
  assert.equal(plan.reaction, null);
  assert.equal(plan.life.dance, false, `${label}: the alive layer is back`);
  assert.equal(d.state.react, null);
  assert.equal(d.state.fading.length, 0);
  assert.equal(d.state.holds.size, 0);
  assert.equal(d.state.queued, null);
  assert.equal(d.state.stopAsked, null, `${label}: no stop left pending`);
}

for (const lib of [true, false]) {
  const tag = lib ? 'library' : 'no library';

  test(`[${tag}] default: a new figure is idle from the first frame, and stays idle`, () => {
    const d = make(lib);
    assert.equal(d.action().state, 'idle');
    const A = app(d);
    const first = A.step(0);
    assert.equal(first.action.state, 'idle');
    assert.equal(first.base.fade, 0, 'the first base comes in at once');
    if (!lib) assert.equal(first.base.id, null, 'no clip: the renderer plays the rest clip');
    const all = A.run(30, 1 / 10);
    assert.ok(all.every((p) => p.action.state === 'idle'), [...new Set(all.map((p) => p.action.state))].join(','));
    assert.deepEqual(d.actions(), [], 'no transition');
  });

  test(`[${tag}] a dance that ends: dance → returning (≤ ${D.DANCE.fadeOut} s cross-fade) → idle; nothing of it stays`, () => {
    const d = make(lib);
    const A = app(d);
    A.run(1);
    A.dance('one', 2);
    const during = A.run(1.5);
    assert.ok(during.some((p) => p.action.state === 'dance'), 'dancing');
    assert.ok(during.some((p) => p.base.id === 'dance:one' && p.base.dance));
    const after = A.run(3);
    assert.equal(A.stops[0], 'end');
    const outAt = after.findIndex((p) => p.dance.state === 'out');
    assert.ok(outAt >= 0);
    assert.equal(after[outAt].action.state, 'returning');
    assert.equal(after[outAt].base.dance, undefined, 'the base is not the dance any more');
    assert.equal(after[outAt].base.fade, D.DANCE.fadeOut, 'cross-faded back');
    assert.ok(D.DANCE.fadeOut >= 0.2 && D.DANCE.fadeOut <= 0.5, `fade back ${D.DANCE.fadeOut} s`);
    const idleAt = after.findIndex((p, i) => i > outAt && p.action.state === 'idle');
    assert.ok(idleAt > outAt);
    assert.ok((idleAt - outAt) / 30 <= D.DANCE.fadeOut + 0.05, `idle ${((idleAt - outAt) / 30).toFixed(2)} s after the end`);
    assertCleanIdle(d, after[after.length - 1], 'after the dance');
    assert.deepEqual(d.actions().map((x) => x.to), ['dance', 'returning', 'idle']);
  });

  test(`[${tag}] a touch reaction and a meal end by themselves → idle`, () => {
    const d = make(lib);
    const A = app(d);
    A.run(0.5);
    A.events.push(touch('head'));
    const p = A.step();
    assert.equal(p.action.state, 'touch');
    A.run(5);
    assertCleanIdle(d, A.last, 'after the touch');
    A.extra = { eat: 'apple' };
    assert.equal(A.step().action.state, 'eat');
    A.run(1.6);
    A.extra = {};
    const back = A.run(3);
    assert.ok(back.some((x) => x.action.state === 'returning') || !lib, 'the hold fades out (returning)');
    assertCleanIdle(d, A.last, 'after the meal');
    const seq = d.actions().map((x) => x.to);
    assert.equal(seq[seq.length - 1], 'idle');
  });

  test(`[${tag}] stop(): a dance (also while it cues in) and a reaction fade back to the idle, not held on their last frame`, () => {
    for (const at of [0.2, 2]) {
      const d = make(lib);
      const A = app(d);
      A.run(0.5);
      A.dance('long', 30);
      A.run(at);
      assert.equal(A.last.action.state, 'dance');
      const r = d.stop('user');
      assert.equal(r.stopped, 'dance');
      const p = A.step();
      assert.equal(p.dance.request, 'stop', 'the app is asked to stop the dance');
      assert.equal(A.stops[0], 'director');
      const after = A.run(D.DANCE.fadeOut + 0.2);
      assert.ok(after.some((x) => x.action.state === 'returning'));
      assertCleanIdle(d, after[after.length - 1], `stopped at ${at} s`);
    }
    // a reaction: cut (CUT s), back to the idle
    const d = make(lib);
    const A = app(d);
    A.run(0.5);
    A.events.push({ type: 'celebrate', name: 'evolve' });
    assert.equal(A.step().action.state, 'celebrate');
    A.run(0.3);
    d.stop();
    const after = A.run(D.CUT + 0.1);
    assertCleanIdle(d, after[after.length - 1], 'reaction stopped');
    // the app's own stop (the dance overlay's 停止 / Esc / the API): same path back
    const d2 = make(lib);
    const A2 = app(d2);
    A2.dance('x', 30);
    A2.run(2);
    A2.stopDance('user');
    const after2 = A2.run(D.DANCE.fadeOut + 0.1);
    assertCleanIdle(d2, after2[after2.length - 1], 'app stop');
  });

  test(`[${tag}] another action midway: dance → dance, dance → meal, touch → celebrate, reaction → dance`, () => {
    const d = make(lib);
    const A = app(d);
    A.run(0.5);
    A.dance('one', 20);
    A.run(1.5);
    A.dance('two', 20);
    const p = A.step();
    assert.equal(p.action.state, 'dance');
    assert.equal(p.base.id, 'dance:two', 'straight to the other dance');
    A.run(1.5);
    // fed while dancing: the dance is stopped, the meal is what she does
    A.extra = { eat: 'apple' };
    const fed = A.run(0.2);
    assert.equal(A.stops[A.stops.length - 1], 'director');
    assert.equal(fed[fed.length - 1].action.state, 'eat');
    assert.equal(fed[fed.length - 1].dance.on, false);
    A.extra = {};
    A.run(3);
    assertCleanIdle(d, A.last, 'after dance → meal');
    // a touch, then a celebration over it (it waits for the touch), then a dance over the reaction
    A.events.push(touch('face'));
    assert.equal(A.step().action.state, 'touch');
    A.events.push({ type: 'celebrate', name: 'evolve' });
    A.run(0.2);
    A.dance('three', 1.5);
    const p3 = A.step();
    assert.equal(p3.action.state, 'dance', 'a dance takes over a reaction');
    assert.equal(d.state.react, null, 'the reaction gave way');
    assert.equal(d.state.queued, null, 'the waiting celebration was dropped');
    A.run(4);
    assertCleanIdle(d, A.last, 'after touch → dance');
  });

  test(`[${tag}] a long run of interruptions (dances, stops, meals, touches, lifts, celebrations, sleep) ends in the same clean idle`, () => {
    for (const seed of [1, 7, 42]) {
      const d = make(lib, seed);
      const A = app(d);
      const rnd = D.seeded(seed * 97);
      let lifted = false;
      for (let i = 0; i < 400; i++) {
        const k = rnd();
        if (k < 0.12) A.dance(`d${Math.floor(rnd() * 3)}`, 0.5 + rnd() * 3);
        else if (k < 0.2) d.stop('user');
        else if (k < 0.26) A.stopDance('user');
        else if (k < 0.34) A.extra = { ...A.extra, eat: A.extra.eat ? null : 'apple' };
        else if (k < 0.44) A.events.push(touch(['head', 'face', 'hands'][Math.floor(rnd() * 3)]));
        else if (k < 0.5) { lifted = !lifted; A.extra = { ...A.extra, lift: lifted }; if (!lifted) A.events.push({ type: 'drag', what: 'drop' }); }
        else if (k < 0.55) A.events.push({ type: 'celebrate', name: rnd() < 0.5 ? 'evolve' : 'hatch' });
        else if (k < 0.6) A.events.push({ type: 'cue', name: 'play' });
        else if (k < 0.64) A.extra = { ...A.extra, mood: A.extra.mood === 'sleep' ? 'idle' : 'sleep' };
        else if (k < 0.68) A.extra = { ...A.extra, think: !A.extra.think };
        const p = A.run(rnd() * 0.4 + 1 / 30);
        const last = p[p.length - 1];
        assert.ok(D.ACTIONS.includes(last.action.state), last.action.state);
        // a dance on means a dance base; no dance means no dance base and the alive layer on
        if (last.dance.on) assert.ok(last.base.dance, `seed ${seed} #${i}: dancing on a dance base`);
        else if (last.dance.state === 'off') assert.ok(!last.base.dance, `seed ${seed} #${i}: base ${last.base.id} after the dance`);
        assert.equal(last.action.exclusive, last.action.state === 'dance');
      }
      // the user lets go of everything: the app's holds end, she is put down, a stop
      lifted = false;
      A.extra = {};
      d.stop('user');
      A.run(12);
      assertCleanIdle(d, A.last, `seed ${seed}`);
      // and she still does things afterwards (nothing locked): a touch is a reaction, a dance dances
      A.events.push(touch('head'));
      assert.equal(A.step().action.state, 'touch');
      A.run(4);
      A.dance('again', 1);
      assert.ok(A.run(0.7).some((x) => x.action.state === 'dance'), `seed ${seed}: dances again`);
      A.run(3);
      assertCleanIdle(d, A.last, `seed ${seed}, again`);
    }
  });
}

// ---------- the rest pose on VRM 0.x (the "hands up" without a library) ----------
let runtime = null;
const R = () => runtime || (runtime = vm.runInThisContext(`(() => {${fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'vendor', 'vrm', 'three-vrm.min.js'), 'utf8')}; return PetVrmRuntime; })()`));

test('restPoseFor: VRM 1.0 as written; VRM 0.x mirrors x / z — both lower the arms (hands below the shoulders), neither raises them', () => {
  const T = R().THREE;
  assert.deepEqual(M.restPoseFor('1'), M.REST_POSE);
  const v0 = M.restPoseFor('0');
  assert.equal(v0.leftUpperArm.z, M.ARM_DOWN);
  assert.equal(v0.rightUpperArm.z, -M.ARM_DOWN);
  assert.equal(v0.leftLowerArm.y, M.REST_POSE.leftLowerArm.y, 'y is kept');
  const DEG = Math.PI / 180;
  // the left arm points +X on a 1.0 model, −X on a 0.x model (its normalized bones face −Z)
  for (const [ver, dir] of [['1', 1], ['0', -1]]) {
    for (const [bone, side] of [['leftUpperArm', dir], ['rightUpperArm', -dir]]) {
      const r = M.restPoseFor(ver)[bone];
      const v = new T.Vector3(side, 0, 0).applyEuler(new T.Euler(r.x * DEG, r.y * DEG, r.z * DEG));
      assert.ok(v.y < -0.9, `${ver} ${bone}: the hand goes down (y ${v.y.toFixed(2)})`);
    }
    // the bug: the 1.0 pose on a 0.x arm raises it
    if (ver === '0') {
      const r = M.REST_POSE.leftUpperArm;
      const up = new T.Vector3(-1, 0, 0).applyEuler(new T.Euler(r.x * DEG, r.y * DEG, r.z * DEG));
      assert.ok(up.y > 0.9, 'the unmirrored pose would raise a 0.x arm');
    }
  }
});

// ---------- the renderer's clip layer: the rest clip, back from a dance, rapid switching ----------
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
  hips.position.set(0, 0.9, 0);
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
  // a 4 s "dance" whose arm angle is 10° × t; its last frame (40°) is the "frozen" pose to look for
  const times = [0, 1, 2, 3, 4];
  const dance = { duration: 4, bones: { hips: { times, values: times.map(() => [0, 0, 0, 1]) }, leftUpperArm: { times, values: times.map((t) => qz(-10 * t)) } }, hips: null, restHipsY: 0.9, rest: { hips: [0, 0.9, 0] } };
  const layers = ctx.window.PetVrmAnim.createAnimLayers(RT, vrm, ['leftUpperArm']);
  layers.setRest({ leftUpperArm: qz(-72) });
  return { layers, arm, hips, REST: ctx.window.PetVrmAnim.REST_ID, idle: await load(still(-60)), dance: await load(dance) };
}
const armAngle = (arm) => (2 * Math.acos(Math.min(1, Math.abs(arm.quaternion.w))) * 180) / Math.PI;

test('vrm-anim: no library — the first base is the rest clip; a dance fades in, and on its end (base id null) fades back to the rest pose instead of freezing on its last frame; the dance clip can then be let go', async () => {
  const { layers, arm, REST, dance } = await layersWith();
  layers.add('dance:t', dance);
  assert.equal(layers.playBase({ id: null }, 0), REST, 'nothing asked: the rest clip');
  layers.update(1 / 30);
  assert.equal(layers.summary(), `${REST}:1.00`);
  assert.ok(Math.abs(armAngle(arm) - 72) < 0.05, `rest ${armAngle(arm)}`);
  assert.equal(layers.playBase({ id: 'dance:t', dance: true }, 0.6, { clock: 'external', time: 0 }), 'dance:t');
  for (let t = 0; t <= 4; t += 1 / 30) { layers.seekBase(t); layers.update(1 / 30); assert.ok(Math.abs(layers.weightSum() - 1) < 1e-9); }
  assert.equal(layers.summary(), 'dance:t:1.00');
  assert.ok(Math.abs(armAngle(arm) - 40) < 0.1, 'on the last frame');
  // the end: the director's base without a clip → back to the rest pose over the fade, weights summing to 1
  assert.equal(layers.playBase({ id: null, key: 9 }, D.DANCE.fadeOut), REST);
  const seen = [];
  for (let i = 0; i < Math.ceil(D.DANCE.fadeOut * 30) + 1; i++) { layers.update(1 / 30); seen.push(armAngle(arm)); assert.ok(Math.abs(layers.weightSum() - 1) < 1e-9, layers.summary()); }
  for (let i = 1; i < seen.length; i++) assert.ok(Math.abs(seen[i] - seen[i - 1]) < 8, `a cross-fade, not a snap: ${seen.map((x) => x.toFixed(1)).join(' ')}`);
  assert.equal(layers.summary(), `${REST}:1.00`, 'the dance left the layers');
  assert.ok(Math.abs(armAngle(arm) - 72) < 0.05, `back at rest, not the dance's last frame: ${armAngle(arm).toFixed(2)}`);
  assert.equal(layers.remove('dance:t'), true, 'and its clip can be let go');
  assert.equal(layers.remove(REST), false, 'not the clip playing');
});

test('vrm-anim: an unknown base id (a slot without a clip) also falls back to the rest clip; a known idle comes back over it', async () => {
  const { layers, arm, REST, idle } = await layersWith();
  layers.add('idle', idle);
  assert.equal(layers.playBase({ id: 'idle' }, 0), 'idle');
  layers.update(1 / 30);
  assert.ok(Math.abs(armAngle(arm) - 60) < 0.05);
  assert.equal(layers.playBase({ id: 'sit.doze@female' }, 0.4), REST);
  for (let i = 0; i < 14; i++) layers.update(1 / 30);
  assert.equal(layers.summary(), `${REST}:1.00`);
  assert.equal(layers.playBase({ id: 'idle' }, 0.4), 'idle');
  for (let i = 0; i < 14; i++) layers.update(1 / 30);
  assert.equal(layers.summary(), 'idle:1.00');
});

test('vrm-anim: rapid switching (rest / idle / dance every few frames, interrupted mid-fade) — weights always 1, one clip left once it settles, the pose is that clip\'s', async () => {
  const { layers, arm, REST, idle, dance } = await layersWith();
  layers.add('idle', idle);
  layers.add('dance:t', dance);
  layers.playBase({ id: null }, 0);
  const rnd = D.seeded(5);
  const bases = [{ id: null }, { id: 'idle' }, { id: 'dance:t', dance: true }, { id: 'missing' }];
  for (let i = 0; i < 300; i++) {
    if (rnd() < 0.3) { const b = bases[Math.floor(rnd() * bases.length)]; layers.playBase(b, 0.2 + rnd() * 0.4, b.dance ? { clock: 'external', time: rnd() * 4 } : null); }
    if (layers.external()) layers.seekBase(rnd() * 4);
    layers.update(1 / 30);
    assert.ok(Math.abs(layers.weightSum() - 1) < 1e-9, `#${i} ${layers.summary()}`);
  }
  for (const [b, deg] of [[{ id: null }, 72], [{ id: 'idle' }, 60], [{ id: 'nope' }, 72]]) {
    layers.playBase(b, 0.3);
    for (let i = 0; i < 12; i++) layers.update(1 / 30);
    assert.equal(layers.summary().split(',').length, 1, layers.summary());
    assert.ok(Math.abs(armAngle(arm) - deg) < 0.05, `${b.id}: ${armAngle(arm).toFixed(2)}`);
  }
  assert.equal(layers.current(), REST);
});
