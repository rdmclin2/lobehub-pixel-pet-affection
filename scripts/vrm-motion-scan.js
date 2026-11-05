#!/usr/bin/env node
'use strict';

// Scans the motion packs (T-5081, docs/vrm-motion-library.md §3): every Mixamo / postures .fbx and every motions .vmd
// is read into a clip in VRM terms (the bake's own readers: scripts/vrm-bake.js fbxToClip, src/core/vmd-retarget.js)
// and measured (scripts/lib/vrm-motion-features.js). The features feed the selection (scripts/vrm-motion-select.js).
// Also keeps a coarse joint track per clip (4 fps) for the review sheets (scripts/vrm-motion-sheet.js).
//
//   node scripts/vrm-motion-scan.js [--assets ~/vrm-assets] [--out ~/vrm-assets/_scan] [--only mixamo|postures|motions] [--limit n]
//
// Writes <out>/features.json and <out>/tracks.json, outside the repository (the file names and the numbers are
// harmless, but the cache sits next to the assets it describes).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Bake = require('./vrm-bake');
const F = require('./lib/vrm-motion-features');
const R = require('../src/core/vmd-retarget');

const ROOT = path.join(__dirname, '..');
const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const insideRepo = (p) => { const r = path.relative(ROOT, path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  return out;
}

// the joints drawn on a review sheet
const TRACK_JOINTS = ['hips', 'chest', 'head', 'leftElbow', 'leftHand', 'rightElbow', 'rightHand', 'leftFoot', 'rightFoot'];
function trackOf(clip, fps = 4) {
  const d = clip.duration || 0;
  const n = Math.min(40, Math.max(1, Math.floor(d * fps) + 1));
  const H = clip.restHipsY || 1;
  const origin = clip.hips ? F.sample(clip.hips, 0, false) : [0, H, 0];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1)) * d;
    const { pos } = F.poseAt(clip, t, origin);
    // knees: the middle of the leg chain is not in CHAINS; hips→foot is enough for a sheet
    out.push(TRACK_JOINTS.map((j) => pos[j].map((v) => +v.toFixed(3))));
  }
  return out;
}

function vmdToClip(file) {
  const { clip } = R.retargetVmd(fs.readFileSync(file), { face: false, stage: false });
  return clip;
}

async function main() {
  const a = args(process.argv.slice(2));
  const assets = path.resolve(home(a.assets || process.env.PIXELPET_VRM_ASSETS || '~/vrm-assets'));
  const out = path.resolve(home(a.out || path.join(assets, '_scan')));
  if (insideRepo(out)) throw new Error(`refusing to write the scan inside the repository: ${out}`);
  const inv = JSON.parse(fs.readFileSync(path.join(assets, 'inventory.json'), 'utf8'));
  const packs = a.only ? [a.only] : ['postures', 'mixamo', 'motions'];
  const three = await Bake.loadThree(Bake.threeDir(a.three));
  const prevF = fs.existsSync(path.join(out, 'features.json')) && !a.fresh ? JSON.parse(fs.readFileSync(path.join(out, 'features.json'), 'utf8')) : { clips: {} };
  const prevT = fs.existsSync(path.join(out, 'tracks.json')) && !a.fresh ? JSON.parse(fs.readFileSync(path.join(out, 'tracks.json'), 'utf8')) : { joints: TRACK_JOINTS, clips: {} };
  const feats = prevF.clips;
  const tracks = prevT.clips;
  let done = 0;
  let failed = 0;
  const t0 = Date.now();
  for (const pk of packs) {
    let files = inv.packs[pk].files.filter((f) => (pk === 'motions' ? /\.vmd$/i.test(f.path) : /\.fbx$/i.test(f.path)));
    if (a.limit) files = files.slice(0, Number(a.limit));
    for (const f of files) {
      const rel = f.path;
      if (feats[rel] && !a.fresh) { done++; continue; }
      try {
        const clip = pk === 'motions' ? vmdToClip(path.join(assets, rel)) : Bake.fbxToClip(three, path.join(assets, rel));
        feats[rel] = { pack: pk, ...F.features(clip) };
        tracks[rel] = trackOf(clip);
      } catch (e) {
        feats[rel] = { pack: pk, error: String(e && e.message).slice(0, 200) };
        failed++;
      }
      done++;
      if (done % 100 === 0) {
        console.log(`  ${done} clips (${failed} failed), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'features.json'), JSON.stringify({ schema: 1, scannedAt: new Date().toISOString(), clips: feats }));
      }
    }
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'features.json'), JSON.stringify({ schema: 1, scannedAt: new Date().toISOString(), clips: feats }));
  fs.writeFileSync(path.join(out, 'tracks.json'), JSON.stringify({ joints: TRACK_JOINTS, clips: tracks }));
  console.log(`scanned ${done} clips (${failed} failed) in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${out}/features.json, tracks.json`);
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { trackOf, TRACK_JOINTS };
