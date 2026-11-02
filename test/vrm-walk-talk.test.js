'use strict';
// T-2711: walking about (a turn ≤ 60° that eases in and leads with the head, the walk cycle at the window's
// pace, a smooth stop), talking (bigger gestures than thinking and of another kind, segments rotating on a
// long reply, male and female sets apart), the male legs swinging while lifted, a bigger poke reaction and
// the male doze knees (docs/vrm-motion-system.md §3.6, §5.3, §14).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/core/vrm-director');
const L = require('../src/core/vrm-library');
const S = require('../src/core/vrm-style');
const Life = require('../src/core/vrm-life');
const B = require('../scripts/lib/vrm-bake-core');
const { runtimeMeta } = require('../scripts/vrm-bake');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'vrm-library.json'), 'utf8'));
// the index the bake writes: walks with their own pace (hip heights / s), talk segments with their trim
const PACE = { female: 1.008, male: 1.072 };
function bakedIndex() {
  const clips = {};
  for (const [id, e] of Object.entries(manifest.clips)) {
    const { slot, style } = L.parseId(id);
    const duration = e.kind === 'posture' || e.still ? 1 : e.kind === 'idle' ? 10 : e.trim ? e.trim[1] - e.trim[0] : slot === 'hold.walk' ? 1.4 : 2.5;
    clips[id] = e.src ? { kind: e.kind, style, label: e.label, file: `${style}/${slot}.vrma`, duration, ...(e.loop ? { loop: true } : {}), ...(e.sit ? { sit: true } : {}), ...(e.detrend ? { speed: PACE[style] } : {}), ...runtimeMeta(e) } : { kind: e.kind, style, cycle: e.cycle, every: e.every };
  }
  return L.cleanIndex({ clips });
}
const holdsOf = (o = {}) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: true, facing: 'right', ...o });
function make(style = 'female') {
  const index = bakedIndex();
  return D.createDirector({ style: S.resolveStyle({ packStyle: { base: style } }), index, loaded: new Set(Object.values(index.clips).filter((c) => c.file).map((c) => c.id)), rand: D.seeded(11), posture: 'stand.relaxed' });
}
function run(d, seconds, holds, dt = 1 / 30) {
  const out = [];
  for (let t = 0; t < seconds - 1e-9; t += dt) out.push({ ...d.update(dt, { holds: typeof holds === 'function' ? holds(t) : holds, events: [] }), at: t });
  return out;
}
const hold = (p, re) => p.overlays.filter((o) => o.layer === 'hold' && re.test(o.slot));
const holdW = (p, re) => hold(p, re).reduce((s, o) => s + o.weight, 0);

test('walk: the turn stays within ±60°, takes ≥ 0.3 s, eases in and out, and the head leads it', () => {
  for (const style of ['female', 'male']) {
    const d = make(style);
    run(d, 2, holdsOf()); // standing, facing right: 18°
    // the window starts walking left: the lead-in (window still), then moving at ~0.75 hip heights / s
    const plans = run(d, 3, (t) => holdsOf({ walk: true, facing: 'left', walkSpeed: t < 0.4 ? 0 : 0.75 }));
    const yaws = plans.map((p) => p.facingYaw);
    assert.ok(Math.max(...yaws.map(Math.abs)) <= 60, `${style}: |yaw| ≤ 60 (${Math.min(...yaws)}…${Math.max(...yaws)})`);
    assert.equal(yaws[yaws.length - 1], -D.WALK.yaw, `${style}: walks turned ${D.WALK.yaw}° towards where she goes`);
    // ≥ 0.3 s from the start of the turn to 90% of it (18 → −50: 68°)
    const total = 18 + D.WALK.yaw;
    const t90 = plans.find((p) => 18 - p.facingYaw >= 0.9 * total).at;
    assert.ok(t90 >= 0.3, `${style}: 90% of the turn after ${t90.toFixed(2)} s`);
    // no frame turns faster than turnRate (deg/s), and the speed builds up (no snap on the first frame)
    const speeds = yaws.slice(1).map((y, i) => Math.abs(y - yaws[i]) * 30);
    assert.ok(Math.max(...speeds) <= D.WALK.turnRate + 1, `${style}: max ${Math.max(...speeds).toFixed(0)}°/s`);
    assert.ok(speeds[0] < 40, `${style}: the turn eases in (${speeds[0].toFixed(1)}°/s on the first frame)`);
    // the head and chest lead: turnLead points where she turns to while she turns, and is 0 once she faces there
    const mid = plans.find((p) => p.walk.turning);
    assert.ok(mid.turnLead < -3 && mid.turnLead >= -D.WALK.leadMax, `${style}: lead ${mid.turnLead}`);
    assert.equal(plans[plans.length - 1].turnLead, 0);
  }
});

test('walk: the cycle plays only while she moves, at the window pace (the planted foot keeps up), and fades back to the idle', () => {
  for (const style of ['female', 'male']) {
    const d = make(style);
    run(d, 2, holdsOf({ walk: true, facing: 'right', walkSpeed: 0 })); // already turned: standing still while walking = no cycle
    const still = run(d, 0.5, holdsOf({ walk: true, facing: 'right', walkSpeed: 0 })).pop();
    assert.equal(still.hold, null, `${style}: no walk cycle while the window does not move`);
    for (const speed of [0.5, 0.8, 1.2]) {
      const p = run(d, 1.5, holdsOf({ walk: true, facing: 'right', walkSpeed: speed })).pop();
      assert.equal(p.hold, 'walk');
      const walk = hold(p, /^hold\.walk$/)[0];
      assert.equal(walk.id, `hold.walk@${style}`);
      assert.equal(walk.mask, 'full');
      // the foot's speed across the screen: the clip's pace × rate × sin(yaw) = the window's speed (±5%)
      const across = PACE[style] * p.walk.rate * Math.sin((p.facingYaw * Math.PI) / 180);
      assert.ok(Math.abs(across - speed) / speed < 0.05, `${style} @${speed}: feet ${across.toFixed(3)} vs window ${speed}`);
    }
    // the clip's clock runs at that rate (the phase moves), it never jumps back mid-stride
    const ph = run(d, 1, holdsOf({ walk: true, facing: 'right', walkSpeed: 0.8 })).map((p) => p.walk.phase);
    assert.ok(ph.every((x, i) => i === 0 || x > ph[i - 1]), `${style}: the phase only goes forward`);
    // stop: the window stops, the walk weight fades out over ≥ 0.4 s, no frame jumps by more than 0.12
    const stop = run(d, 1.5, holdsOf({ walk: false, facing: 'right' }));
    const w = stop.map((p) => holdW(p, /^hold\.walk$/));
    const gone = stop.findIndex((p) => holdW(p, /^hold\.walk$/) === 0);
    assert.ok(gone * (1 / 30) >= 0.4, `${style}: faded out over ${(gone / 30).toFixed(2)} s`);
    assert.ok(w.slice(1).every((x, i) => Math.abs(x - w[i]) <= 0.12), `${style}: smooth fade ${w.map((x) => x.toFixed(2)).join(' ')}`);
    assert.ok(Math.abs(stop[stop.length - 1].facingYaw - 18) < 0.5, `${style}: back to facing the screen (${stop[stop.length - 1].facingYaw})`);
  }
});

test('walk: turning on the spot takes small steps; male and female walks are different clips', () => {
  const d = make('female');
  run(d, 1, holdsOf());
  const turning = run(d, 0.3, holdsOf({ walk: true, facing: 'left', walkSpeed: 0 })).pop();
  assert.equal(turning.hold, 'walk', 'turning in place: small steps, not a slide');
  assert.ok(turning.walk.rate > 0.2 && turning.walk.turning);
  const f = manifest.clips['hold.walk@female'];
  const m = manifest.clips['hold.walk@male'];
  assert.notEqual(f.src, m.src);
  for (const e of [f, m]) assert.ok(e.detrend && e.loop && e.mask === 'full' && /^mixamo\//.test(e.src));
});

test('talk: bigger gestures than before, a different kind of move than thinking, segments rotating on a long reply', () => {
  for (const style of ['female', 'male']) {
    const segs = L.TALK_SEGMENTS.map((s) => manifest.clips[`${s}@${style}`]);
    assert.ok(segs.every(Boolean), `${style}: three talk segments`);
    assert.equal(new Set(segs.map((e) => e.src)).size, 3, `${style}: three different clips`);
    // the gestures: an upper-body clip (arms + chest + head nods) at ≥ 90%, moving (not a held pose);
    // thinking holds one still pose
    for (const e of segs) assert.ok(e.mask === 'upper' && e.weight >= 0.9 && !e.still && e.loop, `${style} talk: ${JSON.stringify({ mask: e.mask, weight: e.weight })}`);
    const think = manifest.clips[`hold.think@${style}`];
    assert.ok(think.still && think.gaze && think.gaze.y > 1, `${style}: thinking is a still pose looking up`);
    assert.ok(!segs.some((e) => e.src === think.src), `${style}: no talk segment is the thinking pose`);
    // a 12 s reply: ≥ 3 segments, never the same twice in a row, the clip time always moving, smooth weights
    const d = make(style);
    run(d, 1, holdsOf());
    const plans = run(d, 12, holdsOf({ talk: true }));
    const order = [];
    for (const p of plans) if (p.talkSegment && p.talkSegment !== order[order.length - 1]) order.push(p.talkSegment);
    assert.ok(order.length >= 3, `${style}: segments ${order.join(' → ')}`);
    assert.ok(order.every((s, i) => i === 0 || s !== order[i - 1]));
    const top = plans.slice(15).map((p) => { const o = hold(p, /^hold\.talk/); return o[o.length - 1]; });
    const frozen = top.filter((o, i) => i > 0 && o.id === top[i - 1].id && Math.abs(o.time - top[i - 1].time) < 1e-6).length;
    assert.equal(frozen, 0, `${style}: the gesture never stops on one frame`);
    const total = plans.map((p) => holdW(p, /^hold\.talk/));
    assert.ok(total.slice(15).every((x) => x > 0.5), `${style}: the gestures stay on through the switches`);
    // a cue's small cheer does not run on over thinking
    const c = make(style);
    run(c, 1, holdsOf());
    c.update(0.05, { holds: holdsOf(), events: [] });
    c.state.react = null;
    for (let i = 0; i < 40 && !c.state.react; i++) c.update(0.05, { holds: holdsOf(), events: [{ type: 'cue', name: 'play' }] });
    if (c.state.react) {
      const th = run(c, 0.6, holdsOf({ think: true })).pop();
      assert.equal(th.reaction, null, `${style}: the cue's cheer ends when she starts thinking`);
    }
    // a reply streaming in: the app still "thinks" while its words appear — she talks
    assert.equal(run(d, 0.5, holdsOf({ talk: true, think: true })).pop().hold, 'talk');
    // nods with the words while talking (the alive layer), none while thinking
    assert.ok(plans[plans.length - 1].life.talk > 0.9);
    assert.equal(run(d, 2, holdsOf({ think: true })).pop().life.talk, 0);
  }
  // the two styles talk differently
  for (const s of L.TALK_SEGMENTS) assert.notEqual(manifest.clips[`${s}@female`].src, manifest.clips[`${s}@male`].src, s);
});

test('lifted: the male legs swing ≥ 60% as far as the female legs; the poke turns the head further; the male doze knees bend forward', () => {
  const swing = (style) => {
    const life = Life.createLife({ rand: D.seeded(3), style: S.resolveStyle({ packStyle: { base: style } }) });
    let max = 0;
    for (let i = 0; i < 180; i++) {
      const velX = i < 60 ? 600 : i < 120 ? -600 : 0;
      const o = life.step(1 / 30, { lifted: true, velX, standing: true });
      const u = o.bones.leftUpperLeg || { x: 0, z: 0 };
      max = Math.max(max, Math.hypot(u.x, u.z));
    }
    return max;
  };
  const f = swing('female');
  const m = swing('male');
  assert.ok(m >= 0.6 * f, `male ${m.toFixed(1)}° vs female ${f.toFixed(1)}°`);
  assert.ok(S.PROFILES.male.liftSwing > S.PROFILES.female.liftSwing);
  // poke: a stronger turn baked (boost) and a high weight, both styles
  for (const style of ['female', 'male']) {
    const e = manifest.clips[`react.touch-face@${style}`];
    assert.ok(e.weight >= 0.95 && e.boost && e.boost.head >= 1.3, `${style}: ${JSON.stringify({ weight: e.weight, boost: e.boost })}`);
  }
  // the male doze: the lower legs bent forward on top of the source (which had them at −9°)
  const doze = manifest.clips['sit.doze@male'];
  assert.ok(doze.offset.leftLowerLeg[0] >= 9 && doze.offset.rightLowerLeg[0] >= 9);
});

test('bake: a walk walked in place keeps its sway, its pace is measured; boost scales a turn', () => {
  const times = [0, 0.5, 1];
  const clip = { duration: 1, restHipsY: 1, bones: { hips: { times, values: times.map(() => [0, 0, 0, 1]) } }, hips: { times, values: [[0, 1, 0], [0.05, 0.97, 0.6], [0, 1, 1.2]] } };
  assert.ok(Math.abs(B.travelSpeed(clip) - 1.2) < 1e-9);
  const inPlace = B.detrendClip(clip);
  assert.deepEqual(inPlace.hips.values.map((p) => p.map((x) => +x.toFixed(6))), [[0, 1, 0], [0.05, 0.97, 0], [0, 1, 0]]);
  const q = B.qEuler(0, 20, 0);
  const b = B.boostClip({ duration: 1, bones: { head: { times: [0], values: [q] } } }, { head: 1.5 });
  assert.ok(Math.abs(B.qangle(b.bones.head.values[0], [0, 0, 0, 1]) - 30) < 1e-6);
  assert.deepEqual(L.validateManifest({ schema: 1, clips: { 'hold.walk@male': { kind: 'hold', style: 'male', src: 'mixamo/x.fbx', mask: 'full', detrend: 'yes' } } }), ['hold.walk@male: detrend is true / false']);
  assert.equal(L.cleanIndex({ clips: { 'hold.walk@male': { kind: 'hold', file: 'male/hold.walk.vrma', duration: 1.4, speed: 1.07, mask: 'full' } } }).clips['hold.walk@male'].speed, 1.07);
});
