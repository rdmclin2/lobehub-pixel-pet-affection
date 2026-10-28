'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const aff = require('../src/core/affection');

const T0 = new Date('2026-01-05T10:00:00').getTime();
const MIN = 60000;
const HOUR = 60 * MIN;
// A neutral pet: mood/hunger in the band with no modifier, greet already used so deltas are exact.
const mk = (affection = 0, extra = {}) => ({ hunger: 30, mood: 50, lastInteractionAt: T0, ...aff.initialAffection(T0, affection), dailyCounts: { greet: 1 }, ...extra });

test('stage thresholds: 14/15, 34/35, 59/60, 84/85', () => {
  const cases = [[0, 'stranger'], [14, 'stranger'], [14.9, 'stranger'], [15, 'familiar'], [34, 'familiar'], [35, 'close'], [59, 'close'], [60, 'flirty'], [84, 'flirty'], [85, 'lover'], [100, 'lover']];
  for (const [v, id] of cases) assert.equal(aff.stageForAffection(v), id, `${v}`);
  assert.deepEqual(aff.REL_STAGES.map((s) => s.nameZh), ['陌生', '熟悉', '亲近', '暧昧', '恋人']);
});

test('adult stages read 知己 / 挚友 when adult content is off', () => {
  assert.equal(aff.stageName('flirty', false), '知己');
  assert.equal(aff.stageName('lover', false), '挚友');
  assert.equal(aff.stageName('flirty', true), '暧昧');
  assert.equal(aff.stageName('close', false), '亲近');
});

test('each interaction scores its rule amount', () => {
  for (const [src, d] of [['pat', 1], ['feed', 2], ['play', 2], ['chat', 1.5]]) {
    const p = mk();
    assert.equal(aff.gainAffection(p, src, T0).delta, d, src);
  }
  const p = mk(10);
  assert.equal(aff.gainAffection(p, 'woken', T0).delta, -2);
  assert.equal(aff.gainAffection(p, 'feed_full', T0).delta, -1);
  assert.equal(p.affection, 7);
});

test('the first positive interaction of the day adds the +3 greet bonus once', () => {
  const p = { hunger: 30, mood: 50, lastInteractionAt: T0, ...aff.initialAffection(T0) };
  const r = aff.gainAffection(p, 'pat', T0);
  assert.equal(r.delta, 4);
  assert.deepEqual(r.parts.map((x) => x.source), ['greet', 'pat']);
  assert.equal(aff.gainAffection(p, 'feed', T0 + MIN).delta, 2);
});

test('stage-up event fires exactly when a threshold is crossed', () => {
  const p = mk(14);
  const r = aff.gainAffection(p, 'pat', T0);
  assert.equal(r.stageUp, true);
  assert.equal(r.from, 'stranger');
  assert.equal(r.to, 'familiar');
  assert.deepEqual(r.unlockedStages, ['familiar']);
  assert.equal(p.peakStage, 'familiar');
  const r2 = aff.gainAffection(p, 'feed', T0 + MIN);
  assert.equal(r2.stageUp, false);
  assert.deepEqual(r2.unlockedStages, []);
});

test('anti-grinding: cooldown per source, also when the clock is set back', () => {
  const p = mk();
  assert.equal(aff.gainAffection(p, 'pat', T0).delta, 1);
  const again = aff.gainAffection(p, 'pat', T0 + MIN);
  assert.equal(again.delta, 0);
  assert.equal(again.blocked, 'cooldown');
  assert.equal(aff.gainAffection(p, 'pat', T0 - HOUR).blocked, 'cooldown');
  assert.equal(aff.gainAffection(p, 'pat', T0 + 2 * MIN).delta, 1);
});

test('anti-grinding: per-source daily count limit', () => {
  const p = mk();
  let t = T0;
  for (let i = 0; i < 4; i++, t += 11 * MIN) assert.equal(aff.gainAffection(p, 'feed', t).delta, 2);
  const fifth = aff.gainAffection(p, 'feed', t);
  assert.equal(fifth.delta, 0);
  assert.equal(fifth.blocked, 'daily');
});

test('anti-grinding: total positive gain is capped at +12 per day and resets at 04:00', () => {
  const p = mk();
  let total = 0;
  let t = T0;
  for (let i = 0; i < 12; i++, t += 2 * MIN) total += aff.gainAffection(p, 'chat', t).delta; // 12 × 1.5 = 18 wanted
  assert.equal(total, 12);
  assert.equal(p.affectionToday, 12);
  assert.equal(aff.gainAffection(p, 'pat', t).blocked, 'cap');
  // negative sources are not capped
  assert.equal(aff.gainAffection(p, 'woken', t).delta, -2);
  // 03:59 next day is still the same affection day, 04:00 is a new one
  const before4 = new Date('2026-01-06T03:59:00').getTime();
  assert.equal(aff.gainAffection(p, 'play', before4).blocked, 'cap');
  const after4 = new Date('2026-01-06T04:00:00').getTime();
  const r = aff.gainAffection(p, 'play', after4);
  assert.equal(r.delta, 5); // greet +3, play +2
  assert.equal(p.affectionDay, '2026-01-06');
});

test('topics score once per topic per day and three per day', () => {
  const p = mk();
  assert.equal(aff.gainAffection(p, 'topic', T0, { topicId: 'intro' }).delta, 2);
  assert.equal(aff.gainAffection(p, 'topic', T0, { topicId: 'intro' }).blocked, 'topic-today');
  assert.equal(aff.gainAffection(p, 'topic', T0, { topicId: 'weather' }).delta, 2);
  assert.equal(aff.gainAffection(p, 'topic', T0, { topicId: 'hobby' }).delta, 2);
  assert.equal(aff.gainAffection(p, 'topic', T0, { topicId: 'riddle' }).blocked, 'daily');
});

test('tucking in only scores between 22:00 and 02:00', () => {
  const p = mk();
  assert.equal(aff.gainAffection(p, 'sleep', T0).blocked, 'window');
  assert.equal(aff.gainAffection(p, 'sleep', new Date('2026-01-05T23:00:00').getTime()).delta, 1);
});

test('mood and hunger modifiers', () => {
  assert.equal(aff.gainAffection(mk(0, { mood: 10 }), 'feed', T0).delta, 1);
  assert.equal(aff.gainAffection(mk(0, { mood: 80 }), 'feed', T0).delta, 2.4);
  assert.equal(aff.gainAffection(mk(0, { hunger: 80 }), 'play', T0).delta, 1);
  assert.equal(aff.gainAffection(mk(0, { hunger: 80 }), 'feed', T0).delta, 2);
});

test('active negatives can demote, but peakStage (unlocks) stays', () => {
  const p = mk(15);
  p.peakStage = 'familiar';
  const r = aff.gainAffection(p, 'woken', T0);
  assert.equal(r.stageDown, true);
  assert.equal(p.relStage, 'stranger');
  assert.equal(p.peakStage, 'familiar');
});

test('offline decay: 48 h grace, -1 per 12 h, at most -8, never below the stage threshold', () => {
  const p = mk(50);
  assert.equal(aff.decay(p, T0 + 59 * HOUR), 0);
  assert.equal(aff.decay(p, T0 + 60 * HOUR), 1);
  assert.equal(aff.decay(p, T0 + 60 * HOUR), 0); // not counted twice
  assert.equal(aff.decay(p, T0 + 84 * HOUR), 2);
  assert.equal(aff.decay(p, T0 + 1000 * HOUR), 5); // 8 per absence in total
  assert.equal(p.affection, 42);
  const q = mk(36);
  aff.decay(q, T0 + 1000 * HOUR);
  assert.equal(q.affection, 35); // floor of 亲近
  assert.equal(q.relStage, 'close');
});

test('progress for the UI: value, next stage and how much is missing', () => {
  const p = mk(42);
  p.relStage = 'close';
  const pr = aff.toAffectionProgress(p, { adult: false });
  assert.equal(pr.value, 42);
  assert.equal(pr.stageName, '亲近');
  assert.equal(pr.next, 'flirty');
  assert.equal(pr.nextName, '知己');
  assert.equal(pr.need, 18);
  assert.equal(aff.toAffectionProgress(p, { adult: true }).nextName, '暧昧');
  const top = mk(92);
  top.relStage = 'lover';
  assert.equal(aff.toAffectionProgress(top).next, null);
  assert.equal(aff.toAffectionProgress(top).pct, 100);
});

test('adult content needs both an 18+ answer and the switch, and is never allowed for Dafeiyu', () => {
  assert.equal(aff.adultAllowed(null, 'testchan'), false);
  assert.equal(aff.adultAllowed({ ageConfirmed: true, adultContent: false }, 'testchan'), false);
  assert.equal(aff.adultAllowed({ ageConfirmed: false, adultContent: true }, 'testchan'), false);
  assert.equal(aff.adultAllowed({ ageConfirmed: true, adultContent: true }, 'testchan'), true);
  assert.equal(aff.adultAllowed({ ageConfirmed: true, adultContent: true }, 'dafeiyu'), false);
});
