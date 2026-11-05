// 像素小院 · 文档截图与录屏 (T-6157; not in `all`): the pictures and the clip in docs/pixel-scene.md, made the way
// a user would see them — the yard window, real clicks on the canvas and the 天色 card.
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js scenedocs
// Out: docs/img/pixel-scene/
//   day-clear.png dusk-cloudy.png night-rain.png snow.png       四种时段 × 天气组合（她站在画面中间的空地上）
//   pos-left.png pos-right.png pos-front.png                    她在小院的不同位置
//   act-touch.png act-bench.png act-water.png act-lamp.png      她正在互动（点她出气泡 / 坐长椅 / 浇花 / 夜里拍路灯）
//   pixel-scene-demo.mp4 (+ .gif, .chapters.json)               ≥10 s 录屏：自己走 → 点地走过去 → 点她 → 长椅 → 拖时间滑块 → 换天气
// The clip is ffmpeg x11grab of the X display (so the mouse pointer is in it), cropped to the yard window.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const isScene = (p) => p.url().includes('/renderer/scene/scene.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function sceneDocsScenario({ ROOT, FAKE_LH, step, launch }) {
  return async function sceneDocs() {
    const S = 'scenedocs';
    const DIR = path.join(ROOT, 'docs', 'img', 'pixel-scene');
    fs.mkdirSync(DIR, { recursive: true });
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-scdocfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const env = { PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-scdoc-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '0' };
    const { app, page } = await launch(env);
    let sp = null;
    let ff = null;
    const chapters = [];
    const t0 = { v: 0 };
    const mark = (title) => chapters.push({ t: Math.round((Date.now() - t0.v) / 100) / 10, kind: 'step', label: title });
    const sc = () => sp.evaluate(() => window.__scene());
    const shot = (n) => sp.screenshot({ path: path.join(DIR, `${n}.png`) });
    const until = async (fn, ms, what) => { const s = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - s > ms) throw new Error(`timed out: ${what}`); await wait(100); } };
    const settled = () => until(async () => { const s = await sc(); const d = (((s.hour - s.target) % 24) + 24) % 24; return Math.min(d, 24 - d) < 0.03 ? s : null; }, 12000, 'the hour to settle');
    const toClient = (x, y) => sp.evaluate(([a, b]) => window.__sceneToClient(a, b), [x, y]);
    const clickLogical = async (x, y, glide = false) => {
      const c = await toClient(x, y);
      if (glide) { await sp.mouse.move(c.x, c.y, { steps: 12 }); await wait(250); }
      await sp.mouse.click(c.x, c.y);
    };
    const prop = async (id) => (await sp.evaluate(() => window.__sceneProps())).find((x) => x.id === id);
    const clickProp = async (id, glide = false) => {
      const [x, y, w, h] = (await prop(id)).box;
      await clickLogical(id === 'pond' ? x + 8 : x + Math.floor(w / 2), id === 'pond' ? y + 6 : y + Math.floor(h / 2), glide);
    };
    // she may have walked to a prop by herself (sitting on the bench lasts 20–40 s): a click on the ground gets her up
    const free = async () => {
      if ((await sc()).pet.mode === 'interact') await clickLogical(150, 100);
      return until(async () => { const s = await sc(); return s.pet.mode === 'idle' ? s : null; }, 25000, 'her to stand idle');
    };
    // walk her to a logical point and wait until she stands there
    const walkTo = async (x, y) => {
      const a = await sc();
      if (a.pet.mode === 'interact' || a.pet.mode === 'goto') await free();
      await clickLogical(x, y);
      // she walks to the walkable tile nearest the click (not always the exact point)
      return until(async () => { const s = await sc(); return s.pet.mode === 'idle' && Math.abs(s.pet.x - x) < 24 && Math.abs(s.pet.y - y) < 24 ? s : null; }, 25000, `her at (${x},${y})`);
    };
    const away = () => sp.mouse.move(4, 4);
    const combo = async (phase, weather) => {
      await sp.click(`[data-phase="${phase}"]`);
      await sp.click(`[data-weather="${weather}"]`);
      await settled();
      await wait(3600); // the weather cross-fade is 3 s
    };
    const facts = [];
    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.fill('#pet-name', '小克');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await page.waitForTimeout(800);
      await page.evaluate(() => window.pet.debugSceneToggle('test'));
      sp = await until(() => app.windows().find(isScene) || null, 15000, 'the yard window');
      await sp.waitForFunction(() => window.__scene && window.__scene().ready && window.__scene().pet.ready, null, { timeout: 15000 });
      await sp.waitForTimeout(1000);

      await step(S, 'D1 四种时段 × 天气：白天晴 / 黄昏多云 / 夜晚小雨 / 雪天，她站在中间空地', async () => {
        const out = [];
        for (const [name, ph, w] of [['day-clear', 'day', 'clear'], ['dusk-cloudy', 'dusk', 'cloudy'], ['night-rain', 'night', 'rain'], ['snow', 'dawn', 'snow']]) {
          await combo(ph, w);
          await walkTo(150, 100);
          await away();
          await wait(300);
          const s = await sc();
          assert.equal(s.phase, ph);
          assert.equal(s.weather.to, w);
          await shot(name);
          out.push(`${name}: ${s.hour.toFixed(2)}h phase=${s.phase} weather=${s.weather.to} rain=${s.particles.rain} snow=${s.particles.snow} clouds=${s.clouds} bright=${s.brightness.toFixed(1)} lamp=${s.lamp.on} pet=(${s.pet.x.toFixed(0)},${s.pet.y.toFixed(0)}) ${s.pet.state}`);
        }
        return out.join(' | ');
      }, () => sp);

      await step(S, 'D2 她在小院的不同位置：左侧、右侧、前景石板路旁（白天晴）', async () => {
        await combo('day', 'clear');
        const out = [];
        for (const [name, x, y] of [['pos-left', 56, 88], ['pos-right', 264, 88], ['pos-front', 192, 118]]) {
          const s = await walkTo(x, y);
          await away();
          await wait(300);
          await shot(name);
          out.push(`${name}: (${s.pet.x.toFixed(0)},${s.pet.y.toFixed(0)}) tile ${Math.floor(s.pet.x / 16)},${Math.floor(s.pet.y / 16)}`);
        }
        return out.join(' | ');
      }, () => sp);

      await step(S, 'D3 她正在互动：点她出气泡、坐长椅、浇花、夜里拍路灯', async () => {
        const out = [];
        await walkTo(150, 100);
        const s0 = await sc();
        const b = s0.pet.box;
        await clickLogical(b.x + b.w / 2, b.y + b.h / 2);
        await sp.waitForFunction(() => !document.getElementById('bubble').classList.contains('hidden'), null, { timeout: 8000 });
        await wait(400);
        await shot('act-touch');
        out.push(`点她: bubble「${(await sp.textContent('#bubble')).trim()}」 state=${(await sc()).pet.state}`);
        await free();
        await clickProp('bench');
        await until(async () => { const x = await sc(); return x.pet.sitting ? x : null; }, 25000, 'sitting');
        await away();
        await wait(600);
        await shot('act-bench');
        out.push('长椅: sitting');
        await clickProp('flowers');
        const w = await until(async () => { const x = await sc(); return x.pet.act === 'water' && x.pet.state === 'play' ? x : null; }, 25000, 'watering');
        await away();
        await wait(1200);
        await shot('act-water');
        out.push(`花坛: ${w.pet.act}/${w.pet.state}`);
        await free();
        await sp.click('[data-phase="night"]');
        await settled();
        const before = (await sc()).lamp.on;
        await clickProp('lamp');
        await until(async () => { const x = await sc(); return x.pet.act === 'lamp' ? x : null; }, 25000, 'at the lamp');
        await away();
        await wait(250);
        await shot('act-lamp');
        const l = await until(async () => { const x = await sc(); return x.lamp.on !== before ? x : null; }, 6000, 'lamp switched');
        out.push(`路灯: ${before} → ${l.lamp.on}`);
        await free();
        await clickProp('lamp');
        await until(async () => { const x = await sc(); return x.lamp.on === before ? x : null; }, 30000, 'lamp back');
        return out.join(' | ');
      }, () => sp);

      await step(S, 'D4 录屏（≥10 s，含鼠标指针）：自己走 → 点地走过去 → 点她 → 长椅 → 拖时间滑块 → 换天气', async () => {
        await combo('day', 'clear');
        await free();
        await sp.bringToFront();
        const win = await sp.evaluate(() => ({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight }));
        // the page area of the window (no frame under xvfb: no window manager)
        const cx = Math.max(0, win.x + (win.w - win.iw)), cy = Math.max(0, win.y + (win.h - win.ih));
        const crop = { x: cx - (cx % 2), y: cy - (cy % 2), w: win.iw - (win.iw % 2), h: win.ih - (win.ih % 2) };
        const raw = path.join(os.tmpdir(), `pp-scdoc-${process.pid}.mp4`);
        ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '20', '-video_size', `${crop.w}x${crop.h}`, '-i', `${process.env.DISPLAY}+${crop.x},${crop.y}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', raw], { stdio: ['pipe', 'ignore', 'inherit'] });
        t0.v = Date.now();
        await wait(800);
        mark('白天 · 晴：不操作，她自己在小院里走动');
        const a = await sc();
        await until(async () => { const x = await sc(); return x.pet.walked > a.pet.walked + 20 ? x : null; }, 30000, 'roaming');
        await wait(1500);
        await free();
        const here = await sc();
        const tx = here.pet.x < 160 ? 264 : 56;
        mark('点空地：插一面小旗，她沿路走过去');
        await clickLogical(tx, 88, true);
        await until(async () => { const x = await sc(); return x.pet.mode === 'idle' && Math.floor(x.pet.x / 16) === Math.floor(tx / 16) ? x : null; }, 25000, 'arrive');
        await wait(600);
        mark('点她：她开心一下，头上出气泡');
        const b = (await sc()).pet.box;
        await clickLogical(b.x + b.w / 2, b.y + b.h / 2, true);
        await wait(2600);
        await free();
        mark('点长椅：她走过去坐下');
        await clickProp('bench', true);
        await until(async () => { const x = await sc(); return x.pet.sitting ? x : null; }, 25000, 'sit');
        await wait(1500);
        mark('拖动时间滑块：06:00 → 21:00，天色由亮转暗，路灯与窗户亮起');
        const box = await sp.locator('#time-slider').boundingBox();
        const xAt = (h) => box.x + 8 + ((box.width - 16) * h) / 23.75;
        await sp.mouse.move(xAt(6), box.y + box.height / 2, { steps: 10 });
        await sp.mouse.down();
        for (let h = 6; h <= 21; h += 0.5) await sp.mouse.move(xAt(h), box.y + box.height / 2);
        await sp.mouse.up();
        await wait(1500);
        for (const [w, t] of [['cloudy', '多云'], ['rain', '小雨'], ['snow', '雪']]) {
          mark(`天气切换：${t}`);
          const c = await sp.locator(`[data-weather="${w}"]`).boundingBox();
          await sp.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 10 });
          await sp.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
          await wait(4000);
        }
        mark('时段按钮「白天」：雪中的白天');
        await sp.click('[data-phase="day"]');
        await wait(2500);
        ff.stdin.write('q');
        await new Promise((r) => ff.on('close', r));
        ff = null;
        const mp4 = path.join(DIR, 'pixel-scene-demo.mp4');
        fs.copyFileSync(raw, mp4);
        fs.rmSync(raw, { force: true });
        // a GIF for the README / PR page (GitHub plays it inline): 10 fps, 480 px wide
        const pal = path.join(os.tmpdir(), `pp-scdoc-pal-${process.pid}.png`);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-vf', 'fps=10,scale=480:-1:flags=neighbor,palettegen=max_colors=128', pal]);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-i', pal, '-lavfi', 'fps=10,scale=480:-1:flags=neighbor[x];[x][1:v]paletteuse=dither=none', path.join(DIR, 'pixel-scene-demo.gif')]);
        fs.rmSync(pal, { force: true });
        fs.writeFileSync(path.join(DIR, 'pixel-scene-demo.chapters.json'), JSON.stringify(chapters, null, 2) + '\n');
        const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim();
        assert.ok(Number(dur) >= 10, `duration ${dur}`);
        facts.push(`mp4 ${dur}s crop=${JSON.stringify(crop)}`);
        return `${facts.join(' ')} chapters=${chapters.map((c) => `${c.t}s ${c.title}`).join(' / ')}`;
      }, () => sp);
    } finally {
      if (ff) { ff.stdin.write('q'); await new Promise((r) => ff.on('close', r)); }
      await app.close().catch(() => {});
    }
  };
};
