'use strict';
// 房间小游戏 (docs/room.md, T-6174): the room definitions (src/core/room.js) and the room on top of PetService
// (src/main/room-service.js) with a fake lh: themes, the five activities, settling, persistence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const room = require('../src/core/room');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const settingsLib = require('../src/core/settings');
const { PetService } = require('../src/main/pet-service');
const { RoomService } = require('../src/main/room-service');

const ROOT = path.join(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const T0 = new Date('2026-01-05T14:00:00').getTime();
const pet = (over = {}) => ({ energy: 50, mood: 50, hunger: 50, lastInteractionAt: 0, ...over });

// ---- definitions ---------------------------------------------------------------------------------------------

test('themes: one per default character (src/characters), 大肥鱼 open with art + hotspots, the other four 即将开放', () => {
  const chars = fs.readdirSync(path.join(ROOT, 'src', 'characters')).map((f) => f.replace(/\.json$/, '')).sort();
  assert.deepEqual(room.THEMES.map((t) => t.character).sort(), chars);
  assert.deepEqual(room.THEMES.map((t) => [t.id, t.status]), [['dafeiyu', 'open'], ['claude', 'soon'], ['grok', 'soon'], ['gemini', 'soon'], ['gpt', 'soon']]);
  for (const t of room.THEMES) {
    assert.ok(t.name && t.blurb && t.motifs.length, `${t.id} has words for its preview`);
    for (const k of ['primary', 'accent', 'base', 'trim']) assert.match(t.palette[k], /^#[0-9A-F]{6}$/i, `${t.id}.${k}`);
  }
  const d = room.themeById('dafeiyu');
  assert.deepEqual(d.palette, { primary: '#2C4A8A', accent: '#6FA8E8', base: '#FFFFFF', trim: '#E8D6A0' }, 'the Goal palette');
  assert.ok(fs.statSync(path.join(ROOT, 'src', 'renderer', d.art.background)).size > 10000, 'the room picture ships');
  assert.deepEqual(Object.keys(d.hotspots).sort(), room.ACTIVITY_IDS.map((k) => room.ACTIVITIES[k].hotspot).sort(), 'every activity has its furniture');
  for (const k of [...room.ACTIVITY_IDS, 'idle']) assert.ok(d.spots[k], `a spot for ${k}`);
  for (const b of Object.values(d.hotspots)) assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 100 && b.y + b.h <= 100, JSON.stringify(b));
  // her actions exist in her pixel pack (her maid outfit sheet plays them)
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'packs', 'dafeiyu-pixel', 'pack.json'), 'utf8'));
  for (const k of room.ACTIVITY_IDS) assert.ok(pack.actions[room.ACTIVITIES[k].action], `${k} → ${room.ACTIVITIES[k].action}`);
  assert.ok(pack.outfits[d.outfit], 'her signature outfit');
  assert.equal(room.themeFor('nobody').id, 'dafeiyu');
});

test('activities: the five, each with a hotspot, an action and what a round does', () => {
  assert.deepEqual(room.ACTIVITY_IDS, ['sleep', 'work', 'phone', 'music', 'game']);
  assert.deepEqual(room.ACTIVITY_IDS.map((k) => room.ACTIVITIES[k].label), ['睡觉', '工作', '看手机', '听音乐', '打游戏']);
  assert.ok(room.ACTIVITIES.sleep.deltas.energy > 0);
  assert.ok(room.ACTIVITIES.work.deltas.focus > 0 && room.ACTIVITIES.work.deltas.energy < 0);
  assert.ok(room.ACTIVITIES.game.deltas.mood > room.ACTIVITIES.phone.deltas.mood);
});

// ---- start / settle ------------------------------------------------------------------------------------------

test('a whole round applies its deltas; fullness is minus hunger; focus lives in pet.room', () => {
  const p = pet();
  const r = room.start(p, 'work', T0);
  assert.equal(r.ok, true);
  assert.ok(r.line, 'a line to say');
  assert.deepEqual(p.room.activity, { kind: 'work', startedAt: T0 });
  const s = room.settle(p, T0 + room.ROUND_MS);
  assert.deepEqual(s.deltas, { energy: -12, mood: -5, focus: 28, fullness: -8 });
  assert.equal(s.complete, true);
  assert.equal(p.energy, 38);
  assert.equal(p.mood, 45);
  assert.equal(p.hunger, 58);
  assert.equal(p.room.focus, 78);
  assert.equal(p.room.activity, null);
  assert.deepEqual(p.room.totals.work, { count: 1, completed: 1, ms: room.ROUND_MS });
  assert.equal(p.lastInteractionAt, T0 + room.ROUND_MS);
});

test('ending early counts the part done (at least a quarter); switching settles the first one', () => {
  const p = pet();
  room.start(p, 'music', T0);
  const half = room.settle(p, T0 + room.ROUND_MS / 2);
  assert.equal(half.complete, false);
  assert.equal(half.fraction, 0.5);
  assert.deepEqual(half.deltas, { energy: 3, mood: 8, focus: 3 });
  room.start(p, 'phone', T0 + room.ROUND_MS);
  const sw = room.start(p, 'sleep', T0 + room.ROUND_MS + 100);
  assert.equal(sw.settled.kind, 'phone');
  assert.equal(sw.settled.fraction, room.MIN_FRACTION);
  assert.equal(p.room.activity.kind, 'sleep');
  assert.deepEqual(room.start(p, 'sleep', T0 + room.ROUND_MS + 200).same, true, 'the same one again changes nothing');
});

test('too tired: 工作 and 打游戏 need 精力 15, 睡觉 does not; numbers stay within 0..100', () => {
  const p = pet({ energy: 10 });
  assert.equal(room.start(p, 'work', T0).reason, 'tired');
  assert.equal(room.start(p, 'game', T0).reason, 'tired');
  assert.equal(p.room.activity, null);
  assert.equal(room.start(p, 'sleep', T0).ok, true);
  room.settle(p, T0 + room.ROUND_MS);
  assert.equal(p.energy, 45);
  assert.equal(room.start(p, 'game', T0 + room.ROUND_MS).ok, true);
  const q = pet({ mood: 95 });
  room.start(q, 'game', T0);
  assert.equal(room.settle(q, T0 + room.ROUND_MS).deltas.mood, 5, 'clamped at 100');
  assert.equal(q.mood, 100);
});

test('view: progress of the running round and her four numbers', () => {
  const p = pet();
  room.start(p, 'sleep', T0);
  const v = room.view(p, T0 + room.ROUND_MS / 4);
  assert.equal(v.activity.progress, 0.25);
  assert.deepEqual(v.stats, { energy: 50, mood: 50, focus: 50, fullness: 50 });
  assert.equal(room.view(p, T0 + room.ROUND_MS * 3).activity.progress, 1);
});

// ---- RoomService on PetService -------------------------------------------------------------------------------

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const data = path.join(dir, 'data');
  const clock = { t: T0 };
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const mk = () => {
    const s = new PetService({ lh, store: new Store(data), settingsStore: new settingsLib.SettingsStore(data), now: () => clock.t, rnd: () => 0.5 });
    s.on('error', () => {});
    return s;
  };
  return { data, clock, mk };
}

test('RoomService: her own room first, 切换房间类型 saved, soon rooms refuse activities, numbers saved in pet.json', async () => {
  const { data, clock, mk } = setup();
  const svc = mk();
  await svc.hatch({ speciesId: 'dafeiyu', name: '小鲸' });
  const rs = new RoomService(svc, { roundMs: 4000 });
  let st = rs.state();
  assert.equal(st.theme, 'dafeiyu');
  assert.deepEqual(st.owner, { character: 'dafeiyu', met: true, name: '小鲸', current: true });
  assert.equal(st.themes.length, 5);
  assert.equal(st.activities.length, 5);
  assert.equal(st.view.roundMs, 4000);

  assert.equal(rs.setTheme('claude').ok, true);
  st = rs.state();
  assert.equal(st.theme, 'claude');
  assert.equal(st.view, null, 'a 即将开放 room has nothing to play');
  assert.equal(rs.start('sleep').reason, 'soon');
  assert.equal(rs.setTheme('nope').reason, 'bad-theme');
  assert.equal(rs.setTheme('dafeiyu').ok, true);

  const e0 = svc._c().energy;
  const r = rs.start('sleep');
  assert.equal(r.ok, true);
  assert.equal(r.action, 'sleep');
  clock.t += 4000;
  const done = rs.stop();
  assert.equal(done.settled.complete, true);
  assert.equal(svc._c().energy, Math.min(100, e0 + 35));
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'pet.json'), 'utf8'));
  assert.equal(saved.roomTheme, 'dafeiyu');
  assert.equal(saved.characters.dafeiyu.room.totals.sleep.completed, 1);
  assert.equal(saved.characters.dafeiyu.room.last.kind, 'sleep');

  // a restart reads it all back
  const again = mk();
  again.init();
  const rs2 = new RoomService(again, { roundMs: 4000 });
  assert.equal(rs2.state().view.totals.sleep.completed, 1);
  assert.equal(rs2.state().view.stats.energy, Math.round(svc._c().energy));
});

test('RoomService: a whole round of 打游戏 scores like 玩耍; a room whose character is not met cannot be played', async () => {
  const { mk } = setup();
  const svc = mk();
  await svc.hatch({ speciesId: 'grok', name: '小格' });
  const rs = new RoomService(svc, { roundMs: 1000 });
  assert.equal(rs.themeId(), 'grok', 'her own room first');
  rs.setTheme('dafeiyu');
  const st = rs.state();
  assert.deepEqual(st.owner, { character: 'dafeiyu', met: false, name: null, current: false });
  assert.equal(st.view, null);
  assert.equal(rs.start('game').reason, 'not-met');

  // a fresh save for 大肥鱼 in another folder
  const other = setup();
  const s2 = other.mk();
  await s2.hatch({ speciesId: 'dafeiyu', name: '' });
  const rs2 = new RoomService(s2, { roundMs: 1000 });
  const a0 = s2._c().affection;
  rs2.start('game');
  other.clock.t += 1000;
  const r = rs2.stop();
  assert.ok(r.affection && r.affection.delta > 0, 'scored');
  assert.ok(s2._c().affection > a0);
});
