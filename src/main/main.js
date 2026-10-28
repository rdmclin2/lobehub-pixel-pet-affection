'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, dialog } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient } = require('../core/lh-client');
const { Store } = require('../core/store');
const { SettingsStore } = require('../core/settings');
const { PetService } = require('./pet-service');
const { Updater } = require('./updater');
const { SPECIES, SPECIES_IDS } = require('../core/species');
const { FOODS } = require('../core/pet-state');
const { artFor } = require('../core/outfits');

const TEST_MODE = process.env.PIXELPET_TEST === '1';
const HEARTBEAT_MS = TEST_MODE ? 2000 : 30 * 1000;
const SIZES = { onboarding: { w: 680, h: 480 }, pet: { w: 230, h: 340 }, panel: { w: 460, h: 540 } };

if (process.env.PIXELPET_DATA_DIR) app.setPath('userData', process.env.PIXELPET_DATA_DIR);
if (TEST_MODE) app.commandLine.appendSwitch('no-sandbox');

let win = null;
let service = null;
let updater = null;
let petBounds = null; // the pet window's bounds while a panel (wardrobe / topics) has it enlarged

function place(mode) {
  const { w, h } = SIZES[mode];
  const wa = screen.getPrimaryDisplay().workArea;
  if (mode === 'onboarding') win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h });
  else win.setBounds({ x: wa.x + wa.width - w - 24, y: wa.y + wa.height - h - 24, width: w, height: h });
}

function logFile() {
  return path.join(app.getPath('userData'), 'pixel-pet.log');
}

function logError(e) {
  const line = `${new Date().toISOString()} [${e.code || 'error'}] ${e.message}${e.stderr ? ` | stderr: ${String(e.stderr).trim().slice(0, 500)}` : ''}\n`;
  console.error('[pixel-pet]', line.trim());
  try { fs.appendFileSync(logFile(), line); } catch { /* logging must never break the pet */ }
}

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Pictures arrive from the renderer as data URLs; write them to a private temp dir for `lh file upload`.
function saveImages(images) {
  const list = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
  if (!list.length) return { paths: [], cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-img-'));
  const paths = [];
  list.forEach((img, i) => {
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((img && img.dataUrl) || ''));
    if (!m) return;
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_IMAGE_BYTES) return;
    const file = path.join(dir, `image-${i + 1}.${IMG_EXT[m[1]]}`);
    fs.writeFileSync(file, buf);
    paths.push(file);
  });
  return { paths, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: SIZES.onboarding.w,
    height: SIZES.onboarding.h,
    frame: false,
    transparent: !TEST_MODE, // opaque in tests so screenshots have a background
    backgroundColor: TEST_MODE ? '#e9e4f5' : '#00000000',
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function wire() {
  ipcMain.handle('boot', () => {
    const v = service.init();
    place(v ? 'pet' : 'onboarding');
    if (v) setTimeout(() => service.warmup().catch((e) => logError(e)), 1500);
    return { view: v, update: updater.state, settings: service.getSettings(), species: SPECIES_IDS.map((id) => ({ ...SPECIES[id], fallback: undefined, portrait: artFor(id, 'daily') || artFor(id, 'scarf') })), foods: FOODS, testMode: TEST_MODE };
  });
  ipcMain.handle('whoami', () => service.lh.whoami());
  const onLoginPrompt = (p) => {
    send('login-prompt', p);
    // The CLI opens the browser itself; only step in if it could not.
    if (p.browserFailed && p.url && /^https:\/\//.test(p.url)) shell.openExternal(p.url);
  };
  ipcMain.handle('spaces', async () => {
    try {
      return { ok: true, ...(await service.spaces({ onStep: (s) => send('hatch-step', s), onLoginPrompt })) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('hatch', async (_e, { speciesId, name, localAbilities, space }) => {
    try {
      const { view, localError, localWarning } = await service.hatch({
        speciesId,
        name,
        localAbilities: !!localAbilities,
        space: space && typeof space === 'object' ? { workspaceId: typeof space.workspaceId === 'string' ? space.workspaceId : null, name: String(space.name || ''), switchToPersonal: !!space.switchToPersonal } : null,
        onStep: (s) => send('hatch-step', s),
        onLoginPrompt,
      });
      // the window shrinks to pet size when the renderer enters the pet screen (see 'place')
      return { ok: true, view, localError, localWarning };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('act', (_e, { kind, food }) => service.act(kind, food));
  ipcMain.handle('talk-topic', (_e, { id }) => service.talkTopic(String(id || '')));
  ipcMain.handle('get-settings', () => service.getSettings());
  ipcMain.handle('confirm-age', (_e, { adult }) => service.answerAgeGate(!!adult));
  ipcMain.handle('set-adult', (_e, { on }) => service.setAdultContent(!!on));
  ipcMain.handle('equip-outfit', (_e, { id }) => service.equipOutfit(String(id || '')));
  ipcMain.handle('mark-seen', (_e, { kind }) => service.markSeen(String(kind || '')));
  ipcMain.handle('chat', async (_e, { text, images, files }) => {
    const { paths, cleanup } = saveImages(images);
    // Dropped files are passed by path only (never read or uploaded here): must be absolute and exist.
    const filePaths = (Array.isArray(files) ? files : []).filter((f) => typeof f === 'string' && path.isAbsolute(f) && fs.existsSync(f)).slice(0, 10);
    try {
      return await service.chat(text, paths, filePaths);
    } finally {
      cleanup();
    }
  });
  ipcMain.handle('pick-images', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    if (r.canceled) return [];
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    return r.filePaths.slice(0, MAX_IMAGES).flatMap((f) => {
      const buf = fs.readFileSync(f);
      if (buf.length > MAX_IMAGE_BYTES) return [];
      return [{ name: path.basename(f), dataUrl: `data:${mime[path.extname(f).slice(1).toLowerCase()]};base64,${buf.toString('base64')}` }];
    });
  });
  ipcMain.handle('set-local', (_e, { on }) => service.setLocalAbilities(!!on));
  ipcMain.on('cancel', () => service.cancel());
  ipcMain.handle('release', async (_e, opts) => {
    const r = await service.release(opts);
    place('onboarding');
    return r;
  });
  ipcMain.on('move-by', (_e, { dx, dy }) => {
    if (!win) return;
    const [x, y] = win.getPosition();
    win.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  ipcMain.on('place', (_e, mode) => { if (mode in SIZES) { petBounds = null; place(mode); } });
  // Wardrobe / topic panel: grow the pet window up and to the left (its bottom-right corner stays put),
  // then give the pet its old bounds back when the panel closes.
  ipcMain.on('panel', (_e, open) => {
    if (!win) return;
    if (open && !petBounds) {
      petBounds = win.getBounds();
      const { w, h } = SIZES.panel;
      const wa = screen.getDisplayMatching(petBounds).workArea;
      const x = Math.max(wa.x, Math.min(petBounds.x + petBounds.width - w, wa.x + wa.width - w));
      const y = Math.max(wa.y, Math.min(petBounds.y + petBounds.height - h, wa.y + wa.height - h));
      win.setBounds({ x, y, width: w, height: h });
    } else if (!open && petBounds) {
      win.setBounds(petBounds);
      petBounds = null;
    }
  });
  ipcMain.on('quit', () => app.quit());
  ipcMain.handle('update-install', () => updater.install());

  if (TEST_MODE) {
    // Test-only hooks used by the E2E suite to drive time-dependent behaviour.
    ipcMain.handle('debug-set', (_e, patch) => service.debugSet(patch));
    ipcMain.handle('debug-heartbeat', async () => {
      await service.heartbeat();
      return service.view();
    });
  }

  service.on('update', (v) => send('update', v));
  service.on('say', (m) => send('say', m));
  service.on('thinking', (b) => send('thinking', b));
  service.on('affection', (a) => send('affection', a));
  service.on('settings', (st) => send('settings', st));
  service.on('error', logError);
  updater.on('status', (st) => send('update-status', st));
  ipcMain.on('open-log', () => { try { fs.appendFileSync(logFile(), ''); shell.showItemInFolder(logFile()); } catch { /* ignore */ } });
}

app.whenReady().then(() => {
  const store = new Store(app.getPath('userData'));
  service = new PetService({ lh: new LhClient(), store, settingsStore: new SettingsStore(app.getPath('userData')) });
  updater = new Updater({ isBusy: () => service.busy, log: logError });
  wire();
  createWindow();
  updater.start();
  if (!TEST_MODE) setInterval(() => service.heartbeat().catch((e) => console.error(e)), HEARTBEAT_MS);
});

app.on('window-all-closed', () => app.quit());
