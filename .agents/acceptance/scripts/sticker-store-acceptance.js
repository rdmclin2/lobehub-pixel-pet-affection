'use strict';

// T-10795 官方表情包货架 — acceptance on the real app against the real CDN (sticker-catalog.json and the set zips
// on chat-cloud.lobeobjects.space) with the real `lh` (a real agent replies; costs a few tokens). Usage (from the
// worktree root, admin already built):
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s '-screen 0 1400x900x24' node .agents/acceptance/scripts/sticker-store-acceptance.js <out>
// Runs, each over its own data folder:
//   run1  a brand-new PIXELPET_DATA_DIR (another user): meet 克洛蒂 (real agent); 商店 → 表情包 lists the CDN index;
//         filter / search; detail with every preview (sticker://store/…); 获取 「大肥鱼的梗图」 for 克洛蒂; her
//         表情包 page shows a read-only 商店 group; 聊天 → panel → 商店 tab → send one; her real reply
//   run2  restart over the same folder: the sticker message is still there, the set still 已获取; 移除 it: gone
//         from the shelf's 已获取, her page and the chat panel; the old message still shows its picture
//   run3  another new folder, the index through a local proxy in front of the same CDN that fails its first
//         answer (出错 + 重试, the shipped copy shown meanwhile) and passes the zip on slowly (下载进度)
// Writes screenshots, *.webm, chapters.json, the CDN's raw index response and evidence.json into <out>.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'acceptance', 'sticker-store'));
fs.mkdirSync(OUT, { recursive: true });
const CDN = 'https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/stickers-v1';
const INDEX_URL = `${CDN}/sticker-catalog.json`;
const SET = 'dafeiyu-memes';
const WHO = 'claude';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const marks = [];
const starts = {};
const videos = {};
const mark = (win, kind, text) => marks.push({ win, kind, text, wall: Date.now() / 1000 });
const note = (k, v) => { log.push({ k, v }); console.log(`[${k}]`, typeof v === 'string' ? v : JSON.stringify(v)); };
const lh = (...a) => execFileSync('lh', a, { encoding: 'utf8', timeout: 60000, env: { ...process.env, LOBEHUB_WORKSPACE_ID: 'personal' } });
const shot = (p, name) => p.screenshot({ path: path.join(OUT, name) });

async function launch(data, run, extra = {}) {
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    cwd: ROOT,
    // PIXELPET_TEST turns the remote index off unless it is named: name the real CDN one
    env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_CATALOG_PREINSTALLED: path.join(ROOT, 'catalog'), PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1', PIXELPET_STICKER_CATALOG_URL: INDEX_URL, ...extra },
    recordVideo: { dir: path.join(OUT, `video-${run}`), size: { width: 1200, height: 820 } },
  });
  const errors = [];
  const page = await app.firstWindow();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(`pet: ${e}`));
  return { app, page, errors };
}
async function openAdmin(app, page, route, errors, run) {
  await page.evaluate((r) => window.pet.openAdmin(r), route);
  let admin = null;
  for (let i = 0; i < 300 && !admin; i++) {
    admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
    if (!admin) await sleep(100);
  }
  starts[run] = Date.now() / 1000; // the admin window's recording starts with the window
  await admin.setViewportSize({ width: 1200, height: 820 }).catch(() => {});
  await admin.waitForSelector('[data-path]', { timeout: 20000 });
  admin.on('pageerror', (e) => errors.push(`admin: ${e}`));
  admin.on('console', (m) => { if (m.type() === 'error') errors.push(`admin console: ${m.text().slice(0, 200)}`); });
  return admin;
}
const go = async (admin, hash) => {
  await admin.evaluate((h) => { location.hash = h; }, hash);
  await sleep(300);
};
const until = async (p, fn, arg, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    if (await p.evaluate(fn, arg).catch(() => false)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
};
const imgsLoaded = (sel) => { const l = [...document.querySelectorAll(sel)]; return l.length > 0 && l.every((i) => i.complete && i.naturalWidth > 0); };
const tree = (dir) => {
  const out = [];
  const walk = (d, pre) => { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n); const st = fs.statSync(f); out.push(`${pre}${n}${st.isDirectory() ? '/' : `  (${st.size} B)`}`); if (st.isDirectory()) walk(f, `${pre}  `); } };
  if (fs.existsSync(dir)) walk(dir, '');
  return out.join('\n');
};
const progressLog = (admin) => admin.evaluate(() => { window.__prog = []; window.petAdmin.onCatalogProgress((p) => window.__prog.push({ t: Date.now(), ...p })); });

async function pickTarget(admin, name) {
  await admin.click('[data-sticker-get-target] > *');
  await admin.waitForSelector('[role="option"]', { timeout: 5000 });
  await admin.locator('[role="option"]', { hasText: name }).first().click();
  await sleep(300);
}

(async () => {
  // the CDN's index as the app will read it, raw
  {
    const res = await fetch(INDEX_URL, { cache: 'no-store' });
    const body = await res.text();
    const head = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
    fs.writeFileSync(path.join(OUT, 'cdn-index-response.txt'), `GET ${INDEX_URL}\nHTTP ${res.status}\n${head}\n\n${body}`);
    note('cdn-index', `HTTP ${res.status}, ${body.length} B, sets: ${JSON.parse(body).sets.map((s) => `${s.id}(${s.name}, ${s.count} 张)`).join(', ')}`);
  }

  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-stickerstore-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  note('data-dir', `${data}: ${fs.readdirSync(data).join(', ')} (nothing else: no stickers/, no chat-log.json)`);

  let agentId = null;
  let topicId = null;
  let { app, page, errors } = await launch(data, 'run1');
  let admin;
  try {
    await page.waitForSelector('.char-card', { timeout: 60000 });
    await shot(page, '00-fresh-first-launch.png');
    await page.click(`.char-card[data-species="${WHO}"]`);
    if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt').catch(() => {});
    await page.fill('#pet-name', '小克');
    await page.click('#hatch-btn');
    const where = await Promise.race([
      page.waitForSelector('#space-box:not(.hidden)', { timeout: 180000 }).then(() => 'asked'),
      page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 180000 }).then(() => 'not asked'),
    ]);
    if (where === 'asked') await page.click('#space-go');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 180000 });
    agentId = (await page.evaluate(async () => (await window.pet.boot()).view)).pet.agentId;
    note('hatch', `real agent ${agentId}`);
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 150000 }).catch(() => {});

    admin = await openAdmin(app, page, 'store/stickers', errors, 'run1');
    await progressLog(admin);
    mark('run1', 'step', '打开 商店 → 表情包');
    await until(admin, () => document.querySelectorAll('[data-store-sticker]').length >= 2, null, 30000, 'shelf');
    await until(admin, imgsLoaded, '[data-store-sticker] img', 20000, 'covers');
    await sleep(500);
    await shot(admin, '01-shelf-cdn.png');
    const shelf = await admin.evaluate(() => ({
      source: document.querySelector('[data-sticker-source]')?.dataset.stickerSource,
      sourceText: document.querySelector('[data-sticker-source]')?.textContent,
      tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent),
      cards: [...document.querySelectorAll('[data-store-sticker]')].map((c) => ({ id: c.dataset.storeSticker, text: c.innerText.replace(/\s+/g, ' '), cover: c.querySelector('img')?.getAttribute('src') })),
    }));
    note('shelf', shelf);
    mark('run1', 'check', `表情包标签页列出 CDN 索引的 ${shelf.cards.length} 组，来源：${shelf.sourceText}`);

    mark('run1', 'step', '搜索「大肥鱼」');
    await admin.fill('[data-sticker-search] input, input[data-sticker-search]', '大肥鱼');
    await sleep(500);
    await shot(admin, '02-search-dafeiyu.png');
    note('search', await admin.evaluate(() => [...document.querySelectorAll('[data-store-sticker]')].map((c) => c.dataset.storeSticker)));
    mark('run1', 'check', '搜索后只剩「大肥鱼的梗图」');
    await admin.fill('[data-sticker-search] input, input[data-sticker-search]', '没有这个');
    await sleep(400);
    await shot(admin, '03-search-empty.png');
    await admin.fill('[data-sticker-search] input, input[data-sticker-search]', '');
    mark('run1', 'step', '筛选「已获取」');
    await admin.locator('[data-sticker-filter]').getByText(/^已获取/).click();
    await sleep(400);
    await shot(admin, '04-filter-installed-empty.png');
    note('filter-installed', await admin.evaluate(() => ({ cards: document.querySelectorAll('[data-store-sticker]').length, empty: document.querySelector('[data-sticker-empty]')?.textContent })));
    mark('run1', 'check', '「已获取 0」下显示空状态');
    await admin.locator('[data-sticker-filter]').getByText(/^全部/).click();
    await sleep(300);

    mark('run1', 'step', '打开「大肥鱼的梗图」详情');
    await admin.click(`[data-sticker-set-open="${SET}"]`);
    await until(admin, (n) => document.querySelectorAll('[data-sticker-preview] img').length >= n, 9, 20000, 'previews');
    await until(admin, imgsLoaded, '[data-sticker-preview] img', 20000, 'preview images');
    await sleep(500);
    await shot(admin, '05-detail-previews.png');
    const detail = await admin.evaluate(() => ({ title: document.querySelector('[data-sticker-title]')?.textContent, about: document.querySelector('[data-sticker-about]')?.innerText.replace(/\s+/g, ' '), previews: [...document.querySelectorAll('[data-sticker-preview]')].map((f) => ({ id: f.dataset.stickerPreview, src: f.querySelector('img')?.getAttribute('src'), w: f.querySelector('img')?.naturalWidth })) }));
    note('detail', detail);
    mark('run1', 'check', `详情页 ${detail.previews.length} 张预览全部加载，src 都是 sticker://store/…`);

    mark('run1', 'step', '点「获取」，选择挂到 克洛蒂');
    await admin.click(`[data-sticker-get="${SET}"]`);
    await admin.waitForSelector('[data-sticker-get-target]', { timeout: 5000 });
    await sleep(400);
    await shot(admin, '06-get-modal-default.png');
    await pickTarget(admin, '克洛蒂');
    await shot(admin, '07-get-modal-claude.png');
    await admin.click(`[data-sticker-get-confirm="${SET}"]`);
    await shot(admin, '08-getting.png');
    await until(admin, (id) => !!document.querySelector(`[data-sticker-installed="${id}"]`), SET, 60000, 'installed');
    await sleep(600);
    await shot(admin, '09-got.png');
    const prog = await admin.evaluate(() => window.__prog);
    note('progress-events', prog);
    note('got', await admin.evaluate(() => document.querySelector('[data-sticker-attached]')?.textContent));
    mark('run1', 'check', '获取完成：状态变为「已获取」，已获取：克洛蒂');
    note('userData-stickers-tree', tree(path.join(data, 'stickers')));
    const setFile = path.join(data, 'stickers', 'sets', `store-${SET}.json`);
    fs.copyFileSync(setFile, path.join(OUT, `store-${SET}.json`));

    // her 表情包 page: a read-only 商店 group
    const rowId = await admin.evaluate(async (who) => { const b = await window.petAdmin.boot(); return (b.roster.find((r) => r.base === who && r.current) || b.roster.find((r) => r.base === who)).id; }, WHO);
    mark('run1', 'step', '打开 角色 → 克洛蒂 → 表情包');
    await go(admin, `/characters/${rowId}/stickers`);
    await admin.waitForSelector(`[data-stickers="${WHO}"]`, { timeout: 15000 });
    await admin.getByText(/^商店 · 大肥鱼的梗图 · 9$/).click();
    await until(admin, imgsLoaded, `[data-stickers-grid="store-${SET}"] img`, 15000, 'store group grid');
    await sleep(400);
    await shot(admin, '10-character-store-group.png');
    note('character-page', await admin.evaluate(() => ({ tabs: document.querySelector('[data-stickers] .ant-segmented, [data-stickers]')?.innerText.split('\n').slice(0, 8), readonly: document.querySelector('[data-sticker-readonly]')?.textContent, deletable: document.querySelectorAll('[data-stickers-grid] [data-sticker-delete]').length })));
    mark('run1', 'check', '她的表情包页出现只读分组「商店 · 大肥鱼的梗图 · 9」，没有删除按钮');

    // chat: the panel's 商店 tab, send one, her real reply
    mark('run1', 'step', '打开 聊天 → 克洛蒂，点表情包按钮，切到「商店 · 大肥鱼的梗图」');
    await go(admin, `/chat/${WHO}`);
    await admin.waitForSelector('[data-sticker-open]', { timeout: 20000 });
    await sleep(800);
    await admin.click('[data-sticker-open]');
    await admin.waitForSelector('[data-sticker-tabs]', { timeout: 8000 });
    await admin.locator('[data-sticker-tabs]').getByText(/^商店 · 大肥鱼的梗图 · 9$/).click();
    await until(admin, (id) => document.querySelectorAll(`[data-sticker-cell^="store-${id}/"] img`).length === 9, SET, 8000, 'store tab');
    await until(admin, imgsLoaded, '[data-sticker-cell] img', 8000, 'store cells');
    await sleep(400);
    await shot(admin, '11-chat-panel-store-tab.png');
    note('chat-panel', await admin.evaluate(() => ({ tabs: document.querySelector('[data-sticker-tabs]').innerText, cells: [...document.querySelectorAll('[data-sticker-cell]')].map((c) => c.dataset.stickerCell) })));
    mark('run1', 'step', '点击「Ciallo～」发送');
    await admin.click(`[data-sticker-cell="store-${SET}/ciallo"]`);
    const t1 = Date.now();
    let turn;
    for (;;) {
      const h = await admin.evaluate((w) => window.petAdmin.chat.history(w, { limit: 40 }), WHO);
      const ms = h.messages || [];
      const u = ms.filter((m) => m.role === 'user' && m.sticker).pop();
      const last = ms[ms.length - 1];
      if (u && last && last.role === 'assistant' && last.turnId === u.turnId && !h.streaming && last.text) { turn = { user: u, reply: last }; break; }
      if (Date.now() - t1 > 180000) throw new Error('no reply');
      await sleep(500);
    }
    await sleep(1500);
    await shot(admin, '12-chat-sent-reply.png');
    note('round', { sent: turn.user.sticker, reply: turn.reply.text, replySticker: turn.reply.sticker || null });
    mark('run1', 'check', `表情包「Ciallo～」以图片出现在会话里；克洛蒂回复：${turn.reply.text.slice(0, 40)}`);
    topicId = (await page.evaluate(async () => (await window.pet.boot()).view)).pet.topicId;
    const raw = JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8'));
    fs.writeFileSync(path.join(OUT, 'chat-log-excerpt.json'), JSON.stringify({ schema: raw.schema, total: raw.messages.length, stickerTurn: raw.messages.filter((m) => m.turnId === turn.user.turnId) }, null, 2));
    note('chat-log', raw.messages.filter((m) => m.turnId === turn.user.turnId));
    videos.run1 = await admin.video()?.path();
    await app.close();
    note('errors-run1', errors);

    // run2: restart over the same folder
    ({ app, page, errors } = await launch(data, 'run2'));
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 60000 });
    admin = await openAdmin(app, page, `chat/${WHO}`, errors, 'run2');
    mark('run2', 'step', '重启应用，打开 聊天 → 克洛蒂');
    await until(admin, imgsLoaded, 'img[data-chat-sticker]', 20000, 'sticker after restart');
    await sleep(800);
    await shot(admin, '13-restart-chat.png');
    note('restart-chat', await admin.evaluate(() => [...document.querySelectorAll('img[data-chat-sticker]')].map((i) => ({ id: i.dataset.chatSticker, src: i.getAttribute('src'), loaded: i.naturalWidth > 0 }))));
    mark('run2', 'check', '重启后会话里那张表情包仍以图片显示');
    mark('run2', 'step', '商店 → 表情包：该集合仍是「已获取」');
    await go(admin, '/store/stickers');
    await until(admin, (id) => !!document.querySelector(`[data-sticker-installed="${id}"]`), SET, 30000, 'still installed');
    await admin.locator('[data-sticker-filter]').getByText(/^已获取/).click();
    await sleep(500);
    await shot(admin, '14-restart-filter-installed.png');
    note('restart-installed', await admin.evaluate(() => [...document.querySelectorAll('[data-store-sticker]')].map((c) => c.innerText.replace(/\s+/g, ' '))));
    mark('run2', 'check', '「已获取 1」只列出大肥鱼的梗图，已获取：克洛蒂');

    mark('run2', 'step', '详情页点「移除」并确认');
    await go(admin, `/store/sticker/${SET}`);
    await admin.waitForSelector(`[data-sticker-remove="${SET}"]`, { timeout: 15000 });
    await admin.click(`[data-sticker-remove="${SET}"]`);
    await sleep(600);
    await shot(admin, '15-remove-confirm.png');
    await admin.getByRole('button', { name: '移除表情包' }).click();
    await until(admin, (id) => !!document.querySelector(`[data-sticker-remote="${id}"]`), SET, 15000, 'removed');
    await sleep(600);
    await shot(admin, '16-removed-detail.png');
    note('after-remove-tree', tree(path.join(data, 'stickers')));
    note('after-remove-set-file', fs.existsSync(setFile) ? 'still there' : 'sets/store-dafeiyu-memes.json removed');
    await go(admin, '/store/stickers');
    await admin.waitForSelector('[data-sticker-filter]', { timeout: 15000 });
    await admin.locator('[data-sticker-filter]').getByText(/^已获取/).click();
    await sleep(500);
    await shot(admin, '17-removed-filter-installed.png');
    mark('run2', 'check', '移除后「已获取 0」，卡片回到「未获取」');
    mark('run2', 'step', '聊天：面板里没有商店分组，旧消息的图片还在');
    await go(admin, `/chat/${WHO}`);
    await until(admin, imgsLoaded, 'img[data-chat-sticker]', 20000, 'old message');
    await admin.click('[data-sticker-open]');
    await sleep(800);
    await shot(admin, '18-removed-chat-panel.png');
    note('removed-chat', await admin.evaluate(() => ({ tabs: document.querySelector('[data-sticker-tabs]')?.innerText || '(one set: no tabs)', storeCells: document.querySelectorAll('[data-sticker-cell^="store-"]').length, oldMessage: [...document.querySelectorAll('img[data-chat-sticker]')].map((i) => ({ src: i.getAttribute('src'), loaded: i.naturalWidth > 0 })) })));
    mark('run2', 'check', '表情包面板只剩内置分组；之前发出的「Ciallo～」仍正常显示');
    videos.run2 = await admin.video()?.path();
    await app.close();
    note('errors-run2', errors);
  } finally {
    try { await app.close(); } catch { /* closed */ }
    if (topicId) {
      try { fs.writeFileSync(path.join(OUT, 'lh-topic-messages.json'), lh('message', 'list', '--topic-id', topicId, '--json')); } catch (e) { note('lh-topic-error', String(e.message).slice(0, 300)); }
    }
    if (agentId) {
      try { lh('agent', 'delete', agentId, '--yes'); note('cleanup', `agent ${agentId} deleted`); } catch (e) { note('cleanup-error', String(e.message).slice(0, 200)); }
    }
  }

  // run3: 出错 + 重试 and 下载进度, through a proxy in front of the same CDN
  {
    let indexHits = 0;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/idx') {
        indexHits++;
        note('proxy-index', `request #${indexHits}`);
        if (indexHits === 1) { await sleep(2500); res.writeHead(503); res.end('upstream unavailable (injected)'); return; }
        const r = await fetch(INDEX_URL, { cache: 'no-store' });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      const name = u.pathname.replace(/^\/files\//, '');
      const r = await fetch(`${CDN}/${name}`);
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'content-length': buf.length });
      const slow = name.endsWith('.zip');
      for (let i = 0; i < buf.length; i += slow ? 4096 : buf.length) {
        res.write(buf.subarray(i, i + (slow ? 4096 : buf.length)));
        if (slow) await sleep(120);
      }
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const data3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-stickerstore-err-'));
    fs.writeFileSync(path.join(data3, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
    ({ app, page, errors } = await launch(data3, 'run3', { PIXELPET_STICKER_CATALOG_URL: `http://127.0.0.1:${port}/idx`, PIXELPET_STICKER_BASE_URL: `http://127.0.0.1:${port}/files`, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-fakelh-')) }));
    try {
      await page.waitForSelector('.char-card', { timeout: 60000 });
      admin = await openAdmin(app, page, 'store/stickers', errors, 'run3');
      mark('run3', 'step', '打开 商店 → 表情包（索引请求被代理延迟 2.5 秒后返回 503）');
      await sleep(600);
      await shot(admin, '19-loading.png');
      note('loading', await admin.evaluate(() => !!document.querySelector('[data-sticker-loading]')));
      mark('run3', 'check', '加载中显示骨架卡片');
      await admin.waitForSelector('[data-sticker-error]', { timeout: 20000 });
      await sleep(400);
      await shot(admin, '20-error-fallback.png');
      note('error-state', await admin.evaluate(() => ({ alert: document.querySelector('[data-sticker-error]')?.innerText.replace(/\s+/g, ' '), source: document.querySelector('[data-sticker-source]')?.dataset.stickerSource, cards: document.querySelectorAll('[data-store-sticker]').length })));
      mark('run3', 'check', '出错：警告条 + 重试按钮，下方是随应用打包的目录');
      mark('run3', 'step', '点「重试」');
      await admin.click('[data-sticker-error] [data-sticker-retry]');
      await until(admin, () => document.querySelector('[data-sticker-source]')?.dataset.stickerSource === 'remote' && !document.querySelector('[data-sticker-error]'), null, 20000, 'retry');
      await sleep(500);
      await shot(admin, '21-retry-ok.png');
      mark('run3', 'check', '重试成功：警告消失，来源变为 LobeHub CDN');
      await progressLog(admin);
      mark('run3', 'step', '获取「大肥鱼的梗图」（代理按 4 KB / 120 ms 转发 CDN 的 zip）');
      await admin.click(`[data-sticker-get="${SET}"]`);
      await admin.waitForSelector('[data-sticker-get-target]', { timeout: 5000 });
      await sleep(300);
      await admin.click(`[data-sticker-get-confirm="${SET}"]`);
      await admin.waitForSelector(`[data-sticker-download-progress="${SET}"]`, { timeout: 10000 });
      await sleep(1500);
      await shot(admin, '22-download-progress.png');
      note('progress-text', await admin.evaluate((id) => document.querySelector(`[data-sticker-download-progress="${id}"]`)?.innerText, SET));
      mark('run3', 'check', '卡片上显示下载进度条与百分比，主按钮变为「取消」');
      await until(admin, (id) => !!document.querySelector(`[data-sticker-installed="${id}"]`), SET, 60000, 'installed via proxy');
      await sleep(500);
      await shot(admin, '23-download-done.png');
      const ev = await admin.evaluate(() => window.__prog);
      note('progress-events-run3', ev.map((p) => `${p.state} ${p.received ?? ''}/${p.total ?? ''}`).filter((s, i, a) => s !== a[i - 1]));
      videos.run3 = await admin.video()?.path();
      await app.close();
      note('errors-run3', errors);
    } finally {
      try { await app.close(); } catch { /* closed */ }
      server.close();
    }
  }

  const chapters = {};
  for (const [run, file] of Object.entries(videos)) chapters[run] = { file, chapters: marks.filter((m) => m.win === run).map((m) => ({ kind: m.kind, t: Math.max(0, Math.round((m.wall - starts[run]) * 100) / 100), [m.kind === 'step' ? 'label' : 'note']: m.text })) };
  fs.writeFileSync(path.join(OUT, 'chapters.json'), JSON.stringify(chapters, null, 2));
  fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(log, null, 2));
})().catch((e) => { console.error(e); fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify([...log, { k: 'FAILED', v: String(e.stack || e) }], null, 2)); process.exit(1); });
