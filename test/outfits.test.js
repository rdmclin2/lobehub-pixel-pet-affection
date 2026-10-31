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

test('Dafeiyu keeps its signature outfit name (her chibi maid look)', () => {
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
  const all = ['daily', 'scarf', 'casual', 'beret', 'idol', 'pajamas', 'cat_ears', 'swimsuit', 'yukata', 'bikini', 'qipao', 'couple_hoodie', 'flower_crown']; // every all-ages outfit, none of the adult ones
  const has = { dafeiyu: all, claude: all, grok: all, gemini: all, gpt: all };
  for (const id of ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']) {
    const p = mk(95, id);
    assert.deepEqual(o.listOutfits(p, ADULT).map((x) => x.id), has[id] || ['daily']);
    assert.equal(o.listOutfits(p, ADULT)[0].label, { dafeiyu: '招牌女仆装', claude: '橘白哥特长裙', grok: '黑金哥特礼服', gemini: '星纹宽袖外披', gpt: '白玫瑰立领长裙' }[id], 'its signature outfit name');
    assert.equal(o.equipOutfit(p, ADULT, 'maid').reason, 'unavailable');
    assert.equal(o.wornOutfit({ ...p, equippedOutfit: 'silk_robe' }, ADULT), 'daily');
  }
});

test('stage-up unlock lists name the outfits the user can see', () => {
  const p = mk(70);
  assert.deepEqual(o.outfitsForStages(['flirty'], p, ADULT).map((x) => x.id), ['yukata', 'bikini', 'qipao', 'maid', 'offshoulder_gown', 'office', 'nurse', 'stewardess']);
  assert.deepEqual(o.outfitsForStages(['flirty'], p, OFF).map((x) => x.id), ['yukata', 'bikini', 'qipao']);
});

test('"new" marks unlocked outfits beyond the first stage until they are seen', () => {
  const p = mk(20);
  assert.deepEqual(o.listOutfits(p, OFF).filter((x) => x.isNew).map((x) => x.id), ['casual', 'beret', 'idol']);
  p.seenUnlocks.push('outfit:casual', 'outfit:beret', 'outfit:idol');
  assert.equal(o.listOutfits(p, OFF).some((x) => x.isNew), false);
});

test('saves without an outfit (older or hand-edited) open in the daily outfit', () => {
  const { pet } = migratePet({ speciesId: 'testchan', name: 'E', agentId: 'a', xp: 300, stage: 'adult' }, T0);
  assert.equal(pet.characters.testchan.equippedOutfit, 'daily');
  const { pet: odd } = migratePet({ ...pet, characters: { testchan: { ...pet.characters.testchan, equippedOutfit: 'space_suit' } } }, T0);
  assert.equal(odd.characters.testchan.equippedOutfit, 'daily');
});

test('the swimsuit is an all-ages 亲近 outfit, separate from the adult retro swimsuit', () => {
  const sw = o.OUTFITS.find((x) => x.id === 'swimsuit');
  assert.deepEqual({ stage: sw.stage, rating: sw.rating, label: sw.label }, { stage: 'close', rating: 'all', label: '运动泳装' });
  assert.match(sw.desc, /连体泳衣.*沙滩裤.*防晒开衫/);
  const retro = o.OUTFITS.find((x) => x.id === 'retro_swimsuit');
  assert.deepEqual({ stage: retro.stage, rating: retro.rating }, { stage: 'lover', rating: 'adult' });
});

test('克洛蒂 sees the swimsuit locked until 亲近, then can put it on', () => {
  const p = mk(20, 'claude');
  const locked = o.listOutfits(p, OFF).find((x) => x.id === 'swimsuit');
  assert.deepEqual({ locked: locked.locked, condition: locked.condition }, { locked: true, condition: '亲近（♥35）解锁，还差 15' });
  assert.deepEqual(o.equipOutfit(p, OFF, 'swimsuit'), { ok: false, reason: 'locked', condition: '亲近（♥35）解锁，还差 15' });
  assert.equal(p.equippedOutfit, 'daily');
  st.setAffectionForTest(p, 40);
  assert.deepEqual(o.outfitsForStages(['close'], p, OFF).map((x) => x.id), ['pajamas', 'cat_ears', 'swimsuit'], 'named in the 亲近 stage-up notice');
  assert.equal(o.listOutfits(p, OFF).find((x) => x.id === 'swimsuit').isNew, true);
  assert.deepEqual(o.equipOutfit(p, OFF, 'swimsuit'), { ok: true, outfit: { id: 'swimsuit', label: '运动泳装' } });
  assert.equal(p.equippedOutfit, 'swimsuit');
  assert.equal(p.lastSafeOutfit, 'swimsuit', 'all-ages: the fallback when adult content goes off');
  assert.equal(o.listOutfits(p, OFF).find((x) => x.id === 'swimsuit').equipped, true);
  assert.equal(o.wornOutfit(p, OFF), 'swimsuit');
});

test('switching adult content off leaves the swimsuit on, and it is where the retro swimsuit falls back to', () => {
  const c = mk(90, 'claude');
  o.equipOutfit(c, OFF, 'swimsuit');
  for (const settings of [ADULT, OFF, { ageConfirmed: false, adultContent: true }]) {
    assert.ok(o.listOutfits(c, settings).some((x) => x.id === 'swimsuit'));
    assert.deepEqual(o.enforceOutfit(c, settings), { changed: false, from: 'swimsuit', to: 'swimsuit' });
  }
  const p = mk(90);
  o.equipOutfit(p, ADULT, 'swimsuit');
  o.equipOutfit(p, ADULT, 'retro_swimsuit');
  assert.equal(o.equipOutfit(p, OFF, 'retro_swimsuit').reason, 'hidden');
  assert.deepEqual(o.enforceOutfit(p, OFF), { changed: true, from: 'retro_swimsuit', to: 'swimsuit' });
  assert.ok(o.listOutfits(p, OFF).some((x) => x.id === 'swimsuit'));
});

test('an 18+ look (adult pack) brings its own wardrobe, adult outfits included, only with adult content on', () => {
  const look = { adult: true, outfits: ['daily', 'maid', 'bunny', 'office'] };
  const p = mk(95, 'claude');
  assert.deepEqual(o.listOutfits(p, ADULT, look).map((x) => x.id), ['daily', 'maid', 'office', 'bunny'], "the look's outfits, not her all-ages ones");
  assert.deepEqual(o.equipOutfit(p, ADULT, 'bunny', look), { ok: true, outfit: { id: 'bunny', label: '兔女郎' } });
  assert.equal(p.lastSafeOutfit, 'daily', 'an adult outfit is never the all-ages fallback');
  for (const settings of [OFF, { ageConfirmed: false, adultContent: false }]) {
    assert.deepEqual(o.listOutfits(p, settings, look).filter((x) => x.rating === 'adult'), [], 'adult content off: none listed');
    assert.equal(o.wornOutfit(p, settings, look), 'daily');
  }
  // her usual look (no 18+ pack) never shows the adult outfits, even with adult content on
  assert.deepEqual(o.listOutfits(p, ADULT).filter((x) => x.rating === 'adult'), []);
  assert.deepEqual(o.enforceOutfit(p, ADULT), { changed: true, from: 'bunny', to: 'daily' });
});
