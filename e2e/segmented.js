'use strict';

// 分段式表达 e2e (run.js `segmented`, docs/segmented-reply.md), no tokens: the fake lh answers with fixed replies
// ($FAKE_LH_DIR/stream-reply.json). A sampler in the pet window records the bubble every 30 ms (which messages are
// on screen, whether 「正在输入」 shows), so each step can show the messages came one by one, in order, with gaps.
//   SG1  a reply of 4 messages that arrives all at once (today's lh): 🥺 → 在吗？ → 有点想你了。 → 在干什么呀？,
//        one at a time, each replacing the last, typing dots while the next comes, each on screen long enough to
//        read; 聊天记录 keeps the whole reply once; read aloud once; her agent's system role asks for it
//   SG1b one bubble, not several: the ordinary card with its tail, never more than one message in it, she does not move
//   SG2  a reply that really streams (pieces 600 ms apart): the first line shows while she is still writing, a later
//        line is 「正在输入」 until it ends, the order holds
//   SG3  the owner sends a new message while one is still coming out: the rest stops, no timer is left (nothing of
//        the old reply shows up later), the new reply plays from its first message
//   SG4  a one-sentence reply is not split: streamed with the caret, one plain bubble (original behaviour)
//   SG5  分段式表达 off (set-prefs): the same multi-line reply shows at once as one bubble
//   SG6  the settings window shows the switch, the cap and the pace (设置 → 桌宠行为 → 聊天)
//   SG7  a click on her reply in the bubble (real mouse), also mid-reply, opens 聊天 on her conversation with every
//        message; 思考中… and selecting text do not
// Screenshots, video, seg-timeline.txt (timestamps), renderer-logs.json and chat-log.json in out/e2e/segmented/.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Seg = require('../src/core/segments');

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
    // which messages were on screen, in order, each once; when each first showed
    const seqOf = (samples) => samples.map((s) => s.segs[0]).filter((x, i, a) => x && x !== a[i - 1]);
    const firstAt = (samples, msg) => (samples.find((s) => s.segs[0] === msg) || {}).t;
    const onScreen = (m) => page.waitForFunction((t) => [...document.querySelectorAll('#bubble .seg')].map((e) => e.textContent).join('|') === t, m, { timeout: 20000 });
    const played = () => page.waitForFunction(() => { const st = window.petFx.segState(); return st && st.done; }, null, { timeout: 30000 });
    const timeline = [];
    const tl = (label, samples, msgs) => {
      const rows = msgs.map((m, i) => `  #${i + 1} +${firstAt(samples, m)}ms 「${m}」`);
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
          await onScreen(MSGS[n - 1]);
          await shot(`sg1-${n}-of-4`);
          if (n < 4) {
            await page.waitForFunction(() => !!document.querySelector('#bubble .seg-typing'), null, { timeout: 5000 });
            await shot(`sg1-${n}-typing`);
          }
        }
        await page.waitForTimeout(400);
        const samples = await stopSampler();
        // never more than one on screen, and each replaced the last, in order
        assert.ok(samples.every((s) => s.segs.length <= 1), `more than one message on screen: ${JSON.stringify(samples.find((s) => s.segs.length > 1))}`);
        assert.deepEqual(seqOf(samples), MSGS);
        // each stayed long enough to read before the next replaced it
        const at = MSGS.map((m) => firstAt(samples, m));
        for (let i = 1; i < 4; i++) assert.ok(at[i] - at[i - 1] >= Seg.readMs(MSGS[i - 1]) - 60, `「${MSGS[i - 1]}」 was on screen for only ${at[i] - at[i - 1]} ms`);
        // 「正在输入」 after each one while the next comes
        assert.ok(MSGS.slice(0, 3).every((m) => samples.some((s) => s.segs[0] === m && s.typing)), 'no typing dots between messages');
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
        return note(`${line}; one on screen at a time; gaps ${gaps.join('/')} ms; typing dots between each; chat-log +2 (pet = whole reply, 4 lines); TTS offered once; system role has the 分段 rule`);
      }, page);

      await step(S, 'SG1b one bubble, not several: the ordinary card and tail, one message in it, she does not move', async () => {
        const look = () => page.evaluate(() => {
          const b = document.getElementById('bubble');
          const cs = getComputedStyle(b);
          const pet = document.getElementById('pet-body').getBoundingClientRect();
          return {
            bg: cs.backgroundColor, shadow: cs.boxShadow,
            tail: getComputedStyle(document.querySelector('.bubble-tail')).display,
            segs: [...b.querySelectorAll('.seg')].map((e) => e.textContent),
            petBottom: Math.round(pet.bottom),
          };
        });
        const check = (v, msg) => {
          assert.notEqual(v.bg, 'rgba(0, 0, 0, 0)', 'the bubble has no card');
          assert.notEqual(v.shadow, 'none', 'the bubble has no shadow');
          assert.notEqual(v.tail, 'none', 'the bubble has no tail');
          assert.deepEqual(v.segs, [msg]);
        };
        const v4 = await look(); // the last message of SG1
        check(v4, MSGS[3]);
        const SIX = ['🥺', '在吗？', '有点想你了。', '在干什么呀？', '理理我嘛～', '不理我我就闹了'];
        reply({ pieces: [SIX.join('\n')], gapMs: 0 });
        await startSampler();
        await sendText('嗨～');
        await onScreen(SIX[3]);
        const mid = await look();
        check(mid, SIX[3]);
        await shot('sg1b-one-bubble-mid-reply');
        await onScreen(SIX[5]);
        await played();
        await page.waitForTimeout(400); // the fade-in is over
        await shot('sg1b-last-message');
        const settled = await page.evaluate(() => { const el = document.querySelector('#bubble .seg'); const c = getComputedStyle(el); return { opacity: c.opacity, same: c.color === getComputedStyle(document.documentElement).getPropertyValue('--lobe-color-text') || c.color === getComputedStyle(document.getElementById('bubble')).color, thinking: document.getElementById('bubble').classList.contains('thinking') }; });
        assert.deepEqual(settled, { opacity: '1', same: true, thinking: false }, 'the message is not at full strength once it settled');
        const v6 = await look();
        check(v6, SIX[5]);
        const samples = await stopSampler();
        assert.deepEqual(seqOf(samples), SIX);
        assert.ok(samples.every((x) => x.segs.length <= 1), 'more than one message on screen');
        assert.deepEqual([mid.petBottom, v6.petBottom], [v4.petBottom, v4.petBottom], 'the bubble moved her');
        return note(`card bg ${v6.bg}, tail ${v6.tail}; 6 messages replaced one another (${seqOf(samples).join(' → ')}), never two on screen; pet bottom stays ${v4.petBottom}`);
      }, page);

      await step(S, 'SG2 a reply that really streams: the first line shows while she writes, later ones wait as 「正在输入」', async () => {
        const M = ['😝', '在吗？', '想你啦', '今天过得怎么样？'];
        reply({ pieces: ['😝\n', '在吗', '？\n', '想你', '啦\n', '今天过得', '怎么样？'], gapMs: 600 });
        await startSampler();
        await sendText('在呢');
        await page.waitForFunction((m) => document.body.classList.contains('busy') && [...document.querySelectorAll('#bubble .seg')].some((e) => e.textContent === m), M[1], { timeout: 15000 });
        await shot('sg2-streaming');
        await idle();
        await onScreen(M[3]);
        await page.waitForTimeout(300);
        const samples = await stopSampler();
        assert.ok(samples.every((s) => s.segs.length <= 1), 'more than one message on screen');
        assert.ok(samples.some((s) => s.busy && s.segs[0] === M[1]), 'nothing past the first message was on screen before the stream ended');
        assert.ok(samples.some((s) => s.busy && s.typing), 'no 「正在输入」 while she was writing');
        assert.deepEqual(seqOf(samples), M);
        const doneAt = (samples.find((s, i) => i > 0 && !s.busy && samples[i - 1].busy) || {}).t;
        return note(`${tl('SG2 真正流式（每块 600 ms）', samples, M)}; stream ended at +${doneAt}ms`);
      }, page);

      await step(S, 'SG3 a new message while a reply is still coming out stops it; no timer is left; the new reply plays', async () => {
        const OLD = ['好呀', '那我先说第一件事', '然后是第二件事', '第三件事是', '最后一件事', '说完啦'];
        reply({ pieces: [OLD.join('\n')], gapMs: 0 });
        const t0 = await nowMs();
        await startSampler();
        await sendText('说说你今天的事');
        await onScreen(OLD[1]);
        await idle();
        await shot('sg3-before-new-message');
        const NEW = ['嗯？', '你说～'];
        reply({ pieces: [NEW.join('\n')], gapMs: 0 });
        const tCut = await nowMs();
        await sendText('等等');
        await onScreen(NEW[1]);
        await idle();
        await page.waitForTimeout(6000); // the rest of the old reply would have come by now
        await shot('sg3-after');
        const samples = await stopSampler();
        const log = await segLogSince(t0);
        const cancel = log.find((e) => e.ev === 'cancel');
        assert.ok(cancel, 'no cancel');
        assert.equal(cancel.reason, 'new-message');
        assert.ok(cancel.shown >= 2 && cancel.shown < OLD.length, JSON.stringify(cancel));
        assert.ok(samples.every((x) => x.segs.length <= 1), 'more than one message on screen');
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
        await startSampler();
        await onScreen(MID[1]);
        await shot('sg4b-emoji-in-the-middle');
        const emoji = await page.evaluate(() => document.querySelector('#bubble .seg').classList.contains('emoji'));
        assert.equal(emoji, true);
        await onScreen(MID[2]);
        await page.waitForTimeout(100); // the sampler's next tick sees it
        const shown = seqOf(await stopSampler());
        assert.deepEqual(shown.slice(-2), MID.slice(1));
        return note(`「🥺 在吗？」 stays one message; the emoji alone on a line is its own message: ${JSON.stringify(shown)}`);
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

      await step(S, 'SG7 a click on her reply opens 聊天 on her conversation with every message; 思考中… and selecting do not', async () => {
        const adminOpen = () => app.windows().some((p) => !p.isClosed() && p.url().includes('admin-ui'));
        const clickBubble = () => page.click('#bubble', { position: { x: 12, y: 10 }, noWaitAfter: true });
        for (const w of app.windows().filter((p) => p.url().includes('admin-ui'))) await w.close().catch(() => {});
        // 思考中…: nothing to read there
        reply({ pieces: ['好呀，这句话写得慢一点。'], gapMs: 1500 });
        await sendText('先等等');
        await page.waitForSelector('#bubble.thinking');
        assert.equal(await page.evaluate(() => document.getElementById('bubble').title || 'none'), 'none');
        await clickBubble();
        await page.waitForTimeout(600);
        assert.equal(adminOpen(), false, '思考中… opened the chat page');
        await idle();
        // selecting text with a drag is not a click
        const box = await page.locator('#bubble').boundingBox();
        await page.mouse.move(box.x + 12, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(600);
        assert.ok(await page.evaluate(() => String(window.getSelection()).length > 0), 'the drag selected nothing');
        assert.equal(adminOpen(), false, 'selecting text opened the chat page');
        await page.evaluate(() => window.getSelection().removeAllRanges());
        // mid-reply: the click opens 聊天 and the reply goes on in the bubble
        const M = ['🥺', '在吗？', '有点想你了。', '在干什么呀？'];
        reply({ pieces: [M.join('\n')], gapMs: 0 });
        await sendText('嗨，点我看记录');
        await onScreen(M[1]);
        await idle();
        await shot('sg7-before-click');
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('bubble')).cursor), 'pointer');
        await page.hover('#bubble');
        assert.equal(await page.evaluate(() => document.getElementById('bubble').title), '点击查看聊天记录');
        await clickBubble();
        let admin = null;
        for (let i = 0; i < 300 && !admin; i++) {
          admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
          if (!admin) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(admin, 'the click opened no settings window');
        await adminUntil(admin, () => location.hash.startsWith('#/chat/') && !!document.querySelector('[data-chat-page]'), null, 15000, 'the 聊天 page');
        const chatPath = await admin.evaluate(() => location.hash);
        assert.match(chatPath, /^#\/chat\/claude(-pixel)?$/); // her character id; the page shows her base's conversation
        await adminUntil(admin, (want) => {
          const all = [...document.querySelectorAll('[data-chat-page] [data-role="assistant"]')].map((e) => e.innerText);
          return want.every((m) => all.some((t) => t.includes(m)));
        }, M, 15000, 'every message on the 聊天 page');
        await admin.waitForTimeout(300);
        await admin.screenshot({ path: path.join(SHOTS, 'sg7-chat-page.png') });
        await onScreen(M[3]); // the bubble went on by itself
        await admin.close().catch(() => {});
        return note(`思考中… and a text selection opened nothing; a click on 「${M[1]}」 opened ${chatPath} showing all ${M.length} messages; the bubble went on to 「${M[3]}」`);
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
