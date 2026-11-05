'use strict';
// 像素小院 · 地图与寻路 (src/core/scene-map.js, docs/pixel-scene-design.md §4.1)
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/core/scene-map');

const m = M.createMap();

test('the map: 20×12 tiles of 16 px; props block their tiles; every usable prop has a reachable spot', () => {
  assert.equal(m.cols, 20);
  assert.equal(m.rows, 12);
  assert.equal(m.width, 320);
  assert.ok(m.ground.every((row) => row.length === 20));
  assert.equal(M.walkable(m, 0, 0), false, 'off the island');
  assert.equal(M.walkable(m, 10, 2), false, 'the house');
  assert.equal(M.walkable(m, 14, 8), false, 'water');
  assert.equal(M.walkable(m, 14, 9), true, 'the bridge');
  assert.equal(M.walkable(m, 10, 6), true, 'the path');
  const usable = m.props.filter((p) => p.act);
  assert.deepEqual(usable.map((p) => p.act).sort(), ['lamp', 'look', 'sit', 'water']);
  for (const p of usable) {
    assert.ok(M.walkable(m, ...p.spot), `${p.id} spot`);
    assert.ok(M.findPath(m, [10, 6], p.spot), `${p.id} reachable`);
  }
});

test('findPath: around the house, across the bridge (not the water); every step is walkable and 4-connected', () => {
  const p = M.findPath(m, [8, 2], [13, 2]);
  assert.ok(p);
  for (let i = 0; i < p.length; i++) {
    assert.ok(M.walkable(m, ...p[i]));
    if (i) assert.equal(Math.abs(p[i][0] - p[i - 1][0]) + Math.abs(p[i][1] - p[i - 1][1]), 1);
  }
  assert.ok(p.some(([, r]) => r >= 4), 'goes round below the house');
  const b = M.findPath(m, [12, 9], [17, 9]);
  assert.deepEqual(b.map(([c]) => c), [12, 13, 14, 15, 16, 17], 'straight over the bridge');
  assert.equal(M.findPath(m, [10, 6], [14, 8]), null, 'water is not a destination');
  assert.equal(M.findPath(m, [0, 0], [10, 6]), null);
});

test('nearestWalkable: a blocked tile → the closest walkable one; a walkable one is itself', () => {
  assert.deepEqual(M.nearestWalkable(m, 10, 6), [10, 6]);
  const n = M.nearestWalkable(m, 10, 2);
  assert.ok(M.walkable(m, ...n));
  assert.ok(Math.abs(n[0] - 10) + Math.abs(n[1] - 2) <= 3, `${n}`);
  const w = M.nearestWalkable(m, 15, 8);
  assert.ok(M.walkable(m, ...w));
  assert.ok(M.walkable(m, ...M.nearestWalkable(m, -5, 40)));
});

test('smoothPath: fewer waypoints, the same ends, never through a blocked tile', () => {
  const tiles = M.findPath(m, [2, 1], [17, 9]);
  const pts = M.smoothPath(m, tiles);
  assert.ok(pts.length < tiles.length);
  assert.deepEqual(pts[0], M.tileCenter(m, 2, 1));
  assert.deepEqual(pts[pts.length - 1], M.tileCenter(m, 17, 9));
  for (let i = 1; i < pts.length; i++) assert.ok(M.clearLine(m, pts[i - 1], pts[i]), `segment ${i}`);
});

test('propAt: picks the usable prop under a point; the bridge is not the pond', () => {
  assert.equal(M.propAt(m, 96, 70).id, 'bench');
  assert.equal(M.propAt(m, 88, 118).id, 'flowers');
  assert.equal(M.propAt(m, 200, 80).id, 'lamp');
  assert.equal(M.propAt(m, 230, 134).id, 'pond');
  assert.equal(M.propAt(m, 230, 150), null, 'the bridge');
  assert.equal(M.propAt(m, 50, 40), null, 'a tree is not usable');
  assert.equal(M.ySortKey(80), 80);
});
