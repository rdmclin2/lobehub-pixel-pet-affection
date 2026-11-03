#!/usr/bin/env node
'use strict';

// 可下载角色目录 (docs/characters.md 「内置与下载」). The app ships only the five pixel characters
// (src/renderer/packs/*-pixel); every other look lives in catalog/ and is downloaded on demand:
//   catalog/packs/<id>/   a pet pack (pack.json …), installed into <userData>/packs/<id>
//   catalog/clips/<id>/   a video character's clips (<base>-clips), installed into <userData>/clips/<id>
//
// This script turns catalog/ into what the app and the download host need:
//   out/character-catalog/<id>.zip           one archive per character (upload these as release assets)
//   src/core/character-catalog.json          the index the app ships: name, kind, size, sha256 per character
//   src/renderer/catalog/<id>.png            a small picture for the 「未下载」 card
//
//   node scripts/build-character-catalog.js [--out <dir>]
//
// Run it after changing anything under catalog/, commit the index and pictures, and upload the zips to the
// release named by the index's `release` (core/catalog.js DEFAULT_BASE_URL).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const P = require('../src/core/packs');
const { SPECIES } = require('../src/core/species');

const ROOT = path.join(__dirname, '..');
const CATALOG = path.join(ROOT, 'catalog');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'out', 'character-catalog');
const INDEX = path.join(ROOT, 'src', 'core', 'character-catalog.json');
const PICS = path.join(ROOT, 'src', 'renderer', 'catalog');
const RELEASE = 'characters-v1';
const PIC_HEIGHT = 240;

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// a zip with the folder's files at its top level, the same layout 导入角色包… reads. Reproducible: sorted
// entries, a fixed timestamp and mode, so the same files always give the same sha256 (the index can be checked
// against a rebuild, --zips-only).
const ZIP_PY = `
import os, sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
files = []
for root, dirs, names in os.walk(src):
    dirs.sort()
    for n in names:
        files.append(os.path.relpath(os.path.join(root, n), src))
files.sort()
with zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in files:
        info = zipfile.ZipInfo(f.replace(os.sep, '/'), date_time=(1980, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(os.path.join(src, f), 'rb') as fh:
            z.writestr(info, fh.read())
`;
function zip(dir, file) {
  fs.rmSync(file, { force: true });
  execFileSync('python3', ['-I', '-c', ZIP_PY, dir, file]);
}

const ffmpeg = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);

// the card picture: a sprite sheet's first frame, a picture / Live2D preview, or a clip's first frame
function picture(src, dest, frame) {
  const scale = `scale=-2:${PIC_HEIGHT}:flags=${frame && frame.pixelated ? 'neighbor' : 'lanczos'}`;
  const vf = frame ? `crop=${frame.width}:${frame.height}:0:0,${scale}` : scale;
  // a VP9 clip keeps its alpha only through libvpx-vp9 (the default decoder drops it: a black box)
  const dec = /\.webm$/i.test(src) ? ['-c:v', 'libvpx-vp9'] : [];
  ffmpeg([...dec, '-i', src, '-frames:v', '1', '-vf', `${vf},format=rgba`, dest]);
}

function packEntry(dir) {
  const r = P.readPack(dir);
  if (!r.ok) throw new Error(`${dir}: ${r.errors.join('; ')}`);
  const p = r.pack;
  const daily = p.outfits.daily || Object.values(p.outfits)[0];
  const file = path.join(OUT, `${p.id}.zip`);
  zip(dir, file);
  const pic = path.join(PICS, `${p.id}.png`);
  const src = p.kind === 'live2d' && fs.existsSync(path.join(dir, P.PREVIEW_FILE)) ? path.join(dir, P.PREVIEW_FILE) : path.join(dir, daily);
  picture(src, pic, p.kind === 'sprites' ? { ...p.frame, pixelated: p.pixelated } : null);
  return { id: p.id, type: 'pack', base: p.species, name: p.name, kind: p.kind, adult: !!p.adult, version: p.version, author: p.author, license: p.license, description: p.description, outfits: Object.keys(p.outfits).length, pixelated: !!p.pixelated, file: `${p.id}.zip`, bytes: fs.statSync(file).size, sha256: sha256(file), picture: `catalog/${p.id}.png` };
}

function clipsEntry(dir) {
  const id = path.basename(dir);
  const base = id.replace(/-clips$/, '');
  const sp = SPECIES[base];
  if (!sp || !sp.clipsLook) throw new Error(`${dir}: ${base} is not a video character`);
  const missing = Object.values(sp.clips).flat().filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) throw new Error(`${dir}: missing ${missing.join(', ')}`);
  const file = path.join(OUT, `${id}.zip`);
  zip(dir, file);
  const idle = [].concat(sp.clips.idle)[0];
  picture(path.join(dir, idle), path.join(PICS, `${id}.png`), null);
  const c = sp.clipsLook;
  return { id, type: 'clips', base, name: c.name, kind: 'video', adult: false, version: '1.0.0', author: c.author, license: c.license, description: c.description, outfits: 1, pixelated: false, file: `${id}.zip`, bytes: fs.statSync(file).size, sha256: sha256(file), picture: `catalog/${id}.png` };
}

// --zips-only: write the archives and check each against the committed index (tests serve them from a local
// server, e2e/run.js catalogdl); the index and pictures stay as they are
function zipsOnly() {
  fs.mkdirSync(OUT, { recursive: true });
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  for (const c of index.characters) {
    const file = path.join(OUT, c.file);
    zip(path.join(CATALOG, c.type === 'clips' ? 'clips' : 'packs', c.id), file);
    const got = sha256(file);
    if (got !== c.sha256 || fs.statSync(file).size !== c.bytes) throw new Error(`${c.id}: the archive does not match the index (run node scripts/build-character-catalog.js)`);
  }
  console.log(`${index.characters.length} archives match the index → ${OUT}`);
}

function main() {
  if (process.argv.includes('--zips-only')) return zipsOnly();
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(PICS, { recursive: true, force: true });
  fs.mkdirSync(PICS, { recursive: true });
  const dirs = (sub) => (fs.existsSync(path.join(CATALOG, sub)) ? fs.readdirSync(path.join(CATALOG, sub), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(CATALOG, sub, d.name)).sort() : []);
  const characters = [...dirs('packs').map(packEntry), ...dirs('clips').map(clipsEntry)];
  const index = { schema: 1, release: RELEASE, characters };
  fs.writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`);
  const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  for (const c of characters) console.log(`${c.id.padEnd(18)} ${c.kind.padEnd(8)} ${mb(c.bytes).padStart(8)}  ${c.sha256.slice(0, 12)}`);
  console.log(`\n${characters.length} characters, ${mb(characters.reduce((n, c) => n + c.bytes, 0))} → ${path.relative(ROOT, OUT)}; index ${path.relative(ROOT, INDEX)}`);
}

if (require.main === module) main();
module.exports = { zip, sha256 };
