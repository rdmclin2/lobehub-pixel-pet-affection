'use strict';
// 房间小游戏 · 窗外的天色 (src/core/room-sky.js, docs/room.md §5)
const test = require('node:test');
const assert = require('node:assert/strict');
const SKY = require('../src/core/game-sky');
const RS = require('../src/core/room-sky');
const ROOM = require('../src/core/room');

const clear = SKY.mixWeather('clear', 'clear', 1);

test('inside: the room gets half of the outside grade (never as dark as the sky), as painted by day', () => {
  const night = SKY.grade(23, clear);
  const inn = RS.inside(night);
  for (let i = 0; i < 3; i++) {
    assert.ok(inn.mul[i] > night.mul[i], 'lighter than outside');
    assert.ok(inn.mul[i] < 1, 'still darker than by day');
    assert.ok(Math.abs(inn.mul[i] - (1 + (night.mul[i] - 1) * RS.INSIDE)) < 1e-9);
  }
  const noon = RS.inside(SKY.grade(12, clear));
  for (const v of noon.mul) assert.ok(Math.abs(v - 1) < 0.05);
  assert.deepEqual(RS.inside(night, 0), { mul: [1, 1, 1], sat: 1, lift: 0 });
});

test('body: the sun from 06:00 to 18:00 (highest at noon), the moon at night (highest at midnight)', () => {
  assert.equal(RS.body(12).kind, 'sun');
  assert.ok(Math.abs(RS.body(12).up - 1) < 1e-9);
  assert.ok(Math.abs(RS.body(12).u - 0.5) < 1e-9);
  assert.ok(RS.body(7).u < RS.body(16).u, 'moves left to right');
  assert.equal(RS.body(18).kind, 'moon');
  assert.equal(RS.body(2).kind, 'moon');
  assert.ok(Math.abs(RS.body(0).up - 1) < 1e-9);
  assert.equal(RS.body(5.9).kind, 'moon');
  assert.equal(RS.body(-1).kind, 'moon', 'wraps');
});

test('stars: out on a clear night, none by day, hidden by clouds and fog', () => {
  assert.equal(RS.stars(SKY.grade(12, clear)), 0);
  const night = RS.stars(SKY.grade(23, clear));
  assert.ok(night > 0.75, `clear night ${night}`);
  assert.ok(RS.stars(SKY.grade(23, SKY.mixWeather('clear', 'rain', 1))) < night * 0.3);
  assert.ok(RS.stars(SKY.grade(23, SKY.mixWeather('clear', 'fog', 1))) < night * 0.6);
});

test('lineFor: the weather first, else the hour, else none; quarter hours for settings.scene.hour', () => {
  const lines = { rain: '下雨了', night: '夜深了' };
  assert.equal(RS.lineFor(lines, 'night', 'rain'), '下雨了');
  assert.equal(RS.lineFor(lines, 'night', 'clear'), '夜深了');
  assert.equal(RS.lineFor(lines, 'day', 'clear'), null);
  assert.equal(RS.lineFor(undefined, 'night', 'rain'), null);
  assert.equal(RS.quarter(18.13), 18.25);
  assert.equal(RS.quarter(23.9), 0);
  assert.equal(RS.quarter(-0.5), 23.5);
});

test('大肥鱼的房间: the window is inside the picture, lamps too, a line for every weather but clear and for dawn / dusk / night', () => {
  const t = ROOM.themeById('dafeiyu');
  const { width, height } = t.art;
  const w = t.sky.window;
  const r = (w.x1 - w.x0) / 2;
  assert.ok(w.x0 > 0 && w.x1 < width && w.spring - r > 0 && w.bottom < height && w.spring < w.bottom);
  // the glass sits between the curtains: the middle of the picture, in its upper half
  assert.ok(w.x0 / width > 0.3 && w.x1 / width < 0.55 && w.bottom / height < 0.55);
  assert.ok(t.sky.lamps.length >= 3);
  for (const k of ['sun', 'sunLow', 'moon', 'star', 'rain', 'snowEdge']) assert.match(t.sky.colors[k], /^#[0-9A-F]{6}$/i, `colour ${k}`);
  for (const l of t.sky.lamps) assert.ok(l.x > 0 && l.x < width && l.y > 0 && l.y < height && l.r > 0);
  for (const id of SKY.WEATHER_IDS.filter((x) => x !== 'clear')) assert.ok(t.sky.lines[id], `line for ${id}`);
  for (const id of ['dawn', 'dusk', 'night']) assert.ok(t.sky.lines[id], `line for ${id}`);
  for (const k of Object.keys(t.sky.lines)) assert.ok(SKY.WEATHER_IDS.includes(k) || SKY.PHASE_IDS.includes(k), `known key ${k}`);
});
