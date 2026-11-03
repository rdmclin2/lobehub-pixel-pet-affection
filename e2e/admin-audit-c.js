'use strict';

// 设置窗口 IA 打磨 · 实施包 C（docs/admin-audit/02-plan.md §5.4）：聊天、插个嘴、话题 / 桌面上的她、商店的前后对照截图。
// `xvfb-run -a node e2e/run.js auditc`（fake lh，不花 token）。PIXELPET_AUDIT_PHASE=before|after 决定截图前缀
// （C-before-* / C-after-*）；after 阶段同时断言 C01～C14 的可见行为。截图写到 docs/admin-audit/screenshots/。
// 失败态用主进程替换 IPC handler 注入（interject-rules / admin-chat-history / interject-clear-decisions / talk-topic）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

module.exports = function auditC(ctx) {
  const { ROOT, FAKE_LH, step, launch, openAdminWindow, adminUntil, clickAct } = ctx;
  const PHASE = process.env.PIXELPET_AUDIT_PHASE === 'before' ? 'before' : 'after';
  const AFTER = PHASE === 'after';
  const SHOTS = path.join(ROOT, 'docs', 'admin-audit', 'screenshots');
  const S = `auditc-${PHASE}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // a rule and three decisions already on disk, so the tables and 清空记录 have something to show
  const seedInterject = (dir) => {
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'interject.json'), JSON.stringify({
      version: 1,
      rules: [{ id: 'r_seed0001', effect: 'block', source: 'clipboard', origin: 'mute', createdAt: now - 3600e3, hits: 2 }],
      decisions: [
        { id: 'd_seed1', at: now - 900e3, source: 'chatDraft', summary: '今天的周报还没写完', probability: 0.82, verdict: 'interject', stage: 'verdict', reason: 'confident', said: '周报加油，写完奖励自己一杯奶茶！' },
        { id: 'd_seed2', at: now - 600e3, source: 'voice', summary: '帮我订明天的会议室', probability: 0.31, verdict: 'skip', stage: 'verdict', reason: 'uncertain' },
        { id: 'd_seed3', at: now - 300e3, source: 'chatDraft', summary: '嗯', probability: null, verdict: 'skip', stage: 'prefilter', reason: 'too-short' },
      ],
    }));
  };

  return async function run() {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auditc-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auditcfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    seedInterject(data);
    const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir });
    let admin = null;
    const shot = async (name, full = false) => {
      const f = `C-${PHASE}-${name}.png`;
      await sleep(350);
      await admin.screenshot({ fullPage: full, path: path.join(SHOTS, f) });
      return f;
    };
    const go = async (route) => {
      await admin.evaluate((r) => { location.hash = r; }, route);
      await sleep(400);
    };
    const remount = async (route) => { await go('/overview'); await go(route); };
    const text = (sel) => admin.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel);
    const bodyText = () => admin.evaluate(() => document.body.innerText);
    // replace one ipcMain handler (main process): `mode` 'throw' rejects, otherwise resolves with `value`
    const inject = (channel, mode, value) => app.evaluate(({ ipcMain }, a) => {
      global.__auditOrig = global.__auditOrig || {};
      if (!(a.channel in global.__auditOrig)) global.__auditOrig[a.channel] = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get(a.channel);
      ipcMain.removeHandler(a.channel);
      ipcMain.handle(a.channel, async () => {
        if (a.mode === 'throw') throw new Error(a.value);
        return a.value;
      });
    }, { channel, mode, value });
    // the real handler back (Electron keeps them in ipcMain._invokeHandlers)
    const restore = (channel) => app.evaluate(({ ipcMain }, ch) => {
      const h = global.__auditOrig && global.__auditOrig[ch];
      if (!h) return false;
      ipcMain._invokeHandlers.set(ch, h);
      delete global.__auditOrig[ch];
      return true;
    }, channel);
    const setTheme = (t) => admin.evaluate((v) => window.petAdmin.set('ui.theme', v), t);
    const toasts = () => admin.evaluate(() => [...document.querySelectorAll('[data-sonner-toast], [class*="toast" i] [class*="title" i], [role="status"]')].map((e) => e.innerText.trim().split('\n')[0]).filter((t, i, a) => t && a.indexOf(t) === i).join(' | '));
    try {
      await page.waitForSelector('.char-card');
      await page.click('.char-card[data-species="grok"]');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      // one round from the desktop chat box: the chat page shows it with the 桌面 tag
      await clickAct(page, 'chat');
      await page.fill('#chat-input', '今天也辛苦啦，晚上想吃什么？');
      await page.press('#chat-input', 'Enter');
      await page.waitForFunction(() => /echo: 今天也辛苦啦/.test(document.getElementById('bubble').textContent), null, { timeout: 20000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
      admin = await openAdminWindow(app, page, 'chat');
      await admin.setViewportSize({ height: 760, width: 1180 }).catch(() => {});

      // ---- 聊天 ------------------------------------------------------------------------------------------
      await step(S, 'C01/C02/C03 聊天页：会话栏、同一段对话说明、模型影响范围', async () => {
        await adminUntil(admin, () => !!document.querySelector('[data-chat-page] [data-role]'), null, 15000, 'the desktop round on the chat page');
        const side = await text('[data-character-list]');
        const out = [await shot('chat-light')];
        if (AFTER) {
          const unmet = await admin.evaluate(() => document.querySelectorAll('[data-character][data-met="false"]').length);
          assert.equal(unmet, 0, 'only met characters in the side list (C02)');
          assert.ok(await admin.$('[data-meet-more]'), '结识更多 (C02)');
          assert.match(await text('[data-model-scope]'), /桌面上也用这个模型/, 'C03');
          assert.match(side, /正在陪你/, 'CHAT-02 状态词');
          assert.doesNotMatch(side, /在桌面|还没见过面/);
        }
        await setTheme('dark');
        out.push(await shot('chat-dark'));
        await setTheme('light');
        return `${out.join(', ')}; side: ${side.replace(/\s+/g, ' ').slice(0, 160)}`;
      }, () => admin);

      await step(S, 'C04 聊天页头 ⋯ → 重新开始对话（确认 → 结果 toast）', async () => {
        if (!AFTER) return `before: 页头没有 ⋯ 菜单，重新开始话题在 设置 → LobeHub 与本机 — ${await shot('chat-header')}`;
        await admin.click('[data-chat-more]');
        await adminUntil(admin, () => !!document.querySelector('[data-chat-new-topic]'), null, 5000, 'the menu');
        const menu = await shot('chat-more-menu');
        await admin.click('[data-chat-new-topic]');
        await adminUntil(admin, () => [...document.querySelectorAll('[role="dialog"]')].some((d) => /从头聊起/.test(d.textContent)), null, 5000, 'the confirmation');
        const confirm = await shot('chat-new-topic-confirm');
        await admin.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].filter((b) => b.textContent.trim() === '重新开始对话').pop().click());
        await adminUntil(admin, () => /下一句会开一个新对话/.test(document.body.innerText), null, 8000, 'the toast');
        const done = await shot('chat-new-topic-done');
        return [menu, confirm, done].join(', ');
      }, () => admin);

      await step(S, 'C09 聊天历史读取失败：LoadFailed + 重试，不再画成空对话', async () => {
        await inject('admin-chat-history', 'throw', 'EIO: chat-log.json 读不出来');
        await remount('/chat');
        await sleep(1200);
        const f = await shot('chat-history-failed');
        const body = await bodyText();
        if (AFTER) {
          assert.ok(await admin.$('[data-load-failed]'), 'LoadFailed in the message area');
          assert.match(body, /没能读取和.+的聊天记录/);
          assert.match(body, /重试/);
          assert.doesNotMatch(body, /说点什么/);
        }
        return `${f}; ${body.includes('说点什么') ? '显示为空对话' : /没能读取/.test(body) ? '显示失败态' : '一直转圈（未处理）'}`;
      }, () => admin);

      assert.equal(await restore('admin-chat-history'), true, 'the real chat-history handler is back');

      await step(S, 'C01 旧地址 #/history 落到聊天页', async () => {
        await go('/history');
        await sleep(800);
        const f = await shot('history-route');
        const where = await admin.evaluate(() => document.querySelector('[data-admin-page]')?.getAttribute('data-admin-page'));
        if (AFTER) assert.equal(where, 'chat', '#/history → 聊天');
        return `${f}; #/history 显示的页面：${where}`;
      }, () => admin);

      // ---- 插个嘴 ----------------------------------------------------------------------------------------
      const IJ = AFTER ? '/interject' : '/proactive';
      await step(S, 'C05/C06 插个嘴：独立页；关闭时只留一句说明、不渲染两张表', async () => {
        await go(IJ);
        await sleep(600);
        const f = await shot('interject-off', true);
        const tables = await admin.evaluate(() => document.querySelectorAll('[data-interject-rules], [data-interject-decisions]').length);
        if (AFTER) {
          assert.equal(tables, 0, 'no tables while off');
          assert.ok(await admin.$('[data-interject-off]'));
          const play = await admin.evaluate(() => [...document.querySelectorAll('[data-admin-page] *')].length);
          assert.ok(play > 0);
        }
        return `${f}; 关闭时表格数 ${tables}`;
      }, () => admin);

      await step(S, 'C05 插个嘴开启：来源 / 额度 / 阈值 + 规则表 + 判断记录', async () => {
        await admin.evaluate(() => window.petAdmin.set('interject.enabled', true));
        await adminUntil(admin, () => document.querySelectorAll('[data-interject-decisions] [data-row-key]').length >= 3, null, 10000, 'the decisions');
        const f = await shot('interject-on', true);
        return f;
      }, () => admin);

      await step(S, 'C07 规则 / 判断表读取失败：表格位置 LoadFailed + 重试', async () => {
        await inject('interject-rules', 'throw', 'ENOENT: interject.json 读不出来');
        await remount(IJ);
        await sleep(1000);
        const f = await shot('interject-load-failed', true);
        await restore('interject-rules');
        const body = await bodyText();
        if (AFTER) {
          assert.ok(await admin.$('[data-interject-rules] [data-load-failed]'), 'LoadFailed in the rules surface');
          assert.doesNotMatch(body, /还没有规则/);
        }
        return `${f}; ${/还没有规则/.test(body) ? '失败被画成「还没有规则」' : '显示失败态'}`;
      }, () => admin);

      await step(S, 'C08 清空记录失败：弹窗不关，原因写在弹窗里', async () => {
        await inject('interject-clear-decisions', 'value', { ok: false, reason: 'busy' });
        await remount(IJ);
        await adminUntil(admin, () => document.querySelectorAll('[data-interject-decisions] [data-row-key]').length >= 3, null, 10000, 'the decisions again');
        await adminUntil(admin, () => !!document.querySelector('[data-interject-clear]:not([disabled])') || [...document.querySelectorAll('[data-interject-decisions] button')].some((b) => /清空记录/.test(b.textContent) && !b.disabled), null, 8000, '清空记录');
        await admin.evaluate(() => (document.querySelector('[data-interject-clear]') || [...document.querySelectorAll('[data-interject-decisions] button')].find((b) => /清空记录/.test(b.textContent))).click());
        await adminUntil(admin, () => [...document.querySelectorAll('[role="dialog"]')].some((d) => /清空判断记录/.test(d.textContent)), null, 5000, 'the confirmation');
        await admin.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].filter((b) => b.textContent.trim() === '清空记录').pop().click());
        await sleep(900);
        const f = await shot('interject-clear-failed');
        const body = await bodyText();
        const dialogOpen = await admin.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /清空判断记录/.test(d.textContent)));
        if (AFTER) {
          assert.ok(dialogOpen, 'the dialog stays open on failure');
          assert.match(body, /没能清空/);
          assert.doesNotMatch(body, /判断记录已清空/);
        }
        await restore('interject-clear-decisions');
        await admin.keyboard.press('Escape');
        return `${f}; 弹窗${dialogOpen ? '未关闭' : '已关闭'}；${/判断记录已清空/.test(body) ? '误报「判断记录已清空」' : '无误报'}`;
      }, () => admin);
      await admin.evaluate(() => window.petAdmin.set('interject.enabled', false));

      // ---- 话题 / 桌面上的她 -----------------------------------------------------------------------------
      await step(S, 'C10 话题「聊聊」：按钮 loading，结果出来只给一条 toast', async () => {
        await inject('talk-topic', 'value', { ok: false, reason: 'busy' });
        await go('/topics');
        await adminUntil(admin, () => !!document.querySelector('[data-topic] button:not([disabled])'), null, 8000, 'a topic');
        await admin.evaluate(() => document.querySelector('[data-topic][data-locked="false"] button').click());
        await sleep(700);
        const f = await shot('topics-talk-failed');
        const t = await toasts();
        await restore('talk-topic');
        if (AFTER) assert.doesNotMatch(t, /开始聊/, 'no 开始聊 toast before the result');
        return `${f}; toasts: ${t.slice(0, 200)}`;
      }, () => admin);

      await step(S, 'C11 桌面上的她：动作 + 找回桌宠；退出移到 关于与数据；桌宠行为页不再有找回按钮', async () => {
        await go('/desk');
        const desk = await shot('desk', true);
        await go('/behavior');
        const behavior = await shot('behavior', true);
        const deskText = await bodyText();
        if (AFTER) {
          await go('/desk');
          const d = await bodyText();
          assert.match(d, /找回桌宠/);
          assert.doesNotMatch(d, /退出桌宠|回到右下角/);
          await go('/behavior');
          assert.equal(await admin.$('[data-place-pet]'), null, 'no 找回桌宠 on 桌宠行为');
          await go('/about');
          assert.ok(await admin.$('[data-app-quit]'), '退出应用 on 关于与数据');
          await admin.evaluate(() => document.querySelector('[data-app-quit]').scrollIntoView());
          await shot('about-quit');
        }
        return `${desk}, ${behavior}; ${deskText.length} chars`;
      }, () => admin);

      // ---- 商店 ------------------------------------------------------------------------------------------
      await step(S, 'C12/C13 商店：单类别无标签栏、页头读 schema、筛选进 ?show=', async () => {
        await go('/store');
        await adminUntil(admin, () => !!document.querySelector('[data-catalog]'), null, 8000, 'the catalog');
        const f1 = await shot('store-light');
        const tabs = await admin.evaluate(() => document.querySelectorAll('[role="tablist"]').length);
        await go('/store?show=remote');
        await sleep(600);
        const where = await admin.evaluate(() => document.querySelector('[data-admin-page]')?.getAttribute('data-admin-page'));
        const f2 = await shot('store-filter-url');
        if (AFTER) {
          assert.equal(tabs, 0, 'no tab bar with one category');
          assert.equal(where, 'store');
          // every look is downloaded here, so 未下载 (read from ?show=remote) shows the filtered-empty line, not the cards
          assert.equal(await admin.evaluate(() => document.querySelectorAll('[data-catalog]').length), 0, 'the filter read from ?show=');
          assert.match(await text('[data-store-filter-empty]'), /已经全部下载了/);
          await setTheme('dark');
          await go('/store');
          await shot('store-dark');
          await setTheme('light');
        }
        return `${f1}, ${f2}; tablist ${tabs}; #/store?show=remote → ${where}`;
      }, () => admin);
    } finally {
      await app.close().catch(() => {});
    }
    await downloadToast();
  };

  // C14: a download from 商店 ends in one toast with 「去见她」 (→ her page). Served from zips built out of catalog/.
  async function downloadToast() {
    const zips = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auditc-zips-'));
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-character-catalog.js'), '--zips-only', '--out', zips], { cwd: ROOT, encoding: 'utf8' });
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      const file = path.join(zips, path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
      const buf = fs.readFileSync(file);
      res.writeHead(200, { 'content-length': buf.length, 'content-type': 'application/zip' });
      res.end(buf);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auditc-dl-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-auditc-dlfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const { app, page } = await launch({ PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir, PIXELPET_CATALOG_PREINSTALLED: '', PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/chars` });
    let admin = null;
    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-character="grok-pixel"]').click();
      await page.uncheck('#local-opt').catch(() => {});
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      admin = await openAdminWindow(app, page, 'store');
      await admin.setViewportSize({ height: 760, width: 1180 }).catch(() => {});
      await step(S, 'C14 商店下载完成：一条 toast 带「去见她」，点了到她的页面', async () => {
        await adminUntil(admin, () => !!document.querySelector('[data-download="grok-classic"]'), null, 10000, 'the card');
        await admin.click('[data-download="grok-classic"]');
        await adminUntil(admin, () => /下载好了/.test(document.body.innerText), null, 60000, 'the toast');
        await sleep(300);
        const f = `C-${PHASE}-store-download-toast.png`;
        await admin.screenshot({ path: path.join(SHOTS, f) });
        if (AFTER) {
          const btn = await admin.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '去见她'));
          assert.ok(btn, '「去见她」 in the toast');
          await admin.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '去见她').click());
          await adminUntil(admin, () => /^#\/characters\/grok-classic/.test(location.hash), null, 5000, 'her page');
        }
        return `${f}; ${AFTER ? '去见她 → ' + (await admin.evaluate(() => location.hash)) : ''}`;
      }, () => admin);
    } finally {
      await app.close().catch(() => {});
      server.close();
    }
  }
};
