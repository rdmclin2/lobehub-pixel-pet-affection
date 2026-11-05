'use strict';
// 按角色选择语音包 (T-5095): 不使用 / 内置（自动）/ 已下载的风格语音包 per character, saved in
// settings.tts.voicePackByCharacter, in force from her next line; the picked pack is looked up first, a line it has
// not recorded goes to the engine; a deleted pack falls back to 内置.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VP = require('../src/core/voice-pack');
const tts = require('../src/core/tts');
const settingsLib = require('../src/core/settings');
const roster = require('../src/core/roster');
const VoiceStore = require('../src/core/voice-store');

const BUILTIN = path.join(__dirname, '..', 'src', 'voicepacks');
const tmp = (p = 'pp-vps-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const LINE = '呃……肚子圆滚滚的，吃不下了。';
const ONLY_HERS = '大肥鱼的专属台词，风格包里没有。';
function stylePack(root, id, style, voiceId, body, { store = true } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.ogg'), body);
  fs.writeFileSync(path.join(dir, 's.ogg'), 'sample');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    format: 1, kind: 'style', style, id, name: `${style} 包`, gender: 'female', version: '1.0.0', engine: 'minimax', voiceId,
    model: 'speech-2.8-turbo', lineSet: 'generic', sample: { text: '试听', file: 's.ogg' }, lines: { [LINE]: 'a.ogg' },
  }));
  if (store) fs.writeFileSync(path.join(dir, '.catalog.json'), JSON.stringify({ id, sha256: 'x' }));
  return dir;
}
function setup() {
  const user = tmp();
  stylePack(user, 'style-cute', 'cute', 'tianxin_xiaoling', 'CUTE-AUDIO');
  stylePack(user, 'style-yujie', 'yujie', 'wumei_yujie', 'YUJIE-AUDIO');
  return { user, packs: new VoicePacksOf(user) };
}
class VoicePacksOf extends VP.VoicePacks { constructor(user) { super([BUILTIN, user]); } }
const resolve = (packs, choice, userChoice = 'auto') => VP.resolvePack({ characterId: 'dafeiyu', gender: 'female', choice, userChoice }, packs);

test('不使用 (none) is a reserved choice: no pack, nothing looked up; a pack may not take the id', () => {
  const { packs } = setup();
  const r = resolve(packs, VP.NONE);
  assert.deepEqual([r.pack, r.source, r.choice, r.missing], [null, 'none', 'none', null]);
  assert.equal(VP.packApplies({ provider: 'auto' }, r.pack, null, r.source), false);
  const r2 = resolve(packs, VP.NONE, 'generic-male');
  assert.equal(r2.pack, null, 'her 不使用 wins over 我的语音包 too');
  assert.equal(r2.userChoice, 'generic-male');
  assert.ok(VP.validateManifest({ format: 1, id: 'none', name: 'x', character: 'dafeiyu', lines: {} }).includes('id none is reserved'));
  // her own voice stays: nothing is borrowed from a pack
  const sp = { id: 'dafeiyu', voice: { tts: { default: 'minimax', minimax: { voiceId: 'qiaopi_mengmei' } } } };
  assert.equal(VP.voiceForPack(sp, r), sp);
});

test('查找优先级: the picked style pack first — A then B gives A\'s then B\'s file; 内置 brings her own pack back', () => {
  const { user, packs } = setup();
  const a = resolve(packs, 'style-cute');
  assert.deepEqual([a.pack.id, a.source], ['style-cute', 'user']);
  const hitA = packs.lookupIn(a.pack, LINE);
  assert.deepEqual([hitA.provider, hitA.packId, hitA.packFile, String(hitA.audio)], ['pack', 'style-cute', 'a.ogg', 'CUTE-AUDIO']);
  assert.equal(path.join(a.pack.dir, hitA.packFile), path.join(user, 'style-cute', 'a.ogg'));
  const b = resolve(packs, 'style-yujie');
  const hitB = packs.lookupIn(b.pack, LINE);
  assert.deepEqual([hitB.packId, String(hitB.audio)], ['style-yujie', 'YUJIE-AUDIO']);
  const auto = resolve(packs, 'auto');
  assert.deepEqual([auto.pack.id, auto.source], ['dafeiyu-minimax', 'own'], '内置 = her own pack, as before');
});

test('a pack picked by hand plays its recordings whatever engine would read; an automatic one still needs its engine', () => {
  const { packs } = setup();
  const a = resolve(packs, 'style-cute');
  // ElevenLabs chosen with a key: an automatic MiniMax pack would not apply, the owner's pick does
  assert.equal(VP.packApplies({ provider: 'elevenlabs' }, a.pack, 'elevenlabs', 'user'), true);
  assert.equal(VP.packApplies({ provider: 'elevenlabs' }, a.pack, 'elevenlabs', 'default'), true, '我的语音包 too');
  assert.equal(VP.packApplies({ provider: 'elevenlabs' }, a.pack, 'elevenlabs', 'own'), false);
  assert.equal(VP.packApplies({ provider: 'system' }, a.pack, null, 'user'), false, '系统语音 chosen: never');
  assert.equal(VP.packApplies({ provider: 'auto', packs: false }, a.pack, null, 'user'), false, '语音包 off: never');
});

test('回退: a line the picked pack has not recorded is not looked up in another pack — it goes to the engine in the pack\'s voice', () => {
  const { packs } = setup();
  const a = resolve(packs, 'style-cute');
  assert.equal(packs.lookupIn(a.pack, ONLY_HERS), null);
  const own = packs.packFor('dafeiyu');
  const herLine = [...own.lines.keys()].find((l) => !a.pack.lines.has(l));
  assert.ok(herLine, 'a line only her own pack has');
  assert.equal(packs.lookupIn(a.pack, herLine), null, 'her own recording of it is not mixed in (another voice)');
  const sp = { id: 'dafeiyu', voice: { tts: { default: 'minimax', minimax: { voiceId: 'qiaopi_mengmei' } } } };
  const voiced = VP.voiceForPack(sp, a);
  assert.equal(voiced.voice.tts.minimax.voiceId, 'tianxin_xiaoling', 'the engine reads it in the picked pack\'s voice');
  // and with no engine she could use, the recorded lines still play and the rest falls to the fallback (no crash)
  const engine = new tts.TtsEngine({ keys: { has: () => false, get: () => '', all: () => [] } });
  assert.equal(engine.firstUsable(voiced, { provider: 'auto' }), null);
});

test('删除正在使用的包: the pick stays saved but counts as 内置 (missing), and is in force again once downloaded back', () => {
  const { user, packs } = setup();
  assert.equal(resolve(packs, 'style-yujie').pack.id, 'style-yujie');
  const r = VoiceStore.remove(user, 'style-yujie');
  assert.equal(r.ok, true);
  packs.reload();
  const after = resolve(packs, 'style-yujie');
  assert.deepEqual([after.pack.id, after.source, after.choice, after.missing], ['dafeiyu-minimax', 'own', 'auto', 'style-yujie']);
  stylePack(user, 'style-yujie', 'yujie', 'wumei_yujie', 'YUJIE-AUDIO');
  packs.reload();
  assert.equal(resolve(packs, 'style-yujie').pack.id, 'style-yujie', 'downloaded again: her pick is back');
  // a deleted pack that was 我的语音包: falls back to her own one as well
  VoiceStore.remove(user, 'style-yujie');
  packs.reload();
  const mine = resolve(packs, 'auto', 'style-yujie');
  assert.deepEqual([mine.pack.id, mine.userChoice, mine.userMissing], ['dafeiyu-minimax', 'auto', 'style-yujie']);
});

test('选择持久化: none / a style pack is saved per character, auto removes it, defaults and old files are auto, it survives a restart', () => {
  assert.deepEqual(settingsLib.normalizeSettings(null).tts.voicePackByCharacter, {}, 'default: every character 内置');
  assert.deepEqual(settingsLib.normalizeSettings({ tts: { provider: 'minimax', providerSet: true, packs: true } }).tts.voicePackByCharacter, {}, 'a settings.json from before: migrated to {}');
  assert.deepEqual(tts.normalizeVoicePackPicks({ dafeiyu: 'none', claude: 'style-cute', gpt: 'auto', grok: 'Bad' }), { dafeiyu: 'none', claude: 'style-cute' });
  const { PetService } = require('../src/main/pet-service');
  const dir = tmp('pp-vps-settings-');
  const svc = new PetService({ lh: null, store: null, settingsStore: new settingsLib.SettingsStore(dir), ttsStatus: () => ({ engines: {} }) });
  svc.setTts({ voicePackByCharacter: { dafeiyu: 'style-cute' } });
  svc.setTts({ voicePackByCharacter: { claude: 'none' } });
  svc.setTts({ voicePackByCharacter: { dafeiyu: 'style-yujie' } }); // A → B
  const again = new PetService({ lh: null, store: null, settingsStore: new settingsLib.SettingsStore(dir), ttsStatus: () => ({ engines: {} }) });
  assert.deepEqual(again.settings.tts.voicePackByCharacter, { dafeiyu: 'style-yujie', claude: 'none' }, 'read back after a restart');
  again.setTts({ voicePackByCharacter: { claude: 'auto' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).tts.voicePackByCharacter, { dafeiyu: 'style-yujie' });
});

test('roster picker: downloaded style packs grouped first (风格·可爱), store packs not here listed apart, 不使用 has no pack row', () => {
  const { packs } = setup();
  const list = packs.list();
  const state = { choice: 'style-cute', userChoice: 'auto', missing: null, source: 'user', pack: { id: 'style-cute' }, notDownloaded: [{ id: 'style-gaoxiao', name: '搞笑 · 爆笑', style: 'gaoxiao', styleLabel: '搞笑', gender: 'male' }] };
  const pick = roster.voicePackPick('dafeiyu', list, state);
  assert.deepEqual(pick.options.slice(0, 2).map((o) => [o.id, o.group, o.label, o.store]), [['style-cute', 'style', '风格·可爱', true], ['style-yujie', 'style', '风格·御姐', true]]);
  assert.deepEqual(pick.notDownloaded.map((o) => o.id), ['style-gaoxiao']);
  const ref = roster.voicePackFor('dafeiyu', list, state);
  assert.deepEqual([ref.id, ref.kind, ref.store, ref.sourceLabel], ['style-cute', 'style', true, '手动指定']);
  assert.equal(roster.voicePackFor('dafeiyu', list, { ...state, choice: 'none', source: 'none', pack: null }), null);
  assert.equal(roster.voicePackPick('dafeiyu', list, { ...state, choice: 'none' }).choice, 'none');
});
