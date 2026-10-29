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

    await step(S, 'CLI call order was whoami -> login -> workspaces -> agent create -> connect device -> bind -> agent run', async () => {
      const calls = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
      const all = calls.map((a) => (a[0] === 'agent' || a[0] === 'workspace' ? `${a[0]} ${a[1]}` : a[0]));
      // where to put the agent is asked right after login (workspace list + the pinned-scope check)
      const create = all.indexOf('agent create');
      assert.ok(all.slice(0, create).includes('workspace list') && all.slice(0, create).includes('workspace current'), all.join(', '));
      const seq = all.filter((c) => !c.startsWith('workspace '));
      const want = ['whoami', 'login', 'whoami', 'whoami', 'agent create', 'connect', 'connect', 'device', 'agent edit', 'agent run']; // connect = status check, then `connect --daemon`; device = `device list`
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
      assert.ok(b.width <= 240 && b.height <= 340, `window is ${b.width}x${b.height}`);
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
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
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
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
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
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
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

    await step(S, 'the wardrobe lists every outfit she has; locked ones are greyed with a lock and their condition', async () => {
      await page.click('#toast-open');
      await page.waitForSelector('#panel:not(.hidden) .card');
      await page.waitForFunction(() => window.innerWidth >= 440, null, { timeout: 5000 });
      assert.equal(await page.locator('.card').count(), 9, 'DeepSeek has 9 all-ages outfits');
      assert.equal(await page.locator('.card.locked').count(), 5);
      assert.equal(await cardStatus('daily'), '✓ 穿着中');
      assert.equal(await page.textContent('.card[data-outfit="daily"] .nm'), '招牌女仆装');
      assert.equal(await cardStatus('pajamas'), '🔒 亲近（♥35）解锁，还差 20');
      assert.equal(await page.locator('.card[data-outfit="maid"]').count(), 0, 'no adult outfit, even with 18+ on: model-chan are all-ages');
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
      assert.equal(await page.locator('.topic[data-topic="tease"]').count(), 0, 'no adult topic for an all-ages character');
      assert.match(await page.textContent('.topic[data-topic="secret"] .st'), /🔒 知己（♥60）解锁/);
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
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
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

    await step(S, 'crossing 60 by a pat moves 亲近 -> 知己: an all-ages character unlocks no adult topics or outfits, even with 18+ on', async () => {
      await page.evaluate(() => window.pet.debugSet({ affection: 59, mood: 50, hunger: 30, sleeping: false, dailyCounts: { greet: 1 }, lastAffectionAt: {}, affectionToday: 0 }));
      await hover(page);
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
      await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 5000 });
      await idle();
      await page.waitForTimeout(800);
      await hover(page);
      const toast = await page.textContent('#unlock-toast');
      assert.match(toast, /关系升级：知己（♥60）/);
      assert.equal((await page.textContent('#toast-body')).trim(), '解锁话题：「交换小秘密」、「深夜谈心」解锁服饰：「浴衣」');
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

    await step(S, 'the yukata unlocked at 知己 can be worn', async () => {
      await openWardrobe();
      await page.click('.card[data-outfit="yukata"]');
      await page.waitForSelector('.card.equipped[data-outfit="yukata"]');
      assert.equal(petJson().equippedOutfit, 'yukata');
      assert.equal(await page.locator('.card.locked').count(), 2);
      const a = await shot('14-wardrobe-yukata-equipped');
      await closePanel();
      await hover(page);
      return `${a}, ${await shot('15-pet-wearing-yukata')}`;
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
      assert.equal(v.outfit, 'yukata');
      assert.equal(v.affection.value, before.affection.value);
      assert.equal(v.affection.stageName, '知己');
      assert.deepEqual(v.topics.map((t) => [t.id, t.unlocked]), before.topics.map((t) => [t.id, t.unlocked]));
      assert.deepEqual(v.outfits.map((o) => [o.id, o.unlocked]), before.outfits.map((o) => [o.id, o.unlocked]));
      await hover(page);
      assert.equal((await page.textContent('#outfit-badge')).trim(), '👗 浴衣');
      assert.match(await page.textContent('#meta'), /知己 ♥60/);
      const a = await shot('16-after-restart-pet');
      await openWardrobe();
      assert.equal(await cardStatus('yukata'), '✓ 穿着中');
      assert.equal(await page.locator('.card.locked').count(), 2);
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
      assert.equal(v.outfit, 'yukata');
      assert.equal(v.affection.stageName, '知己');
      assert.equal(petJson().equippedOutfit, 'yukata');
      assert.deepEqual(v.topics.filter((t) => t.rating === 'adult'), []);
      assert.deepEqual(v.outfits.filter((o) => o.rating === 'adult'), []);
      await hover(page);
      const a = await shot('20-adult-off-pet-unchanged');
      await clickAct(page, 'menu');
      assert.equal((await page.textContent('#menu-adult')).trim(), '成人向内容：关（点此开启）');
      const b = await shot('21-menu-adult-switch-off');
      await page.locator('#main-menu').evaluate((el) => el.classList.add('hidden'));
      await openWardrobe();
      assert.equal(await page.locator('.card').count(), 9);
      assert.equal(await page.locator('.card[data-outfit="maid"]').count(), 0);
      assert.equal(await cardStatus('yukata'), '✓ 穿着中');
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
      assert.equal(disk.schemaVersion, 2);
      assert.equal(disk.speciesId, 'dafeiyu');
      assert.equal(disk.retiredFrom.speciesId, 'bubbo');
      assert.equal('xp' in disk, false);
      assert.equal('stage' in disk, false);
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

// ------------------------------------------------------------- dafeiyu
async function dafeiyu() {
  const S = 'dafeiyu';
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dfy-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dfyfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
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
      assert.ok(b.width <= 240 && b.height <= 340, `window is ${b.width}x${b.height}`);
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
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
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
      assert.match(await page.textContent('#panel-sub'), /陌生 ♥\d+/);
      assert.equal(await page.locator('#unlock-all').isDisabled(), false);
      return await page.textContent('#panel-sub');
    }, page);

    await step(S, 'one click unlocks every stage, topic and outfit (18+ on; 大肥鱼 is all-ages, so all-ages content only)', async () => {
      await page.click('#unlock-all');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)', { timeout: 10000 });
      const msg = await page.textContent('#panel-msg');
      assert.match(msg, /已解锁：\d+ 个话题、\d+ 套服饰/);
      assert.match(await page.textContent('#panel-sub'), /挚友 ♥100\/100 · 已满级 · 话题 13\/13 · 服饰 9\/9/);
      assert.equal(await page.locator('#unlock-all').isDisabled(), true);
      return msg;
    }, page);

    await step(S, 'the wardrobe shows everything unlocked and the last-stage outfit can be put on', async () => {
      await idle();
      await page.click('#panel-close');
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('.card[data-outfit="flower_crown"]');
      assert.equal(await page.locator('.card.locked').count(), 0);
      assert.equal(await page.locator('.card').count(), 9);
      await page.click('.card[data-outfit="flower_crown"]');
      await page.waitForSelector('#panel-msg.ok:not(.hidden)');
      await page.screenshot({ path: path.join(OUT, 'advanced-wardrobe-all-unlocked.png') });
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key.endsWith('/flower_crown'));
      assert.match(await page.textContent('#meta'), /挚友 ♥100 · 已满级/);
      return 'pet now wears 花冠长裙';
    }, page);

    const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
    const stageBox = () => page.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
    const scaleVar = () => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')));
    const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).petScale;
    await step(S, 'dragging the corner handle up-left resizes the pet freely; the window follows, bottom-right corner stays put', async () => {
      const before = await bounds();
      const stage0 = await stageBox();
      await hover(page);
      const g = await page.locator('#resize-grip').boundingBox();
      await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(g.x + g.width / 2 - i * 10, g.y + g.height / 2 - i * 10);
      await page.mouse.up();
      await page.waitForFunction(() => !document.body.classList.contains('resizing'));
      await page.waitForTimeout(300);
      const k = await scaleVar();
      const after = await bounds();
      const stage1 = await stageBox();
      assert.ok(k > 1.2 && k < 2.5, `scale ${k}`);
      assert.equal(saved(), k, 'saved on release');
      assert.ok(after.height > before.height && after.width >= before.width);
      assert.equal(after.x + after.width, before.x + before.width, 'right edge kept');
      assert.equal(after.y + after.height, before.y + before.height, 'bottom edge kept');
      assert.ok(Math.abs(stage1.h - stage0.h * k) <= 2, `stage ${stage1.h} vs ${stage0.h} x ${k}`);
      await page.mouse.move(1, 1);
      await page.screenshot({ path: path.join(OUT, 'pet-size-dragged.png') });
      return `scale ${k}: window ${before.width}x${before.height} -> ${after.width}x${after.height}; stage ${stage0.h} -> ${stage1.h}px`;
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
  const openAdvanced = async () => { await clickAct(page, 'menu'); await page.click('[data-menu="advanced"]'); await page.waitForSelector('.pack-list .pack-opt'); };
  try {
    await page.waitForSelector('.char-card');
    await page.locator('.char-card').nth(2).click();
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });

    await step(S, '格萝可 is an animated pixel sprite from grok-pixel; dragging plays the lifted action', async () => {
      assert.equal(await key(), 'grok-pixel/daily');
      assert.equal(await page.locator('#pet-look canvas.sprite.pixelated').count(), 1);
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

    await step(S, 'an imported pack is listed as imported, can be used, and the advanced list names it', async () => {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mypack-'));
      const base = path.join(ROOT, 'src', 'renderer', 'packs', 'grok-pixel');
      const m = JSON.parse(fs.readFileSync(path.join(base, 'pack.json'), 'utf8'));
      fs.mkdirSync(path.join(src, 'sheets'));
      fs.copyFileSync(path.join(base, 'sheets', 'daily.png'), path.join(src, 'sheets', 'mine.png'));
      fs.writeFileSync(path.join(src, 'pack.json'), JSON.stringify({ ...m, id: 'my-grok', name: '我的格萝可', author: 'tester', outfits: { daily: 'sheets/mine.png' } }));
      const r = await page.evaluate((d) => window.pet.debugImportPack(d), src);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(fs.existsSync(path.join(data, 'packs', 'my-grok', 'pack.json')), 'copied into the user pack folder');
      await openAdvanced();
      const names = await page.locator('.pack-opt[data-pack] .meta b').allTextContents();
      assert.deepEqual(names.sort(), ['我的格萝可', '格萝可 · 像素'].sort());
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
      await openAdvanced();
      await page.click('.pack-opt[data-pack="my-grok"] .btn:not(.pick)');
      await page.waitForFunction(() => !document.querySelector('.pack-opt[data-pack="my-grok"]'));
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'grok-pixel/daily');
      assert.equal(fs.existsSync(path.join(data, 'packs', 'my-grok')), false);
    }, page);

    await step(S, '大肥鱼 switches between her animated clips and her pixel pack', async () => {
      await openAdvanced();
      await page.click('.char-opt[data-species="dafeiyu"] .pick');
      await page.waitForSelector('.char-opt.on[data-species="dafeiyu"]');
      const names = await page.locator('.pack-opt[data-pack] .meta b').allTextContents();
      assert.deepEqual(names.sort(), ['大肥鱼 · 像素', '大肥鱼 · 立绘'].sort());
      await page.click('#panel-close');
      await page.waitForSelector('#vwrap:not(.hidden)');
      await page.waitForFunction(() => /dafeiyu\/(idle|hatch)\.webm$/.test(document.getElementById('pet-video').src), null, { timeout: 5000 });
      await openAdvanced();
      await page.click('.pack-opt[data-pack="dafeiyu-pixel"] .pick');
      await page.waitForSelector('.pack-opt.on[data-pack="dafeiyu-pixel"]');
      await page.click('#panel-close');
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily');
      assert.equal(await page.locator('#vwrap').isHidden(), true);
      await page.screenshot({ path: path.join(OUT, 'pack-dafeiyu-pixel.png') });
      await openAdvanced();
      await page.click('.pack-opt[data-pack="dafeiyu-illustrated"] .pick');
      await page.click('#panel-close');
      await page.waitForSelector('#vwrap:not(.hidden)');
      return `${names.join(' / ')}; clips → dafeiyu-pixel → clips`;
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
      rows.push({ name: 'dafeiyu (clips)', cells: STATES.map((st) => ({ clip: `${sp.clipDir}/${sp.clips[Fx.resolveAction(st, (n) => !!sp.clips[n]).name]}`, exact: Fx.resolveAction(st, (n) => !!sp.clips[n]).exact })) });
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
      if (ch.id === 'dafeiyu') {
        assert.match(await page.evaluate(() => document.getElementById('hatch-video').src), /dafeiyu\/hatch\.webm$/);
        return 'hatch.webm';
      }
      assert.equal(await page.locator('#hatch-look canvas.sprite').count(), 1);
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
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
      await page.waitForFunction(() => ['pat', 'happy'].includes(window.petFx.state().state), null, { timeout: 4000 });
      const squash = await page.evaluate(() => document.getElementById('pet-body').classList.contains('squash'));
      assert.equal(squash, true, 'squash');
      await page.waitForTimeout(150);
      const st = await fxState();
      const hearts = await page.locator('.heart-p').count();
      assert.ok(hearts > 0, 'heart particles');
      return `${await shows(st.state, st.video ? st.state : st.state)}, squash, ${hearts} hearts`;
    }, page);
    await step(S, 'E4b the next click picks the other reaction', async () => {
      const first = (await fxState()).state;
      await page.waitForTimeout(3200);
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
      await page.waitForFunction((f) => ['pat', 'happy'].includes(window.petFx.state().state) && window.petFx.state().state !== f, first, { timeout: 4000 });
      return `${first} → ${(await fxState()).state}`;
    }, page);
    await step(S, 'E5 dragged: she is lifted (dangling)', async () => {
      await settle();
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
      await page.screenshot({ path: path.join(OUT, `${S}-lifted.png`) });
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
    await step(S, 'E13 a wardrobe with her own outfits', async () => {
      await idle();
      await page.click('#toast-close');
      await clickAct(page, 'wardrobe');
      await page.waitForSelector('#panel:not(.hidden) .card');
      const ids = await page.$$eval('.card', (els) => els.map((e) => e.dataset.outfit));
      const label = await page.textContent('.card[data-outfit="daily"] .nm');
      if (ch.id === 'dafeiyu') assert.equal(ids.length, 9);
      else assert.deepEqual(ids, ['daily']);
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
      if (ws.video) assert.equal(await clip(), 'walk');
      else assert.equal(await page.textContent('#char-fx'), '👣');
      await page.waitForTimeout(900);
      await page.screenshot({ path: path.join(OUT, `${S}-walk.png`) });
      await walking;
      const after = await mainBounds();
      const w = (await page.evaluate(() => window.petFx.stats())).lastWalk;
      assert.notEqual(after.x, before.x, 'the window moved');
      assert.equal(after.x, w.to);
      assert.ok(Math.abs(after.x - before.x) >= 60 && Math.abs(after.x - before.x) <= 240 * 2);
      return `${st}; window x ${before.x} → ${after.x} (facing ${w.facing})${(await fxState()).video ? '' : ', idle frames hop + 👣'}`;
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
    await step(S, 'N8 settings: 桌宠行为 switches (roam on, sound / voice off, memes and collisions on by default)', async () => {
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector('#behavior-section');
      const prefs = await page.$$eval('#behavior-section input[data-pref]', (els) => els.map((e) => `${e.dataset.pref}=${e.checked ? 'on' : 'off'}`));
      assert.deepEqual(prefs, ['roam=on', 'clickSound=off', 'voice=off', 'memes=on', 'collide=on']);
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
      await page.locator('#pet-body .pet-hit:not(.hidden)').click();
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
    await step(S, 'E14 switch character from the advanced settings, keeping the agent and affection', async () => {
      if (await page.isVisible('#panel-close')) await page.click('#panel-close');
      await still();
      const next = ROSTER[(ch.idx + 1) % ROSTER.length];
      const before = await view(page);
      await clickAct(page, 'menu');
      await page.click('[data-menu="advanced"]');
      await page.waitForSelector(`.char-opt[data-species="${next.id}"] .pick`);
      await page.click(`.char-opt[data-species="${next.id}"] .pick`);
      await page.waitForSelector(`.char-opt.on[data-species="${next.id}"]`);
      await page.screenshot({ path: path.join(OUT, `${S}-switch-panel.png`) });
      await page.click('#panel-close');
      const after = await view(page);
      assert.equal(after.pet.speciesId, next.id);
      assert.equal(after.pet.agentId, before.pet.agentId);
      assert.equal(after.pet.affection, before.pet.affection);
      await page.waitForFunction(() => window.petFx.state().state === 'hatch', null, { timeout: 4000 });
      return `${ch.id} → ${next.id}; agent ${after.pet.agentId} kept, ♥${after.pet.affection}`;
    }, page);
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
  if (which === 'space' || which === 'all') await space();
  if (which === 'advanced' || which === 'all') await advanced();
  if (which === 'packs' || which === 'all') await packs();
  if (which === 'update' || which === 'all') await update();
  if (which === 'art' || which === 'all') await art();
  if (which === 'roster' || which === 'all') await roster();
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
