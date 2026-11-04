'use strict';
// 快捷调用面板 Goal 终验补充场景 (T-2858): what quick-actions (stub feed) leaves open.
//   R  真实更新源  检查更新… against the real GitHub Releases API (no PIXELPET_UPDATE_FEED): the request, its HTTP
//                 status and tag_name are logged from main (net.fetch wrapped); R1 at the real version (→ 已是最新),
//                 R2 with app.getVersion() reporting an older version (→ 发现新版本 vX from GitHub, 前往下载页 → the
//                 release page; shell.openExternal recorded, no browser).
//   G  既有功能   launch, hover controls, left click (touch reaction), double click, drag, right click, ⚙, quit +
//                 relaunch. Runs on code without the panel too (the "before" half: window.pet.debugQuick missing),
//                 so the same walk shows what changed: a right click opened 设置 before, the panel now.
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js quick-goal
// Output: out/e2e/quick-goal/ (screenshots, quick-goal.mp4 + chapters, net-log.json, observations.json). Needs network.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

module.exports = ({ OUT, FAKE_LH, step, launch, say }) => async function quickGoalScenario() {
  const S = 'quick-goal';
  const DIR = path.join(OUT, 'quick-goal');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const { version } = require('../package.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  delete process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.PIXELPET_UPDATE_FEED;

  const display = process.env.DISPLAY;
  let size = '1280x800';
  try { size = /dimensions:\s+(\d+x\d+)/.exec(execFileSync('xdpyinfo', { encoding: 'utf8' }))[1]; } catch { /* default */ }
  const chapters = [];
  let rec = null;
  let recAt = 0;
  const chapter = (title) => { if (rec) chapters.push({ t: Math.round((Date.now() - recAt) / 100) / 10, title }); };
  const startRec = () => {
    if (!display) return;
    rec = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '12', '-video_size', size, '-i', display, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', path.join(DIR, 'quick-goal.mp4')], { stdio: ['pipe', 'ignore', 'pipe'] });
    recAt = Date.now();
  };
  const stopRec = async () => {
    if (!rec) return;
    const done = new Promise((r) => rec.on('exit', r));
    rec.stdin.write('q');
    await Promise.race([done, sleep(8000)]);
    rec = null;
    fs.writeFileSync(path.join(DIR, 'quick-goal.chapters.json'), JSON.stringify(chapters, null, 2));
  };
  const grab = async (name) => {
    if (!display) return null;
    await sleep(300);
    try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', size, '-i', display, '-frames:v', '1', path.join(DIR, name)]); return name; } catch { return null; }
  };

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-qg-fake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-qg-'));
  const env = { PIXELPET_DATA_DIR: dataDir, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_UPDATE_TEST: '1' };
  const hatch = async (page) => {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="grok"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
    await sleep(600);
  };
  const until = async (fn, what, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const petPoint = async (page) => {
    const b = await page.locator('#pet-body .pet-hit:not(.hidden)').first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height * 0.45 };
  };
  const winInfo = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => ({ url: w.webContents.getURL().replace(/^.*\/src\//, 'src/').replace(/\?.*$/, ''), visible: w.isVisible() })));
  const adminVisible = async (app) => (await winInfo(app)).some((w) => w.url.includes('admin-ui') && w.visible);
  const quickVisible = async (app) => (await winInfo(app)).filter((w) => w.url.includes('/quick/') && w.visible).length;
  const hideAdmin = (app) => app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('admin-ui')) w.hide(); });
  const panelOf = (app) => app.windows().find((w) => w.url().includes('/quick/'));
  const status = (q) => q.evaluate(() => { const s = document.querySelector('.status'); return s ? { status: s.dataset.status, tone: s.dataset.tone, text: s.innerText.replace(/\s+/g, ' ').trim() } : null; });
  const obs = { version };

  let A = null;
  try {
    A = await launch(env);
    let { app, page } = A;
    await hatch(page);
    const hasPanel = await page.evaluate(() => typeof window.pet.debugQuick === 'function');
    obs.mode = hasPanel ? 'after (with 快捷调用面板)' : 'before (no 快捷调用面板)';
    say(`[${S}] mode: ${obs.mode} · app v${version}`);
    startRec();

    // ================= G 既有功能 =================
    await step(S, 'G1 启动：桌宠出现在桌面上', async () => {
      chapter('G1 启动');
      const w = await winInfo(app);
      assert.ok(w.some((x) => x.url.includes('index.html') && x.visible), 'pet window visible');
      await grab('g1-launch-screen.png');
      return `windows ${JSON.stringify(w)}`;
    });

    await step(S, 'G2 悬停她显示控件、移开隐藏', async () => {
      chapter('G2 悬停控件');
      const p = await petPoint(page);
      await page.mouse.move(p.x, p.y);
      await page.waitForSelector('body.hover', { timeout: 5000 });
      await grab('g2-hover-screen.png');
      await page.mouse.move(2, 2);
      await page.dispatchEvent('body', 'mouseleave').catch(() => {});
      return 'body.hover on pointer over her';
    });

    await step(S, 'G3 左键点她：触摸反应（气泡），不弹面板也不开设置', async () => {
      chapter('G3 左键点击');
      const p = await petPoint(page);
      await page.mouse.click(p.x, p.y);
      const text = await until(() => page.evaluate(() => { const b = document.getElementById('bubble'); return b && !b.classList.contains('hidden') && b.textContent.trim() ? b.textContent.trim() : null; }), 'bubble after a click', 6000);
      await grab('g3-click-screen.png');
      assert.equal(await quickVisible(app), 0, 'no panel');
      assert.equal(await adminVisible(app), false, 'no settings window');
      obs.click = text;
      return `bubble 「${text}」 · panel 0 · settings hidden`;
    });

    await step(S, 'G4 双击她：两次触摸，不弹面板也不开设置', async () => {
      chapter('G4 双击');
      await sleep(1200);
      const p = await petPoint(page);
      await page.mouse.dblclick(p.x, p.y);
      await sleep(900);
      await grab('g4-dblclick-screen.png');
      assert.equal(await quickVisible(app), 0, 'no panel');
      assert.equal(await adminVisible(app), false, 'no settings window');
      const alive = await page.evaluate(() => !document.getElementById('pet-screen').classList.contains('hidden'));
      assert.ok(alive);
      return 'pet still shown · panel 0 · settings hidden';
    });

    await step(S, 'G5 拖动她：窗口跟着移动', async () => {
      chapter('G5 拖动');
      await sleep(800);
      const p = await petPoint(page);
      const b0 = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) { await page.mouse.move(p.x - i * 8, p.y - i * 5); await sleep(40); }
      await page.mouse.up();
      await sleep(700);
      const b1 = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
      await grab('g5-drag-screen.png');
      assert.ok(b1.x !== b0.x || b1.y !== b0.y, `drag moved ${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
      assert.equal(await quickVisible(app), 0, 'drag does not open the panel');
      obs.drag = { from: b0, to: b1 };
      await page.evaluate(() => window.pet.place && window.pet.place('pet')).catch(() => {});
      await sleep(400);
      return `window ${JSON.stringify(b0)} → ${JSON.stringify(b1)} · panel 0`;
    });

    await step(S, hasPanel ? 'G6 右键她：只弹出快捷调用面板（一个窗口，无原生菜单、不直接开设置），偏好设置… 打开设置' : 'G6 右键她（改动前）：直接打开设置窗口', async () => {
      chapter('G6 右键');
      await sleep(600);
      const p = await petPoint(page);
      await page.mouse.click(p.x, p.y, { button: 'right' });
      if (!hasPanel) {
        await until(() => adminVisible(app), 'settings window', 15000);
        await sleep(3000); // first open: let the settings page paint before the shot
        await grab('g6-right-click-screen.png');
        obs.rightClick = 'settings window';
        await hideAdmin(app);
        return 'right click → settings window (no menu)';
      }
      await until(async () => (await quickVisible(app)) === 1, 'panel', 6000);
      await sleep(500);
      await grab('g6-right-click-screen.png');
      const n = await quickVisible(app);
      const admin = await adminVisible(app);
      assert.equal(n, 1, 'exactly one panel');
      assert.equal(admin, false, 'the right click itself does not open settings');
      await panelOf(app).click('#row-settings');
      await until(() => adminVisible(app), 'settings window from 偏好设置…', 15000);
      await sleep(800);
      await grab('g6b-settings-from-panel-screen.png');
      assert.equal(await quickVisible(app), 0, 'panel closed after running');
      await hideAdmin(app);
      obs.rightClick = 'one panel; 偏好设置… → settings window';
      return 'right click → 1 panel window, settings not opened; 偏好设置… → settings window, panel closed';
    });

    await step(S, 'G7 ⚙ 按钮：仍直接打开设置窗口', async () => {
      chapter('G7 ⚙ 设置');
      await sleep(500);
      const p = await petPoint(page);
      await page.mouse.move(p.x, p.y);
      await page.waitForSelector('body.hover', { timeout: 5000 });
      await page.locator('#btn-settings').click();
      await until(() => adminVisible(app), 'settings window', 15000);
      await sleep(800);
      await grab('g7-gear-screen.png');
      assert.equal(await quickVisible(app), 0, '⚙ does not open the panel');
      await hideAdmin(app);
      return '⚙ → settings window · panel 0';
    });

    // ================= R 真实更新源 =================
    if (hasPanel) {
      // log every request the updater makes, with the HTTP status and the release tag it read (main process)
      await app.evaluate(({ net, shell }) => {
        globalThis.__qgNet = [];
        globalThis.__qgOpened = [];
        const orig = net.fetch.bind(net);
        net.fetch = async (url, opts) => {
          const t0 = Date.now();
          const r = await orig(url, opts);
          const entry = { url: String(url), status: r.status, ms: Date.now() - t0, userAgent: opts && opts.headers && opts.headers['User-Agent'] };
          try { const j = await r.clone().json(); entry.tag_name = j.tag_name; entry.html_url = j.html_url; entry.published_at = j.published_at; } catch { /* not json */ }
          globalThis.__qgNet.push(entry);
          return r;
        };
        shell.openExternal = async (u) => { globalThis.__qgOpened.push(u); };
      });
      const check = async (want) => {
        const p = await petPoint(page);
        await page.mouse.click(p.x, p.y, { button: 'right' });
        await until(async () => (await quickVisible(app)) === 1, 'panel', 6000);
        const q = panelOf(app);
        await q.click('#row-check-update');
        return until(async () => { const s = await status(q); return s && s.status === want ? s : null; }, `status ${want}`, 25000);
      };

      await step(S, `R1 真实 GitHub Releases（app v${version}）→ 检查更新… 显示「已是最新版本」`, async () => {
        chapter('R1 真实源：已是最新');
        const s = await check('latest');
        const q = panelOf(app);
        await sleep(300);
        await q.screenshot({ path: path.join(DIR, 'r1-real-latest.png') });
        await grab('r1-real-latest-screen.png');
        const net = await app.evaluate(() => globalThis.__qgNet.slice());
        const hit = net.find((e) => e.url === 'https://api.github.com/repos/rdmclin2/lobehub-pixel-pet-affection/releases/latest');
        assert.ok(hit, `real releases API requested: ${JSON.stringify(net)}`);
        assert.equal(hit.status, 200);
        obs.r1 = { panel: s.text, request: hit };
        await q.keyboard.press('Escape');
        await until(async () => (await quickVisible(app)) === 0, 'closed');
        return `「${s.text}」 · GET ${hit.url} → ${hit.status} tag_name ${hit.tag_name} (${hit.ms} ms)`;
      });

      await step(S, 'R2 真实 GitHub Releases，本机版本报告为 v0.23.0 → 显示「发现新版本」与 GitHub 上的版本号，「前往下载页」打开发布页', async () => {
        chapter('R2 真实源：发现新版本');
        await app.evaluate(({ app: a }) => { globalThis.__qgVer = a.getVersion; a.getVersion = () => '0.23.0'; });
        const s = await check('manual');
        const q = panelOf(app);
        await sleep(300);
        await q.screenshot({ path: path.join(DIR, 'r2-real-newer.png') });
        await grab('r2-real-newer-screen.png');
        const net = await app.evaluate(() => globalThis.__qgNet.slice());
        const hit = net.at(-1);
        assert.match(s.text, new RegExp(`v${hit.tag_name.replace(/^v/, '').replace(/\./g, '\\.')}`), 'panel shows the tag GitHub answered');
        const rows = await q.evaluate(() => [...document.querySelectorAll('#list .row .label')].map((e) => e.textContent));
        const followUp = rows.find((l) => /下载页|立即更新/.test(l));
        assert.ok(followUp, `follow-up row in ${rows.join('|')}`);
        await q.click('#row-open-download');
        // e2e runs record the link instead of opening a browser (main.js open-download, TEST_MODE)
        const opened = await until(async () => { const o = await page.evaluate(() => window.pet.debugOpenedLinks()); return o.length ? o : null; }, 'download page link', 6000);
        assert.equal(opened.at(-1), hit.html_url, 'opens the release page GitHub answered');
        await app.evaluate(({ app: a }) => { a.getVersion = globalThis.__qgVer; });
        obs.r2 = { panel: s.text, request: hit, followUp, opened };
        fs.writeFileSync(path.join(DIR, 'net-log.json'), JSON.stringify(net, null, 2));
        await sleep(300);
        if (await quickVisible(app)) await panelOf(app).keyboard.press('Escape').catch(() => {});
        return `「${s.text}」 · GET ${hit.url} → ${hit.status} tag_name ${hit.tag_name} · ${followUp} → ${opened.at(-1)}`;
      });
    }

    // ================= 退出 / 重新启动 =================
    await step(S, hasPanel ? 'G8 退出：面板「退出」结束应用；重新启动直接回到桌宠' : 'G8 退出（改动前：app.quit）；重新启动直接回到桌宠', async () => {
      chapter('G8 退出与重启');
      await sleep(500);
      const exited = new Promise((r) => app.process().once('exit', (code, sig) => r({ code, sig })));
      if (hasPanel) {
        const p = await petPoint(page);
        await page.mouse.click(p.x, p.y, { button: 'right' });
        await until(async () => (await quickVisible(app)) === 1, 'panel', 6000);
        await grab('g8-before-quit-screen.png');
        await panelOf(app).click('#row-quit').catch(() => {});
      } else {
        await app.evaluate(({ app: a }) => a.quit()).catch(() => {});
      }
      const r = await Promise.race([exited, sleep(12000).then(() => 'still running')]);
      assert.notEqual(r, 'still running');
      await grab('g8-after-quit-screen.png');
      A = await launch(env);
      ({ app, page } = A);
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await sleep(1200);
      await grab('g8-relaunch-screen.png');
      obs.quit = r;
      return `exit ${JSON.stringify(r)} · relaunch → pet screen shown (state kept)`;
    });
    await stopRec();
  } finally {
    if (rec) await stopRec();
    if (A) await A.app.close().catch(() => {});
  }
  fs.writeFileSync(path.join(DIR, 'observations.json'), JSON.stringify(obs, null, 2));
  say(`[${S}] artifacts: ${fs.readdirSync(DIR).sort().join(', ')}`);
};
