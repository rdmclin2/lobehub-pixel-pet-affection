'use strict';

// 设置窗口 → 聊天 (docs/admin-chat.md): the owner talks with one of her characters from the settings window.
// One character is one conversation: her own LobeHub agent and topic, the same ones the desktop pet talks
// through, and the same 聊天记录 (core/chat-log.js) — a message sent here is part of her history on the desktop
// too, and the other way round. There is no 新建 / 清空: she stays in that one conversation.
//
// Context. LobeHub keeps the topic's messages and gives them to the model on every turn of that topic
// (previous_response_id = topic id). So what the model sees is bounded by the topic: a topic that has run
// for CONTEXT_MS (4 hours) is put aside (kept in LobeHub, `pastTopicIds`) and the next turn opens a fresh one,
// carrying the owner's rounds of the last CONTEXT_MS with it (recentRounds → buildConsoleBody). Older rounds
// are not sent — unless the owner asks about something from before ("之前…", "还记得…", "上次…": wantsRecall);
// then the rounds of 聊天记录 from before the context that best match the question (pickRecall) go with that
// one turn.
//
// This file is Electron-free: the pure parts (context window, recall, history pages, pictures on disk) are
// here; PetService#chatAs runs the turn, main.js wires the IPC. The tests drive both with fakes.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const chatLog = require('./chat-log');

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 4; // per message
const MAX_TEXT = 20000; // one message
const CONTEXT_MS = 4 * 60 * 60 * 1000; // what one topic (the model's context) spans
const MAX_RECENT_CHARS = 8000; // the last CONTEXT_MS carried into a fresh topic; the oldest go first
const MAX_RECALL_CHARS = 6000; // older rounds sent along when the owner asks about them
const MAX_RECALL_ROUNDS = 12;
const PAGE = 40; // messages per history page
const ATT_RE = /^att_[a-z0-9]{6,40}\.(png|jpg|gif|webp)$/;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const SPECIES_RE = /^[a-z0-9-]{1,40}$/;

const rid = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;

class ChatError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// ---- pictures ------------------------------------------------------------------------------------------
// The type from the bytes themselves; a name or a data URL's declared type is never trusted alone.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const bad = (reason, message) => ({ ok: false, reason, message });

// One picture from the renderer: { path } (an absolute local file), { dataUrl, name? }, or that path / data
// URL as a plain string. -> { ok, buffer, mime, ext, name } or { ok: false, reason, message }.
// reason: 'bad-input' | 'not-found' | 'bad-type' | 'too-large'.
function readImage(input, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  const src = typeof input === 'string' ? (input.startsWith('data:') ? { dataUrl: input } : { path: input }) : input || {};
  let buffer;
  let declared = null;
  let name = typeof src.name === 'string' ? path.basename(src.name).slice(0, 120) : '';
  if (typeof src.dataUrl === 'string' && src.dataUrl) {
    const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(src.dataUrl);
    if (!m) return bad('bad-input', '图片数据格式不对（需要 base64 的 data URL）');
    declared = m[1].toLowerCase();
    if (!EXT[declared]) return bad('bad-type', '只支持 PNG、JPG、WebP、GIF 图片');
    // the size check comes before decoding: base64 is 4/3 of the bytes
    if (Math.floor(m[2].replace(/\s/g, '').length * 3 / 4) > maxBytes + 2) return bad('too-large', `图片不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    buffer = Buffer.from(m[2], 'base64');
  } else if (typeof src.path === 'string' && src.path) {
    if (!path.isAbsolute(src.path)) return bad('bad-input', '图片路径必须是绝对路径');
    let st;
    try {
      st = fs.statSync(src.path);
    } catch {
      return bad('not-found', '找不到这张图片');
    }
    if (!st.isFile()) return bad('not-found', '找不到这张图片');
    const ext = path.extname(src.path).slice(1).toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return bad('bad-type', '只支持 PNG、JPG、WebP、GIF 图片');
    if (st.size > maxBytes) return bad('too-large', `图片不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
    buffer = fs.readFileSync(src.path);
    name = name || path.basename(src.path).slice(0, 120);
  } else {
    return bad('bad-input', '没有图片数据');
  }
  if (buffer.length > maxBytes) return bad('too-large', `图片不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
  const mime = sniffImage(buffer);
  if (!mime) return bad('bad-type', '只支持 PNG、JPG、WebP、GIF 图片');
  if (declared && EXT[declared] !== EXT[mime]) return bad('bad-type', '图片内容和声明的类型不一致');
  const ext = EXT[mime];
  return { ok: true, buffer, mime, ext, name: name || `image.${ext}` };
}

// ---- one character's conversation ------------------------------------------------------------------------
// Her conversation as the chat page shows it: the rounds the owner started with her (chatLog.userSessions is
// the one filter, so a greeting or a proactive line never shows up here either), oldest first, every
// conversation of hers joined into one.
function conversationOf(messages, speciesId) {
  return chatLog.userSessions(messages).sessions.filter((s) => s.speciesId === speciesId).reverse().flatMap((s) => s.messages);
}

// One page of it, newest last: the `limit` messages before the message `before` (an id; none = the latest).
function historyPage(list, { before = null, limit = PAGE } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || PAGE));
  let end = list.length;
  if (before) {
    const i = list.findIndex((m) => m.id === before);
    if (i >= 0) end = i;
  }
  const start = Math.max(0, end - n);
  return { messages: list.slice(start, end), hasMore: start > 0, total: list.length };
}

// Does this message ask about something from before the current context? Kept simple and visible: words that
// point back in time or at memory. A miss costs nothing but the recall; a false hit sends a few old rounds.
const RECALL_RE = /之前|以前|先前|上次|上回|那次|那天|那时|当时|还记得|记得吗|记不记得|记得我|忘了吗|前几天|昨天|前天|上周|上星期|上个月|早些时候|聊过|说过|提过|讲过|告诉过|问过|答应过|\bearlier\b|\bbefore\b|\blast time\b|\bremember\b|\byesterday\b/i;
function wantsRecall(text) {
  return RECALL_RE.test(String(text || ''));
}

// Rounds: the owner's message and her reply share a turnId.
function roundsOf(list) {
  const out = [];
  const byTurn = new Map();
  for (const m of list) {
    const k = m.turnId || m.id;
    let r = byTurn.get(k);
    if (!r) {
      r = { turnId: k, at: m.at, messages: [] };
      byTurn.set(k, r);
      out.push(r);
    }
    r.messages.push(m);
  }
  return out;
}

// The pieces a question is matched on: Chinese character pairs and Latin / digit words.
function terms(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const han = t.match(/[㐀-鿿]+/g) || [];
  for (const run of han) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return out;
}
const STOP = new Set(['之前', '以前', '上次', '还记', '记得', '得吗', '我们', '你们', '什么', '一下', '的时', '时候', '说过', '聊过', '提过', '告诉', '诉过', '是什', '么吗', '那个', '这个', '一个', '昨天', '前天', '吗？', 'remember', 'before', 'earlier']);

// The older rounds that go with a question about the past: those sharing the most words with it, then the
// latest ones before the context (what "上次" usually means), at most maxRounds / maxChars, in time order.
function pickRecall(older, question, { maxChars = MAX_RECALL_CHARS, maxRounds = MAX_RECALL_ROUNDS } = {}) {
  const rounds = roundsOf(older).filter((r) => r.messages.some((m) => (m.text || '').trim()));
  if (!rounds.length) return [];
  const q = [...terms(question)].filter((w) => !STOP.has(w));
  const scored = rounds.map((r, i) => {
    const t = terms(r.messages.map((m) => m.text).join(' '));
    return { r, i, score: q.reduce((n, w) => n + (t.has(w) ? 1 : 0), 0) };
  });
  const chosen = new Set();
  for (const s of [...scored].filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.i - a.i)) {
    if (chosen.size >= Math.ceil(maxRounds / 2)) break;
    chosen.add(s.i);
  }
  for (let i = rounds.length - 1; i >= 0 && chosen.size < maxRounds; i--) chosen.add(i);
  const picked = [...chosen].sort((a, b) => a - b).map((i) => rounds[i]);
  // over the budget: the least relevant, oldest go first
  const rank = new Map(scored.map((s) => [s.r, s.score]));
  let used = picked.reduce((n, r) => n + roundChars(r), 0);
  while (picked.length > 1 && used > maxChars) {
    let k = 0;
    for (let j = 1; j < picked.length; j++) if (rank.get(picked[j]) < rank.get(picked[k])) k = j;
    used -= roundChars(picked[k]);
    picked.splice(k, 1);
  }
  return picked.flatMap((r) => r.messages);
}
const roundChars = (r) => r.messages.reduce((n, m) => n + (m.text || '').length + 8, 0);

// The rounds of the last `spanMs` before `now` (what a fresh topic carries), cut from the front at maxChars.
function recentRounds(list, now, { spanMs = CONTEXT_MS, maxChars = MAX_RECENT_CHARS } = {}) {
  const rounds = roundsOf(list).filter((r) => r.messages.some((m) => m.at >= now - spanMs));
  let used = 0;
  let from = rounds.length;
  while (from > 0 && used + roundChars(rounds[from - 1]) <= maxChars) used += roundChars(rounds[--from]);
  return rounds.slice(from).flatMap((r) => r.messages);
}

const clock = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const picNote = (m) => {
  const n = m.attachments && Number(m.attachments.images);
  return n ? `［发了 ${n} 张图片］` : '';
};
function transcript(list, name) {
  return list
    .filter((m) => (m.text || '').trim() || picNote(m))
    .map((m) => `[${clock(m.at)}] ${m.role === 'user' ? '主人' : name}：${(m.text || '').trim()}${m.role === 'user' ? picNote(m) : ''}`)
    .join('\n');
}

// What the owner's message becomes before PetService wraps it in her state block (persona.buildChatPrompt):
// the carried-over recent rounds (fresh topic only), the recalled older rounds (a question about the past
// only), a note about the pictures, then her words.
function buildConsoleBody({ name, text, recent = [], recall = [], images = 0 }) {
  const parts = [];
  if (recent.length) parts.push(`【最近 4 小时的聊天（换了新话题，接着聊）】\n${transcript(recent, name)}`);
  if (recall.length) parts.push(`【更早的聊天记录摘录（主人问到以前的事，供你回忆；只在相关时引用）】\n${transcript(recall, name)}`);
  if (images) parts.push(`[图片] 主人刚发来 ${images} 张图片${text ? '和下面这句话' : ''}（就在上一条消息里），请先看图，再直接回应。`);
  parts.push(text || (images ? '（发了图片）' : ''));
  return parts.filter(Boolean).join('\n\n');
}

// ---- pictures sent from the chat page ---------------------------------------------------------------------
// Kept at <dir>/<speciesId>/att_….png so her history can show them again (聊天记录 keeps only the refs).
class ChatImages {
  constructor(dir) {
    this.dir = dir;
  }

  _path(speciesId, file) {
    if (!SPECIES_RE.test(String(speciesId || '')) || !ATT_RE.test(String(file || ''))) return null;
    return path.join(this.dir, speciesId, file);
  }

  // read: readImage() results. -> [{ ref: { id, file, name, mime, size }, path }]
  save(speciesId, read) {
    if (!SPECIES_RE.test(String(speciesId || ''))) throw new ChatError('unknown character', 'EBADCHAR');
    const dir = path.join(this.dir, speciesId);
    fs.mkdirSync(dir, { recursive: true });
    return read.map((r) => {
      const file = `${rid('att').toLowerCase()}.${r.ext}`;
      const p = path.join(dir, file);
      fs.writeFileSync(p, r.buffer);
      return { ref: { id: file.replace(/\.\w+$/, ''), file, name: r.name, mime: r.mime, size: r.buffer.length }, path: p };
    });
  }

  dataUrl(speciesId, ref) {
    const p = ref && this._path(speciesId, ref.file);
    if (!p) return null;
    try {
      return `data:${ref.mime};base64,${fs.readFileSync(p).toString('base64')}`;
    } catch {
      return null; // the file is gone: shown as missing
    }
  }
}

// A 聊天记录 message as the chat page gets it. Pictures sent from the chat page come back as data URLs;
// ones sent on the desktop were not kept (only their count), so they are listed without a picture.
function messageView(m, images, speciesId) {
  const a = m.attachments || {};
  const refs = Array.isArray(a.refs) ? a.refs : [];
  const shown = refs.map((r) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size, url: images ? images.dataUrl(speciesId, r) : null }));
  const extra = Math.max(0, (Number(a.images) || 0) - refs.length);
  return {
    id: m.id,
    turnId: m.turnId || null,
    role: m.role === 'user' ? 'user' : 'assistant',
    text: m.text || '',
    createdAt: m.at,
    status: m.status === 'error' ? 'error' : m.status === 'canceled' ? 'aborted' : 'done',
    error: m.error || undefined,
    model: m.model || null,
    via: m.via === 'console' ? 'console' : 'desktop',
    attachments: shown,
    unsavedImages: extra,
  };
}

// Only the answer is shown (like LobeHub's Personal Agent), never the model's working. The chat runs with no tools
// (`tools: []`), and the Responses stream's reasoning / tool events are not passed on (responses-client reads
// `output_text` only), but some models still write their working into the answer text: a tool call they cannot
// make as markup (DeepSeek's `<｜｜DSML｜｜ calls>…`, `<｜tool▁calls▁begin｜>…`, `<tool_call>…`, `<function_calls>…`)
// or their thinking (`<think>…</think>`). Seen on real LobeHub (T-2777): 「我先去抓一下今天的科技新闻。」 followed by
// a raw `<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="activateSkill">…`. Those blocks are cut out — a block still
// open (mid-stream, or never closed) up to the end, and the start of an opening marker at the very end of a
// streamed piece, so it never flashes up.
const WORKING_BLOCKS = [
  [/<[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(function_)?calls\s*>/i, /<\/[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(function_)?calls\s*>/i],
  [/<[｜|]tool▁calls▁begin[｜|]>/, /<[｜|]tool▁calls▁end[｜|]>/],
  [/<tool_calls?>/i, /<\/tool_calls?>/i],
  [/<function_calls>/i, /<\/function_calls>/i],
  [/<think(ing)?>/i, /<\/think(ing)?>/i],
];
const OPENERS = ['<｜｜DSML｜｜', '<||DSML||', '<｜tool▁calls▁begin｜>', '<tool_call', '<function_calls>', '<think>', '<thinking>'];
function answerOnly(text, { streaming = false } = {}) {
  let t = String(text || '');
  for (const [open, close] of WORKING_BLOCKS) {
    for (let guard = 0; guard < 50; guard++) {
      const a = t.search(open);
      if (a < 0) break;
      const rest = t.slice(a);
      const m = rest.slice(1).match(close);
      const end = m ? a + 1 + m.index + m[0].length : t.length;
      t = t.slice(0, a) + t.slice(end);
    }
  }
  if (streaming) {
    const lt = t.lastIndexOf('<');
    if (lt >= 0 && t.length - lt <= 24) {
      const tail = t.slice(lt);
      if (OPENERS.some((o) => o.toLowerCase().startsWith(tail.toLowerCase()))) t = t.slice(0, lt);
    }
    return t.replace(/\s+$/, (w) => (/\n\n/.test(w) ? '' : w));
  }
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// A readable sentence for a failed turn (the UI shows it as is).
function readableError(e) {
  const msg = String((e && e.message) || e || '');
  switch (e && e.code) {
    case 'EAUTH': return 'LobeHub 登录不可用或已过期：请在终端运行 `lh login` 后重试';
    case 'ENET': return `连不上 LobeHub：${msg.replace(/^Responses API unreachable:\s*/, '')}`;
    case 'ETIMEDOUT': return '模型回复超时，请稍后重试';
    case 'ENOREPLY': return '模型没有返回内容，请重试或换一个模型';
    case 'EAPI': return `LobeHub 返回错误：${msg.replace(/^Responses API:?\s*/, '')}`;
    case 'EUPLOAD': return msg;
    case 'EAGENT': return msg;
    default: return msg || '发送失败';
  }
}


module.exports = {
  ChatError, ChatImages, answerOnly, readImage, sniffImage, readableError, conversationOf, historyPage, wantsRecall, pickRecall, recentRounds,
  buildConsoleBody, messageView, transcript, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TEXT, CONTEXT_MS, PAGE,
};
