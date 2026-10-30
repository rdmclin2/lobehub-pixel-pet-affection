'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seed } = require('../scripts/demo');

// npm run demo: the save it prepares opens straight on a hatched pet (no 18+ gate, no login)
test('demo seed answers the age gate and hatches the chosen character with the fake lh, once', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-demo-'));
  const fakeDir = path.join(dataDir, 'fake-lh');
  fs.mkdirSync(fakeDir);
  assert.equal(await seed({ dataDir, fakeDir, speciesId: 'gpt', name: '小杰' }), true);
  const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(settings.answered, true);
  assert.equal(settings.adultContent, false);
  const pet = JSON.parse(fs.readFileSync(path.join(dataDir, 'pet.json'), 'utf8'));
  assert.equal(pet.speciesId, 'gpt');
  const c = pet.characters.gpt;
  assert.equal(c.name, '小杰');
  assert.match(c.agentId, /^agt_FAKE/);
  // a second run keeps the save instead of hatching again
  assert.equal(await seed({ dataDir, fakeDir, speciesId: 'claude', name: '' }), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'pet.json'), 'utf8')).characters.gpt.agentId, c.agentId);
});
