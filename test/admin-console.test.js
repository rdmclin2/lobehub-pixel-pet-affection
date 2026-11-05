'use strict';
// 配置后台 (admin console): the settings schema, admin-set / admin-reset over the real settings store, the
// new runtime settings (主动行为, 好感度, 外观主题, 硬件加速), the roster data, the broadcast to both windows,
// the settings window (single instance, isolated) and its preload whitelist.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const settingsLib = require('../src/core/settings');
const schema = require('../src/core/settings-schema');
const affection = require('../src/core/affection');
const { buildRoster, packRows } = require('../src/core/roster');
const { loadPacks } = require('../src/core/packs');
const { createAdminSettings } = require('../src/main/admin-settings');
const { createBroadcast } = require('../src/main/broadcast');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');

function setup({ hatch = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const data = path.join(dir, 'data');
  const clock = { t: new Date('2026-01-05T14:00:00').getTime() };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const mk = () => {
    const s = new PetService({ lh, store: new Store(data), settingsStore: new settingsLib.SettingsStore(data), now: () => clock.t, rnd: () => 0.5 });
    s.on('error', () => {});
    return s;
  };
  const svc = mk();
  const events = [];
  svc.on('settings', (st) => events.push(st));
  const hooks = { calls: [], keys: {} };
  const admin = createAdminSettings({
    service: svc,
    hooks: {
      resizePet: (k) => { hooks.calls.push(['resizePet', k]); return k; },
      afterPrefs: (p) => hooks.calls.push(['afterPrefs', p.voice]),
      beforeTts: () => hooks.calls.push(['beforeTts']),
      afterApi: async () => hooks.calls.push(['afterApi']),
      setKey: (id, v) => { hooks.keys[id] = v; return true; },
    },
  });
  const file = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  return { dir, data, clock, lh, svc, mk, admin, events, hooks, file, ready: hatch ? svc.hatch({ speciesId: 'grok', name: '小格' }) : Promise.resolve() };
}

test.afterEach(() => affection.setRules({})); // the affection rules are process-wide

// ---- schema -------------------------------------------------------------------------------------------------

test('schema: every settings.json leaf key has a field, on a page the console has, with the default from normalizeSettings(null)', () => {
  const keys = new Set(schema.FIELDS.map((f) => f.key));
  const leaves = schema.settingsLeaves();
  assert.deepEqual(leaves.filter((k) => !keys.has(k)), [], 'missing from the console');
  assert.ok(leaves.length >= 50, `${leaves.length} leaves`);
  const pages = new Set([...Object.keys(schema.PAGES), 'character']);
  const navPages = schema.NAV.flatMap((g) => g.items.map((i) => i.page));
  assert.deepEqual(navPages.filter((p) => !schema.PAGES[p]), []);
  assert.equal(navPages.length, 22, '22 pages under 6 rail places (docs §6.3; 话题 / 聊天记录 / 桌面上的她 since T-2718; 聊天 since T-2765; 商店 since the download catalog; 舞蹈 since T-2801; 音乐创作 since T-5088)');
  assert.deepEqual(schema.RAIL.map((r) => r.key), ['home', 'characters', 'store', 'play', 'settings', 'chat'], 'the rail holds six places (four + 商店 + 聊天, R-05), not every page');
  assert.ok(schema.NAV.every((g) => schema.RAIL.some((r) => r.key === g.section)), 'every group sits under a rail place');
  for (const r of schema.RAIL) assert.ok(schema.PAGES[r.page], r.page);
  for (const f of schema.FIELDS) {
    assert.ok(pages.has(f.page), `${f.key} → ${f.page}`);
    assert.ok(f.label && f.card, f.key);
    if (f.store === 'settings' && !f.key.includes('<id>')) assert.deepEqual(f.default, schema.at(settingsLib.normalizeSettings(null), f.key), f.key);
  }
  // sensitive ones are masked / write-only
  assert.deepEqual(schema.FIELDS.filter((f) => f.sensitive).map((f) => f.key).sort(), ['api.token', 'keys.asrlocal', 'keys.elevenlabs', 'keys.fal', 'keys.fish', 'keys.local', 'keys.minimax']);
  assert.deepEqual(schema.FIELDS.filter((f) => f.restart).map((f) => f.key), ['system.hardwareAcceleration']);
  // describe() is plain data for the window
  const d = JSON.parse(JSON.stringify(schema.describe()));
  assert.equal(d.fields.length, schema.FIELDS.length);
});

test('T-2787: no 形象包 wording left in the console copy (every look is a character of her own since T-2764)', () => {
  // page titles / descriptions, nav, every field's label, card, description and option labels as the console shows them
  const texts = [
    ...Object.entries(schema.PAGES).flatMap(([k, p]) => [`${k}: ${p.title}`, `${k}: ${p.description || ''}`]),
    ...schema.NAV.flatMap((g) => [g.label || '', ...g.items.map((i) => `${i.page}: ${i.label || ''}`)]),
    ...schema.RAIL.map((r) => `${r.key}: ${r.label || ''}`),
    ...schema.FIELDS.flatMap((f) => [`${f.key}: ${f.label}`, `${f.key}: ${f.card}`, `${f.key}: ${f.desc || ''}`, ...(f.options || []).map((o) => `${f.key}: ${o.label || ''}`)]),
  ];
  assert.ok(texts.length > 100, `${texts.length} strings`);
  assert.deepEqual(texts.filter((t) => /形象包|跟随形象包|set-appearance|setAppearance/.test(t)), []);
  // the pages that used to say it now speak of characters, outfits and 角色包
  assert.match(schema.PAGES.characters.description, /给她换衣服/);
  assert.match(schema.field('prefs.framing').desc, /角色包也可以自带默认取景/);
  assert.match(schema.field('characterModel').desc, /每套形象成为一位独立角色/);
});

test('schema.validate: types, ranges, options, URLs and read-only items', () => {
  assert.deepEqual(schema.validate('prefs.roam', false), { ok: true, value: false });
  assert.equal(schema.validate('prefs.roam', 'no').reason, 'type');
  assert.equal(schema.validate('petScale', 3).reason, 'range');
  assert.equal(schema.validate('petScale', 1.234).value, 1.23);
  assert.equal(schema.validate('proactive.speakCooldownMin', 999).reason, 'range');
  assert.equal(schema.validate('proactive.speakCooldownMin', 12.5).reason, 'type');
  assert.equal(schema.validate('proactive.speakCooldownMin', '20').value, 20);
  assert.equal(schema.validate('tts.provider', 'bogus').reason, 'option');
  assert.equal(schema.validate('ui.theme', 'dark').ok, true);
  assert.equal(schema.validate('tts.endpoints.fish', 'http://fish.example.com').reason, 'bad-endpoint');
  assert.equal(schema.validate('tts.endpoints.fish', 'https://fish.example.com').ok, true);
  assert.equal(schema.validate('tts.endpoints.local', 'http://192.168.1.5:9000').ok, true);
  assert.equal(schema.validate('asr.local.endpoint', 'http://user:pw@127.0.0.1:8179').reason, 'bad-endpoint');
  assert.equal(schema.validate('asr.local.model', 'bad model!').reason, 'pattern');
  assert.equal(schema.validate('tts.local.voice', 'x'.repeat(81)).reason, 'too-long');
  assert.equal(schema.validate('visitors', ['a', 'b', 'c', 'd']).reason, 'range');
  for (const k of ['ageConfirmed', 'answered', 'api.token', 'adultContent', 'petScaleSet', 'nope']) assert.equal(schema.validate(k, true).ok, false, k);
});

test('schema.patchFor routes each key to the existing PetService setter', () => {
  assert.deepEqual(schema.patchFor('prefs.voice', true), { setter: 'setPrefs', patch: { voice: true } });
  assert.deepEqual(schema.patchFor('tts.local.model', 'm'), { setter: 'setTts', patch: { local: { model: 'm' } } });
  assert.deepEqual(schema.patchFor('asr.lobehub.model', 'gpt-4o-transcribe'), { setter: 'setAsr', patch: { lobehub: { model: 'gpt-4o-transcribe' } } });
  assert.deepEqual(schema.patchFor('api.port', 8000), { setter: 'setApi', patch: { port: 8000 } });
  assert.deepEqual(schema.patchFor('proactive.hungryAt', 80), { setter: 'setSection', section: 'proactive', patch: { hungryAt: 80 } });
  assert.deepEqual(schema.patchFor('petScale', 1.5), { setter: 'setPetScale', patch: 1.5 });
});

test('new settings: 主动行为 / 好感度 / 外观主题 / 硬件加速 have defaults, ranges and survive normalisation', () => {
  const d = settingsLib.normalizeSettings(null);
  assert.deepEqual(d.proactive, { enabled: true, speakCooldownMin: 12, boredAfterMin: 45, hungryAt: 75, maxLlmPerHour: 6 });
  assert.deepEqual(d.proactive, { enabled: true, ...require('../src/core/proactive').DEFAULTS }, 'the old constants are the defaults');
  assert.deepEqual(d.affectionRules, { decay: true, dailyCap: affection.DAILY_CAP });
  assert.deepEqual(d.ui, { theme: 'auto' });
  assert.deepEqual(d.system, { hardwareAcceleration: true });
  const bad = settingsLib.normalizeSettings({ proactive: { enabled: 'x', speakCooldownMin: 1, hungryAt: 101, maxLlmPerHour: 0 }, affectionRules: { dailyCap: 99, decay: 0 }, ui: { theme: 'neon' }, system: { hardwareAcceleration: 'no' } });
  assert.deepEqual(bad.proactive, { enabled: true, speakCooldownMin: 12, boredAfterMin: 45, hungryAt: 75, maxLlmPerHour: 0 });
  assert.deepEqual(bad.affectionRules, { decay: true, dailyCap: 12 });
  assert.equal(bad.ui.theme, 'auto');
  assert.equal(bad.system.hardwareAcceleration, true);
});

// ---- admin-set / admin-reset ---------------------------------------------------------------------------------

test('admin-set saves through SettingsStore (settings.json), emits `settings` once, and reports the saved value', async () => {
  const { admin, events, file, hooks, svc } = setup();
  const r = await admin.set('prefs.roam', false);
  assert.equal(r.ok, true);
  assert.equal(r.value, false);
  assert.equal(file().prefs.roam, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].prefs.roam, false);
  assert.deepEqual(hooks.calls, [['afterPrefs', false]]);
  // nested keys
  assert.equal((await admin.set('tts.local.api', 'whale')).ok, true);
  assert.equal(file().tts.local.api, 'whale');
  assert.equal((await admin.set('asr.local.timeoutSec', 45)).ok, true);
  assert.equal(file().asr.local.timeoutSec, 45);
  assert.equal((await admin.set('asr.maxSeconds', 90)).ok, true);
  assert.equal(file().asr.maxSeconds, 90);
  assert.equal((await admin.set('petScale', 1.5)).value, 1.5);
  assert.deepEqual(hooks.calls.at(-1), ['resizePet', 1.5]);
  assert.equal(file().petScaleSet, true);
  assert.equal((await admin.set('ui.theme', 'dark')).ok, true);
  assert.equal(svc.settings.ui.theme, 'dark');
  // a reload (the next start) reads the same file
  assert.equal(new settingsLib.SettingsStore(path.dirname(svc.settingsStore.file)).load().ui.theme, 'dark');
});

test('admin-set refuses bad values before anything is saved, with the reason in words', async () => {
  const { admin, events, data } = setup();
  for (const [k, v] of [['petScale', 9], ['tts.endpoints.minimax', 'http://x.example.com'], ['proactive.maxLlmPerHour', 31], ['ageConfirmed', true], ['api.token', 'x'.repeat(30)], ['nope', 1]]) {
    const r = await admin.set(k, v);
    assert.equal(r.ok, false, k);
    assert.ok(r.message, `${k} has a message`);
  }
  assert.equal(events.length, 0);
  assert.equal(fs.existsSync(path.join(data, 'settings.json')), false, 'nothing written');
});

test('API keys are write-only: they go to the key store hook, never into settings.json or the answer', async () => {
  const { admin, hooks, data } = setup();
  const r = await admin.set('keys.fish', 'fk_abcdefgh12345');
  assert.equal(r.ok, true);
  assert.equal(r.value, undefined);
  assert.equal(r.hasKey, true);
  assert.equal(hooks.keys.fish, 'fk_abcdefgh12345');
  assert.ok(!fs.readFileSync(path.join(data, 'settings.json'), 'utf8').includes('fk_abcdefgh12345'));
  assert.ok(!JSON.stringify(r).includes('fk_abcdefgh12345'));
  assert.equal((await admin.set('keys.minimax', 'has space in it')).reason, 'bad-key');
  assert.equal((await admin.set('keys.asrlocal', '')).ok, true, 'empty clears');
  assert.equal(hooks.keys.asrlocal, '');
  assert.equal((await admin.set('keys.openai', 'whatever-123')).ok, false, 'only the known slots');
});

test('ElevenLabs in 设置 → 朗读: engine option, its own card (端点 / 默认音色 ID / 模型 / API Key) and the checks on each', () => {
  const provider = schema.FIELDS.find((f) => f.key === 'tts.provider');
  assert.ok(provider.options.some((o) => o.value === 'elevenlabs' && o.label === 'ElevenLabs'));
  assert.equal(schema.validate('tts.provider', 'elevenlabs').ok, true);
  const card = schema.FIELDS.filter((f) => f.page === 'tts' && f.card === 'ElevenLabs');
  assert.deepEqual(card.map((f) => [f.key, f.type]), [['tts.endpoints.elevenlabs', 'url'], ['tts.elevenlabs.voiceId', 'text'], ['tts.elevenlabs.modelId', 'select'], ['keys.elevenlabs', 'secret']]);
  const by = Object.fromEntries(card.map((f) => [f.key, f]));
  assert.equal(by['tts.endpoints.elevenlabs'].validator, 'tts:elevenlabs');
  assert.match(by['tts.endpoints.elevenlabs'].desc, /留空使用.*https:\/\/api\.elevenlabs\.io/);
  assert.match(by['tts.elevenlabs.voiceId'].desc, /Voice Library.*voice_id/);
  assert.equal(by['tts.elevenlabs.modelId'].default, 'eleven_multilingual_v2');
  assert.deepEqual(by['tts.elevenlabs.modelId'].options.map((o) => o.value), ['eleven_multilingual_v2', 'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_v3']);
  assert.equal(by['keys.elevenlabs'].store, 'keys');
  assert.equal(by['keys.elevenlabs'].sensitive, true);
  assert.match(by['keys.elevenlabs'].desc, /只写入，不回显。保存后显示「已设置」。/);
  // endpoint: https (or loopback for debugging), no credentials; empty = the official address
  assert.deepEqual(schema.validate('tts.endpoints.elevenlabs', ''), { ok: true, value: '' });
  assert.equal(schema.validate('tts.endpoints.elevenlabs', 'https://el.example.com').ok, true);
  assert.equal(schema.validate('tts.endpoints.elevenlabs', 'http://el.example.com').reason, 'bad-endpoint');
  assert.equal(schema.validate('tts.endpoints.elevenlabs', 'https://u:p@el.example.com').reason, 'bad-endpoint');
  assert.equal(schema.validate('tts.endpoints.elevenlabs', 'ftp://el.example.com').reason, 'bad-endpoint');
  // voice_id: letters and digits as ElevenLabs gives them; model: one of the listed ones
  assert.deepEqual(schema.validate('tts.elevenlabs.voiceId', ' 21m00Tcm4TlvDq8ikWAM '), { ok: true, value: '21m00Tcm4TlvDq8ikWAM' });
  assert.equal(schema.validate('tts.elevenlabs.voiceId', '').ok, true, 'cleared');
  assert.equal(schema.validate('tts.elevenlabs.voiceId', 'not/a voice').reason, 'pattern');
  assert.equal(schema.validate('tts.elevenlabs.modelId', 'eleven_flash_v2_5').ok, true);
  assert.equal(schema.validate('tts.elevenlabs.modelId', 'gpt-4o-mini-tts').reason, 'option');
  assert.deepEqual(schema.patchFor('tts.elevenlabs.voiceId', 'abc'), { setter: 'setTts', patch: { elevenlabs: { voiceId: 'abc' } } });
  assert.deepEqual(schema.patchFor('tts.endpoints.elevenlabs', 'https://x'), { setter: 'setTts', patch: { endpoints: { elevenlabs: 'https://x' } } });
});

test('ElevenLabs settings save through admin-set into settings.json; its key goes to the key store only', async () => {
  const { admin, file, hooks, data } = setup();
  assert.equal((await admin.set('tts.provider', 'elevenlabs')).ok, true);
  assert.equal((await admin.set('tts.endpoints.elevenlabs', 'https://el.example.com/')).ok, true);
  assert.equal((await admin.set('tts.elevenlabs.voiceId', '21m00Tcm4TlvDq8ikWAM')).ok, true);
  assert.equal((await admin.set('tts.elevenlabs.modelId', 'eleven_turbo_v2_5')).ok, true);
  const t = file().tts;
  assert.equal(t.provider, 'elevenlabs');
  assert.equal(t.endpoints.elevenlabs, 'https://el.example.com');
  assert.deepEqual(t.elevenlabs, { voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_turbo_v2_5' });
  assert.equal((await admin.set('tts.endpoints.elevenlabs', 'http://el.example.com')).reason, 'bad-endpoint');
  assert.equal(file().tts.endpoints.elevenlabs, 'https://el.example.com', 'a refused endpoint changes nothing');
  const r = await admin.set('keys.elevenlabs', 'sk_el_abcdefgh12345');
  assert.deepEqual([r.ok, r.hasKey, r.value], [true, true, undefined]);
  assert.equal(hooks.keys.elevenlabs, 'sk_el_abcdefgh12345');
  assert.ok(!fs.readFileSync(path.join(data, 'settings.json'), 'utf8').includes('sk_el_abcdefgh12345'));
  assert.equal((await admin.set('keys.elevenlabs', 'has space in it')).reason, 'bad-key');
  assert.equal((await admin.set('keys.elevenlabs', '')).ok, true, 'empty clears');
  assert.equal(hooks.keys.elevenlabs, '');
});

test('朗读 page: the ElevenLabs card shows its engine status, and a cloud engine without a key says 未设置 Key', () => {
  const src = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'console', 'pages', 'Pages.tsx'), 'utf8');
  assert.match(src, /ElevenLabs: eng\('elevenlabs'\)/);
  assert.match(src, /'未设置 Key'/);
  assert.match(src, /还没设置 Key/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main', 'admin-settings.js'), 'utf8'), /KEY_SLOTS = new Set\(\[\.\.\.NEURAL/);
  assert.ok(require('../src/core/tts').NEURAL.includes('elevenlabs'), 'key slot, set-tts key and ttsStatus all follow NEURAL');
});

test('admin-reset puts every listed key back to its default; read-only ones are skipped', async () => {
  const { admin, file } = setup();
  await admin.set('prefs.memes', false);
  await admin.set('proactive.hungryAt', 90);
  await admin.set('petScale', 2);
  const r = await admin.reset(['prefs.memes', 'proactive.hungryAt', 'petScale', 'ageConfirmed']);
  assert.equal(r.results.length, 4);
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true, false]);
  assert.equal(file().prefs.memes, true);
  assert.equal(file().proactive.hungryAt, 75);
  assert.equal(file().petScale, 1.25);
});

test('restart-only settings: saved at once, listed in pendingRestart until set back', async () => {
  const { admin, svc, mk } = setup();
  const r = await admin.set('system.hardwareAcceleration', false);
  assert.equal(r.ok, true);
  assert.equal(r.restart, true);
  assert.deepEqual(r.pendingRestart, ['system.hardwareAcceleration']);
  assert.deepEqual(svc.settingsView().pendingRestart, ['system.hardwareAcceleration']);
  assert.deepEqual(mk().settingsView().pendingRestart, [], 'after a restart it is the boot value');
  assert.deepEqual((await admin.set('system.hardwareAcceleration', true)).pendingRestart, []);
});

// ---- 主动行为 / 好感度 take effect at once -------------------------------------------------------------------

test('主动行为 off: the heartbeat keeps her needs going but she never speaks up; on again she does', async () => {
  const ctx = setup({ hatch: true });
  await ctx.ready;
  const said = [];
  ctx.svc.on('say', (m) => said.push(m.kind));
  const hungry = () => { ctx.svc._c().hunger = 95; ctx.svc._c().lastSpokeAt = 0; };
  await ctx.admin.set('proactive.enabled', false);
  hungry();
  ctx.clock.t += 60 * 60 * 1000;
  await ctx.svc.heartbeat();
  assert.deepEqual(said, []);
  await ctx.admin.set('proactive.enabled', true);
  hungry();
  ctx.clock.t += 60 * 1000;
  await ctx.svc.heartbeat();
  assert.ok(said.includes('hungry'), said.join());
});

test('主动行为 thresholds and the hourly LLM budget come from settings', async () => {
  const ctx = setup({ hatch: true });
  await ctx.ready;
  await ctx.admin.set('proactive.maxLlmPerHour', 2);
  assert.equal(ctx.svc.budget.max, 2);
  await ctx.admin.set('proactive.hungryAt', 100);
  const said = [];
  ctx.svc.on('say', (m) => said.push(m.kind));
  ctx.svc._c().hunger = 80;
  ctx.svc._c().lastSpokeAt = 0;
  ctx.clock.t += 60 * 1000;
  await ctx.svc.heartbeat();
  assert.ok(!said.includes('hungry'), 'hunger 80 is below the new threshold');
});

test('好感度 rules: the daily cap and the decay switch apply to scoring at once', async () => {
  const ctx = setup({ hatch: true });
  await ctx.ready;
  await ctx.admin.set('affectionRules.dailyCap', 4);
  assert.equal(affection.getRules().dailyCap, 4);
  const pet = { ...ctx.svc._c(), affection: 0, affectionToday: 0, dailyCounts: {}, lastAffectionAt: {}, topicsToday: [] };
  let total = 0;
  for (let i = 0; i < 20; i++) total += affection.gainAffection(pet, 'chat', ctx.clock.t + i * 2 * 60 * 1000, {}).delta;
  assert.ok(total <= 4, `gained ${total}`);
  assert.equal(ctx.svc.view().affection.dailyCap, 4);
  await ctx.admin.set('affectionRules.decay', false);
  const p2 = { affection: 30, relStage: 'acquaintance', lastInteractionAt: 0, decayAnchor: 0, decaySteps: 0 };
  assert.equal(affection.decay(p2, 10 * 24 * 3600 * 1000), 0);
  await ctx.admin.set('affectionRules.decay', true);
  assert.equal(affection.decay(p2, 10 * 24 * 3600 * 1000), 0, 'the steps of that absence count as taken');
});

// ---- roster ------------------------------------------------------------------------------------------------

test('roster: before the first hatch every character is listed from the character files, none current', () => {
  const rows = buildRoster(null, { ttsStatus: { packs: [] } });
  // T-2764: one row per character; only the five pixel characters ship with the app (core/catalog.js), the
  // other looks (Live2D, 旧版像素, 原版动画, 成年版 …) are downloaded first and are not characters before that
  assert.deepEqual(rows.map((r) => r.id), ['dafeiyu-pixel', 'claude-pixel', 'grok-pixel', 'gemini-pixel', 'gpt-pixel']);
  assert.deepEqual([...new Set(rows.map((r) => r.base))], ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']);
  assert.ok(rows.every((r) => !r.current && !r.met && r.source === 'builtin' && r.kind === 'sprites'));
  assert.equal(rows.find((r) => r.id === 'dafeiyu-pixel').name, '大肥鱼 · 像素');
});

test('roster rows: name, preview, type, source, voice pack, model and the current mark', async () => {
  const ctx = setup({ hatch: true });
  await ctx.ready;
  const settings = { ...ctx.svc.settingsView(), ttsStatus: { packs: [{ id: 'grok-minimax', name: '格萝可语音', character: 'grok', engine: 'minimax', lines: 120, builtIn: true, credit: 'MiniMax' }] } };
  const rows = buildRoster(ctx.svc.view(), settings);
  const grok = rows.find((r) => r.id === 'grok-pixel');
  assert.equal(grok.current, true);
  assert.equal(grok.base, 'grok');
  assert.equal(grok.displayName, '「小格」格萝可 · 像素（xAI）');
  assert.equal(rows.find((r) => r.id === 'grok-classic').met.name, '小格', 'her other look shares her base');
  assert.equal(rows.find((r) => r.id === 'grok-classic').voicePack.id, 'grok-minimax', 'so does her 语音包');
  assert.equal(grok.kind, 'sprites');
  assert.equal(grok.kindLabel, '像素');
  assert.equal(grok.source, 'builtin');
  assert.equal(grok.sourceLabel, '内置');
  assert.equal(grok.preview.type, 'sprite');
  assert.match(grok.preview.url, /^pack:\/\/grok-pixel\//);
  assert.ok(grok.preview.frame.width > 0);
  assert.deepEqual(grok.voicePack, { id: 'grok-minimax', name: '格萝可语音', engine: 'minimax', engineLabel: 'MiniMax', lines: 120, builtIn: true, store: false, credit: 'MiniMax', kind: 'character', gender: null, label: '专属', source: 'own', sourceLabel: '自动' });
  assert.equal(grok.voicePackPick.choice, 'auto');
  assert.deepEqual(grok.voicePackPick.options.map((o) => [o.id, o.group, o.label]), [['grok-minimax', 'own', '专属']]);
  assert.equal(grok.met.name, '小格');
  assert.equal(rows.filter((r) => r.current).length, 1);
  const fish = rows.find((r) => r.id === 'dafeiyu-pixel');
  assert.equal(fish.met, null);
  assert.equal(fish.voicePack, null);
  // switching (the admin calls the same switch-character) moves the mark
  await ctx.svc.switchCharacter('claude', { name: '小克' });
  const after = buildRoster(ctx.svc.view(), settings);
  assert.deepEqual(after.filter((r) => r.current).map((r) => r.id), ['claude-pixel']);
});

test('roster: a video character (大肥鱼 clips) gets her idle clip as the preview', async () => {
  const ctx = setup({ hatch: true });
  await ctx.ready;
  const fish = buildRoster(ctx.svc.view(), ctx.svc.settingsView()).find((r) => r.id === 'dafeiyu-clips');
  assert.equal(fish.kind, 'video');
  assert.equal(fish.kindLabel, '视频');
  assert.equal(fish.preview.type, 'video');
  // her clips are downloaded (core/catalog.js) and served as pack://dafeiyu-clips/<clip> (src/main/packs.js)
  assert.equal(fish.preview.url, 'pack://dafeiyu-clips/idle.webm');
  assert.equal(fish.source, 'download');
  assert.ok(fs.existsSync(path.join(ROOT, 'catalog', 'clips', 'dafeiyu-clips', 'idle.webm')));
});

test('外观资源 rows: built-in packs cannot be removed or exported, downloaded ones can be removed, imported ones both', () => {
  const { packs } = require('../src/core/catalog').repoPacks();
  const rows = packRows(packs);
  assert.equal(rows.length, packs.size);
  const builtin = rows.filter((r) => r.source === 'builtin');
  assert.deepEqual(builtin.map((r) => r.id).sort(), ['claude-pixel', 'dafeiyu-pixel', 'gemini-pixel', 'gpt-pixel', 'grok-pixel']);
  assert.ok(builtin.every((r) => !r.removable && !r.exportable && r.sourceLabel === '内置'));
  const downloaded = rows.filter((r) => r.source === 'download');
  assert.equal(downloaded.length, rows.length - 5);
  assert.ok(downloaded.every((r) => r.removable && !r.exportable && r.sourceLabel === '下载'));
  assert.ok(rows.some((r) => r.kind === 'live2d' && r.kindLabel === 'Live2D'));
  const user = packRows([{ id: 'my-grok', name: 'x', species: 'grok', kind: 'sprites', source: 'user', outfits: { daily: 'a.png' } }, { id: 'my-vrm', name: 'v', species: 'grok', kind: 'vrm', source: 'user', outfits: {}, vrm: { license: { redistributable: false } } }]);
  assert.deepEqual(user.map((r) => [r.id, r.removable, r.exportable]), [['my-grok', true, true], ['my-vrm', true, false]]);
});

// ---- IPC: broadcast, the window, the preload whitelist ------------------------------------------------------

test('broadcast reaches every pet window and the settings window; a per-character change is broadcast too', async () => {
  const got = [];
  const wc = (name) => ({ isDestroyed: () => false, webContents: { send: (ch, p) => got.push([name, ch, p && typeof p === 'object' ? 'obj' : p]) } });
  const pets = new Map([['main', { win: wc('pet') }], ['visitor:claude', { win: wc('visitor') }]]);
  let adminAlive = true;
  const admin = { get alive() { return adminAlive; }, send: (ch, p) => got.push(['admin', ch, p && typeof p === 'object' ? 'obj' : p]) };
  const broadcast = createBroadcast({ pets, admin: () => admin });
  assert.equal(broadcast('settings', { a: 1 }), 3);
  assert.deepEqual(got.map((g) => g[0]), ['pet', 'visitor', 'admin']);
  adminAlive = false;
  assert.equal(broadcast('settings', {}), 2, 'a closed settings window is skipped');
  // the setters main wires to the broadcast emit `update` (switch-character / set-system-role / unlock-all)
  const ctx = setup({ hatch: true });
  await ctx.ready;
  const updates = [];
  ctx.svc.on('update', (v) => updates.push(v && v.pet.speciesId));
  await ctx.svc.switchCharacter('grok-classic');
  ctx.svc.setSystemRole('叫我老板', 'grok');
  ctx.svc.unlockAll('grok');
  assert.ok(updates.length >= 3, `update events: ${updates.length}`);
});

// Load src/main/admin-window.js against a fake electron.
function withFakeElectron(fn) {
  const created = [];
  class FakeWin {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.shown = 0;
      this.sent = [];
      this.handlers = {};
      this.loading = true;
      this.webContents = {
        send: (ch, p) => this.sent.push([ch, p]),
        setWindowOpenHandler: () => {},
        on: () => {},
        isLoading: () => this.loading,
        once: (ev, cb) => { this.handlers[`wc:${ev}`] = cb; },
        executeJavaScript: async (js) => { this.sent.push(['js', js]); },
      };
      created.push(this);
    }
    setMenuBarVisibility() {}
    loadFile(file, o) { this.loaded = { file, ...o }; }
    once(ev, cb) { this.handlers[ev] = cb; }
    on(ev, cb) { this.handlers[ev] = cb; }
    show() { this.shown += 1; }
    focus() {}
    isMinimized() { return false; }
    restore() {}
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.handlers.closed && this.handlers.closed(); }
  }
  const fake = { BrowserWindow: FakeWin, nativeTheme: { shouldUseDarkColors: false }, shell: { openExternal() {} } };
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : orig.call(this, req, ...rest); };
  const file = require.resolve('../src/main/admin-window');
  delete require.cache[file];
  try {
    return fn(require(file), created);
  } finally {
    Module._load = orig;
    delete require.cache[file];
  }
}

test('the settings window: single instance, isolated (contextIsolation, sandbox, no Node), opens at a section', () => {
  withFakeElectron(({ AdminWindow }, created) => {
    const a = new AdminWindow({ testMode: true, index: '/x/admin-ui/index.html' });
    const r1 = a.open('behavior');
    assert.deepEqual(r1, { ok: true, reused: false, opened: 1 });
    const w = created[0];
    assert.equal(w.opts.webPreferences.contextIsolation, true);
    assert.equal(w.opts.webPreferences.nodeIntegration, false);
    assert.equal(w.opts.webPreferences.sandbox, true);
    assert.match(w.opts.webPreferences.preload, /admin-preload\.js$/);
    assert.deepEqual(w.loaded, { file: '/x/admin-ui/index.html', hash: '/behavior' });
    // again while it is still loading: the same window, sent there once it has loaded (not lost)
    const r2 = a.open('characters/claude');
    assert.equal(r2.reused, true);
    assert.equal(created.length, 1);
    assert.equal(w.sent.length, 0);
    w.loading = false;
    w.handlers['wc:did-finish-load']();
    assert.deepEqual(w.sent.at(-1), ['js', 'location.hash = "/characters/claude"']);
    // loaded: at once
    a.open('tts');
    assert.deepEqual(w.sent.at(-1), ['js', 'location.hash = "/tts"']);
    // junk sections are ignored
    a.open('../../etc');
    assert.deepEqual(w.sent.at(-1), ['js', 'location.hash = "/tts"']);
    // isSender only for its own webContents
    assert.equal(a.isSender({ sender: w.webContents }), true);
    assert.equal(a.isSender({ sender: {} }), false);
    // closed → the next open creates a new one
    w.close();
    assert.equal(a.alive, false);
    assert.equal(a.open().reused, false);
    assert.equal(created.length, 2);
    assert.equal(created[1].loaded.hash, '/overview');
  });
});

test('admin preload: a whitelist of settings / roster / admin-chat channels, each one handled in main; no pet chat, move or debug', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'admin-preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const invoked = [...src.matchAll(/ipcRenderer\.(?:invoke|send)\('([a-z0-9-]+)'/g)].map((m) => m[1]);
  const pushed = [...src.matchAll(/on\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 30, `${invoked.length} channels`);
  for (const ch of invoked) assert.match(main, new RegExp(`ipcMain\\.(handle|on)\\('${ch}'`), `main handles ${ch}`);
  for (const bad of ['chat', 'move-by', 'move-to', 'kick', 'pose', 'hatch', 'act', 'touch', 'api-reply', 'asr-transcribe', 'tts-synthesize']) assert.ok(!invoked.includes(bad), bad);
  assert.ok(!invoked.some((c) => c.startsWith('debug-')));
  assert.deepEqual(pushed.sort(), ['admin-chat-changed', 'admin-chat-delta', 'admin-chat-done', 'admin-chat-music', 'admin-state', 'api-status', 'catalog-progress', 'game-updates', 'interject', 'music-library-changed', 'stickers-changed', 'update-status']); // interject: 插个嘴 rules / records refresh; catalog-progress: 下载角色; game-updates: 小游戏有新版本; music-library-changed: 她的音乐库; stickers-changed: 角色 → 表情包 refresh
  // 聊天 with a character (docs/admin-chat.md): only admin-chat-* channels, answered for that window only
  for (const ch of invoked.filter((c) => c.startsWith('admin-chat-'))) assert.match(main, new RegExp(`ipcMain\\.handle\\('${ch}', adminOnly\\(`), `${ch} is settings-window only`);
  assert.match(src, /contextBridge\.exposeInMainWorld\('petAdmin'/);
  // the settings window's own channels answer that window only (outside tests)
  assert.match(main, /const adminOnly = \(fn\) => \(e, p\) => \(admin\.isSender\(e\) \|\| TEST_MODE/);
  // the pet window can open it; CmdOrCtrl+, and the tray / app menu too
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8'), /openAdmin: \(section\) => ipcRenderer\.invoke\('open-admin'/);
  assert.match(main, /input\.key === ','/);
  assert.match(main, /label: '打开设置…'/);
  assert.match(main, /label: '偏好设置…', accelerator: 'CmdOrCtrl\+,'/);
});

test('the pet window: one ⚙ 设置 button opens the settings window; no ⋯ menu, 话题 or 衣柜 is left in it (T-2718)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  // her panel (right click on her): the three interactions as tiles, its chat box (T-6162: no 聊天 tile), then
  // 🔈 ♪ ↺ … ⚙ ⏻ in its footer
  const panelHtml = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'panel', 'panel.html'), 'utf8');
  const bar = panelHtml.match(/<div id="toolbar"[^>]*>([\s\S]*?)<script/)[1];
  assert.deepEqual([...bar.matchAll(/data-act="(\w+)"/g)].map((m) => m[1]), ['feed', 'play', 'sleep', 'mute', 'scene', 'dance', 'reset', 'settings', 'quit']); // 🔈 静音 (T-2733), ⌂ 小游戏, ♪ 跳舞 and ↺ 重置姿势 (VRM only, T-2801 / T-2830) on the left of the footer; ⚙ and ⏻ 退出 (T-2827) on its right
  assert.match(bar, /id="btn-settings"[^>]*aria-label="设置"/);
  for (const gone of ['id="btn-topics"', 'id="btn-wardrobe"', 'data-act="menu"', 'id="main-menu"', 'id="action-menu"', 'data-menu=', 'id="panel"', 'history.js']) assert.ok(!html.includes(gone), gone);
  for (const gone of ['function openPanel', 'function renderWardrobe', 'function renderTopics', 'function renderCharacters', 'function openMenuAtPet', "$('main-menu')", 'PetHistory', 'panelKind']) assert.ok(!app.includes(gone), gone);
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'renderer', 'history.js')));
  // ⚙ in her panel opens the settings window; a right click and a long press open the panel itself
  assert.match(app, /else if \(act === 'settings'\) openSettings\(\);/);
  assert.ok(!html.includes('data-act='), 'her window has no buttons of its own: they are in her panel');
  assert.match(app, /bindPetPointer\(\{ onClick: touchAt, onMenu: \(\) => openPetPanel\('long-press'\) \}\)/);
  assert.match(app, /addEventListener\('contextmenu'[\s\S]{0,300}togglePetPanel\('right-click'\);/);
  assert.match(app, /window\.pet\.openAdmin\(/);
  // the unlock toast goes to her page (衣柜) or 玩法 → 话题 in the settings window
  // T-2764: her page is the character's (one look), e.g. characters/dafeiyu-live2d
  assert.match(app, /dataset\.admin = outfits \? `characters\/\$\{\(e\.view \|\| view\)\.pet\.characterId/);
  assert.match(app, /\{ label: '去设置', admin: 'asr' \}/);
  // no 高级设置 panel or her model / system-role forms either (since the console)
  for (const gone of ['function renderAdvanced', 'function voiceSection', 'function asrSection', 'function behaviorSections', 'id="model-select"', 'id="role-input"']) assert.ok(!app.includes(gone), gone);
});

test('every item of the old ⋯ menu has its place in the settings window (T-2718)', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'admin-preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const read = (f) => fs.readFileSync(path.join(ROOT, 'admin', 'src', 'console', ...f.split('/')), 'utf8');
  const pages = read('pages/Pages.tsx');
  const together = read('pages/Together.tsx');
  const app = read('ConsoleApp.tsx');
  const navPages = schema.NAV.flatMap((g) => g.items.map((i) => i.page));
  for (const p of ['characters', 'topics', 'history', 'desk', 'connection', 'safety', 'update', 'about']) {
    assert.ok(navPages.includes(p), `${p} is in the nav`);
    if (!['characters'].includes(p)) assert.match(app, new RegExp(`case '${p}':`), `${p} has a page`);
  }
  // the bridge: each menu action has a channel
  for (const fn of ['newTopic:', 'setAdult:', 'confirmAge:', 'checkUpdate:', 'installUpdate:', 'release:', 'openLog:', 'cue:', 'home:', 'quit:', 'talkTopic:', 'markSeen:', 'historyList:', 'historyGet:', 'switchCharacter:', 'equipOutfit:']) assert.ok(preload.includes(fn), fn);
  assert.match(main, /ipcMain\.handle\('admin-home', adminOnly\(/);
  assert.match(main, /ipcMain\.handle\('admin-quit', adminOnly\(/);
  assert.match(main, /const ADMIN_CUES = \[\.\.\.CUE_STATES, 'turn'\];/);
  // dangerous ones are asked again
  assert.match(together, /ask\('退出桌宠？'/);
  assert.match(pages, /ask\('和她开一个新话题？'/);
  assert.match(pages, /deleteAgent \? '放生并删除 agent？' : '仅重置本地？'/);
  // the 动作 list keeps the old menu's nine actions
  assert.match(together, /const CUES = \['look', 'turn', 'walk', 'happy', 'pat', 'play', 'think', 'sad', 'evolve'\];/);
  assert.match(pages, /素材署名/);
  assert.match(pages, /打开错误日志/);
});

test('the pet window: ⏻ 退出 sits right of ⚙ and quits the app in one click (T-2827)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'panel', 'panel.css'), 'utf8');
  const bar = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'panel', 'panel.html'), 'utf8').match(/<div id="toolbar"[^>]*>([\s\S]*?)<script/)[1];
  const buttons = [...bar.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.match(buttons[buttons.length - 1], /data-act="quit"/, '⏻ is the last button');
  assert.match(buttons[buttons.length - 2], /data-act="settings"/, '… right after ⚙');
  assert.match(bar, /id="btn-quit"[^>]*title="退出：[^"]+"[^>]*aria-label="退出"/);
  // the toolbar → the preload's quit → ipcMain 'quit' → app.quit(): no dialog, the save is already on disk
  assert.match(app, /else if \(act === 'quit'\) window\.pet\.quit\(\);/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.js'), 'utf8'), /quit: \(\) => ipcRenderer\.send\('quit'\)/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8'), /ipcMain\.on\('quit', \(\) => app\.quit\(\)\);/);
  // hover marks it apart from the interactions, with a token colour
  assert.match(css, /\.quit-btn:hover[^{]*\{[^}]*color: var\(--lobe-color-error\)/);
});

test('docs/admin-console-design.md names every settings.json key and settings IPC channel (scripts/check-admin-console-doc.js)', () => {
  const out = require('node:child_process').execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-admin-console-doc.js')], { encoding: 'utf8' });
  assert.match(out, /PASS: every settings\.json key/);
});

test('roster: a sprite preview carries her sheet\'s actions, so the console can play idle / happy / pat', () => {
  const { previewOf } = require('../src/core/roster');
  const look = { kind: 'sprites', url: 'pack://grok-pixel/sheets/daily.webp', frame: { width: 664, height: 904 }, actions: { idle: { row: 0, col: 0, frames: 2, fps: 2 }, pat: { row: 0, col: 2, frames: 2, fps: 4 } }, pixelated: false };
  const pv = previewOf({}, look);
  assert.equal(pv.type, 'sprite');
  assert.deepEqual(pv.actions, look.actions);
  assert.equal(previewOf({}, { ...look, actions: undefined }).actions, null);
});

// 后台点击卡顿 (T-2701): what made every click in the console freeze, kept from coming back.
test('admin perf: the console view carries her needs as the whole numbers it shows, without the tick clock', () => {
  const { adminView } = require('../src/core/roster');
  const view = { pet: { hunger: 30.0412, mood: 69.987, energy: 89.97, lastTickAt: 1793625869524, sleeping: false, name: 'x' }, characters: [] };
  const a = adminView(view);
  assert.deepEqual(a.pet, { hunger: 30, mood: 70, energy: 90, sleeping: false, name: 'x' });
  assert.equal(view.pet.lastTickAt, 1793625869524, 'the service view itself is not touched');
  assert.equal(a.characters, view.characters);
  // two heartbeats a moment apart: the same console state, so main sends nothing
  const b = adminView({ ...view, pet: { ...view.pet, hunger: 30.0477, mood: 69.9857, energy: 89.9714, lastTickAt: 1793625870385 } });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(adminView(null), null);
});

test('admin perf: main sends the console a state only when it changed; sprite sheets are decoded off the main thread', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /if \(json === adminSent\) return;/);
  assert.match(main, /view: adminView\(view\)/);
  const stage = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'console', 'stage', 'SpriteStage.tsx'), 'utf8');
  // a whole 2656 × 8136 sheet drawn onto a canvas is decoded synchronously on the main thread (1–2 s each)
  assert.match(stage, /createImageBitmap\(b\)/);
  assert.match(stage, /g\.drawImage\(frames\[i\], 0, 0\)/);
  assert.doesNotMatch(stage, /new Image\(\)/);
  assert.doesNotMatch(stage, /requestAnimationFrame\(/, 'frames advance at the sheet fps, not every vsync');
  assert.match(fs.readFileSync(path.join(ROOT, 'admin', 'index.html'), 'utf8'), /connect-src 'self' pack:/, 'the sheets are fetched from pack://');
  const cs = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'console', 'stage', 'CharacterStage.tsx'), 'utf8');
  assert.doesNotMatch(cs, /infinite/, 'no endless full-stage animation');
  const store = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'console', 'store.tsx'), 'utf8');
  assert.match(store, /share\(d, \{ \.\.\.d, \.\.\.st \}\)/, 'a pushed state reuses what did not change');
});

// 前台精简 (T-2718) took the pet window's 外观 panel away; its VRM license flow lives on in the settings window.
test('VRM import in the settings window: 导入确认 with the license before she wears it, 取消导入 removes it, 授权信息 on the card', () => {
  const src = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'console', 'pages', 'Characters.tsx'), 'utf8');
  assert.match(src, /data-import-vrm [^>]*onClick=\{importVrm\}/, '导入 VRM… asks before wearing, not straight to a toast');
  assert.match(src, /cancelText="取消导入"/);
  assert.match(src, /okText="使用这个模型"/);
  assert.match(src, /await api\(\)\.removePack\(r\.pack\.id\)/, '取消导入 removes the pack again');
  assert.match(src, /data-vrm-info=\{p\.id\}/);
  assert.match(src, /data-vrm-credit=\{p\.id\}/);
  assert.match(src, /data-vrm-noexport=\{p\.id\}/);
  const lic = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'console', 'stage', 'VrmLicense.tsx'), 'utf8');
  assert.match(lic, /from '\.\.\/\.\.\/\.\.\/\.\.\/src\/core\/vrm-ui\.js'/, 'the same wording as before (core/vrm-ui.js)');
  assert.match(lic, /api\(\)\.openLink\(row\.href!\)/, 'license links open in the system browser');
});

test('Live2D import from the settings window: main hands the new pack to the service at once, and the console puts it on', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const h = main.slice(main.indexOf("ipcMain.handle('import-live2d'"), main.indexOf("ipcMain.handle('import-vrm'"));
  assert.match(h, /const out = await packStore\.importLive2d\(r\.filePaths\[0\], sp\);\n\s+if \(out\.ok\) service\.setPacks\(packStore\.packs\);/);
  const src = fs.readFileSync(path.join(ROOT, 'admin', 'src', 'console', 'pages', 'Characters.tsx'), 'utf8');
  // T-2764: the imported model is a new character; the console switches to her (no 形象包 to put on)
  assert.match(src, /data-import-live2d[\s\S]{0,900}becomeNew\(r\.pack\.id/);
  assert.match(src, /const becomeNew = async \(id: string, ok: string\) => \{\n\s+const r = await run\(api\(\)\.switchCharacter\(id\), ok\);/, 'becomeNew switches to the new character');
  assert.doesNotMatch(src, /setAppearance/);
});
