// usage: xvfb-run -a -s '-screen 0 1440x1000x24' node /tmp/t2824/views.js <root> <out>
const path = require('node:path'), fs = require('node:fs'), os = require('node:os'), cp = require('node:child_process');
const [ROOT, OUT] = process.argv.slice(2);
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
const log = []; const note = (s) => { log.push(s); console.log(s); };
const ROUTES = (process.env.ROUTES || '/overview').split(',');
const errors = [];
(async () => {
  cp.execFileSync('npm', ['run', 'build:admin'], { cwd: ROOT, stdio: 'ignore' });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-v-')), fake = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vf-'));
  fs.writeFileSync(path.join(fake, 'loggedin'), '1');
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: false, ageConfirmedAt: null, adultContent: false }));
  const env = { ...process.env, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: data, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fake, PIXELPET_CATALOG_PREINSTALLED: path.join(ROOT, 'catalog') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'], cwd: ROOT, env });
  const page = await app.firstWindow(); page.on('dialog', (d) => d.accept());
  try {
    note(`revision ${cp.execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim()}`);
    await page.waitForSelector('.char-card', { timeout: 20000 });
    await page.click('.char-card[data-species="grok"]');
    if (await page.locator('#local-opt').count()) await page.uncheck('#local-opt');
    await page.click('#hatch-btn');
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 20000 });
    await page.mouse.move(110, 150); await page.waitForSelector('body.hover', { timeout: 5000 });
    await page.click('[data-act="settings"]');
    let admin; for (let i = 0; i < 100 && !admin; i++) { admin = app.windows().find((p) => p.url().includes('admin-ui')); if (!admin) await new Promise((r) => setTimeout(r, 100)); }
    admin.on('pageerror', (e) => errors.push(`pageerror  ${e.message}`)); admin.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error ${m.text().slice(0, 200)}`); });
    await admin.setViewportSize({ width: 1200, height: 800 }).catch(() => {});
    await admin.waitForTimeout(1500);
    const styles = {};
    for (const r of ROUTES) {
      await admin.evaluate((x) => { location.hash = x; }, r);
      await admin.waitForTimeout(1200);
      const name = r.slice(1).replace(/\//g, '-');
      await admin.screenshot({ path: path.join(OUT, `${name}.png`) });
      const s = await admin.evaluate(() => {
        const cs = (el) => el ? (({ fontFamily, fontSize, color, backgroundColor }) => ({ fontFamily, fontSize, color, backgroundColor }))(getComputedStyle(el)) : null;
        const prim = document.querySelector('.ant-btn-primary');
        const h = document.querySelector('h1, h2, h3');
        const vars = {}; const root = getComputedStyle(document.documentElement);
        for (const v of ['--ant-color-primary', '--ant-color-bg-layout', '--ant-color-text', '--ant-font-family', '--ant-color-bg-container', '--ant-border-radius']) vars[v] = root.getPropertyValue(v).trim();
        return { body: cs(document.body), heading: cs(h), headingText: h && h.textContent.slice(0, 30), primaryBtn: prim ? getComputedStyle(prim).backgroundColor : null, vars, title: document.title, text: document.body.innerText.slice(0, 120).replace(/\s+/g, ' ') };
      });
      const blank = !(s.text || '').trim(); styles[r] = s; note(`${r}: heading=「${s.headingText}」 font=${s.body && s.body.fontSize} color=${s.body && s.body.color} bg=${s.body && s.body.backgroundColor} blank=${blank} errorsSoFar=${errors.length} text=${s.text}`);
    }
    note(`pageerror/console.error total: ${errors.length}`); errors.forEach((e) => note('  ' + e));
    fs.writeFileSync(path.join(OUT, 'styles.json'), JSON.stringify(styles, null, 2));
  } catch (e) { note('ERROR ' + (e.stack || e)); process.exitCode = 1; }
  finally { fs.writeFileSync(path.join(OUT, 'views-log.txt'), log.join('\n') + '\n'); await app.close().catch(() => {}); }
})();
