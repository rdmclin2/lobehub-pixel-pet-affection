'use strict';
// Bone maps and the missing-bone fallback of the motion library (T-5081, docs/vrm-motion-library.md §5). Pure; UMD
// (window.PetVrmBoneMap in the renderer, require() in the bake and the tests).
//
// The two source skeletons and the VRM humanoid:
//   • Mixamo (mixamorig:*) → VRM: MIXAMO_TO_VRM, the bake's table (scripts/lib/vrm-bake-core.js reads it from here);
//     the key is carried from the Mixamo bone's rest frame into the VRM normalized bone (identity rest, world axes):
//     q_vrm = Q_parentWorldRest · q · Q_worldRest⁻¹ (vrm-bake-core retargetQ).
//   • MMD (VMD) → VRM: MMD_TO_VRM (src/core/vmd-retarget.js BONE_ROLE: twist bones folded into the arm bones, the root
//     chain into the hips, leg IK solved onto the legs, the A-pose arms carried into the T-pose).
//   • VRM 0.x ↔ 1.0: the baked .vrma is VRM 1.0 (+Z forward); three-vrm's createVRMAnimationClip turns it for a 0.x
//     model (x and z of every rotation negated, hips x / z) and renames the 0.x thumb (thumbProximal → ThumbMetacarpal,
//     thumbIntermediate → ThumbProximal) — VRM0_THUMB documents the pairs, nothing has to be done by hand.
//   • Proportions: every bone is a rotation, so arm and leg lengths do not matter; the hips' travel is scaled by the
//     model's own hips height over the clip's (three-vrm, restHipsPosition), so a short model walks shorter steps.
// What three-vrm does not do: a model without an optional bone (upperChest, neck, shoulders, toes, fingers) loses that
// bone's track, and with it the turn of everything below it. foldMissing() carries the missing bone's rotation down
// into its present children (world rotation kept: P·m·c = P·(m·c)) before the clip is made; a missing leaf (toes,
// a finger tip) is simply dropped.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmBoneMap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- the VRM humanoid ----------
  const VRM_PARENT = {
    hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
    leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
    rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
    leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
    rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
  };
  const FINGERS = ['Index', 'Middle', 'Ring', 'Little'];
  for (const s of ['left', 'right']) {
    VRM_PARENT[`${s}ThumbMetacarpal`] = `${s}Hand`;
    VRM_PARENT[`${s}ThumbProximal`] = `${s}ThumbMetacarpal`;
    VRM_PARENT[`${s}ThumbDistal`] = `${s}ThumbProximal`;
    for (const f of FINGERS) {
      VRM_PARENT[`${s}${f}Proximal`] = `${s}Hand`;
      VRM_PARENT[`${s}${f}Intermediate`] = `${s}${f}Proximal`;
      VRM_PARENT[`${s}${f}Distal`] = `${s}${f}Intermediate`;
    }
  }
  const VRM_BONES = Object.keys(VRM_PARENT);
  // VRM 1.0 "required" (a model without one of these is not a humanoid: core/vrm.js refuses it)
  const VRM_REQUIRED = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
  const VRM_OPTIONAL = VRM_BONES.filter((b) => !VRM_REQUIRED.includes(b));
  const CHILDREN = {};
  for (const [b, p] of Object.entries(VRM_PARENT)) if (p) (CHILDREN[p] = CHILDREN[p] || []).push(b);
  // VRM 0.x thumb names → VRM 1.0 (three-vrm applies these when it loads a 0.x model)
  const VRM0_THUMB = {};
  for (const s of ['left', 'right']) Object.assign(VRM0_THUMB, { [`${s}ThumbProximal`]: `${s}ThumbMetacarpal`, [`${s}ThumbIntermediate`]: `${s}ThumbProximal`, [`${s}ThumbDistal`]: `${s}ThumbDistal` });

  // ---------- Mixamo → VRM ----------
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
    for (const f of FINGERS) {
      const mx = f === 'Little' ? 'Pinky' : f;
      MIXAMO_TO_VRM[`${side}Hand${mx}1`] = `${s}${f}Proximal`;
      MIXAMO_TO_VRM[`${side}Hand${mx}2`] = `${s}${f}Intermediate`;
      MIXAMO_TO_VRM[`${side}Hand${mx}3`] = `${s}${f}Distal`;
    }
  }
  // Mixamo bones read and deliberately not used: the tips (no VRM bone), the eyes (the gaze layer owns them)
  const MIXAMO_IGNORED = ['HeadTop_End', 'LeftEye', 'RightEye', 'LeftToe_End', 'RightToe_End', ...['Left', 'Right'].flatMap((s) => ['Thumb4', 'Index4', 'Middle4', 'Ring4', 'Pinky4'].map((f) => `${s}Hand${f}`))];
  const stripMixamo = (name) => String(name || '').replace(/^mixamorig\d*:?/, '');
  const vrmOfMixamo = (name) => MIXAMO_TO_VRM[stripMixamo(name)] || null;

  // ---------- MMD → VRM (src/core/vmd-retarget.js BONE_ROLE, the bones a VMD keys) ----------
  const MMD_TO_VRM = { 全ての親: 'hips', センター: 'hips', グルーブ: 'hips', 腰: 'hips', 下半身: 'hips', 上半身: 'spine', 上半身1: 'spine', 上半身2: 'chest', 上半身3: 'upperChest', 首: 'neck', 頭: 'head' };
  for (const [s, j] of [['left', '左'], ['right', '右']]) {
    Object.assign(MMD_TO_VRM, {
      [`${j}肩P`]: `${s}Shoulder`, [`${j}肩`]: `${s}Shoulder`, [`${j}腕`]: `${s}UpperArm`, [`${j}腕捩`]: `${s}UpperArm`, [`${j}ひじ`]: `${s}LowerArm`, [`${j}手捩`]: `${s}LowerArm`, [`${j}手首`]: `${s}Hand`,
      [`${j}足`]: `${s}UpperLeg`, [`${j}ひざ`]: `${s}LowerLeg`, [`${j}足首`]: `${s}Foot`, [`${j}つま先`]: `${s}Toes`, [`${j}足D`]: `${s}UpperLeg`, [`${j}ひざD`]: `${s}LowerLeg`, [`${j}足首D`]: `${s}Foot`, [`${j}足先EX`]: `${s}Toes`,
      [`${j}足IK`]: `${s}Foot`, [`${j}つま先IK`]: `${s}Foot`,
      [`${j}親指0`]: `${s}ThumbMetacarpal`, [`${j}親指1`]: `${s}ThumbProximal`, [`${j}親指2`]: `${s}ThumbDistal`,
    });
    for (const [mf, vf] of [['人指', 'Index'], ['中指', 'Middle'], ['薬指', 'Ring'], ['小指', 'Little']]) Object.assign(MMD_TO_VRM, { [`${j}${mf}1`]: `${s}${vf}Proximal`, [`${j}${mf}2`]: `${s}${vf}Intermediate`, [`${j}${mf}3`]: `${s}${vf}Distal` });
  }

  // ---------- quaternions ([x, y, z, w]) ----------
  const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const qnorm = (q) => { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; };
  function qslerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    const bb = d < 0 ? b.map((x) => -x) : b;
    d = Math.abs(d);
    if (d > 0.9995) return qnorm(a.map((x, i) => x + (bb[i] - x) * t));
    const th = Math.acos(d);
    const s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s;
    const wb = Math.sin(t * th) / s;
    return a.map((x, i) => x * wa + bb[i] * wb);
  }
  // a track { times: number[], values: flat [x,y,z,w,…] } at time t
  function at(tr, t) {
    const { times, values } = tr;
    const q = (i) => [values[i * 4], values[i * 4 + 1], values[i * 4 + 2], values[i * 4 + 3]];
    const n = times.length - 1;
    if (n < 0) return [0, 0, 0, 1];
    if (t <= times[0]) return q(0);
    if (t >= times[n]) return q(n);
    let lo = 0;
    let hi = n;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
    return qslerp(q(lo), q(hi), (t - times[lo]) / (times[hi] - times[lo] || 1));
  }
  // m · c on the union of both tracks' times
  function premultiply(m, c) {
    const times = [...new Set([...m.times, ...c.times])].sort((a, b) => a - b);
    const values = [];
    for (const t of times) values.push(...qnorm(qmul(at(m, t), at(c, t))));
    return { times, values };
  }

  // The rotation tracks of a clip ({ vrmBone: { times, values (flat xyzw) } }) for a model that has the bones `has`
  // (a Set or a function): every missing bone folded into its present descendants, the leaves dropped.
  // → { tracks, folded: [[missing, into[]]], dropped: [] }
  function foldMissing(tracks, has) {
    const present = typeof has === 'function' ? has : (b) => has.has(b);
    const out = { ...tracks };
    const folded = [];
    const dropped = [];
    // parents before children, so a chain of missing bones (chest and upperChest) composes in order
    const order = VRM_BONES.filter((b) => out[b]);
    for (const b of order) {
      if (present(b) || !out[b]) continue;
      const m = out[b];
      delete out[b];
      const kids = (CHILDREN[b] || []);
      const into = [];
      for (const k of kids) {
        // a child without a track of its own still turns with its missing parent
        const c = out[k] || { times: m.times.slice(), values: m.times.flatMap(() => [0, 0, 0, 1]) };
        out[k] = premultiply(m, c);
        into.push(k);
      }
      if (into.length) folded.push([b, into]); else dropped.push(b);
    }
    // a bone nobody has (both the bone and its whole subtree missing) ends up dropped with its leaves
    for (const b of Object.keys(out)) if (!present(b)) { delete out[b]; if (!dropped.includes(b)) dropped.push(b); }
    return { tracks: out, folded, dropped };
  }

  // How well a model can play clips (the bones it lacks, by what it costs): 'full', 'folded' (optional trunk / shoulder
  // bones folded), 'no-fingers', or 'unusable' (a required bone is missing).
  function degradeLevel(has) {
    const present = typeof has === 'function' ? has : (b) => has.has(b);
    if (VRM_REQUIRED.some((b) => !present(b))) return 'unusable';
    const trunk = ['chest', 'upperChest', 'neck', 'leftShoulder', 'rightShoulder'].filter((b) => !present(b));
    const fingers = VRM_BONES.filter((b) => /Thumb|Index|Middle|Ring|Little/.test(b) && !present(b));
    if (trunk.length) return 'folded';
    if (fingers.length) return 'no-fingers';
    return 'full';
  }

  // A model whose humanoid "hips" is a root on the floor (some MMD conversions map 全ての親 / センター there): its
  // normalized rest hips height is ~0, so three-vrm scales the hips travel by 0 and every hips turn pivots at her
  // feet. Standing clips still read right; a sit / crouch / lay (or a clip that starts or ends in one) would tip her
  // over around her ankles, so such a model plays standing clips only (renderer loadClips, T-5081).
  const rootHips = (restHipsY, headY) => !(restHipsY > 0.25 * (headY || 1));
  const LOW_GROUPS = ['sit', 'crouch', 'lay'];
  function allowsClip(clip, { rootHips: rh = false } = {}) {
    if (!rh || !clip) return true;
    if (clip.sit || LOW_GROUPS.includes(clip.group)) return false;
    for (const k of ['enter', 'exit']) if (clip[k] && clip[k] !== 'stand') return false;
    return true;
  }

  // ---------- steps in a clip's own keys (T-5084) ----------
  // Some source clips have a moment where a bone turns in one frame what it otherwise turns in several (a mocap
  // glitch, a flip: react.greet-01's hand 57° in 30 ms, emote.shy-02@male's forearm 32°) — played as is, that is a
  // snap whatever the cross-fades do. The track is sampled the way it plays, at 30 fps: a step is a frame whose turn
  // is above `limit` ° and more than `ratio` × the larger of the frames just before and after. Every key within
  // `span` frames around it is replaced by the slerp, by time, between the poses `span` frames before and after —
  // the step spread over 2·span + 1 frames; at the clip's start or end, where there is nothing to spread into, the
  // keys beyond the step hold the pose on the other side. Repeated until none is left (≤ passes). times: seconds;
  // values: flat [x, y, z, w]… (changed in place). → the number of steps spread.
  function sampleQ(times, values, x, out) {
    const n = times.length;
    if (x <= times[0]) { for (let c = 0; c < 4; c++) out[c] = values[c]; return out; }
    if (x >= times[n - 1]) { for (let c = 0; c < 4; c++) out[c] = values[(n - 1) * 4 + c]; return out; }
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= x) lo = m; else hi = m; }
    return slerpQ(values.slice(lo * 4, lo * 4 + 4), values.slice(hi * 4, hi * 4 + 4), (x - times[lo]) / Math.max(1e-9, times[hi] - times[lo]), out);
  }
  function slerpQ(qa, qb, k, out) {
    let d = 0;
    for (let c = 0; c < 4; c++) d += qa[c] * qb[c];
    const sg = d < 0 ? -1 : 1;
    const th = Math.acos(Math.min(1, Math.abs(d)));
    const s0 = th < 1e-6 ? 1 - k : Math.sin((1 - k) * th) / Math.sin(th);
    const s1 = th < 1e-6 ? k : Math.sin(k * th) / Math.sin(th);
    let n = 0;
    for (let c = 0; c < 4; c++) { out[c] = s0 * qa[c] + sg * s1 * qb[c]; n += out[c] * out[c]; }
    n = Math.sqrt(n) || 1;
    for (let c = 0; c < 4; c++) out[c] /= n;
    return out;
  }
  const qdeg = (a, b) => { let d = 0; for (let c = 0; c < 4; c++) d += a[c] * b[c]; return (2 * Math.acos(Math.min(1, Math.abs(d))) * 180) / Math.PI; };
  function smoothSteps(times, values, { limit = 10, ratio = 1.4, span = 3, passes = 4, fps = 30 } = {}) {
    const n = times.length;
    if (n < 3 || values.length < n * 4) return 0;
    const t0 = times[0];
    const t1 = times[n - 1];
    const frames = Math.floor((t1 - t0) * fps + 1e-6);
    if (frames < 2) return 0;
    let fixed = 0;
    for (let p = 0; p < passes; p++) {
      const g = [];
      for (let i = 0; i <= frames; i++) g.push(sampleQ(times, values, t0 + i / fps, [0, 0, 0, 0]));
      g.push(sampleQ(times, values, t1, [0, 0, 0, 0])); // the last key (a clip need not end on a frame)
      const tg = (i) => (i >= g.length - 1 ? t1 : t0 + i / fps);
      const d = [];
      for (let i = 0; i + 1 < g.length; i++) d.push(qdeg(g[i], g[i + 1]));
      let any = false;
      for (let k = 0; k < d.length; k++) {
        const nb = Math.max(k > 0 ? d[k - 1] : 0, k + 1 < d.length ? d[k + 1] : 0);
        if (!(d[k] > limit && d[k] > ratio * nb)) continue;
        const a = k - span;
        const b = k + 1 + span;
        const q = [0, 0, 0, 0];
        if (a < 0 || b > g.length - 1) {
          // at the start: everything before the step holds the pose after it; at the end: the pose before it
          const start = a < 0;
          const hold = start ? g[k + 1] : g[k];
          const edge = start ? tg(k + 1) : tg(k);
          for (let i = 0; i < n; i++) if (start ? times[i] < edge : times[i] > edge) for (let c = 0; c < 4; c++) values[i * 4 + c] = hold[c];
        } else {
          const A = tg(a);
          const B = tg(b);
          for (let i = 0; i < n; i++) if (times[i] > A && times[i] < B) { slerpQ(g[a], g[b], (times[i] - A) / (B - A), q); for (let c = 0; c < 4; c++) values[i * 4 + c] = q[c]; }
        }
        fixed++;
        any = true;
        k = b;
      }
      if (!any) break;
    }
    return fixed;
  }

  return { smoothSteps, _sampleQ: sampleQ, rootHips, allowsClip, LOW_GROUPS, VRM_PARENT, VRM_BONES, VRM_REQUIRED, VRM_OPTIONAL, CHILDREN, VRM0_THUMB, MIXAMO_TO_VRM, MIXAMO_IGNORED, MMD_TO_VRM, stripMixamo, vrmOfMixamo, foldMissing, degradeLevel, premultiply, at, qmul };
});
