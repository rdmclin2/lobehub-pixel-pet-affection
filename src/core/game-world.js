'use strict';
// 小游戏 · 可走区域与寻路 (docs/mini-games.md §4). A game pack's world is a picture in world px; where she may
// walk is given as polygons: `walk.area` (the ground she can stand on, e.g. the island's top) minus
// `walk.blocked` (houses, trees, water …, each a polygon or an ellipse { cx, cy, rx, ry }). The world is cut into
// square cells of `walk.cell` px; a cell is walkable when its centre is in the area and in no blocked shape.
// She walks cell to cell (8-neighbour A*, no corner cutting), then the path is pulled straight wherever the line
// between two points crosses only walkable cells.
// Pure and DOM-free (window.GameWorld in the page, require() in the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameWorld = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function inPoly(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
    }
    return inside;
  }
  function inShape(s, x, y) {
    if (Array.isArray(s)) return inPoly(s, x, y);
    if (s && Number.isFinite(s.rx)) {
      const dx = (x - s.cx) / s.rx;
      const dy = (y - s.cy) / s.ry;
      return dx * dx + dy * dy <= 1;
    }
    if (s && Array.isArray(s.poly)) return inPoly(s.poly, x, y);
    return false;
  }

  // world: { width, height }, walk: { cell, area: [[x,y]…], blocked: [shape…] }
  function createWorld({ width, height, walk }) {
    const cell = Math.max(4, Math.round(walk.cell || 8));
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    const grid = new Uint8Array(cols * rows);
    const blocked = (walk.blocked || []).slice();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c + 0.5) * cell;
        const y = (r + 0.5) * cell;
        if (!inPoly(walk.area, x, y)) continue;
        if (blocked.some((s) => inShape(s, x, y))) continue;
        grid[r * cols + c] = 1;
      }
    }
    return { width, height, cell, cols, rows, grid };
  }

  const cellOf = (w, x, y) => [Math.floor(x / w.cell), Math.floor(y / w.cell)];
  const centerOf = (w, c, r) => [(c + 0.5) * w.cell, (r + 0.5) * w.cell];
  const open = (w, c, r) => c >= 0 && r >= 0 && c < w.cols && r < w.rows && w.grid[r * w.cols + c] === 1;
  const walkableAt = (w, x, y) => { const [c, r] = cellOf(w, x, y); return open(w, c, r); };
  const walkableCount = (w) => w.grid.reduce((n, v) => n + v, 0);

  // the walkable cell nearest to (x, y) (a ring search), or null when nothing in reach is walkable
  function nearestOpen(w, x, y, maxRing = 64) {
    const [c0, r0] = cellOf(w, x, y);
    if (open(w, c0, r0)) return [c0, r0];
    let best = null;
    let bestD = Infinity;
    for (let k = 1; k <= maxRing; k++) {
      for (let dc = -k; dc <= k; dc++) {
        for (const dr of [-k, k]) for (const [c, r] of [[c0 + dc, r0 + dr], [c0 + dr, r0 + dc]]) {
          if (!open(w, c, r)) continue;
          const d = (c - c0) ** 2 + (r - r0) ** 2;
          if (d < bestD) { bestD = d; best = [c, r]; }
        }
      }
      if (best) return best;
    }
    return null;
  }

  // 8-neighbour A* from cell a to cell b; diagonal steps only when both side cells are open (no corner cutting)
  function findCells(w, a, b) {
    if (!open(w, a[0], a[1]) || !open(w, b[0], b[1])) return null;
    const N = w.cols * w.rows;
    const idx = (c, r) => r * w.cols + c;
    const g = new Float32Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = []; // [f, i]
    const push = (f, i) => {
      heap.push([f, i]);
      let k = heap.length - 1;
      while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1;
          const r = l + 1;
          let m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break;
          [heap[m], heap[k]] = [heap[k], heap[m]];
          k = m;
        }
      }
      return top;
    };
    const h = (c, r) => { const dx = Math.abs(c - b[0]); const dy = Math.abs(r - b[1]); return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy); };
    const s = idx(a[0], a[1]);
    const goal = idx(b[0], b[1]);
    g[s] = 0;
    push(h(a[0], a[1]), s);
    while (heap.length) {
      const [, i] = pop();
      if (closed[i]) continue;
      if (i === goal) break;
      closed[i] = 1;
      const c = i % w.cols;
      const r = (i / w.cols) | 0;
      for (let dc = -1; dc <= 1; dc++) {
        for (let dr = -1; dr <= 1; dr++) {
          if (!dc && !dr) continue;
          const nc = c + dc;
          const nr = r + dr;
          if (!open(w, nc, nr)) continue;
          if (dc && dr && (!open(w, c + dc, r) || !open(w, c, r + dr))) continue;
          const j = idx(nc, nr);
          if (closed[j]) continue;
          const ng = g[i] + (dc && dr ? Math.SQRT2 : 1);
          if (ng < g[j]) { g[j] = ng; from[j] = i; push(ng + h(nc, nr), j); }
        }
      }
    }
    if (s !== goal && from[goal] < 0) return null;
    const out = [];
    for (let i = goal; i !== -1; i = i === s ? -1 : from[i]) out.push([i % w.cols, (i / w.cols) | 0]);
    return out.reverse();
  }

  // every cell the segment p→q passes over is walkable (sampled at a quarter cell)
  function clearLine(w, p, q) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = Math.max(1, Math.ceil(d / (w.cell / 4)));
    for (let k = 0; k <= n; k++) {
      const x = p[0] + ((q[0] - p[0]) * k) / n;
      const y = p[1] + ((q[1] - p[1]) * k) / n;
      if (!walkableAt(w, x, y)) return false;
    }
    return true;
  }

  // string-pulling: keep a point only when the next one cannot be seen in a straight walkable line
  function smoothPath(w, pts) {
    if (pts.length <= 2) return pts.slice();
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !clearLine(w, pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  // a walking path in world px from (x0, y0) to the walkable point nearest (x1, y1); null when unreachable.
  // The first point is where she is; the last is exactly (x1, y1) when that point itself is walkable.
  function findPath(w, x0, y0, x1, y1) {
    const a = nearestOpen(w, x0, y0);
    const b = nearestOpen(w, x1, y1);
    if (!a || !b) return null;
    const cells = findCells(w, a, b);
    if (!cells) return null;
    const pts = cells.map(([c, r]) => centerOf(w, c, r));
    pts[0] = walkableAt(w, x0, y0) ? [x0, y0] : pts[0];
    if (walkableAt(w, x1, y1)) pts[pts.length - 1] = [x1, y1];
    const path = smoothPath(w, pts);
    if (path.length > 1 && path[0][0] === x0 && path[0][1] === y0) return path;
    return [[x0, y0], ...path];
  }

  const pathLength = (path) => path.reduce((n, p, i) => (i ? n + Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) : 0), 0);

  // a random walkable point between minD and maxD px from (x, y), reachable from there; null if none found
  function randomSpot(w, x, y, rnd = Math.random, { minD = 60, maxD = 260, tries = 40 } = {}) {
    for (let k = 0; k < tries; k++) {
      const a = rnd() * Math.PI * 2;
      const d = minD + rnd() * (maxD - minD);
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d * 0.6;
      if (!walkableAt(w, px, py)) continue;
      if (findPath(w, x, y, px, py)) return [px, py];
    }
    return null;
  }

  return { inPoly, inShape, createWorld, cellOf, centerOf, open, walkableAt, walkableCount, nearestOpen, findCells, clearLine, smoothPath, findPath, pathLength, randomSpot };
});
