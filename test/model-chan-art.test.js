'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../src/core/packs');
const { SPECIES_IDS } = require('../src/core/species');

// The first model-chan packs wait in art/model-chan/packs until their characters join species.js; they
// must already be valid schema-1 packs in bubbo-pixel's sheet format, and cover every Dafeiyu clip.
const ROOT = path.join(__dirname, '..');
const STAGED = path.join(ROOT, 'art', 'model-chan', 'packs');
const CHARS = JSON.parse(fs.readFileSync(path.join(ROOT, 'art', 'model-chan', 'characters.json'), 'utf8')).characters;
const pngInfo = (file) => {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${file} is a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), depth: b[24], colorType: b[25] };
};

test('staged model-chan packs are valid sprite packs in the bubbo-pixel format', () => {
  const ref = pngInfo(path.join(ROOT, 'src', 'renderer', 'packs', 'bubbo-pixel', 'sheets', 'daily.png'));
  const refPack = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'packs', 'bubbo-pixel', 'pack.json'), 'utf8'));
  const sprites = CHARS.filter((c) => c.art.pack);
  assert.deepEqual(sprites.map((c) => c.id).sort(), ['claude', 'dafeiyu', 'grok']);
  const added = sprites.map((c) => c.id).filter((id) => !SPECIES_IDS.includes(id));
  SPECIES_IDS.push(...added);
  try {
    const { packs, problems } = P.loadPacks([{ dir: STAGED, source: 'builtin' }]);
    assert.deepEqual(problems, []);
    for (const c of sprites) {
      const pack = packs.get(`${c.id}-pixel`);
      assert.ok(pack, c.id);
      assert.equal(pack.species, c.id);
      assert.deepEqual(pack.frame, refPack.frame);
      assert.deepEqual(pack.actions, refPack.actions, 'same layout as bubbo-pixel');
      const extra = JSON.parse(fs.readFileSync(path.join(pack.dir, 'actions-extra.json'), 'utf8'));
      for (const rel of [pack.outfits.daily, extra.sheet]) assert.deepEqual(pngInfo(path.join(pack.dir, rel)), ref, `${c.id}/${rel}`);
      const known = new Set([...Object.keys(pack.actions), ...Object.keys(extra.actions)]);
      for (const clip of CHARS.find((x) => x.id === 'dafeiyu').art.states) assert.ok(known.has(extra.clips[clip]), `${c.id} covers ${clip}`);
    }
  } finally {
    SPECIES_IDS.splice(SPECIES_IDS.length - added.length, added.length);
  }
});
