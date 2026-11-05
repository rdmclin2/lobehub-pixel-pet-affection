#!/usr/bin/env node
'use strict';
// 音乐创作冒烟脚本 (T-5091, T-5651): runs core/music.js — the same module the pet's compose_music tool calls — once,
// outside the app: submit → wait (poll) → save, and prints where the audio file went.
//
//   npm run music:smoke -- --mock                      no network, no key: an in-process stand-in of the picked
//                                                       service answers (fal: queued → running → done, polled)
//   npm run music:smoke -- --provider=elevenlabs --mock   the same for ElevenLabs (one request answering the file)
//   npm run music:smoke -- --provider=minimax --mock      MiniMax direct (a task_id answer, polled)
//   npm run music:smoke -- --mock=error|auth|timeout|cancel   failure paths (minimax also: sync | hex)
//   FAL_KEY=… npm run music:smoke                       a real generation on fal (costs ~$0.15; one short instrumental)
//   npm run music:smoke -- --lyrics "[Verse]\n…" --title 夏天   a song with vocals
//
// Options: --provider fal|elevenlabs|minimax (default fal) --prompt --lyrics --instrumental (default when no lyrics)
// --lyrics-optimizer --title --model --format --endpoint --out <dir> --timeout <s> --json.  Keys: $FAL_KEY /
// $ELEVENLABS_API_KEY / $MINIMAX_API_KEY, else an `export NAME=…` line in ~/.config/pixel-pet/minimax.env /
// ~/.zshrc / ~/.bashrc (scripts/minimax-key.js). The key is never printed.
// Exit code: 0 the file was saved and looks like audio, 1 a MusicError (its reason is printed), 2 bad usage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const music = require('../src/core/music');
const minimaxKey = require('./minimax-key');

const SAMPLE = path.join(__dirname, '..', 'test', 'fixtures', 'music-sample.mp3');

function parseArgs(argv) {
  const o = { mock: null, json: false, instrumental: null, lyricsOptimizer: false, provider: 'fal' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v == null) usage(`${a} needs a value`); return v; };
    if (a === '--mock') o.mock = 'async';
    else if (a.startsWith('--mock=')) o.mock = a.slice(7);
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--provider=')) o.provider = a.slice(11);
    else if (a === '--provider') o.provider = val();
    else if (a === '--instrumental') o.instrumental = true;
    else if (a === '--lyrics-optimizer') o.lyricsOptimizer = true;
    else if (a === '--prompt') o.prompt = val();
    else if (a === '--lyrics') o.lyrics = val().replace(/\\n/g, '\n');
    else if (a === '--title') o.title = val();
    else if (a === '--model') o.model = val();
    else if (a === '--format') o.format = val();
    else if (a === '--endpoint') o.endpoint = val();
    else if (a === '--out') o.out = path.resolve(val());
    else if (a === '--timeout') o.timeoutSec = Number(val());
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown option ${a}`);
  }
  if (!music.PROVIDER_IDS.includes(o.provider)) usage(`--provider=${o.provider}: use ${music.PROVIDER_IDS.join(' | ')}`);
  const modes = o.provider === 'minimax' ? ['async', 'sync', 'hex', 'error', 'auth', 'timeout', 'cancel'] : ['async', 'error', 'auth', 'timeout', 'cancel'];
  if (o.mock && !modes.includes(o.mock)) usage(`--mock=${o.mock}: for ${o.provider} use ${modes.join(' | ')}`);
  return o;
}

function usage(err) {
  const text = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 19).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
  (err ? console.error : console.log)(`${err ? `music-smoke: ${err}\n\n` : ''}${text}`);
  process.exit(err ? 2 : 0);
}

// An in-process stand-in for POST /v1/music_generation (+ the task query + the audio download): no sockets at all.
function mockMiniMax(mode, log) {
  const audio = fs.readFileSync(SAMPLE);
  const json = (obj) => ({ ok: true, status: 200, headers: new Map(), json: async () => obj });
  const done = (a) => ({ data: { status: 2, audio: a }, trace_id: 'mock-trace', extra_info: { music_duration: 3030, music_sample_rate: 44100, music_channel: 1, bitrate: 64000, music_size: audio.length }, base_resp: { status_code: 0, status_msg: 'success' } });
  let polls = 0;
  return async (url, init = {}) => {
    const u = new URL(url);
    log(`[mock] ${init.method || 'GET'} ${u.pathname}${u.search}`);
    if (u.pathname === music.GENERATE_PATH) {
      const body = JSON.parse(init.body);
      if (!init.headers || !/^Bearer \S+/.test(init.headers.Authorization || '')) throw new Error('no Authorization header');
      log(`[mock] request body: ${JSON.stringify({ ...body, prompt: body.prompt && body.prompt.slice(0, 80) })}`);
      if (mode === 'error') return json({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' }, trace_id: 'mock-trace' });
      if (mode === 'auth') return json({ base_resp: { status_code: 1004, status_msg: 'login fail' }, trace_id: 'mock-trace' });
      if (mode === 'timeout' || mode === 'cancel') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      if (mode === 'sync') return json(done('https://mock.minimax.local/audio/song.mp3'));
      if (mode === 'hex') return json(done(audio.toString('hex')));
      return json({ task_id: 'mock-task-1', base_resp: { status_code: 0, status_msg: 'success' } }); // async: polled below
    }
    if (u.pathname === music.QUERY_PATH) {
      polls++;
      return json(polls < 3 ? { status: 'Processing', base_resp: { status_code: 0 } } : { ...done('https://mock.minimax.local/audio/song.mp3'), task_id: u.searchParams.get('task_id') });
    }
    if (u.pathname === '/audio/song.mp3') return { ok: true, status: 200, headers: new Map([['content-length', String(audio.length)]]), arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length) };
    return { ok: false, status: 404, headers: new Map(), json: async () => ({}) };
  };
}

const reply = (status, obj, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null }, json: async () => obj });
const fileReply = (audio, headers = {}) => ({ ok: true, status: 200, headers: { get: (h) => ({ 'content-type': 'audio/mpeg', 'content-length': String(audio.length), ...headers })[h.toLowerCase()] ?? null }, arrayBuffer: async () => audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length) });
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));

// fal's queue (POST queue.fal.run/<model> → status polls → result → the fal.media file; PUT …/cancel), in process.
function mockFal(mode, log) {
  const audio = fs.readFileSync(SAMPLE);
  const base = 'https://mock.fal.local/fal-ai/minimax-music/requests/mock-req-1';
  let polls = 0;
  return async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = new URL(url);
    log(`[mock fal] ${method} ${u.pathname}`);
    if (method === 'POST') {
      if (!/^Key \S+/.test((init.headers || {}).Authorization || '')) throw new Error('no Authorization: Key header');
      const body = JSON.parse(init.body);
      log(`[mock fal] input: ${JSON.stringify({ ...body, prompt: body.prompt.slice(0, 80) })}`);
      if (mode === 'auth') return reply(401, { detail: 'Invalid API key' });
      if (mode === 'error') return reply(403, { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' });
      return reply(200, { request_id: 'mock-req-1', status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel`, queue_position: 1 });
    }
    if (method === 'PUT' && u.pathname.endsWith('/cancel')) return reply(202, { status: 'CANCELLATION_REQUESTED' });
    if (u.pathname.endsWith('/status')) {
      polls++;
      if (mode === 'timeout' || mode === 'cancel') return reply(202, { status: 'IN_QUEUE', queue_position: 3 });
      return reply(202, polls === 1 ? { status: 'IN_QUEUE', queue_position: 1 } : polls === 2 ? { status: 'IN_PROGRESS' } : { status: 'COMPLETED' });
    }
    if (url === base) return reply(200, { audio: { url: 'https://mock.fal.media/files/song.mp3', content_type: 'audio/mpeg', file_name: 'song.mp3', file_size: audio.length } });
    if (u.pathname === '/files/song.mp3') return fileReply(audio);
    return reply(404, {});
  };
}

// ElevenLabs POST /v1/music (answers with the file), in process.
function mockElevenLabs(mode, log) {
  const audio = fs.readFileSync(SAMPLE);
  return async (url, init = {}) => {
    const u = new URL(url);
    log(`[mock elevenlabs] ${init.method || 'GET'} ${u.pathname}${u.search}`);
    if (!(init.headers || {})['xi-api-key']) throw new Error('no xi-api-key header');
    log(`[mock elevenlabs] body: ${JSON.stringify({ ...JSON.parse(init.body), prompt: JSON.parse(init.body).prompt.slice(0, 80) })}`);
    if (mode === 'auth') return reply(401, { detail: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' } });
    if (mode === 'error') return reply(402, { detail: { type: 'payment_required', code: 'insufficient_credits', message: 'Not enough credits' } });
    if (mode === 'timeout' || mode === 'cancel') return hang(init);
    return fileReply(audio, { 'song-id': 'mock-song-1' });
  };
}

const MOCKS = { fal: mockFal, elevenlabs: mockElevenLabs, minimax: mockMiniMax };
const KEY_ENV = { fal: 'FAL_KEY', elevenlabs: 'ELEVENLABS_API_KEY', minimax: 'MINIMAX_API_KEY' };
const MOCK_ENDPOINT = { fal: 'https://mock.fal.local', elevenlabs: 'https://mock.elevenlabs.local', minimax: 'https://mock.minimax.local' };

// Is the file audio? MP3 (ID3 / frame sync) / WAV (RIFF…WAVE) by its header, plus ffprobe's duration when installed.
function inspect(filePath) {
  const head = Buffer.alloc(12);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const kind = head.slice(0, 3).toString() === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) ? 'mp3'
    : head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WAVE' ? 'wav' : 'unknown';
  let probe = null;
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration,bit_rate:stream=codec_name,sample_rate,channels', '-of', 'json', filePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(out);
    const s = (j.streams || [])[0] || {};
    probe = { format: j.format.format_name, durationSec: Number(Number(j.format.duration).toFixed(2)), codec: s.codec_name, sampleRate: Number(s.sample_rate), channels: s.channels };
  } catch { /* ffprobe missing or could not read it */ }
  return { bytes: fs.statSync(filePath).size, kind, probe };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const log = o.json ? () => {} : (m) => console.log(m);
  const out = o.out || (o.mock ? fs.mkdtempSync(path.join(os.tmpdir(), 'music-smoke-')) : path.join(process.cwd(), 'out', 'music-smoke'));
  let key = '';
  let keyFrom = 'mock';
  const envName = KEY_ENV[o.provider];
  if (!o.mock) {
    const k = minimaxKey.read(envName);
    key = k.value;
    keyFrom = k.from === 'env' ? `$${envName}` : k.from;
    if (!key) { console.error(`music-smoke: no ${envName}. export ${envName}=… (or run with --mock to check the flow offline)`); process.exit(1); }
  }
  const sub = o.provider === 'fal' ? { fal: { ...(o.model ? { model: o.model } : {}) } } : o.provider === 'elevenlabs' ? { elevenlabs: { ...(o.model ? { model: o.model } : {}) } } : { ...(o.model ? { model: o.model } : {}) };
  const settings = { music: { provider: o.provider, ...sub, ...(o.format ? { format: o.format } : {}), ...(o.timeoutSec ? { timeoutSec: o.timeoutSec } : {}), outputDir: out } };
  const epVar = music.ENDPOINT_ENV[o.provider];
  const env = { ...process.env, ...(o.endpoint ? { [epVar]: o.endpoint } : {}) };
  if (o.provider === 'minimax' && !env.MINIMAX_MUSIC_ENDPOINT && !o.mock) { const ep = minimaxKey.endpoint(); if (ep) env.MINIMAX_MUSIC_ENDPOINT = ep; }
  const config = music.resolveConfig({ settings, key: o.mock ? 'mock-key-0000' : key, env: o.mock ? {} : env });
  if (o.mock) { config.endpoint = MOCK_ENDPOINT[o.provider]; config.pollIntervalMs = 200; if (o.mock === 'timeout') config.timeoutMs = 1500; }

  const instrumental = o.instrumental ?? (!o.lyrics && !o.lyricsOptimizer);
  const params = {
    prompt: o.prompt || 'Relaxed lo-fi piano for a rainy evening, warm Rhodes, soft drums, short and calm',
    instrumental,
    ...(o.lyrics ? { lyrics: o.lyrics } : {}),
    ...(o.lyricsOptimizer ? { lyricsOptimizer: true } : {}),
    title: o.title || (o.mock ? '冒烟测试-mock' : '冒烟测试'),
    mood: '轻松',
    durationSec: 30,
  };
  log(`music-smoke: provider=${o.provider} mode=${o.mock ? `mock(${o.mock})` : 'real'} endpoint=${config.endpoint} model=${config.model} format=${config.format} key=${o.mock ? 'mock' : `from ${keyFrom} (${key.length} chars, not shown)`} timeout=${config.timeoutMs / 1000}s out=${out}`);

  const client = music.createMusicClient(config, o.mock ? { fetch: MOCKS[o.provider](o.mock, log) } : {});
  // --mock=cancel: Esc after 1 s (fal: the request is also cancelled at fal with PUT …/cancel)
  const ac = new AbortController();
  if (o.mock === 'cancel') setTimeout(() => ac.abort(), 1000);
  const signal = ac.signal;
  const started = Date.now();
  const stages = [];
  const onProgress = (p) => { stages.push(p.stage); log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${p.stage}${p.taskId ? ` task=${p.taskId}` : ''}${p.attempt ? ` attempt=${p.attempt} status=${p.status}` : ''}${p.queuePosition != null ? ` queue=${p.queuePosition}` : ''}${p.filePath ? ` ${p.filePath}` : ''}`); };
  let task = null;
  try {
    task = await client.submit(params, { onProgress, signal });
    log(`submitted: mode=${task.mode} status=${task.status} id=${task.id}`);
    const result = await client.wait(task, { onProgress, signal });
    const saved = await client.save(task, result, { onProgress, signal });
    const file = inspect(saved.filePath);
    const ok = file.bytes > 0 && file.kind !== 'unknown' && (!file.probe || file.probe.durationSec > 0);
    const summary = { ok, provider: o.provider, model: saved.meta.model, mode: o.mock ? `mock-${o.mock}` : 'real', elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)), stages, taskMode: task.mode, traceId: saved.meta.traceId, filePath: saved.filePath, fileUrl: saved.fileUrl, durationMs: saved.durationMs ?? null, unsupported: saved.meta.unsupported || [], warnings: saved.meta.warnings || [], file };
    if (o.json) console.log(JSON.stringify(summary));
    else {
      log(`saved: ${saved.filePath}`);
      if ((saved.meta.unsupported || []).length) log(`not native on ${o.provider}: ${saved.meta.unsupported.map((x) => `${x.field}(${x.how})`).join(', ')}`);
      log(`file: ${file.bytes} bytes, header ${file.kind}${file.probe ? `, ffprobe ${file.probe.codec} ${file.probe.sampleRate} Hz ${file.probe.channels} ch ${file.probe.durationSec}s` : ''}`);
      log(ok ? 'RESULT: PASS' : 'RESULT: FAIL (the saved file does not look like audio)');
    }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    const err = { ok: false, provider: o.provider, mode: o.mock ? `mock-${o.mock}` : 'real', stages, reason: e.reason || 'error', code: e.code ?? null, retryable: e.retryable ?? null, traceId: e.traceId || null, falCancel: task && task.cancel ? task.cancel : null, error: e.message };
    if (o.json) console.log(JSON.stringify(err));
    else console.error(`RESULT: FAIL reason=${err.reason} code=${err.code} retryable=${err.retryable} ${e.message}${err.traceId ? ` trace=${err.traceId}` : ''}${err.falCancel ? ` fal-cancel=${err.falCancel}` : ''}`);
    process.exit(e instanceof music.MusicError ? 1 : 2);
  }
}

main();
