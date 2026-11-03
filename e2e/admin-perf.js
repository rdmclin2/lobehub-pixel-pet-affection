'use strict';
// 配置后台 click-latency probe: launches the real app (fake lh) under xvfb, opens the settings window and
// measures, for the same set of clicks every run:
//   - click → next paint (Event Timing API: the INP number, max over pointerdown/pointerup/click)
//   - React components rendered per click (a __REACT_DEVTOOLS_GLOBAL_HOOK__ stub counts fibers with PerformedWork)
//   - background churn while idle: admin-state pushes and React commits per 10 s, long tasks
// Usage:  xvfb-run -a node e2e/admin-perf.js [label]   → out/e2e/admin-perf-<label>.json
const { _electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'e2e');
const FAKE_LH = path.join(ROOT, 'test', 'fixtures', 'fake-lh.js');
const label = process.argv[2] || 'run';
const ROUNDS = Number(process.env.PERF_ROUNDS || 5);
fs.mkdirSync(OUT, { recursive: true });

// Runs in the settings window before its bundle: counts React work and collects Event Timing entries.
const PROBE = () => {
  if (!location.href.includes('admin-ui')) return;
  const P = (window.__perf = { commits: 0, rendered: 0, events: [], longtasks: [], states: 0 });
  const PERFORMED = 1;
  const walk = (f) => {
    let n = 0;
    const stack = [f];
    while (stack.length) {
      const x = stack.pop();
      if (!x) continue;
      // function / class / memo / forwardRef components that actually ran this commit
      if ((x.tag === 0 || x.tag === 1 || x.tag === 11 || x.tag === 14 || x.tag === 15) && (x.flags & PERFORMED)) n += 1;
      if (x.child) stack.push(x.child);
      if (x.sibling && x !== f) stack.push(x.sibling);
    }
    return n;
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject(r) { this.renderers.set(1, r); return 1; },
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) { P.commits += 1; P.rendered += walk(root.current.child); },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    checkDCE() {},
  };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.events.push({ name: e.name, start: e.startTime, duration: e.duration, id: e.interactionId }); }).observe({ type: 'event', durationThreshold: 16, buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
  } catch { /* older engines */ }
};

async function main() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-perf-'));
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-perffake-'));
  fs.writeFileSync(path.join(fakeDir, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  const app = await _electron.launch({ args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], cwd: ROOT, env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: data, LH_BIN: FAKE_LH, FAKE_LH_DIR: fakeDir } });
  await app.context().addInitScript(PROBE);
  const page = await app.firstWindow();
  const report = { label, rounds: ROUNDS, idle: null, clicks: {} };
  try {
    await page.waitForSelector('.char-card');
    await page.click('.char-card[data-species="grok"]');
    await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
    await page.evaluate(() => window.pet.openAdmin('overview'));
    let admin = null;
    for (let i = 0; i < 300 && !admin; i++) {
      admin = app.windows().find((p) => p.url().includes('admin-ui')) || null;
      if (!admin) await new Promise((r) => setTimeout(r, 100));
    }
    await admin.waitForSelector('[data-path="/overview"]', { timeout: 15000 });
    await admin.evaluate(() => { window.petAdmin.onState(() => { window.__perf.states += 1; }); });
    await admin.waitForTimeout(2000);

    const cdp = await admin.context().newCDPSession(admin);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const snap = () => admin.evaluate(() => ({ commits: window.__perf.commits, rendered: window.__perf.rendered, states: window.__perf.states, longtasks: window.__perf.longtasks.length, ltMs: window.__perf.longtasks.reduce((s, t) => s + t.duration, 0), now: performance.now() }));
    const diff = (a, b) => ({ commits: b.commits - a.commits, rendered: b.rendered - a.rendered, states: b.states - a.states, longtasks: b.longtasks - a.longtasks, longtaskMs: Math.round(b.ltMs - a.ltMs), ms: Math.round(b.now - a.now) });

    // 1) 10 s on a page with nobody touching the console: first quiet, then with the pet "alive" (one
    //    heartbeat a second = what her needs ticking / chatting in the pet window pushes to the console)
    const cpu = () => app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ type: m.type, cpu: m.cpu.percentCPUUsage })));
    const idle = {};
    for (const route of ['/overview', '/characters', '/characters/grok']) {
      for (const alive of [false, true]) {
        await admin.evaluate((r) => { location.hash = r; }, route);
        await admin.waitForSelector(`[data-path="${route}"]`);
        await admin.waitForTimeout(1500);
        await cpu();
        const a = await snap();
        const m0 = await metrics();
        for (let i = 0; i < 10; i++) {
          if (alive) await page.evaluate(() => window.pet.debugHeartbeat());
          await admin.waitForTimeout(1000);
        }
        const m1 = await metrics();
        const c = await cpu();
        idle[`${route}${alive ? ' + pet heartbeat 1/s' : ' quiet'}`] = { ...diff(a, await snap()), rendererTaskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000), cpu: c.filter((x) => x.type !== 'Utility').map((x) => `${x.type}:${x.cpu.toFixed(1)}%`).join(' ') };
      }
    }
    report.idle = idle;

    // 2) the same clicks every run: one interaction → its Event Timing duration + React work
    const clicks = [
      { name: 'rail 角色', route: '/overview', sel: '[data-rail="characters"]', done: '[data-path="/characters"]' },
      { name: 'rail 小屋', route: '/characters', sel: '[data-rail="home"]', done: '[data-path="/overview"]' },
      { name: 'rail 设置', route: '/overview', sel: '[data-rail="settings"]', done: '[data-path="/settings"]' },
      { name: 'blank area (小屋)', route: '/overview', pos: { x: 900, y: 690 } },
      { name: 'blank area (character page)', route: '/characters/grok', pos: { x: 1040, y: 690 } },
      { name: 'blank area (behavior)', route: '/behavior', pos: { x: 1040, y: 690 } },
      { name: 'theme toggle', route: '/overview', sel: '[data-theme-toggle]' },
    ];
    for (const c of clicks) {
      const rows = [];
      for (let i = 0; i < ROUNDS; i++) {
        await admin.evaluate((r) => { location.hash = r; }, c.route);
        await admin.waitForSelector(`[data-path="${c.route}"]`);
        await admin.waitForTimeout(600);
        const a = await snap();
        const m0 = await metrics();
        // click → the page it leads to (or the new theme) is on screen: pointerdown's timestamp to the frame after
        const before = await admin.evaluate(() => {
          window.__clk = null;
          document.addEventListener('pointerdown', (e) => { window.__clk = e.timeStamp; }, { capture: true, once: true });
          const t = document.querySelector('[data-theme-toggle]');
          return t ? t.innerHTML : '';
        });
        const t0 = await admin.evaluate(() => performance.now());
        if (c.sel) await admin.click(c.sel);
        else await admin.mouse.click(c.pos.x, c.pos.y);
        const paintMs = await admin.evaluate(async ([done, theme]) => {
          const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
          for (let i = 0; i < 600; i++) {
            const ok = done ? !!document.querySelector(done) : theme !== null ? document.querySelector('[data-theme-toggle]').innerHTML !== theme : true;
            if (ok && window.__clk !== null) break;
            await frame();
          }
          await frame();
          return Math.round(performance.now() - window.__clk);
        }, [c.done || null, c.sel === '[data-theme-toggle]' ? before : null]);
        await admin.waitForTimeout(500);
        const b = await snap();
        const m1 = await metrics();
        const cost = Object.fromEntries(['ScriptDuration', 'RecalcStyleDuration', 'LayoutDuration', 'TaskDuration'].map((k) => [k.replace('Duration', ''), Math.round((m1[k] - m0[k]) * 1000)]));
        const ev = await admin.evaluate((s) => window.__perf.events.filter((e) => e.start >= s && /pointer|click|mouse/.test(e.name)), t0);
        const inp = ev.reduce((m, e) => Math.max(m, e.duration), 0);
        const d = diff(a, b);
        rows.push({ inpMs: inp, paintMs, rendered: d.rendered, commits: d.commits, states: d.states, longtaskMs: d.longtaskMs, ...cost });
      }
      const med = (k) => { const v = rows.map((r) => r[k]).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
      report.clicks[c.name] = { medianClickToPaintMs: med('paintMs'), maxClickToPaintMs: Math.max(...rows.map((r) => r.paintMs)), medianInpMs: med('inpMs'), maxInpMs: Math.max(...rows.map((r) => r.inpMs)), medianRendered: med('rendered'), medianScriptMs: med('Script'), medianStyleMs: med('RecalcStyle'), medianLayoutMs: med('Layout'), medianTaskMs: med('Task'), rows };
    }
  } finally {
    await app.close().catch(() => {});
  }
  const f = path.join(OUT, `admin-perf-${label}.json`);
  fs.writeFileSync(f, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ idle: report.idle, clicks: Object.fromEntries(Object.entries(report.clicks).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([x]) => x !== 'rows'))])) }, null, 2));
  console.log(`→ ${f}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
