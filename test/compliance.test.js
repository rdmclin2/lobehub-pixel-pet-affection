'use strict';
// Design 8.1: no growth stages / minor or infant framing in anything shown to the user or sent to the agent.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..', 'src');
// Display and prompt sources. lh-client / lh-path / local-device are CLI plumbing ("child process").
const FILES = ['core/persona.js', 'core/species.js', 'core/dialogue.js', 'core/affection.js', 'core/proactive.js', 'core/pet-state.js', 'core/migrate.js', 'core/outfits.js', 'main/pet-service.js', 'renderer/app.js', 'renderer/index.html', 'renderer/fx.js', 'renderer/style.css', 'core/fx.js', 'core/time-context.js', 'core/touch-zones.js', ...fs.readdirSync(path.join(ROOT, 'characters')).map((f) => `characters/${f}`)];
const BANNED = /幼崽|少年|少女|萝莉|正太|宝宝|校服|\bbaby\b|\bchild\b|成长阶段|成长进化|破壳|孵化|[一二三四火水草鲸]之?蛋|擦边/;

test('no growth stage or minor framing in display or prompt sources', () => {
  for (const f of FILES) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      // migrate.js reads legacy save values ('baby' / 'child') to convert them; that is data, not display.
      if (f === 'core/migrate.js' && /baby: 0, child: 15/.test(line)) return;
      assert.doesNotMatch(line, BANNED, `${f}:${i + 1}: ${line.trim()}`);
    });
  }
});

test('"未成年" and "学生" only appear inside the refusal rules of the system role', () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const hits = src.split('\n').filter((l) => /未成年|学生/.test(l));
    for (const l of hits) assert.match(l, /一律拒绝/, `${f}: ${l.trim()}`);
  }
});

test('every species persona states an adult age', () => {
  const { SPECIES } = require('../src/core/species');
  for (const sp of Object.values(SPECIES)) assert.match(sp.personality, /成年.*设定年龄 25 岁以上/, sp.id);
});

test('with adult content off, no adult line, topic, outfit or tone reaches the user or the agent', () => {
  const st = require('../src/core/pet-state');
  const dialogue = require('../src/core/dialogue');
  const outfits = require('../src/core/outfits');
  const persona = require('../src/core/persona');
  const adultTone = Object.values(dialogue.STAGE_TONE).map((t) => t.adult).filter(Boolean);
  const adultLines = Object.values(dialogue.STAGE_LINES).flatMap((t) => Object.values(t.adult || {}).flat());
  const adultTopics = dialogue.TOPICS.filter((t) => t.rating === 'adult');
  const kinds = ['greet', 'fed', 'patted', 'played', 'bored', 'stage_up'];
  for (const settings of [null, { ageConfirmed: false, adultContent: false }, { ageConfirmed: true, adultContent: false }]) {
    for (const aff of [0, 20, 40, 70, 95]) {
      const pet = st.createPet({ speciesId: 'testchan', name: 'T', agentId: 'a', now: 0 });
      st.setAffectionForTest(pet, aff);
      const role = persona.buildSystemRole({ speciesId: 'testchan', name: 'T', pet, settings });
      const block = persona.buildStateBlock(pet, 0, settings);
      for (const tone of adultTone) assert.ok(!role.includes(tone) && !block.includes(tone), `adult tone leaked at ♥${aff}`);
      for (const t of adultTopics) assert.ok(!role.includes(t.label) && !block.includes(t.label), `adult topic ${t.label} leaked at ♥${aff}`);
      assert.doesNotMatch(role + block, /阶段=(暧昧|恋人)/);
      for (const k of kinds) for (const l of dialogue.stageLines(pet, settings, k)) assert.ok(!adultLines.includes(l), `adult line ${l}`);
      assert.deepEqual(dialogue.listTopics(pet, settings).filter((t) => t.rating === 'adult'), []);
      assert.deepEqual(outfits.listOutfits(pet, settings).filter((o) => o.rating === 'adult'), []);
      assert.equal(outfits.checkOutfit({ ...pet, peakStage: 'lover' }, settings, 'maid').reason, 'hidden');
    }
  }
});

test('Dafeiyu (community character, chibi art) never gets adult content, even with adult content on', () => {
  const st = require('../src/core/pet-state');
  const dialogue = require('../src/core/dialogue');
  const outfits = require('../src/core/outfits');
  const settings = { ageConfirmed: true, adultContent: true };
  const pet = st.createPet({ speciesId: 'dafeiyu', name: 'D', agentId: 'a', now: 0 });
  st.setAffectionForTest(pet, 95);
  assert.equal(dialogue.relationScope(pet, settings).adult, false);
  assert.deepEqual(dialogue.listTopics(pet, settings).filter((t) => t.rating === 'adult'), []);
  assert.deepEqual(outfits.listOutfits(pet, settings).filter((o) => o.rating === 'adult'), []);
});
