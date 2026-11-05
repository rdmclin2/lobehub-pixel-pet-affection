'use strict';

// 音乐创作 provider 2 of 3 (T-5651): ElevenLabs Music (Eleven Music API).
//
// Checked 2026-11-05 against the official pages:
//   Endpoint https://elevenlabs.io/docs/api-reference/music/compose
//            POST https://api.elevenlabs.io/v1/music?output_format=<codec_rate_bitrate>   (US / EU / IN / SG
//            residency hosts too: api.us.elevenlabs.io …)   header xi-api-key: <key>
//            (https://elevenlabs.io/docs/api-reference/authentication)
//   Body     prompt (string; not with composition_plan) · composition_plan (MusicPrompt for music_v1, CompositionPlan
//            { chunks } for music_v2 / music_v2_5; not with prompt) · music_length_ms (3000–600000, prompt only) ·
//            model_id music_v1 (API default, deprecated: removed 2027-01-31) | music_v2 | music_v2_5 (newest) ·
//            force_instrumental (prompt only) · seed (composition_plan only) · respect_sections_durations · finetune_id
//            · store_for_inpainting · sign_with_c2pa.  Query output_format: auto (default) | mp3_44100_128 | … .
//   Answer   200: the audio file itself (synchronous, no job id / no cancel endpoint); the song id is in a response
//            header (read as song-id when present). 422: { detail: [{ loc, msg, type }] }.
//   Errors   https://elevenlabs.io/docs/developers/resources/errors — { detail: { type, code, message, status,
//            request_id, param } }: invalid_api_key 401 · payment_required / insufficient_credits 402 ·
//            rate_limit_exceeded / system_busy / concurrent_limit_exceeded 429. The music endpoint also answers
//            bad_prompt / bad_composition_plan (400/422, with data.prompt_suggestion) for prompts naming a
//            copyrighted artist or song, and the older quota_exceeded (401).
//   Plans    https://elevenlabs.io/docs/overview/capabilities/music — the Music API is for paid subscribers; length
//            3 s – 5 min in the product. Price https://elevenlabs.io/pricing/api: $0.15 per generated minute (the
//            minutes included depend on the plan; commercial use from Starter up). On fal (elevenlabs/music):
//            $0.80 per output minute.
//
// We use the prompt mode on every model: a description (+ the lyrics as a "Lyrics:" block when given), the length
// as music_length_ms (the one hint it takes natively), force_instrumental for pure music. With no lyrics and no
// force_instrumental ElevenLabs writes lyrics itself (= lyricsOptimizer). BPM / structure / vocals go into the prompt.
// The app's format / sample rate / bitrate (MiniMax audio_setting) do not apply: music.elevenlabs.outputFormat does.
//
// The key is keys.elevenlabs (the same one as 朗读 → ElevenLabs) or ELEVENLABS_API_KEY.

const C = require('./music-common');
const { MusicError, badParams } = C;

const ID = 'elevenlabs';
const NAME = 'ElevenLabs';
const DEFAULT_ENDPOINT = 'https://api.elevenlabs.io';
const PATH = '/v1/music';
const MODELS = ['music_v2_5', 'music_v2', 'music_v1'];
const OUTPUT_FORMATS = ['mp3_44100_128', 'mp3_44100_192'];
const LENGTH_MS = [3000, 600000];
const PRICE = '$0.15 / 分钟（按生成时长）';

// ---- parameters ------------------------------------------------------------------------------------------------

// -> { model, query: { output_format }, body, lyrics, title, warnings, hints, mapping }
function buildRequest(params, cfg = {}) {
  const p = C.parseParams(params);
  const model = params.model == null || params.model === '' ? cfg.model || MODELS[0] : params.model;
  if (!MODELS.includes(model)) throw badParams(`ElevenLabs 不支持的模型「${model}」，可用：${MODELS.join(' / ')}`);
  const outputFormat = params.outputFormat == null ? cfg.elevenlabsFormat || OUTPUT_FORMATS[0] : params.outputFormat;
  if (!OUTPUT_FORMATS.includes(outputFormat)) throw badParams(`outputFormat 只能是 ${OUTPUT_FORMATS.join(' / ')}`);
  let prompt = C.composePrompt(p, ['durationSec']);
  if (p.lyrics) prompt = `${prompt}${prompt ? '\n\n' : ''}Lyrics:\n${p.lyrics}`;
  const body = { prompt, model_id: model };
  if (p.durationSec) body.music_length_ms = Math.min(LENGTH_MS[1], Math.max(LENGTH_MS[0], p.durationSec * 1000));
  if (p.instrumental) body.force_instrumental = true;
  const mapping = C.mappingOf(p, { native: ['prompt', 'instrumental', 'durationSec', 'lyricsOptimizer'], prompt: ['lyrics', 'genre', 'mood', 'scene', 'instruments', 'vocals', 'bpm', 'structure'] });
  return { model, query: { output_format: outputFormat }, body, lyrics: p.lyrics, title: p.title, warnings: p.warnings, hints: { bpm: p.bpm, durationSec: p.durationSec, structure: p.structure }, mapping };
}

// ---- errors ----------------------------------------------------------------------------------------------------

// { code, message, suggestion } of an error body: { detail: { code | status, message, data } } or { detail: [...] }
function elDetail(body) {
  const d = body && typeof body === 'object' ? body.detail : null;
  if (Array.isArray(d)) return { code: (d[0] && d[0].type) || null, message: String((d[0] && d[0].msg) || '').slice(0, 200), suggestion: '' };
  if (d && typeof d === 'object') {
    const data = d.data && typeof d.data === 'object' ? d.data : {};
    return { code: d.code || d.status || d.type || null, message: String(d.message || '').slice(0, 200), suggestion: typeof data.prompt_suggestion === 'string' ? data.prompt_suggestion.slice(0, 300) : '' };
  }
  return { code: null, message: typeof d === 'string' ? d.slice(0, 200) : '', suggestion: '' };
}

const CONTENT_CODES = /bad_prompt|bad_composition_plan|content|copyright|moderation|tos|violat|blocked/i;
const BALANCE_CODES = /quota|credit|payment|insufficient|balance/i;
const LIMIT_CODES = /rate_limit|too_many|system_busy|concurrent/i;

function httpError(status, body) {
  const { code, message, suggestion } = elDetail(body);
  const opt = (reason, text, retryable) => new MusicError(reason, text, { code: code || `http-${status}`, status, detail: message || null, retryable, provider: ID });
  if (code && CONTENT_CODES.test(code)) return opt('sensitive', `ElevenLabs 拒绝了这个描述（可能提到了受版权保护的歌手 / 歌曲，或没有通过内容审核）${suggestion ? `；它建议改成：${suggestion}` : ''}`, false);
  if (status === 402 || (code && BALANCE_CODES.test(code))) return opt('balance', 'ElevenLabs 额度或余额不足（音乐按生成时长计费），请到 ElevenLabs 后台充值或升级套餐', false);
  if (status === 401) return opt('auth', 'ElevenLabs API Key 无效或未授权，请在 设置 → 朗读 → ElevenLabs 检查 Key，或设置环境变量 ELEVENLABS_API_KEY', false);
  if (status === 403) return opt('unavailable', 'ElevenLabs 拒绝访问：音乐接口只对付费套餐开放，或这个 Key 没有 Music 权限', false);
  if (status === 429 || (code && LIMIT_CODES.test(code))) return opt('rate-limit', 'ElevenLabs 请求太频繁或并发太多（触发限流），请稍后再试', true);
  if (status === 400 || status === 422) return opt('bad-params', `ElevenLabs 认为请求参数不合法${message ? `：${message}` : ''}`, false);
  if (status === 404) return opt('model', 'ElevenLabs 找不到音乐接口或这个模型，请检查端点和模型', false);
  if (status >= 500) return opt('server', 'ElevenLabs 服务暂时不可用，请稍后重试', true);
  return opt('server', `ElevenLabs 请求失败（HTTP ${status}）${message ? `：${message}` : ''}`, false);
}

// ---- the client ------------------------------------------------------------------------------------------------

// ElevenLabs answers with the file, so submit() does the whole request; wait() returns its result; save() writes it.
function createClient(config, { fetch: fetchFn = globalThis.fetch, now = () => Date.now() } = {}) {
  const cfg = { ...config };

  async function submit(params, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    const req = buildRequest(params, cfg);
    const dl = C.deadline(signal, timeoutMs);
    try {
      if (onProgress) onProgress({ stage: 'submitting', model: req.model });
      const url = `${cfg.endpoint}${PATH}?${new URLSearchParams(req.query)}`;
      const res = await C.send(fetchFn, url, { method: 'POST', headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, body: JSON.stringify(req.body) }, dl, NAME);
      if (!res.ok) throw httpError(res.status, await C.readJson(res, dl));
      const contentType = String(C.header(res, 'content-type') || '');
      if (/json/i.test(contentType)) throw httpError(res.status === 200 ? 502 : res.status, await C.readJson(res, dl));
      if (onProgress) onProgress({ stage: 'downloading' });
      const audio = await C.readAudioBody(res, dl);
      if (!audio.length) throw new MusicError('empty', 'ElevenLabs 没有返回音频', { provider: ID, retryable: true });
      const songId = C.header(res, 'song-id') || C.header(res, 'x-song-id') || null;
      const requestId = C.header(res, 'request-id') || C.header(res, 'x-request-id') || null;
      const createdAt = now();
      return { provider: ID, id: songId || requestId || `local-${createdAt}`, mode: 'sync', status: 'succeeded', model: req.model, request: req, title: req.title, warnings: req.warnings, createdAt, result: { audio, contentType, songId, requestId } };
    } finally {
      dl.done();
    }
  }

  async function wait(task) {
    if (!task || !task.result) throw new MusicError('empty', 'ElevenLabs 没有返回音频', { provider: ID });
    return task.result;
  }

  async function save(task, result = task.result, { onProgress } = {}) {
    const req = task.request;
    const format = C.formatOf({ contentType: result.contentType, fallback: 'mp3' });
    const { filePath, fileUrl } = await C.writeAudio(cfg.outputDir, { audio: result.audio, title: task.title, format, date: new Date(now()) });
    // the services do not say how long it is: read it from the file (MP3 / WAV header), else unknown
    const durationMs = C.audioDurationMs(result.audio, format);
    const meta = {
      provider: ID, title: task.title || '', model: task.model, taskId: task.id, mode: 'sync', traceId: result.requestId || null, songId: result.songId || null,
      prompt: req.body.prompt, lyrics: req.lyrics || '', instrumental: req.body.force_instrumental === true,
      format, outputFormat: req.query.output_format, requestedDurationMs: req.body.music_length_ms || null,
      source: 'binary', bytes: result.audio.length, hints: req.hints, mapping: req.mapping,
      unsupported: C.unsupportedOf(req.mapping, ['lyrics', 'bpm', 'structure']), durationSource: durationMs ? 'file-header' : null, price: PRICE,
      warnings: task.warnings || [], createdAt: new Date(task.createdAt || now()).toISOString(),
    };
    if (onProgress) onProgress({ stage: 'saved', filePath });
    return { filePath, fileUrl, durationMs, meta };
  }

  async function generate(p, { signal, timeoutMs = cfg.timeoutMs, onProgress } = {}) {
    const task = await submit(p, { signal, timeoutMs, onProgress });
    return save(task, await wait(task), { onProgress });
  }

  return { config: cfg, submit, wait, save, generate };
}

module.exports = { ID, NAME, DEFAULT_ENDPOINT, PATH, MODELS, OUTPUT_FORMATS, LENGTH_MS, PRICE, buildRequest, httpError, createClient };
