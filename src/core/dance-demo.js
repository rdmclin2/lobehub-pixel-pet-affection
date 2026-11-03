'use strict';
// The built-in demo dance (docs/vrm-dance.md §5.4): 「节拍摇摆」, 16 s at 120 BPM, choreographed here from
// numbers — no third-party motion or music, nothing read from disk. Four 4-s sections, cross-blended over
// half a beat, the last blending back into the first so it loops seamlessly:
//   A  sway   hips side to side with a knee bounce on every beat, arms swinging
//   B  clap   arms forward, hands meet on beats 2 and 4, a nod on each clap
//   C  heart  arms up over the head, forearms bent in (a heart), swaying
//   D  turn   arms out, half a turn (180°) and back
// demoClip() is in the shape src/core/vrma-write.js writeVrma takes (VRM normalized bones, she faces +Z, her
// left is +X; the reference rest of core/vmd-retarget.js), so main serves it as vrmlib://dance/demo/dance.vrma
// like any baked dance; demoBeatWav() is its music (kick on every beat, a clap on 2 and 4, off-beat hats) as a
// 16-bit mono WAV, served as vrmlib://dance/demo/audio.wav. demoPoseAt(t) gives the angles for the tests.
const W = require('./vrma-write');
const R = require('./vmd-retarget');

const BPM = 120;
const DURATION = 16;
const FPS = 30;
const SECTION = 4; // s
const BLEND = 0.25; // s either side of a section change
const H = R.REST_HIPS_Y;

const smooth = (k) => { const x = Math.max(0, Math.min(1, k)); return x * x * (3 - 2 * x); };
const deg2q = (x = 0, y = 0, z = 0) => {
  // XYZ Euler (deg, three.js order) → [x, y, z, w]
  const [a, b, c] = [x, y, z].map((v) => (v * Math.PI) / 360);
  const [ca, cb, cc, sa, sb, sc] = [Math.cos(a), Math.cos(b), Math.cos(c), Math.sin(a), Math.sin(b), Math.sin(c)];
  return [sa * cb * cc + ca * sb * sc, ca * sb * cc - sa * cb * sc, ca * cb * sc + sa * sb * cc, ca * cb * cc - sa * sb * sc];
};

// the shared beat signals at time t (s): s sways over two beats, dip is 1 on every beat, clap 1 on 2 and 4
const sway = (t) => Math.sin(Math.PI * t);
const dip = (t) => 0.5 + 0.5 * Math.cos(4 * Math.PI * t);
const clap = (t) => (0.5 + 0.5 * Math.cos(2 * Math.PI * (t - 0.5))) ** 3;
// the half turn of section D: 0 → 180° over 12.25–13.25 s, back over 14.25–15.25 s
const turn = (t) => 180 * (smooth(t - 12.25) - smooth(t - 14.25));

// each section's pose: { bone: [x, y, z] deg }, hips position, face
function legs(k) {
  return { leftUpperLeg: [-12 * k, 0, 0], rightUpperLeg: [-12 * k, 0, 0], leftLowerLeg: [24 * k, 0, 0], rightLowerLeg: [24 * k, 0, 0], leftFoot: [-12 * k, 0, 0], rightFoot: [-12 * k, 0, 0] };
}
const SECTIONS = [
  // A sway
  (t) => {
    const s = sway(t);
    const d = dip(t);
    return {
      bones: { hips: [0, 8 * s, 6 * s], spine: [0, 0, -4 * s], chest: [0, 0, -2 * s], neck: [0, 0, 0], head: [0, 0, 5 * s], leftUpperArm: [-25 * s, 0, -68], rightUpperArm: [25 * s, 0, 68], leftLowerArm: [0, -25, 0], rightLowerArm: [0, 25, 0], ...legs(d) },
      hips: [0.035 * H * s, H * (1 - 0.03 * d), 0],
      face: { happy: 0.35 },
    };
  },
  // B clap
  (t) => {
    const c = clap(t);
    const d = dip(t);
    return {
      bones: { hips: [0, 0, 0], spine: [4 * c, 0, 0], chest: [2 * c, 0, 0], neck: [0, 0, 0], head: [6 * c, 0, 0], leftUpperArm: [0, -(55 + 25 * c), -35], rightUpperArm: [0, 55 + 25 * c, 35], leftLowerArm: [0, -(20 + 30 * c), 0], rightLowerArm: [0, 20 + 30 * c, 0], ...legs(d) },
      hips: [0, H * (1 - 0.03 * d), 0],
      face: { happy: 0.3 + 0.5 * c },
    };
  },
  // C heart
  (t) => {
    const s = sway(t);
    const d = dip(t) * 0.5;
    return {
      bones: { hips: [0, 0, 5 * s], spine: [0, 0, -6 * s], chest: [0, 0, -2 * s], neck: [0, 0, 0], head: [0, 0, 8 * s], leftUpperArm: [0, 0, 72 + 5 * s], rightUpperArm: [0, 0, -72 + 5 * s], leftLowerArm: [0, 0, 55], rightLowerArm: [0, 0, -55], ...legs(d) },
      hips: [0.03 * H * s, H * (1 - 0.03 * d), 0],
      face: { happy: 0.7 },
    };
  },
  // D turn
  (t) => {
    const d = dip(t);
    return {
      bones: { hips: [0, turn(t), 0], spine: [0, 0, 0], chest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], leftUpperArm: [0, 0, -10], rightUpperArm: [0, 0, 10], leftLowerArm: [0, -10, 0], rightLowerArm: [0, 10, 0], ...legs(d) },
      hips: [0, H * (1 - 0.03 * d), 0],
      face: { happy: 0.5 },
    };
  },
];

// The pose at t (s): the section's, blended into the next over ±BLEND around each change (cyclic: 16 s → 0).
function demoPoseAt(t) {
  const u = ((t % DURATION) + DURATION) % DURATION;
  const i = Math.floor(u / SECTION) % SECTIONS.length;
  const into = u - i * SECTION; // s into the section
  let a = i;
  let b = i;
  let k = 0;
  if (into > SECTION - BLEND) { b = (i + 1) % SECTIONS.length; k = smooth((into - (SECTION - BLEND)) / (2 * BLEND)); } else if (into < BLEND) { a = (i + SECTIONS.length - 1) % SECTIONS.length; k = smooth((into + BLEND) / (2 * BLEND)); }
  const P = SECTIONS[a](u);
  const Q = SECTIONS[b](u);
  const lerp = (x, y) => x + (y - x) * k;
  const bones = {};
  for (const n of new Set([...Object.keys(P.bones), ...Object.keys(Q.bones)])) {
    const p = P.bones[n] || [0, 0, 0];
    const q = Q.bones[n] || [0, 0, 0];
    bones[n] = p.map((v, j) => lerp(v, q[j]));
  }
  const face = {};
  for (const n of new Set([...Object.keys(P.face), ...Object.keys(Q.face)])) face[n] = lerp(P.face[n] || 0, Q.face[n] || 0);
  return { bones, hips: P.hips.map((v, j) => lerp(v, Q.hips[j])), face, section: 'ABCD'[k < 0.5 ? a : b] };
}

// The clip for writeVrma: every bone of the reference rest keyed (the ones the dance does not move held still),
// so a cross-fade never lets the T-pose through (renderer/vrm-anim.js).
function demoClip() {
  const n = DURATION * FPS + 1;
  const times = Array.from({ length: n }, (_, i) => +(i / FPS).toFixed(4));
  const poses = times.map((t) => demoPoseAt(t));
  const moving = Object.keys(poses[0].bones);
  const bones = {};
  for (const b of Object.keys(R.VRM_REST)) {
    if (moving.includes(b)) bones[b] = { times, values: poses.map((p) => W.qnorm(deg2q(...p.bones[b]))) };
    else bones[b] = { times: [0, DURATION], values: [[0, 0, 0, 1], [0, 0, 0, 1]] };
  }
  const expressions = { happy: { times, values: poses.map((p) => +(p.face.happy || 0).toFixed(3)) } };
  return { duration: DURATION, bones, hips: { times, values: poses.map((p) => p.hips) }, restHipsY: H, rest: R.VRM_REST, expressions };
}

// The music: kick on every beat, a clap on beats 2 and 4, a soft hat off the beat, 16 s, 16-bit mono WAV.
function demoBeatWav({ sampleRate = 22050 } = {}) {
  const n = Math.round(DURATION * sampleRate);
  const out = new Float32Array(n);
  let seed = 12345;
  const noise = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed / 4294967296) * 2 - 1; };
  const beat = 60 / BPM;
  const add = (start, len, fn) => { const i0 = Math.round(start * sampleRate); for (let i = 0; i < Math.round(len * sampleRate) && i0 + i < n; i++) out[i0 + i] += fn(i / sampleRate); };
  for (let k = 0; k < DURATION / beat; k++) {
    // kick: a falling sine
    let ph = 0;
    add(k * beat, 0.25, (tau) => { ph += (2 * Math.PI * (50 + 70 * Math.exp(-tau * 30))) / sampleRate; return Math.sin(ph) * Math.exp(-tau * 12) * 0.9; });
    // hat: a click of high noise between the beats
    let prev = 0;
    add(k * beat + beat / 2, 0.05, (tau) => { const x = noise(); const h = x - prev; prev = x; return h * Math.exp(-tau * 80) * 0.12; });
    // clap on 2 and 4: three quick bursts of noise
    if (k % 2 === 1) add(k * beat, 0.16, (tau) => noise() * (Math.exp(-tau * 35) + 0.6 * Math.exp(-Math.max(0, tau - 0.012) * 300) + 0.4 * Math.exp(-Math.max(0, tau - 0.024) * 300)) * 0.35);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.7 / peak : 1;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * g * 32767))), 44 + i * 2);
  return buf;
}

let cache = null;
// { vrma, wav, extent, ground } made once per process
function demoAssets() {
  if (!cache) {
    const clip = demoClip();
    const m = R.extentOf(clip, DURATION * FPS, FPS);
    cache = { vrma: W.writeVrma(clip, { name: 'demo', generator: 'pixel-pet dance-demo' }), wav: demoBeatWav(), extent: m.extent, ground: m.ground };
  }
  return cache;
}

module.exports = { BPM, DURATION, FPS, SECTION, demoPoseAt, demoClip, demoBeatWav, demoAssets, deg2q };
