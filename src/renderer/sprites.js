'use strict';
// Procedural pixel-art sprites. Everything is drawn from the tiny shape
// definitions below, so the project ships no third-party art and has no
// licensing to track. Works in the browser (window.Sprites) and in Node (tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sprites = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const N = 24; // sprite grid is N x N
  const OUTLINE = '#2b2233';

  const PALETTES = {
    embit: { b: '#f2733a', l: '#ffa56b', d: '#c9502a', a: '#ffd23f', f: '#e8442e', w: '#ffe9c4' },
    bubbo: { b: '#4a90e2', l: '#7db8f5', d: '#2f69b8', a: '#ffd23f', f: '#bfe3f2', w: '#e8f6ff' },
    sprig: { b: '#6cc16a', l: '#9be08f', d: '#43964a', a: '#3fa34d', f: '#2f7d3e', w: '#eaf7d0' },
  };
  const COMMON = { o: OUTLINE, k: '#1d1626', e: '#ffffff', c: '#ff9eb5', r: '#e0455f', s: '#7fd3ff', h: '#ff5c7a', z: '#8a7fb0', y: '#ffd23f', m: '#f5e6c8', n: '#c98f4f' };

  // Every companion is an adult: there is a single body size (no younger forms exist).
  const STAGE_DIM = {
    adult: { rx: 8, ry: 8, cy: 14 },
  };
  const SPECIES_DIM = { embit: { rx: 0, ry: 0 }, bubbo: { rx: 0.5, ry: 0.5 }, sprig: { rx: 0.5, ry: 0 } };

  const ORN = {
    embit: {
      tuft: ['...o...', '..ofo..', '.ofaao.', '.ofaao.', '..oaao.'],
      tail: ['.oo', 'oao', 'oao', '.o.'],
    },
    bubbo: {
      finL: ['..oo', '.obo', 'obbo', '.oo.'],
      finR: ['oo..', 'obo.', 'obbo', '.oo.'],
      spout: ['.o.', 'owo', 'owo', '.o.'],
      star: ['.y.', 'yyy', '.y.'],
    },
    sprig: {
      sprout: ['...oo.oo...', '..oaaoaao..', '..oaaoaao..', '...ooooo...', '.....o.....'],
    },
  };

  function blank() {
    return Array.from({ length: N }, () => Array(N).fill('.'));
  }

  function stamp(g, pat, x0, y0) {
    pat.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        const x = x0 + i;
        const y = y0 + j;
        if (ch !== '.' && x >= 0 && y >= 0 && x < N && y < N) g[y][x] = ch;
      }
    });
  }

  function inEllipse(x, y, cx, cy, rx, ry) {
    const dx = (x + 0.5 - cx) / rx;
    const dy = (y + 0.5 - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }

  function dims(speciesId) {
    const s = STAGE_DIM.adult;
    const sp = SPECIES_DIM[speciesId] || { rx: 0, ry: 0 };
    return { cx: N / 2, cy: s.cy, rx: s.rx + sp.rx, ry: s.ry + sp.ry };
  }

  function shadedBlob(g, cx, cy, rx, ry, belly) {
    const mask = blank();
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inEllipse(x, y, cx, cy, rx, ry)) mask[y][x] = 'b';
    const solid = (x, y) => x >= 0 && y >= 0 && x < N && y < N && mask[y][x] !== '.';
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (!solid(x, y)) continue;
        const edge = !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1);
        if (edge) { g[y][x] = 'o'; continue; }
        const u = (x + 0.5 - cx) / rx;
        const v = (y + 0.5 - cy) / ry;
        let ch = 'b';
        if (u + v < -0.85) ch = 'l';
        else if (u * 0.5 + v > 0.62) ch = 'd';
        if (belly && v > 0.05 && Math.abs(u) < 0.55) ch = 'w';
        g[y][x] = ch;
      }
    }
  }

  // Body + ornaments, no face. Returns { grid, face }.
  function buildBody(speciesId) {
    const g = blank();
    const { cx, cy, rx, ry } = dims(speciesId);
    const top = Math.round(cy - ry);
    const adult = true;
    shadedBlob(g, cx, cy, rx, ry, speciesId === 'bubbo');

    if (speciesId === 'embit') {
      const t = ORN.embit.tuft;
      stamp(g, t, cx - 3, top - t.length + 2);
      if (adult) {
        stamp(g, t, cx - 7, top - t.length + 4);
        stamp(g, t, cx + 1, top - t.length + 4);
      }
      stamp(g, ORN.embit.tail, Math.round(cx + rx - 1), Math.round(cy + ry * 0.2));
    } else if (speciesId === 'bubbo') {
      stamp(g, ORN.bubbo.finL, Math.round(cx - rx - 2), Math.round(cy + 1));
      stamp(g, ORN.bubbo.finR, Math.round(cx + rx - 1), Math.round(cy + 1));
      stamp(g, ORN.bubbo.spout, cx - 1, top - ORN.bubbo.spout.length + 1);
      if (adult) stamp(g, ORN.bubbo.star, cx - 1, top + 1);
    } else if (speciesId === 'sprig') {
      const s = ORN.sprig.sprout;
      stamp(g, s, cx - 5, top - s.length + 2);
      if (adult) stamp(g, ['.oo.', 'oaao', '.oo.'], cx + 3, top - 3);
    }
    const eyeDx = Math.max(2, Math.round(rx * 0.45));
    return {
      grid: g,
      face: { lx: Math.round(cx - eyeDx) - 1, rx: Math.round(cx + eyeDx) - 1, ey: Math.round(cy - ry * 0.15), my: Math.round(cy + ry * 0.38), cx: Math.round(cx), big: true },
    };
  }

  function drawEyes(g, f, status, blink) {
    const tall = f.big ? 3 : 2;
    const open = (x) => {
      for (let j = 0; j < tall; j++) { g[f.ey + j][x] = 'k'; g[f.ey + j][x + 1] = 'k'; }
      g[f.ey][x] = 'e';
    };
    const line = (x) => { g[f.ey + 1][x] = 'k'; g[f.ey + 1][x + 1] = 'k'; };
    const happy = (x) => { g[f.ey][x] = 'k'; g[f.ey + 1][x - 1 < 0 ? x : x - 1] = 'k'; g[f.ey + 1][x + 1] = 'k'; };
    for (const x of [f.lx, f.rx]) {
      if (status === 'sleep' || blink) line(x);
      else if (status === 'happy') happy(x);
      else open(x);
    }
    if (status === 'sad' || status === 'hungry') {
      g[f.ey + tall][f.lx] = 's';
    }
    if (status !== 'sleep') {
      g[f.ey + tall + 1][f.lx - 1] = 'c';
      g[f.ey + tall + 1][f.rx + 2] = 'c';
    }
  }

  function drawMouth(g, f, status, talking) {
    const y = f.my;
    const x = f.cx - 1;
    if (talking) { g[y][x] = 'k'; g[y][x + 1] = 'k'; g[y + 1][x] = 'r'; g[y + 1][x + 1] = 'r'; return; }
    if (status === 'happy') { g[y][x - 1] = 'k'; g[y + 1][x] = 'k'; g[y + 1][x + 1] = 'k'; g[y][x + 2] = 'k'; return; }
    if (status === 'sad') { g[y + 1][x - 1] = 'k'; g[y][x] = 'k'; g[y][x + 1] = 'k'; g[y + 1][x + 2] = 'k'; return; }
    if (status === 'hungry') { g[y][x] = 'k'; g[y][x + 1] = 'k'; g[y + 1][x] = 'k'; g[y + 1][x + 1] = 'k'; return; }
    if (status === 'sleep') { g[y][x] = 'k'; g[y][x + 1] = 'k'; return; }
    g[y][x] = 'k'; g[y][x + 1] = 'k';
  }

  // Bounce / squash per status. t is seconds.
  function motion(status, t) {
    if (status === 'sleep') return { dy: Math.round(Math.sin(t * 1.2) * 0.6 + 0.6) > 0 ? 1 : 0, blink: true };
    if (status === 'happy') return { dy: -Math.abs(Math.round(Math.sin(t * 6) * 1.6)), blink: false };
    if (status === 'sad' || status === 'hungry') return { dy: Math.sin(t * 2) > 0.3 ? 1 : 0, blink: false };
    return { dy: Math.sin(t * 2.4) > 0.4 ? -1 : 0, blink: Math.floor(t * 2) % 7 === 0 && (t * 2) % 1 < 0.25 };
  }

  const EFFECTS = {
    heart: ['.hh.hh.', 'hhhhhhh', 'hhhhhhh', '.hhhhh.', '..hhh..', '...h...'],
    zzz: ['zzzz', '..z.', '.z..', 'zzzz'],
    sweat: ['.s.', 'sss', 'sss', '.s.'],
    steam: ['.m.', 'm.m', '.m.', 'm..'],
    rice: ['.mmmm.', 'mmmmmm', 'mmeemm', 'nnnnnn'],
    cookie: ['.nnnn.', 'nnynyn', 'nnnnnn', '.nnnn.'],
    fruit: ['..f.', '.hhh', 'hhhh', '.hh.'],
    spark: ['.y.', 'yyy', '.y.'],
  };

  // Compose one animation frame. Returns { grid, dy, effects:[{name,x,y}] }.
  function frame({ speciesId, status, t = 0, talking = false, eating = null }) {
    const { grid, face } = buildBody(speciesId);
    const m = motion(status, t);
    drawEyes(grid, face, status, m.blink);
    drawMouth(grid, face, status, talking && Math.floor(t * 8) % 2 === 0);
    const effects = [];
    if (status === 'sleep') effects.push({ name: 'zzz', x: 17, y: 2 + (Math.floor(t * 1.5) % 3) });
    if (status === 'happy') effects.push({ name: 'heart', x: 15, y: 1 + (Math.floor(t * 3) % 2) });
    if (status === 'hungry' && Math.floor(t * 2) % 2 === 0) effects.push({ name: 'sweat', x: 3, y: 6 });
    if (eating) effects.push({ name: eating, x: 9, y: 18 + (Math.floor(t * 4) % 2) });
    return { grid, dy: m.dy, effects };
  }

  const EGG_PAL = (sp) => ({ b: sp.shell, l: '#ffffff', d: shade(sp.shell, -28), a: sp.spot });
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const f = (v) => Math.max(0, Math.min(255, v + amt));
    return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => f(v).toString(16).padStart(2, '0')).join('');
  }

  // Egg with spots; cracks 0..3 (3 = about to hatch).
  function egg(cracks = 0) {
    const g = blank();
    shadedBlob(g, N / 2, 14.5, 6.5, 8.5, false);
    // spots
    [[10, 13], [14, 17], [12, 9], [15, 12]].forEach(([x, y]) => { if (g[y][x] !== 'o' && g[y][x] !== '.') { g[y][x] = 'a'; g[y][x + 1] = 'a'; } });
    const crack = [[12, 8], [13, 9], [12, 10], [13, 11], [12, 12], [11, 13]];
    crack.slice(0, cracks * 2).forEach(([x, y]) => { g[y][x] = 'o'; });
    return g;
  }

  function validate() {
    const problems = [];
    for (const sp of Object.keys(PALETTES)) {
      for (const status of ['idle', 'happy', 'sad', 'hungry', 'sleep']) {
        const f = frame({ speciesId: sp, status, t: 0 });
        if (f.grid.length !== N || f.grid.some((r) => r.length !== N)) problems.push(`${sp}/${status}: bad dimensions`);
        const unknown = new Set();
        f.grid.forEach((r) => r.forEach((c) => { if (c !== '.' && !PALETTES[sp][c] && !COMMON[c]) unknown.add(c); }));
        if (unknown.size) problems.push(`${sp}/${status}: unknown palette keys ${[...unknown].join('')}`);
      }
    }
    return problems;
  }

  function colorFor(speciesId, key) {
    return (PALETTES[speciesId] && PALETTES[speciesId][key]) || COMMON[key] || null;
  }

  // Draw a grid on a 2D canvas context.
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

  return { N, PALETTES, COMMON, STAGE_DIM, EFFECTS, EGG_PAL, frame, egg, validate, colorFor, drawGrid, buildBody };
});
