'use strict';

// Pet packs (角色包): how a companion looks. A pack is a folder with a `pack.json` and its images; the
// app ships some (src/renderer/packs) and loads the user's own from <userData>/packs. A pack only
// supplies art for the app's outfits; which outfits exist, when they unlock and how they are rated stay
// with the app (src/core/outfits.js), so an imported pack cannot change what is shown to whom.
// Format: docs/pet-packs.md. Electron-free so it can be tested.

const fs = require('node:fs');
const path = require('node:path');
const { OUTFIT_IDS } = require('./outfits');
const { SPECIES_IDS } = require('./species');

const SCHEMA = 1;
// What a sprite pack can animate. The app maps its states onto these; anything missing plays `idle`.
const ACTIONS = ['idle', 'wave', 'lifted', 'eat', 'sleep', 'think', 'talk', 'cheer'];
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
  if (m.schema !== SCHEMA) errors.push(`schema must be ${SCHEMA}`);
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
      if (!ACTIONS.includes(name)) {
        errors.push(`actions.${name}: unknown action (known: ${ACTIONS.join(', ')})`);
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
// species' default pack is tried next, then its illustrated pack (`fallbackId`, complete).
// null = no art (Dafeiyu's signature outfit: its clips).
function resolveLook(packs, { packId, fallbackId, speciesId, outfitId }) {
  for (const id of [packId, DEFAULT_PACKS[speciesId], fallbackId || fallbackPack(speciesId)]) {
    const p = id && packs.get(id);
    if (!p || p.species !== speciesId || !p.outfits[outfitId]) continue;
    const base = { packId: p.id, kind: p.kind, url: packUrl(p, p.outfits[outfitId]), pixelated: p.pixelated };
    return p.kind === 'sprites' ? { ...base, frame: p.frame, actions: p.actions } : base;
  }
  return null;
}

// Packs for one species, as the appearance picker lists them.
function packsFor(packs, speciesId) {
  return [...packs.values()]
    .filter((p) => p.species === speciesId)
    .map((p) => ({ id: p.id, name: p.name, author: p.author, license: p.license, version: p.version, description: p.description, kind: p.kind, source: p.source, outfits: Object.keys(p.outfits).length }));
}

// The look a companion starts with, and the complete pack every other pack falls back to.
const DEFAULT_PACKS = { bubbo: 'bubbo-pixel' };
const fallbackPack = (speciesId) => `${speciesId}-illustrated`;
function chosenPack(packs, appearance, speciesId) {
  for (const id of [appearance && appearance[speciesId], DEFAULT_PACKS[speciesId], fallbackPack(speciesId)]) {
    const p = id && packs.get(id);
    if (p && p.species === speciesId) return p.id;
  }
  return fallbackPack(speciesId);
}

module.exports = { DEFAULT_PACKS, fallbackPack, chosenPack, SCHEMA, ACTIONS, KINDS, validatePack, readPack, loadPacks, packUrl, resolveLook, packsFor };
