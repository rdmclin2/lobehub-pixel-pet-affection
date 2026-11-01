'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const { ChatLog, MemoryChatLog, userSessions, originOfKind, SESSION_GAP_MS } = require('../src/core/chat-log');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const MIN = 60 * 1000;
const T0 = new Date('2026-01-05T08:00:00').getTime();

function setup(now = T0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: now };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const log = new ChatLog(path.join(dir, 'data'));
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), log, now: () => clock.t, rnd: () => 0.5 });
  svc.on('error', () => {});
  const said = [];
  svc.on('say', (m) => said.push(m));
  return { dir, clock, lh, svc, said, log };
}

// ---- the pure filter -------------------------------------------------------------------------
const msg = (id, at, role, origin, turnId, text, speciesId = 'claude', extra = {}) => ({ id, at, role, origin, turnId, text, speciesId, kind: 'x', ...extra });

test('originOfKind: every kind PetService says gets its origin; nothing unknown falls into user', () => {
  assert.equal(originOfKind('met'), 'greeting');
  assert.equal(originOfKind('switch'), 'greeting');
  assert.equal(originOfKind('greet_morning'), 'greeting');
  assert.equal(originOfKind('greet_evening'), 'greeting');
  assert.equal(originOfKind('hungry'), 'proactive');
  assert.equal(originOfKind('bored'), 'proactive');
  assert.equal(originOfKind('missed'), 'proactive');
  assert.equal(originOfKind('stage_up'), 'emotion');
  assert.equal(originOfKind('touch:head'), 'touch');
  assert.equal(originOfKind('feed'), 'care');
  assert.equal(originOfKind('sleep'), 'care');
  assert.equal(originOfKind('topic:food'), 'topic');
  assert.equal(originOfKind('api'), 'api');
  assert.equal(originOfKind('woke'), 'system');
  assert.equal(originOfKind('chat'), 'system', 'a chat reply is only "user" through its round, never by kind');
  assert.equal(originOfKind('whatever'), 'system');
});

test('userSessions keeps only rounds the owner started: greetings, proactive, emotion, touch, care, topic, api and legacy lines are dropped', () => {
  const t = T0;
  const messages = [
    msg('m1', t, 'pet', 'greeting', 's1', 'echo: [事件] 早上好'),
    msg('m2', t + 1 * MIN, 'pet', 'proactive', 's2', 'echo: [事件] 肚子饿了'),
    msg('m3', t + 2 * MIN, 'user', 'user', 't1', '早呀，今天吃什么？'),
    msg('m4', t + 2 * MIN + 1000, 'pet', 'user', 't1', 'echo: 早呀，今天吃什么？'),
    msg('m5', t + 3 * MIN, 'pet', 'emotion', 's3', 'echo: [事件] 关系升级'),
    msg('m6', t + 4 * MIN, 'pet', 'touch', 's4', '诶，别戳脸！'),
    msg('m7', t + 5 * MIN, 'pet', 'care', 's5', '好吃！'),
    msg('m8', t + 6 * MIN, 'user', 'topic', 't2', '[话题] 最喜欢的食物'),
    msg('m9', t + 6 * MIN + 1000, 'pet', 'topic', 't2', 'echo: [话题] 最喜欢的食物'),
    msg('m10', t + 7 * MIN, 'user', 'api', 't3', '外部脚本发来的'),
    msg('m11', t + 7 * MIN + 1000, 'pet', 'api', 't3', 'echo: 外部脚本发来的'),
    { id: 'm12', at: t + 8 * MIN, role: 'user', turnId: 'old', text: '没有来源字段的旧记录', speciesId: 'claude' },
    msg('m13', t + 9 * MIN, 'pet', 'user', 'forged', '自称 user 但没有主人那句'),
    msg('m14', t + 10 * MIN, 'user', 'user', 't4', '那就吃饭团吧'),
    msg('m15', t + 10 * MIN + 1000, 'pet', 'user', 't4', 'echo: 那就吃饭团吧'),
  ];
  const r = userSessions(messages);
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.deepEqual(s.messages.map((m) => m.id), ['m3', 'm4', 'm14', 'm15']);
  assert.equal(s.preview, '早呀，今天吃什么？');
  assert.equal(s.count, 4);
  assert.equal(s.userCount, 2);
  assert.equal(s.startedAt, t + 2 * MIN);
  assert.ok(s.messages.every((m) => !/\[事件\]|\[话题\]/.test(m.text)));
  assert.deepEqual(r.hidden, { greeting: 1, proactive: 1, emotion: 1, touch: 1, care: 1, topic: 2, api: 2, unknown: 1, user: 1 });
  assert.equal(r.total, 15);
});

test('userSessions: a pause over 30 minutes or another character starts a new conversation; newest first', () => {
  const t = T0;
  const r = userSessions([
    msg('a1', t, 'user', 'user', 'ta', '第一句'),
    msg('a2', t + 1000, 'pet', 'user', 'ta', 'echo: 第一句'),
    msg('b1', t + 1000 + SESSION_GAP_MS + 1, 'user', 'user', 'tb', '过了很久'),
    msg('b2', t + 2000 + SESSION_GAP_MS + 1, 'pet', 'user', 'tb', 'echo: 过了很久'),
    msg('c1', t + 3000 + SESSION_GAP_MS + 1, 'user', 'user', 'tc', '换了个角色', 'gpt'),
  ]);
  assert.deepEqual(r.sessions.map((s) => [s.id, s.speciesId, s.count]), [['c1', 'gpt', 1], ['b1', 'claude', 2], ['a1', 'claude', 2]]);
});

test('userSessions: the owner replying to a proactive line counts from her own message; the system opener never does', () => {
  const t = T0;
  const r = userSessions([
    msg('p1', t, 'pet', 'proactive', 'sp', '主人……我好饿'),
    msg('u1', t + MIN, 'user', 'user', 'tu', '那给你喂点吃的'),
    msg('u2', t + MIN + 1000, 'pet', 'user', 'tu', 'echo: 那给你喂点吃的'),
    msg('p2', t + 2 * MIN, 'pet', 'proactive', 'sq', '她又自己说了一句'),
  ]);
  assert.equal(r.sessions.length, 1);
  assert.deepEqual(r.sessions[0].messages.map((m) => m.id), ['u1', 'u2']);
  assert.equal(r.sessions[0].preview, '那给你喂点吃的');
});

test('userSessions: with no owner message there is nothing to show, and bad records are skipped', () => {
  const r = userSessions([null, 42, { role: 'pet' }, msg('g', T0, 'pet', 'greeting', 's', '你好')]);
  assert.deepEqual(r.sessions, []);
  assert.deepEqual(userSessions(undefined).sessions, []);
});

// ---- storage ---------------------------------------------------------------------------------
test('ChatLog persists to chat-log.json and reads an old bare array (no origin) as hidden legacy data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-file-'));
  const a = new ChatLog(dir);
  a.append({ speciesId: 'claude', role: 'user', origin: 'user', turnId: 't1', text: '你好' }, T0);
  const b = new ChatLog(dir);
  assert.equal(b.list().length, 1);
  assert.equal(b.list()[0].id, 'm1');
  assert.equal(b.append({ speciesId: 'claude', role: 'pet', origin: 'user', turnId: 't1', text: 'echo: 你好' }, T0 + 1).id, 'm2');

  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-old-'));
  fs.writeFileSync(path.join(old, 'chat-log.json'), JSON.stringify([{ id: 'x1', at: T0, role: 'user', text: '旧版本的消息', turnId: 'o1', speciesId: 'claude' }, { id: 'x2', at: T0 + 1, role: 'pet', text: '旧回复', turnId: 'o1', speciesId: 'claude' }]));
  const legacy = new ChatLog(old);
  const r = userSessions(legacy.list());
  assert.deepEqual(r.sessions, []);
  assert.deepEqual(r.hidden, { unknown: 2 });

  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'chatlog-broken-'));
  fs.writeFileSync(path.join(broken, 'chat-log.json'), '{not json');
  assert.deepEqual(new ChatLog(broken).list(), []);
  assert.ok(fs.existsSync(path.join(broken, 'chat-log.broken.json')), 'the unreadable file is set aside, not overwritten');
});

test('MemoryChatLog keeps at most MAX_MESSAGES, dropping the oldest', () => {
  const { MAX_MESSAGES } = require('../src/core/chat-log');
  const l = new MemoryChatLog();
  for (let i = 0; i < MAX_MESSAGES + 5; i++) l.append({ role: 'user', origin: 'user', turnId: `t${i}`, text: String(i) }, i);
  assert.equal(l.list().length, MAX_MESSAGES);
  assert.equal(l.list()[0].text, '5');
});

// ---- every entry point in PetService writes its origin; history() returns only the owner's ----------
test('PetService: greeting, morning greeting, proactive, emotion, touch, care, topic, api and wake lines are logged with their origin; history() returns only the chat-box conversation', async () => {
  const { svc, clock, said, log, dir } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' }); // met → greeting
  clock.t += 13 * MIN;
  await svc.heartbeat(); // 08:13, not greeted today → greet_morning
  clock.t += 13 * MIN;
  svc.debugSet({ hunger: 90 });
  await svc.heartbeat(); // hungry → proactive
  svc.touch('head'); // touch
  svc.act('feed', 'rice'); // care
  svc.sayExternal('外部脚本让她说的'); // api
  await svc.chat('外部接口发来的聊天', [], [], { origin: 'api' }); // api chat
  svc.debugSet({ affection: 20 }); // crosses 15 → stage_up (emotion), spoken on setImmediate
  await new Promise((r) => setImmediate(r));
  while (svc.busy) await new Promise((r) => setTimeout(r, 20));
  const topic = svc.view().topics.find((x) => x.unlocked);
  await svc.talkTopic(topic.id); // topic
  svc.debugSet({ sleeping: true, energy: 100 });
  clock.t += 1 * MIN;
  await svc.heartbeat(); // woke → system
  clock.t += 2 * MIN;
  const r = await svc.chat('早上好呀，今天想做什么？'); // the owner, from the chat box
  assert.equal(r.ok, true);

  const all = log.list();
  const origins = all.map((m) => `${m.role}:${m.origin}:${m.kind}`);
  for (const want of ['pet:greeting:met', 'pet:greeting:greet_morning', 'pet:proactive:hungry', 'pet:touch:touch:head', 'pet:care:feed', 'pet:api:api', 'user:api:chat', 'pet:api:chat', 'pet:emotion:stage_up', `user:topic:topic:${topic.id}`, `pet:topic:topic:${topic.id}`, 'pet:system:woke', 'user:user:chat', 'pet:user:chat']) {
    assert.ok(origins.includes(want), `${want} logged (got ${origins.join(', ')})`);
  }
  assert.equal(all.filter((m) => m.origin === 'user').length, 2, 'only the chat-box round is origin user');
  // the bubble event carries the origin as well
  assert.equal(said.find((m) => m.kind === 'hungry').origin, 'proactive');
  assert.equal(said.filter((m) => m.kind === 'chat').map((m) => m.origin).join(), 'api,user');

  const h = svc.history();
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].preview, '早上好呀，今天想做什么？');
  assert.equal(h.sessions[0].count, 2);
  assert.equal(h.sessions[0].name, '小克');
  assert.equal(h.sessions[0].messages, undefined, 'the list carries summaries only');
  assert.ok(h.hidden.greeting >= 2 && h.hidden.proactive >= 1 && h.hidden.emotion >= 1 && h.hidden.touch >= 1 && h.hidden.care >= 1 && h.hidden.api >= 3 && h.hidden.topic >= 2 && h.hidden.system >= 1, JSON.stringify(h.hidden));

  const d = svc.historySession(h.sessions[0].id);
  assert.equal(d.ok, true);
  assert.deepEqual(d.session.messages.map((m) => [m.role, m.text]), [['user', '早上好呀，今天想做什么？'], ['pet', 'echo: 早上好呀，今天想做什么？']]);
  assert.deepEqual(svc.historySession('nope'), { ok: false, reason: 'not-found' });

  // survives a restart: the file is read back by a new service
  const svc2 = new PetService({ lh: svc.lh, store: new Store(path.join(dir, 'data')), log: new ChatLog(path.join(dir, 'data')), now: () => clock.t });
  svc2.init();
  assert.deepEqual(svc2.history().sessions.map((s) => s.preview), ['早上好呀，今天想做什么？']);
});

test('PetService: a message that got no reply (error) is kept with the note, still as the owner\'s conversation', async () => {
  const { svc, dir } = setup();
  await svc.hatch({ speciesId: 'claude' });
  fs.writeFileSync(path.join(dir, 'fail-run'), '1');
  const r = await svc.chat('这句会失败');
  fs.rmSync(path.join(dir, 'fail-run'), { force: true });
  assert.equal(r.ok, false);
  const h = svc.history();
  assert.equal(h.sessions.length, 1);
  const d = svc.historySession(h.sessions[0].id).session;
  assert.deepEqual(d.messages.map((m) => [m.role, m.text, m.status || null]), [['user', '这句会失败', null], ['pet', '', 'error']]);
});

test('PetService: pictures and dropped files are noted on the owner\'s message; release clears the history', async () => {
  const { svc, dir } = setup();
  await svc.hatch({ speciesId: 'claude' });
  const img = path.join(dir, 'a.png');
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await svc.chat('看这张图', [img]);
  const s = svc.historySession(svc.history().sessions[0].id).session;
  assert.deepEqual(s.messages[0].attachments, { images: 1, files: [] });
  await svc.release();
  assert.deepEqual(svc.history().sessions, []);
  assert.equal(svc.log.list().length, 0);
});

test('PetService: the owner answering her proactive line is listed from the owner\'s message on', async () => {
  const { svc, clock } = setup(new Date('2026-01-05T14:00:00').getTime());
  await svc.hatch({ speciesId: 'claude' });
  clock.t += 13 * MIN;
  svc.debugSet({ hunger: 90 });
  await svc.heartbeat();
  assert.equal(svc.log.list().at(-1).origin, 'proactive');
  clock.t += MIN;
  await svc.chat('好啦好啦，给你吃');
  const h = svc.history();
  assert.equal(h.sessions.length, 1);
  const d = svc.historySession(h.sessions[0].id).session;
  assert.equal(d.messages[0].role, 'user');
  assert.equal(d.messages[0].text, '好啦好啦，给你吃');
  assert.ok(d.messages.every((m) => !/\[事件\]/.test(m.text)));
});

test('userSessions: 重新开始话题 (a new topicEpoch) starts a new conversation even within the gap; old records without it count as epoch 0', () => {
  const T = 1_000_000;
  const msgs = [
    { id: 'm1', at: T, speciesId: 'claude', role: 'user', origin: 'user', turnId: 't1', text: '旧话题' },
    { id: 'm2', at: T + 1, speciesId: 'claude', role: 'pet', origin: 'user', turnId: 't1', text: '回复1' },
    { id: 'm3', at: T + 60000, speciesId: 'claude', role: 'user', origin: 'user', turnId: 't2', text: '还是旧话题', topicEpoch: 0 },
    { id: 'm4', at: T + 120000, speciesId: 'claude', role: 'user', origin: 'user', turnId: 't3', text: '新话题', topicEpoch: 1 },
    { id: 'm5', at: T + 120001, speciesId: 'claude', role: 'pet', origin: 'user', turnId: 't3', text: '回复3', topicEpoch: 1 },
  ];
  const r = userSessions(msgs);
  assert.deepEqual(r.sessions.map((x) => [x.preview, x.count]), [['新话题', 2], ['旧话题', 3]]);
});
