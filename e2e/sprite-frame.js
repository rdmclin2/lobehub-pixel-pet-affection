'use strict';

// 像素 sprites 取景 e2e (run.js `spriteframe`, docs/half-body-mode.md "像素（sprites）实现"), kept out of run.js (over
// the size limit). The built-in 克洛蒂 · 像素 pack (HD, smooth) and 克洛蒂 · 旧版像素 (83×113 hard pixel art):
//   全身 → 设置窗口 桌宠行为 → 取景 → 半身: only head to waist, the waist on the canvas' bottom edge, centred, bigger, same
//   window, the same canvas element (never rebuilt, the sheet never reloaded), the crop glides; data-framing /
//   data-cut / data-band on the canvas; in 半身: touch zones mapped (legs / feet out of reach) and a real click on her
//   head, 拖起 (lifted), walking, talking; back to 全身 = the first picture pixel for pixel; her own 取景 on her page;
//   the classic pack in 半身 is drawn in whole blocks (332×452, every source pixel s×s); a restart keeps 半身.
// Screenshots / GIFs in out/e2e/sprite-frame/, the step-by-step record in out/e2e/sprite-frame/evidence.txt.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

module.exports = function spriteFrameScenarios(ctx) {
  const { OUT, FAKE_LH, step, launch, openAdminWindow, petBounds } = ctx;
  const SHOTS = path.join(OUT, 'sprite-frame');
  fs.mkdirSync(SHOTS, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const SEL = '#pet-look canvas.sprite';

  // where her opaque pixels are in the sprite canvas (0..1 of it)
  const composition = (page) => page.evaluate((q) => {
    const c = document.querySelector(q);
    if (!c) return null;
    const w = 166;
    const h = Math.round((c.height / c.width) * w);
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    const g = t.getContext('2d', { willReadFrequently: true });
    g.drawImage(c, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 24) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return { empty: true };
    const r = (v) => Math.round(v * 1000) / 1000;
    return { left: r(x0 / w), right: r((x1 + 1) / w), top: r(y0 / h), bottom: r((y1 + 1) / h), cx: r((x0 + x1 + 1) / 2 / w), fill: r(n / (w * h)), height: r((y1 + 1 - y0) / h) };
  }, SEL);
  // 全身 must be the old drawing exactly: the canvas pixels vs the frame's cell drawn straight from the sheet (the way
  // drawSprite drew before 半身 existed), for whatever frame is up. -> { frame, same, diff (pixels that differ) }
  const vsSheet = (page) => page.evaluate(async (q) => {
    const c = document.querySelector(q);
    const frame = c.dataset.frame;
    const got = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const m = /^(.*)#(\d+):(\d+)$/.exec(frame);
    if (!m) return { frame, same: false, diff: -1 };
    const bmp = await createImageBitmap(await (await fetch(m[1])).blob());
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const g = t.getContext('2d');
    g.imageSmoothingEnabled = !c.classList.contains('pixelated');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, Number(m[3]) * c.width, Number(m[2]) * c.height, c.width, c.height, 0, 0, c.width, c.height);
    bmp.close();
    const want = g.getImageData(0, 0, c.width, c.height).data;
    let diff = 0, maxd = 0, y0 = 1e9, y1 = -1, opaqueDiff = 0;
    for (let i = 0; i < want.length; i += 4) {
      const d = Math.max(Math.abs(want[i] - got[i]), Math.abs(want[i + 1] - got[i + 1]), Math.abs(want[i + 2] - got[i + 2]), Math.abs(want[i + 3] - got[i + 3]));
      if (!d) continue;
      diff++; maxd = Math.max(maxd, d);
      if (want[i + 3] === 255 && got[i + 3] === 255) opaqueDiff++;
      const y = Math.floor(i / 4 / c.width); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { frame, same: diff === 0, diff, size: `${c.width}x${c.height}`, ...(diff ? { maxDelta: maxd, rows: [y0, y1], opaqueDiff } : {}) };
  }, SEL);

  async function spriteFraming() {
    const S = 'spriteframe';
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-spriteframe-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-spriteframefake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    // she wears the built-in HD pixel pack and stays put (window bounds are compared)
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, appearance: { claude: 'claude-pixel' }, prefs: { roam: false } }));
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };

    const evidence = [];
    const note = (s) => { evidence.push(s); return s; };
    let { app, page } = await launch(env);
    let errors = [];
    const watch = () => { errors = []; page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`)); };
    watch();
    let admin = null;
    const first = {};
    const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    const shot = async (name) => { await sleep(120); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `sprite-frame/${name}.png`; };
    const ds = () => page.evaluate((q) => { const c = document.querySelector(q); return c ? { ...c.dataset } : null; }, SEL);
    const fig = () => page.evaluate(() => window.petFx.sprite());
    const canvasBox = () => page.locator(SEL).boundingBox();
    const settled = (mode, timeout = 15000) => page.waitForFunction((m) => { const f = window.petFx.sprite(); const c = document.querySelector('#pet-look canvas.sprite'); return c && c.dataset.framing === m && f && !f.gliding && (m === 'full' || f.ref); }, mode, { timeout });
    const stand = async () => { await page.mouse.move(5, 5); await page.waitForFunction(() => { const s = window.petFx.state(); return s && s.state === 'idle'; }, null, { timeout: 30000 }).catch(() => {}); await sleep(400); };
    const same = () => page.evaluate((q) => { const c = document.querySelector(q); return !!(c && c.e2eMark); }, SEL);
    const adminToast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
    const adminShot = async (name) => { await sleep(200); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `sprite-frame/${name}.png`; };
    const pickGlobal = async (label) => {
      await admin.evaluate(() => { location.hash = '/behavior'; });
      await admin.waitForSelector('[data-path="/behavior"] [data-key="prefs.framing"]');
      await admin.locator('[data-key="prefs.framing"]').getByText(label, { exact: true }).click();
      await adminToast(new RegExp(`已保存：取景 → ${label}`));
    };
    const adminUntil = async (fn, arg, ms = 15000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        if (await admin.evaluate(fn, arg).catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`settings window: timed out waiting for ${what}`);
        await sleep(150);
      }
    };
    const pickPack = async (id) => {
      if (!admin || admin.isClosed()) admin = await openAdminWindow(app, page, 'characters/claude');
      await admin.evaluate(() => { location.hash = '/characters/claude'; });
      await adminUntil(() => !!document.querySelector('[data-path="/characters/claude"]'), null, 15000, 'her page');
      await admin.evaluate(() => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === '装扮'); if (t) t.click(); });
      await adminUntil((x) => !!document.querySelector(`[data-wardrobe] [data-pack="${x}"]`), id, 10000, `pack ${id}`);
      if (!(await admin.evaluate((x) => !!document.querySelector(`[data-wardrobe] [data-pack="${x}"][data-worn="true"]`), id))) await admin.evaluate((x) => document.querySelector(`[data-use-pack="${x}"]`).click(), id);
      await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), id, { timeout: 10000 });
    };
    // the crop while switching (it moves one way; the same canvas element throughout)
    const glideSamples = async (ms = 650) => {
      const out = [];
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = await fig();
        const sh = f.crop ? Number(f.crop.split(',')[3]) : f.canvas[1];
        out.push({ t: Date.now() - t0, sh, gliding: f.gliding, same: await same() });
        await sleep(20);
      }
      return out;
    };
    const gif = async (name, n, gapMs, grab = null, fps = 8) => {
      const dir = path.join(SHOTS, name);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < n; i++) {
        if (grab) await grab(i);
        await page.screenshot({ path: path.join(dir, `${String(i).padStart(3, '0')}.png`) });
        if (gapMs) await sleep(gapMs);
      }
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, '%03d.png'), '-vf', 'split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse', path.join(SHOTS, `${name}.gif`)]);
      return `sprite-frame/${name}.gif (${n} frames)`;
    };
    const monotonic = (xs) => xs.every((v, i) => i === 0 || (v - xs[i - 1]) * Math.sign(xs[xs.length - 1] - xs[0]) >= -1e-9);
    const halfChecks = (c, why) => {
      assert.ok(c.bottom > 0.98, `${why}: cut at the bottom edge (waist): ${JSON.stringify(c)}`);
      assert.ok(c.top < 0.15, `${why}: her head near the top: ${JSON.stringify(c)}`);
      assert.ok(Math.abs(c.cx - 0.5) < 0.1, `${why}: centred: ${JSON.stringify(c)}`);
    };
    try {
      await step(S, 'hatching 克洛蒂 in her pixel look (claude-pixel); 取景 default 全身', async () => {
        await page.waitForSelector('.char-card', { timeout: 20000 });
        await page.click('.char-card[data-species="claude"]');
        await page.fill('#pet-name', 'Clo');
        await page.click('#hatch-btn');
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await page.waitForFunction(() => document.getElementById('pet-look').dataset.key.startsWith('claude-pixel/daily'), null, { timeout: 15000 });
        await settled('full', 30000);
        await page.evaluate((q) => { document.querySelector(q).e2eMark = 1; }, SEL);
        const st = await page.evaluate(() => window.pet.getSettings());
        assert.equal(st.prefs.framing, 'full');
        const fr = await page.evaluate(() => window.petFx.framing());
        assert.equal(fr.supported, true, 'a sprites look can be re-framed');
        return note(`look ${await page.evaluate(() => document.getElementById('pet-look').dataset.key)}; prefs.framing=${st.prefs.framing}; petFx.framing() ${JSON.stringify(fr)}`);
      }, page);

      await step(S, '全身: the whole frame as before (head to feet, feet on the floor) — screenshot', async () => {
        await stand();
        const c = await composition(page);
        const d = await ds();
        const f = await fig();
        Object.assign(first, { bounds: await petBounds(app), comp: c, frame: d.frame, canvas: f.canvas });
        first.sheet = await vsSheet(page);
        // equal, up to ±1 on semi-transparent edge pixels (premultiplied alpha rounding between two canvases)
        assert.ok(first.sheet.same || (first.sheet.maxDelta <= 1 && first.sheet.opaqueDiff === 0), `全身 = the sheet cell drawn whole: ${JSON.stringify(first.sheet)}`);
        const s = await shot('1-full');
        assert.equal(d.framing, 'full');
        assert.equal(d.cut, '1');
        assert.equal(d.crop, '', 'no crop in 全身');
        assert.deepEqual(f.canvas, [664, 904]);
        assert.ok(c.bottom > 0.97 && c.top > 0.12, `feet near the bottom, air above: ${JSON.stringify(c)}`);
        return note(`${s}: data-framing=full, data-cut=1, canvas ${f.canvas.join('×')}; opaque box ${JSON.stringify(c)}; window ${JSON.stringify(first.bounds)}; canvas vs sheet cell ${JSON.stringify(first.sheet)}`);
      }, page);

      await step(S, '后台 桌宠行为 → 取景 → 半身: the pixel pet re-frames at once — head to waist, waist on the bottom edge, centred, bigger, same window; the same canvas (no rebuild / reload), the crop glides', async () => {
        admin = await openAdminWindow(app, page, 'behavior');
        await admin.waitForSelector('[data-path="/behavior"] [data-key="prefs.framing"]');
        const desc = await admin.evaluate(() => { const el = document.querySelector('[data-key="prefs.framing"]'); let p = el; for (let i = 0; i < 12 && p; i++) { if (/像素角色生效/.test(p.textContent)) return p.textContent.replace(/\s+/g, ' ').slice(0, 300); p = p.parentElement; } return null; });
        assert.ok(desc && /VRM、Live2D 和像素角色生效/.test(desc), `the 取景 card says it works for pixel characters: ${desc}`);
        await adminShot('2-admin-behavior-full');
        const sheetsBefore = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /claude-pixel/.test(e.name)).length);
        const burst = gif('glide-to-half', 14, 0, null, 12);
        await pickGlobal('半身');
        const glide = await glideSamples();
        const glideGif = await burst;
        await settled('half');
        await stand();
        const f = await fig();
        const c = await composition(page);
        const b = await petBounds(app);
        const s = await shot('3-half');
        await adminShot('3-admin-behavior-half');
        const d = await ds();
        const sheetsAfter = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => /claude-pixel/.test(e.name)).length);
        assert.equal(saved().prefs.framing, 'half', 'saved in settings.json');
        assert.equal(d.framing, 'half');
        assert.equal(d.band, 'pack', 'the built-in pack says where her waist is (halfBody.waist)');
        assert.equal(d.cut, '0.520');
        assert.ok(await same(), 'the same canvas element');
        assert.equal(sheetsAfter, sheetsBefore, 'the sheet was not fetched again');
        assert.deepEqual(f.canvas, [664, 904], 'HD art keeps its canvas');
        assert.deepEqual(b, first.bounds, 'the window keeps its size and place');
        halfChecks(c, '半身');
        assert.ok(c.fill > first.comp.fill * 1.6, `drawn bigger: fill ${first.comp.fill} → ${c.fill}`);
        const shs = glide.map((g) => g.sh);
        assert.ok(glide.some((g) => g.gliding), 'a glide was seen');
        assert.ok(monotonic(shs), `the crop glides one way: ${shs.map((v) => v.toFixed(1)).join(' ')}`);
        assert.ok(glide.every((g) => g.same), 'the same canvas throughout');
        return note(`${s} + ${glideGif}: data-framing=half, data-cut=${d.cut}, data-band=${d.band}, data-crop=${d.crop}; petFx.sprite() ${JSON.stringify(f)}; opaque box ${JSON.stringify(c)} (全身 ${JSON.stringify(first.comp)}); window ${JSON.stringify(b)} (unchanged); same canvas element; sheet fetches ${sheetsBefore} → ${sheetsAfter}; glide crop height ${shs.map((v) => v.toFixed(1)).join(' → ')}; card 「${desc}」`);
      }, page);

      await step(S, '半身: touch zones map onto her upper body (legs / feet out of reach); a click on her head is a head touch', async () => {
        await stand();
        const box = await canvasBox();
        const probe = (fx, fy) => page.evaluate(([px, py]) => window.petFx.touchPoint(px, py), [box.x + box.width * fx, box.y + box.height * fy]);
        const rows = [];
        const zones = new Set();
        let headAt = null;
        for (const fy of [0.1, 0.15, 0.22, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97]) {
          const p = await probe(0.5, fy);
          rows.push(`y=${fy}: ${p ? `${p.zone || '-'} (y_full=${p.y.toFixed(2)}, ${p.framing})` : 'off'}`);
          if (p && p.zone) zones.add(p.zone);
          if (p && p.zone === 'head' && !headAt) headAt = fy;
        }
        assert.ok(!zones.has('legs') && !zones.has('feet'), [...zones].join(','));
        assert.ok(zones.has('head') && zones.has('face'), [...zones].join(','));
        assert.ok(zones.has('chest') || zones.has('belly'), [...zones].join(','));
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * headAt);
        await page.waitForFunction(() => { const t = window.petFx.lastTouch(); return t && t.zone === 'head'; }, null, { timeout: 5000 });
        await sleep(300);
        const t = await page.evaluate(() => window.petFx.lastTouch());
        const act = await page.evaluate(() => window.petFx.state().action);
        const s = await shot('4-half-touch-head');
        return note(`${s}: touchPoint down the middle: ${rows.join('; ')}; click at y=${headAt} → lastTouch ${JSON.stringify({ zone: t.zone, mood: t.mood })}, action ${act}`);
      }, page);

      await step(S, '半身: 拖起 (press and drag) → lifted frames, still 半身 with the same crop; walking and talking keep the cut at the bottom', async () => {
        await stand();
        const crop0 = (await ds()).crop;
        const b = await canvasBox();
        const x0 = b.x + b.width / 2;
        const y0 = b.y + b.height * 0.5;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + i * 6, y0 - i * 3); await sleep(40); }
        let f = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) { f = await fig(); if (f.action === 'lifted') break; await sleep(60); }
        const dragGif = await gif('half-drag', 8, 60, null, 8);
        const cl = await composition(page);
        const sLift = await shot('5-half-lifted');
        const dl = await ds();
        await page.mouse.up();
        assert.equal(f.action, 'lifted');
        assert.equal(dl.framing, 'half', 'still 半身 while dragged');
        assert.equal(dl.crop, crop0, 'the same crop for every action');
        assert.ok(cl.bottom > 0.98 && cl.top < 0.3, `lifted in 半身: head and body in the picture, cut at the bottom: ${JSON.stringify(cl)}`);
        await sleep(900);
        await stand();
        let walking = false;
        for (let i = 0; i < 10 && !walking; i++) {
          page.evaluate(() => window.petFx.walk()).catch(() => {});
          walking = await page.waitForFunction(() => { const f = window.petFx.sprite(); return f && f.action === 'walk'; }, null, { timeout: 1500 }).then(() => true, () => false);
        }
        assert.ok(walking, 'she walks');
        await sleep(300);
        const cw = await composition(page);
        const sWalk = await shot('5-half-walk');
        const walkGif = await gif('half-walk', 10, 80, null, 8);
        halfChecks(cw, 'walking in 半身');
        await page.waitForFunction(() => !window.petFx.stats().walking, null, { timeout: 20000 }).catch(() => {});
        await stand();
        await page.evaluate(() => window.petFx.cue('talk'));
        await page.waitForFunction(() => { const f = window.petFx.sprite(); return f && f.action === 'talk'; }, null, { timeout: 3000 });
        const ct = await composition(page);
        const sTalk = await shot('5-half-talk');
        halfChecks(ct, 'talking in 半身');
        return note(`${dragGif}, ${sLift}: drag → action ${f.action}, data-framing ${dl.framing}, crop ${dl.crop} (= idle crop), opaque box ${JSON.stringify(cl)}; ${sWalk} + ${walkGif}: walking, opaque box ${JSON.stringify(cw)}; ${sTalk}: talking, opaque box ${JSON.stringify(ct)}`);
      }, page);

      await step(S, '后台切回 全身: the whole frame again, pixel for pixel the old drawing, the window unchanged', async () => {
        const b0 = await petBounds(app);
        const burst = gif('glide-to-full', 14, 0, null, 12);
        await pickGlobal('全身');
        const glide = await glideSamples();
        const glideGif = await burst;
        await settled('full');
        await stand();
        const px = await vsSheet(page);
        const c = await composition(page);
        const b = await petBounds(app);
        const s = await shot('6-full-again');
        const d = await ds();
        assert.ok(px.same || (px.maxDelta <= 1 && px.opaqueDiff === 0), `the frame up is drawn as the whole sheet cell (as before 半身; ±1 on semi-transparent edges = alpha rounding): ${JSON.stringify(px)}`);
        assert.ok(Math.abs(c.height - first.comp.height) < 0.03 && Math.abs(c.bottom - first.comp.bottom) < 0.01, `her size back: ${JSON.stringify(c)} vs ${JSON.stringify(first.comp)}`);
        assert.deepEqual(b, b0);
        assert.equal(saved().prefs.framing, 'full');
        assert.equal(d.cut, '1');
        assert.ok(await same());
        const shs = glide.map((g) => g.sh);
        assert.ok(monotonic(shs), shs.join(' '));
        return note(`${s} + ${glideGif}: data-framing=full; canvas vs sheet cell ${JSON.stringify(px)} (before 半身: ${JSON.stringify(first.sheet)}); opaque box ${JSON.stringify(c)}; glide crop height ${shs.map((v) => v.toFixed(1)).join(' → ')}`);
      }, page);

      await step(S, '她的页 → 取景: a pixel look is offered 半身; her own 半身 wins over the global 全身, 跟随全局 goes back', async () => {
        await admin.evaluate(() => { location.hash = '/characters/claude'; });
        await admin.waitForSelector('[data-framing-row="claude"]', { timeout: 10000 });
        const hint = await admin.locator('[data-framing-row="claude"]').textContent();
        assert.match(hint, /半身只显示腰部以上/, 'a pixel look is offered 半身 (no "不能半身取景")');
        assert.doesNotMatch(hint, /不能半身取景/);
        await admin.locator('[data-framing-row="claude"]').getByText('半身', { exact: true }).click();
        await adminToast(/的取景已改为「半身」/);
        await settled('half');
        const sa = await adminShot('7-admin-character-half');
        const sp = await shot('7-character-half');
        const s1 = saved();
        assert.deepEqual(s1.framings, { claude: 'half' });
        assert.equal(s1.prefs.framing, 'full');
        const fr = await page.evaluate(() => window.petFx.framing());
        assert.deepEqual([fr.mode, fr.source, fr.supported], ['half', 'character', true]);
        await admin.locator('[data-framing-row="claude"]').getByText(/跟随全局/).click();
        await adminToast(/的取景已改为「跟随全局（全身）」/);
        await settled('full');
        assert.deepEqual(saved().framings, {});
        return note(`${sa}, ${sp}: row 「${hint.replace(/\s+/g, ' ')}」; framings ${JSON.stringify(s1.framings)} with prefs.framing ${s1.prefs.framing} → pet ${fr.mode} (source ${fr.source}); 跟随全局 → framings {} → full`);
      }, page);

      await step(S, '旧版像素 (claude-classic, 83×113 hard pixel art) in 半身: a 332×452 canvas, every source pixel an even s×s block', async () => {
        await pickPack('claude-classic');
        await settled('full', 15000);
        await stand();
        const f0 = await fig();
        const sF = await shot('8-classic-full');
        await pickGlobal('半身');
        await settled('half');
        await stand();
        const f = await fig();
        const d = await ds();
        const c = await composition(page);
        const sH = await shot('8-classic-half');
        const scale = f.scale; // canvas px per source px (core/framing.js spriteHalfCrop)
        // every s×s block of the canvas is one colour (no uneven pixel sizes)
        const blocks = await page.evaluate(([q, s]) => {
          const cv = document.querySelector(q);
          const im = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          let bad = 0, n = 0;
          for (let by = 0; by + s <= cv.height; by += s) for (let bx = 0; bx + s <= cv.width; bx += s) {
            const o = (by * cv.width + bx) * 4;
            n++;
            let ok = true;
            for (let y = by; y < by + s && ok; y++) for (let x = bx; x < bx + s; x++) { const p = (y * cv.width + x) * 4; if (im[p] !== im[o] || im[p + 1] !== im[o + 1] || im[p + 2] !== im[o + 2] || im[p + 3] !== im[o + 3]) { ok = false; break; } }
            if (!ok) bad++;
          }
          return { n, bad };
        }, [SEL, Math.round(scale)]);
        assert.deepEqual(f0.canvas, [83, 113], '全身: the frame size as before');
        assert.deepEqual(f.canvas, [332, 452]);
        assert.equal(d.band, 'pack');
        assert.equal(d.cut, '0.600');
        assert.ok(Number.isInteger(scale), `whole scale ${scale}`);
        assert.equal(blocks.bad, 0, `uneven blocks: ${JSON.stringify(blocks)}`);
        halfChecks(c, 'classic 半身');
        // zoom in on her face to show the blocks
        const box = await canvasBox();
        await page.screenshot({ path: path.join(SHOTS, '8-classic-half-zoom.png'), clip: { x: box.x + box.width * 0.25, y: box.y, width: box.width * 0.5, height: box.height * 0.45 } });
        return note(`${sF} (全身 canvas ${f0.canvas.join('×')}), ${sH} + sprite-frame/8-classic-half-zoom.png: canvas ${f.canvas.join('×')}, data-cut=${d.cut}, data-band=${d.band}, crop ${d.crop} → ${scale}×${scale} canvas px per source px; ${blocks.n} blocks, ${blocks.bad} uneven; opaque box ${JSON.stringify(c)}`);
      }, page);

      await step(S, 'a restart keeps 半身: the pixel pet starts framed head to waist', async () => {
        await pickPack('claude-pixel');
        await settled('half', 15000);
        assert.equal(saved().prefs.framing, 'half');
        if (admin) await admin.close().catch(() => {});
        admin = null;
        await app.close();
        ({ app, page } = await launch(env));
        watch();
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await settled('half', 30000);
        await stand();
        const c = await composition(page);
        const d = await ds();
        const s = await shot('9-after-restart-half');
        halfChecks(c, 'after restart');
        assert.equal(d.cut, '0.520');
        return note(`${s}: after restart look ${await page.evaluate(() => document.getElementById('pet-look').dataset.key)}, data-framing=${d.framing}, data-cut=${d.cut}, opaque box ${JSON.stringify(c)}`);
      }, page);

      await step(S, 'no renderer error on the page', async () => {
        const real = errors.filter((e) => !/Autofill|Electron Security Warning|DevTools|net::ERR_FILE_NOT_FOUND/.test(e));
        assert.deepEqual(real, []);
        return note('no console errors');
      }, page);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'evidence.txt'), `${evidence.join('\n\n')}\n`);
      await app.close().catch(() => {});
    }
  }

  return { spriteFraming };
};
