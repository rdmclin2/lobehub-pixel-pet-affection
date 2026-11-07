'use strict';
// 桌面壁纸 · Windows (docs/wallpaper-mode.md §1.1). The wallpaper window goes into the WorkerW behind the desktop icons
// (SHELLDLL_DefView). That takes Win32 calls (SendMessageTimeout 0x052C to Progman, EnumWindows, SetParent …), which a
// small helper exe does — pixelpet-desktop-helper.exe (src/main/wallpaper/helper/desktop-helper.c, built in CI with
// MSVC, no node-gyp): its own process, so a hung Explorer or a crash never takes the app with it, and its message loop
// hears TaskbarCreated (Explorer restarted), WM_DISPLAYCHANGE, the foreground window and session lock / unlock.
//
// Protocol: JSON lines on stdin / stdout. → { id, cmd: 'attach' | 'place' | 'status' | 'detach', hwnd, rect }
// ← { id, ok, … } | { id, error } | { event: 'shell-restarted' | 'occluded' | 'display-changed' | 'session', … }
// stdin closing (the app quit) makes it detach and exit.
//
// HelperClient: spawn (after a sha256 check against helper.json: a replaced exe is refused, `helper-tampered`),
// 3 s per request, one automatic restart after a crash; a second crash → 'dead' (the host leaves wallpaper mode,
// `helper-failed`). createWinBackend wraps it in the same backend interface as linux.js / mac.js.
//
// NOT VERIFIED ON REAL WINDOWS (docs §6.2 W1–W8): the helper exe itself (attach on Win10 22H2 / Win11 23H2 / 24H2,
// Explorer restart, multi-monitor DPI, occlusion, Defender). Here the client is tested against a Node fake helper
// (test/fixtures/fake-desktop-helper.js) that plays attach / no-workerw / timeout / crash / shell-restarted.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: realSpawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const HELPER_NAME = 'pixelpet-desktop-helper.exe';
const TIMEOUT_MS = 3000;

// helper.json: { file, sha256 } written by the build (null sha256: no helper built into this copy of the app)
function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'helper.json'), 'utf8')); } catch { return null; }
}
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

class HelperClient extends EventEmitter {
  // command: [exe, …args] (tests: [process.execPath, fake.js]); expectSha: from helper.json (null: no check — tests)
  constructor({ command, expectSha = null, spawn = realSpawn, timeoutMs = TIMEOUT_MS, maxRestarts = 1, log = () => {} }) {
    super();
    this.command = command;
    this.expectSha = expectSha;
    this.spawnFn = spawn;
    this.timeoutMs = timeoutMs;
    this.maxRestarts = maxRestarts;
    this.log = log;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.restarts = 0;
    this.dead = false;
    this.buf = '';
    this.events = []; // the last helper events (debug read-out)
  }

  // → { ok } | { ok: false, reason: 'helper-missing' | 'helper-tampered' | 'helper-failed' }
  start() {
    if (this.dead) return { ok: false, reason: 'helper-failed' };
    if (this.child) return { ok: true };
    const exe = this.command[0];
    if (this.expectSha !== null) {
      if (!fs.existsSync(exe)) return { ok: false, reason: 'helper-missing' };
      if (sha256Of(exe) !== this.expectSha) return { ok: false, reason: 'helper-tampered' };
    }
    let child;
    try { child = this.spawnFn(exe, this.command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { this.log(e); return { ok: false, reason: 'helper-failed' }; }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._data(d));
    child.stderr.on('data', (d) => this.log(new Error(`desktop helper: ${String(d).slice(0, 200)}`)));
    child.on('error', (e) => { this.log(e); this._gone('error'); });
    child.on('exit', (code) => this._gone(`exit ${code}`));
    return { ok: true };
  }

  _data(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.event) {
        this.events.push({ ...msg, at: Date.now() });
        if (this.events.length > 40) this.events.shift();
        this.emit('event', msg);
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg.error ? { ok: false, reason: msg.error, ...msg } : { ok: msg.ok !== false, ...msg });
    }
  }

  _gone(why) {
    if (!this.child) return;
    this.child = null;
    this.buf = '';
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, reason: 'helper-failed', why }); }
    this.pending.clear();
    if (this._stopping) return;
    // one restart (it may have been a hiccup); a second crash: give up on wallpaper mode
    if (this.restarts < this.maxRestarts) {
      this.restarts += 1;
      const r = this.start();
      this.emit('restarted', { why, ok: r.ok });
      if (!r.ok) { this.dead = true; this.emit('dead', { why }); }
      return;
    }
    this.dead = true;
    this.emit('dead', { why });
  }

  // → the helper's answer, or { ok: false, reason: 'timeout' | 'helper-failed' }
  request(cmd, args = {}) {
    const s = this.start();
    if (!s.ok) return Promise.resolve(s);
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, reason: 'timeout', id }); }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try { this.child.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`); } catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, reason: 'helper-failed', err: String(e.message) }); }
    });
  }

  // stdin closed: the helper detaches whatever it holds and exits
  stop() {
    this._stopping = true;
    if (this.child) { try { this.child.stdin.end(); } catch { /* gone */ } }
  }
}

// the HWND of an Electron window, as the helper reads it ("0x…")
function hwndOf(win) {
  const b = win.getNativeWindowHandle();
  const v = b.length >= 8 ? b.readBigUInt64LE(0) : BigInt(b.readUInt32LE(0));
  return `0x${v.toString(16)}`;
}

// helperDir: where helper.json and the exe are (process.resourcesPath in a build); client: a HelperClient (tests)
function createWinBackend({ helperDir = null, client = null, screen = null, spawn = realSpawn, log = () => {} } = {}) {
  const ev = new EventEmitter();
  let helper = client;
  let startProblem = null;
  if (!helper) {
    const mf = helperDir ? readManifest(helperDir) : null;
    if (!mf || !mf.sha256) startProblem = 'helper-missing';
    else helper = new HelperClient({ command: [path.join(helperDir, mf.file || HELPER_NAME)], expectSha: mf.sha256, spawn, log });
  }
  if (helper) {
    helper.on('event', (m) => ev.emit(m.event, m));
    helper.on('dead', (m) => ev.emit('helper-dead', m));
  }
  // DIP bounds → physical pixels on the virtual screen (WorkerW's client area is the whole virtual screen)
  const rectOf = (display) => {
    const r = screen && screen.dipToScreenRect ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };

  async function availability({ mode = 'live' } = {}) {
    if (startProblem) return { ok: false, mode: 'live', reason: startProblem };
    const s = helper.start();
    if (!s.ok) return { ok: false, mode: 'live', reason: s.reason };
    return { ok: true, mode: mode === 'static' ? 'live' : 'live', session: 'win32', note: mode === 'static' ? 'static-not-on-windows' : undefined };
  }
  function windowOptions(display) {
    const b = display.bounds;
    // backgroundThrottling off: Chromium's occlusion tracking only knows top-level windows; a re-parented child may be
    // judged covered and stop animating, so on Windows pausing is the helper's call (its `occluded` events)
    return { x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, skipTaskbar: true, focusable: false, resizable: false, transparent: false, backgroundColor: '#000000', webPreferences: { backgroundThrottling: false } };
  }
  async function attach(win, display) {
    const r = await helper.request('attach', { hwnd: hwndOf(win), rect: rectOf(display) });
    if (!r.ok) return { ok: false, reason: r.reason === 'no-workerw' ? 'no-workerw' : r.reason === 'timeout' ? 'helper-failed' : r.reason || 'helper-failed', detail: r };
    win.showInactive();
    return { ok: true, layout: r.layout, workerw: r.workerw };
  }
  async function place(win, display) { return helper.request('place', { hwnd: hwndOf(win), rect: rectOf(display) }); }
  async function status(win) {
    const r = await helper.request('status', { hwnd: hwndOf(win) });
    return { ok: r.ok, attached: !!(r.ok && r.attached && r.parentAlive), detail: r };
  }
  async function detach(win) { if (win.isDestroyed()) return { ok: true }; return helper.request('detach', { hwnd: hwndOf(win) }); }
  async function selfCheck(win) {
    const r = await status(win);
    return { ok: r.attached && !!(r.detail && r.detail.visible !== false), probe: r.detail, reason: r.attached ? null : 'self-check-failed' };
  }
  async function probe(win) { return (await status(win)).detail; }

  return {
    platform: 'win32', session: 'win32', availability, windowOptions, attach, place, detach, status, selfCheck, probe,
    covered: async () => null, otherDesktopWindows: async () => [],
    // Windows keeps the live wallpaper only (a static desktop picture needs nothing of ours there)
    setStatic: async () => ({ ok: false, reason: 'static-failed' }), restoreStatic: async () => ({ ok: true, restored: false }),
    on: (name, cb) => ev.on(name, cb),
    dispose: () => { if (helper) helper.stop(); },
    helper: () => helper,
  };
}

module.exports = { HelperClient, createWinBackend, hwndOf, readManifest, sha256Of, HELPER_NAME, TIMEOUT_MS };
