'use strict';

// 插个嘴 (docs/interject.md): she listens to a few inputs that are NOT addressed to her — the chat box while
// the owner is still typing, a voice transcript, text an outside program reports through the local API, and
// (only with its own switch) the clipboard — and now and then says one short line about it. Nothing else is
// listened to: no global keyboard hook, no screen, no window titles.
//
// Same idea as LobeHub's IM bot routing (apps/server/src/services/channel/ChannelRoutingService.ts): a decision
// model (jev, `lh generate decide`) answers one boolean question with a probability. ≥ highThreshold → speak;
// ≤ lowThreshold → stay quiet; in between → quiet as well (不打扰优先) unless one of the owner's allow rules
// matches. A failed, refused, malformed or timed-out decision is always silence — it never falls back to
// generating a line. Before any decision call a local prefilter (cooldown, hourly caps, the decision budget,
// debounce, sleep, quiet hours, short / repeated / sensitive input, the owner's block rules) drops what is
// obviously not worth asking about, so with the feature off there are zero decision calls.
//
// Every judged input leaves a record (a short summary, the probability, what she did, the owner's reaction),
// persisted in interject.json. The reaction turns into rules: "别打扰" (or 别插嘴 on the bubble) blocks that kind of
// input at once, three ignored remarks in a row block it too, 说得好 or two remarks the owner answered allow it.
// Rules are applied locally (block = never asked about; allow = an uncertain answer is enough) and are also
// written into the decision's state and criteria, so the model sees what the owner wants.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LlmBudget } = require('./proactive');
const { describeTime } = require('./time-context');

const MIN = 60 * 1000;
const SOURCES = ['chatDraft', 'voice', 'api', 'clipboard'];
const SOURCE_LABEL = { chatDraft: '聊天框里正在打的字（还没发给她）', voice: '语音输入的转写', api: '外部程序（本机接口 /observe）', clipboard: '剪贴板' };
// system-level sources: separate switch, off by default, and their text is never kept in the records
const SYSTEM_SOURCES = ['clipboard'];

const CATEGORIES = [
  ['code', /代码|bug|报错|编译|函数|调试|部署|上线|测试用例|\bgit\b|commit|deploy|\bnpm\b|error|exception|stack ?trace|debug|typescript|python|\bsql\b/i],
  ['work', /会议|开会|周报|日报|老板|需求|加班|ddl|deadline|汇报|工作|项目|客户|邮件|ppt|方案|绩效/i],
  ['food', /吃|饭|饿|奶茶|咖啡|蛋糕|甜品|下午茶|外卖|火锅|零食|夜宵|早餐|午餐|晚餐|好喝|好吃/],
  ['play', /游戏|电影|追剧|动漫|番剧|音乐|听歌|小说|b站|打游戏|周末|旅游|旅行|演唱会/i],
  ['mood', /心情|累|烦|难过|开心|哈哈|好耶|焦虑|压力|崩溃|郁闷|无聊|困了|想哭|爽|终于|太好了|气死|emo/i],
];
const CATEGORY_LABEL = { code: '写代码 / 技术', work: '工作', food: '吃喝', play: '娱乐', mood: '心情', other: '其他' };
const BUCKET_LABEL = { morning: '早上（6–11 点）', afternoon: '白天（11–18 点）', evening: '晚上（18–23 点）', night: '深夜（23–6 点）' };
// what is never sent to the decision model nor said back: passwords, keys, long digit runs (cards, ids)
const SENSITIVE = [/password|passwd|密码|口令|验证码|私钥|secret|api[_-]?key|token/i, /\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_]?[A-Za-z0-9]{12,}/, /\d{12,}/];
// the owner's words in a chat message right after a remark that mean "stop it"
const MUTE_RE = /别(打扰|插嘴|吵|烦|说话|出声)|闭嘴|安静(点|一点|些)?|嘘+|不要(插嘴|打扰)|shut ?up|be quiet/i;

const LIMITS = {
  inputChars: 200, // one input as it goes into the decision state
  inputsKept: 5, // the recent inputs shown to the model
  inputWindowMs: 10 * MIN, // older inputs are forgotten
  stateChars: 1500,
  summaryChars: 24, // what a record keeps of the text
  duplicateMs: 30 * MIN,
  petSpokeMs: 60 * 1000, // she just said something: no remark on top of it
  engageMs: 5 * MIN, // the owner chatting within this after a remark = engaged (or mute)
  ignoreMs: 10 * MIN, // no reaction within this = ignored
  ignoredToBlock: 3,
  engagedToAllow: 2,
  decisionsKept: 200,
  rulesKept: 50,
  lineChars: 60,
};

const FEEDBACK = ['mute', 'ignored', 'like', 'engaged'];

// Offline murmurs, used only when the decision said yes but the agent turn failed (never instead of a decision).
const OFFLINE_LINES = ['嗯嗯，我在旁边听着呢～', '（偷偷瞄了一眼）加油哦。', '诶，这个我也想知道。', '慢慢来，我陪着你。', '哼哼，被我看到了～'];

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const hashOf = (s) => crypto.createHash('sha256').update(normText(s).toLowerCase()).digest('hex').slice(0, 16);
const charLen = (s) => [...normText(s)].length;
const clip = (s, n) => {
  const a = [...normText(s)];
  return a.length > n ? `${a.slice(0, n).join('')}…` : a.join('');
};

function classify(text) {
  const t = normText(text);
  for (const [k, re] of CATEGORIES) if (re.test(t)) return k;
  return 'other';
}

function timeBucket(now) {
  const h = new Date(now).getHours();
  if (h >= 6 && h < 11) return 'morning';
  if (h >= 11 && h < 18) return 'afternoon';
  if (h >= 18 && h < 23) return 'evening';
  return 'night';
}

const isSensitive = (text) => SENSITIVE.some((re) => re.test(String(text || '')));

function inQuietHours(cfg, now) {
  const { quietStart: a, quietEnd: b } = cfg;
  if (a === b) return false;
  const h = new Date(now).getHours();
  return a < b ? h >= a && h < b : h >= a || h < b;
}

// What a record keeps of the input: a short clip; nothing at all for a system source or sensitive text.
function summarize(source, text) {
  if (SYSTEM_SOURCES.includes(source)) return `[${source} ${charLen(text)} 字]`;
  if (isSensitive(text)) return '[敏感内容已略去]';
  return clip(text, LIMITS.summaryChars);
}

// ---- rules -------------------------------------------------------------------------------------------------
// { id, effect: 'block' | 'allow', category?, source?, bucket?, origin: 'mute'|'ignored'|'like'|'engaged'|'manual',
//   note, createdAt, hits, disabled? }. A rule matches an input when every field it names is equal. A disabled
//   rule (switched off in the settings window's rules list) is kept, but matches nothing and is not sent to jev.
const RULE_KEYS = ['category', 'source', 'bucket'];

const activeRules = (rules) => rules.filter((r) => !r.disabled);

function ruleMatches(rule, facts) {
  if (rule.disabled) return false;
  const named = RULE_KEYS.filter((k) => rule[k]);
  return named.length > 0 && named.every((k) => rule[k] === facts[k]);
}

function describeRule(rule) {
  const what = [rule.category && CATEGORY_LABEL[rule.category], rule.source && `来源：${SOURCE_LABEL[rule.source] || rule.source}`, rule.bucket && BUCKET_LABEL[rule.bucket]].filter(Boolean).join(' · ');
  return `${rule.effect === 'block' ? '别插嘴' : '可以插嘴'}：${what}`;
}

function normalizeRule(r) {
  if (!r || typeof r !== 'object' || !['block', 'allow'].includes(r.effect)) return null;
  const out = { id: typeof r.id === 'string' && /^r_[a-z0-9]{4,24}$/.test(r.id) ? r.id : null, effect: r.effect };
  if (r.category && (CATEGORY_LABEL[r.category])) out.category = r.category;
  if (r.source && SOURCES.includes(r.source)) out.source = r.source;
  if (r.bucket && BUCKET_LABEL[r.bucket]) out.bucket = r.bucket;
  if (!RULE_KEYS.some((k) => out[k])) return null;
  out.origin = ['mute', 'ignored', 'like', 'engaged', 'manual'].includes(r.origin) ? r.origin : 'manual';
  out.createdAt = Number.isFinite(r.createdAt) ? r.createdAt : 0;
  out.hits = Number.isInteger(r.hits) && r.hits >= 0 ? r.hits : 0;
  if (r.disabled === true) out.disabled = true;
  out.note = describeRule(out);
  return out;
}

const sameMatch = (a, b) => RULE_KEYS.every((k) => (a[k] || null) === (b[k] || null));

// What the facts of a judged input make a rule match on: its category; for uncategorised text the source and
// the time of day instead (an "other" rule alone would match almost everything).
const ruleScope = (d) => (d.category && d.category !== 'other' ? { category: d.category } : { source: d.source, bucket: d.bucket });

// Feedback on one decision → the rule it settles, if any (pure). `decisions`: newest last, including `d`.
function ruleFromFeedback(d, kind, decisions) {
  const scope = ruleScope(d);
  const sameScope = (x) => x.verdict === 'interject' && x.said && RULE_KEYS.every((k) => !scope[k] || x[k] === scope[k]);
  if (kind === 'mute') return { effect: 'block', ...scope, origin: 'mute' };
  if (kind === 'like') return { effect: 'allow', ...scope, origin: 'like' };
  const recent = decisions.filter(sameScope).filter((x) => x.feedback);
  if (kind === 'ignored') {
    const last = recent.slice(-LIMITS.ignoredToBlock);
    if (last.length === LIMITS.ignoredToBlock && last.every((x) => x.feedback === 'ignored')) return { effect: 'block', ...scope, origin: 'ignored' };
  }
  if (kind === 'engaged' && recent.filter((x) => x.feedback === 'engaged' || x.feedback === 'like').length >= LIMITS.engagedToAllow) return { effect: 'allow', ...scope, origin: 'engaged' };
  return null;
}

// Add `rule` to `rules`: one rule per scope — a new block replaces an allow on the same scope and vice versa.
function addRule(rules, rule, now, rnd = Math.random) {
  const r = normalizeRule({ ...rule, createdAt: now });
  if (!r) return { rules, rule: null };
  const existing = rules.find((x) => sameMatch(x, r));
  if (existing && existing.effect === r.effect) {
    // the same rule again (feedback on a remark it had let through): a disabled one is switched back on
    if (!existing.disabled) return { rules, rule: existing, existed: true };
    const on = { ...existing };
    delete on.disabled;
    return { rules: rules.map((x) => (x === existing ? on : x)), rule: on, existed: true, reenabled: true };
  }
  r.id = `r_${now.toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  return { rules: [...rules.filter((x) => !sameMatch(x, r)), r].slice(-LIMITS.rulesKept), rule: r };
}

// ---- prefilter and verdict (pure) ---------------------------------------------------------------------------
// -> { ok: true } | { ok: false, reason, ruleId? }. Runs before every decision call; cheap checks first.
function prefilter({ cfg, now, pet, busy, input, facts, rules, lastInterjectAt, interjectStamps, decideBudget, recentHashes }) {
  if (!cfg || !cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!cfg.sources[input.source]) return { ok: false, reason: 'source-off' };
  if (!pet) return { ok: false, reason: 'no-pet' };
  if (pet.sleeping) return { ok: false, reason: 'sleeping' };
  if (inQuietHours(cfg, now)) return { ok: false, reason: 'quiet-hours' };
  if (busy) return { ok: false, reason: 'busy' };
  if (charLen(input.text) < cfg.minChars) return { ok: false, reason: 'too-short' };
  if (isSensitive(input.text)) return { ok: false, reason: 'sensitive' };
  const h = hashOf(input.text);
  if (recentHashes.some((x) => x.hash === h && now - x.at < LIMITS.duplicateMs)) return { ok: false, reason: 'duplicate' };
  const block = rules.find((r) => r.effect === 'block' && ruleMatches(r, facts));
  if (block) return { ok: false, reason: 'rule', ruleId: block.id };
  if (lastInterjectAt && now - lastInterjectAt < cfg.cooldownMin * MIN) return { ok: false, reason: 'cooldown' };
  if (pet.lastSpokeAt && now - pet.lastSpokeAt < LIMITS.petSpokeMs) return { ok: false, reason: 'pet-just-spoke' };
  if (interjectStamps.filter((t) => now - t < 60 * MIN).length >= cfg.maxPerHour) return { ok: false, reason: 'hourly-cap' };
  if (!decideBudget.canSpend(now)) return { ok: false, reason: 'decide-budget' };
  return { ok: true };
}

// The decision's answer → what she does. Same thresholds as the IM bot (0.7 / 0.3 by default); the band in
// between is silence unless an allow rule matches. Anything but a valid boolean probability is silence.
function verdict(answer, cfg, allowMatched = false) {
  const p = answer && answer.type === 'boolean' ? answer.probability : undefined;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return { act: false, reason: answer && answer.type === 'refusal' ? 'refused' : 'invalid', probability: null };
  if (p >= cfg.highThreshold) return { act: true, reason: 'confident', probability: p };
  if (p <= cfg.lowThreshold) return { act: false, reason: 'confident-no', probability: p };
  return allowMatched ? { act: true, reason: 'uncertain-allowed', probability: p } : { act: false, reason: 'uncertain', probability: p };
}

// ---- the decision request -------------------------------------------------------------------------------------
const QUESTION = 'interject';

function buildQuestions(all = []) {
  const rules = activeRules(all);
  const allow = rules.filter((r) => r.effect === 'allow').map((r) => r.note.replace(/^可以插嘴：/, ''));
  const block = rules.filter((r) => r.effect === 'block').map((r) => r.note.replace(/^别插嘴：/, ''));
  return {
    [QUESTION]: {
      type: 'boolean',
      instructions: 'A desktop pet companion sits on the owner\'s screen. The state lists what the owner recently typed or said that was NOT addressed to the pet. Is it appropriate and valuable for the pet to interject ONE short casual remark about it right now, without disturbing the owner?',
      criteria: {
        true: `The input shows a feeling, a small win or struggle, or a light topic a caring companion would naturally react to, and one short remark would feel welcome rather than intrusive.${allow.length ? ` The owner has welcomed remarks about: ${allow.join('; ')}.` : ''}`,
        false: `The owner is focused or busy, the input is routine, private, unclear or not worth a reaction, the pet spoke recently, or a remark would just be noise.${block.length ? ` The owner asked the pet not to interject about: ${block.join('; ')}.` : ''}`,
      },
    },
  };
}

function buildState({ now, pet, inputs, rules: all, lastInterjectAt }) {
  const rules = activeRules(all);
  const d = new Date(now);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const ago = (t) => (t ? `${Math.max(0, Math.round((now - t) / MIN))} 分钟前` : '从未');
  const lines = [
    `[时间] ${hhmm}（${describeTime(d)}）`,
    `[宠物] ${pet.name || '她'}；${pet.sleeping ? '在睡觉' : '醒着'}；心情 ${Math.round(pet.mood ?? 70)}/100；上次说话：${ago(pet.lastSpokeAt)}；上次插嘴：${ago(lastInterjectAt)}`,
    '[最近的输入]（都不是对宠物说的）',
    ...inputs.slice(-LIMITS.inputsKept).map((x) => `- （${SOURCE_LABEL[x.source] || x.source}，${Math.max(0, Math.round((now - x.at) / 1000))} 秒前）${clip(x.text, LIMITS.inputChars)}`),
  ];
  if (rules.length) lines.push('[主人定下的规则]', ...rules.slice(-10).map((r) => `- ${r.note}`));
  const s = lines.join('\n');
  return s.length > LIMITS.stateChars ? `${s.slice(0, LIMITS.stateChars - 1)}…` : s;
}

// ---- persistence --------------------------------------------------------------------------------------------
const EMPTY = () => ({ version: 1, rules: [], decisions: [] });

function normalizeData(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    rules: (Array.isArray(r.rules) ? r.rules : []).map(normalizeRule).filter((x) => x && x.id).slice(-LIMITS.rulesKept),
    decisions: (Array.isArray(r.decisions) ? r.decisions : []).filter((x) => x && typeof x === 'object' && typeof x.id === 'string').slice(-LIMITS.decisionsKept),
  };
}

class InterjectStore {
  constructor(dir) {
    this.file = path.join(dir, 'interject.json');
    fs.mkdirSync(dir, { recursive: true });
  }
  load() {
    try {
      return normalizeData(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return EMPTY();
    }
  }
  save(data) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeData(data), null, 2));
    fs.renameSync(tmp, this.file);
  }
}

class MemoryInterjectStore {
  constructor(initial = null) {
    this.data = initial;
  }
  load() {
    return normalizeData(this.data);
  }
  save(d) {
    this.data = normalizeData(JSON.parse(JSON.stringify(d)));
  }
}

// ---- the listener ---------------------------------------------------------------------------------------------
// `decide({ model, questions, state, timeoutMs, signal })` → { answers } (LhClient#decide);
// `speak({ text, source, category, decisionId })` → { ok, text } (PetService says one short line);
// `config()` → settings.interject; `pet()` → the current character or null; `busy()` → she is mid-turn.
class Interjector {
  constructor({ decide, speak, config, pet, busy = () => false, now = () => Date.now(), rnd = Math.random, store = new MemoryInterjectStore(), timers = { setTimeout, clearTimeout }, onEvent = () => {} }) {
    Object.assign(this, { _decide: decide, _speak: speak, _config: config, _pet: pet, _busy: busy, now, rnd, store, timers, onEvent });
    this.data = store.load();
    this.inputs = []; // { source, text, at } — in memory only
    this.timer = null;
    this.evaluating = null;
    this.abort = null;
    this.interjectStamps = this.data.decisions.filter((d) => d.verdict === 'interject' && d.said).map((d) => d.at);
    const last = this.data.decisions.filter((d) => d.verdict === 'interject' && d.said).pop();
    this.lastInterject = last ? { id: last.id, at: last.at } : null;
    this.decideBudget = new LlmBudget(this._cfg().maxDecidePerHour);
    this.calls = 0; // decision calls made by this process (tests, status)
  }

  _cfg() {
    return this._config() || { enabled: false, sources: {} };
  }

  _save() {
    try {
      this.store.save(this.data);
    } catch (e) {
      this.onEvent({ type: 'error', error: e });
    }
  }

  // Something the owner typed / said / copied that is not addressed to her. → { accepted, reason? }
  // Nothing is kept or scheduled while the feature or the source is off.
  input(source, text) {
    const cfg = this._cfg();
    if (!cfg.enabled) return { accepted: false, reason: 'disabled' };
    if (!SOURCES.includes(source)) return { accepted: false, reason: 'unknown-source' };
    if (!cfg.sources[source]) return { accepted: false, reason: 'source-off' };
    const t = this.now();
    const clean = String(text || '').slice(0, 4000);
    // the chat box sends the whole draft each time: the latest draft replaces the previous one
    if (source === 'chatDraft') this.inputs = this.inputs.filter((x) => x.source !== 'chatDraft');
    if (!normText(clean)) {
      if (source === 'chatDraft' && !this.inputs.length) this._clearTimer();
      return { accepted: false, reason: 'empty' };
    }
    this.inputs = [...this.inputs.filter((x) => t - x.at < LIMITS.inputWindowMs), { source, text: clean, at: t }].slice(-LIMITS.inputsKept);
    // debounce: judged only once the owner has paused for debounceSec
    this._clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      this.flush().catch((e) => this.onEvent({ type: 'error', error: e }));
    }, cfg.debounceSec * 1000);
    if (this.timer && this.timer.unref) this.timer.unref();
    return { accepted: true };
  }

  _clearTimer() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  // The owner sent a chat message to her: whatever was waiting is dropped (she answers that message anyway, and
  // a draft that was sent is not a draft any more), an in-flight decision is aborted, and the message is the
  // owner's reaction to her last remark if it came soon after it.
  userChatted(text) {
    this._clearTimer();
    this.inputs = this.inputs.filter((x) => x.source !== 'chatDraft' && x.source !== 'voice');
    if (this.abort) this.abort.abort();
    const li = this.lastInterject;
    if (!li || this.now() - li.at > LIMITS.engageMs) return null;
    const d = this.data.decisions.find((x) => x.id === li.id);
    if (!d || d.feedback) return null;
    return this.feedback(li.id, MUTE_RE.test(String(text || '')) ? 'mute' : 'engaged');
  }

  // Remarks nobody reacted to within ignoreMs count as ignored (called from the heartbeat).
  tick() {
    const li = this.lastInterject;
    if (!li || this.now() - li.at < LIMITS.ignoreMs) return null;
    const d = this.data.decisions.find((x) => x.id === li.id);
    if (!d || d.feedback) return null;
    return this.feedback(li.id, 'ignored');
  }

  // The owner's reaction to one remark. → { ok, decision, rule? } (rule: the one this feedback created)
  feedback(decisionId, kind) {
    if (!FEEDBACK.includes(kind)) return { ok: false, reason: 'bad-feedback' };
    const d = this.data.decisions.find((x) => x.id === decisionId);
    if (!d) return { ok: false, reason: 'not-found' };
    if (d.verdict !== 'interject' || !d.said) return { ok: false, reason: 'not-a-remark' };
    // an explicit 别插嘴 / 说得好 overrides an implicit reaction recorded before; implicit ones never override explicit
    if (d.feedback && (kind === 'ignored' || kind === 'engaged' || d.feedback === kind)) return { ok: true, decision: d, rule: null };
    d.feedback = kind;
    d.feedbackAt = this.now();
    const proposed = ruleFromFeedback(d, kind, this.data.decisions);
    let rule = null;
    if (proposed) {
      const r = addRule(this.data.rules, proposed, this.now(), this.rnd);
      this.data.rules = r.rules;
      if (r.rule && (!r.existed || r.reenabled)) {
        rule = r.rule;
        d.ruleIds = [...(d.ruleIds || []), rule.id];
      }
    }
    this._save();
    this.onEvent({ type: 'feedback', decision: d, rule });
    return { ok: true, decision: d, rule };
  }

  listRules() {
    return this.data.rules.map((r) => ({ ...r }));
  }

  addRule(rule) {
    const r = addRule(this.data.rules, { ...rule, origin: 'manual' }, this.now(), this.rnd);
    if (!r.rule) return { ok: false, reason: 'bad-rule' };
    this.data.rules = r.rules;
    this._save();
    return { ok: true, rule: r.rule };
  }

  // Switch one rule off (kept in the list, matches nothing) or back on. → { ok, rule } | { ok:false, reason:'not-found' }
  setRuleDisabled(id, disabled) {
    const r = this.data.rules.find((x) => x.id === id);
    if (!r) return { ok: false, reason: 'not-found' };
    if (disabled) r.disabled = true;
    else delete r.disabled;
    this._save();
    return { ok: true, rule: { ...r } };
  }

  deleteRule(id) {
    const before = this.data.rules.length;
    this.data.rules = this.data.rules.filter((r) => r.id !== id);
    if (this.data.rules.length === before) return { ok: false, reason: 'not-found' };
    this._save();
    return { ok: true };
  }

  listDecisions(limit = 50) {
    return this.data.decisions.slice(-Math.max(1, Math.min(LIMITS.decisionsKept, limit))).map((d) => ({ ...d }));
  }

  clearDecisions() {
    this.data.decisions = [];
    this._save();
    return { ok: true };
  }

  status() {
    const cfg = this._cfg();
    return { enabled: !!cfg.enabled, sources: cfg.sources, pending: this.inputs.length, evaluating: !!this.evaluating, decideCalls: this.calls, rules: this.data.rules.length, decisions: this.data.decisions.length, lastInterjectAt: this.lastInterject ? this.lastInterject.at : null };
  }

  // Stop everything in flight (feature switched off, app quitting).
  cancel() {
    this._clearTimer();
    this.inputs = [];
    if (this.abort) this.abort.abort();
  }

  _record(d) {
    this.data.decisions = [...this.data.decisions, d].slice(-LIMITS.decisionsKept);
    this._save();
    this.onEvent({ type: 'decision', decision: d });
    return d;
  }

  // Judge the newest input now (the debounce timer calls this; tests call it directly). → the record, or null.
  async flush() {
    this._clearTimer();
    if (this.evaluating) return this.evaluating;
    this.evaluating = this._evaluate().finally(() => {
      this.evaluating = null;
    });
    return this.evaluating;
  }

  async _evaluate() {
    const cfg = this._cfg();
    const t = this.now();
    this.inputs = this.inputs.filter((x) => t - x.at < LIMITS.inputWindowMs);
    const input = this.inputs[this.inputs.length - 1];
    if (!input || !cfg.enabled) return null;
    const pet = this._pet();
    const facts = { source: input.source, category: classify(input.text), bucket: timeBucket(t) };
    const base = { id: `d_${t.toString(36)}${crypto.randomBytes(3).toString('hex')}`, at: t, ...facts, summary: summarize(input.source, input.text), hash: hashOf(input.text), chars: charLen(input.text) };
    this.decideBudget.max = cfg.maxDecidePerHour;
    const pre = prefilter({ cfg, now: t, pet, busy: this._busy(), input, facts, rules: this.data.rules, lastInterjectAt: this.lastInterject && this.lastInterject.at, interjectStamps: this.interjectStamps, decideBudget: this.decideBudget, recentHashes: this.data.decisions });
    if (!pre.ok) {
      // a block rule did its job: count it, so the owner sees which rules are in use
      if (pre.ruleId) {
        const r = this.data.rules.find((x) => x.id === pre.ruleId);
        if (r) r.hits += 1;
      }
      // the owner is mid-turn with her / she is asleep / the feature went off: nothing worth a record
      if (['disabled', 'source-off', 'no-pet', 'busy'].includes(pre.reason)) return null;
      return this._record({ ...base, stage: 'prefilter', reason: pre.reason, ...(pre.ruleId ? { ruleIds: [pre.ruleId] } : {}), probability: null, verdict: 'skip' });
    }
    const allow = this.data.rules.find((r) => r.effect === 'allow' && ruleMatches(r, facts));
    const questions = buildQuestions(this.data.rules);
    const state = buildState({ now: t, pet, inputs: this.inputs, rules: this.data.rules, lastInterjectAt: this.lastInterject && this.lastInterject.at });
    this.decideBudget.spend(t);
    this.calls += 1;
    const ac = new AbortController();
    this.abort = ac;
    const started = this.now();
    let res;
    try {
      res = await this._decide({ model: cfg.model, questions, state, timeoutMs: cfg.timeoutSec * 1000, signal: ac.signal });
    } catch (e) {
      // failure / timeout / abort: silence, never a generated fallback. The error text is not stored (it may
      // carry what the owner typed); only its code.
      return this._record({ ...base, stage: 'error', reason: ac.signal.aborted ? 'aborted' : e && e.code === 'ETIMEDOUT' ? 'timeout' : 'error', errorCode: e && e.code !== undefined ? String(e.code) : null, latencyMs: this.now() - started, probability: null, verdict: 'silent' });
    } finally {
      if (this.abort === ac) this.abort = null;
    }
    if (ac.signal.aborted) return this._record({ ...base, stage: 'error', reason: 'aborted', latencyMs: this.now() - started, probability: null, verdict: 'silent' });
    const v = verdict(res && res.answers && res.answers[QUESTION], cfg, !!allow);
    const rec = { ...base, stage: 'decided', reason: v.reason, probability: v.probability, model: (res && res.model) || cfg.model, latencyMs: this.now() - started, verdict: v.act ? 'interject' : 'skip', ...(v.act && allow ? { ruleIds: [allow.id] } : {}) };
    if (!v.act) return this._record(rec);
    // she may have started a reply meanwhile, or the owner sent something: then the moment has passed
    if (this._busy() || !this.inputs.includes(input)) return this._record({ ...rec, verdict: 'skip', reason: 'moment-passed' });
    let said = null;
    try {
      const r = await this._speak({ text: input.text, source: input.source, category: facts.category, decisionId: rec.id });
      if (r && r.ok && r.text) said = { text: clip(r.text, LIMITS.lineChars), via: r.via || 'llm' };
    } catch (e) {
      this.onEvent({ type: 'error', error: e });
    }
    if (!said) return this._record({ ...rec, verdict: 'skip', reason: 'speak-failed' });
    if (allow) allow.hits += 1;
    this.inputs = this.inputs.filter((x) => x !== input);
    this.interjectStamps = [...this.interjectStamps.filter((s) => t - s < 60 * MIN), t];
    this.lastInterject = { id: rec.id, at: this.now() };
    return this._record({ ...rec, at: this.lastInterject.at, said: said.text, via: said.via, feedback: null });
  }
}

// The prompt for the agent turn that writes the remark (PetService#_interjectSpeak).
function buildInterjectPrompt(stateBlock, { text, source }) {
  const where = SOURCE_LABEL[source] || '输入';
  return `${stateBlock}\n[插嘴] 主人刚才在${where}里写/说了：「${clip(text, LIMITS.inputChars)}」——这句不是对你说的，你只是在旁边看到了。你觉得值得插一句：用一句很短的碎碎念（20 字以内）自然地接一下，像在旁边小声嘀咕；不要追问，不要长篇，不要复述原话，不要提“插嘴”或“看到了你的输入”。`;
}

module.exports = {
  SOURCES, SYSTEM_SOURCES, SOURCE_LABEL, CATEGORY_LABEL, BUCKET_LABEL, LIMITS, FEEDBACK, MUTE_RE, OFFLINE_LINES, QUESTION,
  classify, timeBucket, isSensitive, inQuietHours, summarize, hashOf,
  activeRules, ruleMatches, describeRule, normalizeRule, ruleFromFeedback, addRule, prefilter, verdict, buildQuestions, buildState, buildInterjectPrompt,
  InterjectStore, MemoryInterjectStore, Interjector,
};
