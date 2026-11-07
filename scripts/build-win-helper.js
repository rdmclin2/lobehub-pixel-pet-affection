#!/usr/bin/env node
'use strict';
// Builds the Windows desktop-wallpaper helper (docs/wallpaper-mode.md §1.1) and writes its sha256 into the app code.
//
//   npm run build:win-helper            compile src/main/wallpaper/helper/desktop-helper.c with mingw-w64
//                                       → build/win-helper/pixelpet-desktop-helper.exe, stamp src/main/wallpaper/helper.json
//   node scripts/build-win-helper.js --ensure
//                                       (predist:win) keep an exe that already matches helper.json and the current
//                                       source (the CI Windows job downloads the one built on Linux); otherwise
//                                       compile; with no compiler and no matching exe: fail, never ship sha256 null
//
// Compiler: $PIXELPET_MINGW_CC or x86_64-w64-mingw32-gcc (Ubuntu: apt-get install gcc-mingw-w64-x86-64).
// Reproducible: no PE timestamp, no build id, stripped, source paths mapped — the same mingw-w64 package gives the same
// bytes, so the sha256 committed in helper.json can be rebuilt and compared (scripts/check-win-helper.js).
// The main process (src/main/wallpaper/win-helper.js) hashes the exe before every start and refuses any other file.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HELPER_SRC = path.join(ROOT, 'src/main/wallpaper/helper');
const SRC = path.join(HELPER_SRC, 'desktop-helper.c');
const RC = path.join(HELPER_SRC, 'desktop-helper.rc'); // version resource + manifest (asInvoker, PerMonitorV2)
// every input of the exe: their hash is stamped as sourceSha256, so a stale helper.json is caught (tests, --ensure)
const SOURCES = ['desktop-helper.c', 'desktop-helper.rc', 'desktop-helper.manifest'];
const MANIFEST = path.join(ROOT, 'src/main/wallpaper/helper.json');
const OUT_DIR = path.join(ROOT, 'build/win-helper');
const EXE_NAME = 'pixelpet-desktop-helper.exe';
const EXE = path.join(OUT_DIR, EXE_NAME);
const CC = process.env.PIXELPET_MINGW_CC || 'x86_64-w64-mingw32-gcc';
const WINDRES = process.env.PIXELPET_MINGW_WINDRES || CC.replace(/gcc(\.exe)?$/, 'windres$1');

const FLAGS = [
  '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror',
  '-DUNICODE', '-D_UNICODE', '-D_WIN32_WINNT=0x0A00', '-DWINVER=0x0A00',
  '-mconsole', '-static', '-s',
  `-ffile-prefix-map=${ROOT}=.`,
  '-Wl,--no-insert-timestamp', '-Wl,--build-id=none',
  '-Wl,--dynamicbase', '-Wl,--nxcompat', '-Wl,--high-entropy-va',
];
const LIBS = ['-luser32', '-lshell32', '-lwtsapi32'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function sourceSha() {
  const h = crypto.createHash('sha256');
  // LF-normalised: a Windows checkout (core.autocrlf) has the same sources, so --ensure there keeps the Linux-built exe
  for (const f of SOURCES) h.update(`${f}\0`).update(fs.readFileSync(path.join(HELPER_SRC, f), 'utf8').replace(/\r\n/g, '\n')).update('\0');
  return h.digest('hex');
}
const readManifest = () => { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return null; } };

function compilerVersion() {
  try { return execFileSync(CC, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim(); } catch { return null; }
}

function compile() {
  const version = compilerVersion();
  if (!version) throw new Error(`no mingw-w64 compiler (${CC}); install gcc-mingw-w64-x86-64 or set PIXELPET_MINGW_CC`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const res = path.join(OUT_DIR, 'desktop-helper.res.o');
  // relative paths: the bytes do not depend on where the repo is checked out (plus -ffile-prefix-map for the C)
  const rcArgs = ['-c', '65001', '-I', path.relative(ROOT, HELPER_SRC), path.relative(ROOT, RC), '-O', 'coff', '-o', path.relative(ROOT, res)];
  console.log(`$ ${WINDRES} ${rcArgs.join(' ')}`);
  execFileSync(WINDRES, rcArgs, { cwd: ROOT, stdio: 'inherit' });
  const args = [...FLAGS, path.relative(ROOT, SRC), path.relative(ROOT, res), '-o', path.relative(ROOT, EXE), ...LIBS];
  console.log(`$ ${CC} ${args.join(' ')}`);
  execFileSync(CC, args, { cwd: ROOT, stdio: 'inherit' });
  fs.rmSync(res, { force: true });
  return version;
}

function stamp(compiler) {
  const buf = fs.readFileSync(EXE);
  const m = {
    file: EXE_NAME,
    sha256: sha256(buf),
    size: buf.length,
    sources: SOURCES.map((f) => `src/main/wallpaper/helper/${f}`),
    sourceSha256: sourceSha(),
    compiler,
    note: 'Written by scripts/build-win-helper.js (npm run build:win-helper; CI: before dist:win). The main process (win-helper.js) refuses to start a helper exe whose sha256 differs; electron-builder ships the exe as resources/pixelpet-desktop-helper.exe.',
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
  return m;
}

function main() {
  const ensure = process.argv.includes('--ensure');
  if (ensure && fs.existsSync(EXE)) {
    const m = readManifest();
    const have = sha256(fs.readFileSync(EXE));
    if (m && m.sha256 === have && m.sourceSha256 === sourceSha()) {
      console.log(`win helper: keeping ${path.relative(ROOT, EXE)} (sha256 ${have} = helper.json, source unchanged)`);
      return;
    }
    console.log(`win helper: ${path.relative(ROOT, EXE)} does not match helper.json / the source (${have}); rebuilding`);
  }
  const compiler = compile();
  const m = stamp(compiler);
  console.log(`win helper: ${path.relative(ROOT, EXE)} ${m.size} bytes sha256 ${m.sha256}`);
  console.log(`win helper: wrote ${path.relative(ROOT, MANIFEST)} (${m.compiler})`);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(`build-win-helper: ${e.message}`); process.exit(1); }
}

module.exports = { EXE, EXE_NAME, MANIFEST, SRC, SOURCES, FLAGS, LIBS, sha256, sourceSha };
