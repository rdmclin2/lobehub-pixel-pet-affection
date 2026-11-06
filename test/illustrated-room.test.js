'use strict';
// 她的房间 (illustrated-room@1, docs/illustrated-room.md): the pack's manifest (core/illustrated-room-pack.js through
// core/game-pack.js), what the owner says in chat (core/room-intent.js), the state machine
// (core/illustrated-room-play.js), main's side (src/main/games.js illustratedCommand / Boot / Close / Note) and the
// prompt note (core/persona.js buildChatPrompt `room`, PetService.chat roomHook).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const GP = require('../src/core/game-pack');
const IP = require('../src/core/illustrated-room-pack');
const RI = require('../src/core/room-intent');
const IRP = require('../src/core/illustrated-room-play');
const RP = require('../src/core/room-play');
const GQ = require('../src/core/game-quests');
const GS = require('../src/core/game-store');
const persona = require('../src/core/persona');

const SRC = path.join(__dirname, 'fixtures', 'games', 'her-room');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const fixture = () => read(path.join(SRC, 'manifest.json'));
const example = () => read(path.join(__dirname, 'fixtures', 'illustrated-room-manifest.example.json'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const T0 = new Date('2026-11-05T23:00:00').getTime();

// ---- manifest -------------------------------------------------------------------------------------------------
test('manifest: the sample pack (with its files) and the design document’s example both pass', () => {
  assert.deepEqual(GP.validateManifest(fixture(), { files: fs.readdirSync(SRC) }), []);
  assert.deepEqual(GP.validateManifest(example()), [], 'docs/data/illustrated-room-manifest.example.json (T-11682)');
  assert.ok(GP.ENGINES.includes('illustrated-room@1'));
  assert.ok(GP.ENGINES.includes('room@1'), '像素房间 still plays');
});

test('manifest: namedFiles / spriteFiles — every picture of every open room, nothing of a 即将开放 one', () => {
  const m = fixture();
  assert.deepEqual(GP.namedFiles(m).sort(), fs.readdirSync(SRC).filter((f) => f !== 'manifest.json').sort());
  assert.deepEqual(GP.spriteFiles(m), []);
  const ex = example();
  assert.ok(GP.namedFiles(ex).includes('dafeiyu-parts.webp'));
  assert.ok(GP.namedFiles(ex).includes('dafeiyu-light-mask.webp'));
  assert.deepEqual(GP.spriteFiles(ex).sort(), ['dafeiyu-clips.json', 'dafeiyu-media.json', 'dafeiyu-parts.json']);
  assert.ok(GP.MULTI_INDEX.includes('illustrated-room@1'));
});

test('manifest: a missing file, a file of another room, a file the folder does not have', () => {
  const m = fixture();
  m.rooms[0].states.sleep.images.lit = 'dafeiyu-nope.webp';
  assert.match(GP.validateManifest(m, { files: fs.readdirSync(SRC) }).join('\n'), /dafeiyu-nope\.webp is missing/);
  const m2 = fixture();
  m2.rooms[0].states.sleep.images.off = 'claude-sleep-off.webp';
  assert.match(GP.validateManifest(m2).join('\n'), /must start with "dafeiyu-"/);
  const m3 = fixture();
  m3.rooms[0].states.work.images.off = '../x.webp';
  assert.match(GP.validateManifest(m3).join('\n'), /not allowed/);
  const m4 = fixture();
  delete m4.rooms[0].states.work.images;
  assert.match(GP.validateManifest(m4).join('\n'), /states\.work\.images\.off is missing/);
});

test('manifest: activities — the six known, numbers bounded like 像素房间, 发呆 moves nothing', () => {
  const bad = (fn, re) => { const m = fixture(); fn(m); assert.match(GP.validateManifest(m).join('\n'), re); };
  bad((m) => { m.activities.eat = { label: '吃', seconds: 10 }; }, /activities\.eat: not an activity/);
  bad((m) => { delete m.activities.music; }, /activities\.music is missing/);
  bad((m) => { m.activities.sleep.seconds = 2; }, /sleep\.seconds must be 5–600/);
  bad((m) => { m.activities.game.deltas.mood = 80; }, /game\.deltas\.mood must be −40…40/);
  bad((m) => { m.activities.work.deltas.affection = 5; }, /work\.deltas\.affection: only/);
  bad((m) => { m.activities.work.needs = { mood: 3 }; }, /needs: only energy/);
  bad((m) => { m.activities.idle.deltas = { mood: 3 }; }, /idle cannot move numbers/);
  bad((m) => { m.activities.idle.seconds = 30; }, /idle\.seconds must be 0/);
});

test('manifest: states — every activity has one, the default is not transient, links point at real states', () => {
  const bad = (fn, re) => { const m = fixture(); fn(m.rooms[0], m); assert.match(GP.validateManifest(m).join('\n'), re); };
  bad((r) => { delete r.states.game; }, /no state for the activity game/);
  bad((r) => { r.defaultState = 'nope'; }, /defaultState must be a state/);
  bad((r) => { r.states.stand = { transient: true, label: '起身', images: { off: 'dafeiyu-work-off.webp' } }; r.defaultState = 'stand'; }, /defaultState must be a state that is not transient/);
  bad((r) => { r.states.work.enterVia = 'phone'; }, /enterVia must be a transient state/);
  bad((r) => { r.states.idle.variants = ['work']; }, /variants: "work" must be a state of the same activity/);
  bad((r) => { r.states.phone.screens = { phone: { content: 'player', corners: r.states.phone.screens.phone.corners } }; r.content = { player: { tracks: [{ title: 'x', seconds: 60, cover: 'nope' }] } }; }, /tracks\[0\]\.cover: no images\.nope/);
  bad((r) => { r.states.phone.screens = { phone: { content: 'player', corners: r.states.phone.screens.phone.corners } }; r.content = { player: { tracks: [{ title: 'x', seconds: 60, lyrics: [[90, '过了歌尾']] }] } }; }, /tracks\[0\]\.lyrics/);
  bad((r) => { r.states.phone.screens = { phone: { content: 'page', corners: r.states.phone.screens.phone.corners } }; r.content = { page: { templates: [{ id: 'web', title: 'x', image: 'nope' }] } }; }, /templates\[0\]\.image: no images\.nope/);
  bad((r) => { r.states.sleep.activity = 'nap'; }, /states\.sleep\.activity must be one of/);
  bad((r) => { r.states.phone.breath = { rect: [1800, 1000, 400, 200], amp: 1, period: 3 }; }, /breath: rect/);
  bad((r) => { r.states.phone.breath.amp = 9; }, /breath: rect .* amp 0–4/);
  bad((r) => { r.states.phone.blink = { eyes: [] }; }, /blink: eyes/);
  bad((r) => { r.states.phone.blink.every = [0, 3]; }, /blink\.every/);
  bad((r) => { r.window.bokeh.spots = [[-5, 10, 8]]; }, /bokeh\.spots/);
  bad((r) => { r.window.bokeh.spots = [[300, 100, 500]]; }, /bokeh\.spots/);
  bad((r) => { r.states.phone.bubble = [3000, 10]; }, /bubble must be a point in the world/);
  bad((r) => { r.transition = { seconds: 9 }; }, /transition\.seconds must be 0\.3–4/);
});

test('manifest: screens — known contents, convex corners in the world, what a content needs', () => {
  const bad = (fn, re) => { const m = fixture(); fn(m.rooms[0]); assert.match(GP.validateManifest(m).join('\n'), re); };
  bad((r) => { r.states.phone.screens.phone.content = 'tiktok'; }, /content must be one of lock clips page player game chat off/);
  bad((r) => { r.states.phone.screens.tv = { content: 'clips' }; }, /screens\.tv: no such screen/);
  // a bow-tie (corners out of order) is not a screen
  bad((r) => { r.screens.laptop.corners = [[1635, 298], [1753, 473], [1792, 367], [1597, 405]]; }, /laptop\.corners: four points in the world, a convex quad/);
  bad((r) => { r.states.sleep.screens.phone.corners = [[0, 0], [10, 0], [10, 10]]; }, /sleep\.screens\.phone\.corners/);
  bad((r) => { r.content.clips.list = []; }, /a screen plays clips, so at least one/);
  bad((r) => { r.content.clips.list[0].scene = 'explosions'; }, /scene must be one of/);
  bad((r) => { delete r.content.clips.list[1].scene; }, /scene \(drawn by the app\) or frames/);
  bad((r) => { r.content.player.tracks[0].seconds = 3; }, /tracks\[0\]: title and seconds/);
  bad((r) => { r.screens.phone.size = [10, 10]; }, /size must be \[w, h\]/);
  assert.equal(IP.convexQuad([[0, 0], [10, 0], [10, 10], [0, 10]]), true);
  assert.equal(IP.convexQuad([[0, 0], [10, 10], [10, 0], [0, 10]]), false);
});

test('manifest: lighting, window, hotspots, intents, lines, rooms', () => {
  const bad = (fn, re) => { const m = fixture(); fn(m.rooms[0], m); assert.match(GP.validateManifest(m).join('\n'), re); };
  bad((r) => { r.lighting.lamp.at = [-5, 10]; }, /lamp\.at must be a point/);
  bad((r) => { r.lighting.lamp.rampOn = 9; }, /rampOn must be 0–3 s/);
  bad((r) => { r.lighting.lamp.glow.color = 'orange'; }, /glow: r 8–2000/);
  bad((r) => { r.lighting.grade.tint = 'blue'; }, /grade: saturation/);
  bad((r) => { r.window.panes = [[[0, 0], [5000, 0], [0, 10]]]; }, /window: panes must be polygons in the world/);
  bad((r) => { r.window.rain.density = 9999; }, /window\.rain: density/);
  bad((r) => { r.window.bokeh.count = 999; }, /window\.bokeh: count/);
  bad((r) => { r.hotspots[1].state = 'nope'; }, /hotspots\[1\] \(phone\)\.state must be a state/);
  bad((r) => { r.hotspots[0].toggle = 'tv'; }, /toggle: only "lamp"/);
  bad((r) => { r.intents.sleep = ['这是一个特别特别特别长的说法啊']; }, /intents\.sleep: up to 24 words, each 1–12/);
  bad((r) => { r.intents.screen.tiktok = ['抖音']; }, /intents\.screen\.tiktok: not a screen content/);
  bad((r) => { r.intents.dance = ['跳舞']; }, /intents\.dance: not a state or an activity/);
  bad((r) => { r.lines.enter = ['好'.repeat(61)]; }, /lines\.enter: lines ≤ 60/);
  bad((r, m) => { m.defaultRoom = 'claude'; }, /defaultRoom must be an open room/);
  bad((r, m) => { m.rooms.push(clone(m.rooms[1])); }, /rooms\[2\] \(claude\): id twice/);
  bad((r, m) => { m.quests[0].on.type = 'dance'; }, /quests\[0\] \(sleep-full\): on\.type "dance"/);
  // a 即将开放 room needs only its card fields
  const m = fixture();
  assert.equal(m.rooms[1].status, 'soon');
  assert.deepEqual(GP.validateManifest(m), []);
});

test('game-store: the sample pack installs from an archive folder (no stray files, sprites indexes read)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-irstore-'));
  const dir = path.join(root, 'her-room');
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  const list = GS.listInstalled([{ dir: root, source: 'download' }]);
  assert.deepEqual(list.map((g) => [g.id, g.version]), [['her-room', '0.1.0']]);
  fs.writeFileSync(path.join(dir, 'evil.js'), 'x');
  assert.deepEqual(GS.listInstalled([{ dir: root, source: 'download' }]), [], 'a file the manifest does not name: not a game');
});

// ---- room-intent ----------------------------------------------------------------------------------------------
const intents = () => fixture().rooms[0].intents;
const m = (t, ctx) => RI.matchRoomIntent(t, intents(), ctx);

test('intent: a word the room gives to one of its states wins over the common word of another', () => {
  assert.equal(RI.matchRoomIntent('犯懒吧', null).state, 'idle');
  assert.equal(RI.matchRoomIntent('犯懒吧', { 'idle-lazy': ['犯懒'] }).state, 'idle-lazy');
  assert.equal(RI.matchRoomIntent('发会儿呆吧', { 'idle-lazy': ['犯懒'] }).state, 'idle');
});
test('room-intent: the reference video’s own sentences', () => {
  assert.deepEqual(pickI(m('回床上休息吧')), { state: 'sleep', lamp: null, screen: null, stop: false });
  assert.deepEqual(pickI(m('现在去试一下打开电脑刷抖音吧')), { state: 'work', lamp: null, screen: 'clips', stop: false });
  assert.deepEqual(pickI(m('现在回床上休息吧，不玩了')), { state: 'sleep', lamp: null, screen: null, stop: false }, '不玩了 does not beat 回床上');
  assert.equal(m('大肥鱼，能收消息吗'), null);
});
test('room-intent: 「会儿」「一会儿」 between the verb and its object still asks for it', () => {
  const cases = [
    ['看会儿手机吧', 'phone'], ['玩会手机', 'phone'], ['刷一会儿手机', 'phone'],
    ['来打会儿游戏吧', 'game'], ['玩会儿游戏', 'game'], ['打一会游戏', 'game'],
    ['听会儿歌', 'music'], ['听一会音乐吧', 'music'], ['放一首歌吧', 'music'], ['写会儿代码吧', 'work'],
  ];
  for (const [t, state] of cases) { const r = m(t); assert.ok(r, `${t} → something`); assert.equal(r.state, state, t); }
  assert.equal(m('别看会儿手机了').state, null, 'still negated: a stop, not a switch');
  assert.equal(m('我在看会儿手机'), null, 'still about the owner');
  assert.equal(m('你看会儿手机了吗'), null, 'still a question');
});
function pickI(r) { return r && { state: r.state, lamp: r.lamp, screen: r.screen, stop: r.stop }; }

test('room-intent: each activity, the screen it plays, and where 刷抖音 happens', () => {
  const cases = [
    ['去睡觉吧', 'sleep', null], ['躺下', 'sleep', null], ['钻被窝吧', 'sleep', null],
    ['去工作', 'work', null], ['写周报', 'work', null], ['打开电脑', 'work', null],
    ['看手机吧', 'phone', null], ['刷会儿抖音', 'phone', 'clips'], ['看手机刷视频吧', 'phone', 'clips'], ['用电脑刷视频', 'work', 'clips'],
    ['放首歌听听', 'music', 'player'], ['听歌', 'music', 'player'],
    ['去打游戏', 'game', 'game'], ['来一局吧', 'game', null],
    ['发会儿呆吧', 'idle', null], ['歇会吧', 'idle', null],
  ];
  for (const [t, state, screen] of cases) {
    const r = m(t);
    assert.ok(r, `${t} → something`);
    assert.equal(r.state, state, t);
    assert.equal(r.screen, screen, `${t}: screen`);
  }
});

test('room-intent: the lamp, with or without a state; search words; 下一个', () => {
  assert.deepEqual(pickI(m('开灯')), { state: null, lamp: true, screen: null, stop: false });
  assert.deepEqual(pickI(m('把台灯打开')), { state: null, lamp: true, screen: null, stop: false });
  assert.deepEqual(pickI(m('关灯睡觉吧')), { state: 'sleep', lamp: false, screen: null, stop: false });
  const s = m('搜一下明天天气');
  assert.equal(s.state, 'work');
  assert.equal(s.screen, 'page');
  assert.equal(s.query, '明天天气');
  assert.equal(m('下一个', { screen: 'clips' }).next, true);
  assert.equal(m('下一个', { screen: 'page' }), null, '下一个 only means something while clips play');
});

test('room-intent: negations, questions, talk that is not an order, stops', () => {
  assert.equal(m('我不想睡觉'), null);
  assert.equal(m('你睡了吗'), null);
  assert.equal(m('在工作么'), null);
  assert.equal(m('今天好累啊，工作好多'), null, 'a long sentence without 吧 / 去 … is talk');
  assert.equal(m('我在看手机'), null, 'the owner about themselves');
  assert.equal(m(`${'聊'.repeat(61)}睡觉吧`), null, 'over 60 characters: a conversation');
  assert.equal(m(''), null);
  assert.deepEqual(pickI(m('别玩手机了')), { state: null, lamp: null, screen: null, stop: true });
  assert.equal(m('先别玩游戏了，去睡觉').state, 'sleep', 'the one asked for, not the negated one');
  assert.equal(m('要不要去睡觉？').state, 'sleep', 'a suggestion with 去 counts');
});

test('room-intent: a room’s own words add to the common ones', () => {
  assert.equal(RI.matchRoomIntent('钻被窝吧', null), null, 'not a common word');
  assert.equal(RI.matchRoomIntent('钻被窝吧', { sleep: ['钻被窝'] }).state, 'sleep');
  assert.equal(RI.matchRoomIntent('看番吧', { screen: { clips: ['看番'] } }).screen, 'clips');
});

// ---- state machine ---------------------------------------------------------------------------------------------
const M = fixture();
const ROOM = M.rooms[0];
const stats = (energy = 80) => ({ base: 'dafeiyu', energy, mood: 50, fullness: 50, focus: 50 });
test('state machine: restore — a fresh save, a 像素房间 save under the same id, a state that is gone', () => {
  const st = IRP.restore(M, null, T0);
  assert.deepEqual([st.engine, st.room, st.state, st.lamp, st.run], ['illustrated-room@1', 'dafeiyu', 'idle', false, null]);
  const old = IRP.restore(M, { theme: 'dafeiyu', run: { kind: 'sleep', theme: 'dafeiyu', startedAt: T0 } }, T0);
  assert.equal(old.state, 'idle');
  assert.equal(old.run, null, 'a room@1 save is not read');
  const gone = IRP.restore(M, { engine: 'illustrated-room@1', room: 'dafeiyu', state: 'yoga', lamp: true }, T0);
  assert.equal(gone.state, 'idle');
  assert.equal(gone.lamp, true);
});

test('state machine: resolve / path / screensFor', () => {
  assert.equal(IRP.resolve(ROOM, 'work'), 'work');
  assert.equal(IRP.resolve(ROOM, 'nope'), null);
  assert.deepEqual(IRP.path(ROOM, 'idle', 'work'), ['work'], 'no 起身 picture in the sample: straight there');
  const r2 = clone(ROOM);
  r2.states.stand = { transient: true, label: '起身', images: { off: 'dafeiyu-work-off.webp' }, hold: 0.6 };
  r2.states.work.enterVia = 'stand';
  assert.deepEqual(IRP.path(r2, 'phone', 'work'), ['stand', 'work'], '床 → 书桌 through 起身');
  assert.deepEqual(IRP.path(r2, 'work', 'sleep'), ['stand', 'sleep'], 'and back');
  assert.deepEqual(IRP.path(r2, 'work', 'game'), ['game'], 'desk to desk: no 起身');
  assert.equal(IRP.resolve(r2, 'stand'), null, 'a transient state cannot be asked for');
  assert.deepEqual(IRP.screensFor(ROOM, 'work'), { laptop: 'page' });
  assert.deepEqual(IRP.screensFor(ROOM, 'work', 'clips'), { laptop: 'clips' }, '「打开电脑刷抖音」');
  assert.deepEqual(IRP.screensFor(ROOM, 'sleep', 'clips'), { phone: 'lock' }, 'a lock screen stays locked');
});

test('state machine: command — switch, settle the round before, the lamp with work, idle not timed', () => {
  let st = IRP.restore(M, null, T0);
  let r = IRP.command(st, { state: 'phone' }, { manifest: M, now: T0, stats: stats() });
  assert.ok(r.ok);
  assert.deepEqual([r.from, r.to, r.path, r.started, r.settled], ['idle', 'phone', ['phone'], 'phone', null]);
  assert.equal(r.st.run.kind, 'phone');
  assert.equal(r.st.run.seconds, 20);
  st = r.st;
  // 10 s later to work: the phone round is settled at half; work turns the lamp on
  r = IRP.command(st, { state: 'work', screen: 'clips' }, { manifest: M, now: T0 + 10000, stats: stats() });
  assert.equal(r.settled.kind, 'phone');
  assert.equal(r.settled.fraction, 0.5);
  assert.equal(r.st.lamp, true);
  assert.equal(r.lampChanged, true);
  assert.equal(r.st.screen, 'clips');
  assert.deepEqual(IRP.view(r.st, { manifest: M, now: T0 + 10000 }).screens, { laptop: 'clips' });
  st = r.st;
  // the lamp alone, in any state
  r = IRP.command(st, { lamp: false }, { manifest: M, now: T0 + 11000, stats: stats() });
  assert.deepEqual([r.ok, r.to, r.path.length, r.lampChanged, r.st.lamp, r.st.run.kind], [true, 'work', 0, true, false, 'work']);
  st = r.st;
  // 发呆: the round is settled, nothing new runs
  r = IRP.command(st, { state: 'idle' }, { manifest: M, now: T0 + 16000, stats: stats() });
  assert.equal(r.settled.kind, 'work');
  assert.equal(r.st.run, null);
  assert.equal(r.started, null);
  // the same state again changes nothing
  const again = IRP.command(r.st, { state: 'idle' }, { manifest: M, now: T0 + 17000, stats: stats() });
  assert.equal(again.already, true);
  // stop: back to the default
  const ph = IRP.command(r.st, { state: 'music' }, { manifest: M, now: T0 + 18000, stats: stats() }).st;
  const stop = IRP.command(ph, { stop: true }, { manifest: M, now: T0 + 20000, stats: stats() });
  assert.equal(stop.to, 'idle');
  assert.equal(stop.settled.kind, 'music');
});

test('state machine: too tired for work / game — refused, the round before goes on, the lamp still switches', () => {
  const st = IRP.command(IRP.restore(M, null, T0), { state: 'phone' }, { manifest: M, now: T0, stats: stats(10) }).st;
  const r = IRP.command(st, { state: 'game', lamp: true }, { manifest: M, now: T0 + 5000, stats: stats(10) });
  assert.deepEqual([r.ok, r.reason, r.need, r.have, r.kind], [false, 'tired', 15, 9, 'game'], 'have: after the round before would be settled (25%: −1)');
  assert.equal(r.st.state, 'phone');
  assert.equal(r.st.run.kind, 'phone', 'not settled');
  assert.equal(r.st.lamp, true);
  assert.equal(IRP.command(st, { state: 'nope' }, { manifest: M, now: T0, stats: stats() }).reason, 'unknown');
});

test('state machine: tick — settled only when main’s clock agrees, then back to 发呆', () => {
  const st = IRP.command(IRP.restore(M, null, T0), { state: 'sleep' }, { manifest: M, now: T0, stats: stats() }).st;
  assert.equal(IRP.tick(st, { manifest: M, now: T0 + 10000 }), null);
  const r = IRP.tick(st, { manifest: M, now: T0 + 30000 });
  assert.equal(r.settled.complete, true);
  assert.deepEqual(r.settled.deltas, { energy: 35, mood: 6, focus: 8, fullness: -4 });
  assert.deepEqual([r.from, r.to, r.st.state, r.st.run], ['sleep', 'idle', 'idle', null]);
  assert.equal(IRP.tick(r.st, { manifest: M, now: T0 + 40000 }), null, 'nothing running');
});

test('state machine: chatNote — what she just did, the screen in words, tired, nothing asked', () => {
  const st0 = IRP.restore(M, null, T0);
  const r = IRP.command(st0, { state: 'work', screen: 'clips' }, { manifest: M, now: T0, stats: stats() });
  const note = IRP.chatNote(M, r.st, r, { now: T0 });
  assert.match(note, /^\[房间\] 你在自己的房间「鲸鱼女仆的雨夜小屋」里/);
  assert.match(note, /你已经坐到书桌前，打开了笔记本电脑，把台灯打开了；电脑屏幕上在刷短视频，现在这条是「深海里的水母，看着好安静」/);
  const music = IRP.command(st0, { state: 'music' }, { manifest: M, now: T0, stats: stats() });
  assert.match(IRP.chatNote(M, music.st, music), /手机上在放《雨夜的鲸鱼》（大肥鱼）/);
  const tired = IRP.command(st0, { state: 'work' }, { manifest: M, now: T0, stats: stats(5) });
  assert.match(IRP.chatNote(M, tired.st, tired), /你太累了（精力 5，至少要 15），没有去，还在发呆/);
  assert.match(IRP.chatNote(M, st0, null), /你正在发呆/);
  assert.equal(IRP.line(ROOM, 'ack', 'sleep'), '回来了，躺下了。');
  assert.equal(IRP.line({}, 'ack', 'game'), '来一局！', 'the engine’s own when the room has none');
});

test('persona: the room note goes in before the owner’s words, which stay last', () => {
  const pet = { name: '大肥鱼', affection: 10, hunger: 20, energy: 70, mood: 60, sleeping: false };
  const p = persona.buildChatPrompt('回床上休息吧', pet, T0, { room: '[房间] 你已经回到床上\n躺下了' });
  const lines = p.split('\n');
  assert.equal(lines[lines.length - 1], '回床上休息吧');
  assert.equal(lines[lines.length - 2], '[房间] 你已经回到床上 躺下了');
  assert.doesNotMatch(persona.buildChatPrompt('你好', pet, T0), /\[房间\]/);
});

// ---- main's side: GameLibrary.illustrated* with the installed pack and a stand-in PetService ---------------------
function lib() {
  const { GameLibrary } = require('../src/main/games');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-irlib-'));
  const dir = path.join(root, 'her-room');
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  const L = new GameLibrary({ userDir: root });
  const pet = { s: { base: 'dafeiyu', energy: 50, mood: 50, fullness: 50 }, quests: [] };
  const P = { stats: () => ({ ...pet.s }), settle: (s) => { Object.assign(pet.s, s); return { ...pet.s }; }, quest: (title) => { pet.quests.push(title); return { affection: { delta: 2 } }; } };
  return { L, root, pet, P };
}

test('GameLibrary.illustratedCommand: main decides, books the numbers, saves; the page cannot write the state', () => {
  const { L, root, pet, P } = lib();
  const boot = L.illustratedBoot('her-room', P, { now: T0 });
  assert.deepEqual([boot.state, boot.activity, boot.lamp, boot.recovered], ['idle', 'idle', false, null]);
  assert.deepEqual(boot.screens, { phone: 'lock' });
  let r = L.illustratedCommand('her-room', { cmd: 'set', state: 'sleep', from: 'click', seconds: 1, deltas: { energy: 40 } }, P, { now: T0 });
  assert.deepEqual([r.ok, r.from, r.to, r.started, r.line], [true, 'idle', 'sleep', 'sleep', '回来了，躺下了。']);
  assert.equal(r.run.seconds, 30, 'numbers sent by the page are ignored');
  assert.equal(GS.readProgress(root, 'her-room').state.state, 'sleep');
  r = L.illustratedCommand('her-room', { cmd: 'tick' }, P, { now: T0 + 5000 });
  assert.equal(r.settled, null);
  assert.equal(r.early, true);
  r = L.illustratedCommand('her-room', { cmd: 'tick' }, P, { now: T0 + 30000 });
  assert.equal(r.settled.complete, true);
  assert.deepEqual(r.settled.changed, { energy: 35, mood: 6, focus: 8, fullness: -4 });
  assert.equal(r.state, 'idle');
  assert.deepEqual(pet.s, { base: 'dafeiyu', energy: 85, mood: 56, fullness: 46 });
  assert.equal(GS.readProgress(root, 'her-room').state.focus.dafeiyu, 58);
  // the page's saveState writes nothing of an illustrated room
  assert.equal(L.saveState('her-room', { state: 'game', run: { kind: 'game' } }), true);
  assert.equal(GS.readProgress(root, 'her-room').state.state, 'idle');
});

test('GameLibrary.illustratedCommand: chat and lamp quests, a refusal when tired, invalid input', () => {
  const { L, pet, P } = lib();
  const day = GQ.dayKey(new Date());
  const todays = GQ.todays(fixture().quests, day).map((q) => q.id);
  let r = L.illustratedCommand('her-room', { cmd: 'set', state: 'work', screen: 'clips', from: 'chat' }, P, { now: T0 });
  assert.equal(r.lamp, true);
  assert.deepEqual(r.screens, { laptop: 'clips' });
  const done = r.completed.map((q) => q.id);
  if (todays.includes('chat-move')) assert.ok(done.includes('chat-move'), 'the chat quest');
  if (todays.includes('lamp-night')) assert.ok(done.includes('lamp-night'), 'the lamp quest');
  pet.s.energy = 5;
  r = L.illustratedCommand('her-room', { cmd: 'set', state: 'game', from: 'click' }, P, { now: T0 + 1000 });
  assert.deepEqual([r.ok, r.reason, r.need, r.have, r.state], [false, 'tired', 15, 2, 'work'], 'have: after work so far would be settled (−3)');
  assert.match(r.line, /累/);
  assert.equal(L.illustratedCommand('her-room', { cmd: 'set', screen: 'webview' }, P, { now: T0 }).screen, 'clips', 'an unknown screen is ignored');
  assert.equal(L.illustratedCommand('her-room', { cmd: 'hack' }, P, { now: T0 }).ok, false);
  assert.equal(L.illustratedCommand('her-room', { cmd: 'scale', k: 0.1 }, P, { now: T0 }).reason, 'test-only');
  assert.equal(L.illustratedCommand('nope', { cmd: 'state' }, P, { now: T0 }).ok, false);
});

test('GameLibrary: illustratedClose settles by how long it ran; a killed app’s round is recovered on boot', () => {
  const { L, root, P } = lib();
  L.illustratedCommand('her-room', { cmd: 'set', state: 'music', from: 'click' }, P, { now: T0 });
  const s = L.illustratedClose('her-room', P, { now: T0 + 12500 });
  assert.equal(s.kind, 'music');
  assert.equal(s.fraction, 0.5);
  assert.equal(GS.readProgress(root, 'her-room').state.state, 'music', 'she stays where she was');
  assert.equal(L.illustratedClose('her-room', P, { now: T0 + 20000 }), null, 'nothing running');
  L.illustratedCommand('her-room', { cmd: 'set', state: 'phone', from: 'click' }, P, { now: T0 + 30000 });
  const b = L.illustratedBoot('her-room', P, { now: T0 + 30000 + 60000 });
  assert.equal(b.recovered.kind, 'phone');
  assert.equal(b.recovered.complete, true, 'a whole round went by');
  assert.equal(b.state, 'idle');
});

test('GameLibrary.illustratedNote: the note for this turn, from the saved state', () => {
  const { L, P } = lib();
  const r = L.illustratedCommand('her-room', { cmd: 'set', state: 'sleep', lamp: false, from: 'chat' }, P, { now: T0 });
  assert.match(L.illustratedNote('her-room', r, { now: T0 }), /你已经回到床上，钻进被子躺下了/);
  assert.match(L.illustratedNote('her-room', null, { now: T0 }), /你正在睡觉/);
});

test('PetService.chat: with a roomHook the note reaches the prompt before the model; without one, nothing', async () => {
  require('./fixtures/adult-character');
  const { LhClient, cleanEnv } = require('../src/core/lh-client');
  const { Store } = require('../src/core/store');
  const { PetService } = require('../src/main/pet-service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petsvc-ir-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const lh = new LhClient({ bin: path.join(__dirname, 'fixtures', 'fake-lh.js'), env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), now: () => T0, rnd: () => 0.5 });
  svc.on('error', () => {});
  await svc.hatch({ speciesId: 'dafeiyu', name: '大肥鱼' });
  const seen = [];
  svc.roomHook = (text) => { seen.push(text); return '[房间] 你已经回到床上，钻进被子躺下了。'; };
  const r = await svc.chat('回床上休息吧');
  assert.ok(r.ok);
  assert.deepEqual(seen, ['回床上休息吧'], 'asked once, before the reply');
  const runs = fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const prompt = runs[runs.length - 1].prompt.split('\n');
  assert.equal(prompt[prompt.length - 1], '回床上休息吧');
  assert.equal(prompt[prompt.length - 2], '[房间] 你已经回到床上，钻进被子躺下了。');
  svc.roomHook = () => { throw new Error('boom'); };
  assert.ok((await svc.chat('你好')).ok, 'a hook that throws never stops the chat');
  svc.roomHook = null;
  await svc.chat('在吗');
  const last = fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  assert.doesNotMatch(last.prompt, /\[房间\]/);
});

test('像素房间: the bundled catalog names the room@1 game 「像素房间」 (pixel-room); 她的房间 is the illustrated one', () => {
  const cat = read(path.join(__dirname, '..', 'src', 'core', 'game-catalog.json'));
  const px = cat.games.find((g) => g.id === 'pixel-room');
  assert.equal(px.name, '像素房间');
  assert.equal(px.engine, 'room@1');
  assert.ok(!cat.games.some((g) => g.engine === 'room@1' && /她的房间/.test(g.name)));
  assert.equal(fixture().name, '她的房间');
  assert.equal(read(path.join(__dirname, 'fixtures', 'games', 'pixel-room', 'manifest.json')).name, '像素房间');
});

test('room-play is shared: the five timed kinds are 像素房间’s, 发呆 is the illustrated room’s own', () => {
  assert.deepEqual(RP.KINDS, ['sleep', 'work', 'phone', 'music', 'game']);
  assert.deepEqual(IRP.KINDS, [...RP.KINDS, 'idle']);
  assert.equal(RP.defsOf(M).idle, undefined);
});
