'use strict';
// 桌面壁纸 · WallpaperHost (docs/wallpaper-mode.md §1.5, §2). Everything main does for wallpaper mode:
//
//   enter(id)      设为壁纸: one wallpaper window per display (settings.wallpaper.displays), put behind the desktop icons
//                  by the platform backend (linux.js / mac.js / win-helper.js), self-checked; her desktop window hides
//                  and she walks into the picture where her window stood. A backend that cannot (no-wm, no-workerw,
//                  helper-failed, wayland-unsupported …) leaves her on the desktop and says why — never half a wallpaper.
//   recall()       叫她出来 (hotkey, tray, showPet): she fades out of the picture, her desktop window comes up where
//                  she stood in it; 5 minutes without a touch (autoReturn) she goes back
//   return()       回到壁纸
//   exit()         退出壁纸: windows closed (Windows: the helper detaches), a static picture restored, she is on the desktop
//   gameOpened / gameClosed   she went into a mini game (the wallpaper pauses) / back into the wallpaper after it
//
// Kept up: screen display-added / removed / metrics-changed (and the helper's display-changed) → reconcile() 500 ms
// later; powerMonitor suspend / lock → paused, resume / unlock → reconcile, re-check, frame rate back; a 30 s watchdog
// (backend.status); Explorer restarted (helper shell-restarted) or a wallpaper window destroyed under us → recover():
// re-attach / re-create after 0.5 / 1 / 2 / 4 / 8 s, else exit with `shell-restarted-failed`; the page crashing → at most
// 3 reloads in 10 minutes, else exit (`crashed`). The frame rate: core/wallpaper-power.js from battery, covered
// (fullscreen app / the page hidden), lock / suspend, game, called out.
//
// Electron is passed in ({ BrowserWindow, screen, powerMonitor, globalShortcut }) so the tests run it on fakes.
const path = require('node:path');
const fs = require('node:fs');
const WS = require('../../core/wallpaper-state');
const WPower = require('../../core/wallpaper-power');
const WP = require('../../core/wallpaper-pack');
const hotkeyLib = require('../../core/hotkey');

const HTML = path.join(__dirname, '..', '..', 'renderer', 'wallpaper', 'wallpaper.html');
const PRELOAD = path.join(__dirname, '..', 'wallpaper-preload.js');
const AUTO_RETURN_MS = 5 * 60 * 1000;
const WATCHDOG_MS = 30 * 1000;
const DISPLAY_DEBOUNCE_MS = 500;
const COVER_POLL_MS = 3000;
const STATIC_REFRESH_MS = 60 * 60 * 1000;

class WallpaperHost {
  constructor({
    electron, backend, packs, prefs, save, pet, log = () => {}, onChange = () => {}, onNotice = () => {},
    html = HTML, preload = PRELOAD, staticDir = null, testMode = false,
    timers = { setTimeout, clearTimeout, setInterval, clearInterval }, now = () => Date.now(), retryDelays = WS.retryPlan(), selfCheckDelayMs = null,
  }) {
    this.E = electron;
    this.backend = backend;
    this.packs = packs; // { load(id) → { manifest, dir } | null }
    this.prefs = prefs; // () → settings.wallpaper
    this.save = save; // (patch) → settings saved (settings.wallpaper)
    this.pet = pet; // { hasPet(), bounds(), show(bounds?), hide(), visible() }
    this.log = log;
    this.onChange = onChange;
    this.onNotice = onNotice;
    this.html = html;
    this.preload = preload;
    this.staticDir = staticDir;
    this.testMode = testMode;
    this.T = timers;
    this.now = now;
    this.retryDelays = retryDelays;
    this.selfCheckDelayMs = selfCheckDelayMs ?? (backend.platform === 'darwin' ? 1000 : 0);
    this.where = 'desktop';
    this.id = null;
    this.mode = null; // 'live' | 'static' while on
    this.wins = new Map(); // displayId → { win, display, attached, fps, hidden, ready }
    this.petDisplay = null;
    this.petPos = null; // her last place in the picture (canvas px), from the page
    this.signals = { onBattery: false, covered: {}, locked: false, suspended: false, inGame: false, out: false };
    this.lastReason = null;
    this.log2 = []; // what happened (enter / exit / recover / reconcile …) for the debug read-out and the e2e
    this.crashes = WS.crashBudget();
    this._closing = new Set();
    this._timers = {};
    this._hotkey = null;
    this.hotkeyState = { state: 'off', accelerator: '' };
    this._listening = false;
    this._recovering = null;
  }

  get active() { return this.where !== 'desktop'; }
  _note(kind, detail = {}) {
    this.log2.push({ at: this.now(), kind, ...detail });
    if (this.log2.length > 120) this.log2.shift();
  }
  _changed() { try { this.onChange(this.state()); } catch (e) { this.log(e); } }

  // ---- the pack ----------------------------------------------------------------------------------------------
  _pack(id) {
    const g = id ? this.packs.load(id) : null;
    if (!g || !g.manifest || g.manifest.engine !== WP.ENGINE) return null;
    return { ...g, wallpaper: WP.cleanWallpaper(g.manifest) };
  }

  // ---- enter / exit ------------------------------------------------------------------------------------------
  async enter(id, { source = 'store', restore = false } = {}) {
    if (!this.pet.hasPet()) return this._fail('no-pet');
    const pack = this._pack(id);
    if (!pack) return this._fail('no-pack');
    if (this.active && this.id === id) return { ok: true, already: true, ...this.state() };
    if (this.active) await this._teardown({ restoreStatic: true }); // another wallpaper: the new one replaces it
    const prefs = this.prefs();
    const avail = await this.backend.availability({ mode: prefs.mode });
    if (!avail.ok) { this._note('unavailable', { reason: avail.reason }); return this._fail(avail.reason, { restoring: restore }); }
    this.id = id;
    this.pack = pack;
    this._note('enter', { id, source, restore, mode: avail.mode, session: avail.session || null });
    if (avail.mode === 'static') return this._enterStatic(pack, { source, restore, forced: !!avail.forced });

    const petBounds = this.pet.bounds();
    const displays = this.E.screen.getAllDisplays();
    const primary = this.E.screen.getPrimaryDisplay();
    const near = petBounds && this.E.screen.getDisplayMatching ? this.E.screen.getDisplayMatching(petBounds) : primary;
    const plan = WS.reconcile(displays, [], { mode: prefs.displays, primaryId: primary.id, petDisplay: near ? near.id : null });
    if (!plan.create.length) return this._fail('no-display');
    this.petDisplay = plan.petDisplay;
    // she walks in where her window stood (its bottom centre = her feet)
    this.enterAt = petBounds ? this._toCanvas([petBounds.x + petBounds.width / 2, petBounds.y + petBounds.height], plan.petDisplay) : null;
    for (const d of plan.create) {
      const r = await this._open(d);
      if (!r.ok) { await this._teardown({}); this.id = null; return this._fail(r.reason); }
    }
    if (this.selfCheckDelayMs) await this._sleep(this.selfCheckDelayMs);
    for (const [did, w] of this.wins) {
      const c = await this.backend.selfCheck(w.win);
      w.check = c;
      this._note('self-check', { display: did, ok: c.ok, probe: c.probe || null });
      if (!c.ok) {
        await this._teardown({});
        this.id = null;
        // macOS: not under the icons → the still-picture way instead (docs §1.2)
        if (this.backend.platform === 'darwin') { this._note('fallback-static', { why: 'self-check' }); this.id = id; return this._enterStatic(pack, { source, restore, forced: true }); }
        return this._fail(c.reason || 'self-check-failed');
      }
    }
    this.mode = 'live';
    const where = restore && prefs.where === 'out' ? 'out' : 'wallpaper';
    this.where = 'wallpaper';
    this.pet.hide();
    this._listen();
    this._registerHotkey();
    this.save({ on: true, id, where: 'wallpaper' });
    this._power();
    this._startWatchdog();
    const notice = await this._linuxNotice();
    if (where === 'out') this.recall({ source: 'restore' });
    this._changed();
    return { ok: true, mode: 'live', ...(notice ? { notice } : {}), ...this.state() };
  }

  _fail(reason, extra = {}) {
    this.lastReason = reason;
    this._changed();
    return { ok: false, reason, text: WS.reasonText(reason), ...extra };
  }

  async exit({ reason = 'user', notify = false } = {}) {
    if (!this.active && this.mode !== 'static') return { ok: true, already: true, ...this.state() };
    const wasIn = this.where === 'wallpaper';
    const at = wasIn ? this._petScreenBounds() : null;
    await this._teardown({ restoreStatic: true });
    this._note('exit', { reason });
    this.where = 'desktop';
    this.mode = null;
    this.id = null;
    this.signals.inGame = false;
    this.signals.out = false;
    this._unregisterHotkey();
    this._unlisten();
    this.save({ on: false, where: 'wallpaper' });
    if (this.pet.hasPet()) this.pet.show(at);
    if (reason !== 'user') this.lastReason = reason;
    if (notify && reason !== 'user') this.onNotice({ kind: 'exit', reason, text: WS.reasonText(reason) });
    this._changed();
    return { ok: true, reason, ...this.state() };
  }

  // close every wallpaper window (detached first) and the timers; static: the system picture back
  async _teardown({ restoreStatic = false } = {}) {
    this._clear('autoReturn');
    this._clear('watchdog');
    this._clear('cover');
    this._clear('static');
    this._clear('display');
    for (const [did, w] of [...this.wins]) {
      this._closing.add(w.win);
      try { if (!w.win.isDestroyed()) { await this.backend.detach(w.win); w.win.destroy(); } } catch (e) { this.log(e); }
      this.wins.delete(did);
    }
    if (this._static && !this._static.isDestroyed()) { this._closing.add(this._static); this._static.destroy(); }
    this._static = null;
    if (restoreStatic && this.mode === 'static') {
      const r = await this.backend.restoreStatic();
      this._note('static-restore', r);
    }
  }

  // ---- the windows -------------------------------------------------------------------------------------------
  _create(display, { offscreen = false } = {}) {
    const o = this.backend.windowOptions(display);
    const win = new this.E.BrowserWindow({
      ...o,
      ...(offscreen ? { show: false, type: undefined } : {}),
      title: o.title || `pixel-pet-wallpaper-${display.id}`,
      webPreferences: { ...(o.webPreferences || {}), preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, ...(offscreen ? { offscreen: true } : {}) },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', (_e, d) => this._crashed(display.id, d));
    win.on('closed', () => this._closed(display.id, win));
    return win;
  }

  async _open(display) {
    const win = this._create(display);
    const w = { win, display, attached: false, fps: null, hidden: false, ready: false };
    this.wins.set(String(display.id), w);
    try { await win.loadFile(this.html, { query: { id: this.id, display: String(display.id) } }); } catch (e) { this.log(e); return { ok: false, reason: 'load-failed' }; }
    const r = await this.backend.attach(win, display);
    this._note('attach', { display: display.id, ok: r.ok, reason: r.reason || null, layout: r.layout || null });
    if (!r.ok) return { ok: false, reason: r.reason || 'helper-failed' };
    w.attached = true;
    w.layout = r.layout || null;
    return { ok: true };
  }

  _closed(did, win) {
    const w = this.wins.get(String(did));
    if (this._closing.has(win)) { this._closing.delete(win); return; }
    if (!w || w.win !== win) return;
    // destroyed under us (WorkerW gone with Explorer, or closed from outside): build it again
    this._note('window-lost', { display: did });
    w.attached = false;
    if (this.active) this.recover('window-lost').catch((e) => this.log(e));
  }

  _crashed(did, details) {
    this._note('crash', { display: did, reason: details && details.reason });
    if (!this.active) return;
    if (this.crashes.hit(this.now())) {
      const w = this.wins.get(String(did));
      if (w && !w.win.isDestroyed()) w.win.webContents.reload();
      return;
    }
    this.exit({ reason: 'crashed', notify: true }).catch((e) => this.log(e));
  }

  // the window a page message came from → its display id (null: not one of ours)
  displayOf(sender) {
    for (const [did, w] of this.wins) if (!w.win.isDestroyed() && w.win.webContents === sender) return did;
    if (this._static && !this._static.isDestroyed() && this._static.webContents === sender) return 'static';
    return null;
  }

  // what wallpaper:boot hands the page (src/renderer/wallpaper/wallpaper.js)
  bootFor(sender, view = null, scene = null) {
    const did = this.displayOf(sender);
    if (did === null || !this.pack) return null;
    const w = this.wins.get(did);
    const display = w ? w.display : this.E.screen.getPrimaryDisplay();
    const here = did === 'static' || String(this.petDisplay) === String(did);
    return {
      id: this.id, base: `game://${this.id}/`, wallpaper: this.pack.wallpaper, display: { id: display.id, bounds: display.bounds, workArea: display.workArea || display.bounds },
      clip: WS.walkClip(display, this.pack.wallpaper.canvas, this.pack.wallpaper.canvas.fit, this.pack.wallpaper.canvas.focus),
      pet: here && this.where !== 'out' && this.where !== 'game' ? { visible: true, at: this.enterAt || null } : { visible: false },
      fps: w ? (w.fps ? w.fps.fps : WPower.frameRate(this._signalsFor(did), this.prefs(), this.pack.wallpaper.power).fps) : 1,
      staticShot: did === 'static', view, scene: WS.wallpaperScene(scene), testMode: this.testMode,
    };
  }

  // ---- page reports ------------------------------------------------------------------------------------------
  pageReport(sender, msg = {}) {
    const did = this.displayOf(sender);
    if (did === null) return false;
    const w = this.wins.get(did);
    // ready: the page listens now — send it the frame rate again even if it did not change
    if (msg.type === 'ready' && w) { w.ready = true; w.fps = null; this._power(); }
    if (msg.type === 'visibility' && w) { w.hidden = !!msg.hidden; this._power(); }
    // the page's WebGL renderer: drawn by the CPU (no GPU) → lower resolution and frame rate (core/wallpaper-power.js)
    if (msg.type === 'render' && w) {
      w.render = { ...WPower.renderPlan(msg.renderer), renderer: typeof msg.renderer === 'string' ? msg.renderer.slice(0, 200) : null };
      this._note('render', { software: w.render.software, renderer: w.render.renderer });
      if (!w.win.isDestroyed()) w.win.webContents.send('wallpaper:render', { software: w.render.software, scale: w.render.scale });
      this._power();
    }
    if (msg.type === 'pet' && String(did) === String(this.petDisplay) && Array.isArray(msg.at) && msg.at.every(Number.isFinite)) this.petPos = [msg.at[0], msg.at[1]];
    return true;
  }

  // ---- 叫她出来 / 回到壁纸 -----------------------------------------------------------------------------------------
  _toCanvas(pt, did) {
    const d = this._display(did);
    const c = this.pack.wallpaper.canvas;
    return d ? WS.screenToCanvas(pt, d, c, c.fit, c.focus) : null;
  }
  _display(did) {
    const w = this.wins.get(String(did));
    if (w) return w.display;
    return this.E.screen.getAllDisplays().find((d) => String(d.id) === String(did)) || this.E.screen.getPrimaryDisplay();
  }
  // where her desktop window goes when she comes out: her feet at her place in the picture, inside the work area
  _petScreenBounds() {
    const b = this.pet.bounds();
    if (!b || !this.pack) return null;
    const d = this._display(this.petDisplay);
    const c = this.pack.wallpaper.canvas;
    const pos = this.petPos || this.enterAt || this.pack.wallpaper.pet.spawn;
    const feet = WS.canvasToScreen(pos, d, c, c.fit, c.focus);
    return WS.petWindowAt(feet, { width: b.width, height: b.height }, d.workArea || d.bounds);
  }
  _sendPet(payload) {
    const w = this.wins.get(String(this.petDisplay));
    if (w && !w.win.isDestroyed()) w.win.webContents.send('wallpaper:pet', payload);
  }

  recall({ source = 'tray' } = {}) {
    const m = WS.move(this.where, 'recall');
    if (!m.ok) return { ok: false, reason: m.reason, ...this.state() };
    const at = this._petScreenBounds();
    this.where = m.where;
    this.signals.out = true;
    this._sendPet({ visible: false, why: 'recall' });
    this.pet.show(at);
    this.save({ where: 'out' });
    this._armAutoReturn();
    this._note('recall', { source, at });
    this._power();
    this._changed();
    return { ok: true, ...this.state() };
  }

  return({ source = 'tray' } = {}) {
    const m = WS.move(this.where, 'return');
    if (!m.ok) return { ok: false, reason: m.reason, ...this.state() };
    const b = this.pet.bounds();
    const at = b ? this._toCanvas([b.x + b.width / 2, b.y + b.height], this.petDisplay) : null;
    this.where = m.where;
    this.signals.out = false;
    this._clear('autoReturn');
    this.pet.hide();
    this._sendPet({ visible: true, at, why: 'return' });
    this.save({ where: 'wallpaper' });
    this._note('return', { source, at });
    this._power();
    this._changed();
    return { ok: true, ...this.state() };
  }

  toggle(source = 'hotkey') { return this.where === 'wallpaper' ? this.recall({ source }) : this.where === 'out' ? this.return({ source }) : { ok: false, reason: 'nothing-to-do' }; }
  // she is being talked to / touched while out: the 5 minutes start again
  touch() { if (this.where === 'out') this._armAutoReturn(); }
  _armAutoReturn() {
    this._clear('autoReturn');
    if (this.where !== 'out' || !this.prefs().autoReturn) return;
    this._timers.autoReturn = this.T.setTimeout(() => { this._timers.autoReturn = null; if (this.where === 'out') this.return({ source: 'auto' }); }, AUTO_RETURN_MS);
    if (this._timers.autoReturn && this._timers.autoReturn.unref) this._timers.autoReturn.unref();
  }

  // ---- mini games ----------------------------------------------------------------------------------------
  gameOpened() {
    const m = WS.move(this.where, 'game-open');
    if (!m.ok) return false;
    this._clear('autoReturn');
    this.where = m.where;
    this.signals.inGame = true;
    this.signals.out = false;
    this._sendPet({ visible: false, why: 'game' });
    this._power();
    this._changed();
    return true;
  }
  // → true: she went back into the wallpaper (main does not show her desktop window)
  gameClosed() {
    const m = WS.move(this.where, 'game-close');
    if (!m.ok) return false;
    this.where = m.where;
    this.signals.inGame = false;
    this.pet.hide();
    this._sendPet({ visible: true, at: this.petPos || this.enterAt || null, why: 'game-closed' });
    this.save({ where: 'wallpaper' });
    this._power();
    this._changed();
    return true;
  }

  // ---- displays ------------------------------------------------------------------------------------------
  async reconcile(why = 'display') {
    if (this.mode !== 'live' || !this.pack) return null;
    const displays = this.E.screen.getAllDisplays();
    const primary = this.E.screen.getPrimaryDisplay();
    const plan = WS.reconcile(displays, [...this.wins.keys()], { mode: this.prefs().displays, primaryId: primary.id, petDisplay: this.petDisplay });
    for (const did of plan.close) {
      const w = this.wins.get(String(did));
      this.wins.delete(String(did));
      if (w && !w.win.isDestroyed()) { this._closing.add(w.win); await this.backend.detach(w.win); w.win.destroy(); }
    }
    for (const d of plan.place) {
      const w = this.wins.get(String(d.id));
      w.display = d;
      await this.backend.place(w.win, d);
      w.win.webContents.send('wallpaper:display', { display: { id: d.id, bounds: d.bounds, workArea: d.workArea || d.bounds }, clip: WS.walkClip(d, this.pack.wallpaper.canvas, this.pack.wallpaper.canvas.fit, this.pack.wallpaper.canvas.focus) });
    }
    const moved = String(plan.petDisplay) !== String(this.petDisplay);
    this.petDisplay = plan.petDisplay;
    if (moved) this.enterAt = null;
    for (const d of plan.create) {
      const r = await this._open(d);
      if (!r.ok) this._note('reconcile-open-failed', { display: d.id, reason: r.reason });
    }
    // her display went away: she moves to the primary (its page shows her at the spawn point)
    if (moved && this.where === 'wallpaper') this._sendPet({ visible: true, at: null, why: 'display-moved' });
    this._note('reconcile', { why, want: plan.want, created: plan.create.map((d) => d.id), closed: plan.close, placed: plan.place.map((d) => d.id), petDisplay: plan.petDisplay });
    this._power();
    this._changed();
    return plan;
  }

  // ---- recovery: Explorer restarted / a window lost / the watchdog found it detached -----------------------
  async recover(why = 'shell-restarted') {
    if (this._recovering) return this._recovering;
    this._recovering = (async () => {
      this._note('recover-start', { why });
      for (const delay of [0, ...this.retryDelays]) {
        if (delay) await this._sleep(delay);
        if (!this.active || this.mode !== 'live') return { ok: false, reason: 'not-active' };
        let all = true;
        for (const [did, w] of [...this.wins]) {
          if (w.win.isDestroyed()) {
            this.wins.delete(did);
            const r = await this._open(w.display);
            if (!r.ok) { all = false; continue; }
            if (String(did) === String(this.petDisplay)) this._sendPet({ visible: this.where === 'wallpaper', at: this.petPos, why: 'recovered' });
            continue;
          }
          const st = await this.backend.status(w.win);
          if (st.attached) continue;
          const r = await this.backend.attach(w.win, w.display);
          w.attached = !!r.ok;
          if (!r.ok) all = false;
        }
        if (all) { this._note('recover-ok', { why, delay }); this._power(); this._changed(); return { ok: true }; }
      }
      this._note('recover-failed', { why });
      await this.exit({ reason: 'shell-restarted-failed', notify: true });
      return { ok: false, reason: 'shell-restarted-failed' };
    })();
    try { return await this._recovering; } finally { this._recovering = null; }
  }

  async check(why = 'watchdog') {
    if (this.mode !== 'live') return { ok: true, skipped: true };
    for (const [, w] of this.wins) {
      const st = w.win.isDestroyed() ? { attached: false } : await this.backend.status(w.win);
      if (!st.attached) { this._note('check-failed', { why }); return this.recover(why); }
    }
    return { ok: true };
  }
  _startWatchdog() {
    this._clear('watchdog');
    this._timers.watchdog = this.T.setInterval(() => { this.check('watchdog').catch((e) => this.log(e)); }, WATCHDOG_MS);
    if (this._timers.watchdog && this._timers.watchdog.unref) this._timers.watchdog.unref();
  }

  // ---- power ---------------------------------------------------------------------------------------------
  _signalsFor(did) {
    const w = this.wins.get(String(did));
    // covered: this display's own flag, or one that is not a display id ('all' from the X11 fullscreen poll, a Windows
    // monitor name the helper sent, 'test' from the e2e) — those count for every display — or the page hidden
    const c = this.signals.covered;
    const any = Object.entries(c).some(([k, v]) => v && (k === String(did) || !this.wins.has(k)));
    return { ...this.signals, covered: !!(any || (w && w.hidden)), out: this.signals.out, software: !!(w && w.render && w.render.software) };
  }
  _power() {
    if (!this.pack) return;
    for (const [did, w] of this.wins) {
      const r = WPower.frameRate(this._signalsFor(did), this.prefs(), this.pack.wallpaper.power);
      if (w.fps && w.fps.fps === r.fps && w.fps.why === r.why) continue;
      w.fps = r;
      if (!w.win.isDestroyed()) w.win.webContents.send('wallpaper:power', r);
    }
  }
  setSignal(name, value) {
    if (name === 'covered') this.signals.covered = { ...this.signals.covered, ...(value && typeof value === 'object' ? value : { all: !!value }) };
    else this.signals[name] = !!value;
    this._note('signal', { name, value });
    this._power();
  }

  _listen() {
    if (this._listening) return;
    this._listening = true;
    const pm = this.E.powerMonitor;
    const scr = this.E.screen;
    const later = WS.debounce(() => this.reconcile('display').catch((e) => this.log(e)), DISPLAY_DEBOUNCE_MS, { setTimer: this.T.setTimeout, clearTimer: this.T.clearTimeout });
    this._later = later;
    this._h = {
      battery: () => this.setSignal('onBattery', true),
      ac: () => this.setSignal('onBattery', false),
      suspend: () => this.setSignal('suspended', true),
      lock: () => this.setSignal('locked', true),
      resume: () => { this.signals.suspended = false; this._wake('resume'); },
      unlock: () => { this.signals.locked = false; this._wake('unlock'); },
      display: () => later(),
    };
    try { this.signals.onBattery = !!(pm.isOnBatteryPower && pm.isOnBatteryPower()); } catch { /* not on this platform */ }
    pm.on('on-battery', this._h.battery);
    pm.on('on-ac', this._h.ac);
    pm.on('suspend', this._h.suspend);
    pm.on('lock-screen', this._h.lock);
    pm.on('resume', this._h.resume);
    pm.on('unlock-screen', this._h.unlock);
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) scr.on(ev, this._h.display);
    // the platform's own signals (Windows helper): Explorer restarted, a fullscreen app, display / session changes
    if (!this._backendWired) {
      this._backendWired = true;
      this.backend.on('shell-restarted', () => { if (this.active) this.recover('shell-restarted').catch((e) => this.log(e)); });
      this.backend.on('occluded', (m) => this.setSignal('covered', { [m.monitor ? String(m.monitor) : 'all']: !!m.on }));
      this.backend.on('display-changed', () => { if (this._later) this._later(); });
      this.backend.on('session', (m) => { if (m.locked) this.setSignal('locked', true); else { this.signals.locked = false; this._wake('unlock'); } });
      this.backend.on('helper-dead', () => { if (this.active) this.exit({ reason: 'helper-failed', notify: true }).catch((e) => this.log(e)); });
    }
    this._pollCovered();
  }
  _unlisten() {
    if (!this._listening) return;
    this._listening = false;
    const pm = this.E.powerMonitor;
    pm.removeListener('on-battery', this._h.battery);
    pm.removeListener('on-ac', this._h.ac);
    pm.removeListener('suspend', this._h.suspend);
    pm.removeListener('lock-screen', this._h.lock);
    pm.removeListener('resume', this._h.resume);
    pm.removeListener('unlock-screen', this._h.unlock);
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) this.E.screen.removeListener(ev, this._h.display);
    if (this._later) this._later.cancel();
    this._later = null;
  }
  // after a wake / unlock: displays first (their order may have changed), then the attach check, then the frame rate
  async _wake(why) {
    this._note('wake', { why });
    if (this.mode === 'live') {
      await this.reconcile(why);
      await this.check(why);
    }
    this._power();
  }
  // X11: is the active window fullscreen? every 3 s; a backend that cannot tell (null) is not asked again
  _pollCovered() {
    this._clear('cover');
    if (this.mode !== 'live' && this.mode !== null) return;
    const tick = async () => {
      if (!this.active) return;
      const c = await this.backend.covered();
      if (c === null) return;
      if (!!this.signals.covered.all !== c) this.setSignal('covered', { all: c });
      this._timers.cover = this.T.setTimeout(tick, COVER_POLL_MS);
      if (this._timers.cover && this._timers.cover.unref) this._timers.cover.unref();
    };
    this._timers.cover = this.T.setTimeout(tick, COVER_POLL_MS);
    if (this._timers.cover && this._timers.cover.unref) this._timers.cover.unref();
  }

  // ---- the hotkey: 叫她出来 / 回到壁纸, registered only while in wallpaper mode ---------------------------------
  attachShortcuts(shortcuts, platform = process.platform) { this.shortcuts = shortcuts; this.platform = platform; }
  _registerHotkey() {
    this._unregisterHotkey();
    const acc = this.prefs().hotkey;
    if (!this.shortcuts || !acc) { this.hotkeyState = { state: 'off', accelerator: acc || '' }; return; }
    const c = hotkeyLib.checkHotkey(acc, this.platform);
    if (!c.ok) { this.hotkeyState = { state: c.reason, accelerator: acc, message: c.message }; return; }
    let ok = false;
    try { ok = this.shortcuts.register(c.accelerator, () => this.toggle('hotkey')) === true; } catch (e) { this.log(e); }
    this._hotkey = ok ? c.accelerator : null;
    this.hotkeyState = { state: ok ? 'ok' : 'conflict', accelerator: c.accelerator, label: hotkeyLib.labelFor(c.accelerator, this.platform) };
  }
  _unregisterHotkey() {
    if (this._hotkey && this.shortcuts) { try { this.shortcuts.unregister(this._hotkey); } catch (e) { this.log(e); } }
    this._hotkey = null;
    if (this.hotkeyState.state === 'ok') this.hotkeyState = { state: 'off', accelerator: this.hotkeyState.accelerator };
  }

  // ---- static wallpaper (Wayland, macOS self-check failed, or 壁纸类型 = 静态) ---------------------------------
  async _enterStatic(pack, { source, restore, forced }) {
    const r = await this._shoot(pack);
    if (!r.ok) { this.id = null; return this._fail(r.reason || 'static-failed'); }
    this.mode = 'static';
    this.where = 'desktop'; // she stays on the desktop as usual; the picture is of her
    this.save({ on: true, id: pack.manifest.id, where: 'wallpaper' });
    this._clear('static');
    this._timers.static = this.T.setInterval(() => { this._shoot(pack).catch((e) => this.log(e)); }, STATIC_REFRESH_MS);
    if (this._timers.static && this._timers.static.unref) this._timers.static.unref();
    this._note('static', { source, restore, forced, file: r.file, kind: r.kind });
    this._changed();
    return { ok: true, mode: 'static', forced, ...this.state() };
  }
  // one frame of the wallpaper page (offscreen), her standing idle in it → userData/wallpaper/static-<display>.png
  async _shoot(pack) {
    const d = this.E.screen.getPrimaryDisplay();
    if (!this.staticDir) return { ok: false, reason: 'static-failed' };
    const win = this._create(d, { offscreen: true });
    this._static = win;
    try {
      await win.loadFile(this.html, { query: { id: pack.manifest.id, display: 'static' } });
      await this._sleep(this.testMode ? 300 : 1500);
      const img = await win.webContents.capturePage();
      fs.mkdirSync(this.staticDir, { recursive: true });
      const file = path.join(this.staticDir, `static-${d.id}.png`);
      fs.writeFileSync(file, img.toPNG());
      const s = await this.backend.setStatic(file);
      return s.ok ? { ok: true, file, kind: s.kind } : { ok: false, reason: s.reason };
    } catch (e) {
      this.log(e);
      return { ok: false, reason: 'static-failed' };
    } finally {
      this._closing.add(win);
      if (!win.isDestroyed()) win.destroy();
      if (this._static === win) this._static = null;
    }
  }

  // Linux: the first time, say how to get out if the desktop icons end up under the wallpaper (docs §1.3)
  async _linuxNotice() {
    if (this.backend.platform !== 'linux' || this.prefs().linuxNotice) return null;
    let others = [];
    try { others = await this.backend.otherDesktopWindows([...this.wins.values()].map((w) => w.win)); } catch { /* no xprop */ }
    this.save({ linuxNotice: true });
    const text = others.length ? '这个桌面自己也画了一层桌面图标，两层的先后由窗口管理器决定。如果图标被盖住了，从托盘 → 壁纸 → 退出壁纸。' : '如果桌面图标被盖住了，从托盘 → 壁纸 → 退出壁纸。';
    const n = { kind: 'linux-icons', text, others };
    this.onNotice(n);
    return n;
  }

  // settings.scene changed: the pages get the wallpaper's own scene (the clock's hour, the chosen weather)
  sceneChanged(scene) {
    for (const [, w] of this.wins) if (!w.win.isDestroyed()) w.win.webContents.send('wallpaper:settings', { scene: WS.wallpaperScene(scene) });
  }
  // settings.wallpaper changed (设置 → 桌宠行为 → 桌面壁纸): frame rate, displays, the hotkey follow at once
  settingsChanged() {
    if (!this.active) return;
    const p = this.prefs();
    const key = `${p.displays}|${p.hotkey}|${p.autoReturn}`;
    if (this._prefsKey && this._prefsKey !== key) {
      if (this._hotkey !== p.hotkey) this._registerHotkey();
      if (this.where === 'out') this._armAutoReturn();
      this.reconcile('settings').catch((e) => this.log(e));
    }
    this._prefsKey = key;
    this._power();
  }
  // the wallpaper in use was updated in the store: its windows load the new version
  async refreshPack() {
    const pack = this._pack(this.id);
    if (!pack) return this.exit({ reason: 'no-pack', notify: true });
    this.pack = pack;
    this._note('refresh', { version: pack.manifest.version });
    for (const [, w] of this.wins) if (!w.win.isDestroyed()) { w.fps = null; w.win.webContents.reload(); }
    return { ok: true };
  }

  // ---- read-outs -----------------------------------------------------------------------------------------
  state() {
    return {
      on: this.active || this.mode === 'static', where: this.where, id: this.id, mode: this.mode, platform: this.backend.platform,
      session: this.backend.session || null, displays: [...this.wins.keys()], petDisplay: this.petDisplay,
      fps: Object.fromEntries([...this.wins].map(([d, w]) => [d, w.fps])), lastReason: this.lastReason,
      lastReasonText: this.lastReason ? WS.reasonText(this.lastReason) : null, hotkey: this.hotkeyState,
    };
  }
  async debugState({ probe = true } = {}) {
    const wins = [];
    for (const [did, w] of this.wins) {
      const alive = !w.win.isDestroyed();
      wins.push({
        display: did, alive, attached: w.attached, layout: w.layout || null, ready: w.ready, hidden: w.hidden, fps: w.fps, render: w.render || null,
        bounds: alive ? w.win.getBounds() : null, visible: alive ? w.win.isVisible() : false, focused: alive ? w.win.isFocused() : false,
        // what we asked of the window (Electron has no getter for setIgnoreMouseEvents); the X input shape in probe says what X did
        ignoreMouse: w.ignoreMouse !== false, title: alive ? w.win.getTitle() : null,
        probe: probe && alive && this.backend.probe ? await this.backend.probe(w.win, { shape: true }) : null,
      });
    }
    return { ...this.state(), signals: JSON.parse(JSON.stringify(this.signals)), petPos: this.petPos, enterAt: this.enterAt || null, windows: wins, log: this.log2.slice(), crashes: this.crashes.count() };
  }

  _sleep(ms) { return new Promise((r) => this.T.setTimeout(r, ms)); }
  _clear(k) {
    const t = this._timers[k];
    if (!t) return;
    if (k === 'watchdog' || k === 'static') this.T.clearInterval(t); else this.T.clearTimeout(t);
    this._timers[k] = null;
  }
  // app quitting: everything detached at once (Windows: the helper also detaches when its stdin closes)
  async quit() {
    if (this.active || this.mode === 'static') await this._teardown({ restoreStatic: true });
    this._unregisterHotkey();
    try { this.backend.dispose(); } catch (e) { this.log(e); }
  }
}

// the backend for this platform
function backendFor(platform, opts = {}) {
  if (platform === 'linux') return require('./linux').createLinuxBackend(opts);
  if (platform === 'darwin') return require('./mac').createMacBackend(opts);
  if (platform === 'win32') return require('./win-helper').createWinBackend(opts);
  return {
    platform, session: null, availability: async () => ({ ok: false, reason: 'unsupported-platform' }), windowOptions: () => ({}), attach: async () => ({ ok: false, reason: 'unsupported-platform' }),
    place: async () => ({ ok: true }), detach: async () => ({ ok: true }), status: async () => ({ attached: false }), selfCheck: async () => ({ ok: false }), covered: async () => null,
    otherDesktopWindows: async () => [], setStatic: async () => ({ ok: false }), restoreStatic: async () => ({ ok: true }), on: () => {}, dispose: () => {},
  };
}

module.exports = { WallpaperHost, backendFor, HTML, PRELOAD, AUTO_RETURN_MS, WATCHDOG_MS, DISPLAY_DEBOUNCE_MS };
