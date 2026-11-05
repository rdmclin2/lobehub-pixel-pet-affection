'use strict';
// 小游戏 · 天色 (src/core/game-sky.js, docs/mini-games.md §5)
const test = require('node:test');
const assert = require('node:assert/strict');
const SKY = require('../src/core/game-sky');

const bright = (g) => (g.mul[0] + g.mul[1] + g.mul[2]) / 3;

test('phases: 清晨 / 白天 / 黄昏 / 夜晚 by the hour; ‹ › jump to each phase’s own hour, round the clock', () => {
  assert.equal(SKY.phaseOf(7), 'dawn');
  assert.equal(SKY.phaseOf(12), 'day');
  assert.equal(SKY.phaseOf(18), 'dusk');
  assert.equal(SKY.phaseOf(23), 'night');
  assert.equal(SKY.phaseOf(2), 'night');
  assert.equal(SKY.phaseName('dusk'), '黄昏');
  assert.equal(SKY.stepPhase(12, 1), 18);
  assert.equal(SKY.stepPhase(23, 1), 7);
  assert.equal(SKY.stepPhase(7, -1), 23);
  assert.equal(SKY.stepWeather('clear', -1), 'fog');
  assert.equal(SKY.formatHour(18.5), '18:30');
  assert.equal(SKY.formatHour(-0.25), '23:45');
});

test('time flows: one game day in DAY_MINUTES real minutes; the short way round the clock', () => {
  assert.equal(SKY.DAY_MINUTES, 24);
  assert.equal(SKY.flowHours(60), 1, 'one real minute is one game hour');
  assert.equal(SKY.hourDelta(23, 1), 2);
  assert.equal(SKY.hourDelta(1, 23), -2);
});

test('grade: day is the brightest and most saturated, night the darkest and bluest, dusk warm; lights and fireflies at night only', () => {
  const day = SKY.grade(12, SKY.mixWeather('clear', 'clear', 1));
  const dusk = SKY.grade(18, SKY.mixWeather('clear', 'clear', 1));
  const night = SKY.grade(23, SKY.mixWeather('clear', 'clear', 1));
  assert.ok(bright(day) > bright(dusk) && bright(dusk) > bright(night));
  assert.ok(day.sat > night.sat);
  assert.ok(night.mul[2] > night.mul[0], 'night is blue-green');
  assert.ok(dusk.mul[0] > dusk.mul[2] * 1.5, 'dusk is warm');
  assert.equal(day.lights, 0);
  assert.ok(night.lights > 0.9);
  assert.ok(night.flies > 0.9 && day.flies === 0);
  assert.ok(day.sun > 0.9 && night.sun < 0);
});

test('weather: rain darkens and stops the fireflies; a change fades over FADE_S; the matrix is 4×5', () => {
  const clear = SKY.grade(23, SKY.mixWeather('clear', 'clear', 1));
  const rain = SKY.grade(23, SKY.mixWeather('clear', 'rain', 1));
  assert.ok(bright(rain) < bright(clear));
  assert.equal(rain.flies, 0);
  const half = SKY.mixWeather('clear', 'rain', 0.5);
  assert.ok(half.rain > 0 && half.rain < SKY.weatherOf('rain').rain);
  const m = SKY.gradeMatrix(SKY.grade(12, SKY.mixWeather('clear', 'clear', 1)));
  assert.equal(m.length, 20);
  assert.deepEqual(m.slice(15), [0, 0, 0, 1, 0]);
});

test('weather that changes by itself: a neighbour of the current one, every few minutes', () => {
  for (const id of SKY.WEATHER_IDS) for (let i = 0; i < 10; i++) assert.ok(SKY.WEATHER_IDS.includes(SKY.nextWeather(id, () => i / 10)));
  assert.ok(SKY.autoDelay(() => 0) >= SKY.AUTO_MIN_S && SKY.autoDelay(() => 0.999) <= SKY.AUTO_MAX_S);
});
