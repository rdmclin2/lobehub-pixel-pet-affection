'use strict';
// 风格语音包 (core/voice-pack.js kind "style", core/voice-styles.js, core/catalog.js loadVoiceIndex, docs/voice-packs.md §6):
// the manifest, how VoicePacks loads one next to the character / generic packs (never picked automatically),
// and the store index scripts/build-voice-catalog.js writes from the recorded packs in catalog/voicepacks/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const VP = require('../src/core/voice-pack');
const VS = require('../src/core/voice-styles');
const tts = require('../src/core/tts');
const Catalog = require('../src/core/catalog');

const ROOT = path.join(__dirname, '..');
const BUILTIN = path.join(ROOT, 'src', 'voicepacks');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-svp-'));
function makePack(root, name, manifest, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
const LINE = '好累……让我睡一会儿。';
const SM = (over = {}) => ({
  format: 1, kind: 'style', style: 'cute', id: 'style-cute', name: '可爱 · 甜心少女', gender: 'female', version: '1.0.0',
  engine: 'minimax', voiceId: 'tianxin_xiaoling', model: 'speech-2.8-turbo', params: { speed: 1.05, pitch: 1, vol: 1, emotion: 'happy' },
  credit: '语音由 AI 合成：MiniMax 甜心小玲（tianxin_xiaoling）', lineSet: 'generic',
  sample: { text: '嗨嗨～我是可爱语音！', file: 's.ogg' }, lines: { [LINE]: 'a.ogg' }, ...over,
});
const FILES = { 's.ogg': 'sample', 'a.ogg': 'line' };

test('style manifest: a valid one passes, with its files on disk', () => {
  const dir = makePack(tmp(), 'style-cute', SM(), FILES);
  assert.deepEqual(VP.validateManifest(SM(), dir), []);
  assert.ok(VP.KINDS.includes('style'));
});

test('style manifest: style, version, lineSet, sample, gender and a voice are required; no character', () => {
  const errs = (over) => VP.validateManifest(SM(over)).join(' | ');
  assert.match(errs({ style: undefined }), /style is required/);
  assert.match(errs({ style: 'Cute!' }), /style is required/);
  assert.match(errs({ version: '1.0' }), /version is required/);
  assert.match(errs({ lineSet: 'all' }), /lineSet is required/);
  assert.match(errs({ sample: undefined }), /sample is required/);
  assert.match(errs({ sample: { text: '', file: 's.ogg' } }), /sample is required/);
  assert.match(errs({ sample: { text: '嗨', file: '../x.ogg' } }), /sample is required/);
  assert.match(errs({ gender: undefined }), /gender is required for a style pack/);
  assert.match(errs({ character: 'dafeiyu' }), /style pack belongs to no character/);
  assert.match(errs({ engine: 'local' }), /engine is required for a style pack/);
  assert.match(errs({ voiceId: '' }), /voiceId is required for a style pack/);
  assert.match(errs({ params: { speed: 9 } }), /engine voice: .*speed/);
  // lineSet "character": the lines of named characters
  assert.match(errs({ lineSet: 'character' }), /appliesTo must list/);
  assert.deepEqual(VP.validateManifest(SM({ lineSet: 'character', appliesTo: ['dafeiyu'] })), []);
  assert.match(errs({ appliesTo: ['dafeiyu'] }), /appliesTo is only for lineSet "character"/);
  // a missing sample file on disk
  const dir = makePack(tmp(), 'style-cute', SM(), { 'a.ogg': 'x' });
  assert.match(VP.validateManifest(SM(), dir).join(' '), /sample: missing file s\.ogg/);
});

test('compatibility: format stays 1; character and generic manifests (and the built-in packs) validate as before', () => {
  assert.equal(VP.FORMAT, 1);
  assert.deepEqual(VP.validateManifest({ format: 1, id: 'x-minimax', name: 'x', character: 'dafeiyu', lines: { [LINE]: 'a.ogg' } }), []);
  // the style-only fields mean nothing on the other kinds
  assert.deepEqual(VP.validateManifest({ format: 1, kind: 'generic', gender: 'male', id: 'generic-male', name: 'g', engine: 'minimax', voiceId: 'male-qn-qingse', lines: {} }), []);
  assert.match(VP.validateManifest(SM({ format: 2 })).join(' '), /format must be 1/);
  const packs = new VP.VoicePacks([BUILTIN]);
  assert.deepEqual(packs.errors, []);
  assert.ok(packs.list().every((p) => p.kind !== 'style'), 'no style pack is built in');
});

test('VoicePacks: a style pack loads by id only — never her own, never the generic pack of its gender', () => {
  const user = tmp();
  makePack(user, 'style-cute', SM(), FILES);
  const packs = new VP.VoicePacks([BUILTIN, user]);
  assert.deepEqual(packs.errors, []);
  const p = packs.get('style-cute');
  assert.equal(p.kind, 'style');
  assert.equal(p.character, null);
  assert.equal(packs.genericFor('female').id, 'generic-female', 'the built-in generic pack still answers for her gender');
  const row = packs.list().find((x) => x.id === 'style-cute');
  assert.equal(row.kind, 'style');
  assert.equal(row.style, 'cute');
  assert.equal(row.version, '1.0.0');
  assert.equal(row.sample, '嗨嗨～我是可爱语音！');
  assert.equal(packs.list().at(-1).id, 'style-cute', 'style packs are listed last');
  // auto: a character without a pick never lands on a style pack
  assert.notEqual(VP.resolvePack({ characterId: 'nobody', gender: 'female' }, packs).pack.id, 'style-cute');
  // picked for her: lines from the pack, engine voice from the pack
  const r = VP.resolvePack({ characterId: 'dafeiyu', gender: 'female', choice: 'style-cute' }, packs);
  assert.equal(r.source, 'user');
  assert.equal(packs.lookupIn(r.pack, LINE).packId, 'style-cute');
  const sp = VP.voiceForPack({ id: 'dafeiyu', voice: { tts: { minimax: { voiceId: 'qiaopi_mengmei' } } } }, r);
  assert.equal(sp.voice.tts.minimax.voiceId, 'tianxin_xiaoling');
  // 我的语音包 may be a style pack too
  assert.equal(VP.resolvePack({ characterId: 'claude', gender: 'female', userChoice: 'style-cute' }, packs).source, 'default');
  // the 试听 line
  const s = packs.sample('style-cute');
  assert.equal(s.text, '嗨嗨～我是可爱语音！');
  assert.equal(s.mime, 'audio/ogg');
  assert.equal(s.audio.toString(), 'sample');
  assert.equal(packs.sample('generic-male'), null);
});

test('voice-styles: at least 3 styles, distinct voices, each a valid MiniMax voice with its own 试听 line', () => {
  assert.ok(VS.STYLES.length >= 3);
  assert.equal(new Set(VS.STYLES.map((s) => s.voice.voiceId)).size, VS.STYLES.length);
  assert.equal(new Set(VS.STYLES.map((s) => s.style)).size, VS.STYLES.length);
  for (const s of VS.STYLES) {
    assert.equal(s.id, `style-${s.style}`);
    assert.ok(['female', 'male'].includes(s.gender));
    assert.deepEqual(tts.validateVoice({ tts: { minimax: { voiceId: s.voice.voiceId, model: s.voice.model, ...s.voice.params } } }), [], s.id);
    assert.ok(s.sample && s.label && s.name && s.description);
  }
});

test('store index (src/core/voice-catalog.json): ≥3 recorded style packs, each matching its folder in catalog/voicepacks', () => {
  const index = Catalog.loadVoiceIndex();
  assert.equal(index.release, 'voices-v1');
  assert.ok(index.voicePacks.length >= 3, `${index.voicePacks.length} packs`);
  const raw = JSON.parse(fs.readFileSync(Catalog.VOICE_INDEX_FILE, 'utf8'));
  assert.equal(index.voicePacks.length, raw.voicePacks.length, 'every entry passes the loader');
  assert.ok(new Set(index.voicePacks.map((v) => v.style)).size >= 3, 'at least 3 different styles');
  const genericLines = VP.genericPackLines();
  for (const v of index.voicePacks) {
    const dir = path.join(ROOT, 'catalog', 'voicepacks', v.id);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(VP.validateManifest(m, dir), [], v.id);
    assert.equal(m.pending, undefined, `${v.id}: every line recorded`);
    assert.deepEqual(Object.keys(m.lines).sort(), [...genericLines].sort(), `${v.id}: the whole 通用台词 set`);
    assert.equal(v.lines, genericLines.length);
    for (const k of ['style', 'name', 'gender', 'version', 'voiceId', 'model', 'engine']) assert.equal(v[k], m[k], `${v.id}.${k}`);
    assert.deepEqual(v.params, m.params);
    assert.match(v.sha256, /^[0-9a-f]{64}$/);
    assert.equal(v.file, `${v.id}.zip`);
    assert.ok(v.bytes > 100 * 1024, `${v.id}: ${v.bytes} bytes`);
    // the 试听 line ships with the app, the same audio as in the pack
    const sample = path.join(ROOT, 'src', 'renderer', v.sample.file);
    assert.equal(v.sample.text, m.sample.text);
    assert.equal(crypto.createHash('sha1').update(fs.readFileSync(sample)).digest('hex'), crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, m.sample.file))).digest('hex'));
    // where the app will download it from
    assert.equal(Catalog.downloadUrl(v, {}, {}), `${Catalog.CDN_ORIGIN}/${Catalog.UPLOAD_PREFIX_ROOT}/voices-v1/${v.file}`);
    assert.equal(Catalog.downloadUrl(v, {}, { PIXELPET_CATALOG_URL: 'file:///mirror/' }), `file:///mirror/${v.file}`);
    assert.equal(Catalog.voicePackEntry(v.id), v);
  }
  // a recorded pack loads as an owner's pack would after download
  const packs = new VP.VoicePacks([BUILTIN, path.join(ROOT, 'catalog', 'voicepacks')]);
  assert.deepEqual(packs.errors, []);
  for (const v of index.voicePacks) assert.equal(packs.get(v.id).kind, 'style');
  const rows = Catalog.listVoicePacks((id) => id === index.voicePacks[0].id);
  assert.equal(rows[0].installed, true);
  assert.equal(rows[1].installed, false);
  assert.match(rows[0].sizeLabel, /KB|MB/);
});

test('store index loader drops a broken entry', () => {
  const dir = tmp();
  const file = path.join(dir, 'v.json');
  const good = { id: 'style-x', type: 'voice-pack', name: 'x', style: 'x', file: 'style-x.zip', sha256: 'a'.repeat(64), bytes: 10, lines: 3, sample: { text: 't', file: 'catalog/voices/style-x.ogg' } };
  fs.writeFileSync(file, JSON.stringify({ release: 'voices-v9', voicePacks: [good, { ...good, id: 'style-y', sha256: 'nope' }, { ...good, id: 'style-z', sample: null }] }));
  const index = Catalog.loadVoiceIndex(file);
  assert.deepEqual(index.voicePacks.map((v) => v.id), ['style-x']);
  assert.equal(index.voicePacks[0].release, 'voices-v9');
});
