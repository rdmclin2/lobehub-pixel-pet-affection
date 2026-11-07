'use strict';
// 桌面壁纸 · the three platform backends on simulated systems (docs/wallpaper-mode.md §1): Linux (xprop / gsettings
// answers made up here), macOS (osascript answers made up here), Windows (the Node fake of the helper exe,
// test/fixtures/fake-desktop-helper.js, speaking the real protocol). What each would do on a real machine is
// listed as unverified in the PR; these check the commands, options, parsing and failure paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLinuxBackend } = require('../src/main/wallpaper/linux');
const { createMacBackend, ICON_LEVEL, DESKTOP_LEVEL } = require('../src/main/wallpaper/mac');
const { HelperClient, createWinBackend } = require('../src/main/wallpaper/win-helper');

// a fake Electron window: records what was asked of it
function fakeWin(xid = 0x400020) {
  const calls = [];
  const handle = Buffer.alloc(8);
  handle.writeUInt32LE(xid, 0);
  return {
    calls, destroyed: false, visible: false,
    getNativeWindowHandle: () => handle,
    setIgnoreMouseEvents: (...a) => calls.push(['setIgnoreMouseEvents', ...a]),
    showInactive() { this.visible = true; calls.push(['showInactive']); },
    setBounds: (b) => calls.push(['setBounds', b]),
    setVisibleOnAllWorkspaces: (...a) => calls.push(['setVisibleOnAllWorkspaces', ...a]),
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
  };
}
const display = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 0, width: 1280, height: 760 } };
// run(cmd, args) answered from a table: key `cmd args…` → { ok, out } | 'missing'
const fakeRun = (table, log = []) => async (cmd, args = []) => {
  const key = [cmd, ...args].join(' ');
  log.push(key);
  for (const [k, v] of Object.entries(table)) {
    if (key === k || (k.endsWith('*') && key.startsWith(k.slice(0, -1)))) {
      if (v === 'missing') return { ok: false, missing: true, out: '', err: 'ENOENT' };
      return { ok: v.ok !== false, missing: false, out: v.out || '', err: '' };
    }
  }
  return { ok: false, missing: false, out: '', err: 'no answer' };
};

// ---- Linux --------------------------------------------------------------------------------------------------
test('Linux X11: an EWMH WM → live; no WM → no-wm; no xprop at all → live (the self-check decides)', async () => {
  const wm = createLinuxBackend({ env: { XDG_SESSION_TYPE: 'x11' }, run: fakeRun({ 'xprop -root _NET_SUPPORTING_WM_CHECK': { out: '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x20011f' } }) });
  assert.deepEqual(await wm.availability(), { ok: true, mode: 'live', session: 'x11', wm: 'ewmh' });
  const none = createLinuxBackend({ env: {}, run: fakeRun({ 'xprop -root _NET_SUPPORTING_WM_CHECK': { ok: false, out: '_NET_SUPPORTING_WM_CHECK:  not found.' } }) });
  assert.deepEqual(await none.availability(), { ok: false, mode: 'live', reason: 'no-wm', session: 'x11', wm: 'none' });
  const noXprop = createLinuxBackend({ env: {}, run: fakeRun({ 'xprop*': 'missing' }) });
  assert.equal((await noXprop.availability()).ok, true);
});

test('Linux X11: the window is type desktop, never focusable:false (P8: override-redirect on top); attach = click-through, shown inactive, sized', async () => {
  const b = createLinuxBackend({ env: {}, run: fakeRun({}) });
  const o = b.windowOptions(display);
  assert.equal(o.type, 'desktop');
  assert.equal('focusable' in o, false, 'focusable:false would make an override-redirect window that covers everything');
  assert.equal(o.skipTaskbar, true);
  assert.deepEqual([o.x, o.y, o.width, o.height], [0, 0, 1280, 800]);
  const w = fakeWin();
  const r = await b.attach(w, display);
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls, [['setIgnoreMouseEvents', true], ['showInactive'], ['setBounds', display.bounds]]);
});

test('Linux X11 probe: window type, _NET_WM_STATE, override-redirect, place in the stacking order, X input shape (click-through)', async () => {
  const b = createLinuxBackend({ env: {}, run: fakeRun({
    'xprop -id 0x400020 _NET_WM_WINDOW_TYPE': { out: '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DESKTOP' },
    'xprop -id 0x400020 _NET_WM_STATE': { out: '_NET_WM_STATE(ATOM) = _NET_WM_STATE_SKIP_TASKBAR, _NET_WM_STATE_BELOW' },
    'xwininfo -id 0x400020': { out: '  Map State: IsViewable\n  Override Redirect State: no\n  -geometry 1280x800+0+0' },
    'python3*': { out: 'bounding 1280x800+0+0\ninput 1x1+0+0\n' },
    'xprop -root _NET_CLIENT_LIST_STACKING': { out: '_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x400020, 0x60001b' },
    'xprop -root _NET_ACTIVE_WINDOW': { out: '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x60001b' },
  }) });
  const p = await b.probe(fakeWin(), { shape: true });
  assert.deepEqual(p.windowType, ['_NET_WM_WINDOW_TYPE_DESKTOP']);
  assert.deepEqual(p.wmState, ['_NET_WM_STATE_SKIP_TASKBAR', '_NET_WM_STATE_BELOW']);
  assert.equal(p.overrideRedirect, 'no');
  assert.deepEqual(p.stacking, { index: 0, of: 2, bottom: true, above: ['0x60001b'] });
  assert.deepEqual([p.inputShape, p.inputArea, p.windowArea, p.clickThrough], [['1x1+0+0'], 1, 1024000, true]);
  // a window that takes input: its whole area
  const solid = createLinuxBackend({ env: {}, run: fakeRun({ 'xprop -id 0x400020 _NET_WM_WINDOW_TYPE': { out: '= _NET_WM_WINDOW_TYPE_DESKTOP' }, 'python3*': { out: 'bounding 1280x800+0+0\ninput 1280x800+0+0\n' } }) });
  assert.equal((await solid.probe(fakeWin(), { shape: true })).clickThrough, false);
  assert.equal(p.isActive, false);
  assert.equal((await b.selfCheck(fakeWin())).ok, true);
  // an override-redirect window (what focusable:false makes) fails the self-check
  const or = createLinuxBackend({ env: {}, run: fakeRun({ 'xprop -id 0x400020 _NET_WM_WINDOW_TYPE': { out: '= _NET_WM_WINDOW_TYPE_DESKTOP' }, 'xwininfo -id 0x400020': { out: 'Override Redirect State: yes' } }) });
  assert.deepEqual([(await or.selfCheck(fakeWin())).ok, (await or.selfCheck(fakeWin())).reason], [false, 'self-check-failed']);
});

test('Linux: covered = the active window is fullscreen; other DESKTOP windows (the desktop icons) are found', async () => {
  const b = createLinuxBackend({ env: {}, run: fakeRun({
    'xprop -root _NET_ACTIVE_WINDOW': { out: 'window id # 0x777' },
    'xprop -id 0x777 _NET_WM_STATE': { out: '_NET_WM_STATE(ATOM) = _NET_WM_STATE_FULLSCREEN' },
    'xprop -root _NET_CLIENT_LIST': { out: 'window id # 0x400020, 0x888' },
    'xprop -id 0x888 _NET_WM_WINDOW_TYPE': { out: '= _NET_WM_WINDOW_TYPE_DESKTOP' },
  }) });
  assert.equal(await b.covered(), true);
  assert.deepEqual(await b.otherDesktopWindows([fakeWin()]), ['0x888']);
});

test('Linux Wayland: no live wallpaper; GNOME → static via gsettings (set, then the old value restored); others → wayland-unsupported', async () => {
  const log = [];
  const gnome = createLinuxBackend({ env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' }, run: fakeRun({
    'gsettings get org.gnome.desktop.background picture-uri': { out: "'file:///usr/share/backgrounds/old.png'\n" },
    'gsettings get org.gnome.desktop.background picture-uri-dark': { out: "'file:///usr/share/backgrounds/old-d.png'\n" },
    'gsettings set*': { out: '' },
  }, log) });
  assert.deepEqual(await gnome.availability(), { ok: true, mode: 'static', session: 'wayland', staticKind: 'gnome', forced: true });
  assert.equal((await gnome.setStatic('/data/wallpaper/static-1.png')).ok, true);
  await gnome.restoreStatic();
  const sets = log.filter((l) => l.startsWith('gsettings set'));
  assert.deepEqual(sets, [
    'gsettings set org.gnome.desktop.background picture-uri file:///data/wallpaper/static-1.png',
    'gsettings set org.gnome.desktop.background picture-uri-dark file:///data/wallpaper/static-1.png',
    'gsettings set org.gnome.desktop.background picture-uri file:///usr/share/backgrounds/old.png',
    'gsettings set org.gnome.desktop.background picture-uri-dark file:///usr/share/backgrounds/old-d.png',
  ]);
  const sway = createLinuxBackend({ env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'sway' }, run: fakeRun({ 'gsettings*': 'missing' }) });
  assert.deepEqual(await sway.availability(), { ok: false, mode: 'static', reason: 'wayland-unsupported', session: 'wayland' });
});

test('Linux KDE Wayland: static via plasma-apply-wallpaperimage, the old picture read from the applets file and put back', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-kde-'));
  fs.mkdirSync(path.join(home, '.config'));
  fs.writeFileSync(path.join(home, '.config', 'plasma-org.kde.plasma.desktop-appletsrc'), '[Wallpaper][org.kde.image][General]\nImage=file:///home/u/old.jpg\n');
  const log = [];
  const kde = createLinuxBackend({ home, env: { XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' }, run: fakeRun({ 'plasma-apply-wallpaperimage*': { out: '' } }, log) });
  assert.equal((await kde.availability()).staticKind, 'kde');
  await kde.setStatic('/data/s.png');
  await kde.restoreStatic();
  assert.deepEqual(log.filter((l) => !l.endsWith('--help')), ['plasma-apply-wallpaperimage /data/s.png', 'plasma-apply-wallpaperimage /home/u/old.jpg']);
});

// ---- macOS --------------------------------------------------------------------------------------------------
test('macOS: type desktop + focusable:false + every Space; attach = all workspaces (not full-screen ones), click-through, inactive', async () => {
  const b = createMacBackend({ run: fakeRun({}) });
  const o = b.windowOptions(display);
  assert.equal(o.type, 'desktop');
  assert.equal(o.focusable, false);
  assert.equal(o.enableLargerThanScreen, true);
  assert.match(o.title, /^pixel-pet-wallpaper-1$/);
  const w = fakeWin();
  await b.attach(w, display);
  assert.deepEqual(w.calls[0], ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: false }]);
  assert.deepEqual(w.calls[1], ['setIgnoreMouseEvents', true]);
  assert.deepEqual(w.calls[2], ['showInactive']);
});

test('macOS self-check: our kCGWindowLayer below Finder\'s desktop icons passes; not below → self-check-failed (the host then goes static)', async () => {
  const below = createMacBackend({ run: fakeRun({ 'osascript*': { out: JSON.stringify({ ours: [{ name: 'pixel-pet-wallpaper-1', layer: DESKTOP_LEVEL - 1 }], finder: [{ layer: ICON_LEVEL }] }) } }) });
  const c = await below.selfCheck();
  assert.deepEqual([c.ok, c.probe.below, c.probe.layer < c.probe.iconLayer], [true, true, true]);
  const above = createMacBackend({ run: fakeRun({ 'osascript*': { out: JSON.stringify({ ours: [{ name: 'pixel-pet-wallpaper-1', layer: 0 }], finder: [{ layer: ICON_LEVEL }] }) } }) });
  assert.deepEqual([(await above.selfCheck()).ok, (await above.selfCheck()).reason], [false, 'self-check-failed']);
});

test('macOS static: the desktop pictures are read first, ours is set through NSWorkspace, the old ones set back on exit', async () => {
  const log = [];
  let n = 0;
  const run = async (cmd, args) => { log.push(args[3]); n += 1; return { ok: true, out: n === 1 ? JSON.stringify(['/Library/Desktop/old.heic']) : 'ok' }; };
  const b = createMacBackend({ run });
  assert.equal((await b.setStatic('/data/static-1.png')).ok, true);
  await b.restoreStatic();
  assert.match(log[0], /desktopImageURLForScreen/);
  assert.match(log[1], /setDesktopImageURLForScreenOptionsError/);
  assert.match(log[1], /static-1\.png/);
  assert.match(log[2], /old\.heic/);
});

// ---- Windows (the fake helper) -------------------------------------------------------------------------------
const FAKE = path.join(__dirname, 'fixtures', 'fake-desktop-helper.js');
const helper = (mode, extra = {}) => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-helper-')), 'log.jsonl');
  const spawn = (exe, args, opts) => require('node:child_process').spawn(exe, args, { ...opts, env: { ...process.env, FAKE_HELPER_MODE: mode, FAKE_HELPER_LOG: logFile } });
  const c = new HelperClient({ command: [process.execPath, FAKE], spawn, timeoutMs: 400, ...extra });
  c.logFile = logFile;
  return c;
};
const sent = (c) => (fs.existsSync(c.logFile) ? fs.readFileSync(c.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const screen = { dipToScreenRect: (_w, r) => ({ x: r.x * 1.5, y: r.y * 1.5, width: r.width * 1.5, height: r.height * 1.5 }) };

test('Windows: attach sends the HWND and the physical rect (150 % scale), answers with the layout; status / detach', async () => {
  const c = helper('ok');
  const b = createWinBackend({ client: c, screen });
  assert.equal((await b.availability()).ok, true);
  const o = b.windowOptions(display);
  assert.equal(o.focusable, false);
  assert.equal(o.webPreferences.backgroundThrottling, false, 'pausing is the helper\'s call, not Chromium\'s occlusion');
  const w = fakeWin(0x1a2b3c);
  const r = await b.attach(w, display);
  assert.deepEqual([r.ok, r.layout, r.workerw], [true, '24h2', '0x10052']);
  assert.deepEqual(w.calls, [['showInactive']]);
  assert.deepEqual(sent(c)[0], { id: 1, cmd: 'attach', hwnd: '0x1a2b3c', rect: { x: 0, y: 0, w: 1920, h: 1200 } });
  assert.equal((await b.status(w)).attached, true);
  assert.equal((await b.selfCheck(w)).ok, true);
  await b.detach(w);
  assert.equal((await b.status(w)).attached, false);
  b.dispose();
});

test('Windows: no WorkerW → no-workerw; a hung helper → timeout after 3 s (here 0.4 s) → helper-failed', async () => {
  const nw = createWinBackend({ client: helper('no-workerw'), screen });
  assert.deepEqual([(await nw.attach(fakeWin(), display)).ok, (await nw.attach(fakeWin(), display)).reason], [false, 'no-workerw']);
  nw.dispose();
  const hung = createWinBackend({ client: helper('hang'), screen });
  const t0 = Date.now();
  const r = await hung.attach(fakeWin(), display);
  assert.deepEqual([r.ok, r.reason], [false, 'helper-failed']);
  assert.equal(r.detail.reason, 'timeout');
  assert.ok(Date.now() - t0 >= 380);
  hung.dispose();
});

test('Windows: the helper crashing is restarted once; crashing again → dead (the host leaves wallpaper mode: helper-failed)', async () => {
  const c = helper('crash');
  const events = [];
  c.on('restarted', (e) => events.push(['restarted', e.ok]));
  c.on('dead', () => events.push(['dead']));
  const r1 = await c.request('status', { hwnd: '0x1' });
  assert.equal(r1.reason, 'helper-failed');
  await new Promise((r) => setTimeout(r, 100));
  const r2 = await c.request('status', { hwnd: '0x1' });
  assert.equal(r2.reason, 'helper-failed');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events, [['restarted', true], ['dead']]);
  assert.equal((await c.request('status', { hwnd: '0x1' })).reason, 'helper-failed', 'dead: not started again');
});

test('Windows: Explorer restarting arrives as shell-restarted; occlusion events come through', async () => {
  const c = helper('restart');
  const b = createWinBackend({ client: c, screen });
  const got = [];
  b.on('shell-restarted', () => got.push('shell-restarted'));
  const w = fakeWin(0x55);
  await b.attach(w, display);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(got, ['shell-restarted']);
  assert.equal((await b.status(w)).attached, false, 'the WorkerW is gone: parentAlive false');
  assert.equal((await b.attach(w, display)).ok, true, 'attached again');
  b.dispose();
  const o = createWinBackend({ client: helper('occlude'), screen });
  const occ = [];
  o.on('occluded', (m) => occ.push(m.on));
  await o.attach(fakeWin(), display);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(occ, [true, false]);
  o.dispose();
});

test('Windows: no helper in this build → helper-missing; a replaced exe (sha256 differs from helper.json) → helper-tampered, never started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hdir-'));
  assert.deepEqual(await createWinBackend({ helperDir: dir }).availability(), { ok: false, mode: 'live', reason: 'helper-missing' });
  const manifest = { file: 'pixelpet-desktop-helper.exe', sha256: crypto.createHash('sha256').update('MZ the real one').digest('hex') };
  fs.writeFileSync(path.join(dir, 'pixelpet-desktop-helper.exe'), 'MZ something else');
  let spawned = false;
  const b = createWinBackend({ helperDir: dir, manifest, spawn: () => { spawned = true; throw new Error('must not run'); } });
  assert.deepEqual(await b.availability(), { ok: false, mode: 'live', reason: 'helper-tampered' });
  assert.equal(spawned, false);
  // the shipped helper.json (stamped by scripts/build-win-helper.js; test/wallpaper-win-helper.test.js checks it)
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'wallpaper', 'helper.json'), 'utf8'));
  assert.equal(shipped.file, 'pixelpet-desktop-helper.exe');
});
