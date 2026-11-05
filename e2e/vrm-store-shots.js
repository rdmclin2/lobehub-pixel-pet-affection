'use strict';

// vrmstoreshots (T-5097): the store import of each model that vrmverify measures, one by one, as evidence: the store
// card before (未下载), the same card after 下载 (已下载), her page after 切换, and the pet window with her drawn.
// No metrics here (they are vrmverify's); same store mirror, same ids.
//
//   env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js vrmstoreshots
//
// Env: PIXELPET_E2E_STORE_DIR (default ~/vrm-assets/store/vrm), PIXELPET_E2E_VERIFY_IDS (default the six of vrmverify).
// Evidence: out/e2e/vrm/storeshot-<id>-{1-card,2-downloaded,3-page,4-pet}.png
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

module.exports = async function vrmStoreShots(ctx) {
  const { step, launch, sleep, dataDir, helpers } = ctx;
  const S = 'vrmstoreshots';
  const STORE = process.env.PIXELPET_E2E_STORE_DIR || path.join(os.homedir(), 'vrm-assets', 'store', 'vrm');
  const IDS = (process.env.PIXELPET_E2E_VERIFY_IDS || 'vrm-d8789c38,vrm-wanderer,vrm-a185cf3a,vrm-paimon,vrm-diona,vrm-vrchat-avatar').split(',').filter(Boolean);
  if (!fs.existsSync(STORE)) { await step(S, 'store mirror present', async () => { throw new Error(`needs ${STORE}`); }, null); return; }
  const server = http.createServer((req, res) => {
    const f = path.join(STORE, path.basename(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { env } = dataDir('vrmstoreshots', { ageConfirmed: true, ageConfirmedAt: Date.now(), prefs: { roam: false } });
  Object.assign(env, { PIXELPET_CATALOG_URL: `http://127.0.0.1:${server.address().port}/vrm`, PIXELPET_CATALOG_PREINSTALLED: '', PIXELPET_VRM_MOTIONS_DIR: '', PIXELPET_VRM_DANCES_DIR: '' });
  const { app, page } = await launch(env);
  const H = helpers(page, 'storeshot', [], app);
  const A = H.A;
  // the card of a store item, framed in the middle of the window, with a ring around it
  const frameCard = (id) => A.win.evaluate((x) => {
    const b = document.querySelector(`[data-download="${x}"]`) || document.querySelector(`[data-downloaded="${x}"]`) || document.querySelector(`[data-store-open="${x}"]`);
    if (!b) return false;
    let card = b; for (let i = 0; i < 6 && card.parentElement; i++) { card = card.parentElement; if (card.getBoundingClientRect().height > 200) break; }
    card.scrollIntoView({ block: 'center' });
    document.querySelectorAll('[data-e2e-ring]').forEach((e) => { e.style.outline = ''; delete e.dataset.e2eRing; });
    card.style.outline = '3px solid #ff2d55'; card.style.outlineOffset = '2px'; card.dataset.e2eRing = '1';
    return true;
  }, id);
  try {
    await step(S, '启动：孵化、打开商店（本地镜像，不预装）', async () => {
      await H.hatch();
      await A.go('/store');
      await A.until(() => !!document.querySelector('[data-catalog-grid]'), null, 30000, 'the store grid');
      return 'store open';
    }, page);
    for (const id of IDS) {
      await step(S, `${id}：设置 → 商店 → 下载 → 切换 → 桌宠窗口里出现`, async () => {
        await A.until((x) => !!document.querySelector(`[data-download="${x}"]`) || !!document.querySelector(`[data-downloaded="${x}"]`), id, 20000, `card ${id}`);
        await frameCard(id); await sleep(300);
        const s1 = await H.adminShot(`${id}-1-card`);
        await A.win.evaluate((x) => { const b = document.querySelector(`[data-download="${x}"]`); if (b) b.click(); }, id);
        await A.until((x) => !!document.querySelector(`[data-downloaded="${x}"]`), id, 300000, `installed ${id}`);
        await frameCard(id); await sleep(500);
        const s2 = await H.adminShot(`${id}-2-downloaded`);
        const route = await A.win.evaluate((x) => { const a = document.querySelector(`[data-store-open="${x}"]`); return a ? a.getAttribute('href').replace(/^#/, '') : `/characters/${x}`; }, id);
        const cid = route.split('/').pop();
        await A.go(route);
        await A.until((x) => !!document.querySelector(`[data-switch="${x}"]`) || !!document.querySelector(`[data-current="${x}"]`), cid, 20000, `her page ${cid}`);
        await A.win.evaluate((x) => { const b = document.querySelector(`[data-switch="${x}"]`); if (b) b.click(); }, cid);
        await sleep(600);
        await A.win.evaluate(() => { if (!document.querySelector('[data-meet-name]')) return; const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '初次见面' && !x.dataset.switch); if (b) b.click(); });
        const s3 = await H.adminShot(`${id}-3-page`);
        const s0 = Date.now();
        for (;;) {
          const ok = await page.evaluate((x) => { const f = window.PetVRM && window.PetVRM.debug().figures[0]; const c = document.querySelector('#pet-look canvas.vrm'); return !!(f && String(f.packId).startsWith(x) && f.loaded && c && Number(c.dataset.frame) > 10); }, id).catch(() => false);
          if (ok) break;
          if (Date.now() - s0 > 120000) throw new Error(`${id} not drawn`);
          await sleep(200);
        }
        await sleep(1500);
        const s4 = await H.shot(`${id}-4-pet`);
        await A.go('/store');
        await A.until(() => !!document.querySelector('[data-catalog-grid]'), null, 30000, 'the store grid');
        return `${route}; ${s1}, ${s2}, ${s3}, ${s4}`;
      }, page);
    }
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
};
