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
