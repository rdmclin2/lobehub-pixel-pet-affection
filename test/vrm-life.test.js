'use strict';
// The alive layer (src/core/vrm-life.js, docs/vrm-motion-system.md §3.2 L4): capped small motion only.
const test = require('node:test');
const assert = require('node:assert/strict');
const Life = require('../src/core/vrm-life');
const S = require('../src/core/vrm-style');
const D = require('../src/core/vrm-director');

function runLife(ctx, seconds = 120, dt = 1 / 30, style = S.PROFILES.female, seed = 1) {
  const l = Life.createLife({ rand: D.seeded(seed), style });
  const frames = [];
  for (let t = 0; t < seconds; t += dt) frames.push(l.step(dt, { style, standing: true, idle: true, ...ctx }));
  return { frames, l };
}
const maxAbs = (frames, pick) => Math.max(...frames.map(pick).map(Math.abs));

test('caps: every bone ≤ 4° (stance aside), lifted legs ≤ 8° / 12°, whatever the style or the window does', () => {
  for (const style of Object.values(S.PROFILES)) {
    const { frames } = runLife({ fingers: false, sad: 1 }, 60, 1 / 30, { ...style, stanceWidth: 0 });
    for (const f of frames) for (const [b, r] of Object.entries(f.bones)) for (const v of [r.x, r.y, r.z]) assert.ok(Math.abs(v) <= Life.LIMITS.bone + 1e-9, `${b} ${v}`);
    const lift = runLife({ lifted: true, velX: 4000 }, 20, 1 / 30, style).frames.concat(runLife({ lifted: true, velX: -4000 }, 20, 1 / 30, style).frames);
    assert.ok(maxAbs(lift, (f) => f.bones.leftUpperLeg.x) <= Life.LIMITS.liftUpperLeg + 1e-9);
    assert.ok(maxAbs(lift, (f) => f.bones.leftLowerLeg.x) <= Life.LIMITS.liftLowerLeg + 1e-9);
    assert.ok(lift.slice(-10).every((f) => f.bones.leftLowerLeg.x > 3), 'the knees bend under gravity');
  }
  // the male stance opens the legs (a fixed offset), not motion
  const m = runLife({}, 5, 1 / 30, S.PROFILES.male).frames.pop();
  const f = runLife({}, 5, 1 / 30, { ...S.PROFILES.female }).frames.pop();
  assert.ok(m.bones.leftUpperLeg.z - f.bones.leftUpperLeg.z > 1, 'male stands wider');
});

test('lifted: a damped swing, not a shake — the legs follow the window and settle', () => {
  const l = Life.createLife({ rand: D.seeded(2), style: S.PROFILES.female });
  const xs = [];
  for (let i = 0; i < 300; i++) xs.push(l.step(1 / 60, { standing: true, lifted: true, velX: i < 60 ? 1200 : 0 }).bones.leftUpperLeg.x);
  let flips = 0;
  for (let i = 2; i < xs.length; i++) if (Math.sign(xs[i] - xs[i - 1]) !== Math.sign(xs[i - 1] - xs[i - 2]) && Math.abs(xs[i] - xs[i - 1]) > 1e-4) flips++;
  assert.ok(flips < 12, `direction changes in 5 s: ${flips} (the old dangle flailed at 11 Hz)`);
  assert.ok(Math.abs(xs[xs.length - 1] - xs[xs.length - 2]) < 0.05, 'settled');
});

test('breathing: 14–18 per minute awake, 10 asleep and deeper; female chest, male belly', () => {
  const count = (frames) => { let n = 0; for (let i = 1; i < frames.length; i++) if (frames[i - 1].breath < 0 && frames[i].breath >= 0) n++; return n; };
  const awake = runLife({}, 60).frames;
  const asleep = runLife({ sleep: true }, 60).frames;
  assert.ok(count(awake) >= 13 && count(awake) <= 19, `awake ${count(awake)}/min`);
  assert.ok(count(asleep) >= 9 && count(asleep) <= 11, `asleep ${count(asleep)}/min`);
  assert.ok(maxAbs(asleep, (f) => f.bones.chest.x) > maxAbs(awake, (f) => f.bones.chest.x) * 1.3);
  const male = runLife({}, 30, 1 / 30, S.PROFILES.male).frames;
  assert.ok(maxAbs(male, (f) => f.bones.spine.x) > maxAbs(male, (f) => f.bones.chest.x), 'male: belly');
  assert.ok(maxAbs(awake, (f) => f.bones.chest.x) > maxAbs(awake, (f) => f.bones.spine.x), 'female: chest');
});

test('weight shifts every 6–14 s while standing, none sitting; glances away happen while idle only', () => {
  const { frames, l } = runLife({}, 300);
  const st = l.state;
  assert.ok(st.shift.next >= 6 && st.shift.next <= 14);
  const rolls = frames.map((f) => f.bones.hips.z);
  assert.ok(Math.max(...rolls) > 0.5 && Math.min(...rolls) < -0.5, 'both legs');
  const sitting = runLife({ standing: false }, 60).frames;
  assert.ok(maxAbs(sitting.slice(120), (f) => f.bones.hips.z) < 1e-6, 'no shift when sitting');
  assert.ok(frames.some((f) => f.away), 'idle: looks elsewhere sometimes');
  assert.ok(!runLife({ idle: false }, 120).frames.some((f) => f.away), 'busy: never');
  // no forbidden motion words in what the layer gives out
  const keys = new Set(frames.slice(0, 50).flatMap((f) => [...Object.keys(f), ...Object.keys(f.bones)]));
  for (const w of ['hop', 'spin', 'dangle', 'stride', 'wobble', 'shake']) assert.ok(!keys.has(w), w);
  for (const b of Object.keys(frames[0].bones)) assert.ok(Life.BONES.includes(b), `${b} is a bone the renderer keeps (overClip)`);
});

test('long run: nothing accumulates — the offsets after an hour are as small as after a minute', () => {
  const l = Life.createLife({ rand: D.seeded(3), style: S.PROFILES.female });
  let last = null;
  for (let i = 0; i < 3600 * 12; i++) last = l.step(1 / 12, { standing: true, idle: true });
  for (const r of Object.values(last.bones)) for (const v of [r.x, r.y, r.z]) assert.ok(Math.abs(v) <= Life.LIMITS.bone);
  assert.ok(Number.isFinite(l.state.breathPh));
});
