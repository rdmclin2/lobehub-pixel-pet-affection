'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, dialog, clipboard, safeStorage, session, systemPreferences, Tray, Menu, nativeImage, protocol, net, globalShortcut } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient } = require('../core/lh-client');
const { fileCache } = require('../core/lh-path');
const CUE_STATES = require('../core/fx').STATES.filter((x) => x !== 'lifted');
// 动作 in the settings window (the old ⋯ → 动作… list): every cue, plus `turn` (she faces the other way)
const ADMIN_CUES = [...CUE_STATES, 'turn'];
const { ResponsesClient, serverUrl } = require('../core/responses-client');
const { userAvatar } = require('../core/user-avatar');
const { Store } = require('../core/store');
const { ChatLog } = require('../core/chat-log');
const { SettingsStore, petScale, clampScale } = require('../core/settings');
const { PetService } = require('./pet-service');
const { Updater } = require('./updater');
const { SPECIES, SPECIES_IDS, getSpecies } = require('../core/species');
const { FOODS } = require('../core/pet-state');
const { registerPackScheme, PackStore } = require('./packs');
const { CatalogDownloader } = require('./catalog');
const Catalog = require('../core/catalog');
const { GENERIC_BASE, isGenericBase } = require('../core/generic');
const { serveVrmLibrary } = require('./vrm-library');
const vrmDances = require('./vrm-dances');
const DancesLib = require('../core/vrm-dances');
const danceImport = require('./dance-import');
const { ApiServer } = require('./api-server');
const { InterjectStore } = require('../core/interject');
const { screenPx } = require('../core/fx');
const { TtsEngine, NEURAL, defaultEngine } = require('../core/tts');
const { TtsCache } = require('../core/tts-cache');
const { TtsKeyStore } = require('../core/tts-keys');
const { AsrEngine, KEY_ID: ASR_KEY_ID, MAX_BYTES: ASR_MAX_BYTES, mediaAllowed } = require('../core/asr');
const { VoicePacks, packApplies, resolvePack, voiceForPack, AUTO: PACK_AUTO, norm: packNorm } = require('../core/voice-pack');
const VoiceGender = require('../core/voice-gender');
const IVoice = require('../core/interaction-voice');
const { AdminWindow } = require('./admin-window');
const { VoiceHotkey } = require('./voice-hotkey');
const { PetPanel } = require('./pet-panel');
const { createAdminSettings } = require('./admin-settings');
const { ChatImages, readImage: readChatImage, messageView: chatMessageView, MAX_IMAGES: CHAT_MAX_IMAGES } = require('../core/admin-chat');
const { createBroadcast } = require('./broadcast');
const U = require('../core/update');
const settingsSchema = require('../core/settings-schema');
const { buildRoster, packRows, adminView } = require('../core/roster');

const TEST_MODE = process.env.PIXELPET_TEST === '1';
const HEARTBEAT_MS = TEST_MODE ? 2000 : 30 * 1000;
const SIZES = { onboarding: { w: 680, h: 480 }, pet: { w: 230, h: 340 }, panel: { w: 460, h: 540 } };

if (process.env.PIXELPET_DATA_DIR) app.setPath('userData', process.env.PIXELPET_DATA_DIR);
if (TEST_MODE) app.commandLine.appendSwitch('no-sandbox');
registerPackScheme();
// 系统 → 硬件加速 (settings.system.hardwareAcceleration): only possible before the app is ready, so a change
// applies after a restart (the settings window says so and offers 立即重启).
try { if (new SettingsStore(app.getPath('userData')).load().system.hardwareAcceleration === false) app.disableHardwareAcceleration(); } catch { /* defaults */ }

let win = null;
let vrmLibrary = null; // where the VRM motion library is served from (src/main/vrm-library.js)
let service = null;
let updater = null;
let packStore = null;
let catalog = null; // 下载角色 (src/main/catalog.js)
let danceStore = null; // 商店 → 舞蹈: the same downloader, installing into the dance library
let petBounds = null; // the pet window's bounds while a panel (wardrobe / topics) has it enlarged
let apiServer = null;
let admin = null; // the settings window (admin-window.js), single instance
let adminSettings = null; // admin-set / admin-reset (admin-settings.js)
let chatImages = null; // 设置窗口 → 聊天: pictures sent there (core/admin-chat.js, docs/admin-chat.md)
let tray = null;
let trayMenu = null; // kept so the e2e can read and click it (debug-tray)
let nextOpenPath = null; // E2E only (debug-next-open): what the next 导入 Live2D 模型… / 导入 VRM 模型… picks
let nextSavePath = null; // E2E only (debug-next-save): where the next 导出… writes
const openedLinks = []; // E2E only: links the window asked to open (not opened in tests)
let micAccessOverride = null; // E2E only (debug-mic-access): 'denied' plays a refused microphone
let petPanel = null; // 她的面板 (pet-panel.js): her state and buttons, in its own window beside her
let voiceHotkey = null; // 快捷键唤起语音对话 (voice-hotkey.js): settings.asr.hotkey as a global shortcut
let tts = null; // { engine, keys, cache }: the voice engines (core/tts.js); keys stay in this process
// Every pet window on the desktop: the companion ('main') and visiting model-chan ('visitor:<id>').
// Each reports its character box and speed while flying, so a thrown pet can knock into the others.
const pets = new Map(); // id -> { win, speciesId, hit: { x, y, w, h } (in the window), vx, vy }
const VISITOR_SIZE = { w: 190, h: 250 };
const windowOf = (e) => BrowserWindow.fromWebContents(e.sender);
const petIdOf = (w) => { for (const [id, p] of pets) if (p.win === w) return id; return null; };

// The pet window follows the pet's scale: the character area is 150x190 at 1, plus room for the bubble
// and the controls. The scale is capped so the window still fits the screen.
const petDims = (k) => ({ w: Math.round(Math.max(SIZES.pet.w, 150 * k + 80)), h: Math.round(Math.max(260, SIZES.pet.h + 190 * (k - 1))) });
function fitScale(k, bounds) {
  const wa = screen.getDisplayMatching(bounds || win.getBounds()).workArea;
  const maxK = Math.min((wa.height - 24 - SIZES.pet.h) / 190 + 1, (wa.width - 24 - 80) / 150);
  return clampScale(Math.min(k, maxK));
}

// Resize the pet window to scale `k`, keeping its bottom-right corner where it is. Returns the scale used.
function resizePet(k) {
  const fit = (b) => {
    const wa = screen.getDisplayMatching(b).workArea;
    const { w, h } = petDims(k);
    return { x: Math.max(wa.x, b.x + b.width - w), y: Math.max(wa.y, b.y + b.height - h), width: w, height: h };
  };
  k = fitScale(k, petBounds || undefined);
  if (petBounds) petBounds = fit(petBounds); // a panel is open: applied when it closes
  else if (win) win.setBounds(fit(win.getBounds()));
  return k;
}

function place(mode) {
  const { w, h } = mode === 'pet' ? petDims(fitScale(petScale(service ? service.settings : null))) : SIZES[mode];
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
function sendAll(channel, payload) {
  for (const p of pets.values()) if (!p.win.isDestroyed()) p.win.webContents.send(channel, payload);
}
// Every window that shows settings: the pet windows and the settings window (docs §5.4). The settings
// window is not in `pets`, so it never takes part in collisions or `peers`.
const broadcast = createBroadcast({ pets, admin: () => admin });

// ---- the settings window (配置后台) ----------------------------------------------------------------------
// Everything the console shows, derived again on every change: one source (PetService), no copies.
// voicePackStateOf(base): her 语音包 in force (set in wire() next to set-voice-pack / voice-pack-state)
let voicePackStateOf = null;
function adminState() {
  const view = service.view();
  const settings = service.getSettings();
  return { view: adminView(view), settings, roster: buildRoster(view, settings, { characters: service.characterList().map((e) => ({ ...e, pack: service._characterInfo(e).pack })), look: (id) => service.lookFor(id, 'daily'), outfitsOf: (id) => service.outfitsOf(id), voicePack: voicePackStateOf }), packs: packRows(packStore.packs), catalog: service.catalogList(), downloads: catalog ? catalog.state() : [], update: updater.state, apiStatus: apiServer ? apiServer.status() : null };
}
let adminPush = null;
// What the console was last sent (JSON): a push that changes nothing it shows (most heartbeats, the second
// half of a save, a re-emitted view) is not sent at all. admin-boot clears it (a new window has nothing yet).
let adminSent = null;
function pushAdmin() {
  if (!admin || !admin.alive || adminPush) return;
  adminPush = setImmediate(() => {
    adminPush = null;
    if (!admin.alive) return;
    const st = adminState();
    const json = JSON.stringify(st);
    if (json === adminSent) return;
    adminSent = json;
    admin.send('admin-state', st);
  });
}
// The window's first copy: what later pushes are compared against.
function bootState() {
  const st = adminState();
  adminSent = JSON.stringify(st);
  return st;
}
function openAdmin(section) {
  return admin.open(section);
}
function showPet() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
// 快捷键唤起语音对话: wherever the owner is, the pet comes up (shown, restored, focused so Esc works) and her
// window starts listening — or, while she listens, stops and recognises (renderer onVoiceHotkey → micStart /
// micStop). With 语音输入 off she says how to turn it on.
function onVoiceHotkey(p) {
  if (!win || win.isDestroyed()) return;
  showPet();
  send('voice-hotkey', p);
}
function applyHotkey() {
  if (!voiceHotkey || !service) return false;
  const before = JSON.stringify(voiceHotkey.status());
  voiceHotkey.apply(service.settings.asr.hotkey);
  return JSON.stringify(voiceHotkey.status()) !== before;
}
// 托盘 (§5.3): the way back to the settings and to the pet when she is covered or off screen.
function createTray() {
  if (TEST_MODE && process.env.PIXELPET_TRAY !== '1') return;
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png')).resize({ width: 16, height: 16 });
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip('Pixel Pet');
    trayMenu = Menu.buildFromTemplate([
      { label: '打开设置…', click: () => openAdmin() },
      { label: '显示桌宠', click: () => { showPet(); if (service && service.pet) place('pet'); } },
      { label: '重置姿势', click: () => { resetPose('tray'); } },
      { type: 'separator' },
      { label: '检查更新', click: () => { checkUpdatesWithDialog('tray').catch(logError); } },
      { label: '退出', click: () => app.quit() },
    ]);
    tray.setContextMenu(trayMenu);
    tray.on('click', () => openAdmin());
  } catch (e) {
    logError(e); // no tray on this desktop: the ⚙ button, a right click on her and Ctrl+, still open the settings
  }
}
// macOS application menu: 关于 / 检查更新… / 偏好设置… ⌘, / 退出 ⌘Q. e2e runs build it on Linux too
// (PIXELPET_E2E_APP_MENU=1) to click 检查更新… the way the menu does.
function createAppMenu() {
  if (process.platform !== 'darwin' && !(TEST_MODE && process.env.PIXELPET_E2E_APP_MENU === '1')) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about', label: '关于 Pixel Pet' }, { label: '检查更新…', click: () => { checkUpdatesWithDialog('app-menu').catch(logError); } }, { type: 'separator' }, { label: '偏好设置…', accelerator: 'CmdOrCtrl+,', click: () => openAdmin() }, { type: 'separator' }, { role: 'quit', label: '退出' }] },
    { role: 'editMenu' },
  ]));
}

// 检查更新… (顶栏菜单 / 托盘): the same Updater.checkNow() the settings window uses, answered in a native dialog —
// 已是最新 / 发现新版本（前往下载页 · 下载中）/ 已下载好（立即更新）/ 失败（重试）/ 开发版不检查. A version that
// was still downloading gets a second dialog once it is ready. One check at a time: a second click while one is
// on its way waits for the same answer. e2e runs record each dialog (debug-update-dialogs) and answer it
// with the next queued button id (debug-update-answer), or close it.
const updateDialogs = []; // E2E only
const updateAnswers = []; // E2E only
let updateCheckRun = null;
async function showUpdateDialog(d, source) {
  const buttons = d.buttons.map((b) => b.label);
  const cancelId = Math.max(0, d.buttons.findIndex((b) => b.id === 'ok'));
  if (TEST_MODE) {
    const want = updateAnswers.shift();
    const i = want ? d.buttons.findIndex((b) => b.id === want) : -1;
    updateDialogs.push({ ...d, source, at: Date.now(), answered: i >= 0 ? d.buttons[i].id : 'ok' });
    return i >= 0 ? d.buttons[i].id : 'ok';
  }
  const opts = { type: d.type, title: '检查更新', message: d.message, detail: d.detail, buttons, defaultId: 0, cancelId, noLink: true };
  const r = await dialog.showMessageBox(opts);
  return (d.buttons[r.response] || d.buttons[cancelId]).id;
}
const updateDecided = () => new Promise((resolve) => {
  if (updater.state.status !== 'checking') return resolve(updater.state);
  const h = (st) => { if (st.status !== 'checking') { updater.off('status', h); resolve(st); } };
  updater.on('status', h);
});
function checkUpdatesWithDialog(source = 'menu') {
  if (updateCheckRun) return updateCheckRun;
  updateCheckRun = (async () => {
    try {
      for (;;) {
        if (!updater.enabled() && updater.state.status !== 'disabled') updater._set({ status: 'disabled' });
        Promise.resolve(updater.checkNow()).catch(logError);
        const st = await updateDecided();
        const d = U.updateCheckDialog(st);
        if (!d) return st;
        const pick = await showUpdateDialog(d, source);
        if (pick === 'retry') continue;
        if (pick === 'install') updater.install();
        else if (pick === 'open') { if (TEST_MODE) openedLinks.push(st.url); else updater.install(); }
        else if (st.status === 'downloading') {
          // the download goes on: say so again once it is ready (立即更新 / 稍后)
          const h = (s2) => {
            if (s2.status === 'downloading' || s2.status === 'checking') return;
            updater.off('status', h);
            const d2 = s2.status === 'ready' ? U.updateCheckDialog(s2) : null;
            if (d2) showUpdateDialog(d2, source).then((p2) => { if (p2 === 'install') updater.install(); }).catch(logError);
          };
          updater.on('status', h);
        }
        return st;
      }
    } finally {
      updateCheckRun = null;
    }
  })();
  return updateCheckRun;
}

// ---- visitors (同屏伙伴): other model-chan on the desktop, each in its own small window -------------
// Visitors are characters (T-2764: `claude-pixel`, `vrm-gpt-…`); `speciesId` of a pet window is her base.
function syncVisitors() {
  const want = service && service.pet ? service.settings.visitors.filter((id) => { const b = service._baseOf(id); return b && b !== service.pet.speciesId; }) : [];
  for (const [id, p] of pets) {
    if (id === 'main') continue;
    if (!want.includes(p.characterId)) { pets.delete(id); if (!p.win.isDestroyed()) p.win.destroy(); }
  }
  want.forEach((characterId, i) => {
    const id = `visitor:${characterId}`;
    const speciesId = service._baseOf(characterId);
    if (pets.has(id)) return;
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const mb = win.getBounds();
    const x = Math.max(wa.x, mb.x - (i + 1) * (VISITOR_SIZE.w + 10));
    const v = new BrowserWindow({
      x, y: wa.y + wa.height - VISITOR_SIZE.h, width: VISITOR_SIZE.w, height: VISITOR_SIZE.h,
      frame: false, transparent: !TEST_MODE, backgroundColor: TEST_MODE ? '#e9e4f5' : '#00000000', resizable: false, hasShadow: false, alwaysOnTop: true, skipTaskbar: true, focusable: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    });
    v.setMenuBarVisibility(false);
    v.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { visitor: characterId } });
    pets.set(id, { win: v, speciesId, characterId, hit: null, vx: 0, vy: 0 });
    v.on('closed', () => { if (pets.get(id) && pets.get(id).win === v) pets.delete(id); });
  });
}

// ---- the local HTTP API (src/core/api.js): commands the renderer carries out ------------------
let apiSeq = 0;
const apiWaits = new Map();
function askRenderer(cmd, args, timeoutMs = 8000) {
  if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, reason: 'no-window' });
  const id = ++apiSeq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { apiWaits.delete(id); resolve({ ok: false, reason: 'timeout' }); }, timeoutMs);
    apiWaits.set(id, (r) => { clearTimeout(t); resolve(r); });
    win.webContents.send('api-cmd', { id, cmd, args });
  });
}
// ---- dancing (docs/vrm-dance.md): the list is main's (the folder on disk), playing is the pet window's ----
function danceList() {
  const r = vrmDances.listDances(vrmLibrary && vrmLibrary.dances);
  const v = service.view();
  const no = DancesLib.cannotDance(v && v.look);
  // coverUrl / importedAt: for the lists (the pet window's 跳舞 menu, the settings window's 舞蹈 page)
  const row = (e) => ({ ...DancesLib.publicEntry(e), coverUrl: e.cover ? `vrmlib://dance/${e.cover}` : null, ...(e.importedAt ? { importedAt: e.importedAt } : {}) });
  return { dir: r.dir, source: r.source, ...(r.refused ? { refused: r.refused } : {}), ...(r.error ? { error: r.error } : {}), vrm: !no, ...(no ? { reason: no.reason, message: no.message, kind: no.kind } : {}), importing: danceImport.importing(), dances: r.dances.map(row) };
}
// Dance in the pet window: not a VRM look → the reason, without asking the window; an unknown id → no-dance.
async function dancePlay({ id, name, loop } = {}) {
  const v = service.view();
  if (!v) return { ok: false, reason: 'no-pet' };
  const no = DancesLib.cannotDance(v.look);
  if (no) return { ok: false, ...no };
  const list = vrmDances.listDances(vrmLibrary && vrmLibrary.dances).dances;
  if ((id || name) && !DancesLib.findDance(list, { id, name })) return { ok: false, reason: 'no-dance', dances: list.map((d) => d.id) };
  return askRenderer('dance', { id: id || null, name: name || null, loop }, 15000);
}
const danceStop = () => askRenderer('dance-stop', {});
// 重置姿势 (T-2830, docs/usage.md): 托盘 → 重置姿势, Ctrl/⌘+Shift+R in her window, the toolbar's ↺ (IPC reset-pose)
// and the local API POST /reset-pose all come here. The pet window ends what is its own and resets her director
// (app.js resetPose), then main ends what is main's — asleep, she wakes up (no affection lost: a fix, not a nudge).
// In that order: the director already knows it is a reset when the wake comes in, so sit.doze fades back too.
async function resetPose(source = 'ipc') {
  if (!service || !service.pet) return { ok: false, reason: 'no-pet' };
  const r = await askRenderer('reset-pose', { source });
  const woke = service.resetPose();
  return { ...r, woke: woke.woke };
}
const danceLoop = (on) => askRenderer('dance-loop', { on: !!on });
// 导入舞蹈 (settings → 舞蹈, docs/vrm-dance.md §5.5): pick (a dialog; e2e: debug-next-open, several paths split by
// newlines) → a draft for the confirm dialog; commit bakes it into the dance library in a worker.
async function pickPaths(e, opts) {
  if (nextOpenPath) { const p = nextOpenPath.split('\n').filter(Boolean); nextOpenPath = null; return p; }
  const r = await dialog.showOpenDialog(windowOf(e) || win, opts);
  return r.canceled ? [] : r.filePaths || [];
}
const danceDirNow = () => (vrmLibrary && vrmLibrary.dances && vrmLibrary.dances.dir) || null;
const danceState = async () => { const r = await askRenderer('dance-state', {}); return r && r.ok ? r.dance : null; };

async function applyApi() {
  if (!apiServer) return;
  const a = service.settings.api;
  const st = await apiServer.apply({ enabled: a.enabled, port: a.port });
  broadcast('api-status', st);
  pushAdmin();
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
  // 她的面板 goes with her: it follows when her window moves (she walks, the window grows), closes when it hides
  let lastPetBounds = win.getBounds();
  win.on('move', () => {
    const b = win.getBounds();
    if (petPanel) petPanel.follow(b.x - lastPetBounds.x, b.y - lastPetBounds.y);
    lastPetBounds = b;
  });
  win.on('hide', () => { if (petPanel) petPanel.close('hidden'); });
  win.on('minimize', () => { if (petPanel) petPanel.close('hidden'); });
  // CmdOrCtrl+, while the pet window has focus opens the settings (no global shortcut: no clash with other apps)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === ',' && (process.platform === 'darwin' ? input.meta : input.control) && !input.alt && !input.shift) {
      e.preventDefault();
      openAdmin();
    }
    // Ctrl/⌘+Shift+R while the pet window has focus: 重置姿势 (also keeps Electron's force-reload off this key)
    if (input.type === 'keyDown' && input.code === 'KeyR' && (process.platform === 'darwin' ? input.meta : input.control) && input.shift && !input.alt) {
      e.preventDefault();
      resetPose('key');
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// What a pet window knows of the cast: every base (persona: credits, touch zones, clips, voice) with her default
// look, and every character (T-2764: one per look) with hers — the hatch screen lists the characters.
const speciesInfo = () => SPECIES_IDS.map((id) => ({ ...SPECIES[id], fallback: undefined, personality: undefined, portrait: service.lookFor(id, 'daily') }));
const charactersInfo = () => service.characterList().map((e) => ({ ...e, nameZh: SPECIES[e.base].nameZh, vendor: SPECIES[e.base].vendor, title: SPECIES[e.base].title, accent: SPECIES[e.base].accent, blurb: SPECIES[e.base].blurb, portrait: service.lookFor(e.id, 'daily') }));

function wire() {
  ipcMain.handle('boot', () => {
    const v = service.init();
    place(v ? 'pet' : 'onboarding');
    if (v) setTimeout(() => service.warmup().catch((e) => logError(e)), 1500);
    return { view: v, update: updater.state, settings: service.getSettings(), species: speciesInfo(), characters: charactersInfo(), foods: FOODS, testMode: TEST_MODE };
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
  ipcMain.handle('hatch', async (_e, { characterId, speciesId, name, localAbilities, space }) => {
    try {
      const { view, localError, localWarning } = await service.hatch({
        characterId: typeof characterId === 'string' ? characterId : undefined,
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
  ipcMain.handle('reset-pose', (_e, p) => resetPose(['button', 'key', 'test'].includes(p && p.source) ? p.source : 'ipc'));
  ipcMain.handle('touch', (_e, target) => service.touch(target));
  ipcMain.handle('talk-topic', (_e, { id }) => service.talkTopic(String(id || '')));
  ipcMain.handle('get-settings', () => service.getSettings());
  // 插个嘴 (core/interject.js, docs/interject.md): the chat box's unsent draft (the renderer sends it only while
  // the feature and that source are on), the owner's reaction to a remark, and the rules / records for the UI
  ipcMain.on('interject-draft', (_e, p) => { service.interjectInput('chatDraft', String((p && p.text) || '').slice(0, 4000)); });
  ipcMain.handle('interject-feedback', (_e, p) => service.interjectFeedback(p && p.id, p && p.kind));
  ipcMain.handle('interject-rules', () => service.interjectRules());
  ipcMain.handle('interject-add-rule', (_e, p) => service.interjectAddRule(p && p.rule));
  ipcMain.handle('interject-delete-rule', (_e, p) => service.interjectDeleteRule(p && p.id));
  ipcMain.handle('interject-set-rule', (_e, p) => service.interjectSetRuleDisabled(p && p.id, !!(p && p.disabled)));
  ipcMain.handle('interject-clear-decisions', () => service.interjectClearDecisions());
  ipcMain.handle('interject-decisions', (_e, p) => service.interjectDecisions(p && p.limit));
  ipcMain.handle('set-interject', (_e, patch) => { const r = service.setSection('interject', patch); syncClipboardWatch(); return r; });
  ipcMain.handle('confirm-age', (_e, { adult }) => service.answerAgeGate(!!adult));
  ipcMain.handle('set-adult', (_e, { on }) => service.setAdultContent(!!on));
  // per-character settings (⋯ → 角色列表 → her page): `species` says whose — a character id (T-2764; an old
  // per-persona id still works); none = the current character
  const whose = (v) => (typeof v === 'string' && v ? v : undefined);
  // 衣柜: the current character's outfit, or (her page in the settings window) another character's she met
  ipcMain.handle('equip-outfit', (_e, { id, species }) => service.equipOutfit(String(id || ''), whose(species)));
  ipcMain.handle('unlock-all', (_e, p) => service.unlockAll(whose(p && p.species)));
  // the model (her page → 模型): only her own vendor's models are offered
  ipcMain.handle('set-model', (_e, { key, species }) => service.setModel(String(key || ''), whose(species)));
  // 个性化设定 (her page → System Role): her own words added to her agent's system role
  ipcMain.handle('set-framing', (_e, { mode, species }) => service.setFraming(String(mode || ''), whose(species)));
  ipcMain.handle('set-system-role', (_e, { text, species }) => service.setSystemRole(String(text || ''), whose(species)));
  ipcMain.handle('refresh-models', async () => {
    await service.refreshModels({ force: true });
    return { ok: true, view: service.view() };
  });
  // pet packs: every pack is a character of its own (T-2764) — importing one adds a character (its id is the
  // pack's), there is no 形象包 to put on any more
  ipcMain.handle('import-pack', async (e) => {
    const r = await dialog.showOpenDialog(windowOf(e) || win, { title: '导入角色包', properties: ['openFile', 'openDirectory'], filters: [{ name: '角色包', extensions: ['zip', 'json'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
    const src = /pack\.json$/i.test(r.filePaths[0]) ? path.dirname(r.filePaths[0]) : r.filePaths[0];
    try {
      const out = await packStore.importFrom(src);
      if (out.ok) service.setPacks(packStore.packs);
      return out;
    } catch (e) {
      logError(e);
      return { ok: false, errors: [e.message] };
    }
  });
  // her own Live2D model (外观 → 导入 Live2D 模型…): a .model3.json or a .zip (and on macOS a folder too —
  // elsewhere a dialog cannot pick both files and folders, and the .model3.json stands for its folder)
  ipcMain.handle('import-live2d', async (_e, { species } = {}) => {
    const parent = windowOf(_e) || win;
    const v = service.view();
    // whose base the new character stands on: the character asked for, else the companion's
    const sp = (whose(species) && service._baseOf(species)) || (v && v.pet.speciesId);
    if (!sp) return { ok: false, errors: ['先请一位角色来'] };
    // a generic VRM companion's base is made when her model loads (core/generic.js): nothing else may stand on it
    if (SPECIES[sp] && SPECIES[sp].virtual) return { ok: false, errors: ['通用设定的 VRM 伙伴不能再导入 Live2D 形象，请到一位模型娘的页面导入'] };
    const props = process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'];
    const r = nextOpenPath ? { filePaths: [nextOpenPath] } : await dialog.showOpenDialog(parent, { title: '导入 Live2D 模型', properties: props, filters: [{ name: 'Live2D 模型（.model3.json / .zip）', extensions: ['json', 'zip'] }] });
    nextOpenPath = null;
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
    try {
      // the service learns the pack at once (it used to only after the pet window saved its picture), so 穿上
      // from the settings window finds it
      const out = await packStore.importLive2d(r.filePaths[0], sp);
      if (out.ok) service.setPacks(packStore.packs);
      return out;
    } catch (e) {
      logError(e);
      return { ok: false, errors: [e.message] };
    }
  });
  // her own VRM model (外观 → 导入 VRM 模型…): a .vrm, a .zip, or (macOS) a folder holding .vrm files; copied
  // into userData/packs only, with its license read from the model (core/vrm.js, core/vrm-import.js)
  ipcMain.handle('import-vrm', async (_e, { species } = {}) => {
    const parent = windowOf(_e) || win;
    const v = service.view();
    // 通用设定 by default (core/generic.js): the model is a companion of her own; 导入确认 can make her a new look
    // of a character instead (set-pack-base). A character id / base passed in keeps the old behaviour.
    const sp = species === GENERIC_BASE || !whose(species) ? GENERIC_BASE : service._baseOf(species) || (v && v.pet.speciesId);
    if (!sp) return { ok: false, errors: ['先请一位角色来'] };
    const props = process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'];
    const r = nextOpenPath ? { filePaths: [nextOpenPath] } : await dialog.showOpenDialog(parent, { title: '导入 VRM 模型', properties: props, filters: [{ name: 'VRM 模型（.vrm / .zip）', extensions: ['vrm', 'zip'] }] });
    nextOpenPath = null;
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'canceled' };
    try {
      const out = await packStore.importVrm(r.filePaths[0], sp);
      if (out.ok) service.setPacks(packStore.packs);
      return out;
    } catch (e) {
      logError(e);
      return { ok: false, errors: [e.message] };
    }
  });
  ipcMain.handle('set-pack-base', (_e, { id, base } = {}) => {
    const r = packStore.setBase(String(id || ''), String(base || ''));
    if (r.ok) service.setPacks(packStore.packs);
    return r;
  });
  // after the renderer drew the imported model (or found it would not load): its picture, then the list
  ipcMain.handle('save-pack-preview', (_e, { id, dataUrl }) => {
    const r = packStore.savePreview(String(id || ''), dataUrl);
    if (r.ok) service.setPacks(packStore.packs);
    return r;
  });
  ipcMain.handle('set-live2d-height', (_e, { id, height }) => {
    const r = packStore.setLive2dHeight(String(id || ''), height);
    if (r.ok) service.setPacks(packStore.packs);
    return r;
  });
  // 下载角色 (core/catalog.js): progress arrives as `catalog-progress`; when she is in, she is a character
  ipcMain.handle('catalog-download', async (_e, { id }) => {
    const r = await catalog.download(String(id || ''));
    if (r.ok) service.setPacks(packStore.packs);
    pushAdmin();
    return r;
  });
  ipcMain.handle('catalog-cancel', (_e, { id }) => catalog.cancel(String(id || '')));
  // a generic companion (core/generic.js) has no other look to fall back on: she is not deleted while she is out
  const removingCurrentGeneric = (id) => { const p = packStore.packs.get(id); return !!(p && p.generic && service.pet && service._cid() === id); };
  const KEEP_CURRENT = { ok: false, reason: 'current-generic', text: '她正在桌面上陪你。先切换到别的角色，再删除她的模型。' };
  ipcMain.handle('catalog-remove', (_e, { id }) => {
    if (removingCurrentGeneric(String(id || ''))) return KEEP_CURRENT;
    const r = packStore.removeDownload(String(id || ''));
    if (r.ok) service.setPacks(packStore.packs);
    pushAdmin();
    return r;
  });
  ipcMain.handle('remove-pack', (_e, { id }) => {
    if (removingCurrentGeneric(String(id || ''))) return KEEP_CURRENT;
    const r = packStore.remove(String(id || ''));
    if (r.ok) service.setPacks(packStore.packs);
    return r;
  });
  ipcMain.on('open-packs-folder', () => shell.openPath(packStore.userDir));
  // 外观 → 导出…: a user pack as a .zip. A VRM pack whose license forbids redistribution is refused here too,
  // whatever the window asks (core/packs.js packShareable).
  ipcMain.handle('export-pack', async (_e, { id } = {}) => {
    const parent = windowOf(_e) || win;
    const pid = String(id || '');
    const ok = packStore.shareable(pid);
    if (!ok.ok) return ok;
    const r = nextSavePath ? { filePath: nextSavePath } : await dialog.showSaveDialog(parent, { title: '导出角色包', defaultPath: `${pid}.zip`, filters: [{ name: '角色包（.zip）', extensions: ['zip'] }] });
    nextSavePath = null;
    if (r.canceled || !r.filePath) return { ok: false, reason: 'canceled' };
    try {
      return await packStore.exportPack(pid, r.filePath);
    } catch (e) {
      logError(e);
      return { ok: false, reason: 'failed', text: e.message };
    }
  });
  // a link from a model's license (授权条款, 参考, 联系方式): web links only, in the system browser
  ipcMain.handle('open-link', (_e, { url } = {}) => {
    const u = String(url || '');
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(u)) return { ok: false };
    if (TEST_MODE) { openedLinks.push(u); return { ok: true, test: true }; }
    shell.openExternal(u);
    return { ok: true };
  });
  // While the user drags the resize handle: resize the window only. On release: save.
  ipcMain.handle('preview-pet-scale', (_e, { scale }) => resizePet(clampScale(scale)));
  ipcMain.handle('set-pet-scale', (_e, { scale }) => service.setPetScale(resizePet(clampScale(scale))));
  // ⋯ → 聊天记录: the filter runs here, in the data layer (PetService.history → chat-log.userSessions);
  // the window only ever receives the conversations the owner started.
  ipcMain.handle('history-list', () => service.history());
  ipcMain.handle('history-get', (_e, { id }) => service.historySession(String(id || '')));
  ipcMain.handle('mark-seen', (_e, { kind, species }) => service.markSeen(String(kind || ''), typeof species === 'string' && species ? species : undefined));
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
  ipcMain.handle('new-topic', () => service.newTopic());
  ipcMain.handle('release', async (_e, opts) => {
    const r = await service.release(opts);
    place('onboarding');
    return r;
  });
  ipcMain.on('move-by', (e, { dx, dy }) => {
    const w = windowOf(e);
    if (!w) return;
    const [x, y] = w.getPosition();
    const nx = screenPx(x + dx);
    const ny = screenPx(y + dy);
    if (nx !== null && ny !== null) w.setPosition(nx, ny);
  });
  // Throwing the pet (src/core/fx.js stepThrow): the renderer runs the physics against the work area of
  // the screen the window is on and moves the window frame by frame.
  ipcMain.handle('cursor-point', () => screen.getCursorScreenPoint());
  // every pet window hears when it is hidden / minimised and shown again (a VRM figure stops drawing meanwhile)
  app.on('browser-window-created', (_e, w) => {
    const tell = (shown) => () => { if (!w.isDestroyed()) w.webContents.send('window-shown', shown); };
    w.on('hide', tell(false));
    w.on('minimize', tell(false));
    w.on('show', tell(true));
    w.on('restore', tell(true));
  });
  ipcMain.handle('work-area', (e) => {
    const w = windowOf(e);
    if (!w) return null;
    const b = w.getBounds();
    return { bounds: b, area: screen.getDisplayMatching(b).workArea };
  });
  ipcMain.on('move-to', (e, { x, y }) => {
    const w = windowOf(e);
    const nx = screenPx(x);
    const ny = screenPx(y);
    if (!w || nx === null || ny === null) return;
    w.setPosition(nx, ny);
  });
  // Pets knocking into each other: each window reports its character box (in the window) and, while
  // flying, its speed; a flying pet asks for the others' boxes and kicks the one it hits.
  ipcMain.on('pose', (e, { hit, vx, vy }) => {
    const p = pets.get(petIdOf(windowOf(e)));
    if (!p) return;
    if (hit && [hit.x, hit.y, hit.w, hit.h].every(Number.isFinite)) p.hit = hit;
    p.vx = Number.isFinite(vx) ? vx : 0;
    p.vy = Number.isFinite(vy) ? vy : 0;
  });
  ipcMain.handle('peers', (e) => {
    const me = petIdOf(windowOf(e));
    const out = [];
    for (const [id, p] of pets) {
      if (id === me || !p.hit || p.win.isDestroyed() || !p.win.isVisible()) continue;
      const b = p.win.getBounds();
      out.push({ id, x: b.x + p.hit.x, y: b.y + p.hit.y, w: p.hit.w, h: p.hit.h, vx: p.vx, vy: p.vy });
    }
    return out;
  });
  ipcMain.on('kick', (_e, { id, vx, vy }) => {
    const p = pets.get(String(id));
    if (p && !p.win.isDestroyed() && Number.isFinite(vx) && Number.isFinite(vy)) p.win.webContents.send('kicked', { vx, vy });
  });
  ipcMain.handle('visitor-boot', (e) => {
    const p = pets.get(petIdOf(windowOf(e)));
    if (!p) return null;
    // her character's own look in her own wardrobe's daily outfit
    return { speciesId: p.speciesId, characterId: p.characterId, name: (service.characterList().find((e) => e.id === p.characterId) || {}).name || SPECIES[p.speciesId].nameZh, species: speciesInfo(), look: service.lookFor(p.characterId, 'daily'), settings: service.getSettings(), testMode: TEST_MODE };
  });
  ipcMain.handle('set-vrm-posture', (_e, { packId, posture } = {}) => service.setVrmPosture(packId, posture));
  ipcMain.handle('vrm-library-info', () => (vrmLibrary ? { dir: vrmLibrary.dir, source: vrmLibrary.source } : null));
  // dancing: list / play / stop / state — from any window (the settings page too), played by the pet window
  ipcMain.handle('dances:list', () => danceList());
  ipcMain.handle('dance:play', (_e, opts) => dancePlay(opts || {}));
  ipcMain.handle('dance:stop', () => danceStop());
  ipcMain.handle('dance:state', () => danceState());
  ipcMain.handle('dance:loop', (_e, { on } = {}) => danceLoop(on));
  ipcMain.handle('dance-import-pick', async (e, { folder } = {}) => {
    if (danceImport.importing()) return DancesLib.importError('busy');
    const paths = await pickPaths(e, folder
      ? { title: '选择舞蹈文件夹', properties: ['openDirectory'] }
      : { title: '选择舞蹈文件（.vmd，可同时选上音乐和封面）', properties: process.platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'], filters: [{ name: '舞蹈（.vmd、音乐、封面、readme）', extensions: ['vmd', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'jpg', 'jpeg', 'png', 'webp', 'txt', 'json', 'ncm'] }] });
    if (!paths.length) return { ok: false, reason: 'canceled' };
    try { return danceImport.inspect(paths); } catch (err) { logError(err); return DancesLib.importError('bad-vmd'); }
  });
  ipcMain.handle('dance-import-extra', async (e, { token, kind } = {}) => {
    const audio = kind === 'audio';
    const paths = await pickPaths(e, { title: audio ? '选择舞蹈音乐' : '选择舞蹈封面', properties: ['openFile'], filters: [audio ? { name: '音乐（mp3 / wav / ogg / m4a / flac）', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'ncm'] } : { name: '图片（jpg / png / webp）', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
    if (!paths.length) return { ok: false, reason: 'canceled' };
    return danceImport.addExtra(String(token || ''), audio ? 'audio' : 'cover', paths[0]);
  });
  ipcMain.handle('dance-import-commit', async (_e, opts = {}) => {
    try { return await danceImport.commit(opts, danceDirNow()); } catch (err) { logError(err); return DancesLib.importError('write-failed'); }
  });
  ipcMain.handle('dance-import-cancel', () => danceImport.cancel());
  // 商店 → 舞蹈 (core/catalog.js loadDanceIndex): the store's dances, each 已下载 or not; download / cancel
  ipcMain.handle('dance-store', () => {
    const have = danceImport.installedIds(danceDirNow());
    return { dances: Catalog.listDances((id) => have.has(id)), downloads: danceStore ? danceStore.state() : [], vrm: !DancesLib.cannotDance((service.view() || {}).look) };
  });
  ipcMain.handle('dance-download', (_e, { id } = {}) => danceStore.download(String(id || '')));
  ipcMain.handle('dance-download-cancel', (_e, { id } = {}) => danceStore.cancel(String(id || '')));
  // 删除舞蹈: the one she is dancing stops first (at once), then its folder and its entry go
  ipcMain.handle('dance-remove', async (_e, { id } = {}) => {
    const st = await danceState().catch(() => null);
    if (st && st.id === id) await askRenderer('dance-stop', { immediate: true });
    return danceImport.remove(danceDirNow(), String(id || ''));
  });
  ipcMain.handle('set-prefs', (_e, patch) => {
    const r = service.setPrefs(patch);
    if (!IVoice.voiceOn(service.settings.prefs)) tts.engine.stopAll(); // 朗读 off or 静音: nothing more goes to an engine
    return r;
  });
  // 语音: synthesise one line with the chosen engine for the current character; the renderer plays it
  // (or falls back to the system voice). A new line aborts the one still being fetched.
  ipcMain.handle('tts-synthesize', async (_e, { text, mood }) => {
    const sp = service.pet ? SPECIES[service.pet.speciesId] : null;
    if (!sp) return { ok: false, reason: 'no-pet', fallback: service.settings.tts.fallback, fellBackFrom: [] };
    if (!IVoice.voiceOn(service.settings.prefs)) return { ok: false, reason: 'off', fallback: 'silent', fellBackFrom: [] };
    const vp = voicePackOf(sp);
    const hit = recordedLine(sp, text, false, vp);
    if (hit) { tts.engine.cancel(); tts.engine.stats.packHits = (tts.engine.stats.packHits || 0) + 1; return { ok: true, ...hit, cached: true, fellBackFrom: [], fallback: service.settings.tts.fallback, latencyMs: 0 }; }
    // her engine voice: her own, or the voice of the 语音包 she resolved to (a generic pack for a model without one)
    const r = await tts.engine.synthesize({ text: String(text || ''), species: vp.voiced, mood: typeof mood === 'string' ? mood : '' }, service.settings.tts);
    if (r.fellBackFrom.length) service.emit('settings', service.settingsView()); // the 语音 section shows the last error
    return r;
  });
  ipcMain.on('tts-cancel', () => tts.engine.cancel());
  // 语音包: her recorded line for this text, when packs are on and the engine that would read it is the
  // one the pack was recorded with (or none can): played from disk, no request (core/voice-pack.js).
  // The pack is the one she resolves to (core/voice-pack.js resolvePack): the owner's pick for her >
  // 我的语音包 (settings.tts.voicePack) > her own (专属) > the generic pack of her gender (core/voice-gender.js).
  function recordedLine(sp, text, probe = false, vp = voicePackOf(sp)) {
    const pack = vp.pack;
    if (!packApplies(service.settings.tts, pack, tts.engine.firstUsable(vp.voiced, service.settings.tts))) return null;
    if (probe) return pack.lines.has(packNorm(text));
    return tts.packs.lookupIn(pack, text);
  }
  // The pack she is (a generic VRM companion) or her default one: where her gender is read when her file has none.
  function genderPackOf(sp) {
    const id = (sp && sp.generic && sp.generic.pack) || (sp && sp.defaultPack);
    return (id && packStore && packStore.packs.get(id)) || null;
  }
  // { pack, source, choice, missing, gender, genderSource, voiced }: which 语音包 character `sp` uses now and the
  // species her engine lines are read for (voiced: her own voice, or the pack's — core/voice-pack.js voiceForPack).
  function voicePackOf(sp) {
    const g = VoiceGender.genderOf(sp, genderPackOf(sp));
    const picks = (service.settings.tts && service.settings.tts.voicePackByCharacter) || {};
    const mine = (service.settings.tts && service.settings.tts.voicePack) || PACK_AUTO; // 我的语音包
    const r = resolvePack({ characterId: sp.id, gender: g.gender, choice: Object.hasOwn(picks, sp.id) ? picks[sp.id] : PACK_AUTO, userChoice: mine }, tts.packs);
    return { ...r, gender: g.gender, genderSource: g.source, voiced: voiceForPack(sp, r) };
  }
  const engineVoiceOf = (voiced, t, fromPack) => { const e = defaultEngine(voiced); const c = t[e] || {}; return { engine: e, voiceId: c.voiceId || c.referenceId || null, fromPack }; };
  // What the console / pet window shows for one character: plain data, no audio.
  function voicePackState(sp) {
    const vp = voicePackOf(sp);
    const p = vp.pack;
    const voiceTts = vp.voiced && vp.voiced.voice ? vp.voiced.voice.tts || null : null;
    return {
      characterId: sp.id,
      choice: vp.choice,
      missing: vp.missing,
      userChoice: vp.userChoice,
      userMissing: vp.userMissing,
      source: vp.source,
      gender: vp.gender,
      genderSource: vp.genderSource,
      pack: p ? { id: p.id, name: p.name, kind: p.kind, gender: p.gender || null, character: p.character || null, engine: p.engine || null, voiceId: p.voiceId || null, lines: p.lines.size } : null,
      engineVoice: voiceTts ? engineVoiceOf(vp.voiced, voiceTts, vp.voiced !== sp) : null,
      options: [{ id: PACK_AUTO, name: '自动' }, ...tts.packs.list().map((x) => ({ id: x.id, name: x.name, kind: x.kind, gender: x.gender, character: x.character }))],
    };
  }
  const speciesForId = (id) => (typeof id === 'string' && (Object.hasOwn(SPECIES, id) || isGenericBase(id)) ? getSpecies(id) : null);
  // the console's roster rows (adminState) show the pack she really uses, not just her own one
  voicePackStateOf = (id) => {
    const sp = speciesForId(id);
    return sp ? voicePackState(sp) : null;
  };
  // 按角色切换语音包: { characterId, packId: <pack id> | 'auto' }. Saved in settings.tts.voicePackByCharacter
  // and in force for her next line: the running prewarm (for the old pack's voice) stops, the line being
  // fetched is dropped, and the pet window prewarms again with the new pack (its signature includes the picks).
  ipcMain.handle('set-voice-pack', (_e, payload) => {
    const { characterId, packId } = payload && typeof payload === 'object' ? payload : {};
    const sp = speciesForId(characterId);
    if (!sp) return { ok: false, reason: 'unknown-character' };
    const pick = packId === null || packId === undefined || packId === '' ? PACK_AUTO : packId;
    if (pick !== PACK_AUTO && !tts.packs.get(pick)) return { ok: false, reason: 'unknown-pack', state: voicePackState(sp) };
    tts.engine.endPrewarm();
    tts.engine.cancel();
    const r = service.setTts({ voicePackByCharacter: { [sp.id]: pick } });
    return { ok: r.ok !== false, state: voicePackState(sp), settings: r.settings };
  });
  // 我的语音包 (用户语音包): { packId: <pack id> | 'auto' }. Saved in settings.tts.voicePack; every character without
  // a pick of her own uses it from her next line (a 通用语音包 — generic-male / generic-female — or any loaded pack).
  // -> { ok, choice, state (the current character's), settings } | { ok: false, reason: 'unknown-pack' }
  ipcMain.handle('set-user-voice-pack', (_e, payload) => {
    const { packId } = payload && typeof payload === 'object' ? payload : {};
    const pick = packId === null || packId === undefined || packId === '' ? PACK_AUTO : packId;
    if (pick !== PACK_AUTO && !tts.packs.get(pick)) return { ok: false, reason: 'unknown-pack' };
    tts.engine.endPrewarm();
    tts.engine.cancel();
    const r = service.setTts({ voicePack: pick });
    const sp = service.pet ? speciesForId(service.pet.speciesId) : null;
    return { ok: r.ok !== false, choice: r.settings.tts.voicePack, state: sp ? voicePackState(sp) : null, settings: r.settings };
  });
  ipcMain.handle('voice-pack-state', (_e, payload) => {
    const id = payload && typeof payload === 'object' && payload.characterId ? payload.characterId : service.pet && service.pet.speciesId;
    const sp = speciesForId(id);
    return sp ? { ok: true, state: voicePackState(sp) } : { ok: false, reason: 'unknown-character' };
  });
  // 互动语音: synthesise her common short lines ahead (pet-service.js voiceLines) so they play at once.
  // Only with 朗读 and 互动语音 on; a newer call (another character, a new key) replaces a running one.
  ipcMain.handle('tts-prewarm', async () => {
    const p = service.settings.prefs;
    if (!service.pet || !IVoice.voiceOn(p) || p.voiceInteractions === false) return { skipped: 'off' };
    const sp = SPECIES[service.pet.speciesId];
    const all = service.voiceLines();
    const vp = voicePackOf(sp);
    const lines = all.filter((l) => !recordedLine(sp, l.text, true, vp)); // the 语音包 already has these
    const r = await tts.engine.prewarm(lines, vp.voiced, service.settings.tts);
    return { ...r, lines: all.length, recorded: all.length - lines.length };
  });
  ipcMain.handle('set-tts', (_e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    let keyOk = true;
    if (p.key && NEURAL.includes(p.key.id)) keyOk = tts.keys.set(p.key.id, p.key.value);
    tts.engine.endPrewarm(); // the running prewarm was for the old engine / key: nothing more goes to it
    tts.engine.reset(); // a new key, endpoint or engine: try every engine again
    const r = service.setTts(p);
    return keyOk ? r : { ...r, ok: false, reason: 'bad-key' };
  });
  ipcMain.handle('tts-clear-cache', () => { tts.cache.clear(); return service.getSettings(); });
  // 语音包: the owner's own packs go in userData/voicepacks/<id>/ (core/voice-pack.js); read again on request
  ipcMain.on('open-voicepacks-folder', () => { const d = tts.packs.dirs[1]; fs.mkdirSync(d, { recursive: true }); shell.openPath(d); });
  ipcMain.handle('voicepacks-reload', () => { tts.packs.reload(); return { settings: service.getSettings(), errors: tts.packs.errors.map((e) => `${path.basename(e.dir)}：${e.errors.join('；')}`) }; });
  // 语音输入 (core/asr.js). The bytes are checked here before anything is written or sent anywhere.
  ipcMain.handle('asr-transcribe', (_e, p) => {
    const { bytes, mime, ms } = p && typeof p === 'object' ? p : {};
    const size = bytes && typeof bytes.byteLength === 'number' ? bytes.byteLength : 0;
    if (!size || size > ASR_MAX_BYTES || typeof mime !== 'string' || !/^audio\//i.test(mime)) return { ok: false, reason: 'bad-audio', message: 'not an audio clip', provider: null, tried: [] };
    return service.asrTranscribe(bytes, mime, { ms: Number(ms) || null });
  });
  ipcMain.on('asr-cancel', () => service.asrCancel());
  // 🎤 before the first recording: macOS asks the owner once (Info.plist NSMicrophoneUsageDescription);
  // elsewhere the OS has no per-app prompt and getUserMedia reports a refusal itself.
  ipcMain.handle('asr-mic-access', async () => {
    if (TEST_MODE && micAccessOverride) return micAccessOverride; // e2e: what the OS would answer (debug-mic-access)
    if (process.platform !== 'darwin' || !systemPreferences.getMediaAccessStatus) return 'granted';
    const st = systemPreferences.getMediaAccessStatus('microphone');
    if (st === 'not-determined') return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
    return st; // granted | denied | restricted
  });
  ipcMain.handle('asr-test', (_e, p) => service.asrTest({ provider: p && p.provider }));
  ipcMain.handle('set-asr', (_e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    let keyOk = true;
    if (p.key !== undefined) keyOk = tts.keys.set(ASR_KEY_ID, typeof p.key === 'string' ? p.key : ''); // '' removes it
    const r = service.setAsr(p);
    return keyOk ? r : { ...r, ok: false, reason: 'bad-key' };
  });
  ipcMain.handle('set-visitors', (_e, { ids }) => service.setVisitors(ids));
  ipcMain.handle('set-api', async (_e, opts) => {
    const r = service.setApi(opts || {});
    await applyApi();
    return { ...r, status: apiServer.status() };
  });
  ipcMain.handle('api-status', () => apiServer.status());
  ipcMain.on('api-reply', (_e, { id, result }) => {
    const done = apiWaits.get(id);
    if (done) { apiWaits.delete(id); done(result); }
  });
  ipcMain.handle('switch-character', (_e, { id, name }) => service.switchCharacter(String(id || ''), { name: typeof name === 'string' ? name : '' }));
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
  // 她的面板: the pet window opens / closes it and keeps it up to date; the panel presses buttons and sizes itself
  const fromPet = (e) => windowOf(e) === win && !!petPanel;
  ipcMain.handle('pet-panel:open', (e, p = {}) => (fromPet(e) ? petPanel.open(p) : { ok: false, visible: false }));
  ipcMain.handle('pet-panel:toggle', (e, p = {}) => (fromPet(e) ? petPanel.toggle(p) : { ok: false, visible: false }));
  ipcMain.on('pet-panel:close', (e, { reason } = {}) => { if (fromPet(e)) petPanel.close(String(reason || 'pet')); });
  ipcMain.on('pet-panel:update', (e, payload) => { if (fromPet(e)) petPanel.update(payload); });
  ipcMain.on('pet-panel:act', (e, m) => { if (petPanel && petPanel.isSender(e)) petPanel.act(m); });
  ipcMain.on('pet-panel:size', (e, s) => { if (petPanel && petPanel.isSender(e)) petPanel.resize(s); });
  ipcMain.on('pet-panel:close-self', (e, { reason } = {}) => { if (petPanel && petPanel.isSender(e)) petPanel.close(String(reason || 'esc')); });
  // 配置后台: the pet window's ⚙ / right click / unlock toast open it (at a section); single instance
  ipcMain.handle('open-admin', (_e, { section } = {}) => openAdmin(section));
  // the settings window's own channels answer that window only (docs §5.2)
  const adminOnly = (fn) => (e, p) => (admin.isSender(e) || TEST_MODE ? fn(p || {}) : { ok: false, reason: 'forbidden' });
  ipcMain.handle('admin-boot', adminOnly(() => ({ schema: settingsSchema.describe(), ...bootState(), version: app.getVersion(), platform: (TEST_MODE && process.env.PIXELPET_E2E_PLATFORM) || process.platform, testMode: TEST_MODE, dataDir: app.getPath('userData') })));
  // the owner's LobeHub avatar for the console's chat (core/user-avatar.js): a data: URL, cached in userData.
  // Every visit to 聊天 asks; one `lh whoami` answers them for 10 minutes (30 s while there is none: a login shows soon)
  let faceMemo = null;
  ipcMain.handle('user-avatar', adminOnly(() => {
    if (faceMemo && Date.now() < faceMemo.until) return faceMemo.p;
    const p = userAvatar({ whoami: () => service.lh.whoami(), server: serverUrl(), cacheFile: path.join(app.getPath('userData'), 'user-avatar.json') });
    faceMemo = { p, until: Date.now() + 30000 };
    p.then((r) => { if (faceMemo && faceMemo.p === p) faceMemo.until = Date.now() + (r && r.avatar ? 600000 : 30000); }, () => { faceMemo = null; });
    return p;
  }));
  ipcMain.handle('admin-state', adminOnly(() => adminState()));
  ipcMain.handle('admin-set', adminOnly(({ key, value }) => adminSettings.set(key, value)));
  ipcMain.handle('admin-reset', adminOnly(({ keys }) => adminSettings.reset(keys)));
  ipcMain.handle('admin-relaunch', adminOnly(() => {
    if (TEST_MODE) return { ok: true, test: true };
    app.relaunch();
    app.exit(0);
    return { ok: true };
  }));
  ipcMain.on('admin-show-pet', () => showPet());
  // 桌宠行为 → 找回桌宠: the same as ⋯ → 回到右下角 (and the tray's 显示桌宠): shown, back in the bottom-right corner
  ipcMain.handle('admin-place-pet', adminOnly(() => {
    if (!win || win.isDestroyed()) return { ok: false, reason: 'no-pet' };
    showPet();
    if (service && service.pet) { petBounds = null; place('pet'); }
    return { ok: true, bounds: win.getBounds() };
  }));
  // 数据与关于 → 数据目录: where settings.json, pet.json, the packs and the log live
  ipcMain.handle('open-data-folder', adminOnly(() => {
    if (TEST_MODE) return { ok: true, test: true, path: app.getPath('userData') };
    shell.openPath(app.getPath('userData'));
    return { ok: true, path: app.getPath('userData') };
  }));
  // 和她互动 in the settings window: the pet on the desktop answers with the same action (/anim's whitelist)
  ipcMain.handle('admin-cue', adminOnly(({ state }) => (ADMIN_CUES.includes(state) ? askRenderer('anim', { state }) : { ok: false, reason: 'bad-state' })));
  // the old ⋯ menu, now in the settings window (T-2718): 回到右下角 (the pet window stops flying / walking
  // and goes back to its corner) and 退出 (asked once more in the window first)
  ipcMain.handle('admin-home', adminOnly(async () => {
    if (!win || win.isDestroyed()) return { ok: false, reason: 'no-window' };
    if (!service || !service.pet) return { ok: false, reason: 'empty' };
    const r = await askRenderer('home', {});
    if (r.ok === false) return r;
    petBounds = null;
    place('pet');
    return { ok: true, bounds: win.getBounds() };
  }));
  ipcMain.handle('admin-quit', adminOnly(() => {
    setImmediate(() => app.quit());
    return { ok: true };
  }));
  // 设置窗口 → 聊天 (docs/admin-chat.md): one conversation per character, through her own agent and topic, kept
  // in her 聊天记录 (PetService#chatAs). Replies stream to the settings window as `admin-chat-delta`, the end
  // of a round as `admin-chat-done`; `admin-chat-changed` says her history moved (a round here or on the desktop).
  const chatView = (speciesId) => (m) => chatMessageView(m, chatImages, speciesId);
  ipcMain.handle('admin-chat-characters', adminOnly(() => service.chatCharacters()));
  ipcMain.handle('admin-chat-history', adminOnly(({ speciesId, before, limit }) => {
    const r = service.chatHistory(String(speciesId || ''), { before: before ? String(before) : null, limit });
    return r.ok ? { ...r, messages: r.messages.map(chatView(r.speciesId)) } : r;
  }));
  ipcMain.handle('admin-chat-abort', adminOnly(({ speciesId }) => service.chatAbort(speciesId ? String(speciesId) : undefined)));
  ipcMain.handle('admin-chat-send', adminOnly(async ({ speciesId, text, images }) => {
    const id = String(speciesId || '');
    const list = Array.isArray(images) ? images : [];
    if (list.length > CHAT_MAX_IMAGES) return { ok: false, reason: 'too-many-images', error: `一次最多发送 ${CHAT_MAX_IMAGES} 张图片` };
    const read = list.map((x) => readChatImage(x));
    const bad = read.find((r) => !r.ok);
    if (bad) return { ok: false, reason: bad.reason, error: bad.message };
    let saved = [];
    try {
      saved = read.length ? chatImages.save(id, read) : [];
    } catch (e) {
      return { ok: false, reason: 'error', error: `图片没有保存下来：${e.message}` };
    }
    const r = await service.chatAs(id, { text, images: saved }, { onDelta: (d) => admin.send('admin-chat-delta', d) });
    if (!r.userMessage) for (const x of saved) fs.rmSync(x.path, { force: true }); // refused before it was kept
    const view = chatView(r.speciesId || id);
    const out = { ...r, userMessage: r.userMessage ? view(r.userMessage) : undefined, message: r.message ? view(r.message) : undefined };
    if (out.message) admin.send('admin-chat-done', { speciesId: out.speciesId, turnId: out.turnId, ok: out.ok, reason: out.ok ? undefined : out.reason, error: out.error, message: out.message });
    if (!r.ok && r.reason === 'error') logError(new Error(`admin chat: ${r.code || ''} ${r.error}`));
    return out;
  }));
  // 选择图片: a file dialog in main; each picked file comes back checked (type, ≤10 MB) with a preview data URL
  ipcMain.handle('admin-chat-pick-images', adminOnly(async () => {
    const r = nextOpenPath ? { filePaths: nextOpenPath.split('|') } : await dialog.showOpenDialog(admin.win || win, { title: '选择图片', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
    nextOpenPath = null;
    if (r.canceled || !r.filePaths.length) return { ok: false, reason: 'canceled', images: [] };
    const images = [];
    const rejected = [];
    for (const f of r.filePaths.slice(0, CHAT_MAX_IMAGES)) {
      const img = readChatImage({ path: f });
      if (img.ok) images.push({ path: f, name: img.name, mime: img.mime, size: img.buffer.length, dataUrl: `data:${img.mime};base64,${img.buffer.toString('base64')}` });
      else rejected.push({ name: path.basename(f), reason: img.reason, message: img.message });
    }
    return { ok: true, images, rejected };
  }));
  ipcMain.handle('update-install', () => updater.install());
  ipcMain.handle('update-check', () => updater.checkNow());

  if (TEST_MODE) {
    // Test-only hooks used by the E2E suite to drive time-dependent behaviour.
    ipcMain.handle('debug-set', (_e, patch) => service.debugSet(patch));
    // 测速 (e2e/chat-latency.js): the list of models counts as expired, as after MODELS_TTL_MS
    ipcMain.handle('debug-expire-models', () => { service._catalogAt = 0; return true; });
    ipcMain.handle('debug-import-pack', async (_e, dir) => {
      const r = await packStore.importFrom(String(dir));
      if (r.ok) service.setPacks(packStore.packs);
      return r;
    });
    // the next 导入 Live2D 模型… picks this path instead of opening the file dialog
    ipcMain.handle('debug-next-open', (_e, p) => { nextOpenPath = String(p || '') || null; return true; });
    ipcMain.handle('debug-next-save', (_e, p) => { nextSavePath = String(p || '') || null; return true; });
    ipcMain.handle('debug-opened-links', () => openedLinks.slice());
    // the tray (PIXELPET_TRAY=1 in tests): its menu items, and a click on one of them as the user would
    ipcMain.handle('debug-tray', () => ({ created: !!tray, items: trayMenu ? trayMenu.items.map((i) => i.label).filter(Boolean) : [] }));
    ipcMain.handle('debug-tray-click', (_e, { label } = {}) => {
      const item = trayMenu && trayMenu.items.find((i) => i.label === label);
      if (!item) return false;
      item.click();
      return true;
    });
    // e2e: the real tray menu popped up as a native menu at (x, y) of the pet window (a test display has no tray
    // area to click), so a screenshot of the display shows it; closed again by debug-tray-popup { close: true }
    ipcMain.handle('debug-tray-popup', (_e, { x = 10, y = 10, close = false } = {}) => {
      if (!trayMenu || !win || win.isDestroyed()) return false;
      if (close) { trayMenu.closePopup(win); return true; }
      trayMenu.popup({ window: win, x, y });
      return true;
    });
    ipcMain.handle('debug-admin', () => ({ alive: !!(admin && admin.alive), opened: admin ? admin.opened : 0, windows: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length }));
    // 插个嘴: judge what is waiting now instead of after the debounce, and feed any listed source
    ipcMain.handle('debug-interject-flush', async () => service.interjector.flush());
    // e2e: forget the last remark's time (the cooldown and the hourly cap), so a run needs no 10-minute wait
    ipcMain.handle('debug-interject-reset-cooldown', () => { service.interjector.lastInterject = null; service.interjector.interjectStamps = []; return true; });
    ipcMain.handle('debug-interject-input', (_e, p) => service.interjectInput(p && p.source, p && p.text));
    // 快捷键唤起语音对话: press it as the OS would (the registered handler), read its state, hide the pet first
    ipcMain.handle('debug-voice-hotkey', () => { voiceHotkey.trigger('test'); return voiceHotkey.status(); });
    ipcMain.handle('debug-voice-hotkey-status', () => ({ ...voiceHotkey.status(), registered: voiceHotkey.current ? globalShortcut.isRegistered(voiceHotkey.current) : false, petVisible: !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()), petFocused: !!(win && !win.isDestroyed() && win.isFocused()) }));
    ipcMain.handle('debug-mic-access', (_e, v) => { micAccessOverride = typeof v === 'string' && v ? v : null; return micAccessOverride; });
    // 检查更新…: run it as the menu does, read the dialogs it showed, queue the button the next one answers with
    ipcMain.handle('debug-update-check', async (_e, { source } = {}) => { const st = await checkUpdatesWithDialog(source || 'app-menu'); return { state: st, dialogs: updateDialogs.slice() }; });
    ipcMain.handle('debug-update-dialogs', () => updateDialogs.slice());
    ipcMain.handle('debug-update-answer', (_e, id) => { updateAnswers.push(String(id)); return updateAnswers.slice(); });
    ipcMain.handle('debug-update-state', (_e, patch = {}) => { updater._set(patch); return updater.state; });
    ipcMain.handle('debug-pet-panel', () => petPanel.debugState());
    ipcMain.handle('debug-hide-pet', (_e, { minimize } = {}) => { if (minimize) win.minimize(); else win.hide(); return { visible: win.isVisible(), minimized: win.isMinimized() }; });
    ipcMain.handle('debug-heartbeat', async () => {
      await service.heartbeat();
      return service.view();
    });
  }

  // 通用设定: a downloaded / imported generic VRM adds a base of her own; the pet window gets the new list
  let speciesSig = SPECIES_IDS.join(',');
  service.on('update', (v) => {
    const sig = SPECIES_IDS.join(',');
    send('update', sig === speciesSig || !v ? v : { ...v, speciesList: speciesInfo() });
    speciesSig = sig;
    pushAdmin();
  });
  service.on('say', (m) => send('say', m));
  service.on('thinking', (b) => send('thinking', b));
  // 流式回复: the reply as it is written, then the end of that stream (pet-service _openStream; ids per turn)
  service.on('chat-delta', (d) => send('chat-delta', d));
  service.on('chat-done', (d) => { send('chat-done', d); admin.send('admin-chat-changed', { speciesId: service.pet ? service.pet.speciesId : null }); });
  service.on('chat-log', (d) => admin.send('admin-chat-changed', d));
  service.on('affection', (a) => send('affection', a));
  // 插个嘴: what was judged and what she said (the record without the owner's text beyond its short summary)
  // — to the pet window (the 别插嘴 / 说得好 buttons under a remark) and the settings window (规则 and 判断记录)
  service.on('interject', (e) => {
    const m = { type: e.type, decision: e.decision || null, rule: e.rule || null, decisionId: e.decisionId || null };
    send('interject', m);
    if (admin && admin.alive) admin.send('interject', m);
  });
  // a new shortcut is registered before anyone is told, so the status that goes out is the new one
  service.on('settings', (st) => { broadcast('settings', applyHotkey() ? service.settingsView() : st); syncVisitors(); pushAdmin(); syncClipboardWatch(); });
  // the companion appeared, changed or left: visitors follow (none without a companion)
  service.on('update', () => setImmediate(syncVisitors));
  service.on('error', logError);
  updater.on('status', (st) => { send('update-status', st); if (admin) admin.send('update-status', st); });
  ipcMain.on('open-log', () => { try { fs.appendFileSync(logFile(), ''); shell.showItemInFolder(logFile()); } catch { /* ignore */ } });
}

// 插个嘴 source 'clipboard' (system level): only while 插个嘴 AND its own clipboard switch are on (both off by
// default). Polls the clipboard's plain text every few seconds; what was there when watching started is not judged.
// Nothing else system-wide is read (no keyboard hook, no window titles, no screen).
const CLIPBOARD_POLL_MS = 3000;
let clipboardWatch = null;
function syncClipboardWatch() {
  const ij = service && service.settings.interject;
  const want = !!(ij && ij.enabled && ij.sources.clipboard);
  if (!want) {
    if (clipboardWatch) clearInterval(clipboardWatch.timer);
    clipboardWatch = null;
    return;
  }
  if (clipboardWatch) return;
  const w = { last: clipboard.readText() };
  w.timer = setInterval(() => {
    let text = '';
    try { text = clipboard.readText(); } catch { return; }
    if (text === w.last) return;
    w.last = text;
    if (text.trim()) service.interjectInput('clipboard', text.slice(0, 4000));
  }, CLIPBOARD_POLL_MS);
  if (w.timer.unref) w.timer.unref();
  clipboardWatch = w;
}

app.whenReady().then(() => {
  const store = new Store(app.getPath('userData'));
  packStore = new PackStore();
  packStore.serve();
  catalog = new CatalogDownloader({ packStore, settings: () => service.getSettings(), emit: (ch, p) => broadcast(ch, p) });
  danceStore = new CatalogDownloader({
    packStore, settings: () => service.getSettings(), emit: (ch, p) => broadcast(ch, p),
    lookup: (id) => Catalog.danceEntry(id),
    isInstalled: (e) => danceImport.installedIds(danceDirNow()).has(e.id),
    install: (e, zipFile) => danceImport.installStore(danceDirNow(), e, zipFile),
    texts: { unknown: '商店里没有这支舞', installed: '这支舞已经下载好了', invalid: '下载的舞蹈文件有问题，已丢弃' },
  });
  vrmLibrary = serveVrmLibrary({ protocol, net, app });
  for (const p of packStore.problems) logError(new Error(`pet pack ${p.dir} skipped: ${p.errors.join('; ')}`));
  // macOS: no keychain (ad-hoc signing loses "Always Allow" on every update → password prompt); keys are a
  // 0600 file, and ones older versions encrypted are read once and rewritten. See core/tts-keys.js.
  const keys = process.platform === 'darwin'
    ? new TtsKeyStore(app.getPath('userData'), null, { legacyDecrypt: (b) => safeStorage.decryptString(b) })
    : new TtsKeyStore(app.getPath('userData'), { available: () => safeStorage.isEncryptionAvailable(), encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) });
  const cache = new TtsCache(path.join(app.getPath('userData'), 'tts-cache'));
  const packs = new VoicePacks([path.join(__dirname, '..', 'voicepacks'), path.join(app.getPath('userData'), 'voicepacks')], { log: logError });
  tts = { keys, cache, packs, engine: new TtsEngine({ keys, cache, log: logError }) };
  const ttsStatus = () => ({ engines: tts.engine.status(service && service.settings.tts), encrypted: keys.encrypted(), cache: { count: cache.count(), bytes: cache.size() }, stats: { ...tts.engine.stats }, packs: packs.list() });
  const lh = new LhClient({ lhCache: fileCache(path.join(app.getPath('userData'), 'lh-path.json')) });
  // 语音输入: LobeHub through lh, or the owner's own server; logs say which provider, how long and how many bytes — never the audio or the text
  const asr = new AsrEngine({ lh, keys, tmpDir: path.join(app.getPath('temp'), 'pixel-pet-asr'), log: (r) => { if (!r.ok) logError(new Error(`asr ${r.asr} failed: ${r.reason} (${r.ms}ms, ${r.bytes} bytes)`)); } });
  // E2E runs use a fake lh; the real CLI login on the machine must not be used for them
  const responses = TEST_MODE && process.env.PIXELPET_DIRECT !== '1' ? null : new ResponsesClient({ lh });
  voiceHotkey = new VoiceHotkey({ shortcuts: globalShortcut, onTrigger: onVoiceHotkey, log: logError });
  // 对话测速埋点 (core/latency.js, docs/admin-chat-latency.md): off unless PIXELPET_LATENCY=1
  if (process.env.PIXELPET_LATENCY === '1' && !process.env.PIXELPET_LATENCY_FILE) process.env.PIXELPET_LATENCY_FILE = path.join(app.getPath('userData'), 'latency.jsonl');
  service = new PetService({ lh, responses, store, interjectStore: new InterjectStore(app.getPath('userData')), log: new ChatLog(app.getPath('userData')), settingsStore: new SettingsStore(app.getPath('userData')), packs: packStore.packs, ttsStatus, asr, hotkeyStatus: () => voiceHotkey.status() });
  updater = new Updater({ isBusy: () => service.busy, log: logError, autoCheck: () => !!(service && service.settings.update && service.settings.update.autoCheck) });
  apiServer = new ApiServer({
    token: () => service.settings.api.token,
    state: async () => {
      const r = await askRenderer('state');
      const v = service.view();
      return { pet: v ? { name: v.pet.name, species: v.pet.speciesId, affection: v.pet.affection, hunger: v.pet.hunger, mood: v.pet.mood, energy: v.pet.energy, sleeping: v.pet.sleeping, busy: v.busy } : null, fx: r && r.ok ? r.fx : null, bubble: r && r.ok ? r.bubble : null, dance: r && r.ok ? r.dance || null : null };
    },
    dances: async () => danceList(),
    dance: (opts) => dancePlay(opts),
    danceStop: () => danceStop(),
    resetPose: () => resetPose('api'),
    say: async (text) => service.sayExternal(text),
    anim: (state, facing) => askRenderer('anim', { state, facing }),
    throw: (v) => askRenderer('throw', v, 20000),
    chat: (text) => service.chat(text, [], [], { origin: 'api' }), // an outside script, not the owner: not in 聊天记录
    observe: (text) => service.interjectInput('api', text), // 插个嘴 source 'api': she may or may not remark on it
  }, logError);
  // 语音输入: the microphone only for our own page, audio only, and only while 语音输入 is on
  // (core/asr.js mediaAllowed). Other permissions keep Electron's default.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const a = mediaAllowed({ permission, url: (details && details.requestingUrl) || wc.getURL(), mediaTypes: details && details.mediaTypes, settings: service.settings.asr });
    cb(a === null ? true : a);
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    const a = mediaAllowed({ permission, url: (wc && wc.getURL()) || origin, mediaTypes: [details && details.mediaType === 'video' ? 'video' : 'audio'], settings: service.settings.asr });
    return a === null ? true : a;
  });
  admin = new AdminWindow({ testMode: TEST_MODE });
  chatImages = new ChatImages(path.join(app.getPath('userData'), 'admin-chat', 'images'));
  adminSettings = createAdminSettings({
    service,
    hooks: {
      resizePet: (k) => resizePet(clampScale(k)),
      afterPrefs: (prefs) => { if (!IVoice.voiceOn(prefs)) tts.engine.stopAll(); },
      beforeTts: () => { tts.engine.endPrewarm(); tts.engine.reset(); },
      afterApi: () => applyApi(),
      setKey: (id, value) => tts.keys.set(id, value),
      probeHotkey: (acc) => voiceHotkey.probe(acc),
    },
  });
  wire();
  // 她的面板: a button pressed in it is done by her window (app.js runAct); ♪ opens the dance menu there and 聊天
  // the chat box, so her window gets the keyboard
  petPanel = new PetPanel({
    onAct: (m) => { if ((m.act === 'dance' || m.act === 'chat') && win && !win.isDestroyed()) win.focus(); send('panel-act', m); },
    onClosed: (m) => send('panel-closed', m),
    log: logError,
    testMode: TEST_MODE,
  });
  createWindow();
  createTray();
  createAppMenu();
  pets.set('main', { win, speciesId: null, hit: null, vx: 0, vy: 0 });
  // E2E only: combinations "another app" already holds (registered here first, so ours really gets false)
  if (TEST_MODE && process.env.PIXELPET_E2E_TAKEN_HOTKEYS) for (const a of process.env.PIXELPET_E2E_TAKEN_HOTKEYS.split(',').filter(Boolean)) globalShortcut.register(a.trim(), () => {});
  applyHotkey();
  applyApi();
  syncClipboardWatch();
  updater.start();
  if (!TEST_MODE) setInterval(() => service.heartbeat().catch((e) => console.error(e)), HEARTBEAT_MS);
});

app.on('window-all-closed', () => app.quit());
// every global shortcut goes with the app (快捷键唤起语音对话)
app.on('will-quit', () => { if (voiceHotkey) voiceHotkey.dispose(); else globalShortcut.unregisterAll(); });
