'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PetService } = require('../src/main/pet-service');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { SettingsStore } = require('../src/core/settings');

// ⋯ → 角色列表 → her page: the per-character settings (model, look, unlock all) are written for the
// character whose page it is, not for the current companion; old settings.json files keep working.

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const OLD_SETTINGS = path.join(__dirname, 'fixtures', 'settings-v0.10.0.json');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petchars-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: new Date('2026-01-05T14:00:00').getTime() };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const data = path.join(dir, 'data');
  const mk = () => {
    const s = new PetService({ lh, store: new Store(data), settingsStore: new SettingsStore(data), now: () => clock.t, rnd: () => 0.5 });
    s.on('error', () => {});
    return s;
  };
  const edits = () => (fs.existsSync(path.join(dir, 'edits.log')) ? fs.readFileSync(path.join(dir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.model) : []);
  const settingsFile = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  return { dir, data, clock, svc: mk(), mk, edits, settingsFile };
}
const ch = (view, id) => view.characters.find((c) => c.id === id);
const idle = (svc) => new Promise((res) => { if (!svc.busy) return res(); const off = (b) => { if (!b) { svc.off('thinking', off); res(); } }; svc.on('thinking', off); });

test('the roster in the view carries each character\'s thumbnail, look, model and affection', async () => {
  const { svc } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  const v = svc.view();
  assert.deepEqual(v.characters.map((c) => c.id).sort(), ['claude', 'dafeiyu', 'gemini', 'gpt', 'grok']);
  for (const c of v.characters) {
    assert.ok(c.look && c.look.packId === `${c.id}-pixel`, `${c.id}: thumbnail from her default pack`);
    assert.equal(c.appearance.packId, `${c.id}-pixel`);
    assert.ok(c.appearance.options.every((o) => o.id.startsWith(`${c.id}-`)), `${c.id}: only her own packs`);
    assert.ok(c.model.options.length > 0, `${c.id}: her models`);
  }
  assert.equal(ch(v, 'claude').met.progress.value, 0);
  assert.equal(ch(v, 'claude').model.applied, 'lobehub:claude-sonnet-5-5');
  assert.equal(ch(v, 'grok').met, null, 'not met yet');
  assert.equal(ch(v, 'grok').model.applied, null, 'no agent, nothing applied');
  assert.deepEqual(ch(v, 'grok').model.options.map((o) => o.key), ['lobehub:grok-4.7'], 'only xAI models');
  assert.deepEqual(ch(v, 'gpt').model.options.map((o) => o.key), ['lobehub:gpt-6-sol', 'lobehub:gpt-6-luna', 'openai:gpt-6-luna', 'openai:o3'], 'GPT models only, own provider last');
  assert.deepEqual(v.model, ch(v, 'claude').model, 'the current character\'s model as before');
  assert.deepEqual(v.appearance, ch(v, 'claude').appearance);
});

test('setModel(key, id) writes another character\'s model under her id, filtered by her vendor', async () => {
  const { svc, edits, settingsFile } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  const before = edits().length;
  assert.equal(svc.setModel('lobehub:claude-opus-5-5', 'gpt').reason, 'unknown', 'GPT 娘 cannot pick a Claude model');
  assert.equal(svc.setModel('openai:o3', 'nobody').reason, 'unknown-character');
  const r = svc.setModel('openai:o3', 'gpt');
  assert.equal(r.ok, true);
  assert.deepEqual(settingsFile().models, { gpt: 'openai:o3' }, 'saved under gpt, nothing for claude');
  assert.equal(ch(r.view, 'gpt').model.current, 'openai:o3');
  assert.equal(ch(r.view, 'gpt').model.chosen, true);
  assert.equal(r.view.model.current, 'lobehub:claude-sonnet-5-5', 'the current companion keeps her model');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(edits().length, before, 'Claude\'s agent is not touched');

  // the current one still works without an id (as before) and is applied right away
  assert.equal(svc.setModel('lobehub:claude-opus-5-5').ok, true);
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(settingsFile().models, { gpt: 'openai:o3', claude: 'lobehub:claude-opus-5-5' });
  assert.equal(edits().at(-1).model, 'claude-opus-5-5');

  // when GPT 娘 comes, her new agent runs on the model picked on her page
  await svc.switchCharacter('gpt', { name: '小吉' });
  await idle(svc);
  const last = edits().at(-1);
  assert.equal(`${last.provider}:${last.model}`, 'openai:o3');
  assert.equal(last.agentId, svc.pet.characters.gpt.agentId);
});

test('setAppearance(pack, id) dresses that character only', async () => {
  const { svc, settingsFile } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  assert.equal(svc.setAppearance('claude-classic', 'grok').reason, 'unknown', 'not her pack');
  assert.equal(svc.setAppearance('grok-classic', 'nobody').reason, 'unknown-character');
  const r = svc.setAppearance('grok-classic', 'grok');
  assert.equal(r.ok, true);
  assert.deepEqual(settingsFile().appearance, { grok: 'grok-classic' });
  assert.equal(ch(r.view, 'grok').appearance.packId, 'grok-classic');
  assert.equal(ch(r.view, 'grok').look.packId, 'grok-classic', 'her thumbnail follows');
  assert.equal(r.view.look.packId, 'claude-pixel', 'the companion on the desktop is unchanged');
  // without an id: the current companion, as before
  assert.equal(svc.setAppearance('claude-classic').ok, true);
  assert.deepEqual(settingsFile().appearance, { grok: 'grok-classic', claude: 'claude-classic' });
  // the video look of Dafeiyu can be chosen from her page while someone else is the companion
  assert.equal(svc.setAppearance('dafeiyu-clips', 'dafeiyu').ok, true);
  assert.equal(ch(svc.view(), 'dafeiyu').look, null, 'her clips (null look)');
  await svc.switchCharacter('grok', { name: '小格' });
  assert.equal(svc.view().look.packId, 'grok-classic', 'she arrives in the look picked on her page');
});

test('unlockAll(id) fills that character\'s affection only; one not met has none to fill', async () => {
  const { svc, mk } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  await svc.switchCharacter('grok', { name: '小格' });
  await idle(svc);
  await svc.switchCharacter('claude');
  const ups = [];
  svc.on('affection', (e) => { if (e.type === 'stage-up') ups.push(e); });
  assert.deepEqual(svc.unlockAll('gemini'), { ok: false, reason: 'not-met' });
  assert.equal(svc.unlockAll('nobody').reason, 'unknown-character');
  for (const k of ['toString', '__proto__', 'constructor']) {
    assert.equal(svc.unlockAll(k).reason, 'unknown-character', k);
    assert.equal(svc.setModel('lobehub:grok-4.7', k).reason, 'unknown-character', k);
    assert.equal(svc.setAppearance('grok-classic', k).reason, 'unknown-character', k);
  }
  const r = svc.unlockAll('grok');
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  assert.equal(r.speciesId, 'grok');
  assert.equal(svc.pet.characters.grok.affection, 100);
  assert.equal(svc.pet.characters.grok.peakStage, 'lover');
  assert.equal(svc.pet.characters.claude.affection, 0, 'the companion is untouched');
  assert.equal(ch(r.view, 'grok').met.progress.next, null, 'her page shows everything unlocked');
  assert.ok(r.unlocks.topics.length > 0);
  await new Promise((res) => setImmediate(res));
  assert.equal(ups.length, 0, 'no stage-up show for someone not on the desktop');
  assert.equal(svc.unlockAll('grok').already, true);
  // kept across a restart, and she has it all when she comes back
  const again = mk();
  again.init();
  assert.equal(again.pet.characters.grok.affection, 100);
  assert.equal(again.pet.characters.claude.affection, 0);
  await again.switchCharacter('grok');
  assert.ok(again.view().outfits.filter((o) => o.rating === 'all').every((o) => o.unlocked));
});

test('regression: a settings.json from v0.10.0 keeps every character\'s model and look and the global settings', async () => {
  const { svc, mk, data, settingsFile } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  await svc.switchCharacter('grok', { name: '小格' });
  await idle(svc);
  svc.debugSet({ affection: 42 });
  const old = JSON.parse(fs.readFileSync(OLD_SETTINGS, 'utf8'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(old, null, 2));
  const pet = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));

  const s = mk();
  const v = s.init();
  await s.refreshModels({ force: true });
  const view = s.view();
  // per character: the model and the look picked before the upgrade
  assert.equal(ch(view, 'claude').model.current, 'lobehub:claude-opus-5-5');
  assert.equal(ch(view, 'gpt').model.current, 'openai:o3');
  assert.equal(ch(view, 'grok').model.current, 'lobehub:grok-4.7');
  assert.equal(ch(view, 'claude').appearance.packId, 'claude-classic');
  assert.equal(ch(view, 'grok').appearance.packId, 'grok-classic');
  assert.equal(ch(view, 'gemini').appearance.packId, 'gemini-pixel', 'no pick: her default');
  assert.equal(view.look.packId, 'grok-classic', 'the companion on the desktop wears it');
  assert.equal(v.pet.speciesId, 'grok');
  assert.equal(Math.round(ch(view, 'grok').met.affection), 42, 'affection from pet.json');
  // global settings
  const st = s.getSettings();
  assert.equal(st.petScale, 1.6);
  assert.deepEqual(st.prefs, old.prefs);
  assert.deepEqual(st.visitors, ['gemini']);
  assert.deepEqual(st.api, old.api);
  assert.deepEqual({ provider: st.tts.provider, fallback: st.tts.fallback, endpoints: st.tts.endpoints }, { provider: 'minimax', fallback: 'silent', endpoints: { fish: 'https://fish.example.com', minimax: '', local: '' } });
  // nothing is rewritten on load, and a per-character change touches only its own key
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8')).characters.claude, pet.characters.claude);
  assert.equal(s.setModel('lobehub:gemini-3.8-flash', 'gemini').ok, true);
  const after = settingsFile();
  assert.deepEqual(after.models, { ...old.models, gemini: 'lobehub:gemini-3.8-flash' });
  const { models: _m, ...restAfter } = after;
  const { models: _o, ...restOld } = old;
  // 语音包 (v0.11), 个性化设定 and the local voice server are new: an old file gets their defaults; the 18+ wording changed
  // (AGE_GATE_VERSION 2), so the old answer no longer counts and the user is asked again; everything else stays as it was
  assert.deepEqual(restAfter, { ...restOld, answered: false, systemRoles: {}, tts: { ...restOld.tts, packs: true, endpoints: { ...restOld.tts.endpoints, local: '' }, local: { api: 'openai', model: '', voice: '' } } }, 'same keys and values otherwise');
});

const roleEdits = (dir) => (fs.existsSync(path.join(dir, 'edits.log')) ? fs.readFileSync(path.join(dir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.systemRole) : []);

test('setSystemRole(text, id) saves her 个性化设定, puts it in her agent\'s system role and leaves the others alone', async () => {
  const { svc, dir, mk, settingsFile } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  await idle(svc);
  assert.equal(ch(svc.view(), 'claude').systemRole, '', 'none by default');
  const before = roleEdits(dir).length;

  // another character: saved under her id, nobody's agent is edited
  assert.equal(svc.setSystemRole('叫我老板', 'nobody').reason, 'unknown-character');
  assert.equal(svc.setSystemRole('x'.repeat(1001), 'gpt').reason, 'too-long');
  const r = svc.setSystemRole('  叫我老板\r\n说话简短\u0007  ', 'gpt');
  assert.equal(r.ok, true);
  assert.equal(ch(r.view, 'gpt').systemRole, '叫我老板\n说话简短', 'trimmed, line breaks kept, control characters dropped');
  assert.deepEqual(settingsFile().systemRoles, { gpt: '叫我老板\n说话简短' });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(roleEdits(dir).length, before, 'Claude\'s agent is not touched');

  // the current character (no id): applied to her agent right away
  assert.equal(svc.setSystemRole('你是我的前端搭子，叫我阿明。').ok, true);
  await idle(svc);
  await new Promise((res) => setTimeout(res, 300));
  const last = roleEdits(dir).at(-1).systemRole;
  assert.equal(roleEdits(dir).length, before + 1);
  assert.match(last, /主人给你的个性化设定[^\n]*\n你是我的前端搭子，叫我阿明。\n/);
  assert.ok(last.indexOf('个性化设定') < last.lastIndexOf('内容红线'), 'the content rules still come last');
  assert.doesNotMatch(last, /叫我老板/, 'only her own text');

  // kept across a restart, and not re-applied when nothing changed
  const s2 = mk();
  s2.init();
  assert.equal(ch(s2.view(), 'claude').systemRole, '你是我的前端搭子，叫我阿明。');
  await s2._ensureReady();
  assert.equal(roleEdits(dir).length, before + 1);

  // clearing removes it from settings and from her role
  assert.equal(s2.setSystemRole('').ok, true);
  await idle(s2);
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(settingsFile().systemRoles, { gpt: '叫我老板\n说话简短' });
  assert.doesNotMatch(roleEdits(dir).at(-1).systemRole, /个性化设定/);
});

test('the 18+ 成年版 look: refused without adult content; with it her wardrobe is that pack\'s, and turning adult content off takes it off', async () => {
  const { svc } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  svc.answerAgeGate(false);
  assert.ok(!svc.view().appearance.options.some((o) => o.id === 'claude-adult'), 'not listed for all-ages');
  assert.equal(svc.setAppearance('claude-adult').reason, 'adult');
  svc.answerAgeGate(true);
  assert.ok(svc.view().appearance.options.some((o) => o.id === 'claude-adult' && o.adult), 'listed, marked 18+');
  assert.equal(svc.setAppearance('claude-adult').ok, true);
  svc.unlockAll('claude');
  const v = svc.view();
  assert.equal(v.look.packId, 'claude-adult');
  assert.ok(v.outfits.some((o) => o.id === 'maid'), 'adult outfits in her wardrobe');
  assert.ok(!v.outfits.some((o) => o.id === 'swimsuit'), "her all-ages outfits belong to her usual look");
  assert.equal(svc.view().settings.adultContent, true);
  assert.deepEqual(v.topics.filter((t) => t.rating === 'adult'), [], 'the look changes no topic or tone: she is still all-ages');
  assert.equal(svc.equipOutfit('maid').ok, true);
  assert.equal(svc.view().look.packId, 'claude-adult');
  const r = svc.setAdultContent(false);
  assert.deepEqual(r.outfitChanged, { from: 'maid', to: 'daily' });
  assert.equal(r.view.look.packId, 'claude-pixel', 'back to her usual look');
  assert.ok(!r.view.outfits.some((o) => o.rating === 'adult'));
  // switching to her usual look while adult content is on also takes the adult outfit off
  svc.setAdultContent(true);
  svc.equipOutfit('maid');
  svc.setAppearance('claude-pixel');
  assert.equal(svc.view().outfit, 'daily');
});
