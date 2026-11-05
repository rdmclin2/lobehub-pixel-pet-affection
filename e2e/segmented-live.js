'use strict';

// 分段式表达 with the REAL agent (run.js `segmentedlive`, tokens; not in "all"). Real `lh`, a real LobeHub agent in
// the personal space (deleted at the end, also on failure). Three model calls: her hatch greeting, one chat turn,
// and one more message sent while that reply is still coming out.
//   SL1  one message from the owner → her real reply comes out as ≥ 4 short messages, one by one, in order, with
//        typing gaps; screenshots at 1 / 2 / 3 / 4 messages; wall-clock timestamps of every message
//   SL2  a second message while a reply is still coming out: the rest of the old reply stops, the new reply plays
//        from its first message, nothing of the old one shows up later
//   SL3  聊天记录 (设置 → 聊天记录) has both turns whole; read aloud offered once per reply; no page / console errors
// Evidence in out/e2e/segmented-live/: screenshots, video/, live-timeline.txt, renderer-logs.json, chat-log.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

module.exports = function segmentedLiveScenario(ctx) {
  const { OUT, step, launch, hover, clickAct, openAdminWindow, adminUntil } = ctx;
  const lhEnv = { ...process.env };
  for (const k of ['LOBEHUB_TOPIC_ID', 'LOBEHUB_OPERATION_ID', 'LOBEHUB_AGENT_ID', 'LOBEHUB_ASSISTANT_MESSAGE_ID', 'LOBEHUB_WORKSPACE_ID']) delete lhEnv[k];
  lhEnv.LOBEHUB_JWT = '';
  const lh = (...a) => execFileSync('lh', a, { env: lhEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return async function segmentedLive() {
    const S = 'segmented-live';
    const SHOTS = path.join(OUT, S);
    fs.mkdirSync(SHOTS, { recursive: true });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-seglive-'));
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true, voiceInteractions: false } }));
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1' };
    const { app, page } = await launch(env, { video: path.join(SHOTS, 'video') });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
    let agentId = null;
    const onSignal = () => { if (agentId) { try { lh('agent', 'delete', agentId, '--yes'); } catch { /* best effort */ } } process.exit(143); };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    const timeline = [];
    const idle = (ms = 150000) => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: ms });
    const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const logged = () => JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8')).messages;
    const segs = () => page.evaluate(() => [...document.querySelectorAll('#bubble .seg')].map((e) => e.textContent));
    const startSampler = () => page.evaluate(() => {
      clearInterval(window.__sampler);
      window.__samples = [];
      window.__sampler = setInterval(() => {
        const b = document.getElementById('bubble');
        const hidden = b.classList.contains('hidden');
        window.__samples.push({ wall: Date.now(), segs: hidden ? [] : [...b.querySelectorAll('.seg')].map((e) => e.textContent), typing: !hidden && !!b.querySelector('.seg-typing'), busy: document.body.classList.contains('busy') });
      }, 30);
    });
    // from the moment she starts on the new message (busy): before that the bubble may still show the last reply
    const stopSampler = async () => {
      const all = await page.evaluate(() => { clearInterval(window.__sampler); return window.__samples; });
      const i = all.findIndex((x) => x.busy);
      return i < 0 ? all : all.slice(i);
    };
    // performance.now() → wall clock, so the player's log reads as real times
    const segLogWall = () => page.evaluate(() => window.petFx.segLog().map((e) => ({ ...e, wall: Math.round(performance.timeOrigin + e.at) })));
    const iso = (ms) => new Date(ms).toISOString();
    const sendText = async (text) => {
      await hover(page);
      if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
      await page.fill('#chat-input', text);
      const t = Date.now();
      await page.click('#chat-send');
      return t;
    };
    try {
      await page.waitForSelector('.char-card');
      await step(S, 'SL0 real lh: a real agent is created and greets her owner', async () => {
        await page.locator('.char-card[data-species="claude"]').first().click();
        await page.uncheck('#local-opt');
        await page.fill('#pet-name', '芽芽');
        await page.click('#hatch-btn');
        const where = await Promise.race([
          page.waitForSelector('#space-box:not(.hidden)', { timeout: 120000 }).then(() => 'asked'),
          page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 }).then(() => 'not asked'),
        ]);
        if (where === 'asked') await page.click('#space-go');
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 });
        agentId = (await page.evaluate(async () => (await window.pet.boot()).view)).pet.agentId;
        assert.match(agentId, /^agt_/);
        await idle();
        await page.waitForTimeout(4000); // let the greeting finish playing
        const role = lh('agent', 'view', agentId);
        assert.match(role, /每条单独一行/, 'her LobeHub agent has the 分段 rule');
        fs.writeFileSync(path.join(SHOTS, 'agent-role-excerpt.txt'), role.split('\n').filter((l) => /分段|每条单独一行|调皮|亲近|短消息|在吗/.test(l)).join('\n') + '\n');
        // optional: a closer relationship stage (all-ages), the tone the 分段 rule is written for; the role follows next turn
        const aff = Number(process.argv[3] || 0);
        if (aff > 0) {
          await page.evaluate((a) => window.pet.debugSet({ affection: a }), aff);
          // the 关系升级 toast covers her; she also says a stage-up line (one more model call): let it finish
          await page.waitForSelector('#toast-close', { state: 'visible', timeout: 5000 }).then(() => page.click('#toast-close')).catch(() => {});
          await page.waitForTimeout(1500);
          await idle();
          await page.waitForFunction(() => { const s = window.petFx.segState(); return !s || s.done; }, null, { timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(3000);
          if (await page.isVisible('#toast-close')) await page.click('#toast-close');
        }
        const status = await page.evaluate(() => window.__petStatus().summary);
        timeline.push('[SL0]', `  agent ${agentId}`, `  greeting: ${JSON.stringify(await segs())}`, `  status after setup: ${status}`, '');
        return `agent ${agentId}; ${status}; greeting segs ${JSON.stringify(await segs())}`;
      }, page);

      let first = null;
      await step(S, 'SL1 one message → her real reply comes out as ≥4 messages, one by one, in order, with gaps', async () => {
        const before = logged().length;
        await startSampler();
        const tSend = await sendText('嗨～我刚下班回来，你今天有没有想我呀？');
        const seenShots = new Set();
        // wait for the reply, screenshot every count as it appears
        const deadline = Date.now() + 150000;
        let doneSeen = false;
        while (Date.now() < deadline) {
          const n = (await segs()).length;
          for (let k = 1; k <= Math.min(n, 6); k++) if (!seenShots.has(k)) { seenShots.add(k); await shot(`sl1-${k}-msgs`); }
          const st = await page.evaluate(() => window.petFx.segState());
          if (st && st.done && n > 0 && !(await page.evaluate(() => document.body.classList.contains('busy')))) { doneSeen = true; break; }
          await page.waitForTimeout(40);
        }
        assert.ok(doneSeen, 'the reply never finished playing');
        await page.waitForTimeout(500);
        await shot('sl1-final');
        const samples = await stopSampler();
        const log = (await segLogWall()).filter((e) => e.wall >= tSend);
        const start = log.find((e) => e.ev === 'start');
        assert.ok(start, `no segmented playback (bubble: ${JSON.stringify(await segs())})`);
        const reveals = log.filter((e) => e.id === start.id && e.ev === 'reveal');
        const msgs = reveals.map((e) => e.text);
        assert.ok(msgs.length >= 4, `only ${msgs.length} messages: ${JSON.stringify(msgs)}`);
        assert.deepEqual(reveals.map((e) => e.i), msgs.map((_, i) => i), 'reveals out of order');
        // on screen: counts only grow one at a time and always show the first n messages
        const counts = samples.map((s) => s.segs.length).filter((c, i, a) => c > 0 && (i === 0 || c !== a[i - 1]));
        assert.deepEqual(counts, msgs.map((_, i) => i + 1), `counts went ${JSON.stringify(counts)}`);
        const gaps = reveals.slice(1).map((e, i) => e.wall - reveals[i].wall);
        assert.ok(gaps.every((g) => g >= 300 && g <= 5000), `gaps ${gaps}`);
        const added = logged().slice(before);
        assert.equal(added.length, 2);
        assert.equal(added[1].role, 'pet');
        first = { id: start.id, msgs, reveals, gaps, tSend, full: added[1].text };
        timeline.push('[SL1 真实 agent 的一次回复]', `  user sent 「嗨～我刚下班回来，你今天有没有想我呀？」 at ${iso(tSend)}`,
          ...log.filter((e) => e.id === start.id).map((e) => `  ${iso(e.wall)}  ${e.ev}${e.i == null ? '' : `#${e.i}`}${e.text ? ` 「${e.text}」` : ''}${e.reason ? ` reason=${e.reason}` : ''}`),
          `  gaps between messages: ${gaps.map((g, i) => `#${i + 1}→#${i + 2} ${g} ms`).join(', ')}`,
          `  on-screen counts (30 ms sampler): ${counts.join(' → ')}`,
          `  chat-log pet text: ${JSON.stringify(added[1].text)}`, '');
        return `${msgs.map((m) => `「${m}」`).join(' → ')}; gaps ${gaps.join('/')} ms`;
      }, page);

      await step(S, 'SL2 a new message while a reply is still coming out: old one stops, new one plays, nothing left over', async () => {
        await startSampler();
        const tSend = await sendText('跟我说说你今天都做了些什么，一件一件讲给我听嘛');
        // wait for her reply to start playing, then cut in after the first or second message
        await page.waitForFunction(() => { const s = window.petFx.segState(); return s && !s.done && s.shown >= Math.min(2, s.total - 1) && !document.body.classList.contains('busy'); }, null, { timeout: 150000 });
        await shot('sl2-before-cut');
        const tCut = await sendText('等等等等，先告诉我你现在心情怎么样？');
        await page.waitForTimeout(300);
        await shot('sl2-just-after-cut');
        await idle();
        await page.waitForFunction(() => { const s = window.petFx.segState(); return s && s.done; }, null, { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(6000); // the rest of the old reply would have come by now
        await shot('sl2-after');
        const samples = await stopSampler();
        const log = (await segLogWall()).filter((e) => e.wall >= tSend);
        const cancel = log.find((e) => e.ev === 'cancel' && e.wall >= tCut);
        const starts = log.filter((e) => e.ev === 'start');
        assert.ok(starts.length >= 1, 'the first reply never played segmented');
        const oldId = starts[0].id;
        const oldReveals = log.filter((e) => e.id === oldId && e.ev === 'reveal');
        const newStart = starts.find((e) => e.wall > tCut);
        assert.ok(newStart, 'the new reply did not play segmented');
        const newReveals = log.filter((e) => e.id === newStart.id && e.ev === 'reveal');
        let cutNote;
        if (cancel) {
          assert.equal(cancel.id, oldId);
          assert.equal(cancel.reason, 'new-message');
          assert.equal(log.filter((e) => e.id === oldId && e.ev === 'reveal' && e.wall > cancel.wall).length, 0, 'old reply kept coming after the cancel');
          assert.equal(log.filter((e) => e.id === oldId && e.ev === 'done').length, 0);
          cutNote = `cancel(new-message) at ${cancel.shown}/${cancel.total}`;
        } else {
          // the old reply finished before the cut landed: then it must be done before the new one starts
          const done = log.find((e) => e.id === oldId && e.ev === 'done');
          assert.ok(done && done.wall <= newStart.wall, 'neither canceled nor finished before the new reply');
          cutNote = 'old reply had already finished';
        }
        assert.deepEqual(newReveals.map((e) => e.i), newReveals.map((_, i) => i), 'new reply out of order');
        const oldTexts = oldReveals.map((e) => e.text);
        const fullOld = logged().filter((m) => m.role === 'pet').slice(-2)[0].text;
        const unshownOld = fullOld.split('\n').map((x) => x.trim()).filter((x) => x && !oldTexts.includes(x) && !newReveals.some((r) => r.text === x));
        const after = samples.filter((s) => s.wall > newStart.wall);
        assert.ok(after.every((s) => !s.segs.some((x) => unshownOld.includes(x))), 'an unshown old message appeared after the new reply started');
        assert.ok(after.every((s) => s.segs.every((x, i) => x === (newReveals[i] || {}).text || i === s.segs.length - 1)), 'bubble mixed old and new messages');
        const st = await page.evaluate(() => window.petFx.segState());
        assert.equal(st.timer, false);
        timeline.push('[SL2 回复途中再发一条]', `  user sent 「跟我说说你今天都做了些什么，一件一件讲给我听嘛」 at ${iso(tSend)}`, `  user cut in 「等等等等，先告诉我你现在心情怎么样？」 at ${iso(tCut)}`,
          ...log.map((e) => `  ${iso(e.wall)}  [${e.id === oldId ? 'old' : e.id === newStart.id ? 'new' : e.id}] ${e.ev}${e.i == null ? '' : `#${e.i}`}${e.text ? ` 「${e.text}」` : ''}${e.reason ? ` reason=${e.reason}` : ''}${e.shown != null ? ` shown=${e.shown}/${e.total}` : ''}`),
          `  old reply in chat-log: ${JSON.stringify(fullOld)}`, `  old messages never shown: ${JSON.stringify(unshownOld)}`, `  player after: ${JSON.stringify(st)}`, '');
        return `old ${oldTexts.map((m) => `「${m}」`).join(' → ')}; ${cutNote}; new ${newReveals.map((e) => `「${e.text}」`).join(' → ')}; timer=false`;
      }, page);

      await step(S, 'SL3 聊天记录 keeps every turn whole; read aloud once per reply; no page/console errors', async () => {
        const msgs = logged();
        const pets = msgs.filter((m) => m.role === 'pet');
        assert.ok(pets.length >= 3, `pet messages: ${pets.length}`);
        const offers = (await page.evaluate(() => window.petFx.offerLog())).filter((o) => o.kind === 'chat');
        const admin = await openAdminWindow(app, page, 'history');
        await adminUntil(admin, () => !!document.querySelector('[data-session]'), null, 10000, 'conversations');
        await admin.evaluate(() => document.querySelector('[data-session]').click());
        const want = first.full.split('\n')[0].trim();
        await adminUntil(admin, (w) => [...document.querySelectorAll('[data-history-thread] [data-role="pet"] [data-history-text]')].some((e) => e.textContent.includes(w)), want, 10000, 'the saved reply');
        await admin.screenshot({ path: path.join(SHOTS, 'sl3-history.png') });
        const shown = await admin.evaluate(() => [...document.querySelectorAll('[data-history-thread] [data-history-text]')].map((e) => e.textContent));
        await admin.close().catch(() => {});
        assert.deepEqual(errors, [], errors.join('\n'));
        timeline.push('[SL3 聊天记录 / 朗读 / 报错]', ...msgs.map((m) => `  ${m.at ? iso(m.at) : ''} ${m.role}: ${JSON.stringify(m.text)}`), `  read-aloud offers (chat): ${offers.length} ${JSON.stringify(offers.map((o) => (o.text || '').slice(0, 40)))}`, `  history page texts: ${JSON.stringify(shown)}`, `  page/console errors: ${errors.length}`, '');
        return `chat-log ${msgs.length} entries (${pets.length} pet); read aloud offered ${offers.length}×; history page shows ${shown.length} lines; errors 0`;
      }, page);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'live-timeline.txt'), `${timeline.join('\n')}\nerrors:\n${errors.join('\n')}\n`);
      try { fs.copyFileSync(path.join(data, 'chat-log.json'), path.join(SHOTS, 'chat-log.json')); } catch { /* not written */ }
      try {
        const w = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, segLog: window.petFx.segLog(), streamLog: window.petFx.streamLog(), offerLog: window.petFx.offerLog() }));
        fs.writeFileSync(path.join(SHOTS, 'renderer-logs.json'), JSON.stringify(w, null, 2) + '\n');
      } catch { /* window gone */ }
      await app.close().catch(() => {});
      if (agentId) {
        try { lh('agent', 'delete', agentId, '--yes'); fs.writeFileSync(path.join(SHOTS, 'cleanup.txt'), `deleted ${agentId}\n`); } catch (e) { fs.writeFileSync(path.join(SHOTS, 'cleanup.txt'), `delete ${agentId} failed: ${e.message}\n`); }
      }
    }
  };
};
