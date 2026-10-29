'use strict';

// Pet packs (角色包): how a companion looks. A pack is a folder with a `pack.json` and its images; the
// app ships some (src/renderer/packs) and loads the user's own from <userData>/packs. A pack only
// supplies art for the app's outfits; which outfits exist, when they unlock and how they are rated stay
// with the app (src/core/outfits.js), so an imported pack cannot change what is shown to whom.
// Format: docs/pet-packs.md. Electron-free so it can be tested.

const fs = require('node:fs');
const path = require('node:path');
const { OUTFIT_IDS } = require('./outfits');
const { SPECIES, SPECIES_IDS } = require('./species');
const { STATES } = require('./fx');

// Schema 2 names a sprite action after the app's states (the DeepSeek pet's 15 states plus `lifted`,
// see src/core/fx.js). Schema 1 packs keep their 8 older action names; the app maps states onto
// them (fx.ALIASES) and anything missing falls back along fx.FALLBACK to `idle`.
const SCHEMA = 2;
const SCHEMAS = [1, 2];
const ACTIONS_V1 = ['idle', 'wave', 'lifted', 'eat', 'sleep', 'think', 'talk', 'cheer'];
const ACTIONS = { 1: ACTIONS_V1, 2: STATES };
const KINDS = ['sprites', 'pictures'];
const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const IMAGE_RE = /\.(png|webp|gif|jpe?g)$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// A file inside the pack: relative, no "..", an image that exists and is not too big.
function packFile(dir, rel, errors, label) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !IMAGE_RE.test(rel)) {
    errors.push(`${label}: "${rel}" must be a relative path to a png / webp / gif / jpg inside the pack`);
    return null;
  }
  const abs = path.resolve(dir, rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep)) {
    errors.push(`${label}: "${rel}" points outside the pack`);
    return null;
  }
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    errors.push(`${label}: ${rel} is missing`);
    return null;
  }
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) {
    errors.push(`${label}: ${rel} is not a file under ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    return null;
  }
  return rel.split(path.sep).join('/');
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const posInt = (v) => Number.isInteger(v) && v > 0;

// Validate a manifest read from `dir`. Returns { ok: true, pack } or { ok: false, errors }.
function validatePack(manifest, dir) {
  const errors = [];
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  if (!SCHEMAS.includes(m.schema)) errors.push(`schema must be one of ${SCHEMAS.join(', ')}`);
  const known = ACTIONS[m.schema] || ACTIONS[SCHEMA];
  if (!ID_RE.test(m.id || '')) errors.push('id must be 3–40 characters: a-z, 0-9 and "-"');
  if (!text(m.name, 40)) errors.push('name is required');
  if (!SPECIES_IDS.includes(m.species)) errors.push(`species must be one of ${SPECIES_IDS.join(', ')}`);
  if (!KINDS.includes(m.kind)) errors.push(`kind must be one of ${KINDS.join(', ')}`);

  const outfits = {};
  const src = m.outfits && typeof m.outfits === 'object' ? m.outfits : {};
  for (const [id, rel] of Object.entries(src)) {
    if (!OUTFIT_IDS.includes(id)) {
      errors.push(`outfits.${id}: unknown outfit (known: ${OUTFIT_IDS.join(', ')})`);
      continue;
    }
    const f = packFile(dir, rel, errors, `outfits.${id}`);
    if (f) outfits[id] = f;
  }
  if (!Object.keys(src).length) errors.push('outfits must give art for at least one outfit');

  let frame = null;
  const actions = {};
  if (m.kind === 'sprites') {
    if (!m.frame || !posInt(m.frame.width) || !posInt(m.frame.height) || m.frame.width > 1024 || m.frame.height > 1024) errors.push('frame.width and frame.height must be whole numbers of pixels (at most 1024)');
    else frame = { width: m.frame.width, height: m.frame.height };
    const a = m.actions && typeof m.actions === 'object' ? m.actions : {};
    if (!a.idle) errors.push('actions.idle is required');
    for (const [name, v] of Object.entries(a)) {
      if (!known.includes(name)) {
        errors.push(`actions.${name}: unknown action (known: ${known.join(', ')})`);
        continue;
      }
      const ok = v && Number.isInteger(v.row) && v.row >= 0 && Number.isInteger(v.col) && v.col >= 0 && posInt(v.frames) && v.frames <= 64 && (v.fps === undefined || (typeof v.fps === 'number' && v.fps > 0 && v.fps <= 30));
      if (!ok) errors.push(`actions.${name}: needs row, col (from 0), frames (1–64) and optional fps (up to 30)`);
      else actions[name] = { row: v.row, col: v.col, frames: v.frames, fps: v.fps || 4 };
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    pack: {
      id: m.id,
      schema: m.schema,
      name: text(m.name, 40),
      version: text(m.version, 20) || '0.0.0',
      author: text(m.author, 60) || '未署名',
      license: text(m.license, 40) || '未注明',
      description: text(m.description, 200),
      species: m.species,
      kind: m.kind,
      pixelated: m.pixelated === true,
      frame,
      actions,
      outfits,
      dir: path.resolve(dir),
    },
  };
}

function readPack(dir) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`pack.json: ${e.code === 'ENOENT' ? 'missing' : 'not valid JSON'}`] };
  }
  return validatePack(manifest, dir);
}

// Every pack in `roots` ({ dir, source: 'builtin' | 'user' }); a user pack never replaces a built-in one.
// Returns { packs: Map(id -> pack), problems: [{ dir, errors }] }.
function loadPacks(roots) {
  const packs = new Map();
  const problems = [];
  for (const { dir, source } of roots) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const r = readPack(path.join(dir, name));
      if (!r.ok) problems.push({ dir: path.join(dir, name), errors: r.errors });
      else if (packs.has(r.pack.id)) problems.push({ dir: path.join(dir, name), errors: [`id ${r.pack.id} is already used by another pack`] });
      else packs.set(r.pack.id, { ...r.pack, source });
    }
  }
  return { packs, problems };
}

// URL the renderer loads a pack file from (served by the `pack:` protocol, see src/main/packs.js).
const packUrl = (pack, rel) => `pack://${pack.id}/${rel.split('/').map(encodeURIComponent).join('/')}`;

// How `speciesId` looks in `outfitId` with the chosen pack. For an outfit the pack has no art for, the
// character's default pack is tried next, then its fallback pack (`fallbackId`).
// null = no art: a video character in its signature outfit plays its own clips (chosen under 外观, or
// when it has no pack at all).
function resolveLook(packs, { packId, fallbackId, speciesId, outfitId }) {
  if (packId && packId === clipsId(speciesId) && outfitId === 'daily') return null;
  for (const id of [packId, defaultPack(speciesId), fallbackId || fallbackPack(speciesId)]) {
    const p = id && packs.get(id);
    if (!p || p.species !== speciesId || !p.outfits[outfitId]) continue;
    const base = { packId: p.id, kind: p.kind, url: packUrl(p, p.outfits[outfitId]), pixelated: p.pixelated };
    return p.kind === 'sprites' ? { ...base, frame: p.frame, actions: p.actions } : base;
  }
  return null;
}

// Packs for one species, as the appearance picker lists them: hers in the order of her character file
// (the default first), then imported ones; a video character's own clips come last.
function packsFor(packs, speciesId) {
  const own = (SPECIES[speciesId] && SPECIES[speciesId].packs) || [];
  const rank = (p) => (own.includes(p.id) ? own.indexOf(p.id) : own.length);
  const out = [...packs.values()]
    .filter((p) => p.species === speciesId)
    .sort((a, b) => rank(a) - rank(b))
    .map((p) => ({ id: p.id, name: p.name, author: p.author, license: p.license, version: p.version, description: p.description, kind: p.kind, source: p.source, outfits: Object.keys(p.outfits).length }));
  const c = clipsId(speciesId) && SPECIES[speciesId].clipsLook;
  if (c) out.push({ id: clipsId(speciesId), name: c.name, author: c.author, license: c.license, version: '', description: c.description, kind: 'video', source: 'builtin', outfits: 1 });
  return out;
}

// The look a character starts with (its first pack; none for a video character without packs, which
// plays its clips), and the pack every other pack falls back to. Both come from src/characters/<id>.json.
const defaultPack = (speciesId) => (SPECIES[speciesId] && SPECIES[speciesId].defaultPack) || null;
const fallbackPack = (speciesId) => (SPECIES[speciesId] && SPECIES[speciesId].fallbackPack) || `${speciesId}-pixel`;
// The appearance id that stands for a video character's own clips (null for a pack character).
const clipsId = (speciesId) => (SPECIES[speciesId] && SPECIES[speciesId].clipsLook ? `${speciesId}-clips` : null);
function chosenPack(packs, appearance, speciesId) {
  const want = appearance && appearance[speciesId];
  if (want && want === clipsId(speciesId)) return want;
  for (const id of [want, defaultPack(speciesId), fallbackPack(speciesId)]) {
    const p = id && packs.get(id);
    if (p && p.species === speciesId) return p.id;
  }
  return fallbackPack(speciesId);
}

module.exports = { defaultPack, fallbackPack, clipsId, chosenPack, SCHEMA, SCHEMAS, ACTIONS, ACTIONS_V1, KINDS, validatePack, readPack, loadPacks, packUrl, resolveLook, packsFor };
