'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, dialog, safeStorage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient } = require('../core/lh-client');
const { ResponsesClient } = require('../core/responses-client');
const { Store } = require('../core/store');
const { SettingsStore, petScale, clampScale } = require('../core/settings');
const { PetService } = require('./pet-service');
const { Updater } = require('./updater');
const { SPECIES, SPECIES_IDS } = require('../core/species');
const { FOODS } = require('../core/pet-state');
const { registerPackScheme, PackStore } = require('./packs');
const { ApiServer } = require('./api-server');
const { screenPx } = require('../core/fx');
const { TtsEngine, NEURAL } = require('../core/tts');
const { TtsCache } = require('../core/tts-cache');
const { TtsKeyStore } = require('../core/tts-keys');
const { VoicePacks, packApplies, norm: packNorm } = require('../core/voice-pack');

const TEST_MODE = process.env.PIXELPET_TEST === '1';
const HEARTBEAT_MS = TEST_MODE ? 2000 : 30 * 1000;
const SIZES = { onboarding: { w: 680, h: 480 }, pet: { w: 230, h: 340 }, panel: { w: 460, h: 540 } };

if (process.env.PIXELPET_DATA_DIR) app.setPath('userData', process.env.PIXELPET_DATA_DIR);
if (TEST_MODE) app.commandLine.appendSwitch('no-sandbox');
registerPackScheme();

let win = null;
let service = null;
let updater = null;
let packStore = null;
let petBounds = null; // the pet window's bounds while a panel (wardrobe / topics) has it enlarged
let apiServer = null;
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

// ---- visitors (同屏伙伴): other model-chan on the desktop, each in its own small window -------------
function syncVisitors() {
  const want = service && service.pet ? service.settings.visitors.filter((id) => SPECIES[id] && id !== service.pet.speciesId) : [];
  for (const [id, p] of pets) {
    if (id === 'main') continue;
    if (!want.includes(p.speciesId)) { pets.delete(id); if (!p.win.isDestroyed()) p.win.destroy(); }
  }
  want.forEach((speciesId, i) => {
    const id = `visitor:${speciesId}`;
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
    v.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { visitor: speciesId } });
    pets.set(id, { win: v, speciesId, hit: null, vx: 0, vy: 0 });
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
async function applyApi() {
  if (!apiServer) return;
  const a = service.settings.api;
  const st = await apiServer.apply({ enabled: a.enabled, port: a.port });
  sendAll('api-status', st);
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
    return { view: v, update: updater.state, settings: service.getSettings(), species: SPECIES_IDS.map((id) => ({ ...SPECIES[id], fallback: undefined, personality: undefined, portrait: service.lookFor(id, 'daily') })), foods: FOODS, testMode: TEST_MODE };
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
  ipcMain.handle('touch', (_e, target) => service.touch(target));
  ipcMain.handle('talk-topic', (_e, { id }) => service.talkTopic(String(id || '')));
  ipcMain.handle('get-settings', () => service.getSettings());
  ipcMain.handle('confirm-age', (_e, { adult }) => service.answerAgeGate(!!adult));
  ipcMain.handle('set-adult', (_e, { on }) => service.setAdultContent(!!on));
  ipcMain.handle('equip-outfit', (_e, { id }) => service.equipOutfit(String(id || '')));
  ipcMain.handle('unlock-all', () => service.unlockAll());
  // the model (高级设置 → 模型): only the current character's vendor's models are offered
  ipcMain.handle('set-model', (_e, { key }) => service.setModel(String(key || '')));
  ipcMain.handle('refresh-models', async () => {
    await service.refreshModels({ force: true });
    return { ok: true, view: service.view() };
  });
  // pet packs (高级设置 → 外观)
  ipcMain.handle('set-appearance', (_e, { id }) => service.setAppearance(String(id || '')));
  ipcMain.handle('import-pack', async () => {
    const r = await dialog.showOpenDialog(win, { title: '导入角色包', properties: ['openFile', 'openDirectory'], filters: [{ name: '角色包', extensions: ['zip', 'json'] }] });
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
  ipcMain.handle('remove-pack', (_e, { id }) => {
    const r = packStore.remove(String(id || ''));
    if (r.ok) service.setPacks(packStore.packs);
    return r;
  });
  ipcMain.on('open-packs-folder', () => shell.openPath(packStore.userDir));
  // While the user drags the resize handle: resize the window only. On release: save.
  ipcMain.handle('preview-pet-scale', (_e, { scale }) => resizePet(clampScale(scale)));
  ipcMain.handle('set-pet-scale', (_e, { scale }) => service.setPetScale(resizePet(clampScale(scale))));
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
    const sp = SPECIES[p.speciesId];
    return { speciesId: p.speciesId, species: SPECIES_IDS.map((id) => ({ ...SPECIES[id], fallback: undefined, personality: undefined, portrait: service.lookFor(id, 'daily') })), look: service.lookFor(sp.id, 'daily'), settings: service.getSettings(), testMode: TEST_MODE };
  });
  ipcMain.handle('set-prefs', (_e, patch) => {
    const r = service.setPrefs(patch);
    if (!service.settings.prefs.voice) tts.engine.stopAll(); // 朗读 off: nothing more goes to an engine
    return r;
  });
  // 语音: synthesise one line with the chosen engine for the current character; the renderer plays it
  // (or falls back to the system voice). A new line aborts the one still being fetched.
  ipcMain.handle('tts-synthesize', async (_e, { text, mood }) => {
    const sp = service.pet ? SPECIES[service.pet.speciesId] : null;
    if (!sp) return { ok: false, reason: 'no-pet', fallback: service.settings.tts.fallback, fellBackFrom: [] };
    if (!service.settings.prefs.voice) return { ok: false, reason: 'off', fallback: 'silent', fellBackFrom: [] };
    const hit = recordedLine(sp, text);
    if (hit) { tts.engine.cancel(); tts.engine.stats.packHits = (tts.engine.stats.packHits || 0) + 1; return { ok: true, ...hit, cached: true, fellBackFrom: [], fallback: service.settings.tts.fallback, latencyMs: 0 }; }
    const r = await tts.engine.synthesize({ text: String(text || ''), species: sp, mood: typeof mood === 'string' ? mood : '' }, service.settings.tts);
    if (r.fellBackFrom.length) service.emit('settings', service.settingsView()); // the 语音 section shows the last error
    return r;
  });
  ipcMain.on('tts-cancel', () => tts.engine.cancel());
  // 语音包: her recorded line for this text, when packs are on and the engine that would read it is the
  // one the pack was recorded with (or none can): played from disk, no request (core/voice-pack.js).
  function recordedLine(sp, text, probe = false) {
    const pack = tts.packs.packFor(sp.id);
    if (!packApplies(service.settings.tts, pack, tts.engine.firstUsable(sp, service.settings.tts))) return null;
    if (probe) return pack.lines.has(packNorm(text));
    return tts.packs.lookup(sp.id, text);
  }
  // 互动语音: synthesise her common short lines ahead (pet-service.js voiceLines) so they play at once.
  // Only with 朗读 and 互动语音 on; a newer call (another character, a new key) replaces a running one.
  ipcMain.handle('tts-prewarm', async () => {
    const p = service.settings.prefs;
    if (!service.pet || !p.voice || p.voiceInteractions === false) return { skipped: 'off' };
    const sp = SPECIES[service.pet.speciesId];
    const all = service.voiceLines();
    const lines = all.filter((l) => !recordedLine(sp, l.text, true)); // the 语音包 already has these
    const r = await tts.engine.prewarm(lines, sp, service.settings.tts);
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
  ipcMain.handle('update-install', () => updater.install());
  ipcMain.handle('update-check', () => updater.checkNow());

  if (TEST_MODE) {
    // Test-only hooks used by the E2E suite to drive time-dependent behaviour.
    ipcMain.handle('debug-set', (_e, patch) => service.debugSet(patch));
    ipcMain.handle('debug-import-pack', async (_e, dir) => {
      const r = await packStore.importFrom(String(dir));
      if (r.ok) service.setPacks(packStore.packs);
      return r;
    });
    ipcMain.handle('debug-heartbeat', async () => {
      await service.heartbeat();
      return service.view();
    });
  }

  service.on('update', (v) => send('update', v));
  service.on('say', (m) => send('say', m));
  service.on('thinking', (b) => send('thinking', b));
  service.on('affection', (a) => send('affection', a));
  service.on('settings', (st) => { sendAll('settings', st); syncVisitors(); });
  // the companion appeared, changed or left: visitors follow (none without a companion)
  service.on('update', () => setImmediate(syncVisitors));
  service.on('error', logError);
  updater.on('status', (st) => send('update-status', st));
  ipcMain.on('open-log', () => { try { fs.appendFileSync(logFile(), ''); shell.showItemInFolder(logFile()); } catch { /* ignore */ } });
}

app.whenReady().then(() => {
  const store = new Store(app.getPath('userData'));
  packStore = new PackStore();
  packStore.serve();
  for (const p of packStore.problems) logError(new Error(`pet pack ${p.dir} skipped: ${p.errors.join('; ')}`));
  const keys = new TtsKeyStore(app.getPath('userData'), { available: () => safeStorage.isEncryptionAvailable(), encrypt: (t) => safeStorage.encryptString(t), decrypt: (b) => safeStorage.decryptString(b) });
  const cache = new TtsCache(path.join(app.getPath('userData'), 'tts-cache'));
  const packs = new VoicePacks([path.join(__dirname, '..', 'voicepacks'), path.join(app.getPath('userData'), 'voicepacks')], { log: logError });
  tts = { keys, cache, packs, engine: new TtsEngine({ keys, cache, log: logError }) };
  const ttsStatus = () => ({ engines: tts.engine.status(), encrypted: keys.encrypted(), cache: { count: cache.count(), bytes: cache.size() }, stats: { ...tts.engine.stats }, packs: packs.list() });
  const lh = new LhClient();
  // E2E runs use a fake lh; the real CLI login on the machine must not be used for them
  const responses = TEST_MODE && process.env.PIXELPET_DIRECT !== '1' ? null : new ResponsesClient({ lh });
  service = new PetService({ lh, responses, store, settingsStore: new SettingsStore(app.getPath('userData')), packs: packStore.packs, ttsStatus });
  updater = new Updater({ isBusy: () => service.busy, log: logError });
  apiServer = new ApiServer({
    token: () => service.settings.api.token,
    state: async () => {
      const r = await askRenderer('state');
      const v = service.view();
      return { pet: v ? { name: v.pet.name, species: v.pet.speciesId, affection: v.pet.affection, hunger: v.pet.hunger, mood: v.pet.mood, energy: v.pet.energy, sleeping: v.pet.sleeping, busy: v.busy } : null, fx: r && r.ok ? r.fx : null, bubble: r && r.ok ? r.bubble : null };
    },
    say: async (text) => service.sayExternal(text),
    anim: (state, facing) => askRenderer('anim', { state, facing }),
    throw: (v) => askRenderer('throw', v, 20000),
    chat: (text) => service.chat(text, [], []),
  }, logError);
  wire();
  createWindow();
  pets.set('main', { win, speciesId: null, hit: null, vx: 0, vy: 0 });
  applyApi();
  updater.start();
  if (!TEST_MODE) setInterval(() => service.heartbeat().catch((e) => console.error(e)), HEARTBEAT_MS);
});

app.on('window-all-closed', () => app.quit());
