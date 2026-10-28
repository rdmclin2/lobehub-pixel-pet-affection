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


  // ---- outfits -------------------------------------------------------------------------------
  // Every outfit is drawn twice from the data below (made for this project, MIT): as an overlay on the
  // pet's body, and as a full-body figure for the wardrobe. The figure is an adult: about 6.5 heads
  // tall (8-row head on a 50-row body), long legs, no childlike proportions. Nothing is revealing:
  // the adult-rated outfits differ in style only. Colours use keys A..E (per outfit).
  //
  // Figure template, left half (mirrored to 20 columns). Regions: H hair, S skin, k eye, m mouth,
  // 9 neck, 1 shoulders, 2 upper arm, 3 forearm, 4 torso, 5 hips, 6 thigh, 7 shin, 8 feet.
  const FIG_HALF = [
    '......HHHH', '.....HHHHH', '.....HHHSS', '.....HSkSS', '.....HSkSS', '.....HSSSS', '.....HSSSm', '.....H.SSS',
    '.....H..99', '.....11111', '...2111111', '..22444444', '..22444444', '..22444444', '..22444444', '..22.44444',
    '..33..4444', '..33..4444', '..33..4444', '..33.55555', '..33.55555', '..33.55555', '..33.55555', '..SS.55555',
    '..SS.6666.', '..SS.6666.',
    ...Array(10).fill('.....6666.'),
    ...Array(12).fill('......777.'),
    '.....8888.', '.....8888.',
  ];
  const FIG = { w: 22, h: 54, top: 3, left: 1 }; // padded grid: room for hats above and outlines around
  const FIG_COMMON = { o: OUTLINE, S: '#f6d5b8', k: '#2b2233', m: '#c9505a' };
  const HAIR = { embit: '#d9542f', bubbo: '#3a6fc4', sprig: '#3f8f45', dafeiyu: '#5a6bb8' };
  const REGIONS = { 9: 'neck', 1: 'shoulders', 2: 'upperArm', 3: 'forearm', 4: 'torso', 5: 'hips', 6: 'thigh', 7: 'shin', 8: 'feet' };

  // fig: region -> colour key ('S' = skin). ops (template coords, mirrored unless mirror:false):
  //   { r:[y0,y1], c:[x0,x1], k, add }  paint a rectangle; without `add` only cells that are already drawn
  //   { pattern:'dots'|'stripes', on, k, every }  repaint every n-th cell of colour `on`
  // blob: the pet overlay. body/trim keys, optional pattern and a hat stamped on top of the head.
  const BASE = { neck: 'S', shoulders: 'A', upperArm: 'A', forearm: 'A', torso: 'A', hips: 'B', thigh: 'B', shin: 'B', feet: 'C' };
  const OUTFIT_ART = {
    daily: {
      colors: { A: '#f4f1ea', B: '#4a6fa5', C: '#6b4a2f' },
      fig: { ...BASE },
      ops: [{ r: [19, 19], c: [5, 9], k: 'C' }],
      blob: { body: 'A', trim: 'B' },
    },
    scarf: {
      colors: { A: '#e8d8b8', B: '#5a5560', C: '#4a3a30', D: '#d8443c' },
      fig: { ...BASE },
      ops: [{ r: [8, 10], c: [6, 9], k: 'D', add: true }, { r: [11, 16], c: [7, 7], k: 'D', mirror: false }],
      blob: { body: 'A', trim: 'D' },
    },
    casual: {
      colors: { A: '#9aa3ad', B: '#3f4652', C: '#f2f2f2', D: '#7d8691' },
      fig: { ...BASE },
      ops: [{ r: [8, 8], c: [6, 7], k: 'A', add: true }, { r: [16, 18], c: [7, 9], k: 'D' }, { r: [11, 13], c: [8, 8], k: 'C' }],
      blob: { body: 'A', trim: 'D' },
    },
    beret: {
      colors: { A: '#f4f1ea', B: '#2f4f8f', C: '#8a5a3a', D: '#c0392b', E: '#2b2233' },
      fig: { ...BASE, hips: 'C', thigh: 'C', shin: 'C', feet: 'E' },
      ops: [{ pattern: 'stripes', on: 'A', k: 'B', every: 2 }, { r: [11, 18], c: [6, 6], k: 'C' }, { r: [-1, -1], c: [5, 9], k: 'D', add: true }, { r: [0, 0], c: [4, 9], k: 'D', add: true }],
      blob: { body: 'A', trim: 'C', pattern: 'stripes', alt: 'B', hat: ['..D...', '.DDDD.', 'DDDDDD'] },
    },
    pajamas: {
      colors: { A: '#bcd8f5', B: '#ffffff', C: '#f5b8c8' },
      fig: { ...BASE, hips: 'A', thigh: 'A', shin: 'A' },
      ops: [{ pattern: 'dots', on: 'A', k: 'B', every: 4 }, { r: [-1, 0], c: [5, 9], k: 'A', add: true }, { r: [-2, -2], c: [3, 3], k: 'B', add: true, mirror: false }, { r: [-1, -1], c: [4, 4], k: 'A', add: true, mirror: false }],
      blob: { body: 'A', trim: 'A', pattern: 'dots', alt: 'B', hat: ['B.....', '.AA...', '.AAAA.', 'AAAAAA'] },
    },
    cat_ears: {
      colors: { A: '#f7b6c8', B: '#f7b6c8', C: '#ffffff', D: '#ffffff' },
      fig: { ...BASE },
      ops: [{ r: [-2, -2], c: [5, 5], k: 'H', add: true }, { r: [-1, -1], c: [5, 6], k: 'H', add: true }, { r: [-1, -1], c: [6, 6], k: 'A', add: true }, { r: [0, 0], c: [5, 9], k: 'D' }],
      blob: { body: 'A', trim: 'D', hat: ['o......o', 'oo....oo', 'oAo..oAo'] },
    },
    yukata: {
      colors: { A: '#2e3f73', B: '#ffffff', C: '#d8443c', D: '#c69c6d' },
      fig: { ...BASE, hips: 'A', thigh: 'A', shin: 'A', feet: 'D' },
      ops: [{ pattern: 'dots', on: 'A', k: 'B', every: 7 }, { r: [16, 18], c: [5, 9], k: 'C', add: true }, { r: [9, 12], c: [9, 9], k: 'B' }, { r: [24, 47], c: [9, 9], k: 'A', add: true }],
      blob: { body: 'A', trim: 'C', pattern: 'dots', alt: 'B' },
    },
    maid: {
      colors: { A: '#2b2b3a', B: '#ffffff', C: '#3a3346', D: '#1d1626' },
      fig: { ...BASE, hips: 'A', thigh: 'A', shin: 'C', feet: 'D' },
      ops: [
        { r: [24, 35], c: [4, 9], k: 'A', add: true }, // knee-length skirt, no gap between the legs
        { r: [14, 33], c: [7, 9], k: 'B' }, // apron
        { r: [9, 10], c: [8, 9], k: 'B' }, // collar
        { r: [22, 22], c: [2, 3], k: 'B' }, // cuffs
        { r: [0, 0], c: [5, 9], k: 'B' }, // headband
      ],
      blob: { body: 'A', trim: 'B', pattern: 'apron', alt: 'B', hat: ['B.B.B.B', 'BBBBBBB'] },
    },
    offshoulder_gown: {
      colors: { A: '#8e1f3c', B: '#e5c46b' },
      fig: { neck: 'S', shoulders: 'S', upperArm: 'S', forearm: 'S', torso: 'A', hips: 'A', thigh: 'A', shin: 'A', feet: 'B' },
      ops: [{ r: [11, 11], c: [2, 3], k: 'A' }, { r: [24, 47], c: [9, 9], k: 'A', add: true }, { r: [30, 47], c: [4, 4], k: 'A', add: true }, { r: [36, 47], c: [5, 5], k: 'A', add: true }, { r: [16, 16], c: [6, 9], k: 'B' }],
      blob: { body: 'A', trim: 'B' },
    },
    couple_hoodie: {
      colors: { A: '#f28cab', B: '#4a6fa5', C: '#ffffff', D: '#e0455f' },
      fig: { ...BASE },
      ops: [{ r: [8, 8], c: [6, 7], k: 'A', add: true }, { r: [12, 12], c: [8, 8], k: 'D' }, { r: [13, 13], c: [8, 9], k: 'D' }, { r: [14, 14], c: [9, 9], k: 'D' }],
      blob: { body: 'A', trim: 'A', pattern: 'heart', alt: 'D' },
    },
    flower_crown: {
      colors: { A: '#fbf7f0', B: '#ff9eb5', C: '#6cc16a', D: '#e5c46b' },
      fig: { ...BASE, forearm: 'S', hips: 'A', thigh: 'A', shin: 'A', feet: 'D' },
      ops: [{ r: [24, 47], c: [9, 9], k: 'A', add: true }, { r: [30, 47], c: [4, 4], k: 'A', add: true }, { r: [-1, 0], c: [5, 9], k: 'C', add: true }, { pattern: 'dots', on: 'C', k: 'B', every: 2 }],
      blob: { body: 'A', trim: 'B', hat: ['B.C.B.C.B', 'CBCBCBCBC'] },
    },
    retro_swimsuit: {
      colors: { A: '#24365e', B: '#ffffff', C: '#e8c99a', D: '#c69c6d' },
      fig: { neck: 'S', shoulders: 'S', upperArm: 'S', forearm: 'S', torso: 'A', hips: 'A', thigh: 'S', shin: 'S', feet: 'D' },
      ops: [{ r: [9, 10], c: [8, 8], k: 'A' }, { r: [24, 26], c: [5, 9], k: 'A', add: true }, { r: [14, 14], c: [5, 9], k: 'B' }, { r: [-1, -1], c: [5, 9], k: 'C', add: true }, { r: [0, 0], c: [3, 9], k: 'C', add: true }],
      blob: { body: 'A', trim: 'B', pattern: 'stripes', alt: 'B', hat: ['..CCCC..', 'CCCCCCCC'] },
    },
    silk_robe: {
      colors: { A: '#e9d6b0', B: '#c9a86a', C: '#f5e6c8' },
      fig: { ...BASE, hips: 'A', thigh: 'A', shin: 'S', feet: 'C' },
      ops: [{ r: [24, 34], c: [9, 9], k: 'A', add: true }, { r: [11, 15], c: [9, 9], k: 'B' }, { r: [16, 17], c: [5, 9], k: 'B' }, { r: [18, 21], c: [8, 8], k: 'B', mirror: false }],
      blob: { body: 'A', trim: 'B' },
    },
  };

  // Full-body adult figure in an outfit. Returns a FIG.w x FIG.h grid of keys (see figureColor).
  function figure(outfitId) {
    const art = OUTFIT_ART[outfitId] || OUTFIT_ART.daily;
    const g = Array.from({ length: FIG.h }, () => Array(FIG.w).fill('.'));
    const put = (r, c, ch) => {
      const y = r + FIG.top;
      const x = c + FIG.left;
      if (y >= 0 && y < FIG.h && x >= 0 && x < FIG.w) g[y][x] = ch;
    };
    const at = (r, c) => g[r + FIG.top] && g[r + FIG.top][c + FIG.left];
    FIG_HALF.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        let ch = row[c];
        if (ch === '.') continue;
        if (REGIONS[ch]) ch = art.fig[REGIONS[ch]] || 'S';
        put(r, c, ch);
        put(r, 19 - c, ch);
      }
    });
    for (const op of art.ops || []) {
      if (op.pattern) {
        for (let y = 0; y < FIG.h; y++) for (let x = 0; x < FIG.w; x++) {
          if (g[y][x] !== op.on) continue;
          const hit = op.pattern === 'stripes' ? y % op.every === 0 : (x + y * 3) % op.every === 0;
          if (hit) g[y][x] = op.k;
        }
        continue;
      }
      for (let r = op.r[0]; r <= op.r[1]; r++) for (let c = op.c[0]; c <= op.c[1]; c++) {
        for (const cc of op.mirror === false ? [c] : [c, 19 - c]) {
          const cur = at(r, cc);
          if (cur === undefined) continue;
          if (op.add || (cur !== '.' && cur !== 'k' && cur !== 'm')) put(r, cc, op.k);
        }
      }
    }
    // outline every empty cell that touches the figure
    const solid = (x, y) => x >= 0 && y >= 0 && x < FIG.w && y < FIG.h && g[y][x] !== '.' && g[y][x] !== 'o';
    for (let y = 0; y < FIG.h; y++) for (let x = 0; x < FIG.w; x++) {
      if (g[y][x] === '.' && (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1))) g[y][x] = 'o';
    }
    return g;
  }

  function figureColor(outfitId, speciesId, key) {
    const art = OUTFIT_ART[outfitId] || OUTFIT_ART.daily;
    if (key === 'H') return HAIR[speciesId] || HAIR.bubbo;
    return FIG_COMMON[key] || art.colors[key] || null;
  }

  // Head and body rows of the figure template, for the adult-proportion check.
  const FIG_PROPORTIONS = { headRows: FIG_HALF.findIndex((r) => r.includes('9')), bodyRows: FIG_HALF.length };

  // Overlay an outfit on the pet's blob body (below the mouth) and put its hat on the head.
  function dressBlob(g, speciesId, face, outfitId) {
    const art = OUTFIT_ART[outfitId];
    if (!art || !art.blob) return;
    const b = art.blob;
    const { cx, cy, ry } = dims(speciesId);
    const from = face.my + 1; // the row under the mouth; mouth pixels themselves are never covered
    for (let y = from; y < N; y++) for (let x = 0; x < N; x++) {
      const ch = g[y][x];
      if (ch === '.' || ch === 'o' || ch === 'k' || ch === 'r') continue;
      let k = y === from ? b.trim : b.body;
      if (y > from && b.pattern === 'stripes' && (y - from) % 2 === 0) k = b.alt;
      if (y > from && b.pattern === 'dots' && (x + y * 2) % 3 === 0) k = b.alt;
      if (y > from && b.pattern === 'apron' && Math.abs(x + 0.5 - cx) < 2.5) k = b.alt;
      if (b.pattern === 'heart' && y === from + 1 && Math.abs(x + 0.5 - cx) < 2) k = b.alt;
      if (b.pattern === 'heart' && y === from + 2 && Math.abs(x + 0.5 - cx) < 1) k = b.alt;
      g[y][x] = k;
    }
    if (b.hat) {
      const w = b.hat[0].length;
      stamp(g, b.hat, Math.round(cx - w / 2), Math.round(cy - ry) - b.hat.length + 1);
    }
  }

  // Compose one animation frame. Returns { grid, dy, effects:[{name,x,y}] }.
  // `outfit` dresses the body (colour keys A..E resolve through colorFor(speciesId, key, outfit)).
  function frame({ speciesId, status, t = 0, talking = false, eating = null, outfit = null }) {
    const { grid, face } = buildBody(speciesId);
    const m = motion(status, t);
    drawEyes(grid, face, status, m.blink);
    drawMouth(grid, face, status, talking && Math.floor(t * 8) % 2 === 0);
    if (outfit) dressBlob(grid, speciesId, face, outfit);
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

  // Every species x status x outfit frame, and every outfit figure, uses only known colours.
  function validate() {
    const problems = [];
    for (const sp of Object.keys(PALETTES)) {
      for (const outfit of [null, ...Object.keys(OUTFIT_ART)]) {
        for (const status of ['idle', 'happy', 'sad', 'hungry', 'sleep']) {
          const id = `${sp}/${outfit || '-'}/${status}`;
          const f = frame({ speciesId: sp, status, t: 0, outfit });
          if (f.grid.length !== N || f.grid.some((r) => r.length !== N)) problems.push(`${id}: bad dimensions`);
          const unknown = new Set();
          f.grid.forEach((r) => r.forEach((c) => { if (c !== '.' && !colorFor(sp, c, outfit)) unknown.add(c); }));
          if (unknown.size) problems.push(`${id}: unknown palette keys ${[...unknown].join('')}`);
        }
      }
    }
    for (const outfit of Object.keys(OUTFIT_ART)) {
      const g = figure(outfit);
      const unknown = new Set();
      g.forEach((r) => r.forEach((c) => { if (c !== '.' && !figureColor(outfit, 'bubbo', c)) unknown.add(c); }));
      if (unknown.size) problems.push(`figure ${outfit}: unknown keys ${[...unknown].join('')}`);
    }
    return problems;
  }

  function colorFor(speciesId, key, outfit = null) {
    const own = (PALETTES[speciesId] && PALETTES[speciesId][key]) || COMMON[key];
    if (own) return own;
    const art = outfit && OUTFIT_ART[outfit];
    return (art && art.colors[key]) || null;
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

  return { N, PALETTES, COMMON, STAGE_DIM, EFFECTS, EGG_PAL, OUTFIT_ART, FIG, FIG_PROPORTIONS, frame, egg, figure, figureColor, validate, colorFor, drawGrid, buildBody };
});
