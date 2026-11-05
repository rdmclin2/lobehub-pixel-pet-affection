'use strict';

// 音乐创作 provider 3 of 3 (T-5088, kept by T-5651): MiniMax's own music API, called directly.
// Since 2026-11 the API answers new accounts HTTP 410 + base_resp 2153 ("This Music API is no longer available to new
// users. Existing paying customers can continue to use the service."), so it is the third choice now; fal.ai's hosted
// MiniMax Music (music-fal.js) is the default.
//
// API (checked 2026-11-04 against the official docs):
//   POST {endpoint}/v1/music_generation   Authorization: Bearer <key>   Content-Type: application/json
//   China site  https://platform.minimaxi.com/docs/api-reference/music-generation  (→ platform.minimax.cn, host api.minimax.cn)
//   Global site https://platform.minimax.io/docs/api-reference/music-generation    (host api.minimax.io)
//   Error codes https://platform.minimaxi.com/docs/api-reference/errorcode
//
//   Request body:
//     model             'music-3.0' (recommended, 120 RPM) | 'music-2.6' (120 RPM). 'music-cover' (翻唱, needs a
//                       reference audio) is not offered here; the *-free models are discontinued per the docs notice.
//     prompt            style / genre / mood / scene. ≤ 2000 chars; required (1–2000) when is_instrumental is true.
//     lyrics            lines split by \n, structure tags [Intro] [Verse] [Pre Chorus] [Chorus] [Interlude] [Bridge]
//                       [Outro] [Post Chorus] [Transition] [Break] [Hook] [Build Up] [Inst] [Solo]. 1–3500 chars,
//                       required unless is_instrumental or lyrics_optimizer.
//     is_instrumental   boolean (music-3.0 / music-2.6): pure music, no vocals — the native field, so 纯音乐 uses it.
//     lyrics_optimizer  boolean: lyrics written from the prompt when `lyrics` is empty.
//     stream            false here (stream only allows hex and we want one complete file).
//     output_format     'url' (valid 24 h, downloaded at once) | 'hex' (default on their side).
//     audio_setting     { sample_rate: 16000|24000|32000|44100, bitrate: 32000|64000|128000|256000, format: mp3|wav|pcm }
//     aigc_watermark    boolean, default false.
//   There is NO duration / BPM / structure field: those are written into the prompt as hints (see composePrompt), and
//   the structure also shows as tags in the lyrics.
//
//   Response: { data: { status: 1 (generating) | 2 (done), audio: <hex or url> }, trace_id,
//               extra_info: { music_duration (ms), music_sample_rate, music_channel, bitrate, music_size }, base_resp }
//   The endpoint is synchronous: the POST returns once the song is done (it can take minutes). No task id or query
//   endpoint is documented for music. So submit() → wait() → save() is one interface either way: a sync answer is
//   a task that is already done; should the endpoint answer with a `task_id` (as MiniMax's async video API does),
//   wait() polls {endpoint}{queryPath}?task_id=… every pollIntervalMs until it succeeds / fails / times out.
//
//   base_resp.status_code (HTTP is 200 for these): 0 ok · 1002 / 1039 / 1041 / 1045 / 2045 rate limits · 1004 / 2049
//   bad key · 1008 / 2053 / 2067 balance · 1026 / 1027 / 1040 sensitive content · 2013 / 2014 bad params ·
//   2022 / 2061 / 2068 / 2069 model not available · 2153 (HTTP 410) closed to new users · 1001 / 2066 timeout · 1000 / 1024 / 1033 / 2064 server.
//   Price (official): billed per song by MiniMax; see https://platform.minimaxi.com/docs/guides/pricing.
//
// The key is keys.minimax (tts-keys.json — the same MiniMax account key the 朗读 engine uses), else MINIMAX_API_KEY.

const C = require('./music-common');
const { MusicError, badParams } = C;

const ID = 'minimax';
const NAME = 'MiniMax';
const DEFAULT_ENDPOINT = 'https://api.minimax.cn';
const GENERATE_PATH = '/v1/music_generation';
const QUERY_PATH = '/v1/query/music_generation'; // only used if the API ever answers with a task_id (see above)
const MODELS = ['music-3.0', 'music-2.6'];
const SAMPLE_RATES = [16000, 24000, 32000, 44100];
const BITRATES = [32000, 64000, 128000, 256000];
const FORMATS = ['mp3', 'wav', 'pcm'];
const OUTPUT_FORMATS = ['url', 'hex'];

// ---- errors ----------------------------------------------------------------------------------------------------

const API_ERRORS = [
  [[1004, 2049], 'auth', 'MiniMax API Key 无效或未授权，请在 设置 → 朗读 → MiniMax 检查 Key'],
  [[1002, 1039, 1041, 1045, 2045, 2046, 2047, 2056, 2062], 'rate-limit', 'MiniMax 请求太频繁（触发限流），请稍后再试'],
  [[1008, 2053, 2067], 'balance', 'MiniMax 账户余额或额度不足'],
  [[1026, 1027, 1040, 1046], 'sensitive', '内容涉及敏感信息，MiniMax 拒绝生成，请换个描述或歌词'],
  [[2013, 2014, 1042], 'bad-params', 'MiniMax 认为请求参数不合法'],
  [[2022, 2061, 2068, 2069], 'model', '这个音乐模型不存在、已下线或当前账号无权使用'],
  // HTTP 410 + 2153 (seen 2026-11-04): the key is fine (朗读 still works), the account just cannot use music.
  [[2153], 'unavailable', 'MiniMax 音乐接口已不再向新用户开放，这个账号用不了（仅已付费的老用户可继续使用）；Key 本身没问题，可在 设置 → 音乐创作 改用 fal.ai 或 ElevenLabs'],
  [[1001, 2066], 'server', 'MiniMax 处理超时，请稍后重试'],
  [[1000, 1024, 1033, 2064], 'server', 'MiniMax 服务暂时出错，请稍后重试'],
];

function apiError(code, msg, traceId) {
  const hit = API_ERRORS.find(([codes]) => codes.includes(code));
  const [reason, text] = hit ? [hit[1], hit[2]] : ['server', `MiniMax 返回错误${msg ? `：${String(msg).slice(0, 120)}` : ''}`];
  return new MusicError(reason, text, { code, traceId, detail: msg || null, provider: ID });
}

function httpError(status) {
  if (status === 401 || status === 403) return new MusicError('auth', 'MiniMax API Key 无效或未授权', { code: `http-${status}`, status, provider: ID });
  if (status === 429) return new MusicError('rate-limit', 'MiniMax 请求太频繁（触发限流），请稍后再试', { code: 'http-429', status, provider: ID });
  if (status >= 500) return new MusicError('server', 'MiniMax 服务暂时不可用，请稍后重试', { code: `http-${status}`, status, provider: ID });
  return new MusicError('server', `MiniMax 请求失败（HTTP ${status}）`, { code: `http-${status}`, status, provider: ID });
}

// ---- parameters ------------------------------------------------------------------------------------------------

// The compose_music arguments → MiniMax's body.
// params: compose_music's fields + model / format / sampleRate / bitrate / outputFormat / watermark overrides.
// -> { body, title, warnings, hints: { bpm, durationSec, structure }, mapping } or throws MusicError('bad-params')
function buildRequest(params, cfg = {}) {
  const p = C.parseParams(params);
  const model = params.model == null || params.model === '' ? cfg.model || MODELS[0] : params.model;
  if (!MODELS.includes(model)) throw badParams(`不支持的模型「${model}」，可用：${MODELS.join(' / ')}`);
  const prompt = C.composePrompt(p);
  if (prompt.length > C.LIMITS.prompt) throw badParams(`描述加上风格 / 情绪 / BPM 等提示后太长了（最多 ${C.LIMITS.prompt} 字）`);
  const format = params.format == null ? cfg.format || 'mp3' : params.format;
  if (!FORMATS.includes(format)) throw badParams(`format 只能是 ${FORMATS.join(' / ')}`);
  const sampleRate = params.sampleRate == null ? cfg.sampleRate || 44100 : Number(params.sampleRate);
  if (!SAMPLE_RATES.includes(sampleRate)) throw badParams(`sampleRate 只能是 ${SAMPLE_RATES.join(' / ')}`);
  const bitrate = params.bitrate == null ? cfg.bitrate || 256000 : Number(params.bitrate);
  if (!BITRATES.includes(bitrate)) throw badParams(`bitrate 只能是 ${BITRATES.join(' / ')}`);
  const outputFormat = params.outputFormat == null ? cfg.outputFormat || 'url' : params.outputFormat;
  if (!OUTPUT_FORMATS.includes(outputFormat)) throw badParams('outputFormat 只能是 url / hex');

  const body = { model, stream: false, output_format: outputFormat, audio_setting: { sample_rate: sampleRate, bitrate, format }, aigc_watermark: params.watermark === true };
  if (prompt) body.prompt = prompt;
  if (p.lyrics) body.lyrics = p.lyrics;
  if (p.instrumental) body.is_instrumental = true;
  if (!p.instrumental && !p.lyrics && p.lyricsOptimizer) body.lyrics_optimizer = true;
  const mapping = C.mappingOf(p, { native: ['prompt', 'lyrics', 'instrumental', 'lyricsOptimizer'], prompt: ['genre', 'mood', 'scene', 'instruments', 'vocals', 'bpm', 'durationSec', 'structure'] });
  return { body, title: p.title, warnings: p.warnings, hints: { bpm: p.bpm, durationSec: p.durationSec, structure: p.structure }, mapping };
}

// ---- the client ------------------------------------------------------------------------------------------------

async function callJson(fetchFn, url, init, dl) {
  const res = await C.send(fetchFn, url, init, dl, NAME);
  if (!res.ok) {
    // MiniMax may explain a non-2xx answer in base_resp (410 + 2153 = closed to new users): prefer that over the status
    const body = await C.readJson(res, dl);
    const c = body && body.base_resp ? body.base_resp.status_code : null;
    if (c != null && c !== 0) { const e = apiError(c, body.base_resp.status_msg, body.trace_id || null); e.status = res.status; throw e; }
    throw httpError(res.status);
  }
  const j = await C.readJson(res, dl);
  if (j == null) throw new MusicError('server', 'MiniMax 返回的不是 JSON', { provider: ID });
  const code = j && j.base_resp ? j.base_resp.status_code : 0;
  if (code !== 0 && code != null) throw apiError(code, j.base_resp.status_msg, j.trace_id || null);
  return j || {};
}

const HEX = /^(?:[0-9a-f]{2})+$/i;
// a finished answer's audio: { audioHex } | { audioUrl } | null
function audioOf(data) {
  const d = data && typeof data === 'object' ? data : {};
  const a = typeof d.audio === 'string' ? d.audio.trim() : typeof d.audio_url === 'string' ? d.audio_url.trim() : '';
  if (!a) return null;
  if (/^https?:\/\//i.test(a)) return { audioUrl: a };
  if (HEX.test(a)) return { audioHex: a };
  return null;
}

// Task status from a query answer: 'pending' | 'succeeded' | 'failed'
function statusOf(data) {
  const s = data && (data.status ?? data.task_status);
  if (s === 2 || /^(success|succeeded|finished|done|completed)$/i.test(String(s))) return 'succeeded';
  if (/^(fail|failed|error|expired|cancel(l)?ed)$/i.test(String(s)) || s === 3 || s === -1) return 'failed';
  return 'pending';
}

function createClient(config, { fetch: fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  const cfg = { ...config };
  const headers = () => ({ Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' });

  // POST the job. -> task { id, mode: 'sync' | 'async', status, model, request, traceId, createdAt, result? }
  async function submit(params, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    const req = buildRequest(params, cfg);
    const dl = C.deadline(signal, timeoutMs);
    try {
      if (onProgress) onProgress({ stage: 'submitting', model: req.body.model });
      const j = await callJson(fetchFn, `${cfg.endpoint}${GENERATE_PATH}`, { method: 'POST', headers: headers(), body: JSON.stringify(req.body) }, dl);
      const createdAt = now();
      const traceId = j.trace_id || null;
      const taskId = j.task_id || (j.data && j.data.task_id) || null;
      const base = { provider: ID, model: req.body.model, request: req, traceId, createdAt, title: req.title, warnings: req.warnings };
      const audio = audioOf(j.data);
      if (audio) return { ...base, id: traceId || `local-${createdAt}`, mode: 'sync', status: 'succeeded', result: { ...audio, extra: j.extra_info || {}, traceId } };
      if (taskId) {
        if (onProgress) onProgress({ stage: 'submitted', taskId });
        return { ...base, id: String(taskId), mode: 'async', status: 'pending' };
      }
      if (j.data && statusOf(j.data) === 'failed') throw new MusicError('task-failed', '音乐生成失败', { traceId, provider: ID });
      throw new MusicError('empty', 'MiniMax 没有返回音频', { traceId, provider: ID });
    } finally {
      dl.done();
    }
  }

  // Until the task is done: { audioHex | audioUrl, extra, traceId }. Polls async tasks every pollIntervalMs.
  async function wait(task, { signal, timeoutMs = cfg.timeoutMs, pollIntervalMs = cfg.pollIntervalMs, onProgress } = {}) {
    if (!task || typeof task !== 'object') throw badParams('缺少任务');
    if (task.status === 'succeeded' && task.result) return task.result;
    if (task.status === 'failed') throw new MusicError('task-failed', '音乐生成失败', { traceId: task.traceId, provider: ID });
    const dl = C.deadline(signal, timeoutMs);
    try {
      for (let attempt = 1; ; attempt++) {
        const j = await callJson(fetchFn, `${cfg.endpoint}${cfg.queryPath || QUERY_PATH}?task_id=${encodeURIComponent(task.id)}`, { method: 'GET', headers: headers() }, dl);
        const data = j.data && typeof j.data === 'object' ? j.data : j;
        const st = statusOf(data);
        if (onProgress) onProgress({ stage: 'polling', taskId: task.id, attempt, status: st });
        if (st === 'failed') throw new MusicError('task-failed', `音乐生成失败${data.error || data.status_msg ? `：${String(data.error || data.status_msg).slice(0, 120)}` : ''}`, { traceId: j.trace_id || task.traceId, provider: ID });
        if (st === 'succeeded') {
          const audio = audioOf(data);
          if (!audio) throw new MusicError('empty', 'MiniMax 任务完成但没有音频', { traceId: j.trace_id || task.traceId, provider: ID });
          task.status = 'succeeded';
          task.result = { ...audio, extra: j.extra_info || data.extra_info || {}, traceId: j.trace_id || task.traceId };
          return task.result;
        }
        await C.sleepFor(pollIntervalMs, dl.signal, dl.reason);
      }
    } finally {
      dl.done();
    }
  }

  // Write the audio to outputDir. -> { filePath, fileUrl, durationMs, meta }
  async function save(task, result = task.result, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    if (!result) throw new MusicError('empty', '没有可保存的音频', { provider: ID });
    const dl = C.deadline(signal, timeoutMs);
    let audio;
    try {
      if (result.audioHex) audio = Buffer.from(result.audioHex, 'hex');
      else if (result.audioUrl) {
        if (onProgress) onProgress({ stage: 'downloading' });
        audio = await C.downloadAudio(fetchFn, result.audioUrl, dl);
      }
    } finally {
      dl.done();
    }
    if (!audio || !audio.length) throw new MusicError('empty', '音频是空的', { provider: ID });
    const req = task.request || { body: { audio_setting: {} }, mapping: null };
    const format = (req.body.audio_setting && req.body.audio_setting.format) || cfg.format || 'mp3';
    const { filePath, fileUrl } = await C.writeAudio(cfg.outputDir, { audio, title: task.title, format, date: new Date(now()) });
    const extra = result.extra || {};
    const durationMs = Number.isFinite(Number(extra.music_duration)) && Number(extra.music_duration) > 0 ? Number(extra.music_duration) : undefined;
    const meta = {
      provider: ID, title: task.title || '', model: task.model, taskId: task.id, mode: task.mode, traceId: result.traceId || task.traceId || null,
      prompt: req.body.prompt || '', lyrics: req.body.lyrics || '', instrumental: req.body.is_instrumental === true,
      format, sampleRate: req.body.audio_setting && req.body.audio_setting.sample_rate, bitrate: req.body.audio_setting && req.body.audio_setting.bitrate,
      source: result.audioHex ? 'hex' : 'url', bytes: audio.length, extra, hints: req.hints || {}, mapping: req.mapping || null,
      unsupported: C.unsupportedOf(req.mapping), warnings: task.warnings || [], createdAt: new Date(task.createdAt || now()).toISOString(),
    };
    if (onProgress) onProgress({ stage: 'saved', filePath });
    return { filePath, fileUrl, durationMs, meta };
  }

  // submit → wait → save under one deadline and one AbortSignal.
  async function generate(params, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    const started = now();
    const left = () => Math.max(1, timeoutMs - (now() - started));
    const task = await submit(params, { signal, timeoutMs, onProgress });
    const result = await wait(task, { signal, timeoutMs: left(), onProgress });
    return save(task, result, { signal, timeoutMs: left(), onProgress });
  }

  return { config: cfg, submit, wait, save, generate };
}

module.exports = { ID, NAME, DEFAULT_ENDPOINT, GENERATE_PATH, QUERY_PATH, MODELS, SAMPLE_RATES, BITRATES, FORMATS, OUTPUT_FORMATS, API_ERRORS, apiError, httpError, buildRequest, createClient };
