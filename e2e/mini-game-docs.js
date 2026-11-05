// 小游戏 · 文档截图与录屏 (not in `all`): the pictures and the clip in docs/mini-games.md, made the way a user sees
// them — the store, the game window, real clicks on the canvas and the 天色 card.
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js gamedocs   (GAMEDOCS_ONLY=clip: the store and the clip only; =cover: the store picture only)
// Out: docs/img/mini-games/
//   dawn-clear day-clear dusk-cloudy night-clear night-rain storm snow fog .webp
//   act-water act-ripe act-bench act-lamp act-firefly quests .webp
//   store-remote store-installed .webp                    商店 → 小游戏（下载前 / 下载后）
//   mini-game-demo.mp4 (+ .gif, .chapters.json)              ≥10 s 录屏（ffmpeg x11grab，带鼠标指针）
// and cover.png, the store card's picture (copy it to the games repository's games/pixel-yard/cover.webp).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const isGame = (p) => p.url().includes('/renderer/game/game.html');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function gameDocsScenario({ ROOT, FAKE_LH, step, launch, openAdminWindow }) {
  return async function gameDocs() {
    const S = 'gamedocs';
    const DIR = path.join(ROOT, 'docs', 'img', 'mini-games');
    fs.mkdirSync(DIR, { recursive: true });
    const cdn = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gdcdn-'));
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch-game-packs.js'), '--zips', cdn], { stdio: 'ignore' });
    const server = http.createServer((req, res) => {
      const f = path.join(cdn, path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gdfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const env = { PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gdoc-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '0', PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/games` };
    const { app, page } = await launch(env);
    let gp = null;
    let ff = null;
    const chapters = [];
    const t0 = { v: 0 };
    const mark = (label) => chapters.push({ t: Math.round((Date.now() - t0.v) / 100) / 10, label });
    const g = () => gp.evaluate(() => window.__game());
    const T = (fn, arg) => gp.evaluate(fn, arg);
    // a screenshot as WebP (a tenth of the PNG): Playwright writes PNG, ffmpeg turns it into WebP
    const webp = (png) => { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', png, '-quality', '88', png.replace(/\.png$/, '.webp')]); fs.rmSync(png); };
    const shot = async (n) => { const f = path.join(DIR, `${n}.png`); await gp.screenshot({ path: f }); if (n !== 'cover') webp(f); };
    const until = async (fn, ms, what) => { const s = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - s > ms) throw new Error(`timed out: ${what}`); await wait(120); } };
    const manifest = JSON.parse(execFileSync('unzip', ['-p', path.join(cdn, fs.readdirSync(cdn).find((f) => f.startsWith('pixel-yard-'))), 'manifest.json']).toString());
    const def = (id) => manifest.objects.find((o) => o.id === id);
    // a real (gliding) click at a world point; with `card` the camera keeps the point above the cards
    const clickWorld = async (x, y, { glide = false, fold = true } = {}) => {
      if (fold) await T(([a, b]) => { window.__gameTest.showCard(null); window.__gameTest.look(a, b); }, [x, y]);
      await wait(80);
      const [sx, sy] = await T(([a, b]) => window.__gameTest.toScreen(a, b), [x, y]);
      if (glide) { await gp.mouse.move(sx, sy, { steps: 14 }); await wait(250); }
      await gp.mouse.click(sx, sy);
    };
    const clickObj = async (id, opts) => { const o = def(id); const [x, y] = o.hit ? [(await g()).objects.find((v) => v.id === id).x, (await g()).objects.find((v) => v.id === id).y] : [o.x, o.y - 10]; return clickWorld(x, y, opts); };
    const ends = async (id) => (await g()).events.filter((e) => e.type === 'use-end' && e.obj === id).length;
    const useAndWait = async (id, opts) => { const n = await ends(id); await clickObj(id, opts); return until(async () => ((await ends(id)) > n ? g() : null), 45000, `use ${id}`); };
    const free = async () => {
      await T(() => window.__gameTest.roam(false));
      const s = await g();
      if (s.pet.mode !== 'idle') await T(([x, y]) => window.__gameTest.goTo(x, y), [s.pet.x + 6, s.pet.y]);
      return until(async () => { const v = await g(); return v.pet.mode === 'idle' ? v : null; }, 20000, 'idle');
    };
    // a time × weather view: she stands on the lawn in front of the cottage, the 天色 card open
    const combo = async (name, hour, weather, { card = true, at = [600, 330] } = {}) => {
      await T(([h, w]) => { window.__gameTest.setHour(h); window.__gameTest.setWeather(w); }, [hour, weather]);
      await T(([x, y, c]) => { window.__gameTest.showCard(c ? 'sky' : null); window.__gameTest.look(x, y + (c ? 110 : 0), 1.25); }, [at[0], at[1], card]);
      await wait(3600);
      await gp.mouse.move(4, 4);
      await shot(name);
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

      await step(S, 'D1 商店 → 小游戏：下载前、下载后', async () => {
        const admin = await openAdminWindow(app, page, 'store/games');
        await admin.setViewportSize({ width: 1080, height: 720 }).catch(() => {});
        await admin.waitForSelector('[data-store-game="pixel-yard"] img, [data-store-game="pixel-yard"]', { timeout: 15000 });
        await admin.waitForTimeout(800);
        await admin.screenshot({ path: path.join(DIR, 'store-remote.png') });
        webp(path.join(DIR, 'store-remote.png'));
        await admin.click('[data-game-download="pixel-yard"]');
        await until(async () => (await admin.locator('[data-store-game="pixel-yard"]').getAttribute('data-game-state')) === 'installed', 30000, 'installed');
        await admin.waitForTimeout(600);
        await admin.screenshot({ path: path.join(DIR, 'store-installed.png') });
        webp(path.join(DIR, 'store-installed.png'));
        // the game's page (a click on the card's picture)
        await admin.click('[data-game-open="pixel-yard"]');
        await admin.waitForSelector('[data-game-detail="pixel-yard"]', { timeout: 10000 });
        await admin.waitForTimeout(800);
        await admin.screenshot({ path: path.join(DIR, 'store-detail.png') });
        webp(path.join(DIR, 'store-detail.png'));
        // 预览: scrolled into view, then one opened large
        await admin.locator('[data-game-shots]').scrollIntoViewIfNeeded();
        await admin.waitForTimeout(600);
        await admin.screenshot({ path: path.join(DIR, 'store-shots.png') });
        webp(path.join(DIR, 'store-shots.png'));
        await admin.click('[data-game-shot="2"] img');
        await admin.waitForTimeout(1200);
        await admin.screenshot({ path: path.join(DIR, 'store-shot-open.png') });
        webp(path.join(DIR, 'store-shot-open.png'));
        await admin.keyboard.press('Escape');
        await admin.waitForTimeout(400);
        await admin.evaluate(() => { location.hash = '/store/games'; });
        await admin.waitForSelector('[data-game-play="pixel-yard"]', { timeout: 10000 });
        await admin.click('[data-game-play="pixel-yard"]');
        gp = await until(async () => app.windows().find(isGame) || null, 15000, 'the game window');
        await gp.waitForFunction(() => window.__game && window.__game().ready && window.__game().pet.sprite === 'sprites', null, { timeout: 30000 });
        await T(() => { window.__gameTest.roam(false); window.__gameTest.follow(false); });
        if ((await g()).scene.dayFlow) await gp.click('#day-flow');
        await T(([x, y]) => window.__gameTest.goTo(x, y), [600, 330]);
        await until(async () => { const v = await g(); return v.pet.mode === 'idle' && Math.hypot(v.pet.x - 600, v.pet.y - 330) < 10 ? v : null; }, 20000, 'her on the lawn');
        return 'store-remote store-installed store-detail store-shots store-shot-open';
      });

      const only = process.env.GAMEDOCS_ONLY || '';
      if (only !== 'clip') await step(S, 'D2 时段 × 天气（她站在小屋前的草地上）', async () => {
        if (only !== 'cover') {
        await combo('day-clear', 12, 'clear');
        await combo('dawn-clear', 7, 'clear');
        await combo('dusk-cloudy', 18, 'cloudy');
        await combo('night-clear', 23, 'clear');
        await combo('night-rain', 23, 'rain');
        await combo('storm', 15, 'storm');
        await combo('snow', 10, 'snow');
        await combo('fog', 8, 'fog');
        }
        // the store card's picture: the day view without the cards, 640×400
        // the world alone: no title bar, toolbar or cards on the store picture
        await T(() => document.querySelectorAll('.titlebar, .toolbar, .card, #tip, #bubble').forEach((e) => { e.style.visibility = 'hidden'; }));
        await combo('cover', 12, 'clear', { card: false, at: [560, 360] });
        await T(() => document.querySelectorAll('.titlebar, .toolbar, .card, #tip, #bubble').forEach((e) => { e.style.visibility = ''; }));
        // the cover lives in the games repository (games/pixel-yard/cover.webp); the app ships a copy of it
        // through scripts/sync-game-catalog.js — this one is written next to the docs pictures to copy over
        const cover = path.join(DIR, 'cover.png');
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', cover, '-vf', 'scale=640:400:flags=lanczos', '-quality', '86', path.join(os.tmpdir(), 'pixel-yard-cover.webp')]);
        fs.rmSync(cover);
        return 'dawn / day / dusk-cloudy / night / night-rain / storm / snow / fog + the store picture';
      });

      if (!only) await step(S, 'D3 她在做事：浇菜、菜熟了、坐长椅、夜里拍路灯、抓萤火虫、今日小事', async () => {
        await T(() => { window.__gameTest.setHour(10); window.__gameTest.setWeather('clear'); window.__gameTest.plots(1); });
        await free();
        await clickObj('plot-a');
        await until(async () => ((await g()).pet.using === 'plot-a' ? true : null), 20000, 'watering');
        await wait(900);
        await shot('act-water');
        await until(async () => ((await g()).pet.mode === 'idle' ? true : null), 10000, 'done watering');
        await T(() => window.__gameTest.plots(3));
        await T(() => { const p = window.__game().objects.find((o) => o.id === 'plot-a'); window.__gameTest.look(p.x, p.y - 10, 1.8); });
        await wait(600);
        await shot('act-ripe');
        await clickObj('bench');
        await until(async () => ((await g()).pet.using === 'bench' ? true : null), 25000, 'sitting');
        await T(() => window.__gameTest.look(300, 320, 1.8));
        await wait(1200);
        await shot('act-bench');
        await free();
        await T(() => window.__gameTest.setHour(22));
        await wait(800);
        await clickObj('lamp');
        await until(async () => ((await g()).pet.using === 'lamp' ? true : null), 25000, 'at the lamp');
        await T(() => window.__gameTest.look(552, 230, 1.8));
        await wait(500);
        await shot('act-lamp');
        await free();
        // a firefly: the nearest lit one, clicked; the shot while she runs there
        const s = await until(async () => { const v = await g(); return v.flies.length ? v : null; }, 8000, 'fireflies');
        const f = s.flies.sort((a, b) => Math.hypot(a.x - s.pet.x, a.y - s.pet.y) - Math.hypot(b.x - s.pet.x, b.y - s.pet.y))[0];
        await clickWorld(f.x, f.y);
        await wait(700);
        await T(([x, y]) => window.__gameTest.look(x, y, 1.6), [f.x, f.y]);
        await shot('act-firefly');
        await until(async () => ((await g()).pet.mode === 'idle' ? true : null), 20000, 'the run');
        await T(() => { window.__gameTest.setHour(16); window.__gameTest.showCard('quests'); window.__gameTest.look(520, 520, 1.25); });
        await wait(3600);
        await shot('quests');
        return 'act-water act-ripe act-bench act-lamp act-firefly quests';
      });

      if (only !== 'cover') await step(S, 'D4 录屏（≥10 s，带鼠标）：自己逛 → 点地 → 点她 → 浇菜 → 拖时间滑块入夜 → 换天气 → 抓萤火虫', async () => {
        await T(() => { window.__gameTest.setHour(9); window.__gameTest.setWeather('clear'); window.__gameTest.plots(0); window.__gameTest.showCard('sky'); window.__gameTest.follow(true); window.__gameTest.roam(true); });
        await wait(3600);
        await gp.bringToFront();
        const win = await gp.evaluate(() => ({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight }));
        const cx = Math.max(0, win.x + (win.w - win.iw));
        const cy = Math.max(0, win.y + (win.h - win.ih));
        const crop = { x: cx - (cx % 2), y: cy - (cy % 2), w: win.iw - (win.iw % 2), h: win.ih - (win.ih % 2) };
        const raw = path.join(os.tmpdir(), `pp-gdoc-${process.pid}.mp4`);
        ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '25', '-video_size', `${crop.w}x${crop.h}`, '-i', `${process.env.DISPLAY}+${crop.x},${crop.y}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', raw], { stdio: ['pipe', 'ignore', 'inherit'] });
        t0.v = Date.now();
        await wait(600);
        mark('清晨 · 晴：不操作，她自己在院子里逛');
        const a = await g();
        await until(async () => { const v = await g(); return v.pet.walked > a.pet.walked + 30 ? v : null; }, 30000, 'roaming');
        await wait(1200);
        await free();
        await T(() => window.__gameTest.follow(true));
        mark('点空地：插一面小旗，她沿路走过去');
        const here = await g();
        const tx = here.pet.x < 450 ? [620, 520] : [330, 420];
        await clickWorld(tx[0], tx[1], { glide: true, fold: false });
        await until(async () => { const v = await g(); return v.pet.mode === 'idle' ? v : null; }, 25000, 'arrive');
        await wait(500);
        mark('点她：开心一下，头上冒出台词');
        const p = (await g()).pet;
        await clickWorld(p.x, p.y - 14, { glide: true, fold: false });
        await wait(2200);
        mark('点菜地：她拎着水壶去浇水');
        await useAndWait('plot-b', { glide: true });
        await wait(600);
        mark('拖动时间滑块：09:00 → 22:00，天色转暗，窗户和路灯亮起、萤火虫出来');
        await T(() => window.__gameTest.showCard('sky'));
        await wait(400);
        const box = await gp.locator('#time-slider').boundingBox();
        const xAt = (h) => box.x + 8 + ((box.width - 16) * h) / 23.75;
        await gp.mouse.move(xAt(9), box.y + box.height / 2, { steps: 10 });
        await gp.mouse.down();
        for (let h = 9; h <= 22; h += 0.25) { await gp.mouse.move(xAt(h), box.y + box.height / 2); await wait(30); }
        await gp.mouse.up();
        await wait(2000);
        for (const t of ['多云', '小雨', '雷雨', '下雪']) {
          mark(`天气 ›：${t}`);
          const c = await gp.locator('#weather-next').boundingBox();
          await gp.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 8 });
          await gp.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
          await wait(3800);
        }
        mark('天气回到晴朗，夜里点萤火虫：她跑过去扑');
        await T(() => window.__gameTest.setWeather('clear'));
        await wait(2500);
        const s = await until(async () => { const v = await g(); return v.flies.length ? v : null; }, 8000, 'fireflies');
        const f = s.flies.sort((q, r) => Math.hypot(q.x - s.pet.x, q.y - s.pet.y) - Math.hypot(r.x - s.pet.x, r.y - s.pet.y))[0];
        await clickWorld(f.x, f.y, { glide: true, fold: false });
        await until(async () => ((await g()).pet.mode === 'idle' ? true : null), 20000, 'the run');
        await wait(1500);
        mark('‹ 时段：回到清晨');
        await gp.click('#time-next');
        await wait(2500);
        ff.stdin.write('q');
        await new Promise((r) => ff.on('close', r));
        ff = null;
        const mp4 = path.join(DIR, 'mini-game-demo.mp4');
        fs.copyFileSync(raw, mp4);
        fs.rmSync(raw, { force: true });
        const pal = path.join(os.tmpdir(), `pp-gdoc-pal-${process.pid}.png`);
        // the GIF (GitHub plays it inline): the slider-into-night and weather part only, 400 px, 8 fps — a few MB
        const from = (chapters.find((c) => c.label.startsWith('拖动时间滑块')) || { t: 0 }).t;
        const to = (chapters.find((c) => c.label.startsWith('天气回到晴朗')) || { t: from + 22 }).t;
        const cut = ['-ss', String(from), '-t', String(Math.max(10, to - from + 1))];
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...cut, '-i', mp4, '-vf', 'fps=8,scale=400:-1:flags=lanczos,palettegen=max_colors=128', pal]);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...cut, '-i', mp4, '-i', pal, '-lavfi', 'fps=8,scale=400:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5', path.join(DIR, 'mini-game-demo.gif')]);
        fs.rmSync(pal, { force: true });
        fs.writeFileSync(path.join(DIR, 'mini-game-demo.chapters.json'), JSON.stringify(chapters, null, 2) + '\n');
        const dur = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim();
        assert.ok(Number(dur) >= 10, `duration ${dur}`);
        facts.push(`mp4 ${Number(dur).toFixed(1)} s, ${crop.w}×${crop.h}`);
        return `${facts.join(' ')}; chapters ${chapters.map((c) => `${c.t}s ${c.label}`).join(' / ')}`;
      }, () => gp);
    } finally {
      if (ff) { ff.stdin.write('q'); await new Promise((r) => ff.on('close', r)); }
      // the app may hang on quit with the settings window open: give it 10 s, then end it
      await Promise.race([app.close().catch(() => {}), wait(10000)]);
      try { app.process().kill('SIGKILL'); } catch { /* gone */ }
      server.close();
      server.closeAllConnections();
    }
  };
};
