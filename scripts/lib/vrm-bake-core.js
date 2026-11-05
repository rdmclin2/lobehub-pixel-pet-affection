'use strict';
// The pure half of scripts/vrm-bake.js (docs/vrm-motion-system.md §3.7): Mixamo bone names → VRM humanoid
// bones, the retargeting maths (a Mixamo key in its bone's rest space → a rotation of a VRM normalized bone,
// whose rest is the identity), the bake parameters (trim / loop / mirror / amplitude / hold) and the .vrma
// writer (a glTF binary with VRMC_vrm_animation). No three.js here, so test/vrm-bake.test.js runs it in Node;
// the script does the FBX parsing (three's FBXLoader) and hands plain arrays to these functions.
//
// Quaternions are [x, y, z, w] arrays, like three's toArray().

// ---------- Mixamo → VRM humanoid ----------
// the table lives in src/core/vrm-bone-map.js (shared with the runtime's missing-bone fold, T-5081)
const { MIXAMO_TO_VRM } = require('../../src/core/vrm-bone-map');
// The VRM bones a humanoid must have (VRM 1.0 spec "required").
const VRM_REQUIRED = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
// "mixamorig:Hips", "mixamorigHips" (three strips the colon), "mixamorig1:Hips" → "Hips"
const stripMixamo = (name) => String(name || '').replace(/^mixamorig\d*:?/, '');
const vrmBoneOf = (mixamoName) => MIXAMO_TO_VRM[stripMixamo(mixamoName)] || null;
// leftHand ↔ rightHand
const mirrorBone = (b) => (b.startsWith('left') ? `right${b.slice(4)}` : b.startsWith('right') ? `left${b.slice(5)}` : b);

// ---------- quaternions (src/core/vrma-write.js, shared with the dance bake) ----------
const W = require('../../src/core/vrma-write');
const { qmul, qinv, qnorm, qslerp, qangle, VRM_PARENT, writeVrma, readVrma, glb } = W;

// A Mixamo key (local rotation of the bone) as the rotation of the VRM normalized bone: Mixamo bones carry
// non-identity rest rotations, VRM normalized bones rest at identity in world-aligned axes, so the key is
// carried into world axes: q_vrm = Q_parentWorldRest · q · Q_worldRest⁻¹. With identity rests it is q itself.
const retargetQ = (q, parentWorldRest, worldRest) => qnorm(qmul(qmul(parentWorldRest, q), qinv(worldRest)));
// A mirrored rotation (left ↔ right across the YZ plane): x stays, y and z turn the other way.
const mirrorQ = (q) => [q[0], -q[1], -q[2], q[3]];

// ---------- a clip ----------
// clip = { duration, bones: { vrmBone: { times: number[], values: [x,y,z,w][] } },
//          hips: { times, values: [x,y,z][] } | null (metres, world axes), restHipsY (metres), rest: { vrmBone: [x,y,z] world rest positions } }

// The value of a sampled track at time t (linear / slerp between keys; held outside).
function sampleTrack(tr, t, isQ) {
  const { times, values } = tr;
  if (!times.length) return null;
  if (t <= times[0]) return values[0];
  const n = times.length - 1;
  if (t >= times[n]) return values[n];
  let i = 0;
  while (i < n && times[i + 1] < t) i++;
  const k = (t - times[i]) / (times[i + 1] - times[i] || 1);
  const a = values[i];
  const b = values[i + 1];
  return isQ ? qslerp(a, b, k) : a.map((v, j) => v + (b[j] - v) * k);
}

// Keep [a, b] of every track, re-timed from 0 (a key at both ends is sampled in).
function trimClip(clip, a, b) {
  const lo = Math.max(0, a);
  const hi = Math.min(clip.duration, b);
  if (!(hi > lo)) throw new Error(`trim [${a}, ${b}] is outside the clip (0..${clip.duration})`);
  const cut = (tr, isQ) => {
    const times = [0];
    const values = [sampleTrack(tr, lo, isQ)];
    tr.times.forEach((t, i) => { if (t > lo + 1e-6 && t < hi - 1e-6) { times.push(t - lo); values.push(tr.values[i]); } });
    times.push(hi - lo);
    values.push(sampleTrack(tr, hi, isQ));
    return { times, values };
  };
  return { ...clip, duration: hi - lo, bones: Object.fromEntries(Object.entries(clip.bones).map(([n, tr]) => [n, cut(tr, true)])), hips: clip.hips && cut(clip.hips, false) };
}

// A pose (the first frame) held for `seconds`: Mixamo poses are 2 frames of 0.033 s; as a loop they would
// be re-played 30 times a second. Two equal keys, `seconds` apart.
function holdClip(clip, seconds = 1) {
  const hold = (tr) => ({ times: [0, seconds], values: [tr.values[0], tr.values[0]] });
  return { ...clip, duration: seconds, bones: Object.fromEntries(Object.entries(clip.bones).map(([n, tr]) => [n, hold(tr)])), hips: clip.hips && hold(clip.hips) };
}

// A seamless loop: the last `blend` seconds ease into the first frame (smoothstep), so the end meets the start.
function loopClip(clip, blend = 0.2) {
  const d = clip.duration;
  const b = Math.min(blend, d / 2);
  if (!(b > 0)) return clip;
  const ease = (t) => { const w = Math.max(0, Math.min(1, (t - (d - b)) / b)); return w * w * (3 - 2 * w); };
  const fix = (tr, isQ) => ({
    times: tr.times.slice(),
    values: tr.values.map((v, i) => { const w = ease(tr.times[i]); if (w <= 0) return v; const f = tr.values[0]; return isQ ? qslerp(v, f, w) : v.map((x, j) => x + (f[j] - x) * w); }),
  });
  return { ...clip, bones: Object.fromEntries(Object.entries(clip.bones).map(([n, tr]) => [n, fix(tr, true)])), hips: clip.hips && fix(clip.hips, false) };
}

// Left ↔ right: the mirror variant of a clip.
function mirrorClip(clip) {
  const bones = {};
  for (const [n, tr] of Object.entries(clip.bones)) bones[mirrorBone(n)] = { times: tr.times.slice(), values: tr.values.map(mirrorQ) };
  const rest = clip.rest ? Object.fromEntries(Object.entries(clip.rest).map(([n, p]) => [mirrorBone(n), [-p[0], p[1], p[2]]])) : clip.rest;
  return { ...clip, bones, rest, hips: clip.hips && { times: clip.hips.times.slice(), values: clip.hips.values.map((p) => [-p[0], p[1], p[2]]) } };
}

// Scale how far each key moves from the clip's first frame (k 0 = frozen on the first frame, 1 = as is).
function amplitudeClip(clip, k = 1) {
  if (k === 1) return clip;
  const scale = (tr, isQ) => ({ times: tr.times.slice(), values: tr.values.map((v) => (isQ ? qslerp(tr.values[0], v, k) : v.map((x, j) => tr.values[0][j] + (x - tr.values[0][j]) * k))) });
  return { ...clip, bones: Object.fromEntries(Object.entries(clip.bones).map(([n, tr]) => [n, scale(tr, true)])), hips: clip.hips && scale(clip.hips, false) };
}

// Hips sliding across the floor (a walk, a step) taken out: x / z held at the first key, y kept.
function inPlaceClip(clip) {
  if (!clip.hips) return clip;
  const [x0, , z0] = clip.hips.values[0];
  return { ...clip, hips: { times: clip.hips.times.slice(), values: clip.hips.values.map((p) => [x0, p[1], z0]) } };
}

// A walk cycle walked in place (T-2711): the steady forward travel of the hips (the straight line from the
// first key to the last) taken out of x / z, the side-to-side sway and the bob kept, then the hips put back
// on the spot they started from. inPlaceClip would freeze the sway too and make the walk stiff.
function detrendClip(clip) {
  if (!clip.hips || clip.hips.values.length < 2) return clip;
  const { times, values } = clip.hips;
  const d = clip.duration || times[times.length - 1] || 1;
  const p0 = values[0];
  const pn = values[values.length - 1];
  return { ...clip, hips: { times: times.slice(), values: values.map((p, i) => [p[0] - ((pn[0] - p0[0]) * times[i]) / d, p[1], p[2] - ((pn[2] - p0[2]) * times[i]) / d]) } };
}

// How fast a walk clip travels: the hips' floor distance from the first key to the last per second, in hip
// heights (so it holds for any model: the runtime multiplies by the model's own hips height). 0 without hips.
function travelSpeed(clip) {
  if (!clip.hips || clip.hips.values.length < 2 || !(clip.duration > 0)) return 0;
  const v = clip.hips.values;
  const dist = Math.hypot(v[v.length - 1][0] - v[0][0], v[v.length - 1][2] - v[0][2]);
  return dist / clip.duration / (clip.restHipsY || 1);
}

// Bigger (k > 1) or smaller turns of the listed bones: every key's rotation from the rest (the identity)
// scaled by k around its own axis, { bone: k } (T-2711: a poke turned the head too little to read).
function qpow(q, k) {
  const n = qnorm(q[3] < 0 ? q.map((x) => -x) : q);
  const ang = 2 * Math.acos(Math.min(1, n[3]));
  const s = Math.sqrt(Math.max(0, 1 - n[3] * n[3]));
  if (s < 1e-6) return [0, 0, 0, 1];
  const a = (ang * k) / 2;
  return [(n[0] / s) * Math.sin(a), (n[1] / s) * Math.sin(a), (n[2] / s) * Math.sin(a), Math.cos(a)];
}
function boostClip(clip, boost) {
  const bones = { ...clip.bones };
  for (const [b, k] of Object.entries(boost || {})) {
    const tr = bones[b];
    if (!tr || !(k > 0)) continue;
    bones[b] = { times: tr.times.slice(), values: tr.values.map((v) => qpow(v, k)) };
  }
  return { ...clip, bones };
}

// The hips' average floor position (x / z) moved to the origin: an idle that sways about a spot off to
// the side would otherwise stand her off-centre in the window for its whole length. The sway stays.
function centerClip(clip) {
  if (!clip.hips || !clip.hips.values.length) return clip;
  const n = clip.hips.values.length;
  const mx = clip.hips.values.reduce((s, p) => s + p[0], 0) / n;
  const mz = clip.hips.values.reduce((s, p) => s + p[2], 0) / n;
  return { ...clip, hips: { times: clip.hips.times.slice(), values: clip.hips.values.map((p) => [p[0] - mx, p[1], p[2] - mz]) } };
}

// How far apart a clip's last and first frames are: the largest bone turn (deg) across the loop seam.
function seamAngle(clip) {
  let m = 0;
  for (const tr of Object.values(clip.bones)) if (tr.values.length > 1) m = Math.max(m, qangle(tr.values[tr.values.length - 1], tr.values[0]));
  return m;
}

// The loop blend a clip needs: long enough that no bone turns faster than SEAM_SPEED deg/s while the end
// eases into the start (at least 0.25 s, at most a third of the clip). A fixed 0.25 s turned liliya's head
// 40° in a quarter second every time the trimmed 7 s "Standing Happily" idle looped (T-2684).
const SEAM_SPEED = 40;
function seamBlend(clip) {
  return Math.max(0.25, Math.min(clip.duration / 3, seamAngle(clip) / SEAM_SPEED));
}

// Euler degrees (three's default XYZ order) → a quaternion.
function qEuler(x = 0, y = 0, z = 0) {
  const r = Math.PI / 360;
  const [c1, c2, c3] = [Math.cos(x * r), Math.cos(y * r), Math.cos(z * r)];
  const [s1, s2, s3] = [Math.sin(x * r), Math.sin(y * r), Math.sin(z * r)];
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}

// Bones set to a fixed rotation for the whole clip: { bone: [x, y, z] deg } (a procedural layer baked in, e.g.
// the legs hanging while she is lifted). A bone the clip lacks gets a track.
function poseClip(clip, pose) {
  const bones = { ...clip.bones };
  for (const [b, e] of Object.entries(pose || {})) {
    const q = qEuler(...e);
    const tr = bones[b] || { times: [0, clip.duration] };
    bones[b] = { times: tr.times.slice(), values: tr.times.map(() => q.slice()) };
  }
  return { ...clip, bones };
}

// Every key of the listed bones turned a little more in the bone's own axes: { bone: [x, y, z] deg }
// (elbows bent, shoulders up…). Applied on the clip's own rotation (q · offset).
function offsetClip(clip, offset) {
  const bones = { ...clip.bones };
  for (const [b, e] of Object.entries(offset || {})) {
    const tr = bones[b];
    if (!tr) continue;
    const q = qEuler(...e);
    bones[b] = { times: tr.times.slice(), values: tr.values.map((v) => qnorm(qmul(v, q))) };
  }
  return { ...clip, bones };
}

// Hips upright and at standing height (the source kneels or crouches; the clip keeps its upper body): the hips
// rotation becomes the identity and the hips position the rest position.
function uprightClip(clip) {
  const bones = { ...clip.bones };
  if (bones.hips) bones.hips = { times: bones.hips.times.slice(), values: bones.hips.times.map(() => [0, 0, 0, 1]) };
  const rp = (clip.rest && clip.rest.hips) || [0, clip.restHipsY || 1, 0];
  const hips = clip.hips ? { times: clip.hips.times.slice(), values: clip.hips.times.map(() => rp.slice()) } : null;
  return { ...clip, bones, hips };
}

// Turned to face the user (T-5081): a source authored facing aside (many Mixamo talk / gesture clips stand 60–90°
// off) has its hips' mean heading turned back to +Z — the hips rotation pre-multiplied by the inverse yaw and the
// hips travel turned with it. Returns the clip as is when it already faces within 10°.
function yawOf(q) { const x = 2 * (q[0] * q[2] + q[3] * q[1]); const z = 1 - 2 * (q[0] * q[0] + q[1] * q[1]); return Math.atan2(x, z); }
function faceFrontClip(clip) {
  const tr = clip.bones.hips;
  if (!tr || !tr.values.length) return clip;
  let sx = 0;
  let sz = 0;
  for (const q of tr.values) { const a = yawOf(q); sx += Math.sin(a); sz += Math.cos(a); }
  const yaw = Math.atan2(sx, sz);
  if (Math.abs(yaw) < (10 * Math.PI) / 180) return clip;
  const inv = [0, Math.sin(-yaw / 2), 0, Math.cos(-yaw / 2)];
  const c = Math.cos(-yaw);
  const sn = Math.sin(-yaw);
  const bones = { ...clip.bones, hips: { times: tr.times.slice(), values: tr.values.map((q) => qnorm(qmul(inv, q))) } };
  const hips = clip.hips && { times: clip.hips.times.slice(), values: clip.hips.values.map((p) => [p[0] * c + p[2] * sn, p[1], -p[0] * sn + p[2] * c]) };
  return { ...clip, bones, hips, faced: +((yaw * 180) / Math.PI).toFixed(1) };
}

// The parameters of a library entry, in the order they apply.
function bakeParams(clip, e = {}) {
  let c = clip;
  if (Array.isArray(e.trim)) c = trimClip(c, e.trim[0], e.trim[1]);
  if (e.kind === 'posture' || e.hold === true || e.still) c = holdClip(c, 1); // a 2-frame pose: one held second
  if (e.faceFront) c = faceFrontClip(c);
  if (e.inPlace) c = inPlaceClip(c);
  if (e.detrend) c = detrendClip(c);
  if (typeof e.amplitude === 'number') c = amplitudeClip(c, e.amplitude);
  if (e.upright) c = uprightClip(c);
  if (e.boost) c = boostClip(c, e.boost);
  if (e.offset) c = offsetClip(c, e.offset);
  if (e.pose) c = poseClip(c, e.pose);
  if (e.mirror) c = mirrorClip(c);
  if (e.loop && e.kind !== 'posture') c = loopClip(c, typeof e.loopBlend === 'number' ? e.loopBlend : seamBlend(c));
  if (e.kind === 'idle' && e.center !== false) c = centerClip(c); // last: the loop blend moves the hips too
  return c;
}

// ---------- the .vrma writer: src/core/vrma-write.js (re-exported below) ----------

module.exports = {
  MIXAMO_TO_VRM, VRM_REQUIRED, VRM_PARENT, stripMixamo, vrmBoneOf, mirrorBone,
  qmul, qinv, qnorm, qslerp, qangle, retargetQ, mirrorQ,
  sampleTrack, trimClip, holdClip, loopClip, qEuler, poseClip, offsetClip, uprightClip, seamAngle, seamBlend, SEAM_SPEED, mirrorClip, amplitudeClip, inPlaceClip, detrendClip, travelSpeed, qpow, boostClip, centerClip, faceFrontClip, yawOf, bakeParams,
  writeVrma, readVrma, glb,
};
