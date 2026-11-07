// 桌面壁纸 (docs/wallpaper-mode.md): a wallpaper pack bought in the store and set as the desktop wallpaper, driven as a
// user does — `xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js wallpaper` (unset ELECTRON_RUN_AS_NODE first; no
// tokens: fake lh). Needs openbox, x11-utils (xprop / xwininfo), xdotool and ImageMagick (`import`): the scenario
// starts openbox itself after checking the no-window-manager case. The store's CDN is a local server holding the
// fixture packs (test/fixtures/games/mini-wallpaper, mini-yard) zipped here, and the games repository's catalog.json
// (PIXELPET_GAME_INDEX_URL) lists them — the wallpaper as engine wallpaper@1, minAppVersion 0.29.0 (the app plays as
// 0.29.0: PIXELPET_E2E_APP_VERSION).
//   WP1  商店 → 小游戏: the wallpaper has the 壁纸 badge; the filter 壁纸 shows only it; 下载 → 已下载
//   WP2  no window manager (bare Xvfb): 设为壁纸 is disabled, its tooltip says why (no-wm); nothing is created
//   WP3  openbox started: 设为壁纸 → the first-time dialog → she is in the wallpaper: her desktop window hidden, the card
//        says 正在用作壁纸 and offers 退出壁纸
//   WP4  the Linux probe (xprop / xwininfo / XShape): _NET_WM_WINDOW_TYPE_DESKTOP, not override-redirect, bottom of
//        _NET_CLIENT_LIST_STACKING with the settings window above it, input shape empty (click-through), not active
//   WP5  a real click (xdotool) on the wallpaper reaches nothing: the page counts 0 clicks, it never becomes active;
//        the screen there shows the wallpaper's picture
//   WP6  power: the page draws (frames, cap 24 = the pack's); battery → 10; covered → 0 (frames stop); back → 24
//   WP7  叫她出来 / 回到壁纸: the hotkey, the tray's 壁纸 submenu and the detail page's buttons
//   WP8  a mini game opened from the wallpaper pauses it; closing the game puts her back into the wallpaper
//   WP9  recovery: the wallpaper window destroyed from outside is built again and is still a bottom DESKTOP window
//   WP10 restart: wallpaper mode comes back by itself
//   WP11 退出壁纸: the windows go, she is back on the desktop, the setting is off
// Screenshots, the probe outputs and the step log: out/e2e/wallpaper/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');

const isAdmin = (p) => p.url().includes('admin-ui');
const isWall = (p) => p.url().includes('/renderer/wallpaper/wallpaper.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 }).trim(); } catch (e) { return `ERR ${String(e.message).split('\n')[0]}`; } };
const hex = (n) => `0x${Number(n).toString(16)}`;

module.exports = function wallpaperScenario({ ROOT, OUT, FAKE_LH, step, launch, openAdminWindow }) {
  return async function wallpaper() {
    const S = 'wallpaper';
    const SHOTS = path.join(OUT, 'wallpaper');
    fs.mkdirSync(SHOTS, { recursive: true });
    const evidence = { probes: {}, steps: [] };
    const keep = (k, v) => { evidence[k] = v; fs.writeFileSync(path.join(SHOTS, 'evidence.json'), JSON.stringify(evidence, null, 2)); };
    const rootShot = (n) => sh('import', ['-window', 'root', path.join(SHOTS, `${n}.png`)]);
    // the store's CDN: the fixture packs, zipped; the catalog lists them as the games repository would
    const { zip } = require(path.join(ROOT, 'scripts', 'build-character-catalog'));
    const cdn = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wpcdn-'));
    const entry = (id, extra) => {
      const file = `${id}-1.0.0.zip`;
      zip(path.join(ROOT, 'test', 'fixtures', 'games', id), path.join(cdn, file));
      const buf = fs.readFileSync(path.join(cdn, file));
      return { id, type: 'game', version: '1.0.0', file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), published: '2026-11-07', ...extra };
    };
    const catalog = { schema: 1, release: 'games-v1', games: [
      entry('mini-wallpaper', { name: '测试小院壁纸', engine: 'wallpaper@1', minAppVersion: '0.29.0', description: '测试用的最小壁纸包：天空、飘过的云和一片草地，她在草地上走动、坐下。', features: ['白天 / 夜晚两张天空', '飘过的云'] }),
      entry('mini-yard', { name: '小测试院', engine: 'yard@1', minAppVersion: null, description: '单元测试用的最小小游戏包' }),
    ] };
    const server = http.createServer((req, res) => {
      const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (name === 'catalog.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); return; }
      const f = path.join(cdn, name);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wpfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wp-'));
    const base = `http://127.0.0.1:${server.address().port}`;
    const env = { PIXELPET_DATA_DIR: dataDir, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_URL: `${base}/games`, PIXELPET_GAME_INDEX_URL: `${base}/catalog.json`, PIXELPET_E2E_APP_VERSION: '0.29.0', PIXELPET_E2E_WALLPAPER_RESTORE_MS: '800' };
    // a bare Xvfb has no window manager: the run starts without one (WP2) and starts openbox for the rest
    const hadWm = /window id/.test(sh('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']));
    let wm = null;
    let { app, page } = await launch(env);
    let admin = null;
    const until = async (fn, ms = 10000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
        await wait(150);
      }
    };
    const dbg = (o) => page.evaluate((x) => window.pet.debugWallpaper(x), o || {});
    const scene = () => page.evaluate(() => window.pet.debugScene());
    const wallPage = () => until(async () => app.windows().find(isWall) || null, 15000, 'the wallpaper page');
    const W = async () => (await wallPage()).evaluate(() => window.__wallpaper && window.__wallpaper());
    const card = (id) => admin.locator(`[data-store-game="${id}"]`);
    const state = async (id) => card(id).getAttribute('data-game-state');
    const aShot = (n) => admin.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const dialogClick = async (text) => {
      await until(async () => admin.evaluate((t) => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].some((b) => (b.textContent || '').trim() === t), text), 8000, `dialog button ${text}`);
      await admin.evaluate((t) => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].filter((b) => (b.textContent || '').trim() === t).pop().click(), text);
    };
    const filter = (k) => admin.click(`[data-games-filter="${k}"]`);
    // the shelf mounted again (its wallpaper state is read on mount): away and back
    const remount = async () => {
      await admin.evaluate(() => { window.location.hash = '#/overview'; });
      await admin.waitForSelector('[data-path="/overview"]', { timeout: 15000 });
      await admin.evaluate(() => { window.location.hash = '#/store/games'; });
      await admin.waitForSelector('[data-store-game="mini-wallpaper"]', { timeout: 15000 });
      await filter('wallpaper');
    };
    const toStore = async () => {
      admin = await openAdminWindow(app, page, 'store/games');
      await admin.waitForSelector('[data-store-game="mini-wallpaper"]', { timeout: 20000 });
    };

    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.fill('#pet-name', '小克');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });

      await step(S, 'WP1 商店 → 小游戏：壁纸条目带「壁纸」角标，筛选「壁纸」只剩它；下载 → 已下载', async () => {
        await toStore();
        assert.equal(await card('mini-wallpaper').getAttribute('data-game-kind'), 'wallpaper');
        assert.equal(await admin.locator('[data-wallpaper-badge="mini-wallpaper"]').innerText(), '壁纸');
        assert.equal(await state('mini-wallpaper'), 'remote');
        await aShot('wp1-store-all');
        await filter('wallpaper');
        await until(async () => (await admin.locator('[data-store-game]').count()) === 1, 5000, 'only the wallpaper');
        await aShot('wp1-store-filter-wallpaper');
        await admin.click('[data-game-download="mini-wallpaper"]');
        await until(async () => (await state('mini-wallpaper')) === 'installed', 30000, 'installed');
        const files = fs.readdirSync(path.join(dataDir, 'games', 'mini-wallpaper')).sort();
        assert.deepEqual(files, ['.catalog.json', 'cloud.png', 'ground.png', 'manifest.json', 'preview.webp', 'sky-day.webp', 'sky-night.webp']);
        // the mini game too, for WP8
        await filter('all');
        await admin.click('[data-game-download="mini-yard"]');
        await until(async () => (await state('mini-yard')) === 'installed', 30000, 'mini-yard installed');
        await filter('wallpaper');
        const label = (await admin.locator('[data-wallpaper-set="mini-wallpaper"]').innerText()).trim();
        assert.equal(label, '设为壁纸');
        await aShot('wp1-store-installed');
        return `badge 壁纸, filter → 1 card, downloaded: ${files.join(' ')}; main button 「${label}」`;
      }, () => admin);

      await step(S, 'WP2 没有窗口管理器：「设为壁纸」禁用，悬停写明原因（no-wm），什么都没创建', async () => {
        if (hadWm) return 'SKIPPED: this X server already has a window manager';
        const a = await page.evaluate(() => window.pet.debugWallpaperAvailability());
        assert.deepEqual([a.ok, a.reason], [false, 'no-wm']);
        await remount();
        await admin.waitForSelector('[data-wallpaper-blocked="mini-wallpaper"]', { timeout: 15000 });
        assert.equal(await admin.locator('[data-wallpaper-set="mini-wallpaper"]').isDisabled(), true);
        await admin.hover('[data-wallpaper-blocked="mini-wallpaper"]');
        const tip = await until(async () => admin.evaluate(() => { const t = [...document.querySelectorAll('[role="tooltip"], .ant-tooltip, [class*="tooltip"]')].find((x) => /窗口管理器/.test(x.textContent || '')); return t ? t.textContent : null; }), 6000, 'the tooltip');
        assert.match(tip, /没检测到窗口管理器/);
        await aShot('wp2-no-wm-disabled');
        const d = await dbg();
        assert.equal(d.windows.length, 0);
        return `availability ${JSON.stringify(a)}; tooltip 「${tip}」; windows ${d.windows.length}`;
      }, () => admin);

      wm = hadWm ? null : spawn('openbox', [], { stdio: 'ignore' });
      if (wm) await until(async () => /window id/.test(sh('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'])), 10000, 'openbox');

      await step(S, 'WP3 有窗口管理器：设为壁纸 → 首次确认弹窗 → 她住进壁纸，桌宠窗口隐藏，卡片「正在用作壁纸 / 退出壁纸」', async () => {
        const a = await page.evaluate(() => window.pet.debugWallpaperAvailability());
        assert.equal(a.ok, true, JSON.stringify(a));
        await remount();
        await admin.waitForSelector('[data-wallpaper-set="mini-wallpaper"]:not([disabled])', { timeout: 15000 });
        await admin.click('[data-wallpaper-set="mini-wallpaper"]');
        const dlg = await until(async () => admin.evaluate(() => { const d = [...document.querySelectorAll('[role="dialog"], .ant-modal')].find((x) => /让她住进壁纸里/.test(x.textContent || '')); return d ? d.textContent : null; }), 8000, 'the first-time dialog');
        assert.match(dlg, /让她住进壁纸里？/);
        assert.match(dlg, /先不了/);
        await aShot('wp3-confirm');
        await dialogClick('设为壁纸');
        await admin.waitForSelector('[data-wallpaper-exit="mini-wallpaper"]', { timeout: 20000 });
        const d = await dbg();
        assert.deepEqual([d.on, d.where, d.mode, d.id], [true, 'wallpaper', 'live', 'mini-wallpaper']);
        assert.equal((await scene()).petVisible, false, 'her desktop window is hidden');
        assert.equal((await admin.locator('[data-wallpaper-in-use="mini-wallpaper"]').innerText()).trim(), '正在用作壁纸');
        await (await wallPage()).waitForFunction(() => window.__wallpaper && window.__wallpaper().ready, null, { timeout: 20000 });
        await wait(1200);
        await aShot('wp3-store-in-use');
        rootShot('wp3-desktop');
        keep('settingsAfterSet', d.settings);
        return `where=${d.where} mode=${d.mode}; settings.wallpaper ${JSON.stringify({ on: d.settings.on, id: d.settings.id, where: d.settings.where })}; pet window visible=false; card 「正在用作壁纸」+「退出壁纸」`;
      }, () => admin);

      let xid = null;
      await step(S, 'WP4 Linux 探针：窗口类型 DESKTOP、非 override-redirect、在 _NET_CLIENT_LIST_STACKING 最底层、输入形状为空（点穿）、不是活动窗口', async () => {
        const d = await dbg();
        const w = d.windows[0];
        const p = w.probe;
        keep('probeWP4', { window: { display: w.display, bounds: w.bounds, visible: w.visible, focused: w.focused, ignoreMouse: w.ignoreMouse, title: w.title, attached: w.attached, layout: w.layout }, probe: p });
        xid = parseInt(p.xid, 16);
        assert.deepEqual(p.windowType, ['_NET_WM_WINDOW_TYPE_DESKTOP']);
        assert.equal(p.overrideRedirect, 'no');
        assert.equal(p.mapState, 'IsViewable');
        assert.equal(p.stacking.bottom, true, JSON.stringify(p.stacking));
        assert.ok(p.stacking.above.length >= 1, 'the settings window (a normal window) is above it');
        assert.ok(p.inputArea <= 1 && p.windowArea >= 100000, `X input shape ${p.inputShape} (${p.inputArea} px) of a ${p.windowArea} px window: nothing takes input`);
        assert.equal(p.clickThrough, true);
        assert.equal(p.isActive, false);
        assert.equal(w.ignoreMouse, true);
        assert.equal(w.focused, false);
        const raw = { type: sh('xprop', ['-id', p.xid, '_NET_WM_WINDOW_TYPE']), state: sh('xprop', ['-id', p.xid, '_NET_WM_STATE']), stacking: sh('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']), active: sh('xprop', ['-root', '_NET_ACTIVE_WINDOW']) };
        keep('rawWP4', raw);
        console.log(`  probe: ${JSON.stringify({ xid: p.xid, windowType: p.windowType, wmState: p.wmState, overrideRedirect: p.overrideRedirect, stacking: p.stacking, inputShape: p.inputShape, inputArea: p.inputArea, windowArea: p.windowArea, clickThrough: p.clickThrough, isActive: p.isActive, ignoreMouse: w.ignoreMouse, focused: w.focused })}`);
        console.log(`  xprop: ${raw.type} | ${raw.stacking} | ${raw.active}`);
        return `windowType=${p.windowType.join(',')} wmState=[${p.wmState.join(',')}] overrideRedirect=${p.overrideRedirect} stacking=${p.stacking.index}/${p.stacking.of} bottom=${p.stacking.bottom} above=${p.stacking.above.join(',')} inputShape=${p.inputShape} (${p.inputArea}/${p.windowArea} px) clickThrough=${p.clickThrough} active=${p.active} isActive=${p.isActive} ignoreMouse=${w.ignoreMouse}`;
      });

      await step(S, 'WP5 真实点击（xdotool）落在壁纸上：页面 0 次点击、壁纸不会成为活动窗口；该处屏幕是壁纸的画面', async () => {
        const wp = await wallPage();
        const before = (await W()).clicks;
        // the bottom-left corner: outside the settings window (it sits at the middle of the screen)
        const ab = await admin.evaluate(() => ({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight }));
        const sz = (await W()).size;
        const pt = ab.x > 20 ? [8, sz.h - 8] : [sz.w - 8, sz.h - 8];
        const px = (sh('import', ['-window', 'root', '-crop', `1x1+${pt[0]}+${pt[1]}`, 'txt:-']).match(/#[0-9A-F]{6}/i) || ['?'])[0];
        // control: the same window taking input gets the same click
        await page.evaluate(() => window.pet.debugWallpaperIgnore(false));
        await wait(300);
        const ctrlShape = (await dbg()).windows[0].probe;
        sh('xdotool', ['mousemove', String(pt[0]), String(pt[1]), 'click', '1']);
        await wait(600);
        const control = (await W()).clicks - before;
        await page.evaluate(() => window.pet.debugWallpaperIgnore(true));
        await wait(300);
        const mid = (await W()).clicks;
        sh('xdotool', ['mousemove', String(pt[0]), String(pt[1] - 4), 'click', '1']);
        await wait(600);
        const after = (await W()).clicks;
        const active = sh('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
        const activeId = parseInt((active.match(/0x[0-9a-f]+/i) || ['0x0'])[0], 16);
        keep('clickWP5', { point: pt, pixel: px, control: { ignoreMouse: false, inputShape: ctrlShape.inputShape, clicks: control }, clickThrough: { ignoreMouse: true, clicks: after - mid }, active, wallpaperXid: hex(xid), settingsWindow: ab });
        assert.equal(control, 1, 'control: taking input, the wallpaper gets the click');
        assert.equal(after - mid, 0, 'click-through: the wallpaper got no click');
        assert.notEqual(activeId, xid, 'the wallpaper did not become the active window');
        assert.notEqual(px, '#000000', 'the wallpaper picture is on screen there');
        rootShot('wp5-after-click');
        return `click at (${pt}) pixel ${px}: control (ignoreMouse=false, input ${ctrlShape.inputShape}) → wallpaper got ${control} click; default (ignoreMouse=true) → ${after - mid} clicks; ${active} (wallpaper ${hex(xid)})`;
      });

      await step(S, 'WP6 帧率：在画（上限 24 = 包的 power.fps）；用电池 → 10；被遮挡 → 0（不再出帧）；恢复 → 24', async () => {
        const wp = await wallPage();
        const f0 = (await W()).frames;
        await wait(1500);
        const s1 = await W();
        assert.ok(s1.frames - f0 > 15, `frames keep coming (${s1.frames - f0} in 1.5 s)`);
        assert.equal(s1.maxFps, 24);
        await page.evaluate(() => window.pet.debugWallpaperSignal('onBattery', true));
        await until(async () => (await W()).maxFps === 10, 5000, 'battery fps');
        const b0 = (await W()).frames;
        await wait(2000);
        const bat = (await W()).frames - b0;
        await page.evaluate(() => window.pet.debugWallpaperSignal('onBattery', false));
        await page.evaluate(() => window.pet.debugWallpaperSignal('covered', true));
        await until(async () => (await W()).maxFps === 0, 5000, 'paused');
        const c0 = (await W()).frames;
        await wait(1500);
        const cov = (await W()).frames - c0;
        assert.equal(cov, 0, 'no frames while covered');
        await page.evaluate(() => window.pet.debugWallpaperSignal('covered', false));
        await until(async () => (await W()).maxFps === 24, 5000, 'back to 24');
        const r0 = (await W()).frames;
        await wait(1000);
        const back = (await W()).frames - r0;
        assert.ok(bat <= 24 && bat >= 8, `battery: ${bat} frames in 2 s`);
        assert.ok(back > 10, `resumed: ${back} frames in 1 s`);
        keep('powerWP6', { normalFramesIn1_5s: s1.frames - f0, batteryFramesIn2s: bat, coveredFramesIn1_5s: cov, resumedFramesIn1s: back });
        return `normal ${s1.frames - f0} frames/1.5 s (cap 24) · battery ${bat}/2 s (cap 10) · covered ${cov}/1.5 s (cap 0) · resumed ${back}/1 s`;
      });

      await step(S, 'WP7 叫她出来 / 回到壁纸：快捷键、托盘「壁纸」子菜单、详情页按钮', async () => {
        const out1 = await page.evaluate(() => window.pet.debugWallpaperHotkey());
        assert.equal(out1.where, 'out');
        await until(async () => (await scene()).petVisible === true, 5000, 'her window shown');
        await until(async () => (await W()).pet.alpha === 0, 5000, 'she faded out of the picture');
        rootShot('wp7-called-out');
        const tray1 = await page.evaluate(() => window.pet.debugTray());
        assert.ok(tray1.items.includes('壁纸/回到壁纸'), tray1.items.join(' · '));
        await page.evaluate(() => window.pet.debugTrayClick('壁纸/回到壁纸'));
        await until(async () => (await dbg({ probe: false })).where === 'wallpaper', 5000, 'back in');
        assert.equal((await scene()).petVisible, false);
        const tray2 = await page.evaluate(() => window.pet.debugTray());
        assert.ok(tray2.items.includes('壁纸/叫她出来') && tray2.items.includes('壁纸/退出壁纸') && tray2.items.includes('壁纸/换一张壁纸…'), tray2.items.join(' · '));
        // the detail page
        await admin.click('[data-game-open="mini-wallpaper"]');
        await admin.waitForSelector('[data-wallpaper-recall="mini-wallpaper"]', { timeout: 10000 });
        await aShot('wp7-detail-in-wallpaper');
        await admin.click('[data-wallpaper-recall="mini-wallpaper"]');
        await admin.waitForSelector('[data-wallpaper-return="mini-wallpaper"]', { timeout: 10000 });
        assert.equal((await dbg({ probe: false })).where, 'out');
        await aShot('wp7-detail-out');
        await admin.click('[data-wallpaper-return="mini-wallpaper"]');
        await admin.waitForSelector('[data-wallpaper-recall="mini-wallpaper"]', { timeout: 10000 });
        assert.equal((await dbg({ probe: false })).where, 'wallpaper');
        return `hotkey → out (pet window shown) · tray 壁纸/回到壁纸 → wallpaper · tray items ${tray2.items.filter((i) => i.startsWith('壁纸')).join(' · ')} · detail 叫她出来 → out, 让她回到壁纸 → wallpaper`;
      }, () => admin);

      await step(S, 'WP8 小游戏：从壁纸打开小游戏 → 壁纸暂停（0 帧）；关掉小游戏 → 她回到壁纸，不回桌面', async () => {
        await page.evaluate(() => window.pet.debugSceneToggle('test', 'mini-yard'));
        await until(async () => (await scene()).visible === true, 15000, 'the game window');
        await until(async () => (await W()).maxFps === 0, 5000, 'paused for the game');
        const d = await dbg({ probe: false });
        assert.equal(d.where, 'game');
        await page.evaluate(() => window.pet.debugSceneToggle('test', 'mini-yard'));
        await until(async () => (await scene()).visible === false, 10000, 'the game closed');
        await until(async () => (await dbg({ probe: false })).where === 'wallpaper', 5000, 'back in the wallpaper');
        assert.equal((await scene()).petVisible, false, 'not on the desktop');
        await until(async () => (await W()).maxFps === 24, 5000, 'drawing again');
        return `game open: where=game fps 0 · game closed: where=wallpaper, pet window hidden, fps 24`;
      });

      await step(S, 'WP9 恢复：壁纸窗口被外部销毁（如 Explorer 带走 WorkerW）→ 自动重建，仍是最底层 DESKTOP 窗口', async () => {
        const before = (await dbg()).windows[0].probe.xid;
        await page.evaluate(() => window.pet.debugWallpaperKill());
        const d = await until(async () => { const x = await dbg(); return x.log.some((l) => l.kind === 'recover-ok' && l.why === 'window-lost') && x.windows[0] && x.windows[0].alive ? x : null; }, 15000, 'rebuilt');
        await wait(800);
        const p = (await dbg()).windows[0].probe;
        assert.notEqual(p.xid, before, 'a new X window');
        assert.deepEqual(p.windowType, ['_NET_WM_WINDOW_TYPE_DESKTOP']);
        assert.equal(p.stacking.bottom, true);
        assert.equal(p.clickThrough, true);
        keep('probeWP9', p);
        return `window ${before} destroyed → ${p.xid}; log ${d.log.filter((l) => /recover|window-lost/.test(l.kind)).map((l) => `${l.kind}:${l.why || ''}`).join(' → ')}; type ${p.windowType} bottom=${p.stacking.bottom} inputShape=${p.inputShape} clickThrough=${p.clickThrough}`;
      });

      await step(S, 'WP10 重启：settings.wallpaper.on 留着，重新启动后自己回到壁纸', async () => {
        const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).wallpaper;
        assert.deepEqual([saved.on, saved.id, saved.where], [true, 'mini-wallpaper', 'wallpaper']);
        await app.close();
        ({ app, page } = await launch(env));
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        const d = await until(async () => { const x = await dbg(); return x.where === 'wallpaper' && x.windows.length ? x : null; }, 20000, 'back in the wallpaper');
        const p = d.windows[0].probe;
        assert.deepEqual(p.windowType, ['_NET_WM_WINDOW_TYPE_DESKTOP']);
        assert.equal((await scene()).petVisible, false);
        await wait(1500);
        rootShot('wp10-after-restart');
        return `settings.json wallpaper ${JSON.stringify({ on: saved.on, id: saved.id, where: saved.where })} → after restart where=${d.where}, log ${d.log.map((l) => l.kind).join(' → ')}`;
      });

      await step(S, 'WP11 退出壁纸：窗口关闭、她回到桌面、设置关掉', async () => {
        await toStore();
        await filter('wallpaper');
        await admin.waitForSelector('[data-wallpaper-exit="mini-wallpaper"]', { timeout: 15000 });
        await aShot('wp11-before-exit');
        await admin.click('[data-wallpaper-exit="mini-wallpaper"]');
        await admin.waitForSelector('[data-wallpaper-set="mini-wallpaper"]', { timeout: 15000 });
        const d = await dbg();
        assert.deepEqual([d.on, d.where, d.windows.length], [false, 'desktop', 0]);
        await until(async () => (await scene()).petVisible === true, 5000, 'her window back');
        const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).wallpaper;
        assert.equal(saved.on, false);
        assert.equal(app.windows().filter(isWall).length, 0);
        await wait(500);
        await aShot('wp11-after-exit');
        rootShot('wp11-desktop-after-exit');
        return `where=${d.where}, wallpaper windows ${d.windows.length}, pet window visible, settings.wallpaper.on=${saved.on}; button back to 「设为壁纸」`;
      }, () => admin);

      keep('finalLog', (await dbg({ probe: false })).log);
    } finally {
      await app.close().catch(() => {});
      if (wm) wm.kill();
      server.close();
    }
  };
};
