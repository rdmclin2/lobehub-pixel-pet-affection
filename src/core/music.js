'use strict';

// 音乐创作 (T-5088 → T-5651): the one entry the app uses — generateMusic(params, …) → { filePath, fileUrl,
// durationMs?, meta } — over three switchable services (settings.json music.provider):
//
//   fal         (default) MiniMax Music hosted on fal.ai, async queue: submit → poll status → result → download
//               (core/music-fal.js). Key: keys.fal (设置 → 音乐创作) or FAL_KEY.
//   elevenlabs  ElevenLabs Music, one synchronous request that answers with the file (core/music-elevenlabs.js).
//               Key: keys.elevenlabs (shared with 朗读 → ElevenLabs) or ELEVENLABS_API_KEY.
//   minimax     MiniMax's own music API (core/music-minimax.js). Closed to new accounts since 2026-11 (HTTP 410 +
//               2153), kept for accounts that still have it. Key: keys.minimax (shared with 朗读) or MINIMAX_API_KEY.
//
// The compose_music tool's parameters are the same whichever service is picked (core/music-common.js parseParams);
// each provider maps them to its own fields, and what it cannot take natively is reported in meta.mapping /
// meta.unsupported (and so in the tool's answer to the model), never dropped silently. Every failure is a
// MusicError { reason, code, retryable, provider, message (Chinese) }.
//
// Keys come from the key store (tts-keys.json, write-only) or the environment; never from settings.json, never
// hard-coded.

const path = require('node:path');
const C = require('./music-common');
const fal = require('./music-fal');
const elevenlabs = require('./music-elevenlabs');
const minimax = require('./music-minimax');

const PROVIDERS = { fal, elevenlabs, minimax };
const PROVIDER_IDS = ['fal', 'elevenlabs', 'minimax'];
const PROVIDER_LABELS = { fal: 'fal.ai（MiniMax Music）', elevenlabs: 'ElevenLabs Music', minimax: 'MiniMax 官方' };
// where each service's key lives: the key store slot, the environment variable, where to set it in the app
const KEY_SOURCES = {
  fal: { slot: 'fal', env: 'FAL_KEY', where: '设置 → 音乐创作 → fal.ai' },
  elevenlabs: { slot: 'elevenlabs', env: 'ELEVENLABS_API_KEY', where: '设置 → 朗读 → ElevenLabs' },
  minimax: { slot: 'minimax', env: 'MINIMAX_API_KEY', where: '设置 → 朗读 → MiniMax' },
};
// endpoint overrides from the environment (e2e stand-ins, proxies)
const ENDPOINT_ENV = { fal: 'FAL_MUSIC_ENDPOINT', elevenlabs: 'ELEVENLABS_MUSIC_ENDPOINT', minimax: 'MINIMAX_MUSIC_ENDPOINT' };
const RANGE = { timeoutSec: [30, 1800], pollIntervalSec: [1, 60] };

// MiniMax-direct names kept at the top level (settings from before T-5651 stay valid)
const { DEFAULT_ENDPOINT, GENERATE_PATH, QUERY_PATH, MODELS, SAMPLE_RATES, BITRATES, FORMATS, OUTPUT_FORMATS } = minimax;

// settings.json `music` (core/settings.js).
//   enabled          whether the AI may use compose_music (offered only when on AND the picked service has a key)
//   provider         fal | elevenlabs | minimax
//   endpoint, model, outputFormat   MiniMax direct (endpoint '' = MINIMAX_MUSIC_ENDPOINT, else 朗读's MiniMax
//                    endpoint, else DEFAULT_ENDPOINT)
//   format, sampleRate, bitrate     audio_setting for fal and MiniMax (ElevenLabs uses elevenlabs.outputFormat)
//   fal { endpoint ('' = FAL_MUSIC_ENDPOINT, else https://queue.fal.run), model }
//   elevenlabs { endpoint ('' = ELEVENLABS_MUSIC_ENDPOINT, else 朗读's ElevenLabs endpoint, else
//                https://api.elevenlabs.io), model, outputFormat }
//   outputDir ('' = <userData>/music), timeoutSec, pollIntervalSec   for every service
const MUSIC_DEFAULTS = {
  enabled: true, provider: 'fal', endpoint: '', model: 'music-3.0', outputDir: '', outputFormat: 'url', format: 'mp3', sampleRate: 44100, bitrate: 256000, timeoutSec: 600, pollIntervalSec: 3,
  fal: { endpoint: '', model: fal.MODELS[0] },
  elevenlabs: { endpoint: '', model: elevenlabs.MODELS[0], outputFormat: elevenlabs.OUTPUT_FORMATS[0] },
};

const pick = (v, list, d) => (list.includes(v) ? v : d);
const intIn = (v, [lo, hi], d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const cleanEp = (v) => {
  const ep = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '';
  return ep && C.httpsOk(ep) ? ep : '';
};

function normalizeMusic(raw) {
  const m = obj(raw);
  const f = obj(m.fal);
  const e = obj(m.elevenlabs);
  const dir = typeof m.outputDir === 'string' ? m.outputDir.trim() : '';
  return {
    enabled: m.enabled !== false,
    provider: pick(m.provider, PROVIDER_IDS, MUSIC_DEFAULTS.provider),
    endpoint: cleanEp(m.endpoint),
    model: pick(m.model, MODELS, MUSIC_DEFAULTS.model),
    outputDir: dir && path.isAbsolute(dir) && dir.length <= 500 ? dir : '',
    outputFormat: pick(m.outputFormat, OUTPUT_FORMATS, MUSIC_DEFAULTS.outputFormat),
    format: pick(m.format, FORMATS, MUSIC_DEFAULTS.format),
    sampleRate: pick(m.sampleRate, SAMPLE_RATES, MUSIC_DEFAULTS.sampleRate),
    bitrate: pick(m.bitrate, BITRATES, MUSIC_DEFAULTS.bitrate),
    timeoutSec: intIn(m.timeoutSec, RANGE.timeoutSec, MUSIC_DEFAULTS.timeoutSec),
    pollIntervalSec: intIn(m.pollIntervalSec, RANGE.pollIntervalSec, MUSIC_DEFAULTS.pollIntervalSec),
    fal: { endpoint: cleanEp(f.endpoint), model: pick(f.model, fal.MODELS, MUSIC_DEFAULTS.fal.model) },
    elevenlabs: { endpoint: cleanEp(e.endpoint), model: pick(e.model, elevenlabs.MODELS, MUSIC_DEFAULTS.elevenlabs.model), outputFormat: pick(e.outputFormat, elevenlabs.OUTPUT_FORMATS, MUSIC_DEFAULTS.elevenlabs.outputFormat) },
  };
}

// ---- config ----------------------------------------------------------------------------------------------------

const envStr = (env, k) => (env && typeof env[k] === 'string' ? env[k].trim() : '');

// The key of `provider`: keys[slot] (or `key`, the picked service's key from the caller), else its env variable.
function keyFor(provider, { key = '', keys = null, env = process.env } = {}) {
  const src = KEY_SOURCES[provider];
  if (!src) return '';
  const stored = keys && typeof keys === 'object' ? keys[src.slot] : typeof keys === 'function' ? keys(src.slot) : key;
  return (typeof stored === 'string' && stored.trim()) || envStr(env, src.env);
}

// Everything one generation needs, from the saved settings, the key store and the environment.
// settings: the whole normalized settings (or just { music, tts }); key: the picked service's key (or keys:
// { fal, elevenlabs, minimax } / a function slot → key); userDataDir: app.getPath('userData').
// allowInsecureLocal: e2e runs only (main.js under PIXELPET_TEST): an endpoint from the environment may be a
// stand-in on http://127.0.0.1:<port> (test/fixtures). Never set for a real run.
// provider: overrides settings.music.provider (the smoke script).
// -> { provider, endpoint, model, apiKey, outputDir, format, sampleRate, bitrate, outputFormat, elevenlabsFormat,
//      timeoutMs, pollIntervalMs, … }
function resolveConfig({ settings = {}, key = '', keys = null, env = process.env, userDataDir = '', allowInsecureLocal = false, provider = null } = {}) {
  const m = normalizeMusic(settings.music);
  const id = provider && PROVIDER_IDS.includes(provider) ? provider : m.provider;
  const tts = settings.tts && settings.tts.endpoints ? settings.tts.endpoints : {};
  const envEp = envStr(env, ENDPOINT_ENV[id]).replace(/\/+$/, '');
  const own = id === 'fal' ? m.fal.endpoint : id === 'elevenlabs' ? m.elevenlabs.endpoint : m.endpoint;
  if (!own && envEp && !C.endpointAllowed(envEp, { allowInsecureLocal })) throw new C.MusicError('bad-endpoint', `${ENDPOINT_ENV[id]} 不合法：必须是 https 地址，不能带账号密码`, { provider: id });
  const shared = id === 'minimax' ? tts.minimax : id === 'elevenlabs' ? tts.elevenlabs : '';
  const sharedEp = shared && C.httpsOk(shared) ? String(shared).trim().replace(/\/+$/, '') : '';
  const endpoint = own || envEp || sharedEp || PROVIDERS[id].DEFAULT_ENDPOINT;
  const model = id === 'fal' ? m.fal.model : id === 'elevenlabs' ? m.elevenlabs.model : m.model;
  const outputDir = m.outputDir || (userDataDir ? path.join(userDataDir, 'music') : '');
  return {
    ...m, provider: id, endpoint, model, apiKey: keyFor(id, { key, keys, env }), outputDir, elevenlabsFormat: m.elevenlabs.outputFormat,
    allowInsecureLocal: !!allowInsecureLocal, timeoutMs: m.timeoutSec * 1000, pollIntervalMs: m.pollIntervalSec * 1000, queryPath: QUERY_PATH,
  };
}

function checkConfig(cfg) {
  const id = (cfg && cfg.provider) || 'minimax';
  const src = KEY_SOURCES[id];
  if (!PROVIDERS[id]) throw new C.MusicError('bad-params', `不认识的音乐服务「${id}」，可用：${PROVIDER_IDS.join(' / ')}`);
  if (!cfg.apiKey) throw new C.MusicError('no-key', `没有 ${PROVIDERS[id].NAME} 的 API Key：在 ${src.where} 填写，或设置环境变量 ${src.env}`, { provider: id, retryable: false });
  if (!C.endpointAllowed(cfg.endpoint, cfg)) throw new C.MusicError('bad-endpoint', `${PROVIDERS[id].NAME} 音乐端点不合法：必须是 https 地址`, { provider: id, retryable: false });
  if (!cfg.outputDir || !path.isAbsolute(cfg.outputDir)) throw new C.MusicError('write', '没有可用的音乐保存目录', { provider: id });
}

// The picked provider's client: { config, submit, wait, save, generate (, cancel for fal) }. A config without a
// provider is MiniMax (as before T-5651). Every call checks the config first (no key → no request at all).
function createMusicClient(config, opts = {}) {
  const cfg = { provider: 'minimax', ...config };
  const impl = PROVIDERS[cfg.provider];
  if (!impl) throw new C.MusicError('bad-params', `不认识的音乐服务「${cfg.provider}」`);
  const client = impl.createClient(cfg, opts);
  const tag = (e) => { if (e instanceof C.MusicError && !e.provider) e.provider = cfg.provider; throw e; };
  const guarded = (fn) => async (...a) => { try { if (fn === client.submit || fn === client.generate) checkConfig(cfg); return await fn(...a); } catch (e) { return tag(e); } };
  return { ...client, submit: guarded(client.submit), wait: guarded(client.wait), save: guarded(client.save), generate: guarded(client.generate) };
}

// One call for the AI tool: generateMusic(params, { settings, key | keys, env, userDataDir, config, signal, fetch, onProgress, now })
async function generateMusic(params, { settings, key, keys, env, userDataDir, config, provider, fetch: fetchFn, signal, onProgress, now } = {}) {
  const cfg = config || resolveConfig({ settings, key, keys, env, userDataDir, provider });
  return createMusicClient(cfg, { fetch: fetchFn, now }).generate(params, { signal, onProgress });
}

// The MiniMax request body (kept as music.buildRequest; the tests and the smoke script use it), and each
// provider's own mapping by id.
const buildRequest = (params, config = {}) => minimax.buildRequest(params, normalizeMusic(config));
const buildRequestFor = (provider, params, config = {}) => {
  const id = PROVIDER_IDS.includes(provider) ? provider : 'minimax';
  const m = normalizeMusic(config);
  const cfg = { ...m, model: id === 'fal' ? m.fal.model : id === 'elevenlabs' ? m.elevenlabs.model : m.model, elevenlabsFormat: m.elevenlabs.outputFormat, ...(config.model ? { model: config.model } : {}) };
  return PROVIDERS[id].buildRequest(params, cfg);
};

module.exports = {
  PROVIDERS, PROVIDER_IDS, PROVIDER_LABELS, KEY_SOURCES, ENDPOINT_ENV,
  DEFAULT_ENDPOINT, GENERATE_PATH, QUERY_PATH, MODELS, SAMPLE_RATES, BITRATES, FORMATS, OUTPUT_FORMATS, STRUCTURE_TAGS: C.STRUCTURE_TAGS, LIMITS: C.LIMITS, RANGE,
  FAL_MODELS: fal.MODELS, FAL_DEFAULT_ENDPOINT: fal.DEFAULT_ENDPOINT, ELEVENLABS_MODELS: elevenlabs.MODELS, ELEVENLABS_OUTPUT_FORMATS: elevenlabs.OUTPUT_FORMATS, ELEVENLABS_DEFAULT_ENDPOINT: elevenlabs.DEFAULT_ENDPOINT,
  MUSIC_DEFAULTS, normalizeMusic, MusicError: C.MusicError, apiError: minimax.apiError, buildRequest, buildRequestFor, composePrompt: C.composePrompt, parseParams: C.parseParams,
  keyFor, resolveConfig, checkConfig, createMusicClient, generateMusic, fileBase: C.fileBase,
  endpointOk: C.httpsOk,
};
