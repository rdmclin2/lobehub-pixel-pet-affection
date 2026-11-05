'use strict';
// T-5098: the touch zones sized from each part's own mesh box (core/vrm-hit.js opts.parts) — a chibi's belly is not
// her butt from the front, a hand beside her thigh is the hand —; the cue's small cheer at full weight (no half-way
// level arms); a full-body hold fades in over ≥ 0.4 s; the jerk limit for one-shot clips (core/vrm-bone-map.js
// limitAccel jMax) and, with the baked library on this machine, the T-5097 moments replayed offline before the
// output limiter (raw spike ≤ 10°/frame@30 at 30 fps and at 9–15 fps).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Hit = require('../src/core/vrm-hit');
const BM = require('../src/core/vrm-bone-map');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
const Sm = require('../src/core/vrm-smooth');
const W = require('../src/core/vrma-write');
const { runtimeMeta } = require('../scripts/vrm-bake');

// paimon-like (0.53 m, store model vrm-paimon): a big head, a short round trunk, short legs; the camera at +Z
const PAIMON = {
  hips: [0, 0.2, 0], spine: [0, 0.235, 0], chest: [0, 0.27, 0], upperChest: [0, 0.295, 0], neck: [0, 0.315, 0], head: [0, 0.33, 0],
  leftUpperArm: [0.045, 0.3, 0], rightUpperArm: [-0.045, 0.3, 0], leftLowerArm: [0.06, 0.25, 0], rightLowerArm: [-0.06, 0.25, 0], leftHand: [0.068, 0.2, 0.01], rightHand: [-0.068, 0.2, 0.01],
  leftMiddleProximal: [0.07, 0.18, 0.012], rightMiddleProximal: [-0.07, 0.18, 0.012],
  leftUpperLeg: [0.025, 0.19, 0], rightUpperLeg: [-0.025, 0.19, 0], leftLowerLeg: [0.027, 0.1, 0], rightLowerLeg: [-0.027, 0.1, 0], leftFoot: [0.028, 0.02, 0], rightFoot: [-0.028, 0.02, 0],
};
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const box = (c, r) => ({ c, axes: I3, r });
// her parts as the renderer measures them (measurePartBoxes): world ellipsoids
const PARTS = {
  hips: box([0, 0.2, 0], [0.05, 0.035, 0.045]), spine: box([0, 0.24, 0.005], [0.048, 0.03, 0.045]), chest: box([0, 0.28, 0], [0.05, 0.03, 0.04]),
  leftHand: box([0.068, 0.192, 0.012], [0.012, 0.018, 0.012]), rightHand: box([-0.068, 0.192, 0.012], [0.012, 0.018, 0.012]),
  leftUpperLeg: box([0.026, 0.145, 0], [0.024, 0.05, 0.024]), rightUpperLeg: box([-0.026, 0.145, 0], [0.024, 0.05, 0.024]),
  leftLowerLeg: box([0.027, 0.06, 0], [0.018, 0.045, 0.018]), rightLowerLeg: box([-0.027, 0.06, 0], [0.018, 0.045, 0.018]),
};
const fromFront = (list, x, y) => Hit.hit(list, [x, y, 3], [0, 0, -1]).zone;
const fromBack = (list, x, y) => Hit.hit(list, [x, y, -3], [0, 0, 1]).zone;

test('T-5098 touch zones from the mesh boxes: a 0.53 m chibi — the belly from the front, the butt from behind, a hand by the thigh', () => {
  const list = Hit.shapes(PAIMON, [0, 0, 1], { parts: PARTS });
  assert.ok(list.some((s) => s.source === 'mesh' && s.zone === 'pelvis'));
  // T-5097: the centre of her belly was the butt (the butt capsule, 0.19 × hips→head, stood in front of it)
  assert.equal(fromFront(list, 0, 0.235), 'belly', 'belly centre');
  assert.equal(fromFront(list, 0, 0.205), 'belly', 'the front of the pelvis is her belly, never the butt');
  assert.equal(fromBack(list, 0, 0.2), 'butt', 'from behind');
  assert.equal(fromBack(list, 0.02, 0.18), 'butt', 'the top of the thigh from behind (buttocks skinned to the upper legs)');
  assert.equal(fromFront(list, 0.026, 0.14), 'legs', 'the thigh from the front');
  // T-5097: a click on her hand was her legs
  assert.equal(fromFront(list, 0.068, 0.192), 'hands');
  assert.equal(fromFront(list, -0.068, 0.19), 'hands');
  assert.equal(fromFront(list, 0.027, 0.08), 'legs');
  // the hand follows the hand bone: moved in front of her belly it is the hand there
  const moved = { ...PARTS, leftHand: box([0.01, 0.235, 0.06], [0.012, 0.018, 0.012]) };
  assert.equal(fromFront(Hit.shapes({ ...PAIMON, leftHand: [0.01, 0.24, 0.06] }, [0, 0, 1], { parts: moved }), 0.01, 0.235), 'hands');
  // a hanging forearm's sleeve box grazing her butt from behind does not turn the butt into her hand (T-5098 run 4)
  const sleeve = { ...PARTS, leftLowerArm: box([0.03, 0.2, -0.03], [0.02, 0.04, 0.02]), leftHand: box([0.068, 0.17, -0.02], [0.012, 0.018, 0.012]) };
  assert.equal(fromBack(Hit.shapes(PAIMON, [0, 0, 1], { parts: sleeve }), 0.03, 0.2), 'butt', 'sleeve over the butt');
  // but where the hand comes out of the sleeve it is the hand
  assert.equal(fromFront(Hit.shapes(PAIMON, [0, 0, 1], { parts: { ...PARTS, leftLowerArm: box([0.068, 0.215, 0.012], [0.02, 0.03, 0.02]) } }), 0.068, 0.2), 'hands', 'hand out of the sleeve');
  // without the boxes (a model with no skinned vertices there) the bone capsules are still there
  assert.equal(fromFront(Hit.shapes(PAIMON, [0, 0, 1]), 0, 0.235), 'belly');
});

const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'vrm-motion-index.json'), 'utf8'));
function make(style) {
  const clips = {};
  for (const [id, e] of Object.entries(v2.clips)) { const { slot, style: st } = L.parseId(id); clips[id] = e.cycle ? { kind: e.kind, style: st, cycle: e.cycle, every: e.every, group: e.group, category: e.category } : { ...e, ...runtimeMeta(e), file: `${st}/${slot}.vrma`, duration: e.duration }; }
  const index = L.cleanIndex({ clips });
  return D.createDirector({ style: S.resolveStyle({ packStyle: { base: style } }), index, loaded: new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id)), rand: D.seeded(3) });
}
const holds = (o = {}) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: true, facing: 'right', ...o });

test('T-5098 the cue cheer plays at full weight (T-5097: 0.58 → fists overhead over hanging arms came out level); the face is the small part', () => {
  for (const style of ['male', 'female']) {
    const d = make(style);
    for (let i = 0; i < 40; i++) d.update(0.05, { holds: holds(), events: [] });
    let w = 0; let seen = false;
    for (let k = 0; k < 40 && !seen; k++) {
      const p = d.update(0.05, { holds: holds(), events: [{ type: 'cue', name: 'play' }] });
      if (p.reaction === 'react.cheer') seen = true;
      for (let i = 0; i < 30; i++) { const q = d.update(0.05, { holds: holds(), events: [] }); const o = (q.overlays || []).find((x) => x.layer === 'reaction'); if (o && q.reaction === 'react.cheer') w = Math.max(w, o.weight); }
    }
    assert.ok(seen, `${style}: a cue cheer`);
    assert.ok(w > 0.9, `${style}: cue cheer weight ${w}`);
  }
});

test('T-5098 a full-body hold (the lift) fades in over ≥ 0.4 s (hold.lift: 0.2 s was two frames at 9 fps)', () => {
  const d = make('female');
  for (let i = 0; i < 20; i++) d.update(0.05, { holds: holds(), events: [] });
  const ws = [];
  for (let i = 0; i < 14; i++) { const p = d.update(0.05, { holds: holds({ lift: true }), events: i === 0 ? [{ type: 'drag', what: 'lift' }] : [] }); const o = (p.overlays || []).find((x) => /hold\.lift/.test(x.id)); ws.push(o ? o.weight : 0); }
  const full = ws.findIndex((x) => x >= 0.999);
  assert.ok(full < 0 || full * 0.05 >= 0.35, `full weight after ${full * 0.05} s: ${ws.map((x) => x.toFixed(2)).join(' ')}`);
});

test('T-5098 jerk limit (limitAccel jMax): a 4 Hz hand flick sampled at 9–15 fps spikes ≤ 10°/frame@30 after it, a slow sway is untouched', () => {
  const track = (hz, amp, dur = 3) => { const times = []; const vals = []; for (let t = 0; t <= dur + 1e-9; t += 1 / 30) { times.push(t); vals.push(...W.qaxis([0, 0, 1], (amp * Math.PI / 180) * Math.sin(2 * Math.PI * hz * t))); } return { times: Float32Array.from(times), values: Float32Array.from(vals) }; };
  // the frames of a machine without a GPU: 9–15 fps, jittered (scripts/lib/vrm-replay.js 'xvfb')
  const spikeAt = (tr) => { const rand = D.seeded(5); const seq = []; let t = 0; while (t < 3) { const dt = 1 / (9 + rand() * 6); t += dt; seq.push({ q: BM._sampleQ(tr.times, tr.values, t, [0, 0, 0, 0]).slice(), dt }); } return Sm.spikes(seq).maxSpike; };
  const fast = track(4, 40);
  const before = spikeAt(fast);
  const r = BM.limitAccel(fast.times, fast.values, { jMax: 90000 });
  assert.ok(r && r.fixed > 0, 'changed');
  const after = spikeAt({ times: r.times, values: r.values });
  assert.ok(before > 10 && after <= 10, `spike at 9–15 fps ${before.toFixed(1)} → ${after.toFixed(1)}`);
  const slow = track(0.3, 10);
  assert.equal(BM.limitAccel(slow.times, slow.values, { jMax: 90000 }), null, 'a slow sway is not touched');
});

const LIB = path.join(os.homedir(), 'vrm-assets', 'baked-v2');
test('T-5098 offline replay of the T-5097 moments (touches, shy / angry, celebrate, cues, lift → drop, play, talk) before the limiter: raw spike ≤ 10°/frame@30 at 30 fps and at 9–15 fps (skipped without ~/vrm-assets/baked-v2)', { skip: !fs.existsSync(path.join(LIB, 'library.json')) }, () => {
  const R = require('../scripts/lib/vrm-replay');
  const EV = { 8: [{ type: 'touch', zone: 'head', mood: 'happy' }], 18: [{ type: 'touch', zone: 'hands', mood: 'happy' }], 28: [{ type: 'touch', zone: 'belly', mood: 'happy' }], 38: [{ type: 'touch', zone: 'chest', mood: 'shy' }], 46: [{ type: 'touch', zone: 'butt', mood: 'angry' }], 54: [{ type: 'celebrate', name: 'evolve' }], 62: [{ type: 'cue', name: 'play' }], 64: [{ type: 'cue', name: 'happy' }], 70: [{ type: 'drag', what: 'lift' }], 74: [{ type: 'drag', what: 'drop' }], 84: [{ type: 'play' }], 100: [{ type: 'touch', zone: 'hands', mood: 'happy' }] };
  const hl = (t) => ({ attention: true, lift: t >= 70 && t < 74, talk: t >= 100 && t < 104 });
  let worst = { spike: 0 };
  for (const style of ['female', 'male', 'neutral']) for (const frames of ['steady30', 'xvfb']) for (let seed = 1; seed <= 3; seed++) {
    const r = R.replay({ dir: LIB, style, seconds: 108, frames, seed, limiter: false, events: EV, holds: hl });
    for (const w of r.windows) if (w.spike > worst.spike) worst = { ...w, style, frames, seed };
  }
  assert.ok(worst.spike <= 10, `raw spike ${worst.spike} on ${worst.bone} (${worst.style}/${worst.frames}/seed ${worst.seed} @ ${worst.at}: ${worst.what})`);
});
