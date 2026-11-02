'use strict';
// 取景 for Live2D (半身模式, docs/half-body-mode.md "Live2D 实现"): the same setting re-frames a Live2D look; the
// half-body band from pack.json halfBody.waist / the Head hit area / the eye line / a default share; where the model
// goes in the canvas for 全身 (the old fit, unchanged) and 半身; the glide; touch zones on a Live2D half-body
// picture; pack.json halfBody (validated, carried into the look, also overriding the VRM hips cut).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FR = require('../src/core/framing');
const P = require('../src/core/packs');
const TZ = require('../src/core/touch-zones');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// 大肥鱼 · Live2D as measured in the app (model px of the .moc canvas, y down): her opaque drawables, her eyes
const CONTENT = { top: 106.5, bottom: 4705.8, minX: 697, maxX: 3110.6 };
const EYES = { top: 770.9, bottom: 1133, minX: 1379, maxX: 1959 };
const H = CONTENT.bottom - CONTENT.top;

test('resolveFraming: a Live2D look follows the same 取景 setting (global, her own, the pack default)', () => {
  const l2d = { kind: 'live2d', packId: 'dafeiyu-live2d' };
  const S = (framing, framings = {}) => ({ prefs: { framing }, framings });
  assert.ok(FR.SUPPORTED_KINDS.includes('live2d'));
  assert.deepEqual(FR.resolveFraming(S('half'), 'dafeiyu', l2d), { mode: 'half', wanted: 'half', source: 'global', supported: true });
  assert.deepEqual(FR.resolveFraming(S('full'), 'dafeiyu', l2d), { mode: 'full', wanted: 'full', source: 'global', supported: true });
  assert.deepEqual(FR.resolveFraming(S('half', { dafeiyu: 'full' }), 'dafeiyu', l2d), { mode: 'full', wanted: 'full', source: 'character', supported: true });
  assert.equal(FR.resolveFraming(S('full'), 'dafeiyu', { ...l2d, framing: 'half' }).source, 'pack');
  // the same settings give VRM and Live2D the same mode
  for (const s of [S('half'), S('full'), S('full', { dafeiyu: 'half' })]) {
    assert.equal(FR.resolveFraming(s, 'dafeiyu', l2d).mode, FR.resolveFraming(s, 'dafeiyu', { kind: 'vrm' }).mode);
  }
  // still full art for the rest
  assert.equal(FR.resolveFraming(S('half'), 'dafeiyu', { kind: 'rig' }).mode, 'full');
});

test('live2dHalfBand: pack.json halfBody.waist first, then the Head hit area, then the eye line, then a default', () => {
  // the pack says where her waist is
  const pack = FR.live2dHalfBand({ content: CONTENT, waist: 0.52, eyes: EYES });
  assert.equal(pack.source, 'pack');
  assert.ok(near(pack.bottom, CONTENT.top + H * 0.52, 1e-6));
  assert.equal(pack.top, CONTENT.top);
  assert.equal(pack.cut, 0.52);
  assert.equal(pack.cx, (EYES.minX + EYES.maxX) / 2, 'centred on her face, not on the tail-widened box');
  // no pack value: her eyes → her head → the waist (a chibi: big head, low waist)
  const eyes = FR.live2dHalfBand({ content: CONTENT, eyes: EYES });
  assert.equal(eyes.source, 'eyes');
  assert.ok(eyes.waist > 0.45 && eyes.waist < 0.6, `${eyes.waist}`);
  assert.ok(Math.abs(eyes.waist - 0.52) < 0.03, `the inference lands near the hand-set waist: ${eyes.waist}`);
  // a Head hit area wins over the eyes
  const head = { top: CONTENT.top, bottom: CONTENT.top + H * 0.15, minX: 1200, maxX: 2000 };
  const hit = FR.live2dHalfBand({ content: CONTENT, head, eyes: EYES });
  assert.equal(hit.source, 'hitarea');
  assert.ok(near(hit.waist, FR.waistFromHead(0.15)));
  assert.equal(hit.cx, 1600);
  // nothing known: the default share, centred on her box
  const dflt = FR.live2dHalfBand({ content: CONTENT });
  assert.equal(dflt.source, 'default');
  assert.equal(dflt.waist, FR.L2D.dflt);
  assert.equal(dflt.cx, (CONTENT.minX + CONTENT.maxX) / 2);
  // a waist out of range or not a number is ignored (falls through to what the model shows)
  for (const w of [0, 0.1, 0.95, '0.5', NaN, null]) assert.notEqual(FR.live2dHalfBand({ content: CONTENT, waist: w, eyes: EYES }).source, 'pack', String(w));
  // a hit area as tall as her (a whole-body "Head" by mistake) or eyes near her feet are not trusted for the waist
  assert.equal(FR.live2dHalfBand({ content: CONTENT, head: { ...head, bottom: CONTENT.bottom } }).source, 'default');
  assert.equal(FR.live2dHalfBand({ content: CONTENT, eyes: { ...EYES, top: CONTENT.top + H * 0.6, bottom: CONTENT.top + H * 0.62 } }).source, 'default');
});

test('waistFromHead: adult heads put the waist higher than chibi heads, within bounds', () => {
  const adult = FR.waistFromHead(1 / 7.5);
  const chibi = FR.waistFromHead(1 / 3);
  assert.ok(adult > 0.37 && adult < 0.43, `${adult}`);
  assert.ok(chibi > 0.54 && chibi < 0.6, `${chibi}`);
  assert.equal(FR.waistFromHead(0), FR.L2D.min);
  assert.equal(FR.waistFromHead(1), FR.L2D.max);
});

test('live2dPlacement: 全身 is the old fit exactly; 半身 puts the waist on the bottom edge, her head near the top, centred, bigger', () => {
  const W = 332;
  const Hc = 452;
  const model = { w: 3326, h: 4992 };
  const share = 0.8;
  // the old fit() in live2d.js: scale = canvas height × share / model height, centred, feet at 99.5 %
  const full = FR.live2dPlacement(null, { W, H: Hc, model, share, mode: 'full' });
  const s0 = (Hc * share) / model.h;
  assert.deepEqual(full, { s: s0, x: (W - model.w * s0) / 2, y: Hc * 0.995 - model.h * s0 });
  // a band is ignored in 全身
  const band = FR.live2dHalfBand({ content: CONTENT, waist: 0.52, eyes: EYES });
  assert.deepEqual(FR.live2dPlacement(band, { W, H: Hc, model, share, mode: 'full' }), full);
  const half = FR.live2dPlacement(band, { W, H: Hc, model, share, mode: 'half' });
  const y = (v) => half.y + v * half.s; // model px → canvas px
  assert.ok(near(y(band.bottom), Hc, 1e-6), 'the cut is the bottom edge');
  assert.ok(near(y(band.top), Hc * FR.HALF.margin, 1e-6), `air above her head: ${y(band.top)}`);
  assert.ok(near(half.x + band.cx * half.s, W / 2, 1e-6), 'her face centred');
  assert.ok(half.s > full.s * 1.5, `bigger: ${full.s} → ${half.s}`);
  // a band nearly as tall as she is never makes her smaller than 全身
  const tall = { top: 0, bottom: model.h, cx: model.w / 2 };
  assert.ok(FR.live2dPlacement(tall, { W, H: Hc, model, share, mode: 'half' }).s >= full.s);
});

test('blendPlacement: the switch glides from one placement to the other, eased, monotonic', () => {
  const a = { s: 0.07, x: 45, y: 88 };
  const b = { s: 0.15, x: -90, y: 6 };
  assert.deepEqual(FR.blendPlacement(a, b, 0), a);
  assert.deepEqual(FR.blendPlacement(a, b, 1), b);
  assert.deepEqual(FR.blendPlacement(a, b, 2), b);
  const ss = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1].map((t) => FR.blendPlacement(a, b, t).s);
  assert.ok(ss.every((v, i) => i === 0 || v >= ss[i - 1]), ss.join(' '));
});

test('touch zones on a Live2D half-body picture: head and face where they are, legs and feet out of reach', () => {
  const band = FR.live2dHalfBand({ content: CONTENT, waist: 0.52, eyes: EYES });
  const half = { mode: 'half', cut: band.cut };
  const zone = (x, y) => TZ.zoneAt(x, FR.toFullBody({ x, y }, half).y);
  assert.equal(zone(0.5, 0.05), 'head');
  const seen = new Set();
  for (let yy = 0; yy <= 1.0001; yy += 0.01) for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) { const z = zone(x, Math.min(1, yy)); if (z) seen.add(z); }
  assert.ok(!seen.has('legs') && !seen.has('feet'), [...seen].join(','));
  assert.ok(seen.has('face') && seen.has('chest'), [...seen].join(','));
});

test('pack.json halfBody: { waist } validated and carried into the look (Live2D and VRM); anything else refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-halfbody-pack-'));
  const src = path.join(__dirname, '..', 'src', 'renderer', 'packs', 'dafeiyu-live2d');
  const make = (id, over) => {
    const dir = path.join(root, id);
    fs.cpSync(src, dir, { recursive: true });
    const m = { ...JSON.parse(fs.readFileSync(path.join(src, 'pack.json'), 'utf8')), id };
    delete m.halfBody;
    return { m: { ...m, ...over }, dir };
  };
  const a = make('l2d-a', { halfBody: { waist: 0.5 } });
  const ok = P.validatePack(a.m, a.dir);
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.pack.halfBody, { waist: 0.5 });
  const look = P.resolveLook(new Map([[ok.pack.id, ok.pack]]), { packId: 'l2d-a', speciesId: 'dafeiyu', outfitId: 'daily' });
  assert.equal(look.kind, 'live2d');
  assert.deepEqual(look.halfBody, { waist: 0.5 });
  // without it: nothing in the look (the renderer infers)
  const b = make('l2d-b', {});
  assert.equal(P.validatePack(b.m, b.dir).pack.halfBody, undefined);
  for (const bad of [{ waist: 0.05 }, { waist: 1.2 }, { waist: '0.5' }, { cut: 0.5 }, { waist: 0.5, top: 0 }, 0.5, ['x'], null]) {
    const c = make(`l2d-bad`, { halfBody: bad });
    const r = P.validatePack(c.m, c.dir);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.errors.some((e) => /halfBody must be/.test(e)), r.errors.join('; '));
  }
});

test('the built-in 大肥鱼 · Live2D pack carries its half-body waist', () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'packs', 'dafeiyu-live2d');
  const r = P.validatePack(JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')), dir);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.pack.halfBody, { waist: 0.52 });
  assert.equal(r.pack.framing, undefined, 'no default framing: she follows the setting');
});

test('halfBodyBand (VRM): pack.json halfBody.waist overrides the hips cut; without it nothing changes', () => {
  const bones = { head: { x: 0, y: 1.4 }, neck: { x: 0, y: 1.35 }, chest: { x: 0, y: 1.2 }, hips: { x: 0, y: 0.9 } };
  const box = { minX: -0.3, maxX: 0.3, minY: 0, maxY: 1.6 };
  const plain = FR.halfBodyBand(bones, box);
  assert.deepEqual(FR.halfBodyBand(bones, box, { waist: null }), plain);
  assert.deepEqual(FR.halfBodyBand(bones, box, { waist: 3 }), plain, 'an invalid waist is ignored');
  const o = FR.halfBodyBand(bones, box, { waist: 0.5 });
  assert.equal(o.source, 'pack');
  assert.ok(near(o.bottom, 0.8, 1e-9));
  assert.equal(o.top, plain.top);
  assert.ok(o.cut > plain.cut, 'a lower cut shows more of her');
  // no bones: the box fallback with the pack's cut
  const nb = FR.halfBodyBand({}, box, { waist: 0.4 });
  assert.equal(nb.source, 'pack');
  assert.ok(near(nb.bottom, 1.6 - 0.64, 1e-9));
});
