'use strict';
// The character registry (src/characters/*.json) and the time background added to every message.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../src/core/species');
const { describeTime, timeContext } = require('../src/core/time-context');
const { buildStateBlock } = require('../src/core/persona');
const st = require('../src/core/pet-state');

test('every shipped character is a model-chan with a vendor, theme colour, lines and credits, and none allows adult content', () => {
  assert.deepEqual(S.SPECIES_IDS, ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']);
  assert.deepEqual(S.SPECIES_IDS.map((id) => S.SPECIES[id].vendor), ['DeepSeek', 'Anthropic', 'xAI', 'Google', 'OpenAI']);
  for (const sp of Object.values(S.SPECIES)) {
    assert.deepEqual(S.validateCharacter({ ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', `${sp.id}.json`), 'utf8')) }), []);
    assert.equal(sp.adult, false, `${sp.id} is all-ages`);
    assert.match(sp.blurb, /非.*官方/, `${sp.id} says it is not official`);
    assert.match(sp.personality, /成年.*设定年龄 18 岁/);
    assert.ok(sp.credits.length > 0);
  }
});

test('retired characters (焰团 / 泡鲸 / 叶芽) and unknown ids resolve to a current character', () => {
  assert.equal(S.resolveSpeciesId('claude'), 'claude');
  assert.equal(S.resolveSpeciesId('bubbo'), 'dafeiyu');
  assert.equal(S.resolveSpeciesId('embit'), 'claude');
  assert.equal(S.resolveSpeciesId('sprig'), 'dafeiyu');
  assert.equal(S.resolveSpeciesId('nobody'), S.DEFAULT_SPECIES);
  assert.equal(S.resolveSpeciesId(undefined), S.DEFAULT_SPECIES);
  for (const id of Object.keys(S.RETIRED)) assert.equal(S.SPECIES[id], undefined, `${id} is gone`);
});

test('a broken character file is refused with reasons', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chars-'));
  fs.writeFileSync(path.join(dir, 'x1.json'), JSON.stringify({ id: 'x1', vendor: 'V', accent: 'red', adult: 'no', outfits: ['scarf'], art: { kind: 'gif' } }));
  assert.throws(() => S.loadCharacters(dir), /accent must be.*adult must be.*outfits must list.*art\.kind/s);
  assert.match(S.validateCharacter({ ...S.SPECIES.claude, id: 'bubbo' }).join(), /retired/);
});

test('the time background names the part of the day, the weekday and fixed-date festivals', () => {
  assert.equal(describeTime(new Date('2026-10-31T21:30:00')), '晚上，星期六，周末，今天是万圣夜');
  assert.equal(describeTime(new Date('2026-10-29T08:00:00')), '早上，星期四，工作日');
  assert.equal(timeContext(new Date('2026-12-25T02:00:00')).slot, '凌晨');
  assert.equal(timeContext(new Date('2026-12-25T23:30:00')).slot, '深夜');
  const now = new Date('2026-12-25T12:10:00').getTime();
  const pet = st.createPet({ speciesId: 'grok', name: 'G', agentId: 'a', now });
  assert.match(buildStateBlock(pet, now), /现在12:10（中午，星期五，工作日，今天是圣诞节）/);
});
