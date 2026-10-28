'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/renderer/sprites');
const { SPECIES } = require('../src/core/species');

test('egg cracks progressively', () => {
  const sig = (n) => S.egg(n).map((r) => r.join('')).join('');
  assert.notEqual(sig(0), sig(1));
  assert.notEqual(sig(1), sig(3));
});

test('every egg pixel has a colour for every species', () => {
  for (const sp of Object.values(SPECIES)) {
    const pal = S.EGG_PAL(sp.egg);
    for (const row of S.egg(3)) for (const c of row) if (c !== '.') assert.ok(pal[c] || S.COMMON[c], `${sp.id}: ${c}`);
  }
});
