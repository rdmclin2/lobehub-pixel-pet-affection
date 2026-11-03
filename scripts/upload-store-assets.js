#!/usr/bin/env node
'use strict';

// 商店 → 舞蹈 / VRM 角色 (scripts/build-store-assets.js): put the archives on LobeHub's public CDN through the
// Develop Center CLI, like `npm run catalog:upload` does for the characters, then download every entry back from
// the address the app uses (its parts in order) and check it against the committed index.
//
//   node scripts/upload-store-assets.js [--out ~/vrm-assets/store] [--only dances|vrm] [--dry-run]
//
// Needs `dc` on PATH (or DC_CLI=/path/to/dc/dist/index.js) with DC_TOKEN / DC_BASE_URL (or `dc auth login`).
// Files already there with the same size are left alone (--skip-existing); a different size is an error: change
// the release in build-store-assets.js for new contents.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Catalog = require('../src/core/catalog');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const OUT = path.resolve(arg('--out', path.join(os.homedir(), 'vrm-assets', 'store')));
const ONLY = arg('--only', null);
const DRY = process.argv.includes('--dry-run');
const BATCH = 10;

function dc(args) {
  const cli = process.env.DC_CLI;
  const [cmd, pre] = cli ? [process.execPath, [cli]] : ['dc', []];
  return execFileSync(cmd, [...pre, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
}

const filesOf = (e) => (e.parts && e.parts.length ? e.parts.map((p) => p.file) : [e.file]);

async function check(e) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for (const f of filesOf(e)) {
    const url = Catalog.downloadUrl({ ...e, file: f }, {}, {});
    const res = await fetch(url);
    if (!res.ok) return `${f}: HTTP ${res.status} (${url})`;
    const buf = Buffer.from(await res.arrayBuffer());
    bytes += buf.length;
    hash.update(buf);
  }
  const sha = hash.digest('hex');
  return bytes === e.bytes && sha === e.sha256 ? null : `${e.id}: downloaded ${bytes} bytes, sha256 ${sha.slice(0, 12)} (index: ${e.bytes} bytes, ${e.sha256.slice(0, 12)})`;
}

async function upload(kind, entries, release) {
  const dir = path.join(OUT, kind);
  const prefix = `${Catalog.UPLOAD_PREFIX_ROOT}/${release}`;
  const files = entries.flatMap(filesOf).map((f) => path.join(dir, f));
  const missing = files.filter((f) => !fs.existsSync(f));
  if (missing.length) throw new Error(`not built: ${missing.map((f) => path.basename(f)).join(', ')} (node scripts/build-store-assets.js)`);
  console.log(`\n${kind}: ${entries.length} entries, ${files.length} files → ${prefix}/`);
  if (DRY) { for (const f of files) console.log(`  ${path.basename(f)}  ${fs.statSync(f).size}`); return []; }
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const r = JSON.parse(dc(['ops-assets', 'upload', ...chunk, '--prefix', prefix, '--skip-existing']));
    for (const x of r) console.log(`  ${x.skipped ? '=' : '↑'} ${path.basename(x.file)}  ${x.publicUrl || ''}`);
  }
  const problems = [];
  for (const e of entries) {
    const p = await check(e);
    console.log(`  ${p ? '✗' : '✓'} ${e.id}${p ? `  ${p}` : ''}`);
    if (p) problems.push(p);
  }
  return problems;
}

async function main() {
  const problems = [];
  if (ONLY !== 'vrm') { const d = Catalog.loadDanceIndex(); problems.push(...await upload('dances', d.dances, d.release)); }
  if (ONLY !== 'dances') { const v = Catalog.loadIndex(Catalog.VRM_INDEX_FILE); problems.push(...await upload('vrm', v.characters, v.release)); }
  if (problems.length) { console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`); process.exit(1); }
  if (!DRY) console.log('\nEverything is on the CDN and matches the index.');
}

main().catch((e) => { console.error(e); process.exit(1); });
