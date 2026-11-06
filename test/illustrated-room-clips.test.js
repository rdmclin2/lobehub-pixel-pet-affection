'use strict';
// T-11726: 「打开电脑刷抖音」 — her reply and the short video on the screen have to be about the same clip. The reply
// takes seconds; the screen used to swipe on its own random timer in the meantime (she said 水母, the screen played 雨夜台灯).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const IRP = require('../src/core/illustrated-room-play');
const RoomIntent = require('../src/core/room-intent');
const M = require('./fixtures/games/her-room/manifest.json');

const T0 = 1762400000000;
const ROOM = IRP.roomOf(M, M.defaultRoom);
const LIST = ROOM.content.clips.list;
const stats = { energy: 80, mood: 50, focus: 50, fullness: 50 };

// the real page script (renderer/game/engines/screen-content.js) on a canvas that draws nothing
function fakeCanvas() {
  const g = new Proxy({}, {
    get: (t, k) => {
      if (k in t) return t[k];
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4 * 64) });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => {};
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { width: 0, height: 0, getContext: () => g, toDataURL: () => '' };
}
function loadScreenContent() {
  global.document = { createElement: fakeCanvas };
  global.self = global;
  delete require.cache[require.resolve('../src/renderer/game/engines/screen-content.js')];
  require(path.join('..', 'src/renderer/game/engines/screen-content.js'));
  return global.ScreenContent;
}
// the screen, driven the way the page drives it, from t0 to t1
function play(screen, anchorOf, t0, t1) {
  for (let t = t0; t <= t1; t += 250) screen.update(0.25, { clip: IRP.clipNow(ROOM, anchorOf(), t) });
}
const quoted = (note) => (/现在这条是「([^」]+)」/.exec(note) || [])[1];

test('「打开电脑刷抖音」: the clip in the reply is the clip on the screen, for as long as the reply takes', () => {
  const SC = loadScreenContent();
  const intent = RoomIntent.matchRoomIntent('打开电脑刷抖音', ROOM.intents, { state: 'idle', screen: null });
  assert.deepEqual([intent.state, intent.screen], ['work', 'clips']);
  const r = IRP.command(IRP.restore(M, null, T0), { ...intent, from: 'chat' }, { manifest: M, now: T0, stats });
  const note = IRP.chatNote(M, r.st, r, { now: T0 });
  const said = quoted(note);
  assert.ok(said, note);
  const v = IRP.view(r.st, { manifest: M, now: T0 });
  const screen = SC.create('clips', { w: 640, h: 400, room: ROOM });
  screen.update(0, { clip: IRP.clipNow(ROOM, v.clipAnchor, T0) });
  assert.equal(screen.info().clip.caption, said, 'when she starts');
  // the slowest screen timer used to fire at 15 s: the answer arrives well after that
  play(screen, () => v.clipAnchor, T0, T0 + 45000);
  assert.equal(screen.info().clip.caption, said, 'when her reply arrives, 45 s later');
  play(screen, () => v.clipAnchor, T0 + 45000, T0 + IRP.CLIP_HOLD_MS - 1000);
  assert.equal(screen.info().clip.caption, said, 'still held');
});

test('the screen moves on by itself after the hold, and a later note names the clip it has moved to', () => {
  const SC = loadScreenContent();
  const r = IRP.command(IRP.restore(M, null, T0), { state: 'work', screen: 'clips', from: 'chat' }, { manifest: M, now: T0, stats });
  const v = IRP.view(r.st, { manifest: M, now: T0 });
  const screen = SC.create('clips', { w: 640, h: 400, room: ROOM });
  screen.update(0, { clip: 0 });
  const later = T0 + IRP.CLIP_HOLD_MS + 40000;
  play(screen, () => v.clipAnchor, T0, later);
  const onScreen = screen.info().clip;
  assert.notEqual(onScreen.index, 0, 'it swiped');
  // the owner asks what she is watching: that turn's note, and the clip stays while she answers
  const held = IRP.holdClip(r.st, M, later);
  assert.equal(quoted(IRP.chatNote(M, held, null, { now: later })), onScreen.caption);
  const vh = IRP.view(held, { manifest: M, now: later });
  play(screen, () => vh.clipAnchor, later, later + 45000);
  assert.equal(screen.info().clip.caption, onScreen.caption);
});

test('「下一个」: one swipe, from the clip actually on the screen; note and caption agree', () => {
  const SC = loadScreenContent();
  const r0 = IRP.command(IRP.restore(M, null, T0), { state: 'work', screen: 'clips', from: 'click' }, { manifest: M, now: T0, stats });
  const v0 = IRP.view(r0.st, { manifest: M, now: T0 });
  const screen = SC.create('clips', { w: 640, h: 400, room: ROOM });
  screen.update(0, { clip: 0 });
  const t1 = T0 + 15000; // one self-swipe in: the owner's 下一个 means the one after this
  play(screen, () => v0.clipAnchor, T0, t1);
  const before = screen.info().clip.index;
  assert.equal(before, 1);
  const intent = RoomIntent.matchRoomIntent('下一个', ROOM.intents, { state: 'work', screen: 'clips' });
  assert.equal(intent.next, true);
  const r1 = IRP.command(r0.st, { ...intent, from: 'chat' }, { manifest: M, now: t1, stats });
  const said = quoted(IRP.chatNote(M, r1.st, r1, { now: t1 }));
  const v1 = IRP.view(r1.st, { manifest: M, now: t1 });
  play(screen, () => v1.clipAnchor, t1, t1 + 30000);
  assert.equal(screen.info().clip.index, before + 1, 'exactly one clip further');
  assert.equal(screen.info().clip.caption, said);
  assert.equal(said, LIST[before + 1].caption);
});

test('changing state starts the feed over; an old save without a clip anchor still plays', () => {
  const r = IRP.command(IRP.restore(M, { engine: IRP.ENGINE, room: ROOM.id, state: 'phone', clip: 3, since: T0 - 1000 }, T0), { state: 'work', screen: 'clips' }, { manifest: M, now: T0, stats });
  assert.equal(IRP.view(r.st, { manifest: M, now: T0 }).clip, 0);
  const old = IRP.restore(M, { engine: IRP.ENGINE, room: ROOM.id, state: 'phone', clip: 2, since: T0 }, T0);
  assert.equal(IRP.view(old, { manifest: M, now: T0 }).clip, 2);
  assert.ok(Number.isInteger(IRP.view(old, { manifest: M, now: T0 + 1e7 }).clip));
});
