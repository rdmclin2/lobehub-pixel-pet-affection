'use strict';

// 通用设定 (core/generic.js, docs/vrm-dance.md §12): a VRM model is a companion of her own — her own base, made
// from the template with the model's name, so affection, name, chat and agent are hers; the save never hands
// her state to another character, even while her model is gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const G = require('../src/core/generic');
const S = require('../src/core/species');
const P = require('../src/core/packs');
const C = require('../src/core/characters');
const Catalog = require('../src/core/catalog');
const Persona = require('../src/core/persona');
const { migratePet } = require('../src/core/migrate');
const { importVrm } = require('../src/core/vrm-import');
const { makeTestVrm } = require('../scripts/make-test-vrm');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
async function genericPack(dir, name) {
  const src = path.join(tmp('pp-gen-src-'), `${name}.vrm`);
  fs.writeFileSync(src, makeTestVrm({ name }));
  const r = await importVrm({ src, speciesId: G.GENERIC_BASE, userDir: dir });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.pack.id;
}

test('a generic base id: letters only (settings keys), the same for the same pack', () => {
  const a = G.baseIdOf('vrm-generic-mika');
  assert.match(a, /^[a-z]{2,20}$/);
  assert.equal(a, G.baseIdOf('vrm-generic-mika'));
  assert.notEqual(a, G.baseIdOf('vrm-generic-yuki'));
  assert.ok(G.isGenericBase(a));
  assert.ok(!G.isGenericBase('dafeiyu'));
  assert.deepEqual(S.validateCharacter(G.characterFor({ id: 'vrm-generic-mika', name: 'Mika', author: 'someone' })), [], 'the template is a valid character file');
});

test('generic VRM packs: each one is a companion of her own, named after her model', async () => {
  const dir = tmp('pp-gen-');
  const mika = await genericPack(dir, 'Mika');
  const yuki = await genericPack(dir, 'Yuki');
  assert.match(mika, /^vrm-generic-/);
  const { packs, problems } = P.loadPacks([{ dir, source: 'user' }]);
  assert.deepEqual(problems, []);
  const a = packs.get(mika);
  const b = packs.get(yuki);
  assert.equal(a.generic, true);
  assert.equal(a.species, G.baseIdOf(mika));
  assert.notEqual(a.species, b.species, 'two models, two companions');
  const sp = S.SPECIES[a.species];
  assert.equal(sp.nameZh, 'Mika');
  assert.equal(sp.vendor, '通用');
  assert.equal(sp.virtual, true);
  assert.deepEqual(sp.packs, [mika]);
  // her persona: the template with her model's name, an adult like every character
  const role = Persona.buildSystemRole({ speciesId: a.species, name: 'Mika' });
  assert.match(role, /Mika/);
  assert.match(sp.personality, /成年角色，设定年龄 18 岁/);
  assert.doesNotMatch(role, /DeepSeek|大肥鱼/);
  // in the roster as her own character; never under 大肥鱼
  const list = C.listCharacters(packs, { all: true });
  const e = list.find((x) => x.id === mika);
  assert.equal(e.base, a.species);
  assert.equal(e.name, 'Mika', 'her look is called by her own name');
  assert.ok(!list.some((x) => x.base === 'dafeiyu' && x.id === mika));
  assert.equal(C.defaultCharacter(packs, a.species), mika);
  // her model gone: she is not listed as an empty card
  fs.rmSync(path.join(dir, yuki), { recursive: true, force: true });
  const after = C.listCharacters(P.loadPacks([{ dir, source: 'user' }]).packs, { all: true });
  assert.ok(!after.some((x) => x.base === b.species), 'no stub card for a companion without her model');
});

test('a saved generic companion whose model is gone keeps her state; nobody takes it over', () => {
  const ghost = G.baseIdOf('vrm-generic-gone-for-now');
  const now = Date.now();
  const raw = { schemaVersion: 3, speciesId: ghost, characterId: 'vrm-generic-gone-for-now', characters: { [ghost]: { name: '小幽', affection: 321, createdAt: now }, dafeiyu: { name: '鱼', affection: 5, createdAt: now } } };
  const { pet } = migratePet(raw, now);
  assert.equal(pet.speciesId, ghost, 'she is still the current companion');
  assert.ok(pet.characters[ghost], 'her own entry stays');
  assert.equal(pet.characters.dafeiyu.name, '鱼', '大肥鱼 is untouched');
  assert.ok(!pet.retiredFrom);
  assert.equal(S.getSpecies(ghost).ghost, true);
  assert.equal(S.resolveSpeciesId(ghost), ghost);
});

test('store VRM models: each index entry names her own generic base, so 需要下载 can bring her back', () => {
  const vrm = Catalog.storeIndex().characters.filter((c) => c.kind === 'vrm');
  assert.ok(vrm.length > 0);
  for (const c of vrm) assert.equal(c.base, G.baseIdOf(c.id), c.id);
  const first = vrm[0];
  const sp = G.ghostFor(first.base);
  assert.equal(sp.nameZh, first.name.trim().slice(0, 40) || 'VRM 伙伴');
  assert.deepEqual(sp.art.packs, [first.id]);
});
