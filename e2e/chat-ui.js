'use strict';

// 设置窗口 → 聊天 page e2e (run.js `chatui`, T-2765), kept out of run.js (over the size limit). Drives the real
// chat page (admin/src/console/pages/Chat.tsx) in the real settings window with a fake lh + a fake Responses SSE
// server (no tokens): the rail entry, Enter / Shift+Enter, a streamed Markdown reply with the stop button, stop,
// an error with 重试, multi-turn context, pictures (file dialog, paste, drag & drop → thumbnails → remove → sent
// → zoomed preview), the model picker (vision warning, remembered), scrolling up while she writes, sessions
// (new / switch / clear / delete), another page and back, and a reload.
// Screenshots + evidence in out/e2e/chatui/ (PIXELPET_CHATUI_SHOTS=<dir> copies the screenshots there too).

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

module.exports = function chatUiScenario(ctx) {
  const { ROOT, OUT, FAKE_LH, step, launch, openAdminWindow } = ctx;
  return async function chatUi() {
    const S = 'chatui';
    const SHOTS = path.join(OUT, S);
    fs.mkdirSync(SHOTS, { recursive: true });
    const COPY = process.env.PIXELPET_CHATUI_SHOTS || null;
    if (COPY) fs.mkdirSync(COPY, { recursive: true });
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const { startFakeResponses } = require('../test/fixtures/fake-responses-server');

    const MD = ['好的，', '这里是**加粗**的', '回复。\n\n', '- 第一点\n', '- 第二点\n\n', '```js\n', 'const a = 1;\n', '```\n'];
    let mode = null;
    const srv = await startFakeResponses((body) => {
      const text = JSON.stringify(body.input || '');
      const last = text.slice(Math.max(text.lastIndexOf('现在我说'), 0));
      if (mode === 'slow') return { pieces: ['这一段', '会被', '中途', '停止，', '后面', '不会', '出现', '。'], gapMs: 500, id: body.previous_response_id || 'tpc_E2E_UI' };
      if (mode === 'fail') return { status: 502, body: 'upstream exploded' };
      if (mode === 'long') return { pieces: Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 行：滚动测试。\n\n`), gapMs: 150, id: 'tpc_E2E_UI' };
      if (/颜色/.test(last)) return { pieces: ['图里是', '一块', '红色。'], gapMs: 150, id: body.previous_response_id || 'tpc_E2E_UI' };
      if (/我叫什么/.test(last)) return { pieces: [/小明/.test(text) ? '你叫' : '我不知道', /小明/.test(text) ? '小明。' : '。'], gapMs: 150, id: 'tpc_E2E_UI' };
      if (/记住/.test(last)) return { pieces: ['好的', '，记住了。'], gapMs: 150, id: 'tpc_E2E_UI' };
      return { pieces: MD, gapMs: 350, id: 'tpc_E2E_UI' };
    });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${S}-`));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${S}fake-`));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
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
    const bubbles = () => admin.evaluate(() => [...document.querySelectorAll('[data-chat-page] [data-role]')].map((el) => ({ role: el.dataset.role, status: el.dataset.status || (el.hasAttribute('data-streaming') ? 'streaming' : ''), text: (el.querySelector('.lobe-markdown, [class*="markdown"]') || el).innerText.trim().slice(0, 200), images: el.querySelectorAll('[data-chat-image] img, img[data-chat-image], [data-message-images] img').length })));
    const sendButton = () => admin.evaluate(() => { const b = [...document.querySelectorAll('[data-chat-input] button')].pop(); return b ? b.innerText.trim() : null; });
    const type = async (text) => { await admin.click('[data-chat-textarea]'); await admin.keyboard.type(text); };
    const waitIdle = () => until(() => !document.querySelector('[data-streaming]'), null, 20000, 'reply done');

    try {
      await page.waitForSelector('.char-card', { timeout: 30000 });
      admin = await openAdminWindow(app, page, 'overview');
      watch(admin);
      await admin.setViewportSize({ width: 1280, height: 820 }).catch(() => {});

      await step(S, 'U1 左侧 rail 有「聊天」：点进 #/chat，原有入口不变；去设置再回来正常', async () => {
        const rail = await admin.$$eval('nav a[data-rail]', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
        assert.deepEqual(rail.map((r) => r[0]), ['小屋', '角色', '玩法', '设置', '聊天']);
        await admin.click('[data-rail="chat"]');
        await until(() => location.hash === '#/chat' && !!document.querySelector('[data-chat-page]'), null, 10000, 'chat page');
        assert.equal(await admin.getAttribute('[data-rail="chat"]', 'aria-current'), 'page');
        await until(() => !!document.querySelector('[data-model-select]') && !document.querySelector('[data-chat-page] .ant-spin, [data-chat-page] [class*="spin"][class*="spinning"]'), null, 15000, 'models');
        await shot('01-nav-chat-entry');
        const dom = () => admin.evaluate(() => ({
          hash: location.hash,
          rail: [...document.querySelectorAll('nav[aria-label="主导航"] a[data-rail]')].map((a) => ({ text: a.textContent.trim(), href: a.getAttribute('href'), current: a.getAttribute('aria-current') })),
          page: document.querySelector('[data-admin-page]')?.getAttribute('data-admin-page'),
          chatParts: { sessionList: !!document.querySelector('[data-session-list]'), messages: !!document.querySelector('[data-chat-scroll]'), input: !!document.querySelector('[data-chat-textarea]'), modelSelect: !!document.querySelector('[data-model-select]') },
        }));
        const snaps = { onChat: await dom() };
        // the other places still work, and 聊天 comes back intact
        await admin.click('[data-rail="settings"]');
        await until(() => location.hash === '#/settings' && !!document.querySelector('[data-admin-page="settings"]'), null, 10000, 'settings');
        await sleep(300);
        snaps.onSettings = await dom();
        await shot('01b-back-to-settings');
        await admin.click('[data-rail="home"]');
        await until(() => !!document.querySelector('[data-admin-page="overview"]'), null, 10000, 'overview');
        await admin.click('[data-rail="chat"]');
        await until(() => !!document.querySelector('[data-chat-page] [data-chat-textarea]'), null, 10000, 'chat again');
        snaps.chatAgain = await dom();
        fs.writeFileSync(path.join(SHOTS, 'u1-dom.json'), JSON.stringify(snaps, null, 2) + '\n');
        if (COPY) fs.copyFileSync(path.join(SHOTS, 'u1-dom.json'), path.join(COPY, 'u1-dom.json'));
        return note(`rail: ${rail.map((r) => `${r[0]}(${r[1]})`).join(' · ')}; 聊天 → #/chat lit; 设置 / 小屋 → back to 聊天 ok`);
      }, admin);

      let models = null;
      await step(S, 'U2 模型选择器：列表来自 chat.listModels，切换后选择器与 setModel 一致，选择被记住', async () => {
        models = await admin.evaluate(() => window.petAdmin.chat.listModels());
        assert.ok(models.models.length >= 3, `${models.models.length} models`);
        await admin.click('[data-model-select]');
        await until(() => document.querySelectorAll('[role="option"] [data-model-option]').length > 1, null, 8000, 'model options');
        const shown = await admin.$$eval('[role="option"] [data-model-option]', (els) => [...new Set(els.map((e) => e.getAttribute('data-model-option')))]);
        assert.deepEqual(new Set(shown), new Set(models.models.map((m) => m.key)));
        await sleep(400); // let the popup finish fading in
        await shot('02-model-picker-open');
        const target = models.models.find((m) => m.key === 'lobehub:claude-haiku-5-5') || models.models.find((m) => m.vision);
        await admin.click(`[role="option"] [data-model-option="${target.key}"]`);
        await until((k) => window.petAdmin.chat.listModels().then((r) => r.selected === k), target.key, 8000, 'selected saved');
        const label = await admin.$eval('[data-model-select]', (el) => el.innerText.trim());
        assert.ok(label.includes(target.label), `select shows ${label}`);
        return note(`${shown.length} options = listModels (${models.models.map((m) => `${m.label}${m.vision ? '[视觉]' : ''}`).join(', ')}); picked ${target.label} → select shows 「${label.replace(/\s+/g, ' ')}」, listModels().selected=${target.key}`);
      }, admin);

      await step(S, 'U3 Enter 发送 / Shift+Enter 换行；发送中按钮变「停止」，助手消息「正在生成」，Markdown 逐段流式渲染', async () => {
        await type('第一行');
        await admin.keyboard.press('Shift+Enter');
        await admin.keyboard.type('第二行');
        const value = await admin.$eval('[data-chat-textarea]', (t) => t.value);
        assert.equal(value, '第一行\n第二行', 'Shift+Enter is a newline, not a send');
        await admin.keyboard.press('Enter');
        await until(() => !!document.querySelector('[data-streaming]'), null, 8000, 'streaming bubble');
        assert.equal(await sendButton(), '停止');
        assert.equal(await admin.$eval('[data-chat-textarea]', (t) => t.value), '', 'the input empties on send');
        const samples = [];
        for (let i = 0; i < 40 && samples.length < 4; i++) {
          const t = await admin.evaluate(() => document.querySelector('[data-streaming]')?.innerText.replace(/正在生成.*/, '').trim() ?? null);
          if (t && t !== samples[samples.length - 1]) samples.push(t);
          if (samples.length === 2) await shot('03-streaming-midway');
          await sleep(150);
        }
        assert.ok(samples.length >= 3, `streamed in steps: ${JSON.stringify(samples)}`);
        for (let i = 1; i < samples.length; i++) assert.ok(samples[i].length >= samples[i - 1].length, 'text grows');
        await waitIdle();
        assert.equal(await sendButton(), '发送');
        const md = await admin.evaluate(() => { const last = [...document.querySelectorAll('[data-role="assistant"]')].pop(); return { strong: last.querySelector('strong')?.textContent, li: last.querySelectorAll('li').length, code: !!last.querySelector('pre, code') }; });
        assert.equal(md.strong, '加粗');
        assert.equal(md.li, 2);
        assert.ok(md.code);
        const b = await bubbles();
        assert.deepEqual(b.map((x) => x.role), ['user', 'assistant']);
        assert.ok(b[0].text.includes('第一行\n第二行'), b[0].text);
        await shot('04-streamed-markdown');
        return note(`Shift+Enter → 「第一行⏎第二行」 stayed; Enter sent; button 发送→停止→发送; ${samples.length} growing samples: ${samples.map((s) => `「${s.replace(/\n/g, '⏎').slice(0, 30)}」`).join(' → ')}; markdown: <strong>${md.strong}</strong>, ${md.li} <li>, code block`);
      }, admin);

      await step(S, 'U4 多轮上下文：第二问能用上第一问的内容，消息按顺序保留', async () => {
        await type('记住：我叫小明。');
        await admin.keyboard.press('Enter');
        await sleep(300);
        await waitIdle();
        await type('我叫什么？');
        await admin.keyboard.press('Enter');
        await sleep(300);
        await waitIdle();
        const b = await bubbles();
        assert.deepEqual(b.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
        assert.match(b[5].text, /你叫小明/);
        const req = srv.requests[srv.requests.length - 1].body.input[0].content[0].text;
        assert.ok(req.indexOf('我叫小明') >= 0 && req.indexOf('我叫小明') < req.lastIndexOf('我叫什么'), 'history goes with the turn');
        return note(`6 bubbles in order (user/assistant ×3); last answer 「${b[5].text}」; request carried the earlier turns`);
      }, admin);

      await step(S, 'U5 图片：文件选择 + 粘贴 + 拖入 → 输入区缩略图，可移除；发送后在用户消息里显示', async () => {
        await page.evaluate((p) => window.pet.debugNextOpen(p), red);
        await admin.click('[data-pick-images]');
        await until(() => document.querySelectorAll('[data-pending-image]').length === 1, null, 8000, 'picked thumb');
        // paste a picture into the text box
        await admin.evaluate((b64) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bin], 'pasted-blue.png', { type: 'image/png' }));
          document.querySelector('[data-chat-textarea]').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        }, blue);
        await until(() => document.querySelectorAll('[data-pending-image]').length === 2, null, 8000, 'pasted thumb');
        // drop one more onto the chat
        await admin.evaluate((b64) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bin], 'dropped-blue.png', { type: 'image/png' }));
          const target = document.querySelector('[data-chat-input]');
          for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }, blue);
        await until(() => document.querySelectorAll('[data-pending-image]').length === 3, null, 8000, 'dropped thumb');
        const names = await admin.$$eval('[data-pending-image]', (els) => els.map((e) => e.getAttribute('data-pending-image')));
        await shot('05-input-thumbnails');
        // remove the two blue ones
        for (const n of ['pasted-blue.png', 'dropped-blue.png']) await admin.click(`[data-pending-image="${n}"] [data-remove-image]`);
        await until(() => document.querySelectorAll('[data-pending-image]').length === 1, null, 5000, 'removed');
        await type('这张图片是什么颜色？');
        await admin.keyboard.press('Enter');
        await sleep(300);
        await waitIdle();
        assert.equal(await admin.evaluate(() => document.querySelectorAll('[data-pending-image]').length), 0, 'the input card is empty after sending');
        const b = await bubbles();
        const user = b[b.length - 2];
        assert.equal(user.role, 'user');
        assert.ok(user.images >= 1, JSON.stringify(user));
        assert.match(b[b.length - 1].text, /红色/);
        const req = srv.requests[srv.requests.length - 1].body;
        assert.equal(req.input[0].content.filter((x) => x.type === 'input_image').length, 1);
        await shot('06-image-in-message');
        return note(`thumbs after pick + paste + drop: ${names.join(', ')}; removed 2 → 1 left; sent; user bubble shows ${user.images} picture; answer 「${b[b.length - 1].text}」; request had 1 input_image`);
      }, admin);

      await step(S, 'U6 点击消息里的图片放大预览（@lobehub/ui Image preview）', async () => {
        const before = await admin.evaluate(() => document.querySelectorAll('img').length);
        await admin.click('[data-role="user"] [data-message-images] img');
        await until(() => [...document.querySelectorAll('img')].some((i) => { const r = i.getBoundingClientRect(); return r.width >= 300 && i.src.startsWith('data:image/png'); }), null, 8000, 'zoomed preview');
        await sleep(500);
        const big = await admin.evaluate(() => [...document.querySelectorAll('img')].map((i) => i.getBoundingClientRect()).filter((r) => r.width >= 300).map((r) => `${Math.round(r.width)}×${Math.round(r.height)}`));
        await shot('07-image-preview-zoomed');
        await admin.keyboard.press('Escape');
        await until(() => ![...document.querySelectorAll('img')].some((i) => i.getBoundingClientRect().width >= 300), null, 5000, 'preview closed');
        return note(`thumb 128×128 → preview image ${big.join(', ')} (img count ${before} → +viewer); Esc closes`);
      }, admin);

      await step(S, 'U7 选了不支持视觉的模型：带图时输入区给出提示，不发送；换回视觉模型可发', async () => {
        const plain = models.models.find((m) => !m.vision);
        await admin.click('[data-model-select]');
        await until(() => document.querySelectorAll('[role="option"] [data-model-option]').length > 1, null, 8000, 'options');
        await admin.click(`[role="option"] [data-model-option="${plain.key}"]`);
        await until((k) => window.petAdmin.chat.listModels().then((r) => r.selected === k), plain.key, 8000, 'plain selected');
        await page.evaluate((p) => window.pet.debugNextOpen(p), red);
        await admin.click('[data-pick-images]');
        await until(() => !!document.querySelector('[data-vision-warning]'), null, 8000, 'vision warning');
        const warn = await admin.$eval('[data-vision-warning]', (e) => e.innerText.trim());
        const n0 = srv.requests.length;
        await type('看看这张');
        await admin.keyboard.press('Enter');
        await sleep(600);
        assert.equal(srv.requests.length, n0, 'nothing was sent');
        await shot('08-vision-warning');
        await admin.click('[data-pending-image] [data-remove-image]');
        await admin.fill('[data-chat-textarea]', '');
        const vision = models.models.find((m) => m.vision);
        await admin.click('[data-model-select]');
        await until(() => document.querySelectorAll('[role="option"] [data-model-option]').length > 1, null, 8000, 'options');
        await admin.click(`[role="option"] [data-model-option="${vision.key}"]`);
        await until((k) => window.petAdmin.chat.listModels().then((r) => r.selected === k), vision.key, 8000, 'vision selected');
        return note(`${plain.label} (no vision) + picture → 「${warn}」, Enter sent nothing; back to ${vision.label}`);
      }, admin);

      await step(S, 'U8 停止生成：回复中途点「停止」，已生成的部分保留并标「已停止」', async () => {
        mode = 'slow';
        await type('慢慢说一段话');
        await admin.keyboard.press('Enter');
        await until(() => (document.querySelector('[data-streaming]')?.innerText || '').includes('会被'), null, 10000, 'some text');
        await shot('09-before-stop');
        await admin.click('[data-chat-input] button:has-text("停止")');
        await until(() => !document.querySelector('[data-streaming]') && !!document.querySelector('[data-role="assistant"][data-status="aborted"]'), null, 10000, 'aborted');
        mode = null;
        const t = await admin.$eval('[data-role="assistant"][data-status="aborted"]', (e) => e.innerText.trim());
        assert.ok(t.includes('这一段') && t.includes('已停止') && !t.includes('不会出现'), t);
        return note(`stopped mid-way: 「${t.replace(/\s+/g, ' ')}」`);
      }, admin);

      await step(S, 'U9 出错有可见提示，点「重试」重新发送这一轮', async () => {
        mode = 'fail';
        await type('这次会出错');
        await admin.keyboard.press('Enter');
        await until(() => !!document.querySelector('[data-role="assistant"][data-status="error"]'), null, 15000, 'error bubble');
        const err = await admin.$eval('[data-role="assistant"][data-status="error"]', (e) => e.innerText.trim());
        await shot('10-error-retry');
        mode = null;
        await admin.click('[data-retry]');
        await sleep(300);
        await waitIdle();
        const b = await bubbles();
        assert.equal(b[b.length - 1].role, 'assistant');
        assert.equal(b[b.length - 1].status, 'done');
        assert.equal(b[b.length - 2].text, '这次会出错');
        return note(`error shown: 「${err.replace(/\s+/g, ' ').slice(0, 120)}」; 重试 → the same words sent again → reply done`);
      }, admin);

      await step(S, 'U10 消息区可滚动：新消息自动到底；回复中上翻不被拉回，「回到最新消息」可回到底部', async () => {
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
          assert.ok(await admin.$('[data-to-bottom]'));
          await shot('11-scrolled-up-while-streaming');
          await admin.click('[data-to-bottom]');
          await sleep(800);
          const off = await admin.$eval('[data-chat-scroll]', (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
          assert.ok(off < 64, `back at the bottom (${off})`);
          await sleep(900);
          const still = await admin.$eval('[data-chat-scroll]', (el) => el.scrollHeight - el.scrollTop - el.clientHeight);
          assert.ok(still < 64, `follows the reply again (${still})`);
          await waitIdle();
          return note(`while streaming: ${pinned}px from the bottom; scrolled to top → after 1.2 s scrollTop=${top} (not forced back), 回到最新消息 shown; clicked → ${off}px from the bottom, and keeps following (${still}px)`);
        } finally {
          await waitIdle().catch(() => {});
          mode = null;
        }
      }, admin);

      let first = null;
      let second = null;
      await step(S, 'U11 会话：新建、切换（历史与图片回来）、清空、删除', async () => {
        first = await admin.evaluate(() => localStorage.getItem('pixelpet.adminChat.session'));
        const n1 = (await bubbles()).length;
        await admin.click('[data-new-session]');
        await until((f) => { const s = localStorage.getItem('pixelpet.adminChat.session'); return s && s !== f; }, first, 8000, 'new session');
        second = await admin.evaluate(() => localStorage.getItem('pixelpet.adminChat.session'));
        await until(() => document.querySelectorAll('[data-chat-page] [data-role]').length === 0 && !!document.querySelector('[data-chat-page] [data-chat-textarea]'), null, 8000, 'empty new session');
        await type('你好');
        await admin.keyboard.press('Enter');
        await sleep(300);
        await waitIdle();
        await until(() => document.querySelectorAll('[data-session]').length === 2, null, 8000, 'two sessions');
        const titles = await admin.$$eval('[data-session]', (els) => els.map((e) => e.innerText.split('\n')[0]));
        await shot('12-session-list');
        await admin.click(`[data-session="${first}"]`);
        await until((n) => document.querySelectorAll('[data-chat-page] [data-role]').length === n, n1, 8000, 'first session back');
        const imgs = await admin.evaluate(() => document.querySelectorAll('[data-message-images] img').length);
        assert.ok(imgs >= 1, 'pictures come back');
        await admin.click(`[data-session="${second}"]`);
        await until(() => document.querySelectorAll('[data-chat-page] [data-role]').length === 2, null, 8000, 'second session');
        // clear the second one
        await admin.click('[data-clear-session]');
        await admin.getByRole('dialog').getByRole('button', { name: '清空消息' }).click();
        await until(() => document.querySelectorAll('[data-chat-page] [data-role]').length === 0, null, 8000, 'cleared');
        // 新建 on an empty session just focuses the input (no pile of empty sessions); write in it, then delete it
        await admin.click('[data-new-session]');
        assert.equal(await admin.evaluate(() => localStorage.getItem('pixelpet.adminChat.session')), second, 'the empty session is reused');
        await type('临时会话');
        await admin.keyboard.press('Enter');
        await sleep(300);
        await waitIdle();
        const third = await admin.evaluate(() => localStorage.getItem('pixelpet.adminChat.session'));
        await until(() => document.querySelectorAll('[data-session]').length >= 2, null, 8000, 'sessions');
        const before = await admin.$$eval('[data-session]', (els) => els.length);
        await admin.hover(`[data-session="${third}"]`);
        await admin.click(`[data-session="${third}"] [data-session-delete]`);
        await admin.getByRole('dialog').getByRole('button', { name: '删除会话' }).click();
        await until((t) => !document.querySelector(`[data-session="${t}"]`), third, 8000, 'deleted');
        const after = await admin.$$eval('[data-session]', (els) => els.length);
        const left = (await admin.evaluate(() => window.petAdmin.chat.listSessions())).sessions.map((s) => s.id);
        assert.ok(!left.includes(third));
        return note(`new session → empty; list 「${titles.join('」「')}」; switch back → ${n1} messages + ${imgs} picture(s); clear → 0 messages (session kept); 新建 on the empty session reuses it; written in, then deleted from the list (${before} → ${after} rows; main no longer has it)`);
      }, admin);

      await step(S, 'U11b 回复进行中切到别的页面再回来：流式接着显示，结束后消息完整', async () => {
        mode = 'slow';
        try {
          await type('慢慢说，我去别的页面看看');
          await admin.keyboard.press('Enter');
          await until(() => (document.querySelector('[data-streaming]')?.innerText || '').includes('会被'), null, 10000, 'streaming');
          await admin.click('[data-rail="settings"]');
          await until(() => !!document.querySelector('[data-admin-page="settings"]'), null, 8000, 'settings');
          await sleep(700);
          await admin.click('[data-rail="chat"]');
          await until(() => !!document.querySelector('[data-streaming]'), null, 8000, 'still streaming after coming back');
          const busy = await sendButton();
          await shot('14-back-while-streaming');
          await waitIdle();
          const last = (await bubbles()).pop();
          assert.equal(last.status, 'done');
          assert.ok(last.text.includes('不会出现。'), last.text);
          return note(`left for 设置 mid-reply, came back: the reply was still streaming (button 「${busy}」), then finished: 「${last.text.replace(/\s+/g, ' ').slice(0, 60)}」`);
        } finally {
          mode = null;
        }
      }, admin);

      await step(S, 'U12 刷新窗口（重新加载）后：会话列表、历史消息与图片、所选模型都在，可继续对话', async () => {
        await admin.click(`[data-session="${first}"]`);
        await until((n) => document.querySelectorAll('[data-chat-page] [data-role]').length >= n, 10, 8000, 'first session');
        const before = await bubbles();
        const sel = await admin.$eval('[data-model-select]', (el) => el.innerText.trim());
        await admin.reload();
        await admin.waitForSelector('[data-chat-page] [data-chat-textarea]', { timeout: 20000 });
        await until((n) => document.querySelectorAll('[data-chat-page] [data-role]').length === n, before.length, 10000, 'history back');
        const after = await bubbles();
        assert.deepEqual(after.map((b) => [b.role, b.status, b.images]), before.map((b) => [b.role, b.status, b.images]));
        await until((s) => (document.querySelector('[data-model-select]')?.innerText || '').trim() === s, sel, 10000, 'model kept');
        const rows = await admin.$$eval('[data-session]', (els) => els.length);
        await shot('13-after-reload');
        await type('我叫什么？');
        await admin.keyboard.press('Enter');
        await sleep(300);
        await waitIdle();
        const last = (await bubbles()).pop();
        assert.match(last.text, /你叫小明/);
        return note(`reload (#/chat): ${rows} sessions, ${after.length} messages identical (roles / statuses / pictures), model 「${sel.replace(/\s+/g, ' ')}」 kept; next turn still has context → 「${last.text}」`);
      }, admin);

      await step(S, 'U13 设置窗口无报错（页面异常 / 控制台错误）', async () => {
        const real = errors.filter((e) => !/ResizeObserver loop/.test(e));
        assert.deepEqual(real, []);
        return note('pageerror 0, console.error 0');
      });
    } finally {
      fs.writeFileSync(path.join(SHOTS, `${S}-log.txt`), evidence.join('\n\n') + '\n');
      await app.close().catch(() => {});
      await srv.close();
    }
  };
};
