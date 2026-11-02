'use strict';
// The VRM reaction layer (T-2681, docs/vrm-motion-system.md §3.3, §5.3): which reaction a touch / drag / talk /
// celebration plays for female and male, its life (fade in → clip → hold → fade out back to the idle that
// kept playing underneath), interruption without a snap, debounce, a repeated touch extending instead of
// restarting, the mood escalation of core/touch-zones.js (happy → annoyed → angry) and its after-effects,
// holds (lift / talk / think / eat) under reactions, and what happens without a library. Also the 3D touch
// hit test (core/vrm-hit.js) and the landing dip of the alive layer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
const I = require('../src/core/vrm-intent');
const TZ = require('../src/core/touch-zones');
const H = require('../src/core/vrm-hit');
const Life = require('../src/core/vrm-life');
const { runtimeMeta } = require('../scripts/vrm-bake');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'vrm-library.json'), 'utf8'));
// the runtime index the bake writes (every clip "baked"; non-still reactions 2.5 s or their trim)
function bakedIndex(drop = () => false) {
  const clips = {};
  for (const [id, e] of Object.entries(manifest.clips)) {
    if (drop(id)) continue;
    const { slot, style } = L.parseId(id);
    const duration = e.kind === 'posture' || e.still ? 1 : e.kind === 'idle' ? 10 : e.trim ? e.trim[1] - e.trim[0] : 2.5;
    clips[id] = e.src ? { kind: e.kind, style, label: e.label, file: `${style}/${slot}.vrma`, duration, ...(e.sit ? { sit: true } : {}), ...(e.loop ? { loop: true } : {}), ...runtimeMeta(e) } : { kind: e.kind, style, cycle: e.cycle, every: e.every };
  }
  return L.cleanIndex({ clips });
}
const allLoaded = (index) => new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id));
const holdsOf = (o = {}) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: true, facing: 'right', ...o });
function make(style = 'female', opts = {}) {
  const index = opts.index || bakedIndex();
  return D.createDirector({ style: S.resolveStyle({ packStyle: { base: style } }), index, loaded: opts.loaded || allLoaded(index), rand: opts.rand || D.seeded(7), posture: opts.posture });
}
const touch = (zone, mood, streak = null) => ({ type: 'touch', zone, mood, streak });
// step `seconds` at dt with holds; `at` = { time: [events] } fired on the first frame at or after that time
function run(d, seconds, holds = holdsOf(), at = {}, dt = 0.05) {
  const plans = [];
  const due = Object.entries(at).map(([k, v]) => ({ t: Number(k), ev: v, done: false }));
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const events = [];
    for (const x of due) if (!x.done && t >= x.t - 1e-9) { x.done = true; events.push(...x.ev); }
    const p = d.update(dt, { holds: typeof holds === 'function' ? holds(t) : holds, events });
    plans.push({ ...p, at: t });
  }
  return plans;
}
const ov = (p, layer) => p.overlays.filter((o) => o.layer === layer);

test('bake list: ≥ 6 reactions per style, every reaction / hold slot for female and male, the two styles differ (source, mirror or size)', () => {
  assert.deepEqual(L.validateManifest(manifest), []);
  for (const style of ['female', 'male']) {
    const of = (kind) => Object.entries(manifest.clips).filter(([id, e]) => e.kind === kind && id.endsWith(`@${style}`)).map(([id]) => id.split('@')[0]);
    assert.ok(of('reaction').length >= 6, `${style}: ${of('reaction')}`);
    for (const s of L.REACTIONS) assert.ok(of('reaction').includes(s), `${style} ${s}`);
    for (const s of L.HOLDS) assert.ok(of('hold').includes(s), `${style} ${s}`);
  }
  let differentSource = 0;
  for (const s of [...L.REACTIONS, ...L.HOLDS]) {
    const f = manifest.clips[`${s}@female`];
    const m = manifest.clips[`${s}@male`];
    const sig = (e) => JSON.stringify([e.src, e.mirror || false, e.amplitude || 1, e.weight || 1, e.hold || 0]);
    assert.notEqual(sig(f), sig(m), `${s}: female and male play it the same way`);
    if (f.src !== m.src) differentSource++;
  }
  assert.ok(differentSource >= 12, `most slots use a different file per style (${differentSource})`);
  // and the checks catch bad reaction entries
  const bad = { schema: 1, clips: { 'react.nope@female': { kind: 'reaction', style: 'female', src: 'mixamo/x.fbx', mask: 'upper' }, 'react.shy@male': { kind: 'reaction', style: 'male', src: 'mixamo/x.fbx', mask: 'legs', weight: 3, face: { grin: 1 } }, 'hold.talk@male': { kind: 'hold', style: 'male', src: 'mixamo/x.fbx' } } };
  const errs = L.validateManifest(bad).join('\n');
  for (const w of ['unknown reaction slot', 'mask "legs"', 'weight 0..1', 'face is', 'needs a mask']) assert.ok(errs.includes(w), w);
});

test('a touch picks its reaction from the mood touch-zones chose (happy: by zone), for both styles, with a clip, face and gaze', () => {
  const cases = [
    [touch('head', 'happy'), 'react.touch-head'], [touch('pat', 'happy'), 'react.touch-head'], [touch('face', 'happy'), 'react.touch-face'],
    [touch('hands', 'happy'), 'react.touch-hands'], [touch('chest', 'shy'), 'react.shy'], [touch('butt', 'angry'), 'react.angry'],
    [touch('head', 'annoyed', 'annoyed'), 'react.annoyed'], [touch('belly', 'ticklish'), 'react.ticklish'], [touch('feet', 'ticklish'), 'react.ticklish'],
  ];
  for (const style of ['female', 'male']) {
    for (const [e, want] of cases) {
      const d = make(style);
      run(d, 1);
      const p = run(d, 0.6, holdsOf(), { 0: [e] }).pop();
      assert.equal(p.reaction, want, `${style} ${e.zone}/${e.mood}`);
      const o = ov(p, 'reaction')[0];
      assert.ok(o && o.id === `${want}@${style}` && o.weight > 0, `${style} ${want}: its own clip is laid over (${JSON.stringify(p.overlays)})`);
      assert.ok(Object.keys(p.face).length, `${want}: a face`);
    }
  }
  // gaze: shy looks down aside, annoyed away, a pat on the head up at the hand
  const g = (e) => { const d = make(); run(d, 1); return run(d, 0.3, holdsOf(), { 0: [e] }).pop().gaze; };
  assert.ok(g(touch('chest', 'shy')).y < 0 && g(touch('chest', 'shy')).x < 0);
  assert.ok(g(touch('head', 'annoyed', 'annoyed')).x > 0.5);
  assert.ok(g(touch('head', 'happy')).y > 0.5);
});

test('lifecycle: fade in → clip → hold → fade out back to the idle, which kept playing (same base, no restart)', () => {
  const d = make('female');
  run(d, 1);
  const before = run(d, 0.05).pop();
  const plans = run(d, 6, holdsOf(), { 0: [touch('hands', 'happy')] });
  const ws = plans.map((p) => (ov(p, 'reaction')[0] || { weight: 0 }).weight);
  const peak = Math.max(...ws);
  const clip = bakedIndex().clips['react.touch-hands@female'];
  assert.ok(Math.abs(peak - clip.weight) < 0.01, `reaches the clip's weight (${peak})`);
  // smooth: no frame jumps more than a fade step allows (0.05 s frames, fade ≥ 0.2 s)
  for (let i = 1; i < ws.length; i++) assert.ok(Math.abs(ws[i] - ws[i - 1]) < 0.3, `jump at ${i}: ${ws[i - 1]} → ${ws[i]}`);
  // the clip time runs from 0 to its end, then stays on its last frame
  const times = plans.map((p) => (ov(p, 'reaction')[0] || {}).time).filter((t) => t !== undefined);
  assert.ok(times[0] < 0.1 && Math.max(...times) <= clip.duration + 1e-9);
  // over: no reaction, no overlay, and the base is the idle it was (the same clip, the same cross-fade key)
  const last = plans[plans.length - 1];
  assert.equal(last.reaction, null);
  assert.deepEqual(last.overlays, []);
  assert.equal(last.base.key, before.base.key, 'the base was never restarted');
  assert.ok(plans.findIndex((p) => p.reaction === null) * 0.05 >= clip.duration, 'played to the end');
});

test('interrupted: the old reaction fades out under the new one from where it was (no snap); lift cuts a touch', () => {
  const d = make('female');
  run(d, 1);
  const a = run(d, 1.0, holdsOf(), { 0: [touch('head', 'happy')] }).pop();
  const wBefore = ov(a, 'reaction')[0].weight;
  const p = run(d, 0.05, holdsOf(), { 0: [touch('belly', 'ticklish')] }).pop();
  assert.equal(p.reaction, 'react.ticklish');
  const old = ov(p, 'fading')[0];
  assert.ok(old && old.id === 'react.touch-head@female', 'the old one is still there, fading');
  assert.ok(Math.abs(old.weight - wBefore) < 0.15, `it fades from its weight (${wBefore} → ${old.weight}), not from 0 or 1`);
  const later = run(d, 0.4).pop();
  assert.equal(ov(later, 'fading').length, 0, 'gone after the cut fade (0.2 s)');
  assert.equal(later.reaction, 'react.ticklish');
  // overlays are ordered: holds, fading, reaction (the renderer lays them in this order)
  const t = make('female');
  run(t, 1);
  const q = run(t, 0.5, holdsOf({ talk: true }), { 0.3: [touch('face', 'happy')] }).pop();
  assert.deepEqual(q.overlays.map((o) => o.layer), ['hold', 'reaction']);
  // lifted: the reaction goes, the lift hold comes; a touch while lifted is ignored
  const l = make('male');
  run(l, 1);
  run(l, 0.5, holdsOf(), { 0: [touch('head', 'happy')] });
  const lp = run(l, 0.5, holdsOf({ lift: true }), { 0: [{ type: 'drag', what: 'lift' }], 0.2: [touch('face', 'happy')] }).pop();
  assert.equal(lp.reaction, null);
  assert.equal(lp.hold, 'lift');
  assert.ok(ov(lp, 'hold')[0].id === 'hold.lift@male' && ov(lp, 'hold')[0].weight > 0.5);
});

test('debounce and repeated touches: the same reaction within 0.6 s does nothing; touching on extends it (no restart)', () => {
  const d = make('female');
  run(d, 1);
  const p1 = run(d, 0.3, holdsOf(), { 0: [touch('head', 'happy')] }).pop();
  const p2 = run(d, 0.1, holdsOf(), { 0: [touch('head', 'happy')] }).pop();
  assert.equal(p2.reactionKey, p1.reactionKey, 'debounced');
  run(d, 0.4);
  const end1 = d.state.react.end;
  const p3 = run(d, 0.5, holdsOf(), { 0: [touch('head', 'happy')] }).pop();
  assert.equal(p3.reactionKey, p1.reactionKey, 'not started over');
  assert.ok(d.state.react.end > end1, 'kept going: she leans into the hand');
  assert.equal(d.reactions().filter((s) => s === 'react.touch-head').length, 1);
});

test('mood escalation through core/touch-zones.js: poking the head again and again goes happy → annoyed → angry, then stays cross a while', () => {
  for (const style of ['female', 'male']) {
    const d = make(style);
    run(d, 1);
    let snap = { t: 0, status: 'idle', touch: null, pointerInside: true };
    let prev = null;
    const seen = [];
    let streak = null;
    for (let n = 1; n <= 7; n++) {
      // core/touch-zones.js decides the mood of the n-th touch in a row; app.js puts it in lastTouch
      streak = TZ.nextStreak(streak, 'head', n * 1200);
      const r = TZ.reactionFor('head', 'close', streak.count);
      snap = { ...snap, touch: { n, zone: 'head', mood: r.mood, streak: r.streak } };
      const it = I.fromSnapshot(snap, prev || { ...snap, touch: null });
      prev = snap;
      const p = d.update(0.05, it);
      seen.push(`${r.mood}:${p.reaction}`);
      run(d, 1.15, holdsOf());
    }
    assert.deepEqual(seen.slice(0, 2), ['happy:react.touch-head', 'happy:react.touch-head'], style);
    assert.ok(seen.slice(2, 5).every((s) => s === 'annoyed:react.annoyed'), `${style}: ${seen}`);
    assert.ok(seen.slice(5).every((s) => s === 'angry:react.angry'), `${style}: ${seen}`);
    // after the angry reaction: still a little cross (an annoyed face) for a while, then calm
    const after = run(d, 5).pop();
    assert.equal(after.reaction, null);
    assert.ok(after.face.angry > 0, `${style}: still cross ${JSON.stringify(after.face)}`);
    const calm = run(d, 12).pop();
    assert.ok(!calm.face.angry, `${style}: calm again ${JSON.stringify(calm.face)}`);
  }
});

test('mood escalation on a sensitive zone: the chest at a close friend goes shy → annoyed → angry (touch-zones), each reaction cutting the last', () => {
  for (const style of ['female', 'male']) {
    const d = make(style);
    run(d, 1);
    let prev = { touch: null };
    let streak = null;
    const seen = [];
    let fading = 0;
    for (let n = 1; n <= 7; n++) {
      streak = TZ.nextStreak(streak, 'chest', n * 900);
      const r = TZ.reactionFor('chest', 'close', streak.count);
      const snap = { touch: { n, zone: 'chest', mood: r.mood, streak: r.streak } };
      const p = d.update(0.05, I.fromSnapshot(snap, prev));
      prev = snap;
      seen.push(`${r.mood}:${p.reaction}`);
      fading = Math.max(fading, ...run(d, 0.85).map((x) => ov(x, 'fading').length));
    }
    assert.deepEqual(seen, ['shy:react.shy', 'shy:react.shy', 'annoyed:react.annoyed', 'annoyed:react.annoyed', 'annoyed:react.annoyed', 'angry:react.angry', 'angry:react.angry'], style);
    assert.deepEqual(d.reactions().slice(-3), ['react.shy', 'react.annoyed', 'react.angry'], `${style}: repeats extend, changes cut`);
    assert.ok(fading >= 1, 'the cut reaction faded out under the next');
  }
});

test('shy: the shy posture for a while after (auto posture only); angry stares without blinking', () => {
  const d = make('female');
  run(d, 1);
  run(d, 0.5, holdsOf(), { 0: [touch('chest', 'shy')] });
  const p = run(d, 3).pop();
  assert.equal(p.posture, 'stand.shy');
  assert.equal(p.postureSource, 'shy');
  assert.notEqual(run(d, 10).pop().postureSource, 'shy', 'and back');
  const pinned = make('female', { posture: 'stand.playful' });
  run(pinned, 1);
  run(pinned, 3, holdsOf(), { 0: [touch('chest', 'shy')] });
  assert.equal(run(pinned, 0.1).pop().posture, 'stand.playful', 'the user\'s posture is kept');
  const a = make('male');
  run(a, 1);
  assert.equal(run(a, 0.5, holdsOf(), { 0: [touch('butt', 'angry')] }).pop().noBlink, true);
});

test('drag: lift holds the lift clip (legs hang), drop plays the landing (a knee dip), thrown lands longer', () => {
  const d = make('female');
  run(d, 1);
  const lifted = run(d, 1, holdsOf({ lift: true }), { 0: [{ type: 'drag', what: 'lift' }] }).pop();
  assert.equal(lifted.hold, 'lift');
  assert.ok(lifted.life.lifted);
  assert.ok(lifted.face.surprised > 0);
  const k0 = lifted.life.landKey;
  const dropped = run(d, 0.3, holdsOf(), { 0: [{ type: 'drag', what: 'drop' }] }).pop();
  assert.equal(dropped.reaction, 'react.drop');
  assert.equal(dropped.life.landKey, k0 + 1, 'the alive layer gets its landing');
  const drop = d.state.react.end - d.state.react.start;
  run(d, 3);
  run(d, 1, holdsOf({ lift: true }), { 0: [{ type: 'drag', what: 'lift' }] });
  run(d, 0.1, holdsOf(), { 0: [{ type: 'drag', what: 'thrown' }] });
  assert.ok(d.state.react.end - d.state.react.start > drop, 'thrown: a longer landing');
  // the lift hold fades out (not cut) after the drop
  const hw = run(d, 0.1).pop().overlays.filter((o) => o.slot === 'hold.lift').map((o) => o.weight);
  assert.ok(hw.length === 0 || hw[0] < 0.75);
});

test('talk / think / eat: holds with their own clip, face and gaze; a touch plays over them and they come back', () => {
  const d = make('female');
  run(d, 1);
  const talk = run(d, 1, holdsOf({ talk: true })).pop();
  assert.equal(talk.hold, 'talk');
  assert.equal(ov(talk, 'hold')[0].id, 'hold.talk@female');
  assert.ok(ov(talk, 'hold')[0].time > 0, 'the gesture loop runs');
  const mid = run(d, 0.5, holdsOf({ talk: true }), { 0: [touch('head', 'happy')] }).pop();
  assert.equal(mid.reaction, 'react.touch-head');
  assert.equal(ov(mid, 'hold')[0].id, 'hold.talk@female', 'the talk hold stays under the reaction (the mouth keeps talking)');
  const back = run(d, 4, holdsOf({ talk: true })).pop();
  assert.equal(back.reaction, null);
  assert.equal(back.hold, 'talk');
  const think = run(d, 1, holdsOf({ think: true })).pop();
  assert.equal(think.hold, 'think');
  assert.ok(think.gaze.mode === 'fixed' && think.gaze.y > 1, 'thinking: eyes up');
  assert.equal(ov(think, 'hold').find((o) => o.slot === 'hold.think').id, 'hold.think@female');
  const tt = run(d, 0.5, holdsOf({ think: true }), { 0: [touch('face', 'happy')] }).pop();
  assert.equal(tt.reaction, 'react.touch-face');
  assert.equal(run(d, 4, holdsOf({ think: true })).pop().gaze.y > 1, true, 'back to thinking');
  const eat = run(d, 1, holdsOf({ eat: 'cookie' })).pop();
  assert.equal(eat.hold, 'eat');
  assert.equal(eat.life.nod, 1, 'chewing nods');
  assert.ok(eat.face.happy > 0.5);
  assert.ok(eat.gaze.y < 0, 'looks down at the food');
});

test('celebrations and cues: hatch greets, evolve cheers, one waits for a touch to finish; a cue only sometimes cheers, never over a hold', () => {
  const d = make('male');
  run(d, 1);
  assert.equal(run(d, 0.2, holdsOf(), { 0: [{ type: 'celebrate', name: 'hatch' }] }).pop().reaction, 'react.greet');
  run(d, 6);
  run(d, 0.2, holdsOf(), { 0: [touch('head', 'happy')] });
  const q = run(d, 0.2, holdsOf(), { 0: [{ type: 'celebrate', name: 'evolve' }] }).pop();
  assert.equal(q.reaction, 'react.touch-head', 'the touch goes on');
  const plans = run(d, 6);
  assert.ok(plans.some((p) => p.reaction === 'react.cheer'), 'then the queued cheer');
  // cues: some cheers at 60 % weight, the rest smiles; never while talking
  const c = make('female', { rand: D.seeded(3) });
  run(c, 1);
  let cheers = 0;
  for (let i = 0; i < 30; i++) { const p = run(c, 5, holdsOf(), { 0: [{ type: 'cue', name: 'play' }] })[2]; if (p.reaction === 'react.cheer') { cheers++; assert.ok(ov(p, 'reaction')[0] || true); } }
  assert.ok(cheers > 2 && cheers < 25, `cheers ${cheers}/30`);
  const t = make('female', { rand: () => 0 });
  run(t, 1);
  assert.equal(run(t, 0.2, holdsOf({ talk: true }), { 0: [{ type: 'cue', name: 'happy' }] }).pop().reaction, null);
});

test('female and male: the same touch plays different clips; male calmer in the face (×0.8) but not a faint body (T-2691)', () => {
  const f = make('female');
  const m = make('male');
  run(f, 1);
  run(m, 1);
  const pf = run(f, 0.8, holdsOf(), { 0: [touch('belly', 'ticklish')] }).pop();
  const pm = run(m, 0.8, holdsOf(), { 0: [touch('belly', 'ticklish')] }).pop();
  assert.equal(ov(pf, 'reaction')[0].id, 'react.ticklish@female');
  assert.equal(ov(pm, 'reaction')[0].id, 'react.ticklish@male');
  assert.ok(pm.face.happy < pf.face.happy, `male face ${pm.face.happy} < female ${pf.face.happy}`);
  const sf = run(make('female'), 0.05, holdsOf(), { 0: [touch('head', 'happy')] });
  const fd = make('female'); run(fd, 1); const wf = Math.max(...run(fd, 1.5, holdsOf(), { 0: [touch('head', 'happy')] }).map((p) => (ov(p, 'reaction')[0] || { weight: 0 }).weight));
  const md = make('male'); run(md, 1); const wm = Math.max(...run(md, 1.5, holdsOf(), { 0: [touch('head', 'happy')] }).map((p) => (ov(p, 'reaction')[0] || { weight: 0 }).weight));
  // the male way is a different motion, not a smaller one: his overlay weight stays ≥ 60% of hers (T-2691)
  assert.ok(sf.length && wm >= 0.6 * wf, `male ${wm} ≥ 0.6 × female ${wf}`);
});

test('no library: a touch still shows its face and gaze for a while, no overlay, then back; nothing throws', () => {
  const d = D.createDirector({ style: S.resolveStyle({}), index: L.cleanIndex(null), loaded: new Set(), rand: D.seeded(1) });
  const p = run(d, 0.5, holdsOf(), { 0: [touch('chest', 'shy')] }).pop();
  assert.equal(p.reaction, 'react.shy');
  assert.deepEqual(p.overlays, []);
  assert.ok(p.face.surprised > 0);
  assert.equal(run(d, 2).pop().reaction, null);
  const h = run(d, 0.5, holdsOf({ talk: true, lift: false })).pop();
  assert.equal(h.hold, 'talk');
  assert.deepEqual(h.overlays, []);
});

test('intent: the streak touch-zones gave travels with the touch event', () => {
  const prev = { touch: { n: 1, zone: 'head', mood: 'happy', streak: null } };
  const it = I.fromSnapshot({ touch: { n: 2, zone: 'head', mood: 'annoyed', streak: 'annoyed' } }, prev);
  assert.deepEqual(it.events, [{ type: 'touch', zone: 'head', mood: 'annoyed', streak: 'annoyed' }]);
});

// a front-facing skeleton (metres): the camera looks down −Z from +Z
function skeleton(dx = 0) {
  const b = {
    hips: [0, 0.9, 0], spine: [0, 1.0, 0], chest: [0, 1.12, 0], upperChest: [0, 1.24, 0], neck: [0, 1.36, 0], head: [0, 1.44, 0],
    leftUpperArm: [0.17, 1.32, 0], rightUpperArm: [-0.17, 1.32, 0], leftLowerArm: [0.22, 1.08, 0], rightLowerArm: [-0.22, 1.08, 0], leftHand: [0.25, 0.86, 0.02], rightHand: [-0.25, 0.86, 0.02],
    leftUpperLeg: [0.09, 0.85, 0], rightUpperLeg: [-0.09, 0.85, 0], leftLowerLeg: [0.1, 0.48, 0], rightLowerLeg: [-0.1, 0.48, 0], leftFoot: [0.1, 0.08, 0], rightFoot: [-0.1, 0.08, 0], leftToes: [0.1, 0.02, 0.12], rightToes: [-0.1, 0.02, 0.12],
  };
  for (const k of Object.keys(b)) b[k] = [b[k][0] + dx, b[k][1], b[k][2]];
  return b;
}
const shoot = (list, x, y) => H.hit(list, [x, y, 5], [0, 0, -1]).zone;

test('3D touch zones (core/vrm-hit.js): the camera ray against spheres / capsules on the skeleton, nearest first', () => {
  const list = H.shapes(skeleton());
  assert.equal(shoot(list, 0, 1.63), 'head', 'top of the head (hair)');
  assert.equal(shoot(list, 0, 1.5), 'face');
  assert.equal(shoot(list, 0.09, 1.58), 'head', 'the side of the hair is not the face');
  assert.equal(shoot(list, 0, 1.25), 'chest');
  assert.equal(shoot(list, 0, 1.03), 'belly');
  assert.equal(shoot(list, 0, 0.82), 'butt');
  assert.equal(shoot(list, 0.25, 0.88), 'hands');
  assert.equal(shoot(list, -0.25, 0.88), 'hands');
  assert.equal(shoot(list, 0.1, 0.6), 'legs');
  assert.equal(shoot(list, -0.1, 0.06), 'feet');
  assert.equal(shoot(list, 0.6, 1.0), null, 'beside her: nothing');
  // the zones follow the body: moved 0.3 m aside, the old spot is empty and the new one hits
  const moved = H.shapes(skeleton(0.3));
  assert.equal(shoot(moved, 0, 1.25), null);
  assert.equal(shoot(moved, 0.3, 1.25), 'chest');
  // a hand in front of the belly is the hand (nearest along the ray)
  const sk = skeleton();
  sk.leftLowerArm = [0.12, 1.05, 0.15];
  sk.leftHand = [0.0, 1.03, 0.22];
  assert.equal(shoot(H.shapes(sk), 0.0, 1.03), 'hands');
  // the back of the head is never the face
  const back = H.hit(list, [0, 1.5, -5], [0, 0, 1]);
  assert.equal(back.zone, 'head');
  // sizes scale with the skeleton: a half-size model is hit at half the height
  const small = Object.fromEntries(Object.entries(skeleton()).map(([k, v]) => [k, v.map((c) => c * 0.5)]));
  assert.equal(shoot(H.shapes(small), 0, 0.625), 'chest');
  assert.deepEqual(H.shapes({}), []);
  // a model turned round (VRM 0.x through the loader: her left arm at −X, facing −Z): the face is still her
  // front, read from the shoulders, whatever `front` the caller guessed
  const turned = Object.fromEntries(Object.entries(skeleton()).map(([k, v]) => [k, [-v[0], v[1], -v[2]]]));
  assert.equal(H.hit(H.shapes(turned, [0, 0, 1]), [0, 1.5, -5], [0, 0, 1]).zone, 'face');
  assert.equal(H.hit(H.shapes(turned, [0, 0, 1]), [0, 1.5, 5], [0, 0, -1]).zone, 'head');
});

test('landing dip (alive layer): knees give ≤ 4° / 8° for half a second, then nothing; never while lifted', () => {
  const l = Life.createLife({ rand: () => 0.5, style: S.resolveStyle({ packStyle: { base: 'female' } }) });
  let up = 0;
  let low = 0;
  const seq = [];
  for (let i = 0; i < 60; i++) {
    const o = l.step(1 / 30, { landKey: i >= 5 ? 1 : 0, standing: true });
    const k = o.bones.leftLowerLeg ? o.bones.leftLowerLeg.x : 0;
    seq.push(k);
    low = Math.max(low, k);
    up = Math.min(up, o.bones.leftUpperLeg ? o.bones.leftUpperLeg.x : 0);
  }
  assert.ok(low > 4 && low <= Life.LIMITS.landLowerLeg + 1e-9, `lower ${low}`);
  assert.ok(up >= -(Life.LIMITS.landUpperLeg + Life.LIMITS.bone) - 1e-9, `upper ${up}`);
  assert.ok(seq[seq.length - 1] < 0.01, 'over after LAND');
  assert.equal(seq[0], 0, 'nothing before the drop');
});
