// ⏻ 退出 on the pet toolbar (T-2827), driven as a user does: hover her, ⏻ sits right of ⚙ on the same row (a
// pixel look: 7 buttons; a VRM look adds ♪: 8 buttons, still one row), hovering it tints it with the error colour,
// one click quits the whole app (the Electron process exits on its own), and a relaunch finds her as she was.
// Screenshots: out/e2e/quitbtn/*.png.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

module.exports = function quitButtonScenario({ OUT, FAKE_LH, ROOT, step, launch }) {
  return async function quitbtn() {
    const S = 'quitbtn';
    const SHOTS = path.join(OUT, 'quitbtn');
    fs.mkdirSync(SHOTS, { recursive: true });
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-quitbtn-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-quitbtnfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
    const { makeModel } = require('./vrm');
    const model = makeModel(ROOT, 'quitbtn');
    let { app, page } = await launch(env);
    let look = null;
    const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const barShot = (n) => page.locator('#toolbar').screenshot({ path: path.join(SHOTS, `${n}.png`) });
    const hover = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); await page.waitForTimeout(400); };
    const geom = () => page.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
      const shown = [...document.querySelectorAll('#toolbar [data-act]')].filter((b) => !b.classList.contains('hidden'));
      return { win: innerWidth, toolbar: r(document.getElementById('toolbar')), acts: shown.map((b) => b.dataset.act), rows: new Set(shown.map((b) => Math.round(b.getBoundingClientRect().top))).size, settings: r(document.getElementById('btn-settings')), quit: r(document.getElementById('btn-quit')), label: document.getElementById('btn-quit').getAttribute('aria-label'), title: document.getElementById('btn-quit').title };
    });
    const checkRow = (g, acts) => {
      assert.deepEqual(g.acts, acts);
      assert.equal(g.rows, 1, `the toolbar stays on one row: ${JSON.stringify(g)}`);
      assert.equal(g.quit.y, g.settings.y, '⏻ on the same row as ⚙');
      assert.ok(g.quit.x >= g.settings.r && g.quit.x - g.settings.r <= 4, `⏻ right next to ⚙: ${JSON.stringify([g.settings, g.quit])}`);
      assert.ok(g.toolbar.x >= 0 && g.toolbar.r <= g.win, `the toolbar fits the window: ${JSON.stringify(g)}`);
    };
    try {
      await page.waitForSelector('.char-card');
      await page.locator('.char-card[data-species="claude"]').first().click();
      await page.fill('#pet-name', '小克');
      await page.uncheck('#local-opt');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });

      await step(S, 'Q1 像素外观：⏻ 退出在 ⚙ 设置右边、同一行（7 个按钮一行放下）', async () => {
        await hover();
        const g = await geom();
        checkRow(g, ['feed', 'play', 'sleep', 'chat', 'mute', 'settings', 'quit']);
        assert.equal(g.label, '退出');
        assert.match(g.title, /^退出：/);
        await shot('q1-pixel-pet');
        await barShot('q1-pixel-toolbar');
        return `window ${g.win}px, toolbar ${g.toolbar.w}×${g.toolbar.h} @x${g.toolbar.x}; ⚙ x${g.settings.x}–${g.settings.r}, ⏻ x${g.quit.x}–${g.quit.r} (y ${g.quit.y}); title 「${g.title}」`;
      }, page);

      await step(S, 'Q2 悬停 ⏻：文字和描边变成错误色（--lobe-color-error），和互动按钮区分开', async () => {
        await page.hover('#btn-quit');
        await page.waitForTimeout(300);
        const c = await page.evaluate(() => {
          const b = getComputedStyle(document.getElementById('btn-quit'));
          const probe = document.createElement('i'); probe.style.color = 'var(--lobe-color-error)'; document.body.appendChild(probe);
          const err = getComputedStyle(probe).color; probe.remove();
          return { color: b.color, border: b.borderTopColor, err, settings: getComputedStyle(document.getElementById('btn-settings')).color };
        });
        assert.equal(c.color, c.err);
        assert.equal(c.border, c.err);
        assert.notEqual(c.settings, c.err, '⚙ keeps its own colour');
        await barShot('q2-quit-hover');
        return JSON.stringify(c);
      }, page);

      await step(S, 'Q3 VRM 外观（多一个 ♪ 跳舞）：8 个按钮仍在一行，⏻ 仍紧挨 ⚙ 右边', async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file);
        const imp = await page.evaluate(() => window.pet.importVrm('claude'));
        assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
        await page.evaluate((x) => window.pet.switchCharacter(x), imp.pack.id);
        look = imp.pack.id;
        await page.waitForFunction((x) => (document.getElementById('pet-look').dataset.key || '').startsWith(`${x}/`), imp.pack.id, { timeout: 15000 });
        await page.mouse.move(5, 5);
        await hover();
        await page.waitForFunction(() => !document.getElementById('btn-dance').classList.contains('hidden'), null, { timeout: 5000 });
        const g = await geom();
        checkRow(g, ['feed', 'play', 'sleep', 'chat', 'dance', 'mute', 'settings', 'quit']);
        await shot('q3-vrm-pet');
        await barShot('q3-vrm-toolbar');
        return `window ${g.win}px, toolbar ${g.toolbar.w}×${g.toolbar.h}; ⚙ x${g.settings.x}–${g.settings.r}, ⏻ x${g.quit.x}–${g.quit.r}`;
      }, page);

      await step(S, 'Q4 点 ⏻：整个应用退出（Electron 进程自己结束，不弹确认）', async () => {
        await hover();
        const proc = app.process();
        const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
        const t0 = Date.now();
        await page.click('#btn-quit', { noWaitAfter: true }).catch(() => {}); // the page goes away under the click
        const r = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
        assert.ok(r, 'the app did not exit within 10 s');
        assert.equal(r.code, 0, `clean exit: ${JSON.stringify(r)}`);
        assert.equal(page.lastDialog, undefined, 'no dialog on the way out');
        app = null;
        return `process ${proc.pid} exited in ${Date.now() - t0} ms, ${JSON.stringify(r)}`;
      }, page);

      await step(S, 'Q5 再打开：她还在（名字、外观都没丢），直接回到桌面', async () => {
        ({ app, page } = await launch(env));
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        const v = await page.evaluate(async () => (await window.pet.boot()).view);
        assert.equal(v.pet.name, '小克');
        assert.equal(v.pet.characterId, look, 'still in the VRM look she wore when ⏻ was clicked');
        await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
        await hover();
        await shot('q5-relaunched');
        return `name 「${v.pet.name}」, look ${v.pet.characterId}`;
      }, page);
    } finally {
      if (app) await app.close().catch(() => {});
      fs.rmSync(model.dir, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
      fs.rmSync(fakeDir, { recursive: true, force: true });
    }
  };
};
