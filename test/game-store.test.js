'use strict';
// 小游戏包与 商店 → 小游戏 (src/core/game-pack.js, src/core/game-store.js, core/catalog.js listGames; docs/mini-games.md §3, §7)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const GP = require('../src/core/game-pack');
const GS = require('../src/core/game-store');
const Catalog = require('../src/core/catalog');
const { zip, sha256 } = require('../scripts/build-character-catalog');

const SRC = path.join(__dirname, '..', 'catalog', 'games', 'pixel-yard');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-games-'));
const manifest = () => JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

test('validateManifest: the 像素小院 pack is good; data only, an engine this app plays, files and sprites it names exist', () => {
  assert.equal(GS.checkFolder(SRC, 'pixel-yard'), null);
  const m = manifest();
  assert.deepEqual(GP.validateManifest(m), []);
  assert.match(GP.validateManifest({ ...m, engine: 'yard@9' }).join(), /engine/);
  assert.match(GP.validateManifest({ ...m, images: { terrain: '../x.webp' } }).join(), /not allowed/);
  assert.match(GP.validateManifest({ ...m, images: { terrain: 'game.js' } }).join(), /not allowed/, 'no code files');
  assert.match(GP.validateManifest(m, { files: ['manifest.json'] }).join(), /terrain.webp is missing/);
  assert.match(GP.validateManifest(m, { sprites: {} }).join(), /no sprite "cottage"/);
  const bad = { ...m, objects: [...m.objects, { id: 'x', x: 1, y: 1, sprite: 'bench', use: { at: [1, 1], anim: 'fly' } }] };
  assert.match(GP.validateManifest(bad).join(), /use.anim "fly"/);
  assert.match(GP.validateManifest({ ...m, quests: [{ id: 'q', title: 't', on: { type: 'use-end', obj: 'nope' } }] }).join(), /not an object here/);
});

test('installArchive: a store zip goes into <root>/<id>/ with the marker; listed as installed; removed again', async () => {
  const root = tmp();
  const z = path.join(tmp(), 'pixel-yard.zip');
  zip(SRC, z);
  const entry = { id: 'pixel-yard', version: '1.0.0', sha256: sha256(z), bytes: fs.statSync(z).size };
  const r = await GS.installArchive(root, entry, z);
  assert.deepEqual(r, { ok: true, id: 'pixel-yard' });
  assert.ok(fs.existsSync(path.join(root, 'pixel-yard', GS.MARKER)));
  const list = GS.listInstalled([{ dir: root, source: 'download' }]);
  assert.deepEqual(list.map((g) => [g.id, g.name, g.removable]), [['pixel-yard', '像素小院', true]]);
  // progress lives outside the game folder and survives a reinstall / removal
  GS.writeProgress(root, 'pixel-yard', { quests: { day: 'x', total: 2 } });
  assert.equal(GS.readProgress(root, 'pixel-yard').quests.total, 2);
  assert.equal((await GS.installArchive(root, entry, z)).ok, true);
  assert.equal(GS.readProgress(root, 'pixel-yard').quests.total, 2);
  assert.equal(GS.listInstalled([{ dir: root, source: 'download' }]).length, 1, 'the progress folder is not a game');
  assert.deepEqual(GS.remove(root, 'pixel-yard'), { ok: true, id: 'pixel-yard' });
  assert.equal(GS.installedIds([{ dir: root, source: 'download' }]).size, 0);
  assert.equal(GS.remove(root, 'pixel-yard').reason, 'not-found');
});

test('installArchive refuses: another id, a stray file (code) in the zip, a broken manifest — and leaves nothing behind', async () => {
  const root = tmp();
  const stage = tmp();
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(stage, f));
  fs.writeFileSync(path.join(stage, 'evil.js'), 'require("child_process")');
  const z = path.join(tmp(), 'g.zip');
  zip(stage, z);
  const r = await GS.installArchive(root, { id: 'pixel-yard', sha256: 'x', bytes: 1 }, z);
  assert.equal(r.reason, 'stray-file');
  assert.equal((await GS.installArchive(root, { id: 'other-game', sha256: 'x', bytes: 1 }, z)).reason, 'wrong-id');
  fs.rmSync(path.join(stage, 'evil.js'));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ ...manifest(), engine: 'lua@1' }));
  zip(stage, z);
  assert.equal((await GS.installArchive(root, { id: 'pixel-yard', sha256: 'x', bytes: 1 }, z)).reason, 'bad-manifest');
  assert.deepEqual(fs.readdirSync(root), []);
  // a folder put there by hand (no marker) is listed but never deleted from the store
  fs.mkdirSync(path.join(root, 'pixel-yard'));
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(root, 'pixel-yard', f));
  assert.equal(GS.installedIds([{ dir: root }]).has('pixel-yard'), true);
  assert.equal(GS.remove(root, 'pixel-yard').reason, 'not-found');
});

test('the store index: 像素小院 is listed with its archive matching catalog/games (node scripts/build-game-packs.js --check)', () => {
  const idx = Catalog.loadGameIndex();
  assert.equal(idx.release, 'games-v1');
  const g = Catalog.gameEntry('pixel-yard');
  assert.ok(g, 'in the index');
  assert.equal(g.version, manifest().version);
  const z = path.join(tmp(), 'pixel-yard.zip');
  zip(SRC, z);
  assert.equal(sha256(z), g.sha256, 'the published archive is what catalog/games/pixel-yard builds');
  assert.equal(fs.statSync(z).size, g.bytes);
  if (g.picture) assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', g.picture)), 'the card picture ships with the app');
  const rows = GS.storeRows(Catalog.listGames(() => false), [{ id: 'pixel-yard', received: 50, total: 100, state: 'downloading' }]);
  assert.equal(rows[0].state, 'downloading');
  assert.equal(rows[0].percent, 50);
  assert.equal(GS.storeRows(Catalog.listGames(() => true))[0].stateLabel, '已下载');
});

test('affection: a quest done in a game is the `game` source, two points, at most three a day', () => {
  const aff = require('../src/core/affection');
  const state = require('../src/core/pet-state');
  const pet = state.createPet('claude', 'x', Date.UTC(2026, 10, 5, 10));
  const t = Date.UTC(2026, 10, 5, 10);
  const deltas = [0, 1, 2, 3].map((i) => aff.gainAffection(pet, 'game', t + i * 1000).parts.find((p) => p.source === 'game').delta);
  assert.deepEqual(deltas, [2, 2, 2, 0]);
  assert.equal(aff.AFFECTION_RULES.game.dailyMax, 3);
});
