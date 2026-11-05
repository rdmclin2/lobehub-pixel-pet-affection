'use strict';
// 像素小院 · 时间系统 (src/core/scene-time.js, docs/pixel-scene-design.md §5): phases, keyframe interpolation,
// quantisation, the clock, the 24 h ring.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/core/scene-time');

test('phaseOf: dawn 4.5–7.5, day 7.5–16.5, dusk 16.5–19.5, night across midnight', () => {
  const cases = [[4.4, 'night'], [4.5, 'dawn'], [6, 'dawn'], [7.5, 'day'], [12, 'day'], [16.49, 'day'], [16.5, 'dusk'], [18, 'dusk'], [19.5, 'night'], [23.99, 'night'], [0, 'night'], [24, 'night'], [-1, 'night'], [30, 'dawn']];
  for (const [t, want] of cases) assert.equal(T.phaseOf(t), want, `${t}`);
  assert.deepEqual(T.PHASES.map((p) => T.phaseOf(p.jump)), T.PHASE_IDS, 'each chip jumps into its own phase');
});

test('lightAt: equals the keyframes at their hours; ambientK in [0,1] and quantised to 1/8', () => {
  for (const k of T.KEYFRAMES) {
    const l = T.lightAt(k.t);
    assert.equal(l.skyTop, k.skyTop);
    assert.equal(l.ambient, k.ambient);
    assert.equal(l.ambientKRaw, k.ambientK);
    assert.equal(l.lights, k.lights);
  }
  for (let t = 0; t < 24; t += 0.1) {
    const l = T.lightAt(t);
    assert.ok(l.ambientK >= 0 && l.ambientK <= 1);
    assert.ok(Number.isInteger(Math.round(l.ambientK * 8 * 1e9) / 1e9), `quantised at ${t}: ${l.ambientK}`);
    assert.match(l.skyTop, /^#[0-9a-f]{6}$/);
  }
});

test('lightAt: noon is the brightest, midnight the darkest; the ring is continuous (t ≡ t+24, 23.9 ≈ 0.1)', () => {
  let min = Infinity, max = -Infinity, at = {};
  for (let t = 0; t < 24; t += 0.05) {
    const k = T.lightAt(t).ambientKRaw;
    if (k < min) { min = k; at.min = t; }
    if (k > max) { max = k; at.max = t; }
  }
  assert.equal(T.lightAt(12).ambientKRaw, 0);
  assert.ok(Math.abs(at.min - 12) < 0.1, `min at ${at.min}`);
  assert.ok(at.max < 0.1 || at.max > 23.9, `max at ${at.max}`);
  for (const t of [3.3, 9.1, 17.9]) assert.deepEqual(T.lightAt(t + 24), T.lightAt(t));
  assert.ok(Math.abs(T.lightAt(23.9).ambientKRaw - T.lightAt(0.1).ambientKRaw) < 0.02);
  // the four phases' representative hours are ordered by brightness: day < dawn, dusk < night
  const K = (h) => T.lightAt(h).ambientKRaw;
  assert.ok(K(12) < K(6) && K(12) < K(18) && K(6) < K(23) && K(18) < K(23));
  // lamps: off by day, on at night
  assert.equal(T.lightAt(12).lights, 0);
  assert.ok(T.lightAt(23).lights > 0.5);
  assert.equal(T.lightAt(12).sunAngle, 270);
  assert.equal(T.lightAt(1).sunAngle, null);
});

test('colours interpolate in linear RGB (no grey dip) and smoothstep eases', () => {
  assert.equal(T.lerpLinearRGB('#ff0000', '#00ff00', 0), '#ff0000');
  assert.equal(T.lerpLinearRGB('#ff0000', '#00ff00', 1), '#00ff00');
  const mid = T.hexToRgb(T.lerpLinearRGB('#ff0000', '#00ff00', 0.5));
  assert.ok(mid[0] > 180 && mid[1] > 180, `linear mid ${mid}`); // an sRGB lerp would give 128,128
  assert.equal(T.smoothstep(0), 0);
  assert.equal(T.smoothstep(1), 1);
  assert.equal(T.smoothstep(0.5), 0.5);
  assert.ok(T.smoothstep(0.1) < 0.1);
  assert.equal(T.quantize(0.3), 0.25);
  assert.equal(T.quantize(2), 1);
});

test('clockHour / formatHour / stepPhase / approachHour', () => {
  assert.equal(T.clockHour(new Date(2026, 10, 5, 18, 30)), 18.5);
  assert.equal(T.formatHour(18.5), '18:30');
  assert.equal(T.formatHour(23.999), '00:00');
  assert.equal(T.formatHour(-0.25), '23:45');
  assert.equal(T.stepPhase(12, 1), 18);
  assert.equal(T.stepPhase(12, -1), 6);
  assert.equal(T.stepPhase(23, 1), 6);
  assert.equal(T.stepPhase(6, -1), 23);
  // the short way round midnight
  const h = T.approachHour(23, 1, 0.5, 0.5);
  assert.ok(h > 23 || h < 1, `${h}`);
  assert.equal(T.approachHour(5, 9, 1, 0), 9);
  let x = 6;
  for (let i = 0; i < 300; i++) x = T.approachHour(x, 12, 1 / 30, 0.6);
  assert.ok(Math.abs(x - 12) < 1e-3);
});
