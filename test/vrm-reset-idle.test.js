'use strict';
// 重置姿势 (T-2830): one user command brings the VRM figure back to the idle from any state — dancing, eating,
// playing, asleep, a reaction or a touch streak's anger, held up in the air, a dance the app does not let go —
// on the T-2829 action state machine (director.reset() = stop() + the flags stop() keeps), fading (… →
// returning → idle, never a snap), and changes nothing when she is already idle. Also the app's parts: the
// wake without affection (core/reset-wake.js wakeForReset — outside the frozen core/pet-state.js) and the local API route (core/api.js POST /reset-pose).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
const state = require('../src/core/pet-state');
const resetWake = require('../src/core/reset-wake');
const api = require('../src/core/api');
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
function make(lib = true, seed = 3) {
  const style = S.resolveStyle({ packStyle: { base: 'female' } });
  if (!lib) return D.createDirector({ style, index: { clips: {} }, loaded: new Set(), rand: D.seeded(seed) });
  const index = bakedIndex();
  return D.createDirector({ style, index, loaded: new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id)), rand: D.seeded(seed) });
}

// The app around the director (as renderer/vrm-dance.js and app.js): it holds the dance and its clock and obeys
// plan.dance.request, holds a meal / sleep / a lift; resetPose() is app.js resetPose + main's wake: the app's
// holds end, then director.reset().
function app(d, { obey = true } = {}) {
  const A = { id: null, t: 0, playing: false, paused: null, duration: 4, extra: {}, events: [], stops: [], last: null };
  A.dance = (id, duration = 4) => Object.assign(A, { id, t: 0, playing: false, paused: null, duration });
  A.stopDance = (why = 'user') => { if (A.id) A.stops.push(why); A.id = null; };
  A.step = (dt = 1 / 30) => {
    const dance = A.id ? { id: A.id, t: A.t, duration: A.duration, loop: true, ready: true, playing: A.playing, paused: A.paused } : null;
    const plan = d.update(dt, { holds: holdsOf({ ...A.extra, dance }), events: A.events.splice(0) });
    const r = plan.dance.request;
    if (r === 'start') A.playing = true;
    if (r === 'stop' && obey) A.stopDance('director');
    if (A.id && A.playing && !A.paused) A.t = (A.t + dt) % A.duration; // a looping dance never ends by itself
    A.last = plan;
    return plan;
  };
  A.run = (s, dt = 1 / 30) => { const out = []; for (let i = 0; i < Math.round(s / dt); i++) out.push(A.step(dt)); return out; };
  A.resetPose = (source = 'button') => {
    A.stopDance('reset');
    A.extra = { ...A.extra, eat: null, lift: false, walk: false, mood: A.extra.mood === 'sleep' ? 'idle' : A.extra.mood || 'idle' };
    return d.reset(`reset:${source}`);
  };
  return A;
}
const touch = (zone = 'head', mood = 'happy') => ({ type: 'touch', zone, mood });
function assertCleanIdle(d, plan, label) {
  assert.equal(plan.action.state, 'idle', `${label}: action ${plan.action.state}`);
  assert.equal(plan.dance.state, 'off', `${label}: dance ${plan.dance.state}`);
  assert.ok(!(plan.base && plan.base.dance), `${label}: the base is not a dance`);
  assert.deepEqual(plan.overlays, [], `${label}: overlays ${JSON.stringify(plan.overlays)}`);
  assert.equal(plan.hold, null, `${label}: hold ${plan.hold}`);
  assert.equal(plan.reaction, null, `${label}: reaction ${plan.reaction}`);
  assert.equal(plan.life.dance, false);
  assert.equal(plan.life.sleep, false, `${label}: awake`);
  assert.ok(!plan.face.angry, `${label}: no anger left on her face (${JSON.stringify(plan.face)})`);
  assert.equal(d.state.react, null);
  assert.equal(d.state.fading.length, 0);
  assert.equal(d.state.holds.size, 0);
  assert.equal(d.state.queued, null);
  assert.equal(d.state.stopAsked, null, `${label}: no stop left pending`);
}
// reset from `label`: … → returning → idle, faded (not a snap: the frame after the reset is not idle yet unless
// nothing was left), the transitions say why, and the idle is clean within `within` s
// (`fades: false`: nothing of it is a clip layer — asleep without a motion library she only breathes slower and
// closes her eyes, which the alive layer eases out by itself — so idle follows at once)
function assertResetsToIdle(d, A, label, within = 2, { fades = true } = {}) {
  const before = A.last.action.state;
  assert.notEqual(before, 'idle', `${label}: not idle before the reset`);
  const nBefore = d.actions().length;
  const r = A.resetPose('test');
  assert.equal(r.reset, true, `${label}: reset done`);
  assert.equal(r.was, before);
  const after = A.run(within);
  const idleAt = after.findIndex((p) => p.action.state === 'idle');
  assert.ok(idleAt >= 0, `${label}: idle within ${within} s (${[...new Set(after.map((p) => p.action.state))].join(' → ')})`);
  assert.ok(after.slice(idleAt).every((p) => p.action.state === 'idle'), `${label}: stays idle`);
  if (fades) assert.equal(after[0].action.state, 'returning', `${label}: fades back (returning), not snapped`);
  const moves = d.actions().slice(nBefore);
  assert.deepEqual(moves.map((m) => m.to), fades ? ['returning', 'idle'] : ['idle'], `${label}: ${JSON.stringify(moves)}`);
  assert.ok(moves.every((m) => m.why === 'reset:test'), `${label}: the transitions say it was the reset`);
  assertCleanIdle(d, after[after.length - 1], label);
  return { idleAfter: idleAt / 30, moves };
}

for (const lib of [true, false]) {
  const tag = lib ? 'library' : 'no library';

  test(`[${tag}] already idle: reset is a no-op — the same frames as without it`, () => {
    const d1 = make(lib, 9);
    const d2 = make(lib, 9);
    const A1 = app(d1);
    const A2 = app(d2);
    A1.run(3);
    A2.run(3);
    assert.equal(A1.last.action.state, 'idle');
    const r = d1.reset('reset:test');
    assert.deepEqual(r, { reset: false, noop: true, was: 'idle', why: 'reset:test' });
    const p1 = A1.run(15);
    const p2 = A2.run(15);
    assert.deepEqual(p1, p2, 'nothing changed: base, idle, face, gaze, overlays all the same');
    assert.deepEqual(d1.resets(), []);
    assert.deepEqual(d1.actions(), []);
  });

  test(`[${tag}] dancing (a looping dance, exclusive layer) → reset → returning → idle`, () => {
    const d = make(lib);
    const A = app(d);
    A.run(1);
    A.dance('loop', 4);
    A.run(2);
    assert.equal(A.last.action.state, 'dance');
    assert.equal(A.last.action.exclusive, true);
    const { idleAfter } = assertResetsToIdle(d, A, 'dance');
    assert.ok(idleAfter <= D.DANCE.fadeOut + 0.05, `back in ${idleAfter.toFixed(2)} s (the dance's fade ${D.DANCE.fadeOut} s)`);
    assert.deepEqual(A.stops, ['reset']);
    // not stuck: she dances again afterwards
    A.dance('loop', 4);
    A.run(1.5);
    assert.equal(A.last.action.state, 'dance', 'a new dance plays after the reset');
  });

  test(`[${tag}] a dance the app does not let go (stuck): the director's reset asks it to stop → idle`, () => {
    const d = make(lib);
    const A = app(d);
    A.run(1);
    A.dance('stuck', 4);
    A.run(2);
    assert.equal(A.last.action.state, 'dance');
    const r = d.reset('reset:test'); // only the director (the app's own stop did not happen)
    assert.equal(r.reset, true);
    const p = A.step();
    assert.equal(p.dance.request, 'stop', 'the director asks the app to stop the dance');
    assert.equal(A.id, null);
    A.run(1.5);
    assertCleanIdle(d, A.last, 'stuck dance');
  });

  test(`[${tag}] eating (the meal hold) → reset → idle`, () => {
    const d = make(lib);
    const A = app(d);
    A.run(1);
    A.extra = { eat: 'rice' };
    A.run(1);
    assert.equal(A.last.action.state, 'eat');
    assertResetsToIdle(d, A, 'eat');
  });

  test(`[${tag}] asleep (mood sleep: sit.doze) → reset (she wakes) → idle, standing`, () => {
    const d = make(lib);
    const A = app(d);
    A.run(1);
    A.extra = { mood: 'sleep' };
    A.run(3);
    assert.equal(A.last.action.state, 'sleep');
    assert.equal(A.last.life.sleep, true);
    assertResetsToIdle(d, A, 'sleep', 3); // with a library sit.doze cross-fades back to the idle clip; without one the procedural sleep body (T-2831) fades out
    assert.notEqual(A.last.posture, 'sit.doze');
    assert.equal(A.last.life.standing, true, 'standing again');
  });

  test(`[${tag}] playing (a play cue's cheer) → reset → idle`, () => {
    const d = make(lib, 5);
    const A = app(d);
    A.run(1);
    for (let i = 0; i < 40 && A.last.action.state !== 'play'; i++) { A.events.push({ type: 'cue', name: 'play' }); A.step(); if (A.last.action.state !== 'play') A.run(2); }
    assert.equal(A.last.action.state, 'play', 'a play reaction started');
    A.run(0.4); // into it (a reaction cut on its very first frame has nothing to fade)
    assert.equal(A.last.action.state, 'play');
    assertResetsToIdle(d, A, 'play');
  });

  test(`[${tag}] a touch streak's anger, a waiting celebration and a lift (stuck after a drag) → reset → idle`, () => {
    const d = make(lib);
    const A = app(d);
    A.run(1);
    for (let i = 0; i < 6; i++) { A.events.push(touch('butt', i < 3 ? 'annoyed' : 'angry')); A.run(0.3); }
    A.events.push({ type: 'celebrate', name: 'evolve' });
    A.step();
    assert.notEqual(A.last.action.state, 'idle');
    assertResetsToIdle(d, A, 'angry touch');
    assert.ok(d.state.angryUntil < 0, 'the anger after a streak is cleared');
    // held in the air and never put down (the drop never came)
    A.extra = { ...A.extra, lift: true };
    A.run(1);
    assert.equal(A.last.action.state, 'lift');
    // the app lets go (lift false) and the intent sends the drop of that let-go on the next frame: no landing
    const n = d.reactions().length;
    A.events.push({ type: 'drag', what: 'drop' });
    assertResetsToIdle(d, A, 'lift');
    assert.equal(d.reactions().length, n, 'no react.drop after a reset');
    // a real drop later lands as usual
    A.extra = { ...A.extra, lift: true };
    A.run(1);
    A.extra = { ...A.extra, lift: false };
    A.events.push({ type: 'drag', what: 'drop' });
    A.step();
    assert.equal(A.last.reaction, 'react.drop');
  });

  test(`[${tag}] reset midway through anything, again and again: always the same clean idle`, () => {
    const d = make(lib, 11);
    const A = app(d);
    const rnd = D.seeded(77);
    A.run(1);
    for (let i = 0; i < 40; i++) {
      const k = rnd();
      if (k < 0.2) A.dance(`d${i}`, 3);
      else if (k < 0.35) A.extra = { ...A.extra, eat: 'cookie' };
      else if (k < 0.5) A.extra = { ...A.extra, mood: 'sleep' };
      else if (k < 0.6) A.extra = { ...A.extra, lift: true };
      else if (k < 0.75) A.events.push(touch(['head', 'belly', 'hands'][i % 3]));
      else if (k < 0.85) A.events.push({ type: 'celebrate', name: 'hatch' });
      A.run(0.2 + rnd());
      if (rnd() < 0.5) A.resetPose('fuzz');
    }
    A.resetPose('fuzz');
    A.run(3);
    assertCleanIdle(d, A.last, 'after the run');
    assert.ok(d.resets().length > 5);
  });
}

test('wakeForReset: asleep → awake without the grumpy mood or affection, and she stays up at night; awake → nothing', () => {
  const night = new Date(2026, 10, 4, 23, 30).getTime();
  const pet = state.createPet({ speciesId: 'dafeiyu', name: 'x', topicId: 't', now: night });
  assert.equal(resetWake.wakeForReset(pet, night), false, 'awake: nothing to do');
  assert.equal(pet.awakeUntil, undefined);
  state.putToSleep(pet, night);
  pet.energy = 5;
  const mood = pet.mood;
  const aff = pet.affection;
  assert.equal(state.currentStatus(pet), 'sleep');
  assert.equal(resetWake.wakeForReset(pet, night), true);
  assert.equal(pet.sleeping, false);
  assert.equal(state.currentStatus(pet) === 'sleep', false);
  assert.equal(pet.mood, mood, 'no grumpy mood (a wake by touch costs 8)');
  assert.equal(pet.affection, aff, 'no affection lost');
  assert.equal(pet.energy, 15);
  // at night with low energy the next ticks would put her straight back to sleep: not within RESET_AWAKE_MIN
  const MIN = 60 * 1000;
  resetWake.tick(pet, night + 5 * MIN);
  assert.equal(pet.sleeping, false, 'still awake 5 min later');
  resetWake.tick(pet, night + (resetWake.RESET_AWAKE_MIN + 1) * MIN);
  assert.equal(pet.sleeping, true, 'after the grace she may fall asleep again on her own');
  // the grace is the wrapper's: pet-state itself (frozen for the pixel characters) is untouched by it
  assert.equal(state.wakeForReset, undefined);
  assert.equal(state.RESET_AWAKE_MIN, undefined);
});

test('reset-wake.tick: outside a grace it is pet-state.tick, same needs and events', () => {
  const MIN = 60 * 1000;
  const night = new Date(2026, 10, 4, 23, 30).getTime();
  const mk = () => { const p = state.createPet({ speciesId: 'dafeiyu', name: 'x', topicId: 't', now: night }); p.energy = 30; return p; };
  const a = mk();
  const b = mk();
  const ra = state.tick(a, night + 10 * MIN);
  const rb = resetWake.tick(b, night + 10 * MIN);
  assert.deepEqual(rb.events, ra.events);
  assert.ok(ra.events.includes('slept'));
  assert.deepEqual(b, a);
  // inside the grace: same needs, only the falling asleep (and its event) is held back
  const c = mk();
  const d = mk();
  c.awakeUntil = d.awakeUntil = night + 15 * MIN;
  state.tick(c, night + 10 * MIN);
  const rd = resetWake.tick(d, night + 10 * MIN);
  assert.equal(d.sleeping, false);
  assert.equal(rd.events.includes('slept'), false);
  assert.deepEqual({ ...d, sleeping: true }, c);
});

test('local API: POST /reset-pose → ctx.resetPose; 409 without a pet; 404 without the handler; listed in the routes', async () => {
  const token = 't0ken-t0ken-t0ken-t0ken-1';
  const req = (method, p) => ({ method, path: `${api.PREFIX}${p}`, headers: { host: '127.0.0.1:7340', authorization: `Bearer ${token}` }, body: {} });
  let n = 0;
  const ctx = (over = {}) => ({ token, state: async () => ({}), resetPose: async () => { n++; return { ok: true, before: ['dance'], cleared: ['dance'], woke: false }; }, ...over });
  assert.ok(api.ROUTES.some(([m, r]) => m === 'POST' && r === '/reset-pose'));
  let r = await api.handle(req('POST', '/reset-pose'), ctx());
  assert.deepEqual(r, { status: 200, json: { ok: true, before: ['dance'], cleared: ['dance'], woke: false } });
  assert.equal(n, 1);
  r = await api.handle(req('GET', '/reset-pose'), ctx());
  assert.equal(r.status, 405);
  r = await api.handle(req('POST', '/reset-pose'), ctx({ resetPose: async () => ({ ok: false, reason: 'no-pet' }) }));
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'no-pet');
  r = await api.handle(req('POST', '/reset-pose'), ctx({ resetPose: undefined }));
  assert.equal(r.status, 404);
});
