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
const lhEnv = { ...process.env };
for (const k of ['LOBEHUB_TOPIC_ID', 'LOBEHUB_OPERATION_ID', 'LOBEHUB_AGENT_ID', 'LOBEHUB_ASSISTANT_MESSAGE_ID']) delete lhEnv[k];
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
    await step(S, 'first launch shows four eggs', async () => {
      await page.waitForSelector('.egg-card');
      assert.equal(await page.locator('.egg-card').count(), 4);
      assert.equal(await page.locator('#hatch-btn').isDisabled(), true);
    }, page);

    await step(S, 'choosing an egg enables hatching and shows its element', async () => {
      await page.locator('.egg-card').nth(1).click();
      assert.equal(await page.locator('#hatch-btn').isDisabled(), false);
      assert.match(await page.locator('#egg-info').textContent(), /水之灵石/);
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
      assert.match(await page.textContent('#meta'), /小蓝 · 泡鲸 · 陌生 ♥\d+ · 距「熟悉」\d+/);
      const text = await waitReply(page, 15000);
      assert.match(text, /echo:/);
      return `greeting: ${text.slice(0, 40)}`;
    }, page);

    await step(S, 'CLI call order was whoami -> login -> agent create -> connect device -> bind -> agent run', async () => {
      const calls = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
      const seq = calls.map((a) => (a[0] === 'agent' ? `agent ${a[1]}` : a[0]));
      const want = ['whoami', 'login', 'whoami', 'agent create', 'connect', 'connect', 'device', 'agent edit', 'agent run']; // connect = status check, then `connect --daemon`; device = `device list`
      assert.deepEqual(seq.slice(0, want.length), want);
      const created = JSON.parse(fs.readFileSync(path.join(fakeDir, 'last-create.json'), 'utf8'));
      assert.match(created.systemRole, /泡鲸/);
      assert.match(created.title, /小蓝/);
    });

    await step(S, 'restart goes straight to the pet (state persisted, no onboarding)', async () => {
      await app.close();
      ({ app, page } = await launch(env));
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      assert.equal(await page.locator('.egg-card').count() >= 0, true);
      assert.equal(await page.locator('#onboarding').isHidden(), true);
      assert.match(await page.textContent('#meta'), /小蓝/);
    }, () => page);

    await step(S, 'at rest only the pet is shown, with no buttons, bars or text box', async () => {
      assert.equal(await hudOpacity(page), '0');
      assert.equal(await page.evaluate(() => document.body.classList.contains('hover')), false);
      const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      assert.ok(b.width <= 240 && b.height <= 300, `window is ${b.width}x${b.height}`);
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
      await page.locator('#pet-canvas').click();
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

    await step(S, 'release deletes the agent through lh and returns to egg selection', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="release"]');
      await page.waitForSelector('#onboarding:not(.hidden)', { timeout: 15000 });
      const calls = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
      const del = calls.find((a) => a[0] === 'agent' && a[1] === 'delete');
      assert.ok(del && del[2].startsWith('agt_FAKE') && del.includes('--yes'), 'lh agent delete <id> --yes was not called');
      fs.writeFileSync(path.join(OUT, 'release-check.txt'), `$ ${del.length ? 'lh ' + del.join(' ') : ''}\n(recorded by the fake lh CLI used in this scenario; the app asked for the agent to be deleted, then returned to egg selection)\n`);
    }, () => page);
  } finally {
    await app.close().catch(() => {});
  }
}

// ------------------------------------------------------------- wardrobe
// The affection UI end to end on the real app: first-launch 18+ gate -> a pet -> interaction raises
// affection -> stage-up notice naming the unlocked topics and outfits -> wardrobe with locked items ->
// changing clothes -> restart keeps the outfit -> adult switch off falls back to an all-ages outfit.
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
  const petJson = () => JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
  const restartLog = [];
  const openWardrobe = async () => {
    await clickAct(page, 'wardrobe');
    await page.waitForSelector('#panel:not(.hidden) .card');
    await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
  };
  const closePanel = async () => {
    await page.click('#panel-close');
    await page.waitForFunction(() => window.innerWidth <= 240, null, { timeout: 5000 });
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
      await page.locator('.egg-card').nth(1).click();
      await page.fill('#pet-name', '小蓝');
      assert.match(await page.textContent('#egg-info'), /水之灵石/);
      const a = await shot('01b-new-pet-choose-companion');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await waitReply(page, 15000);
      await idle();
      await hover(page);
      assert.match(await page.textContent('#meta'), /小蓝 · 泡鲸/);
      const b = await shot('01c-new-pet-created');
      return `${a}, ${b} · settings.json: ${JSON.stringify(st)}`;
    });

    await step(S, 'initial state: affection bar, number, stage name and distance to the next stage', async () => {
      await hover(page);
      assert.equal((await page.textContent('#aff-stage')).trim(), '陌生');
      assert.equal((await page.textContent('#aff-num')).trim(), '♥0/100');
      assert.match(await page.textContent('#meta'), /小蓝 · 泡鲸 · 陌生 ♥0 · 距「熟悉」15/);
      assert.equal(petJson().equippedOutfit, 'daily');
      return `${await shot('02-initial-state')} · meta: ${await page.textContent('#meta')}`;
    });

    await step(S, 'a pat raises affection: the number goes up and +♥ floats over the pet', async () => {
      await page.locator('#pet-canvas').click();
      await page.waitForSelector('.float');
      const float = await page.textContent('.float');
      await hover(page);
      await page.waitForFunction(() => !/♥0\//.test(document.getElementById('aff-num').textContent));
      const f = await shot('03-affection-up');
      assert.match(float, /^\+\d+(\.\d)? ♥$/); // first interaction of the day: +3 greet bonus, +1 pat (x1.2 when happy)
      assert.ok((await view(page)).pet.affection >= 4);
      return `${f} · float "${float}" · meta: ${await page.textContent('#meta')}`;
    });

    await step(S, 'crossing 15 moves 陌生 -> 熟悉 and a notice names the unlocked topics and outfits', async () => {
      // Test hook: 14 points (a day's cap is 12, so reaching 15 by hand takes two days); the pat that crosses is real.
      await page.evaluate(() => window.pet.debugSet({ affection: 14, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await hover(page);
      await page.locator('#pet-canvas').click();
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 5000 });
      await idle();
      await page.waitForTimeout(800); // let the stage-up flash fade
      await hover(page);
      const toast = await page.textContent('#unlock-toast');
      assert.match(toast, /关系升级：熟悉（♥15）/);
      assert.match(toast, /解锁话题：「聊聊爱好」、「奇怪的冷知识」、「脑筋急转弯」/);
      assert.match(toast, /解锁服饰：「休闲卫衣」、「贝雷帽画家装」/);
      assert.equal(await page.locator('#btn-wardrobe .new-dot').isVisible(), true);
      return `${await shot('04-stage-up-unlock-notice')} · ${toast.replace(/\s+/g, ' ').trim()}`;
    });

    await step(S, 'the wardrobe lists every outfit; locked ones are greyed with a lock and their condition', async () => {
      await page.click('#toast-open');
      await page.waitForSelector('#panel:not(.hidden) .card');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.locator('.card').count(), 13);
      assert.equal(await page.locator('.card.locked').count(), 9);
      assert.equal(await cardStatus('daily'), '✓ 穿着中');
      assert.equal(await cardStatus('pajamas'), '🔒 亲近（♥35）解锁，还差 20');
      assert.equal(await cardStatus('maid'), '🔒 暧昧（♥60）解锁，还差 45');
      return await shot('05-wardrobe-with-locked-items');
    });

    await step(S, 'a locked outfit cannot be put on: the wardrobe says what unlocks it', async () => {
      await page.click('.card[data-outfit="pajamas"]');
      await page.waitForSelector('#panel-msg:not(.hidden)');
      assert.match(await page.textContent('#panel-msg'), /「毛绒睡衣」还没解锁：亲近（♥35）解锁，还差 20/);
      assert.equal(petJson().equippedOutfit, 'daily');
      return await shot('06-locked-outfit-refused');
    });

    await step(S, 'putting on an unlocked outfit changes the figure and marks it worn', async () => {
      await page.click('.card[data-outfit="casual"]');
      await page.waitForSelector('.card.equipped[data-outfit="casual"]');
      assert.equal(await page.getAttribute('#outfit-preview', 'data-outfit'), 'casual');
      assert.equal(await cardStatus('casual'), '✓ 穿着中');
      assert.equal(petJson().equippedOutfit, 'casual');
      const a = await shot('07-wardrobe-casual-equipped');
      await closePanel();
      await hover(page);
      return `${a}, ${await shot('08-pet-wearing-casual')} · pet.json equippedOutfit=casual`;
    });

    await step(S, 'the topic panel marks locked topics with their unlock condition', async () => {
      await clickAct(page, 'topics');
      await page.waitForSelector('#panel:not(.hidden) .topic');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.textContent('.topic[data-topic="riddle"] .st'), '点击聊聊');
      assert.equal(await page.textContent('.topic[data-topic="whine"] .st'), '🔒 亲近（♥35）解锁，还差 20');
      assert.match(await page.textContent('.topic[data-topic="tease"]'), /成人向.*🔒 暧昧（♥60）解锁/);
      return await shot('09-topics-with-locked-items');
    });

    await step(S, 'a topic unlocked at 熟悉 can be started: the agent gets it and the pet answers', async () => {
      await page.click('.topic[data-topic="riddle"]');
      await page.waitForFunction(() => window.innerWidth <= 240, null, { timeout: 5000 });
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
      await page.locator('#pet-canvas').click();
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 5000 });
      await idle();
      await page.waitForTimeout(800);
      await hover(page);
      const toast = await page.textContent('#unlock-toast');
      assert.match(toast, /关系升级：亲近（♥35）/);
      assert.match(toast, /解锁话题：「求安慰 \/ 打气」、「给彼此起昵称」、「撒娇模式」、「说说昨晚的怪梦」/);
      assert.match(toast, /解锁服饰：「毛绒睡衣」、「猫耳家居服」/);
      const f = await shot('11-stage-up-close');
      await page.click('#toast-close');
      return `${f} · ${toast.replace(/\s+/g, ' ').trim()}`;
    });

    await step(S, 'crossing 60 by a pat moves 亲近 -> 暧昧 and unlocks the adult-tier topics and outfits (18+ on)', async () => {
      await page.evaluate(() => window.pet.debugSet({ affection: 59, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await hover(page);
      await page.locator('#pet-canvas').click();
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 5000 });
      await idle();
      await page.waitForTimeout(800);
      await hover(page);
      const toast = await page.textContent('#unlock-toast');
      assert.match(toast, /关系升级：暧昧（♥60）/);
      assert.match(toast, /解锁话题：「交换小秘密」、「深夜谈心」、「调戏一下」、「吃醋模式」、「假装约会」/);
      assert.match(toast, /解锁服饰：「浴衣」、「女仆装」、「露肩晚礼服」/);
      return `${await shot('12-stage-up-flirty')} · ${toast.replace(/\s+/g, ' ').trim()}`;
    });

    await step(S, 'the topic panel now offers the 暧昧 topics; 恋人 topics stay locked', async () => {
      await page.click('#toast-close');
      await clickAct(page, 'topics');
      await page.waitForSelector('#panel:not(.hidden) .topic');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.textContent('.topic[data-topic="tease"] .st'), '点击聊聊');
      assert.match(await page.textContent('.topic[data-topic="sweet_talk"] .st'), /🔒 恋人（♥85）解锁/);
      await page.locator('.topic[data-topic="tease"]').scrollIntoViewIfNeeded();
      const f = await shot('13-topics-flirty-unlocked');
      await closePanel();
      return f;
    });

    await step(S, 'an adult outfit (maid) unlocked at 暧昧 can be worn while adult content is on', async () => {
      await openWardrobe();
      await page.click('.card[data-outfit="maid"]');
      await page.waitForSelector('.card.equipped[data-outfit="maid"]');
      assert.equal(petJson().equippedOutfit, 'maid');
      assert.equal(await page.locator('.card.locked').count(), 4);
      const a = await shot('14-wardrobe-maid-equipped-adult-on');
      await closePanel();
      await hover(page);
      return `${a}, ${await shot('15-pet-wearing-maid')}`;
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
      assert.equal(v.outfit, 'maid');
      assert.equal(v.affection.value, before.affection.value);
      assert.equal(v.affection.stageName, '暧昧');
      assert.deepEqual(v.topics.map((t) => [t.id, t.unlocked]), before.topics.map((t) => [t.id, t.unlocked]));
      assert.deepEqual(v.outfits.map((o) => [o.id, o.unlocked]), before.outfits.map((o) => [o.id, o.unlocked]));
      await hover(page);
      assert.equal((await page.textContent('#outfit-badge')).trim(), '👗 女仆装');
      assert.match(await page.textContent('#meta'), /暧昧 ♥60/);
      const a = await shot('16-after-restart-pet');
      await openWardrobe();
      assert.equal(await cardStatus('maid'), '✓ 穿着中');
      assert.equal(await page.locator('.card.locked').count(), 4);
      const b = await shot('17-after-restart-wardrobe');
      await closePanel();
      await clickAct(page, 'topics');
      await page.waitForSelector('#panel:not(.hidden) .topic');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.textContent('.topic[data-topic="tease"] .st'), '点击聊聊');
      const c = await shot('18-after-restart-topics');
      await closePanel();
      fs.writeFileSync(path.join(SHOTS, 'restart-log.txt'), restartLog.join('\n') + '\n');
      return `${a}, ${b}, ${c} · pid ${pid0} -> ${pid1}`;
    });

    await step(S, 'adult switch off: adult topics and outfits disappear and the pet changes back to its last all-ages outfit', async () => {
      await clickAct(page, 'menu');
      assert.equal((await page.textContent('#menu-adult')).trim(), '成人向内容：开（点此关闭）');
      const m = await shot('19-menu-adult-switch-on');
      await page.click('#menu-adult');
      await page.waitForFunction(() => /已换回「休闲卫衣」/.test(document.getElementById('bubble').textContent), null, { timeout: 5000 });
      const v = await view(page);
      assert.equal(v.outfit, 'casual');
      assert.equal(v.affection.stageName, '知己');
      assert.equal(petJson().equippedOutfit, 'casual');
      assert.deepEqual(v.topics.filter((t) => t.rating === 'adult'), []);
      assert.deepEqual(v.outfits.filter((o) => o.rating === 'adult'), []);
      await hover(page);
      const a = await shot('20-adult-off-pet-back-in-casual');
      await clickAct(page, 'menu');
      assert.equal((await page.textContent('#menu-adult')).trim(), '成人向内容：关（点此开启）');
      const b = await shot('21-menu-adult-switch-off');
      await page.locator('#main-menu').evaluate((el) => el.classList.add('hidden'));
      await openWardrobe();
      assert.equal(await page.locator('.card').count(), 9);
      assert.equal(await page.locator('.card[data-outfit="maid"]').count(), 0);
      assert.equal(await cardStatus('casual'), '✓ 穿着中');
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
  const old = { speciesId: 'bubbo', name: '小蓝', agentId: 'agt_LEGACY', topicId: 'tpc_LEGACY', createdAt: now - 86400000, stage: 'child', xp: 150, hunger: 30, mood: 70, energy: 90, sleeping: false, lastTickAt: now, lastInteractionAt: now, lastFedAt: now, lastSpokeAt: now, owner: 'me', personaVersion: 3 };
  fs.writeFileSync(path.join(data, 'pet.json'), JSON.stringify(old, null, 2));
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  try {
    await step(S, 'an old xp=150 / child save opens as 熟悉 ♥25 with the same agent and topic', async () => {
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 15000 });
      await hover(page);
      const meta = await page.textContent('#meta');
      assert.match(meta, /小蓝 · 泡鲸 · 熟悉 ♥25 · 距「亲近」10/);
      const v = await view(page);
      assert.equal(v.pet.agentId, 'agt_LEGACY');
      assert.equal(v.pet.topicId, 'tpc_LEGACY');
      const disk = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
      assert.equal(disk.schemaVersion, 2);
      assert.equal('xp' in disk, false);
      assert.equal('stage' in disk, false);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'pet.v1.bak.json'), 'utf8')), old);
      fs.writeFileSync(path.join(OUT, 'migrate-files.txt'), `--- pet.v1.bak.json (before) ---\n${JSON.stringify(old, null, 2)}\n\n--- pet.json (after) ---\n${JSON.stringify(disk, null, 2)}\n`);
      return `meta: ${meta}; legacy=${JSON.stringify(disk.legacy)}`;
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
  const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
  const clip = () => page.evaluate(() => document.getElementById('pet-video').dataset.key);
  try {
    await step(S, 'the egg screen offers four eggs and the fourth is the whale egg', async () => {
      await page.waitForSelector('.egg-card');
      assert.equal(await page.locator('.egg-card').count(), 4);
      assert.match(await page.locator('.egg-card').nth(3).textContent(), /鲸之灵石/);
      await page.locator('.egg-card').nth(3).click();
      assert.match(await page.locator('#egg-info').textContent(), /大肥鱼|鱼片/);
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
      assert.equal(await page.locator('#pet-canvas').isHidden(), true);
      // the pointer is still where the Hatch button was; a real user would move away
      await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
      await page.waitForFunction(() => getComputedStyle(document.getElementById('hud')).opacity === '0', null, { timeout: 5000 });
      const b = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      assert.ok(b.width <= 240 && b.height <= 300, `window is ${b.width}x${b.height}`);
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
    await page.waitForSelector('.egg-card');
    await page.locator('.egg-card').nth(0).click();
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
    await page.waitForSelector('.egg-card');
    await page.locator('.egg-card').nth(2).click();
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
    await page.waitForSelector('.egg-card');
    await page.locator('.egg-card').nth(1).click();
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
    await page.waitForSelector('.egg-card');
    await page.locator('.egg-card').nth(1).click();
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
    await page.waitForSelector('.egg-card');
    await step(S, 'real lh is logged in, so login is skipped and a real agent is created', async () => {
      await page.locator('.egg-card').nth(2).click();
      await page.uncheck('#local-opt'); // tests must never bind an agent to, or run tools on, a real computer
      await page.fill('#pet-name', '芽芽');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 120000 });
      const v = await view(page);
      agentId = v.pet.agentId;
      assert.match(agentId, /^agt_/);
      assert.equal(await page.locator('#login-box').isHidden(), true);
      return `agent ${agentId}`;
    }, page);

    await step(S, 'the LobeHub agent exists and carries the pet persona', async () => {
      const out = lh('agent', 'view', agentId);
      assert.match(out, /芽芽/);
      assert.match(out, /叶芽/);
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
      await page.fill('#chat-input', '这张图里有几个蛋？分别什么颜色？');
      await page.click('#chat-send');
      await page.waitForFunction(() => document.body.classList.contains('busy'), null, { timeout: 5000 });
      await idle();
      const b = (await bubbleText(page)).trim();
      await record('picture question (three eggs)');
      transcript.splice(transcript.length - 1, 0, '[picture sent] build/icon.png: 三颗像素蛋（米黄带橙点、浅蓝带蓝点、浅绿带绿点）+ 这张图里有几个蛋？分别什么颜色？');
      assert.match(b, /蛋/, `reply: ${b}`);
      assert.match(b, /三|3/, `reply: ${b}`);
      return b.slice(0, 60);
    }, page);

    await step(S, 'affection crossing 15 moves the stage from 陌生 to 熟悉', async () => {
      await page.evaluate(() => window.pet.debugSet({ affection: 14, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await page.locator('#pet-canvas').click();
      await page.waitForTimeout(1200);
      const v = await view(page);
      assert.equal(v.pet.relStage, 'familiar');
      assert.match(await page.textContent('#meta'), /熟悉 ♥15/);
    }, page);

    await step(S, 'release deletes the real agent and returns to egg selection', async () => {
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

// ------------------------------------------------------------------ art
// Contact sheet of every species x mood (adult body only), rendered by the app's own sprite code.
async function art() {
  const S = 'art';
  const { app, page } = await launch({ PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-art-')), LH_BIN: FAKE_LH, FAKE_LH_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'pp-artfake-')) });
  try {
    await page.waitForSelector('.egg-card');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 1000));
    await step(S, 'sprite sheet: 3 species x 5 moods (adult body only)', async () => {
      await page.evaluate(() => {
        const Sp = window.Sprites;
        document.body.innerHTML = '';
        const c = document.createElement('canvas');
        const sc = 4, cell = 24 * sc + 8, sts = ['idle', 'happy', 'sad', 'hungry', 'sleep'];
        const rows = [];
        for (const sp of ['embit', 'bubbo', 'sprig']) rows.push([sp]);
        c.width = sts.length * cell; c.height = rows.length * cell;
        c.style.cssText = 'position:fixed;left:0;top:0;background:#e9e4f5;image-rendering:pixelated';
        document.body.style.overflow = 'visible';
        document.body.appendChild(c);
        const ctx = c.getContext('2d');
        rows.forEach(([sp], r) => sts.forEach((status, i) => {
          const f = Sp.frame({ speciesId: sp, status, t: 0.3 });
          Sp.drawGrid(ctx, f.grid, (k) => Sp.colorFor(sp, k), sc, i * cell + 4, r * cell + 4 + f.dy * sc);
          for (const fx of f.effects) Sp.drawGrid(ctx, Sp.EFFECTS[fx.name], (k) => Sp.colorFor(sp, k), sc, i * cell + 4 + fx.x * sc, r * cell + 4 + fx.y * sc);
        }));
      });
      await page.screenshot({ path: path.join(OUT, 'sprite-sheet.png'), clip: { x: 0, y: 0, width: 5 * 104, height: 3 * 104 } });
      return 'rows: embit/bubbo/sprig (adult); columns: idle, happy, sad, hungry, sleep';
    });

    await step(S, 'outfit sheet: every outfit as an adult figure and on each pet', async () => {
      const ids = await page.evaluate(() => {
        const Sp = window.Sprites;
        const ids = Object.keys(Sp.OUTFIT_ART);
        document.body.innerHTML = '';
        const c = document.createElement('canvas');
        const cw = 64, fh = Sp.FIG.h * 2, ph = 24 * 2;
        c.width = ids.length * cw; c.height = fh + 3 * ph + 16;
        c.style.cssText = 'position:fixed;left:0;top:0;background:#e9e4f5;image-rendering:pixelated';
        document.body.appendChild(c);
        const ctx = c.getContext('2d');
        ids.forEach((id, i) => {
          Sp.drawGrid(ctx, Sp.figure(id), (k) => Sp.figureColor(id, 'bubbo', k), 2, i * cw + 10, 4);
          ['embit', 'bubbo', 'sprig'].forEach((sp, r) => {
            const f = Sp.frame({ speciesId: sp, status: 'idle', t: 0, outfit: id });
            Sp.drawGrid(ctx, f.grid, (k) => Sp.colorFor(sp, k, id), 2, i * cw + 8, fh + 8 + r * ph);
          });
        });
        return ids;
      });
      await page.screenshot({ path: path.join(OUT, 'outfit-sheet.png'), clip: { x: 0, y: 0, width: ids.length * 64, height: 54 * 2 + 3 * 48 + 16 } });
      return `columns: ${ids.join(', ')}; top row: adult figure, then embit/bubbo/sprig wearing it`;
    });
  } finally {
    await app.close().catch(() => {});
  }
}

(async () => {
  if (which === 'fresh' || which === 'all') await fresh();
  if (which === 'wardrobe' || which === 'all') await wardrobe();
  if (which === 'migrate' || which === 'all') await migrate();
  if (which === 'dafeiyu' || which === 'all') await dafeiyu();
  if (which === 'busy' || which === 'all') { await busy(); await longreply(); await daemonlaunch(); await oldlh(); }
  if (which === 'live' || which === 'all') await live();
  if (which === 'art' || which === 'all') await art();
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
