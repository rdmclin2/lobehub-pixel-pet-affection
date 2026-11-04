'use strict';
// 快捷调用面板 (T-2849, docs/quick-panel.md) end to end, on the real app under xvfb:
//   右键 / 全局快捷键唤出 → 悬停高亮 / ↑↓ / 打字筛选 → 检查更新（检查中 / 已是最新 / 失败 + 重试 / 发现新版本 + 前往下载页 /
//   下载中 / 已下载 + 立即更新 / 开发版不检查）→ 关闭（Esc / 点面板外 / 执行后 / 再按快捷键）→ 贴边不出屏 → 原有手势不受影响 →
//   每一行真实可用（偏好设置 / 关于 / 和她聊天 / 隐藏与显示桌宠 / 退出）→ 快捷键被占用时的备选与降级。
// The whole display is recorded (ffmpeg x11grab) with chapters, and composite screenshots (pet + panel) are taken
// from the display, so the panel is seen where it really opens. Output: out/e2e/quick/.
//   xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js quickpanel
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

module.exports = ({ ROOT, OUT, FAKE_LH, step, launch, say }) => async function quickPanelScenario() {
  const S = 'quickpanel';
  const DIR = path.join(OUT, 'quick');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const { version } = require('../package.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // the update feed (PIXELPET_UPDATE_FEED): latest / newer (9.9.9) / HTTP 500 / slow
  const feed = { mode: 'latest', delay: 0 };
  const server = http.createServer(async (req, res) => {
    if (req.url !== '/releases/latest') { res.writeHead(404); return res.end(); }
    if (feed.delay) await sleep(feed.delay);
    if (feed.mode === 'error') { res.writeHead(500); return res.end('boom'); }
    const tag = feed.mode === 'newer' ? 'v9.9.9' : `v${version}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases/tag/${tag}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const FEED = `http://127.0.0.1:${server.address().port}`;

  // ---- the display: recording, chapters and composite shots ----
  const display = process.env.DISPLAY;
  let size = '1280x800';
  try { size = /dimensions:\s+(\d+x\d+)/.exec(execFileSync('xdpyinfo', { env: process.env, encoding: 'utf8' }))[1]; } catch { /* default */ }
  const chapters = [];
  let recAt = 0;
  let rec = null;
  const chapter = (title) => { if (rec) chapters.push({ t: (Date.now() - recAt) / 1000, title }); };
  const startRec = (name) => {
    if (!display) return;
    rec = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '12', '-video_size', size, '-i', display, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', path.join(DIR, name)], { stdio: ['pipe', 'ignore', 'pipe'] });
    recAt = Date.now();
  };
  const stopRec = async (name) => {
    if (!rec) return;
    const p = new Promise((r) => rec.on('exit', r));
    rec.stdin.write('q');
    await Promise.race([p, sleep(8000)]);
    rec = null;
    fs.writeFileSync(path.join(DIR, name.replace(/\.mp4$/, '.chapters.json')), JSON.stringify(chapters, null, 2));
  };
  const grab = async (name) => {
    if (!display) return null;
    await sleep(250);
    try {
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', size, '-i', display, '-frames:v', '1', path.join(DIR, name)]);
      return name;
    } catch { return null; }
  };
  const xkey = (keys) => { try { execFileSync('xdotool', ['key', '--clearmodifiers', keys], { env: process.env }); return true; } catch { return false; } };

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-quickfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const start = async (env) => {
    const r = await launch({ PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-quick-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, ...env });
    const { page } = r;
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="grok"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
    await sleep(600);
    return r;
  };
  const state = (page) => page.evaluate(() => window.pet.debugQuick());
  const quickPage = (app) => app.windows().find((w) => w.url().includes('/quick/'));
  const until = async (fn, what, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
      await sleep(80);
    }
  };
  const shown = (page, on = true) => until(async () => (await state(page)).visible === on, on ? 'panel shown' : 'panel hidden');
  const petHit = async (page) => {
    const b = await page.locator('#pet-body .pet-hit:not(.hidden)').first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height * 0.45 };
  };
  const rightClick = async (page) => { const p = await petHit(page); await page.mouse.click(p.x, p.y, { button: 'right' }); await shown(page); await sleep(150); };
  const rowsOf = (q) => q.evaluate(() => [...document.querySelectorAll('#list > *')].filter((el) => !el.classList.contains('none')).map((el) => (el.classList.contains('sep') ? '—' : el.classList.contains('status') ? `[${el.dataset.status}] ${el.innerText.replace(/\s+/g, ' ')}` : `${el.querySelector('.label').textContent}${el.querySelector('.hint').textContent ? ` (${el.querySelector('.hint').textContent})` : ''}`)));
  const statusOf = (q) => q.evaluate(() => { const s = document.querySelector('.status'); return s ? { status: s.dataset.status, tone: s.dataset.tone, text: s.innerText.replace(/\s+/g, ' ').trim() } : null; });
  const waitStatus = (q, st, ms = 10000) => until(async () => { const s = await statusOf(q); return s && s.status === st ? s : null; }, `status ${st}`, ms);
  const inside = (b, a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
  const evidence = [];
  const note = (k, v) => { evidence.push({ k, v }); return v; };

  let A = null;
  try {
    A = await start({ PIXELPET_UPDATE_TEST: '1', PIXELPET_UPDATE_FEED: FEED });
    const { app, page } = A;
    startRec('quick-panel.mp4');
    let q = null;

    await step(S, 'Q1 右键她唤出快捷调用面板：分组、图标、快捷键提示，位置在屏幕内', async () => {
      chapter('右键她唤出面板');
      const p = await petHit(page);
      await page.mouse.click(p.x, p.y, { button: 'right' });
      await shown(page);
      q = quickPage(app);
      await q.waitForSelector('.row');
      await sleep(300);
      const st = await state(page);
      const rows = await rowsOf(q);
      assert.deepEqual(rows.filter((r) => r !== '—').map((r) => r.replace(/ \(.*\)$/, '')), ['关于 Pixel Pet', '检查更新…', '偏好设置…', '和她聊天', '隐藏桌宠', '退出']);
      assert.equal(rows.filter((r) => r === '—').length, 3, 'three separators (four groups)');
      assert.ok(rows.includes('偏好设置… (Ctrl+,)') && rows.includes('退出 (Ctrl+Q)'), rows.join(' | '));
      assert.ok(inside(st.bounds, st.area), JSON.stringify(st));
      assert.equal(await q.evaluate(() => document.activeElement.id), 'q', 'typing goes to the filter');
      assert.equal(st.windows, 1);
      await q.screenshot({ path: path.join(DIR, 'q1-panel.png') });
      await grab('q1-right-click.png');
      note('Q1', { rows, bounds: st.bounds, area: st.area, footer: await q.textContent('#foot') });
      return `${rows.join(' | ')} · bounds ${JSON.stringify(st.bounds)} in ${JSON.stringify(st.area)}`;
    });

    await step(S, 'Q1b 触屏长按她 0.5 秒也唤出面板（合成 touch 指针事件）', async () => {
      chapter('长按唤出');
      await q.keyboard.press('Escape');
      await shown(page, false);
      const n0 = (await state(page)).opens;
      const p = await petHit(page);
      // a touch press held still (Fx.LONG_PRESS): pointer events with pointerType touch, as a touch screen sends them
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y).closest('.pet-hit');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, pointerType: 'touch', button: 0, clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y }));
      }, p);
      await sleep(900);
      await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch', button: 0, clientX: x, clientY: y })), p);
      await shown(page, true);
      const st = await state(page);
      assert.equal(st.opens, n0 + 1);
      assert.ok(inside(st.bounds, st.area));
      await grab('q1b-long-press.png');
      return `long press → panel at ${JSON.stringify(st.bounds)} (opens ${n0} → ${st.opens})`;
    });

    await step(S, 'Q2 悬停高亮：指针所在行填充强调色', async () => {
      chapter('悬停高亮');
      await q.hover('#row-settings');
      await until(() => q.evaluate(() => document.querySelector('#row-settings').classList.contains('active')), 'hover highlight');
      const bg = await q.evaluate(() => getComputedStyle(document.querySelector('#row-settings')).backgroundColor);
      await q.screenshot({ path: path.join(DIR, 'q2-hover.png') });
      await grab('q2-hover-screen.png');
      return `#row-settings.active background ${bg}`;
    });

    await step(S, 'Q3 键盘：↑↓ 移动高亮、打字筛选（更新 / quit）、Esc 先清筛选再关闭', async () => {
      chapter('键盘导航与打字筛选');
      await q.mouse.move(2, 2);
      await q.keyboard.press('ArrowDown');
      await q.keyboard.press('ArrowDown');
      const a1 = await q.evaluate(() => (document.querySelector('.row.active') || {}).id);
      assert.equal(a1, 'row-check-update');
      await q.keyboard.press('ArrowUp');
      assert.equal(await q.evaluate(() => (document.querySelector('.row.active') || {}).id), 'row-about');
      const top0 = (await state(page)).bounds;
      await q.keyboard.type('更新');
      await sleep(150);
      const f1 = await rowsOf(q);
      const top1 = (await state(page)).bounds;
      assert.equal(top1.y, top0.y, `filtering keeps the panel's top edge (${JSON.stringify(top0)} → ${JSON.stringify(top1)})`);
      assert.deepEqual(f1, ['检查更新…'], `typed 「${await q.inputValue('#q')}」, list 「${await q.textContent('#list')}」`);
      assert.equal(await q.evaluate(() => (document.querySelector('.row.active') || {}).id), 'row-check-update', 'the first match is highlighted');
      await q.screenshot({ path: path.join(DIR, 'q3-filter.png') });
      await grab('q3-filter-screen.png');
      await q.fill('#q', 'quit');
      await q.dispatchEvent('#q', 'input');
      const f2 = await rowsOf(q);
      assert.equal(f2.length, 1);
      assert.match(f2[0], /^退出/);
      await q.fill('#q', 'zzz');
      await q.dispatchEvent('#q', 'input');
      const none = await q.textContent('#list');
      assert.match(none, /没有匹配“zzz”的操作/);
      await q.screenshot({ path: path.join(DIR, 'q3-filter-empty.png') });
      await q.keyboard.press('Escape');
      assert.equal(await q.inputValue('#q'), '', 'first Esc clears the filter');
      assert.equal((await state(page)).visible, true);
      await q.keyboard.press('Escape');
      await shown(page, false);
      const st = await state(page);
      assert.equal(st.closes.at(-1), 'esc');
      return `↓↓ → 检查更新… · ↑ → 关于 · 「更新」→ ${f1.join()} · 「quit」→ ${f2.join()} · 「zzz」→ ${none.trim()} · Esc×2 → closed (${st.closes.join(',')})`;
    });

    await step(S, 'Q4 检查更新 → 已是最新版本（显示当前版本），面板保持打开', async () => {
      chapter('检查更新：已是最新');
      feed.mode = 'latest';
      feed.delay = 0;
      await rightClick(page);
      await q.click('#row-check-update');
      const s = await waitStatus(q, 'latest');
      assert.equal(s.text, `已是最新版本 当前版本 v${version}`);
      assert.equal((await state(page)).visible, true, 'the panel stays open for the answer');
      await q.screenshot({ path: path.join(DIR, 'q4-latest.png') });
      await grab('q4-latest-screen.png');
      note('latest', s.text);
      return s.text;
    });

    await step(S, 'Q5 检查中：转圈 + 「正在检查更新…」，随后变为结果', async () => {
      chapter('检查更新：检查中');
      feed.delay = 2500;
      await q.click('#row-check-update');
      const s = await waitStatus(q, 'checking', 3000);
      assert.equal(s.text, `正在检查更新… 当前版本 v${version}`);
      assert.equal(await q.evaluate(() => document.querySelector('#row-check-update .hint').textContent), '检查中');
      assert.ok(await q.evaluate(() => !!document.querySelector('.status .spin')));
      await q.screenshot({ path: path.join(DIR, 'q5-checking.png') });
      await grab('q5-checking-screen.png');
      await waitStatus(q, 'latest', 8000);
      feed.delay = 0;
      note('checking', s.text);
      return `${s.text} → 已是最新版本`;
    });

    await step(S, 'Q6 检查失败：显示原因与「重试」，重试后成功', async () => {
      chapter('检查更新：失败与重试');
      feed.mode = 'error';
      await q.click('#row-check-update');
      const s = await waitStatus(q, 'error');
      assert.equal(s.text, '检查更新失败 更新服务器返回 500');
      assert.match((await rowsOf(q)).join('|'), /重试/);
      await q.screenshot({ path: path.join(DIR, 'q6-error.png') });
      await grab('q6-error-screen.png');
      feed.mode = 'latest';
      // keyboard: the follow-up row is reachable with ↓ and ↩
      await q.mouse.move(2, 2);
      for (let i = 0; i < 3; i++) await q.keyboard.press('ArrowDown');
      const act = await q.evaluate(() => (document.querySelector('.row.active') || {}).id);
      assert.equal(act, 'row-retry');
      await q.keyboard.press('Enter');
      const s2 = await waitStatus(q, 'latest');
      note('error', s.text);
      return `${s.text} · ↓↓↓ → ${act} ↩ → ${s2.text}`;
    });

    await step(S, 'Q7 有新版本（需手动下载）：版本号 + 「前往下载页」，点击后打开发布页并关闭面板', async () => {
      chapter('检查更新：发现新版本 → 前往下载页');
      feed.mode = 'newer';
      await q.click('#row-check-update');
      const s = await waitStatus(q, 'manual');
      assert.equal(s.text, '发现新版本 v9.9.9 这个版本需要到下载页下载安装');
      await q.screenshot({ path: path.join(DIR, 'q7-manual.png') });
      await grab('q7-manual-screen.png');
      await q.click('#row-open-download');
      await shown(page, false);
      const links = await page.evaluate(() => window.pet.debugOpenedLinks());
      assert.ok(links.includes('https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases/tag/v9.9.9'), links.join());
      const st = await state(page);
      assert.equal(st.closes.at(-1), 'run');
      note('manual', s.text);
      return `${s.text} · 前往下载页 → ${links.at(-1)} · closed (${st.closes.at(-1)})`;
    });

    await step(S, 'Q8 下载中 / 已下载：重新打开面板仍能看到，已下载给「立即更新」', async () => {
      chapter('下载中 / 已下载（模拟状态）');
      await page.evaluate(() => window.pet.debugUpdateState({ status: 'downloading', version: '9.9.9', error: null }));
      await rightClick(page);
      const d = await waitStatus(q, 'downloading');
      assert.equal(d.text, '发现新版本 v9.9.9 正在后台下载，下载好后会提示你立即更新');
      await q.screenshot({ path: path.join(DIR, 'q8-downloading.png') });
      await page.evaluate(() => window.pet.debugUpdateState({ status: 'ready', version: '9.9.9' }));
      const r = await waitStatus(q, 'ready');
      assert.equal(r.text, '新版本 v9.9.9 已下载好 立即更新会重启桌宠（约 2 秒），数据都会保留');
      assert.match((await rowsOf(q)).join('|'), /立即更新/);
      await q.screenshot({ path: path.join(DIR, 'q8-ready.png') });
      await grab('q8-ready-screen.png');
      await q.keyboard.press('Escape');
      await shown(page, false);
      await page.evaluate(() => window.pet.debugUpdateState({ status: 'latest', version: null }));
      note('downloading', d.text);
      note('ready', r.text);
      return `${d.text} → ${r.text}`;
    });

    await step(S, 'Q9 面板在结果出来前关闭：她在气泡里说结果', async () => {
      chapter('关闭后由气泡反馈');
      feed.mode = 'latest';
      feed.delay = 1500;
      await rightClick(page);
      await q.click('#row-check-update');
      await waitStatus(q, 'checking', 3000);
      await q.keyboard.press('Escape');
      await shown(page, false);
      await page.waitForFunction(() => /已是最新版本/.test(document.getElementById('bubble').textContent) && !document.getElementById('bubble').classList.contains('hidden'), null, { timeout: 8000 });
      const said = await page.textContent('#bubble');
      feed.delay = 0;
      await grab('q9-bubble-screen.png');
      note('bubble', said);
      return `bubble 「${said}」`;
    }, page);

    await step(S, 'Q10 全局快捷键 Ctrl+Alt+P：唤出（在她旁边），再按一次关闭', async () => {
      chapter('全局快捷键唤出 / 关闭');
      const before = await state(page);
      assert.equal(before.hotkey.state, 'ok');
      assert.equal(before.hotkey.accelerator, 'CommandOrControl+Alt+P');
      assert.equal(before.registered, true);
      let how = 'xdotool key ctrl+alt+p (real X key press)';
      xkey('ctrl+alt+p');
      try { await shown(page, true); } catch {
        how = 'debug-quick-hotkey (xdotool did not reach the global shortcut)';
        await page.evaluate(() => window.pet.debugQuickHotkey());
        await shown(page, true);
      }
      const st = await state(page);
      const pet = await page.evaluate(() => ({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight }));
      assert.ok(inside(st.bounds, st.area));
      assert.ok(st.bounds.x + st.bounds.width <= pet.x + 8, 'opens beside her (left)');
      await grab('q10-hotkey-screen.png');
      // ↑↓ in the panel opened by the shortcut, then Esc; the shortcut again opens it, and once more closes it
      chapter('快捷键唤出后 ↑↓ 导航 → Esc 关闭');
      const qq = quickPage(app);
      for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp']) { await qq.keyboard.press(k); await sleep(250); }
      const nav = await qq.evaluate(() => (document.querySelector('.row.active') || {}).id);
      assert.equal(nav, 'row-check-update');
      await qq.keyboard.press('Escape');
      await shown(page, false);
      assert.equal((await state(page)).closes.at(-1), 'esc');
      chapter('再按快捷键唤出 → 再按一次关闭');
      if (how.startsWith('xdotool')) xkey('ctrl+alt+p');
      else await page.evaluate(() => window.pet.debugQuickHotkey());
      await shown(page, true);
      await sleep(500);
      if (how.startsWith('xdotool')) xkey('ctrl+alt+p');
      else await page.evaluate(() => window.pet.debugQuickHotkey());
      await shown(page, false);
      const after = await state(page);
      assert.equal(after.closes.at(-1), 'hotkey');
      return `${how} · ↓↓↓↑ → ${nav} · Esc → closed · opened at ${JSON.stringify(st.bounds)} beside pet ${JSON.stringify(pet)} · second press → closed (${after.closes.at(-1)}) · triggers ${after.hotkey.triggers}`;
    });

    await step(S, 'Q11 点击面板外关闭：点桌宠窗口（真实 X 点击）/ 焦点移到别的窗口（blur）', async () => {
      chapter('点击面板外关闭');
      await rightClick(page);
      // a real X click on her window, away from the panel (xdotool: no Playwright event injection)
      // her window's lower right corner: the panel opened left of the click and does not cover it
      const pet = await page.evaluate(() => ({ x: window.screenX + window.outerWidth - 12, y: window.screenY + window.outerHeight - 12 }));
      execFileSync('xdotool', ['mousemove', String(pet.x), String(pet.y), 'click', '1'], { env: process.env });
      await shown(page, false);
      const st1 = await state(page);
      assert.equal(st1.closes.at(-1), 'outside');
      // another window takes the focus (what a window manager does on a click in another app): blur closes it.
      // xvfb runs no window manager, so the focus change is made directly.
      await rightClick(page);
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('/quick/') && !x.webContents.getURL().includes('admin-ui')); w.focus(); });
      await shown(page, false);
      const st2 = await state(page);
      assert.equal(st2.closes.at(-1), 'blur');
      return `xdotool click at her window (${pet.x},${pet.y}) → closed (${st1.closes.at(-1)}) · focus to another window → closed (${st2.closes.at(-1)})`;
    });

    await step(S, 'Q12 重复唤出 / 关闭 10 次：始终只有一个面板窗口、位置一致、无残留', async () => {
      chapter('重复唤出 / 关闭');
      const seen = new Set();
      for (let i = 0; i < 10; i++) {
        await page.evaluate(() => window.pet.debugQuickHotkey());
        await shown(page, true);
        seen.add(JSON.stringify((await state(page)).bounds));
        await page.evaluate(() => window.pet.debugQuickHotkey());
        await shown(page, false);
      }
      const st = await state(page);
      assert.equal(st.windows, 1);
      assert.equal(seen.size, 1, [...seen].join(' / '));
      assert.equal((await quickPage(app).evaluate(() => document.querySelectorAll('.status').length)), 0, 'no stale update block');
      return `windows ${st.windows} · bounds ${[...seen][0]} every time · opens ${st.opens}`;
    });

    await step(S, 'Q13 桌宠贴边（右下角 / 左上角 / 半出屏）时面板完整可见', async () => {
      chapter('贴边时的位置');
      const out = [];
      for (const [name, pos] of [['bottom-right', 'br'], ['top-left', 'tl'], ['half-off-right', 'off']]) {
        await app.evaluate(({ BrowserWindow, screen }, p) => {
          const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('/quick/') && !x.webContents.getURL().includes('admin-ui'));
          const a = screen.getPrimaryDisplay().workArea;
          const b = w.getBounds();
          const xy = p === 'br' ? [a.x + a.width - b.width, a.y + a.height - b.height] : p === 'tl' ? [a.x, a.y] : [a.x + a.width - Math.round(b.width / 2), a.y + 200];
          w.setPosition(xy[0], xy[1]);
        }, pos);
        await sleep(300);
        const p = await petHit(page);
        await page.mouse.click(Math.min(p.x + 60, 220), p.y + 80, { button: 'right' });
        await shown(page);
        const st = await state(page);
        assert.ok(inside(st.bounds, st.area), `${name}: ${JSON.stringify(st.bounds)} not in ${JSON.stringify(st.area)}`);
        out.push(`${name}: anchor ${JSON.stringify(st.anchor)} → ${JSON.stringify(st.bounds)}`);
        await grab(`q13-edge-${name}.png`);
        await quickPage(app).keyboard.press('Escape');
        await shown(page, false);
      }
      await page.evaluate(() => window.pet.place('pet'));
      await sleep(300);
      return out.join(' · ');
    });

    await step(S, 'Q14 原有手势不受影响：左键点她不会唤出面板，拖动她窗口跟着移动', async () => {
      chapter('原有手势：点击 / 拖动');
      const st0 = await state(page);
      const p = await petHit(page);
      await page.mouse.click(p.x, p.y);
      await sleep(400);
      const st1 = await state(page);
      assert.equal(st1.opens, st0.opens, 'a left click does not open the panel');
      assert.equal(st1.visible, false);
      const b0 = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(p.x - i * 6, p.y - i * 4); await sleep(30); }
      await page.mouse.up();
      await sleep(400);
      const b1 = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
      assert.ok(b1.x !== b0.x || b1.y !== b0.y, `moved ${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
      await page.evaluate(() => window.pet.place('pet'));
      return `left click: opens ${st0.opens} → ${st1.opens} · drag: ${JSON.stringify(b0)} → ${JSON.stringify(b1)}`;
    });

    await step(S, 'Q15 每一行真实可用：偏好设置… / 关于 / 和她聊天 / 隐藏桌宠 → 显示桌宠', async () => {
      chapter('偏好设置 / 关于 / 聊天 / 隐藏与显示');
      await sleep(300);
      await rightClick(page);
      await quickPage(app).click('#row-settings');
      await shown(page, false);
      const admin = await until(async () => app.windows().find((w) => w.url().includes('admin-ui')), 'settings window');
      await admin.waitForSelector('[data-path]', { timeout: 15000 });
      const adminPath = await admin.evaluate(() => location.hash);
      await rightClick(page);
      await quickPage(app).click('#row-about');
      await shown(page, false);
      await admin.waitForSelector('[data-path="/update"]', { timeout: 15000 });
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')); w.hide(); });
      await rightClick(page);
      await quickPage(app).click('#row-chat');
      await shown(page, false);
      await page.waitForSelector('#chat-row:not(.hidden)', { timeout: 5000 });
      const chatFocused = await page.evaluate(() => document.activeElement.id);
      await grab('q15-chat-screen.png');
      await page.evaluate(() => document.getElementById('chat-row').classList.add('hidden'));
      await rightClick(page);
      await quickPage(app).click('#row-hide-pet');
      await shown(page, false);
      const hidden = (await state(page)).petVisible;
      await page.evaluate(() => window.pet.debugQuickHotkey());
      await shown(page, true);
      const rows = await rowsOf(quickPage(app));
      assert.ok(rows.includes('显示桌宠') && !rows.includes('和她聊天'), rows.join('|'));
      await grab('q15-hidden-pet-panel.png');
      await quickPage(app).click('#row-show-pet');
      await shown(page, false);
      const back = (await state(page)).petVisible;
      assert.equal(hidden, false);
      assert.equal(back, true);
      assert.equal(chatFocused, 'chat-input');
      return `偏好设置… → settings window ${adminPath || '#/'} · 关于 → #/update · 和她聊天 → #chat-row open, focus ${chatFocused} · 隐藏桌宠 → visible ${hidden}, panel then lists ${rows.filter((r) => r !== '—').join('/')} · 显示桌宠 → visible ${back}`;
    });

    await step(S, 'Q16 暗色外观：面板跟随系统', async () => {
      chapter('暗色外观');
      await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
      await sleep(300);
      await rightClick(page);
      await quickPage(app).hover('#row-check-update');
      await sleep(200);
      await quickPage(app).screenshot({ path: path.join(DIR, 'q16-dark.png') });
      await grab('q16-dark-screen.png');
      const bg = await quickPage(app).evaluate(() => getComputedStyle(document.getElementById('menu')).backgroundColor);
      await quickPage(app).keyboard.press('Escape');
      await shown(page, false);
      await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
      return `menu background ${bg}`;
    });

    await step(S, 'Q17 退出：面板里的「退出」结束应用', async () => {
      chapter('退出');
      await rightClick(page);
      await grab('q17-before-quit.png');
      const exited = new Promise((r) => app.process().once('exit', (code) => r(code)));
      await quickPage(app).click('#row-quit').catch(() => {});
      const code = await Promise.race([exited, sleep(10000).then(() => 'still running')]);
      assert.notEqual(code, 'still running');
      A = null;
      return `app exited (code ${code})`;
    });
    await stopRec('quick-panel.mp4');
  } finally {
    if (rec) await stopRec('quick-panel.mp4');
    if (A) await A.app.close().catch(() => {});
  }

  // ---- 开发版 (updater disabled): a clear answer, not silence ----
  let B = null;
  try {
    B = await start({});
    const { app, page } = B;
    await step(S, 'Q18 开发态 updater disabled：检查更新给出明确提示', async () => {
      const p = await petHit(page);
      await page.mouse.click(p.x, p.y, { button: 'right' });
      await shown(page);
      const q = quickPage(app);
      await q.click('#row-check-update');
      const s = await waitStatus(q, 'disabled');
      assert.equal(s.text, `当前版本不检查更新 开发版（从源码运行）或已关闭更新时不会检查；当前版本 v${version}`);
      await q.screenshot({ path: path.join(DIR, 'q18-disabled.png') });
      await grab('q18-disabled-screen.png');
      note('disabled', s.text);
      return s.text;
    });
  } finally {
    if (B) await B.app.close().catch(() => {});
  }

  // ---- the shortcut taken by another app: the fallback; both taken: no shortcut, nothing breaks ----
  for (const [name, taken] of [['fallback', 'CommandOrControl+Alt+P'], ['none', 'CommandOrControl+Alt+P,CommandOrControl+Alt+Shift+P']]) {
    let C = null;
    try {
      C = await start({ PIXELPET_E2E_TAKEN_HOTKEYS: taken });
      const { app, page } = C;
      await step(S, `Q19 快捷键被占用（${name === 'fallback' ? '首选被占 → 备选' : '全部被占 → 降级'}）：应用不崩溃，右键仍可唤出`, async () => {
        const st = await state(page);
        const p = await petHit(page);
        await page.mouse.click(p.x, p.y, { button: 'right' });
        await shown(page);
        const foot = await quickPage(app).textContent('#foot');
        await quickPage(app).screenshot({ path: path.join(DIR, `q19-hotkey-${name}.png`) });
        if (name === 'fallback') {
          assert.equal(st.hotkey.state, 'ok');
          assert.equal(st.hotkey.accelerator, 'CommandOrControl+Alt+Shift+P');
          assert.match(foot, /^Ctrl\+Alt\+Shift\+P 唤出/);
        } else {
          assert.equal(st.hotkey.state, 'conflict');
          assert.match(foot, /^快捷键被占用，右键她也能打开/);
        }
        return `hotkey ${JSON.stringify({ state: st.hotkey.state, accelerator: st.hotkey.accelerator, tried: st.hotkey.tried.map((t) => `${t.accelerator}:${t.reason}`) })} · footer 「${foot}」`;
      });
    } finally {
      if (C) await C.app.close().catch(() => {});
    }
  }
  server.close();
  fs.writeFileSync(path.join(DIR, 'evidence.json'), JSON.stringify(evidence, null, 2));
  say(`[quickpanel] artifacts in ${DIR}`);
};
