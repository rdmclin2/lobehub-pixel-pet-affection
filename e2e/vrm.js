'use strict';

// VRM e2e scenarios (run.js `vrm` / `vrmimport`), kept out of run.js because it is already over the size
// limit. The model is a homemade VRM 1.0 made on the spot by scripts/make-test-vrm.js (boxes, the humanoid
// skeleton, 18 preset expressions incl. blink/happy/aa/ih/ou/ee/oh, SpringBone tail + ahoge) and written to a
// temp dir: no third-party model is used, and no .vrm is ever written inside the repository. Its meta is
// made restrictive (allowRedistribution=false, modification=prohibited, creditNotation=required) so the
// app's limits show. Drawn by the real three-vrm renderer under SwiftShader (run.js launches Electron with
// --enable-unsafe-swiftshader --ignore-gpu-blocklist).
//
//   vrmimport  外观 → 导入 VRM 模型… → 导入确认 (author, license, restrictions) → the user pack, its card and
//              授权信息; the model copied into userData only; drawn on the desk.
//   vrm        wearing it: the canvas draws (data-frame climbs, three / three-vrm loaded), idle frame budget,
//              blinking, gaze following the cursor; 摸摸 / 拖起 / 喂食 / 玩耍 through the UI; an interaction
//              line from her voice pack moving aa/ih/ou/ee/oh and back to 0; 18+ off keeps a VRM pack's adult
//              outfit out of reach; back to dafeiyu-pixel and to the VRM again; no .vrm in git or the build.
//   vrmframe   取景 (半身模式, docs/half-body-mode.md): 全身 → 设置窗口 桌宠行为 → 取景 → 半身 → only head to waist,
//              centred, bigger, same window; the camera glides (no reload, no T-pose); gaze, 摸摸 (touch zones
//              mapped, legs out of reach), 拖起, 口型 in 半身; back to 全身 = the first camera again; her own
//              取景 on her page; a real VRM too (PIXELPET_E2E_REAL_VRM=<file.vrm>, never copied into the repo);
//              a restart keeps 半身.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { makeTestVrm } = require('../scripts/make-test-vrm');

// The restrictive license the e2e model carries (a homemade mesh; only the meta says "restricted").
const RESTRICTED = {
  authors: ['E2E Maker'],
  copyrightInformation: '© E2E Maker (generated test model)',
  contactInformation: 'https://example.com/e2e-maker',
  avatarPermission: 'onlyAuthor',
  commercialUsage: 'personalNonProfit',
  creditNotation: 'required',
  allowRedistribution: false,
  modification: 'prohibited',
  allowExcessivelySexualUsage: false,
  otherLicenseUrl: undefined,
};
const MODEL_NAME = 'E2E 自制小鱼';

// A temp dir outside the repository with the generated model; refuses a path inside the repo.
function makeModel(root, tag, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${tag}-model-`));
  const file = path.join(dir, opts.file || 'e2e-fish.vrm');
  const rel = path.relative(root, file);
  assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `the test model must live outside the repository: ${file}`);
  fs.writeFileSync(file, makeTestVrm({ name: opts.name || MODEL_NAME, meta: opts.meta || RESTRICTED, omit: opts.omit || [] }));
  return { dir, file };
}

module.exports = function vrmScenarios(ctx) {
  const { ROOT, OUT, FAKE_LH, step, launch, openCurrentPage, clickAct, openAdminWindow, petBounds } = ctx;
  const SHOTS = path.join(OUT, 'vrm');
  fs.mkdirSync(SHOTS, { recursive: true });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // a fresh data dir, logged in through the fake lh
  function dataDir(tag, settings) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${tag}-`));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${tag}fake-`));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, ...settings }));
    return { data, env: { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir } };
  }
  function helpers(page, prefix, evidence) {
    const shot = async (name) => { await sleep(120); await page.screenshot({ path: path.join(SHOTS, `${prefix}-${name}.png`) }); return `vrm/${prefix}-${name}.png`; };
    const ds = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c ? { ...c.dataset } : null; });
    const fig = async () => { const d = await page.evaluate(() => window.petFx.vrm()); return d && d.figures[0]; };
    const note = (s) => { evidence.push(s); return s; };
    const hatch = async () => {
      await page.waitForSelector('.char-card', { timeout: 20000 });
      await page.click('.char-card[data-species="dafeiyu"]');
      await page.fill('#pet-name', 'Mow');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily', null, { timeout: 10000 });
    };
    // 角色页 → 外观: pick a pack as a user does; waits until her look is that pack
    const pickPack = async (id) => {
      await openCurrentPage(page);
      await page.locator(`.pack-opt[data-pack="${id}"]`).scrollIntoViewIfNeeded();
      if (!(await page.locator(`.pack-opt.on[data-pack="${id}"]`).count())) await page.click(`.pack-opt[data-pack="${id}"] .pick`);
      await page.waitForSelector(`.pack-opt.on[data-pack="${id}"]`);
      await page.click('#panel-close');
      await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), id, { timeout: 10000 });
    };
    const drawing = (n = 2, timeout = 30000) => page.waitForFunction((k) => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > k; }, n, { timeout });
    return { shot, ds, fig, note, hatch, pickPack, drawing };
  }
  const watchErrors = (page) => {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    return errors;
  };
  const realErrors = (errors) => errors.filter((e) => !/Autofill|Electron Security Warning|DevTools|net::ERR_FILE_NOT_FOUND/.test(e));

  // ------------------------------------------------------------------ vrmimport
  async function vrmImport() {
    const S = 'vrmimport';
    const { data, env } = dataDir('vrmimport');
    const model = makeModel(ROOT, 'vrmimport');
    const evidence = [];
    const { app, page } = await launch(env);
    const errors = watchErrors(page);
    const H = helpers(page, 'vrmimport', evidence);
    const msg = () => page.textContent('#panel-msg');
    let ID = null;
    try {
      await step(S, 'a homemade VRM 1.0 with a restrictive license is generated outside the repository', async () => {
        const buf = fs.readFileSync(model.file);
        const j = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString('utf8'));
        const v = j.extensions.VRMC_vrm;
        assert.equal(v.specVersion, '1.0');
        assert.equal(v.meta.allowRedistribution, false);
        assert.equal(v.meta.modification, 'prohibited');
        assert.equal(v.meta.creditNotation, 'required');
        for (const e of ['blink', 'happy', 'aa', 'ih', 'ou', 'ee', 'oh']) assert.ok(v.expressions.preset[e], `expression ${e}`);
        assert.ok(Object.keys(v.humanoid.humanBones).length >= 15);
        assert.ok(j.extensions.VRMC_springBone.springs.length >= 1);
        return H.note(`${model.file} (${buf.length} B): VRM ${v.specVersion}, ${Object.keys(v.humanoid.humanBones).length} humanoid bones, ${Object.keys(v.expressions.preset).length} expressions, springs ${j.extensions.VRMC_springBone.springs.map((s) => `${s.name}×${s.joints.length}`).join(' ')}, meta ${JSON.stringify({ allowRedistribution: v.meta.allowRedistribution, modification: v.meta.modification, creditNotation: v.meta.creditNotation })}`);
      });

      await step(S, 'hatching 大肥鱼 in her default pixel look', H.hatch, page);

      await step(S, '外观 → 导入 VRM 模型…: 导入确认 shows author, license and the restrictions', async () => {
        await openCurrentPage(page);
        await page.locator('#vrm-import').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('#vrm-import').textContent(), '导入 VRM 模型…');
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file); // answers the system file dialog
        await page.click('#vrm-import');
        await page.waitForSelector('#vrm-confirm', { timeout: 20000 });
        const t = await page.textContent('#vrm-confirm');
        for (const s of [`导入 VRM 模型「${MODEL_NAME}」`, '作者E2E Maker', '版权© E2E Maker', '谁可以扮演仅作者本人', '商用仅限个人非商业使用', '再分发不允许', '修改禁止修改', '署名需要署名', '授权条款https://vrm.dev/licenses/1.0/']) assert.ok(t.includes(s), `missing: ${s}`);
        const rs = await page.$$eval('#vrm-confirm .vrm-restrictions li', (ls) => ls.map((l) => `${l.dataset.id}: ${l.textContent.trim()}`));
        for (const id of ['no-redistribution', 'no-modification', 'credit-required']) assert.ok(rs.some((r) => r.startsWith(`${id}:`)), `restriction ${id}: ${rs.join(' | ')}`);
        assert.match(t, /不可再分发：仅限本机使用/);
        await H.shot('1-confirm');
        return H.note(`导入确认 restrictions: ${rs.join(' | ')}`);
      }, page);

      await step(S, '使用这个模型: the user pack is made and worn; the card shows VRM · 作者 and the credit line', async () => {
        await page.click('#vrm-confirm [data-act="use"]');
        await page.waitForSelector('.pack-opt.on[data-pack^="vrm-"]', { timeout: 20000 });
        ID = await page.getAttribute('.pack-opt.on[data-pack^="vrm-"]', 'data-pack');
        assert.match(await msg(), new RegExp(`已导入 VRM 模型「${MODEL_NAME}」并换上（作者：E2E Maker）`));
        const line = await page.textContent(`.pack-opt[data-pack="${ID}"] .meta span`);
        assert.match(line, /^VRM · \d+ 套服饰 · E2E Maker · 本地导入$/);
        assert.equal(await page.textContent(`.pack-opt[data-pack="${ID}"] .vrm-credit`), '署名：E2E Maker（模型授权要求署名）');
        const ex = page.locator(`.pack-opt[data-pack="${ID}"] .pack-export`);
        assert.equal(await ex.isDisabled(), true, '导出… disabled for a non-redistributable model');
        const why = (await page.textContent(`.vrm-noexport[data-pack="${ID}"]`)).trim();
        assert.match(why, /导出已禁用：这个 VRM 模型的授权不允许再分发/);
        await page.locator(`.pack-opt[data-pack="${ID}"]`).scrollIntoViewIfNeeded();
        await H.shot('2-card');
        return H.note(`pack ${ID}: 「${line}」; credit 「署名：E2E Maker（模型授权要求署名）」; ${why}`);
      }, page);

      await step(S, '授权信息 on the card: the license details with author and restrictions', async () => {
        await page.click(`.pack-opt[data-pack="${ID}"] .vrm-info`);
        const sel = `.pack-list .vrm-license[data-pack="${ID}"]`;
        await page.waitForSelector(sel);
        const t = (await page.textContent(sel)).replace(/\s+/g, ' ');
        assert.match(t, /VRM 1\.0 授权：仅限个人非商业使用 \/ 不可再分发 \/ 禁止修改 \/ 需署名/);
        assert.match(t, /作者E2E Maker/);
        await page.locator(sel).scrollIntoViewIfNeeded();
        await H.shot('3-license');
        return H.note(`授权信息: ${t.slice(0, 260)}`);
      }, page);

      await step(S, 'the user pack lives in userData: pack.json kind "vrm" with the meta; the model copied there, not into the repo', async () => {
        const dir = path.join(data, 'packs', ID);
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
        assert.equal(manifest.kind, 'vrm');
        assert.equal(manifest.species, 'dafeiyu');
        const files = [...new Set(Object.values(manifest.vrm.outfits))];
        for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), f);
        assert.ok(!Object.keys(manifest.vrm.outfits).some((o) => require('../src/core/outfits').OUTFITS.find((x) => x.id === o).rating === 'adult'), 'the importer maps no adult outfit');
        const inRepo = execFileSync('git', ['ls-files', '--others', '--cached', '--', '*.vrm', '*.VRM'], { cwd: ROOT, encoding: 'utf8' }).trim();
        assert.equal(inRepo, '', 'no .vrm tracked or untracked in the worktree');
        return H.note(`${dir}/pack.json: kind=${manifest.kind}, outfits ${Object.keys(manifest.vrm.outfits).join(',')} → ${files.join(', ')}; no .vrm in the worktree`);
      });

      await step(S, 'on the desk the imported model is drawn by three-vrm', async () => {
        await page.click('#panel-close');
        await H.drawing(2);
        await sleep(800);
        const d = await H.ds();
        const f = await H.fig();
        assert.ok(f.loaded && f.expressions.length === 18, JSON.stringify(f.expressions));
        await H.shot('4-desk');
        return H.note(`desk: frame ${d.frame}, vrm ${d.vrm}, springs ${d.springs}, ${f.expressions.length} expressions`);
      }, page);

      await step(S, 'no renderer error on the page', async () => {
        assert.deepEqual(realErrors(errors), []);
      });
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'vrmimport-log.txt'), `${evidence.join('\n\n')}\n`);
      await app.close().catch(() => {});
    }
  }

  // ------------------------------------------------------------------ vrm
  async function vrmScenario() {
    const S = 'vrm';
    // 18+ confirmed but adult content off: the app's switch decides (5)
    const { data, env } = dataDir('vrm', { ageConfirmed: true, ageConfirmedAt: Date.now() });
    const model = makeModel(ROOT, 'vrm');
    const evidence = [];
    const samples = {};
    const { app, page } = await launch(env, { args: ['--autoplay-policy=no-user-gesture-required'] });
    const errors = watchErrors(page);
    const H = helpers(page, 'vrm', evidence);
    let ID = null;
    let box = null;
    const petBox = () => page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
    // after an interaction: the state, face and moves the figure shows at its peak
    const peak = async (name, want, ms = 2500) => {
      const t0 = Date.now();
      let best = null;
      while (Date.now() - t0 < ms) {
        const d = await H.ds();
        const f = await H.fig();
        const s = { state: d.state, expr: d.expr, mouth: d.mouth, motion: f.motion, root: f.root, frame: d.frame, mode: d.mode, fps: d.fps };
        if (want(s)) { best = s; break; }
        best = s;
        await sleep(60);
      }
      samples[name] = best;
      return best;
    };
    const fmtMotion = (m) => Object.entries(m || {}).filter(([, v]) => Math.abs(v) > 0.05).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ');
    const rest = async () => { await page.waitForFunction(() => { const s = window.petFx.state(); return s && /^(idle|walk|sit|bored)$/.test(s.state); }, null, { timeout: 15000 }).catch(() => {}); await sleep(400); };
    try {
      await step(S, 'hatching 大肥鱼 (pixel); the 3D runtime is not loaded for a 2D look', async () => {
        await H.hatch();
        const r = await page.evaluate(() => ({ rt: !!window.PetVrmRuntime, vrm: !!window.PetVRM }));
        assert.equal(r.rt, false);
        return H.note(`2D look: PetVrmRuntime ${r.rt}, PetVRM ${r.vrm}`);
      }, page);

      await step(S, 'the homemade model is imported (real import-vrm IPC) and picked under 外观', async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file);
        const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
        assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
        ID = imp.pack.id;
        await page.evaluate(() => window.pet.setAppearance('dafeiyu-pixel', 'dafeiyu')); // the import wears it: start from 2D
        await H.pickPack(ID);
        return H.note(`imported ${ID} (${imp.license && imp.license.summary}); picked in 外观`);
      }, page);

      await step(S, 'the VRM canvas appears, data-frame climbs, three r187 + three-vrm loaded', async () => {
        await H.drawing(2);
        const a = await H.ds();
        await sleep(1000);
        const b = await H.ds();
        assert.ok(Number(b.frame) > Number(a.frame), `${a.frame} → ${b.frame}`);
        const rt = await page.evaluate(() => ({ versions: window.PetVrmRuntime && window.PetVrmRuntime.versions, script: [...document.scripts].some((s) => s.getAttribute('src') === 'vendor/vrm/three-vrm.min.js')}));
        assert.ok(rt.script && rt.versions && rt.versions.three && rt.versions['three-vrm'], JSON.stringify(rt));
        const f = await H.fig();
        assert.ok(f.loaded && f.springJoints >= 4, `springs ${f.springJoints}`);
        // the embedded texture (loaded through a blob: URL, as a real model's are) has its image: T-2654
        assert.ok(f.maps.total >= 1 && f.maps.loaded === f.maps.total, `texture maps ${JSON.stringify(f.maps)}`);
        samples.start = { a, b, runtime: rt.versions, maps: f.maps };
        box = await page.locator('#pet-look canvas.vrm').boundingBox();
        await H.shot('1-drawn');
        return H.note(`data-frame ${a.frame} → ${b.frame} in 1 s (fps ${b.fps}, mode ${b.mode}); runtime ${JSON.stringify(rt.versions)}; SpringBone joints ${f.springJoints}; texture maps ${f.maps.loaded}/${f.maps.total} loaded`);
      }, page);

      await step(S, 'idle: after a while with nothing happening the frame budget drops (data-mode idle, lower fps)', async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.25);
        await page.evaluate(() => window.petFx.cue('happy'));
        await sleep(900);
        const act = await H.ds();
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.mode === 'idle', null, { timeout: 25000 });
        await sleep(2200);
        const f0 = await H.ds();
        await sleep(2000);
        const f1 = await H.ds();
        const measured = (Number(f1.frame) - Number(f0.frame)) / 2;
        samples.frameBudget = { active: act, idle: f1, idleFramesPerSecond: measured };
        assert.equal(act.mode, 'active');
        assert.equal(f1.mode, 'idle');
        assert.ok(Number(f1.fps) < Number(act.fps), `idle fps ${f1.fps} < active ${act.fps}`);
        assert.ok(measured <= 18 && measured > 3, `idle frames/s measured ${measured}`);
        await H.shot('2-idle');
        return H.note(`active: mode ${act.mode} fps ${act.fps} → idle: mode ${f1.mode} fps ${f1.fps}; frames counted in 2 s idle: ${f0.frame} → ${f1.frame} (${measured}/s)`);
      }, page);

      await step(S, 'blinking: the blink expression shows up on its own', async () => {
        let hit = null;
        for (let i = 0; i < 200 && !hit; i++) { const d = await H.ds(); if (/(^|,)blink:/.test(d.expr)) hit = d; else await sleep(40); }
        assert.ok(hit, 'no blink within 8 s');
        await H.shot('3-blink');
        return H.note(`blink seen: data-expr ${hit.expr}`);
      }, page);

      await step(S, 'gaze: moving the cursor left / right moves the lookAt target', async () => {
        await page.mouse.move(box.x + 2, box.y + box.height * 0.2);
        await sleep(900);
        const gl = (await H.ds()).gaze;
        const tl = (await H.fig()).gaze;
        await H.shot('4-gaze-left');
        await page.mouse.move(box.x + box.width - 2, box.y + box.height * 0.2);
        await sleep(900);
        const gr = (await H.ds()).gaze;
        const tr = (await H.fig()).gaze;
        await H.shot('4-gaze-right');
        const x = (g) => Number(g.split(',')[0]);
        assert.ok(x(gl) < -0.3 && x(gr) > 0.3 && gl !== gr, `left ${gl} right ${gr}`);
        samples.gaze = { left: gl, right: gr, debugLeft: tl, debugRight: tr };
        await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.25);
        return H.note(`data-gaze cursor left ${gl} → right ${gr}; lookAt target left ${JSON.stringify(tl)} → right ${JSON.stringify(tr)}`);
      }, page);

      await step(S, '摸摸 (a click on her): pat → relaxed face, a nod', async () => {
        await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
        await rest();
        // a click reacts with pat or happy, never the same twice in a row (fx.pickClickReaction): click until pat
        const tried = [];
        let s = null;
        for (let i = 0; i < 3 && !(s && s.state === 'pat'); i++) { // a happy left over from before can be caught first: allow a few more clicks
          if (i) await rest();
          const b = await petBox();
          await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.45);
          s = await peak('pat', (x) => (x.state === 'pat' && /relaxed:/.test(x.expr) && x.motion.nodDown > 3) || (x.state === 'happy' && /happy:/.test(x.expr) && x.motion.hop > 0.2));
          tried.push(`${s.state}{${s.expr}; ${fmtMotion(s.motion)}}`);
        }
        await H.shot('5-pat');
        assert.equal(s.state, 'pat');
        assert.match(s.expr, /relaxed:/);
        assert.ok(s.motion.nodDown > 3, fmtMotion(s.motion));
        return H.note(`clicks → ${tried.join(' → ')}; pat: state ${s.state}, expr ${s.expr}, motion ${fmtMotion(s.motion)}`);
      }, page);

      await step(S, '拖起 (press and drag her): lifted → surprised face, dangling', async () => {
        await rest();
        const b = await petBox();
        const x0 = b.x + b.width / 2;
        const y0 = b.y + b.height * 0.45;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + i * 6, y0 - i * 3); await sleep(40); }
        const s = await peak('lifted', (x) => x.state === 'lifted' && /surprised:/.test(x.expr) && x.motion.dangle > 0.5);
        await H.shot('6-lifted');
        await page.mouse.up();
        assert.equal(s.state, 'lifted');
        assert.match(s.expr, /surprised:/);
        assert.ok(s.motion.dangle > 0.5, fmtMotion(s.motion));
        await sleep(600);
        const after = await H.ds();
        return H.note(`lifted: state ${s.state}, expr ${s.expr}, motion ${fmtMotion(s.motion)}; released → state ${after.state}`);
      }, page);

      await step(S, '喂食 (喂食 → a food): eating → happy face, chewing', async () => {
        await rest();
        await page.evaluate(() => window.pet.debugSet({ hunger: 60 }));
        await clickAct(page, 'feed');
        await page.click('#food-menu button');
        const s = await peak('feed', (x) => /^eat/.test(x.state) && /happy:/.test(x.expr) && x.motion.chew > 0.5, 3000);
        await H.shot('7-feed');
        assert.match(s.state, /^eat/);
        assert.match(s.expr, /happy:/);
        assert.ok(s.motion.chew > 0.5, fmtMotion(s.motion));
        return H.note(`feed: state ${s.state}, expr ${s.expr}, mouth ${s.mouth}, motion ${fmtMotion(s.motion)}`);
      }, page);

      await step(S, '玩耍: play → happy face, a spin', async () => {
        await page.waitForFunction(() => !/^eat/.test(window.petFx.state().state), null, { timeout: 8000 });
        await rest();
        await clickAct(page, 'play');
        const s = await peak('play', (x) => x.state === 'play' && /happy:/.test(x.expr) && x.motion.spin > 0.3, 3000);
        await H.shot('8-play');
        assert.equal(s.state, 'play');
        assert.match(s.expr, /happy:/);
        assert.ok(s.motion.spin > 0.3, fmtMotion(s.motion));
        return H.note(`play: state ${s.state}, expr ${s.expr}, motion ${fmtMotion(s.motion)}, root yaw ${s.root.yaw.toFixed(0)}°`);
      }, page);

      await step(S, '口型: her pat line (built-in voice pack audio) moves aa/ih/ou/ee/oh, back to 0 when it ends', async () => {
        await page.evaluate(() => window.pet.setPrefs({ voice: true }));
        await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return !sp || !/^(queued|synthesizing|playing|speaking)$/.test(sp.status); }, null, { timeout: 15000 }).catch(() => {});
        await rest();
        await sleep(1700); // past the speech gate
        const n0 = (await page.evaluate(() => window.petFx.offerLog())).length;
        const b = await petBox();
        await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.45);
        await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.45);
        await page.waitForFunction((n) => window.petFx.offerLog().slice(n).some((e) => e.kind === 'pat' && e.n), n0, { timeout: 15000 });
        await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return sp && sp.status === 'playing'; }, null, { timeout: 15000 });
        const mouths = [];
        let shotTaken = false;
        for (let i = 0; i < 120; i++) {
          const d = await H.ds();
          const sp = await page.evaluate(() => window.petFx.lastSpeech().status);
          mouths.push({ t: i * 50, lip: d.lip, mouth: d.mouth, status: sp });
          const open = Math.max(...d.mouth.split(',').map((p) => Number(p.split(':')[1])));
          if (!shotTaken && d.lip === 'audio' && open > 0.25) { await H.shot('9-lipsync'); shotTaken = true; }
          if (sp !== 'playing') break;
          await sleep(50);
        }
        const sp = await page.evaluate(() => window.petFx.lastSpeech());
        await page.waitForFunction(() => { const s = window.petFx.lastSpeech(); return s && s.status !== 'playing'; }, null, { timeout: 15000 });
        await sleep(700);
        const after = [];
        for (let i = 0; i < 5; i++) { const d = await H.ds(); after.push(`${d.lip}{${d.mouth}}`); await sleep(150); }
        samples.lipsync = { speech: { provider: sp.provider, status: sp.status, text: sp.text }, mouths, after };
        const playing = mouths.filter((m) => m.status === 'playing');
        const shapes = new Set();
        let maxOpen = 0;
        for (const m of playing) {
          const v = m.mouth.split(',').map((p) => p.split(':')).map(([k, x]) => [k, Number(x)]);
          for (const [k, x] of v) { if (x > 0.1) shapes.add(k); maxOpen = Math.max(maxOpen, x); }
        }
        assert.equal(sp.provider, 'pack', `the line came from her voice pack: ${sp.provider}`);
        assert.ok(playing.some((m) => m.lip === 'audio'), `lip modes ${[...new Set(playing.map((m) => m.lip))]}`);
        assert.ok(maxOpen > 0.2 && shapes.size >= 1, `max ${maxOpen}, shapes ${[...shapes]}`);
        assert.ok(after.every((a) => a === 'off{aa:0.00,ih:0.00,ou:0.00,ee:0.00,oh:0.00}'), after.join(' | '));
        await H.shot('9-lipsync-after');
        await page.evaluate(() => window.pet.setPrefs({ voice: false }));
        return H.note(`speech provider=${sp.provider} 「${sp.text}」; while playing (${playing.length} samples / 50 ms): shapes ${[...shapes].join(',')}, max ${maxOpen.toFixed(2)}; samples ${playing.filter((_, i) => i % 3 === 0).map((m) => `${m.lip}{${m.mouth}}`).join(' ')}\nafter: ${after.join(' | ')}`);
      }, page);

      await step(S, '18+ off: a VRM pack\'s adult outfit cannot be chosen (pack hidden, no adult card, equip refused)', async () => {
        // a hand-written 18+ VRM pack whose (homemade) model allows it, with the adult outfit maid
        const open = makeModel(ROOT, 'vrmadult', { name: 'E2E Adult Fish', meta: { authors: ['E2E Maker'], allowExcessivelySexualUsage: true } });
        const dir = path.join(open.dir, 'adult-pack');
        fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
        fs.copyFileSync(open.file, path.join(dir, 'models', 'a.vrm'));
        // one model per outfit: the same .vrm under two outfits would be one wardrobe entry
        fs.copyFileSync(open.file, path.join(dir, 'models', 'maid.vrm'));
        fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ schema: 2, id: 'vrm-e2e-adult', name: 'E2E Adult Fish', species: 'dafeiyu', kind: 'vrm', adult: true, vrm: { outfits: { daily: 'models/a.vrm', maid: 'models/maid.vrm' } } }));
        // and an all-ages pack that tries to dress maid: refused at import
        const sneaky = path.join(open.dir, 'sneaky-pack');
        fs.mkdirSync(path.join(sneaky, 'models'), { recursive: true });
        fs.copyFileSync(open.file, path.join(sneaky, 'models', 'a.vrm'));
        fs.writeFileSync(path.join(sneaky, 'pack.json'), JSON.stringify({ schema: 2, id: 'vrm-e2e-sneaky', name: 'Sneaky', species: 'dafeiyu', kind: 'vrm', vrm: { outfits: { daily: 'models/a.vrm', maid: 'models/a.vrm' } } }));
        const r1 = await page.evaluate((d) => window.pet.debugImportPack(d), dir);
        assert.equal(r1.ok, true, JSON.stringify(r1.errors));
        const r2 = await page.evaluate((d) => window.pet.debugImportPack(d), sneaky);
        const sneakyNote = r2.ok ? `imported without maid: ${JSON.stringify(r2)}`.slice(0, 200) : r2.errors.join(' / ');
        if (r2.ok) {
          const m = JSON.parse(fs.readFileSync(path.join(data, 'packs', 'vrm-e2e-sneaky', 'pack.json'), 'utf8'));
          assert.ok(!('maid' in m.vrm.outfits), 'an all-ages pack never keeps maid');
        } else assert.ok(r2.errors.some((e) => /adult outfit needs an 18\+ pack/.test(e)), r2.errors.join(' / '));
        const st = await page.evaluate(() => window.pet.getSettings());
        assert.equal(st.adultContent, false);
        // affection is not what holds it back: everything unlocked. The imported single model is one look, so
        // there is no wardrobe (衣柜 hidden) and the stage-up notice does not lead to one.
        await page.evaluate(() => window.pet.unlockAll('dafeiyu'));
        await page.waitForSelector('#unlock-toast:not(.hidden)', { timeout: 8000 });
        const toast = (await page.textContent('#toast-title')).trim();
        await H.shot('10a-unlock-toast');
        assert.notEqual(await page.evaluate(() => document.getElementById('toast-open').dataset.panel), 'wardrobe');
        await page.click('#toast-close');
        const cardsOf = () => page.$$eval('.card', (cs) => cs.map((c) => ({ id: c.dataset.outfit, label: c.querySelector('.nm').textContent, locked: c.classList.contains('locked'), adultTag: !!c.querySelector('.tag.adult') })));
        const wardrobeHidden = () => page.evaluate(() => document.getElementById('btn-wardrobe').classList.contains('hidden'));
        assert.equal(await wardrobeHidden(), true, 'one VRM model: no 衣柜');
        const view0 = await page.evaluate(async () => (await window.pet.boot()).view);
        assert.deepEqual(view0.outfits.map((x) => x.id), ['daily']);
        assert.equal(view0.outfits[0].label, '招牌女仆装');
        const cards = view0.outfits;
        const eq = await page.evaluate(() => window.pet.equipOutfit('maid'));
        assert.equal(eq.ok, false);
        const eqP = await page.evaluate(() => window.pet.equipOutfit('pajamas'));
        assert.equal(eqP.ok, false, 'no other outfit to change into');
        await H.shot('10b-single-look-no-wardrobe');
        await openCurrentPage(page);
        const listed = await page.$$eval('.pack-list .pack-opt', (os) => os.map((o) => o.dataset.pack));
        assert.ok(!listed.includes('vrm-e2e-adult'), listed.join(', '));
        assert.ok(listed.includes(ID), listed.join(', '));
        await page.locator('.pack-list').scrollIntoViewIfNeeded();
        await H.shot('10c-adult-off-packs');
        await page.click('#panel-close');
        const set = await page.evaluate(() => window.pet.setAppearance('vrm-e2e-adult', 'dafeiyu'));
        await sleep(500);
        const key = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
        assert.ok(!key.startsWith('vrm-e2e-adult/'), `look ${key}`);
        const unlocked = cards.filter((c) => !c.locked).length;
        // contrast: 18+ on → the 18+ VRM pack is offered and its adult outfit 性感女仆装 (成人向) can be worn; off again → gone
        await page.evaluate(() => window.pet.setAdult(true));
        await H.pickPack('vrm-e2e-adult');
        await clickAct(page, 'wardrobe');
        await page.waitForSelector('.card[data-outfit="maid"]:not(.locked)');
        const on = await cardsOf();
        const maidOn = on.find((c) => c.id === 'maid');
        assert.ok(maidOn && maidOn.label === '性感女仆装' && maidOn.adultTag, JSON.stringify(on));
        await page.click('.card[data-outfit="maid"]');
        await page.waitForSelector('.card.equipped[data-outfit="maid"]');
        await page.locator('.card[data-outfit="maid"]').scrollIntoViewIfNeeded();
        await H.shot('10d-adult-on-wardrobe-maid');
        await page.click('#panel-close');
        await page.evaluate(() => window.pet.setAdult(false));
        await page.waitForFunction(() => !document.getElementById('pet-look').dataset.key.includes('/maid') && !document.getElementById('pet-look').dataset.key.startsWith('vrm-e2e-adult/'), null, { timeout: 8000 });
        const keyOff = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
        // she leaves the 18+ pack for her default (2D) look, whose wardrobe is real: 衣柜 is back, without maid
        await clickAct(page, 'wardrobe');
        await page.waitForSelector('#panel:not(.hidden) .card');
        const off2 = await cardsOf();
        assert.ok(off2.length > 1, 'her 2D look has a wardrobe');
        assert.ok(!off2.some((c) => c.id === 'maid' || c.adultTag), JSON.stringify(off2));
        const eq2 = await page.evaluate(() => window.pet.equipOutfit('maid'));
        assert.equal(eq2.ok, false);
        await H.shot('10e-adult-off-again-wardrobe');
        await page.click('#panel-close');
        const contrast = `18+ on: ${on.map((c) => `${c.label}${c.adultTag ? '[成人向]' : ''}`).join('、')} → wore 性感女仆装; 18+ off again → look ${keyOff}, cards ${off2.map((c) => c.label).join('、')} (no 性感女仆装, no 成人向 tag), equipOutfit(maid) → ${eq2.reason}`;
        return H.note(`adult content off (all unlocked): 外观 lists ${listed.join(', ')} (no vrm-e2e-adult); setAppearance(vrm-e2e-adult) → ok=${set.ok} ${set.reason || ''}, look stays ${key}; toast 「${toast}」 (not to a wardrobe); 衣柜 hidden, outfits ${cards.map((c) => `${c.id}=${c.label}`).join('、')} (${unlocked} unlocked); equipOutfit(maid) → ${eq.reason}, equipOutfit(pajamas) → ${eqP.reason}; all-ages pack with maid → ${sneakyNote}\ncontrast — ${contrast}`);
      }, page);

      await step(S, 'back to dafeiyu-pixel: the 2D look draws, the VRM canvas is removed and the figure disposed', async () => {
        await H.pickPack('dafeiyu-pixel');
        await page.waitForFunction(() => !document.querySelector('#pet-look canvas.vrm') && window.PetVRM.stats.live === 0, null, { timeout: 8000 });
        const st = await page.evaluate(() => ({ stats: window.PetVRM.stats, el: document.querySelector('#pet-look').firstElementChild.outerHTML.slice(0, 100), key: document.getElementById('pet-look').dataset.key }));
        assert.ok(st.key.startsWith('dafeiyu-pixel/'));
        assert.ok(st.stats.disposed >= 1);
        await sleep(500);
        await H.shot('11-back-to-2d');
        return H.note(`2D: look ${st.key}, element ${st.el}; PetVRM.stats ${JSON.stringify({ created: st.stats.created, disposed: st.stats.disposed, live: st.stats.live })}`);
      }, page);

      await step(S, 'and to the VRM again: a new figure draws', async () => {
        await H.pickPack(ID);
        await H.drawing(2);
        const a = await H.ds();
        await sleep(800);
        const b = await H.ds();
        const st = await page.evaluate(() => window.PetVRM.stats);
        assert.ok(Number(b.frame) > Number(a.frame));
        assert.equal(st.live, 1);
        assert.equal(st.created, st.disposed + 1);
        await H.shot('12-vrm-again');
        return H.note(`VRM again: frame ${a.frame} → ${b.frame}; stats created ${st.created}, disposed ${st.disposed}, live ${st.live}`);
      }, page);

      await step(S, 'packaging guard: no .vrm / .vrma in git ls-files nor in the files package.json build.files ships', async () => {
        const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.vrma?$/i.test(f));
        assert.deepEqual(tracked, []);
        const build = require('../package.json').build.files;
        assert.ok(build.includes('!**/*.vrm') && build.includes('!**/*.VRM') && build.includes('!**/*.vrma') && build.includes('!**/*.VRMA'), JSON.stringify(build));
        // what build.files matches on disk (src/**/*, package.json), before the exclusions
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
        const shipped = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'package.json')];
        const vrms = shipped.filter((f) => /\.vrma?$/i.test(f));
        assert.deepEqual(vrms, []);
        const models = [model.file];
        assert.ok(models.every((f) => path.relative(ROOT, f).startsWith('..')));
        return H.note(`git ls-files: ${tracked.length} .vrm/.vrma; build.files ${JSON.stringify(build)}; ${shipped.length} files under the build globs, ${vrms.length} .vrm/.vrma; the test model was at ${model.file} (outside the repo)`);
      });

      await step(S, 'no renderer error on the page', async () => {
        assert.deepEqual(realErrors(errors), []);
      });
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'vrm-log.txt'), `${evidence.join('\n\n')}\n`);
      fs.writeFileSync(path.join(SHOTS, 'vrm-samples.json'), `${JSON.stringify(samples, null, 2)}\n`);
      await app.close().catch(() => {});
    }
  }

  // ------------------------------------------------------------------ vrmframe
  // Where her opaque pixels are in the VRM canvas (0..1 of the canvas): read back from the WebGL drawing buffer.
  const composition = (page) => page.evaluate(() => {
    const c = document.querySelector('#pet-look canvas.vrm');
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
  });

  async function vrmFraming() {
    const S = 'vrmframe';
    const { data, env } = dataDir('vrmframe', { prefs: { roam: false } }); // she stays put: window bounds are compared
    const model = makeModel(ROOT, 'vrmframe');
    // real models on this machine (never in the repo: their licenses do not allow redistribution): a list split by ':'
    const realFiles = (process.env.PIXELPET_E2E_REAL_VRM || [path.join(os.homedir(), 'art-archive', 'vrm-test', 'extracted', 'model.vrm'), path.join(os.homedir(), 'art-archive', 'airi-vrm-test', 'AvatarSample_A.vrm')].join(path.delimiter)).split(path.delimiter).filter((f) => f && fs.existsSync(f));
    for (const f of realFiles) { const rel = path.relative(ROOT, f); assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `a real model must stay outside the repository: ${f}`); }
    const real = realFiles.length > 0;
    const evidence = [];
    let { app, page } = await launch(env, { args: ['--autoplay-policy=no-user-gesture-required'] });
    let errors = watchErrors(page);
    let H = helpers(page, 'frame', evidence);
    let admin = null;
    let testId = null;
    let realId = null;
    const fullCam = {};
    const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    const petBox = () => page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
    const canvasBox = () => page.locator('#pet-look canvas.vrm').boundingBox();
    const settled = (mode) => page.waitForFunction((m) => { const c = document.querySelector('#pet-look canvas.vrm'); const f = window.petFx.vrm(); return c && c.dataset.framing === m && f && f.figures[0] && !f.figures[0].gliding; }, mode, { timeout: 15000 });
    const rest = async () => { await page.waitForFunction(() => { const s = window.petFx.state(); return s && /^(idle|walk|sit|bored)$/.test(s.state); }, null, { timeout: 15000 }).catch(() => {}); await sleep(400); };
    const adminToast = (re) => admin.waitForFunction((src) => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, { timeout: 8000 });
    const adminShot = async (name) => { await sleep(200); await admin.screenshot({ path: path.join(SHOTS, `frame-${name}.png`) }); return `vrm/frame-${name}.png`; };
    // 设置窗口 → 桌宠行为 → 大小与取景 → 取景: click 全身 / 半身 as the owner does
    const pickGlobal = async (label) => {
      await admin.evaluate(() => { location.hash = '/behavior'; });
      await admin.waitForSelector('[data-path="/behavior"] [data-key="prefs.framing"]');
      await admin.locator('[data-key="prefs.framing"]').getByText(label, { exact: true }).click();
      await adminToast(new RegExp(`已保存：取景 → ${label}`));
    };
    // the glide: camera samples while switching (distance and height move one way, the figure is not rebuilt)
    const glideSamples = async (ms = 700) => {
      const out = [];
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = (await page.evaluate(() => window.petFx.vrm())).figures[0];
        out.push({ t: Date.now() - t0, z: f.camera.z, y: f.camera.y, gliding: f.gliding, frame: f.frame, loaded: f.loaded });
        await sleep(30);
      }
      return out;
    };
    const monotonic = (xs) => xs.every((v, i) => i === 0 || (v - xs[i - 1]) * Math.sign(xs[xs.length - 1] - xs[0]) >= -1e-6);
    try {
      await step(S, 'hatching 大肥鱼; the homemade VRM (outside the repo) is imported and worn; 取景 default 全身', async () => {
        await H.hatch();
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file);
        const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
        assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
        testId = imp.pack.id;
        await H.pickPack(testId); // 外观: wear it, as the owner does
        await H.drawing(5);
        await settled('full');
        const st = await page.evaluate(() => window.pet.getSettings());
        assert.equal(st.prefs.framing, 'full');
        assert.deepEqual(st.framings, {});
        return H.note(`imported ${testId}; prefs.framing=${st.prefs.framing}, framings=${JSON.stringify(st.framings)}`);
      }, page);

      await step(S, '全身 (homemade model): head to feet, feet on the floor, centred — screenshot', async () => {
        await rest();
        await page.mouse.move(5, 5);
        const f = await H.fig();
        const c = await composition(page);
        fullCam.test = f.camera;
        fullCam.bounds = await petBounds(app);
        fullCam.canvas = await canvasBox();
        fullCam.comp = c;
        const shot = await H.shot('1-test-full');
        assert.equal((await H.ds()).framing, 'full');
        assert.ok(c.bottom > 0.95 && c.top > 0.03 && c.height < 0.97, `feet on the bottom, air above: ${JSON.stringify(c)}`);
        return H.note(`${shot}: data-framing=full; opaque box ${JSON.stringify(c)}; camera ${JSON.stringify(f.camera)}; window ${JSON.stringify(fullCam.bounds)}; band (measured, unused) ${JSON.stringify(f.band)}`);
      }, page);

      await step(S, '设置窗口 → 桌宠行为 → 大小与取景: the 取景 control (全身 / 半身, 立即生效) next to 宠物大小', async () => {
        admin = await openAdminWindow(app, page, 'behavior');
        await admin.waitForSelector('[data-path="/behavior"] [data-key="prefs.framing"]');
        const card = await admin.evaluate(() => { const el = document.querySelector('[data-key="prefs.framing"]'); let p = el; for (let i = 0; i < 12 && p; i++) { if (p.textContent.includes('宠物大小') && p.textContent.includes('大小与取景')) return p.textContent.replace(/\s+/g, ' ').slice(0, 400); p = p.parentElement; } return null; });
        assert.ok(card && /取景/.test(card) && /立即生效/.test(card), card);
        const shot = await adminShot('2-admin-behavior-full');
        return H.note(`${shot}: card text 「${card}」`);
      }, page);

      await step(S, '后台切到 半身: the pet window re-frames at once — head to waist, centred, bigger, same window (right-bottom anchor)', async () => {
        const before = await page.evaluate(() => window.petFx.vrm().stats);
        await pickGlobal('半身');
        const glide = await glideSamples(600);
        await settled('half');
        await rest();
        await page.mouse.move(5, 5);
        const f = await H.fig();
        const c = await composition(page);
        const b = await petBounds(app);
        const after = await page.evaluate(() => window.petFx.vrm().stats);
        const shot = await H.shot('3-test-half');
        await adminShot('3-admin-behavior-half');
        assert.equal(saved().prefs.framing, 'half', 'saved in settings.json');
        assert.equal(f.band.source, 'bones', 'the band comes from the humanoid bones');
        assert.deepEqual(b, fullCam.bounds, 'the window keeps its size and its right-bottom corner');
        assert.ok(f.camera.z < fullCam.test.z * 0.75, `the camera came closer: ${fullCam.test.z} → ${f.camera.z}`);
        assert.ok(c.bottom > 0.98, `she is cut at the bottom edge (waist): ${JSON.stringify(c)}`);
        assert.ok(c.top < 0.12, `her head near the top: ${JSON.stringify(c)}`);
        assert.ok(Math.abs(c.cx - 0.5) < 0.08, `centred: ${JSON.stringify(c)}`);
        assert.ok(c.fill > fullCam.comp.fill * 1.4, `she is drawn bigger: fill ${fullCam.comp.fill} → ${c.fill}`);
        assert.equal(after.created, before.created, 'the figure was not rebuilt (no reload, no T-pose)');
        const zs = glide.map((g) => g.z);
        assert.ok(monotonic(zs), `the camera glides one way: ${zs.map((z) => z.toFixed(2)).join(' ')}`);
        assert.ok(glide.every((g) => g.loaded), 'the model stays loaded during the glide');
        return H.note(`${shot}: data-framing=half, data-cut=${(await H.ds()).cut}, band ${JSON.stringify(f.band)}; opaque box ${JSON.stringify(c)} (full: ${JSON.stringify(fullCam.comp)}); camera z ${fullCam.test.z.toFixed(3)} → ${f.camera.z.toFixed(3)}, y ${fullCam.test.y.toFixed(3)} → ${f.camera.y.toFixed(3)}; window ${JSON.stringify(b)} (unchanged); figures created ${before.created} → ${after.created}; glide z ${zs.map((z) => z.toFixed(2)).join(' → ')}`);
      }, page);

      await step(S, '半身: gaze still follows the cursor left / right', async () => {
        const box = await canvasBox();
        await page.mouse.move(box.x + 2, box.y + box.height * 0.2);
        await sleep(900);
        const gl = (await H.ds()).gaze;
        await page.mouse.move(box.x + box.width - 2, box.y + box.height * 0.2);
        await sleep(900);
        const gr = (await H.ds()).gaze;
        const shot = await H.shot('4-half-gaze-right');
        const x = (g) => Number(g.split(',')[0]);
        assert.ok(x(gl) < -0.3 && x(gr) > 0.3, `left ${gl} right ${gr}`);
        return H.note(`${shot}: data-gaze left ${gl} → right ${gr}`);
      }, page);

      await step(S, '半身: touch zones map onto her upper body — head / chest / belly reachable, the bottom of the picture is not legs / feet', async () => {
        const box = await canvasBox();
        const probe = async (fx, fy) => page.evaluate(([x, y]) => window.petFx.touchPoint(x, y), [box.x + box.width * fx, box.y + box.height * fy]);
        const rows = [];
        const zones = new Set();
        for (const fy of [0.08, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.97]) {
          const p = await probe(0.5, fy);
          rows.push(`y=${fy}: ${p ? `${p.zone || '-'} (y_full=${p.y.toFixed(2)}, ${p.framing})` : 'off'}`);
          if (p && p.zone) zones.add(p.zone);
        }
        assert.ok(!zones.has('legs') && !zones.has('feet'), [...zones].join(','));
        assert.ok(zones.has('head') || zones.has('face'), [...zones].join(','));
        assert.ok(zones.has('chest') || zones.has('belly'), [...zones].join(','));
        const p = await probe(0.5, 0.97);
        assert.equal(p.framing, 'half');
        return H.note(`touchPoint down the middle of the half-body picture: ${rows.join('; ')}`);
      }, page);

      await step(S, '半身: 摸摸 (a click) → pat / happy reaction; 拖起 (press and drag) → lifted, she dangles; released back', async () => {
        await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
        await rest();
        let s = null;
        const tried = [];
        for (let i = 0; i < 3 && !(s && s.state === 'pat'); i++) {
          if (i) await rest();
          const b = await petBox();
          await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.45);
          const t0 = Date.now();
          while (Date.now() - t0 < 2500) { s = await H.ds(); if (s.state === 'pat' || s.state === 'happy') break; await sleep(60); }
          tried.push(s.state);
        }
        await H.shot('5-half-pat');
        assert.ok(['pat', 'happy'].includes(s.state), tried.join('→')); // a click is pat or happy (fx.pickClickReaction)
        await rest();
        const b = await petBox();
        const x0 = b.x + b.width / 2;
        const y0 = b.y + b.height * 0.45;
        const w0 = await petBounds(app);
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + i * 6, y0 - i * 3); await sleep(40); }
        let l = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) { l = await H.ds(); if (l.state === 'lifted') break; await sleep(60); }
        const shot = await H.shot('6-half-lifted');
        await page.mouse.up();
        assert.equal(l.state, 'lifted');
        assert.equal(l.framing, 'half', 'still 半身 while dragged');
        await sleep(800);
        await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
        const w1 = await petBounds(app);
        return H.note(`${shot}: clicks → ${tried.join(' → ')}; drag → state ${l.state} (expr ${l.expr}), framing ${l.framing}; window ${w0.x},${w0.y} → ${w1.x},${w1.y}`);
      }, page);

      await step(S, '半身: 口型 — her pat line (voice pack audio) opens the mouth, back to 0 after', async () => {
        await page.evaluate(() => window.pet.setPrefs({ voice: true }));
        await rest();
        await sleep(1700);
        // a click is pat or happy (they alternate); click until one of her interaction lines is playing
        let playing = false;
        for (let i = 0; i < 4 && !playing; i++) {
          if (i) { await rest(); await sleep(1700); }
          const b = await petBox();
          await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.45);
          await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.45);
          playing = await page.waitForFunction(() => { const sp = window.petFx.lastSpeech(); return sp && sp.status === 'playing'; }, null, { timeout: 8000 }).then(() => true, () => false);
        }
        assert.ok(playing, 'an interaction line played');
        let maxOpen = 0;
        let shot = null;
        const lips = new Set();
        for (let i = 0; i < 120; i++) {
          const d = await H.ds();
          lips.add(d.lip);
          const open = Math.max(...d.mouth.split(',').map((p) => Number(p.split(':')[1])));
          maxOpen = Math.max(maxOpen, open);
          if (!shot && d.lip === 'audio' && open > 0.25) shot = await H.shot('7-half-lipsync');
          if ((await page.evaluate(() => window.petFx.lastSpeech().status)) !== 'playing') break;
          await sleep(50);
        }
        await page.waitForFunction(() => { const s = window.petFx.lastSpeech(); return s && s.status !== 'playing'; }, null, { timeout: 15000 });
        await sleep(700);
        const after = (await H.ds()).mouth;
        await page.evaluate(() => window.pet.setPrefs({ voice: false }));
        assert.ok(lips.has('audio') && maxOpen > 0.2, `lip ${[...lips]} max ${maxOpen}`);
        assert.equal(after, 'aa:0.00,ih:0.00,ou:0.00,ee:0.00,oh:0.00');
        return H.note(`${shot}: lip modes ${[...lips].join(',')}, max mouth ${maxOpen.toFixed(2)}; after: ${after}`);
      }, page);

      await step(S, '后台切回 全身: the first camera and composition again, the window unchanged', async () => {
        const b0 = await petBounds(app); // (the drag moved the window)
        await pickGlobal('全身');
        const glide = await glideSamples(600);
        await settled('full');
        await rest();
        await page.mouse.move(5, 5);
        const f = await H.fig();
        const c = await composition(page);
        const b = await petBounds(app);
        const shot = await H.shot('8-test-full-again');
        const d = (k) => Math.abs(f.camera[k] - fullCam.test[k]);
        assert.ok(d('x') < 1e-6 && d('y') < 1e-6 && d('z') < 1e-6, `camera ${JSON.stringify(f.camera)} vs ${JSON.stringify(fullCam.test)}`);
        assert.deepEqual(b, b0, 'the window keeps its size and place');
        assert.equal(saved().prefs.framing, 'full');
        const zs = glide.map((g) => g.z);
        assert.ok(monotonic(zs), zs.join(' '));
        return H.note(`${shot}: data-framing=full; camera ${JSON.stringify(f.camera)} = the first one; opaque box ${JSON.stringify(c)} (first: ${JSON.stringify(fullCam.comp)}); glide z ${zs.map((z) => z.toFixed(2)).join(' → ')}`);
      }, page);

      await step(S, '她的页 → 形象包 → 取景: her own 半身 wins over the global 全身; 跟随全局 goes back', async () => {
        await admin.evaluate(() => { location.hash = '/characters/dafeiyu'; });
        await admin.waitForSelector('[data-framing-row="dafeiyu"]', { timeout: 10000 });
        await admin.locator('[data-framing-row="dafeiyu"]').getByText('半身', { exact: true }).click();
        await adminToast(/的取景已改为「半身」/);
        await settled('half');
        const shotA = await adminShot('9-admin-character-half');
        const s1 = saved();
        assert.deepEqual(s1.framings, { dafeiyu: 'half' });
        assert.equal(s1.prefs.framing, 'full');
        const fr = await page.evaluate(() => window.petFx.framing());
        assert.deepEqual([fr.mode, fr.source], ['half', 'character']);
        await admin.locator('[data-framing-row="dafeiyu"]').getByText(/跟随全局/).click();
        await adminToast(/的取景已改为「跟随全局（全身）」/);
        await settled('full');
        assert.deepEqual(saved().framings, {});
        return H.note(`${shotA}: framings ${JSON.stringify(s1.framings)} with prefs.framing ${s1.prefs.framing} → pet ${fr.mode} (source ${fr.source}); 跟随全局 → framings {} → pet full`);
      }, page);

      for (const [ri, realFile] of realFiles.entries()) {
        await step(S, `a real VRM (${path.basename(realFile)}, local file, not in the repo): 全身 and 半身 screenshots`, async () => {
          await page.evaluate(() => window.pet.setPrefs({ framing: 'full' })); // start each model from 全身
          await page.evaluate((x) => window.pet.debugNextOpen(x), realFile);
          const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
          assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
          realId = imp.pack.id;
          await H.pickPack(realId);
          await H.drawing(5, 60000);
          await settled('full');
          await rest();
          await page.mouse.move(5, 5);
          const cf = await composition(page);
          const ff = await H.fig();
          const shotF = await H.shot(`10-real${ri + 1}-full`);
          await pickGlobal('半身');
          await settled('half');
          await rest();
          await page.mouse.move(5, 5);
          const ch = await composition(page);
          const fh = await H.fig();
          const shotH = await H.shot(`11-real${ri + 1}-half`);
          assert.equal(fh.band.source, 'bones');
          assert.ok(ch.bottom > 0.98 && ch.top < 0.12 && Math.abs(ch.cx - 0.5) < 0.1, JSON.stringify(ch));
          assert.ok(fh.band.cut < 0.85 && fh.band.bottom > ff.size.minY + ff.size.h * 0.1, `the band is her upper body, not her whole height: ${JSON.stringify(fh.band)}`);
          assert.ok(fh.camera.z < ff.camera.z * 0.9, `closer: ${ff.camera.z} → ${fh.camera.z}`); // a chibi's wide head limits how close
          assert.ok(ch.fill > cf.fill * 1.2, `drawn bigger: fill ${cf.fill} → ${ch.fill}`);
          return H.note(`${shotF}: full opaque box ${JSON.stringify(cf)}, camera z ${ff.camera.z.toFixed(3)} (VRM ${(await H.ds()).vrm})\n${shotH}: half opaque box ${JSON.stringify(ch)}, camera z ${fh.camera.z.toFixed(3)}, band ${JSON.stringify(fh.band)} (${imp.pack.name})`);
        }, page);
      }
      if (!real) evidence.push('no real VRM on this machine (PIXELPET_E2E_REAL_VRM): the real-model step was skipped');

      await step(S, 'a restart keeps 半身: settings.json prefs.framing=half, the pet starts framed head to waist', async () => {
        if (!real) await pickGlobal('半身');
        assert.equal(saved().prefs.framing, 'half');
        await app.close();
        ({ app, page } = await launch(env, { args: ['--autoplay-policy=no-user-gesture-required'] }));
        errors = watchErrors(page);
        H = helpers(page, 'frame', evidence);
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await H.drawing(5, 60000);
        await settled('half');
        await rest();
        await page.mouse.move(5, 5);
        const c = await composition(page);
        const st = await page.evaluate(() => window.pet.getSettings());
        const shot = await H.shot('12-after-restart-half');
        assert.equal(st.prefs.framing, 'half');
        assert.ok(c.bottom > 0.98 && c.top < 0.12, JSON.stringify(c));
        return H.note(`${shot}: after restart prefs.framing=${st.prefs.framing}, data-framing=${(await H.ds()).framing}, opaque box ${JSON.stringify(c)}`);
      }, page);

      await step(S, 'no renderer error on the page', async () => {
        const real = realErrors(errors);
        assert.deepEqual(real, []);
        return H.note('no console errors');
      }, page);
    } finally {
      fs.writeFileSync(path.join(SHOTS, 'frame-evidence.txt'), evidence.join('\n\n'));
      await app.close().catch(() => {});
    }
  }

  return { vrmScenario, vrmImport, vrmFraming };
};
