'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../src/core/pet-state');

const T0 = new Date('2026-01-05T10:00:00').getTime();
const MIN = 60000;
const mk = () => st.createPet({ speciesId: 'grok', name: 'B', agentId: 'agt_x', now: T0 });

test('new companion starts as a stranger with 0 affection and sane needs', () => {
  const p = mk();
  assert.equal(p.affection, 0);
  assert.equal(p.relStage, 'stranger');
  assert.equal(p.peakStage, 'stranger');
  assert.equal('schemaVersion' in p, false, 'the version belongs to the whole save (createSave)');
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

test('a new save holds its first character; cur() is her entry', () => {
  const c = mk();
  const save = st.createSave(c, T0);
  assert.equal(save.schemaVersion, 3);
  assert.equal(save.speciesId, 'grok');
  assert.equal(st.cur(save), c);
  assert.equal(st.cur(null), null);
});

test('resume: a character back on screen picks up where she left, without counting the time away as neglect', () => {
  const p = mk();
  p.hunger = 40;
  p.lastInteractionAt = T0 - 3600000;
  p.decayAnchor = p.lastInteractionAt;
  p.decaySteps = 1;
  const later = T0 + 3 * 86400000;
  st.resume(p, later);
  assert.equal(p.lastTickAt, later);
  assert.equal(p.lastInteractionAt, later - 3600000, 'still an hour since she was last touched');
  assert.equal(p.decayAnchor, p.lastInteractionAt);
  assert.equal(p.decaySteps, 1, 'decay already taken is not taken again');
  const { decay } = st.tick(p, later);
  assert.equal(decay, 0);
  assert.equal(p.hunger, 40);
});
