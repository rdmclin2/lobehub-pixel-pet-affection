'use strict';

// Save-file migration from the growth system (schema 1: `xp` + `stage`) to affection (schema 2).
// Pure: `migratePet(raw, now)` never touches disk. See docs/affection-design.md section 6.

const { initialAffection, stageForAffection, stageIndex, STAGE_IDS, MAX_AFFECTION } = require('./affection');
const { unlockedTopicIds } = require('./dialogue');
const { OUTFIT_IDS, DEFAULT_OUTFIT, hasArt } = require('./outfits');
const { resolveSpeciesId } = require('./species');

const SCHEMA_VERSION = 2;
const MIGRATION_CAP = 50; // migrated pets top out in 亲近 and never land in an adult stage

const needsMigration = (raw) => !!raw && typeof raw === 'object' && !(raw.schemaVersion >= SCHEMA_VERSION);

// xp is the source of truth; `stage` is only a fallback when xp is unusable.
function affectionFromLegacy(xp, stage) {
  if (typeof xp === 'number' && Number.isFinite(xp) && xp >= 0) {
    if (xp < 60) return Math.floor((xp / 60) * 15);
    if (xp < 240) return 15 + Math.floor(((xp - 60) / 180) * 20);
    return 35 + Math.min(Math.floor((xp - 240) / 40), 15);
  }
  return { baby: 0, child: 15, adult: 35 }[stage] ?? 0;
}

// Fill missing schema-2 fields on an already-migrated save (tolerates hand-edited files).
function normalizePet(pet, now) {
  const base = initialAffection(now, typeof pet.affection === 'number' && Number.isFinite(pet.affection) ? pet.affection : 0);
  const out = { ...base, ...pet };
  out.affection = base.affection;
  out.relStage = stageForAffection(out.affection);
  // peakStage never sits below the current stage; an unknown value falls back to it.
  out.peakStage = STAGE_IDS.includes(pet.peakStage) && stageIndex(pet.peakStage) > stageIndex(out.relStage) ? pet.peakStage : out.relStage;
  for (const k of ['dailyCounts', 'lastAffectionAt']) if (!out[k] || typeof out[k] !== 'object') out[k] = {};
  if (!Array.isArray(out.topicsToday)) out.topicsToday = [];
  if (!Array.isArray(out.seenUnlocks)) out.seenUnlocks = [];
  // A retired character (焰团 / 泡鲸 / 叶芽, before the model-chan roster) or an unknown one is taken
  // over by a current character; the agent, its chat history and the affection stay.
  const species = resolveSpeciesId(pet.speciesId);
  if (species !== pet.speciesId) {
    out.retiredFrom = { speciesId: typeof pet.speciesId === 'string' ? pet.speciesId.slice(0, 20) : null, at: now };
    out.speciesId = species;
  }
  // An unknown or missing outfit (older saves, hand edits), or one the character has no art for,
  // falls back to the default outfit.
  if (!OUTFIT_IDS.includes(out.equippedOutfit) || !hasArt(out.speciesId, out.equippedOutfit)) out.equippedOutfit = DEFAULT_OUTFIT;
  if (!OUTFIT_IDS.includes(out.lastSafeOutfit) || !hasArt(out.speciesId, out.lastSafeOutfit)) out.lastSafeOutfit = DEFAULT_OUTFIT;
  out.unlockedTopics = unlockedTopicIds(out.peakStage);
  out.schemaVersion = SCHEMA_VERSION;
  delete out.xp;
  delete out.stage;
  return out;
}

// Returns { pet, migrated, remapped }. `pet` is null for a missing / corrupt save. `remapped` is the
// retired character id when a current one took over.
function migratePet(raw, now) {
  if (!raw || typeof raw !== 'object') return { pet: null, migrated: false, remapped: null };
  const remapped = resolveSpeciesId(raw.speciesId) !== raw.speciesId ? raw.speciesId || null : null;
  if (!needsMigration(raw)) return { pet: normalizePet(raw, now), migrated: false, remapped };
  const { xp, stage, ...rest } = raw;
  const affection = Math.min(MIGRATION_CAP, MAX_AFFECTION, affectionFromLegacy(xp, stage));
  const pet = normalizePet({ ...rest, ...initialAffection(now, affection), seenUnlocks: [], legacy: { xp: xp ?? null, stage: stage ?? null, migratedAt: now } }, now);
  return { pet, migrated: true, remapped };
}

module.exports = { SCHEMA_VERSION, MIGRATION_CAP, needsMigration, affectionFromLegacy, normalizePet, migratePet };
