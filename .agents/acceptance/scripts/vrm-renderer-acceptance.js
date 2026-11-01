// VRM 渲染器 (T-2648) on the real app: a homemade VRM 1.0 (scripts/make-test-vrm.js — boxes, 18 expressions,
// SpringBone; no third-party model) is imported through the real `import-vrm` IPC and worn by 大肥鱼; the
// three-vrm figure is drawn in a transparent WebGL canvas (SwiftShader), its frame counter climbs, every state
// maps to expressions / moves, the voice drives aa/ih/ou/ee/oh, the frame budget drops to idle and pauses
// when hidden, and switching back to the 2D pack disposes the figure.
// usage: xvfb-run -a node .agents/acceptance/scripts/vrm-renderer-acceptance.js <repo or worktree> <out dir>
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

const [ROOT, OUT] = process.argv.slice(2).map((p) => path.resolve(p));
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { makeTestVrm } = require(path.join(ROOT, 'scripts', 'make-test-vrm.js'));
fs.mkdirSync(OUT, { recursive: true });
const log = [];
const note = (s) => { log.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-model-'));
  const model = path.join(src, 'test-fish.vrm');
  fs.writeFileSync(model, makeTestVrm());
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-r-data-'));
  const fakeLh = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-r-lh-'));
  fs.writeFileSync(path.join(fakeLh, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  note(`revision ${execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()} (worktree ${ROOT})`);
  note(`model ${model} (${fs.statSync(model).size} bytes, generated), userData ${data}`);
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    cwd: ROOT,
    env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: data, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fakeLh },
    recordVideo: { dir: path.join(OUT, 'video'), size: { width: 460, height: 540 } },
  });
  const page = await app.firstWindow();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' || /\[vrm\]/.test(m.text())) consoleErrors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  let ok = true;
  const check = (cond, msg) => { note(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) ok = false; };
  const ds = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c ? { ...c.dataset } : null; });
  const dbg = () => page.evaluate(() => window.petFx.vrm());
  const shot = (n) => page.screenshot({ path: path.join(OUT, n) });
  const evidence = {};
  try {
    await page.waitForSelector('.char-card', { timeout: 20000 });
    await page.click('.char-card[data-species="dafeiyu"]');
    if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
    const before2d = await page.evaluate(() => ({ runtime: !!window.PetVrmRuntime, scripts: [...document.scripts].map((s) => s.getAttribute('src')).filter((s) => /vrm/.test(s || '')) }));
    check(!before2d.runtime && !before2d.scripts.includes('vendor/vrm/three-vrm.min.js'), `2D look: three-vrm not loaded yet (scripts: ${before2d.scripts.join(', ')})`);
    await shot('01-2d-before.png');

    // import the homemade model (real IPC; the dialog answered by debug-next-open) and wear it
    await page.evaluate((p) => window.pet.debugNextOpen(p), model);
    const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
    check(imp.ok === true, `import-vrm → ${imp.pack && imp.pack.id} (${imp.license && imp.license.summary})`);
    const set = await page.evaluate((id) => window.pet.setAppearance(id, 'dafeiyu'), imp.pack.id);
    check(set.ok && set.view.look.kind === 'vrm' && /^pack:\/\//.test(set.view.look.model), `setAppearance → look.kind=${set.view.look.kind}, model=${set.view.look.model}`);
    await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > 2; }, null, { timeout: 30000 });
    const rt = await page.evaluate(() => ({ versions: window.PetVrmRuntime && window.PetVrmRuntime.versions, script: [...document.scripts].some((s) => s.getAttribute('src') === 'vendor/vrm/three-vrm.min.js') }));
    check(rt.script && rt.versions && rt.versions.three === '0.187.0', `runtime loaded on first VRM look: ${JSON.stringify(rt.versions)}`);
    const f1 = Number((await ds()).frame);
    await sleep(1000);
    const d1 = await ds();
    check(Number(d1.frame) > f1, `canvas.dataset.frame climbs: ${f1} → ${d1.frame} in 1 s (fps ${d1.fps}, mode ${d1.mode}, vrm ${d1.vrm}, springs ${d1.springs})`);
    evidence.dataset = d1;
    const g = await dbg();
    const F = g.figures[0];
    check(F.loaded && F.expressions.length === 18 && F.springJoints >= 6, `figure: ${F.expressions.length} expressions, ${F.springJoints} SpringBone joints, memory ${JSON.stringify(F.memory)}`);
    // transparent: the canvas corners are clear, her middle is drawn
    const px = await page.evaluate(() => {
      const c = document.querySelector('#pet-look canvas.vrm');
      const t = document.createElement('canvas');
      t.width = c.width; t.height = c.height;
      const x = t.getContext('2d');
      x.drawImage(c, 0, 0);
      const a = (u, v) => x.getImageData(Math.floor(u * c.width), Math.floor(v * c.height), 1, 1).data[3];
      let opaque = 0;
      const d = x.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 200) opaque++;
      return { corners: [a(0.02, 0.02), a(0.98, 0.02), a(0.02, 0.5), a(0.98, 0.98)], opaqueShare: opaque / (c.width * c.height), size: [c.width, c.height] };
    });
    check(px.corners.every((a) => a === 0) && px.opaqueShare > 0.05 && px.opaqueShare < 0.7, `alpha: corners ${px.corners.join('/')} (transparent), ${(px.opaqueShare * 100).toFixed(1)}% of ${px.size.join('×')} opaque (her)`);
    await shot('02-vrm-idle.png');
    await page.locator('#pet-look canvas.vrm').screenshot({ path: path.join(OUT, '02b-vrm-canvas.png'), omitBackground: true });

    // blinking: the blink expression rises within ~7 s
    let blinked = false;
    for (let i = 0; i < 140 && !blinked; i++) { const d = await ds(); blinked = /(^|,)blink:/.test(d.expr); if (!blinked) await sleep(50); }
    check(blinked, 'random blink: data-expr showed blink:>0 within 7 s');

    // gaze: the cursor at the left / right of the window
    const box = await page.locator('#pet-look canvas.vrm').boundingBox();
    await page.mouse.move(box.x + 2, box.y + box.height * 0.2);
    await sleep(900);
    const gl = (await ds()).gaze;
    await page.mouse.move(box.x + box.width - 2, box.y + box.height * 0.2);
    await sleep(900);
    const gr = (await ds()).gaze;
    check(Number(gl.split(',')[0]) < -0.5 && Number(gr.split(',')[0]) > 0.5, `gaze follows the cursor: left ${gl}, right ${gr}`);
    await shot('03-vrm-gaze-right.png');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.25);

    // states → expressions and moves
    const states = {};
    const watch = async (name, start, stop, wait = 700) => {
      await page.evaluate(start);
      await sleep(wait);
      const d = await ds();
      const fg = (await dbg()).figures[0];
      states[name] = { state: d.state, expr: d.expr, mouth: d.mouth, motion: fg.motion, root: fg.root };
      await shot(`04-state-${name}.png`);
      if (stop) await page.evaluate(stop);
      await sleep(500);
      return states[name];
    };
    let s = await watch('pat', () => window.petFx.cue('pat'));
    check(s.state === 'pat' && /relaxed:/.test(s.expr) && s.motion.nodDown > 3, `pat → ${s.expr}; nodDown ${s.motion.nodDown && s.motion.nodDown.toFixed(1)}`);
    s = await watch('happy', () => window.petFx.cue('happy'));
    check(s.state === 'happy' && /happy:/.test(s.expr) && s.motion.hop > 0.2, `happy → ${s.expr}; hop ${s.motion.hop && s.motion.hop.toFixed(2)}`);
    s = await watch('lifted', () => window.petFx.lift(true), () => window.petFx.lift(false), 900);
    check(s.state === 'lifted' && /surprised:/.test(s.expr) && s.motion.dangle > 0.5, `lifted → ${s.expr}; dangle ${s.motion.dangle && s.motion.dangle.toFixed(2)}`);
    s = await watch('eat', () => window.petFx.eat('rice'), null, 900);
    check(s.state === 'eat_rice' && /happy:/.test(s.expr) && s.motion.chew > 0.5, `eat_rice → ${s.expr}; chew ${s.motion.chew && s.motion.chew.toFixed(2)}; mouth ${s.mouth}`);
    await sleep(3300);
    s = await watch('play', () => window.petFx.cue('play'), null, 600);
    check(s.state === 'play' && /happy:/.test(s.expr) && s.motion.spin > 0.3, `play → ${s.expr}; spin ${s.motion.spin && s.motion.spin.toFixed(2)}, yaw ${s.root.yaw.toFixed(0)}°`);
    s = await watch('sad', () => window.petFx.cue('sad'));
    check(s.state === 'sad' && /sad:/.test(s.expr), `sad → ${s.expr}`);
    // a click on her head (部位触摸 on: the head zone)
    await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
    await sleep(300);
    let hy = 0.3;
    for (let y = 0.12; y < 0.5; y += 0.02) {
      const z = await page.evaluate(([x, yy]) => window.petFx.touchPoint(x, yy), [box.x + box.width / 2, box.y + box.height * y]);
      if (z && z.zone === 'head' && z.opaque) { hy = y; break; }
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * hy);
    await sleep(500);
    const th = await ds();
    states.touch = { state: th.state, expr: th.expr };
    await shot('04-state-touch-head.png');
    check(/^(touch-|pat)/.test(th.state) && /(relaxed|happy):/.test(th.expr), `click on her head → state ${th.state}, ${th.expr}`);
    await sleep(2500);

    // lip sync: a vowel WAV through the TTS player (playAudio) → analyser → aa/ih/ou/ee/oh
    const voice = page.evaluate(() => window.petFx.testVoice(2.5));
    const mouths = [];
    for (let i = 0; i < 40; i++) { const d = await ds(); mouths.push({ lip: d.lip, mouth: d.mouth }); await sleep(50); }
    const end = await voice;
    await sleep(600);
    const after = await ds();
    const shapes = new Set();
    let maxOpen = 0;
    for (const m of mouths) {
      const v = Object.fromEntries(m.mouth.split(',').map((p) => p.split(':')).map(([k, x]) => [k, Number(x)]));
      const top = Object.entries(v).sort((a, b) => b[1] - a[1])[0];
      if (top[1] > 0.15) shapes.add(top[0]);
      maxOpen = Math.max(maxOpen, top[1]);
    }
    const lipModes = [...new Set(mouths.map((m) => m.lip))];
    check(lipModes.includes('audio') && maxOpen > 0.3 && shapes.size >= 2, `lip sync while the voice plays: lip modes ${lipModes.join('/')}, shapes ${[...shapes].join(',')}, max ${maxOpen.toFixed(2)} (clip ended: ${end})`);
    check(after.mouth === 'aa:0.00,ih:0.00,ou:0.00,ee:0.00,oh:0.00' && after.lip === 'off', `after the voice: mouth ${after.mouth}, lip ${after.lip}`);
    evidence.lipSamples = mouths.filter((_, i) => i % 4 === 0);
    const vd = await dbg();
    note(`      audio context ${vd.audioContext}, elements routed ${vd.lipAttached}`);

    // frame budget: idle after 6 s of nothing → ~12 fps; hidden → paused, frame stops
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.25);
    await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c.dataset.mode === 'idle'; }, null, { timeout: 20000 });
    await sleep(2200);
    const idle = await ds();
    check(idle.mode === 'idle' && Number(idle.fps) >= 8 && Number(idle.fps) <= 18, `idle: mode ${idle.mode}, fps ${idle.fps}`);
    await page.evaluate(() => window.petFx.cue('pat'));
    await sleep(1200);
    const act = await ds();
    check(act.mode === 'active' && Number(act.fps) >= 20 && Number(act.fps) <= 61, `active (a pat): mode ${act.mode}, fps ${act.fps}`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await sleep(800);
    note(`      after hide(): document.hidden=${await page.evaluate(() => document.hidden)} visibilityState=${await page.evaluate(() => document.visibilityState)}`);
    const h1 = await ds();
    await sleep(1500);
    const h2 = await ds();
    check(h1.mode === 'paused' && h1.frame === h2.frame, `hidden window: mode ${h1.mode}, frame ${h1.frame} → ${h2.frame} (no drawing)`);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await sleep(1200);
    const sh = await ds();
    check(sh.mode !== 'paused' && Number(sh.frame) > Number(h2.frame), `shown again: mode ${sh.mode}, frame ${sh.frame}`);

    // window drag inertia: moving the window makes her lag and lean, then settle
    const rootBefore = (await dbg()).figures[0].root;
    for (let i = 0; i < 10; i++) { await page.evaluate(() => window.pet.moveBy(40, 0)); await sleep(30); }
    const rootMoving = (await dbg()).figures[0].root;
    await sleep(1500);
    const rootAfter = (await dbg()).figures[0].root;
    check(Math.abs(rootMoving.x - rootBefore.x) > 0.002 || Math.abs(rootMoving.roll - rootBefore.roll) > 0.3, `window drag inertia: root x ${rootBefore.x.toFixed(3)} → ${rootMoving.x.toFixed(3)} → ${rootAfter.x.toFixed(3)}, roll ${rootBefore.roll.toFixed(1)}° → ${rootMoving.roll.toFixed(1)}° → ${rootAfter.roll.toFixed(1)}°`);

    // back to the 2D pack: the figure is disposed (renderer, geometries, textures), the 2D look draws
    const back = await page.evaluate(() => window.pet.setAppearance('dafeiyu-pixel', 'dafeiyu'));
    await sleep(1500);
    const st = await page.evaluate(() => ({ stats: window.PetVRM.stats, canvas: !!document.querySelector('#pet-look canvas.vrm'), el: document.querySelector('#pet-look').firstElementChild && document.querySelector('#pet-look').firstElementChild.outerHTML.slice(0, 120) }));
    check(back.ok && back.view.look.kind !== 'vrm' && !st.canvas && st.stats.live === 0 && st.stats.disposed >= 1, `back to 2D (${back.view.look.kind}): VRM canvas gone, figures live ${st.stats.live}, disposed ${st.stats.disposed}, memory before dispose ${JSON.stringify(st.stats.lastDispose && st.stats.lastDispose.before)} → after ${JSON.stringify(st.stats.lastDispose && st.stats.lastDispose.after)}`);
    await shot('05-back-to-2d.png');
    // and again to the VRM: a new figure, no leftovers
    await page.evaluate((id) => window.pet.setAppearance(id, 'dafeiyu'), imp.pack.id);
    await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > 2; }, null, { timeout: 20000 });
    const st2 = await page.evaluate(() => window.PetVRM.stats);
    check(st2.live === 1 && st2.created === st2.disposed + 1, `VRM again: created ${st2.created}, disposed ${st2.disposed}, live ${st2.live}`);
    await shot('06-vrm-again.png');

    // a VRM that cannot be drawn (meta only, no humanoid / mesh): the picture tile stands in, the figure lets go
    const metaOnly = path.join(src, 'meta-only.vrm');
    const j = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, extensions: { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Meta Only', authors: ['t'], licenseUrl: 'https://vrm.dev/licenses/1.0/' }, humanoid: { humanBones: {} } } } }).padEnd(4 * Math.ceil(JSON.stringify({ asset: { version: '2.0' }, extensions: { VRMC_vrm: { specVersion: '1.0', meta: { name: 'Meta Only', authors: ['t'], licenseUrl: 'https://vrm.dev/licenses/1.0/' }, humanoid: { humanBones: {} } } } }).length / 4)));
    const g2 = Buffer.alloc(20 + j.length);
    g2.writeUInt32LE(0x46546c67, 0); g2.writeUInt32LE(2, 4); g2.writeUInt32LE(g2.length, 8); g2.writeUInt32LE(j.length, 12); g2.writeUInt32LE(0x4e4f534a, 16); j.copy(g2, 20);
    fs.writeFileSync(metaOnly, g2);
    await page.evaluate((p) => window.pet.debugNextOpen(p), metaOnly);
    const imp2 = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
    await page.evaluate((id) => window.pet.setAppearance(id, 'dafeiyu'), imp2.pack.id);
    await page.waitForSelector('#pet-look .vrm-look', { timeout: 20000 });
    await sleep(500);
    const st3 = await page.evaluate(() => window.PetVRM.stats);
    check(st3.live === 0 && st3.disposed === st3.created, `undrawable VRM (meta only): picture tile shown, figure released (created ${st3.created}, disposed ${st3.disposed}, live ${st3.live})`);
    await shot('07-undrawable-vrm-tile.png');
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !/falling back to the picture/.test(e)));

    const errs = consoleErrors.filter((e) => !/Autofill|Electron Security Warning|DevTools/.test(e));
    check(errs.length === 0, `no renderer errors (${errs.length})${errs.length ? `: ${errs.slice(0, 5).join(' | ')}` : ''}`);
    const vrmInRepo = execSync('git ls-files "*.vrm" "**/*.vrm"; find src -iname "*.vrm"', { cwd: ROOT }).toString().trim();
    check(vrmInRepo === '', 'no .vrm in the repository (git ls-files / find src)');
    evidence.states = states;
    fs.writeFileSync(path.join(OUT, 'vrm-renderer-evidence.json'), JSON.stringify(evidence, null, 2));
  } catch (e) {
    ok = false;
    note(`ERROR ${e.stack || e}`);
    note(`console: ${consoleErrors.slice(0, 10).join(' | ')}`);
    await page.screenshot({ path: path.join(OUT, 'error.png') }).catch(() => {});
  } finally {
    const video = page.video();
    await app.close().catch(() => {});
    if (video) { const v = await video.path().catch(() => null); if (v && fs.existsSync(v)) { fs.renameSync(v, path.join(OUT, 'vrm-renderer-run.webm')); note(`video ${path.join(OUT, 'vrm-renderer-run.webm')}`); } }
    note(ok ? 'RESULT: all checks passed' : 'RESULT: failures above');
    fs.writeFileSync(path.join(OUT, 'vrm-renderer-log.txt'), `${log.join('\n')}\n`);
    process.exit(ok ? 0 : 1);
  }
})();
