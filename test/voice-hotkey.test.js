'use strict';
// 快捷键唤起语音对话: accelerator parsing / normalisation (core/hotkey.js, settings.js, asr.js), the schema check
// the settings window goes through, and the registration state machine (main/voice-hotkey.js) against a fake
// globalShortcut — start, change (old one let go first), clear, taken by another app, quit.
const test = require('node:test');
const assert = require('node:assert/strict');

const hotkey = require('../src/core/hotkey');
const settingsLib = require('../src/core/settings');
const asrLib = require('../src/core/asr');
const schema = require('../src/core/settings-schema');
const { VoiceHotkey } = require('../src/main/voice-hotkey');
const { createAdminSettings } = require('../src/main/admin-settings');
const { PetService } = require('../src/main/pet-service');

// ---- parsing ---------------------------------------------------------------------------------------------
test('parseAccelerator: Electron and HotkeyInput spellings become one Electron accelerator', () => {
  const ok = (raw, acc) => assert.deepEqual(hotkey.parseAccelerator(raw), { ok: true, accelerator: acc }, raw);
  ok('CommandOrControl+Shift+Space', 'CommandOrControl+Shift+Space');
  ok('CmdOrCtrl+Shift+Space', 'CommandOrControl+Shift+Space');
  ok('mod+shift+space', 'CommandOrControl+Shift+Space');
  ok('shift+mod+space', 'CommandOrControl+Shift+Space'); // order does not matter
  ok(' ctrl + alt + k ', 'Control+Alt+K');
  ok('meta+shift+f5', 'Shift+Super+F5');
  ok('option+cmd+arrowup', 'Command+Alt+Up');
  ok('mod+comma', 'CommandOrControl+,');
  ok('alt+backquote', 'Alt+`');
  ok('mod++', 'CommandOrControl+Plus');
  ok('Ctrl+F24', 'Control+F24');
  ok('alt+shift+7', 'Alt+Shift+7');
});

test('parseAccelerator: modifier-only, no modifier, Shift alone, two keys, unknown keys are refused with a reason', () => {
  const bad = (raw, reason) => {
    const r = hotkey.parseAccelerator(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.reason, reason, raw);
    assert.ok(r.message && r.message.length >= 2, raw);
  };
  bad('ctrl+shift', 'no-key');
  bad('mod', 'no-key');
  bad('space', 'no-modifier');
  bad('K', 'no-modifier');
  bad('shift+a', 'shift-only');
  bad('ctrl+a+b', 'two-keys');
  bad('ctrl+banana', 'unknown-key');
  bad('ctrl+F25', 'unknown-key');
  bad('ctrl+a+', 'unknown-key'); // a dangling '+'
  bad('ctrl+a+b'.repeat(20), 'too-long');
});

test('normalizeHotkey: missing → default, "" → off, unreadable → default, valid → canonical', () => {
  assert.equal(hotkey.DEFAULT_HOTKEY, 'CommandOrControl+Shift+Space');
  assert.equal(settingsLib.normalizeHotkey(undefined), hotkey.DEFAULT_HOTKEY);
  assert.equal(settingsLib.normalizeHotkey(null), hotkey.DEFAULT_HOTKEY);
  assert.equal(settingsLib.normalizeHotkey(''), '');
  assert.equal(settingsLib.normalizeHotkey('   '), '');
  assert.equal(settingsLib.normalizeHotkey('shift'), hotkey.DEFAULT_HOTKEY);
  assert.equal(settingsLib.normalizeHotkey(42), hotkey.DEFAULT_HOTKEY);
  assert.equal(settingsLib.normalizeHotkey('alt+shift+v'), 'Alt+Shift+V');
});

test('settings.json: asr.hotkey defaults on, survives a round trip, settings from before the shortcut get the default', () => {
  assert.equal(settingsLib.normalizeSettings(null).asr.hotkey, hotkey.DEFAULT_HOTKEY);
  assert.equal(settingsLib.normalizeSettings({ asr: { enabled: true, engine: 'local' } }).asr.hotkey, hotkey.DEFAULT_HOTKEY);
  assert.equal(settingsLib.normalizeSettings({ asr: { hotkey: '' } }).asr.hotkey, '');
  assert.equal(settingsLib.normalizeSettings({ asr: { hotkey: 'ctrl+alt+k' } }).asr.hotkey, 'Control+Alt+K');
  assert.equal(settingsLib.normalizeSettings({ asr: { hotkey: 'not a key' } }).asr.hotkey, hotkey.DEFAULT_HOTKEY);
  const store = new settingsLib.MemorySettingsStore();
  store.save({ ...store.load(), asr: { ...store.load().asr, hotkey: 'Alt+Shift+V' } });
  assert.equal(store.load().asr.hotkey, 'Alt+Shift+V');
  assert.equal(asrLib.normalizeAsr({}).hotkey, hotkey.DEFAULT_HOTKEY);
});

test('validateHotkey / checkHotkey: in-app combinations are conflicts (per platform), "" is off', () => {
  const c = settingsLib.validateHotkey('mod+comma', 'linux');
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'conflict');
  assert.match(c.message, /打开设置/);
  assert.match(c.message, /Ctrl\+,/);
  // Ctrl+, on macOS is not ⌘, (CommandOrControl is Command there)
  assert.equal(settingsLib.validateHotkey('ctrl+comma', 'darwin').ok, true);
  assert.equal(settingsLib.validateHotkey('ctrl+comma', 'linux').ok, false);
  assert.equal(settingsLib.validateHotkey('cmd+comma', 'darwin').reason, 'conflict');
  assert.equal(settingsLib.validateHotkey('mod+shift+z', 'win32').reason, 'conflict');
  assert.deepEqual(settingsLib.validateHotkey('', 'linux'), { ok: true, accelerator: '' });
  assert.equal(settingsLib.validateHotkey('shift+a', 'linux').reason, 'invalid');
  assert.deepEqual(settingsLib.validateHotkey('mod+shift+space', 'linux'), { ok: true, accelerator: 'CommandOrControl+Shift+Space' });
});

test('applyAsrPatch: a bad or conflicting hotkey is not taken and the old one stays', () => {
  const cur = asrLib.normalizeAsr({ hotkey: 'Alt+Shift+V' });
  let r = asrLib.applyAsrPatch(cur, { hotkey: 'shift' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['bad-hotkey']);
  assert.equal(r.asr.hotkey, 'Alt+Shift+V');
  r = asrLib.applyAsrPatch(cur, { hotkey: 'CmdOrCtrl+,' });
  assert.deepEqual(r.errors, ['hotkey-conflict']);
  assert.equal(r.asr.hotkey, 'Alt+Shift+V');
  r = asrLib.applyAsrPatch(cur, { hotkey: 'mod+shift+space' });
  assert.equal(r.ok, true);
  assert.equal(r.asr.hotkey, 'CommandOrControl+Shift+Space');
  r = asrLib.applyAsrPatch(cur, { hotkey: '' });
  assert.equal(r.asr.hotkey, '');
});

test('labels and HotkeyInput keys', () => {
  assert.equal(hotkey.labelFor('CommandOrControl+Shift+Space', 'darwin'), '⌘⇧Space');
  assert.equal(hotkey.labelFor('CommandOrControl+Shift+Space', 'linux'), 'Ctrl+Shift+Space');
  assert.equal(hotkey.labelFor('Control+Alt+K', 'win32'), 'Ctrl+Alt+K');
  assert.equal(hotkey.labelFor('', 'linux'), '');
  assert.equal(hotkey.toHotkeyKeys('CommandOrControl+Shift+Space'), 'mod+shift+space');
  assert.equal(hotkey.toHotkeyKeys('CommandOrControl+,'), 'mod+comma');
  // round trip through the settings window's format
  for (const acc of ['CommandOrControl+Shift+Space', 'Control+Alt+K', 'Alt+Shift+F5', 'CommandOrControl+Shift+Z', 'Alt+`', 'Control+Up']) {
    assert.equal(hotkey.parseAccelerator(hotkey.toHotkeyKeys(acc)).accelerator, acc, acc);
  }
});

// ---- the settings schema (what the settings window saves through) ------------------------------------------
test('schema: asr.hotkey is a hotkey field on the 语音输入 page with its default, reserved list and checks', () => {
  const f = schema.field('asr.hotkey');
  assert.equal(f.type, 'hotkey');
  assert.equal(f.page, 'asr');
  assert.equal(f.default, 'CommandOrControl+Shift+Space');
  assert.equal(f.defaultKeys, 'mod+shift+space');
  assert.ok(f.live);
  assert.ok(f.reserved.some((r) => r.keys === 'mod+comma' && r.accelerator === 'CommandOrControl+,' && /设置/.test(r.label)));
  // the settings page writes the in-app conflict the way main does: 和应用内的「打开设置」（Ctrl+,）冲突，换一个组合
  assert.equal(hotkey.checkHotkey('CommandOrControl+,', 'linux').message, '和应用内的「打开设置」（Ctrl+,）冲突，换一个组合');
  assert.equal(hotkey.checkHotkey('CommandOrControl+,', 'darwin').message, '和应用内的「打开设置」（⌘,）冲突，换一个组合');
  assert.deepEqual(schema.validate('asr.hotkey', 'mod+shift+space'), { ok: true, value: 'CommandOrControl+Shift+Space' });
  assert.deepEqual(schema.validate('asr.hotkey', ''), { ok: true, value: '' });
  assert.equal(schema.validate('asr.hotkey', 'shift+a').reason, 'bad-hotkey');
  assert.equal(schema.validate('asr.hotkey', 'ctrl').reason, 'bad-hotkey');
  assert.equal(schema.validate('asr.hotkey', 'mod+comma').reason, 'hotkey-conflict');
  assert.equal(schema.validate('asr.hotkey', 5).reason, 'type');
  assert.deepEqual(schema.patchFor('asr.hotkey', 'Alt+K'), { setter: 'setAsr', patch: { hotkey: 'Alt+K' } });
});

// ---- the registration state machine ------------------------------------------------------------------------
function fakeShortcuts({ taken = [], throws = [] } = {}) {
  const reg = new Map();
  const calls = [];
  return {
    reg,
    calls,
    register(acc, cb) {
      calls.push(['register', acc]);
      if (throws.includes(acc)) throw new Error(`conversion failure from ${acc}`);
      if (taken.includes(acc) || reg.has(acc)) return false;
      reg.set(acc, cb);
      return true;
    },
    unregister(acc) { calls.push(['unregister', acc]); reg.delete(acc); },
    unregisterAll() { calls.push(['unregisterAll']); reg.clear(); },
    isRegistered: (acc) => reg.has(acc),
    press(acc) { const cb = reg.get(acc); if (cb) cb(); return !!cb; },
  };
}

test('VoiceHotkey: registers at start, pressing it triggers, a change lets the old one go first', () => {
  const sc = fakeShortcuts();
  const hits = [];
  const vh = new VoiceHotkey({ shortcuts: sc, onTrigger: (p) => hits.push(p), platform: 'linux' });
  assert.equal(vh.status().state, 'disabled');
  let st = vh.apply('CommandOrControl+Shift+Space');
  assert.equal(st.state, 'ok');
  assert.equal(st.label, 'Ctrl+Shift+Space');
  assert.equal(st.keys, 'mod+shift+space');
  assert.ok(sc.isRegistered('CommandOrControl+Shift+Space'));
  assert.ok(sc.press('CommandOrControl+Shift+Space'));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'shortcut');
  assert.equal(hits[0].label, 'Ctrl+Shift+Space');
  // the same again: nothing is re-registered
  const n = sc.calls.length;
  vh.apply('CommandOrControl+Shift+Space');
  assert.equal(sc.calls.length, n);
  // a new one: old let go, new one registered
  st = vh.apply('Alt+Shift+V');
  assert.equal(st.state, 'ok');
  assert.deepEqual(sc.calls.slice(n), [['unregister', 'CommandOrControl+Shift+Space'], ['register', 'Alt+Shift+V']]);
  assert.ok(!sc.isRegistered('CommandOrControl+Shift+Space'));
  assert.ok(!sc.press('CommandOrControl+Shift+Space'));
  assert.ok(sc.press('Alt+Shift+V'));
  assert.equal(vh.status().triggers, 2);
});

test('VoiceHotkey: cleared = disabled and nothing registered; quit unregisters all', () => {
  const sc = fakeShortcuts();
  const vh = new VoiceHotkey({ shortcuts: sc, platform: 'linux' });
  vh.apply('Alt+Shift+V');
  assert.equal(vh.apply('').state, 'disabled');
  assert.equal(sc.reg.size, 0);
  vh.apply('Alt+Shift+V');
  vh.dispose();
  assert.deepEqual(sc.calls.at(-1), ['unregisterAll']);
  assert.equal(sc.reg.size, 0);
  assert.equal(vh.status().state, 'disabled');
});

test('VoiceHotkey: register() false or throwing = conflict (taken), and the next try works once it is free', () => {
  const sc = fakeShortcuts({ taken: ['Control+Alt+K'], throws: ['Alt+Shift+F1'] });
  const logs = [];
  const vh = new VoiceHotkey({ shortcuts: sc, platform: 'linux', log: (e) => logs.push(e) });
  vh.apply('Alt+Shift+V');
  let st = vh.apply('Control+Alt+K');
  assert.equal(st.state, 'conflict');
  assert.equal(st.code, 'taken');
  assert.match(st.message, /占用/);
  assert.equal(vh.current, '');
  assert.ok(!sc.isRegistered('Alt+Shift+V')); // the old one was let go before trying
  st = vh.apply('Alt+Shift+F1');
  assert.equal(st.state, 'conflict');
  assert.match(st.error, /conversion failure/);
  assert.equal(logs.length, 1);
  // the same accelerator after it became free: tried again (state was not ok)
  const sc2 = fakeShortcuts({ taken: ['Control+Alt+K'] });
  const vh2 = new VoiceHotkey({ shortcuts: sc2, platform: 'linux' });
  assert.equal(vh2.apply('Control+Alt+K').state, 'conflict');
  sc2.register = (acc, cb) => { sc2.reg.set(acc, cb); return true; };
  assert.equal(vh2.apply('Control+Alt+K').state, 'ok');
});

test('VoiceHotkey: invalid and in-app combinations from a hand-edited file are reported, not registered', () => {
  const sc = fakeShortcuts();
  const vh = new VoiceHotkey({ shortcuts: sc, platform: 'linux' });
  let st = vh.apply('Shift+A');
  assert.equal(st.state, 'invalid');
  assert.equal(st.code, 'shift-only');
  st = vh.apply('CommandOrControl+,');
  assert.equal(st.state, 'conflict');
  assert.equal(st.code, 'reserved');
  assert.match(st.message, /打开设置/);
  assert.equal(sc.reg.size, 0);
});

test('VoiceHotkey.probe: free → ok and let go again; taken → conflict; the shortcut in use is untouched', () => {
  const sc = fakeShortcuts({ taken: ['Control+Alt+K'] });
  const vh = new VoiceHotkey({ shortcuts: sc, platform: 'linux' });
  vh.apply('Alt+Shift+V');
  assert.equal(vh.probe('Control+Alt+K').state, 'conflict');
  assert.equal(vh.probe('Control+Alt+J').state, 'ok');
  assert.ok(!sc.isRegistered('Control+Alt+J'));
  assert.equal(vh.probe('Alt+Shift+V').state, 'ok'); // the one in use
  assert.ok(sc.isRegistered('Alt+Shift+V'));
  assert.equal(vh.probe('shift+x').state, 'invalid');
  assert.equal(vh.probe('').state, 'disabled');
});

// ---- the settings window path end to end: admin-set → schema → probe → setAsr → settings event → apply ------
test('admin-set asr.hotkey: saves and re-registers; invalid / in-app / taken combinations are not saved', async () => {
  const sc = fakeShortcuts({ taken: ['Control+Alt+K'] });
  const vh = new VoiceHotkey({ shortcuts: sc, platform: 'linux' });
  const svc = new PetService({ lh: null, store: null, hotkeyStatus: () => vh.status() });
  svc.on('error', () => {});
  svc.on('settings', () => vh.apply(svc.settings.asr.hotkey)); // main.js does the same before broadcasting
  vh.apply(svc.settings.asr.hotkey);
  assert.equal(svc.settingsView().hotkeyStatus.state, 'ok');
  const admin = createAdminSettings({ service: svc, hooks: { probeHotkey: (a) => vh.probe(a) } });

  let r = await admin.set('asr.hotkey', 'alt+shift+v');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'Alt+Shift+V');
  assert.equal(r.settings.hotkeyStatus.state, 'ok');
  assert.equal(r.settings.hotkeyStatus.accelerator, 'Alt+Shift+V');
  assert.ok(sc.isRegistered('Alt+Shift+V'));
  assert.ok(!sc.isRegistered('CommandOrControl+Shift+Space'));

  r = await admin.set('asr.hotkey', 'shift+a');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-hotkey');
  assert.equal(svc.settings.asr.hotkey, 'Alt+Shift+V');

  r = await admin.set('asr.hotkey', 'mod+comma');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hotkey-conflict');
  assert.match(r.message, /打开设置/);

  r = await admin.set('asr.hotkey', 'ctrl+alt+k');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'hotkey-taken');
  assert.match(r.message, /占用/);
  assert.equal(svc.settings.asr.hotkey, 'Alt+Shift+V');
  assert.ok(sc.isRegistered('Alt+Shift+V'));

  r = await admin.set('asr.hotkey', '');
  assert.equal(r.ok, true);
  assert.equal(r.settings.hotkeyStatus.state, 'disabled');
  assert.equal(sc.reg.size, 0);

  const rr = await admin.reset(['asr.hotkey']);
  assert.equal(rr.ok, true);
  assert.equal(svc.settings.asr.hotkey, 'CommandOrControl+Shift+Space');
  assert.ok(sc.isRegistered('CommandOrControl+Shift+Space'));
});
