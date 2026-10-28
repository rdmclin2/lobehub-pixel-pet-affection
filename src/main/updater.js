'use strict';

// Self-updater. Checks GitHub Releases at launch and every few hours, downloads a newer version in the
// background and installs it: when the computer has been idle for a while (the pet restarts in about
// two seconds and keeps all its state on disk), when the user picks "立即更新" in the ⋯ menu, or when
// the app quits.
//   Windows: electron-updater (NSIS installer, per-user, silent).
//   macOS:   own zip-and-swap (see src/core/update.js): the build has no Apple Developer ID signature.
//   Linux:   the tar.gz cannot replace itself; the menu offers the download page instead.

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, net, shell, powerMonitor } = require('electron');
const U = require('../core/update');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const IDLE_CHECK_MS = 60 * 1000;
const IDLE_INSTALL_S = 10 * 60; // install on its own after 10 minutes without keyboard or mouse input

class Updater extends EventEmitter {
  constructor({ isBusy = () => false, log = () => {} } = {}) {
    super();
    this.isBusy = isBusy;
    this.log = log;
    this.state = { status: 'idle', version: null, url: null, error: null };
    this.staged = null; // macOS: { app, newApp }
    this.installing = false;
    this.win = null; // electron-updater's autoUpdater on Windows
  }

  enabled() {
    return app.isPackaged && process.env.PIXELPET_TEST !== '1' && process.env.PIXELPET_NO_UPDATE !== '1';
  }

  _set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('status', this.state);
  }

  start() {
    if (!this.enabled()) return;
    if (process.platform === 'win32') this._initWindows();
    // PIXELPET_UPDATE_NOW=1 (release checks in CI): check at once and install as soon as it is ready.
    const now = process.env.PIXELPET_UPDATE_NOW === '1';
    if (now) this.on('status', (st) => { if (st.status === 'ready') this.install(); });
    const check = () => this.check().catch((e) => { this.log(e); this._set({ status: 'error', error: e.message }); });
    setTimeout(check, now ? 1000 : 20 * 1000);
    setInterval(check, CHECK_EVERY_MS);
    setInterval(() => this._maybeInstallWhileIdle(), IDLE_CHECK_MS);
    app.on('before-quit', () => this._installOnQuit());
  }

  async check() {
    if (this.state.status === 'downloading' || this.state.status === 'ready' || this.installing) return;
    if (process.platform === 'win32') return this.win.checkForUpdates();
    if (process.platform === 'darwin') return this._checkMac();
    return this._checkOther();
  }

  // ---- Windows -----------------------------------------------------------------------------------
  _initWindows() {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (i) => this._set({ status: 'downloading', version: i.version, error: null }));
    autoUpdater.on('update-downloaded', (i) => this._set({ status: 'ready', version: i.version }));
    autoUpdater.on('error', (e) => { this.log(e); if (this.state.status !== 'ready') this._set({ status: 'error', error: e.message }); });
    this.win = autoUpdater;
  }

  // ---- macOS -------------------------------------------------------------------------------------
  async _checkMac() {
    const where = U.macAppPath(process.execPath);
    const info = U.parseUpdateInfo(await this._text(U.LATEST_URL('latest-mac.yml')));
    if (!U.isNewer(info.version, app.getVersion())) return this._set({ status: 'idle', version: null });
    const zip = U.macZip(info);
    if (!zip || !zip.sha512) throw new Error('latest-mac.yml has no mac zip');
    const page = `https://github.com/${U.REPO}/releases/tag/v${info.version}`;
    // Started from the DMG, from Downloads (translocated) or a read-only folder: it cannot replace itself.
    if (!where.app) return this._set({ status: 'manual', version: info.version, url: page, error: where.reason });

    this._set({ status: 'downloading', version: info.version, error: null });
    const dir = path.join(app.getPath('temp'), 'pixel-pet-affection-update');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(zip.url));
    await this._download(U.LATEST_URL(zip.url), file);
    if ((await U.sha512Base64(file)) !== zip.sha512) {
      fs.rmSync(file, { force: true });
      throw new Error('downloaded update failed its sha512 check');
    }
    // Unpack beside the app so the final move is a rename on the same volume.
    const stageDir = path.join(path.dirname(where.app), `.${path.basename(where.app, '.app')}-update`);
    const newApp = await U.stageMacApp({ zip: file, stageDir, appName: path.basename(where.app) });
    fs.rmSync(file, { force: true });
    this.staged = { app: where.app, newApp, stageDir };
    this._set({ status: 'ready', version: info.version });
  }

  _swapMac(relaunch) {
    const { app: appPath, newApp } = this.staged;
    const script = U.writeSwapScript(path.join(os.tmpdir(), 'pixel-pet-affection-update'));
    const child = spawn('/bin/bash', [script, String(process.pid), appPath, newApp, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
    child.unref();
    this.staged = null;
  }

  // ---- Linux and anything else: point at the download page ------------------------------------------
  async _checkOther() {
    const rel = JSON.parse(await this._text(U.RELEASES_API));
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (U.isNewer(version, app.getVersion())) this._set({ status: 'manual', version, url: rel.html_url });
    else this._set({ status: 'idle', version: null });
  }

  // ---- installing ----------------------------------------------------------------------------------
  // Install now and start the new version. Returns false when there is nothing to install.
  install() {
    const s = this.state;
    if (s.status === 'manual' && s.url) {
      shell.openExternal(s.url);
      return true;
    }
    if (s.status !== 'ready' || this.installing) return false;
    this.installing = true;
    if (process.platform === 'win32') {
      this.win.quitAndInstall(true, true); // silent, then run the new version
    } else {
      this._swapMac(true);
      app.quit();
    }
    return true;
  }

  _maybeInstallWhileIdle() {
    if (this.state.status !== 'ready' || this.installing || this.isBusy()) return;
    if (powerMonitor.getSystemIdleTime() < IDLE_INSTALL_S) return;
    this.install();
  }

  // Quitting with an update ready: macOS swaps the bundle after we exit (Windows: autoInstallOnAppQuit).
  _installOnQuit() {
    if (process.platform === 'darwin' && this.staged && !this.installing) {
      this.installing = true;
      this._swapMac(false);
    }
  }

  // ---- network (Chromium's stack: uses the system proxy) --------------------------------------------
  async _text(url) {
    const r = await net.fetch(url, { headers: { 'User-Agent': `PixelPetAffection/${app.getVersion()}` } });
    if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
    return r.text();
  }

  async _download(url, file) {
    const r = await net.fetch(url, { headers: { 'User-Agent': `PixelPetAffection/${app.getVersion()}` } });
    if (!r.ok || !r.body) throw new Error(`GET ${url} -> HTTP ${r.status}`);
    const out = fs.createWriteStream(file);
    const reader = r.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(value)) await new Promise((res) => out.once('drain', res));
      }
    } finally {
      await new Promise((res) => out.end(res));
    }
  }
}

module.exports = { Updater };
