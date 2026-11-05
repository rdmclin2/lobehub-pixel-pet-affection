'use strict';
// 商店 → 小游戏 · 目录与升级 (src/core/game-index.js, docs/mini-games.md §7)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GI = require('../src/core/game-index');
const Catalog = require('../src/core/catalog');

const SHA = 'a'.repeat(64);
const entry = (over = {}) => ({ id: 'pixel-yard', type: 'game', name: '像素小院', version: '1.0.0', engine: 'yard@1', file: 'pixel-yard-1.0.0.zip', bytes: 1000, sha256: SHA, published: '2026-11-05', ...over });

test('compareVersions: numeric per part', () => {
  assert.equal(GI.compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(GI.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(GI.compareVersions('0.9.9', '1.0.0'), -1);
});

test('cleanEntry: a remote entry may only point into the games repository; bad files, hashes and versions are dropped', () => {
  assert.ok(GI.cleanEntry(entry(), 'games-v1'));
  assert.equal(GI.cleanEntry(entry({ version: '1.0' }), 'games-v1'), null);
  assert.equal(GI.cleanEntry(entry({ file: '../x.zip' }), 'games-v1'), null);
  assert.equal(GI.cleanEntry(entry({ sha256: 'nope' }), 'games-v1'), null);
  assert.equal(GI.cleanEntry(entry({ type: 'pack' }), 'games-v1'), null);
  assert.equal(GI.cleanEntry(entry({ picture: 'https://evil.example/x.webp' }), 'games-v1').picture, null);
  assert.equal(GI.cleanEntry(entry({ picture: 'https://raw.githubusercontent.com/rdmclin2/pixel-pet-mini-games/main/games/pixel-yard/cover.webp' }), 'games-v1').picture.endsWith('cover.webp'), true);
  assert.equal(GI.cleanEntry(entry({ repo: 'https://evil.example/' }), 'games-v1').repo, GI.REPO_URL);
  // the download address is built by the app from the CDN, the release and the file name — never taken from the index
  const e = GI.parseIndex({ release: 'games-v7', games: [entry({ url: 'https://evil.example/x.zip' })] }).games[0];
  assert.equal(e.url, undefined);
  assert.equal(Catalog.downloadUrl(e, {}, {}), `${Catalog.CDN_ORIGIN}/${Catalog.UPLOAD_PREFIX_ROOT}/games-v7/pixel-yard-1.0.0.zip`);
});

test('merge: per game the higher version wins; a newer remote one keeps the shipped picture to fall back on', () => {
  const bundled = GI.parseIndex({ games: [entry({ picture: 'catalog/games/pixel-yard.webp' })] }, { bundled: true });
  const remote = GI.parseIndex({ games: [entry({ version: '1.1.0', file: 'pixel-yard-1.1.0.zip', changelog: '加了钓鱼' }), entry({ id: 'snow-hill', name: '雪山', file: 'snow-hill-1.0.0.zip' })] });
  const m = GI.merge(bundled, remote);
  const py = m.games.find((g) => g.id === 'pixel-yard');
  assert.equal(py.version, '1.1.0');
  assert.equal(py.source, 'remote');
  assert.equal(py.bundledPicture, 'catalog/games/pixel-yard.webp');
  assert.ok(m.games.find((g) => g.id === 'snow-hill'), 'a game published after the release shows up');
  const older = GI.merge(bundled, GI.parseIndex({ games: [entry({ version: '0.9.0', file: 'pixel-yard-0.9.0.zip' })] }));
  assert.equal(older.games[0].version, '1.0.0');
  assert.equal(GI.merge(bundled, null).games.length, 1, 'offline: the shipped index');
});

test('storeRows: 未下载 / 已下载 / 有更新 / 需要更新应用, and updates()', () => {
  const index = GI.merge(GI.parseIndex({ games: [entry({ version: '1.2.0', file: 'pixel-yard-1.2.0.zip', changelog: '新地图' }), entry({ id: 'yard-two', engine: 'yard@2', file: 'yard-two-1.0.0.zip' }), entry({ id: 'yard-three', minAppVersion: '9.0.0', file: 'yard-three-1.0.0.zip' })] }), null);
  const ctx = { appVersion: '0.25.0' };
  const by = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));
  let r = by(GI.storeRows(index, new Map(), [], ctx));
  assert.equal(r['pixel-yard'].state, 'remote');
  assert.equal(r['yard-two'].state, 'unsupported');
  assert.equal(r['yard-two'].unsupportedReason, 'engine');
  assert.equal(r['yard-three'].unsupportedReason, 'app');
  r = by(GI.storeRows(index, new Map([['pixel-yard', '1.0.0']]), [], ctx));
  assert.equal(r['pixel-yard'].state, 'update');
  assert.equal(r['pixel-yard'].stateLabel, '有更新');
  assert.equal(r['pixel-yard'].installedVersion, '1.0.0');
  assert.equal(r['pixel-yard'].changelog, '新地图');
  r = by(GI.storeRows(index, new Map([['pixel-yard', '1.2.0'], ['yard-two', '0.5.0']]), [], ctx));
  assert.equal(r['pixel-yard'].state, 'installed');
  assert.equal(r['yard-two'].state, 'installed', 'an installed game this app cannot update stays playable');
  assert.equal(r['yard-two'].updateBlocked, 'engine');
  r = by(GI.storeRows(index, new Map([['pixel-yard', '1.0.0']]), [{ id: 'pixel-yard', received: 1, total: 2, state: 'downloading' }], ctx));
  assert.equal(r['pixel-yard'].state, 'downloading');
  assert.deepEqual(GI.updates(index, new Map([['pixel-yard', '1.0.0'], ['yard-two', '0.5.0']]), ctx).map((u) => [u.id, u.from, u.to]), [['pixel-yard', '1.0.0', '1.2.0']]);
});

test('the shipped index: what scripts/sync-game-catalog.js copied — each entry valid, its picture shipped', () => {
  const raw = JSON.parse(fs.readFileSync(GI.BUNDLED_FILE, 'utf8'));
  const idx = GI.loadBundled();
  assert.equal(idx.games.length, raw.games.length, 'no entry dropped as malformed');
  assert.ok(idx.games.find((g) => g.id === 'pixel-yard'), '像素小院 is in the store');
  for (const g of idx.games) {
    assert.match(g.file, new RegExp(`^${g.id}-${g.version.replace(/\./g, '\\.')}\\.zip$`), 'the archive name carries the version (a published one is never replaced)');
    assert.match(g.repo, /^https:\/\/github\.com\/rdmclin2\/pixel-pet-mini-games/);
    if (g.picture) assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', g.picture)), `${g.id}: its picture ships with the app`);
  }
});
