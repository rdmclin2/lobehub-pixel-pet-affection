'use strict';
// Release build check (run by .github/workflows/release.yml on the build machine, no network):
//   macOS:   latest-mac.yml matches the zip; the zip unpacks into a working app; the swap script
//            replaces an installed copy, keeps its signature valid, and the swapped app starts.
//   Windows: latest.yml matches the installer.
// Usage: node e2e/update-smoke.js <dist dir>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const U = require('../src/core/update');

const dist = path.resolve(process.argv[2] || 'dist');
const { version, build } = require('../package.json');
const log = (...a) => console.log('[update-smoke]', ...a);

async function checkInfo(file, pattern) {
  const info = U.parseUpdateInfo(fs.readFileSync(path.join(dist, file), 'utf8'));
  assert.equal(info.version, version, `${file} version`);
  const f = info.files.find((x) => pattern.test(x.url));
  assert.ok(f, `${file} lists ${pattern}`);
  assert.equal(await U.sha512Base64(path.join(dist, f.url)), f.sha512, `${f.url} sha512`);
  log(`${file}: ${f.url} sha512 ok`);
  return f;
}

async function mac() {
  const zip = await checkInfo('latest-mac.yml', /-mac-universal\.zip$/);
  const name = `${build.productName}.app`;
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'));
  const installed = path.join(apps, name);
  execFileSync('/usr/bin/ditto', [path.join(dist, 'mac-universal', name), installed]);
  fs.writeFileSync(path.join(installed, 'Contents', 'old-marker'), '1');
  const verify = (app) => { try { execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' }); return 'valid'; } catch (e) { return String(e.stderr).trim(); } };
  const before = verify(path.join(dist, 'mac-universal', name));

  const staged = await U.stageMacApp({ zip: path.join(dist, zip.url), stageDir: path.join(apps, `.${build.productName}-update`), appName: name });
  const plist = (app) => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(plist(staged), version);

  const running = spawn('sleep', ['2']);
  const script = U.writeSwapScript(fs.mkdtempSync(path.join(os.tmpdir(), 'swap-')));
  execFileSync('/bin/bash', [script, String(running.pid), installed, staged, '0']);
  assert.equal(fs.existsSync(path.join(installed, 'Contents', 'old-marker')), false, 'bundle replaced');
  assert.equal(plist(installed), version);
  assert.deepEqual(fs.readdirSync(apps), [name], 'nothing left behind');
  assert.equal(verify(installed), before, 'signature state unchanged by the swap');
  log(`swap ok, codesign: ${before}`);

  const bin = path.join(installed, 'Contents', 'MacOS', build.productName);
  const child = spawn(bin, [], { env: { ...process.env, PIXELPET_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'data-')), PIXELPET_NO_UPDATE: '1' }, stdio: 'ignore' });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  await new Promise((r) => setTimeout(r, 15000));
  assert.equal(exited, null, `the swapped app exited early (code ${exited})`);
  child.kill();
  log('swapped app started and kept running for 15s');
}

(async () => {
  if (process.platform === 'darwin') await mac();
  else if (process.platform === 'win32') await checkInfo('latest.yml', /-setup\.exe$/);
  else log('nothing to check on', process.platform);
})().catch((e) => { console.error(e); process.exit(1); });
