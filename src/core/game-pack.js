'use strict';
// 小游戏包 (docs/mini-games.md §3): what a downloadable game is on disk. A game pack is data only — pictures and
// one manifest.json — played by the engine built into the app (src/renderer/game/), so nothing downloaded is
// ever run as code. validateManifest() is the one check for every pack, whether it comes from the store, from
// catalog/games/ in a checkout or from a test.
//
//   manifest.json   { schema: 1, kind: 'game', engine: 'yard@1', id, name, version, description, credit,
//                     world: { width, height, background }, images: { <key>: <file> }, sprites: <file>,
//                     camera: { zoom, min, max, start: [x, y] }, petHeight, petSpeed, spawn: [x, y],
//                     walk: { cell, area: [[x, y]…], blocked: [shape…] },
//                     objects: [{ id, sprite, x, y, … }], fx: { waterfall, water, fireflies }, quests: [ … ],
//                     lines: { <event>: [text…] } }
//   <files>         the pictures (.webp / .png) and the sprites index (.json) named there; nothing else
//
// Electron-free and DOM-free (main, the build script and the tests require() it).
const ENGINES = ['yard@1'];
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.(webp|png|json)$/;
const USE_ANIMS = ['idle', 'sit', 'play', 'pat', 'look', 'happy', 'eat', 'sleep', 'think', 'lookAround'];
const EFFECTS = ['lamp', 'water', 'ripple', 'harvest', 'rest', 'none'];

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const pt = (p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);
const poly = (p) => Array.isArray(p) && p.length >= 3 && p.every(pt);
const shape = (s) => poly(s) || (s && num(s.cx) && num(s.cy) && num(s.rx) && num(s.ry) && s.rx > 0 && s.ry > 0);

// → [error…] (empty = good). `files`: the names in the folder (when checking one on disk), to see every file the
// manifest names is there.
function validateManifest(m, { files = null, sprites = null } = {}) {
  const e = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.schema !== 1) e.push('schema must be 1');
  if (m.kind !== 'game') e.push('kind must be "game"');
  if (!ENGINES.includes(m.engine)) e.push(`engine "${m.engine}" is not one this app plays (${ENGINES.join(', ')})`);
  if (!ID_RE.test(String(m.id || ''))) e.push('id must be 3–64 of a-z 0-9 -');
  if (typeof m.name !== 'string' || !m.name.trim()) e.push('name is missing');
  if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) e.push('version must be x.y.z');
  const w = m.world || {};
  if (!(num(w.width) && num(w.height) && w.width > 0 && w.height > 0 && w.width <= 8192 && w.height <= 8192)) e.push('world.width / height must be 1–8192');
  const images = m.images && typeof m.images === 'object' ? m.images : {};
  if (!images.terrain) e.push('images.terrain is missing');
  const named = [...Object.values(images), m.sprites].filter(Boolean);
  for (const f of named) {
    if (!FILE_RE.test(String(f))) e.push(`file name "${f}" is not allowed`);
    else if (files && !files.includes(f)) e.push(`${f} is missing`);
  }
  if (!m.walk || !poly(m.walk.area)) e.push('walk.area must be a polygon');
  else if (m.walk.blocked && !(Array.isArray(m.walk.blocked) && m.walk.blocked.every(shape))) e.push('walk.blocked must be polygons / ellipses');
  if (!pt(m.spawn)) e.push('spawn must be [x, y]');
  if (m.petHeight !== undefined && !(num(m.petHeight) && m.petHeight >= 8 && m.petHeight <= 400)) e.push('petHeight must be 8–400');
  if (m.petSpeed !== undefined && !(num(m.petSpeed) && m.petSpeed > 0 && m.petSpeed <= 400)) e.push('petSpeed must be 1–400');
  if (!Array.isArray(m.objects)) e.push('objects must be a list');
  const ids = new Set();
  for (const [i, o] of (m.objects || []).entries()) {
    const at = `objects[${i}]`;
    if (!o || typeof o.id !== 'string' || !o.id) { e.push(`${at}.id is missing`); continue; }
    if (ids.has(o.id)) e.push(`${at}: id "${o.id}" twice`);
    ids.add(o.id);
    if (!(num(o.x) && num(o.y)) && !poly(o.hit)) e.push(`${at} (${o.id}): x / y`);
    if (typeof o.sprite !== 'string' && !poly(o.hit)) e.push(`${at} (${o.id}): needs a sprite or a hit polygon`);
    if (sprites) for (const s of [].concat(o.sprite || [], (o.stages || []).filter(Boolean))) if (!sprites[s]) e.push(`${at} (${o.id}): no sprite "${s}"`);
    if (o.block && !shape(o.block)) e.push(`${at} (${o.id}): block`);
    if (o.use) {
      if (!pt(o.use.at)) e.push(`${at} (${o.id}): use.at`);
      if (o.use.anim && !USE_ANIMS.includes(o.use.anim)) e.push(`${at} (${o.id}): use.anim "${o.use.anim}"`);
      if (o.use.effect && !EFFECTS.includes(o.use.effect)) e.push(`${at} (${o.id}): use.effect "${o.use.effect}"`);
      if (o.use.seconds && !(Array.isArray(o.use.seconds) && o.use.seconds.length === 2 && o.use.seconds.every(num))) e.push(`${at} (${o.id}): use.seconds`);
    }
    if (o.lights && !(Array.isArray(o.lights) && o.lights.every((l) => l && num(l.x) && num(l.y) && num(l.r)))) e.push(`${at} (${o.id}): lights`);
  }
  for (const [i, q] of (m.quests || []).entries()) {
    if (!q || typeof q.id !== 'string' || typeof q.title !== 'string' || !q.on || typeof q.on.type !== 'string') e.push(`quests[${i}]: id / title / on.type`);
    else if (q.on.obj && ![].concat(q.on.obj).every((id) => ids.has(id))) e.push(`quests[${i}] (${q.id}): on.obj is not an object here`);
  }
  return e;
}

module.exports = { ENGINES, ID_RE, FILE_RE, USE_ANIMS, EFFECTS, validateManifest };
