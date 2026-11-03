// Real-asset VRM acceptance for T-2711 (docs/vrm-motion-system.md §3.6, §5.3, §14): the motion library baked
// from ~/vrm-assets and real models — 莉莉雅 liliya.vrm (female) and the male VRoid model — imported through the
// real app; then, on the real surface:
//   walk   the app's own walk (petFx.walk = the idle chain's fx.walkPet) both ways: the turn (yaw curve ≤ 60°,
//          ≥ 0.3 s, head ahead of the hips), the walk cycle while the window moves (left / right ankles
//          alternating ahead and behind, the planted foot's slide on screen against the window's speed), the
//          stop (back to the idle, no frame jump); a GIF of the canvas, a desktop recording (x11grab) and the
//          per-frame log;
//   talk   a short reply and a long streamed reply (≥ 8 s): arm peak deflection, segments rotating, never a
//          frozen gesture; think (the wait before the reply): a still pose looking up — a different kind of move;
//   3)     the lifted legs' swing (male ≥ 60% of female), the poke's peak deflection, the male doze knees ≥ 0°.
// Nothing is copied into the repository: models, assets and the baked motions must all be outside ROOT.
//
// usage: xvfb-run -a -s '-screen 0 1280x800x24' node .agents/acceptance/scripts/vrm-walk-talk-real-acceptance.js \
//          <repo> <out dir> --motions ~/vrm-assets/baked --model <female.vrm> --male <male.vrm>
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
// the logged quaternions are rounded to 4 decimals: normalized first, else two equal frames read ~1–2° apart
const qn = (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return q.map((v) => v / n); };
const qang = (a0, b0) => { const a = qn(a0); const b = qn(b0); return (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])))) * 180 / Math.PI; };
// T-2691: the reactions whose male version must move his body visibly: peak deflection ≥ 60% of hers
const ARMS = ['leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
const LEGQ = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];

async function runModel(tag, MODEL) {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `pp-vrm-t2711-${tag}-`));
  const fakeLh = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-t2711-lh-'));
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
      const r = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); const f = window.petFx.vrm().figures[0]; return { url: c.toDataURL('image/png'), d: { ...c.dataset }, w: f.weightSum, bones: f.bones, pose: f.pose, state: window.petFx.state().state, winX: window.screenX, walking: window.petFx.stats().walking, plan: f.plan, root: f.root, vel: f.vel, walkSpeed: f.walkSpeed }; });
      fs.writeFileSync(path.join(fdir, `${String(i).padStart(4, '0')}.png`), Buffer.from(r.url.split(',')[1], 'base64'));
      const row = { t: +((at - t1) / 1000).toFixed(3), winX: r.winX, walking: r.walking, facingYaw: r.plan && r.plan.facingYaw, turnLead: r.plan && r.plan.turnLead, walk: r.plan && r.plan.walk, talkSegment: r.plan && r.plan.talkSegment, talkSegments: r.plan && r.plan.talkSegments, planGaze: r.plan && r.plan.gaze, rootYaw: r.root && +r.root.yaw.toFixed(2), vel: r.vel, walkSpeed: r.walkSpeed, hipsYaw: r.pose && r.pose.hipsYaw, app: r.state, reaction: r.d.reaction, hold: r.d.hold, overlays: r.d.overlays, layers: r.d.layers, weightSum: +r.w.toFixed(3), expr: r.d.expr, gaze: r.d.gaze, mouth: r.d.mouth, lip: r.d.lip, posture: r.d.posture, leftArm: r.bones.leftUpperArm, rightArm: r.bones.rightUpperArm, spine: r.bones.spine, head: r.bones.head, q: r.pose && r.pose.q, legs: r.pose && r.pose.legs, rootY: r.pose && r.pose.rootY, headYaw: r.pose && r.pose.headYaw };
      flog.push(row);
      if (slot) {
        const m = (r.d.overlays || '').match(new RegExp(`(?:reaction|hold):${slot.replace('.', '\\.')}(?:-\\d)?@\\w+:([0-9.]+)`));
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
  // the chat row is a toggle (the 聊天 button): open it only when it is closed
  const openChat = async () => {
    for (let i = 0; i < 3; i++) {
      if (await page.evaluate(() => !document.getElementById('chat-row').classList.contains('hidden'))) break;
      await clickAct('chat');
      await sleep(300);
    }
    await page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
  };
  const pose = () => page.evaluate(() => window.petFx.vrm().figures[0].pose);
  const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  const maxArm = (q, ref) => { let m = { deg: 0, bone: null }; for (const b of ARMS) if (q && q[b] && ref[b]) { const a = qang(q[b], ref[b]); if (a > m.deg) m = { deg: +a.toFixed(1), bone: b }; } return m; };
  // the frame-to-frame turn of a set of bones (deg / s), the largest of them
  const boneSpeed = (a, b, bones) => { let m = 0; for (const n of bones) if (a.q && b.q && a.q[n] && b.q[n]) m = Math.max(m, qang(a.q[n], b.q[n])); return m / Math.max(0.01, b.t - a.t); };
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
    await page.evaluate((id) => window.pet.setVrmPosture(id, 'stand.relaxed'), ID);
    // roam off: the idle chain starts no walks of its own (the measured walks are petFx.walk = fx.walkPet, the
    // same walk the idle chain makes), so a turn is never caught half-way
    await page.evaluate(() => window.pet.setPrefs({ touchZones: true, voice: false, roam: false }));
    await page.evaluate(() => window.pet.debugSet({ affection: 10, mood: 60, hunger: 20, sleeping: false, lastAffectionAt: {}, affectionToday: 0 }));
    await sleep(2500);
    const d0 = await ds();
    const clips = await page.evaluate(() => window.petFx.vrm().figures[0].clips);
    R.pack = ID;
    R.style = d0.style;
    R.clips = clips.filter((c) => /^hold\.(walk|talk)/.test(c));
    check(d0.library === 'loaded' && d0.style.startsWith(tag) && R.clips.includes(`hold.walk@${tag}`) && R.clips.filter((c) => c.startsWith('hold.talk')).length === 3, `[${tag}] library ${d0.library}, style ${d0.style}; walk / talk clips: ${R.clips.join(', ')}`);

    // ---------------- 1) walking about ----------------
    const desk = path.join(dir, `${tag}-walk-desktop.mp4`);
    const rec = require('node:child_process').spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1280x800', '-framerate', '15', '-i', process.env.DISPLAY, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '28', desk], { stdio: ['pipe', 'ignore', 'inherit'] });
    R.walks = {};
    for (const [name, dir0] of [['walk-left', 'left'], ['walk-right', 'right']]) {
      mark(`[${tag}] 漫游：朝${dir0 === 'left' ? '左' : '右'}走（转身 → 走路循环 → 停下回 idle）`);
      // the app picks how far a walk goes (60–240 px): a walk under 1.2 s of motion is mostly speeding up and
      // slowing down, so up to 3 walks are made and the first one with ≥ 1.2 s of motion is measured
      let cap = null;
      let fine = null;
      const tries = [];
      for (let attempt = 1; attempt <= 4; attempt++) {
        await settle();
        await page.evaluate((d) => window.petFx.face(d), dir0);
        // standing and facing the screen again (±18°) before the walk starts
        await page.waitForFunction((d) => { const p = window.PetVRM.director.plan(); return p && !window.petFx.stats().walking && Math.abs(p.facingYaw - (d === 'left' ? -18 : 18)) < 0.2; }, dir0, { timeout: 15000 }).catch(() => {});
        await sleep(600);
        // a sampler in the page every 20 ms (the capture loop samples the canvas at a few fps under load): the
        // director's facing, the turn lead, the walk cycle's pace and the window's x
        await page.evaluate(() => { clearInterval(window.__walkSampler); window.__walkSamples = []; const t0 = performance.now(); window.__walkSampler = setInterval(() => { const p = window.PetVRM.director.plan(); const q = window.PetVRM.director.pose(); if (p && q) { const l = q.legs; window.__walkSamples.push([+((performance.now() - t0) / 1000).toFixed(3), p.facingYaw, p.turnLead, p.walk.rate, p.walk.on ? 1 : 0, window.screenX, window.petFx.stats().walking ? 1 : 0, l.left.ankleFwd, l.right.ankleFwd, l.left.ankleY, l.right.ankleY, l.left.ankleClientX, l.right.ankleClientX, q.headYaw, p.hold || '']); } }, 30); });
        let started = false;
        let endedAt = null;
        cap = await capture(name, { ms: 12000, minMs: 1500, every: 50, during: async (sec) => { if (!started && sec > 0.5) { started = true; await page.evaluate(() => { window.petFx.walk(); return true; }); } }, done: (row, fl) => { if (started && fl.some((x) => x.walking) && !row.walking && endedAt === null) endedAt = row.t; return endedAt !== null && row.t - endedAt > 2.2; } });
        fine = await page.evaluate(() => { clearInterval(window.__walkSampler); return window.__walkSamples; });
        const xs = fine.filter((r) => r[6]);
        const moved = xs.filter((r, i) => i > 0 && r[5] !== xs[i - 1][5]);
        const motion = moved.length ? moved[moved.length - 1][0] - moved[0][0] : 0;
        tries.push({ attempt, px: xs.length ? Math.abs(xs[xs.length - 1][5] - xs[0][5]) : 0, motionS: +motion.toFixed(2) });
        note(`[${tag}] ${name} try ${attempt}: window moved ${tries[tries.length - 1].px} px over ${motion.toFixed(2)} s`);
        if (motion >= 1.8) break;
      }
      const L = cap.log;
      const base = L[0].rootYaw - L[0].facingYaw;
      const body = L.map((x) => +wrap(x.rootYaw - base).toFixed(2));
      const y0 = body[0];
      const wk = L.filter((x) => x.walking && x.walk && x.walk.on);
      const target = wk.length ? wk[wk.length - 1].walk.target : null;
      // the turn, on the 20 ms samples of the director's facing (the yaw the renderer draws): from 10% to 90%
      // of the way from the standing yaw to the walking yaw, and from the first move to the end
      const total = target - y0;
      const fy = fine.map((r) => r[1]);
      const fyMax = Math.max(...fy.map(Math.abs));
      const at = (k) => { const r = fine.find((x) => Math.abs(x[1] - fy[0]) >= k * Math.abs(total)); return r ? r[0] : null; };
      const t10 = at(0.1);
      const t90 = at(0.9);
      const tFirst = at(0.01);
      const tEnd = at(0.995);
      const turnS = t10 !== null && t90 !== null ? +(t90 - t10).toFixed(3) : null;
      const turnAll = tFirst !== null && tEnd !== null ? +(tEnd - tFirst).toFixed(3) : null;
      const iStart = L.findIndex((x) => x.t >= (tFirst || 0));
      const i90 = L.findIndex((x) => x.t >= (t90 || 0));
      // the head ahead of the hips while turning (pose.headYaw: head against the body's facing)
      const turning = L.slice(Math.max(0, iStart), i90 + 1);
      const lead = turning.reduce((m, x) => (Math.sign(x.headYaw) === Math.sign(total) && Math.abs(x.headYaw) > Math.abs(m) ? x.headYaw : m), 0);
      // moving: the window carries her — on the 30 ms samples (F) of the director, the window and the ankles
      const F = fine.map((r) => ({ t: r[0], yaw: r[1], lead: r[2], rate: r[3], on: r[4], winX: r[5], walking: r[6], fl: r[7], fr: r[8], yl: r[9], yr: r[10], xl: r[11], xr: r[12], headYaw: r[13], hold: r[14] }));
      const mvF = [];
      { let lastMove = -1; for (let i = 1; i < F.length; i++) { if (F[i].winX !== F[i - 1].winX) lastMove = F[i].t; if (F[i].walking && lastMove >= 0 && F[i].t - lastMove <= 0.15) mvF.push(i); } }
      const mv = [];
      for (let i = 1; i < L.length; i++) { const v = (L[i].winX - L[i - 1].winX) / Math.max(0.01, L[i].t - L[i - 1].t); if (L[i].walking && Math.abs(v) > 15) mv.push(i); }
      const dAnk = mvF.map((i) => F[i].fl - F[i].fr);
      let flips = 0;
      let sgn = 0;
      for (const d of dAnk) { const s0 = d > 0.03 ? 1 : d < -0.03 ? -1 : 0; if (s0 && sgn && s0 !== sgn) flips++; if (s0) sgn = s0; }
      const movingS = mvF.length ? F[mvF[mvF.length - 1]].t - F[mvF[0]].t : 0;
      // the planted foot on screen against the window. A stance: consecutive samples on which the same foot is
      // clearly the lower one (≥ 1.5 cm below the other; double support is skipped). Its slide is how far that
      // foot moved on screen from the first to the last sample of the stance (the OS moves the window in uneven
      // steps — 0 px, then 30 — so sample-to-sample differences would count that jitter both ways), against how
      // far the window moved meanwhile. Over the steady walk (without the first and last 0.3 s of the window's
      // motion, while the pace catches up / winds down; reported apart).
      const slideOver = (idx) => {
        const low = (x) => (x.yl < x.yr - 0.015 ? 'l' : x.yr < x.yl - 0.015 ? 'r' : null);
        const runs = [];
        let cur = null;
        for (const i of idx) {
          const foot = low(F[i]);
          if (cur && foot === cur.foot && i === cur.last + 1) { cur.last = i; continue; }
          if (cur) runs.push(cur);
          cur = foot ? { foot, first: i, last: i } : null;
        }
        if (cur) runs.push(cur);
        let sl = 0;
        let tr = 0;
        let n = 0;
        for (const r of runs.filter((x) => F[x.last].t - F[x.first].t >= 0.15)) { // a stance of ≥ 0.15 s
          const a = F[r.first];
          const b = F[r.last];
          sl += Math.abs((b.winX + b[`x${r.foot}`]) - (a.winX + a[`x${r.foot}`]));
          tr += Math.abs(b.winX - a.winX);
          n++;
        }
        return { slide: +sl.toFixed(1), travel: tr, samples: n, ratio: tr ? +(sl / tr).toFixed(3) : null };
      };
      const t0m = mvF.length ? F[mvF[0]].t : 0;
      const t1m = mvF.length ? F[mvF[mvF.length - 1]].t : 0;
      const steady = mvF.filter((i) => F[i].t - t0m >= 0.3 && t1m - F[i].t >= 0.3);
      const slideSteady = slideOver(steady);
      const slideAll = slideOver(mvF);
      const stances = slideSteady.samples;
      const slide = slideSteady.slide;
      const travel = slideSteady.travel;
      fs.writeFileSync(path.join(dir, `${name}-samples-30ms.json`), `${JSON.stringify(F)}\n`);
      // the stop: from the window's last move to the idle; the walk overlay's weight and the bones' speed
      const iEnd = L.findIndex((x, i) => i > (mv[mv.length - 1] || 0) && !/hold:hold\.walk/.test(x.overlays || ''));
      const stopRows = L.slice(mv[mv.length - 1] || 0, iEnd > 0 ? iEnd + 1 : L.length);
      const ww0 = stopRows.map((x) => Number(((x.overlays || '').match(/hold:hold\.walk@\w+:([0-9.]+)/) || [0, 0])[1]));
      const ww = ww0.slice(ww0.indexOf(Math.max(...ww0))); // from the last full-weight frame
      const stopSpeed = Math.max(0, ...stopRows.slice(1).map((x, i) => boneSpeed(stopRows[i], x, [...LEGQ, ...MAINB])));
      const walkSpeedMax = Math.max(0, ...mv.map((i) => boneSpeed(L[i - 1], L[i], [...LEGQ, ...MAINB])));
      const W = {
        tries, gif: cap.gif, frames: cap.frames, start: y0, target, maxAbsYaw: +Math.max(fyMax, ...body.map(Math.abs)).toFixed(2), turnSeconds: turnS, turnSecondsAll: turnAll, headLead: lead, maxTurnLead: +Math.max(...fine.map((r) => Math.abs(r[2]))).toFixed(2),
        yawCurve: fine.filter((r) => tFirst !== null && r[0] >= tFirst - 0.1 && r[0] <= (tEnd || 0) + 0.1).map((r) => [r[0], +r[1].toFixed(2), +r[2].toFixed(2)]),
        renderedYaw: L.map((x, i) => [x.t, body[i]]),
        movingSeconds: +movingS.toFixed(2), movingSamples: mvF.length, ankleFlips: flips, stepsPerSecond: movingS ? +(flips / movingS).toFixed(2) : 0, ankleRange: dAnk.length ? +(Math.max(...dAnk) - Math.min(...dAnk)).toFixed(3) : 0,
        ankleCurve: mvF.map((i) => [F[i].t, +F[i].fl.toFixed(3), +F[i].fr.toFixed(3)]),
        rate: mvF.length ? +(mvF.reduce((s0, i) => s0 + F[i].rate, 0) / mvF.length).toFixed(3) : 0,
        windowPx: travel, footSlidePx: slide, slideRatio: slideSteady.ratio, slideSamples: slideSteady.samples, slideAllFrames: slideAll,
        stopFadeSeconds: stopRows.length ? +(stopRows[stopRows.length - 1].t - stopRows[0].t).toFixed(2) : null, stopWeights: ww, stopMaxBoneSpeed: +stopSpeed.toFixed(0), walkMaxBoneSpeed: +walkSpeedMax.toFixed(0),
        end: { hold: L[L.length - 1].hold, overlays: L[L.length - 1].overlays, layers: L[L.length - 1].layers }, tposeFrames: cap.tposeFrames,
      };
      R.walks[name] = W;
      fs.writeFileSync(path.join(dir, `${name}-frames.json`), `${JSON.stringify(L, null, 1)}\n`);
      W.direction = L[L.length - 1].winX < L[0].winX ? 'left' : 'right';
      check(W.maxAbsYaw <= 60 && turnS !== null && turnS >= 0.3 && W.maxTurnLead >= 3, `[${tag}] ${name} (walked ${W.direction}, window ${L[0].winX} → ${L[L.length - 1].winX} px): body yaw ${y0}° → ${target}° (max |yaw| ${W.maxAbsYaw}° ≤ 60); the turn took ${turnS} s from 10% to 90% (≥ 0.3; ${turnAll} s in all, 20 ms samples); head/chest lead up to ${W.maxTurnLead}° (rendered head ahead of the hips by ${lead}°)`);
      check(mvF.length >= 20 && flips >= 2 && W.ankleRange >= 0.15, `[${tag}] ${name}: walking ${W.movingSeconds} s (${mvF.length} samples @30 ms): left/right ankles alternate ahead/behind ${flips} times (${W.stepsPerSecond} steps/s), front-back range ${W.ankleRange} m, cycle played at ${W.rate}× its own pace`);
      check(W.slideRatio !== null && W.slideSamples >= 2 && W.slideRatio <= 0.35, `[${tag}] ${name}: steady walk — the planted foot slides ${W.footSlidePx} px on screen while the window travels ${travel} px (${W.slideSamples} stances) → ${(W.slideRatio * 100).toFixed(0)}% (≤ 35%; a whole-body slide is 100%); over every moving frame incl. speed-up / slow-down ${slideAll.slide}/${slideAll.travel} px → ${slideAll.ratio === null ? '-' : (slideAll.ratio * 100).toFixed(0)}%`);
      check(!/hold\.walk/.test(W.end.overlays || '') && ww.every((x, i) => i === 0 || x <= ww[i - 1] + 0.02) && W.stopFadeSeconds >= 0.3 && stopSpeed <= Math.max(1.25 * walkSpeedMax, 450) && cap.tposeFrames === 0, `[${tag}] ${name}: stop → idle over ${W.stopFadeSeconds} s, walk weight ${ww.map((x) => x.toFixed(2)).join(' → ')}; fastest bone while stopping ${W.stopMaxBoneSpeed}°/s (walking ${W.walkMaxBoneSpeed}°/s; ≤ max(1.25× walking, 450°/s)): no jump; ends ${W.end.layers}`);
    }
    rec.stdin.write('q');
    await new Promise((r) => rec.on('close', r));
    R.walkDesktop = path.relative(OUT, desk);

    // ---------------- 2) think → talk (short), long talk ----------------
    mark(`[${tag}] 思考（等待回复）→ 短回复说话`);
    await settle();
    const chatRef = (await pose()).q;
    await openChat();
    await page.fill('#chat-input', '今天过得怎么样呀？');
    await page.press('#chat-input', 'Enter');
    await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
    await page.mouse.move(400, 700);
    const think = await capture('think', { slot: 'hold.think', ms: 2700, every: 70 });
    const talkS = await capture('talk-short', { slot: 'hold.talk', ms: 7000, minMs: 1500, every: 70, done: (row, fl) => fl.some((x) => x.hold === 'talk') && row.hold !== 'talk' });
    mark(`[${tag}] 长回复说话（流式 ≥ 8 s，手势分段轮换）`);
    await settle();
    await sleep(1500);
    const pieces = ['嗯嗯，今天呀，', '我先是在窗边晒了一会儿太阳，', '然后看你一直在忙，', '就安安静静地陪着你。', '中午的时候想起你说过', '最近有点累，', '所以我想提醒你：', '记得起来走走、喝点水，', '眼睛也要休息一下哦。', '晚上如果有空的话，', '我们可以一起听首歌，', '或者你给我讲讲', '今天遇到的有趣的事，', '我会认真听完的。', '总之，', '今天也辛苦啦！', '对了，', '明天天气好像不错，', '要不要出去走走？', '我可以在桌面上', '一直等你回来，', '回来以后再跟我说说吧！', '好啦，', '我说完啦～'];
    // one piece every 450 ms (≈ 11 s of words), then the whole reply in the bubble
    fs.writeFileSync(path.join(fakeLh, 'stream-reply.json'), JSON.stringify({ pieces, gapMs: 450 }));
    const longRef = (await pose()).q;
    await openChat();
    await page.fill('#chat-input', '给我讲讲你今天都做了什么吧');
    await page.press('#chat-input', 'Enter');
    await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
    await page.mouse.move(400, 700);
    let quietSince = null;
    const talkL = await capture('talk-long', { slot: 'hold.talk', ms: 30000, minMs: 4000, every: 80, done: (row, fl) => { if (row.hold === 'talk') quietSince = null; else if (fl.some((x) => x.hold === 'talk')) quietSince = quietSince === null ? row.t : quietSince; return quietSince !== null && row.t - quietSince > 1.5; } });
    fs.rmSync(path.join(fakeLh, 'stream-reply.json'), { force: true });
    const T = {};
    for (const [name, cap, hold, ref] of [['think', think, 'think', chatRef], ['talk-short', talkS, 'talk', chatRef], ['talk-long', talkL, 'talk', longRef]]) {
      // the talk: from its first frame to its last (a reply streaming in: the words may pause between pieces)
      const firstI = cap.log.findIndex((x) => x.hold === hold);
      let lastI = -1;
      cap.log.forEach((x, i) => { if (x.hold === hold) lastI = i; });
      const rows = firstI >= 0 ? cap.log.slice(firstI, lastI + 1).filter((x) => hold !== 'think' || x.hold === 'think') : [];
      let peak = { deg: 0, bone: null, t: null };
      for (const x of rows) { const m = maxArm(x.q, ref); if (m.deg > peak.deg) peak = { ...m, t: x.t }; }
      // how much the arms keep moving (mean deg/s of the fastest arm bone, after the first 0.6 s in)
      const settled = rows.filter((x) => x.t - rows[0].t >= 0.6);
      const sp = settled.slice(1).map((x, i) => boneSpeed(settled[i], x, ARMS));
      const headRange = (() => { const hs = settled.map((x) => x.q && x.q.head).filter(Boolean); let m = 0; for (const a of hs) for (const b of hs) m = Math.max(m, qang(a, b)); return +m.toFixed(1); })();
      // the longest stretch with the arms frozen (every arm bone moved < 0.05° between samples)
      let still = 0;
      let run0 = null;
      for (let i = 1; i < settled.length; i++) { const f = ARMS.every((b) => qang(settled[i].q[b], settled[i - 1].q[b]) < 0.05); if (f) { run0 = run0 === null ? settled[i - 1].t : run0; still = Math.max(still, settled[i].t - run0); } else run0 = null; }
      const clipIds = [...new Set(rows.flatMap((x) => ((x.overlays || '').match(/hold\.talk(?:-\d)?@\w+/g) || [])))];
      const segs = [];
      for (const x of rows) if (x.talkSegment && x.talkSegment !== segs[segs.length - 1]) segs.push(x.talkSegment);
      const gazeY = rows.length ? rows.map((x) => Number((x.gaze || '0,0').split(',')[1])) : [0];
      // where the director points her eyes: think → fixed up; talk → at the cursor (the one she talks to)
      const fixedUp = rows.filter((x) => x.planGaze && x.planGaze.mode === 'fixed' && x.planGaze.y > 1).length / (rows.length || 1);
      T[name] = { gif: cap.gif, frames: cap.frames, seconds: rows.length ? +(rows[rows.length - 1].t - rows[0].t).toFixed(2) : 0, armPeak: peak, armSpeed: sp.length ? +(sp.reduce((a, b) => a + b, 0) / sp.length).toFixed(1) : 0, headRange, frozenArmsSeconds: +still.toFixed(2), segments: segs, clipIds, gazeYMean: +(gazeY.reduce((a, b) => a + b, 0) / gazeY.length).toFixed(2), gazeFixedUpShare: +fixedUp.toFixed(2), overlaysAtPeak: (rows.find((x) => x.t === peak.t) || {}).overlays, holdFrames: rows.length, mouthFrames: rows.filter((x) => Math.max(...(x.mouth || '').split(',').map((p) => Number(p.split(':')[1]) || 0)) > 0.15).length, tposeFrames: cap.tposeFrames };
      fs.writeFileSync(path.join(dir, `${name}-frames.json`), `${JSON.stringify(cap.log, null, 1)}\n`);
    }
    R.talk = T;
    check(T.think.gazeFixedUpShare > 0.8 && T.think.armSpeed < 8 && T.think.frames > 5, `[${tag}] think: a still pose (arms ${T.think.armSpeed}°/s once settled), eyes up (director gaze fixed up in ${(T.think.gazeFixedUpShare * 100).toFixed(0)}% of frames, rendered gaze y ${T.think.gazeYMean}), arm peak ${T.think.armPeak.deg}° (${T.think.armPeak.bone}) → ${T.think.gif}`);
    check(T['talk-short'].armPeak.deg >= 30 && T['talk-short'].mouthFrames >= Math.max(2, 0.5 * T['talk-short'].holdFrames), `[${tag}] short talk: arm peak ${T['talk-short'].armPeak.deg}° (${T['talk-short'].armPeak.bone}; T-2698 measured 18°/9° female), gestures ${T['talk-short'].armSpeed}°/s, head moves ${T['talk-short'].headRange}°, segments ${T['talk-short'].segments.join(' → ')}, ${T['talk-short'].mouthFrames} of ${T['talk-short'].holdFrames} talk frames with the mouth open → ${T['talk-short'].gif}`);
    check(T['talk-short'].armSpeed >= 3 * Math.max(1, T.think.armSpeed) && T['talk-short'].gazeFixedUpShare < 0.2 && T['talk-short'].headRange > T.think.headRange, `[${tag}] talk vs think: a different kind of move — talk: gestures ${T['talk-short'].armSpeed}°/s, head nods over ${T['talk-short'].headRange}°, eyes on the listener (fixed-up gaze ${(T['talk-short'].gazeFixedUpShare * 100).toFixed(0)}% of frames); think: a still pose ${T.think.armSpeed}°/s, head ${T.think.headRange}°, eyes up ${(T.think.gazeFixedUpShare * 100).toFixed(0)}%`);
    const lg = T['talk-long'];
    check(lg.seconds >= 8 && lg.segments.length >= 3 && lg.segments.every((s, i) => i === 0 || s !== lg.segments[i - 1]) && lg.frozenArmsSeconds < 0.5 && lg.armPeak.deg >= 30, `[${tag}] long talk ${lg.seconds} s: segments ${lg.segments.join(' → ')} (≥ 3, never the same twice in a row), arms never frozen (longest still ${lg.frozenArmsSeconds} s), arm peak ${lg.armPeak.deg}° (${lg.armPeak.bone}), gestures ${lg.armSpeed}°/s → ${lg.gif}`);

    // ---------------- 3) lift swing, poke, doze knees ----------------
    mark(`[${tag}] 拖动：拎起后左右拖（腿摆幅）`);
    await settle();
    const box = await page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
    const x0 = box.x + box.width / 2;
    const y0p = box.y + box.height * 0.45;
    let phase = 0;
    const lift = await capture('lift', { slot: 'hold.lift', ms: 4500, during: async (sec) => {
      if (phase === 0 && sec > 0.2) { phase = 1; await page.mouse.move(x0, y0p); await page.mouse.down(); }
      if (phase === 1 && sec > 0.4) await page.mouse.move(x0 + Math.sin(sec * 4) * 60, y0p - 10 - sec * 6);
    } });
    await page.mouse.up();
    const held = lift.log.filter((x) => x.hold === 'lift' && x.q && Number(((x.overlays || '').match(/hold:hold\.lift@\w+:([0-9.]+)/) || [0, 0])[1]) > 0.5);
    const swing = held.length ? Math.max(...held.flatMap((x) => [qang(x.q.leftUpperLeg, held[0].q.leftUpperLeg), qang(x.q.rightUpperLeg, held[0].q.rightUpperLeg)])) : 0;
    R.lift = { gif: lift.gif, heldFrames: held.length, swingDeg: +swing.toFixed(1), knees: held.length ? [Math.min(...held.flatMap((x) => [x.legs.left.knee, x.legs.right.knee])), Math.max(...held.flatMap((x) => [x.legs.left.knee, x.legs.right.knee]))] : null };
    check(held.length >= 5 && swing >= 2, `[${tag}] lifted and dragged: thighs swing up to ${R.lift.swingDeg}° (${held.length} held frames), knees ${R.lift.knees && R.lift.knees.join('…')}° → ${lift.gif}`);
    await sleep(2500);

    mark(`[${tag}] 戳脸：峰值偏转`);
    await settle();
    let poked = null;
    const poke = await capture('touch-face', { slot: 'react.touch-face', ms: 6000, minMs: 1500, during: async (sec) => { if (!poked && sec > 0.25) poked = await click('face'); }, done: over });
    const ref = poke.log[0].q;
    let pk = { deg: 0, bone: null, t: null };
    // the head and the body above the hips (the bones a poke turns; the reviewer read 21° head / 25° neck)
    for (const x of poke.log.filter((r) => r.reaction === 'react.touch-face' || /react\.touch-face/.test(r.overlays || ''))) for (const b of ['spine', 'chest', 'upperChest', 'neck', 'head']) if (x.q && x.q[b] && ref[b]) { const a = qang(x.q[b], ref[b]); if (a > pk.deg) pk = { deg: +a.toFixed(1), bone: b, t: x.t }; }
    const lt = await page.evaluate(() => window.petFx.lastTouch());
    R.poke = { gif: poke.gif, png: poke.png, peak: pk, touch: lt && { zone: lt.zone, mood: lt.mood } };
    check(lt && lt.zone === 'face' && pk.deg >= 30 && poke.tposeFrames === 0, `[${tag}] poke the face (${lt && lt.zone}/${lt && lt.mood}): peak deflection ${pk.deg}° (${pk.bone}) at ${pk.t} s (T-2698: 21° female / 25° male) → ${poke.gif}`);

    mark(`[${tag}] 打盹坐姿（sit.doze）：膝角`);
    await page.evaluate((id) => window.pet.setVrmPosture(id, 'sit.doze'), ID);
    await sleep(5000);
    const dz = await pose();
    await canvasPng(path.join(dir, 'sit-doze.png'));
    await page.screenshot({ path: path.join(dir, 'sit-doze-window.png') });
    R.doze = { knee: [dz.legs.left.knee, dz.legs.right.knee], hipsY: dz.legs.hipsY, png: path.relative(OUT, path.join(dir, 'sit-doze.png')) };
    check(dz.legs.left.knee >= 0 && dz.legs.right.knee >= 0, `[${tag}] sit.doze knees ${dz.legs.left.knee}° / ${dz.legs.right.knee}° (≥ 0: no knee bent backwards; T-2698 male −9.9/−8.5°)`);
    await page.evaluate((id) => window.pet.setVrmPosture(id, 'stand.relaxed'), ID);
    await sleep(1500);

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
  if (MALE && results.models.female && results.models.male) {
    const F = results.models.female;
    const Mm = results.models.male;
    if (F.lift && Mm.lift) check(Mm.lift.swingDeg >= 0.6 * F.lift.swingDeg, `[male vs female] lifted leg swing: male ${Mm.lift.swingDeg}° vs female ${F.lift.swingDeg}° → ${((Mm.lift.swingDeg / (F.lift.swingDeg || 1)) * 100).toFixed(0)}% (≥ 60%)`);
    if (F.talk && Mm.talk) {
      const fi = F.talk['talk-long'].clipIds;
      const mi = Mm.talk['talk-long'].clipIds;
      check(fi.length >= 3 && mi.length >= 3 && fi.every((s) => s.endsWith('@female')) && mi.every((s) => s.endsWith('@male')), `[male vs female] talk clips played: female ${fi.join(', ')} / male ${mi.join(', ')} (each its own set, three different source motions per style in src/core/vrm-library.json)`);
    }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  fs.writeFileSync(path.join(OUT, 'log.txt'), `${log.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'chapters.json'), `${JSON.stringify(chapters, null, 2)}\n`);
  note(ok ? 'ALL PASS' : 'SOME CHECKS FAILED');
  process.exit(ok ? 0 : 1);
})();
