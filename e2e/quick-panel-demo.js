'use strict';
// 快捷调用面板 (T-2849): a slow, narrated walk for reviewers — the same real app as e2e/quick-panel.js, paced so
// every key press and highlight can be seen on the recording (out/e2e/quick/demo-*.mp4 + .chapters.json).
//   xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js quickdemo
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

module.exports = ({ OUT, FAKE_LH, step, launch, say }) => async function quickDemo() {
  const S = 'quickdemo';
  const DIR = path.join(OUT, 'quick');
  fs.mkdirSync(DIR, { recursive: true });
  const { version } = require('../package.json');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PACE = 900;
  const feed = { mode: 'latest', delay: 0 };
  const server = http.createServer(async (req, res) => {
    if (feed.delay) await sleep(feed.delay);
    if (feed.mode === 'error') { res.writeHead(500); return res.end(); }
    const tag = feed.mode === 'newer' ? 'v9.9.9' : `v${version}`;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases/tag/${tag}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const display = process.env.DISPLAY;
  let size = '1280x800';
  try { size = /dimensions:\s+(\d+x\d+)/.exec(execFileSync('xdpyinfo', { encoding: 'utf8' }))[1]; } catch { /* default */ }
  let rec = null;
  let t0 = 0;
  let marks = [];
  const mark = (kind, text) => marks.push(kind === 'step' ? { kind, t: +((Date.now() - t0) / 1000).toFixed(2), label: text } : { kind, t: +((Date.now() - t0) / 1000).toFixed(2), note: text });
  const startRec = () => {
    rec = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '15', '-video_size', size, '-i', display, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', path.join(DIR, 'tmp.mp4')], { stdio: ['pipe', 'ignore', 'pipe'] });
    t0 = Date.now();
    marks = [];
  };
  const stopRec = async (name) => {
    const p = new Promise((r) => rec.on('exit', r));
    rec.stdin.write('q');
    await Promise.race([p, sleep(8000)]);
    rec = null;
    fs.renameSync(path.join(DIR, 'tmp.mp4'), path.join(DIR, name));
    fs.writeFileSync(path.join(DIR, name.replace(/\.mp4$/, '.chapters.json')), JSON.stringify(marks, null, 1));
  };
  const xkey = (k) => execFileSync('xdotool', ['key', '--clearmodifiers', k]);
  const xclick = (x, y) => execFileSync('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '1']);
  const xmove = (x, y) => execFileSync('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))]);

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-qdemo-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-qdemo-d-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_UPDATE_TEST: '1', PIXELPET_UPDATE_FEED: `http://127.0.0.1:${server.address().port}` });
  const state = () => page.evaluate(() => window.pet.debugQuick());
  const until = async (fn, what, ms = 8000) => { const s = Date.now(); for (;;) { if (await fn().catch(() => false)) return; if (Date.now() - s > ms) throw new Error(`timed out: ${what} (after 「${marks.length ? marks[marks.length - 1].label || marks[marks.length - 1].note : '-'}」)`); await sleep(80); } };
  const shown = (on) => until(async () => (await state()).visible === on, on ? 'shown' : 'hidden');
  const q = () => app.windows().find((w) => w.url().includes('/quick/'));
  const active = () => q().evaluate(() => { const r = document.querySelector('.row.active'); return r ? r.querySelector('.label').textContent : null; });
  const petScreen = async () => { const b = await page.locator('#pet-body .pet-hit:not(.hidden)').first().boundingBox(); const w = await page.evaluate(() => ({ x: window.screenX, y: window.screenY })); return { x: w.x + b.x + b.width / 2, y: w.y + b.y + b.height * 0.45 }; };
  const rightClickPet = async () => { const p = await petScreen(); execFileSync('xdotool', ['mousemove', String(Math.round(p.x)), String(Math.round(p.y)), 'click', '3']); await shown(true); };
  const rowCenter = async (id) => { const b = (await state()).bounds; const r = await q().locator(`#row-${id}`).boundingBox(); return { x: b.x + r.x + r.width / 2, y: b.y + r.y + r.height / 2 }; };
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="grok"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
    await sleep(800);

    await step(S, 'D1 演示录屏：快捷键唤出 → ↑↓ 导航 → Esc 关闭 → 快捷键唤出 → 再按快捷键关闭；右键唤出、悬停高亮、打字筛选、↩ 执行、点面板外关闭、贴边唤出、拖动她', async () => {
      startRec();
      await sleep(1200);
      mark('step', '按 Ctrl+Alt+P（xdotool 真实按键）');
      xkey('ctrl+alt+p');
      try { await until(async () => (await state()).visible, 'shown', 3000); } catch {
        const st = await state();
        throw new Error(`first press did not open it: ${JSON.stringify({ hotkey: st.hotkey, registered: st.registered, opens: st.opens })}`);
      }
      await sleep(PACE);
      mark('check', '面板出现在她左侧，完整在屏幕内；底部提示 Ctrl+Alt+P 唤出 / 关闭');
      for (const k of ['Down', 'Down', 'Down', 'Up']) { mark('step', `按 ${k === 'Down' ? '↓' : '↑'}`); xkey(k); await sleep(PACE); }
      assert.equal(await active(), '检查更新…');
      mark('check', '↓↓↓↑ 后高亮停在「检查更新…」（蓝色填充）');
      await sleep(PACE);
      mark('step', '按 Esc');
      xkey('Escape');
      await shown(false);
      mark('check', 'Esc 后面板消失');
      await sleep(PACE * 1.5);
      mark('step', '再按 Ctrl+Alt+P 唤出');
      xkey('ctrl+alt+p');
      await shown(true);
      await sleep(PACE * 1.5);
      mark('step', '再按一次 Ctrl+Alt+P');
      xkey('ctrl+alt+p');
      await shown(false);
      mark('check', '再次按快捷键面板关闭');
      await sleep(PACE * 1.5);

      mark('step', '右键她（xdotool 右键）');
      await rightClickPet();
      await sleep(PACE);
      mark('check', '右键处弹出面板：关于/检查更新… | 偏好设置… Ctrl+, | 和她聊天/隐藏桌宠 | 退出 Ctrl+Q');
      for (const id of ['about', 'check-update', 'settings', 'chat', 'hide-pet', 'quit']) { const c = await rowCenter(id); xmove(c.x, c.y); await sleep(PACE * 0.6); }
      mark('check', '指针悬停在「退出」上，该行蓝色高亮');
      await sleep(PACE * 0.6);
      const c0 = await rowCenter('about');
      xmove(c0.x + 400, c0.y - 200); // off the panel: nothing stays highlighted
      await sleep(PACE * 0.6);
      mark('step', '打字「设置」筛选');
      await q().keyboard.type('设置', { delay: 350 });
      await sleep(400);
      mark('check', '列表只剩「偏好设置…」并被高亮');
      await sleep(PACE * 1.5);
      mark('step', '按 ↩ 执行');
      xkey('Return');
      await shown(false);
      await until(async () => app.windows().some((w) => w.url().includes('admin-ui')), 'settings window', 15000);
      await sleep(PACE * 2);
      mark('check', '执行后面板关闭，设置窗口打开（小屋页）');
      await sleep(PACE * 1.5);
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')); w.hide(); });
      await sleep(PACE);

      mark('step', '右键她，然后点面板外（她窗口右下角）');
      await rightClickPet();
      await sleep(PACE);
      const pw = await page.evaluate(() => ({ x: window.screenX + window.outerWidth - 12, y: window.screenY + window.outerHeight - 12 }));
      xclick(pw.x, pw.y);
      await shown(false);
      mark('check', '点面板外后面板关闭');
      await sleep(PACE * 1.5);

      mark('step', '把她拖到屏幕右下角贴边，再右键她');
      await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('/quick/') && !x.webContents.getURL().includes('admin-ui')); const a = screen.getPrimaryDisplay().workArea; const b = w.getBounds(); w.setPosition(a.x + a.width - b.width, a.y + a.height - b.height); });
      await sleep(PACE);
      await rightClickPet();
      const st = await state();
      assert.ok(st.bounds.x + st.bounds.width <= st.area.x + st.area.width && st.bounds.y + st.bounds.height <= st.area.y + st.area.height);
      await sleep(PACE);
      mark('check', `贴边时面板向左上翻转，完整在屏幕内 ${JSON.stringify(st.bounds)}`);
      await sleep(PACE);
      xkey('Escape');
      await shown(false);
      await sleep(PACE);

      mark('step', '拖动她（真实鼠标按下-移动-松开）');
      const d = await petScreen();
      execFileSync('xdotool', ['mousemove', String(Math.round(d.x)), String(Math.round(d.y)), 'mousedown', '1']);
      for (let i = 1; i <= 12; i++) { xmove(d.x - i * 25, d.y - i * 15); await sleep(60); }
      execFileSync('xdotool', ['mouseup', '1']);
      await sleep(PACE);
      const after = await page.evaluate(() => ({ x: window.screenX, y: window.screenY }));
      mark('check', `她被拖到了 ${after.x},${after.y}，拖动后没有弹出面板`);
      assert.equal((await state()).visible, false);
      await sleep(PACE * 1.5);
      await stopRec('demo-open-close-nav.mp4');
      return `recorded demo-open-close-nav.mp4 with ${marks.length} chapters`;
    });

    await step(S, 'D2 演示录屏：检查更新 已是最新 → 检查中 → 失败 + 重试 → 发现新版本 + 前往下载页', async () => {
      await page.evaluate(() => window.pet.place('pet'));
      await sleep(600);
      startRec();
      await sleep(800);
      mark('step', '右键她，点「检查更新…」');
      await rightClickPet();
      await sleep(PACE);
      let c = await rowCenter('check-update');
      xclick(c.x, c.y);
      await until(async () => (await q().evaluate(() => (document.querySelector('.status') || {}).dataset?.status)) === 'latest', 'latest');
      await sleep(PACE);
      mark('check', `面板内显示「已是最新版本 · 当前版本 v${version}」`);
      await sleep(PACE * 1.5);
      feed.delay = 3000;
      mark('step', '服务器变慢（3 秒），再点「检查更新…」');
      c = await rowCenter('check-update');
      xclick(c.x, c.y);
      await sleep(PACE);
      mark('check', '显示「正在检查更新…」并转圈，「检查更新…」右侧为「检查中」');
      await until(async () => (await q().evaluate(() => (document.querySelector('.status') || {}).dataset?.status)) === 'latest', 'latest', 10000);
      feed.delay = 0;
      await sleep(PACE);
      feed.mode = 'error';
      mark('step', '服务器返回 500，点「检查更新…」');
      c = await rowCenter('check-update');
      xclick(c.x, c.y);
      await until(async () => (await q().evaluate(() => (document.querySelector('.status') || {}).dataset?.status)) === 'error', 'error');
      await sleep(PACE);
      mark('check', '显示「检查更新失败 · 更新服务器返回 500」和「重试」行');
      await sleep(PACE);
      feed.mode = 'latest';
      mark('step', '点「重试」');
      c = await rowCenter('retry');
      xclick(c.x, c.y);
      await until(async () => (await q().evaluate(() => (document.querySelector('.status') || {}).dataset?.status)) === 'latest', 'latest');
      await sleep(PACE);
      mark('check', '重试后显示「已是最新版本」');
      await sleep(PACE);
      feed.mode = 'newer';
      mark('step', '发布了 v9.9.9，点「检查更新…」');
      c = await rowCenter('check-update');
      xclick(c.x, c.y);
      await until(async () => (await q().evaluate(() => (document.querySelector('.status') || {}).dataset?.status)) === 'manual', 'manual');
      await sleep(PACE);
      mark('check', '显示「发现新版本 v9.9.9」和「前往下载页」行');
      await sleep(PACE * 1.5);
      mark('step', '点「前往下载页」');
      c = await rowCenter('open-download');
      xclick(c.x, c.y);
      await shown(false);
      const links = await page.evaluate(() => window.pet.debugOpenedLinks());
      assert.ok(links.some((l) => l.endsWith('/v9.9.9')));
      mark('check', '面板关闭，发布页链接已打开（测试模式记录链接而不真的打开浏览器）');
      await sleep(PACE * 2);
      await stopRec('demo-check-update.mp4');
      return `recorded demo-check-update.mp4 with ${marks.length} chapters`;
    });
  } finally {
    if (rec) await stopRec('demo-aborted.mp4').catch(() => {});
    await app.close().catch(() => {});
    server.close();
    say(`[quickdemo] recordings in ${DIR}`);
  }
};
