'use strict';

// 设置窗口 → 聊天 end-to-end acceptance (run.js `admin-chat`): `xvfb-run -a node e2e/run.js admin-chat`.
// Part 1 (no tokens): the whole chat-page walk of e2e/chat-ui.js under the name `admin-chat` — one conversation per
//   character, shared with the desktop, against a fake lh + a fake Responses SSE server that keeps topic history.
// Part 2 (real LobeHub, a few tokens): a real companion (小克, claude) is met through the pet window, then talked to
//   from the chat page: her model picked in the selector, two real streamed replies (the second recalls the first
//   through her own topic), a picture she describes, her agent's model read back from LobeHub (`lh agent view`),
//   and the rounds found in the desktop's 聊天记录. Her agent is deleted afterwards. PIXELPET_ADMINCHAT_LIVE=0 leaves
//   part 2 out.
// Evidence: out/e2e/admin-chat/ (part 1) and out/e2e/admin-chat-live/ (part 2).

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

module.exports = function adminChatAcceptance(ctx) {
  const { OUT, step, launch, openAdminWindow, say } = ctx;

  async function live() {
    const S = 'admin-chat-live';
    const SHOTS = path.join(OUT, S);
    fs.mkdirSync(SHOTS, { recursive: true });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${S}-`));
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1', PIXELPET_DIRECT: '1' };
    const red = path.join(data, 'red.png');
    fs.writeFileSync(red, png(320, 200, [230, 40, 40]));
    const evidence = [];
    const note = (s) => { evidence.push(s); return s.length > 400 ? `${s.slice(0, 397)}…` : s; };
    const { app, page } = await launch(env);
    let admin = null;
    let agentId = null;
    let ws = null;
    const lhEnv = () => { const e = { ...process.env }; delete e.LOBEHUB_WORKSPACE_ID; delete e.LOBEHUB_TOPIC_ID; delete e.LOBEHUB_OPERATION_ID; delete e.LOBEHUB_AGENT_ID; if (ws) e.LOBEHUB_WORKSPACE_ID = ws; return e; };
    const shot = async (name) => { await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
    const until = async (fn, arg, ms = 15000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        if (await admin.evaluate(fn, arg).catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(150);
      }
    };
    const bubbles = () => admin.evaluate(() => [...document.querySelectorAll('[data-chat-page] [data-role]')].map((el) => ({ role: el.dataset.role, status: el.dataset.status || '', text: (el.querySelector('.lobe-markdown, [class*="markdown"]') || el).innerText.trim(), images: el.querySelectorAll('[data-message-images] img').length })));
    const sendButton = () => admin.evaluate(() => { const b = [...document.querySelectorAll('[data-chat-input] button')].pop(); return b ? b.innerText.trim() : null; });
    const send = async (text) => { await admin.click('[data-chat-textarea]'); await admin.keyboard.type(text); await admin.keyboard.press('Enter'); };
    const waitIdle = () => until(() => !document.querySelector('[data-streaming]'), null, 150000, 'real reply done');
    const pet = () => JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
    let picked = null;
    try {
      await page.waitForSelector('.char-card', { timeout: 30000 });
      await step(S, 'L0 真实 LobeHub：在桌宠里和小克（claude）初次见面，她有了自己的 agent', async () => {
        await page.click('.char-card[data-species="claude"]');
        if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt'); // never bind a real computer in tests
        await page.fill('#pet-name', '小克');
        await page.click('#hatch-btn');
        const where = await Promise.race([
          page.waitForSelector('#space-box:not(.hidden)', { timeout: 120000 }).then(() => 'asked'),
          page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 }).then(() => 'not asked'),
        ]);
        if (where === 'asked') await page.click('#space-go');
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 });
        await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 150000 }).catch(() => {});
        const p = pet();
        agentId = p.characters.claude.agentId;
        ws = p.space && p.space.workspaceId ? p.space.workspaceId : null;
        assert.match(agentId, /^agt_/);
        return note(`met 小克: her agent ${agentId} (${ws ? 'workspace' : 'personal space'}), topic ${p.characters.claude.topicId || '(none yet)'}`);
      }, page);

      admin = await openAdminWindow(app, page, 'chat/claude');
      await admin.setViewportSize({ width: 1280, height: 820 }).catch(() => {});

      await step(S, 'L1 聊天页打开小克的对话；模型选择器列出真实账号里她所属厂商的模型，选定一个', async () => {
        await until(() => !!document.querySelector('[data-chat-page] [data-chat-textarea]') && /小克/.test(document.querySelector('[data-chat-title]')?.innerText || ''), null, 30000, 'her chat');
        await until(() => window.petAdmin.state().then((s) => !!s.roster.find((c) => c.id === 'claude')?.model?.loaded), null, 60000, 'model list');
        const m = (await admin.evaluate(() => window.petAdmin.state())).roster.find((c) => c.id === 'claude').model;
        assert.ok(m.options.length > 0, 'no Claude model on the real account');
        picked = m.options.find((o) => o.id === 'claude-haiku-5-5') || m.options.find((o) => o.vision) || m.options[0];
        await admin.click('[data-model-select]');
        await until(() => document.querySelectorAll('[role="option"] [data-model-option]').length > 0, null, 10000, 'options');
        await sleep(400);
        await shot('L1-real-model-picker');
        if (picked.key !== m.current) {
          await admin.click(`[role="option"] [data-model-option="${picked.key}"]`);
          await until((k) => window.petAdmin.state().then((s) => s.roster.find((c) => c.id === 'claude').model.current === k), picked.key, 10000, 'picked');
        } else await admin.click('[data-model-select]');
        const label = (await admin.$eval('[data-model-select]', (el) => el.innerText.trim())).replace(/\s+/g, ' ');
        assert.ok(label.includes(picked.label), label);
        return note(`real account: ${m.options.length} Claude models (${m.options.map((o) => o.key).join(', ')}); picked ${picked.key} → selector 「${label}」`);
      }, admin);

      await step(S, 'L2 真实流式回复：发送中显示「停止」与生成中气泡，回复完成后恢复「发送」', async () => {
        await send('请记住：我的暗号是「青柠42」。用一句话确认，并在句中复述暗号。');
        await until(() => !!document.querySelector('[data-streaming]'), null, 30000, 'streaming');
        const busy = await sendButton();
        assert.equal(busy, '停止');
        await shot('L2-real-sending');
        const samples = [];
        for (let i = 0; i < 1500; i++) {
          const t = await admin.evaluate(() => document.querySelector('[data-streaming]')?.innerText.replace(/正在回复.*/, '').trim() ?? null);
          if (t === null) break;
          if (t && t !== samples[samples.length - 1]) samples.push(t);
          if (samples.length === 2) await shot('L2-real-streaming-midway');
          await sleep(100);
        }
        await waitIdle();
        assert.equal(await sendButton(), '发送');
        const b = await bubbles();
        const last = b[b.length - 1];
        assert.equal(last.role, 'assistant');
        assert.notEqual(last.status, 'error', last.text);
        assert.match(last.text, /青柠\s*42/);
        await shot('L2-real-reply');
        return note(`button while sending 「${busy}」; ${samples.length} streamed states; real reply 「${last.text.replace(/\s+/g, ' ').slice(0, 160)}」`);
      }, admin);

      await step(S, 'L3 真实多轮上下文：第二轮问暗号，她从自己的话题里答出「青柠42」', async () => {
        await send('我刚才告诉你的暗号是什么？只回答暗号本身。');
        await until(() => !!document.querySelector('[data-streaming]'), null, 30000, 'streaming');
        await waitIdle();
        const b = await bubbles();
        assert.match(b[b.length - 1].text, /青柠\s*42/);
        await shot('L3-real-multiturn');
        return note(`turn 2 answer 「${b[b.length - 1].text.replace(/\s+/g, ' ').slice(0, 120)}」`);
      }, admin);

      await step(S, 'L4 真实看图：选一张红色图片发给她，她答出颜色；图片留在对话里', async () => {
        await page.evaluate((p) => window.pet.debugNextOpen(p), red);
        await admin.click('[data-pick-images]');
        await until(() => document.querySelectorAll('[data-pending-image]').length === 1, null, 10000, 'thumb');
        await send('这张图片主要是什么颜色？只回答颜色。');
        await until(() => !!document.querySelector('[data-streaming]'), null, 60000, 'streaming');
        await waitIdle();
        const b = await bubbles();
        assert.ok(b[b.length - 2].images >= 1);
        assert.match(b[b.length - 1].text, /红/);
        await shot('L4-real-image');
        return note(`picture in the message (${b[b.length - 2].images}); real answer 「${b[b.length - 1].text.replace(/\s+/g, ' ').slice(0, 80)}」`);
      }, admin);

      await step(S, 'L5 她的 agent 在 LobeHub 上用的就是选定的模型；这几轮也在桌面的聊天记录里', async () => {
        const raw = execFileSync('lh', ['agent', 'view', agentId, '--json'], { encoding: 'utf8', timeout: 60000, env: lhEnv() });
        const j = JSON.parse(raw);
        const a = j.data || j.agent || j;
        const model = a.model || a.config?.model;
        const provider = a.provider || a.config?.provider;
        fs.writeFileSync(path.join(SHOTS, 'L5-lh-agent-view.json'), JSON.stringify({ id: agentId, title: a.title, model, provider }, null, 2) + '\n');
        assert.equal(`${provider}:${model}`, picked.key, 'her agent on LobeHub runs the picked model');
        const list = await page.evaluate(() => window.pet.historyList());
        const s = list.sessions.find((x) => x.speciesId === 'claude');
        const full = await page.evaluate((id) => window.pet.historyGet(id), s.id);
        const texts = full.session.messages.map((m) => m.text).join('\n');
        assert.match(texts, /青柠42/);
        return note(`lh agent view ${agentId} → model=${model} provider=${provider} (= selector); desktop 聊天记录 has the conversation (${full.session.messages.length} messages)`);
      }, admin);
    } finally {
      fs.writeFileSync(path.join(SHOTS, `${S}-log.txt`), evidence.join('\n\n') + '\n');
      await app.close().catch(() => {});
      if (agentId) {
        try { execFileSync('lh', ['agent', 'delete', agentId, '--yes'], { stdio: 'ignore', timeout: 60000, env: lhEnv() }); say(`(deleted the live agent ${agentId})`); } catch (e) { say(`(could not delete the live agent ${agentId}: ${e.message})`); }
      }
    }
  }

  return async function adminChat() {
    if (process.env.ELECTRON_RUN_AS_NODE) {
      delete process.env.ELECTRON_RUN_AS_NODE; // Electron would start as plain node and Playwright could not attach
      say('(admin-chat: ELECTRON_RUN_AS_NODE was set in the shell; unset for the Electron launches)');
    }
    await require('./chat-ui')(ctx, { name: 'admin-chat' })();
    if (process.env.PIXELPET_ADMINCHAT_LIVE === '0') return say('(admin-chat: PIXELPET_ADMINCHAT_LIVE=0, real-LobeHub part left out)');
    await live();
  };
};
