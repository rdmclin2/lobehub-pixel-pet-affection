// Send window positions Electron cannot take (-0, 2^40, NaN, fractions) from the renderer and report whether the
// main process survives (regression probe for the "conversion failure" crash fixed in v0.8.0).
// usage: xvfb-run -a node .agents/acceptance/scripts/window-position-probe.js <repo or worktree>
const path = require('node:path'), fs = require('node:fs'), os = require('node:os');
const ROOT = process.argv[2];
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-neg-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 1, answered: true, ageConfirmed: false, adultContent: false }));
  const app = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, PIXELPET_TEST: '1', PIXELPET_DATA_DIR: data } });
  let err = '';
  app.process().stderr.on('data', (d) => { err += d; });
  const page = await app.firstWindow();
  await page.waitForLoadState();
  const sends = [[-0.4, 10], [-0, -0], [2 ** 40, 5], [NaN, 3], [100.6, -0.2]];
  for (const [x, y] of sends) {
    try { await page.evaluate(([x, y]) => window.pet.moveTo(x, y), [x, y]); console.log(`sent moveTo(${Object.is(x, -0) ? '-0' : x}, ${Object.is(y, -0) ? '-0' : y})`); } catch (e) { console.log(`sent moveTo(${x}, ${y}) -> renderer gone: ${e.message.split('\n')[0]}`); }
  }
  await page.waitForTimeout(1500);
  const lines = err.split('\n').filter((l) => /conversion failure|Uncaught|TypeError/.test(l));
  console.log(`main-process error lines: ${lines.length}`);
  for (const l of lines.slice(0, 6)) console.log('  ' + l.trim().slice(0, 200));
  const b = await Promise.race([app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()).then((x) => JSON.stringify(x)), new Promise((r) => setTimeout(() => r('no answer from the main process within 5 s'), 5000))]).catch((e) => `main process gone: ${e.message.split('\n')[0]}`);
  console.log(`window bounds afterwards: ${b}`);
  app.process().kill('SIGKILL');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e.message.split('\n')[0]); process.exit(1); });
