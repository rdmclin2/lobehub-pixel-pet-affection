// VRM follow-up acceptance (PR #94 after 87ef23a): one imported .vrm is one look (no 衣柜), and the optional idle
// loop `vrm.idle` (.vrma) a folder import brings along. Real app under xvfb + SwiftShader, native file dialog
// answered by window.pet.debugNextOpen, fake lh. The models stay outside the repository (refused otherwise);
// the app copies them into the temp userData only.
// usage: xvfb-run -a -s '-screen 0 1280x800x24' node .agents/acceptance/scripts/vrm-wardrobe-idle-acceptance.js \
//          <repo> <out dir> <model.vrm> <folder with that model + a .vrma> [<second folder with a .vrm + .vrma>]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync, execFileSync } = require('node:child_process');

const [ROOT, OUT, MODEL, FOLDER, SECOND] = process.argv.slice(2, 7).map((p) => p && path.resolve(p));
for (const p of [MODEL, FOLDER, SECOND].filter(Boolean)) if (!path.relative(ROOT, p).startsWith('..')) throw new Error(`test assets must live outside the repository: ${p}`);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-followup-data-'));
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const chapters = [];
let T0 = null;
const t = () => (T0 == null ? 0 : (Date.now() - T0) / 1000);
const note = (s) => { const line = `[${t().toFixed(1)}s] ${s}`; log.push(line); console.log(line); };
const mark = (title) => { chapters.push({ t: Number(t().toFixed(1)), title }); note(`== ${title}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

(async () => {
  const fakeLh = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-followup-lh-'));
  fs.writeFileSync(path.join(fakeLh, 'loggedin'), '1');
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: false }));
  results.revision = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim();
  note(`revision ${results.revision} (worktree ${ROOT}); userData ${DATA}`);
  note(`model ${MODEL}; folder ${FOLDER} [${fs.readdirSync(FOLDER).join(', ')}]${SECOND ? `; second ${SECOND} [${fs.readdirSync(SECOND).join(', ')}]` : ''}`);
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    cwd: ROOT,
    env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: DATA, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fakeLh },
    recordVideo: { dir: path.join(OUT, 'video'), size: { width: 460, height: 540 } },
  });
  const pid = app.process().pid;
  const page = await app.firstWindow();
  T0 = Date.now();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || /\[vrm\]/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  let ok = true;
  const check = (cond, msg) => { note(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) ok = false; return cond; };
  const shot = async (n, opts = {}) => { await sleep(150); await page.screenshot({ path: path.join(OUT, n), ...opts }); note(`shot ${n}`); };
  const ds = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c ? { ...c.dataset } : null; });
  const fig = async () => { const d = await page.evaluate(() => window.petFx.vrm()); return d && d.figures[0]; };
  const hover = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
  const clickAct = async (act) => { await hover(); await page.click(`[data-act="${act}"]`); };
  const wardrobeHidden = () => page.evaluate(() => document.getElementById('btn-wardrobe').classList.contains('hidden'));
  const cursorBeside = async () => { // gaze follows the real screen cursor once the page pointer is stale
    try { const w = await page.evaluate(() => [window.screenX, window.screenY, window.innerWidth]); execFileSync('xdotool', ['mousemove', String(w[0] + w[2] + 120), String(w[1] + 140)]); } catch (e) { note(`xdotool: ${e.message}`); }
  };
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
  const importVrm = async (src, tag) => {
    await openCurrentPage();
    await page.locator('#vrm-import').scrollIntoViewIfNeeded();
    await page.evaluate((x) => window.pet.debugNextOpen(x), src);
    await page.click('#vrm-import');
    await page.waitForSelector('#vrm-confirm', { timeout: 90000 });
    await shot(`${tag}-confirm.png`);
    await page.click('#vrm-confirm [data-act="use"]');
    await page.waitForSelector('.pack-opt.on[data-pack^="vrm-"]', { timeout: 90000 });
    const id = await page.getAttribute('.pack-opt.on[data-pack^="vrm-"]', 'data-pack');
    const meta = (await page.textContent(`.pack-opt[data-pack="${id}"] .meta span`)).trim();
    const msg = (await page.textContent('#panel-msg')).trim();
    await page.locator(`.pack-opt[data-pack="${id}"]`).scrollIntoViewIfNeeded();
    await shot(`${tag}-card.png`);
    return { id, meta, msg };
  };
  const drawingKey = (id) => page.waitForFunction((x) => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > 5 && c.dataset.anim && document.getElementById('pet-look').dataset.key.startsWith(`${x}/`); }, id, { timeout: 120000 });
  const petBox = () => page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
  const rest = async () => { await page.waitForFunction(() => { const s = window.petFx.state(); return s && /^(idle|walk|sit|bored)$/.test(s.state); }, null, { timeout: 15000 }).catch(() => {}); await sleep(400); };
  const fmtMotion = (m) => Object.entries(m || {}).filter(([, v]) => Math.abs(v) > 0.05).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
  const peak = async (want, ms = 3000) => {
    const t0 = Date.now();
    let best = null;
    while (Date.now() - t0 < ms) {
      const d = await ds();
      const f = await fig();
      best = { state: d.state, expr: d.expr, mouth: d.mouth, motion: f.motion, anim: d.anim, frame: d.frame };
      if (want(best)) break;
      await sleep(60);
    }
    return best;
  };
  // her silhouette on the canvas (alpha > 0 on a 64×64 grid): centroid and how many cells differ from the first
  // sample — a number for "her body moves while she stands"; the frames go to <tag>-idle-NN.png
  const silhouette = () => page.evaluate(() => {
    const c = document.querySelector('#pet-look canvas.vrm');
    const g = c.getContext('webgl2') || c.getContext('webgl');
    const w = g.drawingBufferWidth; const h = g.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, buf);
    const N = 64; const cells = []; let sx = 0; let sy = 0; let n = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = Math.floor((i + 0.5) * w / N); const y = Math.floor((j + 0.5) * h / N);
      const on = buf[(y * w + x) * 4 + 3] > 0 ? 1 : 0;
      cells.push(on); if (on) { sx += i; sy += j; n++; }
    }
    return { cells: cells.join(''), cx: n ? sx / n : 0, cy: n ? sy / n : 0, n };
  });
  // only samples in the plain standing state count (a 'look' around or a leftover 'happy' moves her anyway)
  const idleSample = async (tag, frames = 32, gap = 160) => {
    await rest();
    await cursorBeside();
    await sleep(1200);
    const box = await page.locator('#pet-look canvas.vrm').boundingBox();
    const samples = [];
    let first = null;
    for (let i = 0; i < frames; i++) {
      const s = await silhouette();
      if (!first) first = s.cells;
      let diff = 0; for (let k = 0; k < s.cells.length; k++) if (s.cells[k] !== first[k]) diff++;
      const d = await ds();
      samples.push({ i, ms: Date.now() - T0, cx: +s.cx.toFixed(2), cy: +s.cy.toFixed(2), area: s.n, diffCells: diff, state: d.state, anim: d.anim, frame: Number(d.frame) });
      await page.screenshot({ path: path.join(OUT, `${tag}-idle-${String(i).padStart(2, '0')}.png`), clip: box });
      await sleep(gap);
    }
    const still = samples.filter((x) => x.state === 'idle');
    const use = still.length >= 8 ? still : samples;
    const range = (k) => { const v = use.map((x) => x[k]); return +(Math.max(...v) - Math.min(...v)).toFixed(2); };
    try { // a strip of every 4th frame and a GIF of the whole sequence, for the report
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(OUT, `${tag}-idle-%02d.png`), '-vf', "select='not(mod(n\\,4))',tile=8x1", '-frames:v', '1', path.join(OUT, `${tag}-strip.png`)]);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '5', '-i', path.join(OUT, `${tag}-idle-%02d.png`), '-vf', 'split[a][b];[a]palettegen[p];[b][p]paletteuse', '-loop', '0', path.join(OUT, `${tag}.gif`)]);
    } catch (e) { note(`ffmpeg: ${e.message}`); }
    return { samples, idleSamples: use.length, cxRange: range('cx'), cyRange: range('cy'), areaRange: range('area'), maxDiffCells: Math.max(...use.map((x) => x.diffCells)), frames: samples[samples.length - 1].frame - samples[0].frame };
  };
  const interactions = async (tag) => {
    const r = {};
    await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
    mark(`${tag}：摸摸（点击她）`);
    await rest();
    let s = null; const tried = [];
    for (let i = 0; i < 4 && !(s && s.state === 'pat' && /relaxed:/.test(s.expr)); i++) {
      if (i) await rest();
      const bx = await petBox();
      await page.mouse.click(bx.x + bx.width / 2, bx.y + bx.height * 0.45);
      s = await peak((x) => x.state === 'pat' && /relaxed:/.test(x.expr) && x.motion.nodDown > 3);
      tried.push(`${s.state}{${s.expr}}`);
    }
    await shot(`${tag}-pat.png`);
    r.pat = s;
    check(s.state === 'pat' && /relaxed:/.test(s.expr) && s.anim === 'vrma', `${tag} pat (clicks: ${tried.join(' → ')}): anim ${s.anim}, expr ${s.expr}, motion ${fmtMotion(s.motion)}`);

    mark(`${tag}：拖起（按住拖动）`);
    await rest();
    const bx = await petBox();
    const x0 = bx.x + bx.width / 2; const y0 = bx.y + bx.height * 0.45;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + i * 6, y0 - i * 3); await sleep(40); }
    // a model without a `surprised` expression (VRM 0.x presets) gets the `oh` mouth instead (src/core/vrm-motion.js)
    const hasSurprised = (await fig()).expressions.includes('surprised');
    const surprisedRe = hasSurprised ? /surprised:/ : /oh:/;
    s = await peak((x) => x.state === 'lifted' && surprisedRe.test(x.expr) && x.motion.dangle > 0.5);
    await shot(`${tag}-lifted.png`);
    await page.mouse.up();
    r.lifted = { ...s, hasSurprised };
    check(s.state === 'lifted' && surprisedRe.test(s.expr) && s.motion.dangle > 0.5, `${tag} lifted: anim ${s.anim}, expr ${s.expr} (model has surprised: ${hasSurprised}), motion ${fmtMotion(s.motion)}`);

    mark(`${tag}：玩耍（petFx.cue('play')）`);
    await rest();
    await page.evaluate(() => window.petFx.cue('play'));
    s = await peak((x) => x.state === 'play' && x.motion.spin > 0.3);
    await shot(`${tag}-play.png`);
    r.play = s;
    check(s.state === 'play' && s.motion.spin > 0.3, `${tag} play: anim ${s.anim}, expr ${s.expr}, motion ${fmtMotion(s.motion)}`);
    await page.waitForFunction(() => window.petFx.state().state !== 'play', null, { timeout: 10000 }).catch(() => {});
    return r;
  };
  try {
    mark('孵化大肥鱼（默认像素外观）');
    await page.waitForSelector('.char-card', { timeout: 20000 });
    await page.click('.char-card[data-species="dafeiyu"]');
    await page.fill('#pet-name', '小肥鱼');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
    await page.evaluate(() => { window.__sameRendererMarker = 'kept'; });

    mark('导入单个 .vrm（木子惡魔的鲸鱼模型，不带待机动画）');
    const A = await importVrm(MODEL, '01-whale-single');
    results.single = A;
    check(/^VRM · 1 套服饰 · 木子恶魔 · 本地导入$/.test(A.meta), `card meta 「${A.meta}」 (${A.id}); msg 「${A.msg}」`);
    const manifest0 = JSON.parse(fs.readFileSync(path.join(DATA, 'packs', A.id, 'pack.json'), 'utf8'));
    results.single.manifestVrm = manifest0.vrm;
    check(JSON.stringify(Object.keys(manifest0.vrm.outfits)) === '["daily"]' && !manifest0.vrm.idle, `pack.json vrm: ${JSON.stringify(manifest0.vrm)}`);
    await page.click('#panel-close');
    await drawingKey(A.id);
    const d0 = await ds();
    results.single.anim = d0.anim;
    check(d0.anim === 'none', `single .vrm: canvas data-anim=${d0.anim}, data-vrm=${d0.vrm}, springs ${d0.springs}`);
    await hover();
    const hiddenA = await wardrobeHidden();
    const bar = await page.$$eval('#pet-screen [data-act]', (bs) => bs.filter((b) => b.offsetParent && !b.classList.contains('hidden')).map((b) => b.dataset.act));
    results.single.wardrobeHidden = hiddenA; results.single.visibleActs = bar;
    check(hiddenA && !bar.includes('wardrobe'), `衣柜 hidden=${hiddenA}; visible action buttons: ${bar.join(',')}`);
    await shot('02-whale-single-actionbar-no-wardrobe.png');

    mark('一键解锁 → 关系升级提示不引向衣柜；换装被拒');
    await page.mouse.move(600, 600);
    await page.evaluate(() => window.pet.unlockAll('dafeiyu'));
    await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 8000 });
    const toast = await page.evaluate(() => ({ title: document.getElementById('toast-title').textContent.trim(), body: document.getElementById('toast-body').textContent.trim(), button: document.getElementById('toast-open').textContent.trim(), panel: document.getElementById('toast-open').dataset.panel }));
    results.toast = toast;
    await shot('03-unlock-toast.png');
    check(toast.panel !== 'wardrobe' && !/衣柜/.test(toast.button) && !/解锁服饰/.test(toast.body), `toast 「${toast.title}」 body 「${toast.body.slice(0, 200)}」 button 「${toast.button}」 → panel ${toast.panel}`);
    await page.click('#toast-open');
    await sleep(800);
    const opened = await page.evaluate(() => ({ wardrobeCards: document.querySelectorAll('#panel:not(.hidden) .card').length, panelTitle: (document.querySelector('#panel:not(.hidden) h2, #panel:not(.hidden) .panel-title') || {}).textContent || '' }));
    results.toastOpened = opened;
    check(opened.wardrobeCards === 0, `toast button opened panel 「${opened.panelTitle.trim()}」 with ${opened.wardrobeCards} wardrobe cards`);
    await shot('04-toast-opens-topics.png');
    if (await page.locator('#panel-close:visible').count()) await page.click('#panel-close');
    const eqP = await page.evaluate(() => window.pet.equipOutfit('pajamas'));
    const eqM = await page.evaluate(() => window.pet.equipOutfit('maid'));
    const look = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
    results.equip = { pajamas: eqP, maid: eqM, lookAfter: look };
    check(eqP.ok === false && eqM.ok === false && look.startsWith(`${A.id}/daily`), `equipOutfit(pajamas) → ok=${eqP.ok} ${eqP.reason || ''}; equipOutfit(maid) → ok=${eqM.ok} ${eqM.reason || ''}; look still ${look}`);
    await hover();
    check(await wardrobeHidden(), '衣柜 still hidden after unlock-all');
    await shot('05-whale-after-unlock-still-no-wardrobe.png');

    mark('切回 2D 包 dafeiyu-pixel：衣柜回来，无成人服饰');
    await pickPack('dafeiyu-pixel');
    await sleep(600);
    await hover();
    const hiddenPix = await wardrobeHidden();
    await shot('06-pixel-actionbar-wardrobe.png');
    await clickAct('wardrobe');
    await page.waitForSelector('#panel:not(.hidden) .card');
    const cards = await page.$$eval('.card', (cs) => cs.map((c) => ({ id: c.dataset.outfit, label: (c.querySelector('.nm') || c).textContent.trim(), locked: c.classList.contains('locked'), adultTag: !!c.querySelector('.tag.adult') })));
    const st = await page.evaluate(() => window.pet.getSettings());
    results.pixelWardrobe = { hidden: hiddenPix, cards, adultContent: st.adultContent };
    const ADULT = require(path.join(ROOT, 'src/core/outfits')).OUTFITS.filter((o) => o.rating === 'adult').map((o) => o.id);
    check(!hiddenPix && cards.length > 1 && !cards.some((c) => ADULT.includes(c.id) || c.adultTag), `dafeiyu-pixel: 衣柜 hidden=${hiddenPix}; adultContent=${st.adultContent}; cards ${cards.map((c) => `${c.id}=${c.label}${c.locked ? '🔒' : ''}`).join('、')}; adult ids ${ADULT.join(',')} absent`);
    await shot('07-pixel-wardrobe.png');
    await page.locator('.card').last().scrollIntoViewIfNeeded();
    await shot('07b-pixel-wardrobe-end.png');
    await page.click('#panel-close');

    mark('回到鲸鱼（无 .vrma）：待机帧序列');
    await pickPack(A.id);
    await drawingKey(A.id);
    const plain = await idleSample('08-whale-plain');
    results.idlePlain = plain;
    note(`plain idle: anim ${plain.samples[0].anim}; centroid range x ${plain.cxRange} y ${plain.cyRange} cells, area range ${plain.areaRange}, max diff ${plain.maxDiffCells} cells, ${plain.frames} frames drawn`);

    mark('重新导入同一模型的文件夹（带 idle_loop.vrma）：不重启，data-anim none → vrma');
    const keyBefore = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
    const animBefore = (await ds()).anim;
    const B = await importVrm(FOLDER, '09-whale-folder');
    results.folder = B;
    const manifest1 = JSON.parse(fs.readFileSync(path.join(DATA, 'packs', B.id, 'pack.json'), 'utf8'));
    const vrmaInData = path.join(DATA, 'packs', B.id, manifest1.vrm.idle || 'x');
    results.folder.manifestVrm = manifest1.vrm;
    results.folder.vrmaFile = fs.existsSync(vrmaInData) ? { path: vrmaInData, bytes: fs.statSync(vrmaInData).size } : null;
    check(B.id === A.id && /^VRM · 1 套服饰 · 木子恶魔 · 本地导入$/.test(B.meta), `same pack ${B.id} replaced; meta 「${B.meta}」; msg 「${B.msg}」`);
    check(/^animations\/[\w.-]+\.vrma$/.test(manifest1.vrm.idle || '') && !!results.folder.vrmaFile, `pack.json vrm.idle = ${JSON.stringify(manifest1.vrm.idle)}; file in temp userData: ${JSON.stringify(results.folder.vrmaFile)}`);
    await page.click('#panel-close');
    await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.anim === 'vrma' && Number(c.dataset.frame) > 5; }, null, { timeout: 120000 });
    const keyAfter = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
    const marker = await page.evaluate(() => window.__sameRendererMarker);
    results.rebuild = { keyBefore, animBefore, keyAfter, animAfter: (await ds()).anim, sameRenderer: marker === 'kept', pidBefore: pid, pidAfter: app.process().pid };
    check(animBefore === 'none' && results.rebuild.animAfter === 'vrma' && marker === 'kept' && app.process().pid === pid && keyBefore !== keyAfter, `rebuild without restart: ${JSON.stringify(results.rebuild)}`);

    mark('鲸鱼 + 待机动画：待机帧序列');
    const loop = await idleSample('10-whale-vrma');
    results.idleVrma = loop;
    note(`vrma idle: anim ${loop.samples[0].anim}; centroid range x ${loop.cxRange} y ${loop.cyRange} cells, area range ${loop.areaRange}, max diff ${loop.maxDiffCells} cells, ${loop.frames} frames drawn`);
    check(loop.samples.every((s) => s.anim === 'vrma') && loop.cxRange > 2 * plain.cxRange, `standing still (state idle; ${loop.idleSamples} vs ${plain.idleSamples} samples): with .vrma her silhouette centroid sways x ${loop.cxRange} / y ${loop.cyRange} cells of 64, max ${loop.maxDiffCells} cells changed; without: x ${plain.cxRange} / y ${plain.cyRange}, max ${plain.maxDiffCells}`);

    results.whaleInteractions = await interactions('11-whale-vrma');

    mark('鲸鱼 + 待机动画：语音台词口型');
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
      const stt = await page.evaluate(() => window.petFx.lastSpeech().status);
      mouths.push({ ms: Date.now() - T0, lip: d.lip, mouth: d.mouth, anim: d.anim, status: stt });
      await page.screenshot({ path: path.join(lipDir, `f${String(i).padStart(3, '0')}.png`), clip });
      if (stt !== 'playing') break;
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
    check(playing.some((m) => m.lip === 'audio') && maxOpen > 0.2 && playing.every((m) => m.anim === 'vrma'), `speech 「${sp.text}」 (provider ${sp.provider}): ${playing.length} frames while playing, shapes ${[...shapes].join(',')}, max open ${maxOpen.toFixed(2)}, anim vrma throughout`);
    check(after.every((x) => /aa:0\.00,ih:0\.00,ou:0\.00,ee:0\.00,oh:0\.00/.test(x)), `after speech: ${after.join(' | ')}`);
    await page.evaluate(() => window.pet.setPrefs({ voice: false }));
    await sleep(800);

    if (SECOND) {
      mark('第二个主体：VRoid AvatarSample（文件夹带 .vrma）');
      const C = await importVrm(SECOND, '12-second-folder');
      results.second = C;
      const manifest2 = JSON.parse(fs.readFileSync(path.join(DATA, 'packs', C.id, 'pack.json'), 'utf8'));
      results.second.manifestVrm = manifest2.vrm;
      check(/^VRM · 1 套服饰 · .+ · 本地导入$/.test(C.meta) && /\.vrma$/.test(manifest2.vrm.idle || ''), `second pack ${C.id}: meta 「${C.meta}」; vrm.idle ${manifest2.vrm.idle}`);
      await page.click('#panel-close');
      await drawingKey(C.id);
      await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.anim === 'vrma', null, { timeout: 60000 }).catch(() => {});
      const dC = await ds();
      await hover();
      const hiddenC = await wardrobeHidden();
      check(dC.anim === 'vrma' && hiddenC, `second: data-anim=${dC.anim}, data-vrm=${dC.vrm}; 衣柜 hidden=${hiddenC}`);
      await shot('12-second-actionbar.png');
      results.idleSecond = await idleSample('13-second-vrma');
      note(`second idle: max diff ${results.idleSecond.maxDiffCells} cells, centroid x±${results.idleSecond.cxRange} y±${results.idleSecond.cyRange}`);
      results.secondInteractions = await interactions('14-second-vrma');
    }

    const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--', '*.vrm', '*.VRM', '*.vrma', '*.VRMA'], { cwd: ROOT, encoding: 'utf8' }).trim();
    results.repoClean = tracked;
    check(tracked === '', `worktree has no .vrm/.vrma (tracked or untracked): 「${tracked}」`);
    const realErr = errors.filter((e) => !/Autofill|Electron Security Warning|DevTools|net::ERR_FILE_NOT_FOUND/.test(e));
    results.errors = realErr;
    results.allConsole = errors;
    check(realErr.length === 0, `console errors / [vrm] warnings: ${JSON.stringify(realErr).slice(0, 400)}`);
  } catch (e) {
    ok = false;
    note(`ERROR ${e.stack}`);
    await shot('error.png').catch(() => {});
  } finally {
    results.chapters = chapters;
    results.userData = DATA;
    fs.writeFileSync(path.join(OUT, 'log.txt'), `${log.join('\n')}\n`);
    fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    await app.close().catch(() => {});
    note(ok ? 'ALL PASS' : 'SOME FAILED');
    fs.writeFileSync(path.join(OUT, 'log.txt'), `${log.join('\n')}\n`);
    process.exit(ok ? 0 : 1);
  }
})();
