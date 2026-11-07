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
  // T-2764: one row per character (every look is one); 18+ looks are not listed with adult content off
  assert.deepEqual(v.characters.map((c) => c.id), ['dafeiyu-pixel', 'dafeiyu-live2d', 'dafeiyu-live', 'dafeiyu-classic', 'dafeiyu-clips', 'claude-pixel', 'claude-classic', 'grok-pixel', 'grok-classic', 'gemini-pixel', 'gemini-classic', 'gpt-pixel', 'gpt-classic']);
  for (const c of v.characters) {
    if (c.id === 'dafeiyu-clips') assert.equal(c.look, null, 'her clips: no pack look');
    else assert.ok(c.look && c.look.packId === c.id, `${c.id}: thumbnail from her own pack`);
    assert.equal(c.pack.id, c.id, `${c.id}: her one pack`);
    assert.ok(c.id.startsWith(`${c.base}-`));
    assert.ok(c.model.options.length > 0, `${c.id}: her base's models`);
  }
  assert.equal(ch(v, 'claude-pixel').met.progress.value, 0);
  assert.equal(ch(v, 'claude-classic').met.progress.value, 0, 'her other look shares her base');
  assert.equal(ch(v, 'claude-pixel').model.applied, 'lobehub:claude-sonnet-5-5');
  assert.equal(ch(v, 'grok-pixel').met, null, 'not met yet');
  assert.equal(ch(v, 'grok-pixel').model.applied, null, 'no agent, nothing applied');
  assert.deepEqual(ch(v, 'grok-classic').model.options.map((o) => o.key), ['lobehub:grok-4.7'], 'only xAI models');
  assert.deepEqual(ch(v, 'gpt-pixel').model.options.map((o) => o.key), ['lobehub:gpt-6-sol', 'lobehub:gpt-6-luna', 'openai:gpt-6-luna', 'openai:o3'], 'GPT models only, own provider last');
  assert.deepEqual(v.model, ch(v, 'claude-pixel').model, 'the current character\'s model as before');
  assert.equal(v.character.id, 'claude-pixel');
  assert.equal(ch(v, 'claude-pixel').current, true);
  assert.equal(v.appearance, undefined, 'no 形象包 picker any more');
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
  assert.equal(ch(r.view, 'gpt-pixel').model.current, 'openai:o3');
  assert.equal(ch(r.view, 'gpt-pixel').model.chosen, true);
  assert.equal(ch(r.view, 'gpt-classic').model.current, 'openai:o3', 'shared by her looks');
  assert.equal(svc.setModel('openai:o3', 'gpt-classic').ok, true, 'a character id means her base');
  assert.deepEqual(settingsFile().models, { gpt: 'openai:o3' }, 'still one key per base');
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

test('every look is a character of her own: switching to one of a base not met creates her agent once; her other looks reuse it', async () => {
  const { svc, data } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  assert.equal(typeof svc.setAppearance, 'undefined', 'there is no 形象包 choice any more');
  assert.equal((await svc.switchCharacter('nobody-pixel')).reason, 'unknown');
  const r = await svc.switchCharacter('grok-classic', { name: '小格' });
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.view.pet.characterId, 'grok-classic');
  assert.equal(r.view.look.packId, 'grok-classic', 'she arrives in her own look');
  assert.equal(ch(r.view, 'grok-classic').current, true);
  assert.equal(ch(r.view, 'grok-pixel').current, false);
  const agent = svc.pet.characters.grok.agentId;
  await idle(svc);
  const back = await svc.switchCharacter('grok-pixel');
  assert.equal(back.created, false);
  assert.equal(back.sameBase, true);
  assert.equal(svc.pet.characters.grok.agentId, agent, 'same girl, same agent');
  assert.equal(back.view.look.packId, 'grok-pixel');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8')).characterId, 'grok-pixel');
  // the video look of Dafeiyu is a character too: her clips
  assert.equal(ch(svc.view(), 'dafeiyu-clips').look, null, 'her clips (null look)');
  assert.equal(svc.lookFor('dafeiyu-clips', 'daily'), null);
  assert.equal(svc.lookFor('dafeiyu-live2d', 'daily').kind, 'live2d');
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
    assert.equal(svc.setFraming('full', k).reason, 'unknown-character', k);
  }
  const r = svc.unlockAll('grok');
  assert.equal(r.ok, true);
  assert.equal(r.already, false);
  assert.equal(r.speciesId, 'grok');
  assert.equal(svc.pet.characters.grok.affection, 100);
  assert.equal(svc.pet.characters.grok.peakStage, 'lover');
  assert.equal(svc.pet.characters.claude.affection, 0, 'the companion is untouched');
  assert.equal(ch(r.view, 'grok-pixel').met.progress.next, null, 'her page shows everything unlocked');
  assert.equal(svc.unlockAll('grok-classic').already, true, 'a character id means her base');
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
  // a pet.json as v0.10.0 wrote it: no characterId / wardrobes (T-2764)
  const pet = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
  delete pet.characterId;
  delete pet.characterModel;
  for (const c of Object.values(pet.characters)) delete c.wardrobes;
  fs.writeFileSync(path.join(data, 'pet.json'), JSON.stringify(pet, null, 2));

  const s = mk();
  const v = s.init();
  await s.refreshModels({ force: true });
  const view = s.view();
  // per character: the model and the look picked before the upgrade
  assert.equal(ch(view, 'claude-pixel').model.current, 'lobehub:claude-opus-5-5');
  assert.equal(ch(view, 'claude-classic').model.current, 'lobehub:claude-opus-5-5');
  assert.equal(ch(view, 'gpt-pixel').model.current, 'openai:o3');
  assert.equal(ch(view, 'grok-classic').model.current, 'lobehub:grok-4.7');
  // T-2764: grok + her 形象包 grok-classic → the character grok-classic
  assert.equal(v.pet.characterId, 'grok-classic');
  assert.equal(view.look.packId, 'grok-classic', 'the companion on the desktop wears it');
  assert.equal(v.pet.speciesId, 'grok');
  assert.equal(Math.round(ch(view, 'grok-classic').met.affection), 42, 'affection from pet.json');
  // global settings
  const st = s.getSettings();
  assert.equal(st.petScale, 1.6);
  assert.deepEqual(st.prefs, { ...old.prefs, muted: false, framing: 'full', danceVolume: 60 }); // 取景, 静音 and the dance volume came later: an old file shows her as before (全身, not muted)
  assert.deepEqual(st.visitors, ['gemini-pixel'], 'visitors are characters now');
  assert.deepEqual(st.legacyAppearance, old.appearance);
  assert.equal(st.characterModel, 2);
  assert.deepEqual(st.api, old.api);
  assert.deepEqual({ provider: st.tts.provider, fallback: st.tts.fallback, endpoints: st.tts.endpoints }, { provider: 'minimax', fallback: 'silent', endpoints: { fish: 'https://fish.example.com', minimax: '', elevenlabs: '', local: '' } });
  // only the migration's fields are added on load, and a per-character change touches only its own key
  const { wardrobes: _w, ...claudeAfter } = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8')).characters.claude;
  assert.deepEqual(claudeAfter, pet.characters.claude);
  assert.deepEqual(Object.keys(s.pet.characters.claude.wardrobes).sort(), ['claude-adult', 'claude-classic', 'claude-pixel'], 'her outfit copied into the wardrobe of each of her characters');
  assert.equal(s.setModel('lobehub:gemini-3.8-flash', 'gemini').ok, true);
  const after = settingsFile();
  assert.deepEqual(after.models, { ...old.models, gemini: 'lobehub:gemini-3.8-flash' });
  const { models: _m, ...restAfter } = after;
  const { models: _o, appearance: oldAppearance, ...restOld } = old;
  // 配置后台 (v0.20): 主动行为, 好感度 rules, the console theme, 硬件加速 and 自动检查更新 are new sections with their defaults
  // 小游戏 (scene): the game world's time and weather, with their defaults
  // 桌面壁纸 (wallpaper, docs/wallpaper-mode.md): off, with its defaults
  const { proactive, interject, affectionRules, ui, system, update, music, scene, wallpaper } = require('../src/core/settings').normalizeSettings(null);
  const newSections = { proactive, interject, affectionRules, ui, system, update, music, scene, wallpaper }; // 插个嘴 (interject) arrives switched off; 音乐创作 (music, T-5088) at its defaults
  // AI 可读的文件夹 (T-5075): her 本机能力 was off, so the list starts strict (no folder, no commands)
  newSections.local = { folders: [], allowCommands: false, asked: [] };
  // 取景 (半身模式): no per-character framings, prefs.framing 'full' (she looks as before); 静音 off
  // 语音包 (v0.11), 个性化设定, the local voice server and 语音输入 (asr, off) and the VRM postures are new: an old file gets their defaults; the 18+ wording changed
  // (AGE_GATE_VERSION 2), so the old answer no longer counts and the user is asked again; everything else stays as it was
  assert.deepEqual(restAfter, { ...restOld, answered: false, systemRoles: {}, framings: {}, prefs: { ...restOld.prefs, muted: false, framing: 'full', danceVolume: 60 }, tts: { ...restOld.tts, packs: true, voicePack: 'auto', voicePackByCharacter: {}, endpoints: { ...restOld.tts.endpoints, elevenlabs: '', local: '' }, local: { api: 'openai', model: '', voice: '' }, elevenlabs: { voiceId: '', modelId: 'eleven_multilingual_v2' } }, asr: require('../src/core/asr').ASR_DEFAULTS, vrmPostures: {}, ...newSections, visitors: ['gemini-pixel'], legacyAppearance: oldAppearance, characterModel: 2 }, 'same keys and values otherwise (appearance → characters, T-2764)');
});

const roleEdits = (dir) => (fs.existsSync(path.join(dir, 'edits.log')) ? fs.readFileSync(path.join(dir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.systemRole) : []);

test('setSystemRole(text, id) saves her 个性化设定, puts it in her agent\'s system role and leaves the others alone', async () => {
  const { svc, dir, mk, settingsFile } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  await idle(svc);
  assert.equal(ch(svc.view(), 'claude-pixel').systemRole, '', 'none by default');
  const before = roleEdits(dir).length;

  // another character: saved under her id, nobody's agent is edited
  assert.equal(svc.setSystemRole('叫我老板', 'nobody').reason, 'unknown-character');
  assert.equal(svc.setSystemRole('x'.repeat(1001), 'gpt').reason, 'too-long');
  const r = svc.setSystemRole('  叫我老板\r\n说话简短\u0007  ', 'gpt');
  assert.equal(r.ok, true);
  assert.equal(ch(r.view, 'gpt-pixel').systemRole, '叫我老板\n说话简短', 'trimmed, line breaks kept, control characters dropped');
  assert.equal(ch(r.view, 'gpt-classic').systemRole, '叫我老板\n说话简短', 'shared by her looks');
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
  assert.equal(ch(s2.view(), 'claude-pixel').systemRole, '你是我的前端搭子，叫我阿明。');
  await s2._ensureReady();
  assert.equal(roleEdits(dir).length, before + 1);

  // clearing removes it from settings and from her role
  assert.equal(s2.setSystemRole('').ok, true);
  await idle(s2);
  await new Promise((res) => setTimeout(res, 300));
  assert.deepEqual(settingsFile().systemRoles, { gpt: '叫我老板\n说话简短' });
  assert.doesNotMatch(roleEdits(dir).at(-1).systemRole, /个性化设定/);
});

test('the 18+ 成年版 look is a character of her own: refused without adult content; with it her wardrobe is that pack\'s; adult content off shows her usual look', async () => {
  const { svc } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  svc.answerAgeGate(false);
  assert.ok(!svc.view().characters.some((o) => o.id === 'claude-adult'), 'not listed for all-ages');
  assert.equal((await svc.switchCharacter('claude-adult')).reason, 'adult');
  // T-2787: while she is busy (an agent sync, a reply) the refusal still names the real reason, not 'busy'
  svc.busy = true;
  assert.deepEqual(await svc.switchCharacter('claude-adult'), { ok: false, reason: 'adult' });
  assert.deepEqual(await svc.switchCharacter('no-such-character'), { ok: false, reason: 'unknown' });
  assert.equal((await svc.switchCharacter('claude-classic')).reason, 'busy', 'an allowed switch still waits while busy');
  svc.busy = false;
  svc.answerAgeGate(true);
  assert.ok(svc.view().characters.some((o) => o.id === 'claude-adult' && o.adult && o.base === 'claude'), 'listed, marked 18+');
  assert.equal((await svc.switchCharacter('claude-adult')).ok, true);
  svc.unlockAll('claude');
  const v = svc.view();
  assert.equal(v.look.packId, 'claude-adult');
  assert.equal(v.character.name, '克洛蒂 · 成年版（18+）');
  assert.ok(v.outfits.some((o) => o.id === 'maid'), 'adult outfits in her wardrobe');
  assert.ok(!v.outfits.some((o) => o.id === 'swimsuit'), "her all-ages outfits belong to her usual look");
  assert.equal(svc.view().settings.adultContent, true);
  assert.deepEqual(v.topics.filter((t) => t.rating === 'adult'), [], 'the look changes no topic or tone: she is still all-ages');
  assert.equal(svc.equipOutfit('maid').ok, true);
  assert.equal(svc.view().look.packId, 'claude-adult');
  const r = svc.setAdultContent(false);
  assert.equal(r.view.look.packId, 'claude-pixel', 'back to her usual look');
  assert.equal(r.view.pet.characterId, 'claude-pixel');
  assert.equal(r.view.outfit, 'daily', 'her pixel self never wore the adult outfit');
  assert.ok(!r.view.outfits.some((o) => o.rating === 'adult'));
  assert.equal(svc.pet.characterId, 'claude-adult', 'the choice is kept for when it can be shown again');
  // adult content on again: she is her 18+ self again, in what she wore there
  svc.setAdultContent(true);
  assert.equal(svc.view().look.packId, 'claude-adult');
  assert.equal(svc.view().outfit, 'maid');
  // her usual look has a wardrobe of her own
  await svc.switchCharacter('claude-pixel');
  assert.equal(svc.view().outfit, 'daily');
  assert.equal(svc.pet.characters.claude.wardrobes['claude-adult'].equippedOutfit, 'maid');
});
