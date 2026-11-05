'use strict';
// 她的房间 · 活动与结算 (src/core/room-play.js, src/main/games.js GameLibrary.activity; docs/her-room-design.md §2–§3).
// Time is driven by hand: every call takes `now`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RP = require('../src/core/room-play');
const GQ = require('../src/core/game-quests');

const SRC = path.join(__dirname, 'fixtures', 'games', 'her-room');
const M = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const DEFS = RP.defsOf(M);
const T0 = new Date('2026-11-05T10:00:00').getTime();
const S = (o = {}) => ({ energy: 50, mood: 50, focus: 50, fullness: 50, ...o });

test('a whole round settles to the manifest numbers (the table in §2.1)', () => {
  const table = { sleep: { energy: 35, mood: 6, focus: 8, fullness: -4 }, work: { focus: 28, energy: -12, mood: -5, fullness: -8 }, phone: { mood: 14, focus: -10, energy: -4 }, music: { mood: 16, energy: 6, focus: 6 }, game: { mood: 22, energy: -14, fullness: -8, focus: -6 } };
  for (const kind of RP.KINDS) {
    const r = RP.start(null, kind, T0, DEFS, S());
    assert.ok(r.ok, kind);
    assert.equal(r.run.seconds, M.activities[kind].seconds);
    assert.equal(RP.tick(r.run, T0 + (r.run.seconds - 1) * 1000, DEFS), null, `${kind}: not over before its time`);
    const s = RP.tick(r.run, T0 + r.run.seconds * 1000, DEFS);
    assert.equal(s.complete, true);
    assert.equal(s.fraction, 1);
    assert.deepEqual(s.deltas, table[kind], kind);
    const { stats, changed } = RP.apply(S(), s.deltas);
    for (const [k, v] of Object.entries(table[kind])) { assert.equal(stats[k], 50 + v); assert.equal(changed[k], v); }
  }
});

test('stopping early: by how far it got, rounded to 0.01, at least 0.25', () => {
  const { run } = RP.start(null, 'sleep', T0, DEFS, S());
  const at40 = RP.settle(run, T0 + 12000, DEFS); // 12 of 30 s
  assert.equal(at40.complete, false);
  assert.equal(at40.fraction, 0.4);
  assert.deepEqual(at40.deltas, { energy: 14, mood: 2, focus: 3, fullness: -2 });
  assert.equal(RP.settle(run, T0 + 1000, DEFS).fraction, RP.MIN_FRACTION, 'stopped at once still counts a little');
  assert.equal(RP.settle(run, T0 + 10123, DEFS).fraction, 0.34);
  assert.match(RP.summary(at40, DEFS), /^睡觉先到这里（做了 40%）：精力 \+14，心情 \+2，专注 \+3，饱腹 −2$/);
  assert.match(RP.summary(RP.settle(run, T0 + 30000, DEFS), DEFS), /^睡觉完成：/);
});

test('switching: the round before is settled first; starting the one running changes nothing', () => {
  const a = RP.start(null, 'music', T0, DEFS, S());
  const same = RP.start(a.run, 'music', T0 + 5000, DEFS, S(), { theme: null });
  assert.equal(same.already, true);
  const b = RP.start(a.run, 'phone', T0 + 10000, DEFS, S());
  assert.ok(b.ok);
  assert.equal(b.settled.kind, 'music');
  assert.equal(b.settled.fraction, 0.4); // 10 of 25 s
  assert.equal(b.run.kind, 'phone');
  assert.equal(b.stats.mood, 50 + Math.round(16 * 0.4));
});

test('too tired: work and game need energy 15 — judged after the round before is settled; refused changes nothing', () => {
  const r = RP.start(null, 'work', T0, DEFS, S({ energy: 10 }));
  assert.deepEqual(r, { ok: false, reason: 'tired', need: 15, have: 10 });
  assert.equal(RP.start(null, 'game', T0, DEFS, S({ energy: 14 })).reason, 'tired');
  assert.ok(RP.start(null, 'phone', T0, DEFS, S({ energy: 5 })).ok, 'phone needs nothing');
  // sleeping first lifts her over the line: switching to work is allowed with the energy after sleep is settled
  const sleep = RP.start(null, 'sleep', T0, DEFS, S({ energy: 10 }));
  const w = RP.start(sleep.run, 'work', T0 + 15000, DEFS, S({ energy: 10 })); // half a sleep: +18
  assert.ok(w.ok, JSON.stringify(w));
  // the other way round: a game that tires her below 15 blocks work, and the game goes on
  const game = RP.start(null, 'game', T0, DEFS, S({ energy: 20 }));
  const no = RP.start(game.run, 'work', T0 + 30000, DEFS, S({ energy: 20 }));
  assert.equal(no.ok, false);
  assert.equal(no.have, 6);
});

test('numbers are held to 0–100 and only the real change is shown', () => {
  const { stats, changed } = RP.apply(S({ energy: 90, fullness: 2 }), { energy: 35, fullness: -4, mood: 0 });
  assert.equal(stats.energy, 100);
  assert.equal(stats.fullness, 0);
  assert.deepEqual(changed, { energy: 10, fullness: -2 });
});

test('recover: a round the app left open — done when a whole round went by since it started, else by its last save', () => {
  const { run } = RP.start(null, 'work', T0, DEFS, S());
  const late = RP.recover({ ...run, seenAt: T0 + 5000 }, T0 + 31000, DEFS);
  assert.equal(late.complete, true);
  assert.equal(late.recovered, true);
  const early = RP.recover({ ...run, seenAt: T0 + 9000 }, T0 + 20000, DEFS);
  assert.equal(early.complete, false);
  assert.equal(early.fraction, 0.3, 'counted to the last save, not to now');
  assert.equal(RP.recover(null, T0, DEFS), null);
});

test('view: progress and time left for the page; scale shortens a round (test mode)', () => {
  const { run } = RP.start(null, 'phone', T0, DEFS, S(), { scale: 0.5 });
  assert.equal(run.seconds, 10);
  const v = RP.view(run, T0 + 2500, DEFS);
  assert.equal(v.progress, 0.25);
  assert.equal(v.left, 7.5);
  assert.deepEqual(RP.preview('sleep', DEFS, 0.5), { energy: 18, mood: 3, focus: 4, fullness: -2 });
});

test('lines: the room’s, else the manifest’s, else the engine’s own', () => {
  const t = M.themes[0];
  assert.deepEqual(RP.lines(M, t, 'sleep', 'doing'), t.activities.sleep.lines.doing);
  assert.deepEqual(RP.lines(M, { activities: {} }, 'sleep', 'done'), RP.LINES.sleep.done);
  assert.deepEqual(RP.lines(M, t, null, 'touch'), M.lines.touch);
  assert.deepEqual(RP.lines(M, t, null, 'enter'), t.lines.enter);
});

test('game-quests: kind / theme / complete, and distinct kinds', () => {
  const quests = [
    { id: 'sleep-full', title: '陪她睡一整觉', on: { type: 'activity-end', kind: 'sleep', complete: true }, always: true },
    { id: 'here', title: '在这间房里听歌', on: { type: 'activity-end', kind: 'music', theme: 'dafeiyu' }, always: true },
    { id: 'all-five', title: '五件事各做一次', on: { type: 'activity-end' }, count: 5, distinct: 'kind', always: true },
    { id: 'night', title: '夜里哄她睡觉', on: { type: 'activity-end', kind: 'sleep', phase: 'night' }, always: true },
  ];
  const day = '2026-11-05';
  let p = null;
  const rec = (ev, ctx = {}) => { const r = GQ.record(quests, p, { type: 'activity-end', ...ev }, { day, ...ctx }); p = r.progress; return r.completed.map((q) => q.id); };
  assert.deepEqual(rec({ kind: 'sleep', theme: 'dafeiyu', complete: false }), []);
  assert.deepEqual(rec({ kind: 'sleep', theme: 'dafeiyu', complete: true }), ['sleep-full']);
  assert.deepEqual(rec({ kind: 'music', theme: 'claude', complete: true }), [], 'another room');
  assert.deepEqual(rec({ kind: 'music', theme: 'dafeiyu', complete: false }), ['here']);
  assert.equal(p.counts['all-five'], 2, 'sleep twice counted once');
  assert.deepEqual(p.seen['all-five'], ['sleep', 'music']);
  rec({ kind: 'phone' }); rec({ kind: 'work' });
  assert.deepEqual(rec({ kind: 'game' }), ['all-five']);
  assert.deepEqual(rec({ kind: 'sleep' }, { phase: 'night' }), ['night']);
  // the next day starts over
  const r = GQ.record(quests, p, { type: 'activity-end', kind: 'sleep', complete: true }, { day: '2026-11-06' });
  assert.deepEqual(r.progress.seen, { 'all-five': ['sleep'] }, 'counted again from nothing');
  assert.deepEqual(r.completed.map((q) => q.id), ['sleep-full']);
});

// ---- main's side: GameLibrary.activity with the installed manifest and a stand-in PetService ----------------
function lib() {
  const { GameLibrary } = require('../src/main/games');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-roomlib-'));
  const dir = path.join(root, 'her-room');
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  const L = new GameLibrary({ userDir: root });
  const pet = { s: { base: 'dafeiyu', energy: 50, mood: 50, fullness: 50 }, quests: [], settles: [] };
  const P = { stats: () => ({ ...pet.s }), settle: (s) => { pet.settles.push(s); Object.assign(pet.s, s); return { ...pet.s }; }, quest: (title) => { pet.quests.push(title); return { affection: { delta: 2 } }; } };
  return { L, root, pet, P };
}

test('GameLibrary.activity: main settles with its own clock and the installed numbers, saves focus, run and totals', () => {
  const { L, root, pet, P } = lib();
  const GS = require('../src/core/game-store');
  // numbers sent by the page are ignored: only kind / theme count
  let r = L.activity('her-room', { cmd: 'start', kind: 'sleep', theme: 'dafeiyu', seconds: 1, deltas: { energy: 40 } }, P, { now: T0 });
  assert.ok(r.ok);
  assert.equal(r.run.seconds, 30);
  assert.equal(GS.readProgress(root, 'her-room').state.run.kind, 'sleep');
  // the page says it is over too early: not settled
  r = L.activity('her-room', { cmd: 'tick' }, P, { now: T0 + 10000 });
  assert.equal(r.settled, null);
  assert.equal(r.early, true);
  r = L.activity('her-room', { cmd: 'tick', ctx: { phase: 'night', weather: 'clear' } }, P, { now: T0 + 30000 });
  assert.equal(r.settled.complete, true);
  assert.deepEqual(r.settled.changed, { energy: 35, mood: 6, focus: 8, fullness: -4 });
  assert.deepEqual(pet.s, { base: 'dafeiyu', energy: 85, mood: 56, fullness: 46 });
  const st = GS.readProgress(root, 'her-room').state;
  assert.equal(st.run, null);
  assert.equal(st.focus.dafeiyu, 58);
  assert.deepEqual(st.totals.dafeiyu.sleep, { count: 1, completed: 1, ms: 30000 });
  assert.equal(st.last.kind, 'sleep');
  // 小事: sleep-full / night-sleep are today's when picked; whatever finished went to PetService.gameQuest
  assert.equal(pet.quests.length, r.settled.completed.length);
  // switch: phone then work mid-round
  L.activity('her-room', { cmd: 'start', kind: 'phone', theme: 'dafeiyu' }, P, { now: T0 + 40000 });
  r = L.activity('her-room', { cmd: 'start', kind: 'work', theme: 'dafeiyu' }, P, { now: T0 + 50000 });
  assert.equal(r.started, 'work');
  assert.equal(r.settled.kind, 'phone');
  assert.equal(r.settled.fraction, 0.5);
  // stop
  r = L.activity('her-room', { cmd: 'stop' }, P, { now: T0 + 59000 });
  assert.equal(r.settled.kind, 'work');
  assert.equal(r.settled.fraction, 0.3);
  // tired: refused, nothing saved
  pet.s.energy = 10;
  r = L.activity('her-room', { cmd: 'start', kind: 'game', theme: 'dafeiyu' }, P, { now: T0 + 60000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'tired');
  assert.equal(GS.readProgress(root, 'her-room').state.run, null);
  // a soon room cannot be played; scale is test-only
  assert.equal(L.activity('her-room', { cmd: 'start', kind: 'sleep', theme: 'claude' }, P, { now: T0 }).reason, 'theme');
  assert.equal(L.activity('her-room', { cmd: 'scale', k: 0.1 }, P, { now: T0 }).reason, 'test-only');
});

test('GameLibrary: closing settles by how long it ran; a boot after a crash settles the open round (done after a whole round)', () => {
  const { L, root, P } = lib();
  const GS = require('../src/core/game-store');
  L.activity('her-room', { cmd: 'start', kind: 'music', theme: 'dafeiyu' }, P, { now: T0 });
  const s = L.roomClose('her-room', P, { now: T0 + 5000 });
  assert.equal(s.kind, 'music');
  assert.equal(s.fraction, 0.25, 'at least MIN_FRACTION');
  assert.equal(L.roomClose('her-room', P, { now: T0 + 6000 }), null, 'nothing running');
  // crash mid-round, back after more than a round
  L.activity('her-room', { cmd: 'start', kind: 'work', theme: 'dafeiyu' }, P, { now: T0 + 10000 });
  L.activity('her-room', { cmd: 'seen' }, P, { now: T0 + 15000 });
  const b = L.roomBoot('her-room', P, { now: T0 + 10000 + 31000 });
  assert.equal(b.recovered.kind, 'work');
  assert.equal(b.recovered.complete, true);
  assert.equal(GS.readProgress(root, 'her-room').state.run, null);
  // crash, back before a round is over: counted to the last save
  L.activity('her-room', { cmd: 'start', kind: 'work', theme: 'dafeiyu' }, P, { now: T0 + 100000 });
  L.activity('her-room', { cmd: 'seen' }, P, { now: T0 + 112000 });
  const b2 = L.roomBoot('her-room', P, { now: T0 + 120000 });
  assert.equal(b2.recovered.complete, false);
  assert.equal(b2.recovered.fraction, 0.4);
  assert.equal(L.roomBoot('her-room', P, { now: T0 + 130000 }).recovered, null);
});

test('GameLibrary.saveState: the page may only choose the room; focus, run and totals are main’s', () => {
  const { L, root, P } = lib();
  const GS = require('../src/core/game-store');
  L.activity('her-room', { cmd: 'start', kind: 'sleep', theme: 'dafeiyu' }, P, { now: T0 });
  L.activity('her-room', { cmd: 'stop' }, P, { now: T0 + 30000 });
  assert.ok(L.saveState('her-room', { theme: 'dafeiyu', focus: { dafeiyu: 100 }, run: { kind: 'work', startedAt: 0 }, totals: {} }));
  const st = GS.readProgress(root, 'her-room').state;
  assert.equal(st.theme, 'dafeiyu');
  assert.equal(st.focus.dafeiyu, 58);
  assert.equal(st.run, null);
  assert.equal(st.totals.dafeiyu.sleep.count, 1);
  L.saveState('her-room', { theme: 'grok' }); // not open: ignored
  assert.equal(GS.readProgress(root, 'her-room').state.theme, 'dafeiyu');
});
