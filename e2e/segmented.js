'use strict';

// 分段式表达 e2e (run.js `segmented`, docs/segmented-reply.md), no tokens: the fake lh answers with fixed replies
// ($FAKE_LH_DIR/stream-reply.json). A sampler in the pet window records the bubble every 30 ms (which messages are
// on screen, whether 「正在输入」 shows), so each step can show the messages came one by one, in order, with gaps.
//   SG1  a reply of 4 messages that arrives all at once (today's lh): 🥺 → 在吗？ → 有点想你了。 → 在干什么呀？,
//        one at a time with typing dots between; 聊天记录 keeps the whole reply once; read aloud once; her agent's
//        system role asks for it (playful, one message per line)
//   SG2  a reply that really streams (pieces 600 ms apart): the first line shows while she is still writing, a later
//        line is 「正在输入」 until it ends, the order holds
//   SG3  the owner sends a new message while one is still coming out: the rest stops, no timer is left (nothing of
//        the old reply shows up later), the new reply plays from its first message
//   SG4  a one-sentence reply is not split: streamed with the caret, one plain bubble (original behaviour)
//   SG5  分段式表达 off (set-prefs): the same multi-line reply shows at once as one bubble
//   SG6  the settings window shows the switch, the cap and the pace (设置 → 桌宠行为 → 聊天)
// Screenshots, video, seg-timeline.txt (timestamps), renderer-logs.json and chat-log.json in out/e2e/segmented/.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

module.exports = function segmentedScenario(ctx) {
  const { ROOT, OUT, FAKE_LH, step, launch, openAdminWindow, adminUntil, hover, clickAct } = ctx;
  return async function segmented() {
    const S = 'segmented';
    const SHOTS = path.join(OUT, S);
    fs.mkdirSync(SHOTS, { recursive: true });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-seg-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-segfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    // 朗读 on (system voice): the whole reply must be offered to the voice once
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true, voiceInteractions: false } }));
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
    const { app, page } = await launch(env, { video: path.join(SHOTS, 'video') });
    const evidence = [];
    const note = (s) => { evidence.push(s); return s.length > 300 ? `${s.slice(0, 297)}…` : s; };
    const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
    const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const logged = () => JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8')).messages;
    const reply = (r) => fs.writeFileSync(path.join(fakeDir, 'stream-reply.json'), JSON.stringify(r));
    const startSampler = () => page.evaluate(() => {
      clearInterval(window.__sampler);
      window.__samples = [];
      const t0 = performance.now();
      window.__t0 = t0;
      window.__sampler = setInterval(() => {
        const b = document.getElementById('bubble');
        const hidden = b.classList.contains('hidden');
        window.__samples.push({
          t: Math.round(performance.now() - t0),
          segs: hidden ? [] : [...b.querySelectorAll('.seg')].map((e) => e.textContent),
          live: !!b.querySelector('.seg.live'),
          typing: !hidden && !!b.querySelector('.seg-typing'),
          segmented: b.classList.contains('segmented'),
          text: hidden ? '' : b.textContent,
          streaming: b.classList.contains('streaming'),
          busy: document.body.classList.contains('busy'),
        });
      }, 30);
    });
    // from the moment she starts on the new message (busy): before that the bubble may still show the last reply
    const stopSampler = async () => {
      const all = await page.evaluate(() => { clearInterval(window.__sampler); return window.__samples; });
      const i = all.findIndex((x) => x.busy);
      return i < 0 ? all : all.slice(i);
    };
    const segLogSince = (t) => page.evaluate((x) => window.petFx.segLog().filter((e) => e.at >= x), t);
    const nowMs = () => page.evaluate(() => Math.round(performance.now()));
    const sendText = async (text) => {
      await hover(page);
      if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
      await page.fill('#chat-input', text);
      await page.click('#chat-send');
    };
    // when each count of messages was first on screen, from the samples
    const firstAt = (samples, n) => (samples.find((s) => s.segs.length >= n) || {}).t;
    const timeline = [];
    const tl = (label, samples, msgs) => {
      const rows = msgs.map((m, i) => `  #${i + 1} +${firstAt(samples, i + 1)}ms 「${m}」`);
      timeline.push(`[${label}]`, ...rows, '');
      return rows.map((r) => r.trim()).join(' · ');
    };
    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await idle();
      await page.waitForTimeout(500);

      const MSGS = ['🥺', '在吗？', '有点想你了。', '在干什么呀？'];
      const FULL = MSGS.join('\n');
      await step(S, 'SG1 one reply becomes 4 messages that appear one by one, in order, with typing gaps', async () => {
        reply({ pieces: [`${MSGS[0]}\n`, `${MSGS[1]}\n`, `${MSGS[2]}\n`, MSGS[3]], gapMs: 0 }); // all at once, like lh today
        const before = logged().length;
        const t0 = await nowMs();
        await startSampler();
        await sendText('嗨');
        for (let n = 1; n <= 4; n++) {
          await page.waitForFunction((k) => document.querySelectorAll('#bubble .seg').length >= k, n, { timeout: 15000 });
          await shot(`sg1-${n}-of-4`);
          if (n < 4) {
            await page.waitForFunction((k) => document.querySelectorAll('#bubble .seg').length >= k + 1 || !!document.querySelector('#bubble .seg-typing'), n, { timeout: 5000 });
            if (await page.evaluate(() => !!document.querySelector('#bubble .seg-typing'))) await shot(`sg1-${n}-typing`);
          }
        }
        await page.waitForTimeout(400);
        const samples = await stopSampler();
        // never all at once: the counts only grow, one at a time
        const counts = samples.map((s) => s.segs.length).filter((c, i, a) => i === 0 || c !== a[i - 1]);
        const shown = counts.filter((c) => c > 0);
        assert.deepEqual(shown, [1, 2, 3, 4], `message counts went ${JSON.stringify(counts)}`);
        // in order, and what is shown is always the first n messages
        for (const s of samples) assert.deepEqual(s.segs, MSGS.slice(0, s.segs.length));
        const at = [1, 2, 3, 4].map((n) => firstAt(samples, n));
        for (let i = 1; i < 4; i++) assert.ok(at[i] - at[i - 1] >= 300, `message ${i + 1} came ${at[i] - at[i - 1]} ms after the one before`);
        // 「正在输入」 between them
        assert.ok([1, 2, 3].every((n) => samples.some((s) => s.segs.length === n && s.typing)), 'no typing dots between messages');
        // the player's log: reveals 0..3 in order with typing before 1..3
        const sl = (await segLogSince(t0)).filter((e) => e.ev === 'reveal' || e.ev === 'typing' || e.ev === 'done');
        assert.deepEqual(sl.filter((e) => e.ev === 'reveal').map((e) => e.text), MSGS);
        assert.deepEqual(sl.filter((e) => e.ev === 'typing').map((e) => e.i), [1, 2, 3]);
        assert.equal(sl.filter((e) => e.ev === 'done').length, 1);
        assert.equal(await page.evaluate(() => document.getElementById('bubble').classList.contains('segmented')), true);
        // 聊天记录: the whole reply once (one message per line)
        const added = logged().slice(before);
        assert.deepEqual(added.map((m) => [m.role, m.text]), [['user', '嗨'], ['pet', FULL]]);
        // reading aloud: offered once, with the whole reply
        const offers = (await page.evaluate(() => window.petFx.offerLog())).filter((o) => o.kind === 'chat');
        assert.equal(offers.length, 1);
        // her agent was told to talk this way (agent create / edit carries the system role)
        const calls = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        const role = calls.map((c) => c.args).filter((a) => a[0] === 'agent' && (a[1] === 'create' || a[1] === 'edit') && a.includes('-s')).map((a) => a[a.indexOf('-s') + 1]).pop() || '';
        assert.match(role, /每条单独一行/);
        assert.match(role, /调皮/);
        const gaps = at.slice(1).map((x, i) => x - at[i]);
        const line = tl('SG1 一次到达的 4 条（lh 今天的行为）', samples, MSGS);
        const log = sl.map((e) => `${e.ev}${e.i == null ? '' : `#${e.i}`}@${e.at - t0}ms`).join(' ');
        timeline.push(`  segLog: ${log}`, `  gaps: ${gaps.join(' / ')} ms`, '');
        return note(`${line}; gaps ${gaps.join('/')} ms; typing dots between each; chat-log +2 (pet = whole reply, 4 lines); TTS offered once; system role has the 分段 rule`);
      }, page);

      await step(S, 'SG2 a reply that really streams: the first line shows while she writes, later ones wait as 「正在输入」', async () => {
        const M = ['😝', '在吗？', '想你啦', '今天过得怎么样？'];
        reply({ pieces: ['😝\n', '在吗', '？\n', '想你', '啦\n', '今天过得', '怎么样？'], gapMs: 600 });
        await startSampler();
        await sendText('在呢');
        await page.waitForFunction(() => document.querySelectorAll('#bubble .seg').length >= 2 && document.body.classList.contains('busy'), null, { timeout: 15000 });
        await shot('sg2-streaming');
        await idle();
        await page.waitForFunction((n) => document.querySelectorAll('#bubble .seg').length >= n, M.length, { timeout: 15000 });
        await page.waitForTimeout(300);
        const samples = await stopSampler();
        for (const s of samples) assert.deepEqual(s.segs, M.slice(0, s.segs.length).map((m, i) => (i === s.segs.length - 1 && s.live ? s.segs[i] : m)));
        const busyWithTwo = samples.filter((s) => s.busy && s.segs.length >= 2);
        assert.ok(busyWithTwo.length > 0, 'nothing was on screen before the stream ended');
        assert.ok(samples.some((s) => s.busy && s.typing), 'no 「正在输入」 while she was writing');
        const counts = samples.map((s) => s.segs.length).filter((c, i, a) => (i === 0 || c !== a[i - 1]) && c > 0);
        assert.deepEqual(counts, [1, 2, 3, 4]);
        const doneAt = (samples.find((s, i) => i > 0 && !s.busy && samples[i - 1].busy) || {}).t;
        return note(`${tl('SG2 真正流式（每块 600 ms）', samples, M)}; stream ended at +${doneAt}ms`);
      }, page);

      await step(S, 'SG3 a new message while a reply is still coming out stops it; no timer is left; the new reply plays', async () => {
        const OLD = ['好呀', '那我先说第一件事', '然后是第二件事', '第三件事是', '最后一件事', '说完啦'];
        reply({ pieces: [OLD.join('\n')], gapMs: 0 });
        const t0 = await nowMs();
        await startSampler();
        await sendText('说说你今天的事');
        await page.waitForFunction(() => document.querySelectorAll('#bubble .seg').length >= 2, null, { timeout: 15000 });
        await idle();
        await shot('sg3-before-new-message');
        const NEW = ['嗯？', '你说～'];
        reply({ pieces: [NEW.join('\n')], gapMs: 0 });
        const tCut = await nowMs();
        await sendText('等等');
        await page.waitForFunction((m) => [...document.querySelectorAll('#bubble .seg')].map((e) => e.textContent).join('|') === m.join('|'), NEW, { timeout: 15000 });
        await idle();
        await page.waitForTimeout(6000); // the rest of the old reply would have come by now
        await shot('sg3-after');
        const samples = await stopSampler();
        const log = await segLogSince(t0);
        const cancel = log.find((e) => e.ev === 'cancel');
        assert.ok(cancel, 'no cancel');
        assert.equal(cancel.reason, 'new-message');
        assert.ok(cancel.shown >= 2 && cancel.shown < OLD.length, JSON.stringify(cancel));
        const oldId = cancel.id;
        assert.equal(log.filter((e) => e.id === oldId && e.ev === 'reveal' && e.at > cancel.at).length, 0, 'the old reply kept coming after the cancel');
        assert.equal(log.filter((e) => e.id === oldId && e.ev === 'done').length, 0);
        const newId = log.filter((e) => e.ev === 'start' && e.at > cancel.at).map((e) => e.id).pop();
        assert.deepEqual(log.filter((e) => e.id === newId && e.ev === 'reveal').map((e) => e.text), NEW);
        assert.ok(samples.filter((s) => s.t > tCut - t0 + 1000).every((s) => !s.segs.some((x) => OLD.slice(cancel.shown).includes(x))), 'an old message showed after the new one');
        const st = await page.evaluate(() => window.petFx.segState());
        assert.equal(st.done, true);
        assert.equal(st.timer, false);
        // 聊天记录 still has her whole first reply
        const pets = logged().filter((m) => m.role === 'pet').slice(-2).map((m) => m.text);
        assert.deepEqual(pets, [OLD.join('\n'), NEW.join('\n')]);
        return note(`old reply ${oldId}: ${cancel.shown}/${cancel.total} shown, then cancel(new-message), 0 reveals after it in 6 s; new reply ${NEW.map((m) => `「${m}」`).join(' → ')}; player timer=false; chat-log keeps both whole`);
      }, page);

      await step(S, 'SG4 a one-sentence reply is not split: it streams with the caret into one plain bubble', async () => {
        const PIECES = ['好呀，', '今天的天气', '早上有点凉。', '中午出太阳了，', '可以出去走走晒晒太阳。', '晚上记得加件外套哦～'];
        const ONE = PIECES.join('');
        reply({ pieces: PIECES, gapMs: 400 });
        await startSampler();
        await sendText('今天天气怎么样');
        await idle();
        await page.waitForTimeout(200);
        await shot('sg4-single');
        const samples = await stopSampler();
        assert.ok(samples.every((s) => s.segs.length === 0 && !s.segmented), 'a one-line reply was split');
        const partial = [...new Set(samples.filter((s) => s.streaming).map((s) => s.text))];
        assert.ok(partial.length >= 3, `partial texts: ${JSON.stringify(partial)}`);
        for (const t of partial) assert.ok(ONE.startsWith(t));
        assert.equal(samples[samples.length - 1].text, ONE);
        return note(`streamed ${partial.map((t) => `「${t}」`).join(' → ')} → 「${ONE}」, no .seg, bubble not segmented`);
      }, page);

      await step(S, 'SG4b the shape is hers: an emoji in a line stays in it; alone on a line it is a message wherever she put it', async () => {
        reply({ pieces: ['🥺 在吗？'], gapMs: 0 });
        await startSampler();
        await sendText('嗨');
        await idle();
        await page.waitForTimeout(200);
        await shot('sg4b-emoji-in-line');
        const one = await stopSampler();
        assert.ok(one.every((s) => s.segs.length === 0), 'a one-line reply with an emoji was split');
        assert.equal(one[one.length - 1].text, '🥺 在吗？');
        const MID = ['哈哈哈', '🤭', '被你发现了'];
        reply({ pieces: [MID.join('\n')], gapMs: 0 });
        await sendText('你是不是偷吃了');
        await page.waitForFunction((n) => document.querySelectorAll('#bubble .seg').length === n, MID.length, { timeout: 15000 });
        await shot('sg4b-emoji-in-the-middle');
        const shown = await page.evaluate(() => [...document.querySelectorAll('#bubble .seg')].map((e) => [e.textContent, e.classList.contains('emoji')]));
        assert.deepEqual(shown, [['哈哈哈', false], ['🤭', true], ['被你发现了', false]]);
        return note(`「🥺 在吗？」 stays one bubble; ${JSON.stringify(shown)}`);
      }, page);

      await step(S, 'SG4c she knows how long the owner was away: the prompt has the absence from before this message, and a [节奏] line', async () => {
        await page.evaluate((at) => window.pet.debugSet({ lastInteractionAt: at }), Date.now() - 3 * 86400000);
        const mark = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').length;
        reply({ pieces: ['你回来啦'], gapMs: 0 });
        await sendText('嗨');
        await idle();
        const text = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').slice(mark);
        const away = /距上次互动(\d+)分钟/.exec(text);
        assert.ok(away, 'no absence in the prompt');
        assert.ok(Number(away[1]) >= 4319, `absence in the prompt: ${away[1]} min`);
        assert.ok(/\[节奏\] 这次/.test(text), 'no [节奏] line in the prompt');
        return note(`${away[0]}; ${/\[节奏\][^\\"]*/.exec(text)[0]}`);
      }, page);

      await step(S, 'SG5 分段式表达 off: the same multi-line reply shows at once as one bubble', async () => {
        await page.evaluate(() => window.pet.setPrefs({ segmented: false }));
        reply({ pieces: [FULL], gapMs: 0 });
        await startSampler();
        await sendText('嗨嗨');
        await idle();
        await page.waitForTimeout(300);
        await shot('sg5-off-one-bubble');
        const samples = await stopSampler();
        assert.ok(samples.every((s) => s.segs.length === 0), 'split while off');
        const first = samples.find((s) => s.text && !s.text.startsWith('思考中'));
        assert.equal(first.text, FULL, 'not the whole reply at once');
        const calls = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).args);
        const edit = calls.filter((a) => a[0] === 'agent' && a[1] === 'edit' && a.includes('-s')).pop();
        assert.ok(edit && !edit[edit.indexOf('-s') + 1].includes('每条单独一行'), 'her role still asks for short messages');
        await page.evaluate(() => window.pet.setPrefs({ segmented: true }));
        return note(`off: 「${first.text.replace(/\n/g, '⏎')}」 at once in one bubble; agent role updated without the rule; switched back on`);
      }, page);

      await step(S, 'SG6 设置 → 桌宠行为 → 聊天: the switch (on), the cap and the pace', async () => {
        execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
        const admin = await openAdminWindow(app, page, 'behavior');
        await adminUntil(admin, () => document.body.textContent.includes('自己走动'), null, 15000, 'the 桌宠行为 page').catch(async (e) => { await admin.screenshot({ path: path.join(SHOTS, 'sg6-debug.png') }); throw e; });
        const has = await admin.evaluate(() => ['分段式表达', '一次最多几条', '打字速度'].filter((t) => document.body.textContent.includes(t)));
        assert.deepEqual(has, ['分段式表达', '一次最多几条', '打字速度'], `page text: ${(await admin.evaluate(() => document.body.textContent)).slice(0, 400)}`);
        await admin.evaluate(() => { const el = [...document.querySelectorAll('[data-admin-page] *')].find((e) => e.children.length === 0 && e.textContent.trim() === '分段式表达'); if (el) el.scrollIntoView({ block: 'center' }); });
        await admin.waitForTimeout(400);
        await admin.screenshot({ path: path.join(SHOTS, 'sg6-settings.png') });
        const txt = await admin.evaluate(() => document.body.textContent);
        assert.ok(txt.includes('一次最多几条'));
        const st = await page.evaluate(() => window.pet.getSettings ? window.pet.getSettings() : null).catch(() => null);
        await admin.close().catch(() => {});
        return note(`settings window shows 分段式表达 / 一次最多几条 / 打字速度${st && st.prefs ? ` (prefs.segmented=${st.prefs.segmented}, segmentMax=${st.prefs.segmentMax}, segmentCharMs=${st.prefs.segmentCharMs})` : ''}`);
      }, page);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'seg-timeline.txt'), `${timeline.join('\n')}\n${evidence.join('\n\n')}\n`);
      try { fs.copyFileSync(path.join(data, 'chat-log.json'), path.join(SHOTS, 'chat-log.json')); } catch { /* not written */ }
      try {
        const w = await page.evaluate(() => ({ segLog: window.petFx.segLog(), streamLog: window.petFx.streamLog(), offerLog: window.petFx.offerLog() }));
        fs.writeFileSync(path.join(SHOTS, 'renderer-logs.json'), JSON.stringify(w, null, 2) + '\n');
      } catch { /* window gone */ }
      await app.close().catch(() => {});
    }
  };
};
