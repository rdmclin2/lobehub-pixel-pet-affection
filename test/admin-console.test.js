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
  assert.equal(navPages.length, 18, '18 pages under 4 rail places (docs §6.3; 话题 / 聊天记录 / 桌面上的她 since T-2718)');
  assert.deepEqual(schema.RAIL.map((r) => r.key), ['home', 'characters', 'play', 'settings'], 'the rail holds four places, not every page');
  assert.ok(schema.NAV.every((g) => schema.RAIL.some((r) => r.key === g.section)), 'every group sits under a rail place');
  for (const r of schema.RAIL) assert.ok(schema.PAGES[r.page], r.page);
  for (const f of schema.FIELDS) {
    assert.ok(pages.has(f.page), `${f.key} → ${f.page}`);
    assert.ok(f.label && f.card, f.key);
    if (f.store === 'settings' && !f.key.includes('<id>')) assert.deepEqual(f.default, schema.at(settingsLib.normalizeSettings(null), f.key), f.key);
  }
  // sensitive ones are masked / write-only
  assert.deepEqual(schema.FIELDS.filter((f) => f.sensitive).map((f) => f.key).sort(), ['api.token', 'keys.asrlocal', 'keys.fish', 'keys.local', 'keys.minimax']);
  assert.deepEqual(schema.FIELDS.filter((f) => f.restart).map((f) => f.key), ['system.hardwareAcceleration']);
  // describe() is plain data for the window
  const d = JSON.parse(JSON.stringify(schema.describe()));
  assert.equal(d.fields.length, schema.FIELDS.length);
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
  assert.deepEqual(rows.map((r) => r.id), ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']);
  assert.ok(rows.every((r) => !r.current && !r.met));
});

test('roster rows: name, preview, type, source, voice pack, model and the current mark', async () => {
  const ctx = setup({ hatch: true });
  await ctx.ready;
  const settings = { ...ctx.svc.settingsView(), ttsStatus: { packs: [{ id: 'grok-minimax', name: '格萝可语音', character: 'grok', engine: 'minimax', lines: 120, builtIn: true, credit: 'MiniMax' }] } };
  const rows = buildRoster(ctx.svc.view(), settings);
  const grok = rows.find((r) => r.id === 'grok');
  assert.equal(grok.current, true);
  assert.equal(grok.displayName, '「小格」格萝可（xAI）');
  assert.equal(grok.kind, 'sprites');
  assert.equal(grok.kindLabel, '像素');
  assert.equal(grok.source, 'builtin');
  assert.equal(grok.sourceLabel, '内置');
  assert.equal(grok.preview.type, 'sprite');
  assert.match(grok.preview.url, /^pack:\/\/grok-pixel\//);
  assert.ok(grok.preview.frame.width > 0);
  assert.deepEqual(grok.voicePack, { id: 'grok-minimax', name: '格萝可语音', engine: 'minimax', engineLabel: 'MiniMax', lines: 120, builtIn: true, credit: 'MiniMax' });
  assert.equal(grok.met.name, '小格');
  assert.equal(rows.filter((r) => r.current).length, 1);
  const fish = rows.find((r) => r.id === 'dafeiyu');
  assert.equal(fish.met, null);
  assert.equal(fish.voicePack, null);
  // switching (the admin calls the same switch-character) moves the mark
  await ctx.svc.switchCharacter('claude', { name: '小克' });
  const after = buildRoster(ctx.svc.view(), settings);
  assert.deepEqual(after.filter((r) => r.current).map((r) => r.id), ['claude']);
});

test('roster: a video character (大肥鱼 clips) gets her idle clip as the preview', async () => {
  const ctx = setup({ hatch: true });
  await ctx.ready;
  assert.equal(ctx.svc.setAppearance('dafeiyu-clips', 'dafeiyu').ok, true);
  const fish = buildRoster(ctx.svc.view(), ctx.svc.settingsView()).find((r) => r.id === 'dafeiyu');
  assert.equal(fish.kind, 'video');
  assert.equal(fish.kindLabel, '视频');
  assert.equal(fish.preview.type, 'video');
  // relative to the console page (src/admin-ui/index.html): ../renderer/assets/dafeiyu/idle.webm
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'admin-ui', fish.preview.url)), fish.preview.url);
});

test('外观资源 rows: built-in packs cannot be removed or exported, imported ones can', () => {
  const { packs } = loadPacks([{ dir: path.join(ROOT, 'src', 'renderer', 'packs'), source: 'builtin' }]);
  const rows = packRows(packs);
  assert.equal(rows.length, packs.size);
  assert.ok(rows.every((r) => r.source === 'builtin' && !r.removable && !r.exportable));
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
  // the setters main wires to the broadcast emit `update` (set-model / set-appearance / set-system-role / unlock-all)
  const ctx = setup({ hatch: true });
  await ctx.ready;
  const updates = [];
  ctx.svc.on('update', (v) => updates.push(v && v.pet.speciesId));
  ctx.svc.setAppearance('grok-classic', 'grok');
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

test('admin preload: a whitelist of settings / roster channels, each one handled in main; no chat, move or debug', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'admin-preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const invoked = [...src.matchAll(/ipcRenderer\.(?:invoke|send)\('([a-z0-9-]+)'/g)].map((m) => m[1]);
  const pushed = [...src.matchAll(/on\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 30, `${invoked.length} channels`);
  for (const ch of invoked) assert.match(main, new RegExp(`ipcMain\\.(handle|on)\\('${ch}'`), `main handles ${ch}`);
  for (const bad of ['chat', 'move-by', 'move-to', 'kick', 'pose', 'hatch', 'act', 'touch', 'api-reply', 'asr-transcribe', 'tts-synthesize']) assert.ok(!invoked.includes(bad), bad);
  assert.ok(!invoked.some((c) => c.startsWith('debug-')));
  assert.deepEqual(pushed.sort(), ['admin-state', 'api-status', 'update-status']);
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
  // the toolbar: the four interactions and ⚙
  const bar = html.match(/<div id="toolbar"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...bar.matchAll(/data-act="(\w+)"/g)].map((m) => m[1]), ['feed', 'play', 'sleep', 'chat', 'settings']);
  assert.match(bar, /id="btn-settings"[^>]*aria-label="设置"/);
  for (const gone of ['id="btn-topics"', 'id="btn-wardrobe"', 'data-act="menu"', 'id="main-menu"', 'id="action-menu"', 'data-menu=', 'id="panel"', 'history.js']) assert.ok(!html.includes(gone), gone);
  for (const gone of ['function openPanel', 'function renderWardrobe', 'function renderTopics', 'function renderCharacters', 'function openMenuAtPet', "$('main-menu')", 'PetHistory', 'panelKind']) assert.ok(!app.includes(gone), gone);
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'renderer', 'history.js')));
  // ⚙, a right click and a long press all open the settings window
  assert.match(app, /else if \(act === 'settings'\) openSettings\(\);/);
  assert.match(app, /bindPetPointer\(\{ onClick: touchAt, onMenu: \(\) => openSettings\(\) \}\)/);
  assert.match(app, /addEventListener\('contextmenu'[\s\S]{0,160}openSettings\(\);/);
  assert.match(app, /window\.pet\.openAdmin\(/);
  // the unlock toast goes to her page (衣柜) or 玩法 → 话题 in the settings window
  assert.match(app, /dataset\.admin = outfits \? `characters\/\$\{\(e\.view \|\| view\)\.pet\.speciesId\}` : 'topics'/);
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
