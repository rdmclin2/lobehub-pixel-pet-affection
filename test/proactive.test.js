'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const { nextEvent, LlmBudget, fallbackLine } = require('../src/core/proactive');
const st = require('../src/core/pet-state');
const { getSpecies } = require('../src/core/species');

const T0 = new Date('2026-01-05T14:00:00').getTime();
const MIN = 60000;
const mk = () => st.createPet({ speciesId: 'testchan', name: 'E', agentId: 'a', now: T0 });

test('stays quiet while asleep or inside the cooldown', () => {
  const p = mk();
  p.hunger = 90;
  p.sleeping = true;
  assert.equal(nextEvent(p, T0), null);
  p.sleeping = false;
  p.lastSpokeAt = T0 - 2 * MIN;
  assert.equal(nextEvent(p, T0), null);
});

test('asks for food when hungry', () => {
  const p = mk();
  p.hunger = 90;
  assert.equal(nextEvent(p, T0), 'hungry');
});

test('gets bored after a long silence (deterministic rng)', () => {
  const p = mk();
  p.lastInteractionAt = T0 - 60 * MIN;
  assert.equal(nextEvent(p, T0, {}, () => 0.1), 'bored');
  assert.equal(nextEvent(p, T0, {}, () => 0.9), null);
});

test('greets once per day in the morning', () => {
  const p = mk();
  const morning = new Date('2026-01-05T08:00:00').getTime();
  assert.equal(nextEvent(p, morning), 'greet_morning');
  p.lastGreetDay = new Date(morning).toDateString();
  assert.equal(nextEvent(p, morning), null);
});

test('LLM budget caps calls per hour and recovers', () => {
  const b = new LlmBudget(2);
  assert.ok(b.canSpend(T0)); b.spend(T0);
  assert.ok(b.canSpend(T0)); b.spend(T0);
  assert.equal(b.canSpend(T0 + MIN), false);
  assert.equal(b.canSpend(T0 + 61 * MIN), true);
});

test('every species has fallback lines for every event kind', () => {
  for (const id of ['testchan', 'grok', 'claude', 'dafeiyu']) {
    for (const kind of ['hungry', 'bored', 'greet_morning', 'greet_evening', 'stage_up', 'met', 'missed', 'fed', 'patted', 'played']) {
      assert.ok(fallbackLine(getSpecies(id), kind).length > 0, `${id}/${kind}`);
    }
  }
});
