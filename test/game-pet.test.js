'use strict';
// 小游戏 · 她在场景里 (src/core/game-pet.js, docs/mini-games.md §4)
const test = require('node:test');
const assert = require('node:assert/strict');
const GW = require('../src/core/game-world');
const GP = require('../src/core/game-pet');

const world = GW.createWorld({ width: 400, height: 300, walk: { cell: 8, area: [[0, 0], [400, 0], [400, 300], [0, 300]], blocked: [{ cx: 300, cy: 100, rx: 20, ry: 10 }] } });
const objects = [
  { id: 'bench', use: { at: [300, 120], face: 'left', anim: 'sit', seconds: [5, 5] } },
  { id: 'lamp', use: { at: [100, 250], anim: 'pat', seconds: [1, 1], phases: ['night'] } },
];
const run = (pet, s, ctx = {}) => { const ev = []; for (let t = 0; t < s; t += 0.05) ev.push(...pet.step(0.05, ctx)); return ev; };

test('goTo: she walks there at SPEED, facing the way she goes, and arrives (event arrive, why click)', () => {
  const pet = GP.createGamePet({ world, objects, start: [50, 50], rnd: () => 0.5 });
  const r = pet.goTo(250, 50);
  assert.equal(r.ok, true);
  assert.equal(pet.state().mode, 'walk');
  assert.equal(pet.state().anim, 'walk');
  run(pet, 1, { roam: false });
  const s = pet.state();
  assert.ok(Math.abs(s.x - (50 + GP.SPEED)) < 2, `about SPEED px in 1 s (${s.x})`);
  assert.equal(s.facing, 1);
  const ev = run(pet, 6, { roam: false });
  const a = ev.find((e) => e.type === 'arrive');
  assert.ok(a);
  assert.equal(a.why, 'click');
  assert.equal(pet.state().mode, 'idle');
  assert.ok(Math.hypot(pet.state().x - 250, pet.state().y - 50) < 1);
});

test('use: walks to the thing, use-start (anim, face), use-end after its seconds, then idle', () => {
  const pet = GP.createGamePet({ world, objects, start: [50, 120], rnd: () => 0.5 });
  assert.equal(pet.use('bench').ok, true);
  const ev = run(pet, 12, { roam: false });
  const start = ev.find((e) => e.type === 'use-start');
  const end = ev.find((e) => e.type === 'use-end');
  assert.ok(start && end);
  assert.equal(start.obj, 'bench');
  assert.equal(end.why, 'done');
  assert.ok(ev.indexOf(start) < ev.indexOf(end));
  assert.equal(pet.state().mode, 'idle');
  assert.equal(pet.use('nothing').ok, false);
});

test('using: anim and facing come from the thing', () => {
  const pet = GP.createGamePet({ world, objects, start: [290, 125], rnd: () => 0.5 });
  pet.use('bench');
  run(pet, 1, { roam: false });
  const s = pet.state();
  assert.equal(s.mode, 'use');
  assert.equal(s.anim, 'sit');
  assert.equal(s.facing, -1);
  assert.equal(s.using, 'bench');
});

test('touch: a short happy react, then back to what she was doing; lifted she cannot be touched', () => {
  const pet = GP.createGamePet({ world, objects, start: [50, 50], rnd: () => 0.5 });
  assert.equal(pet.touch().ok, true);
  assert.equal(pet.state().anim, 'happy');
  run(pet, GP.REACT_S + 0.2, { roam: false });
  assert.equal(pet.state().anim, 'idle');
  pet.lift();
  assert.equal(pet.touch().ok, false);
});

test('lift / drop: lifting ends what she uses; dropped on a blocked spot she lands on the nearest walkable one', () => {
  const pet = GP.createGamePet({ world, objects, start: [290, 125], rnd: () => 0.5 });
  pet.use('bench');
  run(pet, 1, { roam: false });
  const r = pet.lift();
  assert.equal(r.ok, true);
  assert.equal(r.events[0].type, 'use-end');
  assert.equal(r.events[0].why, 'lifted');
  assert.equal(pet.state().mode, 'lifted');
  assert.equal(pet.goTo(10, 10).ok, false, 'no walking while held');
  pet.moveLifted(300, 100);
  const d = pet.drop(300, 100);
  assert.equal(d.ok, true);
  assert.equal(GW.walkableAt(world, d.x, d.y), true);
  assert.equal(pet.state().mode, 'idle');
});

test('roam: left alone she goes somewhere by herself; never to a thing whose phases exclude the hour', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pet = GP.createGamePet({ world, objects, start: [50, 50], rnd });
  const ev = run(pet, 120, { phase: 'day' });
  assert.ok(ev.some((e) => e.type === 'arrive' && e.why === 'roam'), 'she strolled');
  assert.ok(!ev.some((e) => e.type === 'use-start' && e.obj === 'lamp'), 'the lamp is a night thing');
  assert.ok(pet.state().walked > 100);
  const still = GP.createGamePet({ world, objects, start: [50, 50], rnd });
  run(still, 30, { phase: 'day', roam: false });
  assert.equal(still.state().walked, 0, 'roam off: she stays');
});

test('use again where she stands: she starts at once (no walk needed), and it ends as usual', () => {
  const pet = GP.createGamePet({ world, objects, start: [300, 120], rnd: () => 0.5 });
  const r = pet.use('bench');
  assert.equal(r.ok, true);
  assert.equal(r.here, true);
  const ev = run(pet, 0.1, { roam: false });
  assert.ok(ev.some((e) => e.type === 'use-start' && e.obj === 'bench'), 'started');
  const more = run(pet, 6, { roam: false });
  assert.ok(more.some((e) => e.type === 'use-end' && e.why === 'done'));
  assert.equal(pet.use('bench').ok, true, 'and once more');
  assert.ok(run(pet, 0.1, { roam: false }).some((e) => e.type === 'use-start'));
});
