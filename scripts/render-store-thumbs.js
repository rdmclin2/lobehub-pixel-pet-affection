#!/usr/bin/env node
'use strict';

// 商店 → VRM 角色: a card picture for every VRM model of src/core/vrm-catalog.json that has no thumbnail of its
// own (scripts/build-store-assets.js leaves `picture` null then): the model drawn standing (stand.playful) by
// the app's own runtime (scripts/vrm-dance-frames.js), cropped to a square, written to
// src/renderer/catalog/vrm/<id>.png and recorded in the index.
//
//   xvfb-run -a node scripts/render-store-thumbs.js [--src ~/vrm-assets] [--pose <file.vrma>]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const SRC = path.resolve(arg('--src', path.join(os.homedir(), 'vrm-assets')));
const POSE = path.resolve(arg('--pose', path.join(SRC, 'baked', 'female', 'stand.playful.vrma')));
const INDEX = path.join(ROOT, 'src', 'core', 'vrm-catalog.json');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-thumbs-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let n = 0;
for (const c of index.characters) {
  if (c.picture) continue;
  const name = `t${n}`;
  // stdin ignored: electron must not read the caller's input
  execFileSync(ELECTRON, ['--no-sandbox', path.join(__dirname, 'vrm-dance-frames.js'), '--model', path.join(SRC, 'models', c.source), '--dance', POSE, '--out', tmp, '--times', '0.5', '--count', '1', '--size', '256x400', '--name', name], { env, stdio: ['ignore', 'ignore', 'inherit'], timeout: 120000 });
  const dest = path.join(ROOT, 'src', 'renderer', 'catalog', 'vrm', `${c.id}.png`);
  // a model whose humanoid reads hips at 0 m is framed off-screen: a blank picture is worse than none
  const m = JSON.parse(fs.readFileSync(path.join(tmp, `${name}.json`), 'utf8'));
  if (!(m.hipsY > 0.2)) { console.log(`${c.id}  skipped (hips not found)`); continue; }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmp, `${name}.png`), '-vf', 'crop=256:256:0:30', dest]);
  c.picture = `catalog/vrm/${c.id}.png`;
  n++;
  console.log(`${c.id}  ← ${c.source}`);
}
fs.writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`${n} pictures rendered; ${path.relative(ROOT, INDEX)} updated`);
