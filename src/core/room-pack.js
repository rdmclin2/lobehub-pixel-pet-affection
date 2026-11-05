'use strict';
// 她的房间 · 游戏包校验 (engine `room@1`, docs/her-room-design.md §1). A room pack is a flat folder: manifest.json
// with the five activities' defaults and a list of room themes, and per open theme three files named after it
// (<theme>-room.webp the background, <theme>-atlas.webp the furniture / props, <theme>-sprites.json the atlas
// index), optionally <theme>-preview.webp for a theme that is not open yet. Pictures and JSON only, like every
// game pack (core/game-pack.js FILE_RE); the engine that plays it is the app's (src/renderer/game/engines/room.js).
//
// validateRoom() is called by game-pack.js validateManifest() after the common fields (schema, kind, id, version)
// are checked. A downloaded pack can change her energy, mood and hunger through these numbers, so every number is
// bounded here and the round's result is only ever worked out in main (core/room-play.js, src/main/games.js).
// Electron-free and DOM-free (main, the games repository's build script and the tests require() it).
const KINDS = ['sleep', 'work', 'phone', 'music', 'game'];
const STAT_KEYS = ['energy', 'mood', 'focus', 'fullness'];
const STATUS = ['open', 'soon'];
// the props an activity may use (§1.3): each one's parameters are checked below
const FX = ['dim', 'layer', 'swap', 'hide', 'hold', 'spin', 'frames', 'screen-type', 'emit', 'bob', 'glow'];
const DEFAULT_CHARACTERS = ['claude', 'grok', 'gemini', 'gpt', 'dafeiyu'];
const MAX_THEMES = 12;
const MAX_FILES_PER_THEME = 4;
const MAX_MANIFEST_BYTES = 256 * 1024;
const SECONDS = [5, 600];
const DELTA_MAX = 40;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const PALETTE_KEYS = ['primary', 'accent', 'base', 'trim'];
const POSES = ['stand', 'tucked'];

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const pt = (p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);
const poly = (p) => Array.isArray(p) && p.length >= 3 && p.every(pt);
const shape = (s) => poly(s) || (s && num(s.cx) && num(s.cy) && num(s.rx) && num(s.ry) && s.rx > 0 && s.ry > 0);
const rect = (r) => Array.isArray(r) && r.length === 4 && r.every(num) && r[2] > 0 && r[3] > 0;
const strs = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string');
const inRange = (v, [a, b]) => num(v) && v >= a && v <= b;

function inPoly(p, x, y) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inShape = (s, x, y) => (Array.isArray(s) ? inPoly(s, x, y) : ((x - s.cx) / s.rx) ** 2 + ((y - s.cy) / s.ry) ** 2 <= 1);
// on the floor: inside walk.area and not under a piece of furniture
const onFloor = (walk, p) => pt(p) && inPoly(walk.area, p[0], p[1]) && !(walk.blocked || []).some((b) => inShape(b, p[0], p[1]));

// every file the manifest names (besides manifest.json): what the game:// protocol serves and game-store.js
// accepts in the folder
function namedFiles(m) {
  const out = [];
  for (const t of (m && Array.isArray(m.themes) ? m.themes : [])) {
    if (!t || typeof t !== 'object') continue;
    if (t.images && typeof t.images === 'object') out.push(...Object.values(t.images).filter((f) => typeof f === 'string'));
    if (typeof t.sprites === 'string') out.push(t.sprites);
    if (typeof t.preview === 'string') out.push(t.preview);
  }
  return [...new Set(out)];
}
// the sprites index files (JSON) the manifest names, one per open theme
const spriteFiles = (m) => [...new Set((m && Array.isArray(m.themes) ? m.themes : []).filter((t) => t && typeof t.sprites === 'string').map((t) => t.sprites))];

// one prop (§1.3) → [error…]
function checkProp(p, at, { has, world }) {
  const e = [];
  if (!p || typeof p !== 'object' || !FX.includes(p.fx)) return [`${at}: fx "${p && p.fx}" is not one the engine draws (${FX.join(', ')})`];
  const sprite = (key = 'sprite') => { if (typeof p[key] !== 'string' || !has(p[key])) e.push(`${at} (${p.fx}): no sprite "${p[key]}"`); };
  const sprites = (key = 'sprites') => { if (!strs(p[key]) || !p[key].length || p[key].length > 8) e.push(`${at} (${p.fx}): ${key} must be 1–8 sprite names`); else for (const s of p[key]) if (!has(s)) e.push(`${at} (${p.fx}): no sprite "${s}"`); };
  const inWorld = (r) => rect(r) && r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= world.width && r[1] + r[3] <= world.height;
  const xy = () => { if (!(num(p.x) && num(p.y) && p.x >= 0 && p.y >= 0 && p.x <= world.width && p.y <= world.height)) e.push(`${at} (${p.fx}): x / y must be in the world`); };
  switch (p.fx) {
    case 'dim': if (!inRange(p.to, [0.3, 1])) e.push(`${at} (dim): to must be 0.3–1`); break;
    case 'layer': sprite(); xy(); if (p.under !== undefined && p.under !== 'front') e.push(`${at} (layer): under may only be "front"`); break;
    case 'swap': sprite(); sprite('to'); break;
    case 'hide': sprite(); break;
    case 'hold': sprite(); if (!(pt(p.hand) && p.hand.every((v) => v >= 0 && v <= 1))) e.push(`${at} (hold): hand must be [u, v] in 0–1`); break;
    case 'spin': sprite(); xy(); if (!inRange(p.squash, [0.1, 1])) e.push(`${at} (spin): squash must be 0.1–1`); if (!inRange(p.rpm, [1, 120])) e.push(`${at} (spin): rpm must be 1–120`); break;
    case 'frames': sprites(); if (!inWorld(p.rect)) e.push(`${at} (frames): rect must be [x, y, w, h] in the world`); if (!inRange(p.fps, [0.5, 30])) e.push(`${at} (frames): fps must be 0.5–30`); break;
    case 'screen-type':
      if (!inWorld(p.rect)) e.push(`${at} (screen-type): rect must be [x, y, w, h] in the world`);
      if (!(Number.isInteger(p.rows) && p.rows >= 1 && p.rows <= 24)) e.push(`${at} (screen-type): rows must be 1–24`);
      if (p.color !== undefined && !PALETTE_KEYS.includes(p.color) && !COLOR_RE.test(String(p.color))) e.push(`${at} (screen-type): color is a palette key or #RRGGBB`);
      if (p.sprite !== undefined) sprite();
      break;
    case 'emit':
      sprites();
      if (!(p.from === 'head' || (pt(p.from) && p.from[0] >= 0 && p.from[1] >= 0 && p.from[0] <= world.width && p.from[1] <= world.height))) e.push(`${at} (emit): from must be [x, y] in the world or "head"`);
      if (!inRange(p.every, [0.2, 30])) e.push(`${at} (emit): every must be 0.2–30`);
      if (p.rise !== undefined && !inRange(p.rise, [0, 400])) e.push(`${at} (emit): rise must be 0–400`);
      break;
    case 'bob': if (p.target !== 'pet') e.push(`${at} (bob): target must be "pet"`); if (!inRange(p.period, [0.2, 10])) e.push(`${at} (bob): period must be 0.2–10`); if (!inRange(p.amp, [0, 20])) e.push(`${at} (bob): amp must be 0–20`); break;
    case 'glow': xy(); if (!inRange(p.r, [4, 400])) e.push(`${at} (glow): r must be 4–400`); break;
    default: break;
  }
  return e;
}

function checkLines(l, at) {
  if (l === undefined) return [];
  if (!l || typeof l !== 'object') return [`${at} must be an object`];
  const e = [];
  for (const [k, v] of Object.entries(l)) {
    if (k === 'sky') { if (!v || typeof v !== 'object' || !Object.values(v).every((x) => typeof x === 'string' && x.length <= 120)) e.push(`${at}.sky must be { <weather or phase>: text }`); continue; }
    if (!strs(v) || v.length > 20 || v.some((x) => x.length > 120)) e.push(`${at}.${k} must be up to 20 lines of up to 120 characters`);
  }
  return e;
}

// the five activities' defaults (manifest.activities) → [error…]
function checkDefaults(acts, anims) {
  const e = [];
  if (!acts || typeof acts !== 'object') return ['activities must be an object with the five kinds'];
  for (const k of Object.keys(acts)) if (!KINDS.includes(k)) e.push(`activities.${k}: not one of ${KINDS.join(', ')}`);
  for (const k of KINDS) {
    const a = acts[k];
    const at = `activities.${k}`;
    if (!a || typeof a !== 'object') { e.push(`${at} is missing`); continue; }
    if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 12) e.push(`${at}.label is missing`);
    if (a.verb !== undefined && (typeof a.verb !== 'string' || a.verb.length > 20)) e.push(`${at}.verb`);
    if (!inRange(a.seconds, SECONDS)) e.push(`${at}.seconds must be ${SECONDS[0]}–${SECONDS[1]}`);
    if (a.anim !== undefined && !anims.includes(a.anim)) e.push(`${at}.anim "${a.anim}" is not one she has (${anims.join(', ')})`);
    if (!a.deltas || typeof a.deltas !== 'object') e.push(`${at}.deltas is missing`);
    else for (const [s, v] of Object.entries(a.deltas)) {
      if (!STAT_KEYS.includes(s)) e.push(`${at}.deltas.${s}: only ${STAT_KEYS.join(' / ')}`);
      else if (!inRange(v, [-DELTA_MAX, DELTA_MAX])) e.push(`${at}.deltas.${s} must be −${DELTA_MAX} to ${DELTA_MAX}`);
    }
    if (a.needs !== undefined) {
      if (!a.needs || typeof a.needs !== 'object' || Object.keys(a.needs).some((s) => s !== 'energy')) e.push(`${at}.needs may only have energy`);
      else if (!inRange(a.needs.energy, [0, 100])) e.push(`${at}.needs.energy must be 0–100`);
    }
    e.push(...checkLines(a.lines, `${at}.lines`));
  }
  return e;
}

// one open theme's room → [error…]
function checkOpen(t, at, { files, sprites, anims, kinds }) {
  const e = [];
  const w = t.world || {};
  if (!(inRange(w.width, [256, 4096]) && inRange(w.height, [256, 4096]))) e.push(`${at}.world.width / height must be 256–4096`);
  if (w.background !== undefined && !COLOR_RE.test(String(w.background))) e.push(`${at}.world.background must be #RRGGBB`);
  const world = { width: num(w.width) ? w.width : 0, height: num(w.height) ? w.height : 0 };
  const images = t.images && typeof t.images === 'object' ? t.images : {};
  if (!images.room) e.push(`${at}.images.room is missing`);
  if (!images.atlas) e.push(`${at}.images.atlas is missing`);
  if (typeof t.sprites !== 'string') e.push(`${at}.sprites is missing`);
  const map = (typeof t.sprites === 'string' && sprites && sprites[t.sprites]) || null;
  if (typeof t.sprites === 'string' && sprites && !map) e.push(`${at}: ${t.sprites} is not a sprites index`);
  const has = (name) => !map || (typeof name === 'string' && !!map[name] && num(map[name].w) && num(map[name].h));
  if (t.petHeight !== undefined && !inRange(t.petHeight, [24, 400])) e.push(`${at}.petHeight must be 24–400`);
  if (t.outfit !== undefined && !(typeof t.outfit === 'string' && /^[a-z0-9_-]{1,32}$/.test(t.outfit))) e.push(`${at}.outfit`);
  const walk = t.walk || {};
  if (!poly(walk.area)) { e.push(`${at}.walk.area must be a polygon`); return e; }
  if (walk.blocked && !(Array.isArray(walk.blocked) && walk.blocked.every(shape))) e.push(`${at}.walk.blocked must be polygons / ellipses`);
  if (walk.cell !== undefined && !inRange(walk.cell, [2, 64])) e.push(`${at}.walk.cell must be 2–64`);
  for (const k of ['spawn', 'door']) if (t[k] !== undefined || k === 'spawn') if (!onFloor(walk, t[k])) e.push(`${at}.${k} must be [x, y] on the floor (walk.area)`);
  if (!Array.isArray(t.furniture) || !t.furniture.length) { e.push(`${at}.furniture must be a list`); return e; }
  const ids = new Set();
  for (const [i, f] of t.furniture.entries()) {
    const fa = `${at}.furniture[${i}]`;
    if (!f || typeof f.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(f.id)) { e.push(`${fa}.id is missing`); continue; }
    if (ids.has(f.id)) e.push(`${fa}: id "${f.id}" twice`);
    ids.add(f.id);
    if (!(num(f.x) && num(f.y))) e.push(`${fa} (${f.id}): x / y`);
    if (typeof f.sprite !== 'string' || !has(f.sprite)) e.push(`${fa} (${f.id}): no sprite "${f.sprite}"`);
    if (f.front !== undefined && !has(f.front)) e.push(`${fa} (${f.id}): no sprite "${f.front}" (front)`);
    if (f.label !== undefined && (typeof f.label !== 'string' || f.label.length > 16)) e.push(`${fa} (${f.id}): label`);
    if (f.hit !== undefined && !poly(f.hit)) e.push(`${fa} (${f.id}): hit must be a polygon`);
    if (f.use) {
      if (!onFloor(walk, f.use.at)) e.push(`${fa} (${f.id}): use.at must be on the floor`);
      if (f.use.anim && !anims.includes(f.use.anim)) e.push(`${fa} (${f.id}): use.anim "${f.use.anim}"`);
      if (f.use.seconds && !(Array.isArray(f.use.seconds) && f.use.seconds.length === 2 && f.use.seconds.every((v) => inRange(v, [1, 120])))) e.push(`${fa} (${f.id}): use.seconds`);
    }
  }
  // decor: sprites drawn on the furniture that nothing clicks (the phone on the bedside table, a cup)
  if (t.decor !== undefined && !(Array.isArray(t.decor) && t.decor.length <= 24)) e.push(`${at}.decor must be a list of up to 24`);
  else for (const [i, d] of (t.decor || []).entries()) if (!(d && has(d.sprite) && num(d.x) && num(d.y))) e.push(`${at}.decor[${i}]: { sprite, x, y } with a sprite of the atlas`);
  const acts = t.activities && typeof t.activities === 'object' ? t.activities : {};
  for (const k of Object.keys(acts)) if (!KINDS.includes(k)) e.push(`${at}.activities.${k}: not one of ${KINDS.join(', ')}`);
  for (const k of kinds) {
    const a = acts[k];
    const aa = `${at}.activities.${k}`;
    if (!a || typeof a !== 'object') { e.push(`${aa} is missing (an open room has all five)`); continue; }
    // the numbers are the same in every room (§2.1): a theme cannot change them
    for (const key of ['seconds', 'deltas', 'needs']) if (a[key] !== undefined) e.push(`${aa}.${key}: a room cannot change the numbers (only manifest.activities can)`);
    if (typeof a.at !== 'string' || !ids.has(a.at)) e.push(`${aa}.at "${a.at}" is not a piece of furniture here`);
    if (!onFloor(walk, a.spot)) e.push(`${aa}.spot must be [x, y] on the floor (walk.area)`);
    if (a.face !== undefined && !['left', 'right'].includes(a.face)) e.push(`${aa}.face must be left / right`);
    if (a.pose !== undefined && !POSES.includes(a.pose)) e.push(`${aa}.pose must be ${POSES.join(' / ')}`);
    if (a.anim !== undefined && !anims.includes(a.anim)) e.push(`${aa}.anim "${a.anim}"`);
    if (a.bubble !== undefined && !pt(a.bubble)) e.push(`${aa}.bubble must be [x, y]`);
    if (a.lie !== undefined && !(pt(a.lie) && a.lie[0] >= 0 && a.lie[1] >= 0 && a.lie[0] <= world.width && a.lie[1] <= world.height)) e.push(`${aa}.lie must be [x, y] in the world`);
    if (a.props !== undefined && !(Array.isArray(a.props) && a.props.length <= 8)) e.push(`${aa}.props must be a list of up to 8`);
    else for (const [j, p] of (a.props || []).entries()) e.push(...checkProp(p, `${aa}.props[${j}]`, { has, world }));
    e.push(...checkLines(a.lines, `${aa}.lines`));
  }
  for (const [i, l] of (t.lights || []).entries()) if (!(l && num(l.x) && num(l.y) && inRange(l.r, [4, 400]) && (l.on === undefined || KINDS.includes(l.on)))) e.push(`${at}.lights[${i}]: { x, y, r, on? }`);
  if (t.window !== undefined && !(t.window && inRange(t.window.rect && t.window.rect[2], [1, world.width]) && rect(t.window.rect))) e.push(`${at}.window.rect must be [x, y, w, h]`);
  e.push(...checkLines(t.lines, `${at}.lines`));
  // the files: named after the theme, there in the folder
  const own = [...Object.values(images), t.sprites, t.preview].filter((f) => typeof f === 'string');
  if (own.length > MAX_FILES_PER_THEME) e.push(`${at}: at most ${MAX_FILES_PER_THEME} files per room`);
  for (const f of own) {
    if (!f.startsWith(`${t.id}-`)) e.push(`${at}: file "${f}" must start with "${t.id}-"`);
    if (files && !files.includes(f)) e.push(`${f} is missing`);
  }
  return e;
}

// → [error…] (empty = good). The common fields are game-pack.js's; `files` are the folder's names, `sprites`
// { <file>: <its JSON> } the sprites indexes read from it; `characters` the default characters' ids
// (src/characters) and `anims` the actions she can be asked to play (game-pack.js USE_ANIMS).
function validateRoom(m, { files = null, sprites = null, characters = DEFAULT_CHARACTERS, anims = [], fileRe = null } = {}) {
  const e = [];
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(m)); } catch { bytes = Infinity; }
  if (bytes > MAX_MANIFEST_BYTES) e.push(`manifest is ${bytes} bytes; at most ${MAX_MANIFEST_BYTES}`);
  e.push(...checkDefaults(m.activities, anims));
  const themes = Array.isArray(m.themes) ? m.themes : null;
  if (!themes || !themes.length) return [...e, 'themes must be a list'];
  if (themes.length > MAX_THEMES) e.push(`at most ${MAX_THEMES} themes`);
  const ids = new Set();
  const open = new Set();
  for (const [i, t] of themes.entries()) {
    const at = `themes[${i}]`;
    if (!t || typeof t !== 'object' || !THEME_ID_RE.test(String(t.id))) { e.push(`${at}.id must be 2–32 of a-z 0-9 -`); continue; }
    const ta = `${at} (${t.id})`;
    if (ids.has(t.id)) e.push(`${ta}: id twice`);
    ids.add(t.id);
    if (!characters.includes(t.character)) e.push(`${ta}.character "${t.character}" is not one of ${characters.join(', ')}`);
    if (!STATUS.includes(t.status)) e.push(`${ta}.status must be open / soon`);
    if (typeof t.name !== 'string' || !t.name.trim() || t.name.length > 24) e.push(`${ta}.name is missing`);
    if (t.blurb !== undefined && (typeof t.blurb !== 'string' || t.blurb.length > 200)) e.push(`${ta}.blurb`);
    if (t.motifs !== undefined && !(strs(t.motifs) && t.motifs.length <= 6 && t.motifs.every((x) => x.length <= 8))) e.push(`${ta}.motifs must be up to 6 short words`);
    const pal = t.palette || {};
    for (const k of PALETTE_KEYS) if (!COLOR_RE.test(String(pal[k]))) e.push(`${ta}.palette.${k} must be #RRGGBB`);
    if (t.preview !== undefined) {
      if (typeof t.preview !== 'string' || !/\.(webp|png)$/.test(t.preview) || !t.preview.startsWith(`${t.id}-`)) e.push(`${ta}.preview must be ${t.id}-….webp / .png`);
      else if (files && !files.includes(t.preview)) e.push(`${t.preview} is missing`);
    }
    for (const f of namedFiles({ themes: [t] })) if (fileRe && !fileRe.test(f)) e.push(`${ta}: file name "${f}" is not allowed`);
    if (t.status === 'open') { open.add(t.id); e.push(...checkOpen(t, ta, { files, sprites, anims, kinds: KINDS })); }
  }
  if (!open.size) e.push('at least one theme must be open');
  if (m.defaultTheme !== undefined && !open.has(m.defaultTheme)) e.push(`defaultTheme "${m.defaultTheme}" is not an open theme`);
  for (const [i, q] of (m.quests || []).entries()) {
    if (!q || typeof q.id !== 'string' || typeof q.title !== 'string' || !q.on || typeof q.on.type !== 'string') { e.push(`quests[${i}]: id / title / on.type`); continue; }
    if (q.on.kind !== undefined && ![].concat(q.on.kind).every((k) => KINDS.includes(k))) e.push(`quests[${i}] (${q.id}): on.kind is not one of ${KINDS.join(', ')}`);
    if (q.on.theme !== undefined && ![].concat(q.on.theme).every((x) => ids.has(x))) e.push(`quests[${i}] (${q.id}): on.theme is not a theme here`);
    if (q.distinct !== undefined && q.distinct !== 'kind') e.push(`quests[${i}] (${q.id}): distinct may only be "kind"`);
    if (q.count !== undefined && !(Number.isInteger(q.count) && q.count >= 1 && q.count <= 50)) e.push(`quests[${i}] (${q.id}): count must be 1–50`);
  }
  e.push(...checkLines(m.lines, 'lines'));
  return e;
}

module.exports = { KINDS, STAT_KEYS, FX, DEFAULT_CHARACTERS, MAX_THEMES, MAX_MANIFEST_BYTES, SECONDS, DELTA_MAX, namedFiles, spriteFiles, validateRoom, onFloor, inPoly };
