'use strict';
// 她的房间 · 聊天与状态一致 (core/room-chat.js, T-11734): what she says matches the picture. Reproduces T-11730's
// failures: 「玩把游戏吧」 left her where she was while the prompt never said so; 「那我把灯也熄了」 with the lamp on.
// `decide` stands in for `lh generate decide`, the rest is the real GameLibrary with the sample pack.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoomChat } = require('../src/core/room-chat');
const persona = require('../src/core/persona');

const SRC = path.join(__dirname, 'fixtures', 'games', 'her-room');
const T0 = new Date('2026-11-05T06:25:00').getTime();

function setup({ decide } = {}) {
  const { GameLibrary } = require('../src/main/games');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-roomchat-'));
  const dir = path.join(root, 'her-room');
  fs.mkdirSync(dir);
  for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(dir, f));
  const games = new GameLibrary({ userDir: root });
  const s = { base: 'dafeiyu', energy: 100, mood: 50, fullness: 50 };
  const pet = { stats: () => ({ ...s }), settle: (x) => { Object.assign(s, x); return { ...s }; }, quest: () => ({ affection: null }) };
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
  const pushed = [];
  const calls = [];
  const clock = { t: T0 };
  const chat = createRoomChat({
    open: () => ({ id: 'her-room', manifest }),
    games,
    pet,
    push: (r) => pushed.push(r),
    now: () => clock.t,
    decide: decide ? (req) => { calls.push(req); return decide(req); } : undefined,
  });
  const room = () => games.illustratedCommand('her-room', { cmd: 'state' }, pet, { now: clock.t });
  const set = (cmd) => games.illustratedCommand('her-room', { cmd: 'set', from: 'click', ...cmd }, pet, { now: clock.t });
  games.illustratedBoot('her-room', pet, { now: clock.t });
  return { chat, room, set, pushed, calls, clock };
}
// what `lh generate decide` answers: the state question and the lamp question
const answer = (state, lamp = 'none', p = 0.97) => async () => ({ answers: { state: { type: 'choice', choice: state, confidence: p, probabilities: { [state]: p } }, lamp: { type: 'choice', choice: lamp, confidence: p, probabilities: { [lamp]: p } } } });

test('「玩把游戏吧」 (no word for it): the model decides, the engine moves her to 打游戏, the note says she did', async () => {
  const t = setup({ decide: answer('game') });
  t.set({ state: 'music' });
  const note = await t.chat.onMessage('玩把游戏吧');
  assert.equal(t.calls.length, 1, 'the word list missed, so the model is asked');
  assert.equal(t.room().state, 'game');
  assert.equal(t.pushed.at(-1).state, 'game', 'the game window is told');
  assert.match(note, /状态已切换/);
  assert.match(note, /听音乐.*打游戏/);
});

test('every turn the note says the truth: whether the state changed, what it is now, the lamp', async () => {
  const t = setup({ decide: answer('none') });
  t.set({ state: 'music' });
  const note = await t.chat.onMessage('今天下雨了');
  assert.equal(t.room().state, 'music', 'small talk moves nothing');
  assert.match(note, /状态没变/);
  assert.match(note, /现在.*听音乐/);
  assert.match(note, /台灯.*关着/);
  assert.match(note, /不要(说|声称)/, 'she is told not to claim what did not happen');
  const hit = await t.chat.onMessage('打开电脑写周报吧');
  assert.match(hit, /状态已切换/);
  assert.match(hit, /台灯.*开着/);
  assert.match(hit, /刚.*打开/, 'the lamp came on by itself with 工作: her reply must know');
});

test('the model fails or times out: nothing moves, and the note says it did not understand', async () => {
  for (const decide of [async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); }, async () => ({ answers: {} })]) {
    const t = setup({ decide });
    t.set({ state: 'music' });
    const note = await t.chat.onMessage('玩把游戏吧');
    assert.equal(t.room().state, 'music', 'the state stays');
    assert.equal(t.room().lamp, false, 'the lamp stays');
    assert.match(note, /状态没变/);
    assert.match(note, /没听明白|没反应过来/);
  }
});

test('an unsure answer does not move her', async () => {
  const t = setup({ decide: answer('sleep', 'none', 0.45) });
  const note = await t.chat.onMessage('有点困了');
  assert.equal(t.room().state, 'idle');
  assert.match(note, /状态没变/);
});

test('small talk that happens to hold an activity word goes through the model: 「工作好累啊」 does not send her to the desk', async () => {
  const t = setup({ decide: answer('none') });
  for (const s of ['工作好累啊', '我累了想睡觉', '我回来了，今天工作好累']) {
    const note = await t.chat.onMessage(s);
    assert.equal(t.room().state, 'idle', s);
    assert.match(note, /状态没变/, s);
  }
  assert.equal(t.calls.length, 3);
});

test('a plain order does not wait for the model, and works when the model is down', async () => {
  const t = setup({ decide: async () => { throw new Error('down'); } });
  for (const [s, want] of [['回床上休息吧', 'sleep'], ['打开电脑刷抖音', 'work'], ['听歌', 'music'], ['看手机', 'phone']]) {
    await t.chat.onMessage(s);
    assert.equal(t.room().state, want, s);
  }
  assert.equal(t.calls.length, 0);
});

test('the lamp: the model can switch it, and the note says so', async () => {
  const t = setup({ decide: answer('none', 'on') });
  const note = await t.chat.onMessage('屋里太暗了，亮一点吧');
  assert.equal(t.room().lamp, true);
  assert.match(note, /台灯.*开着/);
});

test('she says she turned the lamp off in her reply: the picture follows', async () => {
  const t = setup({ decide: answer('none') });
  t.set({ lamp: true });
  await t.chat.onMessage('现在回床上休息吧，不玩了');
  const before = t.pushed.length;
  t.chat.onReply('好，电脑关掉了。那我把灯也熄了，先躺下歇会儿~');
  assert.equal(t.room().lamp, false);
  assert.equal(t.pushed.at(-1).lamp, false);
  assert.ok(t.pushed.length > before, 'the game window is told');
});

test('she only mentions the lamp: nothing changes', async () => {
  const t = setup({ decide: answer('none') });
  t.set({ lamp: true });
  for (const s of ['台灯还亮着，我就闭上眼了。', '要不要关灯？', '我不关灯，太黑了。', '灯没关。', '你想开灯吗']) {
    t.chat.onReply(s);
    assert.equal(t.room().lamp, true, s);
  }
  t.set({ lamp: false });
  for (const s of ['屋里没开灯，好蓝。', '灯还关着呢。', '不开灯也挺好。']) {
    t.chat.onReply(s);
    assert.equal(t.room().lamp, false, s);
  }
});

test('the note survives the prompt whole: its end (the rules) is not cut off', async () => {
  const t = setup({ decide: answer('none') });
  t.set({ state: 'work', screen: 'clips' });
  const note = await t.chat.onMessage('今天下雨了');
  const pet = { speciesId: 'dafeiyu', hunger: 10, mood: 50, energy: 50, affection: 10, lastInteractionAt: T0, relStage: 1, name: '大肥鱼' };
  const prompt = persona.buildChatPrompt('今天下雨了', pet, T0, { room: note });
  assert.ok(prompt.includes(note.slice(-30)), 'the whole note is in the prompt');
});

test('the room’s clock: it is always night in her room, whatever the real time; the note gives her that time', async () => {
  const IRP = require('../src/core/illustrated-room-play');
  for (let h = 0; h < 24; h++) {
    const c = IRP.roomClock(new Date(2026, 10, 5, h, 37).getTime());
    const hh = Number(c.split(':')[0]);
    assert.ok(hh >= 23 || hh < 4, `${h}:37 → ${c}`);
  }
  const t = setup({ decide: answer('none') });
  const note = await t.chat.onMessage('现在几点了');
  assert.match(note, new RegExp(`深夜 ?${IRP.roomClock(T0)}`));
  assert.doesNotMatch(note, /06:25/);
});

test('the settings window’s chat list says where she is: in the game, not on the desktop', async () => {
  require('./fixtures/adult-character');
  const { LhClient, cleanEnv } = require('../src/core/lh-client');
  const { Store } = require('../src/core/store');
  const { PetService } = require('../src/main/pet-service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petsvc-place-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const lh = new LhClient({ bin: path.join(__dirname, 'fixtures', 'fake-lh.js'), env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), now: () => T0, rnd: () => 0.5 });
  svc.on('error', () => {});
  await svc.hatch({ speciesId: 'dafeiyu', name: '大肥鱼' });
  const current = () => svc.chatCharacters().characters.find((c) => c.current);
  assert.equal(current().place, '在桌面');
  svc.placeHook = () => '她的房间';
  assert.equal(current().place, '在她的房间');
  assert.equal(svc.chatCharacters().characters.find((c) => !c.current).place, undefined);
});

test('PetService: her reply reaches the room after the turn, on both chat paths', async () => {
  require('./fixtures/adult-character');
  const { LhClient, cleanEnv } = require('../src/core/lh-client');
  const { Store } = require('../src/core/store');
  const { PetService } = require('../src/main/pet-service');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petsvc-reply-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const lh = new LhClient({ bin: path.join(__dirname, 'fixtures', 'fake-lh.js'), env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), now: () => T0, rnd: () => 0.5 });
  svc.on('error', () => {});
  await svc.hatch({ speciesId: 'dafeiyu', name: '大肥鱼' });
  const seen = [];
  svc.roomHook = async () => '[房间] 状态没变';
  svc.roomReplyHook = (text) => seen.push(text);
  const r = await svc.chat('你好');
  assert.equal(r.ok, true);
  assert.deepEqual(seen, [r.text]);
  const a = await svc.chatAs('dafeiyu', { text: '你好' });
  assert.equal(a.ok, true);
  assert.equal(seen.length, 2);
});
