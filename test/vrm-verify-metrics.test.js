'use strict';
// T-5089: the numbers of e2e/vrm-verify.js — angular speed, the dominant-frequency share (a single sine vs mixed
// motion), idle hit ratio and distinct clips, the pose difference between clips.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../e2e/vrm-verify-metrics');

const qz = (deg) => { const h = (deg * Math.PI) / 360; return [0, 0, Math.sin(h), Math.cos(h)].map((v) => +v.toFixed(4)); };
const series = (n, dt, fn, extra = () => ({})) => Array.from({ length: n }, (_, i) => { const t = i * dt; return { t, q: Object.fromEntries(M.IDLE_BONES.map((b, k) => [b, qz(fn(t, k))])), ...extra(t, i) }; });

test('qAngle: 4-decimal rounding of an unchanged pose is not motion; a 10° turn is 10°', () => {
  assert.ok(M.qAngle(qz(30), qz(30)) < 0.05);
  assert.ok(Math.abs(M.qAngle(qz(0), qz(10)) - 10) < 0.05);
});

test('boneStats: a held pose is still (speed ~0); a 1 Hz sine is fast and dominated by one frequency', () => {
  const still = M.boneStats(series(300, 0.1, () => 5));
  assert.ok(still.head.speedMean < 0.5 && still.head.dominant === null);
  const sine = M.boneStats(series(300, 0.1, (t) => 10 * Math.sin(2 * Math.PI * 0.5 * t)));
  assert.ok(sine.head.speedMean > 15, `speed ${sine.head.speedMean}`);
  assert.ok(sine.head.speedSd > 0);
  assert.ok(sine.head.dominant.share > 0.8, `share ${sine.head.dominant.share}`);
});

test('boneStats: several frequencies and a drift are not a single sine', () => {
  const mix = M.boneStats(series(600, 0.1, (t, k) => 6 * Math.sin(0.7 * t + k) + 4 * Math.sin(2.3 * t) + 3 * Math.sin(0.21 * t * t) + (t > 30 ? 8 : 0)));
  assert.ok(mix.head.dominant.share < 0.8, `share ${mix.head.dominant.share}`);
});

test('idleMetrics: hit ratio over the samples, distinct clips in order, the pose difference between clips', () => {
  const s = series(200, 0.1, (t) => (t < 10 ? 0 : 20), (t) => ({ base: t < 10 ? 'idle.a@female' : 'idle.b@female', file: true, idleKind: 'clip', layers: 'idle.a@female:1.00' }));
  s[0] = { ...s[0], file: false, idleKind: 'micro' };
  const m = M.idleMetrics(s);
  assert.equal(m.samples, 200);
  assert.equal(m.hits, 199);
  assert.equal(m.distinctClips, 2);
  assert.deepEqual(m.clipSequence, ['idle.a@female', 'idle.b@female']);
  assert.equal(m.poseDelta.length, 1);
  assert.ok(Math.abs(m.poseDelta[0].maxDeg - 20) < 0.2, JSON.stringify(m.poseDelta));
});

test('tposeIntervals: both arms level for a while outside reactions is reported with its clip; arms down or a cheer is not', () => {
  const s = Array.from({ length: 60 }, (_, i) => ({ t: i * 0.1, base: 'idle.v01@female', arms: i >= 10 && i < 30 ? [3, 5] : [-75, -76], reaction: i >= 40 && i < 50 ? 'react.cheer' : '' }));
  for (let i = 40; i < 50; i++) s[i].arms = [10, 10];
  const v = M.tposeIntervals(s);
  assert.equal(v.length, 1);
  assert.equal(v[0].base, 'idle.v01@female');
  assert.ok(Math.abs(v[0].seconds - 2) < 0.01, JSON.stringify(v));
});
