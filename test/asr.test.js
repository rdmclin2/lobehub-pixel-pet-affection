'use strict';
// 语音输入 (core/asr.js): both providers with a fake lh (the real spawn path through test/fixtures/fake-lh.js, and an
// injected runner) and a fake fetch; timeouts, error reasons, fallback, the breaker, settings and the IPC-facing service.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const asr = require('../src/core/asr');
const settingsLib = require('../src/core/settings');
const { LhClient, cleanEnv, LhError } = require('../src/core/lh-client');
const { TtsKeyStore } = require('../src/core/tts-keys');

const { AsrEngine, AsrError, normalizeAsr, applyAsrPatch, providerChain } = asr;
const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const CLIP = Buffer.from('OggS-not-really-but-bytes');
const on = (patch = {}) => normalizeAsr({ enabled: true, ...patch });

function fakeLhDir(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakelh-asr-'));
  const env = { ...cleanEnv(), FAKE_LH_DIR: dir, ...(mode ? { FAKE_LH_ASR: mode } : {}) };
  return { dir, lh: new LhClient({ bin: FAKE, env }), calls: () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse) };
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asr-tmp-'));

// fake fetch: records each request (url, headers, form fields) and answers with `reply(req)`
function fakeFetch(reply) {
  const calls = [];
  const f = async (url, opts) => {
    const fields = {};
    for (const [k, v] of opts.body.entries()) fields[k] = typeof v === 'string' ? v : { name: v.name, type: v.type, size: v.size, bytes: Buffer.from(await v.arrayBuffer()) };
    const req = { url, headers: opts.headers || {}, fields, signal: opts.signal };
    calls.push(req);
    return reply(req);
  };
  f.calls = calls;
  return f;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
// waits until aborted, then rejects the way fetch does (with the signal's reason)
const hang = (req) => new Promise((_res, rej) => req.signal.addEventListener('abort', () => rej(req.signal.reason), { once: true }));

// ---- settings -------------------------------------------------------------------------------------------
test('settings: ASR is off by default; engine lobehub, local endpoint on the whisper.cpp port 8179', () => {
  const d = settingsLib.normalizeSettings(null).asr;
  assert.deepEqual(d, asr.ASR_DEFAULTS);
  assert.equal(d.enabled, false);
  assert.equal(d.engine, 'lobehub');
  assert.equal(d.local.endpoint, 'http://127.0.0.1:8179');
  assert.equal(asr.asrActive(d), false);
});

test('settings: a settings.json from before 语音输入 (v0.10.0) loads with ASR defaults and keeps everything else', () => {
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'settings-v0.10.0.json'), 'utf8'));
  assert.equal(old.asr, undefined);
  const s = settingsLib.normalizeSettings(old);
  assert.deepEqual(s.asr, asr.ASR_DEFAULTS);
  assert.equal(s.petScale, 1.6);
  assert.equal(s.prefs.voice, true);
});

test('settings: the design-draft shape (provider: auto / lobehub / local) migrates to engine + fallback', () => {
  assert.deepEqual([normalizeAsr({ provider: 'auto' }).engine, normalizeAsr({ provider: 'auto' }).fallback], ['local', true]);
  assert.equal(normalizeAsr({ provider: 'local' }).engine, 'local');
  assert.equal(normalizeAsr({ provider: 'local' }).fallback, false);
  assert.equal(normalizeAsr({ provider: 'lobehub', engine: 'off' }).engine, 'off'); // engine wins once present
  assert.equal(normalizeAsr({ local: { endpoint: '' } }).local.endpoint, asr.DEFAULT_ENDPOINT);
});

test('settings: hand-edited junk is replaced by defaults, values are clamped', () => {
  const s = normalizeAsr({ enabled: 'yes', engine: 'google', fallback: 1, language: 'Chinese', maxSeconds: 999, lobehub: { model: 'bad model!' }, local: { endpoint: 'http://evil.example.com:8179', api: 'grpc', model: '', timeoutSec: 1 } });
  assert.equal(s.enabled, false);
  assert.equal(s.engine, 'lobehub');
  assert.equal(s.fallback, false);
  assert.equal(s.language, 'auto');
  assert.equal(s.maxSeconds, 120);
  assert.equal(s.lobehub.model, 'gpt-4o-mini-transcribe');
  assert.equal(s.local.endpoint, asr.DEFAULT_ENDPOINT); // plain http only to this machine or the home network
  assert.equal(s.local.api, 'openai');
  assert.equal(s.local.model, 'whisper-1');
  assert.equal(s.local.timeoutSec, 5);
  assert.equal(normalizeAsr({ language: 'ZH' }).language, 'zh');
});

test('settings: endpoints — https anywhere, http to loopback / LAN, trailing slash dropped, no credentials', () => {
  assert.equal(asr.endpointOk('http://127.0.0.1:8179'), true);
  assert.equal(asr.endpointOk('http://localhost:9000/'), true);
  assert.equal(asr.endpointOk('http://192.168.1.20:8000'), true);
  assert.equal(asr.endpointOk('http://gpu-box.local:8000'), true);
  assert.equal(asr.endpointOk('https://asr.example.com/v1'), true);
  assert.equal(asr.endpointOk('http://asr.example.com'), false);
  assert.equal(asr.endpointOk('http://user:pw@127.0.0.1:8179'), false);
  assert.equal(asr.endpointOk('file:///etc/passwd'), false);
  assert.equal(normalizeAsr({ local: { endpoint: 'http://127.0.0.1:8179///' } }).local.endpoint, 'http://127.0.0.1:8179');
});

test('settings: applyAsrPatch merges and names what it refused', () => {
  const r = applyAsrPatch(null, { enabled: true, engine: 'local', fallback: true, language: 'zh', local: { endpoint: 'http://127.0.0.1:9999', model: 'base' } });
  assert.equal(r.ok, true);
  assert.equal(r.asr.engine, 'local');
  assert.equal(r.asr.local.endpoint, 'http://127.0.0.1:9999');
  assert.equal(r.asr.local.model, 'base');
  const bad = applyAsrPatch(r.asr, { engine: 'siri', local: { endpoint: 'http://evil.example.com' }, language: 'chinese' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.sort(), ['bad-endpoint', 'bad-engine', 'bad-language']);
  assert.equal(bad.asr.engine, 'local'); // refused values leave the old ones
  assert.equal(bad.asr.local.endpoint, 'http://127.0.0.1:9999');
  assert.equal(applyAsrPatch(r.asr, { local: { endpoint: '' } }).asr.local.endpoint, asr.DEFAULT_ENDPOINT);
});

test('providerChain: the engine, then (with fallback) the other one; off = none', () => {
  assert.deepEqual(providerChain(on({ engine: 'lobehub' })), ['lobehub']);
  assert.deepEqual(providerChain(on({ engine: 'local', fallback: true })), ['local', 'lobehub']);
  assert.deepEqual(providerChain(on({ engine: 'lobehub', fallback: true })), ['lobehub', 'local']);
  assert.deepEqual(providerChain(on({ engine: 'off', fallback: true })), []);
});

// ---- audio ---------------------------------------------------------------------------------------------
test('toAudio: ArrayBuffer / Uint8Array / Buffer accepted; empty, oversized and non-audio refused as bad-audio', () => {
  const ab = new Uint8Array([1, 2, 3]).buffer;
  assert.deepEqual([...asr.toAudio(ab, 'audio/webm;codecs=opus', 1500).buffer], [1, 2, 3]);
  assert.equal(asr.toAudio(ab, 'audio/webm;codecs=opus').mime, 'audio/webm');
  assert.equal(asr.toAudio(new Uint8Array([9]), 'audio/wav').buffer.length, 1);
  for (const [b, m] of [[Buffer.alloc(0), 'audio/wav'], [Buffer.alloc(asr.MAX_BYTES + 1), 'audio/wav'], [Buffer.from('x'), 'text/plain'], ['str', 'audio/wav']]) {
    assert.throws(() => asr.toAudio(b, m), (e) => e instanceof AsrError && e.reason === 'bad-audio');
  }
  assert.equal(asr.extFor('audio/mpeg'), 'mp3');
  assert.equal(asr.extFor('audio/webm;codecs=opus'), 'webm');
});

test('silentWav is a valid RIFF/WAVE header with 16 kHz mono PCM', () => {
  const w = asr.silentWav(500);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.toString('ascii', 8, 12), 'WAVE');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.length, 44 + 16000);
});

test('cleanText / normLang: whisper padding and [BLANK_AUDIO] go, language names become codes', () => {
  assert.equal(asr.cleanText(' Hello there.\n'), 'Hello there.');
  assert.equal(asr.cleanText(' [BLANK_AUDIO]\n'), '');
  assert.equal(asr.normLang('chinese'), 'zh');
  assert.equal(asr.normLang('en'), 'en');
  assert.equal(asr.normLang('klingon'), null);
});

test('lhReason maps the real lh error lines (docs/asr-design.md §1.4)', () => {
  assert.equal(asr.lhReason('16:29:01 [ERROR] ASR failed: UNAUTHORIZED'), 'unauthorized');
  assert.equal(asr.lhReason('16:28:50 [ERROR] ASR failed: hetero-operation tokens are not accepted on this endpoint'), 'unauthorized');
  assert.equal(asr.lhReason('16:28:53 [ERROR] ASR failed: LobeHubModelDeprecated'), 'model');
  assert.equal(asr.lhReason('16:28:56 [ERROR] File not found: missing.wav'), 'bad-audio');
  assert.equal(asr.lhReason('16:28:59 [ERROR] ASR failed:'), 'server');
  assert.equal(asr.lhReason("error: unknown command 'asr'"), 'no-lh');
});

test('pauseFor: refusals 5 min, passing failures 20 s, this-clip failures none', () => {
  assert.equal(asr.pauseFor('unauthorized'), asr.BREAKER_MS);
  assert.equal(asr.pauseFor('model'), asr.BREAKER_MS);
  assert.equal(asr.pauseFor('http-401'), asr.BREAKER_MS);
  assert.equal(asr.pauseFor('timeout'), asr.TRANSIENT_PAUSE_MS);
  assert.equal(asr.pauseFor('network'), asr.TRANSIENT_PAUSE_MS);
  assert.equal(asr.pauseFor('http-503'), asr.TRANSIENT_PAUSE_MS);
  assert.equal(asr.pauseFor('empty'), 0);
  assert.equal(asr.pauseFor('http-400'), 0);
  assert.equal(asr.pauseFor('canceled'), 0);
});

// ---- lobehub provider, through a real spawn of the fake lh ------------------------------------------
test('lobehub: spawns `lh generate asr <tmpfile> --provider lobehub --model … --language … --json`, parses the text, deletes the file', async () => {
  const { dir, lh, calls } = fakeLhDir();
  const tmp = tmpDir();
  const eng = new AsrEngine({ lh, tmpDir: tmp });
  const r = await eng.transcribe(CLIP, 'audio/webm;codecs=opus', on({ language: 'zh' }), { ms: 2000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, 'heard gpt-4o-mini-transcribe zh');
  assert.equal(r.provider, 'lobehub');
  assert.equal(r.lang, 'zh');
  const call = calls().find((c) => c.args[0] === 'generate');
  assert.deepEqual(call.args.slice(0, 2), ['generate', 'asr']);
  assert.match(call.args[2], /asr-\d+-[0-9a-f]{12}\.webm$/);
  assert.deepEqual(call.args.slice(3), ['--provider', 'lobehub', '--model', 'gpt-4o-mini-transcribe', '--json', '--language', 'zh']);
  assert.equal(call.env.topic, null); // run context stripped (cleanEnv)
  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'asr-file.json'), 'utf8'));
  assert.equal(Buffer.from(seen.bytes, 'base64').toString(), CLIP.toString()); // the clip itself went to lh
  assert.equal(seen.mode, '600');
  assert.deepEqual(fs.readdirSync(tmp), []); // and is gone afterwards
});

test('lobehub: language auto sends no --language; the model comes from settings', async () => {
  const { lh, calls } = fakeLhDir();
  const r = await new AsrEngine({ lh, tmpDir: tmpDir() }).transcribe(CLIP, 'audio/wav', on({ lobehub: { model: 'gpt-4o-transcribe' } }));
  assert.equal(r.text, 'heard gpt-4o-transcribe auto');
  assert.equal(r.lang, null);
  assert.ok(!calls().find((c) => c.args[0] === 'generate').args.includes('--language'));
});

test('lobehub: lh errors become reasons (unauthorized, model, server, empty)', async () => {
  for (const [mode, reason] of [['unauth', 'unauthorized'], ['model', 'model'], ['fail', 'server'], ['empty', 'empty']]) {
    const { lh } = fakeLhDir(mode);
    const tmp = tmpDir();
    const r = await new AsrEngine({ lh, tmpDir: tmp }).transcribe(CLIP, 'audio/webm', on());
    assert.equal(r.ok, false, mode);
    assert.equal(r.reason, reason, mode);
    assert.equal(r.provider, 'lobehub');
    assert.deepEqual(fs.readdirSync(tmp), [], `${mode}: temp file removed`);
  }
});

test('lobehub: a hung lh is killed at the timeout -> reason timeout, temp file removed', async () => {
  const { lh } = fakeLhDir('hang');
  const tmp = tmpDir();
  const t0 = Date.now();
  const r = await new AsrEngine({ lh, tmpDir: tmp, timeoutMs: 400 }).transcribe(CLIP, 'audio/webm', on());
  assert.equal(r.reason, 'timeout');
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('lobehub: lh missing -> no-lh; a newer clip cancels the running one', async () => {
  const missing = new LhClient({ bin: path.join(os.tmpdir(), 'no-such-lh-binary'), env: cleanEnv() });
  const r = await new AsrEngine({ lh: missing, tmpDir: tmpDir() }).transcribe(CLIP, 'audio/webm', on());
  assert.equal(r.reason, 'no-lh');

  const { lh } = fakeLhDir('hang');
  const eng = new AsrEngine({ lh, tmpDir: tmpDir(), timeoutMs: 10000 });
  const first = eng.transcribe(CLIP, 'audio/webm', on());
  await new Promise((res) => setTimeout(res, 150));
  eng.cancel();
  assert.equal((await first).reason, 'canceled');
});

test('lobehub: injected runner — LhError codes map to reasons, unparseable stdout is a server error', async () => {
  const runner = (behave) => ({ asr: async () => behave() });
  const cases = [
    [() => { throw new LhError('x', { code: 'ETIMEDOUT' }); }, 'timeout'],
    [() => { throw new LhError('x', { code: 'ENOENT' }); }, 'no-lh'],
    [() => ({ code: 0, stdout: 'not json', stderr: '' }), 'server'],
    [() => ({ code: 0, stdout: '{"text":"  "}', stderr: '' }), 'empty'],
  ];
  for (const [behave, reason] of cases) {
    const r = await new AsrEngine({ lh: runner(behave), tmpDir: tmpDir() }).transcribe(CLIP, 'audio/webm', on());
    assert.equal(r.reason, reason);
  }
});

// ---- local provider, fake fetch -------------------------------------------------------------------------
test('local: multipart POST to <endpoint>/v1/audio/transcriptions with file, model, language, optional key', async () => {
  const f = fakeFetch(() => json({ text: ' 你好,今天我想为我的宠物吃饼干。\n' }));
  const keys = new TtsKeyStore(null);
  keys.set(asr.KEY_ID, 'sk-local-123');
  const eng = new AsrEngine({ fetch: f, keys });
  const r = await eng.transcribe(CLIP, 'audio/webm;codecs=opus', on({ engine: 'local', language: 'zh', local: { endpoint: 'http://127.0.0.1:8179/', model: 'base' } }));
  assert.equal(r.ok, true);
  assert.equal(r.text, '你好,今天我想为我的宠物吃饼干。');
  assert.equal(r.provider, 'local');
  assert.equal(r.lang, 'zh');
  const req = f.calls[0];
  assert.equal(req.url, 'http://127.0.0.1:8179/v1/audio/transcriptions');
  assert.equal(req.headers.Authorization, 'Bearer sk-local-123');
  assert.equal(req.fields.model, 'base');
  assert.equal(req.fields.language, 'zh');
  assert.equal(req.fields.response_format, 'json');
  assert.equal(req.fields.file.name, 'clip.webm');
  assert.equal(req.fields.file.type, 'audio/webm');
  assert.equal(req.fields.file.bytes.toString(), CLIP.toString());
});

test('local: endpoint forms — …/v1, full path, whisper.cpp /inference (verbose_json with language)', async () => {
  const f = fakeFetch(() => json({ text: ' Hello.\n', language: 'english' }));
  const eng = new AsrEngine({ fetch: f });
  await eng.transcribe(CLIP, 'audio/wav', on({ engine: 'local', local: { endpoint: 'http://127.0.0.1:8000/v1' } }));
  await eng.transcribe(CLIP, 'audio/wav', on({ engine: 'local', local: { endpoint: 'http://127.0.0.1:8000/v1/audio/transcriptions' } }));
  const r = await eng.transcribe(CLIP, 'audio/wav', on({ engine: 'local', local: { endpoint: 'http://127.0.0.1:8178', api: 'whispercpp' } }));
  assert.deepEqual(f.calls.map((c) => c.url), ['http://127.0.0.1:8000/v1/audio/transcriptions', 'http://127.0.0.1:8000/v1/audio/transcriptions', 'http://127.0.0.1:8178/inference']);
  assert.equal(f.calls[2].fields.response_format, 'verbose_json');
  assert.equal(f.calls[0].headers.Authorization, undefined); // no key, no header
  assert.equal(f.calls[0].fields.language, undefined); // auto: the server detects it
  assert.equal(r.lang, 'en');
});

test('local: HTTP errors become http-<status>; a 200 that is not JSON or carries an error is a server error', async () => {
  const cases = [
    [() => new Response('Invalid request', { status: 400 }), 'http-400'],
    [() => new Response('File Not Found (/v1/audio/transcriptions)', { status: 404 }), 'http-404'],
    [() => json({ error: 'FFmpeg conversion failed.' }, 500), 'http-500'],
    [() => new Response('nope', { status: 401 }), 'http-401'],
    [() => new Response('<html>', { status: 200 }), 'server'],
    [() => json({ error: { message: 'model not loaded' } }), 'server'],
    [() => json({ text: ' [BLANK_AUDIO]\n' }), 'empty'],
    [() => json({}), 'empty'],
  ];
  for (const [reply, reason] of cases) {
    const r = await new AsrEngine({ fetch: fakeFetch(reply) }).transcribe(CLIP, 'audio/wav', on({ engine: 'local' }));
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason, reason);
  }
});

test('local: no answer in time -> timeout (the fetch is aborted)', async () => {
  const f = fakeFetch(hang);
  const t0 = Date.now();
  const r = await new AsrEngine({ fetch: f, timeoutMs: 300 }).transcribe(CLIP, 'audio/wav', on({ engine: 'local' }));
  assert.equal(r.reason, 'timeout');
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(f.calls[0].signal.aborted, true);
});

test('local: the default timeout is local.timeoutSec', async () => {
  let seen = null;
  const eng = new AsrEngine({ fetch: async () => json({ text: 'x' }) });
  const orig = asr.PROVIDERS.local.timeoutMs;
  try {
    asr.PROVIDERS.local.timeoutMs = (cfg) => { seen = cfg.timeoutSec * 1000; return seen; };
    await eng.transcribe(CLIP, 'audio/wav', on({ engine: 'local', local: { timeoutSec: 45 } }));
  } finally {
    asr.PROVIDERS.local.timeoutMs = orig;
  }
  assert.equal(seen, 45000);
});

test('local: connection refused (server not running) -> network, through the real fetch', async () => {
  const srv = http.createServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  await new Promise((res) => srv.close(res));
  const r = await new AsrEngine().transcribe(CLIP, 'audio/wav', on({ engine: 'local', local: { endpoint: `http://127.0.0.1:${port}` } }));
  assert.equal(r.reason, 'network');
  assert.match(r.message, /ECONNREFUSED/);
});

test('local: the real fetch against a tiny OpenAI-shaped server (multipart arrives intact)', async () => {
  let got = null;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      got = { url: req.url, type: req.headers['content-type'], body: Buffer.concat(chunks).toString('latin1') };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: ' hello from the fake host\n' }));
    });
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  try {
    const r = await new AsrEngine().transcribe(CLIP, 'audio/webm', on({ engine: 'local', local: { endpoint: `http://127.0.0.1:${srv.address().port}` } }));
    assert.equal(r.text, 'hello from the fake host');
    assert.equal(got.url, '/v1/audio/transcriptions');
    assert.match(got.type, /^multipart\/form-data; boundary=/);
    assert.match(got.body, /name="file"; filename="clip.webm"/);
    assert.ok(got.body.includes(CLIP.toString('latin1')));
  } finally {
    srv.close();
  }
});

// ---- fallback and breaker ---------------------------------------------------------------------------------
test('fallback: local down -> LobeHub answers; without fallback the error stays', async () => {
  const f = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  const lh = { asr: async () => ({ code: 0, stdout: '{"text":"from lobehub"}', stderr: '' }) };
  const eng = new AsrEngine({ fetch: f, lh, tmpDir: tmpDir() });
  const r = await eng.transcribe(CLIP, 'audio/webm', on({ engine: 'local', fallback: true }));
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'lobehub');
  assert.equal(r.text, 'from lobehub');
  assert.deepEqual(r.fellBackFrom, [{ id: 'local', reason: 'network' }]);
  assert.equal(eng.stats.fellBack, 1);

  const alone = await new AsrEngine({ fetch: f, lh, tmpDir: tmpDir() }).transcribe(CLIP, 'audio/webm', on({ engine: 'local' }));
  assert.equal(alone.ok, false);
  assert.equal(alone.reason, 'network');
});

test('fallback: LobeHub logged out -> local answers; both failing reports the last reason and every try', async () => {
  const lh = { asr: async () => ({ code: 1, stdout: '', stderr: '12:00:00 [ERROR] ASR failed: UNAUTHORIZED' }) };
  const ok = await new AsrEngine({ lh, fetch: fakeFetch(() => json({ text: 'from local' })), tmpDir: tmpDir() }).transcribe(CLIP, 'audio/webm', on({ engine: 'lobehub', fallback: true }));
  assert.equal(ok.provider, 'local');
  assert.deepEqual(ok.fellBackFrom, [{ id: 'lobehub', reason: 'unauthorized' }]);

  const bad = await new AsrEngine({ lh, fetch: fakeFetch(() => new Response('x', { status: 503 })), tmpDir: tmpDir() }).transcribe(CLIP, 'audio/webm', on({ engine: 'lobehub', fallback: true }));
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'http-503');
  assert.deepEqual(bad.tried.map((t) => [t.id, t.reason]), [['lobehub', 'unauthorized'], ['local', 'http-503']]);
});

test('fallback: an empty clip is not sent to the other provider (it would not hear more)', async () => {
  let lhCalls = 0;
  const lh = { asr: async () => { lhCalls++; return { code: 0, stdout: '{"text":"x"}', stderr: '' }; } };
  const r = await new AsrEngine({ lh, fetch: fakeFetch(() => json({ text: ' [BLANK_AUDIO]\n' })), tmpDir: tmpDir() }).transcribe(CLIP, 'audio/wav', on({ engine: 'local', fallback: true }));
  assert.equal(r.reason, 'empty');
  assert.equal(lhCalls, 0);
});

test('breaker: a refusing provider is skipped while paused, but the last one in the chain is always tried', async () => {
  let t = 1000;
  let lhCalls = 0;
  const lh = { asr: async () => { lhCalls++; return { code: 1, stdout: '', stderr: 'ASR failed: UNAUTHORIZED' }; } };
  const f = fakeFetch(() => json({ text: 'local' }));
  const eng = new AsrEngine({ lh, fetch: f, tmpDir: tmpDir(), now: () => t });
  const set = on({ engine: 'lobehub', fallback: true });
  await eng.transcribe(CLIP, 'audio/wav', set);
  assert.equal(lhCalls, 1);
  assert.equal(eng.status().lobehub.paused, true);
  assert.equal(eng.status().lobehub.reason, 'unauthorized');
  const r2 = await eng.transcribe(CLIP, 'audio/wav', set);
  assert.equal(lhCalls, 1); // skipped
  assert.equal(r2.provider, 'local');
  assert.deepEqual(r2.fellBackFrom, [{ id: 'lobehub', reason: 'unauthorized', skipped: true }]);
  // alone in its chain it is still tried: the owner asked for an answer
  await eng.transcribe(CLIP, 'audio/wav', on({ engine: 'lobehub' }));
  assert.equal(lhCalls, 2);
  t += asr.BREAKER_MS + 1;
  await eng.transcribe(CLIP, 'audio/wav', set);
  assert.equal(lhCalls, 3); // pause over
  eng.reset();
  assert.equal(eng.status().lobehub.paused, false);
});

test('engine: off / disabled -> not-configured without calling anything; bad audio refused up front', async () => {
  let calls = 0;
  const eng = new AsrEngine({ lh: { asr: async () => { calls++; } }, fetch: async () => { calls++; } });
  assert.equal((await eng.transcribe(CLIP, 'audio/wav', normalizeAsr({ engine: 'lobehub' }))).reason, 'not-configured');
  assert.equal((await eng.transcribe(CLIP, 'audio/wav', on({ engine: 'off' }))).reason, 'not-configured');
  assert.equal((await eng.transcribe(Buffer.alloc(0), 'audio/wav', on())).reason, 'bad-audio');
  assert.equal((await eng.transcribe(CLIP, 'image/png', on())).reason, 'bad-audio');
  assert.equal(calls, 0);
});

test('engine: logs only provider, reason, time and size — never the text', async () => {
  const lines = [];
  const eng = new AsrEngine({ fetch: fakeFetch(() => json({ text: 'secret words' })), log: (r) => lines.push(r) });
  await eng.transcribe(CLIP, 'audio/wav', on({ engine: 'local' }));
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(lines[0]).sort(), ['asr', 'bytes', 'ms', 'ok']);
  assert.ok(!JSON.stringify(lines).includes('secret'));
});

// ---- connection test -------------------------------------------------------------------------------------
test('test(): sends a silent WAV; an empty answer counts as reachable; failures carry the reason', async () => {
  const f = fakeFetch(() => json({ text: ' [BLANK_AUDIO]\n' }));
  const eng = new AsrEngine({ fetch: f, lh: { asr: async () => ({ code: 1, stdout: '', stderr: 'ASR failed: UNAUTHORIZED' }) }, tmpDir: tmpDir() });
  const r = await eng.test(on({ engine: 'local', fallback: true }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.results.map((x) => [x.provider, x.ok, x.reason]), [['local', true, undefined], ['lobehub', false, 'unauthorized']]);
  assert.equal(f.calls[0].fields.file.type, 'audio/wav');
  assert.equal(f.calls[0].fields.file.bytes.toString('ascii', 0, 4), 'RIFF');
  const only = await eng.test(on({ engine: 'off' }), { only: 'local' });
  assert.equal(only.ok, true);
  assert.equal((await eng.test(on({ engine: 'off' }))).reason, 'not-configured');
});

// ---- the service behind the IPC (main.js asr-transcribe / asr-test / set-asr) ------------------------------
test('PetService: setAsr saves, validates and resets the breaker; asrTranscribe / asrTest use settings.asr', async () => {
  const { PetService } = require('../src/main/pet-service');
  const { Store } = require('../src/core/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-svc-'));
  const f = fakeFetch(() => json({ text: ' hi there\n' }));
  const engine = new AsrEngine({ fetch: f });
  const store = new settingsLib.MemorySettingsStore();
  const svc = new PetService({ lh: {}, store: new Store(dir), settingsStore: store, asr: engine });
  assert.equal((await svc.asrTranscribe(CLIP, 'audio/webm')).reason, 'not-configured'); // off by default
  engine.health.local = { until: Date.now() + 99999, reason: 'network', at: 0 };
  const r = svc.setAsr({ enabled: true, engine: 'local', local: { endpoint: 'http://127.0.0.1:8179' } });
  assert.equal(r.ok, true);
  assert.equal(store.load().asr.engine, 'local'); // saved
  assert.deepEqual(engine.health, {}); // reset
  assert.equal(r.settings.asrStatus.local.paused, false);
  const t = await svc.asrTranscribe(new Uint8Array(CLIP).buffer, 'audio/webm;codecs=opus', { ms: 1200 });
  assert.equal(t.ok, true);
  assert.equal(t.text, 'hi there');
  const probe = await svc.asrTest();
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.results.map((x) => x.provider), ['local']);
  const bad = svc.setAsr({ local: { endpoint: 'http://evil.example.com' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-endpoint');
  assert.equal(store.load().asr.local.endpoint, 'http://127.0.0.1:8179');
  svc.setAsr({ enabled: false });
  assert.equal((await svc.asrTranscribe(CLIP, 'audio/webm')).reason, 'not-configured');
});
