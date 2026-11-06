// 她的房间 · 上架验收 (T-11725): the published pack on the real CDN, bought in the store and played in the real app:
//   PIXELPET_E2E_APP_VERSION=0.28.0 xvfb-run -a -s "-screen 0 1600x1000x24" node e2e/run.js herroomaccept
// The archive is what the games repository's scripts/publish.js uploaded: no PIXELPET_CATALOG_URL, so the app builds
// the same download URL it does for users. The games repository's catalog.json is served from a local server
// (PIXELPET_GAME_INDEX_URL) until its PR is merged and main has the entry. PIXELPET_E2E_APP_VERSION: the app version
// the store compares with minAppVersion, test mode only; the entry says 0.28.0, the release that carries this engine.
// Her replies come from the real LobeHub agent (the logged-in `lh`, a few chat turns of tokens; the agent is deleted at
// the end). PIXELPET_ACCEPT_FAKE=<fake lh> runs the same steps offline to debug this script.
//   H1  商店 → 小游戏: 她的房间 未下载 → 真实鼠标点下载 → 下载中 → 已下载; the files are the CDN archive's, byte for byte
//   H2  开始玩: the game window, WebGL; 雨和光斑 move at rest: two frames and their difference
//   H3  chat in the game window, one chapter per activity: 睡觉 工作 看手机 听音乐 打游戏 发呆 犯懒 + 打开电脑刷抖音
//   H4  the existing chat (设置 → 聊天) switches the room too, and holds the game-window rounds
//   H5  the status bar and the picture's hotspots, without chat
//   H6  the lamp: off / on in two states, the bar, the lamp in the picture, L
//   H7  screens: video frames, real web page scrolling, player with cover and lyrics, game score
//   H8  transitions: frames through a crossfade and through 起身
//   H9  one real-length round settles and she goes back to 发呆
//   H10 像素房间: 商店下载 from the CDN, 开始玩, a round starts with a click on the furniture
// Out: out/e2e/her-room-accept/ — shots/*.png, obs/*.json, transcript.json, her-room-accept.mp4 + .chapters.json
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');

const isGame = (p) => p.url().includes('/renderer/game/game.html');
const isAdmin = (p) => p.url().includes('admin-ui');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FAKE = process.env.PIXELPET_ACCEPT_FAKE || null;
const CHATS = [
  { key: 'sleep', title: '睡觉', say: '回床上休息吧', state: 'sleep' },
  { key: 'work', title: '工作', say: '打开电脑写周报吧', state: 'work' },
  { key: 'phone', title: '看手机', say: '看会儿手机吧', state: 'phone' },
  { key: 'music', title: '听音乐', say: '放首歌听听吧', state: 'music' },
  { key: 'game', title: '打游戏', say: '来打会儿游戏吧', state: 'game' },
  { key: 'idle', title: '发呆', say: '发会儿呆吧', state: 'idle' },
  { key: 'lazy', title: '犯懒', say: '好懒啊，犯懒吧', state: 'idle-lazy' },
  { key: 'douyin', title: '打开电脑刷抖音', say: '打开电脑刷抖音', state: 'work', screen: 'clips' },
];

module.exports = function herRoomAcceptScenario({ ROOT, OUT, step: stepFn, launch }) {
  return async function herRoomAccept() {
    // PIXELPET_ACCEPT_ONLY=H1,H2,H10: just these steps, to debug this script
    const ONLY = process.env.PIXELPET_ACCEPT_ONLY ? process.env.PIXELPET_ACCEPT_ONLY.split(',') : null;
    const step = (s, name, fn) => (!ONLY || ONLY.includes(name.split(' ')[0]) ? stepFn(s, name, fn) : Promise.resolve());
    const S = 'herroomaccept';
    const DIR = path.join(OUT, 'her-room-accept');
    const SHOTS = path.join(DIR, 'shots');
    const OBS = path.join(DIR, 'obs');
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.mkdirSync(OBS, { recursive: true });
    const obs = (n, data) => { fs.writeFileSync(path.join(OBS, `${n}.json`), JSON.stringify(data, null, 1) + '\n'); return data; };
    const REPO = path.resolve(process.env.PIXELPET_GAMES_REPO || path.join(os.homedir(), 'develop', 'rdmclin2', 'pixel-pet-mini-games'));
    const repoCatalog = JSON.parse(fs.readFileSync(path.join(REPO, 'catalog.json'), 'utf8'));
    const M = JSON.parse(fs.readFileSync(path.join(REPO, 'games', 'her-room', 'pack', 'manifest.json'), 'utf8'));
    const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const CAT = require(path.join(ROOT, 'src', 'core', 'catalog'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-hra-'));
    const zipFiles = (z) => { const d = fs.mkdtempSync(path.join(work, 'z-')); execFileSync('unzip', ['-q', z, '-d', d]); return Object.fromEntries(fs.readdirSync(d).sort().map((n) => [n, sha256(fs.readFileSync(path.join(d, n)))])); };
    const dirFiles = (d) => Object.fromEntries(fs.readdirSync(d).filter((n) => !n.startsWith('.')).sort().map((n) => [n, sha256(fs.readFileSync(path.join(d, n)))]));
    const cdn = {};
    for (const id of ['her-room', 'pixel-room']) {
      const e = repoCatalog.games.find((x) => x.id === id);
      assert.ok(e && e.published, `${id} is published in the games repository's catalog`);
      const url = CAT.downloadUrl({ file: e.file, release: repoCatalog.release }, {}, {});
      const res = await fetch(url);
      assert.ok(res.ok, `${url}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.equal(sha256(buf), e.sha256, `${url} is the archive the catalog lists`);
      assert.equal(buf.length, e.bytes);
      const z = path.join(work, e.file);
      fs.writeFileSync(z, buf);
      cdn[id] = { url, status: res.status, bytes: buf.length, sha256: e.sha256, files: zipFiles(z) };
    }
    obs('cdn-check', Object.fromEntries(Object.entries(cdn).map(([k, v]) => [k, { url: v.url, status: v.status, bytes: v.bytes, sha256: v.sha256, files: Object.keys(v.files).length }])));
    const requests = [];
    const server = http.createServer((req, res) => {
      const name = path.basename(new URL(req.url, 'http://x').pathname);
      requests.push(name);
      if (name === 'catalog.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(repoCatalog)); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dataDir = fs.mkdtempSync(path.join(work, 'data-'));
    let fakeDir = null;
    if (FAKE) { fakeDir = fs.mkdtempSync(path.join(work, 'fake-')); fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1'); }
    const env = { PIXELPET_DATA_DIR: dataDir, ...(FAKE ? { LH_BIN: FAKE, FAKE_LH_DIR: fakeDir } : { LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1' }), PIXELPET_TRAY: '1', PIXELPET_CATALOG_PREINSTALLED: '', PIXELPET_GAME_INDEX_URL: `http://127.0.0.1:${server.address().port}/catalog.json` };
    obs('launch', { appVersionPackage: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, appVersionForStore: process.env.PIXELPET_E2E_APP_VERSION || null, agent: FAKE ? 'fake lh' : 'real lh', catalogUrlOverride: 'PIXELPET_CATALOG_URL' in env, gameIndexServedLocally: true });

    const SCREEN = process.env.PIXELPET_ACCEPT_SCREEN || '1600x1000';
    const VIDEO = path.join(DIR, 'her-room-accept.mp4');
    const rec = { ff: null, t0: 0, marks: [] };
    const mark = (kind, text) => { if (rec.ff) rec.marks.push({ kind, t: Math.round((Date.now() - rec.t0) / 100) / 10, [kind === 'step' ? 'label' : 'note']: text }); };
    const startRec = async () => {
      rec.ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-framerate', '15', '-video_size', SCREEN, '-i', `${process.env.DISPLAY}+0,0`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', VIDEO], { stdio: ['pipe', 'ignore', 'inherit'] });
      rec.t0 = Date.now();
      await wait(600);
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
    const origin = async (p) => p.evaluate(() => ({ x: window.screenX + (window.outerWidth - window.innerWidth), y: window.screenY + (window.outerHeight - window.innerHeight) }));
    const xmove = async (p, x, y) => { const o = await origin(p); execFileSync('xdotool', ['mousemove', String(Math.round(o.x + x)), String(Math.round(o.y + y))]); await wait(40); };
    const xclick = async (p, x, y) => { await xmove(p, x, y); await wait(120); execFileSync('xdotool', ['click', '1']); };
    const xsel = async (p, sel) => {
      await p.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 800 }).catch(() => {});
      const b = await p.locator(sel).first().boundingBox();
      assert.ok(b, `${sel} is on screen`);
      await xclick(p, b.x + b.width / 2, b.y + b.height / 2);
    };

    const { app, page } = await launch(env);
    let gp = null;
    let admin = null;
    const g = () => gp.evaluate(() => window.__game());
    const dbg = () => page.evaluate(() => window.pet.debugScene());
    const shot = (n) => gp.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const until = async (fn, ms = 10000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        // a page call on a window that went away can hang: it counts as "not yet"
        const v = await Promise.race([fn().catch(() => null), wait(8000).then(() => null)]);
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
        await wait(80);
      }
    };
    const settledIn = async (state, ms = 8000) => until(async () => { const s = await g(); return s.state === state && s.shown === state && !s.fading ? s : null; }, ms, `the room to settle in ${state}`);
    const pressAct = (k) => xsel(gp, `#ir-bar .ir-act[data-kind="${k}"]`);
    const typeChat = async (text) => {
      const b = await gp.locator('#ir-chat-input').boundingBox();
      await xclick(gp, b.x + 40, b.y + b.height / 2);
      await wait(150);
      await gp.keyboard.type(text, { delay: 60 });
      await gp.keyboard.press('Enter');
    };
    const lampTo = async (on) => {
      if ((await g()).lamp.on !== on) await xsel(gp, '#ir-lamp');
      await until(async () => { const l = (await g()).lamp; return l.on === on && (on ? l.level >= 0.9 : l.level <= 0.02) ? l : null; }, 3000, `lamp ${on}`);
      await wait(500);
    };
    const quiet = async () => { await wait(3500); }; // the toast and the bubble of the switch have gone
    // two frames and their difference, brightened so what changed is visible
    const diff = (a, b, out) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(SHOTS, `${a}.png`), '-i', path.join(SHOTS, `${b}.png`), '-filter_complex', "[0:v]format=gbrp[a];[1:v]format=gbrp[b];[a][b]blend=all_mode=difference,lutrgb=r='min(val*5,255)':g='min(val*5,255)':b='min(val*5,255)'", '-frames:v', '1', path.join(SHOTS, `${out}.png`)]);
    const montage = (names, out, cols) => {
      const inputs = names.flatMap((n) => ['-i', path.join(SHOTS, `${n}.png`)]);
      const rows = Math.ceil(names.length / cols);
      const scale = names.map((_, i) => `[${i}:v]scale=480:-2[v${i}]`).join(';');
      const layout = names.map((_, i) => `${(i % cols) * 480}_${Math.floor(i / cols) * 300}`).join('|');
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', `${scale};${names.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${names.length}:layout=${layout}:fill=black`, '-frames:v', '1', path.join(SHOTS, `${out}.png`)]);
      return rows;
    };
    const transcript = [];

    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="dafeiyu"]').first().click();
      await page.fill('#pet-name', '大肥鱼');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      if (!FAKE) {
        const where = await Promise.race([page.waitForSelector('#space-box:not(.hidden)', { timeout: 120000 }).then(() => 'asked'), page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 }).then(() => 'not asked')]);
        if (where === 'asked') await page.click('#space-go');
      }
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await wait(500);
      await startRec();

      await step(S, 'H1 商店 → 小游戏：她的房间 未下载 → 真实鼠标点下载 → 已下载，装的文件和 CDN 上的包逐字节一致', async () => {
        mark('step', '章节·商店下载：托盘「小游戏」打开商店');
        await page.evaluate(() => window.pet.debugTrayClick('小游戏'));
        admin = await until(async () => app.windows().find(isAdmin) || null, 30000, 'the settings window');
        const card = '[data-store-game="her-room"]';
        await admin.waitForSelector(card, { timeout: 20000 });
        await admin.bringToFront();
        await wait(800);
        const cover = await admin.evaluate(() => { const i = document.querySelector('[data-store-game="her-room"] img'); return i ? { w: i.naturalWidth, h: i.naturalHeight, complete: i.complete } : null; });
        assert.ok(cover && cover.complete && cover.w > 0, `the cover is drawn (${JSON.stringify(cover)})`);
        const before = { state: await admin.locator(card).getAttribute('data-game-state'), text: await admin.locator(card).innerText() };
        await admin.screenshot({ path: path.join(SHOTS, 'h1-store-before.png') });
        mark('check', `商店卡片「她的房间」，状态 ${before.state}，有封面和下载按钮`);
        mark('step', '真实鼠标点「下载」，包从 CDN 来');
        await xsel(admin, `[data-game-download="her-room"]`);
        const seen = [];
        let progressShot = false;
        const t0 = Date.now();
        await until(async () => {
          const st = await admin.locator(card).getAttribute('data-game-state');
          if (seen[seen.length - 1] !== st) seen.push(st);
          if (!progressShot && st !== 'remote' && st !== 'installed') { progressShot = true; await admin.screenshot({ path: path.join(SHOTS, 'h1-store-downloading.png') }); }
          return st === 'installed';
        }, 120000, 'installed');
        const ms = Date.now() - t0;
        const dir = path.join(dataDir, 'games', 'her-room');
        assert.equal(JSON.stringify(dirFiles(dir)), JSON.stringify(cdn['her-room'].files), 'the installed files are the CDN archive\'s, byte for byte');
        await wait(400);
        await admin.screenshot({ path: path.join(SHOTS, 'h1-store-installed.png') });
        const after = { state: await admin.locator(card).getAttribute('data-game-state'), text: await admin.locator(card).innerText() };
        mark('check', `下载完成：${cdn['her-room'].url}，卡片变成已下载，出现「开始玩」`);
        return JSON.stringify(obs('h1-store', { before, cover, states: seen, ms, progressShot, after, downloadUrl: cdn['her-room'].url, installedMatchesCdnZip: true, files: Object.keys(dirFiles(dir)).length, indexRequests: requests.slice() }));
      });

      await step(S, 'H2 开始玩：独立游戏窗口、WebGL；静止时雨和光斑在动', async () => {
        mark('step', '点「开始玩」：独立游戏窗口打开');
        await xsel(admin, '[data-game-play="her-room"]');
        gp = await until(async () => app.windows().find(isGame) || null, 15000, 'the game window');
        await gp.waitForFunction(() => window.__game && window.__game().ready && window.__game().engine === 'illustrated-room@1', null, { timeout: 30000 });
        await gp.bringToFront();
        const s0 = await settledIn('idle', 15000);
        const d = await dbg();
        assert.equal(d.visible, true);
        assert.equal(d.petVisible, false);
        assert.equal(d.game, 'her-room');
        assert.match(String(s0.renderer), /webgl/i);
        await wait(800);
        await shot('h2-game-window');
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-video_size', SCREEN, '-i', `${process.env.DISPLAY}+0,0`, '-frames:v', '1', path.join(SHOTS, 'h2-whole-screen.png')]);
        mark('check', `独立窗口 ${d.title}：engine ${s0.engine}、renderer ${s0.renderer}，桌宠隐藏`);
        mark('step', '章节·雨和光斑：静止 8 秒');
        await wait(4000); // her first line has gone: what differs below is the living picture
        const samples = [];
        await shot('h2-rain-a');
        for (let i = 0; i < 8; i++) { samples.push(await g()); await wait(800); }
        await shot('h2-rain-b');
        diff('h2-rain-a', 'h2-rain-b', 'h2-rain-diff');
        const b = await g();
        const bk = samples.map((x) => x.window.bokehAlpha[0]);
        const off = samples.map((x) => x.breath.offset);
        assert.notDeepEqual(samples[0].window.rainY, b.window.rainY);
        assert.ok(Math.max(...bk) - Math.min(...bk) > 0.03, `bokeh ${bk}`);
        assert.ok(Math.max(...off) - Math.min(...off) > 0.3, `breath ${off}`);
        assert.ok(b.blink.count >= 1, 'she blinks');
        assert.deepEqual(b.errors, []);
        mark('check', `雨 ${b.window.rain} 条、水珠 ${b.window.drops} 颗、光斑 ${b.window.bokeh} 颗在闪，眨眼 ${b.blink.count} 次`);
        return JSON.stringify(obs('h2-living', { title: d.title, petVisible: d.petVisible, renderer: s0.renderer, fps: b.fps, rain: b.window.rain, drops: b.window.drops, bokeh: b.window.bokeh, bokehAlpha: bk, breathOffset: off, rainY: [samples[0].window.rainY, b.window.rainY], blinks: b.blink.count }));
      });

      await step(S, 'H3 聊天驱动：游戏窗口聊天栏每类活动说一句，切到对应状态并回复', async () => {
        // a round is 20–30 s and a real reply can take as long: the rounds are stretched so she is still in the state
        // when the reply arrives (H9 runs a real-length one)
        await gp.evaluate(() => window.__gameTest.setRoundScale(6));
        let prev = (await g()).chat.reply;
        for (const c of CHATS) {
          mark('step', `章节·${c.title}：聊天栏说「${c.say}」`);
          await typeChat(c.say);
          const t0 = Date.now();
          await until(async () => (await g()).state === c.state, 4000, `${c.say} → ${c.state}`);
          const ms = Date.now() - t0;
          const s = await settledIn(c.state, 12000);
          await wait(600);
          const sc = s.screens.find((x) => x.kind !== 'lock') || s.screens[0] || null;
          if (c.screen) assert.equal(s.screens.find((x) => x.kind === c.screen)?.kind, c.screen, `${c.say}: screen`);
          assert.ok(s.events.some((e) => e.via === 'chat' && e.to === c.state), `${c.say}: via chat`);
          const r = await until(async () => { const x = await g(); return x.chat.reply && x.chat.reply !== prev && !x.chat.busy ? x : null; }, FAKE ? 15000 : 180000, `the reply to ${c.say}`);
          prev = r.chat.reply;
          assert.equal(r.state, c.state, `${c.say}: still in the state when she replied`);
          await wait(300);
          await shot(`h3-${c.key}`);
          mark('check', `「${c.say}」→ ${r.state}（${ms} ms 开始切换），她回：「${r.chat.reply.slice(0, 40)}」`);
          transcript.push({ activity: c.title, said: c.say, reply: r.chat.reply, state: r.state, switchedAfterMs: ms, screens: r.screens.map((x) => `${x.id}=${x.kind}`), card: `${r.pip.title} ${r.pip.caption}`.trim(), shot: `h3-${c.key}.png`, screenKind: sc ? sc.kind : null });
          fs.writeFileSync(path.join(DIR, 'transcript.json'), JSON.stringify(transcript, null, 1) + '\n');
          await wait(2500);
        }
        const log = fs.readFileSync(path.join(dataDir, 'chat-log.json'), 'utf8');
        for (const c of CHATS) assert.ok(log.includes(c.say), `chat log has ${c.say}`);
        return transcript.map((t) => `「${t.said}」→ ${t.state} / ${t.screens.join(',')} / ${t.reply.slice(0, 30)}`).join(' | ');
      });

      await step(S, 'H4 桌宠现有的聊天（设置 → 聊天）：有游戏窗口的那些轮，在这里说也能切房间', async () => {
        await admin.bringToFront();
        await admin.evaluate(() => { location.hash = '#/chat/dafeiyu'; });
        await admin.waitForSelector('[data-chat-page] [data-chat-textarea]', { timeout: 30000 });
        const bubbles = () => admin.evaluate(() => [...document.querySelectorAll('[data-chat-page] [data-role]')].map((el) => ({ role: el.dataset.role, text: el.innerText.trim() })));
        const hist = await until(async () => { const b = await bubbles(); return b.some((x) => /回床上休息吧/.test(x.text)) ? b : null; }, 15000, 'the game-window rounds in her history');
        mark('step', '章节·现有聊天：设置窗口 → 聊天里说「听音乐吧」');
        await xsel(admin, '[data-chat-page] [data-chat-textarea]');
        await admin.keyboard.type('听音乐吧', { delay: 60 });
        await admin.keyboard.press('Enter');
        await until(async () => (await g()).state === 'music', 4000, 'music from the settings chat');
        await settledIn('music', 12000);
        await until(async () => !(await admin.evaluate(() => !!document.querySelector('[data-streaming]'))) && (await bubbles()).filter((x) => x.role === 'assistant').length > hist.filter((x) => x.role === 'assistant').length, FAKE ? 15000 : 180000, 'her reply in the settings chat');
        await admin.screenshot({ path: path.join(SHOTS, 'h4-settings-chat.png') });
        const last = (await bubbles()).filter((x) => x.role === 'assistant').pop();
        mark('check', `设置窗口的聊天切了房间，她回：「${last.text.slice(0, 40)}」`);
        await gp.bringToFront();
        await wait(600);
        await shot('h4-room-music');
        transcript.push({ activity: '听音乐（设置 → 聊天）', said: '听音乐吧', reply: last.text, state: (await g()).state, shot: 'h4-settings-chat.png' });
        fs.writeFileSync(path.join(DIR, 'transcript.json'), JSON.stringify(transcript, null, 1) + '\n');
        return JSON.stringify(obs('h4-settings-chat', { historyMessages: hist.length, reply: last.text, room: (await g()).state }));
      });

      await step(S, 'H5 点选入口：状态栏七个按钮和画面热点，不经过聊天', async () => {
        const out = [];
        await gp.evaluate(() => window.__gameTest.setRoundScale(6));
        for (const [sel, state, title] of [['#ir-bar .ir-act[data-kind="phone"]', 'phone', '看手机'], ['#ir-bar .ir-act[data-kind="music"]', 'music', '听音乐'], ['#ir-bar .ir-act[data-kind="sleep"]', 'sleep', '睡觉'], ['#ir-bar .ir-act[data-kind="work"]', 'work', '工作'], ['#ir-bar .ir-act[data-kind="game"]', 'game', '打游戏'], ['#ir-bar .ir-act[data-state="idle-lazy"]', 'idle-lazy', '犯懒'], ['#ir-bar .ir-act[data-kind="idle"]', 'idle', '发呆']]) {
          mark('step', `章节·点选${title}：点状态栏按钮`);
          await xsel(gp, sel);
          const s = await settledIn(state, 12000);
          assert.ok(s.events.some((e) => e.via !== 'chat' && e.to === state), `${state}: not via chat`);
          await wait(2000);
          await shot(`h5-click-${state}`);
          mark('check', `点「${title}」→ ${state}，按钮高亮`);
          out.push(state);
        }
        const hot = async (id) => (await g()).hotspots.find((h) => h.id === id);
        const bed = await hot('bed');
        const at = [bed.at[0] - 60, bed.at[1] + 40];
        mark('step', '章节·点选画面：悬停床，点床，点书桌');
        await xmove(gp, at[0], at[1]);
        const h = await until(async () => { const s = await g(); return s.hover === 'bed' ? s : null; }, 3000, 'hover bed');
        await shot('h5-hover-bed');
        await xclick(gp, at[0], at[1]);
        await settledIn('sleep', 12000);
        const desk = await hot('desk');
        await xclick(gp, desk.at[0], desk.at[1] - 30);
        await settledIn('work', 14000);
        mark('check', `悬停「${h.tip}」，点床 → 睡觉，点书桌 → 工作`);
        return JSON.stringify(obs('h5-click', { bar: out, hover: h.tip, hotspots: ['bed→sleep', 'desk→work'] }));
      });

      await step(S, 'H6 台灯：关 / 开两组对比（发呆、工作），状态栏、画面里的台灯、L 键', async () => {
        const pair = async (state, act) => {
          if ((await g()).state !== state) { await pressAct(act); await settledIn(state, 14000); }
          await lampTo(false);
          await quiet();
          await shot(`h6-${state}-off`);
          const a = await g();
          await lampTo(true);
          await quiet();
          await shot(`h6-${state}-on`);
          const b = await g();
          assert.equal(b.lamp.litAlpha, 1);
          assert.ok(b.lamp.glowAlpha > 0.2, `glow ${b.lamp.glowAlpha}`);
          assert.notDeepEqual(a.lamp.grade, b.lamp.grade);
          return { state, off: a.lamp, on: b.lamp };
        };
        mark('step', '章节·台灯：书桌前，关和开');
        const w = await pair('work', 'work');
        mark('check', `工作：开灯 glow ${w.on.glowAlpha}，整屋调色 ${w.off.grade} → ${w.on.grade}`);
        mark('step', '章节·台灯：床边发呆，关和开');
        const i = await pair('idle', 'idle');
        mark('check', `发呆：开灯 glow ${i.on.glowAlpha}`);
        await lampTo(false);
        const lamp = (await g()).hotspots.find((x) => x.id === 'lamp');
        mark('step', '点画面里的台灯，再按 L 键');
        await xclick(gp, lamp.at[0], lamp.at[1]);
        await until(async () => (await g()).lamp.on, 3000, 'hotspot on');
        await wait(600);
        await gp.keyboard.press('l');
        await until(async () => !(await g()).lamp.on, 3000, 'L off');
        mark('check', '画面里的台灯能开，L 键能关');
        return JSON.stringify(obs('h6-lamp', { work: w, idle: i, hotspot: 'on', key: 'off' }));
      });

      await step(S, 'H7 屏幕内容：短视频帧、真实网页滚动、封面歌词、小游戏得分', async () => {
        const dump = async (name, id) => {
          const url = await gp.evaluate((sid) => window.__gameTest.screenPng(sid), id);
          fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
        };
        mark('step', '章节·屏幕：手机放短视频');
        await pressAct('phone');
        await settledIn('phone', 14000);
        const c1 = (await g()).screens[0];
        await dump('h7-clip-a', 'phone');
        await wait(1000);
        const c2 = (await g()).screens[0];
        assert.ok(c1.clip.frames >= 20 && c2.clip.frame !== c1.clip.frame, 'frames advance');
        await dump('h7-clip-b', 'phone');
        await shot('h7-phone');
        mark('check', `短视频「${c2.clip.caption}」帧 ${c1.clip.frame} → ${c2.clip.frame}`);
        mark('step', '章节·屏幕：播放器');
        await pressAct('music');
        await settledIn('music', 14000);
        const seen = new Set();
        const t0 = (await g()).screens[0].track;
        for (let i = 0; i < 20; i++) { seen.add((await g()).screens[0].track.lyric); await wait(500); }
        const t1 = (await g()).screens[0].track;
        assert.ok(t1.pos > t0.pos && t0.cover && seen.size >= 2, 'the song plays');
        await dump('h7-player', 'phone');
        await shot('h7-music');
        mark('check', `《${t1.title}》${t1.time}，歌词「${t1.lyric}」`);
        mark('step', '章节·屏幕：电脑上的文档和真实网页');
        await pressAct('work');
        await settledIn('work', 14000);
        const pg = () => g().then((v) => v.screens.find((x) => x.id === 'laptop').page);
        await dump('h7-laptop-doc', 'laptop');
        const p1 = await until(async () => { const v = await pg(); return v && v.real && v.scroll > 40 ? v : null; }, 26000, 'the real page');
        await wait(2500);
        const p2 = await pg();
        assert.ok(p2.real && p2.scroll > p1.scroll, 'scrolls');
        await dump('h7-laptop-web', 'laptop');
        await shot('h7-work-web');
        mark('check', `真实网页「${p2.title}」滚动 ${p1.scroll} → ${p2.scroll} px`);
        mark('step', '章节·屏幕：小游戏');
        await pressAct('game');
        await settledIn('game', 14000);
        const s0 = (await g()).screens[0].score;
        await wait(2000);
        const s1 = (await g()).screens[0].score;
        assert.ok(s1 > s0);
        await dump('h7-laptop-game', 'laptop');
        await shot('h7-game');
        mark('check', `小游戏得分 ${s0} → ${s1}`);
        return JSON.stringify(obs('h7-screens', { clip: c2.clip, track: t1, lyrics: [...seen], page: p2, score: [s0, s1] }));
      });

      await step(S, 'H8 状态过渡：交叉淡化不是硬切，床 ↔ 书桌先起身', async () => {
        await pressAct('phone'); // 书桌 → 床, through 起身
        mark('step', '章节·过渡：书桌 → 床，先起身再过去');
        const names = [];
        const states = [];
        for (let i = 0; i < 12; i++) {
          const v = await g();
          states.push({ state: v.state, shown: v.shown, fading: v.fading });
          const n = `h8-seq-${String(i).padStart(2, '0')}`;
          await shot(n);
          names.push(n);
          await wait(180);
        }
        const s = await settledIn('phone', 14000);
        assert.ok(states.some((x) => x.shown === 'stand'), `she stands on the way (${JSON.stringify(states)})`);
        assert.ok(states.some((x) => x.fading), 'crossfade seen');
        const picked = names.filter((_, i) => i % 2 === 0).slice(0, 6);
        montage(picked, 'h8-transition-sequence', 3);
        const tr = s.transitions.slice(-2);
        for (const t of tr) assert.ok(t.seconds >= 0.8 && t.seconds <= 2.6, `crossfade ${t.seconds} s`);
        mark('check', `过渡：${tr.map((t) => `${t.from || ''}→${t.to || ''} ${t.seconds} s`).join('，')}，中段两张图同时半透明`);
        return JSON.stringify(obs('h8-transition', { states, transitions: tr }));
      });

      await step(S, 'H9 一整轮真实长度：看手机 20 秒结算，回到发呆', async () => {
        await pressAct('idle');
        await settledIn('idle', 14000);
        await gp.evaluate(() => window.__gameTest.setRoundScale(1));
        mark('step', '章节·一轮：看手机 20 秒');
        await pressAct('phone');
        await until(async () => (await g()).state === 'phone', 4000, 'phone');
        const done = await until(async () => { const s = await g(); return s.state === 'idle' && s.events.some((e) => e.via === 'tick' && e.settled && e.settled.kind === 'phone' && e.settled.complete) ? s : null; }, 50000, 'the round to finish');
        await settledIn('idle', 14000);
        await shot('h9-round-done');
        mark('check', `一轮结束：${done.toast}`);
        assert.deepEqual(done.errors, []);
        return JSON.stringify(obs('h9-round', { toast: done.toast, capsule: done.capsule.text }));
      });

      await step(S, 'H10 像素房间：从商店下载（真实 CDN），开始玩，点家具开始一轮', async () => {
        mark('step', '章节·像素房间：关掉游戏窗口，回商店');
        await xsel(gp, '#btn-close');
        await until(async () => !(await dbg()).visible, 8000, 'the game window closed');
        await admin.bringToFront();
        await admin.evaluate(() => { location.hash = '#/store/games'; });
        const card = '[data-store-game="pixel-room"]';
        await admin.waitForSelector(card, { timeout: 20000 });
        await wait(600);
        const text0 = await admin.locator(card).innerText();
        assert.match(text0, /像素房间/);
        await xsel(admin, '[data-game-download="pixel-room"]');
        await until(async () => (await admin.locator(card).getAttribute('data-game-state')) === 'installed', 60000, 'pixel-room installed');
        assert.equal(JSON.stringify(dirFiles(path.join(dataDir, 'games', 'pixel-room'))), JSON.stringify(cdn['pixel-room'].files));
        await wait(400);
        await admin.screenshot({ path: path.join(SHOTS, 'h10-pixel-store.png') });
        mark('check', `像素房间从 ${cdn['pixel-room'].url} 下载完成`);
        await xsel(admin, '[data-game-play="pixel-room"]');
        gp = await until(async () => { const w = app.windows().find(isGame); const v = w && await w.evaluate(() => window.__game && window.__game().engine); return v === 'room@1' ? w : null; }, 30000, 'the pixel room');
        await gp.bringToFront();
        await gp.evaluate(() => { window.__gameTest.roam(false); });
        const r0 = await until(async () => { const r = (await g()).room; return r && r.pet.mode === 'idle' && r.pet.walked > 100 ? r : null; }, 25000, 'her to walk in');
        await shot('h10-pixel-room');
        mark('check', '像素房间：engine room@1，大肥鱼在蓝色小屋');
        const pointOn = async (id) => { const f = (await g()).room.furniture.find((x) => x.id === id); return f.click; };
        const theme = (await g()).room.theme;
        const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'games', 'pixel-room', 'manifest.json'), 'utf8'));
        const at = manifest.themes.find((t) => t.id === theme).activities.phone.at;
        const [x, y] = await pointOn(at);
        mark('step', '点床头柜上的手机，开始「看手机」');
        await xmove(gp, x, y);
        await wait(350);
        await xclick(gp, x, y);
        const r1 = await until(async () => { const r = (await g()).room; return (r.run && r.run.kind === 'phone') ? r : null; }, 20000, 'the round in the pixel room');
        await wait(1500);
        await shot('h10-pixel-playing');
        mark('check', '像素房间可玩：她走过去开始看手机，进度在走');
        return JSON.stringify(obs('h10-pixel', { cardBefore: text0.split('\n')[0], theme, walked: r0.pet.walked, run: r1.run, errors: (await g()).errors }));
      });
    } finally {
      await stopRec().catch(() => {});
      server.close();
      try { await app.close(); } catch { /* gone */ }
      if (!FAKE) {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'pet.json'), 'utf8'));
          for (const c of Object.values(p.characters || {})) if (c.agentId) execFileSync('lh', ['agent', 'delete', c.agentId, '--yes'], { stdio: 'ignore' });
        } catch { /* best effort */ }
      }
    }
  };
};
