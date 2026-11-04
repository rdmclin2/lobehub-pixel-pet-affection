'use strict';
// End-to-end suite: drives the real Electron app with Playwright.
//   scenario "fresh"  -> fake `lh` that starts logged-out (exercises the login flow)
//   scenario "live"   -> the real `lh` CLI against LobeHub (creates and deletes a real agent)
//   scenario "latency" -> 聊天窗口 vs 桌面 测速 (e2e/chat-latency.js, real LobeHub, not in `all`): `node e2e/run.js latency <label>`
//   scenario "stream" -> 流式回复: a fake lh that prints the reply piece by piece; the bubble grows, then corrects
//   scenario "wardrobepack" -> 衣柜按角色隔离 (T-2752/T-2764/T-2784): 「大肥鱼 · 像素」 and 「大肥鱼 · Live2D」 are two characters in 角色图鉴; each one's 衣柜 is a card list of her own outfits (try on, 穿上, 正在穿, 新, 成人), unsupported outfits refused
//   scenario "catalogdl" -> 内置与下载: a new install offers the 5 pixel characters; the others are downloaded from 商店 (progress, sha256, 原版动画 clips, 删除下载 → 需要下载 notice)
//   scenario "store" -> 商店 → 舞蹈 / VRM 角色: every store dance (cover, credit, 有音乐), downloading one; the VRM models with their license; a VRM in parts (sha256 refusal), worn; dancing the store dance with its music
//   scenario "charmigrate" -> 旧数据迁移 (T-2786): an old 大肥鱼 + 形象包 dafeiyu-pixel save (outfit, 取景, VRM posture, ♥, imported pack) opens as 「大肥鱼 · 像素」, a 2nd start migrates nothing, 角色图鉴 / 衣柜 cards / switching do not leak
//   scenario "admincov" -> 配置后台覆盖度: every kind of pack in 角色图鉴 (filter, detail tabs), 衣柜 / Live2D size / 找回桌宠 / 自动检查更新 / 数据目录, a behaviour change showing in the pet window
//   scenario "admin"  -> 配置后台: the settings window (single instance), every page light + dark, a change taking effect in the pet window, roster
//   scenario "design" -> the design-system preview (admin bundle, @lobehub/ui) in light + dark, offline under CSP
//   scenario "petui"  -> the pet window UI (bubble, HUD, chat box, food menu, toast) in light + dark (LobeHub tokens)
//   scenario "frontslim" -> 前台精简 (T-2718): only ⚙ in the pet window; every old ⋯ menu item clicked in the settings window
//   scenario "chatui" -> 设置窗口 → 聊天: one conversation per character, end to end (fake lh + fake Responses SSE)
//   scenario "admin-chat" -> 设置窗口 → 聊天 acceptance: the chatui walk (fake) + a real companion talked to through the same page
//   scenario "asr"    -> 语音输入: fake microphone (a WAV) → MediaRecorder → a mock whisper server → the chat box
//   scenario "interject" -> 插个嘴: off → no jev call; on + mock jev 0.86 → a remark with 别插嘴 / 说得好; 别插嘴 → rule → same kind skipped; rules UI
//   scenario "voicehotkey" -> 快捷键唤起语音对话: the global shortcut → pet shown, listening, recognised; settings window records / refuses combinations
// Run on a headless box with:  xvfb-run -a node e2e/run.js [fresh|live|all]
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'e2e');
const FAKE_LH = path.join(ROOT, 'test', 'fixtures', 'fake-lh.js');
const which = process.argv[2] || 'all';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const logLines = [];
const say = (l) => { logLines.push(l); console.log(l); };
let shotN = 0;

async function step(scenario, name, fn, page) {
  const t0 = Date.now();
  const rec = { scenario, name, status: 'pass', ms: 0, shot: null, note: '' };
  try {
    rec.note = (await fn()) || '';
  } catch (e) {
    rec.status = 'fail';
    rec.note = String(e.message).split('\n').filter(Boolean).slice(0, 4).join(' ').slice(0, 300);
    if (process.env.PIXELPET_E2E_VERBOSE) console.error(e);
  }
  rec.ms = Date.now() - t0;
  const pg = typeof page === 'function' ? page() : page;
  if (pg) {
    const f = `${String(++shotN).padStart(2, '0')}-${scenario}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}.png`;
    try {
      await pg.screenshot({ path: path.join(OUT, f) });
      rec.shot = f;
    } catch { /* window may be gone */ }
  }
  results.push(rec);
  say(`${rec.status === 'pass' ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${rec.note ? ' — ' + rec.note : ''}`);
  return rec.status === 'pass';
}

// T-2718 (前台精简) removed the pet window's ⋯ menu and its panels (角色列表 / her page / 衣柜 / 话题 / 聊天记录).
// Scenarios written against those panels are skipped (recorded as SKIP, not PASS) until they are ported to the
// settings window; `instead` names the scenarios that cover the same feature there now.
function retiredScenario(scenario, instead) {
  const rec = { scenario, name: 'skipped: drove the removed in-pet panels (T-2718)', status: 'skip', ms: 0, shot: null, note: `covered in the settings window by: ${instead}` };
  results.push(rec);
  say(`SKIP  [${scenario}] ${rec.name} — ${rec.note}`);
}

// Scenarios other than the age-gate ones start with the gate already answered ("all ages"), the same
// state an existing user is in. `gate: true` leaves settings.json alone so the first-launch gate shows.
async function launch(env, { gate = false, video = null, args = [], videoSize = { width: 460, height: 540 } } = {}) {
  const dir = env && env.PIXELPET_DATA_DIR;
  if (dir && !gate && !fs.existsSync(path.join(dir, 'settings.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  }
  // software WebGL: xvfb has no GPU, and 全动态 looks (rig.js) need WebGL (without it they show a still picture)
  // only the five pixel characters ship (core/catalog.js); the scenarios that are not about downloading find
  // every other look already downloaded (src/main/packs.js PIXELPET_CATALOG_PREINSTALLED). `catalogdl` passes ''.
  const app = await _electron.launch({ args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...args], cwd: ROOT, env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_CATALOG_PREINSTALLED: path.join(ROOT, 'catalog'), ...env }, ...(video ? { recordVideo: { dir: video, size: videoSize } } : {}) });
  app.stderrBuf = '';
  app.process().stderr.on('data', (d) => { app.stderrBuf += d; });
  const page = await app.firstWindow();
  page.on('dialog', (d) => { page.lastDialog = d.message(); d.accept(); });
  return { app, page };
}

// The controls only exist visually while the pointer is over the window.
const hover = async (page) => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
const clickAct = async (page, act) => { await hover(page); await page.click(`[data-act="${act}"]`); };
// ⋯ → 角色列表, optionally opening `id`'s page (her model, look and affection), as a user clicks it.
const openCharPage = async (page, id) => {
  await page.click(`.char-list .char-opt[data-species="${id}"] .char-open`);
  await page.waitForSelector(`#char-head .char-opt[data-species="${id}"]`);
};
const openCharacters = async (page, id = null) => {
  await clickAct(page, 'menu');
  await page.click('[data-menu="characters"]');
  await page.waitForSelector('.char-list .char-opt');
  await page.waitForFunction(() => window.innerWidth >= 400, null, { timeout: 5000 }); // the window grows to the 460 px panel
  if (id) await openCharPage(page, id);
};
// The current character's page in 角色列表.
const openCurrentPage = async (page) => {
  await openCharacters(page);
  await openCharPage(page, await page.getAttribute('.char-list .char-opt.on', 'data-species'));
};
// ⋯ → 角色列表 → pick a character (in the list or on her page). One not met yet is named first (`name`; null keeps her own) and gets her own agent.
const pickCharacter = async (page, id, name = null) => {
  await page.click(`.char-opt[data-species="${id}"] .pick`);
  if (await page.locator(`.char-opt.new[data-species="${id}"]`).count()) {
    await page.waitForSelector('.char-name-form input');
    if (name !== null) await page.fill('.char-name-form input', name);
    await page.click('.char-name-form button[type="submit"]');
  }
  await page.waitForSelector(`.char-opt.on[data-species="${id}"]`, { timeout: 20000 });
};
// 配置后台 (the settings window): opened the way ⋯ → 设置… / Ctrl+, open it, at `route` ('tts', 'characters/grok' …).
// Single instance: a second call brings the same window to `route`. Its page is told apart by the admin-ui URL.
async function openAdminWindow(app, page, route = 'overview') {
  await page.evaluate((r) => window.pet.openAdmin(r), route);
  let admin = null;
  for (let i = 0; i < 300 && !admin; i++) { // up to 30 s: a cold start under load (parallel runs) takes a while
    admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
    if (!admin) await new Promise((r) => setTimeout(r, 100));
  }
  if (!admin) throw new Error('the settings window did not open');
  await admin.waitForSelector(`[data-path="/${route}"]`, { timeout: 15000 });
  return admin;
}
// The settings window sits behind the always-on-top pet and gets few frames: poll with evaluate, not waitFor*.
async function adminUntil(admin, fn, arg, ms = 15000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    if (await admin.evaluate(fn, arg).catch(() => false)) return;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
// Click a button in the settings window by its text, then the confirm dialog's `okText` (危险操作 ask twice).
async function adminClickConfirm(admin, text, okText = text) {
  await adminUntil(admin, (t) => [...document.querySelectorAll('[data-admin-page] button')].some((b) => (b.textContent || '').trim().includes(t) && !b.disabled), text, 15000, `button ${text}`);
  await admin.evaluate((t) => [...document.querySelectorAll('[data-admin-page] button')].find((b) => (b.textContent || '').trim().includes(t) && !b.disabled).click(), text);
  if (!okText) return;
  await adminUntil(admin, (t) => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].some((b) => (b.textContent || '').trim() === t), okText, 8000, `confirm ${okText}`);
  await admin.evaluate((t) => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].filter((b) => (b.textContent || '').trim() === t).pop().click(), okText).catch(() => {});
}
// A switch (data-key) in the settings window; `okText`: its confirm dialog when switching on asks first.
async function adminFlip(admin, key, okText = null) {
  await adminUntil(admin, (k) => !!document.querySelector(`[data-key="${k}"]`), key, 15000, `switch ${key}`);
  await admin.evaluate((k) => { const el = document.querySelector(`[data-key="${k}"]`); (el.matches('button') ? el : el.querySelector('button')).click(); }, key);
  if (!okText) return;
  await adminUntil(admin, (t) => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].some((b) => (b.textContent || '').trim() === t), okText, 8000, `confirm ${okText}`);
  await admin.evaluate((t) => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].filter((b) => (b.textContent || '').trim() === t).pop().click(), okText);
}
// 设置 → 数据与关于 → 放生并删除 agent / 仅重置本地 (the old ⋯ menu items, T-2718), confirmed; the pet window
// goes back to choosing a character.
async function adminRelease(app, page, deleteAgent = true) {
  const admin = await openAdminWindow(app, page, 'about');
  const t = deleteAgent ? '放生并删除 agent' : '仅重置本地';
  await adminClickConfirm(admin, t, t);
  return admin;
}
// One setting through the settings window's bridge: the same admin-set its forms call (checked in main, saved by
// core/settings.js, broadcast to every window). -> { ok, reason?, message?, value, settings }
const adminSet = (admin, key, value) => admin.evaluate(([k, v]) => window.petAdmin.set(k, v), [key, value]);
// The pet window (BrowserWindow.getAllWindows() also lists the settings window once it is open)
const petBounds = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('admin-ui') && !w.webContents.getURL().includes('visitor=')).getBounds());
const hudOpacity = (page) => page.evaluate(() => getComputedStyle(document.getElementById('hud')).opacity);
// Hands real on-disk files to the page as a drop: an <input type=file> gives File objects that carry real
// paths, so webUtils.getPathForFile resolves them exactly like a file dragged from Finder.
async function dropFiles(page, paths) {
  await page.evaluate(() => { document.getElementById('__drop') || document.body.insertAdjacentHTML('beforeend', '<input id="__drop" type="file" multiple style="position:fixed;left:-999px">'); });
  await page.setInputFiles('#__drop', paths);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    for (const f of document.getElementById('__drop').files) dt.items.add(f);
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
}
const bubbleSource = (page) => page.evaluate(() => document.getElementById('bubble').dataset.source);
const bubbleText = (page) => page.evaluate(() => { const b = document.getElementById('bubble'); return b.classList.contains('hidden') ? '' : b.textContent; });
async function waitReply(page, timeout = 90000) {
  await page.waitForFunction(() => {
    const b = document.getElementById('bubble');
    return !b.classList.contains('hidden') && !b.classList.contains('thinking') && b.textContent.trim().length > 0 && b.textContent !== '……';
  }, null, { timeout });
  return bubbleText(page);
}
const view = (page) => page.evaluate(async () => (await window.pet.boot()).view);
// 部位触摸: a click point on every body part she shows, found by asking the page's own click mapping
// (window.petFx.touchPoint) over a grid on her art: per part, the hit closest to the middle of its hits.
const zonePoints = (page) => page.evaluate(() => {
  const el = document.querySelector('#pet-body .pet-hit:not(.hidden)');
  const r = el.getBoundingClientRect();
  const hits = {};
  for (let y = r.top + 1; y < r.bottom; y += 3) {
    for (let x = r.left + 1; x < r.right; x += 3) {
      const p = window.petFx.touchPoint(x, y);
      if (p && p.zone) (hits[p.zone] = hits[p.zone] || []).push([x, y]);
    }
  }
  const out = {};
  for (const [zone, pts] of Object.entries(hits)) {
    const mx = pts.reduce((n, p) => n + p[0], 0) / pts.length;
    const my = pts.reduce((n, p) => n + p[1], 0) / pts.length;
    const best = pts.reduce((b, p) => (Math.hypot(p[0] - mx, p[1] - my) < Math.hypot(b[0] - mx, b[1] - my) ? p : b));
    out[zone] = { x: Math.round(best[0]), y: Math.round(best[1]), n: pts.length };
  }
  return out;
});
// "Click her" from before body parts: a friendly touch worth the same +1 a pat gave, on her head and
// her hands in turn (poking one spot three times within 8 s annoys her and scores nothing).
let friendlyPart = 'hands';
const clickHead = async (page) => {
  friendlyPart = friendlyPart === 'head' ? 'hands' : 'head';
  const p = (await zonePoints(page))[friendlyPart];
  await page.mouse.click(p.x, p.y);
};
const lhEnv = { ...process.env };
for (const k of ['LOBEHUB_TOPIC_ID', 'LOBEHUB_OPERATION_ID', 'LOBEHUB_AGENT_ID', 'LOBEHUB_ASSISTANT_MESSAGE_ID', 'LOBEHUB_WORKSPACE_ID']) delete lhEnv[k]; // the live pet lives in the personal space
lhEnv.LOBEHUB_JWT = '';
const lh = (...a) => execFileSync('lh', a, { env: lhEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// ---------------------------------------------------------------- fresh
async function fresh() {
  const S = 'fresh';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-data-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-fake-'));
  // a new install: nothing downloaded yet (only the five pixel characters ship, core/catalog.js)
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, FAKE_LH_LOGIN_MS: '2500', PIXELPET_CATALOG_PREINSTALLED: '' };
  let { app, page } = await launch(env);
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  try {
    await step(S, 'first launch offers the five pixel characters that ship with the app, one card each', async () => {
      await page.waitForSelector('.char-card');
      // the other looks (旧版像素, Live2D, 全动态, 原版动画, 成年版) are downloaded later from 角色图鉴
      assert.equal(await page.locator('.char-card').count(), 5);
      assert.deepEqual(await page.locator('.char-card').evaluateAll((els) => els.map((e) => e.dataset.character)), ['dafeiyu-pixel', 'claude-pixel', 'grok-pixel', 'gemini-pixel', 'gpt-pixel']);
      assert.match(await page.locator('.char-card[data-character="dafeiyu-pixel"] .nm').textContent(), /大肥鱼 · 像素/);
      assert.equal(await page.locator('#hatch-btn').isDisabled(), true);
    }, page);

    await step(S, 'choosing a character enables waking her and shows who she is', async () => {
      await page.locator('.char-card[data-species="grok"]').first().click();
      assert.equal(await page.locator('#hatch-btn').isDisabled(), false);
      assert.match(await page.locator('#card-info').textContent(), /xAI|格萝可/);
      await page.fill('#pet-name', '小蓝');
    }, page);

    await step(S, 'hatching invokes lh login and shows the device code', async () => {
      await page.click('#hatch-btn');
      await page.waitForSelector('#login-box:not(.hidden)', { timeout: 15000 });
      assert.equal((await page.textContent('#login-code')).trim(), 'ABCD-1234');
      assert.match(await page.textContent('#login-url'), /example\.com\/device/);
    }, page);

    await step(S, 'after login the agent is created and the pet appears', async () => {
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      assert.match(await page.textContent('#meta'), /小蓝 · 格萝可 · 像素 · 陌生 ♥\d+ · 距「熟悉」\d+/, 'her character name (T-2764)');
      const text = await waitReply(page, 15000);
      assert.match(text, /echo:/);
      return `greeting: ${text.slice(0, 40)}`;
    }, page);

    await step(S, 'CLI call order was whoami -> login -> workspaces -> agent create -> connect device -> bind -> models -> set model -> agent run', async () => {
      const calls = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
      const all = calls.map((a) => (a[0] === 'agent' || a[0] === 'workspace' ? `${a[0]} ${a[1]}` : a[0]));
      // where to put the agent is asked right after login (workspace list + the pinned-scope check)
      const create = all.indexOf('agent create');
      assert.ok(all.slice(0, create).includes('workspace list') && all.slice(0, create).includes('workspace current'), all.join(', '));
      const seq = all.filter((c) => !c.startsWith('workspace '));
      // connect = status check, then `connect --daemon`; device = `device list`; provider + model = the user's models
      // (hosted + own OpenAI), then `agent edit -m -p` puts 格萝可 on her Grok default before her first words
      const want = ['whoami', 'login', 'whoami', 'whoami', 'agent create', 'connect', 'connect', 'device', 'agent edit', 'provider', 'model', 'model', 'agent edit', 'agent run'];
      assert.deepEqual(seq.slice(0, want.length), want);
      const created = JSON.parse(fs.readFileSync(path.join(fakeDir, 'last-create.json'), 'utf8'));
      assert.match(created.systemRole, /格萝可/);
      assert.match(created.title, /小蓝/);
    });

    await step(S, 'restart goes straight to the pet (state persisted, no onboarding)', async () => {
      await app.close();
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      assert.equal(await page.locator('.char-card').count() >= 0, true);
      assert.equal(await page.locator('#onboarding').isHidden(), true);
      assert.match(await page.textContent('#meta'), /小蓝/);
    }, () => page);

    await step(S, 'at rest only the pet is shown, with no buttons, bars or text box', async () => {
      assert.equal(await hudOpacity(page), '0');
      assert.equal(await page.evaluate(() => document.body.classList.contains('hover')), false);
      const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      assert.deepEqual([b.width, b.height], [268, 388], 'default 125%: window 268x388');
      return `window ${b.width}x${b.height}`;
    }, () => page);

    await step(S, 'hovering the pet reveals the controls and moving away hides them again', async () => {
      await hover(page);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '1');
      await page.screenshot({ path: path.join(OUT, 'hover-shown.png') });
      await page.mouse.move(-20, -20);
      await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
      await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '0', null, { timeout: 5000 });
    }, () => page);

    await step(S, 'feeding lowers hunger and shows food', async () => {
      await page.evaluate(() => window.pet.debugSet({ hunger: 80, sleeping: false, energy: 90 }));
      await clickAct(page, 'feed');
      await page.click('#food-menu .btn >> nth=0');
      await page.waitForTimeout(500);
      const v = await view(page);
      assert.ok(v.pet.hunger <= 50, `hunger ${v.pet.hunger}`);
      return `hunger 80 -> ${Math.round(v.pet.hunger)}`;
    }, () => page);

    await step(S, 'affection crossing 15 by a pat moves the stage from 陌生 to 熟悉 and unlocks topics', async () => {
      await page.evaluate(() => window.pet.debugSet({ affection: 14, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await hover(page);
      assert.match(await page.textContent('#meta'), /陌生 ♥14 · 距「熟悉」1/);
      fs.writeFileSync(path.join(OUT, 'stage-before.png'), await page.screenshot());
      const events = [];
      await page.exposeFunction('__affLog', (e) => events.push(e));
      await page.evaluate(() => window.pet.onAffection((e) => window.__affLog({ type: e.type, stage: e.stage, delta: e.delta, unlocks: e.unlocks })));
      await clickHead(page);
      await page.waitForFunction(() => /熟悉 ♥15/.test(document.getElementById('meta').textContent), null, { timeout: 5000 });
      await page.waitForTimeout(800);
      const v = await view(page);
      assert.equal(v.pet.relStage, 'familiar');
      assert.equal(v.affection.stageName, '熟悉');
      assert.ok(v.topics.find((t) => t.id === 'riddle').unlocked);
      const up = events.find((e) => e.type === 'stage-up');
      assert.ok(up, JSON.stringify(events));
      assert.deepEqual(up.unlocks.topics.map((t) => t.id), ['hobby', 'gossip', 'riddle']);
      await hover(page);
      return `meta: ${await page.textContent('#meta')}; stage-up event unlocks: ${up.unlocks.topics.map((t) => t.label).join('、')}`;
    }, () => page);

    await step(S, 'topics: a locked topic returns its unlock condition, an unlocked one is sent to the agent with [话题]', async () => {
      await idle();
      const locked = await page.evaluate(() => window.pet.talkTopic('whine'));
      assert.equal(locked.reason, 'locked');
      assert.match(locked.condition, /亲近（♥35）解锁，还差 20/);
      const ok = await page.evaluate(() => window.pet.talkTopic('riddle'));
      assert.equal(ok.ok, true);
      const run = fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
      assert.match(run.prompt, /\[关系\] 阶段=熟悉；成人向=关，只用全年龄语气/);
      assert.match(run.prompt, /\[话题\] 脑筋急转弯：/);
      fs.writeFileSync(path.join(OUT, 'topic-prompt.txt'), `locked: ${JSON.stringify(locked)}\n\nprompt sent for riddle:\n${run.prompt}\n`);
      await hover(page);
      return `locked whine -> ${locked.condition}; riddle +${ok.affection.delta}`;
    }, () => page);

    await step(S, 'restart keeps affection, stage and unlocked topics', async () => {
      const before = await view(page);
      await app.close();
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      const v = await view(page);
      assert.equal(v.pet.affection, before.pet.affection);
      assert.equal(v.pet.relStage, 'familiar');
      assert.deepEqual(v.pet.unlockedTopics, before.pet.unlockedTopics);
      await hover(page);
      assert.match(await page.textContent('#meta'), /熟悉 ♥\d+/);
      return `after restart: ${await page.textContent('#meta')}`;
    }, () => page);

    // 成人向内容 lives in 设置 → 内容与安全 now (T-2718): without an 18+ answer, switching it on asks the same
    // 18+ question first; declining keeps it off
    await step(S, 'without an 18+ answer the adult switch is off and only opens the 18+ confirmation', async () => {
      const admin = await openAdminWindow(app, page, 'safety');
      await adminUntil(admin, () => document.querySelector('[data-key="adultContent"]')?.getAttribute('aria-checked') === 'false', null, 10000, 'adult switch off');
      await admin.screenshot({ path: path.join(OUT, 'adult-switch-needs-18.png') });
      await adminFlip(admin, 'adultContent');
      await adminUntil(admin, () => [...document.querySelectorAll('[role="dialog"], .ant-modal')].some((d) => /年满 18 周岁/.test(d.textContent)), null, 8000, 'the 18+ question');
      await admin.screenshot({ path: path.join(OUT, 'adult-switch-reopens-gate.png') });
      await admin.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].filter((b) => (b.textContent || '').trim() === '取消').pop().click());
      await admin.waitForTimeout(500);
      const v = await view(page);
      assert.equal(v.settings.adultContent, false);
      assert.ok(v.outfits.every((o) => o.rating === 'all'));
      await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('admin-ui')) w.destroy(); });
    }, () => page);

    await step(S, 'release deletes the agent through lh and returns to character selection', async () => {
      await adminRelease(app, page, true); // 设置 → 数据与关于 → 放生并删除 agent（二次确认）
      await page.waitForSelector('#onboarding:not(.hidden)', { timeout: 15000 });
      const calls = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
      const del = calls.find((a) => a[0] === 'agent' && a[1] === 'delete');
      assert.ok(del && del[2].startsWith('agt_FAKE') && del.includes('--yes'), 'lh agent delete <id> --yes was not called');
      fs.writeFileSync(path.join(OUT, 'release-check.txt'), `$ ${del.length ? 'lh ' + del.join(' ') : ''}\n(recorded by the fake lh CLI used in this scenario; the app asked for the agent to be deleted, then returned to character selection)\n`);
    }, () => page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------- wardrobe
// The affection UI end to end on the real app: first-launch 18+ gate -> a pet -> interaction raises
// affection -> stage-up notice naming the unlocked topics and outfits -> wardrobe with locked items ->
// changing clothes -> restart keeps the outfit -> adult switch off. The companion is 大肥鱼 (DeepSeek):
// like every model-chan she is all-ages, so the adult tiers never appear even with 18+ on.
// Named screenshots go to out/e2e/affection-ui/.
async function wardrobe() {
  return retiredScenario('wardrobe', 'frontslim F5 (toast → 衣柜 on her page, equip), admin a13 (her stage / 装扮)');
  const S = 'wardrobe';
  const SHOTS = path.join(OUT, 'affection-ui');
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wardrobe-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wardrobe-fake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  const VIDEO = path.join(SHOTS, 'video');
  fs.rmSync(VIDEO, { recursive: true, force: true });
  let { app, page } = await launch(env, { gate: true, video: VIDEO });
  const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  // the current character's entry in pet.json (schema 3: `characters[speciesId]`)
  const petJson = () => { const p = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8')); return p.characters[p.speciesId]; };
  const restartLog = [];
  const openWardrobe = async () => {
    await clickAct(page, 'wardrobe');
    await page.waitForSelector('#panel:not(.hidden) .card');
    await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
  };
  const closePanel = async () => {
    await page.click('#panel-close');
    await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 }); // back from the 460 px panel to the pet window (its width follows the pet size)
  };
  const cardStatus = (id) => page.textContent(`.card[data-outfit="${id}"] .st`);
  try {
    await step(S, 'first launch asks for 18+ before anything else', async () => {
      await page.waitForSelector('#age-gate:not(.hidden)', { timeout: 15000 });
      assert.equal(await page.locator('#onboarding').isHidden(), true);
      assert.match(await page.textContent('#age-gate'), /是否已年满 18 周岁/);
      return await shot('01-age-gate-first-launch');
    });

    await step(S, 'answering 18+ goes on to companion selection and saves the answer', async () => {
      await page.click('#age-yes');
      await page.waitForSelector('#onboarding:not(.hidden)');
      const st = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
      assert.equal(st.ageConfirmed, true);
      assert.equal(st.adultContent, true);
      await page.locator('.char-card[data-species="dafeiyu"]').first().click();
      await page.fill('#pet-name', '小蓝');
      assert.match(await page.textContent('#card-info'), /DeepSeek|大肥鱼/);
      const a = await shot('01b-new-pet-choose-companion');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await idle();
      await hover(page);
      assert.match(await page.textContent('#meta'), /小蓝 · 大肥鱼/);
      const b = await shot('01c-new-pet-created');
      return `${a}, ${b} · settings.json: ${JSON.stringify(st)}`;
    });

    await step(S, 'initial state: affection bar, number, stage name and distance to the next stage', async () => {
      await hover(page);
      assert.equal((await page.textContent('#aff-stage')).trim(), '陌生');
      assert.equal((await page.textContent('#aff-num')).trim(), '♥0/100');
      assert.match(await page.textContent('#meta'), /小蓝 · 大肥鱼 · 陌生 ♥0 · 距「熟悉」15/);
      assert.equal(petJson().equippedOutfit, 'daily');
      return `${await shot('02-initial-state')} · meta: ${await page.textContent('#meta')}`;
    });

    await step(S, 'a pat raises affection: the number goes up and +♥ floats over the pet', async () => {
      await clickHead(page);
      await page.waitForSelector('.float');
      const float = await page.textContent('.float');
      await hover(page);
      await page.waitForFunction(() => !/♥0\//.test(document.getElementById('aff-num').textContent));
      const f = await shot('03-affection-up');
      assert.match(float, /^\+\d+(\.\d)? ♥$/); // first interaction of the day: +3 greet bonus, +1 pat (x1.2 when happy)
      assert.ok((await view(page)).pet.affection >= 4);
      return `${f} · float "${float}" · meta: ${await page.textContent('#meta')}`;
    });

    await step(S, 'crossing 15 moves 陌生 -> 熟悉 and a notice names the unlocked topics and the three 熟悉 outfits', async () => {
      // Test hook: 14 points (a day's cap is 12, so reaching 15 by hand takes two days); the pat that crosses is real.
      await page.evaluate(() => window.pet.debugSet({ affection: 14, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await hover(page);
      await clickHead(page);
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 5000 });
      await idle();
      await page.waitForTimeout(800); // let the stage-up flash fade
      await hover(page);
      const toast = await page.textContent('#unlock-toast');
      assert.match(toast, /关系升级：熟悉（♥15）/);
      assert.match(toast, /解锁话题：「聊聊爱好」、「奇怪的冷知识」、「脑筋急转弯」/);
      assert.match(toast, /解锁服饰：「休闲卫衣」、「贝雷帽画家装」、「偶像演出服」/);
      assert.equal((await page.textContent('#toast-open')).trim(), '去衣柜看看');
      return `${await shot('04-stage-up-unlock-notice')} · ${toast.replace(/\s+/g, ' ').trim()}`;
    });

    await step(S, 'the notice leads to the wardrobe: her signature maid outfit, in pixels, the 陌生 and 熟悉 outfits to wear, 运动泳装 locked until 亲近 and 沙滩比基尼 until 知己', async () => {
      await page.click('#toast-open');
      await page.waitForSelector('#panel:not(.hidden) .card[data-outfit="daily"]');
      assert.deepEqual(await page.$$eval('.card', (cs) => cs.map((c) => c.dataset.outfit)), ['daily', 'scarf', 'casual', 'beret', 'idol', 'pajamas', 'cat_ears', 'swimsuit', 'yukata', 'bikini', 'qipao', 'couple_hoodie', 'flower_crown'], 'DeepSeek: her signature outfit and the twelve all-ages outfits');
      assert.equal(await page.locator('.card.locked').count(), 8, 'all but daily, 针织围巾套装 (陌生) and the three 熟悉 outfits');
      for (const id of ['scarf', 'casual', 'beret', 'idol']) assert.equal(await cardStatus(id), '点击穿上', id);
      assert.match(await cardStatus('swimsuit'), /^🔒 亲近（♥35）解锁/);
      assert.match(await cardStatus('bikini'), /^🔒 知己（♥60）解锁/);
      assert.equal(await cardStatus('daily'), '✓ 穿着中');
      assert.equal(await page.textContent('.card[data-outfit="daily"] .nm'), '招牌女仆装');
      assert.equal(await page.locator('.card[data-outfit="daily"] canvas.sprite').count(), 1, 'drawn from her pixel pack');
      assert.equal(await page.locator('.card[data-outfit="maid"]').count(), 0, 'no adult outfit, even with 18+ on: model-chan are all-ages');
      const a = await shot('05-wardrobe-signature-only');
      await closePanel();
      return a;
    });

    await step(S, 'the topic panel marks locked topics with their unlock condition', async () => {
      await clickAct(page, 'topics');
      await page.waitForSelector('#panel:not(.hidden) .topic');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.textContent('.topic[data-topic="riddle"] .st'), '点击聊聊');
      assert.equal(await page.textContent('.topic[data-topic="whine"] .st'), '🔒 亲近（♥35）解锁，还差 20');
      assert.equal(await page.locator('.topic[data-topic="tease"]').count(), 0, 'no adult topic for an all-ages character');
      assert.match(await page.textContent('.topic[data-topic="secret"] .st'), /🔒 知己（♥60）解锁/);
      return await shot('09-topics-with-locked-items');
    });

    await step(S, 'a topic unlocked at 熟悉 can be started: the agent gets it and the pet answers', async () => {
      await page.click('.topic[data-topic="riddle"]');
      await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 }); // back from the 460 px panel to the pet window (its width follows the pet size)
      const b = await waitReply(page, 15000);
      await idle();
      const runs = fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const last = runs[runs.length - 1].prompt;
      assert.match(last, /\[话题\] 脑筋急转弯/);
      assert.match(last, /阶段=熟悉/);
      assert.match(b, /脑筋急转弯/);
      return `${await shot('10-unlocked-topic-started')} · bubble: ${b.slice(0, 80)}`;
    });

    await step(S, 'crossing 35 by a pat moves 熟悉 -> 亲近 and unlocks the next topics and outfits', async () => {
      // Test hook: 34 points with today's counters reset; the pat that crosses 35 is real.
      await page.evaluate(() => window.pet.debugSet({ affection: 34, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await hover(page);
      await clickHead(page);
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 5000 });
      await idle();
      await page.waitForTimeout(800);
      await hover(page);
      const toast = await page.textContent('#unlock-toast');
      assert.match(toast, /关系升级：亲近（♥35）/);
      assert.match(toast, /解锁话题：「求安慰 \/ 打气」、「给彼此起昵称」、「撒娇模式」、「说说昨晚的怪梦」/);
      assert.match(toast, /解锁服饰：「毛绒睡衣」、「猫耳家居服」、「运动泳装」/);
      const f = await shot('11-stage-up-close');
      await page.click('#toast-close');
      return `${f} · ${toast.replace(/\s+/g, ' ').trim()}`;
    });

    await step(S, 'crossing 60 by a pat moves 亲近 -> 知己: an all-ages character unlocks no adult topics or outfits, even with 18+ on', async () => {
      await page.evaluate(() => window.pet.debugSet({ affection: 59, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await hover(page);
      await clickHead(page);
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 5000 });
      await idle();
      await page.waitForTimeout(800);
      await hover(page);
      const toast = await page.textContent('#unlock-toast');
      assert.match(toast, /关系升级：知己（♥60）/);
      assert.equal((await page.textContent('#toast-body')).trim(), '解锁话题：「交换小秘密」、「深夜谈心」解锁服饰：「浴衣」、「沙滩比基尼」、「长旗袍」', 'only all-ages outfits, no adult one');
      return `${await shot('12-stage-up-flirty')} · ${toast.replace(/\s+/g, ' ').trim()}`;
    });

    await step(S, 'the topic panel now offers the 知己 topics; 挚友 topics stay locked', async () => {
      await page.click('#toast-close');
      await clickAct(page, 'topics');
      await page.waitForSelector('#panel:not(.hidden) .topic');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.textContent('.topic[data-topic="secret"] .st'), '点击聊聊');
      assert.match(await page.textContent('.topic[data-topic="promise"] .st'), /🔒 挚友（♥85）解锁/);
      await page.locator('.topic[data-topic="secret"]').scrollIntoViewIfNeeded();
      const f = await shot('13-topics-flirty-unlocked');
      await closePanel();
      return f;
    });

    await step(S, 'restart: the app is closed and relaunched; affection, stage, unlocks and the outfit are kept', async () => {
      const before = await view(page);
      const pid0 = app.process().pid;
      restartLog.push(`$ PIXELPET_DATA_DIR=${data} electron . --no-sandbox   # launched by e2e/run.js (Playwright _electron.launch)`);
      restartLog.push(`[${new Date().toISOString()}] running app pid=${pid0}`);
      const pj = petJson();
      restartLog.push(`[${new Date().toISOString()}] pet.json before close: affection=${pj.affection} relStage=${pj.relStage} peakStage=${pj.peakStage} equippedOutfit=${pj.equippedOutfit} lastSafeOutfit=${pj.lastSafeOutfit}`);
      restartLog.push(`[${new Date().toISOString()}] view before close: stage=${before.affection.stageName} ♥${before.affection.value}; unlocked topics ${before.topics.filter((t) => t.unlocked).length}/${before.topics.length}; unlocked outfits ${before.outfits.filter((o) => o.unlocked).length}/${before.outfits.length}`);
      await app.close();
      let alive = true;
      try { process.kill(pid0, 0); } catch { alive = false; }
      restartLog.push(`[${new Date().toISOString()}] app.close() done; process ${pid0} alive=${alive}`);
      ({ app, page } = await launch(env, { video: VIDEO }));
      const pid1 = app.process().pid;
      restartLog.push(`[${new Date().toISOString()}] relaunched app pid=${pid1} (same data dir)`);
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      const v = await view(page);
      restartLog.push(`[${new Date().toISOString()}] view after restart: stage=${v.affection.stageName} ♥${v.affection.value}; outfit=${v.outfit}; unlocked topics ${v.topics.filter((t) => t.unlocked).length}/${v.topics.length}; unlocked outfits ${v.outfits.filter((o) => o.unlocked).length}/${v.outfits.length}`);
      assert.notEqual(pid1, pid0);
      assert.equal(alive, false);
      assert.equal(v.outfit, 'daily');
      assert.equal(v.affection.value, before.affection.value);
      assert.equal(v.affection.stageName, '知己');
      assert.deepEqual(v.topics.map((t) => [t.id, t.unlocked]), before.topics.map((t) => [t.id, t.unlocked]));
      assert.deepEqual(v.outfits.map((o) => [o.id, o.unlocked]), before.outfits.map((o) => [o.id, o.unlocked]));
      await hover(page);
      assert.equal(await page.locator('#outfit-badge').count(), 0, 'no outfit tag over the pet');
      assert.match(await page.textContent('#meta'), /知己 ♥60/);
      const a = await shot('16-after-restart-pet');
      await openWardrobe();
      assert.equal(await cardStatus('daily'), '✓ 穿着中');
      assert.equal(await page.locator('.card.locked').count(), 2, 'only the two 挚友 outfits stay locked at 知己');
      const b = await shot('17-after-restart-wardrobe');
      await closePanel();
      await clickAct(page, 'topics');
      await page.waitForSelector('#panel:not(.hidden) .topic');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.textContent('.topic[data-topic="secret"] .st'), '点击聊聊');
      const c = await shot('18-after-restart-topics');
      await closePanel();
      fs.writeFileSync(path.join(SHOTS, 'restart-log.txt'), restartLog.join('\n') + '\n');
      return `${a}, ${b}, ${c} · pid ${pid0} -> ${pid1}`;
    });

    await step(S, 'adult switch off: nothing adult was shown, so the all-ages character keeps her outfit and stage', async () => {
      await clickAct(page, 'menu');
      assert.equal((await page.textContent('#menu-adult')).trim(), '成人向内容：开（点此关闭）');
      const m = await shot('19-menu-adult-switch-on');
      await page.click('#menu-adult');
      await page.waitForFunction(() => /成人向内容已关闭/.test(document.getElementById('bubble').textContent), null, { timeout: 5000 });
      const v = await view(page);
      assert.equal(v.outfit, 'daily');
      assert.equal(v.affection.stageName, '知己');
      assert.equal(petJson().equippedOutfit, 'daily');
      assert.deepEqual(v.topics.filter((t) => t.rating === 'adult'), []);
      assert.deepEqual(v.outfits.filter((o) => o.rating === 'adult'), []);
      await hover(page);
      const a = await shot('20-adult-off-pet-unchanged');
      await clickAct(page, 'menu');
      assert.equal((await page.textContent('#menu-adult')).trim(), '成人向内容：关（点此开启）');
      const b = await shot('21-menu-adult-switch-off');
      await page.locator('#main-menu').evaluate((el) => el.classList.add('hidden'));
      await openWardrobe();
      assert.deepEqual(await page.$$eval('.card', (cs) => cs.map((c) => c.dataset.outfit)), ['daily', 'scarf', 'casual', 'beret', 'idol', 'pajamas', 'cat_ears', 'swimsuit', 'yukata', 'bikini', 'qipao', 'couple_hoodie', 'flower_crown'], 'her all-ages outfits stay');
      assert.equal(await page.locator('.card[data-outfit="maid"]').count(), 0);
      assert.equal(await cardStatus('daily'), '✓ 穿着中');
      assert.doesNotMatch(await page.textContent('#panel'), /成人向|暧昧|恋人/);
      const c = await shot('22-wardrobe-adult-off-no-adult-items');
      await closePanel();
      await clickAct(page, 'topics');
      await page.waitForSelector('#panel:not(.hidden) .topic');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.locator('.topic').count(), 13);
      assert.equal(await page.locator('.topic[data-topic="tease"]').count(), 0);
      assert.doesNotMatch(await page.textContent('#panel'), /成人向|暧昧|恋人/);
      const d = await shot('23-topics-adult-off-all-ages-only');
      await closePanel();
      const stateBlock = (await view(page)).affection.stageName;
      return `${m}, ${a}, ${b}, ${c}, ${d} · stage shown as ${stateBlock} · bubble: ${await bubbleText(page)}`;
    });
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------- migrate
// A save from the growth-system version (xp / stage) is migrated on start: same pet, agent and topic.
async function migrate() {
  const S = 'migrate';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mig-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-migfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const now = Date.now();
  // a growth-system save of the retired whale 泡鲸 (bubbo)
  const old = { speciesId: 'bubbo', name: '小蓝', agentId: 'agt_LEGACY', topicId: 'tpc_LEGACY', createdAt: now - 86400000, stage: 'child', xp: 150, hunger: 30, mood: 70, energy: 90, sleeping: false, lastTickAt: now, lastInteractionAt: now, lastFedAt: now, lastSpokeAt: now, owner: 'me', personaVersion: 3 };
  fs.writeFileSync(path.join(data, 'pet.json'), JSON.stringify(old, null, 2));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, adultContent: false, appearance: { bubbo: 'bubbo-pixel' } }));
  let { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  try {
    await step(S, 'an old 泡鲸 xp=150 / child save opens as 大肥鱼 熟悉 ♥25 with the same agent and topic, and says who took over', async () => {
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await page.waitForFunction(() => /原来的角色已经下线/.test(document.getElementById('bubble').textContent), null, { timeout: 10000 });
      const bubble = await bubbleText(page);
      assert.match(bubble, /大肥鱼/);
      await hover(page);
      const meta = await page.textContent('#meta');
      assert.match(meta, /小蓝 · 大肥鱼 · 像素 · 熟悉 ♥25 · 距「亲近」10/);
      const v = await view(page);
      assert.equal(v.pet.speciesId, 'dafeiyu');
      assert.equal(v.pet.agentId, 'agt_LEGACY');
      assert.equal(v.pet.topicId, 'tpc_LEGACY');
      const disk = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
      assert.equal(disk.schemaVersion, 3);
      assert.equal(disk.speciesId, 'dafeiyu');
      assert.equal(disk.retiredFrom.speciesId, 'bubbo');
      assert.deepEqual(Object.keys(disk.characters), ['dafeiyu'], 'one character, the one who took over');
      assert.equal(disk.characters.dafeiyu.agentId, 'agt_LEGACY');
      assert.equal('xp' in disk.characters.dafeiyu, false);
      assert.equal('stage' in disk.characters.dafeiyu, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'pet.v1.bak.json'), 'utf8')), old);
      const st = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
      assert.equal(st.appearance, undefined, 'no 形象包 choice any more (T-2764)');
      assert.equal(st.characterModel, 2);
      assert.equal(disk.characterId, 'dafeiyu-pixel', 'the retired look (bubbo-pixel) → her default character');
      // the agent gets the new persona before its next turn
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const edits = fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.systemRole);
      assert.match(edits.pop().systemRole, /大肥鱼/);
      fs.writeFileSync(path.join(OUT, 'migrate-files.txt'), `--- pet.v1.bak.json (before) ---\n${JSON.stringify(old, null, 2)}\n\n--- pet.json (after) ---\n${JSON.stringify(disk, null, 2)}\n`);
      return `bubble: ${bubble}; meta: ${meta}; retiredFrom=${JSON.stringify(disk.retiredFrom)}`;
    }, page);

    await step(S, 'a current save of the retired 焰团 wearing an adult outfit opens as 克洛蒂 in her own outfit, without a crash', async () => {
      await app.close();
      const saved = { schemaVersion: 2, speciesId: 'embit', name: '小火', agentId: 'agt_EMBIT', topicId: 'tpc_EMBIT', createdAt: now - 1e6, affection: 70, relStage: 'flirty', peakStage: 'flirty', hunger: 30, mood: 60, energy: 90, sleeping: false, lastTickAt: now, lastInteractionAt: now, lastFedAt: now, lastSpokeAt: now, equippedOutfit: 'maid', lastSafeOutfit: 'yukata', personaVersion: 6 };
      fs.writeFileSync(path.join(data, 'pet.json'), JSON.stringify(saved, null, 2));
      ({ app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await page.waitForFunction(() => /克洛蒂/.test(document.getElementById('bubble').textContent), null, { timeout: 10000 });
      await hover(page);
      const v = await view(page);
      assert.equal(v.pet.speciesId, 'claude');
      assert.equal(v.outfit, 'daily');
      assert.equal(v.look.packId, 'claude-pixel');
      assert.equal(v.pet.affection, 70);
      assert.match(await page.textContent('#meta'), /小火 · 克洛蒂 · 像素 · 知己 ♥70/);
      assert.equal(await page.locator('#pet-look canvas.sprite').count(), 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'pet.retired.bak.json'), 'utf8')).speciesId, 'bubbo', 'the backup is written once and never overwritten');
      assert.doesNotMatch(app.stderrBuf, /Unknown species|TypeError/);
      return `meta: ${await page.textContent('#meta')}; outfit maid → ${v.outfit}`;
    }, page);

    // T-2764: 形象包 → 独立角色. A v0.21 settings.json (大肥鱼 wears her Live2D pack, half-body 取景 per persona,
    // 克洛蒂 visiting) and pet.json (大肥鱼 in the scarf) open as the character 「大肥鱼 · Live2D」, every per-persona
    // key moved to character ids, and a second start changes nothing.
    await step(S, 'T-2764: an old 形象包 choice opens as its own character, every per-character key migrated once (idempotent, backed up)', async () => {
      await app.close();
      for (const f of ['pet.json', 'settings.json', 'pet.characters.bak.json', 'settings.characters.bak.json', 'pet.retired.bak.json', 'pet.v1.bak.json', 'pet.v2.bak.json']) fs.rmSync(path.join(data, f), { force: true });
      const petBefore = { schemaVersion: 3, speciesId: 'dafeiyu', createdAt: now - 1e6, owner: 'me', space: { workspaceId: null, name: '个人空间' }, characters: {
        dafeiyu: { speciesId: 'dafeiyu', name: '小鱼', agentId: 'agt_FISH', topicId: 'tpc_FISH', createdAt: now - 1e6, affection: 40, relStage: 'close', peakStage: 'close', hunger: 30, mood: 60, energy: 90, sleeping: false, lastTickAt: now, lastInteractionAt: now, lastFedAt: now, lastSpokeAt: now, equippedOutfit: 'scarf', lastSafeOutfit: 'scarf', personaVersion: 6, seenUnlocks: [], dailyCounts: {}, lastAffectionAt: {}, topicsToday: [] },
        claude: { speciesId: 'claude', name: '克克', agentId: 'agt_CLAUDE', topicId: 'tpc_CLAUDE', createdAt: now - 1e6, affection: 10, relStage: 'stranger', peakStage: 'stranger', hunger: 30, mood: 60, energy: 90, sleeping: false, lastTickAt: now, lastInteractionAt: now, lastFedAt: now, lastSpokeAt: now, equippedOutfit: 'daily', lastSafeOutfit: 'daily', personaVersion: 6, seenUnlocks: [], dailyCounts: {}, lastAffectionAt: {}, topicsToday: [] },
      } };
      const settingsBefore = { ageGateVersion: 2, answered: true, ageConfirmed: false, adultContent: false, appearance: { dafeiyu: 'dafeiyu-live2d', claude: 'claude-classic', grok: 'grok-removed-pack' }, framings: { dafeiyu: 'half' }, visitors: ['claude', 'gemini'], vrmPostures: { 'vrm-dafeiyu-mine': 'sit.rest' }, models: { claude: 'lobehub:claude-sonnet-5-5' }, systemRoles: { dafeiyu: '叫我老板' } };
      fs.writeFileSync(path.join(data, 'pet.json'), JSON.stringify(petBefore, null, 2));
      fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settingsBefore, null, 2));
      ({ app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await page.waitForFunction(() => !!document.querySelector('#pet-look canvas, #pet-look .l2d, #pet-look [data-kind]') || !!(window.petDebug && window.petDebug.framing && window.petDebug.framing()), null, { timeout: 20000 }).catch(() => {});
      await hover(page);
      const v = await view(page);
      assert.equal(v.pet.characterId, 'dafeiyu-live2d', '大肥鱼 + dafeiyu-live2d → the character 「大肥鱼 · Live2D」');
      assert.equal(v.character.name, '大肥鱼 · Live2D');
      assert.equal(v.look.packId, 'dafeiyu-live2d');
      assert.equal(v.pet.agentId, 'agt_FISH', 'same agent, chat and affection');
      assert.equal(v.pet.affection, 40);
      assert.match(await page.textContent('#meta'), /小鱼 · 大肥鱼 · Live2D · 亲近 ♥40/);
      await page.screenshot({ path: path.join(OUT, 't2764-migrated-live2d.png') });
      const petAfter = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
      const stAfter = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
      assert.equal(petAfter.characterId, 'dafeiyu-live2d');
      assert.equal(petAfter.characterModel, 2);
      assert.deepEqual(petAfter.characters.dafeiyu.wardrobes['dafeiyu-pixel'], { equippedOutfit: 'scarf', lastSafeOutfit: 'scarf' }, 'her outfit goes into each of her characters\' wardrobes');
      assert.equal(petAfter.characters.dafeiyu.wardrobes['dafeiyu-live2d'].equippedOutfit, 'daily', 'her Live2D self has no scarf: corrected to daily on arrival');
      assert.ok(petAfter.characters.claude.wardrobes['claude-classic'], 'a met base gets a wardrobe per character too');
      assert.equal(stAfter.appearance, undefined);
      assert.equal(stAfter.characterModel, 2);
      assert.deepEqual(stAfter.legacyAppearance, settingsBefore.appearance);
      assert.deepEqual(stAfter.framings, { 'dafeiyu-pixel': 'half', 'dafeiyu-live2d': 'half', 'dafeiyu-live': 'half', 'dafeiyu-classic': 'half', 'dafeiyu-adult': 'half', 'dafeiyu-clips': 'half' }, '取景 per character');
      assert.deepEqual(stAfter.visitors, ['claude-classic', 'gemini-pixel'], 'visitors: her chosen character');
      assert.deepEqual(stAfter.vrmPostures, settingsBefore.vrmPostures, 'VRM postures: a character id is her pack id');
      assert.deepEqual([stAfter.models, stAfter.systemRoles], [settingsBefore.models, settingsBefore.systemRoles], 'per-persona: shared by her characters, unchanged');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'settings.characters.bak.json'), 'utf8')), settingsBefore, 'settings backed up as they were');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'pet.characters.bak.json'), 'utf8')), petBefore, 'pet.json backed up as it was');
      // a second start: nothing to migrate, the files stay byte for byte (but for the clock the heartbeat moves)
      await app.close();
      const p1 = fs.readFileSync(path.join(data, 'settings.json'), 'utf8');
      ({ app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      const v2 = await view(page);
      assert.equal(v2.pet.characterId, 'dafeiyu-live2d');
      assert.equal(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'), p1, 'settings.json unchanged by a second start');
      const pet2 = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
      assert.deepEqual(pet2.characters.dafeiyu.wardrobes, petAfter.characters.dafeiyu.wardrobes);
      fs.writeFileSync(path.join(OUT, 't2764-migrate-files.txt'), `--- settings.json (before) ---\n${JSON.stringify(settingsBefore, null, 2)}\n\n--- settings.json (after) ---\n${JSON.stringify({ characterModel: stAfter.characterModel, legacyAppearance: stAfter.legacyAppearance, framings: stAfter.framings, visitors: stAfter.visitors, vrmPostures: stAfter.vrmPostures, models: stAfter.models, systemRoles: stAfter.systemRoles }, null, 2)}\n\n--- pet.json (before) ---\n${JSON.stringify({ speciesId: petBefore.speciesId, dafeiyu: { equippedOutfit: 'scarf' } }, null, 2)}\n\n--- pet.json (after) ---\n${JSON.stringify({ speciesId: petAfter.speciesId, characterId: petAfter.characterId, characterModel: petAfter.characterModel, wardrobes: { dafeiyu: petAfter.characters.dafeiyu.wardrobes, claude: petAfter.characters.claude.wardrobes } }, null, 2)}\n`);
      return `characterId ${v.pet.characterId} (${v.character.name}); framings → ${Object.keys(stAfter.framings).length} characters; visitors ${stAfter.visitors.join(',')}; 2nd start: settings.json identical`;
    }, () => page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------- characters
// Every character has her own agent, topic, name and affection (schema 3). Starts from a schema-2 save.
async function characters() {
  return retiredScenario('characters', 'admin (角色图鉴, 切换 / 初次见面), frontslim F10');
  const S = 'characters';
  const SHOTS = path.join(OUT, 'characters');
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chars-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-charsfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const now = Date.now();
  const old = { schemaVersion: 2, speciesId: 'grok', name: '小蓝', agentId: 'agt_GROK_OLD', topicId: 'tpc_GROK_OLD', createdAt: now - 86400000, affection: 40, relStage: 'close', peakStage: 'close', hunger: 30, mood: 70, energy: 90, sleeping: false, lastTickAt: now, lastInteractionAt: now, lastFedAt: now, lastSpokeAt: now, equippedOutfit: 'daily', lastSafeOutfit: 'daily', owner: 'Test Owner', space: { workspaceId: null, name: '个人空间' }, personaVersion: 6 };
  fs.writeFileSync(path.join(data, 'pet.json'), JSON.stringify(old, null, 2));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, adultContent: false }));
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, FAKE_LH_CREATE_DELAY_MS: '1500' };
  let { app, page } = await launch(env);
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const runs = () => fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const disk = () => JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
  const openChars = async () => {
    await clickAct(page, 'menu');
    await page.click('[data-menu="characters"]');
    await page.waitForSelector('.char-opt[data-species="grok"]');
  };
  const rel = (id) => page.textContent(`.char-opt[data-species="${id}"] .char-rel`);
  let claude = null;
  try {
    await step(S, 'a schema-2 save opens as schema 3: 小蓝 keeps her agent, topic and ♥40; the old file is backed up', async () => {
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await idle();
      const d = disk();
      assert.equal(d.schemaVersion, 3);
      assert.deepEqual(Object.keys(d.characters), ['grok']);
      assert.equal(d.characters.grok.agentId, 'agt_GROK_OLD');
      assert.equal(d.characters.grok.topicId, 'tpc_GROK_OLD');
      assert.equal(d.characters.grok.affection, 40);
      assert.equal(d.owner, 'Test Owner');
      assert.equal('agentId' in d, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'pet.v2.bak.json'), 'utf8')), old);
      await hover(page);
      assert.match(await page.textContent('#meta'), /小蓝 · 格萝可 · 亲近 ♥40/);
      fs.writeFileSync(path.join(SHOTS, 'migrate-files.txt'), `--- pet.v2.bak.json (before) ---\n${JSON.stringify(old, null, 2)}\n\n--- pet.json (after) ---\n${JSON.stringify(d, null, 2)}\n`);
      return `characters=${Object.keys(d.characters)}; grok agent=${d.characters.grok.agentId} topic=${d.characters.grok.topicId} ♥${d.characters.grok.affection}`;
    }, page);

    await step(S, '角色列表 shows who has been met: 格萝可 已认识 ♥40, the others 未见过', async () => {
      await openChars();
      assert.match(await rel('grok'), /已认识 · 亲近 · 好感 40/);
      for (const id of ['claude', 'gemini', 'gpt', 'dafeiyu']) assert.equal(await rel(id), '未见过', id);
      assert.equal(await page.textContent('.char-opt[data-species="claude"] .pick'), '初次见面');
      await page.screenshot({ path: path.join(SHOTS, '01-roster.png') });
    }, page);

    await step(S, 'meeting 克洛蒂 asks for her name first (default 克洛蒂), then a second agent is created while she is on her way', async () => {
      await page.click('.char-opt[data-species="claude"] .pick');
      await page.waitForSelector('.char-name-form input');
      assert.equal(await page.inputValue('.char-name-form input'), '克洛蒂');
      await page.screenshot({ path: path.join(SHOTS, '02-name-form.png') });
      await page.fill('.char-name-form input', '小克');
      await page.click('.char-name-form button[type="submit"]');
      await page.waitForFunction(() => /克洛蒂正在赶来/.test(document.getElementById('bubble').textContent), null, { timeout: 5000 });
      assert.match(await page.textContent('#panel-msg'), /克洛蒂正在赶来/);
      await page.screenshot({ path: path.join(SHOTS, '03-arriving.png') });
      await page.waitForSelector('.char-opt.on[data-species="claude"]', { timeout: 20000 });
      await idle();
      await page.screenshot({ path: path.join(SHOTS, '04-claude-met.png') });
      const panelMsgText = await page.textContent('#panel-msg');
      const relClaude = await rel('claude');
      const relGrok = await rel('grok');
      await page.click('#panel-close');
      const v = await view(page); // boot re-places the window: read the panel first
      claude = { agentId: v.pet.agentId };
      assert.equal(v.pet.speciesId, 'claude');
      assert.equal(v.pet.name, '小克');
      assert.notEqual(v.pet.agentId, 'agt_GROK_OLD');
      assert.equal(v.pet.affection, 0);
      assert.match(panelMsgText, /「小克」来了/);
      assert.match(relClaude, /已认识 · 陌生 · 好感 0/);
      assert.match(relGrok, /好感 40/);
      const creates = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args).filter((a) => a[0] === 'agent' && a[1] === 'create');
      assert.equal(creates.length, 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(fakeDir, 'last-create.json'), 'utf8')).title, '小克 (Clody)');
      assert.equal(runs().pop().agent, claude.agentId, 'her hello comes from her own agent');
      return `new agent ${claude.agentId} "小克 (Clody)"; ♥0`;
    }, page);

    await step(S, '克洛蒂 chats in her own topic; back on 格萝可 her agent, topic and ♥40 are untouched', async () => {
      await page.evaluate(() => window.pet.chat('你好，小克'));
      await idle();
      const r1 = runs().pop();
      assert.equal(r1.agent, claude.agentId);
      claude.topicId = (await view(page)).pet.topicId;
      assert.equal(r1.topic, claude.topicId);
      assert.notEqual(claude.topicId, 'tpc_GROK_OLD');
      await openChars();
      await page.click('.char-opt[data-species="grok"] .pick');
      await page.waitForSelector('.char-opt.on[data-species="grok"]');
      await page.screenshot({ path: path.join(SHOTS, '05-back-to-grok-panel.png') });
      await page.click('#panel-close');
      const v = await view(page);
      assert.equal(v.pet.agentId, 'agt_GROK_OLD');
      assert.equal(v.pet.topicId, 'tpc_GROK_OLD');
      assert.equal(v.pet.name, '小蓝');
      assert.equal(v.pet.affection, 40);
      await page.evaluate(() => window.pet.chat('我回来了'));
      await idle();
      const r2 = runs().pop();
      assert.deepEqual([r2.agent, r2.topic], ['agt_GROK_OLD', 'tpc_GROK_OLD']);
      await hover(page);
      await page.screenshot({ path: path.join(SHOTS, '05-back-to-grok.png') });
      return `claude ${r1.agent}/${r1.topic}; grok ${r2.agent}/${r2.topic}`;
    }, page);

    await step(S, 'back on 克洛蒂 a second time: no new agent, her topic and name are kept', async () => {
      await openChars();
      await page.click('.char-opt[data-species="claude"] .pick');
      await page.waitForSelector('.char-opt.on[data-species="claude"]');
      await page.click('#panel-close');
      const v = await view(page);
      assert.equal(v.pet.agentId, claude.agentId);
      assert.equal(v.pet.topicId, claude.topicId);
      assert.equal(v.pet.name, '小克');
      const creates = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args).filter((a) => a[0] === 'agent' && a[1] === 'create');
      assert.equal(creates.length, 1);
    }, page);

    await step(S, 'a failed agent creation (meeting 杰米) keeps 克洛蒂 and stores nothing', async () => {
      fs.writeFileSync(path.join(fakeDir, 'fail-create'), '1');
      await openChars();
      await page.click('.char-opt[data-species="gemini"] .pick');
      await page.waitForSelector('.char-name-form input');
      await page.click('.char-name-form button[type="submit"]');
      await page.waitForFunction(() => /没能来/.test(document.getElementById('panel-msg').textContent), null, { timeout: 20000 });
      const msg = await page.textContent('#panel-msg');
      assert.equal(await rel('gemini'), '未见过');
      assert.equal(await page.locator('.char-name-form button[type="submit"]').isEnabled(), true, 'she can be asked again');
      await page.screenshot({ path: path.join(SHOTS, '06-create-failed.png') });
      await page.click('#panel-close');
      assert.equal((await view(page)).pet.speciesId, 'claude');
      assert.deepEqual(Object.keys(disk().characters).sort(), ['claude', 'grok']);
      fs.rmSync(path.join(fakeDir, 'fail-create'));
      return msg;
    }, page);

    await step(S, 'after a restart both characters are there, each with her own agent, topic and affection', async () => {
      await app.close();
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await idle();
      const v = await view(page);
      assert.equal(v.pet.speciesId, 'claude');
      assert.equal(v.pet.agentId, claude.agentId);
      const d = disk();
      assert.equal(d.characters.grok.agentId, 'agt_GROK_OLD');
      assert.equal(d.characters.grok.topicId, 'tpc_GROK_OLD');
      assert.ok(d.characters.grok.affection >= 40);
      assert.equal(d.characters.claude.topicId, claude.topicId);
      const met = v.characters.filter((c) => c.met).map((c) => `${c.id}:${c.met.name}♥${c.met.affection}`);
      fs.writeFileSync(path.join(SHOTS, 'pet-after.json'), JSON.stringify(d, null, 2) + '\n');
      return met.join(', ');
    }, page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------- dafeiyu
async function dafeiyu() {
  const S = 'dafeiyu';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dfy-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dfyfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  // She starts in pixels like everyone else; this scenario covers her original dsh-pet clips, picked under 外观.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, appearance: { dafeiyu: 'dafeiyu-clips' } }));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const clip = () => page.evaluate(() => document.getElementById('pet-video').dataset.key);
  try {
    await step(S, 'the character screen offers DeepSeek first', async () => {
      await page.waitForSelector('.char-card');
      assert.equal(await page.locator('.char-card').count(), 13);
      assert.match(await page.locator('.char-card').nth(0).textContent(), /DeepSeek/);
      // her original clips are a character of their own (T-2764): 「大肥鱼 · 原版动画」
      await page.locator('.char-card[data-character="dafeiyu-clips"]').click();
      assert.match(await page.locator('#card-info').textContent(), /大肥鱼|鱼片/);
      await page.fill('#pet-name', 'Mow');
    }, page);

    await step(S, 'hatching plays the 大肥鱼 hatch animation', async () => {
      await page.click('#hatch-btn');
      await page.waitForSelector('#hatch-vwrap:not(.hidden)', { timeout: 15000 });
      await page.waitForFunction(() => { const v = document.getElementById('hatch-video'); return v.readyState >= 2 && !v.paused; }, null, { timeout: 10000 });
      await page.waitForTimeout(600);
      assert.match(await page.evaluate(() => document.getElementById('hatch-video').src), /^pack:\/\/dafeiyu-clips\/hatch\.webm$/);
    }, page);

    await step(S, 'the pet appears as a transparent video in a small window with no controls showing', async () => {
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await page.waitForFunction(() => { const v = document.getElementById('pet-video'); return v.readyState >= 2 && !v.paused && v.videoWidth === 640; }, null, { timeout: 10000 });
      // right after hatching the pet is "talking" (its greeting), then settles into the idle clip
      await page.waitForFunction(() => document.getElementById('pet-video').dataset.key === 'idle', null, { timeout: 15000 });
      assert.equal(await page.locator('#char-wrap').isHidden(), true);
      // the pointer is still where the Hatch button was; a real user would move away
      await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
      await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '0', null, { timeout: 5000 });
      const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      assert.deepEqual([b.width, b.height], [268, 388], 'default 125%: window 268x388');
      return `window ${b.width}x${b.height}, clip idle`;
    }, page);

    await step(S, 'hovering shows the controls; feeding rice plays the eating animation', async () => {
      await page.evaluate(() => window.pet.debugSet({ hunger: 80, sleeping: false, energy: 90 }));
      await clickAct(page, 'feed');
      await page.click('#food-menu .btn >> nth=0');
      await page.waitForFunction(() => document.getElementById('pet-video').dataset.key === 'eat_rice', null, { timeout: 5000 });
      await page.waitForTimeout(800);
    }, page);

    await step(S, 'the agent was created with the 大肥鱼 persona', async () => {
      const created = JSON.parse(fs.readFileSync(path.join(fakeDir, 'last-create.json'), 'utf8'));
      assert.match(created.systemRole, /大肥鱼/);
      assert.match(created.systemRole, /鱼片/);
      assert.match(created.title, /Mow \(Dafeiyu\)/);
    });
    // 衣柜 moved to the settings window (her page, T-2718): her signature outfit is there and worn
    await step(S, 'in 设置 → her page the wardrobe lists her signature outfit, worn', async () => {
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      // an old per-persona link still opens her page: the current 大肥鱼 character, 「大肥鱼 · 原版动画」 (T-2764)
      const admin = await openAdminWindow(app, page, 'characters/dafeiyu');
      await adminUntil(admin, () => !!document.querySelector('[data-outfits="dafeiyu-clips"] [data-outfit="daily"]'), null, 15000, 'her wardrobe');
      const rack = await admin.evaluate(() => [...document.querySelectorAll('[data-outfits="dafeiyu-clips"] [data-outfit]')].map((b) => `${b.dataset.outfit}${b.dataset.equipped === 'true' ? '✓' : ''}`));
      assert.ok(rack.includes('daily✓'), rack.join(' '));
      await admin.screenshot({ path: path.join(OUT, 'dafeiyu-wardrobe-signature.png') });
      return `wardrobe ${rack.join(' ')}`;
    }, page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ busy
// Fake lh with a slow agent: the pet is "working" for a few seconds.
async function busy() {
  const S = 'busy';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-busy-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-busyfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, FAKE_LH_RUN_DELAY_MS: '3500' };
  const { app, page } = await launch(env);
  const calls = () => fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="grok"]').first().click();
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();

    await step(S, 'the computer-access option was on by default and the agent got bound to this computer', async () => {
      const edits = fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.deepEqual(edits.find((e) => e.agencyConfig).agencyConfig, { boundDeviceId: 'dev_DAEMON', executionTarget: 'local' });
      assert.ok(fs.existsSync(path.join(fakeDir, 'daemon-started')));
    });

    await step(S, 'with the chat box open, moving the pointer away hides everything; the draft returns on the next hover', async () => {
      await clickAct(page, 'chat'); // opens the chat box, pointer inside
      await page.fill('#chat-input', '草稿还在');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'chat-input');
      await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
      await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '0', null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => document.body.classList.contains('hover')), false);
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'chat-input', 'the hidden box must not keep keyboard focus');
      await page.screenshot({ path: path.join(OUT, 'away-hidden.png') });
      await hover(page);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '1', null, { timeout: 5000 });
      assert.equal(await page.inputValue('#chat-input'), '草稿还在');
      await page.fill('#chat-input', '');
      await clickAct(page, 'chat'); // close it again for the next steps
    }, () => page);

    await step(S, 'while the pet works the controls stay hidden even under the pointer, and actions are refused', async () => {
      await clickAct(page, 'chat');
      await page.fill('#chat-input', '帮我看看下载文件夹里有什么');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await page.mouse.move(120, 160); // pointer is right over the pet
      await page.waitForTimeout(400);
      assert.equal(await hudOpacity(page), '0');
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('toolbar')).visibility), 'hidden');
      assert.match(await page.textContent('#bubble'), /思考中/);
      const r = await page.evaluate(() => window.pet.act('feed', 'rice'));
      assert.deepEqual(r, { ok: false, reason: 'busy' });
    }, () => page);

    await step(S, 'when the reply arrives the controls come back on hover', async () => {
      await idle();
      await page.mouse.move(100, 150);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '1', null, { timeout: 5000 });
      assert.match(await page.textContent('#bubble'), /echo:/);
    }, () => page);

    await step(S, 'Escape stops a running task and the pet says so', async () => {
      await page.fill('#chat-input', '一个很大的活');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await page.waitForTimeout(500);
      await page.keyboard.press('Escape');
      await idle();
      assert.match(await page.textContent('#bubble'), /不想了/);
    }, () => page);

    await step(S, 'hovering while the pet works shows only a Stop button, and clicking it interrupts the task', async () => {
      await hover(page);
      await page.fill('#chat-input', '又一个很大的活');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await page.mouse.move(110, 150);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('stop-btn')).display !== 'none', null, { timeout: 5000 });
      await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '0', null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('toolbar')).visibility), 'hidden');
      // pointer leaves: the button goes away with it
      await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
      await page.waitForFunction(() => getComputedStyle(document.getElementById('stop-btn')).display === 'none', null, { timeout: 5000 });
      await page.mouse.move(112, 152);
      await page.waitForFunction(() => getComputedStyle(document.getElementById('stop-btn')).display !== 'none', null, { timeout: 5000 });
      await page.screenshot({ path: path.join(OUT, 'stop-visible.png') });
      await page.click('#stop-btn');
      await idle();
      assert.match(await page.textContent('#bubble'), /不想了/);
    }, () => page);

    await step(S, 'a pasted picture is attached, uploaded, and answered', async () => {
      const b64 = fs.readFileSync(path.join(ROOT, 'build', 'icon.png')).toString('base64');
      await hover(page);
      await page.evaluate((data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, b64);
      await page.waitForSelector('#attach-row .attach-chip', { timeout: 5000 });
      await page.screenshot({ path: path.join(OUT, 'paste-chip.png') });
      await page.fill('#chat-input', '这是什么图标？');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await idle();
      const seq = calls().map((a) => `${a[0]} ${a[1]}`);
      assert.deepEqual(seq.slice(-4), ['file upload', 'message create', 'message add-files', 'agent run']);
      assert.equal(await page.locator('#attach-row .attach-chip').count(), 0);
    }, () => page);

    await step(S, 'turning computer access off in 设置 → LobeHub 与本机 unbinds the agent, and on (confirmed) binds it again', async () => {
      const admin = await openAdminWindow(app, page, 'connection');
      await adminUntil(admin, () => document.querySelector('[data-key="localAbilities"]')?.getAttribute('aria-checked') === 'true', null, 10000, 'local on');
      await adminFlip(admin, 'localAbilities');
      await adminUntil(admin, () => document.querySelector('[data-key="localAbilities"]')?.getAttribute('aria-checked') === 'false', null, 15000, 'local off');
      await idle();
      let edits = fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.agencyConfig);
      assert.deepEqual(edits.at(-1).agencyConfig, { boundDeviceId: null });
      await adminFlip(admin, 'localAbilities', '开启本机能力');
      await adminUntil(admin, () => document.querySelector('[data-key="localAbilities"]')?.getAttribute('aria-checked') === 'true', null, 15000, 'local on again');
      await idle();
      await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('admin-ui')) w.destroy(); });
      edits = fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.agencyConfig);
      assert.equal(edits.at(-1).agencyConfig.boundDeviceId, 'dev_DAEMON');
    }, () => page);

    const dropDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-drop-'));
    const f1 = path.join(dropDir, '报销单 2026.txt');
    const f2 = path.join(dropDir, 'notes.md');
    fs.writeFileSync(f1, 'hello');
    fs.writeFileSync(f2, 'world');

    await step(S, 'dropping files hands their paths to the pet without uploading anything', async () => {
      const before = calls().length;
      await hover(page);
      await dropFiles(page, [f1, f2]);
      await page.waitForFunction(() => document.querySelectorAll('#attach-row .attach-chip.file').length === 2, null, { timeout: 5000 });
      const names = await page.$$eval('#attach-row .attach-chip.file .nm', (els) => els.map((e) => e.textContent));
      assert.deepEqual(names.sort(), ['notes.md', '报销单 2026.txt']);
      await page.screenshot({ path: path.join(OUT, 'drop-chips.png') });
      await page.fill('#chat-input', '帮我看看这两个文件');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await idle();
      const fresh = calls().slice(before).map((a) => `${a[0]} ${a[1]}`);
      assert.ok(!fresh.includes('file upload'), `uploaded something: ${fresh.join(', ')}`);
      assert.ok(fresh.includes('agent run'));
      const run = fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').map(JSON.parse).pop();
      assert.ok(run.prompt.includes(f1) && run.prompt.includes(f2), 'paths missing from the prompt');
      assert.deepEqual(run.tools, ['lobe-local-system']);
      assert.equal(await page.locator('#attach-row .attach-chip').count(), 0);
    }, () => page);

    await step(S, 'dropping a file while computer access is off asks to turn it on, then goes ahead', async () => {
      assert.equal((await page.evaluate(() => window.pet.setLocal(false))).ok, true);
      await page.waitForFunction(() => !document.body.classList.contains('busy'));
      const before = fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').length;
      page.lastDialog = '';
      await hover(page);
      await dropFiles(page, [f2]);
      await page.waitForSelector('#attach-row .attach-chip.file', { timeout: 5000 });
      await page.fill('#chat-input', '读一下');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await idle();
      assert.match(page.lastDialog, /本机能力/);
      const edits = fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(edits.length > before);
      assert.equal(edits.at(-1).agencyConfig.boundDeviceId, 'dev_DAEMON');
      assert.ok(fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').includes(f2));
    }, () => page);
  } finally {
    await app.close().catch(() => {});
  }
}

// The daemon must be up whenever the app is: relaunching with an existing pet starts it again.
async function daemonlaunch() {
  const S = 'daemon';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dmn-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dmnfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  let { app, page } = await launch(env);
  const starts = () => (fs.existsSync(path.join(fakeDir, 'connects.log')) ? fs.readFileSync(path.join(fakeDir, 'connects.log'), 'utf8').trim().split('\n').length : 0);
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="claude"]').first().click();
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await step(S, 'claiming a pet starts lh connect --daemon', async () => {
      assert.equal(starts(), 1);
      assert.ok(fs.existsSync(path.join(fakeDir, 'daemon-started')));
    });
    await step(S, 'relaunching the app starts the daemon again if it is gone', async () => {
      await app.close();
      fs.rmSync(path.join(fakeDir, 'daemon-started'));
      fs.rmSync(path.join(fakeDir, 'devices.json'));
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      for (let i = 0; i < 40 && starts() < 2; i++) await new Promise((r) => setTimeout(r, 500));
      assert.equal(starts(), 2);
    });
    await step(S, 'relaunching while the daemon is already running does not start a second one', async () => {
      await app.close();
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 6000)); // warm-up runs ~1.5s after launch
      assert.equal(starts(), 2);
    });
  } finally {
    await app.close().catch(() => {});
  }
}

// An lh that cannot write the device binding (old releases): the pet still reaches this computer and says how to fix it.
async function oldlh() {
  const S = 'oldlh';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-old-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-oldfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(fakeDir, 'devices.json'), JSON.stringify([{ deviceId: 'dev_OLD', hostname: '192.168.101.156', platform: process.platform, online: true, channels: [{ hostname: '192.168.101.156', connectedAt: new Date().toISOString() }] }]));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, FAKE_LH_NO_AGENCY: '1' });
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="grok"]').first().click();
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await step(S, 'an lh that cannot write the binding still works, and the pet says to upgrade lh', async () => {
      await page.waitForFunction(() => /升级/.test(document.getElementById('bubble').textContent), null, { timeout: 8000 });
      await hover(page);
      await clickAct(page, 'chat');
      await page.fill('#chat-input', '读一下桌面上有什么');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const run = fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').map(JSON.parse).pop();
      assert.equal(run.device, 'dev_OLD');
      assert.deepEqual(run.tools, ['lobe-local-system']);
    }, () => page);
  } finally {
    await app.close().catch(() => {});
  }
}

// A reply much longer than the bubble must scroll inside it instead of spilling over the pet.
async function longreply() {
  const S = 'longreply';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-long-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-longfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, FAKE_LH_LONG_REPLY: '1' });
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="grok"]').first().click();
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await step(S, 'a very long reply scrolls inside the bubble and stays within the window', async () => {
      await page.waitForFunction(() => { const b = document.getElementById('bubble'); return !b.classList.contains('hidden') && b.textContent.includes('第14行'); }, null, { timeout: 15000 });
      const m = await page.evaluate(() => {
        const b = document.getElementById('bubble');
        const r = b.getBoundingClientRect();
        return { scrollable: b.scrollHeight > b.clientHeight + 4, height: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), overflowY: getComputedStyle(b).overflowY, winH: window.innerHeight, newlines: getComputedStyle(b).whiteSpace };
      });
      assert.equal(m.scrollable, true);
      assert.equal(m.overflowY, 'auto');
      assert.equal(m.newlines, 'pre-wrap');
      assert.ok(m.height <= 84, `bubble is ${m.height}px tall`);
      assert.ok(m.top >= 0 && m.bottom <= m.winH, `bubble ${m.top}-${m.bottom} outside the ${m.winH}px window`);
      await page.evaluate(() => { document.getElementById('bubble').scrollTop = 9999; });
      return `bubble ${m.height}px, scrollable`;
    }, () => page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ----------------------------------------------------------------- live
async function live() {
  const S = 'live';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-live-'));
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: 'lh', PIXELPET_NO_CONNECT: '1' };
  const { app, page } = await launch(env);
  let agentId = null;
  const transcript = [];
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 150000 });
  // A killed run (timeout, Ctrl-C) must not leak the real agent it created.
  const onSignal = () => { if (agentId) { try { lh('agent', 'delete', agentId, '--yes'); } catch { /* best effort */ } } process.exit(143); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const record = async (label) => transcript.push(`[${label}] (${await bubbleSource(page)}) ${await bubbleText(page)}`);
  try {
    await page.waitForSelector('.char-card');
    await step(S, 'real lh is logged in, so login is skipped and a real agent is created', async () => {
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.uncheck('#local-opt'); // tests must never bind an agent to, or run tools on, a real computer
      await page.fill('#pet-name', '芽芽');
      await page.click('#hatch-btn');
      // an account with workspaces is asked where to put the pet; keep the default (personal)
      const where = await Promise.race([
        page.waitForSelector('#space-box:not(.hidden)', { timeout: 120000 }).then(() => 'asked'),
        page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 }).then(() => 'not asked'),
      ]);
      let spaces = '';
      if (where === 'asked') {
        spaces = (await page.locator('.space-opt .nm').allTextContents()).length;
        assert.equal(await page.locator('.space-opt input').first().isChecked(), true);
        await page.click('#space-go');
      }
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 });
      const v = await view(page);
      agentId = v.pet.agentId;
      assert.match(agentId, /^agt_/);
      assert.equal(v.space.personal, true);
      assert.equal(await page.locator('#login-box').isHidden(), true);
      return `agent ${agentId} in the personal space (space choice ${where}${spaces ? `, ${spaces} options` : ''})`;
    }, page);

    await step(S, 'the LobeHub agent exists and carries the pet persona', async () => {
      const out = lh('agent', 'view', agentId);
      assert.match(out, /芽芽/);
      assert.match(out, /克洛蒂/);
      // keep an excerpt for the report; drop identity/workspace lines
      fs.writeFileSync(path.join(OUT, 'agent-view-excerpt.txt'), `$ lh agent view ${agentId}\n` + out.split('\n').filter((l) => !/user|workspace|email|token/i.test(l)).join('\n'));
      return 'agent view shows name + species persona';
    });

    await step(S, 'first greeting comes from the real model, not a canned line', async () => {
      const text = await waitReply(page, 120000);
      const v = await view(page);
      assert.ok(v.pet.topicId && v.pet.topicId.startsWith('tpc_'), 'topic id saved');
      assert.equal(await bubbleSource(page), 'llm', `greeting was canned: ${text}`);
      await record('hatch greeting');
      return `greeting: ${text.slice(0, 60)}`;
    }, page);

    await step(S, 'feeding lowers hunger and shows food', async () => {
      await page.evaluate(() => window.pet.debugSet({ hunger: 80 }));
      await clickAct(page, 'feed');
      await page.click('#food-menu .btn >> nth=0');
      await page.waitForTimeout(500);
      const v = await view(page);
      assert.ok(v.pet.hunger <= 50, `hunger ${v.pet.hunger}`);
      return `hunger 80 -> ${Math.round(v.pet.hunger)}`;
    }, page);

    await step(S, 'chat: the pet answers and remembers what it was told (same LobeHub topic)', async () => {
      await clickAct(page, 'chat');
      await page.fill('#chat-input', '我叫小李，我最喜欢吃面条，记住哦');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.getElementById('bubble').classList.contains('thinking'), null, { timeout: 5000 }).catch(() => {});
      const a = await waitReply(page, 120000);
      await page.waitForTimeout(800);
      await page.fill('#chat-input', '你还记得我叫什么名字吗？');
      await page.click('#chat-send');
      await page.waitForTimeout(500);
      await page.waitForFunction((prev) => { const b = document.getElementById('bubble'); return !b.classList.contains('thinking') && b.textContent !== prev && b.textContent.length > 0; }, a, { timeout: 120000 });
      const b = await bubbleText(page);
      await record('chat reply #2 (asked: do you remember my name?)');
      transcript.splice(transcript.length - 1, 0, `[chat #1 sent] 我叫小李，我最喜欢吃面条，记住哦`, `[chat reply #1] ${a}`, `[chat #2 sent] 你还记得我叫什么名字吗？`);
      assert.match(b, /小李/, `second reply was: ${b}`);
      return `reply: ${b.slice(0, 60)}`;
    }, page);

    await step(S, 'proactive: a hungry pet speaks up on its own via the agent', async () => {
      await page.evaluate(() => window.pet.debugSet({ hunger: 95, lastSpokeAt: 0, sleeping: false }));
      await page.evaluate(() => window.pet.debugHeartbeat());
      const text = await waitReply(page, 120000);
      assert.equal(await bubbleSource(page), 'llm', `proactive line was canned (${text}); reason: ${await page.evaluate(() => document.getElementById('bubble').dataset.reason)}`);
      await record('proactive (hunger forced to 95, no user input)');
      return `unprompted: ${text.slice(0, 60)}`;
    }, page);

    await step(S, 'asked to look something up, the pet helps instead of deflecting to other assistants', async () => {
      await hover(page);
      await page.fill('#chat-input', '帮我查一下今天纳斯达克指数大概是多少，最近是涨还是跌？');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await idle();
      const b = (await bubbleText(page)).trim();
      await record('lookup question (nasdaq)');
      transcript.splice(transcript.length - 1, 0, '[lookup sent] 帮我查一下今天纳斯达克指数大概是多少，最近是涨还是跌？');
      assert.ok(b.length > 4, 'empty reply');
      // a timeout or error shows a canned line, which would otherwise pass the deflection check
      assert.equal(await bubbleSource(page), 'llm', `the lookup got no model reply: ${b}`);
      assert.doesNotMatch(b, /去问|找.{0,8}(专家|助手)|只会看|看不懂/, `deflected: ${b}`);
      return `${b.length} chars: ${b.slice(0, 50)}`;
    }, page);

    await step(S, 'a pasted picture is recognised by the real model', async () => {
      const b64 = fs.readFileSync(path.join(ROOT, 'build', 'icon.png')).toString('base64');
      await hover(page);
      await page.evaluate((data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      }, b64);
      await page.waitForSelector('#attach-row .attach-chip', { timeout: 5000 });
      await page.fill('#chat-input', '这张图里有几个人？她们分别是什么发色？');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await idle();
      const b = (await bubbleText(page)).trim();
      await record('picture question (app icon)');
      transcript.splice(transcript.length - 1, 0, '[picture sent] build/icon.png: 三位像素风模型娘（蓝发、橘发、金发）+ 这张图里有几个人？她们分别是什么发色？');
      assert.match(b, /三|3/, `reply: ${b}`);
      assert.match(b, /蓝/, `reply: ${b}`);
      assert.match(b, /橙|橘/, `reply: ${b}`);
      return b.slice(0, 60);
    }, page);

    await step(S, 'affection crossing 15 moves the stage from 陌生 to 熟悉', async () => {
      await page.evaluate(() => window.pet.debugSet({ affection: 14, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await clickHead(page);
      await page.waitForTimeout(1200);
      const v = await view(page);
      assert.equal(v.pet.relStage, 'familiar');
      assert.match(await page.textContent('#meta'), /熟悉 ♥15/);
    }, page);

    await step(S, 'release deletes the real agent and returns to character selection', async () => {
      await idle(); // a stage-up makes the pet speak; controls stay hidden until it is done
      await adminRelease(app, page, true); // 设置 → 数据与关于 → 放生并删除 agent（二次确认）
      await page.waitForSelector('#onboarding:not(.hidden)', { timeout: 30000 });
      let gone = false;
      try { lh('agent', 'view', agentId); } catch { gone = true; }
      assert.equal(gone, true, 'agent still exists in LobeHub');
      fs.writeFileSync(path.join(OUT, 'release-check-live.txt'), `$ lh agent view ${agentId}\n(exit non-zero: the agent no longer exists in LobeHub)\n`);
      agentId = null;
    }, page);
  } finally {
    if (agentId) { try { lh('agent', 'delete', agentId, '--yes'); console.log(`cleanup: deleted ${agentId}`); } catch { /* best effort */ } }
    fs.writeFileSync(path.join(OUT, 'chat-transcript.txt'), transcript.join('\n') + '\n');
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ advanced
// Advanced settings: one click unlocks every stage, topic and outfit (adult ones with 18+ and adult on).
async function advanced() {
  return retiredScenario('advanced', 'admin (her page → 好感度 → 一键解锁)');
  const S = 'advanced';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adv-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-advfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: true }));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="dafeiyu"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();

    await step(S, 'the ⋯ menu has 设置… (first): the settings window holds the system-wide pages, no per-character controls on them', async () => {
      await clickAct(page, 'menu');
      const items = await page.$$eval('#main-menu [data-menu]', (els) => els.filter((e) => !e.classList.contains('hidden')).map((e) => e.textContent.trim()));
      assert.equal(items[0], '设置…', 'first item');
      assert.ok(!items.includes('高级设置'), 'the in-pet 高级设置 panel is gone');
      await page.click('[data-menu="settings"]');
      let admin = null;
      for (let i = 0; i < 100 && !admin; i++) {
        admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
        if (!admin) await page.waitForTimeout(100);
      }
      assert.ok(admin, 'the settings window opened');
      await admin.waitForSelector('[data-path="/overview"]', { timeout: 15000 });
      // the old panel's sections: 宠物大小 + 桌宠行为 → 桌宠行为, 语音 → 朗读, 语音输入, 同屏伙伴, 对外接口, 版本与更新 —
      // tiles on the 玩法 / 设置 hubs (the rail itself holds only 小屋 / 角色 / 玩法 / 设置)
      const nav = [];
      for (const hub of ['/play', '/settings']) {
        await admin.evaluate((h) => { location.hash = h; }, hub);
        await admin.waitForSelector(`[data-path="${hub}"] [data-tile]`);
        nav.push(...(await admin.$$eval('[data-tile] [data-tile-title]', (ts) => ts.map((t) => t.textContent.trim()))));
      }
      for (const want of ['桌宠行为', '朗读', '语音输入', '同屏伙伴', '对外接口', '版本与更新']) assert.ok(nav.includes(want), `a hub has ${want}: ${nav.join(',')}`);
      await admin.evaluate(() => { location.hash = '/behavior'; });
      await admin.waitForSelector('[data-path="/behavior"] [data-key="petScale"]');
      assert.equal(await admin.locator('[data-path="/behavior"] :is([data-unlock], [data-save-role], [data-use-pack], [data-system-role])').count(), 0, 'per-character settings live on her page (角色列表)');
      await admin.screenshot({ path: path.join(OUT, 'advanced-settings-window.png') });
      await admin.close();
      return `menu: ${items.slice(0, 3).join(' / ')}…; settings nav: ${nav.join(' / ')}`;
    }, page);

    await step(S, 'one click on her page in 角色列表 unlocks every stage, topic and outfit (18+ on; 大肥鱼 is all-ages, so all-ages content only)', async () => {
      await page.mouse.move(1, 1);
      await openCurrentPage(page);
      assert.match(await page.textContent('#char-config .cfg-model'), /^模型：/, 'her page sums up her model and 个性化设定 (edited in the settings window)');
      assert.equal(await page.textContent('#char-config .cfg-role'), '个性化设定：还没写');
      assert.equal(await page.locator('#unlock-all').isDisabled(), false);
      await page.locator('#unlock-all').scrollIntoViewIfNeeded();
      await page.click('#unlock-all');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)', { timeout: 10000 });
      const msg = await page.textContent('#panel-msg');
      assert.match(msg.trim(), /^已为大肥鱼解锁：\d+ 个话题、\d+ 套服饰。去衣柜换上看看吧。$/, '大肥鱼 has all-ages outfits to unlock');
      assert.match(await page.textContent('#panel-sub'), /挚友 ♥100/);
      assert.equal(await page.locator('#unlock-all').isDisabled(), true);
      assert.equal(await page.textContent('#unlock-all'), '已经全部解锁');
      const v = await view(page);
      assert.equal(v.affection.value, 100);
      assert.ok(v.topics.every((t) => t.unlocked), 'every topic');
      return msg;
    }, page);

    await step(S, 'the wardrobe shows everything unlocked: 大肥鱼 has her signature maid outfit, worn in pixels, and all twelve all-ages outfits', async () => {
      await idle();
      await page.click('#panel-close');
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('.card[data-outfit="daily"]');
      assert.equal(await page.locator('.card.locked').count(), 0);
      assert.deepEqual(await page.$$eval('.card', (cs) => cs.map((c) => c.dataset.outfit)), ['daily', 'scarf', 'casual', 'beret', 'idol', 'pajamas', 'cat_ears', 'swimsuit', 'yukata', 'bikini', 'qipao', 'couple_hoodie', 'flower_crown']);
      assert.equal(await page.textContent('.card[data-outfit="daily"] .st'), '✓ 穿着中');
      await page.screenshot({ path: path.join(OUT, 'advanced-wardrobe-all-unlocked.png') });
      await page.click('#panel-close');
      assert.equal(await page.evaluate(() => document.getElementById('pet-look').dataset.key), 'dafeiyu-pixel/daily');
      assert.match(await page.textContent('#meta'), /挚友 ♥100 · 已满级/);
      return 'pet wears 招牌女仆装 (dafeiyu-pixel)';
    }, page);

    const bounds = () => petBounds(app);
    const stageBox = () => page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    const scaleVar = () => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')));
    const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).petScale;
    await step(S, 'dragging the corner handle up-left resizes the pet freely; the window follows, bottom-right corner stays put', async () => {
      const before = await bounds();
      const stage0 = await stageBox();
      const k0 = await scaleVar();
      await hover(page);
      const g = await page.locator('#resize-grip').boundingBox();
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 4; i++) await page.mouse.move(g.x + g.width / 2 - i * 10, g.y + g.height / 2 - i * 10);
      await page.mouse.up();
      await page.waitForFunction(() => !document.body.classList.contains('resizing'));
      await page.waitForTimeout(300);
      const k = await scaleVar();
      const after = await bounds();
      const stage1 = await stageBox();
      assert.equal(k0, 1.25, 'starts at the default size');
      assert.ok(k > 1.4 && k < 2.5, `scale ${k}`);
      assert.equal(saved(), k, 'saved on release');
      assert.ok(after.height > before.height && after.width >= before.width);
      assert.equal(after.x + after.width, before.x + before.width, 'right edge kept');
      assert.equal(after.y + after.height, before.y + before.height, 'bottom edge kept');
      assert.ok(Math.abs(stage1.h - (stage0.h * k) / k0) <= 2, `stage ${stage1.h} vs ${stage0.h} x ${k}/${k0}`);
      await page.mouse.move(1, 1);
      await page.screenshot({ path: path.join(OUT, 'pet-size-dragged.png') });
      return `scale ${k0} -> ${k}: window ${before.width}x${before.height} -> ${after.width}x${after.height}; stage ${stage0.h} -> ${stage1.h}px`;
    }, page);

    await step(S, 'Ctrl + wheel over the pet makes it smaller, step by step', async () => {
      const k0 = await scaleVar();
      await page.mouse.move(110, (await bounds()).height - 200);
      await page.keyboard.down('Control');
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 100);
      await page.keyboard.up('Control');
      await page.waitForFunction((k) => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) < k, k0);
      await page.waitForTimeout(700); // saved 400 ms after the last notch
      const k1 = await scaleVar();
      assert.ok(Math.abs(k1 - k0 / 1.05 ** 4) < 0.02, `${k0} -> ${k1}`);
      assert.equal(saved(), k1);
      return `${k0} -> ${k1}`;
    }, page);

    await step(S, 'the 宠物大小 slider in the settings window (桌宠行为) sets any size, and the size is kept across a restart', async () => {
      const admin = await openAdminWindow(app, page, 'behavior');
      const slider = admin.locator('[data-key="petScale"]');
      const thumb = slider.locator('input[type="range"]').first();
      // Home → 50% (the minimum), then two steps of 5% up; each key-up saves
      await thumb.focus();
      await admin.keyboard.press('Home');
      await page.waitForFunction(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) === 0.5, null, { timeout: 8000 });
      for (const want of [0.55, 0.6]) {
        await thumb.focus();
        await admin.keyboard.press('ArrowRight');
        await page.waitForFunction((w) => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) === w, want, { timeout: 8000 });
      }
      await admin.waitForFunction(() => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && /已保存：宠物大小 → 60%/.test(el.textContent || '')), null, { timeout: 8000 });
      assert.match(await slider.textContent(), /60%/);
      await admin.hover('[data-reset="petScale"]'); // 恢复默认 shows the default in its tooltip
      await admin.getByText('恢复默认：125%', { exact: true }).waitFor({ timeout: 5000 });
      await admin.screenshot({ path: path.join(OUT, 'pet-size-slider.png') });
      await admin.close();
      await page.waitForFunction(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) === 0.6);
      assert.equal(saved(), 0.6);
      // the ⋯ menu still fits (it scrolls) in the small window
      await clickAct(page, 'menu');
      const fit = await page.evaluate(() => { const m = document.getElementById('main-menu').getBoundingClientRect(); return { top: Math.round(m.top), bottom: Math.round(m.bottom), h: window.innerHeight }; });
      assert.ok(fit.top >= 0 && fit.bottom <= fit.h, JSON.stringify(fit));
      await page.screenshot({ path: path.join(OUT, 'pet-size-small-menu.png') });
      await page.mouse.move(1, 1);
      await app.close();
      const again = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
      try {
        await again.page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
        await again.page.waitForFunction(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) === 0.6);
        const b = await petBounds(again.app);
        assert.deepEqual([b.width, b.height], [230, 264]);
        await again.page.screenshot({ path: path.join(OUT, 'pet-size-small-after-restart.png') });
        return `after restart: 60%, window ${b.width}x${b.height}`;
      } finally {
        await again.app.close().catch(() => {});
      }
    });
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ packs
// Pet packs: 格萝可 is drawn from her pixel pack; a pack can be imported (here from a folder through the
// test hook, the UI opens a file dialog), used, and removed again; 大肥鱼 switches between her clips and
// her pixel pack.
async function packs() {
  return retiredScenario('packs', 'admin (角色包: import / use / remove)');
  const S = 'packs';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-packs-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-packsfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const key = () => page.evaluate(() => document.getElementById('pet-look').dataset.key);
  // the pack list (外观) lives on her page in ⋯ → 角色列表, with her model and affection
  const openLooks = async () => { await openCurrentPage(page); await page.waitForSelector('.pack-list .pack-opt'); };
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="grok"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });

    await step(S, '格萝可 is an animated HD sprite from grok-pixel, drawn smoothed; dragging plays the lifted action', async () => {
      assert.equal(await key(), 'grok-pixel/daily');
      assert.equal(await page.locator('#pet-look canvas.sprite:not(.pixelated)').count(), 1, 'HD packs are not drawn as blocks');
      assert.deepEqual(await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.sprite'); return [c.width, c.height, getComputedStyle(c).imageRendering]; }), [664, 904, 'auto']);
      const box = await page.locator('#char-wrap').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 - 20, box.y + box.height / 2 - 10, { steps: 4 });
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.action === 'lifted', null, { timeout: 3000 });
      await page.screenshot({ path: path.join(OUT, 'pack-pixel-lifted.png') });
      await page.waitForTimeout(250);
      await page.mouse.up();
      return 'action while dragging: lifted';
    }, page);

    await step(S, 'an imported pack is listed as imported, can be used, and 角色列表 → 格萝可 → 外观 names it', async () => {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mypack-'));
      const base = path.join(ROOT, 'src', 'renderer', 'packs', 'grok-pixel');
      const m = JSON.parse(fs.readFileSync(path.join(base, 'pack.json'), 'utf8'));
      fs.mkdirSync(path.join(src, 'sheets'));
      const mine = `sheets/mine${path.extname(m.outfits.daily)}`;
      fs.copyFileSync(path.join(base, m.outfits.daily), path.join(src, mine));
      fs.writeFileSync(path.join(src, 'pack.json'), JSON.stringify({ ...m, id: 'my-grok', name: '我的格萝可', author: 'tester', outfits: { daily: mine } }));
      const r = await page.evaluate((d) => window.pet.debugImportPack(d), src);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(fs.existsSync(path.join(data, 'packs', 'my-grok', 'pack.json')), 'copied into the user pack folder');
      await openLooks();
      const names = await page.locator('.pack-opt[data-pack] .meta b').allTextContents();
      assert.deepEqual(names, ['格萝可 · 像素', '格萝可 · 旧版像素', '我的格萝可'], 'hers in order (default first), then the imported one');
      assert.match(await page.textContent('.pack-opt[data-pack="my-grok"] .meta span'), /导入/);
      await page.click('.pack-opt[data-pack="my-grok"] .pick');
      await page.waitForSelector('.pack-opt.on[data-pack="my-grok"]');
      await page.screenshot({ path: path.join(OUT, 'pack-advanced-list.png') });
      await page.click('#panel-close');
      assert.equal(await key(), 'my-grok/daily');
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).appearance.grok, 'my-grok');
      return names.join(' / ');
    }, page);

    await step(S, 'a broken pack is refused with its reasons', async () => {
      const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-badpack-'));
      fs.writeFileSync(path.join(bad, 'pack.json'), JSON.stringify({ schema: 2, id: 'bad', name: 'x', species: 'grok', kind: 'sprites', outfits: { daily: '../x.png' } }));
      const r = await page.evaluate((d) => window.pet.debugImportPack(d), bad);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => /relative path|frame|idle/.test(e)), r.errors.join('; '));
      const old = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-oldpack-'));
      fs.writeFileSync(path.join(old, 'pack.json'), JSON.stringify({ schema: 1, id: 'old-bubbo', name: 'x', species: 'bubbo', kind: 'pictures', outfits: { daily: 'a.png' } }));
      const r2 = await page.evaluate((d) => window.pet.debugImportPack(d), old);
      assert.equal(r2.ok, false);
      assert.ok(r2.errors.some((e) => /species must be one of dafeiyu, claude, grok, gemini, gpt/.test(e)), r2.errors.join('; '));
      return `${r.errors.slice(0, 2).join('; ')} | retired character: ${r2.errors.find((e) => /species/.test(e))}`;
    });

    await step(S, 'removing the pack in use puts the companion back in her default pixel pack', async () => {
      await openLooks();
      await page.click('.pack-opt[data-pack="my-grok"] .pack-remove');
      await page.waitForFunction(() => !document.querySelector('.pack-opt[data-pack="my-grok"]'));
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'grok-pixel/daily');
      assert.equal(fs.existsSync(path.join(data, 'packs', 'my-grok')), false);
    }, page);

    await step(S, '大肥鱼 starts in her pixel pack and can switch to her original clips and back', async () => {
      await openCharacters(page);
      await pickCharacter(page, 'dafeiyu');
      await openCharPage(page, 'dafeiyu');
      await page.waitForSelector('.pack-opt[data-pack="dafeiyu-pixel"]'); // her page lists her looks
      // 模型 and 个性化设定 moved to the settings window: her page keeps a summary and a link there
      assert.deepEqual(await page.$$eval('#panel-body .adv-section h3', (hs) => hs.map((h) => h.textContent.trim())), ['模型与个性化设定', '外观（角色包）', '好感度 · 一键解锁']);
      assert.match(await page.textContent('#char-admin'), /在设置窗口中编辑/);
      const names = await page.locator('.pack-opt[data-pack] .meta b').allTextContents();
      assert.deepEqual(names, ['大肥鱼 · 像素', '大肥鱼 · Live2D', '大肥鱼 · 全动态', '大肥鱼 · 旧版像素', '大肥鱼 · 原版动画']);
      assert.match(await page.locator('.pack-opt[data-pack="dafeiyu-live2d"] .meta span').textContent(), /^Live2D · 1 套服饰 · Live2D：Mao绒绒家园/);
      assert.match(await page.locator('.pack-opt[data-pack="dafeiyu-live"] .meta span').textContent(), /^全动态 · 1 套服饰/);
      assert.equal(await page.locator('.pack-opt.on[data-pack="dafeiyu-pixel"]').count(), 1, 'pixels by default');
      assert.match(await page.textContent('.pack-opt[data-pack="dafeiyu-clips"] .meta span'), /透明视频 · 1 套服饰 · PC2005-cloud\/dsh-pet/);
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily');
      assert.equal(await page.locator('#vwrap').isHidden(), true);
      await page.screenshot({ path: path.join(OUT, 'pack-dafeiyu-pixel.png') });
      await openLooks();
      await page.click('.pack-opt[data-pack="dafeiyu-clips"] .pick');
      await page.waitForSelector('.pack-opt.on[data-pack="dafeiyu-clips"]');
      await page.click('#panel-close');
      await page.waitForSelector('#vwrap:not(.hidden)');
      await page.waitForFunction(() => /dafeiyu\/[a-z_]+\.webm$/.test(document.getElementById('pet-video').src), null, { timeout: 5000 });
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).appearance.dafeiyu, 'dafeiyu-clips');
      await openLooks();
      await page.click('.pack-opt[data-pack="dafeiyu-pixel"] .pick');
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily');
      return `${names.join(' / ')}; pixel → clips → pixel`;
    }, page);

    await step(S, 'every character can wear her v0.7.0 pixels (旧版像素) and go back to the new ones', async () => {
      const seen = [];
      for (const id of ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']) {
        await clickAct(page, 'menu');
        await page.click('[data-menu="characters"]');
        if (!(await page.locator(`.char-opt.on[data-species="${id}"]`).count())) {
          await pickCharacter(page, id);
        }
        await page.click('#panel-close');
        await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 }); // back from the 460 px panel to the pet window (its width follows the pet size)
        await openLooks();
        assert.match(await page.textContent(`.pack-opt[data-pack="${id}-classic"] .meta span`), /像素动画 · 1 套服饰/);
        await page.click(`.pack-opt[data-pack="${id}-classic"] .pick`);
        await page.waitForSelector(`.pack-opt.on[data-pack="${id}-classic"]`);
        await page.click('#panel-close');
        await page.waitForFunction((k) => document.getElementById('pet-look').dataset.key === k, `${id}-classic/daily`, { timeout: 5000 });
        await page.waitForFunction(() => window.petFx.state().state === 'idle', null, { timeout: 15000 }); // past the wake-up after a switch
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `pack-${id}-classic.png`) });
        seen.push(`${id}-classic/daily`);
        await openLooks();
        await page.click(`.pack-opt[data-pack="${id}-pixel"] .pick`);
        await page.click('#panel-close');
        await page.waitForFunction((k) => document.getElementById('pet-look').dataset.key === k, `${id}-pixel/daily`, { timeout: 5000 });
      }
      return `${seen.join(', ')}; each back on her -pixel pack`;
    }, page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ models
// 角色列表 → her page (sums up her model) → 在设置窗口中编辑 › → the settings window's 模型 tab: each character offers
// only her own vendor's models; the agent follows the pick, and switching character switches the list (and the model)
// to the new character's.
async function models() {
  return retiredScenario('models', 'admin (her page → 模型)');
  const S = 'models';
  const SHOTS = path.join(OUT, 'models');
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-models-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-modelsfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const modelEdits = () => (fs.existsSync(path.join(fakeDir, 'edits.log')) ? fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.model).map((e) => `${e.provider}:${e.model}`) : []);
  // 模型 is edited in the settings window: 角色列表 → her page → 模型 tab (a lobe Select: a combobox whose value sits
  // in its hidden input; its data-model-select attribute does not reach the DOM, so it is found by role)
  let admin = null;
  const modelTab = async (id) => {
    if (!admin || admin.isClosed()) admin = await openAdminWindow(app, page, `characters/${id}`);
    else {
      await admin.evaluate((r) => { location.hash = r; }, `/characters/${id}`);
      await admin.waitForSelector(`[data-path="/characters/${id}"]`);
    }
    await admin.getByRole('tab', { name: '模型' }).click();
    // while the tabs switch the old panel stays a moment (inert): wait for the one live panel
    await admin.waitForFunction((n) => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === n); return t && t.getAttribute('aria-selected') === 'true' && document.querySelectorAll('[role="tabpanel"]').length === 1; }, '模型', { timeout: 5000 });
    const box = admin.locator('[role="tabpanel"]:not([inert])').getByRole('combobox');
    await box.waitFor();
    await admin.waitForFunction(() => document.querySelector('[role="tabpanel"]:not([inert]) [role="combobox"]') && !document.querySelector('[role="tabpanel"]:not([inert]) [role="combobox"]').disabled, null, { timeout: 15000 }); // the catalogue is loaded
    return box;
  };
  const current = () => admin.locator('[role="tabpanel"]:not([inert]) input[id$="-hidden-input"]').first().inputValue();
  const options = async () => {
    await admin.locator('[role="tabpanel"]:not([inert])').getByRole('combobox').click();
    await admin.getByRole('option').first().waitFor();
    const labels = await admin.getByRole('option').allTextContents();
    await admin.keyboard.press('Escape');
    await admin.getByRole('option').first().waitFor({ state: 'detached' });
    return labels.map((l) => l.trim());
  };
  const summary = () => page.textContent('#char-config .cfg-model');
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="claude"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();

    await step(S, '克洛蒂 is woken on her default Claude model before her first words', async () => {
      assert.equal((await view(page)).species.id, 'claude');
      assert.deepEqual(modelEdits(), ['lobehub:claude-sonnet-5-5']);
      return modelEdits().join(', ');
    }, page);

    await step(S, '⋯ → 角色列表 → 克洛蒂 shows her model; 在设置窗口中编辑 › opens her 模型 tab: only Claude models (no GPT, GLM, image models), the default selected', async () => {
      await openCurrentPage(page);
      assert.match(await page.textContent('#panel-sub'), /^克洛蒂（Anthropic）· 当前陪伴/);
      await page.waitForFunction(() => document.querySelector('#char-config .cfg-model').textContent === '模型：Claude Sonnet 5.5', null, { timeout: 10000 });
      await page.screenshot({ path: path.join(SHOTS, '01a-claude-page-summary.png') });
      await page.click('#char-admin');
      admin = app.windows().find((p) => p.url().includes('admin-ui'));
      for (let i = 0; i < 100 && !admin; i++) { await page.waitForTimeout(100); admin = app.windows().find((p) => p.url().includes('admin-ui')); }
      await admin.waitForSelector('[data-path="/characters/claude"]', { timeout: 15000 });
      await modelTab('claude');
      const labels = await options();
      assert.deepEqual(labels, ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']);
      const keys = (await view(page)).characters.find((c) => c.id === 'claude').model.options.map((o) => o.key);
      assert.ok(keys.every((k) => /^(lobehub|anthropic):claude-/.test(k)), keys.join(','));
      assert.equal(await current(), 'lobehub:claude-sonnet-5-5');
      assert.match(await admin.locator('[role="tabpanel"]:not([inert])').textContent(), /只列她所属厂商的模型/);
      await admin.screenshot({ path: path.join(SHOTS, '01-claude-models.png') });
      return labels.join(' / ');
    }, () => admin || page);

    await step(S, 'picking Claude Opus 5.5 in the settings window points her agent at it', async () => {
      await admin.locator('[role="tabpanel"]:not([inert])').getByRole('combobox').click();
      await admin.getByRole('option', { name: 'Claude Opus 5.5', exact: true }).click();
      await admin.waitForFunction(() => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && /克洛蒂 的模型/.test(el.textContent || '')), null, { timeout: 8000 });
      const t0 = Date.now();
      while (modelEdits().length < 2 && Date.now() - t0 < 10000) await page.waitForTimeout(200);
      assert.deepEqual(modelEdits(), ['lobehub:claude-sonnet-5-5', 'lobehub:claude-opus-5-5']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).models.claude, 'lobehub:claude-opus-5-5');
      assert.equal(await current(), 'lobehub:claude-opus-5-5');
      assert.equal(await admin.locator('[role="tabpanel"]:not([inert])').getByRole('combobox').textContent(), 'Claude Opus 5.5');
      await admin.waitForFunction(() => !/待应用/.test(document.querySelector('[role="tabpanel"]:not([inert])').textContent), null, { timeout: 10000 }); // applied: no 待应用 notice
      await page.waitForFunction(() => document.querySelector('#char-config .cfg-model').textContent === '模型：Claude Opus 5.5', null, { timeout: 10000 });
      await admin.screenshot({ path: path.join(SHOTS, '02-claude-opus-picked.png') });
      await page.screenshot({ path: path.join(SHOTS, '02b-claude-page-summary.png') });
      return `${await summary()} (pet window) · settings.json models.claude=lobehub:claude-opus-5-5`;
    }, () => admin);

    await step(S, 'switching to 吉皮缇 switches the list to GPT models, her own OpenAI key marked', async () => {
      await page.click('#char-back');
      await pickCharacter(page, 'gpt');
      await openCharPage(page, 'gpt');
      // her own new agent is on it already if her hello went through the agent (not when the hourly budget made it an offline line)
      assert.equal(await summary(), '模型：GPT-6 Luna');
      await modelTab('gpt');
      const labels = await options();
      const opts = (await view(page)).characters.find((c) => c.id === 'gpt').model.options;
      assert.ok(opts.every((o) => /^(lobehub|openai):(gpt-|o\d)/.test(o.key)), opts.map((o) => o.key).join(','));
      assert.deepEqual(opts.map((o) => [o.key, !!o.hosted]), [['lobehub:gpt-6-sol', true], ['lobehub:gpt-6-luna', true], ['openai:gpt-6-luna', false], ['openai:o3', false]]);
      // the models on her own OpenAI key are told apart from the hosted ones (as the pet window's list did)
      assert.deepEqual(labels, ['GPT-6 Sol', 'GPT-6 Luna', 'GPT-6 Luna（自己的 OpenAI Key）', 'o3（自己的 OpenAI Key）'], `settings window lists ${JSON.stringify(labels)}`);
      assert.equal(await current(), 'lobehub:gpt-6-luna');
      await admin.screenshot({ path: path.join(SHOTS, '03-gpt-models.png') });
      return labels.join(' / ');
    }, () => admin);

    await step(S, 'her next words run on GPT-6 Luna; back on 克洛蒂 her Opus pick returns', async () => {
      await page.click('#panel-close');
      await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 }); // back from the 460 px panel to the pet window (its width follows the pet size)
      await page.evaluate(() => window.pet.chat('你好'));
      await idle();
      assert.equal(modelEdits().pop(), 'lobehub:gpt-6-luna');
      await openCharacters(page);
      await pickCharacter(page, 'claude');
      await openCharPage(page, 'claude');
      assert.equal(await summary(), '模型：Claude Opus 5.5');
      await modelTab('claude');
      assert.equal(await current(), 'lobehub:claude-opus-5-5');
      await admin.screenshot({ path: path.join(SHOTS, '04-back-to-claude.png') });
      return modelEdits().join(' → ');
    }, () => admin);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ charpage
// ⋯ → 角色列表 → a character's page: the list shows every character (picture, name, title, relation); a
// click opens her page, where her look is set for her (not for the companion on the desktop) and her model and
// 个性化设定 are summed up, with a jump to the settings window where they are edited; all kept across a restart;
// she arrives with them; her affection can be unlocked there. The settings window's system pages hold no
// per-character controls, and their settings still save.
async function charpage() {
  return retiredScenario('charpage', 'admin (角色图鉴 → her page, two columns)');
  const S = 'charpage';
  const SHOTS = path.join(OUT, 'charpage');
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-charpage-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-charpagefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  // one recording per app run (before / after the restart), with chapters logged while driving
  const VIDEO = path.join(SHOTS, 'video');
  fs.rmSync(VIDEO, { recursive: true, force: true });
  let seg = 0;
  let rec = null;
  const start = async () => {
    const t0 = Date.now(); // the recording starts with the app, before its first window
    const r = await launch(env, { video: VIDEO });
    rec = { n: ++seg, t0, chapters: [] };
    return r;
  };
  const mark = (kind, text) => rec.chapters.push({ kind, t: Math.round((Date.now() - rec.t0) / 100) / 10, [kind === 'step' ? 'label' : 'note']: text });
  // a check stays on screen for a second so the frame at its chapter shows it
  const check = async (text) => { mark('check', text); await page.waitForTimeout(1000); };
  const stop = async () => {
    const v = page.video && page.video();
    await app.close().catch(() => {});
    const file = v ? await v.path().catch(() => null) : null;
    if (file && fs.existsSync(file)) fs.renameSync(file, path.join(VIDEO, `charpage-${rec.n}.webm`));
    fs.writeFileSync(path.join(VIDEO, `charpage-${rec.n}.chapters.json`), JSON.stringify(rec.chapters, null, 2) + '\n');
  };
  let { app, page } = await start();
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const settingsJson = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  // what the verifier needs from disk: per-character models / looks and every character's affection
  const dumpFiles = (name) => {
    const st = settingsJson();
    const pet = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
    const chars = Object.fromEntries(Object.entries(pet.characters).map(([id, c]) => [id, { name: c.name, agentId: c.agentId, affection: c.affection, relStage: c.relStage, peakStage: c.peakStage, unlockedAllAt: c.unlockedAllAt || null, modelApplied: c.modelApplied || null }]));
    const txt = `--- settings.json (models / appearance / systemRoles / petScale / prefs / tts / visitors) ---\n${JSON.stringify({ models: st.models, appearance: st.appearance, systemRoles: st.systemRoles, petScale: st.petScale, prefs: st.prefs, tts: st.tts, visitors: st.visitors }, null, 2)}\n\n--- pet.json (speciesId + characters) ---\n${JSON.stringify({ speciesId: pet.speciesId, characters: chars }, null, 2)}\n`;
    fs.writeFileSync(path.join(SHOTS, `${name}.txt`), txt);
    return txt;
  };
  const modelEdits = () => (fs.existsSync(path.join(fakeDir, 'edits.log')) ? fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.model) : []);
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  // 模型 and 个性化设定 are edited in the settings window (角色列表 → her page); the pet window's her page sums them up
  // (#char-config) and jumps there (#char-admin). Its model Select is a combobox (its value in a hidden input).
  let admin = null;
  const adminShot = (name) => admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const adminTab = async (id, tab) => {
    if (!admin || admin.isClosed()) admin = await openAdminWindow(app, page, `characters/${id}`);
    else if (!(await admin.locator(`[data-path="/characters/${id}"]`).count())) {
      await admin.evaluate((r) => { location.hash = r; }, `/characters/${id}`);
      await admin.waitForSelector(`[data-path="/characters/${id}"]`);
    }
    await admin.getByRole('tab', { name: tab }).click();
    // while the tabs switch the old panel stays a moment (inert): wait for the one live panel
    await admin.waitForFunction((n) => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === n); return t && t.getAttribute('aria-selected') === 'true' && document.querySelectorAll('[role="tabpanel"]').length === 1; }, tab, { timeout: 5000 });
    await admin.locator('[role="tabpanel"]:not([inert])').waitFor();
  };
  const jumpToAdmin = async (id) => {
    await page.click('#char-admin');
    for (let i = 0; i < 100 && !(admin && !admin.isClosed()); i++) {
      admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
      if (!admin) await page.waitForTimeout(100);
    }
    await admin.waitForSelector(`[data-path="/characters/${id}"]`, { timeout: 15000 });
  };
  const selected = () => admin.locator('[role="tabpanel"]:not([inert]) input[id$="-hidden-input"]').first().inputValue();
  const adminToast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
  const cfg = () => page.evaluate(() => ({ model: document.querySelector('#char-config .cfg-model').textContent, role: document.querySelector('#char-config .cfg-role').textContent }));
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="claude"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();

    await step(S, 'C1 ⋯ → 角色列表 lists every character with her picture, name, title and relation', async () => {
      mark('step', '⋯ → 角色列表');
      await openCharacters(page);
      assert.equal((await page.textContent('#menu-characters')).trim(), '角色列表', 'the ⋯ menu entry');
      assert.equal(await page.textContent('#panel-title'), '角色列表');
      const rows = await page.$$eval('.char-list .char-opt', (rs) => rs.map((r) => ({ id: r.dataset.species, look: r.querySelector('.char-thumb').dataset.look, pic: !!r.querySelector('.char-thumb canvas, .char-thumb img, .char-thumb video'), name: r.querySelector('.meta b').textContent, title: r.querySelector('.meta span').textContent, rel: r.querySelector('.char-rel').textContent, pick: r.querySelector('.pick').textContent, on: r.classList.contains('on') })));
      assert.deepEqual(rows.map((r) => r.id).sort(), ['claude', 'dafeiyu', 'gemini', 'gpt', 'grok']);
      for (const r of rows) {
        assert.ok(r.pic, `${r.id} has a picture`);
        assert.equal(r.look, `${r.id}-pixel`, `${r.id}: her default pack`);
        assert.ok(r.title.length > 0, `${r.id} title`);
      }
      const c = rows.find((r) => r.id === 'claude');
      assert.deepEqual([c.on, c.pick, c.name], [true, '✓ 当前', '克洛蒂（Anthropic）']);
      assert.match(c.rel, /^已认识 · 陌生 · 好感 \d+$/);
      assert.equal(rows.find((r) => r.id === 'gpt').rel, '未见过');
      assert.equal(rows.find((r) => r.id === 'gpt').pick, '初次见面');
      await shot('01-list');
      await check('角色列表：5 位角色，每行有缩略图、名字、称号、关系；克洛蒂为当前');
      return rows.map((r) => `${r.name} ${r.title} [${r.rel}] ${r.look}`).join(' | ');
    }, page);

    await step(S, 'C2 clicking 吉皮缇 (not met) opens her page: her model / 个性化设定 summary, look and affection; back returns to the list', async () => {
      mark('step', '点吉皮缇（未见过）那一行');
      await page.click('.char-list .char-opt[data-species="gpt"] .meta');
      await page.waitForSelector('#char-head .char-opt[data-species="gpt"]');
      assert.equal(await page.textContent('#panel-title'), '吉皮缇');
      assert.match(await page.textContent('#panel-sub'), /吉皮缇（OpenAI）· 未见过/);
      assert.deepEqual(await page.$$eval('#panel-body .adv-section h3', (hs) => hs.map((h) => h.textContent.trim())), ['模型与个性化设定', '外观（角色包）', '好感度 · 一键解锁']);
      assert.equal(await page.locator('#model-select, #role-input').count(), 0, 'edited in the settings window, no second copy here');
      const sum = await cfg();
      assert.match(sum.model, /^模型：/);
      assert.equal(sum.role, '个性化设定：还没写');
      assert.equal(await page.textContent('#char-admin'), '在设置窗口中编辑 ›');
      assert.equal(await page.textContent('#char-head .pick'), '初次见面');
      assert.equal(await page.locator('#unlock-all').isDisabled(), true, 'nothing to unlock before meeting her');
      assert.equal(await page.textContent('#unlock-all'), '还没认识她');
      const opts = (await view(page)).characters.find((c) => c.id === 'gpt').model.options.map((o) => o.key);
      assert.deepEqual(opts, ['lobehub:gpt-6-sol', 'lobehub:gpt-6-luna', 'openai:gpt-6-luna', 'openai:o3'], 'only her vendor\'s models');
      assert.deepEqual(await page.locator('.pack-opt[data-pack] .meta b').allTextContents(), ['吉皮缇 · 像素', '吉皮缇 · 旧版像素']);
      await shot('02-gpt-page');
      await check('吉皮缇详情页：‹ 角色列表、初次见面、模型与个性化设定（摘要 + 在设置窗口中编辑）/ 外观 / 好感度');
      await page.waitForTimeout(800);
      mark('step', '点 ‹ 角色列表 返回');
      await page.click('#char-back');
      await page.waitForSelector('.char-list .char-opt[data-species="gpt"]');
      assert.equal(await page.textContent('#panel-title'), '角色列表');
      await check('回到角色列表');
      await page.waitForTimeout(800);
      mark('step', '再点吉皮缇的“设置 ›”');
      await openCharPage(page, 'gpt');
      return `${sum.model} · ${sum.role}; models ${opts.join(' / ')}`;
    }, page);

    await step(S, 'C3 model o3 (settings window, reached from her page) and look 旧版像素 (her page) are saved for 吉皮缇, not for 克洛蒂 on the desktop', async () => {
      const edits0 = modelEdits().length;
      mark('step', '点“在设置窗口中编辑 ›”→ 设置窗口 · 吉皮缇 · 模型');
      await jumpToAdmin('gpt');
      await adminTab('gpt', '模型');
      const box = admin.locator('[role="tabpanel"]:not([inert])').getByRole('combobox');
      await admin.waitForFunction(() => { const b = document.querySelector('[role="tabpanel"]:not([inert]) [role="combobox"]'); return b && !b.disabled; }, null, { timeout: 15000 });
      await box.click();
      await admin.getByRole('option').first().waitFor();
      const labels = (await admin.getByRole('option').allTextContents()).map((l) => l.trim());
      assert.equal(labels.length, 4, `only her vendor's models: ${labels.join(' / ')}`);
      mark('step', '模型选 o3');
      await admin.getByRole('option', { name: /^o3/ }).click();
      await adminToast(/吉皮缇 的模型/);
      assert.equal(await selected(), 'openai:o3');
      await adminShot('03a-gpt-model-saved');
      await page.waitForFunction(() => /^模型：o3/.test(document.querySelector('#char-config .cfg-model').textContent), null, { timeout: 10000 });
      await shot('03a-gpt-model-summary');
      await check('设置窗口里吉皮缇的模型选为 o3；桌宠里她的页显示“模型：o3”');
      await page.locator('#look-section').scrollIntoViewIfNeeded();
      mark('step', '外观选「吉皮缇 · 旧版像素」');
      await page.click('.pack-opt[data-pack="gpt-classic"] .pick');
      await page.waitForSelector('.pack-opt.on[data-pack="gpt-classic"]');
      assert.equal(await page.getAttribute('#char-head .char-thumb', 'data-look'), 'gpt-classic', 'her picture follows');
      assert.match(await page.textContent('#panel-msg'), /吉皮缇的外观已换成「吉皮缇 · 旧版像素」/);
      const st = settingsJson();
      assert.deepEqual(st.models, { gpt: 'openai:o3' });
      assert.deepEqual(st.appearance, { gpt: 'gpt-classic' });
      await page.waitForTimeout(400);
      assert.equal(modelEdits().length, edits0, '克洛蒂\'s agent is not touched');
      assert.equal(await page.evaluate(() => document.getElementById('pet-look').dataset.key), 'claude-pixel/daily', 'the companion keeps her look');
      await page.locator('#look-section').scrollIntoViewIfNeeded();
      await shot('03-gpt-configured');
      await check('提示“吉皮缇的外观已换成「吉皮缇 · 旧版像素」”，旧版像素为使用中');
      dumpFiles('files-after-c3');
      await page.click('#char-back');
      assert.equal(await page.getAttribute('.char-list .char-opt[data-species="gpt"] .char-thumb', 'data-look'), 'gpt-classic');
      assert.equal(await page.getAttribute('.char-list .char-opt[data-species="claude"] .char-thumb', 'data-look'), 'claude-pixel');
      await shot('04-list-after');
      await check('列表里吉皮缇的缩略图换成旧版像素，克洛蒂不变');
      return `settings.json models=${JSON.stringify(st.models)} appearance=${JSON.stringify(st.appearance)}`;
    }, page);

    const GPT_ROLE = '叫我“老板”。说话多用比喻，聊技术时专业一点。';
    const roleEdits = () => (fs.existsSync(path.join(fakeDir, 'edits.log')) ? fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.systemRole) : []);
    await step(S, 'C3b 个性化设定 for 吉皮缇 (settings window) is saved for her, kept while the window re-renders, and leaves 克洛蒂\'s agent alone', async () => {
      const edits0 = roleEdits().length;
      mark('step', '角色列表 → 吉皮缇 → 在设置窗口中编辑 › → 个性化设定');
      await openCharPage(page, 'gpt');
      await jumpToAdmin('gpt');
      await adminTab('gpt', '个性化设定');
      const input = admin.locator('[data-system-role="gpt"]');
      const save = admin.locator('[data-save-role="gpt"]');
      assert.equal(await input.inputValue(), '', 'empty by default');
      assert.match(await admin.locator('[role="tabpanel"]:not([inert])').textContent(), /0 \/ 1000/);
      assert.equal(await save.isDisabled(), true, 'nothing to save yet');
      await adminShot('03c-gpt-role-empty');
      await check('个性化设定：空的输入框、0 / 1000、保存不可点');
      mark('step', '输入个性化设定（未保存时窗口重绘，草稿还在）');
      await input.fill(GPT_ROLE);
      assert.match(await admin.locator('[role="tabpanel"]:not([inert])').textContent(), new RegExp(`${[...GPT_ROLE].length} / 1000`));
      await page.evaluate(() => window.pet.debugSet({ hunger: 40 })); // an update is broadcast and re-renders both windows
      await page.waitForTimeout(400);
      assert.equal(await input.inputValue(), GPT_ROLE, 'the draft survives a re-render');
      mark('step', '点“保存”');
      await save.click();
      await adminToast(/个性化设定已保存/);
      await admin.waitForFunction(() => document.querySelector('[data-save-role="gpt"]').disabled, null, { timeout: 5000 });
      assert.deepEqual(settingsJson().systemRoles, { gpt: GPT_ROLE });
      await page.waitForTimeout(400);
      assert.equal(roleEdits().length, edits0, '克洛蒂\'s agent is not touched');
      await adminShot('03d-gpt-role-saved');
      await page.waitForFunction((n) => document.querySelector('#char-config .cfg-role').textContent === `个性化设定：已写 ${n} 字`, [...GPT_ROLE].length, { timeout: 10000 });
      await shot('03d-gpt-role-summary');
      await check('设置窗口提示“个性化设定已保存”；桌宠里她的页显示“个性化设定：已写 N 字”');
      await page.click('#char-back');
      return `settings.json systemRoles=${JSON.stringify(settingsJson().systemRoles)}`;
    }, () => admin || page);

    await step(S, 'C4 after a restart she still has o3 (settings window and her page), 旧版像素 and her 个性化设定', async () => {
      mark('step', '关闭应用（重启）');
      await stop();
      admin = null;
      ({ app, page } = await start());
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await idle();
      mark('step', '重启后：⋯ → 角色列表 → 吉皮缇');
      await openCharacters(page, 'gpt');
      await page.waitForFunction(() => /^模型：o3/.test(document.querySelector('#char-config .cfg-model').textContent), null, { timeout: 10000 });
      assert.equal(await page.locator('.pack-opt.on[data-pack="gpt-classic"]').count(), 1);
      assert.equal(await page.getAttribute('#char-head .char-thumb', 'data-look'), 'gpt-classic');
      assert.equal((await cfg()).role, `个性化设定：已写 ${[...GPT_ROLE].length} 字`);
      await shot('05-after-restart');
      await check('重启后吉皮缇的页：模型 o3，个性化设定已写');
      await page.locator('#look-section').scrollIntoViewIfNeeded();
      await shot('05b-after-restart-look');
      await check('重启后吉皮缇的外观仍是旧版像素（使用中）');
      await adminTab('gpt', '模型');
      assert.equal(await selected(), 'openai:o3');
      await adminShot('05c-after-restart-admin-model');
      await adminTab('gpt', '个性化设定');
      assert.equal(await admin.locator('[data-system-role="gpt"]').inputValue(), GPT_ROLE, 'her 个性化设定 too');
      await adminShot('05d-after-restart-admin-role');
      await admin.close();
      admin = null;
      return `model openai:o3, look gpt-classic, role kept; settings.json ${JSON.stringify({ models: settingsJson().models, appearance: settingsJson().appearance })}`;
    }, page);

    await step(S, 'C5 初次见面 from her page: she arrives in 旧版像素 and her own agent runs on o3', async () => {
      await page.evaluate(() => { document.getElementById('panel-body').scrollTop = 0; });
      mark('step', '在她的详情页点“初次见面”，起名“小吉”');
      await page.click('#char-head .pick');
      await page.waitForSelector('.char-name-form input');
      await page.fill('.char-name-form input', '小吉');
      await page.click('.char-name-form button[type="submit"]');
      await page.waitForSelector('#char-head .char-opt.on[data-species="gpt"]', { timeout: 20000 });
      await idle();
      assert.equal(await page.textContent('#panel-title'), '小吉');
      await shot('06-gpt-met');
      await check('小吉来了：详情页显示 ✓ 当前');
      await page.click('#panel-close');
      const v = await view(page);
      assert.equal(v.pet.speciesId, 'gpt');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'gpt-classic/daily', null, { timeout: 5000 });
      const last = modelEdits().pop();
      assert.deepEqual([`${last.provider}:${last.model}`, last.agentId], ['openai:o3', v.pet.agentId]);
      const created = JSON.parse(fs.readFileSync(path.join(fakeDir, 'last-create.json'), 'utf8'));
      assert.ok(created.systemRole.includes(`主人给你的个性化设定`) && created.systemRole.includes(GPT_ROLE), 'her new agent starts with her 个性化设定');
      await check('桌面上是穿旧版像素的吉皮缇');
      await page.waitForTimeout(800);
      return `agent ${v.pet.agentId} on ${last.provider}:${last.model}; look gpt-classic/daily`;
    }, page);

    await step(S, 'C5b changing the companion\'s 个性化设定 (settings window) updates her agent right away; saving it empty removes it', async () => {
      const v0 = await view(page);
      const edits0 = roleEdits().length;
      mark('step', '⋯ → 角色列表 → 小吉（当前）→ 在设置窗口中编辑 › → 改个性化设定');
      await openCharacters(page, 'gpt');
      await jumpToAdmin('gpt');
      await adminTab('gpt', '个性化设定');
      const input = admin.locator('[data-system-role="gpt"]');
      const save = admin.locator('[data-save-role="gpt"]');
      await admin.waitForFunction((t) => document.querySelector('[data-system-role="gpt"]').value === t, GPT_ROLE);
      const next = `${GPT_ROLE}\n我是前端工程师。`;
      await input.fill(next);
      await save.click();
      await adminToast(/个性化设定已保存/);
      const t0 = Date.now();
      while (roleEdits().length === edits0 && Date.now() - t0 < 10000) await page.waitForTimeout(200);
      const e = roleEdits().at(-1);
      assert.equal(e.agentId, v0.pet.agentId);
      assert.ok(e.systemRole.includes(next), 'the agent\'s system role carries the new text');
      await page.waitForFunction((n) => document.querySelector('#char-config .cfg-role').textContent === `个性化设定：已写 ${n} 字`, [...next].length, { timeout: 10000 });
      await adminShot('06b-current-role-saved');
      await check('当前角色：保存后 agent 的 system role 已更新');
      mark('step', '清空输入框并保存（留空即删除）');
      await input.fill('');
      await save.click();
      await admin.waitForFunction(() => document.querySelector('[data-save-role="gpt"]').disabled, null, { timeout: 5000 });
      assert.equal(await input.inputValue(), '');
      const t1 = Date.now();
      while (Object.keys(settingsJson().systemRoles || {}).length && Date.now() - t1 < 5000) await page.waitForTimeout(100);
      assert.deepEqual(settingsJson().systemRoles, {});
      while (roleEdits().length === edits0 + 1 && Date.now() - t1 < 10000) await page.waitForTimeout(200);
      assert.doesNotMatch(roleEdits().at(-1).systemRole, /个性化设定/, 'removed from her agent');
      await page.waitForFunction(() => document.querySelector('#char-config .cfg-role').textContent === '个性化设定：还没写', null, { timeout: 10000 });
      await adminShot('06c-current-role-cleared');
      await shot('06c-current-role-cleared-summary');
      await check('清空后输入框为空，agent 的 system role 里不再有它；桌宠里她的页显示“个性化设定：还没写”');
      await admin.close();
      admin = null;
      await page.click('#panel-close');
      return `edit 1 for ${e.agentId}: …${e.systemRole.slice(e.systemRole.indexOf('主人给你的'), e.systemRole.indexOf('主人给你的') + 80).replace(/\n/g, '⏎')}…; after 清空 systemRoles=${JSON.stringify(settingsJson().systemRoles)}`;
    }, page);
    await step(S, 'C6 克洛蒂\'s page (met, not on the desktop): one-click unlock fills her affection only', async () => {
      mark('step', '⋯ → 角色列表 → 克洛蒂（已认识、不在桌面）→ 一键解锁');
      await openCharacters(page, 'claude');
      assert.match(await page.textContent('#panel-sub'), /已认识/);
      await page.locator('#unlock-all').scrollIntoViewIfNeeded();
      await page.click('#unlock-all');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)', { timeout: 10000 });
      assert.match(await page.textContent('#panel-msg'), /^已为克洛蒂解锁：\d+ 个话题/);
      assert.equal(await page.textContent('#unlock-all'), '已经全部解锁');
      await page.locator('#unlock-section').scrollIntoViewIfNeeded();
      await shot('07-claude-unlocked');
      await check('提示“已为克洛蒂解锁”，按钮变为“已经全部解锁”');
      await page.click('#panel-close');
      const v = await view(page); // boot re-places the window: read the panel first
      const claude = v.characters.find((c) => c.id === 'claude');
      assert.equal(claude.met.affection, 100);
      assert.equal(v.pet.speciesId, 'gpt');
      assert.ok(v.pet.affection < 100, 'the companion (小吉) is untouched');
      const files = dumpFiles('files-after-c6');
      assert.match(files, /"claude": \{[^}]*"affection": 100/);
      return `克洛蒂 ♥${claude.met.affection}; 小吉 ♥${v.pet.affection}`;
    }, page);

    await step(S, 'C7 the settings window\'s system pages have no per-character controls; their settings still save', async () => {
      mark('step', '⋯ → 设置… → 桌宠行为');
      await clickAct(page, 'menu');
      await page.click('[data-menu="settings"]');
      for (let i = 0; i < 100 && !(admin && !admin.isClosed()); i++) {
        admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
        if (!admin) await page.waitForTimeout(100);
      }
      await admin.waitForSelector('[data-admin-page]', { timeout: 15000 });
      const go = async (route) => {
        await admin.evaluate((r) => { location.hash = r; }, route);
        await admin.waitForSelector(`[data-path="${route}"]`, { timeout: 10000 });
      };
      // the system pages sit one level down: tiles on the 玩法 and 设置 hubs
      const tiles = [];
      for (const hub of ['/play', '/settings']) {
        await go(hub);
        tiles.push(...(await admin.$$eval('[data-tile] [data-tile-title]', (ts) => ts.map((t) => t.textContent.trim()))));
      }
      for (const want of ['桌宠行为', '朗读', '语音输入', '同屏伙伴', '对外接口', '版本与更新']) assert.ok(tiles.includes(want), `a hub has ${want}: ${tiles.join(',')}`);
      await go('/behavior');
      await adminShot('08a-settings-behavior');
      await check('设置窗口 · 桌宠行为：宠物大小、动作、触摸……没有模型 / 外观 / 一键解锁');
      for (const r of ['/behavior', '/tts', '/visitors', '/api']) {
        if (r !== '/behavior') await go(r);
        assert.equal(await admin.locator(':is([data-unlock], [data-use-pack], [data-system-role], [data-save-role], [data-switch])').count(), 0, `${r}: no per-character controls`);
      }
      await go('/behavior');
      mark('step', '关掉“梗图”');
      await admin.click('[data-key="prefs.memes"]');
      await adminToast(/已保存：梗图 → 关/);
      mark('step', '宠物大小拖到 150%');
      const thumb = admin.locator('[data-key="petScale"] input[type="range"]').first();
      for (const want of [1.3, 1.35, 1.4, 1.45, 1.5]) {
        await thumb.focus();
        await admin.keyboard.press('ArrowRight');
        await page.waitForFunction((w) => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) === w, want, { timeout: 8000 });
      }
      await adminToast(/已保存：宠物大小 → 150%/);
      await adminShot('08-settings-behavior-saved');
      await check('改宠物大小为 150%：提示已保存');
      mark('step', '朗读 → 引擎用不了时：不出声');
      await go('/tts');
      await admin.getByText('不出声', { exact: true }).click();
      await adminToast(/已保存：引擎用不了时 → 不出声/);
      await adminShot('08b-settings-tts');
      const st = settingsJson();
      assert.equal(st.prefs.memes, false);
      assert.equal(st.tts.fallback, 'silent');
      assert.equal(st.petScale, 1.5);
      assert.deepEqual([st.models, st.appearance, st.systemRoles], [{ gpt: 'openai:o3' }, { gpt: 'gpt-classic' }, {}], 'per-character settings untouched');
      const pet = await page.evaluate(async () => (await window.pet.getSettings()).prefs.memes);
      assert.equal(pet, false, 'the pet window has the new setting');
      dumpFiles('files-after-c7');
      return `hub tiles ${tiles.join(' / ')}; prefs.memes=false tts.fallback=silent petScale=1.5`;
    }, () => admin || page);
  } finally {
    await stop();
  }
}

// ------------------------------------------------------------------ update
// 检查更新 from the ⋯ menu against a local update feed (Linux path: GitHub's "latest release" JSON).
async function update() {
  const S = 'update';
  const http = require('node:http');
  const { version } = require('../package.json');
  let tag = `v${version}`;
  const server = http.createServer((req, res) => {
    if (req.url !== '/releases/latest') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases/tag/${tag}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const feed = `http://127.0.0.1:${server.address().port}`;
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-updfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-upd-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_UPDATE_TEST: '1', PIXELPET_UPDATE_FEED: feed });
  // 版本与更新 lives in the settings window now: ⋯ → 检查更新 opens it at #/update and starts a check
  let admin = null;
  const adminWin = async () => {
    for (let i = 0; i < 100; i++) {
      const w = app.windows().find((p) => p.url().includes('admin-ui'));
      if (w) return w;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the settings window did not open');
  };
  // the 版本 card's rows (当前版本 / 状态 / 上次检查) as one line
  const updateText = () => admin.evaluate(() => document.querySelector('[data-path="/update"]').innerText.replace(/\s+/g, ' ').trim());
  const waitStatus = (re) => admin.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-path="/update"]').innerText.replace(/\s+/g, ' ')), re.source, { timeout: 15000 });
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="grok"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });

    await step(S, '⚙ 设置 → 版本与更新 → 检查更新 shows the version and says it is the newest one', async () => {
      await clickAct(page, 'settings');
      admin = await adminWin();
      await admin.waitForSelector('[data-path="/overview"]', { timeout: 15000 });
      await admin.evaluate(() => { location.hash = '/update'; });
      await admin.waitForSelector('[data-path="/update"]', { timeout: 15000 });
      await admin.getByRole('button', { name: '检查更新' }).click();
      await waitStatus(/状态 已是最新版本/);
      const text = await updateText();
      assert.match(text, new RegExp(`当前版本 v?${version.replace(/\./g, '\\.')} 状态`));
      assert.match(text, /上次检查 \d/, 'the time of the check is shown');
      assert.equal(await admin.getByRole('button', { name: '立即更新' }).count(), 0, 'nothing to install');
      assert.equal(await page.getAttribute('#btn-settings', 'data-news'), '', 'no dot on ⚙ either');
      await admin.screenshot({ path: path.join(OUT, 'update-latest.png') });
      return text.slice(text.indexOf('当前版本'), text.lastIndexOf('检查更新')).trim();
    }, () => admin || page);

    await step(S, 'when a newer release exists, 检查更新 in the settings window finds it; the pet says so, ⚙ gets a dot and opens 版本与更新 with the download', async () => {
      tag = 'v9.9.9';
      await admin.getByRole('button', { name: '检查更新' }).click();
      await waitStatus(/状态 需要手动下载新版本 · v?9\.9\.9/);
      const text = await updateText();
      await admin.screenshot({ path: path.join(OUT, 'update-found.png') });
      // the pet window hears it too: she says it in her bubble, ⋯ gets 下载新版本 (which opens the release page)
      await page.waitForFunction(() => /有新版本 v9\.9\.9/.test(document.getElementById('bubble').textContent), null, { timeout: 5000 });
      const said = await bubbleText(page);
      await page.bringToFront();
      assert.equal(await page.getAttribute('#btn-settings', 'data-news'), 'update');
      await hover(page);
      await page.screenshot({ path: path.join(OUT, 'update-menu.png') });
      await admin.evaluate(() => { location.hash = '/overview'; });
      await clickAct(page, 'settings');
      await admin.waitForSelector('[data-path="/update"]', { timeout: 15000 });
      const menu = (await admin.textContent('[data-update-download]')).trim();
      assert.match(menu, /下载新版本 v9\.9\.9/);
      return `${text.slice(text.indexOf('状态'), text.indexOf('上次检查')).trim()} · bubble 「${said}」 · ⚙ → #/update: ${menu}`;
    }, page);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
}

// ------------------------------------------------------------------ space
// Where the pet's agent lives: the personal space is the default; a workspace can be chosen; with
// `lh workspace use` pinned, choosing personal says that it switches lh back first.
async function space() {
  const S = 'space';
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-spacefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(fakeDir, 'workspaces.json'), JSON.stringify([{ id: 'ws_TEAM', slug: 'team', name: 'Team Space' }, { id: 'ws_LAB', slug: 'lab', name: 'Lab' }]));
  fs.writeFileSync(path.join(fakeDir, 'pinned-workspace'), 'ws_TEAM');
  const createCall = () => fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((c) => c.args[0] === 'agent' && c.args[1] === 'create').pop();
  const start = async (page) => {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="claude"]').first().click();
    await page.click('#hatch-btn');
    await page.waitForSelector('#space-box:not(.hidden)', { timeout: 15000 });
  };
  let { app, page } = await launch({ PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-space-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  try {
    await step(S, 'after login it asks where to put the pet: personal first and selected, then each workspace', async () => {
      await start(page);
      const names = await page.locator('.space-opt .nm').allTextContents();
      assert.deepEqual(names, ['个人空间', 'Team Space', 'Lab']);
      assert.equal(await page.locator('.space-opt input').first().isChecked(), true);
      assert.match(await page.textContent('#space-note'), /Team Space.*lh workspace use --personal/);
      return names.join(' / ');
    }, page);

    await step(S, 'keeping the default puts the agent in the personal space (lh switched back to personal)', async () => {
      await page.click('#space-go');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      assert.equal(createCall().env.workspace, null);
      assert.equal(fs.existsSync(path.join(fakeDir, 'pinned-workspace')), false);
      assert.match(await page.getAttribute('#meta', 'title'), /放在：个人空间/);
    }, page);

    await step(S, 'choosing a workspace creates the agent there', async () => {
      await page.evaluate(() => window.pet.release({ deleteAgent: true }));
      await app.close();
      ({ app, page } = await launch({ PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-space2-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }));
      await start(page);
      assert.equal(await page.locator('#space-note').isHidden(), true, 'nothing is pinned any more');
      await page.locator('.space-opt').nth(2).click();
      await page.screenshot({ path: path.join(OUT, 'space-chooser-workspace.png') });
      await page.click('#space-go');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      assert.equal(createCall().env.workspace, 'ws_LAB');
      assert.match(await page.getAttribute('#meta', 'title'), /放在：Lab/);
    }, () => page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ art
// Contact sheets drawn by the app's own renderer (lookEl, the same code the pet and the wardrobe use):
// every character in every outfit she offers, and every character in every state of the effects layer.
async function art() {
  const S = 'art';
  const { app, page } = await launch({ PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-art-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-artfake-')) });
  const { OUTFITS } = require('../src/core/outfits');
  const P = require('../src/core/packs');
  const { STATES } = require('../src/core/fx');
  const { SPECIES, SPECIES_IDS } = require('../src/core/species');
  const { packs } = P.loadPacks([{ dir: path.join(ROOT, 'src', 'renderer', 'packs'), source: 'builtin' }]);
  try {
    await page.waitForSelector('.char-card');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1500, 900));
    await step(S, 'outfit sheet: every character in every outfit she offers', async () => {
      const cols = OUTFITS.filter((o) => SPECIES_IDS.some((id) => SPECIES[id].outfits.includes(o.id)));
      const rows = SPECIES_IDS.map((id) => ({ id, cells: cols.map((o) => (SPECIES[id].outfits.includes(o.id) ? { look: P.resolveLook(packs, { packId: P.chosenPack(packs, {}, id), fallbackId: P.fallbackPack(id), speciesId: id, outfitId: o.id }) } : null)) }));
      const missing = await page.evaluate(async ({ rows, labels }) => {
        document.body.innerHTML = '';
        document.body.style.cssText = 'margin:0;background:#e9e4f5;overflow:visible';
        const grid = document.createElement('div');
        grid.style.cssText = `display:grid;grid-template-columns:70px repeat(${labels.length},84px);gap:2px;padding:4px;font:10px sans-serif;text-align:center`;
        ['', ...labels].forEach((l) => { const d = document.createElement('div'); d.textContent = l; grid.appendChild(d); });
        const waits = [];
        for (const row of rows) {
          const h = document.createElement('div');
          h.textContent = row.id;
          h.style.cssText = 'align-self:center;font-weight:bold';
          grid.appendChild(h);
          for (const c of row.cells) {
            const cell = document.createElement('div');
            cell.style.cssText = 'height:150px;display:flex;align-items:flex-end;justify-content:center;background:#fff;overflow:hidden';
            if (c) {
              const el = lookEl(c.look, { className: 'look', speciesId: row.id }); // pictures, sprites, or her clips
              el.style.cssText = c.look ? 'height:146px;max-width:82px;object-fit:contain' : 'height:84px;width:84px';
              if (c.look) waits.push((c.look.kind === 'sprites' ? sheetReady(c.look.url) : el.decode()).then(() => null, () => c.look.url));
              cell.appendChild(el);
            } else cell.textContent = '—';
            grid.appendChild(cell);
          }
        }
        document.body.appendChild(grid);
        const bad = (await Promise.all(waits)).filter(Boolean);
        tickSprites(performance.now()); // the app's frame loop stopped with its screens gone: draw once
        return bad;
      }, { rows, labels: cols.map((o) => o.label) });
      assert.deepEqual(missing, []);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, 'outfit-sheet.png'), fullPage: true });
      return `rows: ${SPECIES_IDS.join(', ')}; columns: ${cols.map((o) => o.id).join(', ')} (— = no art, not offered)`;
    });

    await step(S, 'state sheet: every character in every state of the shared effects layer, drawn by the app', async () => {
      const Fx = require('../src/core/fx');
      const rows = [];
      // 大肥鱼's clips (a frame from each), then every pixel pack
      const sp = SPECIES.dafeiyu;
      rows.push({ name: 'dafeiyu (clips)', cells: STATES.map((st) => {
        const a = Fx.resolveAction(st, (n) => !!sp.clips[n]);
        const clip = [].concat(sp.clips[a.name])[0]; // a state with several clips (pat, happy) shows its first one
        return { clip: `${sp.clipDir}/${clip}`, exact: a.exact };
      }) });
      for (const id of ['dafeiyu-pixel', 'claude-pixel', 'grok-pixel', 'gemini-pixel', 'gpt-pixel']) {
        const pk = packs.get(id);
        const look = P.resolveLook(packs, { packId: id, fallbackId: id, speciesId: pk.species, outfitId: 'daily' });
        rows.push({ name: id, cells: STATES.map((st) => ({ look, state: st })) });
      }
      const n = await page.evaluate(async ({ rows, states }) => {
        document.body.innerHTML = '';
        document.body.style.cssText = 'margin:0;background:#2b2440;overflow:visible';
        const grid = document.createElement('div');
        grid.style.cssText = `display:grid;grid-template-columns:96px repeat(${states.length},84px);gap:2px;padding:4px;font:10px sans-serif;color:#fff;text-align:center`;
        ['', ...states].forEach((l) => { const d = document.createElement('div'); d.textContent = l; grid.appendChild(d); });
        const waits = [];
        for (const row of rows) {
          const h = document.createElement('div');
          h.textContent = row.name;
          h.style.cssText = 'align-self:center;font-weight:bold';
          grid.appendChild(h);
          for (const c of row.cells) {
            const cell = document.createElement('div');
            cell.style.cssText = 'height:118px;display:flex;align-items:flex-end;justify-content:center;background:#3a3354;position:relative;overflow:hidden';
            if (c.clip) {
              const wrap = document.createElement('div');
              wrap.className = 'look vlook';
              wrap.style.cssText = 'width:84px;height:84px';
              const v = document.createElement('video');
              v.muted = true;
              v.src = c.clip;
              waits.push(new Promise((res) => { v.addEventListener('loadeddata', () => { v.currentTime = 2.5; v.addEventListener('seeked', res, { once: true }); }, { once: true }); setTimeout(res, 5000); }));
              wrap.appendChild(v);
              cell.appendChild(wrap);
              if (!c.exact) { const t = document.createElement('span'); t.textContent = '↪'; t.style.cssText = 'position:absolute;top:2px;right:4px'; cell.appendChild(t); }
            } else {
              const el = lookEl(c.look, { className: 'look', action: () => c.state });
              el.style.cssText = 'height:113px;width:auto';
              waits.push(sheetReady(c.look.url));
              cell.appendChild(el);
            }
            grid.appendChild(cell);
          }
        }
        document.body.appendChild(grid);
        await Promise.all(waits);
        tickSprites(performance.now()); // the app's frame loop stopped with its screens gone: draw once
        return rows.length * states.length;
      }, { rows, states: STATES });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, 'state-sheet.png'), fullPage: true });
      return `${n} cells: rows dafeiyu clips + dafeiyu/claude/grok/gemini/gpt pixel; columns: ${STATES.join(', ')} (↪ = DeepSeek clip borrowed through the fallback chain)`;
    });
  } finally {
    await app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- roster
// The model-chan roster: for every character, wake her up and trigger every effect of the shared
// effects layer (src/core/fx.js + src/renderer/fx.js), asserting the state, what was played (clip or
// sprite action) and taking a screenshot each time. One screen recording per character.
const ROSTER = [
  { id: 'dafeiyu', idx: 0, zh: '大肥鱼', vendor: 'DeepSeek' },
  { id: 'claude', idx: 1, zh: '克洛蒂', vendor: 'Anthropic' },
  { id: 'grok', idx: 2, zh: '格萝可', vendor: 'xAI' },
  { id: 'gemini', idx: 3, zh: '杰米', vendor: 'Google' },
  { id: 'gpt', idx: 4, zh: '吉皮缇', vendor: 'OpenAI' },
];
const SPECIES_MEMES = { dafeiyu: 'onebowl', claude: 'think', grok: 'interesting', gemini: 'peek', gpt: 'glad' };
async function roster() {
  return retiredScenario('roster', "admin a13b (every character's built-in packs on her stage)");
  const only = process.argv[3];
  for (const ch of ROSTER) if (!only || only === ch.id) await rosterOne(ch);
}
async function rosterOne(ch) {
  const S = `roster-${ch.id}`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-roster-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rosterfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const VIDEO = path.join(OUT, 'roster-video', ch.id);
  fs.rmSync(VIDEO, { recursive: true, force: true });
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, FAKE_LH_RUN_DELAY_MS: '2500' }, { video: VIDEO });
  const fxState = () => page.evaluate(() => window.petFx.state());
  const clip = () => page.evaluate(() => document.getElementById('pet-video').dataset.key || '');
  // what the pet shows for `state`: the clip for a video character, the sprite action otherwise
  const shows = async (state, want = state) => {
    await page.waitForFunction((s) => window.petFx.state() && window.petFx.state().state === s, state, { timeout: 8000 });
    const st = await fxState();
    if (st.video) {
      await page.waitForFunction((w) => document.getElementById('pet-video').dataset.key === w, want, { timeout: 5000 });
      return `state=${st.state} clip=${await clip()}.webm`;
    }
    await page.waitForFunction((w) => window.petFx.state().action === w, want, { timeout: 3000 }).catch(() => {});
    const now = await fxState();
    assert.equal(now.action, want, `action for ${state}`);
    assert.equal(now.exact, true, `${ch.id} has its own art for ${state}`);
    return `state=${now.state} action=${now.action} (own sprite row)`;
  };
  const leave = () => page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const settle = async () => { await page.evaluate(() => window.petFx.cue('idle')); await page.waitForTimeout(150); };
  try {
    if (ch.idx === 0) {
      await step(S, 'onboarding offers the five model-chan, no spirit stones', async () => {
        await page.waitForSelector('.char-card');
        assert.equal(await page.locator('.char-card').count(), 13, 'one card per look (T-2764)');
        const vendors = [...new Set((await page.locator('.char-card .vendor').allTextContents()).map((v) => v.split(' · ')[0]))];
        assert.deepEqual(vendors, ['DeepSeek', 'Anthropic', 'xAI', 'Google', 'OpenAI']);
        assert.doesNotMatch(await page.textContent('#onboarding'), /灵石|蛋/);
        return vendors.join(' / ');
      }, page);
    }
    await step(S, `choose ${ch.zh} (${ch.vendor})`, async () => {
      await page.waitForSelector('.char-card');
      await page.locator(`.char-card[data-species="${ch.id}"]`).first().click();
      assert.equal(await page.getAttribute(`.char-card[data-species="${ch.id}"]`, 'aria-checked'), 'true');
      assert.match(await page.textContent('#card-info'), new RegExp(`${ch.vendor}|${ch.zh}`));
      assert.equal(await page.locator('#hatch-btn').isDisabled(), false);
      return (await page.textContent('#card-info')).slice(0, 60);
    }, page);
    await step(S, 'E1 wake-up plays her hatch state', async () => {
      await page.click('#hatch-btn');
      await page.waitForSelector('#hatch-title:has-text("醒来了")', { timeout: 20000 });
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#hatch-look canvas.sprite').count(), 1, 'every character, 大肥鱼 included, starts in pixels');
      return 'sprite hatch action';
    }, page);
    await step(S, 'E2 on the desktop she idles', async () => {
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await leave();
      await idle();
      await page.evaluate(() => window.pet.debugSet({ hunger: 30, mood: 55, energy: 90, sleeping: false }));
      await page.waitForFunction(() => window.petFx.state().state === 'idle', null, { timeout: 15000 });
      assert.match(await page.textContent('#meta'), new RegExp(ch.zh));
      return shows('idle');
    }, page);
    await step(S, 'E3a the idle chain starts a cue on its own (no input)', async () => {
      await leave();
      await page.waitForFunction(() => window.petFx.state().lastCue, null, { timeout: 30000 });
      const st = await fxState();
      return `idle chain played "${st.lastCue}" by itself (facing ${st.facing})`;
    }, page);
    await step(S, 'E3b look around', async () => { await page.evaluate(() => window.petFx.cue('look')); return shows('look'); }, page);
    await step(S, 'E3c turn: the character is mirrored', async () => {
      await settle();
      await page.evaluate(() => window.petFx.face('right'));
      await page.waitForFunction(() => window.petFx.state().facing === 'right', null, { timeout: 3000 });
      const before = (await fxState()).facing;
      await page.evaluate(() => window.petFx.cue('turn'));
      await page.waitForFunction((b) => window.petFx.state().facing !== b, before, { timeout: 3000 });
      const scale = await page.evaluate(() => getComputedStyle(document.querySelector('#pet-body[data-facing="left"] .char, #pet-body[data-facing="left"] video')).scale);
      return `facing ${before} → ${(await fxState()).facing}, CSS scale ${scale}`;
    }, page);
    await step(S, 'E3d turn back', async () => {
      await page.evaluate(() => window.petFx.cue('turn'));
      await page.waitForFunction(() => window.petFx.state().facing === 'right', null, { timeout: 3000 });
      return 'facing right';
    }, page);
    await step(S, 'E4 a click: a reaction with a squash and hearts', async () => {
      await settle();
      await hover(page);
      await clickHead(page);
      await page.waitForFunction(() => ['pat', 'happy'].includes(window.petFx.state().state), null, { timeout: 4000 });
      const squash = await page.evaluate(() => document.getElementById('pet-body').classList.contains('squash'));
      assert.equal(squash, true, 'squash');
      await page.waitForTimeout(150);
      const st = await fxState();
      const hearts = await page.locator('.heart-p').count();
      assert.ok(hearts > 0, 'heart particles');
      return `${await shows(st.state, st.video ? st.state : st.state)}, squash, ${hearts} hearts`;
    }, page);
    await step(S, 'E4b with 部位触摸 off, the next click picks the other reaction', async () => {
      // a touched part always plays its own clip (or pat); the old click alternates pat / happy
      await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
      try {
        await page.waitForTimeout(3200);
        await clickHead(page);
        await page.waitForFunction(() => ['pat', 'happy'].includes(window.petFx.state().state), null, { timeout: 4000 });
        const first = (await fxState()).state;
        await page.waitForTimeout(3200);
        await clickHead(page);
        await page.waitForFunction((f) => ['pat', 'happy'].includes(window.petFx.state().state) && window.petFx.state().state !== f, first, { timeout: 4000 });
        return `${first} → ${(await fxState()).state}`;
      } finally {
        await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
      }
    }, page);
    await step(S, 'E5 dragged: she is lifted (dangling)', async () => {
      await settle();
      // let the E4 click line ("突然被摸头…") fade first, so the lifted screenshot is not mistaken for a pat
      await page.waitForFunction(() => document.getElementById('bubble').classList.contains('hidden'), null, { timeout: 15000 });
      await page.waitForTimeout(350); // not within 300 ms of the last click: that would be the slingshot
      const box = await page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 - 8, { steps: 4 });
      await page.waitForFunction(() => window.petFx.state().state === 'lifted', null, { timeout: 3000 });
      await page.waitForFunction(() => document.getElementById('pet-body').classList.contains('lifted'), null, { timeout: 2000 }); // set on the next frame
      // every character has her own lifted art now (Dafeiyu: dsh-pet's drag clip, no ❗ stand-in)
      const out = await shows('lifted');
      assert.equal((await fxState()).exact, true, 'own lifted art');
      assert.equal(await page.textContent('#char-fx'), '', 'no emoji stand-in');
      // capture a frame that reads as lifted: near the peak of the dangle swing, and for the video, 2 s into
      // dsh-pet's drag clip, where she has risen with her arms out (its first second still looks like idle)
      await page.waitForFunction(() => {
        const v = document.getElementById('pet-video'), m = new DOMMatrix(getComputedStyle(document.getElementById('pet-body')).transform);
        return (!v || !v.dataset.key || v.currentTime >= 2) && Math.abs(Math.atan2(m.b, m.a) * 180 / Math.PI) >= 3;
      }, null, { timeout: 6000, polling: 16 });
      const held = await page.evaluate(() => {
        const b = document.getElementById('pet-body'), v = document.getElementById('pet-video'), bubble = document.getElementById('bubble');
        const m = new DOMMatrix(getComputedStyle(b).transform);
        return { fx: window.petFx.state(), bodyClass: b.className, action: b.dataset.action || null, rotateDeg: +(Math.atan2(m.b, m.a) * 180 / Math.PI).toFixed(2),
          video: v && v.dataset.key ? { key: v.dataset.key, currentTime: +v.currentTime.toFixed(2), paused: v.paused } : null,
          bubble: bubble.classList.contains('hidden') ? null : bubble.textContent };
      });
      assert.equal(held.fx.state, 'lifted', 'still lifted at the screenshot');
      assert.ok(held.bodyClass.split(' ').includes('lifted'), 'dangling class at the screenshot');
      assert.equal(held.bubble, null, 'no speech bubble over the lifted screenshot');
      await page.screenshot({ path: path.join(OUT, `${S}-lifted.png`) });
      fs.writeFileSync(path.join(OUT, `${S}-lifted.json`), JSON.stringify(held, null, 2));
      await page.waitForTimeout(250); // hold still before letting go: a drop, not a throw
      await page.mouse.up();
      assert.equal((await fxState()).flying, false, 'a slow release does not throw');
      return out;
    }, page);
    await step(S, 'E6 thrown: flies, bounces off the screen edges and lands', async () => {
      await leave();
      await page.waitForFunction(() => !window.petFx.state().flying, null, { timeout: 10000 });
      const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      const res = await page.evaluate(() => window.petFx.throw(-1600, -900));
      const after = await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows()[0]; return { b: w.getBounds(), wa: screen.getDisplayMatching(w.getBounds()).workArea }; });
      assert.ok(res && res.bounces >= 1, JSON.stringify(res));
      assert.notDeepEqual([after.b.x, after.b.y], [before.x, before.y]);
      assert.equal(after.b.y, after.wa.y + after.wa.height - after.b.height, 'rests on the bottom of the work area');
      assert.ok(after.b.x >= after.wa.x && after.b.x + after.b.width <= after.wa.x + after.wa.width);
      return `window ${before.x},${before.y} → ${after.b.x},${after.b.y}; ${res.bounces} bounces (${[...new Set(res.hits)].join(', ')})`;
    }, page);
    for (const [i, food] of [[0, 'rice'], [1, 'cookie'], [2, 'fruit']].map(([n, f]) => [n, f])) {
      await step(S, `E7 fed ${food}`, async () => {
        await idle();
        await page.evaluate(() => window.pet.debugSet({ hunger: 70, sleeping: false, energy: 90 }));
        await clickAct(page, 'feed');
        await page.click(`#food-menu .btn >> nth=${i}`);
        return shows(`eat_${food}`);
      }, page);
      await page.waitForTimeout(3600);
    }
    await step(S, 'E8 play', async () => {
      await idle();
      await page.evaluate(() => window.pet.debugSet({ energy: 90, sleeping: false, hunger: 20 }));
      await clickAct(page, 'play');
      return shows('play');
    }, page);
    await page.waitForTimeout(4200);
    await step(S, 'E9 sleep', async () => {
      await idle();
      await page.evaluate(() => window.pet.debugSet({ energy: 20 }));
      await clickAct(page, 'sleep');
      await leave();
      return shows('sleep');
    }, page);
    await step(S, 'E10a hungry', async () => {
      await page.evaluate(() => window.pet.debugSet({ sleeping: false, hunger: 90, mood: 50 }));
      return shows('hungry');
    }, page);
    await step(S, 'E10b sad', async () => {
      await page.evaluate(() => window.pet.debugSet({ hunger: 20, mood: 10 }));
      return shows('sad');
    }, page);
    await step(S, 'E10c happy', async () => {
      await page.evaluate(() => window.pet.debugSet({ hunger: 20, mood: 90 }));
      return shows('happy');
    }, page);
    await step(S, 'E11a work status: thinking while the agent works', async () => {
      await page.evaluate(() => window.pet.debugSet({ mood: 55 }));
      await clickAct(page, 'chat');
      await page.fill('#chat-input', '帮我想想今天吃什么');
      await page.press('#chat-input', 'Enter');
      await leave();
      return shows('think');
    }, page);
    await step(S, 'E11b work status: talking when the reply arrives', async () => {
      await page.waitForFunction(() => !document.getElementById('bubble').classList.contains('thinking') && /echo:/.test(document.getElementById('bubble').textContent), null, { timeout: 15000 });
      return `${await shows('talk')}; bubble: ${(await bubbleText(page)).slice(0, 30)}`;
    }, page);
    await step(S, 'E11c work status: an error makes her upset', async () => {
      await idle();
      await page.waitForTimeout(4200);
      await page.evaluate(() => window.petFx.error());
      return shows('sad');
    }, page);
    await step(S, 'E11d the time background is in every message to the agent', async () => {
      const prompt = fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop().prompt;
      assert.match(prompt, /现在\d\d:\d\d（(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|深夜)，星期./);
      return prompt.match(/现在[^；]+/)[0];
    });
    await step(S, 'E12 relationship stage-up: evolve, sparkle and hearts', async () => {
      await page.waitForTimeout(3600);
      await idle();
      await page.evaluate(() => window.pet.debugSet({ affection: 16 }));
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 5000 });
      return `${await shows('evolve')}; toast: ${(await page.textContent('#toast-title')).trim()}`;
    }, page);
    await step(S, 'E13 a wardrobe with her signature outfit', async () => {
      await idle();
      await page.click('#toast-close');
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('#panel:not(.hidden) .card');
      const ids = await page.$$eval('.card', (els) => els.map((e) => e.dataset.outfit));
      const label = await page.textContent('.card[data-outfit="daily"] .nm');
      assert.deepEqual(ids, require(`../src/characters/${ch.id}.json`).outfits, 'the outfits her character file offers (locked ones included)');
      return `${ids.length} outfit(s); daily = ${label}`;
    }, page);
    // ---- the dsh-pet effects added in T-1163 (docs/dsh-pet-gap.md), for every character --------------
    if (await page.isVisible('#panel-close')) await page.click('#panel-close');
    const winOf = (pg) => app.evaluate(({ BrowserWindow }, t) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getTitle() === t || x.webContents.getURL().includes(t)); return w ? w.getBounds() : null; }, pg);
    const mainBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('visitor=')).getBounds());
    const toFloor = async (x) => app.evaluate(({ BrowserWindow, screen }, x) => { const w = BrowserWindow.getAllWindows().find((v) => !v.webContents.getURL().includes('visitor=')); const wa = screen.getDisplayMatching(w.getBounds()).workArea; const b = w.getBounds(); w.setPosition(Math.round(x == null ? b.x : x), wa.y + wa.height - b.height); return w.getBounds(); }, x);
    const waitLanded = () => page.waitForFunction(() => !window.petFx.state().flying, null, { timeout: 15000 });
    await step(S, 'N1 roaming: she walks a few steps the way she faces, and the window moves', async () => {
      await idle();
      await leave();
      await page.waitForTimeout(300);
      await toFloor(200);
      await page.evaluate(() => window.petFx.face('right'));
      const before = await mainBounds();
      const walking = page.evaluate(() => window.petFx.walk());
      await page.waitForFunction(() => window.petFx.state().state === 'walk' && document.getElementById('pet-body').dataset.state === 'walk', null, { timeout: 3000 });
      await page.waitForTimeout(200); // the next frame draws it
      const ws = await fxState();
      const st = ws.video ? `state=walk clip=${await clip()}.webm` : `state=walk action=${ws.action} exact=${ws.exact} overlay ${await page.textContent('#char-fx')}`;
      let steps = '';
      if (ws.video) assert.equal(await clip(), 'walk');
      else {
        // her own walk cycle (side view on the HD packs, scripts/art/add_walk_frames.py), not the idle art sliding along
        assert.equal(ws.action, 'walk');
        assert.equal(ws.exact, true);
        assert.equal(await page.textContent('#char-fx'), '');
        const seen = new Set();
        for (let i = 0; i < 10; i++) { seen.add(await page.$eval('#pet-look canvas', (c) => c.dataset.frame.split('#')[1])); await page.waitForTimeout(100); }
        assert.ok(seen.size >= 3, `the walk frames play: ${[...seen]}`);
        steps = `, frames ${[...seen].sort().join(' ')}`;
      }
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${S}-walk.png`) });
      await walking;
      const after = await mainBounds();
      const w = (await page.evaluate(() => window.petFx.stats())).lastWalk;
      assert.notEqual(after.x, before.x, 'the window moved');
      assert.equal(after.x, w.to);
      assert.ok(Math.abs(after.x - before.x) >= 60 && Math.abs(after.x - before.x) <= 240 * 2);
      return `${st}; window x ${before.x} → ${after.x} (facing ${w.facing})${steps}`;
    }, page);
    await step(S, 'N1b walking left: the same side view, mirrored, and the window moves left', async () => {
      await idle();
      await leave();
      await page.evaluate(() => window.petFx.face('left'));
      const before = await mainBounds();
      const walking = page.evaluate(() => window.petFx.walk());
      await page.waitForFunction(() => window.petFx.state().state === 'walk', null, { timeout: 3000 });
      await page.waitForTimeout(500);
      const ws = await fxState();
      assert.equal(ws.facing, 'left');
      const scale = await page.$eval(ws.video ? '#pet-body video' : '#pet-look canvas', (el) => getComputedStyle(el).scale);
      assert.equal(scale, '-1 1', 'mirrored');
      await page.screenshot({ path: path.join(OUT, `${S}-walk-left.png`) });
      await walking;
      const after = await mainBounds();
      const w = (await page.evaluate(() => window.petFx.stats())).lastWalk;
      assert.equal(w.facing, 'left');
      assert.ok(after.x < before.x, `moved left: ${before.x} → ${after.x}`);
      return `facing left, scale ${scale}${ws.video ? '' : `, action=${ws.action}`}; window x ${before.x} → ${after.x}`;
    }, page);
    await step(S, 'N2 touch: a long press on her opens the menu', async () => {
      await idle();
      await leave();
      await page.evaluate(() => {
        const el = document.querySelector('#pet-body .pet-hit:not(.hidden)');
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, screenX: window.screenX + r.left + r.width / 2, screenY: window.screenY + r.top + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
      });
      await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 2000 });
      const ms = await page.evaluate(() => performance.now());
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch' })));
      assert.equal(await page.evaluate(() => document.body.classList.contains('hover')), true);
      return `menu open after a 500 ms hold (no mouse); items: ${(await page.locator('#main-menu .btn:not(.hidden)').allTextContents()).slice(0, 4).join(' / ')}…`;
    }, page);
    await step(S, 'N3 right click on her opens the same menu', async () => {
      await page.evaluate(() => document.getElementById('main-menu').classList.add('hidden'));
      await page.locator('#pet-body .pet-hit:not(.hidden)').click({ button: 'right' });
      await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 2000 });
      await toFloor(0);
      await page.click('[data-menu="home"]');
      await page.waitForTimeout(300);
      const home = await app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows().find((v) => !v.webContents.getURL().includes('visitor=')); return { b: w.getBounds(), wa: screen.getPrimaryDisplay().workArea }; });
      assert.equal(home.b.x, home.wa.x + home.wa.width - home.b.width - 24, 'back in the bottom-right corner');
      return `contextmenu → ⋯ menu; 回到右下角 → window at ${home.b.x},${home.b.y}`;
    });
    await step(S, 'N4 动作 menu: play any effect on request', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="actions"]');
      await page.waitForSelector('#action-menu:not(.hidden)');
      await page.screenshot({ path: path.join(OUT, `${S}-action-menu.png`) });
      await page.click('#action-menu [data-cue="look"]');
      return `${(await page.locator('#action-menu .btn').allTextContents()).join(' ')} → ${await shows('look')}`;
    }, page);
    await step(S, 'N5 slingshot: press twice, pull left and hold still, let go — she flies right', async () => {
      await settle();
      await toFloor(200);
      const box = await page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.up(); // first press (a pat)
      await page.mouse.down(); // second press within 300 ms: the slingshot
      await page.mouse.move(cx - 70, cy + 10, { steps: 6 });
      await page.waitForTimeout(400); // held still: a plain drag would just be put down
      const pulled = await mainBounds();
      await page.mouse.up();
      await page.waitForFunction(() => window.petFx.state().flying, null, { timeout: 2000 });
      await page.screenshot({ path: path.join(OUT, `${S}-slingshot.png`) });
      await waitLanded();
      const after = await mainBounds();
      assert.ok(after.x > pulled.x + 50, `launched right: ${pulled.x} → ${after.x}`);
      return `pulled to x=${pulled.x}, launched opposite → landed x=${after.x}`;
    }, page);
    await step(S, 'N6 catch her while she flies: a score pops up', async () => {
      await toFloor(380);
      const flying = page.evaluate(() => window.petFx.throw(-900, -1500));
      await page.waitForFunction(() => window.petFx.state().flying, null, { timeout: 2000 });
      await page.waitForTimeout(120);
      await page.locator('#pet-body .pet-hit:not(.hidden)').dispatchEvent('pointerdown', { button: 0, pointerId: 3, pointerType: 'mouse', isPrimary: true });
      await page.waitForSelector('.score-pop', { timeout: 2000 });
      const txt = await page.textContent('.score-pop');
      await page.screenshot({ path: path.join(OUT, `${S}-score.png`) });
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, pointerType: 'mouse' })));
      await flying;
      const stt = await page.evaluate(() => window.petFx.stats());
      assert.ok(stt.lastScore > 0);
      return `caught mid-air: "${txt}" (${stt.lastScore} points), sparks`;
    }, page);
    await step(S, 'N7 a hard landing squashes her flatter', async () => {
      await toFloor(300);
      await page.evaluate(() => window.petFx.throw(0, -1800));
      await waitLanded();
      const stt = await page.evaluate(() => window.petFx.stats());
      const sq = await page.evaluate(() => document.getElementById('pet-body').style.getPropertyValue('--sq'));
      assert.ok(stt.lastSquash < 0.8, `squash ${stt.lastSquash}`);
      return `landing squash scaleY ${stt.lastSquash} (CSS --sq ${sq})`;
    });
    // the settings window (⋯ → 设置…): its switches save on click with a toast "已保存：<label> → <value>"
    const adminToast = (admin, re) => admin.waitForFunction((src) => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
    const switchState = (admin, key) => admin.getAttribute(`[data-key="${key}"]`, 'aria-checked');
    await step(S, 'N8 settings window: 桌宠行为 / 朗读 switches (roam on, sound / voice off, 互动语音 on, 朗读碎碎念 off, memes and collisions on by default)', async () => {
      const admin = await openAdminWindow(app, page, 'behavior');
      const shown = [];
      for (const k of ['roam', 'clickSound', 'memes', 'collide', 'touchZones', 'touchHint']) shown.push(`${k}=${(await switchState(admin, `prefs.${k}`)) === 'true' ? 'on' : 'off'}`);
      assert.deepEqual(shown, ['roam=on', 'clickSound=off', 'memes=on', 'collide=on', 'touchZones=on', 'touchHint=on']);
      const p0 = (await page.evaluate(() => window.pet.getSettings())).prefs;
      const prefs = ['roam', 'clickSound', 'voice', 'voiceInteractions', 'voiceMurmurs', 'memes', 'collide', 'touchZones', 'touchHint'].map((k) => `${k}=${p0[k] ? 'on' : 'off'}`);
      assert.deepEqual(prefs, ['roam=on', 'clickSound=off', 'voice=off', 'voiceInteractions=on', 'voiceMurmurs=off', 'memes=on', 'collide=on', 'touchZones=on', 'touchHint=on']);
      await admin.screenshot({ path: path.join(OUT, `${S}-behavior-settings.png`) });
      await admin.click('[data-key="prefs.clickSound"]');
      await adminToast(admin, /已保存：点击音效 → 开/);
      await admin.evaluate(() => { location.hash = '/tts'; });
      await admin.waitForSelector('[data-path="/tts"] [data-key="prefs.voice"]');
      assert.equal(await switchState(admin, 'prefs.voice'), 'false');
      await admin.click('[data-key="prefs.voice"]');
      await adminToast(admin, /已保存：朗读回复 → 开/);
      // 互动语音 / 朗读碎碎念 unfold under the master switch, with their defaults
      assert.deepEqual([await switchState(admin, 'prefs.voiceInteractions'), await switchState(admin, 'prefs.voiceMurmurs')], ['true', 'false']);
      await admin.screenshot({ path: path.join(OUT, `${S}-voice-settings.png`) });
      const p1 = (await page.evaluate(() => window.pet.getSettings())).prefs;
      assert.deepEqual([p1.clickSound, p1.voice], [true, true], 'the pet window has them');
      await admin.close();
      return prefs.join(', ') + ' → switched on: click sound, voice';
    }, page);
    await step(S, 'N9 click sound when she is clicked (setting on)', async () => {
      await settle();
      const before = (await page.evaluate(() => window.petFx.stats())).sounds;
      await hover(page);
      await clickHead(page);
      await page.waitForFunction((b) => window.petFx.stats().sounds > b, before, { timeout: 3000 });
      return `pop played (${before} → ${(await page.evaluate(() => window.petFx.stats())).sounds})`;
    });
    const meme = SPECIES_MEMES[ch.id];
    await step(S, 'N10 memes: a reply tagged with one of her memes shows the picture in the bubble', async () => {
      await page.waitForTimeout(3200);
      await idle();
      await clickAct(page, 'chat');
      await page.fill('#chat-input', `看这个 [梗图:${meme}]`);
      await page.press('#chat-input', 'Enter');
      await leave();
      await page.waitForSelector(`#bubble[data-meme="${meme}"]`, { timeout: 15000 });
      await page.waitForFunction(() => { const i = document.getElementById('meme-sticker'); return !i.classList.contains('hidden') && i.complete && i.naturalWidth > 0; });
      const text = await bubbleText(page);
      assert.doesNotMatch(text, /梗图/);
      await page.screenshot({ path: path.join(OUT, `${S}-meme.png`) });
      return `bubble "${text.trim()}" + sticker ${await page.getAttribute('#meme-sticker', 'src')}`;
    }, page);
    await step(S, 'N11 voice: her reply is read aloud with her own pitch and pace', async () => {
      const sp = await page.evaluate(() => window.petFx.lastSpeech());
      assert.ok(sp, 'an utterance was queued');
      assert.equal(sp.species, ch.id);
      assert.equal(sp.text, 'echo: 看这个');
      return `speechSynthesis.speak("${sp.text}") lang ${sp.lang}, pitch ${sp.pitch}, rate ${sp.rate}; system voices here: ${sp.systemVoices} (${sp.voice || 'none — this Linux box has no speech engine'}), status ${sp.status}`;
    });
    const guest = ROSTER[(ch.idx + 1) % ROSTER.length];
    let guestPage = null;
    // a knocked pet can knock the other one back: wait until both are on the ground
    const still = async () => {
      for (const pg of [page, guestPage]) if (pg && !pg.isClosed()) await pg.waitForFunction(() => !window.petFx.state().flying, null, { timeout: 20000 });
      await page.waitForTimeout(300);
    };
    await step(S, `N12 同屏伙伴: ${guest.zh} visits in her own window`, async () => {
      await idle();
      const admin = await openAdminWindow(app, page, 'visitors');
      // the multi Select (its data-key does not reach the DOM: the page's only combobox); the current character is not offered
      await admin.locator('[data-path="/visitors"] [role="combobox"]').click();
      const offered = (await admin.getByRole('option').allTextContents()).map((t) => t.trim());
      assert.ok(!offered.some((t) => t.startsWith(ch.zh)), `not ${ch.zh} herself: ${offered.join(', ')}`);
      const opened = app.waitForEvent('window', { timeout: 10000 });
      await admin.getByRole('option', { name: `${guest.zh}（${guest.vendor}）` }).click();
      guestPage = await opened;
      await adminToast(admin, new RegExp(`同屏伙伴：${guest.zh}`));
      await admin.keyboard.press('Escape');
      await guestPage.waitForFunction(() => window.petFx && window.petFx.state() && window.petFx.state().species, null, { timeout: 10000 });
      const gs = await guestPage.evaluate(() => window.petFx.state());
      assert.equal(gs.species, guest.id);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).visitors, [guest.id]);
      await admin.screenshot({ path: path.join(OUT, `${S}-visitor-settings.png`) });
      await admin.close();
      await guestPage.waitForTimeout(600);
      await guestPage.screenshot({ path: path.join(OUT, `${S}-visitor-${guest.id}.png`) });
      return `visitor window ${guestPage.url().split('?')[1]} shows ${gs.species} (${gs.state})`;
    }, page);
    await step(S, `N13 knock into ${guest.zh}: the thrown pet hits her and she flies off`, async () => {
      await settle();
      const gb = await app.evaluate(({ BrowserWindow, screen }) => { const v = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('visitor=')); const wa = screen.getDisplayMatching(v.getBounds()).workArea; v.setPosition(wa.x + 20, wa.y + wa.height - v.getBounds().height); return v.getBounds(); });
      await page.waitForTimeout(1300); // the visitor reports where she is
      await toFloor(gb.x + gb.width + 60);
      const res = await page.evaluate(() => window.petFx.throw(-1700, -150));
      const gstats = await guestPage.evaluate(() => window.petFx.stats());
      await guestPage.waitForFunction(() => !window.petFx.state().flying, null, { timeout: 15000 });
      const ga = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('visitor=')).getBounds());
      await guestPage.screenshot({ path: path.join(OUT, `${S}-visitor-after-hit.png`) });
      assert.ok(res.collisions >= 1, JSON.stringify(res));
      assert.ok(gstats.kicked >= 1, 'the visitor was kicked');
      return `${res.collisions} collision(s), hits ${[...new Set(res.hits)].join(', ')}; ${guest.id} window ${gb.x},${gb.y} → ${ga.x},${ga.y}`;
    }, page);
    await step(S, 'N14 local HTTP API: switched on in the settings window (对外接口), then driven with curl-like calls', async () => {
      await still();
      const admin = await openAdminWindow(app, page, 'api');
      await admin.fill('[data-key="api.port"] input', String(17400 + ch.idx));
      await admin.click('[data-save="api.port"]');
      await adminToast(admin, new RegExp(`已保存：端口 → ${17400 + ch.idx}`));
      await admin.click('[data-key="api.enabled"]');
      await adminToast(admin, /已保存：开启对外接口 → 开/);
      await admin.getByText(`监听中 127.0.0.1:${17400 + ch.idx}`).waitFor({ timeout: 5000 });
      await admin.screenshot({ path: path.join(OUT, `${S}-api-settings.png`) });
      await admin.close();
      const st = await view(page);
      const token = st.settings.api.token;
      const port = st.settings.api.port;
      const call = async (method, p, body, tok = token) => {
        const r = await fetch(`http://127.0.0.1:${port}/pixel-pet${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json() };
      };
      assert.equal(port, 17400 + ch.idx);
      const lines = [];
      const no = await call('GET', '/state', null, 'wrong-token');
      assert.equal(no.status, 401);
      lines.push(`GET /state (bad token) → ${no.status}`);
      const s1 = await call('GET', '/state');
      assert.equal(s1.json.pet.species, ch.id);
      lines.push(`GET /state → ${s1.status} ${s1.json.pet.species} ${s1.json.fx.state}`);
      const sy = await call('POST', '/say', { text: `来自脚本的问候（${ch.zh}）` });
      await page.waitForFunction((t) => document.getElementById('bubble').textContent.includes(t), `来自脚本的问候`, { timeout: 5000 });
      lines.push(`POST /say → ${sy.status}`);
      await still();
      const an = await call('POST', '/anim', { state: 'happy' });
      assert.equal(an.status, 200, JSON.stringify(an.json));
      await page.waitForFunction(() => window.petFx.state().state === 'happy', null, { timeout: 3000 });
      lines.push(`POST /anim happy → ${an.status}`);
      await page.screenshot({ path: path.join(OUT, `${S}-api-say.png`) });
      const th = await call('POST', '/throw', { angle: 60, power: 1 });
      assert.equal(th.status, 200);
      await still();
      lines.push(`POST /throw → ${th.status} ${th.json.bounces} bounces`);
      fs.writeFileSync(path.join(OUT, `${S}-api.txt`), lines.join('\n') + '\n');
      return lines.join('; ');
    }, page);
    await step(S, 'E14 switch character from ⋯ → 角色列表: a new one gets her own agent and starts as a stranger', async () => {
      if (await page.isVisible('#panel-close')) await page.click('#panel-close');
      await still();
      const next = ROSTER[(ch.idx + 1) % ROSTER.length];
      const before = await view(page);
      await clickAct(page, 'menu');
      await page.click('[data-menu="characters"]');
      await page.waitForSelector(`.char-opt[data-species="${next.id}"] .pick`);
      await pickCharacter(page, next.id);
      await page.screenshot({ path: path.join(OUT, `${S}-switch-panel.png`) });
      await page.click('#panel-close');
      const after = await view(page);
      assert.equal(after.pet.speciesId, next.id);
      assert.notEqual(after.pet.agentId, before.pet.agentId, 'her own agent');
      assert.equal(after.characters.find((c) => c.id === ch.id).met.affection, before.pet.affection, 'the first one keeps her affection');
      await page.waitForFunction(() => window.petFx.state().state === 'hatch', null, { timeout: 4000 });
      return `${ch.id} → ${next.id}; new agent ${after.pet.agentId} ♥${after.pet.affection}; ${ch.id} keeps ♥${before.pet.affection}`;
    }, page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ----------------------------------------------------------------- touch
// Touching body parts: real mouse clicks on her art (sprite and Dafeiyu's clip, facing either way) are
// mapped to a part, each with its own reaction class, marks and line; dragging is not a touch; the
// 部位触摸 switch brings the old single pat back. Then the IPC (window.pet.touch): every zone,
// stage-dependent reactions on the chest, the streak, every character's lines, and the old pat.
async function touch() {
  const S = 'touch';
  const SHOTS = path.join(OUT, 'touch');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-touch-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-touchfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video') });
  const shot = async (name) => { await page.waitForTimeout(200); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  // a forced stage-up shows its card over the bubble; close it before looking at the reaction
  const dismissToast = () => page.evaluate(() => { const t = document.getElementById('unlock-toast'); if (t && !t.classList.contains('hidden')) document.getElementById('toast-close').click(); });
  const touchAndShow = async (target) => {
    const r = await page.evaluate((t) => window.pet.touch(t), target);
    if (r.ok) await page.waitForFunction((l) => document.getElementById('bubble').textContent.includes(l), r.line, { timeout: 5000 });
    return r;
  };
  const fmt = (r) => `${r.zone}:${r.reaction.mood}${r.reaction.streak ? '/' + r.reaction.streak : ''} Δ${r.affection.delta} ♥${r.affection.value} 「${r.line}」`;
  const log = [];
  try {
    await step(S, 'hatch 克洛蒂 (Claude) with the fake lh', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="claude"]');
      await page.fill('#pet-name', 'Touchy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      assert.equal(await page.evaluate(() => typeof window.pet.touch), 'function');
      await page.evaluate(() => window.pet.debugSet({ mood: 50, hunger: 20, energy: 90, sleeping: false }));
    }, page);

    // what each part shows: the reaction class on #pet-body and a mark drawn over her (fx.js TOUCH_MARKS)
    const MARK = { head: 'pat-hand', chest: 'blush', butt: 'anger', feet: 'tickle', hands: 'shake-hand', tail: 'giggle' };
    const settle = async () => {
      await page.waitForFunction(() => !document.getElementById('pet-body').classList.contains('touched'), null, { timeout: 6000 });
      await page.waitForTimeout(300);
    };
    // Click `zone` with the real mouse; assert the part main resolved, the line in the bubble, the reaction.
    // `pts` null: find the spot right before the click (a clip keeps moving)
    const clickZone = async (zone, pts, name) => {
      let seen = pts;
      for (let i = 0; !pts && i < 20 && !(seen && seen[zone]); i++) { if (i) await page.waitForTimeout(250); seen = await zonePoints(page); }
      const p = seen[zone];
      assert.ok(p, `no click point for ${zone}: ${Object.keys(seen).join(',')}`);
      const before = await page.evaluate(() => window.petFx.lastTouch());
      await page.mouse.move(p.x, p.y);
      await page.mouse.click(p.x, p.y);
      await page.waitForFunction((n) => { const t = window.petFx.lastTouch(); return t && t.n > n; }, before ? before.n : 0, { timeout: 5000 }).catch(() => {});
      const t = await page.evaluate(() => window.petFx.lastTouch());
      assert.ok(t && t.n > (before ? before.n : 0), `a touch was shown for the click on ${zone}`);
      assert.equal(t.zone, zone, `clicked (${p.x}, ${p.y}) for ${zone}, got ${t.zone}`);
      await page.waitForFunction((z) => document.getElementById('bubble').dataset.kind === `touch:${z}`, zone, { timeout: 5000 });
      const ui = await page.evaluate(() => {
        const b = document.getElementById('pet-body');
        return { cls: [...b.classList].filter((c) => c.startsWith('touch')).join(' '), marks: [...document.querySelectorAll('#touch-fx .tmark')].map((m) => m.className.replace('tmark ', '')), bubble: document.getElementById('bubble').textContent, kind: document.getElementById('bubble').dataset.kind };
      });
      assert.equal(ui.bubble, t.line, 'the touch line is in the bubble');
      assert.ok(ui.cls.split(' ').includes(`touch-${zone}`), `reaction class: ${ui.cls}`);
      assert.ok(ui.cls.split(' ').includes(`touch-mood-${t.mood}`), `mood class: ${ui.cls}`);
      if (MARK[zone]) assert.ok(ui.marks.some((m) => m.split(' ').includes(MARK[zone])), `mark ${MARK[zone]} in ${ui.marks}`);
      await page.waitForTimeout(450); // mid-reaction
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
      // the DOM at that moment: the reaction classes, the marks layer and the bubble
      const dom = await page.evaluate(() => {
        const b = document.getElementById('pet-body');
        const bub = document.getElementById('bubble');
        return { petBody: { className: b.className, dataset: { ...b.dataset } }, touchFx: document.getElementById('touch-fx').outerHTML, bubble: { text: bub.textContent, dataset: { ...bub.dataset }, hidden: bub.classList.contains('hidden') }, lastTouch: window.petFx.lastTouch() };
      });
      fs.writeFileSync(path.join(SHOTS, `${name}.dom.json`), JSON.stringify({ click: p, ...dom }, null, 2) + '\n');
      log.push(`click ${name} @(${p.x},${p.y}) → zone=${t.zone} mood=${t.mood} clip=${t.clip} class="${ui.cls}" marks=[${ui.marks.join(', ')}] bubble=${ui.kind} 「${t.line}」`);
      return `(${p.x},${p.y}) → ${t.zone}, ${ui.cls}, [${ui.marks.join(', ')}] 「${t.line}」 → ${name}.png`;
    };

    let pts = null;
    await step(S, 'click points: each of the five parts maps to a spot on her art, top to bottom', async () => {
      await page.waitForTimeout(500);
      pts = await zonePoints(page);
      for (const z of ['head', 'chest', 'hands', 'butt', 'feet']) assert.ok(pts[z], `${z} reachable`);
      assert.ok(pts.head.y < pts.chest.y && pts.chest.y < pts.butt.y && pts.butt.y < pts.feet.y, JSON.stringify(pts));
      return Object.entries(pts).map(([z, p]) => `${z}(${p.x},${p.y})`).join(' ');
    }, page);

    for (const zone of ['head', 'chest', 'butt', 'feet', 'hands']) {
      await step(S, `real click on her ${zone}: that part's line, reaction class and marks`, async () => {
        await settle();
        return clickZone(zone, pts, `click-${zone}`);
      }, page);
    }

    await step(S, 'hovering names the part under the pointer (触摸提示)', async () => {
      await settle();
      await page.mouse.move(pts.head.x + 1, pts.head.y);
      await page.mouse.move(pts.head.x, pts.head.y);
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.hoverZone === 'head' && !document.getElementById('zone-hint').classList.contains('hidden'), null, { timeout: 3000 });
      const hint = await page.textContent('#zone-hint');
      assert.match(hint, /头/);
      const cursor = await page.evaluate(() => getComputedStyle(document.querySelector('#pet-body .pet-hit:not(.hidden)')).cursor);
      assert.equal(cursor, 'pointer');
      await page.mouse.move(pts.feet.x, pts.feet.y + 1);
      await page.mouse.move(pts.feet.x, pts.feet.y);
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.hoverZone === 'feet', null, { timeout: 3000 });
      await page.screenshot({ path: path.join(SHOTS, 'hover-hint.png') });
      return `head → "${hint}", cursor ${cursor}; feet → "${await page.textContent('#zone-hint')}"`;
    }, page);

    await step(S, 'facing left (mirrored) the same parts are still hit', async () => {
      await page.evaluate(() => window.petFx.face('left'));
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.facing === 'left', null, { timeout: 3000 });
      await settle();
      const m = await zonePoints(page);
      const r = await clickZone('hands', m, 'mirrored-hands');
      await page.evaluate(() => window.petFx.face('right'));
      return `mirrored: ${Object.entries(m).map(([z, p]) => `${z}(${p.x},${p.y})`).join(' ')}; ${r}`;
    }, page);

    await step(S, 'dragging her by the chest is a drag, not a touch', async () => {
      await settle();
      await page.waitForTimeout(400); // not a double press (slingshot)
      const before = await page.evaluate(() => window.petFx.lastTouch());
      await page.mouse.move(pts.chest.x, pts.chest.y);
      await page.mouse.down();
      await page.mouse.move(pts.chest.x + 20, pts.chest.y + 6, { steps: 5 });
      await page.waitForFunction(() => window.petFx.state().state === 'lifted', null, { timeout: 3000 });
      await page.mouse.up();
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => window.petFx.lastTouch());
      assert.deepEqual(after, before, 'no touch on a drag');
      assert.equal(await page.evaluate(() => document.getElementById('pet-body').classList.contains('touched')), false);
      return 'lifted while dragged, no touch reaction';
    }, page);

    await step(S, 'settings window → 桌宠行为 → 部位触摸 off — a click is the old single pat again', async () => {
      await settle();
      await page.waitForTimeout(400);
      const admin = await openAdminWindow(app, page, 'behavior');
      const sw = admin.locator('[data-key="prefs.touchZones"]');
      await sw.scrollIntoViewIfNeeded();
      assert.equal(await sw.getAttribute('aria-checked'), 'true', 'on by default');
      assert.equal(await admin.locator('[data-key="prefs.touchHint"]').count(), 1, '触摸提示 shown under it');
      await admin.screenshot({ path: path.join(SHOTS, 'settings-touch-switch.png') });
      await sw.click();
      await admin.waitForFunction(() => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && /已保存：部位触摸 → 关/.test(el.textContent || '')), null, { timeout: 8000 });
      assert.equal(await sw.getAttribute('aria-checked'), 'false');
      await admin.waitForSelector('[data-key="prefs.touchHint"]', { state: 'detached' }); // 触摸提示 folds away with it
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).prefs;
      assert.equal(saved.touchZones, false, 'saved to settings.json');
      assert.equal(await page.evaluate(async () => (await window.pet.getSettings()).prefs.touchZones), false, 'the pet window has it');
      log.push(`settings.json prefs after switching off: ${JSON.stringify(saved)}`);
      await admin.screenshot({ path: path.join(SHOTS, 'settings-touch-switch-off.png') });
      await admin.close();
      await page.bringToFront();
      await page.waitForTimeout(800);
      const before = await page.evaluate(() => window.petFx.lastTouch());
      await page.mouse.click(pts.chest.x, pts.chest.y);
      await page.waitForFunction(() => document.getElementById('bubble').dataset.kind === 'pat', null, { timeout: 5000 });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.getElementById('pet-body').dataset.hoverZone || ''), '', 'no hint while off');
      assert.deepEqual(await page.evaluate(() => window.petFx.lastTouch()), before, 'no touch');
      assert.equal(await page.evaluate(() => document.getElementById('pet-body').classList.contains('touched')), false);
      const cue = (await page.evaluate(() => window.petFx.state())).lastCue;
      await page.screenshot({ path: path.join(SHOTS, 'touch-off-pat.png') });
      await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
      await page.waitForTimeout(300);
      fs.writeFileSync(path.join(SHOTS, 'touch-off-pat.dom.json'), JSON.stringify({ settingsJsonPrefs: saved, petBody: await page.evaluate(() => document.getElementById('pet-body').className), bubble: await page.evaluate(() => ({ text: document.getElementById('bubble').textContent, ...document.getElementById('bubble').dataset })), lastTouchUnchanged: before }, null, 2) + '\n');
      return `off: settings.json touchZones=${saved.touchZones}; a click on the chest is a pat (bubble kind "pat", cue "${cue}"), no part reaction; switched back on`;
    }, page);

    await step(S, "Dafeiyu's clip (video art): the five parts and her tail, facing either way", async () => {
      // her original clips are a character of her own, 「大肥鱼 · 原版动画」 (T-2764: id = the old look's id)
      const sw = await page.evaluate(() => window.pet.switchCharacter('dafeiyu-clips'));
      assert.equal(sw.ok, true, JSON.stringify(sw).slice(0, 200));
      assert.equal((await view(page)).pet.characterId, 'dafeiyu-clips');
      await page.waitForTimeout(1500);
      await dismissToast();
      await page.waitForFunction(() => window.petFx.state().video && document.getElementById('pet-video').videoWidth > 0, null, { timeout: 8000 });
      await page.waitForTimeout(8200); // the streak window
      await page.evaluate(() => window.petFx.cue('idle'));
      await page.waitForTimeout(1500);
      const v = await zonePoints(page);
      const out = [];
      for (const zone of ['head', 'chest', 'butt', 'feet', 'hands', 'tail']) {
        await settle();
        out.push(await clickZone(zone, null, `video-${zone}`));
      }
      const tailRight = v.tail.x;
      await page.evaluate(() => window.petFx.face('left'));
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.facing === 'left', null, { timeout: 3000 });
      await page.waitForTimeout(300);
      const vl = await zonePoints(page);
      assert.ok(vl.tail && vl.tail.x < tailRight, `mirrored tail moves to the other side: ${tailRight} → ${vl.tail && vl.tail.x}`);
      await settle();
      out.push(await clickZone('tail', null, 'video-mirrored-tail'));
      await page.evaluate(() => window.petFx.face('right'));
      await page.evaluate(() => window.pet.switchCharacter('claude'));
      await page.waitForTimeout(1500);
      await dismissToast();
      return out.join(' | ');
    }, page);

    for (const zone of ['head', 'chest', 'butt', 'feet', 'hands', 'face', 'belly', 'legs']) {
      await step(S, `stranger touches ${zone}`, async () => {
        const r = await touchAndShow(zone);
        assert.equal(r.ok, true);
        assert.equal(r.zone, zone);
        assert.equal(r.reaction.anim, `touch-${zone}`);
        if (zone === 'chest' || zone === 'butt') { assert.equal(r.reaction.mood, 'angry'); assert.ok(r.affection.delta <= 0); }
        log.push(fmt(r));
        await shot(`stranger-${zone}`);
        await page.waitForTimeout(8200); // let the streak window lapse between parts
        return fmt(r);
      }, page);
    }

    await step(S, 'a click point in the visible box is resolved to a zone; a miss returns null', async () => {
      const pts = [[0.5, 0.03], [0.5, 0.26], [0.5, 0.41], [0.5, 0.53], [0.5, 0.94]];
      const zones = [];
      for (const [x, y] of pts) { zones.push((await touchAndShow({ x, y })).zone); await page.waitForTimeout(8200); }
      assert.deepEqual(zones, ['head', 'chest', 'hands', 'butt', 'feet']);
      const miss = await page.evaluate(() => window.pet.touch({ x: 0.02, y: 0.02 }));
      assert.deepEqual(miss, { ok: false, reason: 'miss', zone: null });
      return `points → ${zones.join(', ')}; (0.02,0.02) → ${JSON.stringify(miss)}`;
    }, page);

    await step(S, 'poking the head repeatedly escalates to annoyed (3rd) and angry (6th)', async () => {
      await page.evaluate(() => window.pet.debugSet({ affection: 20, mood: 50 }));
      await page.waitForTimeout(1500);
      await dismissToast();
      const seq = [];
      for (let i = 0; i < 6; i++) { const r = await touchAndShow('head'); seq.push(fmt(r)); if (i === 2) await shot('streak-annoyed'); }
      assert.match(seq[2], /annoyed\/annoyed/);
      assert.match(seq[5], /angry\/angry Δ-1/);
      log.push(...seq);
      await shot('streak-angry');
      return seq.join(' | ');
    }, page);

    await step(S, 'close friends: chest touch is flustered, no penalty', async () => {
      await page.waitForTimeout(8200);
      await page.evaluate(() => window.pet.debugSet({ affection: 40, mood: 50 }));
      await page.waitForTimeout(1500);
      await dismissToast();
      const r = await touchAndShow('chest');
      assert.equal(r.reaction.mood, 'shy');
      assert.equal(r.affection.delta, 0);
      log.push(fmt(r));
      await shot('close-chest');
      return fmt(r);
    }, page);

    await step(S, 'top stage: chest touch is shy and slightly positive', async () => {
      await page.waitForTimeout(8200);
      await page.evaluate(() => window.pet.debugSet({ affection: 90, mood: 50 }));
      await page.waitForTimeout(1500);
      await dismissToast();
      const r = await touchAndShow('chest');
      assert.equal(r.reaction.mood, 'shy');
      assert.equal(r.reaction.tier, 'high');
      assert.ok(r.affection.delta > 0);
      log.push(fmt(r));
      await shot('high-chest');
      return fmt(r);
    }, page);

    await step(S, 'every character answers each of the five parts in her own words', async () => {
      const out = [];
      for (const id of ['gemini', 'gpt', 'grok', 'dafeiyu', 'claude']) {
        await page.evaluate((c) => window.pet.switchCharacter(c), id);
        await page.waitForTimeout(1500);
        await dismissToast();
        for (const zone of ['head', 'chest', 'butt', 'feet', 'hands']) {
          const r = await touchAndShow(zone);
          assert.equal(r.ok, true);
          out.push(`${id}.${zone}: ${r.line}`);
        }
        await shot(`char-${id}`);
        await page.waitForTimeout(8200);
      }
      log.push(...out);
      return `${out.length} lines`;
    }, page);

    await step(S, 'the old click (pat) still works', async () => {
      const before = (await view(page)).pet.affection;
      const r = await page.evaluate(() => window.pet.act('pat'));
      assert.equal(r.ok, true);
      assert.equal(r.affection.source, 'pat');
      return `pat ok, ♥${before} → ${(await view(page)).pet.affection}`;
    }, page);

    await step(S, 'parts are found on the 旧版像素 pack too (83×113, drawn as blocks): head and feet', async () => {
      await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
      // 「Claude · 旧版像素」 is a character of her own (T-2764), chosen in 设置 → 角色图鉴 → 切换; the same switch-character channel
      const sw = await page.evaluate(() => window.pet.switchCharacter('claude-classic'));
      assert.equal(sw.ok, true, JSON.stringify(sw).slice(0, 200));
      assert.equal((await view(page)).pet.characterId, 'claude-classic');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'claude-classic/daily', null, { timeout: 5000 });
      await page.evaluate(() => window.pet.debugSet({ affection: 90, mood: 60, sleeping: false }));
      await settle();
      const got = [];
      for (const zone of ['head', 'feet']) {
        let pts = null;
        for (let i = 0; i < 20 && !(pts && pts[zone]); i++) { if (i) await page.waitForTimeout(250); pts = await zonePoints(page); }
        const p = pts[zone];
        assert.ok(p, `no ${zone} point on the 旧版像素 sprite`);
        const before = await page.evaluate(() => window.petFx.lastTouch());
        await page.mouse.move(p.x, p.y);
        await page.mouse.click(p.x, p.y);
        await page.waitForFunction((n) => { const t = window.petFx.lastTouch(); return t && t.n > n; }, before ? before.n : 0, { timeout: 5000 });
        const t = await page.evaluate(() => window.petFx.lastTouch());
        assert.equal(t.zone, zone, `clicked (${p.x}, ${p.y}) on the 旧版像素 sprite for ${zone}, got ${t.zone}`);
        got.push(`${zone} @(${p.x}, ${p.y}) → ${t.zone}「${t.line}」`);
        await shot(`classic-${zone}`);
        await settle();
      }
      return got.join('; ');
    }, page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'touch-log.txt'), log.join('\n') + '\n');
    await app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- voice
// 语音 engines (core/tts.js) against a local stand-in for Fish Audio, MiniMax and ElevenLabs (no real key, no cost):
// engine choice, the cache, one line at a time, and every fallback (HTTP error, pause, timeout, no key,
// offline, silent), configured through 高级设置 → 语音 like a user would.
function ttsMock() {
  const http = require('node:http');
  const KEY = 'e2e-fake-fish-key-7f3a9c';
  const MM_KEY = 'e2e-fake-minimax-key-41b2';
  const EL_KEY = 'e2e-fake-elevenlabs-key-9d0e';
  // a 440 Hz tone: a real WAV the page can decode and play (0.5 s, or `perCharMs` per character of the line)
  const tone = (sec) => {
    const rate = 8000;
    const n = Math.round(rate * sec);
    const w = Buffer.alloc(44 + n * 2);
    w.write('RIFF', 0); w.writeUInt32LE(36 + n * 2, 4); w.write('WAVEfmt ', 8); w.writeUInt32LE(16, 16); w.writeUInt16LE(1, 20); w.writeUInt16LE(1, 22);
    w.writeUInt32LE(rate, 24); w.writeUInt32LE(rate * 2, 28); w.writeUInt16LE(2, 32); w.writeUInt16LE(16, 34); w.write('data', 36); w.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) w.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), 44 + i * 2);
    return w;
  };
  const wav = tone(0.5);
  const m = { KEY, MM_KEY, EL_KEY, wav, mode: 'ok', slow: {}, perCharMs: 0, log: [] };
  m.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch { /* ignore */ }
      const fish = req.url === '/v1/tts';
      // a local voice server (本地语音服务): the OpenAI speech API or whale-voice's /tts; no key
      const local = req.url === '/v1/audio/speech' || req.url === '/tts';
      // ElevenLabs: POST /v1/text-to-speech/{voice_id}?output_format=… with the key in xi-api-key
      const el = req.url.startsWith('/v1/text-to-speech/');
      const auth = local || (el ? req.headers['xi-api-key'] === EL_KEY : req.headers.authorization === `Bearer ${fish ? KEY : MM_KEY}`);
      const rec = el
        ? { at: Date.now(), method: req.method, path: req.url.split('?')[0], query: req.url.split('?')[1] || '', auth, xiKey: req.headers['xi-api-key'] || '(none)', bearer: !!req.headers.authorization, accept: req.headers.accept, model: j.model_id, voice: decodeURIComponent(req.url.split('?')[0].slice('/v1/text-to-speech/'.length)), text: j.text, prosody: j.voice_settings, body: j, mode: m.mode, aborted: false, status: 0 }
        : local
        ? { at: Date.now(), path: req.url, auth, model: j.model, voice: j.voice, emo: j.emo, text: j.input || j.text, body: j, mode: m.mode, aborted: false, status: 0 }
        : { at: Date.now(), path: req.url, auth, model: fish ? req.headers.model : j.model, voice: fish ? j.reference_id : j.voice_setting && j.voice_setting.voice_id, text: j.text, prosody: j.prosody || j.voice_setting, mode: m.mode, aborted: false, status: 0 };
      m.log.push(rec);
      // the client gave up: the response closed before it was sent (the request's own `close` fires once its body is read)
      res.on('close', () => { if (!res.writableFinished) rec.aborted = true; });
      const send = () => {
        if (res.destroyed) return;
        if (!auth) { rec.status = 401; return res.writeHead(401).end('{"message":"unauthorized"}'); }
        if (m.mode === '500') { rec.status = 500; return res.writeHead(500).end('{"message":"boom"}'); }
        if (m.mode === 'notaudio' && local) { rec.status = 200; return res.writeHead(200, { 'content-type': 'application/json' }).end('{"error":"model not ready"}'); }
        rec.status = 200;
        const audio = m.perCharMs ? tone(Math.min(6, Math.max(0.4, ([...(j.text || '')].length * m.perCharMs) / 1000))) : wav;
        rec.audioMs = Math.round(((audio.length - 44) / 2 / 8000) * 1000);
        if (fish || local || el) return res.writeHead(200, { 'content-type': 'audio/wav' }).end(audio);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' }, data: { audio: audio.toString('hex') } }));
      };
      if (m.mode === 'hang') return setTimeout(send, 8000);
      setTimeout(send, m.slow[j.text] || 30);
    });
  });
  return new Promise((resolve) => m.server.listen(0, '127.0.0.1', () => { m.url = `http://127.0.0.1:${m.server.address().port}`; resolve(m); }));
}

// 互动语音 synthesises her common lines ahead (petFx.lastPrewarm) once an engine has a key: wait for it
// to settle before counting engine requests.
async function prewarmed(page) {
  const settled = () => page.waitForFunction(() => { const p = window.petFx.lastPrewarm && window.petFx.lastPrewarm(); return !p || p.status === 'done'; }, null, { timeout: 30000 });
  await settled();
  await page.waitForTimeout(800); // a prewarm is scheduled 400 ms after what it depends on changes
  await settled();
}

async function voice() {
  const S = 'voice';
  const SHOTS = path.join(OUT, 'voice');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await ttsMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-voice-'));
  // 语音包 (V15): a pack the owner added for 克洛蒂 with one recorded line (a tone), loaded at start
  const PACK_LINE = '这一句是录好的。';
  const packDir = path.join(data, 'voicepacks', 'test-claude');
  fs.mkdirSync(packDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'voicepack', 'tone.mp3'), path.join(packDir, 'tone.mp3'));
  fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify({ format: 1, id: 'test-claude', name: '测试录音', character: 'claude', engine: 'minimax', lines: { [PACK_LINE]: 'tone.mp3' } }));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-voicefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video') });
  const shot = async (name) => { await page.waitForTimeout(200); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const evidence = [];
  const note = (s) => { evidence.push(s); return s; };
  const reqs = () => mock.log.length;
  const last = () => page.evaluate(() => window.petFx.lastSpeech());
  // speak a line through the same path as a reply, wait until it has an outcome
  let spoken = 0;
  const speakLine = async (text, timeout = 15000) => {
    await page.evaluate((t) => { window.petFx.speak(t); }, text);
    const t0 = Date.now();
    for (;;) {
      const sp = await last();
      if (sp && sp.n > spoken && sp.text === text && !/^(queued|synthesizing)$/.test(sp.status)) { spoken = sp.n; return sp; }
      if (Date.now() - t0 > timeout) throw new Error(`no outcome for 「${text}」: ${JSON.stringify(sp)}`);
      await page.waitForTimeout(50);
    }
  };
  const fmt = (sp) => `「${sp.text}」 engine=${sp.engine} → provider=${sp.provider}${sp.voiceId ? ` voice=${sp.voiceId}` : ''} cached=${sp.cached} ${sp.latencyMs}ms status=${sp.status}${sp.fellBackFrom.length ? ` fellBackFrom=${sp.fellBackFrom.map((f) => `${f.provider}:${f.reason}`).join(',')}` : ''}`;
  const ttsSet = () => page.evaluate(async () => (await window.pet.getSettings()));
  // 设置窗口 → 朗读 (#/tts): opened the way ⋯ → 设置… opens it. Controls by their schema key; the engine select and
  // the fallback segmented by their field label (those two controls carry no data-key).
  let admin = null;
  const openTts = async (route = 'tts') => { admin = await openAdminWindow(app, page, route); await admin.waitForTimeout(250); return admin; };
  const rx = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const field = (label) => admin.locator('.lobe-form-form__field', { has: admin.locator('.lobe-form-form__title-text', { hasText: rx(label) }) });
  const pick = async (label, option) => { await field(label).locator('[role="combobox"]').click(); await admin.locator('[role="option"]', { hasText: rx(option) }).click(); };
  const seg = (label, option) => field(label).locator(`[data-segmented-item][aria-label="${option}"]`).click();
  const engineTags = (card) => admin.locator('.lobe-form-form__group-header', { has: admin.locator('.lobe-form-form__group-title', { hasText: rx(card) }) }).locator('.lobe-tag').allTextContents();
  const waitTags = async (card, re) => { for (let i = 0; i < 80; i++) { const t = await engineTags(card); if (t.some((x) => re.test(x))) return t.join(' / '); await admin.waitForTimeout(100); } throw new Error(`${card} card tags never matched ${re}: ${(await engineTags(card)).join(' / ')}`); };
  const toast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
  const saveDraft = async (key, value) => { await admin.fill(`[data-key="${key}"]`, value); await admin.click(`[data-save="${key}"]`); };
  const saveKey = async (key, value) => { await admin.fill(`[data-key="${key}"]`, value); await admin.click(`[data-save="${key}"]`); await admin.waitForFunction((k) => document.querySelector(`[data-has-key="${k}"]`).textContent.includes('已设置'), key); };
  const waitSet = async (pred, what) => { for (let i = 0; i < 80; i++) { const st = await ttsSet(); if (pred(st)) return st; await page.waitForTimeout(100); } throw new Error(`settings never got ${what}`); };
  const ashot = async (name) => { await admin.waitForTimeout(200); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  try {
    await step(S, 'V0 hatch 大肥鱼 with the fake lh', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const st = await ttsSet();
      assert.deepEqual(st.tts, { provider: 'auto', providerSet: false, fallback: 'system', packs: true, voicePack: 'auto', voicePackByCharacter: {}, endpoints: { fish: '', minimax: '', elevenlabs: '', local: '' }, local: { api: 'openai', model: '', voice: '' }, elevenlabs: { voiceId: '', modelId: 'eleven_multilingual_v2' } });
      return note(`default settings.tts ${JSON.stringify(st.tts)}; keys: fish=${st.ttsStatus.engines.fish.hasKey} minimax=${st.ttsStatus.engines.minimax.hasKey}`);
    }, page);

    await step(S, 'V1 设置窗口 → 朗读: switch 朗读 on, enter the Fish endpoint and API key', async () => {
      await openTts();
      await ashot('v1-voice-toggle-off');
      assert.equal(await admin.getAttribute('[data-key="prefs.voice"]', 'aria-checked'), 'false');
      await admin.click('[data-key="prefs.voice"]');
      await toast(/已保存：朗读回复 → 开/);
      await admin.waitForSelector('[data-key="prefs.voice"][aria-checked="true"]');
      await ashot('v1-voice-toggle-on');
      assert.equal((await ttsSet()).prefs.voice, true);
      await field('朗读引擎').locator('[role="combobox"]').click();
      await admin.waitForSelector('[role="option"]');
      const opts = await admin.locator('[role="option"]').allTextContents();
      await ashot('v1-engine-options');
      await admin.keyboard.press('Escape');
      assert.deepEqual(opts, ['自动（跟随角色）', 'Fish Audio', 'MiniMax', 'ElevenLabs', '本地语音服务', '系统语音']);
      assert.equal(await field('朗读引擎').locator('[role="combobox"]').textContent(), '自动（跟随角色）');
      assert.match(await waitTags('Fish Audio', /未设置 Key/), /未设置 Key/); // a cloud engine without a key
      await ashot('v1-voice-section-empty');
      await saveDraft('tts.endpoints.fish', mock.url);
      await toast(/已保存：端点 → http:\/\/127\.0\.0\.1/);
      await waitSet((st) => st.tts.endpoints.fish === mock.url, 'the Fish endpoint');
      assert.equal(await admin.getAttribute('[data-key="keys.fish"]', 'type'), 'password');
      assert.equal(await admin.textContent('[data-has-key="keys.fish"]'), '未设置');
      await saveKey('keys.fish', mock.KEY);
      await toast(/API Key 已保存（不会回显）/);
      assert.equal(await admin.inputValue('[data-key="keys.fish"]'), '', 'the key is not kept in the page');
      const status = `Fish Audio: ${await waitTags('Fish Audio', /^可用$/)}, key ${await admin.textContent('[data-has-key="keys.fish"]')}; MiniMax: ${(await engineTags('MiniMax')).join(' / ')}, key ${await admin.textContent('[data-has-key="keys.minimax"]')}`;
      assert.equal((await ttsSet()).ttsStatus.engines.fish.hasKey, true);
      await ashot('v1-voice-section-configured');
      // the controls as the DOM has them: the 朗读 switch, the engine select and fallback segmented, key / endpoint fields
      const dom = await admin.evaluate(() => {
        const d = (el) => `<${el.tagName.toLowerCase()}${[...el.attributes].filter((a) => !['style', 'class', 'id'].includes(a.name)).map((a) => ` ${a.name}="${a.value}"`).join('')}>${el.tagName === 'INPUT' ? ` value=${JSON.stringify(el.type === 'password' ? (el.value ? '(non-empty)' : '') : el.value)}` : ` "${el.textContent}"`}`;
        const root = document.querySelector('[data-path="/tts"]');
        return ['# 设置窗口 → 朗读 (#/tts)', ...[...root.querySelectorAll('.lobe-form-form__group-title, .lobe-form-form__group-header .lobe-tag, .lobe-form-form__title-text, [data-key], [data-save], [data-has-key], [role="combobox"], [data-segmented-item]')].map((el) => (el.matches('.lobe-form-form__group-title') ? `\n## ${el.textContent}` : el.matches('.lobe-form-form__title-text') ? `- ${el.textContent}` : `    ${d(el)}`))].join('\n');
      });
      fs.writeFileSync(path.join(SHOTS, 'v1-settings-dom.txt'), dom + '\n');
      assert.equal(dom.includes(mock.KEY), false);
      assert.equal((await admin.content()).includes(mock.KEY), false, 'the key is nowhere in the settings window');
      // 大肥鱼's own voice (was the 语音 credit line): 语音包 lists her built-in MiniMax 俏皮萌妹 pack
      await openTts('voicepacks');
      const row = admin.locator('tr', { hasText: '大肥鱼' }).first();
      await row.waitFor();
      const credit = (await row.innerText()).replace(/\s+/g, ' ');
      assert.match(credit, /大肥鱼.*MiniMax.*俏皮萌妹.*minimax.*内置/);
      await ashot('v1-default-auto-credit');
      await openTts();
      // 大肥鱼 reads with MiniMax by default; with only a Fish key she goes to Fish without a MiniMax request
      await prewarmed(page);
      const before = reqs();
      const sp = await speakLine('先用俏皮萌妹试试');
      assert.equal(sp.engine, 'auto');
      assert.equal(sp.provider, 'fish');
      assert.deepEqual(sp.fellBackFrom, [{ provider: 'minimax', reason: 'no-key' }]);
      assert.equal(reqs(), before + 1);
      assert.equal(mock.log[mock.log.length - 1].path, '/v1/tts');
      // V3–V10 test Fish on its own: pick it
      await pick('朗读引擎', 'Fish Audio');
      await toast(/已保存：朗读引擎 → Fish Audio/);
      await waitSet((st) => st.tts.provider === 'fish', 'provider fish');
      return note(`engines offered: ${opts.join(' / ')}; 语音包 row: ${credit}; status: ${status}; 按角色 without a MiniMax key: ${fmt(sp)}`);
    }, () => admin || page);

    await step(S, 'V2 the key stays out of settings.json, the log and the page; stored in tts-keys.json', async () => {
      const settingsRaw = fs.readFileSync(path.join(data, 'settings.json'), 'utf8');
      const keysRaw = fs.readFileSync(path.join(data, 'tts-keys.json'), 'utf8');
      const log = fs.existsSync(path.join(data, 'pixel-pet.log')) ? fs.readFileSync(path.join(data, 'pixel-pet.log'), 'utf8') : '';
      const pageSt = JSON.stringify(await ttsSet());
      assert.equal(settingsRaw.includes(mock.KEY), false, 'settings.json');
      assert.equal(log.includes(mock.KEY), false, 'log');
      assert.equal(pageSt.includes(mock.KEY), false, 'renderer settings');
      assert.equal(app.stderrBuf.includes(mock.KEY), false, 'stderr');
      const st = await ttsSet();
      const mode = (fs.statSync(path.join(data, 'tts-keys.json')).mode & 0o777).toString(8);
      if (st.ttsStatus.encrypted) assert.equal(keysRaw.includes(mock.KEY), false, 'encrypted file');
      return note(`settings.json has key: no; log has key: no; renderer settings have key: no; tts-keys.json ${st.ttsStatus.encrypted ? 'encrypted (safeStorage)' : 'plain, mode 0' + mode} = ${keysRaw.replace(mock.KEY, '<key>').slice(0, 120)}; settings.tts = ${JSON.stringify(JSON.parse(settingsRaw).tts)}`);
    });

    await step(S, 'V3 engine choice: 大肥鱼 speaks through Fish Audio with the 蓝色大肥鱼 voice', async () => {
      await prewarmed(page); // 互动语音's prewarm sends its own Fish requests; count only this line's
      const before = reqs();
      const sp = await speakLine('今天也要好好吃饭哦');
      assert.equal(sp.provider, 'fish');
      assert.equal(sp.voiceId, 'fe50cdf3040449298470d58ff0991e1d');
      assert.equal(sp.cached, false);
      assert.equal(reqs(), before + 1);
      const rq = mock.log[mock.log.length - 1];
      assert.equal(rq.path, '/v1/tts');
      assert.equal(rq.auth, true);
      assert.equal(rq.model, 's2.1-pro');
      assert.equal(rq.voice, 'fe50cdf3040449298470d58ff0991e1d');
      await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return sp.started || sp.status === 'done'; }, null, { timeout: 5000 }).catch(() => {});
      const after = await last();
      await shot('v3-fish-speaking');
      return note(`${fmt(after)} bytes=${after.bytes} mime=${after.mime} played=${!!after.started}; mock saw POST ${rq.path} model=${rq.model} reference_id=${rq.voice} auth=Bearer✓ text="${rq.text}" prosody=${JSON.stringify(rq.prosody)}`);
    }, page);

    await step(S, 'V4 cache: the same line again is played from the local cache, no request', async () => {
      await prewarmed(page); // 互动语音's prewarm sends its own Fish requests; count only this line's
      const before = reqs();
      const sp = await speakLine('今天也要好好吃饭哦');
      assert.equal(sp.provider, 'fish');
      assert.equal(sp.cached, true);
      assert.equal(reqs(), before, 'no new request');
      const files = fs.readdirSync(path.join(data, 'tts-cache')).filter((f) => f !== 'index.json');
      const st = await ttsSet();
      return note(`${fmt(sp)}; mock requests ${before} → ${reqs()}; tts-cache/: ${files.join(', ')} (${st.ttsStatus.cache.count} line(s), ${st.ttsStatus.cache.bytes} bytes)`);
    });

    await step(S, 'V5 one line at a time: a new line interrupts the one still being synthesised; the UI keeps responding', async () => {
      mock.slow['这句话很长很长要等一会儿'] = 2500;
      const before = reqs();
      await page.evaluate(() => { window.petFx.speak('这句话很长很长要等一会儿'); });
      await page.waitForFunction(() => window.petFx.lastSpeech().status === 'synthesizing');
      const first = await last();
      const t0 = Date.now();
      const st = await page.evaluate(() => window.petFx.state());
      const uiMs = Date.now() - t0;
      await page.waitForTimeout(300);
      const sp = await speakLine('新的一句插进来');
      await page.waitForTimeout(500);
      const slow = mock.log.find((r) => r.text === '这句话很长很长要等一会儿');
      assert.equal(sp.provider, 'fish');
      assert.equal(sp.text, '新的一句插进来');
      assert.ok(slow && slow.aborted, 'the slow request was aborted');
      assert.ok(uiMs < 1000, `UI answered in ${uiMs} ms`);
      const audios = await page.evaluate(() => window.petFx.audioState());
      return note(`line 1 #${first.n} "${first.text}" synthesizing → interrupted (mock: aborted=${slow.aborted}); line 2 ${fmt(sp)}; petFx.state() answered in ${uiMs} ms while synthesising (${st.state}); requests ${before} → ${reqs()}; one audio element: ${JSON.stringify(audios)}`);
    });

    await step(S, 'V6 fallback on an HTTP error: the line goes to the system voice, Fish is paused for 20 s', async () => {
      mock.mode = '500';
      const sp = await speakLine('服务器出错的时候');
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, [{ provider: 'fish', reason: 'http-500' }]);
      const before = reqs();
      const sp2 = await speakLine('暂停期间的下一句');
      assert.equal(sp2.provider, 'system');
      assert.deepEqual(sp2.fellBackFrom, [{ provider: 'fish', reason: 'paused:http-500' }]);
      assert.equal(reqs(), before, 'no request while paused');
      const fishSt = (await ttsSet()).ttsStatus.engines.fish;
      assert.equal(fishSt.lastError, 'http-500');
      assert.ok(fishSt.pausedFor > 0 && fishSt.pausedFor <= 20, `paused for ${fishSt.pausedFor} s`);
      await openTts();
      const status = await waitTags('Fish Audio', /^上次失败：http-500$/);
      await ashot('v6-fallback-http-500');
      return note(`${fmt(sp)} (system voice lang ${sp.lang} pitch ${sp.pitch} rate ${sp.rate}, ${sp.systemVoices} system voices); next: ${fmt(sp2)}; Fish card: ${status}; ttsStatus.engines.fish ${JSON.stringify(fishSt)}`);
    }, () => admin || page);

    await step(S, 'V7 fallback on a timeout: no answer in 5 s (a little more for a longer line) → system voice; the pet stays responsive', async () => {
      mock.mode = 'hang';
      // saving the endpoint again resets the pause (the settings window's 保存 is off while the field is unchanged:
      // the same admin-set through its bridge)
      assert.equal((await adminSet(admin, 'tts.endpoints.fish', mock.url)).ok, true);
      assert.equal((await ttsSet()).ttsStatus.engines.fish.pausedFor, 0, 'the pause was reset');
      const t0 = Date.now();
      await page.evaluate(() => { window.petFx.speak('网络很慢的时候'); });
      const probes = [];
      for (let i = 0; i < 3; i++) { await page.waitForTimeout(800); const p0 = Date.now(); await page.evaluate(() => window.petFx.state()); probes.push(Date.now() - p0); }
      await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return sp.text === '网络很慢的时候' && sp.status !== 'synthesizing'; }, null, { timeout: 10000 });
      const sp = await last();
      spoken = sp.n;
      const ms = Date.now() - t0;
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, [{ provider: 'fish', reason: 'timeout' }]);
      assert.ok(ms >= 4800 && ms < 8000, `fell back after ${ms} ms`);
      const rq = mock.log[mock.log.length - 1];
      await page.waitForTimeout(300);
      return note(`${fmt(sp)}; fell back after ${ms} ms; request aborted=${rq.aborted}; UI probes while waiting: ${probes.join('/')} ms`);
    });

    await step(S, 'V8 fallback offline: navigator.onLine false → system voice without a request', async () => {
      mock.mode = 'ok';
      assert.equal((await adminSet(admin, 'tts.endpoints.fish', mock.url)).ok, true); // resets the timeout pause
      await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
      const before = reqs();
      const sp = await speakLine('断网的时候');
      await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }));
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, [{ provider: 'fish', reason: 'offline' }]);
      assert.equal(reqs(), before);
      return note(fmt(sp));
    });

    await step(S, 'V9 fallback without a key: cleared in 设置窗口 → 朗读 → system voice, no request', async () => {
      await openTts();
      await admin.locator('[data-has-key="keys.fish"]').locator('xpath=..').locator('button', { hasText: /^清除$/ }).click();
      await admin.locator('button', { hasText: /^清除API Key$/ }).click(); // the confirmation
      await admin.waitForFunction(() => document.querySelector('[data-has-key="keys.fish"]').textContent === '未设置');
      await toast(/API Key 已清除/);
      const tags = await waitTags('Fish Audio', /^未设置 Key$/);
      assert.equal((await ttsSet()).ttsStatus.engines.fish.hasKey, false);
      const before = reqs();
      const sp = await speakLine('没有钥匙的时候');
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, [{ provider: 'fish', reason: 'no-key' }]);
      assert.equal(reqs(), before);
      await ashot('v9-no-key');
      return note(`${fmt(sp)}; Fish card: ${tags}, key ${await admin.textContent('[data-has-key="keys.fish"]')}`);
    }, () => admin || page);

    await step(S, 'V10 fallback set to 不出声: the line stays silent', async () => {
      await seg('引擎用不了时', '不出声');
      await toast(/已保存：引擎用不了时 → 不出声/);
      await waitSet((st) => st.tts.fallback === 'silent', 'fallback silent');
      const sp = await speakLine('安静一点');
      assert.equal(sp.status, 'silent');
      assert.equal(sp.provider, null);
      await seg('引擎用不了时', '改用系统语音');
      await waitSet((st) => st.tts.fallback === 'system', 'fallback system');
      return note(fmt(sp));
    }, () => admin || page);

    await step(S, 'V11 按角色 (the default): 大肥鱼 reads with MiniMax, voice qiaopi_mengmei', async () => {
      await saveDraft('tts.endpoints.minimax', mock.url);
      await waitSet((st) => st.tts.endpoints.minimax === mock.url, 'the MiniMax endpoint');
      await saveKey('keys.minimax', mock.MM_KEY);
      await pick('朗读引擎', '自动（跟随角色）');
      await toast(/已保存：朗读引擎 → 自动（跟随角色）/);
      await waitSet((st) => st.tts.provider === 'auto' && st.ttsStatus.engines.minimax.hasKey, 'auto with a MiniMax key');
      await waitTags('MiniMax', /^可用$/);
      await ashot('v11-minimax-selected');
      const sp = await speakLine('换一个引擎试试');
      const rq = mock.log[mock.log.length - 1];
      assert.equal(sp.engine, 'auto');
      assert.equal(sp.provider, 'minimax');
      assert.equal(sp.voiceId, 'qiaopi_mengmei');
      assert.deepEqual(sp.fellBackFrom, []);
      assert.equal(rq.model, 'speech-2.8-turbo');
      assert.equal(rq.path, '/v1/t2a_v2');
      assert.equal(rq.auth, true);
      return note(`${fmt(sp)}; mock saw POST ${rq.path} model=${rq.model} voice_id=${rq.voice} voice_setting=${JSON.stringify(rq.prosody)}`);
    }, page);

    await step(S, 'V12 engine choice: 系统语音 sends nothing to any engine', async () => {
      await pick('朗读引擎', '系统语音');
      await toast(/已保存：朗读引擎 → 系统语音/);
      await waitSet((st) => st.tts.provider === 'system', 'provider system');
      const before = reqs();
      const sp = await speakLine('用系统的声音');
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, []);
      assert.equal(reqs(), before);
      return note(fmt(sp));
    });

    await step(S, 'V13 other characters keep their own default: 按角色 with both keys, 克洛蒂 on Fish', async () => {
      await saveKey('keys.fish', mock.KEY);
      await pick('朗读引擎', '自动（跟随角色）');
      await waitSet((st) => st.tts.provider === 'auto' && st.ttsStatus.engines.fish.hasKey && st.ttsStatus.engines.minimax.hasKey, 'auto with both keys');
      await page.evaluate(() => window.pet.switchCharacter('claude'));
      await page.waitForTimeout(800);
      const sp = await speakLine('我是克洛蒂');
      const rq = mock.log[mock.log.length - 1];
      assert.equal(sp.species, 'claude');
      assert.equal(sp.provider, 'fish');
      assert.equal(sp.voiceId, 'faccba1a8ac54016bcfc02761285e67f');
      assert.equal(rq.voice, 'faccba1a8ac54016bcfc02761285e67f');
      await shot('v13-claude-fish');
      const log = fs.existsSync(path.join(data, 'pixel-pet.log')) ? fs.readFileSync(path.join(data, 'pixel-pet.log'), 'utf8') : '';
      assert.equal(log.includes(mock.KEY) || log.includes(mock.MM_KEY), false, 'no key in the log');
      return note(`${fmt(sp)}; mock reference_id=${rq.voice} prosody=${JSON.stringify(rq.prosody)}; pixel-pet.log TTS lines (no keys): ${log.split('\n').filter((l) => l.includes('tts ')).map((l) => l.slice(25)).join(' | ')}`);
    }, page);

    // The owner's case (2026-10-30): MiniMax answers 1002 past 10 requests a minute, and with 用不了时 = 不出声
    // every line during the old 5-minute pause was silent. Now the pet keeps under the limit itself.
    await step(S, 'V14 MiniMax: never more than 10 requests a minute; past that a line falls back at once (no 1002, no pause)', async () => {
      await openTts(); // 克洛蒂 (V13) has a MiniMax voice too
      await pick('朗读引擎', 'MiniMax');
      await toast(/已保存：朗读引擎 → MiniMax/);
      await waitSet((st) => st.tts.provider === 'minimax', 'provider minimax');
      const mm = () => mock.log.filter((r) => r.path === '/v1/t2a_v2');
      const lines = [];
      let over = null;
      for (let i = 0; i < 14 && !over; i++) {
        const sp = await speakLine(`第${i + 1}句不一样的话`);
        lines.push(`${i + 1}:${sp.provider}${sp.fellBackFrom.length ? `(${sp.fellBackFrom.map((f) => `${f.provider}:${f.reason}`).join(',')})` : ''}`);
        if (sp.fellBackFrom.some((f) => f.provider === 'minimax' && f.reason === 'rate-limit')) over = sp;
      }
      assert.ok(over, `a line fell back on the rate limit: ${lines.join(' ')}`);
      assert.ok(['fish', 'system'].includes(over.provider), `the next engine in the chain took it (${over.provider})`);
      const times = mm().map((r) => r.at);
      const most = Math.max(...times.map((t) => times.filter((u) => u >= t && u < t + 60000).length));
      assert.ok(most <= 10, `at most 10 MiniMax requests in any minute (saw ${most})`);
      // was the 语音 status line "MiniMax：Key 已设置，每分钟最多 10 次，这一分钟还剩 0": the same status the settings window gets
      const mmSt = (await ttsSet()).ttsStatus.engines.minimax;
      assert.equal(mmSt.hasKey, true);
      assert.equal(mmSt.rpm, 10);
      assert.equal(mmSt.budget, 0, 'none left this minute');
      assert.equal(mmSt.lastError, null, 'MiniMax is not failed');
      assert.equal(mmSt.pausedFor, 0, 'MiniMax is not paused');
      const tags = (await engineTags('MiniMax')).join(' / ');
      assert.equal(/上次失败/.test(tags), false, `the MiniMax card shows no failure: ${tags}`);
      await ashot('v14-minimax-budget');
      return note(`lines: ${lines.join(' ')}; MiniMax requests ${times.length}, most in one minute ${most}; ttsStatus.engines.minimax ${JSON.stringify(mmSt)}; MiniMax card: ${tags}`);
    }, () => admin || page);

    await step(S, 'V15 语音包: a recorded line plays from the pack with no request; with 语音包 off it goes to an engine', async () => {
      await openTts('voicepacks');
      const row = admin.locator('tr', { hasText: '测试录音' }).first();
      await row.waitFor();
      const packText = (await row.innerText()).replace(/\s+/g, ' ');
      assert.match(packText, /克洛蒂.*测试录音.*minimax.*1 句.*自定义/);
      await ashot('v15-voice-pack-status');
      await openTts();
      assert.equal(await admin.getAttribute('[data-key="tts.packs"]', 'aria-checked'), 'true', 'on by default');
      const before = reqs();
      const sp = await speakLine(PACK_LINE);
      assert.equal(sp.provider, 'pack');
      assert.equal(sp.cached, true);
      assert.deepEqual(sp.fellBackFrom, []);
      await page.waitForFunction(() => window.petFx.lastSpeech().status === 'done', null, { timeout: 5000 }); // the tone plays to its end
      assert.equal(reqs(), before, 'no request for a recorded line');
      const other = await speakLine('这一句没有录过');
      assert.notEqual(other.provider, 'pack', 'a line not in the pack goes to an engine');
      await admin.click('[data-key="tts.packs"]');
      await toast(/已保存：使用语音包 → 关/);
      await waitSet((st) => st.tts.packs === false, '语音包 off');
      const off = await speakLine(PACK_LINE);
      assert.notEqual(off.provider, 'pack', '语音包 off');
      await admin.click('[data-key="tts.packs"]');
      await waitSet((st) => st.tts.packs === true, '语音包 on');
      return note(`pack: ${packText}; recorded: ${fmt(sp)}; not recorded: ${fmt(other)}; 语音包 off: ${fmt(off)}; requests ${before} → ${reqs()}`);
    }, () => admin || page);

    await step(S, 'V16 ElevenLabs: endpoint, default voice and key in 设置窗口 → 朗读, picked as the engine → POST /v1/text-to-speech/{voice_id} with xi-api-key', async () => {
      const EL_VOICE = '21m00Tcm4TlvDq8ikWAM';
      await openTts();
      assert.match(await waitTags('ElevenLabs', /未设置 Key/), /未设置 Key/);
      assert.equal((await ttsSet()).ttsStatus.engines.elevenlabs.hasKey, false);
      await admin.locator('[data-key="tts.endpoints.elevenlabs"]').scrollIntoViewIfNeeded();
      await ashot('v16-elevenlabs-card-empty');
      await saveDraft('tts.endpoints.elevenlabs', mock.url);
      await toast(/已保存：端点 → http:\/\/127\.0\.0\.1/);
      await saveDraft('tts.elevenlabs.voiceId', EL_VOICE);
      await toast(/已保存：默认音色 ID → 21m00Tcm4TlvDq8ikWAM/);
      const st0 = await waitSet((s) => s.tts.endpoints.elevenlabs === mock.url && s.tts.elevenlabs.voiceId === EL_VOICE, 'the ElevenLabs endpoint and voice');
      assert.deepEqual(st0.tts.elevenlabs, { voiceId: EL_VOICE, modelId: 'eleven_multilingual_v2' });
      assert.equal(await admin.getAttribute('[data-key="keys.elevenlabs"]', 'type'), 'password');
      await saveKey('keys.elevenlabs', mock.EL_KEY);
      await toast(/API Key 已保存（不会回显）/);
      assert.equal(await admin.inputValue('[data-key="keys.elevenlabs"]'), '', 'the key is not kept in the page');
      const tags = await waitTags('ElevenLabs', /^可用$/);
      await pick('朗读引擎', 'ElevenLabs');
      await toast(/已保存：朗读引擎 → ElevenLabs/);
      const st = await waitSet((s) => s.tts.provider === 'elevenlabs' && s.ttsStatus.engines.elevenlabs.hasKey, 'provider elevenlabs with a key');
      await admin.locator('[data-key="tts.endpoints.elevenlabs"]').scrollIntoViewIfNeeded();
      await ashot('v16-elevenlabs-configured');
      await prewarmed(page);
      const sp = await speakLine('用 ElevenLabs 读这一句');
      const rq = mock.log[mock.log.length - 1];
      assert.equal(sp.engine, 'elevenlabs');
      assert.equal(sp.provider, 'elevenlabs');
      assert.equal(sp.voiceId, EL_VOICE);
      assert.deepEqual(sp.fellBackFrom, []);
      assert.equal(rq.method, 'POST');
      assert.equal(rq.path, `/v1/text-to-speech/${EL_VOICE}`);
      assert.equal(rq.query, 'output_format=mp3_44100_128');
      assert.equal(rq.auth, true, 'xi-api-key matched');
      assert.equal(rq.bearer, false, 'no Authorization header');
      assert.equal(rq.accept, 'audio/mpeg');
      assert.equal(rq.model, 'eleven_multilingual_v2');
      assert.deepEqual(Object.keys(rq.prosody).sort(), ['similarity_boost', 'speed', 'stability', 'style', 'use_speaker_boost']);
      assert.equal(rq.text, '用 ElevenLabs 读这一句');
      assert.equal(fs.readFileSync(path.join(data, 'settings.json'), 'utf8').includes(mock.EL_KEY), false, 'the key is not in settings.json');
      assert.equal((await admin.content()).includes(mock.EL_KEY), false, 'the key is nowhere in the settings window');
      // the same playback path as Fish / MiniMax: main hands the audio to the pet window, playAudio() plays it
      assert.equal(sp.mime, 'audio/wav');
      assert.equal(sp.bytes, mock.wav.length, 'the bytes the stand-in sent');
      await page.waitForTimeout(300);
      await shot('v16-elevenlabs-speaking');
      const played = await page.waitForFunction(() => { const r = window.petFx.lastSpeech(); return r && r.status === 'done' && r; }, null, { timeout: 8000 }).then((h) => h.jsonValue());
      assert.equal(played.provider, 'elevenlabs');
      assert.equal(played.started, true, 'the <audio> element started playing');
      note(`playback: provider=${played.provider} mime=${played.mime} bytes=${played.bytes} started=${played.started} status=${played.status} (renderer playAudio, as fish / minimax)`);
      // a reply the owner asked for, read by ElevenLabs: the bubble marks the sentence being played
      const prevN = played.n;
      mock.perCharMs = 250; // a longer tone, so the screenshot lands while it plays
      if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
      await page.fill('#chat-input', '请用 ElevenLabs 的声音回答我');
      await page.press('#chat-input', 'Enter');
      const reading = await page.waitForFunction((p) => { const r = window.petFx.lastSpeech(); const m = document.querySelector('#bubble .sentence.reading'); const au = window.petFx.audioState(); return r && r.n > p && r.provider === 'elevenlabs' && r.status === 'playing' && r.started && au && !au.paused && au.currentTime > 0.3 && m && { n: r.n, provider: r.provider, status: r.status, mime: r.mime, bytes: r.bytes, text: r.text, marked: m.textContent, bubble: document.getElementById('bubble').textContent.trim(), started: r.started, audio: au }; }, prevN, { timeout: 20000 }).then((h) => h.jsonValue());
      await page.screenshot({ path: path.join(SHOTS, 'v16-elevenlabs-reply-reading.png') });
      // the same moment with a probe label (e2e only) spelling out what the pet window is playing
      await page.evaluate((r) => { const d = document.createElement('div'); d.id = 'e2e-probe'; d.style.cssText = 'position:fixed;left:4px;right:4px;bottom:4px;z-index:99999;background:rgba(0,0,0,.78);color:#fff;font:11px/1.4 monospace;padding:4px 6px;border-radius:4px;white-space:pre-wrap'; d.textContent = `e2e 探针 lastSpeech\nprovider=${r.provider} status=${r.status}\nmime=${r.mime} bytes=${r.bytes}\naudio ${r.audio ? `paused=${r.audio.paused} t=${r.audio.currentTime.toFixed(2)}/${r.audio.duration}s` : '-'}\n正在读：${r.marked}`; document.body.appendChild(d); }, reading);
      await page.screenshot({ path: path.join(SHOTS, 'v16-elevenlabs-reply-reading-probe.png') });
      await page.evaluate(() => document.getElementById('e2e-probe').remove());
      mock.perCharMs = 0;
      await page.waitForFunction(() => window.petFx.lastSpeech().status === 'done', null, { timeout: 30000 });
      const rq2 = mock.log.filter((r) => r.path.startsWith('/v1/text-to-speech/')).pop();
      assert.equal(rq2.text, reading.text, 'the stand-in got the sentence being read');
      note(`reply read by ElevenLabs: bubble 「${reading.bubble}」 marked 「${reading.marked}」 provider=${reading.provider} status=${reading.status} mime=${reading.mime} bytes=${reading.bytes} audio=${JSON.stringify(reading.audio)}; mock got 「${rq2.text}」`);
      return note(`settings.tts.provider=${st.tts.provider} endpoints.elevenlabs=${st.tts.endpoints.elevenlabs} tts.elevenlabs=${JSON.stringify(st.tts.elevenlabs)}; card: ${tags}; ${fmt(sp)}; mock saw ${rq.method} ${rq.path}?${rq.query} xi-api-key=${rq.xiKey} accept=${rq.accept} body=${JSON.stringify(rq.body)}`);
    }, () => admin || page);

    await step(S, 'V17 ElevenLabs without a key: cleared → no request, fellBackFrom elevenlabs:no-key; 不出声 → silent with a reason, never a silent success', async () => {
      await openTts();
      await admin.locator('[data-has-key="keys.elevenlabs"]').scrollIntoViewIfNeeded();
      await admin.locator('[data-has-key="keys.elevenlabs"]').locator('xpath=..').locator('button', { hasText: /^清除$/ }).click();
      await admin.locator('button', { hasText: /^清除API Key$/ }).click();
      await admin.waitForFunction(() => document.querySelector('[data-has-key="keys.elevenlabs"]').textContent === '未设置');
      const tags = await waitTags('ElevenLabs', /^未设置 Key$/);
      // ElevenLabs is the picked engine and has no key: the page says so at the top, not only on the card
      const warn = await admin.locator('.ant-alert, [role="alert"]', { hasText: 'ElevenLabs 还没设置 Key' }).first().textContent({ timeout: 5000 });
      assert.match(warn, /ElevenLabs 还没设置 Key：在下方「ElevenLabs」里填写 API Key 后才能用它朗读。/);
      await admin.evaluate(() => window.scrollTo(0, 0));
      await admin.locator('.ant-alert, [role="alert"]', { hasText: 'ElevenLabs 还没设置 Key' }).first().scrollIntoViewIfNeeded();
      await ashot('v17-elevenlabs-no-key-warning');
      const eng = (await ttsSet()).ttsStatus.engines.elevenlabs;
      assert.equal(eng.hasKey, false);
      assert.equal(eng.ready, false);
      const before = reqs();
      const sp = await speakLine('ElevenLabs 没有钥匙');
      assert.equal(sp.engine, 'elevenlabs');
      assert.notEqual(sp.provider, 'elevenlabs');
      assert.deepEqual(sp.fellBackFrom.filter((f) => f.provider === 'elevenlabs'), [{ provider: 'elevenlabs', reason: 'no-key' }]);
      await admin.locator('[data-has-key="keys.elevenlabs"]').scrollIntoViewIfNeeded();
      await ashot('v17-elevenlabs-no-key');
      // 不出声: straight from the engine (the IPC the pet window uses), the result says why
      await seg('引擎用不了时', '不出声');
      await waitSet((s) => s.tts.fallback === 'silent', 'fallback silent');
      mock.mode = '500'; // the other engine with a key (MiniMax) fails too: nothing can read the line
      const raw = await page.evaluate(async () => { const r = await window.pet.ttsSynthesize('不出声也要说清楚', ''); return { ok: r.ok, reason: r.reason, message: r.message, fallback: r.fallback, fellBackFrom: r.fellBackFrom, next: r.next }; });
      assert.equal(raw.ok, false);
      assert.equal(raw.fallback, 'silent');
      assert.equal(raw.reason, 'no-key');
      assert.deepEqual(raw.fellBackFrom.filter((f) => f.provider === 'elevenlabs'), [{ provider: 'elevenlabs', reason: 'no-key' }]);
      const quiet = await speakLine('安静地没有钥匙');
      assert.equal(quiet.status, 'silent');
      assert.equal(reqs() - before, mock.log.slice(before).filter((r) => !r.path.startsWith('/v1/text-to-speech/')).length, 'no ElevenLabs request without a key');
      assert.equal(mock.log.slice(before).some((r) => r.path.startsWith('/v1/text-to-speech/')), false);
      mock.mode = 'ok';
      await seg('引擎用不了时', '改用系统语音');
      await waitSet((s) => s.tts.fallback === 'system', 'fallback system');
      return note(`card: ${tags}; status.elevenlabs=${JSON.stringify(eng)}; system fallback: ${fmt(sp)}; silent IPC result: ${JSON.stringify(raw)}; silent line: ${fmt(quiet)}`);
    }, () => admin || page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'voice-log.txt'), evidence.join('\n') + '\n\nmock requests:\n' + mock.log.map((r) => JSON.stringify({ ...r, at: undefined })).join('\n') + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ---------------------------------------------------------------- localvoice
// 本地语音服务 (core/tts.js LOCAL): a voice server the user runs (IndexTTS2 / whale-voice…), here a local
// stand-in. Picked in the settings window (设置… → 朗读) like a user would: no address → falls back; the OpenAI speech API
// with a model and voice name; whale-voice's /tts with her mood as emo; a non-audio answer falls back; http
// to the home network is accepted for it and refused for the internet.
async function localvoice() {
  const S = 'localvoice';
  const SHOTS = path.join(OUT, 'localvoice');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await ttsMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-localvoice-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-localvoicefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const shot = async (name) => { await page.waitForTimeout(200); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const evidence = [];
  const note = (s) => { evidence.push(s); return s; };
  const last = () => page.evaluate(() => window.petFx.lastSpeech());
  let spoken = 0;
  const speakLine = async (text, timeout = 30000) => {
    await page.evaluate((t) => { window.petFx.speak(t); }, text);
    const t0 = Date.now();
    for (;;) {
      const sp = await last();
      if (sp && sp.n > spoken && sp.text === text && !/^(queued|synthesizing)$/.test(sp.status)) { spoken = sp.n; return sp; }
      if (Date.now() - t0 > timeout) throw new Error(`no outcome for 「${text}」: ${JSON.stringify(sp)}`);
      await page.waitForTimeout(50);
    }
  };
  const fmt = (sp) => `「${sp.text}」 engine=${sp.engine} → provider=${sp.provider}${sp.voiceId ? ` voice=${sp.voiceId}` : ''} cached=${sp.cached} ${sp.latencyMs}ms status=${sp.status}${sp.fellBackFrom.length ? ` fellBackFrom=${sp.fellBackFrom.map((f) => `${f.provider}:${f.reason}`).join(',')}` : ''}`;
  const ttsSet = () => page.evaluate(async () => (await window.pet.getSettings()));
  const reqFor = (text) => mock.log.filter((r) => r.text === text);
  // 设置窗口 → 朗读 (#/tts) → 本地语音服务 card: controls by their schema key; the engine select and the 接口
  // segmented by their field label (those two controls carry no data-key)
  let admin = null;
  const openTts = async () => { admin = await openAdminWindow(app, page, 'tts'); await admin.waitForTimeout(250); return admin; };
  const rx = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const field = (label) => admin.locator('.lobe-form-form__field', { has: admin.locator('.lobe-form-form__title-text', { hasText: rx(label) }) });
  const pick = async (label, option) => { await field(label).locator('[role="combobox"]').click(); await admin.locator('[role="option"]', { hasText: rx(option) }).click(); };
  const seg = (label, option) => field(label).locator(`[data-segmented-item][aria-label="${option}"]`).click();
  const engineTags = (card) => admin.locator('.lobe-form-form__group-header', { has: admin.locator('.lobe-form-form__group-title', { hasText: rx(card) }) }).locator('.lobe-tag').allTextContents();
  const waitTags = async (card, re) => { for (let i = 0; i < 80; i++) { const t = await engineTags(card); if (t.some((x) => re.test(x))) return t.join(' / '); await admin.waitForTimeout(100); } throw new Error(`${card} card tags never matched ${re}: ${(await engineTags(card)).join(' / ')}`); };
  const toast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
  const saveDraft = async (key, value) => { await admin.fill(`[data-key="${key}"]`, value); await admin.click(`[data-save="${key}"]`); };
  const waitSet = async (pred, what) => { for (let i = 0; i < 80; i++) { const st = await ttsSet(); if (pred(st)) return st; await page.waitForTimeout(100); } throw new Error(`settings never got ${what}`); };
  const ashot = async (name) => { await admin.waitForTimeout(200); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  try {
    await step(S, 'L0 hatch 大肥鱼; settings.tts has the local engine, empty', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const st = await ttsSet();
      assert.deepEqual(st.tts.local, { api: 'openai', model: '', voice: '' });
      assert.equal(st.tts.endpoints.local, '');
      assert.equal(st.ttsStatus.engines.local.ready, false);
      return note(`settings.tts ${JSON.stringify(st.tts)}; local status ${JSON.stringify(st.ttsStatus.engines.local)}`);
    }, page);

    await step(S, 'L1 pick 本地语音服务 without an address: the line falls back to the system voice', async () => {
      await openTts();
      await admin.click('[data-key="prefs.voice"]');
      await toast(/已保存：朗读回复 → 开/);
      await waitSet((st) => st.prefs.voice === true, '朗读 on');
      await field('朗读引擎').locator('[role="combobox"]').click();
      await admin.waitForSelector('[role="option"]');
      const opts = await admin.locator('[role="option"]').allTextContents();
      assert.deepEqual(opts, ['自动（跟随角色）', 'Fish Audio', 'MiniMax', 'ElevenLabs', '本地语音服务', '系统语音']);
      await admin.locator('[role="option"]', { hasText: rx('本地语音服务') }).click();
      await toast(/已保存：朗读引擎 → 本地语音服务/);
      await waitSet((st) => st.tts.provider === 'local', 'provider local');
      // was "本地语音服务：没填地址": the card is 未就绪 and its 地址 empty
      const tags = await waitTags('本地语音服务', /^未就绪$/);
      assert.equal(await admin.inputValue('[data-key="tts.endpoints.local"]'), '');
      await admin.locator('[data-key="tts.endpoints.local"]').scrollIntoViewIfNeeded();
      await ashot('l1-local-box-empty');
      const before = mock.log.length;
      const sp = await speakLine('没有地址的时候念这句');
      assert.deepEqual(sp.fellBackFrom.map((f) => `${f.provider}:${f.reason}`), ['local:no-endpoint']);
      assert.notEqual(sp.provider, 'local');
      assert.equal(mock.log.length, before, 'no request anywhere');
      return note(`no address: ${fmt(sp)}; 本地语音服务 card: ${tags}; ttsStatus.engines.local ${JSON.stringify((await ttsSet()).ttsStatus.engines.local)}`);
    }, () => admin || page);

    await step(S, 'L2 OpenAI-compatible: address + model + voice → POST /v1/audio/speech, her line plays from it', async () => {
      await openTts();
      await admin.locator('[data-key="tts.endpoints.local"]').scrollIntoViewIfNeeded();
      assert.equal(await field('接口').locator('[data-segmented-item][aria-pressed="true"]').getAttribute('aria-label'), 'OpenAI 兼容');
      await saveDraft('tts.endpoints.local', `${mock.url}/v1`);
      await toast(/已保存：地址 → http:\/\/127\.0\.0\.1/);
      await saveDraft('tts.local.model', 'IndexTTS-2');
      await toast(/已保存：模型 → IndexTTS-2/);
      await saveDraft('tts.local.voice', 'whale');
      await toast(/已保存：音色名 → whale/);
      const st = await waitSet((s) => s.tts.local.voice === 'whale' && s.tts.local.model === 'IndexTTS-2' && s.tts.endpoints.local === `${mock.url}/v1`, 'the local server');
      assert.deepEqual(st.tts.local, { api: 'openai', model: 'IndexTTS-2', voice: 'whale' });
      const tags = await waitTags('本地语音服务', /^可用$/);
      // its key is optional (was the key field's 可不填 placeholder)
      assert.equal(await field('API Key（可选）').locator('[data-key="keys.local"]').count(), 1);
      await ashot('l2-local-openai-configured');
      await prewarmed(page);
      const pre = await page.evaluate(() => window.petFx.lastPrewarm());
      const LINE = '鱼片，今天也要好好吃饭哦。';
      const sp = await speakLine(LINE);
      assert.equal(sp.provider, 'local');
      assert.equal(sp.voiceId, 'whale');
      const rq = reqFor(LINE)[0];
      assert.equal(rq.path, '/v1/audio/speech');
      assert.deepEqual(rq.body, { model: 'IndexTTS-2', input: LINE, voice: 'whale', response_format: 'mp3', speed: 1 });
      await page.waitForFunction(() => window.petFx.lastSpeech().status === 'done', null, { timeout: 10000 });
      await shot('l2-local-openai-spoken');
      return note(`settings.tts.local ${JSON.stringify(st.tts.local)} endpoint ${st.tts.endpoints.local}; card: ${tags}; prewarm ${JSON.stringify(pre)}; ${fmt(sp)}; request ${rq.path} ${JSON.stringify(rq.body)}`);
    }, page);

    await step(S, 'L3 whale-voice: POST /tts { text, emo } with her mood as the emotion', async () => {
      await openTts();
      await admin.locator('[data-key="tts.endpoints.local"]').scrollIntoViewIfNeeded();
      await saveDraft('tts.endpoints.local', mock.url);
      await waitSet((s) => s.tts.endpoints.local === mock.url, 'the server root as the address');
      await seg('接口', 'Whale');
      await toast(/已保存：接口 → Whale/);
      const st = await waitSet((s) => s.tts.local.api === 'whale' && s.tts.endpoints.local === mock.url, 'whale-voice');
      await ashot('l3-local-whale-configured');
      await prewarmed(page);
      const LINE = '咕噜，这句用鲸鱼的声音念。';
      const sp = await speakLine(LINE);
      assert.equal(sp.provider, 'local');
      assert.equal(sp.voiceId, 'whale-voice');
      const rq = reqFor(LINE)[0];
      assert.equal(rq.path, '/tts');
      assert.deepEqual(Object.keys(rq.body).sort(), ['emo', 'text']);
      assert.ok(['happy', 'sleepy', 'wronged', 'tender'].includes(rq.body.emo), rq.body.emo);
      const warm = mock.log.filter((r) => r.path === '/tts' && r.text !== LINE);
      assert.ok(warm.length > 0, 'her common lines were prewarmed on the local server');
      const emos = [...new Set(warm.map((r) => r.emo))];
      return note(`settings.tts.local ${JSON.stringify(st.tts.local)}; ${fmt(sp)}; request ${rq.path} ${JSON.stringify(rq.body)}; prewarmed ${warm.length} lines through /tts, emo used: ${emos.join(', ')}`);
    }, () => admin || page);

    await step(S, 'L4 the server answers with no audio (model not loaded): falls back, status says why', async () => {
      mock.mode = 'notaudio';
      const LINE = '模型还没加载好时念这句';
      const sp = await speakLine(LINE);
      mock.mode = 'ok';
      assert.deepEqual(sp.fellBackFrom.map((f) => `${f.provider}:${f.reason}`), ['local:not-audio']);
      assert.notEqual(sp.provider, 'local');
      // was "本地语音服务：…上次返回的不是音频，N 秒内跳过"
      const localSt = (await ttsSet()).ttsStatus.engines.local;
      assert.equal(localSt.lastError, 'not-audio');
      assert.ok(localSt.pausedFor > 0, `skipped for ${localSt.pausedFor} s`);
      await openTts();
      const tags = await waitTags('本地语音服务', /^上次失败：not-audio$/);
      await ashot('l4-local-not-audio-status');
      return note(`${fmt(sp)}; ttsStatus.engines.local ${JSON.stringify(localSt)}; card: ${tags}`);
    }, () => admin || page);

    await step(S, 'L5 address rules: home-network http accepted, internet http refused', async () => {
      await openTts();
      await admin.locator('[data-key="tts.endpoints.local"]').scrollIntoViewIfNeeded();
      await saveDraft('tts.endpoints.local', 'http://example.com:7864');
      await admin.waitForSelector('[data-error="tts.endpoints.local"]');
      const refused = await admin.textContent('[data-error="tts.endpoints.local"]');
      assert.match(refused, /局域网/);
      await toast(/地址 没有保存/);
      assert.equal((await ttsSet()).tts.endpoints.local, mock.url, 'kept the old address');
      await ashot('l5-local-internet-http-refused');
      await saveDraft('tts.endpoints.local', 'http://192.168.1.20:7864');
      await toast(/已保存：地址 → http:\/\/192\.168\.1\.20:7864/);
      const lan = (await waitSet((s) => s.tts.endpoints.local === 'http://192.168.1.20:7864', 'the LAN address')).tts.endpoints.local;
      await admin.waitForSelector('[data-error="tts.endpoints.local"]', { state: 'detached' });
      await ashot('l5-local-lan-address');
      // the cloud engines still refuse plain http off this machine
      await saveDraft('tts.endpoints.fish', 'http://192.168.1.20:7864');
      await admin.waitForSelector('[data-error="tts.endpoints.fish"]');
      const fishErr = await admin.textContent('[data-error="tts.endpoints.fish"]');
      assert.match(fishErr, /https/);
      assert.equal((await ttsSet()).tts.endpoints.fish, '');
      return note(`internet http: “${refused}”; LAN saved: ${lan}; Fish with LAN http refused: “${fishErr}”`);
    }, () => admin || page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'localvoice-log.txt'), evidence.join('\n') + '\n\nmock requests:\n' + mock.log.map((r) => JSON.stringify({ ...r, at: undefined })).join('\n') + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ---------------------------------------------------------------- vpack
// 语音包 (core/voice-pack.js): with 朗读 on and no API key at all, her fixed lines (摸摸, 喂食, 部位触摸…)
// play from the built-in pack (src/voicepacks/dafeiyu, MiniMax 俏皮萌妹) — no request, no system voice;
// with 系统语音 chosen the pack is not used.
async function vpack() {
  const S = 'vpack';
  const SHOTS = path.join(OUT, 'vpack');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vpack-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vpackfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true } }));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video') });
  const shot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const evidence = [];
  const note = (x) => { evidence.push(x); return x; };
  const stats = async () => (await page.evaluate(() => window.pet.getSettings())).ttsStatus.stats;
  const idle = async () => {
    await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return !sp || !/^(queued|synthesizing|playing|speaking)$/.test(sp.status); }, null, { timeout: 15000 });
    await page.waitForTimeout(1600); // past the 1.5 s gate
  };
  // one interaction: the line it offers to the voice, and how it was said (waits until it is read to the end)
  const said = async (kindRe, fn) => {
    await idle();
    const n0 = (await page.evaluate(() => window.petFx.offerLog())).length;
    await fn();
    const dump = async (why) => { throw new Error(`${why}: offers ${JSON.stringify((await page.evaluate(() => window.petFx.offerLog())).slice(n0))} last ${JSON.stringify(await page.evaluate(() => window.petFx.lastSpeech()))}`); };
    await page.waitForFunction(([n, re]) => window.petFx.offerLog().slice(n).some((e) => new RegExp(re).test(e.kind) && e.n), [n0, kindRe.source], { timeout: 20000 }).catch(() => dump(`no ${kindRe} line offered`));
    const entry = (await page.evaluate(() => window.petFx.offerLog())).slice(n0).find((e) => kindRe.test(e.kind));
    await page.waitForFunction((n) => { const sp = window.petFx.lastSpeech(); return sp.n !== n || !/^(queued|synthesizing|playing|speaking)$/.test(sp.status); }, entry.n, { timeout: 20000 }).catch(() => dump('not read to the end'));
    return { entry, sp: await page.evaluate(() => window.petFx.lastSpeech()) };
  };
  const petBox = async () => page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
  const fmt = ({ entry, sp }) => `${entry.kind} 「${entry.text}」 → provider=${sp.provider} cached=${sp.cached} ${sp.latencyMs}ms status=${sp.status}`;
  try {
    await step(S, 'P0 hatch 大肥鱼 with 朗读 on and no API key at all', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const st = await page.evaluate(() => window.pet.getSettings());
      assert.equal(st.tts.provider, 'auto');
      assert.equal(st.tts.packs, true);
      // every neural engine (core/tts.js NEURAL: fish, minimax, elevenlabs, local…), none with a key — read from
      // the code so a new engine does not leave this list behind (T-5076: elevenlabs was missing)
      const { NEURAL } = require('../src/core/tts');
      const engines = Object.entries(st.ttsStatus.engines).map(([id, e]) => `${id}:${e.hasKey}`);
      assert.deepEqual(engines, NEURAL.map((id) => `${id}:false`));
      const pack = st.ttsStatus.packs.find((p) => p.character === 'dafeiyu');
      assert.ok(pack && pack.builtIn && pack.lines > 150, `built-in pack: ${JSON.stringify(pack)}`);
      return note(`no keys (engines ${engines.join(' ')}); built-in pack ${pack.id} 「${pack.name}」 ${pack.lines} lines; all packs: ${st.ttsStatus.packs.map((p) => `${p.character}:${p.lines}`).join(' ')}`);
    }, page);

    const rows = [];
    await step(S, 'P1 摸摸 / 喂食 / 部位触摸: each line plays from her pack, read to the end, no engine asked', async () => {
      const s0 = await stats();
      await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
      for (let i = 0; i < 2; i++) {
        const b = await petBox();
        rows.push(await said(/^pat$/, () => page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.4)));
      }
      await page.evaluate(() => window.pet.debugSet({ hunger: 60 }));
      rows.push(await said(/^feed$/, async () => { await clickAct(page, 'feed'); await page.click('#food-menu button'); }));
      await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
      await page.waitForTimeout(300);
      // hover first so her pose settles, then click where her head is drawn now (as ivoice I2 does)
      const b = await petBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(600);
      const pts = await zonePoints(page);
      const z = pts.head || pts.hands || pts.face;
      rows.push(await said(/^touch:/, () => page.mouse.click(z.x, z.y)));
      await shot('p1-touch');
      const s1 = await stats();
      for (const r of rows) {
        assert.equal(r.sp.provider, 'pack', fmt(r));
        assert.equal(r.sp.status, 'done', fmt(r));
      }
      assert.equal((s1.requests || 0) - (s0.requests || 0), 0, 'no engine request');
      assert.ok((s1.packHits || 0) - (s0.packHits || 0) >= rows.length);
      return note(rows.map(fmt).join('\n') + `\nengine requests +${(s1.requests || 0) - (s0.requests || 0)}, pack hits +${(s1.packHits || 0) - (s0.packHits || 0)}`);
    }, page);

    // 设置窗口 (⋯ → 设置…): 语音包 lists the packs; 朗读 → 朗读引擎 is a select found by its field label (no data-key)
    let admin = null;
    const ashot = async (name) => { await admin.waitForTimeout(200); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
    await step(S, 'P2 设置窗口 → 语音包 shows her built-in pack', async () => {
      admin = await openAdminWindow(app, page, 'voicepacks');
      const row = admin.locator('tr', { hasText: '大肥鱼' }).first();
      await row.waitFor();
      const t = (await row.innerText()).replace(/\s+/g, ' ');
      assert.match(t, /^大肥鱼 大肥鱼（MiniMax 「俏皮萌妹」\(qiaopi_mengmei\)） minimax (\d+) 句 内置/);
      const n = Number(t.match(/ (\d+) 句/)[1]);
      const pack = (await page.evaluate(() => window.pet.getSettings())).ttsStatus.packs.find((p) => p.character === 'dafeiyu');
      assert.equal(n, pack.lines, 'the line count is the pack\'s');
      await ashot('p2-voice-pack');
      return note(t);
    }, () => admin || page);

    await step(S, 'P3 with 系统语音 chosen the pack is not used', async () => {
      admin = await openAdminWindow(app, page, 'tts');
      const field = admin.locator('.lobe-form-form__field', { has: admin.locator('.lobe-form-form__title-text', { hasText: /^朗读引擎$/ }) });
      await field.locator('[role="combobox"]').click();
      await admin.locator('[role="option"]', { hasText: /^系统语音$/ }).click();
      await admin.waitForFunction(() => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && /已保存：朗读引擎 → 系统语音/.test(el.textContent || '')), null, { timeout: 8000 });
      for (let i = 0; (await page.evaluate(() => window.pet.getSettings())).tts.provider !== 'system'; i++) {
        if (i > 50) throw new Error('tts.provider was not saved as system');
        await page.waitForTimeout(100);
      }
      await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
      const b = await petBox();
      const r = await said(/^pat$/, () => page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.4));
      assert.notEqual(r.sp.provider, 'pack', fmt(r));
      return note(fmt(r));
    }, page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'vpack-log.txt'), evidence.join('\n\n') + '\n');
    await app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- gvpack
// 通用男女语音包 (core/voice-pack.js kind generic, core/voice-gender.js, docs/voice-packs.md): two imported VRM
// models without a pack of their own (pack.json gender male / female) fall back to generic-male / generic-female
// — their recorded lines play from that pack and an agent reply goes to MiniMax in that gender's voice; the five
// built-in characters resolve as before; set-voice-pack switches a character's pack for her next line and the
// pick survives a restart.
async function gvpack() {
  const S = 'gvpack';
  const SHOTS = path.join(OUT, 'gvpack');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const G = require('../src/core/generic');
  const { importVrm } = require('../src/core/vrm-import');
  const { makeTestVrm } = require('../scripts/make-test-vrm');
  const mock = await ttsMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gvpack-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true, voiceInteractions: false } }));
  // two models imported as 通用设定 companions, each with its gender in pack.json
  const models = {};
  for (const [name, gender] of [['Kaito Test', 'male'], ['Mika Test', 'female']]) {
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gvpack-src-')), `${name}.vrm`);
    fs.writeFileSync(src, makeTestVrm({ name, meta: { allowRedistribution: true, avatarPermission: 'everyone', commercialUsage: 'personalNonProfit' } }));
    const r = await importVrm({ src, speciesId: G.GENERIC_BASE, userDir: path.join(data, 'packs') });
    if (!r.ok) throw new Error(`import ${name}: ${JSON.stringify(r.errors)}`);
    const file = path.join(r.pack.dir, 'pack.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), gender }, null, 1));
    models[gender] = { name, packId: r.pack.id, base: G.baseIdOf(r.pack.id) };
  }
  // the owner's generic-male (same id: replaces the built-in one) with one line recorded (a tone)
  const CATCH = '接住啦！';
  const gm = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'voicepacks', 'generic-male', 'manifest.json'), 'utf8'));
  const gmDir = path.join(data, 'voicepacks', 'generic-male');
  fs.mkdirSync(gmDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'voicepack', 'tone.mp3'), path.join(gmDir, 'tone.mp3'));
  fs.writeFileSync(path.join(gmDir, 'manifest.json'), JSON.stringify({ ...gm, pending: undefined, lines: { [CATCH]: 'tone.mp3' } }));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gvpackfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  let { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video') });
  const shot = async (name, pg = page) => { await pg.waitForTimeout(200); await pg.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const evidence = [];
  const note = (x) => { evidence.push(x); return x; };
  const state = async (id) => (await page.evaluate((c) => window.pet.voicePackState(c), id)).state;
  const fmtState = (s) => `${s.characterId}: choice=${s.choice} → ${s.pack ? s.pack.id : null} (${s.source}; gender ${s.gender}/${s.genderSource}) engineVoice=${s.engineVoice ? `${s.engineVoice.engine}:${s.engineVoice.voiceId}${s.engineVoice.fromPack ? ' (from pack)' : ''}` : 'none'}`;
  // one line through tts-synthesize (what the pet window does for every line she says), and the request it made
  const synth = async (text) => {
    const n0 = mock.log.length;
    const r = await page.evaluate((t) => window.pet.ttsSynthesize(t, '').then((x) => ({ ok: x.ok, provider: x.provider, packId: x.packId || null, voiceId: x.voiceId || null, reason: x.reason || null })), text);
    const req = mock.log.slice(n0).at(-1) || null;
    return { ...r, request: req ? `${req.path} voice_id=${req.voice}` : 'no request' };
  };
  const fmtSynth = (t, r) => `「${t}」 → ok=${r.ok} provider=${r.provider} packId=${r.packId} voiceId=${r.voiceId} | ${r.request}`;
  const REPLY = '这是 agent 的一条回复，不在任何语音包里。';
  try {
    await step(S, 'G0 hatch 大肥鱼; MiniMax key + endpoint (local stand-in); the packs list both kinds', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const r = await page.evaluate(([k, u]) => window.pet.setTts({ key: { id: 'minimax', value: k }, endpoints: { minimax: u } }), [mock.MM_KEY, mock.url]);
      assert.equal(r.ok, true);
      const st = await page.evaluate(() => window.pet.getSettings());
      assert.deepEqual(st.tts.voicePackByCharacter, {});
      const list = st.ttsStatus.packs.map((p) => `${p.id}[${p.kind}${p.gender ? `/${p.gender}` : ''}${p.character ? ` ${p.character}` : ''}] ${p.lines} 句 ${p.builtIn ? '内置' : '自定义'}`);
      for (const id of ['dafeiyu-minimax', 'claude-minimax', 'gemini-minimax', 'gpt-minimax', 'grok-minimax', 'generic-male', 'generic-female']) assert.ok(st.ttsStatus.packs.some((p) => p.id === id), id);
      assert.equal(st.ttsStatus.packs.find((p) => p.id === 'generic-male').builtIn, false, 'the owner\'s generic-male replaces the built-in one');
      await shot('g0-hatched');
      return note(`ttsStatus.packs:\n  ${list.join('\n  ')}`);
    }, page);

    await step(S, 'G1 the five built-in characters resolve to their own packs and own voices, as before', async () => {
      const BEFORE = { dafeiyu: ['dafeiyu-minimax', 'qiaopi_mengmei'], claude: ['claude-minimax', 'Chinese (Mandarin)_Soft_Girl'], grok: ['grok-minimax', 'female-shaonv'], gemini: ['gemini-minimax', 'Chinese (Mandarin)_Crisp_Girl'], gpt: ['gpt-minimax', 'Chinese (Mandarin)_Warm_Girl'] };
      const rows = [];
      for (const [id, [pack, voice]] of Object.entries(BEFORE)) {
        const s = await state(id);
        rows.push(fmtState(s));
        assert.deepEqual([s.pack.id, s.source, s.pack.voiceId, s.engineVoice.fromPack], [pack, 'own', voice, false], id);
      }
      return note(rows.join('\n'));
    }, page);

    await step(S, 'G2 imported models with no pack of their own: male → generic-male, female → generic-female (and its voice)', async () => {
      const m = await state(models.male.base);
      const f = await state(models.female.base);
      assert.deepEqual([m.pack.id, m.source, m.gender, m.genderSource, m.engineVoice.voiceId, m.engineVoice.fromPack], ['generic-male', 'generic', 'male', 'pack', 'male-qn-qingse', true]);
      assert.deepEqual([f.pack.id, f.source, f.gender, f.genderSource, f.engineVoice.voiceId, f.engineVoice.fromPack], ['generic-female', 'generic', 'female', 'pack', 'female-tianmei', true]);
      return note(`${models.male.name} (${models.male.packId}) ${fmtState(m)}\n${models.female.name} (${models.female.packId}) ${fmtState(f)}`);
    }, page);

    await step(S, 'G3 as the male model: his recorded line plays from generic-male, an agent reply is read in the male voice', async () => {
      const r = await page.evaluate(([id, name]) => window.pet.switchCharacter(id, name), [models.male.packId, 'Kaito']);
      assert.notEqual(r && r.ok, false, JSON.stringify(r));
      await page.waitForTimeout(1500);
      const cur = (await page.evaluate(() => window.pet.voicePackState())).state;
      assert.equal(cur.characterId, models.male.base, 'voice-pack-state without an id: the current character');
      const a = await synth(CATCH);
      const b = await synth(REPLY);
      assert.deepEqual([a.ok, a.provider, a.packId], [true, 'pack', 'generic-male']);
      assert.equal(a.request, 'no request');
      assert.deepEqual([b.ok, b.provider, b.voiceId], [true, 'minimax', 'male-qn-qingse']);
      assert.match(b.request, /voice_id=male-qn-qingse$/);
      await shot('g3-male-model');
      return note(`${fmtState(cur)}\n${fmtSynth(CATCH, a)}\n${fmtSynth(REPLY, b)}`);
    }, page);

    await step(S, 'G4 as the female model: an agent reply is read in the female voice', async () => {
      await page.evaluate(([id, name]) => window.pet.switchCharacter(id, name), [models.female.packId, 'Mika']);
      await page.waitForTimeout(1500);
      const b = await synth(REPLY);
      assert.deepEqual([b.ok, b.provider, b.voiceId], [true, 'minimax', 'female-tianmei']);
      await shot('g4-female-model');
      return note(fmtSynth(REPLY, b));
    }, page);

    let ownLine = null;
    await step(S, 'G5 大肥鱼: set-voice-pack generic-male takes effect on her next line; auto brings her own pack back', async () => {
      await page.evaluate(() => window.pet.switchCharacter('dafeiyu'));
      await page.waitForTimeout(1500);
      const own = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'voicepacks', 'dafeiyu', 'manifest.json'), 'utf8'));
      ownLine = Object.keys(own.lines).find((t) => t !== CATCH);
      const rows = [];
      const before = await synth(ownLine);
      rows.push(`before: ${fmtSynth(ownLine, before)}`);
      assert.deepEqual([before.provider, before.packId], ['pack', 'dafeiyu-minimax']);
      const set = await page.evaluate(() => window.pet.setVoicePack('dafeiyu', 'generic-male'));
      assert.equal(set.ok, true);
      assert.deepEqual(set.settings.tts.voicePackByCharacter, { dafeiyu: 'generic-male' });
      rows.push(`set-voice-pack {characterId:'dafeiyu', packId:'generic-male'} → ok=${set.ok} ${fmtState(set.state)}`);
      const a = await synth(ownLine);
      const c = await synth(CATCH);
      const d = await synth(REPLY);
      rows.push(`after:  ${fmtSynth(ownLine, a)}`, `after:  ${fmtSynth(CATCH, c)}`, `after:  ${fmtSynth(REPLY, d)}`);
      assert.deepEqual([a.provider, a.voiceId], ['minimax', 'male-qn-qingse'], 'her own recorded line is no longer used');
      assert.deepEqual([c.provider, c.packId], ['pack', 'generic-male']);
      assert.deepEqual([d.provider, d.voiceId], ['minimax', 'male-qn-qingse']);
      const bad = await page.evaluate(() => window.pet.setVoicePack('dafeiyu', 'no-such-pack'));
      const badChar = await page.evaluate(() => window.pet.setVoicePack('nobody', 'generic-male'));
      assert.deepEqual([bad.ok, bad.reason, badChar.ok, badChar.reason], [false, 'unknown-pack', false, 'unknown-character']);
      rows.push(`set-voice-pack no-such-pack → ${bad.reason}; unknown character → ${badChar.reason}`);
      const back = await page.evaluate(() => window.pet.setVoicePack('dafeiyu', 'auto'));
      assert.deepEqual(back.settings.tts.voicePackByCharacter, {});
      const e = await synth(ownLine);
      const f = await synth(REPLY);
      rows.push(`auto:   ${fmtSynth(ownLine, e)}`, `auto:   ${fmtSynth(REPLY, f)}`);
      assert.deepEqual([e.provider, e.packId], ['pack', 'dafeiyu-minimax']);
      assert.deepEqual([f.provider, f.voiceId], ['minimax', 'qiaopi_mengmei']);
      await shot('g5-dafeiyu');
      return note(rows.join('\n'));
    }, page);

    await step(S, 'G6 the pick is saved in settings.json and comes back after a restart', async () => {
      await page.evaluate(() => window.pet.setVoicePack('dafeiyu', 'generic-female'));
      await page.evaluate(([b]) => window.pet.setVoicePack(b, 'claude-minimax'), [models.male.base]);
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).tts.voicePackByCharacter;
      await app.close().catch(() => {});
      ({ app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video-restart') }));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      const d = await state('dafeiyu');
      const m = await state(models.male.base);
      assert.deepEqual(saved, { dafeiyu: 'generic-female', [models.male.base]: 'claude-minimax' });
      assert.deepEqual([d.choice, d.pack.id, d.source], ['generic-female', 'generic-female', 'user']);
      assert.deepEqual([m.choice, m.pack.id, m.source, m.engineVoice.voiceId], ['claude-minimax', 'claude-minimax', 'user', 'Chinese (Mandarin)_Soft_Girl']);
      await shot('g6-restarted');
      return note(`settings.json tts.voicePackByCharacter = ${JSON.stringify(saved)}\nafter restart:\n${fmtState(d)}\n${fmtState(m)}`);
    }, page);

    let admin = null;
    await step(S, 'G7 设置窗口 → 语音包 lists the generic packs as 通用男声 / 通用女声', async () => {
      admin = await openAdminWindow(app, page, 'voicepacks');
      const male = admin.locator('tr', { hasText: '通用男声（' }).first();
      const female = admin.locator('tr', { hasText: '通用女声（' }).first();
      await male.waitFor();
      await female.waitFor();
      const t = [(await male.innerText()).replace(/\s+/g, ' '), (await female.innerText()).replace(/\s+/g, ' ')];
      assert.match(t[0], /^通用男声 通用男声（MiniMax 青涩青年） minimax 1 句 自定义/);
      assert.match(t[1], /^通用女声 通用女声（MiniMax 甜美女性） minimax 138 句 内置/); // T-5077: recorded
      const fish = (await admin.locator('tr', { hasText: '大肥鱼（MiniMax' }).first().innerText()).replace(/\s+/g, ' ');
      await male.scrollIntoViewIfNeeded();
      await shot('g7-admin-voicepacks', admin);
      return note(`${t.join('\n')}\n${fish}`);
    }, () => admin || page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'gvpack-log.txt'), evidence.join('\n\n') + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ---------------------------------------------------------------- gvpack-recorded
// 通用男女语音包的真实录音 (T-5077, scripts/voicepack-generate.js --generic): a male and a female VRM model imported
// without a pack of their own, and no pack of the owner's in userData — each says three of the generic lines and
// gets them from the built-in recording (provider=pack, generic-male / generic-female), decodable audio, and no
// request to MiniMax (a MiniMax key and endpoint are set, pointing at the local stand-in, so any request is seen).
async function gvpackRecorded() {
  const S = 'gvpack-recorded';
  const SHOTS = path.join(OUT, 'gvpack-recorded');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const G = require('../src/core/generic');
  const { importVrm } = require('../src/core/vrm-import');
  const { makeTestVrm } = require('../scripts/make-test-vrm');
  const manifests = {};
  for (const g of ['male', 'female']) manifests[g] = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'voicepacks', `generic-${g}`, 'manifest.json'), 'utf8'));
  const mock = await ttsMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gvrec-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true, voiceInteractions: false } }));
  const models = {};
  for (const [name, gender] of [['Kaito Test', 'male'], ['Mika Test', 'female']]) {
    const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gvrec-src-')), `${name}.vrm`);
    fs.writeFileSync(src, makeTestVrm({ name, meta: { allowRedistribution: true, avatarPermission: 'everyone', commercialUsage: 'personalNonProfit' } }));
    const r = await importVrm({ src, speciesId: G.GENERIC_BASE, userDir: path.join(data, 'packs') });
    if (!r.ok) throw new Error(`import ${name}: ${JSON.stringify(r.errors)}`);
    const file = path.join(r.pack.dir, 'pack.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), gender }, null, 1));
    models[gender] = { name, packId: r.pack.id, base: G.baseIdOf(r.pack.id) };
  }
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-gvrecfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video') });
  const evidence = [];
  const note = (x) => { evidence.push(x); return x; };
  // one line through tts-synthesize, decoded in the page (Web Audio) to prove it is real, playable audio
  const say1 = (text) => page.evaluate(async (t) => {
    const x = await window.pet.ttsSynthesize(t, '');
    let sec = 0;
    let peak = 0;
    if (x.ok && x.audio) {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(new Uint8Array(x.audio).buffer.slice(0));
      sec = buf.duration;
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i += 50) peak = Math.max(peak, Math.abs(ch[i]));
      await ctx.close();
    }
    return { ok: x.ok, provider: x.provider, packId: x.packId || null, voiceId: x.voiceId || null, mime: x.mime || null, bytes: x.audio ? x.audio.byteLength || x.audio.length : 0, sec: Math.round(sec * 100) / 100, peak: Math.round(peak * 1000) / 1000 };
  }, text);
  try {
    await step(S, 'R0 hatch, MiniMax key + endpoint (local stand-in); built-in generic packs have 138 lines each', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const r = await page.evaluate(([k, u]) => window.pet.setTts({ key: { id: 'minimax', value: k }, endpoints: { minimax: u } }), [mock.MM_KEY, mock.url]);
      assert.equal(r.ok, true);
      const st = await page.evaluate(() => window.pet.getSettings());
      const rows = [];
      for (const g of ['male', 'female']) {
        const p = st.ttsStatus.packs.find((x) => x.id === `generic-${g}`);
        assert.ok(p, `generic-${g}`);
        assert.deepEqual([p.kind, p.gender, p.builtIn, p.lines], ['generic', g, true, 138], `generic-${g}`);
        rows.push(`${p.id}[${p.kind}/${p.gender}] ${p.lines} 句 内置`);
      }
      return note(rows.join('\n'));
    }, page);

    for (const g of ['male', 'female']) {
      await step(S, `R-${g} the ${g} model says three generic lines: from generic-${g}, decodable, no MiniMax request`, async () => {
        const m = models[g];
        const sw = await page.evaluate(([id, name]) => window.pet.switchCharacter(id, name), [m.packId, g === 'male' ? 'Kaito' : 'Mika']);
        assert.notEqual(sw && sw.ok, false, JSON.stringify(sw));
        await page.waitForTimeout(1500);
        const st = (await page.evaluate(() => window.pet.voicePackState())).state;
        assert.deepEqual([st.characterId, st.pack.id, st.source], [m.base, `generic-${g}`, 'generic']);
        const texts = Object.keys(manifests[g].lines);
        const pick = [texts[0], texts[Math.floor(texts.length / 2)], texts[texts.length - 1]];
        const rows = [`${m.name} (${m.packId}) → ${st.pack.id} (${st.source}; gender ${st.gender}/${st.genderSource})`];
        for (const t of pick) {
          const n0 = mock.log.length;
          const r = await say1(t);
          const reqs = mock.log.length - n0;
          rows.push(`「${t}」 → ok=${r.ok} provider=${r.provider} packId=${r.packId} voiceId=${r.voiceId} ${r.mime} ${r.bytes} B, decoded ${r.sec}s peak ${r.peak} | MiniMax requests: ${reqs}`);
          assert.deepEqual([r.ok, r.provider, r.packId, reqs], [true, 'pack', `generic-${g}`, 0], t);
          assert.ok(r.sec > 0.3 && r.peak > 0.01, `${t}: real audio (${r.sec}s, peak ${r.peak})`);
        }
        await page.screenshot({ path: path.join(SHOTS, `r-${g}.png`) });
        return note(rows.join('\n'));
      }, page);
    }

    await step(S, 'R3 no request reached the MiniMax stand-in during the whole run', async () => {
      assert.equal(mock.log.length, 0, JSON.stringify(mock.log.map((x) => x.path)));
      return note(`MiniMax stand-in requests: ${mock.log.length}`);
    }, page);

    let admin = null;
    await step(S, 'R4 设置窗口 → 语音包 lists both built-in generic packs with 138 lines', async () => {
      admin = await openAdminWindow(app, page, 'voicepacks');
      const male = admin.locator('tr', { hasText: '通用男声（' }).first();
      const female = admin.locator('tr', { hasText: '通用女声（' }).first();
      await male.waitFor();
      await female.waitFor();
      const t = [(await male.innerText()).replace(/\s+/g, ' '), (await female.innerText()).replace(/\s+/g, ' ')];
      assert.match(t[0], /^通用男声 通用男声（MiniMax 青涩青年） minimax 138 句 内置/);
      assert.match(t[1], /^通用女声 通用女声（MiniMax 甜美女性） minimax 138 句 内置/);
      await male.scrollIntoViewIfNeeded();
      await admin.waitForTimeout(200);
      await admin.screenshot({ path: path.join(SHOTS, 'r4-admin-voicepacks.png') });
      return note(t.join('\n'));
    }, () => admin || page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'gvpack-recorded-log.txt'), evidence.join('\n\n') + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ---------------------------------------------------------------- voice-pack-switch
// 管理台角色语音包切换 (T-4272, admin/src/console/pages/Characters.tsx VoiceTab): 角色详情 → 语音 lists 自动（按性别）,
// her own pack, the generic male / female packs (the owner's generic-male from userData/voicepacks included) and the
// pack in force with its source (专属 / 通用·男 / 通用·女 · 自动 / 自动回退 / 手动指定); a pick made there is written to
// settings.json, the pet's next line uses the new pack (packId), the list card follows, and it survives a restart.
async function voicePackSwitch() {
  const S = 'voice-pack-switch';
  const SHOTS = path.join(OUT, 'voice-pack-switch');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const G = require('../src/core/generic');
  const { importVrm } = require('../src/core/vrm-import');
  const { makeTestVrm } = require('../scripts/make-test-vrm');
  const mock = await ttsMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vpswitch-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true, voiceInteractions: false } }));
  // a model imported as a 通用设定 companion, male in pack.json, without a pack of his own (自动回退 → 通用·男)
  const src = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vpswitch-src-')), 'Kaito Test.vrm');
  fs.writeFileSync(src, makeTestVrm({ name: 'Kaito Test', meta: { allowRedistribution: true, avatarPermission: 'everyone', commercialUsage: 'personalNonProfit' } }));
  const imp = await importVrm({ src, speciesId: G.GENERIC_BASE, userDir: path.join(data, 'packs') });
  if (!imp.ok) throw new Error(`import: ${JSON.stringify(imp.errors)}`);
  const pj = path.join(imp.pack.dir, 'pack.json');
  fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, 'utf8')), gender: 'male' }, null, 1));
  const male = { packId: imp.pack.id, base: G.baseIdOf(imp.pack.id) };
  // the owner's generic-male in userData/voicepacks (replaces the built-in one) with one recorded line
  const CATCH = '接住啦！';
  const gm = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'voicepacks', 'generic-male', 'manifest.json'), 'utf8'));
  const gmDir = path.join(data, 'voicepacks', 'generic-male');
  fs.mkdirSync(gmDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'voicepack', 'tone.mp3'), path.join(gmDir, 'tone.mp3'));
  fs.writeFileSync(path.join(gmDir, 'manifest.json'), JSON.stringify({ ...gm, pending: undefined, lines: { [CATCH]: 'tone.mp3' } }));
  const ownManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'voicepacks', 'dafeiyu', 'manifest.json'), 'utf8'));
  const OWN = Object.keys(ownManifest.lines).find((t) => t !== CATCH);
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vpswitchfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  let { app, page } = await launch(env, { video: path.join(SHOTS, 'video') });
  let admin = null;
  const evidence = [];
  const note = (x) => { evidence.push(x); return x; };
  const shot = async (name, pg = admin || page) => { await pg.waitForTimeout(300); await pg.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).tts.voicePackByCharacter;
  // one line the way the pet window says it (tts-synthesize): which pack / voice it came from
  const synth = async (text) => {
    const n0 = mock.log.length;
    const r = await page.evaluate((t) => window.pet.ttsSynthesize(t, '').then((x) => ({ ok: x.ok, provider: x.provider, packId: x.packId || null, voiceId: x.voiceId || null })), text);
    const req = mock.log.slice(n0).at(-1) || null;
    return { ...r, request: req ? `${req.path} voice_id=${req.voice}` : 'no request' };
  };
  const fmtSynth = (t, r) => `桌宠 tts-synthesize「${t}」 → provider=${r.provider} packId=${r.packId} voiceId=${r.voiceId} | ${r.request}`;
  // 角色详情 → 语音 tab of one character (by id), the live panel's text
  const voiceTab = async (id) => {
    if (!admin || admin.isClosed()) admin = await openAdminWindow(app, page, `characters/${id}`);
    else {
      await admin.evaluate((r) => { location.hash = r; }, `/characters/${id}`);
      await admin.waitForSelector(`[data-path="/characters/${id}"]`);
    }
    await admin.getByRole('tab', { name: '语音' }).click();
    await admin.waitForFunction(() => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === '语音'); return t && t.getAttribute('aria-selected') === 'true' && document.querySelectorAll('[role="tabpanel"]').length === 1; }, null, { timeout: 5000 });
    await admin.locator('[role="tabpanel"]:not([inert]) [data-voice-pack-select] [role="combobox"]').waitFor();
  };
  // (scrolled into view: the screenshots show the whole 语音包 card, picker to 音色署名)
  const current = async () => {
    await admin.evaluate(() => document.querySelector('[role="tabpanel"]:not([inert]) [data-voice-pack-current]')?.scrollIntoView({ block: 'end' }));
    return (await admin.locator('[role="tabpanel"]:not([inert]) [data-voice-pack-current]').innerText()).replace(/\s+/g, ' ').trim();
  };
  const comboText = async () => (await admin.locator('[role="tabpanel"]:not([inert]) [data-voice-pack-select] [role="combobox"]').innerText()).replace(/\s+/g, ' ').trim();
  const pickInUi = async (rx) => {
    await admin.locator('[role="tabpanel"]:not([inert]) [data-voice-pack-select] [role="combobox"]').click();
    await admin.waitForSelector('[role="option"]');
    const opts = (await admin.locator('[role="option"]').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
    await admin.locator('[role="option"]', { hasText: rx }).first().click();
    return opts;
  };
  const cardMeta = async (base) => {
    await admin.evaluate(() => { location.hash = '/characters'; });
    await admin.waitForSelector('[data-path="/characters"]');
    const id = base === 'dafeiyu' ? 'dafeiyu-pixel' : base;
    const loc = admin.locator(`[data-row-meta="${id}"]`).first();
    await loc.waitFor();
    return (await loc.innerText()).trim();
  };
  try {
    await step(S, 'V0 hatch 大肥鱼; MiniMax key (local stand-in); before: her own pack, auto', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const r = await page.evaluate(([k, u]) => window.pet.setTts({ key: { id: 'minimax', value: k }, endpoints: { minimax: u } }), [mock.MM_KEY, mock.url]);
      assert.equal(r.ok, true);
      assert.deepEqual(saved(), {});
      const a = await synth(OWN);
      assert.deepEqual([a.provider, a.packId], ['pack', 'dafeiyu-minimax']);
      return note(`settings.json tts.voicePackByCharacter = ${JSON.stringify(saved())}\n${fmtSynth(OWN, a)}`);
    }, page);

    await step(S, 'V1 角色列表: the card summary shows the pack in force (语音包 专属)', async () => {
      admin = await openAdminWindow(app, page, 'characters');
      const t = await cardMeta('dafeiyu');
      assert.match(t, /语音包 专属$/);
      await admin.locator('[data-row-meta="dafeiyu-pixel"]').first().scrollIntoViewIfNeeded();
      await shot('v1-list-own');
      return note(`list card dafeiyu-pixel: ${t}`);
    }, () => admin || page);

    let opts = [];
    await step(S, 'V2 角色详情 → 语音: 正在用 专属 · 来源 自动; the picker lists 不使用 / 内置（自动）/ 专属 / 通用·男 / 通用·女', async () => {
      await voiceTab('dafeiyu-pixel');
      const cur = await current();
      assert.match(cur, /正在用 大肥鱼.* 专属/);
      assert.match(cur, /来源 自动 · 她有专属语音包/);
      assert.match(await comboText(), /内置（自动 · 专属或按性别） · 现在是 专属/);
      await shot('v2-voice-tab-auto');
      await admin.locator('[role="tabpanel"]:not([inert]) [data-voice-pack-select] [role="combobox"]').click();
      await admin.waitForSelector('[role="option"]');
      opts = (await admin.locator('[role="option"]').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
      await shot('v2-picker-open');
      await admin.keyboard.press('Escape');
      assert.match(opts[0], /^不使用（全部用引擎朗读）/);
      assert.match(opts[1], /^内置（自动 · 专属或按性别）/);
      assert.ok(opts.some((o) => /^专属 · 大肥鱼/.test(o)), 'her own');
      assert.ok(opts.some((o) => /^通用·男 · 通用男声.* · 1 句$/.test(o)), 'the owner\'s generic-male (userData/voicepacks, 1 line)');
      assert.ok(opts.some((o) => /^通用·女 · 通用女声/.test(o)), 'generic-female');
      return note(`语音 tab: ${cur}\npicker options:\n  ${opts.join('\n  ')}`);
    }, () => admin || page);

    await step(S, 'V3 pick 通用·男 in the UI: settings.json written, the pet\'s next line comes from generic-male, the card follows', async () => {
      await pickInUi(/^通用·男/);
      await adminUntil(admin, () => /通用·男/.test(document.querySelector('[role="tabpanel"]:not([inert]) [data-voice-pack-current]')?.textContent || ''), null, 10000, 'current = 通用·男');
      const cur = await current();
      assert.match(cur, /通用·男/);
      assert.match(cur, /来源 手动指定/);
      assert.deepEqual(saved(), { dafeiyu: 'generic-male' });
      const a = await synth(CATCH);
      const b = await synth(OWN);
      assert.deepEqual([a.provider, a.packId, a.request], ['pack', 'generic-male', 'no request']);
      assert.deepEqual([b.provider, b.voiceId], ['minimax', 'male-qn-qingse'], 'her own recorded line is no longer used; read in the pack\'s voice');
      await shot('v3-picked-generic-male');
      const t = await cardMeta('dafeiyu');
      assert.match(t, /语音包 通用·男$/);
      assert.match(await admin.locator('[data-row-meta="dafeiyu-pixel"]').first().getAttribute('title'), /^语音包：通用·男 · 通用男声.* · 1 句（手动指定）$/);
      await shot('v3-list-generic-male');
      return note(`UI → set-voice-pack(dafeiyu, generic-male)\n语音 tab: ${cur}\nsettings.json tts.voicePackByCharacter = ${JSON.stringify(saved())}\n${fmtSynth(CATCH, a)}\n${fmtSynth(OWN, b)}\nlist card dafeiyu-pixel: ${t}`);
    }, () => admin || page);

    await step(S, 'V4 imported male model without a pack: 正在用 通用·男 · 来源 自动回退 (按性别 男)', async () => {
      await voiceTab(male.packId);
      const cur = await current();
      assert.match(cur, /通用·男/);
      assert.match(cur, /来源 自动回退 · 按性别（男）用通用语音包/);
      assert.match(cur, /朗读音色 minimax · male-qn-qingse（来自语音包）/);
      await shot('v4-male-model-fallback');
      const t = await cardMeta(male.packId);
      return note(`${male.packId} 语音 tab: ${cur}\nlist card: ${t}`);
    }, () => admin || page);

    await step(S, 'V5 restart: the pick is kept (settings.json, 语音 tab, the pet\'s next line)', async () => {
      await app.close().catch(() => {});
      admin = null;
      ({ app, page } = await launch(env, { video: path.join(SHOTS, 'video-restart') }));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      assert.deepEqual(saved(), { dafeiyu: 'generic-male' });
      const a = await synth(CATCH);
      assert.deepEqual([a.provider, a.packId], ['pack', 'generic-male']);
      await voiceTab('dafeiyu-pixel');
      const cur = await current();
      assert.match(cur, /通用·男/);
      assert.match(cur, /来源 手动指定/);
      assert.match(await comboText(), /^通用·男/);
      await shot('v5-after-restart');
      return note(`after restart: settings.json tts.voicePackByCharacter = ${JSON.stringify(saved())}\n语音 tab: ${cur}\n${fmtSynth(CATCH, a)}`);
    }, () => admin || page);

    await step(S, 'V6 pick 通用·女, then 内置（自动）: each in force at once; auto brings her own pack back', async () => {
      await pickInUi(/^通用·女/);
      await adminUntil(admin, () => /通用·女/.test(document.querySelector('[role="tabpanel"]:not([inert]) [data-voice-pack-current]')?.textContent || ''), null, 10000, 'current = 通用·女');
      assert.deepEqual(saved(), { dafeiyu: 'generic-female' });
      const f = await synth(OWN);
      assert.deepEqual([f.provider, f.voiceId], ['minimax', 'female-tianmei']);
      const c1 = await current();
      await shot('v6-picked-generic-female');
      await pickInUi(/^内置（自动/);
      await adminUntil(admin, () => /专属/.test(document.querySelector('[role="tabpanel"]:not([inert]) [data-voice-pack-current]')?.textContent || ''), null, 10000, 'current = 专属');
      assert.deepEqual(saved(), {});
      const a = await synth(OWN);
      assert.deepEqual([a.provider, a.packId], ['pack', 'dafeiyu-minimax']);
      const c2 = await current();
      await shot('v6-back-to-auto');
      return note(`通用·女: ${c1}\n  settings → {dafeiyu:'generic-female'}; ${fmtSynth(OWN, f)}\n自动: ${c2}\n  settings → ${JSON.stringify(saved())}; ${fmtSynth(OWN, a)}`);
    }, () => admin || page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'voice-pack-switch-log.txt'), evidence.join('\n\n') + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ---------------------------------------------------------------- user-voice-pack
// 我的语音包 (用户语音包, settings.tts.voicePack, admin/src/console/pages/Pages.tsx MyVoicePack): 设置 → 语音包 lets the
// owner pick a 通用语音包 (通用男声 / 通用女声, the built-in recorded ones) or any pack as their own; every character
// without a pick of her own uses it from her next line, a pick for her (角色详情 → 语音) still wins, it is written to
// settings.json and survives a restart, and 自动 brings each character's own pack back.
async function userVoicePack() {
  const S = 'user-voice-pack';
  const SHOTS = path.join(OUT, 'user-voice-pack');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await ttsMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-uvp-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true, voiceInteractions: false } }));
  const man = (id) => JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'voicepacks', id, 'manifest.json'), 'utf8'));
  const gm = man('generic-male');
  const gf = man('generic-female');
  const own = man('dafeiyu');
  const GEN = '接住啦！'; // recorded in both generic packs
  assert.ok(gm.lines[GEN] && gf.lines[GEN]);
  const OWN = Object.keys(own.lines).find((t) => !gm.lines[t] && !gf.lines[t]); // only in her own pack
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-uvpfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  let { app, page } = await launch(env, { video: path.join(SHOTS, 'video') });
  let admin = null;
  const evidence = [];
  const note = (x) => { evidence.push(x); return x; };
  const shot = async (name, pg = admin || page) => { await pg.waitForTimeout(300); await pg.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const savedTts = () => { const t = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).tts || {}; return { voicePack: t.voicePack, voicePackByCharacter: t.voicePackByCharacter }; };
  const synth = async (text) => {
    const n0 = mock.log.length;
    const r = await page.evaluate((t) => window.pet.ttsSynthesize(t, '').then((x) => ({ ok: x.ok, provider: x.provider, packId: x.packId || null, voiceId: x.voiceId || null })), text);
    const req = mock.log.slice(n0).at(-1) || null;
    return { ...r, request: req ? `${req.path} voice_id=${req.voice}` : 'no request' };
  };
  const fmtSynth = (t, r) => `桌宠 tts-synthesize「${t}」 → provider=${r.provider} packId=${r.packId} voiceId=${r.voiceId} | ${r.request}`;
  const openPage = async () => {
    if (!admin || admin.isClosed()) admin = await openAdminWindow(app, page, 'voicepacks');
    else {
      await admin.evaluate(() => { location.hash = '/voicepacks'; });
      await admin.waitForSelector('[data-path="/voicepacks"]');
    }
    await admin.locator('[data-user-voice-pack-select] [role="combobox"]').waitFor();
  };
  const mine = async () => {
    await admin.evaluate(() => document.querySelector('[data-user-voice-pack-current]')?.scrollIntoView({ block: 'center' }));
    return (await admin.locator('[data-user-voice-pack-current]').innerText()).replace(/\s+/g, ' ').trim();
  };
  const combo = async () => (await admin.locator('[data-user-voice-pack-select] [role="combobox"]').innerText()).replace(/\s+/g, ' ').trim();
  const pick = async (rx) => {
    await admin.locator('[data-user-voice-pack-select] [role="combobox"]').click();
    await admin.waitForSelector('[role="option"]');
    const opts = (await admin.locator('[role="option"]').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
    await admin.locator('[role="option"]', { hasText: rx }).first().click();
    return opts;
  };
  const until = (rx, what) => adminUntil(admin, (src) => new RegExp(src).test(document.querySelector('[data-user-voice-pack-current]')?.textContent || ''), rx.source, 10000, what);
  try {
    await step(S, 'U0 hatch 大肥鱼; MiniMax key (local stand-in); before: 我的语音包 = auto, she uses her own pack', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const r = await page.evaluate(([k, u]) => window.pet.setTts({ key: { id: 'minimax', value: k }, endpoints: { minimax: u } }), [mock.MM_KEY, mock.url]);
      assert.equal(r.ok, true);
      assert.deepEqual(savedTts(), { voicePack: 'auto', voicePackByCharacter: {} });
      const a = await synth(OWN);
      assert.deepEqual([a.provider, a.packId], ['pack', 'dafeiyu-minimax']);
      return note(`settings.json tts = ${JSON.stringify(savedTts())}\n${fmtSynth(OWN, a)}`);
    }, page);

    let opts = [];
    await step(S, 'U1 设置 → 语音包 → 我的语音包: 自动; the picker lists 通用男声 / 通用女声 (138 句, 内置) and the characters\' own packs', async () => {
      await openPage();
      const t = await mine();
      assert.match(t, /我的语音包 自动/);
      assert.match(t, /现在陪你的 大肥鱼 正在用 .*（专属 · 自动）/);
      assert.match(await combo(), /^自动（每个角色用自己的专属语音包/);
      await shot('u1-auto');
      await admin.locator('[data-user-voice-pack-select] [role="combobox"]').click();
      await admin.waitForSelector('[role="option"]');
      opts = (await admin.locator('[role="option"]').allTextContents()).map((x) => x.replace(/\s+/g, ' ').trim());
      await shot('u1-picker-open');
      await admin.keyboard.press('Escape');
      assert.match(opts[0], /^自动/);
      assert.ok(opts.some((o) => /^通用男声 · .* · 138 句 · 内置$/.test(o)), 'generic-male');
      assert.ok(opts.some((o) => /^通用女声 · .* · 138 句 · 内置$/.test(o)), 'generic-female');
      assert.ok(opts.some((o) => /^大肥鱼 的专属 · /.test(o)), 'a character\'s own pack');
      return note(`我的语音包: ${t}\npicker options:\n  ${opts.join('\n  ')}`);
    }, () => admin || page);

    await step(S, 'U2 pick 通用男声 as 我的语音包: settings.json tts.voicePack = generic-male; her next line comes from generic-male; replies in its voice', async () => {
      await pick(/^通用男声/);
      await until(/我的语音包.*通用男声/, '我的语音包 = 通用男声');
      await until(/正在用 .*通用·男 · 我的语音包/, 'current character follows');
      const t = await mine();
      assert.deepEqual(savedTts(), { voicePack: 'generic-male', voicePackByCharacter: {} });
      const a = await synth(GEN);
      const b = await synth(OWN);
      assert.deepEqual([a.provider, a.packId, a.request], ['pack', 'generic-male', 'no request']);
      assert.deepEqual([b.provider, b.voiceId], ['minimax', gm.voiceId], 'a line not in the pack: read in the pack\'s voice');
      await shot('u2-picked-generic-male');
      return note(`UI → set-user-voice-pack(generic-male)\n我的语音包: ${t}\nsettings.json tts = ${JSON.stringify(savedTts())}\n${fmtSynth(GEN, a)}\n${fmtSynth(OWN, b)}`);
    }, () => admin || page);

    await step(S, 'U3 角色详情 → 语音 of 大肥鱼: 正在用 通用·男 · 来源 自动 · 跟随我的语音包', async () => {
      await admin.evaluate(() => { location.hash = '/characters/dafeiyu-pixel'; });
      await admin.waitForSelector('[data-path="/characters/dafeiyu-pixel"]');
      await admin.getByRole('tab', { name: '语音' }).click();
      await admin.locator('[role="tabpanel"]:not([inert]) [data-voice-pack-current]').waitFor();
      await adminUntil(admin, () => /跟随我的语音包/.test(document.querySelector('[role="tabpanel"]:not([inert]) [data-voice-pack-current]')?.textContent || ''), null, 10000, 'source = 我的语音包');
      await admin.evaluate(() => document.querySelector('[role="tabpanel"]:not([inert]) [data-voice-pack-current]')?.scrollIntoView({ block: 'end' }));
      const cur = (await admin.locator('[role="tabpanel"]:not([inert]) [data-voice-pack-current]').innerText()).replace(/\s+/g, ' ').trim();
      const cb = (await admin.locator('[role="tabpanel"]:not([inert]) [data-voice-pack-select] [role="combobox"]').innerText()).replace(/\s+/g, ' ').trim();
      assert.match(cur, /通用·男/);
      assert.match(cur, /来源 自动 · 跟随我的语音包/);
      assert.match(cb, /^内置（自动 · 跟随我的语音包） · 现在是 通用·男/);
      await shot('u3-character-follows');
      return note(`大肥鱼 语音 tab: ${cur}\npicker: ${cb}`);
    }, () => admin || page);

    await step(S, 'U4 restart: 我的语音包 is kept (settings.json, the page, the pet\'s next line)', async () => {
      await app.close().catch(() => {});
      admin = null;
      ({ app, page } = await launch(env, { video: path.join(SHOTS, 'video-restart') }));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      assert.deepEqual(savedTts(), { voicePack: 'generic-male', voicePackByCharacter: {} });
      const a = await synth(GEN);
      assert.deepEqual([a.provider, a.packId], ['pack', 'generic-male']);
      await openPage();
      const t = await mine();
      assert.match(t, /我的语音包 .*通用男声/);
      assert.match(await combo(), /^通用男声 · /);
      await shot('u4-after-restart');
      return note(`after restart: settings.json tts = ${JSON.stringify(savedTts())}\n我的语音包: ${t}\n${fmtSynth(GEN, a)}`);
    }, () => admin || page);

    await step(S, 'U5 a pick for her beats 我的语音包; removing it brings 我的语音包 back; an unknown pack is refused', async () => {
      const set = await page.evaluate(() => window.pet.setVoicePack('dafeiyu', 'generic-female'));
      assert.equal(set.ok, true);
      const a = await synth(GEN);
      assert.deepEqual([a.packId, set.state.source], ['generic-female', 'user']);
      const back = await page.evaluate(() => window.pet.setVoicePack('dafeiyu', 'auto'));
      const b = await synth(GEN);
      assert.deepEqual([b.packId, back.state.source, back.state.userChoice], ['generic-male', 'default', 'generic-male']);
      const bad = await page.evaluate(() => window.pet.setUserVoicePack('no-such-pack'));
      assert.deepEqual([bad.ok, bad.reason], [false, 'unknown-pack']);
      assert.deepEqual(savedTts(), { voicePack: 'generic-male', voicePackByCharacter: {} });
      return note(`set-voice-pack(dafeiyu, generic-female) → source=${set.state.source}; ${fmtSynth(GEN, a)}\nset-voice-pack(dafeiyu, auto) → source=${back.state.source} userChoice=${back.state.userChoice}; ${fmtSynth(GEN, b)}\nset-user-voice-pack(no-such-pack) → ok=${bad.ok} reason=${bad.reason}\nsettings.json tts = ${JSON.stringify(savedTts())}`);
    }, () => admin || page);

    await step(S, 'U6 pick 通用女声, then 自动: each in force at once; 自动 brings her own pack back', async () => {
      await pick(/^通用女声/);
      await until(/我的语音包.*通用女声/, '我的语音包 = 通用女声');
      assert.deepEqual(savedTts(), { voicePack: 'generic-female', voicePackByCharacter: {} });
      const f = await synth(GEN);
      const fo = await synth(OWN);
      assert.deepEqual([f.provider, f.packId], ['pack', 'generic-female']);
      assert.deepEqual([fo.provider, fo.voiceId], ['minimax', gf.voiceId]);
      const t1 = await mine();
      await shot('u6-picked-generic-female');
      await pick(/^自动/);
      await until(/^我的语音包自动/, '我的语音包 = 自动');
      await until(/（专属 · 自动）/, 'her own pack back');
      assert.deepEqual(savedTts(), { voicePack: 'auto', voicePackByCharacter: {} });
      const a = await synth(OWN);
      assert.deepEqual([a.provider, a.packId], ['pack', 'dafeiyu-minimax']);
      const t2 = await mine();
      await shot('u6-back-to-auto');
      return note(`通用女声: ${t1}\n  ${fmtSynth(GEN, f)}\n  ${fmtSynth(OWN, fo)}\n自动: ${t2}\n  settings.json tts = ${JSON.stringify(savedTts())}; ${fmtSynth(OWN, a)}`);
    }, () => admin || page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'user-voice-pack-log.txt'), evidence.join('\n\n') + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ---------------------------------------------------------------- ivoice
// 互动语音 (core/interaction-voice.js): with 朗读 on, every interaction — 初次见面, 摸摸, 部位触摸, 喂食,
// 玩耍, 哄睡, 拖拽, 甩出, 接住, 关系升级, 切换角色 — asks the engine (the local Fish stand-in) for her line;
// her common lines are synthesised ahead; rapid clicks do not pile up; murmurs only with 朗读碎碎念; and
// with 朗读 off nothing is requested at all.
async function ivoice() {
  const S = 'ivoice';
  const SHOTS = path.join(OUT, 'ivoice');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await ttsMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ivoice-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ivoicefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  // 朗读 is on before she hatches (so 初次见面 is read), with the Fish stand-in and its key as 语音 saves them
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true }, tts: { provider: 'fish', fallback: 'system', endpoints: { fish: mock.url, minimax: '' } } }));
  fs.writeFileSync(path.join(data, 'tts-keys.json'), JSON.stringify({ fish: { plain: mock.KEY } }), { mode: 0o600 });
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video') });
  const shot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const evidence = [];
  const table = [];
  const note = (x) => { evidence.push(x); return x; };
  const slog = () => page.evaluate(() => window.petFx.offerLog());
  const last = () => page.evaluate(() => window.petFx.lastSpeech());
  const engineStats = async () => (await page.evaluate(() => window.pet.getSettings())).ttsStatus.stats;
  const idle = async () => {
    await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return !sp || !/^(queued|synthesizing|playing)$/.test(sp.status); }, null, { timeout: 15000 });
    await page.waitForTimeout(1600); // past the 1.5 s gate
  };
  // run one interaction; it must offer exactly one line of `kind` to the voice, which is said through Fish
  const interact = async (label, kindRe, fn, from = null) => {
    if (!from) await idle();
    const n0 = from ? from.n0 : (await slog()).length;
    const m0 = from ? from.m0 : mock.log.length;
    const s0 = from ? from.s0 : await engineStats();
    await fn();
    await page.waitForFunction(([n, re]) => window.petFx.offerLog().slice(n).some((e) => new RegExp(re).test(e.kind)), [n0, kindRe.source], { timeout: 20000 });
    const entry = (await slog()).slice(n0).find((e) => kindRe.test(e.kind));
    assert.equal(entry.said, true, `${label}: dropped (${entry.dropped})`);
    await page.waitForFunction((n) => { const sp = window.petFx.lastSpeech(); return sp.n !== n || !/^(queued|synthesizing)$/.test(sp.status); }, entry.n, { timeout: 15000 });
    const sp = await last();
    const s1 = await engineStats();
    const live = mock.log.slice(m0).filter((r) => r.text && r.text.endsWith(entry.text));
    const warmed = mock.log.slice(0, m0).filter((r) => r.text && r.text.endsWith(entry.text));
    assert.equal(sp.n, entry.n);
    assert.equal(sp.provider, 'fish', `${label}: ${JSON.stringify(sp)}`);
    assert.ok(live.length || (sp.cached && warmed.length), `${label}: the engine was asked for 「${entry.text}」`);
    const bubble = await bubbleText(page);
    const row = { interaction: label, kind: entry.kind, cls: entry.cls, text: entry.text, bubble, mood: sp.mood, provider: sp.provider, voiceId: sp.voiceId, cached: sp.cached, latencyMs: sp.latencyMs, status: sp.status, ipcRequests: s1.requests - (s1.prewarmed || 0) + s1.hits - s0.requests + (s0.prewarmed || 0) - s0.hits, httpLive: live.length, httpPrewarmed: warmed.length };
    table.push(row);
    return note(`${label}: kind=${row.kind} 「${row.text}」 mood=${row.mood} → fish voice=${row.voiceId} cached=${row.cached} ${row.latencyMs}ms status=${row.status}; engine asked ${row.ipcRequests}× (HTTP now ${row.httpLive}, synthesised ahead ${row.httpPrewarmed}); bubble 「${bubble}」`);
  };
  const petBox = async () => page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
  // 设置窗口 → 朗读 (#/tts), as ⋯ → 设置… opens it: its switches carry their schema key
  let admin = null;
  const openTts = async () => { admin = await openAdminWindow(app, page, 'tts'); await admin.waitForTimeout(250); return admin; };
  const toast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
  const ashot = async (name) => { await admin.waitForTimeout(200); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const prefNow = async (k) => (await page.evaluate(() => window.pet.getSettings())).prefs[k];
  // flip one 朗读 switch in the settings window, as a click; -> once it is saved and the pet window has it
  const flip = async (key, on, label, shotName) => {
    await openTts();
    const sw = admin.locator(`[data-key="prefs.${key}"]`);
    await sw.scrollIntoViewIfNeeded();
    assert.equal(await sw.getAttribute('aria-checked'), String(!on), `${label} was ${on ? 'off' : 'on'}`);
    await ashot(`${shotName}-before`);
    await sw.click();
    await toast(new RegExp(`已保存：${label} → ${on ? '开' : '关'}`));
    await admin.waitForSelector(`[data-key="prefs.${key}"][aria-checked="${on}"]`);
    for (let i = 0; (await prefNow(key)) !== on; i++) { if (i > 50) throw new Error(`prefs.${key} not saved`); await page.waitForTimeout(100); }
    await ashot(shotName);
  };
  try {
    await step(S, 'I0 hatch 大肥鱼 with 朗读 on: 初次见面 (met) is read through Fish', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => window.petFx.offerLog().some((e) => e.kind === 'met'), null, { timeout: 20000 });
      const st = await page.evaluate(() => window.pet.getSettings());
      assert.equal(st.prefs.voice, true);
      assert.equal(st.prefs.voiceInteractions, true);
      assert.equal(st.prefs.voiceMurmurs, false);
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      return await interact('初次见面 met', /^met$/, async () => {}, { n0: 0, m0: 0, s0: { requests: 0, hits: 0 } });
    }, page);
    await shot('i0-met');

    await step(S, 'I1 her common lines are synthesised ahead (prewarm) into the cache', async () => {
      await page.waitForFunction(() => { const p = window.petFx.lastPrewarm(); return p && p.status === 'done'; }, null, { timeout: 60000 });
      const p = await page.evaluate(() => window.petFx.lastPrewarm());
      assert.equal(p.provider, 'fish');
      assert.ok(p.warmed >= 15, `warmed ${p.warmed}`);
      assert.equal(p.failed, null);
      const files = fs.readdirSync(path.join(data, 'tts-cache')).filter((f) => f !== 'index.json');
      return note(`prewarm: ${p.lines} lines → ${p.warmed} synthesised, ${p.cached} already cached, provider ${p.provider}, ${p.ms} ms; tts-cache/ has ${files.length} files; mock requests so far ${mock.log.length}`);
    });

    await step(S, 'I2 部位触摸: real clicks aimed at her head, hands and face — each reads that part\'s touch line', async () => {
      const out = [];
      for (const zone of ['head', 'hands', 'face']) {
        // hover first: the pose under the pointer settles, then the part is found where it is drawn now
        const b = await petBox();
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(600);
        const pts = await zonePoints(page);
        if (!pts[zone]) continue;
        // 大肥鱼's clip moves between frames: the part actually hit is the one her reaction names
        out.push(await interact(`部位触摸 (aimed at ${zone})`, /^touch:[a-z]+$/, () => page.mouse.click(pts[zone].x, pts[zone].y)));
        await shot(`i2-touch-${zone}`);
      }
      assert.ok(out.length >= 2);
      return out.join(' | ');
    }, page);

    await step(S, 'I3 摸摸 (pat): with 部位触摸 off a click on her is the old pat', async () => {
      await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
      await page.waitForFunction(() => window.petFx.speechLog && true);
      await page.waitForTimeout(300);
      const b = await petBox();
      const r = await interact('摸摸 pat', /^pat$/, () => page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.4));
      await shot('i3-pat');
      await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
      return r;
    }, page);

    await step(S, 'I4 喂食: 喂食 → a food from the menu', async () => {
      await page.evaluate(() => window.pet.debugSet({ hunger: 60 }));
      const r = await interact('喂食 feed', /^feed$/, async () => {
        await clickAct(page, 'feed');
        await page.click('#food-menu button');
      });
      await shot('i4-feed');
      return r;
    }, page);

    await step(S, 'I5 玩耍: the 玩耍 button', async () => {
      await page.evaluate(() => window.pet.debugSet({ energy: 80 }));
      const r = await interact('玩耍 play', /^play$/, () => clickAct(page, 'play'));
      await shot('i5-play');
      return r;
    }, page);

    await step(S, 'I6 拖拽: dragging her lifts her and she says her lift line', async () => {
      await page.mouse.move(300, 300);
      await page.waitForTimeout(400);
      const b = await petBox();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      const r = await interact('拖拽 lift', /^lift$/, async () => {
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx + 12, cy - 8, { steps: 4 });
        await page.waitForFunction(() => window.petFx.state().state === 'lifted', null, { timeout: 3000 });
      });
      await shot('i6-lift');
      await page.waitForTimeout(300);
      await page.mouse.up();
      return r;
    }, page);

    await step(S, 'I7 甩出: a fast drag and let go throws her; she says her throw line', async () => {
      await page.waitForFunction(() => !window.petFx.state().flying, null, { timeout: 10000 });
      const r = await interact('甩出 throw', /^throw$/, async () => {
        await page.waitForTimeout(400);
        const b = await petBox();
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) await page.mouse.move(cx - i * 25, cy - i * 18);
        await page.mouse.up();
        await page.waitForFunction(() => window.petFx.state().flying, null, { timeout: 2000 });
      });
      await shot('i7-throw');
      await page.waitForFunction(() => !window.petFx.state().flying, null, { timeout: 15000 });
      return r;
    }, page);

    await step(S, 'I8 接住: pressing her while she flies catches her; she says her catch line', async () => {
      const r = await interact('接住 catch', /^catch$/, async () => {
        page.evaluate(() => window.petFx.throw(-900, -1500));
        await page.waitForFunction(() => window.petFx.state().flying, null, { timeout: 2000 });
        await page.waitForTimeout(120);
        await page.locator('#pet-body .pet-hit:not(.hidden)').dispatchEvent('pointerdown', { button: 0, pointerId: 3, pointerType: 'mouse', isPrimary: true });
      });
      await shot('i8-catch');
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 3, pointerType: 'mouse' })));
      return r;
    }, page);

    await step(S, 'I9 关系升级 stage_up: enough affection for the next stage — her stage-up line is read', async () => {
      const v = await view(page);
      const r = await interact('关系升级 stage_up', /^stage_up$/, () => page.evaluate(() => window.pet.debugSet({ affection: 40 })));
      const v2 = await view(page);
      await shot('i9-stage-up');
      return `${v.pet.relStage} → ${v2.pet.relStage}; ${r}`;
    }, page);

    await step(S, 'I10 哄睡: the 睡觉 button', async () => {
      const r = await interact('哄睡 sleep', /^sleep$/, () => clickAct(page, 'sleep'));
      await shot('i10-sleep');
      return r;
    }, page);

    // Every character has her own agent (#51): meeting 克洛蒂 the first time is her hello (met); going back to
    // one met before is 切换角色 (switch). Both are read in her own Fish voice.
    await step(S, 'I11 切换角色: 设置 → 角色 → 克洛蒂 (switch-character) — her hello, then her greeting on coming back, read in her own Fish voice', async () => {
      const toClaude = async () => {
        const r = await page.evaluate(() => window.pet.switchCharacter('claude', ''));
        assert.equal(r.ok, true, JSON.stringify(r));
      };
      const r1 = await interact('初次见面 克洛蒂 met', /^met$/, toClaude);
      let sp = await last();
      assert.equal(sp.species, 'claude');
      assert.equal(sp.voiceId, 'faccba1a8ac54016bcfc02761285e67f');
      await shot('i11-met');
      await idle();
      await page.evaluate(() => window.pet.switchCharacter('dafeiyu'));
      await page.waitForTimeout(800);
      const r2 = await interact('切换角色 switch', /^switch$/, toClaude);
      sp = await last();
      assert.equal(sp.species, 'claude');
      assert.equal(sp.voiceId, 'faccba1a8ac54016bcfc02761285e67f');
      await shot('i11-switch');
      return `${r1} || ${r2}`;
    }, page);

    await step(S, 'I12 rapid clicks: 8 clicks in 0.8 s — the bubble follows every one, the voice says one line, nothing piles up', async () => {
      await idle();
      // a stage-up toast from meeting her stays up to 30 s over her head (no in-pet panel closes it any more): close it like the owner would
      if (await page.isVisible('#unlock-toast')) await page.click('#toast-close');
      const pts = await zonePoints(page);
      const n0 = (await slog()).length;
      const m0 = mock.log.length;
      const s0 = await engineStats();
      const bubbles = [];
      for (let i = 0; i < 8; i++) {
        const z = ['head', 'hands'][i % 2];
        await page.mouse.click(pts[z].x, pts[z].y);
        await page.waitForTimeout(100);
        bubbles.push(await bubbleText(page));
      }
      await page.waitForTimeout(1500);
      const got = (await slog()).slice(n0);
      const said = got.filter((e) => e.said);
      const s1 = await engineStats();
      const gate = await page.evaluate(() => window.petFx.speechGate());
      await shot('i12-rapid');
      assert.equal(got.length, 8, 'every click offered its line');
      assert.equal(said.length, 1, `said: ${said.map((e) => e.text).join(', ')}`);
      assert.equal(s1.requests + s1.hits - s0.requests - s0.hits, 1, 'one request to the engine');
      return note(`8 clicks → ${got.length} lines offered, ${said.length} said (「${said[0].text}」), dropped: ${got.filter((e) => !e.said).map((e) => e.dropped).join(',')}; engine asked ${s1.requests + s1.hits - s0.requests - s0.hits}×, HTTP ${mock.log.length - m0}; gate ${JSON.stringify(gate)}; bubbles changed ${new Set(bubbles).size}×`);
    }, page);

    await step(S, 'I13 碎碎念: not read by default; read after switching on 朗读碎碎念 in 设置窗口 → 朗读', async () => {
      await idle();
      const murmur = async () => {
        const n0 = (await slog()).length;
        await page.evaluate(async () => { await window.pet.debugSet({ hunger: 95, lastSpokeAt: 0, sleeping: false }); await window.pet.debugHeartbeat(); });
        await page.waitForFunction(() => document.getElementById('bubble').dataset.kind === 'hungry', null, { timeout: 15000 });
        await page.waitForTimeout(500);
        return (await slog()).slice(n0);
      };
      const before = await murmur();
      assert.equal(before.length, 0, 'a murmur is not offered to the voice by default');
      await flip('voiceMurmurs', true, '朗读碎碎念', 'i13-murmur-switch-on');
      await page.waitForTimeout(1700);
      const after = await murmur();
      assert.equal(after.length, 1);
      assert.equal(after[0].said, true);
      await page.waitForFunction(() => !/^(queued|synthesizing)$/.test(window.petFx.lastSpeech().status), null, { timeout: 15000 });
      const sp = await last();
      assert.equal(sp.kind, 'hungry');
      assert.equal(sp.provider, 'fish');
      return note(`murmur with 朗读碎碎念 off: offered ${before.length}; on: 「${after[0].text}」 said via ${sp.provider} (${sp.status})`);
    }, page);

    await step(S, 'I13b 静音 (toolbar speaker): one click silences the reading line, interactions and the click sound; a second click brings them back', async () => {
      await idle();
      await page.evaluate(() => window.pet.setPrefs({ clickSound: true, touchZones: false }));
      await page.waitForTimeout(300);
      await hover(page);
      const btn = page.locator('#btn-mute');
      assert.equal(await btn.getAttribute('aria-pressed'), 'false', 'starts un-muted');
      await page.locator('#toolbar').screenshot({ path: path.join(SHOTS, 'i13b-toolbar-sound-on.png') });
      // a long reply is being read when the speaker is clicked: it stops at once
      mock.perCharMs = 300; // long enough to click the speaker while she is still reading
      await page.evaluate(() => { window.petFx.speak('今天天气真好。我们一起出去走走吧。路上还可以买点好吃的。回来再一起看书。'); }); // not awaited: speak() resolves once she has finished
      const samples = [];
      for (let i = 0; ; i++) {
        const st = await page.evaluate(() => { const sp = window.petFx.lastSpeech(); return { kind: sp && sp.kind, status: sp && sp.status, cur: sp && sp.current, s: sp && sp.sentences.map((x) => x.status).join(','), audio: window.petFx.audioState() }; });
        samples.push(st);
        if (st.kind === 'api' && st.audio && !st.audio.paused) break;
        if (i > 150) throw new Error(`reply not playing: ${JSON.stringify(samples.slice(-3))}`);
        await page.waitForTimeout(100);
      }
      const reading = await last();
      await btn.click();
      await page.waitForFunction(() => document.getElementById('btn-mute').getAttribute('aria-pressed') === 'true', null, { timeout: 3000, polling: 50 });
      const stopped = await page.evaluate((n) => ({ sp: window.petFx.lastSpeech(), audio: window.petFx.audioState(), stop: window.petFx.speechLog().find((e) => e.n === n && e.event === 'stop') }), reading.n);
      mock.perCharMs = 0;
      assert.equal(stopped.sp.status, 'interrupted', JSON.stringify(stopped.sp));
      assert.equal(stopped.stop && stopped.stop.why, 'muted');
      assert.equal(stopped.audio, null, 'nothing playing');
      assert.equal(await prefNow('muted'), true);
      assert.equal(await prefNow('voice'), true, '朗读回复 left as it was');
      const label = await btn.getAttribute('aria-label');
      await page.locator('#toolbar').screenshot({ path: path.join(SHOTS, 'i13b-toolbar-muted.png') });
      // muted: pat + 玩耍 + a reply — the bubble shows each line, nothing is offered to the voice, no click sound
      await page.waitForTimeout(1600);
      const n0 = (await slog()).length;
      const m0 = mock.log.length;
      const snd0 = (await page.evaluate(() => window.petFx.stats())).sounds;
      const b = await petBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.4);
      await page.waitForFunction(() => document.getElementById('bubble').dataset.kind === 'pat', null, { timeout: 15000 });
      await page.evaluate(() => window.pet.debugSet({ energy: 80 }));
      await clickAct(page, 'play');
      await page.waitForFunction(() => document.getElementById('bubble').dataset.kind === 'play', null, { timeout: 15000 });
      await page.evaluate(() => window.petFx.speak('一句回复'));
      await page.waitForTimeout(1500);
      await shot('i13b-muted-play');
      const got = (await slog()).slice(n0);
      const snd1 = (await page.evaluate(() => window.petFx.stats())).sounds;
      assert.equal(got.length, 0, `offered while muted: ${JSON.stringify(got)}`);
      assert.equal(mock.log.length, m0, 'no HTTP request while muted');
      assert.equal(snd1, snd0, 'no click sound while muted');
      // un-mute from the same button: the next interaction is read again and the click sound is back
      await hover(page);
      await btn.click();
      await page.waitForFunction(() => document.getElementById('btn-mute').getAttribute('aria-pressed') === 'false', null, { timeout: 3000 });
      assert.equal(await prefNow('muted'), false);
      await page.waitForTimeout(1600);
      const r = await interact('静音后恢复 pat', /^pat$/, async () => { const bb = await petBox(); await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height * 0.4); });
      const snd2 = (await page.evaluate(() => window.petFx.stats())).sounds;
      assert.ok(snd2 > snd1, `click sound back (${snd1} → ${snd2})`);
      return note(`静音: reading #${reading.n} stopped (why=muted), button aria-label「${label}」, prefs.voice stays on; muted pat + play + reply → offered ${got.length}, HTTP ${m0} → ${mock.log.length}, click sounds ${snd0} → ${snd1}; un-muted → ${r}; click sounds ${snd1} → ${snd2}`);
    }, page);

    mock.perCharMs = 0;
    await page.evaluate(() => window.pet.setPrefs({ muted: false, clickSound: false, touchZones: true }));

    await step(S, 'I14 关掉 朗读回复: every interaction again — no line offered, no request to any engine', async () => {
      await idle();
      await flip('voice', false, '朗读回复', 'i14-voice-off');
      await page.waitForTimeout(500);
      const n0 = (await slog()).length;
      const m0 = mock.log.length;
      const s0 = await engineStats();
      const kinds = [];
      const sawLine = async (k) => { await page.waitForFunction((kk) => document.getElementById('bubble').dataset.kind.startsWith(kk), k, { timeout: 15000 }); kinds.push(await page.evaluate(() => document.getElementById('bubble').dataset.kind)); await page.waitForTimeout(600); };
      let b = await petBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.waitForTimeout(600);
      const pts = await zonePoints(page);
      await page.mouse.click(pts.head.x, pts.head.y); await sawLine('touch:');
      await page.evaluate(() => window.pet.setPrefs({ touchZones: false })); await page.waitForTimeout(300);
      b = await petBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.4); await sawLine('pat');
      await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
      await page.evaluate(() => window.pet.debugSet({ hunger: 60, energy: 80 }));
      await clickAct(page, 'feed'); await page.click('#food-menu button'); await sawLine('feed');
      await clickAct(page, 'play'); await sawLine('play');
      await page.mouse.move(300, 300); await page.waitForTimeout(400);
      b = await petBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + 12, b.y + b.height / 2 - 8, { steps: 4 });
      await page.waitForFunction(() => window.petFx.state().state === 'lifted', null, { timeout: 3000 }); kinds.push('lift(dragged)');
      await page.waitForTimeout(300); await page.mouse.up();
      page.evaluate(() => window.petFx.throw(-900, -1500)); await page.waitForFunction(() => window.petFx.state().flying, null, { timeout: 2000 }); kinds.push('throw(flying)');
      await page.waitForTimeout(120);
      await page.locator('#pet-body .pet-hit:not(.hidden)').dispatchEvent('pointerdown', { button: 0, pointerId: 4, pointerType: 'mouse', isPrimary: true });
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4, pointerType: 'mouse' }))); kinds.push('catch(caught)');
      await page.waitForTimeout(800);
      await page.evaluate(() => window.pet.debugSet({ affection: 90 })); await sawLine('stage_up');
      await clickAct(page, 'sleep'); await sawLine('sleep');
      await page.evaluate(() => window.pet.switchCharacter('dafeiyu')); await sawLine('switch');
      await page.evaluate(async () => { await window.pet.debugSet({ hunger: 95, lastSpokeAt: 0, sleeping: false }); await window.pet.debugHeartbeat(); }); await sawLine('hungry');
      await page.evaluate(() => window.petFx.speak('一句回复'));
      await page.waitForTimeout(2500);
      const got = (await slog()).slice(n0);
      const s1 = await engineStats();
      const audio = await page.evaluate(() => window.petFx.audioState());
      const pw = await page.evaluate(() => window.petFx.lastPrewarm());
      await shot('i14-silent-after');
      assert.equal(got.length, 0, `offered: ${JSON.stringify(got)}`);
      assert.equal(mock.log.length, m0, 'no HTTP request');
      assert.equal(s1.requests + s1.hits, s0.requests + s0.hits, 'no engine call');
      assert.equal(audio, null, 'nothing playing');
      return note(`朗读 off; interactions run: ${kinds.join(', ')}, + a reply; lines offered to the voice ${got.length}; HTTP requests ${m0} → ${mock.log.length}; engine calls ${s0.requests + s0.hits} → ${s1.requests + s1.hits}; audio element ${JSON.stringify(audio)}; last prewarm still ${pw && pw.sig.split('|')[4]} (no new prewarm)`);
    }, page);
  } finally {
    const md = ['| 互动 | kind | 台词 | 气泡 | mood | 引擎 | 音色 | 缓存 | 延迟 ms | 状态 | 引擎调用 | HTTP 现场 | HTTP 预合成 |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|', ...table.map((r) => `| ${r.interaction} | ${r.kind} | ${r.text} | ${r.bubble} | ${r.mood} | ${r.provider} | ${r.voiceId} | ${r.cached} | ${r.latencyMs} | ${r.status} | ${r.ipcRequests} | ${r.httpLive} | ${r.httpPrewarmed} |`)].join('\n');
    fs.writeFileSync(path.join(SHOTS, 'ivoice-table.md'), md + '\n');
    fs.writeFileSync(path.join(SHOTS, 'ivoice-log.txt'), evidence.join('\n') + '\n\nspeech log (renderer):\n' + (await slog().catch(() => [])).map((e) => JSON.stringify(e)).join('\n') + '\n\nmock requests:\n' + mock.log.map((r) => JSON.stringify({ ...r, at: undefined })).join('\n') + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ------------------------------------------------------------ chatvoice
// 对话语音: her chat replies (fake lh echoes the message) read aloud through the TTS engine (the local
// Fish stand-in, audio as long as the line): a multi-sentence reply is read whole and in order with the
// filtering kept, the bubble marks the sentence being read, and a new message or 朗读 off stops it at once.
async function chatvoice() {
  const S = 'chatvoice';
  const SHOTS = path.join(OUT, 'chatvoice');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await ttsMock();
  mock.perCharMs = 160;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chatvoice-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chatvoicefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video') });
  const t0 = Date.now();
  const chapters = [];
  const chapter = (title) => chapters.push({ at: Math.round((Date.now() - t0) / 1000), title });
  const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const evidence = [];
  const note = (s) => { evidence.push(s); return s; };
  const last = () => page.evaluate(() => window.petFx.lastSpeech());
  const log = (n) => page.evaluate((k) => window.petFx.speechLog().filter((e) => e.n === k), n);
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  // type a message in the chat box and send it, as the owner would
  const send = async (text) => {
    if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
    await page.fill('#chat-input', text);
    await page.press('#chat-input', 'Enter');
  };
  // the reading that starts after `prev`, once it has started its sentence `i`
  const readingAt = (prev, i) => page.waitForFunction(([p, k]) => { const sp = window.petFx.lastSpeech(); return sp && sp.n > p && sp.current >= k && /^(playing|speaking)$/.test(sp.status); }, [prev, i], { timeout: 20000 }).then(last);
  const fmtLog = (es) => es.map((e) => `${String(e.at).padStart(7)}ms #${e.n} ${e.event}${e.i == null ? '' : ` [${e.i}] 「${e.text}」`}${e.status ? ` ${e.status}` : ''}${e.why ? ` why=${e.why}` : ''}${e.provider !== undefined ? ` provider=${e.provider}` : ''}`).join('\n');
  // sample, every 100 ms, which sentence is read and which one the bubble marks
  const sampleSync = () => page.evaluate(() => {
    window.__sync = [];
    window.__syncTimer = setInterval(() => {
      const sp = window.petFx.lastSpeech();
      const b = document.getElementById('bubble');
      const mark = b.querySelector('.sentence.reading');
      if (sp && /^(playing|speaking)$/.test(sp.status)) window.__sync.push({ at: Math.round(performance.now()), audioAt: window.petFx.audioState() ? Math.round(window.petFx.audioState().currentTime * 1000) : null, n: sp.n, i: sp.current, reading: sp.sentences[sp.current].text, marked: mark ? Number(mark.dataset.i) : null, markedText: mark ? mark.textContent : null, bubbleShown: !b.classList.contains('hidden') });
    }, 100);
  });
  const stopSample = () => page.evaluate(() => { clearInterval(window.__syncTimer); return window.__sync; });
  // 设置窗口 → 朗读 (#/tts), as ⋯ → 设置… opens it: controls by their schema key
  let admin = null;
  const toast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
  try {
    await step(S, 'C0 hatch 大肥鱼, switch 朗读 on and give Fish Audio its endpoint and key in 设置窗口 → 朗读', async () => {
      chapter('孵化大肥鱼，打开朗读并配置 Fish Audio');
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await idle();
      await clickAct(page, 'settings'); // ⚙ 设置 opens the settings window (at 小屋); then its 朗读 page
      admin = await openAdminWindow(app, page, 'overview'); // let it load first: a route sent while it loads is lost
      admin = await openAdminWindow(app, page, 'tts');
      await admin.click('[data-key="prefs.voice"]');
      await toast(/已保存：朗读回复 → 开/);
      await admin.waitForSelector('[data-key="prefs.voice"][aria-checked="true"]');
      await admin.fill('[data-key="tts.endpoints.fish"]', mock.url);
      await admin.click('[data-save="tts.endpoints.fish"]');
      await toast(/已保存：端点 → http:\/\/127\.0\.0\.1/);
      await admin.fill('[data-key="keys.fish"]', mock.KEY);
      await admin.click('[data-save="keys.fish"]');
      await admin.waitForFunction(() => document.querySelector('[data-has-key="keys.fish"]').textContent.includes('已设置'));
      await admin.screenshot({ path: path.join(SHOTS, 'c0-voice-on-fish-configured.png') });
      const st = await page.evaluate(async () => (await window.pet.getSettings()));
      assert.equal(st.prefs.voice, true);
      assert.equal(st.tts.endpoints.fish, mock.url);
      assert.equal(st.ttsStatus.engines.fish.hasKey, true);
      assert.equal(st.tts.provider, 'auto'); // 大肥鱼's MiniMax has no key here: her lines go to Fish
      return note(`prefs.voice=${st.prefs.voice} tts=${JSON.stringify(st.tts)}`);
    }, () => admin || page);

    const MSG1 = '第一句，我们先打个招呼。第二句（笑着眨眨眼。）说说今天的天气真好！第三句😀你想不想去公园散步？第四句[梗图:cheer]那就这么说定了 https://example.com/park 。';
    const WANT1 = ['echo: 第一句，我们先打个招呼。', '第二句 说说今天的天气真好！', '第三句你想不想去公园散步？', '第四句那就这么说定了 。']; // the meme tag never reaches the bubble (core/memes.js), the link is not read
    let first = null;
    await step(S, 'C1 a four-sentence chat reply is read whole, sentence by sentence in order, filtered, through Fish', async () => {
      chapter('C1 发一条消息：四句回复按句、按顺序完整朗读');
      // 互动语音 synthesises her common lines ahead once Fish has a key; let that finish so the mock log holds only the reply
      await prewarmed(page);
      const before = mock.log.length;
      await sampleSync();
      await send(MSG1);
      const sp = await readingAt(0, 1);
      await page.waitForTimeout(400);
      await shot('c1-reading-sentence-2');
      await page.waitForFunction((n) => { const r = window.petFx.lastSpeech(); return r.n === n && r.status === 'done'; }, sp.n, { timeout: 30000 });
      const sync = await stopSample();
      first = await last();
      const es = await log(first.n);
      const reqs = mock.log.slice(before);
      const seen = [...new Set(sync.filter((x) => x.n === first.n).map((x) => `${x.i}:${x.marked}`))];
      // every sample while she read: renderer time, position in the sentence's audio, the sentence read, the one the bubble marks
      fs.writeFileSync(path.join(SHOTS, 'c1-bubble-sync.txt'), `# bubble text\n${await page.textContent('#bubble')}\n\n# every 100 ms while reading #${first.n}: time | audio position | sentence read → sentence marked in the bubble\n${sync.filter((x) => x.n === first.n).map((x) => `${String(x.at).padStart(7)}ms  audio ${String(x.audioAt).padStart(5)}ms  read [${x.i}]「${x.reading}」 → marked [${x.marked}]「${x.markedText}」 bubble ${x.bubbleShown ? 'shown' : 'HIDDEN'}`).join('\n')}\n`);
      const bubble = await page.textContent('#bubble');
      fs.writeFileSync(path.join(SHOTS, 'c1-speech-log.txt'), `# reply in the bubble\n${bubble}\n\n# sentences read (petFx.lastSpeech().sentences)\n${first.sentences.map((s) => `[${s.i}] ${s.status} ${s.provider} 「${s.text}」`).join('\n')}\n\n# speech log (renderer clock)\n${fmtLog(es)}\n\n# mock Fish requests\n${reqs.map((r) => JSON.stringify({ text: r.text, voice: r.voice, status: r.status, aborted: r.aborted, audioMs: r.audioMs, at: r.at - t0 })).join('\n')}\n\n# bubble sync samples (sentence read → sentence marked)\n${seen.join(', ')} over ${sync.length} samples\n`);
      assert.deepEqual(first.sentences.map((s) => s.text), WANT1, 'sentences, with emoji / stage direction / meme tag / link removed');
      assert.deepEqual(first.sentences.map((s) => s.status), ['done', 'done', 'done', 'done']);
      assert.deepEqual(first.sentences.map((s) => s.provider), ['fish', 'fish', 'fish', 'fish']);
      assert.deepEqual(es.filter((e) => e.event === 'start').map((e) => e.i), [0, 1, 2, 3], 'read in order');
      assert.deepEqual(es.map((e) => `${e.event}${e.i == null ? '' : e.i}`), ['begin', 'start0', 'done0', 'start1', 'done1', 'start2', 'done2', 'start3', 'done3', 'end'], 'one sentence at a time, each to its end');
      assert.deepEqual(reqs.map((r) => r.text.replace(/^\[[^\]]*\]/, '')), WANT1, 'one request per sentence, in order (after her mood tag, core/tts.js)');
      assert.ok(reqs.every((r) => !r.aborted && r.status === 200));
      for (let i = 0; i < 4; i++) {
        const st = es.find((e) => e.event === 'start' && e.i === i).at;
        const dn = es.find((e) => e.event === 'done' && e.i === i).at;
        assert.ok(dn - st >= reqs[i].audioMs - 150, `sentence ${i} played ${dn - st} ms of ${reqs[i].audioMs} ms`);
      }
      // the bubble marked the sentence being read, all the way through, and stayed up while she read
      assert.deepEqual(seen, ['0:0', '1:1', '2:2', '3:3']);
      assert.ok(sync.filter((x) => x.n === first.n).every((x) => x.bubbleShown));
      assert.equal(bubble, `echo: ${MSG1.replace('[梗图:cheer]', '')}`, 'the bubble still shows the whole reply as written');
      return note(`#${first.n}: ${first.sentences.map((s) => `[${s.i}]「${s.text}」${s.status}`).join(' → ')}; Fish requests in order: ${reqs.map((r) => `「${r.text}」${r.audioMs}ms`).join(', ')}; bubble marks ${seen.join(' ')}`);
    }, page);

    await step(S, 'C2 a new message stops the reply still being read at once; the new reply is read instead', async () => {
      await idle();
      chapter('C2 朗读中途发新消息：旧朗读立即停止');
      const MSG2 = '这是一段很长的回复的第一句话。这是第二句话，还没读完就会被打断。这是第三句话，它不应该被读出来。这是第四句话，同样不该读出来。';
      await send(MSG2);
      const old = await readingAt(first.n, 1);
      await page.waitForTimeout(500);
      await shot('c2-old-reply-reading-sentence-2');
      const audioBefore = await page.evaluate(() => window.petFx.audioState());
      const tSend = await page.evaluate(() => Math.round(performance.now()));
      await send('换个话题吧。新的回复只有两句。');
      const after = await page.evaluate((n) => { const sp = window.petFx.lastSpeech(); return { audio: window.petFx.audioState(), stop: window.petFx.speechLog().find((e) => e.n === n && e.event === 'stop') }; }, old.n);
      await page.waitForTimeout(150);
      await shot('c2-new-reply-reading');
      const fresh = await readingAt(old.n, 0);
      await page.waitForFunction((n) => { const r = window.petFx.lastSpeech(); return r.n === n && r.status === 'done'; }, fresh.n, { timeout: 30000 });
      const done = await last();
      const es = await log(old.n);
      const oldStarts = es.filter((e) => e.event === 'start').map((e) => e.i);
      assert.ok(after.stop, 'the old reading was stopped');
      assert.equal(after.stop.why, 'new-message');
      assert.ok(after.stop.at - tSend < 300, `stopped ${after.stop.at - tSend} ms after the send`);
      assert.equal(after.audio, null, 'no audio element left playing');
      assert.deepEqual(oldStarts, [0, 1], 'sentences 3 and 4 of the old reply were never read');
      assert.equal(es.find((e) => e.event === 'stop').i, 1);
      assert.equal(es.some((e) => e.event === 'end'), false);
      assert.deepEqual(done.sentences.map((s) => s.text), ['echo: 换个话题吧。', '新的回复只有两句。']);
      assert.deepEqual(done.sentences.map((s) => s.status), ['done', 'done']);
      const bare = (r) => (r.text || '').replace(/^\[[^\]]*\]/, '');
      const third = mock.log.find((r) => bare(r) === '这是第三句话，它不应该被读出来。');
      const fourth = mock.log.find((r) => bare(r) === '这是第四句话，同样不该读出来。');
      assert.equal(fourth, undefined, 'the fourth sentence was never even requested');
      const all = await page.evaluate((n) => window.petFx.speechLog().filter((e) => e.n >= n), old.n);
      fs.writeFileSync(path.join(SHOTS, 'c2-speech-log.txt'), `# owner sent a new message at ${tSend}ms while sentence [1] of #${old.n} was playing (audio ${JSON.stringify(audioBefore)})\n# right after: audio=${JSON.stringify(after.audio)} stop=${JSON.stringify(after.stop)}\n\n${fmtLog(all)}\n\n# mock Fish requests for the old reply\n${mock.log.filter((r) => /这是/.test(r.text || '')).map((r) => JSON.stringify({ text: r.text, status: r.status, aborted: r.aborted })).join('\n')}\n`);
      return note(`old #${old.n} read [${oldStarts.join(',')}] then stop why=${after.stop.why} ${after.stop.at - tSend} ms after Enter, audio after=${JSON.stringify(after.audio)}; sentence 3 ${third ? `prefetched (aborted=${third.aborted}), never played` : 'never requested'}; sentence 4 never requested; new #${done.n}: ${done.sentences.map((s) => `「${s.text}」${s.status}`).join(' → ')}`);
    }, page);

    // 对话语音 × 互动语音 (#50 + #52): a click on her while a reply is read changes the bubble but does not
    // cut the reply short — the gate drops her interaction line (busy) and the reply is read to its end.
    await step(S, 'C4 touching her while a reply is read: the interaction line is dropped (busy), the reply is read to its end', async () => {
      await idle();
      chapter('C4 朗读回复时摸她：互动台词不插队，回复读完');
      const prevN = (await last()).n;
      await send('边读边摸的第一句话。边读边摸的第二句话。边读边摸的第三句话。');
      const sp = await readingAt(prevN, 0);
      const o0 = (await page.evaluate(() => window.petFx.offerLog())).length;
      const b = await page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
      await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.4);
      await page.waitForFunction((n) => window.petFx.offerLog().length > n, o0, { timeout: 5000 });
      await page.waitForTimeout(300);
      await shot('c4-touched-while-reading');
      const offer = (await page.evaluate(() => window.petFx.offerLog())).slice(o0).find((e) => e.cls === 'interaction');
      const mid = await last();
      const bubble = await page.textContent('#bubble');
      await page.waitForFunction((n) => { const r = window.petFx.lastSpeech(); return r.n !== n || !/^(queued|synthesizing|playing|speaking)$/.test(r.status); }, sp.n, { timeout: 30000 });
      const done = await last();
      const es = await log(sp.n);
      fs.writeFileSync(path.join(SHOTS, 'c4-speech-log.txt'), `# clicked her while #${sp.n} was reading sentence [${mid.current}]\n# offered: ${JSON.stringify(offer)}\n# bubble after the click: ${bubble}\n\n${fmtLog(es)}\n`);
      assert.ok(offer, 'the click offered an interaction line to the voice');
      assert.equal(offer.said, false, 'the interaction line was not said over the reply');
      assert.equal(offer.dropped, 'busy');
      assert.equal(mid.n, sp.n, 'the reply is still the line being read');
      assert.equal(done.n, sp.n);
      assert.equal(done.status, 'done', `reply ended ${done.status} (${done.stoppedBy || ''})`);
      assert.deepEqual(done.sentences.map((s) => s.status), ['done', 'done', 'done']);
      return note(`#${sp.n} reading [${mid.current}] when clicked → offered ${offer.kind} 「${offer.text}」 said=${offer.said} dropped=${offer.dropped}; bubble 「${bubble}」; reply ${done.sentences.map((s) => `[${s.i}]${s.status}`).join(' ')} status=${done.status}`);
    }, page);

    await step(S, 'C3 switching 朗读 off while she reads stops the voice at once', async () => {
      await idle();
      chapter('C3 朗读中关闭“朗读回复”：立即停止');
      const prevN = (await last()).n;
      await send('关掉之前的第一句话。关掉之前的第二句话。关掉之前的第三句话。');
      const sp = await readingAt(prevN, 0);
      await page.waitForTimeout(300);
      admin = await openAdminWindow(app, page, 'tts'); // the settings window (still open from C0) on 朗读
      const reading = await last();
      assert.ok(/^(playing|speaking)$/.test(reading.status), `still reading while the settings window is up: ${reading.status}`);
      assert.equal(reading.n, sp.n);
      const tClick = Date.now();
      await admin.click('[data-key="prefs.voice"]');
      await page.waitForFunction((n) => { const x = window.petFx.lastSpeech(); return x.n === n && !/^(playing|speaking)$/.test(x.status); }, sp.n, { timeout: 2000 });
      const stopMs = Date.now() - tClick;
      const r = await last();
      const es = await log(sp.n);
      await toast(/已保存：朗读回复 → 关/);
      await admin.waitForSelector('[data-key="prefs.voice"][aria-checked="false"]');
      await shot('c3-voice-off-stopped');
      await admin.screenshot({ path: path.join(SHOTS, 'c3-voice-off-switch.png') });
      assert.equal(r.status, 'interrupted');
      assert.equal(r.stoppedBy, 'voice-off');
      assert.equal(await page.evaluate(() => window.petFx.audioState()), null);
      assert.equal((await page.evaluate(() => window.pet.getSettings())).prefs.voice, false);
      await page.waitForTimeout(1500);
      assert.equal((await log(sp.n)).length, es.length, 'nothing more was read after');
      fs.writeFileSync(path.join(SHOTS, 'c3-speech-log.txt'), fmtLog(es) + '\n');
      return note(`#${sp.n} read [${es.filter((e) => e.event === 'start').map((e) => e.i).join(',')}] of ${sp.sentences.length}, then 朗读 off in the settings window → status=${r.status} stoppedBy=${r.stoppedBy} ${stopMs} ms after the click, audio=null, nothing more read in 1.5 s`);
    }, page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'chatvoice-log.txt'), evidence.join('\n\n') + '\n');
    fs.writeFileSync(path.join(SHOTS, 'chapters.json'), JSON.stringify(chapters, null, 2) + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ------------------------------------------------------------------ history
// ⋯ → 聊天记录: after a greeting, a proactive line, a stage-up, a touch and a feed, plus one message the
// owner sends from the chat box, the history lists only the owner's conversation (filtered in main).
async function history() {
  const S = 'history';
  const SHOTS = path.join(OUT, 'history');
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-history-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-historyfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  const video = process.env.PIXELPET_E2E_VIDEO ? path.join(SHOTS, 'video') : null;
  let { app, page } = await launch(env, { video });
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  const logged = () => JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8')).messages;
  // 聊天记录 lives in the settings window now (玩法 → 和她一起 → 聊天记录, T-2718)
  let admin = null;
  const openHistory = async () => {
    admin = await openAdminWindow(app, page, 'history');
    await admin.evaluate(() => { location.hash = '/overview'; });
    await admin.evaluate(() => { location.hash = '/history'; }); // mounted again: the list is read afresh
    await adminUntil(admin, () => !!document.querySelector('[data-history-empty], [data-session]'), null, 15000, '聊天记录');
  };
  const shotAdmin = (n) => admin.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  const items = () => admin.evaluate(() => [...document.querySelectorAll('[data-session]')].map((b) => ({ time: b.querySelector('[data-history-time]').textContent, who: b.querySelector('[data-history-who]').textContent, count: b.querySelector('[data-history-count]').textContent.trim(), preview: b.querySelector('[data-history-preview]').textContent })));
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="claude"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();

    await step(S, 'H1 设置 → 聊天记录 opens; with only her greeting so far it shows the empty state', async () => {
      await openHistory();
      const empty = await admin.evaluate(() => document.querySelector('[data-history-empty]')?.innerText || '');
      assert.match(empty, /还没有你主动发起的聊天/);
      assert.equal(await admin.locator('[data-session]').count(), 0);
      assert.ok(logged().some((m) => m.origin === 'greeting' && m.kind === 'met'), 'the greeting was logged (origin greeting)');
      await shotAdmin('h1-empty');
      return `empty state: 「${empty.trim().slice(0, 40)}」 while chat-log.json holds ${logged().length} system message(s)`;
    }, () => admin);

    await step(S, 'H2 system lines happen: touch, feed, a proactive "hungry" line and a stage-up', async () => {
      await page.bringToFront();
      await page.evaluate(() => window.pet.touch('head'));
      await page.evaluate(() => window.pet.act('feed', 'rice'));
      await page.evaluate(() => window.pet.debugSet({ hunger: 90, lastSpokeAt: 0 }));
      await page.evaluate(() => window.pet.debugHeartbeat());
      await idle();
      await page.waitForFunction(() => /\[事件\]/.test(document.getElementById('bubble').textContent), null, { timeout: 10000 });
      const proactive = await bubbleText(page);
      await shot('h2-proactive-bubble');
      await page.evaluate(() => window.pet.debugSet({ affection: 20 }));
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 }).catch(() => {});
      await idle();
      const origins = logged().map((m) => m.origin);
      for (const o of ['greeting', 'touch', 'care', 'proactive', 'emotion']) assert.ok(origins.includes(o), `${o} logged: ${origins.join(',')}`);
      assert.ok(!origins.includes('user'));
      return `bubble 「${proactive.slice(0, 50)}」; chat-log origins: ${origins.join(', ')}`;
    }, page);

    await step(S, 'H3 the owner sends one message from the chat box and gets a reply', async () => {
      if (await page.isVisible('#unlock-toast')) await page.click('#toast-close');
      await clickAct(page, 'chat');
      await page.fill('#chat-input', '今天也辛苦啦，晚上想吃什么？');
      await page.press('#chat-input', 'Enter');
      await page.waitForFunction(() => /echo: 今天也辛苦啦/.test(document.getElementById('bubble').textContent), null, { timeout: 20000 });
      await idle();
      await shot('h3-chat-reply');
      const u = logged().filter((m) => m.origin === 'user');
      assert.deepEqual(u.map((m) => m.role), ['user', 'pet']);
      assert.equal(u[0].turnId, u[1].turnId);
      return `logged: ${u.map((m) => `${m.role}「${m.text}」`).join(' → ')}`;
    }, page);

    await step(S, 'H4 聊天记录 lists only that conversation: time, first message, 2 条; no greeting / proactive / stage-up text', async () => {
      await openHistory();
      await adminUntil(admin, () => document.querySelectorAll('[data-session]').length > 0, null, 10000, 'the conversation');
      const list = await items();
      assert.equal(list.length, 1, JSON.stringify(list));
      assert.equal(list[0].preview, '今天也辛苦啦，晚上想吃什么？');
      assert.equal(list[0].count, '2 条');
      assert.match(list[0].time, /\d{2}:\d{2}/);
      const text = await admin.evaluate(() => document.querySelector('[data-history-list]').innerText);
      assert.ok(!/\[事件\]|echo: \[/.test(text), 'no system text in the list');
      const hidden = await page.evaluate(() => window.pet.historyList().then((r) => r.hidden));
      await shotAdmin('h4-list');
      return `${list.map((i) => `${i.time} · ${i.who} · ${i.count} · 「${i.preview}」`).join(' | ')}; left out by origin: ${JSON.stringify(hidden)}`;
    }, () => admin);

    await step(S, 'H5 opening it shows the owner\'s message and her reply in full; 返回列表 goes back', async () => {
      await admin.evaluate(() => document.querySelector('[data-session]').click());
      await adminUntil(admin, () => !!document.querySelector('[data-history-thread] [data-role]'), null, 10000, 'the thread');
      const msgs = await admin.evaluate(() => [...document.querySelectorAll('[data-history-thread] [data-role]')].map((m) => ({ role: m.dataset.role, text: m.querySelector('[data-history-text]').textContent })));
      assert.deepEqual(msgs, [{ role: 'user', text: '今天也辛苦啦，晚上想吃什么？' }, { role: 'pet', text: 'echo: 今天也辛苦啦，晚上想吃什么？' }]);
      await shotAdmin('h5-detail');
      await admin.evaluate(() => document.querySelector('[data-history-back]').click());
      await adminUntil(admin, () => !!document.querySelector('[data-session]'), null, 10000, 'the list again');
      return msgs.map((m) => `${m.role}「${m.text}」`).join(' → ');
    }, () => admin);

    await step(S, 'H6 after a restart the history is still there (chat-log.json)', async () => {
      await app.close();
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await openHistory();
      const previews = (await items()).map((i) => i.preview);
      assert.deepEqual(previews, ['今天也辛苦啦，晚上想吃什么？']);
      await shotAdmin('h6-after-restart');
      return `previews after restart: ${previews.join(', ')}`;
    }, () => admin);

    await step(S, 'H7 设置 → LobeHub 与本机 → 重新开始话题: confirm, her next run goes without -t into a new LobeHub topic; old topic not deleted, history keeps both', async () => {
      const runs = () => fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const oldTopic = runs().pop().topic;
      await admin.evaluate(() => { location.hash = '/connection'; });
      await adminUntil(admin, () => !!document.querySelector('[data-new-topic]'), null, 10000, '重新开始话题');
      await admin.evaluate(() => document.querySelector('[data-new-topic]').click());
      await adminUntil(admin, () => [...document.querySelectorAll('[role="dialog"], .ant-modal')].some((d) => /旧话题不会删除/.test(d.textContent)), null, 8000, 'the confirmation');
      await shotAdmin('h7-menu-new-topic');
      await admin.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].filter((b) => (b.textContent || '').trim() === '重新开始话题').pop().click());
      await adminUntil(admin, () => ![...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].some((b) => (b.textContent || '').trim() === '重新开始话题'), null, 8000, 'the dialog to close');
      await page.bringToFront();
      await clickAct(page, 'chat');
      await page.fill('#chat-input', '我们聊点新的吧');
      await page.press('#chat-input', 'Enter');
      await page.waitForFunction(() => /echo: 我们聊点新的吧/.test(document.getElementById('bubble').textContent), null, { timeout: 20000 });
      await idle();
      const newTopic = runs().pop().topic;
      assert.ok(newTopic && newTopic !== oldTopic, `${oldTopic} → ${newTopic}`);
      const calls = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8');
      assert.doesNotMatch(calls, /"topic","delete"|"agent","delete"/);
      await openHistory();
      await adminUntil(admin, () => document.querySelectorAll('[data-session]').length === 2, null, 10000, 'two conversations');
      const previews = (await items()).map((i) => i.preview);
      assert.equal(previews.length, 2, previews.join(' | '));
      await shotAdmin('h7-history-after-new-topic');
      return `topic ${oldTopic} → ${newTopic}; nothing deleted; history: ${previews.join(' | ')}`;
    }, () => admin);
  } finally {
    await app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- outfit
// A character's second outfit on the real app: unlocked by a stage-up, listed and put on in the wardrobe,
// drawn on the desktop in idle / walk / lifted at the same spot and size as her daily sheet, kept over a
// restart, and shown from her default pack when her 旧版像素 look (which has no art for it) is picked.
// usage: node e2e/run.js outfit [character id, default claude] [outfit id, default swimsuit]
// Screenshots in out/e2e/outfit-<character>-<outfit>/.
// The 18+ 成年版 look (T-1261): hidden while all-ages; after the 18+ answer it is listed under 外观, and
// wearing it swaps the wardrobe to that pack's outfits (her adult maid outfit); the adult switch off puts
// her back into her usual look and an all-ages outfit.
// usage: node e2e/run.js adultlook [character id, default claude]. Screenshots in out/e2e/adultlook-<id>/.
async function adultLook() {
  return retiredScenario(`adultlook-${(process.argv[3] || 'claude')}`, 'admin (内容与安全 + her page → 装扮)');
  const ch = ROSTER.find((r) => r.id === (process.argv[3] || 'claude'));
  const S = `adultlook-${ch.id}`;
  const SHOTS = path.join(OUT, S);
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adultlook-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adultlookfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${S}/${name}.png`; };
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const key = () => page.evaluate(() => document.getElementById('pet-look').dataset.key);
  const closePanel = async () => { await page.click('#panel-close'); await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 }); };
  const looks = async () => { await openCurrentPage(page); await page.waitForSelector('.pack-list .pack-opt'); await page.locator('#look-section').scrollIntoViewIfNeeded(); return page.$$eval('.pack-list .pack-opt', (os) => os.map((o) => o.dataset.pack)); };
  // every card picture in the wardrobe has been drawn (a sprite canvas with pixels, or a loaded image)
  const cardsDrawn = () => page.waitForFunction(() => [...document.querySelectorAll('.card')].every((c) => { const cv = c.querySelector('canvas'); if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 16) if (d[i]) return true; return false; } const im = c.querySelector('img'); return !im || (im.complete && im.naturalWidth > 0); }), null, { timeout: 5000 });
  const wardrobe = async () => { await clickAct(page, 'wardrobe'); await page.waitForSelector('#panel:not(.hidden) .card'); return page.$$eval('.card', (cs) => cs.map((c) => c.dataset.outfit)); };
  const adultId = `${ch.id}-adult`;
  try {
    await step(S, `wake ${ch.zh} with all-ages content: 外观 has no 成年版 and her wardrobe no adult outfit`, async () => {
      await page.waitForSelector('.char-card');
      await page.locator(`.char-card[data-species="${ch.id}"]`).first().click();
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await idle();
      const l = await looks();
      assert.ok(!l.includes(adultId), `外观: ${l.join(', ')}`);
      const a = await shot('1-looks-all-ages');
      await closePanel();
      const w = await wardrobe();
      assert.ok(!w.includes('maid'));
      await closePanel();
      return `外观 ${l.join(', ')} · ${a}`;
    }, page);

    await step(S, 'the adult switch asks the 18+ question; after "我已年满 18 岁" 外观 lists the 成年版 marked 18+', async () => {
      await clickAct(page, 'menu');
      await page.click('#menu-adult');
      await page.waitForSelector('#age-gate:not(.hidden)');
      await page.click('#age-yes');
      await page.waitForSelector('#pet-screen:not(.hidden)');
      await idle();
      const l = await looks();
      assert.ok(l.includes(adultId), `外观: ${l.join(', ')}`);
      const meta = await page.textContent(`.pack-opt[data-pack="${adultId}"] .meta span`);
      assert.match(meta, /^18\+ · 像素动画 · 12 套服饰/);
      const name = await page.textContent(`.pack-opt[data-pack="${adultId}"] .meta b`);
      return `${name} — ${meta} · ${await shot('2-looks-18plus')}`;
    }, page);

    await step(S, `wearing the 成年版: the desktop draws ${adultId}, and unlocking every stage brings her adult maid outfit into the wardrobe`, async () => {
      await page.click(`.pack-opt[data-pack="${adultId}"] .pick`);
      await page.waitForSelector(`.pack-opt.on[data-pack="${adultId}"]`);
      assert.equal(await key(), `${adultId}/daily`);
      await page.locator('#unlock-all').scrollIntoViewIfNeeded();
      await page.click('#unlock-all');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)', { timeout: 10000 });
      await closePanel();
      const a = await shot('3-desktop-adult-daily');
      const w = await wardrobe();
      assert.deepEqual(w, ['daily', 'maid', 'offshoulder_gown', 'office', 'nurse', 'stewardess', 'sexy_bikini', 'retro_swimsuit', 'silk_robe', 'bunny', 'knit_dress', 'devil_cos'], "the 成年版's own outfits");
      assert.equal(await page.textContent('.card[data-outfit="maid"] .nm'), '性感女仆装');
      await cardsDrawn();
      assert.match(await page.textContent('#outfit-preview .adult-note'), /成年版（20 岁）/);
      const b = await shot('4-wardrobe-adult');
      return `wardrobe ${w.join(', ')} · ${a}, ${b}`;
    }, page);

    await step(S, 'she puts on the adult maid outfit (idle, walk, happy from its sheet), then the 性感比基尼', async () => {
      await page.click('.card[data-outfit="maid"]');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)');
      await cardsDrawn();
      const b = await shot('5-wardrobe-maid-on');
      await closePanel();
      await idle();
      assert.equal(await key(), `${adultId}/maid`);
      const frame = () => page.evaluate(() => document.querySelector('#pet-look canvas').dataset.frame);
      await page.evaluate(() => window.petFx.cue('idle'));
      await page.waitForTimeout(400);
      assert.match(await frame(), new RegExp(`${adultId}/sheets/maid\\.webp#0:`));
      const i = await shot('6-desktop-maid-idle');
      await page.evaluate(() => window.petFx.face('right'));
      const walking = page.evaluate(() => window.petFx.walk());
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.action === 'walk', null, { timeout: 3000 });
      await page.waitForTimeout(150);
      assert.match(await frame(), /maid\.webp#8:/);
      const wk = await shot('7-desktop-maid-walk');
      await walking;
      await page.evaluate(() => window.petFx.cue('happy'));
      await page.waitForTimeout(300);
      const h = await shot('8-desktop-maid-happy');
      // the 性感比基尼 too (the early bikini drafts): put on from the wardrobe, drawn from its own sheet
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('#panel:not(.hidden) .card[data-outfit="sexy_bikini"]');
      await page.click('.card[data-outfit="sexy_bikini"]');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)');
      await closePanel();
      await idle();
      assert.equal(await key(), `${adultId}/sexy_bikini`);
      await page.evaluate(() => window.petFx.cue('idle'));
      await page.waitForTimeout(400);
      assert.match(await frame(), new RegExp(`${adultId}/sheets/sexy_bikini\\.webp#0:`));
      const bk = await shot('8b-desktop-bikini-idle');
      return `${await frame()} · ${b}, ${i}, ${wk}, ${h}, ${bk}`;
    }, page);

    await step(S, 'turning adult content off: back to her usual look in an all-ages outfit, and the 成年版 leaves 外观', async () => {
      await page.evaluate(() => window.petFx.cue('idle'));
      await clickAct(page, 'menu');
      await page.click('#menu-adult');
      await page.waitForFunction(() => /成人向内容已关闭/.test(document.getElementById('bubble').textContent), null, { timeout: 5000 });
      await idle();
      assert.equal(await key(), `${ch.id}-pixel/daily`);
      const a = await shot('9-desktop-adult-off');
      const l = await looks();
      assert.ok(!l.includes(adultId));
      await closePanel();
      const w = await wardrobe();
      assert.ok(!w.includes('maid') && !w.includes('sexy_bikini') && w.includes('swimsuit'), `wardrobe ${w.join(', ')}`);
      await cardsDrawn();
      assert.match(await page.textContent('#outfit-preview .adult-note'), /成年（18 岁）/);
      const b = await shot('10-wardrobe-adult-off');
      await closePanel();
      return `${await key()} · ${a}, ${b}`;
    }, page);

    await step(S, 'no console errors or page errors', async () => {
      assert.deepEqual(errors, []);
      return '0 errors';
    }, page);
  } finally {
    await app.close().catch(() => {});
  }
}

async function outfitScenario() {
  return retiredScenario('outfit', 'frontslim F5, admin a13');
  const ch = ROSTER.find((r) => r.id === (process.argv[3] || 'claude'));
  const OID = process.argv[4] || 'swimsuit';
  const O = require('../src/core/outfits').OUTFITS.find((o) => o.id === OID);
  const S = `outfit-${ch.id}-${OID}`;
  const SHOTS = path.join(OUT, S);
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-outfit-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-outfitfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  let { app, page } = await launch(env, { video: path.join(SHOTS, 'video') });
  const errors = [];
  const watch = (pg) => {
    pg.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    pg.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    pg.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure() && r.failure().errorText}`));
  };
  watch(page);
  const shot = async (name) => { await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${S}/${name}.png`; };
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const leave = () => page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
  const petJson = () => { const p = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8')); return p.characters[p.speciesId]; };
  const mainBounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('visitor=')).getBounds());
  const toFloor = async (x) => app.evaluate(({ BrowserWindow, screen }, x) => { const w = BrowserWindow.getAllWindows().find((v) => !v.webContents.getURL().includes('visitor=')); const wa = screen.getDisplayMatching(w.getBounds()).workArea; const b = w.getBounds(); w.setPosition(Math.round(x), wa.y + wa.height - b.height); return w.getBounds(); }, x);
  // what the desktop pet draws right now: the sheet and frame up, the canvas box on screen, and the box of
  // her opaque pixels inside the frame (read back from the canvas, so a missing or broken sheet shows as 0 px)
  const drawn = () => page.evaluate(() => {
    const c = document.querySelector('#pet-look canvas');
    const r = c.getBoundingClientRect();
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (d[(y * c.width + x) * 4 + 3] >= 128) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { key: document.getElementById('pet-look').dataset.key, frame: c.dataset.frame.replace(/^pack:\/\//, ''), canvas: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], opaque: n, box: [x0, y0, x1, y1], action: document.getElementById('pet-body').dataset.action };
  });
  const fmt = (d) => `${d.key} frame ${d.frame} action ${d.action} canvas ${d.canvas.join(',')} opaque ${d.opaque} px box ${d.box.join(',')}`;
  // idle, walk (side view, frames cycle) and lifted (a real drag), each captured and measured
  const poses = async (tag) => {
    const out = {};
    await idle();
    await leave();
    // a line she is still saying (her greeting after waking) would turn the walk into talk part way
    await page.waitForFunction(() => document.getElementById('bubble').classList.contains('hidden'), null, { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => window.pet.debugSet({ hunger: 30, mood: 55, energy: 90, sleeping: false }));
    await page.evaluate(() => window.petFx.cue('idle'));
    await page.waitForFunction(() => window.petFx.state().state === 'idle' && document.getElementById('pet-body').dataset.action === 'idle', null, { timeout: 15000 });
    await page.waitForTimeout(300);
    out.idle = await drawn();
    out.idle.shot = await shot(`${tag}-idle`);
    await toFloor(200);
    await page.evaluate(() => window.petFx.face('right'));
    const firstWalk = page.evaluate(() => window.petFx.walk());
    await page.waitForFunction(() => window.petFx.state().state === 'walk' && document.getElementById('pet-body').dataset.action === 'walk', null, { timeout: 3000 });
    await page.waitForTimeout(150); // the next frame draws it
    out.walk = await drawn();
    out.walk.shot = await shot(`${tag}-walk`);
    // every walk frame that comes up while she walks has her in it; a walk is a random length, so a short
    // one that ends before the cycle comes round is followed by another (at most two more)
    const frames = new Set([out.walk.frame.split('#')[1]]);
    let walking = firstWalk;
    for (let n = 0; ; n++) {
      for (let i = 0; i < 15; i++) {
        const d = await drawn();
        if (d.action !== 'walk') break;
        frames.add(d.frame.split('#')[1]);
        assert.ok(d.opaque > 6000, `walk frame ${d.frame} drawn (${d.opaque} px)`);
        await page.waitForTimeout(80);
      }
      await walking;
      if (frames.size >= 3 || n === 2) break;
      await page.waitForTimeout(300);
      walking = page.evaluate(() => window.petFx.walk());
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.action === 'walk', null, { timeout: 3000 }).catch(() => {});
    }
    out.walk.frames = [...frames].sort();
    await page.waitForFunction(() => document.getElementById('bubble').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    const box = await page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 - 8, { steps: 4 });
    await page.waitForFunction(() => window.petFx.state().state === 'lifted' && document.getElementById('pet-body').dataset.action === 'lifted', null, { timeout: 3000 });
    await page.waitForTimeout(300);
    out.lifted = await drawn();
    out.lifted.shot = await shot(`${tag}-lifted`);
    await page.mouse.up();
    await idle();
    // one more action from the sheet's middle rows: happy (row 3), cued the way a click reaction plays it
    await page.waitForFunction(() => document.getElementById('bubble').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => window.petFx.cue('happy'));
    await page.waitForFunction(() => document.getElementById('pet-body').dataset.action === 'happy', null, { timeout: 5000 });
    await page.waitForTimeout(250);
    out.happy = await drawn();
    out.happy.shot = await shot(`${tag}-happy`);
    await page.evaluate(() => window.petFx.cue('idle'));
    for (const k of ['idle', 'walk', 'lifted', 'happy']) assert.ok(out[k].opaque > 6000, `${tag} ${k} drawn`);
    assert.match(out.happy.frame, /#3:/, 'happy plays row 3');
    assert.equal(out.walk.action, 'walk');
    assert.ok(out.walk.frames.length >= 3 && out.walk.frames.every((f) => f.startsWith('8:')), `the side-view walk row cycles: ${out.walk.frames}`);
    return out;
  };
  const report = [];
  let daily;
  try {
    await step(S, `choose ${ch.zh}, wake her: she wears daily`, async () => {
      await page.waitForSelector('.char-card');
      await page.locator(`.char-card[data-species="${ch.id}"]`).first().click();
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await idle();
      assert.equal(await page.evaluate(() => document.getElementById('pet-look').dataset.key), `${ch.id}-pixel/daily`);
      return `pet-look ${ch.id}-pixel/daily`;
    }, page);

    await step(S, 'daily: idle / walk / lifted / happy drawn', async () => {
      daily = await poses('1-daily');
      for (const k of ['idle', 'walk', 'lifted', 'happy']) report.push(`daily ${k}: ${fmt(daily[k])}`);
      assert.match(daily.idle.frame, /sheets\/daily\.webp#0:/);
      return `walk frames ${daily.walk.frames.join(' ')}; ${daily.idle.shot}, ${daily.walk.shot}, ${daily.lifted.shot}, ${daily.happy.shot}`;
    }, page);

    // A first-stage outfit (针织围巾套装, 陌生 ♥0) is never locked: it is offered from the start, without the 新 tag.
    const firstStage = O.stage === 'stranger';
    if (!firstStage) await step(S, `before ${O.stage}: the wardrobe lists ${O.label} locked with its condition`, async () => {
      await clickAct(page, 'wardrobe');
      await page.waitForSelector(`#panel:not(.hidden) .card[data-outfit="${OID}"]`);
      const st = await page.textContent(`.card[data-outfit="${OID}"] .st`);
      assert.match(st, /^🔒 /);
      assert.equal(await page.locator(`.card[data-outfit="${OID}"].locked`).count(), 1);
      const cards = await page.$$eval('.card', (cs) => cs.map((c) => `${c.dataset.outfit}「${c.querySelector('.nm').textContent}」${c.querySelector('.st').textContent}`));
      report.push(`wardrobe before unlock: ${cards.join(' | ')}`);
      const f = await shot('2-wardrobe-locked');
      await page.click('#panel-close');
      return `${cards.join(' | ')} · ${f}`;
    }, page);

    if (!firstStage) await step(S, `a real pat crossing into ${O.stage} unlocks ${O.label}: the notice names it`, async () => {
      const { getStage } = require('../src/core/affection');
      const min = getStage(O.stage).min;
      await page.evaluate((a) => window.pet.debugSet({ affection: a, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }), min - 1);
      // Jumping past an earlier stage (e.g. straight to ♥59) raises its own notice: dismiss it before the pat.
      await page.waitForTimeout(1500);
      if (await page.locator('#unlock-toast:not(.hidden)').count()) {
        await hover(page);
        await page.click('#toast-close');
        await page.waitForSelector('#unlock-toast.hidden', { state: 'attached' });
      }
      await hover(page);
      await clickHead(page);
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 8000 });
      await idle();
      await page.waitForTimeout(800);
      await hover(page);
      const toast = (await page.textContent('#unlock-toast')).replace(/\s+/g, ' ').trim();
      assert.match(toast, new RegExp(`解锁服饰：.*「${O.label}」`));
      report.push(`stage-up notice: ${toast}`);
      const f = await shot('3-unlock-notice');
      await page.click('#toast-close');
      return `${toast} · ${f}`;
    }, page);

    await step(S, `the wardrobe shows ${O.label} unlocked${firstStage ? ' from the start' : ' (新)'} with her art; clicking it puts it on`, async () => {
      await clickAct(page, 'wardrobe');
      await page.waitForSelector(`#panel:not(.hidden) .card[data-outfit="${OID}"]`);
      await page.waitForTimeout(500);
      assert.equal(await page.textContent(`.card[data-outfit="${OID}"] .st`), '点击穿上');
      assert.equal(await page.textContent(`.card[data-outfit="${OID}"] .nm`), O.label);
      assert.equal(await page.locator(`.card[data-outfit="${OID}"] .tag.new`).count(), firstStage ? 0 : 1);
      assert.equal(await page.locator(`.card[data-outfit="${OID}"] canvas.sprite`).count(), 1);
      const before = await shot('4-wardrobe-unlocked');
      await page.click(`.card[data-outfit="${OID}"]`);
      await page.waitForSelector('#panel-msg.ok:not(.hidden)');
      const msg = await page.textContent('#panel-msg');
      assert.equal(msg, `换好了：「${O.label}」`);
      await page.waitForFunction((id) => document.querySelector(`.card[data-outfit="${id}"] .st`).textContent === '✓ 穿着中', OID, { timeout: 5000 });
      assert.equal(await page.getAttribute('#outfit-preview', 'data-outfit'), OID);
      await page.waitForTimeout(500);
      const after = await shot('5-wardrobe-equipped');
      assert.equal(petJson().equippedOutfit, OID);
      report.push(`equip: ${msg}; pet.json equippedOutfit=${petJson().equippedOutfit} lastSafeOutfit=${petJson().lastSafeOutfit}`);
      await page.click('#panel-close');
      return `${msg} · pet.json equippedOutfit=${petJson().equippedOutfit} · ${before}, ${after}`;
    }, page);

    let worn;
    await step(S, `${O.label}: idle / walk / lifted / happy drawn from sheets/${OID}.webp, at daily's spot and size`, async () => {
      worn = await poses(`6-${OID}`);
      for (const k of ['idle', 'walk', 'lifted', 'happy']) report.push(`${OID} ${k}: ${fmt(worn[k])}`);
      assert.equal(worn.idle.key, `${ch.id}-pixel/${OID}`);
      for (const k of ['idle', 'walk', 'lifted', 'happy']) {
        assert.match(worn[k].frame, new RegExp(`sheets/${OID}\\.webp#`));
        assert.ok(Math.abs(worn[k].box[3] - daily[k].box[3]) <= 6, `${k}: feet at the same height (${worn[k].box[3]} vs ${daily[k].box[3]})`);
        const cx = (b) => (b[0] + b[2]) / 2;
        assert.ok(Math.abs(cx(worn[k].box) - cx(daily[k].box)) <= 48, `${k}: centred alike`);
      }
      assert.deepEqual(worn.idle.canvas, daily.idle.canvas, 'idle: the canvas does not move when she changes');
      const h = (b) => b[3] - b[1];
      return `idle height ${h(daily.idle.box)} → ${h(worn.idle.box)} px, feet ${daily.idle.box[3]} → ${worn.idle.box[3]}; walk frames ${worn.walk.frames.join(' ')}; ${worn.idle.shot}, ${worn.walk.shot}, ${worn.lifted.shot}, ${worn.happy.shot}`;
    }, page);

    await step(S, `after a restart she still wears ${O.label}`, async () => {
      await app.close();
      ({ app, page } = await launch(env));
      watch(page);
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await idle();
      await page.waitForFunction((k) => document.getElementById('pet-look').dataset.key === k, `${ch.id}-pixel/${OID}`, { timeout: 10000 });
      await page.waitForTimeout(500);
      const d = await drawn();
      assert.ok(d.opaque > 6000);
      report.push(`after restart: ${fmt(d)}`);
      return `${fmt(d)} · ${await shot('7-after-restart')}`;
    }, page);

    await step(S, `with 旧版像素 (${ch.id}-classic) picked, ${O.label} comes from ${ch.id}-pixel; daily goes back to the classic art`, async () => {
      await openCurrentPage(page);
      await page.waitForSelector(`.pack-opt[data-pack="${ch.id}-classic"]`);
      await page.click(`.pack-opt[data-pack="${ch.id}-classic"] .pick`);
      await page.waitForSelector(`.pack-opt.on[data-pack="${ch.id}-classic"]`);
      await page.click('#panel-close');
      await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 });
      await idle();
      await leave();
      await page.waitForTimeout(600);
      const swim = await drawn();
      assert.equal(swim.key, `${ch.id}-pixel/${OID}`, 'falls back to the default pack');
      assert.ok(swim.opaque > 6000);
      const f1 = await shot(`8-classic-picked-${OID}-fallback`);
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('.card[data-outfit="daily"]');
      await page.click('.card[data-outfit="daily"]');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)');
      await page.click('#panel-close');
      await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 });
      await page.waitForFunction((k) => document.getElementById('pet-look').dataset.key === k, `${ch.id}-classic/daily`, { timeout: 5000 });
      await leave();
      await page.waitForTimeout(600);
      const old = await drawn();
      assert.ok(old.opaque > 500);
      const f2 = await shot('9-classic-daily');
      report.push(`classic picked, ${OID}: ${fmt(swim)}`, `classic picked, daily: ${fmt(old)}`);
      return `${swim.key} (${swim.opaque} px) · ${old.key} (${old.opaque} px) · ${f1}, ${f2}`;
    }, page);

    // A character with her own clips (大肥鱼's 原版动画): the clips only show daily, so another outfit is drawn
    // from her default pixel pack's sheet; changing back to daily plays the clips again.
    const clips = require(`../src/characters/${ch.id}.json`).art.kind === 'video' ? `${ch.id}-clips` : null;
    if (clips) {
      const clip = () => page.evaluate(() => { const v = document.getElementById('pet-video'); const r = v.getBoundingClientRect(); return { key: v.dataset.key, src: v.src.replace(/^.*\/assets\//, 'assets/'), ready: v.readyState, size: [v.videoWidth, v.videoHeight], box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], vwrap: !document.getElementById('vwrap').classList.contains('hidden'), sprites: !document.getElementById('char-wrap').classList.contains('hidden') }; });
      const fmtClip = (c) => `video ${c.src} key ${c.key} ready ${c.ready} ${c.size.join('x')} box ${c.box.join(',')}`;
      const wear = async (id) => {
        await clickAct(page, 'wardrobe');
        await page.waitForSelector(`#panel:not(.hidden) .card[data-outfit="${id}"]`);
        await page.click(`.card[data-outfit="${id}"]`);
        await page.waitForFunction((x) => document.querySelector(`.card[data-outfit="${x}"] .st`).textContent === '✓ 穿着中', id, { timeout: 5000 });
      };
      const clipPoses = async (tag) => {
        const out = {};
        const playing = (k) => page.waitForFunction((k) => { const v = document.getElementById('pet-video'); return v.dataset.key === k && v.readyState >= 2; }, k, { timeout: 15000 });
        await idle();
        await leave();
        await page.evaluate(() => window.pet.debugSet({ hunger: 30, mood: 55, energy: 90, sleeping: false }));
        await page.evaluate(() => window.petFx.cue('idle'));
        await playing('idle');
        await page.waitForTimeout(400);
        out.idle = await clip();
        out.idle.shot = await shot(`${tag}-idle`);
        await toFloor(200);
        await page.evaluate(() => window.petFx.face('right'));
        const walking = page.evaluate(() => window.petFx.walk());
        await playing('walk');
        await page.waitForTimeout(300);
        out.walk = await clip();
        out.walk.shot = await shot(`${tag}-walk`);
        await walking;
        await page.waitForFunction(() => document.getElementById('bubble').classList.contains('hidden'), null, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(400);
        const box = await page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 - 8, { steps: 4 });
        await playing('lifted');
        await page.waitForTimeout(300);
        out.lifted = await clip();
        out.lifted.shot = await shot(`${tag}-lifted`);
        await page.mouse.up();
        await idle();
        for (const k of ['idle', 'walk', 'lifted']) {
          assert.ok(out[k].vwrap && !out[k].sprites, `${tag} ${k}: her clip is shown, not the sprites`);
          assert.equal(out[k].src, `assets/${ch.id}/${k}.webm`);
          assert.ok(out[k].size[0] > 0 && out[k].box[2] > 0, `${tag} ${k}: the clip is decoded and laid out`);
        }
        return out;
      };

      await step(S, `with 原版动画 (${clips}) picked, daily plays her clips: idle / walk / lifted`, async () => {
        await wear('daily');
        await page.click('#panel-close');
        await openCurrentPage(page);
        await page.waitForSelector(`.pack-opt[data-pack="${clips}"]`);
        await page.click(`.pack-opt[data-pack="${clips}"] .pick`);
        await page.waitForSelector(`.pack-opt.on[data-pack="${clips}"]`);
        await page.click('#panel-close');
        await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 });
        await page.waitForSelector('#vwrap:not(.hidden)', { timeout: 5000 });
        const c = await clipPoses('10-clips-daily');
        for (const k of ['idle', 'walk', 'lifted']) report.push(`clips daily ${k}: ${fmtClip(c[k])}`);
        return `${['idle', 'walk', 'lifted'].map((k) => c[k].src).join(', ')} · ${c.idle.shot}, ${c.walk.shot}, ${c.lifted.shot}`;
      }, page);

      await step(S, `with 原版动画 picked, ${O.label} comes from ${ch.id}-pixel/sheets/${OID}.webp (no blank, no error); daily goes back to the clips`, async () => {
        await clickAct(page, 'wardrobe');
        await page.waitForSelector(`#panel:not(.hidden) .card[data-outfit="${OID}"] canvas.sprite`);
        assert.equal(await page.locator('.card[data-outfit="daily"] .vlook video').count(), 1, 'the daily card shows her clip');
        await page.click('#panel-close');
        await wear(OID);
        const card = await shot('11-clips-wardrobe');
        await page.click('#panel-close');
        await page.waitForFunction((k) => document.getElementById('pet-look').dataset.key === k, `${ch.id}-pixel/${OID}`, { timeout: 5000 });
        assert.equal(await page.locator('#vwrap').isHidden(), true, 'the clip is hidden');
        const w = await poses(`12-clips-${OID}`);
        for (const k of ['idle', 'walk', 'lifted']) {
          report.push(`clips picked, ${OID} ${k}: ${fmt(w[k])}`);
          assert.match(w[k].frame, new RegExp(`^${ch.id}-pixel/sheets/${OID}\\.webp#`));
          assert.ok(Math.abs(w[k].box[3] - worn[k].box[3]) <= 6 && Math.abs(w[k].box[1] - worn[k].box[1]) <= 6, `${k}: the same frame as with the pixel look`);
        }
        await wear('daily');
        await page.click('#panel-close');
        await page.waitForSelector('#vwrap:not(.hidden)', { timeout: 5000 });
        await page.waitForFunction(() => document.getElementById('pet-video').readyState >= 2, null, { timeout: 10000 });
        const back = await clip();
        assert.match(back.src, new RegExp(`^assets/${ch.id}/[a-z_]+\\.webm$`));
        const f = await shot('13-clips-daily-again');
        report.push(`clips picked, daily again: ${fmtClip(back)}`);
        return `${w.idle.frame}, ${w.walk.frames.join(' ')}, ${w.lifted.frame} · back to ${back.src} · ${card}, ${w.idle.shot}, ${w.walk.shot}, ${w.lifted.shot}, ${f}`;
      }, page);
    }

    await step(S, 'no console errors, page errors or failed requests', async () => {
      const packErr = /pack:|\.webp|sheet|Failed to load/i;
      report.push(`errors: ${errors.length ? errors.join(' | ') : '(none)'}`);
      assert.deepEqual(errors.filter((e) => packErr.test(e)), [], 'no art failed to load');
      assert.deepEqual(errors, []);
      return `${errors.length} errors`;
    }, null);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'report.txt'), report.join('\n') + '\n');
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ rig
// 大肥鱼 · 全动态 (kind "rig", src/renderer/rig.js): layers bent live in WebGL, not frames.
async function rigScenario() {
  const S = 'rig';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rig-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rigfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, appearance: { dafeiyu: 'dafeiyu-live' } }));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  // what the rig canvas shows: share of opaque pixels and a fingerprint of the frame
  const look = () => page.evaluate(() => {
    const c = document.querySelector('#pet-look canvas.rig');
    if (!c) return null;
    const k = document.createElement('canvas');
    k.width = 83; k.height = 113;
    const g = k.getContext('2d');
    g.drawImage(c, 0, 0, 83, 113);
    const d = g.getImageData(0, 0, 83, 113).data;
    let n = 0;
    let h = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 24) n++; h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 3] * 7) % 1000003; }
    return { opaque: n / (83 * 113), hash: h, size: [c.width, c.height], frame: c.dataset.frame };
  });
  try {
    await step(S, 'hatching 大肥鱼 in her 全动态 look', async () => {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-character="dafeiyu-live"]').click(); // T-2764: she is her own character (settings.appearance is gone)
      await page.fill('#pet-name', 'Mow');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 20000 });
      await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
    }, page);

    await step(S, 'she is drawn by the rig: a WebGL canvas with her whole figure, never an empty frame', async () => {
      await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.rig'); return c && c.dataset.frame; }, null, { timeout: 10000 });
      assert.equal(await page.evaluate(() => document.getElementById('char-wrap').classList.contains('has-sprites')), true);
      const a = await look();
      assert.ok(a.opaque > 0.12 && a.opaque < 0.5, JSON.stringify(a));
      return `canvas ${a.size.join('x')}, ${(a.opaque * 100).toFixed(1)}% of the frame is her`;
    }, page);

    await step(S, 'standing still she still moves: breathing, blinking, hair and tail drift', async () => {
      await page.waitForFunction(() => window.petFx.state().state === 'idle', null, { timeout: 15000 });
      const seen = new Set();
      for (let i = 0; i < 6; i++) { seen.add((await look()).hash); await page.waitForTimeout(250); }
      assert.ok(seen.size >= 4, `${seen.size} different frames in 1.5 s`);
      return `${seen.size} different frames in 1.5 s`;
    }, page);

    for (const cue of ['happy', 'pat', 'sad', 'play']) {
      await step(S, `cue ${cue}: acted out by the rig itself`, async () => {
        await page.evaluate((c) => window.petFx.cue(c), cue);
        await page.waitForTimeout(700);
        const st = await page.evaluate(() => window.petFx.state());
        assert.equal(st.state, cue);
        assert.equal(st.exact, true, 'no emoji stand-in');
        assert.match((await look()).frame, new RegExp(`^${cue}#`));
        return `state ${st.state}, exact`;
      }, page);
    }

    await step(S, 'waking up pops her in, and the next state starts at her full size', async () => {
      const full = (await look()).opaque;
      await page.evaluate(() => window.petFx.cue('hatch'));
      await page.waitForTimeout(80);
      const popping = (await look()).opaque;
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.petFx.lift(true));
      await page.waitForTimeout(80);
      const after = (await look()).opaque;
      await page.evaluate(() => window.petFx.lift(false));
      assert.ok(popping < full * 0.85, `the pop starts small: ${popping} vs ${full}`);
      assert.ok(after > full * 0.85, `lifted right after waking up: ${after} vs ${full}`);
      return `share of the frame: ${(full * 100).toFixed(1)}% standing, ${(popping * 100).toFixed(1)}% popping in, ${(after * 100).toFixed(1)}% lifted after`;
    }, page);

    await step(S, 'lifted and swung about: her hair, skirt and tail trail the motion', async () => {
      await page.evaluate(() => window.petFx.lift(true));
      const b0 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      const hashes = new Set();
      for (let i = 0; i < 12; i++) {
        await app.evaluate(({ BrowserWindow }, [x, y]) => BrowserWindow.getAllWindows()[0].setPosition(x, y), [b0.x + Math.round(Math.sin(i * 0.9) * 120), b0.y]);
        await page.waitForTimeout(60);
        if (i % 3 === 2) hashes.add((await look()).hash);
      }
      const st = await page.evaluate(() => window.petFx.state());
      assert.equal(st.state, 'lifted');
      await page.screenshot({ path: path.join(OUT, 'rig-lifted.png') });
      await page.evaluate(() => window.petFx.lift(false));
      await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setPosition(b.x, b.y), b0);
      assert.ok(hashes.size >= 3);
      return `${hashes.size} different swinging frames`;
    }, page);

    await step(S, 'thrown: she flies, lands and keeps drawing', async () => {
      const r = await page.evaluate(() => window.petFx.throw(500, -500));
      assert.ok(r && r.bounces >= 1, JSON.stringify(r));
      await page.waitForTimeout(500);
      assert.ok((await look()).opaque > 0.12);
      return `${r.bounces} bounces`;
    }, page);

    await step(S, 'touching her parts maps onto the rig: head, face, feet', async () => {
      const r = await page.evaluate(() => {
        const c = document.querySelector('#pet-look canvas.rig').getBoundingClientRect();
        const at = (u, v) => window.petFx.touchPoint(c.left + c.width * u, c.top + c.height * v);
        return { head: at(0.49, 0.245), face: at(0.49, 0.32), feet: at(0.49, 0.95), off: at(0.05, 0.05) };
      });
      assert.equal(r.head && r.head.zone, 'head');
      assert.equal(r.face && r.face.zone, 'face');
      assert.equal(r.feet && r.feet.zone, 'feet');
      assert.equal(r.off ? r.off.zone : null, null, 'the empty corner is not her');
      await page.evaluate(() => window.petFx.click());
      return Object.entries(r).map(([k, v]) => `${k}→${v ? v.zone : 'null'}`).join(', ');
    }, page);

    await step(S, 'no console errors or page errors', async () => {
      assert.deepEqual(errors, []);
      return `${errors.length} errors`;
    }, null);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ live2d
// 大肥鱼 · Live2D (kind "live2d", src/renderer/live2d.js): a Cubism model, its physics and our moves.
async function live2dScenario() {
  const S = 'live2d';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2d-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2dfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, appearance: { dafeiyu: 'dafeiyu-live2d' } }));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  // what the rig canvas shows: share of opaque pixels and a fingerprint of the frame
  const look = () => page.evaluate(() => {
    const c = document.querySelector('#pet-look canvas.live2d');
    if (!c) return null;
    const k = document.createElement('canvas');
    k.width = 83; k.height = 113;
    const g = k.getContext('2d');
    g.drawImage(c, 0, 0, 83, 113);
    const d = g.getImageData(0, 0, 83, 113).data;
    let n = 0;
    let h = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 24) n++; h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 3] * 7) % 1000003; }
    return { opaque: n / (83 * 113), hash: h, size: [c.width, c.height], frame: c.dataset.frame };
  });
  try {
    await step(S, 'hatching 大肥鱼 in her Live2D look', async () => {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-character="dafeiyu-live2d"]').click(); // T-2764: she is her own character (settings.appearance is gone)
      await page.fill('#pet-name', 'Mow');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 20000 });
      await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
    }, page);

    await step(S, 'she is drawn by Live2D: the runtime loads on demand, a WebGL canvas with her whole figure', async () => {
      await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.live2d'); return c && c.dataset.frame; }, null, { timeout: 10000 });
      assert.equal(await page.evaluate(() => document.getElementById('char-wrap').classList.contains('has-sprites')), true);
      assert.equal(await page.evaluate(() => !!(window.PIXI && window.PIXI.live2d && window.Live2DCubismCore)), true, 'Cubism Core, PixiJS and pixi-live2d-display loaded');
      const a = await look();
      assert.ok(a.opaque > 0.12 && a.opaque < 0.5, JSON.stringify(a));
      return `canvas ${a.size.join('x')}, ${(a.opaque * 100).toFixed(1)}% of the frame is her`;
    }, page);

    await step(S, 'standing still she still moves: breathing, blinking, the model physics', async () => {
      await page.waitForFunction(() => window.petFx.state().state === 'idle', null, { timeout: 15000 });
      const seen = new Set();
      for (let i = 0; i < 6; i++) { seen.add((await look()).hash); await page.waitForTimeout(250); }
      assert.ok(seen.size >= 4, `${seen.size} different frames in 1.5 s`);
      return `${seen.size} different frames in 1.5 s`;
    }, page);

    for (const cue of ['happy', 'pat', 'sad', 'play']) {
      await step(S, `cue ${cue}: acted out by the Live2D figure`, async () => {
        await page.evaluate((c) => window.petFx.cue(c), cue);
        await page.waitForTimeout(700);
        const st = await page.evaluate(() => window.petFx.state());
        assert.equal(st.state, cue);
        assert.equal(st.exact, true, 'no emoji stand-in');
        assert.match((await look()).frame, new RegExp(`^${cue}#`));
        return `state ${st.state}, exact`;
      }, page);
    }

    await step(S, 'waking up pops her in, and the next state starts at her full size', async () => {
      const full = (await look()).opaque;
      await page.evaluate(() => window.petFx.cue('hatch'));
      await page.waitForTimeout(80);
      const popping = (await look()).opaque;
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.petFx.lift(true));
      await page.waitForTimeout(80);
      const after = (await look()).opaque;
      await page.evaluate(() => window.petFx.lift(false));
      assert.ok(popping < full * 0.85, `the pop starts small: ${popping} vs ${full}`);
      assert.ok(after > full * 0.85, `lifted right after waking up: ${after} vs ${full}`);
      return `share of the frame: ${(full * 100).toFixed(1)}% standing, ${(popping * 100).toFixed(1)}% popping in, ${(after * 100).toFixed(1)}% lifted after`;
    }, page);

    await step(S, 'lifted and swung about: her hair, skirt and tail trail the motion', async () => {
      await page.evaluate(() => window.petFx.lift(true));
      const b0 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      const hashes = new Set();
      for (let i = 0; i < 12; i++) {
        await app.evaluate(({ BrowserWindow }, [x, y]) => BrowserWindow.getAllWindows()[0].setPosition(x, y), [b0.x + Math.round(Math.sin(i * 0.9) * 120), b0.y]);
        await page.waitForTimeout(60);
        if (i % 3 === 2) hashes.add((await look()).hash);
      }
      const st = await page.evaluate(() => window.petFx.state());
      assert.equal(st.state, 'lifted');
      await page.screenshot({ path: path.join(OUT, 'live2d-lifted.png') });
      await page.evaluate(() => window.petFx.lift(false));
      await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setPosition(b.x, b.y), b0);
      assert.ok(hashes.size >= 3);
      return `${hashes.size} different swinging frames`;
    }, page);

    await step(S, 'thrown: she flies, lands and keeps drawing', async () => {
      const r = await page.evaluate(() => window.petFx.throw(500, -500));
      assert.ok(r && r.bounces >= 1, JSON.stringify(r));
      await page.waitForTimeout(500);
      assert.ok((await look()).opaque > 0.12);
      return `${r.bounces} bounces`;
    }, page);

    await step(S, 'touching her parts maps onto the model: head, face, feet', async () => {
      const r = await page.evaluate(() => {
        const c = document.querySelector('#pet-look canvas.live2d').getBoundingClientRect();
        const at = (u, v) => window.petFx.touchPoint(c.left + c.width * u, c.top + c.height * v);
        return { head: at(0.49, 0.245), face: at(0.49, 0.3), feet: at(0.49, 0.9), off: at(0.05, 0.05) };
      });
      assert.equal(r.head && r.head.zone, 'head');
      assert.equal(r.face && r.face.zone, 'face');
      assert.equal(r.feet && r.feet.zone, 'feet');
      assert.equal(r.off ? r.off.zone : null, null, 'the empty corner is not her');
      await page.evaluate(() => window.petFx.click());
      return Object.entries(r).map(([k, v]) => `${k}→${v ? v.zone : 'null'}`).join(', ');
    }, page);

    await step(S, 'no console errors or page errors', async () => {
      assert.deepEqual(errors, []);
      return `${errors.length} errors`;
    }, null);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ l2dimport
// 外观 → 导入 Live2D 模型…: the user's own Cubism model (a plain folder, no pack.json) becomes her look.
async function live2dImport() {
  return retiredScenario('l2dimport', 'admin (her page → 装扮 → 导入 Live2D…)');
  const S = 'l2dimport';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2di-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2difake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  // "her own" model: the 中肥鱼 model files as a user has them, plus an expression named in Japanese
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2dmodel-'));
  const own = path.join(fix, 'Whale');
  fs.cpSync(path.join(ROOT, 'catalog', 'packs', 'dafeiyu-live2d', 'model'), own, { recursive: true });
  fs.renameSync(path.join(own, 'medium.model3.json'), path.join(own, 'Whale.model3.json'));
  fs.writeFileSync(path.join(own, '照れ.exp3.json'), JSON.stringify({ Type: 'Live2D Expression', Parameters: [{ Id: 'PARAM_EXP4', Value: 1, Blend: 'Add' }] }));
  const m3 = JSON.parse(fs.readFileSync(path.join(own, 'Whale.model3.json'), 'utf8'));
  m3.FileReferences.Expressions = [{ Name: '照れ', File: '照れ.exp3.json' }];
  fs.writeFileSync(path.join(own, 'Whale.model3.json'), JSON.stringify(m3));
  const zip = path.join(fix, 'Whale.zip');
  execFileSync('python3', ['-m', 'zipfile', '-c', zip, own]);
  const empty = path.join(fix, 'empty');
  fs.mkdirSync(empty);
  const c2 = path.join(fix, 'old');
  fs.mkdirSync(c2);
  fs.writeFileSync(path.join(c2, 'shizuku.model.json'), '{}');
  const broken = path.join(fix, 'Broken');
  fs.cpSync(own, broken, { recursive: true });
  fs.writeFileSync(path.join(broken, 'medium.moc3'), 'not a moc');

  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  const share = () => page.evaluate(() => {
    const c = document.querySelector('#pet-look canvas.live2d');
    if (!c) return null;
    const k = document.createElement('canvas');
    k.width = 83; k.height = 113;
    const g = k.getContext('2d');
    g.drawImage(c, 0, 0, 83, 113);
    const d = g.getImageData(0, 0, 83, 113).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 24) n++;
    return n / (83 * 113);
  });
  const importFrom = async (p) => {
    await page.evaluate((x) => window.pet.debugNextOpen(x), p);
    await page.click('#l2d-import');
    await page.waitForFunction(() => { const m = document.getElementById('panel-msg'); return !m.classList.contains('hidden') && !/正在加载/.test(m.textContent); }, null, { timeout: 30000 });
    return page.textContent('#panel-msg');
  };
  const ID = 'l2d-dafeiyu-whale';
  try {
    await step(S, 'hatching 大肥鱼 in her default pixel look', async () => {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="dafeiyu"]').first().click();
      await page.fill('#pet-name', 'Mow');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 20000 });
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily');
    }, page);

    await step(S, 'her page offers 导入 Live2D 模型… under 外观', async () => {
      await openCurrentPage(page);
      await page.locator('#look-section').scrollIntoViewIfNeeded();
      assert.equal(await page.locator('#l2d-import').textContent(), '导入 Live2D 模型…');
      assert.match(await page.textContent('#look-section'), /Cubism 3 \/ 4 \/ 5/);
      await page.screenshot({ path: path.join(OUT, 'l2dimport-section.png') });
    }, page);

    await step(S, 'a Cubism 2 model or a folder without a model is refused with the reason', async () => {
      const a = await importFrom(path.join(c2, 'shizuku.model.json'));
      assert.match(a, /导入失败：这是 Cubism 2 的模型/);
      const b = await importFrom(empty);
      assert.match(b, /导入失败/);
      assert.equal(fs.existsSync(path.join(data, 'packs', ID)), false);
      return `${a.trim()} / ${b.trim()}`;
    }, page);

    await step(S, 'a model that will not load is removed again', async () => {
      const before = errors.length;
      const msg = await importFrom(path.join(broken, 'Whale.model3.json'));
      assert.match(msg, /导入失败：这个模型在这台电脑上加载不了/);
      await page.waitForFunction(() => !document.querySelector('.pack-opt[data-pack^="l2d-"]'), null, { timeout: 5000 });
      assert.deepEqual(fs.readdirSync(path.join(data, 'packs')), [], 'nothing left in the packs folder');
      errors.splice(before); // the broken model's own load error
      return msg.trim();
    }, page);

    await step(S, 'importing her .model3.json: the pack is made, the model drawn, its picture saved and worn', async () => {
      const msg = await importFrom(path.join(own, 'Whale.model3.json'));
      assert.match(msg, /已导入 Live2D 模型「Whale」并换上，用上了它的表情：脸红/);
      await page.waitForSelector(`.pack-opt.on[data-pack="${ID}"]`);
      assert.match(await page.textContent(`.pack-opt[data-pack="${ID}"] .meta span`), /^Live2D · \d+ 套服饰 · 本地导入 · 模型作者的条款 · 导入（内容由作者负责）/);
      const manifest = JSON.parse(fs.readFileSync(path.join(data, 'packs', ID, 'pack.json'), 'utf8'));
      assert.equal(manifest.model, 'model/Whale.model3.json');
      assert.deepEqual(manifest.live2d.faces, { blush: { PARAM_EXP4: 1 } });
      const png = fs.readFileSync(path.join(data, 'packs', ID, 'preview.png'));
      const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      assert.ok(w >= 300 && h >= 400 && png.length > 20000, `preview ${w}x${h}, ${png.length} bytes`);
      await page.screenshot({ path: path.join(OUT, 'l2dimport-imported.png') });
      return `${msg.trim()} · preview ${w}x${h}`;
    }, page);

    await step(S, 'she is drawn by her own model on the desktop', async () => {
      await page.click('#panel-close');
      await page.waitForFunction((id) => document.getElementById('pet-look').dataset.key.startsWith(`${id}/daily`), ID);
      await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.live2d'); return c && c.dataset.frame; }, null, { timeout: 15000 });
      const a = await share();
      assert.ok(a > 0.12 && a < 0.5, `${a}`);
      await page.evaluate(() => window.petFx.cue('pat'));
      await page.waitForTimeout(700);
      assert.equal((await page.evaluate(() => window.petFx.state())).state, 'pat');
      await page.screenshot({ path: path.join(OUT, 'l2dimport-desk.png') });
      return `${(a * 100).toFixed(1)}% of the frame is her`;
    }, page);

    await step(S, '模型大小 makes her smaller in the window, and is kept', async () => {
      const big = await share();
      await openCurrentPage(page);
      await page.locator('.l2d-size').scrollIntoViewIfNeeded();
      assert.equal(await page.inputValue('.l2d-size input'), '80');
      await page.locator('.l2d-size input').fill('50');
      await page.locator('.l2d-size input').dispatchEvent('change');
      await page.waitForFunction((id) => document.getElementById('pet-look').dataset.key === `${id}/daily@0.5`, ID, { timeout: 5000 });
      await page.waitForSelector('.l2d-size b');
      assert.equal(await page.textContent('.l2d-size b'), '50%');
      await page.screenshot({ path: path.join(OUT, 'l2dimport-size.png') });
      await page.click('#panel-close');
      await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.live2d'); return c && c.dataset.frame; }, null, { timeout: 15000 });
      await page.waitForTimeout(500);
      const small = await share();
      assert.ok(small < big * 0.6, `${small} vs ${big}`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'packs', ID, 'pack.json'), 'utf8')).live2d.height, 0.5);
      await page.screenshot({ path: path.join(OUT, 'l2dimport-small.png') });
      return `share of the frame ${(big * 100).toFixed(1)}% → ${(small * 100).toFixed(1)}%`;
    }, page);

    await step(S, 'the same model as a .zip replaces it (one pack per model), at the default size again', async () => {
      await openCurrentPage(page);
      const msg = await importFrom(zip);
      assert.match(msg, /已导入 Live2D 模型「Whale」/);
      assert.deepEqual(fs.readdirSync(path.join(data, 'packs')), [ID]);
      assert.equal(await page.inputValue('.l2d-size input'), '80');
      return msg.trim();
    }, page);

    await step(S, 'removing it puts her back in her default look', async () => {
      await page.click(`.pack-opt[data-pack="${ID}"] .pack-remove`);
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily', null, { timeout: 5000 });
      assert.equal(fs.existsSync(path.join(data, 'packs', ID)), false);
    }, page);

    await step(S, 'no console errors or page errors', async () => {
      assert.deepEqual(errors, []);
      return `${errors.length} errors`;
    }, null);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ vrmui
// 外观 → 导入 VRM 模型… (T-2649): the import entry, errors in plain words, 导入确认 with the model's meta and
// license, the card (VRM · N 套服饰 · 作者, credit kept visible), 授权信息 with a link for the system browser,
// 导出… refused for a model that may not be redistributed, outfits still locked by the app's rules, and
// switching between the VRM pack and the 2D packs (the live VRM figure released and made again). Models are
// synthetic GLBs carrying only meta (the whale's license, no third-party mesh). The 3D renderer is another
// task: a stand-in window.PetVRM records the figure's life cycle.
function vrmGlb(json) {
  let j = Buffer.from(JSON.stringify(json), 'utf8');
  if (j.length % 4) j = Buffer.concat([j, Buffer.alloc(4 - (j.length % 4), 0x20)]);
  const out = Buffer.alloc(20 + j.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(j.length, 12); out.writeUInt32LE(0x4e4f534a, 16); j.copy(out, 20);
  return out;
}
async function vrmUi() {
  return retiredScenario('vrmui', 'admin (her page → 装扮 → 导入 VRM…); vrm / vrmimport scenarios');
  const S = 'vrmui';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrmui-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrmuifake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  // 18+ confirmed but adult content off: the switch is the app's, not the pack's
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: false }));
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrmmodels-'));
  const PRESETS = Object.fromEntries(['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'neutral'].map((n) => [n, {}]));
  const WHALE = { name: '蓝色小肥鱼Deepseek', version: '1.0.0', authors: ['木子惡魔'], copyrightInformation: '© 木子惡魔', contactInformation: 'https://github.com/sunfish1728', references: ['https://github.com/sunfish1728/deepcoin-avatars'], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor', allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, commercialUsage: 'personalNonProfit', allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false, creditNotation: 'required', allowRedistribution: false, modification: 'prohibited' };
  const OPEN = { name: 'Open Fish', version: '0.1', authors: ['Maker'], licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/', avatarPermission: 'everyone', allowExcessivelyViolentUsage: true, allowExcessivelySexualUsage: true, commercialUsage: 'corporation', allowPoliticalOrReligiousUsage: true, allowAntisocialOrHateUsage: true, creditNotation: 'unnecessary', allowRedistribution: true, modification: 'allowModificationRedistribution' };
  const vrm1 = (meta) => vrmGlb({ asset: { version: '2.0' }, extensions: { VRMC_vrm: { specVersion: '1.0', meta, humanoid: { humanBones: {} }, expressions: { preset: PRESETS } } } });
  const whale = path.join(fix, 'whale-meta-only.vrm');
  fs.writeFileSync(whale, vrm1(WHALE));
  const open = path.join(fix, 'open-fish.vrm');
  fs.writeFileSync(open, vrm1(OPEN));
  const notVrm = path.join(fix, 'renamed.vrm');
  fs.writeFileSync(notVrm, 'PK\u0003\u0004 a zip renamed to .vrm');
  const plain = path.join(fix, 'plain.vrm');
  fs.writeFileSync(plain, vrmGlb({ asset: { version: '2.0' }, meshes: [] }));
  const broken = path.join(fix, 'broken.vrm');
  fs.writeFileSync(broken, vrm1(WHALE).subarray(0, 60));
  const gone = path.join(fix, 'moved-away', 'gone.vrm');
  // hand-written 18+ VRM packs: one dressing an adult outfit in the whale model (license forbids), one allowed
  const adultBad = path.join(fix, 'adult-bad');
  fs.mkdirSync(path.join(adultBad, 'models'), { recursive: true });
  fs.copyFileSync(whale, path.join(adultBad, 'models', 'w.vrm'));
  fs.writeFileSync(path.join(adultBad, 'pack.json'), JSON.stringify({ schema: 2, id: 'vrm-adult-bad', name: 'Adult Whale', species: 'dafeiyu', kind: 'vrm', adult: true, vrm: { outfits: { daily: 'models/w.vrm', maid: 'models/w.vrm' } } }));
  const adultOk = path.join(fix, 'adult-ok');
  fs.mkdirSync(path.join(adultOk, 'models'), { recursive: true });
  fs.copyFileSync(open, path.join(adultOk, 'models', 'o.vrm'));
  // one model per outfit: a VRM pack's wardrobe has one entry per distinct model (520d86c), so the same .vrm
  // under daily and maid would be a single look with no wardrobe at all
  fs.copyFileSync(open, path.join(adultOk, 'models', 'maid.vrm'));
  fs.writeFileSync(path.join(adultOk, 'pack.json'), JSON.stringify({ schema: 2, id: 'vrm-adult-open', name: 'Adult Open Fish', species: 'dafeiyu', kind: 'vrm', adult: true, vrm: { outfits: { daily: 'models/o.vrm', maid: 'models/maid.vrm' } } }));
  // an all-ages VRM pack with several looks (one model each), so it has a real wardrobe: daily (stranger),
  // pajamas (close), yukata (flirty) — the last two locked by affection for a new companion
  const multi = path.join(fix, 'multi-open');
  fs.mkdirSync(path.join(multi, 'models'), { recursive: true });
  for (const o of ['daily', 'pajamas', 'yukata']) fs.copyFileSync(open, path.join(multi, 'models', `${o}.vrm`));
  fs.writeFileSync(path.join(multi, 'pack.json'), JSON.stringify({ schema: 2, id: 'vrm-multi-open', name: 'Open Fish Looks', species: 'dafeiyu', kind: 'vrm', vrm: { outfits: { daily: 'models/daily.vrm', pajamas: 'models/pajamas.vrm', yukata: 'models/yukata.vrm' } } }));

  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  const msg = () => page.textContent('#panel-msg');
  const importFrom = async (p) => {
    await page.evaluate(() => { document.getElementById('panel-msg').textContent = ''; });
    await page.evaluate((x) => window.pet.debugNextOpen(x), p);
    await page.click('#vrm-import');
    await page.waitForFunction(() => document.getElementById('vrm-confirm') || /导入失败|已导入/.test(document.getElementById('panel-msg').textContent), null, { timeout: 15000 });
  };
  const WID = 'vrm-dafeiyu-deepseek';
  const OID = 'vrm-dafeiyu-open-fish';
  const packDirs = () => (fs.existsSync(path.join(data, 'packs')) ? fs.readdirSync(path.join(data, 'packs')).sort() : []);
  const look = async () => { await page.locator('#look-section').scrollIntoViewIfNeeded(); };
  try {
    await step(S, 'hatching 大肥鱼 in her default pixel look', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Mow');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 20000 });
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily');
    }, page);

    await step(S, 'her page offers 导入 VRM 模型… under 外观, next to 导入 Live2D 模型…', async () => {
      await openCurrentPage(page);
      await look();
      assert.equal(await page.locator('#vrm-import').textContent(), '导入 VRM 模型…');
      assert.match(await page.textContent('#look-section .vrm-text'), /VRM 1\.0 \/ 0\.x 的 \.vrm 文件/);
      await page.locator('#vrm-import').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, 'vrmui-section.png') });
    }, page);

    await step(S, 'not a VRM / plain glTF / broken / moved file: each refused with a clear reason, nothing copied', async () => {
      const out = [];
      for (const [p, re, tag] of [[notVrm, /这不是 VRM 文件：内容不是 glTF 二进制格式/, 'not-vrm'], [plain, /普通的 glTF\/GLB 模型，没有 VRM 信息/, 'plain-gltf'], [broken, /文件已损坏或不完整/, 'broken'], [gone, /找不到这个文件/, 'missing']]) {
        await importFrom(p);
        const m = await msg();
        assert.match(m, re, m);
        out.push(m.trim());
        await page.screenshot({ path: path.join(OUT, `vrmui-error-${tag}.png`) });
      }
      assert.deepEqual(packDirs(), []);
      await page.screenshot({ path: path.join(OUT, 'vrmui-error.png') });
      return out.join(' | ');
    }, page);

    await step(S, '导入确认 shows the model name, author, copyright, contact, references, license and its restrictions', async () => {
      await importFrom(whale);
      await page.waitForSelector('#vrm-confirm');
      const t = await page.textContent('#vrm-confirm');
      for (const s of ['导入 VRM 模型「蓝色小肥鱼Deepseek」', '模型名蓝色小肥鱼Deepseek（1.0.0）', '作者木子惡魔', '版权© 木子惡魔', '联系方式https://github.com/sunfish1728', '参考https://github.com/sunfish1728/deepcoin-avatars', '谁可以扮演仅作者本人', '商用仅限个人非商业使用', '再分发不允许', '修改禁止修改', '署名需要署名', '授权条款https://vrm.dev/licenses/1.0/']) assert.ok(t.includes(s), `missing: ${s}`);
      const rs = await page.$$eval('#vrm-confirm .vrm-restrictions li', (ls) => ls.map((l) => l.dataset.id));
      assert.deepEqual(rs.slice(0, 5), ['no-redistribution', 'no-modification', 'credit-required', 'personal-non-profit', 'no-sexual']);
      assert.match(t, /不可再分发：仅限本机使用/);
      assert.match(t, /禁止性表现：该模型在 18\+ 内容\/成人服饰下不可用/);
      await page.screenshot({ path: path.join(OUT, 'vrmui-confirm.png') });
      return rs.join(', ');
    }, page);

    await step(S, '取消导入 removes the pack again', async () => {
      await page.click('#vrm-confirm [data-act="cancel"]');
      await page.waitForFunction(() => /已取消导入/.test(document.getElementById('panel-msg').textContent));
      await page.waitForFunction(() => !document.querySelector('.pack-opt[data-pack^="vrm-"]'));
      assert.deepEqual(packDirs(), []);
      return (await msg()).trim();
    }, page);

    await step(S, '使用这个模型: the pack is made and worn; the card reads VRM · N 套服饰 · 作者, credit stays visible', async () => {
      await importFrom(whale);
      await page.waitForSelector('#vrm-confirm');
      await page.click('#vrm-confirm [data-act="use"]');
      await page.waitForSelector(`.pack-opt.on[data-pack="${WID}"]`);
      assert.match(await msg(), /已导入 VRM 模型「蓝色小肥鱼Deepseek」并换上（作者：木子惡魔）/);
      const line = await page.textContent(`.pack-opt[data-pack="${WID}"] .meta span`);
      assert.match(line, /^VRM · \d+ 套服饰 · 木子惡魔 · 本地导入$/);
      assert.equal(await page.textContent(`.pack-opt[data-pack="${WID}"] .vrm-credit`), '署名：木子惡魔（模型授权要求署名）');
      assert.deepEqual(packDirs(), [WID]);
      await page.locator(`.pack-opt[data-pack="${WID}"]`).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, 'vrmui-card.png') });
      return line;
    }, page);

    await step(S, '导出… is disabled for the non-redistributable model, with the reason; main refuses it too', async () => {
      const ex = page.locator(`.pack-opt[data-pack="${WID}"] .pack-export`);
      assert.equal(await ex.isDisabled(), true);
      assert.match(await ex.getAttribute('title'), /不允许再分发/);
      const why = await page.textContent(`.vrm-noexport[data-pack="${WID}"]`);
      assert.match(why, /导出已禁用：这个 VRM 模型的授权不允许再分发/);
      await page.evaluate((p) => window.pet.debugNextSave(p), path.join(fix, 'should-not-exist.zip'));
      const r = await page.evaluate((id) => window.pet.exportPack(id), WID);
      await page.evaluate(() => window.pet.debugNextSave(''));
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'no-redistribution');
      assert.equal(fs.existsSync(path.join(fix, 'should-not-exist.zip')), false);
      return `${why.trim()} · IPC: ${r.reason}`;
    }, page);

    await step(S, '授权信息 on the card opens the license details; the license link goes to the system browser', async () => {
      await page.click(`.pack-opt[data-pack="${WID}"] .vrm-info`);
      await page.waitForSelector(`.pack-list .vrm-license[data-pack="${WID}"]`);
      const t = await page.textContent(`.pack-list .vrm-license[data-pack="${WID}"]`);
      assert.match(t, /VRM 1\.0 授权：仅限个人非商业使用 \/ 不可再分发 \/ 禁止修改 \/ 需署名/);
      assert.match(t, /作者木子惡魔/);
      await page.locator(`.pack-list .vrm-license[data-pack="${WID}"]`).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, 'vrmui-license.png') });
      await page.click(`.pack-list .vrm-license[data-pack="${WID}"] a[href="https://vrm.dev/licenses/1.0/"]`);
      await page.waitForFunction(async () => (await window.pet.debugOpenedLinks()).length > 0);
      const links = await page.evaluate(() => window.pet.debugOpenedLinks());
      assert.deepEqual(links, ['https://vrm.dev/licenses/1.0/']);
      fs.writeFileSync(path.join(OUT, 'vrmui-opened-links.json'), JSON.stringify({ clicked: 'a[href="https://vrm.dev/licenses/1.0/"] in 授权信息', mainProcessOpenLinkLog: links, note: 'PIXELPET_TEST=1: main records the URL instead of shell.openExternal; outside tests open-link calls shell.openExternal (system browser)' }, null, 2));
      assert.equal((await page.evaluate(() => window.pet.openLink('javascript:alert(1)'))).ok, false);
      return `opened ${links.join(', ')}`;
    }, page);

    await step(S, 'a redistributable model can be exported as a .zip that imports back', async () => {
      await importFrom(open);
      await page.waitForSelector('#vrm-confirm');
      assert.equal(await page.locator('#vrm-confirm .vrm-restrictions').count(), 0, 'a fully open model lists no restriction');
      await page.click('#vrm-confirm [data-act="use"]');
      await page.waitForSelector(`.pack-opt.on[data-pack="${OID}"]`);
      assert.equal(await page.locator(`.pack-opt[data-pack="${OID}"] .vrm-credit`).count(), 0, 'no credit required: no credit line');
      const zip = path.join(fix, 'open-fish-export.zip');
      await page.evaluate((p) => window.pet.debugNextSave(p), zip);
      await page.click(`.pack-opt[data-pack="${OID}"] .pack-export`);
      await page.waitForFunction(() => /已导出/.test(document.getElementById('panel-msg').textContent));
      const listing = execFileSync('python3', ['-m', 'zipfile', '-l', zip], { encoding: 'utf8' });
      assert.match(listing, /pack\.json/);
      assert.match(listing, /open-fish\.vrm/);
      return (await msg()).trim();
    }, page);

    await step(S, 'an 18+ VRM pack cannot be made from a model whose license forbids sexual usage', async () => {
      const r = await page.evaluate((d) => window.pet.debugImportPack(d), adultBad);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => /does not allow sexual usage/.test(e)), r.errors.join(' / '));
      assert.equal(packDirs().includes('vrm-adult-bad'), false);
      return r.errors[0];
    }, page);

    const wardrobeHidden = () => page.evaluate(() => document.getElementById('btn-wardrobe').classList.contains('hidden'));
    const lookKey = () => page.evaluate(() => document.getElementById('pet-look').dataset.key);
    await step(S, 'a single-model VRM pack has no 衣柜; with adult content off, an allowed 18+ VRM pack is not offered, and adult outfits stay hidden', async () => {
      // Open Fish (one .vrm) is worn since the export step: one model cannot change clothes, so 衣柜 is
      // hidden by design (520d86c) and no other outfit can be put on
      await page.click('#panel-close');
      await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), OID);
      assert.equal(await wardrobeHidden(), true, 'one VRM model: no 衣柜');
      const eqP = await page.evaluate(() => window.pet.equipOutfit('pajamas'));
      assert.equal(eqP.ok, false, 'no other outfit to change into');
      const eqS = await page.evaluate(() => window.pet.equipOutfit('scarf'));
      assert.equal(eqS.ok, false, 'not even a stranger-stage outfit');
      await page.screenshot({ path: path.join(OUT, 'vrmui-single-look-no-wardrobe.png') });
      const single = `single model ${await lookKey()}: #btn-wardrobe hidden, equipOutfit(pajamas) → ${eqP.reason}, equipOutfit(scarf) → ${eqS.reason}`;
      const r = await page.evaluate((d) => window.pet.debugImportPack(d), adultOk);
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      const rm = await page.evaluate((d) => window.pet.debugImportPack(d), multi);
      assert.equal(rm.ok, true, JSON.stringify(rm.errors));
      await openCurrentPage(page);
      const listed = await page.$$eval('.pack-list .pack-opt', (os) => os.map((o) => o.dataset.pack));
      assert.ok(!listed.includes('vrm-adult-open'), listed.join(', '));
      assert.ok(listed.includes('vrm-multi-open'), listed.join(', '));
      await page.click('#panel-close');
      // nor can she become that character another way (T-2764: every pack is a character): refused, with the reason
      const set = await page.evaluate(() => window.pet.switchCharacter('vrm-adult-open'));
      assert.deepEqual([set.ok, set.reason], [false, 'adult'], JSON.stringify(set));
      await page.waitForTimeout(500);
      assert.ok(!(await lookKey()).startsWith('vrm-adult-open/'), await lookKey());
      // the multi-look VRM pack has a wardrobe, with no adult card in it
      await openCurrentPage(page);
      await page.click('.pack-opt[data-pack="vrm-multi-open"] .pick');
      await page.waitForSelector('.pack-opt.on[data-pack="vrm-multi-open"]');
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key.startsWith('vrm-multi-open/'));
      assert.equal(await wardrobeHidden(), false, 'several VRM models: 衣柜 shown');
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('#panel:not(.hidden) .card');
      const cards = await page.$$eval('.card', (cs) => cs.map((c) => ({ id: c.dataset.outfit, locked: c.classList.contains('locked'), adult: !!c.querySelector('.tag.adult') })));
      assert.deepEqual(cards.map((c) => c.id), ['daily', 'pajamas', 'yukata']);
      assert.equal(cards.filter((c) => c.adult).length, 0);
      const eq = await page.evaluate(() => window.pet.equipOutfit('maid'));
      assert.equal(eq.ok, false);
      return `${single} | 外观: ${listed.join(', ')} (no vrm-adult-open); switchCharacter(vrm-adult-open) → ok=${set.ok} reason=${set.reason}, look ${await lookKey()}; vrm-multi-open 衣柜: ${cards.map((c) => c.id).join(', ')} (0 adult); equipOutfit(maid) → ${eq.reason}`;
    }, page);

    await step(S, 'the VRM pack outfits stay locked by affection in the wardrobe, and a locked one cannot be worn', async () => {
      const cards = await page.$$eval('.card', (cs) => cs.map((c) => ({ id: c.dataset.outfit, locked: c.classList.contains('locked'), vrm: !!c.querySelector('.vrm-look'), st: c.querySelector('.st').textContent })));
      const locked = cards.filter((c) => c.locked);
      assert.deepEqual(locked.map((c) => c.id), ['pajamas', 'yukata'], 'a new companion: the close / flirty looks are locked');
      assert.equal(cards.find((c) => c.id === 'daily').locked, false);
      assert.ok(locked.every((c) => c.vrm && /🔒/.test(c.st)), JSON.stringify(locked));
      // the importer's 1×1 stand-in picture is not shown: the VRM tile is
      await page.waitForFunction(() => [...document.querySelectorAll('.card .vrm-look img')].every((i) => i.complete && i.hidden));
      await page.click(`.card[data-outfit="${locked[0].id}"]`);
      await page.waitForFunction(() => /还没解锁/.test(document.getElementById('panel-msg').textContent));
      await page.screenshot({ path: path.join(OUT, 'vrmui-wardrobe.png') });
      const r = await page.evaluate((id) => window.pet.equipOutfit(id), locked[0].id);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'locked');
      return `${locked.length}/${cards.length} locked: ${locked.map((c) => c.id).join(', ')}; equipOutfit(${locked[0].id}) → ${r.reason}`;
    }, page);

    await step(S, 'with 18+ on but affection low, the 18+ VRM pack\'s adult outfit shows locked and cannot be worn', async () => {
      await page.click('#panel-close');
      await page.evaluate(() => window.pet.setAdult(true));
      await openCurrentPage(page);
      await page.waitForSelector('.pack-opt[data-pack="vrm-adult-open"]');
      await page.click('.pack-opt[data-pack="vrm-adult-open"] .pick');
      await page.waitForSelector('.pack-opt.on[data-pack="vrm-adult-open"]');
      assert.match(await page.textContent('.pack-opt[data-pack="vrm-adult-open"] .meta span'), /^18\+ · VRM · \d+ 套服饰 · Maker/);
      await page.click('#panel-close');
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('.card[data-outfit="maid"]');
      assert.equal(await page.locator('.card[data-outfit="maid"]').getAttribute('class'), 'card locked');
      const r = await page.evaluate(() => window.pet.equipOutfit('maid'));
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'locked');
      await page.screenshot({ path: path.join(OUT, 'vrmui-adult-locked.png') });
      await page.click('#panel-close');
      return `maid: ${r.reason}`;
    }, page);

    await step(S, 'with 18+ on and affection full, the allowed 18+ VRM pack unlocks maid; switching 18+ off takes it away again', async () => {
      await page.evaluate(() => window.pet.unlockAll('dafeiyu'));
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('.card[data-outfit="maid"]:not(.locked)');
      await page.click('.card[data-outfit="maid"]');
      await page.waitForSelector('.card.equipped[data-outfit="maid"]');
      await page.screenshot({ path: path.join(OUT, 'vrmui-adult-unlocked.png') });
      await page.click('#panel-close');
      await page.evaluate(() => window.pet.setAdult(false));
      await page.waitForFunction(() => !document.getElementById('pet-look').dataset.key.includes('/maid'));
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('#panel:not(.hidden) .card');
      const adult = await page.locator('.card .tag.adult').count();
      assert.equal(adult, 0);
      const key = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
      assert.ok(!key.startsWith('vrm-adult-open/'), key);
      await page.screenshot({ path: path.join(OUT, 'vrmui-adult-off-again.png') });
      await page.click('#panel-close');
      // the 18+ pack is gone from 外观 again
      await openCurrentPage(page);
      const listed = await page.$$eval('.pack-list .pack-opt', (os) => os.map((o) => o.dataset.pack));
      assert.ok(!listed.includes('vrm-adult-open'), listed.join(', '));
      await page.click('#panel-close');
      return `maid worn with 18+ on; 18+ off → look ${key}, ${adult} adult cards, 外观 without vrm-adult-open`;
    }, page);

    await step(S, 'without a 3D renderer loaded, the worn VRM pack shows its VRM tile on the desk', async () => {
      await openCurrentPage(page);
      await page.click(`.pack-opt[data-pack="${WID}"] .pick`);
      await page.waitForSelector(`.pack-opt.on[data-pack="${WID}"]`);
      await page.click('#panel-close');
      await page.waitForSelector('#pet-look .vrm-look .vrm-badge');
      await page.screenshot({ path: path.join(OUT, 'vrmui-desk-no-renderer.png') });
      return `PetVRM loaded: ${await page.evaluate(() => !!window.PetVRM)}`;
    }, page);

    await step(S, 'switching VRM → dafeiyu-pixel → dafeiyu-classic → VRM: the live figure is released and made again', async () => {
      // stand-in for the 3D renderer (another task): records creates / disposes and draws a mark
      await page.evaluate(() => {
        window.__vrm = { created: 0, disposed: 0, live: 0 };
        window.PetVRM = { createFigure(canvas) {
          window.__vrm.created++; window.__vrm.live++;
          const g = canvas.getContext('2d');
          let gone = false;
          return { ready: Promise.resolve(true), draw() { if (!gone) { g.clearRect(0, 0, canvas.width, canvas.height); g.fillStyle = '#4a7bd0'; g.fillRect(100, 120, 130, 300); canvas.dataset.frame = 'vrm'; } }, dispose() { gone = true; window.__vrm.disposed++; window.__vrm.live--; } };
        } };
      });
      const pick = async (id) => {
        await openCurrentPage(page);
        // already worn: the look is redrawn so the stand-in renderer draws it
        if (await page.locator(`.pack-opt.on[data-pack="${id}"]`).count()) await page.click('.pack-opt[data-pack="dafeiyu-pixel"] .pick');
        await page.waitForSelector('.pack-opt.on[data-pack="dafeiyu-pixel"], .pack-opt:not(.on)[data-pack="' + id + '"]');
        if (!(await page.locator(`.pack-opt.on[data-pack="${id}"]`).count())) await page.click(`.pack-opt[data-pack="${id}"] .pick`);
        await page.waitForSelector(`.pack-opt.on[data-pack="${id}"]`);
        await page.click('#panel-close');
        await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), id);
      };
      const stat = () => page.evaluate(() => ({ ...window.__vrm, canvas: !!document.querySelector('#pet-look canvas.vrm'), sprite: !!document.querySelector('#pet-look canvas.sprite:not(.vrm), #pet-look img') }));
      const trail = [];
      await pick(WID);
      await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.frame === 'vrm'; });
      let s = await stat();
      assert.deepEqual([s.created, s.live, s.canvas], [1, 1, true]);
      trail.push(`VRM ${JSON.stringify(s)}`);
      await page.screenshot({ path: path.join(OUT, 'vrmui-desk-vrm.png') });
      for (const id of ['dafeiyu-pixel', 'dafeiyu-classic']) {
        await pick(id);
        await page.waitForFunction(() => window.__vrm.live === 0, null, { timeout: 5000 });
        s = await stat();
        assert.equal(s.canvas, false);
        assert.equal(s.sprite, true, `${id} drawn`);
        trail.push(`${id} ${JSON.stringify(s)}`);
        await page.screenshot({ path: path.join(OUT, `vrmui-desk-${id}.png`) });
      }
      await pick(WID);
      await page.waitForFunction(() => window.__vrm.live === 1 && document.querySelector('#pet-look canvas.vrm'));
      s = await stat();
      assert.deepEqual([s.created, s.disposed, s.live], [2, 1, 1]);
      trail.push(`VRM again ${JSON.stringify(s)}`);
      return trail.join(' → ');
    }, page);

    await step(S, 'no renderer error on the page', async () => {
      assert.deepEqual(errors.filter((e) => !/Autofill|net::ERR_FILE_NOT_FOUND/.test(e)), []);
    }, page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ vrm / vrmimport
// The three-vrm renderer with a homemade model made on the spot: e2e/vrm.js (run.js is over the size limit).
// ⏻ 退出 on the toolbar (T-2827): e2e/quit-button.js
const quitButtonScenario = () => require('./quit-button')({ ROOT, OUT, FAKE_LH, step, launch });
const vrmScenarios = () => require('./vrm')({ ROOT, OUT, FAKE_LH, step, launch, openCurrentPage, clickAct, openAdminWindow, petBounds });
// Live2D 取景 (半身): e2e/live2d-frame.js
const chatUiScenario = () => require('./chat-ui')({ ROOT, OUT, FAKE_LH, step, launch, openAdminWindow })();
const adminChatAcceptance = () => require('./admin-chat')({ ROOT, OUT, FAKE_LH, step, launch, openAdminWindow, say })();
const live2dFrameScenarios = () => require('./live2d-frame')({ ROOT, OUT, FAKE_LH, step, launch, openCurrentPage, openAdminWindow, petBounds });
// 像素 sprites 取景 (半身): e2e/sprite-frame.js
const spriteFrameScenarios = () => require('./sprite-frame')({ ROOT, OUT, FAKE_LH, step, launch, openCurrentPage, openAdminWindow, petBounds });

// ------------------------------------------------------------------ asr (语音输入)
// 🎤 in the chat row: Chromium's fake microphone plays a WAV (--use-file-for-fake-audio-capture), the page
// records it with MediaRecorder, main sends it to a local whisper-shaped server (a mock here: no tokens), and
// the text lands in the chat box. Also 高级设置 → 语音输入, 测试连接, 按住说话, Esc, the failure toast,
// 识别后直接发送 and the microphone permission. With PIXELPET_E2E_WHISPER=<url> (a real whisper-server) and
// PIXELPET_E2E_ASR_WAV=<speech.wav> one more step sends the recording to it (PIXELPET_E2E_ASR_EXPECT: a regex);
// with PIXELPET_E2E_ASR_LOBEHUB=1 another sends it to LobeHub's real recognition (the machine's lh login).
function asrMock() {
  const http = require('node:http');
  const TEXT = '你好，今天我想喂我的宠物吃饼干。';
  const m = { TEXT, mode: 'ok', log: [] };
  const field = (body, name) => { const r = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(body.toString('latin1')); return r ? Buffer.from(r[1], 'latin1').toString('utf8') : null; };
  m.server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const s = body.toString('latin1');
      const fn = /filename="([^"]+)"\r\nContent-Type: ([^\r]+)\r\n\r\n/.exec(s);
      const start = fn ? fn.index + fn[0].length : -1;
      const end = start >= 0 ? s.indexOf('\r\n--', start) : -1;
      const audio = start >= 0 && end > start ? body.subarray(start, end) : Buffer.alloc(0);
      const rec = { at: Date.now(), path: req.url, auth: req.headers.authorization || null, filename: fn && fn[1], type: fn && fn[2], bytes: audio.length, magic: audio.subarray(0, 4).toString('hex'), model: field(body, 'model'), language: field(body, 'language'), format: field(body, 'response_format'), mode: m.mode, status: 0 };
      m.log.push(rec);
      const send = (status, j) => { rec.status = status; res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(j)); };
      if (req.url !== '/v1/audio/transcriptions') return send(404, { error: 'not found' });
      if (m.mode === '500') return send(500, { error: { message: 'model not loaded' } });
      // the connection test sends a silent WAV: no words in it
      if (rec.type === 'audio/wav') return setTimeout(() => send(200, { text: '' }), 50);
      setTimeout(() => send(200, { text: ` ${TEXT} ` }), 600); // the spinner shows for a moment
    });
  });
  return new Promise((resolve) => m.server.listen(0, '127.0.0.1', () => { m.url = `http://127.0.0.1:${m.server.address().port}`; resolve(m); }));
}
// 3 s of a gliding tone, 16 kHz mono: what the fake microphone "hears" (looped)
function toneWav(file, sec = 3, rate = 16000) {
  const n = rate * sec;
  const w = Buffer.alloc(44 + n * 2);
  w.write('RIFF', 0); w.writeUInt32LE(36 + n * 2, 4); w.write('WAVEfmt ', 8); w.writeUInt32LE(16, 16); w.writeUInt16LE(1, 20); w.writeUInt16LE(1, 22);
  w.writeUInt32LE(rate, 24); w.writeUInt32LE(rate * 2, 28); w.writeUInt16LE(2, 32); w.writeUInt16LE(16, 34); w.write('data', 36); w.writeUInt32LE(n * 2, 40);
  let ph = 0;
  for (let i = 0; i < n; i++) { ph += (2 * Math.PI * (300 + 200 * Math.sin(i / rate))) / rate; w.writeInt16LE(Math.round(Math.sin(ph) * 9000), 44 + i * 2); }
  fs.writeFileSync(file, w);
  return file;
}

async function asrScenario() {
  const S = 'asr';
  const SHOTS = path.join(OUT, 'asr');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const mock = await asrMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-asr-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-asrfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const wav = process.env.PIXELPET_E2E_ASR_WAV || toneWav(path.join(data, 'fake-mic.wav'));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video'), args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const t0 = Date.now();
  const chapters = [];
  const chapter = (title) => chapters.push({ at: Math.round((Date.now() - t0) / 1000), title });
  const shot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `asr/${name}.png`; };
  const evidence = [];
  const note = (s) => { evidence.push(s); return s; };
  const getSet = () => page.evaluate(async () => (await window.pet.getSettings()).asr);
  const lastAsr = () => page.evaluate(() => window.petFx.lastAsr());
  const micState = () => page.evaluate(() => window.petFx.micState());
  // 语音输入 is configured in the settings window (设置 → 语音输入, #/asr) now
  let admin = null;
  const openAsr = async () => { admin = await openAdminWindow(app, page, 'asr'); await admin.waitForTimeout(250); return admin; };
  const closeAdmin = async () => { if (admin) await admin.close().catch(() => {}); admin = null; await page.bringToFront(); };
  const ashot = async (name) => { await admin.waitForTimeout(150); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `asr/${name}.png`; };
  // a success / error toast in the settings window ("已保存：<label> → <value>")
  const toast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
  // Segmented / Select controls: @lobehub/ui's Segmented and Select do not pass data-key (or aria-label) on to the
  // DOM, so they are found by their form row's label: the nearest ancestor of the label that holds such a control.
  // Marks it data-e2e-ctl="<label>" (again on every call: a folded field comes back as a new node).
  const ctl = async (a, label, sel) => {
    const ok = await a.evaluate(([l, s]) => {
      const root = document.querySelector('[data-path="/asr"]');
      for (const el of root.querySelectorAll('*')) {
        if (el.childElementCount || el.textContent.trim() !== l) continue;
        let n = el;
        while (n && n !== root && !n.querySelector(s)) n = n.parentElement;
        if (n && n !== root) { n.querySelector(s).setAttribute('data-e2e-ctl', l); return true; }
      }
      return false;
    }, [label, sel]);
    assert.ok(ok, `no ${sel} in the row 「${label}」`);
    return a.locator(`[data-e2e-ctl="${label}"]`);
  };
  const SEG = '[data-segmented-item]';
  const segItems = async (a, label) => (await ctl(a, label, SEG)).evaluate((first) => [...first.parentElement.querySelectorAll('[data-segmented-item]')].map((b) => ({ label: b.getAttribute('aria-label'), on: b.hasAttribute('data-pressed') })));
  const pickSeg = async (label, item) => { await (await ctl(admin, label, SEG)).evaluate(() => {}); await admin.locator(`[data-e2e-ctl="${label}"]`).locator('xpath=..').locator(`[data-segmented-item][aria-label="${item}"]`).click(); };
  const segValue = async (a, label) => ((await segItems(a, label)).find((b) => b.on) || {}).label || null;
  const pickSelect = async (label, option) => { await (await ctl(admin, label, '[role="combobox"]')).click(); await admin.getByRole('option', { name: option }).click(); };
  const saveDraft = async (key, value) => { await admin.fill(`[data-key="${key}"]`, value); await admin.click(`[data-save="${key}"]`); };
  // 测试连接 in the 语音输入 page header: an Alert with the result
  const testConnection = async (timeout = 15000) => {
    await admin.getByRole('button', { name: '测试连接' }).click();
    await admin.waitForFunction(() => /连接正常|连接没有成功/.test(document.querySelector('[data-path="/asr"]').innerText), null, { timeout });
    return admin.evaluate(() => { const a = document.querySelector('[data-path="/asr"] [role="alert"]'); return (a ? a.innerText : document.querySelector('[data-path="/asr"]').innerText.match(/连接(正常|没有成功)[^\n]*\n?[^\n]*/)[0]).replace(/\s+/g, ' ').trim(); });
  };
  const openChatBox = async () => {
    await hover(page);
    if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
    await page.waitForSelector('#chat-input', { state: 'visible' });
  };
  const waitMic = (st, timeout = 10000) => page.waitForFunction((s) => window.petFx.micState() === s, st, { timeout });
  // the outcome after `n` recognitions have been asked of the server
  const settled = () => page.waitForFunction(() => window.petFx.micState() === 'idle', null, { timeout: 30000 });
  try {
    await step(S, 'A0 hatch 大肥鱼; 语音输入 is off by default and 🎤 is not shown', async () => {
      chapter('A0 孵化大肥鱼：语音输入默认关闭，聊天行没有 🎤');
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const a = await getSet();
      assert.equal(a.enabled, false);
      assert.equal(a.autoSend, false);
      await openChatBox();
      assert.equal(await page.isVisible('#chat-mic'), false, '🎤 hidden while 语音输入 is off');
      // the microphone is refused while 语音输入 is off (main.js permission handler)
      const denied = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name));
      assert.equal(denied, 'NotAllowedError');
      await shot('a0-chat-row-no-mic');
      await clickAct(page, 'chat');
      return note(`settings.asr defaults ${JSON.stringify(a)}; 🎤 hidden; getUserMedia(audio) with ASR off → ${denied}`);
    }, page);

    await step(S, 'A1 设置 → 语音输入: switch on, 本地 whisper host, endpoint + model + 中文, 测试连接 ✅', async () => {
      chapter('A1 设置窗口 → 语音输入：开启、选本地 whisper、填地址/模型/语言、测试连接');
      await openAsr();
      // 识别引擎 / 语言 / 识别后直接发送 … are folded away while 语音输入 is off
      assert.equal(await admin.locator('[data-key="asr.autoSend"]').count(), 0);
      assert.equal(await admin.locator(`${SEG}[aria-label="本地服务"]`).count(), 0);
      await ashot('a1-asr-section-default');
      await admin.click('[data-key="asr.enabled"]');
      await toast(/已保存：开启语音输入 → 开/);
      await admin.waitForSelector('[data-key="asr.autoSend"]');
      const engines = await segItems(admin, '识别引擎');
      assert.deepEqual(engines.map((b) => b.label), ['LobeHub 云端', '本地服务', '关闭']);
      assert.equal(await segValue(admin, '识别引擎'), 'LobeHub 云端', 'LobeHub by default');
      await pickSeg('识别引擎', '本地服务');
      await toast(/已保存：识别引擎 → 本地服务/);
      await pickSelect('语言', '中文');
      await toast(/已保存：语言 → 中文/);
      // main refuses a plain-http address that is not on this machine / the LAN (the form only checks the shape)
      await saveDraft('asr.local.endpoint', 'http://evil.example.com:8179');
      await admin.waitForSelector('[data-error="asr.local.endpoint"]');
      const refused = (await admin.textContent('[data-error="asr.local.endpoint"]')).trim();
      assert.match(refused, /https/);
      assert.notEqual((await getSet()).local.endpoint, 'http://evil.example.com:8179');
      await saveDraft('asr.local.endpoint', mock.url);
      await toast(/已保存：地址 → http:\/\/127\.0\.0\.1/);
      await admin.waitForSelector('[data-error="asr.local.endpoint"]', { state: 'detached' });
      await saveDraft('asr.local.model', 'ggml-base');
      await toast(/已保存：模型 → ggml-base/);
      assert.equal((await admin.textContent('[data-has-key="keys.asrlocal"]')).trim(), '未设置', 'no API key for the local host');
      const before = mock.log.length;
      const test = await testConnection();
      assert.match(test, /连接正常/);
      assert.match(test, /local：可用/);
      const req = mock.log[before];
      assert.equal(req.type, 'audio/wav', 'the test sends a silent wav');
      assert.equal(req.model, 'ggml-base');
      assert.equal(req.language, 'zh');
      assert.equal(req.auth, null, 'no key, no Authorization header');
      await ashot('a1-asr-configured-test-ok');
      const a = await getSet();
      assert.equal(a.enabled, true);
      assert.equal(a.engine, 'local');
      assert.equal(a.language, 'zh');
      assert.equal(a.local.endpoint, mock.url);
      assert.equal(a.local.model, 'ggml-base');
      const onDisk = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).asr;
      assert.equal(onDisk.local.endpoint, mock.url);
      await closeAdmin();
      return note(`http://evil.example.com:8179 → 「${refused}」; 测试连接 → 「${test}」; request ${JSON.stringify(req)}; settings.asr ${JSON.stringify(a)}`);
    }, () => admin || page);

    await step(S, 'A2 click 🎤, speak, click again: recording → 识别中 → the text is in the chat box', async () => {
      chapter('A2 点一下 🎤 开始、再点一下结束：录音中 → 识别中 → 文字出现在输入框');
      await openChatBox();
      assert.equal(await page.isVisible('#chat-mic'), true, '🎤 shown');
      await page.fill('#chat-input', '');
      const before = mock.log.length;
      await page.click('#chat-mic');
      await waitMic('recording');
      await page.waitForTimeout(1600);
      const recBtn = await page.textContent('#chat-mic');
      const recLine = await page.textContent('#mic-status');
      assert.match(recLine, /正在听 \d+s/);
      assert.equal(await page.getAttribute('#chat-input', 'placeholder'), '正在听…');
      // 🎤 too: she is listening while you speak (look, the ear over her)
      const lis = await page.evaluate(() => { const f = window.petFx.state(); return { state: f.state, listening: f.listening, fx: f.fx }; });
      assert.deepEqual(lis, { state: 'look', listening: true, fx: '👂' }, 'listening while 🎤 records');
      await shot('a2-recording');
      await page.click('#chat-mic');
      await waitMic('transcribing');
      const busyLine = await page.textContent('#mic-status');
      assert.match(busyLine, /识别中/);
      await shot('a2-transcribing');
      await settled();
      await page.waitForFunction((t) => document.getElementById('chat-input').value === t, mock.TEXT, { timeout: 5000 });
      const r = await lastAsr();
      const req = mock.log[before];
      assert.equal(mock.log.length, before + 1);
      assert.equal(req.path, '/v1/audio/transcriptions');
      assert.equal(req.filename, 'clip.webm');
      assert.equal(req.type, 'audio/webm');
      assert.equal(req.magic, '1a45dfa3', 'a real WebM (EBML) clip from MediaRecorder');
      assert.ok(req.bytes > 2000, `${req.bytes} bytes`);
      assert.equal(req.language, 'zh');
      assert.equal(r.ok, true);
      assert.equal(r.provider, 'local');
      assert.equal(await page.isVisible('#mic-status'), false);
      // the microphone is released once the clip is taken
      const live = await page.evaluate(() => window.petFx.micState());
      assert.equal(live, 'idle');
      await shot('a2-text-in-chat-input');
      return note(`button while recording 「${recBtn.trim()}」, status 「${recLine.trim()}」 → 「${busyLine.trim()}」; server got ${req.filename} ${req.type} ${req.bytes} bytes magic=${req.magic} model=${req.model} language=${req.language}; clip ${r.clipMs} ms, ${r.ms} ms to text; #chat-input = 「${await page.inputValue('#chat-input')}」`);
    }, page);

    await step(S, 'A3 按住说话: hold 🎤 for 1.5 s and let go; the text is added after what is typed', async () => {
      chapter('A3 按住 🎤 说话、松开结束：文字接在已输入内容后面');
      await openChatBox();
      await page.fill('#chat-input', '我说：');
      const before = mock.log.length;
      const box = await page.locator('#chat-mic').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await waitMic('recording');
      await page.waitForTimeout(1500);
      assert.equal(await micState(), 'recording', 'still listening while held');
      await shot('a3-holding');
      await page.mouse.up();
      await settled();
      assert.equal(mock.log.length, before + 1);
      const v = await page.inputValue('#chat-input');
      assert.equal(v, `我说： ${mock.TEXT}`);
      const r = await lastAsr();
      assert.ok(r.clipMs >= 1400, `clip ${r.clipMs} ms`);
      await shot('a3-hold-text-appended');
      return note(`held ${r.clipMs} ms → #chat-input = 「${v}」`);
    }, page);

    await step(S, 'A4 Esc while listening throws the recording away; nothing is sent', async () => {
      chapter('A4 录音中按 Esc：丢弃，不发送');
      await openChatBox();
      await page.fill('#chat-input', '');
      const before = mock.log.length;
      await page.click('#chat-mic');
      await waitMic('recording');
      await page.waitForTimeout(800);
      await page.keyboard.press('Escape');
      await waitMic('idle');
      await page.waitForTimeout(700);
      assert.equal(mock.log.length, before, 'no request');
      assert.equal(await page.inputValue('#chat-input'), '');
      assert.equal((await lastAsr()).reason, 'canceled');
      return note('Esc → micState idle, lastAsr.reason=canceled, 0 requests');
    }, page);

    await step(S, 'A5 a quick tap is too short: toast, no request', async () => {
      chapter('A5 太短的点按：提示，不请求');
      await openChatBox();
      const before = mock.log.length;
      await page.click('#chat-mic');
      await waitMic('recording');
      await page.click('#chat-mic');
      await waitMic('idle');
      await page.waitForSelector('#unlock-toast:not(.hidden)');
      const t = await page.textContent('#unlock-toast');
      assert.match(t, /太短了/);
      assert.equal(mock.log.length, before);
      await shot('a5-too-short-toast');
      await page.click('#toast-close');
      return note(`toast 「${t.replace(/\s+/g, ' ').replace('×', '').trim()}」`);
    }, page);

    await step(S, 'A6 the server fails (HTTP 500): a failure toast with 去设置; the box keeps what was typed', async () => {
      chapter('A6 识别服务出错：失败 toast，输入框内容保留');
      mock.mode = '500';
      await openChatBox();
      await page.fill('#chat-input', '原来的草稿');
      await page.click('#chat-mic');
      await waitMic('recording');
      await page.waitForTimeout(1000);
      await page.click('#chat-mic');
      await settled();
      await page.waitForSelector('#unlock-toast.notice:not(.hidden)');
      const t = await page.textContent('#unlock-toast');
      assert.match(t, /语音输入没成功/);
      assert.match(t, /识别服务返回了错误 500/);
      assert.equal(await page.isVisible('#toast-open'), true);
      assert.equal(await page.inputValue('#chat-input'), '原来的草稿');
      const r = await lastAsr();
      assert.equal(r.reason, 'http-500');
      await shot('a6-failure-toast');
      mock.mode = 'ok';
      // 去设置 opens the settings window at 语音输入
      assert.equal(await page.getAttribute('#toast-open', 'data-admin'), 'asr');
      await page.click('#toast-open');
      for (let i = 0; i < 100 && !admin; i++) {
        admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
        if (!admin) await page.waitForTimeout(100);
      }
      assert.ok(admin, 'the settings window opened');
      await admin.waitForSelector('[data-path="/asr"]', { timeout: 15000 });
      assert.equal(await admin.getAttribute('[data-key="asr.enabled"]', 'aria-checked'), 'true');
      assert.equal(await segValue(admin, '识别引擎'), '本地服务');
      const route = await admin.evaluate(() => location.hash);
      await ashot('a6-toast-goes-to-settings');
      await closeAdmin();
      return note(`toast 「${t.replace(/\s+/g, ' ').replace('×', '').trim()}」; lastAsr ${JSON.stringify({ ok: r.ok, reason: r.reason, message: r.message })}; 去设置 → settings window ${route}`);
    }, () => admin || page);

    await step(S, 'A6b the local host is not running: 连不上 toast with the address; with 换另一个引擎 the clip goes to LobeHub', async () => {
      chapter('A6b 本地服务没开：提示“连不上本地识别服务”；勾选换另一个引擎后改走 LobeHub');
      const http = require('node:http');
      const dead = await new Promise((resolve) => { const sv = http.createServer(); sv.listen(0, '127.0.0.1', () => { const port = sv.address().port; sv.close(() => resolve(`http://127.0.0.1:${port}`)); }); });
      await openAsr();
      await saveDraft('asr.local.endpoint', dead);
      await toast(/已保存：地址 → http:\/\/127\.0\.0\.1/);
      assert.equal((await getSet()).local.endpoint, dead);
      await closeAdmin();
      await openChatBox();
      await page.fill('#chat-input', '草稿还在');
      await page.click('#chat-mic');
      await waitMic('recording');
      await page.waitForTimeout(1000);
      await page.click('#chat-mic');
      await settled();
      await page.waitForSelector('#unlock-toast.notice:not(.hidden)');
      const t = await page.textContent('#unlock-toast');
      assert.match(t, /语音输入没成功/);
      assert.match(t, /连不上本地识别服务/);
      assert.ok(t.includes(dead), 'the toast names the address');
      assert.equal(await page.inputValue('#chat-input'), '草稿还在');
      const r = await lastAsr();
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'network');
      await shot('a6b-local-unreachable-toast');
      await page.click('#toast-close');
      // 用不了时换另一个引擎: the same dead host, the clip is recognised by LobeHub (the fake lh) instead
      await openAsr();
      await admin.click('[data-key="asr.fallback"]');
      await toast(/已保存：用不了时换另一个引擎 → 开/);
      assert.equal((await getSet()).fallback, true);
      await closeAdmin();
      await openChatBox();
      await page.fill('#chat-input', '');
      await page.click('#chat-mic');
      await waitMic('recording');
      await page.waitForTimeout(1000);
      await page.click('#chat-mic');
      await settled();
      const f = await lastAsr();
      assert.equal(f.ok, true);
      assert.equal(f.provider, 'lobehub');
      assert.deepEqual(f.fellBackFrom.map((x) => x.id), ['local']);
      const box = await page.inputValue('#chat-input');
      assert.match(box, /^heard gpt-4o-mini-transcribe zh/);
      await shot('a6b-fallback-lobehub-text');
      // back to the mock host, fallback off, for the steps after this one
      await openAsr();
      await admin.click('[data-key="asr.fallback"]');
      await toast(/已保存：用不了时换另一个引擎 → 关/);
      await saveDraft('asr.local.endpoint', mock.url);
      await toast(new RegExp(`已保存：地址 → ${mock.url.replace(/[.:/]/g, '\\$&')}`));
      const back = await getSet();
      assert.equal(back.fallback, false);
      assert.equal(back.local.endpoint, mock.url);
      await closeAdmin();
      await openChatBox();
      await page.fill('#chat-input', '');
      return note(`dead host ${dead} → toast 「${t.replace(/\s+/g, ' ').replace('×', '').trim()}」, lastAsr ${JSON.stringify({ ok: r.ok, reason: r.reason, tried: r.tried })}; fallback on → provider ${f.provider}, fellBackFrom ${JSON.stringify(f.fellBackFrom)}, box 「${box}」`);
    }, page);

    await step(S, 'A7 识别后直接发送: the recognised text goes to her at once and she answers', async () => {
      chapter('A7 打开“识别后直接发送”：识别后直接发给她');
      await openAsr();
      await admin.click('[data-key="asr.autoSend"]');
      await toast(/已保存：识别后直接发送 → 开/);
      assert.equal((await getSet()).autoSend, true);
      await closeAdmin();
      await openChatBox();
      await page.fill('#chat-input', '');
      await page.click('#chat-mic');
      await waitMic('recording');
      await page.waitForTimeout(1200);
      await page.click('#chat-mic');
      await settled();
      const r = await lastAsr();
      assert.equal(r.sent, true);
      const reply = await waitReply(page, 30000);
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
      assert.equal(await page.inputValue('#chat-input'), '');
      await shot('a7-autosend-reply');
      // 聊天记录 (core/chat-log.js) on disk has it as the owner's message
      const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      const logs = walk(data).filter((f) => !/settings\.json$|\.wav$/.test(f) && fs.statSync(f).size < 5e6 && fs.readFileSync(f, 'utf8').includes(mock.TEXT));
      const said = logs.length > 0;
      assert.ok(said, 'the recognised text is in 聊天记录');
      return note(`sent 「${mock.TEXT}」 → her reply 「${reply.trim().slice(0, 80)}」; in 聊天记录: ${logs.map((f) => path.relative(data, f)).join(', ')}`);
    }, page);

    if (process.env.PIXELPET_E2E_WHISPER) {
      await step(S, 'A8 a real whisper host: the fake microphone\'s speech is recognised', async () => {
        chapter('A8 真实 whisper.cpp 服务：识别假麦克风播放的语音');
        await openAsr();
        await admin.click('[data-key="asr.autoSend"]');
        await toast(/已保存：识别后直接发送 → 关/);
        await saveDraft('asr.local.endpoint', process.env.PIXELPET_E2E_WHISPER);
        await toast(/已保存：地址 → /);
        await saveDraft('asr.local.model', 'whisper-1');
        await toast(/已保存：模型 → whisper-1/);
        // 测试连接 against the real host, as docs/asr.md §4.1 tells the owner to
        const tested = await testConnection(60000);
        assert.match(tested, /连接正常/);
        await ashot('a8-real-whisper-settings-test');
        await closeAdmin();
        await openChatBox();
        await page.fill('#chat-input', '');
        await page.click('#chat-mic');
        await waitMic('recording');
        await page.waitForTimeout(Number(process.env.PIXELPET_E2E_ASR_MS || 4500));
        await page.click('#chat-mic');
        await settled();
        const r = await lastAsr();
        assert.equal(r.ok, true, JSON.stringify(r));
        const v = await page.inputValue('#chat-input');
        if (process.env.PIXELPET_E2E_ASR_EXPECT) assert.match(v, new RegExp(process.env.PIXELPET_E2E_ASR_EXPECT));
        await shot('a8-real-whisper-text');
        return note(`测试连接 → 「${tested}」; real whisper ${process.env.PIXELPET_E2E_WHISPER}: clip ${r.clipMs} ms ${r.bytes} bytes → ${r.ms} ms → 「${v}」`);
      }, page);
    }

    if (process.env.PIXELPET_E2E_ASR_LOBEHUB) {
      // LobeHub's real recognition (lh generate asr, the machine's own lh login; costs a few Credits): the fake lh
      // hands `generate asr` to the real CLI while FAKE_LH_DIR/asr-real exists. Needs a speech WAV (PIXELPET_E2E_ASR_WAV).
      await step(S, 'A8b LobeHub 云端识别 for real: the fake microphone\'s speech is recognised by lh generate asr', async () => {
        chapter('A8b 真实 LobeHub 云端识别：引擎切到 LobeHub，识别假麦克风播放的语音');
        fs.writeFileSync(path.join(fakeDir, 'asr-real'), '1');
        try {
          await openAsr();
          if ((await getSet()).autoSend) { await admin.click('[data-key="asr.autoSend"]'); await toast(/已保存：识别后直接发送 → 关/); }
          await pickSeg('识别引擎', 'LobeHub 云端');
          await toast(/已保存：识别引擎 → LobeHub 云端/);
          const r0 = await adminSet(admin, 'asr.lobehub.model', process.env.PIXELPET_E2E_ASR_LOBEHUB_MODEL || 'gpt-4o-mini-transcribe');
          assert.equal(r0.ok, true, JSON.stringify(r0));
          await ashot('a8b-lobehub-settings');
          const tested = await testConnection(90000);
          assert.match(tested, /lobehub：可用/);
          await ashot('a8b-lobehub-test-ok');
          await closeAdmin();
          await openChatBox();
          await page.fill('#chat-input', '');
          await page.click('#chat-mic');
          await waitMic('recording');
          await page.waitForTimeout(Number(process.env.PIXELPET_E2E_ASR_MS || 4500));
          await page.click('#chat-mic');
          await waitMic('transcribing');
          await shot('a8b-lobehub-transcribing');
          await page.waitForFunction(() => window.petFx.micState() === 'idle', null, { timeout: 90000 });
          const r = await lastAsr();
          assert.equal(r.ok, true, JSON.stringify(r));
          assert.equal(r.provider, 'lobehub');
          const v = await page.inputValue('#chat-input');
          if (process.env.PIXELPET_E2E_ASR_EXPECT) assert.match(v, new RegExp(process.env.PIXELPET_E2E_ASR_EXPECT));
          await shot('a8b-lobehub-text');
          return note(`测试连接 → 「${tested}」; real LobeHub (${(await getSet()).lobehub.model}): clip ${r.clipMs} ms ${r.bytes} bytes → ${r.ms} ms → 「${v}」`);
        } finally {
          fs.rmSync(path.join(fakeDir, 'asr-real'), { force: true });
          await openAsr();
          assert.equal((await adminSet(admin, 'asr.engine', 'local')).ok, true);
          await closeAdmin();
        }
      }, page);
    }

    await step(S, 'A9 the camera is never granted; engine 关闭 hides 🎤', async () => {
      chapter('A9 摄像头不放行；引擎选“关闭”后 🎤 消失');
      const cam = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then((s) => { s.getTracks().forEach((t) => t.stop()); return 'granted'; }, (e) => e.name));
      assert.equal(cam, 'NotAllowedError');
      await openAsr();
      await pickSeg('识别引擎', '关闭');
      await toast(/已保存：识别引擎 → 关闭/);
      assert.equal((await getSet()).engine, 'off');
      await closeAdmin();
      await openChatBox();
      assert.equal(await page.isVisible('#chat-mic'), false);
      await shot('a9-engine-off-no-mic');
      return note(`getUserMedia(video) → ${cam}; engine off → 🎤 hidden`);
    }, page);

    await step(S, 'A9b the microphone is refused by the system: 没有麦克风权限 toast, no request, nothing breaks', async () => {
      chapter('A9b 系统拒绝麦克风：提示“没有麦克风权限”，不发请求，界面正常');
      // what main answers on macOS when 隐私与安全性 → 麦克风 is off (systemPreferences 'denied')
      await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler('asr-mic-access'); ipcMain.handle('asr-mic-access', () => 'denied'); });
      await openAsr();
      assert.equal((await adminSet(admin, 'asr.engine', 'local')).ok, true);
      await closeAdmin();
      assert.equal((await getSet()).engine, 'local');
      const before = mock.log.length;
      await openChatBox();
      await page.fill('#chat-input', '打字还能用');
      await page.click('#chat-mic');
      await settled();
      await page.waitForSelector('#unlock-toast.notice:not(.hidden)');
      const t = await page.textContent('#unlock-toast');
      assert.match(t, /语音输入没成功/);
      assert.match(t, /没有麦克风权限/);
      assert.equal(mock.log.length, before, 'nothing is sent');
      assert.equal(await micState(), 'idle');
      assert.equal(await page.inputValue('#chat-input'), '打字还能用');
      const r = await lastAsr();
      assert.equal(r.reason, 'mic-denied');
      await shot('a9b-mic-denied-toast');
      await page.click('#toast-close');
      // Chromium's own refusal (getUserMedia NotAllowedError) maps to the same reason
      await app.evaluate(({ ipcMain, session }) => {
        ipcMain.removeHandler('asr-mic-access'); ipcMain.handle('asr-mic-access', () => 'granted');
        session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));
        session.defaultSession.setPermissionCheckHandler(() => false);
      });
      await page.click('#chat-mic');
      await settled();
      await page.waitForSelector('#unlock-toast.notice:not(.hidden)');
      const t2 = await page.textContent('#unlock-toast');
      const r2 = await lastAsr();
      assert.match(t2, /没有麦克风权限/);
      assert.equal(r2.reason, 'mic-denied');
      assert.equal(mock.log.length, before);
      await page.click('#toast-close');
      await page.fill('#chat-input', '');
      // A10 expects the engine 关闭 as A9 left it
      await openAsr();
      assert.equal((await adminSet(admin, 'asr.engine', 'off')).ok, true);
      await closeAdmin();
      return note(`system denied → toast 「${t.replace(/\s+/g, ' ').replace('×', '').trim()}」, lastAsr ${JSON.stringify({ ok: r.ok, reason: r.reason })}; Chromium denied → ${JSON.stringify({ reason: r2.reason, message: r2.message })}; requests sent: ${mock.log.length - before}`);
    }, page);

    await step(S, 'no console errors or page errors', async () => {
      assert.deepEqual(errors, []);
      return `${errors.length} errors`;
    }, null);

    let again = null;
    await step(S, 'A10 after a restart 设置 → 语音输入 shows what was saved', async () => {
      chapter('A10 重启后：语音输入设置仍是之前保存的');
      await app.close();
      again = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { args: ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] });
      const p = again.page;
      await p.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await p.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      admin = await openAdminWindow(again.app, p, 'asr');
      await admin.waitForSelector('[data-key="asr.autoSend"]');
      const ui = {
        on: (await admin.getAttribute('[data-key="asr.enabled"]', 'aria-checked')) === 'true',
        engine: await segValue(admin, '识别引擎'),
        language: (await (await ctl(admin, '语言', '[role="combobox"]')).innerText()).trim(),
        autoSend: (await admin.getAttribute('[data-key="asr.autoSend"]', 'aria-checked')) === 'true',
        endpoint: await admin.inputValue('[data-key="asr.local.endpoint"]'),
        model: await admin.inputValue('[data-key="asr.local.model"]'),
      };
      // A8 / A8b (real hosts) switch 识别后直接发送 off again
      assert.deepEqual(ui, { on: true, engine: '关闭', language: '中文', autoSend: !(process.env.PIXELPET_E2E_WHISPER || process.env.PIXELPET_E2E_ASR_LOBEHUB), endpoint: process.env.PIXELPET_E2E_WHISPER || mock.url, model: process.env.PIXELPET_E2E_WHISPER ? 'whisper-1' : 'ggml-base' });
      await admin.waitForTimeout(150);
      await admin.screenshot({ path: path.join(SHOTS, 'a10-after-restart-settings.png') });
      // the engine back to 本地: 🎤 is there again in the restarted app
      await pickSeg('识别引擎', '本地服务');
      await toast(/已保存：识别引擎 → 本地服务/);
      await admin.close().catch(() => {});
      admin = null;
      await p.bringToFront();
      await hover(p);
      await clickAct(p, 'chat');
      assert.equal(await p.isVisible('#chat-mic'), true);
      return note(`relaunched with the same data dir → 语音输入 controls ${JSON.stringify(ui)}; engine → local shows 🎤 again`);
    }, () => again && again.page);
    if (again) await again.app.close().catch(() => {});
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'asr-log.txt'), evidence.join('\n\n') + '\n');
    fs.writeFileSync(path.join(SHOTS, 'asr-requests.json'), JSON.stringify(mock.log, null, 2) + '\n');
    fs.writeFileSync(path.join(SHOTS, 'chapters.json'), JSON.stringify(chapters, null, 2) + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ----------------------------------------------------------------- voicehotkey
// 快捷键唤起语音对话 (asr.hotkey, src/main/voice-hotkey.js): the global shortcut shows the pet, opens the chat
// box and starts the same recorder as 🎤 (fake microphone → mock whisper); a second press stops and recognises.
// With 语音输入 off or the microphone refused she says so. The settings window shows the shortcut, records a
// new one with HotkeyInput and refuses invalid / in-app / taken combinations ("another app" = a combination
// main registers first, PIXELPET_E2E_TAKEN_HOTKEYS, so globalShortcut.register really returns false).
// V2 also presses the real key through X11 (xdotool) when it is installed: the OS-level path, not the hook.
async function voiceHotkeyScenario() {
  const S = 'voicehotkey';
  const SHOTS = path.join(OUT, 'voicehotkey');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const TAKEN = 'CommandOrControl+Alt+K';
  const mock = await asrMock();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vhk-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vhkfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const wav = toneWav(path.join(data, 'fake-mic.wav'));
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_E2E_TAKEN_HOTKEYS: TAKEN };
  const args = ['--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`];
  let { app, page } = await launch(env, { video: path.join(SHOTS, 'video'), args });
  const errors = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); }); };
  watch(page);
  const t0 = Date.now();
  const chapters = [];
  const chapter = (title) => chapters.push({ at: Math.round((Date.now() - t0) / 1000), title });
  const evidence = [];
  const note = (s) => { evidence.push(s); return s; };
  const shot = async (name) => { await page.waitForTimeout(200); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `voicehotkey/${name}.png`; };
  let admin = null;
  const ashot = async (name) => { await admin.waitForTimeout(250); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `voicehotkey/${name}.png`; };
  const status = () => page.evaluate(() => window.pet.debugVoiceHotkeyStatus());
  const press = () => page.evaluate(() => window.pet.debugVoiceHotkey());
  const call = () => page.evaluate(() => window.petFx.voiceCall());
  const bubble = () => page.evaluate(() => { const b = document.getElementById('bubble'); return { shown: !b.classList.contains('hidden'), text: b.textContent, kind: b.dataset.kind, reason: b.dataset.reason }; });
  const waitMic = (st, timeout = 10000) => page.waitForFunction((s) => window.petFx.micState() === s, st, { timeout });
  // the bubble and the notice are both readable: inside the window and not on top of each other
  const bothVisible = async () => {
    const g = await page.evaluate(() => {
      const r = (id) => { const x = document.getElementById(id).getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), left: Math.round(x.left), right: Math.round(x.right) }; };
      const el = document.getElementById('bubble');
      return { bubble: r('bubble'), toast: r('unlock-toast'), h: window.innerHeight, w: window.innerWidth, clipped: el.scrollHeight - el.clientHeight };
    });
    const { bubble: b, toast: t } = g;
    assert.ok(g.clipped <= 1, `the whole bubble text shows, nothing scrolled away ${JSON.stringify(g)}`);
    assert.ok(b.top >= 0 && t.top >= 0 && b.bottom <= g.h && t.bottom <= g.h, `both inside the window ${JSON.stringify(g)}`);
    assert.ok(b.bottom <= t.top || t.bottom <= b.top, `the notice does not cover the bubble ${JSON.stringify(g)}`);
    return `bubble y ${b.top}–${b.bottom}, notice y ${t.top}–${t.bottom} (window ${g.w}×${g.h}): no overlap`;
  };
  const petState = () => page.evaluate(() => window.petFx.state().state);
  const away = async () => { await page.mouse.move(-50, -50).catch(() => {}); await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave'))); };
  const openAsr = async () => { admin = await openAdminWindow(app, page, 'asr'); await admin.waitForSelector('[data-key="asr.hotkey"]'); await admin.waitForTimeout(250); return admin; };
  const closeAdmin = async () => { if (admin) await admin.close().catch(() => {}); admin = null; await page.bringToFront(); };
  const field = () => admin.evaluate(() => {
    const el = document.querySelector('[data-key="asr.hotkey"]');
    const col = el.closest('[data-key="asr.hotkey"]').parentElement.parentElement;
    const err = document.querySelector('[data-error="asr.hotkey"]');
    const inner = [...col.querySelectorAll('div')].filter((d) => d.childElementCount === 0 && /冲突|无效|占用/.test(d.textContent)).map((d) => d.textContent.trim());
    const tag = document.querySelector('[data-hotkey-state]');
    return { keys: el.getAttribute('data-hotkey-keys'), shown: el.innerText.replace(/\s+/g, ' ').trim(), state: tag && tag.getAttribute('data-hotkey-state'), tag: tag && tag.textContent.trim(), error: err && err.textContent.trim(), inputError: inner[0] || null, hint: (document.querySelector('[data-hotkey-hint]') || {}).textContent || null };
  });
  // HotkeyInput records what is pressed while it has focus (react-hotkeys-hook, by key code)
  const record = async (combo) => {
    await admin.bringToFront();
    // a click on the field (its value area) focuses HotkeyInput's hidden input and starts recording
    await admin.evaluate(() => document.querySelector('[data-key="asr.hotkey"] input').blur());
    await admin.waitForTimeout(100);
    // (dispatched in the page: the settings window sits behind the always-on-top pet, so a pointer click waits forever)
    await admin.evaluate(() => document.querySelector('[data-key="asr.hotkey"] > div > div:first-child').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await adminUntil(admin, () => document.activeElement === document.querySelector('[data-key="asr.hotkey"] input'), null, 5000, 'HotkeyInput focused');
    await admin.keyboard.press(combo);
    await admin.waitForTimeout(600);
  };
  const saved = () => page.evaluate(async () => (await window.pet.getSettings()).asr.hotkey);
  try {
    await step(S, 'V0 hatch; the default shortcut is registered at launch (Ctrl+Shift+Space)', async () => {
      chapter('V0 孵化；启动时注册默认快捷键 Ctrl+Shift+Space');
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const st = await status();
      assert.equal(st.state, 'ok');
      assert.equal(st.accelerator, 'CommandOrControl+Shift+Space');
      assert.equal(st.label, 'Ctrl+Shift+Space');
      assert.equal(st.registered, true, 'globalShortcut.isRegistered');
      const set = await saved();
      assert.equal(set, 'CommandOrControl+Shift+Space');
      return note(`status ${JSON.stringify({ state: st.state, accelerator: st.accelerator, label: st.label, registered: st.registered })}; settings.asr.hotkey=${set}`);
    }, page);

    await step(S, 'V1 语音输入 off: the pet (hidden) comes back and says how to turn it on — 去设置', async () => {
      chapter('V1 语音输入未开启：隐藏的桌宠被唤出，气泡和提示条引导去设置');
      await away();
      const hid = await page.evaluate(() => window.pet.debugHidePet(false));
      assert.equal(hid.visible, false);
      await press();
      await page.waitForFunction(() => window.petFx.voiceCall().last === 'asr-off', null, { timeout: 5000 });
      const st = await status();
      assert.equal(st.petVisible, true, 'shown again by the shortcut');
      const b = await bubble();
      assert.equal(b.shown, true);
      assert.equal(b.reason, 'asr-off');
      assert.match(b.text, /语音输入还没开/);
      assert.match(b.text, /下面的提示/);
      assert.equal(await page.isVisible('#unlock-toast'), true);
      const tt = (await page.textContent('#unlock-toast')).replace(/\s+/g, ' ');
      assert.match(tt, /设置 → 语音输入/);
      assert.match(tt, /Ctrl\+Shift\+Space/);
      assert.equal(await page.getAttribute('#toast-open', 'data-admin'), 'asr');
      assert.equal((await page.textContent('#toast-open')).trim(), '去设置');
      assert.equal(await page.evaluate(() => window.petFx.micState()), 'idle', 'no recording');
      const geo = await bothVisible();
      const s = await shot('v1-asr-off-hint');
      await page.click('#toast-close');
      return note(`hidden → shortcut → visible=${st.petVisible}; bubble 「${b.text}」; toast 「${tt.replace('×', '').trim()}」 去设置 → #/asr; ${geo}; ${s}`);
    }, page);

    await step(S, 'V2 语音输入 on: minimised pet restored + focused, chat box open, recording, 「我在听…」 bubble, she looks at you', async () => {
      chapter('V2 开启语音输入后：最小化的桌宠被唤出、聊天框展开、开始录音、气泡「我在听…」');
      const r = await page.evaluate((url) => window.pet.asr.set({ enabled: true, engine: 'local', local: { endpoint: url } }), mock.url);
      assert.equal(r.ok, true);
      await away();
      // V1's hint keeps the controls up for a while: wait until they are down, so the shortcut is what brings them up
      await page.waitForFunction(() => !window.petFx.voiceCall().held && !document.body.classList.contains('hover'), null, { timeout: 15000 });
      await page.evaluate(() => window.pet.debugHidePet(true));
      // the real key through X11 when xdotool is there (globalShortcut's own path), otherwise the hook
      let via = 'hook';
      try {
        execFileSync('xdotool', ['key', '--clearmodifiers', 'ctrl+shift+space'], { timeout: 5000 });
        await page.waitForFunction(() => window.petFx.voiceCall().log.some((e) => e.ev === 'start'), null, { timeout: 4000 });
        via = 'xdotool (X11 key press → globalShortcut)';
      } catch {
        await press();
      }
      await waitMic('recording', 10000);
      await page.waitForTimeout(700);
      const st = await status();
      assert.equal(st.petVisible, true, 'restored from minimised');
      const c = await call();
      assert.equal(c.on, true);
      assert.equal(await page.evaluate(() => document.body.classList.contains('voice-call')), true);
      assert.equal(await page.evaluate(() => document.body.classList.contains('hover')), true, 'controls up without the pointer');
      assert.equal(await page.isVisible('#chat-input'), true, 'chat box open');
      assert.equal(await page.getAttribute('#chat-mic', 'data-state'), 'recording');
      assert.match(await page.textContent('#chat-mic'), /■ \d+s/);
      assert.match(await page.textContent('#mic-status'), /正在听/);
      const b = await bubble();
      assert.equal(b.kind, 'listen');
      assert.equal(b.reason, 'recording');
      assert.match(b.text, /我在听/);
      assert.match(b.text, /Ctrl\+Shift\+Space/);
      // while you speak she is listening, the whole time: the look state, the ear over her, the lean (class listening)
      const pet = () => page.evaluate(() => { const f = window.petFx.state(); return { state: f.state, listening: f.listening, fx: f.fx, status: document.getElementById('char-wrap').dataset.status }; });
      const samples = [];
      for (let i = 0; i < 4; i++) { samples.push({ t: i * 600, ...(await pet()) }); await page.waitForTimeout(600); }
      for (const p of samples) {
        assert.equal(p.state, 'look', `listening while recording ${JSON.stringify(samples)}`);
        assert.equal(p.listening, true, `char-wrap.listening ${JSON.stringify(samples)}`);
        assert.equal(p.fx, '👂', `the ear over her ${JSON.stringify(samples)}`);
      }
      const ps = samples[0].state;
      const s = await shot('v2-listening');
      return note(`via ${via}; triggers=${st.triggers}; petVisible=${st.petVisible} focused=${st.petFocused}; mic=recording, 🎤 「${(await page.textContent('#chat-mic')).trim()}」, status 「${(await page.textContent('#mic-status')).trim()}」, bubble 「${b.text.replace(/\n/g, ' ')}」, pet while recording ${JSON.stringify(samples)}; ${s}`);
    }, page);

    await step(S, 'V3 second press: stops, recognises (mock whisper), the text waits in the box; bubble 「听到啦」', async () => {
      chapter('V3 再按一次：结束录音并识别，文字填进输入框');
      const before = mock.log.length;
      await page.waitForTimeout(800);
      await press();
      await page.waitForFunction(() => ['stopping', 'transcribing'].includes(window.petFx.micState()), null, { timeout: 5000 });
      const mid = await bubble();
      const ps = await petState();
      // no longer listening once it stops (the render loop takes it off on its next frame): she thinks
      await page.waitForFunction(() => !window.petFx.state().listening, null, { timeout: 2000 });
      const s1 = await shot('v3-recognising');
      await waitMic('idle', 20000);
      await page.waitForFunction(() => window.petFx.voiceCall().last === 'ok', null, { timeout: 5000 });
      assert.match(mid.text, /让我想想/);
      assert.equal(mid.reason === 'transcribing' || mid.reason === 'stopping', true);
      assert.equal(mock.log.length, before + 1, 'one clip sent to the recogniser');
      assert.match(mock.log[before].type, /^audio\/webm/);
      assert.equal(await page.inputValue('#chat-input'), mock.TEXT);
      const b = await bubble();
      assert.match(b.text, /听到啦/);
      assert.equal(await page.evaluate(() => document.body.classList.contains('hover')), true, 'the box stays up to send it');
      const s2 = await shot('v3-heard-text-in-box');
      await page.fill('#chat-input', '');
      return note(`recognising: bubble 「${mid.text}」 state ${ps}; mock got ${mock.log[before].bytes} bytes ${mock.log[before].type}; box 「${mock.TEXT}」; bubble 「${b.text}」; ${s1}, ${s2}`);
    }, page);

    await step(S, 'V4 识别后直接发送 on: press, speak, press → sent to her agent and she replies', async () => {
      chapter('V4 识别后直接发送：按→说→按，直接发给她并收到回复');
      assert.equal((await page.evaluate(() => window.pet.asr.set({ autoSend: true }))).ok, true);
      await away();
      await press();
      await waitMic('recording', 10000);
      await page.waitForTimeout(900);
      await press();
      await page.waitForFunction(() => window.petFx.voiceCall().last === 'ok', null, { timeout: 20000 });
      const la = await page.evaluate(() => window.petFx.lastAsr());
      assert.equal(la.sent, true);
      await page.waitForFunction(() => { const b = document.getElementById('bubble'); return !b.classList.contains('hidden') && !b.classList.contains('thinking') && b.dataset.source !== 'hotkey' && b.textContent.trim().length > 0 && b.textContent !== '……'; }, null, { timeout: 30000 });
      const reply = await bubbleText(page);
      const s = await shot('v4-sent-and-replied');
      assert.equal((await page.evaluate(() => window.pet.asr.set({ autoSend: false }))).ok, true);
      return note(`lastAsr ${JSON.stringify({ ok: la.ok, text: la.text, sent: la.sent })}; her reply 「${String(reply).slice(0, 60)}」; ${s}`);
    }, page);

    await step(S, 'V5 microphone refused: she says she cannot hear you and how to allow it (no silent failure)', async () => {
      chapter('V5 麦克风权限被拒：气泡说明并引导');
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await page.evaluate(() => window.pet.debugMicAccess('denied'));
      await press();
      await page.waitForFunction(() => window.petFx.voiceCall().last === 'fail', null, { timeout: 8000 });
      const b = await bubble();
      assert.match(b.text, /麦克风权限/);
      assert.equal(b.reason, 'mic-denied');
      assert.equal(await page.isVisible('#unlock-toast'), true);
      const t = (await page.textContent('#unlock-toast')).replace(/\s+/g, ' ');
      assert.match(t, /没有麦克风权限/);
      // what to do on this system (the e2e runs on Linux: sound input / PipeWire·PulseAudio / Flatpak·Snap)
      if (process.platform === 'linux') { assert.match(t, /声音 → 输入/); assert.match(t, /PipeWire/); assert.match(t, /Flatpak \/ Snap/); assert.doesNotMatch(t, /隐私与安全性/); }
      const geo = await bothVisible();
      const s = await shot('v5-mic-denied');
      await page.evaluate(() => window.pet.debugMicAccess(''));
      await page.click('#toast-close');
      return note(`bubble 「${b.text}」; toast 「${t.replace('×', '').trim()}」; ${geo}; ${s}`);
    }, page);

    await step(S, 'V6 设置 → 语音输入 → 快捷键: shows Ctrl+Shift+Space, 已生效', async () => {
      chapter('V6 设置窗口：快捷键字段显示当前组合与「已生效」');
      await openAsr();
      await admin.evaluate(() => document.querySelector('[data-key="asr.hotkey"]').scrollIntoView({ block: 'center' }));
      const f = await field();
      assert.equal(f.keys, 'mod+shift+space');
      assert.equal(f.state, 'ok');
      assert.equal(f.tag, '已生效');
      assert.match(f.hint, /Ctrl\+Shift\+Space/);
      assert.match(f.shown, /Ctrl/i);
      // Space is written out (not lucide's ␣ icon) and the stored value is still an Electron accelerator
      assert.equal(f.shown, 'Ctrl Shift Space');
      assert.equal(await admin.evaluate(() => document.querySelectorAll('[data-key="asr.hotkey"] kbd svg').length), 0);
      assert.equal(await saved(), 'CommandOrControl+Shift+Space');
      const s = await ashot('v6-settings-hotkey-ok');
      return note(`field ${JSON.stringify(f)}; ${s}`);
    }, () => admin);

    await step(S, 'V7 invalid combinations: no modifier (HotkeyInput) and Shift+A (main) — error under the field, not saved', async () => {
      chapter('V7 无效组合：没有修饰键 / 只有 Shift，字段下方报错且不保存');
      await record('KeyA');
      let f = await field();
      // the exact wording README / docs/asr.md quote
      assert.equal(f.inputError, '组合无效，没有保存：至少要有一个修饰键（Ctrl / ⌘ / Alt），且只能有一个普通键');
      assert.equal(await saved(), 'CommandOrControl+Shift+Space');
      const first = f.inputError;
      const s1 = await ashot('v7-invalid-no-modifier');
      await record('Shift+KeyA');
      await adminUntil(admin, () => !!document.querySelector('[data-error="asr.hotkey"]'), null, 8000, 'error under the field');
      f = await field();
      assert.equal(f.error, require('../src/core/hotkey').MESSAGES['shift-only']);
      assert.equal(await saved(), 'CommandOrControl+Shift+Space');
      assert.equal(f.keys, 'mod+shift+space', 'the shortcut in use is still shown');
      assert.equal((await status()).registered, true);
      const s2 = await ashot('v7-invalid-shift-only');
      return note(`A → 「${first}」; Shift+A → 「${f.error}」; saved still CommandOrControl+Shift+Space; ${s1}, ${s2}`);
    }, () => admin);

    await step(S, 'V8 conflicts: Ctrl+, (the app opens settings with it) and Ctrl+Alt+K (held by another app) — not saved', async () => {
      chapter('V8 冲突组合：应用内 Ctrl+, / 被其他应用占用的 Ctrl+Alt+K，提示且不保存');
      await record('Control+Comma');
      let f = await field();
      // the same wording as main's own check (core/hotkey.js), quoted in README / docs/asr.md
      assert.equal(f.inputError, '和应用内的「打开设置」（Ctrl+,）冲突，换一个组合');
      assert.equal(f.inputError, require('../src/core/hotkey').checkHotkey('Control+,', 'linux').message);
      const first = f.inputError;
      const s1 = await ashot('v8-conflict-in-app');
      await record('Control+Alt+KeyK');
      await adminUntil(admin, () => /占用/.test((document.querySelector('[data-error="asr.hotkey"]') || {}).textContent || ''), null, 8000, 'taken error');
      f = await field();
      assert.match(f.error, /被系统或其他应用占用/);
      assert.equal(await saved(), 'CommandOrControl+Shift+Space');
      const st = await status();
      assert.equal(st.accelerator, 'CommandOrControl+Shift+Space');
      assert.equal(st.registered, true, 'the old shortcut keeps working');
      const s2 = await ashot('v8-conflict-taken');
      return note(`Ctrl+, → 「${first}」; Ctrl+Alt+K → 「${f.error}」; still ${st.accelerator} registered=${st.registered}; ${s1}, ${s2}`);
    }, () => admin);

    await step(S, 'V9 a new combination (Alt+Shift+V) is saved and re-registered; the old one is let go; the bubble names the new one', async () => {
      chapter('V9 改成 Alt+Shift+V：保存、注销旧的并注册新的');
      await record('Alt+Shift+KeyV');
      await adminUntil(admin, () => document.querySelector('[data-key="asr.hotkey"]').getAttribute('data-hotkey-keys') === 'alt+shift+v', null, 8000, 'alt+shift+v');
      const f = await field();
      assert.equal(f.state, 'ok');
      assert.equal(f.error, null);
      assert.equal(await saved(), 'Alt+Shift+V');
      const st = await status();
      assert.equal(st.accelerator, 'Alt+Shift+V');
      assert.equal(st.registered, true);
      const old = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+Space'));
      assert.equal(old, false, 'the old one is free again');
      const s1 = await ashot('v9-settings-new-hotkey');
      await closeAdmin();
      await press();
      await waitMic('recording', 10000);
      const b = await bubble();
      assert.match(b.text, /Alt\+Shift\+V/);
      await page.keyboard.press('Escape'); // Esc cancels, as with 🎤
      await waitMic('idle', 5000);
      await page.waitForFunction(() => window.petFx.voiceCall().last === 'canceled', null, { timeout: 5000 });
      return note(`field ${JSON.stringify({ keys: f.keys, state: f.state, hint: f.hint })}; registered Alt+Shift+V, old free=${!old}; bubble 「${b.text.replace(/\n/g, ' ')}」; Esc → canceled; ${s1}`);
    }, page);

    await step(S, 'V10 clear (×) = off, nothing registered, pressing does nothing; 恢复默认 brings Ctrl+Shift+Space back', async () => {
      chapter('V10 清空=关闭；恢复默认');
      await openAsr();
      // HotkeyInput's × (the last action button; ↺ comes first when the value is not the default)
      await admin.evaluate(() => { const b = [...document.querySelectorAll('[data-key="asr.hotkey"] button')].pop(); b.click(); });
      await adminUntil(admin, () => document.querySelector('[data-hotkey-state]').getAttribute('data-hotkey-state') === 'disabled', null, 8000, 'disabled');
      assert.equal(await saved(), '');
      let st = await status();
      assert.equal(st.state, 'disabled');
      const any = await app.evaluate(({ globalShortcut }) => ['Alt+Shift+V', 'CommandOrControl+Shift+Space'].some((a) => globalShortcut.isRegistered(a)));
      assert.equal(any, false);
      const f = await field();
      assert.equal(f.tag, '未启用');
      const s1 = await ashot('v10-cleared');
      await admin.evaluate(() => document.querySelector('[data-reset="asr.hotkey"]').click());
      await adminUntil(admin, () => document.querySelector('[data-hotkey-state]').getAttribute('data-hotkey-state') === 'ok', null, 8000, 'ok again');
      assert.equal(await saved(), 'CommandOrControl+Shift+Space');
      st = await status();
      assert.equal(st.registered, true);
      await closeAdmin();
      return note(`cleared → state disabled, tag 未启用, no shortcut registered; 恢复默认 → ${st.accelerator} registered=${st.registered}; ${s1}`);
    }, () => admin || page);

    await step(S, 'V11 a hand-edited settings.json with a taken combination: after a restart the page shows 被占用', async () => {
      chapter('V11 重启：settings.json 里是被占用的组合 → 设置页显示「被占用」');
      await app.close();
      const file = path.join(data, 'settings.json');
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      j.asr.hotkey = TAKEN;
      fs.writeFileSync(file, JSON.stringify(j, null, 2));
      ({ app, page } = await launch(env, { args }));
      watch(page);
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      const st = await status();
      assert.equal(st.state, 'conflict');
      assert.equal(st.code, 'taken');
      await openAsr();
      await admin.evaluate(() => document.querySelector('[data-key="asr.hotkey"]').scrollIntoView({ block: 'center' }));
      const f = await field();
      assert.equal(f.state, 'conflict');
      assert.equal(f.tag, '被占用');
      assert.match(f.error, /被系统或其他应用占用/);
      const s = await ashot('v11-settings-taken-after-restart');
      // and a free one fixes it
      assert.equal((await adminSet(admin, 'asr.hotkey', 'mod+shift+space')).ok, true);
      await adminUntil(admin, () => document.querySelector('[data-hotkey-state]').getAttribute('data-hotkey-state') === 'ok', null, 8000, 'ok');
      await closeAdmin();
      return note(`settings.asr.hotkey=${TAKEN} at launch → status ${JSON.stringify({ state: st.state, code: st.code })}; page tag 「${f.tag}」 error 「${f.error}」; ${s}`);
    }, () => admin || page);

    await step(S, 'V12 quit lets every global shortcut go (will-quit → unregisterAll)', async () => {
      chapter('V12 退出：注销全部全局快捷键');
      const before = await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+Space'));
      assert.equal(before, true);
      const after = await app.evaluate(({ app: a, globalShortcut }) => { a.emit('will-quit', { preventDefault() {} }); return globalShortcut.isRegistered('CommandOrControl+Shift+Space'); });
      assert.equal(after, false);
      return note(`registered before will-quit: ${before}; after: ${after}`);
    }, null);

    await step(S, 'no console errors or page errors', async () => {
      assert.deepEqual(errors, []);
      return `${errors.length} errors`;
    }, null);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'voicehotkey-log.txt'), evidence.join('\n\n') + '\n');
    fs.writeFileSync(path.join(SHOTS, 'chapters.json'), JSON.stringify(chapters, null, 2) + '\n');
    await app.close().catch(() => {});
    mock.server.close();
  }
}

// ----------------------------------------------------------------- stream
// 流式回复 (docs/streaming-ui.md), no tokens: the fake lh prints one stream_chunk event per line, gapMs apart
// ($FAKE_LH_DIR/stream-reply.json), the way a line-by-line lh would. A sampler in the page records the
// bubble every 40 ms, so the steps can show the reply was on screen in part, grew, and ended as the full text.
async function streamScenario() {
  const S = 'stream';
  const SHOTS = path.join(OUT, 'stream');
  fs.mkdirSync(SHOTS, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-stream-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-streamfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.mkdirSync(data, { recursive: true });
  // 朗读 on (system voice): the reading must start once, with the final text
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true, voiceInteractions: false } }));
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  const { app, page } = await launch(env);
  const evidence = [];
  const note = (s) => { evidence.push(s); return s.length > 280 ? `${s.slice(0, 277)}…` : s; };
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  const logged = () => JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8')).messages;
  const reply = (r) => fs.writeFileSync(path.join(fakeDir, 'stream-reply.json'), JSON.stringify(r));
  const startSampler = () => page.evaluate(() => {
    clearInterval(window.__sampler);
    window.__samples = [];
    const t0 = performance.now();
    window.__sampler = setInterval(() => {
      const b = document.getElementById('bubble');
      window.__samples.push({ t: Math.round(performance.now() - t0), text: b.classList.contains('hidden') ? '' : b.textContent, streaming: b.classList.contains('streaming'), thinking: b.classList.contains('thinking'), busy: document.body.classList.contains('busy'), caret: getComputedStyle(b, '::after').content });
    }, 40);
  });
  const stopSampler = () => page.evaluate(() => { clearInterval(window.__sampler); return window.__samples; });
  const sendText = async (text) => {
    await hover(page);
    if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
    await page.fill('#chat-input', text);
    await page.click('#chat-send');
  };
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="claude"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();
    await page.waitForTimeout(300);

    const PIECES = ['好呀，', '我给你讲讲', '今天的天气：', '早上有点凉，', '中午出太阳，', '晚上记得', '加件外套哦～'];
    const FULL = PIECES.join('');
    await step(S, 'S1 the reply shows in part before it is done, grows piece by piece, and ends as the whole reply', async () => {
      reply({ pieces: PIECES, gapMs: 550 });
      const greetIds = new Set((await page.evaluate(() => window.petFx.streamLog())).map((e) => e.id)); // her greeting at hatch
      const before = logged().length;
      await startSampler();
      await sendText('今天天气怎么样');
      // part of the reply is on screen while she is still busy writing
      await page.waitForFunction(() => document.getElementById('bubble').classList.contains('streaming') && document.body.classList.contains('busy') && document.getElementById('bubble').textContent.length > 0, null, { timeout: 10000 });
      await shot('s1-first-piece');
      await page.waitForFunction((n) => document.getElementById('bubble').classList.contains('streaming') && [...document.getElementById('bubble').textContent].length >= n, [...PIECES.slice(0, 4).join('')].length, { timeout: 10000 });
      await shot('s1-midway');
      await idle();
      await page.waitForTimeout(200);
      await shot('s1-final');
      const samples = await stopSampler();
      const partial = samples.filter((s) => s.streaming);
      assert.ok(partial.length > 0, 'no sample while streaming');
      const distinct = [...new Set(partial.map((s) => s.text))];
      assert.ok(distinct.length >= 5, `only ${distinct.length} distinct partial texts`);
      for (const t of distinct) assert.ok(FULL.startsWith(t) && t.length < FULL.length || t === FULL, `partial 「${t}」 is not a prefix of the reply`);
      for (let i = 1; i < partial.length; i++) assert.ok(partial[i].text.length >= partial[i - 1].text.length, 'the text shrank while streaming');
      assert.ok(partial.every((s) => s.busy), 'controls came back before the reply was done');
      assert.ok(partial.some((s) => s.caret.includes('▍')), 'no typing caret');
      const firstPartialAt = partial.find((s) => s.text.length).t;
      const doneAt = samples.find((s, i) => i > 0 && !s.busy && samples[i - 1].busy).t;
      assert.ok(doneAt - firstPartialAt >= 2000, `first piece ${firstPartialAt} ms, done ${doneAt} ms`);
      const end = samples[samples.length - 1];
      assert.equal(end.text, FULL);
      assert.equal(end.streaming, false);
      assert.equal(await bubbleText(page), FULL);
      // 聊天记录: her reply once, the final text
      const added = logged().slice(before);
      assert.deepEqual(added.map((m) => [m.role, m.text]), [['user', '今天天气怎么样'], ['pet', FULL]]);
      // stream log: one id, growing pieces, one end
      const sl = (await page.evaluate(() => window.petFx.streamLog())).filter((e) => !greetIds.has(e.id));
      const ids = new Set(sl.map((e) => e.id));
      assert.equal(ids.size, 1, 'one stream for this reply');
      assert.deepEqual(sl.filter((e) => e.ev === 'end').map((e) => e.ok), [true]);
      assert.deepEqual(sl.filter((e) => e.ev === 'delta').map((e) => e.text), PIECES.map((_, i) => PIECES.slice(0, i + 1).join('')));
      // reading aloud: offered once, after the reply, with the whole text
      const offers = (await page.evaluate(() => window.petFx.offerLog())).filter((o) => o.kind === 'chat');
      assert.equal(offers.length, 1);
      assert.equal(offers[0].text.replace(/\s+/g, ''), FULL.replace(/\s+/g, ''));
      const timeline = distinct.map((t) => `${partial.find((s) => s.text === t).t}ms「${t}」`).join(' → ');
      return note(`bubble timeline: ${timeline} → done ${doneAt}ms「${end.text}」; chat-log +${added.length} (user, pet=final); TTS offered once: 「${offers[0].text}」`);
    }, page);

    await step(S, 'S2 a meme tag cut between pieces never shows; the picture comes with the final line', async () => {
      reply({ pieces: ['让我想想', '……嗯，', '先读题再画图。', '\n[梗', '图:th', 'ink]'], gapMs: 400 });
      await startSampler();
      await sendText('这道题怎么做');
      await idle();
      await page.waitForTimeout(150);
      await shot('s2-meme-final');
      const samples = await stopSampler();
      const seen = [...new Set(samples.filter((s) => s.streaming).map((s) => s.text))];
      assert.ok(seen.length >= 2, `partial texts: ${JSON.stringify(seen)}`);
      assert.ok(samples.every((s) => !s.text.includes('[') && !s.text.includes('梗图')), 'a tag piece reached the bubble');
      assert.equal(await bubbleText(page), '让我想想……嗯，先读题再画图。');
      assert.equal(await page.evaluate(() => document.getElementById('bubble').dataset.meme), 'think');
      assert.equal(await page.isVisible('#meme-sticker'), true);
      const pet = logged().filter((m) => m.role === 'pet').pop();
      assert.equal(pet.text, '让我想想……嗯，先读题再画图。');
      return note(`shown while writing: ${seen.map((t) => `「${t}」`).join(' → ')}; final 「${await bubbleText(page)}」 + sticker think`);
    }, page);

    await step(S, 'S3 a reply that crosses the content line is withheld from the first hit; the final line is her refusal', async () => {
      reply({ pieces: ['我们周末', '可以去', '做爱做的', '事'], gapMs: 400 });
      await startSampler();
      await sendText('周末做什么');
      await idle();
      await page.waitForTimeout(150);
      await shot('s3-guard-final');
      const samples = await stopSampler();
      assert.ok(samples.every((s) => !/做爱/.test(s.text)), 'the blocked word reached the bubble');
      const seen = [...new Set(samples.filter((s) => s.streaming).map((s) => s.text))];
      assert.ok(seen.includes('……'), `withheld placeholder not shown: ${JSON.stringify(seen)}`);
      const final = await bubbleText(page);
      assert.match(final, /这个我不聊啦/);
      const pet = logged().filter((m) => m.role === 'pet').pop();
      assert.equal(pet.text, final);
      return note(`shown while writing: ${seen.map((t) => `「${t}」`).join(' → ')}; final 「${final}」 (chat-log has the refusal)`);
    }, page);

    await step(S, 'S4 Esc while she is writing stops it: no more pieces, the caret goes, she says she stopped; 聊天记录 notes it once', async () => {
      reply({ pieces: ['从前', '有一座山，', '山里有座庙，', '庙里有个', '老和尚'], gapMs: 600, hang: true });
      const before = logged().length;
      await startSampler();
      await sendText('讲个故事');
      await page.waitForFunction(() => document.getElementById('bubble').textContent.includes('有一座山'), null, { timeout: 10000 });
      await shot('s4-before-esc');
      await page.keyboard.press('Escape');
      await idle();
      await page.waitForTimeout(1500); // a piece that was still coming would land in this time
      await shot('s4-after-esc');
      const samples = await stopSampler();
      const final = await bubbleText(page);
      assert.equal(final, '（好吧，不想了。）');
      assert.ok(samples.every((s) => !s.text.includes('老和尚')), 'pieces kept coming after Esc');
      assert.equal(await page.evaluate(() => document.getElementById('bubble').classList.contains('streaming')), false);
      const added = logged().slice(before);
      assert.deepEqual(added.map((m) => [m.role, m.status || null]), [['user', null], ['pet', 'canceled']]);
      const sl = await page.evaluate(() => window.petFx.streamLog());
      const last = sl[sl.length - 1];
      assert.deepEqual([last.ev, last.ok, last.reason], ['end', false, 'canceled']);
      return note(`before Esc 「${samples.filter((s) => s.streaming).pop().text}」; after: 「${final}」; chat-log pet status canceled`);
    }, page);

    await step(S, 'S5 a proactive line streams the same way, under its own id', async () => {
      reply({ pieces: ['主人～', '我有点饿了，', '能给我点吃的吗？'], gapMs: 400 });
      const idsBefore = new Set((await page.evaluate(() => window.petFx.streamLog())).map((e) => e.id));
      await startSampler();
      await page.evaluate(() => window.pet.debugSet({ hunger: 90, lastSpokeAt: 0 }));
      await page.evaluate(() => { window.pet.debugHeartbeat(); }); // not awaited: it resolves when her line is done
      await page.waitForFunction(() => document.getElementById('bubble').classList.contains('streaming'), null, { timeout: 10000 })
        .catch(async (e) => { throw new Error(`${e.message} bubble=${await bubbleText(page)} log=${JSON.stringify((await page.evaluate(() => window.petFx.streamLog())).slice(-3))}`); });
      await shot('s5-proactive-streaming');
      await idle();
      await page.waitForTimeout(150);
      const samples = await stopSampler();
      const seen = [...new Set(samples.filter((s) => s.streaming).map((s) => s.text))];
      assert.ok(seen.length >= 2, JSON.stringify(seen));
      assert.equal(await bubbleText(page), '主人～我有点饿了，能给我点吃的吗？');
      const sl = (await page.evaluate(() => window.petFx.streamLog())).filter((e) => !idsBefore.has(e.id));
      assert.equal(new Set(sl.map((e) => e.id)).size, 1);
      return note(`proactive (hungry): ${seen.map((t) => `「${t}」`).join(' → ')}; new stream id ${sl[0].id}`);
    }, page);

    // 聊天记录 is a page of the settings window now (T-2718): while she writes, the bubble streams; once she is
    // done, the conversation there shows exactly what was saved
    await step(S, 'S6 a streamed reply lands in 设置 → 聊天记录 as saved, once she is done', async () => {
      reply({ pieces: ['记录里', '也能', '看到我', '一点点写出来。'], gapMs: 500 });
      const done = page.evaluate(() => window.pet.chat('历史面板测试', [], []));
      await page.waitForFunction(() => document.getElementById('bubble').classList.contains('streaming'), null, { timeout: 10000 });
      const live1 = await bubbleText(page);
      await shot('s6-history-live');
      await done;
      await idle();
      const admin = await openAdminWindow(app, page, 'history');
      await adminUntil(admin, () => !!document.querySelector('[data-session]'), null, 10000, 'conversations');
      await admin.evaluate(() => document.querySelector('[data-session]').click());
      await adminUntil(admin, () => [...document.querySelectorAll('[data-history-thread] [data-role="pet"] [data-history-text]')].some((e) => e.textContent === '记录里也能看到我一点点写出来。'), null, 10000, 'the saved reply');
      await admin.screenshot({ path: path.join(SHOTS, 's6-history-final.png') });
      return note(`bubble while writing: 「${live1}」; 聊天记录 after: the saved reply`);
    }, page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'stream-log.txt'), evidence.join('\n\n') + '\n');
    // run evidence: what was saved, what the window showed piece by piece, and what was read aloud
    try { fs.copyFileSync(path.join(data, 'chat-log.json'), path.join(SHOTS, 'chat-log.json')); } catch { /* not written */ }
    try {
      const w = await page.evaluate(() => ({ streamLog: window.petFx.streamLog(), offerLog: window.petFx.offerLog(), speechLog: window.petFx.speechLog() }));
      fs.writeFileSync(path.join(SHOTS, 'renderer-logs.json'), JSON.stringify(w, null, 2) + '\n');
    } catch { /* window gone */ }
    await app.close().catch(() => {});
  }
  await streamDirectScenario();
}

// 流式回复 with local abilities OFF on the direct way (docs/streaming.md §1): the app reads the reply from a local
// stand-in for LobeHub's Responses API (test/fixtures/fake-responses-server.js, SSE, no tokens). The fake lh
// prints its whole answer at once (like lh 0.0.62–0.0.73), so a bubble that grows can only come from the SSE.
async function streamDirectScenario() {
  const S = 'stream';
  const SHOTS = path.join(OUT, 'stream');
  fs.mkdirSync(SHOTS, { recursive: true });
  const { startFakeResponses } = require('../test/fixtures/fake-responses-server');
  const PIECES = ['本机能力关着，', '我也能', '一点一点', '把话说出来：', '先是这一句，', '再接下一句，', '最后说完～'];
  const FULL = PIECES.join('');
  let failNext = false;
  const srv = await startFakeResponses((body) => (failNext ? { status: 502, body: 'bad gateway' } : { pieces: body.input && /本机关闭测试/.test(String(body.input)) ? PIECES : ['你好呀，', '我来了～'], gapMs: 450, id: body.previous_response_id || 'tpc_E2E_DIRECT' }));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-streamdirect-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-streamdirectfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true, voiceInteractions: false } }));
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_DIRECT: '1', LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'e2e-fake-key', LOBEHUB_CLI_HOME: path.relative(os.homedir(), fakeDir) };
  const { app, page } = await launch(env);
  const evidence = [];
  const note = (s) => { evidence.push(s); return s.length > 280 ? `${s.slice(0, 277)}…` : s; };
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
  const logged = () => JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8')).messages;
  const runs = () => (fs.existsSync(path.join(fakeDir, 'runs.log')) ? fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const sample = () => page.evaluate(() => {
    clearInterval(window.__sampler);
    window.__samples = [];
    const t0 = performance.now();
    window.__sampler = setInterval(() => {
      const b = document.getElementById('bubble');
      window.__samples.push({ t: Math.round(performance.now() - t0), text: b.classList.contains('hidden') ? '' : b.textContent, streaming: b.classList.contains('streaming'), busy: document.body.classList.contains('busy') });
    }, 40);
  });
  const stopSampler = () => page.evaluate(() => { clearInterval(window.__sampler); return window.__samples; });
  const sendText = async (text) => {
    await hover(page);
    if (!(await page.isVisible('#chat-input'))) await clickAct(page, 'chat');
    await page.fill('#chat-input', text);
    await page.click('#chat-send');
  };
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="claude"]').first().click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();
    await page.waitForTimeout(300);

    await step(S, 'S7 本机能力关闭：回复走直连 Responses SSE（tools:[]），气泡逐步变长，同一 topic，lh agent run 未被调用', async () => {
      assert.equal((await view(page)).local.enabled, false);
      const greetReq = srv.requests[0];
      assert.ok(greetReq, 'her hello went to the Responses API');
      const before = logged().length;
      const runsBefore = runs().length;
      await sample();
      await sendText('本机关闭测试：慢慢说');
      await page.waitForFunction(() => document.getElementById('bubble').classList.contains('streaming') && document.body.classList.contains('busy') && document.getElementById('bubble').textContent.length > 0, null, { timeout: 10000 });
      await page.screenshot({ path: path.join(SHOTS, 's7-direct-first-piece.png') });
      await page.waitForFunction((n) => [...document.getElementById('bubble').textContent].length >= n, [...PIECES.slice(0, 4).join('')].length, { timeout: 10000 });
      await page.screenshot({ path: path.join(SHOTS, 's7-direct-midway.png') });
      await idle();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, 's7-direct-final.png') });
      const samples = await stopSampler();
      const partial = samples.filter((s) => s.streaming && s.text);
      const distinct = [...new Set(partial.map((s) => s.text))];
      assert.ok(distinct.length >= 5, `only ${distinct.length} distinct partial texts: ${JSON.stringify(distinct)}`);
      for (const t of distinct) assert.ok(FULL.startsWith(t), `partial 「${t}」 is not a prefix`);
      for (let i = 1; i < partial.length; i++) assert.ok(partial[i].text.length >= partial[i - 1].text.length, 'the text shrank while streaming');
      const firstAt = partial[0].t;
      const doneAt = samples.find((s, i) => i > 0 && !s.busy && samples[i - 1].busy).t;
      assert.ok(doneAt - firstAt >= 2000, `first piece ${firstAt} ms, done ${doneAt} ms`);
      assert.equal(await bubbleText(page), FULL);
      const req = srv.requests[srv.requests.length - 1].body;
      assert.equal(req.stream, true);
      assert.deepEqual(req.tools, []);
      assert.equal(req.previous_response_id, 'tpc_E2E_DIRECT'); // her hello opened the topic; this turn continues it
      assert.equal(runs().length, runsBefore, 'lh agent run was not used');
      assert.deepEqual(logged().slice(before).map((m) => [m.role, m.text]), [['user', '本机关闭测试：慢慢说'], ['pet', FULL]]);
      const offers = (await page.evaluate(() => window.petFx.offerLog())).filter((o) => o.kind === 'chat');
      assert.equal(offers.length, 1);
      const timeline = distinct.map((t) => `${partial.find((s) => s.text === t).t}ms「${t}」`).join(' → ');
      return note(`local off, direct SSE: ${timeline} → done ${doneAt}ms; request tools=[] stream=true previous_response_id=${req.previous_response_id}; lh agent run calls +0; chat-log +2; TTS offered once`);
    }, page);

    await step(S, 'S8 直连报错（502）时同一回合自动回退到 lh agent run：回复不丢、气泡与聊天记录各一次', async () => {
      failNext = true;
      const before = logged().length;
      const runsBefore = runs().length;
      await sendText('回退测试');
      await idle();
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS, 's8-fallback-final.png') });
      const text = await bubbleText(page);
      assert.match(text, /^echo: /);
      assert.match(text, /回退测试/);
      const r = runs().slice(runsBefore);
      assert.equal(r.length, 1, 'one lh agent run');
      assert.equal(r[0].topic, 'tpc_E2E_DIRECT');
      assert.deepEqual(r[0].tools, []);
      const added = logged().slice(before);
      assert.deepEqual(added.map((m) => m.role), ['user', 'pet']);
      assert.equal(added[1].text, text);
      failNext = false;
      return note(`502 → lh agent run -t ${r[0].topic} once; bubble 「${text}」; chat-log +2 (user, pet)`);
    }, page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'stream-direct-log.txt'), evidence.join('\n\n') + '\n');
    try { fs.writeFileSync(path.join(SHOTS, 'stream-direct-requests.json'), JSON.stringify(srv.requests.map((q) => ({ at: q.at, body: q.body })), null, 2) + '\n'); } catch { /* ignore */ }
    await app.close().catch(() => {});
    await srv.close();
  }
}

// --- design: the design-system preview (admin bundle, @lobehub/ui) in a real Electron window ----------------
// Builds src/admin-ui, opens it through scripts/design-preview.js (sandboxed, CSP, offline), then drives the
// grouped nav, a switch, a select, a toast and a confirm modal in light and dark. No request may leave file://.
async function designScenario() {
  const S = 'design';
  const SHOTS = path.join(OUT, 'design');
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  for (const theme of ['light', 'dark']) {
    const app = await _electron.launch({ args: ['scripts/design-preview.js', '--no-sandbox', `--theme=${theme}`], cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    const page = await app.firstWindow();
    const remote = [];
    const errors = [];
    page.on('request', (r) => { if (!/^(file|data|blob|devtools):/.test(r.url())) remote.push(r.url()); });
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${theme}-${name}.png`) });
    try {
      await step(S, `${theme}: 预览页加载，data-theme=${theme}，底色取 --lobe-color-bg-layout`, async () => {
        await page.waitForSelector('[data-design-page="/design/colors"]', { timeout: 20000 });
        const f = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, layout: getComputedStyle(document.documentElement).getPropertyValue('--lobe-color-bg-layout').trim(), csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content, url: location.href }));
        assert.equal(f.theme, theme);
        assert.equal(f.layout, theme === 'dark' ? '#000' : '#f8f8f8');
        assert.ok(f.url.startsWith('file://'), f.url);
        await shot('01-colors');
        return `data-theme=${f.theme} body bg=${f.bg} --lobe-color-bg-layout=${f.layout} url=${f.url.replace(/^.*\/src\//, 'src/')}`;
      }, page);
      await step(S, `${theme}: 分组导航切到「按钮与输入」，开关、下拉可操作`, async () => {
        await page.click('nav a[href="#/design/controls"]');
        await page.waitForSelector('[data-design-page="/design/controls"]');
        await page.getByText('回复时自动朗读：开').waitFor();
        await page.locator('button[role="switch"]').first().click();
        await page.getByText('回复时自动朗读：关').waitFor();
        await page.getByRole('combobox').first().click();
        await page.getByRole('option', { name: '本机 TTS 服务' }).click();
        await page.getByText('本机 TTS 服务').first().waitFor();
        await shot('02-controls');
        return 'switch 开→关; select → 本机 TTS 服务';
      }, page);
      await step(S, `${theme}: 表单分组（Form itemsType=group variant=filled）`, async () => {
        await page.click('nav a[href="#/design/form"]');
        await page.waitForSelector('[data-design-page="/design/form"] form');
        const labels = await page.locator('[data-design-page="/design/form"] form').innerText();
        for (const l of ['桌宠行为', '自由漫步', '语音朗读', '朗读引擎', 'API Key']) assert.ok(labels.includes(l), l);
        await shot('03-form');
        return 'groups 桌宠行为 / 语音朗读 rendered';
      }, page);
      await step(S, `${theme}: Toast 与确认弹窗`, async () => {
        await page.click('nav a[href="#/design/feedback"]');
        await page.waitForSelector('[data-design-page="/design/feedback"]');
        await page.getByRole('button', { name: '成功' }).click();
        await page.getByText('设置已保存').waitFor({ timeout: 5000 });
        await shot('04-toast');
        await page.getByRole('button', { name: '删除角色包' }).click();
        await page.getByText('删除角色包「像素小猫」？').waitFor({ timeout: 5000 });
        await page.getByRole('dialog').getByRole('button', { name: '取消' }).waitFor();
        await page.waitForTimeout(500); // let the open transition finish
        await shot('05-confirm');
        await page.getByRole('dialog').getByRole('button', { name: '删除角色包' }).click();
        await page.getByText('已删除角色包「像素小猫」').waitFor({ timeout: 5000 });
        return 'toast 设置已保存; confirm → toast 已删除角色包「像素小猫」';
      }, page);
      await step(S, `${theme}: 零外网请求、零控制台错误（CSP 下离线）`, async () => {
        assert.deepEqual(remote, []);
        assert.deepEqual(errors, []);
        return 'remote requests 0, console errors 0';
      });
    } finally {
      await app.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- frontslim (前台精简, T-2718)
// The pet window keeps 喂食 / 玩耍 / 睡觉 / 聊天 and one ⚙ 设置 button; 话题, 衣柜 and the ⋯ menu are gone.
// ⚙, a right click on her, Ctrl+, and the unlock toast open the settings window, and every item of the old ⋯
// menu is clicked there for real: 新版本, 设置, 角色列表, 聊天记录, 重新开始话题, 成人向内容, 本机能力, 动作,
// 回到右下角, 检查更新, 放生并删除 agent, 仅重置本地, 打开错误日志, 素材署名, 退出 (+ 话题 and 衣柜).
// Free: fake lh, a local update feed, no network.
async function frontslimScenario() {
  const S = 'frontslim';
  const SHOTS = path.join(OUT, 'frontslim');
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const http = require('node:http');
  let tag = 'v0.0.1';
  const server = http.createServer((req, res) => {
    if (req.url !== '/releases/latest') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tag_name: tag, html_url: `https://github.com/rdmclin2/lobehub-pixel-pet-affection/releases/tag/${tag}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-slim-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-slimfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_UPDATE_TEST: '1', PIXELPET_UPDATE_FEED: `http://127.0.0.1:${server.address().port}` });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pet: ${e} @ ${String(e.stack || '').split('\n').slice(1, 3).join(' ')}`));
  const calls = () => { try { return fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args); } catch { return []; } };
  const petState = () => JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
  const shotPet = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
  const desktop = (name) => {
    try {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', process.env.PIXELPET_E2E_SCREEN || '1280x1024', '-i', process.env.DISPLAY, '-frames:v', '1', path.join(SHOTS, `${name}.png`)]);
      return `${name}.png`;
    } catch { return 'no desktop capture'; }
  };
  let admin = null;
  const adminWins = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('admin-ui')).length);
  const findAdmin = async () => {
    for (let i = 0; i < 200; i++) {
      const w = app.windows().find((p) => p.url().includes('admin-ui'));
      if (w) {
        if (w !== admin) {
          w.on('pageerror', (e) => errors.push(`admin: ${e}`));
          await w.setViewportSize({ width: 1180, height: 860 }).catch(() => {});
        }
        return w;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the settings window did not open');
  };
  const closeAdmin = async () => {
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('admin-ui')) w.destroy(); });
    for (let i = 0; i < 50 && (await adminWins()); i++) await new Promise((r) => setTimeout(r, 100));
    admin = null;
  };
  // the settings window sits behind the always-on-top pet and gets few frames: poll with evaluate, not waitFor*
  const until = async (w, fn, arg, ms = 15000, what = 'condition') => {
    const t0 = Date.now();
    for (;;) {
      if (await w.evaluate(fn, arg).catch(() => false)) return;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const atPath = (p) => until(admin, (x) => !!document.querySelector(`[data-path="${x}"]`), p, 15000, `page ${p}`);
  const go = async (p) => { await admin.evaluate((x) => { location.hash = x; }, p); await atPath(p); await admin.waitForTimeout(300); };
  const shotAdmin = async (n) => { await admin.bringToFront().catch(() => {}); await admin.waitForTimeout(250); await admin.screenshot({ path: path.join(SHOTS, `${n}.png`) }); };
  const pageText = () => admin.evaluate(() => document.querySelector('[data-admin-page]').innerText.replace(/\s+/g, ' '));
  const toastSeen = (re) => until(admin, (src) => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, 10000, `toast ${re}`);
  const clickText = (sel, text) => admin.evaluate(([s, t]) => { const b = [...document.querySelectorAll(s)].find((x) => (x.textContent || '').trim().includes(t) && !x.disabled); if (!b) throw new Error(`no ${s} "${t}"`); b.click(); }, [sel, text]);
  const dialogOk = async (okText) => {
    await until(admin, (t) => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].some((b) => (b.textContent || '').trim() === t), okText, 8000, `confirm dialog "${okText}"`);
    const title = await admin.evaluate(() => { const d = [...document.querySelectorAll('[role="dialog"], .ant-modal')].pop(); return d ? d.innerText.replace(/\s+/g, ' ').slice(0, 120) : ''; });
    return title;
  };
  const dialogClick = (t) => admin.evaluate((x) => { const b = [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].filter((e) => (e.textContent || '').trim() === x).pop(); b.click(); }, t);
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const flip = (key) => admin.evaluate((k) => { const el = document.querySelector(`[data-key="${k}"]`); (el.matches('button') ? el : el.querySelector('button')).click(); }, key);
  const map = [];
  try {
    await page.waitForSelector('.char-card');
    await page.click('.char-card[data-species="grok"]');
    await page.uncheck('#local-opt');
    await page.fill('#pet-name', '小蓝');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();

    await step(S, 'F1 前台：工具栏只剩 喂食/玩耍/睡觉/聊天 + 🔊 静音 + ⚙ 设置；没有 话题、衣柜、⋯ 菜单和面板', async () => {
      await hover(page);
      await page.waitForTimeout(400);
      await shotPet('f1-pet-toolbar');
      const ui = await page.evaluate(() => ({
        acts: [...document.querySelectorAll('#toolbar [data-act]')].map((b) => `${b.dataset.act}:${(b.getAttribute('aria-label') || b.textContent).trim()}`),
        visible: [...document.querySelectorAll('#toolbar [data-act]')].filter((b) => b.offsetParent).length,
        gone: ['btn-topics', 'btn-wardrobe', 'main-menu', 'action-menu', 'panel'].filter((id) => document.getElementById(id)),
        menuBtn: document.querySelectorAll('[data-act="menu"], [data-menu]').length,
        text: document.getElementById('toolbar').innerText.replace(/\s+/g, ' ').trim(),
      }));
      // canary #107 (T-2733) added the one-click 静音 speaker between 聊天 and ⚙; still no 话题 / 衣柜 / ⋯ menu
      assert.deepEqual(ui.acts, ['feed:喂食', 'play:玩耍', 'sleep:睡觉', 'chat:聊天', 'mute:静音', 'settings:设置', 'quit:退出']);
      assert.equal(ui.visible, 7);
      assert.deepEqual(ui.gone, []);
      assert.equal(ui.menuBtn, 0);
      assert.doesNotMatch(ui.text, /话题|衣柜/);
      return `toolbar ${JSON.stringify(ui.acts)}; text 「${ui.text}」; removed elements present: ${ui.gone.length}`;
    }, page);

    await step(S, 'F2 前台互动保留：喂食菜单、玩耍、聊天输入框都还在且可用', async () => {
      await clickAct(page, 'feed');
      await page.waitForSelector('#food-menu:not(.hidden)');
      const foods = await page.$$eval('#food-menu .btn', (b) => b.map((x) => x.textContent.trim()));
      await shotPet('f2-food-menu');
      await page.click('#food-menu .btn');
      await idle();
      await clickAct(page, 'chat');
      await page.waitForSelector('#chat-row:not(.hidden)');
      await page.fill('#chat-input', '你好呀，今天过得怎么样？');
      await page.click('#chat-send');
      const reply = await waitReply(page, 20000);
      await idle();
      return `foods ${foods.join('/')}; chat reply 「${reply.slice(0, 40)}」`;
    }, page);

    await step(S, 'F3 点 ⚙ 设置 打开后台（单实例），落在 小屋', async () => {
      await clickAct(page, 'settings');
      admin = await findAdmin();
      await atPath('/overview');
      const n = await adminWins();
      assert.equal(n, 1);
      await shotAdmin('f3-admin-from-gear');
      const d = desktop('f3-desktop-pet-and-admin');
      map.push(['设置', '⚙ 设置按钮 / 右键 / Ctrl+, → 后台 小屋']);
      return `settings windows ${n}; path /overview; ${d}`;
    }, () => admin);

    await step(S, 'F4 右键她 → 打开后台（不再弹菜单）；Ctrl+, 也打开后台', async () => {
      await closeAdmin();
      await page.bringToFront();
      await hover(page);
      const box = await page.evaluate(() => { const el = [...document.querySelectorAll('.pet-hit')].find((e) => !e.classList.contains('hidden')); const r = el.getBoundingClientRect(); return { id: el.id, x: r.x + r.width / 2, y: r.y + r.height * 0.6 }; });
      const hit = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}#${e.id}.${e.className}` : null; }, box);
      await page.mouse.click(box.x, box.y, { button: 'right' });
      try { admin = await findAdmin(); } catch (e) { throw new Error(`${e.message} (right click at ${Math.round(box.x)},${Math.round(box.y)} on ${hit}, pet-hit ${box.id})`); }
      await atPath('/overview');
      const popups = await page.evaluate(() => [...document.querySelectorAll('.popup')].filter((p) => !p.classList.contains('hidden')).map((p) => p.id));
      assert.deepEqual(popups, [], 'no menu pops up in the pet window');
      await closeAdmin();
      await page.bringToFront();
      // a real key press as the window receives it (before-input-event sees sendInputEvent, not CDP key events)
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('admin-ui'));
        w.focus();
        w.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
        w.webContents.sendInputEvent({ type: 'keyUp', keyCode: ',', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
      });
      admin = await findAdmin();
      await atPath('/overview');
      return `right click → settings window (pet popups open: ${popups.length}); Ctrl+, → settings window (${await adminWins()})`;
    }, () => admin);

    await step(S, 'F5 升阶 Toast「去衣柜看看」→ 后台她的页（衣柜），点衣服立即换上', async () => {
      await page.bringToFront();
      await page.evaluate(() => window.pet.debugSet({ affection: 70 }));
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 10000 });
      await idle();
      const btn = (await page.textContent('#toast-open')).trim();
      const where = await page.getAttribute('#toast-open', 'data-admin');
      await hover(page);
      await shotPet('f5-unlock-toast');
      await page.click('#toast-open');
      admin = await findAdmin();
      await atPath(`/${where}`);
      let wore = '';
      if (where.startsWith('characters/')) {
        await until(admin, () => !!document.querySelector('[data-outfits] [data-outfit]'), null, 15000, 'the outfit rack');
        // T-2784: each outfit is a card (data-outfit), 穿上 is its [data-equip] button
        const before = await admin.evaluate(() => [...document.querySelectorAll('[data-outfits] [data-outfit]')].map((b) => `${b.dataset.outfit}${b.dataset.locked === 'true' ? '🔒' : ''}${b.dataset.equipped === 'true' ? '✓' : ''}`));
        await shotAdmin('f5-admin-wardrobe');
        const pick = await admin.evaluate(() => { const b = [...document.querySelectorAll('[data-outfits] [data-equip]')][0]; if (b) { b.click(); return b.dataset.equip; } return null; });
        if (pick) {
          await until(admin, (id) => document.querySelector(`[data-outfits] [data-outfit="${id}"]`)?.dataset.equipped === 'true', pick, 10000, 'outfit equipped');
          const petOutfit = await page.evaluate(() => window.pet.debugHeartbeat().then((v) => v.outfit));
          assert.equal(petOutfit, pick);
          wore = `; wore ${pick} (pet view.outfit=${petOutfit})`;
          await shotAdmin('f5-admin-wardrobe-worn');
        }
        wore = `; outfits ${before.join(' ')}${wore}`;
      } else await shotAdmin('f5-admin-topics');
      return `toast button 「${btn}」 → #/${where}${wore}`;
    }, () => admin);

    await step(S, 'F6 话题 → 后台 玩法 › 话题：点「聊聊」她在桌面上开口', async () => {
      await go('/topics');
      await until(admin, () => document.querySelectorAll('[data-topic]').length > 0, null, 10000, 'topics');
      const info = await admin.evaluate(() => ({ all: document.querySelectorAll('[data-topic]').length, open: document.querySelectorAll('[data-topic][data-locked="false"]').length }));
      await shotAdmin('f6-admin-topics');
      const id = await admin.evaluate(() => { const r = document.querySelector('[data-topic][data-locked="false"]'); r.querySelector('button').click(); return r.dataset.topic; });
      await page.waitForFunction(() => document.body.classList.contains('busy') || /echo/.test(document.getElementById('bubble').textContent), null, { timeout: 10000 });
      const reply = await waitReply(page, 20000);
      await idle();
      const run = calls().filter((a) => a[0] === 'agent' && a[1] === 'run').pop();
      map.push(['话题（原工具栏按钮）', '玩法 › 和她一起 › 话题（聊聊）']);
      return `${info.open}/${info.all} topics unlocked; 聊聊 ${id} → pet bubble 「${reply.slice(0, 50)}」; lh ${run.slice(0, 2).join(' ')}`;
    }, () => admin);

    await step(S, 'F7 聊天记录 → 后台 玩法 › 聊天记录：列表与对话', async () => {
      await go('/history');
      await until(admin, () => document.querySelectorAll('[data-session]').length > 0, null, 10000, 'a conversation');
      const n = await admin.evaluate(() => document.querySelectorAll('[data-session]').length);
      await shotAdmin('f7-admin-history-list');
      await admin.evaluate(() => document.querySelector('[data-session]').click());
      await until(admin, () => !!document.querySelector('[data-history-thread] [data-role="pet"]'), null, 10000, 'the thread');
      const t = await admin.evaluate(() => [...document.querySelectorAll('[data-history-thread] [data-role]')].map((m) => `${m.dataset.role}: ${m.innerText.replace(/\s+/g, ' ').slice(0, 50)}`));
      await shotAdmin('f7-admin-history-thread');
      map.push(['聊天记录', '玩法 › 和她一起 › 聊天记录']);
      return `${n} conversation(s); thread: ${t.join(' | ')}`;
    }, () => admin);

    await step(S, 'F8 动作 → 后台 玩法 › 桌面上的她：9 个动作逐个点，桌宠执行', async () => {
      await go('/desk');
      const cues = await admin.evaluate(() => [...document.querySelectorAll('[data-cue]')].map((b) => `${b.dataset.cue}:${b.textContent.trim()}`));
      assert.equal(cues.length, 9);
      const done = [];
      for (const c of cues.map((x) => x.split(':')[0])) {
        const r = await admin.evaluate((x) => window.petAdmin.cue(x), c).catch((e) => ({ ok: false, reason: String(e) }));
        const fx = await page.evaluate(() => window.petFx.state());
        done.push(`${c}=${r.ok ? 'ok' : r.reason}${fx && fx.lastCue ? `(${fx.lastCue})` : ''}`);
        await page.waitForTimeout(150);
      }
      // and one real click on a button
      await admin.evaluate(() => document.querySelector('[data-cue="happy"]').click());
      await toastSeen(/她：开心/);
      await shotAdmin('f8-admin-desk');
      assert.ok(done.every((d) => /=ok/.test(d)), done.join(' '));
      map.push(['动作…', '玩法 › 和她一起 › 桌面上的她 › 动作（9 个）']);
      return `buttons ${cues.join(' ')}; results ${done.join(' ')}`;
    }, () => admin);

    await step(S, 'F9 回到右下角 → 后台 桌面上的她：被拖走的桌宠回到右下角', async () => {
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.getURL().includes('admin-ui')); w.setPosition(100, 100); });
      const before = await petBounds(app);
      await admin.evaluate(() => document.querySelector('[data-desk-home]').click());
      await toastSeen(/回到右下角/);
      const after = await petBounds(app);
      const wa = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
      assert.equal(after.x + after.width, wa.x + wa.width - 24);
      assert.equal(after.y + after.height, wa.y + wa.height - 24);
      await shotAdmin('f9-admin-home');
      desktop('f9-desktop-pet-home');
      map.push(['回到右下角', '玩法 › 和她一起 › 桌面上的她 › 回到右下角']);
      return `pet window ${before.x},${before.y} → ${after.x},${after.y} (${after.width}x${after.height}; work area ${wa.width}x${wa.height})`;
    }, () => admin);

    await step(S, 'F10 角色列表 → 后台 角色：图鉴与她的页', async () => {
      await go('/characters');
      await until(admin, () => document.querySelectorAll('[data-character], [data-card], a[href^="#/characters/"]').length >= 5, null, 10000, 'character cards');
      const n = await admin.evaluate(() => document.querySelectorAll('a[href^="#/characters/"], [data-character]').length);
      await shotAdmin('f10-admin-characters');
      await go('/characters/claude');
      const title = await admin.evaluate(() => document.querySelector('[data-character-title]').textContent.trim());
      map.push(['角色列表', '角色（rail）› 角色图鉴 › 她的页']);
      return `${n} character entries; /characters/claude title 「${title}」`;
    }, () => admin);

    await step(S, 'F11 重新开始话题 → 后台 设置 › LobeHub 与本机：二次确认后开新话题', async () => {
      const before = petState();
      const cur = before.currentSpecies || before.speciesId;
      const epoch = (o) => { const c = (o.characters || {})[cur] || Object.values(o.characters || {})[0] || {}; return c.topicEpoch || 0; };
      await go('/connection');
      await admin.evaluate(() => document.querySelector('[data-new-topic]').click());
      const dlg = await dialogOk('重新开始话题');
      await shotAdmin('f11-admin-new-topic-confirm');
      await dialogClick('重新开始话题');
      await toastSeen(/新话题/);
      const after = petState();
      assert.equal(epoch(after), epoch(before) + 1);
      map.push(['重新开始话题', '设置 › 连接 › LobeHub 与本机 › 话题 › 重新开始话题（二次确认）']);
      return `confirm 「${dlg}」; topicEpoch ${epoch(before)} → ${epoch(after)}`;
    }, () => admin);

    await step(S, 'F12 本机能力开关 → 后台 LobeHub 与本机：开（二次确认）→ 关', async () => {
      const loc = () => page.evaluate(() => window.pet.debugHeartbeat().then((v) => !!(v.local && v.local.enabled)));
      const was = await loc();
      await flip('localAbilities');
      const dlg = await dialogOk('开启本机能力');
      await shotAdmin('f12-admin-local-confirm');
      await dialogClick('开启本机能力');
      for (let i = 0; i < 100 && !(await loc()); i++) await page.waitForTimeout(150);
      const on = await loc();
      await shotAdmin('f12-admin-local-on');
      await flip('localAbilities');
      for (let i = 0; i < 100 && (await loc()); i++) await page.waitForTimeout(150);
      const off = await loc();
      assert.deepEqual([was, on, off], [false, true, false]);
      map.push(['本机能力：开/关', '设置 › 连接 › LobeHub 与本机 › 本机能力（开启需二次确认）']);
      return `confirm 「${dlg}」; local ${was} → ${on} → ${off}`;
    }, () => admin);

    await step(S, 'F13 成人向内容开关 → 后台 设置 › 内容与安全：年龄确认后打开，再关闭', async () => {
      await go('/safety');
      const adult = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).adultContent;
      const was = adult();
      await flip('adultContent');
      const dlg = await dialogOk('我已满 18 周岁');
      await shotAdmin('f13-admin-adult-confirm');
      await dialogClick('我已满 18 周岁');
      const ok = '我已满 18 周岁';
      for (let i = 0; i < 60 && !adult(); i++) await page.waitForTimeout(150);
      const on = adult();
      await shotAdmin('f13-admin-adult-on');
      await flip('adultContent');
      for (let i = 0; i < 60 && adult(); i++) await page.waitForTimeout(150);
      const off = adult();
      assert.deepEqual([was, on, off], [false, true, false]);
      map.push(['成人向内容：开/关', '设置 › 系统 › 内容与安全 › 成人向内容（打开需 18+ 确认）']);
      return `dialog 「${dlg}」 → 「${ok}」; adultContent ${was} → ${on} → ${off}`;
    }, () => admin);

    await step(S, 'F14 检查更新 / 新版本 → 后台 版本与更新；有新版本时 ⚙ 出现红点并直达该页', async () => {
      await go('/update');
      tag = 'v0.0.1';
      await clickText('button', '检查更新');
      await until(admin, () => /已是最新版本/.test(document.querySelector('[data-path="/update"]').innerText), null, 15000, '已是最新版本');
      const latest = (await pageText()).match(/状态 [^ ]+/)[0];
      tag = 'v9.9.9';
      await clickText('button', '检查更新');
      await until(admin, () => /需要手动下载新版本/.test(document.querySelector('[data-path="/update"]').innerText), null, 15000, '新版本');
      await shotAdmin('f14-admin-update-found');
      // the pet window: a dot on ⚙, and ⚙ goes straight to 版本与更新
      await page.bringToFront();
      await page.waitForFunction(() => document.getElementById('btn-settings').dataset.news === 'update', null, { timeout: 5000 });
      await hover(page);
      await page.waitForTimeout(300);
      await shotPet('f14-pet-gear-dot');
      const title = await page.getAttribute('#btn-settings', 'title');
      await go('/overview');
      await page.click('#btn-settings');
      await atPath('/update');
      const btn = await admin.evaluate(() => { const b = document.querySelector('[data-update-download]'); return b ? b.textContent.trim() : ''; });
      assert.match(btn, /下载新版本 v9\.9\.9/);
      await admin.evaluate(() => document.querySelector('[data-update-download]').click());
      await admin.waitForTimeout(500);
      const links = await page.evaluate(() => window.pet.debugOpenedLinks());
      await shotAdmin('f14-admin-update-download');
      map.push(['检查更新', '设置 › 系统 › 版本与更新 › 检查更新']);
      map.push(['新版本（下载/立即更新）', '⚙ 红点 → 版本与更新 › 下载新版本 / 立即更新']);
      return `first check: ${latest}; then ⚙ title 「${title}」 → #/update, button 「${btn}」; opened ${JSON.stringify(links.slice(-1))}`;
    }, () => admin);

    await step(S, 'F15 打开错误日志 / 素材署名 → 后台 设置 › 数据与关于', async () => {
      await go('/about');
      const log = path.join(data, 'pixel-pet.log');
      const existed = fs.existsSync(log);
      await clickText('button', '打开错误日志');
      for (let i = 0; i < 30 && !fs.existsSync(log); i++) await page.waitForTimeout(100);
      const credits = await admin.evaluate(() => { const s = [...document.querySelectorAll('h1,h2,h3,h4,div')].find((e) => e.textContent.trim() === '素材署名'); return s ? s.closest('[class]').parentElement.innerText.replace(/\s+/g, ' ').slice(0, 160) : ''; });
      await shotAdmin('f15-admin-about');
      assert.ok(fs.existsSync(log), 'open-log touched the log file');
      assert.match(await pageText(), /素材署名/);
      map.push(['打开错误日志', '设置 › 系统 › 数据与关于 › 打开错误日志']);
      map.push(['素材署名', '设置 › 系统 › 数据与关于 › 素材署名']);
      return `log file ${existed ? 'existed' : 'created'} → ${fs.existsSync(log)} (${log.replace(os.tmpdir(), '$TMP')}); credits 「${credits.slice(0, 100)}」`;
    }, () => admin);

    await step(S, 'F16 仅重置本地 → 数据与关于：二次确认（先取消一次），确认后回到选角页、LobeHub agent 保留', async () => {
      await clickText('button', '仅重置本地');
      const dlg = await dialogOk('仅重置本地');
      await shotAdmin('f16-admin-forget-confirm');
      await dialogClick('取消');
      await admin.waitForTimeout(400);
      const still = fs.existsSync(path.join(data, 'pet.json')) && !!petState().speciesId;
      await clickText('button', '仅重置本地');
      await dialogOk('仅重置本地');
      await dialogClick('仅重置本地');
      await toastSeen(/已重置本地进度/);
      await page.waitForSelector('#onboarding:not(.hidden)', { timeout: 10000 });
      const deletes = calls().filter((a) => a[0] === 'agent' && a[1] === 'delete').length;
      assert.equal(deletes, 0);
      await shotPet('f16-pet-onboarding-after-forget');
      map.push(['仅重置本地', '设置 › 系统 › 数据与关于 › 危险操作 › 仅重置本地（二次确认）']);
      return `confirm 「${dlg}」; after 取消 still has a pet: ${still}; after 确认: onboarding shown, lh agent delete calls ${deletes}`;
    }, () => admin);

    await step(S, 'F17 放生并删除 agent → 数据与关于：二次确认后删除 LobeHub agent', async () => {
      await page.bringToFront();
      await page.click('.char-card[data-species="claude"]');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await idle();
      await go('/about');
      await clickText('button', '放生并删除 agent');
      const dlg = await dialogOk('放生并删除 agent');
      await shotAdmin('f17-admin-release-confirm');
      await dialogClick('放生并删除 agent');
      await toastSeen(/已放生/);
      await page.waitForSelector('#onboarding:not(.hidden)', { timeout: 10000 });
      const deletes = calls().filter((a) => a[0] === 'agent' && a[1] === 'delete');
      assert.ok(deletes.length >= 1);
      map.push(['放生并删除 agent', '设置 › 系统 › 数据与关于 › 危险操作 › 放生并删除 agent（二次确认）']);
      return `confirm 「${dlg}」; lh agent delete ×${deletes.length} (${deletes.map((a) => a[2]).join(', ')}); pet back on onboarding`;
    }, () => admin);

    await step(S, 'F18 退出 → 后台 桌面上的她：二次确认后整个应用退出', async () => {
      await go('/desk');
      await admin.evaluate(() => document.querySelector('[data-desk-quit]').click());
      const dlg = await dialogOk('退出');
      await shotAdmin('f18-admin-quit-confirm');
      const exited = new Promise((r) => app.process().once('exit', (code) => r(code)));
      await dialogClick('退出').catch(() => {}); // the window may be gone before the click returns
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 10000))]);
      assert.notEqual(code, 'still running');
      map.push(['退出', '玩法 › 和她一起 › 桌面上的她 › 退出（二次确认）']);
      return `confirm 「${dlg}」; app process exit code ${code}`;
    });

    await step(S, 'F19 无页面错误；菜单项 → 后台入口 对照表', async () => {
      assert.deepEqual(errors, []);
      fs.writeFileSync(path.join(SHOTS, 'menu-map.json'), JSON.stringify(map, null, 2));
      return `page errors 0; ${map.length} entries: ${map.map((m) => `${m[0]} → ${m[1]}`).join(' ; ')}`;
    });
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
}


// ---------------------------------------------------------------- petui
// The pet window's own UI (bubble, HUD bars + 好感, toolbar, chat box, ⋯ menu, stage-up toast, #panel:
// 衣柜 / 话题 / 聊天记录 / 角色列表 and her page, 18+ gate, onboarding) in light and dark. The OS appearance reaches the
// renderer as prefers-color-scheme (Electron nativeTheme), exactly as for the admin window; here it is forced
// with nativeTheme.themeSource. Asserts the window reads the LobeHub tokens (--lobe-*) and switches with the theme.
// usage: xvfb-run -a node e2e/run.js petui. Screenshots in out/e2e/petui/<theme>/ (PIXELPET_PETUI_TAG=<dir> to rename).
async function petuiScenario() {
  const S = 'petui';
  const ROOTSHOTS = path.join(OUT, process.env.PIXELPET_PETUI_TAG || 'petui');
  for (const theme of ['light', 'dark']) {
    const SHOTS = path.join(ROOTSHOTS, theme);
    fs.mkdirSync(SHOTS, { recursive: true });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-petui-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-petuifake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
    // the 18+ question shows on a first launch: shoot it, then answer “all ages”
    const { app, page } = await launch(env, { gate: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
    const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const tokens = () => page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const b = getComputedStyle(document.getElementById('age-gate'));
      return { theme: document.documentElement.dataset.theme, dark: matchMedia('(prefers-color-scheme: dark)').matches, bgContainer: cs.getPropertyValue('--lobe-color-bg-container').trim(), text: cs.getPropertyValue('--lobe-color-text').trim(), gateBg: b.backgroundColor, font: getComputedStyle(document.body).fontFamily.split(',')[0] };
    });
    try {
      // nativeTheme drives prefers-color-scheme on macOS / Windows; xvfb has no desktop theme, so pin the media too
      await app.evaluate(({ nativeTheme }, t) => { nativeTheme.themeSource = t; }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await step(S, `${theme}: 18+ 确认页使用 LobeHub 令牌（--lobe-*）并跟随系统主题`, async () => {
        await page.waitForSelector('#age-gate:not(.hidden)', { timeout: 15000 });
        await page.waitForFunction((t) => matchMedia('(prefers-color-scheme: dark)').matches === (t === 'dark') && document.documentElement.dataset.theme === t, theme);
        const t = await tokens();
        assert.equal(t.theme, theme);
        // @lobehub/ui theme values (src/renderer/design/tokens.json): container #ffffff / #0d0d0d, layout #f8f8f8 / #000000
        assert.deepEqual([t.bgContainer, t.gateBg], theme === 'dark' ? ['#0d0d0d', 'rgb(0, 0, 0)'] : ['#ffffff', 'rgb(248, 248, 248)']);
        assert.equal(t.font, 'Geist');
        await shot('00-age-gate');
        return JSON.stringify(t);
      }, page);
      await page.click('#age-no');
      await step(S, `${theme}: 选角页（卡片、复选、输入框、主按钮）`, async () => {
        await page.waitForSelector('.char-card');
        await page.locator('.char-card[data-species="claude"]').first().click();
        await page.fill('#pet-name', '小克');
        await shot('01-onboarding');
      }, page);
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await idle();
      await step(S, `${theme}: 悬停：气泡、状态条、好感度、工具栏`, async () => {
        await page.waitForFunction(() => !document.getElementById('bubble').classList.contains('hidden'), null, { timeout: 10000 });
        await hover(page);
        await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '1');
        await shot('02-hover-hud-bubble');
        return `bubble 「${(await bubbleText(page)).slice(0, 30)}」`;
      }, page);
      // T-2726: the status bar is ONE panel — needs, affection and the name line share one surface (rows split by
      // hairlines); values still update live, it fits the window at the smallest pet size, and it only shows on hover
      const panelGeom = () => page.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) }; };
        const panel = document.getElementById('status-panel');
        const cs = getComputedStyle(panel);
        const rows = ['bars', 'aff-row', 'meta'].map((id) => { const el = document.getElementById(id); const c = getComputedStyle(el); return { id, in: panel.contains(el), bg: c.backgroundColor, shadow: c.boxShadow, borderTop: c.borderTopWidth, ...r(el) }; });
        const meta = document.getElementById('meta');
        return { win: innerWidth, panel: r(panel), bg: cs.backgroundColor, border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow !== 'none', rows, toolbar: r(document.getElementById('toolbar')), metaCut: meta.scrollWidth > meta.clientWidth, hudOpacity: getComputedStyle(document.getElementById('hud')).opacity };
      });
      await step(S, `${theme}: 状态栏是一个整体 Panel（需求 / 好感 / 信息行同一底板，分隔线分区）`, async () => {
        await hover(page);
        await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '1');
        const g = await panelGeom();
        assert.equal(g.border, '1px'); assert.ok(g.shadow); assert.notEqual(g.bg, 'rgba(0, 0, 0, 0)');
        for (const row of g.rows) {
          assert.ok(row.in, `${row.id} inside the panel`);
          assert.equal(row.bg, 'rgba(0, 0, 0, 0)', `${row.id} has no own background`);
          assert.equal(row.shadow, 'none', `${row.id} has no own shadow`);
          assert.ok(row.x >= g.panel.x && row.r <= g.panel.r && row.y >= g.panel.y && row.b <= g.panel.b, `${row.id} within the panel box`);
        }
        assert.deepEqual(g.rows.map((x) => x.borderTop), ['0px', '1px', '1px'], 'hairlines between the three rows');
        assert.ok(g.panel.x >= 0 && g.panel.r <= g.win, 'panel inside the window');
        assert.ok(g.toolbar.y >= g.panel.b, 'toolbar right under the panel');
        await shot('02b-status-panel');
        return JSON.stringify({ win: g.win, panel: g.panel, radius: g.radius, rows: g.rows.map((x) => `${x.id}:${x.w}x${x.h}@${x.y} top=${x.borderTop}`), toolbarY: g.toolbar.y });
      }, page);
      await step(S, `${theme}: Panel 内数值实时更新（饥饿 / 心情 / 体力 / 好感）`, async () => {
        const vals = () => page.evaluate(() => ({ ...Object.fromEntries(['bar-hunger', 'bar-mood', 'bar-energy', 'bar-affection'].map((id) => [id, document.getElementById(id).style.getPropertyValue('--v')])), num: document.getElementById('aff-num').textContent, meta: document.getElementById('meta').textContent }));
        const before = await vals();
        await page.evaluate(() => window.pet.debugSet({ hunger: 90, mood: 15, energy: 50, affection: 12 }));
        await page.waitForFunction(() => document.getElementById('bar-hunger').style.getPropertyValue('--v') === '10%', null, { timeout: 8000 }); // debugSet saves → 'update' pushes the view
        const after = await vals();
        assert.equal(after['bar-hunger'], '10%'); assert.equal(after['bar-mood'], '15%'); assert.equal(after['bar-energy'], '50%');
        assert.match(after.meta, /♥12/);
        await hover(page);
        await shot('02c-status-panel-updated');
        return `before ${JSON.stringify(before)} → after ${JSON.stringify(after)}`;
      }, page);
      await step(S, `${theme}: 最小尺寸（50%）Panel 不溢出窗口；移开指针后隐藏`, async () => {
        const k = await page.evaluate(() => window.pet.setPetScale(0.5));
        await page.waitForFunction(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) === 0.5, null, { timeout: 8000 });
        await page.waitForTimeout(300);
        await hover(page);
        await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '1');
        const g = await panelGeom();
        assert.ok(g.panel.x >= 0 && g.panel.r <= g.win, `panel ${g.panel.x}..${g.panel.r} inside window ${g.win}`);
        for (const row of g.rows) assert.ok(row.r <= g.panel.r, `${row.id} inside the panel`);
        await shot('02d-status-panel-smallest');
        await page.mouse.move(-20, -20);
        await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
        await page.waitForFunction(() => !document.body.classList.contains('hover') && getComputedStyle(document.getElementById('hud')).opacity === '0', null, { timeout: 5000 });
        await page.evaluate(() => window.pet.setPetScale(1.25));
        await page.waitForFunction(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) === 1.25, null, { timeout: 8000 });
        return `scale ${typeof k === 'object' ? JSON.stringify(k) : k}: window ${g.win}px, panel ${g.panel.x}..${g.panel.r} (${g.panel.w}px), meta cut with … = ${g.metaCut}; hidden again off hover`;
      }, page);
      await step(S, `${theme}: 聊天输入框（附件 / 麦克风 / 发送）`, async () => {
        await clickAct(page, 'chat');
        await page.waitForFunction(() => document.activeElement === document.getElementById('chat-input'));
        await shot('03a-chat-row-placeholder'); // empty and focused: the placeholder
        await page.fill('#chat-input', '今天也辛苦啦，晚上想吃什么？');
        await shot('03-chat-row');
        await page.press('#chat-input', 'Enter');
        await page.waitForFunction(() => /echo: 今天也辛苦啦/.test(document.getElementById('bubble').textContent), null, { timeout: 20000 });
        await idle();
        await hover(page);
        await shot('04-chat-reply');
        await page.click('[data-act="chat"]'); // the chat box sits over the toolbar: close it again
        await page.waitForSelector('#chat-row.hidden', { state: 'attached' });
      }, page);
      await step(S, `${theme}: 工具栏（喂食 / 玩耍 / 睡觉 / 聊天 + 🔈 静音 + ⚙ 设置，无 ⋯ 菜单）`, async () => {
        await hover(page);
        await page.waitForTimeout(400);
        await shot('05-toolbar');
        // a pixel look: ♪ 跳舞 (VRM only, T-2801) is in the toolbar but hidden
        const acts = await page.$$eval('#toolbar [data-act]:not(.hidden)', (b) => b.map((x) => x.dataset.act));
        assert.deepEqual(acts, ['feed', 'play', 'sleep', 'chat', 'mute', 'settings', 'quit']);
        assert.equal(await page.$eval('#btn-dance', (b) => b.classList.contains('hidden')), true, '♪ hidden on a pixel look');
        const rows = await page.$$eval('#toolbar [data-act]:not(.hidden)', (b) => new Set(b.map((x) => Math.round(x.getBoundingClientRect().top))).size);
        assert.equal(rows, 1, 'the toolbar fits on one row');
        return acts.join(' / ');
      }, page);
      await step(S, `${theme}: 喂食菜单`, async () => {
        await clickAct(page, 'feed');
        await page.waitForSelector('#food-menu:not(.hidden)');
        await page.waitForTimeout(400); // let the menu's open transition finish
        await shot('06-food-menu');
        await page.mouse.move(-20, -20);
        await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
        await page.waitForSelector('#food-menu.hidden', { state: 'attached' });
      }, page);
      await step(S, `${theme}: 升阶提示 Toast`, async () => {
        await page.evaluate(() => window.pet.debugSet({ affection: 20 }));
        await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 10000 });
        await idle();
        await page.waitForTimeout(300);
        await shot('07-unlock-toast');
        return (await page.textContent('#toast-title')).trim();
      }, page);
      // 话题 / 衣柜 / 聊天记录 / 角色列表 left the pet window (T-2718): the toast and ⚙ open the settings window
      await step(S, `${theme}: Toast「去衣柜看看 / 去聊聊新话题」与 ⚙ 打开设置窗口`, async () => {
        const where = await page.getAttribute('#toast-open', 'data-admin');
        assert.match(where, /^(characters\/claude-pixel|topics)$/);
        await page.click('#toast-open');
        let admin = null;
        for (let i = 0; i < 200 && !admin; i++) { admin = app.windows().find((w) => w.url().includes('admin-ui')) || null; if (!admin) await page.waitForTimeout(100); }
        await adminUntil(admin, (p) => !!document.querySelector(`[data-path="/${p}"]`), where, 15000, where);
        await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('admin-ui')) w.destroy(); });
        await page.bringToFront();
        await hover(page);
        await page.waitForTimeout(300);
        await shot('08-toolbar-settings');
        assert.equal(await page.locator('#btn-topics, #btn-wardrobe, #main-menu, #panel').count(), 0);
        return `toast → #/${where}; toolbar: ${(await page.textContent('#toolbar')).replace(/\s+/g, ' ').trim()} + ⚙`;
      }, page);
      await step(S, `${theme}: 无页面错误`, async () => {
        assert.deepEqual(errors, []);
        return 'page errors 0';
      });
    } finally {
      await app.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------- wardrobepack (衣柜按角色隔离, T-2752 / T-2784 衣柜卡片)
// The wardrobe follows the pack she wears: 大肥鱼 in her pixel pack has a full 衣柜; changing into her Live2D
// pack (art for daily only) leaves daily alone, takes off the scarf she wore (saved), refuses other outfits and
// never swaps her into another pack. Driven through the settings window like a user. Free: fake lh, no network.
async function wardrobePackScenario() {
  const S = 'wardrobepack';
  const SHOTS = path.join(OUT, 'wardrobepack');
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wardrobe-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wardrobefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1' });
  const savedPet = () => JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
  const errors = [];
  let admin = null;
  const W = 1180;
  const until = async (what, fn, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what}: not within ${ms} ms`);
  };
  const attached = (sel) => until(sel, () => admin.evaluate((x) => !!document.querySelector(x), sel));
  const call = (fn, ...args) => admin.evaluate(([f, a]) => window.petAdmin[f](...a), [fn, args]);
  const go = async (route) => {
    await admin.bringToFront();
    await admin.evaluate((r) => { location.hash = r; }, route);
    await attached(`[data-path="${route}"]`);
    await admin.waitForTimeout(300);
  };
  const tab = async (name) => {
    await admin.bringToFront();
    await admin.getByRole('tab', { name, exact: true }).click();
    await until(`tab ${name}`, () => admin.evaluate((n) => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === n); return !!t && t.getAttribute('aria-selected') === 'true' && document.querySelectorAll('[role="tabpanel"]').length === 1; }, name));
    await admin.waitForTimeout(250);
  };
  const shot = async (name) => {
    const h = await admin.evaluate(() => { const el = document.querySelector('[data-admin-page]'); return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 48); });
    await app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, Math.min(Math.max(hh, 860), 3200)); }, [W, h]);
    await admin.waitForTimeout(350);
    await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 860); }, W);
    return `${name}.png`;
  };
  const petShot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).then(() => `${name}.png`);
  const chips = (id) => admin.$$eval(`[data-outfits="${id}"] [data-outfit]`, (els) => els.map((e) => e.getAttribute('data-outfit')));
  // T-2784: one outfit = one card: its picture (a try-on button), name, rating / 新 tags, and 正在穿 or 穿上
  const cards = (id) => admin.$$eval(`[data-outfits="${id}"] [data-outfit]`, (els) => els.map((e) => ({
    id: e.dataset.outfit,
    text: e.textContent,
    cover: !!e.querySelector(`[data-try-outfit="${e.dataset.outfit}"]`),
    drawn: !!e.querySelector('[data-drawn]'),
    picture: !!e.querySelector('canvas, img, video'),
    rating: e.querySelector('[data-rating]')?.textContent || '',
    isNew: !!e.querySelector('[data-new-outfit]'),
    worn: e.querySelector('[data-worn]')?.textContent || '',
    equip: e.querySelector('[data-equip]')?.textContent || '',
    equipped: e.dataset.equipped === 'true',
    locked: e.dataset.locked === 'true',
  })));
  const petLook = () => page.evaluate(() => ({ kind: document.getElementById('pet-body').dataset.kind, outfit: document.getElementById('char-wrap').dataset.outfit }));
  const viewNow = async () => { const v = (await call('state')).view; return { packId: v.look && v.look.packId, kind: v.look && v.look.kind, outfit: v.outfit, outfits: v.outfits.map((o) => o.id), cards: [...new Set(v.outfits.map((o) => o.look && o.look.packId))] }; };
  try {
    await step(S, 'W0 hatch 大肥鱼, open the settings window, unlock every stage', async () => {
      await page.waitForSelector('.char-card');
      // the pet window's only look picker is 选择模型娘: one card per character (T-2764), no 形象包 grouping
      const picker = await page.$$eval('.char-card', (els) => els.map((e) => `${e.dataset.character}|${e.querySelector('.nm').textContent}|${e.querySelector('.vendor').textContent}`));
      assert.ok(picker.some((x) => x.startsWith('dafeiyu-pixel|大肥鱼 · 像素')) && picker.some((x) => x.startsWith('dafeiyu-live2d|大肥鱼 · Live2D')), picker.join(' '));
      assert.ok(!(await page.textContent('body')).includes('形象包'), 'no 形象包 in the pet window');
      await page.waitForTimeout(1500);
      await petShot('w0-pet-window-character-picker');
      fs.writeFileSync(path.join(SHOTS, 'w0-pet-window-character-picker.txt'), picker.join('\n') + '\n');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await clickAct(page, 'settings');
      for (let i = 0; i < 200 && !admin; i++) {
        admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
        if (!admin) await page.waitForTimeout(100);
      }
      assert.ok(admin, 'the settings window opened');
      admin.on('pageerror', (e) => errors.push(String(e)));
      admin.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await admin.waitForSelector('[data-admin-page="overview"]', { timeout: 20000 });
      await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));
      const u = await call('unlockAll', 'dafeiyu');
      assert.equal(u.ok, true);
      if (await page.isVisible('#toast-close')) await page.evaluate(() => document.getElementById('toast-close').click());
      const v = await viewNow();
      assert.equal(v.packId, 'dafeiyu-pixel');
      return `default pack ${v.packId}; wardrobe ${v.outfits.join(',')}`;
    }, page);

    await step(S, 'W0b 角色图鉴: 「大肥鱼 · 像素」 and 「大肥鱼 · Live2D」 are two cards of their own; no 形象包 wording; 按形象类型 still filters', async () => {
      await go('/characters');
      await attached('[data-row="dafeiyu-pixel"]');
      await attached('[data-row="dafeiyu-live2d"]');
      const rows = await admin.$$eval('[data-roster] [data-row]', (els) => els.map((e) => ({ id: e.dataset.row, kind: e.dataset.kind, text: e.textContent })));
      const fish = rows.filter((r) => r.id.startsWith('dafeiyu-'));
      assert.ok(fish.length >= 3, fish.map((r) => r.id).join(','));
      assert.match(rows.find((r) => r.id === 'dafeiyu-pixel').text, /大肥鱼 · 像素/);
      assert.match(rows.find((r) => r.id === 'dafeiyu-live2d').text, /大肥鱼 · Live2D/);
      assert.equal(rows.find((r) => r.id === 'dafeiyu-pixel').kind, 'sprites');
      assert.equal(rows.find((r) => r.id === 'dafeiyu-live2d').kind, 'live2d');
      // the cards in view draw her (first frame of each character's own look) before the screenshot
      await until('roster cards drawn', () => admin.evaluate(() => [...document.querySelectorAll('[data-roster] [data-row]')].every((r) => !!r.querySelector('[data-drawn]'))), 60000);
      const page0 = await admin.textContent('[data-admin-page]');
      for (const w of ['形象包', '跟随形象包', '有导入包']) assert.ok(!page0.includes(w), `no 「${w}」 on 角色图鉴`);
      assert.equal(await admin.locator('[data-pack-kinds]').count(), 0, 'no per-pack kind row on the cards');
      assert.equal((await admin.textContent('[data-go-import]')).trim(), '导入角色');
      // the page as text and its controls, for the record (w0b-roster-dom.json)
      const dom = await admin.evaluate(() => ({
        route: location.hash,
        innerText: document.querySelector('[data-admin-page]').innerText,
        filter: document.querySelector('[data-kind-filter]').innerText.split('\n').map((x) => x.trim()).filter(Boolean),
        filterHtml: document.querySelector('[data-kind-filter]').outerHTML,
        importButton: document.querySelector('[data-go-import]').outerHTML,
        cards: [...document.querySelectorAll('[data-roster] [data-row]')].map((e) => ({ id: e.dataset.row, kind: e.dataset.kind, link: e.querySelector('a').getAttribute('href'), title: e.querySelector('a').getAttribute('aria-label') })),
        oldWordsFound: ['形象包', '跟随形象包', '有导入包', '导入角色包', 'packs'].filter((w) => document.querySelector('[data-admin-page]').innerText.includes(w)),
      }));
      fs.writeFileSync(path.join(SHOTS, 'w0b-roster-dom.json'), JSON.stringify(dom, null, 2));
      assert.deepEqual(dom.oldWordsFound, []);
      const all = await shot('w0b-roster-all');
      // 按形象类型 → Live2D: only Live2D characters, 「大肥鱼 · Live2D」 among them and not her pixel self
      await admin.locator('[data-kind-filter]').getByText(/^Live2D \d+$/).click();
      await attached('[data-roster-filter="live2d"]');
      const l2d = await admin.$$eval('[data-roster] [data-row]', (els) => els.map((e) => e.dataset.row));
      assert.ok(l2d.includes('dafeiyu-live2d') && !l2d.includes('dafeiyu-pixel'), l2d.join(','));
      const filtered = await shot('w0b-roster-live2d');
      await admin.locator('[data-kind-filter]').getByText(/^全部 \d+$/).click();
      await attached('[data-roster-filter="all"]');
      const filter = (await admin.textContent('[data-kind-filter]')).trim();
      // the import page: 导入角色, no 形象包 / 外观资源 wording
      await admin.click('[data-go-import]');
      await attached('[data-path="/packs"]');
      await attached('[data-import-pack]');
      assert.equal((await admin.textContent('[data-import-pack]')).trim(), '导入角色…');
      const packsText = await admin.textContent('[data-admin-page]');
      for (const w of ['形象包', '外观资源']) assert.ok(!packsText.includes(w), `no 「${w}」 on the import page`);
      const imp = await shot('w0b-import-page');
      return `${rows.length} characters, 大肥鱼: ${fish.map((r) => `${r.id}(${r.kind})`).join(' ')}; filter 「${filter}」; Live2D → ${l2d.join(',')}; ${[all, filtered, imp].join(', ')}`;
    }, () => admin);

    // T-2764: every look is a character of her own: 「大肥鱼 · 像素」 and 「大肥鱼 · Live2D」 each have their own 衣柜
    // (her page, data-outfits="<character id>"); switching between them is switching characters (same agent and
    // affection, she is the same girl), and each one keeps the outfit she wore.
    const wardrobeOf = (id) => (savedPet().characters.dafeiyu.wardrobes || {})[id] || {};
    const switchTo = async (id) => {
      await go(`/characters/${id}`);
      await attached(`[data-switch="${id}"]`);
      await admin.click(`[data-switch="${id}"]`);
      await until(`${id} current`, async () => (await call('state')).view.pet.characterId === id);
      await tab('装扮');
    };
    await step(S, 'W1 「大肥鱼 · 像素」: her 衣柜 is a card list of the pixel pack\'s outfits (picture, name, rating, 新, 正在穿 / 穿上); 穿上 针织围巾套装 dresses her', async () => {
      await go('/characters/dafeiyu-pixel');
      const t0 = Date.now();
      await tab('装扮');
      await attached('[data-outfits="dafeiyu-pixel"] [data-outfit="scarf"]');
      // thumbnails: the cards in view draw their first frame; the rest wait until scrolled to (lazy)
      await until('first thumbnails drawn', async () => (await cards('dafeiyu-pixel')).filter((c) => c.drawn).length >= 2, 20000);
      const firstMs = Date.now() - t0;
      const c0 = await cards('dafeiyu-pixel');
      const drawnFirst = c0.filter((c) => c.drawn).length;
      assert.ok(c0.length >= 10, `${c0.length} cards`);
      assert.ok(c0.every((c) => c.cover && c.picture), 'every card has a picture');
      assert.ok(c0.every((c) => c.rating === '全年龄' || c.rating === '成人'), 'every card has its rating tag');
      assert.equal(c0.filter((c) => c.equipped).length, 1);
      assert.equal(c0.find((c) => c.equipped).worn, '正在穿');
      assert.ok(c0.filter((c) => !c.equipped && !c.locked).every((c) => c.equip === '穿上'), 'the others offer 穿上');
      const fresh = c0.filter((c) => c.isNew).map((c) => c.id);
      assert.ok(fresh.length > 0, 'outfits unlocked since she last looked carry 新');
      const s0 = await shot('w1-pixel-wardrobe-cards');
      // scroll through: every card ends up drawn
      for (const c of c0) await admin.locator(`[data-outfits="dafeiyu-pixel"] [data-outfit="${c.id}"]`).scrollIntoViewIfNeeded();
      await until('every thumbnail drawn', async () => (await cards('dafeiyu-pixel')).every((c) => c.drawn), 60000);
      const allMs = Date.now() - t0;
      // try on (not saved): her stage shows it, the caption says 试穿中
      await admin.locator('[data-try-outfit="scarf"]').scrollIntoViewIfNeeded();
      await admin.click('[data-try-outfit="scarf"]');
      await attached('[data-trying-tag]');
      assert.match(await admin.textContent('[data-worn-caption="dafeiyu-pixel"]'), /试穿中：针织围巾套装/);
      assert.equal(await admin.getAttribute('[data-outfit="scarf"]', 'data-trying'), 'true');
      assert.equal(wardrobeOf('dafeiyu-pixel').equippedOutfit || 'daily', 'daily', 'trying on saves nothing');
      const s1 = await shot('w1b-pixel-try-scarf');
      await admin.click('[data-outfits="dafeiyu-pixel"] [data-equip="scarf"]');
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'scarf', null, { timeout: 8000 });
      await attached('[data-outfit="scarf"][data-equipped="true"]');
      await page.waitForTimeout(500);
      const c = await chips('dafeiyu-pixel');
      assert.ok(c.length > 1 && c.includes('scarf'), c.join(','));
      assert.equal(wardrobeOf('dafeiyu-pixel').equippedOutfit, 'scarf');
      await until('scarf card says 正在穿', async () => (await cards('dafeiyu-pixel')).find((x) => x.id === 'scarf').worn === '正在穿');
      assert.equal(await admin.locator('[data-trying-tag]').count(), 0, '穿上 ends the try-on');
      const out = [s0, s1, await shot('w1-pixel-wardrobe'), await petShot('w1-pet-pixel-scarf')];
      return `${c0.length} cards (dafeiyu-pixel): ${c0.map((x) => `${x.id}[${x.rating}${x.isNew ? ',新' : ''}${x.equipped ? ',正在穿' : ''}]`).join(' ')}; thumbnails: ${drawnFirst} drawn first in ${firstMs} ms, all ${c0.length} after scrolling in ${allMs} ms; pet window ${JSON.stringify(await petLook())}; ${out.join(', ')}`;
    }, () => admin);

    await step(S, 'W2 切换到角色「大肥鱼 · Live2D」: her own 衣柜 shows only daily, she is the Live2D model, the pixel one keeps her scarf', async () => {
      await switchTo('dafeiyu-live2d');
      await until('Live2D worn', async () => (await viewNow()).packId === 'dafeiyu-live2d');
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.kind === 'live2d' && document.getElementById('char-wrap').dataset.outfit === 'daily', null, { timeout: 15000 });
      await until('rack shows daily only', async () => JSON.stringify(await chips('dafeiyu-live2d')) === '["daily"]');
      await page.waitForTimeout(1500);
      const chipsNow = await chips('dafeiyu-live2d');
      const v = await viewNow();
      assert.deepEqual(v.outfits, ['daily']);
      assert.equal(v.outfit, 'daily');
      assert.equal(v.kind, 'live2d');
      assert.deepEqual(v.cards, ['dafeiyu-live2d'], 'every card is drawn from her Live2D pack');
      const others = ['scarf', 'swimsuit', 'qipao', 'beret', 'maid'].filter((o) => v.outfits.includes(o) || chipsNow.includes(o));
      assert.deepEqual(others, [], 'no outfit only another character has is listed');
      assert.equal(wardrobeOf('dafeiyu-live2d').equippedOutfit, 'daily');
      assert.equal(wardrobeOf('dafeiyu-pixel').equippedOutfit, 'scarf', 'her pixel self keeps the scarf');
      assert.equal(savedPet().characterId, 'dafeiyu-live2d');
      const out = [await shot('w2-live2d-wardrobe'), await petShot('w2-pet-live2d')];
      return `衣柜 chips ${chipsNow.join(',')}; view ${JSON.stringify(v)}; wardrobes ${JSON.stringify(savedPet().characters.dafeiyu.wardrobes)}; pet window ${JSON.stringify(await petLook())}; ${out.join(', ')}`;
    }, () => admin);

    await step(S, 'W3 an outfit her Live2D pack has not (scarf / swimsuit / qipao) is refused; she stays 「大肥鱼 · Live2D」', async () => {
      const rs = {};
      for (const id of ['scarf', 'swimsuit', 'qipao']) {
        const r = await call('equipOutfit', id);
        rs[id] = r.ok ? 'ok' : r.reason;
        assert.equal(r.ok, false, id);
        assert.ok(r.reason, `${id} refused with a reason`);
      }
      await page.waitForTimeout(800);
      const v = await viewNow();
      assert.equal(v.packId, 'dafeiyu-live2d');
      assert.equal(v.outfit, 'daily');
      const pl = await petLook();
      assert.deepEqual(pl, { kind: 'live2d', outfit: 'daily' });
      return `equipOutfit → ${JSON.stringify(rs)}; view ${v.packId}/${v.outfit}; pet window ${JSON.stringify(pl)}; ${await petShot('w3-pet-still-live2d')}`;
    }, () => admin);

    await step(S, 'W3b wearing the outfit her pack has (daily: its card says 正在穿; again via IPC) keeps her in dafeiyu-live2d / live2d', async () => {
      await go('/characters/dafeiyu-live2d');
      await tab('装扮');
      await attached('[data-outfits="dafeiyu-live2d"] [data-outfit="daily"][data-equipped="true"] [data-worn="daily"]');
      const lc = await cards('dafeiyu-live2d');
      assert.deepEqual(lc.map((c) => `${c.id}:${c.worn}`), ['daily:正在穿']);
      await until('Live2D card drawn', async () => (await cards('dafeiyu-live2d')).every((c) => c.drawn), 20000);
      const r = await call('equipOutfit', 'daily');
      assert.equal(r.ok, true, JSON.stringify(r));
      await page.waitForTimeout(1200);
      const v = await viewNow();
      assert.equal(v.packId, 'dafeiyu-live2d');
      assert.equal(v.kind, 'live2d');
      assert.equal(v.outfit, 'daily');
      const pl = await petLook();
      assert.deepEqual(pl, { kind: 'live2d', outfit: 'daily' });
      assert.equal(wardrobeOf('dafeiyu-live2d').equippedOutfit, 'daily');
      const out = [await shot('w3b-live2d-wardrobe-daily-worn'), await petShot('w3b-pet-live2d-daily-worn')];
      return `equipOutfit(daily) → ${JSON.stringify({ ok: r.ok, outfit: r.outfit && r.outfit.id })}; view ${JSON.stringify(v)}; pet window ${JSON.stringify(pl)}; ${out.join(', ')}`;
    }, () => admin);

    await step(S, 'W4 18+ confirmed and adult content on: the Live2D character\'s wardrobe is still daily only', async () => {
      await call('confirmAge', true);
      await call('setAdult', true);
      await page.waitForTimeout(500);
      const v = await viewNow();
      assert.deepEqual(v.outfits, ['daily']);
      assert.equal(v.packId, 'dafeiyu-live2d');
      await go('/characters/dafeiyu-live2d');
      await tab('装扮');
      await until('rack shows daily only', async () => JSON.stringify(await chips('dafeiyu-live2d')) === '["daily"]');
      return `view ${JSON.stringify(v)}; ${await shot('w4-live2d-adult-on')}`;
    }, () => admin);

    await step(S, 'W5 back to 「大肥鱼 · 像素」: her full wardrobe again, still in the scarf she wore as that character', async () => {
      await switchTo('dafeiyu-pixel');
      await until('pixel worn', async () => (await viewNow()).packId === 'dafeiyu-pixel');
      await until('rack grows', async () => (await chips('dafeiyu-pixel')).includes('scarf'));
      const v = await viewNow();
      assert.equal(v.outfit, 'scarf', 'each character keeps her own outfit');
      assert.equal(v.kind, 'sprites');
      const c = await chips('dafeiyu-pixel');
      assert.ok(c.length > 1 && c.includes('scarf') && c.includes('qipao'), `pixel rack ${c.join(',')}`);
      return `view ${JSON.stringify(v)}; 衣柜 chips ${c.join(',')}; ${await shot('w5-pixel-again')}`;
    }, () => admin);

    await step(S, 'W5b as the pixel character she wears 旗袍 (qipao); the Live2D character stays in daily, each saved apart', async () => {
      await admin.locator('[data-outfits="dafeiyu-pixel"] [data-equip="qipao"]').scrollIntoViewIfNeeded();
      await admin.click('[data-outfits="dafeiyu-pixel"] [data-equip="qipao"]');
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'qipao', null, { timeout: 8000 });
      assert.equal(wardrobeOf('dafeiyu-pixel').equippedOutfit, 'qipao');
      const before = await viewNow();
      assert.equal(before.packId, 'dafeiyu-pixel');
      const s1 = await petShot('w5b-pet-pixel-qipao');
      await switchTo('dafeiyu-live2d');
      await until('Live2D worn', async () => (await viewNow()).packId === 'dafeiyu-live2d');
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.kind === 'live2d' && document.getElementById('char-wrap').dataset.outfit === 'daily', null, { timeout: 15000 });
      await until('rack shows daily only', async () => JSON.stringify(await chips('dafeiyu-live2d')) === '["daily"]');
      await page.waitForTimeout(1500);
      const v = await viewNow();
      assert.equal(v.kind, 'live2d');
      assert.equal(v.outfit, 'daily');
      assert.deepEqual(v.outfits, ['daily']);
      assert.deepEqual([wardrobeOf('dafeiyu-pixel').equippedOutfit, wardrobeOf('dafeiyu-live2d').equippedOutfit], ['qipao', 'daily'], 'two wardrobes, saved apart');
      const out = [s1, await shot('w5b-live2d-wardrobe-after-qipao'), await petShot('w5b-pet-live2d-after-qipao')];
      return `before ${before.packId}/${before.outfit}; after ${JSON.stringify(v)}; wardrobes ${JSON.stringify(savedPet().characters.dafeiyu.wardrobes)}; ${out.join(', ')}`;
    }, () => admin);

    await step(S, 'W5c while 「大肥鱼 · Live2D」 is with you, her pixel self\'s page still lists her cards; 穿上 贝雷帽画家装 there is saved for the pixel character only', async () => {
      await go('/characters/dafeiyu-pixel');
      await tab('装扮');
      await attached('[data-outfits="dafeiyu-pixel"] [data-outfit="qipao"][data-equipped="true"]');
      const c = await cards('dafeiyu-pixel');
      assert.ok(c.length > 1);
      await admin.locator('[data-outfits="dafeiyu-pixel"] [data-equip="beret"]').scrollIntoViewIfNeeded();
      await admin.click('[data-outfits="dafeiyu-pixel"] [data-equip="beret"]');
      await attached('[data-outfits="dafeiyu-pixel"] [data-outfit="beret"][data-equipped="true"]');
      await page.waitForTimeout(800);
      const v = await viewNow();
      assert.equal(v.packId, 'dafeiyu-live2d', 'still the Live2D character with you');
      assert.equal(v.outfit, 'daily');
      assert.deepEqual(await petLook(), { kind: 'live2d', outfit: 'daily' });
      assert.deepEqual([wardrobeOf('dafeiyu-pixel').equippedOutfit, wardrobeOf('dafeiyu-live2d').equippedOutfit], ['beret', 'daily']);
      await admin.locator('[data-outfits="dafeiyu-pixel"]').scrollIntoViewIfNeeded();
      return `pixel cards ${c.length}; wardrobes ${JSON.stringify(savedPet().characters.dafeiyu.wardrobes)}; pet window ${JSON.stringify(await petLook())}; ${await shot('w5c-pixel-page-while-live2d')}`;
    }, () => admin);

    await step(S, 'W5d 18+ on: 「大肥鱼 · 成年版（18+）」 is a character of her own; her cards carry the 成人 tag', async () => {
      await go('/characters/dafeiyu-adult');
      await tab('装扮');
      await attached('[data-outfits="dafeiyu-adult"] [data-outfit="maid"]');
      const c = await cards('dafeiyu-adult');
      const adult = c.filter((x) => x.rating === '成人').map((x) => x.id);
      assert.ok(adult.includes('maid'), `成人 on ${adult.join(',')}`);
      return `${c.length} cards: ${c.map((x) => `${x.id}[${x.rating}]`).join(' ')}; ${await shot('w5d-adult-wardrobe-cards')}`;
    }, () => admin);

    await step(S, 'W6 no console errors in the settings window', async () => {
      assert.deepEqual(errors, []);
      return 'none';
    });
  } finally {
    await app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- store (商店 → 舞蹈 / VRM 角色)
// 商店 sells the dances and VRM models of scripts/build-store-assets.js. From a local server playing the CDN (the
// archives in ~/vrm-assets/store, or STORE_DIR; STORE_CDN=1 downloads from the real CDN instead): 商店 → 舞蹈
// lists every dance (cover, credit, length, 有音乐); a pixel pet may download one but not dance it; 商店 → 角色
// lists the VRM models with their license (授权); a VRM over 20 MB comes down in parts; she wears it and dances
// the store dance from 商店 with its music. A corrupted part is refused by the sha256. Free: fake lh.
// Evidence in out/e2e/store/.
async function storeScenario() {
  const S = 'store';
  const SHOTS = path.join(OUT, 'store');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const STORE = process.env.STORE_DIR || path.join(os.homedir(), 'vrm-assets', 'store');
  const CDN = process.env.STORE_CDN === '1';
  if (!CDN && !fs.existsSync(path.join(STORE, 'dances'))) {
    console.log(`SKIP  [${S}] no store archives in ${STORE} (node scripts/build-store-assets.js), STORE_CDN not set`);
    return;
  }
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const Catalog = require('../src/core/catalog');
  const DANCE = 'dance-sample';
  const VRM = 'vrm-f060464a'; // 凍香(天使): over 20 MB (two parts), its license allows redistribution
  const http = require('node:http');
  const corrupt = new Set();
  const served = [];
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = [path.join(STORE, 'dances', name), path.join(STORE, 'vrm', name)].find((f) => fs.existsSync(f));
    served.push(name);
    if (!file) { res.writeHead(404); return res.end('not found'); }
    let buf = fs.readFileSync(file);
    if (corrupt.has(name)) { buf = Buffer.from(buf); buf[Math.floor(buf.length / 2)] ^= 0xff; }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
    let i = 0;
    const tick = () => { if (i >= buf.length) return res.end(); res.write(buf.subarray(i, i + 512 * 1024)); i += 512 * 1024; setTimeout(tick, 40); };
    tick();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/store`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-store-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-storefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_PREINSTALLED: '', ...(CDN ? {} : { PIXELPET_CATALOG_URL: base }) };
  const record = (name, text) => { fs.writeFileSync(path.join(SHOTS, name), text); return name; };
  let { app, page } = await launch(env);
  let admin = null;
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pet: ${e}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`pet: ${msg.text()}`); });
  const W = 1180;
  const until = async (what, fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what}: not within ${ms} ms`);
  };
  const attached = (sel, ms) => until(sel, () => admin.evaluate((x) => !!document.querySelector(x), sel), ms);
  const call = (fn, ...args) => admin.evaluate(([f, a]) => window.petAdmin[f](...a), [fn, args]);
  const go = async (route) => {
    await admin.bringToFront();
    await admin.evaluate((r) => { location.hash = r; }, route);
    await attached(`[data-path="${route}"]`);
    await admin.waitForTimeout(300);
  };
  const tab = async (label) => {
    await admin.evaluate((l) => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === l); if (!t) throw new Error(`no tab ${l}`); t.click(); }, label);
    await admin.waitForTimeout(400);
  };
  const shot = async (name) => {
    const h = await admin.evaluate(() => { const el = document.querySelector('[data-admin-page]'); return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 48); });
    await app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, Math.min(Math.max(hh, 860), 3200)); }, [W, h]);
    await admin.waitForTimeout(500);
    await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 860); }, W);
    return `${name}.png`;
  };
  const viewShot = async (name) => { await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const petShot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).then(() => `${name}.png`);
  const state = () => call('state');
  const leftovers = () => ['packs', 'vrm-dances'].flatMap((d) => (fs.existsSync(path.join(data, d)) ? fs.readdirSync(path.join(data, d)).filter((n) => n.startsWith('.')).map((n) => `${d}/${n}`) : []));

  try {
    await step(S, 'S1 唤醒像素角色；商店多了「舞蹈」分类，列出所有舞（封面、署名、时长、大小、有音乐），像素角色时提示只有 VRM 能跳', async () => {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-character="dafeiyu-pixel"]').click();
      await page.fill('#pet-name', '小鱼');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 }).catch((e) => { throw new Error(`${e.message.split('\n')[0]}; pet window errors: ${errors.join(' | ') || 'none'}`); });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      admin = await openAdminWindow(app, page, 'overview');
      admin.on('pageerror', (e) => errors.push(String(e)));
      admin.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
      await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));
      await go('/store');
      const tabs = await admin.$$eval('[role="tab"]', (els) => els.map((e) => e.textContent.trim()));
      assert.ok(tabs.includes('角色') && tabs.includes('舞蹈'), tabs.join(','));
      await tab('舞蹈');
      await attached('[data-store-dances]');
      const want = Catalog.loadDanceIndex().dances;
      const cards = await admin.$$eval('[data-store-dance]', (els) => els.map((e) => ({ id: e.dataset.storeDance, name: e.querySelector('strong, [class*="strong"]')?.textContent || e.textContent.slice(0, 40), meta: e.querySelector('[data-store-dance-meta]')?.textContent, music: /有音乐/.test(e.textContent), img: !!e.querySelector('img') })));
      assert.equal(cards.length, want.length, `${cards.length} cards, ${want.length} in the index`);
      assert.ok(cards.every((c) => /^\d+:\d\d · \d+(\.\d)? (MB|KB)$/.test(c.meta)), JSON.stringify(cards.slice(0, 3)));
      await admin.waitForFunction(() => [...document.querySelectorAll('[data-store-dances] img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 15000 });
      const pics = await admin.$$eval('[data-store-dances] img', (els) => els.length);
      const alert = await admin.evaluate(() => [...document.querySelectorAll('[role="alert"], .ant-alert')].map((e) => e.textContent).join(' | '));
      assert.match(alert, /她现在不是 VRM 角色/);
      return `舞蹈 ${cards.length} 支（${cards.filter((c) => c.music).length} 支有音乐，${pics} 张封面）；提示「${alert.slice(0, 60)}」 → ${await shot('s1-store-dances')}, ${await viewShot('s1b-store-dances-top')}`;
    }, page);

    await step(S, `S2 下载《开心摇》：进度 → 已下载；舞蹈页列出它（有音乐、署名），像素角色时「让她跳」不可点`, async () => {
      await admin.click(`[data-dance-download="${DANCE}"]`);
      await attached(`[data-dance-download-progress="${DANCE}"]`, 15000).catch(() => {});
      const mid = await viewShot('s2a-dance-downloading');
      await attached(`[data-dance-downloaded="${DANCE}"]`, 60000);
      const lib = JSON.parse(fs.readFileSync(path.join(data, 'vrm-dances', 'library.json'), 'utf8'));
      const e = lib.dances[DANCE];
      assert.ok(e && e.source === 'store' && /audio\./.test(e.audio || ''), JSON.stringify(e));
      assert.ok(fs.existsSync(path.join(data, 'vrm-dances', DANCE, 'dance.vrma')));
      const play = await admin.$eval(`[data-store-dance-play="${DANCE}"]`, (b) => b.disabled);
      assert.equal(play, true, '让她跳 is off on a pixel look');
      const after = await viewShot('s2b-dance-downloaded');
      const list = await call('dances');
      const row = list.dances.find((d) => d.id === DANCE);
      assert.ok(row && row.music, JSON.stringify(list.dances.map((d) => d.id)));
      await go('/dances');
      await admin.waitForFunction((id) => !!document.querySelector(`[data-dance-card="${id}"], [data-dance="${id}"]`) || document.body.textContent.includes('开心摇'), DANCE, { timeout: 10000 });
      return `${DANCE}: library ${JSON.stringify({ file: e.file, audio: e.audio, cover: e.cover, credit: e.credit, source: e.source })}; 让她跳 disabled=${play}; served ${served.filter((n) => n.startsWith(DANCE)).join(', ') || '(CDN)'} → ${mid}, ${after}, ${await shot('s2c-dances-page-with-store-dance')}`;
    }, page);

    await step(S, 'S3 商店 → 角色 按类型筛 VRM：每张卡有作者与授权；「授权」弹窗列出模型文件里的授权（再分发、商用、性表现…）', async () => {
      await go('/store');
      await tab('角色');
      await attached('[data-store-kind]');
      await admin.evaluate(() => { const o = [...document.querySelectorAll('[data-store-kind] *')].filter((x) => /^VRM \d+$/.test(x.textContent.trim())).pop(); if (!o) throw new Error(`no VRM filter: ${document.querySelector('[data-store-kind]').textContent}`); o.click(); });
      await admin.waitForTimeout(500);
      const kinds = await admin.$$eval('[data-catalog-grid] [data-catalog]', (els) => [...new Set(els.map((e) => e.dataset.kind))]);
      assert.deepEqual(kinds, ['vrm']);
      const n = await admin.$$eval('[data-catalog-grid] [data-catalog]', (els) => els.length);
      const allAges = Catalog.storeIndex().characters.filter((c) => c.kind === 'vrm' && !c.adult).length;
      assert.equal(n, allAges, 'every all-ages VRM model, no 18+ one');
      const meta = await admin.$eval(`[data-catalog="${VRM}"] [data-catalog-meta]`, (el) => el.textContent);
      const grid = await shot('s3a-store-vrm');
      await admin.click(`[data-store-license-open="${VRM}"]`);
      await attached(`[data-store-license="${VRM}"]`);
      const rows = await admin.$$eval(`[data-store-license="${VRM}"] dt`, (els) => els.map((e) => `${e.textContent}=${e.nextElementSibling.textContent}`));
      assert.ok(rows.some((r) => /^再分发=/.test(r)) && rows.some((r) => /^作者=/.test(r)), rows.join('; '));
      const modal = await viewShot('s3b-vrm-license');
      await admin.keyboard.press('Escape');
      return `VRM 卡 ${n} 张（全年龄）；${VRM} 卡：${meta}；授权：${rows.join('；')} → ${grid}, ${modal}`;
    }, page);

    await step(S, 'S4 分段下载：被改过一个字节的分段 → 校验不通过，什么都没留下；正常下载后两段拼回，她是一位用通用设定的新伙伴（不挂在大肥鱼名下）', async () => {
      const e = Catalog.entry(VRM);
      assert.ok(e.parts && e.parts.length === 2, JSON.stringify(e.parts));
      if (!CDN) {
        corrupt.add(e.parts[1].file);
        const bad = await call('downloadCharacter', VRM);
        assert.equal(bad.reason, 'checksum', JSON.stringify(bad));
        corrupt.clear();
        assert.deepEqual(leftovers(), []);
        assert.ok(!fs.existsSync(path.join(data, 'packs', VRM)));
      }
      const t0 = Date.now();
      const r = await call('downloadCharacter', VRM);
      assert.equal(r.ok, true, JSON.stringify(r));
      const parts = served.filter((n) => n.startsWith(`${VRM}-p`));
      const pack = JSON.parse(fs.readFileSync(path.join(data, 'packs', VRM, 'pack.json'), 'utf8'));
      assert.equal(pack.kind, 'vrm');
      await go(`/characters/${VRM}`);
      await attached(`[data-switch="${VRM}"]`);
      await admin.click(`[data-switch="${VRM}"]`);
      // 初次见面: a new companion — the name is her model's, filled in
      await attached('[data-meet-name]');
      const meetName = await admin.$eval('[data-meet-name]', (el) => el.value);
      assert.equal(meetName, '凍香(天使)');
      await admin.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '初次见面' && !b.dataset.switch).click());
      await until(`${VRM} current`, async () => (await state()).view.pet.characterId === VRM, 30000);
      // 通用设定 (core/generic.js): she is a companion of her own — her own base, her model's name, not 大肥鱼
      const st = await state();
      const row = st.roster.find((x) => x.id === VRM);
      assert.match(st.view.pet.speciesId, /^vrmx[a-z]{12}$/, st.view.pet.speciesId);
      assert.equal(row.vendor, '通用');
      assert.equal(row.nameZh, '凍香(天使)');
      assert.ok(!st.roster.some((x) => x.base === 'dafeiyu' && x.id === VRM));
      const generic = `base ${st.view.pet.speciesId} (通用 · ${row.nameZh}), her own name「${st.view.pet.name || row.nameZh}」`;
      await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > 5; }, null, { timeout: 60000 });
      await page.waitForTimeout(1500);
      return `checksum refused: ${CDN ? '(CDN run: skipped)' : 'yes'}; downloaded ${e.bytes} bytes in ${Date.now() - t0} ms from ${parts.join(' + ') || 'the CDN'}; pack ${pack.id} 「${pack.name}」 species ${pack.species}; ${generic}; she wears it → ${await petShot('s4-pet-vrm-from-store')}, ${await shot('s4b-her-page-generic')}`;
    }, page);

    await step(S, 'S5 VRM 角色：商店 → 舞蹈 点「让她跳」→ 她跳《开心摇》，音乐在播、进度往前走；停止后回到待机', async () => {
      await go('/store');
      await tab('舞蹈');
      await attached(`[data-store-dance-play="${DANCE}"]`);
      await admin.waitForFunction((id) => !document.querySelector(`[data-store-dance-play="${id}"]`).disabled, DANCE, { timeout: 15000 });
      const noAlert = await admin.evaluate(() => !document.body.textContent.includes('她现在不是 VRM 角色'));
      assert.ok(noAlert);
      await admin.click(`[data-store-dance-play="${DANCE}"]`);
      let st = null;
      await until('dancing', async () => { st = await call('danceState'); return st && st.id === DANCE && st.state === 'on' && st.t > 2; }, 30000);
      assert.equal(st.audio, 'playing', JSON.stringify(st));
      await page.waitForTimeout(800);
      const a = await petShot('s5a-pet-dancing');
      await page.waitForTimeout(1200);
      const b = await petShot('s5b-pet-dancing-later');
      const st2 = await call('danceState');
      assert.ok(st2.t > st.t, `${st.t} → ${st2.t}`);
      await call('danceStop');
      await until('stopped', async () => !(await call('danceState')), 10000);
      return `state ${JSON.stringify({ id: st.id, state: st.state, t: st.t, audio: st.audio, clock: st.clock })} → t ${st2.t}; stopped → ${a}, ${b}, ${await petShot('s5c-pet-idle-after')}`;
    }, page);

    await step(S, 'S6 没有渲染错误、没有遗留的临时目录', async () => {
      const bad = errors.filter((e) => !/favicon|DevTools/.test(e));
      assert.deepEqual(bad, []);
      assert.deepEqual(leftovers(), []);
      record('served.txt', `${CDN ? 'STORE_CDN=1: downloaded from the CDN' : `served from ${base}`}\n${served.join('\n')}\n`);
      return `no console errors; served: ${served.length} requests`;
    }, page);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
}

// ---------------------------------------------------------------- voicestore (商店 → 语音包: 浏览、下载、三态)
// 商店 → 语音包 lists the 风格语音包 of src/core/voice-catalog.json: name, 风格, 音色说明, size, 署名, 试听. From a
// local server playing the release host (the archives rebuilt by scripts/build-voice-catalog.js --check, throttled so
// 下载中 shows): 未下载 → 下载中 (progress) → 已下载; the pack is unpacked into userData/voicepacks/<id>/ and listed
// in 设置 → 语音包 (来源 商店下载). A corrupted archive is refused by its sha256 and leaves nothing behind. After a
// restart 已下载 is still right (read from disk); 删除 brings it back to 未下载 and out of the local list.
// Free: fake lh, no network. Evidence in out/e2e/voicestore/.
async function voiceStoreScenario() {
  const S = 'voicestore';
  const SHOTS = path.join(OUT, 'voicestore');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const Catalog = require('../src/core/catalog');
  const index = Catalog.loadVoiceIndex();
  const IDS = index.voicePacks.map((v) => v.id);
  const CUTE = 'style-cute';
  const BAD = 'style-yujie';
  const zips = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-voicezips-'));
  const built = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-voice-catalog.js'), '--check', '--out', zips], { cwd: ROOT, encoding: 'utf8' });
  const http = require('node:http');
  const corrupt = new Set();
  const served = [];
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = path.join(zips, name);
    served.push(name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    let buf = fs.readFileSync(file);
    if (corrupt.has(name)) { buf = Buffer.from(buf); buf[Math.floor(buf.length / 2)] ^= 0xff; } // same size, other bytes
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
    // ~300 KB/s, so 下载中 and the bar are seen
    let i = 0;
    const tick = () => { if (i >= buf.length) return res.end(); res.write(buf.subarray(i, i + 32 * 1024)); i += 32 * 1024; setTimeout(tick, 100); };
    tick();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/voices`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-voicestore-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-voicestorefake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_URL: base };
  const VDIR = path.join(data, 'voicepacks');
  const record = (name, text) => { fs.writeFileSync(path.join(SHOTS, name), text); return name; };
  record('v0-zips-built.txt', `$ node scripts/build-voice-catalog.js --check --out <tmp>\n${built}\nserved from ${base} (throttled ~300 KB/s)\n${index.voicePacks.map((v) => `${v.file}  ${v.bytes} bytes  sha256 ${v.sha256}`).join('\n')}\n`);
  let { app, page } = await launch(env);
  let admin = null;
  const errors = [];
  const W = 1180;
  const until = async (what, fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what}: not within ${ms} ms`);
  };
  const attached = (sel, ms) => until(sel, () => admin.evaluate((x) => !!document.querySelector(x), sel), ms);
  const call = (fn, ...args) => admin.evaluate(([f, a]) => window.petAdmin[f](...a), [fn, args]);
  const go = async (route) => {
    await admin.bringToFront();
    await admin.evaluate((r) => { location.hash = r; }, route);
    await attached(`[data-path="${route}"]`);
    await admin.waitForTimeout(300);
  };
  const tab = async (label) => {
    await admin.evaluate((l) => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === l); if (!t) throw new Error(`no tab ${l}`); t.click(); }, label);
    await admin.waitForTimeout(400);
  };
  const openVoices = async () => { await go('/store'); await tab('语音包'); await attached('[data-store-voices]'); await admin.waitForTimeout(300); };
  const toast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 20000 });
  const shot = async (name) => {
    const h = await admin.evaluate(() => { const el = document.querySelector('[data-admin-page]'); return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 48); });
    await app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, Math.min(Math.max(hh, 860), 3200)); }, [W, h]);
    await admin.waitForTimeout(450);
    await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 860); }, W);
    return `${name}.png`;
  };
  const viewShot = async (name) => { await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  // each card's state as the page shows it
  const states = () => admin.$$eval('[data-store-voice]', (els) => Object.fromEntries(els.map((e) => [e.dataset.storeVoice, e.dataset.voiceState])));
  const leftovers = () => (fs.existsSync(VDIR) ? fs.readdirSync(VDIR).filter((n) => n.startsWith('.') || n.includes('.old-')) : []);
  // 设置 → 语音包: the rows of the local list (antd sets data-row-key)
  const localRows = async () => {
    await go('/voicepacks');
    await admin.waitForTimeout(400);
    return admin.$$eval('[data-admin-page] tr[data-row-key]', (els) => els.map((e) => ({ id: e.dataset.rowKey, text: e.textContent })));
  };
  const openAdmin = async () => {
    admin = await openAdminWindow(app, page, 'overview');
    admin.on('pageerror', (e) => errors.push(String(e)));
    admin.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));
  };

  try {
    await step(S, 'V0 唤醒桌宠，打开配置窗口', async () => {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card').first().click();
      await page.fill('#pet-name', '小鱼');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await openAdmin();
      return 'ok';
    }, page);

    await step(S, 'V1 商店 → 语音包：5 个风格语音包，每张卡有名称、风格、音色说明、体积、署名、试听，全部「未下载」', async () => {
      await openVoices();
      const tabs = await admin.$$eval('[role="tab"]', (els) => els.map((e) => e.textContent.trim()));
      assert.ok(tabs.includes('语音包'), tabs.join(','));
      const cards = await admin.$$eval('[data-store-voice]', (els) => els.map((e) => {
        const q = (a) => (e.querySelector(`[${a}]`) || {}).textContent || '';
        return { id: e.dataset.storeVoice, state: e.dataset.voiceState, name: e.querySelector('strong, [class*="strong"]')?.textContent || e.textContent.slice(0, 20), style: q('data-store-voice-style'), desc: q('data-store-voice-desc'), timbre: q('data-store-voice-timbre'), meta: q('data-store-voice-meta'), credit: q('data-store-voice-credit'), sample: !!e.querySelector('[data-voice-sample]'), tag: q('data-voice-not-downloaded'), btn: q('data-voice-download') };
      }));
      assert.deepEqual(cards.map((c) => c.id), IDS);
      for (const c of cards) {
        const e = index.voicePacks.find((v) => v.id === c.id);
        assert.equal(c.state, 'remote', c.id);
        assert.equal(c.tag, '未下载');
        assert.equal(c.btn, '下载');
        assert.equal(c.style, e.styleLabel);
        assert.equal(c.desc, e.description);
        assert.equal(c.timbre, `音色：MiniMax ${e.voiceId}`);
        assert.match(c.meta, new RegExp(`${e.lines} 句 · ${Catalog.sizeLabel(e.bytes).replace('.', '\\.')}`));
        assert.equal(c.credit, e.credit);
        assert.ok(c.sample);
      }
      const filter = await admin.$eval('[data-store-voice-filter]', (el) => el.textContent);
      assert.match(filter, /全部 5.*未下载 5.*已下载 0/);
      assert.ok(!fs.existsSync(path.join(VDIR, CUTE)));
      record('v1-cards.json', JSON.stringify(cards, null, 2));
      return `${cards.map((c) => `${c.id}「${c.style}」${c.meta}`).join('；')} → ${await shot('v1-store-voices-not-downloaded')}`;
    }, page);

    await step(S, 'V2 试听（不用下载）：点「试听」播放随应用附带的试听句，按钮变「停止」', async () => {
      await admin.click(`[data-voice-sample="${CUTE}"]`);
      await until('playing', () => admin.$eval(`[data-voice-sample="${CUTE}"]`, (b) => b.textContent.includes('停止')), 8000);
      const shotName = await viewShot('v2-sample-playing');
      await admin.click(`[data-voice-sample="${CUTE}"]`);
      await until('stopped', () => admin.$eval(`[data-voice-sample="${CUTE}"]`, (b) => b.textContent.includes('试听')), 5000);
      return `试听 ${index.voicePacks[0].sample.file} 播放中 → ${shotName}`;
    }, page);

    let mid = '';
    await step(S, 'V3 下载「可爱 · 甜心少女」：卡片变「下载中」，进度条与百分比走动', async () => {
      await admin.click(`[data-voice-download="${CUTE}"]`);
      await attached(`[data-voice-download-progress="${CUTE}"]`);
      await admin.waitForFunction((id) => /已下载 [1-9]\d?%/.test(document.querySelector(`[data-voice-download-progress="${id}"]`)?.textContent || ''), CUTE, { timeout: 15000 });
      mid = await admin.$eval(`[data-voice-download-progress="${CUTE}"]`, (el) => el.textContent);
      const st = await states();
      assert.equal(st[CUTE], 'downloading');
      assert.equal(await admin.$eval(`[data-voice-downloading="${CUTE}"]`, (el) => el.textContent), '下载中');
      assert.ok(await admin.$(`[data-voice-download-cancel="${CUTE}"]`));
      const main = await call('voiceStore');
      const row = main.voicePacks.find((v) => v.id === CUTE);
      assert.equal(row.state, 'downloading', 'main says 下载中 too');
      return `进度「${mid}」；主进程 state=${row.state} percent=${row.percent} → ${await viewShot('v3-downloading')}`;
    }, page);

    await step(S, 'V4 下载完成：卡片「已下载」，文件在 userData/voicepacks/style-cute/（manifest 校验通过 + 标记），已下载筛选里有它', async () => {
      await toast(/「可爱 · 甜心少女」下载好了/);
      await until('installed', async () => (await states())[CUTE] === 'installed');
      assert.equal(await admin.$eval(`[data-voice-downloaded="${CUTE}"]`, (el) => el.textContent), '已下载');
      const m = JSON.parse(fs.readFileSync(path.join(VDIR, CUTE, 'manifest.json'), 'utf8'));
      const marker = JSON.parse(fs.readFileSync(path.join(VDIR, CUTE, '.catalog.json'), 'utf8'));
      const VP = require('../src/core/voice-pack');
      assert.deepEqual(VP.validateManifest(m, path.join(VDIR, CUTE)), []);
      assert.equal(marker.sha256, index.voicePacks.find((v) => v.id === CUTE).sha256);
      assert.deepEqual(leftovers(), []);
      const all = await shot('v4a-store-downloaded');
      await admin.locator('[data-store-voice-filter]').getByText(/^已下载 1$/).click();
      await admin.waitForTimeout(400);
      const shown = await admin.$$eval('[data-store-voice]', (els) => els.map((e) => e.dataset.storeVoice));
      assert.deepEqual(shown, [CUTE]);
      const filtered = await shot('v4b-store-filter-downloaded');
      const files = fs.readdirSync(path.join(VDIR, CUTE));
      record('v4-installed.txt', `${path.join('<userData>', 'voicepacks', CUTE)}: ${files.length} files (manifest.json, .catalog.json, ${files.length - 2} audio)\nmanifest: id=${m.id} kind=${m.kind} style=${m.style} version=${m.version} lines=${Object.keys(m.lines).length}\nvalidateManifest: OK\nmarker: ${JSON.stringify(marker)}\n`);
      return `已下载；${files.length} 个文件；marker ${JSON.stringify(marker)}；已下载筛选: ${shown.join(',')} → ${all}, ${filtered}`;
    }, page);

    await step(S, 'V5 本地可用列表：设置 → 语音包 列出 style-cute（任意角色 · 138 句 · 来源「商店下载」），主进程已加载为 style 包', async () => {
      const rows = await localRows();
      const row = rows.find((r) => r.id === CUTE);
      assert.ok(row, rows.map((r) => r.id).join(','));
      assert.match(row.text, /可爱 · 甜心少女/);
      assert.match(row.text, /商店下载/);
      assert.match(row.text, /138 句/);
      const st = await call('state');
      assert.ok(st.settings.ttsStatus.packs.some((p) => p.id === CUTE && p.kind === 'style' && p.store));
      return `本地列表: ${rows.map((r) => r.id).join(', ')} → ${await shot('v5-settings-voicepacks-local-list')}`;
    }, page);

    await step(S, 'V6 下载的文件被篡改：sha256 校验不通过，提示可读的失败原因，本机不留文件，卡片回到「未下载」', async () => {
      corrupt.add(`${BAD}.zip`);
      await openVoices();
      await admin.click(`[data-voice-download="${BAD}"]`);
      await toast(/没能下载「御姐 · 妩媚姐姐」/);
      await toast(/校验没通过/);
      const failShot = await viewShot('v6-checksum-failed');
      await until('remote again', async () => (await states())[BAD] === 'remote');
      const cardErr = await admin.$eval(`[data-voice-download-error="${BAD}"]`, (el) => el.textContent);
      assert.match(cardErr, /校验没通过/);
      assert.ok(!fs.existsSync(path.join(VDIR, BAD)));
      assert.deepEqual(leftovers(), []);
      corrupt.delete(`${BAD}.zip`);
      return `篡改后: 未安装、无残留，卡片仍是未下载，卡上提示「${cardErr}」 → ${failShot}`;
    }, page);

    await step(S, 'V7 重启应用：已下载状态以磁盘为准，style-cute 仍是「已下载」，其余「未下载」', async () => {
      await app.close();
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await openAdmin();
      await openVoices();
      const st = await states();
      assert.deepEqual(st, Object.fromEntries(IDS.map((id) => [id, id === CUTE ? 'installed' : 'remote'])));
      const filter = await admin.$eval('[data-store-voice-filter]', (el) => el.textContent);
      assert.match(filter, /全部 5.*未下载 4.*已下载 1/);
      return `重启后: ${JSON.stringify(st)} → ${await shot('v7-after-restart')}`;
    }, page);

    await step(S, 'V8 删除已下载的语音包：确认后回到「未下载」，文件夹删除，本地列表不再有它', async () => {
      await admin.click(`[data-voice-remove="${CUTE}"]`);
      await admin.getByRole('button', { name: '删除语音包' }).last().click();
      await toast(/已删除语音包「可爱 · 甜心少女」/);
      await until('remote', async () => (await states())[CUTE] === 'remote');
      assert.ok(!fs.existsSync(path.join(VDIR, CUTE)));
      const storeShot = await viewShot('v8a-removed');
      const rows = await localRows();
      assert.ok(!rows.some((r) => r.id === CUTE));
      return `删除后本地列表: ${rows.map((r) => r.id).join(', ')} → ${storeShot}, ${await shot('v8b-settings-after-remove')}`;
    }, page);

    await step(S, 'V9 没有渲染错误、没有遗留的临时目录', async () => {
      const bad = errors.filter((e) => !/favicon|DevTools/.test(e));
      assert.deepEqual(bad, []);
      assert.deepEqual(leftovers(), []);
      record('served.txt', `served from ${base}\n${served.join('\n')}\n`);
      return `no console errors; served: ${served.join(', ')}`;
    }, page);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
}

// ---------------------------------------------------------------- voiceselect (按角色选择语音包：不使用 / 内置 / 已下载的风格包)
// T-5095. 角色详情 → 语音 → 语音包 offers 不使用 / 内置（自动） / the 风格语音包 downloaded from 商店 (the store's others
// are listed disabled, 去商店下载 opens 商店 → 语音包). Picking 可爱 (A), feeding her when she is full makes her say
// 「呃……肚子圆滚滚的，吃不下了。」 — the pet window plays userData/voicepacks/style-cute/<file>; picking 御姐 (B) the
// same line plays from style-yujie at once, no restart; a line B has not recorded (摸摸: her own line) goes to the
// engine; 不使用 plays nothing from a pack. After a restart she is still on B. Deleting B while she uses it puts her on
// 内置 (her own pack) with a notice. Free: fake lh, no key, store served from a local server. Evidence in out/e2e/voiceselect/.
async function voiceSelectScenario() {
  const S = 'voiceselect';
  const SHOTS = path.join(OUT, 'voiceselect');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const Catalog = require('../src/core/catalog');
  const index = Catalog.loadVoiceIndex();
  const A = 'style-cute';
  const B = 'style-yujie';
  const nameOf = (id) => index.voicePacks.find((v) => v.id === id).name;
  const FULL = '呃……肚子圆滚滚的，吃不下了。';
  const zips = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vselzips-'));
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-voice-catalog.js'), '--check', '--out', zips], { cwd: ROOT, encoding: 'utf8' });
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    const file = path.join(zips, path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vsel-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vselfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true } }));
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/voices` };
  const VDIR = path.join(data, 'voicepacks');
  const crypto = require('node:crypto');
  const evidence = [];
  const note = (x) => { evidence.push(x); return x; };
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).tts.voicePackByCharacter;
  let { app, page } = await launch(env, { video: path.join(SHOTS, 'video') });
  let admin = null;
  const errors = [];
  const W = 1180;
  const until = async (what, fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what}: not within ${ms} ms`);
  };
  const openAdmin = async (route) => {
    admin = await openAdminWindow(app, page, route);
    admin.on('pageerror', (e) => errors.push(String(e)));
    admin.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));
    await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 900); }, W);
  };
  const ashot = async (name) => { await admin.bringToFront(); await admin.waitForTimeout(350); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const pshot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const PANEL = '[role="tabpanel"]:not([inert])';
  const combo = () => admin.locator(`${PANEL} [data-voice-pack-select] [role="combobox"]`);
  const voiceTab = async (id = 'dafeiyu-pixel') => {
    await admin.bringToFront();
    if (await admin.$('[role="option"]')) await closePicker();
    await admin.evaluate((x) => { location.hash = `/characters/${x}`; }, id);
    await admin.waitForSelector(`[data-path="/characters/${id}"]`);
    await admin.getByRole('tab', { name: '语音' }).click();
    await combo().waitFor();
    await admin.evaluate((p) => document.querySelector(`${p} [data-voice-pack-select]`)?.scrollIntoView({ block: 'center' }), PANEL);
    await admin.waitForTimeout(300);
  };
  const current = async () => (await admin.locator(`${PANEL} [data-voice-pack-current]`).innerText()).replace(/\s+/g, ' ').trim();
  const comboText = async () => (await combo().innerText()).replace(/\s+/g, ' ').trim();
  // the open picker (@lobehub/ui Select on base-ui): group labels and options in order, disabled ones marked
  const options = () => admin.$$eval('.lobe-select__group-label, [role="option"]', (els) => els.map((e) => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), group: e.classList.contains('lobe-select__group-label'), disabled: e.hasAttribute('data-disabled') || e.getAttribute('aria-disabled') === 'true' })));
  const openPicker = async () => {
    await combo().click();
    await admin.waitForSelector('[role="option"]');
    await admin.waitForTimeout(300);
  };
  const closePicker = async () => {
    await admin.keyboard.press('Escape');
    await admin.waitForFunction(() => !document.querySelector('[role="option"]'), null, { timeout: 5000 }).catch(() => {});
  };
  const pickInUi = async (rx, shotName = null) => {
    await openPicker();
    const opts = await options();
    const s = shotName ? await ashot(shotName) : null;
    await admin.locator('[role="option"]', { hasText: rx }).first().click();
    await admin.waitForFunction(() => !document.querySelector('[role="option"]'), null, { timeout: 5000 }).catch(() => {});
    return { opts, shot: s };
  };
  const choiceIs = (choice) => until(`picker = ${choice}`, () => admin.evaluate(([p, c]) => document.querySelector(`${p} [data-voice-pack-select]`)?.dataset.voicePackChoice === c, [PANEL, choice]), 10000);
  // the line she says when fed while full, as the pet window reads it: what it played and from which file
  const idle = async () => {
    await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return !sp || !/^(queued|synthesizing|playing|speaking)$/.test(sp.status); }, null, { timeout: 15000 });
    await page.waitForTimeout(1600);
  };
  const said = async (kindRe, fn) => {
    await page.bringToFront();
    await idle();
    const n0 = (await page.evaluate(() => window.petFx.offerLog())).length;
    await fn();
    await page.waitForFunction(([n, re]) => window.petFx.offerLog().slice(n).some((e) => new RegExp(re).test(e.kind) && e.n), [n0, kindRe.source], { timeout: 20000 });
    const entry = (await page.evaluate(() => window.petFx.offerLog())).slice(n0).find((e) => kindRe.test(e.kind));
    await page.waitForFunction((n) => { const sp = window.petFx.lastSpeech(); return sp && sp.n === n && !/^(queued|synthesizing|playing|speaking)$/.test(sp.status); }, entry.n, { timeout: 20000 });
    const sp = await page.evaluate(() => window.petFx.lastSpeech());
    return { text: entry.text, provider: sp.provider, packId: sp.packId, packFile: sp.packFile, bytes: sp.bytes || 0, mime: sp.mime || null, started: !!sp.started, status: sp.status };
  };
  const feedFull = async () => said(/^feed$/, async () => { await page.evaluate(() => window.pet.debugSet({ hunger: 0 })); await clickAct(page, 'feed'); await page.click('#food-menu button'); });
  const pat = async () => {
    await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
    const b = await page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
    const r = await said(/^pat$/, () => page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.4));
    await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
    return r;
  };
  // the folder of a pack by id: the store's in userData/voicepacks/<id>, a built-in one in src/voicepacks/<folder>
  const packDir = (id) => {
    if (fs.existsSync(path.join(VDIR, id || '', 'manifest.json'))) return path.join(VDIR, id);
    const b = path.join(ROOT, 'src', 'voicepacks');
    const d = fs.readdirSync(b).find((n) => { try { return JSON.parse(fs.readFileSync(path.join(b, n, 'manifest.json'), 'utf8')).id === id; } catch { return false; } });
    return d ? path.join(b, d) : path.join(VDIR, id || '');
  };
  const fileOf = (r) => {
    const f = path.join(packDir(r.packId), r.packFile || '');
    if (!r.packFile || !fs.existsSync(f)) return { path: f, exists: false };
    const buf = fs.readFileSync(f);
    return { path: f, exists: true, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
  };
  const fmt = (r) => { const f = fileOf(r); return `「${r.text}」 → provider=${r.provider} packId=${r.packId} packFile=${r.packFile} played bytes=${r.bytes} mime=${r.mime} started=${r.started} status=${r.status}${f.exists ? ` | file ${f.path.replace(data, '<userData>').replace(ROOT, '<repo>')} size=${f.size} sha256=${f.sha256}` : ''}`; };
  const assertFrom = (r, packId) => {
    const f = fileOf(r);
    assert.equal(r.text, FULL);
    assert.deepEqual([r.provider, r.packId, r.status, r.started], ['pack', packId, 'done', true], fmt(r));
    assert.ok(f.exists, `file ${f.path}`);
    assert.equal(r.bytes, f.size, 'the audio played is that file');
  };
  const storeStates = () => admin.$$eval('[data-store-voice]', (els) => Object.fromEntries(els.map((e) => [e.dataset.storeVoice, e.dataset.voiceState])));

  try {
    await step(S, 'S0 唤醒大肥鱼（朗读开，没有任何引擎 Key）；初始 settings.json 无按角色选择', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      assert.deepEqual(saved(), {});
      const r = await feedFull();
      assertFrom(r, 'dafeiyu-minimax');
      await pshot('s0-pet');
      return note(`S0 before any pick: tts.voicePackByCharacter=${JSON.stringify(saved())}\n  ${fmt(r)}`);
    }, page);

    await step(S, 'S1 角色详情 → 语音 → 语音包：选项为「不使用 / 内置（自动）/ …」，商店里没下载的风格包列在「未下载」里且不可选，旁边有「去商店下载」', async () => {
      await openAdmin('overview');
      await voiceTab();
      const cb = await comboText();
      assert.match(cb, /^内置（自动 · 专属或按性别） · 现在是 专属/);
      const shotTab = await ashot('s1a-voice-tab-builtin');
      await openPicker();
      const head = await options();
      const shotHead = await ashot('s1b-picker-top');
      await admin.evaluate(() => { const o = [...document.querySelectorAll('[role="option"]')].at(-1); o && o.scrollIntoView({ block: 'end' }); });
      await admin.waitForTimeout(300);
      const tail = head;
      const shotTail = await ashot('s1c-picker-not-downloaded');
      await closePicker();
      assert.match(head.find((o) => !o.group).text, /^不使用（全部用引擎朗读）/);
      assert.ok(head.some((o) => /^内置（自动/.test(o.text)));
      const remote = tail.filter((o) => /· 未下载$/.test(o.text));
      assert.equal(remote.length, index.voicePacks.length, JSON.stringify(tail));
      assert.ok(remote.every((o) => o.disabled), 'not downloaded = not pickable');
      assert.ok(tail.some((o) => o.group && /未下载/.test(o.text)));
      const btn = await admin.locator(`${PANEL} [data-voice-pack-store]`).innerText();
      assert.match(btn, /去商店下载（5 个未下载）/);
      return note(`S1 picker: ${cb}\n  top: ${head.map((o) => `${o.group ? '[组] ' : ''}${o.text}${o.disabled ? ' (disabled)' : ''}`).join(' | ')}\n  bottom: ${tail.map((o) => `${o.group ? '[组] ' : ''}${o.text}${o.disabled ? ' (disabled)' : ''}`).join(' | ')}\n  button: ${btn} → ${shotTab}, ${shotHead}, ${shotTail}`);
    }, () => admin || page);

    await step(S, 'S2 点「去商店下载」进入 商店 → 语音包，下载 可爱（A）与 御姐（B）', async () => {
      await admin.locator(`${PANEL} [data-voice-pack-store]`).click();
      await admin.waitForSelector('[data-path="/store/voices"]');
      await admin.waitForSelector('[data-store-voices]');
      for (const id of [A, B]) {
        await admin.click(`[data-voice-download="${id}"]`);
        await until(`${id} installed`, async () => (await storeStates())[id] === 'installed', 60000);
      }
      const st = await storeStates();
      const s = await ashot('s2-store-downloaded');
      return note(`S2 via 去商店下载 → #/store/voices; states ${JSON.stringify(st)} → ${s}`);
    }, () => admin || page);

    await step(S, 'S3 回到角色语音页：已下载的 A、B 出现在「风格语音包（已下载）」组，选 A（可爱）→ 持久化到 settings.json', async () => {
      await voiceTab();
      const { opts, shot: s } = await pickInUi(new RegExp(nameOf(A)), 's3a-picker-downloaded');
      await choiceIs(A);
      await admin.waitForTimeout(300);
      const cur = await current();
      assert.ok(opts.some((o) => o.group && o.text === '风格语音包（已下载）'));
      assert.ok(opts.some((o) => !o.disabled && o.text.startsWith(`风格·可爱 · ${nameOf(A)}`)));
      assert.ok(opts.some((o) => !o.disabled && o.text.startsWith(`风格·御姐 · ${nameOf(B)}`)));
      assert.match(cur, new RegExp(`正在用 ${nameOf(A)} 风格·可爱`));
      assert.match(cur, /来源 手动指定/);
      assert.deepEqual(saved(), { dafeiyu: A });
      const s2 = await ashot('s3b-picked-A');
      return note(`S3 options: ${opts.map((o) => `${o.group ? '[组] ' : ''}${o.text}${o.disabled ? ' (disabled)' : ''}`).join(' | ')}\n  正在用: ${cur}\n  settings.json tts.voicePackByCharacter=${JSON.stringify(saved())} → ${s}, ${s2}`);
    }, () => admin || page);

    await step(S, 'S4 A 生效：桌宠喂食（已经吃饱）说固定台词，播放的是 userData/voicepacks/style-cute 里的文件；她的专属台词（摸摸）A 包没有 → 回退引擎', async () => {
      const r = await feedFull();
      assertFrom(r, A);
      const p = await pshot('s4-pet-said-A');
      // 摸摸: her lines are random — a generic one A has recorded plays from A, one of her own goes to the engine
      const VPk = require('../src/core/voice-pack');
      const inA = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(VDIR, A, 'manifest.json'), 'utf8')).lines).map(VPk.norm));
      const pats = [];
      let q = null;
      for (let i = 0; i < 8 && !q; i++) {
        const x = await pat();
        pats.push(x);
        const recorded = inA.has(VPk.norm(x.text));
        if (recorded) assert.deepEqual([x.provider, x.packId], ['pack', A], fmt(x));
        else { assert.notEqual(x.provider, 'pack', fmt(x)); assert.ok(!x.packId, 'not from any pack'); q = x; }
      }
      assert.ok(q, `a line A has not recorded: ${pats.map(fmt).join(' / ')}`);
      return note(`S4 (A=${A}):\n  ${fmt(r)}\n  摸摸 lines: ${pats.map((x) => `${inA.has(VPk.norm(x.text)) ? '[in A] ' : '[not in A → engine] '}${fmt(x)}`).join('\n    ')}\n  (no key on this box → 原引擎链 → 系统语音) → ${p}`);
    }, page);

    let fileA = null;
    await step(S, 'S5 切到 B（御姐）：不用重启，同一句台词立刻来自 style-yujie 的文件', async () => {
      fileA = fileOf(await feedFull());
      assert.ok(fileA.path.includes(path.join('voicepacks', A)), fileA.path);
      await voiceTab();
      await pickInUi(new RegExp(nameOf(B)));
      await choiceIs(B);
      assert.deepEqual(saved(), { dafeiyu: B });
      const s = await ashot('s5a-picked-B');
      const r = await feedFull();
      assertFrom(r, B);
      const f = fileOf(r);
      assert.notEqual(f.sha256, fileA.sha256, 'another recording');
      const p = await pshot('s5b-pet-said-B');
      return note(`S5 (B=${B}): settings.json=${JSON.stringify(saved())}\n  ${fmt(r)}\n  A's file was ${fileA.path.replace(data, '<userData>')} sha256=${fileA.sha256} → ${s}, ${p}`);
    }, () => admin || page);

    await step(S, 'S6 选「不使用」：同一句不再从语音包播放（走引擎链）；再切回 B', async () => {
      await voiceTab();
      await pickInUi(/^不使用/);
      await choiceIs('none');
      assert.deepEqual(saved(), { dafeiyu: 'none' });
      const cur = await current();
      assert.match(cur, /不使用语音包/);
      const s = await ashot('s6-none');
      const r = await feedFull();
      assert.notEqual(r.provider, 'pack', fmt(r));
      await voiceTab();
      await pickInUi(new RegExp(nameOf(B)));
      await choiceIs(B);
      assert.deepEqual(saved(), { dafeiyu: B });
      return note(`S6 不使用: 正在用「${cur}」; ${fmt(r)}\n  back to B: settings.json=${JSON.stringify(saved())} → ${s}`);
    }, () => admin || page);

    await step(S, 'S7 重启应用：settings.json 仍是 B，设置页显示 B，固定台词仍来自 style-yujie', async () => {
      await app.close();
      ({ app, page } = await launch(env, { video: path.join(SHOTS, 'video-after-restart') }));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      assert.deepEqual(saved(), { dafeiyu: B });
      const r = await feedFull();
      assertFrom(r, B);
      const p = await pshot('s7a-pet-after-restart');
      await openAdmin('overview');
      await voiceTab();
      const cb = await comboText();
      const cur = await current();
      assert.match(cur, new RegExp(`正在用 ${nameOf(B)} 风格·御姐`));
      const s = await ashot('s7b-voice-tab-after-restart');
      return note(`S7 after restart: settings.json=${JSON.stringify(saved())}; picker「${cb}」; ${cur}\n  ${fmt(r)} → ${p}, ${s}`);
    }, () => admin || page);

    await step(S, 'S7c 选择按角色绑定：另一个角色（克洛蒂）的语音页显示她自己的选择「内置」，不受大肥鱼的 B 影响', async () => {
      const other = (await admin.evaluate(() => window.petAdmin.state())).roster.find((x) => x.base === 'claude');
      await voiceTab(other.id);
      const cb = await comboText();
      const cur = await current();
      const choice = await admin.evaluate((p) => document.querySelector(`${p} [data-voice-pack-select]`)?.dataset.voicePackChoice, PANEL);
      assert.equal(choice, 'auto');
      assert.match(cb, /^内置（自动/);
      assert.match(cur, /专属/);
      assert.deepEqual(saved(), { dafeiyu: B }, 'only her pick is saved');
      const s = await ashot('s7c-other-character-own-choice');
      await voiceTab();
      return note(`S7c ${other.id} (base claude): choice=${choice}; picker「${cb}」; ${cur}; settings.json=${JSON.stringify(saved())} → ${s}`);
    }, () => admin || page);

    await step(S, 'S8 删除正在使用的 B：安全回退到内置（她的专属语音包），设置页提示；选择仍保存，重新下载后恢复', async () => {
      await admin.evaluate(() => { location.hash = '/store/voices'; });
      await admin.waitForSelector('[data-store-voices]');
      await admin.click(`[data-voice-remove="${B}"]`);
      await admin.getByRole('button', { name: '删除语音包' }).last().click();
      await until('B removed', async () => (await storeStates())[B] === 'remote');
      assert.ok(!fs.existsSync(path.join(VDIR, B)));
      const r = await feedFull();
      assertFrom(r, 'dafeiyu-minimax');
      await voiceTab();
      await admin.locator(`${PANEL} [data-voice-pack-missing="${B}"]`).waitFor();
      const warn = (await admin.locator(`${PANEL} [data-voice-pack-missing]`).innerText()).replace(/\s+/g, ' ').trim();
      const cur = await current();
      assert.match(cur, /专属/);
      const s = await ashot('s8-removed-in-use');
      assert.deepEqual(saved(), { dafeiyu: B }, 'the pick is kept');
      return note(`S8 B deleted while in use: ${fmt(r)}\n  正在用: ${cur}\n  notice: ${warn}\n  settings.json=${JSON.stringify(saved())} → ${s}`);
    }, () => admin || page);

    await step(S, 'S9 没有渲染错误', async () => {
      const bad = errors.filter((e) => !/favicon|DevTools/.test(e));
      assert.deepEqual(bad, []);
      return 'no console errors';
    }, page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'voiceselect-log.txt'), evidence.join('\n\n') + '\n');
    await app.close().catch(() => {});
    server.close();
  }
}

// ---------------------------------------------------------------- voiceflow (语音包端到端：商店 → 下载 → 本地列表 → 角色选择 → 播放 → 重启)
// T-5096. One user journey from an empty userData (only the age gate answered, as every scenario starts): turn 朗读
// on in 设置 → 朗读; 商店 → 语音包 shows the 5 风格语音包 未下载; download 可爱 and 少年 from a throttled local server
// playing the CDN (the archives rebuilt and sha256-checked by build-voice-catalog.js --check), seeing 未下载 → 下载中
// (progress) → 已下载; both are in the local list (已下载 filter, 设置 → 语音包, userData/voicepacks/); 角色 → 大肥鱼 →
// 语音 → 语音包 picks 可爱: the pet plays the line from style-cute; switching to 少年 plays it from style-shaonian at
// once; after a restart she is still on 少年 and both packs are still 已下载. The played files are copied next to the
// screenshots (played-*.ogg) so they can be listened to. Free: fake lh, no key. Evidence in out/e2e/voiceflow/.
async function voiceFlowScenario() {
  const S = 'voiceflow';
  const SHOTS = path.join(OUT, 'voiceflow');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const Catalog = require('../src/core/catalog');
  const VPk = require('../src/core/voice-pack');
  const crypto = require('node:crypto');
  const index = Catalog.loadVoiceIndex();
  const IDS = index.voicePacks.map((v) => v.id);
  const A = 'style-cute';
  const B = 'style-shaonian';
  const nameOf = (id) => index.voicePacks.find((v) => v.id === id).name;
  const labelOf = (id) => index.voicePacks.find((v) => v.id === id).styleLabel;
  const FULL = '呃……肚子圆滚滚的，吃不下了。';
  const zips = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vflowzips-'));
  const built = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-voice-catalog.js'), '--check', '--out', zips], { cwd: ROOT, encoding: 'utf8' });
  const http = require('node:http');
  const served = [];
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = path.join(zips, name);
    served.push(name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
    // ~250 KB/s so 下载中 and its progress bar are on screen for a few seconds
    let i = 0;
    const tick = () => { if (i >= buf.length) return res.end(); res.write(buf.subarray(i, i + 24 * 1024)); i += 24 * 1024; setTimeout(tick, 100); };
    tick();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/voices`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vflow-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vflowfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_URL: base };
  const VDIR = path.join(data, 'voicepacks');
  const evidence = [];
  const note = (x) => { evidence.push(x); return x; };
  const record = (name, text) => { fs.writeFileSync(path.join(SHOTS, name), text); return name; };
  const settingsFile = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  const picks = () => (settingsFile().tts || {}).voicePackByCharacter;
  const ls = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null);
  record('f0-zips-built.txt', `$ node scripts/build-voice-catalog.js --check --out <tmp>\n${built}\nserved from ${base} (throttled ~250 KB/s, playing ${Catalog.CDN_ORIGIN}/…/${index.release}/)\n${index.voicePacks.map((v) => `${v.file}  ${v.bytes} bytes  sha256 ${v.sha256}`).join('\n')}\n`);
  const before = ls(data);
  // video chapters: wall-clock marks, turned into seconds from each window's recording start (videos.json)
  const marks = [];
  const videos = [];
  const mark = (kind, text) => { marks.push({ wall: Date.now() / 1000, kind, text }); };
  const VS = { width: 1180, height: 900 };
  const track = (p, name) => { videos.push({ name, start: Date.now() / 1000, page: p }); };
  let { app, page } = await launch(env, { video: path.join(SHOTS, 'video'), videoSize: VS });
  track(page, 'pet-1');
  let admin = null;
  const errors = [];
  const W = 1180;
  const until = async (what, fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what}: not within ${ms} ms`);
  };
  const openAdmin = async (route = 'overview') => {
    admin = await openAdminWindow(app, page, route);
    track(admin, `admin-${videos.filter((v) => v.name.startsWith('admin')).length + 1}`);
    admin.on('pageerror', (e) => errors.push(String(e)));
    admin.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));
    await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 900); }, W);
  };
  const attached = (sel, ms) => until(sel, () => admin.evaluate((x) => !!document.querySelector(x), sel), ms);
  const go = async (route) => {
    await admin.bringToFront();
    if (await admin.$('[role="option"]')) await closePicker();
    await admin.evaluate((r) => { location.hash = r; }, route);
    await attached(`[data-path="${route}"]`);
    await admin.waitForTimeout(400);
  };
  const ashot = async (name) => { await admin.bringToFront(); await admin.waitForTimeout(350); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const pshot = async (name) => { await page.waitForTimeout(150); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `${name}.png`; };
  const states = () => admin.$$eval('[data-store-voice]', (els) => Object.fromEntries(els.map((e) => [e.dataset.storeVoice, e.dataset.voiceState])));
  const openVoices = async () => { await go('/store/voices'); await attached('[data-store-voices]'); await admin.waitForTimeout(300); };
  const PANEL = '[role="tabpanel"]:not([inert])';
  const combo = () => admin.locator(`${PANEL} [data-voice-pack-select] [role="combobox"]`);
  const closePicker = async () => {
    await admin.keyboard.press('Escape');
    await admin.waitForFunction(() => !document.querySelector('[role="option"]'), null, { timeout: 5000 }).catch(() => {});
  };
  const voiceTab = async (id = 'dafeiyu-pixel') => {
    await go(`/characters/${id}`);
    await admin.getByRole('tab', { name: '语音' }).click();
    await combo().waitFor();
    await admin.evaluate((p) => document.querySelector(`${p} [data-voice-pack-select]`)?.scrollIntoView({ block: 'center' }), PANEL);
    await admin.waitForTimeout(300);
  };
  const current = async () => (await admin.locator(`${PANEL} [data-voice-pack-current]`).innerText()).replace(/\s+/g, ' ').trim();
  const options = () => admin.$$eval('.lobe-select__group-label, [role="option"]', (els) => els.map((e) => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), group: e.classList.contains('lobe-select__group-label'), disabled: e.hasAttribute('data-disabled') || e.getAttribute('aria-disabled') === 'true' })));
  const pick = async (rx, shotName) => {
    await combo().click();
    await admin.waitForSelector('[role="option"]');
    await admin.waitForTimeout(300);
    const opts = await options();
    const s = shotName ? await ashot(shotName) : null;
    await admin.locator('[role="option"]', { hasText: rx }).first().click();
    await admin.waitForFunction(() => !document.querySelector('[role="option"]'), null, { timeout: 5000 }).catch(() => {});
    return { opts, shot: s };
  };
  const choiceIs = (choice) => until(`picker = ${choice}`, () => admin.evaluate(([p, c]) => document.querySelector(`${p} [data-voice-pack-select]`)?.dataset.voicePackChoice === c, [PANEL, choice]), 10000);
  const idle = async () => {
    await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return !sp || !/^(queued|synthesizing|playing|speaking)$/.test(sp.status); }, null, { timeout: 15000 });
    await page.waitForTimeout(1600);
  };
  // feed her when she is full: she says FULL; what the pet window played, from which pack file
  const feedFull = async (shotName) => {
    await page.bringToFront();
    await idle();
    const n0 = (await page.evaluate(() => window.petFx.offerLog())).length;
    await page.evaluate(() => window.pet.debugSet({ hunger: 0 }));
    await clickAct(page, 'feed');
    await page.click('#food-menu button');
    await page.waitForFunction((n) => window.petFx.offerLog().slice(n).some((e) => e.kind === 'feed' && e.n), n0, { timeout: 20000 });
    const entry = (await page.evaluate(() => window.petFx.offerLog())).slice(n0).find((e) => e.kind === 'feed');
    // the bubble while it plays
    const shot = shotName ? await (async () => { await page.waitForFunction((n) => { const sp = window.petFx.lastSpeech(); return sp && sp.n === n && sp.started; }, entry.n, { timeout: 20000 }).catch(() => {}); return pshot(shotName); })() : null;
    await page.waitForFunction((n) => { const sp = window.petFx.lastSpeech(); return sp && sp.n === n && !/^(queued|synthesizing|playing|speaking)$/.test(sp.status); }, entry.n, { timeout: 20000 });
    const sp = await page.evaluate(() => window.petFx.lastSpeech());
    return { text: entry.text, provider: sp.provider, packId: sp.packId, packFile: sp.packFile, bytes: sp.bytes || 0, mime: sp.mime || null, started: !!sp.started, status: sp.status, shot };
  };
  const packDir = (id) => {
    if (fs.existsSync(path.join(VDIR, id || '', 'manifest.json'))) return path.join(VDIR, id);
    const b = path.join(ROOT, 'src', 'voicepacks');
    const d = fs.readdirSync(b).find((n) => { try { return JSON.parse(fs.readFileSync(path.join(b, n, 'manifest.json'), 'utf8')).id === id; } catch { return false; } });
    return d ? path.join(b, d) : path.join(VDIR, id || '');
  };
  const fileOf = (r) => {
    const f = path.join(packDir(r.packId), r.packFile || '');
    if (!r.packFile || !fs.existsSync(f)) return { path: f, exists: false };
    const buf = fs.readFileSync(f);
    return { path: f, exists: true, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) };
  };
  const fmt = (r) => { const f = fileOf(r); return `「${r.text}」 → provider=${r.provider} packId=${r.packId} packFile=${r.packFile} played bytes=${r.bytes} mime=${r.mime} started=${r.started} status=${r.status}${f.exists ? ` | file ${f.path.replace(data, '<userData>').replace(ROOT, '<repo>')} size=${f.size} sha256=${f.sha256}` : ''}`; };
  const assertFrom = (r, packId, keep) => {
    const f = fileOf(r);
    assert.equal(r.text, FULL);
    assert.deepEqual([r.provider, r.packId, r.status, r.started], ['pack', packId, 'done', true], fmt(r));
    assert.ok(f.exists, `file ${f.path}`);
    assert.equal(r.bytes, f.size, 'the audio played is that file');
    if (keep) fs.copyFileSync(f.path, path.join(SHOTS, keep));
    return f;
  };

  try {
    await step(S, 'F0 全新 userData（只有年龄确认）：唤醒大肥鱼；本机没有 voicepacks/，settings.json 没有语音包选择', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      mark('step', '全新 userData：选大肥鱼、起名、唤醒');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      mark('check', '桌宠出现；userData 里没有 voicepacks/');
      assert.ok(!fs.existsSync(VDIR) || ls(VDIR).filter((n) => n.startsWith('style-')).length === 0);
      assert.equal(picks() === undefined || JSON.stringify(picks()) === '{}', true);
      const s = await pshot('f0-pet-fresh');
      return note(`F0 userData before launch: ${JSON.stringify(before)} (empty dir); after hatch: ${JSON.stringify(ls(data))}\n  voicepacks/: ${JSON.stringify(ls(VDIR))}; tts.voicePackByCharacter=${JSON.stringify(picks())} → ${s}`);
    }, page);

    await step(S, 'F1 设置 → 朗读：打开「朗读回复」开关（全新安装默认关），settings.json prefs.voice=true', async () => {
      await openAdmin('tts');
      assert.equal(settingsFile().prefs?.voice ?? false, false);
      mark('step', '设置 → 朗读：打开「朗读回复」');
      await adminFlip(admin, 'prefs.voice');
      await until('prefs.voice saved', () => settingsFile().prefs?.voice === true, 8000);
      const s = await ashot('f1-tts-voice-on');
      return note(`F1 prefs.voice=${settingsFile().prefs.voice} → ${s}`);
    }, () => admin || page);

    await step(S, 'F2 商店 → 语音包：5 个风格语音包（可爱/御姐/少年/沉稳/搞笑），全部「未下载」', async () => {
      mark('step', '打开 商店 → 语音包');
      await openVoices();
      const st = await states();
      mark('check', `5 张语音包卡片全部「未下载」：${Object.keys(st).join(', ')}`);
      assert.deepEqual(Object.keys(st), IDS);
      assert.ok(Object.values(st).every((x) => x === 'remote'), JSON.stringify(st));
      const cards = await admin.$$eval('[data-store-voice]', (els) => els.map((e) => `${e.dataset.storeVoice}「${(e.querySelector('[data-store-voice-style]') || {}).textContent}」${(e.querySelector('[data-store-voice-meta]') || {}).textContent} · ${(e.querySelector('[data-voice-not-downloaded]') || {}).textContent}`));
      const filter = await admin.$eval('[data-store-voice-filter]', (el) => el.textContent);
      assert.match(filter, /全部 5.*未下载 5.*已下载 0/);
      const s = await ashot('f2-store-not-downloaded');
      return note(`F2 cards: ${cards.join(' | ')}\n  filter: ${filter} → ${s}`);
    }, () => admin || page);

    const progress = {};
    for (const [i, id] of [[3, A], [4, B]]) {
      await step(S, `F${i} 下载「${nameOf(id)}」：未下载 → 下载中（进度条、百分比、取消）→ 已下载`, async () => {
        const st0 = (await states())[id];
        mark('step', `点「下载」：${nameOf(id)}`);
        await admin.click(`[data-voice-download="${id}"]`);
        await attached(`[data-voice-download-progress="${id}"]`);
        await admin.waitForFunction((x) => /已下载 [1-9]\d?%/.test(document.querySelector(`[data-voice-download-progress="${x}"]`)?.textContent || ''), id, { timeout: 15000 });
        const st1 = (await states())[id];
        const mid = await admin.$eval(`[data-voice-download-progress="${id}"]`, (el) => el.textContent);
        assert.equal(st1, 'downloading');
        assert.equal(await admin.$eval(`[data-voice-downloading="${id}"]`, (el) => el.textContent), '下载中');
        mark('check', `${id} 卡片显示「下载中」与进度「${mid}」`);
        const s1 = await ashot(`f${i}a-downloading-${id}`);
        await until(`${id} installed`, async () => (await states())[id] === 'installed', 60000);
        assert.equal(await admin.$eval(`[data-voice-downloaded="${id}"]`, (el) => el.textContent), '已下载');
        const marker = JSON.parse(fs.readFileSync(path.join(VDIR, id, '.catalog.json'), 'utf8'));
        assert.equal(marker.sha256, index.voicePacks.find((v) => v.id === id).sha256);
        mark('check', `${id} 卡片显示「已下载」`);
        const s2 = await ashot(`f${i}b-downloaded-${id}`);
        progress[id] = mid;
        return note(`F${i} ${id}: ${st0} → ${st1}（${mid}）→ installed; marker ${JSON.stringify(marker)} → ${s1}, ${s2}`);
      }, () => admin || page);
    }

    await step(S, 'F5 本地可用列表：商店「已下载」筛选、设置 → 语音包 表格（来源 商店下载）、磁盘 userData/voicepacks/ 都有两个包', async () => {
      await admin.locator('[data-store-voice-filter]').getByText(/^已下载 2$/).click();
      await admin.waitForTimeout(400);
      const shown = await admin.$$eval('[data-store-voice]', (els) => els.map((e) => e.dataset.storeVoice));
      assert.deepEqual(shown.sort(), [A, B].sort());
      const s1 = await ashot('f5a-store-filter-downloaded');
      mark('check', `「已下载」筛选只显示 ${shown.join('、')}`);
      mark('step', '打开 设置 → 语音包（本地可用列表）');
      await go('/voicepacks');
      const rows = await admin.$$eval('[data-admin-page] tr[data-row-key]', (els) => els.map((e) => ({ id: e.dataset.rowKey, text: e.textContent.replace(/\s+/g, ' ') })));
      for (const id of [A, B]) {
        const row = rows.find((r) => r.id === id);
        assert.ok(row, rows.map((r) => r.id).join(','));
        assert.match(row.text, /商店下载/);
      }
      await admin.evaluate((id) => document.querySelector(`[data-admin-page] tr[data-row-key="${id}"]`)?.scrollIntoView({ block: 'center' }), A);
      mark('check', '设置 → 语音包 表格中 style-cute、style-shaonian 来源为「商店下载」');
      const s2 = await ashot('f5b-settings-voicepacks-local-list');
      const disk = ls(VDIR);
      record('f5-disk.txt', `${disk.map((d) => `<userData>/voicepacks/${d}: ${(ls(path.join(VDIR, d)) || []).length} entries`).join('\n')}\n`);
      return note(`F5 已下载筛选: ${shown.join(', ')}\n  设置 → 语音包: ${rows.filter((r) => /商店下载/.test(r.text)).map((r) => `${r.id}: ${r.text.slice(0, 80)}`).join(' | ')}\n  disk voicepacks/: ${JSON.stringify(disk)} → ${s1}, ${s2}`);
    }, () => admin || page);

    let fA = null;
    await step(S, `F6 角色 → 大肥鱼 → 语音 → 语音包：选「${nameOf(A)}」，写入 settings.json；桌宠喂食台词播放 userData/voicepacks/${A} 里的录音`, async () => {
      mark('step', '角色 → 大肥鱼 → 语音 → 打开「语音包」下拉');
      await voiceTab();
      const { opts, shot: s0 } = await pick(new RegExp(nameOf(A)), 'f6a-picker-downloaded');
      await choiceIs(A);
      mark('check', `已选「${nameOf(A)}」，settings.json=${JSON.stringify(picks())}`);
      assert.ok(opts.some((o) => o.group && o.text === '风格语音包（已下载）'));
      const cur = await current();
      assert.match(cur, new RegExp(`正在用 ${nameOf(A)} 风格·${labelOf(A)}`));
      assert.deepEqual(picks(), { dafeiyu: A });
      const s1 = await ashot('f6b-picked-A');
      mark('step', '桌宠：喂食（已吃饱）');
      const r = await feedFull('f6c-pet-plays-A');
      fA = assertFrom(r, A, `played-${A}.ogg`);
      mark('check', `桌宠播放 ${A}/${r.packFile}（${r.bytes} 字节）`);
      return note(`F6 picker: ${opts.map((o) => `${o.group ? '[组] ' : ''}${o.text}${o.disabled ? ' (disabled)' : ''}`).join(' | ')}\n  正在用: ${cur}; settings.json tts.voicePackByCharacter=${JSON.stringify(picks())}\n  ${fmt(r)} → ${s0}, ${s1}, ${r.shot}, played-${A}.ogg`);
    }, () => admin || page);

    await step(S, `F7 切换到「${nameOf(B)}」：不用重启，同一句立刻来自 ${B}（另一段录音）`, async () => {
      mark('step', `语音页切换到「${nameOf(B)}」`);
      await voiceTab();
      await pick(new RegExp(nameOf(B)));
      await choiceIs(B);
      mark('check', `已切到「${nameOf(B)}」，settings.json=${JSON.stringify(picks())}`);
      assert.deepEqual(picks(), { dafeiyu: B });
      const cur = await current();
      const s = await ashot('f7a-picked-B');
      mark('step', '桌宠：再次喂食（不重启）');
      const r = await feedFull('f7b-pet-plays-B');
      const f = assertFrom(r, B, `played-${B}.ogg`);
      mark('check', `同一句改为播放 ${B}/${r.packFile}（${r.bytes} 字节）`);
      assert.notEqual(f.sha256, fA.sha256, 'another recording');
      return note(`F7 正在用: ${cur}; settings.json=${JSON.stringify(picks())}\n  ${fmt(r)}\n  (A played ${fA.path.replace(data, '<userData>')} sha256=${fA.sha256}) → ${s}, ${r.shot}, played-${B}.ogg`);
    }, () => admin || page);

    await step(S, 'F8 重启应用：settings.json 仍是少年包；商店两个包仍「已下载」；角色语音页显示少年；喂食台词仍来自 style-shaonian', async () => {
      await app.close();
      mark('step', '重启应用（关闭后用同一个 userData 再启动）');
      ({ app, page } = await launch(env, { video: path.join(SHOTS, 'video-after-restart'), videoSize: VS }));
      track(page, 'pet-2');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      mark('check', `重启后 settings.json tts.voicePackByCharacter=${JSON.stringify(picks())}`);
      assert.deepEqual(picks(), { dafeiyu: B });
      assert.equal(settingsFile().prefs.voice, true);
      mark('step', '重启后喂食');
      const r = await feedFull('f8a-pet-after-restart');
      assertFrom(r, B);
      mark('check', `重启后仍播放 ${B}/${r.packFile}`);
      await openAdmin('overview');
      await openVoices();
      const st = await states();
      assert.deepEqual(st, Object.fromEntries(IDS.map((id) => [id, id === A || id === B ? 'installed' : 'remote'])));
      mark('check', `重启后商店：style-cute、style-shaonian 仍「已下载」`);
      const s1 = await ashot('f8b-store-after-restart');
      await voiceTab();
      const cur = await current();
      assert.match(cur, new RegExp(`正在用 ${nameOf(B)} 风格·${labelOf(B)}`));
      mark('check', `重启后大肥鱼语音页仍显示「${nameOf(B)}」`);
      const s2 = await ashot('f8c-voice-tab-after-restart');
      return note(`F8 after restart: settings.json tts.voicePackByCharacter=${JSON.stringify(picks())} prefs.voice=${settingsFile().prefs.voice}\n  store states ${JSON.stringify(st)}\n  正在用: ${cur}\n  ${fmt(r)} → ${r.shot}, ${s1}, ${s2}`);
    }, () => admin || page);

    await step(S, 'F9 没有渲染错误；下载请求只打到商店地址', async () => {
      const bad = errors.filter((e) => !/favicon|DevTools/.test(e));
      assert.deepEqual(bad, []);
      assert.deepEqual([...new Set(served)].sort(), [`${A}.zip`, `${B}.zip`].sort());
      return note(`F9 no console errors; served: ${served.join(', ')}`);
    }, page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'voiceflow-log.txt'), evidence.join('\n\n') + '\n');
    await app.close().catch(() => {});
    server.close();
    // chapters per window recording: marks inside [start, next window start of the same app run) count for every window open then
    const out = [];
    for (const v of videos) {
      const file = await v.page.video()?.path().catch(() => null);
      if (!file) continue;
      const named = path.join(path.dirname(file), `${v.name}.webm`);
      try { fs.renameSync(file, named); } catch { continue; }
      out.push({ name: v.name, file: path.relative(SHOTS, named), start: v.start });
    }
    fs.writeFileSync(path.join(SHOTS, 'videos.json'), JSON.stringify(out, null, 1));
    fs.writeFileSync(path.join(SHOTS, 'marks.jsonl'), marks.map((m) => JSON.stringify(m)).join('\n') + '\n');
  }
}

// ---------------------------------------------------------------- catalogdl (内置 5 位像素角色，其他下载后使用)
// A new install: the pet window offers only the five pixel characters that ship with the app; 角色图鉴 lists the
// other looks under 可下载的角色 (size, picture, 未下载). Downloading one (from a local server playing the release
// host, throttled so the progress shows) makes her a character: switchable, her own wardrobe; 原版动画's clips play
// from pack://. A corrupted archive is refused by its sha256 and leaves nothing behind. 删除下载 while she is with
// you puts her default look back with a 需要下载 notice whose button brings her back. Free: fake lh, no network.
// Evidence in out/e2e/catalogdl/.
async function catalogDownloadScenario() {
  const S = 'catalogdl';
  const SHOTS = path.join(OUT, 'catalogdl');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  // the release assets, rebuilt from catalog/ and checked against the index the app ships
  const zips = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-catzips-'));
  const built = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-character-catalog.js'), '--zips-only', '--out', zips], { cwd: ROOT, encoding: 'utf8' });
  const http = require('node:http');
  const corrupt = new Set();
  const served = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/chars\//, '');
    const file = path.join(zips, path.basename(name));
    served.push(name);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    let buf = fs.readFileSync(file);
    if (corrupt.has(name)) { buf = Buffer.from(buf); buf[Math.floor(buf.length / 2)] ^= 0xff; } // same size, other bytes
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
    // ~1.5 MB/s, so the bar is seen moving
    let i = 0;
    const tick = () => { if (i >= buf.length) return res.end(); res.write(buf.subarray(i, i + 96 * 1024)); i += 96 * 1024; setTimeout(tick, 60); };
    tick();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/chars`;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-catdl-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-catdlfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1', PIXELPET_CATALOG_PREINSTALLED: '', PIXELPET_CATALOG_URL: base };
  const record = (name, text) => { fs.writeFileSync(path.join(SHOTS, name), text); return name; };
  record('d0-zips-built.txt', `$ node scripts/build-character-catalog.js --zips-only --out <tmp>\n${built}\nserved from ${base} (throttled ~1.5 MB/s)\n`);
  let { app, page } = await launch(env);
  let admin = null;
  const errors = [];
  const W = 1180;
  const until = async (what, fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what}: not within ${ms} ms`);
  };
  const attached = (sel) => until(sel, () => admin.evaluate((x) => !!document.querySelector(x), sel));
  const call = (fn, ...args) => admin.evaluate(([f, a]) => window.petAdmin[f](...a), [fn, args]);
  const go = async (route) => {
    await admin.bringToFront();
    await admin.evaluate((r) => { location.hash = r; }, route);
    await attached(`[data-path="${route}"]`);
    await admin.waitForTimeout(300);
  };
  const toast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 20000 });
  const shot = async (name) => {
    const h = await admin.evaluate(() => { const el = document.querySelector('[data-admin-page]'); return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 48); });
    await app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, Math.min(Math.max(hh, 860), 3200)); }, [W, h]);
    await admin.waitForTimeout(350);
    await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 860); }, W);
    return `${name}.png`;
  };
  const petShot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).then(() => `${name}.png`);
  const rosterIds = () => admin.$$eval('[data-roster] [data-row]', (els) => els.map((e) => e.dataset.row));
  // 商店 → 角色: every card, and the ones still to download
  const catalogIds = () => admin.$$eval('[data-catalog-grid] [data-catalog]', (els) => els.filter((e) => e.querySelector('[data-not-downloaded]')).map((e) => e.dataset.catalog));
  const state = () => call('state');
  const leftovers = () => ['packs', 'clips'].flatMap((d) => (fs.existsSync(path.join(data, d)) ? fs.readdirSync(path.join(data, d)).filter((n) => n.startsWith('.')).map((n) => `${d}/${n}`) : []));
  const switchTo = async (id) => {
    await go(`/characters/${id}`);
    await attached(`[data-switch="${id}"]`);
    await admin.click(`[data-switch="${id}"]`);
    await until(`${id} current`, async () => (await state()).view.pet.characterId === id);
  };
  const download = async (id) => {
    await go('/store');
    await attached(`[data-download="${id}"]`);
    await admin.click(`[data-download="${id}"]`);
  };
  const CHAR_REMOTE = ['dafeiyu-classic', 'dafeiyu-live', 'dafeiyu-live2d', 'claude-classic', 'gemini-classic', 'gpt-classic', 'grok-classic', 'dafeiyu-clips'];
  // 商店 → 角色 also sells the VRM models (src/core/vrm-catalog.json, scripts/build-store-assets.js): the all-ages ones
  const VRM_REMOTE = require('../src/core/catalog').storeIndex().characters.filter((c) => c.kind === 'vrm' && !c.adult).map((c) => c.id);
  const ALL_AGES_REMOTE = [...CHAR_REMOTE, ...VRM_REMOTE];
  const N = ALL_AGES_REMOTE.length;

  try {
    await step(S, 'D1 新安装：桌宠窗口「选择你的模型娘」只有 5 位内置像素角色，提示更多形象到商店下载', async () => {
      await page.waitForSelector('.char-card');
      const cards = await page.locator('.char-card').evaluateAll((els) => els.map((e) => `${e.dataset.character}=${e.querySelector('.nm').textContent}`));
      assert.deepEqual(cards.map((c) => c.split('=')[0]), ['dafeiyu-pixel', 'claude-pixel', 'grok-pixel', 'gemini-pixel', 'gpt-pixel'], cards.join(', '));
      assert.ok(cards.every((c) => / · 像素$/.test(c)), cards.join(', '));
      assert.match(await page.textContent('#onboarding .sub'), /更多形象.*商店.*下载/);
      // every card draws her pixel look (a sheet's first frame) before the picture is taken
      await page.waitForFunction(() => [...document.querySelectorAll('.char-card .pic')].every((p) => { const c = p.querySelector('canvas, img'); return c && (c.tagName === 'IMG' ? c.complete && c.naturalWidth > 0 : c.width > 0); }), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const shotName = await petShot('d1-onboarding-five-pixel');
      await page.locator('.char-card[data-character="dafeiyu-pixel"]').click();
      await page.fill('#pet-name', '小鱼');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      return `选角卡片: ${cards.join('、')} (5 张) → ${shotName}`;
    }, page);

    admin = await openAdminWindow(app, page, 'overview');
    admin.on('pageerror', (e) => errors.push(String(e)));
    admin.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));

    await step(S, 'D2 角色图鉴只有本机的 5 位内置角色（另提示去商店）；商店 → 角色 有 8 张角色卡加上全年龄的 VRM 模型（图片、未下载、大小），18+ 不列出', async () => {
      await go('/characters');
      const ids = await rosterIds();
      assert.deepEqual(ids, ['dafeiyu-pixel', 'claude-pixel', 'grok-pixel', 'gemini-pixel', 'gpt-pixel']);
      assert.equal(await admin.$$eval('[data-roster] [data-catalog], [data-catalog-grid]', (els) => els.length), 0, 'no downloadable card in the 图鉴');
      const seg = await admin.$eval('[data-kind-filter]', (el) => el.textContent);
      assert.doesNotMatch(seg, /未下载/);
      const hint = await admin.$eval('[data-store-hint]', (el) => el.textContent);
      assert.match(hint, new RegExp(`商店里还有 ${N} 位角色可以下载`));
      const rosterShot = await shot('d2a-roster-local-only');
      await admin.click('[data-go-store]');
      await attached('[data-path="/store"]');
      await attached('[data-catalog-grid]');
      assert.equal(await admin.getAttribute('[data-rail="store"]', 'aria-current'), 'page', '商店 is lit on the rail');
      const remote = await catalogIds();
      assert.deepEqual([...remote].sort(), [...ALL_AGES_REMOTE].sort());
      const l2d = await admin.evaluate(() => {
        const el = document.querySelector('[data-catalog="dafeiyu-live2d"]');
        const img = el.querySelector('img');
        return { tag: el.querySelector('[data-not-downloaded]')?.textContent, meta: el.querySelector('[data-catalog-meta]')?.textContent, img: img ? { src: img.getAttribute('src'), ok: img.complete && img.naturalWidth > 0 } : null, btn: el.querySelector('[data-download]')?.textContent };
      });
      assert.equal(l2d.tag, '未下载');
      assert.match(l2d.meta, /^\d+\.\d MB · 1 套服饰/);
      assert.ok(l2d.img && l2d.img.ok, JSON.stringify(l2d.img));
      assert.equal(l2d.btn, '下载');
      const filter = await admin.$eval('[data-store-filter]', (el) => el.textContent);
      assert.match(filter, new RegExp(`全部 ${N}.*未下载 ${N}.*已下载 0`));
      return `图鉴角色: ${ids.join(', ')}（提示「${hint}」）; 商店可下载: ${remote.join(', ')}; Live2D 卡: ${JSON.stringify(l2d)} → ${rosterShot}, ${await shot('d2b-store-characters')}`;
    }, page);

    await step(S, 'D3 下载「大肥鱼 · Live2D」：进度条走动，完成后成为图鉴里的角色（来源「下载」），切换后桌宠是 Live2D', async () => {
      await download('dafeiyu-live2d');
      await attached('[data-download-progress="dafeiyu-live2d"]');
      await admin.waitForFunction(() => /已下载 [1-9]\d?%/.test(document.querySelector('[data-download-progress="dafeiyu-live2d"]')?.textContent || ''), null, { timeout: 15000 });
      const mid = await admin.$eval('[data-download-progress="dafeiyu-live2d"]', (el) => el.textContent);
      const midShot = await admin.screenshot({ path: path.join(SHOTS, 'd3a-downloading.png') }).then(() => 'd3a-downloading.png');
      await toast(/「大肥鱼 · Live2D」下载好了/);
      await until('live2d in roster', async () => (await state()).roster.some((r) => r.id === 'dafeiyu-live2d'));
      assert.ok(!(await catalogIds()).includes('dafeiyu-live2d'));
      // 商店 keeps her, as 已下载 with 查看 (→ her page)
      await go('/store');
      await attached('[data-downloaded="dafeiyu-live2d"]');
      assert.equal(await admin.getAttribute('[data-store-open="dafeiyu-live2d"]', 'href'), '#/characters/dafeiyu-live2d');
      const storeShot = await shot('d3d-store-downloaded');
      const marker = JSON.parse(fs.readFileSync(path.join(data, 'packs', 'dafeiyu-live2d', '.catalog.json'), 'utf8'));
      const st = await state();
      const row = st.roster.find((r) => r.id === 'dafeiyu-live2d');
      assert.deepEqual([row.source, row.sourceLabel, row.kind], ['download', '下载', 'live2d']);
      assert.deepEqual(leftovers(), []);
      await switchTo('dafeiyu-live2d');
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.kind === 'live2d', null, { timeout: 20000 });
      await page.waitForTimeout(2500);
      const v = await view(page);
      assert.equal(v.look.packId, 'dafeiyu-live2d');
      assert.equal(v.pet.agentId, st.view.pet.agentId, 'the same 大肥鱼: shared agent');
      return `进度: ${mid}; 安装标记: ${JSON.stringify(marker)}; 图鉴行: ${row.source}/${row.sourceLabel}/${row.kind}; 桌宠 look=${v.look.packId} → ${midShot}, ${storeShot}, ${await shot('d3b-live2d-downloaded')}, ${await petShot('d3c-pet-live2d')}`;
    }, page);

    await step(S, 'D4 下载「大肥鱼 · 原版动画」：切换后桌宠从 pack://dafeiyu-clips 播放视频', async () => {
      await download('dafeiyu-clips');
      await toast(/「大肥鱼 · 原版动画」下载好了/);
      await switchTo('dafeiyu-clips');
      const probe = () => page.evaluate(() => { const v = document.getElementById('pet-video'); return { src: v.src, w: v.videoWidth, h: v.videoHeight, t: v.currentTime, ready: v.readyState, err: v.error && v.error.message, hidden: document.getElementById('vwrap').classList.contains('hidden') }; });
      try {
        await page.waitForFunction(() => { const v = document.getElementById('pet-video'); return v.src.startsWith('pack://dafeiyu-clips/') && v.readyState >= 2 && !document.getElementById('vwrap').classList.contains('hidden'); }, null, { timeout: 20000 });
      } catch (e) {
        throw new Error(`clip not playing: ${JSON.stringify(await probe())}`);
      }
      const vid = await probe();
      assert.ok(vid.w > 0 && vid.h > 0);
      assert.ok(fs.existsSync(path.join(data, 'clips', 'dafeiyu-clips', 'idle.webm')));
      return `video ${JSON.stringify(vid)} → ${await petShot('d4-pet-clips')}`;
    }, page);

    await step(S, 'D5 下载的文件被篡改：sha256 校验不通过，提示失败，本机不留任何文件，卡片仍可重新下载', async () => {
      corrupt.add('claude-classic.zip');
      await download('claude-classic');
      await toast(/没能下载「克洛蒂 · 旧版像素」/);
      await toast(/校验没通过/);
      const failShot = await shot('d5-checksum-failed');
      assert.ok(!fs.existsSync(path.join(data, 'packs', 'claude-classic')));
      assert.deepEqual(leftovers(), []);
      assert.ok((await catalogIds()).includes('claude-classic'));
      await attached('[data-download="claude-classic"]');
      corrupt.delete('claude-classic.zip');
      await admin.click('[data-download="claude-classic"]');
      await toast(/「克洛蒂 · 旧版像素」下载好了/);
      await until('claude-classic in roster', async () => (await state()).roster.some((r) => r.id === 'claude-classic'));
      return `篡改后: 未安装、无残留；恢复后重下成功 → ${failShot}`;
    }, page);

    await step(S, 'D6 删除正在陪伴的下载角色：先换回默认像素形象并提示「需要下载」，点提示里的下载后自动换回', async () => {
      await switchTo('dafeiyu-live2d');
      await attached('[data-remove-download="dafeiyu-live2d"]');
      await admin.click('[data-remove-download="dafeiyu-live2d"]');
      await admin.getByRole('button', { name: '删除下载' }).last().click();
      await toast(/已删除下载「大肥鱼 · Live2D」/);
      await until('back to pixel', async () => (await state()).view.pet.characterId === 'dafeiyu-pixel');
      assert.ok(!fs.existsSync(path.join(data, 'packs', 'dafeiyu-live2d')));
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.kind === 'sprites', null, { timeout: 20000 });
      await go('/characters');
      await attached('[data-pending="dafeiyu-live2d"]');
      const alert = await admin.$eval('[data-pending="dafeiyu-live2d"]', (el) => el.textContent);
      assert.match(alert, /「大肥鱼 · Live2D」需要下载/);
      assert.match(alert, /好感和聊天记录都不受影响/);
      await admin.evaluate(() => document.querySelector('[data-pending]').scrollIntoView({ block: 'center' }));
      await admin.waitForTimeout(400);
      const pendShot = await admin.screenshot({ path: path.join(SHOTS, 'd6a-pending-download.png') }).then(() => 'd6a-pending-download.png');
      await admin.click('[data-pending-download="dafeiyu-live2d"]');
      await toast(/「大肥鱼 · Live2D」下载好了/);
      await until('back to live2d', async () => (await state()).view.pet.characterId === 'dafeiyu-live2d');
      await page.waitForFunction(() => document.getElementById('pet-body').dataset.kind === 'live2d', null, { timeout: 20000 });
      await admin.waitForFunction(() => !document.querySelector('[data-pending]'), null, { timeout: 8000 });
      return `提示: ${alert}; 下载后 characterId=dafeiyu-live2d → ${pendShot}, ${await shot('d6b-after-redownload')}`;
    }, page);

    await step(S, 'D7 设置窗口无报错；只从配置的下载地址取文件', async () => {
      assert.deepEqual(errors, []);
      assert.ok(served.length >= 5 && served.every((n) => /^[a-z0-9-]+\.zip$/.test(n)), served.join(', '));
      return `served: ${served.join(', ')}`;
    }, page);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
}

// ---------------------------------------------------------------- charmigrate (旧数据迁移到独立角色, T-2786)
// A user of the 形象包 era: 当前角色 大肥鱼, 形象包 dafeiyu-pixel, in 长旗袍, 半身 取景, a VRM posture, ♥72, a
// pack she imported herself (「我的大肥鱼」, data/packs/my-fish) and 克洛蒂 met as well in 贝雷帽画家装. The app
// opens on the character 「大肥鱼 · 像素」 with all of it kept, a second start migrates nothing, 角色图鉴 lists
// every look (the imported one too) as its own character, and switching characters / dressing one does not leak
// into another. Free: fake lh, no network. Evidence in out/e2e/charmigrate/.
async function charMigrateScenario() {
  const S = 'charmigrate';
  const SHOTS = path.join(OUT, 'charmigrate');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-charmig-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-charmigfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1' };
  const now = Date.now();
  const read = (f) => fs.readFileSync(path.join(data, f), 'utf8');
  const json = (f) => JSON.parse(read(f));
  const record = (name, text) => { fs.writeFileSync(path.join(SHOTS, name), text); return name; };

  // the imported pack: a copy of her pixel pack's daily sheet under an id and name of the owner's own
  const mine = path.join(data, 'packs', 'my-fish');
  const basePack = path.join(ROOT, 'src', 'renderer', 'packs', 'dafeiyu-pixel');
  const m = JSON.parse(fs.readFileSync(path.join(basePack, 'pack.json'), 'utf8'));
  fs.mkdirSync(path.join(mine, 'sheets'), { recursive: true });
  const sheet = `sheets/mine${path.extname(m.outfits.daily)}`;
  fs.copyFileSync(path.join(basePack, m.outfits.daily), path.join(mine, sheet));
  const { adult: _a, halfBody: _h, ...rest } = m;
  fs.writeFileSync(path.join(mine, 'pack.json'), JSON.stringify({ ...rest, id: 'my-fish', name: '我的大肥鱼', author: 'tester', outfits: { daily: sheet } }, null, 2));

  const c0 = { createdAt: now - 1e6, hunger: 30, mood: 60, energy: 90, sleeping: false, lastTickAt: now, lastInteractionAt: now, lastFedAt: now, lastSpokeAt: now, personaVersion: 6, seenUnlocks: [], dailyCounts: {}, lastAffectionAt: {}, topicsToday: [] };
  const petBefore = { schemaVersion: 3, speciesId: 'dafeiyu', createdAt: now - 1e6, owner: 'me', space: { workspaceId: null, name: '个人空间' }, characters: {
    dafeiyu: { ...c0, speciesId: 'dafeiyu', name: '小鱼', agentId: 'agt_FISH', topicId: 'tpc_FISH', affection: 72, relStage: 'flirty', peakStage: 'flirty', equippedOutfit: 'qipao', lastSafeOutfit: 'qipao' },
    claude: { ...c0, speciesId: 'claude', name: '克克', agentId: 'agt_CLAUDE', topicId: 'tpc_CLAUDE', affection: 20, relStage: 'familiar', peakStage: 'familiar', equippedOutfit: 'beret', lastSafeOutfit: 'beret' },
  } };
  const settingsBefore = { ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false,
    appearance: { dafeiyu: 'dafeiyu-pixel', claude: 'claude-pixel' },
    framings: { dafeiyu: 'half' },
    vrmPostures: { 'vrm-dafeiyu-mine': 'sit.rest' },
    visitors: ['claude'],
    models: { dafeiyu: 'lobehub:deepseek-chat' },
    systemRoles: { dafeiyu: '叫我老板' } };
  fs.writeFileSync(path.join(data, 'pet.json'), JSON.stringify(petBefore, null, 2));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settingsBefore, null, 2));
  record('m0-old-format-input.json', JSON.stringify({ 'settings.json': settingsBefore, 'pet.json': petBefore, 'packs/my-fish/pack.json': json('packs/my-fish/pack.json') }, null, 2));

  let { app, page } = await launch(env);
  let admin = null;
  const errors = [];
  const W = 1180;
  const until = async (what, fn, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what}: not within ${ms} ms`);
  };
  const attached = (sel) => until(sel, () => admin.evaluate((x) => !!document.querySelector(x), sel));
  const call = (fn, ...args) => admin.evaluate(([f, a]) => window.petAdmin[f](...a), [fn, args]);
  const go = async (route) => {
    await admin.bringToFront();
    await admin.evaluate((r) => { location.hash = r; }, route);
    await attached(`[data-path="${route}"]`);
    await admin.waitForTimeout(300);
  };
  const tab = async (name) => {
    await admin.getByRole('tab', { name, exact: true }).click();
    await until(`tab ${name}`, () => admin.evaluate((n) => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === n); return !!t && t.getAttribute('aria-selected') === 'true'; }, name));
    await admin.waitForTimeout(250);
  };
  const shot = async (name) => {
    const h = await admin.evaluate(() => { const el = document.querySelector('[data-admin-page]'); return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 48); });
    await app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, Math.min(Math.max(hh, 860), 3200)); }, [W, h]);
    await admin.waitForTimeout(350);
    await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 860); }, W);
    return `${name}.png`;
  };
  const petShot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).then(() => `${name}.png`);
  const petLook = () => page.evaluate(() => ({ kind: document.getElementById('pet-body').dataset.kind, outfit: document.getElementById('char-wrap').dataset.outfit }));
  const cards = (id) => admin.$$eval(`[data-outfits="${id}"] [data-outfit]`, (els) => els.map((e) => ({ id: e.dataset.outfit, equipped: e.dataset.equipped === 'true', locked: e.dataset.locked === 'true', worn: e.querySelector('[data-worn]')?.textContent || '', equip: e.querySelector('[data-equip]')?.textContent || '', picture: !!e.querySelector('canvas, img, video') })));
  const wardrobes = () => Object.fromEntries(Object.entries(json('pet.json').characters).map(([b, c]) => [b, c.wardrobes]));
  const openAdmin = async () => {
    admin = await openAdminWindow(app, page, 'overview');
    admin.on('pageerror', (e) => errors.push(String(e)));
    admin.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));
  };
  const switchTo = async (id) => {
    await go(`/characters/${id}`);
    await attached(`[data-switch="${id}"]`);
    await admin.click(`[data-switch="${id}"]`);
    await until(`${id} current`, async () => (await call('state')).view.pet.characterId === id);
    await tab('装扮');
  };
  const viewNow = async () => { const v = (await call('state')).view; return { characterId: v.pet.characterId, name: v.character && v.character.name, packId: v.look && v.look.packId, outfit: v.outfit, affection: v.pet.affection, agentId: v.pet.agentId, petName: v.pet.name }; };

  let petAfter1 = null;
  let settingsAfter1 = null;
  try {
    await step(S, 'M1 旧数据（大肥鱼 + 形象包 dafeiyu-pixel）启动后进入独立角色「大肥鱼 · 像素」，衣服/取景/VRM 姿势/好感度/导入包/模型/个性化设定都在', async () => {
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 20000 });
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'qipao', null, { timeout: 15000 });
      await page.waitForTimeout(1200);
      const v = await view(page);
      assert.equal(v.pet.characterId, 'dafeiyu-pixel', '大肥鱼 + dafeiyu-pixel → 「大肥鱼 · 像素」');
      assert.equal(v.character.name, '大肥鱼 · 像素');
      assert.equal(v.look.packId, 'dafeiyu-pixel');
      assert.equal(v.outfit, 'qipao', 'she still wears 长旗袍');
      assert.equal(v.pet.affection, 72);
      assert.equal(v.pet.agentId, 'agt_FISH');
      assert.equal(v.pet.name, '小鱼');
      const pl = await petLook();
      assert.deepEqual(pl, { kind: 'sprites', outfit: 'qipao' });
      await hover(page);
      const meta = await page.textContent('#meta');
      assert.match(meta, /小鱼 · 大肥鱼 · 像素 · 知己 ♥72/);
      petAfter1 = json('pet.json');
      settingsAfter1 = json('settings.json');
      assert.equal(petAfter1.characterModel, 2);
      assert.equal(petAfter1.characterId, 'dafeiyu-pixel');
      assert.equal(petAfter1.speciesId, 'dafeiyu');
      assert.deepEqual(petAfter1.characters.dafeiyu.wardrobes['dafeiyu-pixel'], { equippedOutfit: 'qipao', lastSafeOutfit: 'qipao' });
      assert.ok(petAfter1.characters.dafeiyu.wardrobes['my-fish'], 'the imported pack, a character of hers, gets a wardrobe too');
      assert.deepEqual(petAfter1.characters.claude.wardrobes['claude-pixel'], { equippedOutfit: 'beret', lastSafeOutfit: 'beret' });
      assert.equal(petAfter1.characters.dafeiyu.affection, 72);
      assert.equal(settingsAfter1.characterModel, 2);
      assert.equal(settingsAfter1.appearance, undefined, 'the old key is gone');
      assert.deepEqual(settingsAfter1.legacyAppearance, settingsBefore.appearance, 'kept read-only for an older pet.json');
      assert.equal(settingsAfter1.framings['dafeiyu-pixel'], 'half', '取景 for 「大肥鱼 · 像素」');
      assert.equal(settingsAfter1.framings['my-fish'], 'half', '…and for each of her characters, the imported one too');
      assert.equal(settingsAfter1.framings.dafeiyu, undefined);
      assert.deepEqual(settingsAfter1.vrmPostures, settingsBefore.vrmPostures);
      assert.deepEqual(settingsAfter1.visitors, ['claude-pixel']);
      assert.deepEqual([settingsAfter1.models, settingsAfter1.systemRoles], [settingsBefore.models, settingsBefore.systemRoles]);
      assert.ok(fs.existsSync(path.join(data, 'packs', 'my-fish', 'pack.json')), 'the imported pack is still there');
      assert.deepEqual(json('settings.characters.bak.json'), settingsBefore, 'settings backed up as they were');
      assert.deepEqual(json('pet.characters.bak.json'), petBefore, 'pet.json backed up as it was');
      const ch = v.characters.find((x) => x.id === 'dafeiyu-pixel');
      assert.equal(ch.framing, 'half');
      const mineCh = v.characters.find((x) => x.id === 'my-fish');
      assert.ok(mineCh && mineCh.name === '大肥鱼 · 我的大肥鱼' || mineCh.name === '我的大肥鱼', JSON.stringify(mineCh && mineCh.name));
      record('m1-migrated-output.json', JSON.stringify({ 'settings.json': settingsAfter1, 'pet.json': petAfter1, 'settings.characters.bak.json (== input)': 'deepEqual ok', 'pet.characters.bak.json (== input)': 'deepEqual ok', view: { characterId: v.pet.characterId, character: v.character.name, look: v.look.packId, outfit: v.outfit, affection: v.pet.affection, agentId: v.pet.agentId, name: v.pet.name, framing: ch.framing, meta } }, null, 2));
      const s = await petShot('m1-pet-window-migrated');
      return `characterId ${v.pet.characterId} (${v.character.name}); outfit ${v.outfit}; ♥${v.pet.affection}; agent ${v.pet.agentId}; meta 「${meta}」; framings ${JSON.stringify(settingsAfter1.framings)}; vrmPostures ${JSON.stringify(settingsAfter1.vrmPostures)}; imported → ${mineCh.id} 「${mineCh.name}」; ${s}`;
    }, () => page);

    await step(S, 'M2 再次启动：没有二次迁移 —— settings.json 字节不变，pet.json 角色/衣柜/好感度不变，备份不被覆盖', async () => {
      await app.close();
      const s1 = read('settings.json');
      const p1 = json('pet.json');
      const bak1 = [read('settings.characters.bak.json'), read('pet.characters.bak.json')];
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 20000 });
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'qipao', null, { timeout: 15000 });
      const v = await view(page);
      assert.equal(v.pet.characterId, 'dafeiyu-pixel');
      assert.equal(v.outfit, 'qipao');
      assert.equal(v.pet.affection, 72);
      const s2 = read('settings.json');
      const p2 = json('pet.json');
      assert.equal(s2, s1, 'settings.json byte for byte');
      const strip = (p) => { const { lastTickAt: _t, ...r } = p; const cs = {}; for (const [k, c] of Object.entries(p.characters)) { const { lastTickAt: _x, hunger: _hu, mood: _mo, energy: _en, ...cr } = c; cs[k] = cr; } return { ...r, characters: cs }; };
      assert.deepEqual(strip(p2), strip(p1), 'pet.json the same but for the clock and needs the heartbeat moves');
      assert.deepEqual([read('settings.characters.bak.json'), read('pet.characters.bak.json')], bak1, 'the backups are not overwritten');
      // the migration itself, run once more on what is on disk now: nothing to change
      const P = require('../src/core/packs');
      const CM = require('../src/core/character-migrate');
      const { packs } = P.loadPacks([{ dir: path.join(ROOT, 'src', 'renderer', 'packs'), source: 'builtin' }, { dir: path.join(data, 'packs'), source: 'user' }]);
      const again = CM.migrateAll({ settings: JSON.parse(s2), pet: p2, packs });
      assert.equal(again.settingsChanged, false);
      assert.equal(again.petChanged, false);
      assert.deepEqual(again.pet.characters.dafeiyu.wardrobes, p1.characters.dafeiyu.wardrobes);
      const dump = [
        `settings.json 1st start sha-like length ${s1.length}, 2nd start ${s2.length}, identical: ${s1 === s2}`,
        `pet.json characterId ${p1.characterId} → ${p2.characterId}; characterModel ${p1.characterModel} → ${p2.characterModel}`,
        `wardrobes 1st: ${JSON.stringify(Object.fromEntries(Object.entries(p1.characters).map(([b, c]) => [b, c.wardrobes])))}`,
        `wardrobes 2nd: ${JSON.stringify(Object.fromEntries(Object.entries(p2.characters).map(([b, c]) => [b, c.wardrobes])))}`,
        `affection 1st/2nd: ${p1.characters.dafeiyu.affection}/${p2.characters.dafeiyu.affection}`,
        `backups unchanged: true`,
        `migrateAll(on-disk files again) → settingsChanged=${again.settingsChanged} petChanged=${again.petChanged}`,
      ].join('\n');
      record('m2-idempotent-second-start.txt', `${dump}\n`);
      return `${dump.replace(/\n/g, '; ')}; ${await petShot('m2-pet-window-second-start')}`;
    }, () => page);

    await step(S, 'M3 角色图鉴：每个原形象包都是独立角色卡（大肥鱼 · 像素 / Live2D / 导入的「我的大肥鱼」…），没有「形象包」字样', async () => {
      await openAdmin();
      await go('/characters');
      await attached('[data-row="dafeiyu-pixel"]');
      await attached('[data-row="my-fish"]');
      await until('roster cards drawn', () => admin.evaluate(() => [...document.querySelectorAll('[data-roster] [data-row]')].every((r) => !!r.querySelector('[data-drawn]'))), 60000);
      const rows = await admin.$$eval('[data-roster] [data-row]', (els) => els.map((e) => ({ id: e.dataset.row, kind: e.dataset.kind, text: e.innerText.replace(/\s+/g, ' ').trim() })));
      const ids = rows.map((r) => r.id);
      for (const id of ['dafeiyu-pixel', 'dafeiyu-live2d', 'dafeiyu-classic', 'my-fish', 'claude-pixel', 'claude-classic']) assert.ok(ids.includes(id), `${id} is a card: ${ids.join(',')}`);
      const text = await admin.innerText('[data-admin-page]');
      assert.ok(!text.includes('形象包'), 'no 形象包 on 角色图鉴');
      record('m3-roster.txt', `${rows.map((r) => `${r.id}\t${r.kind}\t${r.text}`).join('\n')}\n\n--- page innerText ---\n${text}\n`);
      return `${rows.length} cards: ${ids.join(', ')}; ${await shot('m3-roster-after-migration')}`;
    }, () => admin);

    await step(S, 'M4「大肥鱼 · 像素」的衣柜是卡片列表，迁移过来的长旗袍「正在穿」；穿上 针织围巾套装 后桌宠换装', async () => {
      await go('/characters/dafeiyu-pixel');
      await tab('装扮');
      await attached('[data-outfits="dafeiyu-pixel"] [data-outfit="qipao"][data-equipped="true"]');
      const c = await cards('dafeiyu-pixel');
      assert.ok(c.length >= 10 && c.every((x) => x.picture), `${c.length} cards with pictures`);
      assert.equal(c.find((x) => x.equipped).id, 'qipao');
      assert.equal(c.find((x) => x.id === 'qipao').worn, '正在穿');
      await admin.locator('[data-outfits="dafeiyu-pixel"] [data-outfit="qipao"]').scrollIntoViewIfNeeded();
      await admin.waitForTimeout(800);
      const s0 = await shot('m4a-pixel-wardrobe-cards-qipao-worn');
      const p0 = await petShot('m4a-pet-qipao');
      await admin.locator('[data-outfits="dafeiyu-pixel"] [data-equip="scarf"]').scrollIntoViewIfNeeded();
      await admin.click('[data-outfits="dafeiyu-pixel"] [data-equip="scarf"]');
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'scarf', null, { timeout: 8000 });
      await attached('[data-outfits="dafeiyu-pixel"] [data-outfit="scarf"][data-equipped="true"]');
      await page.waitForTimeout(600);
      assert.equal(wardrobes().dafeiyu['dafeiyu-pixel'].equippedOutfit, 'scarf');
      const s1 = await shot('m4b-pixel-wardrobe-scarf-worn');
      const p1 = await petShot('m4b-pet-scarf');
      return `${c.length} cards: ${c.map((x) => `${x.id}${x.equipped ? '[正在穿]' : x.locked ? '[未解锁]' : ''}`).join(' ')}; 穿上 scarf → pet window ${JSON.stringify(await petLook())}; ${[s0, p0, s1, p1].join(', ')}`;
    }, () => admin);

    await step(S, 'M5 切换到导入的「我的大肥鱼」：同一个她（agent/好感度共享），衣柜只有她自己的日常服；像素版仍穿着围巾', async () => {
      await switchTo('my-fish');
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'daily', null, { timeout: 15000 });
      await attached('[data-outfits="my-fish"] [data-outfit="daily"][data-equipped="true"]');
      const v = await viewNow();
      assert.equal(v.packId, 'my-fish');
      assert.equal(v.outfit, 'daily');
      assert.equal(v.agentId, 'agt_FISH', 'same agent as 「大肥鱼 · 像素」');
      assert.equal(v.affection, 72, 'same affection');
      const c = await cards('my-fish');
      assert.deepEqual(c.map((x) => x.id), ['daily'], 'only the outfits her own pack has');
      assert.equal(wardrobes().dafeiyu['dafeiyu-pixel'].equippedOutfit, 'scarf', 'the pixel character keeps her scarf');
      await page.waitForTimeout(800);
      return `view ${JSON.stringify(v)}; cards ${c.map((x) => x.id).join(',')}; wardrobes.dafeiyu ${JSON.stringify(wardrobes().dafeiyu)}; ${await shot('m5-my-fish-wardrobe')}, ${await petShot('m5-pet-my-fish')}`;
    }, () => admin);

    await step(S, 'M6 切换到「克洛蒂 · 像素」：她自己的 agent、好感度和迁移过来的贝雷帽；穿上休闲卫衣不影响大肥鱼的衣柜', async () => {
      await switchTo('claude-pixel');
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'beret', null, { timeout: 15000 });
      const v = await viewNow();
      assert.equal(v.packId, 'claude-pixel');
      assert.equal(v.agentId, 'agt_CLAUDE');
      assert.equal(v.affection, 20);
      assert.equal(v.outfit, 'beret', 'her migrated outfit');
      await attached('[data-outfits="claude-pixel"] [data-outfit="beret"][data-equipped="true"]');
      const before = await petShot('m6a-pet-claude-beret');
      await admin.locator('[data-outfits="claude-pixel"] [data-equip="casual"]').scrollIntoViewIfNeeded();
      await admin.click('[data-outfits="claude-pixel"] [data-equip="casual"]');
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'casual', null, { timeout: 8000 });
      const w = wardrobes();
      assert.equal(w.claude['claude-pixel'].equippedOutfit, 'casual');
      assert.equal(w.dafeiyu['dafeiyu-pixel'].equippedOutfit, 'scarf', 'not touched');
      assert.equal(w.dafeiyu['my-fish'].equippedOutfit !== 'beret', true);
      assert.ok(!(await cards('claude-pixel')).some((x) => x.id === 'qipao' && x.equipped), 'no 大肥鱼 outfit worn here');
      await page.waitForTimeout(600);
      return `view ${JSON.stringify(v)} → casual; wardrobes ${JSON.stringify({ claude: w.claude['claude-pixel'], 'dafeiyu-pixel': w.dafeiyu['dafeiyu-pixel'], 'my-fish': w.dafeiyu['my-fish'] })}; ${before}, ${await shot('m6-claude-wardrobe-casual')}, ${await petShot('m6b-pet-claude-casual')}`;
    }, () => admin);

    await step(S, 'M7 回到「大肥鱼 · 像素」：还是围巾、♥72、agt_FISH；没有控制台错误', async () => {
      await switchTo('dafeiyu-pixel');
      await page.waitForFunction(() => document.getElementById('char-wrap').dataset.outfit === 'scarf', null, { timeout: 15000 });
      const v = await viewNow();
      assert.deepEqual([v.packId, v.outfit, v.affection, v.agentId], ['dafeiyu-pixel', 'scarf', 72, 'agt_FISH']);
      assert.deepEqual(errors, []);
      await page.waitForTimeout(800);
      record('m7-final-wardrobes.json', JSON.stringify({ characterId: json('pet.json').characterId, wardrobes: wardrobes(), framings: json('settings.json').framings }, null, 2));
      return `view ${JSON.stringify(v)}; console errors: none; ${await shot('m7-pixel-back-scarf')}, ${await petShot('m7-pet-pixel-scarf')}`;
    }, () => admin);
  } finally {
    await app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- admincov (配置后台覆盖度)
// docs/admin-console-design.md §12: the settings window lists every character with every kind of pack
// (built-in pixel / 全动态 / Live2D, imported 图片 / Live2D / VRM), filters by kind, shows each detail tab
// (形象包, 服饰, 好感, 模型, 设定, 语音, 资料), and the controls that used to live only in the pet window or
// a menu now work from here: 服饰 → 穿上, Live2D 模型大小, 找回桌宠, 自动检查更新, 数据目录. A behaviour changed
// in the settings window shows in the pet window at once. Free: fake lh, no network.
async function adminCoverageScenario() {
  const S = 'admincov';
  const SHOTS = path.join(OUT, 'admincov');
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-admincov-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-admincovfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  // the packs a user brings: a 图片 pack (gemini), her own Live2D model (dafeiyu) and a VRM (claude)
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-admincovfix-'));
  const pic = path.join(fix, 'gemini-photo');
  fs.mkdirSync(pic);
  fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), path.join(pic, 'daily.png'));
  fs.writeFileSync(path.join(pic, 'pack.json'), JSON.stringify({ schema: 2, id: 'gemini-photo', name: '双子立绘', species: 'gemini', kind: 'pictures', author: 'e2e', license: 'CC0', outfits: { daily: 'daily.png' } }));
  const l2d = path.join(fix, 'Whale');
  fs.cpSync(path.join(ROOT, 'catalog', 'packs', 'dafeiyu-live2d', 'model'), l2d, { recursive: true });
  const vrmFile = path.join(fix, 'fish.vrm');
  fs.writeFileSync(vrmFile, require('../scripts/make-test-vrm').makeTestVrm({ name: 'Test Fish', meta: { allowRedistribution: true, licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', commercialUsage: 'personalNonProfit' } }));

  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1' });
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  const errors = [];
  let admin = null;
  const W = 1180;
  const adminWin = `BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui'))`;
  // a settings window behind the always-on-top pet gets no animation frames (Playwright's waits poll on them)
  const go = async (route) => {
    await admin.bringToFront();
    await admin.evaluate((r) => { location.hash = r; }, route);
    await attached(`[data-path="${route}"]`);
    await admin.waitForTimeout(300);
  };
  // the whole page in one image: grow the window to the page's height, capture, shrink back
  const shot = async (name) => {
    const h = await admin.evaluate(() => { const el = document.querySelector('[data-admin-page]'); return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 48); });
    await app.evaluate(({ BrowserWindow }, [w, hh]) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, Math.min(Math.max(hh, 860), 3200)); }, [W, h]);
    await admin.waitForTimeout(350);
    await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 860); }, W);
    return `${name}.png`;
  };
  const petShot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).then(() => `${name}.png`);
  // while the tabs switch the old panel stays a moment (inert): wait for the one live panel
  const tab = async (name) => {
    await admin.bringToFront();
    await admin.getByRole('tab', { name, exact: true }).click();
    await until(`tab ${name}`, () => admin.evaluate((n) => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === n); return !!t && t.getAttribute('aria-selected') === 'true' && document.querySelectorAll('[role="tabpanel"]').length === 1; }, name));
    await admin.waitForTimeout(250);
  };
  // poll with evaluate (not on animation frames): true once `sel` is in the settings window
  const until = async (what, fn, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what}: not within ${ms} ms`);
  };
  const attached = (sel) => until(sel, () => admin.evaluate((x) => !!document.querySelector(x), sel));
  const call = (fn, ...args) => admin.evaluate(([f, a]) => window.petAdmin[f](...a), [fn, args]);
  const petBoundsNow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('admin-ui') && !w.webContents.getURL().includes('visitor=')).getBounds());
  try {
    await step(S, 'B0 hatch 格萝可, ⚙ 设置 opens the settings window (the pet window has no ⋯ menu since T-2718)', async () => {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="grok"]');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await clickAct(page, 'settings');
      for (let i = 0; i < 200 && !admin; i++) {
        admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
        if (!admin) await page.waitForTimeout(100);
      }
      assert.ok(admin, 'the settings window opened');
      admin.on('pageerror', (e) => errors.push(String(e)));
      admin.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await admin.waitForSelector('[data-admin-page="overview"]', { timeout: 20000 });
      await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));
      await app.evaluate(({ BrowserWindow }, w) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(w, 860); }, W);
      return 'settings window up';
    }, page);

    let imported3 = {};
    await step(S, 'B1 imported packs of every kind: 图片 (gemini), Live2D (dafeiyu, from the settings window), VRM (claude, from the settings window)', async () => {
      const a = await page.evaluate((d) => window.pet.debugImportPack(d), pic);
      assert.equal(a.ok, true, JSON.stringify(a));
      await page.evaluate((x) => window.pet.debugNextOpen(x), path.join(l2d, 'medium.model3.json'));
      const b = await call('importLive2d', 'dafeiyu-pixel');
      assert.equal(b.ok, true, JSON.stringify(b));
      await page.evaluate((x) => window.pet.debugNextOpen(x), vrmFile);
      const c = await call('importVrm', 'claude-pixel');
      assert.equal(c.ok, true, JSON.stringify(c));
      imported3 = { l2d: b.pack.id, vrm: c.pack.id };
      await go('/packs');
      const rows = await admin.evaluate(() => [...document.querySelectorAll('[data-packs] tbody tr')].map((tr) => tr.textContent));
      const packs = await admin.evaluate(async () => (await window.petAdmin.state()).packs.map((p) => `${p.id}:${p.kind}:${p.source}`));
      for (const want of ['gemini-photo:pictures:user', `${b.pack.id}:live2d:user`, `${c.pack.id}:vrm:user`, 'dafeiyu-live2d:live2d:download', 'dafeiyu-live:rig:download', 'grok-pixel:sprites:builtin']) assert.ok(packs.includes(want), `${want} in ${packs.join(' ')}`);
      const f = await shot('b1-packs');
      return `${packs.length} packs (${rows.length} table rows): ${packs.join(' ')}; ${f}`;
    }, () => admin);

    let roster = [];
    await step(S, 'B2 角色图鉴 lists every character, one kind each; 按形象类型 filters (全部 / 像素 / 全动态 / Live2D / 图片 / VRM / 导入的)', async () => {
      await go('/characters');
      roster = await admin.evaluate(async () => (await window.petAdmin.state()).roster.map((r) => ({ id: r.id, kinds: r.packKinds.map((k) => `${k.label}${k.user ? `+导入${k.user}` : ''}`) })));
      const cards = await admin.$$eval('[data-roster] [data-row]', (els) => els.map((e) => e.getAttribute('data-row')));
      assert.deepEqual(cards, roster.map((r) => r.id), 'one card per character');
      assert.ok(cards.length >= 5, cards.join(','));
      const filter = (await admin.textContent('[data-kind-filter]')).trim();
      for (const k of ['全部', '像素', '全动态', 'Live2D', '图片', 'VRM', '导入的']) assert.ok(filter.includes(k), `${k} in ${filter}`);
      assert.ok(!filter.includes('有导入包'), filter);
      const out = [await shot('b2-characters-all')];
      const pick = async (label) => {
        await admin.locator('[data-kind-filter]').getByText(new RegExp(`^${label} \\d+$`)).click();
        await admin.waitForTimeout(300);
        return admin.$$eval('[data-roster] [data-row]', (els) => els.map((e) => e.getAttribute('data-row')));
      };
      // T-2764: every imported pack is a character of her own (not a pack hung under 格萝可 / 大肥鱼 …)
      const vrm = await pick('VRM');
      assert.deepEqual(vrm, [imported3.vrm]);
      out.push(await shot('b2-characters-vrm'));
      const l2dRows = await pick('Live2D');
      assert.deepEqual(l2dRows, ['dafeiyu-live2d', imported3.l2d]);
      const pics = await pick('图片');
      assert.deepEqual(pics, ['gemini-photo']);
      const imported = await pick('导入的');
      assert.deepEqual([...imported].sort(), [imported3.vrm, imported3.l2d, 'gemini-photo'].sort());
      out.push(await shot('b2-characters-imported'));
      await pick('全部');
      return `${cards.length} characters: ${roster.map((r) => `${r.id}[${r.kinds.join('/')}]`).join(' ')}; filter 「${filter}」; VRM→${vrm} Live2D→${l2dRows} 图片→${pics} 导入的→${imported.join(',')}; ${out.join(', ')}`;
    }, () => admin);

    await step(S, 'B3 角色详情 (格萝可, current): 装扮 (衣柜卡片 + 取景 + 角色包) / 好感 / 模型 / 个性化设定 / 语音 / 资料, one screenshot per tab', async () => {
      await go('/characters/grok-pixel');
      const out = [];
      for (const [t, sel] of [['装扮', '[data-pack="grok-pixel"]'], ['好感', '[data-road="grok-pixel"]'], ['模型', null], ['个性化设定', '[data-personality="grok-pixel"]'], ['语音', null], ['资料', null]]) {
        await tab(t);
        if (sel) await attached(sel);
        if (t === '装扮') { await attached('[data-outfits="grok-pixel"]'); await attached('[data-framing-row="grok-pixel"]'); }
        out.push(await shot(`b3-grok-${t}`));
      }
      const persona = await admin.textContent('[data-personality="grok-pixel"]').catch(() => '');
      await tab('个性化设定');
      const p2 = await admin.textContent('[data-personality="grok-pixel"]');
      assert.ok(p2.length > 20, 'her persona from the character file');
      await tab('资料');
      const kinds = await admin.evaluate(() => document.querySelector('[role="tabpanel"]').textContent);
      assert.match(kinds, /形象像素/);
      assert.match(kinds, /角色包格萝可 · 像素（内置）/);
      return `tabs: ${out.join(', ')}; 设定 starts 「${p2.slice(0, 30)}…」${persona ? '' : ''}`;
    }, () => admin);

    await step(S, 'B4 装扮 → 衣柜: a click in the settings window dresses her in the pet window at once (was only in the pet window\'s 衣柜)', async () => {
      const u = await call('unlockAll', 'grok-pixel');
      assert.equal(u.ok, true);
      await go('/characters/grok-pixel');
      await tab('装扮');
      const before = await page.getAttribute('#char-wrap', 'data-outfit');
      // T-2784: an outfit card that is unlocked and not worn offers 穿上 ([data-equip])
      await attached('[data-outfits="grok-pixel"] [data-equip]');
      const id = await admin.getAttribute('[data-outfits="grok-pixel"] [data-equip]', 'data-equip');
      assert.ok(id && id !== before, `${id} vs ${before}`);
      // the 关系升级 toast from 一键解锁 covers her: close it the way a user would, so the outfit shows
      if (await page.isVisible('#toast-close')) await page.evaluate(() => document.getElementById('toast-close').click());
      await page.waitForTimeout(400);
      const pBefore = await petShot('b4-pet-before');
      await admin.click(`[data-outfits="grok-pixel"] [data-equip="${id}"]`);
      await page.waitForFunction((w) => document.getElementById('char-wrap').dataset.outfit === w, id, { timeout: 8000 });
      await attached(`[data-outfit="${id}"][data-equipped="true"]`);
      await page.waitForTimeout(500);
      const pAfter = await petShot('b4-pet-after');
      const a = await shot('b4-grok-outfits-after');
      return `pet window #char-wrap data-outfit ${before} → ${id}; ${pBefore}, ${pAfter}, ${a}`;
    }, () => admin);

    await step(S, 'B5 桌宠行为: 宠物大小 slider → the pet window grows at once; 自己走动 switch saved; 找回桌宠 puts her back bottom-right', async () => {
      await go('/behavior');
      const out = [await shot('b5-behavior')];
      const b0 = await petBoundsNow();
      const s0 = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pet-scale').trim());
      out.push(await petShot('b5-pet-before'));
      const thumb = admin.locator('[data-key="petScale"] input[type="range"]').first();
      await thumb.focus();
      await admin.keyboard.press('Home');
      await page.waitForFunction(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')) === 0.5, null, { timeout: 8000 });
      const b1 = await petBoundsNow();
      assert.ok(b1.width < b0.width && b1.height < b0.height, `${JSON.stringify(b0)} → ${JSON.stringify(b1)}`);
      assert.equal(saved().petScale, 0.5);
      out.push(await petShot('b5-pet-after-50'));
      // a switch: 自己走动 off → settings.json and the pet window's copy at once
      await admin.click('[data-key="prefs.roam"]');
      await admin.waitForFunction(() => document.querySelector('[data-key="prefs.roam"]').getAttribute('aria-checked') === 'false', null, { timeout: 5000 });
      assert.equal(saved().prefs.roam, false);
      const petRoam = await page.evaluate(async () => (await window.pet.getSettings()).prefs.roam);
      assert.equal(petRoam, false);
      // 找回桌宠: she was dragged to the top-left corner
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('admin-ui')).setPosition(10, 10); });
      const moved = await petBoundsNow();
      await admin.click('[data-place-pet]');
      await page.waitForTimeout(500);
      const back = await petBoundsNow();
      const wa = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
      assert.equal(back.x, wa.x + wa.width - back.width - 24);
      assert.equal(back.y, wa.y + wa.height - back.height - 24);
      out.push(await shot('b5-behavior-after'));
      return `--pet-scale ${s0} → 0.5, window ${b0.width}×${b0.height} → ${b1.width}×${b1.height}; prefs.roam → false (file and pet window); 找回桌宠 (${moved.x},${moved.y}) → (${back.x},${back.y}) = work area bottom-right; ${out.join(', ')}`;
    }, () => admin);

    await step(S, 'B6 主动搭话与好感: page screenshot; 主动说话 off is saved and its thresholds grey out', async () => {
      await go('/proactive');
      const out = [await shot('b6-proactive')];
      await admin.click('[data-key="proactive.enabled"]');
      await admin.waitForFunction(() => document.querySelector('[data-key="proactive.enabled"]').getAttribute('aria-checked') === 'false', null, { timeout: 5000 });
      assert.equal(saved().proactive.enabled, false);
      out.push(await shot('b6-proactive-off'));
      return `proactive.enabled → ${saved().proactive.enabled}; ${out.join(', ')}`;
    }, () => admin);

    await step(S, 'B7 版本与更新: 自动检查更新 switch (new, was only PIXELPET_NO_UPDATE) saved at once', async () => {
      await go('/update');
      assert.equal(await admin.getAttribute('[data-key="update.autoCheck"]', 'aria-checked'), 'true');
      await admin.click('[data-key="update.autoCheck"]');
      await admin.waitForFunction(() => document.querySelector('[data-key="update.autoCheck"]').getAttribute('aria-checked') === 'false', null, { timeout: 5000 });
      assert.equal(saved().update.autoCheck, false);
      return `update.autoCheck → false in settings.json; ${await shot('b7-update')}`;
    }, () => admin);

    await step(S, 'B8 数据与关于: the data folder\'s path is shown and 打开数据目录 answers', async () => {
      await go('/about');
      const shown = (await admin.textContent('[data-data-dir]')).trim();
      assert.equal(shown, data);
      const r = await call('openDataFolder');
      assert.equal(r.ok, true);
      assert.equal(r.path, data);
      return `shows ${shown}; ${await shot('b8-about')}`;
    }, () => admin);

    let l2dId = null;
    await step(S, 'B9 大肥鱼 in her imported Live2D: 角色详情 → 装扮 → Live2D 模型大小 resizes the model in the pet window at once (was only in the pet window)', async () => {
      const sw = await call('switchCharacter', 'dafeiyu-pixel', '小鱼');
      assert.equal(sw.ok, true, JSON.stringify(sw));
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      const st = await admin.evaluate(async () => (await window.petAdmin.state()).packs.filter((p) => p.kind === 'live2d' && p.source === 'user').map((p) => p.id));
      l2dId = st[0];
      // T-2764: her imported Live2D model is a character of her own: become her (same 大肥鱼, no new agent)
      const ap = await call('switchCharacter', l2dId);
      assert.equal(ap.ok, true, JSON.stringify(ap));
      assert.equal(ap.created, false, 'the same girl as 大肥鱼 · 像素');
      await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.live2d'); return c && c.dataset.frame; }, null, { timeout: 30000 });
      await page.waitForTimeout(1500);
      const pBefore = await petShot('b9-pet-live2d-before');
      await go(`/characters/${l2dId}`);
      await tab('装扮');
      await attached(`[data-live2d-size="${l2dId}"]`);
      const thumb = admin.locator(`[data-live2d-size="${l2dId}"] input[type="range"]`).first();
      await thumb.focus();
      await admin.keyboard.press('Home'); // 30%
      const file = path.join(data, 'packs', l2dId, 'pack.json');
      for (let i = 0; i < 50 && JSON.parse(fs.readFileSync(file, 'utf8')).live2d.height !== 0.3; i++) await page.waitForTimeout(100);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).live2d.height, 0.3);
      await page.waitForTimeout(1500);
      const pAfter = await petShot('b9-pet-live2d-after');
      const a = await shot('b9-dafeiyu-looks');
      return `${l2dId} live2d.height → 0.3 in pack.json; ${pBefore}, ${pAfter}, ${a}`;
    }, () => admin);

    await step(S, 'B10 大肥鱼 / Claude (VRM) / Gemini (图片) detail pages: her kind and 角色包, and the 衣柜 note for one not met', async () => {
      const out = [];
      // one kind per character now (T-2764): her imported Live2D is its own character
      await go(`/characters/${l2dId}`);
      await tab('资料');
      assert.match(await admin.textContent('[role="tabpanel"]'), /形象Live2D角色包.+（导入）/);
      out.push(await shot('b10-dafeiyu-about'));
      await go('/characters/claude-pixel');
      await tab('装扮');
      out.push(await shot('b10-claude-looks-vrm'));
      // T-2784: a character whose base is not met yet has no wardrobe to show; one met shows her cards
      assert.match(await admin.textContent('[role="tabpanel"]'), /初次见面之后，可以在这里看她的服饰/);
      await go('/characters/gemini-photo');
      await tab('资料');
      assert.match(await admin.textContent('[role="tabpanel"]'), /形象图片角色包.+（导入）/);
      out.push(await shot('b10-gemini-about'));
      return out.join(', ');
    }, () => admin);

    await step(S, 'B12 every user-configurable schema field is rendered as a control on its page (DOM export), and the roster data is real', async () => {
      // fields that depend on a switch (dependsOn) only show while it is on: switch the parents on first
      for (const [k, v] of [['proactive.enabled', true], ['prefs.voice', true], ['asr.enabled', true], ['api.enabled', true], ['interject.enabled', true]]) assert.equal((await call('set', k, v)).ok, true, k);
      const boot = await admin.evaluate(() => window.petAdmin.boot());
      const fields = boot.schema.fields.filter((f) => !f.internal && f.page !== 'character');
      const pages = [...new Set(fields.map((f) => f.page))];
      const dom = {};
      const missing = [];
      for (const pg of pages) {
        await go(`/${pg}`);
        const want = fields.filter((f) => f.page === pg).map((f) => f.key);
        const got = await admin.evaluate(() => [...document.querySelectorAll('[data-key]')].map((el) => ({ key: el.getAttribute('data-key'), tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), checked: el.getAttribute('aria-checked'), label: (el.closest('[class*="item"], [class*="row"], div')?.textContent || '').trim().slice(0, 80) })));
        const keys = new Set(got.map((g) => g.key));
        for (const k of want) if (!keys.has(k)) missing.push(`${pg}:${k}`);
        dom[pg] = { schemaKeys: want, controls: got, restartKeys: boot.schema.fields.filter((f) => f.page === pg && f.restart).map((f) => f.key), restartBadge: await admin.evaluate(() => document.body.textContent.includes('重启后生效')) };
      }
      fs.writeFileSync(path.join(SHOTS, 'b12-admin-dom-fields.json'), JSON.stringify({ pages: dom, missing }, null, 2));
      const st = await admin.evaluate(() => window.petAdmin.state());
      const roster = st.roster.map((r) => ({ id: r.id, displayName: r.displayName, current: r.current, kind: r.kind, pack: r.pack && { id: r.pack.id, kind: r.pack.kind, source: r.pack.source }, packKinds: r.packKinds, met: r.met && { name: r.met.name, affection: r.met.affection, stage: r.met.stage }, model: r.model && { current: r.model.current, options: (r.model.options || []).length }, personality: (r.personality || '').slice(0, 60), systemRole: r.systemRole, outfits: r.outfits && r.outfits.map((o) => `${o.id}${o.equipped ? '*' : ''}${o.locked ? '(锁)' : ''}`) }));
      const packs = st.packs.map((p) => ({ id: p.id, species: p.species, kind: p.kind, source: p.source }));
      fs.writeFileSync(path.join(SHOTS, 'b12-roster-data.json'), JSON.stringify({ source: 'window.petAdmin.state() → main adminState() → core/roster.js buildRoster(PetService.view()) + packRows(PackStore: src/renderer/packs [builtin] + <data>/packs [user])', dataDir: data, userPacksOnDisk: fs.readdirSync(path.join(data, 'packs')), roster, packs }, null, 2));
      assert.deepEqual(missing, []);
      return `${fields.length} fields on ${pages.length} pages all rendered; b12-admin-dom-fields.json, b12-roster-data.json`;
    }, () => admin);

    await step(S, 'B11 no console errors in the settings window', async () => {
      const real = errors.filter((e) => !/favicon|DevTools/.test(e));
      assert.deepEqual(real, []);
      return 'none';
    }, () => admin);
  } finally {
    await app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- admin (配置后台)
// The settings window: opened from the ⋯ menu (and Ctrl+,) as a single instance, every page in light and
// dark, a setting changed there takes effect in the pet window and lands in settings.json, typed values are
// checked, keys are write-only, a restart-only item says so, and 角色列表 lists / switches characters.
// Free: fake lh, no paid scenario, no network.
// T-2751: on macOS the settings window has no native title bar (titleBarStyle 'hiddenInset'), so it only moves by a
// page area marked `-webkit-app-region: drag`. Linux has no hiddenInset, so the run reports darwin to the page
// (PIXELPET_E2E_PLATFORM, test mode only) and checks the strip: it is draggable, spans the top, nothing clickable
// sits under it on any page (also with her stage stuck while scrolling); with the real platform there is no strip.
async function titlebarScenario() {
  const S = 'titlebar';
  const SHOTS = path.join(OUT, 'titlebar');
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const ROUTES = ['/overview', '/characters', '/characters/grok', '/store', '/play', '/settings', '/tts', '/chat'];
  const open = async (platform) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-titlebar-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-titlebarfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, ...(platform ? { PIXELPET_E2E_PLATFORM: platform } : {}) });
    await page.waitForSelector('.char-card');
    await page.click('.char-card[data-species="grok"]');
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.evaluate(() => window.pet.openAdmin(''));
    let admin = null;
    for (let i = 0; i < 100 && !admin; i++) {
      admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
      if (!admin) await new Promise((r) => setTimeout(r, 100));
    }
    if (!admin) throw new Error('the settings window did not open');
    await admin.waitForSelector('[data-admin-page="overview"]', { timeout: 20000 });
    const go = async (route) => {
      await admin.evaluate((r) => { location.hash = r; }, route);
      await admin.waitForSelector(`[data-path="${route}"]`, { timeout: 10000 });
      await admin.waitForTimeout(250);
    };
    return { app, admin, go };
  };
  // everything a click lands on (not the visually hidden aria-hidden inputs behind custom switches), and whether its box reaches into the top `h` px of the window
  const underStrip = (admin, h) => admin.evaluate((hh) => [...document.querySelectorAll('a, button, input, textarea, select, [role="tab"], [role="switch"], [role="slider"], [role="combobox"], [data-pat], [tabindex]:not([tabindex="-1"])')]
    .filter((el) => { const r = el.getBoundingClientRect(); return !el.closest('[aria-hidden="true"]') && r.width > 0 && r.height > 0 && r.top < hh && r.bottom > 0 && getComputedStyle(el).visibility !== 'hidden'; })
    .map((el) => `${el.tagName.toLowerCase()}${el.dataset.rail ? `[rail=${el.dataset.rail}]` : ''}${el.dataset.back ? `[back=${el.dataset.back}]` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 12)}" top=${Math.round(el.getBoundingClientRect().top)}`), h);

  let run = null;
  try {
    run = await open('darwin');
    const { admin, go } = run;
    await step(S, 'T1 macOS: a drag strip spans the whole top of the settings window, over the traffic lights', async () => {
      const t = await admin.evaluate(() => {
        const el = document.querySelector('[data-titlebar]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { region: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'), top: r.top, left: r.left, width: r.width, height: r.height, vw: window.innerWidth, hits: [8, 200, window.innerWidth / 2, window.innerWidth - 8].map((x) => document.elementFromPoint(x, 16)?.hasAttribute('data-titlebar')), main: Math.round(document.querySelector('main').getBoundingClientRect().top) };
      });
      assert.ok(t, 'no [data-titlebar] in the darwin window');
      assert.equal(t.region, 'drag', `-webkit-app-region: ${t.region}`);
      assert.deepEqual([t.top, t.left, t.width, t.height], [0, 0, t.vw, 40]);
      assert.ok(t.main >= 40, `the page panel starts at ${t.main}, under the drag bar`);
      assert.deepEqual(t.hits, [true, true, true, true], 'the strip is what the pointer meets across the top (rail, page, right edge)');
      await admin.screenshot({ path: path.join(SHOTS, 'mac-overview.png') });
      return `app-region ${t.region}, ${t.width}×${t.height} at 0,0; topmost at x=8/200/mid/right; page panel top=${t.main}`;
    }, () => run.admin);

    await step(S, 'T2 macOS: on every page nothing clickable sits under the strip (back link, rail, tabs start below it)', async () => {
      const out = [];
      for (const r of ROUTES) {
        await go(r);
        const bad = await underStrip(admin, 40);
        assert.deepEqual(bad, [], `${r}: clickable under the drag strip`);
        const back = await admin.evaluate(() => { const b = document.querySelector('[data-back]'); return b ? Math.round(b.getBoundingClientRect().top) : null; });
        out.push(`${r}${back !== null ? ` (back top=${back})` : ''}`);
        await admin.screenshot({ path: path.join(SHOTS, `mac-${r.slice(1).replace(/\//g, '-')}.png`) });
      }
      return out.join(', ');
    }, () => run.admin);

    await step(S, 'T3 macOS: her page scrolled — the stage stays stuck below the strip, the strip stays on top', async () => {
      await go('/characters/grok');
      const r = await admin.evaluate(async () => {
        const m = document.querySelector('main');
        m.scrollTop = m.scrollHeight;
        await new Promise((res) => setTimeout(res, 300));
        const stage = document.querySelector('[data-stage]');
        return { scrolled: m.scrollTop, stageTop: stage ? Math.round(stage.getBoundingClientRect().top) : null, hit: document.elementFromPoint(window.innerWidth / 2, 16)?.hasAttribute('data-titlebar') };
      });
      assert.ok(r.scrolled > 0, 'her page did not scroll');
      assert.ok(r.stageTop === null || r.stageTop >= 40, `stage top ${r.stageTop} under the strip`);
      assert.equal(r.hit, true);
      await admin.screenshot({ path: path.join(SHOTS, 'mac-characters-grok-scrolled.png') });
      await admin.evaluate(() => { document.querySelector('main').scrollTop = 0; });
      return `scrollTop ${r.scrolled}, stage top ${r.stageTop}, strip still topmost`;
    }, () => run.admin);
    await run.app.close();
    run = null;

    run = await open(null);
    await step(S, `T4 ${process.platform} (native title bar): no drag strip, the page keeps its usual top padding`, async () => {
      const r = await run.admin.evaluate(() => ({ strip: document.querySelectorAll('[data-titlebar]').length, pad: getComputedStyle(document.querySelector('[data-admin-page]')).paddingTop, drag: [...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region') === 'drag').length }));
      assert.deepEqual(r, { strip: 0, pad: '24px', drag: 0 });
      await run.admin.screenshot({ path: path.join(SHOTS, `${process.platform}-overview.png`) });
      return `no strip, padding-top ${r.pad}, 0 drag regions`;
    }, () => run.admin);
  } finally {
    if (run) await run.app.close().catch(() => {});
  }
}

async function adminScenario() {
  const S = 'admin';
  const SHOTS = path.join(OUT, 'admin');
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-admin-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adminfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_TRAY: '1' });
  const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
  // the whole X display (pet window + settings window as two separate windows), when ffmpeg is there
  const desktop = (name) => {
    try {
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', process.env.PIXELPET_E2E_SCREEN || '1280x1024', '-i', process.env.DISPLAY, '-frames:v', '1', path.join(SHOTS, `${name}.png`)]);
      return `${name}.png`;
    } catch { return 'no desktop capture'; }
  };
  const adminPage = async () => {
    for (let i = 0; i < 100; i++) {
      const w = app.windows().find((p) => p.url().includes('admin-ui'));
      if (w) return w;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the settings window did not open');
  };
  let admin = null;
  const remote = [];
  const errors = [];
  const go = async (route) => {
    await admin.evaluate((r) => { location.hash = r; }, route);
    await admin.waitForSelector(`[data-path="${route}"]`, { timeout: 10000 });
    await admin.waitForTimeout(250);
  };
  const shot = (name) => admin.screenshot({ path: path.join(SHOTS, `${name}.png`) });
  const toast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('[data-sonner-toast], [role="status"], li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
  const petScaleCss = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--pet-scale').trim());
  const adminInfo = () => page.evaluate(() => window.pet.debugAdmin ? window.pet.debugAdmin() : null);
  try {
    await page.waitForSelector('.char-card');
    await page.click('.char-card[data-species="grok"]');
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });

    await step(S, 'A1 ⚙ 设置 opens the settings window (contextIsolation, only window.petAdmin); the pet window has no ⋯ menu', async () => {
      await hover(page);
      const items = await page.$$eval('#toolbar [data-act]:not(.hidden)', (els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent).trim()));
      assert.deepEqual(items, ['喂食', '玩耍', '睡觉', '聊天', '静音', '设置', '退出']); // + 跳舞, hidden on this pixel look (VRM only, T-2801)
      assert.equal(await page.$eval('#btn-dance', (b) => b.classList.contains('hidden')), true);
      assert.equal(await page.locator('#main-menu, [data-menu]').count(), 0, 'no ⋯ menu in the pet window');
      await page.screenshot({ path: path.join(SHOTS, 'pet-menu-settings.png') });
      await page.click('[data-act="settings"]');
      admin = await adminPage();
      admin.on('request', (r) => { if (!/^(file|data|blob|devtools|pack):/.test(r.url())) remote.push(r.url()); });
      admin.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      admin.on('pageerror', (e) => errors.push(String(e)));
      await admin.waitForSelector('[data-admin-page="overview"]', { timeout: 20000 });
      const iso = await admin.evaluate(() => ({ require: typeof window.require, process: typeof window.process, petAdmin: typeof window.petAdmin, pet: typeof window.pet, keys: Object.keys(window.petAdmin).length }));
      assert.deepEqual([iso.require, iso.process, iso.petAdmin, iso.pet], ['undefined', 'undefined', 'object', 'undefined']);
      const prefs = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('admin-ui')).map((w) => { const p = w.webContents.getLastWebPreferences(); return { contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration, sandbox: p.sandbox, title: w.getTitle() }; }));
      assert.equal(prefs.length, 1);
      assert.equal(prefs[0].contextIsolation, true);
      assert.equal(prefs[0].nodeIntegration, false);
      return `toolbar: ${items.join(' / ')}; window ${JSON.stringify(prefs[0])}; bridge has ${iso.keys} calls`;
    }, () => admin || page);

    await step(S, 'A2 single instance: tray → 打开设置…, ⚙ 设置 again and Ctrl+, all reuse the same window', async () => {
      const tray = await page.evaluate(() => window.pet.debugTray());
      assert.equal(tray.created, true, 'tray created');
      assert.deepEqual(tray.items, ['打开设置…', '显示桌宠', '检查更新', '退出']);
      const count = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('admin-ui')).map((w) => ({ title: w.getTitle(), url: w.webContents.getURL().replace(/^.*\/src\//, 'src/') })));
      const seen = [];
      await admin.evaluate(() => { location.hash = '/about'; });
      assert.equal(await page.evaluate(() => window.pet.debugTrayClick('打开设置…')), true);
      await page.waitForTimeout(400);
      seen.push(['tray', (await count()).length]);
      await page.bringToFront();
      await clickAct(page, 'settings');
      await page.waitForTimeout(400);
      seen.push(['⚙ 设置', (await count()).length]);
      await page.focus('body');
      await page.keyboard.press('Control+Comma');
      await page.waitForTimeout(500);
      const wins = await count();
      seen.push(['Ctrl+,', wins.length]);
      const info = await page.evaluate(() => window.pet.debugAdmin());
      assert.deepEqual(seen.map((x) => x[1]), [1, 1, 1]);
      assert.equal(info.opened, 1, 'created once');
      const shot = desktop('a2-desktop-two-windows');
      return `tray items ${tray.items.join(' / ')}; settings windows after ${seen.map((x) => `${x[0]}=${x[1]}`).join(', ')}; created ${info.opened} time(s); ${JSON.stringify(wins[0])}; total windows ${info.windows}; desktop: ${shot}`;
    }, () => admin);

    // every page, light and dark (theme pinned through 外观主题 = ui.theme, which the console applies itself)
    const ROUTES = ['/overview', '/characters', '/characters/grok-pixel', '/store', '/play', '/settings', '/packs', '/visitors', '/behavior', '/proactive', '/appearance', '/tts', '/asr', '/voicepacks', '/connection', '/api', '/safety', '/update', '/about'];
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')); w.setSize(1180, 1000); });
    for (const theme of ['light', 'dark']) {
      await step(S, `A3 ${theme}: all ${ROUTES.length} pages render (rail with 6 places, hubs, her stage, form cards), data-theme=${theme}`, async () => {
        await admin.evaluate((t) => window.petAdmin.set('ui.theme', t), theme);
        await admin.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
        const out = [];
        for (const r of ROUTES) {
          await go(r);
          const f = await admin.evaluate(() => ({ groups: document.querySelectorAll('form [class*="group"], form > div > div').length, nav: document.querySelectorAll('nav a').length, bg: getComputedStyle(document.body).backgroundColor }));
          // one image per whole page: grow the window to the page's height, capture, shrink back
          const h = await admin.evaluate(() => { const el = document.querySelector('[data-admin-page]'); return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 48); });
          await app.evaluate(({ BrowserWindow }, hh) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, Math.min(Math.max(hh, 1000), 4000)); }, h);
          await admin.waitForTimeout(300);
          await shot(`${theme}-${r.slice(1).replace(/\//g, '-')}`);
          await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, 1000); });
          out.push(`${r}`);
          assert.equal(f.nav, 6, `rail links ${f.nav}: 小屋 / 角色 / 商店 / 玩法 / 设置 / 聊天, not every page`);
        }
        return `${out.length} pages · rail of 6 · data-theme=${theme}`;
      }, () => admin);
    }
    await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));

    await step(S, 'A3b depth: the rail holds 6 places (4 + 商店 + 聊天); 设置 → a tile → its page → back up; 角色 → a card → her page', async () => {
      await go('/overview');
      const rail = await admin.$$eval('nav a[data-rail]', (as) => as.map((a) => a.textContent.trim()));
      assert.deepEqual(rail, ['小屋', '角色', '商店', '玩法', '设置', '聊天']);
      await admin.click('[data-rail="settings"]');
      await admin.waitForSelector('[data-path="/settings"]');
      const tiles = await admin.$$eval('[data-tile]', (ts) => ts.map((t) => t.dataset.tile));
      await admin.click('[data-tile="tts"]');
      await admin.waitForSelector('[data-path="/tts"]');
      assert.equal(await admin.getAttribute('[data-rail="settings"]', 'aria-current'), 'page', 'a page below 设置 keeps 设置 lit');
      await admin.click('[data-back="settings"]');
      await admin.waitForSelector('[data-path="/settings"]');
      await admin.click('[data-rail="play"]');
      await admin.waitForSelector('[data-path="/play"]');
      const play = await admin.$$eval('[data-tile]', (ts) => ts.map((t) => t.dataset.tile));
      await admin.waitForSelector('[data-pet-status] [data-stat="mood"]');
      await shot('a3b-play-hub');
      await admin.click('[data-rail="characters"]');
      await admin.waitForSelector('[data-path="/characters"]');
      await admin.click('[data-row="gemini-pixel"] a[href="#/characters/gemini-pixel"]');
      await admin.waitForSelector('[data-character-title="gemini-pixel"]');
      await admin.click('[data-back="characters"]');
      await admin.waitForSelector('[data-path="/characters"]');
      return `rail ${rail.join(' / ')}; 设置 tiles ${tiles.join(',')}; 玩法 tiles ${play.join(',')}; card → /characters/gemini → back`;
    }, () => admin);

    await step(S, 'A3c her stage: a tap sends hearts up, she answers, and the pet on the desktop plays happy too', async () => {
      await go('/overview');
      await page.evaluate(() => window.petFx.cue('idle'));
      await admin.click('[data-pat="grok-pixel"]');
      await admin.waitForSelector('[data-reaction]');
      const line = await admin.textContent('[data-reaction]');
      const hearts = await admin.$$eval('[data-stage="grok-pixel"] svg', (s) => s.length);
      await shot('a3c-pat');
      await page.waitForFunction(() => window.petFx.state().lastCue === 'happy', null, { timeout: 5000 });
      await admin.click('[data-action-chip="sleep"]');
      assert.equal(await admin.getAttribute('[data-stage="grok-pixel"] [data-action]', 'data-action'), 'sleep');
      const bad = await admin.evaluate(() => window.petAdmin.cue('rm -rf'));
      assert.equal(bad.ok, false);
      return `reaction "${line.trim()}", ${hearts} hearts; pet window lastCue=happy; action chip → sleep; bad cue refused (${bad.reason})`;
    }, () => admin);

    await step(S, 'A4 桌宠行为 → 宠物大小: the slider in the settings window resizes the pet window and is saved', async () => {
      await go('/behavior');
      const before = { css: await petScaleCss(), width: await page.evaluate(() => window.innerWidth) };
      const thumb = admin.locator('[data-key="petScale"] input[type="range"]').first();
      await thumb.focus();
      for (let i = 0; i < 4; i++) await admin.keyboard.press('ArrowRight');
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--pet-scale').trim() === '1.45', null, { timeout: 8000 });
      const after = { css: await petScaleCss(), width: await page.evaluate(() => window.innerWidth) };
      assert.equal(saved().petScale, 1.45);
      assert.ok(after.width > before.width, `pet window ${before.width} → ${after.width}`);
      await shot('a4-behavior-scale');
      await page.screenshot({ path: path.join(SHOTS, 'pet-after-scale.png') });
      return `pet --pet-scale ${before.css} → ${after.css}; pet window width ${before.width} → ${after.width}px; settings.json petScale=${saved().petScale}`;
    }, () => admin);

    await step(S, 'A5 桌宠行为 switches apply at once: 梗图 off → settings.json + the pet window\'s settings', async () => {
      await admin.click('[data-key="prefs.memes"]');
      await toast(/已保存：梗图/);
      const pet = await page.evaluate(async () => (await window.pet.getSettings()).prefs.memes);
      assert.equal(saved().prefs.memes, false);
      assert.equal(pet, false);
      await shot('a5-behavior-memes-off');
      return 'prefs.memes: settings.json false, pet window false, toast 已保存：梗图';
    }, () => admin);

    await step(S, 'A6 主动行为与好感度: out-of-range number is refused in the form; a valid one is saved and applied', async () => {
      await go('/proactive');
      const input = admin.locator('input[data-key="proactive.speakCooldownMin"], [data-key="proactive.speakCooldownMin"] input').first();
      await input.fill('999');
      await admin.waitForSelector('[data-error="proactive.speakCooldownMin"]');
      const err = await admin.textContent('[data-error="proactive.speakCooldownMin"]');
      assert.equal(await admin.isDisabled('[data-save="proactive.speakCooldownMin"]'), true);
      await shot('a6-proactive-invalid');
      await input.fill('20');
      await admin.click('[data-save="proactive.speakCooldownMin"]');
      await toast(/已保存：主动说话间隔/);
      assert.equal(saved().proactive.speakCooldownMin, 20);
      await admin.click('[data-key="proactive.enabled"]');
      await toast(/已保存：主动说话/);
      assert.equal(saved().proactive.enabled, false);
      const pet = await page.evaluate(async () => (await window.pet.getSettings()).proactive);
      assert.equal(pet.enabled, false);
      await admin.waitForSelector('[data-key="proactive.speakCooldownMin"]', { state: 'detached' }); // folded away with its master switch
      await shot('a6-proactive-saved');
      return `999 → "${err.trim()}"; 20 saved; 主动说话 off (dependent fields folded); pet settings proactive=${JSON.stringify(pet)}`;
    }, () => admin);

    await step(S, 'A7 朗读: a bad endpoint is refused by main with its reason; an API key is write-only (masked, never echoed, not in settings.json)', async () => {
      await go('/tts');
      await admin.fill('[data-key="tts.endpoints.fish"]', 'http://fish.example.com');
      await admin.click('[data-save="tts.endpoints.fish"]');
      await admin.waitForSelector('[data-error="tts.endpoints.fish"]');
      const err = await admin.textContent('[data-error="tts.endpoints.fish"]');
      assert.match(err, /https/);
      assert.equal(saved().tts.endpoints.fish, '');
      const key = 'fk_test_0123456789abcdef';
      await admin.fill('[data-key="keys.fish"]', key);
      assert.equal(await admin.getAttribute('[data-key="keys.fish"]', 'type'), 'password');
      await admin.click('[data-save="keys.fish"]');
      await admin.waitForFunction(() => document.querySelector('[data-has-key="keys.fish"]').textContent.includes('已设置'));
      assert.equal(await admin.inputValue('[data-key="keys.fish"]'), '', 'never filled back');
      assert.ok(!fs.readFileSync(path.join(data, 'settings.json'), 'utf8').includes(key), 'not in settings.json');
      assert.ok(fs.existsSync(path.join(data, 'tts-keys.json')));
      const bridge = await admin.evaluate(async (k) => JSON.stringify(await window.petAdmin.state()).includes(k), key);
      assert.equal(bridge, false, 'the key never comes back over IPC');
      await shot('a7-tts-key-set');
      return `endpoint refused: "${err.trim()}"; key → 已设置, input empty, absent from settings.json and admin state`;
    }, () => admin);

    await step(S, 'A8 对外接口: switching it on generates a token that is shown masked', async () => {
      await go('/api');
      await admin.click('[data-key="api.enabled"]');
      await toast(/已保存：开启对外接口/);
      await admin.waitForSelector('[data-key="api.token"][data-masked="true"]');
      const shown = await admin.textContent('[data-key="api.token"]');
      const token = saved().api.token;
      assert.ok(token.length >= 24);
      assert.ok(!shown.includes(token.slice(0, 8)) && shown.includes('•') && shown.endsWith(token.slice(-4)), shown);
      await shot('a8-api-token-masked');
      return `token masked as ${shown.slice(0, 6)}…${shown.slice(-4)} (${token.length} chars in settings.json)`;
    }, () => admin);

    await step(S, 'A9 数据与关于 → 硬件加速 (restart item): saved, tagged 重启后生效, banner offers 立即重启', async () => {
      await go('/about');
      await admin.click('[data-key="system.hardwareAcceleration"]');
      await admin.waitForSelector('[data-restart-banner]');
      const banner = await admin.textContent('[data-restart-banner]');
      assert.match(banner, /硬件加速：重启应用后生效/);
      assert.equal(saved().system.hardwareAcceleration, false);
      await shot('a9-restart-banner');
      await admin.click('[data-reset="system.hardwareAcceleration"]');
      await admin.waitForSelector('[data-restart-banner]', { state: 'detached' });
      return `banner: "${banner.trim()}"; 恢复默认 removes it`;
    }, () => admin);

    await step(S, 'A10 恢复本页默认 on 桌宠行为 puts petScale / memes back', async () => {
      await go('/behavior');
      await admin.click('[data-reset-page="behavior"]');
      await admin.getByRole('dialog').getByRole('button', { name: '恢复默认' }).click();
      await toast(/已恢复 \d+ 项默认设置/);
      assert.equal(saved().prefs.memes, true);
      assert.equal(saved().petScale, 1.25);
      await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--pet-scale').trim() === '1.25');
      return 'memes on, petScale 1.25 again (pet window too)';
    }, () => admin);

    await step(S, 'A11 角色图鉴: every character with preview, name, type, source, voice pack and the current mark', async () => {
      await go('/characters');
      await admin.waitForSelector('[data-roster] [data-row]');
      const rows = await admin.$$eval('[data-roster] [data-row]', (cards) => cards.map((el) => ({ id: el.dataset.row, text: el.innerText.replace(/\s+/g, ' ').trim(), preview: el.querySelector('[data-preview]') && el.querySelector('[data-preview]').dataset.preview })));
      // T-2764: one card per character (every look), base by base
      assert.deepEqual(rows.map((r) => r.id), ['dafeiyu-pixel', 'dafeiyu-live2d', 'dafeiyu-live', 'dafeiyu-classic', 'dafeiyu-clips', 'claude-pixel', 'claude-classic', 'grok-pixel', 'grok-classic', 'gemini-pixel', 'gemini-classic', 'gpt-pixel', 'gpt-classic']);
      const grok = rows.find((r) => r.id === 'grok-pixel');
      assert.match(grok.text, /当前角色/);
      assert.match(grok.text, /像素/);
      assert.match(grok.text, /内置/);
      assert.ok(rows.every((r) => r.preview && r.preview !== 'none'), JSON.stringify(rows.map((r) => r.preview)));
      const sprites = await admin.$$eval('[data-roster] canvas[role="img"]', (cs) => cs.filter((c) => c.width > 0 && c.height > 0).length);
      assert.ok(sprites >= 4, `sprite first frames drawn: ${sprites}`);
      const voice = rows.filter((r) => /句/.test(r.text)).map((r) => r.id);
      await shot('a11-characters');
      return `rows ${rows.length}; grok: ${grok.text.slice(0, 80)}; previews ${rows.map((r) => r.preview).join('/')}; voice packs: ${voice.join(',')}`;
    }, () => admin);

    await step(S, 'A12 初次见面 / 切换 from the list: Claude gets a name and becomes the pet in the pet window', async () => {
      await admin.click('[data-switch="claude-pixel"]');
      await admin.fill('[data-meet-name]', '小克');
      await admin.getByRole('dialog').getByRole('button', { name: '初次见面' }).click();
      await admin.waitForSelector('[data-current="claude-pixel"]', { timeout: 30000 });
      await page.waitForFunction(() => (document.getElementById('pet-look').dataset.key || '').startsWith('claude-'), null, { timeout: 15000 });
      const key = await page.getAttribute('#pet-look', 'data-key');
      await shot('a12-switched');
      await admin.click('[data-switch="grok-pixel"]');
      await admin.waitForSelector('[data-current="grok-pixel"]', { timeout: 30000 });
      await page.waitForFunction(() => (document.getElementById('pet-look').dataset.key || '').startsWith('grok-'), null, { timeout: 15000 });
      return `pet window look → ${key}; switched back to grok`;
    }, () => admin);

    // her stage on the character page (the showcase on the left): what it shows, and once it is really drawn
    const stageOf = (id) => admin.evaluate((cid) => {
      const el = document.querySelector(`[data-showcase="${cid}"] [data-stage] [data-preview]`);
      return el ? { type: el.dataset.preview, src: el.dataset.src || null, drawn: el.dataset.drawn || null, failed: !!el.dataset.failed } : null;
    }, id);
    const stageDrawn = (id, notSrc) => admin.waitForFunction(([cid, prev]) => {
      const el = document.querySelector(`[data-showcase="${cid}"] [data-stage] [data-preview]`);
      return el && !el.dataset.failed && el.dataset.src && el.dataset.drawn === el.dataset.src && el.dataset.src !== prev;
    }, [id, notSrc || null], { timeout: 15000 }).catch(async (e) => { const diag = await admin.evaluate(async (cid) => { const st = await window.petAdmin.state(); const r = st.roster.find((x) => x.id === cid); return { pushes: window.__pushes || null, main: r && r.preview && r.preview.url, trying: !!document.querySelector('[data-trying-tag]'), caption: (document.querySelector(`[data-worn-caption="${cid}"]`) || {}).textContent, worn: [...document.querySelectorAll(`[data-outfits="${cid}"] [data-equipped="true"]`)].map((x) => x.dataset.outfit) }; }, id); throw new Error(`stage of ${id} not drawn (not ${notSrc}): ${JSON.stringify(await stageOf(id))} ${JSON.stringify(diag)} — ${e.message.split('\n')[0]}`); });
    const showcaseShot = (id, name) => admin.locator(`[data-showcase="${id}"]`).screenshot({ path: path.join(SHOTS, `${name}.png`) });

    await step(S, 'A12b 角色详情: two columns — her stage pinned on the left (scales with the window), story and settings on the right', async () => {
      await go('/characters/grok-pixel');
      await admin.waitForSelector('[data-showcase="grok-pixel"]');
      await stageDrawn('grok-pixel');
      const box = () => admin.evaluate(() => {
        const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }; };
        return { show: r('[data-showcase]'), panels: r('[data-detail-layout] > div:last-child'), stage: r('[data-showcase] [data-stage]'), title: r('[data-character-title]') };
      });
      const a = await box();
      assert.ok(a.show.right <= a.panels.x, `stage column ${JSON.stringify(a.show)} left of the panels ${JSON.stringify(a.panels)}`);
      assert.ok(a.title.x >= a.panels.x, 'her name heads the right column');
      for (const sel of ['[data-pack="grok-pixel"]', '[data-outfits="grok-pixel"]']) assert.equal(await admin.locator(sel).count(), 1, `${sel} on the right`);
      assert.ok(await admin.evaluate(() => { const p = document.querySelector('[data-detail-layout] > div:last-child'); return !!p.querySelector('[role="tablist"]') && !!p.querySelector('[data-character-title]'); }), 'tabs + info in the right column');
      // the whole page, full size
      const h = await admin.evaluate(() => { const el = document.querySelector('[data-admin-page]'); return Math.ceil(el.getBoundingClientRect().top + el.scrollHeight + 48); });
      await app.evaluate(({ BrowserWindow }, hh) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, Math.min(Math.max(hh, 1000), 4000)); }, h);
      await admin.waitForTimeout(400);
      await shot('a12b-detail-two-columns-full');
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, 1000); });
      await admin.waitForTimeout(400);
      // pinned: scrolling the page moves the panels, not her (a short window, so the page has room to scroll)
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, 700); });
      await admin.waitForTimeout(400);
      // from the top: an earlier step may have left the page scrolled
      await admin.evaluate(() => { document.querySelector('main').scrollTop = 0; });
      await admin.waitForTimeout(200);
      const top = await box();
      const scrolled = await admin.evaluate(() => { const m = document.querySelector('main'); m.scrollTop = m.scrollHeight; return m.scrollTop; });
      await admin.waitForTimeout(300);
      const b = await box();
      assert.ok(scrolled >= 300, `the page scrolls (${scrolled}px)`);
      assert.ok(Math.abs(top.panels.y - scrolled - b.panels.y) <= 2, `panels scrolled with the page ${top.panels.y} → ${b.panels.y}`);
      assert.ok(b.show.y >= 0 && b.show.y <= 40 && b.show.y + b.stage.h <= 700, `stage stays in view at the top: y=${b.show.y} h=${b.stage.h}`);
      await shot('a12b-detail-scrolled-stage-pinned');
      await admin.evaluate(() => { document.querySelector('main').scrollTop = 0; });
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, 1000); });
      await admin.waitForTimeout(400);
      // scales with the window: a short window gives a shorter stage, a narrow one stacks the columns
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, 640); });
      await admin.waitForTimeout(500);
      const c = await box();
      await shot('a12b-detail-short-window');
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(820, 1000); });
      await admin.waitForTimeout(500);
      const d = await box();
      await shot('a12b-detail-narrow-window');
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')).setContentSize(1180, 1000); });
      await admin.waitForTimeout(500);
      assert.ok(c.stage.h < a.stage.h, `stage ${a.stage.h}px in 1180×1000 → ${c.stage.h}px in 1180×640`);
      assert.ok(d.panels.y > d.show.y + d.show.h - 1, `narrow: panels below the stage (${JSON.stringify(d)})`);
      await stageDrawn('grok-pixel');
      return `1180×1000: stage column x=${a.show.x} w=${a.show.w}, panels x=${a.panels.x} w=${a.panels.w}, stage ${a.stage.h}px; 1180×700 scrolled ${scrolled}px: panels y ${top.panels.y}→${b.panels.y}, stage y ${top.show.y}→${b.show.y}; 1180×640: stage ${c.stage.h}px; 820 wide: stacked (panels y=${d.panels.y} below stage bottom ${d.show.y + d.show.h})`;
    }, () => admin);

    await step(S, 'A12c 衣柜: two outfits put on from the right panel show on her stage at once (and in the pet window)', async () => {
      await go('/characters/grok-pixel');
      await admin.getByRole('tab', { name: '装扮' }).click();
      const un = await admin.evaluate(() => window.petAdmin.unlockAll('grok-pixel'));
      assert.equal(un.ok, true);
      await admin.waitForSelector('[data-outfits="grok-pixel"] [data-equip="swimsuit"]');
      await admin.waitForSelector('[data-outfits="grok-pixel"] [data-equip="pajamas"]');
      await stageDrawn('grok-pixel');
      const s0 = await stageOf('grok-pixel');
      const caption0 = await admin.textContent('[data-worn-caption="grok-pixel"]');
      await showcaseShot('grok-pixel', 'a12c-stage-0-daily');
      const out = [`daily: ${s0.src.split('/').slice(-2).join('/')}`];
      let prev = s0.src;
      let i = 0;
      for (const id of ['swimsuit', 'pajamas']) {
        const t0 = Date.now();
        await admin.click(`[data-outfits="grok-pixel"] [data-equip="${id}"]`);
        await stageDrawn('grok-pixel', prev);
        const ms = Date.now() - t0;
        const st = await stageOf('grok-pixel');
        assert.notEqual(st.src, prev, `${id}: stage source changed`);
        assert.match(st.src, new RegExp(id), `${id}: the stage draws the ${id} sheet (${st.src})`);
        assert.equal(await admin.getAttribute(`[data-outfit="${id}"]`, 'data-equipped'), 'true');
        await page.waitForFunction((o) => (document.getElementById('pet-look').dataset.key || '').includes(o), id, { timeout: 10000 });
        const caption = await admin.textContent('[data-worn-caption="grok-pixel"]');
        await showcaseShot('grok-pixel', `a12c-stage-${++i}-${id}`);
        out.push(`${id}: ${st.src.split('/').slice(-2).join('/')} drawn ${ms}ms after the click; caption "${caption.trim()}"; pet #pet-look ${await page.getAttribute('#pet-look', 'data-key')}`);
        prev = st.src;
      }
      await shot('a12c-detail-after-outfits');
      // back to her daily outfit (the rest of the run expects it)
      await admin.click('[data-outfits="grok-pixel"] [data-equip="daily"]');
      await stageDrawn('grok-pixel', prev);
      return `caption before "${caption0.trim()}"; ${out.join(' | ')}`;
    }, () => admin);

    // T-2764: 旧版像素 is a character of her own (「格萝可 · 旧版像素」): her page shows her on the stage, 切换 makes her
    // the companion (same agent / affection as 格萝可 · 像素) and the pet window follows; back and forth.
    const petJson = () => JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
    const becomeOn = async (id) => {
      await go(`/characters/${id}`);
      await admin.waitForSelector(`[data-character-title="${id}"]`);
      await admin.locator(`[data-switch="${id}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await admin.click(`[data-switch="${id}"]`);
      await page.waitForFunction((x) => (document.getElementById('pet-look').dataset.key || '').startsWith(`${x}/`), id, { timeout: 10000 });
      for (let k = 0; k < 40 && petJson().characterId !== id; k++) await admin.waitForTimeout(200);
      assert.equal(petJson().characterId, id, `${id} saved as the current character`);
    };
    await step(S, 'A13 「格萝可 · 旧版像素」 is a character of her own: her page draws her on the stage, 切换 makes her the pet (same girl), and back', async () => {
      await go('/characters/grok-classic');
      await admin.waitForSelector('[data-character-title="grok-classic"]');
      await stageDrawn('grok-classic');
      const classic = await stageOf('grok-classic');
      assert.match(classic.src, /grok-classic/, `her stage draws her own pack: ${classic.src}`);
      assert.match(await admin.textContent('[data-character-title="grok-classic"]'), /格萝可 · 旧版像素/);
      await shot('a13-detail-classic');
      await showcaseShot('grok-classic', 'a13-stage-0-classic');
      const agent = petJson().characters.grok.agentId;
      await becomeOn('grok-classic');
      assert.equal(petJson().characters.grok.agentId, agent, 'same agent: the same girl in another look');
      await page.screenshot({ path: path.join(SHOTS, 'pet-after-look.png') });
      await becomeOn('grok-pixel');
      await stageDrawn('grok-pixel');
      const back = await stageOf('grok-pixel');
      assert.match(back.src, /grok-pixel/);
      await showcaseShot('grok-pixel', 'a13-stage-1-pixel-again');
      await becomeOn('grok-classic');
      await shot('a13-detail-look');
      return `grok-classic stage ${classic.src.split('/').slice(-3).join('/')}; 切换 → pet window ${await page.getAttribute('#pet-look', 'data-key')}; pet.json characterId=${petJson().characterId}; agent unchanged`;
    }, () => admin);

    await step(S, 'A13b every official all-ages character (5 built-in + the downloaded ones) draws on her own stage (像素 / 旧版 / 全动态 / Live2D / 原版动画), none blank or broken', async () => {
      // only the pixel five ship; the e2e run counts catalog/ as downloaded (PIXELPET_CATALOG_PREINSTALLED)
      const chars = await admin.evaluate(async () => (await window.petAdmin.state()).view.characters.filter((c) => (c.source === 'builtin' || c.source === 'download') && !c.adult).map((c) => ({ id: c.id, kind: c.kind, pack: c.pack && c.pack.id })));
      const rows = [];
      const kinds = new Set();
      for (const c of chars) {
        await go(`/characters/${c.id}`);
        await admin.waitForSelector(`[data-showcase="${c.id}"]`);
        await stageDrawn(c.id);
        const st = await stageOf(c.id);
        assert.ok(st && st.type !== 'none' && !st.failed && st.drawn, `${c.id} (${c.kind}): ${JSON.stringify(st)}`);
        await admin.getByRole('tab', { name: '装扮' }).click();
        // T-2784: 试穿 is one of her outfit cards (a character with no picture per outfit has nothing to try)
        // a character whose base is not met yet shows a note instead of cards
        await admin.waitForSelector(`[data-outfits="${c.id}"] [data-outfit], [data-outfits-empty="${c.id}"]`);
        const tryId = await admin.evaluate((cid) => { const b = document.querySelector(`[data-outfits="${cid}"] [data-try-outfit]:not([disabled])`); return b ? b.dataset.tryOutfit : null; }, c.id);
        let tr = null;
        if (tryId) {
          await admin.click(`[data-try-outfit="${tryId}"]`);
          await admin.waitForSelector('[data-trying-tag]');
          await stageDrawn(c.id);
          tr = await stageOf(c.id);
          assert.ok(tr && tr.type !== 'none' && !tr.failed, `${c.id} trying ${tryId}: ${JSON.stringify(tr)}`);
        }
        if (!kinds.has(c.kind)) {
          kinds.add(c.kind);
          await showcaseShot(c.id, `a13b-stage-${c.kind}-${c.id}`);
        }
        if (tryId) {
          await admin.click(`[data-try-outfit="${tryId}"]`);
          await admin.waitForSelector('[data-trying-tag]', { state: 'detached' });
        }
        rows.push(`${c.id}[${c.kind}] stage→${st.type} tried ${tryId || '—'}→${tr ? tr.type : '—'}`);
      }
      assert.ok(['sprites', 'rig', 'live2d', 'video'].every((k) => kinds.has(k)), [...kinds].join(','));
      assert.equal(chars.length, 13, '13 all-ages official characters (5 built-in, 8 downloaded)');
      return `${rows.length} characters drawn, kinds ${[...kinds].join('/')}: ${rows.join(', ')}`;
    }, () => admin);

    await step(S, 'A14 角色包 (导入角色): an imported pack shows up (broadcast) and is deleted from the settings window after a confirmation', async () => {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adminpack-'));
      const base = path.join(ROOT, 'src', 'renderer', 'packs', 'grok-pixel');
      const m = JSON.parse(fs.readFileSync(path.join(base, 'pack.json'), 'utf8'));
      fs.mkdirSync(path.join(src, 'sheets'));
      const mine = `sheets/mine${path.extname(m.outfits.daily)}`;
      fs.copyFileSync(path.join(base, m.outfits.daily), path.join(src, mine));
      fs.writeFileSync(path.join(src, 'pack.json'), JSON.stringify({ ...m, id: 'my-grok', name: '我的格萝可', author: 'tester', outfits: { daily: mine } }));
      await go('/packs');
      const r = await page.evaluate((d) => window.pet.debugImportPack(d), src);
      assert.equal(r.ok, true);
      await admin.waitForSelector('[data-remove-pack="my-grok"]');
      await shot('a14-packs-imported');
      await admin.click('[data-remove-pack="my-grok"]');
      await admin.getByRole('dialog').getByRole('button', { name: '删除角色' }).click();
      await admin.waitForSelector('[data-remove-pack="my-grok"]', { state: 'detached' });
      assert.ok(!fs.existsSync(path.join(data, 'packs', 'my-grok')));
      return 'my-grok listed after import, removed (folder gone)';
    }, () => admin);

    await step(S, 'A15 a right click on her brings the same settings window forward (no menu, no second window)', async () => {
      await admin.evaluate(() => { location.hash = '/characters/grok-pixel'; });
      await page.bringToFront();
      await hover(page);
      // ⚙ / a right click go to what is new (an update, an unlocked outfit or topic), else keep the window's page
      const news = await page.getAttribute('#btn-settings', 'data-news');
      const want = { update: '/update', outfit: '/characters/grok-pixel', topic: '/topics' }[news] || '/characters/grok-pixel';
      const box = await page.evaluate(() => { const el = [...document.querySelectorAll('.pet-hit')].find((e) => !e.classList.contains('hidden')); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * 0.6 }; });
      await page.mouse.click(box.x, box.y, { button: 'right' });
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#model-select, #role-input, #main-menu, #panel').count(), 0, 'no form, menu or panel in the pet window');
      const info = await page.evaluate(() => window.pet.debugAdmin());
      assert.equal(info.opened, 1);
      await adminUntil(admin, (p) => !!document.querySelector(`[data-path="${p}"]`), want, 15000, want);
      await page.screenshot({ path: path.join(SHOTS, 'pet-char-page-jump.png') });
      return `right click (news: ${news || 'none'}) → admin ${await admin.evaluate(() => location.hash)} (created ${info.opened} time)`;
    }, () => admin);

    await step(S, 'A16 offline: no remote requests and no console errors in the settings window', async () => {
      assert.deepEqual(remote, []);
      assert.deepEqual(errors, []);
      return 'remote 0, console errors 0';
    });

    await step(S, 'A17 persisted across a restart: values read back from settings.json; 硬件加速 off takes effect only after the restart', async () => {
      assert.equal((await admin.evaluate(() => window.petAdmin.set('system.hardwareAcceleration', false))).ok, true);
      const before = await app.evaluate(({ app: a }) => a.isHardwareAccelerationEnabled());
      await app.close();
      const again = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
      try {
        await again.page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 20000 });
        const after = await again.app.evaluate(({ app: a }) => a.isHardwareAccelerationEnabled());
        const a2 = await openAdminWindow(again.app, again.page, 'proactive');
        const st = await a2.evaluate(async () => (await window.petAdmin.state()).settings);
        assert.equal(await a2.inputValue('[data-key="proactive.speakCooldownMin"] input').catch(() => null), null, 'folded: 主动说话 is still off');
        assert.equal(st.proactive.enabled, false);
        assert.equal(st.proactive.speakCooldownMin, 20);
        assert.equal(st.appearance, undefined, 'no 形象包 choice (T-2764)');
        assert.equal((await a2.evaluate(async () => (await window.petAdmin.state()).view.pet.characterId)), 'grok-classic', 'she is still 「格萝可 · 旧版像素」');
        assert.equal(st.system.hardwareAcceleration, false);
        assert.deepEqual(st.pendingRestart, [], 'applied by the restart');
        assert.equal(before, true);
        assert.equal(after, false);
        await a2.evaluate(() => { location.hash = '/about'; });
        await a2.waitForSelector('[data-path="/about"]');
        await a2.screenshot({ path: path.join(SHOTS, 'a17-after-restart-about.png') });
        // the file itself, as written by core/settings.js (SettingsStore) — evidence of what was saved
        fs.writeFileSync(path.join(SHOTS, 'settings-after-restart.json'), fs.readFileSync(path.join(data, 'settings.json')));
        await a2.evaluate(() => window.petAdmin.set('system.hardwareAcceleration', true));
        return `after restart: proactive=${JSON.stringify(st.proactive)} characterId=grok-classic; hardware acceleration ${before} → ${after} (pendingRestart [])`;
      } finally {
        await again.app.close().catch(() => {});
      }
    });
  } finally {
    await app.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- interject (插个嘴)
// 插个嘴 (docs/interject.md): the real app with the fake `lh` — its `generate decide` answers the probability in
// <FAKE_LH_DIR>/decide.json (the mock jev, no tokens) and logs every call to decide-calls.jsonl.
// IJ1 off by default: typing a draft → zero decide calls · IJ2 设置窗口 → 主动搭话与好感 → 插个嘴: the group folds
// open (dependsOn) when switched on there · IJ3 a low probability → silence · IJ4 on + mock 0.86 → her remark in
// the bubble with 别插嘴 / 说得好 on it · IJ5 click 别插嘴 → feedback mute → a block rule · IJ6 a draft of the same
// kind → dropped by the rule, no decide call, no remark · IJ7 the rules table and the decision records in the
// settings window · IJ8 停用 there → that kind is judged again; 说得好 on a remark → an allow rule · IJ9 删除 a
// rule (confirmed) → gone from the table and interject.json.
// Output: out/e2e/interject/*.png, video/, evidence.json, chapters.json, interject.json.
async function interjectScenario() {
  const S = 'interject';
  const SHOTS = path.join(OUT, 'interject');
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ij-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ijfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir }, { video: path.join(SHOTS, 'video') });
  const t0 = Date.now();
  const chapters = [];
  const evidence = [];
  const chapter = (title) => chapters.push({ at: Math.round((Date.now() - t0) / 1000), title });
  const note = (s) => { evidence.push(s); say(`    ${s}`); };
  const decideCalls = () => { const f = path.join(fakeDir, 'decide-calls.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const mock = (o) => fs.writeFileSync(path.join(fakeDir, 'decide.json'), JSON.stringify(o));
  const shot = async (p, name) => { await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `interject/${name}.png`; };
  const bubble = () => page.evaluate(() => { const b = document.getElementById('bubble'); return b.classList.contains('hidden') ? '' : b.textContent.trim(); });
  const feedbackRow = () => page.evaluate(() => { const r = document.getElementById('ij-feedback'); return { shown: !r.classList.contains('hidden'), buttons: [...r.querySelectorAll('.ij-btn')].filter((b) => !b.classList.contains('hidden')).map((b) => b.textContent.trim()), done: r.querySelector('.ij-done').classList.contains('hidden') ? '' : r.querySelector('.ij-done').textContent, decision: r.dataset.decision || null, result: r.dataset.result || null }; });
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const openChat = async () => { await hover(page); if (!(await page.isVisible('#chat-input'))) await page.click('[data-act="chat"]'); await page.waitForSelector('#chat-input', { state: 'visible' }); };
  const typeDraft = async (text) => { await openChat(); await page.fill('#chat-input', ''); await page.type('#chat-input', text, { delay: 15 }); };
  const lastDecision = async () => (await page.evaluate(() => window.pet.interject.decisions())).decisions.pop();
  const rules = async () => (await page.evaluate(() => window.pet.interject.rules())).rules;
  // a remark: mock `p`, fresh moment (she has not just spoken, no cooldown), type a draft, wait for 辛苦啦
  const remark = async (text) => {
    mock({ probability: 0.86 });
    await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
    await page.evaluate(() => window.pet.debugInterjectResetCooldown());
    await typeDraft(text);
    await page.waitForFunction(() => /辛苦啦/.test(document.getElementById('bubble').textContent) && !document.getElementById('ij-feedback').classList.contains('hidden'), null, { timeout: 20000 });
    await idle();
  };
  let admin = null;
  const adminRows = (sel) => admin.evaluate((s) => [...document.querySelectorAll(`${s} [data-row-key]`)].map((tr) => [...tr.children].map((td) => td.textContent.trim())), sel);
  const scrollTo = (sel) => admin.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'start' }), sel);
  try {
    await step(S, 'IJ0 hatch; 插个嘴 is off by default (interject.enabled false, clipboard off, jev-1.14.0)', async () => {
      chapter('IJ0 孵化：插个嘴默认关闭');
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="claude"]');
      await page.fill('#pet-name', '小芽');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await idle();
      const ij = (await page.evaluate(() => window.pet.getSettings())).interject;
      note(`默认 settings.interject = ${JSON.stringify(ij)}`);
      assert.equal(ij.enabled, false);
      assert.equal(ij.sources.clipboard, false);
      assert.equal(ij.model, 'lobehub/jev-1.14.0');
      return shot(page, 'ij0-hatched');
    }, page);

    await step(S, 'IJ1 off: typing a draft in her chat box makes zero `lh generate decide` calls and no record', async () => {
      chapter('IJ1 开关关：聊天框打字，零次 jev 调用');
      mock({ probability: 0.99 });
      await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
      await typeDraft('终于把这个 bug 修好了！累死我了');
      await page.waitForTimeout(5500); // longer than the default 4 s debounce
      const n = decideCalls().length;
      const d = await page.evaluate(() => window.pet.interject.decisions());
      note(`开关关：decide 调用 ${n} 次，判断记录 ${d.decisions.length} 条，气泡「${await bubble()}」`);
      assert.equal(n, 0);
      assert.equal(d.decisions.length, 0);
      assert.equal((await feedbackRow()).shown, false);
      const p = await shot(page, 'ij1-off-typing');
      await page.fill('#chat-input', '');
      return `decide calls 0, records 0; ${p}`;
    }, page);

    await step(S, 'IJ2 设置窗口 → 主动搭话与好感 → 插个嘴: off folds the group; switching it on there shows sources, quotas, thresholds, model', async () => {
      chapter('IJ2 设置窗口：插个嘴分组（关 → 开，dependsOn 联动）');
      admin = await openAdminWindow(app, page, 'proactive');
      await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')); w.setSize(1180, 1000); });
      await adminUntil(admin, () => !!document.querySelector('[data-key="interject.enabled"]'), null, 15000, 'the 插个嘴 switch');
      const visibleKeys = () => admin.evaluate(() => [...document.querySelectorAll('[data-key^="interject."]')].filter((el) => el.offsetParent !== null).map((el) => el.dataset.key));
      const offKeys = await visibleKeys();
      const desc = await admin.evaluate(() => [...document.querySelectorAll('[data-settings-page="proactive"] *')].map((el) => el.childElementCount === 0 ? el.textContent : '').find((t) => /^默认关闭。/.test(t)) || '');
      await scrollTo('[data-key="interject.enabled"]');
      await shot(admin, 'ij2a-console-off');
      await admin.evaluate(() => document.querySelector('[data-key="interject.enabled"]').click());
      await adminUntil(admin, () => !!document.querySelector('[data-key="interject.sources.chatDraft"]'), null, 8000, 'the sources fold open');
      await adminUntil(admin, async () => (await window.petAdmin.state()).settings.interject.enabled === true, null, 8000, 'saved');
      // for the run: 1 s debounce and no quiet hours (start = end), set like the owner would in the same form
      for (const [k, v] of [['interject.debounceSec', 1], ['interject.quietStart', 0], ['interject.quietEnd', 0]]) assert.equal((await admin.evaluate(([key, val]) => window.petAdmin.set(key, val), [k, v])).ok, true, k);
      await admin.waitForTimeout(300);
      const onKeys = await visibleKeys();
      await scrollTo('[data-key="interject.enabled"]');
      const p = await shot(admin, 'ij2b-console-on');
      await scrollTo('[data-key="interject.quietEnd"]');
      await shot(admin, 'ij2c-console-on-thresholds');
      const s = (await page.evaluate(() => window.pet.getSettings())).interject;
      note(`关时可见字段 ${JSON.stringify(offKeys)}；开后可见 ${onKeys.length} 个：${onKeys.join(', ')}`);
      note(`开关说明：${desc.replace(/\s+/g, ' ').slice(0, 160)}`);
      note(`设置窗口打开后 settings.interject = ${JSON.stringify(s)}`);
      assert.deepEqual(offKeys, ['interject.enabled']);
      for (const k of ['interject.sources.chatDraft', 'interject.sources.voice', 'interject.sources.api', 'interject.sources.clipboard', 'interject.cooldownMin', 'interject.maxPerHour', 'interject.highThreshold', 'interject.lowThreshold', 'interject.model']) assert.ok(onKeys.includes(k), k);
      assert.match(desc, /默认关闭/);
      assert.match(desc, /不装键盘钩子/);
      assert.equal(s.enabled, true);
      assert.equal(s.debounceSec, 1);
      await page.bringToFront();
      return p;
    }, () => admin);

    await step(S, 'IJ3 on + a low probability (mock 0.2 ≤ 0.3) on a voice transcript → she stays quiet', async () => {
      chapter('IJ3 jev 0.2 → 不插嘴');
      mock({ probability: 0.2 });
      await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
      const before = decideCalls().length;
      const shown = await bubble() || null;
      await page.evaluate(() => window.pet.debugInterjectInput('voice', '提醒我明天早上九点交报告'));
      await page.evaluate(() => window.pet.debugInterjectFlush());
      const d = await lastDecision();
      note(`低概率记录：${JSON.stringify(d)}`);
      assert.equal(decideCalls().length, before + 1);
      assert.equal(d.verdict, 'skip');
      assert.equal(d.reason, 'confident-no');
      await page.waitForTimeout(1500);
      assert.doesNotMatch(await bubble(), /辛苦啦/, 'no remark');
      assert.notEqual(d.said, shown);
      assert.equal(d.said, undefined);
      assert.equal((await feedbackRow()).shown, false);
      return shot(page, 'ij3-low-quiet');
    }, page);

    let remarkId = null;
    await step(S, 'IJ4 on + high probability: a draft → jev (mock 0.86 ≥ 0.7) → her remark in the bubble, 别插嘴 / 说得好 on it', async () => {
      chapter('IJ4 开关开 + 高概率 → 插嘴气泡（带反馈按钮）');
      const before = decideCalls().length;
      await remark('终于把这个 bug 修好了！累死我了');
      const calls = decideCalls().slice(before);
      const rec = await lastDecision();
      const row = await feedbackRow();
      remarkId = rec.id;
      note(`decide 调用 ${calls.length} 次，model=${calls[0].model}`);
      note(`jev state:\n${calls[0].state}`);
      note(`判断记录：${JSON.stringify(rec)}`);
      note(`气泡「${await bubble()}」；反馈按钮 ${JSON.stringify(row)}`);
      assert.equal(calls.length, 1);
      assert.match(calls[0].state, /终于把这个 bug 修好了/);
      assert.equal(rec.verdict, 'interject');
      assert.equal(rec.probability, 0.86);
      assert.deepEqual(row.buttons, ['别插嘴', '说得好']);
      assert.equal(row.decision, rec.id);
      return shot(page, 'ij4-remark-bubble');
    }, page);

    await step(S, 'IJ5 click 别插嘴 on the bubble → feedback mute → a block rule on 写代码', async () => {
      chapter('IJ5 点「别插嘴」→ 生成规则');
      await page.click('#ij-feedback [data-ij="mute"]');
      await page.waitForFunction(() => document.getElementById('ij-feedback').dataset.result === 'mute', null, { timeout: 5000 });
      const row = await feedbackRow();
      const p = await shot(page, 'ij5-mute-clicked');
      const rs = await rules();
      const d = (await page.evaluate(() => window.pet.interject.decisions())).decisions.find((x) => x.id === remarkId);
      note(`点击后：${JSON.stringify(row)}；记录 feedback=${d.feedback}；规则 ${JSON.stringify(rs)}`);
      assert.equal(d.feedback, 'mute');
      assert.equal(rs.length, 1);
      assert.equal(rs[0].effect, 'block');
      assert.equal(rs[0].category, 'code');
      assert.equal(rs[0].origin, 'mute');
      assert.match(row.done, /不插嘴了/);
      return p;
    }, page);

    await step(S, 'IJ6 a draft of the same kind (code) is dropped by the rule: no decide call, no remark', async () => {
      chapter('IJ6 同类输入不再插嘴（不调用 jev）');
      mock({ probability: 0.95 });
      await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
      await page.waitForFunction(() => document.getElementById('ij-feedback').classList.contains('hidden'), null, { timeout: 5000 });
      const before = decideCalls().length;
      const shown = await bubble();
      await typeDraft('npm test 又报错了，stack trace 一大串');
      await page.waitForTimeout(2500);
      const d = await lastDecision();
      const after = decideCalls().length;
      note(`拦截记录：${JSON.stringify(d)}；decide 调用 ${before} → ${after}；气泡「${await bubble()}」`);
      assert.equal(after, before);
      assert.equal(d.stage, 'prefilter');
      assert.equal(d.reason, 'rule');
      const now = await bubble();
      assert.ok(now === shown || now === '', 'no new remark (the old line may have timed out)');
      assert.equal((await feedbackRow()).shown, false);
      assert.equal((await rules())[0].hits, 1);
      const p = await shot(page, 'ij6-rule-blocks');
      await page.fill('#chat-input', '');
      return p;
    }, page);

    await step(S, 'IJ7 设置窗口: the rules table (rule, origin, hits, created) and the recent decisions (probability, interjected or not)', async () => {
      chapter('IJ7 设置窗口：规则表与判断记录');
      await admin.evaluate(() => { location.hash = '/proactive'; });
      await adminUntil(admin, () => document.querySelectorAll('[data-interject-rules] [data-row-key]').length === 1 && document.querySelectorAll('[data-interject-decisions] [data-row-key]').length >= 3, null, 10000, 'rules and records');
      const r = await adminRows('[data-interject-rules]');
      const d = await adminRows('[data-interject-decisions]');
      note(`规则表：${JSON.stringify(r)}`);
      note(`判断记录（新→旧）：${JSON.stringify(d)}`);
      assert.match(r[0][0], /别插嘴/);
      assert.match(r[0][0], /写代码/);
      assert.equal(r[0][1], '让她别插嘴');
      assert.equal(r[0][2], '1 次');
      assert.match(r[0][3], /\d/);
      assert.match(d[0].join(' '), /命中「别插嘴」规则/);
      assert.match(d[1].join(' '), /86%.*插了一句.*别插嘴/);
      assert.match(d[2].join(' '), /20%.*没说/);
      await scrollTo('[data-interject-rules]');
      return shot(admin, 'ij7-rules-and-records');
    }, () => admin);

    await step(S, 'IJ8 停用 the rule in the table → the same kind is judged again; 说得好 on that remark → an allow rule', async () => {
      chapter('IJ8 停用规则 → 同类重新判断；点「说得好」→ 可以插嘴规则');
      const id = (await rules())[0].id;
      await admin.evaluate((rid) => document.querySelector(`[data-rule-toggle="${rid}"]`).click(), id);
      await adminUntil(admin, () => /已停用/.test(document.querySelector('[data-interject-rules]').textContent), null, 8000, '已停用');
      assert.equal((await rules())[0].disabled, true);
      await shot(admin, 'ij8a-rule-disabled');
      const before = decideCalls().length;
      await remark('git push 被拒绝了，冲突好多');
      assert.equal(decideCalls().length, before + 1, 'judged again');
      await page.click('#ij-feedback [data-ij="like"]');
      await page.waitForFunction(() => document.getElementById('ij-feedback').dataset.result === 'like', null, { timeout: 5000 });
      await shot(page, 'ij8b-like-clicked');
      const rs = await rules();
      note(`停用后同类输入 decide ${before} → ${decideCalls().length}；点「说得好」后规则 ${JSON.stringify(rs)}`);
      assert.equal(rs.length, 1, 'same scope: allow replaces the disabled block');
      assert.equal(rs[0].effect, 'allow');
      assert.equal(rs[0].origin, 'like');
      await adminUntil(admin, () => /可以插嘴/.test(document.querySelector('[data-interject-rules]').textContent), null, 8000, 'the allow rule in the table');
      await scrollTo('[data-interject-rules]');
      return shot(admin, 'ij8c-allow-rule');
    }, () => admin);

    await step(S, 'IJ9 删除 the rule in the table (confirmed) → the table is empty and interject.json has no rules', async () => {
      chapter('IJ9 删除规则（确认）');
      const id = (await rules())[0].id;
      await admin.evaluate((rid) => document.querySelector(`[data-rule-delete="${rid}"]`).click(), id);
      await adminUntil(admin, () => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].some((b) => b.textContent.trim() === '删除规则'), null, 8000, 'the confirm dialog');
      await shot(admin, 'ij9a-delete-confirm');
      await admin.evaluate(() => [...document.querySelectorAll('[role="dialog"] button, .ant-modal button')].filter((b) => b.textContent.trim() === '删除规则').pop().click());
      await adminUntil(admin, () => document.querySelectorAll('[data-interject-rules] [data-row-key]').length === 0, null, 8000, 'the row gone');
      const file = JSON.parse(fs.readFileSync(path.join(data, 'interject.json'), 'utf8'));
      fs.writeFileSync(path.join(SHOTS, 'interject.json'), JSON.stringify(file, null, 2));
      note(`interject.json：rules ${file.rules.length}，decisions ${file.decisions.length}`);
      assert.equal(file.rules.length, 0);
      await admin.waitForTimeout(400);
      await scrollTo('[data-interject-rules]');
      return shot(admin, 'ij9b-rule-deleted');
    }, () => admin);
  } finally {
    await app.close().catch(() => {});
    const vids = fs.existsSync(path.join(SHOTS, 'video')) ? fs.readdirSync(path.join(SHOTS, 'video')) : [];
    fs.writeFileSync(path.join(SHOTS, 'chapters.json'), JSON.stringify(chapters, null, 2));
    fs.writeFileSync(path.join(SHOTS, 'evidence.json'), JSON.stringify({ results: results.filter((r) => r.scenario === S), evidence, videos: vids }, null, 2));
  }
}

(async () => {
  if (which === 'fresh' || which === 'all') await fresh();
  if (which === 'wardrobe' || which === 'all') await wardrobe();
  if (which === 'migrate' || which === 'all') await migrate();
  if (which === 'characters' || which === 'all') await characters();
  if (which === 'dafeiyu' || which === 'all') await dafeiyu();
  if (which === 'busy' || which === 'all') { await busy(); await longreply(); await daemonlaunch(); await oldlh(); }
  if (which === 'live' || which === 'all') await live();
  // 测速 (docs/admin-chat-latency.md): real LobeHub, not part of `all`; label = argv[3]
  if (which === 'latency') await require('./chat-latency').run(process.argv[3] || 'baseline');
  if (which === 'space' || which === 'all') await space();
  if (which === 'advanced' || which === 'all') await advanced();
  if (which === 'packs' || which === 'all') await packs();
  if (which === 'models' || which === 'all') await models();
  if (which === 'charpage' || which === 'all') await charpage();
  if (which === 'update' || which === 'all') await update();
  if (which === 'art' || which === 'all') await art();
  if (which === 'roster' || which === 'all') await roster();
  if (which === 'touch' || which === 'all') await touch();
  if (which === 'voice' || which === 'all') await voice();
  if (which === 'ivoice' || which === 'all') await ivoice();
  if (which === 'localvoice' || which === 'all') await localvoice();
  if (which === 'chatvoice' || which === 'all') await chatvoice();
  if (which === 'history' || which === 'all') await history();
  if (which === 'vpack' || which === 'all') await vpack();
  if (which === 'gvpack' || which === 'all') await gvpack();
  if (which === 'gvpack-recorded' || which === 'all') await gvpackRecorded();
  if (which === 'voice-pack-switch' || which === 'all') await voicePackSwitch();
  if (which === 'user-voice-pack' || which === 'all') await userVoicePack();
  if (which === 'outfit' || which === 'all') await outfitScenario();
  if (which === 'adultlook' || which === 'all') await adultLook();
  if (which === 'rig' || which === 'all') await rigScenario();
  if (which === 'live2d' || which === 'all') await live2dScenario();
  if (which === 'l2dimport' || which === 'all') await live2dImport();
  if (which === 'vrmui' || which === 'all') await vrmUi();
  if (which === 'vrmimport' || which === 'all') await vrmScenarios().vrmImport();
  if (which === 'vrm' || which === 'all') await vrmScenarios().vrmScenario();
  if (which === 'vrmframe' || which === 'all') await vrmScenarios().vrmFraming();
  if (which === 'vrmacts' || which === 'all') await vrmScenarios().vrmActs();
  if (which === 'vrmdance' || which === 'all') await vrmScenarios().vrmDance();
  if (which === 'vrmreset' || which === 'all') await vrmScenarios().vrmReset();
  if (which === 'vrmanim' || which === 'all') await vrmScenarios().vrmAnim(); // T-2832 前台 VRM 动画状态端到端验收
  if (which === 'danceui' || which === 'all') await vrmScenarios().danceUi();
  if (which === 'dance' || which === 'all') await vrmScenarios().danceE2e();
  if (which === 'dancefinal' || which === 'all') await vrmScenarios().danceFinal();
  if (which === 'live2dframe' || which === 'all') await live2dFrameScenarios().live2dFraming();
  if (which === 'spriteframe' || which === 'all') await spriteFrameScenarios().spriteFraming();
  if (which === 'asr' || which === 'all') await asrScenario();
  if (which === 'voicehotkey' || which === 'all') await voiceHotkeyScenario();
  if (which === 'stream' || which === 'all') await streamScenario();
  if (which === 'design' || which === 'all') await designScenario();
  if (which === 'petui' || which === 'all') await petuiScenario();
  if (which === 'quitbtn' || which === 'all') await quitButtonScenario()();
  if (which === 'admin' || which === 'all') await adminScenario();
  if (which === 'titlebar' || which === 'all') await titlebarScenario();
  if (which === 'frontslim' || which === 'all') await frontslimScenario();
  if (which === 'admincov' || which === 'all') await adminCoverageScenario();
  if (which === 'adminchat') retiredScenario('adminchat', 'chatui (聊天 is one conversation per character now; docs/admin-chat.md)');
  if (which === 'chatui' || which === 'all') await chatUiScenario();
  if (which === 'adminchat-live') retiredScenario('adminchat-live', 'admin-chat (its real-LobeHub part)');
  if (which === 'admin-chat') await adminChatAcceptance(); // T-2773 acceptance: chatui walk + real LobeHub through the chat page (a few tokens)
  if (which === 'wardrobepack' || which === 'all') await wardrobePackScenario();
  if (which === 'charmigrate' || which === 'all') await charMigrateScenario();
  if (which === 'catalogdl' || which === 'all') await catalogDownloadScenario();
  if (which === 'store' || which === 'all') await storeScenario();
  if (which === 'voicestore' || which === 'all') await voiceStoreScenario();
  if (which === 'voiceselect' || which === 'all') await voiceSelectScenario();
  if (which === 'voiceflow' || which === 'all') await voiceFlowScenario();
  if (which === 'interject' || which === 'all') await interjectScenario();
  // Scenarios can be run separately; keep earlier results for the ones not run this time.
  const ran = new Set(results.map((r) => r.scenario));
  let prior = [];
  try { prior = JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8')).filter((r) => !ran.has(r.scenario)); } catch { /* first run */ }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify([...prior, ...results], null, 2));
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  say(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} passed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
  fs.appendFileSync(path.join(OUT, 'run-log.txt'), `# ${new Date().toISOString()} scenarios: ${which}\n` + logLines.join('\n') + '\n');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
