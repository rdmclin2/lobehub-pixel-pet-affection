#!/usr/bin/env node
'use strict';

// 商店 → 舞蹈 / VRM 角色 (docs/vrm-dance.md §11): turn the dance packages and VRM models of a source folder
// (default ~/vrm-assets) into downloadable archives, and write the indexes the app ships with.
//
//   node scripts/build-store-assets.js [--src ~/vrm-assets] [--out ~/vrm-assets/store] [--only dances|vrm]
//
//   <out>/dances/<id>.zip                  dance.json + dance.vrma (+ audio.mp3, cover.jpg, readme.txt)
//   <out>/vrm/<id>.zip                     a VRM character pack (pack.json, models/<file>.vrm, preview.png)
//   src/core/dance-catalog.json            the dance index: name, credit, duration, size, sha256 per dance
//   src/core/vrm-catalog.json              the VRM character index, with each model's license rows
//   src/renderer/catalog/dances/<id>.jpg   the card pictures (dance cover, VRM thumbnail)
//   src/renderer/catalog/vrm/<id>.png
//
// The archives never go into the repository (third-party motions, music and models): the output folder may not
// be inside it. Upload them with `node scripts/upload-store-assets.js`. Reproducible like the character
// catalog: the same sources give the same zips (sorted entries, fixed timestamps).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { zip, sha256 } = require('./build-character-catalog');
const VMD = require('../src/core/vmd');
const R = require('../src/core/vmd-retarget');
const V = require('../src/core/vrm');
const P = require('../src/core/packs');
const Dances = require('../src/core/vrm-dances');
const VrmUi = require('../src/core/vrm-ui');
const DanceImport = require('../src/main/dance-import');
const { importVrm } = require('../src/core/vrm-import');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const SRC = path.resolve(arg('--src', path.join(os.homedir(), 'vrm-assets')));
const OUT = path.resolve(arg('--out', path.join(SRC, 'store')));
const ONLY = arg('--only', null);
const DANCE_INDEX = path.join(ROOT, 'src', 'core', 'dance-catalog.json');
const VRM_INDEX = path.join(ROOT, 'src', 'core', 'vrm-catalog.json');
const PICS = path.join(ROOT, 'src', 'renderer', 'catalog');
const DANCE_RELEASE = 'dances-v1';
const VRM_RELEASE = 'vrm-v1';
// the base every store VRM character belongs to (core/species.js): her stats and voice come from it
const VRM_BASE = 'dafeiyu';

const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const ffmpeg = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
const slug = (s) => String(s || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const hash8 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// The Develop Center takes at most 20 MB per file: a larger archive goes up as <id>-p1.zip, <id>-p2.zip … (plain
// byte ranges), listed in the index as `parts`; the app downloads them in order and checks the whole file.
const PART_BYTES = 19 * 1024 * 1024;
function splitParts(file) {
  const size = fs.statSync(file).size;
  const dir = path.dirname(file);
  const id = path.basename(file, '.zip');
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${id}-p`) && /-p\d+\.zip$/.test(f)) fs.rmSync(path.join(dir, f));
  if (size <= PART_BYTES) return null;
  const buf = fs.readFileSync(file);
  const parts = [];
  for (let i = 0, off = 0; off < size; i++, off += PART_BYTES) {
    const name = `${id}-p${i + 1}.zip`;
    const chunk = buf.subarray(off, Math.min(size, off + PART_BYTES));
    fs.writeFileSync(path.join(dir, name), chunk);
    parts.push({ file: name, bytes: chunk.length });
  }
  return parts;
}

function uniqueId(prefix, name, used, fallback) {
  let s = slug(name).slice(0, 30).replace(/-+$/, '');
  if (s.length < 3) s = hash8(fallback || name);
  let id = `${prefix}-${s}`;
  for (let i = 2; used.has(id); i++) id = `${prefix}-${s}-${i}`;
  used.add(id);
  return id;
}

// ---------- dances ----------

// Packages whose dance is split over several files: merged into one motion first (keys are absolute frames:
// "load all parts from frame zero"). Everything else goes through the same detection as 导入舞蹈 (detectDance).
const MERGE = { 'AOA - Miniskirt (Queendom ver.)': 'Motion in separate parts' };
// Display names for packages without a meta.json (the folder name otherwise)
const NAMES = {
  addiction: '[A]ddiction',
  galaxias: 'galaxias!',
  kiss_me_aishiteru: 'Kiss me 愛してる',
  lupin: 'LUPIN',
  magic_of_xyz: 'XYZの魔法',
  qsx: '青丝线',
  suki_yuki_maji_magic: '好き！雪！本気マジック',
};

// Who to credit, as each package's readme asks (the readmes are not uniform enough to read this from)
const CREDITS = {
  '(G)I-DLE - TOMBOY': 'Motion by NatsumiSan',
  'AOA - Miniskirt (Queendom ver.)': 'Motion by NatsumiSan',
  'Brown Eyed Girls - Abracadabra': 'Motion by NatsumiSan',
  'EVERGLOW - Bon Bon Chocolat (-Full Ver-)': 'Motion by NatsumiSan',
  'Ryan.B & D-DAY - I’m Feeling Good': 'Motion by NatsumiSan',
  'T-ARA - Bunny Style': 'Motion by NatsumiSan',
  'T-ARA - NUMBER NINE': 'Motion by NatsumiSan',
  'Chocolate Cream 【Motion by Ureshiiiiii】': 'Motion by ureshiiiiii',
  'TWICE - Like OOH-AHH': 'Motion by Nikisa San',
  addiction: '振付 足太ぺんた · モーショントレース配布 sm32142474',
  magic_of_xyz: 'hino式モーション · 振付 足太ぺんた',
  suki_yuki_maji_magic: '振付 足太ぺんた · モーショントレース配布 sm23692832',
  lupin: 'KARA LUPIN モーション（トレス元 sm14566712 / sm9871448）',
  galaxias: 'galaxias! Miku モーション v2',
  kiss_me_aishiteru: 'モーション配布 sm18207612',
  qsx: '动作配布 BV1wW411u7Cs',
  'vidol-dance-dingdingdangdhang': '动作 mars_official',
  'vidol-dance-gokuraku': 'Motion by yurie',
  'vidol-dance-last-surprise': 'Motion convert, camera and facials by Seto',
  'vidol-dance-sample': '动作作者 妮谷丹',
  'vidol-dance-shujiwu': '动作 兰若_Ruo · 镜头 -鬼瞳- · 表情 Viero月城',
};

function stageDance(dir, name) {
  // a staging folder: the package's top-level files (symlinked), plus a merged motion when the dance is split
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-store-dance-'));
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isFile()) fs.symlinkSync(path.join(dir, f.name), path.join(tmp, f.name));
  if (MERGE[name]) {
    const parts = fs.readdirSync(path.join(dir, MERGE[name])).filter((f) => /\.vmd$/i.test(f)).sort().map((f) => VMD.parseVmd(fs.readFileSync(path.join(dir, MERGE[name], f))));
    const merged = { ...parts[0], bones: parts.flatMap((p) => p.bones), morphs: parts.flatMap((p) => p.morphs), cameras: [], lights: [], shadows: [], ik: parts.flatMap((p) => p.ik || []) };
    // the chair and camera files at the top are not her dance
    for (const f of fs.readdirSync(tmp)) if (/\.vmd$/i.test(f)) fs.rmSync(path.join(tmp, f));
    fs.writeFileSync(path.join(tmp, `${slug(name)}.vmd`), VMD.writeVmd(merged));
  }
  return tmp;
}

function audioOut(src, dest) {
  // mp3 / ogg / m4a as they are; a wav (often 40 MB) as a 192 kbps mp3
  const ext = Dances.fileExt(src);
  if (ext === 'wav' || ext === 'flac') {
    const out = `${dest}.mp3`;
    ffmpeg(['-i', src, '-vn', '-codec:a', 'libmp3lame', '-b:a', '192k', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', out]);
    return out;
  }
  const out = `${dest}.${ext}`;
  fs.copyFileSync(src, out);
  return out;
}

function coverOut(src, dest) {
  ffmpeg(['-i', src, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2:flags=lanczos", '-q:v', '3', dest]);
  return dest;
}

function buildDance(dir, used) {
  const folder = path.basename(dir);
  const stage = stageDance(dir, folder);
  try {
    const d = DanceImport.inspect([stage]);
    if (!d.ok) throw new Error(`${folder}: ${d.reason} ${d.message || ''}`);
    const name = (d.source === 'vidol-pack' && d.name) || NAMES[folder] || folder;
    const id = uniqueId('dance', folder.replace(/^vidol-dance-/, ''), used, folder);
    const t0 = Date.now();
    const { vrma, report } = R.bakeVmd(fs.readFileSync(d.motion), { name: id, face: true });
    const jl = vrma.readUInt32LE(12);
    const check = V.inspectVrmaJson(JSON.parse(vrma.subarray(20, 20 + jl).toString('utf8')));
    if (!check.ok) throw new Error(`${folder}: inspectVrmaJson ${check.errors.join('; ')}`);
    const pack = fs.mkdtempSync(path.join(os.tmpdir(), `pixelpet-store-${id}-`));
    try {
      fs.writeFileSync(path.join(pack, 'dance.vrma'), vrma);
      const audio = d.audio ? path.basename(audioOut(d.audio, path.join(pack, 'audio'))) : null;
      const cover = d.cover ? path.basename(coverOut(d.cover, path.join(pack, 'cover.jpg'))) : null;
      const readme = d.readme ? fs.readFileSync(path.join(stage, d.readme.file)) : null;
      if (readme) fs.writeFileSync(path.join(pack, 'readme.txt'), readme);
      const credit = CREDITS[folder] || d.credit || null;
      const entry = {
        name, duration: report.duration, offset: 0, loop: false,
        ...(audio ? { audio } : {}), ...(cover ? { cover } : {}), ...(credit ? { credit } : {}), ...(readme ? { readme: 'readme.txt' } : {}),
        face: !!report.face, ik: report.ik, ...(report.stage ? { stage: { radius: report.stage.radius, clampHits: report.stage.clampHits } } : {}),
        extent: report.extent, ground: report.ground,
        src: { package: folder, motion: path.basename(d.motion), ...(d.audio ? { audio: path.basename(d.audio) } : {}) },
        bakedWith: R.BAKED_WITH,
      };
      fs.writeFileSync(path.join(pack, 'dance.json'), `${JSON.stringify(entry, null, 2)}\n`);
      const file = path.join(OUT, 'dances', `${id}.zip`);
      zip(pack, file);
      let picture = null;
      if (cover) {
        fs.mkdirSync(path.join(PICS, 'dances'), { recursive: true });
        ffmpeg(['-i', path.join(pack, cover), '-frames:v', '1', '-vf', 'scale=320:-2:flags=lanczos', '-q:v', '4', path.join(PICS, 'dances', `${id}.jpg`)]);
        picture = `catalog/dances/${id}.jpg`;
      }
      const excerpt = readme ? DanceImportReadme(readme).trim().slice(0, 600) : '';
      console.log(`${id.padEnd(30)} ${String(report.duration.toFixed(1)).padStart(6)} s ${mb(fs.statSync(file).size).padStart(9)}  ${audio ? '♪' : '-'} ${cover ? 'cover' : '-'}  ${name}  (${Date.now() - t0} ms)`);
      const parts = splitParts(file);
      return {
        ...(parts ? { parts } : {}), id, type: 'dance', name, credit: credit || '', description: excerpt, duration: +report.duration.toFixed(3), music: !!audio, face: !!report.face,
        adult: false, file: `${id}.zip`, bytes: fs.statSync(file).size, sha256: sha256(file), picture, source: folder,
      };
    } finally { fs.rmSync(pack, { recursive: true, force: true }); }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

// the readme as text (an old MMD readme is often Shift-JIS, a Chinese one GBK or UTF-16)
function DanceImportReadme(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^﻿/, '');
  let s = buf.toString('utf8');
  if (/�/.test(s)) for (const enc of ['shift_jis', 'gbk']) { try { const t = new TextDecoder(enc, { fatal: true }).decode(buf); s = t; break; } catch { /* next */ } }
  return s.replace(/^﻿/, '');
}

function buildDances() {
  const src = path.join(SRC, 'dances');
  const dirs = fs.readdirSync(src, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(src, d.name)).sort();
  const used = new Set();
  const dances = [];
  for (const dir of dirs) dances.push(buildDance(dir, used));
  fs.writeFileSync(DANCE_INDEX, `${JSON.stringify({ schema: 1, release: DANCE_RELEASE, dances }, null, 2)}\n`);
  console.log(`\n${dances.length} dances, ${mb(dances.reduce((n, d) => n + d.bytes, 0))} → ${path.join(OUT, 'dances')}; index ${path.relative(ROOT, DANCE_INDEX)}\n`);
}

// ---------- VRM ----------

const R18_DIRS = new Set(['R18-魅魔']);
const R18_FILES = new Set(['muma.vrm']);

// The model's own thumbnail (VRM 0.x meta.texture, VRM 1.0 meta.thumbnailImage) as image bytes, or null.
function vrmThumbnail(file) {
  const buf = fs.readFileSync(file);
  const jl = buf.readUInt32LE(12);
  const j = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
  const binStart = 20 + jl + 8;
  const ext = j.extensions || {};
  let image = null;
  if (ext.VRMC_vrm && Number.isInteger(ext.VRMC_vrm.meta && ext.VRMC_vrm.meta.thumbnailImage)) image = ext.VRMC_vrm.meta.thumbnailImage;
  else if (ext.VRM && ext.VRM.meta && Number.isInteger(ext.VRM.meta.texture) && j.textures && j.textures[ext.VRM.meta.texture]) image = j.textures[ext.VRM.meta.texture].source;
  const img = Number.isInteger(image) && j.images ? j.images[image] : null;
  if (!img || !Number.isInteger(img.bufferView)) return null;
  const bv = j.bufferViews[img.bufferView];
  return buf.subarray(binStart + (bv.byteOffset || 0), binStart + (bv.byteOffset || 0) + bv.byteLength);
}

function vrmFiles() {
  const root = path.join(SRC, 'models');
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.vrm$/i.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

// a picture for the card: the model's thumbnail, else the one picture next to it in its own folder
function vrmPicture(file, dest) {
  const tmp = path.join(os.tmpdir(), `pixelpet-thumb-${process.pid}`);
  const thumb = vrmThumbnail(file);
  let src = null;
  if (thumb && thumb.length > 100) { fs.writeFileSync(tmp, thumb); src = tmp; }
  else {
    const dir = path.dirname(file);
    if (path.basename(dir) !== '模型文件') {
      const pics = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
      if (pics.length === 1) src = path.join(dir, pics[0]);
    }
  }
  if (!src) return false;
  try {
    ffmpeg(['-i', src, '-frames:v', '1', '-vf', 'scale=256:-2:flags=lanczos,format=rgba', dest]);
    return true;
  } catch { return false; } finally { fs.rmSync(tmp, { force: true }); }
}

async function buildVrm(file, used, seen) {
  const digest = sha256(file);
  if (seen.has(digest)) { console.log(`(same file as ${seen.get(digest)}) ${path.relative(SRC, file)}`); return null; }
  const info = V.inspectVrmFile(file);
  if (!info.ok) { console.log(`skip ${path.relative(SRC, file)}: ${info.errors.join('; ')}`); return null; }
  const m = info.meta;
  const dirName = path.basename(path.dirname(file));
  const metaName = String(m.name || '').trim();
  const name = (metaName && metaName !== 'model' && metaName.length > 1 ? metaName : dirName !== '模型文件' ? dirName : path.basename(file, '.vrm')).slice(0, 40);
  const id = uniqueId('vrm', metaName.length > 1 ? metaName : dirName !== '模型文件' ? dirName : '', used, digest);
  seen.set(digest, id);
  const adult = R18_DIRS.has(dirName) || R18_FILES.has(path.basename(file));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-store-vrm-'));
  try {
    const r = await importVrm({ src: file, speciesId: VRM_BASE, userDir, appRoot: ROOT });
    if (!r.ok) throw new Error(`${file}: ${r.errors.join('; ')}`);
    const dir = r.pack.dir;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
    const authors = (m.authors || []).filter((a) => String(a).trim()).join('、');
    Object.assign(manifest, {
      id, name,
      author: authors || '未署名',
      license: m.licenseName || (m.licenseUrl ? 'VRM 1.0 授权' : '见模型授权'),
      description: `VRM 模型${authors ? `，作者 ${authors}` : ''}。授权信息读自模型文件，使用前请阅读模型的授权条款。`,
      // 18+ is the store's gate only (catalog `adult`): a pack may be 18+ only when the model's license allows it
      ...(adult && m.allowExcessivelySexualUsage === true ? { adult: true } : {}),
    });
    fs.writeFileSync(path.join(dir, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const pic = path.join(PICS, 'vrm', `${id}.png`);
    fs.mkdirSync(path.dirname(pic), { recursive: true });
    const hasPic = vrmPicture(file, pic);
    if (hasPic) fs.copyFileSync(pic, path.join(dir, P.PREVIEW_FILE));
    const check = P.readPack(dir);
    if (!check.ok) throw new Error(`${file}: ${check.errors.join('; ')}`);
    const out = path.join(OUT, 'vrm', `${id}.zip`);
    zip(dir, out);
    const lic = check.pack.vrm.license;
    const parts = splitParts(out);
    console.log(`${id.padEnd(34)} ${mb(fs.statSync(out).size).padStart(9)} ${hasPic ? 'pic' : '   '} ${adult ? '18+' : '   '} 再分发:${m.allowRedistribution ? '允许' : '不允许'}  ${name} — ${authors}`);
    return {
      ...(parts ? { parts } : {}), id, type: 'pack', base: VRM_BASE, name, kind: 'vrm', adult, version: manifest.version, author: manifest.author, license: manifest.license,
      description: manifest.description, outfits: 1, pixelated: false, file: `${id}.zip`, bytes: fs.statSync(out).size, sha256: sha256(out),
      picture: hasPic ? `catalog/vrm/${id}.png` : null,
      licenseRows: VrmUi.licenseRows(m).map((row) => ({ label: row.label, text: String(row.text).slice(0, 300), ...(row.href ? { href: row.href } : {}) })),
      redistributable: !!(lic && lic.redistributable),
      source: path.relative(path.join(SRC, 'models'), file),
    };
  } finally { fs.rmSync(userDir, { recursive: true, force: true }); }
}

async function buildVrms() {
  const used = new Set();
  const seen = new Map();
  const characters = [];
  fs.rmSync(path.join(PICS, 'vrm'), { recursive: true, force: true });
  for (const f of vrmFiles()) {
    const e = await buildVrm(f, used, seen);
    if (e) characters.push(e);
  }
  fs.writeFileSync(VRM_INDEX, `${JSON.stringify({ schema: 1, release: VRM_RELEASE, characters }, null, 2)}\n`);
  console.log(`\n${characters.length} VRM characters, ${mb(characters.reduce((n, c) => n + c.bytes, 0))} → ${path.join(OUT, 'vrm')}; index ${path.relative(ROOT, VRM_INDEX)}`);
}

async function main() {
  if (inside(OUT, path.resolve(ROOT))) throw new Error(`the archives may not be written inside the repository (${OUT})`);
  fs.mkdirSync(path.join(OUT, 'dances'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'vrm'), { recursive: true });
  if (ONLY !== 'vrm') { fs.rmSync(path.join(PICS, 'dances'), { recursive: true, force: true }); buildDances(); }
  if (ONLY !== 'dances') await buildVrms();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { vrmThumbnail, DANCE_RELEASE, VRM_RELEASE };
