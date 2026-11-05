'use strict';
// 小游戏包与安装 (src/core/game-pack.js, src/core/game-store.js; docs/mini-games.md §3, §7). The pack used is the
// small fixture test/fixtures/games/mini-yard (the real games live in rdmclin2/pixel-pet-mini-games).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const GP = require('../src/core/game-pack');
const GS = require('../src/core/game-store');
const { zip, sha256 } = require('../scripts/build-character-catalog');

const SRC = path.join(__dirname, 'fixtures', 'games', 'mini-yard');
const ID = 'mini-yard';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-games-'));
const manifest = () => JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

test('validateManifest: the fixture pack is good; data only, an engine this app plays, files and sprites it names exist', () => {
  assert.equal(GS.checkFolder(SRC, ID), null);
  const m = manifest();
  assert.deepEqual(GP.validateManifest(m), []);
  assert.match(GP.validateManifest({ ...m, engine: 'yard@9' }).join(), /engine/);
  assert.match(GP.validateManifest({ ...m, images: { terrain: '../x.webp' } }).join(), /not allowed/);
  assert.match(GP.validateManifest({ ...m, images: { terrain: 'game.js' } }).join(), /not allowed/, 'no code files');
  assert.match(GP.validateManifest(m, { files: ['manifest.json'] }).join(), /terrain.webp is missing/);
  assert.match(GP.validateManifest(m, { sprites: {} }).join(), /no sprite "bench"/);
  const bad = { ...m, objects: [...m.objects, { id: 'x', x: 1, y: 1, sprite: 'bench', use: { at: [1, 1], anim: 'fly' } }] };
  assert.match(GP.validateManifest(bad).join(), /use.anim "fly"/);
  assert.match(GP.validateManifest({ ...m, quests: [{ id: 'q', title: 't', on: { type: 'use-end', obj: 'nope' } }] }).join(), /not an object here/);
  assert.match(GP.validateManifest({ ...m, petHeight: 9000 }).join(), /petHeight/);
});

test('installArchive: a store zip goes into <root>/<id>/ with the marker; listed as installed; removed again', async () => {
  const root = tmp();
  const z = path.join(tmp(), 'mini-yard.zip');
  zip(SRC, z);
  const entry = { id: ID, version: '1.0.0', sha256: sha256(z), bytes: fs.statSync(z).size };
  const r = await GS.installArchive(root, entry, z);
  assert.deepEqual(r, { ok: true, id: ID });
  assert.ok(fs.existsSync(path.join(root, ID, GS.MARKER)));
  const list = GS.listInstalled([{ dir: root, source: 'download' }]);
  assert.deepEqual(list.map((g) => [g.id, g.name, g.removable]), [[ID, '小测试院', true]]);
  // progress lives outside the game folder and survives a reinstall / removal
  GS.writeProgress(root, ID, { quests: { day: 'x', total: 2 } });
  assert.equal(GS.readProgress(root, ID).quests.total, 2);
  assert.equal((await GS.installArchive(root, entry, z)).ok, true);
  assert.equal(GS.readProgress(root, ID).quests.total, 2);
  assert.equal(GS.listInstalled([{ dir: root, source: 'download' }]).length, 1, 'the progress folder is not a game');
  assert.deepEqual(GS.remove(root, ID), { ok: true, id: ID });
  assert.equal(GS.installedIds([{ dir: root, source: 'download' }]).size, 0);
  assert.equal(GS.remove(root, ID).reason, 'not-found');
});

test('installArchive refuses: another id, a stray file (code) in the zip, a broken manifest — and leaves nothing behind', async () => {
  const root = tmp();
  const stage = tmp();
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(stage, f));
  fs.writeFileSync(path.join(stage, 'evil.js'), 'require("child_process")');
  const z = path.join(tmp(), 'g.zip');
  zip(stage, z);
  const r = await GS.installArchive(root, { id: ID, sha256: 'x', bytes: 1 }, z);
  assert.equal(r.reason, 'stray-file');
  assert.equal((await GS.installArchive(root, { id: 'other-game', sha256: 'x', bytes: 1 }, z)).reason, 'wrong-id');
  fs.rmSync(path.join(stage, 'evil.js'));
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ ...manifest(), engine: 'lua@1' }));
  zip(stage, z);
  assert.equal((await GS.installArchive(root, { id: ID, sha256: 'x', bytes: 1 }, z)).reason, 'bad-manifest');
  assert.deepEqual(fs.readdirSync(root), []);
  // a folder put there by hand (no marker) is listed but never deleted from the store
  fs.mkdirSync(path.join(root, ID));
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(root, ID, f));
  assert.equal(GS.installedIds([{ dir: root }]).has(ID), true);
  assert.equal(GS.remove(root, ID).reason, 'not-found');
});

test('update: a newer version replaces the old one in place (installedVersions), the progress file stays', async () => {
  const root = tmp();
  const stage = tmp();
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(stage, f));
  const z1 = path.join(tmp(), 'a.zip');
  zip(stage, z1);
  assert.equal((await GS.installArchive(root, { id: ID, version: '1.0.0', sha256: sha256(z1), bytes: fs.statSync(z1).size }, z1)).ok, true);
  GS.writeProgress(root, ID, { quests: { day: 'x', total: 5 }, state: { plots: { a: { stage: 2 } } } });
  assert.equal(GS.installedVersions([{ dir: root }]).get(ID), '1.0.0');
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ ...manifest(), version: '1.1.0' }));
  const z2 = path.join(tmp(), 'b.zip');
  zip(stage, z2);
  assert.equal((await GS.installArchive(root, { id: ID, version: '1.1.0', sha256: sha256(z2), bytes: fs.statSync(z2).size }, z2)).ok, true);
  assert.equal(GS.installedVersions([{ dir: root }]).get(ID), '1.1.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ID, GS.MARKER), 'utf8')).version, '1.1.0');
  assert.deepEqual(GS.readProgress(root, ID).state, { plots: { a: { stage: 2 } } }, 'her progress survived the update');
  assert.deepEqual(fs.readdirSync(root).sort(), ['.progress', ID], 'nothing of the old copy left');
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
