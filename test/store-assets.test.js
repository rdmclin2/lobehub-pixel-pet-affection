'use strict';

// 商店 → 舞蹈 / VRM 角色 (docs/vrm-dance.md §11): the indexes the app ships, where each archive is downloaded
// from, and a downloaded dance going into the dance library.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const Catalog = require('../src/core/catalog');
const Dances = require('../src/core/vrm-dances');
const DanceImport = require('../src/main/dance-import');
const { zip } = require('../scripts/build-character-catalog');

const ROOT = path.join(__dirname, '..');
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('store index: the characters and the VRM models together, each from its own release', () => {
  const chars = Catalog.loadIndex();
  const all = Catalog.storeIndex();
  const vrm = all.characters.filter((c) => c.kind === 'vrm');
  assert.ok(vrm.length > 0, 'the VRM index is in the store');
  assert.equal(all.characters.length, chars.characters.length + vrm.length);
  assert.ok(chars.characters.every((c) => c.release === chars.release), 'a character archive stays in characters-v1');
  for (const c of vrm) {
    assert.equal(c.release, 'vrm-v1');
    assert.equal(c.type, 'pack');
    assert.ok(Array.isArray(c.licenseRows) && c.licenseRows.some((r) => r.label === '再分发'), `${c.id}: the license rows are listed`);
    if (c.parts) assert.equal(c.parts.reduce((n, p) => n + p.bytes, 0), c.bytes, `${c.id}: the parts add up`);
    if (c.picture) assert.ok(fs.existsSync(path.join(ROOT, 'src', 'renderer', c.picture)), `${c.id}: ${c.picture} ships`);
  }
  // the CDN keeps each release under its own prefix; a mirror / test server has every file in one folder
  const v = vrm[0];
  assert.equal(Catalog.downloadUrl(v, {}, {}), `${Catalog.CDN_ORIGIN}/dc/ops-assets/archives/pixel-pet/vrm-v1/${v.file}`);
  assert.equal(Catalog.downloadUrl(Catalog.entry('dafeiyu-live2d'), {}, {}), `${Catalog.DEFAULT_BASE_URL}/dafeiyu-live2d.zip`);
  assert.equal(Catalog.downloadUrl(v, {}, { PIXELPET_CATALOG_URL: 'http://127.0.0.1:9/x/' }), `http://127.0.0.1:9/x/${v.file}`);
  // 18+ models only behind the switches
  const adult = vrm.filter((c) => c.adult).map((c) => c.id);
  assert.ok(adult.length > 0);
  const listed = Catalog.listAll(() => false).map((c) => c.id);
  assert.ok(adult.every((id) => !listed.includes(id)), 'no 18+ model without the switches');
  assert.ok(adult.every((id) => Catalog.listAll(() => false, { adultOk: true }).some((c) => c.id === id)));
  const row = Catalog.listAll(() => false).find((c) => c.kind === 'vrm');
  assert.ok(Array.isArray(row.licenseRows) && typeof row.redistributable === 'boolean', 'the store card gets the license');
});

test('store index: a malformed entry or parts that do not add up are left out', () => {
  const dir = tmpDir('pp-storeidx-');
  const e = { id: 'vrm-test', type: 'pack', kind: 'vrm', file: 'vrm-test.zip', bytes: 30, sha256: 'a'.repeat(64) };
  write(path.join(dir, 'c.json'), { release: 'characters-v1', characters: [] });
  write(path.join(dir, 'v.json'), { release: 'vrm-v1', characters: [
    { ...e, parts: [{ file: 'vrm-test-p1.zip', bytes: 20 }, { file: 'vrm-test-p2.zip', bytes: 10 }] },
    { ...e, id: 'vrm-bad-parts', parts: [{ file: 'x-p1.zip', bytes: 20 }, { file: 'x-p2.zip', bytes: 5 }] },
    { ...e, id: 'vrm-no-sha', sha256: 'nope' },
  ] });
  const idx = Catalog.storeIndex({ characters: path.join(dir, 'c.json'), vrm: path.join(dir, 'v.json') });
  assert.deepEqual(idx.characters.map((c) => c.id), ['vrm-test', 'vrm-bad-parts']);
  assert.deepEqual(idx.characters[0].parts.map((p) => p.file), ['vrm-test-p1.zip', 'vrm-test-p2.zip']);
  assert.equal(idx.characters[1].parts, undefined, 'parts that do not add up to bytes are not trusted');
});

test('dance index: every store dance, its picture, and rows with 已下载', () => {
  const idx = Catalog.loadDanceIndex();
  assert.equal(idx.release, 'dances-v1');
  assert.ok(idx.dances.length >= 1);
  for (const d of idx.dances) {
    assert.match(d.id, /^dance-/);
    assert.ok(Dances.ID_RE.test(d.id), `${d.id} is a library id too`);
    assert.ok(d.duration > 0 && d.bytes > 0);
    if (d.picture) assert.ok(fs.existsSync(path.join(ROOT, 'src', 'renderer', d.picture)), `${d.id}: ${d.picture} ships`);
  }
  const first = idx.dances[0];
  assert.equal(Catalog.downloadUrl(first, {}, {}), `${Catalog.CDN_ORIGIN}/dc/ops-assets/archives/pixel-pet/dances-v1/${first.file}`);
  const rows = Catalog.listDances((id) => id === first.id);
  assert.equal(rows.length, idx.dances.length);
  assert.equal(rows[0].installed, true);
  assert.ok(rows.slice(1).every((r) => !r.installed));
  assert.match(rows[0].sizeLabel, /MB|KB/);
  assert.equal(Catalog.danceEntry('dance-nope'), null);
});

test('a downloaded store dance goes into the library under its store id; 删除舞蹈 frees it again', async () => {
  const lib = tmpDir('pp-storedance-');
  const src = tmpDir('pp-storedance-src-');
  fs.writeFileSync(path.join(src, 'dance.vrma'), Buffer.from('glTF-not-checked-here'));
  fs.writeFileSync(path.join(src, 'audio.mp3'), Buffer.from('ID3'));
  fs.writeFileSync(path.join(src, 'readme.txt'), 'Motion by someone');
  write(path.join(src, 'dance.json'), { name: '测试舞', duration: 12.5, offset: 0, loop: false, audio: 'audio.mp3', cover: 'cover.jpg', readme: 'readme.txt', credit: 'Motion by someone', face: true, ik: 'on', extent: { up: 0.5, side: 0.4 }, ground: 0, bakedWith: 'vmd-retarget@1' });
  const zipFile = path.join(tmpDir('pp-storedance-zip-'), 'dance-test.zip');
  zip(src, zipFile);
  const entry = { id: 'dance-test', name: '测试舞', sha256: sha(fs.readFileSync(zipFile)) };
  const unzip = (z, dest) => execFileSync('unzip', ['-q', z, '-d', dest]);
  const r = await DanceImport.installStore(lib, entry, zipFile, unzip);
  assert.deepEqual(r, { ok: true, id: 'dance-test' });
  const index = JSON.parse(fs.readFileSync(path.join(lib, 'library.json'), 'utf8'));
  const e = index.dances['dance-test'];
  assert.equal(e.file, 'dance-test/dance.vrma');
  assert.equal(e.audio, 'dance-test/audio.mp3');
  assert.equal(e.cover, undefined, 'a cover the archive does not have is not listed');
  assert.equal(e.source, 'store');
  assert.equal(e.catalog.sha256, entry.sha256);
  const clean = Dances.cleanDanceIndex(index).dances['dance-test'];
  assert.equal(clean.source, 'store');
  assert.equal(clean.credit, 'Motion by someone');
  assert.deepEqual([...DanceImport.installedIds(lib)], ['dance-test']);
  assert.deepEqual(fs.readdirSync(lib).filter((n) => n.startsWith('.')), [], 'no staging folder left');
  // an archive without a dance is refused, nothing is written
  const empty = tmpDir('pp-storedance-empty-');
  fs.writeFileSync(path.join(empty, 'x.txt'), 'x');
  const bad = path.join(tmpDir('pp-storedance-bad-'), 'dance-bad.zip');
  zip(empty, bad);
  const rb = await DanceImport.installStore(lib, { id: 'dance-bad', sha256: 'b'.repeat(64) }, bad, unzip);
  assert.equal(rb.ok, false);
  assert.ok(!fs.existsSync(path.join(lib, 'dance-bad')));
  // 删除舞蹈 → not installed any more, can be downloaded again
  assert.equal(DanceImport.remove(lib, 'dance-test').ok, true);
  assert.equal(DanceImport.installedIds(lib).size, 0);
});
