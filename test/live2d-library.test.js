'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const L = require('../scripts/live2d-library-check');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'live2d-library-check.js');

// a PNG whose IHDR says w×h (the checker only reads the header)
const png = (w, h) => { const b = Buffer.alloc(33); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const moc3 = (v) => Buffer.concat([Buffer.from('MOC3'), Buffer.from([v]), Buffer.alloc(59)]);

function fixture() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-lib-'));
  const a = path.join(lib, 'models', 'gh-good-cat');
  fs.mkdirSync(path.join(a, 'tex'), { recursive: true });
  fs.writeFileSync(path.join(a, 'cat.moc3'), moc3(3));
  fs.writeFileSync(path.join(a, 'tex', 't0.png'), png(2048, 2048));
  fs.writeFileSync(path.join(a, 'cat.physics3.json'), '{}');
  fs.writeFileSync(path.join(a, 'smile.exp3.json'), '{}');
  fs.writeFileSync(path.join(a, 'idle.motion3.json'), '{}');
  fs.writeFileSync(path.join(a, 'cat.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: 'cat.moc3', Textures: ['tex/t0.png'], Physics: 'cat.physics3.json', Expressions: [{ Name: 'smile', File: 'smile.exp3.json' }], Motions: { Idle: [{ File: 'idle.motion3.json' }, { File: 'idle2.motion3.json' }] } } }));
  const b = path.join(lib, 'models', 'bili-old-dog');
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'dog.moc'), 'moc');
  fs.writeFileSync(path.join(b, 't.png'), png(1024, 1024));
  fs.writeFileSync(path.join(b, 'dog.model.json'), JSON.stringify({ model: 'dog.moc', textures: ['t.png'], motions: { idle: [{ file: 'a.mtn' }] } }));
  fs.writeFileSync(path.join(b, 'a.mtn'), '');
  fs.mkdirSync(path.join(lib, '_downloads'));
  fs.writeFileSync(path.join(lib, '_downloads', 'gh-good-cat.zip'), 'zip-bytes');
  fs.writeFileSync(path.join(lib, 'manifest.json'), JSON.stringify({ schema: 1, entries: [
    { id: 'booth-paid-one', name: 'Paid', channel: 'booth', sourceUrl: 'https://booth.pm/x', author: 'a', downloadStatus: 'paid', failReason: '付费 ¥3000', license: 'Booth 作者条款', licenseNote: '', licenseFlags: { commercial: false, redistribute: false, modify: 'unknown', attribution: true, needsAuthorization: true }, cubismVersion: 'unknown', appSupported: false, files: [], hasPhysics: false, expressionCount: 0, motionCount: 0, textureMaxSize: 0, sizeBytes: 0, sha256: null, qualityTier: null, previewPath: null, notes: '' },
  ] }));
  return lib;
}

test('empty library: the script runs, reports zero and exits 0', () => {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-empty-'));
  const out = execFileSync(process.execPath, [SCRIPT, '--root', lib, '--json'], { encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.equal(r.summary.total, 0);
  assert.deepEqual(r.summary.tiers, { A: 0, B: 0, C: 0 });
  assert.deepEqual(r.problems, []);
});

test('every entry of the committed manifest is well-formed', () => {
  // only the schema: local model dirs (git-ignored) are not looked at, so a half-downloaded library does not fail npm test
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'live2d-library', 'manifest.json'), 'utf8'));
  assert.equal(m.schema, 1);
  assert.deepEqual(m.entries.flatMap(L.validateEntry), []);
});

test('backfills measured fields, tiers models and creates missing entries', () => {
  const lib = fixture();
  const { manifest, problems } = L.checkLibrary(lib, { write: true });
  const cat = manifest.entries.find((e) => e.id === 'gh-good-cat');
  assert.equal(cat.channel, 'github'); // inferred from the prefix
  assert.equal(cat.cubismVersion, 4); // moc3 version byte 3 = Cubism 4.0
  assert.equal(cat.appSupported, true);
  assert.deepEqual(cat.files, ['cat.model3.json']);
  assert.equal(cat.hasPhysics, true);
  assert.equal(cat.expressionCount, 1);
  assert.equal(cat.motionCount, 2);
  assert.equal(cat.textureMaxSize, 2048);
  assert.deepEqual(cat.missingFiles, ['idle2.motion3.json']);
  assert.equal(cat.qualityTier, 'C'); // broken references drop it to C
  assert.match(cat.sha256, /^[0-9a-f]{64}$/);
  assert.ok(problems.some((p) => p.includes('gh-good-cat: missing referenced file idle2.motion3.json')));
  const dog = manifest.entries.find((e) => e.id === 'bili-old-dog');
  assert.equal(dog.cubismVersion, 2);
  assert.equal(dog.appSupported, false);
  assert.equal(dog.qualityTier, 'C');
  const s = L.summarize(manifest.entries);
  assert.equal(s.total, 3);
  assert.equal(s.downloaded, 2);
  assert.equal(s.cubism3plus, 1);
  assert.equal(s.byStatus.paid, 1);
  // written back
  assert.equal(JSON.parse(fs.readFileSync(path.join(lib, 'manifest.json'), 'utf8')).entries.length, 3);
});

test('a complete Cubism 4 model with physics, 2K textures and expressions is tier A', () => {
  const lib = fixture();
  fs.writeFileSync(path.join(lib, 'models', 'gh-good-cat', 'idle2.motion3.json'), '{}');
  const { manifest, problems } = L.checkLibrary(lib, { write: false });
  assert.equal(manifest.entries.find((e) => e.id === 'gh-good-cat').qualityTier, 'A');
  assert.deepEqual(problems, []);
});

test('manifest validation rejects bad ids, enums and flags', () => {
  const p = L.validateEntry({ id: 'NoPrefix', name: 'x', channel: 'weibo', sourceUrl: 'ftp://x', downloadStatus: 'failed', license: '', licenseFlags: { commercial: 'maybe' }, cubismVersion: 6 });
  for (const want of ['id must be', 'channel', 'failReason', 'sourceUrl', 'license is empty', 'licenseFlags.commercial', 'cubismVersion']) assert.ok(p.some((x) => x.includes(want)), want);
});

test('the reference sample 大肥鱼 measures as tier A (read-only)', () => {
  const dir = path.join(ROOT, 'catalog', 'packs', 'dafeiyu-live2d');
  if (!fs.existsSync(dir)) return;
  const { agg } = L.analyzeDir(dir);
  assert.equal(agg.appSupported, true);
  assert.ok(agg.cubismVersion >= 4);
  assert.equal(agg.hasPhysics, true);
  assert.ok(agg.textureMaxSize >= 2048);
  assert.equal(agg.qualityTier, 'A');
});

test('the library is outside every store / catalog path and its models are git-ignored', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const p of ['live2d-library/models/', 'live2d-library/_downloads/']) assert.ok(ignore.split('\n').includes(p), p);
  const files = require('../package.json').build.files;
  assert.ok(!files.some((f) => f.includes('live2d-library')), 'electron-builder must not package the library');
  for (const s of ['build-character-catalog.js', 'build-store-assets.js', 'upload-character-catalog.js', 'upload-store-assets.js']) {
    assert.ok(!fs.readFileSync(path.join(ROOT, 'scripts', s), 'utf8').includes('live2d-library'), `${s} must not read the library`);
  }
});
