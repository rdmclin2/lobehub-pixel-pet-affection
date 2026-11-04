// 重置姿势 (T-2830): the pet-state side of the owner's "back to the idle", kept out of core/pet-state.js — that
// file is frozen for the pixel characters (test/vrm-pack-style.test.js, docs/vrm-motion-system.md §2.1/§9.3).
//
// Asleep, she wakes up — without the grumpy mood or the affection a wake costs (it is a fix for a stuck pose,
// not an interaction) — and stays up for RESET_AWAKE_MIN (else at night the next tick would put her straight
// back to sleep). Awake: nothing changes. The grace lives in `pet.awakeUntil` and is honoured by `tick` below,
// the wrapper the service calls instead of pet-state's own.
const state = require('./pet-state');

const MIN = 60 * 1000;
const RESET_AWAKE_MIN = 15;

// → woke?
function wakeForReset(pet, now) {
  if (!pet.sleeping) return false;
  pet.sleeping = false;
  pet.energy = Math.max(pet.energy, 15);
  pet.awakeUntil = now + RESET_AWAKE_MIN * MIN;
  return true;
}

// pet-state.tick, except that inside the grace she does not fall asleep on her own. Falling asleep is the last
// thing an awake tick does (after the needs moved), so undoing it leaves exactly what a guarded tick would.
function tick(pet, now) {
  const wasAwake = !pet.sleeping;
  const r = state.tick(pet, now);
  if (wasAwake && pet.sleeping && pet.awakeUntil > now) {
    pet.sleeping = false;
    const i = r.events.indexOf('slept');
    if (i >= 0) r.events.splice(i, 1);
  }
  return r;
}

module.exports = { wakeForReset, tick, RESET_AWAKE_MIN };
