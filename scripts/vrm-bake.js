#!/usr/bin/env node
'use strict';

// Bakes the VRM motion library (docs/vrm-motion-system.md §3.7, §6): every entry of src/core/vrm-library.json
// with a `src` (a Mixamo .fbx under the assets folder) becomes <out>/<style>/<slot>.vrma, retargeted onto
// the VRM humanoid (scripts/lib/vrm-bake-core.js), and <out>/library.json lists what was baked (the runtime
// index the app reads over vrmlib://). Entries without a file (idle.posture-cycle) are copied into the index
// as they are. The app never parses FBX: it only plays .vrma.
//
//   node scripts/vrm-bake.js [--assets ~/vrm-assets] [--out <dir>] [--only id,id] [--three <node_modules dir>]
//
//   --assets  default $PIXELPET_VRM_ASSETS, else ~/vrm-assets
//   --out     default $PIXELPET_VRM_MOTIONS_DIR, else ~/vrm-assets/baked; refused inside the repository
//   --three   a folder with three@0.187.0 installed; by default it is installed once into the temp folder
//             (like scripts/build-vrm-vendor.js, the app gets no runtime dependency)
//
// The motions are for personal use only: nothing it reads or writes goes into git or the app package.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const B = require('./lib/vrm-bake-core');
const L = require('../src/core/vrm-library');

const THREE_VERSION = '0.187.0';
const ROOT = path.join(__dirname, '..');

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; out[k] = v; }
  }
  return out;
}
const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const insideRepo = (p) => { const r = path.relative(ROOT, path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };

// three (for FBXLoader), installed once outside the repository
function threeDir(given) {
  if (given) return path.resolve(home(given));
  const dir = path.join(os.tmpdir(), `pixelpet-vrm-bake-three-${THREE_VERSION}`);
  if (!fs.existsSync(path.join(dir, 'node_modules', 'three', 'package.json'))) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vrm-bake-three', private: true }));
    execFileSync('npm', ['install', '--no-audit', '--no-fund', `three@${THREE_VERSION}`], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  }
  return path.join(dir, 'node_modules');
}

async function loadThree(nm) {
  // FBXLoader reaches for a few browser globals while parsing; the animation files have no textures
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
  const THREE = await import(pathToFileURL(path.join(nm, 'three', 'build', 'three.module.js')).href);
  const { FBXLoader } = await import(pathToFileURL(path.join(nm, 'three', 'examples', 'jsm', 'loaders', 'FBXLoader.js')).href);
  return { THREE, FBXLoader };
}

// One Mixamo FBX → a clip in VRM terms (vrm-bake-core's clip shape).
function fbxToClip({ THREE, FBXLoader }, file) {
  const buf = fs.readFileSync(file);
  const warn = console.warn;
  console.warn = () => {}; // FBXLoader warns about every unused node type
  let group;
  try { group = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), ''); } finally { console.warn = warn; }
  const anim = group.animations && group.animations[0];
  if (!anim) throw new Error('no animation in the FBX');
  group.updateMatrixWorld(true);
  const bones = [];
  group.traverse((o) => { if (o.isBone && B.vrmBoneOf(o.name)) bones.push(o); });
  const hips = bones.find((b) => B.vrmBoneOf(b.name) === 'hips');
  if (!hips) throw new Error('no mixamorig Hips');
  const wq = (o) => o.getWorldQuaternion(new THREE.Quaternion()).toArray();
  const wp = (o) => o.getWorldPosition(new THREE.Vector3()).toArray();
  const restHipsRaw = wp(hips)[1];
  const unit = restHipsRaw > 5 ? 0.01 : 1; // Mixamo FBX are in centimetres
  const byName = new Map(anim.tracks.map((t) => [t.name, t]));
  const clip = { duration: anim.duration, bones: {}, hips: null, restHipsY: restHipsRaw * unit, rest: {} };
  for (const b of bones) {
    const vb = B.vrmBoneOf(b.name);
    clip.rest[vb] = wp(b).map((v) => v * unit);
    const W = wq(b);
    const P = b.parent ? wq(b.parent) : [0, 0, 0, 1];
    const t = byName.get(`${b.name}.quaternion`);
    if (t) {
      const values = [];
      for (let i = 0; i < t.times.length; i++) values.push(B.retargetQ(Array.from(t.values.slice(i * 4, i * 4 + 4)), P, W));
      clip.bones[vb] = { times: Array.from(t.times), values };
    } else {
      // no key: the bone stays at its rest, which is the identity in VRM terms (kept as a track so a
      // cross-fade never mixes it with the T-pose)
      clip.bones[vb] = { times: [0, anim.duration], values: [B.retargetQ(b.quaternion.toArray(), P, W), B.retargetQ(b.quaternion.toArray(), P, W)] };
    }
  }
  const tp = byName.get(`${hips.name}.position`);
  if (tp) {
    const m = hips.parent ? hips.parent.matrixWorld : new THREE.Matrix4();
    const v = new THREE.Vector3();
    const values = [];
    for (let i = 0; i < tp.times.length; i++) { v.fromArray(tp.values, i * 3).applyMatrix4(m); values.push([v.x * unit, v.y * unit, v.z * unit]); }
    clip.hips = { times: Array.from(tp.times), values };
  }
  return clip;
}

async function main() {
  const a = args(process.argv.slice(2));
  const assets = path.resolve(home(a.assets || process.env.PIXELPET_VRM_ASSETS || '~/vrm-assets'));
  const out = path.resolve(home(a.out || process.env.PIXELPET_VRM_MOTIONS_DIR || '~/vrm-assets/baked'));
  if (insideRepo(out)) throw new Error(`refusing to write motions inside the repository: ${out}`);
  if (insideRepo(assets)) throw new Error(`refusing to read assets from inside the repository: ${assets}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-library.json'), 'utf8'));
  const problems = L.validateManifest(manifest);
  if (problems.length) throw new Error(`src/core/vrm-library.json: ${problems.join('; ')}`);
  const only = typeof a.only === 'string' ? new Set(a.only.split(',')) : null;
  const three = await loadThree(threeDir(a.three));
  const index = { schema: 1, bakedAt: new Date().toISOString(), generator: 'scripts/vrm-bake.js', clips: {} };
  const prev = fs.existsSync(path.join(out, 'library.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'library.json'), 'utf8')) : null;
  const report = [];
  for (const [id, e] of Object.entries(manifest.clips)) {
    const { slot, style } = L.parseId(id);
    const meta = { kind: e.kind, style, label: e.label || slot, ...(e.sit ? { sit: true } : {}), ...(e.loop ? { loop: true } : {}), ...(e.cycle ? { cycle: e.cycle, every: e.every } : {}) };
    if (!e.src) { index.clips[id] = meta; report.push(`${id}: (no file) ${e.cycle ? `cycle ${e.cycle.join(' → ')}` : ''}`); continue; }
    const file = `${style}/${slot}.vrma`;
    if (only && !only.has(id)) { if (prev && prev.clips[id]) index.clips[id] = prev.clips[id]; continue; }
    const src = path.join(assets, e.src);
    try {
      const raw = fbxToClip(three, src);
      const clip = B.bakeParams(raw, e);
      const buf = B.writeVrma(clip, { name: id });
      fs.mkdirSync(path.join(out, style), { recursive: true });
      fs.writeFileSync(path.join(out, file), buf);
      index.clips[id] = { ...meta, file, duration: +clip.duration.toFixed(3), bones: Object.keys(clip.bones).length, src: e.src };
      report.push(`${id}: ${e.src} → ${file} (${clip.duration.toFixed(2)} s, ${Object.keys(clip.bones).length} bones, ${buf.length} B)`);
    } catch (err) {
      report.push(`${id}: FAILED ${e.src}: ${err.message}`);
    }
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'library.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(report.join('\n'));
  console.log(`wrote ${path.join(out, 'library.json')} (${Object.keys(index.clips).length} clips)`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { fbxToClip, loadThree, threeDir };
