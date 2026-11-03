'use strict';
// T-2764: 「每个形象就是一个角色」 — the roster is one entry per look (core/characters.js), the old per-persona
// 形象包 choice is migrated once (core/character-migrate.js), and every character keeps her own wardrobe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('../src/core/packs');
const C = require('../src/core/characters');
const M = require('../src/core/character-migrate');
const settingsLib = require('../src/core/settings');
const { buildRoster } = require('../src/core/roster');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');

const ROOT = path.join(__dirname, '..');
const BUILTIN = path.join(ROOT, 'src', 'renderer', 'packs');
const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const builtin = () => require('../src/core/catalog').repoPacks().packs;
const clone = (o) => JSON.parse(JSON.stringify(o));

const ALL_AGES = [
  ['dafeiyu-pixel', 'dafeiyu', '大肥鱼 · 像素', 'sprites'],
  ['dafeiyu-live2d', 'dafeiyu', '大肥鱼 · Live2D', 'live2d'],
  ['dafeiyu-live', 'dafeiyu', '大肥鱼 · 全动态', 'rig'],
  ['dafeiyu-classic', 'dafeiyu', '大肥鱼 · 旧版像素', 'sprites'],
  ['dafeiyu-clips', 'dafeiyu', '大肥鱼 · 原版动画', 'video'],
  ['claude-pixel', 'claude', '克洛蒂 · 像素', 'sprites'],
  ['claude-classic', 'claude', '克洛蒂 · 旧版像素', 'sprites'],
  ['grok-pixel', 'grok', '格萝可 · 像素', 'sprites'],
  ['grok-classic', 'grok', '格萝可 · 旧版像素', 'sprites'],
  ['gemini-pixel', 'gemini', '杰米 · 像素', 'sprites'],
  ['gemini-classic', 'gemini', '杰米 · 旧版像素', 'sprites'],
  ['gpt-pixel', 'gpt', '吉皮缇 · 像素', 'sprites'],
  ['gpt-classic', 'gpt', '吉皮缇 · 旧版像素', 'sprites'],
];
const DAFEIYU_ALL = ['dafeiyu-pixel', 'dafeiyu-live2d', 'dafeiyu-live', 'dafeiyu-classic', 'dafeiyu-adult', 'dafeiyu-clips'];

// ---- roster expansion -------------------------------------------------------------------------------------

test('roster: every built-in pack (and 大肥鱼\'s clips) is a character of her own, base by base, her default first', () => {
  const packs = builtin();
  const list = C.listCharacters(packs);
  assert.deepEqual(list.map((e) => [e.id, e.base, e.name, e.kind]), ALL_AGES);
  assert.ok(list.every((e) => !e.adult));
  // 18+ looks are characters too, listed only with adult content on (each after her base's built-in ones)
  const adult = C.listCharacters(packs, { adultOk: true });
  assert.equal(adult.length, 18);
  assert.deepEqual(adult.filter((e) => e.adult).map((e) => [e.id, e.name]), [
    ['dafeiyu-adult', '大肥鱼 · 成年版（18+）'], ['claude-adult', '克洛蒂 · 成年版（18+）'], ['grok-adult', '格萝可 · 成年版（18+）'], ['gemini-adult', '杰米 · 成年版（18+）'], ['gpt-adult', '吉皮缇 · 成年版（18+）'],
  ]);
  assert.deepEqual(adult.filter((e) => e.base === 'dafeiyu').map((e) => e.id), DAFEIYU_ALL, 'her file\'s order, clips last');
  assert.deepEqual(C.listCharacters(packs, { all: true }).map((e) => e.id), adult.map((e) => e.id));
  // lookups
  assert.equal(C.characterById(packs, 'dafeiyu-live2d').label, 'Live2D');
  assert.equal(C.characterById(packs, 'dafeiyu-clips').clips, true);
  assert.equal(C.characterById(packs, 'grok-clips'), null, 'a pack character has no clips');
  assert.equal(C.characterById(packs, 'dafeiyu'), null, 'a base is not a character');
  assert.equal(C.defaultCharacter(packs, 'gpt'), 'gpt-pixel');
  assert.equal(C.resolveCharacterId(packs, 'claude'), 'claude-pixel', 'an old per-persona id → her default character');
  assert.equal(C.resolveCharacterId(packs, 'bubbo'), 'dafeiyu-pixel', 'a retired one → her successor\'s');
  assert.equal(C.resolveCharacterId(packs, 'claude-adult'), 'claude-pixel', 'an 18+ look with adult content off → her default');
  assert.equal(C.resolveCharacterId(packs, 'claude-adult', { adultOk: true }), 'claude-adult');
  assert.equal(C.resolveCharacterId(packs, 'vrm-gemini-gone'), 'gemini-pixel', 'a removed import → her base\'s default');
  assert.equal(C.baseOf(packs, 'dafeiyu-live2d'), 'dafeiyu');
});

test('roster before the first hatch: one row per character with her own name, kind, picture and the base\'s persona', () => {
  // what ships with the app: the five pixel characters (the others are downloaded first, core/catalog.js)
  const shipped = buildRoster(null, { ttsStatus: { packs: [] } });
  assert.deepEqual(shipped.map((r) => [r.id, r.base, r.name, r.kind]), ALL_AGES.filter(([id]) => id.endsWith('-pixel')));
  // with everything downloaded (catalog/ counted as downloaded): main.js hands buildRoster the characters and
  // each one's daily look (PetService.lookFor), as here
  const packs = builtin();
  const look = (id) => { const e = C.characterById(packs, id); return e.clips ? null : P.resolveLook(packs, { packId: e.packId, speciesId: e.base, outfitId: 'daily' }); };
  const rows = buildRoster(null, { ttsStatus: { packs: [] } }, { characters: C.listCharacters(packs), look });
  assert.deepEqual(rows.map((r) => [r.id, r.base, r.name, r.kind]), ALL_AGES);
  const l2d = rows.find((r) => r.id === 'dafeiyu-live2d');
  assert.equal(l2d.displayName, '大肥鱼 · Live2D（DeepSeek）');
  assert.equal(l2d.kindLabel, 'Live2D');
  assert.equal(l2d.source, 'download');
  assert.equal(l2d.sourceLabel, '下载');
  assert.equal(l2d.personality, rows.find((r) => r.id === 'dafeiyu-pixel').personality, 'persona inherited from her base');
  assert.ok(l2d.personality.length > 20);
  const pics = rows;
  assert.equal(pics.find((r) => r.id === 'dafeiyu-clips').preview.type, 'video');
  assert.equal(pics.find((r) => r.id === 'claude-pixel').preview.type, 'sprite');
  assert.match(pics.find((r) => r.id === 'dafeiyu-live2d').preview.url, /^pack:\/\/dafeiyu-live2d\//);
  assert.ok(rows.every((r) => !r.current && !r.met && r.packKinds.length === 1));
});

// ---- the migration (pure) ---------------------------------------------------------------------------------

const T0 = new Date('2026-01-05T14:00:00').getTime();
const OLD_SETTINGS = {
  ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: T0, adultContent: true,
  appearance: { dafeiyu: 'dafeiyu-live2d', claude: 'claude-adult', grok: 'gone-pack' },
  framings: { dafeiyu: 'half' },
  visitors: ['claude', 'gemini'],
  vrmPostures: { 'vrm-dafeiyu-whale': 'sit.rest' },
  models: { claude: 'lobehub:claude-opus-5-5' },
  systemRoles: { dafeiyu: '叫我老板' },
};
const oldChar = (speciesId, name, over = {}) => ({ speciesId, name, agentId: `agt_${speciesId}`, topicId: `tpc_${speciesId}`, createdAt: T0 - 1e6, affection: 30, relStage: 'familiar', peakStage: 'familiar', hunger: 20, mood: 70, energy: 80, sleeping: false, lastTickAt: T0, lastInteractionAt: T0, lastFedAt: T0, lastSpokeAt: 0, seenUnlocks: [], equippedOutfit: 'scarf', lastSafeOutfit: 'scarf', ...over });
const OLD_PET = {
  schemaVersion: 3, speciesId: 'dafeiyu', createdAt: T0 - 1e6, owner: 'me', space: { workspaceId: null, name: '个人空间' },
  characters: { dafeiyu: oldChar('dafeiyu', '小鱼'), grok: oldChar('grok', '小格', { equippedOutfit: 'casual', lastSafeOutfit: 'casual' }) },
};

test('migration: settings and pet.json before → after, old key → new key', () => {
  const packs = builtin();
  const r = M.migrateAll({ settings: clone(OLD_SETTINGS), pet: clone(OLD_PET), packs });
  assert.equal(r.settingsChanged, true);
  assert.equal(r.petChanged, true);
  const s = r.settings;
  // settings: appearance → gone (kept read-only), framings / visitors → per character, the rest unchanged
  assert.equal('appearance' in s, false);
  assert.deepEqual(s.legacyAppearance, OLD_SETTINGS.appearance);
  assert.deepEqual(s.framings, Object.fromEntries(DAFEIYU_ALL.map((id) => [id, 'half'])), 'her 取景 for every one of her characters');
  assert.deepEqual(s.visitors, ['claude-adult', 'gemini-pixel'], 'her chosen look, else her default');
  assert.deepEqual(s.vrmPostures, OLD_SETTINGS.vrmPostures, 'a character id is her pack id: unchanged');
  assert.deepEqual(s.models, OLD_SETTINGS.models, 'per base: shared by her characters');
  assert.deepEqual(s.systemRoles, OLD_SETTINGS.systemRoles, 'per base: shared by her characters');
  assert.equal(s.characterModel, 2);
  // pet.json: current base + her 形象包 → characterId; her outfit into the wardrobe of each of her characters
  const p = r.pet;
  assert.equal(p.characterId, 'dafeiyu-live2d');
  assert.equal(p.speciesId, 'dafeiyu', 'speciesId stays: her base');
  assert.equal(p.characterModel, 2);
  assert.deepEqual(p.characters.dafeiyu.wardrobes, Object.fromEntries(DAFEIYU_ALL.map((id) => [id, { equippedOutfit: 'scarf', lastSafeOutfit: 'scarf' }])));
  assert.deepEqual(p.characters.grok.wardrobes, { 'grok-pixel': { equippedOutfit: 'casual', lastSafeOutfit: 'casual' }, 'grok-classic': { equippedOutfit: 'casual', lastSafeOutfit: 'casual' }, 'grok-adult': { equippedOutfit: 'casual', lastSafeOutfit: 'casual' } });
  // shared per base, untouched: agent, chat topic, name, affection
  for (const k of ['agentId', 'topicId', 'name', 'affection', 'peakStage']) assert.equal(p.characters.dafeiyu[k], OLD_PET.characters.dafeiyu[k], k);
  // the normalized settings keep every migrated key
  const n = settingsLib.normalizeSettings(s);
  assert.deepEqual([n.characterModel, n.appearance, n.framings, n.visitors, n.legacyAppearance], [2, undefined, s.framings, s.visitors, s.legacyAppearance]);
});

test('migration: an unknown or removed pack, another base\'s pack, or no choice at all fall back to her default character', () => {
  const packs = builtin();
  const pet = { ...clone(OLD_PET), speciesId: 'grok' };
  assert.equal(M.migratePet(pet, { packs, appearance: { grok: 'gone-pack' } }).pet.characterId, 'grok-pixel');
  assert.equal(M.migratePet(pet, { packs, appearance: { grok: 'claude-pixel' } }).pet.characterId, 'grok-pixel', 'not hers');
  assert.equal(M.migratePet(pet, { packs, appearance: {} }).pet.characterId, 'grok-pixel');
  assert.equal(M.migratePet({ ...clone(OLD_PET), speciesId: 'dafeiyu' }, { packs, appearance: { dafeiyu: 'dafeiyu-clips' } }).pet.characterId, 'dafeiyu-clips', 'her clips are a character');
  // a retired persona's choice goes to her successor
  const s = M.migrateSettings({ appearance: { bubbo: 'dafeiyu-classic' }, visitors: ['bubbo', 'nobody'], framings: { embit: 'half' } }, packs).settings;
  assert.deepEqual(s.legacyAppearance, { dafeiyu: 'dafeiyu-classic' });
  assert.deepEqual(s.visitors, ['dafeiyu-classic']);
  assert.deepEqual(Object.keys(s.framings), ['claude-pixel', 'claude-classic', 'claude-adult']);
});

test('migration is idempotent: a second run changes nothing', () => {
  const packs = builtin();
  const once = M.migrateAll({ settings: clone(OLD_SETTINGS), pet: clone(OLD_PET), packs });
  const twice = M.migrateAll({ settings: clone(once.settings), pet: clone(once.pet), packs });
  assert.equal(twice.settingsChanged, false);
  assert.equal(twice.petChanged, false);
  assert.deepEqual(twice.settings, once.settings);
  assert.deepEqual(twice.pet, once.pet);
  assert.equal(M.migrateSettings(once.settings, packs).changed, false);
  assert.equal(M.migratePet(once.pet, { packs }).changed, false);
  // a choice made under the new model is never overwritten by a later migration of an old key
  const mixed = M.migrateSettings({ framings: { dafeiyu: 'half', 'dafeiyu-pixel': 'full' } }, packs).settings;
  assert.equal(mixed.framings['dafeiyu-pixel'], 'full');
  assert.equal(mixed.framings['dafeiyu-live2d'], 'half');
  // a new file starts migrated
  assert.equal(settingsLib.normalizeSettings(null).characterModel, 2);
  assert.equal(settingsLib.normalizeSettings({ adultContent: false }).characterModel, 1, 'an old file without the mark');
});

// ---- through PetService, on disk --------------------------------------------------------------------------

function svcOn({ settings = null, pet = null, packs = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petcm-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  if (settings) fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings, null, 2));
  if (pet) fs.writeFileSync(path.join(data, 'pet.json'), JSON.stringify(pet, null, 2));
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const mk = () => {
    const s = new PetService({ lh, store: new Store(data), settingsStore: new settingsLib.SettingsStore(data), packs: packs || undefined, now: () => T0, rnd: () => 0.5 });
    s.on('error', () => {});
    return s;
  };
  const read = (f) => fs.readFileSync(path.join(data, f), 'utf8');
  return { dir, data, mk, read };
}

test('PetService migrates settings.json and pet.json once on load, with backups; a second start rewrites nothing', () => {
  const { mk, read } = svcOn({ settings: OLD_SETTINGS, pet: OLD_PET });
  const origSettings = read('settings.json');
  const origPet = read('pet.json');
  const v = mk().init();
  assert.equal(v.pet.characterId, 'dafeiyu-live2d');
  assert.equal(v.character.name, '大肥鱼 · Live2D');
  assert.equal(v.look.packId, 'dafeiyu-live2d');
  assert.equal(v.pet.agentId, 'agt_dafeiyu', 'her agent and chat stay');
  assert.equal(v.pet.topicId, 'tpc_dafeiyu');
  assert.equal(v.outfit, 'daily', 'her Live2D pack has no scarf: shown in daily');
  assert.equal(read('settings.characters.bak.json'), origSettings, 'the old settings.json is backed up');
  assert.equal(read('pet.characters.bak.json'), origPet, 'the old pet.json is backed up');
  const s1 = JSON.parse(read('settings.json'));
  const p1 = JSON.parse(read('pet.json'));
  assert.equal(s1.appearance, undefined);
  assert.equal(s1.characterModel, 2);
  assert.equal(p1.characterId, 'dafeiyu-live2d');
  assert.equal(p1.characterModel, 2);
  assert.equal(p1.characters.dafeiyu.wardrobes['dafeiyu-pixel'].equippedOutfit, 'scarf', 'her pixel self keeps the scarf');
  // second start: same files, the backups are not replaced
  const after1 = [read('settings.json'), read('pet.json')];
  const v2 = mk().init();
  assert.deepEqual([read('settings.json'), read('pet.json')], after1);
  assert.equal(read('settings.characters.bak.json'), origSettings);
  assert.equal(read('pet.characters.bak.json'), origPet);
  assert.equal(v2.pet.characterId, 'dafeiyu-live2d');
  // switching back to her pixel self: same agent, her own wardrobe
  const s = mk();
  s.init();
  return s.switchCharacter('dafeiyu-pixel').then((r) => {
    assert.equal(r.created, false);
    assert.equal(r.view.pet.agentId, 'agt_dafeiyu');
    assert.equal(r.view.outfit, 'scarf');
  });
});

test('an imported pack is an independent character: listed on her own, switchable, and an old choice of it migrates to her', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'petcm-user-'));
  const dst = path.join(tmp, 'claude-mine');
  fs.cpSync(path.join(ROOT, 'catalog', 'packs', 'claude-classic'), dst, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dst, 'pack.json'), 'utf8'));
  fs.writeFileSync(path.join(dst, 'pack.json'), JSON.stringify({ ...m, id: 'claude-mine', name: '克洛蒂 · 我的' }));
  const user = P.loadPacks([{ dir: tmp, source: 'user' }]);
  assert.deepEqual([...user.packs.keys()], ['claude-mine'], JSON.stringify(user.errors || []));
  const packs = new Map([...builtin(), ...user.packs]);
  assert.deepEqual(C.listCharacters(packs).filter((e) => e.base === 'claude').map((e) => [e.id, e.source]), [['claude-pixel', 'builtin'], ['claude-classic', 'download'], ['claude-mine', 'user']]);

  // an old save that wore it as claude's 形象包
  const pet = { ...clone(OLD_PET), speciesId: 'claude', characters: { claude: oldChar('claude', '小克') } };
  const { mk, read } = svcOn({ settings: { ...OLD_SETTINGS, appearance: { claude: 'claude-mine' } }, pet, packs });
  const svc = mk();
  const v = svc.init();
  assert.equal(v.pet.characterId, 'claude-mine');
  assert.equal(v.look.packId, 'claude-mine');
  const row = v.characters.find((c) => c.id === 'claude-mine');
  assert.deepEqual([row.base, row.source, row.name, row.current, row.pack.source], ['claude', 'user', '克洛蒂 · 我的', true, 'user']);
  assert.equal(JSON.parse(read('pet.json')).characterId, 'claude-mine');
  const roster = buildRoster(v, svc.settingsView());
  assert.equal(roster.find((r) => r.id === 'claude-mine').sourceLabel, '导入');
  // switch away and back: she is a character like any other
  assert.equal((await svc.switchCharacter('claude-pixel')).view.look.packId, 'claude-pixel');
  const back = await svc.switchCharacter('claude-mine');
  assert.equal(back.ok, true);
  assert.equal(back.view.pet.agentId, 'agt_claude', 'the same 克洛蒂: shared agent');
  // the pack removed: she becomes her base's default character
  svc.setPacks(builtin());
  assert.equal(svc.view().pet.characterId, 'claude-pixel');
  assert.equal(svc.view().characters.some((c) => c.id === 'claude-mine'), false);
});

test('the wardrobe is per character: what one look wears never changes another\'s', async () => {
  const { mk, read } = svcOn();
  const svc = mk();
  await svc.hatch({ characterId: 'dafeiyu-pixel', name: '小鱼' });
  svc.unlockAll('dafeiyu');
  assert.equal(svc.equipOutfit('scarf').ok, true);
  // 大肥鱼 · 旧版像素 has one outfit: her own wardrobe is daily only
  let r = await svc.switchCharacter('dafeiyu-classic');
  assert.equal(r.ok, true);
  assert.deepEqual(r.view.outfits.map((o) => o.id), ['daily']);
  assert.equal(r.view.outfit, 'daily');
  assert.equal(svc.equipOutfit('scarf').ok, false);
  r = await svc.switchCharacter('dafeiyu-pixel');
  assert.equal(r.view.outfit, 'scarf', 'the pixel one still wears her scarf');
  const disk = JSON.parse(read('pet.json')).characters.dafeiyu.wardrobes;
  assert.deepEqual(disk['dafeiyu-pixel'], { equippedOutfit: 'scarf', lastSafeOutfit: 'scarf' });
  assert.deepEqual(disk['dafeiyu-classic'], { equippedOutfit: 'daily', lastSafeOutfit: 'daily' });

  // an 18+ look is a character with her own wardrobe, apart from the all-ages one
  svc.answerAgeGate(true);
  await svc.switchCharacter('claude-pixel', { name: '小克' });
  svc.unlockAll('claude');
  assert.equal(svc.equipOutfit('swimsuit').ok, true);
  await svc.switchCharacter('claude-adult');
  assert.equal(svc.view().outfit, 'daily', 'her 18+ self starts in her own daily');
  assert.equal(svc.equipOutfit('maid').ok, true);
  await svc.switchCharacter('claude-pixel');
  assert.equal(svc.view().outfit, 'swimsuit');
  const w = JSON.parse(read('pet.json')).characters.claude.wardrobes;
  assert.equal(w['claude-pixel'].equippedOutfit, 'swimsuit');
  assert.equal(w['claude-adult'].equippedOutfit, 'maid');
  assert.equal(w['claude-adult'].lastSafeOutfit, 'daily', 'an adult outfit is never the all-ages fallback');
});

// ---- 内置与下载 (core/catalog.js): only the five pixel characters ship -------------------------------------

const Catalog = require('../src/core/catalog');
const shippedOnly = () => Catalog.repoPacks({ catalog: false }).packs;

test('catalog: the app ships five pixel characters; every other look is in the download index with size and sha256', () => {
  const ids = C.listCharacters(shippedOnly(), { all: true }).map((e) => e.id);
  assert.deepEqual(ids, ['dafeiyu-pixel', 'claude-pixel', 'grok-pixel', 'gemini-pixel', 'gpt-pixel']);
  const idx = Catalog.loadIndex();
  const all = C.listCharacters(builtin(), { all: true }).map((e) => e.id);
  // the index lists exactly the looks that do not ship, the clips included
  assert.deepEqual(idx.characters.map((c) => c.id).sort(), all.filter((id) => !ids.includes(id)).sort());
  for (const c of idx.characters) {
    assert.match(c.sha256, /^[0-9a-f]{64}$/, c.id);
    assert.ok(c.bytes > 0 && c.file === `${c.id}.zip`, c.id);
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'renderer', c.picture)), `${c.id}: card picture ${c.picture}`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'renderer', 'packs', c.id)), `${c.id} must not ship`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'renderer', 'assets', 'dafeiyu')), 'the clips do not ship either');
});

test('catalog: what can be downloaded — 18+ only with adult content on, installed ones not again; where from', () => {
  const none = () => false;
  const safe = Catalog.notInstalled(none).map((c) => c.id);
  assert.ok(safe.includes('dafeiyu-live2d') && safe.includes('dafeiyu-clips') && safe.includes('claude-classic'));
  assert.ok(!safe.some((id) => id.endsWith('-adult')), '18+ looks are not offered with adult content off');
  assert.ok(Catalog.notInstalled(none, { adultOk: true }).some((c) => c.id === 'dafeiyu-adult'));
  assert.ok(!Catalog.notInstalled((id) => id === 'dafeiyu-live2d').some((c) => c.id === 'dafeiyu-live2d'));
  const l2d = Catalog.notInstalled(none).find((c) => c.id === 'dafeiyu-live2d');
  assert.deepEqual([l2d.base, l2d.kind, l2d.name], ['dafeiyu', 'live2d', '大肥鱼 · Live2D']);
  assert.match(l2d.sizeLabel, /^\d+\.\d MB$/);
  assert.equal(Catalog.baseUrl({}, {}), `https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/${Catalog.loadIndex().release}`);
  assert.equal(Catalog.baseUrl({ catalogUrl: 'https://mirror.example/chars/' }, {}), 'https://mirror.example/chars');
  assert.equal(Catalog.baseUrl({ catalogUrl: 'https://mirror.example/chars' }, { PIXELPET_CATALOG_URL: 'file:///tmp/cat' }), 'file:///tmp/cat');
  assert.equal(Catalog.baseUrl({ catalogUrl: 'javascript:alert(1)' }, {}), Catalog.DEFAULT_BASE_URL, 'only http(s) / file URLs');
  assert.equal(Catalog.downloadUrl(Catalog.entry('dafeiyu-live2d'), {}, { PIXELPET_CATALOG_URL: 'http://127.0.0.1:9/x' }), 'http://127.0.0.1:9/x/dafeiyu-live2d.zip');
});

test('catalog: 原版动画 is a character only once her clips are installed', () => {
  const packs = shippedOnly();
  assert.equal(C.characterById(packs, 'dafeiyu-clips'), null);
  assert.ok(!C.listCharacters(packs).some((e) => e.id === 'dafeiyu-clips'));
  packs.clips = new Set(['dafeiyu-clips']);
  assert.equal(C.characterById(packs, 'dafeiyu-clips').source, 'download');
  assert.ok(C.listCharacters(packs).some((e) => e.id === 'dafeiyu-clips'));
});

test('catalog: an old choice of a look that no longer ships is kept; she is her default until it is downloaded, then becomes it', async () => {
  const packs = shippedOnly();
  // pre-T-2764 data that wore 大肥鱼 · Live2D, on an install where it is not downloaded
  const { mk, read } = svcOn({ settings: { ...OLD_SETTINGS, appearance: { dafeiyu: 'dafeiyu-live2d' }, visitors: ['claude'] }, pet: OLD_PET, packs });
  const svc = mk();
  const v = svc.init();
  assert.equal(JSON.parse(read('pet.json')).characterId, 'dafeiyu-live2d', 'the choice is kept');
  assert.equal(v.pet.characterId, 'dafeiyu-pixel', 'shown as her default meanwhile');
  assert.equal(v.pet.agentId, 'agt_dafeiyu', 'same girl: agent, affection and chat are hers');
  assert.equal(v.pet.affection, 30);
  assert.deepEqual(v.pendingDownload, { id: 'dafeiyu-live2d', name: '大肥鱼 · Live2D', sizeLabel: Catalog.sizeLabel(Catalog.entry('dafeiyu-live2d').bytes) });
  assert.ok(!v.characters.some((c) => c.id === 'dafeiyu-live2d'), 'not a character before it is downloaded');
  assert.ok(svc.catalogList().some((c) => c.id === 'dafeiyu-live2d'));
  assert.ok(Object.hasOwn(JSON.parse(read('settings.json')).framings, 'dafeiyu-live2d'), 'her 取景 waits for her too');
  // switching to a look not downloaded is refused with that reason
  assert.deepEqual(await svc.switchCharacter('claude-classic'), { ok: false, reason: 'not-downloaded', name: '克洛蒂 · 旧版像素' });
  assert.equal((await svc.switchCharacter('claude-adult')).reason, 'not-downloaded', 'adult content is on in OLD_SETTINGS: only the download is missing');
  // downloaded (the pack store reloads): she becomes the look she chose, the notice goes
  svc.setPacks(builtin());
  assert.equal(svc.view().pet.characterId, 'dafeiyu-live2d');
  assert.equal(svc.view().pendingDownload, null);
  assert.ok(!svc.catalogList().some((c) => c.id === 'dafeiyu-live2d'));
  // removed again (删除下载): back to her default, the choice kept for the next download
  svc.setPacks(shippedOnly());
  assert.equal(svc.view().pet.characterId, 'dafeiyu-pixel');
  assert.equal(svc.view().pendingDownload.id, 'dafeiyu-live2d');
  // choosing her default herself ends the wait
  assert.equal((await svc.switchCharacter('dafeiyu-pixel')).ok, true);
  assert.equal(svc.view().pendingDownload, null);
  assert.equal(JSON.parse(read('pet.json')).characterId, 'dafeiyu-pixel');
});
