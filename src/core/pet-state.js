'use strict';

// Pure pet-state logic: every function takes `now` (ms) explicitly so it is
// trivially testable. Needs run 0..100: hunger 0 = full, mood 100 = joyful,
// energy 100 = rested. Affection (好感度) lives in ./affection.js; care actions here
// report what they scored as `affection`.

const aff = require('./affection');
const { unlockedTopicIds } = require('./dialogue');
const { SCHEMA_VERSION } = require('./migrate');
const { DEFAULT_OUTFIT } = require('./outfits');

const MIN = 60 * 1000;
const MAX_OFFLINE_MIN = 8 * 60; // do not punish the owner for being away

const clamp = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function isNight(now) {
  const h = new Date(now).getHours();
  return h >= 23 || h < 7;
}

function createPet({ speciesId, name, agentId, topicId = null, now }) {
  return {
    speciesId,
    name,
    agentId,
    topicId,
    createdAt: now,
    schemaVersion: SCHEMA_VERSION,
    ...aff.initialAffection(now),
    unlockedTopics: unlockedTopicIds('stranger'),
    seenUnlocks: [],
    equippedOutfit: DEFAULT_OUTFIT,
    lastSafeOutfit: DEFAULT_OUTFIT,
    hunger: 30,
    mood: 70,
    energy: 90,
    sleeping: false,
    lastTickAt: now,
    lastInteractionAt: now,
    lastFedAt: now,
    lastSpokeAt: 0,
  };
}

// Score an interaction and keep `unlockedTopics` in step with the peak stage.
function score(pet, source, now, opts) {
  const r = aff.gainAffection(pet, source, now, opts);
  if (r.unlockedStages.length) pet.unlockedTopics = unlockedTopicIds(pet.peakStage);
  return r;
}

// Merge two scoring results (e.g. "woken" then "pat") into one report for the caller.
function combine(a, b) {
  if (!a) return b;
  const idx = aff.stageIndex;
  return {
    ...b,
    delta: Math.round((a.delta + b.delta) * 10) / 10,
    parts: [...a.parts, ...b.parts],
    from: a.from,
    stageUp: idx(b.to) > idx(a.from),
    stageDown: idx(b.to) < idx(a.from),
    unlockedStages: [...a.unlockedStages, ...b.unlockedStages],
  };
}

// Force a value (test hooks only) while keeping stages and unlocks consistent.
function setAffectionForTest(pet, value) {
  const fromPeak = pet.peakStage;
  const from = pet.relStage;
  pet.affection = Math.max(0, Math.min(aff.MAX_AFFECTION, value));
  pet.relStage = aff.stageForAffection(pet.affection);
  if (aff.stageIndex(pet.relStage) > aff.stageIndex(pet.peakStage)) pet.peakStage = pet.relStage;
  pet.unlockedTopics = unlockedTopicIds(pet.peakStage);
  return { from, to: pet.relStage, stageUp: aff.stageIndex(pet.relStage) > aff.stageIndex(from), unlockedStages: aff.STAGE_IDS.slice(aff.stageIndex(fromPeak) + 1, aff.stageIndex(pet.peakStage) + 1) };
}

// Advance simulated time. Mutates and returns { pet, events, decay }.
// `decay` is the affection lost to a long absence (design 2.4), 0 most of the time.
function tick(pet, now) {
  const events = [];
  const lost = aff.decay(pet, now);
  if (lost > 0) events.push('missed');
  const dtMin = Math.min(Math.max(0, now - pet.lastTickAt) / MIN, MAX_OFFLINE_MIN);
  pet.lastTickAt = now;
  if (dtMin <= 0) return { pet, events, decay: lost };

  if (pet.sleeping) {
    pet.energy = clamp(pet.energy + dtMin * 1.2);
    pet.hunger = clamp(pet.hunger + dtMin * 0.15);
    if (pet.energy >= 100 && !isNight(now)) {
      pet.sleeping = false;
      events.push('woke');
    }
  } else {
    pet.hunger = clamp(pet.hunger + dtMin * 0.5);
    pet.energy = clamp(pet.energy - dtMin * 0.3);
    const ignoredMin = (now - pet.lastInteractionAt) / MIN;
    const drain = 0.15 + (pet.hunger > 70 ? 0.3 : 0) + (ignoredMin > 30 ? 0.1 : 0);
    pet.mood = clamp(pet.mood - dtMin * drain);
    if (pet.energy <= 10 || (isNight(now) && pet.energy < 60)) {
      pet.sleeping = true;
      events.push('slept');
    }
  }
  return { pet, events, decay: lost };
}

function touch(pet, now) {
  pet.lastInteractionAt = now;
  if (pet.sleeping) {
    pet.sleeping = false;
    pet.energy = Math.max(pet.energy, 15);
    pet.mood = clamp(pet.mood - 8); // grumpy when woken up
    return 'woken';
  }
  return null;
}

// Waking a sleeping pet costs affection (design 2.2, `woken`).
function wake(pet, now) {
  const woken = touch(pet, now);
  return { woken, penalty: woken ? score(pet, 'woken', now) : null };
}

const FOODS = {
  rice: { label: '白饭', hunger: -35, mood: 6 },
  cookie: { label: '饼干', hunger: -15, mood: 15 },
  fruit: { label: '水果', hunger: -25, mood: 8 },
};

function feed(pet, foodId, now) {
  const food = FOODS[foodId] || FOODS.rice;
  const { woken, penalty } = wake(pet, now);
  if (pet.hunger < 8) {
    // Overfed: tummy ache, small mood loss, and a little affection.
    pet.mood = clamp(pet.mood - 5);
    return { ok: false, reason: 'full', woken, affection: combine(penalty, score(pet, 'feed_full', now)) };
  }
  pet.hunger = clamp(pet.hunger + food.hunger);
  pet.mood = clamp(pet.mood + food.mood);
  pet.lastFedAt = now;
  return { ok: true, food: food.label, woken, affection: combine(penalty, score(pet, 'feed', now)) };
}

function pat(pet, now) {
  const { woken, penalty } = wake(pet, now);
  pet.mood = clamp(pet.mood + 8);
  return { ok: true, woken, affection: combine(penalty, score(pet, 'pat', now)) };
}

function play(pet, now) {
  const { woken, penalty } = wake(pet, now);
  if (pet.energy < 15) return { ok: false, reason: 'tired', woken, affection: penalty };
  pet.mood = clamp(pet.mood + 12);
  pet.energy = clamp(pet.energy - 10);
  pet.hunger = clamp(pet.hunger + 5);
  return { ok: true, woken, affection: combine(penalty, score(pet, 'play', now)) };
}

// The agent answered a chat. Only a real message (2+ characters) scores (design 2.2).
function chatted(pet, now, { textLength = 2 } = {}) {
  const { penalty } = wake(pet, now);
  pet.mood = clamp(pet.mood + 3);
  if (textLength < 2) return { affection: penalty };
  return { affection: combine(penalty, score(pet, 'chat', now)) };
}

// The agent answered a topic from the topic panel; each topic scores once a day.
function talkedTopic(pet, topicId, now) {
  const { penalty } = wake(pet, now);
  pet.mood = clamp(pet.mood + 4);
  return { affection: combine(penalty, score(pet, 'topic', now, { topicId })) };
}

// Tucking the pet in between 22:00 and 02:00 earns a little affection once a day.
function putToSleep(pet, now) {
  pet.lastInteractionAt = now;
  pet.sleeping = true;
  return { ok: true, affection: score(pet, 'sleep', now) };
}

// Which animation / mood face should the sprite show right now?
function currentStatus(pet) {
  if (pet.sleeping) return 'sleep';
  if (pet.hunger >= 75) return 'hungry';
  if (pet.mood <= 25) return 'sad';
  if (pet.mood >= 75) return 'happy';
  return 'idle';
}

module.exports = {
  FOODS,
  clamp,
  isNight,
  createPet,
  tick,
  feed,
  pat,
  play,
  chatted,
  talkedTopic,
  putToSleep,
  setAffectionForTest,
  touch,
  currentStatus,
  toAffectionProgress: aff.toAffectionProgress,
};
