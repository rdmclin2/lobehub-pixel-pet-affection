'use strict';
// 通用男女语音包 (core/voice-pack.js kind "generic", core/voice-gender.js, docs/voice-packs.md): the manifest,
// a character's gender, which pack she resolves to (the owner's pick > her own > the generic pack of her
// gender), the voice a generic pack lends to a character without one, and the per-character pick in settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VP = require('../src/core/voice-pack');
const Gender = require('../src/core/voice-gender');
const tts = require('../src/core/tts');
const settingsLib = require('../src/core/settings');
const S = require('../src/core/species');
const P = require('../src/core/packs');
const G = require('../src/core/generic');
const touchZones = require('../src/core/touch-zones');
const IVoice = require('../src/core/interaction-voice');
const Voice = require('../src/core/voice');
const { importVrm } = require('../src/core/vrm-import');
const { makeTestVrm } = require('../scripts/make-test-vrm');

const BUILTIN = path.join(__dirname, '..', 'src', 'voicepacks');
const tmp = (p = 'pp-gvp-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
function makePack(root, name, manifest, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
const GM = (over = {}) => ({ format: 1, kind: 'generic', gender: 'male', id: 'generic-male', name: '通用男声', engine: 'minimax', voiceId: 'male-qn-qingse', model: 'speech-2.8-turbo', params: { speed: 1, pitch: 0, vol: 1, emotion: 'happy' }, lines: {}, ...over });
const keysWith = (k) => ({ has: (id) => !!k[id], get: (id) => k[id] || '', all: () => Object.values(k) });
// a character with no voice.tts and no gender: what a new imported model looks like to the voice code
const bare = (id, over = {}) => ({ id, nameZh: id, voice: { lang: 'zh-CN' }, ...over });

// What the five built-in characters resolved to before generic packs existed (VoicePacks#packFor on canary e7a1b6c).
const BEFORE = {
  dafeiyu: { id: 'dafeiyu-minimax', voiceId: 'qiaopi_mengmei', lines: 224 },
  claude: { id: 'claude-minimax', voiceId: 'Chinese (Mandarin)_Soft_Girl', lines: 219 },
  grok: { id: 'grok-minimax', voiceId: 'female-shaonv', lines: 220 },
  gemini: { id: 'gemini-minimax', voiceId: 'Chinese (Mandarin)_Crisp_Girl', lines: 223 },
  gpt: { id: 'gpt-minimax', voiceId: 'Chinese (Mandarin)_Warm_Girl', lines: 230 },
};

// ---- manifest ---------------------------------------------------------------------------------------
test('validateManifest: a generic pack needs gender, engine and voiceId and no character; old packs stay valid', () => {
  assert.deepEqual(VP.validateManifest(GM()), []);
  assert.deepEqual(VP.validateManifest(GM({ gender: 'female', id: 'generic-female', voiceId: 'female-tianmei' })), []);
  assert.match(VP.validateManifest(GM({ gender: undefined })).join(), /gender is required/);
  assert.match(VP.validateManifest(GM({ gender: 'robot' })).join(), /gender is required/);
  assert.match(VP.validateManifest(GM({ character: 'dafeiyu' })).join(), /belongs to no character/);
  assert.match(VP.validateManifest(GM({ engine: undefined })).join(), /engine is required/);
  assert.match(VP.validateManifest(GM({ engine: 'local' })).join(), /engine is required/);
  assert.match(VP.validateManifest(GM({ voiceId: '' })).join(), /voiceId is required/);
  assert.match(VP.validateManifest(GM({ voiceId: 'bad/voice!' })).join(), /engine voice: voice\.tts\.minimax\.voiceId/);
  assert.match(VP.validateManifest(GM({ params: { speed: 9 } })).join(), /speed must be a number from 0.5 to 2/);
  assert.match(VP.validateManifest(GM({ kind: 'other' })).join(), /kind must be one of character, generic/);
  assert.match(VP.validateManifest(GM({ id: 'auto' })).join(), /reserved/);
  // the old (character) shape: no kind, character required, gender optional
  const old = { format: 1, id: 'dafeiyu-minimax', name: '大肥鱼', character: 'dafeiyu', engine: 'minimax', voiceId: 'qiaopi_mengmei', lines: {} };
  assert.deepEqual(VP.validateManifest(old), []);
  assert.deepEqual(VP.validateManifest({ ...old, kind: 'character' }), []);
  assert.match(VP.validateManifest({ ...old, character: undefined }).join(), /character is required/);
  assert.match(VP.validateManifest({ ...old, gender: 'x' }).join(), /gender must be one of female, male/);
});

test('the built-in packs: five character packs as before plus generic-male and generic-female, all valid', () => {
  const packs = new VP.VoicePacks([BUILTIN]);
  assert.deepEqual(packs.errors, []);
  assert.deepEqual(packs.list().map((p) => [p.id, p.kind, p.gender, p.character]), [
    ...Object.keys(BEFORE).sort().map((c) => [BEFORE[c].id, 'character', null, c]),
    ['generic-female', 'generic', 'female', null],
    ['generic-male', 'generic', 'male', null],
  ]);
  for (const g of Gender.GENDERS) {
    const p = packs.genericFor(g);
    assert.equal(p.id, `generic-${g}`);
    assert.equal(p.engine, 'minimax');
    assert.equal(p.kind, 'generic');
    const m = JSON.parse(fs.readFileSync(path.join(BUILTIN, `generic-${g}`, 'manifest.json'), 'utf8'));
    // lines still to be recorded (no MiniMax key on the build machine): exactly the generic line set
    assert.deepEqual([...Object.keys(m.lines), ...(m.pending || [])].sort(), VP.genericPackLines().sort());
  }
  assert.equal(packs.genericFor('male').voiceId, 'male-qn-qingse');
  assert.equal(packs.genericFor('female').voiceId, 'female-tianmei');
});

test('VoicePacks indexes both kinds; the owner\'s generic pack replaces the built-in one of that gender', () => {
  const builtIn = tmp();
  const mine = tmp();
  makePack(builtIn, 'gm', GM({ lines: { '接住啦！': 'a.ogg' } }), { 'a.ogg': 'BUILTIN-MALE' });
  makePack(builtIn, 'dafeiyu', { format: 1, id: 'dafeiyu-minimax', name: '大肥鱼', character: 'dafeiyu', engine: 'minimax', voiceId: 'qiaopi_mengmei', lines: { '接住啦！': 'b.ogg' } }, { 'b.ogg': 'FISH' });
  let packs = new VP.VoicePacks([builtIn, mine]);
  assert.equal(packs.packFor('dafeiyu').id, 'dafeiyu-minimax');
  assert.equal(packs.genericFor('male').id, 'generic-male');
  assert.equal(packs.genericFor('female'), null);
  assert.equal(packs.get('generic-male').kind, 'generic');
  assert.equal(packs.get('nope'), null);
  assert.equal(packs.get('__proto__'), null);
  assert.equal(packs.lookupIn(packs.genericFor('male'), ' 接住啦！ ').audio.toString(), 'BUILTIN-MALE');
  assert.equal(packs.lookup('dafeiyu', '接住啦！').audio.toString(), 'FISH', 'her own pack, as before');
  assert.equal(packs.lookup('generic-male', '接住啦！'), null, 'lookup() is only ever a character\'s own pack');
  makePack(mine, 'my-male', GM({ id: 'my-male', name: '我的男声', lines: { '接住啦！': 'c.ogg' } }), { 'c.ogg': 'MINE' });
  packs = new VP.VoicePacks([builtIn, mine]);
  assert.equal(packs.genericFor('male').id, 'my-male');
  assert.deepEqual(packs.list().map((p) => [p.id, p.kind, p.gender, p.builtIn]), [['dafeiyu-minimax', 'character', null, true], ['my-male', 'generic', 'male', false]]);
});

test('genericPackLines: app, stage, touch and drag lines any companion says — never a character\'s own', () => {
  const lines = VP.genericPackLines();
  assert.ok(lines.length > 100, String(lines.length));
  assert.equal(new Set(lines).size, lines.length);
  for (const l of VP.APP_LINES) assert.ok(lines.includes(l), l);
  for (const l of IVoice.DEFAULT_LINES.catch) assert.ok(lines.includes(Voice.speakable(l)), l);
  const anyTouch = Object.values(touchZones.DEFAULT_LINES).flatMap((x) => (Array.isArray(x) ? x : Object.values(x).flat())).find((x) => typeof x === 'string');
  if (anyTouch) assert.ok(lines.includes(VP.norm(Voice.speakable(anyTouch))) || Voice.sentences(anyTouch).some((p) => lines.includes(VP.norm(p.say))), anyTouch);
  for (const id of S.SPECIES_IDS) {
    const sp = S.SPECIES[id];
    for (const own of [sp.catchphrase, ...sp.fallback.greet]) assert.equal(lines.includes(VP.norm(Voice.speakable(own))), false, `${id}: ${own}`);
    assert.equal(lines.some((l) => l.includes(sp.nameZh)), false, sp.nameZh);
  }
});

// ---- gender -----------------------------------------------------------------------------------------
test('genderOf: character file > pack.json gender > vrm.style > the model\'s body > female', () => {
  const male = { gender: 'male' };
  assert.deepEqual(Gender.genderOf({ gender: 'male' }), { gender: 'male', source: 'character' });
  assert.deepEqual(Gender.genderOf({ voice: { gender: 'male' } }), { gender: 'male', source: 'character' });
  assert.deepEqual(Gender.genderOf({ gender: 'female' }, male), { gender: 'female', source: 'character' }, 'her file wins over her pack');
  assert.deepEqual(Gender.genderOf({}, male), { gender: 'male', source: 'pack' });
  assert.deepEqual(Gender.genderOf({}, { voice: { gender: 'male' } }), { gender: 'male', source: 'pack' });
  assert.deepEqual(Gender.genderOf({}, { gender: 'female', vrm: { style: { base: 'male', overrides: {} } } }), { gender: 'female', source: 'pack' }, 'pack gender beats its motion style');
  assert.deepEqual(Gender.genderOf({}, { vrm: { style: { base: 'male', overrides: {} } } }), { gender: 'male', source: 'style' });
  assert.deepEqual(Gender.genderOf({}, { vrm: { style: 'male' } }), { gender: 'male', source: 'style' });
  const body = (b) => ({ outfits: { daily: 'models/a.vrm' }, vrm: { style: null, models: { 'models/a.vrm': { body: b } } } });
  assert.deepEqual(Gender.genderOf({}, body({ bustSpring: 2, shoulderHip: 1.2 })), { gender: 'female', source: 'model' });
  assert.deepEqual(Gender.genderOf({}, body({ bustSpring: 0, shoulderHip: 1.7 })), { gender: 'male', source: 'model' });
  // neutral says nothing about the voice: on to the default
  assert.deepEqual(Gender.genderOf({}, body({ bustSpring: 0, shoulderHip: 1.2 })), { gender: 'female', source: 'default' });
  assert.deepEqual(Gender.genderOf({}, { vrm: { style: { base: 'neutral', overrides: {} } } }), { gender: 'female', source: 'default' });
  assert.deepEqual(Gender.genderOf(null, null), { gender: Gender.DEFAULT_GENDER, source: 'default' });
  assert.equal(Gender.DEFAULT_GENDER, 'female');
});

test('gender is checked in character files, voice and pack.json', () => {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', 'dafeiyu.json'), 'utf8'));
  assert.deepEqual(S.validateCharacter(c), []);
  assert.equal(c.gender, 'female');
  assert.match(S.validateCharacter({ ...c, gender: 'robot' }).join(), /gender must be one of female, male/);
  assert.match(S.validateCharacter({ ...c, voice: { ...c.voice, gender: 'x' } }).join(), /voice\.gender must be one of female, male/);
  assert.deepEqual(S.validateCharacter({ ...c, gender: undefined }), [], 'optional');
  for (const id of S.SPECIES_IDS) assert.deepEqual(Gender.genderOf(S.SPECIES[id]), { gender: 'female', source: 'character' }, id);
  const errs = (m) => { const r = P.validatePack(m, tmp()); return r.ok ? [] : r.errors; };
  assert.match(errs({ gender: 'robot' }).join(), /gender must be one of female, male/);
  assert.match(errs({ voice: { gender: 'x' } }).join(), /voice\.gender must be one of female, male/);
  assert.match(errs({ voice: { tts: {} } }).join(), /voice must be \{ "gender"/);
  assert.equal(errs({ gender: 'male' }).some((e) => /gender/.test(e)), false);
});

// ---- resolution -------------------------------------------------------------------------------------
test('resolvePack: the owner\'s pick > her own pack > the generic pack of her gender', () => {
  const packs = new VP.VoicePacks([BUILTIN]);
  // a new imported model with no pack of her own
  assert.equal(VP.resolvePack({ characterId: 'vrmxabcdefghijkl', gender: 'male' }, packs).pack.id, 'generic-male');
  assert.equal(VP.resolvePack({ characterId: 'vrmxabcdefghijkl', gender: 'female' }, packs).pack.id, 'generic-female');
  assert.equal(VP.resolvePack({ characterId: 'vrmxabcdefghijkl' }, packs).pack.id, 'generic-female', 'no gender: the default');
  assert.equal(VP.resolvePack({ characterId: 'vrmxabcdefghijkl', gender: 'male' }, packs).source, 'generic');
  // her own pack beats the generic one, whatever her gender
  const own = VP.resolvePack({ characterId: 'dafeiyu', gender: 'male', choice: 'auto' }, packs);
  assert.deepEqual([own.pack.id, own.source, own.choice], ['dafeiyu-minimax', 'own', 'auto']);
  // the owner's pick beats both
  const picked = VP.resolvePack({ characterId: 'dafeiyu', gender: 'female', choice: 'generic-male' }, packs);
  assert.deepEqual([picked.pack.id, picked.source, picked.choice], ['generic-male', 'user', 'generic-male']);
  assert.equal(VP.resolvePack({ characterId: 'vrmxabcdefghijkl', gender: 'male', choice: 'claude-minimax' }, packs).pack.id, 'claude-minimax', 'any pack may be picked');
  // a pick whose pack is gone: as auto, and says which
  const gone = VP.resolvePack({ characterId: 'gpt', gender: 'female', choice: 'deleted-pack' }, packs);
  assert.deepEqual([gone.pack.id, gone.source, gone.missing], ['gpt-minimax', 'own', 'deleted-pack']);
  assert.deepEqual(VP.resolvePack({ characterId: 'x' }, new VP.VoicePacks([])), { pack: null, source: null, choice: 'auto', missing: null });
});

test('the five built-in characters resolve exactly as before (own pack, own voice, same recorded lines)', () => {
  const packs = new VP.VoicePacks([BUILTIN]);
  for (const [id, before] of Object.entries(BEFORE)) {
    const sp = S.SPECIES[id];
    const r = VP.resolvePack({ characterId: id, gender: Gender.genderOf(sp).gender, choice: 'auto' }, packs);
    assert.deepEqual([r.pack.id, r.source, r.pack.voiceId, r.pack.lines.size], [before.id, 'own', before.voiceId, before.lines], id);
    assert.equal(r.pack, packs.packFor(id), 'the same pack packFor gave');
    assert.equal(VP.voiceForPack(sp, r), sp, `${id}: her engine voice is untouched`);
    const line = [...r.pack.lines.keys()][0];
    assert.deepEqual(packs.lookupIn(r.pack, line).audio, packs.lookup(id, line).audio);
  }
});

test('voiceForPack: a character without voice.tts reads with her generic pack\'s voice; one with her own keeps hers', () => {
  const packs = new VP.VoicePacks([BUILTIN]);
  const him = bare('vrmxmaleaaaaaaaa', { gender: 'male' });
  const r = VP.resolvePack({ characterId: him.id, gender: 'male' }, packs);
  const voiced = VP.voiceForPack(him, r);
  assert.deepEqual(voiced.voice.tts, { default: 'minimax', minimax: { speed: 1, pitch: 0, vol: 1, emotion: 'happy', voiceId: 'male-qn-qingse', model: 'speech-2.8-turbo' } });
  assert.equal(voiced.voice.lang, 'zh-CN', 'the rest of her voice stays');
  assert.equal(him.voice.tts, undefined, 'pure: her species is not changed');
  assert.equal(tts.voiceFor(voiced, 'minimax').voiceId, 'male-qn-qingse');
  const her = bare('vrmxfemaleaaaaaa');
  assert.equal(tts.voiceFor(VP.voiceForPack(her, VP.resolvePack({ characterId: her.id, gender: 'female' }, packs)), 'minimax').voiceId, 'female-tianmei');
  // a character with her own voice falling back to a generic pack (no own pack): her voice stays
  const own = bare('vrmxownvoiceaaaa', { voice: { tts: { minimax: { voiceId: 'female-yujie' } } } });
  assert.equal(VP.voiceForPack(own, VP.resolvePack({ characterId: own.id, gender: 'female' }, packs)), own);
  // the owner picked another pack for her: its voice comes along, so recorded and synthesised lines match
  const dafeiyu = S.SPECIES.dafeiyu;
  const pick = VP.voiceForPack(dafeiyu, VP.resolvePack({ characterId: 'dafeiyu', choice: 'generic-male' }, packs));
  assert.equal(tts.voiceFor(pick, 'minimax').voiceId, 'male-qn-qingse');
  assert.equal(tts.defaultEngine(pick), 'minimax');
  assert.equal(VP.voiceForPack(dafeiyu, VP.resolvePack({ characterId: 'dafeiyu', choice: 'dafeiyu-minimax' }, packs)), dafeiyu, 'her own pack picked: unchanged');
  assert.deepEqual(VP.packVoiceTts({ engine: 'fish', voiceId: 'a'.repeat(32) }), { default: 'fish', fish: { referenceId: 'a'.repeat(32) } });
  assert.equal(VP.packVoiceTts({ engine: null, voiceId: 'x' }), null);
});

test('engine: a new male model without a voice is synthesised in the generic male voice; a generic pack line plays from disk', async () => {
  const root = tmp();
  makePack(root, 'gm', GM({ lines: { '接住啦！': 'a.ogg' } }), { 'a.ogg': 'OGG-MALE' });
  const packs = new VP.VoicePacks([root]);
  const him = bare('vrmxmalebbbbbbbb', { gender: 'male' });
  const r = VP.resolvePack({ characterId: him.id, gender: Gender.genderOf(him).gender }, packs);
  const voiced = VP.voiceForPack(him, r);
  const sent = [];
  const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, headers: new Map(), json: async () => ({ base_resp: { status_code: 0 }, data: { audio: 'abcd' } }) }; };
  const engine = new tts.TtsEngine({ keys: keysWith({ minimax: 'mm-key-000000' }), fetch });
  const set = { provider: 'auto' };
  assert.equal(engine.firstUsable(him, set), null, 'before: no voice of his own on any engine');
  assert.equal(engine.firstUsable(voiced, set), 'minimax');
  assert.equal(VP.packApplies(set, r.pack, engine.firstUsable(voiced, set)), true);
  assert.equal(packs.lookupIn(r.pack, '接住啦！').audio.toString(), 'OGG-MALE');
  const out = await engine.synthesize({ text: '这是一条 agent 回复。', species: voiced, mood: '' }, set);
  assert.equal(out.ok, true);
  assert.equal(out.provider, 'minimax');
  assert.equal(sent[0].voice_setting.voice_id, 'male-qn-qingse');
});

test('an imported VRM (通用设定) gets her gender from pack.json, else vrm.style, else her model, and so generic-male / generic-female', async () => {
  const packs = new VP.VoicePacks([BUILTIN]);
  const userDir = tmp('pp-gvp-packs-');
  const ids = {};
  for (const [name, edit] of [['Kaito Test', (m) => { m.vrm.style = 'male'; }], ['Mika Test', (m) => { m.gender = 'female'; m.vrm.style = 'male'; }], ['Plain Test', () => {}]]) {
    const src = path.join(tmp('pp-gvp-src-'), `${name}.vrm`);
    fs.writeFileSync(src, makeTestVrm({ name }));
    const r = await importVrm({ src, speciesId: G.GENERIC_BASE, userDir });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    const file = path.join(r.pack.dir, 'pack.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    edit(m);
    fs.writeFileSync(file, JSON.stringify(m));
    ids[name] = r.pack.id;
  }
  const loaded = P.loadPacks([{ dir: userDir, source: 'user' }]);
  assert.deepEqual(loaded.problems, []);
  const resolved = Object.fromEntries(Object.entries(ids).map(([name, id]) => {
    const pack = loaded.packs.get(id);
    const sp = S.SPECIES[pack.species];
    assert.ok(G.isGenericBase(sp.id));
    const g = Gender.genderOf(sp, pack);
    const r = VP.resolvePack({ characterId: sp.id, gender: g.gender }, packs);
    return [name, [g.gender, g.source, r.pack.id, r.source]];
  }));
  assert.deepEqual(resolved, {
    'Kaito Test': ['male', 'style', 'generic-male', 'generic'],
    'Mika Test': ['female', 'pack', 'generic-female', 'generic'],
    // nothing in pack.json: the guess from the model (the test model has broad shoulders, shoulderHip ≥ 1.5)
    'Plain Test': ['male', 'model', 'generic-male', 'generic'],
  });
  for (const id of Object.values(ids)) S.unregisterCharacter(loaded.packs.get(id).species);
});

// ---- settings ---------------------------------------------------------------------------------------
test('settings.tts.voicePackByCharacter: {} by default and for old files; bad entries and auto are dropped', () => {
  assert.deepEqual(settingsLib.normalizeSettings(null).tts.voicePackByCharacter, {});
  assert.deepEqual(settingsLib.normalizeSettings({ tts: { provider: 'fish', providerSet: true } }).tts.voicePackByCharacter, {}, 'a file from before has none');
  assert.deepEqual(tts.normalizeVoicePackPicks({ dafeiyu: 'generic-male', vrmxabcdefghijkl: 'generic-female', gpt: 'auto', Bad: 'generic-male', claude: 'Bad Id', grok: 3, gemini: '' }), { dafeiyu: 'generic-male', vrmxabcdefghijkl: 'generic-female' });
  assert.deepEqual(tts.normalizeVoicePackPicks(['x']), {});
  assert.deepEqual(tts.normalizeVoicePackPicks('x'), {});
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`c${String(i).padStart(3, '0')}`, 'generic-male']));
  assert.equal(Object.keys(tts.normalizeVoicePackPicks(many)).length, tts.VOICE_PACK_PICKS);
  const schema = require('../src/core/settings-schema');
  assert.ok(schema.settingsLeaves().includes('tts.voicePackByCharacter.<id>'));
  assert.equal(schema.field('tts.voicePackByCharacter.<id>').type, 'perCharacter');
});

test('PetService.setTts merges one character\'s pick, \'auto\' removes it, and it survives a restart', () => {
  const { PetService } = require('../src/main/pet-service');
  const dir = tmp('pp-gvp-settings-');
  const store = new settingsLib.SettingsStore(dir);
  const svc = new PetService({ lh: null, store: null, settingsStore: store, ttsStatus: () => ({ engines: {} }) });
  svc.setTts({ provider: 'minimax' });
  svc.setTts({ voicePackByCharacter: { dafeiyu: 'generic-male' } });
  svc.setTts({ voicePackByCharacter: { vrmxabcdefghijkl: 'generic-female' } });
  assert.deepEqual(store.load().tts.voicePackByCharacter, { dafeiyu: 'generic-male', vrmxabcdefghijkl: 'generic-female' });
  assert.equal(store.load().tts.provider, 'minimax', 'the rest of tts is kept');
  svc.setTts({ fallback: 'silent' });
  assert.deepEqual(store.load().tts.voicePackByCharacter, { dafeiyu: 'generic-male', vrmxabcdefghijkl: 'generic-female' }, 'another tts change keeps the picks');
  svc.setTts({ voicePackByCharacter: { dafeiyu: 'auto', gpt: 'Not An Id' } });
  assert.deepEqual(store.load().tts.voicePackByCharacter, { vrmxabcdefghijkl: 'generic-female' });
  const again = new PetService({ lh: null, store: null, settingsStore: new settingsLib.SettingsStore(dir), ttsStatus: () => ({ engines: {} }) });
  assert.deepEqual(again.settings.tts.voicePackByCharacter, { vrmxabcdefghijkl: 'generic-female' }, 'read back from settings.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).tts.voicePackByCharacter, { vrmxabcdefghijkl: 'generic-female' });
});

// ---- 管理台角色语音包切换 (T-4272): the roster rows show the pack in force and what can be picked
test('roster voicePackFor / voicePackPick: the pack in force with its label and source, the picker grouped', () => {
  const { voicePackFor, voicePackPick, buildRoster } = require('../src/core/roster');
  const packs = [
    { id: 'dafeiyu-minimax', name: '大肥鱼语音', kind: 'character', character: 'dafeiyu', engine: 'minimax', lines: 150, builtIn: true, credit: 'MiniMax' },
    { id: 'claude-minimax', name: '克洛蒂语音', kind: 'character', character: 'claude', engine: 'minimax', lines: 219, builtIn: true, credit: '' },
    { id: 'generic-female', name: '通用女声', kind: 'generic', gender: 'female', character: null, engine: 'minimax', lines: 0, builtIn: true },
    { id: 'generic-male', name: '通用男声（我的）', kind: 'generic', gender: 'male', character: null, engine: 'minimax', lines: 3, builtIn: false },
  ];
  const st = (pack, source, choice = 'auto', extra = {}) => ({ characterId: 'x', choice, missing: null, source, gender: 'male', genderSource: 'pack', pack: { id: pack.id, name: pack.name, kind: pack.kind, gender: pack.gender || null, character: pack.character, engine: pack.engine, lines: pack.lines }, engineVoice: { engine: 'minimax', voiceId: 'male-qn-qingse', fromPack: true }, ...extra });
  // no app (tests / before the first hatch): her own pack, auto
  assert.equal(voicePackFor('dafeiyu', packs).label, '专属');
  assert.equal(voicePackFor('vrmxabcdefghijkl', packs), null, 'a generic pack is never "her own"');
  // 自动回退 to the generic male pack: label 通用·男, source generic, the owner's pack (builtIn false) with its credit fields
  const g = voicePackFor('vrmxabcdefghijkl', packs, st(packs[3], 'generic'));
  assert.deepEqual([g.id, g.label, g.source, g.sourceLabel, g.builtIn, g.lines], ['generic-male', '通用·男', 'generic', '自动回退', false, 3]);
  // picked by the owner: generic female for 大肥鱼, another character's own pack
  assert.deepEqual(['label', 'source', 'sourceLabel'].map((k) => voicePackFor('dafeiyu', packs, st(packs[2], 'user', 'generic-female'))[k]), ['通用·女', 'user', '手动指定']);
  assert.equal(voicePackFor('dafeiyu', packs, st(packs[1], 'user', 'claude-minimax')).label, '克洛蒂 的专属');
  // the picker: her own first, then 通用·男, 通用·女, then the others
  const pick = voicePackPick('dafeiyu', packs, st(packs[2], 'user', 'generic-female'));
  assert.deepEqual(pick.options.map((o) => [o.id, o.group]), [['dafeiyu-minimax', 'own'], ['generic-male', 'generic'], ['generic-female', 'generic'], ['claude-minimax', 'other']]);
  assert.deepEqual([pick.choice, pick.gender, pick.engineVoice.voiceId], ['generic-female', 'male', 'male-qn-qingse']);
  assert.equal(voicePackPick('dafeiyu', packs).choice, 'auto');
  // buildRoster asks main for each base's state (voicePack option)
  const asked = [];
  const rows = buildRoster(null, { ttsStatus: { packs } }, { voicePack: (base) => { asked.push(base); return base === 'dafeiyu' ? st(packs[3], 'user', 'generic-male') : null; } });
  const fish = rows.find((r) => r.base === 'dafeiyu');
  assert.deepEqual([fish.voicePack.id, fish.voicePack.label, fish.voicePackPick.choice], ['generic-male', '通用·男', 'generic-male']);
  assert.ok(asked.includes('dafeiyu') && asked.includes('claude'));
  assert.equal(rows.find((r) => r.base === 'claude').voicePack.label, '专属', 'no state: her own, as before');
});
