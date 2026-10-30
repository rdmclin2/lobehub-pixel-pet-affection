'use strict';
// 语音包 (core/voice-pack.js): her fixed lines recorded ahead, played from disk before any engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VP = require('../src/core/voice-pack');
const { VoicePacks } = VP;
const tts = require('../src/core/tts');
const Voice = require('../src/core/voice');
const { SPECIES, SPECIES_IDS } = require('../src/core/species');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vp-'));
function makePack(root, name, manifest, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}
const M = (over = {}) => ({ format: 1, id: 'dafeiyu-minimax', name: '大肥鱼', character: 'dafeiyu', engine: 'minimax', voiceId: 'qiaopi_mengmei', lines: { '摸头……嗯，凑合。': 'a.mp3' }, ...over });
const keysWith = (k) => ({ has: (id) => !!k[id], get: (id) => k[id] || '', all: () => Object.values(k) });

test('packLines: her fixed lines as they reach an engine — whole lines and each sentence, no duplicates', () => {
  for (const id of SPECIES_IDS) {
    const lines = VP.packLines(SPECIES[id]);
    assert.ok(lines.length > 150, `${id}: ${lines.length}`);
    assert.equal(new Set(lines).size, lines.length);
    for (const l of lines) assert.equal(l, VP.norm(Voice.speakable(l)), `already speakable: ${l}`);
  }
  const d = VP.packLines(SPECIES.dafeiyu);
  for (const l of SPECIES.dafeiyu.touch.lines.head.low) assert.ok(d.includes(Voice.speakable(l)), l);
  for (const l of SPECIES.dafeiyu.voice.lines.throw) assert.ok(d.includes(Voice.speakable(l)), l);
  for (const l of VP.APP_LINES) assert.ok(d.includes(l), l);
  assert.equal(d.some((l) => l.includes('DeepSeek 社区')), false, 'not her blurb or personality');
});

test('validateManifest checks the shape and that every file is there', () => {
  const root = tmp();
  const dir = makePack(root, 'p', M(), { 'a.mp3': 'ID3' });
  assert.deepEqual(VP.validateManifest(M(), dir), []);
  assert.match(VP.validateManifest(M({ format: 2 })).join(), /format/);
  assert.match(VP.validateManifest(M({ id: 'Bad Id' })).join(), /id/);
  assert.match(VP.validateManifest(M({ lines: { 'x': '../evil.mp3' } })).join(), /bad entry/);
  assert.match(VP.validateManifest(M({ lines: { 'x': 'gone.mp3' } }), dir).join(), /missing file/);
});

test('VoicePacks: built-in packs load, the owner\'s own pack wins for the same character, broken ones are skipped', () => {
  const builtIn = tmp();
  const mine = tmp();
  makePack(builtIn, 'dafeiyu', M(), { 'a.mp3': 'BUILTIN' });
  makePack(builtIn, 'broken', M({ id: 'broken', character: 'claude', lines: { x: 'missing.mp3' } }));
  const logs = [];
  let packs = new VoicePacks([builtIn, mine], { log: (e) => logs.push(e.message) });
  assert.equal(packs.lookup('dafeiyu', '摸头……嗯，凑合。').audio.toString(), 'BUILTIN');
  assert.equal(packs.packFor('claude'), null);
  assert.match(logs.join(), /broken/);
  makePack(mine, 'mine', M({ id: 'my-dafeiyu', name: '我录的大肥鱼', engine: undefined }), { 'a.mp3': 'MINE' });
  packs = new VoicePacks([builtIn, mine]);
  const hit = packs.lookup('dafeiyu', ' 摸头……嗯，凑合。 ');
  assert.equal(hit.audio.toString(), 'MINE');
  assert.equal(hit.provider, 'pack');
  assert.equal(hit.packId, 'my-dafeiyu');
  assert.equal(packs.lookup('dafeiyu', '没录过的话'), null);
  assert.deepEqual(packs.list().map((p) => [p.id, p.builtIn, p.lines]), [['my-dafeiyu', false, 1]]);
});

test('packApplies: only when the engine that would read the line is the pack\'s, or none could', () => {
  const pack = { engine: 'minimax' };
  assert.equal(VP.packApplies({ provider: 'auto' }, pack, 'minimax'), true);
  assert.equal(VP.packApplies({ provider: 'auto' }, pack, null), true, 'no key at all: her recorded voice beats the system voice');
  assert.equal(VP.packApplies({ provider: 'fish' }, pack, 'fish'), false, 'Fish chosen with a key: her lines stay in the Fish voice');
  assert.equal(VP.packApplies({ provider: 'system' }, pack, null), false, '系统语音 chosen');
  assert.equal(VP.packApplies({ provider: 'auto', packs: false }, pack, 'minimax'), false, '语音包 off');
  assert.equal(VP.packApplies({ provider: 'fish' }, { engine: null }, 'fish'), true, 'a pack of no engine (recorded by hand) is always hers');
  assert.equal(VP.packApplies({ provider: 'auto' }, null, 'minimax'), false);
});

test('firstUsable: the engine her next line would go to — skips no key, no voice and paused ones', () => {
  let now = 0;
  const e = new tts.TtsEngine({ keys: keysWith({ minimax: 'mm-key-000000' }), now: () => now });
  assert.equal(e.firstUsable(SPECIES.dafeiyu, { provider: 'auto' }), 'minimax');
  assert.equal(e.firstUsable(SPECIES.dafeiyu, { provider: 'fish' }), 'minimax', 'Fish has no key: MiniMax is next');
  assert.equal(e.firstUsable(SPECIES.dafeiyu, { provider: 'system' }), null);
  e.health.minimax = { until: 1000, reason: 'api-1002' };
  assert.equal(e.firstUsable(SPECIES.dafeiyu, { provider: 'auto' }), null, 'paused');
  now = 2000;
  assert.equal(e.firstUsable(SPECIES.dafeiyu, { provider: 'auto' }), 'minimax');
  assert.equal(new tts.TtsEngine({ keys: keysWith({}) }).firstUsable(SPECIES.dafeiyu, { provider: 'auto' }), null);
});

test('settings: 语音包 is on by default and can be switched off', () => {
  assert.equal(tts.normalizeTts({}).packs, true);
  assert.equal(tts.normalizeTts({ packs: false }).packs, false);
});

test('fileFor names a line\'s audio by its text, stable across runs', () => {
  assert.equal(VP.fileFor('咕噜'), VP.fileFor(' 咕噜 '));
  assert.match(VP.fileFor('咕噜'), /^[0-9a-f]{16}\.mp3$/);
  assert.notEqual(VP.fileFor('咕噜'), VP.fileFor('咕噜~'));
});
