'use strict';

// 像素小院 (docs/pixel-scene.md, docs/pixel-scene-design.md §2): a window of its own where she walks about a
// pixel yard. Made the first time it opens, then only shown / hidden (like pet-panel.js). While it is open her
// desktop window is hidden (she "went home"); closing it brings her back where she was — main.js does both
// through onOpen / onClosed. What it draws is src/renderer/scene/.
//   open    tray 「像素小院」, her panel's ⌂ button, Ctrl/⌘+Shift+H on her window, POST /pixel-pet/scene
//   close   its ✕ button, Ctrl/⌘+W or Ctrl/⌘+Shift+H in it, the tray item again, anything that needs her on the
//           desktop (showPet: 显示桌宠, the voice hotkey …), its page crashing

const path = require('node:path');
const { BrowserWindow } = require('electron');

const HTML = path.join(__dirname, '..', 'renderer', 'scene', 'scene.html');
const SIZE = { w: 960, h: 600, minW: 640, minH: 400 };

class SceneWindow {
  constructor({ onOpen = () => {}, onClosed = () => {}, log = () => {}, testMode = false } = {}) {
    this.onOpen = onOpen;
    this.onClosed = onClosed;
    this.log = log;
    this.testMode = testMode;
    this.win = null;
    this.bounds = null;
    this.opens = 0;
    this.closes = [];
    this.sources = [];
  }

  get alive() { return !!(this.win && !this.win.isDestroyed()); }
  get visible() { return this.alive && this.win.isVisible(); }
  isSender(e) { return this.alive && !!e && e.sender === this.win.webContents; }

  _create() {
    const b = this.bounds;
    const win = new BrowserWindow({
      width: b ? b.width : SIZE.w,
      height: b ? b.height : SIZE.h,
      ...(b ? { x: b.x, y: b.y } : {}),
      minWidth: SIZE.minW,
      minHeight: SIZE.minH,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#0b0f0c',
      resizable: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      title: '像素小院',
      webPreferences: { preload: path.join(__dirname, 'scene-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    win.on('closed', () => { this.win = null; });
    // the system close (Alt+F4, the dock) only hides it: she comes back to the desktop the same way as ✕
    win.on('close', (e) => { if (!this._quitting && this.visible) { e.preventDefault(); this.close('window'); } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', () => { this.log(new Error('scene page gone')); this.close('crash'); try { win.destroy(); } catch { /* gone */ } });
    // Ctrl/⌘+W and Ctrl/⌘+Shift+H close the yard; Esc is the page's (folds the 天色 card)
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      if (mod && !input.alt && ((input.code === 'KeyW' && !input.shift) || (input.code === 'KeyH' && input.shift))) {
        e.preventDefault();
        this.close('key');
      }
    });
    this._loaded = win.loadFile(HTML);
    this.win = win;
  }

  async open(source = 'tray') {
    if (this.visible) { this.win.focus(); return { ok: true, visible: true, already: true }; }
    if (!this.alive) this._create();
    await this._loaded;
    this.sources.push(String(source));
    if (this.sources.length > 50) this.sources.shift();
    this.opens += 1;
    try { this.onOpen({ source }); } catch (e) { this.log(e); }
    this.win.webContents.send('scene:shown', { source });
    this.win.show();
    this.win.focus();
    return { ok: true, visible: true };
  }

  close(reason = 'button') {
    if (!this.visible) return false;
    this.bounds = this.win.getBounds();
    this.closes.push(String(reason));
    if (this.closes.length > 50) this.closes.shift();
    this.win.hide();
    this.win.webContents.send('scene:hidden', { reason });
    try { this.onClosed({ reason }); } catch (e) { this.log(e); }
    return true;
  }

  toggle(source) {
    if (this.visible) { this.close('toggle'); return Promise.resolve({ ok: true, visible: false }); }
    return this.open(source);
  }

  send(channel, payload) {
    if (this.alive) this.win.webContents.send(channel, payload);
  }

  // app quitting: the close handler must not keep it
  quit() { this._quitting = true; }

  debugState() {
    return { alive: this.alive, visible: this.visible, opens: this.opens, closes: this.closes.slice(), sources: this.sources.slice(), bounds: this.alive ? this.win.getBounds() : null };
  }
}

module.exports = { SceneWindow, SIZE };
