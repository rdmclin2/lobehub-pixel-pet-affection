#!/usr/bin/env node
'use strict';
// The motion library that ships inside the app (resources/vrm-motions → <app>/resources/vrm-motions): the Mixamo
// part of a baked v2 library (scripts/vrm-bake.js --v2), so a VRM from the store moves on a fresh install with
// nothing else to set up. Only clips baked from the Mixamo animations (the mixamo and postures packs, both Mixamo
// rigs: Adobe lets them be used inside an app) are taken; the MMD motions (motions pack) and the dances keep
// their own licences and stay out — they are still there for whoever links a full library (设置 → 角色 → VRM 动作库).
//
//   node scripts/vrm-bundle-motions.js [--from ~/vrm-assets/baked-v2] [--out resources/vrm-motions]
//   node scripts/vrm-bundle-motions.js --check    → the bundled folder matches its index, every clip is Mixamo
//
// The index (library.json) is the baked one with the other clips taken out, its counts recomputed, and the
// machine-local parts (the model probe, the dance folder) left out.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'resources', 'vrm-motions');
const PACKS = ['mixamo', 'postures']; // Mixamo rigs only
const STYLES = ['female', 'male', 'neutral'];

// a path git may track: a clip of the bundled library (resources/vrm-motions/<style>/<clip>.vrma)
const isBundledMotion = (f) => /^resources\/vrm-motions\/(female|male|neutral)\/[^/]+\.vrma$/.test(String(f));

const allowed = (c) => typeof c.src === 'string' && PACKS.includes(c.src.split('/')[0]);

// The bundled index from a baked one: { lib, files: [relative .vrma paths] }
function bundleIndex(baked) {
  const src = (baked && baked.clips) || {};
  const clips = {};
  for (const [id, c] of Object.entries(src)) if (c && c.file && allowed(c)) clips[id] = c;
  // a cycle (idle.posture-cycle) has no file of its own: kept when every posture it cycles through is kept
  for (const [id, c] of Object.entries(src)) {
    if (!c || c.file || !Array.isArray(c.cycle)) continue;
    const st = id.split('@')[1];
    if (c.cycle.every((p) => clips[`${p}@${st}`])) clips[id] = c;
  }
  const counts = {};
  for (const st of STYLES) counts[st] = {};
  for (const [id, c] of Object.entries(clips)) {
    const st = id.split('@')[1];
    const cat = c.category || c.kind;
    if (!counts[st] || !cat) continue;
    counts[st][cat] = (counts[st][cat] || 0) + 1;
  }
  const lib = {
    schema: baked.schema,
    bakedAt: baked.bakedAt,
    generator: baked.generator,
    index: baked.index,
    bundled: { packs: PACKS, note: 'Mixamo clips only (mixamo / postures packs); MMD motions and dances are not bundled' },
    styleFallback: baked.styleFallback,
    clips,
    counts,
  };
  return { lib, files: Object.values(clips).filter((c) => c.file).map((c) => c.file) };
}

// Problems with a bundled folder (empty = fine): every clip Mixamo, every file there, nothing else there
function check(dir = OUT) {
  const errors = [];
  let lib;
  try { lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')); } catch (e) { return [`library.json: ${e.message}`]; }
  const want = new Set();
  for (const [id, c] of Object.entries(lib.clips || {})) {
    if (!c.file) { if (!Array.isArray(c.cycle)) errors.push(`${id}: neither a file nor a cycle`); continue; }
    if (!allowed(c)) errors.push(`${id}: ${c.src || 'no source'} is not a Mixamo clip`);
    want.add(c.file);
    if (!fs.existsSync(path.join(dir, c.file))) errors.push(`${id}: ${c.file} missing`);
  }
  for (const st of fs.readdirSync(dir)) {
    const p = path.join(dir, st);
    if (!fs.statSync(p).isDirectory()) { if (st !== 'library.json') errors.push(`${st}: not part of the library`); continue; }
    if (!STYLES.includes(st)) { errors.push(`${st}/: not a style`); continue; }
    for (const f of fs.readdirSync(p)) if (!want.has(`${st}/${f}`)) errors.push(`${st}/${f}: not in library.json`);
  }
  return errors;
}

function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const out = path.resolve(arg('out', OUT));
  if (argv.includes('--check')) {
    const errors = check(out);
    for (const e of errors) console.error(`  ${e}`);
    console.log(errors.length ? `bundled motion library: ${errors.length} problem(s)` : `bundled motion library: ok (${out})`);
    return errors.length ? 1 : 0;
  }
  const from = path.resolve(arg('from', path.join(os.homedir(), 'vrm-assets', 'baked-v2')).replace(/^~(?=$|\/)/, os.homedir()));
  const baked = JSON.parse(fs.readFileSync(path.join(from, 'library.json'), 'utf8'));
  const { lib, files } = bundleIndex(baked);
  fs.rmSync(out, { recursive: true, force: true });
  let bytes = 0;
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(path.join(from, f), path.join(out, f));
    bytes += fs.statSync(path.join(out, f)).size;
  }
  fs.writeFileSync(path.join(out, 'library.json'), `${JSON.stringify(lib, null, 2)}\n`);
  const all = Object.keys(baked.clips || {}).length;
  console.log(`bundled ${Object.keys(lib.clips).length} of ${all} clips (${files.length} files, ${(bytes / 1048576).toFixed(1)} MB) from ${from} → ${out}`);
  for (const st of STYLES) console.log(`  ${st}: ${Object.entries(lib.counts[st]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const errors = check(out);
  for (const e of errors) console.error(`  ${e}`);
  return errors.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { bundleIndex, check, isBundledMotion, PACKS, OUT };
