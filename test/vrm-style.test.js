'use strict';
// VRM motion style (src/core/vrm-style.js, docs/vrm-motion-system.md §4): profiles, pack.json vrm.style,
// the guess from the model (SpringBone on bust bones / shoulder-to-hip width), priority and clamping.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/core/vrm-style');

// a minimal VRM glTF JSON: humanoid nodes at given x, optional bust nodes and spring setups
function model({ v = '1.0', shoulder = 0.18, hip = 0.1, bust = false, bustSpring = false } = {}) {
  const nodes = [
    { name: 'Hips', translation: [0, 0.9, 0], children: [1, 2, 3] },
    { name: 'L_UpperLeg', translation: [hip / 2, -0.05, 0] },
    { name: 'R_UpperLeg', translation: [-hip / 2, -0.05, 0] },
    { name: 'Chest', translation: [0, 0.4, 0], children: [4, 5, ...(bust ? [6] : [])] },
    { name: 'L_UpperArm', translation: [shoulder / 2, 0, 0] },
    { name: 'R_UpperArm', translation: [-shoulder / 2, 0, 0] },
  ];
  if (bust) nodes.push({ name: 'J_Sec_L_Bust1', translation: [0.05, 0, 0.05] });
  const bones = { hips: 0, leftUpperLeg: 1, rightUpperLeg: 2, chest: 3, leftUpperArm: 4, rightUpperArm: 5 };
  const ext = {};
  if (v === '1.0') {
    ext.VRMC_vrm = { specVersion: '1.0', humanoid: { humanBones: Object.fromEntries(Object.entries(bones).map(([k, n]) => [k, { node: n }])) } };
    if (bustSpring) ext.VRMC_springBone = { springs: [{ joints: [{ node: 6 }] }] };
  } else {
    ext.VRM = { humanoid: { humanBones: Object.entries(bones).map(([k, n]) => ({ bone: k, node: n })) }, secondaryAnimation: { boneGroups: bustSpring ? [{ bones: [6] }] : [] } };
  }
  return { nodes, extensions: ext };
}

test('the guess: bust bones on a spring → female; else shoulders ≥ 1.5× the hips → male; else neutral', () => {
  const f = S.bodyFromJson(model({ bust: true, bustSpring: true, shoulder: 0.15, hip: 0.11 }));
  assert.equal(f.bustSpring, 1);
  assert.equal(S.inferFromBody(f), 'female');
  // a VRoid male: Bust nodes exported, but on no spring — not female
  const m = S.bodyFromJson(model({ bust: true, bustSpring: false, shoulder: 0.2, hip: 0.12 }));
  assert.equal(m.bustSpring, 0);
  assert.ok(m.shoulderHip >= 1.5);
  assert.equal(S.inferFromBody(m), 'male');
  assert.equal(S.inferFromBody(S.bodyFromJson(model({ shoulder: 0.16, hip: 0.12 }))), 'neutral');
  // VRM 0.x: the spring group's chain counts
  assert.equal(S.inferFromBody(S.bodyFromJson(model({ v: '0.x', bust: true, bustSpring: true }))), 'female');
  assert.equal(S.inferFromBody(S.bodyFromJson({ nodes: [], extensions: {} })), 'neutral', 'no humanoid: neutral');
  assert.equal(S.inferFromBody(null), 'neutral');
});

// T-5076: the store's Elysia (shoulderHip 1.54, breast bones on no spring) was read as male, by the motion style
// and by the voice gender. Models in the shapes the 73-model scan found (docs/voice-packs.md §性别推断).
function rig({ shoulder = 0.18, hip = 0.1, names = [], spring = [] } = {}) {
  const j = model({ shoulder, hip });
  const at = j.nodes.length;
  names.forEach((name) => j.nodes.push({ name, translation: [0, 0, 0.05] }));
  j.nodes[3].children.push(...names.map((_, i) => at + i));
  j.extensions.VRMC_springBone = { springs: [{ joints: spring.map((n) => ({ node: at + names.indexOf(n) })) }] };
  return S.bodyFromJson(j);
}
const ELYSIA = rig({ shoulder: 0.154, hip: 0.1, names: ['579.joint_LeftBreastUpper2', '580.joint_RightBreastUpper2', '583.!joint_RightBreast', '584.!joint_LeftBreast', 'Breast_L_Collider'] });
const KAZUHA = rig({ shoulder: 0.196, hip: 0.1 });
const LAYLA = rig({ shoulder: 0.134, hip: 0.1, names: ['40.joint_+Breast L A01', '41.joint_+Breast R A01'], spring: ['40.joint_+Breast L A01', '41.joint_+Breast R A01'] });
const VROID_MALE = rig({ shoulder: 0.157, hip: 0.1, names: ['J_Sec_L_Bust1', 'J_Sec_L_Bust2', 'J_Sec_R_Bust1', 'J_Sec_R_Bust2'] });
const VROID_FEMALE = rig({ shoulder: 0.141, hip: 0.1, names: ['J_Sec_L_Bust1', 'J_Sec_R_Bust1'], spring: ['J_Sec_L_Bust1', 'J_Sec_R_Bust1'] });
const LIQU = rig({ shoulder: 0.152, hip: 0.1 });

test('bodyFromJson counts breast bones outside VRoid\'s template (spring or not, colliders left out) and the template ones', () => {
  assert.deepEqual(ELYSIA, { bustSpring: 0, bustBones: 4, vroidBust: 0, shoulderHip: 1.54 });
  assert.deepEqual(LAYLA, { bustSpring: 2, bustBones: 2, vroidBust: 0, shoulderHip: 1.34 });
  assert.deepEqual(VROID_MALE, { bustSpring: 0, bustBones: 0, vroidBust: 4, shoulderHip: 1.57 });
  assert.deepEqual(KAZUHA, { bustSpring: 0, bustBones: 0, vroidBust: 0, shoulderHip: 1.96 });
});

test('voice gender (inferVoiceGender) is stricter than the motion style: Elysia female, Kazuha male, Layla female', () => {
  const both = (b) => [S.inferFromBody(b), S.inferVoiceGender(b)];
  assert.deepEqual(both(ELYSIA), ['neutral', 'female'], 'breast bones: never male; female for the voice');
  assert.deepEqual(both(KAZUHA), ['male', 'male']);
  assert.deepEqual(both(LAYLA), ['female', 'female']);
  assert.deepEqual(both(VROID_MALE), ['male', 'male'], 'VRoid figure, bust on no spring, 1.57');
  assert.deepEqual(both(VROID_FEMALE), ['female', 'female']);
  assert.deepEqual(both(LIQU), ['male', 'neutral'], '1.5–1.8 without other evidence: the voice says nothing (→ default female); the motion style is unchanged');
  // the thresholds
  assert.equal(S.inferVoiceGender({ bustSpring: 0, bustBones: 0, vroidBust: 0, shoulderHip: S.VRM_GENDER_RULES.voiceMaleShoulderHip }), 'male');
  assert.equal(S.inferVoiceGender({ bustSpring: 0, bustBones: 0, vroidBust: 0, shoulderHip: 1.79 }), 'neutral');
  assert.equal(S.inferVoiceGender({ bustSpring: 0, bustBones: 0, vroidBust: 4, shoulderHip: 1.49 }), 'neutral');
  assert.equal(S.inferVoiceGender({ bustSpring: 0, bustBones: 2, vroidBust: 0, shoulderHip: 2.3 }), 'female', 'breast bones beat broad shoulders');
  // an older body reading (no bustBones / vroidBust), a missing ratio, nothing
  assert.equal(S.inferVoiceGender({ bustSpring: 0, shoulderHip: 1.7 }), 'neutral');
  assert.equal(S.inferVoiceGender({ bustSpring: 0, shoulderHip: 1.9 }), 'male');
  assert.equal(S.inferFromBody({ bustSpring: 0, shoulderHip: 1.7 }), 'male', 'the motion style keeps reading an older body as before');
  assert.equal(S.inferVoiceGender({ bustSpring: 0, bustBones: 0, shoulderHip: null }), 'neutral');
  assert.equal(S.inferVoiceGender(null), 'neutral');
});

test('priority: pack.json style > the model guess > neutral; object style inherits its base and is clamped', () => {
  const body = { bustSpring: 2, shoulderHip: 1.41 };
  assert.deepEqual([S.resolveStyle({ packStyle: { base: 'male', overrides: {} }, body }).name, S.resolveStyle({ packStyle: { base: 'male', overrides: {} }, body }).source], ['male', 'pack']);
  assert.deepEqual([S.resolveStyle({ body }).name, S.resolveStyle({ body }).source], ['female', 'meta']);
  assert.deepEqual([S.resolveStyle({}).name, S.resolveStyle({}).source], ['neutral', 'default']);
  const p = S.parsePackStyle({ base: 'female', amplitude: 0.7, hipSway: 9 });
  assert.equal(p.ok, true);
  assert.equal(p.value.overrides.hipSway, S.VRM_STYLE_LIMITS.hipSway[1], 'clamped');
  const st = S.resolveStyle({ packStyle: p.value });
  assert.equal(st.amplitude, 0.7);
  assert.equal(st.headTilt, S.PROFILES.female.headTilt, 'inherited');
  assert.equal(st.set, 'female');
  assert.equal(S.parsePackStyle('male').value.base, 'male');
  assert.equal(S.parsePackStyle(undefined).value, null);
  assert.match(S.parsePackStyle('robot').errors[0], /unknown style "robot"/);
  assert.match(S.parsePackStyle({ base: 'female', wiggle: 1 }).errors[0], /vrm.style.wiggle: unknown field/);
  assert.match(S.parsePackStyle({ amplitude: 'big' }).errors[0], /must be a number/);
});

test('female and male profiles differ the way the design says (male: smaller moves, wider stance, belly breathing)', () => {
  const F = S.PROFILES.female;
  const M = S.PROFILES.male;
  assert.ok(M.amplitude < F.amplitude && M.hipSway < F.hipSway && M.stanceWidth > F.stanceWidth && M.emotion < F.emotion && M.idleEvery > F.idleEvery);
  assert.ok(F.breath.chest > F.breath.spine && M.breath.spine > M.breath.chest, 'chest vs belly breathing');
  for (const p of Object.values(S.PROFILES)) for (const [k, [a, b]] of Object.entries(S.VRM_STYLE_LIMITS)) assert.ok(p[k] >= a && p[k] <= b, k);
});
