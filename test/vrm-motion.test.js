'use strict';
// VRM renderer, pure part (src/core/vrm-motion.js): state → expression / motion mapping, pack overrides and
// fallbacks, lip-sync weights, the frame budget, blinking and gaze. Plus: the renderer only draws the look
// the app resolved, the vendored runtime is in place with its licenses, and the homemade test model is a
// complete VRM. No third-party model is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/core/vrm-motion');
const { STATES } = require('../src/core/fx');
const { ZONES } = require('../src/core/touch-zones');
const V = require('../src/core/vrm');
const { makeTestVrm } = require('../scripts/make-test-vrm');

const ROOT = path.join(__dirname, '..');
const all = (n) => M.PRESETS.includes(n);
const only = (...names) => (n) => names.includes(n);

test('every app state and every touch zone has a VRM look made of preset expressions and known moves', () => {
  for (const s of STATES) assert.ok(M.STATE_LOOKS[s], `state ${s} has a look`);
  for (const z of Object.keys(ZONES)) assert.ok(M.TOUCH_LOOKS[z], `touch zone ${z} has a look`);
  for (const L of [...Object.values(M.STATE_LOOKS), ...Object.values(M.TOUCH_LOOKS), ...Object.values(M.MOOD_LOOKS)]) {
    for (const [n, w] of Object.entries(L.face)) { assert.ok(all(n), `${n} is a VRM preset`); assert.ok(w > 0 && w <= 1); }
    for (const k of Object.keys(L.motion)) assert.ok(M.MOTIONS.includes(k), `${k} is a known move`);
  }
});

test('the mapping: idle neutral, pat relaxed + bow, lifted surprised + dangling, eating chews, play spins and hops, sleep shuts the eyes', () => {
  assert.deepEqual(M.lookFor('idle').face, {});
  assert.deepEqual(M.lookFor('unknown-state'), M.STATE_LOOKS.idle);
  assert.ok(M.lookFor('pat').face.relaxed > 0.5 && M.lookFor('pat').motion.nodDown > 0);
  assert.ok(M.lookFor('lifted').face.surprised > 0.5 && M.lookFor('lifted').motion.dangle === 1);
  for (const f of ['eat_rice', 'eat_cookie', 'eat_fruit']) assert.equal(M.lookFor(f).motion.chew, 1);
  assert.ok(M.lookFor('play').motion.spin > 0 && M.lookFor('play').motion.hop > 0 && M.lookFor('play').face.happy === 1);
  assert.equal(M.lookFor('sleep').face.blink, 1);
  assert.ok(M.lookFor('sad').face.sad > 0.5);
  assert.ok(M.lookFor('walk').motion.stride === 1);
  // touches: the zone's look, the angry / annoyed mood wins
  assert.equal(M.lookFor('touch-head'), M.TOUCH_LOOKS.head);
  assert.equal(M.lookFor('touch-chest', 'angry'), M.MOOD_LOOKS.angry);
  assert.equal(M.lookFor('touch-legs', 'annoyed'), M.MOOD_LOOKS.annoyed);
  assert.equal(M.lookFor('touch-nowhere'), M.STATE_LOOKS.pat);
});

test('resolveFace: model names, pack overrides, safe fallbacks for missing expressions', () => {
  // a full model: the presets as they are
  assert.deepEqual(M.resolveFace({ happy: 0.85 }, all), { happy: 0.85 });
  // pack.json vrm.expressions.happy = "joy_custom": replaces the strongest emotion, keeps its weight
  const has = (n) => all(n) || n === 'joy_custom';
  assert.deepEqual(M.resolveFace({ happy: 1, surprised: 0.3 }, has, 'joy_custom'), { joy_custom: 1, surprised: 0.3 });
  // an override on a state without an emotion is added at full weight
  assert.deepEqual(M.resolveFace({}, has, 'joy_custom'), { joy_custom: 1 });
  // an override the model does not have: ignored, the preset stays
  assert.deepEqual(M.resolveFace({ happy: 0.7 }, all, 'missing'), { happy: 0.7 });
  // missing presets fall back: relaxed → happy, surprised → oh, blinkRight → blink, angry → sad
  assert.deepEqual(M.resolveFace({ relaxed: 0.7, happy: 0.4 }, only('happy')), { happy: 0.7 });
  assert.deepEqual(M.resolveFace({ surprised: 0.9 }, only('oh')), { oh: 0.9 });
  assert.deepEqual(M.resolveFace({ blinkRight: 1 }, only('blink')), { blink: 1 });
  assert.deepEqual(M.resolveFace({ angry: 1 }, only('sad')), { sad: 1 });
  // a model with no expressions at all: nothing, no error
  for (const L of Object.values(M.STATE_LOOKS)) assert.deepEqual(M.resolveFace(L.face, () => false), {});
  assert.equal(M.expressionFor('ee', only('ih')), 'ih');
  assert.equal(M.expressionFor('ee', () => false), null);
});

test('pose: lifted dangles and swings the legs, play turns her round, walk strides, idle arms rest down', () => {
  const at = (look, t, st = t) => {
    const cur = Object.fromEntries(M.MOTIONS.map((k) => [k, look.motion[k] || 0]));
    return M.pose(cur, t, st);
  };
  const idle = at(M.STATE_LOOKS.idle, 1);
  assert.ok(idle.bones.leftUpperArm.z < -60 && idle.bones.rightUpperArm.z > 60, 'arms down from the T-pose');
  assert.equal(idle.root.yaw, 0);
  assert.equal(idle.root.lift, 0);
  // lifted: the lower legs hang bent, the legs swing over time
  const l1 = at(M.STATE_LOOKS.lifted, 0.1);
  const l2 = at(M.STATE_LOOKS.lifted, 0.4);
  assert.ok(l1.bones.leftLowerLeg.x > 0 && l2.bones.leftLowerLeg.x > 0);
  assert.notEqual(l1.bones.leftUpperLeg.x, l2.bones.leftUpperLeg.x);
  assert.notEqual(l1.bones.leftUpperArm.z, l2.bones.leftUpperArm.z);
  // play: half way through the turn she faces away (≈180°), and she hops
  const p = at(M.STATE_LOOKS.play, 0.45 / 1.6 * 1.6, 0.45);
  assert.ok(Math.abs(p.root.yaw - 180) < 1, `yaw ${p.root.yaw}`);
  assert.ok(at(M.STATE_LOOKS.play, 0.3).root.lift > 0);
  // walk: the legs swing opposite
  const w = at(M.STATE_LOOKS.walk, 0.1);
  assert.ok(Math.sign(w.bones.leftUpperLeg.x) === -Math.sign(w.bones.rightUpperLeg.x));
  // pat bows the head
  assert.ok(at(M.STATE_LOOKS.pat, 0).bones.head.x > 3);
  // eating opens and shuts the mouth
  const chew = [0.05, 0.2, 0.35, 0.5].map((t) => M.motionMouth({ chew: 1 }, t));
  assert.ok(Math.max(...chew) > 0.4 && Math.min(...chew) < 0.1);
  assert.equal(M.motionMouth({}, 1), 0);
  // breathing moves the spine and chest
  assert.notEqual(M.breath(0.2).chest, M.breath(1.5).chest);
  assert.ok(Math.abs(M.breath(0.7, 1).chest) > Math.abs(M.breath(0.7, 0).chest) * 0.5);
});

// a byte spectrum (AnalyserNode.getByteFrequencyData) with energy in [lo, hi] Hz
function spectrum(bands, sampleRate = 48000, n = 512) {
  const bins = new Uint8Array(n);
  const hz = sampleRate / 2 / n;
  for (const [lo, hi, v] of bands) for (let i = Math.ceil(lo / hz); i <= Math.floor(hi / hz) && i < n; i++) bins[i] = v;
  return bins;
}
const top = (v) => Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];

test('lip sync: silence shuts the mouth, loud open vowels → aa, high formants → ee/ih, low → oh/ou', () => {
  assert.deepEqual(M.visemesFromSpectrum(new Uint8Array(512)), M.zeroVisemes());
  assert.deepEqual(M.visemesFromSpectrum(spectrum([[200, 3600, 8]])), M.zeroVisemes(), 'noise floor');
  assert.deepEqual(M.visemesFromSpectrum(null), M.zeroVisemes());
  const a = M.visemesFromSpectrum(spectrum([[700, 1400, 200], [200, 700, 60]]));
  assert.equal(top(a), 'aa');
  assert.ok(a.aa > 0.5);
  const e = M.visemesFromSpectrum(spectrum([[1800, 3600, 180], [200, 700, 50]]));
  assert.ok(['ee', 'ih'].includes(top(e)), JSON.stringify(e));
  const o = M.visemesFromSpectrum(spectrum([[200, 700, 200]]));
  assert.ok(['oh', 'ou'].includes(top(o)), JSON.stringify(o));
  // louder → wider
  assert.ok(M.visemesFromSpectrum(spectrum([[700, 1400, 220]])).aa > M.visemesFromSpectrum(spectrum([[700, 1400, 60]])).aa);
  for (const v of [a, e, o]) for (const k of M.VISEMES) assert.ok(v[k] >= 0 && v[k] <= 1);
});

test('lip sync: smoothing eases in and out and ends at exactly 0; the synthetic rhythm cycles the vowels', () => {
  let m = M.zeroVisemes();
  m = M.smoothVisemes(m, { aa: 1 }, 1 / 30);
  assert.ok(m.aa > 0.3 && m.aa < 1, 'eases in');
  for (let i = 0; i < 30; i++) m = M.smoothVisemes(m, { aa: 1 }, 1 / 30);
  assert.ok(m.aa > 0.95);
  const once = M.smoothVisemes(m, M.zeroVisemes(), 1 / 30);
  assert.ok(once.aa > 0.2 && once.aa < m.aa, 'eases out, not cut');
  for (let i = 0; i < 40; i++) m = M.smoothVisemes(m, M.zeroVisemes(), 1 / 30);
  assert.deepEqual(m, M.zeroVisemes(), 'silent mouth is exactly shut');
  const seen = new Set();
  for (let t = 0; t < 2; t += 0.02) { const s = M.syntheticVisemes(t); const k = top(s); if (s[k] > 0.2) seen.add(k); }
  for (const k of M.VISEMES) assert.ok(seen.has(k), `synthetic rhythm uses ${k}`);
});

test('frame budget: active while something happens, idle after N s of nothing, paused when hidden', () => {
  const B = M.BUDGET;
  assert.ok(B.activeFps >= 30 && B.activeFps <= 60 && B.idleFps >= 10 && B.idleFps <= 15);
  const now = 100000;
  assert.deepEqual(M.frameMode({ now, lastActivity: now - 500 }), { mode: 'active', fps: B.activeFps });
  assert.deepEqual(M.frameMode({ now, lastActivity: now - B.idleAfterMs - 1 }), { mode: 'idle', fps: B.idleFps });
  for (const k of ['talking', 'dragging', 'busy']) assert.equal(M.frameMode({ now, lastActivity: -Infinity, [k]: true }).mode, 'active', k);
  assert.deepEqual(M.frameMode({ now, lastActivity: -Infinity, blinking: true }), { mode: 'idle', fps: B.activeFps }, 'a blink is drawn smoothly');
  assert.deepEqual(M.frameMode({ now, lastActivity: now, talking: true, hidden: true }), { mode: 'paused', fps: 0 }, 'hidden wins');
  // shouldRender at 12 fps over one second: 12 frames from 60 Hz ticks
  let last = null;
  let n = 0;
  for (let t = 0; t < 1000; t += 1000 / 60) if (M.shouldRender(t, last, 12)) { n++; last = t; }
  assert.ok(n >= 11 && n <= 13, `idle frames ${n}`);
  last = null; n = 0;
  for (let t = 0; t < 1000; t += 1000 / 60) if (M.shouldRender(t, last, 30)) { n++; last = t; }
  assert.ok(n >= 29 && n <= 31, `active frames ${n}`);
  assert.equal(M.shouldRender(5, null, 0), false, 'paused: nothing');
  const meter = M.FpsMeter();
  for (let t = 0; t <= 2000; t += 100) meter.tick(t);
  assert.equal(meter.fps(2000), 11);
  assert.equal(meter.fps(5000), 0);
});

test('frame budget: resting statuses (pet-state happy / sad / hungry / sleep) do not keep it active; idle calms the bouncing', () => {
  for (const s of ['idle', 'look', 'happy', 'sad', 'hungry', 'sleep']) assert.equal(M.isResting(s), true, s);
  for (const s of ['pat', 'lifted', 'eat_rice', 'play', 'talk', 'walk', 'think', 'hatch', 'evolve', 'touch-head']) assert.equal(M.isResting(s), false, s);
  const now = 1e6;
  assert.equal(M.frameMode({ now, lastActivity: now - 60000, busy: !M.isResting('happy') }).mode, 'idle', 'resting happy for a minute: idle');
  const c = M.calm(M.STATE_LOOKS.happy);
  assert.deepEqual(c.face, M.STATE_LOOKS.happy.face, 'face kept');
  assert.equal(c.motion.hop, undefined, 'no hopping at 12 fps');
  assert.equal(c.motion.armsOut, M.STATE_LOOKS.happy.motion.armsOut, 'posture kept');
  assert.equal(M.calm(M.STATE_LOOKS.sleep).motion.nodDown, M.STATE_LOOKS.sleep.motion.nodDown);
});

test('blinking and gaze helpers', () => {
  assert.equal(M.blinkWeight(0), 0);
  assert.equal(M.blinkWeight(M.BLINK_MS / 2000), 1);
  assert.equal(M.blinkWeight(M.BLINK_MS / 1000), 0);
  assert.equal(M.blinkWeight(-1), 0);
  assert.equal(M.nextBlinkIn(() => 0.1), 0.25, 'a double blink');
  assert.ok(M.nextBlinkIn(() => 0.5) >= 2 && M.nextBlinkIn(() => 0.99) <= 6);
  const rect = { left: 0, top: 0, width: 200, height: 300 };
  assert.deepEqual(M.gazeNdc({ x: 100, y: 150 }, rect), { x: 0, y: 0 });
  assert.deepEqual(M.gazeNdc({ x: 200, y: 0 }, rect), { x: 1, y: 1 });
  assert.deepEqual(M.gazeNdc({ x: 200, y: 0 }, rect, { mirror: true }), { x: -1, y: 1 }, 'facing left flips x');
  assert.deepEqual(M.gazeNdc({ x: 100000, y: 150 }, rect), { x: 2.5, y: 0 }, 'clamped far away');
  assert.deepEqual(M.gazeNdc(null, rect), { x: 0, y: 0 });
  // the screen cursor in window coordinates
  assert.deepEqual(M.screenToClient({ x: 1500, y: 800 }, { x: 1400, y: 600 }), { x: 100, y: 200 });
});

test('the renderer only draws the look the app resolved: it never picks a pack or an outfit', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'vrm.js'), 'utf8');
  for (const call of ['equipOutfit(', 'setAppearance(', 'setAdult(', 'unlockAll(', 'resolveLook(', 'lookContext(', '.outfits', 'adultContent']) assert.ok(!src.includes(call), `vrm.js does not use ${call}`);
  assert.match(src, /startsWith\(`pack:\/\/\$\{look\.packId\}\/`\)/, 'the model URL must be in its own pack');
  assert.match(src, /setURLModifier/, 'files the model refers to are kept to its pack');
  for (const k of ['removeUnnecessaryVertices', 'combineSkeletons', 'deepDispose', 'forceContextLoss', 'alpha: true']) assert.ok(src.includes(k), k);
});

test('vendored three.js + three-vrm: loaded on demand, with licenses and versions', () => {
  const dir = path.join(ROOT, 'src', 'renderer', 'vendor', 'vrm');
  const js = fs.readFileSync(path.join(dir, 'three-vrm.min.js'), 'utf8');
  assert.match(js.slice(0, 300), /three\.js r187.*three-vrm 3\.5\.5/);
  assert.match(js, /PetVrmRuntime/);
  for (const f of ['three.LICENSE', 'three-vrm.LICENSE', 'README.md']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.match(fs.readFileSync(path.join(dir, 'three.LICENSE'), 'utf8'), /MIT License/);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  assert.ok(!html.includes('three-vrm.min.js'), 'not loaded with the page: only when a VRM look is first shown');
  assert.ok(html.includes('vrm.js') && html.includes('../core/vrm-motion.js'));
});

test('the homemade test model is a full VRM 1.0 (18 expressions, SpringBone, humanoid) and redistributable', () => {
  const buf = makeTestVrm();
  const r = V.inspectVrm(buf);
  assert.equal(r.ok, true);
  assert.equal(r.expressions.length, 18);
  for (const n of M.PRESETS) assert.ok(r.expressions.includes(n), n);
  assert.equal(r.springBone, true);
  assert.equal(r.meta.allowRedistribution, true);
  const json = V.readGlbJson(buf);
  for (const b of ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperLeg', 'leftFoot']) assert.ok(json.extensions.VRMC_vrm.humanoid.humanBones[b], b);
});

// T-2654: a real model (木子惡魔's 《蓝色小肥鱼Deepseek》) drew untextured, white: its textures are images inside the
// GLB, which GLTFLoader fetches through blob: URLs, and the page CSP blocked blob: in connect-src. The test model
// carries an embedded texture the same way (the e2e `vrm` scenario checks it loads), and the CSP allows blob:.
test('the test model embeds a PNG texture like a real model, and the renderer page lets GLTFLoader load it (blob:)', () => {
  const json = V.readGlbJson(makeTestVrm());
  assert.equal(json.images.length, 1);
  assert.equal(json.images[0].mimeType, 'image/png');
  assert.equal(typeof json.images[0].bufferView, 'number');
  assert.ok(json.materials.some((m) => m.pbrMetallicRoughness.baseColorTexture), 'a material uses it');
  assert.equal(V.readGlbJson(makeTestVrm({ texture: false })).images, undefined);
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  const dir = (name) => (csp.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0] === name) || []).slice(1);
  assert.ok(dir('connect-src').includes('blob:'), `connect-src ${dir('connect-src')}`);
  assert.ok(dir('img-src').includes('blob:'), `img-src ${dir('img-src')}`);
});
