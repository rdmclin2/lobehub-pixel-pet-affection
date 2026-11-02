'use strict';
// The VRM motion library (src/core/vrm-library.json + vrm-library.js, docs/vrm-motion-system.md §3.7, §6):
// the bake list is metadata only with safe relative sources, each style has ≥ 4 postures and ≥ 3 idles, the
// runtime index is cleaned before use, resolution falls back, and the motion folder is never in the repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('../src/core/vrm-library');
const VL = require('../src/main/vrm-library');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'core', 'vrm-library.json'), 'utf8'));

test('the bake list is valid: kinds, ids, relative sources under postures/ mixamo/ motions/, no ..', () => {
  assert.deepEqual(L.validateManifest(manifest), []);
  for (const e of Object.values(manifest.clips)) if (e.src) assert.ok(!path.isAbsolute(e.src) && !e.src.includes('..'), e.src);
  // and the checks catch bad entries
  const bad = { schema: 1, clips: { 'stand.x@female': { kind: 'posture', style: 'female', src: '../secret.fbx' }, 'idle.y@male': { kind: 'idle', style: 'female', cycle: ['nope', 'nada'], every: 3 }, nope: {} } };
  const errs = L.validateManifest(bad).join('\n');
  for (const w of ['src must be a relative path', 'style "female" does not match', 'cycle posture nope@male', 'every', 'bad clip id "nope"']) assert.ok(errs.includes(w), w);
});

test('each style has ≥ 4 postures (the six of this release) and ≥ 3 idles', () => {
  for (const style of ['female', 'male']) {
    const of = (kind) => Object.entries(manifest.clips).filter(([id, e]) => e.kind === kind && id.endsWith(`@${style}`)).map(([id]) => id.split('@')[0]);
    const postures = of('posture');
    const idles = of('idle');
    assert.ok(postures.length >= 4, `${style} postures ${postures}`);
    for (const p of L.POSTURES) assert.ok(postures.includes(p), `${style} ${p}`);
    assert.ok(idles.length >= 3, `${style} idles ${idles}`);
  }
  // female and male use different source files for every posture
  for (const p of L.POSTURES) assert.notEqual(manifest.clips[`${p}@female`].src, manifest.clips[`${p}@male`].src, p);
});

test('with the assets on this machine ($PIXELPET_VRM_ASSETS), every source exists (skipped without)', (t) => {
  const dir = process.env.PIXELPET_VRM_ASSETS;
  if (!dir) return t.skip('PIXELPET_VRM_ASSETS not set');
  for (const e of Object.values(manifest.clips)) if (e.src) assert.ok(fs.existsSync(path.join(dir, e.src)), e.src);
});

test('the runtime index is cleaned: only <style>/<slot>.vrma files and cycles; resolve falls back', () => {
  const idx = L.cleanIndex({ clips: {
    'stand.relaxed@female': { kind: 'posture', file: 'female/stand.relaxed.vrma', duration: 1 },
    'stand.relaxed@male': { kind: 'posture', file: '../../etc/passwd' },
    'stand.shy@male': { kind: 'posture', file: 'male/stand.shy.vrma' },
    'idle.posture-cycle@female': { kind: 'idle', cycle: ['stand.relaxed', 'stand.shy'], every: 99 },
    'evil@female': { kind: 'posture', file: 'female/x.vrma' },
  } });
  assert.deepEqual(Object.keys(idx.clips).sort(), ['idle.posture-cycle@female', 'stand.relaxed@female', 'stand.shy@male']);
  assert.equal(idx.clips['idle.posture-cycle@female'].every, 30, 'clamped');
  assert.equal(L.resolve(idx, 'stand.relaxed', 'male').id, 'stand.relaxed@female', 'male without its own: another set rather than nothing');
  assert.equal(L.resolve(idx, 'stand.shy', 'female').id, 'stand.shy@male');
  assert.equal(L.resolve(idx, 'stand.relaxed', 'neutral').id, 'stand.relaxed@female');
  assert.equal(L.resolve(idx, 'sit.rest', 'female'), null);
  assert.equal(L.resolve(idx, 'stand.relaxed', 'female', null, (c) => c.id !== 'stand.relaxed@female'), null, 'not loaded → not used');
  assert.equal(L.resolve(L.cleanIndex(null), 'stand.relaxed', 'female'), null);
  assert.equal(L.status(idx, new Set(['stand.relaxed@female'])), 'partial:1');
  assert.equal(L.status(L.cleanIndex({}), new Set()), 'none');
});

test('vrmlib://: the motion folder (env, userData, dev ~/vrm-assets/baked) — never inside the repository; URLs stay inside it', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmlib-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vrmlib-home-'));
  assert.deepEqual(VL.libraryDir({ env: { PIXELPET_VRM_MOTIONS_DIR: tmp }, userData: '/u', home }), { dir: tmp, source: 'env' });
  const inRepo = VL.libraryDir({ env: { PIXELPET_VRM_MOTIONS_DIR: path.join(ROOT, 'baked') }, userData: '/u', home });
  assert.equal(inRepo.dir, null);
  assert.ok(inRepo.refused);
  // nothing anywhere: userData's folder (empty) — the dev folder only for a development run, not a test or the package
  fs.mkdirSync(path.join(home, 'vrm-assets', 'baked'), { recursive: true });
  fs.writeFileSync(path.join(home, 'vrm-assets', 'baked', 'library.json'), '{}');
  assert.equal(VL.libraryDir({ env: {}, userData: tmp, home }).source, 'dev');
  assert.equal(VL.libraryDir({ env: { PIXELPET_TEST: '1' }, userData: tmp, home }).dir, path.join(tmp, 'vrm-motions'));
  assert.equal(VL.libraryDir({ env: {}, userData: tmp, home, packaged: true }).dir, path.join(tmp, 'vrm-motions'));
  fs.mkdirSync(path.join(tmp, 'vrm-motions'));
  fs.writeFileSync(path.join(tmp, 'vrm-motions', 'library.json'), '{}');
  assert.equal(VL.libraryDir({ env: {}, userData: tmp, home }).source, 'userData', 'userData wins over dev');
  const d = path.join(tmp, 'vrm-motions');
  assert.equal(VL.resolveUrl(d, 'vrmlib://index/library.json'), path.join(d, 'library.json'));
  assert.equal(VL.resolveUrl(d, 'vrmlib://female/stand.relaxed.vrma'), path.join(d, 'female', 'stand.relaxed.vrma'));
  // the URL parser folds ../ away; whatever is left still lands inside the folder
  for (const u of ['vrmlib://female/../../../etc/passwd.vrma', 'vrmlib://female/%2e%2e/%2e%2e/x.vrma']) { const f = VL.resolveUrl(d, u); assert.ok(f === null || f.startsWith(d + path.sep), `${u} → ${f}`); }
  for (const bad of ['vrmlib://female/..%2f..%2f..%2fx.vrma', 'vrmlib://female/%2e%2e%2f%2e%2e%2fx.vrma', 'vrmlib://index/other.json', 'vrmlib://female/x.fbx', 'vrmlib://etc/x.vrma', 'pack://female/x.vrma']) assert.equal(VL.resolveUrl(d, bad), null, bad);
});

test('motions and models stay out of git and the package: ignored, excluded from build.files, none tracked', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const ext of ['*.fbx', '*.FBX', '*.vmd', '*.VMD', '*.bvh', '*.pmx', '*.vroid', '*.vrm', '*.vrma']) assert.ok(gi.split('\n').includes(ext), `.gitignore ${ext}`);
  const files = require('../package.json').build.files;
  for (const ext of ['fbx', 'vmd', 'bvh', 'pmx', 'vrm', 'vrma']) assert.ok(files.includes(`!**/*.${ext}`), `build.files !**/*.${ext}`);
  const tracked = require('node:child_process').execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  assert.deepEqual(tracked.filter((f) => /\.(fbx|vmd|bvh|pmx|vroid|vrma?)$/i.test(f)), []);
});

test('T-2691: idle variants come from different motion files; lift is a full-body hold with hanging legs', () => {
  for (const style of ['female', 'male']) {
    const a = manifest.clips[`idle.happy@${style}`];
    const b = manifest.clips[`idle.variant2@${style}`];
    assert.ok(a.src && b.src && a.src !== b.src, `${style}: ${a.src} vs ${b.src}`);
    const lift = manifest.clips[`hold.lift@${style}`];
    assert.equal(lift.mask, 'full', `${style}: the legs are part of the lift`);
    assert.equal(lift.upright, true);
    for (const s of ['left', 'right']) {
      const up = lift.pose[`${s}UpperLeg`];
      const low = lift.pose[`${s}LowerLeg`];
      const foot = lift.pose[`${s}Foot`];
      assert.ok(up && Math.abs(up[0]) <= 15, `${style} ${s} thigh nearly straight down: ${up}`);
      assert.ok(low && low[0] >= 0 && low[0] <= 30, `${style} ${s} knee soft, never bent backwards: ${low}`);
      assert.ok(foot && foot[0] >= 20, `${style} ${s} toes point down: ${foot}`);
    }
  }
  // the old male lift (arms spread in an A) is gone
  assert.notEqual(manifest.clips['hold.lift@male'].src, 'mixamo/ede8954e-5272-46c2-b3c5-c701e5ee887c.fbx');
  // liliya's idle posture cycle leaves out the 47°-turned playful stand and does not tick every 12 s
  const pc = manifest.clips['idle.posture-cycle@female'];
  assert.ok(!pc.cycle.includes('stand.playful') && pc.every >= 15, JSON.stringify(pc));
});
