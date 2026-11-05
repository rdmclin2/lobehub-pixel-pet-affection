// 小游戏 (docs/mini-games.md): a game pack bought in the store and played in the game window, driven as a user
// does — `xvfb-run -a node e2e/run.js game` (unset ELECTRON_RUN_AS_NODE first; no tokens: fake lh).
// The store's CDN is a local server holding the published archive (fetched from the real CDN by
// scripts/fetch-game-packs.js: the bytes and sha256 of src/core/game-catalog.json), and it also plays the games
// repository's catalog.json (PIXELPET_GAME_INDEX_URL), so G14 can publish a newer version.
//   G1  before any download: the tray item 「小游戏」 opens 商店 → 小游戏; the card is 未下载
//   G2  商店 → 小游戏 → 下载: progress, 已下载, the files in userData/games/pixel-yard
//   G3  开始玩: the game window opens with her in it, her desktop window hides; PixiJS (WebGL) draws the world,
//       her sprite is the claude-pixel pack's; frames keep coming
//   G4  time: ‹ › on the 天色 card walk 清晨 → 白天 → 黄昏 → 夜晚; the world darkens and turns blue at night,
//       windows and lamps light up, fireflies come out; the slider sets 18:00; 随时间流动 moves the clock
//   G5  weather: › walks 晴朗 → 多云 → 小雨 → 雷雨 → 下雪 → 起雾: clouds, rain lines, snow, fog
//   G6  she roams by herself (her position changes with nobody clicking)
//   G7  a click on the ground: she walks there (a flag) and arrives
//   G8  things: 菜地 three times → ripe → once more harvests (collect cabbage); 长椅 → she sits; 路灯 at night
//       → switches; 浆果丛 → collect berry; a firefly at night → caught
//   G9  today's 小事: done ones give affection (main's pet: +2 each), the 今日小事 card ticks them
//   G10 press and drag her: lifted, dropped on walkable ground
//   G11 Ctrl+W closes the game; her desktop window comes back; her panel ⌂ opens it again
//   G12 restart: time, weather, the crops and today's 小事 are kept
//   G14 a newer version is published (the games repository's catalog.json): 检查更新 → 有更新 with its notes,
//       the game window says 有新版本, 开源仓库 opens the repository; 更新 replaces it, her progress stays
//   G13 商店 → 小游戏 → 删除: gone from disk, the tray opens the store again
// Screenshots: out/e2e/mini-game/.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { clickAct } = require('./pet-panel');

const isGame = (p) => p.url().includes('/renderer/game/game.html');
const isAdmin = (p) => p.url().includes('admin-ui');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bright = (g) => (g.mul[0] + g.mul[1] + g.mul[2]) / 3;

module.exports = function miniGameScenario({ ROOT, OUT, FAKE_LH, step, launch, openAdminWindow }) {
  return async function miniGame() {
    const S = 'game';
    const SHOTS = path.join(OUT, 'mini-game');
    fs.mkdirSync(SHOTS, { recursive: true });
    // the store's CDN: the published archive, fetched from the real CDN and checked against the shipped index
    const cdn = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gamecdn-'));
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch-game-packs.js'), '--zips', cdn], { stdio: 'ignore' });
    const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'game-catalog.json'), 'utf8'));
    // the games repository's catalog.json as the app reads it: to start with, what the app shipped with
    let catalog = { ...bundled, games: bundled.games.map((x) => ({ ...x, published: '2026-11-05' })) };
    let served = 0;
    const server = http.createServer((req, res) => {
      const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (name === 'catalog.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); return; }
      const f = path.join(cdn, name);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      served += 1;
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gamefake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-game-'));
    const env = { PIXELPET_DATA_DIR: dataDir, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/games`, PIXELPET_GAME_INDEX_URL: `http://127.0.0.1:${server.address().port}/catalog.json` };
    let { app, page } = await launch(env);
    let gp = null;
    let admin = null;
    const g = () => gp.evaluate(() => window.__game());
    const T = (fn, arg) => gp.evaluate(fn, arg);
    const dbg = () => page.evaluate(() => window.pet.debugScene());
    const shot = (n) => gp.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const until = async (fn, ms = 10000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
        await wait(120);
      }
    };
    const findGame = async (a) => until(async () => a.windows().find(isGame) || null, 15000, 'the game window');
    const ready = async () => { await gp.waitForFunction(() => window.__game && window.__game().ready, null, { timeout: 30000 }); return g(); };
    // a real click at a world point (the camera looks there first)
    const clickWorld = async (x, y) => {
      // the cards cover the lower middle of the window: fold them and look straight at the point
      await T(([a, b]) => { window.__gameTest.showCard(null); window.__gameTest.look(a, b); }, [x, y]);
      await gp.waitForTimeout(80);
      const [sx, sy] = await T(([a, b]) => window.__gameTest.toScreen(a, b), [x, y]);
      await gp.mouse.click(sx, sy);
      return [sx, sy];
    };
    const objOf = async (id) => (await g()).objects.find((o) => o.id === id);
    // a point on the thing itself: sprites are hit by their box (middle), plots / pond by their polygon (centre)
    const clickObj = async (id) => {
      const o = await objOf(id);
      const m = require(path.join(ROOT, 'catalog', 'games', 'pixel-yard', 'manifest.json')).objects.find((x) => x.id === id);
      return m.hit ? clickWorld(o.x, o.y) : clickWorld(o.x, o.y - 10);
    };
    const usedEnd = (id, n0) => until(async () => { const s = await g(); return s.events.filter((e) => e.type === 'use-end' && e.obj === id).length > n0 ? s : null; }, 40000, `she finished using ${id}`).catch(async (e) => {
      const s = await g();
      throw new Error(`${e.message}; she is ${JSON.stringify({ x: Math.round(s.pet.x), y: Math.round(s.pet.y), mode: s.pet.mode, using: s.pet.using, goal: s.pet.goal, anim: s.pet.anim })}; last events ${JSON.stringify(s.events.slice(-4).map((v) => `${v.type}:${v.obj || v.item || ''}`))}; camera ${JSON.stringify(s.camera)}`);
    });
    const countEnd = async (id) => (await g()).events.filter((e) => e.type === 'use-end' && e.obj === id).length;
    const idle = async () => {
      await T(() => window.__gameTest.roam(false));
      const s = await g();
      if (s.pet.mode === 'use' || s.pet.mode === 'walk') await T(([x, y]) => window.__gameTest.goTo(x, y), [s.pet.x + 6, s.pet.y]);
      return until(async () => { const v = await g(); return v.pet.mode === 'idle' ? v : null; }, 20000, 'her to stand idle');
    };
    const collected = async (item) => (await g()).events.filter((e) => e.type === 'collect' && e.item === item).length;
    const catchFly = async () => {
      await idle();
      await T(() => { window.__gameTest.setHour(23); window.__gameTest.setWeather('clear'); });
      for (let k = 0; k < 6; k++) {
        const n = await collected('firefly');
        const s = await until(async () => { const v = await g(); return v.flies.length ? v : null; }, 8000, 'a lit firefly');
        // the one nearest her
        const f = s.flies.sort((a, b) => Math.hypot(a.x - s.pet.x, a.y - s.pet.y) - Math.hypot(b.x - s.pet.x, b.y - s.pet.y))[0];
        await T(([a, b]) => { window.__gameTest.showCard(null); window.__gameTest.look(a, b); }, [f.x, f.y]);
        await gp.waitForTimeout(60);
        const live = (await g()).flies.find((x) => x.i === f.i) || f;
        const [sx, sy] = await T(([a, b]) => window.__gameTest.toScreen(a, b), [live.x, live.y]);
        await gp.mouse.click(sx, sy);
        const got = await until(async () => ((await collected('firefly')) > n || (await g()).pet.mode === 'idle' ? true : null), 20000, 'the firefly run').then(async () => (await collected('firefly')) > n);
        if (got) return [live.x, live.y];
      }
      throw new Error('no firefly caught in six tries');
    };
    // today's 小事, each done the way a user does it
    const doQuest = async (id) => {
      const useOnce = async (obj) => { const n = await countEnd(obj); await clickObj(obj); await usedEnd(obj, n); };
      await idle();
      if (id === 'water') { await T(() => window.__gameTest.plots(0)); await useOnce('plot-b'); await useOnce('plot-b'); }
      else if (id === 'harvest') { await T(() => window.__gameTest.plots(3)); await useOnce('plot-b'); }
      else if (id === 'berry') { await T(() => { window.__gameTest.resetBerries(); }); await useOnce('berries'); }
      else if (id === 'lamp') { await T(() => window.__gameTest.setHour(21)); await gp.waitForTimeout(500); await useOnce('lamp'); }
      else if (id === 'rain') { await T(() => window.__gameTest.setWeather('rain')); await useOnce('pond'); await T(() => window.__gameTest.setWeather('clear')); }
      else if (id === 'bench') await useOnce('bench');
      else if (id === 'fireflies') { for (let i = 0; i < 3; i++) await catchFly(); }
      else if (id === 'mail') await useOnce('mailbox');
      else if (id === 'well') await useOnce('well');
      else throw new Error(`no way to do quest ${id}`);
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

      await step(S, 'G1 还没下载：托盘「小游戏」打开 商店 → 小游戏，卡片是「未下载」', async () => {
        const tray = await page.evaluate(() => window.pet.debugTray());
        assert.ok(tray.items.includes('小游戏'), `tray: ${tray.items.join(' / ')}`);
        await page.evaluate(() => window.pet.debugTrayClick('小游戏'));
        admin = await until(async () => app.windows().find(isAdmin) || null, 30000, 'the settings window');
        await admin.waitForSelector('[data-path="/store/games"]', { timeout: 20000 });
        await admin.waitForSelector('[data-store-game="pixel-yard"]', { timeout: 15000 });
        const card = await admin.locator('[data-store-game="pixel-yard"]').getAttribute('data-game-state');
        assert.equal(card, 'remote');
        assert.equal((await dbg()).visible, false, 'no game window without a game');
        await admin.screenshot({ path: path.join(SHOTS, 'g1-store-remote.png') });
        return `tray → #/store/games, card ${card}`;
      });

      await step(S, 'G2 下载：进度 → 已下载，文件在 userData/games/pixel-yard', async () => {
        await admin.click('[data-game-download="pixel-yard"]');
        await until(async () => (await admin.locator('[data-store-game="pixel-yard"]').getAttribute('data-game-state')) === 'installed', 30000, 'installed');
        const dir = path.join(dataDir, 'games', 'pixel-yard');
        const files = fs.readdirSync(dir).sort();
        assert.deepEqual(files, ['.catalog.json', 'atlas.webp', 'manifest.json', 'sprites.json', 'terrain.webp']);
        assert.ok(served >= 1, 'fetched from the store server');
        await admin.screenshot({ path: path.join(SHOTS, 'g2-store-installed.png') });
        return `installed: ${files.join(', ')}`;
      });

      await step(S, 'G3 开始玩：游戏窗口打开、她在里面，桌面上的她隐藏；Pixi（WebGL）在画、她是克洛蒂的像素包', async () => {
        await admin.click('[data-game-play="pixel-yard"]');
        gp = await findGame(app);
        const s = await ready();
        const d = await dbg();
        assert.equal(d.visible, true);
        assert.equal(d.petVisible, false, 'her desktop window hid');
        assert.equal(d.game, 'pixel-yard');
        assert.equal(s.id, 'pixel-yard');
        assert.match(String(s.renderer), /webgl/i);
        assert.equal(s.pet.sprite, 'sprites');
        assert.equal(s.pet.visible, true);
        const f0 = s.frames;
        await gp.waitForTimeout(1500);
        const s2 = await g();
        assert.ok(s2.frames - f0 > 20, `frames keep coming (${s2.frames - f0} in 1.5 s, ${s2.fps} fps)`);
        await T(() => window.__gameTest.setHour(12));
        await gp.waitForTimeout(600);
        await shot('g3-open');
        return `renderer ${s.renderer}, ${s2.fps} fps, walkable cells ${s.walkable}, title ${d.title}`;
      });

      await step(S, 'G4 时段：‹ › 走一圈清晨→白天→黄昏→夜晚；夜里变暗偏蓝、窗户路灯亮、萤火虫出来；滑块 18:00；随时间流动', async () => {
        // 随时间流动 off first so the clock stands
        if ((await g()).scene.dayFlow) await gp.click('#day-flow');
        await T(() => window.__gameTest.setHour(7));
        await gp.waitForTimeout(300);
        const seen = [];
        const grades = {};
        for (let i = 0; i < 4; i++) {
          const s = await until(async () => { const v = await g(); const d = (((v.hour - v.target) % 24) + 24) % 24; return Math.min(d, 24 - d) < 0.03 ? v : null; }, 8000, 'the hour to settle');
          seen.push(s.phase);
          grades[s.phase] = s;
          await shot(`g4-${s.phase}`);
          await gp.click('#time-next');
          await gp.waitForTimeout(200);
        }
        assert.deepEqual(seen, ['dawn', 'day', 'dusk', 'night']);
        const day = grades.day.grade;
        const night = grades.night.grade;
        assert.ok(bright(night) < bright(day) * 0.6, `night darker (${bright(night).toFixed(2)} vs ${bright(day).toFixed(2)})`);
        assert.ok(night.mul[2] > night.mul[0], 'night is bluish');
        assert.ok(grades.dusk.grade.mul[0] > grades.dusk.grade.mul[2] * 1.5, 'dusk is warm');
        assert.ok(night.lights > 0.9 && day.lights === 0, 'lights at night only');
        assert.ok(grades.night.lampLit && !grades.day.lampLit, 'the lamp follows the dark');
        await until(async () => (await g()).counts.fliesLit > 3, 6000, 'fireflies at night');
        await until(async () => (await gp.textContent('#time-name')) === '清晨', 6000, 'the card to show 清晨 again (wrapped round)');
        // the slider
        await gp.locator('#time-slider').fill('18');
        await gp.locator('#time-slider').dispatchEvent('change');
        const s18 = await until(async () => { const v = await g(); return Math.abs(v.hour - 18) < 0.05 ? v : null; }, 4000, 'the slider hour');
        assert.equal(s18.phase, 'dusk');
        assert.equal(await gp.textContent('#time-clock'), '18:00');
        // 随时间流动: a game day in 24 minutes, so a minute of game time every 2.5 s
        await gp.click('#day-flow');
        const h0 = (await g()).hour;
        await gp.waitForTimeout(3000);
        const h1 = (await g()).hour;
        assert.ok(h1 - h0 > 0.01 && h1 - h0 < 0.1, `time flows (${h0.toFixed(3)} → ${h1.toFixed(3)})`);
        await gp.click('#day-flow');
        return `phases ${seen.join(' → ')}; brightness day ${bright(day).toFixed(2)} / dusk ${bright(grades.dusk.grade).toFixed(2)} / night ${bright(night).toFixed(2)}; flowing ${(h1 - h0) * 60} game min in 3 s`;
      });

      await step(S, 'G5 天气：› 走一圈 晴朗→多云→小雨→雷雨→下雪→起雾，云 / 雨 / 雪 / 雾都出现', async () => {
        await T(() => { window.__gameTest.setHour(12); window.__gameTest.setWeather('clear'); });
        const got = {};
        for (let i = 0; i < 6; i++) {
          await gp.waitForTimeout(3600); // the 3 s fade
          const s = await g();
          got[s.weather.to] = s.counts;
          await shot(`g5-${s.weather.to}`);
          await gp.click('#weather-next');
        }
        assert.deepEqual(Object.keys(got), ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog']);
        assert.equal(got.clear.drops + got.clear.flakes, 0);
        assert.ok(got.cloudy.clouds >= 3, `clouds ${got.cloudy.clouds}`);
        assert.ok(got.rain.drops > 100, `rain ${got.rain.drops}`);
        assert.ok(got.storm.drops > got.rain.drops, 'a storm rains harder');
        assert.ok(got.snow.flakes > 100, `snow ${got.snow.flakes}`);
        assert.ok(got.fog.fog > 0.3, `fog ${got.fog.fog}`);
        assert.equal(await gp.textContent('#weather-name'), '晴朗', 'wrapped back');
        return JSON.stringify(got);
      });

      await step(S, 'G6 她自己逛：没人点，她的位置会变', async () => {
        await T(() => window.__gameTest.setWeather('clear'));
        await idle(); // not in the middle of a 36 s sit
        await T(() => { window.__gameTest.roam(true); window.__gameTest.follow(true); });
        const a = (await g()).pet;
        const s = await until(async () => { const v = await g(); return v.pet.walked - a.walked > 40 ? v : null; }, 60000, 'her to roam');
        return `walked ${Math.round(s.pet.walked - a.walked)} px by herself, now at (${Math.round(s.pet.x)}, ${Math.round(s.pet.y)})`;
      });

      await step(S, 'G7 点地面：她走过去（小旗），到达', async () => {
        const here = await idle();
        // somewhere away from her (a click on her is a pat, not a walk)
        const target = here.pet.x < 450 ? [640, 530] : [300, 420];
        await clickWorld(...target);
        const s1 = await g();
        assert.equal(s1.pet.mode, 'walk');
        await shot('g7-walking');
        const s2 = await until(async () => { const v = await g(); return v.pet.mode === 'idle' && Math.hypot(v.pet.x - target[0], v.pet.y - target[1]) < 12 ? v : null; }, 20000, 'her to arrive');
        return `walked to (${Math.round(s2.pet.x)}, ${Math.round(s2.pet.y)})`;
      });

      await step(S, 'G8 互动：浇菜三次→熟了→收菜；坐长椅；夜里拍路灯开关；摘浆果；抓萤火虫', async () => {
        await T(() => window.__gameTest.plots(0));
        for (let i = 0; i < 3; i++) {
          const n = await countEnd('plot-a');
          await idle();
          await clickObj('plot-a');
          await gp.waitForTimeout(200);
          const st0 = await g();
          assert.ok(st0.pet.goal || st0.pet.using === 'plot-a', `the click on 菜地 sent her there (${JSON.stringify(st0.pet)}, hover label ${await gp.textContent('#tip')})`);
          await usedEnd('plot-a', n);
        }
        let s = await g();
        assert.equal(s.world.plots['plot-a'].stage, 3, 'ripe after three waterings');
        assert.match(s.objects.find((o) => o.id === 'plot-a').label, /收菜/);
        await shot('g8-ripe');
        const n = await countEnd('plot-a');
        await clickObj('plot-a');
        s = await usedEnd('plot-a', n);
        assert.equal(s.world.plots['plot-a'].stage, 0, 'harvested');
        assert.ok(s.events.some((e) => e.type === 'collect' && e.item === 'cabbage'));
        // the bench
        const nb = await countEnd('bench');
        await clickObj('bench');
        await until(async () => { const v = await g(); return v.pet.using === 'bench' ? v : null; }, 20000, 'her to sit');
        await gp.waitForTimeout(400);
        await shot('g8-bench');
        assert.equal((await g()).pet.anim, 'sit');
        await idle();
        assert.equal(await countEnd('bench'), nb, 'got up early: not counted as done');
        // the lamp at night
        await T(() => window.__gameTest.setHour(22));
        await gp.waitForTimeout(800);
        const was = (await g()).lampLit;
        const nl = await countEnd('lamp');
        await clickObj('lamp');
        s = await usedEnd('lamp', nl);
        assert.equal(s.lampLit, !was, 'the lamp switched');
        await shot('g8-lamp');
        // berries
        await clickObj('berries');
        s = await until(async () => { const v = await g(); return v.events.some((e) => e.type === 'collect' && e.item === 'berry') ? v : null; }, 30000, 'berries picked');
        // a firefly at night: click one, she runs there and catches it
        const caught = await catchFly();
        s = await g();
        await shot('g8-firefly');
        return `crops 0→3→harvest (cabbage), bench sit, lamp ${was} → ${s.lampLit}, berries picked, firefly caught at (${caught.map(Math.round).join(', ')}); items ${JSON.stringify(s.items)}`;
      });

      await step(S, 'G9 今日小事：一件件做完，每件完成弹提示、给好感（+2，每天最多三次），卡片打勾', async () => {
        const start = await g();
        const log = [];
        for (const q of start.quests) {
          if (q.done) { log.push(`✓ ${q.title}（G8 里已完成）`); continue; }
          const a0 = (await dbg()).affection;
          await doQuest(q.id);
          const s = await until(async () => { const v = await g(); return v.quests.find((x) => x.id === q.id).done ? v : null; }, 15000, `quest ${q.id} done`);
          const a1 = (await dbg()).affection;
          assert.ok(a1 - a0 >= 2, `${q.title}: affection ${a0} → ${a1}`);
          log.push(`✓ ${q.title}：好感 ${a0} → ${a1}`);
          void s;
        }
        const toast = await gp.textContent('#toast');
        await gp.click('#tb-quests');
        await gp.waitForTimeout(400);
        await shot('g9-quests');
        assert.equal(await gp.locator('#quest-list li.done').count(), start.quests.length);
        assert.equal(await gp.textContent('#quest-sum'), `${start.quests.length}/${start.quests.length}`);
        const items = await gp.textContent('#items');
        await gp.click('#tb-quests');
        return `${log.join('；')}；最后的提示「${toast}」；${items}`;
      });

      await step(S, 'G10 按住拖动她：拎起，松手落在能走的地方', async () => {
        await idle();
        await T(() => { const p = window.__game().pet; window.__gameTest.showCard(null); window.__gameTest.look(p.x, p.y); });
        await gp.waitForTimeout(100);
        const s = await g();
        const [sx, sy] = s.pet.screen;
        await gp.mouse.move(sx, sy - 15);
        await gp.mouse.down();
        await gp.mouse.move(sx + 30, sy - 25, { steps: 4 });
        await gp.mouse.move(sx + 90, sy - 40, { steps: 6 });
        const lifted = await g();
        assert.equal(lifted.pet.mode, 'lifted');
        await shot('g10-lifted');
        await gp.mouse.up();
        const after = await until(async () => { const v = await g(); return v.pet.mode === 'idle' ? v : null; }, 4000, 'dropped');
        assert.ok(Math.hypot(after.pet.x - s.pet.x, after.pet.y - s.pet.y) > 20, 'she moved with the drag');
        return `(${Math.round(s.pet.x)}, ${Math.round(s.pet.y)}) → (${Math.round(after.pet.x)}, ${Math.round(after.pet.y)})`;
      });

      await step(S, 'G11 Ctrl+W 关闭：桌面上的她回来；她的面板 ⌂ 再打开', async () => {
        await gp.keyboard.press('Control+KeyW');
        await until(async () => { const d = await dbg(); return !d.visible && d.petVisible ? d : null; }, 6000, 'closed, pet back');
        await clickAct(page, 'scene');
        await until(async () => (await dbg()).visible, 6000, 'reopened from ⌂');
        const d = await dbg();
        assert.ok(d.sources.includes('panel'));
        return `closes ${d.closes.join(',')}, sources ${d.sources.join(',')}`;
      });

      await step(S, 'G12 重启：时段、天气、菜地和今日小事都保留', async () => {
        await T(() => { window.__gameTest.setHour(20.5); window.__gameTest.setWeather('snow'); window.__gameTest.plots(2); });
        await gp.waitForTimeout(1200);
        const before = await g();
        await gp.keyboard.press('Control+KeyW');
        await wait(600);
        await app.close();
        ({ app, page } = await launch(env));
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await page.evaluate(() => window.pet.debugSceneToggle('test'));
        gp = await findGame(app);
        const s = await ready();
        assert.equal(s.scene.weather, 'snow');
        assert.equal(s.scene.hour, 20.5);
        assert.equal(s.world.plots['plot-a'].stage, 2);
        assert.deepEqual(s.quests.map((q) => [q.id, q.done]), before.quests.map((q) => [q.id, q.done]));
        await gp.waitForTimeout(3500);
        await shot('g12-restored');
        return `hour ${s.scene.hour}, weather ${s.scene.weather}, plot-a stage ${s.world.plots['plot-a'].stage}, quests ${s.quests.filter((q) => q.done).length} done`;
      });

      await step(S, 'G14 发布新版本：检查更新 → 有更新和更新说明；游戏里提示有新版本；开源仓库；更新后进度还在', async () => {
        // the games repository publishes 1.0.1: the same pack, a higher version, new notes
        const old = bundled.games.find((x) => x.id === 'pixel-yard');
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gamev2-'));
        execFileSync('unzip', ['-q', path.join(cdn, old.file), '-d', work]);
        const mf = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
        fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ ...mf, version: '1.0.1' }, null, 2));
        const { zip, sha256 } = require(path.join(ROOT, 'scripts', 'build-character-catalog'));
        const file = 'pixel-yard-1.0.1.zip';
        zip(work, path.join(cdn, file));
        const notes = '测试发布：小院的路灯更亮了一点，浆果长回来更快。';
        catalog = { ...catalog, games: [{ ...old, version: '1.0.1', file, bytes: fs.statSync(path.join(cdn, file)).size, sha256: sha256(path.join(cdn, file)), changelog: notes, published: '2026-11-06' }] };
        const stageBefore = (await g()).world.plots['plot-a'].stage;
        await gp.keyboard.press('Control+KeyW');
        admin = await openAdminWindow(app, page, 'store/games');
        await admin.waitForSelector('[data-game-check]', { timeout: 15000 });
        await admin.click('[data-game-check]');
        await until(async () => (await admin.locator('[data-store-game="pixel-yard"]').getAttribute('data-game-state')) === 'update', 15000, '有更新');
        const meta = await admin.textContent('[data-store-game-meta="pixel-yard"]');
        assert.match(meta, /v1\.0\.0 → v1\.0\.1/);
        assert.equal((await admin.textContent('[data-game-changelog="pixel-yard"]')).includes(notes), true, 'the notes are on the card');
        assert.equal(await admin.textContent('[data-game-tag="pixel-yard"]'), '有更新');
        await admin.locator('[data-game-update="pixel-yard"]').scrollIntoViewIfNeeded();
        await admin.waitForTimeout(400);
        await admin.screenshot({ path: path.join(SHOTS, 'g14-store-update.png') });
        // 开源仓库
        await admin.click('[data-game-repo="pixel-yard"]');
        const links = await until(async () => { const l = await page.evaluate(() => window.pet.debugOpenedLinks()); return l.some((u) => u.includes('github.com/rdmclin2/pixel-pet-mini-games')) ? l : null; }, 5000, 'the repository link');
        // the game window: 有新版本
        await admin.click('[data-game-play="pixel-yard"]');
        gp = await findGame(app);
        await until(async () => { const v = await g(); return v.update && v.update.to === '1.0.1' ? v : null; }, 8000, 'the update chip');
        assert.equal(await gp.isVisible('#update-chip'), true);
        assert.match(await gp.textContent('#update-chip'), /有新版本 v1\.0\.1/);
        assert.equal(await gp.textContent('#game-version'), 'v1.0.0');
        await gp.screenshot({ path: path.join(SHOTS, 'g14-game-chip.png') });
        await gp.keyboard.press('Control+KeyW');
        // 更新
        await admin.click('[data-game-update="pixel-yard"]');
        await until(async () => (await admin.locator('[data-store-game="pixel-yard"]').getAttribute('data-game-state')) === 'installed', 30000, 'updated');
        const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'games', 'pixel-yard', 'manifest.json'), 'utf8')).version;
        assert.equal(onDisk, '1.0.1');
        await admin.locator('[data-game-play="pixel-yard"]').scrollIntoViewIfNeeded();
        await admin.waitForTimeout(500);
        await admin.screenshot({ path: path.join(SHOTS, 'g14-store-updated.png') });
        await admin.click('[data-game-play="pixel-yard"]');
        gp = await findGame(app);
        await gp.waitForFunction(() => window.__game && window.__game().ready && window.__game().version === '1.0.1', null, { timeout: 20000 });
        const s = await g();
        assert.equal(s.update, null, 'no chip once up to date');
        assert.equal(await gp.isVisible('#update-chip'), false);
        assert.equal(s.world.plots['plot-a'].stage, stageBefore, 'her progress (the crops) survived the update');
        return `checked → 有更新 (${meta}), notes shown, repo link ${links.filter((u) => u.includes('pixel-pet-mini-games')).pop()}, chip「有新版本 v1.0.1」, updated on disk to ${onDisk}, plot-a stage ${s.world.plots['plot-a'].stage} kept`;
      });

      await step(S, 'G13 商店里删除：文件没了，托盘再点就打开商店', async () => {
        await gp.keyboard.press('Control+KeyW');
        await admin.evaluate(() => { location.hash = '/store/games'; });
        await admin.waitForSelector('[data-game-remove="pixel-yard"]', { timeout: 15000 });
        await admin.click('[data-game-remove="pixel-yard"]');
        await until(async () => admin.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].some((b) => (b.textContent || '').trim() === '删除小游戏')), 8000, 'the confirm dialog');
        await admin.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].filter((b) => (b.textContent || '').trim() === '删除小游戏').pop().click());
        await until(async () => (await admin.locator('[data-store-game="pixel-yard"]').getAttribute('data-game-state')) === 'remote', 10000, 'removed');
        assert.equal(fs.existsSync(path.join(dataDir, 'games', 'pixel-yard')), false);
        const r = await page.evaluate(() => window.pet.debugSceneToggle('test'));
        assert.equal(r.reason, 'no-game');
        return 'deleted; opening again goes to the store';
      });
    } finally {
      // the app may hang on quit with the settings window open: give it 10 s, then end it
      await Promise.race([app.close().catch(() => {}), wait(10000)]);
      try { app.process().kill('SIGKILL'); } catch { /* gone */ }
      server.close();
      server.closeAllConnections();
    }
  };
};
