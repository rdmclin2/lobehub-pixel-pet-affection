'use strict';

// 快捷调用面板 (T-2849, docs/quick-panel.md): rows, filtering, keyboard moves, update state → feedback text,
// placement inside the screen, and the global shortcut with its fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('../src/core/quick-panel');
const hotkeyLib = require('../src/core/hotkey');
const { QuickHotkey } = require('../src/main/quick-hotkey');

const ROOT = path.join(__dirname, '..');
const labels = (items) => items.map((i) => (i.type === 'separator' ? '—' : i.label));

test('rows: grouped like the reference menu — 关于 / 检查更新…, 偏好设置…, the pet actions, 退出', () => {
  const items = Q.buildItems({ hasPet: true, petVisible: true, canReset: true, version: '0.24.0' });
  assert.deepEqual(labels(items), ['关于 Pixel Pet', '检查更新…', '—', '偏好设置…', '—', '和她聊天', '重置姿势', '隐藏桌宠', '—', '退出']);
  assert.equal(items[0].detail, 'v0.24.0');
  assert.equal(items.find((i) => i.id === 'settings').keys, 'CommandOrControl+,');
  assert.equal(items.find((i) => i.id === 'quit').keys, 'CommandOrControl+Q');
  for (const it of items.filter((i) => i.id)) assert.ok(it.icon, `${it.id} has an icon`);
});

test('rows follow the pet: no 重置姿势 without a VRM look, 显示桌宠 when she is hidden, no 聊天 before a pet exists', () => {
  assert.deepEqual(labels(Q.buildItems({ hasPet: true, petVisible: true, canReset: false })), ['关于 Pixel Pet', '检查更新…', '—', '偏好设置…', '—', '和她聊天', '隐藏桌宠', '—', '退出']);
  assert.deepEqual(labels(Q.buildItems({ hasPet: true, petVisible: false, canReset: true })), ['关于 Pixel Pet', '检查更新…', '—', '偏好设置…', '—', '重置姿势', '显示桌宠', '—', '退出']);
  assert.deepEqual(labels(Q.buildItems({ hasPet: false, petVisible: true })), ['关于 Pixel Pet', '检查更新…', '—', '偏好设置…', '—', '隐藏桌宠', '—', '退出']);
  // 检查更新… and 偏好设置… are always there (the settings stay one step away)
  for (const ctx of [{}, { hasPet: false }, { petVisible: false }]) {
    const ids = Q.buildItems(ctx).map((i) => i.id);
    assert.ok(ids.includes('check-update') && ids.includes('settings') && ids.includes('quit'));
  }
});

test('every row id has an action in main (the panel lists only what really works)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const block = main.slice(main.indexOf('const quickActions = {'), main.indexOf('};', main.indexOf('const quickActions = {')));
  for (const id of Object.keys(Q.ITEMS).filter((k) => k !== 'check-update')) assert.match(block, new RegExp(`\\n  '?${id}'?: `), `${id} has an action`);
  for (const id of ['install', 'open-download']) assert.match(block, new RegExp(`'?${id}'?: `));
  // 检查更新… is the tray's own Updater.checkNow(), not a second checker
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'main', 'quick-panel.js'), 'utf8');
  assert.match(panel, /this\.updater\.checkNow\(\)/);
  assert.ok(!/net\.fetch|https?:\/\//.test(panel), 'no update request of its own');
});

test('typing filters by label or extra words (Chinese, English, several words); separators go while filtering', () => {
  const items = Q.buildItems({ hasPet: true, petVisible: true, canReset: true, version: '1.0.0' });
  assert.deepEqual(labels(Q.filterItems(items, '更新')), ['检查更新…']);
  assert.deepEqual(labels(Q.filterItems(items, 'update')), ['检查更新…']);
  assert.deepEqual(labels(Q.filterItems(items, 'UPD')), ['检查更新…']);
  assert.deepEqual(labels(Q.filterItems(items, '设置')), ['偏好设置…']);
  assert.deepEqual(labels(Q.filterItems(items, 'quit')), ['退出']);
  assert.deepEqual(labels(Q.filterItems(items, '重置 姿势')), ['重置姿势']);
  assert.deepEqual(Q.filterItems(items, 'zzz'), []);
  assert.deepEqual(Q.filterItems(items, '   '), items);
});

test('↑↓ move the highlight over rows only, wrapping, skipping separators and disabled rows', () => {
  const items = [{ id: 'a' }, { type: 'separator' }, { id: 'b', disabled: true }, { id: 'c' }, { type: 'status' }, { id: 'd' }];
  assert.equal(Q.moveActive(items, -1, 1), 0);
  assert.equal(Q.moveActive(items, 0, 1), 3);
  assert.equal(Q.moveActive(items, 3, 1), 5, 'the update status block is not a row');
  assert.equal(Q.moveActive(items, 5, 1), 0);
  assert.equal(Q.moveActive(items, -1, -1), 5);
  assert.equal(Q.moveActive(items, 0, -1), 5);
  assert.equal(Q.moveActive([], -1, 1), -1);
  assert.equal(Q.moveActive([{ type: 'separator' }], -1, 1), -1);
});

test('shortcut hints read like the menu (⌘, on macOS, Ctrl+, elsewhere) and match the key presses they name', () => {
  assert.equal(Q.keyLabel('CommandOrControl+,', 'darwin'), '⌘,');
  assert.equal(Q.keyLabel('CommandOrControl+Q', 'darwin'), '⌘Q');
  assert.equal(Q.keyLabel('CommandOrControl+Shift+R', 'win32'), 'Ctrl+Shift+R');
  assert.equal(Q.keyLabel('', 'darwin'), '');
  assert.ok(Q.matchesKeys('CommandOrControl+,', { key: ',', meta: true }, 'darwin'));
  assert.ok(!Q.matchesKeys('CommandOrControl+,', { key: ',', ctrl: true }, 'darwin'));
  assert.ok(Q.matchesKeys('CommandOrControl+,', { key: ',', ctrl: true }, 'linux'));
  assert.ok(Q.matchesKeys('CommandOrControl+Shift+R', { key: 'R', code: 'KeyR', ctrl: true, shift: true }, 'win32'));
  assert.ok(!Q.matchesKeys('CommandOrControl+Shift+R', { key: 'r', ctrl: true }, 'win32'), 'Shift missing');
  assert.ok(!Q.matchesKeys('CommandOrControl+Q', { key: 'q' }, 'linux'), 'plain q is typing, not quit');
});

test('update state → feedback: 检查中 / 已是最新 (current version) / 发现新版本 (version + next step) / 失败 (reason + 重试) / 开发版', () => {
  const base = { current: '0.24.0', version: null, error: null };
  assert.equal(Q.updateFeedback(null), null);
  assert.equal(Q.updateFeedback({ ...base, status: 'idle' }), null);
  assert.deepEqual(Q.updateFeedback({ ...base, status: 'checking' }), { status: 'checking', tone: 'loading', title: '正在检查更新…', detail: '当前版本 v0.24.0', action: null });
  assert.deepEqual(Q.updateFeedback({ ...base, status: 'latest' }), { status: 'latest', tone: 'success', title: '已是最新版本', detail: '当前版本 v0.24.0', action: null });
  const dl = Q.updateFeedback({ ...base, status: 'downloading', version: '0.25.0' });
  assert.equal(dl.title, '发现新版本 v0.25.0');
  assert.match(dl.detail, /正在后台下载/);
  assert.equal(dl.action, null);
  const ready = Q.updateFeedback({ ...base, status: 'ready', version: '0.25.0' });
  assert.equal(ready.title, '新版本 v0.25.0 已下载好');
  assert.deepEqual(ready.action, { id: 'install', label: '立即更新' });
  const manual = Q.updateFeedback({ ...base, status: 'manual', version: '9.9.9', url: 'https://x' });
  assert.equal(manual.title, '发现新版本 v9.9.9');
  assert.deepEqual(manual.action, { id: 'open-download', label: '前往下载页' });
  assert.match(Q.updateFeedback({ ...base, status: 'manual', version: '9.9.9', error: 'translocated' }).detail, /从“下载”里直接打开/);
  const err = Q.updateFeedback({ ...base, status: 'error', error: 'GET http://127.0.0.1:1/releases/latest -> HTTP 500' });
  assert.equal(err.title, '检查更新失败');
  assert.equal(err.tone, 'error');
  assert.equal(err.detail, '更新服务器返回 500');
  assert.deepEqual(err.action, { id: 'retry', label: '重试' });
  assert.match(Q.updateFeedback({ ...base, status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' }).detail, /^连不上更新服务器/);
  assert.match(Q.updateFeedback({ ...base, status: 'error', error: '' }).detail, /未知原因/);
  const off = Q.updateFeedback({ ...base, status: 'disabled' });
  assert.equal(off.title, '当前版本不检查更新');
  assert.match(off.detail, /开发版（从源码运行）.*当前版本 v0\.24\.0/);
  assert.equal(off.tone, 'warning');
});

test('feedback line for her bubble when the panel closed before the answer', () => {
  assert.equal(Q.feedbackLine(null), '');
  assert.equal(Q.feedbackLine(Q.updateFeedback({ status: 'checking', current: '1.0.0' })), '');
  assert.equal(Q.feedbackLine(Q.updateFeedback({ status: 'latest', current: '1.0.0' })), '（已是最新版本：当前版本 v1.0.0。）');
  assert.equal(Q.feedbackLine(Q.updateFeedback({ status: 'error', error: 'HTTP 503' })), '（检查更新失败：更新服务器返回 503。右键我打开快捷调用面板，点「重试」。）');
});

test('placement: like a context menu, flipped and clamped so the whole panel stays on screen', () => {
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const size = { w: 264, h: 300 };
  assert.deepEqual(Q.placePanel({ anchor: { x: 100, y: 100 }, size, area }), { x: 100, y: 100, width: 264, height: 300 });
  // pet at the right edge: opens to the left of the point
  assert.deepEqual(Q.placePanel({ anchor: { x: 1430, y: 100 }, size, area }), { x: 1430 - 264, y: 100, width: 264, height: 300 });
  // at the bottom: opens upwards
  assert.equal(Q.placePanel({ anchor: { x: 100, y: 880 }, size, area }).y, 880 - 300);
  // off screen (a pet dragged half out): clamped inside with the margin
  const b = Q.placePanel({ anchor: { x: -200, y: -50 }, size, area });
  assert.deepEqual([b.x, b.y], [8, 33]);
  // second display left of the main one
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  const c = Q.placePanel({ anchor: { x: -10, y: 1075 }, size, area: left });
  assert.ok(c.x >= left.x + 8 && c.x + c.width <= -8 && c.y + c.height <= 1072, JSON.stringify(c));
  // taller than the screen: shrunk to fit
  const tiny = Q.placePanel({ anchor: { x: 0, y: 0 }, size: { w: 264, h: 2000 }, area: { x: 0, y: 0, width: 800, height: 600 } });
  assert.equal(tiny.height, 584);
  for (const p of [b, c, tiny]) assert.ok(p.width > 0 && p.height > 0);
});

test('placement from the shortcut: beside the pet (left if there is room), centred on the pointer when she is hidden', () => {
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  const size = { w: 264, h: 300 };
  assert.deepEqual(Q.hotkeyAnchor({ pet: { x: 1186, y: 536, width: 230, height: 340 }, size, area }), { x: 1186 - 268, y: 536 + 85 });
  assert.deepEqual(Q.hotkeyAnchor({ pet: { x: 10, y: 100, width: 230, height: 340 }, size, area }), { x: 244, y: 185 });
  assert.deepEqual(Q.hotkeyAnchor({ pet: null, size, area, cursor: { x: 700, y: 400 } }), { x: 568, y: 250 });
});

// a fake globalShortcut: `taken` combinations belong to "another app"
function fakeShortcuts(taken = [], { throwOn = [] } = {}) {
  const reg = new Map();
  return {
    reg,
    register(acc, cb) {
      if (throwOn.includes(acc)) throw new Error('bad accelerator');
      if (taken.includes(acc) || reg.has(acc)) return false;
      reg.set(acc, cb);
      return true;
    },
    unregister(acc) { reg.delete(acc); },
    unregisterAll() { reg.clear(); },
    isRegistered: (acc) => reg.has(acc),
  };
}

test('global shortcut: ⌘⌥P / Ctrl+Alt+P; pressing it toggles the panel', () => {
  let n = 0;
  const s = fakeShortcuts();
  const h = new QuickHotkey({ shortcuts: s, onTrigger: () => { n += 1; }, platform: 'linux' });
  const st = h.apply();
  assert.equal(st.state, 'ok');
  assert.equal(st.accelerator, 'CommandOrControl+Alt+P');
  assert.equal(st.label, 'Ctrl+Alt+P');
  assert.equal(st.fallback, false);
  s.reg.get('CommandOrControl+Alt+P')();
  assert.equal(n, 1);
  assert.equal(new QuickHotkey({ shortcuts: fakeShortcuts(), platform: 'darwin' }).apply().label, '⌘⌥P');
  // applying again keeps the registration (no unregister / register churn)
  assert.equal(h.apply().accelerator, 'CommandOrControl+Alt+P');
  assert.equal(s.reg.size, 1);
  h.dispose();
  assert.equal(s.reg.size, 0);
});

test('global shortcut taken by another app, failing, or equal to the voice shortcut: the fallback, then a clear state — never a crash', () => {
  const taken = new QuickHotkey({ shortcuts: fakeShortcuts(['CommandOrControl+Alt+P']), platform: 'linux' }).apply();
  assert.equal(taken.state, 'ok');
  assert.equal(taken.accelerator, 'CommandOrControl+Alt+Shift+P');
  assert.equal(taken.fallback, true);
  assert.deepEqual(taken.tried.map((t) => t.reason), ['taken']);
  const logs = [];
  const none = new QuickHotkey({ shortcuts: fakeShortcuts(['CommandOrControl+Alt+P'], { throwOn: ['CommandOrControl+Alt+Shift+P'] }), platform: 'linux', log: (e) => logs.push(e.message) }).apply();
  assert.equal(none.state, 'conflict');
  assert.deepEqual(none.tried.map((t) => t.reason), ['taken', 'error']);
  assert.equal(logs.length, 1);
  // the voice shortcut set to Ctrl+Alt+P (any spelling): the panel moves to the fallback and gives it back
  const s = fakeShortcuts();
  const h = new QuickHotkey({ shortcuts: s, platform: 'linux' });
  assert.equal(h.apply({ avoid: ['Control+Alt+P'] }).accelerator, 'CommandOrControl+Alt+Shift+P');
  assert.equal(h.apply({ avoid: [''] }).accelerator, 'CommandOrControl+Alt+Shift+P', 'kept while it works');
  assert.equal(h.apply({ avoid: ['CommandOrControl+Alt+Shift+P'] }).accelerator, 'CommandOrControl+Alt+P');
  assert.equal(s.reg.size, 1);
  // a throwing onTrigger is logged, not thrown
  const bad = new QuickHotkey({ shortcuts: fakeShortcuts(), platform: 'linux', onTrigger: () => { throw new Error('boom'); }, log: (e) => logs.push(e.message) });
  bad.apply();
  bad.trigger();
  assert.equal(logs.at(-1), 'boom');
});

test('the panel shortcut is not offered to 快捷键唤起语音对话 and differs from the app\'s own keys', () => {
  const c = hotkeyLib.checkHotkey('CommandOrControl+Alt+P', 'linux');
  assert.equal(c.ok, false);
  assert.match(c.message, /快捷调用面板/);
  for (const acc of Q.QUICK_HOTKEYS) {
    assert.ok(hotkeyLib.parseAccelerator(acc).ok);
    assert.notEqual(hotkeyLib.parseAccelerator(acc).accelerator, hotkeyLib.DEFAULT_HOTKEY, 'not the voice default');
    // none of the app's own keys (⌘, / ⌘Q / copy / paste …) other than the panel's own entry
    const r = hotkeyLib.reservedConflict(acc, 'darwin');
    assert.ok(!r || r.label === '快捷调用面板', `${acc} vs ${r && r.label}`);
  }
});

test('wiring: right click / long press open the panel; the tray lists it; the panel window is sandboxed and isolated', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'src', 'main', 'quick-panel.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'quick', 'quick.html'), 'utf8');
  assert.match(app, /onMenu: \(at\) => openQuickPanel\(at, 'long-press'\)/);
  assert.match(app, /openQuickPanel\(\{ x: e\.screenX, y: e\.screenY \}, 'right-click'\)/);
  assert.match(main, /label: '快捷调用面板…'/);
  assert.match(main, /quickHotkey\.apply\(\{ avoid: \[voiceHotkey\.current\] \}\)/);
  assert.match(panel, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
  assert.match(panel, /win\.on\('blur', \(\) => this\.close\('blur'\)\)/);
  assert.match(html, /Content-Security-Policy" content="default-src 'self'/);
  assert.match(html, /<script src="\.\.\/\.\.\/core\/quick-panel\.js"><\/script>/);
});
