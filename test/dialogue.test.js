'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/core/dialogue');
const st = require('../src/core/pet-state');
const { stageLines } = d;

const T0 = new Date('2026-01-05T10:00:00').getTime();
const ADULT = { ageConfirmed: true, adultContent: true };
const OFF = { ageConfirmed: true, adultContent: false };
const mk = (affection, speciesId = 'embit') => {
  const p = st.createPet({ speciesId, name: 'E', agentId: 'a', now: T0 });
  st.setAffectionForTest(p, affection);
  return p;
};

test('the content table covers every stage with tone, offline lines and topics', () => {
  for (const s of d.REL_STAGES) {
    assert.ok(d.STAGE_TONE[s.id].all, `${s.id} tone`);
    for (const kind of ['greet', 'fed', 'patted', 'played', 'bored', 'stage_up']) assert.ok(d.STAGE_LINES[s.id].all[kind].length, `${s.id}/${kind}`);
    assert.ok(d.TOPICS.some((t) => t.stage === s.id && t.rating === 'all'), `${s.id} has an all-ages topic`);
  }
  for (const id of ['flirty', 'lover']) assert.ok(d.TOPICS.some((t) => t.stage === id && t.rating === 'adult'));
  assert.equal(new Set(d.TOPIC_IDS).size, d.TOPICS.length);
  for (const t of d.TOPICS.filter((x) => x.rating === 'adult')) assert.ok(t.prompt.includes(d.KEEP_CLEAN), t.id);
});

test('locked topics come back locked with their unlock condition', () => {
  const p = mk(20); // 熟悉
  const list = d.listTopics(p, ADULT);
  const riddle = list.find((t) => t.id === 'riddle');
  assert.equal(riddle.unlocked, true);
  const whine = list.find((t) => t.id === 'whine');
  assert.equal(whine.locked, true);
  assert.equal(whine.condition, '亲近（♥35）解锁，还差 15');
  const tease = list.find((t) => t.id === 'tease');
  assert.equal(tease.locked, true);
  assert.equal(tease.condition, '暧昧（♥60）解锁，还差 40');
  const r = d.getTopic(p, ADULT, 'whine');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'locked');
  assert.match(r.condition, /亲近/);
  assert.equal(d.getTopic(p, ADULT, 'hobby').ok, true);
  assert.equal(d.getTopic(p, ADULT, 'nope').reason, 'unknown');
});

test('unlocks follow the peak stage, so a demotion keeps topics', () => {
  const p = mk(40);
  p.affection = 20;
  p.relStage = 'familiar';
  assert.equal(d.getTopic(p, ADULT, 'whine').ok, true);
});

test('with adult content off, adult topics are hidden (not locked) and all-ages alternatives remain', () => {
  const p = mk(90);
  for (const settings of [OFF, null, { ageConfirmed: false, adultContent: false }]) {
    const list = d.listTopics(p, settings);
    assert.ok(list.every((t) => t.rating === 'all'));
    assert.ok(list.some((t) => t.id === 'secret') && list.some((t) => t.id === 'promise'));
    assert.equal(list.find((t) => t.id === 'secret').stageName, '知己');
    assert.equal(d.getTopic(p, settings, 'tease').reason, 'hidden');
  }
  const on = d.listTopics(p, ADULT);
  assert.ok(on.some((t) => t.id === 'tease' && t.unlocked));
  assert.equal(on.find((t) => t.id === 'tease').stageName, '暧昧');
});

test('Dafeiyu only ever gets all-ages topics and lines', () => {
  const p = mk(90, 'dafeiyu');
  assert.ok(d.listTopics(p, ADULT).every((t) => t.rating === 'all'));
  assert.equal(d.getTopic(p, ADULT, 'sweet_talk').reason, 'hidden');
  const adultLines = d.STAGE_LINES.lover.adult.greet;
  assert.ok(stageLines(p, ADULT, 'greet').every((l) => !adultLines.includes(l)));
});

test('offline lines follow the stage, and adult lines are only offered when allowed', () => {
  const stranger = mk(0);
  assert.deepEqual(stageLines(stranger, ADULT, 'patted'), d.STAGE_LINES.stranger.all.patted);
  const lover = mk(90);
  const adultLines = d.STAGE_LINES.lover.adult.patted;
  assert.ok(stageLines(lover, ADULT, 'patted').some((l) => adultLines.includes(l)));
  assert.ok(stageLines(lover, OFF, 'patted').every((l) => !adultLines.includes(l)));
});

test('relation scope lists tone and unlocked topics for the prompt', () => {
  const r = d.relationScope(mk(40), OFF);
  assert.equal(r.stageName, '亲近');
  assert.match(r.tone, /撒娇/);
  assert.ok(r.topics.includes('撒娇模式'));
  assert.ok(!r.topics.includes('调戏一下'));
  const flirtyOff = d.relationScope(mk(70), OFF);
  assert.equal(flirtyOff.adult, false);
  assert.equal(flirtyOff.tone, d.STAGE_TONE.flirty.all);
  const flirtyOn = d.relationScope(mk(70), ADULT);
  assert.equal(flirtyOn.tone, d.STAGE_TONE.flirty.adult);
  assert.ok(flirtyOn.topics.includes('调戏一下'));
});

test('topics unlocked by a stage-up are filtered by rating', () => {
  const p = mk(60);
  assert.deepEqual(d.topicsForStages(['flirty'], p, OFF).map((t) => t.id), ['secret', 'deep_talk']);
  assert.deepEqual(d.topicsForStages(['flirty'], p, ADULT).map((t) => t.id), ['secret', 'deep_talk', 'tease', 'jealous', 'date_plan']);
});
