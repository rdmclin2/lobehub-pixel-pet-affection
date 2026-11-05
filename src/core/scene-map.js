'use strict';
// 像素小院 · 地图与寻路 (docs/pixel-scene-design.md §4.1). The yard is a 20×12 grid of 16 px tiles (320×192
// logical px; the scene draws it at y 0 of its 320×200 canvas, the last 8 px are the island's cliff face).
// `ground` says what each tile is; props (house, trees, bench, flower bed, lamp, pond) stand on tiles and block
// the ones in their `solid` rectangle. She walks on walkable tiles only (4-neighbour A*), along a path whose
// needless corners are removed (smoothPath), and a click on a blocked tile goes to the nearest walkable one.
// Pure and DOM-free (window.SceneMap in the page, require() in the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SceneMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TILE = 16;
  // # void (off the island)  . grass  : stone path  ~ water  = bridge  , garden soil
  const GROUND = [
    '####################',
    '##................##',
    '##................##',
    '##................##',
    '##........::......##',
    '##........::......##',
    '##........::......##',
    '##..,,,...::......##',
    '##........::.~~~~.##',
    '##........:::====.##',
    '##........::.~~~~.##',
    '####################',
  ];
  const WALKABLE = new Set(['.', ':', '=', ',']);

  // tile: top-left tile of its art; solid: [c0, r0, c1, r1] inclusive tiles it blocks; spot: the tile she stands
  // on to use it, face: which way she looks there; act: what she does (sit / water / lamp / look); box: where a
  // click picks it (logical px [x, y, w, h]); foot: the y her depth is sorted by (px).
  const PROPS = [
    { id: 'house', kind: 'house', name: '小屋', solid: [9, 1, 12, 3], box: [144, 6, 64, 58], foot: 64, windows: [[156, 42], [196, 42]] },
    { id: 'tree1', kind: 'tree', name: '大树', solid: [3, 3, 3, 3], box: [40, 20, 32, 44], foot: 64 },
    { id: 'tree2', kind: 'tree', name: '大树', solid: [16, 2, 16, 2], box: [248, 4, 32, 44], foot: 48 },
    { id: 'tree3', kind: 'tree', name: '大树', solid: [3, 9, 3, 9], box: [40, 116, 32, 44], foot: 160 },
    { id: 'bench', kind: 'bench', name: '长椅', solid: [5, 4, 6, 4], box: [80, 60, 32, 20], foot: 80, spot: [6, 5], face: 'left', act: 'sit' },
    { id: 'flowers', kind: 'flowerbed', name: '花坛', solid: [4, 7, 6, 7], box: [64, 108, 48, 22], foot: 128, spot: [7, 7], face: 'left', act: 'water' },
    { id: 'lamp', kind: 'lamp', name: '路灯', solid: [12, 5, 12, 5], box: [192, 56, 16, 40], foot: 96, spot: [12, 6], face: 'left', act: 'lamp', light: { x: 200, y: 62, r: 30 } },
    { id: 'pond', kind: 'pond', name: '池塘', solid: null, water: true, box: [208, 128, 64, 48], foot: 128, spot: [12, 8], face: 'right', act: 'look' },
  ];
  const ACTS = ['sit', 'water', 'lamp', 'look'];

  function createMap() {
    const cols = GROUND[0].length;
    const rows = GROUND.length;
    const blocked = new Set();
    for (const p of PROPS) {
      if (!p.solid) continue;
      const [c0, r0, c1, r1] = p.solid;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) blocked.add(`${c},${r}`);
    }
    return { tile: TILE, cols, rows, width: cols * TILE, height: rows * TILE, ground: GROUND, props: PROPS, blocked };
  }

  const groundAt = (m, c, r) => (r >= 0 && r < m.rows && c >= 0 && c < m.cols ? m.ground[r][c] : '#');
  const walkable = (m, c, r) => WALKABLE.has(groundAt(m, c, r)) && !m.blocked.has(`${c},${r}`);
  const tileOf = (m, x, y) => [Math.floor(x / m.tile), Math.floor(y / m.tile)];
  // where she stands on a tile: its centre, a little below the middle (her feet)
  const tileCenter = (m, c, r) => ({ x: c * m.tile + m.tile / 2, y: r * m.tile + m.tile / 2 + 4 });
  const walkableAt = (m, x, y) => { const [c, r] = tileOf(m, x, y); return walkable(m, c, r); };

  // the walkable tile nearest to (c, r) (itself when walkable), searching outward ring by ring
  function nearestWalkable(m, c, r) {
    const c0 = Math.max(0, Math.min(m.cols - 1, Math.round(c)));
    const r0 = Math.max(0, Math.min(m.rows - 1, Math.round(r)));
    if (walkable(m, c0, r0)) return [c0, r0];
    let best = null;
    for (let d = 1; d < m.cols + m.rows; d++) {
      for (let dr = -d; dr <= d; dr++) {
        for (let dc = -d; dc <= d; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== d) continue;
          const cc = c0 + dc;
          const rr = r0 + dr;
          if (!walkable(m, cc, rr)) continue;
          const dist = dc * dc + dr * dr;
          if (!best || dist < best.dist) best = { c: cc, r: rr, dist };
        }
      }
      if (best) return [best.c, best.r];
    }
    return null;
  }

  // A* on the tile grid, 4 neighbours. -> [[c, r], …] from `from` to `to` (both included), or null.
  function findPath(m, from, to) {
    const [sc, sr] = from;
    const [tc, tr] = to;
    if (!walkable(m, sc, sr) || !walkable(m, tc, tr)) return null;
    const key = (c, r) => r * m.cols + c;
    const h = (c, r) => Math.abs(c - tc) + Math.abs(r - tr);
    const open = [{ c: sc, r: sr, g: 0, f: h(sc, sr) }];
    const came = new Map();
    const g = new Map([[key(sc, sr), 0]]);
    const closed = new Set();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f || (open[i].f === open[bi].f && open[i].g > open[bi].g)) bi = i;
      const cur = open.splice(bi, 1)[0];
      const ck = key(cur.c, cur.r);
      if (closed.has(ck)) continue;
      if (cur.c === tc && cur.r === tr) {
        const path = [[tc, tr]];
        let k = ck;
        while (came.has(k)) { k = came.get(k); path.push([k % m.cols, Math.floor(k / m.cols)]); }
        return path.reverse();
      }
      closed.add(ck);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = cur.c + dc;
        const nr = cur.r + dr;
        if (!walkable(m, nc, nr)) continue;
        const nk = key(nc, nr);
        if (closed.has(nk)) continue;
        const ng = cur.g + 1;
        if (ng < (g.has(nk) ? g.get(nk) : Infinity)) {
          g.set(nk, ng);
          came.set(nk, ck);
          open.push({ c: nc, r: nr, g: ng, f: ng + h(nc, nr) });
        }
      }
    }
    return null;
  }

  // is the straight line between two px points over walkable tiles only (checked every 2 px, with her width)
  function clearLine(m, a, b, half = 3) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 2));
    for (let i = 0; i <= n; i++) {
      const x = a.x + (dx * i) / n;
      const y = a.y + (dy * i) / n;
      if (!walkableAt(m, x - half, y) || !walkableAt(m, x + half, y)) return false;
    }
    return true;
  }
  // tile path -> px waypoints with the corners she does not need removed (never through a blocked tile)
  function smoothPath(m, tiles, start = null) {
    if (!tiles || !tiles.length) return [];
    const pts = tiles.map(([c, r]) => tileCenter(m, c, r));
    if (start) pts[0] = { x: start.x, y: start.y };
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !clearLine(m, pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  // the prop under a logical px point (the one in front when two overlap), or null
  function propAt(m, x, y) {
    const water = groundAt(m, Math.floor(x / m.tile), Math.floor(y / m.tile)) === '~';
    const hit = m.props.filter((p) => p.act && (!p.water || water) && x >= p.box[0] && x < p.box[0] + p.box[2] && y >= p.box[1] && y < p.box[1] + p.box[3]);
    return hit.sort((a, b) => b.foot - a.foot)[0] || null;
  }
  const propById = (m, id) => m.props.find((p) => p.id === id) || null;
  // the depth key: things lower on the screen are drawn later (in front)
  const ySortKey = (footY) => footY;

  return { TILE, GROUND, PROPS, ACTS, createMap, groundAt, walkable, walkableAt, tileOf, tileCenter, nearestWalkable, findPath, clearLine, smoothPath, propAt, propById, ySortKey };
});
