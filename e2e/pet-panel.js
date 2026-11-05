// 她的面板 (right click / long press on her: its own small window beside her) and 检查更新… in the macOS menu bar,
// driven as a user does.
//   P1  hovering her shows no status card or toolbar any more
//   P2  a right click on her opens one card beside her (not over her): name · character · stage, affection, the
//       three needs, 4 tiles, footer; light + dark
//   P3  tiles and footer buttons hover as quiet fills; ←→ move between them
//   P4  it closes on a right click on her again, Esc, a press in her window, after a button; 10 rounds stay stable,
//       one panel window
//   P5  what each button does: 喂食 opens the foods in the card and picking one feeds her; 玩耍 closes it and she
//       plays; 静音 switches in place; 聊天 opens the chat box; ⚙ opens the settings window
//   P6  a long press (touch) opens it; at the right screen edge it opens on her left
//   P7  while she thinks it closes and a right click does not open it
//   U1… 检查更新… (Pixel Pet menu): 已是最新 / 发现新版本 → 前往下载页 / 失败 → 重试 / 下载中 → 已下载好 / 开发版
// Screenshots: out/e2e/petpanel/*.png; the update dialogs are native, so e2e runs record them as text and answer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

const isPanel = (p) => p.url().includes('/renderer/panel/panel.html');
// the panel's page (its own window); null before it was first opened
const panelPage = (page) => page.context().pages().find(isPanel) || null;
const panelState = (page) => page.evaluate(() => window.pet.debugPetPanel());
// where to right click: the upper middle of her picture
async function petPoint(page) {
  return page.evaluate(() => {
    const el = [...document.querySelectorAll('.pet-hit')].find((e) => !e.classList.contains('hidden'));
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height * 0.45) };
  });
}
async function waitPanel(page, visible) {
  for (let i = 0; i < 60; i++) {
    const st = await panelState(page);
    if (st.visible === visible) return st;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`the panel did not ${visible ? 'open' : 'close'}`);
}
// right click her and wait for the panel; -> its page
async function openPetPanel(page) {
  if (!(await panelState(page)).visible) {
    const p = await petPoint(page);
    await page.mouse.move(p.x, p.y);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    await waitPanel(page, true);
  }
  let pp = null;
  for (let i = 0; i < 60 && !pp; i++) { pp = panelPage(page); if (!pp) await new Promise((r) => setTimeout(r, 50)); }
  await pp.waitForFunction(() => document.getElementById('pp-name').textContent.length > 0);
  await pp.waitForTimeout(220); // the pop-in
  return pp;
}
// a button in her panel, as a user presses it
async function clickAct(page, act) {
  const pp = await openPetPanel(page);
  await pp.click(`[data-act="${act}"]`);
  return pp;
}
// 喂食 → a food (the i-th): opens the panel, the foods, and picks one
async function pickFood(page, i = 0) {
  const pp = await clickAct(page, 'feed');
  await pp.waitForSelector('#food-menu:not(.hidden) .btn');
  await pp.click(`#food-menu .btn >> nth=${i}`);
  return pp;
}

module.exports = function petPanelScenario({ OUT, FAKE_LH, step, launch }) {
  return async function petpanel() {
    const S = 'petpanel';
    const SHOTS = path.join(OUT, 'petpanel');
    fs.mkdirSync(SHOTS, { recursive: true });
    const { version } = require('../package.json');
    // the update feed (GitHub's releases API on Linux): `mode` decides the next answers
    let mode = { tag: `v${version}`, fails: 0 };
    const server = http.createServer((req, res) => {
      if (req.url !== '/releases/latest') { res.writeHead(404); return res.end(); }
      if (mode.fails > 0) { mode.fails -= 1; res.writeHead(500); return res.end('boom'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag_name: mode.tag, html_url: `https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases/tag/${mode.tag}` }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const feed = `http://127.0.0.1:${server.address().port}`;
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-panelfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const env = { PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-panel-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_UPDATE_TEST: '1', PIXELPET_UPDATE_FEED: feed, PIXELPET_E2E_APP_MENU: '1' };
    let { app, page } = await launch(env);
    const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const pshot = (pp, n) => pp.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    // both windows side by side, as they sit on the screen (one picture of her and her panel)
    const both = async (pp, n) => {
      const st = await panelState(page);
      const pet = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('renderer/index.html')).getBounds());
      const a = path.join(SHOTS, `.${n}-pet.png`);
      const b = path.join(SHOTS, `.${n}-panel.png`);
      await page.screenshot({ path: a });
      await pp.screenshot({ path: b });
      fs.writeFileSync(path.join(SHOTS, `${n}.json`), JSON.stringify({ pet, panel: st.bounds, side: st.side }, null, 2));
      return { pet, panel: st.bounds, side: st.side, files: [a, b] };
    };
    const geom = (pp) => pp.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; };
      const p = document.getElementById('pet-panel');
      const shown = [...p.querySelectorAll('[data-act]')].filter((b) => !b.classList.contains('hidden') && b.offsetParent);
      return { win: { w: innerWidth, h: innerHeight }, card: r(p), acts: shown.map((b) => b.dataset.act), name: document.getElementById('pp-name').textContent, char: document.getElementById('pp-char').textContent, stage: document.getElementById('aff-stage').textContent, aff: document.getElementById('aff-num').textContent, meta: document.getElementById('meta').textContent, needs: ['hunger', 'mood', 'energy'].map((k) => document.getElementById(`val-${k}`).textContent), theme: document.documentElement.dataset.theme, cut: [...p.querySelectorAll('.pp-name, .pp-char')].some((e) => e.scrollWidth > e.clientWidth + 1) };
    });
    const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    // what the update dialogs said
    const dialogs = () => page.evaluate(() => window.pet.debugUpdateDialogs());
    const menuCheck = async (want = 1) => {
      const before = (await dialogs()).length;
      // click 检查更新… in the Pixel Pet menu, as the menu bar does
      const items = await app.evaluate(({ Menu }) => { const sub = Menu.getApplicationMenu().items[0].submenu.items; sub.find((i) => i.label === '检查更新…').click(); return sub.map((i) => i.label || i.type); });
      for (let i = 0; i < 100 && (await dialogs()).length < before + want; i++) await page.waitForTimeout(150);
      const all = await dialogs();
      assert.ok(all.length >= before + want, `${want} dialog(s) answered the check`);
      return { menu: items, dialogs: all.slice(before) };
    };
    const say = (d) => d.map((x) => `「${x.message}」${x.detail.replace(/\n/g, ' ')} [${x.buttons.map((b) => b.label).join(' / ')}] → ${x.answered}`).join(' ‖ ');
    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.fill('#pet-name', '小克');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await page.waitForTimeout(500);

      await step(S, 'P1 悬停她：不再出现状态卡片和工具栏', async () => {
        const p = await petPoint(page);
        await page.mouse.move(p.x, p.y);
        await page.waitForSelector('body.hover', { timeout: 5000 });
        await page.waitForTimeout(300);
        const vis = await page.evaluate(() => ({ statusInPetWindow: !!document.getElementById('status-panel'), buttonsInPetWindow: document.querySelectorAll('[data-act]').length, hudShown: [...document.getElementById('hud').children].filter((c) => !c.classList.contains('hidden') && getComputedStyle(c).display !== 'none').map((c) => c.id) }));
        assert.equal(vis.statusInPetWindow, false);
        assert.equal(vis.buttonsInPetWindow, 0);
        assert.deepEqual(vis.hudShown, []);
        assert.equal((await panelState(page)).visible, false);
        await shot('p1-hover-nothing');
        return JSON.stringify(vis);
      }, page);

      for (const theme of ['light', 'dark']) {
        await step(S, `P2 ${theme}: 右键她 → 旁边弹出一张卡片（不挡住她）：名字 · 角色 · 阶段、好感、三项状态、四个操作、底栏`, async () => {
          await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
          await page.emulateMedia({ colorScheme: theme });
          await page.waitForTimeout(250);
          const pp = await openPetPanel(page);
          await pp.emulateMedia({ colorScheme: theme });
          const g = await geom(pp);
          assert.equal(g.theme, theme);
          assert.deepEqual(g.acts, ['feed', 'play', 'sleep', 'chat', 'mute', 'scene', 'settings', 'quit']);
          assert.ok(g.card.x >= 0 && g.card.r <= g.win.w && g.card.b <= g.win.h, `the card fits its window: ${JSON.stringify(g)}`);
          assert.equal(g.name, '小克');
          assert.ok(g.char && g.stage && /^\d+\/100$/.test(g.aff), JSON.stringify(g));
          assert.ok(g.needs.every((v) => /^\d+$/.test(v)), JSON.stringify(g.needs));
          assert.ok(!g.cut, 'name and character are not cut');
          const st = await panelState(page);
          const anchor = st.anchor;
          // beside her picture, not over it (the window's shadow margin may touch it)
          assert.ok(overlap({ x: st.bounds.x + 12, y: st.bounds.y + 12, width: st.bounds.width - 24, height: st.bounds.height - 24 }, anchor) === 0, `the card does not cover her: ${JSON.stringify({ card: st.bounds, her: anchor })}`);
          await pshot(pp, `p2-${theme}-panel`);
          const b = await both(pp, `p2-${theme}-beside`);
          return `card ${g.card.w}×${g.card.h} (window ${st.bounds.width}×${st.bounds.height}) on her ${st.side}; her box ${JSON.stringify(anchor)}; ${g.name} · ${g.char} · ${g.stage} ${g.aff}; ${g.meta}; 饱腹/心情/体力 ${g.needs.join('/')}; pet window ${JSON.stringify(b.pet)}`;
        }, page);
        await step(S, `P3 ${theme}: 悬停操作块与底栏按钮有安静的底色；方向键在按钮间移动`, async () => {
          const pp = await openPetPanel(page);
          const bg = (sel) => pp.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
          const before = await bg('[data-act="play"]');
          await pp.hover('[data-act="play"]');
          await pp.waitForTimeout(250);
          const after = await bg('[data-act="play"]');
          assert.notEqual(before, after);
          await pshot(pp, `p3-${theme}-hover-tile`);
          await pp.hover('#btn-settings');
          await pp.waitForTimeout(250);
          const gear = await bg('#btn-settings');
          assert.notEqual(gear, 'rgba(0, 0, 0, 0)');
          await pshot(pp, `p3-${theme}-hover-gear`);
          await pp.focus('[data-act="feed"]');
          await pp.keyboard.press('ArrowRight');
          const f1 = await pp.evaluate(() => document.activeElement.dataset.act);
          await pp.keyboard.press('ArrowRight');
          const f2 = await pp.evaluate(() => document.activeElement.dataset.act);
          assert.deepEqual([f1, f2], ['play', 'sleep']);
          await pp.keyboard.press('Escape');
          await waitPanel(page, false);
          return `tile ${before} → ${after}; ⚙ ${gear}; → moves feed → ${f1} → ${f2}; Esc closes`;
        }, page);
      }
      await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
      await page.emulateMedia({ colorScheme: 'light' });

      await step(S, 'P4 关闭：再右键她 / Esc / 点她的窗口 / 失焦；开关 10 轮稳定、只有一个面板窗口', async () => {
        const ways = [];
        const p = await petPoint(page);
        let pp = await openPetPanel(page);
        await page.mouse.click(p.x, p.y, { button: 'right' });
        await waitPanel(page, false);
        ways.push('right-click again');
        pp = await openPetPanel(page);
        await pp.keyboard.press('Escape');
        await waitPanel(page, false);
        ways.push('esc');
        await openPetPanel(page);
        await page.mouse.click(20, 20); // a press in her window, away from her
        await waitPanel(page, false);
        ways.push('press in her window');
        // another window takes the focus (a click on another app): xvfb has no window manager, so focus it directly
        pp = await openPetPanel(page);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('renderer/index.html')).focus());
        await waitPanel(page, false);
        ways.push('blur');
        for (let i = 0; i < 10; i++) {
          pp = await openPetPanel(page);
          if (i % 3 === 0) await pp.keyboard.press('Escape');
          else if (i % 3 === 1) await page.mouse.click(p.x, p.y, { button: 'right' });
          else await page.mouse.click(20, 20);
          await waitPanel(page, false);
        }
        const st = await panelState(page);
        assert.equal(st.windows, 1, 'one panel window');
        return `closed by ${ways.join(' / ')}; 10 rounds; opens ${st.opens}; last closes ${st.closes.slice(-8).join(',')}; panel windows ${st.windows}`;
      }, page);

      await step(S, 'P5 按钮：喂食 在卡片里展开食物、点一个就喂；玩耍 关面板她去玩；静音 原地切换；聊天 打开输入框；⚙ 打开设置', async () => {
        const notes = [];
        let pp = await clickAct(page, 'feed');
        await pp.waitForSelector('#food-menu:not(.hidden) .btn');
        await pp.waitForTimeout(250);
        const foods = await pp.$$eval('#food-menu .btn', (b) => b.map((x) => x.textContent));
        const grown = await panelState(page);
        await pshot(pp, 'p5-feed-foods');
        const hungerBefore = await pp.textContent('#val-hunger');
        await pp.click('#food-menu .btn >> nth=0');
        await waitPanel(page, false);
        await page.waitForTimeout(600);
        pp = await openPetPanel(page);
        const hungerAfter = await pp.textContent('#val-hunger');
        assert.ok(Number(hungerAfter) > Number(hungerBefore), `饱腹 ${hungerBefore} → ${hungerAfter}`);
        notes.push(`喂食 → foods ${foods.join('/')} in the card (window ${grown.bounds.height}px tall), picked ${foods[0]} → closed, 饱腹 ${hungerBefore} → ${hungerAfter}`);
        await page.waitForTimeout(1500);
        await pp.click('[data-act="play"]');
        await waitPanel(page, false);
        await page.waitForTimeout(150);
        const action = await page.evaluate(() => document.getElementById('pet-body').dataset.action);
        notes.push(`玩耍 → closed, she is ${action}`);
        await page.waitForTimeout(2500);
        pp = await openPetPanel(page);
        const m0 = await pp.getAttribute('#btn-mute', 'aria-pressed');
        await pp.click('#btn-mute');
        await pp.waitForFunction((v) => document.getElementById('btn-mute').getAttribute('aria-pressed') !== v, m0);
        const m1 = await pp.getAttribute('#btn-mute', 'aria-pressed');
        assert.equal((await panelState(page)).visible, true, '静音 keeps the panel open');
        await pshot(pp, 'p5-muted');
        await pp.click('#btn-mute');
        notes.push(`静音 ${m0} → ${m1}, panel stays`);
        await pp.click('[data-act="chat"]');
        await waitPanel(page, false);
        await page.waitForSelector('#chat-row:not(.hidden)');
        await page.mouse.move(110, 150);
        await shot('p5-chat-open');
        notes.push('聊天 → panel closed, the chat box is open');
        pp = await openPetPanel(page);
        await pp.click('#btn-settings');
        let admin = null;
        for (let i = 0; i < 300 && !admin; i++) { admin = app.windows().find((w) => w.url().includes('admin-ui')) || null; if (!admin) await page.waitForTimeout(100); }
        assert.ok(admin, 'the settings window opened');
        assert.equal((await panelState(page)).visible, false);
        await admin.close();
        notes.push('⚙ → settings window, panel closed');
        return notes.join('; ');
      }, page);

      await step(S, 'P6 触屏长按她也能打开；她在屏幕右边缘时面板开在她左边', async () => {
        const p = await petPoint(page);
        await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y).closest('.pet-hit');
          el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, pointerType: 'touch', button: 0, isPrimary: true, clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true }));
        }, p);
        await waitPanel(page, true);
        await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'touch', button: 0, clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true })), p);
        const src = await page.evaluate(() => window.__panel.lastOpen);
        assert.equal(src, 'long-press');
        const st1 = await panelState(page);
        let pp = panelPage(page);
        await pp.keyboard.press('Escape');
        await waitPanel(page, false);
        // her window at the right edge of the screen
        const area = await app.evaluate(({ screen, BrowserWindow }) => { const wa = screen.getPrimaryDisplay().workArea; const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('renderer/index.html')); const b = w.getBounds(); w.setBounds({ ...b, x: wa.x + wa.width - b.width }); return wa; });
        await page.waitForTimeout(300);
        pp = await openPetPanel(page);
        const st2 = await panelState(page);
        assert.equal(st2.side, 'left');
        assert.ok(st2.bounds.x >= area.x && st2.bounds.x + st2.bounds.width <= area.x + area.width);
        await both(pp, 'p6-right-edge');
        await pp.keyboard.press('Escape');
        return `long press → ${src} (on her ${st1.side}); at the right edge → on her ${st2.side} ${JSON.stringify(st2.bounds)}`;
      }, page);

      await step(S, 'P7 她在思考时：面板自动关闭，右键也不打开；想完后右键照常打开', async () => {
        const p = await petPoint(page);
        // a reply that takes a while (the fake lh prints it piece by piece)
        fs.writeFileSync(path.join(fakeDir, 'stream-reply.json'), JSON.stringify({ pieces: ['嗯…', '让我想想', '好了'], gapMs: 900 }));
        let pp = await openPetPanel(page);
        await page.evaluate(() => { window.pet.chat('你在想什么？', [], []); });
        await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 10000 });
        const st1 = await waitPanel(page, false);
        await page.mouse.click(p.x, p.y, { button: 'right' });
        await page.waitForTimeout(400);
        const st2 = await panelState(page);
        assert.equal(st2.visible, false, 'no panel while she thinks');
        await shot('p7-thinking-no-panel');
        await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
        fs.rmSync(path.join(fakeDir, 'stream-reply.json'), { force: true });
        pp = await openPetPanel(page);
        await pp.keyboard.press('Escape');
        return `thinking → closed (${st1.closes[st1.closes.length - 1]}); right click while thinking → visible ${st2.visible}; after → opens again`;
      }, page);

      // ---- 检查更新… in the Pixel Pet menu (built on Linux for the run: PIXELPET_E2E_APP_MENU=1) ----
      await step(S, 'U1 顶栏 Pixel Pet 菜单有「检查更新…」；已是最新 → 对话框「已是最新版本」', async () => {
        mode = { tag: `v${version}`, fails: 0 };
        const r = await menuCheck();
        assert.deepEqual(r.menu, ['关于 Pixel Pet', '检查更新…', 'separator', '偏好设置…', 'separator', '退出']);
        assert.equal(r.dialogs[0].message, '已是最新版本');
        assert.match(r.dialogs[0].detail, new RegExp(`v${version.replace(/\./g, '\\.')}`));
        return `menu ${r.menu.join(' · ')}; ${say(r.dialogs)}`;
      }, page);
      await step(S, 'U2 有新版本 → 「发现新版本 v9.9.9」，点「前往下载页」打开发布页', async () => {
        mode = { tag: 'v9.9.9', fails: 0 };
        await page.evaluate(() => window.pet.debugUpdateAnswer('open'));
        const r = await menuCheck();
        assert.equal(r.dialogs[0].message, '发现新版本 v9.9.9');
        assert.equal(r.dialogs[0].answered, 'open');
        const links = await page.evaluate(() => window.pet.debugOpenedLinks());
        assert.ok(links.some((u) => u.endsWith('/releases/tag/v9.9.9')), JSON.stringify(links));
        return `${say(r.dialogs)}; opened ${links[links.length - 1]}`;
      }, page);
      await step(S, 'U3 检查失败 → 「检查更新失败」+ 原因，点「重试」再查一次（这次成功）', async () => {
        mode = { tag: `v${version}`, fails: 1 };
        await page.evaluate(() => window.pet.debugUpdateAnswer('retry'));
        const r = await menuCheck(2);
        assert.equal(r.dialogs[0].message, '检查更新失败');
        assert.match(r.dialogs[0].detail, /500/);
        assert.equal(r.dialogs[0].answered, 'retry');
        assert.equal(r.dialogs[1].message, '已是最新版本');
        return say(r.dialogs);
      }, page);
      await step(S, 'U4 正在下载 → 「发现新版本」后台下载；下载好后再弹「已下载好」+「立即更新」', async () => {
        await page.evaluate(() => window.pet.debugUpdateState({ status: 'downloading', version: '9.9.9', error: null }));
        const before = (await dialogs()).length;
        const r = await menuCheck();
        assert.equal(r.dialogs[0].message, '发现新版本 v9.9.9');
        assert.match(r.dialogs[0].detail, /后台下载/);
        await page.evaluate(() => window.pet.debugUpdateState({ status: 'ready', version: '9.9.9' }));
        for (let i = 0; i < 25 && (await dialogs()).length < before + 2; i++) await page.waitForTimeout(200);
        const d = (await dialogs()).slice(before);
        assert.equal(d[1].message, '新版本 v9.9.9 已下载好');
        assert.deepEqual(d[1].buttons.map((b) => b.label), ['立即更新', '稍后']);
        await page.evaluate(() => window.pet.debugUpdateState({ status: 'latest', version: null }));
        return say(d);
      }, page);
    } finally {
      await app.close().catch(() => {});
    }

    // 开发版 (updates off): the same menu item says so instead of staying silent
    ({ app, page } = await launch({ ...env, PIXELPET_UPDATE_TEST: '', PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-panel2-')) }));
    try {
      await page.waitForSelector('.char-card');
      await step(S, 'U5 开发版（不检查更新）→ 「当前版本不检查更新」', async () => {
        const r = await menuCheck();
        assert.equal(r.dialogs[0].message, '当前版本不检查更新');
        return say(r.dialogs);
      }, page);
    } finally {
      await app.close().catch(() => {});
      server.close();
    }
  };
};
Object.assign(module.exports, { openPetPanel, clickAct, pickFood, panelPage, panelState });
