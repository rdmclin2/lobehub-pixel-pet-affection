'use strict';

// 设置窗口 → 聊天 (src/core/admin-chat.js, PetService#chatAs, docs/admin-chat.md): one conversation per
// character through her own agent and topic, shared with the desktop's 聊天记录; the 4-hour context window and
// the recall of older rounds; pictures; the bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AC = require('../src/core/admin-chat');
const { readImage, sniffImage, MAX_IMAGE_BYTES } = AC;
const { ResponsesClient } = require('../src/core/responses-client');
const { startFakeResponses } = require('./fixtures/fake-responses-server');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const chatLog = require('../src/core/chat-log');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adminchat-'));
// the smallest real files of each type (sniffed by their first bytes)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(12)]);
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

function fakeLh() {
  const calls = [];
  let n = 0;
  return {
    calls,
    workspaceId: null,
    createAgent: async (a) => { calls.push(['createAgent', a.title]); return { agentId: `agt_chat${++n}` }; },
    updateAgent: async (a) => { calls.push(['updateAgent', a.agentId, a.provider, a.model]); },
    uploadFile: async (p) => { calls.push(['uploadFile', path.basename(p)]); return `file_${++n}`; },
    createTopic: async (agentId) => { calls.push(['createTopic', agentId]); return `tpc_img${++n}`; },
    createUserMessage: async (m) => { calls.push(['createUserMessage', m.topicId]); return `msg_${++n}`; },
    addFilesToMessage: async (mid, ids) => { calls.push(['addFilesToMessage', mid, ids.join(',')]); },
  };
}

// ---- pictures ---
test('readImage: png / jpg / webp / gif by their bytes, from a path or a data URL; other types, lies and >10 MB refused', () => {
  const dir = tmp();
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPG), 'image/jpeg');
  assert.equal(sniffImage(GIF), 'image/gif');
  assert.equal(sniffImage(WEBP), 'image/webp');
  for (const [buf, ext, mime] of [[PNG, 'png', 'image/png'], [JPG, 'jpg', 'image/jpeg'], [GIF, 'gif', 'image/gif'], [WEBP, 'webp', 'image/webp']]) {
    const f = path.join(dir, `x.${ext}`);
    fs.writeFileSync(f, buf);
    const r = readImage({ path: f });
    assert.deepEqual([r.ok, r.mime, r.ext, r.name], [true, mime, ext, `x.${ext}`]);
    assert.equal(readImage(dataUrl(buf, mime)).mime, mime);
  }
  assert.equal(readImage(dataUrl(JPG, 'image/jpg')).mime, 'image/jpeg');
  // not an image, or a type outside the four
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  assert.equal(readImage({ path: path.join(dir, 'a.txt') }).reason, 'bad-type');
  assert.equal(readImage(dataUrl(Buffer.from('<svg/>'), 'image/svg+xml')).reason, 'bad-type');
  fs.writeFileSync(path.join(dir, 'fake.png'), 'not really a png at all');
  assert.equal(readImage({ path: path.join(dir, 'fake.png') }).reason, 'bad-type');
  assert.equal(readImage(dataUrl(PNG, 'image/gif')).reason, 'bad-type', 'declared gif, bytes say png');
  // size
  const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
  fs.writeFileSync(path.join(dir, 'big.png'), big);
  assert.equal(readImage({ path: path.join(dir, 'big.png') }).reason, 'too-large');
  assert.equal(readImage(dataUrl(big)).reason, 'too-large');
  assert.match(readImage(dataUrl(big)).message, /10 MB/);
  // paths
  assert.equal(readImage({ path: 'relative.png' }).reason, 'bad-input');
  assert.equal(readImage({ path: path.join(dir, 'missing.png') }).reason, 'not-found');
  assert.equal(readImage({ path: dir }).reason, 'not-found');
  assert.equal(readImage('data:image/png;base64,@@@').reason, 'bad-input');
  assert.equal(readImage(null).reason, 'bad-input');
});


const H = 60 * 60 * 1000;
const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
async function setup(now = new Date('2026-01-05T09:00:00').getTime()) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: now };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const log = new chatLog.MemoryChatLog();
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), now: () => clock.t, rnd: () => 0.5, log });
  svc.on('error', () => {});
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  const runs = () => (fs.existsSync(path.join(dir, 'runs.log')) ? fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').map(JSON.parse) : []);
  const calls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse).map((c) => c.args);
  return { dir, clock, lh, svc, log, runs, calls };
}

// ---- one character, one conversation --------------------------------------------------------------------
test('chatAs talks through her own agent and topic, also when she is not the companion; the round lands in her 聊天记录', async () => {
  const { svc, runs, log } = await setup();
  const claude = svc.pet.characters.claude;
  await svc.switchCharacter('gpt');
  assert.equal(svc.pet.speciesId, 'gpt');
  const deltas = [];
  const r = await svc.chatAs('claude', { text: '今天好累' }, { onDelta: (d) => deltas.push(d) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.message.text, 'echo: 今天好累');
  const run = runs().pop();
  assert.equal(run.agent, claude.agentId, 'her agent, not the companion\'s');
  assert.equal(run.topic, claude.topicId, 'her topic: the same conversation as on the desktop');
  assert.deepEqual(run.tools, [], 'no local tools from the settings window');
  assert.match(run.prompt, /^\[状态\]/, 'her persona prompt (state block) as on the desktop');
  assert.ok(deltas.length >= 1 && deltas.at(-1).text === 'echo: 今天好累' && deltas.at(-1).speciesId === 'claude');
  // the shared history: in 聊天记录 (desktop) as an owner-started round of hers
  const s = svc.history().sessions[0];
  assert.equal(s.speciesId, 'claude');
  const msgs = log.list().filter((m) => m.turnId === r.turnId);
  assert.deepEqual(msgs.map((m) => [m.role, m.origin, m.via, m.speciesId]), [['user', 'user', 'console', 'claude'], ['pet', 'user', 'console', 'claude']]);
  assert.equal(svc.pet.speciesId, 'gpt', 'the companion stays');
});

test('her conversation joins desktop and settings-window rounds in time order; pages go back with `before`', async () => {
  const { svc, clock } = await setup();
  await svc.chat('桌面上说的');
  clock.t += 60000;
  await svc.chatAs('claude', { text: '设置窗口里说的' });
  const h = svc.chatHistory('claude');
  assert.equal(h.ok, true);
  assert.deepEqual(h.messages.map((m) => [m.role, m.via || 'desktop']), [['user', 'desktop'], ['pet', 'desktop'], ['user', 'console'], ['pet', 'console']]);
  assert.equal(h.messages[0].text, '桌面上说的');
  const views = h.messages.map((m) => AC.messageView(m, null, 'claude'));
  assert.deepEqual(views.map((v) => v.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(views.map((v) => v.via), ['desktop', 'desktop', 'console', 'console']);
  // no greetings / proactive lines: only the rounds the owner started
  assert.ok(!h.messages.some((m) => m.kind === 'met'));
  // pages
  for (let i = 0; i < 5; i++) {
    clock.t += 1000;
    await svc.chatAs('claude', { text: `第${i}句` });
  }
  const p1 = svc.chatHistory('claude', { limit: 4 });
  assert.equal(p1.messages.length, 4);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.messages.at(-1).text, 'echo: 第4句');
  const p2 = svc.chatHistory('claude', { before: p1.messages[0].id, limit: 100 });
  assert.equal(p2.hasMore, false);
  assert.equal(p2.messages.length, p1.total - 4);
  // the left column
  const list = svc.chatCharacters().characters;
  const c = list.find((x) => x.id === 'claude');
  assert.deepEqual([c.met, c.current, c.count, c.name], [true, true, p1.total, '小克']);
  assert.equal(c.preview, 'echo: 第4句');
  assert.equal(list.find((x) => x.id === 'grok').met, false);
});

test('refused: a character not met yet, an empty message, a turn already running', async () => {
  const { svc, lh } = await setup();
  assert.equal((await svc.chatAs('grok', { text: 'hi' })).reason, 'not-met');
  assert.equal((await svc.chatAs('nobody', { text: 'hi' })).reason, 'unknown-character');
  assert.equal((await svc.chatAs('claude', { text: '  ' })).reason, 'empty');
  lh.env.FAKE_LH_RUN_DELAY_MS = '300';
  const one = svc.chatAs('claude', { text: '一' });
  await new Promise((r) => setTimeout(r, 50));
  const two = await svc.chatAs('claude', { text: '二' });
  assert.equal(two.reason, 'busy');
  assert.equal((await svc.chat('桌面也等一下')).reason, 'busy', 'one turn at a time with the desktop too');
  assert.equal((await one).ok, true);
});

test('stop ends only the chat page\'s own turn and keeps the round with status canceled', async () => {
  const { svc, lh, log } = await setup();
  lh.env.FAKE_LH_RUN_DELAY_MS = '2000';
  const p = svc.chatAs('claude', { text: '说个长的' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(svc.chatAbort('gpt').aborted, false, 'another character: nothing to stop');
  assert.equal(svc.chatAbort('claude').aborted, true);
  const r = await p;
  assert.equal(r.reason, 'aborted');
  assert.equal(log.list().at(-1).status, 'canceled');
  assert.equal(AC.messageView(log.list().at(-1)).status, 'aborted');
  assert.equal(svc.busy, false);
});

test('a failed turn is kept as a failed reply with a readable error', async () => {
  const { svc, lh, log } = await setup();
  lh.env.FAKE_LH_FAIL_RUN = '1';
  const r = await svc.chatAs('claude', { text: '在吗' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
  assert.ok(r.userMessage && r.message);
  assert.equal(log.list().at(-1).status, 'error');
  assert.equal(AC.messageView(log.list().at(-1)).status, 'error');
});

// ---- the model: hers, among her vendor's, the same pick as her page → 模型 ---------------------------------
test('the model is her own pick (settings.models), applied to her agent before the turn; no vision → pictures refused', async () => {
  const { svc, calls, dir } = await setup();
  await svc.refreshModels({ force: true });
  const opts = svc.modelView('claude').options;
  assert.ok(opts.length >= 2, JSON.stringify(opts));
  assert.ok(opts.every((o) => /claude/i.test(o.id)), 'only her vendor');
  const other = opts.find((o) => o.key !== svc.modelView('claude').current);
  assert.equal(svc.setModel(other.key, 'claude').ok, true);
  await svc.switchCharacter('gpt');
  const r = await svc.chatAs('claude', { text: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.message.model, other.key, 'the reply records the model it ran on');
  const claudeId = svc.pet.characters.claude.agentId;
  const edit = calls().filter((a) => a[0] === 'agent' && a[1] === 'edit' && a[2] === claudeId && a.includes('-m')).pop();
  assert.equal(edit[edit.indexOf('-m') + 1], other.id, 'her agent runs on her pick');
  assert.equal(svc.pet.characters.claude.modelApplied, other.key);
  // a text-only pick refuses pictures before anything is kept
  svc._catalog = svc._catalog.map((m) => (m.id === other.id ? { ...m, abilities: { vision: false } } : m));
  const f = path.join(dir, 'p.png');
  fs.writeFileSync(f, PNG);
  const n = svc.log.list().length;
  const bad = await svc.chatAs('claude', { text: '看图', images: [{ path: f, ref: null }] });
  assert.equal(bad.reason, 'no-vision');
  assert.equal(svc.log.list().length, n);
});

// ---- pictures --------------------------------------------------------------------------------------------
test('pictures: saved by ChatImages, uploaded and attached to a message in her topic; her history shows them again', async () => {
  const { svc, calls, dir } = await setup();
  const images = new AC.ChatImages(path.join(dir, 'imgs'));
  await svc.refreshModels({ force: true });
  const seeing = svc.modelView('claude').options.find((o) => o.vision);
  assert.ok(seeing, 'a model of hers that can look at pictures');
  svc.setModel(seeing.key, 'claude');
  const saved = images.save('claude', [readImage(dataUrl(PNG))]);
  assert.match(saved[0].ref.file, /^att_[a-z0-9]+\.png$/);
  const r = await svc.chatAs('claude', { text: '这是什么颜色', images: saved });
  assert.equal(r.ok, true, JSON.stringify(r));
  const a = calls();
  assert.ok(a.some((x) => x[0] === 'file' && x[1] === 'upload' && x[3] === saved[0].path));
  const mc = a.find((x) => x[0] === 'message' && x[1] === 'create');
  assert.equal(mc[mc.indexOf('--topic-id') + 1], svc.pet.characters.claude.topicId);
  assert.ok(a.some((x) => x[0] === 'message' && x[1] === 'add-files'));
  const v = AC.messageView(svc.chatHistory('claude').messages.find((m) => m.role === 'user'), images, 'claude');
  assert.equal(v.attachments.length, 1);
  assert.equal(v.attachments[0].url, dataUrl(PNG));
  assert.equal(v.unsavedImages, 0);
  // a picture sent on the desktop: only its count was kept
  const d = AC.messageView({ id: 'm1', at: 1, role: 'user', text: '', attachments: { images: 2 } }, images, 'claude');
  assert.deepEqual([d.attachments.length, d.unsavedImages, d.via], [0, 2, 'desktop']);
  // refs outside her folder are never read
  assert.equal(images.dataUrl('claude', { file: '../x.png', mime: 'image/png' }), null);
  assert.equal(images.dataUrl('../etc', { file: saved[0].ref.file, mime: 'image/png' }), null);
});

// ---- context: 4 hours, older rounds on demand -------------------------------------------------------------
test('a topic that has run 4 hours is put aside: the next turn opens a fresh one carrying the last 4 hours', async () => {
  const { svc, clock, runs } = await setup();
  const c = svc.pet.characters.claude;
  await svc.chatAs('claude', { text: '早上说的：暗号是青柠42' });
  const first = c.topicId;
  clock.t += 3 * H;
  await svc.chatAs('claude', { text: '中午说的：今天吃面' });
  assert.equal(runs().at(-1).topic, first, 'within 4 hours: the same topic, nothing carried');
  assert.doesNotMatch(runs().at(-1).prompt, /最近 4 小时/);
  clock.t += 1.5 * H; // the topic began 4.5 h ago
  await svc.chatAs('claude', { text: '下午了' });
  const last = runs().at(-1);
  assert.notEqual(c.topicId, first, 'a fresh topic');
  assert.ok(c.pastTopicIds.includes(first), 'the old one is kept');
  assert.match(last.prompt, /【最近 4 小时的聊天/);
  assert.match(last.prompt, /今天吃面/, 'the rounds of the last 4 hours go with it');
  assert.doesNotMatch(last.prompt, /青柠42/, 'older ones do not');
});

test('a question about the past brings back the matching older rounds, once', async () => {
  const { svc, clock, runs } = await setup();
  await svc.chatAs('claude', { text: '记一下，我的暗号是青柠42' });
  clock.t += 2 * H;
  await svc.chatAs('claude', { text: '随便聊聊天气' });
  clock.t += 5 * H;
  await svc.chatAs('claude', { text: '你还记得我之前说的暗号吗' });
  let p = runs().at(-1).prompt;
  assert.match(p, /【更早的聊天记录摘录/);
  assert.match(p, /青柠42/);
  clock.t += 60000;
  await svc.chatAs('claude', { text: '好的谢谢' });
  p = runs().at(-1).prompt;
  assert.doesNotMatch(p, /更早的聊天记录/, 'not on an ordinary message');
});

test('重新开始话题 on the desktop is a clean start: nothing from before it is carried over', async () => {
  const { svc, clock, runs } = await setup();
  await svc.chatAs('claude', { text: '旧话题里的话' });
  clock.t += 60000;
  assert.equal(svc.newTopic().ok, true);
  await svc.chatAs('claude', { text: '新的开始' });
  assert.doesNotMatch(runs().at(-1).prompt, /旧话题里的话/);
});

test('重新开始对话 from the chat page (C04): any met character, not only the companion; unknown / not met are refused', async () => {
  const { svc, clock, runs } = await setup();
  await svc.chatAs('claude', { text: '克的旧话题' });
  const claude = svc.pet.characters.claude;
  const oldTopic = claude.topicId;
  assert.ok(oldTopic);
  await svc.switchCharacter('gpt');
  const companion = svc._c();
  const companionTopic = companion.topicId;
  const companionEpoch = companion.topicEpoch || 0;
  clock.t += 60000;
  const r = svc.newTopic('claude');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.previous, oldTopic);
  assert.equal(claude.topicId, null);
  assert.equal(claude.pastTopicIds.at(-1), oldTopic);
  assert.equal(claude.topicEpoch, 1);
  // the companion is untouched
  assert.equal(companion.topicId, companionTopic);
  assert.equal(companion.topicEpoch || 0, companionEpoch);
  await svc.chatAs('claude', { text: '新的开始' });
  assert.doesNotMatch(runs().at(-1).prompt, /克的旧话题/);
  assert.notEqual(runs().at(-1).topic, oldTopic);
  assert.deepEqual(svc.newTopic('grok'), { ok: false, reason: 'not-met' });
  assert.deepEqual(svc.newTopic('nobody'), { ok: false, reason: 'unknown-character' });
});

test('wantsRecall / pickRecall / recentRounds / historyPage', () => {
  assert.equal(AC.wantsRecall('你还记得吗'), true);
  assert.equal(AC.wantsRecall('上次那家店叫什么'), true);
  assert.equal(AC.wantsRecall('do you remember my cat'), true);
  assert.equal(AC.wantsRecall('今天天气不错'), false);
  const msgs = [];
  let t = 0;
  for (let i = 0; i < 30; i++) {
    msgs.push({ id: `u${i}`, at: (t += 1000), role: 'user', turnId: `t${i}`, text: i === 3 ? '我养了一只橘猫叫团子' : `闲聊${i}` });
    msgs.push({ id: `p${i}`, at: (t += 1000), role: 'pet', turnId: `t${i}`, text: `嗯${i}` });
  }
  const got = AC.pickRecall(msgs, '我之前说的那只橘猫叫什么', { maxRounds: 6 });
  assert.ok(got.some((m) => m.text.includes('团子')), 'the matching round');
  assert.ok(got.some((m) => m.id === 'u29'), 'and the latest ones');
  assert.ok(got.length <= 12);
  for (let i = 1; i < got.length; i++) assert.ok(got[i].at >= got[i - 1].at, 'in time order');
  assert.ok(AC.pickRecall(msgs, '之前', { maxChars: 30 }).length <= 4, 'within the budget');
  assert.deepEqual(AC.pickRecall([], '之前'), []);
  const recent = AC.recentRounds(msgs, t, { spanMs: 10000 });
  assert.ok(recent.length > 0 && recent[0].at >= t - 10000 - 1000, 'the rounds touching the span, nothing older');
  assert.equal(recent[0].role, 'user', 'whole rounds');
  const pg = AC.historyPage(msgs, { limit: 10 });
  assert.deepEqual([pg.messages.length, pg.hasMore, pg.messages.at(-1).id], [10, true, 'p29']);
  const pg2 = AC.historyPage(msgs, { before: 'u0' });
  assert.deepEqual([pg2.messages.length, pg2.hasMore], [0, false]);
  const body = AC.buildConsoleBody({ name: '小克', text: '你好', recent: msgs.slice(0, 2), images: 1 });
  assert.match(body, /\] 主人：闲聊0/);
  assert.match(body, /\] 小克：嗯0/);
  assert.match(body, /主人刚发来 1 张图片/);
  assert.equal(body.split('\n').pop(), '你好', 'her words last');
});

test('ResponsesClient#run: `signal` stops only that run', async () => {
  const srv = await startFakeResponses(() => ({ pieces: ['a', 'b', 'c', 'd'], gapMs: 100, id: 'tpc_s' }));
  try {
    const rc = new ResponsesClient({ lh: fakeLh(), env: { LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'k' } });
    const ac = new AbortController();
    const one = rc.run({ agentId: 'agt_1', prompt: 'x', onDelta: () => ac.abort(), signal: ac.signal });
    const two = rc.run({ agentId: 'agt_2', prompt: 'y', onDelta: () => {} });
    await assert.rejects(one, (e) => e.code === 'ECANCELED');
    assert.equal((await two).text, 'abcd');
  } finally {
    await srv.close();
  }
});

// ---- the bridge ------------------------------------------------------------------------------------------
test('admin preload exposes petAdmin.chat with exactly the documented methods, each one handled in main for the settings window only', () => {
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'main', 'admin-preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'admin-chat.md'), 'utf8');
  const block = pre.slice(pre.indexOf('  chat: {'), pre.indexOf('\n  },', pre.indexOf('  chat: {')));
  const methods = [...block.matchAll(/^ {4}([a-zA-Z]+): /gm)].map((m) => m[1]);
  assert.deepEqual(methods, ['listCharacters', 'history', 'pickImages', 'send', 'abort', 'onDelta', 'onDone', 'onChanged']);
  for (const m of methods) assert.match(doc, new RegExp(`\`chat\\.${m}\\(`), `docs/admin-chat.md documents chat.${m}`);
  const channels = [...block.matchAll(/'(admin-chat-[a-z-]+)'/g)].map((m) => m[1]);
  for (const ch of channels) {
    assert.match(doc, new RegExp(`\`${ch}\``), `docs name ${ch}`);
    if (!['admin-chat-delta', 'admin-chat-done', 'admin-chat-changed'].includes(ch)) assert.match(main, new RegExp(`ipcMain\\.handle\\('${ch}', adminOnly\\(`));
    else assert.match(main, new RegExp(`admin\\.send\\('${ch}'`));
  }
  assert.match(pre.slice(0, 900), /petAdmin\.chat/);
  assert.match(pre.slice(0, 900), /Keys are write-only/);
});

// ---- only the answer is shown (T-2777, 「类似 PA 那样，只需要展示最终的结果」) --------------------------------------
const { answerOnly } = require('../src/core/admin-chat');
// what real LobeHub returned as the answer text for 「帮我查一下今天的科技新闻要点」 (T-2777 probe)
const DSML_LEAK = '<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="activateSkill">\n<｜｜DSML｜｜ parameter name="skill" string="true">agent-browser</｜｜DSML｜｜ parameter>\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

test('answerOnly: tool-call markup and thinking written into the text are cut out; a block still open is cut to the end', () => {
  assert.equal(answerOnly(`我先去抓一下今天的科技新闻。\n\n${DSML_LEAK}`), '我先去抓一下今天的科技新闻。');
  assert.equal(answerOnly(`<think>先算 17×20=340，再加 51</think>391`), '391');
  assert.equal(answerOnly('前面<tool_call>{"name":"search"}</tool_call>\n\n\n\n后面'), '前面\n\n后面');
  assert.equal(answerOnly('A<｜tool▁calls▁begin｜>x<｜tool▁calls▁end｜>B'), 'AB');
  assert.equal(answerOnly('A<function_calls><invoke name="x"/></function_calls>B'), 'AB');
  assert.equal(answerOnly('答案<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="x">', { streaming: true }), '答案');
  // the first characters of an opening marker at the end of a streamed piece wait for the rest
  assert.equal(answerOnly('答案<｜｜DS', { streaming: true }), '答案');
  assert.equal(answerOnly('a < b 且 b<c', { streaming: true }), 'a < b 且 b<c');
  assert.equal(answerOnly('用 <div> 包起来'), '用 <div> 包起来');
  assert.equal(answerOnly(DSML_LEAK), '');
});

