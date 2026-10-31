'use strict';

// The companions: model-chan (模型娘) fan characters themed on AI model vendors. Each one is data, not
// code: `src/characters/<id>.json` holds its vendor, persona, lines, theme colour, which outfits it has
// art for, whether adult content may ever apply to it, its art (video clips or pet packs) and credits.
// Every effect (src/core/fx.js, src/renderer/fx.js) is shared; a character only differs in this file,
// its art and its lines. Every character is an adult (set age 18); see docs/affection-design.md 8.1.
// None of them is an official vendor mascot.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'characters');
const ID_RE = /^[a-z][a-z0-9]{1,19}$/;
const FALLBACK_KINDS = ['hungry', 'bored', 'happy', 'sleepy', 'greet'];
const ART_KINDS = ['video', 'pack'];

// Characters that were retired with the model-chan roster, and who takes over an old save.
// The whale goes to the DeepSeek whale; the others to the character closest in temperament.
const RETIRED = { bubbo: 'dafeiyu', embit: 'claude', sprig: 'dafeiyu' };
const DEFAULT_SPECIES = 'dafeiyu';

const str = (v) => typeof v === 'string' && v.trim().length > 0;
const MEME_ID_RE = /^[a-z0-9_-]{1,40}$/;
const ASSETS = path.join(__dirname, '..', 'renderer');
// A clip is a file name, or a list of variants played in turn (e.g. several click reactions).
const clipOk = (v) => str(v) || (Array.isArray(v) && v.length > 0 && v.every(str));

// Check one character file. Returns a list of problems (empty = valid).
function validateCharacter(c) {
  const errors = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  if (!ID_RE.test(c.id || '')) errors.push('id must be 2–20 characters: a-z, 0-9, starting with a letter');
  for (const k of ['vendor', 'name', 'nameZh', 'title', 'blurb', 'personality', 'catchphrase', 'likes']) if (!str(c[k])) errors.push(`${k} is required`);
  if (!/^#[0-9a-fA-F]{6}$/.test(c.accent || '')) errors.push('accent must be a #rrggbb colour');
  for (const k of FALLBACK_KINDS) if (!c.fallback || !Array.isArray(c.fallback[k]) || !c.fallback[k].length || !c.fallback[k].every(str)) errors.push(`fallback.${k} needs at least one line`);
  // optional: her own lines for 喂食 / 摸摸 / 玩耍 (core/proactive.js fallbackPool)
  for (const k of ['fed', 'patted', 'played']) if (c.fallback && c.fallback[k] !== undefined && (!Array.isArray(c.fallback[k]) || !c.fallback[k].length || !c.fallback[k].every(str))) errors.push(`fallback.${k} must be a list of lines`);
  if (typeof c.adult !== 'boolean') errors.push('adult must be true or false');
  if (!Array.isArray(c.outfits) || !c.outfits.includes('daily')) errors.push('outfits must list the outfits it has art for, including daily');
  const art = c.art || {};
  if (!ART_KINDS.includes(art.kind)) errors.push(`art.kind must be one of ${ART_KINDS.join(', ')}`);
  if (art.kind === 'video' && (!art.clips || !str(art.clips.idle) || !str(art.dir))) errors.push('a video character needs art.dir and art.clips.idle');
  if (art.kind === 'video' && art.clips) for (const [k, v] of Object.entries(art.clips)) if (!clipOk(v)) errors.push(`art.clips.${k} must be a file name or a list of them`);
  if (art.clipsLook !== undefined && (!art.clipsLook || !['name', 'author', 'license'].every((k) => str(art.clipsLook[k])))) errors.push('art.clipsLook needs a name, an author and a license');
  if (c.memes !== undefined) {
    if (!Array.isArray(c.memes)) errors.push('memes must be a list');
    else {
      const ids = new Set();
      c.memes.forEach((m, i) => {
        if (!m || !MEME_ID_RE.test(m.id || '') || !str(m.label) || !str(m.desc)) errors.push(`memes[${i}] needs an id (a-z0-9_-), a label and a desc`);
        else if (ids.has(m.id)) errors.push(`memes[${i}]: duplicate id ${m.id}`);
        else ids.add(m.id);
      });
    }
  }
  if (c.models !== undefined) {
    const m = c.models;
    let reOk = false;
    try { reOk = str(m && m.match) && !!new RegExp(m.match); } catch { reOk = false; }
    if (!m || typeof m !== 'object' || !reOk) errors.push('models.match must be a regular expression for the model ids she may use');
    else for (const k of ['providers', 'prefer']) if (m[k] !== undefined && (!Array.isArray(m[k]) || !m[k].every(str))) errors.push(`models.${k} must be a list of ids`);
  }
  // voice: { lang, pitch, rate, prefer } for the system voice, plus optional engines in voice.tts (core/tts.js)
  if (c.voice !== undefined) errors.push(...require('./tts').validateVoice(c.voice));
  if (!Array.isArray(art.packs) || (art.kind === 'pack' && !art.packs.length)) errors.push('art.packs must list its pet packs');
  if (!Array.isArray(c.credits) || !c.credits.length) errors.push('credits are required');
  if (c.touch !== undefined) errors.push(...require('./touch-zones').validateTouch(c.touch));
  if (RETIRED[c.id]) errors.push(`${c.id} is a retired character id`);
  return errors;
}

// Normalise a valid file into the shape the app uses.
function toSpecies(c) {
  const art = c.art;
  return {
    ...c,
    // video characters keep `art: 'video'` + `clips` at the top level (what the renderer reads)
    art: art.kind === 'video' ? 'video' : 'pack',
    clips: art.kind === 'video' ? { ...art.clips } : null,
    clipDir: art.kind === 'video' ? art.dir : null,
    packs: [...art.packs],
    // a video character with a pack starts in that pack; its clips are picked under 外观 (clipsLook)
    defaultPack: art.packs[0] || null,
    clipsLook: art.kind === 'video' ? { name: `${c.nameZh} · 视频`, author: '', license: '', description: '', ...(art.clipsLook || {}) } : null,
    fallbackPack: art.fallbackPack || art.packs[0] || null,
    fx: { noMirror: [], ...(c.fx || {}) },
    signature: c.signature || null,
    memes: Array.isArray(c.memes) ? c.memes.map((m) => ({ id: m.id, label: m.label, desc: m.desc })) : [],
    voice: typeof c.voice === 'string' ? { prefer: [c.voice] } : c.voice || null,
    models: c.models ? { match: c.models.match, providers: [...(c.models.providers || [])], prefer: [...(c.models.prefer || [])] } : null,
  };
}

// Files a character file points at that are missing on disk (clips and meme pictures).
function missingFiles(c, root = ASSETS) {
  const out = [];
  const art = c.art || {};
  if (art.kind === 'video' && art.clips) for (const v of Object.values(art.clips)) for (const f of [].concat(v)) if (!fs.existsSync(path.join(root, art.dir, f))) out.push(`${art.dir}/${f}`);
  for (const m of c.memes || []) if (!fs.existsSync(path.join(root, 'assets', 'memes', c.id, `${m.id}.webp`))) out.push(`assets/memes/${c.id}/${m.id}.webp`);
  return out;
}

function loadCharacters(dir = DIR) {
  const out = {};
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const errors = validateCharacter(c);
    if (`${c.id}.json` !== f) errors.push(`file name must be ${c.id}.json`);
    if (!errors.length) for (const m of missingFiles(c)) errors.push(`missing file ${m}`);
    if (errors.length) throw new Error(`character ${f}: ${errors.join('; ')}`);
    out[c.id] = toSpecies(c);
  }
  return Object.fromEntries(Object.entries(out).sort(([, a], [, b]) => (a.order || 99) - (b.order || 99)));
}

const SPECIES = loadCharacters();
const SPECIES_IDS = Object.keys(SPECIES);

function getSpecies(id) {
  const s = SPECIES[id];
  if (!s) throw new Error(`Unknown species: ${id}`);
  return s;
}

// The character a saved id stands for now: itself, its successor if it was retired, else the default.
function resolveSpeciesId(id) {
  if (SPECIES[id]) return id;
  if (RETIRED[id] && SPECIES[RETIRED[id]]) return RETIRED[id];
  return DEFAULT_SPECIES;
}

// Tests only: add a character (e.g. one that allows adult content) to the live registry.
function registerCharacter(c) {
  const errors = validateCharacter(c);
  if (errors.length) throw new Error(errors.join('; '));
  SPECIES[c.id] = toSpecies(c);
  if (!SPECIES_IDS.includes(c.id)) SPECIES_IDS.push(c.id);
  return SPECIES[c.id];
}
function unregisterCharacter(id) {
  delete SPECIES[id];
  const i = SPECIES_IDS.indexOf(id);
  if (i >= 0) SPECIES_IDS.splice(i, 1);
}

module.exports = { SPECIES, SPECIES_IDS, RETIRED, DEFAULT_SPECIES, getSpecies, resolveSpeciesId, validateCharacter, toSpecies, missingFiles, loadCharacters, registerCharacter, unregisterCharacter };
