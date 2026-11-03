'use strict';
// 插个嘴 e2e (docs/interject.md): the real Electron app with the fake `lh` (test/fixtures/fake-lh.js; its
// `generate decide` answers the probability in <FAKE_LH_DIR>/decide.json — the mock jev). Standalone (run.js
// is not touched):
//
//   xvfb-run -a node e2e/interject.js        → out/e2e/interject/*.png, video/, evidence.json, chapters.json
//
// I0 hatch; 插个嘴 is off by default · I1 off: typing in her chat box → zero `lh generate decide` calls ·
// I2 设置窗口 → 玩法 → 主动搭话与好感 → 插个嘴: switch it on there · I3 a draft in her chat box → debounce → jev
// (mock 0.86 ≥ 0.7) → her remark in the bubble · I4 the owner answers 「别打扰我…」 → feedback mute → block rule ·
// I5 the next code draft is dropped by the rule (no decision call) · I6 the rule is deleted through the
// rules interface. I2c (before I3): a low probability (0.2) on a voice transcript → silence.
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'e2e', 'interject');
const FAKE_LH = path.join(ROOT, 'test', 'fixtures', 'fake-lh.js');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ij-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-ijfake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  const env = { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], cwd: ROOT, env, recordVideo: { dir: path.join(OUT, 'video'), size: { width: 460, height: 540 } } });
  const page = await app.firstWindow();
  const t0 = Date.now();
  const chapters = [];
  const evidence = [];
  const results = [];
  const chapter = (title) => chapters.push({ at: Math.round((Date.now() - t0) / 1000), title });
  const note = (s) => { evidence.push(s); console.log(`    ${s}`); };
  const decideCalls = () => { const f = path.join(fakeDir, 'decide-calls.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
  const mock = (o) => fs.writeFileSync(path.join(fakeDir, 'decide.json'), JSON.stringify(o));
  const shot = async (p, name) => { await p.waitForTimeout(200); await p.screenshot({ path: path.join(OUT, `${name}.png`) }); return `interject/${name}.png`; };
  const bubble = () => page.evaluate(() => { const b = document.getElementById('bubble'); return b.classList.contains('hidden') ? '' : b.textContent.trim(); });
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
  const hover = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
  const openChat = async () => { await hover(); if (!(await page.isVisible('#chat-input'))) await page.click('[data-act="chat"]'); await page.waitForSelector('#chat-input', { state: 'visible' }); };
  const typeDraft = async (text) => { await openChat(); await page.fill('#chat-input', ''); await page.type('#chat-input', text, { delay: 15 }); };
  const step = async (name, fn) => {
    try {
      const r = await fn();
      results.push({ name, status: 'pass', note: r || '' });
      console.log(`PASS  ${name}${r ? ` — ${r}` : ''}`);
    } catch (e) {
      results.push({ name, status: 'fail', note: String(e.message).slice(0, 300) });
      console.log(`FAIL  ${name} — ${String(e.message).split('\n')[0]}`);
      await shot(page, `fail-${results.length}`).catch(() => {});
    }
  };
  let admin = null;
  try {
    await step('I0 hatch; 插个嘴 is off by default (settings.interject.enabled = false)', async () => {
      chapter('I0 孵化克洛蒂：插个嘴默认关闭');
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
      return shot(page, 'i0-hatched');
    });

    await step('I1 off: typing a draft in her chat box makes zero `lh generate decide` calls', async () => {
      chapter('I1 关闭时在聊天框打字：零次 jev 调用');
      await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
      await typeDraft('终于把这个 bug 修好了！累死我了');
      await page.waitForTimeout(5500); // longer than the default 4 s debounce
      const n = decideCalls().length;
      const d = await page.evaluate(() => window.pet.interject.decisions());
      note(`关闭状态：decide 调用 ${n} 次，判断记录 ${d.decisions.length} 条，status=${JSON.stringify(d.status)}`);
      assert.equal(n, 0);
      assert.equal(d.decisions.length, 0);
      await page.fill('#chat-input', '');
      return shot(page, 'i1-off-typing');
    });

    await step('I2 设置窗口 → 主动搭话与好感 → 插个嘴: switched on in the console (debounce 1 s)', async () => {
      chapter('I2 设置窗口里打开插个嘴');
      await page.evaluate(() => window.pet.openAdmin('proactive'));
      for (let i = 0; i < 300 && !admin; i++) { admin = app.windows().find((p) => p.url().includes('admin-ui')) || null; if (!admin) await new Promise((r) => setTimeout(r, 100)); }
      assert.ok(admin, 'settings window opened');
      await admin.waitForSelector('[data-path="/proactive"]', { timeout: 15000 });
      await admin.waitForSelector('[data-key="interject.enabled"]', { timeout: 15000 });
      await admin.evaluate(() => document.querySelector('[data-key="interject.enabled"]').scrollIntoView({ block: 'start' }));
      await shot(admin, 'i2a-console-off');
      await admin.evaluate(() => document.querySelector('[data-key="interject.enabled"]').click());
      for (let i = 0; i < 50; i++) { if ((await page.evaluate(() => window.pet.getSettings())).interject.enabled) break; await page.waitForTimeout(100); }
      assert.equal((await admin.evaluate(() => window.petAdmin.set('interject.debounceSec', 1))).ok, true);
      await admin.waitForSelector('[data-key="interject.sources.chatDraft"]', { timeout: 5000 });
      await admin.evaluate(() => document.querySelector('[data-key="interject.enabled"]').scrollIntoView({ block: 'start' }));
      // 勿扰时段 (default 23–8): judged on the machine's real clock; an input now is dropped there when it is quiet time
      await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
      await page.evaluate(() => window.pet.debugInterjectInput('voice', '今天的天气真不错呀'));
      const q = await page.evaluate(() => window.pet.debugInterjectFlush());
      note(`本机时间 ${new Date().toTimeString().slice(0, 5)}，默认勿扰 23–8 点：一条语音输入 → ${q ? `${q.stage}/${q.reason}` : 'null'}；decide 调用 ${decideCalls().length}`);
      if (new Date().getHours() >= 23 || new Date().getHours() < 8) assert.equal(q.reason, 'quiet-hours');
      // for the rest of the run: no quiet hours (start = end), set in the console like the owner would
      assert.equal((await admin.evaluate(() => window.petAdmin.set('interject.quietStart', 0))).ok, true);
      assert.equal((await admin.evaluate(() => window.petAdmin.set('interject.quietEnd', 0))).ok, true);
      const s = (await page.evaluate(() => window.pet.getSettings())).interject;
      note(`设置窗口打开后 settings.interject = ${JSON.stringify(s)}`);
      assert.equal(s.enabled, true);
      assert.equal(s.debounceSec, 1);
      const p = await shot(admin, 'i2b-console-on');
      await page.bringToFront();
      return p;
    });

    await step('I2c a low probability (mock 0.2 ≤ 0.3) → she stays quiet', async () => {
      chapter('I2c jev 0.2 → 不插嘴');
      mock({ probability: 0.2 });
      await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
      const before = decideCalls().length;
      const shown = await bubble();
      await page.evaluate(() => window.pet.debugInterjectInput('voice', '提醒我明天早上九点交报告')); // as a voice transcript would
      await page.evaluate(() => window.pet.debugInterjectFlush());
      const d = (await page.evaluate(() => window.pet.interject.decisions())).decisions.pop();
      note(`低概率记录: ${JSON.stringify(d)}`);
      assert.equal(decideCalls().length, before + 1);
      assert.equal(d.verdict, 'skip');
      assert.equal(d.reason, 'confident-no');
      assert.equal(await bubble(), shown, 'the bubble did not change');
      return shot(page, 'i2c-low-quiet');
    });
    await step('I3 a draft in her chat box → jev (mock 0.86 ≥ 0.7) → her remark in the bubble', async () => {
      chapter('I3 聊天框草稿 → jev 0.86 → 气泡里插一句');
      mock({ probability: 0.86 });
      await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
      const before = decideCalls().length;
      await typeDraft('终于把这个 bug 修好了！累死我了');
      await page.waitForFunction(() => /辛苦啦/.test(document.getElementById('bubble').textContent), null, { timeout: 20000 });
      await idle();
      const calls = decideCalls().slice(before);
      const rec = (await page.evaluate(() => window.pet.interject.decisions())).decisions.pop();
      note(`decide 调用 ${calls.length} 次；model=${calls[0].model}；问题=${JSON.stringify(calls[0].questions.interject.instructions).slice(0, 90)}…`);
      note(`jev state:\n${calls[0].state}`);
      note(`判断记录: ${JSON.stringify(rec)}`);
      note(`气泡: 「${await bubble()}」`);
      assert.equal(calls.length, 1);
      assert.match(calls[0].state, /终于把这个 bug 修好了/);
      assert.equal(rec.verdict, 'interject');
      assert.equal(rec.probability, 0.86);
      return shot(page, 'i3-remark-bubble');
    });

    await step('I4 the owner answers 「别打扰我，正写代码呢」 → feedback mute → block rule on 写代码', async () => {
      chapter('I4 回一句别打扰 → 沉淀成规则');
      await openChat();
      await page.fill('#chat-input', '别打扰我，正写代码呢');
      await page.press('#chat-input', 'Enter');
      await page.waitForFunction(() => /echo:/.test(document.getElementById('bubble').textContent), null, { timeout: 20000 });
      await idle();
      const { rules } = await page.evaluate(() => window.pet.interject.rules());
      const d = (await page.evaluate(() => window.pet.interject.decisions())).decisions.pop();
      note(`反馈: ${d.feedback}；规则: ${JSON.stringify(rules)}`);
      assert.equal(d.feedback, 'mute');
      assert.equal(rules.length, 1);
      assert.equal(rules[0].effect, 'block');
      assert.equal(rules[0].category, 'code');
      return shot(page, 'i4-mute-rule');
    });

    await step('I5 the next code draft is dropped by the rule: no decision call, no remark', async () => {
      chapter('I5 同类草稿被规则拦下，不调用 jev');
      mock({ probability: 0.95 });
      await page.evaluate(() => window.pet.debugSet({ lastSpokeAt: 0 }));
      const before = decideCalls().length;
      await typeDraft('npm test 又报错了，stack trace 一大串');
      await page.waitForTimeout(2500);
      const d = (await page.evaluate(() => window.pet.interject.decisions())).decisions.pop();
      const after = decideCalls().length;
      note(`拦截记录: ${JSON.stringify(d)}；decide 调用 ${before} → ${after}`);
      assert.equal(after, before);
      assert.equal(d.stage, 'prefilter');
      assert.equal(d.reason, 'rule');
      assert.doesNotMatch(await bubble(), /辛苦啦/, 'no new remark');
      await page.fill('#chat-input', '');
      return shot(page, 'i5-rule-blocks');
    });

    await step('I6 rules interface: list and delete (for the rules UI of the next task)', async () => {
      chapter('I6 规则查看 / 删除接口');
      const { rules } = await page.evaluate(() => window.pet.interject.rules());
      const r = await page.evaluate((id) => window.pet.interject.deleteRule(id), rules[0].id);
      const left = (await page.evaluate(() => window.pet.interject.rules())).rules;
      note(`deleteRule(${rules[0].id}) → ${JSON.stringify(r)}；剩余规则 ${left.length} 条`);
      assert.deepEqual(r, { ok: true });
      assert.equal(left.length, 0);
      const file = JSON.parse(fs.readFileSync(path.join(data, 'interject.json'), 'utf8'));
      note(`interject.json: rules ${file.rules.length}，decisions ${file.decisions.length}`);
      fs.writeFileSync(path.join(OUT, 'interject.json'), JSON.stringify(file, null, 2));
    });

  } finally {
    if (admin) await admin.close().catch(() => {});
    await app.close().catch(() => {});
    const vids = fs.existsSync(path.join(OUT, 'video')) ? fs.readdirSync(path.join(OUT, 'video')) : [];
    fs.writeFileSync(path.join(OUT, 'chapters.json'), JSON.stringify(chapters, null, 2));
    fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ results, evidence, videos: vids }, null, 2));
    const failed = results.filter((r) => r.status === 'fail').length;
    console.log(`\n${results.length - failed}/${results.length} passed; video ${vids.join(', ')}`);
    process.exit(failed ? 1 : 0);
  }
})().catch((e) => { console.error(e); process.exit(2); });
