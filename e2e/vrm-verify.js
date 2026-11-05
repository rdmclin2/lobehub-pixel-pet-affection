'use strict';

// vrmverify (T-5089): several store VRMs on the motion library v2 through the real app, each through the same day:
// 60 s of idle, touches on three body parts, lifted by a drag and put down, talking, one dance interrupted back to
// the idle. Every model gets a screenshot sequence (and the run a video with chapters) and a table of numbers
// (e2e/vrm-verify-metrics.js) that the T-5079 diagnosis series (before the fix) are measured with too.
//
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js vrmverify
//
// Env: PIXELPET_E2E_STORE_DIR (store mirror, default ~/vrm-assets/store/vrm), PIXELPET_E2E_MOTIONS (the library
// linked in the console, default ~/vrm-assets/baked-v2, dances from its dances/), PIXELPET_E2E_VERIFY_IDS (default
// six: female 0.x, male whose hips sit on the floor, VRM 1.0, a chibi, a child, a VRoid male), PIXELPET_E2E_IDLE_S
// (60), PIXELPET_E2E_SPIKE_MAX (10 °/frame@30fps), PIXELPET_E2E_BASELINE (~/t5079-diag/out: before the fix).
//
// A model fails (it is not skipped) when: its idle is not on library clips (procedural), fewer than 2 idle clips in
// 60 s, a touch / the drop / talking / the dance shows no clip, a change of what plays snaps (spike over the limit),
// a knee bends backwards, or it does not get back to the idle after a reaction / the dance.
// Evidence: out/e2e/vrm/verify-*.png, verify-summary.json, verify-<id>-series.json, verify-evidence.json, verify.webm.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const M = require('./vrm-verify-metrics');

module.exports = async function vrmVerify(ctx) {
  const { ROOT, SHOTS, step, launch, sleep, dataDir, helpers, watchErrors, realErrors } = ctx;
  const S = 'vrmverify';
  const home = os.homedir();
  const STORE = process.env.PIXELPET_E2E_STORE_DIR || path.join(home, 'vrm-assets', 'store', 'vrm');
  const LIB = process.env.PIXELPET_E2E_MOTIONS || path.join(home, 'vrm-assets', 'baked-v2');
  const BASE = process.env.PIXELPET_E2E_BASELINE || path.join(home, 't5079-diag', 'out');
  const IDS = (process.env.PIXELPET_E2E_VERIFY_IDS || 'vrm-d8789c38,vrm-wanderer,vrm-a185cf3a,vrm-paimon,vrm-diona,vrm-vrchat-avatar').split(',').filter(Boolean);
  const IDLE_S = Number(process.env.PIXELPET_E2E_IDLE_S || 60);
  const SPIKE_MAX = Number(process.env.PIXELPET_E2E_SPIKE_MAX || 10);
  const ZONES = ['head', 'hands', 'belly'];
  // after the 60 s window: wait for the first rest bout (sit / crouch) up to REST_S s (0 = skip)
  const REST_S = Number(process.env.PIXELPET_E2E_REST_S ?? 150);
  if (!fs.existsSync(STORE) || !fs.existsSync(path.join(LIB, 'library.json'))) {
    await step(S, 'store mirror and motion library present', async () => { throw new Error(`needs ${STORE} and ${LIB}/library.json (outside the repository)`); }, null);
    return;
  }
  const server = http.createServer((req, res) => {
    const f = path.join(STORE, path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = 7800 + Math.floor(Math.random() * 400);
  const TOKEN = `e2e-verify-${Math.random().toString(36).slice(2, 12)}-token`;
  const { env } = dataDir('vrmverify', { ageConfirmed: true, ageConfirmedAt: Date.now(), prefs: { roam: false }, api: { enabled: true, port: PORT, token: TOKEN } });
  Object.assign(env, { PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/vrm`, PIXELPET_CATALOG_PREINSTALLED: '', PIXELPET_VRM_MOTIONS_DIR: '', PIXELPET_VRM_DANCES_DIR: '' });
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vrmverify-video-'));
  const evidence = [];
  const chapters = [];
  const t0 = Date.now();
  const { app, page } = await launch(env, { video: videoDir });
  const errors = watchErrors(page);
  const H = helpers(page, 'verify', evidence, app);
  const A = H.A;
  const sec = () => +((Date.now() - t0) / 1000).toFixed(1);
  let broken = null;
  const ST = async (name, fn, { setup = false } = {}) => {
    if (broken) return step(S, name, async () => { throw new Error(`skipped: ${broken} failed`); }, null);
    chapters.push({ t: sec(), title: name });
    let failed = false;
    await step(S, name, async () => { try { return await fn(); } catch (e) { failed = true; throw e; } }, page);
    if (failed) { const recent = realErrors(errors).slice(-5); if (recent.length) console.log(`  page errors: ${recent.map((e) => String(e).slice(0, 300)).join(' | ')}`); }
    if (failed && setup) broken = name;
    return !failed;
  };
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/pixel-pet${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  // the pointer off her window, as when the user works in another app: a pointer inside counts as attention
  // (core/vrm-intent.js holds.attention = pointerInside), which holds off rest and boredom postures
  const away = async () => { await page.mouse.move(4, 4); await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave'))); };
  const until = async (what, fn, arg, ms = 20000) => { const s0 = Date.now(); for (;;) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; if (Date.now() - s0 > ms) throw new Error(`timed out: ${what}`); await sleep(100); } };
  const isIdle = () => { const c = document.querySelector('#pet-look canvas.vrm'); return !!(c && c.dataset.action === 'idle' && !c.dataset.manual && !c.dataset.reaction && !c.dataset.hold && !c.dataset.dance); };
  const idleNow = (ms = 25000) => until('back to the idle', isIdle, null, ms);
  const bubbleGone = () => until('the bubble gone', () => document.getElementById('bubble').classList.contains('hidden'), null, 30000).catch(() => {});
  let nShot = 0;
  const shot = (name) => H.shot(`${String(++nShot).padStart(2, '0')}-${name}`);

  // the in-page sampler: every 100 ms (the T-5079 series were ~110 ms; lighter on the renderer than 50 ms) the plan, the canvas state and the 18 pose bones (PetVRM.debug.director.pose)
  const startSampler = () => page.evaluate(() => {
    if (window.__vs) clearInterval(window.__vs.id);
    const s = { t0: performance.now(), samples: [], marks: [] };
    s.id = setInterval(() => {
      const D = window.PetVRM && window.PetVRM.director;
      const c = document.querySelector('#pet-look canvas.vrm');
      if (!D || !c) return;
      const p = D.plan();
      const po = D.pose();
      if (!p || !po) return;
      const d = c.dataset;
      s.samples.push({ t: +((performance.now() - s.t0) / 1000).toFixed(3), base: p.base && p.base.id, file: !!(p.base && p.base.file), idle: p.idle, idleKind: p.idleKind, posture: p.posture, pose: d.pose, action: d.action, reaction: d.reaction, hold: d.hold, manual: d.manual, dance: d.dance, layers: d.layers, overlays: d.overlays, expr: d.expr, q: po.q, knees: [po.legs.left && po.legs.left.knee, po.legs.right && po.legs.right.knee], arms: [po.arms.left && po.arms.left.elev, po.arms.right && po.arms.right.elev], fps: Number(d.fps) || 0, mode: d.mode, headY: po.headY, hipsY: po.legs.hipsY, ankleY: po.legs.left && po.legs.left.ankleY });
    }, 100);
    window.__vs = s;
    window.__vsMark = (name) => { s.marks.push({ t: +((performance.now() - s.t0) / 1000).toFixed(3), name }); };
    return true;
  });
  const mark = (name) => page.evaluate((n) => { window.__vsMark(n); return +((performance.now() - window.__vs.t0) / 1000).toFixed(3); }, name);
  const nowT = () => page.evaluate(() => +((performance.now() - window.__vs.t0) / 1000).toFixed(3));
  const takeSampler = () => page.evaluate(() => { const s = window.__vs; clearInterval(s.id); return { samples: s.samples, marks: s.marks }; });
  const fig = () => page.evaluate(() => { const f = window.PetVRM && window.PetVRM.debug().figures[0]; return f ? { packId: f.packId, library: f.library, libraryInfo: f.libraryInfo, clips: f.clips.length, style: f.style, sets: f.sets, boneFold: f.boneFold, jump: f.jump, idleHistory: f.idleHistory, poses: f.poses, clipRepairs: f.clipRepairs } : null; });
  // the first moment (sampler clock) at or after `from` that the samples satisfy fn
  const firstAfter = (samples, from, fn) => { const s = samples.find((x) => x.t >= from && fn(x)); return s ? s.t : null; };
  const idleS = (x) => x.action === 'idle' && !x.manual && !x.reaction && !x.hold && !x.dance;

  const routes = {};
  const summary = [];
  try {
    await ST('启动：孵化、打开商店（本地镜像，不预装）', async () => {
      await H.hatch();
      await A.go('/store');
      await A.until(() => !!document.querySelector('[data-catalog-grid]'), null, 30000, 'the store grid');
      return H.note(`store: ${await H.adminShot(`${String(++nShot).padStart(2, '0')}-store`)}`);
    }, { setup: true });

    await ST(`从商店下载 ${IDS.length} 个 VRM（设置 → 商店 → 下载）`, async () => {
      for (const id of IDS) {
        await A.until((x) => !!document.querySelector(`[data-download="${x}"]`) || !!document.querySelector(`[data-downloaded="${x}"]`), id, 20000, `download ${id}`);
        await A.win.evaluate((x) => { const b = document.querySelector(`[data-download="${x}"]`); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } }, id);
        await A.until((x) => !!document.querySelector(`[data-downloaded="${x}"]`), id, 300000, `installed ${id}`);
        routes[id] = await A.win.evaluate((x) => { const a = document.querySelector(`[data-store-open="${x}"]`); return a ? a.getAttribute('href').replace(/^#/, '') : `/characters/${x}`; }, id);
      }
      return H.note(`downloaded: ${JSON.stringify(routes)}; ${await H.adminShot(`${String(++nShot).padStart(2, '0')}-store-downloaded`)}`);
    }, { setup: true });

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

    await ST('设置 → 角色 → 装扮 → VRM 动作库 → 选择动作库文件夹（关联 baked-v2，含 dances/）', async () => {
      const cid = await switchTo(IDS[0]);
      await page.evaluate((p) => window.pet.debugNextOpen(p), LIB);
      await A.lookTab(cid);
      await A.until(() => !!document.querySelector('[data-motion-pick]'), null, 20000, '选择动作库文件夹');
      await A.click('[data-motion-pick]');
      await A.until(() => Number((document.querySelector('[data-motion-lib]') || {}).dataset?.motionFiles || 0) > 0, null, 20000, 'the library linked');
      await until('redrawn with the library', () => { const f = window.PetVRM && window.PetVRM.debug().figures[0]; return f && f.loaded && /^(loaded|partial)/.test(f.library) && f.clips.length > 20; }, null, 120000);
      await A.win.evaluate(() => document.querySelector('[data-motion-lib]').scrollIntoView({ block: 'center' }));
      const con = await H.adminShot(`${String(++nShot).padStart(2, '0')}-library-linked`);
      const info = await page.evaluate(() => window.pet.vrmLibraryInfo());
      const dances = await api('GET', '/dances');
      return H.note(`vrm-library-info ${JSON.stringify({ source: info.source, dir: info.dir, files: info.status && info.status.files, styles: info.status && info.status.styles })}; GET /dances → ${dances.json.dances ? dances.json.dances.length : 0} dances (source ${dances.json.source}); ${con}`);
    }, { setup: true });

    const dancesList = (await api('GET', '/dances')).json.dances || [];
    const libDances = dancesList.filter((d) => d.id && !/demo/.test(d.id));

    for (let i = 0; i < IDS.length; i++) {
      const id = IDS[i];
      const row = { id, steps: {}, failures: [] };
      summary.push(row);
      const fail = (why) => { row.failures.push(why); };
      let tModel = 0;
      let series = null;

      await ST(`${id}：切换为当前角色，读模型信息（版本、风格、骨骼比例、载入片段）`, async () => {
        if (i > 0) await switchTo(id);
        await away();
        await sleep(2500);
        await startSampler();
        const f = await fig();
        tModel = f.jump.t;
        const ds = await H.ds();
        const po = await page.evaluate(() => window.PetVRM.director.pose());
        const ankle = po.legs.left ? po.legs.left.ankleY : 0;
        const height = po.headY - ankle;
        Object.assign(row, { vrm: ds.vrm, style: f.style, sets: f.sets, library: f.library, libraryReason: f.libraryInfo && f.libraryInfo.reason, clips: f.clips, boneFold: f.boneFold, clipRepairs: f.clipRepairs, proportions: { headY: po.headY, hipsY: po.legs.hipsY, ankleY: ankle, headAboveAnkle: +height.toFixed(3), legShare: +((po.legs.hipsY - ankle) / Math.max(0.01, height)).toFixed(3) } });
        const s = await shot(`${id}-loaded`);
        if (!/^(loaded|partial)/.test(row.library) || row.clips < 10) fail(`library ${row.library} (${row.clips} clips): procedural`);
        return H.note(`${id}: VRM ${row.vrm}, style ${JSON.stringify(row.style)} → sets ${row.sets}, library ${row.library} (${row.libraryReason}), ${row.clips} clips, hips on floor ${!!(row.boneFold && row.boneFold.rootHips)}; proportions ${JSON.stringify(row.proportions)}; ${s}`);
      });

      await ST(`${id}：${IDLE_S} s 待机（片段命中、不同片段、姿势变化、每骨骼角速度）`, async () => {
        // her greeting line first: the window is the idle alone (a line she says by herself later stays in it)
        await idleNow(40000).catch(() => {});
        await bubbleGone();
        const from = await mark('idle-start');
        const shots = [];
        const s0 = Date.now();
        for (let k = 0; Date.now() - s0 < IDLE_S * 1000; k++) {
          const due = s0 + k * 6000;
          if (Date.now() < due) await sleep(due - Date.now());
          if (Date.now() - s0 >= IDLE_S * 1000) break;
          shots.push(await shot(`${id}-idle-${String(k * 6).padStart(2, '0')}s`));
        }
        const to = await mark('idle-end');
        const snap = await page.evaluate(() => window.__vs.samples.slice());
        const w = snap.filter((x) => x.t >= from && x.t <= to);
        const m = M.idleMetrics(w);
        const kneesMin = Math.min(...w.flatMap((x) => x.knees).filter((x) => typeof x === 'number'));
        const f = await fig();
        row.idle = { ...m, bones: undefined, boneStats: m.bones, kneesMin, idleHistory: f.idleHistory, shots };
        row.steps.idle = m.hitRatio >= 0.95 && m.distinctClips >= 3;
        if (m.hitRatio < 0.95) fail(`idle on library clips ${(m.hitRatio * 100).toFixed(1)}% (< 95%): procedural`);
        if (m.distinctClips < 3) fail(`only ${m.distinctClips} idle clip(s) in ${IDLE_S} s (< 3)`);
        if (kneesMin < -10) fail(`a knee bends backwards in the idle (${kneesMin}°)`);
        const top = Object.entries(m.bones).sort((a, b) => b[1].speedMean - a[1].speedMean).slice(0, 4).map(([b, v]) => `${b} ${v.speedMean}°/s (p95 ${v.speedP95}, range ${v.range}°)`).join(', ');
        const note = H.note(`${id}: ${m.samples} samples / ${m.seconds} s; on library clips ${m.hits}/${m.samples} = ${(m.hitRatio * 100).toFixed(1)}%; ${m.distinctClips} different clips: ${m.clipSequence.join(' → ')}; postures ${m.postures.join('/')}; moving bones ${m.movingBones}/18, mean speed ${m.meanSpeedAll}°/s, 9-bone range sum ${m.key9RangeSum}°; dominant-frequency share median ${m.dominantShareMedian} (max ${m.dominantShareMax}; single-sine bones: ${m.singleSineBones.join(',') || 'none'}); knees min ${kneesMin}°; pose change between clips ${m.poseDelta.map((d) => `${d.from}→${d.to} max ${d.maxDeg}° (${d.maxBone}) mean ${d.meanDeg}°`).join('; ')}; fastest ${top}`);
        assert.ok(row.steps.idle, row.failures.join('; '));
        return note;
      });

      // the posture bout of a calm idle (sit / crouch, every REST.after = 70–140 s): keep idling until she rests,
      // up to REST_S s; a model whose hips sit on the floor only stands (boneFold.rootHips) — recorded, not a failure
      if (REST_S > 0) {
        await ST(`${id}：继续待机到第一次姿势休息（坐 / 蹲，≤ ${REST_S} s）→ 起身回站姿`, async () => {
          const t = await mark('rest-wait');
          const s0 = Date.now();
          let got = null;
          while (Date.now() - s0 < REST_S * 1000) {
            got = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.pose && c.dataset.pose !== 'stand' ? { pose: c.dataset.pose, layers: c.dataset.layers } : null; });
            if (got) break;
            await sleep(500);
          }
          const rootHips = !!(row.boneFold && row.boneFold.rootHips);
          if (!got) {
            row.rest = { seen: false, waitedS: +((Date.now() - s0) / 1000).toFixed(1), rootHips };
            const why = rootHips ? 'hips on the floor: only standing clips are loaded (by design)' : 'no rest bout';
            if (!rootHips) fail(`no posture bout within ${REST_S} s`);
            return H.note(`${id}: no sit / crouch within ${row.rest.waitedS}s — ${why}; ${await shot(`${id}-rest-none`)}`);
          }
          const tAt = +((Date.now() - s0) / 1000).toFixed(1);
          await sleep(3500);
          const sh1 = await shot(`${id}-rest-${got.pose}`);
          // stand her up (a touch interrupts a rest: she gets up) — the cross-fade back is in the jump meter
          let up = null;
          const s1 = Date.now();
          while (Date.now() - s1 < 45000) { up = await page.evaluate(() => document.querySelector('#pet-look canvas.vrm').dataset.pose === 'stand'); if (up) break; await sleep(500); }
          const sh2 = up ? await shot(`${id}-rest-stood-up`) : null;
          row.rest = { seen: true, pose: got.pose, layers: got.layers, afterS: tAt, stoodUp: !!up, upAfterS: up ? +((Date.now() - s1) / 1000).toFixed(1) : null, shots: [sh1, sh2].filter(Boolean), t };
          return H.note(`${id}: after ${tAt}s more idle she rests: pose ${got.pose}, ${got.layers}; stood up again ${row.rest.upAfterS}s later: ${!!up}; ${sh1}${sh2 ? `, ${sh2}` : ''}`);
        });
      }

      // a real click on a body part; the reaction, its clip; when it is back in the idle
      const touch = async (zone) => {
        await idleNow();
        await bubbleGone();
        await sleep(400);
        const z = (await page.evaluate(() => window.PetVRM.director.zoneCenters()))[zone];
        if (!z) return { zone, error: 'no zone on screen' };
        const topEl = await page.evaluate((q) => { const e = document.elementFromPoint(q.x, q.y); return e ? `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${e.classList.length ? `.${[...e.classList].join('.')}` : ''}` : null; }, z);
        const n0 = ((await page.evaluate(() => window.petFx && window.petFx.lastTouch && window.petFx.lastTouch())) || { n: 0 }).n;
        // T-5092: where the click lands, marked on the screenshot (a ring that takes no clicks), and the zone the hit
        // test gives for that point before the click (core/vrm-hit.js over the drawn head: headBox)
        const probe = await page.evaluate((q) => { const f = window.PetVRM.director; const h = f.zoneAt ? f.zoneAt(q.x, q.y) : null; const d = window.PetVRM.debug(); const fig = d && d.figures && d.figures[0]; const m = document.createElement('div'); m.id = 'e2e-click-mark'; Object.assign(m.style, { position: 'fixed', left: `${q.x - 7}px`, top: `${q.y - 7}px`, width: '14px', height: '14px', border: '2px solid #ff2d55', borderRadius: '50%', pointerEvents: 'none', zIndex: 99999, boxSizing: 'border-box' }); document.body.appendChild(m); return { zone: h ? h.zone : null, headBox: fig ? fig.headBox : null }; }, z).catch(() => null);
        const t = await mark(`touch-${zone}`);
        await page.mouse.click(z.x, z.y);
        const getR = () => until(`a reaction to ${zone}`, () => { const p = window.PetVRM.director.plan(); const o = (p.overlays || []).find((x) => x.layer === 'reaction'); return p.reaction ? { slot: p.reaction, id: o ? o.id : null, mask: o ? o.mask : null } : null; }, null, 4000).catch(() => null);
        let r = await getR();
        const last = (await page.evaluate(() => window.petFx && window.petFx.lastTouch && window.petFx.lastTouch())) || { n: 0 };
        let retry = null;
        const onFigure = /^div#pet-look|^canvas/.test(topEl || '');
        if (!r) {
          // a second click a little lower on the same part. It counts as the touch only when the first point was not on
          // her at all (the zone's centre off the figure, e.g. above a tall hat: nothing a user could click); a miss
          // on her stays a failure
          const zc = await page.evaluate(() => window.PetVRM.director.zoneCenters());
          const below = zc.chest ? { x: z.x, y: z.y + (zc.chest.y - z.y) * 0.3 } : { x: z.x, y: z.y + 12 };
          await page.mouse.click(below.x, below.y);
          const r2 = await getR();
          retry = { at: [Math.round(below.x), Math.round(below.y)], reaction: r2, counts: !onFigure };
          if (!onFigure && r2) r = r2;
          await sleep(400);
        }
        await sleep(600);
        const sh = await shot(`${id}-touch-${zone}`);
        await page.evaluate(() => { const m = document.getElementById('e2e-click-mark'); if (m) m.remove(); }).catch(() => {});
        await away();
        let back = true;
        try { await idleNow(); } catch { back = false; }
        await sleep(300);
        return { zone, at: [Math.round(z.x), Math.round(z.y)], hitZone: probe && probe.zone, headBox: zone === 'head' && probe ? probe.headBox : undefined, t, reaction: r, back, shot: sh, topElement: topEl, touchRegistered: last.n > n0, lastTouch: last.zone || last.part || null, onFigure, retry };
      };
      await ST(`${id}：触摸头 / 手 / 肚子（真实点击）→ 反应片段 → 回待机`, async () => {
        const out = [];
        for (const zn of ZONES) out.push(await touch(zn));
        const snap = await page.evaluate(() => window.__vs.samples.slice());
        for (const o of out) {
          if (o.error) continue;
          const tr = firstAfter(snap, o.t, (x) => !!x.reaction);
          if (o.retry && o.retry.counts) o.note = 'first point off the figure; timed from the first click';
          const tEnd = tr !== null ? firstAfter(snap, tr, (x) => !/reaction:/.test(x.overlays || '') && !x.reaction) : null;
          const tIdle = tr !== null ? firstAfter(snap, tr, idleS) : null;
          Object.assign(o, { reactS: tr === null ? null : +(tr - o.t).toFixed(2), reactionEndS: tEnd === null ? null : +(tEnd - o.t).toFixed(2), backToIdleS: tIdle === null ? null : +(tIdle - o.t).toFixed(2) });
        }
        row.touch = out;
        const withClip = out.filter((o) => o.reaction && o.reaction.id);
        row.steps.touch = withClip.length === ZONES.length && out.every((o) => o.back);
        for (const o of out) { if (!o.reaction) fail(`touch ${o.zone}: no reaction`); else if (!o.reaction.id) fail(`touch ${o.zone}: ${o.reaction.slot} without a clip (face only)`); if (!o.back) fail(`touch ${o.zone}: not back to the idle`); }
        const note = H.note(`${id}: ${out.map((o) => `${o.zone}@${o.at} (element ${o.topElement}, touch registered ${o.touchRegistered}${o.retry ? `; the zone centre is ${o.onFigure ? 'on her but missed' : 'off the figure'}: a second click at ${o.retry.at} → ${o.retry.reaction ? `${o.retry.reaction.slot} ${o.retry.reaction.id}` : 'nothing'}${o.retry.counts ? ' (counts as the touch)' : ' (diagnosis only)'}` : ''}) → ${o.reaction ? `${o.reaction.slot} plays ${o.reaction.id || '(no clip)'} [${o.reaction.mask}]` : 'no reaction'}, reaction after ${o.reactS}s, overlay gone ${o.reactionEndS}s, idle ${o.backToIdleS}s after the click`).join(' | ')}`);
        assert.ok(row.steps.touch, row.failures.join('; '));
        return note;
      });

      await ST(`${id}：拖拽拎起（按住拖动）→ 悬空 → 松手放下 → 落地反应 → 回待机`, async () => {
        await idleNow();
        await bubbleGone();
        const zc = await page.evaluate(() => window.PetVRM.director.zoneCenters());
        const c = zc.belly || zc.chest;
        const t = await mark('lift');
        await page.mouse.move(c.x, c.y);
        await page.mouse.down();
        for (let k = 1; k <= 8; k++) { await page.mouse.move(c.x + k * 5, c.y - k * 3); await sleep(40); }
        let lifted = null;
        try { lifted = await until('lifted', () => { const d = document.querySelector('#pet-look canvas.vrm').dataset; return d.hold === 'lift' && /hold:hold\.lift/.test(d.overlays) ? d.overlays : null; }, null, 5000); } catch { lifted = null; }
        for (let k = 0; k < 10; k++) { await page.mouse.move(c.x + 40 + Math.sin(k) * 12, c.y - 24 + Math.cos(k) * 6); await sleep(80); }
        const up = await shot(`${id}-lifted`);
        const kneesUp = await page.evaluate(() => { const p = window.PetVRM.director.pose(); return [p.legs.left && p.legs.left.knee, p.legs.right && p.legs.right.knee]; });
        const tDrop = await mark('drop');
        await page.mouse.up();
        let drop = null;
        try { drop = await until('react.drop', () => { const p = window.PetVRM.director.plan(); const o = (p.overlays || []).find((x) => x.layer === 'reaction'); return p.reaction && /drop|land/.test(p.reaction) ? { slot: p.reaction, id: o ? o.id : null } : null; }, null, 4000); } catch { drop = null; }
        await sleep(400);
        const dn = await shot(`${id}-dropped`);
        await away();
        let back = true;
        try { await idleNow(); } catch { back = false; }
        await sleep(300);
        const snap = await page.evaluate(() => window.__vs.samples.slice());
        const tIdle = firstAfter(snap, tDrop + 0.2, idleS);
        row.drag = { lifted, kneesUp, drop, back, liftS: (() => { const x = firstAfter(snap, t, (s) => s.hold === 'lift'); return x === null ? null : +(x - t).toFixed(2); })(), backToIdleS: tIdle === null ? null : +(tIdle - tDrop).toFixed(2), shots: [up, dn] };
        row.steps.drag = !!lifted && !!drop && back;
        if (!lifted) fail('drag: not lifted (no hold.lift clip)');
        if (!drop) fail('drag: no landing reaction');
        if (!back) fail('drag: not back to the idle');
        if (Math.min(...kneesUp.filter((x) => typeof x === 'number')) < -10) fail(`drag: a knee bends backwards while held (${kneesUp})`);
        const note = H.note(`${id}: lifted after ${row.drag.liftS}s, overlays ${lifted}, knees ${JSON.stringify(kneesUp)}; dropped → ${drop ? `${drop.slot} plays ${drop.id}` : 'no reaction'}; idle ${row.drag.backToIdleS}s after letting go; ${up}, ${dn}`);
        assert.ok(row.steps.drag, row.failures.join('; '));
        return note;
      });

      await ST(`${id}：说话（POST /say）→ 说话手势片段轮换 → 说完回待机`, async () => {
        await idleNow();
        await bubbleGone();
        const t = await mark('talk');
        const r = await api('POST', '/say', { text: '今天天气真好呀，我们一起出去走走吧！你想去公园还是去海边呢？我都可以哦，只要和你在一起就好。' });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        let talk = null;
        try { talk = await until('talking', () => { const d = document.querySelector('#pet-look canvas.vrm').dataset; return d.hold === 'talk' && /talk/.test(d.overlays) ? d.overlays : null; }, null, 6000); } catch { talk = null; }
        await sleep(1200);
        const s1 = await shot(`${id}-talk-1`);
        await sleep(2500);
        const s2 = await shot(`${id}-talk-2`);
        let back = true;
        try { await idleNow(40000); } catch { back = false; }
        await sleep(300);
        const snap = await page.evaluate(() => window.__vs.samples.slice());
        const talkClips = [...new Set(snap.filter((x) => x.t >= t && x.hold === 'talk').flatMap((x) => (x.overlays || '').split(',').filter((o) => /talk/.test(o)).map((o) => o.split(':')[1])))];
        const tEnd = (() => { const last = snap.filter((x) => x.t >= t && x.hold === 'talk').pop(); return last ? last.t : null; })();
        const tIdle = tEnd !== null ? firstAfter(snap, tEnd, idleS) : null;
        row.talk = { overlays: talk, talkClips, back, backToIdleS: tIdle === null ? null : +(tIdle - tEnd).toFixed(2), shots: [s1, s2] };
        row.steps.talk = !!talk && back;
        if (!talk) fail('talk: no talk clip laid over');
        if (!back) fail('talk: not back to the idle');
        const note = H.note(`${id}: talking → ${talk}; talk clips ${talkClips.join(', ')}; idle ${row.talk.backToIdleS}s after the talk hold ended; ${s1}, ${s2}`);
        assert.ok(row.steps.talk, row.failures.join('; '));
        return note;
      });

      await ST(`${id}：跳一支舞（POST /dance）→ 中途 Esc 打断 → 交叉淡回待机`, async () => {
        await idleNow();
        await bubbleGone();
        const pick = libDances.length ? libDances[i % libDances.length] : null;
        const t = await mark('dance');
        const r = await api('POST', '/dance', pick ? { id: pick.id } : {});
        assert.equal(r.status, 200, JSON.stringify(r.json));
        let on = null;
        try { on = await until('dancing', () => { const d = document.querySelector('#pet-look canvas.vrm').dataset; return d.dance && d.danceState === 'on' ? { dance: d.dance, layers: d.layers } : null; }, null, 15000); } catch { on = null; }
        await sleep(2500);
        const d1 = await shot(`${id}-dance-1`);
        await sleep(2500);
        const d2 = await shot(`${id}-dance-2`);
        const tStop = await mark('dance-stop');
        await page.bringToFront().catch(() => {});
        await page.keyboard.press('Escape');
        await sleep(400);
        let how = 'Esc';
        const still = await page.evaluate(() => !!document.querySelector('#pet-look canvas.vrm').dataset.dance && document.querySelector('#pet-look canvas.vrm').dataset.danceState === 'on');
        if (still) { how = 'POST /dance/stop (Esc did not stop it)'; await api('POST', '/dance/stop'); }
        let back = true;
        try { await idleNow(); } catch { back = false; }
        await sleep(600);
        const after = await shot(`${id}-after-dance`);
        const snap = await page.evaluate(() => window.__vs.samples.slice());
        const tIdle = firstAfter(snap, tStop, (x) => idleS(x) && !/dance/.test(x.layers || ''));
        const kneesMin = Math.min(...snap.filter((x) => x.t >= t && x.t <= tStop).flatMap((x) => x.knees).filter((x) => typeof x === 'number'));
        row.dance = { id: r.json.id, name: r.json.name, on, how, back, backToIdleS: tIdle === null ? null : +(tIdle - tStop).toFixed(2), kneesMin, shots: [d1, d2, after] };
        row.steps.dance = !!on && back;
        if (!on) fail('dance: did not start');
        if (!back) fail('dance: not back to the idle after the stop');
        const note = H.note(`${id}: POST /dance → ${r.json.id} (${r.json.name}); dancing ${JSON.stringify(on)}; stopped by ${how}; idle (no dance layer) ${row.dance.backToIdleS}s after the stop; knees min while dancing ${kneesMin}°; ${d1}, ${d2}, ${after}`);
        assert.ok(row.steps.dance, row.failures.join('; '));
        return note;
      });

      await ST(`${id}：切换处相邻帧最大角度跳变（跳变计，每次切换 spike ≤ ${SPIKE_MAX}°/帧@30fps）`, async () => {
        await sleep(1800);
        const j = (await fig()).jump;
        series = await takeSampler();
        // the dance's tail fades over the next idle for a while (at a low frame rate past the snapshot the dance step
        // took): its time from the whole series
        if (row.dance && row.dance.backToIdleS === null) { const m = series.marks.filter((x) => x.name === 'dance-stop').pop(); const x = m && series.samples.find((y) => y.t >= m.t && idleS(y) && !/dance/.test(y.layers || '')); if (x) { row.dance.backToIdleS = +(x.t - m.t).toFixed(2); row.dance.fromSeries = true; } }
        const tr = j.transitions.filter((w) => w.at >= tModel && !/cut/.test(w.what));
        const kindOf = (w) => (/dance (on|in)→out|dance out→off/.test(w.what) ? '舞蹈结束→idle' : /dance (off→cueing|cueing→in|in→on)/.test(w.what) ? 'idle→舞蹈' : /reaction→none/.test(w.what) ? '反应结束→idle' : /reaction→react/.test(w.what) ? 'idle→反应（触摸/落地）' : /hold\.lift/.test(w.what) ? '拎起/放下' : /talk/.test(w.what) ? '说话手势' : /^base→/.test(w.what) ? 'idle 片段轮换/姿势切换' : '其他叠加层');
        const byKind = {};
        for (const w of tr) { const k = kindOf(w); const e = byKind[k] || (byKind[k] = { n: 0, spikeMax: 0, speedMax: 0, worst: null }); e.n++; if (w.spike >= e.spikeMax) { e.spikeMax = w.spike; e.worst = `${w.what} ${w.spikeBone}`; } e.speedMax = Math.max(e.speedMax, w.speed); }
        const mx = tr.length ? Math.max(...tr.map((w) => w.spike)) : 0;
        const worst = tr.slice().sort((a, b) => b.spike - a.spike).slice(0, 3);
        row.jump = { unit: j.unit, frames: j.frames, late: j.late, transitions: tr.length, spikeMax: mx, bodySpikeMax: tr.length ? Math.max(...tr.map((w) => w.bodySpike)) : 0, speedMaxInWindows: tr.length ? Math.max(...tr.map((w) => w.speed)) : 0, steadyP99: j.p99, byKind, worst: worst.map((w) => ({ what: w.what, spike: w.spike, bone: w.spikeBone, speed: w.speed, before: w.before })) };
        row.transitionsRaw = tr;
        row.steps.jump = tr.length >= 6 && mx <= SPIKE_MAX;
        for (const w of tr) if (w.spike > SPIKE_MAX) fail(`snap: ${w.what} spike ${w.spike}°/frame on ${w.spikeBone}`);
        const note = H.note(`${id}: ${tr.length} transitions, spike max ${mx}° (body ${row.jump.bodySpikeMax}°) / limit ${SPIKE_MAX}°/frame@30fps; by kind ${Object.entries(byKind).map(([k, e]) => `${k} ×${e.n} spike≤${e.spikeMax}° speed≤${e.speedMax}°`).join('; ')}; worst ${worst.map((w) => `${w.what} ${w.spike}° ${w.spikeBone}`).join(' | ')}`);
        assert.ok(row.steps.jump, `${tr.length} transitions; ${row.failures.join('; ')}`);
        return note;
      });
      if (!series) series = await takeSampler().catch(() => null);
      if (series) fs.writeFileSync(path.join(SHOTS, `verify-${id}-series.json`), JSON.stringify(series));
      // arms spread level like a T-pose, from any clip (not a dance / reaction): a distortion, the model fails
      if (series) {
        row.tpose = M.tposeIntervals(series.samples);
        // T-5092: every 100 ms sample with both arms level (outside dance / reaction / hold), however short
        row.tposeSamples = M.tposeSamples(series.samples);
        for (const v of row.tpose) fail(`T-pose arms for ${v.seconds}s on ${v.base} (elevation ${v.maxElev}°)`);
      }
      // before the fix: the same metrics on the T-5079 series of this model (none = a user's machine; env = the
      // old 22-clip library linked by hand), when the diagnosis had it
      row.baseline = {};
      for (const mode of ['none', 'env']) {
        const f = path.join(BASE, mode, id, 'idle-series.json');
        if (!fs.existsSync(f)) continue;
        const raw = JSON.parse(fs.readFileSync(f, 'utf8')).map((x) => (typeof x.base === 'string' && x.base.startsWith('{') ? (() => { const b = JSON.parse(x.base); return { ...x, base: b.id, file: b.file }; })() : x));
        const m = M.idleMetrics(raw);
        row.baseline[mode] = { samples: m.samples, seconds: m.seconds, hitRatio: m.hitRatio, distinctClips: m.distinctClips, switches: m.switches, movingBones: m.movingBones, meanSpeedAll: m.meanSpeedAll, key9RangeSum: m.key9RangeSum, dominantShareMedian: m.dominantShareMedian, singleSineBones: m.singleSineBones, stillBones: m.stillBones, upperArmSpeed: m.bones.leftUpperArm && m.bones.leftUpperArm.speedMean, headSpeed: m.bones.head && m.bones.head.speedMean };
      }
      row.passed = row.failures.length === 0 && Object.values(row.steps).every(Boolean) && Object.keys(row.steps).length === 6;
    }

    await ST(`全部模型的结论（失败的模型记为失败，不略过）；无控制台错误`, async () => {
      const lines = summary.map((r) => `${r.id}: ${r.passed ? 'PASS' : 'FAIL'} — vrm ${r.vrm}, style ${r.style && r.style.name}, ${r.clips} clips; idle ${r.idle ? `${(r.idle.hitRatio * 100).toFixed(1)}% / ${r.idle.distinctClips} clips` : '-'}; spike max ${r.jump ? r.jump.spikeMax : '-'}°${r.failures.length ? `; failures: ${r.failures.join('; ')}` : ''}`);
      const real = realErrors(errors).filter((e) => !/\[vrm\]/.test(e));
      const note = H.note(`${lines.join('\n')}\nconsole errors: ${real.length}`);
      assert.ok(summary.length >= Math.min(5, IDS.length), `${summary.length} models`); // (a PIXELPET_E2E_VERIFY_IDS subset: all of them)
      assert.deepEqual(real, [], real.join('\n'));
      assert.ok(summary.every((r) => r.passed), summary.filter((r) => !r.passed).map((r) => r.id).join(', '));
      return note;
    });
  } finally {
    const vpath = page.video() ? await page.video().path().catch(() => null) : null;
    await app.close().catch(() => {});
    server.close();
    let video = null;
    if (vpath && fs.existsSync(vpath)) { video = 'vrm/verify.webm'; fs.copyFileSync(vpath, path.join(SHOTS, 'verify.webm')); }
    fs.writeFileSync(path.join(SHOTS, 'verify-summary.json'), JSON.stringify({ spikeMax: SPIKE_MAX, idleSeconds: IDLE_S, library: LIB, baseline: BASE, models: summary.map((r) => ({ ...r, transitionsRaw: undefined })) }, null, 2));
    fs.writeFileSync(path.join(SHOTS, 'verify-transitions.json'), JSON.stringify(Object.fromEntries(summary.map((r) => [r.id, r.transitionsRaw || []])), null, 2));
    fs.writeFileSync(path.join(SHOTS, 'verify-evidence.json'), JSON.stringify({ chapters, evidence, video, errors: realErrors(errors) }, null, 2));
  }
};
