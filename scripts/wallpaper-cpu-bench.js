'use strict';
// 桌面壁纸 · CPU 采样 (docs/wallpaper-mode.md §7.7). The same conditions as the T-13654 acceptance: Xvfb 1600×900,
// openbox, no GPU (software GL: llvmpipe / SwiftShader), the real pack 「海边露台」 copied in as if the store had installed it,
// she hatches on a first start, then wallpaper mode is restored on the second. Samples the app's whole process tree (/proc/<pid>/stat utime+stime) every
// SAMPLE_S seconds through three segments: normal → on battery → covered. 100 % = one core.
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node scripts/wallpaper-cpu-bench.js <pack dir> <out dir> [label]
//
// env: SEG_S (seconds per segment, default 120), SAMPLE_S (default 15), SEGMENTS (default normal,battery,covered),
//      WP_HOUR (force the wallpaper hour, default: leave it on the clock).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const [PACK, OUT, LABEL = 'run'] = process.argv.slice(2);
if (!PACK || !OUT) { console.error('usage: node scripts/wallpaper-cpu-bench.js <pack dir> <out dir> [label]'); process.exit(2); }
const SEG_S = Number(process.env.SEG_S || 120);
const SAMPLE_S = Number(process.env.SAMPLE_S || 15);
const SEGMENTS = (process.env.SEGMENTS || 'normal,battery,covered').split(',');
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 8000 }).trim(); } catch (e) { return `ERR ${String(e.message).split('\n')[0]}`; } };

function tree(root) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try { const ppid = Number(fs.readFileSync(`/proc/${d}/stat`, 'utf8').split(') ')[1].split(' ')[1]); if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(Number(d)); } catch { /* gone */ }
  }
  const out = [];
  const walk = (p) => { out.push(p); for (const k of kids.get(p) || []) walk(k); };
  walk(root);
  return out;
}
// a process's kind: main / gpu-process / renderer (one per window) / utility …
const kindOf = (id) => { try { const m = /--type=(\S+)/.exec(fs.readFileSync(`/proc/${id}/cmdline`, 'utf8').replace(/\0/g, ' ')); return m ? m[1] : 'main'; } catch { return '?'; } };
function ticks(root) {
  let cpu = 0; let rss = 0; const ids = tree(root); const per = {};
  for (const id of ids) { try { const s = fs.readFileSync(`/proc/${id}/stat`, 'utf8').split(') ')[1].split(' '); const c = Number(s[11]) + Number(s[12]); cpu += c; rss += Number(s[21]) * 4096; per[id] = c / 100; } catch { /* gone */ } }
  return { t: Date.now(), cpu: cpu / 100, rss, n: ids.length, per };
}
// CPU % per process kind between two samples (renderers summed)
function byKind(a, b) {
  const dt = (b.t - a.t) / 1000; const out = {};
  for (const [id, c] of Object.entries(b.per)) { const k = kindOf(id); out[k] = (out[k] || 0) + ((c - (a.per[id] || 0)) / dt) * 100; }
  return Object.entries(out).map(([k, v]) => `${k}=${Math.round(v)}`).join(' ');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wpbench-'));
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wpbench-lh-'));
  fs.writeFileSync(path.join(fake, 'loggedin'), '1');
  const m = JSON.parse(fs.readFileSync(path.join(PACK, 'manifest.json'), 'utf8'));
  const dest = path.join(data, 'games', m.id);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(PACK)) fs.copyFileSync(path.join(PACK, f), path.join(dest, f));
  fs.writeFileSync(path.join(dest, '.catalog.json'), JSON.stringify({ id: m.id, version: m.version, installedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, wallpaper: { on: true, id: m.id, confirmed: true, linuxNotice: true } }));
  const wm = spawn('openbox', [], { stdio: 'ignore', detached: true });
  await wait(1500);
  const passPerms = () => {
    const go = () => { const s = document.getElementById('perms'); if (s && !s.classList.contains('hidden') && !s.dataset.e2ePassed) { s.dataset.e2ePassed = '1'; document.getElementById('perms-next').click(); } if (s && s.classList.contains('hidden')) delete s.dataset.e2ePassed; };
    new MutationObserver(go).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
  };
  const start = async () => {
    const a = await _electron.launch({ args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], cwd: ROOT, env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_CATALOG_PREINSTALLED: path.join(ROOT, 'catalog'), PIXELPET_DATA_DIR: data, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fake, PIXELPET_E2E_APP_VERSION: '0.29.0', PIXELPET_E2E_WALLPAPER_RESTORE_MS: '800' } });
    const p = await a.firstWindow();
    await p.addInitScript(passPerms).catch(() => {});
    await p.evaluate(passPerms).catch(() => {});
    return { a, p };
  };
  // first start: she hatches (wallpaper mode comes back only for a pet that exists), then the app restarts into it
  {
    const { a, p } = await start();
    await p.waitForSelector('.char-card');
    await p.locator('.char-card[data-species="claude"]').first().click();
    await p.fill('#pet-name', '小克');
    await p.uncheck('#local-opt');
    await p.click('#hatch-btn');
    await p.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await wait(3000);
    const first = a.process();
    await a.close().catch(() => {});
    for (let i = 0; i < 100 && first.exitCode === null && first.signalCode === null; i++) await wait(100);
    await wait(2000);
  }
  const { a: app, p: page } = await start();
  const pid = app.process().pid;
  const isWall = (p) => p.url().includes('/renderer/wallpaper/wallpaper.html');
  let wall = null;
  for (let i = 0; i < 200 && !wall; i++) { wall = app.windows().find(isWall) || null; if (!wall) await wait(150); }
  if (!wall) throw new Error('no wallpaper page');
  for (let i = 0; i < 200; i++) { const r = await wall.evaluate(() => window.__wallpaper && window.__wallpaper().ready).catch(() => false); if (r) break; await wait(150); }
  if (process.env.WP_HOUR) await wall.evaluate((h) => window.__wallpaperTest && window.__wallpaperTest.setHour(h), Number(process.env.WP_HOUR));
  if (process.env.WP_EVAL) console.log('WP_EVAL →', await wall.evaluate(process.env.WP_EVAL).catch((e) => String(e)));
  const W = () => wall.evaluate(() => window.__wallpaper()).catch(() => null);
  const gpu = await app.evaluate(({ app: a }) => a.getGPUFeatureStatus()).catch((e) => String(e));
  await wait(5000);
  const rows = [];
  const csv = ['label,segment,elapsed_s,cpu_pct,rss_mb,maxFps,fps,why,frames,render,hour,phase,by_process'];
  const setSeg = async (seg) => {
    await page.evaluate(() => window.pet.debugWallpaperSignal('onBattery', false));
    await page.evaluate(() => window.pet.debugWallpaperSignal('covered', false));
    if (seg === 'battery') await page.evaluate(() => window.pet.debugWallpaperSignal('onBattery', true));
    if (seg === 'covered') await page.evaluate(() => window.pet.debugWallpaperSignal('covered', true));
  };
  for (const seg of SEGMENTS) {
    await setSeg(seg);
    await wait(3000);
    let prev = ticks(pid);
    const t0 = Date.now();
    while (Date.now() - t0 < SEG_S * 1000) {
      await wait(SAMPLE_S * 1000);
      const cur = ticks(pid);
      const w = await W();
      const row = { label: LABEL, seg, elapsed: Math.round((cur.t - t0) / 1000), cpu: Math.round(((cur.cpu - prev.cpu) / ((cur.t - prev.t) / 1000)) * 1000) / 10, rss: Math.round(cur.rss / 1048576), maxFps: w && w.maxFps, fps: w && w.fps, why: w && w.why, frames: w && w.frames, render: w && w.render ? JSON.stringify(w.render).replace(/,/g, ';') : '', hour: w && Math.round(w.hour * 100) / 100, phase: w && w.phase, byProcess: byKind(prev, cur) };
      rows.push(row);
      csv.push(Object.values(row).join(','));
      console.log(csv[csv.length - 1]);
      prev = cur;
    }
  }
  await wall.screenshot({ path: path.join(OUT, `${LABEL}-wallpaper.png`) }).catch(() => {});
  sh('import', ['-window', 'root', path.join(OUT, `${LABEL}-root.png`)]);
  const avg = (seg) => { const r = rows.filter((x) => x.seg === seg); return r.length ? Math.round((r.reduce((a, x) => a + x.cpu, 0) / r.length) * 10) / 10 : null; };
  const summary = { label: LABEL, when: new Date().toISOString(), cpus: os.cpus().length, cpuModel: os.cpus()[0].model, screen: sh('xdpyinfo', []).split('\n').find((l) => /dimensions/.test(l)), gpuFeatureStatus: gpu, segSeconds: SEG_S, sampleSeconds: SAMPLE_S, avg: Object.fromEntries(SEGMENTS.map((s) => [s, avg(s)])), last: await W() };
  fs.writeFileSync(path.join(OUT, `${LABEL}.csv`), `${csv.join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, `${LABEL}-summary.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await app.close().catch(() => {});
  try { process.kill(-wm.pid); } catch { wm.kill(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
