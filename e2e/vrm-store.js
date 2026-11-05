'use strict';

// vrmstore (T-5084): store-imported VRMs on the motion library v2 (docs/vrm-motion-library.md, T-5081), through the
// real app. A local HTTP mirror of the store (PIXELPET_E2E_STORE_DIR, default ~/vrm-assets/store/vrm) stands in for
// the CDN; the models are downloaded in 设置 → 商店 like a user does and switched to on her page. Nothing of them,
// nor of the library, is in the repository (they stay in the temp data dir and ~/vrm-assets).
//
//   1. no library (a broken install — the bundled one switched off with PIXELPET_VRM_BUILTIN_DIR='' — T-5079 R1): data-library none, the figure says why (no-library), she says
//      it in her bubble, and her page → 装扮 → VRM 动作库 shows the warning — not a silent procedural idle;
//   2. 选择动作库文件夹 (PIXELPET_E2E_MOTIONS, default ~/vrm-assets/baked-v2) links it: she is redrawn with it at once;
//   3. per store VRM (PIXELPET_E2E_STORE_IDS, default four: female 0.x, male whose hips sit on the floor, VRM 1.0,
//      a female the old guess read as male): IDLE_S s of idle sampled every 250 ms — the share of samples whose base
//      is a library clip (not rest.pose / the procedural micro idle), the idles it went through; a touch on her
//      head (a real click); POST /motion (a bow, then a looping sit) and POST /motion/stop; on the first model also
//      动作试播 in the console and a chat request (「伸个懒腰」);
//   4. the jump meter (renderer/vrm.js meterJump): for every change of what plays during all that — base cross-fades,
//      reactions in / out, manual play / stop — the largest bone turn between two drawn frames (°/frame at 30 fps)
//      must stay under JUMP_MAX (PIXELPET_E2E_JUMP_MAX, default 12; a snap is tens of degrees in one frame).
// Evidence: out/e2e/vrm/store-*.png, store-summary.json (per model: style, sets, clips, idle hits, every transition
// with its number), store-evidence.json (chapters of the video), store.webm.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');

module.exports = async function vrmStore(ctx) {
  const { ROOT, SHOTS, step, launch, sleep, dataDir, helpers, watchErrors, realErrors } = ctx;
  const S = 'vrmstore';
  const home = os.homedir();
  const STORE = process.env.PIXELPET_E2E_STORE_DIR || path.join(home, 'vrm-assets', 'store', 'vrm');
  const LIB = process.env.PIXELPET_E2E_MOTIONS || path.join(home, 'vrm-assets', 'baked-v2');
  const IDS = (process.env.PIXELPET_E2E_STORE_IDS || 'vrm-d8789c38,vrm-wanderer,vrm-a185cf3a,vrm-elysia').split(',').filter(Boolean);
  const IDLE_S = Number(process.env.PIXELPET_E2E_IDLE_S || 40);
  // a snap is a turn one frame makes that its neighbours do not (renderer/vrm.js meterJump `spike`); the speed
  // (°/frame at 30 fps) is reported next to it, with the same numbers of the 1.6 s before each change
  const SPIKE_MAX = Number(process.env.PIXELPET_E2E_SPIKE_MAX || 10); // a cut (the control step) measures 40–50°
  const JUMP_MAX = SPIKE_MAX;
  if (!fs.existsSync(STORE) || !fs.existsSync(path.join(LIB, 'library.json'))) {
    await step(S, 'store mirror and motion library present', async () => { throw new Error(`needs ${STORE} and ${LIB}/library.json (outside the repository)`); }, null);
    return;
  }
  for (const d of [STORE, LIB]) { const rel = path.relative(ROOT, d); assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `must stay outside the repository: ${d}`); }

  // the store CDN: <base>/<file>.zip from STORE
  const server = http.createServer((req, res) => {
    const f = path.join(STORE, path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    const st = fs.statSync(f);
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': st.size });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = 7400 + Math.floor(Math.random() * 400);
  const TOKEN = `e2e-store-${Math.random().toString(36).slice(2, 12)}-token`;
  const { env } = dataDir('vrmstore', { ageConfirmed: true, ageConfirmedAt: Date.now(), prefs: { roam: false }, api: { enabled: true, port: PORT, token: TOKEN } });
  Object.assign(env, { PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/vrm`, PIXELPET_CATALOG_PREINSTALLED: '', PIXELPET_VRM_MOTIONS_DIR: '', PIXELPET_VRM_DANCES_DIR: '', PIXELPET_VRM_BUILTIN_DIR: '' }); // no bundled library either: the broken-install case
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrmstore-video-'));
  const evidence = [];
  const chapters = [];
  const t0 = Date.now();
  const { app, page } = await launch(env, { video: videoDir });
  const errors = watchErrors(page);
  const H = helpers(page, 'store', evidence, app);
  const A = H.A;
  const sec = () => +((Date.now() - t0) / 1000).toFixed(1);
  // a failed step of the setup (launch, downloads, the library link) ends the run: the rest would only cascade
  let broken = null;
  const ST = async (name, fn, { setup = false } = {}) => {
    if (broken) return step(S, name, async () => { throw new Error(`skipped: ${broken} failed`); }, null);
    chapters.push({ t: sec(), title: name });
    let failed = false;
    await step(S, name, async () => { try { return await fn(); } catch (e) { failed = true; throw e; } }, page);
    if (failed && setup) broken = name;
  };
  const apiLog = [];
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/pixel-pet${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const out = { status: r.status, json: await r.json() };
    apiLog.push({ t: sec(), request: `${method} /pixel-pet${p}`, body: body || null, status: out.status, response: p === '/motions' ? { ...out.json, motions: `${out.json.motions.length} clips, e.g. ${out.json.motions.slice(0, 3).map((m) => m.id).join(', ')}` } : out.json });
    return out;
  };
  const fig = () => page.evaluate(() => { const f = window.PetVRM && window.PetVRM.debug().figures[0]; return f ? { packId: f.packId, library: f.library, libraryInfo: f.libraryInfo, clips: f.clips.length, style: f.style, sets: f.sets, boneFold: f.boneFold, plan: f.plan, layers: f.layers, jump: f.jump, idleHistory: f.idleHistory, manuals: f.manuals, variants: f.variants, poses: f.poses, poseGroup: f.poseGroup, align: f.align, frame: f.frame } : null; });
  const ds = H.ds;
  const away = () => page.mouse.move(4, 4);
  const until = async (what, fn, arg, ms = 20000) => { const s0 = Date.now(); for (;;) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; if (Date.now() - s0 > ms) throw new Error(`timed out: ${what}`); await sleep(150); } };
  const idleNow = () => until('back to the idle', () => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.action === 'idle' && !c.dataset.manual && !c.dataset.reaction; }, null, 25000);
  let nShot = 0;
  const shot = (name) => H.shot(`${String(++nShot).padStart(2, '0')}-${name}`);
  const routes = {};
  const summary = [];
  try {
    await ST('启动：孵化、打开商店（本地镜像，不预装）', async () => {
      await H.hatch();
      const info = await page.evaluate(() => window.pet.vrmLibraryInfo());
      assert.equal(info.source, 'none', `no library yet: ${JSON.stringify(info)}`);
      await A.go('/store');
      await A.until(() => !!document.querySelector('[data-catalog-grid]'), null, 30000, 'the store grid');
      const file = await H.adminShot(`${String(++nShot).padStart(2, '0')}-store`);
      return H.note(`vrm-library-info: ${JSON.stringify(info)}; store ${file}`);
    }, { setup: true });

    await ST(`从商店下载 ${IDS.length} 个 VRM（设置 → 商店 → 下载）`, async () => {
      for (const id of IDS) {
        await A.until((x) => !!document.querySelector(`[data-download="${x}"]`) || !!document.querySelector(`[data-downloaded="${x}"]`), id, 20000, `download ${id}`);
        await A.win.evaluate((x) => { const b = document.querySelector(`[data-download="${x}"]`); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } }, id);
        await A.until((x) => !!document.querySelector(`[data-downloaded="${x}"]`), id, 300000, `installed ${id}`);
        routes[id] = await A.win.evaluate((x) => { const a = document.querySelector(`[data-store-open="${x}"]`); return a ? a.getAttribute('href').replace(/^#/, '') : `/characters/${x}`; }, id);
      }
      const file = await H.adminShot(`${String(++nShot).padStart(2, '0')}-store-downloaded`);
      return H.note(`downloaded: ${JSON.stringify(routes)}; ${file}`);
    }, { setup: true });

    // her page → 切换 (→ 初次见面), until the pet window draws her
    const switchTo = async (id) => {
      const route = routes[id];
      const cid = route.split('/').pop();
      await A.go(route);
      await A.until((x) => !!document.querySelector(`[data-switch="${x}"]`) || !!document.querySelector(`[data-current="${x}"]`), cid, 20000, `her page ${cid}`);
      await A.win.evaluate((x) => { const b = document.querySelector(`[data-switch="${x}"]`); if (b) b.click(); }, cid);
      await sleep(600);
      await A.win.evaluate(() => { if (!document.querySelector('[data-meet-name]')) return; const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '初次见面' && !x.dataset.switch); if (b) b.click(); });
      await until(`${id} drawn`, (x) => { const f = window.PetVRM && window.PetVRM.debug().figures[0]; const c = document.querySelector('#pet-look canvas.vrm'); return f && String(f.packId).startsWith(x) && f.loaded && f.plan && c && Number(c.dataset.frame) > 10 && c.dataset.library; }, id, 120000);
      await page.bringToFront().catch(() => {});
      await away();
      return cid;
    };

    let firstCid = null;
    await ST('(1) 没有动作库：data-library=none，日志/气泡/控制台都说明原因（不再静默退回程序化）', async () => {
      firstCid = await switchTo(IDS[0]);
      const f = await fig();
      assert.equal(f.library, 'none');
      assert.equal(f.libraryInfo.reason, 'no-library', JSON.stringify(f.libraryInfo));
      const bubble = await until('the hint in her bubble', () => { const b = document.getElementById('bubble'); return b && !b.classList.contains('hidden') && /动作库/.test(b.textContent) ? b.textContent : null; }, null, 50000);
      const pet = await shot('no-library-pet');
      await A.lookTab(firstCid);
      await A.until(() => !!document.querySelector('[data-motion-missing]'), null, 15000, 'the warning in 装扮 → VRM 动作库');
      await A.win.evaluate(() => document.querySelector('[data-motion-lib]').scrollIntoView({ block: 'center' }));
      const con = await H.adminShot(`${String(++nShot).padStart(2, '0')}-no-library-console`);
      const warn = await A.text('[data-motion-missing]');
      return H.note(`figure.libraryInfo ${JSON.stringify(f.libraryInfo)}; plan idleKind ${f.plan.idleKind}, layers ${f.layers}\nbubble: ${bubble}\nconsole: ${warn}\nshots: ${pet}, ${con}`);
    });

    await ST('(2) 设置 → 角色 → 装扮 → VRM 动作库 → 选择动作库文件夹：立即重新载入，命中素材库', async () => {
      await page.evaluate((p) => window.pet.debugNextOpen(p), LIB);
      await A.click('[data-motion-pick]');
      await A.until(() => Number((document.querySelector('[data-motion-lib]') || {}).dataset?.motionFiles || 0) > 0, null, 20000, 'the library linked');
      await until('redrawn with the library', () => { const f = window.PetVRM && window.PetVRM.debug().figures[0]; return f && f.loaded && /^(loaded|partial)/.test(f.library) && f.clips.length > 20; }, null, 120000);
      await sleep(1500);
      await A.lookTab(firstCid);
      await A.until(() => !!document.querySelector('[data-motion-select]'), null, 20000, '动作试播');
      await A.win.evaluate(() => document.querySelector('[data-motion-lib]').scrollIntoView({ block: 'center' }));
      const con = await H.adminShot(`${String(++nShot).padStart(2, '0')}-library-linked-console`);
      const info = await page.evaluate(() => window.pet.vrmLibraryInfo());
      const f = await fig();
      return H.note(`vrm-library-info ${JSON.stringify({ source: info.source, dir: info.dir, files: info.status.files, styles: info.status.styles })}; figure ${f.library}, ${f.clips} clips, style ${JSON.stringify(f.style)}, sets ${f.sets}; ${con}`);
    }, { setup: true });

    for (let i = 0; i < IDS.length; i++) {
      const id = IDS[i];
      const row = { id, transitions: [] };
      summary.push(row);
      let tStart = 0;
      await ST(`(3) ${id}：切换并观察 ${IDLE_S} s 待机（片段命中、轮换）`, async () => {
        if (i > 0) await switchTo(id);
        await away();
        await sleep(2500);
        const f0 = await fig();
        tStart = f0.jump.t;
        Object.assign(row, { vrm: (await ds()).vrm, style: f0.style, sets: f0.sets, library: f0.library, clips: f0.clips, boneFold: f0.boneFold, libraryReason: f0.libraryInfo && f0.libraryInfo.reason });
        const samples = [];
        const shots = [];
        const s0 = Date.now();
        let k = 0;
        while (Date.now() - s0 < IDLE_S * 1000) {
          const s = await page.evaluate(() => { const f = window.PetVRM.debug().figures[0]; const p = f.plan; return { base: p.base && p.base.id, file: !!(p.base && p.base.file), idle: p.idle, idleKind: p.idleKind, posture: p.posture, action: p.action && p.action.state, layers: f.layers, life: f.life, expr: f.face }; });
          samples.push(s);
          if ((Date.now() - s0) / 1000 >= k * (IDLE_S / 4)) { shots.push(await shot(`${id}-idle-${k}`)); k++; }
          await sleep(250);
        }
        const hit = samples.filter((s) => s.file && !/^rest\.pose:1/.test(s.layers) && s.idleKind !== 'micro');
        // the alive layer over the clips: breathing (chest offset range), weight shift (hips), gaze moving, blinks
        const rng = (k) => { const v = samples.map((x) => x.life && x.life[k]).filter((x) => typeof x === 'number'); return v.length ? +(Math.max(...v) - Math.min(...v)).toFixed(3) : 0; };
        const gz = samples.map((x) => x.life && x.life.gaze).filter(Boolean);
        row.life = { overClip: samples.filter((x) => x.life && x.life.overClip && x.life.on).length, chestRange: rng('chest'), breathRange: rng('breath'), hipsRange: rng('hips'), headRange: rng('head'), gazeXRange: gz.length ? +(Math.max(...gz.map((g) => g.x)) - Math.min(...gz.map((g) => g.x))).toFixed(3) : 0, blinksSeen: samples.filter((x) => x.expr && Object.entries(x.expr).some(([n, w]) => /blink/i.test(n) && w > 0.3)).length };
        const f1 = await fig();
        Object.assign(row, { idleSamples: samples.length, idleHits: hit.length, idleHitRatio: +(hit.length / samples.length).toFixed(3), idleBases: [...new Set(samples.map((s) => s.base))], idleHistory: f1.idleHistory, idleKinds: [...new Set(samples.map((s) => s.idleKind))], poses: f1.poses, align: f1.align, idleShots: shots });
        assert.ok(row.idleHitRatio >= 0.95, `${id}: idle hits ${row.idleHits}/${row.idleSamples}`);
        return H.note(`${id}: vrm ${row.vrm}, style ${row.style.name}(${row.style.source}) → sets ${row.sets}, ${row.clips} clips${row.boneFold && row.boneFold.rootHips ? ', hips on the floor (standing clips only)' : ''}; idle ${row.idleHits}/${row.idleSamples} samples on a library clip (${(row.idleHitRatio * 100).toFixed(1)}%), bases ${row.idleBases.join(' → ')}; history ${row.idleHistory.slice(-8).join(' → ')}; last phase alignment ${JSON.stringify(row.align)}; alive layer over the clip in ${row.life.overClip}/${samples.length} samples: breath range ${row.life.breathRange}, chest offset range ${row.life.chestRange}°, hips ${row.life.hipsRange}°, head ${row.life.headRange}°, gaze x range ${row.life.gazeXRange}, eyes closed (blink) in ${row.life.blinksSeen} samples`);
      });

      await ST(`(3) ${id}：摸头（真实点击）→ 反应片段分层叠加 → 交叉淡回待机`, async () => {
        await idleNow();
        // a line in her bubble sits over a tall model's head: wait until it is gone (a click there is on the bubble)
        await until('the bubble gone', () => document.getElementById('bubble').classList.contains('hidden'), null, 30000).catch(() => {});
        const zones = await page.evaluate(() => window.PetVRM.director.zoneCenters());
        const topEl = await page.evaluate((p) => { const e = document.elementFromPoint(p.x, p.y); return e ? `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}.${[...e.classList].join('.')}` : null; }, zones.head);
        const n0 = ((await page.evaluate(() => window.petFx.lastTouch())) || { n: 0 }).n;
        await page.mouse.click(zones.head.x, zones.head.y);
        // the head point is the top of her head sphere: on a hat brim it can be a transparent pixel — then her face
        let where = 'head';
        const reacted = () => page.evaluate(() => !!window.PetVRM.debug().figures[0].plan.reaction);
        for (let k = 0; k < 15 && !(await reacted()); k++) await sleep(150);
        if (!(await reacted())) { where = 'face'; await page.mouse.click(zones.face.x, zones.face.y); }
        const r = await until(`a reaction (clicked ${topEl} at ${Math.round(zones.head.x)},${Math.round(zones.head.y)}, then ${where})`, () => { const f = window.PetVRM.debug().figures[0]; const o = (f.plan.overlays || []).find((x) => x.layer === 'reaction'); return o ? { slot: f.plan.reaction, id: o.id, mask: o.mask, overlays: f.overlays } : null; }, null, 6000);
        const n1 = ((await page.evaluate(() => window.petFx.lastTouch())) || { n: 0 }).n;
        await sleep(700);
        const mid = await shot(`${id}-touch`);
        await away();
        await idleNow();
        row.touch = { ...r, registered: n1 > n0, topElement: topEl, clicked: where };
        return H.note(`${id}: touch ${where} (element under the head point: ${topEl}) → ${r.slot} plays ${r.id} (mask ${r.mask}); overlays ${r.overlays}; back to idle; ${mid}`);
      });

      await ST(`(3) ${id}：POST /motion 鞠躬（一次性）→ 自动回待机；循环坐下 → POST /motion/stop 打断回待机`, async () => {
        let r = await api('POST', '/motion', { group: 'bow' });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        await until('manual on', () => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.manual && c.dataset.action === 'manual'; }, null, 5000);
        await sleep(1500);
        const bow = await shot(`${id}-api-bow`);
        await idleNow();
        const bowId = r.json.id;
        r = await api('POST', '/motion', { group: 'sit', loop: true });
        const sitR = r;
        let sit = null;
        if (r.status === 200) {
          await until('sitting', () => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.pose === 'sit'; }, null, 5000);
          await sleep(2500);
          sit = await shot(`${id}-api-sit`);
          const s = await api('POST', '/motion/stop');
          assert.equal(s.json.stopped, true);
          await idleNow();
          await until('standing', () => document.querySelector('#pet-look canvas.vrm').dataset.pose === 'stand', null, 5000);
        }
        const list = await api('GET', '/motions');
        row.api = { bow: bowId, sit: sitR.status === 200 ? sitR.json.id : `${sitR.status} ${sitR.json.error}`, motions: list.json.motions.length };
        return H.note(`${id}: POST /motion {group:bow} → ${bowId} → idle; {group:sit, loop} → ${row.api.sit} → POST /motion/stop → idle (stand); GET /motions → ${row.api.motions} clips; ${bow}${sit ? `, ${sit}` : ''}`);
      });

      if (i === 0) {
        await ST(`(3) ${id}：控制台动作试播（选择片段 → 播放 → 停止）与聊天「伸个懒腰」`, async () => {
          await A.lookTab(routes[id].split('/').pop());
          await A.until(() => !!document.querySelector('[data-motion-select]'), null, 20000, '动作试播');
          await A.win.evaluate(() => document.querySelector('[data-motion-lib]').scrollIntoView({ block: 'center' }));
          await A.win.bringToFront().catch(() => {});
          await A.win.click('[data-motion-select] :is(button, [role="combobox"])');
          await A.until(() => document.querySelectorAll('[role="option"] [data-motion-option]').length > 0, null, 10000, 'the motion options');
          await sleep(400);
          const opt = await A.win.evaluate(() => { const el = [...document.querySelectorAll('[role="option"] [data-motion-option]')].find((x) => /^react\.bow-/.test(x.dataset.motionOption)); if (!el) return null; el.scrollIntoView({ block: 'center' }); return el.dataset.motionOption; });
          const list = await H.adminShot(`${String(++nShot).padStart(2, '0')}-console-trial-list`);
          await A.win.click(`[role="option"] [data-motion-option="${opt}"]`);
          await sleep(300);
          await A.click('[data-motion-play]');
          const playing = await until('试播 plays', () => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.manual ? c.dataset.manual : null; }, null, 6000);
          await sleep(1200);
          const con = await H.adminShot(`${String(++nShot).padStart(2, '0')}-console-trial`);
          // the 动作试播 card as it is now (DOM), with the clip the pet window plays
          const dom = await A.win.evaluate(() => document.querySelector('[data-motion-lib]').closest('section, [class*="surface"], div').outerHTML);
          const st = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return { manual: c.dataset.manual, action: c.dataset.action, layers: c.dataset.layers, overlays: c.dataset.overlays }; });
          fs.writeFileSync(path.join(SHOTS, 'store-console-trial-dom.html'), `<!-- 动作试播 while playing; pet canvas dataset: ${JSON.stringify(st)} -->\n${dom}\n`);
          const pet = await shot(`${id}-console-trial`);
          await A.click('[data-motion-stop]');
          await idleNow();
          await page.bringToFront().catch(() => {});
          await page.mouse.move(110, 150);
          await page.waitForSelector('body.hover', { timeout: 5000 });
          await page.click('[data-act="chat"]');
          await page.fill('#chat-input', '伸个懒腰');
          await page.press('#chat-input', 'Enter');
          const chat = await until('chat → stretch', () => { const c = document.querySelector('#pet-look canvas.vrm'); return c && /stretch/.test(c.dataset.manual || '') ? c.dataset.manual : null; }, null, 8000);
          await sleep(1200);
          const pc = await shot(`${id}-chat-stretch`);
          await away();
          await idleNow();
          row.console = { trial: playing, chat };
          return H.note(`${id}: 控制台试播（下拉选 ${opt}）→ ${playing} → 停止 → idle; 聊天「伸个懒腰」→ ${chat} → idle; ${list}, ${con}, ${pet}, ${pc}`);
        });

        await ST(`(4) ${id}：跳变测量的对照——故意不交叉淡化的硬切（应被测出）`, async () => {
          await idleNow();
          const base = (await fig()).plan.base.id;
          const far = (await page.evaluate(() => window.PetVRM.director.motions())).find((m) => m.kind === 'posture' && /^(lay|crouch)\./.test(m.slot));
          const tCut = (await fig()).jump.t;
          row.controlFrom = tCut;
          assert.ok(await page.evaluate((x) => window.PetVRM.director.cut(x), far.id), 'cut');
          await sleep(2200);
          await page.evaluate((x) => window.PetVRM.director.cut(x), base);
          await sleep(2200);
          const jr = (await fig()).jump;
          row.controlTo = jr.t;
          const tr = jr.transitions.filter((w) => w.at >= tCut && /cut/.test(w.what));
          row.control = tr;
          assert.ok(tr.length >= 1 && Math.max(...tr.map((w) => w.spike)) > SPIKE_MAX * 2, `the meter sees a cut: ${JSON.stringify(tr)}`);
          return H.note(`${id}: 硬切 ${base} → ${far.id} → ${base}（无交叉淡化）: ${tr.map((w) => `spike ${w.spike}° (${w.spikeBone}), speed ${w.speed}° (${w.speedBone}), 切换前 1.6 s 的 spike ${w.before.spike}° / speed ${w.before.speed}°`).join(' | ')}`);
        });
      }

      await ST(`(4) ${id}：相邻帧骨骼跳变（每次切换 ${'≤'} ${JUMP_MAX}°/帧@30fps）`, async () => {
        await sleep(2000);
        const j = (await fig()).jump;
        // (not the control's own cuts, nor a window that overlaps them: those frames are the cut's)
        const inControl = (w) => row.controlFrom !== undefined && w.at + 1.6 >= row.controlFrom && w.at <= row.controlTo;
        const tr = j.transitions.filter((w) => w.at >= tStart && !/cut/.test(w.what) && !inControl(w));
        row.transitions = tr;
        const mx = (k) => (tr.length ? Math.max(...tr.map((w) => w[k])) : 0);
        row.jump = { unit: j.unit, frames: j.frames, overallSpeedMax: j.max, overallSpeedMaxBone: j.maxBone, speedP50: j.p50, speedP99: j.p99, spikeP99: j.spikeP99, transitions: tr.length, transitionSpikeMax: mx('spike'), transitionBodySpikeMax: mx('bodySpike'), transitionSpeedMax: mx('speed'), transitionBodySpeedMax: mx('body'), beforeSpeedMax: tr.length ? Math.max(...tr.map((w) => w.before.speed)) : 0 };
        row.jump.transitionMax = row.jump.transitionSpikeMax;
        // by kind of change: idle → idle clip (rotation), → a reaction / hold, a reaction ending back in the idle, a
        // clip played by hand starting / ending
        const kindOf = (w) => (/manual [^-]+→-/.test(w.what) ? '手动片段结束→idle' : /manual -→/.test(w.what) ? 'idle→手动片段' : /reaction→none/.test(w.what) ? '反应结束→idle' : /reaction→react/.test(w.what) ? 'idle→反应' : /^base→/.test(w.what) ? 'idle 片段轮换/姿势切换' : '叠加层变化（说话/持续）');
        row.byKind = {};
        for (const w of tr) { const k = kindOf(w); const e = row.byKind[k] || (row.byKind[k] = { n: 0, spikeMax: 0, speedMax: 0 }); e.n++; e.spikeMax = Math.max(e.spikeMax, w.spike); e.speedMax = Math.max(e.speedMax, w.speed); }
        const worst = tr.slice().sort((a, b) => b.spike - a.spike).slice(0, 3);
        assert.ok(tr.length >= 4, `${id}: ${tr.length} transitions measured`);
        for (const w of tr) assert.ok(w.spike <= SPIKE_MAX, `${id}: ${w.what} — spike ${w.spike}°/frame on ${w.spikeBone}`);
        return H.note(`${id}: by kind ${Object.entries(row.byKind).map(([k, e]) => `${k} ×${e.n} spike≤${e.spikeMax}° speed≤${e.speedMax}°`).join('; ')}\n${id}: ${tr.length} transitions; spike (jump) max ${row.jump.transitionSpikeMax}° (body ${row.jump.transitionBodySpikeMax}°) ≤ ${SPIKE_MAX}°/frame@30fps; speed max in the windows ${row.jump.transitionSpeedMax}° (body ${row.jump.transitionBodySpeedMax}°), steady p99 ${j.p99}°; worst: ${worst.map((w) => `${w.what} [${w.action}] spike ${w.spike}° ${w.spikeBone} / speed ${w.speed}° (before ${w.before.speed}°)`).join(' | ')}`);
      });
    }

    await ST('至少 3 个商店 VRM 全部通过；无控制台错误', async () => {
      const ok = summary.filter((r) => r.idleHitRatio >= 0.95 && r.jump && r.jump.transitionMax <= JUMP_MAX);
      assert.ok(ok.length >= 3, `${ok.length} models passed`);
      const real = realErrors(errors).filter((e) => !/\[vrm\]/.test(e));
      assert.deepEqual(real, [], real.join('\n'));
      return H.note(summary.map((r) => `${r.id}: vrm ${r.vrm} style ${r.style && r.style.name} sets ${r.sets} clips ${r.clips} idle ${(r.idleHitRatio * 100).toFixed(1)}% transitions ${r.jump && r.jump.transitions} max ${r.jump && r.jump.transitionMax}°`).join('\n'));
    });
  } finally {
    const vpath = page.video() ? await page.video().path().catch(() => null) : null;
    await app.close().catch(() => {});
    server.close();
    let video = null;
    if (vpath && fs.existsSync(vpath)) { video = 'vrm/store.webm'; fs.copyFileSync(vpath, path.join(SHOTS, 'store.webm')); }
    fs.writeFileSync(path.join(SHOTS, 'store-api.json'), JSON.stringify(apiLog, null, 2));
    fs.writeFileSync(path.join(SHOTS, 'store-summary.json'), JSON.stringify({ jumpMax: JUMP_MAX, idleSeconds: IDLE_S, library: LIB, models: summary }, null, 2));
    fs.writeFileSync(path.join(SHOTS, 'store-evidence.json'), JSON.stringify({ chapters, evidence, video, errors: realErrors(errors) }, null, 2));
  }
};
