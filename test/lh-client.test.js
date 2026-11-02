'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient, parseRunEvents, runEndCode, cleanEnv } = require('../src/core/lh-client');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakelh-'));
  const env = { ...cleanEnv(), FAKE_LH_DIR: dir };
  return { dir, lh: new LhClient({ bin: FAKE, env }), calls: () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse) };
}

test('whoami returns null when logged out, user when logged in', async () => {
  const { dir, lh } = setup();
  assert.equal(await lh.whoami(), null);
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  assert.equal((await lh.whoami()).name, 'Test Owner');
});

test('login surfaces the device URL and code, then confirms identity', async () => {
  const { lh } = setup();
  let prompt = null;
  const user = await lh.login({ onPrompt: (p) => { prompt = p; } });
  assert.deepEqual(prompt, { url: 'https://example.com/device', code: 'ABCD-1234', browserFailed: false });
  assert.equal(user.username, 'tester');
});

test('createAgent passes persona and parses the agent id', async () => {
  const { dir, lh } = setup();
  const { agentId } = await lh.createAgent({ title: 'T', description: 'D', systemRole: 'ROLE' });
  assert.match(agentId, /^agt_FAKE/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'last-create.json'))).systemRole, 'ROLE');
});

test('run returns the reply and reuses the topic', async () => {
  const { lh, calls } = setup();
  const r1 = await lh.run({ agentId: 'agt_1', prompt: 'hi' });
  assert.equal(r1.text, 'echo: hi');
  assert.equal(r1.topicId, 'tpc_FAKE1');
  await lh.run({ agentId: 'agt_1', prompt: 'again', topicId: 'tpc_ZZ' });
  const last = calls().filter((c) => c.args[1] === 'run').pop();
  assert.ok(last.args.includes('-t') && last.args.includes('tpc_ZZ'));
});

test('run returns as soon as the events are printed, without waiting for lh to exit', async () => {
  const { lh } = setup();
  lh.env.FAKE_LH_LINGER_MS = '15000';
  const t0 = Date.now();
  const r = await lh.run({ agentId: 'agt_1', prompt: 'hi' });
  assert.equal(r.text, 'echo: hi');
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0}ms`);
});

test('runEndCode: the exit code once the event array is complete, undefined before', () => {
  const end = (data) => JSON.stringify([{ type: 'stream_end', data: { finalContent: 'x' } }, { type: 'agent_runtime_end', data }], null, 2);
  assert.equal(runEndCode(end({})), 0);
  assert.equal(runEndCode(end({ reason: 'interrupted' })), 1);
  assert.equal(runEndCode(JSON.stringify([{ type: 'error', data: { message: 'boom' } }])), 1);
  const full = end({});
  assert.equal(runEndCode(full.slice(0, full.length - 10)), undefined, 'half-written');
  assert.equal(runEndCode('[]'), undefined, 'no terminal event: wait for the exit code');
  assert.equal(runEndCode(''), undefined);
});

test('run surfaces CLI failures as errors', async () => {
  const { lh } = setup();
  lh.env.FAKE_LH_FAIL_RUN = '1';
  await assert.rejects(() => lh.run({ agentId: 'agt_1', prompt: 'x' }), /Agent run failed/);
});

test('missing binary gives a helpful error', async () => {
  const lh = new LhClient({ bin: '/nonexistent/lh' });
  await assert.rejects(() => lh.whoami(), /not found/);
});

test('inherited run-context variables are stripped from the child env', () => {
  const env = cleanEnv({ LOBEHUB_TOPIC_ID: 't', LOBEHUB_AGENT_ID: 'a', LOBEHUB_OPERATION_ID: 'o', LOBEHUB_ASSISTANT_MESSAGE_ID: 'm', KEEP: '1' });
  assert.deepEqual(env, { KEEP: '1' });
});

test('parseRunEvents tolerates garbage and picks the final content', () => {
  assert.equal(parseRunEvents('nope').text, '');
  const out = parseRunEvents(JSON.stringify([{ type: 'stream_end', data: { finalContent: ' hi ' } }]));
  assert.equal(out.text, 'hi');
});

test('parseRunEvents finds the topic on stream_start when init carries none', () => {
  const out = parseRunEvents(JSON.stringify([
    { type: 'agent_runtime_init', data: {} },
    { type: 'stream_start', data: { assistantMessage: { topicId: 'tpc_1' } } },
    { type: 'stream_end', data: { finalContent: 'yo' } },
  ]));
  assert.equal(out.topicId, 'tpc_1');
});

test('login handles a code that arrives in a later chunk and non-hyphenated codes', async () => {
  const { lh } = setup();
  lh.env.FAKE_LH_CODE = 'XYZ789';
  const prompts = [];
  await lh.login({ onPrompt: (p) => prompts.push(p) });
  assert.equal(prompts.length, 1);
  assert.deepEqual({ url: prompts[0].url, code: prompts[0].code }, { url: 'https://example.com/device', code: 'XYZ789' });
});

test('login reports when the CLI could not open a browser so the app can open it', async () => {
  const { lh } = setup();
  lh.env.FAKE_LH_NO_BROWSER = '1';
  lh.env.FAKE_LH_LOGIN_MS = '800'; // stay alive long enough to print the warning
  const prompts = [];
  await lh.login({ onPrompt: (p) => prompts.push(p) });
  assert.equal(prompts[0].browserFailed, false);
  assert.equal(prompts.at(-1).browserFailed, true);
});

test('run failures are classified so the UI can say what went wrong', async () => {
  for (const [mode, code, re] of [['timeout', 'ETIMEDOUT', /timed out/], ['auth', 'EAUTH', /login/i], ['badflag', 'ECLI', /not compatible/], ['empty', 'ENOREPLY', /no reply/], ['x', 1, /exit 1/]]) {
    const { lh } = setup();
    lh.env.FAKE_LH_FAIL_RUN = mode;
    await assert.rejects(() => lh.run({ agentId: 'agt_1', prompt: 'x', timeoutMs: 600 }), (e) => e.code === code && re.test(e.message), mode);
  }
});

test('daemon status is parsed, and starting a daemon that is already running counts as success', async () => {
  const { lh } = setup();
  assert.deepEqual(await lh.daemonStatus(), { running: false, pid: null, connection: null });
  await lh.startConnectDaemon();
  const st = await lh.daemonStatus();
  assert.deepEqual({ running: st.running, pid: st.pid, connection: st.connection }, { running: true, pid: 4242, connection: 'connected' });
  await lh.startConnectDaemon(); // the real CLI exits 1 with "already running"; that must not throw
});

test('a real failure to start the daemon still throws', async () => {
  const { lh } = setup();
  lh.env.FAKE_LH_CONNECT_FAIL = '1';
  await assert.rejects(() => lh.startConnectDaemon(), /lh connect failed/);
});

// ---- streaming (onDelta) ------------------------------------------------------------------------------
const { createEventScanner } = require('../src/core/lh-client');
const streamed = async (mode, extra = {}) => {
  const { lh } = setup();
  lh.env.FAKE_LH_STREAM = mode;
  Object.assign(lh.env, extra.env || {});
  const deltas = [];
  const t0 = Date.now();
  const onDelta = (chunk, full) => deltas.push({ chunk, full, ms: Date.now() - t0 });
  const run = lh.run({ agentId: 'agt_1', prompt: 'hi', onDelta, ...extra.run });
  return { lh, deltas, run };
};
const noBrokenChars = (s) => !s.includes('�');

test('onDelta: text chunks of one-event-per-line output arrive while lh is still writing, in order, whole characters only', async () => {
  const { deltas, run } = await streamed('ndjson');
  const r = await run;
  assert.deepEqual(deltas.map((d) => d.chunk), ['你好呀～', '今天的风', '有点凉，', '要不要🍵喝杯热茶？']);
  assert.ok(deltas.every((d) => noBrokenChars(d.chunk)), 'a UTF-8 character split between two pipe reads stays whole');
  for (let i = 0; i < deltas.length; i++) assert.equal(deltas[i].full, deltas.slice(0, i + 1).map((d) => d.chunk).join(''));
  assert.ok(deltas[deltas.length - 1].ms - deltas[0].ms > 20, 'spread over the writes, not delivered at the end');
  // the result is the same as without streaming; reasoning never reaches onDelta
  assert.deepEqual(r, { text: '你好呀～今天的风有点凉，要不要🍵喝杯热茶？', topicId: 'tpc_FAKE1', cost: 0.002 });
  assert.equal(deltas.at(-1).full, r.text);
});

test('onDelta: every 1-byte cut of the stream gives the same chunks (JSON, strings and characters cut anywhere)', async () => {
  const { deltas, run } = await streamed('ndjson', { env: { FAKE_LH_SLICE: '1' } });
  await run;
  assert.deepEqual(deltas.map((d) => d.chunk), ['你好呀～', '今天的风', '有点凉，', '要不要🍵喝杯热茶？']);
});

test('onDelta: a tool step\'s preamble streams too, the next step starts after a paragraph break; the final text is the last step', async () => {
  const { deltas, run } = await streamed('ndjson-steps');
  const r = await run;
  assert.deepEqual(deltas.map((d) => d.chunk), ['我看', '看', '\n\n桌面上有', ' a 和 b 两个文件夹。']);
  assert.equal(deltas.at(-1).full, '我看看\n\n桌面上有 a 和 b 两个文件夹。');
  assert.equal(r.text, '桌面上有 a 和 b 两个文件夹。');
  assert.equal(r.cost, 0.004);
});

test('onDelta: today\'s lh (the whole --json array at once) falls back to the one-shot result, chunks in one burst', async () => {
  const { deltas, run } = await streamed('array');
  const r = await run;
  assert.equal(deltas.map((d) => d.chunk).join(''), r.text);
  assert.equal(r.text, '你好呀～今天的风有点凉，要不要🍵喝杯热茶？');
});

test('onDelta: replaying the recorded lh 0.0.62 --json sample gives its 11 text chunks, adding up to the final reply', async () => {
  const sample = require('./fixtures/streaming/lh-run-json-long.json');
  const s = sample.chunks.filter((c) => c.stream === 'stdout').map((c) => c.text).join('');
  const expected = JSON.parse(s.slice(s.indexOf('['))).filter((e) => e.type === 'stream_chunk' && e.data.chunkType === 'text').map((e) => e.data.content);
  const { deltas, run } = await streamed('fixture:lh-run-json-long.json');
  const r = await run;
  assert.equal(expected.length, 11);
  assert.deepEqual(deltas.map((d) => d.chunk), expected);
  assert.equal(deltas.at(-1).full.trim(), r.text);
});

test('onDelta: an lh without stream_chunk events still calls it once with the whole reply', async () => {
  const { deltas, run } = await streamed('');
  const r = await run;
  assert.equal(r.text, 'echo: hi');
  assert.deepEqual(deltas.map(({ chunk, full }) => ({ chunk, full })), [{ chunk: 'echo: hi', full: 'echo: hi' }]);
});

test('onDelta: an lh that rejects an optional flag is retried without it, and the reply still streams once', async () => {
  const { lh, deltas, run } = await streamed('', { env: { FAKE_LH_NO_DEVICE_FLAG: '1' }, run: { device: 'dev_1' } });
  assert.equal((await run).text, 'echo: hi');
  assert.deepEqual(deltas.map((d) => d.chunk), ['echo: hi']);
  assert.equal(lh.env.FAKE_LH_NO_DEVICE_FLAG, '1');
});

test('onDelta: a run that breaks off with an error event keeps the shown text but fails the turn', async () => {
  const { deltas, run } = await streamed('ndjson-error');
  await assert.rejects(run, (e) => e.code === 1 && /Agent run failed/.test(e.message));
  assert.deepEqual(deltas.map((d) => d.chunk), ['你好呀～', '今天的风']);
});

test('onDelta: a run that stops writing mid-reply times out (ETIMEDOUT) after the chunks it did write', async () => {
  const { deltas, run } = await streamed('ndjson-hang', { run: { timeoutMs: 800 } });
  await assert.rejects(run, { code: 'ETIMEDOUT' });
  assert.deepEqual(deltas.map((d) => d.chunk), ['你好呀～', '今天的风']);
});

test('onDelta: a throwing callback does not cost the turn', async () => {
  const { lh } = setup();
  lh.env.FAKE_LH_STREAM = 'ndjson';
  const r = await lh.run({ agentId: 'agt_1', prompt: 'hi', onDelta: () => { throw new Error('ui bug'); } });
  assert.equal(r.text, '你好呀～今天的风有点凉，要不要🍵喝杯热茶？');
});

test('createEventScanner: objects split anywhere, braces and quotes inside strings, non-JSON between objects', () => {
  const src = '[\n  {"type":"a","s":"{\\"x\\"}"},\n  {"type":"b","n":{"m":[{"k":1}]}}\n]\n[INFO] {not json}\n{"type":"c"}\n';
  for (let cut = 1; cut < src.length; cut++) {
    const got = [];
    const push = createEventScanner((e) => got.push(e.type));
    push(src.slice(0, cut));
    push(src.slice(cut));
    assert.deepEqual(got, ['a', 'b', 'c'], `cut at ${cut}`);
  }
});

test('parseRunEvents also reads one event per line', () => {
  const out = parseRunEvents([{ type: 'stream_start', data: { assistantMessage: { topicId: 'tpc_9' } } }, { type: 'stream_end', data: { finalContent: '嗨', usage: { cost: 1 } } }].map((e) => JSON.stringify(e)).join('\n'));
  assert.deepEqual(out, { text: '嗨', topicId: 'tpc_9', cost: 1 });
});
