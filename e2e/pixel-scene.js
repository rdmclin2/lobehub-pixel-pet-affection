// 像素小院 (docs/pixel-scene.md, T-5550): the pixel yard she walks about in, driven as a user does —
// `xvfb-run -a node e2e/run.js scene` (unset ELECTRON_RUN_AS_NODE first; no tokens: fake lh).
//   S1  entry: her panel ⌂ opens the yard, her desktop window hides; the tray has 「像素小院」
//   S2  rendering: integer scale (canvas = 320×200×scale, no smoothing, every screen block one colour), layers,
//       her sprite loaded from the claude-pixel pack
//   S3  time: the 黎明 / 白天 / 黄昏 / 夜晚 chips and the slider (18:30) — phase, sky, brightness, lamp / windows
//   S4  跟随时间 on: the yard's hour = this computer's clock; off again
//   S5  weather 晴 / 多云 / 小雨 / 雪 (+ 雷雨 / 雾): particles, clouds and tint change
//   S6  she roams by herself (her position changes with nobody clicking)
//   S7  a click on the ground: she walks there (flag), arrives on that tile
//   S8  props: 长椅 → sits; 花坛 → waters (play), the flowers open; 路灯 → switches the lamp; 池塘 → looks
//   S9  press and drag her: lifted, dropped on a walkable tile
//   S10 another character (gemini-pixel) in the settings window: the yard redraws her; weather set there syncs
//   S11 Ctrl+Shift+H in the yard closes it, her desktop window comes back
//   S12 restart: the yard's time and weather are kept (settings.json)
//   S13 a recording: dawn → day → dusk → night (lamp) → rain → snow → she sits on the bench
// Screenshots and the recording: out/e2e/pixel-scene/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { clickAct } = require('./pet-panel');

const isScene = (p) => p.url().includes('/renderer/scene/scene.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function pixelSceneScenario({ OUT, FAKE_LH, step, launch, openAdminWindow }) {
  return async function pixelScene() {
    const S = 'scene';
    const SHOTS = path.join(OUT, 'pixel-scene');
    fs.mkdirSync(SHOTS, { recursive: true });
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-scenefake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-scene-'));
    const env = { PIXELPET_DATA_DIR: dataDir, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1' };
    let { app, page } = await launch(env);
    let sp = null; // the yard's page
    const facts = {};
    const sc = () => sp.evaluate(() => window.__scene());
    const dbg = () => page.evaluate(() => window.pet.debugScene());
    const shot = (n) => sp.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const until = async (fn, ms = 10000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
        await wait(100);
      }
    };
    const findScene = async (a) => until(() => a.windows().find(isScene) || null, 15000, 'the yard window');
    // the hour settled at the target (transitions done)
    const settled = () => until(async () => { const s = await sc(); const d = (((s.hour - s.target) % 24) + 24) % 24; return Math.min(d, 24 - d) < 0.03 ? s : null; }, 12000, 'the hour to settle');
    const clickLogical = async (x, y) => { const c = await sp.evaluate(([a, b]) => window.__sceneToClient(a, b), [x, y]); await sp.mouse.click(c.x, c.y); return c; };
    const clickProp = async (id) => {
      const p = (await sp.evaluate(() => window.__sceneProps())).find((x) => x.id === id);
      const [x, y, w, h] = p.box;
      // a point inside the box that is the prop itself (the pond: its water at the top row)
      return clickLogical(id === 'pond' ? x + 8 : x + Math.floor(w / 2), id === 'pond' ? y + 6 : y + Math.floor(h / 2));
    };
    // she roams by herself and may be using a prop (the bench lasts 20–40 s): a click on the ground gets her up
    const petIdle = async () => {
      if ((await sc()).pet.mode === 'interact') await clickLogical(150, 100);
      return until(async () => { const s = await sc(); return s.pet.mode === 'idle' ? s : null; }, 20000, 'her to stand idle');
    };
    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.fill('#pet-name', '小克');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await page.waitForTimeout(500);

      await step(S, 'S1 入口：她的面板 ⌂ 打开像素小院，桌面上的她隐藏；托盘有「像素小院」', async () => {
        const tray = await page.evaluate(() => window.pet.debugTray());
        const petBefore = (await dbg()).petBounds;
        await page.screenshot({ path: path.join(SHOTS, 's1-0-desktop-pet.png') });
        const pp = await clickAct(page, 'scene');
        void pp;
        sp = await findScene(app);
        await sp.waitForFunction(() => window.__scene && window.__scene().ready && window.__scene().pet.ready, null, { timeout: 15000 });
        const d = await dbg();
        assert.equal(d.visible, true, 'the yard is open');
        assert.equal(d.petVisible, false, 'her desktop window is hidden while she is in the yard');
        assert.deepEqual(d.sources, ['panel']);
        if (tray.created) assert.ok(tray.items.includes('像素小院'), tray.items.join(','));
        facts.petBefore = petBefore;
        await shot('s1-1-opened');
        return `tray=${tray.created ? tray.items.join('/') : '(no tray on this desktop)'} · scene visible=${d.visible} · pet visible=${d.petVisible} · source=${d.sources}`;
      }, () => sp || page);

      await step(S, 'S2 像素渲染：整数缩放、不平滑、多图层；claude-pixel 精灵已加载', async () => {
        const s = await sc();
        assert.ok(Number.isInteger(s.scale) && s.scale >= 1, `scale ${s.scale}`);
        assert.equal(s.canvas.w, 320 * s.scale);
        assert.equal(s.canvas.h, 200 * s.scale);
        assert.equal(s.smoothing, false);
        assert.ok(s.layers.length >= 8);
        assert.equal(s.pet.kind, 'sprites');
        assert.match(s.pet.url, /claude-pixel/);
        // every scale×scale block of the screen canvas is one colour (no blur between logical pixels)
        const crisp = await sp.evaluate(() => {
          const c = document.getElementById('stage');
          const k = window.__scene().scale;
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let blocks = 0, bad = 0;
          for (let by = 0; by < 200; by += 7) for (let bx = 0; bx < 320; bx += 7) {
            blocks++;
            const i0 = ((by * k) * c.width + bx * k) * 4;
            for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) {
              const i = ((by * k + y) * c.width + bx * k + x) * 4;
              if (d[i] !== d[i0] || d[i + 1] !== d[i0 + 1] || d[i + 2] !== d[i0 + 2]) { bad++; y = k; break; }
            }
          }
          return { blocks, bad };
        });
        assert.equal(crisp.bad, 0, `${crisp.bad}/${crisp.blocks} blocks not uniform`);
        await shot('s2-render');
        return `scale=${s.scale} canvas=${s.canvas.w}×${s.canvas.h} smoothing=${s.smoothing} uniformBlocks=${crisp.blocks - crisp.bad}/${crisp.blocks} layers=${s.layers.join('>')} pet=${s.pet.kind} ${s.pet.frameW}×${s.pet.frameH}px`;
      }, () => sp);

      const bright = {};
      await step(S, 'S3 时间调节：黎明 / 白天 / 黄昏 / 夜晚 时段按钮与连续滑块，天空、光照遮罩、灯光随之变化', async () => {
        await sp.mouse.move(5, 300);
        const out = [];
        for (const ph of ['dawn', 'day', 'dusk', 'night']) {
          await sp.click(`[data-phase="${ph}"]`);
          const s = await settled();
          assert.equal(s.phase, ph);
          assert.equal(s.scene.followClock, false);
          bright[ph] = s.brightness;
          out.push(`${ph}: ${s.hour.toFixed(2)}h K=${s.light.ambientK} sky=${s.light.skyTop} lights=${s.light.lights.toFixed(2)} lamp=${s.lamp.on} bright=${s.brightness.toFixed(1)} card=${s.dark ? 'dark' : 'light'}`);
          await shot(`s3-${ph}`);
        }
        assert.ok(bright.day > bright.dawn && bright.day > bright.dusk, JSON.stringify(bright));
        assert.ok(bright.dawn > bright.night && bright.dusk > bright.night, JSON.stringify(bright));
        const night = await sc();
        assert.equal(night.lamp.on, true, 'the lamp is on at night');
        assert.ok(night.light.lights > 0.5);
        // the slider: any quarter hour, here 18:30
        await sp.locator('#time-slider').fill('18.5');
        const s = await settled();
        assert.equal(s.scene.hour, 18.5);
        assert.equal(s.phase, 'dusk');
        assert.equal(await sp.textContent('#time-name'), '黄昏 · 18:30');
        out.push(`slider 18.5 → ${s.phase} ${await sp.textContent('#time-name')} K=${s.light.ambientK}`);
        await shot('s3-slider-1830');
        return out.join(' | ');
      }, () => sp);

      await step(S, 'S4 跟随系统时间：打开后小院时刻 = 本机时间；关掉后回到固定时刻', async () => {
        await sp.click('#follow-clock');
        const s = await settled();
        const label = await sp.textContent('#time-name');
        const now = new Date();
        const clock = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
        assert.equal(s.scene.followClock, true);
        assert.ok(Math.abs(s.hour - clock) < 0.1 || Math.abs(s.hour - clock) > 23.9, `${s.hour} vs ${clock}`);
        assert.equal((await dbg()).settings.followClock, true, 'saved');
        await shot('s4-follow-clock');
        await sp.click('[data-phase="day"]');
        const s2 = await settled();
        assert.equal(s2.scene.followClock, false);
        return `follow on: hour=${s.hour.toFixed(3)} clock=${clock.toFixed(3)} （卡片「${label}」） · chip 白天 → follow off, hour=${s2.hour.toFixed(2)}`;
      }, () => sp);

      await step(S, 'S5 天气调节：晴 / 多云 / 小雨 / 雪（另有雷雨 / 雾），粒子与色调立即变化', async () => {
        const out = [];
        const got = {};
        for (const w of ['clear', 'cloudy', 'rain', 'snow', 'storm', 'fog']) {
          await sp.click(`[data-weather="${w}"]`);
          const first = await sc();
          assert.equal(first.weather.to, w, 'switched at once');
          await sp.waitForTimeout(3600);
          const s = await sc();
          got[w] = s;
          out.push(`${w}: rain=${s.particles.rain} snow=${s.particles.snow} clouds=${s.clouds} tintK=${s.weather.tintK.toFixed(2)} bright=${s.brightness.toFixed(1)}`);
          await shot(`s5-${w}`);
        }
        assert.equal(got.clear.particles.rain + got.clear.particles.snow, 0);
        assert.ok(got.cloudy.clouds >= 4, `cloudy clouds ${got.cloudy.clouds}`);
        assert.ok(got.rain.particles.rain > 100, `rain ${got.rain.particles.rain}`);
        assert.ok(got.snow.particles.snow > 80, `snow ${got.snow.particles.snow}`);
        assert.ok(got.snow.particles.rain <= 10, `rain left in snow ${got.snow.particles.rain}`);
        assert.ok(got.rain.weather.tintK > got.clear.weather.tintK);
        assert.ok(got.rain.brightness < got.clear.brightness, 'rain darkens');
        assert.equal((await dbg()).settings.weather, 'fog', 'saved');
        await sp.click('[data-weather="clear"]');
        return out.join(' | ');
      }, () => sp);

      await step(S, 'S6 自主游走：没人点她，过一会儿她自己走到别处', async () => {
        await sp.mouse.move(5, 300);
        // sitting on the bench (a prop she picked by herself) lasts 20–40 s: get her up first
        if ((await sc()).pet.mode === 'interact') { await clickLogical(150, 100); await petIdle(); }
        const a = await sc();
        const s = await until(async () => { const x = await sc(); return (Math.hypot(x.pet.x - a.pet.x, x.pet.y - a.pet.y) > 8 || x.pet.walked > a.pet.walked + 8) ? x : null; }, 30000, 'her to walk by herself');
        await shot('s6-roam');
        return `from (${a.pet.x.toFixed(0)},${a.pet.y.toFixed(0)}) → (${s.pet.x.toFixed(0)},${s.pet.y.toFixed(0)}) mode=${s.pet.mode} state=${s.pet.state} walked=${s.pet.walked}`;
      }, () => sp);

      await step(S, 'S7 点击目标点：点空地，她走过去（小旗），到达该格', async () => {
        await petIdle();
        const a = await sc();
        const tx = a.pet.x < 160 ? 264 : 56;
        const ty = 88;
        await clickLogical(tx, ty);
        const mid = await until(async () => { const x = await sc(); return x.pet.mode === 'goto' && x.pet.state === 'walk' ? x : null; }, 3000, 'goto');
        await sp.waitForTimeout(800);
        await shot('s7-walking');
        const s = await until(async () => { const x = await sc(); return x.pet.mode === 'idle' ? x : null; }, 25000, 'arrival');
        const tile = [Math.floor(s.pet.x / 16), Math.floor(s.pet.y / 16)];
        assert.deepEqual(tile, [Math.floor(tx / 16), Math.floor(ty / 16)]);
        await shot('s7-arrived');
        return `click (${tx},${ty}) → mode ${mid.pet.mode}/${mid.pet.state} facing ${mid.pet.facing} → arrived tile ${tile} at (${s.pet.x.toFixed(0)},${s.pet.y.toFixed(0)})`;
      }, () => sp);

      await step(S, 'S8 与物件互动：长椅坐下、花坛浇花、路灯开关、池塘看鱼', async () => {
        const out = [];
        await petIdle();
        await clickProp('bench');
        const sit = await until(async () => { const x = await sc(); return x.pet.act === 'sit' && x.pet.sitting ? x : null; }, 25000, 'sitting');
        await sp.waitForTimeout(400);
        await shot('s8-bench-sit');
        out.push(`长椅: act=${sit.pet.act} sitting=${sit.pet.sitting} state=${sit.pet.state} at (${sit.pet.drawX},${sit.pet.drawY})`);
        // roaming, she may already have watered them by herself (30% of her walks go to a prop)
        const before = await sc();
        await clickProp('flowers');
        const water = await until(async () => { const x = await sc(); return x.pet.act === 'water' && x.pet.state === 'play' ? x : null; }, 25000, 'watering');
        await sp.waitForTimeout(600);
        await shot('s8-flowers-water');
        const watered = await until(async () => { const x = await sc(); return x.flowers.watered ? x : null; }, 8000, 'flowers watered');
        await shot('s8-flowers-open');
        out.push(`花坛: watered before=${before.flowers.watered} state=${water.pet.state} → watered=${watered.flowers.watered}`);
        await sp.click('[data-phase="night"]');
        await settled();
        const lampBefore = (await sc()).lamp.on;
        await clickProp('lamp');
        await until(async () => { const x = await sc(); return x.pet.act === 'lamp' ? x : null; }, 25000, 'at the lamp');
        await shot('s8-lamp-reach');
        const lamp = await until(async () => { const x = await sc(); return x.lamp.on !== lampBefore ? x : null; }, 6000, 'the lamp switched');
        await sp.waitForTimeout(500);
        await shot('s8-lamp-off');
        out.push(`路灯: ${lampBefore} → ${lamp.lamp.on} (manual=${lamp.lamp.manual})`);
        await petIdle();
        await clickProp('lamp');
        await until(async () => { const x = await sc(); return x.lamp.on === lampBefore ? x : null; }, 30000, 'the lamp back on');
        await sp.click('[data-phase="day"]');
        await settled();
        await clickProp('pond');
        const look = await until(async () => { const x = await sc(); return x.pet.act === 'look' ? x : null; }, 25000, 'looking at the pond');
        await sp.waitForTimeout(300);
        await shot('s8-pond-look');
        out.push(`池塘: act=${look.pet.act} state=${look.pet.state}`);
        // the yard reports an act to main when it is done (sit: when she sits down), so `look` lands a few seconds later
        const want = ['sit', 'water', 'lamp', 'look'];
        const acts = await until(async () => { const a = (await dbg()).acts.map((x) => x.act); return want.every((w) => a.includes(w)) ? a : null; }, 15000, `main to record ${want.join(',')}`).catch(async () => (await dbg()).acts.map((x) => x.act));
        assert.ok(want.every((a) => acts.includes(a)), acts.join(','));
        out.push(`main 记录的互动：${acts.join('、')}`);
        return out.join(' | ');
      }, () => sp);

      await step(S, 'S9 拖拽：按住她拖动 → 拎起，松手落在可走格', async () => {
        await petIdle();
        const a = await sc();
        const b = a.pet.box;
        const from = await sp.evaluate(([x, y]) => window.__sceneToClient(x, y), [b.x + b.w / 2, b.y + b.h / 2]);
        const to = await sp.evaluate(([x, y]) => window.__sceneToClient(x, y), [100, 150]);
        await sp.mouse.move(from.x, from.y);
        await sp.mouse.down();
        for (let i = 1; i <= 10; i++) await sp.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
        const lifted = await sc();
        assert.equal(lifted.pet.mode, 'lifted');
        assert.equal(lifted.pet.state, 'lifted');
        await shot('s9-lifted');
        await sp.mouse.up();
        const s = await sc();
        assert.equal(s.pet.mode, 'idle');
        return `lifted at (${lifted.pet.x.toFixed(0)},${lifted.pet.y.toFixed(0)}) → dropped (${s.pet.x.toFixed(0)},${s.pet.y.toFixed(0)}) tile ${[Math.floor(s.pet.x / 16), Math.floor(s.pet.y / 16)]}`;
      }, () => sp);

      await step(S, 'S10 切换宠物包：设置窗口换成 gemini-pixel，小院里的她同步；设置窗口改天气，小院跟着变', async () => {
        const admin = await openAdminWindow(app, page, 'behavior');
        await admin.waitForSelector('[data-key="scene.weather"]', { timeout: 15000 });
        await admin.screenshot({ path: path.join(SHOTS, 's10-admin-behavior-scene-card.png') });
        const r = await admin.evaluate(() => window.petAdmin.switchCharacter('gemini-pixel', '小双'));
        assert.ok(r && r.ok !== false, JSON.stringify(r).slice(0, 200));
        const s = await until(async () => { const x = await sc(); return x.pet.ready && /gemini-pixel/.test(x.pet.url || '') ? x : null; }, 15000, 'the yard to redraw her');
        const w = await admin.evaluate(() => window.petAdmin.set('scene.weather', 'snow'));
        assert.ok(w && w.ok !== false, JSON.stringify(w).slice(0, 200));
        const s2 = await until(async () => { const x = await sc(); return x.weather.to === 'snow' && x.scene.weather === 'snow' ? x : null; }, 5000, 'snow from the settings window');
        await sp.waitForTimeout(3500);
        await shot('s10-gemini-snow');
        const back = await admin.evaluate(() => window.petAdmin.switchCharacter('claude-pixel'));
        assert.ok(back && back.ok !== false);
        await until(async () => { const x = await sc(); return /claude-pixel/.test(x.pet.url || '') ? x : null; }, 15000, 'back to claude-pixel');
        await admin.evaluate(() => window.petAdmin.set('scene.weather', 'clear'));
        return `pet url → ${s.pet.url.split('/').slice(-3).join('/')} (${s.pet.frameW}×${s.pet.frameH}) · settings window scene.weather=snow → yard ${s2.weather.to} · back to claude-pixel`;
      }, () => sp);

      await step(S, 'S11 Ctrl+Shift+H 关闭小院：桌面上的她回到原位', async () => {
        await sp.bringToFront();
        await sp.keyboard.press('Control+Shift+KeyH');
        const d = await until(async () => { const x = await dbg(); return !x.visible ? x : null; }, 5000, 'the yard to close');
        assert.equal(d.petVisible, true);
        assert.deepEqual(d.petBounds, facts.petBefore, 'she is back where she was');
        assert.equal(d.closes.slice(-1)[0], 'key');
        await page.screenshot({ path: path.join(SHOTS, 's11-back-on-desktop.png') });
        return `scene visible=${d.visible} pet visible=${d.petVisible} bounds same=${JSON.stringify(d.petBounds) === JSON.stringify(facts.petBefore)} closes=${d.closes}`;
      }, page);

      // set something to keep: 23:00 (night) and snow, then restart
      await step(S, 'S12 持久化：小院时刻 23:00、雪 → 重启后保留；Ctrl+Shift+H 在桌宠窗口打开小院', async () => {
        await page.evaluate(() => window.pet.debugSceneToggle('test'));
        await until(async () => (await dbg()).visible, 5000, 'reopen');
        await sp.click('[data-phase="night"]');
        await sp.click('[data-weather="snow"]');
        await until(async () => { const d = await dbg(); return d.settings.weather === 'snow' && d.settings.hour === 23 ? d : null; }, 5000, 'saved');
        const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).scene;
        assert.deepEqual(file, { followClock: false, hour: 23, weather: 'snow', autoWeather: false });
        await app.close();
        ({ app, page } = await launch(env));
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await page.waitForTimeout(800);
        await page.bringToFront();
        await page.mouse.move(110, 150);
        await page.keyboard.press('Control+Shift+KeyH');
        sp = await findScene(app);
        await sp.waitForFunction(() => window.__scene && window.__scene().ready && window.__scene().pet.ready, null, { timeout: 15000 });
        await sp.waitForTimeout(1500);
        const s = await sc();
        assert.equal(s.scene.hour, 23);
        assert.equal(s.scene.weather, 'snow');
        assert.equal(s.scene.followClock, false);
        assert.equal(s.phase, 'night');
        assert.ok(s.particles.snow > 80);
        assert.deepEqual((await dbg()).sources, ['key']);
        await shot('s12-after-restart');
        return `settings.json scene=${JSON.stringify(file)} · after restart (Ctrl+Shift+H): hour=${s.scene.hour} phase=${s.phase} weather=${s.scene.weather} snow=${s.particles.snow} card=「${await sp.textContent('#time-name')}」「${await sp.textContent('#weather-name')}」`;
      }, () => sp);
    } finally {
      await app.close().catch(() => {});
    }

    // S13: a recording of the whole loop, its own run (Playwright records every window of the app)
    await step(S, 'S13 录屏：黎明 → 白天 → 黄昏 → 夜晚开灯 → 下雨 → 下雪 → 她坐到长椅上', async () => {
      const vdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-scene-video-'));
      const r = await launch({ ...env, PIXELPET_TRAY: '0' }, { video: vdir, videoSize: { width: 960, height: 600 } });
      app = r.app; page = r.page;
      const t0 = Date.now();
      const chapters = [];
      const mark = (title) => chapters.push({ t: Math.round((Date.now() - t0) / 100) / 10, title });
      try {
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await page.evaluate(() => window.pet.debugSceneToggle('test'));
        sp = await findScene(app);
        await sp.waitForFunction(() => window.__scene && window.__scene().ready && window.__scene().pet.ready, null, { timeout: 15000 });
        await sp.click('[data-weather="clear"]');
        await sp.mouse.move(5, 300);
        for (const [ph, title] of [['dawn', '黎明'], ['day', '白天'], ['dusk', '黄昏'], ['night', '夜晚（路灯、窗户亮起，萤火虫）']]) { mark(title); await sp.click(`[data-phase="${ph}"]`); await sp.waitForTimeout(2600); }
        mark('小雨'); await sp.click('[data-weather="rain"]'); await sp.waitForTimeout(4500);
        mark('雪'); await sp.click('[data-weather="snow"]'); await sp.waitForTimeout(4500);
        mark('白天 · 晴，点长椅：她走过去坐下'); await sp.click('[data-phase="day"]'); await sp.click('[data-weather="clear"]');
        await clickProp('bench');
        await until(async () => { const x = await sc(); return x.pet.sitting ? x : null; }, 25000, 'sitting');
        await sp.waitForTimeout(2000);
        mark('点空地：她走过去'); await clickLogical(250, 40); await sp.waitForTimeout(5000);
      } finally {
        const video = sp && sp.video();
        await app.close().catch(() => {});
        if (video) {
          const src = await video.path();
          const dst = path.join(SHOTS, 'scene.webm');
          fs.copyFileSync(src, dst);
          fs.writeFileSync(path.join(SHOTS, 'scene.chapters.json'), JSON.stringify(chapters, null, 2));
          facts.video = { dst, bytes: fs.statSync(dst).size };
        }
      }
      assert.ok(facts.video && facts.video.bytes > 50000, 'a recording');
      return `${facts.video.dst} (${Math.round(facts.video.bytes / 1024)} KB) chapters=${chapters.map((c) => `${c.t}s ${c.title}`).join(' / ')}`;
    }, null);
  };
};
