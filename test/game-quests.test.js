'use strict';
// 小游戏 · 每日小事 (src/core/game-quests.js, docs/mini-games.md §6)
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/core/game-quests');

const quests = [
  { id: 'water', title: '浇两次水', on: { type: 'use-end', obj: ['plot-a', 'plot-b'] }, count: 2 },
  { id: 'lamp', title: '夜里点灯', on: { type: 'use-end', obj: 'lamp', phase: ['night'] } },
  { id: 'rain', title: '雨天看池塘', on: { type: 'use-end', obj: 'pond', weather: ['rain', 'storm'] } },
  { id: 'fly', title: '抓萤火虫', on: { type: 'collect', item: 'firefly' }, count: 3 },
];

test('todays: DAILY quests a day, the same pick all day, another day another pick', () => {
  const a = Q.todays(quests, '2026-11-05').map((q) => q.id);
  assert.equal(a.length, Q.DAILY);
  assert.deepEqual(Q.todays(quests, '2026-11-05').map((q) => q.id), a);
  const days = new Set(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((d) => Q.todays(quests, d).map((q) => q.id).join()));
  assert.ok(days.size > 1);
});

test('record: counts matching events, a quest is done once at its count; phase and weather must match', () => {
  const all = quests.map((q) => ({ ...q, always: true }));
  const day = '2026-11-05';
  let p = {};
  let r = Q.record(all, p, { type: 'use-end', obj: 'plot-a' }, { day });
  assert.equal(r.completed.length, 0);
  r = Q.record(all, r.progress, { type: 'use-end', obj: 'plot-b' }, { day });
  assert.deepEqual(r.completed.map((q) => q.id), ['water']);
  r = Q.record(all, r.progress, { type: 'use-end', obj: 'plot-b' }, { day });
  assert.equal(r.completed.length, 0, 'once');
  r = Q.record(all, r.progress, { type: 'use-end', obj: 'lamp' }, { day, phase: 'day' });
  assert.equal(r.completed.length, 0, 'not at night');
  r = Q.record(all, r.progress, { type: 'use-end', obj: 'lamp' }, { day, phase: 'night' });
  assert.deepEqual(r.completed.map((q) => q.id), ['lamp']);
  r = Q.record(all, r.progress, { type: 'use-end', obj: 'pond' }, { day, weather: 'clear' });
  assert.equal(r.completed.length, 0);
  r = Q.record(all, r.progress, { type: 'use-end', obj: 'pond' }, { day, weather: 'storm' });
  assert.deepEqual(r.completed.map((q) => q.id), ['rain']);
  for (let i = 0; i < 3; i++) r = Q.record(all, r.progress, { type: 'collect', item: 'firefly' }, { day });
  assert.deepEqual(r.completed.map((q) => q.id), ['fly']);
  assert.equal(r.progress.total, 4);
  assert.equal(r.progress.items.firefly, 3);
  p = r.progress;
  const v = Q.view(all, p, day);
  assert.ok(v.every((q) => q.done));
  // a new day: counts start over, totals stay
  const next = Q.record(all, p, { type: 'use-end', obj: 'plot-a' }, { day: '2026-11-06' });
  assert.equal(next.progress.done.length, 0);
  assert.equal(next.progress.counts.water, 1);
  assert.equal(next.progress.total, 4);
  assert.equal(next.progress.items.firefly, 3);
});

const fs = require('node:fs');
const path = require('node:path');
const PACKS = [path.join(__dirname, 'fixtures', 'games', 'mini-yard'), path.join(__dirname, '..', 'catalog', 'games', 'pixel-yard')].filter((d) => fs.existsSync(path.join(d, 'manifest.json')));
for (const dir of PACKS) test(`the ${path.basename(dir)} pack: its quests can each be done by an event the game sends`, () => {
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const ids = new Set(m.objects.map((o) => o.id));
  for (const q of m.quests) {
    if (q.on.type === 'use-end') for (const o of [].concat(q.on.obj)) assert.ok(ids.has(o) && m.objects.find((x) => x.id === o).use, `${q.id}: ${o} can be used`);
    if (q.on.type === 'collect') for (const it of [].concat(q.on.item)) assert.ok((m.items || {})[it], `${q.id}: ${it} is an item`);
  }
});
