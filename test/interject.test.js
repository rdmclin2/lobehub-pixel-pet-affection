'use strict';
// 插个嘴 (core/interject.js, docs/interject.md): settings, prefilter, thresholds, silence on failure, rules
// from feedback and their effect, lh decide(), and the PetService / local API wiring. decide() is mocked
// except in the lh-client tests, which run the fake `lh` (test/fixtures/fake-lh.js).
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ij = require('../src/core/interject');
const settingsLib = require('../src/core/settings');
const schema = require('../src/core/settings-schema');
const api = require('../src/core/api');
const { LlmBudget } = require('../src/core/proactive');
const { LhClient, cleanEnv, parseDecision } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const T0 = new Date('2026-01-05T14:00:00').getTime(); // a Monday afternoon: outside the default quiet hours
const MIN = 60000;
const ON = (over = {}) => settingsLib.normalizeInterject({ enabled: true, ...over });

// An Interjector with a scripted decide() and a recording speak(); fake timers (flush() is called by hand).
function rig({ cfg = ON(), answers = [], pet = {}, busy = false, store } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const spoken = [];
  const events = [];
  const queue = [...answers];
  const state = { cfg, pet: { name: '小芽', sleeping: false, mood: 70, lastSpokeAt: T0 - 30 * MIN, ...pet }, busy };
  const timers = { setTimeout: () => ({ fake: true }), clearTimeout: () => {} };
  const decide = async (req) => {
    calls.push(req);
    const a = queue.length ? queue.shift() : 0.9;
    if (a instanceof Error) throw a;
    if (typeof a === 'function') return a(req);
    if (a && typeof a === 'object') return { answers: { interject: a } };
    return { answers: { interject: { type: 'boolean', probability: a } }, model: 'jev-1.14.0' };
  };
  const speak = async (req) => {
    spoken.push(req);
    state.pet.lastSpokeAt = clock.t;
    return { ok: true, text: '嘿嘿，修好啦？辛苦啦～', via: 'llm' };
  };
  const it = new ij.Interjector({ decide, speak, config: () => state.cfg, pet: () => state.pet, busy: () => state.busy, now: () => clock.t, rnd: () => 0.5, store: store || new ij.MemoryInterjectStore(), timers, onEvent: (e) => events.push(e) });
  const say = async (source, text, advanceMin = 0) => {
    clock.t += advanceMin * MIN;
    const r = it.input(source, text);
    if (!r.accepted) return { accepted: r };
    return it.flush();
  };
  return { it, clock, calls, spoken, events, state, say };
}

// ---- settings ------------------------------------------------------------------------------------------------
test('settings: 插个嘴 is off by default, the clipboard source too; an old file without it gets the defaults', () => {
  const d = settingsLib.normalizeSettings(null).interject;
  assert.equal(d.enabled, false);
  assert.deepEqual(d.sources, { chatDraft: true, voice: true, api: true, clipboard: false });
  assert.equal(d.model, 'lobehub/jev-1.14.0');
  assert.equal(d.highThreshold, 0.7);
  assert.equal(d.lowThreshold, 0.3);
  const old = settingsLib.normalizeSettings({ ageGateVersion: 2, answered: true, proactive: { enabled: false } });
  assert.deepEqual(old.interject, d, 'migration: missing section → defaults (off)');
});

test('settings: bad values fall back; an unknown source is dropped; low ≥ high resets both thresholds', () => {
  const s = settingsLib.normalizeInterject({ enabled: 'yes', sources: { clipboard: true, keyboard: true }, cooldownMin: 0, maxPerHour: 99, model: 'rm -rf', highThreshold: 0.5, lowThreshold: 0.5, quietStart: 25 });
  assert.equal(s.enabled, false);
  assert.equal(s.sources.clipboard, true);
  assert.equal('keyboard' in s.sources, false);
  assert.equal(s.cooldownMin, 10);
  assert.equal(s.maxPerHour, 3);
  assert.equal(s.model, 'lobehub/jev-1.14.0');
  assert.equal(s.quietStart, 23);
  assert.deepEqual([s.highThreshold, s.lowThreshold], [0.7, 0.3]);
  assert.deepEqual([settingsLib.normalizeInterject({ highThreshold: 0.8, lowThreshold: 0.2 }).highThreshold, settingsLib.normalizeInterject({ highThreshold: 0.8, lowThreshold: 0.2 }).lowThreshold], [0.8, 0.2]);
  assert.equal(settingsLib.normalizeInterject({ model: 'openrouter/typesafe-jev-1.13' }).model, 'openrouter/typesafe-jev-1.13');
});

test('schema: every interject leaf has a console field; a nested source goes to setSection as a nested patch', () => {
  for (const k of schema.settingsLeaves().filter((x) => x.startsWith('interject.'))) assert.ok(schema.FIELDS.some((f) => f.key === k), k);
  assert.deepEqual(schema.patchFor('interject.sources.clipboard', true), { setter: 'setSection', section: 'interject', patch: { sources: { clipboard: true } } });
  assert.deepEqual(schema.validate('interject.highThreshold', 0.85), { ok: true, value: 0.85 });
  assert.equal(schema.validate('interject.model', 'not a model').ok, false);
});

// ---- prefilter / verdict (pure) ----------------------------------------------------------------------------------
test('prefilter: every local reason to stay quiet, cheapest first, before any decision call', () => {
  const base = { cfg: ON(), now: T0, pet: { sleeping: false, lastSpokeAt: T0 - 30 * MIN }, busy: false, input: { source: 'chatDraft', text: '终于把这个 bug 修好了' }, facts: { source: 'chatDraft', category: 'code', bucket: 'afternoon' }, rules: [], lastInterjectAt: null, interjectStamps: [], decideBudget: new LlmBudget(20), recentHashes: [] };
  const why = (over) => ij.prefilter({ ...base, ...over }).reason;
  assert.equal(ij.prefilter(base).ok, true);
  assert.equal(why({ cfg: settingsLib.normalizeInterject({}) }), 'disabled');
  assert.equal(why({ cfg: ON({ sources: { chatDraft: false } }) }), 'source-off');
  assert.equal(why({ input: { source: 'clipboard', text: 'whatever text here' } }), 'source-off', 'clipboard is off unless switched on');
  assert.equal(why({ pet: null }), 'no-pet');
  assert.equal(why({ pet: { sleeping: true } }), 'sleeping');
  assert.equal(why({ now: new Date('2026-01-05T23:30:00').getTime() }), 'quiet-hours');
  assert.equal(why({ now: new Date('2026-01-05T07:59:00').getTime() }), 'quiet-hours', 'quiet hours wrap past midnight');
  assert.equal(ij.prefilter({ ...base, cfg: ON({ quietStart: 0, quietEnd: 0 }), now: new Date('2026-01-06T03:00:00').getTime() }).ok, true, 'equal start and end = no quiet hours');
  assert.equal(why({ busy: true }), 'busy');
  assert.equal(why({ input: { source: 'chatDraft', text: '嗯嗯' } }), 'too-short');
  assert.equal(why({ input: { source: 'chatDraft', text: '我的密码是 hunter2hunter2' } }), 'sensitive');
  assert.equal(why({ input: { source: 'chatDraft', text: 'export KEY=sk-abcdefghijklmnop1234' } }), 'sensitive');
  assert.equal(why({ recentHashes: [{ hash: ij.hashOf('终于把这个  bug 修好了 '), at: T0 - 5 * MIN }] }), 'duplicate');
  assert.equal(ij.prefilter({ ...base, recentHashes: [{ hash: ij.hashOf('终于把这个 bug 修好了'), at: T0 - 31 * MIN }] }).ok, true, 'a repeat after 30 min is judged again');
  const block = { id: 'r_x1', effect: 'block', category: 'code' };
  assert.deepEqual(ij.prefilter({ ...base, rules: [block] }), { ok: false, reason: 'rule', ruleId: 'r_x1' });
  assert.equal(why({ lastInterjectAt: T0 - 5 * MIN }), 'cooldown');
  assert.equal(why({ pet: { sleeping: false, lastSpokeAt: T0 - 20000 } }), 'pet-just-spoke');
  assert.equal(why({ interjectStamps: [T0 - 50 * MIN, T0 - 40 * MIN, T0 - 30 * MIN] }), 'hourly-cap');
  assert.equal(why({ cfg: ON({ maxPerHour: 0 }) }), 'hourly-cap');
  const spent = new LlmBudget(1);
  spent.spend(T0 - MIN);
  assert.equal(why({ decideBudget: spent }), 'decide-budget');
});

test('verdict: ≥ high speaks, ≤ low is quiet, the band between is quiet unless an allow rule matches; invalid = quiet', () => {
  const cfg = ON();
  assert.deepEqual(ij.verdict({ type: 'boolean', probability: 0.7 }, cfg), { act: true, reason: 'confident', probability: 0.7 });
  assert.deepEqual(ij.verdict({ type: 'boolean', probability: 0.3 }, cfg), { act: false, reason: 'confident-no', probability: 0.3 });
  assert.deepEqual(ij.verdict({ type: 'boolean', probability: 0.55 }, cfg), { act: false, reason: 'uncertain', probability: 0.55 });
  assert.deepEqual(ij.verdict({ type: 'boolean', probability: 0.55 }, cfg, true), { act: true, reason: 'uncertain-allowed', probability: 0.55 });
  assert.equal(ij.verdict({ type: 'refusal' }, cfg, true).reason, 'refused');
  for (const bad of [undefined, null, {}, { type: 'boolean' }, { type: 'boolean', probability: 1.2 }, { type: 'boolean', probability: NaN }, { type: 'choice', choice: 'yes' }]) assert.equal(ij.verdict(bad, cfg, true).act, false);
  assert.equal(ij.verdict({ type: 'boolean', probability: 0.75 }, ON({ highThreshold: 0.8, lowThreshold: 0.2 })).act, false, 'thresholds come from settings');
});

test('decision request: one boolean question; the state carries time, pet, clipped recent inputs and the rules', () => {
  const rules = [ij.normalizeRule({ id: 'r_aaaa', effect: 'block', category: 'work' }), ij.normalizeRule({ id: 'r_bbbb', effect: 'allow', category: 'food' })];
  const q = ij.buildQuestions(rules);
  assert.deepEqual(Object.keys(q), ['interject']);
  assert.equal(q.interject.type, 'boolean');
  assert.match(q.interject.criteria.true, /welcomed remarks about: 吃喝/);
  assert.match(q.interject.criteria.false, /not to interject about: 工作/);
  const long = '好'.repeat(500);
  const s = ij.buildState({ now: T0, pet: { name: '小芽', mood: 80, lastSpokeAt: T0 - 3 * MIN }, inputs: [{ source: 'voice', text: long, at: T0 - 4000 }], rules, lastInterjectAt: null });
  assert.match(s, /\[时间\] 14:00/);
  assert.match(s, /小芽；醒着；心情 80\/100；上次说话：3 分钟前；上次插嘴：从未/);
  assert.match(s, /语音输入的转写，4 秒前/);
  assert.ok(!s.includes(long) && s.includes('好'.repeat(200)), 'one input is clipped to 200 characters');
  assert.match(s, /\[主人定下的规则\]\n- 别插嘴：工作\n- 可以插嘴：吃喝/);
  assert.ok(s.length <= ij.LIMITS.stateChars);
});

// ---- the listener ------------------------------------------------------------------------------------------------
test('switched off: input is refused and nothing is ever judged — zero decision calls', async () => {
  const { it, calls, spoken, say } = rig({ cfg: settingsLib.normalizeInterject({}) });
  for (const src of ij.SOURCES) assert.deepEqual((await say(src, '终于把这个 bug 修好了！累死我了')).accepted, { accepted: false, reason: 'disabled' });
  assert.equal(await it.flush(), null);
  assert.equal(calls.length, 0);
  assert.equal(spoken.length, 0);
  assert.equal(it.listDecisions().length, 0);
});

test('a failed, timed-out, refused or malformed decision is always silence (no fallback line)', async () => {
  const timeout = Object.assign(new Error('lh generate timed out'), { code: 'ETIMEDOUT' });
  const { calls, spoken, say, it } = rig({ cfg: ON({ cooldownMin: 1 }), answers: [new Error('TypeSafe not configured'), timeout, { type: 'refusal' }, { nonsense: true }] });
  const texts = ['今天的会议又拖堂了', '晚饭吃火锅还是烧烤', '周末去看演唱会吗', '终于下班了好开心'];
  const recs = [];
  for (const t of texts) recs.push(await say('chatDraft', t, 2));
  assert.equal(calls.length, 4);
  assert.equal(spoken.length, 0, 'she never spoke');
  assert.deepEqual(recs.map((r) => [r.stage, r.reason, r.verdict]), [['error', 'error', 'silent'], ['error', 'timeout', 'silent'], ['decided', 'refused', 'skip'], ['decided', 'invalid', 'skip']]);
  assert.ok(!JSON.stringify(it.listDecisions()).includes('TypeSafe'), 'provider error text is not stored');
});

test('debounce: typing keeps resetting the timer; only the latest draft is judged, once', async () => {
  const scheduled = [];
  const cleared = [];
  const { it, calls } = rig();
  it.timers = { setTimeout: (fn, ms) => { const h = { fn, ms }; scheduled.push(h); return h; }, clearTimeout: (h) => cleared.push(h) };
  it.input('chatDraft', '终于');
  it.input('chatDraft', '终于把这个');
  it.input('chatDraft', '终于把这个 bug 修好了');
  assert.equal(scheduled.length, 3);
  assert.equal(cleared.length, 2, 'each keystroke cancels the previous timer');
  assert.equal(scheduled[2].ms, 4000);
  assert.equal(it.inputs.length, 1, 'a draft replaces the previous draft');
  await scheduled[2].fn();
  await it.evaluating;
  assert.equal(calls.length, 1);
  assert.match(calls[0].state, /终于把这个 bug 修好了/);
});

test('the owner sending the message drops the pending draft and aborts a decision in flight', async () => {
  let release;
  const { it, spoken } = rig({ answers: [(req) => new Promise((resolve, reject) => { req.signal.addEventListener('abort', () => reject(Object.assign(new Error('Canceled'), { code: 'ECANCELED' }))); release = resolve; })] });
  it.input('chatDraft', '帮我看看这个周报怎么写');
  const p = it.flush();
  await new Promise((r) => setImmediate(r));
  it.userChatted('帮我看看这个周报怎么写');
  const rec = await p;
  assert.equal(rec.reason, 'aborted');
  assert.equal(rec.verdict, 'silent');
  assert.equal(spoken.length, 0);
  assert.equal(typeof release, 'function');
});

test('full chain (mock decide): judge → speak / stay quiet → 别打扰 → block rule → that kind is never asked about again', async () => {
  const { it, calls, spoken, say } = rig({ cfg: ON({ cooldownMin: 1 }), answers: [0.86, 0.2, 0.9] });
  // 1. judged yes (0.86 ≥ 0.7) → she says one short line
  const r1 = await say('chatDraft', '终于把这个 bug 修好了！累死我了');
  assert.equal(r1.verdict, 'interject');
  assert.equal(r1.probability, 0.86);
  assert.equal(r1.category, 'code');
  assert.equal(r1.said, '嘿嘿，修好啦？辛苦啦～');
  assert.equal(spoken.length, 1);
  assert.match(calls[0].state, /终于把这个 bug 修好了/);
  assert.equal(calls[0].model, 'lobehub/jev-1.14.0');
  assert.equal(calls[0].timeoutMs, 10000);
  // 2. judged no (0.2 ≤ 0.3) → silence
  const r2 = await say('voice', '明天上午十点开会别忘了', 2);
  assert.equal(r2.verdict, 'skip');
  assert.equal(r2.reason, 'confident-no');
  assert.equal(spoken.length, 1);
  // 3. the owner answers her remark with 别打扰 → feedback mute → block rule on 写代码
  const fb = it.userChatted('别打扰我，在写代码');
  assert.equal(fb.decision.feedback, 'mute');
  assert.equal(fb.rule.effect, 'block');
  assert.equal(fb.rule.category, 'code');
  assert.equal(fb.rule.note, '别插嘴：写代码 / 技术');
  assert.deepEqual(it.listRules().map((r) => r.id), [fb.rule.id]);
  // 4. the rule takes effect: the next code input is dropped locally, no decision call
  const before = calls.length;
  const r3 = await say('chatDraft', 'npm test 又报错了，什么鬼', 5);
  assert.equal(r3.stage, 'prefilter');
  assert.equal(r3.reason, 'rule');
  assert.deepEqual(r3.ruleIds, [fb.rule.id]);
  assert.equal(calls.length, before, 'zero decision calls for a blocked kind');
  assert.equal(it.listRules()[0].hits, 1);
  // 5. other kinds are still judged, and the rule is in the state and the criteria the model sees
  const r4 = await say('chatDraft', '晚饭想吃火锅了', 5);
  assert.equal(r4.verdict, 'interject');
  assert.match(calls[calls.length - 1].state, /别插嘴：写代码 \/ 技术/);
  assert.match(calls[calls.length - 1].questions.interject.criteria.false, /写代码 \/ 技术/);
  // 6. deleting the rule (the UI's 删除) lets that kind be judged again
  assert.deepEqual(it.deleteRule(fb.rule.id), { ok: true });
  assert.equal(it.deleteRule(fb.rule.id).reason, 'not-found');
  const r5 = await say('chatDraft', 'git push 被拒绝了，冲突好多', 5);
  assert.equal(r5.stage, 'decided');
});

test('👍 creates an allow rule: an uncertain answer (between the thresholds) is then enough for that kind', async () => {
  const { it, spoken, say } = rig({ cfg: ON({ cooldownMin: 1 }), answers: [0.8, 0.55, 0.55] });
  const r1 = await say('chatDraft', '奶茶店今天买一送一');
  assert.equal(r1.category, 'food');
  const fb = it.feedback(r1.id, 'like');
  assert.equal(fb.rule.effect, 'allow');
  assert.equal(fb.rule.category, 'food');
  const r2 = await say('chatDraft', '中午吃什么好纠结', 3);
  assert.equal(r2.verdict, 'interject');
  assert.equal(r2.reason, 'uncertain-allowed');
  assert.deepEqual(r2.ruleIds, [fb.rule.id]);
  const r3 = await say('chatDraft', '这部电影的结局有点意外', 3);
  assert.equal(r3.verdict, 'skip', 'without an allow rule the uncertain band stays quiet');
  assert.equal(r3.reason, 'uncertain');
  assert.equal(spoken.length, 2);
});

test('implicit feedback: three ignored remarks of one kind block it; two answered ones allow it', async () => {
  const { it, say, clock } = rig({ cfg: ON({ cooldownMin: 1, maxPerHour: 20 }) });
  for (const t of ['周报写完了好累', '老板又改需求了', '客户的邮件还没回']) {
    const r = await say('chatDraft', t, 2);
    assert.equal(r.verdict, 'interject');
    clock.t += 11 * MIN; // nobody reacted for over 10 minutes
    const fb = it.tick();
    assert.equal(fb.decision.feedback, 'ignored');
  }
  const rules = it.listRules();
  assert.equal(rules.length, 1);
  assert.deepEqual([rules[0].effect, rules[0].category, rules[0].origin], ['block', 'work', 'ignored']);
  for (const t of ['周末去爬山吗', '新出的游戏好好玩']) {
    const r = await say('chatDraft', t, 2);
    assert.equal(r.category, 'play');
    clock.t += MIN;
    assert.equal(it.userChatted('哈哈是啊').decision.feedback, 'engaged');
  }
  const allow = it.listRules().find((r) => r.effect === 'allow');
  assert.deepEqual([allow.category, allow.origin], ['play', 'engaged']);
  // an explicit 🙊 later replaces the allow with a block on the same scope
  const last = it.listDecisions().filter((d) => d.said).pop();
  const fb = it.feedback(last.id, 'mute');
  assert.equal(fb.rule.effect, 'block');
  assert.equal(it.listRules().filter((r) => r.category === 'play').length, 1);
});

test('cooldown and the hourly cap count real remarks; uncategorised text is scoped by source and time of day', async () => {
  const { it, calls, say } = rig({ cfg: ON({ cooldownMin: 10, maxPerHour: 2 }) });
  await say('api', 'running the nightly backup job now');
  assert.equal((await say('api', 'backup finished in 12 minutes', 3)).reason, 'cooldown');
  await say('api', 'disk cleanup started on volume two', 10);
  assert.equal((await say('api', 'disk cleanup finished, all good', 11)).reason, 'hourly-cap');
  assert.equal(calls.length, 2);
  const d = it.listDecisions().find((x) => x.said);
  assert.equal(d.category, 'other');
  const fb = it.feedback(d.id, 'mute');
  assert.deepEqual([fb.rule.source, fb.rule.bucket, fb.rule.category], ['api', 'afternoon', undefined]);
});

test('records persist (interject.json) and keep no clipboard text; rules survive a restart and can be listed and deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'interject-'));
  const store = new ij.InterjectStore(dir);
  const a = rig({ cfg: ON({ sources: { clipboard: true }, cooldownMin: 1 }), store });
  const r = await a.say('clipboard', '今天心情好差，什么都不想干');
  assert.equal(r.summary, '[clipboard 13 字]');
  const file = fs.readFileSync(path.join(dir, 'interject.json'), 'utf8');
  assert.ok(!file.includes('心情好差'), 'the clipboard text is not on disk');
  a.it.feedback(r.id, 'mute');
  const b = rig({ store: new ij.InterjectStore(dir) });
  const rules = b.it.listRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].category, 'mood');
  assert.equal(b.it.listDecisions()[0].feedback, 'mute');
  assert.equal(b.it.status().lastInterjectAt, r.at, 'the cooldown survives a restart');
  assert.equal(b.it.addRule({ effect: 'allow', bucket: 'evening' }).rule.note, '可以插嘴：晚上（18–23 点）');
  assert.equal(b.it.addRule({ effect: 'block' }).ok, false, 'a rule must name something to match');
  assert.deepEqual(b.it.deleteRule(rules[0].id), { ok: true });
  assert.equal(new ij.InterjectStore(dir).load().rules.length, 1);
});

test('chat-draft summaries are clipped; sensitive text never reaches the model', async () => {
  const { calls, say } = rig();
  const r = await say('chatDraft', '这是一段很长很长的草稿，主人正在认真地写给朋友的一封信，内容很多很多很多');
  assert.ok([...r.summary].length <= ij.LIMITS.summaryChars + 1);
  const s = await say('chatDraft', '验证码 834211 别告诉别人', 20);
  assert.equal(s.reason, 'sensitive');
  assert.equal(s.summary, '[敏感内容已略去]');
  assert.equal(calls.length, 1);
});

// ---- lh decide() with the fake CLI --------------------------------------------------------------------------------
function fakeLh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lhdecide-'));
  return { dir, lh: new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } }) };
}

test('lh decide(): `generate decide -m … -q … --state-file`, the state file is removed, the answer parsed', async () => {
  const { dir, lh } = fakeLh();
  const res = await lh.decide({ model: 'lobehub/jev-1.14.0', questions: ij.buildQuestions([]), state: '-starts with a dash\n[最近的输入] 终于修好了' });
  assert.deepEqual(res.answers, { interject: { probability: 0.85, type: 'boolean' } });
  const call = JSON.parse(fs.readFileSync(path.join(dir, 'decide-calls.jsonl'), 'utf8').trim());
  assert.equal(call.model, 'lobehub/jev-1.14.0');
  assert.equal(call.state, '-starts with a dash\n[最近的输入] 终于修好了');
  const log = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args);
  const args = log.find((a) => a[1] === 'decide');
  const stateFile = args[args.indexOf('--state-file') + 1];
  assert.equal(fs.existsSync(stateFile), false, 'temporary state file deleted');
  assert.ok(!args.some((a) => a.includes('终于修好了')), 'the owner\'s text is not on the command line');
});

test('lh decide(): exit 1, garbage output and a hang all reject (timeout = ETIMEDOUT); abort stops it', async () => {
  const { dir, lh } = fakeLh();
  const q = ij.buildQuestions([]);
  fs.writeFileSync(path.join(dir, 'decide.json'), JSON.stringify({ mode: 'fail' }));
  await assert.rejects(lh.decide({ model: 'lobehub/jev-1.14.0', questions: q, state: 'x' }), /TypeSafe provider is not configured/);
  fs.writeFileSync(path.join(dir, 'decide.json'), JSON.stringify({ mode: 'garbage' }));
  await assert.rejects(lh.decide({ model: 'lobehub/jev-1.14.0', questions: q, state: 'x' }), (e) => e.code === 'ENOPARSE');
  fs.writeFileSync(path.join(dir, 'decide.json'), JSON.stringify({ mode: 'hang' }));
  await assert.rejects(lh.decide({ model: 'lobehub/jev-1.14.0', questions: q, state: 'x', timeoutMs: 800 }), (e) => e.code === 'ETIMEDOUT');
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(lh.decide({ model: 'lobehub/jev-1.14.0', questions: q, state: 'x', signal: ac.signal, timeoutMs: 10000 }), (e) => e.code === 'ECANCELED');
  assert.equal(parseDecision('12:00 [INFO] x\n{"answers":{"interject":{"type":"boolean","probability":0.4}}}').answers.interject.probability, 0.4);
});

// ---- PetService / local API wiring ----------------------------------------------------------------------------------
async function petSetup(interject = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petij-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: T0 };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const settingsStore = new settingsLib.MemorySettingsStore({ ageGateVersion: 2, answered: true, ...(interject ? { interject } : {}) });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), settingsStore, now: () => clock.t, rnd: () => 0.5, timers: { setTimeout: () => ({}), clearTimeout: () => {} } });
  svc.on('error', () => {});
  const said = [];
  svc.on('say', (m) => said.push(m));
  await svc.hatch({ speciesId: 'claude', name: '小芽' });
  clock.t += 30 * MIN; // past her greeting
  const decideCalls = () => (fs.existsSync(path.join(dir, 'decide-calls.jsonl')) ? fs.readFileSync(path.join(dir, 'decide-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0);
  return { dir, clock, lh, svc, said, decideCalls };
}

test('PetService, switched off (default): chat, voice and API input never reach `lh generate decide`', async () => {
  const { svc, decideCalls, said } = await petSetup();
  assert.equal(svc.settings.interject.enabled, false);
  assert.equal(svc.interjectInput('chatDraft', '终于把这个 bug 修好了').reason, 'disabled');
  assert.equal(svc.interjectInput('api', '终于把这个 bug 修好了').reason, 'disabled');
  await svc.chat('你好呀');
  await svc.interjector.flush();
  await svc.heartbeat();
  assert.equal(decideCalls(), 0);
  assert.equal(said.filter((m) => m.kind === 'interject').length, 0);
});

test('PetService, switched on: the fake jev says yes → one short remark in the bubble (kind interject), recorded', async () => {
  const { svc, dir, said, decideCalls } = await petSetup({ enabled: true });
  const events = [];
  svc.on('interject', (e) => events.push(e.type));
  assert.equal(svc.interjectInput('chatDraft', '终于把这个 bug 修好了！累死我了').accepted, true);
  const rec = await svc.interjector.flush();
  assert.equal(decideCalls(), 1);
  assert.equal(rec.verdict, 'interject');
  const line = said.find((m) => m.kind === 'interject');
  assert.ok(line && line.text, 'she said something');
  assert.equal(line.source, 'llm');
  assert.ok(line.text.startsWith(rec.said.replace(/…$/, '')), 'the record keeps the start of her line');
  const run = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args).filter((a) => a[0] === 'agent' && a[1] === 'run').pop();
  assert.match(run[run.indexOf('-p') + 1], /\[插嘴\] 主人刚才在聊天框里正在打的字（还没发给她）里写\/说了：「终于把这个 bug 修好了！累死我了」/);
  assert.deepEqual(events, ['said', 'decision']);
  // 别打扰 in her chat box right after → a block rule, visible through the rules interface
  await svc.chat('别打扰我，正写代码呢');
  const { rules } = svc.interjectRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].category, 'code');
  assert.equal(svc.interjectDecisions().decisions.pop().feedback, 'mute');
  assert.deepEqual(svc.interjectDeleteRule(rules[0].id), { ok: true });
});

test('PetService: voice transcripts are a source; a low probability is silence; setSection keeps the other sources', async () => {
  const { svc, dir, said, decideCalls } = await petSetup({ enabled: true });
  fs.writeFileSync(path.join(dir, 'decide.json'), JSON.stringify({ probability: 0.12 }));
  svc.asr = { transcribe: async () => ({ ok: true, text: '提醒我明天早上九点交报告', provider: 'lobehub' }), status: () => null };
  await svc.asrTranscribe(Buffer.from('x'), 'audio/webm', { ms: 1000 });
  const rec = await svc.interjector.flush();
  assert.equal(decideCalls(), 1);
  assert.equal(rec.source, 'voice');
  assert.equal(rec.verdict, 'skip');
  assert.equal(said.filter((m) => m.kind === 'interject').length, 0);
  svc.setSection('interject', { sources: { clipboard: true } });
  assert.deepEqual(svc.settings.interject.sources, { chatDraft: true, voice: true, api: true, clipboard: true });
  svc.interjectInput('chatDraft', '还在等的一段草稿内容');
  svc.setSection('interject', { enabled: false });
  assert.equal(svc.interjector.inputs.length, 0, 'switching off drops what was waiting');
  assert.equal(await svc.interjector.flush(), null);
  assert.equal(decideCalls(), 1);
});

test('local API: POST /pixel-pet/observe hands the text to 插个嘴 and does not reply', async () => {
  const seen = [];
  const ctx = { token: 't'.repeat(32), observe: (text) => { seen.push(text); return seen.length === 1 ? { accepted: true } : { accepted: false, reason: 'disabled' }; } };
  const req = (body) => ({ method: 'POST', path: '/pixel-pet/observe', headers: { host: '127.0.0.1:7340', authorization: `Bearer ${'t'.repeat(32)}` }, body });
  assert.deepEqual(await api.handle(req({ text: '  build failed on main  ' }), ctx), { status: 202, json: { ok: true, accepted: true } });
  assert.deepEqual(await api.handle(req({ text: 'again' }), ctx), { status: 200, json: { ok: true, accepted: false, reason: 'disabled' } });
  assert.equal((await api.handle(req({ text: '' }), ctx)).status, 400);
  assert.deepEqual(seen, ['build failed on main', 'again']);
  assert.ok(api.ROUTES.some(([m, r]) => m === 'POST' && r === '/observe'));
});
