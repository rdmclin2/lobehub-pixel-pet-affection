// 像素小院 · 整屏录屏 (T-5550 evidence; not in `all`): records the whole X display with ffmpeg, so the desktop pet,
// her panel, the ⌂ click and the yard window are all in one clip, as the owner sees them.
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js scenerec
// Out: out/e2e/pixel-scene-rec/{scene-full.mp4, scene-full.chapters.json, tray-menu.png, *.png}
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { openPetPanel } = require('./pet-panel');

const isScene = (p) => p.url().includes('/renderer/scene/scene.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function sceneRecordScenario({ OUT, FAKE_LH, step, launch }) {
  return async function sceneRecord() {
    const S = 'scenerec';
    const DIR = path.join(OUT, 'pixel-scene-rec');
    fs.mkdirSync(DIR, { recursive: true });
    const display = process.env.DISPLAY;
    const size = '1280x800';
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-screcfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const env = { PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-screc-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1' };
    const grab = (file) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', size, '-i', display, '-frames:v', '1', path.join(DIR, file)]);
    const { app, page } = await launch(env);
    let ff = null;
    const t0 = { v: 0 };
    const chapters = [];
    const mark = (title, kind = 'step') => { const t = Math.round((Date.now() - t0.v) / 100) / 10; chapters.push({ t, kind, title }); };
    const out = [];
    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.fill('#pet-name', '小克');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await page.waitForTimeout(1200);
      await step(S, 'R0 托盘菜单（真实菜单弹出在屏幕上）', async () => {
        const r = await page.evaluate(() => window.pet.debugTrayPopup({ x: 900, y: 300 }));
        await wait(800);
        grab('tray-menu.png');
        await page.evaluate(() => window.pet.debugTrayPopup({ close: true }));
        const items = (await page.evaluate(() => window.pet.debugTray())).items;
        assert.ok(items.includes('像素小院'));
        return `popup=${JSON.stringify(r).slice(0, 80)} items=${items.join('/')}`;
      }, null);
      ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '15', '-video_size', size, '-i', display, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(DIR, 'scene-full.mp4')], { stdio: ['pipe', 'ignore', 'inherit'] });
      t0.v = Date.now();
      await wait(1500);
      let sp = null;
      const sc = () => sp.evaluate(() => window.__scene());
      const toClient = (x, y) => sp.evaluate(([a, b]) => window.__sceneToClient(a, b), [x, y]);
      const until = async (fn, ms, what) => { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > ms) throw new Error(`timed out: ${what}`); await wait(100); } };
      await step(S, 'R1 入口：右键她 → 面板 ⌂ → 像素小院打开，桌面上的她隐藏', async () => {
        mark('桌面上的她（右下角）：右键她打开面板');
        await wait(1200);
        const pp = await openPetPanel(page);
        await wait(1500);
        await pp.hover('[data-act="scene"]');
        await wait(1200);
        await pp.click('[data-act="scene"]');
        mark('点面板底栏 ⌂（像素小院）→ 小院窗口打开，她从桌面消失');
        sp = await until(() => app.windows().find(isScene) || null, 15000, 'yard');
        await sp.waitForFunction(() => window.__scene && window.__scene().ready && window.__scene().pet.ready, null, { timeout: 15000 });
        const d = await page.evaluate(() => window.pet.debugScene());
        assert.equal(d.visible, true);
        assert.equal(d.petVisible, false);
        await wait(1500);
        grab('r1-opened-full-screen.png');
        return `sources=${d.sources} petVisible=${d.petVisible}`;
      }, null);
      await step(S, 'R2 自主游走：不点任何地方，她自己走动', async () => {
        await sp.click('[data-phase="day"]');
        await sp.mouse.move(2, 590);
        mark('不操作：她自己在小院里逛（idle → walk）');
        const a = await sc();
        const s = await until(async () => { const x = await sc(); return x.pet.walked > a.pet.walked + 30 ? x : null; }, 30000, 'roaming');
        await wait(1500);
        out.push(`roam (${a.pet.x.toFixed(0)},${a.pet.y.toFixed(0)})→(${s.pet.x.toFixed(0)},${s.pet.y.toFixed(0)}) walked +${s.pet.walked - a.pet.walked}`);
        return out[out.length - 1];
      }, null);
      await step(S, 'R3 点空地 → 她走过去；点长椅坐下；点花坛浇花；夜里点路灯关灯', async () => {
        await until(async () => { const x = await sc(); return x.pet.mode === 'idle' || x.pet.mode === 'wander' ? x : null; }, 30000, 'free');
        const p = await toClient(264, 88);
        mark('点右侧空地（插小旗）：她沿路走过去');
        await sp.mouse.click(p.x, p.y);
        await until(async () => { const x = await sc(); return x.pet.mode === 'idle' && Math.floor(x.pet.x / 16) === 16 ? x : null; }, 25000, 'arrive');
        await wait(800);
        const props = await sp.evaluate(() => window.__sceneProps());
        const at = async (id) => { const b = props.find((x) => x.id === id).box; const c = await toClient(b[0] + b[2] / 2, b[1] + b[3] / 2); await sp.mouse.move(c.x, c.y); await wait(500); await sp.mouse.click(c.x, c.y); };
        mark('点长椅：她走过去坐下');
        await at('bench');
        await until(async () => { const x = await sc(); return x.pet.sitting ? x : null; }, 25000, 'sit');
        await wait(2500);
        mark('点花坛：她去浇花，花开了');
        await at('flowers');
        await until(async () => { const x = await sc(); return x.flowers.watered ? x : null; }, 25000, 'water');
        await wait(1500);
        mark('切到夜晚：路灯、窗户亮起');
        await sp.click('[data-phase="night"]');
        await wait(2000);
        mark('点路灯：她走过去拍一下，灯灭');
        const before = (await sc()).lamp.on;
        await at('lamp');
        await until(async () => { const x = await sc(); return x.lamp.on !== before ? x : null; }, 25000, 'lamp');
        await wait(2000);
        return 'goto / sit / water / lamp';
      }, null);
      await step(S, 'R4 时段：四个时段按钮 + 拖动滑块（连续）+ 跟随时间；天气：晴 / 多云 / 小雨 / 雪', async () => {
        await sp.mouse.move(2, 590);
        for (const [ph, t] of [['dawn', '黎明'], ['day', '白天'], ['dusk', '黄昏'], ['night', '夜晚']]) { mark(`时段：${t}`); await sp.click(`[data-phase="${ph}"]`); await wait(2200); }
        mark('拖动时间滑块：从 6 点连续拖到 21 点');
        const box = await sp.locator('#time-slider').boundingBox();
        const xAt = (h) => box.x + 8 + ((box.width - 16) * h) / 23.75;
        await sp.mouse.move(xAt(6), box.y + box.height / 2);
        await sp.mouse.down();
        for (let h = 6; h <= 21; h += 0.25) { await sp.mouse.move(xAt(h), box.y + box.height / 2); await wait(60); }
        await sp.mouse.up();
        await wait(1200);
        mark('打开「跟随时间」：回到本机当前时间');
        await sp.click('#follow-clock');
        await wait(2500);
        await sp.click('[data-phase="day"]');
        for (const [w, t] of [['clear', '晴'], ['cloudy', '多云'], ['rain', '小雨'], ['snow', '雪']]) { mark(`天气：${t}`); await sp.click(`[data-weather="${w}"]`); await wait(4000); }
        await sp.click('[data-weather="clear"]');
        return 'ok';
      }, null);
      await step(S, 'R5 Ctrl+Shift+H 关闭小院：她回到桌面原位', async () => {
        mark('Ctrl+Shift+H：关闭小院，她回到桌面');
        await sp.keyboard.press('Control+Shift+KeyH');
        await until(async () => { const d = await page.evaluate(() => window.pet.debugScene()); return !d.visible && d.petVisible ? d : null; }, 5000, 'closed');
        await wait(2500);
        grab('r5-back-on-desktop.png');
        return 'closed, pet visible';
      }, null);
    } finally {
      if (ff) { ff.stdin.write('q'); await new Promise((r) => ff.on('close', r)); }
      fs.writeFileSync(path.join(DIR, 'scene-full.chapters.json'), JSON.stringify(chapters, null, 2));
      await app.close().catch(() => {});
    }
  };
};
