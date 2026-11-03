'use strict';
// 取景 for pixel sprite packs (半身模式, docs/half-body-mode.md "像素实现", docs/pixel-half-body-plan.md §3): the same
// setting re-frames a sprites look; her head-to-soles reference from a few frames; the half-body crop (waist on the
// canvas' bottom edge, 8% air above her head, the frame's aspect, whole-number blocks for hard pixel art); the
// crop clipped to its cell; the glide; touch zones on the half-body picture; every built-in sprites pack's
// pack.json halfBody.waist validated and carried into the look.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FR = require('../src/core/framing');
const P = require('../src/core/packs');
const TZ = require('../src/core/touch-zones');

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const HD = { w: 664, h: 904 };
const CLASSIC = { w: 83, h: 113 };
// claude-pixel daily, as measured (docs/pixel-half-body-plan.md §4): head top 184, soles 903, centre 332
const REF_HD = { top: 184, bottom: 903, cx: 332 };
// dafeiyu-classic daily: head top 17, soles 112
const REF_CLASSIC = { top: 17, bottom: 112, cx: 41.5 };

test('resolveFraming: a sprites look follows 取景 — her own choice > the pack default > the global setting', () => {
  const px = { kind: 'sprites', packId: 'claude-pixel' };
  const S = (framing, framings = {}) => ({ prefs: { framing }, framings });
  assert.ok(FR.SUPPORTED_KINDS.includes('sprites'));
  assert.deepEqual(FR.SUPPORTED_KINDS, ['vrm', 'live2d', 'sprites']);
  assert.deepEqual(FR.resolveFraming(S('half'), 'claude', px), { mode: 'half', wanted: 'half', source: 'global', supported: true });
  assert.deepEqual(FR.resolveFraming(S('full'), 'claude', px), { mode: 'full', wanted: 'full', source: 'global', supported: true });
  // the pack's default beats the global setting
  assert.deepEqual(FR.resolveFraming(S('full'), 'claude', { ...px, framing: 'half' }), { mode: 'half', wanted: 'half', source: 'pack', supported: true });
  assert.deepEqual(FR.resolveFraming(S('half'), 'claude', { ...px, framing: 'full' }), { mode: 'full', wanted: 'full', source: 'pack', supported: true });
  // her own choice beats both
  assert.deepEqual(FR.resolveFraming(S('half', { claude: 'full' }), 'claude', { ...px, framing: 'half' }), { mode: 'full', wanted: 'full', source: 'character', supported: true });
  assert.deepEqual(FR.resolveFraming(S('full', { claude: 'half' }), 'claude', { ...px, framing: 'full' }), { mode: 'half', wanted: 'half', source: 'character', supported: true });
  // someone else's choice is not hers
  assert.equal(FR.resolveFraming(S('full', { gpt: 'half' }), 'claude', px).mode, 'full');
  // the other kinds: VRM / Live2D unchanged, pictures / rig stay full
  assert.equal(FR.resolveFraming(S('half'), 'claude', { kind: 'vrm' }).mode, 'half');
  assert.equal(FR.resolveFraming(S('half'), 'claude', { kind: 'live2d' }).mode, 'half');
  assert.deepEqual(FR.resolveFraming(S('half'), 'claude', { kind: 'pictures' }), { mode: 'full', wanted: 'half', source: 'global', supported: false });
  assert.deepEqual(FR.resolveFraming(S('half'), 'claude', { kind: 'rig' }), { mode: 'full', wanted: 'half', source: 'global', supported: false });
});

test('spriteRef: the medians of the sampled frames; one oddly drawn frame does not move it; unreadable → the whole frame', () => {
  const stand = { top: 184, bottom: 904, minX: 202, maxX: 466 };
  const ref = FR.spriteRef([stand, { ...stand, top: 186 }, { ...stand, top: 100 }, { ...stand, top: 185, minX: 196, maxX: 462 }, stand], HD);
  assert.equal(ref.top, 184);
  assert.equal(ref.bottom, 904);
  assert.equal(ref.cx, 334);
  assert.equal(ref.measured, true);
  assert.deepEqual(FR.spriteRef([], HD), { top: 0, bottom: 904, cx: 332, measured: false });
  assert.deepEqual(FR.spriteRef(null, CLASSIC), { top: 0, bottom: 113, cx: 41.5, measured: false });
  assert.deepEqual(FR.spriteRef([{ top: NaN, bottom: 1, minX: 0, maxX: 1 }], HD).measured, false);
});

test('spriteCanvas: 全身 = the frame; 半身 of hard pixel art = a whole multiple about 452 tall; HD keeps its size', () => {
  assert.deepEqual(FR.spriteCanvas(HD, { mode: 'full' }), { W: 664, H: 904 });
  assert.deepEqual(FR.spriteCanvas(HD, { mode: 'half', pixelated: false }), { W: 664, H: 904 });
  assert.deepEqual(FR.spriteCanvas(CLASSIC, { mode: 'full', pixelated: true }), { W: 83, H: 113 });
  assert.deepEqual(FR.spriteCanvas(CLASSIC, { mode: 'half', pixelated: true }), { W: 332, H: 452 });
  assert.deepEqual(FR.spriteFull(HD), { sx: 0, sy: 0, sw: 664, sh: 904 });
});

test('spriteHalfCrop (HD): the waist lands on the canvas bottom edge, 8% air above her head, frame aspect, centred, bigger than 全身', () => {
  const canvas = FR.spriteCanvas(HD, { mode: 'half' });
  const c = FR.spriteHalfCrop(REF_HD, { frame: HD, waist: 0.52, canvas });
  const H = REF_HD.bottom - REF_HD.top;
  const cutY = REF_HD.top + 0.52 * H;
  assert.ok(near(c.sy + c.sh, cutY), 'the crop ends at the waist (= the canvas bottom edge)');
  assert.ok(near((REF_HD.top - c.sy) / c.sh, FR.SPRITE.margin), '8% of the crop above her head');
  assert.equal(FR.SPRITE.margin, 0.08);
  assert.ok(near(c.sw / c.sh, HD.w / HD.h), 'same aspect as the frame: the layout does not change');
  assert.ok(near(c.sx + c.sw / 2, REF_HD.cx), 'her centre in the middle');
  assert.ok(c.sh <= HD.h && c.scale >= 1, 'never smaller than 全身');
  assert.ok(near(c.scale, 904 / c.sh));
  assert.ok(c.scale > 2.1 && c.scale < 2.4, `HD packs ~2.2x (${c.scale})`);
  assert.equal(c.source, 'pack');
  assert.equal(c.waist, 0.52);
  assert.equal(c.cut, 0.52);
  // the plan's numbers for claude-pixel: crop ≈ (_, 151.5, 298.5, 406.4)
  assert.ok(Math.abs(c.sy - 151.5) < 0.5 && Math.abs(c.sw - 298.5) < 0.5 && Math.abs(c.sh - 406.4) < 0.5, JSON.stringify(c));
});

test('spriteHalfCrop: no (or an invalid) pack waist → L2D.dflt (0.55), source "default"; waist range 0.2–0.9 as for VRM / Live2D', () => {
  for (const w of [null, undefined, 0.1, 0.95, '0.5', NaN]) {
    const c = FR.spriteHalfCrop(REF_HD, { frame: HD, waist: w });
    assert.equal(c.source, 'default', String(w));
    assert.equal(c.waist, FR.L2D.dflt);
    assert.equal(c.cut, 0.55);
  }
  assert.equal(FR.spriteHalfCrop(REF_HD, { frame: HD, waist: 0.2 }).source, 'pack');
  assert.equal(FR.spriteHalfCrop(REF_HD, { frame: HD, waist: 0.9 }).source, 'pack');
  // a lower waist shows more of her (a bigger crop), a higher one less
  const lo = FR.spriteHalfCrop(REF_HD, { frame: HD, waist: 0.7 });
  const hi = FR.spriteHalfCrop(REF_HD, { frame: HD, waist: 0.4 });
  assert.ok(lo.sh > hi.sh);
  // a very low waist (nearly full) is capped at the whole frame height: never smaller than 全身
  const all = FR.spriteHalfCrop({ top: 0, bottom: 904, cx: 332 }, { frame: HD, waist: 0.9 });
  assert.ok(all.sh <= HD.h + 1e-9);
});

test('spriteHalfCrop (hard pixel art): whole-number blocks — each source pixel is s×s canvas pixels, crop on whole pixels', () => {
  const canvas = FR.spriteCanvas(CLASSIC, { mode: 'half', pixelated: true });
  const c = FR.spriteHalfCrop(REF_CLASSIC, { frame: CLASSIC, waist: 0.72, canvas, pixelated: true });
  assert.ok(Number.isInteger(c.scale), `whole scale (${c.scale})`);
  assert.ok(c.scale === 6 || c.scale === 7, String(c.scale));
  assert.ok(near(canvas.H / c.sh, c.scale) && near(canvas.W / c.sw, c.scale), 'the same whole scale both ways');
  assert.ok(Number.isInteger(c.sx) && Number.isInteger(c.sy));
  // the waist stays at the bottom edge within a source pixel; the head is still inside the crop
  const cutY = REF_CLASSIC.top + 0.72 * (REF_CLASSIC.bottom - REF_CLASSIC.top);
  assert.ok(Math.abs(c.sy + c.sh - cutY) <= 1, `${c.sy + c.sh} vs ${cutY}`);
  assert.ok(c.sy <= REF_CLASSIC.top);
  // the plan's numbers for dafeiyu-classic: (13.2, 10.1, 55.3, 75.3), 6×6 blocks on 332×452
  assert.equal(c.scale, 6);
  assert.ok(Math.abs(c.sw - 55.3) < 0.1 && Math.abs(c.sh - 75.3) < 0.1, JSON.stringify(c));
  // every built-in classic waist gives whole blocks
  for (const w of [0.6, 0.72, 0.66, 0.62]) assert.ok(Number.isInteger(FR.spriteHalfCrop(REF_CLASSIC, { frame: CLASSIC, waist: w, canvas, pixelated: true }).scale));
});

test('spriteDrawRects: the crop is clipped to its own cell (never the neighbouring frames); the full crop draws the whole frame', () => {
  const W = 664;
  const H = 904;
  const full = FR.spriteDrawRects(FR.spriteFull(HD), HD, { W, H });
  assert.deepEqual(full, { src: { x: 0, y: 0, w: 664, h: 904 }, dst: { x: 0, y: 0, w: 664, h: 904 } });
  // a crop sticking out above and left of the cell: the source stays in the cell, the canvas part shifts down / right
  const crop = { sx: -20, sy: -40, sw: 300, sh: 300 * 904 / 664 };
  const r = FR.spriteDrawRects(crop, HD, { W, H });
  assert.equal(r.src.x, 0);
  assert.equal(r.src.y, 0);
  assert.ok(near(r.src.w, 280) && near(r.src.h, crop.sh - 40));
  const k = W / crop.sw;
  assert.ok(near(r.dst.x, 20 * k) && near(r.dst.y, 40 * (H / crop.sh)));
  assert.ok(near(r.dst.x + r.dst.w, W) && near(r.dst.y + r.dst.h, H));
  // sticking out right / below
  const r2 = FR.spriteDrawRects({ sx: 500, sy: 800, sw: 300, sh: 300 * 904 / 664 }, HD, { W, H });
  assert.ok(r2.src.x + r2.src.w <= 664 && r2.src.y + r2.src.h <= 904);
  // the real half-body crop sits inside the frame
  const half = FR.spriteHalfCrop(REF_HD, { frame: HD, waist: 0.52 });
  const r3 = FR.spriteDrawRects(half, HD, { W, H });
  assert.ok(r3.src.x >= 0 && r3.src.y >= 0 && r3.src.x + r3.src.w <= 664 && r3.src.y + r3.src.h <= 904);
  assert.ok(near(r3.dst.y + r3.dst.h, H), 'the waist row is drawn on the canvas bottom edge');
  // nothing of the frame in the crop
  assert.equal(FR.spriteDrawRects({ sx: 700, sy: 0, sw: 100, sh: 100 }, HD, { W, H }), null);
});

test('blendRect: the switch glides — eased, monotonic, ends exactly on the target', () => {
  const a = FR.spriteFull(HD);
  const b = FR.spriteHalfCrop(REF_HD, { frame: HD, waist: 0.52 });
  const t = (x) => FR.blendRect(a, b, x);
  assert.deepEqual(t(0), a);
  assert.deepEqual(t(-1), a);
  const end = t(1);
  for (const k of ['sx', 'sy', 'sw', 'sh']) assert.ok(near(end[k], b[k]), k);
  const shs = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((x) => t(x).sh);
  assert.ok(shs.every((v, i) => i === 0 || v <= shs[i - 1]), shs.join(' '));
  const step = (t0, t1) => t(t0).sh - t(t1).sh;
  assert.ok(step(0, 0.05) < step(0.45, 0.5), 'eased in');
  assert.ok(step(0.95, 1) < step(0.45, 0.5), 'eased out');
  // aspect kept all the way (no stretch while gliding)
  for (const x of [0.2, 0.5, 0.8]) assert.ok(near(t(x).sw / t(x).sh, 664 / 904, 1e-9));
});

test('touch zones on a sprites half-body picture: data-cut = waist → head and face where they are, legs and feet out of reach', () => {
  for (const waist of [0.5, 0.52, 0.6, 0.72]) {
    const c = FR.spriteHalfCrop(REF_HD, { frame: HD, waist });
    const half = { mode: 'half', cut: Number(c.cut.toFixed(3)) }; // what artPoint reads back from data-cut
    const zone = (x, y) => TZ.zoneAt(x, FR.toFullBody({ x, y }, half).y);
    assert.equal(zone(0.5, 0.03), 'head', String(waist));
    const seen = new Set();
    for (let y = 0; y <= 1.0001; y += 0.01) for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) { const z = zone(x, Math.min(1, y)); if (z) seen.add(z); }
    // feet never; legs never for the HD packs' waists (0.50–0.52). The default zone table is measured on the HD
    // packs (legs from 0.6 of her height): a chibi waist of 0.66–0.72 reaches its top band, as a 全身 click there does
    assert.ok(!seen.has('feet'), `${waist}: ${[...seen]}`);
    if (waist <= 0.6) assert.ok(!seen.has('legs'), `${waist}: ${[...seen]}`);
    assert.ok(seen.has('face') && seen.has('chest'), `${waist}: ${[...seen]}`);
    // the bottom edge of the picture (y = 1) is her waist: y·cut of her full height
    assert.ok(near(FR.toFullBody({ y: 1 }, half).y, half.cut));
  }
  // 全身: unchanged (cut 1 / no framing)
  assert.deepEqual(FR.toFullBody({ x: 0.5, y: 0.8 }, { mode: 'full', cut: 1 }), { x: 0.5, y: 0.8 });
});

// docs/pixel-half-body-plan.md §4: measured per pack (cut under her folded hands)
const WAISTS = {
  'claude-pixel': 0.52, 'dafeiyu-pixel': 0.52, 'gemini-pixel': 0.5, 'gpt-pixel': 0.5, 'grok-pixel': 0.52,
  'claude-adult': 0.5, 'dafeiyu-adult': 0.52, 'gemini-adult': 0.5, 'gpt-adult': 0.5, 'grok-adult': 0.5,
  'claude-classic': 0.6, 'dafeiyu-classic': 0.72, 'gemini-classic': 0.66, 'gpt-classic': 0.6, 'grok-classic': 0.62,
};
test('built-in sprites packs: pack.json halfBody.waist validated and carried into the look of every outfit', () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'packs');
  const { packs } = P.loadPacks([{ dir, source: 'builtin' }]);
  const sprites = [...packs.values()].filter((p) => p.kind === 'sprites');
  assert.equal(sprites.length, 15);
  for (const p of sprites) {
    assert.ok(WAISTS[p.id], p.id);
    assert.deepEqual(p.halfBody, { waist: WAISTS[p.id] }, p.id);
    assert.ok(FR.isWaist(p.halfBody.waist));
    for (const outfitId of Object.keys(p.outfits)) {
      const look = P.resolveLook(packs, { packId: p.id, speciesId: p.species, outfitId });
      if (!look || look.locked) continue;
      assert.equal(look.kind, 'sprites');
      assert.deepEqual(look.halfBody, { waist: WAISTS[p.id] }, `${p.id}/${outfitId}`);
    }
  }
});

test('spriteLift: a frame drawn floating takes the half-body crop up with her; ordinary frames and lifted frames stay put', () => {
  // dafeiyu-pixel daily: the reference soles 904, idle#1 drawn 94 px higher (soles 810)
  const ref = { top: 194, bottom: 904, cx: 330 };
  assert.equal(FR.SPRITE.liftMin, 0.02);
  assert.equal(FR.SPRITE.liftMax, 0.2);
  assert.equal(FR.spriteLift(ref, 810, HD), 94);
  // the 1–2 px between ordinary frames (and lifted frames, soles on the floor): no move, no jitter
  for (const b of [904, 903, 902, 895]) assert.equal(FR.spriteLift(ref, b, HD), 0);
  // a frame below the reference never pulls the crop down
  assert.equal(FR.spriteLift({ ...ref, bottom: 850 }, 904, HD), 0);
  // at most liftMax of the frame (a frame drawn half empty is not followed off the canvas)
  assert.equal(FR.spriteLift(ref, 300, HD), 0.2 * 904);
  // pixel art: whole source px
  assert.equal(FR.spriteLift({ top: 17, bottom: 112, cx: 41.5 }, 104.6, CLASSIC, { pixelated: true }), 7);
  // nothing measured: no move
  assert.equal(FR.spriteLift(ref, NaN, HD), 0);
  assert.equal(FR.spriteLift(null, 800, HD), 0);
  // with the lift the crop keeps her head below its top edge: the floating idle#1's head (100) vs the crop top
  const c = FR.spriteHalfCrop(ref, { frame: HD, waist: 0.52 });
  assert.ok(c.sy > 100, 'without the lift the crop starts below her floating head');
  assert.ok(c.sy - FR.spriteLift(ref, 810, HD) < 100, 'with it, above');
});
