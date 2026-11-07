'use strict';
// 桌面壁纸 · main.js 的接线 (docs/wallpaper-mode.md §3.4): the IPC of the wallpaper page and of 商店 → 小游戏 → 壁纸,
// the tray's 壁纸 submenu, the restart restore, and the e2e's debug hooks. main.js calls wireWallpaper() once and uses
// the returned helpers where the wallpaper meets the pet window (showPet, the game window, quitting).
//
//   page       wallpaper:boot · wallpaper:report (ready / visibility / her place)
//   settings   wallpaper-state · wallpaper-set { id, confirmed } · wallpaper-exit · wallpaper-recall · wallpaper-return
//   tests      debug-wallpaper · debug-wallpaper-signal · debug-wallpaper-hotkey · debug-wallpaper-kill · debug-wallpaper-check
const WS = require('../../core/wallpaper-state');
const hotkeyLib = require('../../core/hotkey');

const AVAIL_TTL_MS = 30 * 1000;

function wireWallpaper({ ipcMain, host, service, games, admin, log = () => {}, testMode = false, notify = () => {}, refreshTray = () => {}, restoreDelayMs = 3000, platform = process.platform }) {
  const notices = [];
  let avail = null;
  let availAt = 0;
  // can this computer do it at all (for the store card: 设为壁纸 disabled with the reason)
  const availability = async ({ fresh = false } = {}) => {
    if (!fresh && avail && Date.now() - availAt < AVAIL_TTL_MS) return avail;
    try { avail = await host.backend.availability({ mode: service.settings.wallpaper.mode }); } catch (e) { log(e); avail = { ok: false, reason: 'helper-failed' }; }
    availAt = Date.now();
    return avail;
  };
  const installed = () => games.list().filter((g) => g.kind === 'wallpaper').map((g) => ({ id: g.id, name: g.name, version: g.version }));
  const hotkeyLabel = () => { const acc = service.settings.wallpaper.hotkey; return acc ? hotkeyLib.labelFor(acc, platform) : ''; };
  const state = async (opts) => {
    const a = await availability(opts);
    return {
      ...host.state(), available: { ok: !!a.ok, mode: a.mode || null, reason: a.reason || null, text: a.reason ? WS.reasonText(a.reason) : null },
      confirmed: !!service.settings.wallpaper.confirmed, hotkeyLabel: hotkeyLabel(), installed: installed(),
    };
  };
  const pushState = async () => { if (admin.alive) admin.send('wallpaper-changed', await state()); refreshTray(); };
  host.onChange = () => { pushState().catch(log); };
  host.onNotice = (n) => { notices.push({ ...n, at: Date.now() }); if (notices.length > 20) notices.shift(); notify(n); if (admin.alive) admin.send('wallpaper-notice', n); };

  // ---- the wallpaper page ----------------------------------------------------------------------------------
  ipcMain.handle('wallpaper:boot', (e) => host.bootFor(e.sender, service.view(), service.settings.scene));
  ipcMain.on('wallpaper:report', (e, msg) => { host.pageReport(e.sender, msg && typeof msg === 'object' ? msg : {}); });

  // ---- 商店 → 小游戏 → 壁纸: the settings window's only (outside tests), like main.js adminOnly ------------------
  const adminOnly = (fn) => (e, p) => (admin.isSender(e) || testMode ? fn(e, p) : { ok: false, reason: 'forbidden' });
  ipcMain.handle('wallpaper-state', adminOnly((_e, p) => state({ fresh: !!(p && p.fresh) })));
  ipcMain.handle('wallpaper-set', adminOnly(async (_e, { id, confirmed } = {}) => {
    if (confirmed) service.setSection('wallpaper', { confirmed: true });
    const r = await host.enter(String(id || ''), { source: 'store' });
    return { ...r, state: await state() };
  }));
  ipcMain.handle('wallpaper-exit', adminOnly(async () => ({ ...(await host.exit({ reason: 'user' })), state: await state() })));
  ipcMain.handle('wallpaper-recall', adminOnly(async () => ({ ...host.recall({ source: 'store' }), state: await state() })));
  ipcMain.handle('wallpaper-return', adminOnly(async () => ({ ...host.return({ source: 'store' }), state: await state() })));

  // ---- tests ----------------------------------------------------------------------------------------------------
  if (testMode) {
    ipcMain.handle('debug-wallpaper', (_e, p) => host.debugState({ probe: !(p && p.probe === false) }).then((d) => ({ ...d, notices: notices.slice(), settings: service.settings.wallpaper })));
    // covered goes in under its own key ('test'), so the X11 fullscreen poll ('all') does not undo it
    ipcMain.handle('debug-wallpaper-signal', (_e, { name, value } = {}) => { host.setSignal(String(name), name === 'covered' ? { test: !!value } : value); return host.state().fps; });
    ipcMain.handle('debug-wallpaper-hotkey', () => host.toggle('hotkey'));
    // a wallpaper window destroyed from outside (as when Explorer takes the WorkerW with it): the host builds it again
    ipcMain.handle('debug-wallpaper-kill', () => { const w = [...host.wins.values()][0]; if (!w) return false; w.win.destroy(); return true; });
    ipcMain.handle('debug-wallpaper-check', () => host.check('test'));
    // the control for the click-through check: the first wallpaper window taking input again (true) / not (false)
    ipcMain.handle('debug-wallpaper-ignore', (_e, on) => { const w = [...host.wins.values()][0]; if (!w) return false; w.win.setIgnoreMouseEvents(!!on); w.ignoreMouse = !!on; return true; });
    ipcMain.handle('debug-wallpaper-availability', () => availability({ fresh: true }));
  }

  // ---- the pieces main.js calls ---------------------------------------------------------------------------
  let restored = false;
  return {
    state,
    availability,
    installed,
    // the pet hatched / the app started with her: back into the wallpaper she was in (3 s later, docs §2.2)
    restoreSoon() {
      if (restored) return;
      restored = true;
      const w = service.settings.wallpaper;
      if (!w.on || !w.id) return;
      setTimeout(async () => {
        const r = await host.enter(w.id, { source: 'restart', restore: true }).catch((e) => { log(e); return { ok: false, reason: 'helper-failed' }; });
        if (!r.ok) {
          service.setSection('wallpaper', { on: false });
          host.onNotice({ kind: 'restore-failed', reason: r.reason, text: WS.reasonText(r.reason) });
        }
      }, restoreDelayMs);
    },
    // showPet(): she is in the wallpaper → called out first (the voice hotkey, 显示桌宠, notifications …)
    beforeShowPet() { if (host.where === 'wallpaper') { host.recall({ source: 'showPet' }); return true; } return false; },
    trayItems() {
      if (!installed().length && !host.active) return null;
      const items = [];
      if (host.where === 'wallpaper') items.push({ label: '叫她出来', click: () => host.recall({ source: 'tray' }) });
      else if (host.where === 'out') items.push({ label: '回到壁纸', click: () => host.return({ source: 'tray' }) });
      if (host.active || host.mode === 'static') items.push({ label: '退出壁纸', click: () => { host.exit({ reason: 'user' }).catch(log); } });
      items.push({ label: '换一张壁纸…', click: () => admin.open('store/games') });
      return { label: '壁纸', submenu: items };
    },
    notices: () => notices.slice(),
  };
}

module.exports = { wireWallpaper };
