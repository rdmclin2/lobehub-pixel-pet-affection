// 房间小游戏 (docs/room.md, T-6174), driven as a user does in the settings window: 小屋 → 她的房间.
//   R1  小屋 shows the way into her room (card + 去她的房间); it opens 小屋 / 她的房间
//   R2  大肥鱼's room: the picture loaded, her (maid outfit sheet) drawn, five hotspots, 5 room types in the picker
//   R3  切换房间类型: each of the five; the four 即将开放 show a preview (never empty, no error); the pick is saved
//   R4  too tired (精力 10): 工作 and 打游戏 are disabled with why
//   R5… 睡觉 / 工作 / 看手机 / 听音乐 / 打游戏: hotspot → running (her action, the prop, timer, progress, line) →
//       a whole round → settled: her numbers change the way the activity says, saved in pet.json
//   R10 switching mid-round settles the first one partly; 结束 ends the second one early
//   R11 relaunch: the room, her numbers and the totals are still there
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
        await shot('r4-too-tired');
        return JSON.stringify(st);
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
    } finally {
      await app.close().catch(() => {});
      fs.writeFileSync(path.join(SHOTS, 'chapters.json'), JSON.stringify(chapters, null, 2));
      fs.writeFileSync(path.join(SHOTS, 'evidence.json'), JSON.stringify({ evidence, errors }, null, 2));
    }
  };
};
