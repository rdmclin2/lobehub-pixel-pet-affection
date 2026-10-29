'use strict';
// The shared effects layer (src/core/fx.js): every character gets every effect; only art differs.
const test = require('node:test');
const assert = require('node:assert/strict');
const Fx = require('../src/core/fx');
const { SPECIES } = require('../src/core/species');

const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('the state vocabulary is the DeepSeek pet’s 15 clips plus lifted and walk, and every character can play all of them', () => {
  assert.deepEqual([...Fx.STATES].sort(), Object.keys(SPECIES.dafeiyu.clips).sort(), 'Dafeiyu has a clip for every state, lifted and walk included');
  for (const st of Fx.STATES) for (const sp of Object.values(SPECIES)) {
    const has = sp.clips ? (n) => !!sp.clips[n] : () => false;
    assert.ok(Fx.resolveAction(st, has).name, `${sp.id}/${st}`);
  }
});

test('a state without art falls back along the chain, and ends at idle', () => {
  assert.deepEqual(Fx.chain('eat_fruit'), ['eat_fruit', 'eat', 'eat_rice', 'happy', 'cheer', 'idle']);
  assert.deepEqual(Fx.chain('hungry'), ['hungry', 'sad', 'idle']);
  const onlyIdle = (n) => n === 'idle';
  for (const st of Fx.STATES) assert.equal(Fx.resolveAction(st, onlyIdle).name, 'idle', st);
  assert.deepEqual(Fx.resolveAction('idle', onlyIdle), { name: 'idle', exact: true });
  assert.deepEqual(Fx.resolveAction('lifted', onlyIdle), { name: 'idle', exact: false }, 'not exact: an emoji overlay is drawn');
  // Dafeiyu dangles with dsh-pet's own drag clip (it used to borrow the click clip); she walks with its crab walk
  assert.deepEqual(Fx.resolveAction('lifted', (n) => !!SPECIES.dafeiyu.clips[n]), { name: 'lifted', exact: true });
  assert.deepEqual(Fx.resolveAction('walk', (n) => !!SPECIES.dafeiyu.clips[n]), { name: 'walk', exact: true });
  // a character without its own `lifted` still waves (pat) while dangling; without `walk` the idle art hops along
  assert.deepEqual(Fx.resolveAction('lifted', (n) => n !== 'lifted'), { name: 'pat', exact: false });
  assert.deepEqual(Fx.resolveAction('walk', (n) => n !== 'walk'), { name: 'idle', exact: false });
  assert.equal(Fx.resolveAction('nonsense', onlyIdle).name, 'idle');
  for (const st of Fx.STATES) if (st !== 'idle') assert.ok(Fx.OVERLAY[st] || Fx.FOOD_OVERLAY[st], `${st} has a fallback overlay`);
});

test('the idle chain picks by weight and never repeats a cue back to back', () => {
  assert.equal(Fx.nextIdleCue(() => 0), 'look');
  assert.equal(Fx.nextIdleCue(() => 0.999), 'happy');
  assert.equal(Fx.nextIdleCue(() => 0, 'look'), 'turn');
  const rnd = seq(0.1, 0.5, 0.7, 0.95, 0.3, 0.05, 0.6, 0.83, 0.88);
  let prev = null;
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const c = Fx.nextIdleCue(rnd, prev);
    assert.notEqual(c, prev);
    seen.add(c);
    prev = c;
  }
  assert.deepEqual([...seen].sort(), ['happy', 'look', 'play', 'turn', 'walk']);
  // roaming off (高级设置 → 自己走动): the chain never walks
  for (let i = 0; i < 200; i++) assert.notEqual(Fx.nextIdleCue(Math.random, null, { roam: false }), 'walk');
  for (const r of [0, 0.5, 0.9999]) {
    const d = Fx.idleDelay(() => r);
    assert.ok(d >= Fx.IDLE_GAP.min && d < Fx.IDLE_GAP.max);
  }
});

test('clicks alternate between reactions', () => {
  assert.equal(Fx.pickClickReaction(() => 0), 'pat');
  assert.equal(Fx.pickClickReaction(() => 0, 'pat'), 'happy');
  assert.equal(Fx.pickClickReaction(() => 0.9, 'happy'), 'pat');
});

test('facing: mirrored unless the state is listed as noMirror', () => {
  assert.equal(Fx.facingFor('left', 'idle'), 'left');
  assert.equal(Fx.facingFor('left', 'talk', ['talk']), 'right');
  assert.equal(Fx.facingFor('right', 'idle'), 'right');
  assert.equal(Fx.facingFor(undefined, 'idle'), 'right');
});

test('a fast release is a throw; a slow one is just a drop', () => {
  const t = 1000;
  const fast = Fx.releaseVelocity([{ x: 0, y: 0, t: t - 60 }, { x: 60, y: -30, t }], t);
  assert.ok(Fx.isThrow(fast));
  assert.equal(Math.round(fast.vx), 1000);
  const slow = Fx.releaseVelocity([{ x: 0, y: 0, t: t - 60 }, { x: 3, y: 1, t }], t);
  assert.equal(Fx.isThrow(slow), false);
  assert.equal(Fx.isThrow(Fx.releaseVelocity([{ x: 0, y: 0, t: t - 500 }, { x: 500, y: 0, t: t - 400 }], t)), false, 'old samples do not count');
  const capped = Fx.releaseVelocity([{ x: 0, y: 0, t: t - 16 }, { x: 900, y: 0, t }], t);
  assert.ok(Math.hypot(capped.vx, capped.vy) <= Fx.PHYSICS.maxSpeed + 1e-6);
});

test('a thrown pet falls under gravity, bounces off the walls and the floor, and comes to rest inside the screen', () => {
  const area = { x: 0, y: 0, width: 1280, height: 800 };
  const body = { x: 900, y: 300, w: 230, h: 340, vx: 1800, vy: -900 };
  const r = Fx.simulateThrow(body, area);
  assert.equal(r.rest, true);
  assert.ok(r.path.some((p) => p.hit === 'wall'), 'hit the right edge');
  assert.ok(r.path.some((p) => p.hit === 'floor'), 'bounced on the floor');
  for (const p of r.path) {
    assert.ok(p.x >= area.x && p.x <= area.width - body.w, `x ${p.x}`);
    assert.ok(p.y >= area.y && p.y <= area.height - body.h, `y ${p.y}`);
  }
  assert.equal(r.body.y, area.height - body.h, 'rests on the floor');
  assert.ok(r.path.length < 600, `settles in under 10 s (${r.path.length} steps)`);
  // a dropped pet (no velocity) just falls to the floor
  const drop = Fx.simulateThrow({ ...body, vx: 0, vy: 0, y: 0 }, area);
  assert.equal(drop.rest, true);
  assert.equal(drop.body.x, 900);
});
