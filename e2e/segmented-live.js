'use strict';

// 分段式表达 with the REAL agent (run.js `segmentedlive`, tokens; not in "all"). Real `lh`, a real LobeHub agent in
// the personal space (deleted at the end, also on failure). About 12–18 model calls: her hatch greeting, a conversation
// of 8 turns, up to 6 messages from an owner back after days away, and a message sent while a reply is coming out.
//   SL1  a natural conversation: every message gets a reply on topic. The shape is hers: some replies are one message,
//        some several (one by one, in order, with typing gaps), and not most of them open with an emoji
//   SL1b the owner is back after days away (the Goal's example): a reply of ≥ 4 messages with an emoji on its own.
//        Every turn's shape in shapes.json; screenshots per message count
//   SL2  a second message while a reply is still coming out: the rest of the old reply stops, the new reply plays
//        from its first message, nothing of the old one shows up later
//   SL3  聊天记录 (设置 → 聊天记录) has both turns whole; read aloud offered once per reply; no page / console errors
// Evidence in out/e2e/segmented-live/: screenshots, video/, live-timeline.txt, renderer-logs.json, chat-log.json.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Seg = require('../src/core/segments');

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
    // the real lh, with a note of the [节奏] each turn was given next to the shape she chose (rhythm.log)
    const rhythmLog = path.join(SHOTS, 'rhythm.log');
    const lhShim = path.join(data, 'lh-rhythm.js');
    fs.rmSync(rhythmLog, { force: true });
    fs.writeFileSync(lhShim, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const a = process.argv.slice(2);
for (const x of a) { const m = /\\[节奏\\] 这次[^\\n]*/.exec(x); if (m) require('node:fs').appendFileSync(${JSON.stringify(rhythmLog)}, new Date().toISOString() + ' ' + (/距上次互动\\d+分钟/.exec(x) || [''])[0] + ' ' + m[0] + ' 主人: ' + x.split('\\n').pop() + '\\n'); }
process.exit(spawnSync('lh', a, { stdio: 'inherit' }).status ?? 1);
`, { mode: 0o755 });
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: lhShim, PIXELPET_NO_CONNECT: '1' };
    fs.rmSync(path.join(SHOTS, 'video'), { recursive: true, force: true });
    fs.writeFileSync(path.join(SHOTS, 'launched-at.txt'), `${Date.now()}\n`);
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
    const turns = [];
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
        fs.writeFileSync(path.join(SHOTS, 'agent-role-excerpt.txt'), role.split('\n').filter((l) => /核心是自然|发几条|每条单独一行|表情看心情|调皮|下午三点|在吗/.test(l)).join('\n') + '\n');
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
      // one turn: send, follow it on screen, return what she did
      const runTurn = async (n, text) => {
        const before = logged().length;
        await startSampler();
        const tSend = await sendText(text);
        const seen = new Set();
        const deadline = Date.now() + 150000;
        let petText = null;
        while (Date.now() < deadline) {
          const k = (await segs()).length;
          for (let c = 1; c <= Math.min(k, 6); c++) if (!seen.has(c)) { seen.add(c); await shot(`sl1-t${n}-${c}-msgs`); }
          const added = logged().slice(before);
          const pet = added.filter((m) => m.role === 'pet').pop();
          const busy = await page.evaluate(() => document.body.classList.contains('busy'));
          if (pet && !busy) {
            const want = Seg.split(pet.text).length;
            const done = (await segLogWall()).some((e) => e.wall >= tSend && e.ev === 'done');
            if (want < 2 || done) { petText = pet.text; break; }
          }
          await page.waitForTimeout(40);
        }
        assert.ok(petText !== null, `no reply to 「${text}」`);
        await page.waitForTimeout(300);
        await shot(`sl1-t${n}-final`);
        // one bubble: the ordinary card, one message in it
        const look = await page.evaluate(() => { const b = document.getElementById('bubble'); const c = getComputedStyle(b); return { n: b.querySelectorAll('.seg').length, shadow: c.boxShadow }; });
        assert.ok(look.n <= 1 && look.shadow !== 'none', `turn ${n}: not one bubble: ${JSON.stringify(look)}`);
        const samples = await stopSampler();
        const log = (await segLogWall()).filter((e) => e.wall >= tSend);
        const start = log.find((e) => e.ev === 'start');
        const reveals = start ? log.filter((e) => e.id === start.id && e.ev === 'reveal') : [];
        const msgs = reveals.length ? reveals.map((e) => e.text) : [petText];
        const gaps = reveals.slice(1).map((e, i) => e.wall - reveals[i].wall);
        const seq = samples.map((x) => x.segs[0]).filter((x, i, a) => x && x !== a[i - 1]);
        if (msgs.length >= 2) {
          assert.deepEqual(reveals.map((e) => e.i), msgs.map((_, i) => i), `turn ${n}: reveals out of order`);
          assert.ok(samples.every((x) => x.segs.length <= 1), `turn ${n}: more than one message on screen`);
          assert.deepEqual(seq, msgs, `turn ${n}: on screen went ${JSON.stringify(seq)}`);
          assert.ok(gaps.every((g, i) => g >= Seg.readMs(msgs[i]) - 60 && g <= 6000), `turn ${n}: gaps ${gaps}`);
        } else {
          assert.equal(samples.some((x) => x.segs.length > 0), false, `turn ${n}: one message but a segmented bubble`);
        }
        timeline.push(`[SL1 第 ${n} 轮] 主人 ${iso(tSend)}: 「${text}」`, ...log.filter((e) => start && e.id === start.id).map((e) => `  ${iso(e.wall)}  ${e.ev}${e.i == null ? '' : `#${e.i}`}${e.text ? ` 「${e.text}」` : ''}`), ...(start ? [] : [`  (一条，普通气泡) 「${petText}」`]), `  ${msgs.length} 条; 间隔 ${gaps.join('/') || '-'} ms; 屏上条数 ${seq.join('→') || '-'}`, '');
        return { n, text, tSend, msgs, gaps, firstIsEmoji: Seg.isEmojiOnly(msgs[0]), hasEmojiMsg: msgs.some((m) => Seg.isEmojiOnly(m)), reveals, full: petText };
      };
      // nothing here asks for a format: everyday things an owner says, for her to answer as she likes
      const NATURAL = ['现在几点了？', '今天上班好累啊', '哈哈你真逗', '2+3 等于几', '我晚饭吃了碗牛肉面', '嗨～我刚下班回来，你今天有没有想我呀？', '好，那我去洗澡了', '我回来啦'];
      // the owner comes back after days away (the example of the Goal): a burst is likely then
      const MISSED = ['嗨', '好几天没理你了，你还好吗？', '在吗？', '我回来了', '好久不见呀', '想我了吗？'];
      await step(S, 'SL1 a natural conversation: replies on topic, and their shape varies from turn to turn', async () => {
        for (const text of NATURAL) { turns.push(await runTurn(turns.length + 1, text)); await page.waitForTimeout(1500); }
        const lens = turns.map((t) => t.msgs.length);
        assert.ok(lens.some((c) => c === 1), `every reply was split: ${lens}`);
        assert.ok(lens.some((c) => c >= 2), `no reply had several messages: ${lens}`);
        assert.ok(turns.filter((t) => t.firstIsEmoji).length <= turns.length / 2, `too many open with an emoji: ${turns.filter((t) => t.firstIsEmoji).length}/${turns.length}`);
        timeline.push(`[SL1 汇总] ${turns.length} 轮，每轮条数 ${lens.join(',')}；以表情开头 ${turns.filter((t) => t.firstIsEmoji).length} 轮`, '');
        return turns.map((t) => `${t.n}「${t.text}」→ ${t.msgs.map((m) => `「${m}」`).join(' ')}`).join('; ');
      }, page);

      await step(S, 'SL1b the owner is back after days away: at least one reply is ≥4 messages with an emoji on its own', async () => {
        const back = [];
        for (const text of MISSED) {
          await page.evaluate((at) => window.pet.debugSet({ lastInteractionAt: at }), Date.now() - 3 * 86400000);
          const t = await runTurn(turns.length + 1, text);
          turns.push(t);
          back.push(t);
          await page.waitForTimeout(1500);
          if (t.msgs.length >= 4 && t.hasEmojiMsg) { first = t; break; }
        }
        assert.ok(first, `no reply of ≥4 messages with an emoji in ${back.length} tries: ${back.map((t) => t.msgs.length)}`);
        const gaps = first.gaps.join('/');
        timeline.push(`[SL1b 汇总] 第 ${first.n} 轮达到 ${first.msgs.length} 条，试了 ${back.length} 次，间隔 ${gaps} ms`, '');
        return `tries ${back.length}; 「${first.text}」→ ${first.msgs.map((m) => `「${m}」`).join(' → ')}; gaps ${gaps} ms`;
      }, page);

      await step(S, 'SL2 a new message while a reply is still coming out: old one stops, new one plays, nothing left over', async () => {
        await startSampler();
        // a burst is likely after a long absence; a one-message reply has nothing to cut into, so she is asked again
        let tSend = 0;
        for (let tries = 0, playing = false; !playing; tries++) {
          assert.ok(tries < 5, 'five replies in a row had nothing left to cut into');
          await page.evaluate((at) => window.pet.debugSet({ lastInteractionAt: at }), Date.now() - 3 * 86400000);
          tSend = await sendText('跟我说说你今天都做了些什么，一件一件讲给我听嘛');
          // wait for her reply to start playing, then cut in after the first or second message
          playing = await page.waitForFunction(() => {
            const s = window.petFx.segState();
            return !!(s && !s.done && s.total >= 3 && s.shown >= 2 && !document.body.classList.contains('busy'));
          }, null, { timeout: 45000 }).then(() => true).catch(() => false);
          if (!playing) { await idle(); await page.waitForFunction(() => { const s = window.petFx.segState(); return !s || s.done; }, null, { timeout: 30000 }); await page.waitForTimeout(800); }
        }
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
        // her new reply may well be one message (a plain bubble, no playback of its own)
        const newStart = starts.find((e) => e.wall > tCut) || null;
        const newReveals = newStart ? log.filter((e) => e.id === newStart.id && e.ev === 'reveal') : [];
        const newReply = logged().filter((m) => m.role === 'pet').pop().text;
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
          assert.ok(done && (!newStart || done.wall <= newStart.wall), 'neither canceled nor finished before the new reply');
          cutNote = 'old reply had already finished';
        }
        assert.deepEqual(newReveals.map((e) => e.i), newReveals.map((_, i) => i), 'new reply out of order');
        const oldTexts = oldReveals.map((e) => e.text);
        const fullOld = logged().filter((m) => m.role === 'pet').slice(-2)[0].text;
        const unshownOld = fullOld.split('\n').map((x) => x.trim()).filter((x) => x && !oldTexts.includes(x) && !newReveals.some((r) => r.text === x));
        const after = samples.filter((s) => s.wall > (newStart ? newStart.wall : tCut + 300));
        assert.ok(after.every((s) => !s.segs.some((x) => unshownOld.includes(x))), 'an unshown old message appeared after the new reply started');
        if (newStart) assert.ok(after.every((s) => s.segs.length <= 1), 'more than one message on screen');
        else assert.equal(await page.evaluate(() => document.getElementById('bubble').textContent.trim().replace(/\s*▍$/, '')), newReply, 'the new one-message reply is not what the bubble shows');
        const st = await page.evaluate(() => window.petFx.segState());
        assert.ok(!st || st.timer === false, 'a timer was left behind'); // null: a one-message reply cleared the player
        timeline.push('[SL2 回复途中再发一条]', `  user sent 「跟我说说你今天都做了些什么，一件一件讲给我听嘛」 at ${iso(tSend)}`, `  user cut in 「等等等等，先告诉我你现在心情怎么样？」 at ${iso(tCut)}`,
          ...log.map((e) => `  ${iso(e.wall)}  [${e.id === oldId ? 'old' : newStart && e.id === newStart.id ? 'new' : e.id}] ${e.ev}${e.i == null ? '' : `#${e.i}`}${e.text ? ` 「${e.text}」` : ''}${e.reason ? ` reason=${e.reason}` : ''}${e.shown != null ? ` shown=${e.shown}/${e.total}` : ''}`),
          `  old reply in chat-log: ${JSON.stringify(fullOld)}`, `  old messages never shown: ${JSON.stringify(unshownOld)}`, `  player after: ${JSON.stringify(st)}`, '');
        return `old ${oldTexts.map((m) => `「${m}」`).join(' → ')}; ${cutNote}; new ${newReveals.map((e) => `「${e.text}」`).join(' → ') || `one message 「${newReply}」`}; no timer left`;
      }, page);

      await step(S, 'SL3 聊天记录 keeps every turn whole; read aloud once per reply; no page/console errors', async () => {
        const msgs = logged();
        const pets = msgs.filter((m) => m.role === 'pet');
        assert.ok(pets.length >= 3, `pet messages: ${pets.length}`);
        const offers = (await page.evaluate(() => window.petFx.offerLog())).filter((o) => o.kind === 'chat');
        const admin = await openAdminWindow(app, page, 'history');
        await adminUntil(admin, () => !!document.querySelector('[data-session]'), null, 10000, 'conversations');
        await admin.evaluate(() => document.querySelector('[data-session]').click());
        const want = (first || turns[turns.length - 1]).full.split('\n')[0].trim();
        await adminUntil(admin, (w) => [...document.querySelectorAll('[data-history-thread] [data-role="pet"] [data-history-text]')].some((e) => e.textContent.includes(w)), want, 10000, 'the saved reply');
        // like WeChat: the burst is one bubble per message in 聊天记录 and on the 聊天 page too, not lines in one
        if (first) {
          const hist = await admin.evaluate(() => document.querySelectorAll('[data-history-thread] [data-role="pet"][data-seg-index]').length);
          assert.ok(hist >= first.msgs.length, `聊天记录 shows ${hist} separate messages`);
        }
        await admin.evaluate((w) => { [...document.querySelectorAll('[data-history-thread] [data-history-text]')].find((e) => e.textContent.includes(w))?.scrollIntoView({ block: 'start' }); }, want);
        await admin.waitForTimeout(300);
        await admin.screenshot({ path: path.join(SHOTS, 'sl3-history.png') });
        const shown = await admin.evaluate(() => [...document.querySelectorAll('[data-history-thread] [data-history-text]')].map((e) => e.textContent));
        await admin.evaluate(() => { location.hash = '#/chat'; });
        await adminUntil(admin, () => document.querySelectorAll('[data-chat-page] [data-role="assistant"][data-seg-index]').length >= 2, null, 15000, 'separate bubbles on the 聊天 page');
        const lastOfFirst = (first || turns[turns.length - 1]).msgs.at(-1);
        await admin.evaluate((w) => { [...document.querySelectorAll('[data-chat-page] [data-role="assistant"]')].find((e) => e.innerText.includes(w))?.scrollIntoView({ block: 'center' }); }, lastOfFirst);
        await admin.waitForTimeout(400);
        await admin.screenshot({ path: path.join(SHOTS, 'sl3-chat-page.png') });
        await admin.close().catch(() => {});
        assert.deepEqual(errors, [], errors.join('\n'));
        timeline.push('[SL3 聊天记录 / 朗读 / 报错]', ...msgs.map((m) => `  ${m.at ? iso(m.at) : ''} ${m.role}: ${JSON.stringify(m.text)}`), `  read-aloud offers (chat): ${offers.length} ${JSON.stringify(offers.map((o) => (o.text || '').slice(0, 40)))}`, `  history page texts: ${JSON.stringify(shown)}`, `  page/console errors: ${errors.length}`, '');
        return `chat-log ${msgs.length} entries (${pets.length} pet); read aloud offered ${offers.length}×; history page shows ${shown.length} lines; errors 0`;
      }, page);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'shapes.json'), JSON.stringify(turns.map(({ n, text, tSend, msgs, gaps, firstIsEmoji }) => ({ n, text, sentAt: new Date(tSend).toISOString(), count: msgs.length, firstIsEmoji, msgs, gaps })), null, 2) + '\n');
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
