// 她的房间 · 上架验收 (T-10804): the real games-repository pack (rdmclin2/pixel-pet-mini-games games/her-room,
// built by its scripts/build.js) bought in the store and played in the real app, as a user does:
//   xvfb-run -a -s "-screen 0 1600x1000x24" node e2e/run.js roomaccept
// Unlike `room` (the minimal fixture, rounds shortened): a fresh save, no PIXELPET_CATALOG_PREINSTALLED, every
// click and hover is a real X pointer event (xdotool on the Xvfb display, so the recording shows the pointer),
// and the five rounds run their real length. The store's CDN is a local server holding the archive the games
// repository built (PIXELPET_GAMES_REPO/out/<file>, checked against src/core/game-catalog.json, which
// `node scripts/sync-game-catalog.js --repo <games checkout> --all` wrote) and playing the repository's
// catalog.json; for the upgrade it publishes 1.0.1 (the same pack, version raised).
//   A1  a new save: she is on the desktop
//   A2  商店 → 小游戏: 她的房间 未下载 with its cover → 下载 → 已下载 · 开始玩; the detail page
//   A3  开始玩: the game window, she is in the room and gone from the desktop; ✕: she is back on the desktop
//   A4  the room: panorama, her close-up (招牌女仆装), the colours measured
//   A5  换房间: five rooms, 大肥鱼 可以玩, the other four 即将开放 (each preview), back to hers
//   A6  the five, each one whole real-length round: hotspot hover, her walk, in progress, numbers, done; then
//       stop early (结束) and switch mid-round
//   A7  restart (quit + start again): installed, last game, theme, numbers, last activity, today's quests kept
//   A8  upgrade: 1.0.1 published → 有更新 in the store and the game, 更新 → v1.0.1, progress kept
// Out: out/e2e/her-room-accept/ — shots/*.png, obs/*.json (each step's numbers), her-room-accept.mp4 +
// .chapters.json (the whole screen, the whole run).
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
const KINDS = ['sleep', 'work', 'phone', 'music', 'game'];

module.exports = function herRoomAcceptScenario({ ROOT, OUT, FAKE_LH, step: stepFn, launch }) {
  return async function herRoomAccept() {
    let step = stepFn;
    const S = 'roomaccept';
    const DIR = path.join(OUT, 'her-room-accept');
    const SHOTS = path.join(DIR, 'shots');
    const OBS = path.join(DIR, 'obs');
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.mkdirSync(OBS, { recursive: true });
    const REPO = path.resolve(process.env.PIXELPET_GAMES_REPO || path.join(ROOT, '..', 'rdmclin2', 'pixel-pet-mini-games'));
    const bundled = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'game-catalog.json'), 'utf8'));
    const entry = bundled.games.find((x) => x.id === 'her-room');
    assert.ok(entry, 'src/core/game-catalog.json has her-room (node scripts/sync-game-catalog.js --repo <games checkout> --all)');
    const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    const srcZip = path.join(REPO, 'out', entry.file);
    assert.equal(sha256(srcZip), entry.sha256, `${srcZip} is the archive the catalog lists`);
    const M = JSON.parse(fs.readFileSync(path.join(REPO, 'games', 'her-room', 'pack', 'manifest.json'), 'utf8'));
    const THEME = M.themes.find((t) => t.id === 'dafeiyu');
    const label = (kind) => M.activities[kind].label;
    const furnLabel = (kind) => THEME.furniture.find((x) => x.id === THEME.activities[kind].at).label;
    const at = (kind) => THEME.activities[kind].at;

    // the store's CDN and the games repository's catalog.json
    const cdn = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-acceptcdn-'));
    fs.copyFileSync(srcZip, path.join(cdn, entry.file));
    const repoCatalog = JSON.parse(fs.readFileSync(path.join(REPO, 'catalog.json'), 'utf8'));
    const repoEntry = repoCatalog.games.find((x) => x.id === 'her-room');
    let catalog = { ...repoCatalog, games: [{ ...repoEntry, published: repoEntry.published || '2026-11-05' }, ...repoCatalog.games.filter((x) => x.id !== 'her-room')] };
    const requests = [];
    const server = http.createServer((req, res) => {
      const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
      requests.push(name);
      if (name === 'catalog.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(catalog)); return; }
      const f = path.join(cdn, name);
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
      fs.createReadStream(f).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-acceptfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-accept-'));
    const base = `http://127.0.0.1:${server.address().port}`;
    // PIXELPET_CATALOG_PREINSTALLED '' — nothing counts as downloaded; a new, empty data dir
    const env = { PIXELPET_DATA_DIR: dataDir, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_PREINSTALLED: '', PIXELPET_CATALOG_URL: `${base}/games`, PIXELPET_GAME_INDEX_URL: `${base}/catalog.json` };
    const appVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    fs.writeFileSync(path.join(DIR, 'launch.json'), JSON.stringify({ command: 'xvfb-run -a -s "-screen 0 1600x1000x24" node e2e/run.js roomaccept', appVersion, env: { ...env, PIXELPET_TEST: '1', PIXELPET_CATALOG_PREINSTALLED_set: Object.prototype.hasOwnProperty.call(env, 'PIXELPET_CATALOG_PREINSTALLED') ? JSON.stringify(env.PIXELPET_CATALOG_PREINSTALLED) : null }, dataDirBefore: fs.readdirSync(dataDir), pack: { file: entry.file, bytes: entry.bytes, sha256: entry.sha256, from: srcZip } }, null, 1));

    // ---- recording (the whole screen) + chapters, full-screen grabs ------------------------------------------
    const SCREEN = (process.env.PIXELPET_ACCEPT_SCREEN || '1600x1000');
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
    const screen = (n) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '1', '-video_size', SCREEN, '-i', `${process.env.DISPLAY}+0,0`, '-frames:v', '1', path.join(SHOTS, `${n}.png`)]);
    const obs = (n, data) => { fs.writeFileSync(path.join(OBS, `${n}.json`), JSON.stringify(data, null, 1) + '\n'); return data; };

    // ---- real X pointer (xdotool) ------------------------------------------------------------------------------
    const origin = async (p) => p.evaluate(() => ({ x: window.screenX + (window.outerWidth - window.innerWidth), y: window.screenY + (window.outerHeight - window.innerHeight) }));
    // (no --sync: it waits for the pointer to move, so a move to where it already is blocks for seconds)
    const xmove = async (p, x, y) => { const o = await origin(p); execFileSync('xdotool', ['mousemove', String(Math.round(o.x + x)), String(Math.round(o.y + y))]); await wait(40); };
    const xclick = async (p, x, y) => { await xmove(p, x, y); await wait(120); execFileSync('xdotool', ['click', '1']); };
    const xglide = async (p, x, y, steps = 10) => {
      const loc = execFileSync('xdotool', ['getmouselocation', '--shell'], { encoding: 'utf8' });
      const X0 = Number(/X=(\d+)/.exec(loc)[1]); const Y0 = Number(/Y=(\d+)/.exec(loc)[1]);
      const o = await origin(p);
      for (let i = 1; i <= steps; i++) { execFileSync('xdotool', ['mousemove', String(Math.round(X0 + ((o.x + x) - X0) * i / steps)), String(Math.round(Y0 + ((o.y + y) - Y0) * i / steps))]); await wait(25); }
    };
    const xsel = async (p, sel, { glide = true } = {}) => {
      // (no actionability wait: the room's bar and labels change every frame, a wait for them to settle never ends)
      await p.locator(sel).first().scrollIntoViewIfNeeded({ timeout: 800 }).catch(() => {});
      const b = await p.locator(sel).first().boundingBox();
      assert.ok(b, `${sel} is on screen`);
      const x = b.x + b.width / 2; const y = b.y + b.height / 2;
      if (glide) await xglide(p, x, y);
      await xclick(p, x, y);
    };

    let { app, page } = await launch(env);
    let gp = null;
    let admin = null;
    const g = () => gp.evaluate(() => window.__game());
    const R = async () => (await g()).room;
    const T = (fn, arg) => gp.evaluate(fn, arg);
    const dbg = () => page.evaluate(() => window.pet.debugScene());
    const shot = (n) => gp.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const progress = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'games', '.progress', 'her-room.json'), 'utf8'));
    const petJson = () => { const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'pet.json'), 'utf8')); const c = p.characters[p.speciesId]; return { speciesId: p.speciesId, energy: c.energy, mood: c.mood, hunger: c.hunger, affection: c.affection }; };
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
    const pointOn = async (id) => {
      const r = await R();
      const f = r.furniture.find((x) => x.id === id);
      const b = r.pet.boxScreen;
      const inB = (x, y) => x >= b[0] - 4 && x <= b[0] + b[2] + 4 && y >= b[1] - 4 && y <= b[1] + b[3] + 4;
      const [x0, y0, w, h] = f.rect;
      const cands = [f.click, [x0 + w * 0.5, y0 + h * 0.3], [x0 + w * 0.2, y0 + h * 0.5], [x0 + w * 0.8, y0 + h * 0.5], [x0 + w * 0.15, y0 + h * 0.8], [x0 + w * 0.85, y0 + h * 0.8], [x0 + w * 0.5, y0 + h * 0.1]];
      return cands.find(([x, y]) => !inB(x, y)) || f.click;
    };
    // a real click on a piece of furniture; when nothing happened (no walk, no round) the page is asked what was
    // under the pointer, kept in obs/click-misses.json, and the click is tried once more (flagged in the video)
    const misses = [];
    const clickFurn = async (id, kind) => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const [x, y] = await pointOn(id);
        await xglide(gp, x, y, 14);
        await wait(350);
        await xclick(gp, x, y);
        const ok = await until(async () => { const v = await R(); return (v.pending && v.pending.kind === kind) || (v.run && v.run.kind === kind) ? v : null; }, 2500, 'the click took').catch(() => null);
        if (ok) return [x, y];
        const under = await gp.evaluate(([px, py]) => { const el = document.elementFromPoint(px, py); return el ? { tag: el.tagName, id: el.id, cls: String(el.className), text: (el.textContent || '').slice(0, 40) } : null; }, [x, y]);
        const r = await R();
        misses.push({ id, kind, attempt, at: [Math.round(x), Math.round(y)], under, hover: r.hover, tip: r.tip, pet: r.pet && { mode: r.pet.mode, box: r.pet.boxScreen }, run: r.run, pending: r.pending, toast: r.toast });
        fs.writeFileSync(path.join(OBS, 'click-misses.json'), JSON.stringify(misses, null, 1) + '\n');
        await shot(`miss-${id}-${attempt}`);
        mark('flag', `点击「${id}」后 2.5 秒没有反应（第 ${attempt} 次），已记录指针下的元素，${attempt === 1 ? '再点一次' : '放弃'}`);
      }
      throw new Error(`a click on ${id} did nothing twice (obs/click-misses.json)`);
    };
    const settledOf = (s, kind, n0) => s.events.filter((e) => e.settled && e.settled.kind === kind).slice(n0);
    const countSettled = async (kind) => (await g()).events.filter((e) => e.settled && e.settled.kind === kind).length;
    const parkPointer = async () => { await xglide(gp, 480, 70, 6); await wait(150); };
    const idleRoom = async () => {
      await T(() => window.__gameTest.roam(false));
      return until(async () => { const v = await R(); return !v.run && !v.pending && v.pet.mode !== 'use' ? v : null; }, 20000, 'nothing running');
    };
    const errorsOf = async () => (await g()).errors;
    const snap = (r) => ({ theme: r.theme, stats: r.stats, run: r.run, last: r.last, bar: r.bar, bubble: r.bubble.text, toast: r.toast, labels: r.labels.map((l) => ({ id: l.id, text: l.text, running: l.running, tired: l.tired })), props: r.props, statsCard: r.statsCard, lastText: r.lastText, pet: { x: Math.round(r.pet.x), y: Math.round(r.pet.y), mode: r.pet.mode, anim: r.pet.anim, pose: r.pet.pose, using: r.pet.using } });
    const hatch = async () => {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="dafeiyu"]').first().click();
      await page.fill('#pet-name', '大肥鱼');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
    };
    const openStore = async () => {
      await page.evaluate(() => window.pet.debugTrayClick('小游戏'));
      admin = await until(async () => app.windows().find(isAdmin) || null, 30000, 'the settings window');
      await admin.waitForSelector('[data-path="/store/games"]', { timeout: 20000 });
      await admin.waitForSelector('[data-store-game="her-room"]', { timeout: 20000 });
      await admin.bringToFront();
      return admin;
    };
    const cardState = () => admin.locator('[data-store-game="her-room"]').getAttribute('data-game-state');

    // PIXELPET_ACCEPT_ONLY=A1,A2,A3,A4,A6b runs just those (debugging; evidence runs run everything)
    const ONLY = process.env.PIXELPET_ACCEPT_ONLY ? process.env.PIXELPET_ACCEPT_ONLY.split(',') : null;
    const realStep = step;
    step = (sc, name, fn) => (ONLY && !ONLY.includes(name.split(' ')[0]) ? Promise.resolve() : realStep(sc, name, fn));
    try {
      await hatch();
      await page.waitForTimeout(800);
      await startRec();
      mark('step', '全新存档：孵化大肥鱼，她在桌面上');

      await step(S, 'A1 全新存档：桌面上的她可见，还没下载任何小游戏', async () => {
        const d = await dbg();
        assert.equal(d.petVisible, true);
        assert.deepEqual(d.games, [], 'no game installed');
        assert.equal(fs.existsSync(path.join(dataDir, 'games', 'her-room')), false);
        screen('a1-desktop-before');
        mark('check', '桌面上的大肥鱼可见，游戏窗口没有打开');
        return JSON.stringify(obs('a1-desktop-before', { petVisible: d.petVisible, petBounds: d.petBounds, gameWindowVisible: d.visible, installedGames: d.games, dataDirAppFiles: fs.readdirSync(dataDir).filter((f) => /\.json$/.test(f) || f === 'games').sort() }));
      });

      await step(S, 'A2 商店 → 小游戏：她的房间「未下载」带封面 → 真实鼠标点「下载」→「已下载 · 开始玩」；详情页', async () => {
        mark('step', '托盘「小游戏」→ 商店 → 小游戏');
        await openStore();
        await admin.waitForTimeout(800);
        assert.equal(await cardState(), 'remote');
        const card = await admin.locator('[data-store-game="her-room"]').innerText();
        const cover = await admin.evaluate(() => { const i = document.querySelector('[data-store-game="her-room"] img'); return i ? { src: i.getAttribute('src'), w: i.naturalWidth, h: i.naturalHeight, complete: i.complete } : null; });
        assert.ok(cover && cover.complete && cover.w > 0, `the cover is drawn (${JSON.stringify(cover)})`);
        await admin.screenshot({ path: path.join(SHOTS, 'a2-store-remote.png') });
        mark('check', '商店卡片：她的房间，封面、未下载、下载按钮');
        mark('step', '真实鼠标点「下载」');
        await xsel(admin, '[data-game-download="her-room"]');
        await until(async () => (await cardState()) === 'installed', 60000, 'installed');
        const files = fs.readdirSync(path.join(dataDir, 'games', 'her-room')).sort();
        assert.deepEqual(files, ['.catalog.json', 'dafeiyu-atlas.webp', 'dafeiyu-room.webp', 'dafeiyu-sprites.json', 'manifest.json']);
        await admin.waitForTimeout(400);
        await admin.screenshot({ path: path.join(SHOTS, 'a2-store-installed.png') });
        mark('check', '下载完成：卡片变成「已下载」，出现「开始玩」');
        const cardAfter = await admin.locator('[data-store-game="her-room"]').innerText();
        const stateAfter = await cardState();
        // its detail page
        mark('step', '点卡片封面进入详情页');
        await xsel(admin, '[data-game-open="her-room"]');
        await admin.waitForSelector('[data-game-detail="her-room"]', { timeout: 10000 });
        await admin.waitForTimeout(600);
        await admin.screenshot({ path: path.join(SHOTS, 'a2-store-detail.png'), fullPage: true });
        const detail = await admin.locator('[data-game-detail="her-room"]').innerText();
        mark('check', '详情页：大封面、已下载 v1.0.0、开始玩、玩法要点、更新说明');
        return JSON.stringify(obs('a2-store', { before: { state: 'remote', text: card, cover }, after: { state: stateAfter, text: cardAfter }, installedFiles: files, cdnRequests: requests.slice(), detail: detail.slice(0, 600) }));
      });

      await step(S, 'A3 开始玩：游戏窗口打开、她进到游戏里、桌面上的她消失；✕ 关闭后她回到桌面', async () => {
        mark('step', '详情页点「开始玩」');
        await xsel(admin, '[data-game-play="her-room"]');
        gp = await findGame(app);
        await ready();
        await T(() => { window.__gameTest.roam(false); window.__gameTest.setHour(12); window.__gameTest.setWeather('clear'); });
        await until(async () => { const r = await R(); return r.pet.mode === 'idle' && r.pet.walked > 100 ? r : null; }, 20000, 'her to walk in');
        await gp.bringToFront();
        await wait(500);
        const d = await dbg();
        assert.equal(d.visible, true); assert.equal(d.petVisible, false, 'her desktop window hid'); assert.equal(d.game, 'her-room');
        const r = await R();
        assert.equal(r.theme, 'dafeiyu'); assert.equal(r.owner, true); assert.match(String(r.lookUrl), /daily/);
        screen('a3-desktop-during');
        await shot('a3-game-open');
        mark('check', '游戏窗口里是大肥鱼（招牌女仆装）在她的蓝色小屋，桌面上的她不见了');
        const during = { petVisible: d.petVisible, gameVisible: d.visible, game: d.game, title: d.title, theme: r.theme, owner: r.owner, look: r.lookUrl, renderer: (await g()).renderer, version: (await g()).version };
        mark('step', '真实鼠标点标题栏 ✕ 关闭');
        await xsel(gp, '#btn-close');
        const d2 = await until(async () => { const x = await dbg(); return !x.visible && x.petVisible ? x : null; }, 8000, 'closed, pet back');
        await wait(600);
        screen('a3-desktop-after');
        mark('check', '游戏窗口关闭，桌面上的大肥鱼回来了');
        return JSON.stringify(obs('a3-open-close', { during, afterClose: { petVisible: d2.petVisible, gameVisible: d2.visible, petBounds: d2.petBounds } }));
      });

      await step(S, 'A4 房间全景与角色特写；配色测量', async () => {
        mark('step', '托盘「小游戏」再打开她的房间（上次玩的游戏）');
        await page.evaluate(() => window.pet.debugTrayClick('小游戏'));
        await until(async () => (await dbg()).visible, 8000, 'reopened');
        await gp.bringToFront();
        await idleRoom();
        await parkPointer();
        await wait(800);
        await shot('a4-room-panorama');
        const r = await R();
        const [bx, by, bw, bh] = r.pet.boxScreen.map(Math.round);
        const pad = 14;
        const crop = [Math.max(0, bx - pad), Math.max(0, by - pad), bw + pad * 2, bh + pad * 2];
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(SHOTS, 'a4-room-panorama.png'), '-vf', `crop=${crop[2]}:${crop[3]}:${crop[0]}:${crop[1]},scale=iw*3:ih*3:flags=neighbor`, path.join(SHOTS, 'a4-closeup-dafeiyu.png')]);
        mark('check', '房间全景：浅蓝和奶白、蕾丝床幔、蝴蝶结，大肥鱼穿女仆装站在房间里');
        return JSON.stringify(obs('a4-room', { theme: r.theme, themeName: THEME.name, palette: THEME.palette, motifs: THEME.motifs, outfit: THEME.outfit, look: r.lookUrl, petBox: r.pet.boxScreen, closeupCrop: crop, furniture: r.furniture.map((f) => ({ id: f.id, kind: f.kind, sprite: f.sprite })) }));
      });

      await step(S, 'A5 换房间：标题栏按钮打开卡片，五个主题，大肥鱼可以玩，其余四个即将开放', async () => {
        mark('step', '真实鼠标点标题栏「鲸鱼女仆的蓝色小屋 ▾」');
        await xsel(gp, '#room-btn');
        await until(async () => { const r = await R(); return r.picker.open && r.picker.items.length === 5 && r.picker.items.every((i) => i.avatar) ? r : null; }, 8000, 'the picker');
        await wait(600);
        let r = await R();
        assert.deepEqual(r.picker.items.map((i) => [i.id, i.status]), [['dafeiyu', 'open'], ['claude', 'soon'], ['grok', 'soon'], ['gemini', 'soon'], ['gpt', 'soon']]);
        await shot('a5-picker');
        mark('check', '换房间卡片：五个主题，大肥鱼「可以玩」，其余四个「即将开放」');
        const items = r.picker.items;
        const previews = [];
        for (const id of ['claude', 'grok', 'gemini', 'gpt']) {
          if (!(await R()).picker.open) await xsel(gp, '#room-btn');
          await until(async () => (await R()).picker.open, 4000, 'picker');
          mark('step', `点「${M.themes.find((t) => t.id === id).name}」`);
          await xsel(gp, `.pick[data-theme="${id}"]`);
          r = await until(async () => { const v = await R(); return v.preview && v.preview.id === id && v.preview.avatar ? v : null; }, 6000, `preview ${id}`);
          assert.equal(r.preview.soon, '即将开放'); assert.equal(r.theme, 'dafeiyu');
          await wait(900);
          await shot(`a5-soon-${id}`);
          mark('check', `${r.preview.name}：预览卡写「即将开放」，房间画面还在、不报错`);
          previews.push(r.preview);
          await xsel(gp, '#preview-back');
          await until(async () => !(await R()).preview, 4000, 'preview closed');
        }
        mark('step', '再打开卡片，点大肥鱼的房间');
        await xsel(gp, '#room-btn');
        await until(async () => (await R()).picker.open, 4000, 'picker');
        await xsel(gp, '.pick[data-theme="dafeiyu"]');
        r = await until(async () => { const v = await R(); return !v.picker.open ? v : null; }, 4000, 'picker closed');
        assert.equal(r.theme, 'dafeiyu');
        assert.deepEqual(await errorsOf(), []);
        mark('check', '回到鲸鱼女仆的蓝色小屋，可以继续玩');
        return JSON.stringify(obs('a5-themes', { items, previews, back: r.theme, errors: await errorsOf() }));
      });

      const roundLog = [];
      await step(S, 'A6 五件事各做一整轮（真实时长）：热点、走过去、进行中、数值变化、结束、切换到下一件', async () => {
        await T(() => window.__gameTest.setRoundScale(1));
        for (const kind of KINDS) {
          await idleRoom();
          const n0 = await countSettled(kind);
          const before = await R();
          // hotspot: hover
          const [hx, hy] = await pointOn(at(kind));
          mark('step', `${label(kind)}：鼠标移到「${furnLabel(kind)}」热点`);
          await xglide(gp, hx, hy, 14);
          const hov = await until(async () => { const v = await R(); return v.hover && v.hover.id === at(kind) ? v : null; }, 4000, `hover ${kind}`);
          await wait(500);
          await shot(`a6-${kind}-0-hotspot`);
          mark('check', `悬停「${furnLabel(kind)}」：描边，提示「${hov.tip}」`);
          const t0 = Date.now();
          await xclick(gp, hx, hy);
          mark('step', `点击「${furnLabel(kind)}」，她走过去`);
          const running = await until(async () => { const v = await R(); return v.run && v.run.kind === kind && v.run.progress > 0.45 ? v : null; }, M.activities[kind].seconds * 1000 + 20000, `${kind} half way`);
          await parkPointer();
          const mid = await R();
          await shot(`a6-${kind}-1-doing`);
          mark('check', `${label(kind)}进行中：她在做「${label(kind)}」，活动条 ${mid.bar && mid.bar.time}，家具标签「${(mid.labels.find((l) => l.id === at(kind)) || {}).text}」，数值卡斜纹预览`);
          const s = await until(async () => { const v = await g(); return settledOf(v, kind, n0).length ? v : null; }, M.activities[kind].seconds * 1000 + 15000, `${kind} settled`);
          const settled = settledOf(s, kind, n0)[0].settled;
          const after = s.room;
          await wait(300);
          await shot(`a6-${kind}-2-done`);
          mark('check', `${label(kind)}结束：「${after.toast}」，数值卡飘字`);
          assert.equal(settled.complete, true, `${kind}: a whole round`);
          const realSec = (Date.now() - t0) / 1000;
          for (const [k, v] of Object.entries(M.activities[kind].deltas)) {
            const dd = after.stats[k] - before.stats[k];
            if (v > 0) assert.ok(dd > 0 || after.stats[k] === 100, `${kind}: ${k} up (${before.stats[k]} → ${after.stats[k]})`);
            else assert.ok(dd < 0 || after.stats[k] === 0, `${kind}: ${k} down (${before.stats[k]} → ${after.stats[k]})`);
          }
          const pj = petJson();
          const sky = await g().then((v) => ({ hour: Math.round(v.hour * 100) / 100, phase: v.phase, dayFlow: !!v.scene.dayFlow, followClock: !!v.scene.followClock }));
          const o = obs(`a6-${kind}`, { kind, sky, label: label(kind), hotspot: { furniture: at(kind), tip: hov.tip, outline: hov.hover }, manifest: { seconds: M.activities[kind].seconds, deltas: M.activities[kind].deltas, anim: M.activities[kind].anim }, before: snap(before), during: snap(mid), settled, after: snap(after), petJson: pj, progressFile: progress().state, wallSecondsClickToSettle: Math.round(realSec * 10) / 10, delta: Object.fromEntries(Object.keys(before.stats).map((k) => [k, after.stats[k] - before.stats[k]])) });
          roundLog.push(`${kind}: ${JSON.stringify(before.stats)} → ${JSON.stringify(after.stats)} (${o.wallSecondsClickToSettle}s)「${after.toast}」`);
          await until(async () => !(await R()).run, 4000, 'props folded');
        }
        return roundLog.join('；');
      });

      await step(S, 'A6b 提前结束和中途切换（真实时长）：听音乐做到四成点「结束」；看手机做一会儿点书桌，前一件先结算、工作开始', async () => {
        await idleRoom();
        const n0 = await countSettled('music');
        mark('step', '点唱片机：听音乐，做到四成左右点「结束」');
        await clickFurn(at('music'), 'music');
        await until(async () => { const v = await R(); return v.run && v.run.kind === 'music' && v.run.progress > 0.4 ? v : null; }, 60000, 'music 40%');
        const shown = (await R()).run.progress;
        const tStop = Date.now();
        await xsel(gp, '#act-stop');
        const tClicked = Date.now();
        const s = await until(async () => { const v = await g(); return settledOf(v, 'music', n0).length ? v : null; }, 6000, 'music settled');
        const m = settledOf(s, 'music', n0)[0].settled;
        obs('a6b-debug', { n0, shown, clickMs: tClicked - tStop, settleMs: Date.now() - tStop, settled: m, musicEvents: s.events.filter((e) => e.settled && e.settled.kind === 'music'), lastEvents: s.events.slice(-12), room: snap(s.room), pointer: execFileSync('xdotool', ['getmouselocation'], { encoding: 'utf8' }) });
        assert.equal(m.complete, false);
        await wait(300);
        await shot('a6b-stopped');
        mark('check', `提前结束：「${s.room.toast}」`);
        await idleRoom();
        const p0 = await countSettled('phone');
        const beforeSwitch = await R();
        mark('step', '点床头柜：看手机，做一会儿后点书桌');
        await clickFurn(at('phone'), 'phone');
        await until(async () => { const v = await R(); return v.run && v.run.kind === 'phone' && v.run.progress > 0.3 ? v : null; }, 60000, 'phone running');
        await clickFurn(at('work'), 'work');
        const s2 = await until(async () => { const v = await g(); return settledOf(v, 'phone', p0).length ? v : null; }, 6000, 'phone settled by the switch');
        const ph = settledOf(s2, 'phone', p0)[0].settled;
        assert.equal(ph.complete, false);
        const w = await until(async () => { const v = await R(); return v.run && v.run.kind === 'work' && v.run.progress > 0.1 ? v : null; }, 30000, 'work after the switch');
        await parkPointer();
        await shot('a6b-switched');
        mark('check', `切换：看手机先结算（做了 ${Math.round(ph.fraction * 100)}%），工作开始`);
        await xsel(gp, '#act-stop');
        const after = await idleRoom();
        return JSON.stringify(obs('a6b-stop-switch', { stop: { shownProgress: shown, settled: m, toast: s.room.toast, stats: s.room.stats }, switch: { before: beforeSwitch.stats, phoneSettled: ph, toast: s2.room.toast, workRun: w.run }, after: after.stats, last: after.last }));
      });

      // restart
      let beforeRestart = null;
      await step(S, 'A7 重启：退出应用再打开，已下载、上次玩的游戏、房间、数值、上一件、今日小事都还在', async () => {
        const r = await idleRoom();
        const st = progress();
        beforeRestart = { stats: r.stats, last: r.last, lastText: r.lastText, theme: r.theme, quests: (await g()).quests, progress: st, petJson: petJson(), settingsGame: (await dbg()).settings.game };
        mark('step', '退出应用（app.quit），用同一个存档重新启动');
        // the games repository publishes 1.0.1 meanwhile (A8 uses it; the restart reads it)
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-acceptv2-'));
        execFileSync('unzip', ['-q', path.join(cdn, entry.file), '-d', work]);
        const mf = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
        fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify({ ...mf, version: '1.0.1' }, null, 2));
        const { zip } = require(path.join(ROOT, 'scripts', 'build-character-catalog'));
        const file = 'her-room-1.0.1.zip';
        zip(work, path.join(cdn, file));
        catalog = { ...catalog, games: catalog.games.map((x) => (x.id === 'her-room' ? { ...x, version: '1.0.1', file, bytes: fs.statSync(path.join(cdn, file)).size, sha256: sha256(path.join(cdn, file)), changelog: '验收用的测试版本：内容与 1.0.0 相同，只升版本号，用来走一遍商店升级。', published: '2026-11-06' } : x)) };
        await app.close();
        await wait(1500);
        ({ app, page } = await launch(env));
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await page.waitForTimeout(1000);
        screen('a7-desktop-restarted');
        mark('check', '重启后大肥鱼回到桌面');
        mark('step', '托盘「小游戏」打开（上次玩的游戏）');
        await page.evaluate(() => window.pet.debugTrayClick('小游戏'));
        gp = await findGame(app);
        await ready();
        await gp.bringToFront();
        await T(() => window.__gameTest.roam(false));
        const r2 = await until(async () => { const v = await R(); return v.lastText && v.stats ? v : null; }, 8000, 'restored');
        await parkPointer();
        await wait(1200);
        await shot('a7-restored');
        const d = await dbg();
        const after = { stats: r2.stats, last: r2.last, lastText: r2.lastText, theme: r2.theme, quests: (await g()).quests, progress: progress(), petJson: petJson(), settingsGame: d.settings.game, installed: d.games, version: (await g()).version };
        assert.equal(after.theme, 'dafeiyu'); assert.equal(d.game, 'her-room'); assert.equal(after.version, '1.0.0');
        // focus is the room's own number (the progress file): exactly kept. Energy / mood / fullness are hers
        // (pet.json) and live on in real time while the app is closed (PetService.load → resetWake.tick), so
        // they may only have drifted a little the way time moves them, never jumped back to defaults
        assert.equal(after.stats.focus, beforeRestart.stats.focus, 'focus kept');
        for (const k of ['energy', 'mood', 'fullness']) assert.ok(Math.abs(after.stats[k] - beforeRestart.stats[k]) <= 5, `${k} kept (${beforeRestart.stats[k]} → ${after.stats[k]})`);
        assert.equal(after.lastText, beforeRestart.lastText);
        assert.deepEqual(after.progress.state.totals || null, beforeRestart.progress.state.totals || null);
        assert.deepEqual(after.quests, beforeRestart.quests, 'today\'s quests kept');
        mark('check', `重启后：还是鲸鱼女仆的蓝色小屋，数值卡与重启前一致，「${after.lastText}」`);
        return JSON.stringify(obs('a7-restart', { before: beforeRestart, after }));
      });

      await step(S, 'A8 升级：游戏仓库发布 1.0.1 → 游戏里提示有新版本、商店「有更新」→ 真实鼠标点「更新」→ v1.0.1，进度还在', async () => {
        const chip = await until(async () => { const v = await g(); return v.update && v.update.to === '1.0.1' ? v.update : null; }, 15000, 'the update chip');
        await shot('a8-game-chip');
        mark('check', '游戏标题栏：有新版本 v1.0.1 · 去更新');
        const before = await R();
        mark('step', '点「有新版本 · 去更新」：打开商店里她的房间的详情页');
        await xsel(gp, '#update-chip');
        admin = await until(async () => app.windows().find(isAdmin) || null, 30000, 'the settings window');
        await admin.waitForSelector('[data-game-detail="her-room"]', { timeout: 20000 });
        await admin.bringToFront();
        await until(async () => /v1\.0\.0 → v1\.0\.1/.test(await admin.textContent('[data-game-detail-meta="her-room"]')), 15000, 'v1.0.0 → v1.0.1 on its page');
        const meta = await admin.textContent('[data-game-detail-meta="her-room"]');
        const notes = await admin.textContent('[data-game-changelog="her-room"]');
        await admin.waitForTimeout(500);
        await admin.screenshot({ path: path.join(SHOTS, 'a8-store-detail-update.png') });
        mark('check', `详情页：有更新 ${meta}，「v1.0.1 更新了什么」和「更新到 v1.0.1」`);
        // the card in the list too
        mark('step', '点「‹ 小游戏」回到卡片列表');
        await admin.evaluate(() => { location.hash = '#/store/games'; });
        await admin.waitForSelector('[data-store-game="her-room"]', { timeout: 10000 });
        await until(async () => (await cardState()) === 'update', 10000, '有更新 on the card');
        const cardMeta = await admin.textContent('[data-store-game-meta="her-room"]');
        await admin.waitForTimeout(400);
        await admin.screenshot({ path: path.join(SHOTS, 'a8-store-card-update.png') });
        mark('check', `卡片：角标「有更新」，${cardMeta}`);
        mark('step', '进详情页，真实鼠标点「更新到 v1.0.1」');
        await xsel(admin, '[data-game-open="her-room"]');
        await admin.waitForSelector('[data-game-update="her-room"]', { timeout: 10000 });
        await xsel(admin, '[data-game-update="her-room"]');
        await until(async () => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'games', 'her-room', 'manifest.json'), 'utf8')).version === '1.0.1'; } catch { return false; } }, 60000, 'updated on disk');
        await until(async () => /已装 v1\.0\.1/.test(await admin.textContent('[data-game-about="her-room"]')), 15000, '已装 v1.0.1');
        const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'games', 'her-room', 'manifest.json'), 'utf8')).version;
        await admin.waitForTimeout(500);
        await admin.screenshot({ path: path.join(SHOTS, 'a8-store-updated.png') });
        mark('check', '更新完成：已装 v1.0.1');
        mark('step', '点「开始玩」');
        await xsel(admin, '[data-game-play="her-room"]');
        gp = await findGame(app);
        await until(async () => { const v = await g().catch(() => null); return v && v.ready && v.version === '1.0.1' ? v : null; }, 20000, 'v1.0.1 in the game');
        await gp.bringToFront();
        await T(() => window.__gameTest.roam(false));
        const r = await until(async () => { const v = await R(); return v.lastText ? v : null; }, 8000, 'room');
        await parkPointer();
        await wait(1000);
        await shot('a8-after-update');
        assert.equal(await gp.textContent('#game-version'), 'v1.0.1');
        assert.equal(r.lastText, before.lastText);
        assert.deepEqual(r.stats, before.stats);
        mark('check', '游戏里显示 v1.0.1，没有更新提示，数值卡和「上一件」与更新前一致');
        const out = obs('a8-upgrade', { chip, detailMeta: meta, cardMeta, changelog: notes, onDisk, before: { stats: before.stats, lastText: before.lastText }, after: { version: await gp.textContent('#game-version'), update: (await g()).update, stats: r.stats, lastText: r.lastText, theme: r.theme }, cdnRequests: requests.slice() });
        mark('step', '关闭游戏，她回到桌面');
        await xsel(gp, '#btn-close');
        await until(async () => { const x = await dbg(); return !x.visible && x.petVisible ? x : null; }, 8000, 'closed');
        await wait(800);
        screen('a8-desktop-end');
        return JSON.stringify(out);
      });
    } finally {
      await stopRec().catch(() => {});
      server.close();
      try { await app.close(); } catch { /* gone */ }
    }
  };
};
