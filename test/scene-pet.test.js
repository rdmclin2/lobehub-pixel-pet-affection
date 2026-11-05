'use strict';
// 像素小院 · 她的状态机 (src/core/scene-pet.js, docs/pixel-scene-design.md §4.2): injected randomness and time
const test = require('node:test');
const assert = require('node:assert/strict');
const SP = require('../src/core/scene-pet');
const M = require('../src/core/scene-map');
const { STATES } = require('../src/core/fx');

const lcg = (seed = 5) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); };
const run = (pet, sec, each = () => {}) => { for (let i = 0; i < sec * 30; i++) { pet.tick(1 / 30); each(pet.state()); } };
const tileOf = (s) => [Math.floor(s.x / 16), Math.floor(s.y / 16)];

test('roam off: 60 s and she does not walk by herself; roam on: she does', () => {
  const still = SP.createScenePet({ rnd: lcg(1), roam: false });
  const a = still.state();
  const states = new Set();
  run(still, 60, (s) => states.add(s.mode));
  assert.deepEqual([...states], ['idle']);
  assert.equal(still.state().x, a.x);
  const free = SP.createScenePet({ rnd: lcg(1), roam: true });
  const modes = new Set();
  run(free, 60, (s) => modes.add(s.mode));
  assert.ok(modes.has('wander'), [...modes].join(','));
  assert.ok(free.state().walked > 16);
});

test('clickGround: walk → idle on the clicked tile; a blocked click goes to the nearest walkable tile', () => {
  const pet = SP.createScenePet({ rnd: lcg(2), roam: false });
  const r = pet.clickGround(3 * 16 + 5, 2 * 16 + 5);
  assert.equal(r.ok, true);
  assert.deepEqual(r.tile, [3, 2]);
  assert.equal(pet.state().mode, 'goto');
  assert.equal(pet.state().state, 'walk');
  let facing = null;
  run(pet, 20, (s) => { if (s.mode === 'goto') facing = facing || s.facing; });
  const s = pet.state();
  assert.equal(s.mode, 'idle');
  assert.deepEqual(tileOf(s), [3, 2]);
  assert.equal(facing, 'left');
  assert.ok(pet.drain().some((e) => e.type === 'arrive' && e.goto));
  const b = pet.clickGround(10 * 16 + 8, 2 * 16 + 8); // the house
  assert.equal(b.ok, true);
  assert.ok(M.walkable(pet.map, ...b.tile));
});

test('walking: 24 px/s and only over walkable tiles', () => {
  const pet = SP.createScenePet({ rnd: lcg(3), roam: false });
  pet.clickGround(17 * 16 + 8, 9 * 16 + 8);
  const pts = [];
  run(pet, 1, (s) => pts.push(s));
  assert.ok(Math.abs(pts[pts.length - 1].walked - 24) <= 2, `${pts[pts.length - 1].walked}`);
  run(pet, 30, (s) => assert.ok(M.walkableAt(pet.map, s.x, s.y), `${s.x},${s.y}`));
});

test('clickProp bench: goes to its spot, faces it, sits (idle, drawn on the seat); at night she dozes off (sleep)', () => {
  const pet = SP.createScenePet({ rnd: lcg(4), roam: false });
  const r = pet.clickProp('bench');
  assert.equal(r.ok, true);
  assert.equal(r.act, 'sit');
  run(pet, 15);
  const s = pet.state();
  assert.equal(s.mode, 'interact');
  assert.equal(s.act, 'sit');
  assert.equal(s.sitting, true);
  assert.equal(s.state, 'idle');
  assert.equal(s.facing, M.propById(pet.map, 'bench').face);
  assert.deepEqual(tileOf(s), M.propById(pet.map, 'bench').spot);
  assert.ok(s.drawY < s.y, 'on the seat');
  pet.setNight(true);
  run(pet, 9);
  assert.equal(pet.state().state, 'sleep');
  // a click on the ground gets her up
  pet.clickGround(10 * 16, 8 * 16);
  assert.equal(pet.state().sitting, false);
  assert.equal(pet.state().mode, 'goto');
});

test('clickProp flowers: waters them (play) for 2.5 s, fires the act, then idle; lamp: pat and one switch', () => {
  const pet = SP.createScenePet({ rnd: lcg(6), roam: false });
  pet.clickProp('flowers');
  let played = false;
  run(pet, 12, (s) => { if (s.act === 'water' && s.state === 'play') played = true; });
  assert.ok(played);
  const ev = pet.drain().map((e) => `${e.type}:${e.act || ''}`);
  assert.ok(ev.includes('act-start:water') && ev.includes('act-fire:water') && ev.includes('act-done:water'), ev.join(' '));
  assert.equal(pet.state().mode, 'idle');
  pet.clickProp('lamp');
  let patted = false;
  run(pet, 12, (s) => { if (s.act === 'lamp' && s.state === 'pat') patted = true; });
  assert.ok(patted);
  assert.equal(pet.drain().filter((e) => e.type === 'act-fire' && e.act === 'lamp').length, 1);
  pet.clickProp('pond');
  let looked = false;
  run(pet, 15, (s) => { if (s.act === 'look' && s.state === 'look') looked = true; });
  assert.ok(looked);
  assert.equal(pet.clickProp('tree1').ok, false);
  assert.equal(pet.clickProp('nope').ok, false);
});

test('pick / drop: lifted follows the pointer, dropped on a walkable tile (also when let go over water or off the island)', () => {
  const pet = SP.createScenePet({ rnd: lcg(7), roam: true });
  pet.pick(100, 100);
  pet.move(230, 135); // over the pond
  assert.equal(pet.state().mode, 'lifted');
  assert.equal(pet.state().state, 'lifted');
  run(pet, 10);
  assert.equal(pet.state().mode, 'lifted', 'no roaming while held');
  assert.equal(pet.clickGround(50, 50).ok, false);
  const r = pet.drop();
  assert.equal(r.ok, true);
  const s = pet.state();
  assert.ok(M.walkableAt(pet.map, s.x, s.y));
  assert.equal(s.mode, 'idle');
  assert.equal(s.state, 'pat', 'lands with a pat');
  pet.pick(5, 5);
  pet.drop();
  assert.ok(M.walkableAt(pet.map, pet.state().x, pet.state().y));
});

test('poke: a short happy / pat where she stands; every state she shows is a core/fx.js state', () => {
  const pet = SP.createScenePet({ rnd: lcg(8), roam: true });
  const r = pet.poke();
  assert.ok(['happy', 'pat'].includes(r.state));
  assert.equal(pet.state().state, r.state);
  const seen = new Set();
  const g = lcg(9);
  for (let i = 0; i < 40; i++) {
    const k = g();
    if (k < 0.2) pet.clickProp(['bench', 'flowers', 'lamp', 'pond'][Math.floor(g() * 4)]);
    else if (k < 0.3) pet.poke();
    else if (k < 0.35) { pet.pick(g() * 320, g() * 192); pet.drop(); }
    else if (k < 0.5) pet.clickGround(g() * 320, g() * 192);
    if (k > 0.9) pet.setNight(g() < 0.5);
    run(pet, 3, (s) => seen.add(s.state));
  }
  for (const s of seen) assert.ok(STATES.includes(s), s);
  assert.ok(['walk', 'idle', 'play', 'pat', 'look', 'happy'].every((s) => seen.has(s)), [...seen].join(','));
});
