'use strict';
// 流式回复 in PetService: chat-delta / chat-done events on top of the clients' onDelta (docs/streaming-ui.md).
// Driven by the fake lh's stream-reply.json mode: one stream_chunk per piece, gapMs apart.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const memes = require('../src/core/memes');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');

async function hatched(speciesId = 'claude') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petstream-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), now: () => Date.now(), rnd: () => 0.5 });
  const errors = [];
  svc.on('error', (e) => errors.push(e));
  await svc.hatch({ speciesId, name: '小芽' });
  const events = [];
  for (const ev of ['chat-delta', 'chat-done', 'say', 'affection']) svc.on(ev, (p) => events.push({ ev, p, at: Date.now() }));
  const reply = (r) => fs.writeFileSync(path.join(dir, 'stream-reply.json'), JSON.stringify(r));
  return { dir, lh, svc, events, errors, reply };
}
const of = (events, ev) => events.filter((e) => e.ev === ev).map((e) => e.p);
const petLines = (svc) => svc.log.list().filter((m) => m.role === 'pet' && m.origin === 'user');

test('a chat reply arrives piece by piece: growing chat-delta text, then the final say and one chat-done, same id', async () => {
  const { svc, events, reply } = await hatched();
  reply({ pieces: ['你好呀～', '今天的风', '有点凉，', '要不要喝杯热茶？'], gapMs: 120 });
  const t0 = Date.now();
  const r = await svc.chat('冷不冷');
  assert.equal(r.ok, true);
  assert.equal(r.text, '你好呀～今天的风有点凉，要不要喝杯热茶？');
  const deltas = of(events, 'chat-delta');
  assert.deepEqual(deltas.map((d) => d.text), ['你好呀～', '你好呀～今天的风', '你好呀～今天的风有点凉，', '你好呀～今天的风有点凉，要不要喝杯热茶？']);
  assert.deepEqual(deltas.map((d) => d.n), [1, 2, 3, 4]);
  const id = deltas[0].id;
  assert.ok(deltas.every((d) => d.id === id && d.kind === 'chat' && d.turnId));
  // the pieces really came over time (not all at the end)
  const at = events.filter((e) => e.ev === 'chat-delta').map((e) => e.at - t0);
  assert.ok(at[3] - at[0] >= 250, `pieces spread over ${at[3] - at[0]} ms`);
  // order: deltas, then the final say (with streamId), then chat-done; affection after the reply
  const order = events.map((e) => e.ev).filter((e) => e !== 'affection');
  assert.deepEqual(order, ['chat-delta', 'chat-delta', 'chat-delta', 'chat-delta', 'say', 'chat-done']);
  const say = of(events, 'say')[0];
  assert.equal(say.streamId, id);
  assert.equal(say.text, r.text);
  assert.deepEqual(of(events, 'chat-done'), [{ id, ok: true, reason: null, text: r.text, kind: 'chat', turnId: deltas[0].turnId, deltas: 4, withheld: false }]);
  // 聊天记录: exactly one line for her reply, the final text
  assert.deepEqual(petLines(svc).map((m) => m.text), [r.text]);
  assert.equal(of(events, 'affection').filter((a) => a.type === 'gain').length, 1);
});

test('a meme tag cut between pieces never shows while she writes; the picture comes with the final line', async () => {
  const { svc, events, reply } = await hatched('claude');
  reply({ pieces: ['让我', '想想哦', '\n[梗', '图:th', 'ink]'], gapMs: 30 });
  const r = await svc.chat('这题怎么做');
  assert.equal(r.ok, true);
  const shown = of(events, 'chat-delta').map((d) => d.text);
  assert.deepEqual(shown, ['让我', '让我想想哦']); // the tag pieces add nothing visible
  assert.ok(shown.every((t) => !t.includes('[')));
  const say = of(events, 'say')[0];
  assert.equal(say.text, '让我想想哦');
  assert.equal(say.meme.id, 'think');
  assert.deepEqual(petLines(svc).map((m) => m.text), ['让我想想哦']);
});

test('the guard checks everything so far: from the first hit nothing more is shown, the final line is the refusal', async () => {
  const { svc, events, errors, reply } = await hatched('claude');
  reply({ pieces: ['我们', '去做', '爱做的', '事吧'], gapMs: 20 });
  const r = await svc.chat('周末干嘛');
  const deltas = of(events, 'chat-delta');
  assert.deepEqual(deltas.map((d) => [d.text, !!d.withheld]), [['我们', false], ['我们去做', false], ['', true]]);
  assert.ok(deltas.every((d) => !/做爱/.test(d.text)));
  assert.match(r.text, /这个我不聊啦/);
  assert.equal(of(events, 'say')[0].text, r.text);
  assert.equal(of(events, 'chat-done')[0].withheld, true);
  assert.equal(errors.filter((e) => e.code === 'ECONTENT').length, 1); // reported once, for the final reply
  assert.deepEqual(petLines(svc).map((m) => m.text), [r.text]);
});

test('Esc while she is writing: no more pieces, chat-done canceled, no final line, 聊天记录 notes canceled once, no score', async () => {
  const { svc, events, reply } = await hatched();
  reply({ pieces: ['我想', '想……', '这个嘛'], gapMs: 150, hang: true });
  const p = svc.chat('讲个故事');
  await new Promise((res) => { const h = (d) => { if (d.n === 2) { svc.off('chat-delta', h); res(); } }; svc.on('chat-delta', h); });
  svc.cancel();
  const r = await p;
  assert.deepEqual(r, { ok: false, reason: 'canceled' });
  const done = of(events, 'chat-done');
  assert.equal(done.length, 1);
  assert.equal(done[0].ok, false);
  assert.equal(done[0].reason, 'canceled');
  assert.ok(of(events, 'chat-delta').length <= 3);
  assert.equal(of(events, 'say').length, 0);
  assert.deepEqual(petLines(svc).map((m) => m.status), ['canceled']);
  assert.equal(of(events, 'affection').length, 0);
  assert.equal(svc.busy, false);
});

test('a run that breaks off mid-stream ends the stream as an error after the pieces already shown', async () => {
  const { svc, events, lh } = await hatched();
  lh.env.FAKE_LH_STREAM = 'ndjson-error';
  const r = await svc.chat('你好');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
  assert.deepEqual(of(events, 'chat-delta').map((d) => d.text), ['你好呀～', '你好呀～今天的风']);
  assert.deepEqual(of(events, 'chat-done').map((d) => [d.ok, d.reason]), [[false, 'error']]);
  assert.equal(of(events, 'say').length, 0);
  assert.deepEqual(petLines(svc).map((m) => m.status), ['error']);
});

test('a tool preamble may stream, but the final line is the reply alone', async () => {
  const { svc, events, reply } = await hatched();
  reply({ pieces: ['我看看', '\n\n桌面上有 a 和 b。'], final: '桌面上有 a 和 b。', gapMs: 20 });
  const r = await svc.chat('桌面上有什么');
  assert.equal(r.text, '桌面上有 a 和 b。');
  assert.deepEqual(of(events, 'chat-delta').map((d) => d.text), ['我看看', '我看看\n\n桌面上有 a 和 b。']);
  assert.equal(of(events, 'say')[0].text, '桌面上有 a 和 b。');
  assert.deepEqual(petLines(svc).map((m) => m.text), ['桌面上有 a 和 b。']);
});

test('every turn has its own stream id; a proactive line streams too, without a round of the owner', async () => {
  const { svc, events, reply } = await hatched();
  reply({ pieces: ['一', '二'], gapMs: 10 });
  await svc.chat('第一句');
  await svc.chat('第二句');
  await svc._speak('bored');
  const done = of(events, 'chat-done');
  assert.equal(done.length, 3);
  assert.equal(new Set(done.map((d) => d.id)).size, 3);
  for (const d of done) assert.ok(of(events, 'chat-delta').filter((x) => x.id === d.id).length === 2);
  assert.equal(done[2].kind, 'bored');
  assert.equal(done[2].turnId, null);
  assert.equal(of(events, 'say')[2].streamId, done[2].id);
});

test('a proactive line due while a reply is streaming is dropped: nothing cuts into the bubble or into 聊天记录', async () => {
  const { svc, events, reply } = await hatched();
  reply({ pieces: ['第一段，', '第二段，', '第三段。'], gapMs: 150 });
  const turn = svc.chat('讲个长的');
  await new Promise((r) => setTimeout(r, 200)); // the reply is being written
  assert.equal(svc.busy, true);
  await svc._speak('hungry');
  const r = await turn;
  assert.equal(r.ok, true);
  const says = of(events, 'say');
  assert.equal(says.length, 1, `says: ${JSON.stringify(says.map((s) => s.text))}`);
  assert.equal(says[0].text, '第一段，第二段，第三段。');
  const rounds = svc.log.list().filter((m) => m.role === 'pet');
  assert.deepEqual(rounds.slice(-1).map((m) => m.text), ['第一段，第二段，第三段。']);
  assert.ok(!rounds.some((m) => m.kind === 'hungry'), 'no hungry line logged');
});

test('an lh that prints the whole reply at once still gives one delta and the same final line', async () => {
  const { svc, events } = await hatched();
  const r = await svc.chat('今天好累');
  assert.equal(r.text, 'echo: 今天好累');
  assert.deepEqual(of(events, 'chat-delta').map((d) => d.text), ['echo: 今天好累']);
  assert.equal(of(events, 'chat-done')[0].ok, true);
});

test('memes.streamingText drops finished tags and a tail that may still become one, and nothing else', () => {
  const cases = [
    ['你好[', '你好'], ['你好[梗', '你好'], ['你好\n[梗图:ca', '你好'], ['你好\n[梗图：cat]', '你好'], ['好[meme:do', '好'], ['好[mem', '好'],
    ['数组 a[0] 是第一个', '数组 a[0] 是第一个'], ['看 [x]', '看 [x]'], ['a[1', 'a[1'], ['好 [meme:dog] 再见', '好  再见'],
  ];
  for (const [inp, out] of cases) assert.equal(memes.streamingText(inp), out, inp);
});
