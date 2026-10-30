'use strict';

// Save-file migrations. Pure: `migratePet(raw, now)` never touches disk.
// schema 1 -> 2: the growth system (`xp` + `stage`) becomes affection (docs/affection-design.md section 6).
// schema 2 -> 3: one flat pet becomes per-character entries (`pet.characters[speciesId]`), each with her own
// agent, topic, name, affection and needs; the owner-level fields (SHARED_KEYS) stay at the top.

const { initialAffection, stageForAffection, stageIndex, STAGE_IDS, MAX_AFFECTION } = require('./affection');
const { unlockedTopicIds } = require('./dialogue');
const { OUTFIT_IDS, DEFAULT_OUTFIT, hasArt } = require('./outfits');
const { resolveSpeciesId } = require('./species');

const SCHEMA_VERSION = 3;
const MIGRATION_CAP = 50; // migrated pets top out in 亲近 and never land in an adult stage

// Fields of the whole save; everything else belongs to one character. `createdAt` is both: the hatch at the
// top, the day she was met in her entry.
const SHARED_KEYS = ['schemaVersion', 'speciesId', 'characters', 'space', 'owner', 'localAbilities', 'createdAt', 'legacy', 'retiredFrom', 'retiredCharacters'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
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

// Fill missing fields of one character's state (tolerates hand-edited files). The entry carries its own
// `speciesId`, so every core function can take it as "the pet".
function normalizeCharacter(pet, speciesId, now) {
  const base = initialAffection(now, typeof pet.affection === 'number' && Number.isFinite(pet.affection) ? pet.affection : 0);
  const out = { ...base, ...pet, speciesId };
  out.affection = base.affection;
  out.relStage = stageForAffection(out.affection);
  // peakStage never sits below the current stage; an unknown value falls back to it.
  out.peakStage = STAGE_IDS.includes(pet.peakStage) && stageIndex(pet.peakStage) > stageIndex(out.relStage) ? pet.peakStage : out.relStage;
  for (const k of ['dailyCounts', 'lastAffectionAt']) if (!out[k] || typeof out[k] !== 'object') out[k] = {};
  if (!Array.isArray(out.topicsToday)) out.topicsToday = [];
  if (!Array.isArray(out.seenUnlocks)) out.seenUnlocks = [];
  // An unknown or missing outfit (older saves, hand edits), or one the character has no art for,
  // falls back to the default outfit.
  if (!OUTFIT_IDS.includes(out.equippedOutfit) || !hasArt(out.speciesId, out.equippedOutfit)) out.equippedOutfit = DEFAULT_OUTFIT;
  if (!OUTFIT_IDS.includes(out.lastSafeOutfit) || !hasArt(out.speciesId, out.lastSafeOutfit)) out.lastSafeOutfit = DEFAULT_OUTFIT;
  out.unlockedTopics = unlockedTopicIds(out.peakStage);
  delete out.schemaVersion;
  delete out.xp;
  delete out.stage;
  return out;
}

// A retired character (焰团 / 泡鲸 / 叶芽, before the model-chan roster) or an unknown one is taken over by a
// current character; her agent, its chat history and the affection stay.
function retire(id, now) {
  const to = resolveSpeciesId(id);
  return { to, retiredFrom: to === id ? null : { speciesId: typeof id === 'string' ? id.slice(0, 20) : null, at: now } };
}

// schema 2 (one flat pet) -> schema 3: everything that is not owner-level goes to the current character.
// Other characters get an entry when they are first met.
function splitCharacters(flat, now) {
  const { to, retiredFrom } = retire(flat.speciesId, now);
  const top = { schemaVersion: SCHEMA_VERSION, speciesId: to };
  const own = {};
  for (const [k, v] of Object.entries(flat)) {
    if (k === 'createdAt') top[k] = own[k] = v;
    else if (SHARED_KEYS.includes(k)) {
      if (k !== 'schemaVersion' && k !== 'speciesId' && k !== 'characters') top[k] = v;
    } else own[k] = v;
  }
  if (retiredFrom) top.retiredFrom = retiredFrom;
  top.characters = { [to]: normalizeCharacter(own, to, now) };
  return top;
}

// A schema-3 save: normalize every entry. A retired character's entry moves to the one taking over; if that
// one has her own already, the retired entry is kept aside (`retiredCharacters`) so 放生 can still delete its agent.
function normalizeSave(raw, now) {
  const chars = isObj(raw.characters) ? raw.characters : {};
  const out = { ...raw, schemaVersion: SCHEMA_VERSION, characters: {} };
  const aside = isObj(raw.retiredCharacters) ? { ...raw.retiredCharacters } : {};
  const retiredIds = [];
  for (const [id, entry] of Object.entries(chars)) {
    if (!isObj(entry)) continue;
    const { to } = retire(id, now);
    if (to !== id) retiredIds.push(id);
    else out.characters[id] = normalizeCharacter(entry, id, now);
  }
  for (const id of retiredIds) {
    const { to } = retire(id, now);
    if (out.characters[to]) aside[id] = chars[id];
    else out.characters[to] = normalizeCharacter(chars[id], to, now);
  }
  if (Object.keys(aside).length) out.retiredCharacters = aside;
  const { to, retiredFrom } = retire(raw.speciesId, now);
  if (retiredFrom) out.retiredFrom = retiredFrom;
  out.speciesId = out.characters[to] ? to : Object.keys(out.characters)[0];
  return out.speciesId ? out : null;
}

// The growth system's flat pet (schema 1) as a flat schema-2 pet.
function fromGrowth(raw, now) {
  const { xp, stage, ...rest } = raw;
  const affection = Math.min(MIGRATION_CAP, MAX_AFFECTION, affectionFromLegacy(xp, stage));
  return { ...rest, ...initialAffection(now, affection), seenUnlocks: [], legacy: { xp: xp ?? null, stage: stage ?? null, migratedAt: now } };
}

// Returns { pet, migrated, from, remapped }. `pet` is null for a missing / corrupt save. `from` is the schema
// the save was written with (1, 2, 3). `remapped` is the retired character id when a current one took over.
function migratePet(raw, now) {
  if (!isObj(raw)) return { pet: null, migrated: false, from: null, remapped: null };
  const from = raw.schemaVersion >= 3 ? 3 : raw.schemaVersion >= 2 ? 2 : 1;
  const remapped = resolveSpeciesId(raw.speciesId) !== raw.speciesId ? raw.speciesId || null : null;
  if (from === 3) {
    const pet = normalizeSave(raw, now);
    return { pet, migrated: false, from, remapped: pet ? remapped : null };
  }
  const pet = splitCharacters(from === 1 ? fromGrowth(raw, now) : raw, now);
  return { pet, migrated: true, from, remapped };
}

// The current character's entry ("the pet" for pet-state, persona, dialogue, outfits), or null.
const cur = (pet) => (pet && pet.characters && pet.characters[pet.speciesId]) || null;

module.exports = { SCHEMA_VERSION, SHARED_KEYS, MIGRATION_CAP, needsMigration, affectionFromLegacy, normalizeCharacter, migratePet, cur };
