'use strict';
// 对话测速埋点 (core/latency.js, docs/admin-chat-latency.md): off by default; on, one line per chat turn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const latency = require('../src/core/latency');
const { ResponsesClient } = require('../src/core/responses-client');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const chatLog = require('../src/core/chat-log');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-lat-'));

test('off by default: the no-op trace, nothing written', () => {
  const file = path.join(tmp(), 'latency.jsonl');
  const t = latency.createTrace('admin', { env: { PIXELPET_LATENCY_FILE: file } });
  assert.equal(t, latency.NOOP);
  assert.equal(t.on, false);
  t.mark('x');
  t.markLast('y');
  t.set('a', 1);
  t.add('b');
  t.end();
  assert.equal(fs.existsSync(file), false);
  assert.equal(latency.enabled({}), false);
  assert.equal(latency.enabled({ PIXELPET_LATENCY: '1' }), true);
});

test('on: first marks stay, last marks move, counters add up, one line when the turn ends', () => {
  let t = 1000;
  const out = [];
  const tr = latency.createTrace('desktop', { env: { PIXELPET_LATENCY: '1' }, now: () => t, write: (l) => out.push(JSON.parse(l)) });
  t = 1010;
  tr.mark('reqSent');
  t = 1500;
  tr.mark('firstText');
  tr.markLast('lastShown');
  tr.add('deltas');
  tr.add('ipcBytes', 30);
  t = 1700;
  tr.mark('firstText'); // the first one stays
  tr.markLast('lastShown');
  tr.add('deltas');
  tr.add('ipcBytes', 60);
  tr.set('via', 'direct');
  t = 2000;
  tr.end({ ok: true });
  tr.end({ ok: false }); // written once
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { kind: 'desktop', t0: 1000, deltas: 2, ipcBytes: 90, via: 'direct', ok: true, marks: { reqSent: 10, firstText: 500, lastShown: 700, end: 1000 } });
});

test('ResponsesClient marks token / reqSent / headers / firstByte / firstText of a streamed turn; without a trace it runs as before', async () => {
  const sse = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"tpc_1","status":"in_progress","output":[]}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"m1","output_index":0,"delta":"在呢"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"tpc_1","status":"completed","output":[{"type":"message","id":"m1","content":[{"type":"output_text","text":"在呢"}]}]}}\n\n',
  ];
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/event-stream' }), body: (async function* () { for (const s of sse) yield new TextEncoder().encode(s); })() });
  const c = new ResponsesClient({ lh: { workspaceId: null }, fetchImpl, env: { LOBEHUB_SERVER: 'https://hub.test' }, readCredentials: () => ({ accessToken: 'tok' }) });
  const out = [];
  const tr = latency.createTrace('raw', { env: { PIXELPET_LATENCY: '1' }, write: (l) => out.push(JSON.parse(l)) });
  const r = await c.run({ agentId: 'agt_1', topicId: 'tpc_1', prompt: 'hi', onDelta: () => {}, trace: tr });
  tr.end();
  assert.deepEqual(r, { text: '在呢', topicId: 'tpc_1', cost: null });
  assert.deepEqual(Object.keys(out[0].marks), ['token', 'reqSent', 'headers', 'firstByte', 'firstText', 'end']);
  assert.equal(out[0].streamed, true);
  assert.equal(out[0].steps, 1);
  assert.deepEqual(await c.run({ agentId: 'agt_1', topicId: 'tpc_1', prompt: 'hi', onDelta: () => {} }), r);
});

test('PIXELPET_LATENCY=1: a desktop turn and a chat-page turn each write a line (way, prompt size, steps); the replies are unchanged', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const file = path.join(dir, 'latency.jsonl');
  const lh = new LhClient({ bin: path.join(__dirname, 'fixtures', 'fake-lh.js'), env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), rnd: () => 0.5, log: new chatLog.MemoryChatLog() });
  svc.on('error', () => {});
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  const saved = { on: process.env.PIXELPET_LATENCY, file: process.env.PIXELPET_LATENCY_FILE, write: process.stdout.write };
  process.env.PIXELPET_LATENCY = '1';
  process.env.PIXELPET_LATENCY_FILE = file;
  process.stdout.write = (s, ...a) => (String(s).startsWith('[latency]') ? true : saved.write.call(process.stdout, s, ...a));
  try {
    const a = await svc.chat('在吗');
    const b = await svc.chatAs('claude', { text: '设置窗口里说的' });
    assert.equal(a.ok, true);
    assert.equal(a.text, 'echo: 在吗');
    assert.equal(b.ok, true);
    assert.equal(b.message.text, 'echo: 设置窗口里说的');
  } finally {
    if (saved.on === undefined) delete process.env.PIXELPET_LATENCY; else process.env.PIXELPET_LATENCY = saved.on;
    if (saved.file === undefined) delete process.env.PIXELPET_LATENCY_FILE; else process.env.PIXELPET_LATENCY_FILE = saved.file;
    process.stdout.write = saved.write;
  }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => [l.kind, l.ok, l.via]), [['desktop', true, 'lh-run'], ['admin', true, 'lh-run']]);
  for (const l of lines) {
    assert.match(l.fallbackReason, /no direct client/);
    assert.ok(l.promptChars > l.textChars);
    for (const m of ['models', 'persona', 'applyModel', 'reqSent', 'firstDelta', 'firstShown', 'lastShown', 'runStart', 'runEnd', 'end']) assert.equal(typeof l.marks[m], 'number', `${l.kind} ${m}`);
    assert.ok(l.deltas >= 1 && l.ipcBytes > 0);
  }
  assert.equal(lines[1].topicFresh, false);
  // off again: nothing more is written
  await svc.chat('再说一句');
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 2);
});
