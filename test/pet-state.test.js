'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../src/core/pet-state');

const T0 = new Date('2026-01-05T10:00:00').getTime();
const MIN = 60000;
const mk = () => st.createPet({ speciesId: 'bubbo', name: 'B', agentId: 'agt_x', now: T0 });

test('new companion starts as a stranger with 0 affection and sane needs', () => {
  const p = mk();
  assert.equal(p.affection, 0);
  assert.equal(p.relStage, 'stranger');
  assert.equal(p.peakStage, 'stranger');
  assert.equal(p.schemaVersion, 2);
  assert.equal('xp' in p, false);
  assert.equal('stage' in p, false);
  assert.ok(p.hunger < 50 && p.mood > 50);
});

test('hunger grows with time and flips status to hungry', () => {
  const p = mk();
  st.tick(p, T0 + 120 * MIN);
  assert.ok(p.hunger > 75);
  assert.equal(st.currentStatus(p), 'hungry');
});

test('offline time is capped so the pet does not starve overnight', () => {
  const p = mk();
  st.tick(p, T0 + 48 * 60 * MIN);
  assert.ok(p.hunger <= 100);
  assert.ok(p.mood >= 0);
});

test('feeding lowers hunger, raises affection, does not score again while cooling down, and refuses when full', () => {
  const p = mk();
  p.mood = 50;
  p.hunger = 60;
  const r = st.feed(p, 'rice', T0);
  assert.equal(r.ok, true);
  assert.equal(p.hunger, 25);
  assert.equal(r.affection.delta, 5); // +3 first interaction of the day, +2 feed
  p.hunger = 60;
  const again = st.feed(p, 'rice', T0 + MIN);
  assert.equal(again.ok, true);
  assert.equal(p.hunger, 25); // the action still happens...
  assert.equal(again.affection.delta, 0); // ...but scores nothing
  assert.equal(again.affection.blocked, 'cooldown');
  p.hunger = 2;
  const full = st.feed(p, 'rice', T0 + 20 * MIN);
  assert.equal(full.reason, 'full');
  assert.equal(full.affection.delta, -1);
});

test('crossing a threshold through a care action reports a stage-up', () => {
  const p = mk();
  p.mood = 50;
  p.affection = 14;
  p.dailyCounts = { greet: 1 };
  const r = st.pat(p, T0);
  assert.equal(r.affection.stageUp, true);
  assert.equal(r.affection.from, 'stranger');
  assert.equal(r.affection.to, 'familiar');
  assert.deepEqual(r.affection.unlockedStages, ['familiar']);
  assert.ok(p.unlockedTopics.includes('riddle'));
});

test('pet falls asleep at night and is grumpy when woken', () => {
  const p = mk();
  const night = new Date('2026-01-05T23:30:00').getTime();
  p.lastTickAt = night - MIN;
  p.lastInteractionAt = night - MIN;
  p.energy = 40;
  const { events } = st.tick(p, night);
  assert.ok(events.includes('slept'));
  assert.equal(st.currentStatus(p), 'sleep');
  const moodBefore = p.mood;
  p.affection = 10;
  const r = st.pat(p, night);
  assert.equal(p.sleeping, false);
  assert.ok(p.mood < moodBefore + 8);
  assert.equal(r.affection.parts[0].source, 'woken');
  assert.equal(r.affection.parts[0].delta, -2);
});

test('playing is refused when exhausted', () => {
  const p = mk();
  p.energy = 5;
  assert.equal(st.play(p, T0).reason, 'tired');
});
