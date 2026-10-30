'use strict';

// Decides *when* the pet should speak on its own. Pure function over pet state;
// the caller decides whether to spend an LLM call or use the offline fallback.

const { stageLines } = require('./dialogue');

const MIN = 60 * 1000;

const DEFAULTS = {
  speakCooldownMin: 12, // never speak twice within this window
  boredAfterMin: 45,
  hungryAt: 75,
  maxLlmPerHour: 6,
};

function pick(arr, rnd = Math.random) {
  return arr[Math.floor(rnd() * arr.length)];
}

// Returns an event kind or null.
function nextEvent(pet, now, opts = {}, rnd = Math.random) {
  const o = { ...DEFAULTS, ...opts };
  if (pet.sleeping) return null;
  if (now - pet.lastSpokeAt < o.speakCooldownMin * MIN) return null;

  if (pet.hunger >= o.hungryAt) return 'hungry';

  const idleMin = (now - pet.lastInteractionAt) / MIN;
  if (idleMin >= o.boredAfterMin && rnd() < 0.5) return 'bored';

  const h = new Date(now).getHours();
  const day = new Date(now).toDateString();
  if (pet.lastGreetDay !== day) {
    if (h >= 6 && h < 11) return 'greet_morning';
    if (h >= 20 && h < 23) return 'greet_evening';
  }
  return null;
}

// Hourly budget so a chatty pet cannot run up the bill.
class LlmBudget {
  constructor(maxPerHour = DEFAULTS.maxLlmPerHour) {
    this.max = maxPerHour;
    this.stamps = [];
  }
  canSpend(now) {
    this.stamps = this.stamps.filter((t) => now - t < 60 * MIN);
    return this.stamps.length < this.max;
  }
  spend(now) {
    this.stamps.push(now);
  }
}

// Offline line for an event. With `pet` given, lines from the pet's relationship stage
// (src/core/dialogue.js) join the species' own lines; adult lines only when `settings` allow them.
function fallbackLine(species, kind, rnd = Math.random, pet = null, settings = null) {
  return pick(fallbackPool(species, kind, pet, settings), rnd);
}

// Every line fallbackLine() may pick for `kind` (互动语音 synthesises these ahead, pet-service.js voiceLines).
function fallbackPool(species, kind, pet = null, settings = null) {
  const map = { hungry: 'hungry', bored: 'bored', greet_morning: 'greet', greet_evening: 'sleepy', stage_up: 'happy', met: 'greet', missed: 'greet', fed: 'happy', patted: 'happy', played: 'happy' };
  // fed / patted / played: her own lines when her file has them (互动语音 reads them in her voice)
  const own = ['fed', 'patted', 'played'].includes(kind) && Array.isArray(species.fallback[kind]) && species.fallback[kind].length ? species.fallback[kind] : null;
  const lines = own || species.fallback[map[kind] || 'happy'] || species.fallback.happy;
  if (!pet) return [...lines];
  const stageKind = { greet_morning: 'greet', met: 'greet', missed: 'greet' }[kind] || kind;
  const staged = stageLines(pet, settings, stageKind);
  // Stage-up and interaction feedback speak for the new relationship; other events mix in the species' voice.
  // (her own fed / patted / played lines stay in the pool next to the stage's)
  if (own) return [...own, ...staged];
  return staged.length && ['stage_up', 'fed', 'patted', 'played'].includes(kind) ? staged : [...lines, ...staged];
}

module.exports = { nextEvent, LlmBudget, fallbackLine, fallbackPool, DEFAULTS, pick };
