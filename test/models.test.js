'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../src/core/models');
const { SPECIES } = require('../src/core/species');
const { PetService } = require('../src/main/pet-service');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { SettingsStore, normalizeSettings } = require('../src/core/settings');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const m = (providerId, id, extra = {}) => ({ providerId, id, displayName: id, enabled: true, type: 'chat', abilities: {}, ...extra });
const CATALOG = [
  m('lobehub', 'deepseek-flash'), m('lobehub', 'claude-opus-5-5'), m('lobehub', 'claude-sonnet-5-5'), m('lobehub', 'grok-4.7'),
  m('lobehub', 'gemini-3.8-flash'), m('lobehub', 'gemini-3.1-flash-image', { abilities: { imageOutput: true } }), m('lobehub', 'gemini-old', { enabled: false }),
  m('lobehub', 'gpt-6-sol'), m('lobehub', 'glm-5.3'), m('openai', 'gpt-6-sol'), m('openai', 'o3'), m('openai', 'text-embedding-3', { type: 'embedding' }),
];

test('every character only gets her own vendor\'s chat models', () => {
  const ids = (sp) => M.optionsFor(sp, CATALOG).map((o) => o.key);
  assert.deepEqual(ids('dafeiyu'), ['lobehub:deepseek-flash']);
  assert.deepEqual(ids('claude'), ['lobehub:claude-opus-5-5', 'lobehub:claude-sonnet-5-5']);
  assert.deepEqual(ids('grok'), ['lobehub:grok-4.7']);
  assert.deepEqual(ids('gemini'), ['lobehub:gemini-3.8-flash'], 'no image-only or disabled model');
  assert.deepEqual(ids('gpt'), ['lobehub:gpt-6-sol', 'openai:gpt-6-sol', 'openai:o3'], 'hosted first, then her own provider; no embedding model');
  assert.ok(!Object.keys(SPECIES).some((sp) => ids(sp).includes('lobehub:glm-5.3')), 'a model of no roster vendor is offered to nobody');
  for (const sp of ['dafeiyu', 'claude', 'grok', 'gemini', 'gpt']) assert.ok(SPECIES[sp].models, `${sp} declares her models`);
});

test('the pick: the user\'s choice if still offered, else her preferred default, else the first one', () => {
  const opts = M.optionsFor('claude', CATALOG);
  assert.equal(M.pick('claude', opts, null).key, 'lobehub:claude-sonnet-5-5', 'prefer list, not the priciest first entry');
  assert.equal(M.pick('claude', opts, 'lobehub:claude-opus-5-5').key, 'lobehub:claude-opus-5-5');
  assert.equal(M.pick('claude', opts, 'lobehub:gpt-6-sol').key, 'lobehub:claude-sonnet-5-5', 'another vendor\'s model is never used');
  assert.equal(M.pick('grok', M.optionsFor('grok', []), null), null, 'nothing to offer: keep the agent\'s model');
  assert.deepEqual(M.providersToQuery(['lobehub', 'openai', 'fal', 'glmcodingplan']), ['lobehub', 'openai']);
});

test('settings keep one valid model choice per character', () => {
  const s = normalizeSettings({ models: { claude: 'lobehub:claude-opus-5-5', gpt: 'openai:o3', bad: 'no colon', '../x': 'lobehub:a' } });
  assert.deepEqual(s.models, { claude: 'lobehub:claude-opus-5-5', gpt: 'openai:o3' });
  assert.deepEqual(normalizeSettings({}).models, {});
});

// ---- PetService with the fake lh -----------------------------------------------------------------
function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petmodels-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: new Date('2026-01-05T14:00:00').getTime() };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir, ...env } });
  const data = path.join(dir, 'data');
  const mk = () => {
    const s = new PetService({ lh, store: new Store(data), settingsStore: new SettingsStore(data), now: () => clock.t, rnd: () => 0.5 });
    s.on('error', () => {});
    return s;
  };
  const edits = () => (fs.existsSync(path.join(dir, 'edits.log')) ? fs.readFileSync(path.join(dir, 'edits.log'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.model) : []);
  const lists = () => (fs.existsSync(path.join(dir, 'model-lists.log')) ? fs.readFileSync(path.join(dir, 'model-lists.log'), 'utf8').trim().split('\n').length : 0);
  return { dir, clock, svc: mk(), mk, edits, lists };
}

test('a new pet runs on her character\'s default model before her first words', async () => {
  const { svc, edits } = setup();
  const { view } = await svc.hatch({ speciesId: 'claude', name: '小克' });
  assert.deepEqual(edits().map((e) => `${e.provider}:${e.model}`), ['lobehub:claude-sonnet-5-5']);
  assert.equal(view.model.current, 'lobehub:claude-sonnet-5-5');
  assert.equal(view.model.applied, 'lobehub:claude-sonnet-5-5');
  assert.equal(view.model.chosen, false, 'a default, not a pick');
  assert.deepEqual(view.model.options.map((o) => o.id), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
});

test('switching character moves the agent to the new character\'s models, and each keeps her own pick', async () => {
  const { svc, edits } = setup();
  await svc.hatch({ speciesId: 'claude', name: '小克' });
  const opus = svc.setModel('lobehub:claude-opus-5-5');
  assert.equal(opus.ok, true);
  await new Promise((r) => setTimeout(r, 300)); // applied in the background
  assert.equal(svc.setModel('lobehub:gpt-6-sol').reason, 'unknown', 'Claude cannot pick a GPT model');

  const sw = svc.switchCharacter('gpt');
  assert.equal(sw.view.model.current, 'lobehub:gpt-6-luna', 'GPT 娘\'s default, shown right away');
  assert.ok(sw.view.model.options.every((o) => /^(gpt-|o\d)/.test(o.id)));
  assert.ok(sw.view.model.options.some((o) => o.key === 'openai:gpt-6-luna' && !o.hosted), 'her own OpenAI key is offered too');
  await svc.chat('你好');
  assert.equal(svc.setModel('openai:o3').ok, true);
  await new Promise((r) => setTimeout(r, 300));

  svc.switchCharacter('claude');
  assert.equal(svc.view().model.current, 'lobehub:claude-opus-5-5', 'Claude\'s own pick comes back');
  await svc.chat('回来啦');
  assert.deepEqual(edits().map((e) => `${e.provider}:${e.model}`), ['lobehub:claude-sonnet-5-5', 'lobehub:claude-opus-5-5', 'lobehub:gpt-6-luna', 'openai:o3', 'lobehub:claude-opus-5-5']);
});

test('the pick survives a restart and is not re-applied when nothing changed', async () => {
  const { svc, mk, edits } = setup();
  await svc.hatch({ speciesId: 'gemini', name: '小杰' });
  await svc.chat('早');
  const before = edits().length;
  const again = mk();
  again.init();
  await again.warmup();
  await again.chat('还在吗');
  assert.equal(edits().length, before, 'already on that model');
  assert.equal(again.view().model.applied, 'lobehub:gemini-3.8-flash');
});

test('an lh without model commands: chat still works and the agent keeps its model; no retry every turn', async () => {
  const { svc, clock, edits, dir } = setup({ FAKE_LH_NO_MODELS: '1' });
  const { view } = await svc.hatch({ speciesId: 'grok', name: '小格' });
  assert.equal(view.model.loaded, false);
  assert.match(view.model.error, /unknown command/);
  const r = await svc.chat('在吗');
  assert.equal(r.ok, true, 'the agent answers on its current model');
  assert.deepEqual(edits(), []);
  const runs = () => fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').length;
  const n = runs();
  clock.t += 60 * 1000; // within the 10-minute back-off
  await svc.chat('再说一句');
  assert.equal(runs(), n + 1);
});

test('the model list is reused for ten minutes, then read again', async () => {
  const { svc, clock, lists } = setup();
  await svc.hatch({ speciesId: 'dafeiyu', name: '小蓝' });
  const first = lists();
  assert.equal(first, 2, 'lobehub + the enabled openai provider');
  await svc.chat('一');
  assert.equal(lists(), first);
  clock.t += 11 * 60 * 1000;
  await svc.chat('二');
  assert.equal(lists(), first * 2);
});
