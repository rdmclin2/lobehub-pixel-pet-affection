'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ResponsesClient, LOCAL_FUNCTION_TOOLS, runLocalTool, readCliCredentials, serverUrl } = require('../src/core/responses-client');

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const reply = (id, text) => ({ id, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], output_text: text });
const parked = (id, calls) => ({ id, status: 'incomplete', output: calls.map(([callId, name, args]) => ({ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) })) });

function client({ answers = [], lh = {}, env = { LOBEHUB_SERVER: 'https://hub.test/' }, creds = { accessToken: 'tok' }, runTool } = {}) {
  const sent = [];
  const queue = [...answers];
  const fetchImpl = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const next = queue.shift();
    return typeof next === 'function' ? next(init) : next;
  };
  const fakeLh = { workspaceId: null, whoami: async () => ({}), pinnedWorkspace: async () => null, ...lh };
  const ran = [];
  const c = new ResponsesClient({ lh: fakeLh, fetchImpl, env, readCredentials: () => (typeof creds === 'function' ? creds() : creds), runTool: runTool || (async (name, args) => { ran.push({ name, args }); return `ok:${name}`; }) });
  return { c, sent, ran };
}

test('a turn without tool calls is one request: agent as model, the topic as previous response, no server tools', async () => {
  const { c, sent } = client({ answers: [json(reply('tpc_1', ' 在呢～ '))] });
  const r = await c.run({ agentId: 'agt_1', topicId: 'tpc_1', prompt: 'hi', tools: ['lobe-local-system'] });
  assert.deepEqual(r, { text: '在呢～', topicId: 'tpc_1', cost: null });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://hub.test/api/v1/responses');
  assert.equal(sent[0].headers.Authorization, 'Bearer tok');
  assert.equal(sent[0].headers['X-Workspace-Id'], undefined); // personal space
  assert.equal(sent[0].body.model, 'agt_1');
  assert.equal(sent[0].body.previous_response_id, 'tpc_1');
  assert.equal(sent[0].body.tools_mode, 'exclusive');
  assert.deepEqual(sent[0].body.tools.map((t) => t.name), LOCAL_FUNCTION_TOOLS.map((t) => t.name));
});

test('a parked tool call runs here and its output resumes the same run strictly', async () => {
  const { c, sent, ran } = client({ answers: [json(parked('tpc_9', [['call_a', 'list_directory', { path: '~/Desktop' }], ['call_b', 'read_file', { path: '/x.txt' }]])), json(reply('tpc_9', '找到了'))] });
  const r = await c.run({ agentId: 'agt_1', topicId: null, prompt: '找报销单', tools: ['lobe-local-system'] });
  assert.equal(r.text, '找到了');
  assert.equal(r.topicId, 'tpc_9'); // a new topic comes back as the response id
  assert.deepEqual(ran.map((x) => x.name), ['list_directory', 'read_file']);
  assert.equal(sent[0].body.previous_response_id, undefined);
  assert.deepEqual(sent[1].body.input, [
    { type: 'function_call_output', call_id: 'call_a', output: 'ok:list_directory' },
    { type: 'function_call_output', call_id: 'call_b', output: 'ok:read_file' },
  ]);
  assert.equal(sent[1].body.previous_response_id, 'tpc_9');
  assert.equal(sent[1].body.strict_tool_resume, true);
});

test('a failing tool is reported to the model as an error, not thrown', async () => {
  const { c, sent } = client({ answers: [json(parked('tpc_1', [['c1', 'read_file', { path: '/nope' }]])), json(reply('tpc_1', '没找到'))], runTool: async () => { throw new Error('ENOENT'); } });
  assert.equal((await c.run({ agentId: 'a', topicId: 'tpc_1', prompt: 'p', tools: ['x'] })).text, '没找到');
  assert.equal(sent[1].body.input[0].output, 'Error: ENOENT');
});

test('without local abilities no tools are offered', async () => {
  const { c, sent } = client({ answers: [json(reply('tpc_1', 'ok'))] });
  await c.run({ agentId: 'a', topicId: 'tpc_1', prompt: 'p' });
  assert.deepEqual(sent[0].body.tools, []);
});

test('the pet\'s workspace goes in X-Workspace-Id; an old pet without a space uses lh\'s saved scope', async () => {
  const a = client({ answers: [json(reply('t', 'ok'))], lh: { workspaceId: 'ws_1' } });
  await a.c.run({ agentId: 'a', prompt: 'p' });
  assert.equal(a.sent[0].headers['X-Workspace-Id'], 'ws_1');
  let lookups = 0;
  const b = client({ answers: [json(reply('t', 'ok')), json(reply('t', 'ok'))], lh: { workspaceId: undefined, pinnedWorkspace: async () => { lookups++; return 'ws_pin'; } } });
  await b.c.run({ agentId: 'a', prompt: 'p' });
  await b.c.run({ agentId: 'a', prompt: 'p' });
  assert.equal(b.sent[1].headers['X-Workspace-Id'], 'ws_pin');
  assert.equal(lookups, 1);
});

test('an expired login is refreshed through lh before the request; LOBEHUB_CLI_API_KEY wins over it', async () => {
  let stored = { accessToken: 'old', expiresAt: 1 };
  let whoami = 0;
  const a = client({ answers: [json(reply('t', 'ok'))], creds: () => stored, lh: { whoami: async () => { whoami++; stored = { accessToken: 'new', expiresAt: Date.now() / 1000 + 3600 }; } } });
  await a.c.run({ agentId: 'a', prompt: 'p' });
  assert.equal(whoami, 1);
  assert.equal(a.sent[0].headers.Authorization, 'Bearer new');
  const b = client({ answers: [json(reply('t', 'ok'))], env: { LOBEHUB_CLI_API_KEY: 'sk-key' }, creds: null });
  assert.equal(b.c.available(), true);
  await b.c.run({ agentId: 'a', prompt: 'p' });
  assert.equal(b.sent[0].headers.Authorization, 'Bearer sk-key');
  assert.equal(client({ creds: null, env: {} }).c.available(), false);
});

test('errors carry a code, and say whether a local tool already ran', async () => {
  const http = client({ answers: [json({ error: 'nope' }, 404)] });
  await assert.rejects(http.c.run({ agentId: 'a', prompt: 'p', tools: ['x'] }), (e) => e.code === 'EAPI' && e.status === 404 && e.toolsRan === false);
  const auth = client({ answers: [json({}, 401)] });
  await assert.rejects(auth.c.run({ agentId: 'a', prompt: 'p' }), { code: 'EAUTH' });
  const net = client({ answers: [() => { throw new TypeError('fetch failed'); }] });
  await assert.rejects(net.c.run({ agentId: 'a', prompt: 'p' }), { code: 'ENET' });
  const late = client({ answers: [json(parked('t', [['c1', 'run_command', { command: 'ls' }]])), json({ id: 'x', status: 'failed', error: { message: 'boom' } })] });
  await assert.rejects(late.c.run({ agentId: 'a', prompt: 'p', tools: ['x'] }), (e) => e.code === 'EAPI' && e.toolsRan === true && /boom/.test(e.message));
});

test('cancel() aborts the request in flight', async () => {
  const { c } = client({ answers: [(init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))] });
  const p = c.run({ agentId: 'a', prompt: 'p' });
  setTimeout(() => c.cancel(), 20);
  await assert.rejects(p, { code: 'ECANCELED' });
});

test('local tools read, list, write and run on this computer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-tools-'));
  const signal = new AbortController().signal;
  assert.match(await runLocalTool('write_file', { path: path.join(dir, 'a', 'b.txt'), content: '你好' }, signal), /wrote 6 bytes/);
  assert.equal(await runLocalTool('read_file', { path: path.join(dir, 'a', 'b.txt') }, signal), '你好');
  assert.equal(await runLocalTool('list_directory', { path: dir }, signal), 'a/');
  assert.match(await runLocalTool('run_command', { command: 'echo hi', cwd: dir }, signal), /^exit 0\nhi/);
  await assert.rejects(runLocalTool('read_file', { path: dir }, signal), /not a regular file/);
});

test('reads the CLI login in its encrypted format and in the old plain JSON; the server from its settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-clihome-'));
  const rel = path.relative(os.homedir(), home);
  const env = { LOBEHUB_CLI_HOME: rel };
  const key = crypto.pbkdf2Sync('lobehub-cli:host:me', 'lobehub-cli-salt', 100000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify({ accessToken: 'secret', expiresAt: 9 })), cipher.final()]);
  fs.writeFileSync(path.join(home, 'credentials.json'), Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64'));
  assert.deepEqual(readCliCredentials({ env, hostname: 'host', username: 'me' }), { accessToken: 'secret', expiresAt: 9 });
  assert.equal(readCliCredentials({ env, hostname: 'other', username: 'me' }), null); // another machine's file
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ accessToken: 'plain' }));
  assert.equal(readCliCredentials({ env }).accessToken, 'plain');
  assert.equal(serverUrl(env), 'https://app.lobehub.com');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ serverUrl: 'https://self.host/' }));
  assert.equal(serverUrl(env), 'https://self.host');
});

// ---- streaming (stream: true, onDelta) ----------------------------------------------------------------
const { createSseParser } = require('../src/core/responses-client');
const sample = (n) => require(path.join(__dirname, 'fixtures', 'streaming', n));
const rawSse = (n) => sample(n).reads.map((r) => r.text).join('');
const sseBlock = (event, data) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
// A streamed answer cut every `slice` bytes, so cuts land inside SSE lines, JSON and UTF-8 characters.
// `real`: a real fetch Response over a ReadableStream (reader path); otherwise an async iterable body.
function sse(text, { slice = 5, real = false, tail = null } = {}) {
  const bytes = Buffer.from(text, 'utf8');
  const parts = [];
  for (let i = 0; i < bytes.length; i += slice) parts.push(new Uint8Array(bytes.subarray(i, i + slice)));
  if (real) {
    const body = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
    return () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  }
  return (init) => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: (async function* () {
      for (const p of parts) {
        await new Promise((r) => setImmediate(r));
        yield p;
      }
      if (tail) await tail(init);
    })(),
  });
}
const completed = (id, text, usage) => [
  sseBlock('response.created', { response: { id, status: 'in_progress', output: [] } }),
  ...[...text].reduce((acc, ch, i) => (i % 3 ? acc.with(-1, acc.at(-1) + ch) : [...acc, ch]), []).map((d) => sseBlock('response.output_text.delta', { item_id: `msg_${id}`, output_index: 0, delta: d })),
  sseBlock('response.output_text.done', { item_id: `msg_${id}`, output_index: 0, text }),
  sseBlock('response.output_item.done', { output_index: 0, item: { type: 'message', id: `msg_${id}`, content: [{ type: 'output_text', text }] } }),
  sseBlock('response.completed', { response: { id, status: 'completed', output: [{ type: 'message', id: `msg_${id}`, content: [{ type: 'output_text', text }] }], usage } }),
].join('');
const collect = () => {
  const deltas = [];
  return { deltas, onDelta: (chunk, full) => deltas.push({ chunk, full }) };
};

test('stream: the recorded long SSE answer, cut every 5 bytes, streams its 12 deltas and returns the same result', async () => {
  const rec = sample('responses-sse-long.json');
  const expected = rec.events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta);
  for (const real of [false, true]) {
    const { c, sent } = client({ answers: [sse(rawSse('responses-sse-long.json'), { real })] });
    const { deltas, onDelta } = collect();
    const r = await c.run({ agentId: 'agt_1', topicId: 'tpc_REDACTED1', prompt: '写秋天', onDelta });
    assert.equal(sent[0].body.stream, true);
    assert.equal(sent[0].headers.Accept, 'text/event-stream');
    assert.equal(deltas.length, 12);
    assert.deepEqual(deltas.map((d) => d.chunk), expected, 'multi-byte characters cut between reads stay whole');
    assert.ok(deltas.every((d) => !d.chunk.includes('�')));
    const done = rec.events.find((e) => e.event === 'response.output_text.done').data.text;
    assert.equal(deltas.at(-1).full, done);
    assert.deepEqual(r, { text: done.trim(), topicId: 'tpc_REDACTED1', cost: null });
  }
});

test('stream: a parked tool call (recorded sample) streams its preamble, runs the tool here, and the resumed round streams on', async () => {
  const { c, sent, ran } = client({ answers: [sse(rawSse('responses-sse-tool.json'), { slice: 3 }), sse(completed('tpc_REDACTED1', '/tmp 里有 a 和 b 两个文件夹。', { cost: 0.01 }))] });
  const { deltas, onDelta } = collect();
  const r = await c.run({ agentId: 'agt_1', prompt: '先说我看看，再列 /tmp', tools: ['lobe-local-system'], onDelta });
  assert.deepEqual(ran, [{ name: 'list_directory', args: { path: '/tmp' } }], 'the call is taken from output_item.done: response.incomplete lists no output');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.stream, true);
  assert.equal(sent[1].body.strict_tool_resume, true);
  assert.equal(sent[1].body.previous_response_id, 'tpc_REDACTED1');
  assert.deepEqual(sent[1].body.input, [{ type: 'function_call_output', call_id: 'call_REDACTED1', output: 'ok:list_directory' }]);
  assert.equal(deltas[0].chunk, '我看看');
  assert.ok(deltas[1].chunk.startsWith('\n\n'), 'the next round starts after a paragraph break');
  assert.equal(deltas.at(-1).full, '我看看\n\n/tmp 里有 a 和 b 两个文件夹。');
  assert.deepEqual(r, { text: '/tmp 里有 a 和 b 两个文件夹。', topicId: 'tpc_REDACTED1', cost: 0.01 });
});

test('stream: a server that answers plain JSON anyway is read the old way, onDelta gets the reply once', async () => {
  const { c, sent } = client({ answers: [json(reply('tpc_1', ' 在呢～ '))] });
  const { deltas, onDelta } = collect();
  const r = await c.run({ agentId: 'agt_1', topicId: 'tpc_1', prompt: 'hi', onDelta });
  assert.equal(sent[0].body.stream, true);
  assert.deepEqual(r, { text: '在呢～', topicId: 'tpc_1', cost: null });
  assert.deepEqual(deltas, [{ chunk: ' 在呢～ ', full: ' 在呢～ ' }]);
});

test('without onDelta the request stays stream:false', async () => {
  const { c, sent } = client({ answers: [json(reply('tpc_1', 'ok'))] });
  await c.run({ agentId: 'a', prompt: 'p' });
  assert.equal(sent[0].body.stream, false);
  assert.equal(sent[0].headers.Accept, undefined);
});

test('stream: errors in the middle of a stream fail the turn with a code, after the text already shown', async () => {
  const head = sseBlock('response.created', { response: { id: 'tpc_1', status: 'in_progress' } }) + sseBlock('response.output_text.delta', { item_id: 'm', delta: '你好' });
  const cases = [
    ['response.failed', head + sseBlock('response.failed', { response: { id: 'tpc_1', status: 'failed', error: { message: 'model overloaded' } } }), (e) => e.code === 'EAPI' && /model overloaded/.test(e.message)],
    ['error event', head + sseBlock('error', { message: 'rate limited' }), (e) => e.code === 'EAPI' && /rate limited/.test(e.message)],
    ['cut short', head, (e) => e.code === 'EAPI' && /ended before/.test(e.message)],
  ];
  for (const [name, text, check] of cases) {
    const { c } = client({ answers: [sse(text)] });
    const { deltas, onDelta } = collect();
    await assert.rejects(c.run({ agentId: 'a', prompt: 'p', onDelta }), check, name);
    assert.deepEqual(deltas.map((d) => d.chunk), ['你好'], name);
  }
  const dropped = client({ answers: [sse(head, { tail: async () => { throw new TypeError('terminated'); } })] });
  await assert.rejects(dropped.c.run({ agentId: 'a', prompt: 'p', onDelta: () => {} }), { code: 'ENET' });
});

test('stream: cancel() stops reading a stream that is still coming', async () => {
  const head = sseBlock('response.created', { response: { id: 'tpc_1', status: 'in_progress' } }) + sseBlock('response.output_text.delta', { item_id: 'm', delta: '想一' });
  const waitAbort = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const { c } = client({ answers: [sse(head, { tail: waitAbort })] });
  const { deltas, onDelta } = collect();
  const p = c.run({ agentId: 'a', prompt: 'p', onDelta });
  setTimeout(() => c.cancel(), 50);
  await assert.rejects(p, { code: 'ECANCELED' });
  assert.deepEqual(deltas.map((d) => d.chunk), ['想一']);
});

test('createSseParser: CRLF, comments, multi-line data and any byte cut through a Chinese payload', () => {
  const text = ': keep-alive\r\nevent: response.output_text.delta\r\ndata: {"delta":\r\ndata: "秋天🍁来了"}\r\n\r\nevent: x\ndata: not json\n\ndata: {"type":"response.completed","response":{"id":"t"}}';
  const bytes = Buffer.from(text, 'utf8');
  for (let cut = 1; cut < bytes.length; cut++) {
    const got = [];
    const p = createSseParser((type, data) => got.push([type, data.delta || data.response.id]));
    p.push(new Uint8Array(bytes.subarray(0, cut)));
    p.push(new Uint8Array(bytes.subarray(cut)));
    p.end();
    assert.deepEqual(got, [['response.output_text.delta', '秋天🍁来了'], ['response.completed', 't']], `cut at ${cut}`);
  }
});

test('stream: a throwing onDelta does not cost the turn', async () => {
  const { c } = client({ answers: [sse(completed('tpc_1', '好的'))] });
  assert.equal((await c.run({ agentId: 'a', prompt: 'p', onDelta: () => { throw new Error('ui'); } })).text, '好的');
});
