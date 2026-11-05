// 她的房间 (docs/her-room-design.md §7.2): the room@1 game bought in the store and played in the game window,
// driven as a user does — `xvfb-run -a node e2e/run.js room` (no tokens: fake lh). The store's CDN is a local
// server holding an archive of the minimal room pack (test/fixtures/games/her-room, scripts/build-room-fixture.js)
// and plays the games repository's catalog.json (PIXELPET_GAME_INDEX_URL) with a her-room entry. She is 大肥鱼.
// Every click on the room is a real mouse click on the canvas (or on the room's DOM: its buttons and cards).
//   R1  商店 → 小游戏 → 她的房间: the card, 下载 → 已下载, 开始玩: the game window opens, her desktop window hides,
//       WebGL draws, frames keep coming
//   R2  into the room: the theme is dafeiyu (hers), its pictures are loaded, she wears her pack's daily sheet
//       (招牌女仆装), the five activity pieces are there
//   R3  换房间: the picker (the title-bar button) has five rooms — 1 可以玩, 4 即将开放; each 即将开放 one opens a
//       preview card (name, palette, avatar, 即将开放) with no error; 回到 brings the room back; R picks too
//   R4  hover each piece: its outline is drawn, the tip names it
//   R5  the five, each one whole round (rounds shortened to a few seconds, test mode only): she walks to the
//       spot, plays the action, the props do their thing, the bar and the label count, she talks, the round
//       settles in main, the numbers move the way the manifest says, pet.json agrees with the stats card
//   R6  energy 10: 工作 / 打游戏 are greyed out, the tip says why, a click starts nothing
//   R7  stop early (结束) and switch (another piece mid-round): settled by how far it got; the one before first
//   R10 天色: night darkens the room, lights it, the moon in the window; rain in the window
//   R8  Ctrl+W mid-round: settled by how long it ran, she is back on the desktop; the tray opens 她的房间 again
//       (the last game played) and the card says 上一件
//   R9  the app killed mid-round, reopened after more than a whole round: the round is settled as done
// Screenshots: out/e2e/her-room/. With PIXELPET_ROOM_VIDEO=<file.mp4> (run under xvfb-run -s "-screen 0 1280x800x24")
// R2–R6 are also recorded from the screen (ffmpeg x11grab, with the pointer), chapters in <file>.chapters.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { clickAct } = require('./pet-panel');

const isGame = (p) => p.url().includes('/renderer/game/game.html');
const isAdmin = (p) => p.url().includes('admin-ui');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const KINDS = ['sleep', 'work', 'phone', 'music', 'game'];
const SCALE = 0.15; // a 30 s round takes 4.5 s

module.exports = function miniRoomScenario({ ROOT, OUT, FAKE_LH, step, launch }) {
  return async function miniRoom() {
    const S = 'room';
    const SHOTS = path.join(OUT, 'her-room');
    fs.mkdirSync(SHOTS, { recursive: true });
    const PACK = path.join(ROOT, 'test', 'fixtures', 'games', 'her-room');
    const M = JSON.parse(fs.readFileSync(path.join(PACK, 'manifest.json'), 'utf8'));
    const THEME = M.themes.find((t) => t.id === 'dafeiyu');
    // the store's CDN: an archive of the minimal pack, and the games repository's catalog with its entry
    const cdn = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-roomcdn-'));
    const { zip } = require(path.join(ROOT, 'scripts', 'build-character-catalog'));
    const file = `her-room-${M.version}.zip`;
    zip(PACK, path.join(cdn, file));
    const buf = fs.readFileSync(path.join(cdn, file));
    const entry = { id: 'her-room', type: 'game', name: '她的房间', version: M.version, engine: 'room@1', minAppVersion: null, description: M.description, credit: M.credit, features: ['睡觉 · 工作 · 看手机 · 听音乐 · 打游戏', '五位角色各一间房（大肥鱼的先开放）', '每天三件小事，完成加好感'], changelog: '开发用的最小包（像素图由脚本绘制）。', file, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), published: '2026-11-05' };
    const catalog = { schema: 1, release: 'games-v1', games: [entry] };
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
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-roomfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-room-'));
    const env = { PIXELPET_DATA_DIR: dataDir, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/games`, PIXELPET_GAME_INDEX_URL: `http://127.0.0.1:${server.address().port}/catalog.json` };
    let { app, page } = await launch(env);
    let gp = null;
    let admin = null;
    const g = () => gp.evaluate(() => window.__game());
    const R = async () => (await g()).room;
    const T = (fn, arg) => gp.evaluate(fn, arg);
    const dbg = () => page.evaluate(() => window.pet.debugScene());
    const shot = (n) => gp.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const progress = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'games', '.progress', 'her-room.json'), 'utf8'));
    const petJson = () => { const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'pet.json'), 'utf8')); return p.characters[p.speciesId]; };
    const until = async (fn, ms = 10000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn().catch(() => null);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
        await wait(100);
      }
    };
    const findGame = async (a) => until(async () => a.windows().find(isGame) || null, 15000, 'the game window');
    const ready = async () => { await gp.waitForFunction(() => window.__game && window.__game().ready && window.__game().engine === 'room@1', null, { timeout: 30000 }); return g(); };
    const furn = async (id) => (await R()).furniture.find((f) => f.id === id);
    // a point on a piece of furniture that is not on her (a click on her is a pat): its middle, else round it
    const pointOn = async (id) => {
      const r = await R();
      const f = r.furniture.find((x) => x.id === id);
      const b = r.pet.boxScreen;
      const inB = (x, y) => x >= b[0] - 4 && x <= b[0] + b[2] + 4 && y >= b[1] - 4 && y <= b[1] + b[3] + 4;
      const [x0, y0, w, h] = f.rect;
      const cands = [f.click, [x0 + w * 0.5, y0 + h * 0.3], [x0 + w * 0.2, y0 + h * 0.5], [x0 + w * 0.8, y0 + h * 0.5], [x0 + w * 0.15, y0 + h * 0.8], [x0 + w * 0.85, y0 + h * 0.8], [x0 + w * 0.5, y0 + h * 0.1]];
      return cands.find(([x, y]) => !inB(x, y)) || f.click;
    };
    // a real mouse click on a piece of furniture
    const clickFurn = async (id) => { const [x, y] = await pointOn(id); await gp.mouse.move(x - 4, y - 4); await gp.mouse.click(x, y); return [x, y]; };
    // a real mouse click on a DOM control (its box changes every frame, so no actionability wait)
    const press = async (sel) => { const b = await gp.locator(sel).boundingBox(); await gp.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
    const at = (kind) => THEME.activities[kind].at;
    const settledOf = (s, kind, n0) => s.events.filter((e) => e.settled && e.settled.kind === kind).slice(n0);
    const countSettled = async (kind) => (await g()).events.filter((e) => e.settled && e.settled.kind === kind).length;
    const idleRoom = async () => {
      await T(() => window.__gameTest.roam(false));
      const r = await R();
      if (r.run) await press('#act-stop');
      return until(async () => { const v = await R(); return !v.run && !v.pending && v.pet.mode !== 'use' ? v : null; }, 15000, 'nothing running');
    };
    const errorsOf = async () => (await g()).errors;
    // the recording (optional): marks are wall-clock, turned into seconds from the recorder's start
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
      rec.ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '25', '-video_size', `${crop.w}x${crop.h}`, '-i', `${process.env.DISPLAY}+${crop.x},${crop.y}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', VIDEO], { stdio: ['pipe', 'ignore', 'inherit'] });
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

    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="dafeiyu"]').first().click();
      await page.fill('#pet-name', '大肥鱼');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await page.waitForTimeout(500);

      await step(S, 'R1 商店 → 小游戏 → 她的房间：卡片、下载 → 已下载、开始玩：游戏窗口打开、桌宠隐藏、WebGL 在画', async () => {
        await page.evaluate(() => window.pet.debugTrayClick('小游戏'));
        admin = await until(async () => app.windows().find(isAdmin) || null, 30000, 'the settings window');
        await admin.waitForSelector('[data-path="/store/games"]', { timeout: 20000 });
        await admin.waitForSelector('[data-store-game="her-room"]', { timeout: 20000 });
        assert.equal(await admin.locator('[data-store-game="her-room"]').getAttribute('data-game-state'), 'remote');
        const cardText = await admin.locator('[data-store-game="her-room"]').innerText();
        assert.match(cardText, /她的房间/);
        await admin.screenshot({ path: path.join(SHOTS, 'r1-store-remote.png') });
        await admin.click('[data-game-download="her-room"]');
        await until(async () => (await admin.locator('[data-store-game="her-room"]').getAttribute('data-game-state')) === 'installed', 30000, 'installed');
        const files = fs.readdirSync(path.join(dataDir, 'games', 'her-room')).sort();
        assert.deepEqual(files, ['.catalog.json', 'dafeiyu-atlas.png', 'dafeiyu-room.png', 'dafeiyu-sprites.json', 'manifest.json']);
        assert.ok(served >= 1);
        await admin.screenshot({ path: path.join(SHOTS, 'r1-store-installed.png') });
        await admin.click('[data-game-play="her-room"]');
        gp = await findGame(app);
        const s = await ready();
        const d = await dbg();
        assert.equal(d.visible, true);
        assert.equal(d.petVisible, false, 'her desktop window hid');
        assert.equal(d.game, 'her-room');
        assert.equal(d.settings.game, 'her-room', 'the last game played is her-room');
        assert.match(String(s.renderer), /webgl/i);
        const f0 = s.frames;
        await gp.waitForTimeout(1500);
        const s2 = await g();
        assert.ok(s2.frames - f0 > 20, `frames keep coming (${s2.frames - f0} in 1.5 s)`);
        return `store card「${cardText.split('\n')[0]}」remote → installed (${files.join(', ')}); game window ${d.title}, renderer ${s.renderer}, ${s2.fps} fps`;
      });

      await step(S, 'R2 进房间：主题 dafeiyu、背景和图集加载、她穿像素包的 daily（招牌女仆装）、五件活动家具都在', async () => {
        await T(() => { window.__gameTest.setHour(12); window.__gameTest.setWeather('clear'); window.__gameTest.roam(false); });
        await startRec();
        mark('step', '进房间：大肥鱼（招牌女仆装）从门口走进鲸鱼女仆的蓝色小屋');
        // she walks in from the door to the middle
        await until(async () => { const r = await R(); return r.pet.mode === 'idle' && r.pet.walked > 100 ? r : null; }, 15000, 'her to walk in');
        const r = await R();
        assert.equal(r.theme, 'dafeiyu');
        assert.equal(r.owner, true, 'she is in her own room: the owner look');
        assert.match(String(r.lookUrl), /daily/, `her look ${r.lookUrl}`);
        assert.equal(r.pet.sprite, 'sprites');
        assert.equal(r.pet.visible, true);
        assert.deepEqual(r.furniture.filter((f) => f.kind).map((f) => f.kind).sort(), [...KINDS].sort());
        for (const f of r.furniture) assert.ok(f.rect[2] > 30 && f.rect[3] > 30, `${f.id} is big enough to click (${f.rect.map(Math.round)})`);
        assert.equal(r.labels.length, 5);
        assert.deepEqual(await errorsOf(), []);
        await shot('r2-room-day');
        return `theme ${r.theme}, look ${path.basename(String(r.lookUrl))}, furniture ${r.furniture.map((f) => `${f.id}:${f.kind || 'use'}`).join(' ')}, labels ${r.labels.map((l) => l.text).join(' / ')}`;
      });

      await step(S, 'R3 换房间：标题栏按钮打开选择卡，五个条目 1 个可以玩 + 4 个即将开放；四张预览卡都有房间名、色板、头像，不报错；回到 dafeiyu；R 键也能打开', async () => {
        mark('step', '点标题栏「鲸鱼女仆的蓝色小屋 ▾」打开换房间卡片');
        await press('#room-btn');
        await until(async () => { const r = await R(); return r.picker.open && r.picker.items.length === 5 && r.picker.items.every((i) => i.avatar) ? r : null; }, 8000, 'the picker with five avatars');
        let r = await R();
        assert.deepEqual(r.picker.items.map((i) => [i.id, i.status]), [['dafeiyu', 'open'], ['claude', 'soon'], ['grok', 'soon'], ['gemini', 'soon'], ['gpt', 'soon']]);
        assert.deepEqual(r.picker.items.map((i) => i.tag), ['可以玩', '即将开放', '即将开放', '即将开放', '即将开放']);
        assert.ok(r.picker.items[0].current);
        mark('check', '换房间卡片：五个条目，大肥鱼「可以玩」，其余四个「即将开放」');
        await wait(VIDEO ? 1200 : 0);
        await shot('r3-themes');
        const seen = [];
        for (const id of ['claude', 'grok', 'gemini', 'gpt']) {
          if (!(await R()).picker.open) await gp.click('#room-btn');
          mark('step', `点「${M.themes.find((t) => t.id === id).name}」`);
          await press(`.pick[data-theme="${id}"]`);
          r = await until(async () => { const v = await R(); return v.preview && v.preview.id === id && v.preview.avatar ? v : null; }, 6000, `the preview of ${id}`);
          assert.equal(r.preview.soon, '即将开放');
          assert.equal(r.preview.name, M.themes.find((t) => t.id === id).name);
          assert.ok(r.preview.motifs >= 3, 'motif chips in the palette');
          assert.equal(r.preview.back, '回到 鲸鱼女仆的蓝色小屋');
          assert.equal(r.theme, 'dafeiyu', 'the room stays');
          mark('check', `${id} 的预览卡：房间名、色块、头像和「即将开放」，房间画面还在`);
          await wait(VIDEO ? 1000 : 0);
          await shot(`r3-soon-${id}`);
          seen.push(`${id}「${r.preview.name}」${r.preview.owner}`);
          await press('#preview-back');
          await until(async () => !(await R()).preview, 4000, 'preview closed');
        }
        // the open one: back in dafeiyu, the choice saved
        await gp.keyboard.press('r');
        await until(async () => (await R()).picker.open, 4000, 'R opens the picker');
        mark('step', '按 R 再打开卡片，选回大肥鱼的房间');
        await press('.pick[data-theme="dafeiyu"]');
        r = await until(async () => { const v = await R(); return !v.picker.open ? v : null; }, 4000, 'picker closed');
        assert.equal(r.theme, 'dafeiyu');
        await until(async () => progress().state.theme === 'dafeiyu', 4000, 'state.theme saved');
        assert.deepEqual(await errorsOf(), [], 'no errors in the page');
        return `${seen.join('；')}；back to ${r.theme}, saved state.theme=${progress().state.theme}`;
      });

      await step(S, 'R4 悬停每件家具：描边出现、提示文字对', async () => {
        const out = [];
        mark('step', '鼠标依次悬停六件家具');
        for (const f of (await R()).furniture) {
          const [hx, hy] = await pointOn(f.id);
          await gp.mouse.move(hx, hy, { steps: VIDEO ? 8 : 1 });
          await wait(VIDEO ? 400 : 0);
          const r = await until(async () => { const v = await R(); return v.hover && v.hover.id === f.id ? v : null; }, 3000, `hover ${f.id}`);
          assert.ok(r.hover.sprites >= 8, 'the outline is drawn');
          assert.equal(r.hover.tone, 'ok');
          const want = f.kind ? `${M.activities[f.kind].label} · ${THEME.furniture.find((x) => x.id === f.id).label}` : '坐一会儿';
          assert.ok(r.tip.startsWith(want), `tip「${r.tip}」starts with「${want}」`);
          if (f.id === 'bed') await shot('r4-hover-bed');
          out.push(`${f.id}「${r.tip}」`);
        }
        await gp.mouse.move(500, 120);
        return out.join(' ');
      });

      await step(S, 'R5 五件事各做一整轮：走到位置、动作、道具、活动条和标签在走、台词气泡、到点在 main 结算、数值方向和 pet.json 一致', async () => {
        await T((k) => window.__gameTest.setRoundScale(k), SCALE);
        const log = [];
        for (const kind of ['sleep', 'work', 'phone', 'music', 'game']) {
          await idleRoom();
          const n0 = await countSettled(kind);
          const before = (await R()).stats;
          mark('step', `点${THEME.furniture.find((x) => x.id === at(kind)).label}：${M.activities[kind].label}`);
          await clickFurn(at(kind));
          // she walks there with the marker, then the round starts
          const walking = await R();
          assert.ok(walking.pending && walking.pending.kind === kind, `${kind}: the click sent her (${JSON.stringify(walking.pending)})`);
          const r = await until(async () => { const v = await R(); return v.run && v.run.kind === kind && v.run.progress > 0.25 ? v : null; }, 20000, `${kind} running`);
          const spot = THEME.activities[kind].spot;
          assert.ok(Math.hypot(r.pet.x - spot[0], r.pet.y - spot[1]) < 12, `${kind}: she is at her spot (${Math.round(r.pet.x)}, ${Math.round(r.pet.y)})`);
          assert.equal(r.pet.anim, M.activities[kind].anim, `${kind}: anim`);
          assert.ok(r.bar && r.bar.name === `正在${M.activities[kind].label}` && /\d\d:\d\d \/ \d\d:\d\d/.test(r.bar.time) && r.bar.fill > 0, `${kind}: the bar ${JSON.stringify(r.bar)}`);
          const label = r.labels.find((l) => l.id === at(kind));
          assert.ok(label.running && label.text === `${M.activities[kind].label}中`, `${kind}: the label ${JSON.stringify(label)}`);
          assert.ok(r.bubble.text, `${kind}: she says something`);
          const p = Object.fromEntries(r.props.map((x) => [x.fx, x]));
          const statsCard = r.statsCard.filter((x) => x.preview);
          assert.ok(statsCard.length >= 2, `${kind}: the stats card previews this round`);
          if (kind === 'sleep') {
            assert.equal(r.pet.pose, 'tucked'); assert.equal(r.pet.parent, 'front');
            assert.ok(p.dim && p.dim.now < 0.8, `the room dims (${p.dim && p.dim.now})`);
            const q = p.layer.rect;
            const bed = THEME.furniture.find((x) => x.id === 'bed');
            assert.ok(q[0] >= bed.x - 150 && q[0] + q[2] <= bed.x + 150, 'the quilt is on the bed');
            assert.ok(Math.abs(r.pet.rotation + Math.PI / 2) < 0.05, 'she lies down');
            assert.ok(p.front, "the bed's front is over her");
          } else if (kind === 'work') {
            const r2 = await until(async () => { const v = await R(); const st = v.props.find((x) => x.fx === 'screen-type'); return st && st.rows > p['screen-type'].rows ? v : null; }, 4000, 'more lines typed');
            void r2;
            assert.equal(p.swap.swapped, 1, 'the desk lamp is on');
          } else if (kind === 'phone') {
            assert.ok(p.hold.inHand, 'the phone is in her hand'); assert.equal(p.hide.hidden, 1, 'not on the table any more');
          } else if (kind === 'music') {
            const a0 = p.spin.angle;
            await gp.waitForTimeout(300);
            const a1 = (await R()).props.find((x) => x.fx === 'spin').angle;
            assert.ok(a1 > a0, `the record turns (${a0.toFixed(2)} → ${a1.toFixed(2)})`);
            assert.ok(p.bob);
          } else if (kind === 'game') {
            const f0 = p.frames.t;
            await gp.waitForTimeout(400);
            const f1 = (await R()).props.find((x) => x.fx === 'frames');
            assert.ok(f1.t > f0 && f1.frames === 4, 'the TV plays');
            assert.ok(p.hold.inHand, 'the controller is in her hand');
          }
          await gp.mouse.move(500, 60); // the tip off the picture
          await gp.waitForTimeout(150);
          mark('check', `${M.activities[kind].label}进行中：她在位置上做动作，道具在动，活动条和家具标签在计时，有台词气泡`);
          await shot(`r5-act-${kind}`);
          const s = await until(async () => { const v = await g(); return settledOf(v, kind, n0).length ? v : null; }, 15000, `${kind} settled`);
          const done = settledOf(s, kind, n0)[0].settled;
          assert.equal(done.complete, true, `${kind}: a whole round`);
          const after = s.room.stats;
          for (const [k, v] of Object.entries(M.activities[kind].deltas)) {
            const d = after[k] - before[k];
            if (v > 0) assert.ok(d > 0 || after[k] === 100, `${kind}: ${k} goes up (${before[k]} → ${after[k]})`);
            else assert.ok(d < 0 || after[k] === 0, `${kind}: ${k} goes down (${before[k]} → ${after[k]})`);
          }
          const pj = petJson();
          assert.equal(Math.round(pj.energy), after.energy, 'pet.json energy = the stats card');
          assert.equal(Math.round(pj.mood), after.mood, 'pet.json mood');
          assert.equal(100 - Math.round(pj.hunger), after.fullness, 'pet.json fullness');
          assert.equal(progress().state.focus.dafeiyu, after.focus, 'focus saved in the progress file');
          assert.match(s.room.toast || '', new RegExp(`${M.activities[kind].label}完成`));
          mark('check', `${M.activities[kind].label}一整轮结束：提示「${s.room.toast}」，状态卡数值变化`);
          await until(async () => !(await R()).run, 3000, 'props folded');
          const folded = await R();
          assert.equal(folded.props.length, 0);
          assert.equal(folded.pet.pose, null);
          log.push(`${kind}: ${JSON.stringify(before)} → ${JSON.stringify(after)}「${s.room.toast}」`);
        }
        return log.join('；');
      });

      await step(S, 'R6 精力 10：工作和打游戏描边变灰、提示写原因，点了不会开始', async () => {
        await idleRoom();
        mark('step', '把她的精力调到 10（测试接口），再悬停、点击书桌和游戏机');
        await page.evaluate(() => window.pet.debugSet({ energy: 10 }));
        await until(async () => (await R()).stats.energy === 10, 5000, 'energy 10 in the room');
        const out = [];
        for (const kind of ['work', 'game']) {
          const f = await furn(at(kind));
          const [hx, hy] = await pointOn(f.id);
          await gp.mouse.move(hx, hy);
          const r = await until(async () => { const v = await R(); return v.hover && v.hover.id === f.id ? v : null; }, 3000, `hover ${kind}`);
          assert.equal(r.hover.tone, 'tired', 'a grey outline');
          assert.match(r.tip, /太累了（精力 10，要 15）/);
          assert.ok(r.labels.find((l) => l.id === f.id).tired);
          if (kind === 'work') { mark('check', '精力 10：工作的描边变灰，提示「太累了（精力 10，要 15）」'); await shot('r6-tired'); }
          await gp.mouse.click(hx, hy);
          await gp.waitForTimeout(600);
          const v = await R();
          assert.equal(v.run, null, 'nothing started');
          assert.equal(v.pending, null);
          out.push(`${kind}「${r.tip}」`);
        }
        await page.evaluate(() => window.pet.debugSet({ energy: 80 }));
        await until(async () => (await R()).stats.energy === 80, 5000, 'energy back');
        await stopRec();
        return out.join('；');
      });

      await step(S, 'R7 提前结束和切换：做到一半点「结束」按做了多久结算；做一半点另一件家具，前一件先结算', async () => {
        await idleRoom();
        await T(() => window.__gameTest.setRoundScale(0.3)); // a 25 s round is 7.5 s
        const n0 = await countSettled('music');
        await clickFurn(at('music'));
        await until(async () => { const v = await R(); return v.run && v.run.kind === 'music' && v.run.progress > 0.45 ? v : null; }, 20000, 'music half way');
        const shown = (await R()).run.progress;
        await press('#act-stop');
        const s = await until(async () => { const v = await g(); return settledOf(v, 'music', n0).length ? v : null; }, 5000, 'music settled');
        const m = settledOf(s, 'music', n0)[0].settled;
        assert.equal(m.complete, false);
        assert.ok(Math.abs(m.fraction - shown) < 0.15, `fraction ${m.fraction} ≈ the progress shown ${shown.toFixed(2)}`);
        assert.match(s.room.toast, /听音乐先到这里（做了 \d+%）/);
        await shot('r7-stopped');
        // switching: phone half way, then a click on the desk
        await idleRoom();
        const p0 = await countSettled('phone');
        await clickFurn(at('phone'));
        await until(async () => { const v = await R(); return v.run && v.run.kind === 'phone' && v.run.progress > 0.3 ? v : null; }, 20000, 'phone running');
        await clickFurn(at('work'));
        const s2 = await until(async () => { const v = await g(); return settledOf(v, 'phone', p0).length ? v : null; }, 5000, 'phone settled by the switch');
        const ph = settledOf(s2, 'phone', p0)[0].settled;
        assert.equal(ph.complete, false);
        const w = await until(async () => { const v = await R(); return v.run && v.run.kind === 'work' ? v : null; }, 20000, 'work started after the switch');
        assert.equal(w.labels.find((l) => l.id === at('phone')).running, false);
        return `结束 at ${Math.round(shown * 100)}% → fraction ${m.fraction}「${s.room.toast}」; switch phone (${ph.fraction}) → work running`;
      });

      await step(S, 'R10 天色：调到夜里房间变暗、灯亮、窗外是月亮；小雨时窗外下雨（和像素小院共用天色）', async () => {
        await idleRoom();
        const day = await g();
        await T(() => { window.__gameTest.setHour(23); window.__gameTest.setWeather('clear'); });
        const night = await until(async () => { const v = await g(); return v.phase === 'night' && v.windowSky && v.windowSky.moon ? v : null; }, 6000, 'night in the window');
        const b = (x) => (x.grade.mul[0] + x.grade.mul[1] + x.grade.mul[2]) / 3;
        assert.ok(b(night) < b(day) * 0.85, `the room darkens (${b(day).toFixed(2)} → ${b(night).toFixed(2)})`);
        await gp.mouse.move(500, 60);
        await gp.waitForTimeout(300);
        await shot('r10-night');
        await T(() => window.__gameTest.setWeather('rain'));
        const rain = await until(async () => { const v = await g(); return v.windowSky && v.windowSky.drops > 20 ? v : null; }, 6000, 'rain in the window');
        await shot('r10-night-rain');
        assert.equal((await dbg()).settings.weather, 'rain', 'saved in the shared settings.scene');
        await T(() => { window.__gameTest.setHour(12); window.__gameTest.setWeather('clear'); });
        return `brightness day ${b(day).toFixed(2)} → night ${b(night).toFixed(2)}, window ${JSON.stringify(night.windowSky)}, rain drops ${rain.windowSky.drops}`;
      });

      await step(S, 'R8 工作中 Ctrl+W：按做了多久结算，她回到桌面；托盘再打开的还是她的房间，状态卡写「上一件」', async () => {
        await idleRoom();
        await clickFurn(at('work'));
        const r = await until(async () => { const v = await R(); return v.run && v.run.kind === 'work' ? v : null; }, 20000, 'work running');
        assert.equal(r.run.kind, 'work');
        await gp.waitForTimeout(1500);
        await gp.keyboard.press('Control+KeyW');
        await until(async () => { const d = await dbg(); return !d.visible && d.petVisible ? d : null; }, 6000, 'closed, pet back');
        const st = progress().state;
        assert.equal(st.run, null, 'the round is settled');
        assert.equal(st.last.kind, 'work');
        assert.equal(st.last.complete, false);
        // the tray opens the last game played
        await page.evaluate(() => window.pet.debugTrayClick('小游戏'));
        await until(async () => (await dbg()).visible, 6000, 'reopened from the tray');
        const d = await dbg();
        assert.equal(d.game, 'her-room');
        const v = await until(async () => { const x = await R(); return /上一件：工作（做了 \d+%）/.test(x.lastText) ? x : null; }, 5000, '上一件 on the card');
        await shot('r8-reopened');
        // her panel ⌂ too
        await gp.keyboard.press('Control+KeyW');
        await until(async () => !(await dbg()).visible, 6000, 'closed');
        await clickAct(page, 'scene');
        await until(async () => (await dbg()).visible, 6000, 'reopened from ⌂');
        const d2 = await dbg();
        assert.equal(d2.game, 'her-room');
        return `settled work at ${Math.round(st.last.fraction * 100)}%; tray → ${d.game}, ⌂ → ${d2.game}; card「${v.lastText}」; sources ${d2.sources.join(',')}`;
      });

      await step(S, 'R9 睡觉中进程被杀，过了一整轮再打开：直接按完成结算', async () => {
        await idleRoom();
        await T(() => window.__gameTest.setRoundScale(0.15)); // 4.5 s
        await clickFurn(at('sleep'));
        await until(async () => { const v = await R(); return v.run && v.run.kind === 'sleep' ? v : null; }, 20000, 'sleep running');
        await until(async () => progress().state.run && progress().state.run.kind === 'sleep', 3000, 'the run saved');
        const startedAt = progress().state.run.startedAt;
        // the app goes away without settling (a crash, a kill): no before-quit
        process.kill(app.process().pid, 'SIGKILL');
        await wait(6000); // more than the whole 4.5 s round
        assert.equal(progress().state.run.kind, 'sleep', 'still open on disk');
        ({ app, page } = await launch(env));
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await page.evaluate(() => window.pet.debugSceneToggle('test'));
        gp = await findGame(app);
        await ready();
        const st = await until(async () => { const s = progress().state; return !s.run ? s : null; }, 8000, 'settled on boot');
        assert.equal(st.last.kind, 'sleep');
        assert.equal(st.last.complete, true, 'a whole round went by: done');
        assert.equal(st.last.recovered, true);
        const v = await until(async () => { const x = await R(); return /上次没结束的睡觉，这次打开时结算/.test(x.toast || '') ? x : null; }, 6000, 'the toast');
        assert.equal(v.theme, 'dafeiyu');
        await shot('r9-recovered');
        return `run started ${new Date(startedAt).toISOString()}, killed, reopened ${Math.round((st.last.at - startedAt) / 1000)} s later →「${v.toast}」, last ${JSON.stringify(st.last)}`;
      });
    } finally {
      await stopRec().catch(() => {});
      server.close();
      try { await app.close(); } catch { /* gone */ }
    }
  };
};
