'use strict';

// 角色 → 表情包 e2e (run.js `stickers`, T-6173, docs/stickers-design.md §4): the real app, the real settings window.
// For one character (大肥鱼): an empty 我的 set → 添加表情包 picks 4 pictures + 2 that are not stickers (the file
// dialog answered with debug-next-open) → the grid shows 4, the 2 refusals are listed with their reasons → delete
// one (asked first) → 3 → quit and start the app again over the same userData → still 3, pictures loading over
// sticker://. Then her reply tagging one of them ([梗图:<id>], the fake lh echoes it) shows that picture in the
// pet window's bubble: the AI side can use what the owner added. Built-in memes stay a read-only set.
// Screenshots + evidence.json in out/e2e/stickers/.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

// A small RGBA sticker: a round face in `rgb` with two eyes and a mouth on a transparent ground.
function face(size, [r, g, b], mood = 'smile') {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  const R = size * 0.46;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const d = Math.hypot(x - c, y - c);
      if (d > R) continue;
      let px = [r, g, b];
      const eye = (ex) => Math.hypot(x - ex, y - c * 0.8) < size * 0.06;
      const my = mood === 'sad' ? c * 1.45 - Math.abs(x - c) * 0.35 : c * 1.2 + Math.sqrt(Math.max(0, (size * 0.22) ** 2 - (x - c) ** 2)) * 0.6;
      const mouth = Math.abs(x - c) < size * 0.22 && Math.abs(y - my) < size * 0.03;
      if (eye(c * 0.7) || eye(c * 1.3) || mouth) px = [40, 30, 30];
      else if (d > R - size * 0.03) px = [Math.max(0, r - 60), Math.max(0, g - 60), Math.max(0, b - 60)];
      raw[o] = px[0]; raw[o + 1] = px[1]; raw[o + 2] = px[2]; raw[o + 3] = 255;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(size, 0); ih.writeUInt32BE(size, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = function stickersScenario(ctx) {
  const { ROOT, OUT, FAKE_LH, step, launch, openAdminWindow } = ctx;
  return async function stickers() {
    const S = 'stickers';
    const SHOTS = path.join(OUT, S);
    fs.mkdirSync(SHOTS, { recursive: true });
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-stickers-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-stickersfake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
    // the pictures the owner picks: 4 stickers, a text file named .png, and one too small
    const pics = path.join(data, '..', `pp-stickers-pics-${process.pid}`);
    fs.mkdirSync(pics, { recursive: true });
    const files = [
      ['超开心.png', face(240, [255, 196, 64])],
      ['委屈.png', face(200, [120, 170, 255], 'sad')],
      ['比心.png', face(256, [255, 120, 160])],
      ['摸鱼中.png', face(180, [110, 210, 150])],
      ['说明.png', Buffer.from('this is a text file, renamed to .png')],
      ['小图标.png', face(32, [200, 200, 200])],
    ].map(([n, buf]) => { const f = path.join(pics, n); fs.writeFileSync(f, buf); return f; });

    const evidence = [];
    const note = (s) => { evidence.push(s); return s.length > 300 ? `${s.slice(0, 297)}…` : s; };
    const errors = [];
    const watch = (p) => { p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); };
    let { app, page } = await launch(env);
    let admin = null;
    let charId = null;
    // the settings window: her 表情包 section scrolled to the top, so the grid is in view
  const shot = async (name, p = admin) => {
    if (p === admin) await admin.evaluate(() => { const el = document.querySelector('[role="tabpanel"]:not([inert]) [data-stickers]'); if (el) el.scrollIntoView({ block: 'start' }); }).catch(() => {});
    await sleep(250);
    await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    return `${name}.png`;
  };
    const until = async (fn, arg, ms = 15000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        if (await admin.evaluate(fn, arg).catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await sleep(120);
      }
    };
    const cards = () => admin.evaluate(() => [...document.querySelectorAll('[data-stickers-grid] [data-sticker]')].map((el) => { const img = el.querySelector('img'); return { id: el.dataset.sticker, label: el.innerText.split('\n')[0].trim(), src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 }; }));
    const setFile = () => JSON.parse(fs.readFileSync(path.join(data, 'stickers', 'sets', 'mine-dafeiyu.json'), 'utf8'));
    const openTab = async () => {
      if (!admin || admin.isClosed()) { admin = await openAdminWindow(app, page, 'characters'); watch(admin); }
      charId = await admin.evaluate(() => window.petAdmin.state().then((s) => s.roster.find((c) => c.base === 'dafeiyu' && c.current).id));
      await admin.evaluate((id) => { location.hash = `/characters/${id}`; }, charId);
      await admin.waitForSelector(`[data-path="/characters/${charId}"]`, { timeout: 15000 });
      await admin.getByRole('tab', { name: '表情包' }).click();
      await until(() => !!document.querySelector('[role="tabpanel"]:not([inert]) [data-stickers]') && !document.querySelector('[data-stickers-loading]'), null, 15000, 'stickers tab');
      await admin.setViewportSize({ width: 1100, height: 900 }).catch(() => {});
    };

    try {
      // 大肥鱼, as a new user meets her
      await page.waitForSelector('.char-card', { timeout: 30000 });
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', '鱼片');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('thinking'), null, { timeout: 20000 }).catch(() => {});

      await step(S, 'her page has a 表情包 tab: 我的 starts empty with one 添加表情包, 内置 holds her built-in memes read-only', async () => {
        await openTab();
        await until(() => !!document.querySelector('[data-stickers-empty]'), null, 8000, 'empty state');
        const seg = await admin.evaluate(() => (document.querySelector('[role="tabpanel"]:not([inert]) [data-stickers]').innerText.match(/(?:内置|我的) · \d+/g) || []));
        await shot('01-empty');
        assert.ok(seg.some((x) => /^我的 · 0$/.test(x)), `segments: ${seg.join(' / ')}`);
        const builtin = seg.find((x) => /^内置 · \d+$/.test(x));
        assert.ok(builtin, 'a 内置 set');
        await admin.getByText(builtin, { exact: true }).click();
        await until(() => document.querySelectorAll('[data-stickers-grid^="builtin:"] [data-sticker]').length > 0, null, 8000, 'built-in grid');
        await until(() => [...document.querySelectorAll('[data-stickers-grid] img')].every((i) => i.complete && i.naturalWidth > 0), null, 8000, 'built-in pictures loaded');
        const b = await cards();
        assert.ok(b.every((x) => x.src.startsWith('sticker://builtin/dafeiyu/')));
        assert.equal(await admin.locator('[data-sticker-delete]').count(), 0, 'built-in ones cannot be deleted');
        await shot('02-builtin-readonly');
        await admin.getByText('我的 · 0', { exact: true }).click();
        await until(() => !!document.querySelector('[data-stickers-empty]'), null, 5000, 'back to 我的');
        return note(`segments ${seg.join(' / ')}; built-in ${b.length} read-only (${b.map((x) => x.label).join('、')}), served from sticker://builtin/`);
      }, () => admin);

      await step(S, '添加表情包 with 6 files picked at once: 4 added in order, the 2 that are not stickers listed with why', async () => {
        await page.evaluate((p) => window.pet.debugNextOpen(p), files.join('\n'));
        await admin.click('[data-stickers-empty] [data-stickers-add]');
        await until(() => document.querySelectorAll('[data-stickers-grid] [data-sticker]').length === 4, null, 10000, '4 cards');
        await until(() => [...document.querySelectorAll('[data-stickers-grid] img')].every((i) => i.complete && i.naturalWidth > 0), null, 8000, 'pictures loaded');
        const c = await cards();
        const rej = await admin.evaluate(() => (document.querySelector('[data-stickers-rejected]') || {}).innerText || '');
        await shot('03-added-4-rejected-2');
        assert.deepEqual(c.map((x) => x.label), ['超开心', '委屈', '比心', '摸鱼中']);
        assert.ok(c.every((x) => /^sticker:\/\/blob\/[0-9a-f]{64}\.png$/.test(x.src) && x.loaded));
        assert.match(rej, /2 张图片没有添加/);
        assert.match(rej, /说明\.png：不是 PNG、JPG、WebP 或 GIF 图片/);
        assert.match(rej, /小图标\.png：尺寸太小/);
        const disk = setFile();
        assert.equal(disk.stickers.length, 4);
        assert.equal(fs.readdirSync(path.join(data, 'stickers', 'blobs')).length, 4);
        return note(`grid: ${c.map((x) => `${x.label}(${x.id})`).join('、')}; refused: ${rej.replace(/\s+/g, ' ')}; disk: sets/mine-dafeiyu.json ${disk.stickers.length} stickers, blobs/ 4 files`);
      }, () => admin);

      let deleted = null;
      await step(S, 'delete 委屈: asked first (删除表情包 / 取消), then 3 left on the page and on disk', async () => {
        const c = await cards();
        deleted = c.find((x) => x.label === '委屈');
        await admin.hover(`[data-sticker="${deleted.id}"]`);
        await admin.click(`[data-sticker-delete="${deleted.id}"]`);
        await until(() => [...document.querySelectorAll('.ant-modal button, [role="dialog"] button')].some((b) => b.textContent.trim() === '删除表情包'), null, 5000, 'confirm');
        const dlg = await admin.evaluate(() => [...document.querySelectorAll('.ant-modal, [role="dialog"]')].map((d) => d.innerText).join('\n'));
        await shot('04-delete-confirm');
        assert.match(dlg, /删除「委屈」？/);
        assert.match(dlg, /取消/);
        await admin.evaluate(() => [...document.querySelectorAll('.ant-modal button, [role="dialog"] button')].filter((b) => b.textContent.trim() === '删除表情包').pop().click());
        await until(() => document.querySelectorAll('[data-stickers-grid] [data-sticker]').length === 3, null, 8000, '3 cards');
        await sleep(400);
        const after = await cards();
        await shot('05-after-delete-3');
        assert.deepEqual(after.map((x) => x.label), ['超开心', '比心', '摸鱼中']);
        assert.deepEqual(setFile().stickers.map((s) => s.label), ['超开心', '比心', '摸鱼中']);
        return note(`confirm: ${dlg.replace(/\s+/g, ' ').slice(0, 120)}; after: ${after.map((x) => x.label).join('、')}; disk 3`);
      }, () => admin);

      await step(S, 'quit and start again over the same userData: her 表情包 tab still shows the 3, pictures loading', async () => {
        await app.close();
        ({ app, page } = await launch(env));
        admin = null;
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await page.waitForFunction(() => !document.body.classList.contains('thinking'), null, { timeout: 20000 }).catch(() => {});
        await openTab();
        await until(() => document.querySelectorAll('[data-stickers-grid] [data-sticker]').length === 3, null, 10000, '3 cards after restart');
        await until(() => [...document.querySelectorAll('[data-stickers-grid] img')].every((i) => i.complete && i.naturalWidth > 0), null, 8000, 'pictures loaded');
        const c = await cards();
        await shot('06-after-restart-3');
        assert.deepEqual(c.map((x) => x.label), ['超开心', '比心', '摸鱼中']);
        assert.ok(!c.some((x) => x.id === deleted.id));
        // the deleted picture's blob is gone after the start-up clean-up (nothing refers to it)
        assert.equal(fs.readdirSync(path.join(data, 'stickers', 'blobs')).length, 3);
        return note(`after restart: ${c.map((x) => `${x.label}(${x.id})`).join('、')}, all loaded; blobs/ 3 files (the deleted one cleaned up at start)`);
      }, () => admin);

      await step(S, 'her reply tagging an owner\'s sticker ([梗图:<id>]) shows that picture in the pet window bubble', async () => {
        const c = await cards();
        const pick = c.find((x) => x.label === '比心');
        await page.evaluate(() => window.pet.openChat && window.pet.openChat()).catch(() => {});
        await require('./pet-panel').clickChatBubble(page);
        await page.fill('#chat-input', `[梗图:${pick.id}]`);
        await page.click('#chat-send');
        await page.waitForFunction(() => { const s = document.getElementById('meme-sticker'); return s && !s.classList.contains('hidden') && s.src.startsWith('sticker://blob/') && s.complete && s.naturalWidth > 0; }, null, { timeout: 20000 });
        const st = await page.evaluate(() => { const s = document.getElementById('meme-sticker'); return { src: s.getAttribute('src'), alt: s.alt, bubble: document.getElementById('bubble').innerText }; });
        // the fake lh has no direct LobeHub: an unrelated 本机工具 notice may cover her; close it for the picture
        await page.evaluate(() => { const t = document.getElementById('unlock-toast'); if (t && !t.classList.contains('hidden')) document.getElementById('toast-close').click(); });
        await sleep(400);
        await shot('07-pet-bubble-sticker', page);
        assert.equal(st.src, pick.src);
        assert.equal(st.alt, '比心');
        assert.doesNotMatch(st.bubble, /梗图/);
        const prompt = fs.readFileSync(path.join(fakeDir, 'calls.log'), 'utf8');
        assert.match(prompt, new RegExp(`${pick.id}（比心：比心）`), 'the prompt offered her the owner\'s sticker');
        return note(`bubble text "${st.bubble.trim()}", sticker ${st.src} (alt ${st.alt}); the prompt listed ${pick.id}（比心：比心）`);
      }, () => page);

      await step(S, 'no page errors or console errors in either window', async () => {
        const real = errors.filter((e) => !/Autofill|DevTools|Electron Security Warning/i.test(e));
        assert.deepEqual(real, []);
        return note('pageerror 0, console.error 0');
      }, () => admin);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'evidence.json'), JSON.stringify({ evidence, errors }, null, 2));
      try { fs.copyFileSync(path.join(data, 'stickers', 'sets', 'mine-dafeiyu.json'), path.join(SHOTS, 'mine-dafeiyu.json')); } catch { /* none */ }
      await app.close().catch(() => {});
    }
  };
};
