'use strict';
// End-to-end suite: drives the real Electron app with Playwright.
//   scenario "fresh"  -> fake `lh` that starts logged-out (exercises the login flow)
//   scenario "live"   -> the real `lh` CLI against LobeHub (creates and deletes a real agent)
//   scenario "stream" -> 流式回复: a fake lh that prints the reply piece by piece; the bubble grows, then corrects
//   scenario "admin"  -> 配置后台: the settings window (single instance), every page light + dark, a change taking effect in the pet window, roster
//   scenario "design" -> the design-system preview (admin bundle, @lobehub/ui) in light + dark, offline under CSP
//   scenario "petui"  -> the pet window UI (bubble, HUD, chat box, menus, toast, #panel) in light + dark (LobeHub tokens)
//   scenario "asr"    -> 语音输入: fake microphone (a WAV) → MediaRecorder → a mock whisper server → the chat box
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

// Scenarios other than the age-gate ones start with the gate already answered ("all ages"), the same
// state an existing user is in. `gate: true` leaves settings.json alone so the first-launch gate shows.
async function launch(env, { gate = false, video = null, args = [] } = {}) {
  const dir = env && env.PIXELPET_DATA_DIR;
  if (dir && !gate && !fs.existsSync(path.join(dir, 'settings.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  }
  // software WebGL: xvfb has no GPU, and 全动态 looks (rig.js) need WebGL (without it they show a still picture)
  const app = await _electron.launch({ args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...args], cwd: ROOT, env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', ...env }, ...(video ? { recordVideo: { dir: video, size: { width: 460, height: 540 } } } : {}) });
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
  const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, FAKE_LH_LOGIN_MS: '2500' };
  let { app, page } = await launch(env);
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  try {
    await step(S, 'first launch shows the five model-chan', async () => {
      await page.waitForSelector('.char-card');
      assert.equal(await page.locator('.char-card').count(), 5);
      assert.equal(await page.locator('#hatch-btn').isDisabled(), true);
    }, page);

    await step(S, 'choosing a character enables waking her and shows who she is', async () => {
      await page.locator('.char-card').nth(2).click();
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
      assert.match(await page.textContent('#meta'), /小蓝 · 格萝可 · 陌生 ♥\d+ · 距「熟悉」\d+/);
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

    await step(S, 'without an 18+ answer the adult switch is off and only reopens the same 18+ confirmation', async () => {
      await clickAct(page, 'menu');
      assert.equal((await page.textContent('#menu-adult')).trim(), '成人向内容：关（需年满 18 岁）');
      await page.screenshot({ path: path.join(OUT, 'adult-switch-needs-18.png') });
      await page.click('#menu-adult');
      await page.waitForSelector('#age-gate:not(.hidden)');
      await page.screenshot({ path: path.join(OUT, 'adult-switch-reopens-gate.png') });
      await page.click('#age-no');
      await page.waitForSelector('#pet-screen:not(.hidden)');
      const v = await view(page);
      assert.equal(v.settings.adultContent, false);
      assert.ok(v.outfits.every((o) => o.rating === 'all'));
    }, () => page);

    await step(S, 'release deletes the agent through lh and returns to character selection', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="release"]');
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
      await page.locator('.char-card').nth(0).click();
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
      assert.match(meta, /小蓝 · 大肥鱼 · 熟悉 ♥25 · 距「亲近」10/);
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
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).appearance, {}, 'the retired look is dropped');
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
      assert.match(await page.textContent('#meta'), /小火 · 克洛蒂 · 知己 ♥70/);
      assert.equal(await page.locator('#pet-look canvas.sprite').count(), 1);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'pet.retired.bak.json'), 'utf8')).speciesId, 'bubbo', 'the backup is written once and never overwritten');
      assert.doesNotMatch(app.stderrBuf, /Unknown species|TypeError/);
      return `meta: ${await page.textContent('#meta')}; outfit maid → ${v.outfit}`;
    }, page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------- characters
// Every character has her own agent, topic, name and affection (schema 3). Starts from a schema-2 save.
async function characters() {
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
      assert.equal(await page.locator('.char-card').count(), 5);
      assert.match(await page.locator('.char-card').nth(0).textContent(), /DeepSeek/);
      await page.locator('.char-card').nth(0).click();
      assert.match(await page.locator('#card-info').textContent(), /大肥鱼|鱼片/);
      await page.fill('#pet-name', 'Mow');
    }, page);

    await step(S, 'hatching plays the 大肥鱼 hatch animation', async () => {
      await page.click('#hatch-btn');
      await page.waitForSelector('#hatch-vwrap:not(.hidden)', { timeout: 15000 });
      await page.waitForFunction(() => { const v = document.getElementById('hatch-video'); return v.readyState >= 2 && !v.paused; }, null, { timeout: 10000 });
      await page.waitForTimeout(600);
      assert.match(await page.evaluate(() => document.getElementById('hatch-video').src), /dafeiyu\/hatch\.webm$/);
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
    await step(S, 'in the wardrobe the signature outfit shows its animation cropped to fill the card', async () => {
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('.card[data-outfit="daily"] .vlook video');
      await page.waitForFunction(() => { const v = document.querySelector('.card[data-outfit="daily"] .vlook video'); return v && v.readyState >= 2; }, null, { timeout: 10000 });
      const box = await page.evaluate(() => { const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; }; return { card: r('.card[data-outfit="daily"] .vlook'), video: r('.card[data-outfit="daily"] .vlook video'), preview: r('#outfit-preview .vlook') }; });
      assert.ok(box.card[1] >= 100 && box.video[0] > box.card[0] * 2, JSON.stringify(box));
      await page.screenshot({ path: path.join(OUT, 'dafeiyu-wardrobe-signature.png') });
      await page.click('#panel-close');
      return `card ${box.card.join('x')}, video ${box.video.join('x')}, preview ${box.preview.join('x')}`;
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
    await page.locator('.char-card').nth(2).click();
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

    await step(S, 'turning computer access off from the menu unbinds the agent, and on binds it again', async () => {
      await clickAct(page, 'menu');
      assert.match(await page.textContent('#menu-local'), /开/);
      await page.click('#menu-local');
      await idle();
      let edits = fs.readFileSync(path.join(fakeDir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.agencyConfig);
      assert.deepEqual(edits.at(-1).agencyConfig, { boundDeviceId: null });
      await clickAct(page, 'menu');
      assert.match(await page.textContent('#menu-local'), /关/);
      await page.click('#menu-local');
      await idle();
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
    await page.locator('.char-card').nth(1).click();
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
    await page.locator('.char-card').nth(2).click();
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
    await page.locator('.char-card').nth(2).click();
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
      await page.locator('.char-card').nth(1).click();
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
      await clickAct(page, 'menu');
      await page.click('[data-menu="release"]');
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
  const S = 'advanced';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adv-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-advfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: true }));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card').nth(0).click();
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
    await page.locator('.char-card').nth(2).click();
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
    await page.locator('.char-card[data-species="claude"], .char-card >> nth=1').first().click();
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
    await page.locator('.char-card[data-species="claude"], .char-card >> nth=1').first().click();
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
    await page.locator('.char-card').nth(2).click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });

    await step(S, '⋯ → 检查更新 opens 设置 → 版本与更新, shows the version and says it is the newest one', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="check-update"]');
      admin = await adminWin();
      await admin.waitForSelector('[data-path="/update"]', { timeout: 15000 });
      await waitStatus(/状态 已是最新版本/);
      const text = await updateText();
      assert.match(text, new RegExp(`当前版本 v?${version.replace(/\./g, '\\.')} 状态`));
      assert.match(text, /上次检查 \d/, 'the time of the check is shown');
      assert.equal(await admin.getByRole('button', { name: '立即更新' }).count(), 0, 'nothing to install');
      assert.equal(await page.isVisible('#menu-update'), false, 'no download item in ⋯ either');
      await admin.screenshot({ path: path.join(OUT, 'update-latest.png') });
      return text.slice(text.indexOf('当前版本'), text.lastIndexOf('检查更新')).trim();
    }, () => admin || page);

    await step(S, 'when a newer release exists, 检查更新 in the settings window finds it; the pet says so and ⋯ offers the download', async () => {
      tag = 'v9.9.9';
      await admin.getByRole('button', { name: '检查更新' }).click();
      await waitStatus(/状态 需要手动下载新版本 · v?9\.9\.9/);
      const text = await updateText();
      await admin.screenshot({ path: path.join(OUT, 'update-found.png') });
      // the pet window hears it too: she says it in her bubble, ⋯ gets 下载新版本 (which opens the release page)
      await page.waitForFunction(() => /有新版本 v9\.9\.9/.test(document.getElementById('bubble').textContent), null, { timeout: 5000 });
      const said = await bubbleText(page);
      await page.bringToFront();
      await clickAct(page, 'menu');
      const menu = await page.textContent('#menu-update');
      assert.match(menu, /下载新版本 v9\.9\.9/);
      await page.screenshot({ path: path.join(OUT, 'update-menu.png') });
      return `${text.slice(text.indexOf('状态'), text.indexOf('上次检查')).trim()} · bubble 「${said}」 · menu: ${menu}`;
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
    await page.locator('.char-card').nth(1).click();
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
        assert.equal(await page.locator('.char-card').count(), 5);
        const vendors = await page.locator('.char-card .vendor').allTextContents();
        assert.deepEqual(vendors, ['DeepSeek', 'Anthropic', 'xAI', 'Google', 'OpenAI']);
        assert.doesNotMatch(await page.textContent('#onboarding'), /灵石|蛋/);
        return vendors.join(' / ');
      }, page);
    }
    await step(S, `choose ${ch.zh} (${ch.vendor})`, async () => {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card').nth(ch.idx).click();
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
      await page.evaluate(() => window.pet.switchCharacter('dafeiyu'));
      await page.waitForTimeout(1500);
      await dismissToast();
      await page.evaluate(() => window.pet.setAppearance('dafeiyu-clips'));
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
      await openCharacters(page, 'claude');
      await page.click('.pack-opt[data-pack="claude-classic"] .pick');
      await page.waitForSelector('.pack-opt.on[data-pack="claude-classic"]');
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'claude-classic/daily', null, { timeout: 5000 });
      await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 });
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
// 语音 engines (core/tts.js) against a local stand-in for Fish Audio and MiniMax (no real key, no cost):
// engine choice, the cache, one line at a time, and every fallback (HTTP error, pause, timeout, no key,
// offline, silent), configured through 高级设置 → 语音 like a user would.
function ttsMock() {
  const http = require('node:http');
  const KEY = 'e2e-fake-fish-key-7f3a9c';
  const MM_KEY = 'e2e-fake-minimax-key-41b2';
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
  const m = { KEY, MM_KEY, wav, mode: 'ok', slow: {}, perCharMs: 0, log: [] };
  m.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch { /* ignore */ }
      const fish = req.url === '/v1/tts';
      // a local voice server (本地语音服务): the OpenAI speech API or whale-voice's /tts; no key
      const local = req.url === '/v1/audio/speech' || req.url === '/tts';
      const auth = local || req.headers.authorization === `Bearer ${fish ? KEY : MM_KEY}`;
      const rec = local
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
        if (fish || local) return res.writeHead(200, { 'content-type': 'audio/wav' }).end(audio);
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
      assert.deepEqual(st.tts, { provider: 'auto', providerSet: false, fallback: 'system', packs: true, endpoints: { fish: '', minimax: '', local: '' }, local: { api: 'openai', model: '', voice: '' } });
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
      assert.deepEqual(opts, ['自动（跟随角色）', 'Fish Audio', 'MiniMax', '本地语音服务', '系统语音']);
      assert.equal(await field('朗读引擎').locator('[role="combobox"]').textContent(), '自动（跟随角色）');
      assert.match(await waitTags('Fish Audio', /未就绪/), /未就绪/);
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
      const tags = await waitTags('Fish Audio', /^未就绪$/);
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
      assert.deepEqual(opts, ['自动（跟随角色）', 'Fish Audio', 'MiniMax', '本地语音服务', '系统语音']);
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
      assert.deepEqual(Object.entries(st.ttsStatus.engines).map(([id, e]) => `${id}:${e.hasKey}`), ['fish:false', 'minimax:false', 'local:false']); // 本地语音服务 is the third engine
      const pack = st.ttsStatus.packs.find((p) => p.character === 'dafeiyu');
      assert.ok(pack && pack.builtIn && pack.lines > 150, `built-in pack: ${JSON.stringify(pack)}`);
      return note(`no keys; built-in pack ${pack.id} 「${pack.name}」 ${pack.lines} lines; all packs: ${st.ttsStatus.packs.map((p) => `${p.character}:${p.lines}`).join(' ')}`);
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
    await step(S, 'I11 切换角色: ⋯ → 角色列表 → 克洛蒂 — her hello, then her greeting on coming back, read in her own Fish voice', async () => {
      const toClaude = async () => {
        await clickAct(page, 'menu');
        await page.click('[data-menu="characters"]');
        await pickCharacter(page, 'claude');
      };
      const r1 = await interact('初次见面 克洛蒂 met', /^met$/, toClaude);
      let sp = await last();
      assert.equal(sp.species, 'claude');
      assert.equal(sp.voiceId, 'faccba1a8ac54016bcfc02761285e67f');
      await shot('i11-met');
      await page.click('#panel-close');
      await idle();
      await page.evaluate(() => window.pet.switchCharacter('dafeiyu'));
      await page.waitForTimeout(800);
      const r2 = await interact('切换角色 switch', /^switch$/, toClaude);
      sp = await last();
      assert.equal(sp.species, 'claude');
      assert.equal(sp.voiceId, 'faccba1a8ac54016bcfc02761285e67f');
      await shot('i11-switch');
      await page.click('#panel-close');
      return `${r1} || ${r2}`;
    }, page);

    await step(S, 'I12 rapid clicks: 8 clicks in 0.8 s — the bubble follows every one, the voice says one line, nothing piles up', async () => {
      await idle();
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
      await clickAct(page, 'menu');
      await page.click('[data-menu="settings"]'); // ⋯ → 设置… opens the settings window (at 概览); then its 朗读 page
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
  const openHistory = async () => {
    // the stage-up toast from H2 stays up to 30 s over the top of the window (and the ⋯ menu): close it like the owner would
    if (await page.isVisible('#unlock-toast')) await page.click('#toast-close');
    await clickAct(page, 'menu');
    await page.click('[data-menu="history"]');
    await page.waitForSelector('#panel:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('panel-title').textContent.startsWith('聊天记录') && document.querySelector('.history-empty, .history-item'));
  };
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card[data-species="claude"]').click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();

    await step(S, 'H1 ⋯ → 聊天记录 opens; with only her greeting so far it shows the empty state', async () => {
      await openHistory();
      assert.match(await page.textContent('.history-empty'), /还没有你主动发起的聊天/);
      assert.equal(await page.locator('.history-item').count(), 0);
      assert.ok(logged().some((m) => m.origin === 'greeting' && m.kind === 'met'), 'the greeting was logged (origin greeting)');
      await shot('h1-empty');
      await page.click('#panel-close');
      return `empty state: 「${(await page.textContent('.history-empty')).trim().slice(0, 40)}」 while chat-log.json holds ${logged().length} system message(s)`;
    }, page);

    await step(S, 'H2 system lines happen: touch, feed, a proactive "hungry" line and a stage-up', async () => {
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
      const items = await page.$$eval('.history-item', (bs) => bs.map((b) => ({ time: b.querySelector('.history-time').textContent, who: b.querySelector('.history-who').textContent, count: b.querySelector('.history-count').textContent, preview: b.querySelector('.history-preview').textContent })));
      assert.equal(items.length, 1, JSON.stringify(items));
      assert.equal(items[0].preview, '今天也辛苦啦，晚上想吃什么？');
      assert.equal(items[0].count, '2 条');
      assert.match(items[0].time, /\d{2}:\d{2}/);
      const panel = await page.textContent('#panel');
      assert.ok(!/\[事件\]|echo: \[/.test(panel), 'no system text in the list');
      const hidden = await page.evaluate(() => window.pet.historyList().then((r) => r.hidden));
      await shot('h4-list');
      return `${items.map((i) => `${i.time} · ${i.who} · ${i.count} · 「${i.preview}」`).join(' | ')}; left out by origin: ${JSON.stringify(hidden)}`;
    }, page);

    await step(S, 'H5 opening it shows the owner\'s message and her reply in full; ← 返回列表 goes back', async () => {
      await page.click('.history-item');
      await page.waitForSelector('.history-thread');
      const msgs = await page.$$eval('.history-msg', (ms) => ms.map((m) => ({ role: m.dataset.role, text: m.querySelector('.history-msg-text').textContent })));
      assert.deepEqual(msgs, [{ role: 'user', text: '今天也辛苦啦，晚上想吃什么？' }, { role: 'pet', text: 'echo: 今天也辛苦啦，晚上想吃什么？' }]);
      await shot('h5-detail');
      await page.click('.history-back');
      await page.waitForSelector('.history-item');
      return msgs.map((m) => `${m.role}「${m.text}」`).join(' → ');
    }, page);

    await step(S, 'H6 after a restart the history is still there (chat-log.json)', async () => {
      await app.close();
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await openHistory();
      const previews = await page.$$eval('.history-preview', (ps) => ps.map((p) => p.textContent));
      assert.deepEqual(previews, ['今天也辛苦啦，晚上想吃什么？']);
      await shot('h6-after-restart');
      return `previews after restart: ${previews.join(', ')}`;
    }, page);

    await step(S, 'H7 ⋯ → 重新开始话题: confirm, her next run goes without -t into a new LobeHub topic; old topic not deleted, history keeps both', async () => {
      const runs = () => fs.readFileSync(path.join(fakeDir, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const oldTopic = runs().pop().topic;
      await page.click('#panel-close');
      await clickAct(page, 'menu');
      await page.waitForSelector('[data-menu="new-topic"]');
      await shot('h7-menu-new-topic');
      await page.click('[data-menu="new-topic"]');
      await page.waitForFunction(() => /换个新话题/.test(document.getElementById('bubble').textContent), null, { timeout: 10000 });
      assert.match(page.lastDialog || '', /旧话题不会删除/);
      await shot('h7-new-topic-bubble');
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
      const previews = await page.$$eval('.history-preview', (ps) => ps.map((p) => p.textContent));
      assert.equal(previews.length, 2, previews.join(' | '));
      await shot('h7-history-after-new-topic');
      return `topic ${oldTopic} → ${newTopic}; nothing deleted; history: ${previews.join(' | ')}`;
    }, page);
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
      await page.locator(`.char-card[data-species="${ch.id}"]`).click();
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
      await page.locator(`.char-card[data-species="${ch.id}"]`).click();
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
      await page.locator('.char-card').nth(0).click();
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
      await page.locator('.char-card').nth(0).click();
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
  const S = 'l2dimport';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2di-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2difake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  // "her own" model: the 中肥鱼 model files as a user has them, plus an expression named in Japanese
  const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2dmodel-'));
  const own = path.join(fix, 'Whale');
  fs.cpSync(path.join(ROOT, 'src', 'renderer', 'packs', 'dafeiyu-live2d', 'model'), own, { recursive: true });
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
      await page.locator('.char-card').nth(0).click();
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
  fs.writeFileSync(path.join(adultOk, 'pack.json'), JSON.stringify({ schema: 2, id: 'vrm-adult-open', name: 'Adult Open Fish', species: 'dafeiyu', kind: 'vrm', adult: true, vrm: { outfits: { daily: 'models/o.vrm', maid: 'models/o.vrm' } } }));

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

    await step(S, 'with adult content off, an allowed 18+ VRM pack is not offered, and adult outfits stay hidden', async () => {
      const r = await page.evaluate((d) => window.pet.debugImportPack(d), adultOk);
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      await page.click('#panel-close');
      await openCurrentPage(page);
      const listed = await page.$$eval('.pack-list .pack-opt', (os) => os.map((o) => o.dataset.pack));
      assert.ok(!listed.includes('vrm-adult-open'), listed.join(', '));
      await page.click('#panel-close');
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('#panel:not(.hidden) .card');
      const cards = await page.$$eval('.card', (cs) => cs.map((c) => ({ id: c.dataset.outfit, locked: c.classList.contains('locked'), adult: !!c.querySelector('.tag.adult') })));
      assert.equal(cards.filter((c) => c.adult).length, 0);
      return `外观: ${listed.join(', ')}`;
    }, page);

    await step(S, 'the VRM pack outfits stay locked by affection in the wardrobe, and a locked one cannot be worn', async () => {
      const cards = await page.$$eval('.card', (cs) => cs.map((c) => ({ id: c.dataset.outfit, locked: c.classList.contains('locked'), vrm: !!c.querySelector('.vrm-look'), st: c.querySelector('.st').textContent })));
      const locked = cards.filter((c) => c.locked);
      assert.ok(locked.length > 0, 'a new companion has locked outfits');
      assert.ok(locked.every((c) => c.vrm && /🔒/.test(c.st)), JSON.stringify(locked));
      // the importer's 1×1 stand-in picture is not shown: the VRM tile is
      await page.waitForFunction(() => [...document.querySelectorAll('.card .vrm-look img')].every((i) => i.complete && i.hidden));
      await page.click(`.card[data-outfit="${locked[0].id}"]`);
      await page.waitForFunction(() => /还没解锁/.test(document.getElementById('panel-msg').textContent));
      await page.screenshot({ path: path.join(OUT, 'vrmui-wardrobe.png') });
      return `${locked.length}/${cards.length} locked: ${locked.map((c) => c.id).join(', ')}`;
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
      await page.screenshot({ path: path.join(OUT, 'vrmui-adult-off-again.png') });
      await page.click('#panel-close');
      return `maid worn with 18+ on; 18+ off → look ${key}, ${adult} adult cards`;
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
const vrmScenarios = () => require('./vrm')({ ROOT, OUT, FAKE_LH, step, launch, openCurrentPage, clickAct });

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
    await page.locator('.char-card[data-species="claude"]').click();
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

    await step(S, 'S6 an open 聊天记录 conversation fills in her reply as it is written, then shows what was saved', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="history"]');
      await page.waitForSelector('.history-item');
      await page.locator('.history-item').first().click();
      await page.waitForSelector('.history-thread');
      reply({ pieces: ['记录里', '也能', '看到我', '一点点写出来。'], gapMs: 500 });
      // the chat box is behind the panel; the same chat IPC the box uses
      const done = page.evaluate(() => window.pet.chat('历史面板测试', [], []));
      // the conversation was drawn before this round: it is drawn again with the new message, then her reply fills in
      await page.waitForFunction(() => { const r = document.querySelector('.history-msg.pet.streaming .history-msg-text'); return r && r.textContent.length > 0; }, null, { timeout: 10000 });
      const live1 = await page.evaluate(() => document.querySelector('.history-msg.pet.streaming .history-msg-text').textContent);
      assert.ok('记录里也能看到我一点点写出来。'.startsWith(live1) && live1.length < 15, `live row 「${live1}」`);
      assert.equal(await page.evaluate(() => document.body.classList.contains('busy')), true);
      await shot('s6-history-live');
      await done;
      await page.waitForFunction(() => !document.querySelector('.history-msg.pet.streaming') && [...document.querySelectorAll('.history-msg.pet .history-msg-text')].some((e) => e.textContent === '记录里也能看到我一点点写出来。'), null, { timeout: 10000 });
      await shot('s6-history-final');
      await page.click('#panel-close');
      return note(`history row while writing: 「${live1}」; after: the saved reply`);
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
    await page.locator('.char-card[data-species="claude"]').click();
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
    const closePanel = async () => { await page.click('#panel-close'); await page.waitForSelector('#panel.hidden', { state: 'attached' }); };
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
        await page.locator('.char-card[data-species="claude"]').click();
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
      await step(S, `${theme}: ⋯ 菜单`, async () => {
        await clickAct(page, 'menu');
        await page.waitForSelector('#main-menu:not(.hidden)');
        await page.waitForTimeout(400); // let the menu's open transition finish
        await shot('05-main-menu');
        // the menu closes when the pointer leaves the window (as in `fresh`)
        await page.mouse.move(-20, -20);
        await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
        await page.waitForSelector('#main-menu.hidden', { state: 'attached' });
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
      await step(S, `${theme}: #panel 衣柜`, async () => {
        if (await page.isVisible('#unlock-toast')) await page.click('#toast-close');
        await clickAct(page, 'wardrobe');
        await page.waitForSelector('#panel:not(.hidden) .grid .card');
        await page.waitForTimeout(300);
        await shot('08-panel-wardrobe');
        await closePanel();
      }, page);
      await step(S, `${theme}: #panel 话题`, async () => {
        await clickAct(page, 'topics');
        await page.waitForSelector('#panel:not(.hidden) .topic');
        await shot('09-panel-topics');
        await closePanel();
      }, page);
      await step(S, `${theme}: #panel 聊天记录（列表 / 对话）`, async () => {
        await clickAct(page, 'menu');
        await page.click('[data-menu="history"]');
        await page.waitForSelector('#panel:not(.hidden) .history-item');
        await shot('10-panel-history-list');
        await page.click('.history-item');
        await page.waitForSelector('.history-thread');
        await shot('11-panel-history-thread');
        await closePanel();
      }, page);
      await step(S, `${theme}: #panel 角色列表`, async () => {
        await openCharacters(page);
        await page.waitForTimeout(300);
        await shot('12-panel-characters');
        await closePanel();
      }, page);
      // 高级设置 moved to the settings window (配置后台, scenario `admin`): her page in 角色列表 instead
      await step(S, `${theme}: #panel 角色列表 → 她的页（模型与个性化设定 → 在设置窗口中编辑）`, async () => {
        await openCharacters(page);
        await openCharPage(page, 'claude');
        await page.waitForSelector('#panel:not(.hidden) #char-config #char-admin');
        await page.waitForTimeout(300);
        await shot('13-panel-char-page');
        await closePanel();
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

// ---------------------------------------------------------------- admin (配置后台)
// The settings window: opened from the ⋯ menu (and Ctrl+,) as a single instance, every page in light and
// dark, a setting changed there takes effect in the pet window and lands in settings.json, typed values are
// checked, keys are write-only, a restart-only item says so, and 角色列表 lists / switches characters.
// Free: fake lh, no paid scenario, no network.
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

    await step(S, 'A1 ⋯ → 设置… opens the settings window (contextIsolation, only window.petAdmin), 高级设置 is gone from the menu', async () => {
      await clickAct(page, 'menu');
      const items = await page.$$eval('#main-menu [data-menu]', (els) => els.filter((e) => !e.classList.contains('hidden')).map((e) => e.textContent.trim()));
      assert.ok(items.includes('设置…'), items.join(','));
      assert.ok(!items.includes('高级设置'), 'the in-pet 高级设置 panel was replaced by the settings window');
      await page.screenshot({ path: path.join(SHOTS, 'pet-menu-settings.png') });
      await page.click('[data-menu="settings"]');
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
      return `menu: ${items.slice(0, 4).join(' / ')}…; window ${JSON.stringify(prefs[0])}; bridge has ${iso.keys} calls`;
    }, () => admin || page);

    await step(S, 'A2 single instance: tray → 打开设置…, ⋯ → 设置… again and Ctrl+, all reuse the same window', async () => {
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
      await clickAct(page, 'menu');
      await page.click('[data-menu="settings"]');
      await page.waitForTimeout(400);
      seen.push(['⋯ 设置…', (await count()).length]);
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
    const ROUTES = ['/overview', '/characters', '/characters/grok', '/play', '/settings', '/packs', '/visitors', '/behavior', '/proactive', '/appearance', '/tts', '/asr', '/voicepacks', '/connection', '/api', '/safety', '/update', '/about'];
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('admin-ui')); w.setSize(1180, 1000); });
    for (const theme of ['light', 'dark']) {
      await step(S, `A3 ${theme}: all ${ROUTES.length} pages render (rail with 4 places, hubs, her stage, form cards), data-theme=${theme}`, async () => {
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
          assert.equal(f.nav, 4, `rail links ${f.nav}: 小屋 / 角色 / 玩法 / 设置, not every page`);
        }
        return `${out.length} pages · rail of 4 · data-theme=${theme}`;
      }, () => admin);
    }
    await admin.evaluate(() => window.petAdmin.set('ui.theme', 'light'));

    await step(S, 'A3b depth: the rail holds 4 places; 设置 → a tile → its page → back up; 角色 → a card → her page', async () => {
      await go('/overview');
      const rail = await admin.$$eval('nav a[data-rail]', (as) => as.map((a) => a.textContent.trim()));
      assert.deepEqual(rail, ['小屋', '角色', '玩法', '设置']);
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
      await admin.click('[data-row="gemini"] a[href="#/characters/gemini"]');
      await admin.waitForSelector('[data-character-title="gemini"]');
      await admin.click('[data-back="characters"]');
      await admin.waitForSelector('[data-path="/characters"]');
      return `rail ${rail.join(' / ')}; 设置 tiles ${tiles.join(',')}; 玩法 tiles ${play.join(',')}; card → /characters/gemini → back`;
    }, () => admin);

    await step(S, 'A3c her stage: a tap sends hearts up, she answers, and the pet on the desktop plays happy too', async () => {
      await go('/overview');
      await page.evaluate(() => window.petFx.cue('idle'));
      await admin.click('[data-pat="grok"]');
      await admin.waitForSelector('[data-reaction]');
      const line = await admin.textContent('[data-reaction]');
      const hearts = await admin.$$eval('[data-stage="grok"] svg', (s) => s.length);
      await shot('a3c-pat');
      await page.waitForFunction(() => window.petFx.state().lastCue === 'happy', null, { timeout: 5000 });
      await admin.click('[data-action-chip="sleep"]');
      assert.equal(await admin.getAttribute('[data-stage="grok"] [data-action]', 'data-action'), 'sleep');
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
      assert.deepEqual(rows.map((r) => r.id), ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']);
      const grok = rows.find((r) => r.id === 'grok');
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
      await admin.click('[data-switch="claude"]');
      await admin.fill('[data-meet-name]', '小克');
      await admin.getByRole('dialog').getByRole('button', { name: '初次见面' }).click();
      await admin.waitForSelector('[data-current="claude"]', { timeout: 30000 });
      await page.waitForFunction(() => (document.getElementById('pet-look').dataset.key || '').startsWith('claude-'), null, { timeout: 15000 });
      const key = await page.getAttribute('#pet-look', 'data-key');
      await shot('a12-switched');
      await admin.click('[data-switch="grok"]');
      await admin.waitForSelector('[data-current="grok"]', { timeout: 30000 });
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
    }, [id, notSrc || null], { timeout: 15000 }).catch(async (e) => { const diag = await admin.evaluate(async (cid) => { const st = await window.petAdmin.state(); const r = st.roster.find((x) => x.id === cid); return { pushes: window.__pushes || null, main: r && r.preview && r.preview.url, trying: !!document.querySelector('[data-trying-tag]'), caption: (document.querySelector(`[data-worn-caption="${cid}"]`) || {}).textContent, worn: [...document.querySelectorAll(`[data-wardrobe="${cid}"] [data-worn="true"]`)].map((x) => x.dataset.pack) }; }, id); throw new Error(`stage of ${id} not drawn (not ${notSrc}): ${JSON.stringify(await stageOf(id))} ${JSON.stringify(diag)} — ${e.message.split('\n')[0]}`); });
    const showcaseShot = (id, name) => admin.locator(`[data-showcase="${id}"]`).screenshot({ path: path.join(SHOTS, `${name}.png`) });

    await step(S, 'A12b 角色详情: two columns — her stage pinned on the left (scales with the window), story and settings on the right', async () => {
      await go('/characters/grok');
      await admin.waitForSelector('[data-showcase="grok"]');
      await stageDrawn('grok');
      const box = () => admin.evaluate(() => {
        const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }; };
        return { show: r('[data-showcase]'), panels: r('[data-detail-layout] > div:last-child'), stage: r('[data-showcase] [data-stage]'), title: r('[data-character-title]') };
      });
      const a = await box();
      assert.ok(a.show.right <= a.panels.x, `stage column ${JSON.stringify(a.show)} left of the panels ${JSON.stringify(a.panels)}`);
      assert.ok(a.title.x >= a.panels.x, 'her name heads the right column');
      for (const sel of ['[data-wardrobe="grok"]', '[data-outfits="grok"]']) assert.equal(await admin.locator(sel).count(), 1, `${sel} on the right`);
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
      await stageDrawn('grok');
      return `1180×1000: stage column x=${a.show.x} w=${a.show.w}, panels x=${a.panels.x} w=${a.panels.w}, stage ${a.stage.h}px; 1180×700 scrolled ${scrolled}px: panels y ${top.panels.y}→${b.panels.y}, stage y ${top.show.y}→${b.show.y}; 1180×640: stage ${c.stage.h}px; 820 wide: stacked (panels y=${d.panels.y} below stage bottom ${d.show.y + d.show.h})`;
    }, () => admin);

    await step(S, 'A12c 衣柜: two outfits put on from the right panel show on her stage at once (and in the pet window)', async () => {
      await go('/characters/grok');
      await admin.getByRole('tab', { name: '装扮' }).click();
      const un = await admin.evaluate(() => window.petAdmin.unlockAll('grok'));
      assert.equal(un.ok, true);
      await admin.waitForSelector('[data-outfit="swimsuit"]:not([disabled])');
      await admin.waitForSelector('[data-outfit="pajamas"]:not([disabled])');
      await stageDrawn('grok');
      const s0 = await stageOf('grok');
      const caption0 = await admin.textContent('[data-worn-caption="grok"]');
      await showcaseShot('grok', 'a12c-stage-0-daily');
      const out = [`daily: ${s0.src.split('/').slice(-2).join('/')}`];
      let prev = s0.src;
      let i = 0;
      for (const id of ['swimsuit', 'pajamas']) {
        const t0 = Date.now();
        await admin.click(`[data-outfit="${id}"]`);
        await stageDrawn('grok', prev);
        const ms = Date.now() - t0;
        const st = await stageOf('grok');
        assert.notEqual(st.src, prev, `${id}: stage source changed`);
        assert.match(st.src, new RegExp(id), `${id}: the stage draws the ${id} sheet (${st.src})`);
        assert.equal(await admin.getAttribute(`[data-outfit="${id}"]`, 'data-equipped'), 'true');
        await page.waitForFunction((o) => (document.getElementById('pet-look').dataset.key || '').includes(o), id, { timeout: 10000 });
        const caption = await admin.textContent('[data-worn-caption="grok"]');
        await showcaseShot('grok', `a12c-stage-${++i}-${id}`);
        out.push(`${id}: ${st.src.split('/').slice(-2).join('/')} drawn ${ms}ms after the click; caption "${caption.trim()}"; pet #pet-look ${await page.getAttribute('#pet-look', 'data-key')}`);
        prev = st.src;
      }
      await shot('a12c-detail-after-outfits');
      // back to her daily outfit (the rest of the run expects it)
      await admin.click('[data-outfit="daily"]');
      await stageDrawn('grok', prev);
      return `caption before "${caption0.trim()}"; ${out.join(' | ')}`;
    }, () => admin);

    // 穿上 on a card, scrolled to the middle first: the last toast (bottom-right) may sit over a card at the bottom edge
    const useOn = async (id) => {
      await admin.locator(`[data-use-pack="${id}"]`).evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await admin.click(`[data-use-pack="${id}"]`);
    };
    await step(S, 'A13 角色详情 → 装扮: trying 旧版像素 on shows it on her stage, 穿上 keeps it there and changes the pet window', async () => {
      await go('/characters/grok');
      await admin.waitForSelector('[data-character-title="grok"]');
      await admin.evaluate(() => { window.__pushes = []; const t0 = performance.now(); window.petAdmin.onState((st) => { const r = st.roster && st.roster.find((x) => x.id === 'grok'); window.__pushes.push(`${Math.round(performance.now() - t0)}:${r ? r.preview.url.split('/')[2] : st.roster ? '?' : 'no-roster'}`); }); });
      await stageDrawn('grok');
      const before = await stageOf('grok');
      await shot('a13-detail-overview');
      await showcaseShot('grok', 'a13-stage-0-before');
      await admin.getByRole('tab', { name: '装扮' }).click();
      // 试穿 first: the stage shows the pack, nothing is saved yet
      await admin.click('[data-try-pack="grok-classic"]');
      await admin.waitForSelector('[data-trying-tag]');
      await stageDrawn('grok', before.src);
      const tried = await stageOf('grok');
      assert.match(tried.src, /grok-classic/, `try-on stage ${tried.src}`);
      assert.notEqual(saved().appearance && saved().appearance.grok, 'grok-classic', 'trying on saves nothing');
      await shot('a13-detail-try-on');
      await showcaseShot('grok', 'a13-stage-1-try-on');
      await useOn('grok-classic');
      await admin.waitForSelector('[data-trying-tag]', { state: 'detached' });
      await page.waitForFunction(() => (document.getElementById('pet-look').dataset.key || '').startsWith('grok-classic/'), null, { timeout: 10000 });
      await admin.waitForFunction(() => /正在穿：旧版像素|正在穿：.*classic/i.test(document.querySelector('[data-worn-caption="grok"]').textContent) || !/试穿中/.test(document.querySelector('[data-worn-caption="grok"]').textContent));
      await stageDrawn('grok');
      const worn = await stageOf('grok');
      assert.match(worn.src, /grok-classic/, `after 穿上 the stage keeps the new pack: ${worn.src}`);
      assert.equal(saved().appearance.grok, 'grok-classic');
      // the other way: back to her pixel pack, the stage follows without a reload
      await useOn('grok-pixel');
      for (let k = 0; k < 40 && saved().appearance.grok !== 'grok-pixel'; k++) await admin.waitForTimeout(200);
      if (saved().appearance.grok !== 'grok-pixel') await Promise.reject(new Error('unsaved')).catch(async () => { throw new Error(`穿上 grok-pixel did not save: appearance=${JSON.stringify(saved().appearance)}; toasts=${JSON.stringify(await admin.$$eval('[data-sonner-toast]', (ts) => ts.map((t) => t.textContent)))}; button=${await admin.locator('[data-use-pack="grok-pixel"]').count()}`); });
      await stageDrawn('grok', worn.src);
      const back = await stageOf('grok');
      assert.match(back.src, /grok-pixel/);
      await showcaseShot('grok', 'a13-stage-2-pixel-again');
      await useOn('grok-classic');
      await stageDrawn('grok', back.src);
      await page.waitForFunction(() => (document.getElementById('pet-look').dataset.key || '').startsWith('grok-classic/'), null, { timeout: 10000 });
      await shot('a13-detail-look');
      await showcaseShot('grok', 'a13-stage-3-classic-worn');
      await page.screenshot({ path: path.join(SHOTS, 'pet-after-look.png') });
      return `stage ${before.src.split('/').slice(-3).join('/')} → try-on ${tried.src.split('/').slice(-3).join('/')} (unsaved) → 穿上 ${worn.src.split('/').slice(-3).join('/')} → grok-pixel ${back.src.split('/').slice(-3).join('/')} → grok-classic again; pet window look ${await page.getAttribute('#pet-look', 'data-key')}; settings.json appearance.grok=${saved().appearance.grok}`;
    }, () => admin);

    await step(S, 'A13b every built-in look of every character draws on her stage (像素 / 旧版 / 全动态 / Live2D / 原版动画), none blank or broken', async () => {
      const chars = await admin.evaluate(async () => (await window.petAdmin.state()).view.characters.map((c) => ({ id: c.id, packId: c.appearance.packId, options: c.appearance.options.filter((o) => o.source === 'builtin' && !o.adult).map((o) => ({ id: o.id, kind: o.kind })) })));
      const rows = [];
      const kinds = new Set();
      for (const c of chars) {
        await go(`/characters/${c.id}`);
        await admin.waitForSelector(`[data-showcase="${c.id}"]`);
        await admin.getByRole('tab', { name: '装扮' }).click();
        for (const o of c.options) {
          const r = await admin.evaluate(([id, sp]) => window.petAdmin.setAppearance(id, sp), [o.id, c.id]);
          assert.equal(r.ok, true, `${c.id} ← ${o.id}: ${JSON.stringify(r)}`);
          await admin.waitForFunction(([cid, pid]) => [...document.querySelectorAll(`[data-wardrobe="${cid}"] [data-pack="${pid}"]`)].some((x) => x.dataset.worn === 'true'), [c.id, o.id], { timeout: 10000 }).catch(() => {});
          await stageDrawn(c.id);
          const st = await stageOf(c.id);
          assert.ok(st && st.type !== 'none' && !st.failed && st.drawn, `${c.id} in ${o.id} (${o.kind}): ${JSON.stringify(st)}`);
          // and tried on from her wardrobe (in colour even before she is met: a silhouette is only for the worn look)
          await admin.click(`[data-try-pack="${o.id}"]`);
          await admin.waitForSelector('[data-trying-tag]');
          await stageDrawn(c.id);
          const tr = await stageOf(c.id);
          assert.ok(tr && tr.type !== 'none' && !tr.failed, `${c.id} trying ${o.id}: ${JSON.stringify(tr)}`);
          if (!kinds.has(o.kind)) {
            kinds.add(o.kind);
            await showcaseShot(c.id, `a13b-stage-${o.kind}-${o.id}`);
          }
          await admin.click(`[data-try-pack="${o.id}"]`);
          await admin.waitForSelector('[data-trying-tag]', { state: 'detached' });
          rows.push(`${c.id}/${o.id}[${o.kind}] worn→${st.type} tried→${tr.type}`);
        }
        // as she was
        await admin.evaluate(([id, sp]) => window.petAdmin.setAppearance(id, sp), [c.packId || c.options[0].id, c.id]);
      }
      assert.ok(['sprites', 'rig', 'live2d', 'video'].every((k) => kinds.has(k)), [...kinds].join(','));
      assert.equal(saved().appearance.grok, 'grok-classic');
      return `${rows.length} looks drawn, kinds ${[...kinds].join('/')}: ${rows.join(', ')}`;
    }, () => admin);

    await step(S, 'A14 外观资源: an imported pack shows up (broadcast) and is deleted from the settings window after a confirmation', async () => {
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
      await admin.getByRole('dialog').getByRole('button', { name: '删除角色包' }).click();
      await admin.waitForSelector('[data-remove-pack="my-grok"]', { state: 'detached' });
      assert.ok(!fs.existsSync(path.join(data, 'packs', 'my-grok')));
      return 'my-grok listed after import, removed (folder gone)';
    }, () => admin);

    await step(S, 'A15 the pet window\'s 角色列表 → her page sends 模型与个性化设定 to the settings window', async () => {
      await page.bringToFront();
      await openCharacters(page, 'grok');
      assert.equal(await page.locator('#model-select, #role-input').count(), 0, 'no second copy of the form in the pet window');
      await page.click('#char-admin');
      await admin.waitForSelector('[data-character-title="grok"]');
      await page.screenshot({ path: path.join(SHOTS, 'pet-char-page-jump.png') });
      return `pet her page → admin ${await admin.evaluate(() => location.hash)}`;
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
        assert.equal(st.appearance.grok, 'grok-classic');
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
        return `after restart: proactive=${JSON.stringify(st.proactive)} appearance.grok=${st.appearance.grok}; hardware acceleration ${before} → ${after} (pendingRestart [])`;
      } finally {
        await again.app.close().catch(() => {});
      }
    });
  } finally {
    await app.close().catch(() => {});
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
  if (which === 'outfit' || which === 'all') await outfitScenario();
  if (which === 'adultlook' || which === 'all') await adultLook();
  if (which === 'rig' || which === 'all') await rigScenario();
  if (which === 'live2d' || which === 'all') await live2dScenario();
  if (which === 'l2dimport' || which === 'all') await live2dImport();
  if (which === 'vrmui' || which === 'all') await vrmUi();
  if (which === 'vrmimport' || which === 'all') await vrmScenarios().vrmImport();
  if (which === 'vrm' || which === 'all') await vrmScenarios().vrmScenario();
  if (which === 'asr' || which === 'all') await asrScenario();
  if (which === 'stream' || which === 'all') await streamScenario();
  if (which === 'design' || which === 'all') await designScenario();
  if (which === 'petui' || which === 'all') await petuiScenario();
  if (which === 'admin' || which === 'all') await adminScenario();
  // Scenarios can be run separately; keep earlier results for the ones not run this time.
  const ran = new Set(results.map((r) => r.scenario));
  let prior = [];
  try { prior = JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8')).filter((r) => !ran.has(r.scenario)); } catch { /* first run */ }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify([...prior, ...results], null, 2));
  const failed = results.filter((r) => r.status === 'fail');
  say(`\n${results.length - failed.length}/${results.length} passed`);
  fs.appendFileSync(path.join(OUT, 'run-log.txt'), `# ${new Date().toISOString()} scenarios: ${which}\n` + logLines.join('\n') + '\n');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
