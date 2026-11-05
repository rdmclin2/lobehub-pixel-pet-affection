'use strict';
// 小游戏 · 可走区域与寻路 (src/core/game-world.js, docs/mini-games.md §4)
const test = require('node:test');
const assert = require('node:assert/strict');
const GW = require('../src/core/game-world');

const square = { width: 400, height: 400, walk: { cell: 8, area: [[0, 0], [400, 0], [400, 400], [0, 400]], blocked: [[[150, 0], [250, 0], [250, 300], [150, 300]], { cx: 320, cy: 320, rx: 30, ry: 20 }] } };

test('grid: a cell is walkable when its centre is in the area and in no blocked polygon / ellipse', () => {
  const w = GW.createWorld(square);
  assert.equal(w.cols, 50);
  assert.equal(GW.walkableAt(w, 20, 20), true);
  assert.equal(GW.walkableAt(w, 200, 100), false, 'inside the wall');
  assert.equal(GW.walkableAt(w, 320, 320), false, 'inside the ellipse');
  assert.equal(GW.walkableAt(w, 200, 350), true, 'below the wall');
  assert.equal(GW.walkableAt(w, -5, 20), false, 'outside the world');
});

test('findPath: goes round the wall, never through it, and ends where asked', () => {
  const w = GW.createWorld(square);
  const p = GW.findPath(w, 50, 50, 350, 50);
  assert.ok(p && p.length >= 3, 'a path with corners');
  assert.deepEqual(p[0], [50, 50]);
  assert.deepEqual(p[p.length - 1], [350, 50]);
  for (let i = 1; i < p.length; i++) assert.ok(GW.clearLine(w, p[i - 1], p[i]), `segment ${i} crosses only walkable cells`);
  assert.ok(Math.max(...p.map((q) => q[1])) >= 300, 'it went round the bottom of the wall');
  assert.ok(GW.pathLength(p) > 600);
});

test('findPath: a straight line when nothing is in the way (string pulling); a blocked goal goes to the nearest walkable point', () => {
  const w = GW.createWorld(square);
  assert.deepEqual(GW.findPath(w, 20, 350, 120, 380), [[20, 350], [120, 380]]);
  const p = GW.findPath(w, 50, 350, 200, 150);
  const end = p[p.length - 1];
  assert.equal(GW.walkableAt(w, end[0], end[1]), true);
  assert.ok(Math.hypot(end[0] - 200, end[1] - 150) < 160);
});

test('unreachable: an island cut off by blocked cells gives null', () => {
  const w = GW.createWorld({ width: 200, height: 100, walk: { cell: 10, area: [[0, 0], [200, 0], [200, 100], [0, 100]], blocked: [[[90, -10], [110, -10], [110, 110], [90, 110]]] } });
  assert.equal(GW.findCells(w, [1, 1], [18, 1]), null);
  assert.equal(GW.findPath(w, 20, 20, 180, 20), null);
});

test('randomSpot: a reachable walkable point within the distance band', () => {
  const w = GW.createWorld(square);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20; i++) {
    const p = GW.randomSpot(w, 60, 60, rnd, { minD: 30, maxD: 120 });
    assert.ok(p, 'found one');
    assert.equal(GW.walkableAt(w, p[0], p[1]), true);
    assert.ok(GW.findPath(w, 60, 60, p[0], p[1]));
  }
});

test('the 像素小院 pack: every thing she can use is reachable from where she starts', () => {
  const m = require('../catalog/games/pixel-yard/manifest.json');
  const blocked = [...m.walk.blocked, ...m.objects.filter((o) => o.block).map((o) => o.block)];
  const w = GW.createWorld({ width: m.world.width, height: m.world.height, walk: { cell: m.walk.cell, area: m.walk.area, blocked } });
  assert.ok(GW.walkableCount(w) > 2000);
  assert.equal(GW.walkableAt(w, ...m.spawn), true, 'spawn');
  for (const o of m.objects.filter((x) => x.use)) {
    assert.equal(GW.walkableAt(w, ...o.use.at), true, `${o.id}: where she stands to use it is walkable`);
    assert.ok(GW.findPath(w, ...m.spawn, ...o.use.at), `${o.id}: reachable`);
  }
});
