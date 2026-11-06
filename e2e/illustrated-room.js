// 她的房间 (illustrated-room@1, docs/illustrated-room.md): the illustrated room bought in the store and played in the
// game window, driven as a user does — `xvfb-run -a node e2e/run.js illustrated` (no tokens: the fake lh, whose
// reply echoes the owner's words). The store's CDN is a local server holding an archive of the sample pack
// (test/fixtures/games/her-room: the T-11695 probe's art, 3 illustrations × lamp off / on), listed as her-room-sample.
// Every click is a real mouse click on the canvas or on the room's DOM; every chat message is typed in the game
// window's chat bar and goes through PetService.chat (her agent, her topic, 聊天记录).
//   I1  商店 → 小游戏 → 她的房间（小样）: the card, 下载 → 已下载, 开始玩: the game window opens, WebGL draws
//   I2  the living picture at rest: rain falls, bokeh pulses, she breathes and blinks; the numbers are folded into
//       the title-bar capsule (no stats panel); the 屏幕 card shows her phone
//   I3  the desk lamp: the status-bar button turns it on within 0.2 s (lit picture, glow, warmer grade — the whole
//       room and her together), the lamp in the picture turns it off again; L too
//   I4  the six activities from the status bar: each a crossfade (~1.4 s, both of her half-visible in its middle),
//       each its own picture and screen content — phone: short videos, music: the player (title, time running),
//       work: the document, game: the little game (score going up), sleep: Z, idle: the lock screen
//   I4c (real pack) the screens' real content: the video's frames advance and every clip plays, the laptop's real web
//       page scrolls, the player has its cover and lyrics in time; screen close-ups via __gameTest.screenPng
//   I5  the picture's hotspots: hover the bed shows 「睡觉 · 床」, a click on the bed / the desk switches
//   I6  chat: 「现在去试一下打开电脑刷抖音吧」 → at the desk within 2 s, the laptop plays short videos, the lamp on
//       (work turns it on); her reply in the bubble; the prompt had the [房间·真实情况] note; 「回床上休息吧」 → in bed;
//       「大肥鱼，能收消息吗」 → nothing switches; both rounds are in her 聊天记录
//   I7  the capsule opens her numbers; a whole round (shortened, test mode) settles in main and she goes back to 发呆
//   I8  像素房间: the store still lists the pixel room under its new name, its engine room@1 untouched
// Screenshots: out/e2e/illustrated-room/. With PIXELPET_ROOM_VIDEO=<file.mp4> (xvfb-run -s "-screen 0 1280x800x24")
// I2–I7 are recorded (ffmpeg x11grab, with the pointer), chapters in <file>.chapters.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const isGame = (p) => p.url().includes('/renderer/game/game.html');
const isAdmin = (p) => p.url().includes('admin-ui');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// PIXELPET_ROOM_PACK=<games/her-room/pack>: the same run on the real game pack, plus I4b (every state × lamp off / on)
const REAL_PACK = process.env.PIXELPET_ROOM_PACK || null;
const ID = REAL_PACK ? 'her-room' : 'her-room-sample';
// PIXELPET_ROOM_LIVE=1: her replies come from the real LobeHub agent (the logged-in `lh`; a few chat turns of tokens),
// the agent made for the run is deleted at the end. Otherwise the fake lh echoes the owner's words.
const LIVE = process.env.PIXELPET_ROOM_LIVE === '1';

module.exports = function illustratedRoomScenario({ ROOT, OUT, FAKE_LH, step, launch }) {
  return async function illustratedRoom() {
    const S = 'illustrated';
    const SHOTS = path.join(OUT, 'illustrated-room');
    fs.mkdirSync(SHOTS, { recursive: true });
    const SRC_PACK = REAL_PACK || path.join(ROOT, 'test', 'fixtures', 'games', 'her-room');
    const PACK = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-irpack-'));
    for (const f of fs.readdirSync(SRC_PACK)) fs.copyFileSync(path.join(SRC_PACK, f), path.join(PACK, f));
    const M = { ...JSON.parse(fs.readFileSync(path.join(SRC_PACK, 'manifest.json'), 'utf8')), id: ID, name: REAL_PACK ? '她的房间' : '她的房间（小样）' };
    fs.writeFileSync(path.join(PACK, 'manifest.json'), JSON.stringify(M, null, 2));
    const cdn = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ircdn-'));
    const { zip } = require(path.join(ROOT, 'scripts', 'build-character-catalog'));
    const file = `${ID}-${M.version}.zip`;
    zip(PACK, path.join(cdn, file));
    const buf = fs.readFileSync(path.join(cdn, file));
    const entry = { id: ID, type: 'game', name: M.name, version: M.version, engine: 'illustrated-room@1', minAppVersion: null, description: M.description, credit: M.credit, features: ['日系插画、深夜下雨的房间', '在聊天里叫她做什么，她就去做', '睡觉 · 工作 · 看手机 · 听音乐 · 打游戏 · 发呆'], changelog: '小样包：3 张插画 × 台灯关 / 开。', file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), published: '2026-11-05' };
    const catalog = { schema: 1, release: 'games-v1', games: [entry] };
    const server = http.createServer((req, res) => {
      const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (name === 'catalog.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); return; }
      const f = path.join(cdn, name);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-irfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ir-'));
    const env = { PIXELPET_DATA_DIR: dataDir, ...(LIVE ? { LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1' } : { LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }), PIXELPET_TRAY: '1', PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/games`, PIXELPET_GAME_INDEX_URL: `http://127.0.0.1:${server.address().port}/catalog.json` };
    const { app, page } = await launch(env);
    let gp = null;
    let admin = null;
    const g = () => gp.evaluate(() => window.__game());
    const dbg = () => page.evaluate(() => window.pet.debugScene());
    const shot = (n) => gp.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const runs = () => (fs.existsSync(path.join(fakeDir, 'runs.log')) ? fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const until = async (fn, ms = 10000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
        await wait(80);
      }
    };
    const press = async (sel) => { const b = await gp.locator(sel).boundingBox(); await gp.mouse.move(b.x + b.width / 2 - 6, b.y + b.height / 2 - 4); await gp.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
    const pressAct = (k) => press(`#ir-bar .ir-act[data-kind="${k}"]`);
    const settledIn = async (state, ms = 6000) => until(async () => { const s = await g(); return s.state === state && s.shown === state && !s.fading ? s : null; }, ms, `the room to settle in ${state}`);
    const hot = async (id) => (await g()).hotspots.find((h) => h.id === id);
    const VIDEO = process.env.PIXELPET_ROOM_VIDEO || null;
    const rec = { ff: null, t0: 0, marks: [] };
    const mark = (kind, text) => { if (rec.ff) rec.marks.push({ kind, t: Math.round((Date.now() - rec.t0) / 100) / 10, [kind === 'step' ? 'label' : 'note']: text }); };
    const startRec = async () => {
      if (!VIDEO || rec.ff) return;
      await gp.bringToFront();
      const win = await gp.evaluate(() => ({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight }));
      const cx = Math.max(0, win.x + (win.w - win.iw));
      const cy = Math.max(0, win.y + (win.h - win.ih));
      const crop = { x: cx - (cx % 2), y: cy - (cy % 2), w: win.iw - (win.iw % 2), h: win.ih - (win.ih % 2) };
      rec.ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '25', '-video_size', `${crop.w}x${crop.h}`, '-i', `${process.env.DISPLAY}+${crop.x},${crop.y}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', VIDEO], { stdio: ['pipe', 'ignore', 'inherit'] });
      rec.t0 = Date.now();
      await wait(500);
    };
    const stopRec = async () => {
      if (!rec.ff) return;
      const ff = rec.ff;
      await wait(800);
      ff.stdin.write('q');
      await new Promise((r) => ff.on('close', r));
      fs.writeFileSync(VIDEO.replace(/\.mp4$/, '.chapters.json'), JSON.stringify(rec.marks, null, 1) + '\n');
      rec.ff = null;
    };
    const typeChat = async (text) => {
      const b = await gp.locator('#ir-chat-input').boundingBox();
      await gp.mouse.click(b.x + 40, b.y + b.height / 2);
      await gp.keyboard.type(text, { delay: 35 });
      await gp.keyboard.press('Enter');
    };

    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="dafeiyu"]').first().click();
      await page.fill('#pet-name', '大肥鱼');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      if (LIVE) {
        const where = await Promise.race([page.waitForSelector('#space-box:not(.hidden)', { timeout: 120000 }).then(() => 'asked'), page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 }).then(() => 'not asked')]);
        if (where === 'asked') await page.click('#space-go');
      }
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: LIVE ? 120000 : 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await page.waitForTimeout(500);

      await step(S, 'I1 商店 → 小游戏 → 她的房间（小样）：卡片、下载 → 已下载、开始玩：独立游戏窗口打开、桌宠隐藏、WebGL 在画', async () => {
        await page.evaluate(() => window.pet.debugTrayClick('小游戏'));
        admin = await until(async () => app.windows().find(isAdmin) || null, 30000, 'the settings window');
        await admin.waitForSelector(`[data-store-game="${ID}"]`, { timeout: 20000 });
        const cardText = await admin.locator(`[data-store-game="${ID}"]`).innerText();
        assert.match(cardText, /她的房间/);
        await admin.click(`[data-game-download="${ID}"]`);
        await until(async () => (await admin.locator(`[data-store-game="${ID}"]`).getAttribute('data-game-state')) === 'installed', 30000, 'installed');
        const files = fs.readdirSync(path.join(dataDir, 'games', ID)).sort();
        await admin.screenshot({ path: path.join(SHOTS, 'i1-store-installed.png') });
        await admin.click(`[data-game-play="${ID}"]`);
        gp = await until(async () => app.windows().find(isGame) || null, 15000, 'the game window');
        await gp.waitForFunction(() => window.__game && window.__game().ready && window.__game().engine === 'illustrated-room@1', null, { timeout: 30000 });
        const s = await g();
        const d = await dbg();
        assert.equal(d.visible, true);
        assert.equal(d.petVisible, false, 'her desktop window hid');
        assert.equal(d.game, ID);
        assert.match(String(s.renderer), /webgl/i);
        const f0 = s.frames;
        await gp.waitForTimeout(1500);
        const s2 = await g();
        assert.ok(s2.frames - f0 > 8, `frames keep coming (${s2.frames - f0} in 1.5 s, software GL while the pictures decode)`);
        assert.deepEqual(s2.errors, []);
        return `store card「${cardText.split('\n')[0]}」→ installed (${files.join(', ')}); game window ${d.title}, renderer ${s.renderer}, ${s2.fps} fps`;
      });

      await step(S, 'I2 活着的画面：雨在下、光斑在闪、她在呼吸和眨眼；数值收进标题栏胶囊（没有数值面板）；「屏幕」卡片显示她的手机', async () => {
        await startRec();
        mark('step', '进房间：深夜、下雨、蓝色月光；手机锁屏亮着');
        const a = await settledIn('idle');
        await gp.waitForTimeout(400);
        await shot('i2-idle-moon');
        // ten seconds of rest: blinks, breath, rain, bokeh
        const samples = [];
        for (let i = 0; i < 10; i++) { samples.push(await g()); await gp.waitForTimeout(700); }
        const b = await g();
        const offsets = samples.map((x) => x.breath.offset);
        const bk = samples.map((x) => x.window.bokehAlpha[0]);
        assert.ok(b.window.rain > 50 && b.window.bokeh > 20, `rain ${b.window.rain}, bokeh ${b.window.bokeh}`);
        assert.notDeepEqual(a.window.rainY, b.window.rainY, 'the rain moves');
        assert.ok(Math.max(...bk) - Math.min(...bk) > 0.05, `bokeh pulses (${bk.join(' ')})`);
        assert.ok(Math.max(...offsets) - Math.min(...offsets) > 0.5, `she breathes (offset ${offsets.join(' ')})`);
        assert.ok(b.blink.has && b.blink.count >= 1, `she blinks (${b.blink.count} in ~7 s)`);
        assert.equal(b.statsCard, null, 'no stats panel by default');
        assert.match(b.capsule.text, /⚡\d+♥\d+/);
        assert.equal(b.pip.open, true);
        assert.match(b.pip.title, /手机 · 锁屏/);
        assert.equal(b.lamp.on, false);
        mark('check', `静止 7 秒：眨眼 ${b.blink.count} 次、呼吸起伏 ${(Math.max(...offsets) - Math.min(...offsets)).toFixed(1)} px、雨 ${b.window.rain} 条、光斑 ${b.window.bokeh} 颗在闪`);
        return `blinks ${b.blink.count}; breath offsets ${offsets.join(',')}; bokeh alpha ${bk.join(',')}; rain ${b.window.rain} streaks + ${b.window.drops} drops; capsule「${b.capsule.text}」; pip「${b.pip.title}」`;
      });

      await step(S, 'I3 台灯：点状态栏「台灯」0.2 秒内亮起（开灯插画、暖光晕、整屋调色一起变，她也被照到）；点画面里的台灯关掉；L 键也能开关', async () => {
        mark('step', '点「台灯」：桌面最暖，整屋跟着变暖（真实包），窗外仍是蓝色雨夜');
        const before = await g();
        await press('#ir-lamp');
        const t0 = Date.now();
        const on = await until(async () => { const s = await g(); return s.lamp.level >= 0.9 ? s : null; }, 2000, 'the lamp to light');
        const ms = Date.now() - t0;
        await gp.waitForTimeout(500);
        const lit = await g();
        assert.equal(lit.lamp.on, true);
        assert.equal(lit.lamp.litAlpha, 1, 'the lit illustration is shown (her too)');
        assert.ok(lit.lamp.glowAlpha > 0.15, `glow ${lit.lamp.glowAlpha}`); // the pack's glow.alpha × a 3–5 % flicker
        assert.notDeepEqual(lit.lamp.grade, before.lamp.grade, 'the whole-room grade changed');
        assert.equal((await g()).bar.find((x) => x.kind === 'lamp').pressed, true);
        await shot('i3-lamp-on');
        mark('check', `台灯亮起：${ms} ms 到 90%，开灯插画 alpha 1，光晕 ${lit.lamp.glowAlpha}`);
        const lamp = await hot('lamp');
        await gp.mouse.move(lamp.at[0] - 10, lamp.at[1] + 10);
        await gp.mouse.click(lamp.at[0], lamp.at[1]);
        await until(async () => { const s = await g(); return s.lamp.level === 0 && !s.lamp.on ? s : null; }, 2000, 'the lamp off');
        await shot('i3-lamp-off');
        await gp.keyboard.press('l');
        await until(async () => (await g()).lamp.on, 2000, 'L on');
        await gp.keyboard.press('l');
        await until(async () => !(await g()).lamp.on, 2000, 'L off');
        mark('check', '点画面里的台灯关掉，L 键也能开关');
        return `lamp to 90% in ${ms} ms (first sample); lit alpha ${lit.lamp.litAlpha}, glow ${lit.lamp.glowAlpha}, grade ${before.lamp.grade} → ${lit.lamp.grade}; hotspot off; L on/off`;
      });

      const SEEN = {};
      await step(S, 'I4 状态栏六件事：每次交叉淡化约 1.4 秒（中段两个她同时半透明、不黑屏），各自的插画和屏幕内容（短视频 / 播放器 / 文档 / 游戏 / 锁屏，Z 和音符）', async () => {
        const order = ['phone', 'music', 'work', 'game', 'sleep', 'idle'];
        const want = { phone: 'clips', music: 'player', work: 'page', game: 'game', sleep: 'lock', idle: 'lock' };
        for (const k of order) {
          const n0 = (await g()).transitions.length;
          mark('step', `点状态栏「${M.activities[k].label}」`);
          await pressAct(k);
          await until(async () => (await g()).fading, 3000, `a crossfade to ${k}`);
          const s = await settledIn(k, 6000);
          const tr = s.transitions[s.transitions.length - 1];
          assert.ok(s.transitions.length > n0, 'a transition was recorded');
          assert.ok(tr.seconds >= 1 && tr.seconds <= 2, `crossfade ${tr.seconds} s`);
          assert.ok(tr.both >= 2, `both of her half-visible for ${tr.both} frames`); // software GL while recording can be slow
          assert.equal(s.scenesOnStage, 1, 'the one before is gone');
          assert.equal(s.activity, k);
          assert.ok(s.bar.find((x) => x.kind === k).current);
          const sc = s.screens.find((x) => x.kind !== 'lock') || s.screens[0];
          assert.equal(sc.kind, want[k], `${k} screen`);
          await gp.waitForTimeout(k === 'sleep' ? 2200 : 900);
          const s2 = await g();
          SEEN[k] = s2;
          if (k === 'music') { assert.match(s2.pip.caption, /《雨夜的鲸鱼》 \d:\d\d \/ 3:06/); }
          if (k === 'phone') assert.ok(s2.screens[0].clip && s2.screens[0].clip.caption, 'a clip with a caption');
          if (k === 'game') assert.ok(s2.screens[0].score > 0, 'the game is playing');
          if (k === 'sleep') assert.ok(s2.fx.includes('Z'), `Z rising (${s2.fx.join('')})`);
          if (k === 'music') assert.ok(s2.fx.some((x) => /♪|♫/.test(x)), 'notes');
          await shot(`i4-${k}`);
          mark('check', `${M.activities[k].label}：淡化 ${tr.seconds} s，屏幕 ${sc.id}=${sc.kind}${s2.pip.caption ? `「${s2.pip.caption}」` : ''}`);
        }
        // the player's time runs
        await pressAct('music');
        await settledIn('music');
        const m1 = (await g()).screens[0].track.pos;
        await gp.waitForTimeout(2200);
        const m2 = (await g()).screens[0].track.pos;
        assert.ok(m2 > m1, `the song plays (${m1} → ${m2} s)`);
        // the clips swipe to the next one
        await pressAct('phone');
        await settledIn('phone');
        const c1 = (await g()).screens[0].clip;
        await gp.evaluate(() => window.__gameTest.nextClip());
        await gp.waitForTimeout(150);
        const sw = await g();
        assert.equal(sw.screens[0].swiping, true, 'swiping up');
        await gp.waitForTimeout(600);
        const c2 = (await g()).screens[0].clip;
        assert.notEqual(c1.id, c2.id);
        await shot('i4-phone-next-clip');
        mark('check', `短视频上滑：「${c1.caption}」→「${c2.caption}」`);
        return order.map((k) => `${k}: ${SEEN[k].screens.map((x) => `${x.id}=${x.kind}`).join(',')} ${SEEN[k].pip.caption || ''}`).join('; ') + `; song ${m1}→${m2} s; clip ${c1.id} → ${c2.id}`;
      });

      if (REAL_PACK) await step(S, 'I4b 整包：8 个状态各有专门的插画，每个状态台灯关 / 开两版；床 ↔ 书桌先起身；眨眼贴片；光斑在画好的灯位', async () => {
        const lampTo = async (on) => {
          if ((await g()).lamp.on !== on) await press('#ir-lamp');
          await until(async () => { const l = (await g()).lamp; return l.on === on && (on ? l.level >= 0.9 : l.level <= 0.02) ? l : null; }, 3000, `lamp ${on}`);
          await gp.waitForTimeout(450);
        };
        const out = [];
        const R = M.rooms[0];
        assert.equal((await g()).window.bokeh, R.window.bokeh.spots.length, 'a bokeh light per painted spot');
        for (const key of ['idle', 'idle-lazy', 'phone', 'music', 'sleep', 'work', 'game']) {
          const def = R.states[key];
          mark('step', `${def.label}：专门的姿势，台灯关 / 开`);
          if (key === 'idle-lazy') {
            // 备用入口：状态栏有自己的「犯懒」按钮（真实鼠标），聊天和 7 键也能进
            await press('#ir-bar .ir-act[data-state="idle-lazy"]');
            const v = await settledIn('idle-lazy', 8000);
            assert.equal(v.bar.find((x) => x.kind === 'idle-lazy').current, true, '「犯懒」按钮高亮');
            assert.equal(v.bar.find((x) => x.kind === 'idle').current, false, '「发呆」按钮不高亮');
            await pressAct('idle');
            await settledIn('idle', 8000);
            await typeChat('好懒啊，犯懒吧');
            await settledIn('idle-lazy', 8000);
            await pressAct('idle');
            await settledIn('idle', 8000);
            await gp.keyboard.press('7');
            await settledIn('idle-lazy', 8000);
          } else if (R.states[(await g()).state].zone !== def.zone) {
            // 床 ↔ 书桌 goes through 起身: she is seen standing on the way
            await pressAct(key);
            await until(async () => { const v = await g(); return v.shown === 'stand' && !v.fading ? v : null; }, 6000, 'she stands up on the way');
            if (key === 'work') await shot('i4b-stand');
            await settledIn(key, 8000);
          } else {
            await pressAct(key);
            await settledIn(key, 8000);
          }
          await lampTo(false);
          await gp.waitForTimeout(3500); // the toast and the bubble of the switch have gone: these are the store's screenshots
          await shot(`i4b-${key}-off`);
          const a = await g();
          await lampTo(true);
          await gp.waitForTimeout(3000);
          await shot(`i4b-${key}-lit`);
          const b = await g();
          assert.equal(b.lamp.litAlpha, 1, `${key}: the lit picture`);
          assert.deepEqual(a.errors, []);
          const scr = Object.entries(def.screens || {}).map(([id, c]) => `${id}=${c.content}`).join(' ');
          for (const [id] of Object.entries(def.screens || {})) assert.ok(b.screens.find((x) => x.id === id), `${key}: screen ${id}`);
          assert.equal(b.blink.has, !!def.blink, `${key}: blink`);
          if (def.blink) {
            assert.equal(b.blink.patch, true, `${key}: the pack's patch`);
            await gp.evaluate(() => window.__gameTest.holdBlink(1.2));
            await gp.waitForTimeout(120);
            assert.equal((await g()).blink.closed, true);
            await shot(`i4b-${key}-blink-lit`);
            await gp.waitForTimeout(1300);
          }
          out.push(`${key}: ${scr || 'no screen'}; breath ${b.breath ? b.breath.phase : '-'}; blink ${def.blink ? 'patch' : 'none'}`);
          mark('check', `${def.label}：台灯关 / 开两版、屏幕 ${scr || '无'}、${def.blink ? '眨眼贴片' : '不眨眼'}`);
          await lampTo(false);
        }
        await pressAct('idle');
        await settledIn('idle', 8000);
        const end = await g();
        assert.deepEqual(end.errors, []);
        return `${out.join(' | ')}; ${end.fps} fps; bokeh ${end.window.bokeh} spots`;
      });

      if (REAL_PACK) await step(S, 'I4c 屏幕真实内容：手机放视频帧并上滑换片、电脑放真实网页并滚动、播放器有封面和跟着时间走的歌词', async () => {
        const R = M.rooms[0];
        const dump = async (name, id) => {
          const url = await gp.evaluate((sid) => window.__gameTest.screenPng(sid), id);
          const buf = Buffer.from(url.split(',')[1], 'base64');
          fs.writeFileSync(path.join(SHOTS, `${name}.png`), buf);
          return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
        };
        const out = [];
        // 屏幕卡片不压聊天栏和状态栏，不被歌词撑宽拉伸；状态栏文字一行
        const layoutOk = async (where) => {
          const hit = (a, b) => a && b && a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
          const v = await g();
          assert.ok(!hit(v.pip.rect, v.chat.rect), `${where}: the card clear of the chat bar (${v.pip.rect} / ${v.chat.rect})`);
          for (const b of v.bar) assert.ok(!hit(v.pip.rect, b.rect), `${where}: the card clear of ${b.kind}`);
          const m = await gp.evaluate(() => { const c = document.getElementById('ir-pip-canvas'); const r = c.getBoundingClientRect(); return { aspect: r.width / r.height, want: c.width / c.height, lines: [...document.querySelectorAll('#ir-bar .ir-act span')].map((x) => x.getBoundingClientRect().height) }; });
          assert.ok(Math.abs(m.aspect - m.want) < 0.02, `${where}: the screen keeps its proportions (${m.aspect} vs ${m.want})`);
          assert.ok(Math.max(...m.lines) < 26, `${where}: every label on one line (${m.lines})`);
        };
        // 短视频：真实帧（不是程序画的），帧在走，画面在变；上滑换一段
        await pressAct('phone');
        await settledIn('phone', 8000);
        mark('step', '看手机：屏幕放视频帧，「屏幕」卡片放大显示');
        const c1 = (await g()).screens[0];
        assert.ok(c1.clip.frames >= 20, `clip ${c1.clip.id} has its frames (${c1.clip.frames})`);
        const h1 = await dump(`i4c-clip-${c1.clip.id}-a`, 'phone');
        await gp.waitForTimeout(900);
        const c1b = (await g()).screens[0];
        assert.ok(c1b.clip.frame > c1.clip.frame, `frames advance (${c1.clip.frame} → ${c1b.clip.frame})`);
        const h2 = await dump(`i4c-clip-${c1.clip.id}-b`, 'phone');
        assert.notEqual(h1, h2, 'the picture changed');
        await layoutOk('phone');
        await shot('i4c-phone-video');
        const shown = [c1.clip.id];
        for (let i = 1; i < R.content.clips.list.length; i++) {
          await gp.evaluate(() => window.__gameTest.nextClip());
          await gp.waitForTimeout(700);
          const c = (await g()).screens[0].clip;
          assert.ok(c.frames >= 20);
          shown.push(c.id);
          await dump(`i4c-clip-${c.id}`, 'phone');
          if (i === 1) await shot('i4c-phone-video-next');
        }
        assert.equal(new Set(shown).size, R.content.clips.list.length, 'every clip plays');
        mark('check', `手机放真实视频帧：${shown.join(' → ')}，帧 ${c1.clip.frame} → ${c1b.clip.frame}`);
        await gp.waitForTimeout(1200); // the chapter lands on the video, not on the next crossfade
        out.push(`clips ${shown.join('→')}, ${c1.clip.frames} frames each, frame ${c1.clip.frame}→${c1b.clip.frame}, sha ${h1}≠${h2}`);
        // 听音乐：封面（包里的图）、歌名、时间、歌词
        await pressAct('music');
        await settledIn('music', 8000);
        mark('step', '听音乐：封面、歌名、进度、歌词');
        const seen = new Set();
        const t0 = (await g()).screens[0].track;
        assert.equal(t0.cover, true, 'the track has its cover picture');
        for (let i = 0; i < 28; i++) { seen.add((await g()).screens[0].track.lyric); await gp.waitForTimeout(500); }
        const t1 = (await g()).screens[0].track;
        assert.ok(t1.pos > t0.pos, 'the song plays');
        assert.ok(seen.size >= 2, `the lyrics move (${[...seen].join(' / ')})`);
        await layoutOk('music');
        await dump('i4c-player', 'phone');
        await shot('i4c-music-player');
        mark('check', `播放器《${t1.title}》${t1.time}，歌词走到「${t1.lyric}」`);
        out.push(`player《${t1.title}》${t1.time}, cover ${t1.cover}, lyrics ${[...seen].join(' / ')}`);
        // 工作：文档和真实网页轮流，网页在滚动
        await pressAct('work');
        await settledIn('work', 8000);
        mark('step', '工作：电脑屏幕上文档和真实网页轮流');
        const page = () => g().then((v) => v.screens.find((x) => x.id === 'laptop').page);
        await dump('i4c-laptop-doc', 'laptop');
        const pg = await until(async () => { const v = await page(); return v && v.real && v.scroll > 40 ? v : null; }, 22000, 'the real page to come up and scroll');
        await gp.waitForTimeout(2500);
        const pg2 = await page();
        assert.ok(pg2.real && pg2.scroll > pg.scroll, `the page scrolls (${pg.scroll} → ${pg2.scroll})`);
        await layoutOk('work');
        await dump('i4c-laptop-web', 'laptop');
        await shot('i4c-work-web');
        const seenWork = await g();
        assert.match(seenWork.pip.caption, new RegExp(pg2.title));
        mark('check', `电脑上是真实网页「${pg2.title}」${pg2.url}，滚动 ${pg.scroll} → ${pg2.scroll} px`);
        out.push(`web「${pg2.title}」${pg2.url}, scroll ${pg.scroll}→${pg2.scroll}`);
        // 打游戏：小游戏在跑
        await pressAct('game');
        await settledIn('game', 8000);
        const s0 = (await g()).screens[0].score;
        await gp.waitForTimeout(2000);
        const s1 = (await g()).screens[0].score;
        assert.ok(s1 > s0);
        await layoutOk('game');
        await dump('i4c-laptop-game', 'laptop');
        mark('check', `打游戏：小游戏在跑，得分 ${s0} → ${s1}`);
        out.push(`game score ${s0}→${s1}`);
        await pressAct('idle');
        await settledIn('idle', 8000);
        assert.deepEqual((await g()).errors, []);
        return out.join('; ');
      });

      await step(S, 'I5 画面热点：悬停床显示「睡觉 · 床」并描边；真实鼠标点床 → 睡觉，点书桌 → 工作', async () => {
        const bed = await hot('bed');
        const at = [bed.at[0] - 60, bed.at[1] + 40];
        await gp.mouse.move(at[0] - 20, at[1] - 10);
        await gp.mouse.move(at[0], at[1], { steps: 4 });
        const h = await until(async () => { const s = await g(); return s.hover === 'bed' ? s : null; }, 2000, 'hover bed');
        assert.equal(h.tip, '睡觉 · 床');
        await shot('i5-hover-bed');
        mark('step', '悬停床：描边和「睡觉 · 床」');
        await gp.mouse.click(at[0], at[1]);
        await settledIn('sleep');
        const desk = await hot('desk');
        await gp.mouse.move(desk.at[0], desk.at[1] - 30, { steps: 4 });
        await gp.mouse.click(desk.at[0], desk.at[1] - 30);
        const s = await settledIn('work');
        assert.equal(s.lamp.on, true, 'work turns the lamp on');
        mark('check', '点床 → 睡觉，点书桌 → 工作（台灯自动亮）');
        return `hover「${h.tip}」; bed → sleep; desk → work (lamp ${s.lamp.on ? 'on' : 'off'})`;
      });

      await step(S, 'I6 聊天驱动：在游戏窗口聊天栏说「现在去试一下打开电脑刷抖音吧」→ 2 秒内切到书桌 + 电脑放短视频并回复；「回床上休息吧」→ 回床上；「大肥鱼，能收消息吗」不切；都进聊天记录', async () => {
        await pressAct('idle');
        await settledIn('idle');
        await press('#ir-lamp');
        await until(async () => !(await g()).lamp.on, 2000, 'lamp off');
        const nRuns = runs().length;
        mark('step', '聊天栏输入「现在去试一下打开电脑刷抖音吧」');
        await typeChat('现在去试一下打开电脑刷抖音吧');
        const t0 = Date.now();
        await until(async () => { const s = await g(); return s.state === 'work' ? s : null; }, 2000, 'work within 2 s of the message');
        const dt = Date.now() - t0;
        const s = await settledIn('work');
        assert.equal(s.screens.find((x) => x.id === 'laptop').kind, 'clips', 'the laptop plays short videos');
        assert.equal(s.lamp.on, true);
        assert.ok(s.events.some((e) => e.via === 'chat' && e.to === 'work'));
        const replied = (re, prev) => async () => { const x = await g(); return x.chat.reply && x.chat.reply !== prev && (LIVE || re.test(x.chat.reply)) && !x.chat.busy ? x : null; };
        const reply = await until(replied(/刷抖音/, null), LIVE ? 150000 : 10000, 'her reply');
        assert.ok(reply.bubble.text, 'the reply is in her bubble');
        assert.match(reply.chat.said || '', /你：现在去试一下打开电脑刷抖音吧/, 'what the owner said stays above the bar');
        const run = LIVE ? null : runs().slice(nRuns).find((r) => /刷抖音/.test(r.prompt));
        if (!LIVE) {
          assert.ok(run, 'the message went to her agent');
          assert.match(run.prompt, /\[房间·真实情况[^\n]*状态已切换[^\n]*坐到书桌前，打开了笔记本电脑[^\n]*短视频/, 'the prompt said what she just did');
        }
        await shot('i6-chat-douyin');
        mark('check', `${dt} ms 切到书桌，电脑屏幕放短视频；她的回复进了气泡`);
        mark('step', '聊天栏输入「回床上休息吧」');
        await typeChat('回床上休息吧');
        await until(async () => (await g()).state === 'sleep', 2500, 'sleep');
        const s2 = await settledIn('sleep');
        const reply2 = await until(replied(/回床上/, reply.chat.reply), LIVE ? 150000 : 10000, 'her reply 2');
        await shot('i6-chat-bed');
        mark('check', '切回床上睡觉');
        mark('step', '聊天栏输入「大肥鱼，能收消息吗」（不是指令）');
        await typeChat('大肥鱼，能收消息吗');
        const reply3 = await until(replied(/能收消息吗/, reply2.chat.reply), LIVE ? 150000 : 10000, 'her reply 3');
        await shot('i6-chat-question');
        const s3 = await g();
        assert.equal(s3.state, 'sleep', 'a question does not switch her');
        if (!LIVE) {
          const r3 = runs().slice(nRuns).find((r) => /能收消息吗/.test(r.prompt));
          assert.match(r3.prompt, /\[房间·真实情况[^\n]*状态没变[^\n]*你正在睡觉/, 'the note says nothing moved and where she is');
        }
        const log = fs.readFileSync(path.join(dataDir, 'chat-log.json'), 'utf8');
        assert.match(log, /现在去试一下打开电脑刷抖音吧/);
        assert.match(log, /回床上休息吧/);
        mark('check', '问句不切状态；三句都进了聊天记录');
        return `${LIVE ? '[live LobeHub agent] ' : ''}「打开电脑刷抖音」→ work in ${dt} ms, laptop=clips, lamp on, reply「${reply.chat.reply}」${run ? `; prompt note「${run.prompt.split('\n').find((l) => l.startsWith('[房间'))}」` : ''}; 「回床上休息吧」→ ${s2.state}, reply「${reply2.chat.reply}」; 「能收消息吗」→ stays ${s3.state}, reply「${reply3.chat.reply}」; chat log has all three`;
      });

      await step(S, 'I6b 桌宠现有的聊天（设置窗口 → 聊天 → 大肥鱼）：游戏窗口里的三轮都在她的聊天记录里；在这里说「看手机吧」，房间也切到看手机', async () => {
        await admin.bringToFront();
        await admin.evaluate(() => { location.hash = '#/chat/dafeiyu'; });
        await admin.waitForSelector('[data-chat-page] [data-chat-textarea]', { timeout: 30000 });
        const bubbles = () => admin.evaluate(() => [...document.querySelectorAll('[data-chat-page] [data-role]')].map((el) => ({ role: el.dataset.role, text: el.innerText.trim() })));
        const hist = await until(async () => { const b = await bubbles(); return b.some((x) => /打开电脑刷抖音/.test(x.text)) && b.some((x) => /回床上休息吧/.test(x.text)) ? b : null; }, 15000, 'the game-window rounds in her history');
        await admin.screenshot({ path: path.join(SHOTS, 'i6b-settings-chat-history.png') });
        mark('step', '设置窗口 → 聊天（她的聊天记录）里说「看手机吧」');
        await admin.click('[data-chat-page] [data-chat-textarea]');
        await admin.keyboard.type('看手机吧');
        await admin.keyboard.press('Enter');
        await until(async () => (await g()).state === 'phone', 3000, 'phone from the settings chat');
        const s = await settledIn('phone');
        await until(async () => !(await admin.evaluate(() => !!document.querySelector('[data-streaming]'))) && (await bubbles()).filter((x) => x.role === 'assistant').length > hist.filter((x) => x.role === 'assistant').length, LIVE ? 150000 : 15000, 'her reply in the settings chat');
        const after = await bubbles();
        await admin.screenshot({ path: path.join(SHOTS, 'i6b-settings-chat-phone.png') });
        await gp.bringToFront();
        await shot('i6b-room-phone-from-settings');
        mark('check', '设置窗口的聊天也能切她的状态：切到看手机，手机在刷短视频');
        const last = after.filter((x) => x.role === 'assistant').pop();
        return `history has ${hist.length} messages incl. the game-window rounds; 「看手机吧」 in 设置 → 聊天 → room ${s.state} (${s.screens.map((x) => `${x.id}=${x.kind}`).join(',')}); her reply there「${last ? last.text.slice(0, 80) : ''}」`;
      });

      await step(S, 'I7 数值胶囊点开看精力 / 心情 / 今日小事；一整轮（测试缩短）在 main 结算，结算后她回到发呆', async () => {
        await press('#ir-capsule');
        const open = await until(async () => { const s = await g(); return s.statsCard ? s : null; }, 2000, 'the stats card');
        await shot('i7-stats-open');
        await press('#ir-capsule');
        await until(async () => !(await g()).statsCard, 2000, 'folded');
        mark('step', '点胶囊看数值，再收起；看一整轮手机');
        await pressAct('idle');
        await settledIn('idle');
        await gp.evaluate(() => window.__gameTest.setRoundScale(0.12));
        await pressAct('phone');
        // the shortened round may end before the crossfade does on a slow software GL: only that it started
        await until(async () => (await g()).state === 'phone', 3000, 'the round to start');
        const done = await until(async () => { const s = await g(); return s.state === 'idle' && s.events.some((e) => e.via === 'tick' && e.settled && e.settled.kind === 'phone' && e.settled.complete) ? s : null; }, 15000, 'the round to finish');
        await settledIn('idle');
        assert.match(done.toast || '', /看手机完成/);
        await shot('i7-round-done');
        mark('check', `一轮结束：${done.toast}`);
        return `stats card open ${JSON.stringify(open.statsCard.map(Math.round))}; round settled「${done.toast}」, back to ${done.state}`;
      });

      await step(S, 'I8 像素房间改名：商店里原来的像素版显示「像素房间」（engine room@1，玩法和美术不动）', async () => {
        await stopRec();
        await admin.bringToFront();
        await admin.evaluate(() => { location.hash = '#/store/games'; });
        await admin.waitForSelector('[data-store-game="pixel-room"]', { timeout: 20000 });
        const t = await admin.locator('[data-store-game="pixel-room"]').innerText();
        assert.match(t, /像素房间/);
        assert.doesNotMatch(t, /她的房间/);
        const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'game-catalog.json'), 'utf8')).games.find((x) => x.id === 'pixel-room');
        assert.equal(bundled.name, '像素房间');
        assert.equal(bundled.engine, 'room@1');
        await admin.screenshot({ path: path.join(SHOTS, 'i8-store-pixel-room.png') });
        return `store card「${t.split('\n')[0]}」; bundled catalog pixel-room「${bundled.name}」engine ${bundled.engine}`;
      });
    } finally {
      await stopRec().catch(() => {});
      server.close();
      try { await app.close(); } catch { /* gone */ }
      // the real agent this run made (live only)
      if (LIVE) {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'pet.json'), 'utf8'));
          for (const c of Object.values(p.characters || {})) if (c.agentId) require('node:child_process').execFileSync('lh', ['agent', 'delete', c.agentId, '--yes'], { stdio: 'ignore' });
        } catch { /* best effort */ }
      }
    }
  };
};
