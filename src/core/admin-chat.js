'use strict';

// 设置窗口 → 聊天 (docs/admin-chat.md): an everyday AI chat with any of the user's LobeHub chat models, apart
// from the pet. Electron-free so it can be tested: main.js passes the LobeHub side (`lh`, a ResponsesClient,
// the model catalog of PetService#refreshModels) and the folder under userData; the tests pass fakes.
//
// On disk (userData/admin-chat/, written atomically through core/store.js):
//   index.json                  { version, selectedModel, agent, sessions: [summary] }
//   sessions/<sessionId>.json   { id, title, createdAt, updatedAt, model, messages: [message] }
//   attachments/<sessionId>/    the pictures sent in that session (att_….png …)
//
// How a turn reaches the model. LobeHub's Responses API (`/api/v1/responses`, the same auth and request as
// core/responses-client.js) runs an *agent*: `model` is an agent id, and the agent's model/provider decide the
// LLM. So the chat keeps one agent of its own ("Pixel Pet 聊天"), switched to the chosen model before a turn.
// The server reads the text of the last input message only, so the whole history is written into that message
// (buildTurnInput); pictures are uploaded as LobeHub files, attached to a user message in a fresh topic the
// turn continues (`previous_response_id`), and listed as `input_image` { file_id } parts of the same input.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store } = require('./store');
const modelsLib = require('./models');

const VERSION = 1;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 4; // per message
const MAX_CONTEXT_IMAGES = 6; // the most recent pictures of a session the model sees again
const MAX_CONTEXT_CHARS = 60000; // history written into one turn; the oldest messages go first
const MAX_TEXT = 20000; // one message
const TIMEOUT_MS = 180000;
const TITLE_LEN = 30;
const ID_RE = /^ses_[a-z0-9]{6,40}$/;
const ATT_RE = /^att_[a-z0-9]{6,40}\.(png|jpg|gif|webp)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const AGENT_TITLE = 'Pixel Pet 聊天';
const SYSTEM_ROLE = '你是一个友好、可靠的 AI 助手，在 Pixel Pet 的设置窗口里和用户日常聊天。用用户使用的语言回答，简洁清楚；看得到用户发来的图片时，先看图再回答。';
const DEFAULT_TITLE = '新会话';

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

// ---- context -------------------------------------------------------------------------------------------
const imageNote = (m) => (m.attachments && m.attachments.length ? `［附图 ${m.attachments.length} 张：${m.attachments.map((a) => a.name).join('、')}］` : '');

// The messages that count as context: finished ones with something in them, in order (failed turns and
// empty stopped ones are left out; a stopped reply that said something stays).
function contextMessages(messages) {
  return (messages || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.status !== 'error' && ((m.text && m.text.trim()) || (m.attachments && m.attachments.length)));
}

// The Responses API input of one turn: a single user message whose text is the earlier conversation (oldest
// first, cut from the front at maxChars) followed by the new message, plus one `input_image` per picture the
// model should see (`imageFileIds`, LobeHub file ids). -> [{ type: 'message', role: 'user', content }]
function buildTurnInput(history, current, { imageFileIds = [], maxChars = MAX_CONTEXT_CHARS } = {}) {
  const lines = contextMessages(history).map((m) => `${m.role === 'user' ? '【用户】' : '【助手】'}${(m.text || '').trim()}${m.role === 'user' ? imageNote(m) : ''}`);
  let used = 0;
  let from = lines.length;
  while (from > 0 && used + lines[from - 1].length + 1 <= maxChars) used += lines[--from].length + 1;
  const kept = lines.slice(from);
  const now = (current.text || '').trim() || '（请看我发的图片）';
  const parts = [];
  if (kept.length) {
    parts.push(`以下是我们这次对话到目前为止的记录（按时间顺序${from ? `，更早的 ${from} 条已省略` : ''}）：`, ...kept, '', '现在我说：');
  }
  parts.push(`${now}${imageNote(current)}`);
  const content = [{ type: 'input_text', text: parts.join('\n') }];
  for (const id of imageFileIds) content.push({ type: 'input_image', file_id: id, detail: 'auto' });
  return [{ type: 'message', role: 'user', content }];
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

// ---- the store -------------------------------------------------------------------------------------------
class AdminChat {
  // dir: userData/admin-chat. lh: LhClient (workspace scope, agent, files, topics). responses: ResponsesClient.
  // loadCatalog({ force }): the catalog [{ id, displayName, providerId, enabled, type, abilities }].
  constructor({ dir, lh, responses, loadCatalog = async () => [], now = () => Date.now(), timeoutMs = TIMEOUT_MS }) {
    this.dir = dir;
    this.lh = lh;
    this.responses = responses;
    this.loadCatalog = loadCatalog;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.index = new Store(dir, 'index.json');
    this.sessionsDir = path.join(dir, 'sessions');
    this.attDir = path.join(dir, 'attachments');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.attDir, { recursive: true });
    this.state = this._loadIndex();
    this._models = null; // last listModels() options
    this.inflight = null; // { sessionId, ac, messageId }
  }

  _loadIndex() {
    const s = this.index.load();
    if (!s || typeof s !== 'object' || !Array.isArray(s.sessions)) return { version: VERSION, selectedModel: null, agent: null, sessions: [] };
    return { version: VERSION, selectedModel: typeof s.selectedModel === 'string' ? s.selectedModel : null, agent: s.agent && typeof s.agent.id === 'string' ? s.agent : null, sessions: s.sessions.filter((x) => x && ID_RE.test(x.id)) };
  }

  _saveIndex() {
    this.index.save(this.state);
  }

  _sessionStore(id) {
    return new Store(this.sessionsDir, `${id}.json`);
  }

  _readSession(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    const s = this._sessionStore(id).load();
    return s && s.id === id && Array.isArray(s.messages) ? s : null;
  }

  _summary(s) {
    const last = [...s.messages].reverse().find((m) => m.text && m.text.trim());
    return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, model: s.model || null, messageCount: s.messages.length, preview: last ? last.text.trim().slice(0, 60) : '' };
  }

  _writeSession(s) {
    this._sessionStore(s.id).save(s);
    const sum = this._summary(s);
    const i = this.state.sessions.findIndex((x) => x.id === s.id);
    if (i >= 0) this.state.sessions[i] = sum;
    else this.state.sessions.push(sum);
    this._saveIndex();
    return sum;
  }

  _attachmentPath(sessionId, file) {
    if (!ID_RE.test(sessionId) || !ATT_RE.test(String(file || ''))) return null;
    return path.join(this.attDir, sessionId, file);
  }

  // A message as the renderer gets it: pictures as data URLs it can show directly (CSP allows data:).
  _messageView(sessionId, m) {
    const attachments = (m.attachments || []).map((a) => {
      let url = null;
      const p = this._attachmentPath(sessionId, a.file);
      try {
        if (p) url = `data:${a.mime};base64,${fs.readFileSync(p).toString('base64')}`;
      } catch { /* file gone: shown as missing */ }
      return { id: a.id, name: a.name, mime: a.mime, size: a.size, url };
    });
    const { attachments: _a, ...rest } = m;
    const out = { ...rest, attachments };
    delete out.remote;
    return out;
  }

  // ---- sessions ----
  listSessions() {
    return { ok: true, sessions: [...this.state.sessions].sort((a, b) => b.updatedAt - a.updatedAt) };
  }

  createSession({ title } = {}) {
    const t = this.now();
    const s = { id: rid('ses').toLowerCase(), title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 60) : DEFAULT_TITLE, createdAt: t, updatedAt: t, model: null, messages: [] };
    return { ok: true, session: this._writeSession(s) };
  }

  getSession(id) {
    const s = this._readSession(id);
    if (!s) return { ok: false, reason: 'not-found', message: '会话不存在' };
    return { ok: true, session: { ...this._summary(s), messages: s.messages.map((m) => this._messageView(s.id, m)), streaming: !!(this.inflight && this.inflight.sessionId === s.id) } };
  }

  deleteSession(id) {
    if (!ID_RE.test(String(id || ''))) return { ok: false, reason: 'not-found', message: '会话不存在' };
    if (this.inflight && this.inflight.sessionId === id) this.abort(id);
    const had = this.state.sessions.some((x) => x.id === id);
    this.state.sessions = this.state.sessions.filter((x) => x.id !== id);
    this._saveIndex();
    this._sessionStore(id).clear();
    fs.rmSync(path.join(this.attDir, id), { recursive: true, force: true });
    return had ? { ok: true } : { ok: false, reason: 'not-found', message: '会话不存在' };
  }

  // Empty a session (its messages and pictures); it keeps its id, gets its default title back.
  clearSession(id) {
    const s = this._readSession(id);
    if (!s) return { ok: false, reason: 'not-found', message: '会话不存在' };
    if (this.inflight && this.inflight.sessionId === id) this.abort(id);
    s.messages = [];
    s.title = DEFAULT_TITLE;
    s.updatedAt = this.now();
    fs.rmSync(path.join(this.attDir, id), { recursive: true, force: true });
    const sum = this._writeSession(s);
    return { ok: true, session: { ...sum, messages: [], streaming: false } };
  }

  // ---- models ----
  async listModels({ force = false } = {}) {
    let error = null;
    let catalog = [];
    try {
      catalog = (await this.loadCatalog({ force })) || [];
    } catch (e) {
      error = e.message;
    }
    const models = modelsLib.chatModelOptions(catalog);
    if (models.length) this._models = models;
    const list = models.length ? models : this._models || [];
    const sel = list.find((m) => m.key === this.state.selectedModel) || list[0] || null;
    return { ok: true, models: list, selected: sel ? sel.key : null, error: error || (list.length ? null : '没有可用的聊天模型：请检查 LobeHub 登录与模型服务商设置') };
  }

  async setModel(key) {
    const k = String(key || '');
    if (!modelsLib.KEY_RE.test(k)) return { ok: false, reason: 'bad-model', message: '模型格式不对' };
    const list = this._models || (await this.listModels()).models;
    if (list.length && !list.some((m) => m.key === k)) return { ok: false, reason: 'unknown-model', message: '没有这个模型' };
    this.state.selectedModel = k;
    this._saveIndex();
    return { ok: true, selected: k };
  }

  async _resolveModel(key) {
    const list = this._models || (await this.listModels()).models;
    const k = key || this.state.selectedModel;
    const m = list.find((x) => x.key === k) || (!key ? list[0] : null);
    if (m) return m;
    if (k && modelsLib.KEY_RE.test(k) && !list.length) {
      // the catalog could not be loaded: trust a well-formed key (vision unknown → allowed)
      const [providerId, ...rest] = k.split(':');
      return { key: k, providerId, id: rest.join(':'), label: rest.join(':'), vision: true };
    }
    return null;
  }

  // ---- the chat's own agent ----
  async _ensureAgent(model) {
    const ws = this.lh.workspaceId === undefined ? null : this.lh.workspaceId || null;
    let a = this.state.agent;
    if (!a || (a.workspaceId || null) !== ws) {
      const r = await this.lh.createAgent({ title: AGENT_TITLE, description: '设置窗口 → 聊天 使用的通用助手', systemRole: SYSTEM_ROLE });
      a = { id: r.agentId, workspaceId: ws, modelKey: null };
      this.state.agent = a;
      this._saveIndex();
    }
    if (a.modelKey !== model.key) {
      try {
        await this.lh.updateAgent({ agentId: a.id, model: model.id, provider: model.providerId });
      } catch (e) {
        // the agent may have been deleted in LobeHub: make a new one, once
        if (this.state.agent !== a) throw e;
        this.state.agent = null;
        return this._ensureAgent(model);
      }
      a.modelKey = model.key;
      this._saveIndex();
    }
    return a.id;
  }

  // The pictures the model sees this turn (the latest MAX_CONTEXT_IMAGES of the session), uploaded once
  // each (the LobeHub file id is kept on the attachment as `remote`). -> [fileId]
  async _uploadContextImages(s, signal) {
    const atts = s.messages.filter((m) => m.role === 'user' && m.status !== 'error').flatMap((m) => m.attachments || []).slice(-MAX_CONTEXT_IMAGES);
    const ids = [];
    for (const a of atts) {
      if (signal.aborted) throw new ChatError('Canceled', 'ECANCELED');
      if (!a.remote || a.remote.workspaceId !== (this.lh.workspaceId || null)) {
        const p = this._attachmentPath(s.id, a.file);
        if (!p || !fs.existsSync(p)) continue;
        try {
          a.remote = { fileId: await this.lh.uploadFile(p), workspaceId: this.lh.workspaceId || null };
        } catch (e) {
          throw new ChatError(`图片上传失败：${e.message}`, 'EUPLOAD');
        }
        this._sessionStore(s.id).save(s);
      }
      ids.push(a.remote.fileId);
    }
    return ids;
  }

  // ---- a turn ----
  // { sessionId, text, images: [{ path } | { dataUrl, name }], model?: 'provider:id' }
  // onDelta({ sessionId, messageId, delta, text }) for each piece of the reply as it streams.
  // -> { ok: true, userMessage, message } | { ok: false, reason, message?, error?, userMessage?, ... }
  async send({ sessionId, text, images = [], model } = {}, { onDelta = () => {} } = {}) {
    const s = this._readSession(sessionId);
    if (!s) return { ok: false, reason: 'not-found', error: '会话不存在' };
    const clean = typeof text === 'string' ? text.trim() : '';
    const imgs = Array.isArray(images) ? images : [];
    if (!clean && !imgs.length) return { ok: false, reason: 'empty', error: '消息是空的' };
    if (clean.length > MAX_TEXT) return { ok: false, reason: 'too-long', error: `一条消息最多 ${MAX_TEXT} 个字符` };
    if (imgs.length > MAX_IMAGES) return { ok: false, reason: 'too-many-images', error: `一次最多发送 ${MAX_IMAGES} 张图片` };
    if (this.inflight) return { ok: false, reason: 'busy', error: '上一条消息还在回复中' };
    const read = imgs.map((x) => readImage(x));
    const badImg = read.find((r) => !r.ok);
    if (badImg) return { ok: false, reason: badImg.reason, error: badImg.message };
    const m = await this._resolveModel(typeof model === 'string' && model ? model : null);
    if (!m) return { ok: false, reason: 'no-model', error: model ? '没有这个模型' : '没有可用的聊天模型' };
    if (read.length && !m.vision) return { ok: false, reason: 'no-vision', error: `${m.label} 不支持图片，请换一个支持视觉的模型` };
    if (this.inflight) return { ok: false, reason: 'busy', error: '上一条消息还在回复中' };

    const ac = new AbortController();
    const messageId = rid('msg');
    this.inflight = { sessionId: s.id, ac, messageId };
    try {
      // the user's message is kept first, so it is there even when the turn fails
      const history = s.messages.slice();
      const dir = path.join(this.attDir, s.id);
      if (read.length) fs.mkdirSync(dir, { recursive: true });
      const attachments = read.map((r) => {
        const file = `${rid('att').toLowerCase()}.${r.ext}`;
        fs.writeFileSync(path.join(dir, file), r.buffer);
        return { id: file.replace(/\.\w+$/, ''), file, name: r.name, mime: r.mime, size: r.buffer.length };
      });
      const t = this.now();
      const user = { id: rid('msg'), role: 'user', text: clean, attachments, model: m.key, createdAt: t, status: 'done' };
      s.messages.push(user);
      if (s.title === DEFAULT_TITLE && clean) s.title = clean.replace(/\s+/g, ' ').slice(0, TITLE_LEN);
      s.updatedAt = t;
      s.model = m.key;
      this._writeSession(s);

      let partial = '';
      const finish = (extra) => {
        const msg = { id: messageId, role: 'assistant', text: partial, attachments: [], model: m.key, createdAt: this.now(), ...extra };
        s.messages.push(msg);
        s.updatedAt = msg.createdAt;
        this._writeSession(s);
        return this._messageView(s.id, msg);
      };
      try {
        if (this.responses.available && !this.responses.available()) throw new ChatError('LobeHub login is missing', 'EAUTH');
        const agentId = await this._ensureAgent(m).catch((e) => { throw e.code ? e : new ChatError(`聊天助手准备失败：${e.message}`, 'EAGENT'); });
        if (ac.signal.aborted) throw new ChatError('Canceled', 'ECANCELED');
        const fileIds = await this._uploadContextImages(s, ac.signal);
        let topicId;
        if (fileIds.length) {
          try {
            topicId = await this.lh.createTopic(agentId, s.title.slice(0, 40) || AGENT_TITLE);
            const mid = await this.lh.createUserMessage({ agentId, topicId, content: '（这次对话里的图片，按发送顺序）' });
            await this.lh.addFilesToMessage(mid, fileIds);
          } catch (e) {
            throw new ChatError(`图片上传失败：${e.message}`, 'EUPLOAD');
          }
        }
        if (ac.signal.aborted) throw new ChatError('Canceled', 'ECANCELED');
        const input = buildTurnInput(history, user, { imageFileIds: fileIds });
        const r = await this.responses.run({
          agentId, prompt: input, topicId, tools: [], timeoutMs: this.timeoutMs, signal: ac.signal,
          onDelta: (delta, full) => {
            partial = full;
            try {
              onDelta({ sessionId: s.id, messageId, delta, text: full });
            } catch { /* a display callback must not cost the turn */ }
          },
        });
        partial = r.text;
        const message = finish({ status: 'done' });
        return { ok: true, sessionId: s.id, userMessage: this._messageView(s.id, user), message, session: this._summary(s) };
      } catch (e) {
        if (e.code === 'ECANCELED' || ac.signal.aborted) {
          const message = finish({ status: 'aborted' });
          return { ok: false, reason: 'aborted', sessionId: s.id, error: '已停止', userMessage: this._messageView(s.id, user), message, session: this._summary(s) };
        }
        const error = readableError(e);
        const message = finish({ status: 'error', error });
        return { ok: false, reason: 'error', code: e.code || null, error, sessionId: s.id, userMessage: this._messageView(s.id, user), message, session: this._summary(s) };
      }
    } finally {
      this.inflight = null;
    }
  }

  // Stop the reply being written in `sessionId` (any session when omitted). -> { ok, aborted }
  abort(sessionId) {
    const f = this.inflight;
    if (!f || (sessionId && f.sessionId !== sessionId)) return { ok: true, aborted: false };
    f.ac.abort();
    return { ok: true, aborted: true, sessionId: f.sessionId, messageId: f.messageId };
  }
}

module.exports = { AdminChat, ChatError, readImage, sniffImage, buildTurnInput, contextMessages, readableError, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_CONTEXT_IMAGES, MAX_CONTEXT_CHARS, AGENT_TITLE };
