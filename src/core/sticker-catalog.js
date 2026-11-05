'use strict';

// 商店 → 表情包 · 目录 (docs/stickers-design.md §5.2 方案 B): the official sticker sets, each a zip
// (core/sticker-set.js) on LobeHub's public CDN under dc/ops-assets/archives/pixel-pet/<release>/, put there by
// the maintainer's scripts/publish-sticker-set.mjs through the Develop Center (`dc ops-assets upload`).
//
// The index, sticker-catalog.json, lives next to them on the CDN and is read by the app (src/main/sticker-
// store.js) when the store opens; the copy shipped with the app (src/core/sticker-catalog.json, written by the
// same script) is what the store shows when the CDN cannot be reached. Every picture the store shows before a
// set is fetched — the cover and each sticker's preview — is a file of its own next to the zip,
// `previews/<sha256>.<ext>`, so main can check it by its name before serving it (the settings window's CSP
// takes no web images).
//
//   { schema: 1, release: "stickers-v1", updatedAt, sets: [{ id, type: "sticker-set", name, description,
//     author, official, license, version, forSpecies, count, cover, previews: [{ id, label, desc, file, bytes,
//     sha256 }], file, bytes, sha256 }] }
//
// Electron-free: main and the tests require() it.

const fs = require('node:fs');
const path = require('node:path');
const { CDN_ORIGIN, UPLOAD_PREFIX_ROOT, sizeLabel } = require('./catalog');
const { SET_ID_RE, VER_RE } = require('./sticker-set');
const { ID_RE, MAX_PER_SET } = require('./stickers');

const BUNDLED_FILE = path.join(__dirname, 'sticker-catalog.json');
const RELEASE = 'stickers-v1';
const RELEASE_RE = /^stickers-v\d+$/;
const INDEX_NAME = 'sticker-catalog.json';
const REMOTE_URL = `${CDN_ORIGIN}/${UPLOAD_PREFIX_ROOT}/${RELEASE}/${INDEX_NAME}`;
const SHA_RE = /^[0-9a-f]{64}$/;
const ZIP_RE = /^[a-z0-9][a-z0-9-]*\.zip$/;
const PREVIEW_RE = /^previews\/([0-9a-f]{64})\.(png|webp|gif|jpg)$/;
const SPECIES_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
const MAX_ZIP_BYTES = 60 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function cleanPreview(p) {
  if (!p || !ID_RE.test(String(p.id || ''))) return null;
  const m = PREVIEW_RE.exec(String(p.file || ''));
  if (!m || p.sha256 !== m[1] || !Number.isInteger(p.bytes) || p.bytes <= 0 || p.bytes > MAX_PREVIEW_BYTES) return null;
  return { id: p.id, label: str(p.label, 20) || p.id, desc: str(p.desc, 60), file: p.file, bytes: p.bytes, sha256: p.sha256 };
}

// one entry, cleaned: anything malformed is dropped (null); unknown fields are not carried
function cleanEntry(s, release) {
  if (!s || typeof s !== 'object' || s.type !== 'sticker-set' || !SET_ID_RE.test(String(s.id || ''))) return null;
  const name = str(s.name, 30);
  const author = str(s.author, 120);
  const license = str(s.license, 120);
  if (!name || !author || !license || !VER_RE.test(String(s.version || ''))) return null;
  if (!ZIP_RE.test(String(s.file || '')) || !SHA_RE.test(String(s.sha256 || '')) || !Number.isInteger(s.bytes) || s.bytes <= 0 || s.bytes > MAX_ZIP_BYTES) return null;
  const previews = (Array.isArray(s.previews) ? s.previews : []).slice(0, MAX_PER_SET).map(cleanPreview).filter(Boolean);
  const count = Number.isInteger(s.count) && s.count > 0 && s.count <= MAX_PER_SET ? s.count : previews.length;
  if (!count) return null;
  const cover = previews.find((p) => p.id === s.cover) || previews[0] || null;
  return {
    id: s.id, type: 'sticker-set', name, description: str(s.description, 200), author, license, official: s.official !== false,
    version: s.version, forSpecies: (Array.isArray(s.forSpecies) ? s.forSpecies : []).filter((x) => SPECIES_RE.test(String(x))).slice(0, 20),
    count, cover: cover ? cover.id : null, previews, file: s.file, bytes: s.bytes, sha256: s.sha256, release,
  };
}

// -> { schema, release, updatedAt, sets } (sets possibly empty: a broken index offers nothing)
function parseIndex(raw) {
  const release = raw && RELEASE_RE.test(String(raw.release || '')) ? raw.release : RELEASE;
  const seen = new Set();
  const sets = [];
  for (const s of raw && Array.isArray(raw.sets) ? raw.sets : []) {
    const e = cleanEntry(s, release);
    if (e && !seen.has(e.id)) { seen.add(e.id); sets.push(e); }
  }
  return { schema: 1, release, updatedAt: str(raw && raw.updatedAt, 40), sets };
}

// A JSON body as fetched: a valid index with at least one set, or null (the store falls back).
function parseRemote(body) {
  let raw = body;
  if (typeof body === 'string') { try { raw = JSON.parse(body); } catch { return null; } }
  if (!raw || raw.schema !== 1 || !Array.isArray(raw.sets)) return null;
  const index = parseIndex(raw);
  return index.sets.length ? index : null;
}

let bundledCache = null;
function loadBundled(file = BUNDLED_FILE) {
  if (file === BUNDLED_FILE && bundledCache) return bundledCache;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = null; }
  const index = parseIndex(raw);
  if (file === BUNDLED_FILE) bundledCache = index;
  return index;
}

// Which index the store shows: the CDN's when it was read (now, or the last good read kept on disk), else
// the bundled one. -> { index, source: 'remote' | 'cache' | 'bundled' }
function pick({ remote = null, cached = null, bundled = loadBundled() } = {}) {
  if (remote && remote.sets.length) return { index: remote, source: 'remote' };
  if (cached && cached.sets.length) return { index: cached, source: 'cache' };
  return { index: bundled, source: 'bundled' };
}

// Where an entry's files are: the CDN (<origin>/<root>/<release>/<file>), or `base` (a mirror or a test server
// holding every file of the release in one folder: PIXELPET_STICKER_BASE_URL).
const fileUrl = (e, file, base = null) => `${base ? base.replace(/\/+$/, '') : `${CDN_ORIGIN}/${UPLOAD_PREFIX_ROOT}/${e.release || RELEASE}`}/${file}`;

// 商店 → 表情包 rows: each set with whether it is 已获取 and to whom. `installed`: Map storeId → { version,
// attached: [speciesId] }; `names`: speciesId → her name (for 适用角色 and 已挂到).
function rows(index, installed = new Map(), names = {}) {
  return index.sets.map((s) => {
    const have = installed.get(s.id) || null;
    return {
      id: s.id, name: s.name, description: s.description, author: s.author, official: s.official, license: s.license,
      version: s.version, count: s.count, bytes: s.bytes, sizeLabel: sizeLabel(s.bytes),
      forSpecies: s.forSpecies.map((id) => ({ id, name: names[id] || id })),
      installed: !!have, installedVersion: have ? have.version : null, update: !!have && have.version !== s.version,
      attached: have ? have.attached.map((id) => ({ id, name: names[id] || id })) : [],
    };
  });
}

module.exports = { BUNDLED_FILE, RELEASE, INDEX_NAME, REMOTE_URL, PREVIEW_RE, MAX_PREVIEW_BYTES, parseIndex, parseRemote, loadBundled, pick, fileUrl, rows, cleanEntry };
