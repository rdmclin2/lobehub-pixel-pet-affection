'use strict';
// The chat box under her feet (T-6162): her window grows down for it, and goes up only when the screen ends first.
const test = require('node:test');
const assert = require('node:assert/strict');
const { composerBounds } = require('../src/core/composer-space');

const area = { x: 0, y: 25, width: 1280, height: 775 }; // ends at y = 800
const pet = { x: 900, y: 100, width: 230, height: 340 };

test('with room below, the window grows down and she does not move', () => {
  const b = composerBounds({ bounds: pet, extra: 110, area });
  assert.deepEqual(b, { x: 900, y: 100, width: 230, height: 450, lift: 0 });
});

test('at the bottom of the screen the window goes up by what is missing, and comes back as the box closes', () => {
  const low = { ...pet, y: 436 }; // where she starts: the bottom right corner of the screen, 24px above its end
  const open = composerBounds({ bounds: low, extra: 110, area });
  assert.equal(open.y + open.height, 800, 'the box ends at the end of the screen');
  assert.equal(open.lift, 86);
  const taller = composerBounds({ bounds: { ...low, y: open.y, height: open.height }, prevExtra: 110, extra: 150, lift: open.lift, area });
  assert.equal(taller.y + taller.height, 800);
  assert.equal(taller.lift, 126);
  const closed = composerBounds({ bounds: { ...low, y: taller.y, height: taller.height }, prevExtra: 150, extra: 0, lift: taller.lift, area });
  assert.deepEqual(closed, { x: 900, y: 436, width: 230, height: 340, lift: 0 });
});

test('a window taller than the screen keeps its top on the screen', () => {
  const b = composerBounds({ bounds: { ...pet, y: 25, height: 700 }, extra: 200, area });
  assert.equal(b.y, 25);
});
