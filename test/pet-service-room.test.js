'use strict';
// 像素房间 · PetService (docs/her-room-design.md §3.2): roomStats / roomSettle change only her energy, mood and
// hunger, never put her to sleep on the desktop, save and push `update`; roomLooks gives the room's owner the
// outfit her room asks for.
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
async function hatched(speciesId = 'dafeiyu') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petsvc-room-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const clock = { t: new Date('2026-11-05T14:00:00').getTime() };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), now: () => clock.t, rnd: () => 0.5 });
  svc.on('error', () => {});
  await svc.hatch({ speciesId, name: '大肥鱼' });
  return { svc, dir, clock };
}

test('roomStats: 精力 / 心情 and 饱腹 = 100 − hunger of her base', async () => {
  const { svc } = await hatched();
  const c = svc._c();
  c.energy = 61; c.mood = 42; c.hunger = 30;
  assert.deepEqual(svc.roomStats(), { base: 'dafeiyu', energy: 61, mood: 42, fullness: 70 });
});

test('roomSettle: only the three numbers, held to 0–100; not asleep; saved and pushed', async () => {
  const { svc, dir } = await hatched();
  const c = svc._c();
  c.sleeping = false;
  const before = { affection: c.affection, relStage: c.relStage, sleeping: c.sleeping };
  const updates = [];
  svc.on('update', (v) => updates.push(v));
  const r = svc.roomSettle({ energy: 140, mood: 12, fullness: -5, affection: 99 });
  assert.deepEqual(r, { base: 'dafeiyu', energy: 100, mood: 12, fullness: 0 });
  assert.equal(c.hunger, 100);
  assert.equal(c.affection, before.affection, 'affection is not the room’s to change');
  assert.equal(c.relStage, before.relStage);
  assert.equal(!!c.sleeping, false, 'sleeping in the room does not put her to sleep on the desktop');
  assert.equal(updates.length, 1, 'pushed once');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'pet.json'), 'utf8'));
  assert.equal(saved.characters.dafeiyu.energy, 100);
  assert.equal(saved.characters.dafeiyu.hunger, 100);
});

test('roomLooks: each room’s character (her daily look) and, in her own room, the owner in the room’s outfit', async () => {
  const { svc } = await hatched();
  const themes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'pixel-room', 'manifest.json'), 'utf8')).themes;
  const r = svc.roomLooks(themes);
  assert.deepEqual(Object.keys(r.characters).sort(), ['claude', 'dafeiyu', 'gemini', 'gpt', 'grok']);
  assert.equal(r.characters.dafeiyu.name, '大肥鱼');
  for (const c of Object.values(r.characters)) assert.ok(c.look && c.look.url, `${c.id} has a look`);
  assert.match(r.looks.dafeiyu.url, /daily/, 'the owner wears daily (招牌女仆装)');
  assert.deepEqual(Object.keys(r.looks), ['dafeiyu'], 'only open rooms whose owner she is');
  // as a guest (another base) she keeps her own look: no owner look
  const g = await hatched('claude');
  assert.deepEqual(g.svc.roomLooks(themes).looks, {});
});
