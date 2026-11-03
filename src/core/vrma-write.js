'use strict';
// The .vrma writer and the quaternion maths it needs, shared by the motion bake (scripts/lib/vrm-bake-core.js,
// which re-exports all of this) and the dance bake (src/core/vmd-retarget.js, docs/vrm-dance.md §2.1). No three.js
// and nothing from the script folder, so the main process can bake an imported dance in an installed app.
//
// Quaternions are [x, y, z, w] arrays, like three's toArray().

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
// a vector turned by a rotation
function qrot(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
// a rotation of `rad` about a unit axis
const qaxis = (axis, rad) => { const s = Math.sin(rad / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)]; };

// ---------- the humanoid tree ----------
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

// ---------- the .vrma writer ----------
// clip = { duration, bones: { vrmBone: { times, values: [x,y,z,w][] } }, hips: { times, values: [x,y,z][] } | null
//          (metres, world axes), restHipsY (metres), rest: { vrmBone: [x,y,z] world rest positions },
//          expressions?: { presetName: { times, values: number[] (weights 0..1) } } }
// → GLB bytes (Buffer). Nodes: the humanoid bones at their rest positions (identity rotations, as the VRMA spec's
// T-pose) plus one node per expression (VRMC_vrm_animation: its translation.x is the weight); channels: rotation
// of every bone, translation of hips, translation of every expression node.
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
  const exprNames = Object.keys(clip.expressions || {}).filter((e) => clip.expressions[e] && clip.expressions[e].times.length);
  const exprIdx = {};
  for (const e of exprNames) { exprIdx[e] = nodes.length; nodes.push({ name: `expression.${e}` }); }

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
    if (minmax) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
      acc.min = [lo];
      acc.max = [hi];
    }
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
  for (const e of exprNames) {
    const tr = clip.expressions[e];
    samplers.push({ input: timesAcc(tr.times), output: addAccessor(tr.values.flatMap((w) => [w, 0, 0]), 'VEC3'), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node: exprIdx[e], path: 'translation' } });
  }
  const bin = Buffer.concat(chunks);
  const ext = { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(order.map((b) => [b, { node: idx[b] }])) } };
  if (exprNames.length) ext.expressions = { preset: Object.fromEntries(exprNames.map((e) => [e, { node: exprIdx[e] }])) };
  const json = {
    asset: { version: '2.0', generator },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: ext },
    scene: 0,
    scenes: [{ nodes: [idx.hips, ...exprNames.map((e) => exprIdx[e])] }],
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

module.exports = { qmul, qinv, qnorm, qdot, qslerp, qangle, qrot, qaxis, VRM_PARENT, presentParent, writeVrma, readVrma, glb };
