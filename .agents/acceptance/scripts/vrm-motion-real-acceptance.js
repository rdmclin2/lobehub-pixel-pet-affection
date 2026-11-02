// Real-asset VRM motion acceptance (T-2678, docs/vrm-motion-system.md §8.3): the motion library baked from
// ~/vrm-assets (scripts/vrm-bake.js) and real models — 莉莉雅 liliya.vrm (female, guessed from the model) and a
// male VRoid model — imported through the real app, then every posture (picked in 外观 → the VRM card's
// 姿势 menu, persisted in settings) and the idle schedule (auto posture, the director's clock sped up) are
// captured, plus the decoupling checks (no CSS animation / transform / mirror on the VRM canvas).
// Nothing is copied into the repository: models, assets and the baked motions must all be outside ROOT.
//
// usage: xvfb-run -a -s '-screen 0 1280x800x24' node .agents/acceptance/scripts/vrm-motion-real-acceptance.js \
//          <repo> <out dir> --motions ~/vrm-assets/baked --model <female.vrm> [--male <male.vrm>] [--seconds 40]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync, execFileSync } = require('node:child_process');

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const ROOT = path.resolve(argv[0]);
const OUT = path.resolve(argv[1]);
const MOTIONS = path.resolve(home(opt('motions', '~/vrm-assets/baked')));
const FEMALE = path.resolve(home(opt('model')));
const MALE = opt('male') ? path.resolve(home(opt('male'))) : null;
const IDLE_SECONDS = Number(opt('seconds', 40));
// default output: ~/vrm-motion-evidence
for (const p of [MOTIONS, FEMALE, MALE].filter(Boolean)) if (!path.relative(ROOT, p).startsWith('..')) throw new Error(`must live outside the repository: ${p}`);
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
// Electron must start as the app, not as Node (a shell may export ELECTRON_RUN_AS_NODE)
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
const log = [];
const chapters = [];
let T0 = null;
const t = () => (T0 == null ? 0 : (Date.now() - T0) / 1000);
const note = (s) => { const line = `[${t().toFixed(1)}s] ${s}`; log.push(line); console.log(line); };
const mark = (title) => { chapters.push({ t: Number(t().toFixed(1)), title }); note(`== ${title}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POSTURES = ['stand.relaxed', 'stand.confident', 'stand.shy', 'stand.playful', 'sit.rest', 'sit.doze'];
const results = { models: {} };
let ok = true;
const check = (cond, msg) => { note(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) ok = false; return cond; };

async function runModel(tag, MODEL, { full }) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `pp-vrm-motion-${tag}-`));
  const fakeLh = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-motion-lh-'));
  fs.writeFileSync(path.join(fakeLh, 'loggedin'), '1');
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: false, petScale: 1.6, petScaleSet: true }));
  const dir = path.join(OUT, tag);
  fs.mkdirSync(dir, { recursive: true });
  note(`[${tag}] model ${MODEL} (${fs.statSync(MODEL).size} B), motions ${MOTIONS}, userData ${DATA}`);
  const launch = () => _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    cwd: ROOT,
    env: { ...cleanEnv, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: DATA, PIXELPET_VRM_MOTIONS_DIR: MOTIONS, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fakeLh },
    recordVideo: { dir: path.join(dir, 'video'), size: { width: 460, height: 640 } },
  });
  let app = await launch();
  let page = await app.firstWindow();
  if (T0 == null) T0 = Date.now();
  const errors = [];
  const watch = (p) => { p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`)); p.on('dialog', (d) => d.accept()); };
  watch(page);
  const R = (results.models[tag] = { model: MODEL, postures: {}, idle: [] });
  const ds = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c ? { ...c.dataset } : null; });
  const fig = async () => { const d = await page.evaluate(() => window.petFx.vrm()); return d && d.figures[0]; };
  // the canvas at its own resolution (preserveDrawingBuffer) on a light backdrop, and the window
  const canvasShot = async (name) => {
    const url = await page.evaluate(() => document.querySelector('#pet-look canvas.vrm').toDataURL('image/png'));
    fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
    await page.screenshot({ path: path.join(dir, `${name}-window.png`) });
    return path.join(tag, `${name}.png`);
  };
  // a sequence of canvas frames → a GIF on a plain backdrop (ffmpeg); returns the GIF's path relative to OUT
  const frames = async (name, ms, every, during = null) => {
    const fdir = path.join(dir, `${name}-frames`);
    fs.rmSync(fdir, { recursive: true, force: true }); // frames of an earlier run must not end up in this GIF
    fs.mkdirSync(fdir, { recursive: true });
    const t1 = Date.now();
    let i = 0;
    const log = [];
    while (Date.now() - t1 < ms) {
      const at = Date.now();
      if (during) await during((at - t1) / 1000);
      const r = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); const f = window.petFx.vrm().figures[0]; return { url: c.toDataURL('image/png'), d: { ...c.dataset }, w: f.weightSum, root: f.root, bones: f.bones, ground: f.ground, pose: f.pose }; });
      fs.writeFileSync(path.join(fdir, `${String(i++).padStart(4, '0')}.png`), Buffer.from(r.url.split(',')[1], 'base64'));
      log.push({ t: +((at - t1) / 1000).toFixed(2), posture: r.d.posture, idle: r.d.idle, layers: r.d.layers, weightSum: +r.w.toFixed(4), mode: r.d.mode, expr: r.d.expr, gaze: r.d.gaze, root: r.root, hips: r.bones.hips, head: r.bones.head, ground: +r.ground.toFixed(4), headYaw: r.pose ? r.pose.headYaw : null, q: r.pose ? r.pose.q : null });
      const wait = every - (Date.now() - at);
      if (wait > 0) await sleep(wait);
    }
    const fps = Math.max(1, Math.round(1000 / every));
    const gif = path.join(dir, `${name}.gif`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(fdir, '%04d.png'), '-f', 'lavfi', '-i', `color=c=0xd8dcef:s=64x64:r=${fps}:d=${(i / fps + 1).toFixed(2)}`,
      // the backdrop is bounded (d=) AND the overlay ends with the frames (shortest=1): an endless lavfi source
      // feeding palettegen buffers frames forever (it once grew to 60 GB)
      '-filter_complex', '[1][0]scale2ref[bg][fg];[bg][fg]overlay=shortest=1:format=auto,scale=-2:420,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer', gif]);
    fs.writeFileSync(path.join(dir, `${name}-frames.json`), `${JSON.stringify(log, null, 1)}\n`);
    note(`[${tag}] gif ${path.relative(OUT, gif)} (${i} frames, ${(fs.statSync(gif).size / 1024).toFixed(0)} KB)`);
    return { gif: path.relative(OUT, gif), log, n: i };
  };
  const hover = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
  const openCurrentPage = async () => {
    await hover();
    await page.click('[data-act="menu"]');
    await page.click('[data-menu="characters"]');
    await page.waitForSelector('.char-list .char-opt');
    await page.waitForFunction(() => window.innerWidth >= 400, null, { timeout: 5000 });
    const id = await page.getAttribute('.char-list .char-opt.on', 'data-species');
    await page.click(`.char-list .char-opt[data-species="${id}"] .char-open`);
    await page.waitForSelector(`#char-head .char-opt[data-species="${id}"]`);
  };
  const drawing = () => page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > 3 && c.dataset.posture !== undefined; }, null, { timeout: 120000 });
  // wait until the cross-fade into `posture` is over (one clip at full weight)
  const settled = (posture) => page.waitForFunction((p) => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.posture === p && /^[^,]+:1\.00$/.test(c.dataset.layers || ''); }, posture, { timeout: 20000 });
  let ID = null;
  try {
    mark(`[${tag}] 孵化 → 外观 → 导入 VRM 模型…`);
    await page.waitForSelector('.char-card', { timeout: 30000 });
    await page.click('.char-card[data-species="dafeiyu"]');
    await page.fill('#pet-name', tag === 'female' ? '莉莉雅' : '男孩');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
    await openCurrentPage();
    await page.locator('#vrm-import').scrollIntoViewIfNeeded();
    // the import flow, step by step: the button on the character page, the confirmation card (name, author,
    // licence of the picked file), the new look selected
    await page.screenshot({ path: path.join(dir, 'import-1-button.png') });
    await page.evaluate((x) => window.pet.debugNextOpen(x), MODEL); // answers the native file dialog with this path
    await page.click('#vrm-import');
    await page.waitForSelector('#vrm-confirm', { timeout: 90000 });
    await sleep(800);
    await page.screenshot({ path: path.join(dir, 'import-2-confirm.png') });
    R.importConfirm = await page.evaluate(() => document.getElementById('vrm-confirm').innerText);
    await page.click('#vrm-confirm [data-act="use"]');
    await page.waitForSelector('.pack-opt.on[data-pack^="vrm-"]', { timeout: 90000 });
    await sleep(500);
    await page.screenshot({ path: path.join(dir, 'import-3-done.png') });
    R.importMsg = await page.evaluate(() => document.getElementById('panel-msg').textContent);
    note(`[${tag}] 导入确认卡: ${JSON.stringify(R.importConfirm).slice(0, 300)}; 提示: ${R.importMsg}`);
    ID = await page.getAttribute('.pack-opt.on[data-pack^="vrm-"]', 'data-pack');
    await page.click('#panel-close');
    await drawing();
    await sleep(1500);
    const d0 = await ds();
    const f0 = await fig();
    const info = await page.evaluate(() => window.pet.vrmLibraryInfo());
    R.pack = ID;
    R.style = d0.style;
    R.library = { state: d0.library, clips: f0.clips, served: info };
    check(d0.library === 'loaded', `[${tag}] motion library loaded over vrmlib:// (${info && info.source} ${info && info.dir}): data-library=${d0.library}, ${f0.clips.length} clips: ${f0.clips.join(', ')}`);
    check(d0.style.startsWith(tag === 'female' ? 'female' : 'male'), `[${tag}] style guessed from the model: data-style=${d0.style}`);
    check(d0.anim === 'vrma', `[${tag}] data-anim=${d0.anim}`);

    mark(`[${tag}] 解耦：VRM 画布没有像素式 CSS 动画/变换/镜像`);
    await page.evaluate(() => window.petFx.cue('happy'));
    await sleep(300);
    await page.evaluate(() => window.petFx.face('left'));
    await sleep(500);
    const css = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); const cs = getComputedStyle(c); const b = document.getElementById('pet-body'); return { status: document.getElementById('char-wrap').dataset.status, kind: b.dataset.kind, facing: b.dataset.facing, animationName: cs.animationName, transform: cs.transform, scale: cs.scale, bodyAnimation: getComputedStyle(b).animationName }; });
    const figL = await fig();
    R.decoupling = { css, motion: figL.motion, yaw: figL.root.yaw, plan: figL.plan };
    check(css.kind === 'vrm' && css.animationName === 'none' && css.transform === 'none' && (css.scale === 'none' || css.scale === '1'), `[${tag}] status ${css.status}, facing ${css.facing}: canvas animation ${css.animationName}, transform ${css.transform}, scale ${css.scale}`);
    check(Object.keys(figL.motion).length === 0 && Math.abs(figL.plan.facingYaw) === 18, `[${tag}] no procedural hop/spin/dangle (motion ${JSON.stringify(figL.motion)}); facing left → body yaw target ${figL.plan.facingYaw}° (not mirrored)`);
    await canvasShot('00-facing-left');
    await page.evaluate(() => window.petFx.face('right'));

    mark(`[${tag}] 姿势系统：外观 → 姿势 菜单逐个切换（持久化）`);
    for (const p of full ? POSTURES : POSTURES) {
      await openCurrentPage();
      const sel = page.locator(`select.vrm-posture[data-pack="${ID}"]`);
      await sel.scrollIntoViewIfNeeded();
      await sel.selectOption(p);
      await page.waitForFunction((x) => /姿势已设为/.test(document.getElementById('panel-msg').textContent), p, { timeout: 5000 });
      if (p === 'stand.confident') await page.screenshot({ path: path.join(dir, 'posture-menu.png') });
      await page.click('#panel-close');
      // the cross-fade: weights add up to 1 the whole way (no T-pose leaking in)
      const sums = [];
      for (let i = 0; i < 14; i++) { const f = await fig(); sums.push(+f.weightSum.toFixed(3)); if (i === 4) R.postures[`${p}:mid`] = f.layers; await sleep(70); }
      await settled(p);
      await sleep(1200);
      const d = await ds();
      const f = await fig();
      const shot = await canvasShot(`posture-${p}`);
      const saved = await page.evaluate(async (id) => (await window.pet.getSettings()).vrmPostures[id], ID);
      R.postures[p] = { shot, layers: d.layers, posture: d.posture, source: f.plan.postureSource, saved, weightSums: sums, bones: f.bones, ground: f.ground, seatLift: f.seatLift };
      // the whole figure inside the canvas: the bottom pixel row must stay empty (a seated pose once hung out of it)
      const edge = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); const g = document.createElement('canvas'); g.width = c.width; g.height = c.height; const x = g.getContext('2d'); x.drawImage(c, 0, 0); const row = x.getImageData(0, c.height - 2, c.width, 2).data; let n = 0; for (let i = 3; i < row.length; i += 4) if (row[i] > 8) n++; return n; });
      R.postures[p].bottomRowPixels = edge;
      // T-2691: a seated pose sits on something (the renderer's pouf / cushion), not on thin air
      if (p.startsWith('sit.')) { const st = f.props && f.props.seat; R.postures[p].seat = st; check(!!(st && st.visible && st.k > 0.9 && st.height >= 0.03 && st.top < st.hipsY && st.hipsY - st.top < 0.15 && st.top > st.floor), `[${tag}] 姿势 ${p}: 坐具 ${st ? `可见 (k=${st.k})，从地面 y=${st.floor} 到臀下 y=${st.top}（臀部骨骼 y=${st.hipsY}），高 ${st.height} m` : '无'} → 不悬空`); }
      if (p.startsWith("sit.")) check(f.seatLift > 0, `[${tag}] 姿势 ${p}: 坐姿整体上抬 seatLift=${f.seatLift} m 以免臀/腿/脚落出画布底边；画布最底 2 行剩余 ${edge} 个不透明像素（拖地长发落在地面线上属正常，见截图）`);
      else note(`[${tag}] 姿势 ${p}: 画布最底 2 行 ${edge} 个不透明像素（脚底贴地面线）`);
      check(d.posture === p && saved === p && sums.every((s) => Math.abs(s - 1) < 0.01), `[${tag}] 姿势 ${p}: data-posture=${d.posture}, layers ${d.layers}, settings.vrmPostures=${saved}, weight sums during fade ${[...new Set(sums)].join('/')}`);
    }

    mark(`[${tag}] 姿势切换过程 GIF（交叉淡化，权重和恒为 1）`);
    await page.evaluate((id) => window.pet.setVrmPosture(id, 'stand.relaxed'), ID);
    await settled('stand.relaxed');
    await sleep(800);
    const seq = ['stand.confident', 'stand.playful', 'sit.rest', 'stand.shy', 'stand.relaxed'];
    const sw0 = new Set();
    const sw = await frames('posture-switch', seq.length * 2600, 80, async (sec) => {
      const k = Math.floor(sec / 2.6);
      if (seq[k] && !sw0.has(k)) { sw0.add(k); await page.evaluate(([id, p]) => window.pet.setVrmPosture(id, p), [ID, seq[k]]); }
    });
    const sums = sw.log.map((x) => x.weightSum);
    const mids = sw.log.filter((x) => /,/.test(x.layers || ''));
    R.postureSwitch = { gif: sw.gif, frames: sw.n, minWeightSum: Math.min(...sums), maxWeightSum: Math.max(...sums), framesMidFade: mids.length, sampleMidFade: mids.slice(0, 6).map((x) => `${x.t}s ${x.layers}`) };
    check(Math.min(...sums) > 0.99 && Math.max(...sums) < 1.01 && mids.length >= 5, `[${tag}] 切换 GIF ${sw.gif}: ${sw.n} 帧，其中 ${mids.length} 帧处于两段姿势交叉淡化中（如 ${mids.slice(0, 2).map((x) => x.layers).join(' | ')}），权重和 ${Math.min(...sums).toFixed(3)}–${Math.max(...sums).toFixed(3)}`);

    mark(`[${tag}] 持久化：重启应用后仍是上次的姿势`);
    await page.evaluate((id) => window.pet.setVrmPosture(id, 'sit.doze'), ID);
    await settled('sit.doze');
    const last = POSTURES[POSTURES.length - 1];
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    watch(page);
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 60000 });
    await drawing();
    await settled(last);
    const dr = await ds();
    const settingsFile = JSON.parse(fs.readFileSync(path.join(DATA, 'settings.json'), 'utf8'));
    R.persisted = { posture: dr.posture, layers: dr.layers, settingsJson: { vrmPostures: settingsFile.vrmPostures } };
    check(dr.posture === last && settingsFile.vrmPostures[ID] === last, `[${tag}] 重启后 data-posture=${dr.posture} (${dr.layers}); settings.json vrmPostures=${JSON.stringify(settingsFile.vrmPostures)}`);
    await canvasShot('posture-after-restart');

    mark(`[${tag}] idle 实时 GIF（45 s，光标缓慢移动：呼吸、眨眼、视线跟随、换重心、微动）`);
    await page.evaluate((id) => window.pet.setVrmPosture(id, 'auto'), ID);
    await page.evaluate(() => { window.PetVRM.director.seed(3); window.PetVRM.director.speed(1); });
    await sleep(1500);
    const box = await page.locator('#pet-look canvas.vrm').boundingBox();
    const live = await frames('idle-realtime', 45000, 250, async (sec) => {
      // the cursor sweeps left → right → left over her face, then leaves the window (she looks back ahead)
      if (sec < 30) { const k = (Math.sin(sec / 30 * Math.PI * 2 - Math.PI / 2) + 1) / 2; await page.mouse.move(box.x + box.width * (0.05 + 0.9 * k), box.y + box.height * (0.15 + 0.1 * Math.sin(sec))); }
    });
    const xs = live.log.map((x) => Number(x.gaze.split(',')[0]));
    const blinks = live.log.filter((x) => /(^|,)blink:/.test(x.expr || '')).length;
    const rootX = live.log.map((x) => x.root.x);
    const rootY = live.log.map((x) => x.root.y);
    const heads = live.log.map((x) => x.head);
    const spread = (a) => Math.max(...a) - Math.min(...a);
    R.idleRealtime = { gif: live.gif, frames: live.n, gazeX: [Math.min(...xs), Math.max(...xs)], blinkFrames: blinks, idles: [...new Set(live.log.map((x) => x.idle))], postures: [...new Set(live.log.map((x) => x.posture))], modes: [...new Set(live.log.map((x) => x.mode))], rootXSpread: spread(rootX), rootYSpread: spread(rootY), headPitchSpread: spread(heads.map((h) => h[0])), headRollSpread: spread(heads.map((h) => h[2])) };
    // T-2691: liliya's idle must not sweep her head about (every head turn within ±12° of where her body
    // faces); the male idle must not stand like a post (≥ 2 clear but small changes in 35 s: a main bone
    // turning > 12° within 2 s, counted at most once per 3 s)
    const yaws = live.log.map((x) => x.headYaw).filter((v) => v !== null);
    const qang = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180) / Math.PI;
    const MAINB = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
    const in35 = live.log.filter((x) => x.t <= 35 && x.q);
    const moves = [];
    for (const x of in35) { const ref = in35.find((y) => y.t >= x.t - 2); const d = Math.max(...MAINB.filter((b) => x.q[b] && ref.q[b]).map((b) => qang(x.q[b], ref.q[b]))); if (d > 12 && (!moves.length || x.t - moves[moves.length - 1].t > 3)) moves.push({ t: x.t, deg: +d.toFixed(1), idle: x.idle, posture: x.posture }); }
    R.idleRealtime.headYaw = [Math.min(...yaws), Math.max(...yaws)];
    R.idleRealtime.changes35s = moves;
    if (tag === 'female') check(yaws.length > 100 && yaws.every((v) => Math.abs(v) <= 12), `[${tag}] idle 转头幅度：${yaws.length} 帧头部相对身体朝向 ${Math.min(...yaws).toFixed(1)}…${Math.max(...yaws).toFixed(1)}°（要求每帧 ≤ ±12°）`);
    else note(`[${tag}] idle 转头幅度：头部相对身体朝向 ${Math.min(...yaws).toFixed(1)}…${Math.max(...yaws).toFixed(1)}°`);
    if (tag === 'male') check(moves.length >= 2, `[${tag}] idle 前 35 s 有 ${moves.length} 次明显变化（2 s 内主要骨骼转动 > 12°）：${moves.map((m) => `${m.t}s ${m.deg}° ${m.idle}${m.posture ? `/${m.posture}` : ''}`).join('；')}`);
    else note(`[${tag}] idle 前 35 s 明显变化 ${moves.length} 次：${moves.map((m) => `${m.t}s ${m.deg}°`).join('；')}`);
    check(spread(xs) > 1 && blinks >= 3, `[${tag}] 实时 idle GIF ${live.gif}: ${live.n} 帧/45 s；视线 x ${Math.min(...xs).toFixed(2)}…${Math.max(...xs).toFixed(2)} 跟随光标；${blinks} 帧在眨眼；头部俯仰变化范围 ${spread(heads.map((h) => h[0])).toFixed(2)}°（含 idle 片段自身动作）；变体 ${R.idleRealtime.idles.join(', ')}`);

    mark(`[${tag}] idle 待机：自动姿势，导演时钟 ×8，≥3 段变体随机调度`);
    await page.evaluate(() => { window.PetVRM.director.seed(7); window.PetVRM.director.speed(8); });
    await page.mouse.move(400, 600);
    const seen = [];
    const t1 = Date.now();
    let shots = 0;
    const drift = [];
    while (Date.now() - t1 < IDLE_SECONDS * 1000) {
      const d = await ds();
      const f = await fig();
      const key = `${d.idle}|${d.posture}`;
      if (!seen.length || seen[seen.length - 1].key !== key) {
        seen.push({ key, idle: d.idle, posture: d.posture, at: +((Date.now() - t1) / 1000).toFixed(1), layers: d.layers, mode: d.mode });
        note(`[${tag}] idle → ${d.idle} (posture ${d.posture || '-'}; ${d.layers}; mode ${d.mode})`);
        // a picture of each new idle once it has settled in
        setTimeout(() => {}, 0);
        if (shots < 12) { await sleep(1300); await canvasShot(`idle-${String(++shots).padStart(2, '0')}-${d.idle}${d.posture ? `-${d.posture}` : ''}`); }
      }
      drift.push(f.bones);
      await sleep(250);
    }
    const hist = await page.evaluate(() => window.PetVRM.director.history());
    const variants = [...new Set(hist)];
    let repeats = 0;
    for (let i = 1; i < hist.length; i++) if (hist[i] === hist[i - 1]) repeats++;
    R.idle = { seen, history: hist, variants, repeats };
    check(variants.length >= 3 && repeats === 0, `[${tag}] idle history ${hist.join(' → ')}: ${variants.length} variants, ${repeats} back-to-back repeats`);
    await page.evaluate(() => { window.PetVRM.director.seed(21); window.PetVRM.director.speed(6); });
    const fast = await frames('idle-schedule-x6', 30000, 200);
    R.idleScheduleGif = { gif: fast.gif, frames: fast.n, idles: [...new Set(fast.log.map((x) => x.idle))] };
    note(`[${tag}] 调度 GIF ${fast.gif}: 变体 ${R.idleScheduleGif.idles.join(' / ')}`);
    await page.evaluate(() => window.PetVRM.director.speed(1));

    mark(`[${tag}] 长时间运行：降帧到 idle 12fps，无漂移`);
    await page.evaluate((id) => window.pet.setVrmPosture(id, 'stand.relaxed'), ID);
    await settled('stand.relaxed');
    await sleep(3000); // the feet-on-the-floor offset eases in over ~1 s after a change of clip
    const a = await fig();
    await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.mode === 'idle', null, { timeout: 30000 });
    const i0 = await ds();
    await sleep(2000);
    const i1 = await ds();
    const fps = (Number(i1.frame) - Number(i0.frame)) / 2;
    await sleep(60000);
    const b = await fig();
    const diff = Math.max(...Object.keys(a.bones).flatMap((k) => a.bones[k].map((v, i) => Math.abs(v - b.bones[k][i]))));
    R.longRun = { fps, mode: i1.mode, before: a.bones, after: b.bones, maxBoneDiffDeg: diff, frames: [i0.frame, i1.frame] };
    check(i1.mode === 'idle' && fps <= 15 && fps >= 4, `[${tag}] idle frame budget: mode ${i1.mode}, ${fps} frames/s`);
    R.longRun.root = { before: a.root, after: b.root };
    check(diff < 6 && Math.abs(a.root.x - b.root.x) < 0.01 && Math.abs(a.root.y - b.root.y) < 0.01, `[${tag}] 同一姿势相隔 62 s：采样骨骼最大差 ${diff.toFixed(2)}°（仅呼吸/重心/头部微动），根节点 (${a.root.x.toFixed(3)}, ${a.root.y.toFixed(3)}) → (${b.root.x.toFixed(3)}, ${b.root.y.toFixed(3)}) m，无漂移`);
    await canvasShot('long-run');
    const real = errors.filter((e) => !/Autofill|Electron Security Warning|DevTools|net::ERR_FILE_NOT_FOUND/.test(e));
    R.errors = real;
    check(real.length === 0, `[${tag}] no renderer errors (${real.length})`);
  } catch (e) {
    ok = false;
    note(`[${tag}] ERROR ${e.stack || e.message}`);
    try { await page.screenshot({ path: path.join(dir, 'error.png') }); } catch { /* gone */ }
  } finally {
    await app.close().catch(() => {});
  }
}

(async () => {
  note(`revision ${execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()} (worktree ${ROOT})`);
  await runModel('female', FEMALE, { full: true });
  if (MALE) await runModel('male', MALE, { full: true });
  // female vs male, the same postures side by side (top: liliya, bottom: male)
  if (MALE) {
    try {
      const row = (g) => ['stand.relaxed', 'stand.confident', 'stand.shy', 'stand.playful', 'sit.rest', 'sit.doze'].map((p) => path.join(OUT, g, `posture-${p}.png`));
      const ins = [...row('female'), ...row('male')];
      const scale = ins.map((_, i) => `[${i + 1}]scale=-2:420[s${i}]`).join(';');
      const top = [0, 1, 2, 3, 4, 5].map((i) => `[s${i}]`).join('');
      const bot = [6, 7, 8, 9, 10, 11].map((i) => `[s${i}]`).join('');
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xd8dcef:s=4000x1000:d=1', ...ins.flatMap((f) => ['-i', f]), '-filter_complex', `${scale};${top}hstack=inputs=6[t];${bot}hstack=inputs=6[b];[t][b]vstack[g];[0][g]scale2ref=iw:ih[bg][g2];[bg][g2]overlay=format=auto`, '-frames:v', '1', path.join(OUT, 'female-vs-male-postures.png')]);
      for (const g of ['female', 'male']) {
        const ps = row(g);
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xd8dcef:s=4000x1000:d=1', ...ps.flatMap((f) => ['-i', f]), '-filter_complex', `${ps.map((_, i) => `[${i + 1}]scale=-2:420[s${i}]`).join(';')};${ps.map((_, i) => `[s${i}]`).join('')}hstack=inputs=6[t];[0][t]scale2ref=iw:ih[bg][g2];[bg][g2]overlay=format=auto`, '-frames:v', '1', path.join(OUT, `${g}-postures-sheet.png`)]);
      }
      note('sheets: female-vs-male-postures.png, female-postures-sheet.png, male-postures-sheet.png');
    } catch (e) { note(`sheet failed: ${e.message}`); }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'log.txt'), `${log.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'chapters.json'), `${JSON.stringify(chapters, null, 2)}\n`);
  note(ok ? 'ALL PASS' : 'SOME CHECKS FAILED');
  process.exit(ok ? 0 : 1);
})();
