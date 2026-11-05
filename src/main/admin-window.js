'use strict';

// The settings window (配置后台, docs/admin-console-design.md §5.1): one ordinary, resizable window with the
// admin bundle (src/admin-ui, built from admin/ by `npm run build:admin`). Single instance: opening it again
// shows and focuses the same window and moves it to `section`. It is not a pet window (never in `pets`), so
// it takes no part in collisions or `peers`.

const path = require('node:path');
const { BrowserWindow, nativeTheme, shell } = require('electron');

const INDEX = path.join(__dirname, '..', 'admin-ui', 'index.html');
const SECTION_RE = /^[a-z][a-z0-9-]{0,30}(\/[a-z0-9-]{1,40}){0,2}$/; // up to two levels: store/game/<id>

class AdminWindow {
  constructor({ testMode = false, index = INDEX } = {}) {
    this.win = null;
    this.testMode = testMode;
    this.index = index;
    this.opened = 0; // how many windows were created (the e2e checks a second open reuses the first)
  }

  get alive() {
    return !!(this.win && !this.win.isDestroyed());
  }

  isSender(e) {
    return this.alive && e && e.sender === this.win.webContents;
  }

  send(channel, payload) {
    if (this.alive) this.win.webContents.send(channel, payload);
  }

  // Move the open window to `path` by setting its hash (the console follows hashchange, and reads the hash
  // when it mounts). A window still loading gets it once loaded, so an early request is not lost.
  navigate(path) {
    const wc = this.win.webContents;
    const go = () => { if (this.alive) wc.executeJavaScript(`location.hash = ${JSON.stringify(path)}`).catch(() => {}); };
    if (wc.isLoading()) wc.once('did-finish-load', go);
    else go();
  }

  // Open (or bring forward) the window at `section` ('behavior', 'characters/claude' …); unknown → home.
  open(section) {
    const s = typeof section === 'string' && SECTION_RE.test(section) ? section : '';
    if (this.alive) {
      if (this.win.isMinimized()) this.win.restore();
      if (s) this.navigate(`/${s}`);
      this.win.show();
      this.win.focus();
      return { ok: true, reused: true, opened: this.opened };
    }
    this.opened += 1;
    const win = new BrowserWindow({
      width: 1080, height: 720, minWidth: 860, minHeight: 560,
      title: 'Pixel Pet 设置',
      show: false,
      frame: true,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f8f8f8', // = --lobe-color-bg-layout: no white flash
      alwaysOnTop: false,
      transparent: false,
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'admin-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setMenuBarVisibility(false);
    this.win = win;
    win.loadFile(this.index, { hash: s ? `/${s}` : '/overview' });
    // tests run hidden-free so Playwright sees it at once; a real start waits for the first paint
    if (this.testMode) win.show();
    else win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url) && !this.testMode) shell.openExternal(url);
      return { action: 'deny' };
    });
    // never navigate away from the bundle
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
    win.on('closed', () => { if (this.win === win) this.win = null; });
    return { ok: true, reused: false, opened: this.opened };
  }
}

module.exports = { AdminWindow, SECTION_RE };
