'use strict';

// VRM e2e scenarios (run.js `vrm` / `vrmimport`), kept out of run.js because it is already over the size
// limit. The model is a homemade VRM 1.0 made on the spot by scripts/make-test-vrm.js (boxes, the humanoid
// skeleton, 18 preset expressions incl. blink/happy/aa/ih/ou/ee/oh, SpringBone tail + ahoge) and written to a
// temp dir: no third-party model is used, and no .vrm is ever written inside the repository. Its meta is
// made restrictive (allowRedistribution=false, modification=prohibited, creditNotation=required) so the
// app's limits show. Drawn by the real three-vrm renderer under SwiftShader (run.js launches Electron with
// --enable-unsafe-swiftshader --ignore-gpu-blocklist).
//
//   vrmimport  settings window → her page → 装扮 → 导入 VRM… → 导入确认 (author, license, restrictions); 取消导入
//              removes the pack; 使用这个模型 → the user pack, its card (credit, 导出已禁用) and 授权信息; 外观资源
//              keeps 导出 disabled; the model copied into userData only; drawn on the desk.
//   vrm        wearing it with a homemade motion library (scripts/make-test-vrma.js in <userData>/vrm-motions):
//              the canvas draws, data-library loaded, idle frame budget, the idle schedule (≥ 3 variants, no
//              repeat), the 姿势 menu (cross-fade, saved), blinking, gaze; 摸摸 / 拖起 / 喂食 / 玩耍 through the UI
//              act out VRM's own way (faces, holds; no pixel moves, no CSS animation on the canvas); male / female
//              style; no library → still draws; an interaction
//              line from her voice pack moving aa/ih/ou/ee/oh and back to 0; the reaction layer (T-2681):
//              touch zones hit on the 3D skeleton, every reaction by a real click / drag / chat (clip laid over
//              the base, face, gaze, back to the idle), the streak escalation happy → annoyed → angry, an
//              interrupted reaction fading under the next, holds for lift / think / talk / eat, never a T-pose; 18+ off keeps a VRM pack's adult
//              outfit out of reach; back to dafeiyu-pixel and to the VRM again; no .vrm in git or the build.
//   vrmframe   取景 (半身模式, docs/half-body-mode.md): 全身 → 设置窗口 桌宠行为 → 取景 → 半身 → only head to waist,
//              centred, bigger, same window; the camera glides (no reload, no T-pose); gaze, 摸摸 (touch zones
//              mapped, legs out of reach), 拖起, 口型 in 半身; back to 全身 = the first camera again; her own
//              取景 on her page; a real VRM too (PIXELPET_E2E_REAL_VRM=<file.vrm>, never copied into the repo);
//              a restart keeps 半身.
//   vrmdance   跳舞 (docs/vrm-dance.md §7.3): a homemade dance library (scripts/make-test-dance.js) in
//              <userData>/vrm-dances and the local API on; pixel → 409 not-vrm with the reason; VRM → cueing → on
//              on the dance layer alone (weights 1), the music as the clock (drift), the retargeted pose on the
//              model (A-pose, arms level, squat), stage limit and framing, mute / volume, lifted, touched, talking,
//              hidden, the end (out → off), the loop, Esc / API stop, 喂食 and another look stopping it, a dance
//              without music and the built-in demo; no console / CSP errors, nothing new in the repository. Records
//              a video (out/e2e/vrm/vrmdance.webm) with chapters (vrmdance-evidence.json).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const { makeTestVrm } = require('../scripts/make-test-vrm');
const { writeTestLibrary, ARM, LEFT_ARM } = require('../scripts/make-test-vrma');

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
  function dataDir(tag, settings, { motions = false } = {}) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${tag}-`));
    // a homemade motion library (scripts/make-test-vrma.js) where the app looks for one: <userData>/vrm-motions
    if (motions) writeTestLibrary(path.join(data, 'vrm-motions'));
    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), `pp-${tag}fake-`));
    fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
    fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, ...settings }));
    return { data, env: { PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir } };
  }
  // The settings window (T-2718: the pet window keeps only ⚙): opened from ⚙, driven by evaluate — it sits
  // behind the always-on-top pet and gets few frames, so waits poll instead of waitFor*.
  function adminOf(app, page) {
    let w = null;
    const until = async (fn, arg, ms = 15000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        if (await w.evaluate(fn, arg).catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`settings window: timed out waiting for ${what}`);
        await sleep(150);
      }
    };
    const open = async () => {
      if (w && !w.isClosed()) return w;
      await clickAct(page, 'settings');
      for (let i = 0; i < 200 && !(w = app.windows().find((x) => x.url().includes('admin-ui'))); i++) await sleep(100);
      if (!w) throw new Error('the settings window did not open');
      await until(() => !!document.querySelector('[data-admin-page]'), null, 20000, 'the console');
      return w;
    };
    const go = async (route) => {
      await open();
      await w.evaluate((x) => { location.hash = x; }, route);
      await until((x) => !!document.querySelector(`[data-path="${x}"]`), route, 15000, route);
      await sleep(300);
    };
    // her page → 装扮 (衣柜 cards, 取景, VRM 姿势, 角色包, 导入新角色). `id` is a character id (T-2764: every
    // look is a character of her own); a base id (`dafeiyu`) opens the current character of that base.
    const lookTab = async (id) => {
      await go(`/characters/${id}`);
      await w.evaluate(() => { const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent.trim() === '装扮'); if (t) t.click(); });
      await until(() => !!document.querySelector('[data-import-row]'), null, 10000, '装扮');
    };
    const click = (sel) => w.evaluate((x) => { const el = document.querySelector(x); if (!el) throw new Error(`no ${x}`); el.scrollIntoView({ block: 'center' }); el.click(); }, sel);
    const text = (sel) => w.evaluate((x) => { const el = document.querySelector(x); return el ? el.textContent : null; }, sel);
    const modalButton = (label) => w.evaluate((t) => { const b = [...document.querySelectorAll('[role="dialog"] button')].filter((x) => x.textContent.trim() === t).pop(); if (!b) throw new Error(`no dialog button ${t}`); b.click(); }, label);
    const toastSeen = (re) => until((src) => [...document.querySelectorAll('li, div')].some((el) => el.childElementCount < 6 && new RegExp(src).test(el.textContent || '')), re.source, 10000, `toast ${re}`);
    const shot = async (file) => { await w.bringToFront().catch(() => {}); await sleep(250); await w.screenshot({ path: file }); };
    return { open, go, lookTab, click, text, modalButton, toastSeen, until, shot, get win() { return w; } };
  }
  function helpers(page, prefix, evidence, app) {
    const shot = async (name) => { await sleep(120); await page.screenshot({ path: path.join(SHOTS, `${prefix}-${name}.png`) }); return `vrm/${prefix}-${name}.png`; };
    const A = adminOf(app, page);
    const adminShot = async (name) => { await A.shot(path.join(SHOTS, `${prefix}-${name}.png`)); return `vrm/${prefix}-${name}.png`; };
    const ds = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c ? { ...c.dataset } : null; });
    const fig = async () => { const d = await page.evaluate(() => window.petFx.vrm()); return d && d.figures[0]; };
    const note = (s) => { evidence.push(s); return s; };
    const hatch = async () => {
      await page.waitForSelector('.char-card', { timeout: 20000 });
      await page.click('.char-card[data-character="dafeiyu-pixel"]'); // one card per character (T-2764)
      await page.fill('#pet-name', 'Mow');
      await page.click('#hatch-btn');
      await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
      await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
      await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily', null, { timeout: 10000 });
    };
    // settings window → 角色图鉴 → her page → 切换, as a user does (T-2764: there is no 形象包 to put on, every
    // pack is a character of her own); waits until the pet window wears that character
    const switchTo = async (id) => {
      await A.go(`/characters/${id}`);
      await A.until((x) => !!document.querySelector(`[data-character-title="${x}"]`), id, 10000, `her page ${id}`);
      if (!(await A.win.evaluate((x) => !!document.querySelector(`[data-current="${x}"]`), id))) await A.click(`[data-switch="${id}"]`);
      await A.until((x) => !!document.querySelector(`[data-current="${x}"]`), id, 15000, `${id} current`);
      await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), id, { timeout: 10000 }).catch(async () => { throw new Error(`switchTo(${id}): pet look stays ${await page.getAttribute('#pet-look', 'data-key')}`); });
    };
    const drawing = (n = 2, timeout = 30000) => page.waitForFunction((k) => { const c = document.querySelector('#pet-look canvas.vrm'); return c && Number(c.dataset.frame) > k; }, n, { timeout });
    return { shot, adminShot, A, ds, fig, note, hatch, switchTo, drawing };
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
    const H = helpers(page, 'vrmimport', evidence, app);
    const A = H.A;
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

      const userVrmPacks = () => (fs.existsSync(path.join(data, 'packs')) ? fs.readdirSync(path.join(data, 'packs')).filter((d) => d.startsWith('vrm-')) : []);
      const importOnce = async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file); // answers the system file dialog
        await A.click('[data-import-vrm]');
        await A.until(() => !!document.querySelector('[data-vrm-confirm]'), null, 20000, '导入确认');
        await sleep(400);
      };

      // 角色图鉴 as the console has it (main's roster): one row per character
      const rosterIds = async () => (await A.win.evaluate(async () => (await window.petAdmin.state()).roster.map((r) => r.id)));

      await step(S, '设置窗口 → 她的页 → 装扮 → 导入 VRM 角色…: 导入确认 shows author, license and the restrictions', async () => {
        await A.lookTab('dafeiyu-pixel');
        assert.equal((await A.text('[data-import-vrm]')).trim(), '导入 VRM 角色…');
        await importOnce();
        const t = await A.win.evaluate(() => document.querySelector('[data-vrm-confirm]').closest('[role="dialog"]').textContent);
        for (const x of [`导入 VRM 模型「${MODEL_NAME}」`, '作者E2E Maker', '版权© E2E Maker', '谁可以扮演仅作者本人', '商用仅限个人非商业使用', '再分发不允许', '修改禁止修改', '署名需要署名', '授权条款https://vrm.dev/licenses/1.0/', '取消导入', '使用这个模型']) assert.ok(t.includes(x), `missing: ${x}`);
        const rs = await A.win.evaluate(() => [...document.querySelectorAll('[data-vrm-confirm] [data-vrm-restrictions] li')].map((l) => `${l.dataset.id}: ${l.textContent.trim()}`));
        for (const id of ['no-redistribution', 'no-modification', 'credit-required']) assert.ok(rs.some((r) => r.startsWith(`${id}:`)), `restriction ${id}: ${rs.join(' | ')}`);
        assert.match(t, /不可再分发：仅限本机使用/);
        await H.adminShot('1-confirm');
        return H.note(`导入确认 restrictions: ${rs.join(' | ')}`);
      }, () => A.win);

      await step(S, '取消导入 removes the pack again: nothing left in userData, no new character, nothing switched', async () => {
        const before = userVrmPacks();
        assert.equal(before.length, 1, `the import made one pack: ${before}`);
        await A.modalButton('取消导入');
        await A.toastSeen(/已取消导入「E2E 自制小鱼」，模型没有留在本机/);
        for (let i = 0; i < 50 && userVrmPacks().length; i++) await sleep(100);
        assert.deepEqual(userVrmPacks(), []);
        const ids = await rosterIds();
        assert.equal(ids.filter((x) => x.startsWith('vrm-')).length, 0, `no VRM character in 角色图鉴: ${ids.join(', ')}`);
        assert.equal(await A.win.evaluate(() => document.querySelectorAll('[data-pack^="vrm-"], [data-current^="vrm-"]').length), 0);
        assert.match(await page.getAttribute('#pet-look', 'data-key'), /^dafeiyu-pixel\//);
        await H.adminShot('1b-canceled');
        return H.note(`取消导入: ${before[0]} removed; 角色图鉴 ${ids.length} characters, none vrm-*; pet still ${await page.getAttribute('#pet-look', 'data-key')}`);
      }, () => A.win);

      await step(S, '使用这个模型: the import becomes a character of her own (角色图鉴 row, her page, current); 角色包 card shows VRM · 作者, the credit line and 导出已禁用; her 衣柜 is a card list she can dress from', async () => {
        await importOnce();
        await A.modalButton('使用这个模型');
        await A.toastSeen(new RegExp(`已导入 VRM 模型「${MODEL_NAME}」，成为新角色（作者：E2E Maker）`));
        await page.waitForFunction(() => (document.getElementById('pet-look').dataset.key || '').startsWith('vrm-'), null, { timeout: 20000 });
        ID = (await page.getAttribute('#pet-look', 'data-key')).split('/')[0];
        // she is a new character: her own page opens, she is 当前角色, and 角色图鉴 lists her next to 大肥鱼 · 像素
        await A.until((x) => location.hash === `#/characters/${x}` && !!document.querySelector(`[data-current="${x}"]`), ID, 15000, 'her own page, current');
        const ids = await rosterIds();
        assert.ok(ids.includes(ID) && ids.includes('dafeiyu-pixel'), `角色图鉴: ${ids.join(', ')}`);
        const view = await page.evaluate(async () => (await window.pet.boot()).view);
        assert.equal(view.pet.characterId, ID, 'the pet window is her');
        const me = view.characters.find((c) => c.id === ID);
        assert.ok(me && me.base === 'dafeiyu' && me.kind === 'vrm' && me.source === 'user', JSON.stringify(me));
        const title = (await A.text(`[data-character-title="${ID}"]`)).trim();
        assert.match(title, new RegExp(MODEL_NAME));
        const card = (await A.text(`[data-pack="${ID}"]`)).replace(/\s+/g, ' ');
        assert.match(card, /VRM/);
        assert.match(card, /E2E Maker/);
        assert.equal((await A.text(`[data-vrm-credit="${ID}"]`)).trim(), '署名：E2E Maker（模型授权要求署名）');
        const why = (await A.text(`[data-vrm-noexport="${ID}"]`)).trim();
        assert.match(why, /导出已禁用：这个 VRM 模型的授权不允许再分发/);
        // 可穿衣: her 衣柜 is the card list of her own outfits; the one she has on is 正在穿, 穿上 is the user's way in
        const outfits = await A.win.evaluate((x) => [...document.querySelectorAll(`[data-outfits="${x}"] [data-outfit]`)].map((c) => ({ id: c.dataset.outfit, equipped: c.dataset.equipped === 'true', locked: c.dataset.locked === 'true' })), ID);
        assert.ok(outfits.length >= 1 && outfits.filter((o) => o.equipped).length === 1, JSON.stringify(outfits));
        const worn = outfits.find((o) => o.equipped).id;
        assert.ok((await page.getAttribute('#pet-look', 'data-key')).startsWith(`${ID}/${worn}`), `衣柜 正在穿 ${worn} vs pet look ${await page.getAttribute('#pet-look', 'data-key')}`);
        const eq = await A.win.evaluate((x) => window.petAdmin.equipOutfit(x.o, x.id), { o: worn, id: ID });
        assert.equal(eq.ok, true, `equipOutfit(${worn}, ${ID}) → ${JSON.stringify(eq).slice(0, 200)}`);
        await A.win.evaluate((x) => document.querySelector(`[data-pack="${x}"]`).scrollIntoView({ block: 'center' }), ID);
        await H.adminShot('2-card');
        await A.win.evaluate((x) => document.querySelector(`[data-outfits="${x}"]`).scrollIntoView({ block: 'center' }), ID);
        await H.adminShot('2a-wardrobe-cards');
        // 角色包 lists it with 导出 disabled (main refuses it too)
        await A.go('/packs');
        await A.until((x) => !!document.querySelector(`[data-export-pack="${x}"]`), ID, 10000, '角色包 row');
        assert.equal(await A.win.evaluate((x) => document.querySelector(`[data-export-pack="${x}"]`).disabled, ID), true, '导出 disabled for a non-redistributable model');
        const ex = await A.win.evaluate((x) => window.petAdmin.exportPack(x), ID);
        assert.equal(ex.ok, false);
        await H.adminShot('2b-packs-export-disabled');
        return H.note(`new character ${ID} 「${title}」 (base ${me.base}, kind ${me.kind}, ${me.source}): current, in 角色图鉴 (${ids.length} rows); 角色包 card 「${card.slice(0, 120)}」; credit 「署名：E2E Maker（模型授权要求署名）」; ${why}; 衣柜 cards ${outfits.map((o) => `${o.id}${o.equipped ? '[正在穿]' : ''}${o.locked ? '[🔒]' : ''}`).join('、')}, 穿上 ${worn} → ok; 角色包页 导出 disabled, exportPack → ${ex.reason}`);
      }, () => A.win);

      await step(S, '授权信息 on the card: the license details with author and restrictions', async () => {
        await A.lookTab(ID);
        await A.click(`[data-vrm-info="${ID}"]`);
        const sel = `[role="dialog"] [data-vrm-license="${ID}"]`;
        await A.until((x) => !!document.querySelector(x), sel, 10000, '授权信息');
        await sleep(400);
        const t = (await A.text(sel)).replace(/\s+/g, ' ');
        assert.match(t, /VRM 1\.0 授权：仅限个人非商业使用 \/ 不可再分发 \/ 禁止修改 \/ 需署名/);
        assert.match(t, /作者E2E Maker/);
        await H.adminShot('3-license');
        await A.win.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => /close|关闭/i.test(b.getAttribute('aria-label') || '')).click());
        return H.note(`授权信息: ${t.slice(0, 260)}`);
      }, () => A.win);

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
    const { data, env } = dataDir('vrm', { ageConfirmed: true, ageConfirmedAt: Date.now() }, { motions: true });
    env.FAKE_LH_RUN_DELAY_MS = '2500'; // the chat reply takes a while: she thinks (hold.think) before she talks
    const model = makeModel(ROOT, 'vrm');
    const evidence = [];
    const samples = {};
    const { app, page } = await launch(env, { args: ['--autoplay-policy=no-user-gesture-required'] });
    const errors = watchErrors(page);
    const H = helpers(page, 'vrm', evidence, app);
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
        const css = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); const cs = getComputedStyle(c); const b = getComputedStyle(document.getElementById('pet-body')); return { animationName: cs.animationName, transform: cs.transform, scale: cs.scale, body: b.animationName }; });
        const s = { state: await page.evaluate(() => window.petFx.state().state), events: d.state, hold: d.hold, reaction: d.reaction, overlays: d.overlays, expr: d.expr, mouth: d.mouth, motion: f.motion, root: f.root, frame: d.frame, mode: d.mode, fps: d.fps, css };
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

      await step(S, 'the homemade model is imported (real import-vrm IPC) as a character of her own and switched to in 角色图鉴', async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file);
        const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
        assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
        ID = imp.pack.id;
        // T-2764: the import is a new character (id = the pack id) next to 大肥鱼 · 像素, not a 形象包 of hers
        const chars = (await page.evaluate(async () => (await window.pet.boot()).view)).characters;
        const me = chars.find((c) => c.id === ID);
        assert.ok(me && me.base === 'dafeiyu' && me.kind === 'vrm', `the import is a character: ${JSON.stringify(me)}`);
        assert.ok(chars.some((c) => c.id === 'dafeiyu-pixel'), 'her pixel character stays');
        // start from 2D: the 3D runtime is loaded only when she becomes the VRM character
        const back = await page.evaluate(() => window.pet.switchCharacter('dafeiyu-pixel'));
        assert.equal(back.ok, true, JSON.stringify(back).slice(0, 200));
        await page.waitForFunction(() => document.getElementById('pet-look').dataset.key.startsWith('dafeiyu-pixel/'), null, { timeout: 10000 });
        await H.switchTo(ID);
        return H.note(`imported ${ID} (${imp.license && imp.license.summary}) → character ${me.id} 「${me.label || me.name}」 (base ${me.base}, kind ${me.kind}); switched to it on her page in 角色图鉴`);
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
        // VRM's own motion: the library over vrmlib://, the style read from the model, a posture clip at full weight
        assert.equal(b.library, 'loaded', `data-library ${b.library}`);
        assert.equal(b.anim, 'vrma');
        assert.match(b.style, /^(female|male|neutral) \((meta|pack)\)$/);
        assert.match(b.layers, /@(female|male):/);
        samples.start = { a, b, runtime: rt.versions, maps: f.maps, clips: f.clips, style: f.style };
        box = await page.locator('#pet-look canvas.vrm').boundingBox();
        await H.shot('1-drawn');
        return H.note(`data-frame ${a.frame} → ${b.frame} in 1 s (fps ${b.fps}, mode ${b.mode}); runtime ${JSON.stringify(rt.versions)}; SpringBone joints ${f.springJoints}; texture maps ${f.maps.loaded}/${f.maps.total} loaded\nmotion library: data-library=${b.library}, ${f.clips.length} clips (${f.clips.join(', ')}); data-style=${b.style}; data-posture=${b.posture}; data-idle=${b.idle}; data-layers=${b.layers}`);
      }, page);

      await step(S, 'idle: after a while with nothing happening the frame budget drops (data-mode idle, lower fps)', async () => {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.25);
        await page.evaluate(() => window.petFx.cue('happy'));
        await sleep(900);
        const act = await H.ds();
        // an idle cue of the app (fx) may now and then play a small cheer (T-2681): that wakes her up for a few
        // seconds by design, so a window with a reaction in it is measured again
        let f0;
        let f1;
        let measured;
        for (let tries = 0; tries < 4; tries++) {
          await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.mode === 'idle', null, { timeout: 25000 });
          await sleep(2200);
          const r0 = (await page.evaluate(() => window.PetVRM.director.reactions())).length;
          f0 = await H.ds();
          await sleep(2000);
          f1 = await H.ds();
          measured = (Number(f1.frame) - Number(f0.frame)) / 2;
          const r1 = (await page.evaluate(() => window.PetVRM.director.reactions())).length;
          if (r1 === r0 && f1.mode === 'idle') break;
        }
        samples.frameBudget = { active: act, idle: f1, idleFramesPerSecond: measured };
        assert.equal(act.mode, 'active');
        assert.equal(f1.mode, 'idle');
        assert.ok(Number(f1.fps) < Number(act.fps), `idle fps ${f1.fps} < active ${act.fps}`);
        assert.ok(measured <= 18 && measured > 3, `idle frames/s measured ${measured}`);
        await H.shot('2-idle');
        return H.note(`active: mode ${act.mode} fps ${act.fps} → idle: mode ${f1.mode} fps ${f1.fps}; frames counted in 2 s idle: ${f0.frame} → ${f1.frame} (${measured}/s)`);
      }, page);

      await step(S, 'idle schedule: with the director\'s clock ×20, data-idle goes through ≥ 3 variants, never the same twice in a row', async () => {
        await page.evaluate(() => { window.PetVRM.director.seed(11); window.PetVRM.director.speed(20); });
        const seen = [];
        const t0 = Date.now();
        while (Date.now() - t0 < 9000) { const d = await H.ds(); if (seen[seen.length - 1] !== d.idle) seen.push(d.idle); await sleep(100); }
        const hist = await page.evaluate(() => window.PetVRM.director.history());
        await page.evaluate(() => window.PetVRM.director.speed(1));
        assert.ok(new Set(hist).size >= 3, hist.join(' → '));
        for (let i = 1; i < hist.length; i++) assert.notEqual(hist[i], hist[i - 1], hist.join(' → '));
        await H.shot('2b-idle-variants');
        samples.idle = { seen, history: hist };
        return H.note(`data-idle seen: ${seen.join(' → ')}; director history ${hist.join(' → ')} (${new Set(hist).size} variants, no repeat)`);
      }, page);

      await step(S, '设置窗口 → 她的页 → 装扮 → VRM 姿势: each posture cross-fades in (weights sum to 1), is saved, and the bone shows it', async () => {
        const got = [];
        const LABEL = { 'stand.confident': '叉腰站', 'stand.playful': '俏皮站', 'sit.rest': '坐着', 'stand.relaxed': '放松站' };
        for (const p of ['stand.confident', 'stand.playful', 'sit.rest', 'stand.relaxed']) {
          await H.A.lookTab(ID); // her page is the VRM character's own (T-2764)
          await H.A.until((x) => !!document.querySelector(`[data-posture-row="${x}"] [role="combobox"]`), ID, 10000, 'VRM 姿势 row');
          const w = H.A.win;
          await w.locator(`[data-posture-row="${ID}"]`).scrollIntoViewIfNeeded();
          await w.locator(`[data-posture-row="${ID}"]`).getByRole('combobox').click();
          await w.getByRole('option', { name: LABEL[p], exact: true }).click();
          await H.A.toastSeen(new RegExp(`的姿势已设为「${LABEL[p]}」`));
          if (p === 'stand.confident') await H.adminShot('2c-posture-menu');
          const sums = [];
          for (let i = 0; i < 8; i++) { sums.push((await H.fig()).weightSum); await sleep(80); }
          await page.waitForFunction((x) => { const c = document.querySelector('#pet-look canvas.vrm'); return c.dataset.posture === x && /^[^,]+:1\.00$/.test(c.dataset.layers); }, p, { timeout: 15000 });
          await sleep(300);
          const f = await H.fig();
          const saved = await page.evaluate(async (id) => (await window.pet.getSettings()).vrmPostures[id], ID);
          // the homemade clip raises the right upper arm by ARM[p]° from hanging (70° roll); the alive layer adds ≤ 4°
          const roll = Math.abs(f.bones.rightUpperArm[2]);
          assert.ok(Math.abs(roll - (70 - ARM[p])) < 8, `${p}: right arm roll ${roll} (want ≈ ${70 - ARM[p]})`);
          assert.ok(sums.every((x) => Math.abs(x - 1) < 0.01), `weights ${sums}`);
          assert.equal(saved, p);
          got.push(`${p}: layers ${(await H.ds()).layers}, arm ${roll.toFixed(1)}°, saved ${saved}, sums ${[...new Set(sums.map((x) => x.toFixed(2)))].join('/')}`);
          await H.shot(`2d-posture-${p}`);
        }
        return H.note(got.join('\n'));
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
        const dl = await H.ds();
        const gl = dl.gaze;
        const tl = (await H.fig()).gaze;
        await H.shot('4-gaze-left');
        await page.mouse.move(box.x + box.width - 2, box.y + box.height * 0.2);
        await sleep(900);
        const dr = await H.ds();
        const gr = dr.gaze;
        const tr = (await H.fig()).gaze;
        await H.shot('4-gaze-right');
        const x = (g) => Number(g.split(',')[0]);
        // T-2729: a moving cursor is what her eyes follow — never a glance away (走神) in the middle of it
        assert.equal(dl.gazeSrc, 'cursor', `left: eyes on ${dl.gazeSrc}`);
        assert.equal(dr.gazeSrc, 'cursor', `right: eyes on ${dr.gazeSrc}`);
        assert.ok(x(gl) < -0.3 && x(gr) > 0.3 && gl !== gr, `left ${gl} right ${gr}`);
        samples.gaze = { left: gl, right: gr, debugLeft: tl, debugRight: tr };
        await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.25);
        return H.note(`data-gaze cursor left ${gl} (${dl.gazeSrc}) → right ${gr} (${dr.gazeSrc}); lookAt target left ${JSON.stringify(tl)} → right ${JSON.stringify(tr)}`);
      }, page);

      await step(S, '摸摸 (a click on her): pat → relaxed face; no pixel nod / hop, no CSS animation on the VRM', async () => {
        await page.evaluate(() => window.pet.setPrefs({ touchZones: false }));
        await rest();
        // a click reacts with pat or happy, never the same twice in a row (fx.pickClickReaction): click until pat
        const tried = [];
        let s = null;
        for (let i = 0; i < 3 && !(s && s.state === 'pat'); i++) { // a happy left over from before can be caught first: allow a few more clicks
          if (i) await rest();
          const b = await petBox();
          await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.45);
          s = await peak('pat', (x) => (x.state === 'pat' && /relaxed:/.test(x.expr)) || (x.state === 'happy' && /happy:/.test(x.expr)));
          tried.push(`${s.state}{${s.expr}; ${fmtMotion(s.motion)}}`);
        }
        await H.shot('5-pat');
        assert.equal(s.state, 'pat');
        assert.match(s.expr, /relaxed:/);
        // VRM's own: a face, no pixel moves on the bones or the canvas
        assert.deepEqual(s.motion, {}, fmtMotion(s.motion));
        assert.equal(s.css.animationName, 'none');
        assert.equal(s.css.transform, 'none');
        return H.note(`clicks → ${tried.join(' → ')}; pat: state ${s.state}, expr ${s.expr}, motion ${fmtMotion(s.motion)}`);
      }, page);

      await step(S, '拖起 (press and drag her): lifted → surprised face, data-hold lift, legs hang; no pixel dangle, no CSS swing', async () => {
        await rest();
        const b = await petBox();
        const x0 = b.x + b.width / 2;
        const y0 = b.y + b.height * 0.45;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + i * 6, y0 - i * 3); await sleep(40); }
        const s = await peak('lifted', (x) => x.state === 'lifted' && x.hold === 'lift' && /(surprised|oh):/.test(x.expr));
        await H.shot('6-lifted');
        const legs = (await H.fig()).bones.leftUpperLeg;
        await page.mouse.up();
        assert.equal(s.state, 'lifted');
        assert.equal(s.hold, 'lift');
        assert.match(s.expr, /(surprised|oh):/);
        // no pixel dangle: no CSS swing on her or the window's body, no procedural flailing
        assert.deepEqual(s.motion, {});
        assert.equal(s.css.animationName, 'none');
        assert.equal(s.css.body, 'none', 'the pet-dangle CSS swing is off for VRM');
        assert.equal(s.css.transform, 'none');
        await sleep(600);
        const after = await H.ds();
        return H.note(`lifted: app state ${s.state}, VRM ${s.events}, data-hold ${s.hold}, expr ${s.expr}, canvas css ${JSON.stringify(s.css)}, legs ${JSON.stringify(legs)} (gravity, ≤ 8°/12°); released → ${after.state}`);
      }, page);

      await step(S, '喂食 (喂食 → a food): eating → happy face, chewing with the mouth (aa), not the bones', async () => {
        await rest();
        await page.evaluate(() => window.pet.debugSet({ hunger: 60 }));
        await clickAct(page, 'feed');
        await page.click('#food-menu button');
        const s = await peak('feed', (x) => /^eat/.test(x.state) && x.hold === 'eat' && /happy:/.test(x.expr) && /aa:0\.[2-9]/.test(x.mouth), 3000);
        await H.shot('7-feed');
        assert.match(s.state, /^eat/);
        assert.equal(s.hold, 'eat');
        assert.match(s.expr, /happy:/);
        assert.match(s.mouth, /aa:0\.[2-9]/, 'chewing is the mouth (aa), not a bone');
        assert.match(s.overlays, /hold:hold\.eat@\w+:/, `the eating hold is laid over the base: ${s.overlays}`);
        assert.deepEqual(s.motion, {});
        return H.note(`feed: app state ${s.state}, VRM ${s.events}, data-hold ${s.hold}, expr ${s.expr}, mouth ${s.mouth}`);
      }, page);

      await step(S, '玩耍: play → happy face; she does not spin round (the pixel play), body stays turned to the user', async () => {
        await page.waitForFunction(() => !/^eat/.test(window.petFx.state().state), null, { timeout: 8000 });
        await rest();
        await clickAct(page, 'play');
        const s = await peak('play', (x) => x.state === 'play' && /happy:/.test(x.expr), 3000);
        const yaws = [];
        for (let i = 0; i < 12; i++) { yaws.push(Math.abs((await H.fig()).root.yaw)); await sleep(100); }
        await H.shot('8-play');
        assert.equal(s.state, 'play');
        assert.match(s.expr, /happy:/);
        // the pixel play spun her round every 3 s; a VRM smiles and stays turned to the user (≤ the facing yaw)
        assert.ok(Math.max(...yaws) <= 25, `body yaw ${Math.max(...yaws).toFixed(1)}°`);
        assert.deepEqual(s.motion, {});
        assert.equal(s.css.animationName, 'none', 'no CSS char-hop');
        return H.note(`play: app state ${s.state}, VRM ${s.events}, expr ${s.expr}, body yaw ≤ ${Math.max(...yaws).toFixed(1)}° over 1.2 s (no spin), canvas animation ${s.css.animationName}`);
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

      // ---------------------------------------------------------------- the reaction layer (T-2681)
      // one frame's dataset and bones together (the same draw)
      const frameNow = () => page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); const f = window.PetVRM.debug().figures[0]; return { d: { ...c.dataset }, bones: f.bones, reactions: f.reactions, plan: f.plan }; });
      // the left upper arm the overlays should give (make-test-vrma: base −70°, each clip raises it LEFT_ARM°)
      const expectArm = (overlays) => {
        let z = -70;
        for (const o of (overlays || '').split(',').filter(Boolean)) {
          const [, id, w] = o.split(':');
          z += (-70 + (LEFT_ARM[id.split('@')[0]] || 0) - z) * Number(w);
        }
        return z;
      };
      // watch until data-reaction is `want`, then until it is over; every frame: no T-pose, the arm as the overlays say
      const watchReaction = async (want, { ms = 4000, after = 6000, shotName = null } = {}) => {
        const t0 = Date.now();
        const frames = [];
        let peakF = null;
        let shot = null;
        while (Date.now() - t0 < ms + after) {
          const f = await frameNow();
          frames.push({ t: Date.now() - t0, reaction: f.d.reaction, hold: f.d.hold, overlays: f.d.overlays, expr: f.d.expr, gaze: f.d.gaze, layers: f.d.layers, la: f.bones.leftUpperArm[2], ra: f.bones.rightUpperArm[2] });
          if (f.d.reaction === want) {
            const w = Number(((f.d.overlays.match(new RegExp(`reaction:${want.replace('.', '\\.')}@\\w+:([0-9.]+)`)) || [])[1]) || 0);
            if (!peakF || w > peakF.w) peakF = { ...f, w };
            if (shotName && !shot && w > 0.4) shot = await H.shot(shotName);
          }
          if (peakF && f.d.reaction !== want && !/reaction:/.test(f.d.overlays) && !/fading:/.test(f.d.overlays)) break;
          if (!peakF && Date.now() - t0 > ms) break;
          await sleep(40);
        }
        if (shotName && !shot && peakF) shot = await H.shot(shotName);
        assert.ok(peakF, `${want} never showed: ${frames.slice(-5).map((x) => `${x.reaction}{${x.overlays}}`).join(' | ')}`);
        // never a T-pose (the right arm stays down with the base), and the left arm is what the overlays say
        for (const x of frames) {
          assert.ok(Math.abs(x.ra) > 15, `T-pose? right arm ${x.ra} at ${x.t} ms`);
          assert.ok(Math.abs(x.la - expectArm(x.overlays)) < 4, `left arm ${x.la.toFixed(1)} vs overlays ${x.overlays} (${expectArm(x.overlays).toFixed(1)}) at ${x.t} ms`);
        }
        const end = frames[frames.length - 1];
        return { peak: peakF, frames, end, shot };
      };
      const touchZone = async (zone) => {
        const c = await page.evaluate(() => window.PetVRM.director.zoneCenters());
        assert.ok(c[zone], `no ${zone} on screen: ${Object.keys(c)}`);
        const n0 = ((await page.evaluate(() => window.petFx.lastTouch())) || { n: 0 }).n;
        await page.mouse.click(c[zone].x, c[zone].y);
        await page.waitForFunction((n) => { const t = window.petFx.lastTouch(); return t && t.n > n; }, n0, { timeout: 5000 });
        return page.evaluate(() => window.petFx.lastTouch());
      };
      const settle = async () => { await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && !c.dataset.reaction && !/reaction:|fading:/.test(c.dataset.overlays || ''); }, null, { timeout: 15000 }); await sleep(300); };
      const reactionLog = [];
      samples.reactions = reactionLog;

      await step(S, '触摸区 3D 命中: each zone is hit on the skeleton (ray vs capsules), and the zones follow her posture', async () => {
        await page.evaluate(() => window.pet.setPrefs({ touchZones: true, voice: false }));
        await page.evaluate(() => window.pet.debugSet({ affection: 20, mood: 60, hunger: 20, sleeping: false, lastAffectionAt: {}, affectionToday: 0 }));
        await rest();
        await settle();
        const c = await page.evaluate(() => window.PetVRM.director.zoneCenters());
        const got = {};
        for (const z of ['head', 'face', 'chest', 'belly', 'hands', 'legs', 'feet']) {
          const tp = await page.evaluate((p) => window.petFx.touchPoint(p.x, p.y), c[z]);
          got[z] = tp && tp.zone;
          assert.equal(got[z], z, `${z} at ${JSON.stringify(c[z])} → ${tp && tp.zone}`);
          assert.equal(tp.pose, 'vrm', 'hit on the VRM skeleton, not the 2D zone table');
        }
        await H.shot('13a-zones');
        // seated: the head comes down; where it was is no longer the head
        await page.evaluate((id) => window.PetVRM.director.setPosture(id, 'sit.rest'), ID);
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.posture === 'sit.rest', null, { timeout: 10000 });
        await sleep(2500);
        const sc = await page.evaluate(() => window.PetVRM.director.zoneCenters());
        const oldHead = await page.evaluate((p) => window.petFx.touchPoint(p.x, p.y), c.head);
        const newHead = await page.evaluate((p) => window.petFx.touchPoint(p.x, p.y), sc.head);
        await H.shot('13b-zones-seated');
        await page.evaluate((id) => window.PetVRM.director.setPosture(id, 'stand.relaxed'), ID);
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.posture === 'stand.relaxed', null, { timeout: 10000 });
        await sleep(2000);
        // seated she is raised so her seat, legs and feet stay inside the frame (T-2684), so the head comes down
        // less than on the floor line; what matters is that the zones follow her (the next two asserts)
        assert.ok(sc.head.y > c.head.y + 10, `the head moved down sitting: ${c.head.y} → ${sc.head.y}`);
        assert.notEqual(oldHead && oldHead.zone, 'head');
        assert.equal(newHead.zone, 'head');
        return H.note(`standing zone centres → touchPoint: ${JSON.stringify(got)}\nzones on screen ${JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, [Math.round(v.x), Math.round(v.y)]])))}\nsit.rest: head ${Math.round(c.head.y)} → ${Math.round(sc.head.y)} px; the old head spot is now ${oldHead && oldHead.zone}, the new one ${newHead.zone}`);
      }, page);

      for (const [zone, want, label] of [['head', 'react.touch-head', '摸头'], ['face', 'react.touch-face', '戳脸'], ['hands', 'react.touch-hands', '牵手'], ['belly', 'react.ticklish', '怕痒'], ['chest', 'react.angry', '敏感区·低好感生气']]) {
        await step(S, `${label}: a click on ${zone} → ${want} (clip over the base + face + gaze), then back to the idle`, async () => {
          await settle();
          const before = await frameNow();
          const t = await touchZone(zone);
          const r = await watchReaction(want, { shotName: `13-${want.replace('react.', '')}` });
          const pk = r.peak;
          assert.match(pk.d.overlays, new RegExp(`reaction:${want.replace('.', '\\.')}@male:`), pk.d.overlays);
          assert.ok(pk.d.expr.length > 0, 'a face');
          assert.equal(r.end.reaction, '', 'over');
          assert.equal(r.end.layers.split(',').length, 1, `one base clip at full weight: ${r.end.layers}`);
          assert.equal(r.end.layers.split(':')[0], before.d.layers.split(':')[0], `back to the same idle base (${before.d.layers} → ${r.end.layers})`);
          reactionLog.push({ want, mood: t.mood, streak: t.streak, peak: { overlays: pk.d.overlays, expr: pk.d.expr, gaze: pk.d.gaze, leftArm: pk.bones.leftUpperArm }, frames: r.frames.length, shot: r.shot });
          return H.note(`click ${zone} → touch-zones mood ${t.mood}${t.streak ? ` (streak ${t.streak})` : ''} → data-reaction ${want}; peak overlays ${pk.d.overlays}, expr ${pk.d.expr}, gaze ${pk.d.gaze}, left arm ${pk.bones.leftUpperArm[2].toFixed(1)}° (base −70 + ${LEFT_ARM[want]}×w); ${r.frames.length} frames checked (no T-pose, arm = overlays); end: reaction '${r.end.reaction}', overlays '${r.end.overlays}', base ${r.end.layers}`);
        }, page);
      }

      await step(S, '敏感区·中好感害羞: chest at affection 40 → react.shy, eyes down aside, the shy posture for a while', async () => {
        await page.evaluate(() => window.pet.debugSet({ affection: 40, lastAffectionAt: {}, affectionToday: 0 }));
        await page.evaluate((id) => window.pet.setVrmPosture(id, 'auto'), ID); // 姿势: 自动 (the shy posture only follows in auto)
        await settle();
        await sleep(9000); // past the chest streak window: a fresh first touch
        const t = await touchZone('chest');
        const r = await watchReaction('react.shy', { shotName: '13-shy' });
        assert.equal(t.mood, 'shy');
        const g = r.peak.d.gaze.split(',').map(Number);
        assert.ok(g[0] < 0 && g[1] < 0, `looks down aside: ${r.peak.d.gaze}`);
        assert.match(r.peak.d.expr, /(surprised|oh|sad|sorrow)/);
        const f = await frameNow();
        assert.equal(f.plan.postureSource, 'shy');
        reactionLog.push({ want: 'react.shy', mood: t.mood, peak: { overlays: r.peak.d.overlays, expr: r.peak.d.expr, gaze: r.peak.d.gaze } });
        await page.evaluate((id) => window.pet.setVrmPosture(id, 'stand.relaxed'), ID);
        await sleep(1500);
        return H.note(`chest at affection 40 → mood ${t.mood} → react.shy; peak overlays ${r.peak.d.overlays}, expr ${r.peak.d.expr}, gaze ${r.peak.d.gaze}; after: posture ${f.plan.posture} (${f.plan.postureSource})`);
      }, page);

      await step(S, '连续触摸情绪升级: poking the head 7× in a row goes happy → annoyed → angry (touch-zones streak); each new reaction fades the old one out, never a T-pose', async () => {
        await settle();
        await sleep(9000); // a fresh streak
        const moods = [];
        const frames = [];
        let sawFading = false;
        for (let i = 0; i < 7; i++) {
          const t = await touchZone('head');
          moods.push(`${t.mood}${t.streak ? `/${t.streak}` : ''}`);
          const t0 = Date.now();
          while (Date.now() - t0 < 750) {
            const f = await frameNow();
            frames.push({ i, reaction: f.d.reaction, overlays: f.d.overlays, la: f.bones.leftUpperArm[2], ra: f.bones.rightUpperArm[2] });
            if (/fading:/.test(f.d.overlays)) sawFading = true;
            await sleep(40);
          }
        }
        await H.shot('13-angry-escalated');
        const hist = (await frameNow()).reactions;
        for (const x of frames) {
          assert.ok(Math.abs(x.ra) > 15, `T-pose? ${x.ra}`);
          assert.ok(Math.abs(x.la - expectArm(x.overlays)) < 4, `arm ${x.la} vs ${x.overlays}`);
        }
        assert.deepEqual(moods.slice(0, 2), ['happy', 'happy']);
        assert.ok(moods.slice(2, 5).every((m) => m === 'annoyed/annoyed'), moods.join(' '));
        assert.ok(moods.slice(5).every((m) => m === 'angry/angry'), moods.join(' '));
        const tail = hist.slice(-3);
        assert.deepEqual(tail, ['react.touch-head', 'react.annoyed', 'react.angry'], hist.join(' → '));
        assert.ok(sawFading, 'the interrupted reaction faded out under the new one');
        await settle();
        const calm = await frameNow();
        reactionLog.push({ want: 'escalation', moods, reactions: tail });
        return H.note(`touch-zones moods: ${moods.join(' → ')}\ndirector reactions: ${tail.join(' → ')} (repeated happy touches extend touch-head instead of restarting it)\n${frames.length} frames: right arm never < 15°, left arm = overlays (fading seen: ${sawFading}); afterwards expr ${calm.d.expr} (still a little cross)`);
      }, page);

      await step(S, '拖拽提起与放下: lifted → hold.lift laid over (legs hang); put down → react.drop (knee dip) → idle', async () => {
        await settle();
        const b = await petBox();
        const x0 = b.x + b.width / 2;
        const y0 = b.y + b.height * 0.45;
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + i * 6, y0 - i * 3); await sleep(40); }
        await page.waitForFunction(() => /hold:hold\.lift@\w+:(0\.[5-9]|1)/.test(document.querySelector('#pet-look canvas.vrm').dataset.overlays), null, { timeout: 5000 });
        const up = await frameNow();
        await H.shot('13-lift');
        await page.mouse.up();
        const r = await watchReaction('react.drop', { shotName: '13-drop' });
        assert.match(up.d.overlays, /hold:hold\.lift@male/);
        assert.equal(up.d.hold, 'lift');
        assert.ok(Math.abs(up.bones.leftUpperArm[2] - expectArm(up.d.overlays)) < 4);
        reactionLog.push({ want: 'hold.lift / react.drop', lift: up.d.overlays, drop: r.peak.d.overlays });
        return H.note(`lifted: data-hold ${up.d.hold}, overlays ${up.d.overlays}, expr ${up.d.expr}, left arm ${up.bones.leftUpperArm[2].toFixed(1)}°, legs ${JSON.stringify(up.bones.leftUpperLeg)}\nreleased → ${r.peak.d.reaction}: overlays ${r.peak.d.overlays}, expr ${r.peak.d.expr}; then reaction '${r.end.reaction}', base ${r.end.layers}`);
      }, page);

      await step(S, '思考/等待回复 → 说话: the chat waits (hold.think, eyes up), the reply talks (hold.talk + the mouth moving together)', async () => {
        await settle();
        await clickAct(page, 'chat');
        await page.fill('#chat-input', '你在想什么呀');
        await page.press('#chat-input', 'Enter');
        await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave')));
        await page.waitForFunction(() => /hold:hold\.think@\w+:(0\.[5-9]|1)/.test(document.querySelector('#pet-look canvas.vrm').dataset.overlays), null, { timeout: 8000 });
        const th = await frameNow();
        await H.shot('13-think');
        const g = th.d.gaze.split(',').map(Number);
        await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c.dataset.hold === 'talk' && /hold:hold\.talk(?:-\d)?@\w+:(0\.[3-9]|1)/.test(c.dataset.overlays) && Math.max(...c.dataset.mouth.split(',').map((p) => Number(p.split(':')[1]))) > 0.15; }, null, { timeout: 15000 });
        const tk = await frameNow();
        await H.shot('13-talk');
        assert.equal(th.d.hold, 'think');
        assert.ok(g[1] > 0.5, `thinking looks up: ${th.d.gaze}`);
        assert.ok(Math.abs(th.bones.leftUpperArm[2] - expectArm(th.d.overlays)) < 4);
        assert.match(tk.d.overlays, /hold:hold\.talk(?:-\d)?@male/);
        assert.notEqual(tk.d.lip, 'off');
        reactionLog.push({ want: 'hold.think / hold.talk', think: th.d.overlays, talk: tk.d.overlays, mouth: tk.d.mouth });
        return H.note(`waiting for the reply: data-hold ${th.d.hold}, overlays ${th.d.overlays}, gaze ${th.d.gaze} (up), expr ${th.d.expr}\nthe reply: data-hold ${tk.d.hold}, overlays ${tk.d.overlays}, lip ${tk.d.lip}, mouth ${tk.d.mouth} — the gesture and the mouth together`);
      }, page);

      await step(S, '开心/打招呼: evolve → react.cheer, hatch → react.greet (full body), back to the idle', async () => {
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.hold === '', null, { timeout: 30000 });
        await settle();
        await page.evaluate(() => window.PetVRM.director.inject({ type: 'celebrate', name: 'evolve' }));
        const c = await watchReaction('react.cheer', { shotName: '13-cheer' });
        await page.evaluate(() => window.PetVRM.director.inject({ type: 'celebrate', name: 'hatch' }));
        const g = await watchReaction('react.greet', { shotName: '13-greet', after: 8000 });
        assert.match(c.peak.d.expr, /happy|joy/);
        reactionLog.push({ want: 'react.cheer / react.greet', cheer: c.peak.d.overlays, greet: g.peak.d.overlays });
        return H.note(`celebrate:evolve → ${c.peak.d.reaction} (${c.peak.d.overlays}, expr ${c.peak.d.expr}); celebrate:hatch → ${g.peak.d.reaction} (${g.peak.d.overlays}); end reaction '${g.end.reaction}', base ${g.end.layers}`);
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
        const toastTo = await page.evaluate(() => document.getElementById('toast-open').dataset.admin);
        assert.equal(toastTo, 'topics', 'the notice leads to 话题, not to a wardrobe');
        await page.click('#toast-close');
        // the wardrobe is the 衣柜 on her page in the settings window (T-2784: a card per outfit, 成人 / 全年龄 tag,
        // 正在穿 / 穿上 / 未解锁); `id` defaults to her base, i.e. whichever of her characters is current
        const cardsOf = async (id = 'dafeiyu') => {
          await H.A.lookTab(id);
          await H.A.until(() => !!document.querySelector('[data-outfits] [data-outfit]'), null, 10000, '衣柜 cards');
          return H.A.win.evaluate(() => [...document.querySelectorAll('[data-outfits] [data-outfit]')].map((b) => ({ id: b.dataset.outfit, label: ((b.querySelector('[data-try-outfit]').getAttribute('aria-label') || '').match(/「(.+)」/) || [])[1], locked: b.dataset.locked === 'true', equipped: b.dataset.equipped === 'true', adultTag: (b.querySelector('[data-rating]') || {}).textContent === '成人' })));
        };
        const single = await cardsOf();
        assert.equal(single.length, 1, `one VRM model: one look in 衣柜 (${JSON.stringify(single)})`);
        const view0 = await page.evaluate(async () => (await window.pet.boot()).view);
        assert.deepEqual(view0.outfits.map((x) => x.id), ['daily']);
        assert.equal(view0.outfits[0].label, '招牌女仆装');
        const cards = view0.outfits;
        const eq = await page.evaluate(() => window.pet.equipOutfit('maid'));
        assert.equal(eq.ok, false);
        const eqP = await page.evaluate(() => window.pet.equipOutfit('pajamas'));
        assert.equal(eqP.ok, false, 'no other outfit to change into');
        await H.adminShot('10b-single-look-wardrobe');
        // 角色图鉴 (the console's roster and the 选择模型娘 list of the pet window) does not offer the 18+ character
        await H.A.go('/characters');
        await H.A.until(() => !!document.querySelector('[data-roster] [data-row]'), null, 10000, '角色图鉴');
        const listed = await H.A.win.evaluate(() => [...document.querySelectorAll('[data-roster] [data-row]')].map((o) => o.dataset.row));
        assert.ok(!listed.includes('vrm-e2e-adult'), listed.join(', '));
        assert.ok(listed.includes(ID), listed.join(', '));
        const pickable = (await page.evaluate(async () => (await window.pet.boot()).view)).characters.map((c) => c.id);
        assert.ok(!pickable.includes('vrm-e2e-adult') && pickable.includes(ID), pickable.join(', '));
        await H.adminShot('10c-adult-off-roster');
        // her page is not there either, and switching to her is refused with the reason
        await H.A.go('/characters/vrm-e2e-adult');
        await H.A.until(() => /没有角色「vrm-e2e-adult」/.test(document.querySelector('[data-path="/characters/vrm-e2e-adult"]').textContent), null, 10000, 'no page for the 18+ character');
        assert.equal(await H.A.win.evaluate(() => document.querySelectorAll('[data-switch="vrm-e2e-adult"]').length), 0);
        const lookBefore = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
        const set = await page.evaluate(() => window.pet.switchCharacter('vrm-e2e-adult'));
        const setA = await H.A.win.evaluate(() => window.petAdmin.switchCharacter('vrm-e2e-adult'));
        assert.deepEqual([set.ok, set.reason], [false, 'adult'], JSON.stringify(set).slice(0, 200));
        assert.deepEqual([setA.ok, setA.reason], [false, 'adult'], JSON.stringify(setA).slice(0, 200));
        await sleep(500);
        const key = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
        assert.ok(!key.startsWith('vrm-e2e-adult/'), `look ${key}`);
        assert.equal(key, lookBefore, 'she stays who she was');
        assert.equal((await page.evaluate(async () => (await window.pet.boot()).view)).pet.characterId, ID);
        const unlocked = cards.filter((c) => !c.locked).length;
        // contrast: 18+ on → the 18+ VRM pack is offered and its adult outfit 性感女仆装 (成人向) can be worn; off again → gone
        await page.evaluate(() => window.pet.setAdult(true));
        await H.switchTo('vrm-e2e-adult');
        await H.A.lookTab('vrm-e2e-adult');
        await H.A.until(() => !!document.querySelector('[data-outfits="vrm-e2e-adult"] [data-outfit="maid"][data-locked="false"]'), null, 10000, 'maid in 衣柜');
        const on = await cardsOf('vrm-e2e-adult');
        const maidOn = on.find((c) => c.id === 'maid');
        assert.ok(maidOn && maidOn.label === '性感女仆装' && maidOn.adultTag && !maidOn.locked, JSON.stringify(on));
        await H.A.click('[data-outfits] [data-equip="maid"]');
        await H.A.until(() => !!document.querySelector('[data-outfits] [data-outfit="maid"][data-equipped="true"]'), null, 10000, 'maid worn');
        await page.waitForFunction(() => (document.getElementById('pet-look').dataset.key || '').startsWith('vrm-e2e-adult/maid'), null, { timeout: 10000 }).catch(async () => { throw new Error(`maid: pet look stays ${await page.getAttribute('#pet-look', 'data-key')}`); });
        await H.adminShot('10d-adult-on-wardrobe-maid');
        await page.evaluate(() => window.pet.setAdult(false));
        await page.waitForFunction(() => !document.getElementById('pet-look').dataset.key.includes('/maid') && !document.getElementById('pet-look').dataset.key.startsWith('vrm-e2e-adult/'), null, { timeout: 8000 });
        const keyOff = await page.evaluate(() => document.getElementById('pet-look').dataset.key);
        // she leaves the 18+ pack for her default (2D) look, whose wardrobe is real: 衣柜 has more, without maid
        // the 18+ character is gone from the console too: her page is no more, 角色图鉴 no longer lists her
        await H.A.until(() => /没有角色「vrm-e2e-adult」/.test(document.body.textContent), null, 10000, 'the 18+ page is gone');
        const rosterOff = await H.A.win.evaluate(async () => (await window.petAdmin.state()).roster.map((r) => r.id));
        assert.ok(!rosterOff.includes('vrm-e2e-adult'), rosterOff.join(', '));
        await H.A.lookTab('dafeiyu'); // her current character, the one she fell back to
        await H.A.until(() => document.querySelectorAll('[data-outfits] [data-outfit]').length > 1, null, 10000, 'her 2D wardrobe');
        const off2 = await cardsOf();
        assert.ok(off2.length > 1, 'her 2D look has a wardrobe');
        assert.ok(!off2.some((c) => c.id === 'maid' || c.adultTag), JSON.stringify(off2));
        const eq2 = await page.evaluate(() => window.pet.equipOutfit('maid'));
        assert.equal(eq2.ok, false);
        await H.adminShot('10e-adult-off-again-wardrobe');
        const contrast = `18+ on: ${on.map((c) => `${c.label}${c.adultTag ? '[成人向]' : ''}`).join('、')} → wore 性感女仆装; 18+ off again → look ${keyOff}, cards ${off2.map((c) => c.label).join('、')} (no 性感女仆装, no 成人向 tag), equipOutfit(maid) → ${eq2.reason}`;
        return H.note(`adult content off (all unlocked): 角色图鉴 lists ${listed.join(', ')} (no vrm-e2e-adult), her page says 没有角色; switchCharacter(vrm-e2e-adult) → ok=${set.ok} reason=${set.reason} (console: ok=${setA.ok} reason=${setA.reason}), look stays ${key}; toast 「${toast}」 (not to a wardrobe); 衣柜 has one look (${single.map((c) => c.label).join('')}), outfits ${cards.map((c) => `${c.id}=${c.label}`).join('、')} (${unlocked} unlocked); equipOutfit(maid) → ${eq.reason}, equipOutfit(pajamas) → ${eqP.reason}; all-ages pack with maid → ${sneakyNote}\ncontrast — ${contrast}`);
      }, page);

      await step(S, 'back to dafeiyu-pixel: the 2D look draws, the VRM canvas is removed and the figure disposed', async () => {
        await H.switchTo('dafeiyu-pixel');
        await page.waitForFunction(() => !document.querySelector('#pet-look canvas.vrm') && window.PetVRM.stats.live === 0, null, { timeout: 8000 });
        const st = await page.evaluate(() => ({ stats: window.PetVRM.stats, el: document.querySelector('#pet-look').firstElementChild.outerHTML.slice(0, 100), key: document.getElementById('pet-look').dataset.key }));
        assert.ok(st.key.startsWith('dafeiyu-pixel/'));
        assert.ok(st.stats.disposed >= 1);
        await sleep(500);
        await H.shot('11-back-to-2d');
        return H.note(`2D: look ${st.key}, element ${st.el}; PetVRM.stats ${JSON.stringify({ created: st.stats.created, disposed: st.stats.disposed, live: st.stats.live })}`);
      }, page);

      await step(S, 'and to the VRM again: a new figure draws', async () => {
        await H.switchTo(ID);
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

      await step(S, 'style: the homemade model is read as male (meta); a pack with vrm.style "female" plays the female set (pack), narrower stance', async () => {
        await page.evaluate((id) => window.pet.setVrmPosture(id, 'stand.confident'), ID);
        await page.waitForFunction(() => /^stand\.confident@male:1\.00$/.test(document.querySelector('#pet-look canvas.vrm').dataset.layers), null, { timeout: 15000 });
        await sleep(300);
        const male = await H.fig();
        const md = await H.ds();
        // the box model has broad shoulders (shoulder / hip 1.57, no bust springs) → male, from the file
        assert.equal(md.style, 'male (meta)');
        assert.ok(male.clips.every((c) => c.endsWith('@male')), male.clips.join(', '));
        const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrm-female-')), 'female-pack');
        fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
        fs.copyFileSync(model.file, path.join(dir, 'models', 'a.vrm'));
        fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ schema: 2, id: 'vrm-e2e-female', name: 'E2E Female Fish', species: 'dafeiyu', kind: 'vrm', vrm: { outfits: { daily: 'models/a.vrm' }, style: 'female' } }));
        const r = await page.evaluate((d) => window.pet.debugImportPack(d), dir);
        assert.equal(r.ok, true, JSON.stringify(r.errors));
        await page.evaluate(() => window.pet.setVrmPosture('vrm-e2e-female', 'stand.confident'));
        await H.switchTo('vrm-e2e-female');
        await H.drawing(2);
        await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && /^stand\.confident@female:1\.00$/.test(c.dataset.layers || ''); }, null, { timeout: 15000 });
        await sleep(400);
        const d = await H.ds();
        const f = await H.fig();
        assert.equal(d.style, 'female (pack)');
        assert.ok(f.clips.every((c) => c.endsWith('@female')), f.clips.join(', '));
        // same model, same posture: the male set stands with the feet apart (clip 4° + male stance), the female not
        assert.ok(male.bones.leftUpperLeg[2] > f.bones.leftUpperLeg[2] + 2, `legs: male ${male.bones.leftUpperLeg} vs female ${f.bones.leftUpperLeg}`);
        assert.ok(f.style.amplitude > male.style.amplitude && f.style.hipSway > male.style.hipSway);
        await H.shot('12b-female-style');
        // the same touch on the female set plays the female clip
        await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
        await sleep(9000);
        await touchZone('belly');
        const fr = await watchReaction('react.ticklish', { shotName: '12b-female-ticklish' });
        assert.match(fr.peak.d.overlays, /reaction:react\.ticklish@female:/);
        await H.switchTo(ID);
        return H.note(`imported model: data-style ${md.style}, layers ${md.layers}, leftUpperLeg ${male.bones.leftUpperLeg}, amplitude ${male.style.amplitude}, hipSway ${male.style.hipSway}\npack.json vrm.style "female": data-style ${d.style}, layers ${d.layers}, clips ${f.clips.length} @female, leftUpperLeg ${f.bones.leftUpperLeg}, amplitude ${f.style.amplitude}, hipSway ${f.style.hipSway}\nfemale belly touch → ${fr.peak.d.overlays} (male: react.ticklish@male)`);
      }, page);

      await step(S, 'no motion library (library.json removed): data-library none, she still draws (arms down, alive layer), no error', async () => {
        fs.renameSync(path.join(data, 'vrm-motions', 'library.json'), path.join(data, 'vrm-motions', 'library.off'));
        await H.switchTo('dafeiyu-pixel');
        await H.switchTo(ID);
        await H.drawing(5);
        await sleep(800);
        const a = await H.ds();
        await sleep(800);
        const b = await H.ds();
        const f = await H.fig();
        assert.equal(b.library, 'none');
        assert.ok(Number(b.frame) > Number(a.frame));
        assert.equal(b.layers, '');
        assert.ok(f.bones.leftUpperArm[2] < -50 && f.bones.rightUpperArm[2] > 50, `arms down, not a T-pose: ${f.bones.leftUpperArm} / ${f.bones.rightUpperArm}`);
        await H.shot('12c-no-library');
        fs.renameSync(path.join(data, 'vrm-motions', 'library.off'), path.join(data, 'vrm-motions', 'library.json'));
        return H.note(`library.json removed: data-library=${b.library}, data-anim=${b.anim}, frames ${a.frame} → ${b.frame}, idle ${b.idle}, arms ${f.bones.leftUpperArm} / ${f.bones.rightUpperArm}`);
      }, page);

      await step(S, 'packaging guard: no .vrm / .vrma / .fbx / .vmd in git ls-files nor in the files package.json build.files ships', async () => {
        const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => /\.(vrma?|fbx|vmd|bvh|pmx|vroid)$/i.test(f));
        assert.deepEqual(tracked, []);
        const build = require('../package.json').build.files;
        assert.ok(build.includes('!**/*.vrm') && build.includes('!**/*.VRM') && build.includes('!**/*.vrma') && build.includes('!**/*.VRMA'), JSON.stringify(build));
        for (const ext of ['fbx', 'vmd', 'bvh', 'pmx']) assert.ok(build.includes(`!**/*.${ext}`), ext);
        // what build.files matches on disk (src/**/*, package.json), before the exclusions
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
        const shipped = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'package.json')];
        const vrms = shipped.filter((f) => /\.(vrma?|fbx|vmd|bvh|pmx)$/i.test(f));
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
    let H = helpers(page, 'frame', evidence, app);
    let admin = null;
    let testId = null;
    let realId = null;
    const fullCam = {};
    const saved = () => JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'));
    const petBox = () => page.locator('#pet-body .pet-hit:not(.hidden)').boundingBox();
    const canvasBox = () => page.locator('#pet-look canvas.vrm').boundingBox();
    const settled = (mode) => page.waitForFunction((m) => { const c = document.querySelector('#pet-look canvas.vrm'); const f = window.petFx.vrm(); return c && c.dataset.framing === m && f && f.figures[0] && !f.figures[0].gliding; }, mode, { timeout: 15000 });
    const rest = async () => { await page.waitForFunction(() => { const s = window.petFx.state(); return s && /^(idle|walk|sit|bored)$/.test(s.state); }, null, { timeout: 15000 }).catch(() => {}); await sleep(400); };
    // composition shots: standing at rest (not sitting / bored), pointer off her
    const stand = async () => { await page.mouse.move(5, 5); await page.waitForFunction(() => { const s = window.petFx.state(); return s && s.state === 'idle'; }, null, { timeout: 30000 }).catch(() => {}); await sleep(500); };
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
    // a GIF from rapid screenshots of the pet window (frames kept next to it): `grab(i)` runs before frame i
    const gif = async (name, n, gapMs, grab = null, fps = 8) => {
      const dir = path.join(SHOTS, `frame-${name}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < n; i++) {
        if (grab) await grab(i);
        await page.screenshot({ path: path.join(dir, `${String(i).padStart(3, '0')}.png`) });
        if (gapMs) await sleep(gapMs);
      }
      const out = path.join(SHOTS, `frame-${name}.gif`);
      execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', path.join(dir, '%03d.png'), '-vf', 'split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse', out]);
      return `vrm/frame-${name}.gif (${n} frames)`;
    };
    const monotonic = (xs) => xs.every((v, i) => i === 0 || (v - xs[i - 1]) * Math.sign(xs[xs.length - 1] - xs[0]) >= -1e-6);
    try {
      await step(S, 'hatching 大肥鱼; the homemade VRM (outside the repo) is imported and worn; 取景 default 全身', async () => {
        await H.hatch();
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file);
        const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
        assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
        testId = imp.pack.id;
        await H.switchTo(testId); // 角色图鉴 → her page → 切换, as the owner does
        await H.drawing(5);
        await settled('full');
        const st = await page.evaluate(() => window.pet.getSettings());
        assert.equal(st.prefs.framing, 'full');
        assert.deepEqual(st.framings, {});
        return H.note(`imported ${testId}; prefs.framing=${st.prefs.framing}, framings=${JSON.stringify(st.framings)}`);
      }, page);

      await step(S, '全身 (homemade model): head to feet, feet on the floor, centred — screenshot', async () => {
        await stand();
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
        const burst = gif('glide-to-half', 14, 0, null, 12); // the switch frame by frame: a glide, no T-pose, no blank
        await pickGlobal('半身');
        const glide = await glideSamples(600);
        const glideGif = await burst;
        await settled('half');
        await stand();
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
        return H.note(`${shot} + ${glideGif}: data-framing=half, data-cut=${(await H.ds()).cut}, band ${JSON.stringify(f.band)}; opaque box ${JSON.stringify(c)} (full: ${JSON.stringify(fullCam.comp)}); camera z ${fullCam.test.z.toFixed(3)} → ${f.camera.z.toFixed(3)}, y ${fullCam.test.y.toFixed(3)} → ${f.camera.y.toFixed(3)}; window ${JSON.stringify(b)} (unchanged); figures created ${before.created} → ${after.created}; glide z ${zs.map((z) => z.toFixed(2)).join(' → ')}`);
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
        // the cursor sweeps right → left → right across the window while she watches it (and idles, blinks)
        const xs = [1, 0.75, 0.5, 0.25, 0, 0, 0.25, 0.5, 0.75, 1, 1];
        const sweep = await gif('half-gaze', xs.length * 2, 120, async (i) => { const k = xs[Math.floor(i / 2)]; await page.mouse.move(box.x + 2 + (box.width - 4) * k, box.y + box.height * 0.2); }, 6);
        return H.note(`${shot} + ${sweep}: data-gaze left ${gl} → right ${gr}`);
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
        await stand();
        const idleGif = await gif('half-idle', 16, 200, null, 5); // 待机: breathing, blinking, in 半身
        // the app's state (pat / happy / lifted) is petFx.state(); the VRM canvas's data-state lists the director's
        // semantic events since the VRM motion system (docs/vrm-motion-system.md), data-reaction / data-hold what she plays
        const appDs = async () => ({ ...(await H.ds()), state: await page.evaluate(() => window.petFx.state().state) });
        let s = null;
        const tried = [];
        for (let i = 0; i < 3 && !(s && s.state === 'pat'); i++) {
          if (i) await rest();
          const b = await petBox();
          await page.mouse.click(b.x + b.width / 2, b.y + b.height * 0.45);
          const t0 = Date.now();
          while (Date.now() - t0 < 2500) { s = await appDs(); if (s.state === 'pat' || s.state === 'happy') break; await sleep(60); }
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
        const dragGif = await gif('half-drag', 8, 60, null, 8); // lifted: dangling while held, 半身
        let l = null;
        const t0 = Date.now();
        while (Date.now() - t0 < 2500) { l = await appDs(); if (l.state === 'lifted' && l.hold === 'lift') break; await sleep(60); }
        const shot = await H.shot('6-half-lifted');
        await page.mouse.up();
        assert.equal(l.state, 'lifted');
        assert.equal(l.hold, 'lift', 'the VRM plays her lifted hold (legs hang)');
        assert.equal(l.framing, 'half', 'still 半身 while dragged');
        await sleep(800);
        await page.evaluate(() => window.pet.setPrefs({ touchZones: true }));
        const w1 = await petBounds(app);
        return H.note(`${idleGif}; ${dragGif}; ${shot}: clicks → ${tried.join(' → ')}; drag → state ${l.state}, hold ${l.hold} (${l.overlays}; expr ${l.expr}), framing ${l.framing}; window ${w0.x},${w0.y} → ${w1.x},${w1.y}`);
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
        const lipDir = path.join(SHOTS, 'frame-half-lipsync');
        fs.rmSync(lipDir, { recursive: true, force: true });
        fs.mkdirSync(lipDir, { recursive: true });
        let lipN = 0;
        for (let i = 0; i < 120; i++) {
          if (lipN < 40) await page.screenshot({ path: path.join(lipDir, `${String(lipN++).padStart(3, '0')}.png`) });
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
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', '8', '-i', path.join(lipDir, '%03d.png'), '-vf', 'split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse', path.join(SHOTS, 'frame-half-lipsync.gif')]);
        assert.ok(lips.has('audio') && maxOpen > 0.2, `lip ${[...lips]} max ${maxOpen}`);
        assert.equal(after, 'aa:0.00,ih:0.00,ou:0.00,ee:0.00,oh:0.00');
        return H.note(`${shot} + vrm/frame-half-lipsync.gif (${lipN} frames): lip modes ${[...lips].join(',')}, max mouth ${maxOpen.toFixed(2)}; after: ${after}`);
      }, page);

      await step(S, '后台切回 全身: the first camera and composition again, the window unchanged', async () => {
        const b0 = await petBounds(app); // (the drag moved the window)
        const burst = gif('glide-to-full', 14, 0, null, 12);
        await pickGlobal('全身');
        const glide = await glideSamples(600);
        const glideGif = await burst;
        await settled('full');
        await stand();
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
        return H.note(`${shot} + ${glideGif}: data-framing=full; camera ${JSON.stringify(f.camera)} = the first one; opaque box ${JSON.stringify(c)} (first: ${JSON.stringify(fullCam.comp)}); glide z ${zs.map((z) => z.toFixed(2)).join(' → ')}`);
      }, page);

      await step(S, '她的页 → 装扮 → 取景 (per character): her own 半身 wins over the global 全身; 跟随全局 goes back', async () => {
        // the VRM character's own page (T-2764: 取景 is saved per character, not per base)
        await admin.evaluate((x) => { location.hash = `/characters/${x}`; }, testId);
        await admin.waitForSelector(`[data-framing-row="${testId}"]`, { timeout: 10000 });
        await admin.locator(`[data-framing-row="${testId}"]`).getByText('半身', { exact: true }).click();
        await adminToast(/的取景已改为「半身」/);
        await settled('half');
        const shotA = await adminShot('9-admin-character-half');
        const s1 = saved();
        assert.deepEqual(s1.framings, { [testId]: 'half' });
        assert.equal(s1.prefs.framing, 'full');
        const fr = await page.evaluate(() => window.petFx.framing());
        assert.deepEqual([fr.mode, fr.source], ['half', 'character']);
        await admin.locator(`[data-framing-row="${testId}"]`).getByText(/跟随全局/).click();
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
          await H.switchTo(realId);
          await H.drawing(5, 60000);
          await settled('full');
          await stand();
          const cf = await composition(page);
          const ff = await H.fig();
          const shotF = await H.shot(`10-real${ri + 1}-full`);
          await pickGlobal('半身');
          await settled('half');
          await stand();
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
        H = helpers(page, 'frame', evidence, app);
        await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
        await H.drawing(5, 60000);
        await settled('half');
        await stand();
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

  // ------------------------------------------------------------------ vrmdance
  // Dancing (docs/vrm-dance.md §7.3, T-2800): a homemade dance library (scripts/make-test-dance.js: an MMD motion
  // written with the VMD writer and baked by the real pipeline, a 6 s beep WAV, a generated cover) in
  // <userData>/vrm-dances, the homemade model, the local API switched on. Pixel look: no dance (409 not-vrm with
  // the reason); VRM: cueing → on on the dance layer alone, the music as the clock (drift), the retargeted pose on
  // the model, the stage limit and the framing, mute / volume, lifted (pause → resume), touched (a face, no
  // reaction), talking (ducked), out of sight (paused), the natural end (out → off, the idle back), the loop, Esc /
  // API stop, 喂食 and another look stopping it, a dance without music and the built-in demo; no console / CSP
  // errors, nothing written into the repository.
  async function vrmDance() {
    const S = 'vrmdance';
    const PORT = 7400 + Math.floor(Math.random() * 400);
    const TOKEN = `e2e-dance-${Math.random().toString(36).slice(2, 12)}-token`;
    const { data, env } = dataDir('vrmdance', { ageConfirmed: true, ageConfirmedAt: Date.now(), api: { enabled: true, port: PORT, token: TOKEN } }, { motions: true });
    env.PIXELPET_TRAY = '1'; // 显示桌宠 from the tray brings the hidden window back
    const { writeTestDances } = require('../scripts/make-test-dance');
    const danceDir = path.join(data, 'vrm-dances');
    const made = writeTestDances(danceDir);
    const model = makeModel(ROOT, 'vrmdance');
    const gitBefore = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    const VIDEO = path.join(SHOTS, 'vrmdance-video');
    fs.rmSync(VIDEO, { recursive: true, force: true });
    fs.mkdirSync(VIDEO, { recursive: true });
    const evidence = [];
    const chapters = [];
    const t0 = Date.now();
    const { app, page } = await launch(env, { args: ['--autoplay-policy=no-user-gesture-required'], video: VIDEO });
    const errors = watchErrors(page);
    const H = helpers(page, 'dance', evidence, app);
    const api = async (method, p, body) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/pixel-pet${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, json: await r.json() };
    };
    const ds = H.ds;
    const ctl = () => page.evaluate(() => window.petFx.dance());
    const dfig = async () => { const f = await H.fig(); return f && f.dance; };
    const waitState = (want, ms = 4000, id = null) => page.waitForFunction(([w, i]) => { const c = document.querySelector('#pet-look canvas.vrm'); return c && new RegExp(`^(${w})$`).test(c.dataset.danceState || '') && (!i || c.dataset.dance === i); }, [want, id], { timeout: ms });
    const sample = async (ms, every = 50) => { const out = []; const s0 = Date.now(); while (Date.now() - s0 < ms) { out.push({ at: Date.now() - s0, d: await ds(), f: await dfig() }); await sleep(every); } return out; };
    const sumOf = (layers) => String(layers || '').split(',').filter(Boolean).reduce((s, x) => s + Number(x.split(':').pop()), 0);
    let ID = null;
    const ST = async (name, fn) => { chapters.push({ at: (Date.now() - t0) / 1000, title: name }); return step(S, name, fn, page); };
    try {
      await ST('像素外观：不能跳舞 — 本地 API 409 not-vrm 并说明原因，IPC 同样；列表标明 vrm:false', async () => {
        await H.hatch();
        for (let i = 0; i < 50; i++) { try { if ((await api('GET', '/state')).status === 200) break; } catch { /* not listening yet */ } await sleep(200); }
        const list = await api('GET', '/dances');
        assert.equal(list.status, 200);
        assert.equal(list.json.vrm, false);
        assert.equal(list.json.reason, 'not-vrm');
        assert.equal(list.json.dir, danceDir, 'the library is in userData, not the repository');
        assert.equal(list.json.source, 'userData');
        assert.deepEqual(list.json.dances.map((d) => d.id), ['e2e-test', 'e2e-silent', 'demo']);
        const r = await api('POST', '/dance', { id: 'e2e-test' });
        assert.equal(r.status, 409);
        assert.equal(r.json.error, 'not-vrm');
        assert.equal(r.json.kind, 'sprites');
        assert.match(r.json.message, /舞蹈只有 VRM 外观可以跳。她现在是像素外观/);
        const ipc = await page.evaluate(() => window.pet.dance.play({ id: 'e2e-test' }));
        assert.equal(ipc.reason, 'not-vrm');
        const local = await page.evaluate(() => window.PetDance.current.play({ id: 'e2e-test' }));
        assert.equal(local.reason, 'not-vrm', 'the pet window refuses too');
        assert.equal(await page.evaluate(() => !!document.querySelector('#pet-look canvas.vrm')), false);
        assert.equal((await ctl()).state, null);
        return H.note(`pixel: GET /dances → vrm ${list.json.vrm} (${list.json.dances.map((d) => d.id).join(', ')}, dir ${list.json.dir}); POST /dance → ${r.status} ${JSON.stringify(r.json)}; IPC dance:play → ${ipc.reason}`);
      });

      await ST('穿上自制 VRM：画布绘制，舞蹈调试字段为 off', async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file);
        const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
        assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
        ID = imp.pack.id;
        await page.evaluate((x) => window.pet.setAppearance(x, 'dafeiyu'), ID);
        await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), ID, { timeout: 15000 });
        await H.drawing(3);
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.library === 'loaded', null, { timeout: 20000 });
        const d = await ds();
        assert.equal(d.danceState, 'off');
        assert.equal(d.dance, '');
        const list = await api('GET', '/dances');
        assert.equal(list.json.vrm, true);
        await H.shot('1-vrm');
        return H.note(`VRM ${ID}: data-dance-state ${d.danceState}, layers ${d.layers}; GET /dances vrm ${list.json.vrm}`);
      });

      await ST('开跳（API）：cueing → on；淡入时两层权重和为 1；之后只有舞蹈层（独占）、无叠加、active 帧率、音乐 playing', async () => {
        const r = await api('POST', '/dance', { id: 'e2e-test', loop: true });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.music, true);
        const frames = await sample(1500, 30);
        const states = [...new Set(frames.map((x) => x.d.danceState))];
        assert.ok(states.includes('cueing'), states.join(' '));
        assert.ok(states.includes('on'), states.join(' '));
        const fadeF = frames.filter((x) => x.d.danceState === 'cueing' && x.d.layers.split(',').length === 2);
        assert.ok(fadeF.length > 0, 'the cross-fade was seen');
        for (const x of frames) assert.ok(Math.abs(sumOf(x.d.layers) - 1) < 0.011, `weights ${x.d.layers}`);
        await waitState('on');
        await sleep(300);
        const d = await ds();
        assert.equal(d.layers, 'dance:e2e-test:1.00');
        assert.equal(d.overlays, '');
        assert.equal(d.reaction, '');
        assert.equal(d.mode, 'active');
        assert.equal(d.danceAudio, 'playing');
        assert.equal(d.danceExclusive, '1');
        assert.equal(d.dance, 'e2e-test');
        assert.equal(await page.getAttribute('#pet-body', 'data-dancing'), '1');
        const st = await api('GET', '/state');
        assert.equal(st.json.dance.id, 'e2e-test');
        await H.shot('2-dancing');
        return H.note(`POST /dance → ${JSON.stringify(r.json)}; states ${states.join(' → ')}; a fade frame: ${fadeF[0].d.layers}; on: layers ${d.layers}, overlays '${d.overlays}', mode ${d.mode}, audio ${d.danceAudio}, exclusive ${d.danceExclusive}, fps ${d.fps}; /state.dance ${JSON.stringify(st.json.dance)}`);
      });

      await ST('音乐同步：动作时间 = 音频时钟（每 200 ms 采样 5 s，|drift| ≤ 40 ms），且随墙钟前进', async () => {
        const out = [];
        for (let i = 0; i < 25; i++) {
          // one read: the time the figure showed on its last frame against the <audio> element's clock now
          const r = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); const f = window.PetVRM.debug().figures[0].dance; return { drift: Number(c.dataset.danceDrift), shown: f.t, s: window.PetDance.current.state() }; });
          out.push({ wall: Date.now(), t: r.shown, drift: r.drift, ct: r.s.t, clock: r.s.clock, media: r.s.media ? r.s.media.t : null });
          await sleep(200);
        }
        const worst = Math.max(...out.map((x) => Math.abs(x.drift)));
        // the motion shown vs the music's own clock (read a moment later: ≤ one frame apart), ignoring a loop seam
        const gaps = out.filter((x) => x.media !== null && x.media >= x.t).map((x) => x.media - x.t);
        assert.ok(gaps.length >= 20 && Math.max(...gaps) <= 0.05 + 0.04, `motion vs audio.currentTime: ${gaps.map((g) => g.toFixed(3)).join(' ')}`);
        assert.ok(worst <= 40, `drift ${out.map((x) => x.drift).join(' ')}`);
        assert.ok(out.every((x) => x.clock === 'audio'), 'the music is the clock');
        // the clock runs at real time (it loops every 6 s: count the forward steps)
        let adv = 0;
        for (let i = 1; i < out.length; i++) { const dt = out[i].ct - out[i - 1].ct; if (dt > 0) adv += dt; }
        const wall = (out[out.length - 1].wall - out[0].wall) / 1000;
        assert.ok(Math.abs(adv - wall) / wall < 0.15, `clock ${adv.toFixed(2)} s over ${wall.toFixed(2)} s`);
        evidence.push({ sync: out.map((x) => [x.t, x.drift]) });
        return H.note(`25 samples: max |drift| ${worst} ms (${out.map((x) => x.drift).join(',')}); audio.currentTime − shown time ≤ ${(Math.max(...gaps) * 1000).toFixed(0)} ms (mean ${(gaps.reduce((a, b) => a + b, 0) / gaps.length * 1000).toFixed(0)} ms, ${gaps.length} samples); clock advanced ${adv.toFixed(2)} s in ${wall.toFixed(2)} s of wall time; clock=${out[0].clock}`);
      });

      await ST('重定向上身：t=0 双臂 A 字下垂、t=1 右臂水平、t=2 左臂水平、t=4 下蹲膝盖向前', async () => {
        await page.evaluate(() => window.PetVRM.director.dance.speed(0.25));
        const at = async (t) => { await page.evaluate((x) => window.PetVRM.director.dance.seek(x), t); await sleep(160); const p = await page.evaluate(() => window.PetVRM.director.pose()); const d = await ds(); return { t: Number(d.danceT), p }; };
        const a0 = await at(0.05);
        const a1 = await at(1.0);
        const a2 = await at(2.05);
        const a4 = await at(4.15);
        await H.shot('3-squat'); // still in the squat: the clock runs at a quarter speed
        await page.evaluate(() => window.PetVRM.director.dance.speed(1));
        assert.ok(Math.abs(a0.p.arms.left.elev + 38.4) < 8 && Math.abs(a0.p.arms.right.elev + 38.4) < 8, `A-pose ${JSON.stringify(a0.p.arms)}`);
        assert.ok(Math.abs(a1.p.arms.right.elev) < 8, `right arm level at ${a1.t}: ${JSON.stringify(a1.p.arms)}`);
        assert.ok(a1.p.arms.left.elev < -25, 'the left one still down');
        assert.ok(Math.abs(a2.p.arms.left.elev) < 8, `left arm level at ${a2.t}: ${JSON.stringify(a2.p.arms)}`);
        for (const s of ['left', 'right']) {
          assert.ok(a4.p.legs[s].knee > 30, `${s} knee ${a4.p.legs[s].knee}° at ${a4.t}`);
          assert.ok(Math.abs(a4.p.legs[s].ankleY - a0.p.legs[s].ankleY) < 0.03, `${s} ankle on the floor: ${a4.p.legs[s].ankleY} vs ${a0.p.legs[s].ankleY}`);
        }
        return H.note(`t ${a0.t}: arms ${JSON.stringify(a0.p.arms)}; t ${a1.t}: ${JSON.stringify(a1.p.arms)}; t ${a2.t}: ${JSON.stringify(a2.p.arms)}; t ${a4.t}: knees ${a4.p.legs.left.knee}° / ${a4.p.legs.right.knee}°, ankles ${a4.p.legs.left.ankleY} / ${a4.p.legs.right.ankleY} (standing ${a0.p.legs.left.ankleY})`);
      });

      await ST('舞台限位与取景：大位移时 hips 被限住，头和双手始终在画布内，舞蹈相机拉远 (>1)', async () => {
        await page.evaluate(() => window.PetVRM.director.dance.seek(2.8));
        const out = [];
        for (let i = 0; i < 16; i++) { const d = await ds(); const fp = await page.evaluate(() => window.PetVRM.director.framePoints()); out.push({ t: Number(d.danceT), hips: d.danceHips.split(',').map(Number), cam: Number(d.danceCam), fp }); await sleep(60); }
        const hipsY = (await page.evaluate(() => window.PetVRM.director.pose())).legs.hipsY;
        const maxX = Math.max(...out.map((x) => Math.abs(x.hips[0])));
        assert.ok(maxX <= 0.5 * hipsY + 0.03, `hips ${maxX} m vs hips height ${hipsY}`);
        for (const x of out) for (const [n, [px, py]] of Object.entries(x.fp)) assert.ok(Math.abs(px) <= 1 && Math.abs(py) <= 1, `${n} out of the canvas at t ${x.t}: ${px},${py} (cam ${x.cam}, hips ${x.hips})`);
        assert.ok(out[0].cam > 1, `camera ${out[0].cam}`);
        await H.shot('4-stage');
        const ts = out.map((x) => x.t).filter((t) => t >= 2.7);
        return H.note(`t ${Math.min(...ts)}–${Math.max(...ts)}: max |hips x| ${maxX} m (hips ${hipsY} m, raw centre move 30 MMD units ≈ 2.4 m); data-dance-cam ${out[0].cam}; head/hands/feet NDC all in [-1,1]`);
      });

      await ST('静音 / 音量：静音后音乐 muted、动作照跳；取消恢复；音量 30% → gain ≈ 0.3', async () => {
        await clickAct(page, 'mute');
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.danceAudio === 'muted', null, { timeout: 3000 });
        const t1 = Number((await ds()).danceT);
        await sleep(700);
        const t2 = Number((await ds()).danceT);
        assert.ok(t2 !== t1, 'the dance goes on muted');
        await clickAct(page, 'mute');
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.danceAudio === 'playing', null, { timeout: 3000 });
        await page.evaluate(() => window.pet.setPrefs({ danceVolume: 30 }));
        await sleep(700);
        const g = (await ctl()).state;
        assert.ok(Math.abs(g.gain - 0.3) < 0.02, `gain ${g.gain}`);
        await page.evaluate(() => window.pet.setPrefs({ danceVolume: 60 }));
        await sleep(500);
        const g2 = (await ctl()).state;
        assert.ok(Math.abs(g2.gain - 0.6) < 0.02);
        return H.note(`muted: data-dance-audio=muted, t ${t1} → ${t2}; unmuted → playing; danceVolume 30 → gain ${g.gain}; 60 → ${g2.gain}`);
      });

      await ST('拖起：暂停（时间冻结、音乐暂停、只叠 hold.lift）；放下后 ≤1.2 s 续跳，从暂停点继续', async () => {
        await page.evaluate(() => window.PetVRM.director.dance.seek(1.5));
        await sleep(100);
        await page.evaluate(() => window.petFx.lift(true));
        await waitState('paused', 2000);
        await sleep(300);
        const p1 = await ds();
        await sleep(900);
        const p2 = await ds();
        assert.equal(p2.danceState, 'paused');
        assert.equal(p1.danceT, p2.danceT, 'frozen');
        assert.match(p2.overlays, /^hold:hold\.lift@\w+:/);
        assert.equal(p2.danceAudio, 'paused');
        await H.shot('5-lifted');
        await page.evaluate(() => window.petFx.lift(false));
        const s0 = Date.now();
        await waitState('on', 2000);
        const back = Date.now() - s0;
        await sleep(100);
        const p3 = await ds();
        assert.ok(back <= 1200, `back after ${back} ms`);
        assert.ok(Number(p3.danceT) >= Number(p2.danceT) - 0.05 && Number(p3.danceT) - Number(p2.danceT) < 0.8, `${p2.danceT} → ${p3.danceT}`);
        assert.equal(p3.danceAudio, 'playing');
        return H.note(`lifted: state ${p2.danceState}, t ${p1.danceT} = ${p2.danceT} (frozen), overlays ${p2.overlays}, audio ${p2.danceAudio}; put down → on after ${back} ms, t ${p3.danceT}, audio ${p3.danceAudio}`);
      });

      await ST('点击头部：只有表情回应，没有反应动作；触摸照常计数', async () => {
        const c = await page.evaluate(() => window.PetVRM.director.zoneCenters());
        const n0 = ((await page.evaluate(() => window.petFx.lastTouch())) || { n: 0 }).n;
        await page.mouse.click(c.head.x, c.head.y);
        await page.waitForFunction((n) => { const t = window.petFx.lastTouch(); return t && t.n > n; }, n0, { timeout: 5000 });
        const out = await sample(900, 60);
        assert.ok(out.every((x) => x.d.reaction === '' && x.d.overlays === ''), 'no reaction clip over the dance');
        assert.ok(out.every((x) => x.d.danceState === 'on'));
        assert.ok(out.some((x) => /relaxed:0\.[3-9]|happy:0\.[4-9]/.test(x.d.expr)), `a face: ${out.map((x) => x.d.expr).join(' | ')}`);
        const lt = await page.evaluate(() => window.petFx.lastTouch());
        return H.note(`touch ${lt.zone} (n ${n0} → ${lt.n}, mood ${lt.mood}); while dancing: reaction '' overlays '' throughout; expr ${out.find((x) => /relaxed|happy/.test(x.d.expr)).d.expr}`);
      });

      await ST('说话：继续跳，音乐压低到 30%（ducked），嘴在动；说完恢复', async () => {
        const voice = page.evaluate(() => window.petFx.testVoice(2.5));
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.danceAudio === 'ducked', null, { timeout: 4000 });
        await sleep(500);
        const d = await ds();
        const g = (await ctl()).state;
        assert.equal(d.danceState, 'on');
        assert.ok(Math.abs(g.gain - 0.6 * 0.3) < 0.03, `ducked gain ${g.gain}`);
        assert.ok(/aa:0\.[1-9]|ih:0\.[1-9]|ou:0\.[1-9]|ee:0\.[1-9]|oh:0\.[1-9]/.test(d.mouth), `mouth ${d.mouth}`);
        await H.shot('6-talking');
        await voice;
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.danceAudio === 'playing', null, { timeout: 4000 });
        const g2 = (await ctl()).state;
        return H.note(`talking: state ${d.danceState}, audio ${d.danceAudio}, gain ${g.gain} (60 % × 30 %), mouth ${d.mouth}; after: playing, gain → ${g2.gain}`);
      });

      await ST('窗口隐藏：暂停（含音乐）；显示后续跳', async () => {
        await page.evaluate(() => window.PetVRM.director.dance.seek(1.0));
        const hid = await page.evaluate(() => window.pet.debugHidePet(false));
        assert.equal(hid.visible, false);
        await sleep(600);
        const c1 = (await ctl()).state;
        assert.equal(c1.pausedBy, 'hidden');
        const t1 = c1.t;
        await sleep(800);
        assert.equal((await ctl()).state.t, t1, 'frozen while hidden');
        await page.evaluate(() => window.pet.debugTrayClick('显示桌宠'));
        await page.waitForFunction(() => { const s = window.petFx.dance().state; return s && !s.paused; }, null, { timeout: 4000 });
        await sleep(300);
        const c2 = (await ctl()).state;
        assert.ok(c2.t > t1);
        return H.note(`hidden: paused by ${c1.pausedBy}, t ${t1} frozen; shown again → t ${c2.t}, audio ${c2.audio}`);
      });

      await ST('自然结束：跳到末尾 → 末帧停留 → out → off（≤1.5 s），idle 恢复，全程权重和 = 1', async () => {
        await page.evaluate(() => window.PetDance.current.setLoop(false));
        await page.evaluate(() => window.PetVRM.director.dance.seek(5.4));
        const out = await sample(3000, 40);
        const states = out.map((x) => x.d.danceState);
        const firstOut = out.find((x) => x.d.danceState === 'out');
        const firstOff = out.find((x) => x.d.danceState === 'off');
        assert.ok(firstOut && firstOff && firstOff.at > firstOut.at, [...new Set(states)].join(' '));
        const lastOn = [...out].reverse().find((x) => x.d.danceState === 'on');
        assert.ok(firstOff.at - lastOn.at <= 1500, `on → off ${firstOff.at - lastOn.at} ms`);
        for (const x of out) assert.ok(Math.abs(sumOf(x.d.layers) - 1) < 0.011, `weights ${x.d.layers}`);
        const d = await ds();
        assert.ok(!/dance:/.test(d.layers), d.layers);
        assert.ok(d.idle || d.posture, 'the idle is back');
        assert.equal(await page.getAttribute('#pet-body', 'data-dancing'), null);
        const c = await ctl();
        assert.equal(c.state, null);
        assert.equal(c.stats.lastStop.reason, 'end');
        return H.note(`states ${[...new Set(states)].join(' → ')}; last on → off ${firstOff.at - lastOn.at} ms; weights 1 on all ${out.length} frames; after: layers ${d.layers}, idle ${d.idle}, last stop ${JSON.stringify(c.stats.lastStop)}`);
      });

      await ST('循环：开循环后过了 6 s 不进 out，时间回绕到开头', async () => {
        const r = await api('POST', '/dance', { id: 'e2e-test', loop: true });
        assert.equal(r.status, 200);
        await waitState('on');
        await page.evaluate(() => window.PetVRM.director.dance.seek(5.5));
        const out = await sample(1500, 40);
        assert.ok(out.every((x) => x.d.danceState === 'on'), [...new Set(out.map((x) => x.d.danceState))].join(' '));
        const ts = out.map((x) => Number(x.d.danceT));
        assert.ok(ts.some((t, i) => i > 0 && t < 1 && ts[i - 1] > 5), `wrapped: ${ts.join(' ')}`);
        for (const x of out) assert.ok(Math.abs(sumOf(x.d.layers) - 1) < 0.011, `weights at the seam ${x.d.layers}`);
        const seam = out.find((x) => x.d.layers.split(',').length === 2);
        return H.note(`loop: t ${ts.slice(0, 3).join(',')} … ${ts.slice(-3).join(',')}, never out; seam blended on two actions: ${seam ? seam.d.layers : '(between samples)'}`);
      });

      await ST('停止：Esc → 0.5 s 内 out；API /dance → /state.dance → /dance/stop', async () => {
        await page.focus('body').catch(() => {});
        const s0 = Date.now();
        await page.keyboard.press('Escape');
        await waitState('out|off', 1500);
        const esc = Date.now() - s0;
        assert.ok(esc <= 500, `Esc → out in ${esc} ms`);
        await waitState('off', 3000);
        const r = await api('POST', '/dance', { id: 'e2e-test' });
        assert.equal(r.status, 200);
        await waitState('cueing|in|on');
        const st = await api('GET', '/state');
        assert.equal(st.json.dance.id, 'e2e-test');
        const stop = await api('POST', '/dance/stop');
        assert.deepEqual(stop.json, { ok: true, id: 'e2e-test' });
        await waitState('out|off', 1500);
        const again = await api('POST', '/dance/stop');
        assert.equal(again.json.dancing, false);
        const bad = await api('POST', '/dance', { id: 'no-such' });
        assert.equal(bad.status, 404);
        return H.note(`Esc → out in ${esc} ms; POST /dance → GET /state.dance ${JSON.stringify(st.json.dance)} → POST /dance/stop ${JSON.stringify(stop.json)}; stop again ${JSON.stringify(again.json)}; unknown id → ${bad.status} ${bad.json.error}`);
      });

      await ST('打断类停止：跳舞中点「喂食」→ 先停舞再进食；跳舞中换回像素外观 → 立即停、音乐停', async () => {
        await waitState('off', 3000);
        await page.evaluate(() => window.pet.debugSet({ hunger: 60 }));
        let r = await api('POST', '/dance', { id: 'e2e-test', loop: true });
        assert.equal(r.status, 200);
        await waitState('on');
        await clickAct(page, 'feed');
        await page.click('#food-menu button');
        await waitState('out|off', 1500);
        await page.waitForFunction(() => document.querySelector('#pet-look canvas.vrm').dataset.hold === 'eat', null, { timeout: 4000 });
        const c1 = await ctl();
        assert.equal(c1.stats.lastStop.reason, 'feed');
        await waitState('off', 3000);
        await sleep(2500);
        r = await api('POST', '/dance', { id: 'e2e-test', loop: true });
        assert.equal(r.status, 200);
        await waitState('on');
        await page.evaluate(() => window.pet.setAppearance('dafeiyu-pixel', 'dafeiyu'));
        await page.waitForFunction(() => document.getElementById('pet-look').dataset.key === 'dafeiyu-pixel/daily', null, { timeout: 10000 });
        await sleep(400);
        const c2 = await ctl();
        assert.equal(c2.state, null);
        assert.equal(c2.stats.lastStop.reason, 'look');
        assert.equal(c2.stats.fading, 0, 'the music stopped at once');
        return H.note(`喂食 → last stop ${JSON.stringify(c1.stats.lastStop)}, then data-hold eat; another look → ${JSON.stringify(c2.stats.lastStop)}, music elements fading ${c2.stats.fading}`);
      });

      await ST('无音乐舞蹈（渲染时钟、默认循环）与内置示例舞「节拍摇摆」（合成节拍、拍手 / 举手比心）', async () => {
        await page.evaluate((x) => window.pet.setAppearance(x, 'dafeiyu'), ID);
        await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), ID, { timeout: 15000 });
        await H.drawing(3);
        await page.waitForFunction(() => window.PetVRM.debug().figures[0] && window.PetVRM.debug().figures[0].library === 'loaded', null, { timeout: 20000 });
        let r = await api('POST', '/dance', { id: 'e2e-silent' });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.music, false);
        assert.equal(r.json.loop, true, 'short and silent: loops');
        await waitState('on', 4000, 'e2e-silent');
        const a = await ds();
        await sleep(3600);
        const b = await ds();
        const cs = (await ctl()).state;
        assert.equal(a.danceAudio, 'none');
        assert.equal(cs.clock, 'render');
        assert.equal(b.danceState, 'on', 'still dancing after its 3 s (loop)');
        r = await api('POST', '/dance', { id: 'demo' });
        assert.equal(r.status, 200);
        assert.equal(r.json.music, true);
        await waitState('on', 4000, 'demo');
        await sleep(500);
        const d = await ds();
        assert.equal(d.danceAudio, 'playing', JSON.stringify((await ctl()).state));
        assert.equal(d.dance, 'demo');
        await page.evaluate(() => window.PetVRM.director.dance.speed(0.25));
        await page.evaluate(() => window.PetVRM.director.dance.seek(10));
        await sleep(200);
        const up = await page.evaluate(() => window.PetVRM.director.pose());
        await H.shot('7-demo-heart');
        await page.evaluate(() => window.PetVRM.director.dance.seek(2));
        await sleep(200);
        const sway = await page.evaluate(() => window.PetVRM.director.pose());
        await page.evaluate(() => window.PetVRM.director.dance.speed(1));
        assert.ok(up.arms.left.elev > 40 && up.arms.right.elev > 40, `heart: arms up ${JSON.stringify(up.arms)}`);
        assert.ok(sway.arms.left.elev < -40, `sway: arms down ${JSON.stringify(sway.arms)}`);
        const stop = await api('POST', '/dance/stop');
        assert.equal(stop.json.id, 'demo');
        return H.note(`e2e-silent: audio ${a.danceAudio}, clock ${cs.clock}, loop, t ${a.danceT} → ${b.danceT}; demo: audio ${d.danceAudio}; t 10 arms ${JSON.stringify(up.arms)}; t 2 arms ${JSON.stringify(sway.arms)}`);
      });

      await ST('守卫：无渲染 / CSP 报错，仓库里没有新增文件；舞蹈只在 userData', async () => {
        const list = await page.evaluate(() => window.pet.dance.list());
        assert.equal(list.dir, danceDir);
        const gitAfter = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
        assert.equal(gitAfter, gitBefore, 'nothing written into the repository');
        const real = realErrors(errors);
        assert.deepEqual(real, [], real.join('\n'));
        assert.ok(!/Content Security Policy|Refused to/.test(app.stderrBuf), 'no CSP refusal');
        return H.note(`dances:list dir ${list.dir} (${list.source}); git status unchanged; console errors: none; dances made: ${Object.keys(made.index.dances).join(', ')}`);
      });
    } finally {
      const vpath = await page.video() ? await page.video().path().catch(() => null) : null;
      await app.close().catch(() => {});
      let video = null;
      if (vpath && fs.existsSync(vpath)) { video = path.join(SHOTS, 'vrmdance.webm'); fs.copyFileSync(vpath, video); }
      fs.writeFileSync(path.join(SHOTS, 'vrmdance-evidence.json'), JSON.stringify({ chapters, evidence, video }, null, 2));
    }
  }

  // ------------------------------------------------------------------ danceui
  // The dance UI (docs/vrm-dance.md §6, T-2801), driven as a user does: the pixel look has no ♪ in the toolbar and
  // the settings window's 舞蹈 page says why (让她跳 off); 导入舞蹈 from a folder (a camera-only folder fails in plain
  // words; a homemade MMD folder → the confirm dialog → baked into <userData>/vrm-dances → its card); on the VRM
  // look ♪ appears, its menu lists the dances (cover, name, length, 无音乐), one click dances, the menu shows 正在跳
  // with progress, 循环播放 and 停止; the settings page shows the same and stops it; the volume slider; 删除舞蹈
  // (the one she is dancing stops first); back to the pixel look: ♪ gone again. Screenshots out/e2e/vrm/danceui-*.png.
  async function danceUi() {
    const S = 'danceui';
    const { data, env } = dataDir('danceui', { ageConfirmed: true, ageConfirmedAt: Date.now() }, { motions: true });
    const { testVmd, beepWav, coverPng } = require('../scripts/make-test-dance');
    const VMD = require('../src/core/vmd');
    const danceDir = path.join(data, 'vrm-dances');
    // what the owner would pick: an MMD folder (dance + camera + music + cover + readme), and a camera-only folder
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-danceui-src-'));
    const folder = path.join(src, '自制小舞 Homemade');
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'Motion.vmd'), testVmd());
    fs.writeFileSync(path.join(folder, 'Camera.vmd'), VMD.writeVmd({ modelName: 'cam', bones: [], cameras: [{ frame: 0, distance: -45, pos: [0, 10, 0], rot: [0, 0, 0], fov: 30 }] }));
    fs.writeFileSync(path.join(folder, 'Motion.wav'), beepWav(6));
    fs.writeFileSync(path.join(folder, 'cover.png'), coverPng(128));
    fs.writeFileSync(path.join(folder, 'readme.txt'), '自制测试舞（e2e）\r\nMotion by e2e\r\n只在本机测试使用。\r\n');
    const camOnly = path.join(src, 'camera-only');
    fs.mkdirSync(camOnly);
    fs.copyFileSync(path.join(folder, 'Camera.vmd'), path.join(camOnly, 'Camera.vmd'));
    const model = makeModel(ROOT, 'danceui');
    const gitBefore = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    const VIDEO = path.join(SHOTS, 'danceui-video');
    fs.rmSync(VIDEO, { recursive: true, force: true });
    fs.mkdirSync(VIDEO, { recursive: true });
    const evidence = [];
    const chapters = [];
    const shots = [];
    const t0 = Date.now();
    const { app, page } = await launch(env, { args: ['--autoplay-policy=no-user-gesture-required'], video: VIDEO });
    const errors = watchErrors(page);
    const H = helpers(page, 'danceui', evidence, app);
    const A = H.A;
    const petShot = async (name) => { const p = await H.shot(name); shots.push(p); return p; };
    const setShot = async (name) => { const p = await H.adminShot(name); shots.push(p); return p; };
    const hoverPet = async () => { await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 }); await sleep(150); };
    const ST = async (name, fn) => { chapters.push({ at: (Date.now() - t0) / 1000, title: name }); return step(S, name, fn, page); };
    let IMPORTED = null;
    try {
      await ST('像素外观：工具栏没有「跳舞」；设置 → 舞蹈 说明原因、「让她跳」全部禁用', async () => {
        await H.hatch();
        await hoverPet();
        assert.equal(await page.evaluate(() => document.getElementById('btn-dance').classList.contains('hidden')), true, '♪ hidden on a pixel look');
        await petShot('1-pixel-toolbar');
        await A.go('/play');
        const tile = await A.text('[data-tile="dances"] [data-tile-status]');
        assert.match(tile, /不是 VRM 外观，跳不了舞/);
        await A.go('/dances');
        await A.until(() => !!document.querySelector('[data-dance-notvrm]') && document.querySelectorAll('[data-dance-play]').length > 0, null, 10000, 'not-vrm alert');
        const alert = await A.text('[data-dance-notvrm]');
        assert.match(alert, /舞蹈只有 VRM 外观可以跳/);
        assert.match(alert, /她现在是像素外观/);
        const disabled = await A.win.evaluate(() => [...document.querySelectorAll('[data-dance-play]')].map((b) => b.disabled));
        assert.ok(disabled.length >= 1 && disabled.every(Boolean), `让她跳 disabled: ${disabled}`);
        await setShot('2-pixel-settings');
        return H.note(`pixel: #btn-dance hidden; hub tile 「${tile}」; alert 「${alert.replace(/\s+/g, ' ')}」; 让她跳 disabled ×${disabled.length}`);
      });

      await ST('导入失败：只有镜头动作的文件夹 → 页面上说明原因与出路', async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), camOnly);
        await A.click('[data-dance-import-folder]');
        await A.until(() => !!document.querySelector('[data-dance-pick-error]'), null, 10000, 'the pick error');
        const msg = await A.text('[data-dance-pick-error]');
        assert.match(msg, /只有镜头或道具的动作/);
        await setShot('3-import-error');
        return H.note(`camera-only folder → 「${msg}」`);
      });

      await ST('导入舞蹈：选文件夹 → 确认页（名字、动作、时长、音乐、封面、署名、readme）→ 转换入库 → 卡片出现', async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), folder);
        await A.click('[data-dance-import-folder]');
        await A.until(() => !!document.querySelector('[data-dance-draft]'), null, 15000, 'the confirm dialog');
        const draft = await A.win.evaluate(() => ({ name: document.querySelector('[data-dance-name]').value, dur: document.querySelector('[data-dance-draft-duration]').textContent, credit: document.querySelector('[data-dance-draft-credit]')?.textContent, text: document.querySelector('[data-dance-draft]').textContent }));
        assert.equal(draft.name, '自制小舞 Homemade');
        assert.equal(draft.dur, '0:06');
        assert.equal(draft.credit, 'Motion by e2e');
        assert.match(draft.text, /Motion\.wav/);
        assert.match(draft.text, /不会随角色包导出或分享/);
        await setShot('4-import-confirm');
        await A.click('[data-dance-import-ok]');
        await A.until(() => !document.querySelector('[data-dance-draft]'), null, 30000, 'the dialog to close');
        await A.until(() => [...document.querySelectorAll('[data-dance]')].some((c) => c.textContent.includes('自制小舞 Homemade')), null, 10000, 'the new card');
        IMPORTED = await A.win.evaluate(() => [...document.querySelectorAll('[data-dance]')].find((c) => c.textContent.includes('自制小舞 Homemade')).dataset.dance);
        assert.match(IMPORTED, /^homemade-[0-9a-f]{4}$/);
        const lib = JSON.parse(fs.readFileSync(path.join(danceDir, 'library.json'), 'utf8'));
        const e = lib.dances[IMPORTED];
        assert.ok(e && e.audio && e.cover && e.credit === 'Motion by e2e', JSON.stringify(e));
        assert.deepEqual(fs.readdirSync(path.join(danceDir, IMPORTED)).sort(), ['audio.wav', 'cover.png', 'dance.vrma', 'readme.txt', 'src']);
        const card = await A.text(`[data-dance="${IMPORTED}"]`);
        assert.match(card, /0:06/);
        assert.match(card, /含表情/);
        await setShot('5-imported');
        return H.note(`draft: name 「${draft.name}」, ${draft.dur}, credit ${draft.credit}; imported ${IMPORTED} → ${path.join(danceDir, IMPORTED)} (${Object.keys(lib.dances).length} in library.json); card 「${card.replace(/\s+/g, ' ')}」`);
      });

      await ST('换上 VRM：工具栏出现「跳舞」；点开浮层列出舞蹈（封面、名字、时长、无音乐标记）', async () => {
        await page.evaluate((x) => window.pet.debugNextOpen(x), model.file);
        const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
        assert.equal(imp.ok, true, JSON.stringify(imp).slice(0, 300));
        await page.evaluate((x) => window.pet.setAppearance(x, 'dafeiyu'), imp.pack.id);
        await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), imp.pack.id, { timeout: 15000 });
        await H.drawing(3);
        await hoverPet();
        await page.waitForFunction(() => !document.getElementById('btn-dance').classList.contains('hidden'), null, { timeout: 5000 });
        const bar = await page.evaluate(() => { const r = document.getElementById('toolbar').getBoundingClientRect(); const b = document.getElementById('btn-dance').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), btn: [Math.round(b.left), Math.round(b.top)] }; });
        assert.ok(bar.h < 30, `the toolbar stays on one row: ${JSON.stringify(bar)}`);
        await petShot('6-vrm-toolbar');
        await page.click('#btn-dance');
        await page.waitForSelector('#dance-menu:not(.hidden) .dance-row');
        const rows = await page.evaluate(() => [...document.querySelectorAll('#dance-menu .dance-row')].map((r) => ({ id: r.dataset.dance, name: r.querySelector('.dance-name').textContent, meta: r.querySelector('.dance-meta').textContent, img: !!r.querySelector('img') })));
        assert.deepEqual(rows.map((r) => r.id), [IMPORTED, 'demo']);
        assert.equal(rows[0].meta, '0:06');
        assert.equal(rows[0].img, true, 'the cover');
        assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.dance), IMPORTED, 'keyboard focus on the first row');
        await page.keyboard.press('ArrowDown');
        assert.equal(await page.evaluate(() => document.activeElement.dataset.dance), 'demo');
        await petShot('7-menu');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.getElementById('dance-menu').classList.contains('hidden')), true, 'Esc closes the menu');
        return H.note(`VRM: toolbar ${JSON.stringify(bar)}; menu rows ${JSON.stringify(rows)}; ↓ moves focus; Esc closes`);
      });

      await ST('播放中：点一支 → 她开跳，按钮按下；浮层顶部「正在跳」+ 进度 + 循环播放 + 停止；设置页同样显示', async () => {
        await hoverPet();
        await page.click('#btn-dance');
        await page.waitForSelector('#dance-menu:not(.hidden) .dance-row');
        await page.click(`#dance-menu .dance-row[data-dance="${IMPORTED}"]`);
        await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.danceState === 'on'; }, null, { timeout: 8000 });
        assert.equal(await page.getAttribute('#btn-dance', 'aria-pressed'), 'true');
        await sleep(1200);
        await hoverPet();
        await page.click('#btn-dance');
        await page.waitForSelector('#dance-menu:not(.hidden) .dance-now');
        await sleep(400);
        const now = await page.evaluate(() => ({ title: document.querySelector('.dance-now b').textContent, progress: document.querySelector('.dance-progress').textContent, row: document.querySelector('#dance-menu .dance-row .dance-meta').textContent }));
        assert.match(now.title, /正在跳《自制小舞 Homemade》/);
        assert.match(now.progress, /^0:0\d \/ 0:06/);
        assert.equal(now.row, '正在跳');
        await page.click('#dance-menu .dance-loop');
        await sleep(100);
        assert.equal(await page.getAttribute('#dance-menu .dance-loop', 'aria-pressed'), 'true');
        assert.equal((await page.evaluate(() => window.petFx.dance())).state.loop, true);
        await petShot('8-playing-menu');
        await page.mouse.move(115, 120);
        await page.evaluate(() => { document.getElementById('dance-menu').classList.add('hidden'); });
        await petShot('9-playing');
        await A.go('/dances');
        await A.until(() => !!document.querySelector('[data-dance-now]'), null, 5000, '正在跳');
        await A.until(() => document.querySelector('[data-dance-loop]')?.getAttribute('aria-checked') === 'true', null, 3000, 'loop on');
        const card = await A.win.evaluate((id) => ({ dancing: document.querySelector(`[data-dance="${id}"]`).dataset.dancing, btn: document.querySelector(`[data-dance-play="${id}"]`).textContent }), IMPORTED);
        assert.equal(card.dancing, 'true');
        assert.equal(card.btn, '停止');
        const prog = await A.text('[data-dance-progress]');
        await setShot('10-playing-settings');
        return H.note(`pet menu: 「${now.title}」 ${now.progress}, row 「${now.row}」, loop → on; settings: 正在跳 ${prog}, card button 「${card.btn}」`);
      });

      await ST('设置页控制：关循环、音量 30%（跳舞中实时生效）、停止', async () => {
        await A.click('[data-dance-loop]');
        await A.until(() => document.querySelector('[data-dance-loop]')?.getAttribute('aria-checked') === 'false', null, 3000, 'loop off');
        assert.equal((await page.evaluate(() => window.petFx.dance())).state.loop, false);
        const set = await A.win.evaluate(() => window.petAdmin.set('prefs.danceVolume', 30));
        assert.equal(set.ok, true);
        await sleep(400);
        const st = (await page.evaluate(() => window.petFx.dance())).state;
        assert.equal(st.volume, 0.3);
        await A.click('[data-dance-stop]');
        await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && /^(out|off)$/.test(c.dataset.danceState); }, null, { timeout: 3000 });
        await A.until(() => !document.querySelector('[data-dance-now]'), null, 3000, '正在跳 gone');
        assert.equal(await page.getAttribute('#btn-dance', 'aria-pressed'), 'false');
        await setShot('11-stopped-volume');
        return H.note(`loop off from settings; volume 30 → controller volume ${st.volume}; 停止 → dance state out/off, ♪ not pressed`);
      });

      await ST('删除舞蹈：正在跳的那支先停，再删目录与索引；浮层不再列出', async () => {
        await A.click(`[data-dance-play="${IMPORTED}"]`);
        await page.waitForFunction(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.danceState === 'on'; }, null, { timeout: 8000 }).catch(async (e) => {
          const d0 = await H.ds(); const diag = { danceState: d0 && d0.danceState, dance: d0 && d0.dance, ctl: await page.evaluate(() => window.petFx.dance()), btn: await A.win.evaluate((id) => { const b = document.querySelector(`[data-dance-play="${id}"]`); const g = document.querySelector('[data-dance-list]'); return b && { text: b.textContent, disabled: b.disabled, grid: { ...g.dataset } }; }, IMPORTED) };
          throw new Error(`${e.message}\n${JSON.stringify(diag.btn)} ${JSON.stringify(diag).slice(0, 600)}`);
        });
        await A.click(`[data-dance-remove="${IMPORTED}"]`);
        await A.until(() => !![...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === '删除舞蹈'), null, 5000, 'the confirm');
        const dlg = await A.win.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].pop().textContent);
        assert.match(dlg, /她正在跳这支，会先停下/);
        assert.match(dlg, /取消/);
        await setShot('12-delete-confirm');
        await A.modalButton('删除舞蹈');
        await A.until((id) => !document.querySelector(`[data-dance="${id}"]`), IMPORTED, 8000, 'the card gone');
        assert.equal(fs.existsSync(path.join(danceDir, IMPORTED)), false);
        assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(danceDir, 'library.json'), 'utf8')).dances), []);
        const st = (await page.evaluate(() => window.petFx.dance())).state;
        assert.equal(st, null, 'she stopped');
        await hoverPet();
        await page.click('#btn-dance');
        await page.waitForSelector('#dance-menu:not(.hidden) .dance-row');
        const rows = await page.evaluate(() => [...document.querySelectorAll('#dance-menu .dance-row')].map((r) => r.dataset.dance));
        assert.deepEqual(rows, ['demo']);
        const more = await page.textContent('#dance-menu .dance-more');
        assert.equal(more, '导入更多舞蹈…');
        await petShot('13-after-delete-menu');
        await page.keyboard.press('Escape');
        return H.note(`deleted ${IMPORTED} while dancing: stopped first, folder gone, library empty; menu rows ${rows.join(', ')} + 「${more}」`);
      });

      await ST('换回像素外观：「跳舞」再次隐藏，设置页恢复禁用说明；无渲染 / CSP 报错，仓库无新增文件', async () => {
        await page.evaluate(() => window.pet.setAppearance('dafeiyu-pixel', 'dafeiyu'));
        await page.waitForFunction(() => document.getElementById('pet-look').dataset.key.startsWith('dafeiyu-pixel/'), null, { timeout: 10000 });
        await hoverPet();
        await page.waitForFunction(() => document.getElementById('btn-dance').classList.contains('hidden'), null, { timeout: 3000 });
        await A.go('/dances');
        await A.until(() => !!document.querySelector('[data-dance-notvrm]'), null, 8000, 'not-vrm alert');
        assert.equal(await A.text('[data-dance-notvrm] .ant-alert-description, [data-dance-notvrm] [class*="description"]').catch(() => null) !== null, true);
        await setShot('14-pixel-again-settings');
        const gitAfter = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
        assert.equal(gitAfter, gitBefore, 'nothing written into the repository');
        const real = realErrors(errors);
        assert.deepEqual(real, [], real.join('\n'));
        assert.ok(!/Content Security Policy|Refused to/.test(app.stderrBuf || ''), 'no CSP refusal');
        return H.note('back to pixel: ♪ hidden, settings alert back; console errors none; git status unchanged');
      });
    } finally {
      const vpath = await page.video() ? await page.video().path().catch(() => null) : null;
      await app.close().catch(() => {});
      let video = null;
      if (vpath && fs.existsSync(vpath)) { video = path.join(SHOTS, 'danceui.webm'); fs.copyFileSync(vpath, video); }
      fs.writeFileSync(path.join(SHOTS, 'danceui-evidence.json'), JSON.stringify({ chapters, evidence, shots, video }, null, 2));
    }
  }

  return { vrmScenario, vrmImport, vrmFraming, vrmDance, danceUi };
};
