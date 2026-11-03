'use strict';

// Live2D 取景 e2e (run.js `live2dframe`, docs/half-body-mode.md "Live2D 实现"), kept out of run.js (over the size
// limit). The built-in 大肥鱼 · Live2D pack (catalog/packs/dafeiyu-live2d) drawn by the real Cubism runtime
// under SwiftShader:
//   全身 → 设置窗口 桌宠行为 → 取景 → 半身: only head to waist, centred, bigger, same window; the model glides (same
//   canvas, never reloaded); in 半身: blinking, 口型 (talk), expressions (happy / sad), gaze following the cursor,
//   touch zones mapped (legs / feet out of reach) and a real click on her head, 拖起, walking, the bubble above her
//   head; back to 全身 = the first placement exactly; her own 取景 on her page; a third-party model without any
//   half-body metadata (imported folder, no pack.json) falls back to her eye line; the homemade VRM under the same
//   setting is half-body too; a restart keeps 半身.
// Screenshots / GIFs in out/e2e/live2d-frame/, the step-by-step record in out/e2e/live2d-frame/evidence.txt.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { makeTestVrm } = require('../scripts/make-test-vrm');

module.exports = function live2dFrameScenarios(ctx) {
  const { ROOT, OUT, FAKE_LH, step, launch, openAdminWindow, petBounds } = ctx;
  const SHOTS = path.join(OUT, 'live2d-frame');
  fs.mkdirSync(SHOTS, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // where her opaque pixels are in a canvas (0..1 of it), read back from the WebGL drawing buffer
  const composition = (page, sel = '#pet-look canvas.live2d') => page.evaluate((q) => {
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
  }, sel);

  async function live2dFraming() {
    const S = 'live2dframe';
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2dframe-'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2dframefake-'));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    // she is 「大肥鱼 · Live2D」 (the built-in Live2D character, chosen at hatching) and stays put (window bounds are compared)
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, prefs: { roam: false } }));
    const env = { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir };
    // a third-party model as a user has it: the 中肥鱼 files in a plain folder, no pack.json (so no halfBody)
    const fix = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2dframe-model-'));
    const own = path.join(fix, 'Whale');
    fs.cpSync(path.join(ROOT, 'catalog', 'packs', 'dafeiyu-live2d', 'model'), own, { recursive: true });
    // the homemade VRM (outside the repo) for 两类角色一致
    const vrmDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-l2dframe-vrm-'));
    const vrmFile = path.join(vrmDir, 'e2e-fish.vrm');
    fs.writeFileSync(vrmFile, makeTestVrm({ name: 'E2E 自制小鱼' }));

    const evidence = [];
    const note = (s) => { evidence.push(s); return s; };
    let { app, page } = await launch(env);
    let errors = [];
    const watch = () => { errors = []; page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`)); };
    watch();
    let admin = null;
    const first = {};
    const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    const shot = async (name) => { await sleep(120); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `live2d-frame/${name}.png`; };
    const ds = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.live2d'); return c ? { ...c.dataset } : null; });
    const fig = async () => (await page.evaluate(() => window.petFx.live2d()))[0] || null;
    const canvasBox = () => page.locator('#pet-look canvas.live2d').boundingBox();
    const settled = (mode, timeout = 15000) => page.waitForFunction((m) => { const c = document.querySelector('#pet-look canvas.live2d'); const f = window.petFx.live2d()[0]; return c && c.dataset.framing === m && f && f.loaded && !f.gliding; }, mode, { timeout });
    const stand = async () => { await page.mouse.move(5, 5); await page.waitForFunction(() => { const s = window.petFx.state(); return s && s.state === 'idle'; }, null, { timeout: 30000 }).catch(() => {}); await sleep(500); };
    const adminToast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
    const adminShot = async (name) => { await sleep(200); await admin.screenshot({ path: path.join(SHOTS, `${name}.png`) }); return `live2d-frame/${name}.png`; };
    const pickGlobal = async (label) => {
      await admin.evaluate(() => { location.hash = '/behavior'; });
      await admin.waitForSelector('[data-path="/behavior"] [data-key="prefs.framing"]');
      await admin.locator('[data-key="prefs.framing"]').getByText(label, { exact: true }).click();
      await adminToast(new RegExp(`已保存：取景 → ${label}`));
    };
    // settings window → her page (the pet window has no 外观 panel since T-2718)
    const adminUntil = async (fn, arg, ms = 15000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        if (await admin.evaluate(fn, arg).catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`settings window: timed out waiting for ${what}`);
        await sleep(150);
      }
    };
    // her page → 装扮 (衣柜 cards, 取景, 导入新角色); `id` a character id, or her base for the current one of hers
    const lookTab = async (id = 'dafeiyu') => {
      if (!admin || admin.isClosed()) admin = await openAdminWindow(app, page, `characters/${id}`);
      await admin.evaluate((x) => { location.hash = `/characters/${x}`; }, id);
      await adminUntil((x) => !!document.querySelector(`[data-path="/characters/${x}"]`), id, 15000, 'her page');
      await admin.evaluate(() => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === '装扮'); if (t) t.click(); });
      await adminUntil(() => !!document.querySelector('[data-import-row]'), null, 10000, '装扮');
    };
    // 角色图鉴 → her page → 切换 (T-2764: every look is a character of her own, there is no 形象包 to put on)
    const switchTo = async (id) => {
      await lookTab(id);
      await adminUntil((x) => !!document.querySelector(`[data-current="${x}"], [data-switch="${x}"]`), id, 10000, `switch ${id}`);
      if (!(await admin.evaluate((x) => !!document.querySelector(`[data-current="${x}"]`), id))) await admin.evaluate((x) => document.querySelector(`[data-switch="${x}"]`).click(), id);
      await adminUntil((x) => !!document.querySelector(`[data-current="${x}"]`), id, 15000, `${id} current`);
      await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), id, { timeout: 10000 });
    };
    // placement samples while switching (the scale moves one way; the same canvas, the model stays loaded)
    const glideSamples = async (ms = 650) => {
      const out = [];
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = await fig();
        out.push({ t: Date.now() - t0, s: f.placement.s, y: f.placement.y, gliding: f.gliding, loaded: f.loaded, same: await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.live2d'); return !!(c && c.e2eMark); }) });
        await sleep(25);
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
      return `live2d-frame/${name}.gif (${n} frames)`;
    };
    const monotonic = (xs) => xs.every((v, i) => i === 0 || (v - xs[i - 1]) * Math.sign(xs[xs.length - 1] - xs[0]) >= -1e-9);
    // ParamEyeLOpen / ParamMouthOpenY / faces over a while
    const sampleParams = async (ms, every = 40) => {
      const out = [];
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const f = await fig(); out.push({ eye: f.params.ParamEyeLOpen, mouth: f.params.ParamMouthOpenY, faces: f.faces, state: (await ds()).frame }); await sleep(every); }
      return out;
    };
    const halfChecks = (c, why) => {
      assert.ok(c.bottom > 0.98, `${why}: cut at the bottom edge (waist): ${JSON.stringify(c)}`);
      assert.ok(c.top < 0.12, `${why}: her head near the top: ${JSON.stringify(c)}`);
      assert.ok(Math.abs(c.cx - 0.5) < 0.1, `${why}: centred: ${JSON.stringify(c)}`);
    };
    try {
      await step(S, 'hatching 「大肥鱼 · Live2D」 (her own character card); 取景 default 全身', async () => {
        await page.waitForSelector('.char-card', { timeout: 20000 });
        await page.click('.char-card[data-character="dafeiyu-live2d"]');
        await page.fill('#pet-name', 'Mow');
        await page.click('#hatch-btn');
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await page.waitForFunction(() => document.getElementById('pet-look').dataset.key.startsWith('dafeiyu-live2d/daily'), null, { timeout: 15000 });
        await settled('full', 30000);
        await page.evaluate(() => { document.querySelector('#pet-look canvas.live2d').e2eMark = 1; });
        const st = await page.evaluate(() => window.pet.getSettings());
        assert.equal(st.prefs.framing, 'full');
        return note(`look ${await page.evaluate(() => document.getElementById('pet-look').dataset.key)}; prefs.framing=${st.prefs.framing}, framings=${JSON.stringify(st.framings)}`);
      }, page);

      await step(S, '全身: head to feet at live2d.height of the canvas, feet on the floor, centred — screenshot', async () => {
        await stand();
        const f = await fig();
        const c = await composition(page);
        Object.assign(first, { placement: f.placement, bounds: await petBounds(app), comp: c, band: f.band });
        const s = await shot('1-full');
        const d = await ds();
        assert.equal(d.framing, 'full');
        assert.equal(d.cut, '1');
        assert.ok(c.bottom > 0.9 && c.top > 0.1, `feet near the bottom, air above: ${JSON.stringify(c)}`);
        return note(`${s}: data-framing=full; opaque box ${JSON.stringify(c)}; placement ${JSON.stringify(f.placement)}; window ${JSON.stringify(first.bounds)}; measured band (unused in 全身) ${JSON.stringify(f.band)}`);
      }, page);

      await step(S, '后台 桌宠行为 → 取景 → 半身: the Live2D pet re-frames at once — head to waist, centred, bigger, same window; a glide, not a reload', async () => {
        admin = await openAdminWindow(app, page, 'behavior');
        await admin.waitForSelector('[data-path="/behavior"] [data-key="prefs.framing"]');
        const desc = await admin.evaluate(() => { const el = document.querySelector('[data-key="prefs.framing"]'); let p = el; for (let i = 0; i < 12 && p; i++) { if (/Live2D/.test(p.textContent)) return p.textContent.replace(/\s+/g, ' ').slice(0, 300); p = p.parentElement; } return null; });
        assert.ok(desc && /VRM、Live2D/.test(desc), `the 取景 card says it works for Live2D: ${desc}`);
        await adminShot('2-admin-behavior-full');
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
        assert.equal(saved().prefs.framing, 'half', 'saved in settings.json');
        assert.equal(d.framing, 'half');
        assert.equal(d.band, 'pack', 'the built-in pack says where her waist is (halfBody.waist)');
        assert.equal(d.cut, '0.520');
        assert.deepEqual(b, first.bounds, 'the window keeps its size and place');
        halfChecks(c, '半身');
        assert.ok(c.fill > first.comp.fill * 1.4, `drawn bigger: fill ${first.comp.fill} → ${c.fill}`);
        assert.ok(f.placement.s > first.placement.s * 1.5, `scale ${first.placement.s} → ${f.placement.s}`);
        const ss = glide.map((g) => g.s);
        assert.ok(glide.some((g) => g.gliding), 'a glide was seen');
        assert.ok(monotonic(ss), `the scale glides one way: ${ss.map((v) => v.toFixed(4)).join(' ')}`);
        assert.ok(glide.every((g) => g.loaded && g.same), 'the same canvas and model throughout (no reload, no blank frame)');
        return note(`${s} + ${glideGif}: data-framing=half, data-cut=${d.cut}, data-band=${d.band}; opaque box ${JSON.stringify(c)} (全身 ${JSON.stringify(first.comp)}); scale ${first.placement.s.toFixed(4)} → ${f.placement.s.toFixed(4)}; window ${JSON.stringify(b)} (unchanged); glide scale ${ss.map((v) => v.toFixed(4)).join(' → ')}; card 「${desc}」`);
      }, page);

      await step(S, '半身: blinking, 口型 while talking, expressions (happy blush / sad gloom) still move her face', async () => {
        await stand();
        const idle = await sampleParams(6500, 30);
        const minEye = Math.min(...idle.map((p) => p.eye));
        const idleGif = await gif('half-idle', 16, 200, null, 5);
        await page.evaluate(() => window.petFx.cue('talk'));
        const talk = await sampleParams(1500);
        const sTalk = await shot('4-half-talk');
        const maxMouth = Math.max(...talk.map((p) => p.mouth));
        await page.evaluate(() => window.petFx.cue('happy'));
        await sleep(900);
        const happy = await fig();
        const sHappy = await shot('4-half-happy');
        await page.evaluate(() => window.petFx.cue('sad'));
        await sleep(900);
        const sad = await fig();
        const sSad = await shot('4-half-sad');
        assert.ok(minEye < 0.3, `a blink in 6.5 s: min ParamEyeLOpen ${minEye}`);
        assert.ok(maxMouth > 0.3, `the mouth opens while talking: max ParamMouthOpenY ${maxMouth}`);
        assert.ok(happy.faces.blush > 0.3, `happy blushes: ${JSON.stringify(happy.faces)}`);
        assert.ok(sad.faces.gloom > 0.15, `sad: gloom ${JSON.stringify(sad.faces)}`);
        assert.equal((await ds()).framing, 'half');
        return note(`${idleGif}; ${sTalk}, ${sHappy}, ${sSad}: min eye-open ${minEye.toFixed(2)} (blink), max mouth ${maxMouth.toFixed(2)} (talk), happy blush ${happy.faces.blush.toFixed(2)}, sad gloom ${sad.faces.gloom.toFixed(2)}; still data-framing=half`);
      }, page);

      await step(S, '半身: her gaze follows the cursor left / right / up, from her face where it is now', async () => {
        await stand();
        const box = await canvasBox();
        const f = await fig();
        const faceY = box.y + ((f.placement.y + f.face.y * (f.size.h / f.original.h) * f.placement.s) / f.canvas.h) * box.height;
        await page.mouse.move(box.x + 2, faceY);
        await sleep(1200);
        const gl = (await ds()).gaze;
        await page.mouse.move(box.x + box.width - 2, faceY);
        await sleep(1200);
        const gr = (await ds()).gaze;
        const sRight = await shot('5-half-gaze-right');
        await page.mouse.move(box.x + box.width / 2, box.y + 2);
        await sleep(1200);
        const gu = (await ds()).gaze;
        const xs = [1, 0.75, 0.5, 0.25, 0, 0, 0.25, 0.5, 0.75, 1, 1];
        const sweep = await gif('half-gaze', xs.length * 2, 120, async (i) => { const k = xs[Math.floor(i / 2)]; await page.mouse.move(box.x + 2 + (box.width - 4) * k, faceY); }, 6);
        const x = (g) => Number(g.split(',')[0]);
        const y = (g) => Number(g.split(',')[1]);
        assert.ok(x(gl) < -0.3 && x(gr) > 0.3, `left ${gl} right ${gr}`);
        assert.ok(Math.abs(y(gl)) < 0.25 && Math.abs(y(gr)) < 0.25, `level with her face: ${gl} / ${gr}`);
        assert.ok(y(gu) > 0.3, `up: ${gu}`);
        return note(`${sRight} + ${sweep}: data-gaze at her face height: left ${gl}, right ${gr}; cursor above her: ${gu}`);
      }, page);

      await step(S, '半身: touch zones map onto her upper body (legs / feet out of reach); a click on her head is a head touch', async () => {
        await stand();
        const box = await canvasBox();
        const probe = (fx, fy) => page.evaluate(([px, py]) => window.petFx.touchPoint(px, py), [box.x + box.width * fx, box.y + box.height * fy]);
        const rows = [];
        const zones = new Set();
        let headAt = null;
        for (const fy of [0.08, 0.15, 0.22, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.97]) {
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
        const st = (await ds()).frame;
        const s = await shot('6-half-touch-head');
        assert.match(st, /^touch-head#/);
        return note(`${s}: touchPoint down the middle: ${rows.join('; ')}; click at y=${headAt} → lastTouch ${JSON.stringify({ zone: t.zone, mood: t.mood })}, drawn state ${st}`);
      }, page);

      await step(S, '半身: 拖起 (press and drag) → lifted and dangling, still 半身; walking keeps the cut at the bottom', async () => {
        await stand();
        const b = await canvasBox();
        const x0 = b.x + b.width / 2;
        const y0 = b.y + b.height * 0.5;
        const w0 = await petBounds(app);
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + i * 6, y0 - i * 3); await sleep(40); }
        const dragGif = await gif('half-drag', 8, 60, null, 8);
        let l = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) { l = await ds(); if (/^lifted#/.test(l.frame)) break; await sleep(60); }
        const sLift = await shot('7-half-lifted');
        await page.mouse.up();
        assert.match(l.frame, /^lifted#/);
        assert.equal(l.framing, 'half', 'still 半身 while dragged');
        await sleep(900);
        const w1 = await petBounds(app);
        await stand(); // landed (a release may throw her a little)
        let walking = false;
        for (let i = 0; i < 10 && !walking; i++) {
          page.evaluate(() => window.petFx.walk()).catch(() => {});
          walking = await page.waitForFunction(() => /^walk#/.test(document.querySelector('#pet-look canvas.live2d').dataset.frame), null, { timeout: 1500 }).then(() => true, () => false);
        }
        assert.ok(walking, 'she walks');
        await sleep(400);
        const cw = await composition(page);
        const sWalk = await shot('7-half-walk');
        const walkGif = await gif('half-walk', 10, 80, null, 8);
        assert.ok(cw.bottom > 0.98 && cw.top < 0.15, `walking in 半身: ${JSON.stringify(cw)}`);
        await page.waitForFunction(() => !window.petFx.stats().walking, null, { timeout: 20000 }).catch(() => {});
        return note(`${dragGif}, ${sLift}: drag → ${l.frame}, data-framing ${l.framing}; window ${w0.x},${w0.y} → ${w1.x},${w1.y}; ${sWalk} + ${walkGif}: walking, opaque box ${JSON.stringify(cw)}`);
      }, page);

      await step(S, '半身: the speech bubble sits above her, clear of her face', async () => {
        await stand();
        await page.evaluate(() => window.petFx.error()); // a line in her bubble
        await sleep(300);
        const bub = await page.evaluate(() => { const b = document.getElementById('bubble'); return b && !b.classList.contains('hidden') ? b.getBoundingClientRect().toJSON() : null; });
        const box = await canvasBox();
        const f = await fig();
        const k = f.size.h / f.original.h;
        const eyesTop = box.y + ((f.placement.y + f.eyes.top * k * f.placement.s) / f.canvas.h) * box.height;
        const s = await shot('8-half-bubble');
        assert.ok(bub, 'a bubble is shown');
        assert.ok(bub.bottom <= eyesTop, `the bubble (bottom ${bub.bottom}) stays above her eyes (${eyesTop.toFixed(1)})`);
        return note(`${s}: bubble ${JSON.stringify({ top: Math.round(bub.top), bottom: Math.round(bub.bottom) })}, her eyes from y=${eyesTop.toFixed(1)} (client px)`);
      }, page);

      await step(S, '后台切回 全身: exactly the first placement and composition again, the window unchanged', async () => {
        const b0 = await petBounds(app);
        const burst = gif('glide-to-full', 14, 0, null, 12);
        await pickGlobal('全身');
        const glide = await glideSamples();
        const glideGif = await burst;
        await settled('full');
        await stand();
        const f = await fig();
        const c = await composition(page);
        const b = await petBounds(app);
        const s = await shot('9-full-again');
        for (const k of ['s', 'x', 'y']) assert.ok(Math.abs(f.placement[k] - first.placement[k]) < 1e-9, `placement ${JSON.stringify(f.placement)} vs ${JSON.stringify(first.placement)}`);
        assert.deepEqual(b, b0);
        assert.equal(saved().prefs.framing, 'full');
        assert.equal((await ds()).cut, '1');
        const ss = glide.map((g) => g.s);
        assert.ok(monotonic(ss), ss.join(' '));
        assert.ok(glide.every((g) => g.loaded && g.same));
        // her size on screen is back (her pose may differ: she was just idling, a hop or a nod moves her a little)
        assert.ok(Math.abs(c.fill - first.comp.fill) < 0.03 && Math.abs(c.height - first.comp.height) < 0.03, `composition back: ${JSON.stringify(c)} vs ${JSON.stringify(first.comp)}`);
        return note(`${s} + ${glideGif}: data-framing=full; placement ${JSON.stringify(f.placement)} = the first; opaque box ${JSON.stringify(c)} (first ${JSON.stringify(first.comp)}); glide scale ${ss.map((v) => v.toFixed(4)).join(' → ')}`);
      }, page);

      await step(S, '她的页 → 装扮 → 取景: 「大肥鱼 · Live2D」 her own 半身 wins over the global 全身 (Live2D card text), 跟随全局 goes back', async () => {
        // her character's own page: 取景 is saved per character (T-2764), here 「大肥鱼 · Live2D」
        await admin.evaluate(() => { location.hash = '/characters/dafeiyu-live2d'; });
        await admin.waitForSelector('[data-framing-row="dafeiyu-live2d"]', { timeout: 10000 });
        const hint = await admin.locator('[data-framing-row="dafeiyu-live2d"]').textContent();
        assert.match(hint, /半身只显示腰部以上/, 'a Live2D look is offered 半身 (not "只有 VRM")');
        await admin.locator('[data-framing-row="dafeiyu-live2d"]').getByText('半身', { exact: true }).click();
        await adminToast(/的取景已改为「半身」/);
        await settled('half');
        const sa = await adminShot('10-admin-character-half');
        const sp = await shot('10-character-half');
        const s1 = saved();
        assert.deepEqual(s1.framings, { 'dafeiyu-live2d': 'half' });
        assert.equal(s1.prefs.framing, 'full');
        const fr = await page.evaluate(() => window.petFx.framing());
        assert.deepEqual([fr.mode, fr.source, fr.supported], ['half', 'character', true]);
        await admin.locator('[data-framing-row="dafeiyu-live2d"]').getByText(/跟随全局/).click();
        await adminToast(/的取景已改为「跟随全局（全身）」/);
        await settled('full');
        assert.deepEqual(saved().framings, {});
        return note(`${sa}, ${sp}: row 「${hint.replace(/\s+/g, ' ')}」; framings ${JSON.stringify(s1.framings)} with prefs.framing ${s1.prefs.framing} → pet ${fr.mode} (source ${fr.source}); 跟随全局 → framings {} → full`);
      }, page);

      await step(S, 'a third-party Live2D model without half-body metadata (imported folder, no pack.json): 半身 falls back to her eye line', async () => {
        // 设置窗口 → 她的页 → 装扮 → 导入 Live2D… as the owner does: the folder becomes a pack and she wears it
        await page.evaluate((x) => window.pet.debugNextOpen(x), own);
        await lookTab();
        await adminUntil(() => document.querySelectorAll('[role="tabpanel"]').length === 1 && !!document.querySelector('[role="tabpanel"] [data-import-live2d]'), null, 10000, '导入 Live2D… in the live 装扮 panel');
        const nBtn = await admin.evaluate(() => { const b = document.querySelectorAll('[data-import-live2d]'); b[b.length - 1].click(); return b.length; });
        // the import is a new character and she becomes her at once: her look becomes the new pack
        await page.waitForFunction(() => document.getElementById('pet-look').dataset.key.startsWith('l2d-'), null, { timeout: 60000 });
        const msg = `导入 Live2D…（${nBtn} 个按钮）→ 她穿上了 ${await page.getAttribute('#pet-look', 'data-key')}`;
        await page.waitForFunction(() => document.getElementById('pet-look').dataset.key.startsWith('l2d-'), null, { timeout: 15000 });
        const imp = { pack: { id: (await page.evaluate(() => document.getElementById('pet-look').dataset.key)).split('/')[0] } };
        const manifest = JSON.parse(fs.readFileSync(path.join(data, 'packs', imp.pack.id, 'pack.json'), 'utf8'));
        assert.equal(manifest.halfBody, undefined, 'the generated pack.json has no halfBody');
        // T-2764: the import is a character of her own — her page opens, she is 当前角色, 角色图鉴 lists her next to
        // 「大肥鱼 · Live2D」, and her 衣柜 is a card list with the outfit she has on (可穿衣: 穿上 it again works)
        const L = imp.pack.id;
        await adminUntil((x) => location.hash === `#/characters/${x}` && !!document.querySelector(`[data-current="${x}"]`), L, 15000, 'her own page, current');
        const roster = await admin.evaluate(async () => (await window.petAdmin.state()).roster.map((r) => r.id));
        assert.ok(roster.includes(L) && roster.includes('dafeiyu-live2d'), `角色图鉴: ${roster.join(', ')}`);
        const me = (await page.evaluate(async () => (await window.pet.boot()).view)).characters.find((c) => c.id === L);
        assert.ok(me && me.base === 'dafeiyu' && me.kind === 'live2d' && me.source === 'user', JSON.stringify(me));
        await adminUntil((x) => !!document.querySelector(`[data-outfits="${x}"] [data-outfit]`), L, 10000, '衣柜 cards');
        const rack = await admin.evaluate((x) => [...document.querySelectorAll(`[data-outfits="${x}"] [data-outfit]`)].map((c) => ({ id: c.dataset.outfit, equipped: c.dataset.equipped === 'true', locked: c.dataset.locked === 'true' })), L);
        assert.equal(rack.filter((o) => o.equipped).length, 1, JSON.stringify(rack));
        const worn = rack.find((o) => o.equipped).id;
        const eq = await admin.evaluate((x) => window.petAdmin.equipOutfit(x.o, x.id), { o: worn, id: L });
        assert.equal(eq.ok, true, JSON.stringify(eq).slice(0, 200));
        await admin.evaluate((x) => document.querySelector(`[data-outfits="${x}"]`).scrollIntoView({ block: 'center' }), L);
        const sR = await adminShot('11-thirdparty-character-wardrobe');
        await settled('full', 30000);
        await stand();
        const sF = await shot('11-thirdparty-full');
        await pickGlobal('半身');
        await settled('half');
        await stand();
        const f = await fig();
        const c = await composition(page);
        const sH = await shot('11-thirdparty-half');
        assert.equal(f.band.source, 'eyes');
        assert.ok(f.band.waist > 0.4 && f.band.waist < 0.65, JSON.stringify(f.band));
        halfChecks(c, 'third-party 半身');
        return note(`${sR}: new character ${L} (base ${me.base}, kind ${me.kind}, ${me.source}) current, in 角色图鉴; 衣柜 ${rack.map((o) => `${o.id}${o.equipped ? '[正在穿]' : ''}${o.locked ? '[🔒]' : ''}`).join('、')}, 穿上 ${worn} → ok\n${sF}, ${sH}: 「${msg}」 pack ${imp.pack.id} (pack.json without halfBody): band ${JSON.stringify(f.band)} (eyes ${JSON.stringify(f.eyes)}); opaque box ${JSON.stringify(c)}`);
      }, page);

      await step(S, '两类角色一致: under the same 半身 setting the VRM look is half-body too (same window, cut at the bottom, head at the top)', async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), vrmFile);
        const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
        assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
        await switchTo(imp.pack.id);
        await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); const f = window.petFx.vrm(); return c && c.dataset.framing === 'half' && f && f.figures[0] && !f.figures[0].gliding && Number(c.dataset.frame) > 5; }, null, { timeout: 60000 });
        await stand();
        const cv = await composition(page, '#pet-look canvas.vrm');
        const sV = await shot('12-vrm-half-same-setting');
        await switchTo('dafeiyu-live2d');
        await settled('half', 30000);
        await stand();
        const cl = await composition(page);
        const sL = await shot('12-live2d-half-same-setting');
        assert.equal(saved().prefs.framing, 'half');
        halfChecks(cv, 'VRM 半身');
        halfChecks(cl, 'Live2D 半身');
        return note(`${sV} (VRM: ${JSON.stringify(cv)}) / ${sL} (Live2D: ${JSON.stringify(cl)}) — prefs.framing=half for both`);
      }, page);

      await step(S, 'a restart keeps 半身: the Live2D pet starts framed head to waist', async () => {
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
        const s = await shot('13-after-restart-half');
        halfChecks(c, 'after restart');
        return note(`${s}: after restart data-framing=${(await ds()).framing}, opaque box ${JSON.stringify(c)}`);
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

  return { live2dFraming };
};
