'use strict';
// 角色性别 (voice gender): which 通用语音包 (generic voice pack, core/voice-pack.js) a character falls back to
// when she has no pack of her own, and which default engine voice reads her when her file names none.
//
// Where it comes from, first match wins (genderOf):
//   1. her character file: `gender` ("female" | "male"), or `voice.gender`            → source 'character'
//   2. the pack she is (a generic VRM companion, core/generic.js) or wears: pack.json `gender` / `voice.gender` → 'pack'
//   3. that pack's VRM motion style, pack.json `vrm.style` ("female" / "male", or { base })                   → 'style'
//   4. the guess from her model's body (core/vrm-style.js inferVoiceGender — stricter than the motion style's
//      inferFromBody: bust SpringBones or breast bones → female, shoulders ≥ 1.8× the hips → male, a VRoid
//      rig with an unsprung bust and shoulders ≥ 1.5 → male, else nothing)                                 → 'model'
//   5. DEFAULT_GENDER ("female")                                                                               → 'default'
// A neutral style or a neutral body reading says nothing about the voice, so it falls through to the next
// step and finally to the default. The default is female: every character the app ships and the template of a
// generic companion (core/generic.js) is written as 她, so a voice that matches the text is the safer guess.
// Pure; no fs.

const VrmStyle = require('./vrm-style');

const GENDERS = ['female', 'male'];
const DEFAULT_GENDER = 'female';

const isGender = (v) => GENDERS.includes(v);

// Problems with an optional gender field (empty = valid). `at` names the field in the message.
function validateGender(v, at = 'gender') {
  if (v === undefined) return [];
  return isGender(v) ? [] : [`${at} must be one of ${GENDERS.join(', ')}`];
}

// The explicit gender of a character file / species or a pack (top-level `gender`, else `voice.gender`).
function explicitOf(o) {
  if (!o || typeof o !== 'object') return null;
  if (isGender(o.gender)) return o.gender;
  const v = o.voice;
  return v && typeof v === 'object' && isGender(v.gender) ? v.gender : null;
}

// The model file of a VRM pack her daily look is drawn from (its body reading lives on it).
function bodyOf(pack) {
  const vrm = pack && pack.vrm;
  if (!vrm || !vrm.models) return null;
  const outfits = pack.outfits || {};
  const rel = outfits.daily || Object.values(outfits)[0] || Object.keys(vrm.models)[0];
  const m = rel && vrm.models[rel];
  return (m && m.body) || null;
}

// The style name a pack's vrm.style asks for: a parsed value ({ base }) or the raw pack.json field.
function styleOf(pack) {
  const st = pack && pack.vrm && pack.vrm.style;
  if (!st) return null;
  if (typeof st === 'string') return st;
  return typeof st.base === 'string' ? st.base : null;
}

// species: her species / character file; pack: the pack she is or wears (null when none).
// → { gender: 'female' | 'male', source: 'character' | 'pack' | 'style' | 'model' | 'default' }
function genderOf(species, pack = null) {
  const own = explicitOf(species);
  if (own) return { gender: own, source: 'character' };
  const fromPack = explicitOf(pack);
  if (fromPack) return { gender: fromPack, source: 'pack' };
  const style = styleOf(pack);
  if (isGender(style)) return { gender: style, source: 'style' };
  const body = bodyOf(pack);
  if (body) {
    const guess = VrmStyle.inferVoiceGender(body);
    if (isGender(guess)) return { gender: guess, source: 'model' };
  }
  return { gender: DEFAULT_GENDER, source: 'default' };
}

module.exports = { GENDERS, DEFAULT_GENDER, isGender, validateGender, explicitOf, genderOf };
