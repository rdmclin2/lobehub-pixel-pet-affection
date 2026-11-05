'use strict';
// 像素小院 · 天气系统 (src/core/scene-weather.js, docs/pixel-scene-design.md §6)
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/core/scene-weather');
const settings = require('../src/core/settings');

const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const lcg = (seed = 1) => { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); };

test('every weather has a full parameter set; the ids match settings SCENE_WEATHERS', () => {
  assert.deepEqual(W.WEATHER_IDS, settings.SCENE_WEATHERS);
  for (const id of W.WEATHER_IDS) {
    const w = W.WEATHERS[id];
    assert.equal(w.id, id);
    assert.ok(w.name);
    assert.ok(w.clouds && Number.isInteger(w.clouds.count) && w.clouds.day && w.clouds.night);
    assert.ok(w.tint && /^#[0-9a-f]{6}$/.test(w.tint.color) && w.tint.k >= 0 && w.tint.k <= 1);
    assert.ok(typeof w.shadowMul === 'number' && Number.isInteger(w.fireflies));
    assert.ok(w.particle === null || ['rain', 'snow'].includes(w.particle));
  }
  assert.equal(W.WEATHERS.rain.count, 160);
  assert.equal(W.WEATHERS.snow.count, 120);
  assert.equal(W.WEATHERS.clear.count, 0);
});

test('mixWeather: k=0 is `from`, k=1 is `to`; particle targets cross-fade', () => {
  const a = W.mixWeather('clear', 'rain', 0);
  assert.equal(a.tint.k, W.WEATHERS.clear.tint.k);
  assert.deepEqual(a.targets, { rain: 0, snow: 0 });
  const b = W.mixWeather('clear', 'rain', 1);
  assert.equal(b.tint.k, W.WEATHERS.rain.tint.k);
  assert.equal(b.tint.color, W.WEATHERS.rain.tint.color);
  assert.deepEqual(b.targets, { rain: 160, snow: 0 });
  const m = W.mixWeather('rain', 'snow', 0.5);
  assert.deepEqual(m.targets, { rain: 80, snow: 60 });
  assert.equal(W.mixWeather('fog', 'fog', 1).fog, 0.25);
  assert.equal(W.mixWeather('clear', 'storm', 1).lightning, true);
  assert.equal(W.spawnCount('rain', 0.5), 80);
  assert.equal(W.spawnCount('snow', 0), 0);
});

test('nextWeather: rows sum to 1, reproducible with a fixed random sequence, snow only in Nov–Feb, no storm straight from clear', () => {
  for (const [from, row] of Object.entries(W.TRANSITIONS)) {
    const sum = Object.values(row).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `${from} sums to ${sum}`);
    for (const m of [0, 6]) assert.ok(Math.abs(Object.values(W.transitionRow(from, { month: m })).reduce((s, v) => s + v, 0) - 1) < 1e-9);
  }
  const r1 = []; const r2 = [];
  let c1 = 'clear', c2 = 'clear';
  const g1 = lcg(7), g2 = lcg(7);
  for (let i = 0; i < 50; i++) { c1 = W.nextWeather(c1, g1, { month: 0 }); c2 = W.nextWeather(c2, g2, { month: 0 }); r1.push(c1); r2.push(c2); }
  assert.deepEqual(r1, r2);
  assert.equal(W.transitionRow('snow', { month: 6 }).snow, 0);
  assert.equal(W.transitionRow('clear', { month: 6 }).snow, 0);
  const g = lcg(3);
  for (let i = 0; i < 2000; i++) {
    assert.notEqual(W.nextWeather('clear', g, { month: 6 }), 'storm');
    assert.notEqual(W.nextWeather('cloudy', g, { month: 6 }), 'snow');
  }
  assert.equal(W.nextWeather('clear', seq([0]), { month: 0 }), 'clear');
  assert.equal(W.nextWeather('clear', seq([0.999]), { month: 0 }), 'fog');
  const d = W.autoDelay(seq([0.5]));
  assert.ok(d >= W.AUTO_MIN_S && d <= W.AUTO_MAX_S);
});

test('stepParticles: builds up gradually, never above the target; drops leaving the bottom are recycled; 0 = none', () => {
  const g = lcg(11);
  const list = [];
  W.stepParticles(list, 1 / 30, { targets: { rain: 160, snow: 0 } }, g);
  assert.ok(list.length > 0 && list.length < 160, `first frame ${list.length}`);
  for (let i = 0; i < 120; i++) W.stepParticles(list, 1 / 30, { targets: { rain: 160, snow: 0 } }, g);
  const n = W.countKinds(list);
  assert.ok(n.rain >= 150 && list.length <= 160, `${n.rain} / ${list.length}`);
  assert.ok(list.every((p) => p.y <= W.H + 1));
  // the weather clears: the drops leave and none come back
  for (let i = 0; i < 200; i++) W.stepParticles(list, 1 / 30, { targets: { rain: 0, snow: 0 } }, g);
  assert.equal(list.length, 0);
  // snow, then nothing with intensity 0
  for (let i = 0; i < 200; i++) W.stepParticles(list, 1 / 30, { targets: { rain: 0, snow: 120 } }, g);
  assert.ok(W.countKinds(list).snow <= 120 && W.countKinds(list).snow >= 110);
  assert.ok(list.every((p) => p.x >= 0 && p.x < W.W));
  const none = [];
  for (let i = 0; i < 30; i++) W.stepParticles(none, 1 / 30, { targets: { rain: W.spawnCount('rain', 0), snow: 0 } }, g);
  assert.equal(none.length, 0);
});
