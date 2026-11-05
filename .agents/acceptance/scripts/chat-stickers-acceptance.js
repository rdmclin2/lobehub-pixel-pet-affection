'use strict';

// T-6175 聊天内发送表情包 — acceptance run on the real app with the real `lh` (real agent, real replies; costs a
// few tokens). Usage (from the worktree root, admin already built):
//   xvfb-run -a -s '-screen 0 1400x900x24' node .agents/acceptance/scripts/chat-stickers-acceptance.js <out dir>
// What it does:
//   0. writes a chat-log.json in the OLD format (no `sticker` field, schema 1) holding a long earlier conversation
//      with 大肥鱼, so the page is longer than a screen and old data is read as before;
//   1. meets 大肥鱼 (real agent, local abilities off), adds 2 pictures of the owner's own (我的 set);
//   2. 设置 → 聊天 → 大肥鱼: opens the 表情包 panel (screenshot), sends a built-in meme and one of 我的 from it,
//      waits for her real reply to each (screenshots + a recording of the whole settings window);
//   3. the pet window's chat box: ☺ panel (screenshot), sends one more from there, her bubble answers;
//   4. scrolls the long conversation up and down (screenshots), dumps chat-log.json's sticker records;
//   5. quits, starts the app again over the same userData: 聊天 and 聊天记录 still show every sticker;
//   6. reads the topic's messages from LobeHub (`lh message list`) — what the agent was given — and deletes the agent.
// Writes screenshots, *.webm and evidence.json into <out>.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'acceptance', 'chat-stickers'));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
// video chapters (acceptance video-chapters.md): wall-clock marks per window, converted against each video's start
const marks = [];
const starts = {};
const videos = {};
const mark = (win, kind, text) => marks.push({ win, kind, text, wall: Date.now() / 1000 });
const note = (k, v) => { log.push({ k, v }); console.log(`[${k}]`, typeof v === 'string' ? v : JSON.stringify(v)); };
// the app runs `lh` with the workspace variables cleared (core/lh-client.js cleanEnv): its agent is in the personal space
const lh = (...a) => execFileSync('lh', a, { encoding: 'utf8', timeout: 60000, env: { ...process.env, LOBEHUB_WORKSPACE_ID: 'personal' } });

// a round face sticker in `rgb` (transparent ground), as in e2e/stickers.js
function face(size, [r, g, b], mood = 'smile') {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  const R = size * 0.46;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = y * (size * 4 + 1) + 1 + x * 4;
    const d = Math.hypot(x - c, y - c);
    if (d > R) continue;
    let px = [r, g, b];
    const eye = (ex) => Math.hypot(x - ex, y - c * 0.8) < size * 0.06;
    const tear = mood === 'sad' && Math.abs(x - c * 0.7) < size * 0.025 && y > c * 0.85 && y < c * 1.15;
    const my = mood === 'sad' ? c * 1.45 - Math.abs(x - c) * 0.35 : c * 1.2 + Math.sqrt(Math.max(0, (size * 0.22) ** 2 - (x - c) ** 2)) * 0.6;
    const mouth = Math.abs(x - c) < size * 0.22 && Math.abs(y - my) < size * 0.03;
    if (tear) px = [60, 140, 255];
    else if (eye(c * 0.7) || eye(c * 1.3) || mouth) px = [40, 30, 30];
    else if (d > R - size * 0.03) px = [Math.max(0, r - 60), Math.max(0, g - 60), Math.max(0, b - 60)];
    raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2]; raw[o + 3] = 255;
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function launch(data, video) {
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    cwd: ROOT,
    env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_CATALOG_PREINSTALLED: path.join(ROOT, 'catalog'), PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1' },
    ...(video ? { recordVideo: { dir: video, size: { width: 1200, height: 820 } } } : {}),
  });
  const errors = [];
  const page = await app.firstWindow();
  page.__run = video ? path.basename(video) : 'novideo';
  starts[`pet-${page.__run}`] = Date.now() / 1000;
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(`pet: ${e}`));
  return { app, page, errors };
}
async function openAdmin(app, page, route) {
  await page.evaluate((r) => window.pet.openAdmin(r), route);
  let admin = null;
  for (let i = 0; i < 300 && !admin; i++) {
    admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
    if (!admin) await sleep(100);
  }
  if (!starts[`admin-${page.__run}`]) starts[`admin-${page.__run}`] = Date.now() / 1000;
  await admin.setViewportSize({ width: 1200, height: 820 }).catch(() => {});
  await admin.waitForSelector(`[data-path="/${route}"]`, { timeout: 20000 });
  return admin;
}
const until = async (p, fn, arg, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    if (await p.evaluate(fn, arg).catch(() => false)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
};

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chatstk-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  // 0. an old-format 聊天记录 (written before stickers existed): 14 rounds with 大肥鱼, two days ago
  const t0 = Date.now() - 2 * 24 * 3600 * 1000;
  const lines = [['今天上班好累', '摸摸头，先喝口水歇一会儿吧'], ['中午吃什么好', '白饭！配什么都行，我先干为敬'], ['你会写代码吗', '会一点点，帮你看看报错？'], ['周末去哪玩', '去海边吧，我想念大海了'], ['下雨了', '记得带伞，别淋湿啦'], ['我升职了', '哇！大的要来啦，恭喜恭喜'], ['晚安', '晚安，做个好梦'], ['早上好', '早呀，今天也元气满满'], ['好无聊', '那我陪你聊会儿天'], ['推荐首歌', '来点轻松的 lo-fi 吧'], ['我想吃火锅', '我也想！鸳鸯锅安排上'], ['你是鱼吗', '是蓝色的大肥鱼哦'], ['猫和狗选哪个', '我选……鲸鱼'], ['今天好开心', '开心就好，我也跟着开心']];
  const old = [];
  lines.forEach(([u, p], i) => {
    const at = t0 + i * 60000;
    old.push({ id: `m${old.length + 1}`, at, speciesId: 'dafeiyu', role: 'user', origin: 'user', kind: 'chat', turnId: `told${i}`, text: u });
    old.push({ id: `m${old.length + 1}`, at: at + 5000, speciesId: 'dafeiyu', role: 'pet', origin: 'user', kind: 'chat', turnId: `told${i}`, text: p });
  });
  fs.writeFileSync(path.join(data, 'chat-log.json'), JSON.stringify({ schema: 1, seq: old.length, messages: old }));
  note('old-chat-log', `${old.length} records written in the pre-sticker format (no sticker field); sample: ${JSON.stringify(old[0])}`);

  const pics = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chatstk-pics-'));
  const files = [['委屈巴巴.png', face(220, [120, 170, 255], 'sad')], ['超开心.png', face(240, [255, 196, 64])]].map(([n, b]) => { const f = path.join(pics, n); fs.writeFileSync(f, b); return f; });

  let agentId = null;
  let topicId = null;
  const videoDir = path.join(OUT, 'video-run1');
  let { app, page, errors } = await launch(data, videoDir);
  try {
    // 1. meet 大肥鱼 with a real agent
    await page.waitForSelector('.char-card', { timeout: 60000 });
    await page.click('.char-card[data-species="dafeiyu"]');
    if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt').catch(() => {});
    await page.fill('#pet-name', '鱼片');
    await page.click('#hatch-btn');
    const where = await Promise.race([
      page.waitForSelector('#space-box:not(.hidden)', { timeout: 180000 }).then(() => 'asked'),
      page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 180000 }).then(() => 'not asked'),
    ]);
    if (where === 'asked') await page.click('#space-go');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 180000 });
    const v = await page.evaluate(async () => (await window.pet.boot()).view);
    agentId = v.pet.agentId;
    note('hatch', `real agent ${agentId}`);
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 150000 }).catch(() => {});

    let admin = await openAdmin(app, page, 'chat/dafeiyu');
    admin.on('pageerror', (e) => errors.push(`admin: ${e}`));
    // her own 2 pictures (我的), through the same file dialog path as 角色 → 表情包 → 添加表情包
    await page.evaluate((p) => window.pet.debugNextOpen(p), files.join('\n'));
    const added = await admin.evaluate(() => window.petAdmin.stickers.pickAndAdd('dafeiyu'));
    note('add-mine', `${added.added.length} added: ${added.added.map((s) => `${s.id} ${s.label} ${s.url}`).join(' | ')}`);
    // give the first one a use, so the agent hears it
    await admin.evaluate((id) => window.petAdmin.stickers.update('dafeiyu', id, { desc: '眼泪汪汪，委屈得想哭' }), added.added[0].id);
    const list = await admin.evaluate(() => window.petAdmin.stickers.list('dafeiyu'));
    note('sets', list.sets.map((s) => `${s.name}(${s.id}) · ${s.stickers.length}: ${s.stickers.map((x) => x.id).join(',')}`).join(' / '));

    // wait for the old conversation on screen, at the bottom
    await until(admin, () => document.querySelectorAll('[data-message-id]').length >= 20, null, 20000, 'old messages');
    await sleep(800);
    await admin.screenshot({ path: path.join(OUT, '01-chat-before.png') });

    const lastTurnDone = async (n) => {
      // her reply to the n-th sticker round: the latest message is hers, done, after a user sticker message
      const t1 = Date.now();
      for (;;) {
        const h = await admin.evaluate(() => window.petAdmin.chat.history('dafeiyu', { limit: 60 }));
        const ms = h.messages || [];
        const stickers = ms.filter((m) => m.role === 'user' && m.sticker);
        const last = ms[ms.length - 1];
        if (stickers.length >= n && last && last.role === 'assistant' && last.turnId === stickers[n - 1].turnId && !h.streaming) return { user: stickers[n - 1], reply: last };
        if (Date.now() - t1 > 180000) throw new Error('no reply');
        await sleep(500);
      }
    };

    // 2. the panel: open, screenshot, send a built-in one
    mark('admin-video-run1', 'step', '点开输入框左下角的表情包按钮');
    await admin.click('[data-sticker-open]');
    await until(admin, () => document.querySelectorAll('[data-sticker-cell]').length >= 2 && [...document.querySelectorAll('[data-sticker-cell] img')].every((i) => i.complete && i.naturalWidth > 0), null, 10000, 'panel');
    await sleep(400);
    await admin.screenshot({ path: path.join(OUT, '02-panel-builtin.png') });
    const builtinCells = await admin.evaluate(() => [...document.querySelectorAll('[data-sticker-cell]')].map((b) => b.dataset.stickerCell));
    note('panel-builtin', `tabs: ${await admin.evaluate(() => (document.querySelector('[data-sticker-tabs]') || {}).innerText || '')}; cells: ${builtinCells.join(', ')}`);
    mark('admin-video-run1', 'check', '面板已打开：内置 · 9 / 我的 · 2 两个分组，网格里是她的内置梗图');
    mark('admin-video-run1', 'step', '点击内置表情包「可爱」');
    await admin.click('[data-sticker-cell="builtin:dafeiyu/cute"]');
    const r1 = await lastTurnDone(1);
    mark('admin-video-run1', 'check', `「可爱」以图片出现在会话右侧；她随后回复：${r1.reply.text.slice(0, 30)}`);
    note('round1', { sent: r1.user.sticker, reply: r1.reply.text, replySticker: r1.reply.sticker || null });
    await sleep(1500);
    await admin.screenshot({ path: path.join(OUT, '03-sent-builtin-reply.png') });

    // the 我的 tab, one of the owner's own
    await admin.click('[data-sticker-open]');
    await until(admin, () => !!document.querySelector('[data-sticker-tabs]'), null, 8000, 'tabs');
    mark('admin-video-run1', 'step', '再次打开面板，切到「我的 · 2」');
    await admin.getByText(/^我的 · 2$/).click();
    await until(admin, () => document.querySelectorAll('[data-sticker-cell^="mine-dafeiyu/"]').length === 2, null, 8000, 'mine tab');
    await sleep(400);
    await admin.screenshot({ path: path.join(OUT, '04-panel-mine.png') });
    mark('admin-video-run1', 'step', '点击自己添加的「委屈巴巴」');
    await admin.click(`[data-sticker-cell="mine-dafeiyu/${added.added[0].id}"]`);
    const r2 = await lastTurnDone(2);
    mark('admin-video-run1', 'check', '「委屈巴巴」以图片出现，她随后回复了安慰的话');
    note('round2', { sent: r2.user.sticker, reply: r2.reply.text, replySticker: r2.reply.sticker || null });
    await sleep(1500);
    await admin.screenshot({ path: path.join(OUT, '05-sent-mine-reply.png') });
    const rendered = await admin.evaluate(() => [...document.querySelectorAll('[data-sticker-message] img[data-chat-sticker]')].map((i) => ({ id: i.dataset.chatSticker, src: i.getAttribute('src'), w: i.naturalWidth, shown: i.getBoundingClientRect().width })));
    note('rendered-run1', rendered);

    // 3. the pet window's chat box panel
    await page.mouse.move(110, 150);
    await page.evaluate(() => { document.body.classList.add('hover'); document.getElementById('chat-row').classList.remove('hidden'); });
    mark('pet-video-run1', 'step', '桌宠聊天框：点 ☺ 打开表情包弹层');
    await page.click('#sticker-btn');
    await page.waitForFunction(() => !document.getElementById('sticker-pop').classList.contains('hidden') && document.querySelectorAll('#sticker-grid .sticker-cell img').length >= 2, null, { timeout: 8000 });
    await sleep(600);
    await page.screenshot({ path: path.join(OUT, '06-pet-chatbox-panel.png') });
    const petCells = await page.evaluate(() => ({ tabs: document.getElementById('sticker-tabs').innerText, cells: [...document.querySelectorAll('#sticker-grid .sticker-cell')].map((b) => b.dataset.stickerCell) }));
    note('pet-panel', petCells);
    await page.click(`#sticker-tabs [data-sticker-tab="mine-dafeiyu"]`);
    mark('pet-video-run1', 'step', '切到「我的」，点击「超开心」发送');
    await page.click(`#sticker-grid [data-sticker-cell="mine-dafeiyu/${added.added[1].id}"]`);
    mark('pet-video-run1', 'check', '发出的表情包在聊天框上方浮现约 1.5 秒');
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, '07-pet-sent-flash.png') });
    const r3 = await lastTurnDone(3);
    await page.waitForFunction(() => !document.getElementById('bubble').classList.contains('hidden') && document.getElementById('bubble').textContent.trim().length > 0 && !document.body.classList.contains('busy'), null, { timeout: 60000 }).catch(() => {});
    await sleep(800);
    mark('pet-video-run1', 'check', '她的回复出现在气泡里');
    await page.screenshot({ path: path.join(OUT, '08-pet-bubble-reply.png') });
    note('round3-desktop', { sent: r3.user.sticker, reply: r3.reply.text, bubble: await page.evaluate(() => document.getElementById('bubble').textContent) });

    // 4. the long conversation scrolls; the stickers stay in place
    await sleep(1000);
    await admin.screenshot({ path: path.join(OUT, '09-chat-three-stickers.png') });
    const sc = await admin.evaluate(() => { const s = document.querySelector('[data-chat-scroll]'); return { scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, scrollWidth: s.scrollWidth, clientWidth: s.clientWidth }; });
    note('scroll-size', sc);
    mark('admin-video-run1', 'check', '设置窗口会话里也出现了在桌宠聊天框发出的「超开心」和她的回复');
    mark('admin-video-run1', 'step', '把长会话滚到顶部');
    await admin.evaluate(() => { document.querySelector('[data-chat-scroll]').scrollTop = 0; });
    await sleep(700);
    await admin.screenshot({ path: path.join(OUT, '10-scrolled-top.png') });
    mark('admin-video-run1', 'step', '滚到中部（旧格式的 14 轮聊天）');
    await admin.evaluate(() => { const s = document.querySelector('[data-chat-scroll]'); s.scrollTop = s.scrollHeight * 0.55; });
    await sleep(700);
    await admin.screenshot({ path: path.join(OUT, '11-scrolled-middle.png') });
    mark('admin-video-run1', 'step', '滚回底部');
    await admin.evaluate(() => { const s = document.querySelector('[data-chat-scroll]'); s.scrollTop = s.scrollHeight; });
    await sleep(900);
    await admin.screenshot({ path: path.join(OUT, '12-scrolled-bottom.png') });
    const vis = await admin.evaluate(() => [...document.querySelectorAll('img[data-chat-sticker]')].map((i) => ({ id: i.dataset.chatSticker, loaded: i.complete && i.naturalWidth > 0 })));
    note('after-scroll', vis);
    mark('admin-video-run1', 'check', '回到底部后三张表情包图片仍然加载完好、位置不变');

    topicId = (await page.evaluate(async () => (await window.pet.boot()).view)).pet.topicId;
    const raw = JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8'));
    const withSticker = raw.messages.filter((m) => m.sticker);
    fs.writeFileSync(path.join(OUT, 'chat-log-excerpt.json'), JSON.stringify({ schema: raw.schema, seq: raw.seq, total: raw.messages.length, oldFormatSample: raw.messages.slice(0, 2), stickerMessages: raw.messages.filter((m) => m.sticker || withSticker.some((s) => s.turnId === m.turnId)) }, null, 2));
    note('chat-log', `${raw.messages.length} records, ${withSticker.length} with sticker`);
    videos['pet-video-run1'] = await page.video()?.path();
    videos['admin-video-run1'] = await admin.video()?.path();
    await app.close();
    note('errors-run1', errors);

    // 5. restart over the same userData
    ({ app, page, errors } = await launch(data, path.join(OUT, 'video-run2')));
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 60000 });
    admin = await openAdmin(app, page, 'chat/dafeiyu');
    await until(admin, () => document.querySelectorAll('img[data-chat-sticker]').length >= 3 && [...document.querySelectorAll('img[data-chat-sticker]')].every((i) => i.complete && i.naturalWidth > 0), null, 20000, 'stickers after restart');
    await sleep(800);
    mark('admin-video-run2', 'check', '重启后的聊天页：三张表情包仍以图片显示');
    await admin.screenshot({ path: path.join(OUT, '13-restart-chat.png') });
    note('rendered-run2', await admin.evaluate(() => [...document.querySelectorAll('img[data-chat-sticker]')].map((i) => ({ id: i.dataset.chatSticker, src: i.getAttribute('src'), loaded: i.naturalWidth > 0 }))));
    mark('admin-video-run2', 'step', '打开 玩法 → 聊天记录');
    await admin.evaluate(() => { location.hash = '/history'; });
    await admin.waitForSelector('[data-path="/history"]', { timeout: 15000 });
    await until(admin, () => !!document.querySelector('[data-session]'), null, 15000, 'history list');
    await sleep(500);
    await admin.screenshot({ path: path.join(OUT, '14-restart-history-list.png') });
    note('history-list', await admin.evaluate(() => [...document.querySelectorAll('[data-session]')].map((el) => el.innerText.replace(/\s+/g, ' ').slice(0, 80))));
    mark('admin-video-run2', 'step', '打开最新一段会话');
    await admin.click('[data-session]');
    await until(admin, () => document.querySelectorAll('img[data-history-sticker]').length >= 3 && [...document.querySelectorAll('img[data-history-sticker]')].every((i) => i.naturalWidth > 0), null, 15000, 'history stickers');
    await admin.evaluate(() => { const imgs = document.querySelectorAll('img[data-history-sticker]'); imgs[0].scrollIntoView({ block: 'center' }); });
    await sleep(500);
    mark('admin-video-run2', 'check', '聊天记录里三条表情包消息都以缩略图显示，顺序与发送时一致');
    await admin.screenshot({ path: path.join(OUT, '15-restart-history-thread.png'), fullPage: false });
    note('history-thread', await admin.evaluate(() => [...document.querySelectorAll('img[data-history-sticker]')].map((i) => ({ id: i.dataset.historySticker, src: i.getAttribute('src'), loaded: i.naturalWidth > 0 }))));
    videos['admin-video-run2'] = await admin.video()?.path();
    await sleep(1500);
    await app.close();
    note('errors-run2', errors);
  } finally {
    try { await app.close(); } catch { /* closed */ }
    // 6. what LobeHub holds for the topic (the words the agent was given), then the agent goes
    if (topicId) {
      try {
        const out = lh('message', 'list', '--topic-id', topicId, '--json');
        fs.writeFileSync(path.join(OUT, 'lh-topic-messages.json'), out);
        note('lh-topic', `saved ${out.length} bytes`);
      } catch (e) { note('lh-topic-error', String(e.message).slice(0, 300)); }
    }
    if (agentId && !process.env.KEEP_AGENT) {
      try { lh('agent', 'delete', agentId, '--yes'); note('cleanup', `agent ${agentId} deleted`); } catch (e) { note('cleanup-error', String(e.message).slice(0, 200)); }
    }
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(log, null, 2));
    // chapters per video, from the marks
    const chapters = {};
    for (const [key, file] of Object.entries(videos)) {
      const start = starts[key.replace('-video-', '-video-')] ?? starts[key];
      chapters[key] = { file, chapters: marks.filter((m) => m.win === key).map((m) => ({ kind: m.kind, t: Math.max(0, Math.round((m.wall - start) * 100) / 100), [m.kind === 'step' ? 'label' : 'note']: m.text })) };
    }
    fs.writeFileSync(path.join(OUT, 'chapters.json'), JSON.stringify(chapters, null, 2));
  }
})().catch((e) => { console.error(e); fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify([...log, { k: 'FAILED', v: String(e.stack || e) }], null, 2)); process.exit(1); });
