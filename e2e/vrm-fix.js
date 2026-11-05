'use strict';

// vrmfix (T-5098): the store VRMs through the real app (store mirror → 下载 → 切换, the motion library linked in the
// console), for the fixes of T-5098:
//   hit    — six body parts × six models: a real click on each part's visible centre (e2e/vrm-hit-truth.js: the
//            rasterised mesh, not the touch zones) and the part the app recognised (petFx.lastTouch().zone, what it
//            reacts to) → the 6×6 matrix. The butt is clicked with her back to the camera (PetVRM.director.yaw(180)).
//   rest   — a hips-on-floor model (Wanderer) sitting and crouching (the posture setting), feet / seat on the floor
//   cheer  — react.cheer (and the idle that replaced penguin_stand) on several models, the arms sampled through it
//   spikes — the jump meter before the output limiter (raw) and after it, over the moments T-5097 found capped
//
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js vrmfix
//
// Env: PIXELPET_E2E_STORE_DIR, PIXELPET_E2E_MOTIONS, PIXELPET_E2E_VERIFY_IDS (as vrmverify), PIXELPET_E2E_FIX_PARTS
// (default hit,rest,cheer,spikes). Evidence: out/e2e/vrm/fix-*.png, fix-hit-matrix.{json,md}, fix-rest.json,
// fix-cheer.json, fix-spikes.json.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { visibleParts } = require('./vrm-hit-truth');

const NAMES = { 'vrm-d8789c38': '莉莉雅', 'vrm-wanderer': 'Wanderer', 'vrm-a185cf3a': '試作1', 'vrm-paimon': 'paimon', 'vrm-diona': 'Diona', 'vrm-vrchat-avatar': 'Vrchat Avatar' };
const PARTS = (process.env.PIXELPET_E2E_HIT_PARTS || 'head,face,hands,belly,legs,butt').split(',');
const LABEL = { head: '头', face: '脸', hands: '手', belly: '肚子', legs: '腿', butt: '屁股' };

module.exports = async function vrmFix(ctx) {
  const { SHOTS, step, launch, sleep, dataDir, helpers, watchErrors, realErrors } = ctx;
  const S = 'vrmfix';
  const home = os.homedir();
  const STORE = process.env.PIXELPET_E2E_STORE_DIR || path.join(home, 'vrm-assets', 'store', 'vrm');
  const LIB = process.env.PIXELPET_E2E_MOTIONS || path.join(home, 'vrm-assets', 'baked-v2');
  // T-5099: a click aims at least HIT_DEPTH px inside the part's visible area (a 2 px sliver of belly between the
  // coat and the arms moves onto the chest with the idle's next frame); waits ≤ 20 s for it like for a hidden part
  const HIT_DEPTH = Number(process.env.PIXELPET_E2E_HIT_DEPTH || 4);
  const IDS = (process.env.PIXELPET_E2E_VERIFY_IDS || 'vrm-d8789c38,vrm-wanderer,vrm-a185cf3a,vrm-paimon,vrm-diona,vrm-vrchat-avatar').split(',').filter(Boolean);
  const DO = new Set((process.env.PIXELPET_E2E_FIX_PARTS || 'hit,rest,cheer,spikes').split(','));
  if (!fs.existsSync(STORE) || !fs.existsSync(path.join(LIB, 'library.json'))) {
    await step(S, 'store mirror and motion library present', async () => { throw new Error(`needs ${STORE} and ${LIB}/library.json (outside the repository)`); }, null);
    return;
  }
  const OUTD = SHOTS;
  const writeJson = (f, o) => fs.writeFileSync(path.join(OUTD, f), JSON.stringify(o, null, 2));
  const server = http.createServer((req, res) => {
    const f = path.join(STORE, path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = 7800 + Math.floor(Math.random() * 400);
  const TOKEN = `e2e-fix-${Math.random().toString(36).slice(2, 12)}-token`;
  const { env } = dataDir('vrmfix', { ageConfirmed: true, ageConfirmedAt: Date.now(), prefs: { roam: false }, api: { enabled: true, port: PORT, token: TOKEN } });
  Object.assign(env, { PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/vrm`, PIXELPET_CATALOG_PREINSTALLED: '', PIXELPET_VRM_MOTIONS_DIR: '', PIXELPET_VRM_DANCES_DIR: '' });
  const { app, page } = await launch(env);
  const errors = watchErrors(page);
  const H = helpers(page, 'fix', [], app);
  const A = H.A;
  let broken = null;
  const ST = async (name, fn, { setup = false } = {}) => {
    if (broken) return step(S, name, async () => { throw new Error(`skipped: ${broken} failed`); }, null);
    let failed = false;
    await step(S, name, async () => { try { return await fn(); } catch (e) { failed = true; throw e; } }, page);
    if (failed && setup) broken = name;
    return !failed;
  };
  const until = async (what, fn, arg, ms = 20000) => { const s0 = Date.now(); for (;;) { const v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; if (Date.now() - s0 > ms) throw new Error(`timed out: ${what}`); await sleep(100); } };
  const isIdle = () => { const c = document.querySelector('#pet-look canvas.vrm'); return !!(c && c.dataset.action === 'idle' && !c.dataset.manual && !c.dataset.reaction && !c.dataset.hold && !c.dataset.dance); };
  const idleNow = (ms = 25000) => until('back to the idle', isIdle, null, ms);
  const bubbleGone = () => until('the bubble gone', () => document.getElementById('bubble').classList.contains('hidden'), null, 30000).catch(() => {});
  const away = async () => { await page.mouse.move(4, 4); await page.evaluate(() => document.documentElement.dispatchEvent(new MouseEvent('mouseleave'))); };
  const api = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${PORT}/pixel-pet${p}`, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const routes = {};
  const result = { hit: {}, rest: {}, cheer: {}, spikes: {} };
  try {
    await ST('启动：孵化、从商店下载模型、关联动作库 baked-v2', async () => {
      await H.hatch();
      await A.go('/store');
      await A.until(() => !!document.querySelector('[data-catalog-grid]'), null, 30000, 'the store grid');
      for (const id of IDS) {
        await A.until((x) => !!document.querySelector(`[data-download="${x}"]`) || !!document.querySelector(`[data-downloaded="${x}"]`), id, 20000, `download ${id}`);
        await A.win.evaluate((x) => { const b = document.querySelector(`[data-download="${x}"]`); if (b) { b.scrollIntoView({ block: 'center' }); b.click(); } }, id);
        await A.until((x) => !!document.querySelector(`[data-downloaded="${x}"]`), id, 300000, `installed ${id}`);
        routes[id] = await A.win.evaluate((x) => { const a = document.querySelector(`[data-store-open="${x}"]`); return a ? a.getAttribute('href').replace(/^#/, '') : `/characters/${x}`; }, id);
      }
      const cid = await switchTo(IDS[0]);
      await page.evaluate((p) => window.pet.debugNextOpen(p), LIB);
      await A.lookTab(cid);
      await A.until(() => !!document.querySelector('[data-motion-pick]'), null, 20000, '选择动作库文件夹');
      await A.click('[data-motion-pick]');
      await A.until(() => Number((document.querySelector('[data-motion-lib]') || {}).dataset?.motionFiles || 0) > 0, null, 20000, 'the library linked');
      await until('redrawn with the library', () => { const f = window.PetVRM && window.PetVRM.debug().figures[0]; return f && f.loaded && /^(loaded|partial)/.test(f.library) && f.clips.length > 20; }, null, 120000);
      return `downloaded ${JSON.stringify(routes)}; library ${LIB}`;
    }, { setup: true });

    async function switchTo(id) {
      const route = routes[id];
      const cid = route.split('/').pop();
      await A.go(route);
      await A.until((x) => !!document.querySelector(`[data-switch="${x}"]`) || !!document.querySelector(`[data-current="${x}"]`), cid, 20000, `her page ${cid}`);
      await A.win.evaluate((x) => { const b = document.querySelector(`[data-switch="${x}"]`); if (b) b.click(); }, cid);
      await sleep(600);
      await A.win.evaluate(() => { if (!document.querySelector('[data-meet-name]')) return; const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '初次见面' && !x.dataset.switch); if (b) b.click(); });
      await until(`${id} drawn`, (x) => { const f = window.PetVRM && window.PetVRM.debug().figures[0]; const c = document.querySelector('#pet-look canvas.vrm'); return f && String(f.packId).startsWith(x) && f.loaded && f.plan && c && Number(c.dataset.frame) > 10 && c.dataset.library; }, id, 120000);
      await page.bringToFront().catch(() => {});
      return cid;
    }
    const mark = (q, color = '#ff2d55') => page.evaluate(([p, c]) => { const m = document.createElement('div'); m.className = 'e2e-click-mark'; Object.assign(m.style, { position: 'fixed', left: `${p.x - 7}px`, top: `${p.y - 7}px`, width: '14px', height: '14px', border: `2px solid ${c}`, borderRadius: '50%', pointerEvents: 'none', zIndex: 99999, boxSizing: 'border-box' }); document.body.appendChild(m); }, [q, color]);
    const unmark = () => page.evaluate(() => document.querySelectorAll('.e2e-click-mark').forEach((m) => m.remove())).catch(() => {});

    for (const id of IDS) {
      const name = NAMES[id] || id;
      await ST(`${name}（${id}）：切换为当前角色`, async () => {
        if (id !== IDS[0] || true) await switchTo(id);
        await sleep(2500);
        const f = await H.fig();
        return `VRM ${(await H.ds()).vrm}, style ${JSON.stringify(f.style)}, ${f.clips.length} clips, rootHips ${!!(f.boneFold && f.boneFold.rootHips)}, hipsRig ${JSON.stringify(f.hipsRig)}, partBoxes ${Object.keys(f.partBoxes || {}).length}`;
      });

      // T-5099: the head's visible centre against the app's zone over a stretch of idle (no click): the head/face
      // split on every pose of the idle, not one moment
      if (DO.has('headprobe')) {
        await ST(`${name}：头部可见中心逐帧判定（idle ${process.env.PIXELPET_E2E_PROBE_S || 60} s，不点击）`, async () => {
          await idleNow(40000).catch(() => {});
          await bubbleGone();
          await page.mouse.move(230, 30);
          const rows = [];
          const s0 = Date.now();
          while (Date.now() - s0 < Number(process.env.PIXELPET_E2E_PROBE_S || 60) * 1000) {
            // the truth and the app's zone in one task: the same frame (no render, no spring-bone step in between)
            const both = await page.evaluate(`(() => { const truth = (${visibleParts.toString()})({ parts: ['head', 'face'] }); const out = [];
              for (const part of ['head', 'face']) { const c = truth.centres && truth.centres[part]; if (!c) continue;
                const r = window.PetVRM.director.zoneAt(c.x, c.y, { precise: true }); const c2 = document.querySelector('#pet-look canvas.vrm');
                out.push({ part, at: [c.x, c.y], px: c.px, depth: c.depth, ...(r ? { zone: r.zone, mesh: r.mesh, via: r.via, dbg: r.dbg, base: c2 && c2.dataset.layers } : {}) }); }
              return out; })()`);
            for (const x of both) rows.push({ t: +((Date.now() - s0) / 1000).toFixed(1), ...x });
            await sleep(400);
          }
          writeJson(`fix-headprobe-${id}.json`, rows);
          const bad = rows.filter((r) => r.zone !== r.part);
          return `${name}: ${rows.length} probes, wrong ${bad.length}: ${bad.slice(0, 6).map((r) => `${r.part}@${r.at}→${r.zone} q${JSON.stringify(r.dbg && r.dbg.faceQ)} box${JSON.stringify(r.dbg && r.dbg.faceBox)}`).join(' | ')}`;
        });
      }

      if (DO.has('hit')) {
        await ST(`${name}：在头 / 脸 / 手 / 肚子 / 腿 / 屁股的可见中心各真实点击一次 → 识别出的部位必须等于点击的部位`, async () => {
          const row = {};
          await idleNow(40000).catch(() => {});
          await bubbleGone();
          for (const part of PARTS) {
            const back = part === 'butt';
            await idleNow().catch(() => {});
            await bubbleGone();
            await page.evaluate((y) => window.PetVRM.director.yaw(y), back ? 180 : 0);
            await page.mouse.move(230, 30); // inside her window (attention: no rest posture), off her
            await sleep(back ? 1200 : 500);
            await bubbleGone();
            // (her back square to the camera: her own turn — the director's facingYaw — settled near 0, ≤ 8 s)
            if (back) await until('facing settled', () => Math.abs((window.PetVRM.director.plan() || {}).facingYaw || 0) < 8, null, 8000).catch(() => {});
            // (a part can be hidden for a moment — hands clasped behind a prop, under a sleeve: wait until it shows, ≤ 20 s)
            let truth = await page.evaluate(visibleParts, { parts: [part] });
            for (let k = 0; k < 20 && !(truth.centres && truth.centres[part] && truth.centres[part].px >= 12 && truth.centres[part].depth >= HIT_DEPTH); k++) { await sleep(1000); truth = await page.evaluate(visibleParts, { parts: [part] }); }
            const c = truth.centres && truth.centres[part];
            if (!c) { row[part] = { clicked: part, recognised: null, error: `no visible ${part} (${JSON.stringify(truth.counts)}; body ${JSON.stringify(truth.countsB)}; ${JSON.stringify(truth.band)}; why ${JSON.stringify(truth.centres.buttWhy || null)})` }; await page.evaluate(() => window.PetVRM.director.yaw(0)); continue; }
            const probe = await page.evaluate((q) => { const h = window.PetVRM.director.zoneAt(q.x, q.y, { precise: true }); return h ? `${h.zone} (${h.via}${h.mesh ? `: ${h.mesh}` : ''}${h.dbg ? ` ${JSON.stringify(h.dbg)}` : ''})` : null; }, c);
            const n0 = ((await page.evaluate(() => window.petFx.lastTouch())) || { n: 0 }).n;
            await page.mouse.click(c.x, c.y);
            let got = null;
            const s0 = Date.now();
            while (Date.now() - s0 < 3000) { const lt = await page.evaluate(() => window.petFx.lastTouch()); if (lt && lt.n > n0) { got = lt; break; } await sleep(50); }
            const plan = await page.evaluate(() => { const p = window.PetVRM.director.plan(); const o = (p.overlays || []).find((x) => x.layer === 'reaction'); return { reaction: p.reaction || null, clip: o ? o.id : null }; });
            await mark(c, got && got.zone === part ? '#34c759' : '#ff2d55');
            await sleep(500);
            const shot = await H.shot(`hit-${id}-${part}`);
            await unmark();
            row[part] = { clicked: part, at: [c.x, c.y], cover: c.cover, visiblePx: c.px, edgeDepthPx: c.depth, probe, recognised: got ? got.zone : null, reaction: plan.reaction, clip: plan.clip, ok: !!got && got.zone === part, shot };
            await page.evaluate(() => window.PetVRM.director.yaw(0));
          }
          result.hit[id] = row;
          writeJson('fix-hit-matrix.json', result.hit);
          const bad = PARTS.filter((p) => !row[p] || !row[p].ok);
          const line = PARTS.map((p) => `${LABEL[p]}→${row[p] ? row[p].recognised : '-'}${row[p] && row[p].ok ? '✓' : '✗'}`).join(' ');
          assert.ok(!bad.length, `${name}: ${line}`);
          return `${name}: ${line}`;
        });
      }

      if (DO.has('cheer') && (process.env.PIXELPET_E2E_CHEER_IDS || 'vrm-wanderer,vrm-vrchat-avatar,vrm-d8789c38').split(',').includes(id)) {
        await ST(`${name}：欢呼反应（与 T-5097 同一路径：待机里的 cue 提示 → react.cheer）——双臂举过头顶、不再半权重平举`, async () => {
          await idleNow(40000).catch(() => {});
          await bubbleGone();
          await away();
          // the cue cheers 35 % of the time (core/vrm-director.js): sent until it does
          let r = null;
          for (let k = 0; k < 80 && !r; k++) {
            await page.evaluate(() => window.PetVRM.director.inject({ type: 'cue', name: 'play' }));
            await sleep(150);
            // (the cheer slot draws a variant — a clap, an excited emote —: the same clip on every model, react.cheer@style)
            r = await page.evaluate(() => { const p = window.PetVRM.director.plan(); const o = (p.overlays || []).find((x) => x.layer === 'reaction'); return p.reaction === 'react.cheer' && o && /^react\.cheer@/.test(o.id) ? { id: o.id } : null; });
            if (!r) { await idleNow().catch(() => {}); await sleep(300); }
          }
          assert.ok(r, 'no cue cheer (react.cheer@…) in 80 cues');
          const samples = []; const s0 = Date.now(); let shot = null; let best = -999;
          while (Date.now() - s0 < 3600) {
            const x = await page.evaluate(() => { const p = window.PetVRM.director.plan(); const o = (p.overlays || []).find((y) => y.layer === 'reaction'); const po = window.PetVRM.director.pose(); return { t: performance.now(), w: o ? o.weight : 0, id: o ? o.id : null, l: po.arms.left && po.arms.left.elev, r: po.arms.right && po.arms.right.elev }; });
            samples.push({ s: +((Date.now() - s0) / 1000).toFixed(2), w: x.w, l: x.l, r: x.r });
            const e = Math.min(x.l, x.r);
            if (e > best && x.w > 0.5 && !shot && e > 30) { best = e; shot = await H.shot(`cheer-${id}-overhead`); }
            await sleep(100);
          }
          const during = samples.filter((x) => x.w > 0.5);
          const maxW = Math.max(...samples.map((x) => x.w));
          const maxElev = Math.max(...during.map((x) => Math.min(x.l, x.r)));
          // the T-5097 shape: both arms near level (−15°..+15°) for ≥ 1 s while the reaction is on
          let run = 0; let longest = 0; let prev = null;
          for (const x of during) { const lvl = Math.abs(x.l) < 15 && Math.abs(x.r) < 15; if (lvl) { run += prev ? x.s - prev.s : 0; longest = Math.max(longest, run); } else run = 0; prev = x; }
          if (!shot) shot = await H.shot(`cheer-${id}-end`);
          result.cheer[id] = { clip: r.id, maxWeight: maxW, maxElevBoth: maxElev, levelRunS: +longest.toFixed(2), samples, shot };
          writeJson('fix-cheer.json', result.cheer);
          assert.ok(maxW > 0.9, `the cue cheer plays at weight ${maxW} (T-5097: 0.58)`);
          assert.ok(longest < 0.6, `both arms held level ${longest} s`);
          return `${name}: ${r.id} — weight up to ${maxW.toFixed(2)}, both upper arms up to ${maxElev}° above level, level run ${longest.toFixed(2)} s; ${shot}`;
        });
      }
      if (DO.has('gallery')) {
        await ST(`${name}：动作对照（POST /motion {id}）`, async () => {
          const out = [];
          const style = (await H.fig()).style.set;
          for (const cid of (process.env.PIXELPET_E2E_GALLERY || 'crouch.v01,crouch.v02,crouch.v03,sit.v01,sit.rest').split(',')) {
            const clip = `${cid}@${style}`;
            await page.mouse.move(230, 30);
            const r = await api('POST', '/motion', { id: clip, loop: true });
            if (r.status !== 200) { out.push(`${clip}: ${r.status}`); continue; }
            await sleep(3500);
            await bubbleGone();
            const sh = await H.shot(`gallery-${id}-${cid}`);
            const po = await page.evaluate(() => window.PetVRM.director.pose());
            out.push(`${clip}: arms ${JSON.stringify(po.arms)} ${sh}`);
            await api('POST', '/motion/stop', {});
            await sleep(1500);
          }
          return out.join(' | ');
        });
      }
      if (DO.has('rest') && (process.env.PIXELPET_E2E_REST_IDS || 'vrm-wanderer').split(',').includes(id)) {
        // her floor contact now: the lowest skinned vertex vs the floor line (the shadow / seat's floor), the hip
        // joints' and ankles' height, the seat (sit): all in metres and × her height
        const ground = () => page.evaluate(() => {
          const H = window.PetVRM.director.handles(); const { vrm, THREE: T } = H;
          vrm.scene.updateMatrixWorld(true);
          const v = new T.Vector3(); let minY = Infinity; let maxY = -Infinity;
          // (her body: vertices skinned mostly to humanoid bones; cloth and hair on spring bones do not collide with the
          // floor in any model and are reported apart: clothLowest)
          const spring = new Set(); if (vrm.springBoneManager) for (const j of vrm.springBoneManager.joints) if (j.bone) spring.add(j.bone);
          const isCloth = (b) => { for (let p = b; p; p = p.parent) if (spring.has(p)) return true; return false; };
          let clothMin = Infinity;
          vrm.scene.traverse((o) => { if (!o.isSkinnedMesh || !o.visible) return; const g = o.geometry; const n = g.attributes.position.count; const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight; const cloth = o.skeleton.bones.map(isCloth); const st = Math.max(1, Math.floor(n / 20000)); for (let i = 0; i < n; i += st) { let best = 0; let bw = -1; for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } } o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld); if (cloth[best]) { if (v.y < clothMin) clothMin = v.y; continue; } if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y; } });
          const f = window.PetVRM.debug().figures[0];
          const floor = f.props && f.props.seat ? f.props.seat.floor : 0;
          const W = (n) => { const b = vrm.humanoid.getNormalizedBoneNode(n); return b ? b.getWorldPosition(new T.Vector3()) : null; };
          const lu = W('leftUpperLeg'); const ru = W('rightUpperLeg'); const lf = W('leftFoot'); const rf = W('rightFoot'); const hb = W('hips');
          const h = f.hipsRig ? f.hipsRig.height : null;
          const r3 = (x) => +x.toFixed(3);
          return { floor: r3(floor), lowestVertex: r3(minY), gap: r3(minY - floor), clothGap: Number.isFinite(clothMin) ? r3(clothMin - floor) : null, height: r3(maxY - minY), hipJointsY: r3((lu.y + ru.y) / 2 - floor), anklesY: r3(Math.min(lf.y, rf.y) - floor), hipsBoneY: r3(hb.y - floor), legRigHeight: h, seat: f.props && f.props.seat, pose: document.querySelector('#pet-look canvas.vrm').dataset.pose, base: f.plan && f.plan.base ? f.plan.base.id : null };
        });
        // crouching her feet are on the floor (the lowest body vertex within ~2.5 cm of it); sitting she is on the seat
        // (it stands on the floor, its top just under her hip joints: a stool or, sitting on the floor, a cushion), her
        // feet may hang; nothing of her body goes through the floor either way
        const tol = 0.025;
        const restOk = (g) => {
          if ((g.pose || '').startsWith('sit')) {
            const top = g.seat ? g.seat.top - g.floor : null;
            const under = top === null ? null : g.hipJointsY - top;
            return { ok: g.gap >= -tol && !!(g.seat && g.seat.visible && g.seat.k > 0.9) && under > 0 && under < 0.3 * (g.legRigHeight || 1), why: `sit: lowest body vertex ${g.gap} m (≥ −${tol}), seat top ${top === null ? '-' : top.toFixed(3)} m under her hip joints ${g.hipJointsY} m` };
          }
          return { ok: Math.abs(g.gap) <= tol, why: `crouch: lowest body vertex ${g.gap} m from the floor (|·| ≤ ${tol})` };
        };
        await ST(`${name}：hips 贴地模型的休息姿势——自动待机里自己坐下或蹲下（导演时钟 ×10），按腿骨链推算的髋高`, async () => {
          const f = await H.fig();
          await page.evaluate(() => window.PetVRM.director.speed(10));
          await away();
          let got = null; const s0 = Date.now();
          while (Date.now() - s0 < 90000) { got = await page.evaluate(() => { const c = document.querySelector('#pet-look canvas.vrm'); return c && /^(sit|crouch)/.test(c.dataset.pose || '') ? c.dataset.pose : null; }); if (got) break; await sleep(300); }
          // (back to the real clock at once: at ×10 the bout itself would be over in 2–3 s)
          await page.evaluate(() => window.PetVRM.director.speed(1));
          await sleep(2500);
          await bubbleGone();
          const g = got ? await ground() : null;
          const sh = await H.shot(`rest-${id}-auto-${got || 'none'}`);
          await page.evaluate(() => window.PetVRM.director.speed(1));
          result.rest[id] = { ...(result.rest[id] || {}), libraryLegRig: f.libraryInfo && f.libraryInfo.legRig, hipsRig: f.hipsRig, sitClips: f.clips.filter((x) => /^(sit|crouch|lay)\./.test(x)), auto: { pose: got, ground: g, shot: sh } };
          writeJson('fix-rest.json', result.rest);
          assert.ok(got, 'no sit / crouch within 90 s (×10 clock)');
          const ok = restOk(g);
          result.rest[id].auto.check = ok;
          writeJson('fix-rest.json', result.rest);
          assert.ok(ok.ok, `${ok.why}; ${JSON.stringify(g)}`);
          return `${name}: rootHips leg rig ${JSON.stringify(f.hipsRig)}; ${f.clips.filter((x) => /^(sit|crouch|lay)\./.test(x)).length} sit/crouch/lay clips loaded; rested by herself: ${got} (${g.base}), ${restOk(g).why}, ankles ${g.anklesY} m, cloth lowest ${g.clothGap} m; ${sh}`;
        });
        for (const group of ['sit', 'crouch']) {
          await ST(`${name}：本地 API POST /motion {group:${group}} → ${group === 'sit' ? '坐下' : '蹲下'}，不穿地、不悬空（截图）`, async () => {
            await page.mouse.move(230, 30);
            const r = await api('POST', '/motion', { group, loop: true });
            assert.equal(r.status, 200, JSON.stringify(r.json));
            await until(`${group} plays`, (gp) => { const c = document.querySelector('#pet-look canvas.vrm'); return c && c.dataset.manual && (c.dataset.pose || '').startsWith(gp); }, group, 8000).catch(() => null);
            await sleep(3500);
            await bubbleGone();
            const g = await ground();
            const sh = await H.shot(`rest-${id}-${group}`);
            await api('POST', '/motion/stop', {});
            await sleep(1500);
            result.rest[id] = { ...(result.rest[id] || {}), [group]: { id: r.json.id, ground: g, shot: sh } };
            writeJson('fix-rest.json', result.rest);
            assert.ok((g.pose || '').startsWith(group), `pose ${g.pose}`);
            // sitting she is on the seat (it stands on the floor, its top just under her hip joints), her feet may
            // hang; nothing goes through the floor either way. Crouching her feet are on the floor.
            const ok = restOk(g);
            result.rest[id][group].check = ok;
            writeJson('fix-rest.json', result.rest);
            assert.ok(ok.ok, `${ok.why}; ${JSON.stringify(g)}`);
            assert.ok(g.hipJointsY < 0.85 * (g.legRigHeight || 1), `hips came down: hip joints ${g.hipJointsY} m vs standing ${g.legRigHeight} m`);
            return `${name}: ${r.json.id} — pose ${g.pose}; ${ok.why} (height ${g.height} m), cloth lowest ${g.clothGap} m, hip joints ${g.hipJointsY} m (standing ${g.legRigHeight} m), ankles ${g.anklesY} m, hips bone ${g.hipsBoneY} m; seat ${JSON.stringify(g.seat)}; ${sh}`;
          });
        }
      }
    }

    if (DO.has('hit')) {
      await ST('输出 6×6 部位识别矩阵（行：模型；列：点击的部位；格：识别出的部位）', async () => {
        const head = `| 模型 | ${PARTS.map((p) => `${LABEL[p]}（${p}）`).join(' | ')} |\n|---|${PARTS.map(() => '---').join('|')}|\n`;
        const rows = IDS.map((id) => `| ${NAMES[id] || id} | ${PARTS.map((p) => { const c = (result.hit[id] || {})[p]; return c ? `${c.ok ? '✓' : '✗'} ${c.recognised}` : '—'; }).join(' | ')} |`).join('\n');
        const all = IDS.length * PARTS.length;
        const ok = IDS.reduce((s, id) => s + PARTS.filter((p) => (result.hit[id] || {})[p] && result.hit[id][p].ok).length, 0);
        const md = `${head}${rows}\n\n正确 ${ok}/${all}\n`;
        fs.writeFileSync(path.join(OUTD, 'fix-hit-matrix.md'), md);
        console.log(md);
        assert.equal(ok, all, md);
        return `${ok}/${all}`;
      });
    }
    await ST('无控制台错误', async () => { const e = realErrors(errors); assert.equal(e.length, 0, e.slice(0, 5).join(' | ')); return 'console errors: 0'; });
  } finally {
    writeJson('fix-result.json', result);
    await app.close().catch(() => {});
    server.close();
  }
};
