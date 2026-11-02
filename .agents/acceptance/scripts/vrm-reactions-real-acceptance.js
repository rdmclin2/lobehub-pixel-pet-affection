// Real-asset VRM reaction acceptance (T-2681, docs/vrm-motion-system.md §3.3, §5.3, §8.3): the motion library
// baked from ~/vrm-assets (scripts/vrm-bake.js) and real models — 莉莉雅 liliya.vrm (female, guessed from the
// model) and a male VRoid model — imported through the real app; then every interaction reaction is driven
// through the real surface: clicks on the 3D touch zones (head, face, hands, belly, chest at low and mid
// affection), poking the head again and again (happy → annoyed → angry), a reaction interrupted by another,
// press-and-drag (lift) and release (drop), a chat that waits (think) and answers (talk with the mouth), feeding
// (eat), and the celebrations (cheer, greet; injected as the semantic events the app sends). Each one: a GIF of
// the canvas from the click to the return to the idle, the peak frame, and a per-frame log (reaction, overlays,
// face, gaze, arm angles: no T-pose). A female / male sheet of the peak frames shows the two styles.
// Nothing is copied into the repository: models, assets and the baked motions must all be outside ROOT.
//
// usage: xvfb-run -a -s '-screen 0 1280x800x24' node .agents/acceptance/scripts/vrm-reactions-real-acceptance.js \
//          <repo> <out dir> --motions ~/vrm-assets/baked --model <female.vrm> [--male <male.vrm>]
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
for (const p of [MOTIONS, FEMALE, MALE].filter(Boolean)) if (!path.relative(ROOT, p).startsWith('..')) throw new Error(`must live outside the repository: ${p}`);
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
const log = [];
const chapters = [];
let T0 = null;
const t = () => (T0 == null ? 0 : (Date.now() - T0) / 1000);
const note = (s) => { const line = `[${t().toFixed(1)}s] ${s}`; log.push(line); console.log(line); };
let launchedAt = null; // this model's app launch: its recording starts there
const vchapters = {}; // tag → [{ t (s in that model's recording), title }]
let curTag = null;
const mark = (title) => {
  chapters.push({ t: Number(t().toFixed(1)), title });
  if (curTag && launchedAt) (vchapters[curTag] = vchapters[curTag] || []).push({ t: Number(((Date.now() - launchedAt) / 1000).toFixed(1)), title });
  note(`== ${title}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { models: {} };
let ok = true;
const check = (cond, msg) => { note(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) ok = false; return cond; };
// the reactions in the order they are shown (name → the GIF / png base name)
const MAINB = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
const qang = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])))) * 180 / Math.PI;
// T-2691: the reactions whose male version must move his body visibly: peak deflection ≥ 60% of hers
const MALE_VS_FEMALE = ['touch-head', 'touch-face', 'angry', 'annoyed', 'shy', 'ticklish', 'think', 'talk', 'cheer', 'greet'];
const SHEET = ['touch-head', 'touch-face', 'touch-hands', 'ticklish', 'angry', 'shy', 'annoyed', 'chest-escalation', 'lift', 'drop', 'think', 'talk', 'eat', 'cheer', 'greet'];

async function runModel(tag, MODEL) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `pp-vrm-react-${tag}-`));
  const fakeLh = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-react-lh-'));
  fs.writeFileSync(path.join(fakeLh, 'loggedin'), '1');
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: false, petScale: 1.6, petScaleSet: true }));
  const dir = path.join(OUT, tag);
  fs.mkdirSync(dir, { recursive: true });
  note(`[${tag}] model ${MODEL} (${fs.statSync(MODEL).size} B), motions ${MOTIONS}, userData ${DATA}`);
  curTag = tag;
  launchedAt = Date.now();
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    cwd: ROOT,
    env: { ...cleanEnv, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: DATA, PIXELPET_VRM_MOTIONS_DIR: MOTIONS, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fakeLh, FAKE_LH_RUN_DELAY_MS: '3000' },
    recordVideo: { dir: path.join(dir, 'video'), size: { width: 460, height: 640 } },
  });
  const page = await app.firstWindow();
  if (T0 == null) T0 = Date.now();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  const R = (results.models[tag] = { model: MODEL, reactions: {} });
  const ds = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c ? { ...c.dataset } : null; });
  const canvasPng = async (file) => {
    const url = await page.evaluate(() => document.querySelector('#pet-look canvas.vrm').toDataURL('image/png'));
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  };
  // frames of the canvas while `during(sec)` drives the interaction, until `done(frame)` (after `minMs`) or `ms`;
  // → a GIF, the peak frame (largest reaction / hold weight of `slot`) as PNG + the window, and the frame log
  const capture = async (name, { ms = 7000, minMs = 1200, every = 80, during = null, slot = null, done = null }) => {
    const fdir = path.join(dir, `${name}-frames`);
    fs.rmSync(fdir, { recursive: true, force: true });
    fs.mkdirSync(fdir, { recursive: true });
    const t1 = Date.now();
    let i = 0;
    const flog = [];
    let peak = { w: -1, i: -1 };
    while (Date.now() - t1 < ms) {
      const at = Date.now();
      if (during) await during((at - t1) / 1000);
      const r = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); const f = window.petFx.vrm().figures[0]; return { url: c.toDataURL('image/png'), d: { ...c.dataset }, w: f.weightSum, bones: f.bones, pose: f.pose, state: window.petFx.state().state }; });
      fs.writeFileSync(path.join(fdir, `${String(i).padStart(4, '0')}.png`), Buffer.from(r.url.split(',')[1], 'base64'));
      const row = { t: +((at - t1) / 1000).toFixed(2), app: r.state, reaction: r.d.reaction, hold: r.d.hold, overlays: r.d.overlays, layers: r.d.layers, weightSum: +r.w.toFixed(3), expr: r.d.expr, gaze: r.d.gaze, mouth: r.d.mouth, lip: r.d.lip, posture: r.d.posture, leftArm: r.bones.leftUpperArm, rightArm: r.bones.rightUpperArm, spine: r.bones.spine, head: r.bones.head, q: r.pose && r.pose.q, legs: r.pose && r.pose.legs, rootY: r.pose && r.pose.rootY, headYaw: r.pose && r.pose.headYaw };
      flog.push(row);
      if (slot) {
        const m = (r.d.overlays || '').match(new RegExp(`(?:reaction|hold):${slot.replace('.', '\\.')}@\\w+:([0-9.]+)`));
        const w = m ? Number(m[1]) : -1;
        if (w > peak.w + 0.02) { peak = { w, i }; fs.copyFileSync(path.join(fdir, `${String(i).padStart(4, '0')}.png`), path.join(dir, `${name}.png`)); if (w > 0.3) await page.screenshot({ path: path.join(dir, `${name}-window.png`) }); }
      }
      i++;
      if (done && Date.now() - t1 > minMs && done(row, flog)) break;
      const wait = every - (Date.now() - at);
      if (wait > 0) await sleep(wait);
    }
    const fps = Math.max(1, Math.round(1000 / every));
    const gif = path.join(dir, `${name}.gif`);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(fdir, '%04d.png'), '-f', 'lavfi', '-i', `color=c=0xd8dcef:s=64x64:r=${fps}:d=${(i / fps + 1).toFixed(2)}`,
      // bounded backdrop + shortest overlay: an endless lavfi source makes palettegen buffer forever
      '-filter_complex', '[1][0]scale2ref[bg][fg];[bg][fg]overlay=shortest=1:format=auto,scale=-2:420,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer', gif]);
    fs.writeFileSync(path.join(dir, `${name}-frames.json`), `${JSON.stringify(flog, null, 1)}\n`);
    fs.rmSync(fdir, { recursive: true, force: true });
    // never a T-pose: both upper arms straight out sideways at once (|roll| < 12° and little pitch / yaw)
    const tpose = flog.filter((x) => [x.leftArm, x.rightArm].every((a) => Math.abs(a[2]) < 12 && Math.abs(a[0]) < 20 && Math.abs(a[1]) < 20));
    const sums = flog.map((x) => x.weightSum);
    note(`[${tag}] ${name}: gif ${path.relative(OUT, gif)} (${i} frames, ${(fs.statSync(gif).size / 1024).toFixed(0)} KB), peak ${slot || '-'} weight ${peak.w}`);
    return { gif: path.relative(OUT, gif), png: peak.i >= 0 ? path.relative(OUT, path.join(dir, `${name}.png`)) : null, frames: i, log: flog, peak, tposeFrames: tpose.length, weightSums: [Math.min(...sums), Math.max(...sums)] };
  };
  const over = (row) => !row.reaction && !/reaction:|fading:/.test(row.overlays || '');
  const hover = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); };
  const clickAct = async (act) => { await hover(); await page.click(`[data-act="${act}"]`); };
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
  const settle = async () => {
    await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && !c.dataset.reaction && !c.dataset.hold && !/reaction:|fading:|hold:/.test(c.dataset.overlays || ''); }, null, { timeout: 30000 }).catch(() => {});
    await page.mouse.move(400, 700); // the pointer off her (she looks ahead)
    await sleep(700);
  };
  const centers = () => page.evaluate(() => window.PetVRM.director.zoneCenters());
  const click = async (zone) => { const c = await centers(); await page.mouse.click(c[zone].x, c[zone].y); return c[zone]; };
  const summarize = (name, cap, slot, lastTouch = null) => {
    const pk = cap.log[cap.peak.i] || {};
    // how far the reaction moves her: the largest turn of a main bone against the frame before the input (deg)
    const ref = cap.log[0] && cap.log[0].q;
    let deflection = { deg: 0, bone: null, t: null };
    if (ref) for (const x of cap.log) for (const b of MAINB) if (x.q && x.q[b] && ref[b]) { const a = qang(x.q[b], ref[b]); if (a > deflection.deg) deflection = { deg: +a.toFixed(1), bone: b, t: x.t }; }
    const rec = { deflection, gif: cap.gif, png: cap.png, frames: cap.frames, peakWeight: cap.peak.w, peak: { reaction: pk.reaction, hold: pk.hold, overlays: pk.overlays, expr: pk.expr, gaze: pk.gaze, mouth: pk.mouth, leftArm: pk.leftArm, rightArm: pk.rightArm, spine: pk.spine, head: pk.head }, end: cap.log[cap.log.length - 1], tposeFrames: cap.tposeFrames, weightSums: cap.weightSums, touch: lastTouch };
    R.reactions[name] = rec;
    return rec;
  };
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
    await page.evaluate((x) => window.pet.debugNextOpen(x), MODEL);
    await page.click('#vrm-import');
    await page.waitForSelector('#vrm-confirm', { timeout: 90000 });
    await page.click('#vrm-confirm [data-act="use"]');
    await page.waitForSelector('.pack-opt.on[data-pack^="vrm-"]', { timeout: 90000 });
    ID = await page.getAttribute('.pack-opt.on[data-pack^="vrm-"]', 'data-pack');
    await page.click('#panel-close');
    await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > 3; }, null, { timeout: 120000 });
    // a fixed standing posture (the menu's 放松站) so every reaction starts from the same base; voice off (fast lines)
    await page.evaluate((id) => window.pet.setVrmPosture(id, 'stand.relaxed'), ID);
    await page.evaluate(() => window.pet.setPrefs({ touchZones: true, voice: false }));
    await page.evaluate(() => window.pet.debugSet({ affection: 10, mood: 60, hunger: 20, sleeping: false, lastAffectionAt: {}, affectionToday: 0 }));
    await sleep(2500);
    const d0 = await ds();
    const clips = (await page.evaluate(() => window.petFx.vrm().figures[0].clips));
    R.pack = ID;
    R.style = d0.style;
    R.library = { state: d0.library, reactionClips: clips.filter((c) => /^(react|hold)\./.test(c)) };
    check(d0.library === 'loaded' && R.library.reactionClips.length >= 14, `[${tag}] library loaded, style ${d0.style}; reaction/hold clips: ${R.library.reactionClips.join(', ')}`);
    check(d0.style.startsWith(tag), `[${tag}] style guessed from the model: ${d0.style}`);

    mark(`[${tag}] 触摸区：3D 骨骼命中（每个区的中心 → touchPoint）`);
    const c = await centers();
    const hits = {};
    for (const z of ['head', 'face', 'chest', 'belly', 'hands', 'legs', 'feet']) hits[z] = c[z] ? (await page.evaluate((p) => window.petFx.touchPoint(p.x, p.y), c[z])) : null;
    R.zones = Object.fromEntries(Object.entries(hits).map(([z, h]) => [z, h && { zone: h.zone, pose: h.pose, at: [Math.round(c[z].x), Math.round(c[z].y)] }]));
    await page.screenshot({ path: path.join(dir, 'zones-window.png') });
    check(Object.entries(hits).every(([z, h]) => h && h.zone === z && h.pose === 'vrm'), `[${tag}] zones on the skeleton: ${JSON.stringify(R.zones)}`);

    // touches, one per zone (a different zone each time: no streak)
    const touches = [
      ['angry', 'chest', 'react.angry', '敏感区·低好感 → 生气'],
      ['touch-head', 'head', 'react.touch-head', '摸头'],
      ['touch-face', 'face', 'react.touch-face', '戳脸'],
      ['touch-hands', 'hands', 'react.touch-hands', '牵手'],
      ['ticklish', 'belly', 'react.ticklish', '怕痒'],
      ['shy', 'chest', 'react.shy', '敏感区·中好感 → 害羞'],
    ];
    for (const [name, zone, slot, label] of touches) {
      mark(`[${tag}] ${label}：点击${zone}`);
      await settle();
      if (name === 'shy') { await page.evaluate(() => window.pet.debugSet({ affection: 40, lastAffectionAt: {}, affectionToday: 0 })); await sleep(5000); await settle(); } // the stage-up notice passes first
      let at = null;
      const cap = await capture(name, { slot, ms: 8000, minMs: 1500, during: async (sec) => { if (!at && sec > 0.25) at = await click(zone); }, done: over });
      const lt = await page.evaluate(() => window.petFx.lastTouch());
      const rec = summarize(name, cap, slot, lt && { zone: lt.zone, mood: lt.mood, streak: lt.streak });
      check(rec.peak.reaction === slot && rec.peakWeight > 0.3 && cap.tposeFrames === 0 && over(rec.end), `[${tag}] ${label}: touch ${lt.zone}/${lt.mood} → ${rec.peak.reaction}; peak overlays ${rec.peak.overlays}; expr ${rec.peak.expr}; gaze ${rec.peak.gaze}; ${cap.frames} frames, T-pose frames ${cap.tposeFrames}, base weight sum ${cap.weightSums.join('–')}; back to the idle (${rec.end.layers}) → ${cap.gif}`);
    }

    mark(`[${tag}] 连续触摸情绪升级：连摸头 7 次（happy → annoyed → angry），新反应打断旧反应`);
    await settle();
    await sleep(8500); // a fresh streak
    const moods = [];
    let n = 0;
    const esc = await capture('annoyed', { slot: 'react.annoyed', ms: 11000, every: 90, during: async (sec) => {
      if (n < 7 && sec > 0.3 + n * 0.85) { n++; await click('head'); const lt = await page.evaluate(() => window.petFx.lastTouch()); moods.push(`${lt.mood}${lt.streak ? `/${lt.streak}` : ''}`); }
    }, done: (row) => n >= 7 && over(row), minMs: 7000 });
    const hist = await page.evaluate(() => window.PetVRM.director.reactions());
    const fading = esc.log.filter((x) => /fading:/.test(x.overlays || '')).length;
    const rec = summarize('annoyed', esc, 'react.annoyed');
    rec.moods = moods;
    rec.reactions = hist.slice(-3);
    rec.fadingFrames = fading;
    rec.angryPeak = esc.log.filter((x) => x.reaction === 'react.angry').map((x) => x.overlays).slice(-1)[0];
    check(moods.slice(2, 5).every((m) => m === 'annoyed/annoyed') && moods.slice(5).every((m) => m === 'angry/angry') && hist.slice(-2).join() === 'react.annoyed,react.angry' && fading > 0 && esc.tposeFrames === 0, `[${tag}] moods ${moods.join(' → ')}; reactions ${hist.slice(-3).join(' → ')}; ${fading} frames with the interrupted reaction fading out; T-pose frames ${esc.tposeFrames} → ${esc.gif}`);

    mark(`[${tag}] 敏感区连续触摸：中好感连点胸口 7 次（shy → annoyed → angry，touch-zones 的 mood/streak）`);
    await settle();
    await sleep(8500); // a fresh streak
    const cmoods = [];
    let cn = 0;
    const cesc = await capture('chest-escalation', { slot: 'react.angry', ms: 12000, every: 90, during: async (sec) => {
      if (cn < 7 && sec > 0.3 + cn * 0.9) { cn++; await click('chest'); const lt = await page.evaluate(() => window.petFx.lastTouch()); cmoods.push(`${lt.zone}:${lt.mood}${lt.streak ? `/${lt.streak}` : ''}`); }
    }, done: (row) => cn >= 7 && over(row), minMs: 7500 });
    const chist = await page.evaluate(() => window.PetVRM.director.reactions());
    const cr = summarize('chest-escalation', cesc, 'react.angry');
    cr.moods = cmoods;
    cr.reactions = chist.slice(-3);
    cr.fadingFrames = cesc.log.filter((x) => /fading:/.test(x.overlays || '')).length;
    check(cmoods.slice(0, 2).every((m) => m === 'chest:shy') && cmoods.slice(2, 5).every((m) => m === 'chest:annoyed/annoyed') && cmoods.slice(5).every((m) => m === 'chest:angry/angry') && chist.slice(-3).join() === 'react.shy,react.annoyed,react.angry' && cesc.tposeFrames === 0, `[${tag}] chest moods ${cmoods.join(' → ')}; reactions ${chist.slice(-3).join(' → ')}; ${cr.fadingFrames} frames fading the interrupted one; T-pose frames ${cesc.tposeFrames} → ${cesc.gif}`);

    mark(`[${tag}] 拖拽：按住提起（hold.lift，腿下垂）→ 松手放下（react.drop）`);
    await settle();
    const box = await page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
    const x0 = box.x + box.width / 2;
    const y0 = box.y + box.height * 0.45;
    let phase = 0;
    const standLegs = (await page.evaluate(() => window.petFx.vrm().figures[0].pose));
    const lift = await capture('lift', { slot: 'hold.lift', ms: 4200, during: async (sec) => {
      if (phase === 0 && sec > 0.2) { phase = 1; await page.mouse.move(x0, y0); await page.mouse.down(); }
      if (phase === 1 && sec > 0.4) { await page.mouse.move(x0 + Math.sin(sec * 4) * 60, y0 - 10 - sec * 6); }
    } });
    const lr = summarize('lift', lift, 'hold.lift');
    const drop = await capture('drop', { slot: 'react.drop', ms: 4000, minMs: 1000, during: async () => { if (phase === 1) { phase = 2; await page.mouse.up(); } }, done: over });
    const dr = summarize('drop', drop, 'react.drop');
    check(lr.peak.hold === 'lift' && lr.peakWeight > 0.5 && dr.peak.reaction === 'react.drop' && lift.tposeFrames + drop.tposeFrames === 0, `[${tag}] lifted: ${lr.peak.overlays}, expr ${lr.peak.expr}; dropped: ${dr.peak.overlays} → ${lift.gif}, ${drop.gif}`);
    // T-2691: the legs really hang while she is held up: the ankles further below the hips than standing,
    // the toes pointing down (the foot drops below the ankle), the knees soft but never bent backwards or
    // drawn up (0…45°), the body raised off the floor, and the legs swinging with the window
    const held = lift.log.filter((x) => x.hold === 'lift' && x.legs && Number(((x.overlays || '').match(/hold:hold\.lift@\w+:([0-9.]+)/) || [0, 0])[1]) > 0.5);
    const sL = standLegs.legs;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const standAnkle = (sL.left.ankleBelowHips + sL.right.ankleBelowHips) / 2;
    const liftAnkle = Math.max(...held.map((x) => (x.legs.left.ankleBelowHips + x.legs.right.ankleBelowHips) / 2));
    const standToe = (sL.left.toeDrop + sL.right.toeDrop) / 2;
    const liftToe = avg(held.map((x) => (x.legs.left.toeDrop + x.legs.right.toeDrop) / 2));
    const knees = held.flatMap((x) => [x.legs.left.knee, x.legs.right.knee]);
    const rise = Math.max(...held.map((x) => x.rootY)) - standLegs.rootY;
    const swing = held.length ? Math.max(...held.map((x) => qang(x.q.leftUpperLeg, held[0].q.leftUpperLeg))) : 0;
    lr.legs = { heldFrames: held.length, standAnkleBelowHips: +standAnkle.toFixed(4), liftAnkleBelowHips: +liftAnkle.toFixed(4), standToeDrop: +standToe.toFixed(4), liftToeDrop: +liftToe.toFixed(4), knee: [Math.min(...knees), Math.max(...knees)], rise: +rise.toFixed(4), swingDeg: +swing.toFixed(1), standKnee: [sL.left.knee, sL.right.knee] };
    check(held.length >= 5 && liftAnkle > standAnkle + 0.004 && liftToe > standToe + 0.03 && Math.min(...knees) >= 0 && Math.max(...knees) <= 45 && rise > 0.05 && swing >= 2, `[${tag}] legs hang: ankle below hips ${standAnkle.toFixed(3)} m standing → ${liftAnkle.toFixed(3)} m held; toes below the ankle ${standToe.toFixed(3)} → ${liftToe.toFixed(3)} m (pointing down); knees ${Math.min(...knees)}…${Math.max(...knees)}° (0…45, none bent backwards; standing ${sL.left.knee}/${sL.right.knee}°); body raised ${rise.toFixed(3)} m off the floor; legs swing ${swing.toFixed(1)}° with the window (${held.length} held frames)`);

    mark(`[${tag}] 思考/等待回复 → 说话（手势 + 口型并存）`);
    await settle();
    const chatRef = (await page.evaluate(() => window.petFx.vrm().figures[0].pose)).q; // before the chat: the idle
    await clickAct('chat');
    await page.fill('#chat-input', '今天过得怎么样呀？');
    await page.press('#chat-input', 'Enter');
    await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
    await page.mouse.move(400, 700);
    const think = await capture('think', { slot: 'hold.think', ms: 2600 });
    const th = summarize('think', think, 'hold.think');
    const talk = await capture('talk', { slot: 'hold.talk', ms: 6000, minMs: 1500, done: (row, fl) => fl.some((x) => x.hold === 'talk') && row.hold !== 'talk' });
    const tk = summarize('talk', talk, 'hold.talk');
    // think and talk start as the message is sent: measured against the idle before the chat
    for (const [rec, cap, hold] of [[th, think, 'think'], [tk, talk, 'talk']]) {
      let dfl = { deg: 0, bone: null, t: null };
      for (const x of cap.log) if (x.hold === hold && x.q) for (const b of MAINB) if (x.q[b] && chatRef[b]) { const a = qang(x.q[b], chatRef[b]); if (a > dfl.deg) dfl = { deg: +a.toFixed(1), bone: b, t: x.t }; }
      rec.deflection = dfl;
    }
    const talking = talk.log.filter((x) => x.hold === 'talk');
    const mouthOpen = talking.filter((x) => Math.max(...(x.mouth || '').split(',').map((p) => Number(p.split(':')[1]) || 0)) > 0.15).length;
    tk.mouthOpenFrames = mouthOpen;
    check(th.peak.hold === 'think' && Number((th.peak.gaze || '0,0').split(',')[1]) > 0.5 && tk.peak.hold === 'talk' && mouthOpen > 3, `[${tag}] think: ${th.peak.overlays}, gaze ${th.peak.gaze} (up); talk: ${tk.peak.overlays}, ${mouthOpen}/${talking.length} talking frames with the mouth open (${talking.find((x) => x.lip !== 'off')?.lip}) → ${think.gif}, ${talk.gif}`);

    mark(`[${tag}] 吃东西（喂食 → 食物）`);
    await settle();
    await page.evaluate(() => window.pet.debugSet({ hunger: 70 }));
    await clickAct('feed');
    await page.click('#food-menu button');
    await page.mouse.move(400, 700);
    const eat = await capture('eat', { slot: 'hold.eat', ms: 4500 });
    const er = summarize('eat', eat, 'hold.eat');
    check(er.peak.hold === 'eat' && /aa:0\.[1-9]/.test(eat.log.map((x) => x.mouth).join(' ')) && eat.tposeFrames === 0, `[${tag}] eat: ${er.peak.overlays}, expr ${er.peak.expr}, gaze ${er.peak.gaze} (down at the food), chewing mouth → ${eat.gif}`);

    for (const [name, ev, slot, label] of [['cheer', { type: 'celebrate', name: 'evolve' }, 'react.cheer', '开心（进化庆祝）'], ['greet', { type: 'celebrate', name: 'hatch' }, 'react.greet', '打招呼（孵化）']]) {
      mark(`[${tag}] ${label}`);
      await settle();
      let sent = false;
      const cap = await capture(name, { slot, ms: 9000, minMs: 1500, during: async (sec) => { if (!sent && sec > 0.25) { sent = true; await page.evaluate((e) => window.PetVRM.director.inject(e), ev); } }, done: over });
      const r = summarize(name, cap, slot);
      check(r.peak.reaction === slot && r.peakWeight > 0.5 && cap.tposeFrames === 0 && over(r.end), `[${tag}] ${label}: ${r.peak.overlays}, expr ${r.peak.expr} → ${cap.gif}`);
    }
    const real = errors.filter((e) => !/Autofill|Electron Security Warning|DevTools|net::ERR_FILE_NOT_FOUND/.test(e));
    R.errors = real;
    check(real.length === 0, `[${tag}] no renderer errors (${real.length}) ${real.slice(0, 3).join(' | ')}`);
  } catch (e) {
    ok = false;
    note(`[${tag}] ERROR ${e.stack || e.message}`);
    try { await page.screenshot({ path: path.join(dir, 'error.png') }); } catch { /* gone */ }
  } finally {
    const video = page.video();
    await app.close().catch(() => {});
    // the session recording as mp4, with its chapters (seconds from this model's launch)
    try {
      const webm = await video.path();
      const mp4 = path.join(dir, `${tag}-session.mp4`);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '26', mp4]);
      const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4]).toString().trim());
      const ch = (vchapters[tag] || []).filter((c) => c.t < dur);
      fs.writeFileSync(path.join(dir, `${tag}-session-chapters.json`), `${JSON.stringify(ch, null, 2)}\n`);
      R.video = { file: path.relative(OUT, mp4), duration: dur, chapters: ch };
      note(`[${tag}] session video ${path.relative(OUT, mp4)} (${dur.toFixed(1)} s, ${ch.length} chapters)`);
    } catch (e) { note(`[${tag}] video failed: ${e.message}`); }
  }
}

(async () => {
  note(`revision ${execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()} (+ working tree) (worktree ${ROOT})`);
  await runModel('female', FEMALE);
  if (MALE) await runModel('male', MALE);
  // T-2691: the male reactions move his body, not just his face: each one's peak deflection (largest main-bone
  // turn from the frame before the input) is at least 60% of hers
  if (MALE && results.models.female && results.models.male) {
    const F = results.models.female.reactions;
    const Mm = results.models.male.reactions;
    const rows = MALE_VS_FEMALE.filter((n) => F[n] && Mm[n]).map((n) => ({ n, f: F[n].deflection.deg, m: Mm[n].deflection.deg, mb: Mm[n].deflection.bone, k: F[n].deflection.deg ? Mm[n].deflection.deg / F[n].deflection.deg : 0 }));
    results.maleVsFemale = rows;
    for (const r of rows) check(r.m >= 0.6 * r.f, `[male vs female] ${r.n}: male ${r.m}° (${r.mb}) vs female ${r.f}° → ${(r.k * 100).toFixed(0)}% (≥ 60%)`);
    check(rows.length === MALE_VS_FEMALE.length, `[male vs female] ${rows.length}/${MALE_VS_FEMALE.length} reactions compared`);
  }
  // the peak frames side by side: female on top, male below (missing ones skipped)
  try {
    const have = SHEET.filter((n) => fs.existsSync(path.join(OUT, 'female', `${n}.png`)) && (!MALE || fs.existsSync(path.join(OUT, 'male', `${n}.png`))));
    const rows = MALE ? ['female', 'male'] : ['female'];
    const ins = rows.flatMap((g) => have.map((n) => path.join(OUT, g, `${n}.png`)));
    const scale = ins.map((_, i) => `[${i + 1}]scale=-2:360[s${i}]`).join(';');
    const stacks = rows.map((g, r) => `${have.map((_, i) => `[s${r * have.length + i}]`).join('')}hstack=inputs=${have.length}[r${r}]`).join(';');
    const v = rows.length > 1 ? `;${rows.map((_, r) => `[r${r}]`).join('')}vstack=inputs=${rows.length}[g]` : ';[r0]copy[g]';
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xd8dcef:s=4000x1000:d=1', ...ins.flatMap((f) => ['-i', f]), '-filter_complex', `${scale};${stacks}${v};[0][g]scale2ref=iw:ih[bg][g2];[bg][g2]overlay=format=auto`, '-frames:v', '1', path.join(OUT, 'female-vs-male-reactions.png')]);
    results.sheet = { file: 'female-vs-male-reactions.png', columns: have, rows };
    note(`sheet female-vs-male-reactions.png: columns ${have.join(', ')}; rows ${rows.join(' / ')}`);
  } catch (e) { note(`sheet failed: ${e.message}`); }
  fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'log.txt'), `${log.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'chapters.json'), `${JSON.stringify(chapters, null, 2)}\n`);
  note(ok ? 'ALL PASS' : 'SOME CHECKS FAILED');
  process.exit(ok ? 0 : 1);
})();
