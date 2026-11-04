'use strict';
// 快捷调用面板验收场景 (T-2852): an independent end-to-end check of the panel T-2849 built (docs/quick-panel.md),
// written against the Goal's four requirements rather than the implementation's own walk (scenario quickpanel):
//   A  唤出 / 关闭    right click, touch long press, the global shortcut (a real X key press); Esc, a click outside,
//                    the shortcut again; 10 open / close cycles (alternating ways) with one window and the app alive
//   B  列表交互      typing filters (中文 / English / no match), ↑↓ + ↩ runs the highlighted row, hover highlights
//   C  检查更新      有新版本 / 已是最新 / 检查失败 (HTTP 500, unreachable) / updater disabled — each one shown in the panel
//                    and captured (panel page + the whole display)
//   D  不破坏原有    a left click on her does not open it, dragging still moves her, ⚙ still opens settings directly
// Update states come from a local stub feed (PIXELPET_UPDATE_TEST=1 + PIXELPET_UPDATE_FEED); disabled is the default
// of a run from source, and PIXELPET_NO_UPDATE=1. The display is recorded with chapters.
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js quick-actions
// Output: out/e2e/quick-actions/ (screenshots, quick-actions.mp4 + chapters, observations.json).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

module.exports = ({ OUT, FAKE_LH, step, launch, say }) => async function quickActionsScenario() {
  const S = 'quick-actions';
  const DIR = path.join(OUT, 'quick-actions');
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const { version } = require('../package.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Electron started with ELECTRON_RUN_AS_NODE set runs as plain node and Playwright cannot attach: drop it.
  say(`[${S}] ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE === undefined ? '(unset)' : JSON.stringify(process.env.ELECTRON_RUN_AS_NODE)} → removed before launch`);
  delete process.env.ELECTRON_RUN_AS_NODE;

  // stub update feed: GET /releases/latest (what the Linux updater asks, src/main/updater.js _checkOther)
  const feed = { mode: 'latest', hits: 0 };
  const server = http.createServer((req, res) => {
    if (req.url !== '/releases/latest') { res.writeHead(404); return res.end(); }
    feed.hits += 1;
    if (feed.mode === 'error') { res.writeHead(500); return res.end('stub failure'); }
    const tag = feed.mode === 'newer' ? 'v9.9.9' : `v${version}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases/tag/${tag}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const FEED = `http://127.0.0.1:${server.address().port}`;
  say(`[${S}] stub update feed ${FEED}/releases/latest · app version v${version}`);

  // ---- display recording, chapters, whole-display shots ----
  const display = process.env.DISPLAY;
  let size = '1280x800';
  try { size = /dimensions:\s+(\d+x\d+)/.exec(execFileSync('xdpyinfo', { encoding: 'utf8' }))[1]; } catch { /* default */ }
  const chapters = [];
  let rec = null;
  let recAt = 0;
  const chapter = (title) => { if (rec) chapters.push({ t: Math.round((Date.now() - recAt) / 100) / 10, title }); };
  const startRec = () => {
    if (!display) return;
    rec = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '12', '-video_size', size, '-i', display, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', path.join(DIR, 'quick-actions.mp4')], { stdio: ['pipe', 'ignore', 'pipe'] });
    recAt = Date.now();
  };
  const stopRec = async () => {
    if (!rec) return;
    const done = new Promise((r) => rec.on('exit', r));
    rec.stdin.write('q');
    await Promise.race([done, sleep(8000)]);
    rec = null;
    fs.writeFileSync(path.join(DIR, 'quick-actions.chapters.json'), JSON.stringify(chapters, null, 2));
  };
  const grab = async (name) => {
    if (!display) return null;
    await sleep(250);
    try { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', size, '-i', display, '-frames:v', '1', path.join(DIR, name)]); return name; } catch { return null; }
  };
  const xdo = (...a) => execFileSync('xdotool', a, { env: process.env });

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-qa-fake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const start = async (env) => {
    const r = await launch({ PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-qa-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, ...env });
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

  const st = (page) => page.evaluate(() => window.pet.debugQuick());
  const panelOf = (app) => app.windows().find((w) => w.url().includes('/quick/'));
  const until = async (fn, what, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn().catch(() => null);
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await sleep(80);
    }
  };
  const visible = (page, on = true) => until(async () => (await st(page)).visible === on, on ? 'panel visible' : 'panel hidden');
  const petPoint = async (page) => {
    const b = await page.locator('#pet-body .pet-hit:not(.hidden)').first().boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height * 0.45 };
  };
  const rightClick = async (page) => { const p = await petPoint(page); await page.mouse.click(p.x, p.y, { button: 'right' }); await visible(page); await sleep(200); };
  const labels = (q) => q.evaluate(() => [...document.querySelectorAll('#list .row .label')].map((e) => e.textContent));
  const activeId = (q) => q.evaluate(() => (document.querySelector('.row.active') || {}).id || null);
  const status = (q) => q.evaluate(() => { const s = document.querySelector('.status'); return s ? { status: s.dataset.status, tone: s.dataset.tone, text: s.innerText.replace(/\s+/g, ' ').trim() } : null; });
  const waitStatus = (q, want, ms = 10000) => until(async () => { const s = await status(q); return s && s.status === want ? s : null; }, `update status ${want}`, ms);
  const inArea = (b, a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
  // the global shortcut as a real X key press; when xdotool cannot reach the grab, the same trigger via the test hook
  let hotkeyHow = 'xdotool key ctrl+alt+p';
  const pressHotkey = async (page) => {
    if (hotkeyHow.startsWith('xdotool')) { try { xdo('key', '--clearmodifiers', 'ctrl+alt+p'); return; } catch { hotkeyHow = 'debugQuickHotkey()'; } }
    await page.evaluate(() => window.pet.debugQuickHotkey());
  };
  const obs = {};
  const shot = async (q, name) => { await sleep(150); await q.screenshot({ path: path.join(DIR, `${name}.png`) }); await grab(`${name}-screen.png`); };

  let A = null;
  try {
    A = await start({ PIXELPET_UPDATE_TEST: '1', PIXELPET_UPDATE_FEED: FEED });
    const { app, page } = A;
    startRec();

    // ================= A 唤出 / 关闭 =================
    await step(S, 'A1 右键桌宠唤出面板：含「检查更新…」，完整位于屏幕内', async () => {
      chapter('A1 右键唤出');
      await rightClick(page);
      const q = panelOf(app);
      await q.waitForSelector('.row');
      const s = await st(page);
      const l = await labels(q);
      assert.ok(l.includes('检查更新…'), l.join('|'));
      assert.ok(inArea(s.bounds, s.area), `${JSON.stringify(s.bounds)} not inside ${JSON.stringify(s.area)}`);
      assert.equal(s.windows, 1);
      await shot(q, 'a1-right-click');
      obs.rows = l;
      return `rows ${l.join(' | ')} · bounds ${JSON.stringify(s.bounds)} in workArea ${JSON.stringify(s.area)}`;
    });

    await step(S, 'A2 Esc 关闭面板', async () => {
      chapter('A2 Esc 关闭');
      await panelOf(app).keyboard.press('Escape');
      await visible(page, false);
      const s = await st(page);
      assert.equal(s.closes.at(-1), 'esc');
      return `visible ${s.visible} · close reason ${s.closes.at(-1)}`;
    });

    await step(S, 'A3 触屏长按桌宠 0.9 秒唤出面板', async () => {
      chapter('A3 长按唤出');
      const n0 = (await st(page)).opens;
      const p = await petPoint(page);
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y).closest('.pet-hit');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, pointerType: 'touch', button: 0, clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y }));
      }, p);
      await sleep(900);
      await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11, pointerType: 'touch', button: 0, clientX: x, clientY: y })), p);
      await visible(page, true);
      const s = await st(page);
      assert.equal(s.opens, n0 + 1);
      await grab('a3-long-press-screen.png');
      await panelOf(app).keyboard.press('Escape');
      await visible(page, false);
      return `opens ${n0} → ${s.opens} · bounds ${JSON.stringify(s.bounds)}`;
    });

    await step(S, 'A4 点击面板外部（真实 X 鼠标点击她的窗口）关闭面板', async () => {
      chapter('A4 点外部关闭');
      await rightClick(page);
      const s0 = await st(page);
      // a spot of her window the panel does not cover
      const pt = await page.evaluate(() => ({ x: window.screenX + window.outerWidth - 10, y: window.screenY + window.outerHeight - 10 }));
      const b = s0.bounds;
      assert.ok(!(pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height), 'click point must be outside the panel');
      xdo('mousemove', String(pt.x), String(pt.y), 'click', '1');
      await visible(page, false);
      const s = await st(page);
      assert.ok(['outside', 'blur'].includes(s.closes.at(-1)), s.closes.join(','));
      return `xdotool click at (${pt.x},${pt.y}), panel at ${JSON.stringify(b)} → hidden · reason ${s.closes.at(-1)}`;
    });

    await step(S, 'A5 键盘快捷键 Ctrl+Alt+P 唤出（真实按键），再按一次关闭', async () => {
      chapter('A5 快捷键唤出 / 再按关闭');
      const s0 = await st(page);
      assert.equal(s0.hotkey.state, 'ok');
      assert.equal(s0.hotkey.accelerator, 'CommandOrControl+Alt+P');
      assert.equal(s0.registered, true, 'globalShortcut registered');
      await pressHotkey(page);
      try { await visible(page, true); } catch {
        hotkeyHow = 'debugQuickHotkey()';
        await pressHotkey(page);
        await visible(page, true);
      }
      const s1 = await st(page);
      assert.ok(inArea(s1.bounds, s1.area));
      await shot(panelOf(app), 'a5-hotkey-open');
      await sleep(400);
      await pressHotkey(page);
      await visible(page, false);
      const s2 = await st(page);
      assert.equal(s2.closes.at(-1), 'hotkey');
      obs.hotkeyHow = hotkeyHow;
      return `${hotkeyHow} → visible (bounds ${JSON.stringify(s1.bounds)}) · again → hidden (reason ${s2.closes.at(-1)}) · triggers ${s2.hotkey.triggers}`;
    });

    await step(S, 'A6 连续开关 10 次（快捷键 / 右键 / Esc / 点外部 交替）：每次状态正确，只有一个面板窗口，应用存活', async () => {
      chapter('A6 连续开关 10 次');
      const log = [];
      const ways = [
        ['hotkey', 'hotkey'], ['right-click', 'esc'], ['hotkey', 'esc'], ['right-click', 'outside'], ['hotkey', 'hotkey'],
        ['right-click', 'hotkey'], ['hotkey', 'outside'], ['right-click', 'esc'], ['hotkey', 'hotkey'], ['right-click', 'esc'],
      ];
      const o0 = (await st(page)).opens;
      for (let i = 0; i < ways.length; i++) {
        const [how, close] = ways[i];
        if (how === 'hotkey') await pressHotkey(page); else { const p = await petPoint(page); await page.mouse.click(p.x, p.y, { button: 'right' }); }
        await visible(page, true);
        await sleep(250);
        const on = await st(page);
        assert.equal(on.windows, 1, `cycle ${i + 1}: one panel window`);
        if (close === 'esc') await panelOf(app).keyboard.press('Escape');
        else if (close === 'hotkey') await pressHotkey(page);
        else { const pt = await page.evaluate(() => ({ x: window.screenX + window.outerWidth - 10, y: window.screenY + window.outerHeight - 10 })); xdo('mousemove', String(pt.x), String(pt.y), 'click', '1'); }
        await visible(page, false);
        const off = await st(page);
        log.push(`${i + 1}:${how}→${off.closes.at(-1)}`);
        await sleep(150);
      }
      const s = await st(page);
      assert.equal(s.opens - o0, 10);
      assert.equal(s.windows, 1);
      assert.equal(app.process().exitCode, null, 'app still running');
      await page.evaluate(() => 1); // pet renderer still answers
      obs.cycles = log;
      return `${log.join(' ')} · opens +${s.opens - o0} · panel windows ${s.windows} · app alive`;
    });

    // ================= B 列表交互 =================
    await step(S, 'B1 悬浮高亮：指针所在行填充强调色，离开后取消', async () => {
      chapter('B1 悬浮高亮');
      await rightClick(page);
      const q = panelOf(app);
      await q.hover('#row-settings');
      await until(() => q.evaluate(() => document.querySelector('#row-settings').classList.contains('active')), 'hover → active');
      const css = await q.evaluate(() => {
        const row = getComputedStyle(document.querySelector('#row-settings'));
        const probe = document.createElement('div');
        probe.style.background = 'var(--lobe-color-info)';
        document.body.appendChild(probe);
        const info = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const other = getComputedStyle(document.querySelector('#row-quit')).backgroundColor;
        return { row: row.backgroundColor, color: row.color, info, other };
      });
      assert.equal(css.row, css.info, 'hovered row uses --lobe-color-info');
      assert.notEqual(css.other, css.row, 'other rows are not filled');
      assert.equal(css.color, 'rgb(255, 255, 255)', 'light text on the accent');
      await shot(q, 'b1-hover');
      await q.hover('#row-quit');
      await until(() => q.evaluate(() => document.querySelector('#row-quit').classList.contains('active') && !document.querySelector('#row-settings').classList.contains('active')), 'highlight follows the pointer');
      return `#row-settings hovered: bg ${css.row} (= --lobe-color-info ${css.info}), text ${css.color}; other row bg ${css.other}; pointer → 退出 moves the highlight`;
    });

    await step(S, 'B2 搜索过滤：「更新」「设置」「quit」只剩匹配项，「zzz」显示无结果', async () => {
      chapter('B2 搜索过滤');
      const q = panelOf(app);
      await q.mouse.move(1, 1);
      const out = [];
      for (const [kw, want] of [['更新', ['检查更新…']], ['设置', ['偏好设置…']], ['quit', ['退出']]]) {
        await q.fill('#q', '');
        await q.keyboard.type(kw);
        await sleep(150);
        const l = await labels(q);
        assert.deepEqual(l, want, `「${kw}」 → ${l.join('|')}`);
        assert.equal(await activeId(q), `row-${{ 更新: 'check-update', 设置: 'settings', quit: 'quit' }[kw]}`, 'first match highlighted');
        out.push(`「${kw}」→ ${l.join(',')}`);
        if (kw === '更新') await shot(q, 'b2-filter-update');
      }
      await q.fill('#q', '');
      await q.keyboard.type('zzz');
      await sleep(150);
      const none = (await q.textContent('#list')).trim();
      assert.equal(none, '没有匹配“zzz”的操作');
      assert.deepEqual(await labels(q), []);
      await shot(q, 'b2-filter-none');
      out.push(`「zzz」→ ${none}`);
      await q.keyboard.press('Escape');
      assert.equal(await q.inputValue('#q'), '', 'first Esc clears the filter');
      assert.equal((await labels(q)).length, obs.rows.length, 'all rows back');
      assert.equal((await st(page)).visible, true, 'panel still open after the first Esc');
      out.push('Esc → filter cleared, panel open');
      return out.join(' · ');
    });

    await step(S, 'B3 ↑↓ 移动选中项（跳过分隔线），↩ 执行：↓↓↓ → 偏好设置… ↩ 打开设置窗口并关闭面板', async () => {
      chapter('B3 上下键 + 回车执行');
      const q = panelOf(app);
      await q.mouse.move(1, 1);
      const path_ = [];
      for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowDown']) { await q.keyboard.press(k); path_.push(`${k === 'ArrowDown' ? '↓' : '↑'}${(await activeId(q)).replace('row-', '')}`); }
      assert.deepEqual(path_, ['↓about', '↓check-update', '↓settings', '↑check-update', '↓settings']);
      await shot(q, 'b3-keyboard-settings');
      await q.keyboard.press('Enter');
      await visible(page, false);
      const admin = await until(async () => app.windows().find((w) => w.url().includes('admin-ui')), 'settings window', 20000);
      await admin.waitForSelector('[data-path]', { timeout: 20000 });
      const s = await st(page);
      assert.equal(s.ran.at(-1), 'settings');
      assert.equal(s.closes.at(-1), 'run');
      await grab('b3-enter-settings-screen.png');
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')); if (w) w.hide(); });
      return `${path_.join(' ')} · ↩ → ran ${s.ran.at(-1)}, panel closed (${s.closes.at(-1)}), settings window ${admin.url().replace(/^.*admin-ui/, 'admin-ui')}`;
    });

    await step(S, 'B4 暗色外观（与 LobeHub macOS 菜单参考图对照）：暗底、强调色高亮「检查更新…」、分组细线、右侧快捷键', async () => {
      chapter('B4 暗色外观');
      await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
      await sleep(300);
      await rightClick(page);
      const q = panelOf(app);
      await q.hover('#row-check-update');
      await until(() => q.evaluate(() => document.querySelector('#row-check-update').classList.contains('active')), 'hover → active');
      const c = await q.evaluate(() => ({ menu: getComputedStyle(document.getElementById('menu')).backgroundColor, row: getComputedStyle(document.querySelector('#row-check-update')).backgroundColor, rowText: getComputedStyle(document.querySelector('#row-check-update')).color, text: getComputedStyle(document.querySelector('#row-about')).color, seps: document.querySelectorAll('.sep').length }));
      // WCAG relative luminance / contrast
      const lum = (rgb) => { const unit = /^color\(srgb/.test(rgb) ? 1 : 255; const [r, g, b] = rgb.replace(/^color\(srgb/, '').match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= unit; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
      assert.ok(lum(c.menu) < 0.05, `dark menu background ${c.menu}`);
      assert.ok(lum(c.text) > 0.6, `light text ${c.text}`);
      assert.ok(lum(c.rowText) > 0.6, `highlighted row keeps light text like the reference (${c.rowText})`);
      const cr = contrast(c.row, c.rowText);
      assert.ok(cr >= 4.5, `highlighted row text contrast ${cr.toFixed(2)} ≥ 4.5`);
      c.contrast = cr.toFixed(2);
      assert.equal(c.seps, 3);
      await shot(q, 'b4-dark-hover-check-update');
      await q.keyboard.press('Escape');
      await visible(page, false);
      await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });
      return `menu bg ${c.menu} · row text ${c.text} · hovered 检查更新… bg ${c.row}, text ${c.rowText}, contrast ${c.contrast}:1 · separators ${c.seps}`;
    });

    // ================= C 检查更新 =================
    await step(S, 'C1 检查更新（键盘 ↓↓ ↩ 执行）→ 已是最新版本', async () => {
      chapter('C1 已是最新');
      feed.mode = 'latest';
      const h0 = feed.hits;
      await rightClick(page);
      const q = panelOf(app);
      await q.mouse.move(1, 1);
      await q.keyboard.press('ArrowDown');
      await q.keyboard.press('ArrowDown');
      assert.equal(await activeId(q), 'row-check-update');
      await q.keyboard.press('Enter');
      const s = await waitStatus(q, 'latest');
      assert.equal(s.text, `已是最新版本 当前版本 v${version}`);
      assert.equal(s.tone, 'success');
      assert.ok(feed.hits > h0, 'the stub feed was really asked');
      assert.equal((await st(page)).visible, true, 'panel stays open with the answer');
      await shot(q, 'c1-latest');
      obs.latest = s.text;
      return `「${s.text}」 tone ${s.tone} · feed hits ${h0} → ${feed.hits}`;
    });

    await step(S, 'C2 检查失败（桩更新源返回 HTTP 500）→ 显示原因与「重试」', async () => {
      chapter('C2 检查失败 500');
      feed.mode = 'error';
      const q = panelOf(app);
      await q.click('#row-check-update');
      const s = await waitStatus(q, 'error');
      assert.equal(s.text, '检查更新失败 更新服务器返回 500');
      assert.ok((await labels(q)).includes('重试'));
      await shot(q, 'c2-error-500');
      obs.error500 = s.text;
      // 重试 with the feed healthy again
      feed.mode = 'latest';
      await q.click('#row-retry');
      const s2 = await waitStatus(q, 'latest');
      return `「${s.text}」 + 重试 row · 重试 (feed ok) → 「${s2.text}」`;
    });

    await step(S, 'C3 有新版本（桩更新源返回 v9.9.9）→ 版本号与「前往下载页」，点击打开发布页', async () => {
      chapter('C3 有新版本');
      feed.mode = 'newer';
      const q = panelOf(app);
      await q.click('#row-check-update');
      const s = await waitStatus(q, 'manual');
      assert.equal(s.text, '发现新版本 v9.9.9 这个版本需要到下载页下载安装');
      assert.ok((await labels(q)).includes('前往下载页'));
      await shot(q, 'c3-newer');
      obs.newer = s.text;
      await q.click('#row-open-download');
      await visible(page, false);
      const links = await page.evaluate(() => window.pet.debugOpenedLinks());
      assert.ok(links.includes('https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases/tag/v9.9.9'), links.join());
      return `「${s.text}」 · 前往下载页 → ${links.at(-1)}`;
    });

    await step(S, 'C3b 有新版本已下载（Windows / macOS 路径，状态注入）→「立即更新」', async () => {
      chapter('C3b 新版本已下载');
      await page.evaluate(() => window.pet.debugUpdateState({ status: 'ready', version: '9.9.9', error: null }));
      await rightClick(page);
      const q = panelOf(app);
      const s = await waitStatus(q, 'ready');
      assert.equal(s.text, '新版本 v9.9.9 已下载好 立即更新会重启桌宠（约 2 秒），数据都会保留');
      assert.ok((await labels(q)).includes('立即更新'));
      await shot(q, 'c3b-ready');
      await q.keyboard.press('Escape');
      await visible(page, false);
      await page.evaluate(() => window.pet.debugUpdateState({ status: 'latest', version: null }));
      obs.ready = s.text;
      return `「${s.text}」 + 立即更新 row`;
    });

    await step(S, 'C4 检查失败（更新源不可达：连接被拒绝）→ 网络提示', async () => {
      chapter('C4 检查失败 网络');
      // an unreachable feed: stop the stub, the next request gets ECONNREFUSED
      await new Promise((r) => server.close(r));
      server.closeAllConnections && server.closeAllConnections();
      await rightClick(page);
      const q = panelOf(app);
      await q.click('#row-check-update');
      const s = await waitStatus(q, 'error', 15000);
      assert.match(s.text, /^检查更新失败 /);
      assert.ok((await labels(q)).includes('重试'));
      await shot(q, 'c4-error-network');
      await q.keyboard.press('Escape');
      await visible(page, false);
      obs.errorNetwork = s.text;
      return `「${s.text}」`;
    });

    // ================= D 原有功能 =================
    await step(S, 'D1 原有交互未破坏：左键点她不唤出面板、拖动她窗口跟着移动、⚙ 仍直接打开设置窗口', async () => {
      chapter('D1 原有交互');
      const s0 = await st(page);
      const p = await petPoint(page);
      await page.mouse.click(p.x, p.y);
      await sleep(500);
      const s1 = await st(page);
      assert.equal(s1.opens, s0.opens, 'left click does not open the panel');
      const b0 = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) { await page.mouse.move(p.x - i * 6, p.y - i * 4); await sleep(30); }
      await page.mouse.up();
      await sleep(400);
      const b1 = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
      assert.ok(b1.x !== b0.x || b1.y !== b0.y, `drag moved ${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
      await page.evaluate(() => window.pet.place('pet'));
      await sleep(300);
      await page.mouse.move(110, 150);
      await page.waitForSelector('body.hover', { timeout: 5000 });
      const gear = page.locator('#btn-settings');
      const tip = await gear.getAttribute('title');
      assert.equal(tip, '设置（Ctrl/⌘ + ,）；右键或长按她打开快捷调用面板', 'the ⚙ tooltip no longer says a right click opens settings');
      await gear.click();
      const admin = await until(async () => { const w = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((x) => x.webContents.getURL().includes('admin-ui') && x.isVisible())); return w; }, 'settings window visible', 15000);
      const s2 = await st(page);
      assert.equal(s2.opens, s0.opens, '⚙ does not go through the panel');
      await grab('d1-gear-settings-screen.png');
      return `left click: opens ${s0.opens} → ${s1.opens} · drag ${JSON.stringify(b0)} → ${JSON.stringify(b1)} · ⚙ → settings window visible ${admin}, panel opens unchanged ${s2.opens}`;
    });
    await stopRec();
  } finally {
    if (rec) await stopRec();
    if (A) await A.app.close().catch(() => {});
    if (server.listening) server.close();
  }

  // ================= C5 updater disabled =================
  for (const [name, env, why] of [['source', {}, '从源码运行（未设 PIXELPET_UPDATE_TEST）'], ['no-update', { PIXELPET_UPDATE_TEST: '1', PIXELPET_NO_UPDATE: '1' }, 'PIXELPET_NO_UPDATE=1']]) {
    let B = null;
    try {
      B = await start(env);
      const { app, page } = B;
      await step(S, `C5 updater 不可用（${why}）→ 面板明确提示不检查更新`, async () => {
        const p = await petPoint(page);
        await page.mouse.click(p.x, p.y, { button: 'right' });
        await visible(page);
        const q = panelOf(app);
        await q.click('#row-check-update');
        const s = await waitStatus(q, 'disabled');
        assert.equal(s.text, `当前版本不检查更新 开发版（从源码运行）或已关闭更新时不会检查；当前版本 v${version}`);
        await shot(q, `c5-disabled-${name}`);
        obs[`disabled-${name}`] = s.text;
        return `「${s.text}」`;
      });
    } finally {
      if (B) await B.app.close().catch(() => {});
    }
  }

  fs.writeFileSync(path.join(DIR, 'observations.json'), JSON.stringify(obs, null, 2));
  say(`[${S}] artifacts: ${fs.readdirSync(DIR).sort().join(', ')}`);
};
