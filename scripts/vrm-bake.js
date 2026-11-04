#!/usr/bin/env node
'use strict';

// Bakes the VRM motion library (docs/vrm-motion-system.md §3.7, §6): every entry of src/core/vrm-library.json
// with a `src` (a Mixamo .fbx under the assets folder) becomes <out>/<style>/<slot>.vrma, retargeted onto
// the VRM humanoid (scripts/lib/vrm-bake-core.js), and <out>/library.json lists what was baked (the runtime
// index the app reads over vrmlib://). Entries without a file (idle.posture-cycle) are copied into the index
// as they are. The app never parses FBX: it only plays .vrma.
//
//   node scripts/vrm-bake.js [--assets ~/vrm-assets] [--out <dir>] [--only id,id] [--three <node_modules dir>]
//   node scripts/vrm-bake.js --v2 --check [--out ~/vrm-assets/baked-v2]   → the pose guard + MMD arm check only (T-5092)
//
//   --assets  default $PIXELPET_VRM_ASSETS, else ~/vrm-assets
//   --out     default $PIXELPET_VRM_MOTIONS_DIR, else ~/vrm-assets/baked; refused inside the repository
//   --three   a folder with three@0.187.0 installed; by default it is installed once into the temp folder
//             (like scripts/build-vrm-vendor.js, the app gets no runtime dependency)
//
// Dances (docs/vrm-dance.md §2, §5.5): an MMD motion baked into a .vrma, no three needed (src/core/vmd-retarget.js,
// the same code the app runs when a dance is imported):
//
//   node scripts/vrm-bake.js --dance <folder | file.vmd> [--out <dir>] [--id <id>] [--no-stage] [--no-face]
//
//   <folder>  a vidol dance pack (meta.json { type: "anim", src }) or an MMD folder (the VMD with the most body keys,
//             camera and prop motions skipped)
//   --out     default $PIXELPET_VRM_DANCES_DIR, else ~/vrm-assets/baked-dances; refused inside the repository.
//             Writes <out>/<id>/dance.vrma and <out>/<id>/bake.json (the bake report), copies the music
//             (audio.<ext>: mp3 / wav / ogg / m4a / flac; an encrypted .ncm is refused), the cover (cover.<ext>) and
//             the readme (readme.txt), and adds the dance to <out>/library.json — the dance library the app
//             serves over vrmlib://dance/… (src/main/vrm-dances.js; a development run finds ~/vrm-assets/baked-dances
//             by itself, or point PIXELPET_VRM_DANCES_DIR at <out>). --no-audio: the motion only.
//
// The motions are for personal use only: nothing it reads or writes goes into git or the app package.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const B = require('./lib/vrm-bake-core');
const L = require('../src/core/vrm-library');
const VMD = require('../src/core/vmd');
const R = require('../src/core/vmd-retarget');
const V = require('../src/core/vrm');

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

// how a reaction / hold plays at runtime (core/vrm-library.js cleanIndex reads these back)
const RUNTIME = ['mask', 'weight', 'hold', 'fadeIn', 'fadeOut', 'still', 'face', 'gaze'];
const runtimeMeta = (e) => (e.kind === 'reaction' || e.kind === 'hold' ? Object.fromEntries(RUNTIME.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])) : {});

// ---------- dances ----------
// The dancer's VMD in a folder: a vidol pack names it in meta.json; otherwise the motion VMD with the most bone keys.
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac)$/i;
const COVER_EXT = /\.(jpe?g|png|webp)$/i;
// the music, cover and readme next to the dance in its folder (§5.5): a vidol pack's meta.json audio, else the
// audio file named like the VMD, else the largest; cover.* / thumb.* first, else the first picture; readme*.txt
function danceExtras(dir, vmd, metaAudio) {
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  const size = (f) => fs.statSync(path.join(dir, f)).size;
  const stem = path.basename(vmd, path.extname(vmd)).toLowerCase();
  const songs = files.filter((f) => AUDIO_EXT.test(f));
  const audio = metaAudio && files.includes(metaAudio) ? metaAudio : songs.find((f) => path.basename(f, path.extname(f)).toLowerCase() === stem) || songs.sort((a, b) => size(b) - size(a))[0] || null;
  const pics = files.filter((f) => COVER_EXT.test(f));
  const cover = pics.find((f) => /^cover\./i.test(f)) || pics.find((f) => /^thumb\./i.test(f)) || pics[0] || null;
  const readme = files.find((f) => /\.txt$/i.test(f) && /re[a]?d[-_ ]?me/i.test(f)) || null;
  return { audio, cover, readme, encrypted: files.filter((f) => /\.ncm$/i.test(f)) };
}
// who made the motion, from its readme (shown with the dance)
function creditOf(text) {
  const m = /motion[ \t]*(?:by|:|：)[ \t]*([^\r\n]{1,80})/i.exec(text) || /(?:动作|動作|モーション)(?:作者|制作|製作)?[ \t]*[:：][ \t]*([^\r\n]{1,80})/.exec(text);
  return m ? m[0].trim().slice(0, 120) : null;
}

function danceSource(input) {
  const p = path.resolve(home(input));
  if (!fs.statSync(p).isDirectory()) return { vmd: p, name: path.basename(p, path.extname(p)), dir: path.dirname(p) };
  const meta = path.join(p, 'meta.json');
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m.type !== 'anim') throw new Error(`meta.json type "${m.type}" is not a dance (anim)`);
    return { vmd: path.join(p, m.src), name: m.name || path.basename(p), pack: 'vidol-pack', dir: p, metaAudio: typeof m.audio === 'string' ? path.basename(m.audio) : null };
  }
  const cands = fs.readdirSync(p).filter((f) => /\.vmd$/i.test(f)).map((f) => {
    const v = VMD.parseVmd(fs.readFileSync(path.join(p, f)));
    return { f, kind: VMD.classifyVmd(v), keys: v.bones.length };
  }).filter((c) => c.kind === 'motion').sort((x, y) => y.keys - x.keys);
  if (!cands.length) throw new Error(`no dance motion (.vmd) in ${p}`);
  return { vmd: path.join(p, cands[0].f), name: path.basename(p), pack: 'mmd-folder', others: cands.slice(1).map((c) => c.f), dir: p };
}
const slug = (s) => String(s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function bakeDance(a) {
  const out = path.resolve(home(typeof a.out === 'string' ? a.out : process.env.PIXELPET_VRM_DANCES_DIR || '~/vrm-assets/baked-dances'));
  if (insideRepo(out)) throw new Error(`refusing to write dances inside the repository: ${out}`);
  const src = danceSource(a.dance);
  if (insideRepo(src.vmd)) throw new Error(`refusing to read dances from inside the repository: ${src.vmd}`);
  const id = typeof a.id === 'string' ? a.id : slug(path.basename(path.resolve(home(a.dance)), '.vmd')) || `dance-${require('node:crypto').createHash('sha1').update(src.vmd).digest('hex').slice(0, 6)}`;
  if (!/^[a-z0-9-]{1,48}$/.test(id) || id === 'demo') throw new Error(`bad dance id "${id}" (a-z 0-9 -, at most 48, not "demo")`);
  const t0 = Date.now();
  const buf = fs.readFileSync(src.vmd);
  const { vrma, report } = R.bakeVmd(buf, { name: id, stage: a['no-stage'] ? false : undefined, face: !a['no-face'] });
  const ms = Date.now() - t0;
  // the app's own check of a .vrma, on the bytes written
  const jl = vrma.readUInt32LE(12);
  const check = V.inspectVrmaJson(JSON.parse(vrma.subarray(20, 20 + jl).toString('utf8')));
  if (!check.ok) throw new Error(`the baked .vrma does not pass inspectVrmaJson: ${check.errors.join('; ')}`);
  const dir = path.join(out, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dance.vrma'), vrma);
  const full = { id, name: src.name, source: src.pack || 'vmd', src: path.basename(src.vmd), vmdBytes: buf.length, bakeMs: ms, inspect: { ok: check.ok, specVersion: check.specVersion, humanoid: check.humanoid.length, expressions: check.expressions }, ...report };
  fs.writeFileSync(path.join(dir, 'bake.json'), `${JSON.stringify(full, null, 2)}\n`);
  // the music, cover and readme, and the library entry (§5.3)
  const ex = danceExtras(src.dir, src.vmd, src.metaAudio);
  for (const f of fs.readdirSync(dir)) if (/^(audio|cover)\./.test(f)) fs.rmSync(path.join(dir, f));
  let audio = null;
  if (ex.audio && !a['no-audio']) { audio = `audio.${path.extname(ex.audio).slice(1).toLowerCase()}`; fs.copyFileSync(path.join(src.dir, ex.audio), path.join(dir, audio)); }
  let cover = null;
  if (ex.cover) { cover = `cover.${path.extname(ex.cover).slice(1).toLowerCase().replace('jpeg', 'jpg')}`; fs.copyFileSync(path.join(src.dir, ex.cover), path.join(dir, cover)); }
  let credit = null;
  if (ex.readme) { const txt = fs.readFileSync(path.join(src.dir, ex.readme)); fs.writeFileSync(path.join(dir, 'readme.txt'), txt); credit = creditOf(txt.toString('utf8')); }
  const entry = {
    name: src.name, file: `${id}/dance.vrma`, ...(audio ? { audio: `${id}/${audio}` } : {}), ...(cover ? { cover: `${id}/${cover}` } : {}),
    duration: report.duration, offset: 0, loop: !audio && report.duration <= 15, ...(credit ? { credit } : {}), ...(ex.readme ? { readme: `${id}/readme.txt` } : {}),
    face: !!report.face, ik: report.ik, ...(report.stage ? { stage: { radius: report.stage.radius, clampHits: report.stage.clampHits } } : {}), extent: report.extent, ground: report.ground,
    source: src.pack || 'vmd', src: { motion: path.basename(src.vmd), ...(ex.audio ? { audio: ex.audio } : {}) }, bakedWith: R.BAKED_WITH, importedAt: new Date().toISOString(),
  };
  const libFile = path.join(out, 'library.json');
  let lib = { schema: 1, dances: {} };
  try { lib = JSON.parse(fs.readFileSync(libFile, 'utf8')); if (!lib.dances) lib.dances = {}; } catch { /* a new library */ }
  lib.schema = 1;
  lib.dances[id] = entry;
  fs.writeFileSync(`${libFile}.tmp`, `${JSON.stringify(lib, null, 2)}\n`);
  fs.renameSync(`${libFile}.tmp`, libFile); // never a half-written index
  full.library = { file: libFile, entry };
  if (ex.encrypted.length && !audio) console.warn(`  music:  ${ex.encrypted.join(', ')} is an encrypted (.ncm) file — use mp3 / wav / ogg / m4a`);
  const r = report;
  console.log([
    `dance ${id} 「${src.name}」 ← ${src.vmd}${src.others && src.others.length ? ` (other motions in the folder: ${src.others.join(', ')})` : ''}`,
    `  source: model 「${r.modelName}」, ${r.source.boneKeys} bone keys / ${r.source.morphKeys} morph keys, last frame ${r.source.lastFrame}, ${r.source.bones} bones named, IK switch frames ${r.source.ikSwitchFrames}`,
    `  out:    ${r.duration} s, ${r.frames} frames @ ${r.fps} fps, ${r.bones.vrm} VRM bone tracks (${r.bones.animated.length} animated), ${r.keys} keys, ${r.bytes} B, baked in ${ms} ms`,
    `  bones:  ${r.bones.mapped.length} MMD bones mapped, ${r.bones.ignored.length} ignored (${r.bones.ignored.join(' ') || '-'}), ${r.bones.unmapped.length} unmapped${r.bones.unmapped.length ? ` (${r.bones.unmapped.slice(0, 12).join(' ')}${r.bones.unmapped.length > 12 ? ' …' : ''})` : ''}`,
    `  legs:   ${r.ik} (left ${r.legs.left}, right ${r.legs.right}); IK frames ${r.ikStats.frames}, max FK error ${r.ikStats.maxErrorMm} mm, farthest target ${r.ikStats.reachMax} leg lengths (stretched ${(r.ikStats.unreachable * 100).toFixed(1)}%), knee ${r.ikStats.kneeMinDeg}°…${r.ikStats.kneeMaxDeg}°`,
    `  arms:   A-pose ${r.aPoseDeg.left}° / ${r.aPoseDeg.right}°; fingers ${r.fingers.left} / ${r.fingers.right}`,
    `  stage:  ${r.stage ? `radius ${r.stage.radius} hips heights, limited on ${(r.stage.clampHits * 100).toFixed(1)}% of frames, raw drift up to ${r.stage.maxDriftM} m` : 'off'}; extent up ${r.extent.up} / side ${r.extent.side} hips heights; ground ${r.ground}`,
    `  face:   ${r.expressions.join(' ') || '-'} (from ${r.morphs.mapped.join(' ') || '-'}; not mapped: ${r.morphs.unmapped.slice(0, 10).join(' ') || '-'}${r.morphs.unmapped.length > 10 ? ' …' : ''})`,
    `  check:  inspectVrmaJson ok=${check.ok} spec ${check.specVersion}, ${check.humanoid.length} humanoid bones, expressions [${check.expressions.join(', ')}]`,
    `  extras: music ${audio ? `${ex.audio} → ${audio}` : '-'}; cover ${cover ? `${ex.cover} → ${cover}` : '-'}; readme ${ex.readme || '-'}${credit ? ` (${credit})` : ''}`,
    `  wrote   ${path.join(dir, 'dance.vrma')} + bake.json; library ${libFile} (${Object.keys(lib.dances).length} dances)`,
  ].join('\n'));
  return full;
}

// ---------- the v2 library (T-5081, docs/vrm-motion-library.md §6) ----------
// node scripts/vrm-bake.js --v2 [--assets ~/vrm-assets] [--out ~/vrm-assets/baked-v2] [--only id,id] [--no-dances]
//                              [--install [--user-data <dir>]]
// Every clip of src/core/vrm-motion-index.json → <out>/<style>/<slot>.vrma + <out>/library.json (the motion library,
// PIXELPET_VRM_MOTIONS_DIR=<out>), every dance → <out>/dances/<id>/dance.vrma + <out>/dances/library.json (the dance
// library, PIXELPET_VRM_DANCES_DIR=<out>/dances; an MMD dance keeps its music, a Mixamo one is a silent loop).
// --install copies both into the app's data folder (<userData>/vrm-motions, <userData>/vrm-dances), where a packaged
// app finds them (src/main/vrm-library.js libraryDir, src/main/vrm-dances.js danceDir).
const LOOP_SEAM_MAX = 2; // deg: a baked loop's last frame may differ from its first by at most this (test/vrm-motion-index.test.js)

function userDataDir(given) {
  if (given) return path.resolve(home(given));
  if (process.env.PIXELPET_DATA_DIR) return path.resolve(home(process.env.PIXELPET_DATA_DIR));
  const name = require('../package.json').productName; // Electron's app.name: the userData folder name
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, f.name);
    const d = path.join(to, f.name);
    if (f.isDirectory()) n += copyTree(s, d);
    else if (f.isFile()) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

// <out> → <userData>/vrm-motions and <userData>/vrm-dances (the old contents replaced, library.json written last)
function installLibrary(out, userData) {
  const ud = userDataDir(userData);
  if (insideRepo(ud)) throw new Error(`refusing to install inside the repository: ${ud}`);
  const res = {};
  const motions = path.join(ud, 'vrm-motions');
  fs.rmSync(motions, { recursive: true, force: true });
  let n = 0;
  for (const st of L.SETS) if (fs.existsSync(path.join(out, st))) n += copyTree(path.join(out, st), path.join(motions, st));
  fs.copyFileSync(path.join(out, 'library.json'), path.join(motions, 'library.json'));
  res.motions = { dir: motions, files: n + 1 };
  if (fs.existsSync(path.join(out, 'dances', 'library.json'))) {
    const dances = path.join(ud, 'vrm-dances');
    fs.rmSync(dances, { recursive: true, force: true });
    res.dances = { dir: dances, files: copyTree(path.join(out, 'dances'), dances) };
  }
  return res;
}

function sourceClip(three, assets, src) {
  const file = path.join(assets, src);
  if (/\.vmd$/i.test(src)) return R.retargetVmd(fs.readFileSync(file), { face: false, stage: false }).clip;
  return fbxToClip(three, file);
}

const Probe = require('./lib/vrm-model-probe');
function countFiles(dir, re) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(path.join(dir, e.name), re) : re.test(e.name) ? 1 : 0;
  return n;
}

const V2_META = ['category', 'group', 'enter', 'exit', 'pack', 'srcStyle', 'by', 'armsOut'];

async function bakeV2(a) {
  const assets = path.resolve(home(a.assets || process.env.PIXELPET_VRM_ASSETS || '~/vrm-assets'));
  const out = path.resolve(home(typeof a.out === 'string' ? a.out : '~/vrm-assets/baked-v2'));
  if (insideRepo(out)) throw new Error(`refusing to write motions inside the repository: ${out}`);
  if (insideRepo(assets)) throw new Error(`refusing to read assets from inside the repository: ${assets}`);
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-motion-index.json'), 'utf8'));
  if (idx.schema !== 2) throw new Error('src/core/vrm-motion-index.json: schema 2 expected');
  const problems = L.validateManifest({ schema: 1, clips: idx.clips });
  if (problems.length) throw new Error(`src/core/vrm-motion-index.json: ${problems.slice(0, 10).join('; ')}`);
  const only = typeof a.only === 'string' ? new Set(a.only.split(',')) : null;
  const three = await loadThree(threeDir(a.three));
  const t0 = Date.now();
  // the five input packs (postures / mixamo / motions: clips; dances: the dance library; models: the per-model check)
  const PACKS = ['postures', 'mixamo', 'motions', 'dances', 'models'];
  const used = Object.fromEntries(PACKS.map((pk) => [pk, new Set()]));
  for (const e of Object.values(idx.clips)) if (e.src) used[e.src.split('/')[0]].add(e.src);
  for (const e of Object.values(idx.dances || {})) used[e.pack].add(e.src);
  console.log(`inputs (${assets}):`);
  for (const pk of PACKS) {
    const dir = path.join(assets, pk);
    const n = fs.existsSync(dir) ? countFiles(dir, pk === 'models' ? /\.vrm$/i : /\.(fbx|vmd)$/i) : 0;
    console.log(`  ${pk.padEnd(8)} ${dir}  ${fs.existsSync(dir) ? `${n} ${pk === 'models' ? '.vrm models' : 'source files'}` : 'MISSING'}${pk === 'models' ? ' (probed after the bake)' : `, ${used[pk].size} used by the index`}`);
  }
  const lib = { schema: 1, bakedAt: new Date().toISOString(), generator: 'scripts/vrm-bake.js --v2', index: 'src/core/vrm-motion-index.json', styleFallback: idx.styleFallback, clips: {} };
  const prev = fs.existsSync(path.join(out, 'library.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'library.json'), 'utf8')) : null;
  const report = [];
  const failed = [];
  const raws = new Map(); // a source read once for all three styles
  const baked = new Map(); // and baked once per parameter set
  for (const [id, e] of Object.entries(idx.clips)) {
    const { slot, style } = L.parseId(id);
    const meta = { kind: e.kind, style, label: e.label || slot, ...(e.sit ? { sit: true } : {}), ...(e.loop ? { loop: true } : {}), ...(e.cycle ? { cycle: e.cycle, every: e.every } : {}), ...runtimeMeta(e), ...Object.fromEntries(V2_META.filter((k) => e[k] !== undefined).map((k) => [k, e[k]])) };
    if (!e.src) { lib.clips[id] = meta; continue; }
    const file = `${style}/${slot}.vrma`;
    if (only && !only.has(id)) { if (prev && prev.clips[id]) lib.clips[id] = prev.clips[id]; continue; }
    try {
      if (!raws.has(e.src)) raws.set(e.src, sourceClip(three, assets, e.src));
      const raw = raws.get(e.src);
      const params = Object.fromEntries(Object.entries(e).filter(([k]) => !['style', 'label', 'about', 'score', 'by', 'srcStyle', 'category', 'group', 'enter', 'exit', 'pack', 'duration', 'srcDuration', 'autoTrim', 'note'].includes(k)));
      const key = `${e.src}|${JSON.stringify(params)}`;
      if (!baked.has(key)) {
        const clip = B.bakeParams(raw, e);
        const speed = e.detrend ? B.travelSpeed(Array.isArray(e.trim) ? B.trimClip(raw, e.trim[0], e.trim[1]) : raw) : 0;
        baked.set(key, { clip, speed, buf: B.writeVrma(clip, { name: slot }) });
      }
      const { clip, speed, buf } = baked.get(key);
      fs.mkdirSync(path.join(out, style), { recursive: true });
      fs.writeFileSync(path.join(out, file), buf);
      const seam = e.loop && e.kind !== 'posture' ? +B.seamAngle(clip).toFixed(2) : undefined;
      lib.clips[id] = { ...meta, file, duration: +clip.duration.toFixed(3), bones: Object.keys(clip.bones).length, src: e.src, ...(speed > 0 ? { speed: +speed.toFixed(4) } : {}), ...(seam !== undefined ? { seamDeg: seam } : {}) };
      if (seam !== undefined && seam > LOOP_SEAM_MAX) failed.push(`${id}: loop seam ${seam}° > ${LOOP_SEAM_MAX}°`);
      report.push(`${id}: ${e.src} → ${file} (${clip.duration.toFixed(2)} s, ${Object.keys(clip.bones).length} bones, ${buf.length} B${seam !== undefined ? `, seam ${seam}°` : ''})`);
    } catch (err) {
      failed.push(`${id}: ${e.src}: ${err.message}`);
    }
  }
  fs.mkdirSync(out, { recursive: true });
  // ---- models pack: what every model there can play (the renderer's degrade rules) ----
  const modelsDir = path.join(assets, 'models');
  if (fs.existsSync(modelsDir)) {
    lib.models = Probe.probeModels(modelsDir, lib.clips);
    console.log(`models: probed ${lib.models.probed} VRM in ${modelsDir}: ${JSON.stringify(lib.models.summary)}`);
    for (const [rel, m] of Object.entries(lib.models.models)) {
      if (m.error) console.log(`  model ${rel}: ERROR ${m.error}`);
      else if (m.level !== 'full' || m.rootHips) console.log(`  model ${rel}: VRM ${m.vrm}, ${m.level}${m.missingTrunk.length ? ` (missing ${m.missingTrunk.join('/')} → folded into children)` : ''}${m.missingRequired.length ? ` (missing required ${m.missingRequired.join('/')})` : ''}${m.rootHips ? `, hips at ${m.hipsY} m → ${m.legRig && m.legRig.ok ? `retargeted on the leg chain (hip joints ${m.legRig.height} m: chain ${m.legRig.chain} + ankle ${m.legRig.ankle})` : 'standing clips only (no leg chain)'}` : ''}${m.playable ? `, plays ${m.playable.female}/${m.playable.male}/${m.playable.neutral} clips (female/male/neutral)` : ''}`);
    }
  } else console.log(`models: ${modelsDir} missing — no per-model check`);
  lib.counts = {};
  for (const c of Object.values(lib.clips)) { const k = c.style; lib.counts[k] = lib.counts[k] || {}; lib.counts[k][c.category || c.kind] = (lib.counts[k][c.category || c.kind] || 0) + 1; }
  // ---- dances ----
  if (!a['no-dances']) {
    const dout = path.join(out, 'dances');
    fs.mkdirSync(dout, { recursive: true });
    const dlibFile = path.join(dout, 'library.json');
    let dlib = { schema: 1, dances: {} };
    try { dlib = JSON.parse(fs.readFileSync(dlibFile, 'utf8')); if (!dlib.dances) dlib.dances = {}; } catch { /* new */ }
    for (const [id, e] of Object.entries(idx.dances || {})) {
      if (only && !only.has(id)) continue;
      try {
        if (e.pack === 'dances') {
          const quiet = console.log;
          console.log = () => {};
          try { bakeDance({ dance: path.join(assets, e.folder), out: dout, id }); } finally { console.log = quiet; }
          dlib = JSON.parse(fs.readFileSync(dlibFile, 'utf8'));
        } else {
          const raw = sourceClip(three, assets, e.src);
          const clip = B.centerClip(B.bakeParams(raw, { kind: 'idle', loop: true }));
          const buf = B.writeVrma(clip, { name: id });
          fs.mkdirSync(path.join(dout, id), { recursive: true });
          fs.writeFileSync(path.join(dout, id, 'dance.vrma'), buf);
          dlib.dances[id] = { name: e.name, file: `${id}/dance.vrma`, duration: +clip.duration.toFixed(3), offset: 0, loop: true, face: false, ground: 0, source: 'vrma', src: { motion: path.basename(e.src) }, bakedWith: 'vrm-bake-core@mixamo', importedAt: new Date().toISOString() };
        }
        Object.assign(dlib.dances[id], { styles: e.styles, category: 'dance', pack: e.pack });
        if (e.armsOut) dlib.dances[id].armsOut = e.armsOut; else delete dlib.dances[id].armsOut;
        fs.writeFileSync(dlibFile, `${JSON.stringify(dlib, null, 2)}\n`);
        report.push(`dance ${id}: ${e.src} → dances/${id}/dance.vrma (${dlib.dances[id].duration} s${dlib.dances[id].audio ? ', with music' : ''}; styles ${e.styles.join('/')})`);
      } catch (err) {
        failed.push(`dance ${id}: ${e.src}: ${err.message}`);
      }
    }
    lib.dances = { dir: 'dances', count: Object.keys(dlib.dances).length };
    for (const d of Object.values(dlib.dances)) for (const st of d.styles || L.SETS) { lib.counts[st] = lib.counts[st] || {}; lib.counts[st].dance = (lib.counts[st].dance || 0) + 1; }
  }
  fs.writeFileSync(path.join(out, 'library.json.tmp'), `${JSON.stringify(lib, null, 2)}\n`);
  fs.renameSync(path.join(out, 'library.json.tmp'), path.join(out, 'library.json'));
  console.log(report.join('\n'));
  if (failed.length) console.log(`FAILED (${failed.length}):\n  ${failed.join('\n  ')}`);
  console.log(`wrote ${path.join(out, 'library.json')}: ${Object.keys(lib.clips).length} clips in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`counts ${JSON.stringify(lib.counts)}`);
  // ---- T-5092: the pose guard over everything just baked (and the MMD arm check); a hit fails the bake ----
  const guard = poseGuard(out, assets, idx);
  for (const l of guard.lines) console.log(l);
  failed.push(...guard.failed);
  if (a.install) {
    const r = installLibrary(out, typeof a['user-data'] === 'string' ? a['user-data'] : null);
    console.log(`installed: ${r.motions.dir} (${r.motions.files} files)${r.dances ? `, ${r.dances.dir} (${r.dances.files} files)` : ''}`);
  }
  return { lib, failed };
}

// T-5092: the automatic posture guard (scripts/lib/vrm-pose-guard.js) over a baked library — every clip and dance
// frame by frame (T-pose: both upper arms level with straight elbows for ≥ 0.2 s, unless annotated armsOut within
// its maxS) — and the MMD → VRM arm check of every VMD source (an independent MMD forward kinematics, ≤ ARM_TOL°).
// `--v2 --check` runs only this, on --out (default ~/vrm-assets/baked-v2), and exits 1 on any hit.
const Guard = require('./lib/vrm-pose-guard');
const ARM_TOL = 5;
function poseGuard(out, assets, idx) {
  const sum = Guard.checkLibrary(out);
  // an armsOut annotation covers runs up to its maxS only
  for (const r of sum.rows) if (r.suspect && r.armsOut && !(r.longestS <= r.armsOut.maxS)) r.armsOut = null;
  const s2 = Guard.summarize(sum.rows);
  const lines = Guard.formatReport(s2).map((l) => l.replace(/— armsOut: \[object Object\]/, ''));
  for (const r of s2.allowedList) { const i = lines.findIndex((l) => l.startsWith(`  allowed  ${r.id}:`)); if (i >= 0) lines[i] = `  allowed  ${r.id}: ${r.longestS} s @ ${r.at} s ≤ armsOut ${r.armsOut.maxS} s (${r.armsOut.why})`; }
  const failed = s2.hitList.map((r) => `pose guard: ${r.id} holds a T-pose ${r.longestS} s @ ${r.at} s (${r.src})`);
  for (const r of s2.stiffList) failed.push(`pose guard: ${r.id} holds both arms out stiff (${r.stiffOutDeg}° to the side) ${r.stiffS} s @ ${r.stiffAt} s (${r.src})`);
  const vmds = new Set();
  for (const e of Object.values(idx.clips)) if (e.src && /\.vmd$/i.test(e.src)) vmds.add(e.src);
  for (const e of Object.values(idx.dances || {})) if (/\.vmd$/i.test(e.src)) vmds.add(e.src);
  let worst = { maxUpperDeg: 0, maxForeDeg: 0 };
  let samples = 0;
  for (const src of [...vmds].sort()) {
    const file = path.join(assets, src);
    if (!fs.existsSync(file)) { failed.push(`arm check: ${src} missing`); continue; }
    const r = Guard.vmdArmCheck(fs.readFileSync(file));
    samples += r.samples;
    if (r.maxUpperDeg > worst.maxUpperDeg) worst = { ...r, src };
    if (r.maxUpperDeg > ARM_TOL || r.maxForeDeg > ARM_TOL) failed.push(`arm check: ${src} upper arm ${r.maxUpperDeg}° / forearm ${r.maxForeDeg}° off the MMD pose @ ${r.at} s`);
  }
  lines.push(`arm check (MMD → VRM): ${vmds.size} VMD sources, ${samples} arm samples, worst upper arm ${worst.maxUpperDeg}° (${worst.src || '-'} @ ${worst.at || 0} s), tolerance ${ARM_TOL}° — ${failed.some((f) => f.startsWith('arm check')) ? 'FAILED' : 'ok'}`);
  return { sum: s2, lines, failed };
}

function checkV2(a) {
  const assets = path.resolve(home(a.assets || process.env.PIXELPET_VRM_ASSETS || '~/vrm-assets'));
  const out = path.resolve(home(typeof a.out === 'string' ? a.out : '~/vrm-assets/baked-v2'));
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-motion-index.json'), 'utf8'));
  console.log(`pose guard on ${out}`);
  const lib = JSON.parse(fs.readFileSync(path.join(out, 'library.json'), 'utf8'));
  const idles = {};
  for (const c of Object.values(lib.clips)) if (c.kind === 'idle' && c.file) idles[c.style] = (idles[c.style] || 0) + 1;
  const g = poseGuard(out, assets, idx);
  for (const l of g.lines) console.log(l);
  // every idle clip: the largest angle both upper arms reach together (from the torso's down axis) and its T-pose frames
  console.log('idle clips (both upper arms together: max angle from the torso\'s down axis; T-pose frames; longest run):');
  for (const r of g.sum.rows.filter((x) => x.kind === 'idle').sort((a, b) => a.id.localeCompare(b.id))) console.log(`  ${r.id.padEnd(22)} ${(r.src || '').slice(0, 58).padEnd(58)} max ${String(r.bothArmsMaxDeg).padStart(5)}°  T-pose frames ${r.tposeFrames}  longest ${r.longestS} s  stiff-out ${r.stiffS} s${r.suspect ? '  HIT' : ''}${r.stiff ? '  STIFF' : ''}`);
  const short = Object.entries(idles).filter(([, n]) => n < 6);
  console.log(`idle clips per style: ${JSON.stringify(idles)}${short.length ? ' — FAILED (< 6)' : ' (≥ 6 each)'}`);
  for (const [st] of short) g.failed.push(`idle: ${st} has fewer than 6 idle clips`);
  if (g.failed.length) console.log(`FAILED (${g.failed.length}):\n  ${g.failed.join('\n  ')}`);
  return g;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.v2 && a.check) { const g = checkV2(a); if (g.failed.length) process.exitCode = 1; return; }
  if (a.v2) { const r = await bakeV2(a); if (r.failed.length) process.exitCode = 1; return; }
  if (a.install) { const out = path.resolve(home(typeof a.out === 'string' ? a.out : '~/vrm-assets/baked-v2')); const r = installLibrary(out, typeof a['user-data'] === 'string' ? a['user-data'] : null); console.log(JSON.stringify(r)); return; }
  if (a.dance) { bakeDance(a); return; }
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
    const meta = { kind: e.kind, style, label: e.label || slot, ...(e.sit ? { sit: true } : {}), ...(e.loop ? { loop: true } : {}), ...(e.cycle ? { cycle: e.cycle, every: e.every } : {}), ...runtimeMeta(e) };
    if (!e.src) { index.clips[id] = meta; report.push(`${id}: (no file) ${e.cycle ? `cycle ${e.cycle.join(' → ')}` : ''}`); continue; }
    const file = `${style}/${slot}.vrma`;
    if (only && !only.has(id)) { if (prev && prev.clips[id]) index.clips[id] = prev.clips[id]; continue; }
    const src = path.join(assets, e.src);
    try {
      const raw = fbxToClip(three, src);
      const clip = B.bakeParams(raw, e);
      // a walk's own pace (hip heights per second, measured before it is walked in place): the director
      // plays it at the window's pace with it (T-2711)
      const speed = e.detrend ? B.travelSpeed(Array.isArray(e.trim) ? B.trimClip(raw, e.trim[0], e.trim[1]) : raw) : 0;
      const buf = B.writeVrma(clip, { name: id });
      fs.mkdirSync(path.join(out, style), { recursive: true });
      fs.writeFileSync(path.join(out, file), buf);
      index.clips[id] = { ...meta, file, duration: +clip.duration.toFixed(3), bones: Object.keys(clip.bones).length, src: e.src, ...(speed > 0 ? { speed: +speed.toFixed(4) } : {}) };
      let seam = '';
      if (e.loop && e.kind !== 'posture') { const pre = B.bakeParams(raw, { ...e, loop: false }); seam = `, loop seam ${B.seamAngle(pre).toFixed(1)}° → blend ${(typeof e.loopBlend === 'number' ? e.loopBlend : B.seamBlend(pre)).toFixed(2)} s`; }
      report.push(`${id}: ${e.src} → ${file} (${clip.duration.toFixed(2)} s, ${Object.keys(clip.bones).length} bones, ${buf.length} B${seam}${speed > 0 ? `, walks ${speed.toFixed(3)} hip heights/s` : ''})`);
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
module.exports = { poseGuard, checkV2, ARM_TOL, fbxToClip, loadThree, threeDir, runtimeMeta, danceSource, danceExtras, creditOf, bakeDance, bakeV2, installLibrary, userDataDir, LOOP_SEAM_MAX };
