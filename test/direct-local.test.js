'use strict';
// Local abilities through the Responses API (core/responses-client.js) instead of `lh connect`.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const readLog = (dir, name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const myDevice = (id) => ({ deviceId: id, hostname: 'Mac', platform: process.platform, online: true, channels: [{ channel: 'desktop', connectedAt: new Date().toISOString() }] });

function fakeResponses({ available = true, fail = null } = {}) {
  const r = { runs: [], canceled: 0, available: () => available, cancel: () => { r.canceled++; } };
  r.run = async (args) => {
    r.runs.push(args);
    if (fail) throw fail;
    return { text: '找到了，在桌面', topicId: args.topicId || 'tpc_DIRECT', cost: null };
  };
  return r;
}

async function hatched(responses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petdirect-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: new Date('2026-01-05T14:00:00').getTime() };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, responses, store: new Store(path.join(dir, 'data')), now: () => clock.t, rnd: () => 0.5 });
  const errors = [];
  svc.on('error', (e) => errors.push(e));
  await svc.hatch({ speciesId: 'testchan', name: 'E' });
  return { dir, clock, svc, errors };
}

test('with the direct path up, turning local abilities on needs no device and turns go to the Responses API', async () => {
  const responses = fakeResponses();
  const { svc, dir } = await hatched(responses);
  const runsBefore = readLog(dir, 'runs.log').length;
  const r = await svc.setLocalAbilities(true);
  assert.deepEqual(r, { ok: true, via: 'direct' });
  assert.equal(fs.existsSync(path.join(dir, 'daemon-started')), false);
  assert.equal(readLog(dir, 'edits.log').some((e) => e.agencyConfig), false); // nothing bound
  const res = await svc.chat('帮我找一下桌面上的报销单');
  assert.equal(res.text, '找到了，在桌面');
  assert.equal(readLog(dir, 'runs.log').length, runsBefore); // no `lh agent run`
  const run = responses.runs.pop();
  assert.equal(run.agentId, svc._c().agentId);
  assert.equal(run.topicId, svc._c().topicId); // same chat history as `lh agent run`
  assert.ok(run.tools.length > 0);
  assert.match(run.prompt, /\[本机\]/);
});

test('without local abilities turns stay on `lh agent run`', async () => {
  const responses = fakeResponses();
  const { svc, dir } = await hatched(responses);
  await svc.chat('在吗');
  assert.equal(responses.runs.length, 0);
  assert.match(readLog(dir, 'runs.log').pop().prompt, /在吗/);
});

test('no readable CLI login: local abilities use `lh connect` as before', async () => {
  const responses = fakeResponses({ available: false });
  const { svc, dir } = await hatched(responses);
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify([myDevice('dev_MAC')]));
  assert.deepEqual(await svc.setLocalAbilities(true), { ok: true, via: 'daemon' });
  await svc.chat('看看');
  assert.equal(responses.runs.length, 0);
  assert.deepEqual(readLog(dir, 'runs.log').pop().tools, ['lobe-local-system']);
});

test('a direct turn that fails before any tool ran is sent again through `lh connect`, which then stays for a while', async () => {
  const responses = fakeResponses({ fail: Object.assign(new Error('Responses API HTTP 502'), { code: 'EAPI', toolsRan: false }) });
  const { svc, dir, errors, clock } = await hatched(responses);
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify([myDevice('dev_MAC')]));
  await svc.setLocalAbilities(true);
  const res = await svc.chat('看看');
  assert.equal(res.ok, true);
  assert.equal(responses.runs.length, 1);
  const run = readLog(dir, 'runs.log').pop();
  assert.deepEqual(run.tools, ['lobe-local-system']);
  assert.match(run.prompt, /看看/);
  assert.equal(svc.localVia, 'daemon');
  assert.match(svc.localWarning, /lh connect/);
  assert.ok(errors.some((e) => /502/.test(e.message)));
  await svc.chat('再看看');
  assert.equal(responses.runs.length, 1); // not retried right away
  clock.t += 6 * 60 * 1000;
  responses.run = async (args) => { responses.runs.push(args); return { text: 'ok', topicId: args.topicId }; };
  await svc.chat('现在呢');
  assert.equal(responses.runs.length, 2); // back on the direct path
  assert.equal(svc.localVia, 'direct');
});

test('once a local tool ran, a failed direct turn is not repeated another way', async () => {
  const responses = fakeResponses({ fail: Object.assign(new Error('Responses API: boom'), { code: 'EAPI', toolsRan: true }) });
  const { svc, dir } = await hatched(responses);
  await svc.setLocalAbilities(true);
  const before = readLog(dir, 'runs.log').length;
  const res = await svc.chat('删掉临时文件');
  assert.equal(res.ok, false);
  assert.match(res.message, /boom/);
  assert.equal(readLog(dir, 'runs.log').length, before);
});

test('Stop cancels the direct request too', async () => {
  const responses = fakeResponses();
  let release;
  responses.run = (args) => new Promise((_, reject) => { release = reject; responses.runs.push(args); });
  responses.cancel = () => release(Object.assign(new Error('Canceled'), { code: 'ECANCELED' }));
  const { svc } = await hatched(responses);
  await svc.setLocalAbilities(true);
  const p = svc.chat('慢慢找');
  await new Promise((r) => setTimeout(r, 50));
  svc.cancel();
  assert.deepEqual(await p, { ok: false, reason: 'canceled' });
});

test('重新开始话题 on the direct path: the next Responses turn goes without previous_response_id (a new topic), then continues it', async () => {
  const responses = fakeResponses();
  const { svc } = await hatched(responses);
  await svc.setLocalAbilities(true);
  await svc.chat('第一句');
  const old = svc._c().topicId;
  assert.ok(old);
  assert.equal(svc.newTopic().ok, true);
  responses.run = async (args) => {
    responses.runs.push(args);
    return { text: '好呀', topicId: args.topicId || 'tpc_DIRECT_NEW', cost: null };
  };
  await svc.chat('新话题');
  assert.equal(responses.runs.pop().topicId, null);
  assert.equal(svc._c().topicId, 'tpc_DIRECT_NEW');
  assert.deepEqual(svc._c().pastTopicIds, [old]);
  await svc.chat('接着聊');
  assert.equal(responses.runs.pop().topicId, 'tpc_DIRECT_NEW');
});
