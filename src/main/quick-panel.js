'use strict';

// 快捷调用面板 (T-2849, docs/quick-panel.md): the window. One small frameless, always-on-top window, made the
// first time it is opened and then only shown / hidden (opening it again never leaves a second one behind).
//   open      right click / long press on her (at that point), the global shortcut (beside her), the tray
//   close     Esc, a click anywhere else (the window loses focus), after running a row, the shortcut again
// What it lists and what an update state reads as live in core/quick-panel.js; what each row does is
// `actions` (main.js). 检查更新… keeps the panel open and shows the check as it goes (检查中 → 已是最新 /
// 发现新版本 / 失败 + 重试); closed before the answer came, she says the answer in her bubble instead.

const path = require('node:path');
const { BrowserWindow, ipcMain, screen } = require('electron');
const Q = require('../core/quick-panel');

const WIDTH = 264;
const HTML = path.join(__dirname, '..', 'renderer', 'quick', 'quick.html');

class QuickPanel {
  // context(): { hasPet, petVisible, canReset, version, petBounds, platform, hotkey }
  // actions: { [id]: () => any } for every row id (core ITEMS) plus install / open-download
  // updater: the Updater (checkNow, state, 'status' events); notify(line): her bubble
  constructor({ context, actions, updater, notify = () => {}, log = () => {}, testMode = false }) {
    this.context = context;
    this.actions = actions;
    this.updater = updater;
    this.notify = notify;
    this.log = log;
    this.testMode = testMode;
    this.win = null;
    this.anchor = null;
    this.size = { w: WIDTH, h: 240 };
    this.opens = 0;
    this.closes = [];
    this.ran = [];
    this.session = null; // { checking: bool } while open
    this.pendingCheck = false; // a check started in the panel whose answer has not been shown yet
    this.lastFeedback = null;
    this._shown = null;
    updater.on('status', (st) => this._onUpdate(st));
    ipcMain.handle('quick:run', (e, { id } = {}) => (this._isSender(e) ? this.run(String(id || '')) : { ok: false }));
    ipcMain.on('quick:size', (e, s) => { if (this._isSender(e)) this._resize(s); });
    ipcMain.on('quick:close', (e, { reason } = {}) => { if (this._isSender(e)) this.close(String(reason || 'esc')); });
  }

  get alive() {
    return !!(this.win && !this.win.isDestroyed());
  }

  get visible() {
    return this.alive && this.win.isVisible();
  }

  _isSender(e) {
    return this.alive && e && e.sender === this.win.webContents;
  }

  _create() {
    const win = new BrowserWindow({
      width: this.size.w,
      height: this.size.h,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Pixel Pet 快捷调用',
      webPreferences: { preload: path.join(__dirname, 'quick-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu'); // above the pet window (itself always on top)
    win.setMenuBarVisibility(false);
    win.on('blur', () => this.close('blur'));
    win.on('closed', () => { this.win = null; });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    this._loaded = win.loadFile(HTML);
    this.win = win;
  }

  _payload() {
    const ctx = this.context();
    const items = Q.buildItems(ctx).map((it) => (it.type === 'separator' ? it : { ...it, hint: Q.keyLabel(it.keys, ctx.platform) }));
    // a found / downloaded version stays reachable (立即更新 / 前往下载页) every time the panel opens
    const st = this.updater.state;
    const keep = ['downloading', 'ready', 'manual'].includes(st.status) || this.pendingCheck;
    return { items, platform: ctx.platform, hotkey: ctx.hotkey, theme: ctx.theme || null, feedback: keep ? Q.updateFeedback(st) : null };
  }

  // -> { ok, visible }
  async open({ source = 'menu', at = null } = {}) {
    if (!this.alive) this._create();
    await this._loaded;
    const ctx = this.context();
    this.opens += 1;
    this.session = { source, at: Date.now() };
    const display = at ? screen.getDisplayNearestPoint(at) : ctx.petBounds && ctx.petVisible ? screen.getDisplayMatching(ctx.petBounds) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.area = display.workArea;
    this.anchor = at || Q.hotkeyAnchor({ pet: ctx.petVisible ? ctx.petBounds : null, size: this.size, area: this.area, cursor: screen.getCursorScreenPoint() });
    this._shown = new Promise((resolve) => { this._onSized = resolve; });
    this.win.webContents.send('quick:open', { ...this._payload(), source, n: this.opens });
    // the page answers with its height (quick:size); a page that does not still opens, at the last size
    await Promise.race([this._shown, new Promise((r) => setTimeout(r, 400))]);
    this._place();
    this.win.show();
    this.win.focus();
    return { ok: true, visible: this.visible, bounds: this.win.getBounds() };
  }

  _place() {
    if (!this.alive || !this.anchor) return;
    const b = Q.placePanel({ anchor: this.anchor, size: this.size, area: this.area });
    this.win.setBounds(b);
  }

  _resize(s) {
    const h = Math.round(Number(s && s.h));
    if (!Number.isFinite(h) || h < 40 || h > 1200) return;
    this.size = { w: WIDTH, h };
    if (this._onSized) { this._onSized(); this._onSized = null; }
    // open already (typing filters it, an update answer adds a block): the top edge stays where it is, only kept
    // inside the screen — no jump to the other side of the anchor
    if (this.visible) {
      const cur = this.win.getBounds();
      this.win.setBounds(Q.placePanel({ anchor: { x: cur.x, y: cur.y }, size: this.size, area: this.area }));
    }
  }

  close(reason = 'esc') {
    if (!this.visible) return false;
    this.closes.push(reason);
    if (this.closes.length > 50) this.closes.shift();
    this.win.hide();
    this.session = null;
    if (this.alive) this.win.webContents.send('quick:closed', { reason });
    return true;
  }

  async toggle(opts = {}) {
    if (this.visible) { this.close('hotkey'); return { ok: true, visible: false }; }
    return this.open(opts);
  }

  _push(fb) {
    this.lastFeedback = fb;
    if (this.alive) this.win.webContents.send('quick:feedback', fb);
  }

  // A row was picked. 检查更新… / 重试 keep the panel open for the answer; everything else closes it first.
  async run(id) {
    this.ran.push(id);
    if (this.ran.length > 50) this.ran.shift();
    if (id === 'check-update' || id === 'retry') return this.checkUpdate();
    const fn = this.actions[id];
    if (!fn) return { ok: false, reason: 'unknown' };
    this.close('run');
    try {
      const r = await fn();
      return { ok: true, result: r === undefined ? null : r };
    } catch (e) {
      this.log(e);
      return { ok: false, reason: 'error', message: e.message };
    }
  }

  // 检查更新: the same Updater the tray and the settings window use (src/main/updater.js), no checking of our own.
  checkUpdate() {
    this.pendingCheck = true;
    const p = this.updater.checkNow();
    // checkNow answers at once (without a status event) when updates are off (开发版) or a download is on its way
    this._push(Q.updateFeedback(this.updater.state));
    Promise.resolve(p).then((st) => this._onUpdate(st || this.updater.state, true)).catch((e) => this.log(e));
    return { ok: true, feedback: Q.updateFeedback(this.updater.state) };
  }

  _onUpdate(st, final = false) {
    const fb = Q.updateFeedback(st);
    if (!fb) return;
    if (this.visible) this._push(fb);
    const done = final || ['latest', 'error', 'ready', 'manual', 'disabled'].includes(st.status) || (st.status === 'downloading' && this.pendingCheck);
    if (!done || !this.pendingCheck) return;
    this.pendingCheck = false;
    // closed before the answer: she says it (ready / manual she announces herself, app.js onUpdateStatus)
    if (!this.visible && !['ready', 'manual'].includes(st.status)) this.notify(Q.feedbackLine(fb));
  }

  debugState() {
    return { alive: this.alive, visible: this.visible, opens: this.opens, closes: this.closes.slice(), ran: this.ran.slice(), bounds: this.alive ? this.win.getBounds() : null, area: this.area || null, anchor: this.anchor, lastFeedback: this.lastFeedback, windows: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('/quick/')).length };
  }
}

module.exports = { QuickPanel, WIDTH };
