'use strict';

// Pet packs (角色包): how a companion looks. A pack is a folder with a `pack.json` and its images; the
// app ships some (src/renderer/packs) and loads the user's own from <userData>/packs. A pack only
// supplies art for the app's outfits; which outfits exist, when they unlock and how they are rated stay
// with the app (src/core/outfits.js), so an imported pack cannot change what is shown to whom.
// Format: docs/pet-packs.md. Electron-free so it can be tested.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { OUTFITS, OUTFIT_IDS } = require('./outfits');
const { SPECIES, SPECIES_IDS } = require('./species');
const { STATES } = require('./fx');

// Schema 2 names a sprite action after the app's states (the DeepSeek pet's 15 states plus `lifted`,
// see src/core/fx.js). Schema 1 packs keep their 8 older action names; the app maps states onto
// them (fx.ALIASES) and anything missing falls back along fx.FALLBACK to `idle`.
const SCHEMA = 2;
const SCHEMAS = [1, 2];
const ACTIONS_V1 = ['idle', 'wave', 'lifted', 'eat', 'sleep', 'think', 'talk', 'cheer'];
const ACTIONS = { 1: ACTIONS_V1, 2: STATES };
const KINDS = ['sprites', 'pictures', 'rig', 'live2d'];
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

// A rig pack (全动态): `model` is a JSON file in the pack (see docs/pet-packs.md) and every outfit's
// image is its preview, with the outfit's layers (<part id>.png) in the same folder. The model goes to
// the renderer with the look (src/renderer/rig.js draws it), so it is checked here.
const RIG_DEFORMERS = ['body', 'skirt', 'hair', 'tail', 'head', 'finL', 'finR', 'ahoge', 'armL', 'armR', 'legL', 'legR'];
const RIG_PIVOTS = ['body', 'head', 'neck', 'tail', 'finL', 'finR', 'ahoge', 'armL', 'armR', 'elbowL', 'elbowR', 'legL', 'legR'];
// drawn faces the app knows how to use (src/renderer/rig.js LOOKS `expr`), plus the eyes shut and the mouth open
const RIG_EXPRESSIONS = ['happy', 'content', 'surprised', 'sad', 'angry', 'shy', 'sleep', 'wink', 'blink', 'talk'];
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const nums = (v, n) => Array.isArray(v) && v.length === n && v.every(num);
function readRigModel(dir, rel, outfits, errors) {
  if (typeof rel !== 'string' || !/\.json$/i.test(rel) || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    errors.push('model: must be a relative path to a .json file inside the pack');
    return null;
  }
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.resolve(dir, rel), 'utf8'));
  } catch (e) {
    errors.push(`model: ${rel} is ${e.code === 'ENOENT' ? 'missing' : 'not valid JSON'}`);
    return null;
  }
  const bad = (msg) => { errors.push(`model: ${msg}`); return null; };
  if (!nums(m.size, 2) || m.size.some((v) => v <= 0 || v > 4096)) return bad('size must be [width, height] in pixels');
  if (!Array.isArray(m.parts) || !m.parts.length || m.parts.length > 64) return bad('parts must list 1–64 layers');
  const parts = [];
  for (const p of m.parts) {
    if (!p || !/^[a-z0-9_]{1,32}$/.test(p.id || '')) return bad(`part id "${p && p.id}" must be 1–32 characters a-z, 0-9, _`);
    if (p.id === 'face' || parts.some((q) => q.id === p.id)) return bad(`part id ${p.id} is reserved or used twice`);
    if (!RIG_DEFORMERS.includes(p.deformer)) return bad(`part ${p.id}: deformer must be one of ${RIG_DEFORMERS.join(', ')}`);
    if (!nums(p.box, 4) || p.box[2] <= 0 || p.box[3] <= 0) return bad(`part ${p.id}: box must be [x, y, width, height]`);
    if (!num(p.z)) return bad(`part ${p.id}: z must be a number`);
    const grid = p.grid === undefined ? [4, 4] : p.grid;
    if (!nums(grid, 2) || grid.some((g) => !Number.isInteger(g) || g < 1 || g > 32)) return bad(`part ${p.id}: grid must be [columns, rows], 1–32 each`);
    parts.push({ id: p.id, deformer: p.deformer, box: p.box, z: p.z, grid });
  }
  const pivots = {};
  for (const [k, v] of Object.entries(m.pivots || {})) {
    if (!RIG_PIVOTS.includes(k) || !nums(v, 2)) return bad(`pivots.${k} must be one of ${RIG_PIVOTS.join(', ')} with [x, y]`);
    pivots[k] = v;
  }
  let legs = null;
  if (m.legs !== undefined) {
    if (!m.legs || !num(m.legs.hem) || !num(m.legs.feet) || !num(m.legs.split)) return bad('legs must be { hem, feet, split }');
    legs = { hem: m.legs.hem, feet: m.legs.feet, split: m.legs.split };
  }
  let face = null;
  if (m.face !== undefined) {
    const f = m.face || {};
    const rgb = (v) => v === undefined || (nums(v, 3) && v.every((c) => c >= 0 && c <= 255));
    if (!nums(f.box, 4) || !Array.isArray(f.eyes) || f.eyes.length !== 2 || !f.eyes.every((e) => nums(e, 4)) || !nums(f.mouth, 2)
      || !rgb(f.skin) || !rgb(f.ink) || (f.blush !== undefined && !(Array.isArray(f.blush) && f.blush.every((b) => nums(b, 2))))) {
      return bad('face must be { box, eyes: [[x0, y0, x1, y1] × 2], mouth: [x, y] } with optional skin, ink and blush');
    }
    face = { box: f.box, eyes: f.eyes, mouth: f.mouth, skin: f.skin, ink: f.ink, blush: f.blush };
  }
  let expressions = null;
  if (m.expressions !== undefined) {
    if (!m.expressions || typeof m.expressions !== 'object') return bad('expressions must map face names to part ids');
    expressions = {};
    for (const [k, v] of Object.entries(m.expressions)) {
      if (!RIG_EXPRESSIONS.includes(k)) return bad(`expressions.${k}: one of ${RIG_EXPRESSIONS.join(', ')}`);
      if (!parts.some((p) => p.id === v)) return bad(`expressions.${k}: no part ${v}`);
      expressions[k] = v;
    }
  }
  // every outfit needs every layer, next to its preview
  for (const [id, preview] of Object.entries(outfits)) {
    const folder = path.posix.dirname(preview);
    for (const p of parts) {
      const rel2 = folder === '.' ? `${p.id}.png` : `${folder}/${p.id}.png`;
      if (!fs.existsSync(path.resolve(dir, rel2))) return bad(`outfit ${id} has no layer ${rel2}`);
    }
  }
  return { size: m.size, parts, pivots, legs, face, expressions };
}

// A Live2D pack: `model` is a Cubism 4 .model3.json in the pack (with the .moc3, textures and physics it
// names), drawn by src/renderer/live2d.js for every outfit it lists; `live2d` maps the app's moves onto the
// model's own parameters (docs/pet-packs.md). Outfit images are the pictures shown in lists and the wardrobe.
const PARAM_RE = /^[A-Za-z0-9_]{1,64}$/;
const LIVE2D_PARAMS = ['armL', 'armR', 'elbowR', 'tail', 'earL', 'earR'];
const LIVE2D_NUMBERS = ['armOut', 'armWave', 'elbowWave'];
function readLive2d(dir, rel, cfg, errors) {
  const bad = (msg) => { errors.push(msg); return null; };
  if (typeof rel !== 'string' || !/\.model3\.json$/i.test(rel) || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return bad('model: must be a relative path to a .model3.json file inside the pack');
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.resolve(dir, rel), 'utf8'));
  } catch (e) {
    return bad(`model: ${rel} is ${e.code === 'ENOENT' ? 'missing' : 'not valid JSON'}`);
  }
  const refs = (m && m.FileReferences) || {};
  const folder = path.dirname(path.resolve(dir, rel));
  const files = [refs.Moc, ...(Array.isArray(refs.Textures) ? refs.Textures : []), refs.Physics].filter((f) => f !== undefined);
  if (typeof refs.Moc !== 'string' || !Array.isArray(refs.Textures) || !refs.Textures.length) return bad('model: the .model3.json must name its Moc and Textures');
  for (const f of files) {
    const abs = typeof f === 'string' && path.resolve(folder, f);
    if (!abs || !abs.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(abs)) return bad(`model: ${f} is missing from the pack`);
  }
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const out = { height: 0.8, params: {}, faces: {}, pinned: {} };
  if (c.height !== undefined) {
    if (typeof c.height !== 'number' || c.height < 0.3 || c.height > 1) return bad('live2d.height must be between 0.3 and 1 (her share of the frame height)');
    out.height = c.height;
  }
  for (const [k, v] of Object.entries(c.params || {})) {
    if (LIVE2D_PARAMS.includes(k) && typeof v === 'string' && PARAM_RE.test(v)) out.params[k] = v;
    else if (LIVE2D_NUMBERS.includes(k) && typeof v === 'number' && Math.abs(v) <= 90) out.params[k] = v;
    else return bad(`live2d.params.${k}: one of ${[...LIVE2D_PARAMS, ...LIVE2D_NUMBERS].join(', ')}, a parameter id or a number`);
  }
  const values = (v) => v && typeof v === 'object' && Object.entries(v).every(([id, x]) => PARAM_RE.test(id) && typeof x === 'number' && Math.abs(x) <= 100);
  for (const [k, v] of Object.entries(c.faces || {})) {
    if (!/^[a-z]{1,16}$/.test(k) || !values(v)) return bad(`live2d.faces.${k}: { parameter id: value }`);
    out.faces[k] = v;
  }
  if (c.pinned !== undefined && !values(c.pinned)) return bad('live2d.pinned: { parameter id: value }');
  out.pinned = c.pinned || {};
  return out;
}

// ---------- the user's own Live2D model (外观 → 导入 Live2D 模型…) ----------
// A plain Cubism 3–5 model folder (a .model3.json and the files it names, no pack.json) becomes a live2d
// pack for one character: the model goes into `model/`, its expressions become the app's named faces, and
// it dresses her in every all-ages outfit (adult outfits still need an 18+ pack). The preview picture is
// drawn by the renderer from the model itself after the import (PREVIEW_FILE starts as a blank).
const LIVE2D_DIR = 'model';
const PREVIEW_FILE = 'preview.png';
const SKIP_DIRS = new Set(['__MACOSX', 'node_modules', '.git']);

// The .model3.json files under `dir` (relative, '/'-separated, shallowest first), and whether only
// Cubism 2 models (.model.json) were found there.
function findLive2dModels(dir, maxDepth = 4) {
  const found = [];
  let cubism2 = false;
  const walk = (rel, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(r, depth + 1);
      else if (e.isFile() && /\.model3\.json$/i.test(e.name)) found.push(r);
      else if (e.isFile() && /\.model\.json$/i.test(e.name)) cubism2 = true;
    }
  };
  walk('', 0);
  found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return { models: found, cubism2: cubism2 && !found.length };
}

// Its id: one per character and model name, so importing the same model again replaces it.
function live2dPackId(speciesId, name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 8);
  const tail = slug.length >= 3 ? slug : hash;
  return `l2d-${speciesId}-${tail}`.slice(0, 40).replace(/-+$/, '');
}

// The app's named faces (src/renderer/live2d.js) recognised from expression names and file names, in
// English, Japanese and Chinese; the first expression that matches a face wins.
const FACE_HINTS = {
  blush: /blush|shy|embarrass|照れ|赤面|ほほ|脸红|臉紅|害羞|羞/i,
  wide: /surpris|shock|astonish|驚|びっくり|吃惊|惊讶|驚訝|惊/i,
  squint: /squint|><|＞＜|xx|笑い目|眯|闭眼笑/i,
  gloom: /gloom|depress|dark|落ち込|暗|阴沉|陰沉|黑脸|sad|悲|哀|难过|難過/i,
  dizzy: /dizzy|confus|目回|ぐるぐる|晕|暈|眩/i,
  drool: /drool|よだれ|口水/i,
};
// Parameters the renderer drives itself every frame (head, gaze, eyes, brows, mouth; with their Cubism 2
// names): an expression's values for them would fight her own face, so a face keeps only the rest.
const LIVE2D_DRIVEN = new Set(['AngleX', 'AngleY', 'AngleZ', 'BodyAngleX', 'BodyAngleZ', 'EyeBallX', 'EyeBallY', 'EyeLOpen', 'EyeROpen', 'EyeSmile', 'EyeLSmile', 'EyeRSmile', 'EyeAnger', 'BrowLY', 'BrowRY', 'BrowLAngle', 'BrowRAngle', 'MouthForm', 'MouthOpenY']
  .flatMap((k) => [`Param${k}`, `PARAM_${k.replace(/([a-z])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z])/g, '$1_$2').toUpperCase()}`]));
// `expressions`: [{ name, file, json }] from the .model3.json and its .exp3.json files. A face sets the
// expression's Add / Overwrite values (Multiply ones scale what is there and are left out).
function facesFromExpressions(expressions) {
  const faces = {};
  for (const [face, re] of Object.entries(FACE_HINTS)) {
    for (const ex of expressions) {
      if (!re.test(`${ex.name || ''} ${path.basename(ex.file || '')}`)) continue;
      const params = {};
      for (const p of (ex.json && Array.isArray(ex.json.Parameters) ? ex.json.Parameters : [])) {
        if (!p || !PARAM_RE.test(p.Id || '') || LIVE2D_DRIVEN.has(p.Id) || typeof p.Value !== 'number' || Math.abs(p.Value) > 100 || p.Blend === 'Multiply') continue;
        params[p.Id] = p.Value;
      }
      if (Object.keys(params).length) { faces[face] = params; break; }
    }
  }
  return faces;
}

// The pack.json for a model at `${LIVE2D_DIR}/<modelRel>` worn by `speciesId`.
function live2dManifest({ speciesId, modelRel, name, expressions = [] }) {
  const all = OUTFITS.filter((o) => o.rating !== 'adult').map((o) => o.id);
  return {
    schema: SCHEMA,
    id: live2dPackId(speciesId, name),
    name: text(name, 40) || 'Live2D 模型',
    version: '1.0.0',
    author: '本地导入',
    license: '模型作者的条款',
    description: '从本地导入的 Live2D 模型。',
    species: speciesId,
    kind: 'live2d',
    model: `${LIVE2D_DIR}/${modelRel}`,
    live2d: { height: 0.8, faces: facesFromExpressions(expressions) },
    outfits: Object.fromEntries(all.map((id) => [id, PREVIEW_FILE])),
  };
}

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

  const model = m.kind === 'rig' ? readRigModel(dir, m.model, outfits, errors) : null;
  const live2d = m.kind === 'live2d' ? readLive2d(dir, m.model, m.live2d, errors) : null;

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
      // 18+ look (T-1261): listed and worn only after the 18+ confirmation with adult content on
      adult: m.adult === true,
      frame,
      actions,
      model: live2d ? m.model : model,
      live2d,
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
    if (p.kind === 'sprites') return { ...base, frame: p.frame, actions: p.actions };
    if (p.kind === 'live2d') return { ...base, model: packUrl(p, p.model), live2d: p.live2d };
    if (p.kind === 'rig') {
      const folder = path.posix.dirname(p.outfits[outfitId]);
      return { ...base, model: p.model, base: packUrl(p, folder === '.' ? '' : folder).replace(/\/$/, '') };
    }
    return base;
  }
  return null;
}

// Packs for one species, as the appearance picker lists them: hers in the order of her character file
// (the default first), then imported ones; a video character's own clips come last. 18+ packs only
// when `adultOk` (the user confirmed 18+ and turned adult content on).
function packsFor(packs, speciesId, adultOk = false) {
  const own = (SPECIES[speciesId] && SPECIES[speciesId].packs) || [];
  const rank = (p) => (own.includes(p.id) ? own.indexOf(p.id) : own.length);
  const out = [...packs.values()]
    .filter((p) => p.species === speciesId && (adultOk || !p.adult))
    .sort((a, b) => rank(a) - rank(b))
    .map((p) => ({ id: p.id, name: p.name, author: p.author, license: p.license, version: p.version, description: p.description, kind: p.kind, source: p.source, adult: p.adult, outfits: Object.keys(p.outfits).length, ...(p.live2d ? { height: p.live2d.height } : {}) }));
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
// The pack she wears: her chosen one, else her default. An 18+ pack counts only when `adultOk`; without
// it she falls back to her default look (the choice is kept for when adult content is on again).
function chosenPack(packs, appearance, speciesId, adultOk = false) {
  const want = appearance && appearance[speciesId];
  if (want && want === clipsId(speciesId)) return want;
  for (const id of [want, defaultPack(speciesId), fallbackPack(speciesId)]) {
    const p = id && packs.get(id);
    if (p && p.species === speciesId && (adultOk || !p.adult)) return p.id;
  }
  return fallbackPack(speciesId);
}

module.exports = { defaultPack, fallbackPack, clipsId, chosenPack, SCHEMA, SCHEMAS, ACTIONS, ACTIONS_V1, KINDS, validatePack, readPack, loadPacks, packUrl, resolveLook, packsFor, LIVE2D_DIR, PREVIEW_FILE, findLive2dModels, live2dPackId, facesFromExpressions, live2dManifest };
