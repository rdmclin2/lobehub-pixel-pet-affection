'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../src/core/packs');
const { OUTFITS } = require('../src/core/outfits');
const { SPECIES_IDS } = require('../src/core/species');

const BUILTIN = path.join(__dirname, '..', 'src', 'renderer', 'packs');
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function writePack(root, manifest, files = []) {
  const dir = path.join(root, manifest.id || 'x');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), PNG); }
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest));
  return dir;
}
const sprites = (over = {}) => ({ schema: 1, id: 'my-pack', name: 'Mine', species: 'bubbo', kind: 'sprites', pixelated: true, frame: { width: 10, height: 20 }, actions: { idle: { row: 0, col: 0, frames: 2, fps: 2 } }, outfits: { daily: 'a.png' }, ...over });

test('every built-in pack is valid, and every companion has art for every outfit it can wear', () => {
  const { packs, problems } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  assert.deepEqual(problems, []);
  for (const sp of SPECIES_IDS) {
    const fb = packs.get(P.fallbackPack(sp));
    assert.ok(fb, `${sp} has its illustrated pack`);
    for (const x of OUTFITS) {
      if (sp === 'dafeiyu' && (x.rating === 'adult' || x.id === 'daily')) continue; // never offered / its clips
      assert.ok(fb.outfits[x.id], `${sp}/${x.id}`);
    }
  }
  const px = packs.get('bubbo-pixel');
  assert.equal(px.kind, 'sprites');
  assert.deepEqual(Object.keys(px.actions).sort(), [...P.ACTIONS].sort(), 'the pixel pack animates every action');
  assert.equal(Object.keys(px.outfits).length, OUTFITS.length);
});

test('looks: the chosen pack, the species default, then the illustrated fallback; Dafeiyu signature = clips', () => {
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }]);
  assert.equal(P.chosenPack(packs, {}, 'bubbo'), 'bubbo-pixel');
  assert.equal(P.chosenPack(packs, { bubbo: 'bubbo-illustrated' }, 'bubbo'), 'bubbo-illustrated');
  assert.equal(P.chosenPack(packs, { bubbo: 'embit-illustrated' }, 'bubbo'), 'bubbo-pixel', "another species' pack is ignored");
  assert.equal(P.chosenPack(packs, { bubbo: 'gone' }, 'bubbo'), 'bubbo-pixel');
  assert.equal(P.chosenPack(packs, {}, 'embit'), 'embit-illustrated');
  const l = P.resolveLook(packs, { packId: 'bubbo-pixel', fallbackId: 'bubbo-illustrated', speciesId: 'bubbo', outfitId: 'maid' });
  assert.equal(l.kind, 'sprites');
  assert.equal(l.url, 'pack://bubbo-pixel/sheets/maid.png');
  assert.ok(l.actions.idle && l.frame.width > 0);
  assert.equal(P.resolveLook(packs, { packId: 'dafeiyu-illustrated', fallbackId: 'dafeiyu-illustrated', speciesId: 'dafeiyu', outfitId: 'daily' }), null);
});

test('a pack with art for some outfits falls back to the illustrated pack for the rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  writePack(root, sprites(), ['a.png']);
  const { packs } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }, { dir: root, source: 'user' }]);
  assert.equal(packs.get('my-pack').source, 'user');
  const args = { packId: 'my-pack', fallbackId: 'bubbo-illustrated', speciesId: 'bubbo' };
  assert.equal(P.resolveLook(packs, { ...args, outfitId: 'daily' }).packId, 'my-pack');
  assert.equal(P.resolveLook(packs, { ...args, outfitId: 'maid' }).packId, 'bubbo-pixel', 'then the species default pack');
  assert.equal(P.resolveLook(packs, { packId: 'gone', fallbackId: 'sprig-illustrated', speciesId: 'sprig', outfitId: 'maid' }).packId, 'sprig-illustrated', 'then the illustrated pack');
  assert.ok(P.packsFor(packs, 'bubbo').some((x) => x.id === 'my-pack' && x.outfits === 1));
});

test('bad packs are refused with reasons, and cannot reach outside their folder or reuse an id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const check = (m, files) => P.readPack(writePack(root, m, files));
  assert.match(check(sprites({ schema: 2 })).errors.join(), /schema/);
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
  writePack(r2, sprites({ id: 'bubbo-pixel' }), ['a.png']);
  const { packs, problems } = P.loadPacks([{ dir: BUILTIN, source: 'builtin' }, { dir: r2, source: 'user' }]);
  assert.equal(packs.get('bubbo-pixel').source, 'builtin', 'a user pack cannot replace a built-in one');
  assert.match(problems[0].errors[0], /already used/);
});

test('a pictures pack needs no frames or actions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  const r = P.readPack(writePack(root, { schema: 1, id: 'pics', name: 'Pics', species: 'sprig', kind: 'pictures', outfits: { daily: 'img/d.webp'.replace('webp', 'png') } }, ['img/d.png']));
  assert.equal(r.ok, true);
  assert.equal(r.pack.frame, null);
  assert.equal(r.pack.author, '未署名');
});
