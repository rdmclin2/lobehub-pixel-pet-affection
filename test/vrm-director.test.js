'use strict';
// The VRM director (src/core/vrm-director.js, docs/vrm-motion-system.md §3): idle scheduling (8–20 s, never
// the same twice in a row, mood bias), postures (the user's choice, sleep, sad, bored → sitting, standing up
// again), cross-fade times, female / male picking different clips, and what happens without a library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');

// the runtime index the bake writes, from the repository's bake list (every clip "baked")
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'vrm-library.json'), 'utf8'));
function bakedIndex(drop = () => false) {
  const clips = {};
  for (const [id, e] of Object.entries(manifest.clips)) {
    if (drop(id)) continue;
    const { slot, style } = L.parseId(id);
    const runtime = Object.fromEntries(['mask', 'weight', 'hold', 'fadeIn', 'fadeOut', 'still', 'face', 'gaze'].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
    const duration = e.kind === 'posture' || e.still ? 1 : e.kind === 'reaction' || e.kind === 'hold' ? (e.trim ? e.trim[1] - e.trim[0] : 2.5) : id.startsWith('idle.happy@male') ? 2 : 10;
    clips[id] = e.src ? { kind: e.kind, style, label: e.label, file: `${style}/${slot}.vrma`, duration, ...(e.sit ? { sit: true } : {}), ...(e.loop ? { loop: true } : {}), ...runtime } : { kind: e.kind, style, cycle: e.cycle, every: e.every };
  }
  return L.cleanIndex({ clips });
}
const allLoaded = (index) => new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id));
const idleHolds = (o = {}) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: true, facing: 'right', ...o });
function make(opts = {}) {
  const index = opts.index || bakedIndex();
  return D.createDirector({ style: S.resolveStyle({ packStyle: { base: opts.style || 'female' } }), index, loaded: opts.loaded || allLoaded(index), rand: D.seeded(opts.seed || 1), ...opts.extra });
}
// run for `seconds` at `dt`, collecting each plan
function run(d, seconds, holds = idleHolds(), dt = 0.1, events = () => []) {
  const plans = [];
  for (let t = 0; t < seconds; t += dt) plans.push(d.update(dt, { holds, events: events(t) }));
  return plans;
}

test('idle schedule: each idle lasts 8–20 s, the next is never the same as the last, ≥ 3 variants show up', () => {
  for (const style of ['female', 'male']) {
    for (const seed of [1, 2, 3, 4, 5]) {
      const d = make({ style, seed });
      const plans = run(d, 600);
      const h = d.history();
      for (let i = 1; i < h.length; i++) assert.notEqual(h[i], h[i - 1], `${style} seed ${seed}: ${h.join(' → ')}`);
      assert.ok(new Set(h).size >= 3, `${style}: ${new Set(h).size} variants`);
      // the length of each idle (between changes)
      const spans = [];
      let start = 0;
      for (let i = 1; i < plans.length; i++) if (plans[i].idle !== plans[i - 1].idle || plans[i].idleLeft > plans[i - 1].idleLeft + 0.5) { spans.push(plans[i].t - plans[start].t); start = i; }
      for (const s of spans) assert.ok(s >= 7.9 && s <= 20.2, `${style} seed ${seed}: an idle lasted ${s.toFixed(1)} s`);
    }
  }
});

test('idle clips last a whole number of loops; a short clip (2 s) is repeated, not cut', () => {
  const d = make({ style: 'male', seed: 9 });
  const seen = new Map();
  for (let t = 0; t < 600; t += 0.1) {
    d.update(0.1, { holds: idleHolds(), events: [] });
    const I = d.state.idle;
    if (I.kind === 'clip') seen.set(I.started, { slot: I.slot, len: I.until - I.started, dur: I.clip.duration });
  }
  assert.ok(seen.size >= 5, `${seen.size} clip idles`);
  for (const { slot, len, dur } of seen.values()) {
    const loops = len / dur;
    assert.ok(Math.abs(loops - Math.round(loops)) < 1e-6 && len >= 8 - 1e-6 && len <= 20 + 1e-6, `${slot}: ${len.toFixed(2)} s of a ${dur} s clip`);
  }
});

test('mood happy doubles idle.happy; sad / hungry hold stand.shy; sleep sits down to sit.doze with micro idles', () => {
  let happy = 0;
  let other = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const d = make({ seed });
    run(d, 300, idleHolds({ mood: 'happy' }));
    for (const s of d.history()) if (s === 'idle.happy') happy++; else other++;
  }
  assert.ok(happy / (happy + other) > 0.4, `idle.happy share when happy ${(happy / (happy + other)).toFixed(2)}`);
  const sad = make();
  const p = run(sad, 30, idleHolds({ mood: 'sad' })).pop();
  assert.equal(p.posture, 'stand.shy');
  assert.equal(p.postureSource, 'mood');
  assert.equal(p.base.id, 'stand.shy@female');
  assert.ok(D.MICRO_IDLES[p.idle], `a held posture idles with micro variants: ${p.idle}`);
  assert.ok(p.face.sad > 0.3);
  const sleep = make();
  const q = run(sleep, 30, idleHolds({ mood: 'sleep' })).pop();
  assert.equal(q.posture, 'sit.doze');
  assert.equal(q.base.sit, true);
  assert.equal(q.life.sleep, true);
  assert.equal(q.life.standing, false);
  assert.equal(q.face.blink, 1);
  assert.equal(q.gaze.mode, 'fixed');
});

test('postures: the user\'s choice holds (all six), switches cross-fade 1.0 s (1.2 s stand ↔ sit), the first clip at once', () => {
  const d = make();
  const p0 = d.update(0.1, { holds: idleHolds(), events: [] });
  assert.equal(p0.base.fade, 0, 'the first clip comes in at once (no fade from the T-pose)');
  let key = p0.base.key;
  let last = p0.base;
  for (const posture of L.POSTURES) {
    d.setPosture(posture);
    const p = run(d, 3).pop();
    assert.equal(p.posture, posture);
    assert.equal(p.postureSource, 'setting');
    assert.equal(p.base.id, `${posture}@female`);
    assert.ok(p.base.key > key, 'a new base');
    const sitChange = !!p.base.sit !== !!last.sit;
    assert.equal(p.base.fade, sitChange ? D.FADE.sit : D.FADE.posture, posture);
    assert.ok(p.base.fade >= 0.8 && p.base.fade <= 1.2);
    key = p.base.key;
    last = p.base;
    // held: the idle varies without leaving the posture
    const held = run(d, 60);
    assert.ok(held.every((x) => x.base.id === `${posture}@female`), 'the posture stays while idles change');
    assert.ok(new Set(held.map((x) => x.idle)).size >= 2);
  }
  d.setPosture('auto');
  assert.equal(d.posture, 'auto');
  d.setPosture('upside-down');
  assert.equal(d.posture, 'auto', 'an unknown posture is auto');
});

test('posture-cycle goes through its standing postures every `every` s (female 12 s)', () => {
  const index = bakedIndex((id) => /^idle\.(happy|variant2)@/.test(id)); // only the cycle left
  const d = make({ index, seed: 3 });
  const plans = run(d, 40);
  const seq = [];
  for (const p of plans) if (seq[seq.length - 1] !== p.posture) seq.push(p.posture);
  assert.ok(seq.length >= 3, seq.join(' → '));
  for (const s of seq) assert.ok(['stand.relaxed', 'stand.confident', 'stand.playful'].includes(s), s);
  assert.ok(plans.every((p) => p.idle === 'idle.posture-cycle' || D.MICRO_IDLES[p.idle]));
});

test('nobody around for 180 s → she sits down (sit.rest); the cursor comes back → she stands up again', () => {
  const d = make({ seed: 4 });
  const away = idleHolds({ attention: false });
  let p = run(d, 179, away).pop();
  assert.notEqual(p.posture, 'sit.rest');
  p = run(d, 2, away).pop();
  assert.equal(p.posture, 'sit.rest');
  assert.equal(p.postureSource, 'bored');
  assert.equal(p.base.fade, D.FADE.sit, 'stand → sit fades 1.2 s');
  p = run(d, 1, idleHolds({ attention: true })).pop();
  assert.notEqual(p.posture, 'sit.rest');
  assert.equal(p.base.sit, false);
  // any event counts as attention too
  const e = make({ seed: 4 });
  run(e, 170, away);
  p = run(e, 20, away, 0.1, (t) => (Math.abs(t - 5) < 0.05 ? [{ type: 'touch', zone: 'head', mood: 'happy' }] : [])).pop();
  assert.notEqual(p.posture, 'sit.rest', 'a touch at 175 s resets the clock');
});

test('female and male pick different clips and sizes for the same moment; neutral borrows the female set', () => {
  const f = make({ style: 'female', seed: 2 });
  const m = make({ style: 'male', seed: 2 });
  for (const d of [f, m]) d.setPosture('stand.confident');
  const pf = run(f, 2).pop();
  const pm = run(m, 2).pop();
  assert.equal(pf.base.id, 'stand.confident@female');
  assert.equal(pm.base.id, 'stand.confident@male');
  // the same touch: the male face is the female's × 0.8
  const touch = [{ type: 'touch', zone: 'head', mood: 'happy' }];
  const ff = f.update(0.1, { holds: idleHolds(), events: touch });
  const fm = m.update(0.1, { holds: idleHolds(), events: touch });
  assert.ok(Math.abs(fm.face.relaxed - ff.face.relaxed * 0.8) < 1e-9, `${ff.face.relaxed} vs ${fm.face.relaxed}`);
  // idles: every clip the male idles with is from the male set
  const mm = make({ style: 'male', seed: 5 });
  const bases = new Set(run(mm, 300).map((p) => p.base.id));
  for (const b of bases) assert.match(b, /@male$/);
  const n = make({ style: 'neutral', seed: 5 });
  const nb = new Set(run(n, 120).map((p) => p.base.id));
  for (const b of nb) assert.match(b, /@female$/, 'neutral: female postures (no neutral set baked)');
});

test('pack.json vrm.motions overrides a slot', () => {
  const index = bakedIndex();
  const d = D.createDirector({ style: S.resolveStyle({ packStyle: { base: 'female' } }), index, loaded: allLoaded(index), overrides: { 'stand.relaxed': 'stand.relaxed@male' }, rand: D.seeded(1) });
  d.setPosture('stand.relaxed');
  assert.equal(run(d, 2).pop().base.id, 'stand.relaxed@male');
});

test('missing motions: an empty library (or none loaded) falls back to the pack idle / the rest pose, without throwing', () => {
  const empty = D.createDirector({ style: S.resolveStyle({}), index: L.cleanIndex(null), loaded: new Set(), rand: D.seeded(1) });
  const plans = run(empty, 120);
  assert.ok(plans.every((p) => p.base && p.base.id === null), 'no clip: base null (the renderer keeps arms-down rest + alive layer)');
  assert.ok(new Set(empty.history()).size >= 3, 'micro idles still vary');
  const pack = D.createDirector({ style: S.resolveStyle({}), index: L.cleanIndex(null), loaded: new Set(), packIdle: true, rand: D.seeded(1) });
  assert.equal(run(pack, 1).pop().base.id, 'pack.idle');
  // a library whose files did not load: the same
  const index = bakedIndex();
  const none = D.createDirector({ style: S.resolveStyle({ packStyle: { base: 'male' } }), index, loaded: new Set(), rand: D.seeded(1) });
  assert.equal(run(none, 30).pop().base.id, null);
  // half loaded: only clips that loaded are used; a missing posture falls back to stand.relaxed
  const some = new Set(['stand.relaxed@female', 'idle.happy@female']);
  const half = D.createDirector({ style: S.resolveStyle({ packStyle: { base: 'female' } }), index, loaded: some, rand: D.seeded(2) });
  const hp = run(half, 200);
  for (const p of hp) assert.ok(p.base.id === null || some.has(p.base.id), p.base.id);
  half.setPosture('sit.doze');
  assert.equal(run(half, 1).pop().base.id, 'stand.relaxed@female');
});

test('holds and faces: lift > think > eat > talk; touch faces by mood; thinking looks up; no motion words anywhere', () => {
  const d = make();
  assert.equal(d.update(0.1, { holds: idleHolds({ lift: true, think: true, talk: true }), events: [] }).hold, 'lift');
  assert.equal(d.update(0.1, { holds: idleHolds({ think: true, eat: 'rice' }), events: [] }).hold, 'think');
  const th = d.update(0.1, { holds: idleHolds({ think: true }), events: [] });
  assert.deepEqual([th.gaze.mode, th.gaze.y > 1], ['fixed', true]);
  assert.equal(d.update(0.1, { holds: idleHolds({ eat: 'rice', talk: true }), events: [] }).hold, 'eat');
  assert.equal(d.update(0.1, { holds: idleHolds({ talk: true }), events: [] }).hold, 'talk');
  for (const [mood, want] of [['angry', 'angry'], ['annoyed', 'angry'], ['ticklish', 'happy'], ['shy', 'surprised'], ['happy', 'relaxed']]) {
    const e = make();
    const p = e.update(0.1, { holds: idleHolds(), events: [{ type: 'touch', zone: 'chest', mood }] });
    assert.ok(p.face[want] > 0, `${mood} → ${want}: ${JSON.stringify(p.face)}`);
    if (mood === 'angry') assert.equal(p.noBlink, true, 'angry: a stare without blinking');
    if (mood === 'shy') assert.ok(p.gaze.mode === 'fixed' && p.gaze.y < 0, 'shy: looks down aside');
    const after = run(e, 6).pop();
    assert.equal(after.reaction, null, `${mood}: the reaction is over`);
    if (mood === 'angry') assert.ok(after.face.angry > 0 && after.face.angry < 0.5, `angry: still a little cross for a while ${JSON.stringify(after.face)}`);
    else assert.deepEqual(after.face, {}, `${mood}: the face fades back to the mood's`);
  }
  const words = JSON.stringify(run(make(), 60));
  for (const w of ['hop', 'spin', 'dangle', 'stride', 'wobble', 'shake', 'flail']) assert.ok(!words.includes(`"${w}"`), w);
  // facing: a turn of the body (yaw), not a mirror
  assert.equal(d.update(0.1, { holds: idleHolds({ facing: 'left' }), events: [] }).facingYaw, -18);
  assert.equal(d.update(0.1, { holds: idleHolds({ facing: 'right', walk: true }), events: [] }).facingYaw, 60);
});
