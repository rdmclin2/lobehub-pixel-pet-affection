'use strict';

// 音乐创作 (T-5651): what every music provider (music-fal.js / music-elevenlabs.js / music-minimax.js) shares — the
// error type, the compose_music parameters checked once (parseParams), the deadline / AbortSignal plumbing, the
// audio download and the file under <userData>/music/. core/music.js picks the provider and is the only entry
// (generateMusic); nothing here talks to a particular service.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { endpointOk } = require('./tts');

const STRUCTURE_TAGS = ['Intro', 'Verse', 'Pre Chorus', 'Chorus', 'Interlude', 'Bridge', 'Outro', 'Post Chorus', 'Transition', 'Break', 'Hook', 'Build Up', 'Inst', 'Solo'];
// the compose_music limits (the tool schema shows these). Each provider may be narrower and says so (meta.unsupported).
const LIMITS = { prompt: 2000, lyrics: 3500, title: 60, hint: 200, durationSec: [10, 360], bpm: [40, 240] };
const MAX_DOWNLOAD = 200 * 1024 * 1024;

const httpsOk = (u) => endpointOk(u, { lan: false });
// e2e / unit runs only: an endpoint may be a stand-in on http://127.0.0.1:<port> (allowInsecureLocal, never in a real run)
const LOOPBACK_HTTP = /^http:\/\/127\.0\.0\.1(:\d{1,5})?$/;
const endpointAllowed = (ep, cfg) => httpsOk(ep) || !!(cfg && cfg.allowInsecureLocal && LOOPBACK_HTTP.test(ep));

// ---- errors ----------------------------------------------------------------------------------------------------

// reason: what kind of failure — no-key / bad-endpoint / bad-params / auth / rate-limit / balance / sensitive / model /
// unavailable / server / task-failed / network / timeout / aborted / empty / download / write.
// code: the service's own code (MiniMax base_resp.status_code, fal error_type, ElevenLabs detail.code) or
// `http-<status>` or null. retryable: whether trying the same request again later may work (told to the model).
// provider: 'fal' | 'elevenlabs' | 'minimax' (set by the provider that threw). message: readable Chinese, with the code.
const RETRYABLE = new Set(['rate-limit', 'server', 'network', 'timeout']);
class MusicError extends Error {
  constructor(reason, message, { code = null, status = null, traceId = null, detail = null, retryable = null, provider = null } = {}) {
    super(code != null ? `${message}（错误码 ${code}）` : message);
    this.name = 'MusicError';
    this.reason = reason;
    this.code = code;
    this.status = status;
    this.traceId = traceId;
    this.detail = detail;
    this.retryable = typeof retryable === 'boolean' ? retryable : RETRYABLE.has(reason);
    this.provider = provider;
  }
}

const badParams = (msg) => new MusicError('bad-params', msg);
const stopError = (why) => (why === 'timeout' ? new MusicError('timeout', '音乐生成超时，请稍后重试或在设置里调大超时') : new MusicError('aborted', '已取消音乐生成', { retryable: false }));

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

// Tags in lyrics ([Verse], [Chorus] …); [verse 2] / [chorus] are matched loosely.
const TAG_KEY = (t) => t.toLowerCase().replace(/[\s_-]+/g, ' ').replace(/\s*\d+$/, '').trim();
const KNOWN_TAGS = new Map(STRUCTURE_TAGS.map((t) => [TAG_KEY(t), t]));
const lyricTags = (lyrics) => [...lyrics.matchAll(/^\s*\[([^\]\n]{1,30})\]\s*$/gm)].map((m) => m[1]);

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

// The compose_music arguments, checked and cleaned once for every provider:
// -> { prompt, lyrics, instrumental, lyricsOptimizer, genre, mood, scene, instruments, vocals, bpm, durationSec,
//      structure: [tags], title, warnings: [] }   or throws MusicError('bad-params').
// The service-independent rules: pure music needs a description; a song with vocals needs lyrics or lyricsOptimizer;
// lyric tags must be known ones. `vocals` is dropped for pure music (with a warning when it was given).
function parseParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw badParams('缺少创作参数');
  const warnings = [];
  const instrumental = params.instrumental === true || params.is_instrumental === true;
  const lyricsOptimizer = params.lyricsOptimizer === true || params.lyrics_optimizer === true;
  const hint = (k) => optText(params[k], k, LIMITS.hint);
  const p = {
    prompt: optText(params.prompt, 'prompt', LIMITS.prompt),
    lyrics: optText(params.lyrics, 'lyrics', LIMITS.lyrics),
    instrumental,
    lyricsOptimizer,
    genre: hint('genre'), mood: hint('mood'), scene: hint('scene'), instruments: hint('instruments'), vocals: hint('vocals'),
    bpm: optNum(params.bpm, 'bpm', LIMITS.bpm),
    durationSec: optNum(params.durationSec ?? params.duration, 'durationSec', LIMITS.durationSec),
    structure: normalizeStructure(params.structure),
    title: optText(params.title, 'title', LIMITS.title),
    warnings,
  };
  const described = !!(p.prompt || p.genre || p.mood || p.scene || p.instruments);
  if (instrumental) {
    if (!described) throw badParams('纯音乐需要 prompt（风格 / 情绪 / 场景描述）');
    if (p.lyrics) { warnings.push('纯音乐模式不使用歌词，已忽略 lyrics'); p.lyrics = ''; }
    if (p.vocals) { warnings.push('纯音乐模式没有人声，已忽略 vocals'); p.vocals = ''; }
  } else if (!p.lyrics) {
    if (!lyricsOptimizer) throw badParams('有人声的歌需要 lyrics（可带 [Verse] / [Chorus] 等段落标签）；没有歌词时设 lyricsOptimizer: true 让模型按 prompt 写词，或设 instrumental: true 生成纯音乐');
    if (!described) throw badParams('让模型自动写词时需要 prompt');
  }
  if (p.lyrics) {
    const unknown = lyricTags(p.lyrics).filter((t) => !KNOWN_TAGS.has(TAG_KEY(t)));
    if (unknown.length) throw badParams(`歌词里有不认识的段落标签 ${unknown.map((t) => `[${t}]`).join(' ')}，可用：${STRUCTURE_TAGS.map((t) => `[${t}]`).join(' ')}`);
  }
  return p;
}

// prompt + the hints a service has no field for, in one description. `skip`: the hints it does have a field for
// (e.g. ElevenLabs takes the length as music_length_ms, so durationSec is not written into its prompt).
function composePrompt({ prompt, genre, mood, scene, instruments, vocals, bpm, durationSec, structure = [] }, skip = []) {
  const no = new Set(skip);
  const parts = [prompt];
  if (genre) parts.push(`Genre: ${genre}`);
  if (mood) parts.push(`Mood: ${mood}`);
  if (scene) parts.push(`Scene: ${scene}`);
  if (instruments) parts.push(`Instruments: ${instruments}`);
  if (vocals && !no.has('vocals')) parts.push(`Vocals: ${vocals}`);
  if (bpm && !no.has('bpm')) parts.push(`Tempo: ${bpm} BPM`);
  if (durationSec && !no.has('durationSec')) parts.push(`Length: about ${durationSec} seconds`);
  if (structure.length && !no.has('structure')) parts.push(`Structure: ${structure.join(' - ')}`);
  return parts.filter(Boolean).join('. ');
}

// How each compose_music field reached the service, for meta / the tool's answer (never silently dropped):
// native: a field of its own · prompt: written into the description as a hint (the service may or may not follow it)
// · ignored: not sent at all (with why). -> { native: [], prompt: [], ignored: [{ field, why }] }
function mappingOf(p, { native = [], prompt = [], ignored = {} }) {
  const given = (k) => {
    const v = p[k];
    return Array.isArray(v) ? v.length > 0 : v === true || (v != null && v !== '' && v !== false);
  };
  const out = { native: [], prompt: [], ignored: [] };
  for (const k of ['prompt', 'lyrics', 'instrumental', 'lyricsOptimizer', 'genre', 'mood', 'scene', 'instruments', 'vocals', 'bpm', 'durationSec', 'structure', 'title']) {
    if (!given(k)) continue;
    if (native.includes(k)) out.native.push(k);
    else if (prompt.includes(k)) out.prompt.push(k);
    else if (ignored[k]) out.ignored.push({ field: k, why: ignored[k] });
    else if (k === 'title') out.native.push(k); // the title only names the file, on every service
  }
  return out;
}

// What the model should tell the owner honestly: the fields that are only a hint in the prompt (of `hintKeys`, the
// ones a listener would check: length, tempo, structure) and the ones not sent at all.
// -> [{ field, how: 'prompt-hint' | 'ignored', why? }]
function unsupportedOf(mapping, hintKeys = ['bpm', 'durationSec', 'structure']) {
  if (!mapping) return [];
  return [...mapping.prompt.filter((k) => hintKeys.includes(k)).map((field) => ({ field, how: 'prompt-hint' })), ...mapping.ignored.map((x) => ({ field: x.field, how: 'ignored', why: x.why }))];
}

// ---- cancellation / deadline -----------------------------------------------------------------------------------

// One AbortSignal for a step: the caller's signal, or the deadline. reason() says which fired.
function deadline(outer, timeoutMs) {
  const ac = new AbortController();
  let why = null;
  const onAbort = () => { if (!why) why = 'aborted'; ac.abort(); };
  if (outer) { if (outer.aborted) onAbort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  // not unref'd: the deadline is what settles a job whose request hangs; a script with nothing else pending must wait for it
  const timer = timeoutMs > 0 ? setTimeout(() => { if (!why) why = 'timeout'; ac.abort(); }, timeoutMs) : null;
  return {
    signal: ac.signal,
    reason: () => why,
    done() { if (timer) clearTimeout(timer); if (outer) outer.removeEventListener('abort', onAbort); },
  };
}

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

// a real timer (not unref'd): between two polls it may be the only thing keeping a plain node script alive
const sleepFor = (ms, signal, why) => race(new Promise((r) => setTimeout(r, ms)), signal, why);

// fetch under the deadline: a thrown fetch is `network` (named after the service), an abort is timeout / aborted.
async function send(fetchFn, url, init, dl, serviceName) {
  if (dl.signal.aborted) throw stopError(dl.reason()); // cancelled already: no request at all
  try {
    return await race(Promise.resolve().then(() => fetchFn(url, { ...init, signal: dl.signal })), dl.signal, dl.reason);
  } catch (e) {
    if (e instanceof MusicError) throw e;
    if (dl.signal.aborted) throw stopError(dl.reason());
    throw new MusicError('network', `连不上 ${serviceName}：${e && e.message ? e.message : '网络错误'}`);
  }
}

// the body of an answer as JSON (null when it is not JSON), under the deadline
const readJson = (res, dl) => race(Promise.resolve().then(() => res.json()), dl.signal, dl.reason).catch((e) => { if (e instanceof MusicError) throw e; return null; });

// ---- download / save -------------------------------------------------------------------------------------------

const header = (res, name) => (res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null);

// GET an audio url (no Authorization: the services hand out a public, signed CDN link) -> Buffer
async function downloadAudio(fetchFn, url, dl) {
  let res;
  try {
    res = await race(Promise.resolve().then(() => fetchFn(url, { method: 'GET', signal: dl.signal })), dl.signal, dl.reason);
  } catch (e) {
    if (e instanceof MusicError) throw e;
    if (dl.signal.aborted) throw stopError(dl.reason());
    throw new MusicError('download', `下载音频失败：${e && e.message ? e.message : '网络错误'}`, { retryable: true });
  }
  if (!res.ok) throw new MusicError('download', `下载音频失败（HTTP ${res.status}）`, { code: `http-${res.status}`, status: res.status, retryable: res.status >= 500 });
  return readAudioBody(res, dl);
}

async function readAudioBody(res, dl) {
  const len = Number(header(res, 'content-length') || 0);
  if (len > MAX_DOWNLOAD) throw new MusicError('download', '音频文件太大');
  const buf = Buffer.from(await race(Promise.resolve().then(() => res.arrayBuffer()), dl.signal, dl.reason));
  if (buf.length > MAX_DOWNLOAD) throw new MusicError('download', '音频文件太大');
  return buf;
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

// Write `audio` to <outputDir>/<yyyyMMdd-HHmmss>-<title>.<format> (via a .part file). -> { filePath, fileUrl }
async function writeAudio(outputDir, { audio, title, format, date }) {
  if (!audio || !audio.length) throw new MusicError('empty', '音频是空的');
  let filePath;
  try {
    await fsp.mkdir(outputDir, { recursive: true });
    filePath = await freeName(outputDir, fileBase(title, date), format);
    const tmp = `${filePath}.part`;
    await fsp.writeFile(tmp, audio);
    await fsp.rename(tmp, filePath);
  } catch (e) {
    throw new MusicError('write', `保存音频失败：${e && e.message ? e.message : e}`);
  }
  return { filePath, fileUrl: pathToFileURL(filePath).href };
}

// an audio file's format from its url / content type (fal names the file; ElevenLabs answers audio/mpeg)
function formatOf({ url = '', contentType = '', fallback = 'mp3' } = {}) {
  const ct = String(contentType).toLowerCase();
  if (/mpeg|mp3/.test(ct)) return 'mp3';
  if (/wav/.test(ct)) return 'wav';
  if (/flac/.test(ct)) return 'flac';
  if (/opus|ogg/.test(ct)) return 'opus';
  const m = /\.([a-z0-9]{2,4})(?:$|[?#])/i.exec(String(url));
  if (m && ['mp3', 'wav', 'pcm', 'flac', 'opus', 'ogg'].includes(m[1].toLowerCase())) return m[1].toLowerCase();
  return fallback;
}

// ---- length from the file ---------------------------------------------------------------------------------------

// fal and ElevenLabs do not say how long the song is: read it from the audio itself. MP3: the Xing / Info / VBRI
// frame count when there is one, else CBR (bytes × 8 / bitrate of the first frame). WAV: data size / byte rate.
// -> ms, or undefined when the header is not understood (never a guess beyond that).
const MP3_KBPS = {
  1: [null, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 layer III
  2: [null, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2 / 2.5 layer III
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
function mp3DurationMs(buf) {
  let off = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') off = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  for (let end = Math.min(buf.length - 4, off + 65536); off < end; off++) if (buf[off] === 0xff && (buf[off + 1] & 0xe6) === 0xe2) break;
  if (off >= buf.length - 4) return undefined;
  const ver = (buf[off + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const kbps = MP3_KBPS[ver === 3 ? 1 : 2][(buf[off + 2] >> 4) & 15];
  const rate = MP3_RATES[ver] && MP3_RATES[ver][(buf[off + 2] >> 2) & 3];
  if (!kbps || !rate) return undefined;
  const spf = ver === 3 ? 1152 : 576;
  const mono = ((buf[off + 3] >> 6) & 3) === 3;
  const side = ver === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const x = off + 4 + side;
  const tag = buf.length > x + 12 ? buf.toString('latin1', x, x + 4) : '';
  if ((tag === 'Xing' || tag === 'Info') && (buf.readUInt32BE(x + 4) & 1)) return Math.round((buf.readUInt32BE(x + 8) * spf * 1000) / rate);
  const v = off + 36;
  if (buf.length > v + 18 && buf.toString('latin1', v, v + 4) === 'VBRI') return Math.round((buf.readUInt32BE(v + 14) * spf * 1000) / rate);
  return Math.round(((buf.length - off) * 8) / kbps);
}
function wavDurationMs(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return undefined;
  let byteRate = 0;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 16 <= buf.length) byteRate = buf.readUInt32LE(p + 16);
    if (id === 'data') return byteRate ? Math.round((Math.min(size, buf.length - p - 8) * 1000) / byteRate) : undefined;
    p += 8 + size + (size & 1);
  }
  return undefined;
}
function audioDurationMs(buf, format) {
  try {
    if (!buf || !buf.length) return undefined;
    const ms = format === 'wav' ? wavDurationMs(buf) : format === 'mp3' ? mp3DurationMs(buf) : undefined;
    return Number.isFinite(ms) && ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  STRUCTURE_TAGS, LIMITS, MAX_DOWNLOAD, RETRYABLE, LOOPBACK_HTTP,
  httpsOk, endpointAllowed, MusicError, badParams, stopError, parseParams, composePrompt, mappingOf, unsupportedOf, normalizeStructure, KNOWN_TAGS, TAG_KEY, lyricTags,
  deadline, race, sleepFor, send, readJson, header, downloadAudio, readAudioBody, fileBase, freeName, writeAudio, formatOf, audioDurationMs,
};
