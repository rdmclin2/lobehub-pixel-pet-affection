'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../src/core/packs');
const { SPECIES } = require('../src/core/species');
const { STATES, resolveAction } = require('../src/core/fx');

const BUILTIN = path.join(__dirname, '..', 'src', 'renderer', 'packs');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function writePack(root, manifest, files = []) {
  const dir = path.join(root, manifest.id || 'x');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), PNG); }
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest));
  return dir;
}
const sprites = (over = {}) => ({ schema: 1, id: 'my-pack', name: 'Mine', species: 'grok', kind: 'sprites', pixelated: true, frame: { width: 10, height: 20 }, actions: { idle: { row: 0, col: 0, frames: 2, fps: 2 } }, outfits: { daily: 'a.png' }, ...over });

test('every built-in pack is valid, and every character has art for every outfit it offers', () => {
  const { packs, problems } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  assert.deepEqual(problems, []);
  assert.deepEqual([...packs.keys()].sort(), ['claude-pixel', 'dafeiyu-illustrated', 'dafeiyu-pixel', 'grok-pixel']);
  for (const id of ['dafeiyu', 'claude', 'grok']) {
    const sp = SPECIES[id];
    for (const p of sp.packs) assert.equal(packs.get(p).species, id, `${id} lists ${p}`);
    for (const outfit of sp.outfits) {
      const look = P.resolveLook(packs, { packId: P.chosenPack(packs, {}, id), fallbackId: P.fallbackPack(id), speciesId: id, outfitId: outfit });
      if (sp.art === 'video' && outfit === 'daily') assert.equal(look, null, 'the video character plays its clips in its signature outfit');
      else assert.ok(look, `${id}/${outfit}`);
    }
  }
});

test('the model-chan pixel packs are schema 2 and animate every state of the shared effects layer', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  for (const id of ['claude-pixel', 'grok-pixel', 'dafeiyu-pixel']) {
    const px = packs.get(id);
    assert.equal(px.schema, 2);
    assert.equal(px.kind, 'sprites');
    assert.deepEqual(Object.keys(px.actions).sort(), [...STATES].sort(), `${id} animates every state`);
    for (const st of STATES) assert.equal(resolveAction(st, (n) => !!px.actions[n]).exact, true, `${id}/${st}`);
    assert.deepEqual(px.frame, { width: 83, height: 113 });
  }
});

test('looks: the chosen pack, the character default, then its fallback pack; the video character in daily = clips', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  assert.equal(P.chosenPack(packs, {}, 'grok'), 'grok-pixel');
  assert.equal(P.chosenPack(packs, { grok: 'claude-pixel' }, 'grok'), 'grok-pixel', "another character's pack is ignored");
  assert.equal(P.chosenPack(packs, { grok: 'gone' }, 'grok'), 'grok-pixel');
  assert.equal(P.chosenPack(packs, {}, 'dafeiyu'), 'dafeiyu-illustrated');
  assert.equal(P.chosenPack(packs, { dafeiyu: 'dafeiyu-pixel' }, 'dafeiyu'), 'dafeiyu-pixel');
  const l = P.resolveLook(packs, { packId: 'claude-pixel', fallbackId: 'claude-pixel', speciesId: 'claude', outfitId: 'daily' });
  assert.equal(l.kind, 'sprites');
  assert.equal(l.url, 'pack://claude-pixel/sheets/daily.png');
  assert.ok(l.actions.idle && l.actions.evolve && l.frame.width > 0);
  assert.equal(P.resolveLook(packs, { packId: 'dafeiyu-illustrated', fallbackId: 'dafeiyu-illustrated', speciesId: 'dafeiyu', outfitId: 'daily' }), null);
  // the pixel DeepSeek wears its pixel daily look, and its illustrated pictures for the rest
  assert.equal(P.resolveLook(packs, { packId: 'dafeiyu-pixel', fallbackId: 'dafeiyu-illustrated', speciesId: 'dafeiyu', outfitId: 'daily' }).packId, 'dafeiyu-pixel');
  assert.equal(P.resolveLook(packs, { packId: 'dafeiyu-pixel', fallbackId: 'dafeiyu-illustrated', speciesId: 'dafeiyu', outfitId: 'yukata' }).packId, 'dafeiyu-illustrated');
});

test('a pack with art for some outfits falls back to the character default pack for the rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  writePack(root, sprites({ outfits: { scarf: 'a.png' } }), ['a.png']);
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }, { dir: root, source: 'user' }]);
  assert.equal(packs.get('my-pack').source, 'user');
  const args = { packId: 'my-pack', fallbackId: 'grok-pixel', speciesId: 'grok' };
  assert.equal(P.resolveLook(packs, { ...args, outfitId: 'scarf' }).packId, 'my-pack');
  assert.equal(P.resolveLook(packs, { ...args, outfitId: 'daily' }).packId, 'grok-pixel', 'then the character default pack');
  assert.ok(P.packsFor(packs, 'grok').some((x) => x.id === 'my-pack' && x.outfits === 1));
});

test('schema 1 packs keep working: their older action names map onto the states', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const r = P.readPack(writePack(root, sprites({ actions: { idle: { row: 0, col: 0, frames: 2 }, wave: { row: 1, col: 0, frames: 2 }, cheer: { row: 2, col: 0, frames: 2 }, eat: { row: 3, col: 0, frames: 2 } } }), ['a.png']));
  assert.equal(r.ok, true, (r.errors || []).join());
  const has = (n) => !!r.pack.actions[n];
  assert.deepEqual(resolveAction('pat', has), { name: 'wave', exact: true });
  assert.deepEqual(resolveAction('happy', has), { name: 'cheer', exact: true });
  assert.deepEqual(resolveAction('eat_fruit', has), { name: 'eat', exact: true });
  assert.deepEqual(resolveAction('look', has), { name: 'idle', exact: false });
  assert.match(P.readPack(writePack(root, sprites({ id: 'v1-new-name', actions: { idle: { row: 0, col: 0, frames: 1 }, evolve: { row: 0, col: 0, frames: 1 } } }), ['a.png'])).errors.join(), /unknown action/);
});

test('bad packs are refused with reasons, and cannot reach outside their folder or reuse an id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const check = (m, files) => P.readPack(writePack(root, m, files));
  assert.match(check(sprites({ schema: 3 })).errors.join(), /schema/);
  assert.match(check(sprites({ id: 'A B' })).errors.join(), /id must be/);
  assert.match(check(sprites({ id: 'p-species', species: 'cat' }), ['a.png']).errors.join(), /species must be/);
  assert.match(check(sprites({ id: 'p-outfit', outfits: { tuxedo: 'a.png' } }), ['a.png']).errors.join(), /unknown outfit/);
  assert.match(check(sprites({ id: 'p-escape', outfits: { daily: '../../etc/passwd.png' } })).errors.join(), /relative path/);
  assert.match(check(sprites({ id: 'p-missing' })).errors.join(), /a\.png is missing/);
  assert.match(check(sprites({ id: 'p-script', outfits: { daily: 'x.js' } })).errors.join(), /png/);
  assert.match(check(sprites({ id: 'p-action', actions: { idle: { row: 0, col: 0, frames: 2 }, dance: { row: 0, col: 0, frames: 1 } } }), ['a.png']).errors.join(), /unknown action/);
  assert.match(check(sprites({ id: 'p-noidle', actions: { wave: { row: 0, col: 0, frames: 1 } } }), ['a.png']).errors.join(), /actions\.idle is required/);
  assert.match(P.readPack(fs.mkdtempSync(path.join(os.tmpdir(), 'nopack-'))).errors.join(), /pack\.json: missing/);

  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  writePack(r2, sprites({ id: 'grok-pixel' }), ['a.png']);
  const { packs, problems } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }, { dir: r2, source: 'user' }]);
  assert.equal(packs.get('grok-pixel').source, 'builtin', 'a user pack cannot replace a built-in one');
  assert.match(problems[0].errors[0], /already used/);
});

test('a pictures pack needs no frames or actions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const r = P.readPack(writePack(root, { schema: 1, id: 'pics', name: 'Pics', species: 'claude', kind: 'pictures', outfits: { daily: 'img/d.webp'.replace('webp', 'png') } }, ['img/d.png']));
  assert.equal(r.ok, true);
  assert.equal(r.pack.frame, null);
  assert.equal(r.pack.author, '未署名');
});
