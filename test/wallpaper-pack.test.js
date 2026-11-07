'use strict';
// 桌面壁纸 · 壁纸包 (core/wallpaper-pack.js, docs/wallpaper-mode.md §3): the manifest's fields and bounds, picture
// sizes read from headers, hostile packs refused at install; game-pack / game-store / game-index know the new engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WP = require('../src/core/wallpaper-pack');
const GP = require('../src/core/game-pack');
const GS = require('../src/core/game-store');
const GI = require('../src/core/game-index');
const { zip } = require('../scripts/build-character-catalog');

const SRC = path.join(__dirname, 'fixtures', 'games', 'mini-wallpaper');
const manifest = () => JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const files = () => fs.readdirSync(SRC);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pp-wp-'));
const DIMS = { 'preview.webp': { width: 480, height: 270 }, 'sky-day.webp': { width: 640, height: 360 }, 'sky-night.webp': { width: 640, height: 360 }, 'cloud.png': { width: 640, height: 360 }, 'ground.png': { width: 640, height: 360 } };
const check = (m, extra = {}) => GP.validateManifest(m, { files: files(), dims: DIMS, ...extra });
const has = (errs, re) => assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);

// minimal picture headers
const png = (w, h) => { const b = Buffer.alloc(33); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0); b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const webpX = (w, h) => { const b = Buffer.alloc(34); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1'); b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3); return b; };
const webpL = (w, h) => { const b = Buffer.alloc(30); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8L', 12, 'latin1'); b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21); return b; };

test('the fixture wallpaper (test/fixtures/games/mini-wallpaper) is valid: on disk, with its real picture headers', () => {
  assert.deepEqual(check(manifest()), []);
  assert.equal(GS.checkFolder(SRC, 'mini-wallpaper'), null);
  assert.deepEqual(WP.namedFiles(manifest()).sort(), ['cloud.png', 'ground.png', 'preview.webp', 'sky-day.webp', 'sky-night.webp']);
  assert.deepEqual(GP.namedFiles(manifest()).sort(), WP.namedFiles(manifest()).sort());
  assert.deepEqual(GP.spriteFiles(manifest()), []);
});

test('imageSize reads PNG IHDR and the three WebP chunk kinds without decoding; anything else is null', () => {
  assert.deepEqual(WP.imageSize(png(7680, 4320)), { type: 'png', width: 7680, height: 4320 });
  assert.deepEqual(WP.imageSize(webpX(3840, 2160)), { type: 'webp', width: 3840, height: 2160 });
  assert.deepEqual(WP.imageSize(webpL(1000, 500)), { type: 'webp', width: 1000, height: 500 });
  assert.deepEqual(WP.imageSize(fs.readFileSync(path.join(SRC, 'sky-day.webp'))), { type: 'webp', width: 640, height: 360 }); // VP8 (lossy)
  assert.equal(WP.imageSize(Buffer.from('<script>alert(1)</script> not a picture')), null);
  assert.equal(WP.imageSize(Buffer.alloc(4)), null);
});

test('game-pack: wallpaper@1 is an engine this app plays, kind "wallpaper" (a game engine still needs kind "game")', () => {
  assert.ok(GP.ENGINES.includes('wallpaper@1'));
  assert.equal(GP.kindOf('wallpaper@1'), 'wallpaper');
  assert.equal(GP.kindOf('yard@1'), 'game');
  has(check({ ...manifest(), kind: 'game' }), /kind must be "wallpaper"/);
  // a yard@1 manifest calling itself a wallpaper is not let through either
  const yard = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'games', 'mini-yard', 'manifest.json'), 'utf8'));
  has(GP.validateManifest({ ...yard, kind: 'wallpaper' }), /kind must be "game"/);
});

test('every field is bounded (docs §3.2)', () => {
  const m = manifest;
  has(check({ ...m(), canvas: { ...m().canvas, width: 100 } }), /canvas.width/);
  has(check({ ...m(), canvas: { ...m().canvas, height: 5000 } }), /canvas.height/);
  has(check({ ...m(), canvas: { ...m().canvas, width: 1280.5 } }), /canvas.width/);
  has(check({ ...m(), canvas: { ...m().canvas, background: 'red' } }), /background/);
  has(check({ ...m(), canvas: { ...m().canvas, fit: 'stretch' } }), /canvas.fit/);
  has(check({ ...m(), canvas: { ...m().canvas, focus: [1.2, 0] } }), /canvas.focus/);
  has(check({ ...m(), layers: [] }), /layers must be a list of 1–16/);
  has(check({ ...m(), layers: Array.from({ length: 17 }, (_, i) => ({ id: `l${i}`, image: 'ground.png', z: 0 })) }), /layers must be a list of 1–16/);
  has(check({ ...m(), layers: [{ id: 'a', image: 'ground.png', z: 0 }, { id: 'a', image: 'cloud.png', z: 1 }] }), /id "a" twice/);
  has(check({ ...m(), layers: [{ id: 'a', image: 'ground.png', z: 101 }] }), /z must be an integer/);
  has(check({ ...m(), layers: [{ id: 'a', image: 'ground.png', z: 0, drift: [300, 0] }] }), /drift/);
  has(check({ ...m(), layers: [{ id: 'a', image: 'ground.png', z: 0, opacity: 2 }] }), /opacity/);
  has(check({ ...m(), layers: [{ id: 'a', image: 'ground.png', z: 0, blend: 'difference' }] }), /blend/);
  has(check({ ...m(), layers: [{ id: 'a', image: 'ground.png', z: 0, phases: ['noon'] }] }), /phases/);
  has(check({ ...m(), sky: { weather: ['hail'] } }), /sky.weather/);
  has(check({ ...m(), fx: { fireflies: 41 } }), /fireflies/);
  has(check({ ...m(), fx: { lights: [{ x: 99999, y: 0, r: 10 }] } }), /fx.lights\[0\]/);
  has(check({ ...m(), pet: { ...m().pet, height: 900 } }), /pet.height/);
  has(check({ ...m(), pet: { ...m().pet, speed: 0 } }), /pet.speed/);
  has(check({ ...m(), pet: { ...m().pet, spawn: [10, 10] } }), /spawn is outside/);
  has(check({ ...m(), pet: { ...m().pet, area: [[0, 0], [99999, 0], [0, 10]] } }), /pet.area/);
  has(check({ ...m(), pet: { ...m().pet, spots: [{ id: 'x', at: [640, 600], anim: 'dance', seconds: [1, 2] }] } }), /anim "dance"/);
  has(check({ ...m(), pet: { ...m().pet, spots: [{ id: 'x', at: [640, 600], anim: 'sit', seconds: [5, 700] }] } }), /seconds/);
  has(check({ ...m(), pet: { ...m().pet, spots: [{ id: 'x', at: [5, 5], anim: 'sit', seconds: [1, 2] }] } }), /inside pet.area/);
  has(check({ ...m(), power: { fps: 60 } }), /power.fps/);
  has(check({ ...m(), name: 'x'.repeat(41) }), /name is longer/);
});

test('hostile packs: code-ish fields, other file types, oversized / fake pictures are refused', () => {
  for (const k of ['entry', 'main', 'html', 'script', 'shader', 'url', 'video']) has(check({ ...manifest(), [k]: 'x' }), new RegExp(`"${k}" is not allowed`));
  has(check({ ...manifest(), preview: 'evil.js' }), /not allowed \(.webp/);
  has(check({ ...manifest(), layers: [{ id: 'a', image: 'clip.mp4', z: 0 }] }), /not allowed/);
  has(check({ ...manifest(), layers: [{ id: 'a', image: 'data.json', z: 0 }] }), /not allowed \(.webp/);
  has(check({ ...manifest(), layers: [{ id: 'a', image: 'gone.png', z: 0 }] }), /gone.png is missing/);
  // sizes from the headers: one picture too big, the total too big, the preview too big, a "picture" that is not one
  has(check(manifest(), { dims: { ...DIMS, 'ground.png': { width: 8000, height: 4500 } } }), /larger than 7680×4320/);
  const many = Array.from({ length: 4 }, (_, i) => ({ id: `l${i}`, image: ['sky-day.webp', 'sky-night.webp', 'cloud.png', 'ground.png'][i], z: i }));
  const big = Object.fromEntries(Object.keys(DIMS).map((f) => [f, { width: 7680, height: 4320 }]));
  has(check({ ...manifest(), layers: many }, { dims: { ...big, 'preview.webp': DIMS['preview.webp'] } }), /MP in all, more than 64 MP/);
  has(check(manifest(), { dims: { ...DIMS, 'preview.webp': { width: 3840, height: 2160 } } }), /preview: 3840×2160 is larger/);
  has(check(manifest(), { dims: { ...DIMS, 'cloud.png': null } }), /not a PNG \/ WebP/);
});

test('game-store: installing a wallpaper zip; stray files, sub-folders and a giant header are refused with nothing left behind', async () => {
  const root = tmp();
  const z = path.join(tmp(), 'w.zip');
  zip(SRC, z);
  const r = await GS.installArchive(root, { id: 'mini-wallpaper', version: '1.0.0', sha256: 'x'.repeat(64), bytes: 1 }, z);
  assert.equal(r.ok, true, JSON.stringify(r));
  const listed = GS.listInstalled([{ dir: root, source: 'download' }]);
  assert.deepEqual(listed.map((g) => [g.id, g.engine, g.kind, g.version]), [['mini-wallpaper', 'wallpaper@1', 'wallpaper', '1.0.0']]);

  const bad = async (mutate) => {
    const stage = tmp();
    for (const f of files()) fs.copyFileSync(path.join(SRC, f), path.join(stage, f));
    mutate(stage);
    const zz = path.join(tmp(), 'bad.zip');
    zip(stage, zz);
    const root2 = tmp();
    const out = await GS.installArchive(root2, { id: 'mini-wallpaper', version: '1.0.0', sha256: 'x'.repeat(64), bytes: 1 }, zz);
    assert.deepEqual(fs.readdirSync(root2), [], 'nothing left behind');
    return out;
  };
  assert.equal((await bad((d) => fs.writeFileSync(path.join(d, 'run.js'), 'require("child_process")'))).reason, 'stray-file');
  assert.equal((await bad((d) => { fs.mkdirSync(path.join(d, 'sub')); fs.writeFileSync(path.join(d, 'sub', 'a.png'), png(4, 4)); })).reason, 'stray-file');
  const giant = await bad((d) => fs.writeFileSync(path.join(d, 'ground.png'), png(20000, 20000)));
  assert.equal(giant.reason, 'bad-manifest');
  assert.ok(giant.errors.some((e) => /larger than 7680×4320/.test(e)), giant.errors.join('; '));
  const fake = await bad((d) => fs.writeFileSync(path.join(d, 'cloud.png'), '<html><script>x</script></html>'));
  assert.ok(fake.errors.some((e) => /not a PNG/.test(e)), fake.errors.join('; '));
});

test('game-index: supported() — this app plays wallpaper@1; an old app (no such engine) or minAppVersion 0.29.0 on 0.28.0 cannot; store rows say kind', () => {
  const entry = { id: 'rainy-window', type: 'game', name: '雨夜窗边', version: '1.0.0', engine: 'wallpaper@1', minAppVersion: '0.29.0', file: 'rainy-window-1.0.0.zip', bytes: 1000, sha256: 'a'.repeat(64) };
  const g = GI.cleanEntry(entry, 'games-v1');
  assert.equal(g.engine, 'wallpaper@1');
  assert.deepEqual(GI.supported(g, { appVersion: '0.29.0' }), { ok: true });
  assert.deepEqual(GI.supported(g, { appVersion: '0.28.0' }), { ok: false, reason: 'app' });
  // what a 0.28.0 build sees: its ENGINES has no wallpaper@1 → 需要更新应用, not downloadable
  assert.deepEqual(GI.supported(g, { appVersion: '0.28.0', engines: ['yard@1', 'room@1', 'illustrated-room@1'] }), { ok: false, reason: 'engine' });
  const rows = GI.storeRows({ games: [g, GI.cleanEntry({ ...entry, id: 'pixel-yard', engine: 'yard@1', minAppVersion: null }, 'games-v1')] }, new Map(), [], { appVersion: '0.29.0' });
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.state]), [['rainy-window', 'wallpaper', 'remote'], ['pixel-yard', 'game', 'remote']]);
  assert.equal(GI.storeRows({ games: [g] }, new Map(), [], { appVersion: '0.28.0' })[0].state, 'unsupported');
  // a wallpaper archive is at most 120 MB (a game 200 MB)
  assert.equal(GI.cleanEntry({ ...entry, bytes: 121 * 1024 * 1024 }, 'games-v1'), null);
  assert.ok(GI.cleanEntry({ ...entry, engine: 'yard@1', bytes: 121 * 1024 * 1024 }, 'games-v1'));
});

test('cleanWallpaper: what the engine gets — known fields only, defaults filled, layers by z', () => {
  const c = WP.cleanWallpaper({ ...manifest(), extra: 'dropped', layers: [{ id: 'b', image: 'ground.png', z: 10 }, { id: 'a', image: 'sky-day.webp', z: -1, blend: 'add' }] });
  assert.equal(c.extra, undefined);
  assert.deepEqual(c.layers.map((l) => [l.id, l.z, l.blend, l.opacity]), [['a', -1, 'add', 1], ['b', 10, 'normal', 1]]);
  assert.equal(c.power.fps, 24);
  assert.equal(c.canvas.fit, 'cover');
});
