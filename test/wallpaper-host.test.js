'use strict';
// 桌面壁纸 · WallpaperHost (src/main/wallpaper/host.js) on a fake Electron and a fake backend: entering / leaving and
// her desktop window, refusing with a reason (nothing half-made), 叫她出来 / 回到壁纸 / auto return, mini games,
// displays coming and going, sleep / lock, battery and covered → frame rate, Explorer restarting / a lost window /
// the watchdog, page crashes, the hotkey, persistence and the restart restore, the macOS static fallback.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WallpaperHost } = require('../src/main/wallpaper/host');
const { createWinBackend, HelperClient } = require('../src/main/wallpaper/win-helper');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'mini-wallpaper', 'manifest.json'), 'utf8'));
const D = (id, x) => ({ id, bounds: { x, y: 0, width: 1280, height: 800 }, workArea: { x, y: 0, width: 1280, height: 760 } });

function fakeElectron(displays = [D(1, 0)]) {
  const made = [];
  class BrowserWindow extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.destroyed = false;
      this.visible = false;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      this.sent = [];
      this.reloads = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        send: (ch, p) => this.sent.push([ch, p]),
        setWindowOpenHandler: () => {},
        reload: () => { this.reloads += 1; },
        capturePage: async () => ({ toPNG: () => Buffer.from('png') }),
      });
      made.push(this);
    }
    loadFile(file, o) { this.loaded = { file, ...o }; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible && !this.destroyed; }
    isFocused() { return false; }
    getBounds() { return this.bounds; }
    getTitle() { return this.opts.title; }
    showInactive() { this.visible = true; }
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeUInt32LE(0x1000 + made.indexOf(this), 0); return b; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    power() { return this.sent.filter(([c]) => c === 'wallpaper:power').map(([, p]) => p).pop(); }
  }
  const screen = Object.assign(new EventEmitter(), {
    displays,
    getAllDisplays() { return this.displays; },
    getPrimaryDisplay() { return this.displays[0]; },
    getDisplayMatching() { return this.displays[0]; },
  });
  const powerMonitor = Object.assign(new EventEmitter(), { battery: false, isOnBatteryPower() { return this.battery; } });
  return { BrowserWindow, screen, powerMonitor, made };
}

function fakeBackend(over = {}) {
  const ev = new EventEmitter();
  const calls = [];
  const b = {
    platform: 'linux', session: 'x11', calls, attached: new Set(), failAttach: 0,
    availability: async () => ({ ok: true, mode: 'live', session: 'x11' }),
    windowOptions: (d) => ({ type: 'desktop', x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }),
    attach: async (w, d) => { calls.push(['attach', d.id]); if (b.failAttach > 0) { b.failAttach -= 1; return { ok: false, reason: 'no-workerw' }; } w.visible = true; b.attached.add(w); return { ok: true, layout: 'x11-desktop' }; },
    place: async (w, d) => { calls.push(['place', d.id]); w.bounds = d.bounds; return { ok: true }; },
    detach: async () => { calls.push(['detach']); return { ok: true }; },
    status: async (w) => ({ ok: true, attached: b.attached.has(w) && !w.destroyed }),
    selfCheck: async () => ({ ok: true, probe: { windowType: ['_NET_WM_WINDOW_TYPE_DESKTOP'] } }),
    probe: async () => ({ ok: true }),
    covered: async () => null,
    otherDesktopWindows: async () => [],
    setStatic: async (f) => { calls.push(['setStatic', path.basename(f)]); return { ok: true, kind: 'nsworkspace' }; },
    restoreStatic: async () => { calls.push(['restoreStatic']); return { ok: true, restored: true }; },
    on: (n, cb) => ev.on(n, cb),
    emit: (n, p) => ev.emit(n, p),
    dispose: () => {},
    ...over,
  };
  return b;
}

// fake timers: run by hand; sleeps resolve at once
function fakeTimers() {
  const list = [];
  const T = {
    list,
    setTimeout: (fn, ms) => { const t = { fn, ms, on: true }; list.push(t); if (ms >= 100 && ms <= 8000 && fn.length === 1) { /* a sleep's resolver */ } return t; },
    clearTimeout: (t) => { if (t) t.on = false; },
    setInterval: (fn, ms) => { const t = { fn, ms, on: true, every: true }; list.push(t); return t; },
    clearInterval: (t) => { if (t) t.on = false; },
    fire: (ms) => { for (const t of list.filter((x) => x.on && x.ms === ms)) { if (!t.every) t.on = false; t.fn(); } },
  };
  return T;
}
const flush = () => new Promise((r) => setImmediate(r));

function setup({ displays, backend = fakeBackend(), prefs = {}, timers = null, pet = true } = {}) {
  const E = fakeElectron(displays);
  const settings = { on: false, id: '', where: 'wallpaper', displays: 'primary', fps: 30, batteryFps: 10, pauseWhenCovered: true, autoReturn: true, hotkey: 'CommandOrControl+Alt+P', mode: 'live', confirmed: true, linuxNotice: true, ...prefs };
  const saves = [];
  const petWin = { visible: true, bounds: { x: 900, y: 460, width: 200, height: 300 }, shows: [] };
  const shortcuts = { reg: new Map(), register(a, cb) { this.reg.set(a, cb); return true; }, unregister(a) { this.reg.delete(a); } };
  // real-time sleeps in recover() are short in tests: retryDelays [1, 1]
  const host = new WallpaperHost({
    electron: E, backend,
    packs: { load: (id) => (id === 'mini-wallpaper' ? { manifest, dir: '/x' } : id === 'yard' ? { manifest: { engine: 'yard@1' } } : null) },
    prefs: () => settings,
    save: (p) => { Object.assign(settings, p); saves.push(p); },
    pet: {
      hasPet: () => pet,
      bounds: () => petWin.bounds,
      show: (b) => { petWin.visible = true; if (b) petWin.bounds = { ...petWin.bounds, x: b.x, y: b.y }; petWin.shows.push(b); },
      hide: () => { petWin.visible = false; },
    },
    timers: timers || { setTimeout, clearTimeout, setInterval, clearInterval },
    retryDelays: [1, 1, 1], staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-static-')), testMode: true,
  });
  host.attachShortcuts(shortcuts, 'linux');
  return { host, E, backend, settings, saves, petWin, shortcuts };
}

test('设为壁纸: one window on the primary display, attached and self-checked; her desktop window hides; saved on / id / where; hotkey on', async () => {
  const { host, E, backend, settings, petWin, shortcuts } = setup();
  const r = await host.enter('mini-wallpaper');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(E.made.length, 1);
  assert.equal(E.made[0].opts.type, 'desktop');
  assert.equal(E.made[0].opts.webPreferences.sandbox, true);
  assert.equal(E.made[0].opts.webPreferences.contextIsolation, true);
  assert.equal(E.made[0].loaded.query.id, 'mini-wallpaper');
  assert.deepEqual(backend.calls, [['attach', 1]]);
  assert.equal(petWin.visible, false);
  assert.deepEqual([settings.on, settings.id, settings.where], [true, 'mini-wallpaper', 'wallpaper']);
  assert.equal(host.where, 'wallpaper');
  assert.ok(shortcuts.reg.has('CommandOrControl+Alt+P'));
  // she walks in where her window stood: its bottom centre, in canvas px
  assert.ok(Array.isArray(host.enterAt) && host.enterAt.every(Number.isFinite));
  const boot = host.bootFor(E.made[0].webContents);
  assert.deepEqual([boot.pet.visible, boot.base, boot.wallpaper.layers.length], [true, 'game://mini-wallpaper/', 4]);
});

test('refused without leaving anything: no WM / no WorkerW / not a wallpaper / no pet — she stays on the desktop, the reason in words', async () => {
  const noWm = setup({ backend: fakeBackend({ availability: async () => ({ ok: false, reason: 'no-wm' }) }) });
  const r = await noWm.host.enter('mini-wallpaper');
  assert.deepEqual([r.ok, r.reason, r.text], [false, 'no-wm', '没检测到窗口管理器，壁纸没有地方放。']);
  assert.deepEqual([noWm.E.made.length, noWm.petWin.visible, noWm.settings.on], [0, true, false]);

  const b = fakeBackend();
  b.failAttach = 1;
  const nw = setup({ backend: b });
  const r2 = await nw.host.enter('mini-wallpaper');
  assert.deepEqual([r2.ok, r2.reason], [false, 'no-workerw']);
  assert.equal(nw.E.made[0].destroyed, true, 'the half-made window is gone');
  assert.deepEqual([nw.host.where, nw.petWin.visible, nw.settings.on], ['desktop', true, false]);

  const s = setup();
  assert.equal((await s.host.enter('yard')).reason, 'no-pack', 'a game is not a wallpaper');
  assert.equal((await s.host.enter('nope')).reason, 'no-pack');
  assert.equal((await setup({ pet: false }).host.enter('mini-wallpaper')).reason, 'no-pet');

  const bad = setup({ backend: fakeBackend({ selfCheck: async () => ({ ok: false, reason: 'self-check-failed' }) }) });
  assert.equal((await bad.host.enter('mini-wallpaper')).reason, 'self-check-failed');
  assert.equal(bad.E.made[0].destroyed, true);
});

test('叫她出来 / 回到壁纸: her window comes up where she stands in the picture (inside the work area); back in, she hides; the hotkey toggles', async () => {
  const { host, E, petWin, settings, shortcuts } = setup();
  await host.enter('mini-wallpaper');
  host.pageReport(E.made[0].webContents, { type: 'pet', at: [300, 600] });
  const r = host.recall({ source: 'tray' });
  assert.equal(r.where, 'out');
  assert.equal(petWin.visible, true);
  const b = petWin.shows.pop();
  assert.ok(b.y + 300 <= 760 && b.x >= 0, `inside the work area: ${JSON.stringify(b)}`);
  assert.deepEqual(E.made[0].sent.filter(([c]) => c === 'wallpaper:pet').pop()[1], { visible: false, why: 'recall' });
  assert.equal(settings.where, 'out');
  assert.equal(host.return().where, 'wallpaper');
  assert.equal(petWin.visible, false);
  const back = E.made[0].sent.filter(([c]) => c === 'wallpaper:pet').pop()[1];
  assert.equal(back.visible, true);
  assert.ok(Array.isArray(back.at), 'she fades in where her window was');
  shortcuts.reg.get('CommandOrControl+Alt+P')();
  assert.equal(host.where, 'out', 'the hotkey called her out');
});

test('自动回到壁纸: 5 minutes after being called out without a touch she goes back; a touch starts the 5 minutes again', async () => {
  const T = fakeTimers();
  const { host } = setup({ timers: T });
  const p = host.enter('mini-wallpaper');
  await p;
  host.recall();
  assert.ok(T.list.some((t) => t.on && t.ms === 5 * 60 * 1000));
  host.touch();
  assert.equal(T.list.filter((t) => t.on && t.ms === 5 * 60 * 1000).length, 1, 'restarted, not doubled');
  T.fire(5 * 60 * 1000);
  assert.equal(host.where, 'wallpaper');
});

test('a mini game: the wallpaper pauses (0 fps) and she is not drawn; closing it brings her back into the wallpaper, not onto the desktop', async () => {
  const { host, E, petWin } = setup();
  await host.enter('mini-wallpaper');
  host.pageReport(E.made[0].webContents, { type: 'ready' });
  assert.equal(E.made[0].power().fps, 24, 'min(settings 30, pack 24)');
  assert.equal(host.gameOpened(), true);
  assert.deepEqual(E.made[0].power(), { fps: 0, why: 'game' });
  assert.equal(host.gameClosed(), true);
  assert.equal(host.where, 'wallpaper');
  assert.equal(petWin.visible, false);
  assert.equal(E.made[0].power().fps, 24);
  const off = setup();
  assert.equal(off.host.gameClosed(), false, 'not in wallpaper mode: main shows her on the desktop as before');
});

test('frame rate: battery → 10, covered (page hidden) → 0, called out → 15, suspended / locked → 0; resume re-checks and restores', async () => {
  const { host, E } = setup();
  await host.enter('mini-wallpaper');
  const w = E.made[0];
  host.pageReport(w.webContents, { type: 'ready' });
  E.powerMonitor.emit('on-battery');
  assert.deepEqual(w.power(), { fps: 10, why: 'battery' });
  E.powerMonitor.emit('on-ac');
  host.pageReport(w.webContents, { type: 'visibility', hidden: true });
  assert.deepEqual(w.power(), { fps: 0, why: 'covered' });
  host.pageReport(w.webContents, { type: 'visibility', hidden: false });
  host.recall();
  assert.deepEqual(w.power(), { fps: 15, why: 'out' });
  host.return();
  E.powerMonitor.emit('suspend');
  assert.deepEqual(w.power(), { fps: 0, why: 'suspended' });
  E.powerMonitor.emit('lock-screen');
  E.powerMonitor.emit('resume');
  await flush(); await flush();
  assert.deepEqual(w.power(), { fps: 0, why: 'locked' }, 'still locked after the wake');
  E.powerMonitor.emit('unlock-screen');
  await flush(); await flush();
  assert.deepEqual(w.power(), { fps: 24, why: 'normal' });
  assert.ok(host.log2.some((l) => l.kind === 'wake' && l.why === 'unlock'));
  assert.ok(host.log2.some((l) => l.kind === 'reconcile' && l.why === 'resume'), 'a wake reconciles the displays first');
});

test('displays: 所有显示器 opens one per display; one plugged in / out 500 ms later → a window more / less; resolution → re-placed', async () => {
  const T = fakeTimers();
  const { host, E, backend } = setup({ displays: [D(1, 0), D(2, 1280)], prefs: { displays: 'all' }, timers: T });
  await host.enter('mini-wallpaper');
  assert.deepEqual([...host.wins.keys()], ['1', '2']);
  E.screen.displays = [D(1, 0)];
  E.screen.emit('display-removed');
  E.screen.emit('display-metrics-changed');
  T.fire(500);
  await flush(); await flush();
  assert.deepEqual([...host.wins.keys()], ['1']);
  assert.equal(E.made[1].destroyed, true);
  E.screen.displays = [{ ...D(1, 0), bounds: { x: 0, y: 0, width: 1024, height: 768 } }, D(3, 1024)];
  E.screen.emit('display-added');
  T.fire(500);
  await flush(); await flush(); await flush();
  assert.deepEqual([...host.wins.keys()].sort(), ['1', '3']);
  assert.ok(backend.calls.some((c) => c[0] === 'place' && c[1] === 1));
  assert.deepEqual(E.made[0].bounds, { x: 0, y: 0, width: 1024, height: 768 });
});

test('Explorer restarted (helper shell-restarted): re-attached; the window destroyed with the WorkerW: built again', async () => {
  const backend = fakeBackend();
  const { host, E } = setup({ backend });
  await host.enter('mini-wallpaper');
  backend.attached.clear(); // the WorkerW is gone: nothing attached any more
  backend.emit('shell-restarted');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(host.log2.some((l) => l.kind === 'recover-ok' && l.why === 'shell-restarted'), JSON.stringify(host.log2.map((l) => l.kind)));
  assert.equal(backend.calls.filter((c) => c[0] === 'attach').length, 2);
  E.made[0].destroy(); // destroyed from outside
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(E.made.length, 2, 'a new window');
  assert.equal(host.where, 'wallpaper');
  assert.ok(host.log2.some((l) => l.kind === 'recover-ok' && l.why === 'window-lost'));
});

test('Explorer does not come back in time: every retry fails → out of wallpaper mode, her desktop window back, the notice says so', async () => {
  const backend = fakeBackend();
  const { host, petWin, settings } = setup({ backend });
  const notices = [];
  host.onNotice = (n) => notices.push(n);
  await host.enter('mini-wallpaper');
  backend.attached.clear();
  backend.failAttach = 99;
  const r = await host.recover('shell-restarted');
  assert.deepEqual(r, { ok: false, reason: 'shell-restarted-failed' });
  assert.deepEqual([host.where, petWin.visible, settings.on], ['desktop', true, false]);
  assert.equal(notices[0].text, '桌面刚刚重启了，她没能回到壁纸里，先回到桌面上了。托盘 → 壁纸 可以再试一次。');
});

test('the 30 s watchdog finds it detached and re-attaches; the Windows helper dying ends wallpaper mode (helper-failed)', async () => {
  const backend = fakeBackend();
  const { host } = setup({ backend });
  await host.enter('mini-wallpaper');
  assert.deepEqual(await host.check('watchdog'), { ok: true });
  backend.attached.clear();
  assert.deepEqual(await host.check('watchdog'), { ok: true });
  assert.ok(host.log2.some((l) => l.kind === 'check-failed'));
  backend.emit('helper-dead', {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(host.where, 'desktop');
  assert.equal(host.lastReason, 'helper-failed');
});

test('the wallpaper page crashing: reloaded up to 3 times in 10 minutes, the 4th ends wallpaper mode (crashed)', async () => {
  const { host, E } = setup();
  await host.enter('mini-wallpaper');
  for (let i = 0; i < 3; i++) E.made[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(E.made[0].reloads, 3);
  E.made[0].webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([host.where, host.lastReason], ['desktop', 'crashed']);
});

test('退出壁纸: windows detached and closed, hotkey let go, settings off, she is back on the desktop where she stood in the picture', async () => {
  const { host, E, backend, settings, petWin, shortcuts } = setup();
  await host.enter('mini-wallpaper');
  const r = await host.exit();
  assert.equal(r.ok, true);
  assert.ok(backend.calls.some((c) => c[0] === 'detach'));
  assert.equal(E.made[0].destroyed, true);
  assert.equal(shortcuts.reg.size, 0);
  assert.deepEqual([settings.on, host.where, petWin.visible], [false, 'desktop', true]);
  assert.ok(petWin.shows.pop(), 'shown at a place');
  assert.equal(host.log2.filter((l) => l.kind === 'recover-start').length, 0, 'closing it ourselves is not a lost window');
});

test('restart restore: on + where out → she comes back out (wallpaper behind); the host reports state for the store', async () => {
  const { host, settings } = setup({ prefs: { on: true, id: 'mini-wallpaper', where: 'out' } });
  const r = await host.enter('mini-wallpaper', { source: 'restart', restore: true });
  assert.equal(r.ok, true);
  assert.equal(host.where, 'out');
  assert.equal(settings.where, 'out');
  assert.deepEqual(Object.keys(host.state()).sort(), ['displays', 'fps', 'hotkey', 'id', 'lastReason', 'lastReasonText', 'mode', 'on', 'petDisplay', 'platform', 'session', 'where']);
});

test('macOS: the self-check fails (not under the icons) → a still picture of her becomes the desktop picture; 退出壁纸 puts the old one back', async () => {
  const backend = fakeBackend({ platform: 'darwin', selfCheck: async () => ({ ok: false, reason: 'self-check-failed' }) });
  const { host, E } = setup({ backend });
  host.selfCheckDelayMs = 0;
  const r = await host.enter('mini-wallpaper');
  assert.deepEqual([r.ok, r.mode, r.forced], [true, 'static', true]);
  assert.ok(backend.calls.some((c) => c[0] === 'setStatic' && c[1] === 'static-1.png'));
  assert.ok(E.made.some((w) => w.opts.webPreferences.offscreen === true), 'the picture is shot offscreen');
  assert.equal(host.where, 'desktop', 'she stays on the desktop');
  await host.exit();
  assert.deepEqual(backend.calls.pop(), ['restoreStatic']);
});

test('Windows end to end on the fake helper: enter attaches through the helper; Explorer restarting → the host re-attaches', async () => {
  const spawn = (exe, args, opts) => require('node:child_process').spawn(exe, args, { ...opts, env: { ...process.env, FAKE_HELPER_MODE: 'restart' } });
  const client = new HelperClient({ command: [process.execPath, path.join(__dirname, 'fixtures', 'fake-desktop-helper.js')], spawn, timeoutMs: 1000 });
  const backend = createWinBackend({ client, screen: { dipToScreenRect: (_w, r) => r } });
  const { host, E } = setup({ backend });
  try {
    const r = await host.enter('mini-wallpaper');
    assert.equal(r.ok, true, JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 300));
    assert.ok(host.log2.some((l) => l.kind === 'recover-ok' && l.why === 'shell-restarted'), JSON.stringify(host.log2.map((l) => l.kind)));
    assert.equal((await backend.status(E.made[0])).attached, true);
  } finally {
    await host.quit();
  }
});

test('no GPU (T-13654 D3): the page reports a software renderer → wallpaper:render scale 0.5 and 10 fps (why software); battery / covered still on top; a GPU renderer keeps 24 at full size', async () => {
  const { host, E, settings } = setup();
  await host.enter('mini-wallpaper');
  const w = E.made[0];
  host.pageReport(w.webContents, { type: 'ready' });
  assert.deepEqual(w.power(), { fps: 24, why: 'normal' });
  host.pageReport(w.webContents, { type: 'render', renderer: 'ANGLE (Mesa; llvmpipe (LLVM 20.1.2 256 bits); OpenGL 4.5)' });
  const render = () => w.sent.filter(([c]) => c === 'wallpaper:render').map(([, p]) => p).pop();
  assert.deepEqual(render(), { software: true, scale: 0.5 });
  assert.deepEqual(w.power(), { fps: 10, why: 'software' });
  settings.batteryFps = 4;
  E.powerMonitor.emit('on-battery');
  assert.deepEqual(w.power(), { fps: 4, why: 'battery' });
  E.powerMonitor.emit('on-ac');
  host.pageReport(w.webContents, { type: 'visibility', hidden: true });
  assert.deepEqual(w.power(), { fps: 0, why: 'covered' });
  host.pageReport(w.webContents, { type: 'visibility', hidden: false });
  assert.deepEqual(w.power(), { fps: 10, why: 'software' });
  assert.equal(host.bootFor(w.webContents).fps, 10, 'a reloaded page starts at the software cap');
  const dbg = await host.debugState({ probe: false });
  assert.deepEqual([dbg.windows[0].render.software, dbg.windows[0].render.scale], [true, 0.5]);
  assert.match(dbg.windows[0].render.renderer, /llvmpipe/);
  const gpu = setup();
  await gpu.host.enter('mini-wallpaper');
  const g = gpu.E.made[0];
  gpu.host.pageReport(g.webContents, { type: 'ready' });
  gpu.host.pageReport(g.webContents, { type: 'render', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' });
  assert.deepEqual(g.sent.filter(([c]) => c === 'wallpaper:render').map(([, p]) => p).pop(), { software: false, scale: 1 });
  assert.deepEqual(g.power(), { fps: 24, why: 'normal' });
});

test('the time of day (T-13654 D4): the page boots on the computer clock and a settings change keeps it there, whatever the mini games\' scene says', async () => {
  const { host, E } = setup();
  await host.enter('mini-wallpaper');
  const w = E.made[0];
  const games = { followClock: false, dayFlow: true, hour: 8, weather: 'clear', autoWeather: false, game: '' };
  assert.deepEqual(host.bootFor(w.webContents, null, games).scene, { followClock: true, dayFlow: false, hour: 8, weather: 'clear' });
  host.sceneChanged({ ...games, dayFlow: false, hour: 3, weather: 'rain' });
  const sent = w.sent.filter(([c]) => c === 'wallpaper:settings').map(([, p]) => p).pop();
  assert.deepEqual(sent, { scene: { followClock: true, dayFlow: false, hour: 3, weather: 'rain' } });
});
