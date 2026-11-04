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
const cfgFor = (dir, extra = {}) => ({ ...music.resolveConfig({ settings: settingsLib.normalizeSettings(null), key: FAKE_KEY, env: {}, userDataDir: dir }), ...extra });
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
  const cfg = music.resolveConfig({ settings: { music: { outputDir: outDir } }, key: FAKE_KEY, env: {}, userDataDir: base });
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
  const s = settingsLib.normalizeSettings(null);
  assert.equal(music.resolveConfig({ settings: s, key: FAKE_KEY, env: { MINIMAX_API_KEY: 'env-key-placeholder' } }).apiKey, FAKE_KEY);
  assert.equal(music.resolveConfig({ settings: s, key: '', env: { MINIMAX_API_KEY: 'env-key-placeholder' } }).apiKey, 'env-key-placeholder');
  assert.equal(music.resolveConfig({ settings: s, env: {} }).endpoint, 'https://api.minimax.cn');
  assert.equal(music.resolveConfig({ settings: s, env: { MINIMAX_MUSIC_ENDPOINT: 'https://api.minimax.io/' } }).endpoint, 'https://api.minimax.io');
  const withTts = settingsLib.normalizeSettings({ tts: { endpoints: { minimax: 'https://api.minimax.io' } } });
  assert.equal(music.resolveConfig({ settings: withTts, env: {} }).endpoint, 'https://api.minimax.io');
  const own = settingsLib.normalizeSettings({ music: { endpoint: 'https://proxy.example.com' } });
  assert.equal(music.resolveConfig({ settings: own, env: { MINIMAX_MUSIC_ENDPOINT: 'https://api.minimax.io' } }).endpoint, 'https://proxy.example.com');
  assert.throws(() => music.resolveConfig({ settings: s, env: { MINIMAX_MUSIC_ENDPOINT: 'http://api.minimax.io' } }), (e) => e.reason === 'bad-endpoint');
  assert.equal(settingsLib.normalizeSettings({ music: { endpoint: 'http://api.minimax.cn' } }).music.endpoint, '', 'http is dropped');
  assert.equal(music.resolveConfig({ settings: s, env: {}, userDataDir: '/data' }).outputDir, path.join('/data', 'music'));
  // no key → no-key before any request
  const fetch = mockFetch([ok({ status: 2, audio: 'aa' })]);
  await assert.rejects(music.generateMusic(SONG, { settings: s, key: '', env: {}, userDataDir: tmpDir(), fetch }), (e) => e.reason === 'no-key' && /MINIMAX_API_KEY/.test(e.message));
  assert.equal(fetch.calls.length, 0);
});

test('settings: settings.music defaults and normalisation; every music key has a console field on the 音乐创作 page; patches go to setSection', () => {
  const d = settingsLib.normalizeSettings(null).music;
  assert.deepEqual(d, { endpoint: '', model: 'music-3.0', outputDir: '', outputFormat: 'url', format: 'mp3', sampleRate: 44100, bitrate: 256000, timeoutSec: 600, pollIntervalSec: 3 });
  const n = settingsLib.normalizeSettings({ music: { model: 'nope', format: 'ogg', sampleRate: 1, timeoutSec: 99999, pollIntervalSec: 0, outputDir: 'relative/dir', outputFormat: 'x' } }).music;
  assert.deepEqual(n, d);
  for (const k of Object.keys(d)) {
    const f = schema.field(`music.${k}`);
    assert.ok(f, k);
    assert.equal(f.page, 'music');
    assert.deepEqual(schema.patchFor(`music.${k}`, d[k]), { setter: 'setSection', section: 'music', patch: { [k]: d[k] } });
  }
  assert.ok(schema.PAGES.music);
  assert.deepEqual(schema.validate('music.endpoint', 'http://api.minimax.cn'), { ok: false, reason: 'bad-endpoint-https', message: '地址不合法：必须是 https，不能带账号密码' });
  assert.equal(schema.validate('music.endpoint', 'https://api.minimax.io').ok, true);
  assert.equal(schema.validate('music.outputDir', 'relative').ok, false);
  assert.equal(schema.validate('music.outputDir', '/Users/me/Music').ok, true);
  assert.equal(schema.validate('music.timeoutSec', 10).ok, false);
  assert.equal(schema.validate('music.model', 'music-2.6').ok, true);
});

test('no real key is committed: module, test and settings only hold placeholders', () => {
  for (const f of ['src/core/music.js', 'test/music.test.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}/, f);
  }
});
