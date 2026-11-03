#!/usr/bin/env node
'use strict';

// 上传可下载角色 (docs/characters.md 「内置与下载」): put the catalog's archives on LobeHub's public CDN through
// the Develop Center CLI (`dc ops-assets upload`, lobehub-biz/develop-center packages/cli), then download each
// one back from the address the app will use and check it against the committed index.
//
//   npm run catalog:upload               # build the zips (checked against the index), upload, verify
//   npm run catalog:upload -- --dry-run  # build and check only; print what would be uploaded where
//
// Needs `dc` on PATH (or DC_CLI=/path/to/dc/dist/index.js) logged in to the Develop Center:
//   dc auth login --token <DC_CLI_TOKEN> --base-url <DC address>   (or DC_TOKEN / DC_BASE_URL)
// Files already there with the same size are left alone (--skip-existing); a different size is an error, so a
// published archive is never replaced silently: change `release` in the index (scripts/build-character-catalog.js
// RELEASE) for new contents.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Catalog = require('../src/core/catalog');

const ROOT = path.join(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function dc(args) {
  const cli = process.env.DC_CLI;
  const [cmd, pre] = cli ? [process.execPath, [cli]] : ['dc', []];
  return execFileSync(cmd, [...pre, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
}

async function main() {
  const index = Catalog.loadIndex();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-catalog-'));
  // the archives, rebuilt from catalog/ and checked byte for byte against the index the app ships
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-character-catalog.js'), '--zips-only', '--out', out], { stdio: 'inherit' });
  const files = index.characters.map((c) => path.join(out, c.file));
  // where the app downloads from (PIXELPET_CATALOG_URL overrides it, as in the app: a mirror, a test server)
  const base = Catalog.baseUrl({});
  console.log(`\n${files.length} archives → ${Catalog.UPLOAD_PREFIX}/ (served from ${base})`);
  if (DRY) {
    for (const c of index.characters) console.log(`  ${c.file.padEnd(22)} ${String(c.bytes).padStart(9)}  ${base}/${c.file}`);
    return;
  }

  const results = JSON.parse(dc(['ops-assets', 'upload', ...files, '--prefix', Catalog.UPLOAD_PREFIX, '--skip-existing']));
  const problems = [];
  for (const c of index.characters) {
    const r = results.find((x) => path.basename(x.file) === c.file);
    const want = `${base}/${c.file}`;
    if (!r) { problems.push(`${c.file}: not uploaded`); continue; }
    if (r.publicUrl !== want) problems.push(`${c.file}: the CDN address is ${r.publicUrl}, the app downloads ${want} (core/catalog.js CDN_ORIGIN)`);
    // what a user's download gets
    const res = await fetch(want);
    const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    const ok = buf && buf.length === c.bytes && sha256(buf) === c.sha256;
    if (!ok) problems.push(`${c.file}: ${res.ok ? `downloaded ${buf.length} bytes, sha256 ${sha256(buf).slice(0, 12)}` : `HTTP ${res.status}`} (index: ${c.bytes} bytes, ${c.sha256.slice(0, 12)})`);
    console.log(`  ${ok ? '✓' : '✗'} ${c.file.padEnd(22)} ${r.skipped ? 'already there' : 'uploaded     '}  ${want}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`\nAll ${index.characters.length} archives are on the CDN and match the index.`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
