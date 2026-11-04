#!/usr/bin/env node
'use strict';
// Packaging guard for dances (docs/vrm-dance.md §5.6 / §9.6): build the real Linux app folder with
// electron-builder (`--linux dir`, the same build.files as `npm run dist:*`) while decoy dance assets sit
// inside src/ — a vrm-dances/ library (dance.vrma, audio.mp3, cover.png, library.json), loose .vmd / .VMD /
// .ncm / .vrma files and a baked-dances/ folder — then list app.asar (and app.asar.unpacked) and assert that
// none of them, and no dance asset at all, made it into the package. The decoys are removed afterwards.
//
//   node scripts/check-dance-packaging.js [--keep]     (exit 0 = guard holds; prints the evidence)
//   node scripts/check-dance-packaging.js --no-guard   (negative control: build.files without the exclusions —
//                                                      the decoys ship and the check must FAIL, exit 1)
//
// It does not need any third-party dance: the decoys are a few bytes written here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const keep = process.argv.includes('--keep');
const noGuard = process.argv.includes('--no-guard');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pack-guard-'));
const DECOYS = [
  'src/renderer/vrm-dances/library.json',
  'src/renderer/vrm-dances/decoy-1a2b/dance.vrma',
  'src/renderer/vrm-dances/decoy-1a2b/audio.mp3',
  'src/renderer/vrm-dances/decoy-1a2b/cover.png',
  'src/renderer/vrm-dances/decoy-1a2b/src/Motion.vmd',
  'src/core/baked-dances/decoy/dance.vrma',
  'src/core/baked-dances/decoy/audio.wav',
  'src/assets-decoy-dance.vmd',
  'src/assets-decoy-dance.VMD',
  'src/assets-decoy-music.ncm',
  'src/assets-decoy-clip.vrma',
];
const made = [];
const dirs = new Set();
function plant() {
  for (const rel of DECOYS) {
    const f = path.join(ROOT, rel);
    if (fs.existsSync(f)) throw new Error(`refusing to overwrite an existing file: ${rel}`);
    let d = path.dirname(f);
    const chain = [];
    while (!fs.existsSync(d)) { chain.push(d); d = path.dirname(d); }
    for (const c of chain.reverse()) { fs.mkdirSync(c); dirs.add(c); }
    fs.writeFileSync(f, `decoy for scripts/check-dance-packaging.js: ${rel}\n`);
    made.push(f);
  }
}
function unplant() {
  for (const f of made) fs.rmSync(f, { force: true });
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) fs.rmSync(d, { recursive: true, force: true });
}

function listAsar(file) {
  const asar = require(path.join(ROOT, 'node_modules/@electron/asar'));
  return asar.listPackage(file, { isPack: false }).map((p) => p.replace(/\\/g, '/'));
}
function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const res = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) res.push(...walk(p, base)); else res.push('/' + path.relative(base, p).replace(/\\/g, '/'));
  }
  return res;
}

function noGuardConfig() {
  const build = JSON.parse(JSON.stringify(require(path.join(ROOT, 'package.json')).build));
  build.files = build.files.filter((f) => !f.startsWith('!'));
  const f = path.join(out, 'no-guard.json');
  fs.writeFileSync(f, JSON.stringify(build));
  return f;
}
// a control file that must ship either way: proves the decoys were in the packaged tree
DECOYS.push('src/assets-decoy-control.txt');

let code = 1;
try {
  plant();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  execFileSync(path.join(ROOT, 'node_modules/.bin/electron-builder'), [
    '--linux', 'dir', '--x64', '--publish', 'never',
    `-c.directories.output=${out}`,
    `-c.electronDist=${path.join(ROOT, 'node_modules/electron/dist')}`,
    // the negative control: a config file (replaces package.json "build"; -c.files would only add to it) with
    // the same settings but build.files stripped of every exclusion
    ...(noGuard ? ['--config', noGuardConfig()] : []),
  ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const res = path.join(out, 'linux-unpacked', 'resources');
  const asarFile = path.join(res, 'app.asar');
  if (!fs.existsSync(asarFile)) throw new Error(`no app.asar under ${res}`);
  const files = [...listAsar(asarFile), ...walk(path.join(res, 'app.asar.unpacked')).map((f) => `(unpacked)${f}`)];
  const AUDIO = /\.(mp3|wav|ogg|m4a|flac|ncm)$/i;
  const bad = {
    decoys: files.filter((f) => /decoy/i.test(f) && !/decoy-control/.test(f)),
    motion: files.filter((f) => /\.(vmd|vrma|ncm)$/i.test(f)),
    libraries: files.filter((f) => /(^|\/)(vrm-dances|baked-dances)(\/|$)/.test(f)),
    // the only audio the app ships is its own voice packs
    audio: files.filter((f) => AUDIO.test(f) && !/\/src\/voicepacks\//.test(f)),
  };
  const shipped = {
    builtinDemo: files.includes('/src/core/dance-demo.js'),
    danceCode: ['/src/core/vrm-dances.js', '/src/core/vmd.js', '/src/core/vmd-retarget.js', '/src/main/dance-import.js', '/src/renderer/vrm-dance.js'].filter((f) => files.includes(f)),
    voicepackAudio: files.filter((f) => AUDIO.test(f)).length,
  };
  console.log(`electron-builder --linux dir: ${secs} s → ${asarFile}`);
  console.log(`files in the package: ${files.length}${noGuard ? ' (NEGATIVE CONTROL: build.files without the dance exclusions)' : ''}`);
  console.log(`decoys planted under src/ (${DECOYS.length}):\n  ${DECOYS.join('\n  ')}`);
  for (const [k, v] of Object.entries(bad)) console.log(`${v.length ? 'FAIL' : 'ok  '} ${k}: ${v.length}${v.length ? `\n  ${v.slice(0, 20).join('\n  ')}` : ''}`);
  console.log(`ok   the built-in demo dance (code, no asset) is shipped: ${shipped.builtinDemo}`);
  console.log(`ok   dance code shipped: ${shipped.danceCode.join(', ')}`);
  console.log(`ok   audio in the package: ${shipped.voicepackAudio} file(s), all under src/voicepacks/`);
  const control = files.includes('/src/assets-decoy-control.txt');
  console.log(`${control ? 'ok  ' : 'FAIL'} the control file planted beside the decoys is shipped: ${control}`);
  const failed = Object.values(bad).some((v) => v.length) || !shipped.builtinDemo || !control;
  console.log(failed ? 'RESULT: FAIL — dance assets would ship' : 'RESULT: PASS — no .vmd / .vrma / .ncm / dance audio / dance library in the package');
  code = failed ? 1 : 0;
} catch (e) {
  console.error(`error: ${e.stderr ? e.stderr.toString().slice(-2000) : e.message}`);
} finally {
  unplant();
  if (!keep) fs.rmSync(out, { recursive: true, force: true }); else console.log(`kept ${out}`);
}
process.exit(code);
