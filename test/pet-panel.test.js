'use strict';
// 她的面板 (src/main/pet-panel.js): where its window goes beside her (core/pet-panel.js placeBeside).
const test = require('node:test');
const assert = require('node:assert/strict');
const { placeBeside } = require('../src/core/pet-panel');

const area = { x: 0, y: 0, width: 1280, height: 1000 };
const size = { w: 264, h: 234 };
const PAD = 12;
const inside = (b) => b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width && b.y + b.height <= area.y + area.height;
// the card (the window minus its shadow room) and her box do not overlap
const clear = (b, her) => {
  const c = { x: b.x + PAD, y: b.y + PAD, r: b.x + b.width - PAD, b: b.y + b.height - PAD };
  return c.r <= her.x || c.x >= her.x + her.width || c.b <= her.y || c.y >= her.y + her.height;
};

test('beside her on the right, the card level with her feet', () => {
  const her = { x: 400, y: 600, width: 150, height: 190 };
  const b = placeBeside({ anchor: her, size, area, pad: PAD });
  assert.equal(b.side, 'right');
  assert.equal(b.x + PAD, her.x + her.width + 8, '8 px gap between her and the card');
  assert.equal(b.y + b.height - PAD, her.y + her.height, 'card bottom at her feet');
  assert.ok(inside(b) && clear(b, her));
});

test('at the right edge of the screen it opens on her left', () => {
  const her = { x: 1280 - 160, y: 700, width: 150, height: 190 };
  const b = placeBeside({ anchor: her, size, area, pad: PAD });
  assert.equal(b.side, 'left');
  assert.equal(b.x + b.width - PAD, her.x - 8);
  assert.ok(inside(b) && clear(b, her));
});

test('near the top of the screen it is pushed down, never off screen', () => {
  const her = { x: 300, y: 10, width: 150, height: 120 };
  const b = placeBeside({ anchor: her, size, area, pad: PAD });
  assert.ok(inside(b));
  assert.ok(b.y >= area.y);
});

test('a screen too narrow for either side: over her, centred, still inside', () => {
  const small = { x: 0, y: 0, width: 400, height: 600 };
  const her = { x: 120, y: 300, width: 150, height: 190 };
  const b = placeBeside({ anchor: her, size, area: small, pad: PAD });
  assert.equal(b.side, 'over');
  assert.ok(b.x >= 0 && b.x + b.width <= 400);
});

test('a second screen: the coordinates of that screen', () => {
  const right = { x: 1280, y: 0, width: 1920, height: 1080 };
  const her = { x: 1280 + 1700, y: 800, width: 150, height: 190 };
  const b = placeBeside({ anchor: her, size, area: right, pad: PAD });
  assert.equal(b.side, 'left');
  assert.ok(b.x >= right.x && b.x + b.width <= right.x + right.width);
});
