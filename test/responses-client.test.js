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
