'use strict';

// One-time migration to 「每个形象就是一个角色」 (T-2764, docs/characters.md 「角色与形象」). Pure: never touches disk;
// PetService runs it whenever settings.json / pet.json are loaded and saves (with a backup) only what changed.
//
// Before: a character was a persona (`dafeiyu`, `claude`, …) and the owner chose which 形象包 she wore
// (settings.appearance = { dafeiyu: 'dafeiyu-live2d' }). Per persona were kept: 取景 (settings.framings), the
// model, 个性化设定, the 同屏伙伴 list (settings.visitors) and, in pet.json, her whole state incl. the outfit she
// wore. Per pack: the VRM posture (settings.vrmPostures).
// After: every look is a character (core/characters.js). Rules, old key → new key:
//
//   settings.appearance[base] = pack      → pet.json `characterId` (the current base's choice) and the start of
//                                           every visitor id; the key itself is dropped (kept read-only as
//                                           settings.legacyAppearance, so a pet.json migrated later still finds it)
//   pet.speciesId = base (current)        → pet.characterId = the character of her chosen pack (unknown / removed
//                                           pack → her default character); pet.speciesId stays, now = its base
//   settings.framings[base] = mode        → settings.framings[<each of her characters>] = mode (an own choice made
//                                           under the new model is never overwritten)
//   settings.visitors = [base, …]         → [<her chosen character>, …] (unknown ids dropped)
//   characters[base].equippedOutfit /     → characters[base].wardrobes[<each of her characters>] = { equippedOutfit,
//     lastSafeOutfit                         lastSafeOutfit } (each one's own wardrobe from then on; an outfit her
//                                           pack has no art for falls back to daily when she is shown)
//   settings.vrmPostures[pack]            → unchanged: a character's id is her pack's id
//   settings.models[base], systemRoles[base], characters[base] (agent, topic / 聊天记录, name, 好感度, needs,
//     unlocks), chat-log speciesId, 语音包 (by base)  → unchanged: shared by all characters of the same base
//
// Idempotent: the result carries `characterModel: 2` (settings and pet.json alike) and is returned unchanged when
// run again; a file without the mark is migrated once.

const { SPECIES, RETIRED } = require('./species');
const C = require('./characters');
const Catalog = require('./catalog');
const { DEFAULT_OUTFIT, OUTFIT_IDS } = require('./outfits');

const CHARACTER_MODEL = 2;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const migrated = (o) => isObj(o) && o.characterModel >= CHARACTER_MODEL;

// An old per-persona key → the base it means now (a retired one → her successor), or null.
function baseKey(k) {
  if (Object.hasOwn(SPECIES, k)) return k;
  if (Object.hasOwn(RETIRED, k) && SPECIES[RETIRED[k]]) return RETIRED[k];
  return null;
}

// The character `base` wore under the old model: her chosen pack when it still exists and is hers (an 18+ one
// too: the choice is kept, as before; it is shown once adult content is on), else her default character.
// A look that no longer ships with the app but can be downloaded (core/catalog.js: 旧版像素, Live2D, 成年版, …)
// is kept too: she is shown as her default character until it is downloaded, then becomes it again
// (PetService._cid), so `keepDownloadable: false` is only for lists that need her on the desktop now (visitors).
function chosenCharacter(packs, appearance, base, { keepDownloadable = true } = {}) {
  const want = isObj(appearance) ? appearance[base] : null;
  const e = typeof want === 'string' ? C.characterById(packs, want) : null;
  if (e && e.base === base) return e.id;
  const d = keepDownloadable && typeof want === 'string' ? Catalog.entry(want) : null;
  if (d && d.base === base) return d.id;
  return C.defaultCharacter(packs, base, true);
}

// Every character of a base, 18+ included, and the downloadable ones she may become later (their 取景 and
// wardrobe are kept for then).
const charactersOf = (packs, base) => [...new Set([...C.listCharacters(packs, { all: true }).filter((e) => e.base === base).map((e) => e.id), ...Catalog.loadIndex().characters.filter((c) => c.base === base).map((c) => c.id)])];

// settings.json (normalized or raw). -> { settings, changed }
function migrateSettings(settings, packs) {
  if (!isObj(settings) || migrated(settings)) return { settings, changed: false };
  const ap = isObj(settings.appearance) ? Object.fromEntries(Object.entries(settings.appearance).filter(([k, v]) => baseKey(k) && typeof v === 'string')) : {};
  // a retired persona's choice goes to her successor unless the successor has her own
  for (const [k, v] of Object.entries(ap)) if (baseKey(k) !== k) { if (!ap[baseKey(k)]) ap[baseKey(k)] = v; delete ap[k]; }

  const framings = {};
  const old = isObj(settings.framings) ? settings.framings : {};
  for (const [k, v] of Object.entries(old)) if (!baseKey(k)) framings[k] = v; // already per character
  for (const [k, v] of Object.entries(old)) {
    const base = baseKey(k);
    if (!base) continue;
    for (const id of charactersOf(packs, base)) if (!Object.hasOwn(framings, id)) framings[id] = v;
  }

  const visitors = [];
  for (const v of Array.isArray(settings.visitors) ? settings.visitors : []) {
    const base = typeof v === 'string' ? baseKey(v) : null;
    const id = base ? chosenCharacter(packs, ap, base, { keepDownloadable: false }) : C.characterById(packs, v) ? v : null;
    if (id && !visitors.includes(id)) visitors.push(id);
  }

  const { appearance: _gone, ...rest } = settings;
  return { settings: { ...rest, framings, visitors, legacyAppearance: ap, characterModel: CHARACTER_MODEL }, changed: true };
}

const outfitOr = (v) => (OUTFIT_IDS.includes(v) ? v : DEFAULT_OUTFIT);

// pet.json (schema 3, after core/migrate.js). `appearance`: the old settings.appearance (or legacyAppearance).
// -> { pet, changed }
function migratePet(pet, { packs, appearance = {} } = {}) {
  if (!isObj(pet) || migrated(pet)) return { pet, changed: false };
  const characters = {};
  for (const [base, c] of Object.entries(isObj(pet.characters) ? pet.characters : {})) {
    if (!isObj(c) || !SPECIES[base]) { characters[base] = c; continue; }
    const wardrobes = isObj(c.wardrobes) ? { ...c.wardrobes } : {};
    const worn = { equippedOutfit: outfitOr(c.equippedOutfit), lastSafeOutfit: outfitOr(c.lastSafeOutfit) };
    const ids = charactersOf(packs, base);
    const chosen = chosenCharacter(packs, appearance, base);
    if (!ids.includes(chosen)) ids.push(chosen);
    for (const id of ids) if (!isObj(wardrobes[id])) wardrobes[id] = { ...worn };
    characters[base] = { ...c, wardrobes };
  }
  const base = SPECIES[pet.speciesId] ? pet.speciesId : Object.keys(characters).find((k) => SPECIES[k]) || null;
  const characterId = base ? chosenCharacter(packs, appearance, base) : null;
  return { pet: { ...pet, characters, characterId, characterModel: CHARACTER_MODEL }, changed: true };
}

// Both at once (the order PetService loads them in). The pet's choice comes from the settings before they lose
// `appearance`, or from `legacyAppearance` when the settings were migrated first (no pet then, or an older
// pet.json restored afterwards).
function migrateAll({ settings, pet, packs }) {
  const s = migrateSettings(settings, packs);
  const appearance = isObj(s.settings) && isObj(s.settings.legacyAppearance) ? s.settings.legacyAppearance : {};
  const p = migratePet(pet, { packs, appearance });
  return { settings: s.settings, pet: p.pet, settingsChanged: s.changed, petChanged: p.changed };
}

module.exports = { CHARACTER_MODEL, migrateSettings, migratePet, migrateAll, chosenCharacter, baseKey };
