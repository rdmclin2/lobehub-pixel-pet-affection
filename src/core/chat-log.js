'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 聊天记录: every line the pet says (and every message the owner sends) is kept locally with the place it
// came from (`origin`). The history the owner can open only ever shows conversations the owner started:
// `userSessions()` is the one filter, and main.js hands its result to the window as is (the window never
// sees a system line, so it cannot show one). See docs/chat-history.md for the rules.
//
// A message: { id, at, speciesId, role: 'user' | 'pet', origin, kind, turnId, text, attachments?, status? }
//   turnId  — one round: the owner's message and her reply to it share it; a system line has its own.
//   status  — only on a reply that never came: 'error' | 'canceled' (text is empty then).
//   topicEpoch — how many times the owner chose 重新开始话题 for this character before it (absent = 0).

const SCHEMA = 1;
const MAX_MESSAGES = 3000; // the oldest go first; a few months of chatting
const SESSION_GAP_MS = 30 * 60 * 1000; // a pause longer than this starts a new conversation
const PREVIEW_CHARS = 40;

// Where a message came from. Only 'user' is ever shown in the history.
const ORIGINS = {
  user: '用户在聊天框里主动发送',
  topic: '用户在话题面板点了一个预设话题',
  api: '本机 HTTP 接口（外部脚本）',
  greeting: '问候：初次见面、换角色、早晚问候',
  proactive: '主动搭话：饿了、无聊、想你了',
  emotion: '情绪 / 好感度触发：关系升级',
  touch: '触摸身体部位的反应台词',
  care: '喂食 / 摸摸 / 玩耍 / 哄睡的台词',
  system: '其他系统提示：睡醒、角色下线',
  unknown: '旧数据或无法识别的来源',
};
const USER_ORIGIN = 'user';

// The origin of a pet line from its `kind` (the same kinds PetService emits on 'say').
const KIND_ORIGIN = {
  met: 'greeting', switch: 'greeting', greet_morning: 'greeting', greet_evening: 'greeting',
  hungry: 'proactive', bored: 'proactive', missed: 'proactive',
  stage_up: 'emotion',
  feed: 'care', pat: 'care', play: 'care', sleep: 'care',
  woke: 'system', retired: 'system',
  api: 'api',
};
function originOfKind(kind) {
  const k = String(kind || '');
  if (k.startsWith('touch:')) return 'touch';
  if (k.startsWith('topic:')) return 'topic';
  return KIND_ORIGIN[k] || 'system';
}

// Old or hand-edited records: a missing or unknown origin becomes 'unknown' and is never shown
// (nothing proves the owner started it); a record without text or role is dropped.
function normalize(m) {
  if (!m || typeof m !== 'object') return null;
  const role = m.role === 'user' || m.role === 'pet' ? m.role : null;
  if (!role || typeof m.text !== 'string') return null;
  const at = Number(m.at);
  return {
    ...m,
    role,
    at: Number.isFinite(at) ? at : 0,
    origin: Object.prototype.hasOwnProperty.call(ORIGINS, m.origin) ? m.origin : 'unknown',
    turnId: m.turnId ? String(m.turnId) : null,
  };
}

const preview = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return [...t].length > PREVIEW_CHARS ? `${[...t].slice(0, PREVIEW_CHARS).join('')}…` : t;
};

// The history filter. Keeps only rounds the owner started (her own message in the chat box, origin
// 'user') and her reply to each of them; drops every other origin, including a pet line that claims
// 'user' without the owner's message of the same round. Rounds of one character less than
// SESSION_GAP_MS apart form one conversation, unless 重新开始话题 came between them (a new
// topicEpoch). Newest conversation first.
function userSessions(messages, { gapMs = SESSION_GAP_MS } = {}) {
  const all = (Array.isArray(messages) ? messages : []).map(normalize).filter(Boolean);
  const userTurns = new Set(all.filter((m) => m.role === 'user' && m.origin === USER_ORIGIN && m.turnId).map((m) => m.turnId));
  const kept = all.filter((m) => m.origin === USER_ORIGIN && userTurns.has(m.turnId)).sort((a, b) => a.at - b.at);
  const keptSet = new Set(kept);
  const sessions = [];
  let cur = null;
  for (const m of kept) {
    const last = cur && cur.messages[cur.messages.length - 1];
    const sameRound = last && last.turnId === m.turnId;
    if (!cur || (!sameRound && (m.speciesId !== cur.speciesId || epochOf(m) !== cur.epoch || m.at - last.at > gapMs))) {
      cur = { id: m.id, speciesId: m.speciesId || null, epoch: epochOf(m), messages: [] };
      sessions.push(cur);
    }
    cur.messages.push(m);
  }
  return {
    sessions: sessions.reverse().map((s) => {
      const first = s.messages.find((m) => m.role === 'user');
      return {
        id: s.id,
        speciesId: s.speciesId,
        startedAt: s.messages[0].at,
        endedAt: s.messages[s.messages.length - 1].at,
        preview: preview(first.text) || attachmentLabel(first),
        count: s.messages.length,
        userCount: s.messages.filter((m) => m.role === 'user').length,
        messages: s.messages,
      };
    }),
    // how much was left out, by origin (counts only, never the text)
    hidden: all.filter((m) => !keptSet.has(m)).reduce((o, m) => ({ ...o, [m.origin]: (o[m.origin] || 0) + 1 }), {}),
    total: all.length,
  };
}

function epochOf(m) {
  const n = Number(m.topicEpoch);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function attachmentLabel(m) {
  const a = m && m.attachments;
  if (!a) return '';
  return [a.images ? `${a.images} 张图片` : '', a.files && a.files.length ? `${a.files.length} 个文件` : ''].filter(Boolean).join('、');
}

// In memory (tests, and PetService without a folder).
class MemoryChatLog {
  constructor(messages = []) {
    this.data = { schema: SCHEMA, seq: 0, messages: [...messages] };
  }
  _read() { return this.data; }
  _write(d) { this.data = d; }
  list() {
    return this._read().messages;
  }
  // Adds a message and returns it with its id and time.
  append(msg, now = Date.now()) {
    const d = this._read();
    const seq = (Number(d.seq) || d.messages.length) + 1;
    const m = { id: `m${seq}`, at: now, ...msg };
    const messages = [...d.messages, m].slice(-MAX_MESSAGES);
    this._write({ schema: SCHEMA, seq, messages });
    return m;
  }
  clear() {
    this._write({ schema: SCHEMA, seq: 0, messages: [] });
  }
}

// `<userData>/chat-log.json`, written atomically like pet.json. A file that cannot be read is set aside
// once as chat-log.broken.json instead of being overwritten.
class ChatLog extends MemoryChatLog {
  constructor(dir) {
    super();
    this.file = path.join(dir, 'chat-log.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = null;
  }
  _read() {
    if (this.data) return this.data;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') try { fs.renameSync(this.file, path.join(path.dirname(this.file), 'chat-log.broken.json')); } catch { /* keep going without it */ }
    }
    // schema 0: an older bare array of messages (no origin) is read as is; normalize() marks them 'unknown'
    const messages = Array.isArray(raw) ? raw : raw && Array.isArray(raw.messages) ? raw.messages : [];
    this.data = { schema: SCHEMA, seq: (raw && Number(raw.seq)) || messages.length, messages };
    return this.data;
  }
  _write(d) {
    this.data = d;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { ChatLog, MemoryChatLog, userSessions, originOfKind, normalize, ORIGINS, USER_ORIGIN, SESSION_GAP_MS, MAX_MESSAGES };
