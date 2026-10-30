'use strict';
// Voice engines (core/tts.js): provider chain, cache, fallbacks, one line at a time, character files,
// settings and the key store. No network: every request goes to a fake fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tts = require('../src/core/tts');
const { TtsCache } = require('../src/core/tts-cache');
const { TtsKeyStore } = require('../src/core/tts-keys');
const settingsLib = require('../src/core/settings');
const { SPECIES, SPECIES_IDS, validateCharacter } = require('../src/core/species');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tts-'));
const KEY = 'fish-secret-key-123456';
const keysWith = (k) => {
  const ks = new TtsKeyStore(null);
  for (const [id, v] of Object.entries(k)) ks.set(id, v);
  return ks;
};
const audioRes = (bytes = Buffer.from('ID3fake-mp3'), type = 'audio/mpeg') => ({ ok: true, status: 200, headers: { get: () => type }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), json: async () => ({}) });
const errRes = (status) => ({ ok: false, status, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) });
// a fetch that records calls and answers with `answer(url, init)` (a response, a promise, or a thrown error)
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return answer(url, init);
  };
  f.calls = calls;
  return f;
}
const hang = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
const FISH = { provider: 'fish', fallback: 'system', endpoints: {} };
const dfy = SPECIES.dafeiyu;

// ---- character files ---------------------------------------------------------------------------------
test('every character has a Fish and a MiniMax voice; 大肥鱼 uses the 蓝色大肥鱼 Fish voice', () => {
  for (const id of SPECIES_IDS) {
    assert.deepEqual(tts.validateVoice(SPECIES[id].voice), [], id);
    assert.ok(tts.voiceFor(SPECIES[id], 'fish'), `${id} fish`);
    assert.ok(tts.voiceFor(SPECIES[id], 'minimax'), `${id} minimax`);
  }
  const f = tts.voiceFor(dfy, 'fish');
  assert.equal(f.voiceId, 'fe50cdf3040449298470d58ff0991e1d');
  assert.equal(f.model, 's2.1-pro');
  assert.equal(f.speed, 1);
  assert.equal(tts.voiceFor(dfy, 'minimax').voiceId, 'qiaopi_mengmei');
  assert.equal(new Set(SPECIES_IDS.map((id) => tts.voiceFor(SPECIES[id], 'fish').voiceId)).size, SPECIES_IDS.length, 'each her own voice');
});

test('a legacy string voice (a system voice name) still passes and reaches the system voice', () => {
  assert.deepEqual(tts.validateVoice('Xiaoxiao'), []);
  assert.match(tts.validateVoice('  ').join(), /system voice name/);
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', 'dafeiyu.json'), 'utf8'));
  assert.deepEqual(validateCharacter({ ...c, voice: 'Xiaoxiao' }), []);
  const { toSpecies } = require('../src/core/species');
  const sp = toSpecies({ ...c, voice: 'Xiaoxiao' });
  assert.deepEqual(sp.voice, { prefer: ['Xiaoxiao'] });
  assert.equal(tts.voiceFor(sp, 'fish'), null, 'no engine voice: she falls back to the system voice');
  assert.deepEqual(require('../src/core/voice').voiceOf({ voice: 'Xiaoxiao' }).prefer, ['Xiaoxiao']);
});

test('the old voice object (no tts) is still valid, and engines then have no voice for her', () => {
  const old = { lang: 'zh-CN', pitch: 1.35, rate: 1.0, prefer: ['Xiaoyi'] };
  assert.deepEqual(tts.validateVoice(old), []);
  assert.deepEqual(tts.validateVoice({}), []);
  assert.equal(tts.voiceFor({ voice: old }, 'fish'), null);
  assert.equal(tts.voiceFor({ voice: null }, 'minimax'), null);
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', 'dafeiyu.json'), 'utf8'));
  assert.deepEqual(validateCharacter({ ...c, voice: old }), []);
  assert.deepEqual(validateCharacter({ ...c, voice: undefined }), []);
});

test('validateCharacter rejects a broken voice.tts', () => {
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', 'dafeiyu.json'), 'utf8'));
  const bad = (voice) => validateCharacter({ ...c, voice }).join('; ');
  assert.match(bad(42), /voice must be a system voice name or an object/);
  assert.match(bad(['Xiaoxiao']), /voice must be/);
  assert.match(bad({ lang: '' }), /voice\.lang/);
  assert.match(bad({ pitch: 'high' }), /voice\.pitch/);
  assert.match(bad({ tts: [] }), /voice\.tts must be an object/);
  assert.match(bad({ tts: { azure: {} } }), /unknown engine/);
  assert.match(bad({ tts: { default: 'azure' } }), /voice\.tts\.default must be one of fish, minimax/);
  assert.deepEqual(tts.validateVoice({ tts: { default: 'minimax', minimax: { voiceId: 'qiaopi_mengmei' } } }), []);
  assert.match(bad({ tts: { fish: { referenceId: 'nope' } } }), /referenceId/);
  assert.match(bad({ tts: { fish: { referenceId: 'fe50cdf3040449298470d58ff0991e1d', speed: 9 } } }), /speed must be a number from 0.5 to 2/);
  assert.match(bad({ tts: { minimax: { voiceId: 'x' } } }), /voiceId/);
  assert.match(bad({ tts: { minimax: { voiceId: 'female-shaonv', pitch: 30 } } }), /pitch/);
  assert.match(bad({ tts: { fish: { referenceId: 'fe50cdf3040449298470d58ff0991e1d', moodTags: { happy: '' } } } }), /moodTags/);
});

// ---- settings ----------------------------------------------------------------------------------------
test('settings.tts: each character\'s own engine (auto) by default with the system voice as fallback; bad values are dropped', () => {
  assert.deepEqual(settingsLib.normalizeSettings(null).tts, { provider: 'auto', providerSet: false, fallback: 'system', endpoints: { fish: '', minimax: '' } });
  const s = settingsLib.normalizeSettings({ tts: { provider: 'azure', providerSet: true, fallback: 'loud', endpoints: { fish: 'http://evil.example.com', minimax: 'https://mm.example.com/' } } });
  assert.deepEqual(s.tts, { provider: 'auto', providerSet: true, fallback: 'system', endpoints: { fish: '', minimax: 'https://mm.example.com' } });
  // saved before 'auto': provider 'fish' was the default, never a choice → auto; a picked engine stays
  assert.equal(settingsLib.normalizeSettings({ tts: { provider: 'fish', fallback: 'silent' } }).tts.provider, 'auto');
  assert.equal(settingsLib.normalizeSettings({ tts: { provider: 'fish', fallback: 'silent' } }).tts.fallback, 'silent');
  assert.equal(settingsLib.normalizeSettings({ tts: { provider: 'fish', providerSet: true } }).tts.provider, 'fish');
  assert.equal(settingsLib.normalizeSettings({ tts: { provider: 'system', fallback: 'silent', endpoints: { fish: 'http://127.0.0.1:9 ' } } }).tts.endpoints.fish, 'http://127.0.0.1:9');
  assert.equal(tts.endpointOk('https://user:pw@api.fish.audio'), false, 'no credentials in an endpoint');
  assert.equal(JSON.stringify(settingsLib.normalizeSettings({ tts: { key: KEY } })).includes(KEY), false, 'a key never lands in settings.json');
});

test('the chain: the chosen engine, other engines with a key, then Web Speech (unless silent)', () => {
  const has = (...ids) => (id) => ids.includes(id);
  assert.deepEqual(tts.providerChain({ provider: 'fish' }, has()), ['fish', 'system']);
  assert.deepEqual(tts.providerChain({ provider: 'fish' }, has('minimax')), ['fish', 'minimax', 'system']);
  assert.deepEqual(tts.providerChain({ provider: 'minimax' }, has('fish', 'minimax')), ['minimax', 'fish', 'system']);
  assert.deepEqual(tts.providerChain({ provider: 'fish', fallback: 'silent' }, has()), ['fish']);
  assert.deepEqual(tts.providerChain({ provider: 'system' }, has('fish')), ['system']);
});

test('auto: 大肥鱼 reads with MiniMax (qiaopi_mengmei), Fish next when it has a key; the others keep Fish', () => {
  const has = (...ids) => (id) => ids.includes(id);
  const dafeiyu = SPECIES.dafeiyu;
  assert.equal(tts.defaultEngine(dafeiyu), 'minimax');
  assert.equal(tts.voiceFor(dafeiyu, 'minimax').voiceId, 'qiaopi_mengmei');
  assert.equal(tts.voiceFor(dafeiyu, 'minimax').model, 'speech-2.8-turbo');
  assert.deepEqual(tts.providerChain({ provider: 'auto' }, has('fish'), dafeiyu), ['minimax', 'fish', 'system']);
  assert.deepEqual(tts.providerChain({}, has(), dafeiyu), ['minimax', 'system']);
  assert.deepEqual(tts.providerChain({ provider: 'fish' }, has('minimax'), dafeiyu), ['fish', 'minimax', 'system'], 'a picked engine wins over hers');
  for (const id of ['claude', 'gemini', 'gpt', 'grok']) {
    assert.equal(tts.defaultEngine(SPECIES[id]), 'fish', id);
    assert.deepEqual(tts.providerChain({ provider: 'auto' }, has('minimax'), SPECIES[id]), ['fish', 'minimax', 'system'], id);
  }
  assert.equal(tts.defaultEngine(null), 'fish');
});

test('auto, 大肥鱼 without a MiniMax key: straight to Fish, no MiniMax request', async () => {
  const f = fakeFetch(() => audioRes());
  const eng = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch: f });
  const r = await eng.synthesize({ text: '摸摸头', species: SPECIES.dafeiyu }, { provider: 'auto' });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'fish');
  assert.deepEqual(r.fellBackFrom, [{ provider: 'minimax', reason: 'no-key' }]);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/v1\/tts$/);
});

test('every provider has the same shape; Web Speech is the system provider', () => {
  assert.deepEqual(Object.keys(tts.PROVIDERS), ['fish', 'minimax', 'system']);
  for (const p of Object.values(tts.PROVIDERS)) {
    for (const k of ['id', 'label', 'kind', 'needsKey']) assert.ok(p[k] !== undefined, `${p.id}.${k}`);
    for (const k of ['available', 'config']) assert.equal(typeof p[k], 'function', `${p.id}.${k}`);
    assert.equal(typeof (p.kind === 'neural' ? p.synthesize : p.speak), 'function', p.id);
  }
  assert.equal(tts.PROVIDERS.fish.available({ hasKey: true }), true);
  assert.equal(tts.PROVIDERS.fish.available({ hasKey: false }), false);
  assert.equal(tts.PROVIDERS.fish.available({ hasKey: true, online: false }), false);
  const sys = tts.PROVIDERS.system;
  assert.equal(sys.available({}), false, 'no speechSynthesis here');
  assert.deepEqual(sys.config(dfy.voice), { lang: 'zh-CN', pitch: 1.35, rate: 1, prefer: ['Xiaoyi', 'Xiaoxiao', 'Tingting', 'Meijia'] });
  // speak() through a fake speechSynthesis: her pitch / rate / preferred voice, the old line cancelled first
  const said = [];
  class Utt { constructor(t) { this.text = t; } }
  const env = { SpeechSynthesisUtterance: Utt, speechSynthesis: { getVoices: () => [{ name: 'Microsoft Xiaoxiao', lang: 'zh-CN' }], cancel: () => said.push('cancel'), speak: (u) => { said.push(u); u.onstart(); u.onend(); } } };
  const ev = [];
  const r = sys.speak('你好', sys.config(dfy.voice), env, { start: () => ev.push('start'), end: () => ev.push('end') });
  assert.deepEqual(r, { voice: 'Microsoft Xiaoxiao', systemVoices: 1 });
  assert.equal(said[0], 'cancel');
  assert.equal(said[1].pitch, 1.35);
  assert.equal(said[1].voice.name, 'Microsoft Xiaoxiao');
  assert.deepEqual(ev, ['start', 'end']);
});

// ---- engine -------------------------------------------------------------------------------------------
test('Fish request: her reference id, model header, Bearer key, prosody; the mood tag goes in front', async () => {
  const fetch = fakeFetch(() => audioRes());
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch });
  const r = await e.synthesize({ text: '鱼片在哪里', species: dfy, mood: 'hungry' }, { ...FISH, endpoints: { fish: 'http://127.0.0.1:9' } });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'fish');
  assert.equal(r.cached, false);
  assert.equal(r.voiceId, 'fe50cdf3040449298470d58ff0991e1d');
  assert.equal(r.mime, 'audio/mpeg');
  assert.equal(r.audio.toString(), 'ID3fake-mp3');
  const c = fetch.calls[0];
  assert.equal(c.url, 'http://127.0.0.1:9/v1/tts');
  assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.init.headers.model, 's2.1-pro');
  assert.equal(c.body.reference_id, 'fe50cdf3040449298470d58ff0991e1d');
  assert.equal(c.body.text, '[可怜巴巴地]鱼片在哪里');
  assert.deepEqual(c.body.prosody, { speed: 1, volume: 0 });
  assert.equal(c.body.format, 'mp3');
});

test('MiniMax request and its hex answer; its own error codes count as failures', async () => {
  let reply = { base_resp: { status_code: 0 }, data: { audio: Buffer.from('mm-audio').toString('hex') } };
  const fetch = fakeFetch(() => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => reply }));
  const e = new tts.TtsEngine({ keys: keysWith({ minimax: 'mm-secret-key-0000' }), fetch });
  const r = await e.synthesize({ text: '你好', species: dfy }, { provider: 'minimax' });
  assert.equal(r.ok, true);
  assert.equal(r.audio.toString(), 'mm-audio');
  assert.equal(fetch.calls[0].url, 'https://api.minimax.cn/v1/t2a_v2');
  assert.deepEqual(fetch.calls[0].body.voice_setting, { voice_id: 'qiaopi_mengmei', speed: 1, vol: 1, pitch: 2, emotion: 'happy' });
  reply = { base_resp: { status_code: 1004, status_msg: 'auth' } };
  const r2 = await e.synthesize({ text: '再见', species: dfy }, { provider: 'minimax' });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.fellBackFrom, [{ provider: 'minimax', reason: 'http-401' }]);
});

test('cache: the same line in the same voice is not requested again; another voice or text is', async () => {
  const dir = tmp();
  const fetch = fakeFetch(() => audioRes());
  const cache = new TtsCache(dir);
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch, cache });
  assert.equal((await e.synthesize({ text: '早上好', species: dfy }, FISH)).cached, false);
  const again = await e.synthesize({ text: '早上好', species: dfy }, FISH);
  assert.equal(again.cached, true);
  assert.equal(again.audio.toString(), 'ID3fake-mp3');
  assert.equal(fetch.calls.length, 1);
  await e.synthesize({ text: '早上好', species: SPECIES.claude }, FISH);
  await e.synthesize({ text: '晚上好', species: dfy }, FISH);
  assert.equal(fetch.calls.length, 3);
  assert.equal(cache.count(), 3);
  // survives a restart
  const e2 = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch, cache: new TtsCache(dir) });
  assert.equal((await e2.synthesize({ text: '早上好', species: dfy }, FISH)).cached, true);
  assert.equal(fetch.calls.length, 3);
});

test('cache keys change with engine, voice, parameters and text; the LRU keeps under its size', () => {
  const f = tts.voiceFor(dfy, 'fish');
  const k = tts.cacheKey('fish', f, 'a');
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(tts.cacheKey('fish', { ...f }, 'a'), k);
  assert.notEqual(tts.cacheKey('fish', { ...f, speed: 1.1 }, 'a'), k);
  assert.notEqual(tts.cacheKey('fish', { ...f, voiceId: 'x' }, 'a'), k);
  assert.notEqual(tts.cacheKey('minimax', f, 'a'), k);
  assert.notEqual(tts.cacheKey('fish', f, 'b'), k);
  const c = new TtsCache(tmp(), { maxBytes: 25 });
  c.put('a'.repeat(64), Buffer.alloc(10), 'audio/mpeg');
  c.put('b'.repeat(64), Buffer.alloc(10), 'audio/mpeg');
  c.index['a'.repeat(64)].used = 0; // a is the oldest
  c.put('c'.repeat(64), Buffer.alloc(10), 'audio/mpeg');
  assert.equal(c.get('a'.repeat(64)), null);
  assert.ok(c.get('c'.repeat(64)));
  assert.ok(c.size() <= 25);
  c.clear();
  assert.equal(c.count(), 0);
});

test('no key: falls back without a request', async () => {
  const fetch = fakeFetch(() => audioRes());
  const e = new tts.TtsEngine({ keys: keysWith({}), fetch });
  const r = await e.synthesize({ text: '你好', species: dfy }, FISH);
  assert.equal(r.ok, false);
  assert.equal(r.fallback, 'system');
  assert.deepEqual(r.fellBackFrom, [{ provider: 'fish', reason: 'no-key' }]);
  assert.equal(fetch.calls.length, 0);
  assert.equal((await e.synthesize({ text: '你好', species: dfy }, { ...FISH, fallback: 'silent' })).fallback, 'silent');
});

test('a character without a voice on the engine falls back', async () => {
  const fetch = fakeFetch(() => audioRes());
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch });
  const r = await e.synthesize({ text: '你好', species: { voice: { lang: 'zh-CN' } } }, FISH);
  assert.deepEqual(r.fellBackFrom, [{ provider: 'fish', reason: 'no-voice' }]);
  assert.equal(fetch.calls.length, 0);
});

test('a refused request (bad key, no balance) falls back, then the engine is skipped for 5 minutes', async () => {
  let now = 1000;
  let answer = () => errRes(401);
  const fetch = fakeFetch((...a) => answer(...a));
  const logs = [];
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch, now: () => now, log: (err) => logs.push(err.message) });
  const r = await e.synthesize({ text: '一', species: dfy }, FISH);
  assert.equal(r.ok, false);
  assert.deepEqual(r.fellBackFrom, [{ provider: 'fish', reason: 'http-401' }]);
  const r2 = await e.synthesize({ text: '二', species: dfy }, FISH);
  assert.deepEqual(r2.fellBackFrom, [{ provider: 'fish', reason: 'paused:http-401' }]);
  assert.equal(fetch.calls.length, 1, 'no request while paused');
  assert.equal(e.status().fish.pausedFor, 300);
  now += tts.BREAKER_MS + 1;
  answer = () => { throw new TypeError(`fetch failed for ${KEY}`); };
  const r3 = await e.synthesize({ text: '三', species: dfy }, FISH);
  assert.deepEqual(r3.fellBackFrom, [{ provider: 'fish', reason: 'network' }]);
  assert.ok(logs.length >= 2);
  for (const l of logs) assert.equal(l.includes(KEY), false, `key leaked into the log: ${l}`);
  e.reset();
  answer = () => audioRes();
  assert.equal((await e.synthesize({ text: '四', species: dfy }, FISH)).ok, true, 'reset after a new key or endpoint');
});

test('a passing failure (timeout, network, 5xx) pauses briefly; a rate limit until the minute has room', async () => {
  assert.equal(tts.pauseFor('http-401'), tts.BREAKER_MS);
  assert.equal(tts.pauseFor('http-402'), tts.BREAKER_MS);
  assert.equal(tts.pauseFor('api-2013'), tts.BREAKER_MS, 'a bad request does not fix itself');
  for (const r of ['timeout', 'network', 'http-500', 'http-503', 'api-1000', 'empty']) assert.equal(tts.pauseFor(r), tts.TRANSIENT_PAUSE_MS, r);
  for (const r of ['http-429', 'api-1002', 'api-1039']) assert.equal(tts.pauseFor(r), tts.RATE_PAUSE_MS, r);
  let now = 1000;
  let answer = () => errRes(500);
  const fetch = fakeFetch((...a) => answer(...a));
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch, now: () => now });
  await e.synthesize({ text: '一', species: dfy }, FISH);
  assert.equal(e.status().fish.pausedFor, tts.TRANSIENT_PAUSE_MS / 1000);
  now += tts.TRANSIENT_PAUSE_MS + 1;
  answer = () => audioRes();
  assert.equal((await e.synthesize({ text: '二', species: dfy }, FISH)).ok, true, 'back after 20 s, not 5 minutes');
});

test('the backup engine takes over when the chosen one fails', async () => {
  const fetch = fakeFetch((url) => (url.includes('/v1/tts') ? errRes(503) : { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ base_resp: { status_code: 0 }, data: { audio: 'abcd' } }) }));
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY, minimax: 'mm-secret-key-0000' }), fetch });
  const r = await e.synthesize({ text: '你好', species: dfy }, FISH);
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'minimax');
  assert.deepEqual(r.fellBackFrom, [{ provider: 'fish', reason: 'http-503' }]);
});

test('timeout: no answer within 5 s (longer for a longer line, at most 10 s) aborts the request and falls back', async () => {
  const fetch = fakeFetch(hang);
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch, timeoutMs: 50 });
  const t0 = Date.now();
  const r = await e.synthesize({ text: '你好', species: dfy }, FISH);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.ok, false);
  assert.deepEqual(r.fellBackFrom, [{ provider: 'fish', reason: 'timeout' }]);
  assert.equal(fetch.calls[0].init.signal.aborted, true);
  assert.equal(tts.TIMEOUT_MS, 5000);
  assert.equal(tts.timeoutFor(5000, '你好'), 5100);
  assert.equal(tts.timeoutFor(5000, '好'.repeat(40)), 7000);
  assert.equal(tts.timeoutFor(5000, '好'.repeat(300)), 10000);
});

const MM = { provider: 'minimax', fallback: 'system', endpoints: {} };
const mmRes = (code = 0) => ({ ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ base_resp: { status_code: code }, data: { audio: 'abcd' } }) });

test('MiniMax: at most 10 requests a minute; past that a line falls back at once, without a request or a pause', async () => {
  let now = 0;
  const fetch = fakeFetch(() => mmRes());
  const e = new tts.TtsEngine({ keys: keysWith({ minimax: 'mm-secret-key-0000' }), fetch, now: () => now });
  for (let i = 0; i < 10; i++) { now += 1000; assert.equal((await e.synthesize({ text: `第${i}句`, species: dfy }, MM)).ok, true, `line ${i}`); }
  assert.equal(e.status().minimax.budget, 0);
  const r = await e.synthesize({ text: '第十一句', species: dfy }, MM);
  assert.equal(r.ok, false);
  assert.deepEqual(r.fellBackFrom, [{ provider: 'minimax', reason: 'rate-limit' }]);
  assert.equal(fetch.calls.length, 10, 'no request past the budget');
  assert.equal(e.status().minimax.lastError, null, 'not paused: the budget refills');
  assert.equal((await e.synthesize({ text: '第一句', species: dfy }, MM)).ok, false, 'a new line is no exception');
  now = 1000 + 60 * 1000 + 1; // the first request (at 1 s) leaves the minute window
  assert.equal((await e.synthesize({ text: '第十二句', species: dfy }, MM)).ok, true);
  assert.equal(tts.PROVIDERS.fish.rpm, 0, 'Fish publishes no per-minute limit');
});

test('MiniMax rate limit (1002) pauses it for 20 s, not five minutes', async () => {
  let now = 0;
  const fetch = fakeFetch(() => mmRes(1002));
  const e = new tts.TtsEngine({ keys: keysWith({ minimax: 'mm-secret-key-0000' }), fetch, now: () => now });
  const r = await e.synthesize({ text: '你好', species: dfy }, MM);
  assert.deepEqual(r.fellBackFrom, [{ provider: 'minimax', reason: 'api-1002' }]);
  assert.equal(e.status().minimax.pausedFor, 20);
});

test('a line she says now waits a few seconds for room in the minute instead of going silent', async () => {
  let now = 0;
  const sent = [];
  const fetch = fakeFetch(() => { sent.push(now); return mmRes(); });
  const sleeps = [];
  const e = new tts.TtsEngine({ keys: keysWith({ minimax: 'mm-secret-key-0000' }), fetch, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  for (let i = 0; i < 10; i++) { now = i * 100; await e.synthesize({ text: `第${i}句`, species: dfy }, MM); }
  now = 55 * 1000; // the first request leaves the window in 5 s
  const r = await e.synthesize({ text: '摸摸头', species: dfy }, { ...MM, fallback: 'silent' });
  assert.equal(r.ok, true, 'said in her voice after waiting');
  assert.deepEqual(sleeps, [5050]);
  assert.equal(sent.length, 11);
  assert.ok(sent[10] >= 60 * 1000, 'not before the minute had room');
});

test('waiting for room is cut short by a new line', async () => {
  let now = 0;
  const fetch = fakeFetch(() => mmRes());
  let release;
  const e = new tts.TtsEngine({ keys: keysWith({ minimax: 'mm-secret-key-0000' }), fetch, now: () => now, sleep: () => new Promise((r) => { release = r; }) });
  for (let i = 0; i < 10; i++) { now = i * 100; await e.synthesize({ text: `第${i}句`, species: dfy }, MM); }
  now = 55 * 1000;
  const waiting = e.synthesize({ text: '第一句', species: dfy }, MM);
  await new Promise((r) => setImmediate(r));
  e.cancel();
  const r = await waiting;
  assert.equal(r.reason, 'interrupted');
  assert.equal(fetch.calls.length, 10, 'no request after it was cut short');
  release();
});

test('prewarm only spends the spare requests of the minute and waits for more, keeping some for live lines', async () => {
  let now = 0;
  const sent = [];
  const fetch = fakeFetch(() => { sent.push(now); return mmRes(); });
  const sleeps = [];
  const e = new tts.TtsEngine({ keys: keysWith({ minimax: 'mm-secret-key-0000' }), cache: new TtsCache(tmp()), fetch, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
  const items = Array.from({ length: 12 }, (_, i) => ({ text: `预合成第${i}句` }));
  const out = await e.prewarm(items, dfy, MM);
  assert.equal(out.warmed, 12);
  assert.ok(sleeps.length > 0, 'it waited for the window instead of asking past the limit');
  const most = Math.max(...sent.map((t) => sent.filter((u) => u >= t && u < t + 60 * 1000).length));
  assert.ok(most <= tts.PROVIDERS.minimax.rpm - tts.PREWARM_RESERVE, `at most rpm - reserve requests in any minute (saw ${most})`);
  assert.ok(e.budget('minimax') >= tts.PREWARM_RESERVE, 'live lines still have requests left');
});


test('one line at a time: a new line interrupts the one still being fetched (no pause, no fallback)', async () => {
  let first = true;
  const fetch = fakeFetch((u, init) => { if (first) { first = false; return hang(u, init); } return audioRes(); });
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch });
  const p1 = e.synthesize({ text: '第一句', species: dfy }, FISH);
  await new Promise((r) => setImmediate(r));
  const p2 = e.synthesize({ text: '第二句', species: dfy }, FISH);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'interrupted');
  assert.deepEqual(r1.fellBackFrom, []);
  assert.equal(fetch.calls[0].init.signal.aborted, true);
  assert.equal(r2.ok, true);
  assert.equal(e.status().fish.lastError, null, 'an interruption does not pause the engine');
});

test('system engine: no request at all', async () => {
  const fetch = fakeFetch(() => audioRes());
  const e = new tts.TtsEngine({ keys: keysWith({ fish: KEY }), fetch });
  const r = await e.synthesize({ text: '你好', species: dfy }, { provider: 'system' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'system');
  assert.equal(r.next, 'system');
  assert.equal(fetch.calls.length, 0);
});

// ---- keys --------------------------------------------------------------------------------------------
test('keys: encrypted on disk when the system can, 0600 otherwise; never in settings', () => {
  const crypt = { available: () => true, encrypt: (t) => Buffer.from(`enc:${Buffer.from(t).toString('hex')}`), decrypt: (b) => Buffer.from(b.toString().slice(4), 'hex').toString() };
  const dir = tmp();
  const ks = new TtsKeyStore(dir, crypt);
  assert.equal(ks.set('fish', KEY), true);
  const raw = fs.readFileSync(path.join(dir, 'tts-keys.json'), 'utf8');
  assert.equal(raw.includes(KEY), false);
  assert.equal(new TtsKeyStore(dir, crypt).get('fish'), KEY);
  assert.equal(ks.set('fish', 'has space in it'), false);
  assert.equal(ks.set('fish', ''), true);
  assert.equal(new TtsKeyStore(dir, crypt).has('fish'), false);
  const plainDir = tmp();
  new TtsKeyStore(plainDir, null).set('minimax', 'mm-secret-key-0000');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(plainDir, 'tts-keys.json')).mode & 0o777, 0o600);
  assert.equal(new TtsKeyStore(plainDir, null).get('minimax'), 'mm-secret-key-0000');
  assert.equal(tts.redact(`bad ${KEY}!`, [KEY]), 'bad ***!');
});

test('the repository holds no API key', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (!['assets', 'packs'].includes(f.name)) walk(p); } else if (/\.(js|json|html)$/.test(f.name)) files.push(p); } };
  walk(root);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /(sk-[A-Za-z0-9]{20,}|"apiKey"\s*:\s*"[^"]+")/, f);
});

// ---- 高级设置 → 语音 through the pet service ------------------------------------------------------
test('PetService.setTts saves engine, fallback and endpoints; the settings view only says whether keys are set', () => {
  const { PetService } = require('../src/main/pet-service');
  const store = new settingsLib.MemorySettingsStore();
  const keys = keysWith({ fish: KEY });
  const svc = new PetService({ lh: null, store: null, settingsStore: store, ttsStatus: () => ({ engines: { fish: { hasKey: keys.has('fish') }, minimax: { hasKey: keys.has('minimax') } } }) });
  let r = svc.setTts({ provider: 'minimax', fallback: 'silent', endpoints: { fish: 'http://127.0.0.1:7777' } });
  assert.equal(r.ok, true);
  assert.deepEqual(store.load().tts, { provider: 'minimax', providerSet: true, fallback: 'silent', endpoints: { fish: 'http://127.0.0.1:7777', minimax: '' } });
  r = svc.setTts({ endpoints: { fish: 'ftp://nope' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-endpoint');
  assert.equal(store.load().tts.endpoints.fish, 'http://127.0.0.1:7777', 'a bad endpoint keeps the old one');
  assert.equal(svc.getSettings().ttsStatus.engines.fish.hasKey, true);
  assert.equal(JSON.stringify(svc.getSettings()).includes(KEY), false);
  assert.equal(JSON.stringify(store.data).includes(KEY), false);
});
