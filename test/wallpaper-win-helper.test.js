'use strict';
// The Windows desktop helper's integrity check (docs/wallpaper-mode.md §1.1): the main process hashes
// pixelpet-desktop-helper.exe against the sha256 the build wrote into src/main/wallpaper/helper.json (inside app.asar)
// and refuses to start anything else — before the first start and before the automatic restart after a crash.
// Plus the build contract: the stamp matches the current source, electron-builder ships the exe in resources/,
// and the PE reader of scripts/check-win-helper.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: realSpawn } = require('node:child_process');
const { HelperClient, createWinBackend, readManifest } = require('../src/main/wallpaper/win-helper');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-desktop-helper.js');
const EXE = 'pixelpet-desktop-helper.exe';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// a resources/ dir holding an "exe" (bytes), the manifest the code would carry, and a spawn that counts starts and
// runs the Node fake helper in place of the exe
function setup(bytes = 'MZ the real helper') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-winhelper-'));
  fs.writeFileSync(path.join(dir, EXE), bytes);
  const manifest = { file: EXE, sha256: sha(bytes) };
  const starts = [];
  const children = [];
  const spawn = (exe, args, opts) => {
    starts.push(exe);
    const c = realSpawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_HELPER_MODE: 'ok' } });
    children.push(c);
    return c;
  };
  return { dir, manifest, starts, children, spawn, exe: path.join(dir, EXE) };
}

test('the exe matching the sha256 in the code starts; one byte changed → helper-tampered and nothing is spawned', async () => {
  const s = setup();
  const ok = createWinBackend({ helperDir: s.dir, manifest: s.manifest, spawn: s.spawn });
  assert.deepEqual(await ok.availability(), { ok: true, mode: 'live', session: 'win32', note: undefined });
  assert.deepEqual(s.starts, [s.exe], 'started the checked file, by its full path');
  ok.dispose();

  const t = setup();
  fs.writeFileSync(t.exe, 'MZ the real helpeR'); // same size, one byte different
  const bad = createWinBackend({ helperDir: t.dir, manifest: t.manifest, spawn: t.spawn });
  assert.deepEqual(await bad.availability(), { ok: false, mode: 'live', reason: 'helper-tampered' });
  const w = { getNativeWindowHandle: () => Buffer.alloc(8, 1), isDestroyed: () => false, showInactive: () => {} };
  assert.equal((await bad.attach(w, { bounds: { x: 0, y: 0, width: 10, height: 10 } })).reason, 'helper-tampered', '设为壁纸 fails with the reason, no attach');
  assert.deepEqual(t.starts, [], 'a tampered exe is never spawned');
});

test('the expected sha256 comes from the code, not from a helper.json planted next to the exe', async () => {
  const s = setup();
  fs.writeFileSync(s.exe, 'MZ a foreign exe');
  // an attacker who can write resources/ also drops a matching manifest there: ignored
  fs.writeFileSync(path.join(s.dir, 'helper.json'), JSON.stringify({ file: EXE, sha256: sha('MZ a foreign exe') }));
  const b = createWinBackend({ helperDir: s.dir, manifest: s.manifest, spawn: s.spawn });
  assert.equal((await b.availability()).reason, 'helper-tampered');
  assert.deepEqual(s.starts, []);
  // the default manifest is the one beside win-helper.js (ships in app.asar), whatever helperDir is
  assert.deepEqual(readManifest(), JSON.parse(fs.readFileSync(path.join(ROOT, 'src/main/wallpaper/helper.json'), 'utf8')));
  const d = createWinBackend({ helperDir: s.dir, spawn: s.spawn });
  assert.equal((await d.availability()).reason, 'helper-tampered', 'default manifest: the shipped sha256, not the planted one');
  assert.deepEqual(s.starts, []);
});

test('no exe / no sha256 / no helper dir → helper-missing, never an unchecked start', async () => {
  const s = setup();
  fs.rmSync(s.exe);
  assert.equal((await createWinBackend({ helperDir: s.dir, manifest: s.manifest, spawn: s.spawn }).availability()).reason, 'helper-missing');
  for (const manifest of [null, { file: EXE, sha256: null }, { file: EXE, sha256: '' }, { file: EXE, sha256: 'abc' }]) {
    const t = setup();
    assert.equal((await createWinBackend({ helperDir: t.dir, manifest, spawn: t.spawn }).availability()).reason, 'helper-missing', JSON.stringify(manifest));
    assert.deepEqual(t.starts, []);
  }
  const u = setup();
  assert.equal((await createWinBackend({ helperDir: null, manifest: u.manifest, spawn: u.spawn }).availability()).reason, 'helper-missing');
  assert.deepEqual(u.starts, []);
});

test('the restart after a crash checks the sha256 again: an exe swapped while it ran is refused and the helper is dead', { timeout: 5000 }, async () => {
  const s = setup();
  const c = new HelperClient({ command: [s.exe], expectSha: s.manifest.sha256, spawn: s.spawn, timeoutMs: 1000 });
  const events = [];
  c.on('restarted', (m) => events.push(['restarted', m.ok]));
  c.on('dead', () => events.push(['dead']));
  assert.equal(c.start().ok, true);
  assert.equal((await c.request('status', { hwnd: '0x1' })).ok, true, 'the fake answers');
  fs.writeFileSync(s.exe, 'MZ swapped while running');
  const died = new Promise((r) => c.once('dead', r));
  s.children[0].kill();
  const outcome = await Promise.race([died.then(() => 'dead'), new Promise((r) => setTimeout(() => r('still running'), 3000))]);
  for (const ch of s.children) ch.kill();
  assert.equal(outcome, 'dead', 'the restart must refuse the swapped exe');
  assert.deepEqual(events, [['restarted', false], ['dead']]);
  assert.equal(s.starts.length, 1, 'the swapped file was not started');
  assert.deepEqual(await c.request('status', { hwnd: '0x1' }), { ok: false, reason: 'helper-failed' });
});

test('helper.json carries a real sha256 stamped from the current desktop-helper.c (no stale stamp)', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/main/wallpaper/helper.json'), 'utf8'));
  assert.equal(m.file, EXE);
  assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.equal(m.sourceSha256, require('../scripts/build-win-helper').sourceSha(), 'desktop-helper.c / .rc / .manifest changed: run npm run build:win-helper');
});

test('packaging: dist:win builds the helper first and ships it unpacked in resources/; the C source stays out of app.asar', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['predist:win'], /build-win-helper\.js --ensure/);
  assert.equal(pkg.scripts['build:win-helper'], 'node scripts/build-win-helper.js');
  assert.deepEqual(pkg.build.win.extraResources, [{ from: 'build/win-helper/pixelpet-desktop-helper.exe', to: EXE }]);
  assert.ok(pkg.build.files.includes('!src/main/wallpaper/helper/**'));
  // main.js points the backend at resources/ when packaged, build/win-helper from source
  const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
  assert.match(main, /helperDir: app\.isPackaged \? process\.resourcesPath : path\.join\(__dirname, '\.\.', '\.\.', 'build', 'win-helper'\)/);
});

test('scripts/check-win-helper.js reads PE32+ headers and the import table', () => {
  const { parsePE } = require('../scripts/check-win-helper');
  // a minimal PE32+ image: one section holding an import directory for USER32.dll!SetParent
  const buf = Buffer.alloc(0x400);
  buf.writeUInt16LE(0x5a4d, 0); buf.writeUInt32LE(0x40, 0x3c); buf.writeUInt32LE(0x4550, 0x40);
  const coff = 0x44; buf.writeUInt16LE(0x8664, coff); buf.writeUInt16LE(1, coff + 2); buf.writeUInt16LE(240, coff + 16); buf.writeUInt16LE(0x22, coff + 18);
  const opt = coff + 20; buf.writeUInt16LE(0x20b, opt); buf.writeUInt16LE(3, opt + 68); buf.writeUInt16LE(0x160, opt + 70); buf.writeUInt32LE(16, opt + 108);
  buf.writeUInt32LE(0x1000, opt + 112 + 8); buf.writeUInt32LE(40, opt + 116 + 8); // import dir rva
  const sec = opt + 240; buf.write('.idata', sec, 'latin1'); buf.writeUInt32LE(0x200, sec + 8); buf.writeUInt32LE(0x1000, sec + 12); buf.writeUInt32LE(0x200, sec + 16); buf.writeUInt32LE(0x200, sec + 20);
  const r = (rva) => rva - 0x1000 + 0x200;
  buf.writeUInt32LE(0x1040, r(0x1000)); buf.writeUInt32LE(0x1080, r(0x1000) + 12); buf.writeUInt32LE(0x1040, r(0x1000) + 16);
  buf.writeBigUInt64LE(0x1060n, r(0x1040));
  buf.write('SetParent\0', r(0x1060) + 2, 'latin1'); buf.write('USER32.dll\0', r(0x1080), 'latin1');
  const pe = parsePE(buf);
  assert.equal(pe.machine, 0x8664);
  assert.equal(pe.subsystem, 3);
  assert.deepEqual(pe.imports, { 'USER32.dll': ['SetParent'] });
  assert.throws(() => parsePE(Buffer.from('not an exe at all, no MZ here..........................................')), /no MZ/);
});
