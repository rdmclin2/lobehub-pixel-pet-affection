'use strict';
// The pure half of scripts/vrm-bake.js (docs/vrm-motion-system.md §3.7): Mixamo bone names → VRM humanoid
// bones, the retargeting maths (a Mixamo key in its bone's rest space → a rotation of a VRM normalized bone,
// whose rest is the identity), the bake parameters (trim / loop / mirror / amplitude / hold) and the .vrma
// writer (a glTF binary with VRMC_vrm_animation). No three.js here, so test/vrm-bake.test.js runs it in Node;
// the script does the FBX parsing (three's FBXLoader) and hands plain arrays to these functions.
//
// Quaternions are [x, y, z, w] arrays, like three's toArray().

// ---------- Mixamo → VRM humanoid ----------
const MIXAMO_TO_VRM = {
  Hips: 'hips', Spine: 'spine', Spine1: 'chest', Spine2: 'upperChest', Neck: 'neck', Head: 'head',
  LeftShoulder: 'leftShoulder', LeftArm: 'leftUpperArm', LeftForeArm: 'leftLowerArm', LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder', RightArm: 'rightUpperArm', RightForeArm: 'rightLowerArm', RightHand: 'rightHand',
  LeftUpLeg: 'leftUpperLeg', LeftLeg: 'leftLowerLeg', LeftFoot: 'leftFoot', LeftToeBase: 'leftToes',
  RightUpLeg: 'rightUpperLeg', RightLeg: 'rightLowerLeg', RightFoot: 'rightFoot', RightToeBase: 'rightToes',
};
for (const side of ['Left', 'Right']) {
  const s = side.toLowerCase();
  MIXAMO_TO_VRM[`${side}HandThumb1`] = `${s}ThumbMetacarpal`;
  MIXAMO_TO_VRM[`${side}HandThumb2`] = `${s}ThumbProximal`;
  MIXAMO_TO_VRM[`${side}HandThumb3`] = `${s}ThumbDistal`;
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    const mx = f === 'Little' ? 'Pinky' : f;
    MIXAMO_TO_VRM[`${side}Hand${mx}1`] = `${s}${f}Proximal`;
    MIXAMO_TO_VRM[`${side}Hand${mx}2`] = `${s}${f}Intermediate`;
    MIXAMO_TO_VRM[`${side}Hand${mx}3`] = `${s}${f}Distal`;
  }
}
// The VRM bones a humanoid must have (VRM 1.0 spec "required").
const VRM_REQUIRED = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
// "mixamorig:Hips", "mixamorigHips" (three strips the colon), "mixamorig1:Hips" → "Hips"
const stripMixamo = (name) => String(name || '').replace(/^mixamorig\d*:?/, '');
const vrmBoneOf = (mixamoName) => MIXAMO_TO_VRM[stripMixamo(mixamoName)] || null;
// leftHand ↔ rightHand
const mirrorBone = (b) => (b.startsWith('left') ? `right${b.slice(4)}` : b.startsWith('right') ? `left${b.slice(5)}` : b);

// ---------- quaternions ----------
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => { const n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] || 1; return [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n]; };
const qnorm = (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / n, q[1] / n, q[2] / n, q[3] / n]; };
const qdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
function qslerp(a, b, t) {
  let d = qdot(a, b);
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9995) return qnorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  const th = Math.acos(Math.min(1, d));
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s;
  const kb = Math.sin(t * th) / s;
  return [a[0] * ka + bb[0] * kb, a[1] * ka + bb[1] * kb, a[2] * ka + bb[2] * kb, a[3] * ka + bb[3] * kb];
}
// the angle (deg) between two rotations
const qangle = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(qdot(qnorm(a), qnorm(b))))) * 180) / Math.PI;

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

// The parameters of a library entry, in the order they apply.
function bakeParams(clip, e = {}) {
  let c = clip;
  if (Array.isArray(e.trim)) c = trimClip(c, e.trim[0], e.trim[1]);
  if (e.kind === 'posture' || e.hold === true || e.still) c = holdClip(c, 1); // a 2-frame pose: one held second
  if (e.inPlace) c = inPlaceClip(c);
  if (typeof e.amplitude === 'number') c = amplitudeClip(c, e.amplitude);
  if (e.upright) c = uprightClip(c);
  if (e.offset) c = offsetClip(c, e.offset);
  if (e.pose) c = poseClip(c, e.pose);
  if (e.mirror) c = mirrorClip(c);
  if (e.loop && e.kind !== 'posture') c = loopClip(c, typeof e.loopBlend === 'number' ? e.loopBlend : seamBlend(c));
  if (e.kind === 'idle' && e.center !== false) c = centerClip(c); // last: the loop blend moves the hips too
  return c;
}

// ---------- the .vrma writer ----------
// The humanoid tree of the rest pose (parents among the bones present).
const VRM_PARENT = {
  hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
  leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
};
for (const s of ['left', 'right']) {
  VRM_PARENT[`${s}ThumbMetacarpal`] = `${s}Hand`;
  VRM_PARENT[`${s}ThumbProximal`] = `${s}ThumbMetacarpal`;
  VRM_PARENT[`${s}ThumbDistal`] = `${s}ThumbProximal`;
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    VRM_PARENT[`${s}${f}Proximal`] = `${s}Hand`;
    VRM_PARENT[`${s}${f}Intermediate`] = `${s}${f}Proximal`;
    VRM_PARENT[`${s}${f}Distal`] = `${s}${f}Intermediate`;
  }
}
function presentParent(bone, has) {
  let p = VRM_PARENT[bone];
  while (p && !has(p)) p = VRM_PARENT[p];
  return p || null;
}

// clip → GLB bytes (Buffer). Nodes: the humanoid bones at their rest positions (identity rotations, as the
// VRMA spec's T-pose); channels: rotation of every bone, translation of hips.
function writeVrma(clip, { name = 'clip', generator = 'pixel-pet vrm-bake' } = {}) {
  const bonesIn = Object.keys(clip.bones).filter((b) => VRM_PARENT[b] !== undefined);
  if (!bonesIn.includes('hips')) throw new Error('a VRM animation needs the hips');
  const has = (b) => bonesIn.includes(b);
  const rest = clip.rest || {};
  const restOf = (b) => rest[b] || [0, b === 'hips' ? clip.restHipsY || 1 : 0, 0];
  // parents before children
  const order = [];
  const visit = (b) => { if (order.includes(b)) return; const p = presentParent(b, has); if (p) visit(p); order.push(b); };
  bonesIn.forEach(visit);
  const idx = Object.fromEntries(order.map((b, i) => [b, i]));
  const nodes = order.map((b) => {
    const p = presentParent(b, has);
    const w = restOf(b);
    const pw = p ? restOf(p) : [0, 0, 0];
    return { name: b, translation: [w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]] };
  });
  for (const b of order) { const p = presentParent(b, has); if (p) (nodes[idx[p]].children = nodes[idx[p]].children || []).push(idx[b]); }

  const chunks = [];
  let offset = 0;
  const bufferViews = [];
  const accessors = [];
  const addAccessor = (arr, type, minmax = false) => {
    const f = Float32Array.from(arr);
    const bytes = Buffer.from(f.buffer);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes, Buffer.alloc(pad));
    offset += bytes.length + pad;
    const comps = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
    const acc = { bufferView: bufferViews.length - 1, componentType: 5126, count: f.length / comps, type };
    if (minmax) { acc.min = [Math.min(...arr)]; acc.max = [Math.max(...arr)]; }
    accessors.push(acc);
    return accessors.length - 1;
  };
  const samplers = [];
  const channels = [];
  const timeCache = new Map();
  const timesAcc = (times) => { const k = times.join(','); if (!timeCache.has(k)) timeCache.set(k, addAccessor(times, 'SCALAR', true)); return timeCache.get(k); };
  for (const b of order) {
    const tr = clip.bones[b];
    samplers.push({ input: timesAcc(tr.times), output: addAccessor(tr.values.flatMap((q) => qnorm(q)), 'VEC4'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: idx[b], path: 'rotation' } });
  }
  if (clip.hips) {
    samplers.push({ input: timesAcc(clip.hips.times), output: addAccessor(clip.hips.values.flat(), 'VEC3'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: idx.hips, path: 'translation' } });
  }
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(order.map((b) => [b, { node: idx[b] }])) } } },
    scene: 0,
    scenes: [{ nodes: [idx.hips] }],
    nodes,
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors,
    animations: [{ name, samplers, channels }],
  };
  return glb(json, bin);
}

function glb(json, bin) {
  let j = Buffer.from(JSON.stringify(json), 'utf8');
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const ch = (len, type) => { const x = Buffer.alloc(8); x.writeUInt32LE(len, 0); x.writeUInt32LE(type, 4); return x; };
  return Buffer.concat([head, ch(j.length, 0x4e4f534a), j, ch(b.length, 0x004e4942), b]);
}

// Read a .vrma back (for checks): the JSON and its tracks as arrays.
function readVrma(buf) {
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'));
  const binStart = 20 + jl + 8;
  const acc = (i) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const f = new Float32Array(buf.buffer.slice(buf.byteOffset + binStart + v.byteOffset, buf.byteOffset + binStart + v.byteOffset + v.byteLength));
    return Array.from(f);
  };
  const anim = json.animations[0];
  const tracks = {};
  for (const c of anim.channels) {
    const s = anim.samplers[c.sampler];
    tracks[`${json.nodes[c.target.node].name}.${c.target.path}`] = { times: acc(s.input), values: acc(s.output) };
  }
  return { json, tracks };
}

module.exports = {
  MIXAMO_TO_VRM, VRM_REQUIRED, VRM_PARENT, stripMixamo, vrmBoneOf, mirrorBone,
  qmul, qinv, qnorm, qslerp, qangle, retargetQ, mirrorQ,
  sampleTrack, trimClip, holdClip, loopClip, qEuler, poseClip, offsetClip, uprightClip, seamAngle, seamBlend, SEAM_SPEED, mirrorClip, amplitudeClip, inPlaceClip, centerClip, bakeParams,
  writeVrma, readVrma, glb,
};
