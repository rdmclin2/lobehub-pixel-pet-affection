'use strict';
// VRM motion style (docs/vrm-motion-system.md §4): female / male / neutral profiles that decide which set of
// postures and idles a model plays and how big she moves (sway, breathing, head, hands, emotion), the
// pack.json `vrm.style` field (a name, or { base, …overrides } clamped to VRM_STYLE_LIMITS), and the guess
// from the model file when the pack says nothing (VRM meta has no gender: SpringBone on bust bones → female,
// broad shoulders against hips and no breast bones → male, else neutral). The voice gender (core/voice-gender.js)
// reads the same body with a stricter rule of its own (inferVoiceGender). Pure; UMD (window.PetVrmStyle / require()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmStyle = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // set: which library set; amplitude: gestures; hipSway: weight shifts; stanceWidth: deg the upper legs open;
  // handPose: finger curl 0..1; headTilt: deg; breath: { chest, upperChest, spine, shoulder } deg at full breath;
  // emotion: expression strength; idleEvery: seconds per idle (a base, scheduled 8–20 s); lookAway: share of
  // idle time she looks elsewhere; shiftEvery: [min, max] seconds between weight shifts (the male set shifts
  // more often: a still male idle read as wooden, T-2691); liftSwing: how far the legs swing while she is
  // dragged in the air (× the alive layer's swing; T-2711: the male legs swung half as far).
  const PROFILES = {
    female: { set: 'female', amplitude: 1.0, hipSway: 1.0, stanceWidth: 0, handPose: 0.3, headTilt: 4, breath: { chest: 1.2, upperChest: 0.8, spine: 0.4, shoulder: 0.6 }, emotion: 1.0, idleEvery: 12, lookAway: 0.12, shiftEvery: [8, 16], liftSwing: 1 },
    male: { set: 'male', amplitude: 0.8, hipSway: 0.9, stanceWidth: 4, handPose: 0.45, headTilt: 1.5, breath: { chest: 0.8, upperChest: 0.3, spine: 1.0, shoulder: 0.3 }, emotion: 0.8, idleEvery: 16, lookAway: 0.08, shiftEvery: [4, 9], liftSwing: 1.6 },
    neutral: { set: 'neutral', amplitude: 0.9, hipSway: 0.75, stanceWidth: 2, handPose: 0.38, headTilt: 3, breath: { chest: 1.0, upperChest: 0.55, spine: 0.7, shoulder: 0.45 }, emotion: 0.9, idleEvery: 15, lookAway: 0.09, shiftEvery: [6, 14], liftSwing: 1.2 },
  };
  const NAMES = Object.keys(PROFILES);
  const VRM_STYLE_LIMITS = { amplitude: [0.3, 1.3], hipSway: [0, 1.5], stanceWidth: [-2, 8], handPose: [0, 0.8], headTilt: [0, 8], emotion: [0.3, 1.2], idleEvery: [8, 20], lookAway: [0, 0.3] };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // pack.json vrm.style → { ok, value: { base, overrides } | null, errors }
  function parsePackStyle(raw) {
    if (raw === undefined || raw === null) return { ok: true, value: null, errors: [] };
    if (typeof raw === 'string') {
      return NAMES.includes(raw) ? { ok: true, value: { base: raw, overrides: {} }, errors: [] } : { ok: false, value: null, errors: [`vrm.style: unknown style "${raw}" (known: ${NAMES.join(', ')})`] };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, value: null, errors: ['vrm.style must be a style name or { "base": …, overrides }'] };
    const errors = [];
    const base = raw.base === undefined ? 'neutral' : raw.base;
    if (!NAMES.includes(base)) errors.push(`vrm.style.base: unknown style "${base}" (known: ${NAMES.join(', ')})`);
    const overrides = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'base') continue;
      if (!VRM_STYLE_LIMITS[k]) { errors.push(`vrm.style.${k}: unknown field (known: base, ${Object.keys(VRM_STYLE_LIMITS).join(', ')})`); continue; }
      if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`vrm.style.${k} must be a number`); continue; }
      overrides[k] = clamp(v, VRM_STYLE_LIMITS[k][0], VRM_STYLE_LIMITS[k][1]);
    }
    return errors.length ? { ok: false, value: null, errors } : { ok: true, value: { base, overrides }, errors: [] };
  }

  // ---------- guessing from the model ----------
  const BUST_RE = /bust|breast|oppai|胸/i;
  const COLLIDER_RE = /collid/i; // Breast_L_Collider, BreastUnder_Collider: collision helpers, not breast bones
  const VROID_BUST_RE = /^J_Sec_[LR]_Bust/; // VRoid Studio's skeleton has these on every figure, male or female
  // Shoulder-to-hip ratios (VRM_GENDER_RULES): the motion style calls ≥ 1.5 male; the voice gender asks for
  // more. Across the 73 models of the store (docs/voice-packs.md §性别推断) every male stood at 1.90–2.30, the
  // female Elysia at 1.54 (breast bones without a spring) and two more girls at 1.60 / 1.64 (bust on a spring).
  const VRM_GENDER_RULES = { styleMaleShoulderHip: 1.5, voiceMaleShoulderHip: 1.8, vroidMaleShoulderHip: 1.5 };
  // { bustSpring, bustBones, vroidBust, shoulderHip } from a VRM glTF JSON (1.0 or 0.x), read only from the
  // JSON header. bustSpring: bust-named bones on a SpringBone; bustBones: bust-named bones outside VRoid's
  // template skeleton (spring or not, colliders left out) — a rig only has them when the figure was made with
  // breasts; vroidBust: VRoid's J_Sec_*_Bust template bones (present on male VRoid figures too).
  function bodyFromJson(json) {
    const nodes = (json && json.nodes) || [];
    const ext = (json && json.extensions) || {};
    const springNodes = new Set();
    if (ext.VRMC_springBone && Array.isArray(ext.VRMC_springBone.springs)) {
      for (const s of ext.VRMC_springBone.springs) for (const j of (s && s.joints) || []) if (Number.isInteger(j && j.node)) springNodes.add(j.node);
    }
    if (ext.VRM && ext.VRM.secondaryAnimation && Array.isArray(ext.VRM.secondaryAnimation.boneGroups)) {
      // 0.x: a group lists root bones; the chain under each moves with it
      const kids = (i) => ((nodes[i] && nodes[i].children) || []);
      const walk = (i, depth = 0) => { if (!nodes[i] || depth > 32 || springNodes.has(i)) return; springNodes.add(i); for (const c of kids(i)) walk(c, depth + 1); };
      for (const g of ext.VRM.secondaryAnimation.boneGroups) for (const b of (g && g.bones) || []) if (Number.isInteger(b)) walk(b);
    }
    let bustSpring = 0;
    for (const i of springNodes) if (nodes[i] && BUST_RE.test(String(nodes[i].name || ''))) bustSpring++;
    let bustBones = 0;
    let vroidBust = 0;
    for (const n of nodes) {
      const name = String((n && n.name) || '');
      if (!BUST_RE.test(name) || COLLIDER_RE.test(name)) continue;
      if (VROID_BUST_RE.test(name)) vroidBust++;
      else bustBones++;
    }
    // humanoid: bone name → node index
    const hb = {};
    if (ext.VRMC_vrm && ext.VRMC_vrm.humanoid && ext.VRMC_vrm.humanoid.humanBones) for (const [n, b] of Object.entries(ext.VRMC_vrm.humanoid.humanBones)) if (b && Number.isInteger(b.node)) hb[n] = b.node;
    if (ext.VRM && ext.VRM.humanoid && Array.isArray(ext.VRM.humanoid.humanBones)) for (const b of ext.VRM.humanoid.humanBones) if (b && b.bone && Number.isInteger(b.node)) hb[b.bone] = b.node;
    // world positions by adding up node translations (rotations are identity at rest in VRM exports)
    const parent = new Map();
    nodes.forEach((n, i) => { for (const c of (n && n.children) || []) parent.set(c, i); });
    const world = (i) => { const p = [0, 0, 0]; let k = i; let guard = 0; while (k !== undefined && nodes[k] && guard++ < 64) { const t = nodes[k].translation || [0, 0, 0]; p[0] += t[0]; p[1] += t[1]; p[2] += t[2]; k = parent.get(k); } return p; };
    const dist = (a, b) => (hb[a] === undefined || hb[b] === undefined ? null : Math.hypot(...world(hb[a]).map((v, i) => v - world(hb[b])[i])));
    const shoulders = dist('leftUpperArm', 'rightUpperArm');
    const hips = dist('leftUpperLeg', 'rightUpperLeg');
    const shoulderHip = shoulders && hips ? shoulders / hips : null;
    return { bustSpring, bustBones, vroidBust, shoulderHip: shoulderHip === null ? null : Math.round(shoulderHip * 100) / 100 };
  }

  const ratio = (body) => (body && typeof body.shoulderHip === 'number' && Number.isFinite(body.shoulderHip) ? body.shoulderHip : null);
  const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0); // a body read before T-5076 has no bustBones / vroidBust

  // The motion style a body reading suggests: bust on a spring → female; broad shoulders (≥ 1.5× the hips)
  // → male, unless the rig has breast bones (Elysia: 1.54, breast bones without a spring — T-5076), then neutral.
  function inferFromBody(body) {
    if (!body) return 'neutral';
    if (count(body.bustSpring) > 0) return 'female';
    const r = ratio(body);
    if (r !== null && r >= VRM_GENDER_RULES.styleMaleShoulderHip && count(body.bustBones) === 0) return 'male';
    return 'neutral';
  }

  // The voice gender a body reading suggests (core/voice-gender.js step 4) — stricter than the motion style,
  // since a girl read with a man's voice is the worse mistake; 'neutral' = not enough to say (the caller then
  // falls back to its default, female):
  //   bust on a spring, or breast bones outside VRoid's template          → female
  //   shoulders ≥ 1.8× the hips (and no breast bones)                     → male
  //   a VRoid skeleton whose bust bones are on no spring, shoulders ≥ 1.5 → male (VRoid Studio springs the bust
  //                                                                          of a female figure; vroid.vrm: 1.57)
  //   else                                                                → neutral
  function inferVoiceGender(body) {
    if (!body) return 'neutral';
    if (count(body.bustSpring) > 0 || count(body.bustBones) > 0) return 'female';
    const r = ratio(body);
    if (r === null) return 'neutral';
    if (r >= VRM_GENDER_RULES.voiceMaleShoulderHip) return 'male';
    if (count(body.vroidBust) > 0 && r >= VRM_GENDER_RULES.vroidMaleShoulderHip) return 'male';
    return 'neutral';
  }

  // The style a figure plays: pack.json (`packStyle`, parsed) > what the importer wrote (also pack.json,
  // `source` 'import') > the model's body > neutral. → { name, set, source, ...profile }
  function resolveStyle({ packStyle = null, body = null } = {}) {
    let base = null;
    let source = 'default';
    let overrides = {};
    if (packStyle && packStyle.base) { base = packStyle.base; overrides = packStyle.overrides || {}; source = 'pack'; }
    else if (body) { base = inferFromBody(body); source = 'meta'; }
    if (!base) base = 'neutral';
    const p = PROFILES[base];
    return { ...p, ...overrides, breath: { ...p.breath }, shiftEvery: p.shiftEvery.slice(), name: base, set: p.set, source };
  }

  return { PROFILES, NAMES, VRM_STYLE_LIMITS, VRM_GENDER_RULES, parsePackStyle, bodyFromJson, inferFromBody, inferVoiceGender, resolveStyle };
});
