'use strict';
// Neural voices (TTS engines) behind one provider interface; docs/tts-voice-research.md §5–§8.
// The system voice (Web Speech, core/voice.js) stays the last fallback and runs in the renderer; the
// cloud engines run here in the main process, so API keys never reach the page.
//
// Every provider has the same shape (PROVIDERS):
//   { id, label, kind: 'neural' | 'system', needsKey, available(ctx), config(voice) }
//   neural: + defaultEndpoint, text(cfg, line, mood), synthesize(cfg, text, ctx) -> { audio: Buffer, mime }
//           (or throws a TtsError: http-401, timeout, network…); runs here, in main
//   system: + speak(text, cfg, env, on) — Web Speech (core/voice.js webSpeech); runs in the renderer
// providerChain() picks the providers for one line from settings: the chosen engine, the other engines
// with a key, then the system voice (unless the fallback is silence).
//
// A character sets her engines in her file under `voice.tts` (fish / minimax), next to the
// lang / pitch / rate / prefer the system voice uses. Older files without `tts` stay valid: the engines
// then use DEFAULT_TTS (or nothing for a provider without a default) and she falls back to the system voice.

const crypto = require('node:crypto');
const Voice = require('./voice');
const InteractionVoice = require('./interaction-voice');

const ENGINES = ['fish', 'minimax', 'system'];
const NEURAL = ['fish', 'minimax'];
const FALLBACKS = ['system', 'silent'];
const TIMEOUT_MS = 4000; // no response headers in this time: give up and fall back (doc §8)
const BODY_TIMEOUT_MS = 15000;
const BREAKER_MS = 5 * 60 * 1000; // a failing engine is skipped for 5 minutes, so not every line waits for a timeout
const MAX_TEXT = 300;

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
const str = (v) => typeof v === 'string' && v.trim().length > 0;

class TtsError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason;
  }
}

// ---- providers ------------------------------------------------------------------------------------
const neuralAvailable = (ctx) => !!(ctx && ctx.hasKey && ctx.online !== false);
const ttsOf = (voice) => (voice && typeof voice === 'object' ? voice.tts : null);

const FISH = {
  id: 'fish',
  label: 'Fish Audio',
  kind: 'neural',
  needsKey: true,
  defaultEndpoint: 'https://api.fish.audio',
  available: neuralAvailable,
  // the engine's settings for one character (her `voice`); null = she has no voice on this engine
  config(voice) {
    const t = ttsOf(voice);
    const f = t && t.fish;
    if (!f || !str(f.referenceId)) return null;
    const tags = f.moodTags && typeof f.moodTags === 'object' ? Object.fromEntries(Object.entries(f.moodTags).filter(([k, v]) => str(k) && str(v))) : {};
    return {
      voiceId: f.referenceId,
      model: str(f.model) ? f.model : 's2.1-pro',
      speed: clamp(f.speed, 0.5, 2, 1),
      volume: clamp(f.volume, -20, 20, 0),
      temperature: clamp(f.temperature, 0, 1, 0.7),
      topP: clamp(f.topP, 0, 1, 0.7),
      latency: ['normal', 'balanced'].includes(f.latency) ? f.latency : 'balanced',
      moodTags: tags,
    };
  },
  // the mood tag goes in front after speakable() (which strips brackets), never into the line itself
  text(cfg, text, mood) {
    const tag = mood && cfg.moodTags[mood];
    return tag ? `[${tag}]${text}` : text;
  },
  async synthesize(cfg, text, { key, endpoint, fetch, signal, wait }) {
    const res = await wait(fetch(`${endpoint}/v1/tts`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', model: cfg.model },
      body: JSON.stringify({ text, reference_id: cfg.voiceId, format: 'mp3', latency: cfg.latency, temperature: cfg.temperature, top_p: cfg.topP, prosody: { speed: cfg.speed, volume: cfg.volume }, normalize: true }),
    }));
    if (!res.ok) throw new TtsError(`http-${res.status}`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new TtsError('empty');
    return { audio, mime: (res.headers.get('content-type') || 'audio/mpeg').split(';')[0] };
  },
};

const MINIMAX = {
  id: 'minimax',
  label: 'MiniMax',
  kind: 'neural',
  needsKey: true,
  defaultEndpoint: 'https://api.minimax.cn',
  available: neuralAvailable,
  config(voice) {
    const t = ttsOf(voice);
    const m = t && t.minimax;
    if (!m || !str(m.voiceId)) return null;
    return {
      voiceId: m.voiceId,
      model: str(m.model) ? m.model : 'speech-2.8-turbo',
      speed: clamp(m.speed, 0.5, 2, 1),
      pitch: Math.round(clamp(m.pitch, -12, 12, 0)),
      vol: clamp(m.vol, 0.1, 10, 1),
      emotion: str(m.emotion) ? m.emotion : '',
    };
  },
  text: (_cfg, text) => text,
  async synthesize(cfg, text, { key, endpoint, fetch, signal, wait }) {
    const voice = { voice_id: cfg.voiceId, speed: cfg.speed, vol: cfg.vol, pitch: cfg.pitch, ...(cfg.emotion ? { emotion: cfg.emotion } : {}) };
    const res = await wait(fetch(`${endpoint}/v1/t2a_v2`, {
      method: 'POST',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: cfg.model, text, stream: false, voice_setting: voice, audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 } }),
    }));
    if (!res.ok) throw new TtsError(`http-${res.status}`);
    const j = await res.json().catch(() => null);
    const code = j && j.base_resp ? j.base_resp.status_code : -1;
    // MiniMax answers 200 with its own code: 1004 / 2049 are a bad key, 1002 / 1039 rate limits
    if (code !== 0) throw new TtsError([1004, 2049].includes(code) ? 'http-401' : `api-${code}`);
    const hex = j.data && j.data.audio;
    if (!str(hex) || !/^[0-9a-f]+$/i.test(hex)) throw new TtsError('empty');
    return { audio: Buffer.from(hex, 'hex'), mime: 'audio/mpeg' };
  },
};

// Web Speech: the system's own voices, free and offline (core/voice.js; spoken by the renderer).
const SYSTEM = { ...Voice.webSpeech, label: '系统语音（Web Speech）' };

const PROVIDERS = { fish: FISH, minimax: MINIMAX, system: SYSTEM };

// ---- character files --------------------------------------------------------------------------------
// Problems with a character's `voice` (empty = valid). The old shape { lang, pitch, rate, prefer } is valid as is.
// A plain string (the oldest shape, a system voice name) is valid too.
function validateVoice(v) {
  if (typeof v === 'string') return v.trim() ? [] : ['voice must be a system voice name or an object ({ lang, pitch, rate, prefer, tts })'];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['voice must be a system voice name or an object ({ lang, pitch, rate, prefer, tts })'];
  const errors = [];
  if (v.lang !== undefined && !str(v.lang)) errors.push('voice.lang must be a language tag such as zh-CN');
  for (const k of ['pitch', 'rate']) if (v[k] !== undefined && !Number.isFinite(v[k])) errors.push(`voice.${k} must be a number`);
  if (v.prefer !== undefined && (!Array.isArray(v.prefer) || !v.prefer.every(str))) errors.push('voice.prefer must be a list of system voice names');
  errors.push(...InteractionVoice.validateLines(v.lines)); // 拖拽 / 甩出 / 接住 lines (core/interaction-voice.js)
  if (v.tts === undefined) return errors;
  if (!v.tts || typeof v.tts !== 'object' || Array.isArray(v.tts)) return [...errors, 'voice.tts must be an object ({ fish, minimax })'];
  for (const [id, c] of Object.entries(v.tts)) {
    const at = `voice.tts.${id}`;
    if (!NEURAL.includes(id)) { errors.push(`${at}: unknown engine (one of ${NEURAL.join(', ')})`); continue; }
    if (!c || typeof c !== 'object') { errors.push(`${at} must be an object`); continue; }
    if (id === 'fish' && !/^[0-9a-f]{32}$/.test(c.referenceId || '')) errors.push(`${at}.referenceId must be a Fish Audio model id (32 hex characters)`);
    if (id === 'minimax' && !/^[A-Za-z0-9_() -]{2,80}$/.test(c.voiceId || '')) errors.push(`${at}.voiceId must be a MiniMax voice id`);
    if (c.model !== undefined && !str(c.model)) errors.push(`${at}.model must be a model name`);
    const ranges = id === 'fish' ? { speed: [0.5, 2], volume: [-20, 20], temperature: [0, 1], topP: [0, 1] } : { speed: [0.5, 2], pitch: [-12, 12], vol: [0.1, 10] };
    for (const [k, [lo, hi]] of Object.entries(ranges)) if (c[k] !== undefined && !(Number.isFinite(c[k]) && c[k] >= lo && c[k] <= hi)) errors.push(`${at}.${k} must be a number from ${lo} to ${hi}`);
    if (c.moodTags !== undefined && (!c.moodTags || typeof c.moodTags !== 'object' || !Object.values(c.moodTags).every(str))) errors.push(`${at}.moodTags must map moods to tags`);
  }
  return errors;
}

// What a character sounds like on one engine (null: she has none there).
function voiceFor(species, providerId) {
  const p = PROVIDERS[providerId];
  return p ? p.config(species && species.voice) : null;
}

// ---- settings ---------------------------------------------------------------------------------------
// settings.tts: which engine reads, what happens when it cannot (system voice or silence) and an endpoint
// per engine ('' = the official one). API keys are not here: they live encrypted in tts-keys.json.
const TTS_DEFAULTS = { provider: 'fish', fallback: 'system', endpoints: { fish: '', minimax: '' } };

const endpointOk = (u) => {
  if (!str(u)) return false;
  try {
    const x = new URL(u);
    return (x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname))) && !x.username && !x.password;
  } catch { return false; }
};

function normalizeTts(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ep = r.endpoints && typeof r.endpoints === 'object' ? r.endpoints : {};
  return {
    provider: ENGINES.includes(r.provider) ? r.provider : TTS_DEFAULTS.provider,
    fallback: FALLBACKS.includes(r.fallback) ? r.fallback : TTS_DEFAULTS.fallback,
    endpoints: Object.fromEntries(NEURAL.map((id) => [id, endpointOk(ep[id]) ? String(ep[id]).trim().replace(/\/+$/, '') : ''])),
  };
}

// The providers tried for one line, in order: the chosen engine, then any other engine with a key, then
// the system voice; with the fallback set to silence the chain just ends. 'system' chosen = only it.
function providerChain(tts, hasKey) {
  const t = normalizeTts(tts);
  if (t.provider === 'system') return ['system'];
  return [t.provider, ...NEURAL.filter((id) => id !== t.provider && hasKey(id)), ...(t.fallback === 'system' ? ['system'] : [])];
}

// Same engine + voice + parameters + text = same audio. Changing any of them makes a new key.
function cacheKey(providerId, cfg, text) {
  const { moodTags, ...params } = cfg;
  const norm = JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
  return crypto.createHash('sha256').update([providerId, cfg.model, cfg.voiceId, norm, text].join('|')).digest('hex');
}

// Never let a key reach a log line or an error shown on screen.
const redact = (msg, keys) => keys.filter((k) => str(k) && k.length >= 6).reduce((m, k) => m.split(k).join('***'), String(msg || ''));

// ---- engine -----------------------------------------------------------------------------------------
// One line at a time: a new synthesize() aborts the request still running (the renderer stops the audio).
class TtsEngine {
  constructor({ keys, cache = null, fetch = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS, bodyTimeoutMs = BODY_TIMEOUT_MS, breakerMs = BREAKER_MS, log = () => {} }) {
    Object.assign(this, { keys, cache, fetch, now, timeoutMs, bodyTimeoutMs, breakerMs, log });
    this.current = null;
    this.health = {}; // provider -> { until, reason, at }
    this.stats = { requests: 0, hits: 0, prewarmed: 0 };
    this.warmGen = 0; // a newer prewarm() (or stopAll) ends the one running
  }

  // A key or endpoint was changed: give every engine another chance.
  reset(providerId) {
    if (providerId) delete this.health[providerId];
    else this.health = {};
  }

  status() {
    const t = this.now();
    return Object.fromEntries(NEURAL.map((id) => {
      const h = this.health[id];
      return [id, { hasKey: !!this.keys.has(id), lastError: h ? h.reason : null, pausedFor: h && h.until > t ? Math.ceil((h.until - t) / 1000) : 0 }];
    }));
  }

  cancel() {
    if (this.current) this.current.abort('interrupted');
    this.current = null;
  }

  // { text, species, mood } + settings.tts -> { ok: true, audio, mime, provider, voiceId, cached, latencyMs, fellBackFrom }
  // or { ok: false, reason, fallback, fellBackFrom } (the renderer then uses the system voice or stays quiet).
  async synthesize({ text, species, mood }, tts) {
    const t0 = this.now();
    const set = normalizeTts(tts);
    const line = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT);
    this.cancel();
    const ctl = new AbortController();
    this.current = ctl;
    const fellBackFrom = [];
    const done = (r) => { if (this.current === ctl) this.current = null; return { ...r, fallback: set.fallback, fellBackFrom, latencyMs: this.now() - t0 }; };
    if (!line) return done({ ok: false, reason: 'empty' });
    for (const id of providerChain(set, (p) => this.keys.has(p))) {
      const p = PROVIDERS[id];
      if (p.kind === 'system') return done({ ok: false, reason: set.provider === 'system' ? 'system' : 'fallback', next: 'system' });
      const cfg = p.config(species && species.voice);
      if (!cfg) { fellBackFrom.push({ provider: id, reason: 'no-voice' }); continue; }
      const key = this.keys.get(id);
      if (!p.available({ hasKey: !!key })) { fellBackFrom.push({ provider: id, reason: 'no-key' }); continue; }
      const h = this.health[id];
      if (h && h.until > this.now()) { fellBackFrom.push({ provider: id, reason: `paused:${h.reason}` }); continue; }
      const said = p.text(cfg, line, mood);
      const ck = cacheKey(id, cfg, said);
      const hit = this.cache && this.cache.get(ck);
      if (hit) {
        this.stats.hits++;
        return done({ ok: true, audio: hit.audio, mime: hit.mime, provider: id, voiceId: cfg.voiceId, model: cfg.model, cached: true });
      }
      try {
        this.stats.requests++;
        const ask = p.synthesize(cfg, said, { key, endpoint: set.endpoints[id] || p.defaultEndpoint, fetch: this.fetch, signal: ctl.signal, wait: (pr) => this._within(pr, ctl, this.timeoutMs) });
        const { audio, mime } = await this._within(ask, ctl, this.bodyTimeoutMs);
        if (this.cache) this.cache.put(ck, audio, mime);
        delete this.health[id];
        return done({ ok: true, audio, mime, provider: id, voiceId: cfg.voiceId, model: cfg.model, cached: false });
      } catch (e) {
        if (ctl.signal.aborted && ctl.signal.reason === 'interrupted') return done({ ok: false, reason: 'interrupted' });
        const reason = e instanceof TtsError ? e.reason : ctl.signal.aborted ? 'timeout' : 'network';
        this.health[id] = { until: this.now() + this.breakerMs, reason, at: this.now() };
        fellBackFrom.push({ provider: id, reason });
        this.log(new Error(`tts ${id}: ${redact(reason === 'network' ? `network (${e.message})` : reason, this.keys.all())} — falling back`));
      }
    }
    return done({ ok: false, reason: 'fallback', next: null }); // silent
  }

  // 互动语音: synthesise her common short lines ahead into the cache, so a pat or a feed plays at once.
  // items: [{ text, mood }] (text already speakable). One request at a time, with its own abort
  // controller so a live line is never interrupted by it; only the engine the next line would use, and
  // only lines not cached yet. The first failure ends the prewarm (and pauses that engine like a live
  // line would). Returns { provider, warmed, cached, skipped, failed }.
  async prewarm(items, species, tts) {
    const gen = ++this.warmGen;
    const set = normalizeTts(tts);
    const out = { provider: null, warmed: 0, cached: 0, skipped: null, failed: null };
    if (!this.cache) return { ...out, skipped: 'no-cache' };
    let pick = null;
    for (const id of providerChain(set, (p) => this.keys.has(p))) {
      const p = PROVIDERS[id];
      if (p.kind === 'system') break;
      const cfg = p.config(species && species.voice);
      const key = this.keys.get(id);
      const h = this.health[id];
      if (cfg && key && !(h && h.until > this.now())) { pick = { id, p, cfg, key }; break; }
    }
    if (!pick) return { ...out, skipped: 'no-engine' };
    out.provider = pick.id;
    const seen = new Set();
    for (const it of Array.isArray(items) ? items : []) {
      if (gen !== this.warmGen) return { ...out, skipped: 'superseded' };
      const line = String((it && it.text) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TEXT);
      if (!line) continue;
      const said = pick.p.text(pick.cfg, line, it.mood || '');
      const ck = cacheKey(pick.id, pick.cfg, said);
      if (seen.has(ck)) continue;
      seen.add(ck);
      if (this.cache.has(ck)) { out.cached++; continue; }
      const ctl = new AbortController();
      this.warming = ctl;
      try {
        this.stats.requests++;
        const ask = pick.p.synthesize(pick.cfg, said, { key: pick.key, endpoint: set.endpoints[pick.id] || pick.p.defaultEndpoint, fetch: this.fetch, signal: ctl.signal, wait: (pr) => this._within(pr, ctl, this.timeoutMs) });
        const { audio, mime } = await this._within(ask, ctl, this.bodyTimeoutMs);
        if (gen !== this.warmGen) return { ...out, skipped: 'superseded' };
        this.cache.put(ck, audio, mime);
        this.stats.prewarmed++;
        out.warmed++;
      } catch (e) {
        if (ctl.signal.aborted && ctl.signal.reason === 'interrupted') return { ...out, skipped: 'stopped' };
        const reason = e instanceof TtsError ? e.reason : ctl.signal.aborted ? 'timeout' : 'network';
        this.health[pick.id] = { until: this.now() + this.breakerMs, reason, at: this.now() };
        this.log(new Error(`tts ${pick.id} prewarm: ${redact(reason === 'network' ? `network (${e.message})` : reason, this.keys.all())}`));
        return { ...out, failed: reason };
      } finally {
        if (this.warming === ctl) this.warming = null;
      }
    }
    return out;
  }

  // End the running prewarm at once (the engine, key or endpoint changed: it would keep asking the old one).
  endPrewarm() {
    this.warmGen++;
    if (this.warming) this.warming.abort('interrupted');
    this.warming = null;
  }

  // 朗读 switched off: stop the line being fetched and any prewarm, at once.
  stopAll() {
    this.cancel();
    this.endPrewarm();
  }

  // Resolve `pr` unless the line is interrupted or `ms` passes first (then the request is aborted).
  _within(pr, ctl, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ctl.abort('timeout'); reject(new TtsError('timeout')); }, ms);
      const onAbort = () => { clearTimeout(timer); reject(new TtsError(ctl.signal.reason === 'timeout' ? 'timeout' : 'interrupted')); };
      if (ctl.signal.aborted) return onAbort();
      ctl.signal.addEventListener('abort', onAbort, { once: true });
      pr.then((v) => { clearTimeout(timer); ctl.signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { clearTimeout(timer); ctl.signal.removeEventListener('abort', onAbort); reject(e); });
    });
  }
}

module.exports = { ENGINES, NEURAL, FALLBACKS, TIMEOUT_MS, BREAKER_MS, PROVIDERS, TTS_DEFAULTS, TtsError, validateVoice, voiceFor, normalizeTts, endpointOk, providerChain, cacheKey, redact, TtsEngine };
