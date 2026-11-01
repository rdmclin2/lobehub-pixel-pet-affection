// Real-model VRM acceptance (T-2654): a VRM the user downloaded themselves — e.g. 木子惡魔's 《蓝色小肥鱼Deepseek》 —
// is imported through 外观 → 导入 VRM 模型… on the real app (the native file dialog answered by the test hook),
// then: 导入确认 / card / 授权信息, the figure on the desk, 摸摸 / 拖起 / 喂食 / 玩耍, lip sync from her voice-pack
// line, the idle frame budget, 18+ off, back to dafeiyu-pixel / dafeiyu-classic and to the VRM again.
// The model is never copied into the repository: the path must be outside ROOT, and the app copies it into the
// temp userData only. Phase 2 (transparency) relaunches the same userData without PIXELPET_TEST; see
// vrm-transparent-desk.sh.
// usage: xvfb-run -a -s '-screen 0 1280x800x24' node .agents/acceptance/scripts/vrm-real-model-acceptance.js <repo> <out dir> <model.vrm> [userData dir]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

const [ROOT, OUT, MODEL] = process.argv.slice(2, 5).map((p) => path.resolve(p));
const DATA = process.argv[5] ? path.resolve(process.argv[5]) : fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-real-data-'));
if (!path.relative(ROOT, MODEL).startsWith('..')) throw new Error(`the model must live outside the repository: ${MODEL}`);
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
const log = [];
const chapters = [];
let T0 = null;
const t = () => (T0 == null ? 0 : (Date.now() - T0) / 1000);
const note = (s) => { const line = `[${t().toFixed(1)}s] ${s}`; log.push(line); console.log(line); };
const mark = (title) => { chapters.push({ t: Number(t().toFixed(1)), title }); note(`== ${title}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

(async () => {
  const fakeLh = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-real-lh-'));
  fs.writeFileSync(path.join(fakeLh, 'loggedin'), '1');
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: false }));
  note(`revision ${execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()} (worktree ${ROOT})`);
  note(`model ${MODEL} (${fs.statSync(MODEL).size} bytes), userData ${DATA}`);
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    cwd: ROOT,
    env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: DATA, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fakeLh },
    recordVideo: { dir: path.join(OUT, 'video'), size: { width: 460, height: 540 } },
  });
  const page = await app.firstWindow();
  T0 = Date.now();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  let ok = true;
  const check = (cond, msg) => { note(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) ok = false; return cond; };
  const shot = async (n, opts = {}) => { await sleep(150); await page.screenshot({ path: path.join(OUT, n), ...opts }); note(`shot ${n}`); };
  const ds = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c ? { ...c.dataset } : null; });
  const fig = async () => { const d = await page.evaluate(() => window.petFx.vrm()); return d && d.figures[0]; };
  const hover = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
  const clickAct = async (act) => { await hover(); await page.click(`[data-act="${act}"]`); };
  const openCurrentPage = async () => {
    await clickAct('menu');
    await page.click('[data-menu="characters"]');
    await page.waitForSelector('.char-list .char-opt');
    await page.waitForFunction(() => window.innerWidth >= 400, null, { timeout: 5000 });
    const id = await page.getAttribute('.char-list .char-opt.on', 'data-species');
    await page.click(`.char-list .char-opt[data-species="${id}"] .char-open`);
    await page.waitForSelector(`#char-head .char-opt[data-species="${id}"]`);
  };
  const pickPack = async (id) => {
    await openCurrentPage();
    await page.locator(`.pack-opt[data-pack="${id}"]`).scrollIntoViewIfNeeded();
    if (!(await page.locator(`.pack-opt.on[data-pack="${id}"]`).count())) await page.click(`.pack-opt[data-pack="${id}"] .pick`);
    await page.waitForSelector(`.pack-opt.on[data-pack="${id}"]`);
    await page.click('#panel-close');
    await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), id, { timeout: 15000 });
  };
  const drawing = (n = 2) => page.waitForFunction((k) => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > k; }, n, { timeout: 90000 });
  const petBox = () => page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
  const rest = async () => { await page.waitForFunction(() => { const s = window.petFx.state(); return s && /^(idle|walk|sit|bored)$/.test(s.state); }, null, { timeout: 15000 }).catch(() => {}); await sleep(400); };
  const fmtMotion = (m) => Object.entries(m || {}).filter(([, v]) => Math.abs(v) > 0.05).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
  const peak = async (want, ms = 3000) => {
    const t0 = Date.now();
    let best = null;
    while (Date.now() - t0 < ms) {
      const d = await ds();
      const f = await fig();
      best = { state: d.state, expr: d.expr, mouth: d.mouth, motion: f.motion, frame: d.frame, mode: d.mode, fps: d.fps };
      if (want(best)) break;
      await sleep(60);
    }
    return best;
  };
  let ID = null;
  try {
    mark('孵化大肥鱼（默认像素外观）');
    await page.waitForSelector('.char-card', { timeout: 20000 });
    await page.click('.char-card[data-species="dafeiyu"]');
    await page.fill('#pet-name', '小肥鱼');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
    await shot('01-hatched-pixel.png');

    mark('外观 → 导入 VRM 模型…（真实模型）→ 导入确认');
    await openCurrentPage();
    await page.locator('#vrm-import').scrollIntoViewIfNeeded();
    await page.evaluate((x) => window.pet.debugNextOpen(x), MODEL); // answers the native file dialog
    await page.click('#vrm-import');
    await page.waitForSelector('#vrm-confirm', { timeout: 60000 });
    const confirmText = (await page.textContent('#vrm-confirm')).replace(/\s+/g, ' ');
    const restrictions = await page.$$eval('#vrm-confirm .vrm-restrictions li', (ls) => ls.map((l) => `${l.dataset.id}: ${l.textContent.trim()}`));
    results.confirm = { text: confirmText, restrictions };
    for (const s of ['蓝色小肥鱼Deepseek', '木子恶魔', '仅限个人非商业使用', '不允许', '禁止修改', '需要署名']) check(confirmText.includes(s), `导入确认 contains 「${s}」`);
    await shot('02-import-confirm.png');
    await page.locator('#vrm-confirm .vrm-restrictions').scrollIntoViewIfNeeded().catch(() => {});
    await shot('02b-import-confirm-restrictions.png');

    mark('使用这个模型 → 角色包卡片（署名、导出禁用）');
    await page.click('#vrm-confirm [data-act="use"]');
    await page.waitForSelector('.pack-opt.on[data-pack^="vrm-"]', { timeout: 60000 });
    ID = await page.getAttribute('.pack-opt.on[data-pack^="vrm-"]', 'data-pack');
    const msg = (await page.textContent('#panel-msg')).trim();
    const metaLine = (await page.textContent(`.pack-opt[data-pack="${ID}"] .meta span`)).trim();
    const credit = (await page.textContent(`.pack-opt[data-pack="${ID}"] .vrm-credit`)).trim();
    const exportDisabled = await page.locator(`.pack-opt[data-pack="${ID}"] .pack-export`).isDisabled();
    const noExport = (await page.textContent(`.vrm-noexport[data-pack="${ID}"]`)).trim();
    results.card = { ID, msg, metaLine, credit, exportDisabled, noExport };
    check(/木子恶魔/.test(credit) && exportDisabled, `card: 「${metaLine}」 / 「${credit}」 / export disabled=${exportDisabled} / 「${noExport}」 / msg 「${msg}」`);
    await page.locator(`.pack-opt[data-pack="${ID}"]`).scrollIntoViewIfNeeded();
    await shot('03-pack-card.png');

    mark('授权信息');
    await page.click(`.pack-opt[data-pack="${ID}"] .vrm-info`);
    const licSel = `.pack-list .vrm-license[data-pack="${ID}"]`;
    await page.waitForSelector(licSel);
    const lic = (await page.textContent(licSel)).replace(/\s+/g, ' ');
    results.license = lic;
    check(/仅限个人非商业使用 \/ 不可再分发 \/ 禁止修改 \/ 需署名/.test(lic) && /木子恶魔/.test(lic), `授权信息: ${lic.slice(0, 300)}`);
    await page.locator(licSel).scrollIntoViewIfNeeded();
    await shot('04-license-info.png');
    const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'packs', ID, 'pack.json'), 'utf8'));
    results.manifest = manifest;
    note(`userData pack.json: ${JSON.stringify(manifest).slice(0, 600)}`);

    mark('桌面：three-vrm 绘制真实模型');
    await page.click('#panel-close');
    await drawing(2);
    const a = await ds();
    await sleep(1000);
    const b = await ds();
    const F = await fig();
    results.desk = { a, b, expressions: F.expressions, springJoints: F.springJoints, memory: F.memory };
    check(Number(b.frame) > Number(a.frame) && F.loaded, `frame ${a.frame} → ${b.frame} in 1 s (fps ${b.fps}, mode ${b.mode}); ${F.expressions.length} expressions [${F.expressions.join(',')}], SpringBone joints ${F.springJoints}`);
    const canvasBox = await page.locator('#pet-look canvas.vrm').boundingBox();
    const alpha = await page.evaluate(() => {
      const c = document.querySelector('#pet-look canvas.vrm');
      const g = c.getContext('webgl2') || c.getContext('webgl');
      const px = (x, y) => { const p = new Uint8Array(4); g.readPixels(x, y, 1, 1, g.RGBA, g.UNSIGNED_BYTE, p); return [...p]; };
      const w = g.drawingBufferWidth; const h = g.drawingBufferHeight;
      let drawn = 0; let clear = 0; const N = 40;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const p = px(Math.floor((i + 0.5) * w / N), Math.floor((j + 0.5) * h / N)); if (p[3] > 0) drawn++; else clear++; }
      return { w, h, corners: [px(1, 1), px(w - 2, 1), px(1, h - 2), px(w - 2, h - 2)], drawn, clear };
    });
    results.alpha = alpha;
    check(alpha.corners.every((p) => p[3] === 0) && alpha.drawn > 20, `canvas alpha: corners ${JSON.stringify(alpha.corners)}, ${alpha.drawn} drawn / ${alpha.clear} clear samples of 1600`);
    await shot('05-desk-vrm.png');

    mark('空闲降帧');
    await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height * 0.25);
    await page.evaluate(() => window.petFx.cue('happy'));
    await sleep(900);
    const act = await ds();
    await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.mode === 'idle', null, { timeout: 30000 });
    await sleep(2200);
    const i0 = await ds();
    // the page's own animation ticks over the same 2 s: the renderer skips most of them when idle
    const raf = page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); }));
    await sleep(2000);
    const i1 = await ds();
    const rafTicks = await raf;
    const measured = (Number(i1.frame) - Number(i0.frame)) / 2;
    results.idle = { active: { mode: act.mode, fps: act.fps, frame: act.frame }, idle0: { mode: i0.mode, fps: i0.fps, frame: i0.frame }, idle1: { mode: i1.mode, fps: i1.fps, frame: i1.frame }, measuredIdleFps: measured, rafTicksIn2s: rafTicks, budget: { activeFps: 30, idleFps: 12, idleAfterMs: 6000 } };
    // SwiftShader draws this textured model at ~10–13 frames/s, under both budgets (active 30 / idle 12), so the
    // fps alone cannot drop much here: check the mode switch and that idle stays within its 12 fps budget
    check(act.mode === 'active' && i1.mode === 'idle' && measured <= 12.5, `active mode ${act.mode} fps ${act.fps} → idle mode ${i1.mode} fps ${i1.fps}; frames ${i0.frame} → ${i1.frame} in 2 s = ${measured}/s rendered vs ${rafTicks} animation ticks (${rafTicks / 2}/s) offered by the page`);
    await shot('06-idle.png');
    // hidden (the window hidden by main, as when minimised / tucked away): no frames at all
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await sleep(800);
    const h0 = await ds();
    await sleep(2000);
    const h1 = await ds();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
    await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.mode !== 'paused', null, { timeout: 10000 }).catch(() => {});
    await sleep(800);
    const h2 = await ds();
    results.hidden = { hidden0: { mode: h0.mode, fps: h0.fps, frame: h0.frame }, hidden1: { mode: h1.mode, fps: h1.fps, frame: h1.frame }, shownAgain: { mode: h2.mode, fps: h2.fps, frame: h2.frame } };
    check(h0.mode === 'paused' && h1.frame === h0.frame && Number(h2.frame) > Number(h1.frame), `hidden: mode ${h0.mode}, frames ${h0.frame} → ${h1.frame} in 2 s; shown again: mode ${h2.mode}, frame ${h2.frame}`);

    await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
    mark('摸摸（点击她）');
    await rest();
    let s = null; const tried = [];
    for (let i = 0; i < 4 && !(s && s.state === 'pat'); i++) {
      if (i) await rest();
      const bx = await petBox();
      await page.mouse.click(bx.x + bx.width / 2, bx.y + bx.height * 0.45);
      s = await peak((x) => x.state === 'pat' && /relaxed:/.test(x.expr) && x.motion.nodDown > 3);
      tried.push(`${s.state}{${s.expr}}`);
    }
    await shot('07-pat.png');
    results.pat = s;
    check(s.state === 'pat' && /relaxed:/.test(s.expr), `pat (clicks: ${tried.join(' → ')}): expr ${s.expr}, motion ${fmtMotion(s.motion)}`);

    mark('拖起（按住拖动）');
    await rest();
    const bx = await petBox();
    const x0 = bx.x + bx.width / 2; const y0 = bx.y + bx.height * 0.45;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + i * 6, y0 - i * 3); await sleep(40); }
    s = await peak((x) => x.state === 'lifted' && /surprised:/.test(x.expr) && x.motion.dangle > 0.5);
    await shot('08-lifted.png');
    await page.mouse.up();
    results.lifted = s;
    check(s.state === 'lifted' && /surprised:/.test(s.expr), `lifted: expr ${s.expr}, motion ${fmtMotion(s.motion)}`);

    mark('喂食');
    await rest();
    await page.evaluate(() => window.pet.debugSet({ hunger: 60 }));
    await clickAct('feed');
    await page.click('#food-menu button');
    s = await peak((x) => /^eat/.test(x.state) && /happy:/.test(x.expr) && x.motion.chew > 0.5);
    await shot('09-feed.png');
    results.feed = s;
    check(/^eat/.test(s.state) && /happy:/.test(s.expr), `feed: state ${s.state}, expr ${s.expr}, motion ${fmtMotion(s.motion)}`);

    mark('玩耍');
    await page.waitForFunction(() => !/^eat/.test(window.petFx.state().state), null, { timeout: 10000 }).catch(() => {});
    await rest();
    await clickAct('play');
    s = await peak((x) => x.state === 'play' && /happy:/.test(x.expr) && x.motion.spin > 0.3);
    await shot('10-play.png');
    results.play = s;
    check(s.state === 'play' && /happy:/.test(s.expr), `play: state ${s.state}, expr ${s.expr}, motion ${fmtMotion(s.motion)}`);

    mark('互动语音口型（语音包台词）');
    await page.evaluate(() => window.pet.setPrefs({ voice: true }));
    await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return !sp || !/^(queued|synthesizing|playing|speaking)$/.test(sp.status); }, null, { timeout: 15000 }).catch(() => {});
    await rest();
    await sleep(1700);
    const n0 = (await page.evaluate(() => window.petFx.offerLog())).length;
    const pb = await petBox();
    await page.mouse.click(pb.x + pb.width / 2, pb.y + pb.height * 0.45);
    await page.waitForFunction((n) => window.petFx.offerLog().slice(n).some((e) => e.kind === 'pat' && e.n), n0, { timeout: 15000 });
    await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return sp && sp.status === 'playing'; }, null, { timeout: 15000 });
    const lipDir = path.join(OUT, 'lipsync-frames');
    fs.mkdirSync(lipDir, { recursive: true });
    const cb = await page.locator('#pet-look canvas.vrm').boundingBox();
    const clip = { x: Math.max(0, cb.x), y: Math.max(0, cb.y), width: Math.min(cb.width, 400), height: Math.min(cb.height * 0.6, 400) };
    const mouths = [];
    for (let i = 0; i < 80; i++) {
      const d = await ds();
      const st = await page.evaluate(() => window.petFx.lastSpeech().status);
      mouths.push({ ms: Date.now() - T0, lip: d.lip, mouth: d.mouth, status: st });
      await page.screenshot({ path: path.join(lipDir, `f${String(i).padStart(3, '0')}.png`), clip });
      if (st !== 'playing') break;
    }
    const sp = await page.evaluate(() => window.petFx.lastSpeech());
    await page.waitForFunction(() => { const x = window.petFx.lastSpeech(); return x && x.status !== 'playing'; }, null, { timeout: 15000 });
    await sleep(700);
    const after = [];
    for (let i = 0; i < 5; i++) { const d = await ds(); after.push(`${d.lip}{${d.mouth}}`); await sleep(150); }
    const playing = mouths.filter((m) => m.status === 'playing');
    const shapes = new Set(); let maxOpen = 0;
    for (const m of playing) for (const [k, x] of m.mouth.split(',').map((p) => p.split(':'))) { if (Number(x) > 0.1) shapes.add(k); maxOpen = Math.max(maxOpen, Number(x)); }
    results.lipsync = { speech: { provider: sp.provider, text: sp.text }, samples: mouths, after, shapes: [...shapes], maxOpen };
    check(sp.provider === 'pack' && playing.some((m) => m.lip === 'audio') && maxOpen > 0.2, `speech 「${sp.text}」 (provider ${sp.provider}): ${playing.length} frames while playing, shapes ${[...shapes].join(',')}, max open ${maxOpen.toFixed(2)}`);
    check(after.every((x) => /aa:0\.00,ih:0\.00,ou:0\.00,ee:0\.00,oh:0\.00/.test(x)), `after speech: ${after.join(' | ')}`);
    await page.evaluate(() => window.pet.setPrefs({ voice: false }));

    mark('18+ 关闭：成人向服饰不可选');
    const st0 = await page.evaluate(() => window.pet.getSettings());
    await page.evaluate(() => window.pet.unlockAll('dafeiyu'));
    await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 8000 }).catch(() => {});
    if (await page.locator('#toast-open:visible').count()) await page.click('#toast-open'); else await clickAct('wardrobe');
    await page.waitForSelector('#panel:not(.hidden) .card');
    const cards = await page.$$eval('.card', (cs) => cs.map((c) => ({ id: c.dataset.outfit, label: c.querySelector('.nm').textContent, locked: c.classList.contains('locked'), adultTag: !!c.querySelector('.tag.adult') })));
    const eq = await page.evaluate(() => window.pet.equipOutfit('maid'));
    const adultKeys = Object.keys(manifest.vrm.outfits);
    results.adult = { settings: { ageConfirmed: st0.ageConfirmed, adultContent: st0.adultContent }, cards, equipMaid: eq, vrmOutfits: adultKeys, allowExcessivelySexualUsage: manifest.vrm && manifest.vrm.meta ? manifest.vrm.meta.allowExcessivelySexualUsage : undefined };
    check(st0.adultContent === false && !cards.some((c) => c.id === 'maid' || c.adultTag) && eq.ok === false, `adultContent=${st0.adultContent}; wardrobe (all unlocked): ${cards.map((c) => `${c.label}${c.locked ? '🔒' : ''}`).join('、')}; equipOutfit(maid) → ok=${eq.ok} ${eq.reason || ''}; VRM pack outfits: ${adultKeys.join(',')}`);
    await shot('11-adult-off-wardrobe.png');
    await page.locator('.card').last().scrollIntoViewIfNeeded();
    await shot('11b-adult-off-wardrobe-end.png');
    await page.click('#panel-close');

    mark('切回 dafeiyu-pixel');
    await pickPack('dafeiyu-pixel');
    await page.waitForFunction(() => !document.querySelector('#pet-look canvas.vrm') && window.PetVRM.stats.live === 0, null, { timeout: 10000 });
    await sleep(600);
    const k1 = await page.evaluate(() => ({ key: document.getElementById('pet-look').dataset.key, stats: window.PetVRM.stats }));
    check(k1.key.startsWith('dafeiyu-pixel/'), `look ${k1.key}, PetVRM.stats ${JSON.stringify(k1.stats)}`);
    await shot('12-back-to-dafeiyu-pixel.png');

    mark('切到 dafeiyu-classic');
    await pickPack('dafeiyu-classic');
    await sleep(600);
    const k2 = await page.evaluate(() => ({ key: document.getElementById('pet-look').dataset.key, img: (document.querySelector('#pet-look img, #pet-look canvas') || {}).outerHTML?.slice(0, 160) }));
    check(k2.key.startsWith('dafeiyu-classic/'), `look ${k2.key}, element ${k2.img}`);
    await shot('13-dafeiyu-classic.png');
    results.back2d = { pixel: k1, classic: k2 };

    mark('再切回真实 VRM');
    await pickPack(ID);
    await drawing(2);
    await sleep(1000);
    const st2 = await page.evaluate(() => window.PetVRM.stats);
    check(st2.live === 1, `VRM again: stats ${JSON.stringify(st2)}`);
    await shot('14-vrm-again.png');
    // leave her wearing the VRM so phase 2 (non-test, transparent window) starts in it
    const realErr = errors.filter((e) => !/Autofill|Electron Security Warning|DevTools|net::ERR_FILE_NOT_FOUND/.test(e));
    results.errors = realErr;
    check(realErr.length === 0, `console errors: ${JSON.stringify(realErr).slice(0, 400)}`);
  } catch (e) {
    ok = false;
    note(`ERROR ${e.stack}`);
    await shot('error.png').catch(() => {});
  } finally {
    results.chapters = chapters;
    fs.writeFileSync(path.join(OUT, 'real-vrm-log.txt'), `${log.join('\n')}\n`);
    fs.writeFileSync(path.join(OUT, 'real-vrm-results.json'), `${JSON.stringify(results, null, 2)}\n`);
    await app.close().catch(() => {});
    note(ok ? 'ALL PASS' : 'SOME FAILED');
    fs.writeFileSync(path.join(OUT, 'real-vrm-log.txt'), `${log.join('\n')}\n`);
    process.exit(ok ? 0 : 1);
  }
})();
