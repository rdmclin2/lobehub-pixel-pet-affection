'use strict';
// Motion features of a clip in VRM terms (T-5081, docs/vrm-motion-library.md §3): the numbers the selection rules
// (scripts/lib/vrm-motion-rules.js) read to tell an idle from a nod, a wave, a walk or a stretch. Pure (no three):
// forward kinematics on the clip's own rest skeleton (clip.rest, world rest positions of the VRM bones) with the
// VRM normalized rotations of scripts/lib/vrm-bake-core.js / src/core/vmd-retarget.js.
//
// Units: lengths in hip heights (H = clip.restHipsY), so a Mixamo clip (cm, 1 m hips) and an MMD one (0.08 m per
// unit) read alike; angles in degrees; the body faces +Z with her left at +X (VRM 1.0 / glTF).

const W = require('../../src/core/vrma-write');

const { qmul, qinv, qnorm, qslerp, qangle, qrot } = W;
const ID = [0, 0, 0, 1];
const DEG = 180 / Math.PI;

function sample(tr, t, isQ) {
  if (!tr || !tr.times.length) return isQ ? ID : null;
  const { times, values } = tr;
  if (t <= times[0]) return values[0];
  const n = times.length - 1;
  if (t >= times[n]) return values[n];
  let lo = 0;
  let hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
  const k = (t - times[lo]) / (times[hi] - times[lo] || 1);
  return isQ ? qslerp(values[lo], values[hi], k) : values[lo].map((v, j) => v + (values[hi][j] - v) * k);
}

const CHAINS = {
  head: ['spine', 'chest', 'upperChest', 'neck', 'head'],
  leftHand: ['spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'],
  rightHand: ['spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'],
  leftElbow: ['spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm'],
  rightElbow: ['spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm'],
  leftFoot: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'],
  rightFoot: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'],
  chest: ['spine', 'chest', 'upperChest'],
};

// The world pose of one frame: { pos: { joint: [x,y,z] } (hip heights, the hips' start over the origin), rot: { bone: q } }
function poseAt(clip, t, origin) {
  const H = clip.restHipsY || 1;
  const R = clip.rest || {};
  const hp = clip.hips ? sample(clip.hips, t, false) : (R.hips || [0, H, 0]);
  const qh = sample(clip.bones.hips, t, true);
  const pos = { hips: [(hp[0] - origin[0]) / H, hp[1] / H, (hp[2] - origin[2]) / H] };
  const rot = { hips: qh };
  for (const [name, list] of Object.entries(CHAINS)) {
    let p = hp;
    let q = qh;
    let prev = 'hips';
    for (const b of list) {
      if (!R[b]) continue; // a bone the source lacks: skipped (its child hangs off the last present one)
      const off = [R[b][0] - R[prev][0], R[b][1] - R[prev][1], R[b][2] - R[prev][2]];
      const r = qrot(q, off);
      p = [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
      q = qmul(q, sample(clip.bones[b], t, true));
      prev = b;
      if (!rot[b]) rot[b] = q;
    }
    pos[name] = [(p[0] - origin[0]) / H, p[1] / H, (p[2] - origin[2]) / H];
  }
  return { pos, rot };
}

// yaw (about +Y) and pitch (about +X, + = looking down / bending forward) of a rotation's forward (+Z) axis
function yawPitch(q) {
  const f = qrot(q, [0, 0, 1]);
  return { yaw: Math.atan2(f[0], f[2]) * DEG, pitch: Math.asin(Math.max(-1, Math.min(1, -f[1]))) * DEG };
}
// how far a rotation's up (+Y) axis leans from the world up
function lean(q) { const u = qrot(q, [0, 1, 0]); return Math.acos(Math.max(-1, Math.min(1, u[1]))) * DEG; }

// Direction reversals of a signal that swing at least `min` (an oscillation count: a nod is ≥ 2).
function swings(xs, min) {
  if (!xs.length) return 0;
  let n = 0;
  let dir = 0;
  let hi = xs[0];
  let lo = xs[0];
  for (const x of xs) {
    if (dir === 0) {
      hi = Math.max(hi, x);
      lo = Math.min(lo, x);
      if (hi - x >= min) { dir = -1; lo = x; } else if (x - lo >= min) { dir = 1; hi = x; }
    } else if (dir > 0) {
      if (x > hi) hi = x;
      else if (hi - x >= min) { n++; dir = -1; lo = x; }
    } else if (x < lo) lo = x;
    else if (x - lo >= min) { n++; dir = 1; hi = x; }
  }
  return n;
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const range = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const r3 = (x) => +x.toFixed(3);

// Largest bone turn (deg) from the last frame to the first: the loop seam (vrm-bake-core.seamAngle, without three).
function seamDeg(clip) {
  let m = 0;
  for (const tr of Object.values(clip.bones)) if (tr.values.length > 1) m = Math.max(m, qangle(tr.values[tr.values.length - 1], tr.values[0]));
  return m;
}

const ARM_BONES = ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm'];
const LEG_BONES = ['leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
const HEAD_BONES = ['neck', 'head'];
const SPINE_BONES = ['spine', 'chest', 'upperChest'];

// clip → features (docs §3.2). fps: the sampling rate (10 is plenty for the rules).
function features(clip, { fps = 10 } = {}) {
  const d = clip.duration || 0;
  const n = Math.max(1, Math.floor(d * fps) + 1);
  const times = n === 1 ? [0] : Array.from({ length: n }, (_, i) => (i / (n - 1)) * d);
  const H = clip.restHipsY || 1;
  const origin = clip.hips ? sample(clip.hips, 0, false) : [0, H, 0];
  const frames = times.map((t) => poseAt(clip, t, origin));
  const keys = Math.max(...Object.values(clip.bones).map((tr) => tr.times.length));
  const P = (j) => frames.map((f) => f.pos[j]);
  const hips = P('hips');
  const head = P('head');
  const lh = P('leftHand');
  const rh = P('rightHand');
  const chest = P('chest');
  const lf = P('leftFoot');
  const rf = P('rightFoot');
  // head relative to the chest (a nod / a shake is the neck, not the whole body bowing)
  const headRel = frames.map((f) => yawPitch(qmul(qinv(f.rot.upperChest || f.rot.chest || f.rot.spine || ID), f.rot.head || ID)));
  const hipsDir = frames.map((f) => yawPitch(f.rot.hips));
  const bodyLean = frames.map((f) => lean(f.rot.upperChest || f.rot.chest || f.rot.spine || f.rot.hips));
  const torsoPitch = frames.map((f) => yawPitch(f.rot.upperChest || f.rot.chest || f.rot.hips).pitch);
  // angular speed (deg/s) of a group of bones, local rotations
  const speed = (bones) => {
    if (n < 2) return 0;
    let s = 0;
    let c = 0;
    for (const b of bones) {
      const tr = clip.bones[b];
      if (!tr) continue;
      for (let i = 1; i < n; i++) { s += qangle(sample(tr, times[i], true), sample(tr, times[i - 1], true)) / (times[i] - times[i - 1]); c++; }
    }
    return c ? s / c : 0;
  };
  const faceAt = (i) => { const h = head[i]; const f = qrot(frames[i].rot.head || ID, [0, 0.06, 0.08]); return [h[0] + f[0], h[1] + f[1], h[2] + f[2]]; };
  const handFace = frames.map((_, i) => Math.min(dist(lh[i], faceAt(i)), dist(rh[i], faceAt(i))));
  const handsUp = frames.map((_, i) => ({ l: lh[i][1] - head[i][1], r: rh[i][1] - head[i][1] }));
  const handsApart = frames.map((_, i) => dist(lh[i], rh[i]));
  const handFront = frames.map((_, i) => Math.max(lh[i][2] - chest[i][2], rh[i][2] - chest[i][2]));
  const handLow = frames.map((_, i) => Math.min(lh[i][1], rh[i][1]) - hips[i][1]);
  // the hand most above the shoulder, swinging side to side (a wave)
  const up = (arr, i) => arr[i][1] - chest[i][1] > 0.12;
  const waveL = swings(lh.filter((_, i) => up(lh, i)).map((p) => p[0]), 0.06);
  const waveR = swings(rh.filter((_, i) => up(rh, i)).map((p) => p[0]), 0.06);
  const travel = Math.hypot(hips[n - 1][0] - hips[0][0], hips[n - 1][2] - hips[0][2]);
  let path = 0;
  for (let i = 1; i < n; i++) path += Math.hypot(hips[i][0] - hips[i - 1][0], hips[i][2] - hips[i - 1][2]);
  const footY = frames.map((_, i) => Math.min(lf[i][1], rf[i][1]));
  const footGap = lf.map((p, i) => p[2] - rf[i][2]); // a stride swings this back and forth
  const hy = hips.map((p) => p[1]);
  const yaw = hipsDir.map((x) => x.yaw);
  // unwrap the hips yaw
  for (let i = 1; i < yaw.length; i++) { while (yaw[i] - yaw[i - 1] > 180) yaw[i] -= 360; while (yaw[i] - yaw[i - 1] < -180) yaw[i] += 360; }
  // the per-frame speed of the whole upper body (deg/s): a startle is a burst early on, then calm
  const frameSpeed = [0];
  for (let i = 1; i < n; i++) {
    let s = 0;
    for (const b of [...ARM_BONES, ...SPINE_BONES, ...HEAD_BONES]) if (clip.bones[b]) s += qangle(sample(clip.bones[b], times[i], true), sample(clip.bones[b], times[i - 1], true));
    frameSpeed.push(s / (times[i] - times[i - 1]));
  }
  let peak = 0;
  let peakAt = 0;
  frameSpeed.forEach((v, i) => { if (v > peak) { peak = v; peakAt = i; } });
  const meanSpeed = mean(frameSpeed.slice(1)) || 1;
  const poseOf = (i) => (bodyLean[i] > 60 && hips[i][1] < 0.5 ? 'lay' : hips[i][1] < 0.6 ? 'sit' : hips[i][1] < 0.8 ? 'crouch' : 'stand');
  return {
    duration: r3(d),
    start: poseOf(0),
    end: poseOf(n - 1),
    burst: { ratio: +(peak / meanSpeed).toFixed(2), at: r3(n > 1 ? peakAt / (n - 1) : 0) },
    hipsBack: r3(Math.min(...hips.slice(0, Math.ceil(n / 2)).map((p) => p[2]))),
    keys,
    static: keys <= 3 || d < 0.1,
    bones: Object.keys(clip.bones).length,
    fingers: Object.keys(clip.bones).some((b) => /Index|Thumb/.test(b)),
    seamDeg: +seamDeg(clip).toFixed(1),
    hips: {
      heightMin: r3(Math.min(...hy)), heightMean: r3(mean(hy)), heightMax: r3(Math.max(...hy)), bob: r3(range(hy)),
      travel: r3(travel), path: r3(path), speed: r3(d > 0 ? travel / d : 0), yawTurn: +(yaw[n - 1] - yaw[0]).toFixed(1), yawRange: +range(yaw).toFixed(1),
    },
    lean: { mean: +mean(bodyLean).toFixed(1), max: +Math.max(...bodyLean).toFixed(1) },
    torsoPitch: { mean: +mean(torsoPitch).toFixed(1), max: +Math.max(...torsoPitch).toFixed(1), range: +range(torsoPitch).toFixed(1) },
    head: {
      pitchRange: +range(headRel.map((x) => x.pitch)).toFixed(1), yawRange: +range(headRel.map((x) => x.yaw)).toFixed(1),
      pitchSwings: swings(headRel.map((x) => x.pitch), 6), yawSwings: swings(headRel.map((x) => x.yaw), 8),
      pitchMean: +mean(headRel.map((x) => x.pitch)).toFixed(1), pitchMax: +Math.max(...headRel.map((x) => x.pitch)).toFixed(1), pitchMin: +Math.min(...headRel.map((x) => x.pitch)).toFixed(1),
    },
    hands: {
      upMax: r3(Math.max(...handsUp.map((x) => Math.max(x.l, x.r)))),
      bothUpFrac: r3(mean(handsUp.map((x) => (x.l > 0.02 && x.r > 0.02 ? 1 : 0)))),
      oneUpFrac: r3(mean(handsUp.map((x) => (Math.max(x.l, x.r) > 0.02 ? 1 : 0)))),
      faceMin: r3(Math.min(...handFace)), faceFrac: r3(mean(handFace.map((x) => (x < 0.2 ? 1 : 0)))),
      apartMin: r3(Math.min(...handsApart)), apartMean: r3(mean(handsApart)), togetherFrac: r3(mean(handsApart.map((x) => (x < 0.16 ? 1 : 0)))),
      frontMax: r3(Math.max(...handFront)), lowMean: r3(mean(handLow)),
      wave: Math.max(waveL, waveR),
      travel: r3(Math.max(range(lh.map((p) => p[0])) + range(lh.map((p) => p[1])), range(rh.map((p) => p[0])) + range(rh.map((p) => p[1])))),
    },
    feet: { lift: r3(Math.max(...footY) - Math.min(...footY)), strideSwings: swings(footGap, 0.08), strideRange: r3(range(footGap)) },
    energy: { arms: +speed(ARM_BONES).toFixed(1), legs: +speed(LEG_BONES).toFixed(1), head: +speed(HEAD_BONES).toFixed(1), spine: +speed(SPINE_BONES).toFixed(1) },
  };
}

module.exports = { features, poseAt, yawPitch, lean, swings, seamDeg, sample, CHAINS };
