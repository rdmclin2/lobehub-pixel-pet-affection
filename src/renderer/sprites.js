'use strict';
// Procedural pixel-art spirit stones ("eggs") for the onboarding and hatching screens. The companions
// themselves are pictures (assets/chars, see src/core/outfits.js artFor). Works in the browser
// (window.Sprites) and in Node (tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sprites = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const N = 24; // sprite grid is N x N
  const OUTLINE = '#2b2233';
  const COMMON = { o: OUTLINE };

  function blank() {
    return Array.from({ length: N }, () => Array(N).fill('.'));
  }

  function inEllipse(x, y, cx, cy, rx, ry) {
    const dx = (x + 0.5 - cx) / rx;
    const dy = (y + 0.5 - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }

  function shadedBlob(g, cx, cy, rx, ry) {
    const solid = (x, y) => x >= 0 && y >= 0 && x < N && y < N && inEllipse(x, y, cx, cy, rx, ry);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!solid(x, y)) continue;
        const edge = !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1);
        if (edge) { g[y][x] = 'o'; continue; }
        const u = (x + 0.5 - cx) / rx;
        const v = (y + 0.5 - cy) / ry;
        g[y][x] = u + v < -0.85 ? 'l' : u * 0.5 + v > 0.62 ? 'd' : 'b';
      }
    }
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, v + amt));
    return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
  }

  const EGG_PAL = (sp) => ({ b: sp.shell, l: '#ffffff', d: shade(sp.shell, -28), a: sp.spot });

  // Egg with spots; cracks 0..3 (3 = about to hatch).
  function egg(cracks = 0) {
    const g = blank();
    shadedBlob(g, N / 2, 14.5, 6.5, 8.5);
    [[10, 13], [14, 17], [12, 9], [15, 12]].forEach(([x, y]) => { if (g[y][x] !== 'o' && g[y][x] !== '.') { g[y][x] = 'a'; g[y][x + 1] = 'a'; } });
    const crack = [[12, 8], [13, 9], [12, 10], [13, 11], [12, 12], [11, 13]];
    crack.slice(0, cracks * 2).forEach(([x, y]) => { g[y][x] = 'o'; });
    return g;
  }

  function drawGrid(ctx, grid, colorOf, scale, ox = 0, oy = 0) {
    for (let y = 0; y < grid.length; y++) for (let x = 0; x < grid[y].length; x++) {
      const c = grid[y][x];
      if (c === '.') continue;
      const col = colorOf(c);
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }

  return { N, COMMON, EGG_PAL, egg, drawGrid };
});
