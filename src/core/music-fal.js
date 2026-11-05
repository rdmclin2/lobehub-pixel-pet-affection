'use strict';

// 音乐创作 provider 1 of 3, the default (T-5651): MiniMax Music hosted on fal.ai, through fal's queue.
//
// Checked 2026-11-05 against the official pages:
//   Models   https://fal.ai/models/fal-ai/minimax-music/v2.6/api  (the latest MiniMax Music on fal; $0.15 per audio)
//            https://fal.ai/models/fal-ai/minimax-music/v2.5/api  (same input schema; $0.15 per audio)
//            https://fal.ai/explore/text-to-music-apis              (lists v2.6, v2.5, v2 $0.03/generation, v1.5, legacy)
//            fal-ai/minimax-music/v2 takes another schema (prompt 10–300 chars + required lyrics_prompt, no
//            is_instrumental) and v1.5 / the unversioned legacy one need reference audio, so they are not offered.
//            No MiniMax "music-3.0" is listed on fal (only on MiniMax's own API, which is closed to new users).
//   Queue    https://fal.ai/docs/model-apis/model-endpoints/queue
//            POST https://queue.fal.run/{model_id}                 body = the model input  → { request_id,
//                 response_url, status_url, cancel_url, queue_position }
//            GET  https://queue.fal.run/{owner}/{app}/requests/{id}/status   → { status: IN_QUEUE (+ queue_position)
//                 | IN_PROGRESS | COMPLETED (+ error / error_type when it failed) }
//            GET  https://queue.fal.run/{owner}/{app}/requests/{id}           → the model output
//            PUT  https://queue.fal.run/{owner}/{app}/requests/{id}/cancel    → 200 OK (removed) · 202
//                 CANCELLATION_REQUESTED (running, may still finish) · 400 ALREADY_COMPLETED · 404 NOT_FOUND
//            The status / result / cancel URLs use only owner/app (fal-ai/minimax-music), not the version path: the
//            ones submit returns are used, and rebuilt from owner/app only if they are missing or on another host.
//   Auth     Authorization: Key <FAL_KEY>
//   Errors   https://fal.ai/docs/model-apis/errors — model errors: { detail: [{ loc, msg, type, … }] } with type
//            content_policy_violation (422, not retryable), no_media_generated (422), generation_timeout (504),
//            internal_server_error / downstream_service_error (500) …; request errors: { detail, error_type }
//            (request_timeout / startup_timeout 504, runner_* 50x, bad_request 400) + X-Fal-Error-Type; header
//            X-Fal-Needs-Retry. Not documented there, seen from fal in practice: 401 bad key, 403 "User is locked.
//            Reason: Exhausted balance …" (no credit), 429 too many requests.
//
//   Input (v2.6 / v2.5): prompt (string, required; v2.6: 10–2000 chars) · lyrics (≤ 3500, tags [Intro] [Verse]
//   [Chorus] [Bridge] [Outro] [Hook] …, required unless is_instrumental / lyrics_optimizer) · is_instrumental ·
//   lyrics_optimizer · audio_setting { sample_rate 16000|24000|32000|44100, bitrate 32000|64000|128000|256000,
//   format mp3|wav|pcm } · enable_safety_checker (default true, left as is).
//   Output: { audio: { url, content_type?, file_name?, file_size? } } — a fal.media link, downloaded at once.
//   No duration / BPM / structure field: written into the prompt as hints (meta.unsupported says so).
//
// The key is keys.fal (设置 → 音乐创作 → fal.ai, write-only) or FAL_KEY. Never in settings.json.

const C = require('./music-common');
const { MusicError, badParams } = C;

const ID = 'fal';
const NAME = 'fal.ai';
const DEFAULT_ENDPOINT = 'https://queue.fal.run';
const MODELS = ['fal-ai/minimax-music/v2.6', 'fal-ai/minimax-music/v2.5'];
const PRICES = { 'fal-ai/minimax-music/v2.6': '$0.15 / 首', 'fal-ai/minimax-music/v2.5': '$0.15 / 首' };
const SAMPLE_RATES = [16000, 24000, 32000, 44100];
const BITRATES = [32000, 64000, 128000, 256000];
const FORMATS = ['mp3', 'wav', 'pcm'];
const PROMPT_MIN = 10;
const CANCEL_WAIT_MS = 3000;

// owner/app of a model id: fal-ai/minimax-music/v2.6 → fal-ai/minimax-music (the queue's request URLs use only that)
const appOf = (model) => String(model).split('/').slice(0, 2).join('/');

// ---- parameters ------------------------------------------------------------------------------------------------

// The compose_music arguments → fal's input. -> { model, input, title, warnings, hints, mapping }
function buildRequest(params, cfg = {}) {
  const p = C.parseParams(params);
  const model = params.model == null || params.model === '' ? cfg.model || MODELS[0] : params.model;
  if (!MODELS.includes(model)) throw badParams(`fal 上不支持的模型「${model}」，可用：${MODELS.join(' / ')}`);
  let prompt = C.composePrompt(p);
  if (prompt.length > C.LIMITS.prompt) throw badParams(`描述加上风格 / 情绪 / BPM 等提示后太长了（最多 ${C.LIMITS.prompt} 字）`);
  if (prompt.length < PROMPT_MIN) {
    prompt = `${prompt}${prompt ? '. ' : ''}Original music`;
    p.warnings.push(`描述太短（fal 要求至少 ${PROMPT_MIN} 个字符），已在末尾补上 "Original music"`);
  }
  const format = params.format == null ? cfg.format || 'mp3' : params.format;
  if (!FORMATS.includes(format)) throw badParams(`format 只能是 ${FORMATS.join(' / ')}`);
  const sampleRate = params.sampleRate == null ? cfg.sampleRate || 44100 : Number(params.sampleRate);
  if (!SAMPLE_RATES.includes(sampleRate)) throw badParams(`sampleRate 只能是 ${SAMPLE_RATES.join(' / ')}`);
  const bitrate = params.bitrate == null ? cfg.bitrate || 256000 : Number(params.bitrate);
  if (!BITRATES.includes(bitrate)) throw badParams(`bitrate 只能是 ${BITRATES.join(' / ')}`);
  const input = { prompt, audio_setting: { sample_rate: sampleRate, bitrate, format } };
  if (p.instrumental) input.is_instrumental = true;
  else if (p.lyrics) input.lyrics = p.lyrics;
  else if (p.lyricsOptimizer) input.lyrics_optimizer = true;
  const mapping = C.mappingOf(p, { native: ['prompt', 'lyrics', 'instrumental', 'lyricsOptimizer'], prompt: ['genre', 'mood', 'scene', 'instruments', 'vocals', 'bpm', 'durationSec', 'structure'] });
  return { model, input, title: p.title, warnings: p.warnings, hints: { bpm: p.bpm, durationSec: p.durationSec, structure: p.structure }, mapping };
}

// ---- errors ----------------------------------------------------------------------------------------------------

const MODEL_ERRORS = {
  content_policy_violation: ['sensitive', '内容没有通过 fal.ai 的内容审核，拒绝生成，请换个描述或歌词', false],
  no_media_generated: ['task-failed', 'fal.ai 这次没有生成出音频，可以换个描述再试', false],
  generation_timeout: ['timeout', 'fal.ai 生成超时，请稍后重试', true],
  request_timeout: ['timeout', 'fal.ai 请求超时，请稍后重试', true],
  startup_timeout: ['timeout', 'fal.ai 启动超时，请稍后重试', true],
  internal_server_error: ['server', 'fal.ai 服务内部出错，请稍后重试', true],
  internal_error: ['server', 'fal.ai 服务内部出错，请稍后重试', true],
  downstream_service_error: ['server', 'fal.ai 上游（MiniMax）出错，请稍后重试', true],
  downstream_service_unavailable: ['server', 'fal.ai 上游（MiniMax）暂时不可用，请稍后重试', true],
  bad_request: ['bad-params', 'fal.ai 认为请求不合法', false],
  client_cancelled: ['aborted', '已取消音乐生成', false],
};

const BALANCE_RE = /balance|locked|exhaust|billing|credit|top ?up|payment|quota/i;

// the first error object fal sends: { type, msg } from detail[], or { type: error_type, msg: detail }
function falDetail(body) {
  if (!body || typeof body !== 'object') return { type: null, msg: '' };
  if (Array.isArray(body.detail) && body.detail.length) {
    const d = body.detail[0] || {};
    return { type: d.type || body.error_type || null, msg: String(d.msg || '').slice(0, 200) };
  }
  return { type: body.error_type || null, msg: typeof body.detail === 'string' ? body.detail.slice(0, 200) : typeof body.error === 'string' ? body.error.slice(0, 200) : '' };
}

// a non-2xx answer (submit / status / result) → MusicError
function httpError(status, body, headerRetry = null) {
  const { type, msg } = falDetail(body);
  const opt = (reason, text, retryable, code = type || `http-${status}`) => new MusicError(reason, text, { code, status, detail: msg || null, retryable: headerRetry == null ? retryable : headerRetry, provider: ID });
  if (type && MODEL_ERRORS[type]) { const [r, t, re] = MODEL_ERRORS[type]; return opt(r, msg && r === 'bad-params' ? `${t}：${msg}` : t, re); }
  if (status === 401) return opt('auth', 'fal.ai API Key 无效或未授权，请在 设置 → 音乐创作 → fal.ai 检查 Key，或设置环境变量 FAL_KEY', false);
  if (status === 402 || (status === 403 && BALANCE_RE.test(msg))) return opt('balance', 'fal.ai 账户余额不足或已被锁定，请到 fal.ai/dashboard/billing 充值后再试', false);
  if (status === 403) return opt('auth', 'fal.ai 拒绝访问：这个 Key 没有权限调用该模型', false);
  if (status === 404) return opt('model', 'fal.ai 上找不到这个模型或任务，请在设置里换一个模型', false);
  if (status === 422) return opt('bad-params', `fal.ai 认为请求参数不合法${msg ? `：${msg}` : ''}`, false);
  if (status === 429) return opt('rate-limit', 'fal.ai 请求太频繁（触发限流），请稍后再试', true);
  if (status === 504) return opt('timeout', 'fal.ai 请求超时，请稍后重试', true);
  if (status >= 500) return opt('server', 'fal.ai 服务暂时不可用，请稍后重试', true);
  return opt('server', `fal.ai 请求失败（HTTP ${status}）${msg ? `：${msg}` : ''}`, false);
}

// a COMPLETED status / result that carries an error (error / error_type) → MusicError
function completedError(body) {
  const type = body && typeof body.error_type === 'string' ? body.error_type : null;
  const msg = body && body.error ? String(typeof body.error === 'string' ? body.error : JSON.stringify(body.error)).slice(0, 200) : '';
  if (type && MODEL_ERRORS[type]) { const [r, t, re] = MODEL_ERRORS[type]; return new MusicError(r, t, { code: type, detail: msg || null, retryable: re, provider: ID }); }
  if (BALANCE_RE.test(msg)) return new MusicError('balance', 'fal.ai 账户余额不足或已被锁定，请到 fal.ai/dashboard/billing 充值后再试', { code: type, detail: msg, retryable: false, provider: ID });
  return new MusicError('task-failed', `fal.ai 生成失败${msg ? `：${msg}` : ''}`, { code: type, detail: msg || null, retryable: false, provider: ID });
}

const retryHeader = (res) => {
  const h = C.header(res, 'x-fal-needs-retry');
  return h == null ? null : /^(1|true|yes)$/i.test(String(h));
};

// ---- the client ------------------------------------------------------------------------------------------------

function createClient(config, { fetch: fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  const cfg = { ...config };
  const headers = (json = true) => ({ Authorization: `Key ${cfg.apiKey}`, Accept: 'application/json', ...(json ? { 'Content-Type': 'application/json' } : {}) });
  const origin = (() => { try { return new URL(cfg.endpoint).origin; } catch { return ''; } })();
  // a URL fal returned, only when it is on the queue's own host (the key goes with it)
  const sameHost = (u) => { try { return typeof u === 'string' && new URL(u).origin === origin ? u : null; } catch { return null; } };

  async function call(url, init, dl) {
    const res = await C.send(fetchFn, url, init, dl, NAME);
    const body = await C.readJson(res, dl);
    if (!res.ok) throw httpError(res.status, body, retryHeader(res));
    if (body == null) throw new MusicError('server', 'fal.ai 返回的不是 JSON', { provider: ID, retryable: true });
    return body;
  }

  // POST the input to the queue. -> task { id (request_id), provider, model, statusUrl, resultUrl, cancelUrl, … }
  async function submit(params, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    const req = buildRequest(params, cfg);
    const dl = C.deadline(signal, timeoutMs);
    try {
      if (onProgress) onProgress({ stage: 'submitting', model: req.model });
      const j = await call(`${cfg.endpoint}/${req.model}`, { method: 'POST', headers: headers(), body: JSON.stringify(req.input) }, dl);
      const id = j.request_id ? String(j.request_id) : '';
      if (!id) throw new MusicError('empty', 'fal.ai 没有返回任务 ID（request_id）', { provider: ID, retryable: true });
      const base = `${cfg.endpoint}/${appOf(req.model)}/requests/${encodeURIComponent(id)}`;
      const task = {
        provider: ID, id, mode: 'async', status: 'pending', model: req.model, request: req, title: req.title, warnings: req.warnings, createdAt: now(),
        statusUrl: sameHost(j.status_url) || `${base}/status`, resultUrl: sameHost(j.response_url) || base, cancelUrl: sameHost(j.cancel_url) || `${base}/cancel`,
        queuePosition: Number.isInteger(j.queue_position) ? j.queue_position : null,
      };
      if (onProgress) onProgress({ stage: 'submitted', taskId: id, queuePosition: task.queuePosition });
      return task;
    } finally {
      dl.done();
    }
  }

  // Ask fal to drop a request (best effort, a few seconds at most). -> 'OK' | 'CANCELLATION_REQUESTED' | … | null
  async function cancel(task) {
    if (!task || !task.cancelUrl) return null;
    const dl = C.deadline(null, CANCEL_WAIT_MS);
    try {
      const res = await C.send(fetchFn, task.cancelUrl, { method: 'PUT', headers: headers(false) }, dl, NAME);
      const j = await C.readJson(res, dl);
      task.cancel = (j && j.status) || `http-${res.status}`;
      return task.cancel;
    } catch {
      task.cancel = 'failed';
      return null;
    } finally {
      dl.done();
    }
  }

  // Poll the status every pollIntervalMs until COMPLETED, then fetch the result.
  // -> { audioUrl, contentType, fileName, fileSize, requestId }. On abort / timeout the request is cancelled at fal.
  async function wait(task, { signal, timeoutMs = cfg.timeoutMs, pollIntervalMs = cfg.pollIntervalMs, onProgress } = {}) {
    if (!task || typeof task !== 'object' || !task.id) throw badParams('缺少任务');
    if (task.status === 'succeeded' && task.result) return task.result;
    const dl = C.deadline(signal, timeoutMs);
    try {
      for (let attempt = 1; ; attempt++) {
        const s = await call(task.statusUrl, { method: 'GET', headers: headers(false) }, dl);
        const st = String(s.status || '').toUpperCase();
        task.queuePosition = Number.isInteger(s.queue_position) ? s.queue_position : null;
        if (onProgress) onProgress({ stage: st === 'IN_QUEUE' ? 'queued' : st === 'IN_PROGRESS' ? 'running' : 'polling', taskId: task.id, attempt, status: st, queuePosition: task.queuePosition });
        if (st === 'COMPLETED') {
          if (s.error || s.error_type) { task.status = 'failed'; throw completedError(s); }
          break;
        }
        if (/^(FAILED|ERROR|CANCELL?ED)$/.test(st)) { task.status = 'failed'; throw completedError({ error: s.error || st, error_type: s.error_type || null }); }
        await C.sleepFor(pollIntervalMs, dl.signal, dl.reason);
      }
      const out = await call(task.resultUrl, { method: 'GET', headers: headers(false) }, dl);
      const audio = out && out.audio && typeof out.audio === 'object' ? out.audio : null;
      const url = audio && typeof audio.url === 'string' ? audio.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) { task.status = 'failed'; throw new MusicError('empty', 'fal.ai 任务完成但没有音频链接', { provider: ID, retryable: false }); }
      task.status = 'succeeded';
      task.result = { audioUrl: url, contentType: audio.content_type || '', fileName: audio.file_name || '', fileSize: Number.isFinite(audio.file_size) ? audio.file_size : null, requestId: task.id };
      return task.result;
    } catch (e) {
      if (e instanceof MusicError && (e.reason === 'aborted' || e.reason === 'timeout') && dl.reason()) await cancel(task); // our deadline / the caller's Esc
      throw e;
    } finally {
      dl.done();
    }
  }

  // Download the audio and write it. -> { filePath, fileUrl, durationMs, meta }
  async function save(task, result = task.result, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    if (!result || !result.audioUrl) throw new MusicError('empty', '没有可保存的音频', { provider: ID });
    const dl = C.deadline(signal, timeoutMs);
    let audio;
    try {
      if (onProgress) onProgress({ stage: 'downloading' });
      audio = await C.downloadAudio(fetchFn, result.audioUrl, dl);
    } finally {
      dl.done();
    }
    const req = task.request;
    const format = C.formatOf({ url: result.fileName || result.audioUrl, contentType: result.contentType, fallback: req.input.audio_setting.format });
    const { filePath, fileUrl } = await C.writeAudio(cfg.outputDir, { audio, title: task.title, format, date: new Date(now()) });
    // the services do not say how long it is: read it from the file (MP3 / WAV header), else unknown
    const durationMs = C.audioDurationMs(audio, format);
    const meta = {
      provider: ID, title: task.title || '', model: task.model, taskId: task.id, mode: 'async', traceId: task.id,
      prompt: req.input.prompt, lyrics: req.input.lyrics || '', instrumental: req.input.is_instrumental === true,
      format, sampleRate: req.input.audio_setting.sample_rate, bitrate: req.input.audio_setting.bitrate,
      source: 'url', audioUrl: result.audioUrl, bytes: audio.length, hints: req.hints, mapping: req.mapping,
      unsupported: C.unsupportedOf(req.mapping, ['bpm', 'durationSec', 'structure']), durationSource: durationMs ? 'file-header' : null, price: PRICES[task.model] || null,
      warnings: task.warnings || [], createdAt: new Date(task.createdAt || now()).toISOString(),
    };
    if (onProgress) onProgress({ stage: 'saved', filePath });
    return { filePath, fileUrl, durationMs, meta };
  }

  async function generate(params, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    const started = now();
    const left = () => Math.max(1, timeoutMs - (now() - started));
    const task = await submit(params, { signal, timeoutMs, onProgress });
    const result = await wait(task, { signal, timeoutMs: left(), onProgress });
    return save(task, result, { signal, timeoutMs: left(), onProgress });
  }

  return { config: cfg, submit, wait, save, cancel, generate };
}

module.exports = { ID, NAME, DEFAULT_ENDPOINT, MODELS, PRICES, SAMPLE_RATES, BITRATES, FORMATS, PROMPT_MIN, appOf, buildRequest, httpError, completedError, createClient };
