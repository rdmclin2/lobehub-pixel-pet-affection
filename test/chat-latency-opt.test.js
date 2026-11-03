'use strict';

// 聊天窗口响应优化 (docs/admin-chat-latency.md §7, T-2818): what was taken off the path before the request, and
// that nothing the chat page relies on changed with it.
//   - the model list is stale-while-revalidate: a list past MODELS_TTL_MS no longer holds the turn (R2); the
//     reload runs in the background and its result is applied from the next turn; with no list yet it waits
//   - the chat page opening (chatCharacters) reloads a stale list in the background
//   - the CLI credentials key (PBKDF2) is derived once, not before every direct turn
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const chatLog = require('../src/core/chat-log');
const { readCliCredentials } = require('../src/core/responses-client');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-latopt-'));
const TEN_MIN = 10 * 60 * 1000;

async function setup() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: new Date('2026-01-05T09:00:00').getTime() };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), now: () => clock.t, rnd: () => 0.5, log: new chatLog.MemoryChatLog() });
  svc.on('error', () => {});
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  await svc.refreshModels({ force: true });
  // count the model-list loads, and hold one when asked (a slow `lh provider list`, ≈2.3 s in real life)
  const loads = { n: 0, gate: null };
  const orig = lh.listEnabledProviders.bind(lh);
  lh.listEnabledProviders = async () => {
    loads.n += 1;
    if (loads.gate) await loads.gate.promise;
    return orig();
  };
  const hold = () => {
    let release;
    loads.gate = { promise: new Promise((r) => { release = r; }) };
    return () => { const g = loads.gate; loads.gate = null; release(); return g; };
  };
  const calls = () => fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map(JSON.parse).map((c) => c.args);
  return { dir, clock, lh, svc, loads, hold, calls };
}

test('a model list past MODELS_TTL_MS does not hold the chat page turn: it is reloaded in the background', async () => {
  const { svc, clock, loads, hold } = await setup();
  assert.ok(svc._catalog && svc._catalog.length);
  clock.t += TEN_MIN + 1000; // stale
  const release = hold(); // the reload never finishes during the turn
  const r = await svc.chatAs('claude', { text: '在吗' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.message.text, 'echo: 在吗');
  assert.ok(r.message.model, 'the reply still records the model it ran on (from the cached list)');
  assert.equal(loads.n, 1, 'one background reload started');
  assert.ok(svc._catalogLoading, 'still reloading after the turn is over');
  release();
  await svc._catalogLoading;
  assert.equal(svc._modelsFresh(), true);
  // a second stale-free turn starts no reload
  await svc.chatAs('claude', { text: '再来' });
  assert.equal(loads.n, 1);
});

test('the desktop turn (_ensureReady) uses a stale list the same way', async () => {
  const { svc, clock, loads, hold } = await setup();
  clock.t += TEN_MIN + 1000;
  const release = hold();
  const r = await svc.chat('你好');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(loads.n, 1);
  release();
  await svc._catalogLoading;
  assert.equal(svc._modelsFresh(), true);
});

test('with no list yet the turn waits for it (her model must be known before the first request)', async () => {
  const { svc, loads } = await setup();
  svc._catalog = null;
  svc._catalogAt = 0;
  const r = await svc.chatAs('claude', { text: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(loads.n, 1);
  assert.ok(svc._catalog && svc._catalog.length, 'loaded before the turn went on');
  assert.ok(r.message.model);
});

test('a model picked while the list is stale is applied before that turn; a model that only the reload brings is applied from the next turn', async () => {
  const { svc, clock, calls } = await setup();
  const opts = svc.modelView('claude').options;
  const other = opts.find((o) => o.key !== svc.modelView('claude').current);
  clock.t += TEN_MIN + 1000;
  assert.equal(svc.setModel(other.key, 'claude').ok, true);
  const r = await svc.chatAs('claude', { text: 'hi' });
  assert.equal(r.message.model, other.key, 'the pick holds with a stale list');
  const agentId = svc.pet.characters.claude.agentId;
  const edit = calls().filter((a) => a[0] === 'agent' && a[1] === 'edit' && a[2] === agentId && a.includes('-m')).pop();
  assert.equal(edit[edit.indexOf('-m') + 1], other.id);
  await svc._catalogLoading;
  // the reload drops her pick: the next turn falls back to her default and applies it
  svc._catalog = svc._catalog.filter((m) => m.id !== other.id);
  const r2 = await svc.chatAs('claude', { text: 'hi again' });
  assert.notEqual(r2.message.model, other.key);
  assert.equal(svc.pet.characters.claude.modelApplied, r2.message.model);
});

test('opening the chat page (chatCharacters) reloads a stale list in the background, once; a fresh one is left alone', async () => {
  const { svc, clock, loads, hold } = await setup();
  svc.chatCharacters();
  assert.equal(loads.n, 0, 'fresh: nothing');
  clock.t += TEN_MIN + 1000;
  const release = hold();
  const v = svc.chatCharacters();
  assert.equal(v.ok, true, 'answers at once');
  svc.chatCharacters();
  assert.equal(loads.n, 1, 'one reload, however often the page asks');
  release();
  await svc._catalogLoading;
  svc.chatCharacters();
  assert.equal(loads.n, 1);
});

test('busy mutex and abort still hold while a background reload runs', async () => {
  const { svc, clock, hold } = await setup();
  clock.t += TEN_MIN + 1000;
  const release = hold();
  svc.busy = true;
  const busy = await svc.chatAs('claude', { text: 'x' });
  assert.equal(busy.reason, 'busy');
  svc.busy = false;
  assert.deepEqual(svc.chatAbort('claude'), { ok: true, aborted: false });
  release();
});

test('CLI credentials: the PBKDF2 key is derived once per host and user; the file is read every time', () => {
  const home = tmp();
  const env = { LOBEHUB_CLI_HOME: path.relative(os.homedir(), home) };
  const key = crypto.pbkdf2Sync('lobehub-cli:h1:u1', 'lobehub-cli-salt', 100000, 32, 'sha256');
  const write = (token) => {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([c.update(JSON.stringify({ accessToken: token })), c.final()]);
    fs.writeFileSync(path.join(home, 'credentials.json'), Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'));
  };
  write('tok1');
  const orig = crypto.pbkdf2Sync;
  let derived = 0;
  crypto.pbkdf2Sync = (...a) => { derived += 1; return orig(...a); };
  try {
    assert.equal(readCliCredentials({ env, hostname: 'h1', username: 'u1' }).accessToken, 'tok1');
    write('tok2'); // `lh` refreshed the login
    assert.equal(readCliCredentials({ env, hostname: 'h1', username: 'u1' }).accessToken, 'tok2');
    assert.equal(readCliCredentials({ env, hostname: 'h1', username: 'u1' }).accessToken, 'tok2');
    assert.equal(derived, 1, 'derived once for h1/u1');
    assert.equal(readCliCredentials({ env, hostname: 'h2', username: 'u1' }), null, 'another host: another key, cannot open it');
    assert.equal(derived, 2);
  } finally {
    crypto.pbkdf2Sync = orig;
  }
});

test('contentGuard still guards the chat page with a stale list: a blocked reply is never streamed, the refusal line is saved', async () => {
  const { svc, clock } = await setup();
  clock.t += TEN_MIN + 1000;
  const deltas = [];
  const r = await svc.chatAs('claude', { text: '我们来写床戏吧' }, { onDelta: (d) => deltas.push(d.text) }); // the fake lh echoes it back
  assert.equal(r.ok, true);
  assert.ok(deltas.every((t) => !/床戏/.test(t)), JSON.stringify(deltas));
  assert.match(r.message.text, /这个我不聊啦/);
  await svc._catalogLoading;
});
