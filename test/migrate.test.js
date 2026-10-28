'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { migratePet, affectionFromLegacy, needsMigration } = require('../src/core/migrate');

const T0 = new Date('2026-01-05T10:00:00').getTime();
const legacy = (extra) => ({
  speciesId: 'bubbo', name: '小蓝', agentId: 'agt_OLD', topicId: 'tpc_OLD', createdAt: T0 - 86400000,
  hunger: 40, mood: 60, energy: 70, sleeping: false, lastTickAt: T0, lastInteractionAt: T0, lastFedAt: T0, lastSpokeAt: 0,
  owner: 'me', personaVersion: 3, localAbilities: true, ...extra,
});

test('xp converts to affection per the design table', () => {
  const cases = [[0, 0], [30, 7], [59, 14], [60, 15], [150, 25], [239, 34], [240, 35], [280, 36], [840, 50], [1e9, 50]];
  for (const [xp, v] of cases) assert.equal(affectionFromLegacy(xp, 'baby'), v, `xp=${xp}`);
});

test('unusable xp falls back to the stage, then to 0', () => {
  assert.equal(affectionFromLegacy(undefined, 'child'), 15);
  assert.equal(affectionFromLegacy(NaN, 'adult'), 35);
  assert.equal(affectionFromLegacy(-5, 'adult'), 35);
  assert.equal(affectionFromLegacy('12', 'baby'), 0);
  assert.equal(affectionFromLegacy(undefined, 'weird'), 0);
  assert.equal(affectionFromLegacy(undefined, undefined), 0);
});

test('xp wins when xp and stage disagree', () => {
  assert.equal(affectionFromLegacy(10, 'adult'), 2);
});

test('an old save keeps the pet, agent and topic, drops xp/stage and records them under legacy', () => {
  const { pet, migrated } = migratePet(legacy({ xp: 300, stage: 'adult' }), T0);
  assert.equal(migrated, true);
  assert.equal(pet.schemaVersion, 2);
  assert.equal(pet.agentId, 'agt_OLD');
  assert.equal(pet.topicId, 'tpc_OLD');
  assert.equal(pet.name, '小蓝');
  assert.equal(pet.speciesId, 'bubbo');
  assert.equal(pet.localAbilities, true);
  assert.equal(pet.personaVersion, 3); // so the agent's system role is upgraded on the next turn
  assert.equal(pet.affection, 36);
  assert.equal(pet.relStage, 'close');
  assert.equal(pet.peakStage, 'close');
  assert.equal(pet.affectionDay, '2026-01-05');
  assert.deepEqual(pet.dailyCounts, {});
  assert.ok(pet.unlockedTopics.includes('whine'));
  assert.equal('xp' in pet, false);
  assert.equal('stage' in pet, false);
  assert.deepEqual(pet.legacy, { xp: 300, stage: 'adult', migratedAt: T0 });
});

test('migration never lands in an adult stage', () => {
  const { pet } = migratePet(legacy({ xp: 1e9, stage: 'adult' }), T0);
  assert.equal(pet.affection, 50);
  assert.equal(pet.relStage, 'close');
});

test('a migrated save is not migrated again, and corrupt input yields no pet', () => {
  const { pet } = migratePet(legacy({ xp: 100, stage: 'child' }), T0);
  assert.equal(needsMigration(pet), false);
  const again = migratePet(JSON.parse(JSON.stringify(pet)), T0 + 1000);
  assert.equal(again.migrated, false);
  assert.equal(again.pet.affection, pet.affection);
  assert.deepEqual(again.pet.legacy, pet.legacy);
  assert.deepEqual(migratePet(null, T0), { pet: null, migrated: false });
  assert.deepEqual(migratePet('garbage', T0), { pet: null, migrated: false });
});
