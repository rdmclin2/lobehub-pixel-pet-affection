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

async function main() {
  const a = args(process.argv.slice(2));
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
module.exports = { fbxToClip, loadThree, threeDir, runtimeMeta, danceSource, danceExtras, creditOf, bakeDance };
