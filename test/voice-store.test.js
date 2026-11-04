'use strict';
// 商店 → 语音包 (core/voice-store.js): installing a downloaded archive (checked, rolled back on any problem),
// which packs are on disk, the store row's state (未下载 / 下载中 / 已下载), and the download itself through
// src/main/catalog.js CatalogDownloader (size + sha256 against the index) with a local file server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const VS = require('../src/core/voice-store');
const VP = require('../src/core/voice-pack');
const Catalog = require('../src/core/catalog');

const ROOT = path.join(__dirname, '..');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const AUDIO = Buffer.from('OggS fake audio');

// a small valid style pack folder (two lines + the sample)
function packDir(id = 'style-test', over = {}) {
  const d = tmp('vs-src-');
  const lines = { '你好呀。': 'a1.ogg', '晚安。': 'a2.ogg' };
  for (const f of [...Object.values(lines), 's.ogg']) fs.writeFileSync(path.join(d, f), AUDIO);
  const m = { format: 1, kind: 'style', style: 'cute', id, name: '测试 · 可爱', gender: 'female', version: '1.0.0', engine: 'minimax', voiceId: 'tianxin_xiaoling', model: 'speech-2.8-turbo', params: { speed: 1 }, credit: 'MiniMax', lineSet: 'generic', sample: { text: '嗨。', file: 's.ogg' }, lines, ...over };
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m));
  return d;
}
function zipOf(dir) {
  const out = path.join(tmp('vs-zip-'), 'p.zip');
  // python's zipfile: every file under dir, folders included (no `zip` binary needed)
  const py = 'import os,sys,zipfile\nz=zipfile.ZipFile(sys.argv[2],"w")\nfor r,ds,fs in os.walk(sys.argv[1]):\n  for f in fs:\n    p=os.path.join(r,f); z.write(p, os.path.relpath(p, sys.argv[1]))\nz.close()';
  execFileSync('python3', ['-I', '-c', py, dir, out]);
  return out;
}
const entry = (id, zip) => ({ id, version: '1.0.0', bytes: fs.statSync(zip).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex') });
const dots = (root) => fs.readdirSync(root).filter((n) => n.startsWith('.') || n.includes('.old-'));

test('installArchive: a valid archive lands in <root>/<id>/ with the marker; installedIds and VoicePacks see it', async () => {
  const root = tmp('vs-root-');
  const zip = zipOf(packDir());
  const r = await VS.installArchive(root, entry('style-test', zip), zip);
  assert.deepEqual(r, { ok: true, id: 'style-test' });
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'style-test', VS.MARKER), 'utf8'));
  assert.equal(marker.id, 'style-test');
  assert.match(marker.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual([...VS.installedIds(root)], ['style-test']);
  assert.deepEqual(dots(root), []);
  const packs = new VoicePacksOf(root);
  const row = packs.list().find((p) => p.id === 'style-test');
  assert.equal(row.kind, 'style');
  assert.equal(row.store, true);
});

class VoicePacksOf extends VP.VoicePacks {
  constructor(root) { super([path.join(tmp('vs-builtin-')), root]); }
}

test('installArchive refuses and leaves nothing behind: wrong id, not a style pack, missing audio, stray file, a folder, not a zip', async () => {
  const cases = [
    ['wrong-id', () => packDir('style-other')],
    ['not-style', () => { const d = packDir(); const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'))); m.kind = 'generic'; delete m.style; fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m)); return d; }],
    ['bad-manifest', () => { const d = packDir(); fs.rmSync(path.join(d, 'a2.ogg')); return d; }],
    ['stray-file', () => { const d = packDir(); fs.writeFileSync(path.join(d, 'evil.sh'), 'x'); return d; }],
    ['stray-file', () => { const d = packDir(); fs.mkdirSync(path.join(d, 'sub')); fs.writeFileSync(path.join(d, 'sub', 'x.ogg'), AUDIO); return d; }],
    ['no-manifest', () => { const d = packDir(); fs.rmSync(path.join(d, 'manifest.json')); return d; }],
  ];
  for (const [reason, make] of cases) {
    const root = tmp('vs-root-');
    const zip = zipOf(make());
    const r = await VS.installArchive(root, entry('style-test', zip), zip);
    assert.equal(r.ok, false, reason);
    assert.equal(r.reason, reason);
    assert.ok(r.text && /[㐀-鿿]/.test(r.text), `readable text for ${reason}: ${r.text}`);
    assert.deepEqual(fs.readdirSync(root), [], `${reason}: nothing left in the voicepacks folder`);
  }
  const root = tmp('vs-root-');
  const junk = path.join(tmp('vs-junk-'), 'x.zip');
  fs.writeFileSync(junk, 'not a zip');
  const r = await VS.installArchive(root, { id: 'style-test', sha256: 'x', bytes: 9 }, junk);
  assert.equal(r.ok, false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('installArchive over an existing folder: a failure keeps the earlier one as it was', async () => {
  const root = tmp('vs-root-');
  const good = zipOf(packDir());
  assert.equal((await VS.installArchive(root, entry('style-test', good), good)).ok, true);
  const before = fs.readFileSync(path.join(root, 'style-test', 'manifest.json'), 'utf8');
  const badDir = packDir();
  fs.rmSync(path.join(badDir, 'a1.ogg'));
  const bad = zipOf(badDir);
  const r = await VS.installArchive(root, entry('style-test', bad), bad);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'style-test', 'manifest.json'), 'utf8'), before);
  assert.deepEqual(dots(root), []);
});

test('installedIds: the disk is the truth — broken, renamed or hidden folders are not 已下载', async () => {
  const root = tmp('vs-root-');
  const zip = zipOf(packDir());
  await VS.installArchive(root, entry('style-test', zip), zip);
  fs.cpSync(path.join(root, 'style-test'), path.join(root, 'style-renamed'), { recursive: true }); // manifest id ≠ folder
  fs.cpSync(path.join(root, 'style-test'), path.join(root, '.style-test-tmp'), { recursive: true }); // being unpacked
  assert.deepEqual([...VS.installedIds(root)].sort(), ['style-test']);
  assert.deepEqual([...VS.installedIds(root, new Set(['style-cute']))], []);
  fs.rmSync(path.join(root, 'style-test', 'a1.ogg')); // a file deleted by hand
  assert.deepEqual([...VS.installedIds(root)], []);
  assert.deepEqual([...VS.installedIds(path.join(root, 'missing'))], []);
  // VoicePacks never loads a dot folder (a download being unpacked)
  assert.ok(!new VoicePacksOf(root).list().some((p) => p.id === 'style-test' && p.dir && p.dir.includes('.style-test-tmp')));
});

test('remove: only a folder the store put there', async () => {
  const root = tmp('vs-root-');
  const zip = zipOf(packDir());
  await VS.installArchive(root, entry('style-test', zip), zip);
  fs.cpSync(packDir('my-own'), path.join(root, 'my-own'), { recursive: true }); // made by hand: no marker
  assert.equal(VS.remove(root, 'my-own').ok, false);
  assert.ok(fs.existsSync(path.join(root, 'my-own')));
  assert.equal(VS.remove(root, '../etc').ok, false);
  assert.deepEqual(VS.remove(root, 'style-test'), { ok: true, id: 'style-test' });
  assert.ok(!fs.existsSync(path.join(root, 'style-test')));
  assert.equal(VS.remove(root, 'style-test').reason, 'not-found');
});

test('deriveState: 未下载 / 下载中 (percent, installing) / 已下载; a failed or canceled download is 未下载 again', () => {
  assert.deepEqual(VS.deriveState(false, null), { state: 'remote' });
  assert.deepEqual(VS.deriveState(true, null), { state: 'installed' });
  assert.deepEqual(VS.deriveState(false, { state: 'downloading', received: 250, total: 1000 }), { state: 'downloading', percent: 25, installing: false });
  assert.deepEqual(VS.deriveState(false, { state: 'downloading', received: 5 }), { state: 'downloading', percent: 0, installing: false });
  assert.deepEqual(VS.deriveState(false, { state: 'installing', received: 1000, total: 1000 }), { state: 'downloading', percent: 100, installing: true });
  assert.deepEqual(VS.deriveState(true, { state: 'done' }), { state: 'installed' });
  assert.deepEqual(VS.deriveState(false, { state: 'failed', reason: 'checksum', text: '校验没通过' }), { state: 'remote', error: '校验没通过' });
  assert.deepEqual(VS.deriveState(false, { state: 'failed', reason: 'canceled', text: '已取消下载' }), { state: 'remote' });
  // a running download wins over what the disk says (a re-download after a hand-made copy)
  assert.equal(VS.deriveState(true, { state: 'downloading', received: 1, total: 2 }).state, 'downloading');
});

test('storeRows: the shipped index, each row with its state and label', () => {
  const rows = Catalog.listVoicePacks((id) => id === 'style-yujie');
  assert.ok(rows.length >= 3);
  for (const r of rows) for (const k of ['name', 'styleLabel', 'description', 'sizeLabel', 'credit', 'engine', 'voiceId']) assert.ok(r[k], `${r.id}.${k}`);
  const out = VS.storeRows(rows, [{ id: 'style-cute', received: 10, total: 100, state: 'downloading' }]);
  const by = Object.fromEntries(out.map((r) => [r.id, [r.state, r.stateLabel]]));
  assert.deepEqual(by['style-cute'], ['downloading', '下载中']);
  assert.deepEqual(by['style-yujie'], ['installed', '已下载']);
  assert.deepEqual(by['style-chenwen'], ['remote', '未下载']);
});

// ---- the downloader (src/main/catalog.js) with a local server playing the release host -----------------------
function withFakeElectron(fn) {
  const orig = Module._load;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return { app: { getVersion: () => '0.0.0-test' }, net: { fetch: (...a) => fetch(...a) } };
    return orig.call(this, req, ...rest);
  };
  try {
    delete require.cache[require.resolve('../src/main/catalog')];
    return fn(require('../src/main/catalog'));
  } finally {
    Module._load = orig;
  }
}

test('CatalogDownloader + installArchive: downloads, checks sha256, installs; a corrupted or short archive is refused, nothing left', async () => {
  const zip = zipOf(packDir());
  const buf = fs.readFileSync(zip);
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    let b = buf;
    if (mode === 'corrupt') { b = Buffer.from(buf); b[b.length >> 1] ^= 0xff; }
    if (mode === 'short') b = buf.subarray(0, buf.length - 10);
    if (mode === '404') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-length': b.length });
    res.end(b);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = tmp('vs-root-');
  const e = { ...entry('style-test', zip), name: '测试', file: 'style-test.zip', release: 'voices-v1' };
  const events = [];
  try {
    await withFakeElectron(async ({ CatalogDownloader }) => {
      const dl = new CatalogDownloader({
        packStore: null, settings: () => ({ catalogUrl: base }), emit: (ch, p) => events.push(p),
        lookup: (id) => (id === e.id ? e : null),
        isInstalled: (x) => VS.installedIds(root, new Set([x.id])).has(x.id),
        install: (x, z) => VS.installArchive(root, x, z),
        texts: { unknown: '商店里没有这个语音包', installed: '这个语音包已经下载好了', invalid: '下载的语音包文件有问题，已丢弃' },
      });
      assert.equal((await dl.download('nope')).reason, 'unknown');
      for (const [m, reason] of [['corrupt', 'checksum'], ['short', 'size'], ['404', 'http']]) {
        mode = m;
        const r = await dl.download(e.id);
        assert.equal(r.reason, reason, m);
        assert.ok(/[㐀-鿿]/.test(r.text));
        assert.deepEqual(fs.readdirSync(root), [], `${m}: nothing installed`);
      }
      mode = 'ok';
      const r = await dl.download(e.id);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual([...VS.installedIds(root)], ['style-test']);
      assert.equal((await dl.download(e.id)).reason, 'installed');
      assert.deepEqual(events.filter((p) => p.id === e.id).map((p) => p.state).filter((s, i, a) => s !== a[i - 1]).slice(-3), ['downloading', 'installing', 'done']);
      // a valid archive whose contents are wrong: the installer's own reason reaches the owner
      const badDir = packDir('style-other');
      const bad = zipOf(badDir);
      const e2 = { ...entry('style-bad', bad), name: '坏包', file: 'style-bad.zip' };
      const dl2 = new CatalogDownloader({ packStore: null, settings: () => ({ catalogUrl: base }), emit: () => {}, lookup: () => e2, isInstalled: () => false, install: (x, z) => VS.installArchive(root, x, z), texts: { invalid: '下载的语音包文件有问题，已丢弃' } });
      const badBuf = fs.readFileSync(bad);
      server.removeAllListeners('request');
      server.on('request', (_q, res) => { res.writeHead(200, { 'content-length': badBuf.length }); res.end(badBuf); });
      const r2 = await dl2.download('style-bad');
      assert.equal(r2.reason, 'invalid');
      assert.match(r2.text, /下载的语音包文件有问题，已丢弃：下载的语音包和商店条目对不上/);
      assert.deepEqual([...VS.installedIds(root)], ['style-test']);
    });
  } finally {
    server.close();
  }
});

test('the shipped store archives (out/voice-catalog, when built) install as valid packs', { skip: !fs.existsSync(path.join(ROOT, 'out', 'voice-catalog', 'style-cute.zip')) && 'out/voice-catalog not built (node scripts/build-voice-catalog.js)' }, async () => {
  const e = Catalog.voicePackEntry('style-cute');
  const zip = path.join(ROOT, 'out', 'voice-catalog', e.file);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex'), e.sha256);
  const root = tmp('vs-root-');
  assert.deepEqual(await VS.installArchive(root, e, zip), { ok: true, id: 'style-cute' });
  const p = new VoicePacksOf(root).get('style-cute');
  assert.equal(p.lines.size, e.lines);
});
