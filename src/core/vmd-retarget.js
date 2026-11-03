'use strict';
// MMD dance (.vmd) → VRM humanoid clip → .vrma (docs/vrm-dance.md §2). Pure JS, no three: the main process bakes
// an imported dance with it (a worker thread) and scripts/vrm-bake.js --dance runs the same function.
//
// Steps, per output frame (30 fps, the VMD's own rate):
//   1. every MMD bone sampled along its Bézier curves (src/core/vmd.js) and turned into right-handed axes
//      (§2.6: mirror on the Z plane, position (x, y, −z), rotation (−x, −y, z, w); the model then faces +Z with
//      her left at +X, like VRM 1.0 / glTF);
//   2. the root chain 全ての親 → センター → グルーブ → 腰 → 下半身 run as FK on a reference MMD skeleton (MMD_REF)
//      → the hips rotation and position (§2.3, §2.6);
//   3. the hips' slow horizontal drift softly limited (§3.6), the same shift given to both foot IK targets;
//   4. the legs: two-bone analytic IK towards 足ＩＫ (knee a forward-bending hinge, the ankle aimed at
//      つま先ＩＫ and rolled like the IK bone), or the FK keys when the IK is off / never animated (§2.5);
//   5. the rest mapped onto VRM bones (§2.3): 上半身 under 下半身, twist bones folded into the arm bones, the arm
//      chain carried from MMD's A-pose rest into VRM's T-pose (§2.4);
//   6. morphs mapped onto VRM expression presets (§2.9).
// The result is the clip shape of src/core/vrma-write.js; hips positions in metres at 0.08 m per MMD unit, with
// the reference skeleton's hips height as the clip's rest height, so createVRMAnimationClip scales the travel to
// any model's own hips height.
//
// Written from the MMD bone semantics and quaternion maths; nothing here comes from another project's code.

const V = require('./vmd');
const W = require('./vrma-write');

const { qmul, qinv, qnorm, qslerp, qangle, qrot } = W;
const BAKED_WITH = 'vmd-retarget@1';
const UNIT = 0.08; // metres per MMD unit (a 158 cm model is about 20 units tall)
const ID = [0, 0, 0, 1];

// ---------- vectors ----------
const vadd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vscale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// MMD axes → ours (§2.6)
const toRH = (p) => [p[0], p[1], -p[2]];
const qToRH = (q) => [-q[0], -q[1], q[2], q[3]];

// The rotation taking unit vector a onto unit vector b (shortest arc).
function qfromTo(a, b) {
  const d = vdot(a, b);
  if (d < -0.999999) {
    const ax = vnorm(Math.abs(a[0]) < 0.9 ? vcross(a, [1, 0, 0]) : vcross(a, [0, 1, 0]));
    return [ax[0], ax[1], ax[2], 0];
  }
  const c = vcross(a, b);
  return qnorm([c[0], c[1], c[2], 1 + d]);
}
// The rotation taking the orthonormal frame (x0, y0, x0×y0) onto (x1, y1, x1×y1).
function qfromFrames(x0, y0, x1, y1) {
  const z0 = vcross(x0, y0);
  const z1 = vcross(x1, y1);
  // R = M1 · M0ᵀ, columns are the frame axes
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const A = [x0, y0, z0];
  const B = [x1, y1, z1];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r][c] = B[0][r] * A[0][c] + B[1][r] * A[1][c] + B[2][r] * A[2][c];
  return qFromMatrix(m);
}
function qFromMatrix(m) {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let q;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, 0.25 * s]; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s]; }
  else if (m[1][1] > m[2][2]) { const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s]; }
  else { const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s, (m[1][0] - m[0][1]) / s]; }
  return qnorm(q);
}
// a rotation limited to `deg` from the identity
function qclamp(q, deg) {
  const a = qangle(q, ID);
  return a > deg ? qslerp(ID, q, deg / a) : q;
}

// ---------- the reference MMD skeleton (§2.4) ----------
// Rest positions in MMD units and MMD axes, proportioned like the standard Tda-style MMD model most of the
// dances were made on (≈ 20 units tall). Used for the arm A-pose angle, the leg IK and the rest hips height.
const L = (x, y, z) => [x, y, z];
const MMD_REF = {
  全ての親: { p: L(0, 0, 0), parent: null },
  センター: { p: L(0, 8.0, 0), parent: '全ての親' },
  グルーブ: { p: L(0, 8.2, 0), parent: 'センター' },
  腰: { p: L(0, 11.6, 0.4), parent: 'グルーブ' },
  下半身: { p: L(0, 11.8, 0.3), parent: '腰' },
  上半身: { p: L(0, 11.8, 0.3), parent: '腰' },
  上半身2: { p: L(0, 13.1, 0.2), parent: '上半身' },
  上半身3: { p: L(0, 14.4, 0.25), parent: '上半身2' },
  首: { p: L(0, 16.3, 0.4), parent: '上半身3' },
  頭: { p: L(0, 17.1, 0.15), parent: '首' },
};
for (const [s, k] of [['左', 1], ['右', -1]]) {
  const x = (v) => v * k;
  Object.assign(MMD_REF, {
    [`${s}足`]: { p: L(x(0.95), 10.7, 0.3), parent: '下半身' },
    [`${s}ひざ`]: { p: L(x(1.05), 6.05, 0.42), parent: `${s}足` }, // on the hip–ankle line: the rest leg is straight
    [`${s}足首`]: { p: L(x(1.15), 1.25, 0.55), parent: `${s}ひざ` },
    [`${s}つま先`]: { p: L(x(1.2), 0.05, -1.0), parent: `${s}足首` },
    [`${s}足IK親`]: { p: L(x(1.15), 0, 0.55), parent: '全ての親' },
    [`${s}足IK`]: { p: L(x(1.15), 1.25, 0.55), parent: `${s}足IK親` },
    [`${s}つま先IK`]: { p: L(x(1.2), 0.05, -1.0), parent: `${s}足IK` },
    [`${s}肩`]: { p: L(x(0.3), 15.6, 0.45), parent: '上半身3' },
    [`${s}腕`]: { p: L(x(1.35), 15.35, 0.5), parent: `${s}肩` },
    [`${s}ひじ`]: { p: L(x(3.25), 13.85, 0.6), parent: `${s}腕` },
    [`${s}手首`]: { p: L(x(4.95), 12.5, 0.6), parent: `${s}ひじ` },
    [`${s}親指0`]: { p: L(x(5.15), 12.3, 0.2), parent: `${s}手首` },
    [`${s}親指1`]: { p: L(x(5.45), 12.0, -0.05), parent: `${s}親指0` },
    [`${s}親指2`]: { p: L(x(5.7), 11.75, -0.2), parent: `${s}親指1` },
  });
  ['人指', '中指', '薬指', '小指'].forEach((f, i) => {
    const z = 0.25 - i * 0.22;
    MMD_REF[`${s}${f}1`] = { p: L(x(5.6), 11.95, z + 0.1), parent: `${s}手首` };
    MMD_REF[`${s}${f}2`] = { p: L(x(5.95), 11.67, z + 0.1), parent: `${s}${f}1` };
    MMD_REF[`${s}${f}3`] = { p: L(x(6.2), 11.47, z + 0.1), parent: `${s}${f}2` };
  });
}
// in our axes
const REF = Object.fromEntries(Object.entries(MMD_REF).map(([n, b]) => [n, toRH(b.p)]));
const refOffset = (n) => { const b = MMD_REF[n]; return b.parent ? vsub(REF[n], REF[b.parent]) : REF[n].slice(); };

// The arm chain's A-pose: the rotation that takes the T-pose arm (along ±X) onto the reference 腕→ひじ line.
function aPose(side) {
  const s = side === 'left' ? '左' : '右';
  const dir = vnorm(vsub(REF[`${s}ひじ`], REF[`${s}腕`]));
  return qfromTo([side === 'left' ? 1 : -1, 0, 0], dir);
}
const A_POSE = { left: aPose('left'), right: aPose('right') };
const aPoseDeg = (side) => qangle(A_POSE[side], ID);

// ---------- the bone map (§2.3) ----------
const SIDES = [['left', '左'], ['right', '右']];
const FINGER_MAP = {}; // MMD finger bone → VRM bone
for (const [s, j] of SIDES) {
  FINGER_MAP[`${j}親指0`] = `${s}ThumbMetacarpal`;
  FINGER_MAP[`${j}親指1`] = `${s}ThumbProximal`;
  FINGER_MAP[`${j}親指2`] = `${s}ThumbDistal`;
  for (const [mf, vf] of [['人指', 'Index'], ['中指', 'Middle'], ['薬指', 'Ring'], ['小指', 'Little']]) {
    FINGER_MAP[`${j}${mf}1`] = `${s}${vf}Proximal`;
    FINGER_MAP[`${j}${mf}2`] = `${s}${vf}Intermediate`;
    FINGER_MAP[`${j}${mf}3`] = `${s}${vf}Distal`;
  }
}
// Every MMD bone the bake reads, with what it becomes (for the report and the tests). Names are normalised
// (vmd.normName: ＩＫ → IK, ０ → 0).
const BONE_ROLE = {
  全ての親: 'hips (root)', センター: 'hips', グルーブ: 'hips', 腰: 'hips', 下半身: 'hips',
  上半身: 'spine', 上半身1: 'spine', 上半身2: 'chest', 上半身3: 'upperChest', 首: 'neck', 頭: 'head',
};
for (const [s, j] of SIDES) {
  const S = s;
  Object.assign(BONE_ROLE, {
    [`${j}肩P`]: `${S}Shoulder`, [`${j}肩`]: `${S}Shoulder`,
    [`${j}腕`]: `${S}UpperArm`, [`${j}腕捩`]: `${S}UpperArm`,
    [`${j}ひじ`]: `${S}LowerArm`, [`${j}手捩`]: `${S}LowerArm`,
    [`${j}手首`]: `${S}Hand`,
    [`${j}足`]: `${S}UpperLeg`, [`${j}ひざ`]: `${S}LowerLeg`, [`${j}足首`]: `${S}Foot`, [`${j}つま先`]: `${S}Toes`,
    [`${j}足D`]: `${S}UpperLeg`, [`${j}ひざD`]: `${S}LowerLeg`, [`${j}足首D`]: `${S}Foot`, [`${j}足先EX`]: `${S}Toes`,
    [`${j}足IK`]: `${S}Foot (IK target)`, [`${j}つま先IK`]: `${S}Foot (IK target)`, [`${j}足IK親`]: `${S}Foot (IK target)`,
  });
}
Object.assign(BONE_ROLE, FINGER_MAP);
// Read and deliberately not used (§2.3): the eyes (the gaze layer owns them), the waist cancel and shoulder
// cancel helpers, the tips.
const BONE_IGNORED = new Set(['両目', '左目', '右目', '腰キャンセル左', '腰キャンセル右', '左肩C', '右肩C']);

// VRM bones written by every dance (all of them get a track: vrm-anim.js wants every clip to pose every bone)
const VRM_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  ...SIDES.flatMap(([s]) => [`${s}Shoulder`, `${s}UpperArm`, `${s}LowerArm`, `${s}Hand`, `${s}UpperLeg`, `${s}LowerLeg`, `${s}Foot`, `${s}Toes`]),
  ...Object.values(FINGER_MAP)];

// VRM rest positions (metres, T-pose: the arm chain turned up out of the A-pose about the shoulder joint; the
// reference hips over the origin, like the hips track)
function vrmRest() {
  const at = { hips: '下半身', spine: '上半身', chest: '上半身2', upperChest: '上半身3', neck: '首', head: '頭' };
  for (const [s, j] of SIDES) Object.assign(at, { [`${s}Shoulder`]: `${j}肩`, [`${s}UpperArm`]: `${j}腕`, [`${s}LowerArm`]: `${j}ひじ`, [`${s}Hand`]: `${j}手首`, [`${s}UpperLeg`]: `${j}足`, [`${s}LowerLeg`]: `${j}ひざ`, [`${s}Foot`]: `${j}足首`, [`${s}Toes`]: `${j}つま先` });
  for (const [m, v] of Object.entries(FINGER_MAP)) at[v] = m;
  const rest = {};
  for (const [v, m] of Object.entries(at)) {
    let p = REF[m];
    const side = v.startsWith('left') ? 'left' : v.startsWith('right') ? 'right' : null;
    const armChain = side && !/Shoulder|Leg|Foot|Toes/.test(v);
    if (armChain) { const pivot = REF[`${side === 'left' ? '左' : '右'}腕`]; p = vadd(pivot, qrot(qinv(A_POSE[side]), vsub(p, pivot))); }
    rest[v] = vscale([p[0] - REF.下半身[0], p[1], p[2] - REF.下半身[2]], UNIT); // the hips over the origin
  }
  return rest;
}
const VRM_REST = vrmRest();
const REST_HIPS_Y = VRM_REST.hips[1];

// ---------- expressions (§2.9) ----------
// MMD morph → [VRM preset, weight factor]. Several morphs on one preset: the strongest wins.
const MORPH_MAP = {
  あ: ['aa', 1], い: ['ih', 1], う: ['ou', 1], え: ['ee', 1], お: ['oh', 1],
  まばたき: ['blink', 1],
  ウィンク: ['blinkLeft', 1], ウィンク2: ['blinkLeft', 1], ウィンク右: ['blinkRight', 1], ウィンク2右: ['blinkRight', 1],
  笑い: ['happy', 0.6], にこり: ['happy', 1], にっこり: ['happy', 1],
  怒り: ['angry', 0.7], 困る: ['sad', 0.6],
};

// ---------- leg IK (§2.5) ----------
// Two-bone analytic IK on the reference leg. hip: the hip joint (world); target: where the ankle should be;
// pole: the direction the knee should face (the leg's FK forward); rest: { hip, knee, ankle } rest positions.
// The knee is a hinge that only bends forward: it is placed in the plane of hip→target and the pole, on the pole's
// side. Returns the world rotations of thigh and shin (relative to their rest), the knee and the ankle reached.
function solveLegIK({ hip, target, pole, rest }) {
  const a = vlen(vsub(rest.knee, rest.hip));
  const b = vlen(vsub(rest.ankle, rest.knee));
  const toT = vsub(target, hip);
  const dist = vlen(toT);
  const lo = Math.abs(a - b) + 1e-4 * (a + b);
  const hi = (a + b) * (1 - 1e-6);
  const d = Math.min(hi, Math.max(lo, dist));
  const dir = dist > 1e-9 ? vscale(toT, 1 / dist) : [0, -1, 0];
  let fwd = vsub(pole, vscale(dir, vdot(pole, dir)));
  if (vlen(fwd) < 1e-6) { const alt = Math.abs(dir[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]; fwd = vsub(alt, vscale(dir, vdot(alt, dir))); }
  fwd = vnorm(fwd);
  const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const knee = vadd(hip, vadd(vscale(dir, a * cosA), vscale(fwd, a * sinA)));
  const ankle = vadd(hip, vscale(dir, d));
  const side = vnorm(vcross(dir, fwd)); // the knee's hinge axis
  // rest frames: bone direction + the hinge axis of the straight-ahead rest leg
  const restSide = (u) => vnorm(vcross(u, vnorm(vsub([0, 0, 1], vscale(u, u[2])))));
  const u0 = vnorm(vsub(rest.knee, rest.hip));
  const s0 = vnorm(vsub(rest.ankle, rest.knee));
  const thigh = qfromFrames(u0, restSide(u0), vnorm(vsub(knee, hip)), side);
  const shin = qfromFrames(s0, restSide(s0), vnorm(vsub(ankle, knee)), side);
  return { thigh, shin, knee, ankle, reach: dist <= hi && dist >= lo, a, b, dist };
}

// ---------- the bake ----------
const DEFAULTS = {
  fps: 30,
  face: true, // expression tracks from the morphs
  stage: { radius: 0.15, rhythm: 0.35, window: 2 }, // §3.6, in hips heights / seconds; stage: false keeps the travel
  staticDeg: 0.05, // a key within this of both neighbours is dropped
  fingerTolDeg: 0.2, // finger keys thinned to this when the dance is longer than thinAfter seconds
  thinAfter: 120,
  ankleLimit: 60,
};

// Finger curl when the dance has no finger keys (the L4 relaxed hand, core/vrm-life.js: handPose × 4 degrees)
const RELAX_DEG = 0.38 * 4;
const qz = (deg) => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];

// vmd (parsed) or Buffer → { clip, report }
function retargetVmd(input, options = {}) {
  const o = { ...DEFAULTS, ...options, stage: options.stage === false ? false : { ...DEFAULTS.stage, ...(options.stage || {}) } };
  const vmd = Buffer.isBuffer(input) || input instanceof Uint8Array ? V.parseVmd(input) : input;
  const kind = V.classifyVmd(vmd);
  if (kind !== 'motion') throw Object.assign(new Error(kind === 'camera' ? 'this VMD is a camera motion, not a dance' : kind === 'prop' ? 'this VMD moves a prop, not a person' : 'this VMD has no motion in it'), { code: `vmd-${kind}` });
  const keys = V.groupKeys(vmd.bones);
  const morphKeys = V.groupKeys(vmd.morphs);
  const last = V.lastFrame(vmd);
  const step = 30 / o.fps;
  const nFrames = Math.floor(last / step) + 1;
  const frameAt = (i) => Math.min(last, i * step);

  // which bones move at all (a single key at rest is the export's placeholder)
  const moves = (name) => {
    const k = keys.get(name);
    if (!k || !k.length) return false;
    if (k.length > 1) return k.some((x) => vlen(vsub(x.pos, k[0].pos)) > 1e-4 || qangle(x.rot, k[0].rot) > 0.01) || vlen(k[0].pos) > 1e-4 || qangle(k[0].rot, ID) > 0.01;
    return vlen(k[0].pos) > 1e-4 || qangle(k[0].rot, ID) > 0.01;
  };
  const samplers = new Map();
  const sampleRaw = (name, f) => {
    if (!keys.has(name)) return null;
    if (!samplers.has(name)) samplers.set(name, V.boneSampler(keys.get(name)));
    return samplers.get(name)(f);
  };
  // a bone's pose at frame f in our axes: { pos, rot } (identity / zero when it has no keys)
  const pose = (name, f) => { const s = sampleRaw(name, f); return s ? { pos: toRH(s.pos), rot: qnorm(qToRH(s.rot)) } : { pos: [0, 0, 0], rot: ID }; };
  const rot = (name, f) => pose(name, f).rot;

  // the leg mode per side (§2.5): the file's IK switches; IK bones never animated while the FK legs are → FK
  const ikFrames = (vmd.ik || []).slice().sort((x, y) => x.frame - y.frame);
  const legMode = {};
  for (const [s, j] of SIDES) {
    const ikAnimated = moves(`${j}足IK`) || moves(`${j}足IK親`);
    const fkAnimated = moves(`${j}足`) || moves(`${j}ひざ`);
    legMode[s] = { bakedFk: !ikAnimated && fkAnimated, ik: `${j}足IK`, toe: `${j}つま先IK` };
  }
  // the IK switches are a step function of the frame (MMD's default: on)
  const ikOnAt = (name, f) => { const v = V.ikEnabled(ikFrames, name, f); return v === undefined ? true : v; };

  // ----- pass 1: the root chain → hips; the IK targets -----
  const fk = (parentW, name, f) => {
    const ps = pose(name, f);
    const off = vadd(refOffset(name), ps.pos);
    return { p: vadd(parentW.p, qrot(parentW.q, off)), q: qnorm(qmul(parentW.q, ps.rot)) };
  };
  const frames = [];
  for (let i = 0; i < nFrames; i++) {
    const f = frameAt(i);
    const root = fk({ p: [0, 0, 0], q: ID }, '全ての親', f);
    const center = fk(root, 'センター', f);
    const groove = fk(center, 'グルーブ', f);
    const waist = fk(groove, '腰', f);
    const lower = fk(waist, '下半身', f);
    const upper = fk(waist, '上半身', f);
    const fr = { f, root, hips: lower, upper, legs: {} };
    for (const [s, j] of SIDES) {
      const ikParent = fk(root, `${j}足IK親`, f);
      const ik = fk(ikParent, `${j}足IK`, f);
      const toe = fk(ik, `${j}つま先IK`, f);
      fr.legs[s] = { ik, toe: toe.p, ikOn: !legMode[s].bakedFk && ikOnAt(legMode[s].ik, f), toeOn: ikOnAt(legMode[s].toe, f) };
    }
    frames.push(fr);
  }

  // ----- pass 2: the stage limit (§3.6) -----
  const restHipsXZ = [REF.下半身[0], REF.下半身[2]];
  const hipsH = REF.下半身[1];
  let clampHits = 0;
  let maxDrift = 0;
  const shift = frames.map(() => [0, 0]);
  if (o.stage) {
    const R = o.stage.radius * hipsH;
    const rhythmMax = o.stage.rhythm * hipsH;
    const half = Math.round((o.stage.window * o.fps) / 2);
    const xs = frames.map((fr) => fr.hips.p[0] - restHipsXZ[0]);
    const zs = frames.map((fr) => fr.hips.p[2] - restHipsXZ[1]);
    // centred moving average with prefix sums
    const pre = (arr) => { const p = [0]; for (const v of arr) p.push(p[p.length - 1] + v); return p; };
    const px = pre(xs);
    const pz = pre(zs);
    for (let i = 0; i < frames.length; i++) {
      const a = Math.max(0, i - half);
      const b = Math.min(frames.length - 1, i + half);
      const n = b - a + 1;
      const mx = (px[b + 1] - px[a]) / n;
      const mz = (pz[b + 1] - pz[a]) / n;
      const m = Math.hypot(mx, mz);
      maxDrift = Math.max(maxDrift, Math.hypot(xs[i], zs[i]));
      const k = m > 1e-9 ? (R * Math.tanh(m / R)) / m : 1;
      let rx = xs[i] - mx;
      let rz = zs[i] - mz;
      const rl = Math.hypot(rx, rz);
      if (rl > rhythmMax) { rx *= rhythmMax / rl; rz *= rhythmMax / rl; }
      const nx = rx + mx * k;
      const nz = rz + mz * k;
      shift[i] = [nx - xs[i], nz - zs[i]];
      if (Math.hypot(shift[i][0], shift[i][1]) > 0.01 * hipsH) clampHits++;
    }
  }

  // ----- pass 3: every VRM bone -----
  const tracks = Object.fromEntries(VRM_BONES.map((b) => [b, []]));
  const hipsPos = [];
  const ikStats = { frames: 0, unreachable: 0, maxError: 0, reachMax: 0, kneeMinDeg: Infinity, kneeMaxDeg: -Infinity };
  const hasFingers = {};
  for (const [s, j] of SIDES) hasFingers[s] = Object.keys(FINGER_MAP).some((m) => m.startsWith(j) && keys.has(m));
  let modeCount = { ik: 0, fk: 0 };
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    const { f } = fr;
    const sh = [shift[i][0], 0, shift[i][1]];
    const H = fr.hips.q;
    const hipsP = vadd(fr.hips.p, sh);
    hipsPos.push(vscale([hipsP[0] - REF.下半身[0], hipsP[1], hipsP[2] - REF.下半身[2]], UNIT)); // standing still = on the origin
    tracks.hips.push(H);
    // the upper body: 上半身 is 下半身's sibling in MMD, spine is the hips' child in VRM
    // (上半身1, an extra segment some models put between 上半身 and 上半身2, folds into the spine)
    tracks.spine.push(qnorm(qmul(qmul(qinv(H), fr.upper.q), rot('上半身1', f))));
    tracks.chest.push(rot('上半身2', f));
    tracks.upperChest.push(rot('上半身3', f));
    tracks.neck.push(rot('首', f));
    tracks.head.push(rot('頭', f));
    for (const [s, j] of SIDES) {
      const A = A_POSE[s];
      const Ai = qinv(A);
      const conj = (q) => qnorm(qmul(qmul(Ai, q), A));
      tracks[`${s}Shoulder`].push(qnorm(qmul(rot(`${j}肩P`, f), rot(`${j}肩`, f))));
      tracks[`${s}UpperArm`].push(qnorm(qmul(qmul(rot(`${j}腕`, f), rot(`${j}腕捩`, f)), A)));
      tracks[`${s}LowerArm`].push(conj(qmul(rot(`${j}ひじ`, f), rot(`${j}手捩`, f))));
      tracks[`${s}Hand`].push(conj(rot(`${j}手首`, f)));
      for (const [m, v] of Object.entries(FINGER_MAP)) {
        if (!m.startsWith(j)) continue;
        tracks[v].push(hasFingers[s] ? conj(rot(m, f)) : qz((s === 'left' ? -1 : 1) * RELAX_DEG * (v.includes('Thumb') ? 0.5 : 1)));
      }
      // legs
      const leg = fr.legs[s];
      const fkThigh = rot(`${j}足`, f);
      const fkShin = rot(`${j}ひざ`, f);
      const fkFoot = rot(`${j}足首`, f);
      let upperLeg;
      let lowerLeg;
      let foot;
      if (leg.ikOn) {
        modeCount.ik++;
        const restHip = REF[`${j}足`];
        const hipW = vadd(hipsP, qrot(H, vsub(restHip, REF.下半身)));
        const target = vadd(leg.ik.p, sh);
        const pole = qrot(qmul(H, fkThigh), [0, 0, 1]);
        const r = solveLegIK({ hip: hipW, target, pole, rest: { hip: restHip, knee: REF[`${j}ひざ`], ankle: REF[`${j}足首`] } });
        upperLeg = qnorm(qmul(qinv(H), r.thigh));
        lowerLeg = qnorm(qmul(qinv(r.thigh), r.shin));
        // the ankle: aim 足首→つま先 at the toe target, roll like the IK bone
        let footW;
        if (leg.toeOn) {
          const restFoot = vsub(REF[`${j}つま先`], REF[`${j}足首`]);
          const cur = vnorm(qrot(r.shin, restFoot));
          const want = vnorm(vsub(vadd(leg.toe, sh), r.ankle));
          footW = qnorm(qmul(qfromTo(cur, want), r.shin));
          const upWant = qrot(leg.ik.q, [0, 1, 0]);
          const upHave = qrot(footW, [0, 1, 0]);
          const pw = vsub(upWant, vscale(want, vdot(upWant, want)));
          const ph = vsub(upHave, vscale(want, vdot(upHave, want)));
          if (vlen(pw) > 1e-3 && vlen(ph) > 1e-3) footW = qnorm(qmul(qfromTo(vnorm(ph), vnorm(pw)), footW));
          foot = qclamp(qnorm(qmul(qinv(r.shin), footW)), o.ankleLimit);
        } else foot = fkFoot;
        // the check: FK of the result lands on the target
        ikStats.frames++;
        ikStats.reachMax = Math.max(ikStats.reachMax, r.dist / (r.a + r.b));
        if (!r.reach) ikStats.unreachable++;
        else {
          const reached = vadd(vadd(hipW, qrot(r.thigh, vsub(REF[`${j}ひざ`], restHip))), qrot(r.shin, vsub(REF[`${j}足首`], REF[`${j}ひざ`])));
          ikStats.maxError = Math.max(ikStats.maxError, vlen(vsub(reached, target)) * UNIT);
        }
      } else {
        modeCount.fk++;
        upperLeg = fkThigh;
        lowerLeg = fkShin;
        foot = fkFoot;
      }
      // the knee: bending forward is a positive turn about x (the shin swings back)
      const kx = 2 * Math.asin(Math.max(-1, Math.min(1, lowerLeg[0] * Math.sign(lowerLeg[3] || 1)))) * (180 / Math.PI);
      ikStats.kneeMinDeg = Math.min(ikStats.kneeMinDeg, kx);
      ikStats.kneeMaxDeg = Math.max(ikStats.kneeMaxDeg, kx);
      // the D bones add on top (§2.3)
      tracks[`${s}UpperLeg`].push(qnorm(qmul(upperLeg, rot(`${j}足D`, f))));
      tracks[`${s}LowerLeg`].push(qnorm(qmul(lowerLeg, rot(`${j}ひざD`, f))));
      tracks[`${s}Foot`].push(qnorm(qmul(foot, rot(`${j}足首D`, f))));
      tracks[`${s}Toes`].push(qnorm(qmul(rot(`${j}つま先`, f), rot(`${j}足先EX`, f)))); // 足先EX: the toe of semi-standard rigs
    }
  }

  // ----- expressions -----
  const exprRaw = {};
  const morphUsed = [];
  const morphUnmapped = [];
  for (const [name, list] of morphKeys) {
    const m = MORPH_MAP[name];
    const animated = list.some((k) => k.weight > 1e-3);
    if (!m) { if (animated) morphUnmapped.push(name); continue; }
    if (!animated) continue;
    morphUsed.push(name);
    if (!o.face) continue;
    const smp = V.morphSampler(list);
    const arr = exprRaw[m[0]] || (exprRaw[m[0]] = new Array(nFrames).fill(0));
    for (let i = 0; i < nFrames; i++) arr[i] = Math.max(arr[i], Math.min(1, Math.max(0, smp(frameAt(i)) * m[1])));
  }

  // ----- keys out, thinned -----
  const times = frames.map((_, i) => +(i / o.fps).toFixed(6));
  const duration = times[times.length - 1] || 0;
  const thin = (vals, same) => {
    const t = [];
    const v = [];
    for (let i = 0; i < vals.length; i++) {
      if (i > 0 && i < vals.length - 1 && same(vals[i - 1], vals[i]) && same(vals[i], vals[i + 1])) continue;
      t.push(times[i]);
      v.push(vals[i]);
    }
    if (t.length === 1) { t.push(duration || 1 / o.fps); v.push(v[0]); } // a track has two keys at least
    return { times: t, values: v };
  };
  // greedy: drop keys a straight slerp between the neighbours kept would rebuild within tol
  const reduce = (tr, tolDeg) => {
    if (tr.times.length < 3) return tr;
    const t = [tr.times[0]];
    const v = [tr.values[0]];
    let a = 0;
    for (let i = 1; i < tr.times.length - 1; i++) {
      const b = i + 1;
      let ok = true;
      for (let k = a + 1; k <= i && ok; k++) {
        const w = (tr.times[k] - tr.times[a]) / (tr.times[b] - tr.times[a]);
        if (qangle(qslerp(tr.values[a], tr.values[b], w), tr.values[k]) > tolDeg) ok = false;
      }
      if (!ok) { t.push(tr.times[i]); v.push(tr.values[i]); a = i; }
    }
    t.push(tr.times[tr.times.length - 1]);
    v.push(tr.values[tr.values.length - 1]);
    return { times: t, values: v };
  };
  const sameQ = (x, y) => qangle(x, y) < o.staticDeg;
  const bones = {};
  for (const [b, vals] of Object.entries(tracks)) {
    let tr = thin(vals, sameQ);
    if (duration > o.thinAfter && /Thumb|Index|Middle|Ring|Little/.test(b)) tr = reduce(tr, o.fingerTolDeg);
    bones[b] = tr;
  }
  const hips = thin(hipsPos, (x, y) => vlen(vsub(x, y)) < 1e-4);
  const expressions = {};
  for (const [e, arr] of Object.entries(exprRaw)) expressions[e] = thin(arr, (x, y) => Math.abs(x - y) < 1e-3);
  const clip = { duration, bones, hips, restHipsY: REST_HIPS_Y, rest: VRM_REST, expressions };

  // ----- the report (§2.10) -----
  const mapped = [];
  const ignored = [];
  const unmapped = [];
  for (const name of keys.keys()) {
    if (BONE_ROLE[name]) { if (moves(name) || keys.get(name).length > 1) mapped.push(name); }
    else if (BONE_IGNORED.has(name)) ignored.push(name);
    else if (moves(name)) unmapped.push(name);
  }
  const animated = VRM_BONES.filter((b) => tracks[b].some((q) => qangle(q, tracks[b][0]) > 0.5));
  const ext = extentOf(clip, frames.length, o.fps);
  const ik = modeCount.ik && modeCount.fk ? 'mixed' : modeCount.ik ? 'on' : 'fk';
  const report = {
    bakedWith: BAKED_WITH,
    modelName: vmd.modelName,
    duration: +duration.toFixed(3),
    frames: nFrames,
    fps: o.fps,
    source: { boneKeys: vmd.bones.length, morphKeys: vmd.morphs.length, lastFrame: last, bones: keys.size, morphs: morphKeys.size, ikSwitchFrames: ikFrames.length },
    bones: { mapped: mapped.sort(), ignored: ignored.sort(), unmapped: unmapped.sort(), vrm: VRM_BONES.length, animated },
    ik,
    legs: Object.fromEntries(SIDES.map(([s]) => [s, legMode[s].bakedFk ? 'fk (IK never animated)' : 'ik'])),
    ikStats: {
      frames: ikStats.frames,
      unreachable: ikStats.frames ? +(ikStats.unreachable / ikStats.frames).toFixed(4) : 0,
      maxErrorMm: +(ikStats.maxError * 1000).toFixed(3),
      reachMax: +ikStats.reachMax.toFixed(3), // the farthest target, in leg lengths (> 1: stretched straight)
      kneeMinDeg: +ikStats.kneeMinDeg.toFixed(2),
      kneeMaxDeg: +ikStats.kneeMaxDeg.toFixed(2),
    },
    aPoseDeg: { left: +aPoseDeg('left').toFixed(2), right: +aPoseDeg('right').toFixed(2) },
    stage: o.stage ? { radius: o.stage.radius, clampHits: +(clampHits / frames.length).toFixed(4), maxDriftM: +(maxDrift * UNIT).toFixed(3) } : null,
    extent: ext.extent,
    ground: ext.ground,
    face: Object.keys(expressions).length > 0,
    expressions: Object.keys(expressions).sort(),
    morphs: { mapped: morphUsed.sort(), unmapped: morphUnmapped.sort() },
    fingers: Object.fromEntries(SIDES.map(([s]) => [s, hasFingers[s] ? 'keys' : 'relaxed'])),
    keys: Object.values(bones).reduce((n, tr) => n + tr.times.length, 0) + hips.times.length,
  };
  return { clip, report };
}

// FK of the VRM side of a clip (reference rest): head and hands above / beside the stage centre and the lowest
// ankle, in hips heights (§2.10: the dance camera frames by these; the ground offset).
function extentOf(clip, n, fps = 30) {
  const at = (b, i) => W.qnorm(sampleAt(clip.bones[b], i / fps));
  const sampleAt = (tr, t) => {
    const { times, values } = tr;
    if (t <= times[0]) return values[0];
    if (t >= times[times.length - 1]) return values[values.length - 1];
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
    return qslerp(values[lo], values[hi], (t - times[lo]) / (times[hi] - times[lo]));
  };
  const hipsAt = (t) => {
    const { times, values } = clip.hips;
    if (t <= times[0]) return values[0];
    if (t >= times[times.length - 1]) return values[values.length - 1];
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
    const k = (t - times[lo]) / (times[hi] - times[lo]);
    return values[lo].map((v, j) => v + (values[hi][j] - v) * k);
  };
  const R = clip.rest;
  const H = clip.restHipsY;
  let up = 0;
  let side = 0;
  const lows = [];
  const chain = (i, list) => {
    let p = hipsAt(i / fps);
    let q = at('hips', i);
    let prev = 'hips';
    for (const b of list) {
      p = vadd(p, qrot(q, vsub(R[b], R[prev])));
      q = qmul(q, at(b, i));
      prev = b;
    }
    return p;
  };
  const stride = Math.max(1, Math.floor(n / 600)); // ≤ 600 samples
  for (let i = 0; i < n; i += stride) {
    const pts = [
      chain(i, ['spine', 'chest', 'upperChest', 'neck', 'head']),
      chain(i, ['spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand']),
      chain(i, ['spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']),
    ];
    for (const p of pts) { up = Math.max(up, (p[1] - H) / H); side = Math.max(side, Math.abs(p[0]) / H); }
    const la = chain(i, ['leftUpperLeg', 'leftLowerLeg', 'leftFoot']);
    const ra = chain(i, ['rightUpperLeg', 'rightLowerLeg', 'rightFoot']);
    lows.push(Math.min(la[1], ra[1]) - R.leftFoot[1]);
  }
  lows.sort((x, y) => x - y);
  return { extent: { up: +up.toFixed(3), side: +side.toFixed(3) }, ground: +(lows[Math.floor(lows.length * 0.05)] / H || 0).toFixed(4) };
}

// vmd Buffer → { vrma: Buffer, report, clip }
function bakeVmd(input, options = {}) {
  const { clip, report } = retargetVmd(input, options);
  const vrma = W.writeVrma(clip, { name: options.name || 'dance', generator: `pixel-pet ${BAKED_WITH}` });
  report.bytes = vrma.length;
  return { vrma, report, clip };
}

module.exports = {
  BAKED_WITH, UNIT, MMD_REF, REF, VRM_REST, REST_HIPS_Y, A_POSE, BONE_ROLE, BONE_IGNORED, FINGER_MAP, VRM_BONES, MORPH_MAP,
  toRH, qToRH, qfromTo, qfromFrames, solveLegIK, retargetVmd, bakeVmd, extentOf, aPoseDeg,
};
