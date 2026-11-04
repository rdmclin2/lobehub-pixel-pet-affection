#!/usr/bin/env node
'use strict';

// 商店 → 语音包 (docs/voice-packs.md §6): turn the recorded 风格语音包 in catalog/voicepacks/<id>/ (written by
// `node scripts/voicepack-generate.js --style`) into what the app and the download host need, the same way the
// character catalog does (scripts/build-character-catalog.js):
//   out/voice-catalog/<id>.zip                 one archive per pack: manifest.json + the audio at the top level
//   src/core/voice-catalog.json                the index the app ships: name, style, voice, lines, size, sha256 …
//   src/renderer/catalog/voices/<id>.ogg       the 试听 line, so the store can play it before anything is fetched
//
//   node scripts/build-voice-catalog.js [--out <dir>] [--check]
//
// --check rebuilds the zips and fails when one differs from the index (the archives are reproducible: sorted
// entries, fixed timestamps). Upload the zips with `node scripts/upload-character-catalog.js --voices` to the
// release named by the index (voices-v1, core/catalog.js voiceDownloadUrl).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const VP = require('../src/core/voice-pack');
const S = require('../src/core/voice-styles');
const Catalog = require('../src/core/catalog');
const { zip, sha256 } = require('./build-character-catalog');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'catalog', 'voicepacks');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'voice-catalog')));
const CHECK = process.argv.includes('--check');
const INDEX = path.join(ROOT, 'src', 'core', 'voice-catalog.json');
const SAMPLES = path.join(ROOT, 'src', 'renderer', 'catalog', 'voices');
const RELEASE = 'voices-v1';

// seconds of audio in a file (ffprobe), 0 when ffprobe is missing
function duration(file) {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}

function entry(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const errors = VP.validateManifest(m, dir);
  if (m.kind !== 'style') errors.push('not a style pack (kind "style")');
  if (Array.isArray(m.pending) && m.pending.length) errors.push(`${m.pending.length} lines not recorded yet (run voicepack-generate.js --style ${m.style})`);
  if (errors.length) throw new Error(`${dir}: ${errors.join('; ')}`);
  // only the manifest and the files it names go into the archive
  const files = new Set(['manifest.json', m.sample.file, ...Object.values(m.lines)]);
  for (const f of fs.readdirSync(dir)) if (!files.has(f)) throw new Error(`${dir}: stray file ${f} (not in the manifest)`);
  const file = path.join(OUT, `${m.id}.zip`);
  zip(dir, file);
  fs.mkdirSync(SAMPLES, { recursive: true });
  const sampleExt = path.extname(m.sample.file);
  const pic = path.join(SAMPLES, `${m.id}${sampleExt}`);
  if (!CHECK) fs.copyFileSync(path.join(dir, m.sample.file), pic);
  const seconds = Object.values(m.lines).reduce((n, f) => n + duration(path.join(dir, f)), 0);
  return {
    id: m.id,
    type: 'voice-pack',
    kind: 'style',
    style: m.style,
    styleLabel: S.labelOf(m.style),
    name: m.name,
    gender: m.gender,
    version: m.version,
    description: m.description || '',
    credit: m.credit || '',
    engine: m.engine,
    voiceId: m.voiceId,
    model: m.model,
    params: m.params,
    lineSet: m.lineSet,
    ...(m.appliesTo ? { appliesTo: m.appliesTo } : {}),
    lines: Object.keys(m.lines).length,
    seconds: Math.round(seconds),
    sample: { text: m.sample.text, file: `catalog/voices/${m.id}${sampleExt}`, seconds: Math.round(duration(path.join(dir, m.sample.file)) * 10) / 10 },
    file: `${m.id}.zip`,
    // where the app downloads it by default (core/catalog.js downloadUrl; PIXELPET_CATALOG_URL / settings.catalogUrl override)
    url: `${Catalog.CDN_ORIGIN}/${Catalog.UPLOAD_PREFIX_ROOT}/${RELEASE}/${m.id}.zip`,
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  };
}

function main() {
  if (OUT === ROOT || OUT.startsWith(path.join(ROOT, 'src'))) throw new Error('--out must not be the repository or src/');
  fs.mkdirSync(OUT, { recursive: true });
  const order = (id) => { const i = S.STYLES.findIndex((s) => s.id === id); return i < 0 ? 99 : i; };
  const dirs = fs.readdirSync(SRC, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const voicePacks = dirs.map((d) => entry(path.join(SRC, d)));
  const index = { schema: 1, release: RELEASE, voicePacks };
  if (CHECK) {
    const old = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    const bad = voicePacks.filter((v) => { const o = old.voicePacks.find((x) => x.id === v.id); return !o || o.sha256 !== v.sha256 || o.bytes !== v.bytes; });
    if (bad.length || old.voicePacks.length !== voicePacks.length) { console.error(`index out of date: ${bad.map((b) => b.id).join(', ') || 'pack count'} (run node scripts/build-voice-catalog.js)`); process.exit(1); }
    console.log(`voice catalog up to date: ${voicePacks.length} packs`);
    return;
  }
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');
  for (const v of voicePacks) console.log(`${v.id.padEnd(16)} ${v.styleLabel}  ${String(v.lines).padStart(3)} lines  ${String(v.seconds).padStart(4)} s  ${(v.bytes / 1024).toFixed(0).padStart(5)} KB  ${v.sha256}`);
  console.log(`wrote ${path.relative(ROOT, INDEX)} and ${voicePacks.length} archives in ${OUT}`);
}

if (require.main === module) main();
module.exports = { RELEASE, INDEX };
