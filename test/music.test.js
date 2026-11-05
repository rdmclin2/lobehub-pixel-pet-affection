'use strict';
// core/music.js (T-5088): MiniMax music generation — submit → wait → save, errors, cancel, settings. fetch is mocked;
// no real key is used anywhere (FAKE_KEY is a placeholder).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const music = require('../src/core/music');
const settingsLib = require('../src/core/settings');
const schema = require('../src/core/settings-schema');

const FAKE_KEY = 'test-key-not-real-0000';
const AUDIO = Buffer.from('ID3fake-mp3-bytes-for-tests');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'music-test-'));
// MiniMax direct (music.provider 'minimax'); fal / ElevenLabs have their own tests in music-providers.test.js
const MM = settingsLib.normalizeSettings({ music: { provider: 'minimax' } });
const cfgFor = (dir, extra = {}) => ({ ...music.resolveConfig({ settings: MM, key: FAKE_KEY, env: {}, userDataDir: dir }), ...extra });
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });
const bin = (buf, status = 200) => ({ ok: status === 200, status, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), headers: { get: (h) => (h === 'content-length' ? String(buf.length) : null) } });
const ok = (data, extra = {}) => json({ data, trace_id: 'trace-1', extra_info: { music_duration: 25364, music_sample_rate: 44100, music_channel: 2, bitrate: 256000, music_size: AUDIO.length }, base_resp: { status_code: 0, status_msg: 'success' }, ...extra });
const err = (code, msg = 'x') => json({ base_resp: { status_code: code, status_msg: msg } });
const SONG = { title: '晚风/Night Breeze', prompt: '温柔的城市民谣，夏夜海边', mood: '放松', bpm: 90, lyrics: '[Verse]\n晚风吹过街角\n[Chorus]\n我们一起唱' };

// a fetch that answers from a queue and records each call
function mockFetch(answers) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    return typeof a === 'function' ? a(url, init) : a;
  };
  f.calls = calls;
  return f;
}
// never answers, but rejects when its signal aborts (like real fetch)
const hangingFetch = () => (url, { signal } = {}) => new Promise((_, reject) => signal && signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

test('success (sync, url): POSTs /v1/music_generation with Bearer key and the documented body, downloads and writes <time>-<title>.mp3', async () => {
  const dir = tmpDir();
  const fetch = mockFetch([ok({ status: 2, audio: 'https://cdn.example.com/song.mp3' }), bin(AUDIO)]);
  const progress = [];
  const out = await music.generateMusic(SONG, { config: cfgFor(dir), fetch, now: () => new Date(2026, 10, 4, 15, 30, 12).getTime(), onProgress: (p) => progress.push(p.stage) });
  const [post, dl] = fetch.calls;
  assert.equal(post.url, 'https://api.minimax.cn/v1/music_generation');
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(post.body.model, 'music-3.0');
  assert.equal(post.body.stream, false);
  assert.equal(post.body.output_format, 'url');
  assert.deepEqual(post.body.audio_setting, { sample_rate: 44100, bitrate: 256000, format: 'mp3' });
  assert.equal(post.body.lyrics, SONG.lyrics);
  assert.match(post.body.prompt, /^温柔的城市民谣，夏夜海边\. Mood: 放松\. Tempo: 90 BPM$/);
  assert.equal(post.body.is_instrumental, undefined);
  assert.equal(dl.url, 'https://cdn.example.com/song.mp3');
  assert.equal(out.filePath, path.join(dir, 'music', '20261104-153012-晚风-Night-Breeze.mp3'));
  assert.deepEqual(fs.readFileSync(out.filePath), AUDIO);
  assert.equal(fileURLToPath(out.fileUrl), out.filePath);
  assert.ok(out.fileUrl.startsWith('file://'));
  assert.equal(out.durationMs, 25364);
  assert.equal(out.meta.model, 'music-3.0');
  assert.equal(out.meta.traceId, 'trace-1');
  assert.equal(out.meta.source, 'url');
  assert.equal(out.meta.bytes, AUDIO.length);
  assert.deepEqual(progress, ['submitting', 'downloading', 'saved']);
  assert.ok(!fs.readdirSync(path.join(dir, 'music')).some((f) => f.endsWith('.part')), 'no temp file left');
});

test('success (sync, hex): the hex audio is decoded and written; no second request; same name twice gets -2', async () => {
  const dir = tmpDir();
  const cfg = cfgFor(dir, { outputFormat: 'hex' });
  const now = () => new Date(2026, 0, 2, 3, 4, 5).getTime();
  const fetch = mockFetch([ok({ status: 2, audio: AUDIO.toString('hex') })]);
  const a = await music.generateMusic({ prompt: 'lofi chill beat', instrumental: true, title: 'Study' }, { config: cfg, fetch, now });
  const b = await music.generateMusic({ prompt: 'lofi chill beat', instrumental: true, title: 'Study' }, { config: cfg, fetch, now });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].body.output_format, 'hex');
  assert.equal(fetch.calls[0].body.is_instrumental, true);
  assert.equal(path.basename(a.filePath), '20260102-030405-Study.mp3');
  assert.equal(path.basename(b.filePath), '20260102-030405-Study-2.mp3');
  assert.deepEqual(fs.readFileSync(a.filePath), AUDIO);
  assert.equal(a.meta.source, 'hex');
  assert.equal(a.meta.instrumental, true);
});

test('async task: a task_id answer is polled until it succeeds (pending ×2 → success), then saved', async () => {
  const dir = tmpDir();
  const fetch = mockFetch([
    json({ task_id: 'task-42', base_resp: { status_code: 0 } }),
    json({ data: { status: 1 }, base_resp: { status_code: 0 } }),
    json({ data: { status: 'Processing' }, base_resp: { status_code: 0 } }),
    json({ data: { status: 2, audio: AUDIO.toString('hex') }, extra_info: { music_duration: 30000 }, base_resp: { status_code: 0 } }),
  ]);
  const client = music.createMusicClient(cfgFor(dir, { pollIntervalMs: 5 }), { fetch });
  const task = await client.submit({ prompt: 'epic orchestral', instrumental: true });
  assert.equal(task.mode, 'async');
  assert.equal(task.status, 'pending');
  assert.equal(task.id, 'task-42');
  const polls = [];
  const result = await client.wait(task, { onProgress: (p) => polls.push(p.attempt) });
  assert.deepEqual(polls, [1, 2, 3]);
  assert.equal(fetch.calls[1].url, 'https://api.minimax.cn/v1/query/music_generation?task_id=task-42');
  assert.equal(fetch.calls[1].init.method, 'GET');
  assert.equal(task.status, 'succeeded');
  const out = await client.save(task, result);
  assert.deepEqual(fs.readFileSync(out.filePath), AUDIO);
  assert.equal(out.durationMs, 30000);
  assert.equal(out.meta.mode, 'async');
});

test('sync task through the same interface: submit returns a done task, wait returns its result without a request', async () => {
  const fetch = mockFetch([ok({ status: 2, audio: AUDIO.toString('hex') })]);
  const client = music.createMusicClient(cfgFor(tmpDir()), { fetch });
  const task = await client.submit({ prompt: 'piano', instrumental: true });
  assert.equal(task.mode, 'sync');
  assert.equal(task.status, 'succeeded');
  const r = await client.wait(task);
  assert.equal(r.audioHex, AUDIO.toString('hex'));
  assert.equal(fetch.calls.length, 1);
});

test('task failed: a failed status while polling throws task-failed and writes nothing', async () => {
  const dir = tmpDir();
  const fetch = mockFetch([json({ task_id: 't1', base_resp: { status_code: 0 } }), json({ data: { status: 'Fail', error: 'generation failed' }, base_resp: { status_code: 0 } })]);
  const cfg = cfgFor(dir, { pollIntervalMs: 5 });
  await assert.rejects(music.generateMusic({ prompt: 'x', instrumental: true }, { config: cfg, fetch }), (e) => e instanceof music.MusicError && e.reason === 'task-failed' && /音乐生成失败：generation failed/.test(e.message));
  assert.equal(fs.existsSync(path.join(dir, 'music')), false);
});

test('timeout: a POST that never answers is given up at the deadline (reason timeout); a task that stays pending times out too', async () => {
  const cfg = cfgFor(tmpDir(), { timeoutMs: 60 });
  const t0 = Date.now();
  await assert.rejects(music.generateMusic({ prompt: 'x', instrumental: true }, { config: cfg, fetch: hangingFetch() }), (e) => e.reason === 'timeout' && /超时/.test(e.message));
  assert.ok(Date.now() - t0 < 2000);
  // a fetch that ignores its signal is let go as well
  await assert.rejects(music.generateMusic({ prompt: 'x', instrumental: true }, { config: cfg, fetch: () => new Promise(() => {}) }), (e) => e.reason === 'timeout');
  const pending = mockFetch([json({ task_id: 't2', base_resp: { status_code: 0 } }), json({ data: { status: 1 }, base_resp: { status_code: 0 } })]);
  await assert.rejects(music.generateMusic({ prompt: 'x', instrumental: true }, { config: { ...cfg, timeoutMs: 80, pollIntervalMs: 10 }, fetch: pending }), (e) => e.reason === 'timeout');
  assert.ok(pending.calls.length >= 3, `polled ${pending.calls.length} times`);
});

test('auth: 1004 / 2049 and HTTP 401 are 鉴权失败 with the code', async () => {
  const cfg = cfgFor(tmpDir());
  for (const code of [1004, 2049]) {
    await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([err(code, 'invalid api key')]) }), (e) => e.reason === 'auth' && e.code === code && /API Key/.test(e.message) && e.message.includes(`错误码 ${code}`));
  }
  await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([json({}, 401)]) }), (e) => e.reason === 'auth' && e.code === 'http-401');
});

test('rate limit: 1002 / 1039 and HTTP 429 are 限流', async () => {
  const cfg = cfgFor(tmpDir());
  for (const code of [1002, 1039]) {
    await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([err(code)]) }), (e) => e.reason === 'rate-limit' && e.code === code && /限流/.test(e.message));
  }
  await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([json({}, 429)]) }), (e) => e.reason === 'rate-limit' && e.code === 'http-429');
});

test('other MiniMax codes: 1026 sensitive, 1008 balance, 2013 bad params, unknown code keeps its message', async () => {
  const cfg = cfgFor(tmpDir());
  const cases = [[1026, 'sensitive', /敏感/], [1008, 'balance', /余额/], [2013, 'bad-params', /参数/], [2069, 'model', /模型/], [9999, 'server', /MiniMax 返回错误：weird/]];
  for (const [code, reason, re] of cases) {
    await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([err(code, 'weird')]) }), (e) => e.reason === reason && e.code === code && re.test(e.message), String(code));
  }
});

test('HTTP 410 + base_resp 2153 (closed to new users, seen live 2026-11-04) is reason unavailable with the code, not a bare HTTP 410', async () => {
  const cfg = cfgFor(tmpDir());
  const gone = json({ base_resp: { status_code: 2153, status_msg: 'This Music API is no longer available to new users.' }, trace_id: 't-410' }, 410);
  await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([gone]) }), (e) => e.reason === 'unavailable' && e.code === 2153 && e.status === 410 && e.traceId === 't-410' && /不再向新用户开放/.test(e.message));
  // a non-2xx answer whose body is not JSON still reads as the HTTP status
  const broken = { ok: false, status: 503, json: async () => { throw new Error('not json'); }, headers: { get: () => null } };
  await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([broken]) }), (e) => e.reason === 'server' && e.code === 'http-503');
});

test('network error: a fetch that throws is 连不上 MiniMax (reason network); a failed download is reason download', async () => {
  const cfg = cfgFor(tmpDir());
  await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: async () => { throw new TypeError('fetch failed'); } }), (e) => e.reason === 'network' && /连不上 MiniMax：fetch failed/.test(e.message));
  await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([ok({ status: 2, audio: 'https://cdn.example.com/a.mp3' }), bin(Buffer.alloc(0), 404)]) }), (e) => e.reason === 'download' && e.code === 'http-404');
  await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: mockFetch([json({}, 502)]) }), (e) => e.reason === 'server' && e.code === 'http-502');
});

test('cancel: an AbortSignal stops the POST, a poll wait and an already-aborted job (reason aborted)', async () => {
  const cfg = cfgFor(tmpDir(), { pollIntervalMs: 10_000 });
  const ac = new AbortController();
  const p = music.generateMusic(SONG, { config: cfg, fetch: hangingFetch(), signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (e) => e.reason === 'aborted' && /已取消/.test(e.message));

  const ac2 = new AbortController();
  const fetch = mockFetch([json({ task_id: 't3', base_resp: { status_code: 0 } }), json({ data: { status: 1 }, base_resp: { status_code: 0 } })]);
  const t0 = Date.now();
  const p2 = music.generateMusic(SONG, { config: cfg, fetch, signal: ac2.signal, onProgress: (e) => { if (e.stage === 'polling') ac2.abort(); } });
  await assert.rejects(p2, (e) => e.reason === 'aborted');
  assert.ok(Date.now() - t0 < 2000, 'did not wait out the 10 s poll interval');

  const ac3 = new AbortController();
  ac3.abort();
  const f3 = mockFetch([ok({ status: 2, audio: AUDIO.toString('hex') })]);
  await assert.rejects(music.generateMusic(SONG, { config: cfg, fetch: f3, signal: ac3.signal }), (e) => e.reason === 'aborted');
  assert.equal(f3.calls.length, 0);
});

test('download writes the file: url audio lands in a configured outputDir, created if missing', async () => {
  const base = tmpDir();
  const outDir = path.join(base, 'nested', 'songs');
  const cfg = music.resolveConfig({ settings: { music: { provider: 'minimax', outputDir: outDir } }, key: FAKE_KEY, env: {}, userDataDir: base });
  assert.equal(cfg.outputDir, outDir);
  const out = await music.generateMusic({ prompt: 'jazz', instrumental: true, title: '' }, { config: cfg, fetch: mockFetch([ok({ status: 2, audio: 'https://cdn.example.com/j.mp3' }), bin(AUDIO)]) });
  assert.equal(path.dirname(out.filePath), outDir);
  assert.match(path.basename(out.filePath), /^\d{8}-\d{6}-music\.mp3$/);
  assert.deepEqual(fs.readFileSync(out.filePath), AUDIO);
});

test('parameters: lyrics / instrumental / optimizer rules, structure tags, hints, audio settings and limits follow the docs', () => {
  const b = (p, c) => music.buildRequest(p, c).body;
  // instrumental uses the native field and needs a prompt; lyrics are dropped with a warning
  assert.throws(() => b({ instrumental: true }), /纯音乐需要 prompt/);
  const r = music.buildRequest({ prompt: 'ambient', instrumental: true, lyrics: '[Verse]\nla' });
  assert.equal(r.body.is_instrumental, true);
  assert.equal(r.body.lyrics, undefined);
  assert.match(r.warnings[0], /忽略 lyrics/);
  // a song with vocals needs lyrics, unless lyricsOptimizer writes them from the prompt
  assert.throws(() => b({ prompt: 'pop' }), /需要 lyrics/);
  assert.equal(b({ prompt: 'pop', lyricsOptimizer: true }).lyrics_optimizer, true);
  // structure tags in lyrics are checked against the documented list (loosely: [chorus], [Verse 2], [Pre-Chorus])
  assert.doesNotThrow(() => b({ lyrics: '[Intro]\n[verse 2]\nla\n[Pre-Chorus]\nla\n[CHORUS]\nla\n[Build Up]\n[Outro]' }));
  assert.throws(() => b({ lyrics: '[Rap]\nyo' }), /不认识的段落标签 \[Rap\]/);
  // duration / structure / bpm / genre have no API field: they go into the prompt
  const p = b({ prompt: 'cyberpunk', instrumental: true, genre: 'synthwave', mood: 'tense', scene: 'night city', instruments: 'analog synth', bpm: 128, durationSec: 120, structure: ['Intro', 'build up', '[Solo]', 'Outro'] }).prompt;
  assert.equal(p, 'cyberpunk. Genre: synthwave. Mood: tense. Scene: night city. Instruments: analog synth. Tempo: 128 BPM. Length: about 120 seconds. Structure: Intro - Build Up - Solo - Outro');
  assert.throws(() => b({ prompt: 'x', instrumental: true, structure: ['Verse', 'Rap'] }), /不认识的段落「Rap」/);
  assert.throws(() => b({ prompt: 'x', instrumental: true, bpm: 500 }), /bpm 需要 40–240/);
  assert.throws(() => b({ prompt: 'x', instrumental: true, durationSec: 5 }), /durationSec 需要 10–360/);
  // lengths: prompt 2000, lyrics 3500
  assert.throws(() => b({ prompt: 'a'.repeat(2001), instrumental: true }), /prompt 太长了（最多 2000 字）/);
  assert.doesNotThrow(() => b({ prompt: 'a'.repeat(2000), instrumental: true }));
  assert.throws(() => b({ lyrics: 'a'.repeat(3501) }), /lyrics 太长了（最多 3500 字）/);
  assert.throws(() => b({ prompt: 'a'.repeat(1990), instrumental: true, bpm: 100 }), /太长了/);
  // audio settings and model
  const a = b({ prompt: 'x', instrumental: true, format: 'wav', sampleRate: 32000, bitrate: 128000, model: 'music-2.6', outputFormat: 'hex', watermark: true });
  assert.deepEqual(a.audio_setting, { sample_rate: 32000, bitrate: 128000, format: 'wav' });
  assert.equal(a.model, 'music-2.6');
  assert.equal(a.output_format, 'hex');
  assert.equal(a.aigc_watermark, true);
  assert.throws(() => b({ prompt: 'x', instrumental: true, format: 'ogg' }), /format 只能是/);
  assert.throws(() => b({ prompt: 'x', instrumental: true, sampleRate: 48000 }), /sampleRate 只能是/);
  assert.throws(() => b({ prompt: 'x', instrumental: true, bitrate: 320000 }), /bitrate 只能是/);
  assert.throws(() => b({ prompt: 'x', instrumental: true, model: 'music-cover' }), /不支持的模型/);
  assert.throws(() => b(null), /缺少创作参数/);
});

test('bad params are refused before any request (reason bad-params, no fetch)', async () => {
  const fetch = mockFetch([ok({ status: 2, audio: 'aa' })]);
  await assert.rejects(music.generateMusic({ prompt: 'pop' }, { config: cfgFor(tmpDir()), fetch }), (e) => e.reason === 'bad-params');
  assert.equal(fetch.calls.length, 0);
});

test('config: key from keys.minimax, else MINIMAX_API_KEY; endpoint from settings, MINIMAX_MUSIC_ENDPOINT, the TTS MiniMax endpoint, the default; https only', async () => {
  const s = MM;
  assert.equal(music.resolveConfig({ settings: s, key: FAKE_KEY, env: { MINIMAX_API_KEY: 'env-key-placeholder' } }).apiKey, FAKE_KEY);
  assert.equal(music.resolveConfig({ settings: s, key: '', env: { MINIMAX_API_KEY: 'env-key-placeholder' } }).apiKey, 'env-key-placeholder');
  assert.equal(music.resolveConfig({ settings: s, env: {} }).endpoint, 'https://api.minimax.cn');
  assert.equal(music.resolveConfig({ settings: s, env: { MINIMAX_MUSIC_ENDPOINT: 'https://api.minimax.io/' } }).endpoint, 'https://api.minimax.io');
  const withTts = settingsLib.normalizeSettings({ music: { provider: 'minimax' }, tts: { endpoints: { minimax: 'https://api.minimax.io' } } });
  assert.equal(music.resolveConfig({ settings: withTts, env: {} }).endpoint, 'https://api.minimax.io');
  const own = settingsLib.normalizeSettings({ music: { provider: 'minimax', endpoint: 'https://proxy.example.com' } });
  assert.equal(music.resolveConfig({ settings: own, env: { MINIMAX_MUSIC_ENDPOINT: 'https://api.minimax.io' } }).endpoint, 'https://proxy.example.com');
  assert.throws(() => music.resolveConfig({ settings: s, env: { MINIMAX_MUSIC_ENDPOINT: 'http://api.minimax.io' } }), (e) => e.reason === 'bad-endpoint');
  assert.equal(settingsLib.normalizeSettings({ music: { endpoint: 'http://api.minimax.cn' } }).music.endpoint, '', 'http is dropped');
  assert.equal(music.resolveConfig({ settings: s, env: {}, userDataDir: '/data' }).outputDir, path.join('/data', 'music'));
  // no key → no-key before any request
  const fetch = mockFetch([ok({ status: 2, audio: 'aa' })]);
  await assert.rejects(music.generateMusic(SONG, { settings: s, key: '', env: {}, userDataDir: tmpDir(), fetch }), (e) => e.reason === 'no-key' && /MINIMAX_API_KEY/.test(e.message));
  assert.equal(fetch.calls.length, 0);
});

test('settings: settings.music defaults (provider fal) and normalisation; every music key has a console field on the 音乐创作 page; patches go to setSection (nested for fal / elevenlabs)', () => {
  const d = settingsLib.normalizeSettings(null).music;
  assert.deepEqual(d, {
    enabled: true, provider: 'fal', endpoint: '', model: 'music-3.0', outputDir: '', outputFormat: 'url', format: 'mp3', sampleRate: 44100, bitrate: 256000, timeoutSec: 600, pollIntervalSec: 3,
    fal: { endpoint: '', model: 'fal-ai/minimax-music/v2.6' },
    elevenlabs: { endpoint: '', model: 'music_v2_5', outputFormat: 'mp3_44100_128' },
  });
  const n = settingsLib.normalizeSettings({ music: { provider: 'suno', model: 'nope', format: 'ogg', sampleRate: 1, timeoutSec: 99999, pollIntervalSec: 0, outputDir: 'relative/dir', outputFormat: 'x', fal: { model: 'fal-ai/minimax-music/v2', endpoint: 'http://queue.fal.run' }, elevenlabs: { model: 'music_v9', outputFormat: 'wav', endpoint: 'ftp://x' } } }).music;
  assert.deepEqual(n, d);
  assert.equal(settingsLib.normalizeSettings({ music: { provider: 'elevenlabs' } }).music.provider, 'elevenlabs');
  assert.equal(settingsLib.normalizeSettings({ music: { provider: 'minimax' } }).music.provider, 'minimax');
  for (const k of schema.settingsLeaves(d, 'music')) {
    const f = schema.field(k);
    assert.ok(f, k);
    assert.equal(f.page, 'music');
    const parts = k.split('.').slice(1);
    const v = parts.reduce((o, p) => o[p], d);
    const patch = parts.reduceRight((acc, p) => ({ [p]: acc }), v);
    assert.deepEqual(schema.patchFor(k, v), { setter: 'setSection', section: 'music', patch });
  }
  assert.ok(schema.PAGES.music);
  assert.deepEqual(schema.validate('music.endpoint', 'http://api.minimax.cn'), { ok: false, reason: 'bad-endpoint-https', message: '地址不合法：必须是 https，不能带账号密码' });
  assert.equal(schema.validate('music.endpoint', 'https://api.minimax.io').ok, true);
  assert.equal(schema.validate('music.fal.endpoint', 'http://queue.fal.run').ok, false);
  assert.equal(schema.validate('music.elevenlabs.endpoint', 'https://api.us.elevenlabs.io').ok, true);
  assert.equal(schema.validate('music.provider', 'elevenlabs').ok, true);
  assert.equal(schema.validate('music.provider', 'suno').ok, false);
  assert.equal(schema.validate('music.fal.model', 'fal-ai/minimax-music/v2.5').ok, true);
  assert.equal(schema.validate('music.elevenlabs.model', 'music_v2').ok, true);
  assert.equal(schema.validate('music.outputDir', 'relative').ok, false);
  assert.equal(schema.validate('music.outputDir', '/Users/me/Music').ok, true);
  assert.equal(schema.validate('music.timeoutSec', 10).ok, false);
  assert.equal(schema.validate('music.model', 'music-2.6').ok, true);
  // keys.fal: a write-only secret on the 音乐创作 page, shown only when fal is picked
  const kf = schema.field('keys.fal');
  assert.deepEqual({ type: kf.type, store: kf.store, page: kf.page, dependsOn: kf.dependsOn }, { type: 'secret', store: 'keys', page: 'music', dependsOn: { key: 'music.provider', value: 'fal' } });
  assert.deepEqual(schema.field('music.fal.model').dependsOn, { key: 'music.provider', value: 'fal' });
  assert.deepEqual(schema.field('music.elevenlabs.model').dependsOn, { key: 'music.provider', value: 'elevenlabs' });
  assert.deepEqual(schema.field('music.model').dependsOn, { key: 'music.provider', value: 'minimax' });
});

test('a plain node script waits for the deadline and the polls (the timers keep it alive): timeout and poll results arrive', () => {
  const { execFileSync } = require('node:child_process');
  const src = `const m = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'music.js'))});
    const cfg = { ...m.resolveConfig({ settings: { music: { provider: 'minimax' } }, key: 'placeholder', env: {}, userDataDir: require('node:os').tmpdir() }), timeoutMs: 80, pollIntervalMs: 20 };
    const hang = (u, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
    let n = 0;
    const poll = async (u) => ({ ok: true, status: 200, json: async () => (u.includes('/query/') ? (++n < 3 ? { data: { status: 1 } } : { data: { status: 2, audio: 'abcd' } }) : { task_id: 't' }) });
    (async () => {
      try { await m.generateMusic({ prompt: 'x', instrumental: true }, { config: cfg, fetch: hang }); } catch (e) { console.log('T:' + e.reason); }
      const c = m.createMusicClient({ ...cfg, timeoutMs: 5000 }, { fetch: poll });
      const r = await c.wait(await c.submit({ prompt: 'x', instrumental: true }));
      console.log('P:' + r.audioHex + ':' + n);
    })();`;
  const out = execFileSync(process.execPath, ['-e', src], { encoding: 'utf8', timeout: 10000 });
  assert.match(out, /T:timeout/);
  assert.match(out, /P:abcd:3/);
});

test('no real key is committed: module, test and settings only hold placeholders', () => {
  for (const f of ['src/core/music.js', 'test/music.test.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}/, f);
  }
});

// ==== T-5651: switchable services — fal.ai (MiniMax Music on fal's queue) and ElevenLabs Music ==================
// fetch is mocked per URL; no network, FAKE_KEY only.
const FAL_EP = 'https://queue.fal.run';
const EL_EP = 'https://api.elevenlabs.io';
const falCfg = (dir, extra = {}) => ({ ...music.resolveConfig({ settings: settingsLib.normalizeSettings({ music: { provider: 'fal' } }), key: FAKE_KEY, env: {}, userDataDir: dir }), pollIntervalMs: 5, ...extra });
const elCfg = (dir, extra = {}) => ({ ...music.resolveConfig({ settings: settingsLib.normalizeSettings({ music: { provider: 'elevenlabs' } }), key: FAKE_KEY, env: {}, userDataDir: dir }), ...extra });
const REQ = 'req-123';
const FAL_BASE = `${FAL_EP}/fal-ai/minimax-music/requests/${REQ}`;
const submitted = () => json({ request_id: REQ, status_url: `${FAL_BASE}/status`, response_url: FAL_BASE, cancel_url: `${FAL_BASE}/cancel`, queue_position: 2 });
const falResult = () => json({ audio: { url: 'https://v3.fal.media/files/x/song.mp3', content_type: 'audio/mpeg', file_name: 'song.mp3', file_size: AUDIO.length } });
// a fal queue: statuses in order (the last repeats), then the result; records every call
function falFetch({ submit = submitted, statuses = [{ status: 'COMPLETED' }], result = falResult, download = () => bin(AUDIO), cancel = () => json({ status: 'CANCELLATION_REQUESTED' }, 202) } = {}) {
  const calls = [];
  let polls = 0;
  const f = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (method === 'POST') return submit(url, init);
    if (method === 'PUT' && url.endsWith('/cancel')) return cancel();
    if (url.endsWith('/status')) { const s = statuses[Math.min(polls++, statuses.length - 1)]; return typeof s === 'function' ? s(url, init) : json(s, 202); }
    if (url === FAL_BASE) return result(url, init);
    return download(url, init);
  };
  f.calls = calls;
  f.polls = () => polls;
  return f;
}

test('fal: success — POST queue.fal.run/fal-ai/minimax-music/v2.6 with Authorization: Key, poll status, fetch the result, download (no key sent to the CDN), save under <userData>/music', async () => {
  const dir = tmpDir();
  const f = falFetch();
  const stages = [];
  const r = await music.generateMusic({ ...SONG, durationSec: 90, structure: ['Verse', 'Chorus'] }, { config: falCfg(dir), fetch: f, onProgress: (p) => stages.push(p.stage) });
  const [post, status, result, dl] = f.calls;
  assert.equal(post.url, `${FAL_EP}/fal-ai/minimax-music/v2.6`);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers.Authorization, `Key ${FAKE_KEY}`);
  assert.equal(post.body.lyrics, SONG.lyrics);
  assert.match(post.body.prompt, /^温柔的城市民谣，夏夜海边\. Mood: 放松\. Tempo: 90 BPM\. Length: about 90 seconds\. Structure: Verse - Chorus$/);
  assert.deepEqual(post.body.audio_setting, { sample_rate: 44100, bitrate: 256000, format: 'mp3' });
  assert.equal(post.body.is_instrumental, undefined);
  assert.deepEqual([status.url, status.method, status.headers.Authorization], [`${FAL_BASE}/status`, 'GET', `Key ${FAKE_KEY}`]);
  assert.equal(result.url, FAL_BASE);
  assert.equal(dl.url, 'https://v3.fal.media/files/x/song.mp3');
  assert.equal(dl.headers.Authorization, undefined, 'the key never goes to the CDN');
  assert.equal(path.dirname(r.filePath), path.join(dir, 'music'));
  assert.match(path.basename(r.filePath), /^\d{8}-\d{6}-晚风-Night-Breeze\.mp3$/);
  assert.deepEqual(fs.readFileSync(r.filePath), AUDIO);
  assert.equal(fileURLToPath(r.fileUrl), r.filePath);
  assert.equal(r.durationMs, undefined, 'fal does not say how long the song is');
  assert.deepEqual([r.meta.provider, r.meta.model, r.meta.taskId, r.meta.mode, r.meta.format], ['fal', 'fal-ai/minimax-music/v2.6', REQ, 'async', 'mp3']);
  // the fields fal has no field for are reported, not dropped
  assert.deepEqual(r.meta.mapping.native, ['prompt', 'lyrics', 'title']);
  assert.deepEqual(r.meta.mapping.prompt, ['mood', 'bpm', 'durationSec', 'structure']);
  assert.deepEqual(r.meta.unsupported, [{ field: 'bpm', how: 'prompt-hint' }, { field: 'durationSec', how: 'prompt-hint' }, { field: 'structure', how: 'prompt-hint' }]);
  assert.deepEqual(stages, ['submitting', 'submitted', 'polling', 'downloading', 'saved']);
});

test('fal: several polls — IN_QUEUE ×2 → IN_PROGRESS ×2 → COMPLETED, every pollIntervalMs; progress says queued / running; instrumental maps to is_instrumental', async () => {
  const dir = tmpDir();
  const f = falFetch({ statuses: [{ status: 'IN_QUEUE', queue_position: 3 }, { status: 'IN_QUEUE', queue_position: 1 }, { status: 'IN_PROGRESS' }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED' }] });
  const seen = [];
  const t0 = Date.now();
  const r = await music.generateMusic({ prompt: 'calm lo-fi piano for studying', instrumental: true, lyrics: 'ignored', title: 'Study' }, { config: falCfg(dir, { pollIntervalMs: 20 }), fetch: f, onProgress: (p) => seen.push(p.stage === 'queued' ? `q${p.queuePosition}` : p.stage) });
  assert.equal(f.polls(), 5);
  assert.ok(Date.now() - t0 >= 4 * 20 - 5, 'waited between polls');
  assert.deepEqual(seen, ['submitting', 'submitted', 'q3', 'q1', 'running', 'running', 'polling', 'downloading', 'saved']);
  assert.equal(f.calls[0].body.is_instrumental, true);
  assert.equal(f.calls[0].body.lyrics, undefined);
  assert.deepEqual(r.meta.warnings, ['纯音乐模式不使用歌词，已忽略 lyrics']);
  assert.equal(r.meta.instrumental, true);
});

test('fal: failures — COMPLETED with an error, content_policy_violation (422 on the result), no audio url; nothing is written', async () => {
  const dir = tmpDir();
  await assert.rejects(music.generateMusic({ prompt: 'a song please ok', lyricsOptimizer: true }, { config: falCfg(dir), fetch: falFetch({ statuses: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', error: 'Generation failed', error_type: 'no_media_generated' }] }) }),
    (e) => e.reason === 'task-failed' && e.code === 'no_media_generated' && e.retryable === false && e.provider === 'fal' && /fal\.ai 这次没有生成出音频/.test(e.message));
  await assert.rejects(music.generateMusic({ prompt: 'a song please ok', lyricsOptimizer: true }, { config: falCfg(dir), fetch: falFetch({ result: () => json({ detail: [{ loc: ['body', 'prompt'], msg: 'Content flagged', type: 'content_policy_violation' }] }, 422) }) }),
    (e) => e.reason === 'sensitive' && e.code === 'content_policy_violation' && e.retryable === false && /内容审核/.test(e.message));
  await assert.rejects(music.generateMusic({ prompt: 'a song please ok', lyricsOptimizer: true }, { config: falCfg(dir), fetch: falFetch({ result: () => json({ audio: {} }) }) }), (e) => e.reason === 'empty');
  await assert.rejects(music.generateMusic({ prompt: 'a song please ok', lyricsOptimizer: true }, { config: falCfg(dir), fetch: falFetch({ statuses: [{ status: 'COMPLETED', error: 'upstream exploded', error_type: 'downstream_service_error' }] }) }),
    (e) => e.reason === 'server' && e.retryable === true);
  assert.equal(fs.existsSync(path.join(dir, 'music')) ? fs.readdirSync(path.join(dir, 'music')).length : 0, 0);
});

test('fal: auth / balance / rate limit / bad model / server / network map to readable Chinese with code and retry', async () => {
  const dir = tmpDir();
  const on = (status, body = {}, headers = {}) => falFetch({ submit: () => ({ ...json(body, status), headers: { get: (h) => headers[h.toLowerCase()] ?? null } }) });
  const go = (f) => music.generateMusic({ prompt: 'jazz trio at night', instrumental: true }, { config: falCfg(dir), fetch: f });
  await assert.rejects(go(on(401, { detail: 'Invalid API key' })), (e) => e.reason === 'auth' && e.code === 'http-401' && e.retryable === false && /fal\.ai API Key 无效/.test(e.message) && /FAL_KEY/.test(e.message));
  await assert.rejects(go(on(403, { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' })), (e) => e.reason === 'balance' && e.retryable === false && /余额不足/.test(e.message));
  await assert.rejects(go(on(403, { detail: 'Forbidden' })), (e) => e.reason === 'auth' && /没有权限/.test(e.message));
  await assert.rejects(go(on(429, { detail: 'Too many requests' })), (e) => e.reason === 'rate-limit' && e.retryable === true && e.code === 'http-429');
  await assert.rejects(go(on(404, { detail: 'Application not found' })), (e) => e.reason === 'model');
  await assert.rejects(go(on(503, { detail: 'busy', error_type: 'runner_scheduling_failure' })), (e) => e.reason === 'server' && e.retryable === true && e.code === 'runner_scheduling_failure');
  await assert.rejects(go(on(504, { detail: 'timeout', error_type: 'request_timeout' })), (e) => e.reason === 'timeout' && e.retryable === true);
  await assert.rejects(go(on(500, { detail: 'x' }, { 'x-fal-needs-retry': '0' })), (e) => e.reason === 'server' && e.retryable === false, 'X-Fal-Needs-Retry wins');
  await assert.rejects(go(falFetch({ submit: () => { throw new Error('getaddrinfo ENOTFOUND queue.fal.run'); } })), (e) => e.reason === 'network' && e.code === 'network' && e.retryable === true && /连不上 fal\.ai/.test(e.message));
  await assert.rejects(go(falFetch({ download: () => bin(Buffer.alloc(0), 403) })), (e) => e.reason === 'download');
});

test('fal: timeout — a task that stays IN_QUEUE is given up at the deadline and cancelled at fal (PUT …/cancel)', async () => {
  const dir = tmpDir();
  const f = falFetch({ statuses: [{ status: 'IN_QUEUE', queue_position: 9 }] });
  await assert.rejects(music.generateMusic({ prompt: 'ambient drone pads', instrumental: true }, { config: falCfg(dir, { timeoutMs: 80, pollIntervalMs: 10 }), fetch: f }), (e) => e.reason === 'timeout' && e.code === 'timeout' && e.retryable === true && e.provider === 'fal');
  const cancel = f.calls.find((c) => c.method === 'PUT');
  assert.ok(cancel, 'cancel was sent');
  assert.equal(cancel.url, `${FAL_BASE}/cancel`);
  assert.equal(cancel.headers.Authorization, `Key ${FAKE_KEY}`);
  assert.ok(f.polls() >= 2);
});

test('fal: cancel — an AbortSignal stops the polling (reason aborted, not retryable) and the request is cancelled at fal; an aborted signal sends nothing', async () => {
  const dir = tmpDir();
  const f = falFetch({ statuses: [{ status: 'IN_PROGRESS' }] });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);
  await assert.rejects(music.generateMusic({ prompt: 'ambient drone pads', instrumental: true }, { config: falCfg(dir, { pollIntervalMs: 10 }), fetch: f, signal: ac.signal }), (e) => e.reason === 'aborted' && e.code === 'cancelled' && e.retryable === false);
  assert.equal(f.calls.filter((c) => c.method === 'PUT').length, 1);
  // the client's own cancel(): fal's answer is kept on the task
  const c = music.createMusicClient(falCfg(dir), { fetch: falFetch() });
  const task = await c.submit({ prompt: 'ambient drone pads', instrumental: true });
  assert.equal(await c.cancel(task), 'CANCELLATION_REQUESTED');
  const none = falFetch();
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(music.generateMusic({ prompt: 'ambient drone pads', instrumental: true }, { config: falCfg(dir), fetch: none, signal: pre.signal }), (e) => e.reason === 'aborted');
  assert.equal(none.calls.length, 0);
});

test('fal: request URLs — the ones submit returns on the queue host are used; others are rebuilt from owner/app (the key never leaves the queue host)', async () => {
  const dir = tmpDir();
  const f = falFetch({ submit: () => json({ request_id: REQ, status_url: 'https://evil.example.com/steal/status', response_url: 'https://evil.example.com/steal' }) });
  await music.generateMusic({ prompt: 'ambient drone pads', instrumental: true }, { config: falCfg(dir), fetch: f });
  assert.ok(f.calls.every((c) => !c.url.includes('evil.example.com')));
  assert.equal(f.calls[1].url, `${FAL_BASE}/status`);
  // a short prompt is padded to fal's 10-character minimum, with a warning
  const r = music.buildRequestFor('fal', { prompt: 'jazz', instrumental: true });
  assert.equal(r.input.prompt, 'jazz. Original music');
  assert.match(r.warnings[0], /至少 10 个字符/);
  assert.equal(r.model, 'fal-ai/minimax-music/v2.6');
  assert.equal(music.buildRequestFor('fal', { prompt: 'a b c d e f g', lyricsOptimizer: true }, { fal: { model: 'fal-ai/minimax-music/v2.5' } }).model, 'fal-ai/minimax-music/v2.5');
  assert.throws(() => music.buildRequestFor('fal', { prompt: 'x', instrumental: true, model: 'fal-ai/minimax-music/v2' }), (e) => e.reason === 'bad-params');
});

// ---- ElevenLabs
const audioRes = (buf = AUDIO, headers = {}) => ({ ok: true, status: 200, headers: { get: (h) => ({ 'content-type': 'audio/mpeg', 'content-length': String(buf.length), 'song-id': 'song-abc', ...headers })[h.toLowerCase()] ?? null }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });

test('ElevenLabs: success — POST /v1/music?output_format with xi-api-key; prompt + lyrics block, music_length_ms from durationSec, force_instrumental; one request, no polling (it answers with the file)', async () => {
  const dir = tmpDir();
  const f = mockFetch([audioRes()]);
  const stages = [];
  const r = await music.generateMusic({ ...SONG, durationSec: 75, structure: ['Verse', 'Chorus'], vocals: '温柔女声' }, { config: elCfg(dir), fetch: f, onProgress: (p) => stages.push(p.stage) });
  assert.equal(f.calls.length, 1, 'a single synchronous request');
  const c = f.calls[0];
  assert.equal(c.url, `${EL_EP}/v1/music?output_format=mp3_44100_128`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['xi-api-key'], FAKE_KEY);
  assert.equal(c.init.headers.Authorization, undefined);
  assert.deepEqual(Object.keys(c.body).sort(), ['model_id', 'music_length_ms', 'prompt']);
  assert.equal(c.body.model_id, 'music_v2_5');
  assert.equal(c.body.music_length_ms, 75000);
  assert.match(c.body.prompt, /^温柔的城市民谣，夏夜海边\. Mood: 放松\. Vocals: 温柔女声\. Tempo: 90 BPM\. Structure: Verse - Chorus\n\nLyrics:\n\[Verse\]\n晚风吹过街角/);
  assert.doesNotMatch(c.body.prompt, /Length: about/, 'the length goes as music_length_ms, not as a hint');
  assert.deepEqual(fs.readFileSync(r.filePath), AUDIO);
  assert.match(path.basename(r.filePath), /晚风-Night-Breeze\.mp3$/);
  assert.deepEqual([r.meta.provider, r.meta.model, r.meta.songId, r.meta.requestedDurationMs, r.meta.lyrics], ['elevenlabs', 'music_v2_5', 'song-abc', 75000, SONG.lyrics]);
  assert.ok(r.meta.mapping.native.includes('durationSec'));
  assert.deepEqual(r.meta.unsupported.map((x) => x.field), ['lyrics', 'bpm', 'structure']);
  assert.deepEqual(stages, ['submitting', 'downloading', 'saved']);
  // pure music: force_instrumental; the output format setting
  const f2 = mockFetch([audioRes()]);
  await music.generateMusic({ prompt: 'chill synthwave', instrumental: true }, { config: elCfg(dir, { elevenlabsFormat: 'mp3_44100_192', model: 'music_v2' }), fetch: f2 });
  assert.equal(f2.calls[0].body.force_instrumental, true);
  assert.equal(f2.calls[0].body.model_id, 'music_v2');
  assert.equal(f2.calls[0].body.music_length_ms, undefined, 'no length asked: ElevenLabs decides');
  assert.match(f2.calls[0].url, /output_format=mp3_44100_192$/);
});

test('ElevenLabs: errors — 401 auth, 402 / quota balance, 403 plan, bad_prompt (with its suggestion), 422 bad params, 429 rate limit, 5xx, network; readable Chinese with code and retry', async () => {
  const dir = tmpDir();
  const go = (res) => music.generateMusic({ prompt: 'a song like a famous band', lyricsOptimizer: true }, { config: elCfg(dir), fetch: typeof res === 'function' ? res : mockFetch([res]) });
  await assert.rejects(go(json({ detail: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' } }, 401)), (e) => e.reason === 'auth' && e.code === 'invalid_api_key' && e.retryable === false && /ElevenLabs API Key 无效/.test(e.message) && /ELEVENLABS_API_KEY/.test(e.message));
  await assert.rejects(go(json({ detail: { type: 'payment_required', code: 'insufficient_credits', message: 'not enough credits' } }, 402)), (e) => e.reason === 'balance' && e.code === 'insufficient_credits' && e.retryable === false);
  await assert.rejects(go(json({ detail: { status: 'quota_exceeded', message: 'quota' } }, 401)), (e) => e.reason === 'balance' && e.code === 'quota_exceeded');
  await assert.rejects(go(json({ detail: { status: 'forbidden', message: 'music not in plan' } }, 403)), (e) => e.reason === 'unavailable' && /付费套餐/.test(e.message));
  await assert.rejects(go(json({ detail: { status: 'bad_prompt', message: 'mentions an artist', data: { prompt_suggestion: 'An upbeat pop-rock anthem' } } }, 400)), (e) => e.reason === 'sensitive' && e.code === 'bad_prompt' && e.retryable === false && /它建议改成：An upbeat pop-rock anthem/.test(e.message));
  await assert.rejects(go(json({ detail: [{ loc: ['body', 'music_length_ms'], msg: 'too long', type: 'value_error' }] }, 422)), (e) => e.reason === 'bad-params' && /too long/.test(e.message));
  await assert.rejects(go(json({ detail: { type: 'rate_limit_error', code: 'concurrent_limit_exceeded', message: 'busy' } }, 429)), (e) => e.reason === 'rate-limit' && e.retryable === true);
  await assert.rejects(go(json({}, 503)), (e) => e.reason === 'server' && e.retryable === true && e.code === 'http-503');
  await assert.rejects(go(async () => { throw new Error('ECONNRESET'); }), (e) => e.reason === 'network' && /连不上 ElevenLabs/.test(e.message));
  await assert.rejects(go({ ...json({ detail: { message: 'odd' } }, 200), headers: { get: (h) => (h === 'content-type' ? 'application/json' : null) } }), (e) => e.reason === 'server', 'a JSON body on 200 is not audio');
});

test('ElevenLabs: timeout and cancel — the request is let go at the deadline (timeout, retryable) or on the AbortSignal (aborted); nothing is written', async () => {
  const dir = tmpDir();
  await assert.rejects(music.generateMusic({ prompt: 'chill synthwave', instrumental: true }, { config: elCfg(dir, { timeoutMs: 60 }), fetch: hangingFetch() }), (e) => e.reason === 'timeout' && e.code === 'timeout' && e.retryable === true && e.provider === 'elevenlabs');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  await assert.rejects(music.generateMusic({ prompt: 'chill synthwave', instrumental: true }, { config: elCfg(dir), fetch: hangingFetch(), signal: ac.signal }), (e) => e.reason === 'aborted' && e.retryable === false);
  assert.equal(fs.existsSync(path.join(dir, 'music')), false);
});

test('config per service: provider from settings (default fal) or the caller; each service its own key slot / env variable / endpoint; no key → no-key naming where to set it', async () => {
  const s = settingsLib.normalizeSettings(null);
  const env = { FAL_KEY: 'fal-env-key-0000', ELEVENLABS_API_KEY: 'el-env-key-0000', MINIMAX_API_KEY: 'mm-env-key-0000' };
  const fc = music.resolveConfig({ settings: s, env });
  assert.deepEqual([fc.provider, fc.endpoint, fc.model, fc.apiKey], ['fal', 'https://queue.fal.run', 'fal-ai/minimax-music/v2.6', 'fal-env-key-0000']);
  assert.equal(music.resolveConfig({ settings: s, keys: { fal: 'fal-store-key-0000' }, env }).apiKey, 'fal-store-key-0000');
  assert.equal(music.resolveConfig({ settings: s, keys: (slot) => (slot === 'fal' ? 'fal-fn-key-0000' : ''), env }).apiKey, 'fal-fn-key-0000');
  const ec = music.resolveConfig({ settings: s, env, provider: 'elevenlabs' });
  assert.deepEqual([ec.provider, ec.endpoint, ec.model, ec.apiKey, ec.elevenlabsFormat], ['elevenlabs', 'https://api.elevenlabs.io', 'music_v2_5', 'el-env-key-0000', 'mp3_44100_128']);
  const withTts = settingsLib.normalizeSettings({ music: { provider: 'elevenlabs' }, tts: { endpoints: { elevenlabs: 'https://api.eu.residency.elevenlabs.io' } } });
  assert.equal(music.resolveConfig({ settings: withTts, env: {} }).endpoint, 'https://api.eu.residency.elevenlabs.io', '朗读 → ElevenLabs endpoint is shared');
  assert.equal(music.resolveConfig({ settings: s, env, provider: 'minimax' }).apiKey, 'mm-env-key-0000');
  assert.equal(music.resolveConfig({ settings: s, env: { FAL_MUSIC_ENDPOINT: 'https://fal-proxy.example.com/' } }).endpoint, 'https://fal-proxy.example.com');
  assert.throws(() => music.resolveConfig({ settings: s, env: { FAL_MUSIC_ENDPOINT: 'http://queue.fal.run' } }), (e) => e.reason === 'bad-endpoint' && /FAL_MUSIC_ENDPOINT/.test(e.message));
  assert.equal(music.resolveConfig({ settings: s, env: { FAL_MUSIC_ENDPOINT: 'http://127.0.0.1:9' }, allowInsecureLocal: true }).endpoint, 'http://127.0.0.1:9');
  // no key: refused before any request, and the message says where the key goes
  const f = mockFetch([json({})]);
  await assert.rejects(music.generateMusic({ prompt: 'ambient drone pads', instrumental: true }, { settings: s, env: {}, userDataDir: tmpDir(), fetch: f }), (e) => e.reason === 'no-key' && e.provider === 'fal' && /设置 → 音乐创作 → fal\.ai/.test(e.message) && /FAL_KEY/.test(e.message));
  await assert.rejects(music.generateMusic({ prompt: 'ambient drone pads', instrumental: true }, { settings: s, provider: 'elevenlabs', env: {}, userDataDir: tmpDir(), fetch: f }), (e) => e.reason === 'no-key' && /ELEVENLABS_API_KEY/.test(e.message));
  assert.equal(f.calls.length, 0);
  // the tool's parameters are the same for every service: the same arguments build a request on each
  const args = { prompt: 'Relaxed lo-fi hip hop, rainy evening', instrumental: true, title: '雨夜', mood: '轻松', bpm: 80, durationSec: 60, structure: ['Intro', 'Outro'] };
  for (const id of music.PROVIDER_IDS) assert.ok(music.buildRequestFor(id, args), id);
});

test('no real key in the provider modules either', () => {
  for (const f of ['src/core/music-fal.js', 'src/core/music-elevenlabs.js', 'src/core/music-minimax.js', 'src/core/music-common.js', 'test/fixtures/fake-music-services.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|sk_[a-f0-9]{30,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{20,}/, f);
  }
});

test('length from the file (fal / ElevenLabs do not report it): MP3 frames / WAV header give durationMs; an unknown header stays undefined', async () => {
  const C = require('../src/core/music-common');
  const sample = fs.readFileSync(path.join(__dirname, 'fixtures', 'music-sample.mp3'));
  assert.equal(C.audioDurationMs(sample, 'mp3'), 3030, 'ffprobe says 3.03 s');
  const pcm = Buffer.alloc(44100 * 2 * 2); // 1 s, 16-bit stereo
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 2, 0]), Buffer.from([0x44, 0xac, 0, 0]), Buffer.from([0x10, 0xb1, 2, 0]), Buffer.from([4, 0, 16, 0]), Buffer.from('data'), Buffer.from([0x10, 0xb1, 2, 0]), pcm]);
  assert.equal(C.audioDurationMs(wav, 'wav'), 1000);
  assert.equal(C.audioDurationMs(Buffer.from('not audio at all'), 'mp3'), undefined);
  assert.equal(C.audioDurationMs(sample, 'pcm'), undefined);
  // through the fal client: the saved song carries it, with where it came from
  const dir = tmpDir();
  const r = await music.generateMusic({ prompt: 'ambient drone pads', instrumental: true }, { config: falCfg(dir), fetch: falFetch({ download: () => bin(sample) }) });
  assert.deepEqual([r.durationMs, r.meta.durationSource], [3030, 'file-header']);
});
