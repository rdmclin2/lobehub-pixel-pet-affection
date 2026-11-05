#!/usr/bin/env node
// 上架官方表情包 (docs/stickers-design.md §5.2 方案 B, §5.3): pack sticker sets into the zip format the app reads
// (src/core/sticker-set.js), put them on LobeHub's public CDN through the Develop Center CLI (`dc ops-assets
// upload`, the same path as `npm run catalog:upload`), and publish sticker-catalog.json next to them — the index
// 商店 → 表情包 reads (src/core/sticker-catalog.js). The same index is written to src/core/sticker-catalog.json,
// the copy shipped with the app for when the CDN cannot be reached: commit it.
//
//   node scripts/publish-sticker-set.mjs --builtin dafeiyu --builtin claude      # characters' built-in memes
//   node scripts/publish-sticker-set.mjs --folder path/to/set                    # sticker-set.json + stickers/
//   node scripts/publish-sticker-set.mjs --mine claude --data-dir <userData> --id claude-mine \
//        --name 克洛蒂的日常 --author 你的名字 --license "CC BY 4.0"                 # a character's 「我的」 set
//   … --dry-run      build, validate and print what would go where; upload nothing, write nothing to src/
//   … --version 1.1.0   publish a new version (a changed set needs one: a published zip is never replaced)
//
// Uploads go to dc/ops-assets/archives/pixel-pet/stickers-v1/:
//   <id>-<version>.zip            the set (≤ 20 MB per file: the Ops Assets limit)
//   previews/<sha256>.<ext>       each sticker on its own, what the store shows before 获取
//   sticker-catalog.json          the index (replaced on every publish)
// Every file is downloaded back from the address the app uses and checked against its size and sha256.
//
// Needs `dc` on PATH, or DC_CLI=<develop-center>/packages/cli/dist/index.js, logged in to the Develop Center
// (`dc auth login --token <DC_CLI_TOKEN> --base-url <DC address>`, or DC_TOKEN / DC_BASE_URL).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SS = require('../src/core/sticker-set');
const SC = require('../src/core/sticker-catalog');
const Catalog = require('../src/core/catalog');
const { getSpecies } = require('../src/core/species');

// ---- arguments -------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []));
const one = (name) => all(name)[0];
const DRY = flag('dry-run');
const PREFIX = `${Catalog.UPLOAD_PREFIX_ROOT}/${SC.RELEASE}`;
const BASE = `${Catalog.CDN_ORIGIN}/${PREFIX}`;
const OUT = one('out') || path.join(ROOT, 'out', 'sticker-catalog');

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

// ---- the sets to publish ---------------------------------------------------------------------------------
// her built-in memes (src/characters/<id>.json memes + src/renderer/assets/memes/<id>/<meme>.webp)
function builtinSet(speciesId) {
  const sp = getSpecies(speciesId);
  if (!sp || sp.id !== speciesId || !sp.memes || !sp.memes.length) die(`--builtin ${speciesId}: no such character with memes`);
  const credit = (sp.credits || []).find((c) => /梗图/.test(c)) || '';
  const fromDsh = /dsh-pet/.test(credit);
  return {
    meta: {
      id: `${speciesId}-memes`,
      name: `${sp.nameZh}的梗图`,
      description: `${sp.nameZh}的官方梗图合集（${sp.memes.length} 张）：${sp.memes.map((m) => m.label).join('、')}。`,
      author: fromDsh ? 'Pixel Pet 官方（梗图出自 PC2005-cloud/dsh-pet）' : 'Pixel Pet 官方（rdmclin2，gpt-image-2.5 生成）',
      license: fromDsh ? 'dsh-pet 素材：可开源使用，禁止商用' : 'CC BY-NC-SA 4.0',
      version: one('version') || '1.0.0',
      forSpecies: [speciesId],
      cover: sp.memes[0].id,
    },
    pictures: sp.memes.map((m) => ({ id: m.id, label: m.label, desc: m.desc, buffer: fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'assets', 'memes', speciesId, `${m.id}.webp`)) })),
  };
}

// a folder holding sticker-set.json and stickers/
function folderSet(dir) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, SS.MANIFEST), 'utf8'));
  const m = SS.checkManifest(raw);
  if (!m.ok) die(`${dir}: ${m.errors.join('; ')}`);
  const { stickers, ...meta } = m.manifest;
  if (one('version')) meta.version = one('version');
  return { meta, pictures: stickers.map((s) => ({ id: s.id, label: s.label, desc: s.desc, buffer: fs.readFileSync(path.resolve(dir, s.file)) })) };
}

// a character's 「我的」 set from an app's data folder (<userData>/stickers/sets/mine-<id>.json + blobs/)
function mineSet(speciesId) {
  const dataDir = one('data-dir') || die('--mine needs --data-dir <the app\'s userData folder>');
  const set = JSON.parse(fs.readFileSync(path.join(dataDir, 'stickers', 'sets', `mine-${speciesId}.json`), 'utf8'));
  for (const k of ['id', 'name', 'author', 'license']) if (!one(k)) die(`--mine needs --${k}`);
  return {
    meta: { id: one('id'), name: one('name'), description: one('description') || '', author: one('author'), license: one('license'), version: one('version') || '1.0.0', forSpecies: [speciesId], cover: set.stickers[0] && set.stickers[0].id },
    pictures: set.stickers.map((s) => ({ id: s.id, label: s.label, desc: s.desc || '', buffer: fs.readFileSync(path.join(dataDir, 'stickers', 'blobs', s.blob)) })),
  };
}

const sources = [...all('builtin').map(builtinSet), ...all('folder').map(folderSet), ...all('mine').map(mineSet)];
if (!sources.length) die('nothing to publish: pass --builtin <id>, --folder <dir> or --mine <id> (see the top of this file)');

// ---- build -----------------------------------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'previews'), { recursive: true });
const built = sources.map(({ meta, pictures }) => {
  const r = SS.packSet(meta, pictures);
  if (!r.ok) die(`${meta.id}: ${r.errors.join('; ')}`);
  const file = `${meta.id}-${meta.version.replace(/\./g, '-')}.zip`;
  fs.writeFileSync(path.join(OUT, file), r.zip);
  const previews = r.stickers.map((s) => {
    const name = `previews/${s.sha256}.${s.ext}`;
    fs.writeFileSync(path.join(OUT, name), s.buffer);
    return { id: s.id, label: s.label, desc: s.desc, file: name, bytes: s.buffer.length, sha256: s.sha256 };
  });
  const entry = {
    id: meta.id, type: 'sticker-set', name: r.manifest.name, description: r.manifest.description, author: r.manifest.author, official: true,
    license: r.manifest.license, version: r.manifest.version, forSpecies: r.manifest.forSpecies || [], count: r.stickers.length,
    cover: r.manifest.cover, previews, file, bytes: r.zip.length, sha256: SS.sha256(r.zip),
  };
  if (!SC.cleanEntry(entry, SC.RELEASE)) die(`${meta.id}: the catalog entry does not pass core/sticker-catalog.js`);
  return entry;
});

// ---- the index: what is on the CDN now (else the shipped copy), with these sets put in -------------------
async function currentIndex() {
  try {
    const res = await fetch(`${BASE}/${SC.INDEX_NAME}`, { cache: 'no-store' });
    if (res.ok) {
      const remote = SC.parseRemote(await res.text());
      if (remote) return { index: remote, from: 'cdn' };
    }
  } catch { /* first publish, or offline */ }
  return { index: SC.loadBundled(), from: 'bundled' };
}

const { index: before, from } = await currentIndex();
const strip = ({ release: _r, ...e }) => e;
const sets = before.sets.map(strip);
for (const e of built) {
  const i = sets.findIndex((s) => s.id === e.id);
  if (i >= 0 && sets[i].version === e.version && sets[i].sha256 !== e.sha256) die(`${e.id} v${e.version} is published already with other contents: pass --version <newer>`);
  if (i >= 0) sets[i] = e;
  else sets.push(e);
}
const index = { schema: 1, release: SC.RELEASE, updatedAt: new Date().toISOString(), sets };
const indexText = `${JSON.stringify(index, null, 2)}\n`;
if (SC.parseRemote(indexText).sets.length !== sets.length) die('the new index does not pass core/sticker-catalog.js');
fs.writeFileSync(path.join(OUT, SC.INDEX_NAME), indexText);

console.log(`index: ${sets.length} set(s) (started from the ${from} index) → ${BASE}/${SC.INDEX_NAME}`);
for (const e of built) console.log(`  ${e.id.padEnd(18)} v${e.version}  ${String(e.count).padStart(3)} stickers  ${String(e.bytes).padStart(8)} B  sha256 ${e.sha256}\n    ${BASE}/${e.file}`);
if (DRY) {
  console.log(`\n--dry-run: built in ${OUT}; nothing uploaded, src/core/sticker-catalog.json unchanged.`);
  process.exit(0);
}

// ---- upload ----------------------------------------------------------------------------------------------
function dc(args) {
  const cli = process.env.DC_CLI;
  const [cmd, pre] = cli ? [process.execPath, [cli]] : ['dc', []];
  return JSON.parse(execFileSync(cmd, [...pre, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 }));
}
const sha256 = (buf) => SS.sha256(buf);
const zips = built.map((e) => path.join(OUT, e.file));
const previewFiles = [...new Set(built.flatMap((e) => e.previews.map((p) => path.join(OUT, p.file))))];
console.log(`\nuploading ${zips.length} zip(s) and ${previewFiles.length} preview(s) to ${PREFIX}/ …`);
const up = [...dc(['ops-assets', 'upload', ...zips, '--prefix', PREFIX, '--skip-existing']), ...dc(['ops-assets', 'upload', ...previewFiles, '--prefix', `${PREFIX}/previews`, '--skip-existing'])];
for (const r of up) console.log(`  ${r.skipped ? 'already there' : 'uploaded     '}  ${r.publicUrl}`);

// verify every file from the address the app uses before the index points at it
const problems = [];
async function check(url, bytes, sum) {
  const res = await fetch(url, { cache: 'no-store' });
  const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
  if (!buf || buf.length !== bytes || sha256(buf) !== sum) problems.push(`${url}: ${res.ok ? `${buf.length} B, sha256 ${sha256(buf).slice(0, 12)}` : `HTTP ${res.status}`} (want ${bytes} B, ${sum.slice(0, 12)})`);
}
for (const e of built) {
  await check(`${BASE}/${e.file}`, e.bytes, e.sha256);
  for (const p of e.previews) await check(`${BASE}/${p.file}`, p.bytes, p.sha256);
}
if (problems.length) die(`\n${problems.length} file(s) on the CDN do not match; the index was NOT published:\n  ${problems.join('\n  ')}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-stickers-'));
const indexFile = path.join(tmp, SC.INDEX_NAME);
fs.writeFileSync(indexFile, indexText);
const [ir] = dc(['ops-assets', 'upload', indexFile, '--key', `${PREFIX}/${SC.INDEX_NAME}`, '--overwrite']);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`  index        ${ir.publicUrl}`);
const res = await fetch(`${BASE}/${SC.INDEX_NAME}`, { cache: 'no-store' });
const back = res.ok ? await res.text() : '';
if (back !== indexText) die(`the index on the CDN is not the one just uploaded (HTTP ${res.status})`);
fs.writeFileSync(SC.BUNDLED_FILE, indexText);
console.log(`\nPublished: ${built.map((e) => e.id).join(', ')}. The CDN index matches; src/core/sticker-catalog.json updated (commit it).`);
