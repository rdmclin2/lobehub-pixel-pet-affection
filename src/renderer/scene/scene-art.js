'use strict';
// 像素小院 · 美术 (docs/pixel-scene-design.md §3.4). Every tile and prop is generated here from a fixed palette
// when the page starts — no picture files, nothing from the reference video. All coordinates are logical pixels
// (the 320×200 canvas); everything is drawn with whole-pixel fillRect, so it stays hard-edged when scaled.
// The time-of-day light and the weather tint are applied over the finished picture by scene.js, so there is one
// set of art for day and night.
(function (root) {
  const P = {
    ink: '#1c2b1a', g0: '#2f5d2a', g1: '#3f7a32', g2: '#5a9a3c', g3: '#8cc152', g4: '#b5dc6e',
    p0: '#7d6d52', p1: '#b3a17c', p2: '#d9c9a0',
    s0: '#4f3422', s1: '#714a2f',
    w0: '#215b74', w1: '#2f7f9a', w2: '#5fb4c4', w3: '#c8f0ee',
    d0: '#3e2718', d1: '#6e4529', d2: '#94623a', d3: '#b8814f',
    r0: '#6f2620', r1: '#a63c2c', r2: '#cf5a3a', r3: '#e98a5a',
    m0: '#b3a893', m1: '#e8e0cf', m2: '#f6f1e4',
    c0: '#2e2620', c1: '#4f3f32', c2: '#77604b', c3: '#9a8166',
    metal: '#2c2f36', glassOff: '#4a4f4a', glassOn: '#ffe9a8', winDark: '#2a3348', winLit: '#ffd27a',
    fl0: '#e85a7a', fl1: '#f4d04a', fl2: '#ffffff', fl3: '#a77be0', wilt: '#7a5a4a',
  };
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

  const hash = (x, y, s = 0) => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const R = (ctx, x, y, w, h, col) => { ctx.fillStyle = col; ctx.fillRect(x | 0, y | 0, w | 0, h | 0); };

  // a mask -> pixels, coloured by shade(x, y) and outlined in ink
  function maskArt(w, h, inside, shade, outline = P.ink) {
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    const m = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = inside(x, y);
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (at(x, y)) R(ctx, x, y, 1, 1, shade(x, y));
        else if (outline && (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1))) R(ctx, x, y, 1, 1, outline);
      }
    }
    return c;
  }

  // ---- ground: the island's tiles, its edge and the cliff face (the waterfall is animated in scene.js) ----
  function buildGround(map) {
    const W = 320;
    const H = 200;
    const c = canvas(W, H);
    const ctx = c.getContext('2d');
    const T = map.tile;
    const g = (cc, rr) => (rr >= 0 && rr < map.rows && cc >= 0 && cc < map.cols ? map.ground[rr][cc] : '#');
    for (let r = 0; r < map.rows; r++) {
      for (let col = 0; col < map.cols; col++) {
        const t = g(col, r);
        const x0 = col * T;
        const y0 = r * T;
        if (t === '#') continue;
        if (t === '.' || t === ',') {
          R(ctx, x0, y0, T, T, P.g2);
          for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
            const h = hash(x0 + x, y0 + y, 1);
            if (h < 0.05) R(ctx, x0 + x, y0 + y, 1, 1, P.g3);
            else if (h < 0.1) R(ctx, x0 + x, y0 + y, 1, 1, P.g1);
          }
          if (hash(col, r, 2) < 0.45) { // a tuft
            const tx = x0 + 3 + Math.floor(hash(col, r, 3) * 9);
            const ty = y0 + 4 + Math.floor(hash(col, r, 4) * 8);
            R(ctx, tx, ty, 1, 2, P.g1); R(ctx, tx + 2, ty, 1, 2, P.g1); R(ctx, tx + 1, ty - 1, 1, 3, P.g3);
          }
        } else if (t === ':') {
          R(ctx, x0, y0, T, T, P.p0);
          for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
            const ox = x0 + sx * 8 + ((r + sy) % 2 ? 1 : 0);
            const oy = y0 + sy * 8;
            R(ctx, ox, oy, 7, 7, P.p1);
            R(ctx, ox, oy, 7, 1, P.p2); R(ctx, ox, oy, 1, 6, P.p2);
          }
        } else if (t === '~' || t === '=') {
          R(ctx, x0, y0, T, T, P.w1);
          for (let i = 0; i < 3; i++) {
            const rx = x0 + Math.floor(hash(col, r, 10 + i) * 12);
            const ry = y0 + 3 + Math.floor(hash(col, r, 20 + i) * 11);
            R(ctx, rx, ry, 3, 1, P.w2);
          }
          const water = (cc, rr) => g(cc, rr) === '~' || g(cc, rr) === '=';
          if (!water(col, r - 1)) { R(ctx, x0, y0, T, 2, P.w0); R(ctx, x0, y0 + 2, T, 1, P.w2); }
          if (!water(col - 1, r)) R(ctx, x0, y0, 2, T, P.w0);
          if (!water(col + 1, r)) R(ctx, x0 + T - 1, y0, 1, T, P.w0);
          if (t === '=') { // planks across, rails on both sides
            for (let x = 0; x < T; x += 3) { R(ctx, x0 + x, y0 + 3, 2, 10, P.d2); R(ctx, x0 + x + 2, y0 + 3, 1, 10, P.d1); }
            R(ctx, x0, y0 + 2, T, 1, P.d0); R(ctx, x0, y0 + 13, T, 1, P.d0);
            R(ctx, x0, y0 + 1, T, 1, P.d1);
            if (col % 2 === 0) { R(ctx, x0, y0, 2, 3, P.d0); R(ctx, x0, y0 + 12, 2, 4, P.d0); }
          }
        }
      }
    }
    // island edges: an ink line round it, a light rim along the top
    for (let r = 0; r < map.rows; r++) {
      for (let col = 0; col < map.cols; col++) {
        if (g(col, r) === '#') continue;
        const x0 = col * T;
        const y0 = r * T;
        if (g(col, r - 1) === '#') { R(ctx, x0, y0 - 1, T, 1, P.ink); R(ctx, x0, y0, T, 1, P.g4); }
        if (g(col - 1, r) === '#') R(ctx, x0 - 1, y0 - 1, 1, T + 1, P.ink);
        if (g(col + 1, r) === '#') R(ctx, x0 + T, y0 - 1, 1, T + 1, P.ink);
      }
    }
    // the cliff face under the bottom row (the pond's part is left for the waterfall)
    const top = (map.rows - 1) * T;
    for (let col = 0; col < map.cols; col++) {
      if (g(col, map.rows - 2) === '#') continue;
      const x0 = col * T;
      for (let x = 0; x < T; x++) {
        const X = x0 + x;
        const deep = 18 + Math.floor(hash(X, 0, 30) * 6) - (col === 2 || col === 17 ? 4 : 0);
        R(ctx, X, top, 1, 2, P.g1);
        R(ctx, X, top + 2, 1, 5, P.s1);
        R(ctx, X, top + 7, 1, 6, P.c2);
        R(ctx, X, top + 13, 1, Math.max(0, deep - 13), P.c1);
        R(ctx, X, top + deep, 1, 1, P.c0);
        if (hash(X, 1, 31) < 0.2) R(ctx, X, top + 8 + Math.floor(hash(X, 2, 32) * 8), 1, 1, P.c3);
        if (hash(X, 3, 33) < 0.15) R(ctx, X, top + 3, 1, 2, P.s0);
      }
    }
    // stones round the pond, lily pads
    for (const [x, y] of [[206, 126], [272, 134], [270, 160], [208, 174]]) { R(ctx, x, y, 4, 3, P.c2); R(ctx, x, y, 3, 1, P.c3); R(ctx, x, y + 3, 4, 1, P.c1); }
    for (const [x, y] of [[226, 135], [252, 166], [238, 168]]) { R(ctx, x, y, 5, 3, P.g1); R(ctx, x + 1, y, 3, 1, P.g3); R(ctx, x + 2, y + 1, 1, 1, P.w1); }
    // small bushes and wild flowers
    for (const [x, y] of [[100, 24], [118, 150], [274, 76], [40, 84], [150, 160]]) {
      const b = maskArt(12, 8, (px, py) => (px - 6) * (px - 6) / 36 + (py - 5) * (py - 5) / 12 <= 1, (px, py) => (py < 3 ? P.g3 : py < 6 ? P.g2 : P.g1));
      ctx.drawImage(b, x, y);
    }
    for (let i = 0; i < 26; i++) {
      const x = 34 + Math.floor(hash(i, 0, 40) * 250);
      const y = 18 + Math.floor(hash(i, 1, 41) * 150);
      const [cc, rr] = [Math.floor(x / T), Math.floor(y / T)];
      if (g(cc, rr) !== '.' || map.blocked.has(`${cc},${rr}`)) continue;
      R(ctx, x, y, 1, 1, [P.fl0, P.fl1, P.fl2, P.fl3][i % 4]);
    }
    return c;
  }

  // ---- props ---------------------------------------------------------------------------------------------
  function house() {
    const c = canvas(64, 60);
    const ctx = c.getContext('2d');
    // walls
    R(ctx, 4, 30, 56, 28, P.ink);
    R(ctx, 5, 31, 54, 27, P.m1);
    R(ctx, 5, 54, 54, 4, P.m0);
    R(ctx, 56, 31, 3, 27, P.m0);
    for (let y = 36; y < 54; y += 6) R(ctx, 5, y, 51, 1, P.m2);
    // roof (a trapezoid of tile rows)
    for (let y = 2; y <= 31; y++) {
      const k = (y - 2) / 29;
      const l = Math.round(14 - k * 14);
      const r = Math.round(50 + k * 14);
      R(ctx, l, y, r - l, 1, y < 5 ? P.r3 : (y - 2) % 5 === 4 ? P.r0 : y < 12 ? P.r2 : P.r1);
      R(ctx, l - 1, y, 1, 1, P.ink); R(ctx, r, y, 1, 1, P.ink);
      if ((y - 2) % 5 !== 4) for (let x = l + ((y >> 2) % 2) * 3; x < r; x += 6) R(ctx, x, y, 1, 1, P.r0);
    }
    R(ctx, 13, 1, 38, 1, P.ink);
    R(ctx, 0, 31, 64, 2, P.r0);
    R(ctx, 0, 33, 64, 1, P.ink);
    // chimney
    R(ctx, 44, 0, 7, 10, P.ink); R(ctx, 45, 1, 5, 9, P.c2); R(ctx, 45, 1, 5, 1, P.c3);
    // door and step
    R(ctx, 25, 41, 14, 17, P.ink); R(ctx, 26, 42, 12, 16, P.d1); R(ctx, 26, 42, 12, 1, P.d2); R(ctx, 31, 42, 1, 16, P.d0);
    R(ctx, 35, 50, 2, 2, P.p2);
    R(ctx, 23, 57, 18, 3, P.c2); R(ctx, 23, 57, 18, 1, P.c3);
    // window frames (the glass is drawn by scene.js: dark by day, lit at night)
    for (const x of [8, 46]) { R(ctx, x, 38, 12, 11, P.ink); R(ctx, x + 1, 39, 10, 9, P.d0); }
    // flower boxes under the windows
    for (const x of [8, 46]) { R(ctx, x, 49, 12, 3, P.d1); R(ctx, x + 1, 48, 2, 1, P.fl0); R(ctx, x + 5, 48, 2, 1, P.fl1); R(ctx, x + 9, 48, 2, 1, P.fl0); }
    return c;
  }
  // window glass rects inside the house art (x, y, w, h)
  const HOUSE_GLASS = [[9, 39, 10, 9], [47, 39, 10, 9]];

  function tree(seed) {
    const w = 32;
    const h = 44;
    const blobs = [[16, 13, 12], [8, 19, 8], [24, 19, 8], [16, 22, 9]];
    const inC = (x, y) => blobs.some(([cx, cy, r]) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r);
    const crown = maskArt(w, 32, inC, (x, y) => {
      const lx = (x - 11) * (x - 11) + (y - 8) * (y - 8);
      const n = hash(x, y, seed) * 30;
      if (lx + n < 50) return P.g4;
      if (lx + n < 130) return P.g3;
      if (y > 23 || lx + n > 380) return P.g0;
      return y > 18 ? P.g1 : P.g2;
    });
    const c = canvas(w, h);
    const ctx = c.getContext('2d');
    R(ctx, 13, 26, 7, 16, P.ink); R(ctx, 14, 27, 5, 15, P.d1); R(ctx, 14, 27, 1, 15, P.d0); R(ctx, 17, 30, 1, 6, P.d2);
    R(ctx, 11, 41, 11, 2, P.d0);
    ctx.drawImage(crown, 0, 0);
    return c;
  }

  function bench() {
    const c = canvas(32, 20);
    const ctx = c.getContext('2d');
    for (const x of [3, 27]) R(ctx, x, 1, 2, 18, P.d0);
    R(ctx, 1, 2, 30, 3, P.ink); R(ctx, 2, 2, 28, 2, P.d3);
    R(ctx, 1, 6, 30, 2, P.ink); R(ctx, 2, 6, 28, 1, P.d2);
    R(ctx, 0, 10, 32, 4, P.ink); R(ctx, 1, 10, 30, 2, P.d3); R(ctx, 1, 12, 30, 1, P.d1);
    for (const x of [4, 26]) R(ctx, x, 14, 2, 6, P.d0);
    return c;
  }

  function bed() {
    const c = canvas(48, 22);
    const ctx = c.getContext('2d');
    R(ctx, 0, 4, 48, 18, P.ink);
    R(ctx, 1, 5, 46, 16, P.c2);
    R(ctx, 1, 5, 46, 1, P.c3);
    R(ctx, 3, 7, 42, 12, P.s0);
    for (let y = 8; y < 19; y += 3) R(ctx, 4, y, 40, 1, P.s1);
    return c;
  }
  // the flowers on the bed: watered (bright, swaying in 2 frames) or wilted (brown, drooping)
  function drawFlowers(ctx, x0, y0, watered, frame) {
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 2; j++) {
        const x = x0 + 6 + i * 6 + (j ? 3 : 0);
        const y = y0 + 9 + j * 5;
        if (watered) {
          const sway = (frame + i + j) % 2;
          R(ctx, x, y - 3, 1, 4, P.g1);
          R(ctx, x - 1 + sway, y - 6, 3, 3, [P.fl0, P.fl1, P.fl2, P.fl3][(i + j) % 4]);
          R(ctx, x + sway, y - 5, 1, 1, P.fl1);
          R(ctx, x + 1, y - 1, 2, 1, P.g3);
        } else {
          R(ctx, x, y - 2, 1, 3, P.s1);
          R(ctx, x + 1, y - 2, 2, 1, P.wilt);
        }
      }
    }
  }

  function lamp() {
    const c = canvas(16, 40);
    const ctx = c.getContext('2d');
    R(ctx, 4, 36, 8, 4, P.ink); R(ctx, 5, 36, 6, 3, P.c1);
    R(ctx, 7, 9, 2, 28, P.metal); R(ctx, 7, 9, 1, 28, '#4a4f5a');
    R(ctx, 3, 1, 10, 9, P.ink); R(ctx, 2, 0, 12, 2, P.metal);
    R(ctx, 6, 10, 4, 1, P.metal);
    return c;
  }
  const LAMP_GLASS = [4, 2, 8, 7];

  function cloud(seed) {
    const n = 3 + Math.floor(hash(seed, 0, 49) * 2);
    const w = 18 + n * 10;
    const h = 18;
    const base = h - 3;
    const blobs = [];
    for (let i = 0; i < n; i++) {
      const r = i === 0 || i === n - 1 ? 5 + hash(seed, i, 53) * 2 : 7 + hash(seed, i, 53) * 3;
      blobs.push([7 + i * ((w - 14) / (n - 1)), base - r * 0.55, r]);
    }
    const inC = (x, y) => y <= base && (blobs.some(([cx, cy, r]) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) || (y >= base - 4 && x >= blobs[0][0] && x <= blobs[n - 1][0]));
    return maskArt(w, h, inC, (x, y) => {
      const top = !inC(x, y - 2);
      if (y >= base - 1) return '#b8c0cc';
      if (top) return '#ffffff';
      return y > base - 5 ? '#d3d9e2' : '#eef1f5';
    }, null);
  }

  function buildArt(map) {
    const trees = {};
    for (const p of map.props) if (p.kind === 'tree') trees[p.id] = tree(p.id.length * 7 + p.box[0]);
    return { ground: buildGround(map), house: house(), trees, bench: bench(), bed: bed(), lamp: lamp(), clouds: [0, 1, 2, 3].map(cloud) };
  }

  root.SceneArt = { P, BAYER, hash, canvas, R, maskArt, buildArt, drawFlowers, HOUSE_GLASS, LAMP_GLASS };
})(typeof self !== 'undefined' ? self : this);
