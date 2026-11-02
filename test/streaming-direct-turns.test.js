'use strict';
// Turns without local tools (local abilities off, greetings, proactive lines, topics) go to the Responses API
// with SSE when the direct way is up, so the reply streams; `lh agent run` is the fallback
// (docs/streaming.md §1, §3). Real ResponsesClient against a local fake server + the fake lh.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { ResponsesClient } = require('../src/core/responses-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const { startFakeResponses } = require('./fixtures/fake-responses-server');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const readLog = (dir, name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const agentRuns = (dir) => readLog(dir, 'runs.log');
const of = (events, ev) => events.filter((e) => e.ev === ev).map((e) => e.p);

// `plan`: the fake server's answers; `available`: whether the CLI login can be read; `lhReply`: the fake lh's
// stream-reply.json (its pieces, line by line) for fallback runs.
async function setup({ plan, available = true, lhReply = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petdirectturn-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  if (lhReply) fs.writeFileSync(path.join(dir, 'stream-reply.json'), JSON.stringify(lhReply));
  const srv = await startFakeResponses(plan);
  const clock = { t: new Date('2026-01-05T14:00:00').getTime() };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const env = available ? { LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'test-key' } : { LOBEHUB_SERVER: srv.url };
  const responses = new ResponsesClient({ lh, env, readCredentials: () => null });
  const svc = new PetService({ lh, responses, store: new Store(path.join(dir, 'data')), now: () => clock.t, rnd: () => 0.5 });
  const errors = [];
  svc.on('error', (e) => errors.push(e));
  const events = [];
  for (const ev of ['chat-delta', 'chat-done', 'say']) svc.on(ev, (p) => events.push({ ev, p, at: Date.now() }));
  return { dir, srv, svc, clock, errors, events, lh, responses };
}
const petLines = (svc) => svc.log.list().filter((m) => m.role === 'pet');

test('local abilities off: hatch greeting and chat go to the Responses API with no tools, streamed, and continue one topic', async (t) => {
  const { dir, srv, svc, events } = await setup({ plan: (body, n) => ({ pieces: n === 1 ? ['你好，', '我来啦'] : ['今天', '有点冷，', '多穿点哦'], gapMs: 60, id: body.previous_response_id || 'tpc_DIRECT_A' }) });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  assert.ok(!svc.pet.localAbilities);
  assert.equal(svc._c().topicId, 'tpc_DIRECT_A'); // the response id is the topic, kept for the next turn
  const r = await svc.chat('冷不冷');
  assert.equal(r.ok, true);
  assert.equal(r.text, '今天有点冷，多穿点哦');
  assert.equal(agentRuns(dir).length, 0, 'no `lh agent run`');
  assert.equal(srv.requests.length, 2);
  const [hello, chat] = srv.requests.map((q) => q.body);
  for (const b of [hello, chat]) {
    assert.equal(b.stream, true);
    assert.deepEqual(b.tools, []);
    assert.equal(b.model, svc._c().agentId);
  }
  assert.equal(hello.previous_response_id, undefined); // a new pet: a new topic
  assert.equal(chat.previous_response_id, 'tpc_DIRECT_A'); // same history
  assert.equal(srv.requests[1].headers.accept, 'text/event-stream');
  const chatDeltas = of(events, 'chat-delta').filter((d) => d.kind === 'chat');
  assert.deepEqual(chatDeltas.map((d) => d.text), ['今天', '今天有点冷，', '今天有点冷，多穿点哦']);
  assert.deepEqual(petLines(svc).map((m) => m.text), ['你好，我来啦', '今天有点冷，多穿点哦']);
  assert.equal(svc._c().affection > 0, true);
});

test('proactive lines and topics go the direct way too, on the same topic', async (t) => {
  const { dir, srv, svc } = await setup({ plan: (body) => ({ pieces: ['嗯', '嗯～'], id: body.previous_response_id || 'tpc_DIRECT_B' }) });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  const before = srv.requests.length;
  await svc._speak('hungry');
  const topic = svc.view().topics.find((x) => x.unlocked !== false && !x.locked) || svc.view().topics[0];
  if (topic) await svc.talkTopic(topic.id);
  assert.ok(srv.requests.length >= before + 1);
  for (const q of srv.requests.slice(before)) {
    assert.deepEqual(q.body.tools, []);
    assert.equal(q.body.previous_response_id, 'tpc_DIRECT_B');
  }
  assert.equal(agentRuns(dir).length, 0);
});

test('no readable login: turns use `lh agent run` (no tools, no device) and nothing is sent directly', async (t) => {
  const { dir, srv, svc } = await setup({ available: false, plan: () => ({ pieces: ['x'] }) });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  await svc.chat('在吗');
  assert.equal(srv.requests.length, 0);
  const run = agentRuns(dir).pop();
  assert.match(run.prompt, /在吗/);
  assert.deepEqual(run.tools, []);
  assert.equal(run.device, null);
});

test('direct HTTP error: the same turn goes through `lh agent run` on the same topic; one reply, one 聊天记录 line; direct is retried after a while', async (t) => {
  let fail = false;
  const { dir, srv, svc, clock, errors, events } = await setup({
    plan: (body) => (fail ? { status: 502, body: 'bad gateway' } : { pieces: ['好'], id: body.previous_response_id || 'tpc_DIRECT_C' }),
    lhReply: { pieces: ['lh ', '的回复'], gapMs: 30 },
  });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  fail = true;
  events.length = 0;
  const r = await svc.chat('你好吗');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'lh 的回复');
  const run = agentRuns(dir).pop();
  assert.equal(run.topic, 'tpc_DIRECT_C'); // `-t` the direct topic: same history
  assert.match(run.prompt, /你好吗/);
  assert.ok(errors.some((e) => /502/.test(e.message)));
  assert.equal(of(events, 'say').length, 1);
  assert.equal(of(events, 'chat-done').length, 1);
  assert.equal(of(events, 'chat-done')[0].ok, true);
  assert.deepEqual(petLines(svc).slice(-1).map((m) => m.text), ['lh 的回复']);
  assert.equal(svc.log.list().filter((m) => m.role === 'pet' && m.origin === 'user').length, 1);
  // within LOCAL_RETRY_MS: straight to lh, no second direct try
  const sent = srv.requests.length;
  await svc.chat('再来');
  assert.equal(srv.requests.length, sent);
  // later: direct again
  fail = false;
  clock.t += 6 * 60 * 1000;
  await svc.chat('现在呢');
  assert.equal(srv.requests.length, sent + 1);
  assert.equal(srv.requests[sent].body.previous_response_id, 'tpc_DIRECT_C');
});

test('a direct stream cut off mid-reply: the bubble starts over (restart delta) with the lh reply; no doubled text, one 聊天记录 line', async (t) => {
  let cut = false;
  const { dir, srv, svc, events } = await setup({
    plan: (body) => (cut ? { pieces: ['写到', '一半', '断了'], cutAfter: 2, gapMs: 20, id: body.previous_response_id } : { pieces: ['嗨'], id: body.previous_response_id || 'tpc_DIRECT_D' }),
    lhReply: { pieces: ['完整', '的回复'], gapMs: 30 },
  });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  cut = true;
  events.length = 0;
  const r = await svc.chat('讲讲');
  assert.equal(r.text, '完整的回复');
  const deltas = of(events, 'chat-delta');
  assert.equal(new Set(deltas.map((d) => d.id)).size, 1, 'one bubble');
  assert.deepEqual(deltas.map((d) => [d.text, !!d.restart]), [['写到', false], ['写到一半', false], ['', true], ['完整', false], ['完整的回复', false]]);
  assert.equal(of(events, 'say').length, 1);
  assert.equal(of(events, 'say')[0].text, '完整的回复');
  assert.equal(agentRuns(dir).pop().topic, 'tpc_DIRECT_D');
  assert.deepEqual(svc.log.list().filter((m) => m.role === 'pet' && m.origin === 'user').map((m) => m.text), ['完整的回复']);
});

test('lh topic carried over to the direct way: a pet whose topic came from `lh agent run` continues it with previous_response_id', async (t) => {
  let down = true;
  const { srv, svc, clock } = await setup({ plan: (body) => (down ? { status: 503 } : { pieces: ['接着聊'], id: body.previous_response_id }) });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' }); // direct fails → lh opens the topic
  const lhTopic = svc._c().topicId;
  assert.match(lhTopic, /^tpc_FOR_/);
  down = false;
  clock.t += 6 * 60 * 1000;
  const r = await svc.chat('还记得我吗');
  assert.equal(r.text, '接着聊');
  assert.equal(srv.requests.pop().body.previous_response_id, lhTopic);
  assert.equal(svc._c().topicId, lhTopic);
});

test('Esc during a direct turn: canceled, no fallback run', async (t) => {
  let hang = false;
  const { dir, srv, svc } = await setup({ plan: (body) => (hang ? { pieces: ['从前', '有座山'], hang: true, id: body.previous_response_id } : { pieces: ['嗨'], id: 'tpc_DIRECT_E' }) });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  hang = true;
  const runs = agentRuns(dir).length;
  const p = svc.chat('讲故事');
  await new Promise((r) => setTimeout(r, 200));
  svc.cancel();
  assert.deepEqual(await p, { ok: false, reason: 'canceled' });
  assert.equal(agentRuns(dir).length, runs);
});

test('local abilities on through a device (no direct login) keep `lh agent run --tool --device`', async (t) => {
  const { dir, srv, svc } = await setup({ available: false, plan: () => ({ pieces: ['x'] }) });
  t.after(() => srv.close());
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify([{ deviceId: 'dev_MAC', hostname: 'Mac', platform: process.platform, online: true, channels: [{ channel: 'desktop', connectedAt: new Date().toISOString() }] }]));
  await svc.setLocalAbilities(true);
  await svc.chat('看看');
  const run = agentRuns(dir).pop();
  assert.deepEqual(run.tools, ['lobe-local-system']);
  assert.equal(run.device, 'dev_MAC');
  assert.equal(srv.requests.length, 0);
});
