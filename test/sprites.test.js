'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/renderer/sprites');

test('all species/status frames are well-formed', () => {
  assert.deepEqual(S.validate(), []);
});

test('the three species look different from each other', () => {
  const sig = (id) => S.frame({ speciesId: id, status: 'idle', t: 0 }).grid.map((r) => r.join('')).join('');
  assert.notEqual(sig('embit'), sig('bubbo'));
  assert.notEqual(sig('bubbo'), sig('sprig'));
  assert.notEqual(sig('embit'), sig('sprig'));
});

test('only the adult body exists: no younger forms', () => {
  assert.deepEqual(Object.keys(S.STAGE_DIM), ['adult']);
});

test('egg cracks progressively', () => {
  const sig = (n) => S.egg(n).map((r) => r.join('')).join('');
  assert.notEqual(sig(0), sig(1));
  assert.notEqual(sig(1), sig(3));
});
