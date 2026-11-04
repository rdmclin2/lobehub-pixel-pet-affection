'use strict';

// 设置窗口 → 聊天 page e2e (run.js `chatui`), kept out of run.js (over the size limit). Drives the real chat page
// (admin/src/console/pages/Chat.tsx) in the real settings window with a fake lh + a fake Responses SSE server that
// keeps each topic's history the way LobeHub does (no tokens). One character is one conversation (docs/admin-chat.md):
// the rail entry; the character list; her history shared with the desktop (a round sent in the pet window shows up,
// tagged 桌面); Enter / Shift+Enter, a streamed Markdown reply with the stop button; multi-turn context through her
// topic; pictures (file dialog, paste, drag & drop → thumbnails → remove → sent → zoomed preview); her model picker
// (only her vendor's, the same value as her character page, applied to her agent; vision warning); stop; an error
// with 重试; scrolling; 查看更早的消息 and recall of older rounds; another character (her own agent and history); a
// character not met yet; another page and back; a reload.
// Screenshots + evidence in out/e2e/<name>/ (PIXELPET_CHATUI_SHOTS=<dir> copies the screenshots there too).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const png = (w, h, [r, g, b]) => {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};

// 聊天记录 seeded before the first launch: two days ago, 30 rounds with 小克 (claude) — enough for 查看更早的消息,
// and the oldest one holds the 暗号 a later question about the past has to bring back.
const seedLog = (now) => {
  const messages = [];
  let t = now - 2 * 24 * 3600e3;
  for (let i = 0; i < 30; i++) {
    const turnId = `tseed${i}`;
    messages.push({ id: `m${messages.length + 1}`, at: (t += 60000), speciesId: 'claude', role: 'user', origin: 'user', kind: 'chat', turnId, text: i === 0 ? '记一下：我的暗号是青柠42' : `前天的第 ${i} 句` });
    messages.push({ id: `m${messages.length + 1}`, at: (t += 5000), speciesId: 'claude', role: 'pet', origin: 'user', kind: 'chat', turnId, text: i === 0 ? '好，记住了。' : `嗯嗯，第 ${i} 句收到` });
  }
  return { schema: 1, seq: messages.length, messages };
};

module.exports = function chatUiScenario(ctx, opts = {}) {
  const { ROOT, OUT, FAKE_LH, step, launch, openAdminWindow } = ctx;
  return async function chatUi() {
    const S = opts.name || 'chatui'; // `admin-chat` (e2e/admin-chat.js) runs the same walk under its own name
    const SHOTS = path.join(OUT, S);
    fs.mkdirSync(SHOTS, { recursive: true });
    const COPY = process.env.PIXELPET_CHATUI_SHOTS || null;
    if (COPY) fs.mkdirSync(COPY, { recursive: true });
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const { startFakeResponses } = require('../test/fixtures/fake-responses-server');

    // like LobeHub: a run continuing a topic (previous_response_id) sees that topic's earlier messages
    const topics = new Map();
    let opened = 0;
    const MD = ['好的，', '这里是**加粗**的', '回复。\n\n', '- 第一点\n', '- 第二点\n\n', '```js\n', 'const a = 1;\n', '```\n'];
    let mode = null;
    const srv = await startFakeResponses((body) => {
      const text = typeof body.input === 'string' ? body.input : JSON.stringify(body.input || '');
      const id = body.previous_response_id || `tpc_E2E_${++opened}`;
      const hist = topics.get(id) || [];
      topics.set(id, [...hist, text]);
      const seen = [...hist, text].join('\n');
      const last = text.split('\n').pop();
      if (mode === 'slow') return { pieces: ['这一段', '会被', '中途', '停止，', '后面', '不会', '出现', '。'], gapMs: 500, id };
      if (mode === 'fail') return { status: 502, body: 'upstream exploded' };
      if (mode === 'hang') return { pieces: ['我想', '一想……'], gapMs: 200, hang: true, id };
      if (mode === 'long') return { pieces: Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：滚动测试。\n\n`), gapMs: 150, id };
      if (/颜色/.test(last)) return { pieces: ['图里是', '一块', '红色。'], gapMs: 150, id };
      if (/我叫什么/.test(last)) return { pieces: /我叫小明/.test(seen) ? ['你叫', '小明。'] : ['我不知道', '。'], gapMs: 150, id };
      if (/暗号/.test(last)) return { pieces: /青柠42/.test(text) ? ['你之前说过，', '暗号是青柠42。'] : ['我想不起来了。'], gapMs: 150, id };
      if (/记住/.test(last)) return { pieces: ['好的', '，记住了。'], gapMs: 150, id };
      return { pieces: MD, gapMs: 300, id };
    });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${S}-`));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${S}fake-`));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    fs.writeFileSync(path.join(data, 'chat-log.json'), JSON.stringify(seedLog(Date.now())));
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_DIRECT: '1', LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'e2e-fake-key', LOBEHUB_CLI_HOME: path.relative(os.homedir(), fakeDir) };
    const red = path.join(data, 'red.png');
    fs.writeFileSync(red, png(320, 200, [230, 40, 40]));
    const blue = png(96, 96, [40, 90, 230]).toString('base64');

    const evidence = [];
    const note = (s) => { evidence.push(s); return s.length > 300 ? `${s.slice(0, 297)}…` : s; };
    let { app, page } = await launch(env);
    let admin = null;
    const shot = async (name) => {
      const f = path.join(SHOTS, `${name}.png`);
      await admin.screenshot({ path: f });
      if (COPY) fs.copyFileSync(f, path.join(COPY, `${name}.png`));
      return `${name}.png`;
    };
    const until = async (fn, arg, ms = 15000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        if (await admin.evaluate(fn, arg).catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
      }
    };
    const errors = [];
    const watch = (p) => { p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); };
    const bubbles = () => admin.evaluate(() => [...document.querySelectorAll('[data-chat-page] [data-role]')].map((el) => ({ id: el.dataset.messageId || '', role: el.dataset.role, status: el.dataset.status || (el.hasAttribute('data-streaming') ? 'streaming' : ''), text: (el.querySelector('.lobe-markdown, [class*="markdown"]') || el).innerText.trim().slice(0, 200), all: el.innerText, images: el.querySelectorAll('[data-message-images] img').length })));
    const sendButton = () => admin.evaluate(() => { const b = [...document.querySelectorAll('[data-chat-input] button')].pop(); return b ? b.innerText.trim() : null; });
    const type = async (text) => { await admin.click('[data-chat-textarea]'); await admin.keyboard.type(text); };
    const waitIdle = () => until(() => !document.querySelector('[data-streaming]'), null, 20000, 'reply done');
    const sendAndWait = async (text) => { await type(text); await admin.keyboard.press('Enter'); await sleep(300); await waitIdle(); };
    const petJson = () => JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
    const lastReq = () => srv.requests[srv.requests.length - 1].body;
    const reqText = (b) => (typeof b.input === 'string' ? b.input : JSON.stringify(b.input));
    const edits = () => (fs.existsSync(path.join(fakeDir, 'edits.log')) ? fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    const lhCalls = () => fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
    const openModels = async () => {
      await admin.click('[data-model-select]');
      await until(() => document.querySelectorAll('[role="option"] [data-model-option]').length > 0, null, 8000, 'model options');
      await sleep(300);
    };
    const pickModel = async (key) => {
      await openModels();
      await admin.click(`[role="option"] [data-model-option="${key}"]`);
      await until((k) => window.petAdmin.state().then((s) => (s.roster.find((c) => c.base === 'claude') || {}).model?.current === k), key, 8000, `model ${key} chosen`);
    };

    // a step that failed half-way may have left another page open: the next one starts from her chat
    const ensureChat = async (id = 'claude') => {
      if (await admin.evaluate((i) => location.hash === `#/chat/${i}` && !!document.querySelector('[data-chat-textarea]'), id)) return;
      await admin.keyboard.press('Escape').catch(() => {});
      await admin.evaluate((i) => { location.hash = `#/chat/${i}`; }, id);
      await until(() => !!document.querySelector('[data-chat-page] [data-chat-textarea]'), null, 10000, 'chat page');
      await waitIdle().catch(() => {});
    };

    try {
      // a companion first: 小克 (claude), as a new user meets her
      await page.waitForSelector('.char-card', { timeout: 30000 });
      await page.click('.char-card[data-species="claude"]');
      await page.fill('#pet-name', '小克');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('thinking'), null, { timeout: 20000 }).catch(() => {});
      // and 小G (gpt) met too, then back to 小克 on the desktop
      const sw = await page.evaluate(() => window.pet.switchCharacter('gpt', '小G'));
      assert.equal(sw.ok, true, JSON.stringify(sw).slice(0, 200));
      assert.equal((await page.evaluate(() => window.pet.switchCharacter('claude'))).ok, true);
      admin = await openAdminWindow(app, page, 'overview');
      watch(admin);
      await admin.setViewportSize({ width: 1280, height: 820 }).catch(() => {});

      await step(S, 'U1 左侧 rail 有「聊天」：点进去是角色列表（一个角色一个会话），默认打开桌面上的当前角色；原有入口不变', async () => {
        const rail = await admin.$$eval('nav a[data-rail]', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
        assert.deepEqual(rail.map((r) => r[0]), ['小屋', '角色', '商店', '玩法', '设置', '聊天']);
        await admin.click('[data-rail="chat"]');
        await until(() => location.hash.startsWith('#/chat') && !!document.querySelector('[data-chat-page] [data-chat-textarea]'), null, 10000, 'chat page');
        assert.equal(await admin.getAttribute('[data-rail="chat"]', 'aria-current'), 'page');
        const list = await admin.$$eval('[data-character]', (els) => els.map((e) => ({ id: e.dataset.character, met: e.dataset.met, current: e.getAttribute('aria-current'), text: e.innerText.replace(/\s+/g, ' ').trim() })));
        assert.equal(list.length, 5, 'every character');
        assert.deepEqual(list.slice(0, 2).map((x) => x.id).sort(), ['claude', 'gpt'], 'the ones met come first');
        assert.equal(list.find((x) => x.id === 'claude').current, 'true', 'opens the desktop companion');
        assert.ok(list.filter((x) => x.met === 'false').every((x) => /还没见过面/.test(x.text)));
        assert.match(await admin.$eval('[data-chat-title]', (e) => e.innerText), /小克/);
        assert.equal(await admin.$('[data-new-session]'), null, 'no 新建会话');
        assert.equal(await admin.$('[data-clear-session]'), null, 'no 清空');
        await shot('01-chat-character-list');
        await admin.click('[data-rail="settings"]');
        await until(() => location.hash === '#/settings' && !!document.querySelector('[data-admin-page="settings"]'), null, 10000, 'settings');
        await shot('01b-back-to-settings');
        await admin.click('[data-rail="home"]');
        await until(() => !!document.querySelector('[data-admin-page="overview"]'), null, 10000, 'overview');
        await admin.click('[data-rail="chat"]');
        await until(() => !!document.querySelector('[data-chat-page] [data-chat-textarea]'), null, 10000, 'chat again');
        return note(`rail: ${rail.map((r) => `${r[0]}(${r[1]})`).join(' · ')}; list: ${list.map((x) => `${x.id}[${x.met === 'true' ? '见过' : '没见过'}${x.current ? ',打开' : ''}]`).join(' ')}; no 新建 / 清空; 设置 / 小屋 → back to 聊天 ok`);
      }, admin);

      await step(S, 'U2 她的历史与桌面共用：最近 40 条读出来，「查看更早的消息」往前翻；在桌宠聊天框说一句，聊天页自动出现并标「桌面」', async () => {
        await until(() => document.querySelectorAll('[data-chat-page] [data-role]').length >= 40, null, 10000, 'seeded history');
        const n0 = (await bubbles()).length;
        assert.equal(n0, 40, 'one page');
        assert.ok(await admin.$('[data-load-earlier]'));
        await admin.click('[data-load-earlier]');
        await until((n) => document.querySelectorAll('[data-chat-page] [data-role]').length > n, n0, 8000, 'earlier page');
        const b = await bubbles();
        assert.equal(b[0].text, '记一下：我的暗号是青柠42', 'the oldest round is back');
        assert.equal(await admin.$('[data-load-earlier]'), null, 'nothing older');
        await shot('02-history-earlier');
        const r = await page.evaluate(() => window.pet.chat('这句是在桌面上说的'));
        assert.equal(r.ok, true);
        await until(() => [...document.querySelectorAll('[data-chat-page] [data-role="user"]')].some((e) => e.innerText.includes('这句是在桌面上说的')), null, 10000, 'desktop round shown');
        const mine = (await bubbles()).filter((x) => /这句是在桌面上说的/.test(x.all) || x === undefined);
        assert.match(mine[0].all, /桌面/);
        await shot('02b-desktop-round');
        return note(`${n0} messages on open, 查看更早 → ${b.length} (oldest: 「${b[0].text}」); a round sent in the pet window appeared here tagged 「桌面」`);
      }, admin);

      let claudeModels = null;
      await step(S, 'U3 模型选择器：只有她所属厂商的模型，与她的角色页同一个值；切换后她的 agent 换成这个模型', async () => {
        claudeModels = (await admin.evaluate(() => window.petAdmin.state())).roster.find((c) => c.base === 'claude').model;
        assert.ok(claudeModels.options.length >= 2, JSON.stringify(claudeModels).slice(0, 200));
        await openModels();
        const shown = await admin.$$eval('[role="option"] [data-model-option]', (els) => [...new Set(els.map((e) => e.getAttribute('data-model-option')))]);
        assert.deepEqual(new Set(shown), new Set(claudeModels.options.map((o) => o.key)));
        assert.ok(shown.every((k) => /claude/i.test(k)), `only Claude models: ${shown}`);
        await shot('03-model-picker-open');
        await admin.keyboard.press('Escape');
        const target = claudeModels.options.find((o) => o.vision) || claudeModels.options[0];
        await pickModel(target.key);
        const label = (await admin.$eval('[data-model-select]', (el) => el.innerText.trim())).replace(/\s+/g, ' ');
        assert.ok(label.includes(target.label), label);
        const agent = petJson().characters.claude.agentId;
        await until(() => true, null, 100);
        const e = edits().filter((x) => x.agentId === agent && x.model).pop();
        assert.equal(`${e.provider}:${e.model}`, target.key, 'her agent was switched to it');
        return note(`${shown.length} options, all Claude (${claudeModels.options.map((o) => `${o.label}${o.vision ? '[视觉]' : ''}`).join(', ')}); picked ${target.label} → select 「${label}」; lh agent edit ${agent} -m ${e.model} -p ${e.provider}`);
      }, admin);

      await step(S, 'U4 Enter 发送 / Shift+Enter 换行；发送中按钮变「停止」、显示「正在回复」，Markdown 逐段流式；请求走她自己的 agent 和话题', async () => {
        await type('第一行');
        await admin.keyboard.press('Shift+Enter');
        await admin.keyboard.type('第二行');
        assert.equal(await admin.$eval('[data-chat-textarea]', (t) => t.value), '第一行\n第二行');
        await admin.keyboard.press('Enter');
        await until(() => !!document.querySelector('[data-streaming]'), null, 8000, 'streaming bubble');
        assert.equal(await sendButton(), '停止');
        const samples = [];
        for (let i = 0; i < 40 && samples.length < 4; i++) {
          const t = await admin.evaluate(() => document.querySelector('[data-streaming]')?.innerText.replace(/正在回复.*/, '').trim() ?? null);
          if (t && t !== samples[samples.length - 1]) samples.push(t);
          if (samples.length === 2) await shot('04-streaming-midway');
          await sleep(150);
        }
        assert.ok(samples.length >= 3, `streamed in steps: ${JSON.stringify(samples)}`);
        await waitIdle();
        assert.equal(await sendButton(), '发送');
        const md = await admin.evaluate(() => { const last = [...document.querySelectorAll('[data-role="assistant"]')].pop(); return { strong: last.querySelector('strong')?.textContent, li: last.querySelectorAll('li').length, code: !!last.querySelector('pre, code') }; });
        assert.deepEqual([md.strong, md.li, md.code], ['加粗', 2, true]);
        const pj = petJson().characters.claude;
        const req = lastReq();
        assert.equal(req.model, pj.agentId, 'her agent');
        assert.equal(req.previous_response_id, pj.topicId, 'her topic: the one the desktop talks in');
        assert.match(reqText(req), /^\[状态\]/, 'her persona prompt');
        await shot('05-streamed-markdown');
        return note(`Shift+Enter kept a newline; button 发送→停止→发送; ${samples.length} growing samples; markdown ok; request model=${req.model} (小克's agent), previous_response_id=${req.previous_response_id} (her topic)`);
      }, admin);

      await step(S, 'U5 多轮上下文：她的话题记得上一句', async () => {
        await sendAndWait('记住：我叫小明。');
        await sendAndWait('我叫什么？');
        const b = await bubbles();
        assert.match(b[b.length - 1].text, /你叫小明/);
        assert.deepEqual(b.slice(-4).map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
        return note(`last answer 「${b[b.length - 1].text}」 — from the topic's own history (the request carried only the new message)`);
      }, admin);

      await step(S, 'U6 问起以前的事：从聊天记录里翻出更早的轮次一起发给她', async () => {
        await sendAndWait('你还记得我之前说的暗号吗？');
        const req = reqText(lastReq());
        assert.match(req, /更早的聊天记录摘录/);
        assert.match(req, /青柠42/);
        const b = await bubbles();
        assert.match(b[b.length - 1].text, /青柠42/);
        await sendAndWait('好的谢谢');
        assert.doesNotMatch(reqText(lastReq()), /更早的聊天记录摘录/, 'not on an ordinary message');
        return note(`question about the past → request carried 【更早的聊天记录摘录】 with 「青柠42」 (seeded two days ago); answer 「${b[b.length - 1].text}」; the next ordinary message carried none`);
      }, admin);

      await step(S, 'U7 图片：文件选择 + 粘贴 + 拖入 → 输入区缩略图，可移除；发送后在消息里显示，并挂到她的话题里', async () => {
        await page.evaluate((p) => window.pet.debugNextOpen(p), red);
        await admin.click('[data-pick-images]');
        await until(() => document.querySelectorAll('[data-pending-image]').length === 1, null, 8000, 'picked thumb');
        await admin.evaluate((b64) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bin], 'pasted-blue.png', { type: 'image/png' }));
          document.querySelector('[data-chat-textarea]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        }, blue);
        await until(() => document.querySelectorAll('[data-pending-image]').length === 2, null, 8000, 'pasted thumb');
        await admin.evaluate((b64) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bin], 'dropped-blue.png', { type: 'image/png' }));
          const target = document.querySelector('[data-chat-input]');
          for (const t of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }, blue);
        await until(() => document.querySelectorAll('[data-pending-image]').length === 3, null, 8000, 'dropped thumb');
        await shot('06-input-thumbnails');
        for (const n of ['pasted-blue.png', 'dropped-blue.png']) await admin.click(`[data-pending-image="${n}"] [data-remove-image]`);
        await until(() => document.querySelectorAll('[data-pending-image]').length === 1, null, 5000, 'removed');
        await sendAndWait('这张图片是什么颜色？');
        const b = await bubbles();
        assert.ok(b[b.length - 2].images >= 1, JSON.stringify(b[b.length - 2]));
        assert.match(b[b.length - 1].text, /红色/);
        const topic = petJson().characters.claude.topicId;
        const calls = lhCalls();
        assert.ok(calls.some((a) => a[0] === 'file' && a[1] === 'upload'), 'uploaded');
        const mc = calls.filter((a) => a[0] === 'message' && a[1] === 'create').pop();
        assert.equal(mc[mc.indexOf('--topic-id') + 1], topic, 'attached in her topic');
        assert.ok(calls.some((a) => a[0] === 'message' && a[1] === 'add-files'));
        assert.ok(fs.readdirSync(path.join(data, 'admin-chat', 'images', 'claude')).some((f) => /^att_.*\.png$/.test(f)), 'kept on disk for her history');
        await shot('07-image-in-message');
        return note(`3 thumbs (pick + paste + drop) → removed 2 → sent 1; user bubble shows ${b[b.length - 2].images} picture; lh file upload → message create --topic-id ${topic} → add-files; answer 「${b[b.length - 1].text}」`);
      }, admin);

      await step(S, 'U8 点击消息里的图片放大预览', async () => {
        await admin.click('[data-role="user"] [data-message-images] img');
        await until(() => [...document.querySelectorAll('img')].some((i) => i.getBoundingClientRect().width >= 300 && i.src.startsWith('data:image/png')), null, 8000, 'zoomed preview');
        await sleep(500);
        const big = await admin.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.getBoundingClientRect()).filter((r) => r.width >= 300).map((r) => `${Math.round(r.width)}×${Math.round(r.height)}`));
        await shot('08-image-preview-zoomed');
        await admin.keyboard.press('Escape');
        await until(() => ![...document.querySelectorAll('img')].some((i) => i.getBoundingClientRect().width >= 300), null, 5000, 'preview closed');
        return note(`128×128 thumb → preview ${big.join(', ')}; Esc closes`);
      }, admin);

      await step(S, 'U9 模型看不了图：带图时输入区提示，不发送；她的角色页显示的是同一个模型', async () => {
        const plain = claudeModels.options.find((o) => !o.vision);
        const seeing = claudeModels.options.find((o) => o.vision);
        await pickModel(plain.key);
        await page.evaluate((p) => window.pet.debugNextOpen(p), red);
        await admin.click('[data-pick-images]');
        await until(() => !!document.querySelector('[data-vision-warning]'), null, 8000, 'vision warning');
        const warn = await admin.$eval('[data-vision-warning]', (e) => e.innerText.trim());
        const n0 = srv.requests.length;
        await type('看看这张');
        await admin.keyboard.press('Enter');
        await sleep(600);
        assert.equal(srv.requests.length, n0, 'nothing was sent');
        await shot('09-vision-warning');
        await admin.click('[data-pending-image] [data-remove-image]');
        await admin.fill('[data-chat-textarea]', '');
        // the same pick on her character page
        await admin.evaluate(() => { location.hash = '#/characters/claude'; });
        await until(() => !!document.querySelector('[data-admin-page]') && /characters/.test(location.hash), null, 8000, 'her page');
        await admin.getByRole('tab', { name: '模型' }).click();
        await until((l) => { const p = document.querySelector('[role="tabpanel"]:not([inert])'); return !!p && document.querySelectorAll('[role="tabpanel"]').length === 1 && p.innerText.includes(l); }, plain.label, 8000, 'model tab');
        const there = (await admin.$eval('[role="tabpanel"]:not([inert])', (e) => (e.querySelector('[data-model-status]') || e).innerText.trim())).replace(/\s+/g, ' ').slice(0, 120);
        assert.ok(there.includes(plain.label), `character page shows ${there}`);
        await shot('09b-character-page-same-model');
        await admin.evaluate(() => { location.hash = '#/chat/claude'; });
        await until(() => !!document.querySelector('[data-chat-page] [data-chat-textarea]'), null, 8000, 'chat back');
        await pickModel(seeing.key);
        return note(`${plain.label} (no vision) + picture → 「${warn}」, Enter sent nothing; 角色 → 小克 → 模型 shows 「${there}」 (same value); back to ${seeing.label}`);
      }, admin);

      await step(S, 'U10 停止生成：回复中途点「停止」，已生成的部分保留并标「已停止」', async () => {
        await ensureChat();
        mode = 'slow';
        try {
          await type('慢慢说一段话');
          await admin.keyboard.press('Enter');
          await until(() => (document.querySelector('[data-streaming]')?.innerText || '').includes('会被'), null, 10000, 'some text');
          await admin.click('[data-chat-input] button:has-text("停止")');
          await until(() => !document.querySelector('[data-streaming]') && !!document.querySelector('[data-role="assistant"][data-status="aborted"]'), null, 10000, 'aborted');
        } finally {
          mode = null;
        }
        const t = await admin.$eval('[data-role="assistant"][data-status="aborted"]', (e) => e.innerText.trim());
        assert.ok(t.includes('这一段') && t.includes('已停止') && !t.includes('不会出现'), t);
        await shot('10-stopped');
        return note(`stopped mid-way: 「${t.replace(/\s+/g, ' ')}」`);
      }, admin);

      await step(S, 'U12 消息区可滚动：回复中上翻不被拉回，「回到最新消息」可回到底部', async () => {
        await ensureChat();
        mode = 'long';
        try {
          await type('来一段长回复');
          await admin.keyboard.press('Enter');
          await until(() => (document.querySelector('[data-streaming]')?.innerText || '').includes('第 8 行'), null, 15000, 'long text');
          const pinned = await admin.$eval('[data-chat-scroll]', (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
          assert.ok(pinned < 64, `stays at the bottom while streaming (${pinned}px off)`);
          await admin.$eval('[data-chat-scroll]', (el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
          await sleep(1200);
          const top = await admin.$eval('[data-chat-scroll]', (el) => el.scrollTop);
          assert.ok(top < 40, `not pulled back down (${top})`);
          await shot('12-scrolled-up-while-streaming');
          await admin.click('[data-to-bottom]');
          await sleep(800);
          const off = await admin.$eval('[data-chat-scroll]', (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
          assert.ok(off < 64, `back at the bottom (${off})`);
          await waitIdle();
          return note(`while streaming ${pinned}px from the bottom; scrolled up → scrollTop=${top} after 1.2 s; 回到最新消息 → ${off}px`);
        } finally {
          await waitIdle().catch(() => {});
          mode = null;
        }
      }, admin);

      let claudeCount = 0;
      await step(S, 'U13 切到另一个角色：她自己的 agent 和历史；再切回来，之前的对话都在', async () => {
        await ensureChat();
        claudeCount = (await bubbles()).length;
        await admin.click('[data-character="gpt"]');
        await until(() => location.hash === '#/chat/gpt' && /小G/.test(document.querySelector('[data-chat-title]')?.innerText || ''), null, 8000, 'gpt');
        await until(() => !document.querySelector('[data-chat-page] .ant-spin-spinning'), null, 8000, 'loaded');
        const before = (await bubbles()).length;
        await sendAndWait('你好呀');
        const pj = petJson();
        assert.equal(lastReq().model, pj.characters.gpt.agentId, '小G\'s own agent');
        assert.notEqual(pj.characters.gpt.agentId, pj.characters.claude.agentId);
        assert.equal(pj.speciesId, 'claude', 'the desktop companion stays');
        const shownModels = await (async () => { await openModels(); const k = await admin.$$eval('[role="option"] [data-model-option]', (els) => [...new Set(els.map((e) => e.getAttribute('data-model-option')))]); await admin.click('[data-model-select]'); await sleep(300); return k; })();
        assert.ok(shownModels.length && shownModels.every((k) => /gpt|o3/i.test(k)), `only OpenAI models for 小G: ${shownModels}`);
        await shot('13-other-character');
        await admin.click('[data-character="claude"]');
        await until(() => location.hash === '#/chat/claude', null, 8000, 'claude');
        await until((n) => document.querySelectorAll('[data-chat-page] [data-role]').length >= Math.min(n, 40), claudeCount, 8000, 'claude history');
        const back = await bubbles();
        const after = (await admin.evaluate(() => window.petAdmin.state())).roster.find((c) => c.base === 'claude').model.current;
        assert.equal(after, claudeModels.options.find((o) => o.vision).key, 'switching characters changes nobody\'s model');
        assert.equal(await admin.evaluate(() => [...document.querySelectorAll('.ant-message, [class*="toast"]')].some((e) => /找不到/.test(e.innerText))), false, 'no error toast');
        assert.match(back[back.length - 1].text, /第 40 行|滚动测试/);
        return note(`小G: ${before} messages before, own agent ${lastReq().model}, models offered: ${shownModels.join(', ')}; back to 小克 → ${back.length} messages, last one is her long reply`);
      }, admin);

      await step(S, 'U14 没见过面的角色：说明「还没见过面」并给出「去见她」，没有输入框', async () => {
        await ensureChat();
        await admin.click('[data-character="grok"]');
        await until(() => location.hash === '#/chat/grok' && /还没见过/.test(document.querySelector('[data-chat-scroll]')?.innerText || ''), null, 8000, 'not met');
        assert.equal(await admin.$('[data-chat-textarea]'), null);
        const txt = (await admin.$eval('[data-chat-scroll]', (e) => e.innerText)).replace(/\s+/g, ' ');
        assert.match(txt, /去见她/);
        await shot('14-not-met');
        await admin.click('[data-character="claude"]');
        await until(() => !!document.querySelector('[data-chat-textarea]'), null, 8000, 'back');
        return note(`grok: 「${txt.slice(0, 80)}」, no input box`);
      }, admin);

      await step(S, 'U15 刷新窗口后：还是她的对话，历史（含图片）与所选模型都在，可以接着聊', async () => {
        await admin.reload();
        await until(() => location.hash === '#/chat/claude' && document.querySelectorAll('[data-chat-page] [data-role]').length >= 10, null, 20000, 'reloaded history');
        await admin.click('[data-load-earlier]').catch(() => {});
        await until(() => document.querySelectorAll('[data-role="user"] [data-message-images] img').length >= 1, null, 10000, 'picture back');
        await sendAndWait('我叫什么？');
        const b = await bubbles();
        assert.match(b[b.length - 1].text, /你叫小明/);
        await shot('15-after-reload');
        return note(`after reload: #/chat/claude, ${b.length} messages, the picture is back, and 「我叫什么？」 → 「${b[b.length - 1].text}」`);
      }, admin);

      await step(S, 'U15c 超时：流式写了一半就不再有数据，到时（120 s）给出「模型回复超时」，不会退回到 lh 重发；点「重试」恢复', async () => {
        await ensureChat();
        mode = 'hang';
        const t0 = Date.now();
        await type('这次会超时');
        await admin.keyboard.press('Enter');
        await until(() => !!document.querySelector('[data-streaming]'), null, 15000, 'streaming bubble');
        await until(() => [...document.querySelectorAll('[data-role="assistant"][data-status="error"]')].some((e) => /超时/.test(e.innerText)), null, 150000, 'timeout error bubble');
        const waited = Date.now() - t0;
        const err = await admin.evaluate(() => [...document.querySelectorAll('[data-role="assistant"][data-status="error"]')].pop().innerText.trim());
        await shot('11b-timeout-retry');
        mode = null;
        const before = srv.requests.length;
        await admin.locator('[data-retry]').last().click(); // the newest error bubble (an earlier step's may still be in the history)
        await sleep(300);
        await waitIdle();
        const b = await bubbles();
        assert.equal(b[b.length - 1].status, 'done');
        assert.equal(b[b.length - 2].text, '这次会超时');
        assert.ok(srv.requests.length > before, 'retry sent a new request');
        return note(`after ${Math.round(waited / 1000)} s: 「${err.replace(/\s+/g, ' ').slice(0, 120)}」; 重试 → sent again → reply done (「${b[b.length - 1].text.slice(0, 40)}」)`);
      }, admin);

      await step(S, 'U15b 出错有可见提示，点「重试」重新发送这一轮', async () => {
        await ensureChat();
        // the direct way fails, and so does the `lh agent run` it falls back to: a real failed round
        mode = 'fail';
        fs.writeFileSync(path.join(fakeDir, 'fail-run'), '1');
        const errsBefore = await admin.evaluate(() => document.querySelectorAll('[data-role="assistant"][data-status="error"]').length);
        await type('这次会出错');
        await admin.keyboard.press('Enter');
        await until((n) => document.querySelectorAll('[data-role="assistant"][data-status="error"]').length > n, errsBefore, 30000, 'error bubble');
        const err = await admin.evaluate(() => [...document.querySelectorAll('[data-role="assistant"][data-status="error"]')].pop().innerText.trim());
        await shot('11-error-retry');
        mode = null;
        fs.rmSync(path.join(fakeDir, 'fail-run'), { force: true });
        await admin.locator('[data-retry]').last().click(); // the newest error bubble (an earlier step's may still be in the history)
        await sleep(300);
        await waitIdle();
        const b = await bubbles();
        assert.equal(b[b.length - 1].status, 'done');
        assert.equal(b[b.length - 2].text, '这次会出错');
        return note(`error: 「${err.replace(/\s+/g, ' ').slice(0, 120)}」; 重试 → sent again → reply done`);
      }, admin);

      await step(S, 'U16 设置窗口无报错（页面异常 / 控制台错误）', async () => {
        const real = errors.filter((e) => !/ResizeObserver loop/.test(e));
        assert.deepEqual(real, []);
        return note('pageerror 0, console.error 0');
      });
    } finally {
      fs.writeFileSync(path.join(SHOTS, `${S}-log.txt`), evidence.join('\n\n') + '\n');
      try { fs.writeFileSync(path.join(SHOTS, `${S}-requests.json`), JSON.stringify(srv.requests.map((q) => ({ at: q.at, model: q.body.model, previous_response_id: q.body.previous_response_id || null, lastText: reqText(q.body).slice(-160) })), null, 2) + '\n'); } catch { /* ignore */ }
      try { fs.copyFileSync(path.join(fakeDir, 'edits.log'), path.join(SHOTS, `${S}-lh-agent-edits.log`)); } catch { /* none */ }
      await app.close().catch(() => {});
      await srv.close();
    }
  };
};
