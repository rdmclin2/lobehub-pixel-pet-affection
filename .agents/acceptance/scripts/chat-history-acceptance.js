// Chat-history acceptance (T-1232): first launch → hatch → empty 聊天记录 → system lines (touch, proactive heartbeat)
// → two messages from the chat box → 聊天记录 list + detail. Fake lh (offline), real Electron app, test hooks on.
// Writes screenshots, e2e-run.webm (+ marks.json for chapters), run-log.txt and the final chat-log.json.
// usage: xvfb-run -a node .agents/acceptance/scripts/chat-history-acceptance.js <repo> <out dir>
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const [ROOT, OUT] = process.argv.slice(2);
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const log = [];
const marks = [];
const note = (s) => { const line = `[${new Date().toISOString()}] ${s}`; log.push(line); console.log(line); };
const mark = (kind, label) => marks.push({ kind, label, atMs: Date.now() - t0 });
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-t1232-'));
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-t1232fake-'));
  fs.writeFileSync(path.join(fake, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  note(`revision ${require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()} · data dir ${data}`);
  const app = await _electron.launch({
    args: ['.', '--no-sandbox'], cwd: ROOT,
    env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: data, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fake },
    recordVideo: { dir: path.join(OUT, 'video'), size: { width: 460, height: 540 } },
  });
  app.process().stdout.on('data', (d) => note(`[main stdout] ${String(d).trim()}`));
  const page = await app.firstWindow();
  page.on('console', (m) => note(`[renderer console.${m.type()}] ${m.text()}`));
  page.on('dialog', (d) => d.accept());
  const hover = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
  const act = async (a) => { await hover(); await page.click(`[data-act="${a}"]`); };
  const idle = () => page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
  const shot = async (n) => { await page.screenshot({ path: path.join(OUT, `${n}.png`) }); note(`screenshot ${n}.png`); };
  const bubble = () => page.evaluate(() => { const b = document.getElementById('bubble'); return { text: b.textContent.trim(), source: b.dataset.source || '', hidden: b.classList.contains('hidden') }; });
  const logged = () => JSON.parse(fs.readFileSync(path.join(data, 'chat-log.json'), 'utf8')).messages;
  const dumpLog = (label) => {
    const ms = logged();
    note(`chat-log.json after ${label}: ${ms.length} messages`);
    for (const m of ms) note(`   ${m.id} role=${m.role} origin=${m.origin} kind=${m.kind} turn=${m.turnId} 「${(m.text || '').slice(0, 60)}」`);
  };
  const openHistory = async () => {
    await act('menu');
    await page.waitForTimeout(500);
    await shot('4a-menu-entry');
    await page.click('[data-menu="history"]');
    await page.waitForSelector('#panel:not(.hidden)');
    await page.waitForFunction(() => document.getElementById('panel-title').textContent.startsWith('聊天记录') && document.querySelector('.history-empty, .history-item'));
    await page.waitForTimeout(400);
  };
  try {
    // 1. first launch from the clean clone: character picker → hatch → pet window
    mark('step', '1 首次启动：角色选择页');
    await page.waitForSelector('.char-card', { timeout: 60000 });
    await page.waitForTimeout(800);
    await shot('1a-first-launch-picker');
    await page.locator('.char-card[data-species="claude"]').click();
    if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await idle();
    await page.waitForTimeout(1200);
    mark('check', '1 桌宠窗口显示，唤醒问候气泡（greeting）');
    note(`pet screen visible; bubble ${JSON.stringify(await bubble())}`);
    await shot('1b-pet-window');
    dumpLog('hatch');

    // 5. empty state: nothing the owner started yet (only her greeting is logged)
    mark('step', '5 空状态：打开 ⋯ → 聊天记录');
    await openHistory();
    fs.renameSync(path.join(OUT, '4a-menu-entry.png'), path.join(OUT, '5a-menu-entry.png'));
    const empty = (await page.textContent('#panel')).replace(/\s+/g, ' ').trim();
    const emptyList = await page.evaluate(() => window.pet.historyList());
    note(`empty-state panel text: 「${empty}」; .history-item count=${await page.locator('.history-item').count()}; historyList()=${JSON.stringify(emptyList)}`);
    mark('check', '5 空状态提示，列表 0 条（日志里已有 1 条问候）');
    await shot('5b-empty-state');
    await page.click('#panel-close');
    await page.waitForTimeout(600);

    // 2. system-initiated lines: a real click on her body (touch), then a proactive heartbeat line (hungry)
    mark('step', '2 系统台词：点击身体（触摸）');
    await hover();
    await page.locator('#pet-body .pet-hit:not(.hidden)').first().click();
    await page.waitForFunction(() => !document.getElementById('bubble').classList.contains('hidden') && document.getElementById('bubble').textContent.trim(), null, { timeout: 8000 });
    await idle();
    await page.waitForTimeout(500);
    note(`touch bubble ${JSON.stringify(await bubble())}`);
    await shot('2a-touch-bubble');
    mark('step', '2 系统台词：心跳主动搭话（饿了）');
    await page.evaluate(() => window.pet.debugSet({ hunger: 90, lastSpokeAt: 0 }));
    await page.evaluate(() => window.pet.debugHeartbeat());
    await page.waitForFunction(() => /\[事件\]/.test(document.getElementById('bubble').textContent), null, { timeout: 15000 });
    await idle();
    await page.mouse.move(110, 150);
    await page.waitForTimeout(500);
    note(`proactive bubble ${JSON.stringify(await bubble())}`);
    mark('check', '2 主动搭话气泡出现（origin=proactive）');
    await shot('2b-proactive-bubble');
    dumpLog('system lines');

    // 3. the owner sends two messages from the chat box
    const sent = ['你好呀克洛蒂，今天过得怎么样？', '晚上一起看电影吧，你想看什么？'];
    for (const [i, text] of sent.entries()) {
      mark('step', `3 用户发送第 ${i + 1} 条消息`);
      if (!(await page.locator('#chat-input').isVisible())) await act('chat');
      await page.waitForSelector('#chat-input', { state: 'visible' });
      await page.fill('#chat-input', text);
      await page.waitForTimeout(400);
      if (i === 0) await shot('3a-typing-first-message');
      await page.press('#chat-input', 'Enter');
      await page.waitForFunction((t) => document.getElementById('bubble').textContent.includes(`echo: ${t}`), text, { timeout: 20000 });
      await idle();
      await page.mouse.move(110, 150);
      await page.waitForTimeout(500);
      note(`reply ${i + 1} bubble ${JSON.stringify(await bubble())}`);
      mark('check', `3 第 ${i + 1} 条消息得到回复`);
      await shot(`3${i ? 'c' : 'b'}-reply-${i + 1}`);
    }
    dumpLog('two user messages');

    // 4. 聊天记录: list only has the owner's conversation; detail shows it in full
    mark('step', '4 打开 ⋯ → 聊天记录');
    await openHistory();
    const items = await page.$$eval('.history-item', (bs) => bs.map((b) => ({ time: b.querySelector('.history-time').textContent, who: b.querySelector('.history-who').textContent, count: b.querySelector('.history-count').textContent, preview: b.querySelector('.history-preview').textContent })));
    const panelText = (await page.textContent('#panel')).replace(/\s+/g, ' ').trim();
    const list = await page.evaluate(() => window.pet.historyList());
    note(`history list items: ${JSON.stringify(items)}`);
    note(`history panel text: 「${panelText}」`);
    note(`historyList() → ${JSON.stringify(list)}`);
    const sys = logged().filter((m) => m.origin !== 'user');
    note(`system lines NOT in panel: ${sys.map((m) => `${m.origin}「${m.text.slice(0, 30)}」 in panel=${panelText.includes(m.text.slice(0, 20))}`).join(' | ')}`);
    mark('check', '4 列表只有 1 段用户会话（4 条），无问候/触摸/主动搭话');
    await shot('4b-history-list');
    mark('step', '4 点开会话详情');
    await page.click('.history-item');
    await page.waitForSelector('.history-thread');
    await page.waitForTimeout(400);
    const msgs = await page.$$eval('.history-msg', (ms) => ms.map((m) => ({ role: m.dataset.role, text: m.querySelector('.history-msg-text').textContent })));
    note(`detail messages: ${JSON.stringify(msgs)}`);
    mark('check', '4 详情显示两条用户消息与两条回复');
    await shot('4c-history-detail');
    await page.click('.history-back');
    await page.waitForSelector('.history-item');
    await page.waitForTimeout(500);
    mark('step', '4 ← 返回列表');
  } catch (e) {
    note(`FAILED: ${e.stack}`);
    await shot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    const v = page.video();
    await app.close().catch(() => {});
    if (v) { const p = await v.path(); fs.renameSync(p, path.join(OUT, 'e2e-run.webm')); note(`video e2e-run.webm`); }
    fs.writeFileSync(path.join(OUT, 'run-log.txt'), log.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify(marks, null, 2));
    try { fs.copyFileSync(path.join(data, 'chat-log.json'), path.join(OUT, 'chat-log.json')); } catch {}
  }
})();
