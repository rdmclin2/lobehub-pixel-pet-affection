'use strict';

// 音乐创作 (T-5088): MiniMax music generation — submit a job, wait for it, save the audio under userData/music/.
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
//               extra_info: { music_duration (ms — the docs' example is 25364 for a ~25 s clip), music_sample_rate,
//               music_channel, bitrate, music_size }, base_resp: { status_code, status_msg } }
//   The endpoint is synchronous: the POST returns once the song is done (it can take minutes). No task id or query
//   endpoint is documented for music. So submit() → wait() → save() is one interface either way: a sync answer is
//   a task that is already done; should the endpoint answer with a `task_id` (as MiniMax's async video API does),
//   wait() polls {endpoint}{queryPath}?task_id=… every pollIntervalMs until it succeeds / fails / times out.
//
//   base_resp.status_code (HTTP is 200 for these): 0 ok · 1002 / 1039 / 1041 / 1045 / 2045 rate limits · 1004 / 2049
//   bad key · 1008 / 2053 / 2067 balance · 1026 / 1027 / 1040 sensitive content · 2013 / 2014 bad params ·
//   2022 / 2061 / 2068 / 2069 model not available · 1001 / 2066 timeout · 1000 / 1024 / 1033 / 2064 server.
//
// The key is keys.minimax (tts-keys.json — the same MiniMax account key the 朗读 engine uses; a key is per account
// and region, not per product), else the MINIMAX_API_KEY environment variable. Never written to settings.json.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { endpointOk } = require('./tts');

const DEFAULT_ENDPOINT = 'https://api.minimax.cn';
const GENERATE_PATH = '/v1/music_generation';
const QUERY_PATH = '/v1/query/music_generation'; // only used if the API ever answers with a task_id (see above)
const MODELS = ['music-3.0', 'music-2.6'];
const SAMPLE_RATES = [16000, 24000, 32000, 44100];
const BITRATES = [32000, 64000, 128000, 256000];
const FORMATS = ['mp3', 'wav', 'pcm'];
const OUTPUT_FORMATS = ['url', 'hex'];
const STRUCTURE_TAGS = ['Intro', 'Verse', 'Pre Chorus', 'Chorus', 'Interlude', 'Bridge', 'Outro', 'Post Chorus', 'Transition', 'Break', 'Hook', 'Build Up', 'Inst', 'Solo'];
const LIMITS = { prompt: 2000, lyrics: 3500, title: 60, hint: 200, durationSec: [10, 360], bpm: [40, 240] };
const RANGE = { timeoutSec: [30, 1800], pollIntervalSec: [1, 60] };
const MAX_DOWNLOAD = 200 * 1024 * 1024;

// settings.json `music` (core/settings.js). endpoint '' = MINIMAX_MUSIC_ENDPOINT, else tts.endpoints.minimax, else
// DEFAULT_ENDPOINT. outputDir '' = <userData>/music.
const MUSIC_DEFAULTS = { endpoint: '', model: 'music-3.0', outputDir: '', outputFormat: 'url', format: 'mp3', sampleRate: 44100, bitrate: 256000, timeoutSec: 600, pollIntervalSec: 3 };

const httpsOk = (u) => endpointOk(u, { lan: false });
const pick = (v, list, d) => (list.includes(v) ? v : d);
const intIn = (v, [lo, hi], d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

function normalizeMusic(raw) {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ep = typeof m.endpoint === 'string' ? m.endpoint.trim().replace(/\/+$/, '') : '';
  const dir = typeof m.outputDir === 'string' ? m.outputDir.trim() : '';
  return {
    endpoint: ep && httpsOk(ep) ? ep : '',
    model: pick(m.model, MODELS, MUSIC_DEFAULTS.model),
    outputDir: dir && path.isAbsolute(dir) && dir.length <= 500 ? dir : '',
    outputFormat: pick(m.outputFormat, OUTPUT_FORMATS, MUSIC_DEFAULTS.outputFormat),
    format: pick(m.format, FORMATS, MUSIC_DEFAULTS.format),
    sampleRate: pick(m.sampleRate, SAMPLE_RATES, MUSIC_DEFAULTS.sampleRate),
    bitrate: pick(m.bitrate, BITRATES, MUSIC_DEFAULTS.bitrate),
    timeoutSec: intIn(m.timeoutSec, RANGE.timeoutSec, MUSIC_DEFAULTS.timeoutSec),
    pollIntervalSec: intIn(m.pollIntervalSec, RANGE.pollIntervalSec, MUSIC_DEFAULTS.pollIntervalSec),
  };
}

// ---- errors ----------------------------------------------------------------------------------------------------

// reason: what kind of failure (no-key / bad-endpoint / bad-params / auth / rate-limit / balance / sensitive / model /
// server / task-failed / network / timeout / aborted / empty / download / write). code: MiniMax's
// base_resp.status_code, or `http-<status>`, or null. message: readable Chinese, with the code.
class MusicError extends Error {
  constructor(reason, message, { code = null, status = null, traceId = null, detail = null } = {}) {
    super(code != null ? `${message}（错误码 ${code}）` : message);
    this.name = 'MusicError';
    this.reason = reason;
    this.code = code;
    this.status = status;
    this.traceId = traceId;
    this.detail = detail;
  }
}

const API_ERRORS = [
  [[1004, 2049], 'auth', 'MiniMax API Key 无效或未授权，请在 设置 → 朗读 → MiniMax 检查 Key'],
  [[1002, 1039, 1041, 1045, 2045, 2046, 2047, 2056, 2062], 'rate-limit', 'MiniMax 请求太频繁（触发限流），请稍后再试'],
  [[1008, 2053, 2067], 'balance', 'MiniMax 账户余额或额度不足'],
  [[1026, 1027, 1040, 1046], 'sensitive', '内容涉及敏感信息，MiniMax 拒绝生成，请换个描述或歌词'],
  [[2013, 2014, 1042], 'bad-params', 'MiniMax 认为请求参数不合法'],
  [[2022, 2061, 2068, 2069], 'model', '这个音乐模型不存在、已下线或当前账号无权使用'],
  [[1001, 2066], 'server', 'MiniMax 处理超时，请稍后重试'],
  [[1000, 1024, 1033, 2064], 'server', 'MiniMax 服务暂时出错，请稍后重试'],
];

function apiError(code, msg, traceId) {
  const hit = API_ERRORS.find(([codes]) => codes.includes(code));
  const [reason, text] = hit ? [hit[1], hit[2]] : ['server', `MiniMax 返回错误${msg ? `：${String(msg).slice(0, 120)}` : ''}`];
  return new MusicError(reason, text, { code, traceId, detail: msg || null });
}

function httpError(status) {
  if (status === 401 || status === 403) return new MusicError('auth', 'MiniMax API Key 无效或未授权', { code: `http-${status}`, status });
  if (status === 429) return new MusicError('rate-limit', 'MiniMax 请求太频繁（触发限流），请稍后再试', { code: 'http-429', status });
  if (status >= 500) return new MusicError('server', 'MiniMax 服务暂时不可用，请稍后重试', { code: `http-${status}`, status });
  return new MusicError('server', `MiniMax 请求失败（HTTP ${status}）`, { code: `http-${status}`, status });
}

const badParams = (msg) => new MusicError('bad-params', msg);

// ---- parameters ------------------------------------------------------------------------------------------------

const cleanText = (v) => String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
const optText = (v, name, max) => {
  if (v == null || v === '') return '';
  if (typeof v !== 'string') throw badParams(`${name} 必须是文字`);
  const t = cleanText(v);
  if (t.length > max) throw badParams(`${name} 太长了（最多 ${max} 字）`);
  return t;
};
const optNum = (v, name, [lo, hi]) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) throw badParams(`${name} 需要 ${lo}–${hi} 之间的数字`);
  return Math.round(n);
};

// The tags in lyrics ([Verse], [Chorus] …) must be ones MiniMax knows; [verse 2] / [chorus] are matched loosely.
const TAG_KEY = (t) => t.toLowerCase().replace(/[\s_-]+/g, ' ').replace(/\s*\d+$/, '').trim();
const KNOWN_TAGS = new Map(STRUCTURE_TAGS.map((t) => [TAG_KEY(t), t]));
function lyricTags(lyrics) {
  return [...lyrics.matchAll(/^\s*\[([^\]\n]{1,30})\]\s*$/gm)].map((m) => m[1]);
}

function normalizeStructure(v) {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，>→/|]+/) : null;
  if (!list) throw badParams('structure 需要是段落列表，如 ["Intro","Verse","Chorus","Outro"]');
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw badParams('structure 里的每一段都要是文字');
    const s = raw.replace(/^\s*\[|\]\s*$/g, '').trim();
    if (!s) continue;
    const tag = KNOWN_TAGS.get(TAG_KEY(s));
    if (!tag) throw badParams(`不认识的段落「${s}」，可用：${STRUCTURE_TAGS.join(' / ')}`);
    out.push(tag);
  }
  if (out.length > 30) throw badParams('structure 最多 30 段');
  return out;
}

// prompt + the hints the API has no field for, in one description (≤ 2000 chars)
function composePrompt({ prompt, genre, mood, scene, instruments, vocals, bpm, durationSec, structure }) {
  const parts = [prompt];
  if (genre) parts.push(`Genre: ${genre}`);
  if (mood) parts.push(`Mood: ${mood}`);
  if (scene) parts.push(`Scene: ${scene}`);
  if (instruments) parts.push(`Instruments: ${instruments}`);
  if (vocals) parts.push(`Vocals: ${vocals}`);
  if (bpm) parts.push(`Tempo: ${bpm} BPM`);
  if (durationSec) parts.push(`Length: about ${durationSec} seconds`);
  if (structure.length) parts.push(`Structure: ${structure.join(' - ')}`);
  return parts.filter(Boolean).join('. ');
}

// Check what the caller (the AI tool) asked for and build the request body.
// params: { prompt, lyrics, instrumental, lyricsOptimizer, genre, mood, scene, instruments, vocals, bpm, durationSec,
//           structure, title, model, format, sampleRate, bitrate, outputFormat, watermark }
// -> { body, title, warnings, hints: { bpm, durationSec, structure } } or throws MusicError('bad-params')
function buildRequest(params, config = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw badParams('缺少创作参数');
  const cfg = normalizeMusic(config);
  const warnings = [];
  const model = params.model == null || params.model === '' ? cfg.model : params.model;
  if (!MODELS.includes(model)) throw badParams(`不支持的模型「${model}」，可用：${MODELS.join(' / ')}`);
  const instrumental = params.instrumental === true || params.is_instrumental === true;
  const lyricsOptimizer = params.lyricsOptimizer === true || params.lyrics_optimizer === true;
  const hint = (k) => optText(params[k], k, LIMITS.hint);
  const base = optText(params.prompt, 'prompt', LIMITS.prompt);
  let lyrics = optText(params.lyrics, 'lyrics', LIMITS.lyrics);
  const structure = normalizeStructure(params.structure);
  const bpm = optNum(params.bpm, 'bpm', LIMITS.bpm);
  const durationSec = optNum(params.durationSec ?? params.duration, 'durationSec', LIMITS.durationSec);
  const title = optText(params.title, 'title', LIMITS.title);
  const prompt = composePrompt({ prompt: base, genre: hint('genre'), mood: hint('mood'), scene: hint('scene'), instruments: hint('instruments'), vocals: instrumental ? '' : hint('vocals'), bpm, durationSec, structure });
  if (prompt.length > LIMITS.prompt) throw badParams(`描述加上风格 / 情绪 / BPM 等提示后太长了（最多 ${LIMITS.prompt} 字）`);

  if (instrumental) {
    if (!prompt) throw badParams('纯音乐需要 prompt（风格 / 情绪 / 场景描述）');
    if (lyrics) { warnings.push('纯音乐模式不使用歌词，已忽略 lyrics'); lyrics = ''; }
  } else if (!lyrics) {
    if (!lyricsOptimizer) throw badParams('有人声的歌需要 lyrics（可带 [Verse] / [Chorus] 等段落标签）；没有歌词时设 lyricsOptimizer: true 让模型按 prompt 写词，或设 instrumental: true 生成纯音乐');
    if (!prompt) throw badParams('让模型自动写词时需要 prompt');
  }
  if (lyrics) {
    const unknown = lyricTags(lyrics).filter((t) => !KNOWN_TAGS.has(TAG_KEY(t)));
    if (unknown.length) throw badParams(`歌词里有不认识的段落标签 ${unknown.map((t) => `[${t}]`).join(' ')}，可用：${STRUCTURE_TAGS.map((t) => `[${t}]`).join(' ')}`);
  }

  const format = params.format == null ? cfg.format : params.format;
  if (!FORMATS.includes(format)) throw badParams(`format 只能是 ${FORMATS.join(' / ')}`);
  const sampleRate = params.sampleRate == null ? cfg.sampleRate : Number(params.sampleRate);
  if (!SAMPLE_RATES.includes(sampleRate)) throw badParams(`sampleRate 只能是 ${SAMPLE_RATES.join(' / ')}`);
  const bitrate = params.bitrate == null ? cfg.bitrate : Number(params.bitrate);
  if (!BITRATES.includes(bitrate)) throw badParams(`bitrate 只能是 ${BITRATES.join(' / ')}`);
  const outputFormat = params.outputFormat == null ? cfg.outputFormat : params.outputFormat;
  if (!OUTPUT_FORMATS.includes(outputFormat)) throw badParams('outputFormat 只能是 url / hex');

  const body = { model, stream: false, output_format: outputFormat, audio_setting: { sample_rate: sampleRate, bitrate, format }, aigc_watermark: params.watermark === true };
  if (prompt) body.prompt = prompt;
  if (lyrics) body.lyrics = lyrics;
  if (instrumental) body.is_instrumental = true;
  if (!instrumental && !lyrics && lyricsOptimizer) body.lyrics_optimizer = true;
  return { body, title, warnings, hints: { bpm, durationSec, structure } };
}

// ---- config ----------------------------------------------------------------------------------------------------

// Everything one generation needs, from the saved settings, the key store and the environment.
// settings: the whole normalized settings (or just { music, tts }); key: keys.minimax (TtsKeyStore.get('minimax'));
// userDataDir: app.getPath('userData'). -> { endpoint, apiKey, model, outputDir, …, timeoutMs, pollIntervalMs }
function resolveConfig({ settings = {}, key = '', env = process.env, userDataDir = '' } = {}) {
  const m = normalizeMusic(settings.music);
  const ttsEp = settings.tts && settings.tts.endpoints && settings.tts.endpoints.minimax;
  const envEp = env && typeof env.MINIMAX_MUSIC_ENDPOINT === 'string' ? env.MINIMAX_MUSIC_ENDPOINT.trim().replace(/\/+$/, '') : '';
  if (!m.endpoint && envEp && !httpsOk(envEp)) throw new MusicError('bad-endpoint', 'MINIMAX_MUSIC_ENDPOINT 不合法：必须是 https 地址，不能带账号密码');
  const endpoint = m.endpoint || envEp || (ttsEp && httpsOk(ttsEp) ? String(ttsEp).replace(/\/+$/, '') : '') || DEFAULT_ENDPOINT;
  const apiKey = (typeof key === 'string' && key.trim()) || (env && typeof env.MINIMAX_API_KEY === 'string' ? env.MINIMAX_API_KEY.trim() : '');
  const outputDir = m.outputDir || (userDataDir ? path.join(userDataDir, 'music') : '');
  return { ...m, endpoint, apiKey, outputDir, timeoutMs: m.timeoutSec * 1000, pollIntervalMs: m.pollIntervalSec * 1000, queryPath: QUERY_PATH };
}

function checkConfig(cfg) {
  if (!cfg || !cfg.apiKey) throw new MusicError('no-key', '没有 MiniMax API Key：在 设置 → 朗读 → MiniMax 填写，或设置环境变量 MINIMAX_API_KEY');
  if (!httpsOk(cfg.endpoint)) throw new MusicError('bad-endpoint', '音乐生成端点不合法：必须是 https 地址');
  if (!cfg.outputDir || !path.isAbsolute(cfg.outputDir)) throw new MusicError('write', '没有可用的音乐保存目录');
}

// ---- cancellation / deadline -----------------------------------------------------------------------------------

// One AbortSignal for the whole job: the caller's signal, or the deadline. reason() says which fired.
function deadline(outer, timeoutMs) {
  const ac = new AbortController();
  let why = null;
  const onAbort = () => { if (!why) why = 'aborted'; ac.abort(); };
  if (outer) { if (outer.aborted) onAbort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  const timer = timeoutMs > 0 ? setTimeout(() => { if (!why) why = 'timeout'; ac.abort(); }, timeoutMs) : null;
  if (timer && timer.unref) timer.unref();
  return {
    signal: ac.signal,
    reason: () => why,
    done() { if (timer) clearTimeout(timer); if (outer) outer.removeEventListener('abort', onAbort); },
  };
}

const stopError = (why) => (why === 'timeout' ? new MusicError('timeout', '音乐生成超时，请稍后重试或在设置里调大超时') : new MusicError('aborted', '已取消音乐生成'));

// Resolve with `p`, or reject as soon as `signal` aborts (a fetch that ignores its signal is still let go).
function race(p, signal, why) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(stopError(why()));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(stopError(why()));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

const sleepFor = (ms, signal, why) => race(new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }), signal, why);

// ---- the client ------------------------------------------------------------------------------------------------

async function callJson(fetchFn, url, init, signal, why) {
  if (signal && signal.aborted) throw stopError(why()); // cancelled already: no request at all
  let res;
  try {
    res = await race(Promise.resolve().then(() => fetchFn(url, { ...init, signal })), signal, why);
  } catch (e) {
    if (e instanceof MusicError) throw e;
    if (signal && signal.aborted) throw stopError(why());
    throw new MusicError('network', `连不上 MiniMax：${e && e.message ? e.message : '网络错误'}`);
  }
  if (!res.ok) throw httpError(res.status);
  const j = await race(Promise.resolve().then(() => res.json()), signal, why).catch((e) => {
    if (e instanceof MusicError) throw e;
    throw new MusicError('server', 'MiniMax 返回的不是 JSON');
  });
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

function createMusicClient(config, { fetch: fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  const cfg = { ...config };
  const headers = () => ({ Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' });

  // POST the job. -> task { id, mode: 'sync' | 'async', status, model, request, traceId, createdAt, result? }
  // A sync answer (the documented one) is a task that is already done; a task_id answer is polled by wait().
  async function submit(params, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    checkConfig(cfg);
    const req = buildRequest(params, cfg);
    const dl = deadline(signal, timeoutMs);
    try {
      if (onProgress) onProgress({ stage: 'submitting', model: req.body.model });
      const j = await callJson(fetchFn, `${cfg.endpoint}${GENERATE_PATH}`, { method: 'POST', headers: headers(), body: JSON.stringify(req.body) }, dl.signal, dl.reason);
      const createdAt = now();
      const traceId = j.trace_id || null;
      const taskId = j.task_id || (j.data && j.data.task_id) || null;
      const base = { model: req.body.model, request: req, traceId, createdAt, title: req.title, warnings: req.warnings };
      const audio = audioOf(j.data);
      if (audio) return { ...base, id: traceId || `local-${createdAt}`, mode: 'sync', status: 'succeeded', result: { ...audio, extra: j.extra_info || {}, traceId } };
      if (taskId) {
        if (onProgress) onProgress({ stage: 'submitted', taskId });
        return { ...base, id: String(taskId), mode: 'async', status: 'pending' };
      }
      if (j.data && statusOf(j.data) === 'failed') throw new MusicError('task-failed', '音乐生成失败', { traceId });
      throw new MusicError('empty', 'MiniMax 没有返回音频', { traceId });
    } finally {
      dl.done();
    }
  }

  // Until the task is done: { audioHex | audioUrl, extra, traceId }. Polls async tasks every pollIntervalMs.
  async function wait(task, { signal, timeoutMs = cfg.timeoutMs, pollIntervalMs = cfg.pollIntervalMs, onProgress } = {}) {
    if (!task || typeof task !== 'object') throw badParams('缺少任务');
    if (task.status === 'succeeded' && task.result) return task.result;
    if (task.status === 'failed') throw new MusicError('task-failed', '音乐生成失败', { traceId: task.traceId });
    const dl = deadline(signal, timeoutMs);
    try {
      for (let attempt = 1; ; attempt++) {
        const j = await callJson(fetchFn, `${cfg.endpoint}${cfg.queryPath || QUERY_PATH}?task_id=${encodeURIComponent(task.id)}`, { method: 'GET', headers: headers() }, dl.signal, dl.reason);
        const data = j.data && typeof j.data === 'object' ? j.data : j;
        const st = statusOf(data);
        if (onProgress) onProgress({ stage: 'polling', taskId: task.id, attempt, status: st });
        if (st === 'failed') throw new MusicError('task-failed', `音乐生成失败${data.error || data.status_msg ? `：${String(data.error || data.status_msg).slice(0, 120)}` : ''}`, { traceId: j.trace_id || task.traceId });
        if (st === 'succeeded') {
          const audio = audioOf(data);
          if (!audio) throw new MusicError('empty', 'MiniMax 任务完成但没有音频', { traceId: j.trace_id || task.traceId });
          task.status = 'succeeded';
          task.result = { ...audio, extra: j.extra_info || data.extra_info || {}, traceId: j.trace_id || task.traceId };
          return task.result;
        }
        await sleepFor(pollIntervalMs, dl.signal, dl.reason);
      }
    } finally {
      dl.done();
    }
  }

  // Write the audio to outputDir: <yyyyMMdd-HHmmss>-<title>.<format>. -> { filePath, fileUrl, durationMs, meta }
  async function save(task, result = task.result, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    if (!result) throw new MusicError('empty', '没有可保存的音频');
    const dl = deadline(signal, timeoutMs);
    let audio;
    try {
      if (result.audioHex) audio = Buffer.from(result.audioHex, 'hex');
      else if (result.audioUrl) {
        if (onProgress) onProgress({ stage: 'downloading' });
        let res;
        try {
          res = await race(Promise.resolve().then(() => fetchFn(result.audioUrl, { method: 'GET', signal: dl.signal })), dl.signal, dl.reason);
        } catch (e) {
          if (e instanceof MusicError) throw e;
          throw new MusicError('download', `下载音频失败：${e && e.message ? e.message : '网络错误'}`);
        }
        if (!res.ok) throw new MusicError('download', `下载音频失败（HTTP ${res.status}）`, { code: `http-${res.status}`, status: res.status });
        const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : 0);
        if (len > MAX_DOWNLOAD) throw new MusicError('download', '音频文件太大');
        audio = Buffer.from(await race(Promise.resolve().then(() => res.arrayBuffer()), dl.signal, dl.reason));
      }
    } finally {
      dl.done();
    }
    if (!audio || !audio.length) throw new MusicError('empty', '音频是空的');
    if (audio.length > MAX_DOWNLOAD) throw new MusicError('download', '音频文件太大');
    const req = task.request || { body: { audio_setting: {} } };
    const format = (req.body.audio_setting && req.body.audio_setting.format) || cfg.format || 'mp3';
    let filePath;
    try {
      await fsp.mkdir(cfg.outputDir, { recursive: true });
      filePath = await freeName(cfg.outputDir, fileBase(task.title, new Date(now())), format);
      const tmp = `${filePath}.part`;
      await fsp.writeFile(tmp, audio);
      await fsp.rename(tmp, filePath);
    } catch (e) {
      throw new MusicError('write', `保存音频失败：${e && e.message ? e.message : e}`);
    }
    const extra = result.extra || {};
    const durationMs = Number.isFinite(Number(extra.music_duration)) && Number(extra.music_duration) > 0 ? Number(extra.music_duration) : undefined;
    const meta = {
      title: task.title || '', model: task.model, taskId: task.id, mode: task.mode, traceId: result.traceId || task.traceId || null,
      prompt: req.body.prompt || '', lyrics: req.body.lyrics || '', instrumental: req.body.is_instrumental === true,
      format, sampleRate: req.body.audio_setting && req.body.audio_setting.sample_rate, bitrate: req.body.audio_setting && req.body.audio_setting.bitrate,
      source: result.audioHex ? 'hex' : 'url', bytes: audio.length, extra, hints: req.hints || {}, warnings: task.warnings || [], createdAt: new Date(task.createdAt || now()).toISOString(),
    };
    if (onProgress) onProgress({ stage: 'saved', filePath });
    return { filePath, fileUrl: pathToFileURL(filePath).href, durationMs, meta };
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

// file names: 20261104-153012-晚风.mp3 — letters / digits of any script, the rest becomes '-'
function fileBase(title, date) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  const slug = String(title || '').normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${stamp}-${slug || 'music'}`;
}

async function freeName(dir, base, ext) {
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, `${base}${i > 1 ? `-${i}` : ''}.${ext}`);
    try { await fsp.access(p); } catch { return p; }
  }
  throw new Error('too many files with the same name');
}

// One call for the AI tool: generateMusic(params, { settings, key, userDataDir, signal, fetch, onProgress })
async function generateMusic(params, { settings, key, env, userDataDir, config, fetch: fetchFn, signal, onProgress, now } = {}) {
  const cfg = config || resolveConfig({ settings, key, env, userDataDir });
  return createMusicClient(cfg, { fetch: fetchFn, now }).generate(params, { signal, onProgress });
}

module.exports = {
  DEFAULT_ENDPOINT, GENERATE_PATH, QUERY_PATH, MODELS, SAMPLE_RATES, BITRATES, FORMATS, OUTPUT_FORMATS, STRUCTURE_TAGS, LIMITS, RANGE,
  MUSIC_DEFAULTS, normalizeMusic, MusicError, apiError, buildRequest, composePrompt, resolveConfig, createMusicClient, generateMusic, fileBase,
  endpointOk: httpsOk,
};
