'use strict';
// App snapshot → semantic events for a VRM figure (src/core/vrm-intent.js, docs/vrm-motion-system.md §2.2).
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../src/core/vrm-intent');

const base = { t: 0, status: 'idle', shot: null, lifted: false, flying: false, thinking: false, eating: null, talking: false, voice: null, walking: false, touch: null, facing: 'right', pointerInside: false };

test('a touch counts once: the edge of lastTouch.n, with the zone and the mood touch-zones chose', () => {
  const a = { ...base, touch: { n: 3, zone: 'head', mood: 'happy' } };
  assert.deepEqual(I.fromSnapshot(a, null).events, [], 'no previous frame: nothing to compare (no replay on load)');
  assert.deepEqual(I.fromSnapshot(a, a).events, [], 'the same touch is not an event again');
  const b = { ...base, touch: { n: 4, zone: 'chest', mood: 'shy' } };
  assert.deepEqual(I.fromSnapshot(b, a).events, [{ type: 'touch', zone: 'chest', mood: 'shy', streak: 0 }]);
  // the plain click (touch zones off): fx shot pat, on its rising edge only
  const p = { ...base, shot: 'pat' };
  assert.deepEqual(I.fromSnapshot(p, base).events, [{ type: 'touch', zone: 'pat', mood: 'happy', streak: 0 }]);
  assert.deepEqual(I.fromSnapshot(p, p).events, []);
});

test('lifted / flying: drag:lift on the way up, drag:drop or drag:thrown on the way down; lift is held', () => {
  const up = { ...base, lifted: true };
  const r = I.fromSnapshot(up, base);
  assert.deepEqual(r.events, [{ type: 'drag', what: 'lift' }]);
  assert.equal(r.holds.lift, true);
  assert.deepEqual(I.fromSnapshot(up, up).events, []);
  assert.deepEqual(I.fromSnapshot(base, up).events, [{ type: 'drag', what: 'drop' }]);
  const fly = { ...base, flying: true };
  assert.deepEqual(I.fromSnapshot(base, fly).events, [{ type: 'drag', what: 'thrown' }]);
});

test('holds: mood from pet-state, talk / think / eat / walk, attention, facing; cues and celebrations from the shot', () => {
  const h = I.fromSnapshot({ ...base, status: 'sleep', talking: false, voice: 'audio', thinking: true, eating: 'rice', walking: true, pointerInside: true, facing: 'left' }, base).holds;
  assert.deepEqual(h, { mood: 'sleep', talk: true, think: true, eat: 'rice', walk: true, lift: false, attention: true, facing: 'left' });
  assert.equal(I.fromSnapshot({ ...base, status: 'weird' }, base).holds.mood, 'idle');
  assert.deepEqual(I.fromSnapshot({ ...base, shot: 'look' }, base).events, [{ type: 'cue', name: 'look' }]);
  assert.deepEqual(I.fromSnapshot({ ...base, shot: 'evolve' }, base).events, [{ type: 'celebrate', name: 'evolve' }]);
});

test('events never say how to move (no hop / spin / dangle…): VRM decides that itself', () => {
  const snaps = [base, { ...base, shot: 'play' }, { ...base, lifted: true }, base, { ...base, flying: true }, base, { ...base, touch: { n: 1, zone: 'butt', mood: 'angry' } }, { ...base, touch: { n: 2, zone: 'feet', mood: 'ticklish' } }, { ...base, shot: 'happy' }];
  let prev = null;
  const out = [];
  for (const s of snaps) { out.push(I.fromSnapshot(s, prev)); prev = s; }
  const text = JSON.stringify(out);
  for (const w of ['hop', 'spin', 'dangle', 'stride', 'wobble', 'shake', 'sway', 'flinch', 'armsOut', 'nod']) assert.ok(!text.includes(w), w);
});

test('an old-style { state } call (the picture, the hatch screen) becomes a snapshot', () => {
  assert.equal(I.fromState('sad').status, 'sad');
  assert.equal(I.fromState('lifted').lifted, true);
  assert.equal(I.fromState('eat_cookie').eating, 'cookie');
  assert.equal(I.fromState('hatch').shot, 'hatch');
  assert.equal(I.summary(I.fromSnapshot({ ...base, thinking: true, shot: 'look' }, base)), 'mood:idle think cue:look');
});
