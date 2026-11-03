'use strict';

// 设置窗口 → 聊天 backend (src/core/admin-chat.js, docs/admin-chat.md): sessions on disk, history order and the
// multi-turn input, pictures, the model list, streaming / errors / abort through a real ResponsesClient over a
// fake Responses server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AdminChat, readImage, sniffImage, buildTurnInput, contextMessages, MAX_IMAGE_BYTES } = require('../src/core/admin-chat');
const { chatModelOptions } = require('../src/core/models');
const { ResponsesClient } = require('../src/core/responses-client');
const { startFakeResponses } = require('./fixtures/fake-responses-server');

const ROOT = path.join(__dirname, '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-adminchat-'));
// the smallest real files of each type (sniffed by their first bytes)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(12)]);
const dataUrl = (buf, mime = 'image/png') => `data:${mime};base64,${buf.toString('base64')}`;

const CATALOG = [
  { id: 'gpt-x', displayName: 'GPT X', providerId: 'openai', enabled: true, type: 'chat', abilities: { vision: true } },
  { id: 'claude-y', displayName: 'Claude Y', providerId: 'lobehub', enabled: true, type: 'chat', abilities: { vision: true } },
  { id: 'text-only', displayName: 'Text Only', providerId: 'lobehub', enabled: true, type: 'chat', abilities: {} },
  { id: 'banana', displayName: 'Nano Banana', providerId: 'lobehub', enabled: true, type: 'chat', abilities: { imageOutput: true, vision: true } },
  { id: 'off', providerId: 'lobehub', enabled: false, type: 'chat' },
  { id: 'emb', providerId: 'lobehub', enabled: true, type: 'embedding' },
  { id: 'claude-y', displayName: 'dup', providerId: 'lobehub', enabled: true, type: 'chat' },
];

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

// a ResponsesClient that streams `pieces` as SSE, or a scripted run()
function fakeResponses(script) {
  const runs = [];
  return {
    runs,
    available: () => true,
    async run(opts) {
      runs.push(opts);
      return script(opts);
    },
  };
}

function make({ dir = tmp(), lh = fakeLh(), responses, catalog = CATALOG, now } = {}) {
  let t = 1000;
  const chat = new AdminChat({ dir, lh, responses: responses || fakeResponses(async (o) => { o.onDelta('好', '好'); return { text: '好' }; }), loadCatalog: async () => catalog, now: now || (() => (t += 1000)) });
  return { chat, dir, lh };
}

// ---- models --------------------------------------------------------------------------------------------
test('model list: enabled chat models of every provider, hosted first, image-only / disabled / non-chat / duplicates left out, vision flagged', () => {
  const opts = chatModelOptions(CATALOG);
  assert.deepEqual(opts.map((o) => o.key), ['lobehub:claude-y', 'lobehub:text-only', 'openai:gpt-x']);
  assert.deepEqual(opts[0], { key: 'lobehub:claude-y', id: 'claude-y', providerId: 'lobehub', label: 'Claude Y', vision: true, hosted: true });
  assert.equal(opts[1].vision, false);
  assert.deepEqual(chatModelOptions(null), []);
});

test('listModels / setModel: the last choice is kept on disk and comes back after a restart; unknown keys refused', async () => {
  const { chat, dir } = make();
  let r = await chat.listModels();
  assert.equal(r.ok, true);
  assert.equal(r.selected, 'lobehub:claude-y'); // nothing chosen yet: the first
  assert.deepEqual(r.models.map((m) => [m.providerId, m.id, m.label, m.vision]), [['lobehub', 'claude-y', 'Claude Y', true], ['lobehub', 'text-only', 'Text Only', false], ['openai', 'gpt-x', 'GPT X', true]]);
  assert.deepEqual(await chat.setModel('openai:nope'), { ok: false, reason: 'unknown-model', message: '没有这个模型' });
  assert.equal((await chat.setModel('../x')).reason, 'bad-model');
  assert.deepEqual(await chat.setModel('openai:gpt-x'), { ok: true, selected: 'openai:gpt-x' });
  const again = make({ dir }).chat;
  r = await again.listModels();
  assert.equal(r.selected, 'openai:gpt-x');
  // a catalog that fails: the error is readable, the list is empty, nothing throws
  const broken = new AdminChat({ dir: tmp(), lh: fakeLh(), responses: fakeResponses(async () => ({ text: '' })), loadCatalog: async () => { throw new Error('lh offline'); } });
  r = await broken.listModels();
  assert.deepEqual([r.ok, r.models, r.selected, r.error], [true, [], null, 'lh offline']);
});

// ---- sessions ------------------------------------------------------------------------------------------
test('sessions: create / list (newest first) / get / clear / delete, all on disk and back after a restart', async () => {
  const { chat, dir } = make();
  const a = chat.createSession().session;
  const b = chat.createSession({ title: '  旅行计划  ' }).session;
  assert.match(a.id, /^ses_[a-z0-9]+$/);
  assert.equal(a.title, '新会话');
  assert.equal(b.title, '旅行计划');
  assert.deepEqual(chat.listSessions().sessions.map((s) => s.id), [b.id, a.id]);
  assert.ok(fs.existsSync(path.join(dir, 'index.json')));
  assert.ok(fs.existsSync(path.join(dir, 'sessions', `${a.id}.json`)));

  const r = await chat.send({ sessionId: a.id, text: '你好，帮我想个周末计划', images: [{ dataUrl: dataUrl(PNG), name: 'p.png' }] });
  assert.equal(r.ok, true);
  // a restarted app (a new AdminChat on the same folder) sees the same sessions and messages
  const again = make({ dir }).chat;
  const list = again.listSessions().sessions;
  assert.deepEqual(list.map((s) => s.id), [a.id, b.id]); // a was just used
  assert.equal(list[0].title, '你好，帮我想个周末计划'); // the first message names a new session
  assert.equal(list[0].messageCount, 2);
  const got = again.getSession(a.id);
  assert.equal(got.ok, true);
  assert.deepEqual(got.session.messages.map((m) => [m.role, m.text, m.status]), [['user', '你好，帮我想个周末计划', 'done'], ['assistant', '好', 'done']]);
  const att = got.session.messages[0].attachments[0];
  assert.equal(att.name, 'p.png');
  assert.equal(att.mime, 'image/png');
  assert.equal(att.url, dataUrl(PNG)); // shown straight from the data URL
  assert.ok(!('file' in att) && !('remote' in att), 'no disk path or remote id leaks to the renderer');

  const cleared = again.clearSession(a.id);
  assert.deepEqual([cleared.ok, cleared.session.messages, cleared.session.title], [true, [], '新会话']);
  assert.ok(!fs.existsSync(path.join(dir, 'attachments', a.id)), 'its pictures are gone too');
  assert.equal(make({ dir }).chat.getSession(a.id).session.messageCount, 0);

  assert.deepEqual(again.deleteSession(b.id), { ok: true });
  assert.ok(!fs.existsSync(path.join(dir, 'sessions', `${b.id}.json`)));
  assert.deepEqual(make({ dir }).chat.listSessions().sessions.map((s) => s.id), [a.id]);
  assert.equal(again.getSession(b.id).reason, 'not-found');
  assert.equal(again.deleteSession(b.id).reason, 'not-found');
  // ids are checked: no path outside the folder
  assert.equal(again.getSession('../../etc/passwd').reason, 'not-found');
  assert.equal(again.deleteSession('../x').reason, 'not-found');
});

test('a broken index.json starts empty instead of throwing', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'index.json'), '{nope');
  const { chat } = make({ dir });
  assert.deepEqual(chat.listSessions().sessions, []);
});

// ---- history and context -------------------------------------------------------------------------------
test('messages keep their order with role, text, pictures, model and time; each turn carries the whole history', async () => {
  const responses = fakeResponses(async (o) => ({ text: `回复${o.prompt[0].content[0].text.length}` }));
  const { chat } = make({ responses });
  const s = chat.createSession().session;
  await chat.setModel('openai:gpt-x');
  await chat.send({ sessionId: s.id, text: '第一句：我叫小明' });
  await chat.send({ sessionId: s.id, text: '第二句：我喜欢猫', model: 'lobehub:claude-y' });
  await chat.send({ sessionId: s.id, text: '我叫什么？' });
  const msgs = chat.getSession(s.id).session.messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(msgs.map((m) => m.model), ['openai:gpt-x', 'openai:gpt-x', 'lobehub:claude-y', 'lobehub:claude-y', 'openai:gpt-x', 'openai:gpt-x']);
  for (let i = 1; i < msgs.length; i++) assert.ok(msgs[i].createdAt > msgs[i - 1].createdAt, 'times go up');
  for (const m of msgs) assert.ok(m.id && Array.isArray(m.attachments));
  // the third turn: one user message, the earlier four messages oldest first, then the new one
  const input = responses.runs[2].prompt;
  assert.equal(input.length, 1);
  assert.equal(input[0].type, 'message');
  assert.equal(input[0].role, 'user');
  const text = input[0].content[0].text;
  const order = ['【用户】第一句：我叫小明', `【助手】${msgs[1].text}`, '【用户】第二句：我喜欢猫', `【助手】${msgs[3].text}`, '现在我说：\n我叫什么？'].map((x) => text.indexOf(x));
  assert.ok(order.every((i) => i >= 0), text);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'oldest first, the new message last');
  // the first turn has no history block at all
  assert.equal(responses.runs[0].prompt[0].content[0].text, '第一句：我叫小明');
  assert.deepEqual(responses.runs[0].tools, []);
});

test('buildTurnInput: failed and empty turns are left out, a long history is cut from the oldest end, pictures become input_image parts', () => {
  const h = [
    { role: 'user', text: '旧的一句', attachments: [] },
    { role: 'assistant', text: '', status: 'error', error: 'x', attachments: [] },
    { role: 'assistant', text: '', status: 'aborted', attachments: [] },
    { role: 'user', text: '看图', attachments: [{ name: 'a.png' }] },
    { role: 'assistant', text: '一只猫', status: 'done', attachments: [] },
  ];
  assert.equal(contextMessages(h).length, 3);
  const input = buildTurnInput(h, { text: '它是什么颜色？', attachments: [] }, { imageFileIds: ['file_1', 'file_2'] });
  assert.match(input[0].content[0].text, /【用户】看图［附图 1 张：a\.png］\n【助手】一只猫/);
  assert.deepEqual(input[0].content.slice(1), [{ type: 'input_image', file_id: 'file_1', detail: 'auto' }, { type: 'input_image', file_id: 'file_2', detail: 'auto' }]);
  const cut = buildTurnInput(h, { text: '新的', attachments: [] }, { maxChars: 30 })[0].content[0].text;
  assert.ok(!cut.includes('旧的一句'));
  assert.match(cut, /更早的 1 条已省略/);
  // a picture with no words still asks the model to look
  assert.match(buildTurnInput([], { text: '', attachments: [{ name: 'b.jpg' }] })[0].content[0].text, /^（请看我发的图片）［附图 1 张：b\.jpg］$/);
});

// ---- pictures ------------------------------------------------------------------------------------------
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

test('send with pictures: saved to the session folder, uploaded once, attached in a topic the turn continues, and sent as input_image', async () => {
  const responses = fakeResponses(async () => ({ text: '是红色的' }));
  const { chat, dir, lh } = make({ responses });
  const s = chat.createSession().session;
  const src = path.join(tmp(), 'cat.png');
  fs.writeFileSync(src, PNG);
  const r = await chat.send({ sessionId: s.id, text: '这是什么颜色', images: [{ path: src }, { dataUrl: dataUrl(JPG, 'image/jpeg'), name: 'b.jpg' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.userMessage.attachments.map((a) => [a.name, a.mime, !!a.url]), [['cat.png', 'image/png', true], ['b.jpg', 'image/jpeg', true]]);
  const files = fs.readdirSync(path.join(dir, 'attachments', s.id)).sort();
  assert.equal(files.length, 2);
  assert.ok(files.every((f) => /^att_[a-z0-9]+\.(png|jpg)$/.test(f)));
  assert.deepEqual(lh.calls.filter((c) => c[0] === 'uploadFile').length, 2);
  const run = responses.runs[0];
  assert.match(run.topicId, /^tpc_img/);
  assert.deepEqual(run.prompt[0].content.filter((p) => p.type === 'input_image').map((p) => p.type), ['input_image', 'input_image']);
  assert.ok(lh.calls.some((c) => c[0] === 'addFilesToMessage'));
  // the next turn without pictures still lets the model see them (uploaded once, ids reused)
  await chat.send({ sessionId: s.id, text: '再说一遍' });
  assert.equal(lh.calls.filter((c) => c[0] === 'uploadFile').length, 2);
  assert.equal(responses.runs[1].prompt[0].content.filter((p) => p.type === 'input_image').length, 2);
  // a session without pictures: no topic, no upload
  const t = chat.createSession().session;
  await chat.send({ sessionId: t.id, text: '纯文字' });
  assert.equal(responses.runs[2].topicId, undefined);
  assert.equal(responses.runs[2].prompt[0].content.length, 1);
});

test('send refuses: empty, unknown session, bad picture, too many pictures, a text-only model with pictures — nothing saved', async () => {
  const { chat, lh } = make();
  const s = chat.createSession().session;
  assert.equal((await chat.send({ sessionId: s.id, text: '  ' })).reason, 'empty');
  assert.equal((await chat.send({ sessionId: 'ses_nope000', text: 'x' })).reason, 'not-found');
  assert.equal((await chat.send({ sessionId: s.id, text: 'x', images: [dataUrl(Buffer.from('hi'), 'text/plain')] })).reason, 'bad-type');
  assert.equal((await chat.send({ sessionId: s.id, text: 'x', images: ['data:image/png;base64,@@'] })).reason, 'bad-input');
  assert.equal((await chat.send({ sessionId: s.id, text: 'x', images: [dataUrl(Buffer.from('<svg/>'), 'image/svg+xml')] })).reason, 'bad-type');
  assert.equal((await chat.send({ sessionId: s.id, text: 'x', images: Array(5).fill(dataUrl(PNG)) })).reason, 'too-many-images');
  const nv = await chat.send({ sessionId: s.id, text: 'x', images: [dataUrl(PNG)], model: 'lobehub:text-only' });
  assert.equal(nv.reason, 'no-vision');
  assert.match(nv.error, /Text Only 不支持图片/);
  assert.equal((await chat.send({ sessionId: s.id, text: 'x', model: 'openai:missing' })).reason, 'no-model');
  assert.equal(chat.getSession(s.id).session.messages.length, 0);
  assert.equal(lh.calls.length, 0);
});

// ---- the agent -----------------------------------------------------------------------------------------
test('the chat has one agent of its own, switched to the chosen model only when it changes; a new one in another workspace', async () => {
  const { chat, lh } = make();
  const s = chat.createSession().session;
  await chat.send({ sessionId: s.id, text: '1', model: 'openai:gpt-x' });
  await chat.send({ sessionId: s.id, text: '2', model: 'openai:gpt-x' });
  await chat.send({ sessionId: s.id, text: '3', model: 'lobehub:claude-y' });
  assert.deepEqual(lh.calls, [['createAgent', 'Pixel Pet 聊天'], ['updateAgent', 'agt_chat1', 'openai', 'gpt-x'], ['updateAgent', 'agt_chat1', 'lobehub', 'claude-y']]);
  lh.workspaceId = 'ws_team';
  await chat.send({ sessionId: s.id, text: '4', model: 'lobehub:claude-y' });
  assert.deepEqual(lh.calls.slice(3), [['createAgent', 'Pixel Pet 聊天'], ['updateAgent', 'agt_chat2', 'lobehub', 'claude-y']]);
  // an agent deleted in LobeHub: edit fails once, a new agent is made
  let failed = false;
  const orig = lh.updateAgent;
  lh.updateAgent = async (a) => { if (!failed) { failed = true; throw new Error('Agent not found'); } return orig(a); };
  await chat.send({ sessionId: s.id, text: '5', model: 'openai:gpt-x' });
  assert.equal(chat.state.agent.id, 'agt_chat3');
});

// ---- streaming, errors, abort: a real ResponsesClient over a fake SSE server -----------------------------
test('streaming: deltas arrive in order through onDelta, the request is the multimodal input on the chat agent', async () => {
  const srv = await startFakeResponses(() => ({ pieces: ['你好', '，我是', '聊天助手', '。'], gapMs: 20, id: 'tpc_chat' }));
  try {
    const lh = fakeLh();
    const responses = new ResponsesClient({ lh, env: { LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'k' } });
    const { chat } = make({ lh, responses });
    const s = chat.createSession().session;
    const deltas = [];
    const r = await chat.send({ sessionId: s.id, text: '介绍一下你自己' }, { onDelta: (d) => deltas.push(d) });
    assert.equal(r.ok, true);
    assert.equal(r.message.text, '你好，我是聊天助手。');
    assert.deepEqual(deltas.map((d) => d.delta), ['你好', '，我是', '聊天助手', '。']);
    assert.deepEqual(deltas.map((d) => d.text), ['你好', '你好，我是', '你好，我是聊天助手', '你好，我是聊天助手。']);
    assert.ok(deltas.every((d) => d.sessionId === s.id && d.messageId === r.message.id));
    const body = srv.requests[0].body;
    assert.equal(body.model, 'agt_chat1');
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools, []);
    assert.deepEqual(body.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '介绍一下你自己' }] }]);
    assert.equal(srv.requests[0].headers.authorization, 'Bearer k');
  } finally {
    await srv.close();
  }
});

test('errors are readable and kept as a failed reply; abort stops just this turn and keeps what was written', async () => {
  let mode = 'fail';
  const srv = await startFakeResponses(() => (mode === 'fail' ? { status: 500, body: 'upstream exploded' } : { pieces: ['一', '二', '三', '四', '五', '六'], gapMs: 150, id: 'tpc_x' }));
  try {
    const lh = fakeLh();
    const responses = new ResponsesClient({ lh, env: { LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'k' } });
    const { chat } = make({ lh, responses });
    const s = chat.createSession().session;
    const bad = await chat.send({ sessionId: s.id, text: '会失败' });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'error');
    assert.equal(bad.code, 'EAPI');
    assert.match(bad.error, /^LobeHub 返回错误：HTTP 500: upstream exploded/);
    assert.deepEqual(chat.getSession(s.id).session.messages.map((m) => [m.role, m.status]), [['user', 'done'], ['assistant', 'error']]);
    // the failed reply is not context for the next turn
    mode = 'stream';
    const seen = [];
    const p = chat.send({ sessionId: s.id, text: '慢慢说' }, { onDelta: (d) => { seen.push(d.delta); if (seen.length === 2) chat.abort(s.id); } });
    assert.equal((await chat.send({ sessionId: s.id, text: '插队' })).reason, 'busy');
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'aborted');
    assert.equal(r.message.status, 'aborted');
    assert.equal(r.message.text, '一二');
    assert.ok(!srv.requests[1].body.input[0].content[0].text.includes('会失败'.repeat(2)));
    assert.ok(!/【助手】\s*$/m.test(srv.requests[1].body.input[0].content[0].text), 'no empty failed reply in the history');
    assert.deepEqual(chat.abort(s.id), { ok: true, aborted: false });
    // not logged in at all
    const noAuth = make({ responses: { available: () => false, run: async () => ({ text: 'x' }) } }).chat;
    const ns = noAuth.createSession().session;
    const na = await noAuth.send({ sessionId: ns.id, text: 'hi' });
    assert.equal(na.code, 'EAUTH');
    assert.match(na.error, /lh login/);
  } finally {
    await srv.close();
  }
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
  assert.deepEqual(methods, ['listModels', 'setModel', 'listSessions', 'createSession', 'getSession', 'deleteSession', 'clearSession', 'pickImages', 'send', 'abort', 'onDelta', 'onDone']);
  for (const m of methods) assert.match(doc, new RegExp(`\`chat\\.${m}\\(`), `docs/admin-chat.md documents chat.${m}`);
  const channels = [...block.matchAll(/'(admin-chat-[a-z-]+)'/g)].map((m) => m[1]);
  for (const ch of channels) {
    assert.match(doc, new RegExp(`\`${ch}\``), `docs name ${ch}`);
    if (!['admin-chat-delta', 'admin-chat-done'].includes(ch)) assert.match(main, new RegExp(`ipcMain\\.handle\\('${ch}', adminOnly\\(`));
    else assert.match(main, new RegExp(`admin\\.send\\('${ch}'`));
  }
  // the security note at the top says what the chat channels are and that keys stay write-only
  assert.match(pre.slice(0, 900), /petAdmin\.chat/);
  assert.match(pre.slice(0, 900), /Keys are write-only/);
});
