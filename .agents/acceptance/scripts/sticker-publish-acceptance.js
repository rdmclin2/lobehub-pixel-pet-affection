'use strict';

// T-10796 上架到商店 — acceptance on the real app with the real sticker market service (services/sticker-market, run
// here on 127.0.0.1) verifying owners against real LobeHub (app.lobehub.com user.getUserState with the `lh login`
// token), and the real `lh` (real agents; costs a few tokens). Usage (from the worktree root, admin already built):
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s '-screen 0 1400x900x24' node .agents/acceptance/scripts/sticker-publish-acceptance.js <out>
// Runs:
//   runA   owner A, a new data folder: 大肥鱼 → 表情包 → 「我的」 empty → add 3 pictures at once → 商店 before (no
//          community set) → 上架到商店 form → submit → 我上架的 says 审核中 → shelf still without it → the maintainer
//          approves (review.mjs) → 刷新: the set on the shelf (社区, author = A's LobeHub name) → its detail
//   runB   another install (new data folder): 商店 lists A's set → detail → 获取 for 克洛蒂 → her 表情包 page → chat
//          panel → send one → her real reply
//   runA2  owner A again: 我上架的 → 下架 → the shelf no longer lists it
// Writes screenshots, *.webm, chapters.json, the market's raw responses and evidence.json into <out>.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { _electron } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'out', 'acceptance', 'sticker-publish'));
fs.mkdirSync(OUT, { recursive: true });
const PICS = process.env.PICS_DIR || '/tmp/pp-publish-pics';
const PORT = 8791;
const MARKET = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = crypto.randomBytes(16).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const marks = [];
const starts = {};
const videos = {};
const mark = (win, kind, text) => marks.push({ win, kind, text, wall: Date.now() / 1000 });
const note = (k, v) => { log.push({ k, v }); console.log(`[${k}]`, typeof v === 'string' ? v : JSON.stringify(v)); };
const lh = (...a) => execFileSync('lh', a, { encoding: 'utf8', timeout: 60000, env: { ...process.env, LOBEHUB_WORKSPACE_ID: 'personal' } });
const shot = (p, name) => p.screenshot({ path: path.join(OUT, name) });
const raw = async (name, url, opts) => {
  const res = await fetch(url, opts);
  const body = await res.text();
  fs.writeFileSync(path.join(OUT, name), `${opts?.method || 'GET'} ${url}\nHTTP ${res.status}\n\n${body}`);
  return { status: res.status, body };
};

async function launch(data, run) {
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    cwd: ROOT,
    env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_CATALOG_PREINSTALLED: path.join(ROOT, 'catalog'), PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1', PIXELPET_STICKER_CATALOG_URL: 'https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/stickers-v1/sticker-catalog.json', PIXELPET_STICKER_MARKET_URL: MARKET },
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
  starts[run] = Date.now() / 1000;
  await admin.setViewportSize({ width: 1200, height: 820 }).catch(() => {});
  await admin.waitForSelector('[data-path]', { timeout: 20000 });
  admin.on('pageerror', (e) => errors.push(`admin: ${e}`));
  admin.on('console', (m) => { if (m.type() === 'error') errors.push(`admin console: ${m.text().slice(0, 200)}`); });
  return admin;
}
const go = async (admin, hash) => { await admin.evaluate((h) => { location.hash = h; }, hash); await sleep(400); };
const until = async (p, fn, arg, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    if (await p.evaluate(fn, arg).catch(() => false)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
};
const imgsLoaded = (sel) => { const l = [...document.querySelectorAll(sel)]; return l.length > 0 && l.every((i) => i.complete && i.naturalWidth > 0); };
const cards = (admin) => admin.evaluate(() => [...document.querySelectorAll('[data-store-sticker]')].map((c) => ({ id: c.dataset.storeSticker, text: c.innerText.replace(/\s+/g, ' ') })));

async function hatch(page, who, name) {
  await page.waitForSelector('.char-card', { timeout: 60000 });
  await page.click(`.char-card[data-species="${who}"]`);
  if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt').catch(() => {});
  await page.fill('#pet-name', name);
  await page.click('#hatch-btn');
  const where = await Promise.race([
    page.waitForSelector('#space-box:not(.hidden)', { timeout: 180000 }).then(() => 'asked'),
    page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 180000 }).then(() => 'not asked'),
  ]);
  if (where === 'asked') await page.click('#space-go');
  await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 180000 });
  const agentId = (await page.evaluate(async () => (await window.pet.boot()).view)).pet.agentId;
  await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 150000 }).catch(() => {});
  return agentId;
}
const rowOf = (admin, who) => admin.evaluate(async (w) => { const b = await window.petAdmin.boot(); return (b.roster.find((r) => r.base === w && r.current) || b.roster.find((r) => r.base === w)).id; }, who);
const newData = (tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `pp-publish-${tag}-`));
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  return d;
};

(async () => {
  // ---- the sticker market, verifying against real LobeHub -------------------------------------------------
  const marketDir = path.join(OUT, 'market-data');
  fs.rmSync(marketDir, { recursive: true, force: true });
  const srvLog = fs.openSync(path.join(OUT, 'market-server.log'), 'w');
  const srv = spawn(process.execPath, [path.join(ROOT, 'services', 'sticker-market', 'server.js')], { env: { ...process.env, PORT: String(PORT), STICKER_MARKET_DIR: marketDir, STICKER_MARKET_REVIEW: 'manual', STICKER_MARKET_ADMIN_TOKEN: ADMIN_TOKEN }, stdio: ['ignore', srvLog, srvLog] });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${MARKET}/v1/health`)).ok) break; } catch { /* starting */ } await sleep(200); }
  note('market-health', (await raw('market-00-health.txt', `${MARKET}/v1/health`)).body);
  note('market-index-empty', (await raw('market-01-index-before.txt', `${MARKET}/v1/sticker-catalog.json`)).body);
  // a token LobeHub does not know is refused by the real verifier
  note('forged-token', (await raw('market-02-forged-token.txt', `${MARKET}/v1/sticker-sets`, { method: 'POST', headers: { 'Oidc-Auth': 'not-a-real-token', 'X-Rights-Confirmed': 'yes' }, body: Buffer.from('x') })).status);

  const agents = [];
  let setId = null;
  const dataA = newData('A');
  try {
    // ---- runA: owner A publishes ---------------------------------------------------------------------------
    let { app, page, errors } = await launch(dataA, 'runA');
    agents.push(await hatch(page, 'dafeiyu', '鱼片'));
    let admin = await openAdmin(app, page, 'store/stickers', errors, 'runA');
    mark('runA', 'step', '上架前：打开 商店 → 表情包');
    await until(admin, () => document.querySelectorAll('[data-store-sticker]').length >= 5, null, 30000, 'shelf');
    await until(admin, imgsLoaded, '[data-store-sticker] img', 20000, 'covers');
    await sleep(500);
    await shot(admin, 'A01-shelf-before.png');
    note('A-shelf-before', { source: await admin.evaluate(() => document.querySelector('[data-sticker-source]')?.textContent), cards: await cards(admin) });
    mark('runA', 'check', '上架前商店只有 5 组官方表情包，来源行显示「社区上架 0 组」');
    await admin.locator('[data-sticker-filter]').getByText(/^我上架的/).click();
    await admin.waitForSelector('[data-my-published-empty], [data-my-published]', { timeout: 15000 });
    await sleep(400);
    await shot(admin, 'A02-my-published-empty.png');
    mark('runA', 'check', '「我上架的」为空状态，提示从角色表情包页上架');

    const rowA = await rowOf(admin, 'dafeiyu');
    mark('runA', 'step', '打开 角色 → 大肥鱼 → 表情包 →「我的」');
    await go(admin, `/characters/${rowA}/stickers`);
    await admin.waitForSelector('[data-stickers="dafeiyu"]', { timeout: 15000 });
    await admin.getByText(/^我的 · \d+$/).click();
    await sleep(400);
    await shot(admin, 'A03-mine-empty.png');
    mark('runA', 'step', '添加表情包：一次选 3 张图片');
    const files = ['开心.png', '害羞.png', '惊讶.png'].map((f) => path.join(PICS, f));
    await page.evaluate((x) => window.pet.debugNextOpen(x), files.join('\n'));
    await admin.locator('[data-stickers-add]').first().click();
    await until(admin, () => document.querySelectorAll('[data-stickers-grid^="mine-"] [data-sticker] img').length === 3, null, 15000, '3 stickers');
    await until(admin, imgsLoaded, '[data-stickers-grid^="mine-"] [data-sticker] img', 10000, 'mine imgs');
    await sleep(800);
    await shot(admin, 'A04-mine-3-with-publish-button.png');
    mark('runA', 'check', '「我的 · 3」出现 3 张，工具栏有「上架到商店」');

    mark('runA', 'step', '点「上架到商店」，填写名称、简介、授权并勾选发布权');
    await admin.click('[data-sticker-publish]');
    await admin.waitForSelector('[data-sticker-publish-form]', { timeout: 8000 });
    await sleep(400);
    await shot(admin, 'A05-publish-form-empty.png');
    await admin.fill('[data-publish-name]', '鱼片的表情三连');
    await admin.fill('[data-publish-desc]', '大肥鱼开心、害羞、惊讶三连，日常聊天用。');
    await admin.locator('[data-publish-rights]').click();
    await sleep(400);
    await shot(admin, 'A06-publish-form-filled.png');
    mark('runA', 'step', '点「提交上架」');
    await admin.getByRole('button', { name: '提交上架' }).click();
    await admin.waitForSelector('[data-sticker-publish-form]', { state: 'detached', timeout: 60000 });
    await sleep(500);
    await shot(admin, 'A07-submitted-toast.png');
    setId = JSON.parse(fs.readFileSync(path.join(dataA, 'stickers', 'published.json'), 'utf8')).dafeiyu;
    note('A-published-map', fs.readFileSync(path.join(dataA, 'stickers', 'published.json'), 'utf8'));
    mark('runA', 'check', `提交成功，提示「已提交上架（v1.0.0）」，商店分配 id ${setId}`);

    mark('runA', 'step', '商店 → 我上架的：审核中');
    await go(admin, '/store/stickers');
    await admin.waitForSelector('[data-sticker-filter]', { timeout: 15000 });
    await admin.locator('[data-sticker-filter]').getByText(/^我上架的/).click();
    await admin.waitForSelector('[data-publish-state="pending"]', { timeout: 15000 });
    await sleep(400);
    await shot(admin, 'A08-my-published-pending.png');
    note('A-mine-pending', await admin.evaluate(() => document.querySelector('[data-my-published]')?.innerText));
    mark('runA', 'check', '「我上架的」显示这组「审核中」，作者为 LobeHub 账号名');
    await admin.locator('[data-sticker-filter]').getByText(/^全部/).click();
    await sleep(500);
    note('A-shelf-while-pending', await cards(admin));
    note('market-pending', (await raw('market-03-admin-pending.txt', `${MARKET}/v1/admin/pending`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).body);
    note('market-index-while-pending', (await raw('market-04-index-while-pending.txt', `${MARKET}/v1/sticker-catalog.json`)).body);
    mark('runA', 'check', '审核通过前，商店「全部」里还没有它');

    mark('runA', 'step', '维护者审核通过（review.mjs approve）');
    const rv = execFileSync(process.execPath, [path.join(ROOT, 'services', 'sticker-market', 'review.mjs'), 'approve', setId], { encoding: 'utf8', env: { ...process.env, STICKER_MARKET_URL: MARKET, STICKER_MARKET_ADMIN_TOKEN: ADMIN_TOKEN } });
    fs.writeFileSync(path.join(OUT, 'market-05-review-approve.txt'), `$ node services/sticker-market/review.mjs approve ${setId}\n${rv}`);
    note('review-approve', rv);
    note('market-index-after', (await raw('market-06-index-after-approve.txt', `${MARKET}/v1/sticker-catalog.json`)).body);

    mark('runA', 'step', '商店点「刷新」');
    await admin.click('[data-sticker-refresh]');
    await until(admin, (id) => !!document.querySelector(`[data-store-sticker="${id}"] img`), setId, 20000, 'community card');
    await until(admin, imgsLoaded, '[data-store-sticker] img', 20000, 'covers');
    await sleep(600);
    await admin.evaluate((id) => document.querySelector(`[data-store-sticker="${id}"]`)?.scrollIntoView({ block: 'center' }), setId);
    await sleep(400);
    await shot(admin, 'A09-shelf-after-approve.png');
    note('A-shelf-after', { source: await admin.evaluate(() => document.querySelector('[data-sticker-source]')?.textContent), cards: await cards(admin) });
    mark('runA', 'check', '商店列表出现「鱼片的表情三连」卡片：社区标签、作者、3 张');
    mark('runA', 'step', '打开它的详情页');
    await admin.click(`[data-sticker-set-open="${setId}"]`);
    await until(admin, () => document.querySelectorAll('[data-sticker-preview] img').length === 3, null, 20000, 'previews');
    await until(admin, imgsLoaded, '[data-sticker-preview] img', 20000, 'preview imgs');
    await sleep(500);
    await shot(admin, 'A10-detail.png');
    note('A-detail', await admin.evaluate(() => ({ title: document.querySelector('[data-sticker-title]')?.parentElement?.innerText, about: document.querySelector('[data-sticker-about]')?.innerText.replace(/\s+/g, ' '), previews: [...document.querySelectorAll('[data-sticker-preview]')].map((f) => ({ id: f.dataset.stickerPreview, src: f.querySelector('img')?.getAttribute('src'), w: f.querySelector('img')?.naturalWidth })) })));
    mark('runA', 'check', '详情页：名称、社区标签、3 张预览、作者（LobeHub 账号名）、授权 CC BY 4.0、适用角色 大肥鱼');
    await go(admin, '/store/stickers');
    await admin.locator('[data-sticker-filter]').getByText(/^我上架的/).click();
    await admin.waitForSelector('[data-publish-state="published"]', { timeout: 15000 });
    await sleep(400);
    await shot(admin, 'A11-my-published-live.png');
    mark('runA', 'check', '「我上架的」变为「已上架」');
    videos.runA = await admin.video()?.path();
    await app.close();
    note('errors-runA', errors);

    // ---- runB: another install gets it and sends it -------------------------------------------------------
    const dataB = newData('B');
    ({ app, page, errors } = await launch(dataB, 'runB'));
    agents.push(await hatch(page, 'claude', '小克'));
    admin = await openAdmin(app, page, 'store/stickers', errors, 'runB');
    mark('runB', 'step', '另一份安装（全新数据目录）打开 商店 → 表情包');
    await until(admin, (id) => !!document.querySelector(`[data-store-sticker="${id}"] img`), setId, 30000, 'community card on B');
    await until(admin, imgsLoaded, '[data-store-sticker] img', 20000, 'covers');
    await admin.fill('[data-sticker-search] input, input[data-sticker-search]', '鱼片');
    await sleep(600);
    await shot(admin, 'B01-shelf-search.png');
    note('B-shelf', await cards(admin));
    mark('runB', 'check', '搜索「鱼片」：只剩主人 A 上架的这组');
    await admin.click(`[data-sticker-set-open="${setId}"]`);
    await until(admin, imgsLoaded, '[data-sticker-preview] img', 20000, 'preview imgs');
    mark('runB', 'step', '详情页点「获取」，选 克洛蒂');
    await admin.click(`[data-sticker-get="${setId}"]`);
    await admin.waitForSelector('[data-sticker-get-target]', { timeout: 5000 });
    await admin.click('[data-sticker-get-target] > *');
    await admin.waitForSelector('[role="option"]', { timeout: 5000 });
    await admin.locator('[role="option"]', { hasText: '克洛蒂' }).first().click();
    await sleep(300);
    await shot(admin, 'B02-get-modal.png');
    await admin.click(`[data-sticker-get-confirm="${setId}"]`);
    await until(admin, (id) => !!document.querySelector(`[data-sticker-installed="${id}"]`), setId, 60000, 'installed');
    await sleep(600);
    await shot(admin, 'B03-got.png');
    mark('runB', 'check', '获取完成：已获取 克洛蒂');
    note('B-set-file', fs.readFileSync(path.join(dataB, 'stickers', 'sets', `store-${setId}.json`), 'utf8'));
    fs.copyFileSync(path.join(dataB, 'stickers', 'sets', `store-${setId}.json`), path.join(OUT, `B-store-${setId}.json`));
    const rowB = await rowOf(admin, 'claude');
    mark('runB', 'step', '角色 → 克洛蒂 → 表情包');
    await go(admin, `/characters/${rowB}/stickers`);
    await admin.waitForSelector('[data-stickers="claude"]', { timeout: 15000 });
    await admin.getByText(/^商店 · 鱼片的表情三连 · 3$/).click();
    await until(admin, imgsLoaded, `[data-stickers-grid="store-${setId}"] img`, 15000, 'store group');
    await sleep(400);
    await shot(admin, 'B04-character-store-group.png');
    mark('runB', 'check', '克洛蒂的表情包页出现只读分组「商店 · 鱼片的表情三连 · 3」');
    mark('runB', 'step', '聊天 → 克洛蒂 → 表情包面板 → 商店分组 → 点「害羞」');
    await go(admin, '/chat/claude');
    await admin.waitForSelector('[data-sticker-open]', { timeout: 20000 });
    await sleep(800);
    await admin.click('[data-sticker-open]');
    await admin.waitForSelector('[data-sticker-tabs]', { timeout: 8000 });
    await admin.locator('[data-sticker-tabs]').getByText(/^商店 · 鱼片的表情三连 · 3$/).click();
    await until(admin, (id) => document.querySelectorAll(`[data-sticker-cell^="store-${id}/"] img`).length === 3, setId, 8000, 'store tab');
    await until(admin, imgsLoaded, '[data-sticker-cell] img', 8000, 'cells');
    await sleep(400);
    await shot(admin, 'B05-chat-panel.png');
    const cell = await admin.evaluate((id) => [...document.querySelectorAll(`[data-sticker-cell^="store-${id}/"]`)].map((c) => c.dataset.stickerCell), setId);
    note('B-panel-cells', cell);
    const target = cell.find((c) => /害羞/.test(c)) || cell[1];
    await admin.click(`[data-sticker-cell="${target}"]`);
    const t1 = Date.now();
    let turn;
    for (;;) {
      const h = await admin.evaluate(() => window.petAdmin.chat.history('claude', { limit: 40 }));
      const ms = h.messages || [];
      const u = ms.filter((m) => m.role === 'user' && m.sticker).pop();
      const last = ms[ms.length - 1];
      if (u && last && last.role === 'assistant' && last.turnId === u.turnId && !h.streaming && last.text) { turn = { user: u, reply: last }; break; }
      if (Date.now() - t1 > 180000) throw new Error('no reply');
      await sleep(500);
    }
    await sleep(1500);
    await shot(admin, 'B06-chat-sent-reply.png');
    note('B-round', { sent: turn.user.sticker, reply: turn.reply.text });
    mark('runB', 'check', `社区表情包以图片出现在会话里；克洛蒂回复：${turn.reply.text.slice(0, 40)}`);
    videos.runB = await admin.video()?.path();
    await app.close();
    note('errors-runB', errors);

    // ---- runA2: the owner takes it down -------------------------------------------------------------------
    ({ app, page, errors } = await launch(dataA, 'runA2'));
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 60000 });
    admin = await openAdmin(app, page, 'store/stickers', errors, 'runA2');
    mark('runA2', 'step', '主人 A：商店 → 我上架的 → 下架');
    await admin.waitForSelector('[data-sticker-filter]', { timeout: 20000 });
    await admin.locator('[data-sticker-filter]').getByText(/^我上架的/).click();
    await admin.waitForSelector(`[data-unpublish="${setId}"]`, { timeout: 15000 });
    await admin.click(`[data-unpublish="${setId}"]`);
    await sleep(600);
    await shot(admin, 'A12-unpublish-confirm.png');
    await admin.getByRole('button', { name: '下架' }).last().click();
    await admin.waitForSelector('[data-my-published-empty]', { timeout: 15000 });
    await admin.locator('[data-sticker-filter]').getByText(/^全部/).click();
    await sleep(800);
    await shot(admin, 'A13-after-unpublish-shelf.png');
    note('A2-shelf-after-unpublish', await cards(admin));
    note('market-index-after-unpublish', (await raw('market-07-index-after-unpublish.txt', `${MARKET}/v1/sticker-catalog.json`)).body);
    mark('runA2', 'check', '下架后商店只剩 5 组官方表情包');
    videos.runA2 = await admin.video()?.path();
    await app.close();
    note('errors-runA2', errors);
  } finally {
    for (const id of agents) {
      try { lh('agent', 'delete', id, '--yes'); note('cleanup', `agent ${id} deleted`); } catch (e) { note('cleanup-error', String(e.message).slice(0, 200)); }
    }
    srv.kill();
    const chapters = {};
    for (const [run, file] of Object.entries(videos)) chapters[run] = { file, chapters: marks.filter((m) => m.win === run).map((m) => ({ kind: m.kind, t: Math.max(0, Math.round((m.wall - starts[run]) * 100) / 100), [m.kind === 'step' ? 'label' : 'note']: m.text })) };
    fs.writeFileSync(path.join(OUT, 'chapters.json'), JSON.stringify(chapters, null, 2));
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(log, null, 2));
  }
})().catch((e) => { console.error(e); fs.writeFileSync(path.join(OUT, 'evidence-failed.txt'), String(e.stack || e)); process.exit(1); });
