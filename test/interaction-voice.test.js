'use strict';
// 互动语音 (core/interaction-voice.js): which lines are read with which switches, the gate that keeps rapid
// clicks from piling up, the lines her renderer interactions say, and synthesising lines ahead
// (TtsEngine.prewarm, PetService.voiceLines). No network: a fake fetch answers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const IV = require('../src/core/interaction-voice');
const Voice = require('../src/core/voice');
const tts = require('../src/core/tts');
const { TtsCache } = require('../src/core/tts-cache');
const { TtsKeyStore } = require('../src/core/tts-keys');
const settingsLib = require('../src/core/settings');
const { SPECIES, SPECIES_IDS, validateCharacter } = require('../src/core/species');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');

const ON = { voice: true, voiceInteractions: true, voiceMurmurs: false };
const line = (kind, source = 'fallback') => ({ text: '嗯。', kind, source });

// ---- which lines are read ------------------------------------------------------------------------
test('classify sorts every interaction kind, replies, murmurs and the app\'s own notes', () => {
  assert.deepEqual(IV.classify(line('chat', 'llm')), { cls: 'reply', tier: 2, interaction: null });
  assert.equal(IV.classify(line('topic:books', 'llm')).cls, 'reply');
  assert.equal(IV.classify(line('topic:books', 'fallback')).cls, 'reply', 'an offline topic line still answers a click');
  assert.equal(IV.classify(line('api', 'api')).cls, 'reply');
  for (const k of ['met', 'stage_up', 'switch']) {
    assert.deepEqual(IV.classify(line(k, 'llm')), { cls: 'milestone', tier: 1, interaction: k });
    assert.equal(IV.classify(line(k, 'fallback')).cls, 'milestone');
  }
  for (const k of ['pat', 'feed', 'play', 'sleep', 'lift', 'throw', 'catch']) assert.deepEqual(IV.classify(line(k)), { cls: 'interaction', tier: 0, interaction: k });
  assert.deepEqual(IV.classify(line('touch:head')), { cls: 'interaction', tier: 0, interaction: 'touch' });
  for (const k of ['hungry', 'bored', 'greet_morning', 'greet_evening', 'missed', 'woke']) assert.equal(IV.classify(line(k, 'llm')).cls, 'murmur', k);
  for (const [k, s] of [['error', 'error'], ['busy', undefined], ['settings', 'fallback'], ['retired', 'fallback'], ['update', 'fallback'], ['chat', 'fallback']]) assert.equal(IV.classify(line(k, s)), null, `${k}/${s}`);
  assert.equal(IV.classify(null), null);
});

test('with 朗读 off nothing at all is read, whatever the other switches say', () => {
  const off = { voice: false, voiceInteractions: true, voiceMurmurs: true };
  for (const m of [line('chat', 'llm'), line('api', 'api'), line('pat'), line('touch:head'), line('met', 'llm'), line('stage_up', 'llm'), line('lift'), line('hungry', 'llm')]) {
    assert.equal(IV.shouldSpeak(m, off), false, m.kind);
    assert.equal(IV.shouldSpeak(m, {}), false, m.kind);
    assert.equal(IV.shouldSpeak(m, null), false, m.kind);
  }
});

test('互动语音 and 朗读碎碎念 decide interactions and murmurs; replies are read either way', () => {
  assert.equal(IV.shouldSpeak(line('pat'), ON), true);
  assert.equal(IV.shouldSpeak(line('met', 'llm'), ON), true);
  assert.equal(IV.shouldSpeak(line('hungry', 'llm'), ON), false, 'murmurs are not read by default');
  assert.equal(IV.shouldSpeak(line('hungry', 'llm'), { ...ON, voiceMurmurs: true }), true);
  const noInter = { ...ON, voiceInteractions: false };
  assert.equal(IV.shouldSpeak(line('pat'), noInter), false);
  assert.equal(IV.shouldSpeak(line('stage_up', 'llm'), noInter), false);
  assert.equal(IV.shouldSpeak(line('chat', 'llm'), noInter), true);
  assert.equal(IV.shouldSpeak(line('error', 'error'), { ...ON, voiceMurmurs: true }), false);
});

test('settings: 互动语音 is on and 朗读碎碎念 off by default; both survive a save as booleans only', () => {
  const s = settingsLib.normalizeSettings({});
  assert.equal(s.prefs.voice, false, 'the pet stays quiet until asked');
  assert.equal(s.prefs.voiceInteractions, true);
  assert.equal(s.prefs.voiceMurmurs, false);
  const t = settingsLib.normalizeSettings({ prefs: { voiceInteractions: false, voiceMurmurs: true } });
  assert.deepEqual([t.prefs.voiceInteractions, t.prefs.voiceMurmurs], [false, true]);
  assert.equal(settingsLib.normalizeSettings({ prefs: { voiceMurmurs: 'yes' } }).prefs.voiceMurmurs, false);
});

test('moods: fixed per interaction (so the cache key is stable), a touch reaction its own, a reply none', () => {
  assert.equal(IV.moodFor(line('pat')), 'happy');
  assert.equal(IV.moodFor(line('sleep')), 'sleep');
  assert.equal(IV.moodFor({ ...line('touch:chest'), voiceMood: 'sad' }), 'sad');
  assert.equal(IV.moodFor({ ...line('touch:chest'), voiceMood: '' }), '');
  assert.equal(IV.moodFor(line('chat', 'llm')), null);
  assert.equal(IV.touchMood('ticklish'), 'happy');
  assert.equal(IV.touchMood('angry'), '');
});

// ---- the gate ----------------------------------------------------------------------------------------
test('rapid clicks: one interaction line per 1.5 s, none while another is being said, nothing queued', () => {
  const clock = { t: 0 };
  const g = new IV.SpeechGate({ now: () => clock.t });
  const pat = IV.classify(line('pat'));
  // ten clicks 100 ms apart, the first line still being said for 800 ms
  const out = [];
  for (let i = 0; i < 10; i++) {
    clock.t = i * 100;
    out.push(g.admit(pat, clock.t < 800 && out[0] === true ? 0 : -1).ok);
  }
  assert.deepEqual(out, [true, false, false, false, false, false, false, false, false, false]);
  assert.deepEqual(g.stats, { admitted: 1, busy: 7, throttled: 2 });
  clock.t = 1600;
  assert.equal(g.admit(pat, -1).ok, true, 'after the gap she speaks again');
  clock.t = 1700;
  assert.deepEqual(g.admit(IV.classify(line('touch:head')), -1), { ok: false, reason: 'throttled' });
});

test('a reply or a milestone always gets through; an interaction never cuts off a reply', () => {
  const clock = { t: 0 };
  const g = new IV.SpeechGate({ now: () => clock.t });
  const reply = IV.classify(line('chat', 'llm'));
  const ms = IV.classify(line('stage_up', 'llm'));
  const pat = IV.classify(line('pat'));
  assert.equal(g.admit(pat, -1).ok, true);
  assert.equal(g.admit(ms, 0).ok, true, 'a stage-up interrupts a pat line');
  assert.equal(g.admit(reply, 1).ok, true, 'a reply interrupts the stage-up line');
  assert.equal(g.admit(ms, 2).ok, false, 'a stage-up waits for no reply: it is dropped while one plays');
  clock.t = 5000;
  assert.deepEqual(g.admit(pat, 2), { ok: false, reason: 'busy' });
  assert.equal(g.admit(reply, 2).ok, true, 'a new reply replaces the old one');
});

// ---- lines for the renderer's interactions ----------------------------------------------------------
test('every character has her own short lift / throw / catch lines, and they are valid', () => {
  for (const id of SPECIES_IDS) {
    const sp = SPECIES[id];
    assert.deepEqual(validateCharacter(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', `${id}.json`), 'utf8'))), [], id);
    for (const k of IV.LOCAL) {
      const l = IV.localLines(sp, k);
      assert.ok(l.length >= 2, `${id} ${k}`);
      assert.notDeepEqual(l, IV.DEFAULT_LINES[k], `${id} has her own ${k} lines`);
      for (const x of l) assert.equal(Voice.speakable(x), x, `${id} ${k} "${x}" is read as written`);
    }
  }
  assert.deepEqual(IV.localLines({ voice: { lang: 'zh-CN' } }, 'lift'), IV.DEFAULT_LINES.lift, 'a file without lines uses the defaults');
  assert.deepEqual(IV.localLines({ voice: 'Xiaoxiao' }, 'catch'), IV.DEFAULT_LINES.catch);
});

test('喂食 / 摸摸 / 玩耍: every character has her own lines, mixed with the stage lines', () => {
  const { fallbackPool } = require('../src/core/proactive');
  const { stageLines } = require('../src/core/dialogue');
  const seen = new Set();
  for (const id of SPECIES_IDS) {
    const sp = SPECIES[id];
    const pet = { speciesId: id, relStage: 'close' };
    for (const kind of ['fed', 'patted', 'played']) {
      assert.ok(sp.fallback[kind] && sp.fallback[kind].length >= 2, `${id} fallback.${kind}`);
      const pool = fallbackPool(sp, kind, pet, settingsLib.normalizeSettings({}));
      for (const l of sp.fallback[kind]) { assert.ok(pool.includes(l), `${id} ${kind} 「${l}」 in the pool`); seen.add(l); }
      for (const l of stageLines(pet, null, kind)) assert.ok(pool.includes(l), `${id} ${kind} keeps the stage line 「${l}」`);
    }
  }
  assert.equal(seen.size, SPECIES_IDS.length * 6, 'no two characters share a line');
  const bare = { fallback: { happy: ['好'], sleepy: ['困'], greet: ['嗨'], hungry: ['饿'], bored: ['闲'] } };
  assert.deepEqual(fallbackPool(bare, 'fed'), ['好'], 'a file without them keeps fallback.happy');
  assert.match(validateCharacter({ ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', 'grok.json'), 'utf8')), fallback: { ...SPECIES.grok.fallback, fed: [] } }).join(), /fallback.fed must be a list of lines/);
});

test('voice.lines is checked in a character file', () => {
  assert.deepEqual(tts.validateVoice({ lines: { lift: ['好'] } }), []);
  assert.match(tts.validateVoice({ lines: { wave: ['好'] } }).join(), /unknown interaction/);
  assert.match(tts.validateVoice({ lines: { lift: [] } }).join(), /short lines/);
  assert.match(tts.validateVoice({ lines: { lift: ['好'.repeat(41)] } }).join(), /short lines/);
  assert.match(tts.validateVoice({ lines: ['好'] }).join(), /must be an object/);
});

// ---- prewarm ------------------------------------------------------------------------------------------
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-iv-'));
const KEY = 'fish-secret-key-123456';
const keysWith = (k) => { const ks = new TtsKeyStore(null); for (const [id, v] of Object.entries(k)) ks.set(id, v); return ks; };
const audioRes = (b = Buffer.from('ID3fake')) => ({ ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length), json: async () => ({}) });
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return answer(url, init); };
  f.calls = calls;
  return f;
}
const FISH = { provider: 'fish', fallback: 'system', endpoints: {} };
const dfy = SPECIES.dafeiyu;

test('prewarm fills the cache so the live line is a hit with no request; cached lines are skipped', async () => {
  const fetch = fakeFetch(() => audioRes());
  const cache = new TtsCache(tmp());
  const engine = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), cache, fetch });
  const items = [{ text: '咕噜~', mood: 'happy' }, { text: '好饱', mood: 'happy' }, { text: '咕噜~', mood: 'happy' }];
  const r = await engine.prewarm(items, dfy, FISH);
  assert.deepEqual(r, { provider: 'fish', warmed: 2, cached: 0, skipped: null, failed: null });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].body.text, '[开心地]咕噜~', 'read in the mood the live line will use');
  const again = await engine.prewarm(items, dfy, FISH);
  assert.equal(again.cached, 2);
  assert.equal(fetch.calls.length, 2, 'nothing fetched twice');
  const live = await engine.synthesize({ text: '咕噜~', species: dfy, mood: 'happy' }, FISH);
  assert.equal(live.ok, true);
  assert.equal(live.cached, true);
  assert.equal(fetch.calls.length, 2);
});

test('prewarm does nothing without an engine: system voice chosen, no key, no voice', async () => {
  const fetch = fakeFetch(() => audioRes());
  const cache = new TtsCache(tmp());
  assert.equal((await new tts.TtsEngine({ keys: keysWith({ fish: KEY }), cache, fetch }).prewarm([{ text: '好' }], dfy, { ...FISH, provider: 'system' })).skipped, 'no-engine');
  assert.equal((await new tts.TtsEngine({ keys: keysWith({}), cache, fetch }).prewarm([{ text: '好' }], dfy, FISH)).skipped, 'no-engine');
  assert.equal((await new tts.TtsEngine({ keys: keysWith({ fish: KEY }), cache, fetch }).prewarm([{ text: '好' }], { voice: { lang: 'zh-CN' } }, { ...FISH, fallback: 'silent' })).skipped, 'no-engine');
  assert.equal(fetch.calls.length, 0);
});

test('prewarm stops at the first failure and pauses that engine; a live line is not interrupted by it', async () => {
  let n = 0;
  const fetch = fakeFetch(() => (++n === 2 ? { ok: false, status: 500, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) } : audioRes()));
  const engine = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), cache: new TtsCache(tmp()), fetch });
  const r = await engine.prewarm([{ text: '一' }, { text: '二' }, { text: '三' }], dfy, FISH);
  assert.deepEqual([r.warmed, r.failed], [1, 'http-500']);
  assert.equal(fetch.calls.length, 2);
  assert.equal(engine.status().fish.lastError, 'http-500');
});

test('stopAll (朗读 switched off) aborts the prewarm and the live line at once', async () => {
  const pending = [];
  const fetch = fakeFetch((_u, init) => new Promise((res, rej) => { pending.push(res); init.signal.addEventListener('abort', () => rej(new Error('aborted'))); }));
  const engine = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), cache: new TtsCache(tmp()), fetch });
  const warm = engine.prewarm([{ text: '一' }, { text: '二' }], dfy, FISH);
  const live = engine.synthesize({ text: '回复', species: dfy }, FISH);
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 2, 'the live line runs beside the prewarm');
  engine.stopAll();
  assert.equal((await warm).skipped, 'stopped');
  assert.equal((await live).reason, 'interrupted');
  assert.equal(fetch.calls.length, 2, 'nothing more is requested');
  assert.equal(engine.status().fish.lastError, null, 'stopping is not a failure');
});

test('endPrewarm (engine, key or endpoint changed) ends the running prewarm before its next request', async () => {
  const pending = [];
  const fetch = fakeFetch((_u, init) => new Promise((res, rej) => { pending.push(res); init.signal.addEventListener('abort', () => rej(new Error('aborted'))); }));
  const engine = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), cache: new TtsCache(tmp()), fetch });
  const warm = engine.prewarm([{ text: '一' }, { text: '二' }, { text: '三' }], dfy, FISH);
  await new Promise((r) => setImmediate(r));
  assert.equal(fetch.calls.length, 1);
  engine.endPrewarm();
  assert.equal((await warm).skipped, 'stopped');
  assert.equal(fetch.calls.length, 1, 'nothing more goes to the old engine');
  assert.equal(engine.status().fish.lastError, null, 'ending it is not a failure');
});

test('a newer prewarm supersedes the running one (another character, a new key)', async () => {
  let release;
  const fetch = fakeFetch(() => new Promise((res) => { release = () => res(audioRes()); }));
  const engine = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), cache: new TtsCache(tmp()), fetch });
  const first = engine.prewarm([{ text: '一' }, { text: '二' }], dfy, FISH);
  await new Promise((r) => setImmediate(r));
  const second = engine.prewarm([], SPECIES.claude, FISH);
  release();
  assert.equal((await first).skipped, 'superseded');
  assert.equal((await second).warmed, 0);
});

// ---- PetService: the lines it says are the lines it synthesises ahead ------------------------------
function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petsvc-iv-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: new Date('2026-01-05T14:00:00').getTime() };
  const lh = new LhClient({ bin: path.join(__dirname, 'fixtures', 'fake-lh.js'), env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), now: () => clock.t, rnd: () => 0.5 });
  svc.on('error', () => {});
  const said = [];
  svc.on('say', (m) => said.push(m));
  return { svc, said, clock };
}
const sameLine = (list, m) => list.some((x) => x.text === Voice.speakable(m.text) && x.mood === IV.moodFor(m));

test('every interaction PetService says is an interaction or milestone line, read with 互动语音 on', async () => {
  const { svc, said, clock } = service();
  await svc.hatch({ speciesId: 'dafeiyu', name: 'F' });
  svc.pet.hunger = 50;
  svc.act('pat');
  clock.t += 20000;
  svc.act('feed', Object.keys(require('../src/core/pet-state').FOODS)[0]);
  clock.t += 20000;
  svc.act('play');
  clock.t += 20000;
  svc.touch('head');
  // a new character says hello (met) once her agent exists; going back to one met before is 切换角色 (switch)
  await svc.switchCharacter('claude');
  await svc.switchCharacter('dafeiyu');
  svc.act('sleep');
  svc.debugSet({ affection: 400 });
  await new Promise((r) => setTimeout(r, 300));
  const kinds = said.map((m) => m.kind);
  for (const k of ['met', 'pat', 'feed', 'play', 'touch:head', 'switch', 'sleep', 'stage_up']) assert.ok(kinds.includes(k), `${k} in ${kinds.join(',')}`);
  for (const m of said) {
    const c = IV.classify(m);
    assert.ok(c && ['interaction', 'milestone'].includes(c.cls), `${m.kind} → ${c && c.cls}`);
    assert.equal(IV.shouldSpeak(m, ON), true, m.kind);
    assert.equal(IV.shouldSpeak(m, { ...ON, voice: false }), false, m.kind);
  }
  assert.equal(typeof said.find((m) => m.kind === 'touch:head').voiceMood, 'string', 'a touch carries its reaction mood');
});

test('voiceLines lists the pat / feed / play / touch / drag lines exactly as they are said (text + mood)', async () => {
  const { svc, said, clock } = service();
  await svc.hatch({ speciesId: 'dafeiyu', name: 'F' });
  const lines = svc.voiceLines();
  assert.ok(lines.length >= 20 && lines.length <= 60, `${lines.length} lines`);
  for (const k of IV.LOCAL) for (const l of IV.localLines(SPECIES.dafeiyu, k)) assert.ok(sameLine(lines, { text: l, kind: k, source: 'fallback' }), `${k} ${l}`);
  said.length = 0;
  svc.pet.hunger = 50;
  for (const [i, k] of ['pat', 'feed', 'play'].entries()) { clock.t += 20000 * (i + 1); svc.act(k, k === 'feed' ? 'rice' : undefined); }
  for (const zone of ['head', 'hands', 'face', 'feet']) { clock.t += 9000; svc.touch(zone); }
  assert.equal(said.length, 7);
  for (const m of said) assert.ok(sameLine(lines, m), `${m.kind} 「${m.text}」 (${IV.moodFor(m)}) is synthesised ahead`);
  assert.equal(new Set(lines.map((l) => `${l.mood}|${l.text}`)).size, lines.length, 'no duplicates');
});
