'use strict';
// 语音输入 (ASR): turn what the owner said into text, in the main process. docs/asr-design.md §3–§4.
// Two providers behind one interface, like core/tts.js:
//   lobehub — LobeHub's own speech recognition through the CLI (`lh generate asr <file> --provider lobehub
//             --model … --json`, spawned like every other lh call: core/lh-client.js runLh + cleanEnv)
//   local   — a recognition server the owner runs on their own machine (whisper.cpp `whisper-server`,
//             speaches / faster-whisper-server, LocalAI…): HTTP multipart POST to the OpenAI-compatible
//             /v1/audio/transcriptions (or whisper.cpp's own /inference)
//
// Every provider has the same shape (PROVIDERS):
//   { id, label, available(set, ctx), config(set, ctx), timeoutMs(cfg, audio), transcribe(cfg, audio, ctx) -> { text, lang } }
//   audio = { buffer: Buffer, mime: 'audio/webm' | 'audio/wav' | 'audio/mpeg' | …, ms }   (ms: how long she listened)
//   failures throw an AsrError with a `reason` (see REASONS)
// providerChain() picks the providers for one clip from settings: the chosen engine, then (with `fallback`) the other.
// AsrEngine runs the chain with timeouts, a breaker per provider and one recognition at a time.
//
// Privacy: audio is never logged and never kept. The lobehub provider needs a file (lh only takes a path or a
// URL): it lives in the temp dir, 0600, for the duration of the call. Recognised text is not logged either.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ENGINES = ['lobehub', 'local', 'off'];
const PROVIDER_IDS = ['lobehub', 'local'];
const LOCAL_APIS = ['openai', 'whispercpp']; // openai: POST /v1/audio/transcriptions · whispercpp: POST /inference
const LOCAL_PORT = 8179; // whisper.cpp started with --inference-path /v1/audio/transcriptions (docs/asr-design.md §2.1)
const DEFAULT_ENDPOINT = `http://127.0.0.1:${LOCAL_PORT}`;
const LOBEHUB_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe'];
const KEY_ID = 'asrlocal'; // the local server's optional API key, in tts-keys.json (core/tts-keys.js)
const MAX_BYTES = 8 * 1024 * 1024; // a clip bigger than this is refused before it goes anywhere
const SECONDS = { min: 5, max: 120, default: 60 }; // how long one clip may be (the recorder stops there)
const LOCAL_TIMEOUT = { min: 5, max: 120, default: 30 }; // seconds; CPU inference, the first request after start ~16 s
const LOBEHUB_TIMEOUT_MS = 30000; // + 100 ms per second of audio, at most LOBEHUB_MAX_TIMEOUT_MS (3.3 MB upload took 10.5 s; one 3.5 s clip took 18 s)
const LOBEHUB_MAX_TIMEOUT_MS = 60000;
const BREAKER_MS = 5 * 60 * 1000; // a provider that refuses (login, model, no lh, not configured) is skipped for 5 minutes
const TRANSIENT_PAUSE_MS = 20 * 1000; // a timeout, network or server error: skipped briefly

// Why a recognition failed (AsrError#reason):
//   not-configured  ASR off, or the local provider without an endpoint
//   bad-audio       nothing usable was sent (no bytes, not audio/*, too big; HTTP 400; ffmpeg could not read it)
//   network         the local server is not running / unreachable
//   timeout         no answer in time
//   http-<status>   the local server answered with an HTTP error
//   unauthorized    LobeHub login missing or expired (lh: UNAUTHORIZED / a run token the endpoint refuses)
//   model           LobeHub does not offer that model (lh: LobeHubModelDeprecated)
//   no-lh           the lh CLI is not installed
//   server          the provider failed without saying why (lh: an empty "ASR failed:"; a reply that is not JSON)
//   empty           she heard nothing (no text, or whisper's [BLANK_AUDIO])
//   canceled        a newer clip or the owner stopped this one
class AsrError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'AsrError';
    this.reason = reason;
  }
}

// How long a provider is skipped after a failure. Failures about this one clip (empty, bad audio, canceled)
// pause nothing; a refusal pauses for BREAKER_MS; a passing failure for TRANSIENT_PAUSE_MS.
const NO_PAUSE = /^(empty|bad-audio|canceled|http-400|http-413|http-415|http-422)$/;
const TRANSIENT = /^(timeout|network|server|http-408|http-429|http-5\d\d)$/;
function pauseFor(reason, breakerMs = BREAKER_MS) {
  if (NO_PAUSE.test(reason)) return 0;
  if (TRANSIENT.test(reason)) return Math.min(TRANSIENT_PAUSE_MS, breakerMs);
  return breakerMs;
}

// ---- settings ---------------------------------------------------------------------------------------
// settings.asr (core/settings.js). Off until the owner switches it on (that is when the microphone is asked for).
const ASR_DEFAULTS = {
  enabled: false,
  engine: 'lobehub', // lobehub | local | off
  fallback: false, // when the engine fails, try the other provider once
  language: 'auto', // auto | an ISO-639-1 code (zh, en, ja…)
  maxSeconds: SECONDS.default,
  autoSend: false, // 识别后直接发送 (renderer): the text goes to the chat at once instead of waiting in the box
  lobehub: { model: LOBEHUB_MODELS[0] },
  local: { endpoint: DEFAULT_ENDPOINT, api: 'openai', model: 'whisper-1', timeoutSec: LOCAL_TIMEOUT.default },
};

const str = (v) => typeof v === 'string' && v.trim().length > 0;
const int = (v, { min, max, default: d }) => (Number.isFinite(Number(v)) ? Math.round(Math.min(max, Math.max(min, Number(v)))) : d);
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,80}$/;
const LANG_RE = /^(auto|[a-z]{2})$/;

// https anywhere; plain http to this machine or a machine on the home network (a GPU box next to the Mac).
// Same rule as the local voice server (core/tts.js endpointOkFor('local')): the clip goes only where the owner pointed.
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const privateHost = (h) => /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(h) || /^[a-z0-9-]+\.local$/i.test(h);
function endpointOk(u) {
  if (!str(u)) return false;
  try {
    const x = new URL(String(u).trim());
    return (x.protocol === 'https:' || (x.protocol === 'http:' && (LOOPBACK.includes(x.hostname) || privateHost(x.hostname)))) && !x.username && !x.password && !x.search && !x.hash;
  } catch {
    return false;
  }
}
const cleanEndpoint = (u) => String(u).trim().replace(/\/+$/, '');

// Any stored value -> a valid settings.asr. Older shapes are migrated:
//   no `asr` at all (settings from before 语音输入)        -> the defaults (off)
//   `provider: 'lobehub' | 'local' | 'auto'` (design draft) -> engine (auto = local, falling back to lobehub)
//   `local.endpoint: ''`                                     -> the default endpoint
function normalizeAsr(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let engine = r.engine;
  let fallback = r.fallback;
  if (engine === undefined && typeof r.provider === 'string') {
    engine = r.provider === 'auto' ? 'local' : r.provider;
    if (r.provider === 'auto' && fallback === undefined) fallback = true;
  }
  const lob = r.lobehub && typeof r.lobehub === 'object' ? r.lobehub : {};
  const loc = r.local && typeof r.local === 'object' ? r.local : {};
  return {
    enabled: r.enabled === true,
    engine: ENGINES.includes(engine) ? engine : ASR_DEFAULTS.engine,
    fallback: fallback === true,
    language: typeof r.language === 'string' && LANG_RE.test(r.language.trim().toLowerCase()) ? r.language.trim().toLowerCase() : ASR_DEFAULTS.language,
    maxSeconds: int(r.maxSeconds, SECONDS),
    autoSend: r.autoSend === true,
    lobehub: { model: typeof lob.model === 'string' && MODEL_RE.test(lob.model.trim()) ? lob.model.trim() : ASR_DEFAULTS.lobehub.model },
    local: {
      endpoint: endpointOk(loc.endpoint) ? cleanEndpoint(loc.endpoint) : DEFAULT_ENDPOINT,
      api: LOCAL_APIS.includes(loc.api) ? loc.api : ASR_DEFAULTS.local.api,
      model: typeof loc.model === 'string' && MODEL_RE.test(loc.model.trim()) ? loc.model.trim() : ASR_DEFAULTS.local.model,
      timeoutSec: int(loc.timeoutSec, LOCAL_TIMEOUT),
    },
  };
}

// The owner changed something in 高级设置 → 语音输入: merge, and say what could not be taken.
// Returns { asr, ok, errors: ['bad-endpoint' | 'bad-model' | 'bad-language' | 'bad-engine'] }.
function applyAsrPatch(cur, patch) {
  const c = normalizeAsr(cur);
  const p = patch && typeof patch === 'object' ? patch : {};
  const errors = [];
  const next = { ...c, lobehub: { ...c.lobehub }, local: { ...c.local } };
  if (typeof p.enabled === 'boolean') next.enabled = p.enabled;
  if (p.engine !== undefined) { if (ENGINES.includes(p.engine)) next.engine = p.engine; else errors.push('bad-engine'); }
  if (typeof p.fallback === 'boolean') next.fallback = p.fallback;
  if (p.language !== undefined) { if (typeof p.language === 'string' && LANG_RE.test(p.language.trim().toLowerCase())) next.language = p.language.trim().toLowerCase(); else errors.push('bad-language'); }
  if (p.maxSeconds !== undefined) next.maxSeconds = int(p.maxSeconds, SECONDS);
  if (typeof p.autoSend === 'boolean') next.autoSend = p.autoSend;
  const lob = p.lobehub && typeof p.lobehub === 'object' ? p.lobehub : {};
  if (lob.model !== undefined) { if (typeof lob.model === 'string' && MODEL_RE.test(lob.model.trim())) next.lobehub.model = lob.model.trim(); else errors.push('bad-model'); }
  const loc = p.local && typeof p.local === 'object' ? p.local : {};
  if (loc.endpoint !== undefined) {
    if (!str(loc.endpoint)) next.local.endpoint = DEFAULT_ENDPOINT; // cleared: back to the default
    else if (endpointOk(loc.endpoint)) next.local.endpoint = cleanEndpoint(loc.endpoint);
    else errors.push('bad-endpoint');
  }
  if (loc.api !== undefined && LOCAL_APIS.includes(loc.api)) next.local.api = loc.api;
  if (loc.model !== undefined) { if (typeof loc.model === 'string' && MODEL_RE.test(loc.model.trim())) next.local.model = loc.model.trim(); else errors.push('bad-model'); }
  if (loc.timeoutSec !== undefined) next.local.timeoutSec = int(loc.timeoutSec, LOCAL_TIMEOUT);
  return { asr: normalizeAsr(next), ok: errors.length === 0, errors };
}

// ASR is on when it is switched on and an engine is picked.
const asrActive = (set) => { const s = normalizeAsr(set); return s.enabled && s.engine !== 'off'; };

// Electron permission requests (main.js session handlers). Only the microphone is decided here: audio, asked
// by this app's own page (file://), with 语音输入 switched on. Never the camera, never a web page. Anything
// else is not ours to change and keeps Electron's default (granted). -> true | false | null (= not media).
function mediaAllowed({ permission, url, mediaTypes, settings } = {}) {
  if (permission !== 'media') return null;
  const ours = typeof url === 'string' && url.startsWith('file://');
  const types = Array.isArray(mediaTypes) ? mediaTypes : [];
  return ours && asrActive(settings) && types.every((t) => t === 'audio');
}

// The providers to try for one clip, in order.
function providerChain(set) {
  const s = normalizeAsr(set);
  if (s.engine === 'off') return [];
  const chain = [s.engine];
  if (s.fallback) for (const id of PROVIDER_IDS) if (!chain.includes(id)) chain.push(id);
  return chain;
}

// ---- audio --------------------------------------------------------------------------------------------
const baseMime = (m) => String(m || '').split(';')[0].trim().toLowerCase();
const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'm4a', 'audio/flac': 'flac' };
const extFor = (mime) => EXT[baseMime(mime)] || 'webm';

// What came over IPC -> { buffer, mime, ms }, or an AsrError('bad-audio').
function toAudio(bytes, mime, ms) {
  let buffer = null;
  if (Buffer.isBuffer(bytes)) buffer = bytes;
  else if (bytes instanceof ArrayBuffer) buffer = Buffer.from(bytes);
  else if (ArrayBuffer.isView(bytes)) buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer || !buffer.length) throw new AsrError('bad-audio', 'no audio');
  if (buffer.length > MAX_BYTES) throw new AsrError('bad-audio', `audio too big (${buffer.length} bytes)`);
  const m = baseMime(mime);
  if (!/^audio\/[a-z0-9.+-]+$/.test(m)) throw new AsrError('bad-audio', `not audio: ${String(mime).slice(0, 40)}`);
  const dur = Number(ms);
  return { buffer, mime: m, ms: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null };
}

// A short silent clip (16 kHz mono 16-bit WAV) for the connection test: a server that answers it with no text
// is running, reachable and accepts audio, without sending anything the owner said.
function silentWav(ms = 600, rate = 16000) {
  const samples = Math.round((rate * ms) / 1000);
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(data, 40);
  return b;
}

// What came back -> the text to put in the chat box ('' = nothing heard).
const cleanText = (t) => String(t || '').replace(/\[BLANK_AUDIO\]/gi, '').replace(/\s+/g, ' ').trim();
// whisper.cpp's verbose_json says "chinese"; OpenAI says "chinese" or "zh"
const LANG_NAMES = { chinese: 'zh', english: 'en', japanese: 'ja', korean: 'ko', french: 'fr', german: 'de', spanish: 'es', russian: 'ru', cantonese: 'yue' };
function normLang(l) {
  const v = String(l || '').trim().toLowerCase();
  if (!v) return null;
  if (/^[a-z]{2,3}$/.test(v)) return v;
  return LANG_NAMES[v] || null;
}

// ---- providers ------------------------------------------------------------------------------------
// lh's stderr -> a reason (docs/asr-design.md §1.4: "HH:MM:SS [ERROR] ASR failed: <message>").
function lhReason(stderr) {
  const s = String(stderr || '');
  if (/UNAUTHORI[SZ]ED|hetero-operation tokens|not logged in|lh login|\b401\b/i.test(s)) return 'unauthorized';
  if (/LobeHubModelDeprecated|model.*(not found|deprecated|unsupported)/i.test(s)) return 'model';
  if (/File not found/i.test(s)) return 'bad-audio';
  if (/unknown command|unknown option/i.test(s)) return 'no-lh'; // an lh too old to know `generate asr`
  return 'server';
}
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

const LOBEHUB = {
  id: 'lobehub',
  label: 'LobeHub 云端识别',
  available: () => true, // whether the owner is signed in shows on the first call
  config: (set) => ({ model: set.lobehub.model, language: set.language }),
  timeoutMs: (_cfg, audio) => Math.min(LOBEHUB_MAX_TIMEOUT_MS, LOBEHUB_TIMEOUT_MS + Math.round(((audio && audio.ms) || 0) / 10)),
  async transcribe(cfg, audio, { lh, signal, timeoutMs, tmpDir }) {
    if (!lh || typeof lh.asr !== 'function') throw new AsrError('not-configured', 'no lh client');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const file = path.join(tmpDir, `asr-${process.pid}-${crypto.randomBytes(6).toString('hex')}.${extFor(audio.mime)}`);
    fs.writeFileSync(file, audio.buffer, { mode: 0o600 });
    let r;
    try {
      // the CLI's own defaults (openai / whisper-1) answer HTTP 500: provider and model are always passed
      r = await lh.asr(file, { model: cfg.model, language: cfg.language === 'auto' ? null : cfg.language, timeoutMs, signal });
    } catch (e) {
      if (e && e.code === 'ETIMEDOUT') throw new AsrError('timeout', `lh generate asr timed out after ${timeoutMs}ms`);
      if (e && e.code === 'ECANCELED') throw new AsrError('canceled');
      if (e && e.code === 'ENOENT') throw new AsrError('no-lh', e.message);
      throw new AsrError('server', (e && e.message) || String(e));
    } finally {
      fs.rmSync(file, { force: true });
    }
    if (r.code !== 0) throw new AsrError(lhReason(r.stderr), lastLine(r.stderr) || `lh exited ${r.code}`);
    let j;
    try {
      j = JSON.parse(String(r.stdout || '').trim());
    } catch {
      throw new AsrError('server', 'lh did not print JSON');
    }
    const text = cleanText(j && j.text);
    if (!text) throw new AsrError('empty');
    return { text, lang: cfg.language === 'auto' ? null : cfg.language };
  },
};

const LOCAL = {
  id: 'local',
  label: '本地识别服务',
  available: (set) => endpointOk(set.local.endpoint),
  config: (set) => ({ endpoint: set.local.endpoint, api: set.local.api, model: set.local.model, language: set.language, timeoutSec: set.local.timeoutSec }),
  timeoutMs: (cfg) => cfg.timeoutSec * 1000,
  url(cfg) {
    const base = cleanEndpoint(cfg.endpoint);
    if (cfg.api === 'whispercpp') return /\/inference$/.test(base) ? base : `${base}/inference`;
    if (/\/v1\/audio\/transcriptions$/.test(base)) return base;
    return `${base.replace(/\/v1$/, '')}/v1/audio/transcriptions`;
  },
  async transcribe(cfg, audio, { fetch, signal, key }) {
    if (!endpointOk(cfg.endpoint)) throw new AsrError('not-configured', 'no local endpoint');
    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.mime }), `clip.${extFor(audio.mime)}`);
    form.append('model', cfg.model);
    // whisper.cpp answers verbose_json with the detected language; plain json is what every OpenAI-shaped server takes
    form.append('response_format', cfg.api === 'whispercpp' ? 'verbose_json' : 'json');
    form.append('temperature', '0');
    if (cfg.language !== 'auto') form.append('language', cfg.language);
    let res;
    try {
      res = await fetch(LOCAL.url(cfg), { method: 'POST', body: form, signal, headers: key ? { Authorization: `Bearer ${key}` } : {} });
    } catch (e) {
      throw fetchError(e, signal);
    }
    let body;
    try {
      body = await res.text();
    } catch (e) {
      throw fetchError(e, signal);
    }
    if (!res.ok) throw new AsrError(`http-${res.status}`, `${res.status} ${body.slice(0, 160).trim()}`);
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      throw new AsrError('server', `not JSON: ${body.slice(0, 80)}`);
    }
    if (j && j.error) throw new AsrError('server', String(j.error.message || j.error).slice(0, 160));
    const text = cleanText(j && j.text);
    if (!text) throw new AsrError('empty');
    return { text, lang: normLang(j.language) || (cfg.language !== 'auto' ? cfg.language : null) };
  },
};

// A fetch that threw -> timeout / canceled / network.
function fetchError(e, signal) {
  if (signal && signal.aborted) {
    const why = signal.reason;
    if (why && why.name === 'TimeoutError') return new AsrError('timeout', 'the local server did not answer in time');
    return new AsrError('canceled');
  }
  if (e && (e.name === 'TimeoutError')) return new AsrError('timeout', 'the local server did not answer in time');
  if (e && e.name === 'AbortError') return new AsrError('canceled');
  const cause = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(e);
  return new AsrError('network', `cannot reach the local server (${cause})`);
}

const PROVIDERS = { lobehub: LOBEHUB, local: LOCAL };

// ---- engine -------------------------------------------------------------------------------------------
class AsrEngine {
  // lh: { asr(file, { model, language, timeoutMs, signal }) -> { code, stdout, stderr } } (LhClient#asr)
  // keys: TtsKeyStore (the local server's optional key under KEY_ID) · fetch: global fetch · log(err)
  constructor({ lh = null, keys = null, fetch: fetchImpl = globalThis.fetch, tmpDir = path.join(os.tmpdir(), 'pixel-pet-asr'), now = () => Date.now(), log = () => {}, breakerMs = BREAKER_MS, timeoutMs = null } = {}) {
    this.lh = lh;
    this.keys = keys;
    this.fetch = fetchImpl;
    this.tmpDir = tmpDir;
    this.now = now;
    this.log = log;
    this.breakerMs = breakerMs;
    this.timeoutMs = timeoutMs; // tests only: one timeout for every provider instead of each provider's own
    this.health = {}; // id -> { until, reason, at }
    this._ac = null; // the recognition running now
    this.stats = { calls: 0, ok: 0, failed: 0, fellBack: 0 };
  }

  // Try every provider again (settings, key or engine changed).
  reset(id) {
    if (id) delete this.health[id];
    else this.health = {};
  }

  // Stop the recognition in flight (a newer clip, Esc, ASR switched off).
  cancel() {
    if (this._ac) this._ac.abort();
  }

  _ctx(id, signal, timeoutMs) {
    return { lh: this.lh, fetch: this.fetch, tmpDir: this.tmpDir, signal, timeoutMs, key: id === 'local' && this.keys ? this.keys.get(KEY_ID) : '' };
  }

  // One provider, one clip, its own timeout. Throws an AsrError.
  async _one(id, set, audio, outer) {
    const p = PROVIDERS[id];
    if (!p.available(set)) throw new AsrError('not-configured', `${id} is not configured`);
    const cfg = p.config(set);
    const timeoutMs = this.timeoutMs || p.timeoutMs(cfg, audio);
    // lh enforces its own timeout (runLh kills the process: ETIMEDOUT); fetch gets an AbortSignal.timeout
    const signal = id === 'local' ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : outer;
    try {
      return await p.transcribe(cfg, audio, this._ctx(id, signal, timeoutMs));
    } catch (e) {
      if (e instanceof AsrError) throw e;
      throw new AsrError('server', (e && e.message) || String(e));
    }
  }

  // Recognise one clip with the providers of settings.asr.
  // -> { ok: true, text, lang, provider, ms, fellBackFrom: [{ id, reason }] }
  //  | { ok: false, reason, message, provider (the last one tried), tried: [{ id, reason, skipped? }] }
  async transcribe(bytes, mime, settings, { ms } = {}) {
    const set = normalizeAsr(settings);
    const t0 = this.now();
    if (!asrActive(set)) return { ok: false, reason: 'not-configured', message: 'ASR is off', provider: null, tried: [] };
    let audio;
    try {
      audio = toAudio(bytes, mime, ms);
    } catch (e) {
      return { ok: false, reason: e.reason || 'bad-audio', message: e.message, provider: null, tried: [] };
    }
    this.cancel(); // one recognition at a time: the newer clip wins
    const ac = new AbortController();
    this._ac = ac;
    this.stats.calls++;
    const chain = providerChain(set);
    const tried = [];
    let last = null;
    try {
      for (let i = 0; i < chain.length; i++) {
        const id = chain[i];
        const h = this.health[id];
        // a paused provider is skipped, unless it is the last one left: the owner asked for an answer
        if (h && h.until > this.now() && i < chain.length - 1) { tried.push({ id, reason: h.reason, skipped: true }); continue; }
        const t1 = this.now();
        try {
          const r = await this._one(id, set, audio, ac.signal);
          delete this.health[id];
          this.stats.ok++;
          if (tried.length) this.stats.fellBack++;
          this.log({ asr: id, ok: true, ms: this.now() - t1, bytes: audio.buffer.length });
          return { ok: true, text: r.text, lang: r.lang, provider: id, ms: this.now() - t0, fellBackFrom: tried };
        } catch (e) {
          last = { id, e };
          this.log({ asr: id, ok: false, reason: e.reason, ms: this.now() - t1, bytes: audio.buffer.length });
          if (e.reason === 'canceled') break; // a newer clip: nothing more for this one
          const pause = pauseFor(e.reason, this.breakerMs);
          if (pause) this.health[id] = { until: this.now() + pause, reason: e.reason, at: this.now() };
          tried.push({ id, reason: e.reason });
          // the clip itself is the problem: another provider will not hear more in it
          if (e.reason === 'empty' || e.reason === 'bad-audio') break;
        }
      }
    } finally {
      if (this._ac === ac) this._ac = null;
    }
    this.stats.failed++;
    const e = last ? last.e : new AsrError('not-configured');
    return { ok: false, reason: e.reason, message: e.message, provider: last ? last.id : null, tried };
  }

  // 测试连接: send a short silent clip to each provider of the chain (or just `only`), ignoring the breaker.
  // A provider that answers with no text is fine: it is reachable, signed in and takes audio.
  // -> { ok, results: [{ provider, ok, reason?, message?, ms, text? }] }
  async test(settings, { only } = {}) {
    const set = normalizeAsr(settings);
    const ids = only ? [only].filter((id) => PROVIDERS[id]) : providerChain(set);
    if (!ids.length) return { ok: false, results: [], reason: 'not-configured' };
    const audio = { buffer: silentWav(), mime: 'audio/wav', ms: 600 };
    const results = [];
    for (const id of ids) {
      const t0 = this.now();
      try {
        const r = await this._one(id, set, audio, new AbortController().signal);
        results.push({ provider: id, ok: true, ms: this.now() - t0, text: r.text });
      } catch (e) {
        const ok = e.reason === 'empty';
        results.push({ provider: id, ok, ms: this.now() - t0, ...(ok ? { text: '' } : { reason: e.reason, message: e.message }) });
      }
      const last = results[results.length - 1];
      if (last.ok) delete this.health[id];
    }
    return { ok: results.every((r) => r.ok), results };
  }

  // For the settings view: per provider, whether it is paused and why (never keys or text).
  status() {
    const t = this.now();
    return Object.fromEntries(PROVIDER_IDS.map((id) => {
      const h = this.health[id];
      return [id, { label: PROVIDERS[id].label, paused: !!(h && h.until > t), reason: h ? h.reason : null, at: h ? h.at : null, ...(id === 'local' ? { hasKey: !!(this.keys && this.keys.has(KEY_ID)) } : {}) }];
    }));
  }
}

module.exports = { ENGINES, PROVIDER_IDS, LOCAL_APIS, LOCAL_PORT, DEFAULT_ENDPOINT, LOBEHUB_MODELS, KEY_ID, MAX_BYTES, BREAKER_MS, TRANSIENT_PAUSE_MS, ASR_DEFAULTS, AsrError, pauseFor, endpointOk, normalizeAsr, applyAsrPatch, asrActive, mediaAllowed, providerChain, toAudio, silentWav, cleanText, normLang, lhReason, extFor, PROVIDERS, AsrEngine };
