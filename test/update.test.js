'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const U = require('../src/core/update');

const LATEST_MAC = `version: 0.4.1
files:
  - url: PixelPetAffection-0.4.1-mac-universal.zip
    sha512: abc+/=
    size: 228090543
  - url: PixelPetAffection-0.4.1-mac-universal.dmg
    sha512: def
    size: 238268658
path: PixelPetAffection-0.4.1-mac-universal.zip
sha512: abc+/=
releaseDate: '2026-10-28T10:00:00.000Z'
`;

test('reads electron-builder update info and picks the mac zip', () => {
  const info = U.parseUpdateInfo(LATEST_MAC);
  assert.equal(info.version, '0.4.1');
  assert.equal(info.files.length, 2);
  assert.deepEqual(U.macZip(info), { url: 'PixelPetAffection-0.4.1-mac-universal.zip', sha512: 'abc+/=', size: 228090543 });
  assert.equal(U.macZip(U.parseUpdateInfo('version: 1.0.0\nfiles:\n  - url: a.dmg\n')), null);
});

test('only a higher release version counts as newer', () => {
  assert.equal(U.isNewer('0.4.1', '0.4.0'), true);
  assert.equal(U.isNewer('0.10.0', '0.9.9'), true);
  assert.equal(U.isNewer('v1.0.0', '0.99.0'), true);
  assert.equal(U.isNewer('0.4.0', '0.4.0'), false);
  assert.equal(U.isNewer('0.3.9', '0.4.0'), false);
  assert.equal(U.isNewer('0.5.0-beta.1', '0.5.0'), false);
  assert.equal(U.isNewer(null, '0.4.0'), false);
});

test('sha512 is the base64 digest electron-builder writes', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')), 'x.bin');
  fs.writeFileSync(f, 'hello');
  assert.equal(await U.sha512Base64(f), crypto.createHash('sha512').update('hello').digest('base64'));
});

test('an app started from the DMG, Downloads (translocated) or a read-only folder cannot replace itself', () => {
  const ok = () => {};
  const bin = (app) => path.join(app, 'Contents', 'MacOS', 'Pixel Pet Affection');
  assert.deepEqual(U.macAppPath(bin('/Applications/Pixel Pet Affection.app'), { access: ok }), { app: '/Applications/Pixel Pet Affection.app', reason: null });
  assert.equal(U.macAppPath(bin('/private/var/folders/x/AppTranslocation/ABC/d/Pixel Pet Affection.app'), { access: ok }).reason, 'translocated');
  assert.equal(U.macAppPath(bin('/Volumes/Pixel Pet Affection 0.4.1/Pixel Pet Affection.app'), { access: ok }).reason, 'dmg');
  assert.equal(U.macAppPath(bin('/Applications/Pixel Pet Affection.app'), { access: () => { throw new Error('EACCES'); } }).reason, 'read-only');
  assert.equal(U.macAppPath('/usr/bin/node', { access: ok }).reason, 'not-bundle');
});

// A fake bundle: <dir>/<name>.app/Contents/{Info.plist, version}
function fakeApp(dir, name, version) {
  const app = path.join(dir, `${name}.app`);
  fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
  fs.writeFileSync(path.join(app, 'Contents', 'version'), version);
  return app;
}

test('staging unpacks the update and refuses an archive without the app', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-stage-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-src-'));
  fakeApp(src, 'Pixel Pet Affection', '0.4.1');
  const extract = async (_zip, dest) => fs.cpSync(src, dest, { recursive: true });
  const staged = await U.stageMacApp({ zip: 'x.zip', stageDir: path.join(root, '.stage'), appName: 'Pixel Pet Affection.app', extract });
  assert.equal(fs.readFileSync(path.join(staged, 'Contents', 'version'), 'utf8'), '0.4.1');
  await assert.rejects(U.stageMacApp({ zip: 'x.zip', stageDir: path.join(root, '.stage'), appName: 'Other.app', extract }), /does not contain Other\.app/);
});

// Runs the real swap script with stub `xattr` / `open` on PATH (on Linux neither exists).
function runSwap({ pid, oldApp, newApp, relaunch }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-bin-'));
  const opened = path.join(bin, 'opened');
  fs.writeFileSync(path.join(bin, 'xattr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$1" > "${opened}"\n`, { mode: 0o755 });
  const script = U.writeSwapScript(fs.mkdtempSync(path.join(os.tmpdir(), 'upd-sh-')));
  execFileSync('/bin/bash', [script, String(pid), oldApp, newApp, relaunch ? '1' : '0'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').trim() : null;
}

test('the swap script waits for the app to exit, replaces the bundle and reopens it', async () => {
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-apps-'));
  const oldApp = fakeApp(apps, 'Pixel Pet Affection', '0.4.0');
  const newApp = fakeApp(path.join(apps, '.Pixel Pet Affection-update'), 'Pixel Pet Affection', '0.4.1');
  const running = spawn('sleep', ['1']);
  const t0 = Date.now();
  const opened = runSwap({ pid: running.pid, oldApp, newApp, relaunch: true });
  assert.ok(Date.now() - t0 >= 700, 'waited for the old process');
  assert.equal(fs.readFileSync(path.join(oldApp, 'Contents', 'version'), 'utf8'), '0.4.1');
  assert.equal(opened, oldApp);
  assert.deepEqual(fs.readdirSync(apps), ['Pixel Pet Affection.app'], 'no backup or staging folder left behind');
});

test('on quit the swap happens without reopening; a failed swap keeps the old app', () => {
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-apps-'));
  const oldApp = fakeApp(apps, 'Pixel Pet Affection', '0.4.0');
  const newApp = fakeApp(path.join(apps, '.stage'), 'Pixel Pet Affection', '0.4.1');
  assert.equal(runSwap({ pid: 999999, oldApp, newApp, relaunch: false }), null);
  assert.equal(fs.readFileSync(path.join(oldApp, 'Contents', 'version'), 'utf8'), '0.4.1');

  const apps2 = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-apps-'));
  const keep = fakeApp(apps2, 'Pixel Pet Affection', '0.4.0');
  runSwap({ pid: 999999, oldApp: keep, newApp: path.join(apps2, 'missing', 'Pixel Pet Affection.app'), relaunch: false });
  assert.equal(fs.readFileSync(path.join(keep, 'Contents', 'version'), 'utf8'), '0.4.0', 'rolled back');
  assert.deepEqual(fs.readdirSync(apps2), ['Pixel Pet Affection.app']);
});
