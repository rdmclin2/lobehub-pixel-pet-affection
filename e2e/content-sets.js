'use strict';
// Content inventory and adult-on / adult-off comparison for the compliance review
// (docs/compliance-review.md). Pure data: reads the shipped tables and the same filters the app uses.
// Run: node e2e/content-sets.js > out/e2e/content-sets.txt
const dialogue = require('../src/core/dialogue');
const outfits = require('../src/core/outfits');
const persona = require('../src/core/persona');
const st = require('../src/core/pet-state');
const { SPECIES } = require('../src/core/species');
const { checkReply } = require('../src/core/content-guard');

const p = (...a) => console.log(...a);
const tones = Object.entries(dialogue.STAGE_TONE).flatMap(([s, t]) => Object.entries(t).map(([r, v]) => ({ s, r, v })));
const lines = Object.entries(dialogue.STAGE_LINES).flatMap(([s, t]) => Object.entries(t).flatMap(([r, kinds]) => Object.entries(kinds).flatMap(([k, ls]) => ls.map((l) => ({ s, r, k, l })))));
const speciesLines = Object.values(SPECIES).flatMap((sp) => Object.values(sp.fallback).flat());
p('# 1. Inventory (what the review covers)');
p(`stage tone entries:        ${tones.length} (all ${tones.filter((t) => t.r === 'all').length}, adult ${tones.filter((t) => t.r === 'adult').length})`);
p(`stage offline lines:       ${lines.length} (all ${lines.filter((l) => l.r === 'all').length}, adult ${lines.filter((l) => l.r === 'adult').length})`);
p(`topics (label+prompt+fallback): ${dialogue.TOPICS.length} (all ${dialogue.TOPICS.filter((t) => t.rating === 'all').length}, adult ${dialogue.TOPICS.filter((t) => t.rating === 'adult').length})`);
p(`outfits (name+desc+art):   ${outfits.OUTFITS.length} (all ${outfits.OUTFITS.filter((o) => o.rating === 'all').length}, adult ${outfits.OUTFITS.filter((o) => o.rating === 'adult').length}); pictures ${Object.keys(SPECIES).length} companions x their outfits (src/renderer/packs)`);
p(`species personas:          ${Object.keys(SPECIES).length}; species fallback lines ${speciesLines.length}`);
p(`system-role content rules: ${persona.CONTENT_RULES.split('\n').length - 1}; event hints ${Object.keys(persona.EVENT_HINT).length}`);
const all = [...tones.map((t) => t.v), ...lines.map((l) => l.l), ...dialogue.TOPICS.flatMap((t) => [t.label, t.prompt, ...t.fallback]), ...outfits.OUTFITS.flatMap((o) => [o.label, o.desc]), ...speciesLines, ...Object.values(SPECIES).map((s) => s.personality)];
p(`content guard over every shipped string (${all.length}): ${all.filter((x) => !checkReply(x).ok).length} blocked`);

for (const [label, settings] of [['ON (18+ confirmed, adult content on)', { ageConfirmed: true, adultContent: true }], ['OFF (18+ confirmed, adult content off)', { ageConfirmed: true, adultContent: false }], ['OFF (under 18 / all ages only)', { ageConfirmed: false, adultContent: false }]]) {
  const pet = st.createPet({ speciesId: 'grok', name: 'T', agentId: 'a', now: 0 });
  st.setAffectionForTest(pet, 95); // highest stage: everything unlocked
  const scope = dialogue.relationScope(pet, settings);
  const pool = ['greet', 'fed', 'patted', 'played', 'bored', 'stage_up'].flatMap((k) => dialogue.stageLines(pet, settings, k));
  p(`\n# 2. Adult content ${label} · 格萝可 ♥95 (all stages unlocked)`);
  p(`stage shown: ${scope.stageName}; tone sent to agent: ${scope.tone}`);
  p(`topics (${dialogue.listTopics(pet, settings).length}): ${dialogue.listTopics(pet, settings).map((t) => `${t.label}${t.rating === 'adult' ? '[成人向]' : ''}`).join('、')}`);
  p(`outfits (${outfits.listOutfits(pet, settings).length}): ${outfits.listOutfits(pet, settings).map((o) => `${o.label}${o.rating === 'adult' ? '[成人向]' : ''}`).join('、')}`);
  p(`offline lines at 恋人 stage (${pool.length}): ${pool.join(' / ')}`);
  p(`equip maid -> ${JSON.stringify(outfits.checkOutfit(pet, settings, 'maid').ok ? 'ok' : outfits.checkOutfit(pet, settings, 'maid').reason)}; topic tease -> ${dialogue.getTopic(pet, settings, 'tease').ok ? 'ok' : dialogue.getTopic(pet, settings, 'tease').reason}`);
  p(`system role mentions adult topics: ${dialogue.TOPICS.filter((t) => t.rating === 'adult' && persona.buildSystemRole({ speciesId: 'grok', name: 'T', pet, settings }).includes(t.label)).map((t) => t.label).join('、') || '(none)'}`);
}
