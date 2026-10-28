'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const o = require('../src/core/outfits');
const st = require('../src/core/pet-state');
const { REL_STAGES } = require('../src/core/affection');
const { migratePet } = require('../src/core/migrate');

const T0 = new Date('2026-01-05T10:00:00').getTime();
const ADULT = { ageConfirmed: true, adultContent: true };
const OFF = { ageConfirmed: true, adultContent: false };
const mk = (affection, speciesId = 'testchan') => {
  const p = st.createPet({ speciesId, name: 'E', agentId: 'a', now: T0 });
  st.setAffectionForTest(p, affection);
  return p;
};

test('every stage has at least one all-ages outfit; the adult stages also have adult ones', () => {
  for (const s of REL_STAGES) assert.ok(o.OUTFITS.some((x) => x.stage === s.id && x.rating === 'all'), s.id);
  for (const id of ['flirty', 'lover']) assert.ok(o.OUTFITS.some((x) => x.stage === id && x.rating === 'adult'), id);
  assert.equal(new Set(o.OUTFIT_IDS).size, o.OUTFITS.length);
  assert.ok(o.OUTFITS.every((x) => x.rating === 'all' || ['flirty', 'lover'].includes(x.stage)), 'adult outfits only in adult stages');
});

test('Dafeiyu keeps its signature outfit name (its animated look)', () => {
  const d = o.listOutfits(mk(0, 'dafeiyu'), ADULT).find((x) => x.id === 'daily');
  assert.equal(d.label, '招牌女仆装');
});

test('a new pet wears the daily outfit; the wardrobe lists every outfit with locks and conditions', () => {
  const p = mk(0);
  assert.equal(p.equippedOutfit, 'daily');
  const list = o.listOutfits(p, ADULT);
  assert.equal(list.length, o.OUTFITS.length);
  assert.deepEqual(list.filter((x) => x.unlocked).map((x) => x.id), ['daily', 'scarf']);
  assert.equal(list.find((x) => x.id === 'daily').equipped, true);
  const pj = list.find((x) => x.id === 'pajamas');
  assert.equal(pj.locked, true);
  assert.equal(pj.condition, '亲近（♥35）解锁，还差 35');
  assert.equal(list.find((x) => x.id === 'maid').condition, '暧昧（♥60）解锁，还差 60');
});

test('only unlocked outfits can be put on', () => {
  const p = mk(20); // 熟悉
  assert.deepEqual(o.equipOutfit(p, ADULT, 'pajamas'), { ok: false, reason: 'locked', condition: '亲近（♥35）解锁，还差 15' });
  assert.equal(o.equipOutfit(p, ADULT, 'nope').reason, 'unknown');
  assert.equal(p.equippedOutfit, 'daily');
  assert.equal(o.equipOutfit(p, ADULT, 'casual').ok, true);
  assert.equal(p.equippedOutfit, 'casual');
  assert.equal(p.lastSafeOutfit, 'casual');
});

test('unlocks follow the peak stage: dropping back a stage keeps the outfit', () => {
  const p = mk(40);
  o.equipOutfit(p, OFF, 'pajamas');
  st.setAffectionForTest(p, 30); // back to 熟悉, peak stays 亲近
  assert.equal(o.checkOutfit(p, OFF, 'pajamas').ok, true);
  assert.equal(o.wornOutfit(p, OFF), 'pajamas');
});

test('adult content off: adult outfits are hidden (not locked) and the pet changes back to its last all-ages outfit', () => {
  const p = mk(90);
  o.equipOutfit(p, ADULT, 'yukata');
  o.equipOutfit(p, ADULT, 'maid');
  assert.equal(p.lastSafeOutfit, 'yukata');
  const off = o.listOutfits(p, OFF);
  assert.ok(off.every((x) => x.rating === 'all'));
  assert.equal(o.equipOutfit(p, OFF, 'retro_swimsuit').reason, 'hidden');
  assert.deepEqual(o.enforceOutfit(p, OFF), { changed: true, from: 'maid', to: 'yukata' });
  assert.equal(p.equippedOutfit, 'yukata');
  assert.equal(off.find((x) => x.id === 'yukata').stageName, '知己');
  // never confirmed 18+: the same
  assert.equal(o.listOutfits(p, { ageConfirmed: false, adultContent: true }).some((x) => x.rating === 'adult'), false);
});

test('Dafeiyu never gets adult outfits', () => {
  const p = mk(95, 'dafeiyu');
  assert.ok(o.listOutfits(p, ADULT).every((x) => x.rating === 'all'));
  assert.equal(o.equipOutfit(p, ADULT, 'maid').reason, 'unavailable', 'it has no art for it either');
});

test('a character only offers the outfits it has art for', () => {
  for (const id of ['claude', 'grok']) {
    const p = mk(95, id);
    assert.deepEqual(o.listOutfits(p, ADULT).map((x) => x.id), ['daily']);
    assert.equal(o.listOutfits(p, ADULT)[0].label, id === 'claude' ? '橘白哥特长裙' : '黑金哥特礼服', 'its signature outfit name');
    assert.equal(o.equipOutfit(p, ADULT, 'scarf').reason, 'unavailable');
    assert.equal(o.wornOutfit({ ...p, equippedOutfit: 'yukata' }, ADULT), 'daily');
  }
  assert.equal(o.listOutfits(mk(95, 'dafeiyu'), ADULT).length, 9, 'DeepSeek: 9 all-ages outfits');
});

test('stage-up unlock lists name the outfits the user can see', () => {
  const p = mk(70);
  assert.deepEqual(o.outfitsForStages(['flirty'], p, ADULT).map((x) => x.id), ['yukata', 'maid', 'offshoulder_gown']);
  assert.deepEqual(o.outfitsForStages(['flirty'], p, OFF).map((x) => x.id), ['yukata']);
});

test('"new" marks unlocked outfits beyond the first stage until they are seen', () => {
  const p = mk(20);
  assert.deepEqual(o.listOutfits(p, OFF).filter((x) => x.isNew).map((x) => x.id), ['casual', 'beret']);
  p.seenUnlocks.push('outfit:casual', 'outfit:beret');
  assert.equal(o.listOutfits(p, OFF).some((x) => x.isNew), false);
});

test('saves without an outfit (older or hand-edited) open in the daily outfit', () => {
  const { pet } = migratePet({ speciesId: 'testchan', name: 'E', agentId: 'a', xp: 300, stage: 'adult' }, T0);
  assert.equal(pet.equippedOutfit, 'daily');
  const { pet: odd } = migratePet({ ...pet, equippedOutfit: 'bikini' }, T0);
  assert.equal(odd.equippedOutfit, 'daily');
});
