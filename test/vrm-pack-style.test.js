'use strict';
// pack.json vrm.style / vrm.motions (src/core/packs.js, docs/vrm-motion-system.md §4.2), the look handed to the
// renderer (style resolved, source pack | meta | default), the posture saved per pack (settings.vrmPostures),
// and a guard that the shared pixel layer is the same as before VRM got its own motion (§8.1, §8.4).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const P = require('../src/core/packs');
const SL = require('../src/core/settings');
const Fx = require('../src/core/fx');
const TZ = require('../src/core/touch-zones');
const { makeTestVrm } = require('../scripts/make-test-vrm');

const ROOT = path.join(__dirname, '..');
function pack(vrm) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrm-style-pack-'));
  fs.mkdirSync(path.join(dir, 'models'));
  fs.writeFileSync(path.join(dir, 'models', 'a.vrm'), makeTestVrm({ name: 'Style Fish', meta: { authors: ['E2E'] } }));
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ schema: 2, id: 'vrm-style-fish', name: 'Style Fish', species: 'dafeiyu', kind: 'vrm', vrm: { outfits: { daily: 'models/a.vrm' }, ...vrm } }));
  // loadPacks reads every folder under a root: give it a root with only this pack
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vrm-style-root-'));
  fs.renameSync(dir, path.join(root, 'vrm-style-fish'));
  return P.loadPacks([{ dir: root, source: 'user' }]);
}
const lookOf = (packs) => P.resolveLook(packs, { packId: 'vrm-style-fish', speciesId: 'dafeiyu', outfitId: 'daily' });

test('vrm.style: a name or { base, …overrides } reaches the look; left out, the model is read (source meta)', () => {
  const m = pack({ style: 'male' });
  assert.deepEqual(m.problems, []);
  const s = lookOf(m.packs).vrm.style;
  assert.deepEqual([s.name, s.set, s.source, s.amplitude], ['male', 'male', 'pack', 0.8]);
  const o = lookOf(pack({ style: { base: 'female', amplitude: 0.6 } }).packs).vrm.style;
  assert.deepEqual([o.name, o.source, o.amplitude, o.hipSway], ['female', 'pack', 0.6, 1]);
  const g = lookOf(pack({}).packs).vrm.style;
  assert.equal(g.source, 'meta', 'no vrm.style: guessed from the model body');
  assert.ok(['female', 'male', 'neutral'].includes(g.name));
});

test('vrm.style / vrm.motions errors are refused with a reason', () => {
  const bad = pack({ style: 'robot' });
  assert.equal(bad.packs.size, 0);
  assert.match(bad.problems[0].errors.join(' '), /vrm.style: unknown style "robot"/);
  assert.match(pack({ style: { base: 'male', bounce: 2 } }).problems[0].errors.join(' '), /vrm.style.bounce: unknown field/);
  assert.match(pack({ motions: { 'stand.relaxed': 'stand.shy@male' } }).problems[0].errors.join(' '), /vrm.motions.stand.relaxed: "stand.shy@male" is not a stand.relaxed@<style> entry/);
  assert.match(pack({ motions: { 'fly.away': 'x@male' } }).problems[0].errors.join(' '), /vrm.motions.fly.away: unknown slot/);
  const ok = pack({ motions: { 'stand.relaxed': 'stand.relaxed@male' } });
  assert.deepEqual(lookOf(ok.packs).vrm.motions, { 'stand.relaxed': 'stand.relaxed@male' });
});

test('the posture saved per VRM pack: only known postures, auto is the default (not stored)', () => {
  const s = SL.normalizeSettings({ vrmPostures: { 'vrm-dafeiyu-liliya': 'sit.rest', 'vrm-x-y': 'flying', BAD: 'sit.rest', 'vrm-a-b': 'auto' } });
  assert.deepEqual(s.vrmPostures, { 'vrm-dafeiyu-liliya': 'sit.rest' });
  assert.deepEqual(SL.normalizeSettings({}).vrmPostures, {});
  assert.deepEqual(SL.VRM_POSTURES, ['auto', 'stand.relaxed', 'stand.confident', 'stand.shy', 'stand.playful', 'sit.rest', 'sit.doze']);
});

test('pixel characters are untouched: the shared layer is what it was before VRM got its own motion', () => {
  assert.deepEqual(Fx.STATES, ['idle', 'look', 'happy', 'pat', 'sad', 'hungry', 'sleep', 'eat_rice', 'eat_cookie', 'eat_fruit', 'think', 'talk', 'play', 'hatch', 'evolve', 'lifted', 'walk']);
  assert.deepEqual(Object.keys(TZ.ZONES).sort(), ['belly', 'butt', 'chest', 'face', 'feet', 'hands', 'head', 'legs', 'tail']);
  // the files the design keeps byte for byte (docs/vrm-motion-system.md §2.1, §9.3), against the release VRM motion started from
  const BASE = '7bae23a';
  let has = true;
  try { execFileSync('git', ['cat-file', '-e', `${BASE}^{commit}`], { cwd: ROOT, stdio: 'ignore' }); } catch { has = false; }
  if (!has) return;
  const frozen = ['src/core/fx.js', 'src/core/touch-zones.js', 'src/core/pet-state.js', 'src/renderer/rig.js', 'src/renderer/live2d.js', 'src/renderer/fx.js'];
  const diff = execFileSync('git', ['diff', '--stat', BASE, '--', ...frozen], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(diff, '', diff);
});
