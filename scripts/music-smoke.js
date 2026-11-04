#!/usr/bin/env node
'use strict';
// 音乐创作冒烟脚本 (T-5091): runs core/music.js — the same module the pet's compose_music tool calls — once,
// outside the app: submit → wait (poll) → save, and prints where the audio file went.
//
//   npm run music:smoke -- --mock                      no network, no key: an in-process MiniMax stand-in answers with a
//                                                       task_id, is polled until done, the sample mp3 is downloaded and saved
//   npm run music:smoke -- --mock=sync|hex|error|timeout   the other answer shapes / failure paths
//   MINIMAX_API_KEY=… npm run music:smoke              a real generation (costs MiniMax credit; one short instrumental)
//   npm run music:smoke -- --lyrics "[Verse]\n…" --title 夏天   a song with vocals
//
// Options: --prompt --lyrics --instrumental (default when no lyrics) --lyrics-optimizer --title --model --format
// --endpoint --out <dir> --timeout <s> --json.  Key: $MINIMAX_API_KEY, else an `export MINIMAX_API_KEY=…` line in
// ~/.config/pixel-pet/minimax.env / ~/.zshrc / ~/.bashrc (scripts/minimax-key.js). The key is never printed.
// Exit code: 0 the file was saved and looks like audio, 1 a MusicError (its reason is printed), 2 bad usage.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const music = require('../src/core/music');
const minimaxKey = require('./minimax-key');

const SAMPLE = path.join(__dirname, '..', 'test', 'fixtures', 'music-sample.mp3');

function parseArgs(argv) {
  const o = { mock: null, json: false, instrumental: null, lyricsOptimizer: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v == null) usage(`${a} needs a value`); return v; };
    if (a === '--mock') o.mock = 'async';
    else if (a.startsWith('--mock=')) o.mock = a.slice(7);
    else if (a === '--json') o.json = true;
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
  if (o.mock && !['async', 'sync', 'hex', 'error', 'timeout'].includes(o.mock)) usage(`--mock=${o.mock}: use async | sync | hex | error | timeout`);
  return o;
}

function usage(err) {
  const text = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
  (err ? console.error : console.log)(`${err ? `music-smoke: ${err}\n\n` : ''}${text}`);
  process.exit(err ? 2 : 0);
}

// An in-process stand-in for POST /v1/music_generation (+ the task query + the audio download): no sockets at all.
function mockFetch(mode, log) {
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
      if (mode === 'timeout') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
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
  if (!o.mock) {
    const k = minimaxKey.key();
    key = k.value;
    keyFrom = k.from === 'env' ? '$MINIMAX_API_KEY' : k.from;
    if (!key) { console.error('music-smoke: no MiniMax key. export MINIMAX_API_KEY=… (or run with --mock to check the flow offline)'); process.exit(1); }
  }
  const settings = { music: { ...(o.model ? { model: o.model } : {}), ...(o.format ? { format: o.format } : {}), ...(o.timeoutSec ? { timeoutSec: o.timeoutSec } : {}), outputDir: out } };
  const env = { ...process.env, ...(o.endpoint ? { MINIMAX_MUSIC_ENDPOINT: o.endpoint } : {}) };
  if (!env.MINIMAX_MUSIC_ENDPOINT && !o.mock) { const ep = minimaxKey.endpoint(); if (ep) env.MINIMAX_MUSIC_ENDPOINT = ep; }
  const config = music.resolveConfig({ settings, key: o.mock ? 'mock-key' : key, env: o.mock ? {} : env });
  if (o.mock) { config.endpoint = 'https://mock.minimax.local'; config.pollIntervalMs = 200; if (o.mock === 'timeout') config.timeoutMs = 1500; }

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
  log(`music-smoke: mode=${o.mock ? `mock(${o.mock})` : 'real'} endpoint=${config.endpoint} model=${config.model} format=${config.format} key=${o.mock ? 'mock' : `from ${keyFrom} (${key.length} chars, not shown)`} timeout=${config.timeoutMs / 1000}s out=${out}`);

  const client = music.createMusicClient(config, o.mock ? { fetch: mockFetch(o.mock, log) } : {});
  const started = Date.now();
  const stages = [];
  const onProgress = (p) => { stages.push(p.stage); log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${p.stage}${p.taskId ? ` task=${p.taskId}` : ''}${p.attempt ? ` attempt=${p.attempt} status=${p.status}` : ''}${p.filePath ? ` ${p.filePath}` : ''}`); };
  try {
    const task = await client.submit(params, { onProgress });
    log(`submitted: mode=${task.mode} status=${task.status} id=${task.id}`);
    const result = await client.wait(task, { onProgress });
    const saved = await client.save(task, result, { onProgress });
    const file = inspect(saved.filePath);
    const ok = file.bytes > 0 && file.kind !== 'unknown' && (!file.probe || file.probe.durationSec > 0);
    const summary = { ok, mode: o.mock ? `mock-${o.mock}` : 'real', elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)), stages, taskMode: task.mode, traceId: saved.meta.traceId, filePath: saved.filePath, fileUrl: saved.fileUrl, durationMs: saved.durationMs ?? null, file };
    if (o.json) console.log(JSON.stringify(summary));
    else {
      log(`saved: ${saved.filePath}`);
      log(`file: ${file.bytes} bytes, header ${file.kind}${file.probe ? `, ffprobe ${file.probe.codec} ${file.probe.sampleRate} Hz ${file.probe.channels} ch ${file.probe.durationSec}s` : ''}`);
      log(ok ? 'RESULT: PASS' : 'RESULT: FAIL (the saved file does not look like audio)');
    }
    process.exit(ok ? 0 : 1);
  } catch (e) {
    const err = { ok: false, mode: o.mock ? `mock-${o.mock}` : 'real', stages, reason: e.reason || 'error', code: e.code ?? null, traceId: e.traceId || null, error: e.message };
    if (o.json) console.log(JSON.stringify(err));
    else console.error(`RESULT: FAIL reason=${err.reason} code=${err.code} ${e.message}${err.traceId ? ` trace=${err.traceId}` : ''}`);
    process.exit(e instanceof music.MusicError ? 1 : 2);
  }
}

main();
