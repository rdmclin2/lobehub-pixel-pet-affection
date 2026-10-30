'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { migratePet, affectionFromLegacy, needsMigration, cur } = require('../src/core/migrate');

const T0 = new Date('2026-01-05T10:00:00').getTime();
const legacy = (extra) => ({
  speciesId: 'grok', name: '小蓝', agentId: 'agt_OLD', topicId: 'tpc_OLD', createdAt: T0 - 86400000,
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
  const { pet: save, migrated, from } = migratePet(legacy({ xp: 300, stage: 'adult' }), T0);
  assert.equal(migrated, true);
  assert.equal(from, 1);
  assert.equal(save.schemaVersion, 3, 'schema 1 goes straight to 3');
  assert.equal(save.localAbilities, true);
  assert.deepEqual(save.legacy, { xp: 300, stage: 'adult', migratedAt: T0 });
  assert.deepEqual(Object.keys(save.characters), ['grok']);
  const pet = save.characters.grok;
  assert.equal(pet.agentId, 'agt_OLD');
  assert.equal(pet.topicId, 'tpc_OLD');
  assert.equal(pet.name, '小蓝');
  assert.equal(pet.speciesId, 'grok');
  assert.equal(pet.personaVersion, 3); // so the agent's system role is upgraded on the next turn
  assert.equal(pet.affection, 36);
  assert.equal(pet.relStage, 'close');
  assert.equal(pet.peakStage, 'close');
  assert.equal(pet.affectionDay, '2026-01-05');
  assert.deepEqual(pet.dailyCounts, {});
  assert.ok(pet.unlockedTopics.includes('whine'));
  assert.equal('xp' in pet, false);
  assert.equal('stage' in pet, false);
});

test('migration never lands in an adult stage', () => {
  const pet = cur(migratePet(legacy({ xp: 1e9, stage: 'adult' }), T0).pet);
  assert.equal(pet.affection, 50);
  assert.equal(pet.relStage, 'close');
});

test('a migrated save is not migrated again, and corrupt input yields no pet', () => {
  const { pet } = migratePet(legacy({ xp: 100, stage: 'child' }), T0);
  assert.equal(needsMigration(pet), false);
  const again = migratePet(JSON.parse(JSON.stringify(pet)), T0 + 1000);
  assert.equal(again.migrated, false);
  assert.equal(cur(again.pet).affection, cur(pet).affection);
  assert.deepEqual(again.pet.legacy, pet.legacy);
  assert.deepEqual(migratePet(null, T0), { pet: null, migrated: false, from: null, remapped: null });
  assert.deepEqual(migratePet('garbage', T0), { pet: null, migrated: false, from: null, remapped: null });
  assert.equal(migratePet({ schemaVersion: 3, speciesId: 'grok', characters: {} }, T0).pet, null, 'a save with no character');
});

// ---- schema 2 -> 3: one entry per character ------------------------------------------------------
const v2 = (extra) => ({
  schemaVersion: 2, speciesId: 'grok', name: '小蓝', agentId: 'agt_OLD', topicId: 'tpc_OLD', createdAt: T0 - 86400000,
  affection: 40, relStage: 'close', peakStage: 'close', dailyCounts: { pat: 2 }, lastAffectionAt: {}, topicsToday: ['intro'], seenUnlocks: ['topic:whine'],
  hunger: 40, mood: 60, energy: 70, sleeping: false, lastTickAt: T0, lastInteractionAt: T0, lastFedAt: T0, lastSpokeAt: 0,
  equippedOutfit: 'daily', lastSafeOutfit: 'daily', personaVersion: 6, personaKey: 'k', modelApplied: 'lobehub:grok-5', boundDeviceId: 'dev_1', touchStreak: { zone: 'head', count: 2, at: T0 },
  owner: 'me', localAbilities: true, space: { workspaceId: 'ws_1', name: 'Team' }, ...extra,
});

test('schema 2 -> 3: the agent, topic, name, affection, needs and outfit go to the current character; the owner stays on top', () => {
  const { pet, migrated, from } = migratePet(v2(), T0);
  assert.equal(migrated, true);
  assert.equal(from, 2);
  assert.equal(pet.schemaVersion, 3);
  assert.equal(pet.speciesId, 'grok');
  assert.deepEqual(pet.space, { workspaceId: 'ws_1', name: 'Team' });
  assert.equal(pet.owner, 'me');
  assert.equal(pet.localAbilities, true);
  assert.equal(pet.createdAt, T0 - 86400000);
  for (const k of ['agentId', 'topicId', 'name', 'affection', 'hunger', 'equippedOutfit', 'modelApplied']) assert.equal(k in pet, false, k);
  const c = pet.characters.grok;
  assert.equal(c.speciesId, 'grok');
  assert.equal(c.agentId, 'agt_OLD');
  assert.equal(c.topicId, 'tpc_OLD');
  assert.equal(c.name, '小蓝');
  assert.equal(c.createdAt, T0 - 86400000, 'she was met at hatch');
  assert.equal(c.affection, 40);
  assert.equal(c.relStage, 'close');
  assert.deepEqual(c.dailyCounts, { pat: 2 });
  assert.deepEqual(c.topicsToday, ['intro']);
  assert.deepEqual(c.seenUnlocks, ['topic:whine']);
  assert.equal(c.hunger, 40);
  assert.equal(c.mood, 60);
  assert.equal(c.energy, 70);
  assert.equal(c.personaVersion, 6);
  assert.equal(c.modelApplied, 'lobehub:grok-5');
  assert.equal(c.boundDeviceId, 'dev_1');
  assert.deepEqual(c.touchStreak, { zone: 'head', count: 2, at: T0 });
  assert.equal('schemaVersion' in c, false);
  assert.equal('owner' in c, false);
  assert.equal('localAbilities' in c, false);
  assert.equal(cur(pet), c);
});

test('schema 2 -> 3 with a retired character: her entry goes to the one taking over', () => {
  const { pet, remapped } = migratePet(v2({ speciesId: 'embit', equippedOutfit: 'maid' }), T0);
  assert.equal(remapped, 'embit');
  assert.equal(pet.speciesId, 'claude');
  assert.deepEqual(Object.keys(pet.characters), ['claude']);
  assert.equal(pet.characters.claude.agentId, 'agt_OLD');
  assert.deepEqual(pet.retiredFrom, { speciesId: 'embit', at: T0 });
});

test('a schema-3 save is kept as is: every entry normalized, nothing moved', () => {
  const { pet: first } = migratePet(v2(), T0);
  first.characters.claude = { speciesId: 'claude', name: '克', agentId: 'agt_C', affection: 300, equippedOutfit: 'nope' };
  const { pet, migrated } = migratePet(JSON.parse(JSON.stringify(first)), T0 + 1000);
  assert.equal(migrated, false);
  assert.equal(needsMigration(pet), false);
  assert.deepEqual(pet.characters.grok, first.characters.grok);
  assert.equal(pet.characters.claude.agentId, 'agt_C');
  assert.equal(pet.characters.claude.affection, 100, 'clamped');
  assert.equal(pet.characters.claude.equippedOutfit, 'daily');
  assert.deepEqual(pet.characters.claude.dailyCounts, {});
});

test('a schema-3 save: an entry of a retired character moves to the one taking over, or is kept aside', () => {
  const base = migratePet(v2(), T0).pet;
  const moved = migratePet({ ...base, speciesId: 'embit', characters: { ...base.characters, embit: { name: '火', agentId: 'agt_E', affection: 10 } } }, T0).pet;
  assert.equal(moved.speciesId, 'claude');
  assert.equal(moved.characters.claude.agentId, 'agt_E');
  const clash = migratePet({ ...base, characters: { ...base.characters, claude: { name: '克', agentId: 'agt_C' }, embit: { name: '火', agentId: 'agt_E' } } }, T0).pet;
  assert.equal(clash.characters.claude.agentId, 'agt_C');
  assert.equal(clash.retiredCharacters.embit.agentId, 'agt_E', 'kept so 放生 can delete its agent');
});
