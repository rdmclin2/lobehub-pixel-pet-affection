'use strict';

// 小游戏窗口 (docs/mini-games.md §2): a window of its own where she plays one downloaded game pack. Made the
// first time it opens, then only shown / hidden (like pet-panel.js); opening another game reloads the page with
// that game. While it is open her desktop window is hidden (she went into the game); closing it brings her back
// where she was — main.js does both through onOpen / onClosed. What it draws is src/renderer/game/.
//   open    tray 「小游戏」, her panel's ⌂ button, Ctrl/⌘+Shift+H on her window, 商店 → 小游戏 → 开始玩,
//           POST /pixel-pet/scene
//   close   its ✕ button, Ctrl/⌘+W or Ctrl/⌘+Shift+H in it, the tray item again, anything that needs her on the
//           desktop (showPet: 显示桌宠, the voice hotkey …), its page crashing

const path = require('node:path');
const { BrowserWindow } = require('electron');

const HTML = path.join(__dirname, '..', 'renderer', 'game', 'game.html');
const SIZE = { w: 960, h: 600, minW: 640, minH: 400 };

class GameWindow {
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
    this.gameId = null;
    this.title = '小游戏';
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
      title: this.title,
      webPreferences: { preload: path.join(__dirname, 'game-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    win.on('closed', () => { this.win = null; });
    // the system close (Alt+F4, the dock) only hides it: she comes back to the desktop the same way as ✕
    win.on('close', (e) => { if (!this._quitting && this.visible) { e.preventDefault(); this.close('window'); } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', () => { this.log(new Error('game page gone')); this.close('crash'); try { win.destroy(); } catch { /* gone */ } });
    // Ctrl/⌘+W and Ctrl/⌘+Shift+H close the game; Esc is the page's (folds the 天色 card)
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const mod = process.platform === 'darwin' ? input.meta : input.control;
      if (mod && !input.alt && ((input.code === 'KeyW' && !input.shift) || (input.code === 'KeyH' && input.shift))) {
        e.preventDefault();
        this.close('key');
      }
    });
    this.win = win;
  }

  // game: { id, name } — the game to play; another game than the one loaded reloads the page
  async open(source = 'tray', game = null) {
    const id = game && game.id;
    if (this.visible && (!id || id === this.gameId)) { this.win.focus(); return { ok: true, visible: true, already: true, game: this.gameId }; }
    if (!this.alive) this._create();
    if (id && id !== this.gameId) {
      this.gameId = id;
      this.title = game.name || '小游戏';
      this.win.setTitle(this.title);
      this._loaded = this.win.loadFile(HTML, { query: { game: id } });
    }
    await this._loaded;
    this.sources.push(String(source));
    if (this.sources.length > 50) this.sources.shift();
    this.opens += 1;
    try { this.onOpen({ source }); } catch (e) { this.log(e); }
    this.win.webContents.send('game:shown', { source });
    this.win.show();
    this.win.focus();
    return { ok: true, visible: true, game: this.gameId };
  }

  close(reason = 'button') {
    if (!this.visible) return false;
    this.bounds = this.win.getBounds();
    this.closes.push(String(reason));
    if (this.closes.length > 50) this.closes.shift();
    this.win.hide();
    this.win.webContents.send('game:hidden', { reason });
    try { this.onClosed({ reason }); } catch (e) { this.log(e); }
    return true;
  }

  // reload the page (the game was updated or deleted) — only when it is not on screen
  forget(id) {
    if (this.gameId === id && !this.visible) { this.gameId = null; if (this.alive) this.win.loadURL('about:blank'); }
  }

  send(channel, payload) {
    if (this.alive) this.win.webContents.send(channel, payload);
  }

  // app quitting: the close handler must not keep it
  quit() { this._quitting = true; }

  debugState() {
    return { alive: this.alive, visible: this.visible, game: this.gameId, title: this.alive ? this.win.getTitle() : null, opens: this.opens, closes: this.closes.slice(), sources: this.sources.slice(), bounds: this.alive ? this.win.getBounds() : null };
  }
}

module.exports = { GameWindow, SIZE };
