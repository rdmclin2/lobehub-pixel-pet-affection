'use strict';

// 角色 (T-2764): one roster entry per look. There is no 形象包 (appearance pack) to choose any more: every pet
// pack — built-in (dafeiyu-pixel, dafeiyu-live2d, claude-classic, …) or imported by the owner (a pack, a Live2D
// or a VRM model) — is a character of its own, with its own id, name, kind, picture and wardrobe. A video
// character's own clips (dafeiyu-clips) are one more. Electron-free so it can be tested.
//
// Ids: a character's id is her pack's id (`dafeiyu-pixel`, `vrm-claude-alice`, …) or `<base>-clips`. A pack may
// not take the id of a character file (core/packs.js validatePack), so an old per-persona id (`dafeiyu`, `claude`,
// a retired `bubbo`, src/core/species.js) is never also a character id: character-migrate.js relies on that.
//
// Persona vs look. Every character stands on a *base* character file (src/characters/<base>.json: her persona,
// lines, touch zones, voice, vendor models): 「大肥鱼 · 像素」 and 「大肥鱼 · Live2D」 are both 大肥鱼. What she *is*
// stays with the base and is shared by all her characters — her LobeHub agent and its chat history (聊天记录),
// the name the owner gave her, affection (好感度) and its unlocks, needs, the model she runs on, 个性化设定 and
// her 语音包: the same girl, met once, in whatever look. What she *looks like* is per character: her wardrobe
// (the outfits her own pack has art for, the one she wears, the last all-ages one), 取景 and the VRM posture.
// See docs/characters.md 「角色与形象」.

const { SPECIES, SPECIES_IDS, RETIRED, DEFAULT_SPECIES } = require('./species');

const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const isCharacterId = (id) => typeof id === 'string' && ID_RE.test(id);
// an id from before T-2764: a character file (a base) or a retired one
const isSpeciesId = (id) => typeof id === 'string' && (Object.hasOwn(SPECIES, id) || Object.hasOwn(RETIRED, id));

const KIND_LABEL = { sprites: '像素', pictures: '图片', rig: '全动态', live2d: 'Live2D', vrm: 'VRM', video: '视频' };

// The id standing for a video character's own clips (null for a character without clips).
const clipsId = (base) => (SPECIES[base] && SPECIES[base].clipsLook ? `${base}-clips` : null);
// Her clips are a downloaded character too (core/catalog.js): the pack store marks the installed ones on its
// Map as `packs.clips` (a Set of `<base>-clips` ids, src/main/packs.js). Not installed = not a character.
const hasClips = (map, base) => !!clipsId(base) && map.clips instanceof Set && map.clips.has(clipsId(base));

const asMap = (packs) => (packs instanceof Map ? packs : new Map((Array.isArray(packs) ? packs : []).map((p) => [p.id, p])));
// where a character comes from: 内置 (ships with the app), 下载 (from the catalog), 导入 (the owner's own)
const sourceOf = (p) => (p.source === 'user' || p.source === 'download' ? p.source : 'builtin');

// 「大肥鱼 · 像素」: a pack's own name when it already says whose it is, else her name in front.
function displayName(base, packName) {
  const sp = SPECIES[base];
  const nm = sp ? sp.nameZh : base;
  const n = String(packName || '').trim();
  if (!n) return nm;
  return n.startsWith(nm) ? n : `${nm} · ${n}`;
}

// What sets this look apart in her name (「像素」「Live2D」「成年版（18+）」), for short labels.
function lookLabel(base, name) {
  const sp = SPECIES[base];
  const prefix = sp ? `${sp.nameZh} · ` : '';
  return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function entryOf(p) {
  const name = displayName(p.species, p.name);
  return { id: p.id, base: p.species, packId: p.id, clips: false, name, label: lookLabel(p.species, name), kind: p.kind, kindLabel: KIND_LABEL[p.kind] || p.kind, adult: !!p.adult, source: sourceOf(p) };
}

function clipsEntry(base) {
  const sp = SPECIES[base];
  const name = displayName(base, sp.clipsLook.name);
  return { id: clipsId(base), base, packId: null, clips: true, name, label: lookLabel(base, name), kind: 'video', kindLabel: KIND_LABEL.video, adult: false, source: 'download' };
}

// A base none of whose packs is loaded (a broken install, tests without packs) is still one character: her
// fallback pack's id, with no art (she is drawn as nothing / her clips until the pack is back).
const fallbackId = (base) => (SPECIES[base] && SPECIES[base].fallbackPack) || `${base}-pixel`;
function stubEntry(base) {
  const name = displayName(base, '');
  return { id: fallbackId(base), base, packId: fallbackId(base), clips: false, name, label: '', kind: null, kindLabel: '--', adult: false, source: 'builtin', missing: true };
}

// Every character, in roster order: base by base (the order of src/characters), and per base her built-in looks
// in the order of her file (the default first), then the owner's imports (by name), then her clips.
// 18+ looks only when `adultOk` (the user confirmed 18+ and turned adult content on), unless `all`.
function listCharacters(packs, { adultOk = false, all = false } = {}) {
  const map = asMap(packs);
  const out = [];
  for (const base of SPECIES_IDS) {
    const own = SPECIES[base].packs || [];
    const rank = (p) => (own.includes(p.id) ? own.indexOf(p.id) : own.length);
    const mine = [...map.values()].filter((p) => p.species === base).sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
    for (const p of mine) if (all || adultOk || !p.adult) out.push(entryOf(p));
    // a generic companion (core/generic.js) without her model is not listed: she has no look to show
    if (!mine.length && !hasClips(map, base) && !SPECIES[base].virtual) out.push(stubEntry(base));
    if (hasClips(map, base)) out.push(clipsEntry(base));
  }
  return out;
}

// One character by id (any, 18+ included), or null when there is none (an unknown or removed pack).
function characterById(packs, id) {
  if (!isCharacterId(id)) return null;
  const map = asMap(packs);
  const base = id.endsWith('-clips') ? id.slice(0, -'-clips'.length) : null;
  if (base && clipsId(base) === id) return hasClips(map, base) ? clipsEntry(base) : null;
  const p = map.get(id);
  if (p) return SPECIES[p.species] ? entryOf(p) : null;
  // her fallback pack when none of hers is loaded at all (stubEntry)
  const stub = SPECIES_IDS.find((b) => !SPECIES[b].virtual && fallbackId(b) === id && ![...map.values()].some((x) => x.species === b));
  return stub ? stubEntry(stub) : null;
}

// May she be shown now? 18+ looks only with adult content on.
const available = (entry, adultOk) => !!entry && (adultOk || !entry.adult);

// The character a base is first met as: her file's first pack, then her fallback pack, then any look she has.
function defaultCharacter(packs, base, adultOk = false) {
  const sp = SPECIES[base];
  if (!sp) return null;
  const map = asMap(packs);
  for (const id of [sp.defaultPack, sp.fallbackPack]) {
    const e = id && characterById(map, id);
    if (e && e.base === base && available(e, adultOk)) return e.id;
  }
  const any = listCharacters(map, { adultOk }).find((e) => e.base === base);
  return any ? any.id : sp.fallbackPack || `${base}-pixel`;
}

// The character a saved id stands for now. A character that still exists (and may be shown) is itself; an old
// per-persona id (`dafeiyu`, a retired `bubbo`) is that persona's default character; an unknown or removed one
// (an imported pack deleted since, an 18+ look with adult content off) falls back to her base's default when the
// base is known from `baseHint`, else to the app's default character.
function resolveCharacterId(packs, id, { adultOk = false, baseHint = null } = {}) {
  const map = asMap(packs);
  const e = characterById(map, id);
  if (available(e, adultOk)) return e.id;
  if (e) return defaultCharacter(map, e.base, adultOk);
  if (isSpeciesId(id)) {
    const base = SPECIES[id] ? id : SPECIES[RETIRED[id]] ? RETIRED[id] : DEFAULT_SPECIES;
    return defaultCharacter(map, base, adultOk);
  }
  const hint = typeof baseHint === 'string' && SPECIES[baseHint] ? baseHint : null;
  if (!hint && typeof id === 'string') {
    // `vrm-claude-…` / `l2d-gpt-…` / `grok-adult`: the base is in the id even when the pack is gone
    const m = /^(?:vrm-|l2d-)?([a-z][a-z0-9]{1,19})-/.exec(id);
    if (m && SPECIES[m[1]]) return defaultCharacter(map, m[1], adultOk);
  }
  return defaultCharacter(map, hint || DEFAULT_SPECIES, adultOk);
}

// The base (persona) of a character id; an old per-persona id is its own base. null = unknown.
function baseOf(packs, id) {
  const e = characterById(packs, id);
  if (e) return e.base;
  if (typeof id === 'string' && Object.hasOwn(SPECIES, id)) return id;
  return null;
}

module.exports = { ID_RE, KIND_LABEL, isCharacterId, isSpeciesId, clipsId, displayName, lookLabel, listCharacters, characterById, available, defaultCharacter, resolveCharacterId, baseOf };
