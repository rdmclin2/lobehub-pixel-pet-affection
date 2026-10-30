'use strict';
// End-to-end suite: drives the real Electron app with Playwright.
//   scenario "fresh"  -> fake `lh` that starts logged-out (exercises the login flow)
//   scenario "live"   -> the real `lh` CLI against LobeHub (creates and deletes a real agent)
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
async function launch(env, { gate = false, video = null } = {}) {
  const dir = env && env.PIXELPET_DATA_DIR;
  if (dir && !gate && !fs.existsSync(path.join(dir, 'settings.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  }
  const app = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', ...env }, ...(video ? { recordVideo: { dir: video, size: { width: 460, height: 540 } } } : {}) });
  app.stderrBuf = '';
  app.process().stderr.on('data', (d) => { app.stderrBuf += d; });
  const page = await app.firstWindow();
  page.on('dialog', (d) => { page.lastDialog = d.message(); d.accept(); });
  return { app, page };
}

// The controls only exist visually while the pointer is over the window.
const hover = async (page) => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
const clickAct = async (page, act) => { await hover(page); await page.click(`[data-act="${act}"]`); };
// ⋯ → 切换角色 → pick a character. One not met yet is named first (`name`; null keeps her own) and gets her own agent.
const pickCharacter = async (page, id, name = null) => {
  await page.click(`.char-opt[data-species="${id}"] .pick`);
  if (await page.locator(`.char-opt.new[data-species="${id}"]`).count()) {
    await page.waitForSelector('.char-name-form input');
    if (name !== null) await page.fill('.char-name-form input', name);
    await page.click('.char-name-form button[type="submit"]');
  }
  await page.waitForSelector(`.char-opt.on[data-species="${id}"]`, { timeout: 20000 });
};
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

    await step(S, 'crossing 15 moves 陌生 -> 熟悉 and a notice names the unlocked topics (she has no other outfits to unlock)', async () => {
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
      assert.doesNotMatch(toast, /解锁服饰/);
      assert.equal((await page.textContent('#toast-open')).trim(), '去聊聊新话题');
      assert.equal(await page.locator('#btn-wardrobe .new-dot').isVisible(), false);
      return `${await shot('04-stage-up-unlock-notice')} · ${toast.replace(/\s+/g, ' ').trim()}`;
    });

    await step(S, 'the notice leads to the topics; the wardrobe holds only her signature maid outfit, in pixels', async () => {
      await page.click('#toast-open');
      await page.waitForSelector('#panel:not(.hidden) .topic');
      await closePanel();
      await openWardrobe();
      assert.equal(await page.locator('.card').count(), 1, 'DeepSeek keeps only her signature outfit');
      assert.equal(await page.locator('.card.locked').count(), 0);
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
      assert.doesNotMatch(toast, /解锁服饰/);
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
      assert.equal((await page.textContent('#toast-body')).trim(), '解锁话题：「交换小秘密」、「深夜谈心」');
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
      assert.equal(await page.locator('.card.locked').count(), 0);
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
      assert.equal(await page.locator('.card').count(), 1);
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
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, adultContent: false, appearance: { bubbo: 'bubbo-pixel' } }));
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
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, adultContent: false }));
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

    await step(S, '切换角色 shows who has been met: 格萝可 已认识 ♥40, the others 未见过', async () => {
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
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, appearance: { dafeiyu: 'dafeiyu-clips' } }));
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
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: true }));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card').nth(0).click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();

    await step(S, 'the ⋯ menu has 高级设置, which explains one-click unlock', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#panel:not(.hidden) #unlock-all');
      assert.equal(await page.textContent('#panel-title'), '高级设置');
      assert.equal(await page.evaluate(() => document.getElementById('panel-body').scrollTop), 0, 'opens at its top');
      const sections = await page.$$eval('#panel-body .adv-section h3', (hs) => hs.map((h) => h.textContent.trim()));
      assert.ok(!sections.some((t) => /^(角色|模型|外观)/.test(t)), `who she is and how she looks live in 切换角色: ${sections.join(' / ')}`);
      assert.match(await page.textContent('#panel-sub'), /陌生 ♥\d+/);
      assert.equal(await page.locator('#unlock-all').isDisabled(), false);
      return await page.textContent('#panel-sub');
    }, page);

    await step(S, 'one click unlocks every stage, topic and outfit (18+ on; 大肥鱼 is all-ages, so all-ages content only)', async () => {
      await page.click('#unlock-all');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)', { timeout: 10000 });
      const msg = await page.textContent('#panel-msg');
      assert.match(msg.trim(), /^已解锁：\d+ 个话题。$/, '大肥鱼 has no outfit to unlock, so none is mentioned');
      assert.match(await page.textContent('#panel-sub'), /挚友 ♥100\/100 · 已满级 · 话题 13\/13 · 服饰 1\/1/);
      assert.equal(await page.locator('#unlock-all').isDisabled(), true);
      return msg;
    }, page);

    await step(S, 'the wardrobe shows everything unlocked: 大肥鱼 has only her signature maid outfit, worn in pixels', async () => {
      await idle();
      await page.click('#panel-close');
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('.card[data-outfit="daily"]');
      assert.equal(await page.locator('.card.locked').count(), 0);
      assert.equal(await page.locator('.card').count(), 1);
      assert.equal(await page.textContent('.card[data-outfit="daily"] .st'), '✓ 穿着中');
      await page.screenshot({ path: path.join(OUT, 'advanced-wardrobe-all-unlocked.png') });
      await page.click('#panel-close');
      assert.equal(await page.evaluate(() => document.getElementById('pet-look').dataset.key), 'dafeiyu-pixel/daily');
      assert.match(await page.textContent('#meta'), /挚友 ♥100 · 已满级/);
      return 'pet wears 招牌女仆装 (dafeiyu-pixel)';
    }, page);

    const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
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

    await step(S, 'the slider in 高级设置 sets any size, and the size is kept across a restart', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#size-range');
      await page.evaluate(() => { const r = document.getElementById('size-range'); r.value = '60'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
      await page.waitForSelector('#panel-msg.ok:not(.hidden)');
      assert.match(await page.textContent('.size-val'), /60%/);
      assert.equal(await page.textContent('#size-reset'), '恢复默认 125%');
      await page.locator('#size-reset').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, 'pet-size-slider.png') });
      await page.click('#panel-close');
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
        const b = await again.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
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
  // the pack list (外观) lives in ⋯ → 切换角色, with the character list and her model
  const openLooks = async () => { await clickAct(page, 'menu'); await page.click('[data-menu="characters"]'); await page.waitForSelector('.pack-list .pack-opt'); };
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
      assert.deepEqual(await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.sprite'); return [c.width, c.height, getComputedStyle(c).imageRendering]; }), [332, 452, 'auto']);
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

    await step(S, 'an imported pack is listed as imported, can be used, and 切换角色 → 外观 names it', async () => {
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
      await page.click('.pack-opt[data-pack="my-grok"] .btn:not(.pick)');
      await page.waitForFunction(() => !document.querySelector('.pack-opt[data-pack="my-grok"]'));
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'grok-pixel/daily');
      assert.equal(fs.existsSync(path.join(data, 'packs', 'my-grok')), false);
    }, page);

    await step(S, '大肥鱼 starts in her pixel pack and can switch to her original clips and back', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="characters"]');
      await pickCharacter(page, 'dafeiyu');
      await page.waitForSelector('.pack-opt[data-pack="dafeiyu-pixel"]'); // the same panel now lists her looks
      assert.deepEqual(await page.$$eval('#panel-body .adv-section h3', (hs) => hs.map((h) => h.textContent.trim())), ['角色', '模型', '外观（角色包）']);
      const names = await page.locator('.pack-opt[data-pack] .meta b').allTextContents();
      assert.deepEqual(names, ['大肥鱼 · 像素', '大肥鱼 · 旧版像素', '大肥鱼 · 原版动画']);
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
// 高级设置 → 模型: each character offers only her own vendor's models; the agent follows the pick, and
// switching character switches the list (and the model) to the new character's.
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
  const options = () => page.$$eval('#model-select option', (os) => os.map((o) => ({ key: o.value, label: o.textContent, selected: o.selected })));
  const openCharacters = async () => {
    await clickAct(page, 'menu');
    await page.click('[data-menu="characters"]');
    await page.waitForSelector('#model-select option', { state: 'attached' }); // options are never "visible"
    await page.locator('#model-select').scrollIntoViewIfNeeded();
  };
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

    await step(S, '⋯ → 切换角色 → 模型 lists only Claude models (no GPT, GLM, image models), the default selected', async () => {
      await openCharacters();
      assert.equal(await page.textContent('#panel-title'), '切换角色');
      const os = await options();
      assert.deepEqual(os.map((o) => o.label), ['Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5']);
      assert.equal(os.find((o) => o.selected).key, 'lobehub:claude-sonnet-5-5');
      assert.match(await page.textContent('.model-status'), /正在用：Claude Sonnet 5\.5（默认）/);
      assert.match(await page.textContent('#panel'), /克洛蒂只能用 Anthropic 的模型/);
      await page.screenshot({ path: path.join(SHOTS, '01-claude-models.png') });
      return os.map((o) => o.label).join(' / ');
    }, page);

    await step(S, 'picking Claude Opus 5.5 points her agent at it', async () => {
      await page.selectOption('#model-select', 'lobehub:claude-opus-5-5');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)');
      assert.match(await page.textContent('#panel-msg'), /模型已换成「Claude Opus 5\.5」/);
      await page.waitForFunction(() => /正在用：Claude Opus 5\.5$/.test(document.querySelector('.model-status').textContent), null, { timeout: 10000 });
      assert.deepEqual(modelEdits(), ['lobehub:claude-sonnet-5-5', 'lobehub:claude-opus-5-5']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).models.claude, 'lobehub:claude-opus-5-5');
      await page.screenshot({ path: path.join(SHOTS, '02-claude-opus-picked.png') });
      return `${await page.textContent('.model-status')} · settings.json models.claude=lobehub:claude-opus-5-5`;
    }, page);

    await step(S, 'switching to 吉皮缇 switches the list to GPT models, her own OpenAI key marked', async () => {
      await pickCharacter(page, 'gpt');
      await page.waitForSelector('#model-select option', { state: 'attached' }); // options are never "visible"
      const os = await options();
      assert.ok(os.every((o) => /^(lobehub|openai):(gpt-|o\d)/.test(o.key)), JSON.stringify(os));
      assert.deepEqual(os.map((o) => o.label), ['GPT-6 Sol', 'GPT-6 Luna', 'GPT-6 Luna（自己的 OpenAI Key）', 'o3（自己的 OpenAI Key）']);
      assert.equal(os.find((o) => o.selected).key, 'lobehub:gpt-6-luna');
      // her own new agent is on it already if her hello went through the agent (not when the hourly budget made it an offline line)
      assert.match(await page.textContent('.model-status'), /(正在用|下一句话起用)：GPT-6 Luna（默认）/);
      await page.screenshot({ path: path.join(SHOTS, '03-gpt-models.png') });
      return os.map((o) => o.label).join(' / ');
    }, page);

    await step(S, 'her next words run on GPT-6 Luna; back on 克洛蒂 her Opus pick returns', async () => {
      await page.click('#panel-close');
      await page.waitForFunction(() => window.innerWidth < 400, null, { timeout: 5000 }); // back from the 460 px panel to the pet window (its width follows the pet size)
      await page.evaluate(() => window.pet.chat('你好'));
      await idle();
      assert.equal(modelEdits().pop(), 'lobehub:gpt-6-luna');
      await openCharacters();
      await pickCharacter(page, 'claude');
      await page.waitForSelector('#model-select option', { state: 'attached' }); // options are never "visible"
      assert.equal((await options()).find((o) => o.selected).key, 'lobehub:claude-opus-5-5');
      await page.screenshot({ path: path.join(SHOTS, '04-back-to-claude.png') });
      return modelEdits().join(' → ');
    }, page);
  } finally {
    await app.close().catch(() => {});
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
  const statusText = () => page.textContent('#update-section .st');
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card').nth(2).click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });

    await step(S, '⋯ → 检查更新 shows the version and says it is the newest one', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="check-update"]');
      await page.waitForFunction(() => /已经是最新版本/.test(document.querySelector('#update-section .st').textContent), null, { timeout: 15000 });
      const ver = await page.textContent('#update-section .ver');
      assert.match(ver, new RegExp(`当前版本 v${version.replace(/\./g, '\\.')} · 上次检查：\\d`));
      assert.equal(await page.locator('#update-go').isHidden(), true);
      await page.locator('#update-section').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, 'update-latest.png') });
      return `${ver} / ${await statusText()}`;
    }, page);

    await step(S, 'when a newer release exists, 检查更新 finds it and offers it', async () => {
      tag = 'v9.9.9';
      await page.click('#update-check');
      await page.waitForFunction(() => /有新版本 v9\.9\.9/.test(document.querySelector('#update-section .st').textContent), null, { timeout: 15000 });
      assert.match(await page.textContent('#update-go'), /下载 v9\.9\.9/);
      await page.locator('#update-section').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, 'update-found.png') });
      await page.click('#panel-close');
      await clickAct(page, 'menu');
      const menu = await page.textContent('#menu-update');
      assert.match(menu, /下载新版本 v9\.9\.9/);
      await page.screenshot({ path: path.join(OUT, 'update-menu.png') });
      return `${await statusText().catch(() => '')} · menu: ${menu}`;
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
              if (c.look) waits.push((c.look.kind === 'sprites' ? sheet(c.look.url) : el).decode().then(() => null, () => c.look.url));
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
              waits.push(sheet(c.look.url).decode());
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
      assert.deepEqual(ids, ['daily']);
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
    await step(S, 'N8 settings: 桌宠行为 switches (roam on, sound / voice off, 互动语音 on, 朗读碎碎念 off, memes and collisions on by default)', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#behavior-section');
      const prefs = await page.$$eval('#behavior-section input[data-pref]', (els) => els.map((e) => `${e.dataset.pref}=${e.checked ? 'on' : 'off'}`));
      assert.deepEqual(prefs, ['roam=on', 'clickSound=off', 'voice=off', 'voiceInteractions=on', 'voiceMurmurs=off', 'memes=on', 'collide=on', 'touchZones=on', 'touchHint=on']);
      await page.locator('#behavior-section').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `${S}-behavior-settings.png`) });
      await page.check('#behavior-section input[data-pref="clickSound"]');
      await page.check('#behavior-section input[data-pref="voice"]');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('朗读回复'));
      return prefs.join(', ') + ' → switched on: click sound, voice';
    }, page);
    await step(S, 'N9 click sound when she is clicked (setting on)', async () => {
      await page.click('#panel-close');
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
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector(`#visitor-section input[data-visitor="${guest.id}"]`);
      const opened = app.waitForEvent('window', { timeout: 10000 });
      await page.check(`#visitor-section input[data-visitor="${guest.id}"]`);
      guestPage = await opened;
      await guestPage.waitForFunction(() => window.petFx && window.petFx.state() && window.petFx.state().species, null, { timeout: 10000 });
      const gs = await guestPage.evaluate(() => window.petFx.state());
      assert.equal(gs.species, guest.id);
      await page.locator('#visitor-section').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `${S}-visitor-settings.png`) });
      await page.click('#panel-close');
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
    await step(S, 'N14 local HTTP API: switched on in settings, then driven with curl-like calls', async () => {
      await still();
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#api-on');
      await page.fill('#api-port', String(17400 + ch.idx));
      await page.dispatchEvent('#api-port', 'change');
      await page.check('#api-on');
      await page.waitForFunction(() => /正在监听/.test(document.getElementById('api-st').textContent), null, { timeout: 5000 });
      await page.locator('#api-section').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `${S}-api-settings.png`) });
      const st = await view(page);
      const token = st.settings.api.token;
      const port = st.settings.api.port;
      const call = async (method, p, body, tok = token) => {
        const r = await fetch(`http://127.0.0.1:${port}/pixel-pet${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json() };
      };
      await page.click('#panel-close');
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
    await step(S, 'E14 switch character from ⋯ → 切换角色: a new one gets her own agent and starts as a stranger', async () => {
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

    await step(S, 'settings: 部位触摸 off — a click is the old single pat again', async () => {
      await settle();
      await page.waitForTimeout(400);
      await hover(page);
      await page.click('[data-act="menu"]');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#behavior-section input[data-pref="touchZones"]');
      assert.equal(await page.isChecked('#behavior-section input[data-pref="touchZones"]'), true, 'on by default');
      await page.locator('#behavior-section input[data-pref="touchZones"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, 'settings-touch-switch.png') });
      await page.uncheck('#behavior-section input[data-pref="touchZones"]');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('部位触摸：关'));
      const saved = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).prefs;
      assert.equal(saved.touchZones, false, 'saved to settings.json');
      log.push(`settings.json prefs after switching off: ${JSON.stringify(saved)}`);
      await page.click('#panel-close');
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
      await clickAct(page, 'menu');
      await page.click('[data-menu="characters"]');
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
      const auth = req.headers.authorization === `Bearer ${fish ? KEY : MM_KEY}`;
      const rec = { at: Date.now(), path: req.url, auth, model: fish ? req.headers.model : j.model, voice: fish ? j.reference_id : j.voice_setting && j.voice_setting.voice_id, text: j.text, prosody: j.prosody || j.voice_setting, mode: m.mode, aborted: false, status: 0 };
      m.log.push(rec);
      // the client gave up: the response closed before it was sent (the request's own `close` fires once its body is read)
      res.on('close', () => { if (!res.writableFinished) rec.aborted = true; });
      const send = () => {
        if (res.destroyed) return;
        if (!auth) { rec.status = 401; return res.writeHead(401).end('{"message":"unauthorized"}'); }
        if (m.mode === '500') { rec.status = 500; return res.writeHead(500).end('{"message":"boom"}'); }
        rec.status = 200;
        const audio = m.perCharMs ? tone(Math.min(6, Math.max(0.4, ([...(j.text || '')].length * m.perCharMs) / 1000))) : wav;
        rec.audioMs = Math.round(((audio.length - 44) / 2 / 8000) * 1000);
        if (fish) return res.writeHead(200, { 'content-type': 'audio/wav' }).end(audio);
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
  const openVoice = async () => {
    if (!(await page.$('#voice-section'))) {
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#voice-section');
    }
    await page.locator('#voice-section').scrollIntoViewIfNeeded();
  };
  const ttsSet = () => page.evaluate(async () => (await window.pet.getSettings()));
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
      assert.deepEqual(st.tts, { provider: 'auto', providerSet: false, fallback: 'system', endpoints: { fish: '', minimax: '' } });
      return note(`default settings.tts ${JSON.stringify(st.tts)}; keys: fish=${st.ttsStatus.engines.fish.hasKey} minimax=${st.ttsStatus.engines.minimax.hasKey}`);
    }, page);

    await step(S, 'V1 高级设置 → 语音: switch 朗读 on, enter the Fish endpoint and API key', async () => {
      await openVoice();
      await page.locator('#behavior-section input[data-pref="voice"]').scrollIntoViewIfNeeded();
      await shot('v1-voice-toggle-off');
      await page.check('#behavior-section input[data-pref="voice"]');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('朗读回复：开'));
      await shot('v1-voice-toggle-on');
      assert.equal((await ttsSet()).prefs.voice, true);
      await page.locator('#voice-section').scrollIntoViewIfNeeded();
      await shot('v1-voice-section-empty');
      const opts = await page.$$eval('#tts-provider option', (els) => els.map((e) => `${e.value}:${e.textContent}`));
      assert.deepEqual(opts.map((o) => o.split(':')[0]), ['auto', 'fish', 'minimax', 'system']);
      assert.equal(await page.inputValue('#tts-provider'), 'auto');
      assert.match(await page.textContent('#tts-credit'), /默认用 MiniMax.*俏皮萌妹/);
      await page.fill('.tts-engine[data-engine="fish"] .tts-endpoint', mock.url);
      await page.click('.tts-engine[data-engine="fish"] .tts-ep-save');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('端点已改为'));
      assert.equal(await page.getAttribute('.tts-engine[data-engine="fish"] .tts-key', 'type'), 'password');
      await page.fill('.tts-engine[data-engine="fish"] .tts-key', mock.KEY);
      await page.click('.tts-engine[data-engine="fish"] .tts-key-save');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('API Key 已保存'));
      assert.equal(await page.inputValue('.tts-engine[data-engine="fish"] .tts-key'), '', 'the key is not kept in the page');
      await page.waitForFunction(() => document.getElementById('tts-status').textContent.includes('Fish Audio：Key 已设置'));
      const status = await page.textContent('#tts-status');
      await shot('v1-voice-section-configured');
      // the controls as the DOM has them: the 朗读 switch, the engine and fallback selects, key / endpoint fields
      const dom = await page.evaluate(() => {
        const d = (el) => `<${el.tagName.toLowerCase()}${[...el.attributes].filter((a) => a.name !== 'style').map((a) => ` ${a.name}="${a.value}"`).join('')}>${el.tagName === 'INPUT' ? ` value=${JSON.stringify(el.type === 'checkbox' ? el.checked : el.type === 'password' ? (el.value ? '(non-empty)' : '') : el.value)}` : ''}${el.tagName === 'SELECT' ? ` selected=${el.value} options=[${[...el.options].map((o) => `${o.value}:${o.textContent}`).join(' | ')}]` : ''}${el.tagName === 'BUTTON' ? ` "${el.textContent}"` : ''}`;
        const row = document.querySelector('#behavior-section input[data-pref="voice"]').closest('.pref-row');
        return ['# 高级设置 → 桌宠行为 → 朗读回复', d(row.querySelector('input')) + '  ' + row.querySelector('b').textContent, '', '# 高级设置 → 语音 (#voice-section)', ...[...document.querySelectorAll('#voice-section h3, #voice-section select, #voice-section input, #voice-section button, #voice-section .tts-engine > b, #tts-status, #tts-credit')].map((el) => (['SELECT', 'INPUT', 'BUTTON'].includes(el.tagName) ? d(el) : `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}: ${el.textContent}`))].join('\n');
      });
      fs.writeFileSync(path.join(SHOTS, 'v1-settings-dom.txt'), dom + '\n');
      assert.equal(dom.includes(mock.KEY), false);
      const credit = await page.textContent('#tts-credit');
      await page.locator('#tts-credit').scrollIntoViewIfNeeded();
      await shot('v1-default-auto-credit');
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
      await page.selectOption('#tts-provider', 'fish');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('Fish Audio'));
      return note(`engines offered: ${opts.join(' / ')}; credit: ${credit}; status line: ${status}; 按角色 without a MiniMax key: ${fmt(sp)}`);
    }, page);

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

    await step(S, 'V6 fallback on an HTTP error: the line goes to the system voice, Fish is paused for 5 minutes', async () => {
      mock.mode = '500';
      const sp = await speakLine('服务器出错的时候');
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, [{ provider: 'fish', reason: 'http-500' }]);
      const before = reqs();
      const sp2 = await speakLine('暂停期间的下一句');
      assert.equal(sp2.provider, 'system');
      assert.deepEqual(sp2.fellBackFrom, [{ provider: 'fish', reason: 'paused:http-500' }]);
      assert.equal(reqs(), before, 'no request while paused');
      await openVoice();
      await page.waitForFunction(() => document.getElementById('tts-status').textContent.includes('服务出错 500'));
      const status = await page.textContent('#tts-status');
      await shot('v6-fallback-http-500');
      return note(`${fmt(sp)} (system voice lang ${sp.lang} pitch ${sp.pitch} rate ${sp.rate}, ${sp.systemVoices} system voices); next: ${fmt(sp2)}; status line: ${status}`);
    }, page);

    await step(S, 'V7 fallback on a timeout: no answer in 4 s → system voice; the pet stays responsive', async () => {
      mock.mode = 'hang';
      await page.click('.tts-engine[data-engine="fish"] .tts-ep-save'); // saving resets the pause
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('端点'));
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
      assert.ok(ms >= 3800 && ms < 7000, `fell back after ${ms} ms`);
      const rq = mock.log[mock.log.length - 1];
      await page.waitForTimeout(300);
      return note(`${fmt(sp)}; fell back after ${ms} ms; request aborted=${rq.aborted}; UI probes while waiting: ${probes.join('/')} ms`);
    });

    await step(S, 'V8 fallback offline: navigator.onLine false → system voice without a request', async () => {
      mock.mode = 'ok';
      await page.click('.tts-engine[data-engine="fish"] .tts-ep-save');
      await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
      const before = reqs();
      const sp = await speakLine('断网的时候');
      await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true }));
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, [{ provider: 'fish', reason: 'offline' }]);
      assert.equal(reqs(), before);
      return note(fmt(sp));
    });

    await step(S, 'V9 fallback without a key: cleared in 语音 → system voice, no request', async () => {
      await openVoice();
      await page.click('.tts-engine[data-engine="fish"] .tts-key-del');
      await page.waitForFunction(() => document.getElementById('tts-status').textContent.includes('Fish Audio：没有 Key'));
      const before = reqs();
      const sp = await speakLine('没有钥匙的时候');
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, [{ provider: 'fish', reason: 'no-key' }]);
      assert.equal(reqs(), before);
      await shot('v9-no-key');
      return note(`${fmt(sp)}; status: ${await page.textContent('#tts-status')}`);
    }, page);

    await step(S, 'V10 fallback set to 不出声: the line stays silent', async () => {
      await page.selectOption('#tts-fallback', 'silent');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('不出声'));
      const sp = await speakLine('安静一点');
      assert.equal(sp.status, 'silent');
      assert.equal(sp.provider, null);
      await page.selectOption('#tts-fallback', 'system');
      return note(fmt(sp));
    }, page);

    await step(S, 'V11 按角色 (the default): 大肥鱼 reads with MiniMax, voice qiaopi_mengmei', async () => {
      await page.fill('.tts-engine[data-engine="minimax"] .tts-endpoint', mock.url);
      await page.click('.tts-engine[data-engine="minimax"] .tts-ep-save');
      await page.fill('.tts-engine[data-engine="minimax"] .tts-key', mock.MM_KEY);
      await page.click('.tts-engine[data-engine="minimax"] .tts-key-save');
      await page.selectOption('#tts-provider', 'auto');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('按角色'));
      assert.match(await page.textContent('#tts-credit'), /大肥鱼默认用 MiniMax。大肥鱼的音色：MiniMax 系统音色「俏皮萌妹」/);
      await page.waitForFunction(() => document.getElementById('tts-status').textContent.includes('MiniMax：Key 已设置'));
      await shot('v11-minimax-selected');
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
      await page.selectOption('#tts-provider', 'system');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('系统语音'));
      const before = reqs();
      const sp = await speakLine('用系统的声音');
      assert.equal(sp.provider, 'system');
      assert.deepEqual(sp.fellBackFrom, []);
      assert.equal(reqs(), before);
      return note(fmt(sp));
    });

    await step(S, 'V13 other characters keep their own default: 按角色 with both keys, 克洛蒂 on Fish', async () => {
      await page.fill('.tts-engine[data-engine="fish"] .tts-key', mock.KEY);
      await page.click('.tts-engine[data-engine="fish"] .tts-key-save');
      await page.selectOption('#tts-provider', 'auto');
      await page.click('#panel-close');
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
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'voice-log.txt'), evidence.join('\n') + '\n\nmock requests:\n' + mock.log.map((r) => JSON.stringify({ ...r, at: undefined })).join('\n') + '\n');
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
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { voice: true }, tts: { provider: 'fish', fallback: 'system', endpoints: { fish: mock.url, minimax: '' } } }));
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
  const openAdvanced = async () => {
    if (!(await page.isVisible('#behavior-section'))) {
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#behavior-section');
    }
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
    await step(S, 'I11 切换角色: ⋯ → 切换角色 → 克洛蒂 — her hello, then her greeting on coming back, read in her own Fish voice', async () => {
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

    await step(S, 'I13 碎碎念: not read by default; read after switching on 朗读碎碎念 in 高级设置', async () => {
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
      await openAdvanced();
      await page.locator('#behavior-section input[data-pref="voiceMurmurs"]').scrollIntoViewIfNeeded();
      await shot('i13-murmur-switch-off');
      await page.check('#behavior-section input[data-pref="voiceMurmurs"]');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('朗读碎碎念：开'));
      await shot('i13-murmur-switch-on');
      await page.click('#panel-close');
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
      await openAdvanced();
      await page.locator('#behavior-section input[data-pref="voice"]').scrollIntoViewIfNeeded();
      await page.uncheck('#behavior-section input[data-pref="voice"]');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('朗读回复：关'));
      await shot('i14-voice-off');
      await page.click('#panel-close');
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
  try {
    await step(S, 'C0 hatch 大肥鱼, switch 朗读 on and give Fish Audio its endpoint and key in 高级设置 → 语音', async () => {
      chapter('孵化大肥鱼，打开朗读并配置 Fish Audio');
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Fishy');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await idle();
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#voice-section');
      await page.locator('#behavior-section input[data-pref="voice"]').scrollIntoViewIfNeeded();
      await page.check('#behavior-section input[data-pref="voice"]');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('朗读回复：开'));
      await page.locator('#voice-section').scrollIntoViewIfNeeded();
      await page.fill('.tts-engine[data-engine="fish"] .tts-endpoint', mock.url);
      await page.click('.tts-engine[data-engine="fish"] .tts-ep-save');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('端点已改为'));
      await page.fill('.tts-engine[data-engine="fish"] .tts-key', mock.KEY);
      await page.click('.tts-engine[data-engine="fish"] .tts-key-save');
      await page.waitForFunction(() => document.getElementById('tts-status').textContent.includes('Fish Audio：Key 已设置'));
      await shot('c0-voice-on-fish-configured');
      await page.click('#panel-close');
      const st = await page.evaluate(async () => (await window.pet.getSettings()));
      assert.equal(st.prefs.voice, true);
      assert.equal(st.tts.provider, 'auto'); // 大肥鱼's MiniMax has no key here: her lines go to Fish
      return note(`prefs.voice=${st.prefs.voice} tts=${JSON.stringify(st.tts)}`);
    }, page);

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
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#voice-section');
      await page.locator('#behavior-section input[data-pref="voice"]').scrollIntoViewIfNeeded();
      const reading = await last();
      assert.ok(/^(playing|speaking)$/.test(reading.status), `still reading while the panel opens: ${reading.status}`);
      await page.uncheck('#behavior-section input[data-pref="voice"]');
      await page.waitForFunction(() => document.getElementById('panel-msg').textContent.includes('朗读回复：关'));
      const r = await last();
      const es = await log(sp.n);
      await shot('c3-voice-off-stopped');
      assert.equal(r.status, 'interrupted');
      assert.equal(r.stoppedBy, 'voice-off');
      assert.equal(await page.evaluate(() => window.petFx.audioState()), null);
      await page.waitForTimeout(1500);
      assert.equal((await log(sp.n)).length, es.length, 'nothing more was read after');
      await page.click('#panel-close');
      fs.writeFileSync(path.join(SHOTS, 'c3-speech-log.txt'), fmtLog(es) + '\n');
      return note(`#${sp.n} read [${es.filter((e) => e.event === 'start').map((e) => e.i).join(',')}] of ${sp.sentences.length}, then 朗读 off → status=${r.status} stoppedBy=${r.stoppedBy}, audio=null, nothing more read in 1.5 s`);
    }, page);
  } finally {
    fs.writeFileSync(path.join(SHOTS, 'chatvoice-log.txt'), evidence.join('\n\n') + '\n');
    fs.writeFileSync(path.join(SHOTS, 'chapters.json'), JSON.stringify(chapters, null, 2) + '\n');
    await app.close().catch(() => {});
    mock.server.close();
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
  if (which === 'update' || which === 'all') await update();
  if (which === 'art' || which === 'all') await art();
  if (which === 'roster' || which === 'all') await roster();
  if (which === 'touch' || which === 'all') await touch();
  if (which === 'voice' || which === 'all') await voice();
  if (which === 'ivoice' || which === 'all') await ivoice();
  if (which === 'chatvoice' || which === 'all') await chatvoice();
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
