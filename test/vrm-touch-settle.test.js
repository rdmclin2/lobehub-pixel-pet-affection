'use strict';
// T-5092: a touch without a snap — the director keeps the base still while the touch reaction plays, queues a talk
// gesture behind it and fades the reaction's limbs in slower (core/vrm-director.js TOUCH_SETTLE); the renderer's last
// stage limits every bone's angular acceleration (core/vrm-smooth.js), which bounds the jump meter's spike; the
// combination idle switch + reaction + talk on one frame replayed offline through the real director and clips
// (scripts/lib/vrm-replay.js, with the baked library on this machine); and the head zone of a model whose hips bone
// sits on the floor (core/vrm-hit.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
const Sm = require('../src/core/vrm-smooth');
const Hit = require('../src/core/vrm-hit');
const W = require('../src/core/vrma-write');
const { runtimeMeta } = require('../scripts/vrm-bake');

const ROOT = path.join(__dirname, '..');
const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-motion-index.json'), 'utf8'));
function v2Index() {
  const clips = {};
  for (const [id, e] of Object.entries(v2.clips)) {
    const { slot, style } = L.parseId(id);
    clips[id] = e.cycle ? { kind: e.kind, style, cycle: e.cycle, every: e.every, group: e.group, category: e.category } : { ...e, ...runtimeMeta(e), file: `${style}/${slot}.vrma`, duration: e.duration };
  }
  return L.cleanIndex({ clips });
}
const holdsOf = (o = {}) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: true, facing: 'right', ...o });
function make(style, opts = {}) {
  const index = v2Index();
  return D.createDirector({ style: S.resolveStyle({ packStyle: { base: style } }), index, loaded: new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id)), rand: D.seeded(opts.seed || 7), settle: opts.settle, boredAfter: opts.boredAfter });
}
// the frame an idle switch happens on (after `after` s), found on a twin director with the same seed
function idleSwitchAt(style, after = 12, opts = {}) {
  const d = make(style, opts);
  let prev = null;
  for (let t = 0.05; t < 60; t += 0.05) {
    const p = d.update(0.05, { holds: holdsOf(), events: [] });
    if (t > after && prev !== null && p.base.key !== prev) return t;
    prev = p.base.key;
  }
  return null;
}

test('a touch with a talk gesture on the frame her idle would switch: the base waits, the talk queues, the limbs come in slower', () => {
  for (const style of ['female', 'male', 'neutral']) {
    const T = idleSwitchAt(style);
    assert.ok(T, `${style}: an idle switch`);
    for (const settle of [false, true]) {
      const d = make(style, { settle });
      const plans = [];
      let t = 0;
      while (t < T + 6) {
        t += 0.05;
        const on = t >= T - 1e-9;
        plans.push({ t, ...d.update(0.05, { holds: holdsOf({ talk: on }), events: on && !plans.some((p) => p.t >= T - 1e-9) ? [{ type: 'touch', zone: 'hands', mood: 'happy' }] : [] }) });
      }
      const i0 = plans.findIndex((p) => p.t >= T - 1e-9);
      const at = plans[i0];
      const before = plans[i0 - 1];
      const talkW = (p) => (p.overlays || []).filter((o) => o.slot && /^hold\.talk/.test(o.slot)).reduce((s, o) => s + o.weight, 0);
      const react = (p) => (p.overlays || []).find((o) => o.layer === 'reaction');
      assert.ok(at.reaction, `${style}: the touch starts a reaction`);
      if (!settle) {
        // the T-5089 combination: the base switches on the touch's frame, the talk gesture comes in with the reaction
        assert.notEqual(at.base.key, before.base.key, `${style}: (before) the idle switched with the touch`);
        assert.ok(talkW(plans[i0 + 4]) > 0, `${style}: (before) the talk gesture came in at once`);
        assert.equal(react(plans[i0 + 2]).limb, undefined);
        continue;
      }
      // the base she was in stays for the whole settle; afterwards it changes again (cross-faded)
      const settleEnd = plans.findIndex((p, i) => i >= i0 && !p.settling);
      assert.ok(at.settling && settleEnd > i0, `${style}: settling from the touch`);
      for (let i = i0; i < settleEnd; i++) assert.equal(plans[i].base.key, before.base.key, `${style}: the base held at ${plans[i].t.toFixed(2)} s`);
      assert.ok(plans[settleEnd].t - T <= D.TOUCH_SETTLE.base + 0.06, `${style}: settled after ${(plans[settleEnd].t - T).toFixed(2)} s`);
      // the talk gesture waits for the reaction (≤ TOUCH_SETTLE.talk s), then fades in; the mouth is the app's (not here)
      const firstTalk = plans.findIndex((p, i) => i >= i0 && talkW(p) > 0);
      assert.ok(firstTalk > i0, `${style}: a talk gesture comes in`);
      const wait = plans[firstTalk].t - T;
      assert.ok(wait >= Math.min(D.TOUCH_SETTLE.talk, 0.4) - 0.06 && wait <= D.TOUCH_SETTLE.talk + 0.11, `${style}: the talk gesture waited ${wait.toFixed(2)} s`);
      for (let i = i0; i < firstTalk; i++) assert.ok(plans[i].talkQueued || talkW(plans[i]) === 0, `${style}: queued at ${plans[i].t.toFixed(2)}`);
      // the reaction's limbs fade in slower than the rest of her body (and catch up)
      const early = react(plans[i0 + 3]);
      assert.ok(early.limb < early.weight, `${style}: limbs ${early.limb} < body ${early.weight} while it comes in`);
      const later = react(plans[i0 + Math.ceil((D.TOUCH_SETTLE.limbFade * 0.5) / 0.05) + 4]);
      assert.ok(Math.abs(later.limb - later.weight) < 1e-3, `${style}: limbs caught up (${later.limb} / ${later.weight})`);
    }
  }
});

test('touched while resting in a posture (bored / a rest break): she stays in it until the reaction settles, then stands up with the long fade', () => {
  const d = make('female', { boredAfter: 8 });
  const holds = (o) => holdsOf({ attention: false, ...o });
  let p = null;
  for (let t = 0; t < 12; t += 0.05) p = d.update(0.05, { holds: holds(), events: [] });
  assert.equal(p.pose, 'sit', `bored she sits (${p.base.id})`);
  const sitKey = p.base.key;
  const plans = [];
  for (let i = 0; i < 120; i++) plans.push(d.update(0.05, { holds: holds({ talk: true }), events: i === 0 ? [{ type: 'touch', zone: 'head', mood: 'happy' }] : [] }));
  const settled = plans.findIndex((x) => !x.settling);
  assert.ok(settled > 0);
  for (let i = 0; i < settled; i++) assert.equal(plans[i].base.key, sitKey, `still seated at frame ${i}`);
  const up = plans.findIndex((x) => x.base.key !== sitKey);
  assert.ok(up >= settled, `stands up after the settle (${up} ≥ ${settled})`);
  assert.equal(plans[up].base.fade, D.FADE.sit, 'with the sit → stand fade');
});

// ---------- the limiter ----------
const rnd = D.seeded(99);
const qrand = (deg) => { const ax = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]; const n = Math.hypot(...ax) || 1; return W.qaxis(ax.map((x) => x / n), (deg * Math.PI) / 180); };

test('limiter: whatever the input (steps, jitter, 9–15 fps), the jump meter\'s spike stays ≤ ACCEL; stops are not delayed', () => {
  const lim = Sm.createLimiter();
  const raw = [];
  const out = [];
  let q = [0, 0, 0, 1];
  for (let i = 0; i < 600; i++) {
    const dt = 1 / (9 + rnd() * 6);
    // a slow drift with snaps of up to 70° every so often
    q = W.qnorm(W.qmul(q, qrand(i % 37 === 0 ? 70 : i % 11 === 0 ? 25 : 2)));
    raw.push({ q, dt });
    out.push({ q: lim.step('b', q, dt), dt });
  }
  const a = Sm.spikes(raw);
  const b = Sm.spikes(out);
  assert.ok(a.maxSpike > 30, `the input snaps (${a.maxSpike.toFixed(1)}°)`);
  assert.ok(b.maxSpike <= Sm.ACCEL + 1e-6, `limited: ${b.maxSpike.toFixed(3)}° ≤ ${Sm.ACCEL}`);
  // it catches up: 1 s after the last snap the output is back on the input
  const lim2 = Sm.createLimiter();
  let o = null;
  for (let i = 0; i < 40; i++) o = lim2.step('b', i < 10 ? [0, 0, 0, 1] : W.qaxis([0, 0, 1], 1.2), 1 / 30);
  assert.ok(Sm.angle(o, W.qaxis([0, 0, 1], 1.2)) < 1e-6, 'caught up');
  // a stop: no lag (speed may drop at once)
  const lim3 = Sm.createLimiter();
  let last = null;
  for (let i = 0; i < 30; i++) last = lim3.step('b', W.qaxis([0, 0, 1], Math.min(i, 20) * 0.05), 1 / 30);
  assert.ok(Sm.angle(last, W.qaxis([0, 0, 1], 1.0)) < 1e-6, 'stopped where the input stopped');
});

test('limiter: a smooth clip motion passes (a 30°/frame talk gesture, eased) — nothing held back', () => {
  const lim = Sm.createLimiter();
  let cut = 0;
  for (let i = 0; i < 300; i++) {
    const t = i / 30;
    const q = W.qaxis([0, 0, 1], 1.2 * Math.sin(t * 2.6)); // peak ≈ 3.1 rad/s ≈ 6°/frame… × 5 gives 30°/frame
    const q5 = W.qaxis([0, 0, 1], 6 * Math.sin(t * 0.87) * Math.sin(t * 2.6) * 0.2);
    const o = lim.step('b', W.qmul(q, q5), 1 / 30);
    cut = Math.max(cut, Sm.angle(o, W.qmul(q, q5)));
  }
  assert.ok(cut < 0.5, `held back at most ${cut.toFixed(3)}°`);
  assert.ok(lim.stats().frames > 0);
});

// ---------- the offline replay over the baked library ----------
const LIB = path.join(os.homedir(), 'vrm-assets', 'baked-v2');
test('offline replay (real director + baked clips + renderer mixing + limiter): idle + reaction + talk on one frame, 30 fps and 9–15 fps — spike ≤ 10°/frame@30 (skipped without ~/vrm-assets/baked-v2)', { skip: !fs.existsSync(path.join(LIB, 'library.json')) }, () => {
  const R = require('../scripts/lib/vrm-replay');
  for (const style of ['female', 'male', 'neutral']) {
    const probe = R.replay({ dir: LIB, style, seconds: 40, keepPlans: true, limiter: false, holds: () => ({ attention: true }) });
    let T = null;
    for (let i = 1; i < probe.plans.length; i++) if (probe.plans[i].t > 12 && probe.plans[i].base !== probe.plans[i - 1].base) { T = probe.plans[i].t - 0.001; break; }
    assert.ok(T, `${style}: an idle switch to touch on`);
    for (const frames of ['steady30', 'xvfb']) {
      for (const zone of ['head', 'hands', 'belly']) {
        const before = R.replay({ dir: LIB, style, seconds: T + 6, frames, settle: false, limiter: false, holds: (t) => ({ attention: true, talk: t >= T }), events: { [T]: [{ type: 'touch', zone, mood: 'happy' }] } });
        const combo = before.windows.find((w) => w.at >= T - 0.05 && /base→/.test(w.what) && /reaction→/.test(w.what) && /hold\.talk/.test(w.what));
        assert.ok(combo, `${style}/${zone}: (before) base + reaction + talk changed on one frame`);
        const r = R.replay({ dir: LIB, style, seconds: T + 6, frames, holds: (t) => ({ attention: true, talk: t >= T }), events: { [T]: [{ type: 'touch', zone, mood: 'happy' }] } });
        const win = r.windows.filter((w) => w.at >= T - 0.05);
        assert.ok(win.length >= 2, `${style}/${zone}: transitions after the touch`);
        assert.ok(!win.some((w) => /base→/.test(w.what) && /reaction→/.test(w.what)), `${style}/${zone}: the base never switches with the reaction`);
        assert.ok(r.spikeMax <= 10, `${style}/${zone}/${frames}: spike ${r.spikeMax}° on ${r.spikeBone} at ${r.spikeAt}`);
      }
    }
  }
});

// ---------- the head zone ----------
// Wanderer's skeleton (store model vrm-wanderer, VRM 0.x): the humanoid hips bone on the floor
const WANDERER = { hips: [0, 0, 0], spine: [0, 0.971, -0.048], chest: [0, 1.12, -0.049], neck: [0, 1.306, -0.029], head: [0, 1.392, -0.046], leftUpperArm: [0.128, 1.259, -0.017], rightUpperArm: [-0.128, 1.259, -0.017], leftLowerArm: [0.37, 1.25, -0.02], rightLowerArm: [-0.37, 1.25, -0.02], leftHand: [0.6, 1.24, -0.02], rightHand: [-0.6, 1.24, -0.02], leftUpperLeg: [0.066, 0.886, -0.031], rightUpperLeg: [-0.066, 0.886, -0.031], leftLowerLeg: [0.051, 0.47, -0.032], rightLowerLeg: [-0.051, 0.47, -0.032], leftFoot: [0.038, 0.092, -0.004], rightFoot: [-0.038, 0.092, -0.004] };

test('head zone: a model whose hips bone is on the floor is sized from her hip joints; a click on her head (or hat) is the head, not the chest', () => {
  const list = Hit.shapes(WANDERER, [0, 0, 1]);
  const chest = list.find((s) => s.zone === 'chest');
  assert.ok(chest.r < 0.12, `chest capsule radius ${chest.r.toFixed(3)} m (was ${(1.392 * 0.17).toFixed(3)} with the hips on the floor)`);
  const cam = [0, 1.2, 3];
  const at = (y) => Hit.hit(list, cam, [0 - cam[0], y - cam[1], -0.05 - cam[2]]).zone;
  // the upper head (~1.56 m) is the head, the front below it the face, the chest below the neck
  assert.equal(at(1.56), 'head');
  assert.equal(at(1.45), 'face');
  assert.equal(at(1.2), 'chest');
  // the point the e2e clicks for "head" (renderer zoneCenters: centre + 0.8 r up) is on her head now: 1.57 m — with
  // the hips bone as the hips it was 1.88 m, half a head above her hat, and the sphere's front (all "face") below
  const hd = list.find((s) => s.zone === 'head');
  const top = hd.c[1] + hd.r * 0.8;
  assert.ok(top > 1.5 && top < 1.62, `head point ${top.toFixed(3)} m`);
  // the drawn head (opts.head: the box of the head vertices, e.g. a tall hat up to 1.75 m) — its top is the head too
  const head = { c: [0, 1.53, -0.03], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], r: [0.16, 0.22, 0.17] };
  const list2 = Hit.shapes(WANDERER, [0, 0, 1], { head });
  const hz = list2.find((s) => s.zone === 'head');
  assert.equal(hz.kind, 'ellipsoid');
  assert.equal(hz.source, 'mesh');
  assert.equal(Hit.hit(list2, cam, [0, 1.72 - cam[1], -0.03 - cam[2]]).zone, 'head', 'the hat top');
  assert.equal(Hit.hit(list2, cam, [0, 1.42 - cam[1], -0.03 - cam[2]]).zone, 'face', 'the face');
  assert.equal(Hit.hit(list2, cam, [0, 1.85 - cam[1], -0.03 - cam[2]]).zone, null, 'above the hat: nothing');
  // a normal model (hips bone at the pelvis) is unchanged by the hip-joint rule
  const normal = { ...WANDERER, hips: [0, 0.93, -0.03] };
  const a = Hit.shapes(normal, [0, 0, 1]).find((s) => s.zone === 'chest').r;
  assert.ok(Math.abs(a - Math.hypot(0, 1.392 - 0.93, -0.046 + 0.03) * 0.17) < 1e-9);
});

test('ray × ellipsoid: hits a sphere-shaped ellipsoid where raySphere does; misses beside it', () => {
  const o = [0, 0, 5];
  const d = [0, 0, -1];
  const t1 = Hit.rayEllipsoid(o, d, [0, 0, 0], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0.5, 0.5, 0.5]);
  const t2 = Hit.raySphere(o, d, [0, 0, 0], 0.5);
  assert.ok(Math.abs(t1 - t2) < 1e-9);
  assert.ok(Math.abs(Hit.rayEllipsoid(o, d, [0, 0, 0], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0.5, 0.5, 2]) - 3) < 1e-9);
  assert.equal(Hit.rayEllipsoid([0.6, 0, 5], d, [0, 0, 0], [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0.5, 0.5, 0.5]), null);
});

test('a touch right after the idle was cleared (posture setting changed, a clip played by hand) never leaves her without an idle', () => {
  const d = make('female');
  for (let i = 0; i < 100; i++) d.update(0.05, { holds: holdsOf(), events: [] });
  d.update(0.05, { holds: holdsOf(), events: [{ type: 'touch', zone: 'head', mood: 'happy' }] });
  d.setPosture('auto'); // clears the idle while the touch settles
  for (let i = 0; i < 40; i++) {
    const p = d.update(0.05, { holds: holdsOf({ talk: true }), events: [] });
    assert.ok(p.idle, `an idle at frame ${i}`);
  }
});
