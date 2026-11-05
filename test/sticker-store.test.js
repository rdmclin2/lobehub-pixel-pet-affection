'use strict';

// 商店 → 表情包 (docs/stickers-design.md §5.2 方案 B, §5.3): the set zip and its checks (src/core/sticker-set.js),
// the CDN index and its fallbacks (src/core/sticker-catalog.js), installing / attaching / removing a set
// (src/core/stickers.js) and the download path with its size and sha256 checks (src/main/sticker-store.js →
// src/main/catalog.js), all without Electron: fetch is a fake CDN serving files from a folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const SS = require('../src/core/sticker-set');
const SC = require('../src/core/sticker-catalog');
const S = require('../src/core/stickers');
const memes = require('../src/core/memes');
const { StickerStore } = require('../src/main/sticker-store');
const { getSpecies } = require('../src/core/species');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-store-test-'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const meme = (sp, id) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'assets', 'memes', sp, `${id}.webp`));
const claude = getSpecies('claude');
const dafeiyu = getSpecies('dafeiyu');

const META = { id: 'test-set', name: '测试表情', description: '测试用', author: 'tester', license: 'CC BY 4.0', version: '1.0.0', forSpecies: ['dafeiyu'], cover: 'rice' };
const PICS = [
  { id: 'rice', label: '吃白饭', desc: '自嘲时', buffer: meme('dafeiyu', 'rice') },
  { id: 'cute', label: '可爱', desc: '', buffer: meme('dafeiyu', 'cute') },
];
const manifestOf = (over = {}) => ({ schema: 1, ...META, stickers: [{ id: 'rice', label: '吃白饭', file: 'stickers/rice.webp' }, { id: 'cute', label: '可爱', file: 'stickers/cute.webp' }], ...over });
const zipOf = (manifest, files = [{ name: 'stickers/rice.webp', data: PICS[0].buffer }, { name: 'stickers/cute.webp', data: PICS[1].buffer }]) =>
  SS.buildZip([{ name: 'sticker-set.json', data: Buffer.from(JSON.stringify(manifest)) }, ...files]);

// ---- the zip format ------------------------------------------------------------------------------------
test('packSet builds a zip the app accepts, the same bytes every time, readable by unzip-compatible readers', () => {
  const a = SS.packSet(META, PICS);
  const b = SS.packSet(META, PICS);
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  assert.equal(sha(a.zip), sha(b.zip));
  const v = SS.validateSetZip(a.zip);
  assert.equal(v.ok, true);
  assert.equal(v.manifest.id, 'test-set');
  assert.deepEqual(v.manifest.stickers.map((s) => [s.id, s.file, s.width, s.height]), [['rice', 'stickers/rice.webp', 260, 260], ['cute', 'stickers/cute.webp', 260, 260]]);
  assert.equal(v.manifest.license, 'CC BY 4.0');
});

test('validateSetZip refuses a path out of the folder, an absolute path, a symlink and a stray file', () => {
  const bad = (files, man = manifestOf()) => SS.validateSetZip(zipOf(man, files));
  const ok = [{ name: 'stickers/rice.webp', data: PICS[0].buffer }, { name: 'stickers/cute.webp', data: PICS[1].buffer }];
  assert.equal(bad([...ok, { name: '../evil.webp', data: PICS[0].buffer }]).reason, 'bad-path');
  assert.equal(bad([...ok, { name: 'stickers/../../evil', data: PICS[0].buffer }]).reason, 'bad-path');
  assert.equal(bad([...ok, { name: '/etc/passwd', data: Buffer.from('x') }]).reason, 'bad-path');
  assert.equal(bad([...ok, { name: 'C:/x.webp', data: Buffer.from('x') }]).reason, 'bad-path');
  assert.equal(bad([...ok, { name: 'stickers\\x.webp', data: Buffer.from('x') }]).reason, 'bad-path');
  assert.equal(bad([...ok, { name: 'readme.txt', data: Buffer.from('hi') }]).reason, 'stray-file');
  assert.equal(bad([...ok, { name: 'other/', data: Buffer.alloc(0) }]).reason, 'stray-file');
  // a manifest whose file points out of stickers/
  assert.equal(bad(ok, manifestOf({ stickers: [{ id: 'rice', label: 'x', file: '../rice.webp' }] })).reason, 'bad-manifest');
  // a symlink entry (unix mode 120777 in the external attributes)
  const z = zipOf(manifestOf());
  const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  z.writeUInt32LE((0o120777 << 16) >>> 0, cd + 38);
  assert.equal(SS.validateSetZip(z).reason, 'bad-path');
  // Finder's junk is skipped, not refused
  assert.equal(bad([...ok, { name: '__MACOSX/._rice.webp', data: Buffer.from('x') }]).ok, true);
});

test('validateSetZip: license and author required, at most 120 stickers, 2 MB each, type by content', () => {
  assert.equal(SS.validateSetZip(zipOf(manifestOf({ license: '' }))).reason, 'bad-manifest');
  assert.match(SS.validateSetZip(zipOf(manifestOf({ license: undefined }))).errors.join(), /license is required/);
  assert.match(SS.validateSetZip(zipOf(manifestOf({ author: ' ' }))).errors.join(), /author is required/);
  const many = Array.from({ length: 121 }, (_, i) => ({ id: `s${i}`, label: `s${i}`, file: `stickers/s${i}.webp` }));
  assert.match(SS.validateSetZip(zipOf(manifestOf({ stickers: many, cover: 's0' }), [])).errors.join(), /at most 120/);
  // a text file renamed .webp is found out
  const fake = SS.validateSetZip(zipOf(manifestOf(), [{ name: 'stickers/rice.webp', data: Buffer.from('not a picture at all, just text') }, { name: 'stickers/cute.webp', data: PICS[1].buffer }]));
  assert.equal(fake.reason, 'bad-image');
  // a PNG named .webp is accepted and kept as what it is
  const big = Buffer.alloc(S.MAX_STICKER_BYTES + 1, 1);
  assert.equal(SS.validateSetZip(zipOf(manifestOf(), [{ name: 'stickers/rice.webp', data: big }, { name: 'stickers/cute.webp', data: PICS[1].buffer }])).reason, 'too-large');
  // a missing picture
  assert.equal(SS.validateSetZip(zipOf(manifestOf(), [{ name: 'stickers/rice.webp', data: PICS[0].buffer }])).reason, 'missing-file');
  // not a zip / a cut-off zip
  assert.equal(SS.validateSetZip(Buffer.from('hello world, this is not a zip')).reason, 'bad-zip');
  const z = SS.packSet(META, PICS).zip;
  assert.equal(SS.validateSetZip(z.subarray(0, z.length - 40)).ok, false);
});

test('readZip checks a declared size before inflating anything (a zip bomb is refused unread)', () => {
  const z = zipOf(manifestOf());
  // claim the first picture inflates to 50 MB
  let cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cd + 4);
  z.writeUInt32LE(50 * 1024 * 1024, cd + 24);
  const r = SS.readZip(z);
  assert.equal(r.reason, 'too-large');
});

// ---- the index -----------------------------------------------------------------------------------------
function entryFor(zip, man = META, previews = []) {
  return { id: man.id, type: 'sticker-set', name: man.name, description: '', author: man.author, official: true, license: man.license, version: man.version, forSpecies: man.forSpecies, count: PICS.length, cover: man.cover, previews, file: `${man.id}-1-0-0.zip`, bytes: zip.length, sha256: sha(zip) };
}

test('sticker-catalog: malformed entries are dropped, a broken body is null, remote > cache > bundled', () => {
  const zip = SS.packSet(META, PICS).zip;
  const good = entryFor(zip);
  const idx = SC.parseIndex({ schema: 1, release: 'stickers-v1', sets: [good, { ...good, id: 'x' }, { ...good, id: 'no-license', license: '' }, { ...good, id: 'bad-sha', sha256: 'zz' }, { ...good, id: 'evil-file', file: '../x.zip' }, good] });
  assert.deepEqual(idx.sets.map((s) => s.id), ['test-set']);
  assert.equal(SC.parseRemote('<html>502</html>'), null);
  assert.equal(SC.parseRemote({ schema: 1, sets: [] }), null);
  assert.equal(SC.parseRemote(JSON.stringify({ schema: 1, sets: [good] })).sets.length, 1);
  // previews may only be previews/<its sha256>.<ext>
  const pv = { id: 'rice', label: 'r', file: `previews/${sha(PICS[0].buffer)}.webp`, bytes: PICS[0].buffer.length, sha256: sha(PICS[0].buffer) };
  assert.equal(SC.cleanEntry({ ...good, previews: [pv, { ...pv, file: 'previews/../../x.webp' }, { ...pv, sha256: 'a'.repeat(64) }] }, 'stickers-v1').previews.length, 1);
  const remote = SC.parseIndex({ sets: [good] });
  const bundled = SC.parseIndex({ sets: [{ ...good, id: 'bundled-set' }] });
  assert.equal(SC.pick({ remote, cached: null, bundled }).source, 'remote');
  assert.equal(SC.pick({ remote: null, cached: remote, bundled }).source, 'cache');
  assert.deepEqual(SC.pick({ remote: null, cached: null, bundled }).index.sets.map((s) => s.id), ['bundled-set']);
  assert.equal(SC.fileUrl({ release: 'stickers-v1' }, 'a.zip'), 'https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/stickers-v1/a.zip');
  assert.equal(SC.fileUrl({ release: 'stickers-v1' }, 'a.zip', 'http://127.0.0.1:9/m/'), 'http://127.0.0.1:9/m/a.zip');
});

test('the shipped sticker-catalog.json is valid and lists at least two built-in characters\' memes', () => {
  const idx = SC.loadBundled();
  const builtins = idx.sets.filter((s) => /-memes$/.test(s.id));
  assert.ok(builtins.length >= 2, `only ${builtins.length}`);
  for (const s of builtins) assert.ok(s.previews.length === s.count && s.official && s.license);
});

// ---- install / attach / remove -------------------------------------------------------------------------
test('installStore: a 商店 group for her, sendable, [梗图:id] finds it, survives a restart; remove keeps old messages', () => {
  const dir = tmp();
  const lib = new S.StickerLibrary(dir);
  const zip = SS.packSet(META, PICS).zip;
  const r = lib.installStore(entryFor(zip), zip, 'claude');
  assert.equal(r.ok, true, r.text);
  assert.ok(fs.existsSync(path.join(dir, 'sets', 'store-test-set.json')));
  // a restart: a fresh library reads it back
  const again = new S.StickerLibrary(dir);
  const sets = again.list(claude).sets;
  const store = sets.find((s) => s.kind === 'store');
  assert.equal(store.name, '商店 · 测试表情');
  assert.equal(store.readOnly, true);
  assert.deepEqual(store.stickers.map((s) => s.id), ['rice', 'cute']);
  // not hers: another character does not see it
  assert.equal(again.list(dafeiyu).sets.some((s) => s.kind === 'store'), false);
  // the panel's pick and the reply tag
  const pick = again.resolve(claude, 'store-test-set', 'rice');
  assert.equal(pick.ok, true);
  assert.match(pick.sticker.ref, /^blob:[0-9a-f]{64}\.webp$/);
  assert.equal(again.resolve(dafeiyu, 'store-test-set', 'rice').ok, false);
  assert.equal(again.resolveTag(claude, 'cute').ref.startsWith('blob:'), true);
  const cat = again.catalog(claude);
  assert.ok(cat.some((m) => m.id === 'rice'));
  assert.equal(memes.extractMeme('好的\n[梗图:rice]', { memes: cat }).meme, 'rice');
  assert.ok(S.refUrl(pick.sticker.ref));
  // attach to one more
  assert.equal(again.attachStore('test-set', 'dafeiyu').ok, true);
  assert.equal(again.list(dafeiyu).sets.some((s) => s.kind === 'store'), true);
  assert.deepEqual(again.storeInstalled().get('test-set').attached, ['claude', 'dafeiyu']);
  // 移除: gone from both; a chat message that showed rice keeps its blob through gc
  const removed = again.removeStore('test-set');
  assert.deepEqual(removed.attached, ['claude', 'dafeiyu']);
  assert.equal(again.list(claude).sets.some((s) => s.kind === 'store'), false);
  assert.equal(again.resolve(claude, 'store-test-set', 'rice').ok, false);
  const keep = pick.sticker.ref.slice(5);
  const gone = again.gc([keep]);
  assert.ok(again.blobPath(keep));
  assert.equal(gone.length, 1);
  assert.equal(again.removeStore('test-set').ok, false);
});

test('installStore refuses a zip whose set id is not the entry\'s, and a bad zip, writing nothing', () => {
  const dir = tmp();
  const lib = new S.StickerLibrary(dir);
  const zip = SS.packSet(META, PICS).zip;
  assert.equal(lib.installStore({ ...entryFor(zip), id: 'other-set' }, zip, 'claude').reason, 'wrong-id');
  assert.equal(lib.installStore(entryFor(zip), Buffer.from('nope'), 'claude').ok, false);
  assert.equal(lib.installStore(entryFor(zip), zip, '../x').reason, 'bad-species');
  assert.equal(fs.existsSync(path.join(dir, 'sets')), false);
});

// ---- the main-process store, with a fake CDN -----------------------------------------------------------
function fakeCdn(files, { failIndex = false } = {}) {
  const hits = [];
  const fetch = async (url) => {
    hits.push(url);
    const name = url.replace(/^.*\/stickers-v1\//, '').replace(/^http:\/\/mirror\//, '');
    if (failIndex && name === 'sticker-catalog.json') throw new Error('getaddrinfo ENOTFOUND chat-cloud.lobeobjects.space');
    const body = files[name];
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200 });
  };
  return { fetch, hits };
}

function published() {
  const p = SS.packSet(META, PICS);
  const previews = p.stickers.map((s) => ({ id: s.id, label: s.label, desc: s.desc, file: `previews/${s.sha256}.${s.ext}`, bytes: s.buffer.length, sha256: s.sha256 }));
  const entry = { ...entryFor(p.zip, META, previews), file: 'test-set-1-0-0.zip' };
  const files = { 'test-set-1-0-0.zip': p.zip, 'sticker-catalog.json': JSON.stringify({ schema: 1, release: 'stickers-v1', sets: [entry] }) };
  for (const s of p.stickers) files[`previews/${s.sha256}.${s.ext}`] = s.buffer;
  return { entry, files, zip: p.zip };
}

const storeFor = (dir, cdn, extra = {}) => {
  const events = [];
  const store = new StickerStore({ lib: new S.StickerLibrary(dir), fetch: cdn.fetch, emit: (ch, p) => events.push([ch, p]), names: () => ({ claude: '克洛蒂', dafeiyu: '大肥鱼' }), url: `${SC.REMOTE_URL}`, bundled: SC.parseIndex({ sets: [] }), ...extra });
  return { store, events };
};

test('StickerStore: lists the CDN index with cached covers, 获取 downloads + installs with progress, 移除', async () => {
  const dir = tmp();
  const { files } = published();
  const cdn = fakeCdn(files);
  const { store, events } = storeFor(dir, cdn);
  const st = await store.state();
  assert.equal(st.source, 'remote');
  assert.equal(st.error, null);
  assert.equal(st.sets[0].id, 'test-set');
  assert.equal(st.sets[0].count, 2);
  assert.match(st.sets[0].coverUrl, /^sticker:\/\/store\/[0-9a-f]{64}\.webp$/);
  assert.deepEqual(st.sets[0].forSpecies, [{ id: 'dafeiyu', name: '大肥鱼' }]);
  assert.ok(cdn.hits[0].endsWith('/stickers-v1/sticker-catalog.json'));
  const d = await store.detail('test-set');
  assert.equal(d.stickers.length, 2);
  assert.ok(d.stickers.every((x) => /^sticker:\/\/store\//.test(x.url)));
  assert.ok(store.lib.cachePath(d.stickers[1].url.slice('sticker://store/'.length)));
  const r = await store.get('test-set', 'claude');
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(events.filter(([ch]) => ch === 'catalog-progress').map(([, p]) => p.state).filter((s, i, a) => s !== a[i - 1]), ['downloading', 'installing', 'done']);
  const after = await store.state();
  assert.equal(after.sets[0].installed, true);
  assert.deepEqual(after.sets[0].attached, [{ id: 'claude', name: '克洛蒂' }]);
  // 获取 for another character: attached, nothing downloaded again
  const zips = cdn.hits.filter((u) => u.endsWith('.zip')).length;
  const r2 = await store.get('test-set', 'dafeiyu');
  assert.equal(r2.attachedOnly, true);
  assert.equal(cdn.hits.filter((u) => u.endsWith('.zip')).length, zips);
  assert.equal((await store.get('test-set', 'dafeiyu')).reason, 'installed');
  assert.equal(store.remove('test-set').ok, true);
  assert.equal((await store.state()).sets[0].installed, false);
});

test('StickerStore: a zip whose sha256 does not match the index is refused and nothing is installed', async () => {
  const dir = tmp();
  const { files, zip } = published();
  // the CDN serves another file of the same size (one byte flipped)
  const tampered = Buffer.from(zip);
  tampered[Math.floor(zip.length / 2)] ^= 0xff;
  const { store, events } = storeFor(dir, fakeCdn({ ...files, 'test-set-1-0-0.zip': tampered }));
  await store.state();
  const r = await store.get('test-set', 'claude');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'checksum');
  assert.match(r.text, /sha256/);
  assert.equal(store.lib.storeInstalled().size, 0);
  assert.equal(fs.existsSync(path.join(dir, 'sets')), false);
  assert.ok(events.some(([ch, p]) => ch === 'catalog-progress' && p.state === 'failed' && p.reason === 'checksum'));
  // a zip of another size: refused for its size
  const { store: s2 } = storeFor(tmp(), fakeCdn({ ...files, 'test-set-1-0-0.zip': Buffer.concat([zip, Buffer.from('x')]) }));
  await s2.state();
  assert.equal((await s2.get('test-set', 'claude')).reason, 'size');
  // the CDN answers 404
  const { store: s3 } = storeFor(tmp(), fakeCdn({ ...files, 'test-set-1-0-0.zip': undefined }));
  await s3.state();
  assert.equal((await s3.get('test-set', 'claude')).reason, 'http');
});

test('StickerStore: a preview whose sha256 does not match is not cached or shown', async () => {
  const { files, entry } = published();
  const bad = { ...files, [entry.previews[1].file]: Buffer.from(files[entry.previews[0].file]) };
  const { store } = storeFor(tmp(), fakeCdn(bad));
  const d = await store.detail('test-set');
  assert.ok(d.stickers[0].url);
  assert.equal(d.stickers[1].url, null);
});

test('StickerStore: the CDN unreachable → the last good read, else the bundled index, with the error; retry recovers', async () => {
  const dir = tmp();
  const { files } = published();
  // first run: online, the index is kept on disk
  await storeFor(dir, fakeCdn(files)).store.state();
  // next run: offline → the cached copy
  const off = storeFor(dir, fakeCdn(files, { failIndex: true })).store;
  const st = await off.state({ refresh: true });
  assert.equal(st.source, 'cache');
  assert.match(st.error, /ENOTFOUND/);
  assert.equal(st.sets[0].id, 'test-set');
  // a fresh data folder offline → the bundled copy
  const bundledIdx = SC.parseIndex({ sets: [{ ...published().entry, id: 'shipped-set' }] });
  const fresh = storeFor(tmp(), fakeCdn(files, { failIndex: true }), { bundled: bundledIdx }).store;
  const sb = await fresh.state();
  assert.equal(sb.source, 'bundled');
  assert.deepEqual(sb.sets.map((s) => s.id), ['shipped-set']);
  assert.ok(sb.error);
  // back online: 重试 reads the CDN
  fresh.fetch = fakeCdn(files).fetch;
  fresh.downloader.fetch = fresh.fetch;
  const back = await fresh.state({ refresh: true });
  assert.equal(back.source, 'remote');
  assert.equal(back.error, null);
});
