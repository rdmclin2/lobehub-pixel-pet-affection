'use strict';
// The selection rules of the motion library (T-5081, docs/vrm-motion-library.md §3.3): scanned features
// (scripts/lib/vrm-motion-features.js) plus the pack's own labels (inventory.json `ref`: lobe-vidol's names for
// part of the Mixamo / postures files) → a category and a group per clip, with a score to rank the candidates of a
// group. Pure; test/vrm-motion-rules.test.js pins every rule on synthetic features.
//
// What a rule cannot see (an angry fist from a cheer, a yawn from a hand on the chin) is settled by the review
// (scripts/vrm-motion-select.js REVIEW): a reviewed clip keeps the group the reviewer gave it, a rejected one is out.

// category → groups (the index's `category` / `group`; docs §2)
const CATEGORIES = {
  posture: ['stand', 'sit', 'crouch', 'lay'],
  idle: ['idle'],
  reaction: ['greet', 'bow', 'nod', 'shake', 'think', 'stretch', 'yawn', 'clap', 'point', 'shrug', 'look', 'jump', 'agree', 'fidget'],
  emotion: ['happy', 'angry', 'sad', 'surprised', 'shy', 'excited'],
  talk: ['talk'],
  walk: ['walk', 'run', 'turn'],
  dance: ['dance'],
};
const GROUP_CATEGORY = Object.fromEntries(Object.entries(CATEGORIES).flatMap(([c, gs]) => gs.map((g) => [g, c])));

// Never in the library: fights, weapons, falls, the adult-only and helper motions (inventory `use_this_phase` NO).
const EXCLUDE_TEXT = /on object|holding (?:a|an|the) |combat|weapon|sword|punch|kick|fight|attack|shoot|rifle|pistol|gun|zombie|dying|death|die\b|hit reaction|knocked|stab|block|parry|slash|boxing|brawl|kidnap|PO_chest|_0[ms]|number_meter|center_dummy/i;

const standing = (f) => f.hips.heightMin > 0.85 && f.lean.max < 30;
const inPlace = (f) => f.hips.speed < 0.12 && f.hips.path < 0.6 && f.feet.strideRange < 0.3;
const calmLegs = (f) => f.energy.legs < 45;

// lobe-vidol's label (ref.category / description) → a group; null when the label says nothing we use
function groupOfLabel(ref) {
  if (!ref) return null;
  const d = String(ref.description || '').toLowerCase();
  const c = String(ref.category || '');
  if (ref.type === 'Posture') {
    if (c === 'Standing') return 'stand';
    if (c === 'Sitting') return 'sit';
    if (c === 'Crouch') return 'crouch';
    if (c === 'Laying') return 'lay';
    return null; // Action / Locomotion / Dynamic / Dance poses: key frames, not postures to rest in
  }
  if (c === 'Dance') return 'dance';
  if (/walk/.test(d)) return 'walk';
  if (/turning/.test(d)) return 'turn';
  if (/bow/.test(d)) return 'bow';
  if (/greet|salute|shaking hands/.test(d)) return 'greet';
  if (/angr/.test(d)) return 'angry';
  if (/excited|celebrat|victory/.test(d)) return 'excited';
  if (/idle/.test(d)) return 'idle';
  if (/happ/.test(d)) return 'happy';
  return null;
}

// The rules on the features alone: [{ group, score }] best first (empty: nothing we use). A static clip (≤ 3 keys)
// is a posture candidate only.
function rulesOf(f) {
  if (!f || f.error) return [];
  const out = [];
  const add = (group, score) => out.push({ group, score: +score.toFixed(3) });
  if (f.static) {
    if (f.lean.mean > 60 && f.hips.heightMax < 0.45) add('lay', 1);
    else if (f.hips.heightMax < 0.72 && f.lean.mean < 45) add(f.hips.heightMax < 0.55 ? 'sit' : 'crouch', 0.8);
    else if (standing(f)) add('stand', 0.6);
    return out;
  }
  const upright = standing(f);
  const still = inPlace(f);
  // walk / run: the hips travel, the feet stride, the body upright
  if (f.feet.strideRange > 0.45 && f.lean.mean < 25 && f.hips.heightMin > 0.8 && f.duration <= 6) {
    if (f.hips.speed >= 0.3 && f.hips.speed < 1.8) add('walk', 1 - Math.abs(f.hips.speed - 0.9) / 2 + (f.seamDeg < 5 ? 0.2 : 0));
    else if (f.hips.speed >= 1.8 && f.hips.speed < 4) add('run', 0.6);
    else if (f.hips.speed < 0.3 && f.feet.strideSwings >= 1 && f.energy.legs > 60) add('walk', 0.5); // walked in place
  }
  if (Math.abs(f.hips.yawTurn) > 60 && f.duration < 3 && upright) add('turn', 0.4);
  if (!upright || !still) return out.sort((a, b) => b.score - a.score);
  const H = f.head;
  const hands = f.hands;
  const arms = f.energy.arms;
  // idle: long, calm, the arms down, a seam that loops
  if (f.duration >= 2 && arms < 45 && calmLegs(f) && f.energy.head < 35 && hands.bothUpFrac === 0 && hands.faceFrac < 0.15 && H.pitchRange < 25 && f.torsoPitch.range < 15) add('idle', 0.5 + Math.min(0.3, f.duration / 30) + (f.seamDeg < 8 ? 0.2 : 0) - arms / 300);
  // stretch: both hands over the head, held a while
  if (hands.bothUpFrac >= 0.15 && hands.upMax > 0.15 && f.duration >= 1.5 && f.hips.bob < 0.08) add('stretch', 0.5 + hands.bothUpFrac);
  // cheer / excited: both hands up with a bounce, or fast arms and a bounce
  if ((hands.bothUpFrac >= 0.1 && f.hips.bob >= 0.06) || (arms > 120 && f.hips.bob >= 0.08)) add('excited', 0.4 + f.hips.bob * 3);
  // wave: one hand up, swinging side to side
  if (hands.wave >= 2 && hands.oneUpFrac >= 0.15 && hands.bothUpFrac < 0.2) add('greet', 0.5 + Math.min(0.4, hands.wave / 10));
  // bow: the upper body forward and back again, hands low
  if (f.torsoPitch.max > 22 && f.torsoPitch.range > 18 && f.duration < 6 && hands.upMax < -0.3) add('bow', 0.5 + f.torsoPitch.max / 100);
  // nod / shake: the head swings on the neck, the body still
  if (H.pitchSwings >= 2 && H.pitchRange >= 12 && H.yawRange < H.pitchRange && f.torsoPitch.range < 15 && arms < 60) add('nod', 0.4 + Math.min(0.4, H.pitchSwings / 10) + H.pitchRange / 200);
  if (H.yawSwings >= 2 && H.yawRange >= 18 && H.pitchRange < H.yawRange && f.torsoPitch.range < 15 && arms < 70) add('shake', 0.4 + Math.min(0.4, H.yawSwings / 10) + H.yawRange / 200);
  // a hand at the face: a yawn (head back), thinking (held, calm), shy (head down)
  // a yawn: a hand to the mouth with the head tipped back (often with the other arm stretching up)
  if (hands.faceFrac >= 0.12 && H.pitchMin < -12 && f.duration >= 2) add('yawn', 0.9 + hands.faceFrac - H.pitchMin / 100);
  if (hands.faceFrac >= 0.15) {
    if (arms < 40 && H.pitchMean > -5 && hands.faceFrac >= 0.3) add('think', 0.4 + hands.faceFrac);
    if (H.pitchMean > 8) add('shy', 0.3 + hands.faceFrac);
  }
  // shy without the face: head down, hands together in front, small moves
  if (H.pitchMean > 12 && hands.togetherFrac > 0.3 && arms < 50) add('shy', 0.4 + hands.togetherFrac / 2);
  // clap: hands meet and part again and again in front
  if (hands.togetherFrac > 0.15 && hands.togetherFrac < 0.8 && arms > 60 && hands.frontMax > 0.15) add('clap', 0.3 + hands.togetherFrac);
  // talk: the hands gesture in front, the legs and head calm, no hand over the head
  if (f.duration >= 2.5 && arms >= 25 && arms <= 130 && calmLegs(f) && hands.travel >= 0.35 && hands.frontMax > 0.08 && hands.upMax < -0.05 && hands.wave < 2 && f.torsoPitch.range < 20) add('talk', 0.4 + Math.min(0.3, f.duration / 30) + (hands.travel > 0.6 ? 0.1 : 0));
  // point: one hand out in front, far
  if (hands.frontMax > 0.45 && arms < 90 && hands.togetherFrac < 0.1) add('point', 0.3 + hands.frontMax / 2);
  // look around: the head turns far, the arms calm
  if (H.yawRange > 45 && arms < 35 && H.yawSwings <= 3) add('look', 0.3 + H.yawRange / 200);
  // sad: head hung, the body slumped forward a little, slow
  if (H.pitchMean > 14 && arms < 30 && f.torsoPitch.mean > 3 && hands.togetherFrac < 0.3 && hands.faceFrac < 0.15 && f.duration >= 2) add('sad', 0.4 + H.pitchMean / 100);
  // surprised: a burst of the upper body early on (a flinch), a step back or the hands up, then calm
  if (f.burst && f.burst.ratio > 2.5 && f.burst.at < 0.45 && f.duration <= 5 && (f.hipsBack < -0.04 || hands.upMax > -0.35)) add('surprised', 0.3 + Math.min(0.5, f.burst.ratio / 10));
  // angry: a stamp (a foot lifted, no travel) or fists thrown forward with the body leaning in
  if ((f.feet.lift > 0.08 && f.energy.legs > 30 && hands.upMax < -0.2 && f.duration < 5) || (hands.frontMax > 0.3 && arms > 60 && f.torsoPitch.mean > 6 && hands.togetherFrac < 0.1)) add('angry', 0.3 + f.feet.lift);
  // jump: a big bounce with the feet off the floor
  if (f.hips.bob > 0.18 && f.feet.lift > 0.15) add('jump', 0.3 + f.hips.bob);
  return out.sort((a, b) => b.score - a.score);
}

// A clip's group: the review, else the label, else the best rule. { group, category, score, by } or null.
function classify(src, f, { ref = null, review = null, text = '' } = {}) {
  if (review && review.reject) return null;
  if (review && review.group) return { group: review.group, category: GROUP_CATEGORY[review.group], score: 2, by: 'review' };
  if (EXCLUDE_TEXT.test(`${src} ${text} ${(ref && ref.description) || ''}`)) return null;
  const lg = groupOfLabel(ref);
  if (!lg && ref && ref.type === 'Posture') return null; // an action / locomotion key pose: not a posture to rest in
  if (lg) return { group: lg, category: GROUP_CATEGORY[lg], score: 1.5, by: 'label' };
  const r = rulesOf(f)[0];
  return r ? { group: r.group, category: GROUP_CATEGORY[r.group], score: r.score, by: 'rule' } : null;
}

// Which style sets a source serves (docs §4): a gendered label serves its own set and — for a female source —
// neutral too (neutral models are mostly unmarked girls, T-5079 R4); an unlabelled source serves all three.
function stylesOf(ref, hint) {
  const g = String((ref && ref.gender) || hint || '').toLowerCase();
  if (g === 'female') return ['female', 'neutral'];
  if (g === 'male') return ['male'];
  return ['female', 'male', 'neutral'];
}

// The style fallback the runtime uses when a set lacks a slot (core/vrm-library.js resolve, docs §4.2).
const STYLE_FALLBACK = { female: ['female', 'neutral', 'male'], male: ['male', 'neutral', 'female'], neutral: ['neutral', 'female', 'male'] };

module.exports = { CATEGORIES, GROUP_CATEGORY, EXCLUDE_TEXT, groupOfLabel, rulesOf, classify, stylesOf, STYLE_FALLBACK, standing, inPlace };
