// 房间小游戏 (docs/room.md, T-6174), driven as a user does in the settings window: 小屋 → 她的房间.
//   R1  小屋 shows the way into her room (card + 去她的房间); it opens 小屋 / 她的房间
//   R2  大肥鱼's room: the picture loaded, her (maid outfit sheet) drawn, five hotspots, 5 room types in the picker
//   R3  切换房间类型: each of the five; the four 即将开放 show a preview (never empty, no error); the pick is saved
//   R4  too tired (精力 10): 工作 and 打游戏 are disabled with why
//   R5… 睡觉 / 工作 / 看手机 / 听音乐 / 打游戏: hotspot → running (her action, the prop, timer, progress, line) →
//       a whole round → settled: her numbers change the way the activity says, saved in pet.json
//   R10 switching mid-round settles the first one partly; 结束 ends the second one early
//   R11 relaunch: the room, her numbers and the totals are still there
//   R12 closed for longer than a round while she sleeps: on relaunch the round is settled at once (a whole
//       round, the numbers exactly so), before the room is even opened
//   R13 窗外的天色 (docs/room.md §5): ‹ › through the four phases (sun / moon, stars, lamps, the glass darker at
//       night, her line), the six weathers (clouds, rain, lightning, snow, fog), saved in settings.scene; flow, clock
// In every R5 step: no hotspot label is under her (P3); 睡觉 tucks her in under a cover inside the bed (P1);
// 工作 types line after line on the monitor's screen (P2); 打游戏's TV is wholly in the picture with a game on it (P4).
// Screenshots: out/e2e/room/*.png (+ video/ and chapters.json for the acceptance report).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const ROUND_MS = 4000;
// what one whole round does (src/core/room.js ACTIVITIES): the sign of each number's change
const EXPECT = {
  sleep: { energy: 1, mood: 1, focus: 1, fullness: -1 },
  work: { focus: 1, energy: -1, mood: -1, fullness: -1 },
  phone: { mood: 1, focus: -1, energy: -1 },
  music: { mood: 1, energy: 1, focus: 1 },
  game: { mood: 1, energy: -1, fullness: -1, focus: -1 },
};
// what the room shows while each one runs: her sheet action and the prop that changes
const SHOWS = { sleep: { action: 'sleep', prop: '[data-room-prop="night"][data-on="true"]' }, work: { action: 'think', prop: '[data-room-prop="monitor"][data-on="true"]' }, phone: { action: 'look', prop: '[data-room-prop="held-phone"]' }, music: { action: 'happy', prop: '[data-room-prop="record"][data-on="true"]' }, game: { action: 'play', prop: '[data-room-prop="tv"][data-on="true"]' } };
const LABEL = { sleep: '睡觉', work: '工作', phone: '看手机', music: '听音乐', game: '打游戏' };

module.exports = function roomScenario({ ROOT, OUT, FAKE_LH, step, launch }) {
  return async function room() {
    const S = 'room';
    const SHOTS = path.join(OUT, 'room');
    fs.rmSync(SHOTS, { recursive: true, force: true });
    fs.mkdirSync(SHOTS, { recursive: true });
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-room-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-roomfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    // evidence: only the five built-in characters (no PIXELPET_CATALOG_PREINSTALLED, .agents/acceptance)
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_ROOM_ROUND_MS: String(ROUND_MS), PIXELPET_CATALOG_PREINSTALLED: '' };
    const t0 = Date.now();
    const chapters = [];
    const chapter = (title) => chapters.push({ at: Math.round((Date.now() - t0) / 1000), title });
    const evidence = [];
    const note = (s) => evidence.push(s);
    let { app, page } = await launch(env, { video: path.join(SHOTS, 'video'), videoSize: { width: 1360, height: 860 } });
    let admin = null;
    const errors = [];
    const save = () => JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
    const mine = () => save().characters.dafeiyu;
    const shot = async (name) => {
      await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
      return `${name}.png`;
    };
    const until = async (fn, arg, ms = 15000, what = 'condition') => {
      const t = Date.now();
      for (;;) {
        if (await admin.evaluate(fn, arg).catch(() => false)) return;
        if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 120));
      }
    };
    const openAdmin = async (route) => {
      await page.evaluate((r) => window.pet.openAdmin(r), route);
      for (let i = 0; i < 300 && !admin; i++) {
        admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
        if (!admin) await new Promise((r) => setTimeout(r, 100));
      }
      if (!admin) throw new Error('the settings window did not open');
      admin.on('pageerror', (e) => errors.push(String(e)));
      admin.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      // a roomier window than the default 1080 × 720, so the screenshots show the room large
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')); w.setSize(1360, 860); w.center(); });
      await admin.waitForSelector(`[data-path="/${route}"]`, { timeout: 15000 });
    };
    const statsOnScreen = () => admin.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-room-stat]')].map((el) => [el.dataset.roomStat, Number(el.dataset.value)])));
    const noErrorPage = async () => assert.equal(await admin.evaluate(() => document.body.textContent.includes('这一页没有显示出来')), false, 'the page did not fail');
    // the hotspot labels her body covers (her frame's body: 29–71% across, from the top of her hair down);
    // and whether every label is painted above her (later in the scene) and inside the picture
    const labels = () => admin.evaluate(() => {
      const her = document.querySelector('[data-room-her]');
      const st = her.querySelector('[data-action]').getBoundingClientRect();
      const tucked = her.hasAttribute('data-tucked');
      const shown = her.getBoundingClientRect();
      const body = { l: st.left + st.width * 0.29, r: st.left + st.width * 0.71, t: st.top + st.height * 0.19, b: tucked ? shown.bottom : st.bottom };
      const scene = document.querySelector('[data-room-scene]').getBoundingClientRect();
      const chips = [...document.querySelectorAll('[data-room-chip]')];
      const hit = (b) => b.left < body.r && b.right > body.l && b.top < body.b && b.bottom > body.t;
      return {
        covered: chips.filter((c) => hit(c.getBoundingClientRect())).map((c) => c.dataset.roomChip),
        above: chips.every((c) => !!(her.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)),
        inside: chips.every((c) => { const b = c.getBoundingClientRect(); return b.left >= scene.left && b.right <= scene.right && b.top >= scene.top && b.bottom <= scene.bottom; }),
        texts: chips.map((c) => c.textContent),
      };
    });
    const rectOf = (sel) => admin.evaluate((q) => { const b = document.querySelector(q).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; }, sel);
    const within = (a, b, pad = 0.5) => a.l >= b.l - pad && a.t >= b.t - pad && a.r <= b.r + pad && a.b <= b.b + pad;
    const hatch = async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.uncheck('#local-opt').catch(() => {});
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
    };
    try {
      await hatch();
      // start tired, a little sad and hungry: the room has to show that work / games wait for a nap
      await page.evaluate(() => window.pet.debugSet({ energy: 10, mood: 40, hunger: 50 }));

      await step(S, 'R1 小屋 shows the way into her room; clicking it opens 小屋 / 她的房间', async () => {
        chapter('R1 小屋里的「她的房间」入口');
        await openAdmin('overview');
        await until(() => !!document.querySelector('[data-home-room] img') && document.querySelector('[data-home-room] img').naturalWidth > 0, null, 15000, 'the room card');
        const card = await admin.evaluate(() => document.querySelector('[data-home-room]').textContent);
        assert.match(card, /她的房间/);
        assert.match(card, /鲸鱼女仆的蓝色小屋/);
        assert.equal(await admin.locator('[data-go-room]').count(), 1, '去她的房间 button in the hero');
        await shot('r1-home-entry');
        await admin.click('[data-home-room]');
        await admin.waitForSelector('[data-path="/room"] [data-room-scene="dafeiyu"]', { timeout: 10000 });
        const trail = await admin.evaluate(() => document.querySelector('[data-back]').closest('div').textContent);
        assert.match(trail, /小屋.*\/.*她的房间/);
        return `入口卡片：「${card.trim()}」；面包屑：${trail}`;
      }, () => admin || page);

      await step(S, 'R2 大肥鱼的房间: picture loaded, her maid sheet drawn, five hotspots, five room types', async () => {
        chapter('R2 大肥鱼的蓝色女仆风房间');
        await until(() => { const i = document.querySelector('[data-room-scene] img'); return i && i.complete && i.naturalWidth > 0; }, null, 10000, 'the room picture');
        await until(() => !!document.querySelector('[data-room-her] [data-drawn]'), null, 15000, 'her sprite drawn');
        const info = await admin.evaluate(() => ({
          bg: document.querySelector('[data-room-scene] img').src.split('/').slice(-3).join('/'),
          sheet: document.querySelector('[data-room-her] [data-drawn]').dataset.drawn.split('/').slice(-3).join('/'),
          hotspots: [...document.querySelectorAll('[data-hotspot]')].map((b) => b.getAttribute('aria-label')),
          themes: [...document.querySelectorAll('[data-room-theme]')].map((t) => `${t.dataset.roomTheme}:${t.dataset.status}:${t.getAttribute('aria-selected')}`),
          stats: [...document.querySelectorAll('[data-room-stat]')].map((el) => `${el.dataset.roomStat}=${el.dataset.value}`),
        }));
        assert.equal(info.bg, 'rooms/dafeiyu/room.webp');
        assert.match(info.sheet, /dafeiyu-pixel\/sheets\/daily\.webp$/, 'her signature maid outfit');
        assert.equal(info.hotspots.length, 5);
        assert.deepEqual(info.themes, ['dafeiyu:open:true', 'claude:soon:false', 'grok:soon:false', 'gemini:soon:false', 'gpt:soon:false']);
        await shot('r2-dafeiyu-room');
        note(`R2 ${JSON.stringify(info)}`);
        return JSON.stringify(info);
      }, () => admin);

      await step(S, 'R3 切换房间类型 through all five: 即将开放 previews (never empty, no error), the pick is saved', async () => {
        chapter('R3 切换房间类型（五个主题）');
        const seen = [];
        for (const id of ['claude', 'grok', 'gemini', 'gpt']) {
          await admin.click(`[data-room-theme="${id}"]`);
          await admin.waitForSelector(`[data-room-preview="${id}"]`, { timeout: 8000 });
          await until((x) => document.querySelector(`[data-room-theme="${x}"]`).getAttribute('aria-selected') === 'true', id, 5000, `${id} selected`);
          const txt = await admin.evaluate((x) => document.querySelector(`[data-room-preview="${x}"]`).textContent, id);
          assert.match(txt, /即将开放/);
          assert.ok(txt.length > 30, `${id}: a real preview, not an empty box`);
          // her portrait on the card (docs/room.md §1.2), not a grey silhouette
          await until((x) => !!document.querySelector(`[data-room-portrait="${x}"] [data-drawn]`), id, 8000, `${id} portrait drawn`);
          const shade = await admin.evaluate((x) => document.querySelector(`[data-room-portrait="${x}"] canvas`).style.filter, id);
          assert.equal(shade, '', `${id}: portrait, not a silhouette`);
          await noErrorPage();
          assert.equal(save().roomTheme, id, 'the pick is saved');
          await admin.waitForTimeout(300);
          seen.push(`${id}：${txt.slice(0, 40)}`);
          await shot(`r3-theme-${id}`);
        }
        await admin.click('[data-room-back]');
        await admin.waitForSelector('[data-room-scene="dafeiyu"]', { timeout: 8000 });
        assert.equal(save().roomTheme, 'dafeiyu');
        assert.deepEqual(errors, [], 'no page errors');
        note(`R3 ${seen.join(' | ')}`);
        return seen.join(' | ');
      }, () => admin);

      await step(S, 'R4 精力 10: 工作 and 打游戏 wait for a nap (disabled, with why)', async () => {
        chapter('R4 太累：工作和打游戏要先睡觉');
        await until(() => Number(document.querySelector('[data-room-stat="energy"]').dataset.value) <= 11, null, 8000, 'energy 10 on screen');
        const st = await admin.evaluate(() => Object.fromEntries(['work', 'game', 'sleep'].map((k) => [k, { disabled: document.querySelector(`[data-room-act="${k}"]`).disabled, why: document.querySelector(`[data-hotspot="${k}"]`).getAttribute('aria-label') }])));
        assert.equal(st.work.disabled, true);
        assert.equal(st.game.disabled, true);
        assert.equal(st.sleep.disabled, false);
        assert.match(st.work.why, /太累/);
        // the reason is on the page, not only in a hover title (P5)
        const why = await admin.evaluate(() => { const el = document.querySelector('[data-room-tired]'); if (!el) return null; const b = el.getBoundingClientRect(); return { text: el.textContent, visible: b.width > 0 && b.height > 0 && getComputedStyle(el).visibility !== 'hidden' }; });
        assert.ok(why && why.visible, 'a visible 太累 note in the panel');
        assert.match(why.text, /太累了/);
        assert.match(why.text, /工作和打游戏/);
        assert.match(why.text, /睡一觉/);
        const chips = (await labels()).texts;
        assert.ok(chips.some((t) => /工作 · 太累了/.test(t)) && chips.some((t) => /打游戏 · 太累了/.test(t)), `hotspot labels say it: ${chips}`);
        await shot('r4-too-tired');
        return `${JSON.stringify(st)}；页面上：「${why.text}」；热点标签：${chips.join(' / ')}`;
      }, () => admin);

      for (const kind of ['sleep', 'work', 'phone', 'music', 'game']) {
        await step(S, `R5 ${LABEL[kind]}: hotspot → running (action, prop, timer, line) → a whole round → numbers change and are saved`, async () => {
          chapter(`R5 ${LABEL[kind]}`);
          const before = await statsOnScreen();
          const tBefore = (mine().room && mine().room.totals && mine().room.totals[kind]) || { completed: 0 };
          await admin.click(`[data-hotspot="${kind}"]`);
          await until((k) => document.querySelector('[data-room-scene]').dataset.roomActivity === k, kind, 5000, `${kind} running`);
          await until((sel) => !!document.querySelector(sel), SHOWS[kind].prop, 5000, `${kind} prop`);
          const run = await admin.evaluate(() => ({ her: document.querySelector('[data-room-her] [data-action]').dataset.action, now: document.querySelector('[data-room-now]').textContent, line: document.querySelector('[data-room-line]') && document.querySelector('[data-room-line]').textContent, chip: document.querySelector('[data-hotspot][data-active="true"]').textContent }));
          assert.equal(run.her, SHOWS[kind].action, 'her action');
          assert.match(run.now, new RegExp(`正在${LABEL[kind]}`));
          assert.match(run.now, /\d\d:\d\d \/ 00:04/);
          assert.ok(run.line, 'she says something');
          assert.equal(mine().room.activity.kind, kind, 'saved as running');
          await admin.waitForTimeout(1500);
          const pct = await admin.evaluate(() => Number(document.querySelector('[data-room-progress]').dataset.roomProgress));
          assert.ok(pct > 10 && pct < 100, `progress moves: ${pct}`);
          await shot(`r5-${kind}-running`);
          // P3: no hotspot label under her, all of them above her and inside the picture
          const lab = await labels();
          assert.deepEqual(lab.covered, [], `labels under her while ${kind}: ${lab.covered}`);
          assert.ok(lab.above && lab.inside, `labels above her and inside the picture: ${JSON.stringify(lab)}`);
          const scene = await rectOf('[data-room-scene]');
          let extra = '';
          if (kind === 'sleep') {
            // P1: tucked in — head shows, the cover is inside the bed and lace-trimmed with a bow
            const bed = await rectOf('[data-hotspot="sleep"]');
            const cover = await rectOf('[data-room-cover]');
            const her = await rectOf('[data-room-her][data-tucked]');
            assert.ok(within(cover, bed), `the cover stays on the bed: ${JSON.stringify({ cover, bed })}`);
            assert.ok(her.h > 20 && her.b <= cover.b, 'her head and shoulders above the cover');
            extra = `cover ${Math.round(cover.w)}×${Math.round(cover.h)} inside bed ${Math.round(bed.w)}×${Math.round(bed.h)}; her head ${Math.round(her.w)}×${Math.round(her.h)}`;
          }
          if (kind === 'work') {
            // P2: the screen glow sits on the monitor's screen; lines appear one after another
            const mon = await rectOf('[data-room-prop="monitor"]');
            const t1 = await admin.evaluate(() => Number(document.querySelector('[data-room-prop="monitor"]').dataset.roomTyped));
            await admin.waitForTimeout(900);
            const t2 = await admin.evaluate(() => Number(document.querySelector('[data-room-prop="monitor"]').dataset.roomTyped));
            const note2 = await admin.evaluate(() => document.querySelector('[data-room-work-lines]').textContent);
            assert.ok(t2 > t1, `more lines written: ${t1} → ${t2}`);
            assert.match(note2, /写好了 \d \/ 5 行/);
            extra = `monitor ${Math.round(mon.w)}×${Math.round(mon.h)} at (${Math.round(mon.l - scene.l)}, ${Math.round(mon.t - scene.t)}); lines ${t1} → ${t2}; 「${note2}」`;
          }
          if (kind === 'game') {
            // P4: the TV is wholly inside the picture with the game on it; she stands in front of the TV stand
            const tv = await rectOf('[data-room-prop="tv"]');
            assert.ok(within(tv, scene), `TV inside the picture: ${JSON.stringify({ tv, scene })}`);
            assert.ok(await admin.evaluate(() => !!document.querySelector('[data-room-prop="tv"] [data-room-level]')), 'a game on the TV');
            const her = await rectOf('[data-room-her] [data-action]');
            const mid = (her.l + her.r) / 2;
            assert.ok(mid > tv.l - tv.w * 0.3 && mid < tv.r && her.t + her.h * 0.19 >= tv.b - 1, `she is in front of the TV, below its screen: ${JSON.stringify({ her, tv })}`);
            extra = `TV ${Math.round(tv.w)}×${Math.round(tv.h)} inside the ${Math.round(scene.w)}×${Math.round(scene.h)} picture; her middle x ${Math.round(mid - scene.l)} (TV ${Math.round(tv.l - scene.l)}–${Math.round(tv.r - scene.l)})`;
          }
          if (extra) note(`R5 ${kind}: ${extra}`);
          // the round ends by itself
          await until(() => document.querySelector('[data-room-scene]').dataset.roomActivity === 'idle', null, ROUND_MS + 6000, `${kind} settled`);
          await until(() => !!document.querySelector('[data-room-last]'), null, 5000, 'the result');
          await admin.waitForTimeout(400);
          const after = await statsOnScreen();
          const saved = mine();
          const last = saved.room.last;
          assert.equal(saved.room.activity, null);
          assert.equal(last.kind, kind);
          assert.equal(last.complete, true);
          assert.equal(saved.room.totals[kind].completed, tBefore.completed + 1);
          for (const [k, sign] of Object.entries(EXPECT[kind])) {
            const d = last.deltas[k] || 0;
            // a number at its end (0 or 100) cannot move further
            if (!((sign > 0 && before[k] >= 100) || (sign < 0 && before[k] <= 0))) assert.ok(Math.sign(d) === sign, `${k} ${sign > 0 ? 'up' : 'down'}: ${JSON.stringify(last.deltas)}`);
          }
          const disk = { energy: Math.round(saved.energy), mood: Math.round(saved.mood), focus: Math.round(saved.room.focus), fullness: Math.round(100 - saved.hunger) };
          for (const k of Object.keys(disk)) assert.ok(Math.abs(disk[k] - after[k]) <= 1, `screen ${k}=${after[k]} = pet.json ${disk[k]}`);
          const res = await admin.evaluate(() => document.querySelector('[data-room-last]').textContent);
          await shot(`r5-${kind}-done`);
          const msg = `${LABEL[kind]}：before ${JSON.stringify(before)} → after ${JSON.stringify(after)}；pet.json deltas ${JSON.stringify(last.deltas)}；「${res}」；line「${run.line}」`;
          note(`R5 ${msg}`);
          return msg;
        }, () => admin);
      }

      await step(S, 'R10 switching mid-round settles the first partly; 结束 ends the second one early', async () => {
        chapter('R10 中途切换与结束');
        await admin.click('[data-hotspot="phone"]');
        await until(() => document.querySelector('[data-room-scene]').dataset.roomActivity === 'phone', null, 5000, 'phone');
        await admin.waitForTimeout(1200);
        await admin.click('[data-hotspot="music"]');
        await until(() => document.querySelector('[data-room-scene]').dataset.roomActivity === 'music', null, 5000, 'music');
        const sw = mine().room;
        assert.equal(sw.activity.kind, 'music');
        assert.equal(sw.last.kind, 'phone');
        assert.equal(sw.last.complete, false);
        assert.ok(sw.last.fraction >= 0.25 && sw.last.fraction < 1, `partial: ${sw.last.fraction}`);
        await shot('r10-switched-to-music');
        await admin.click('[data-room-stop]');
        await until(() => document.querySelector('[data-room-scene]').dataset.roomActivity === 'idle', null, 5000, 'stopped');
        const st = mine().room;
        assert.equal(st.activity, null);
        assert.equal(st.last.kind, 'music');
        assert.equal(st.last.complete, false);
        await admin.waitForTimeout(300);
        await shot('r10-stopped');
        const msg = `切换：看手机 做了 ${Math.round(sw.last.fraction * 100)}% ${JSON.stringify(sw.last.deltas)}；结束：听音乐 做了 ${Math.round(st.last.fraction * 100)}% ${JSON.stringify(st.last.deltas)}；totals ${JSON.stringify(st.totals)}`;
        note(`R10 ${msg}`);
        return msg;
      }, () => admin);

      await step(S, 'R11 relaunch: the room, her numbers and the totals are still there', async () => {
        chapter('R11 重启后仍在');
        const shown = await statsOnScreen();
        const totals = mine().room.totals;
        await app.close();
        admin = null;
        ({ app, page } = await launch(env));
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await openAdmin('room');
        await admin.waitForSelector('[data-room-scene="dafeiyu"]', { timeout: 10000 });
        await until(() => document.querySelectorAll('[data-room-stat]').length === 4, null, 8000, 'stats');
        const again = await statsOnScreen();
        for (const k of Object.keys(shown)) assert.ok(Math.abs(again[k] - shown[k]) <= 1, `${k}: ${shown[k]} → ${again[k]}`);
        assert.deepEqual(mine().room.totals, totals);
        await shot('r11-after-relaunch');
        return `before ${JSON.stringify(shown)} / after relaunch ${JSON.stringify(again)}; totals ${JSON.stringify(totals)}`;
      }, () => admin);

      await step(S, 'R12 closed for longer than a round while she sleeps: settled at once on relaunch, numbers exact', async () => {
        chapter('R12 关闭超过一轮后重开：直接结算');
        await admin.click('[data-hotspot="sleep"]');
        await until(() => document.querySelector('[data-room-scene]').dataset.roomActivity === 'sleep', null, 5000, 'sleep running');
        const b = mine();
        assert.equal(b.room.activity.kind, 'sleep');
        const before = { energy: b.energy, mood: b.mood, focus: b.room.focus, hunger: b.hunger, completed: (b.room.totals.sleep || { completed: 0 }).completed };
        await app.close();
        admin = null;
        await new Promise((r) => setTimeout(r, ROUND_MS + 2500)); // closed for longer than a whole round
        ({ app, page } = await launch(env, { video: path.join(SHOTS, 'video-sky'), videoSize: { width: 1360, height: 860 } })); // recorded: R12's page and R13 窗外
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        // settled by main at start — the room page has not been opened yet
        const a = mine();
        const clamp = (v) => Math.max(0, Math.min(100, v));
        assert.equal(a.room.activity, null, 'settled at start');
        assert.equal(a.room.last.kind, 'sleep');
        assert.equal(a.room.last.complete, true);
        assert.equal(a.room.last.fraction, 1);
        assert.equal(a.room.totals.sleep.completed, before.completed + 1);
        // a whole round of 睡觉: 精力 +35, 心情 +6, 专注 +8, 饱腹 -4 (clamped to 0..100; ±1 for the seconds of decay while closed)
        const want = { energy: clamp(before.energy + 35), mood: clamp(before.mood + 6), focus: clamp(before.focus + 8), hunger: clamp(before.hunger + 4) };
        const got = { energy: a.energy, mood: a.mood, focus: a.room.focus, hunger: a.hunger };
        for (const k of Object.keys(want)) assert.ok(Math.abs(got[k] - want[k]) <= 1, `${k}: want ${want[k]}, got ${got[k]}`);
        assert.equal(got.focus, want.focus, 'focus only moves in the room: exact');
        await openAdmin('room');
        await admin.waitForSelector('[data-room-scene="dafeiyu"][data-room-activity="idle"]', { timeout: 10000 });
        await until(() => !!document.querySelector('[data-room-last]'), null, 5000, 'the result');
        const res = await admin.evaluate(() => document.querySelector('[data-room-last]').textContent);
        assert.match(res, /睡觉（完成）/);
        const shown = await statsOnScreen();
        for (const k of ['energy', 'mood', 'focus']) assert.ok(Math.abs(shown[k] - Math.round(got[k])) <= 1, `screen ${k}`);
        assert.ok(Math.abs(shown.fullness - Math.round(100 - got.hunger)) <= 1, 'screen fullness');
        await shot('r12-settled-after-relaunch');
        const r = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
        const msg = `关闭前 ${JSON.stringify(r(before))}；关闭 ${(ROUND_MS + 2500) / 1000}s 后重开，未打开房间时 pet.json：activity=null，last=${JSON.stringify(a.room.last.deltas)} complete=${a.room.last.complete}；期望 ${JSON.stringify(r(want))}，实际 ${JSON.stringify(r(got))}；页面「${res}」`;
        note(`R12 ${msg}`);
        return msg;
      }, () => admin || page);

      await step(S, 'R13 窗外的天色: 时段 ‹ › through dawn / day / dusk / night, the six weathers, flow, clock, saved', async () => {
        chapter('R13 窗外的时间与天气');
        const settings = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).scene;
        await admin.waitForSelector('[data-room-sky] [data-room-sky-phase]', { timeout: 10000 });
        await admin.waitForSelector('[data-room-prop="window"] [data-room-glass] image', { timeout: 10000 });
        const sky = () => admin.evaluate(() => {
          const sc = document.querySelector('[data-room-scene]');
          const win = document.querySelector('[data-room-prop="window"]');
          const matrix = [...win.querySelectorAll('feColorMatrix')].map((m) => m.getAttribute('values'));
          return {
            phase: sc.dataset.roomPhase, hour: Number(sc.dataset.roomHour), weather: sc.dataset.roomWeather,
            card: document.querySelector('[data-room-sky-now]').textContent,
            body: win.dataset.roomBody, lights: Number(win.dataset.roomLights), stars: Number(win.dataset.roomStars),
            rain: !!win.querySelector('[data-room-rain]'), snow: !!win.querySelector('[data-room-snow]'), fog: !!win.querySelector('[data-room-fog]'), flash: !!win.querySelector('[data-room-flash]'),
            clouds: Number(win.querySelector('[data-room-clouds]').getAttribute('opacity')),
            outside: matrix[0], inside: matrix[1],
            line: document.querySelector('[data-room-line]')?.textContent ?? null,
          };
        });
        // the window's mean brightness on screen (0..255): the sky in the top of the glass (above where her line is said)
        const glassLuma = async () => {
          const box = await admin.evaluate(() => {
            const win = document.querySelector('[data-room-prop="window"]');
            const [x0, top, x1, bottom] = win.dataset.roomGlassBox.split(',').map(Number);
            const vb = win.viewBox.baseVal;
            const r = win.getBoundingClientRect();
            const sx = r.width / vb.width;
            const sy = r.height / vb.height;
            return { l: r.left + x0 * sx, t: r.top + top * sy, w: (x1 - x0) * sx, h: (bottom - top) * sy };
          });
          const png = await admin.screenshot({ clip: { x: box.l + box.w * 0.15, y: box.t + box.h * 0.08, width: box.w * 0.7, height: box.h * 0.3 } });
          return admin.evaluate(async (b64) => {
            const img = new Image();
            img.src = `data:image/png;base64,${b64}`;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const x = c.getContext('2d');
            x.drawImage(img, 0, 0);
            const d = x.getImageData(0, 0, c.width, c.height).data;
            let sum = 0;
            for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
            return Math.round(sum / (d.length / 4));
          }, png.toString('base64'));
        };
        // time stands still while we look at each phase
        if (await admin.evaluate(() => document.querySelector('[data-room-sky-toggle="flow"]').getAttribute('aria-checked') === 'true')) await admin.click('[data-room-sky-toggle="flow"]');
        await until(() => document.querySelector('[data-room-sky-toggle="flow"]').getAttribute('aria-checked') === 'false', null, 5000, 'flow off');
        await admin.locator('[data-room-sky]').scrollIntoViewIfNeeded();
        await admin.evaluate(() => document.querySelector('[data-room-scene]').scrollIntoView({ block: 'start' }));
        const rows = [];
        const seen = new Set();
        for (let i = 0; i < 4; i++) {
          await admin.click('[data-room-sky-phase-step="1"]');
          await admin.waitForTimeout(1500); // the ‹ › jump eases over a second
          const s = await sky();
          seen.add(s.phase);
          const luma = await glassLuma();
          rows.push({ ...s, luma });
          await shot(`r13-phase-${s.phase}`);
        }
        assert.deepEqual([...seen].sort(), ['dawn', 'day', 'dusk', 'night'], 'four phases');
        const by = Object.fromEntries(rows.map((r) => [r.phase, r]));
        assert.equal(by.day.body, 'sun');
        assert.equal(by.night.body, 'moon');
        assert.ok(by.night.lights > 0.8, `lamps on at night (${by.night.lights})`);
        assert.ok(by.day.lights < 0.05, `lamps off by day (${by.day.lights})`);
        assert.ok(by.night.stars > 0.5 && by.day.stars === 0, 'stars at night only');
        assert.ok(by.night.luma < by.day.luma * 0.7, `the window is darker at night (${by.night.luma} vs ${by.day.luma})`);
        assert.notEqual(by.night.inside, by.day.inside, 'the room is graded too');
        assert.match(by.night.line, /夜深了/, 'her line about the night');
        // to 白天 for the weathers
        while ((await sky()).phase !== 'day') { await admin.click('[data-room-sky-phase-step="1"]'); await admin.waitForTimeout(1300); }
        const weathers = [];
        for (let i = 0; i < 6; i++) {
          await admin.click('[data-room-sky-weather-step="1"]');
          await admin.waitForTimeout(3400); // a weather fades in over 3 seconds
          const s = await sky();
          weathers.push({ ...s, luma: await glassLuma() });
          await shot(`r13-weather-${s.weather}`);
        }
        const w = Object.fromEntries(weathers.map((r) => [r.weather, r]));
        assert.deepEqual(Object.keys(w).sort(), ['clear', 'cloudy', 'fog', 'rain', 'snow', 'storm']);
        assert.ok(w.rain.rain && w.storm.rain && w.storm.flash && w.snow.snow && w.fog.fog, 'rain, lightning, snow and fog are drawn');
        assert.ok(!w.clear.rain && !w.clear.snow && !w.clear.fog && w.clear.clouds === 0, 'clear: nothing');
        assert.ok(w.cloudy.clouds > 0.6 && w.rain.clouds > 0.9, 'clouds');
        assert.ok(w.storm.luma < w.clear.luma, `a storm is darker (${w.storm.luma} vs ${w.clear.luma})`);
        assert.match(w.rain.line, /下雨了/, 'her line about the rain');
        assert.match(w.snow.line, /下雪了/, 'her line about the snow');
        // back to 小雨 and 18:00 (黄昏), then saved for every mini game
        while ((await sky()).weather !== 'rain') { await admin.click('[data-room-sky-weather-step="1"]'); await admin.waitForTimeout(400); }
        while ((await sky()).phase !== 'dusk') { await admin.click('[data-room-sky-phase-step="1"]'); await admin.waitForTimeout(1300); }
        await admin.waitForTimeout(3400);
        await shot('r13-dusk-rain');
        await admin.waitForTimeout(500); // the save lands in settings.json
        const saved = settings();
        assert.equal(saved.weather, 'rain');
        assert.equal(saved.hour, 18);
        assert.equal(saved.autoWeather, false);
        // 随时间流动: an hour a minute
        await admin.click('[data-room-sky-toggle="flow"]');
        const h0 = (await sky()).hour;
        await admin.waitForTimeout(6000);
        const h1 = (await sky()).hour;
        assert.ok(h1 - h0 > 0.07 && h1 - h0 < 0.14, `flows an hour a minute (${h0} → ${h1})`);
        // 对齐本机时间
        await admin.click('[data-room-sky-toggle="clock"]');
        await admin.waitForTimeout(1500);
        const now = new Date();
        const clock = now.getHours() + now.getMinutes() / 60;
        const hc = (await sky()).hour;
        const off = Math.abs(hc - clock);
        assert.ok(Math.min(off, 24 - off) < 0.1, `follows the clock (${hc} vs ${clock})`);
        await admin.waitForTimeout(500); // the save lands in settings.json
        assert.equal(settings().followClock, true);
        // 天气自己变 (on: saved; a manual pick turns it off again)
        await admin.click('[data-room-sky-toggle="auto"]');
        await admin.waitForTimeout(500);
        assert.equal(settings().autoWeather, true);
        await admin.click('[data-room-sky-toggle="clock"]');
        await admin.click('[data-room-sky-toggle="flow"]');
        await admin.waitForTimeout(500);
        await admin.click('[data-room-sky-weather-step="-1"]');
        await admin.waitForTimeout(600);
        const last = settings();
        assert.equal(last.autoWeather, false, 'a manual pick turns 天气自己变 off');
        await noErrorPage();
        const msg = `时段：${rows.map((r) => `${r.card}（窗内亮度 ${r.luma}，灯 ${r.lights}，星星 ${r.stars}，${r.body === 'sun' ? '太阳' : '月亮'}）`).join('；')}。天气：${weathers.map((r) => `${r.card}（雨 ${r.rain ? '有' : '无'}，雪 ${r.snow ? '有' : '无'}，雾 ${r.fog ? '有' : '无'}，闪电 ${r.flash ? '有' : '无'}，云 ${r.clouds.toFixed(2)}，亮度 ${r.luma}，台词「${r.line}」）`).join('；')}。保存 settings.json scene：${JSON.stringify(saved)}；随时间流动 6 秒 ${h0.toFixed(3)} → ${h1.toFixed(3)}；对齐本机时间 ${hc.toFixed(2)}（本机 ${clock.toFixed(2)}）；手动选天气后 autoWeather=${last.autoWeather}`;
        note(`R13 ${msg}`);
        return msg;
      }, () => admin || page);
    } finally {
      await app.close().catch(() => {});
      fs.writeFileSync(path.join(SHOTS, 'chapters.json'), JSON.stringify(chapters, null, 2));
      fs.writeFileSync(path.join(SHOTS, 'evidence.json'), JSON.stringify({ evidence, errors }, null, 2));
    }
  };
};
