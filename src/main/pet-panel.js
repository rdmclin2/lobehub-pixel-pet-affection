'use strict';

// 她的面板: her state and what you can do with her, in its own small window beside her (right click or a long
// press on her opens it; docs/usage.md). Made the first time it opens, then only shown / hidden, so opening it
// again never leaves a second one behind.
//   open    the pet window asks (pet-panel:open / :toggle) with her box on the screen and what to show
//   close   Esc in it, a click anywhere else (it loses focus), a press in her window, a right click on her again,
//           after a button, her window moving or hiding, she starts thinking
//   buttons pet-panel:act → onAct({ act, food }) — main forwards it to her window, which does it (app.js runAct)
// What it draws is src/renderer/panel/; where it goes is core/pet-panel.js.

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const { placeBeside } = require('../core/pet-panel');

const HTML = path.join(__dirname, '..', 'renderer', 'panel', 'panel.html');
const PAD = 12; // transparent room around the card for its shadow (panel.css body padding)
const STAYS_OPEN = new Set(['mute']); // switches in place; everything else closes the panel first

class PetPanel {
  constructor({ onAct = () => {}, onClosed = () => {}, log = () => {}, testMode = false } = {}) {
    this.onAct = onAct;
    this.onClosed = onClosed;
    this.log = log;
    this.testMode = testMode;
    this.win = null;
    this.size = { w: 264, h: 260 };
    this.anchor = null;
    this.area = null;
    this.side = null;
    this.opens = 0;
    this.closes = [];
    this.acts = [];
    this.lastClose = null;
  }

  get alive() { return !!(this.win && !this.win.isDestroyed()); }
  get visible() { return this.alive && this.win.isVisible(); }
  isSender(e) { return this.alive && !!e && e.sender === this.win.webContents; }

  _create() {
    const win = new BrowserWindow({
      width: this.size.w,
      height: this.size.h,
      show: false,
      frame: false,
      transparent: !this.testMode,
      backgroundColor: this.testMode ? '#e9e4f5' : '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Pixel Pet',
      webPreferences: { preload: path.join(__dirname, 'panel-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, 'pop-up-menu'); // above the pet window, itself always on top
    win.setMenuBarVisibility(false);
    win.on('blur', () => this.close('blur'));
    win.on('closed', () => { this.win = null; });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    this._loaded = win.loadFile(HTML);
    this.win = win;
  }

  // -> { ok, visible, bounds, side }
  async open({ source = 'right-click', anchor = null, payload = null } = {}) {
    if (!payload) return { ok: false, visible: this.visible };
    if (!this.alive) this._create();
    await this._loaded;
    this.anchor = anchor;
    const display = anchor ? screen.getDisplayMatching({ x: anchor.x, y: anchor.y, width: Math.max(1, anchor.width), height: Math.max(1, anchor.height) }) : screen.getPrimaryDisplay();
    this.area = display.workArea;
    const sized = new Promise((resolve) => { this._onSized = resolve; });
    this.win.webContents.send('pet-panel:show', { payload, source, fresh: !this.visible });
    // the page answers with its size (pet-panel:size); one that does not still opens, at the last size
    await Promise.race([sized, new Promise((r) => setTimeout(r, 400))]);
    this._place();
    if (!this.visible) { this.opens += 1; this.win.show(); }
    this.win.focus();
    return { ok: true, visible: this.visible, bounds: this.win.getBounds(), side: this.side };
  }

  // A right click on her while it is open closes it. `wasShown`: it was open when that right click went down, but
  // clicking her took the focus from it and it closed on blur already — the click was meant to close it, so it
  // does not open again.
  async toggle(opts = {}) {
    if (this.visible) { this.close('toggle'); return { ok: true, visible: false }; }
    if (opts.wasShown) return { ok: true, visible: false };
    return this.open(opts);
  }

  // her window moved by (dx, dy) — she walks, it was resized: the panel keeps its place beside her
  follow(dx, dy) {
    if (!this.visible || !this.anchor || (!dx && !dy)) return;
    this.anchor = { ...this.anchor, x: this.anchor.x + dx, y: this.anchor.y + dy };
    this._place();
  }

  update(payload) {
    if (this.visible && payload) this.win.webContents.send('pet-panel:show', { payload, source: 'update', fresh: false });
  }

  _place() {
    if (!this.alive || !this.area) return;
    const anchor = this.anchor || { x: this.area.x + this.area.width / 2, y: this.area.y + this.area.height / 2, width: 0, height: 0 };
    const b = placeBeside({ anchor, size: this.size, area: this.area, pad: PAD });
    this.side = b.side;
    this.win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
  }

  resize(s) {
    const w = Math.round(Number(s && s.w));
    const h = Math.round(Number(s && s.h));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 80 || h < 60 || w > 800 || h > 1200) return;
    this.size = { w, h };
    if (this._onSized) { this._onSized(); this._onSized = null; }
    if (this.visible) this._place(); // 喂食 opens its foods: the card grows, still beside her
  }

  act(m) {
    const act = String((m && m.act) || '');
    if (!act) return;
    this.acts.push(act);
    if (this.acts.length > 50) this.acts.shift();
    if (!STAYS_OPEN.has(act)) this.close('act');
    try { this.onAct({ act, food: m.food ? String(m.food) : undefined }); } catch (e) { this.log(e); }
  }

  close(reason = 'esc') {
    if (!this.visible) return false;
    this.lastClose = { reason, at: Date.now() };
    this.closes.push(reason);
    if (this.closes.length > 50) this.closes.shift();
    this.win.hide();
    this.win.webContents.send('pet-panel:closed', { reason });
    try { this.onClosed({ reason }); } catch (e) { this.log(e); }
    return true;
  }

  debugState() {
    return { alive: this.alive, visible: this.visible, opens: this.opens, closes: this.closes.slice(), acts: this.acts.slice(), bounds: this.alive ? this.win.getBounds() : null, anchor: this.anchor, area: this.area, side: this.side, windows: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('/panel/')).length };
  }
}

module.exports = { PetPanel, PAD };
