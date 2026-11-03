'use strict';

// 内置与下载 (docs/characters.md): the app ships five characters, each base's pixel look (src/renderer/packs/
// <base>-pixel). Every other look — 旧版像素, 全动态, Live2D, 成年版, 大肥鱼's 原版动画 — is a character the owner
// downloads first. The index of those (src/core/character-catalog.json, written by scripts/build-character-
// catalog.js) ships with the app: name, kind, size and sha256 per character, so the 角色图鉴 lists them, with a
// picture, before anything is fetched. Electron-free so it can be tested; src/main/catalog.js downloads.
//
// Where the archives are fetched from: PIXELPET_CATALOG_URL (tests, a mirror), else settings.catalogUrl, else
// DEFAULT_BASE_URL (the GitHub release named by the index). `<base>/<file>`; file: URLs work too.

const fs = require('node:fs');
const path = require('node:path');

const INDEX_FILE = path.join(__dirname, 'character-catalog.json');
const REPO = 'rdmclin2/lobehub-pixel-pet-affection';
const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
// the marker an installed download carries in its folder: which catalog entry, which archive
const MARKER = '.catalog.json';

let cached = null;
function loadIndex(file = INDEX_FILE) {
  if (file === INDEX_FILE && cached) return cached;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const characters = (raw && Array.isArray(raw.characters) ? raw.characters : []).filter((c) => c && ID_RE.test(c.id) && ['pack', 'clips'].includes(c.type) && typeof c.file === 'string' && /^[a-z0-9-]+\.zip$/.test(c.file) && SHA_RE.test(c.sha256) && Number.isInteger(c.bytes) && c.bytes > 0);
  const index = { schema: (raw && raw.schema) || 1, release: (raw && typeof raw.release === 'string' && raw.release) || 'characters-v1', characters };
  if (file === INDEX_FILE) cached = index;
  return index;
}

const DEFAULT_BASE_URL = `https://github.com/${REPO}/releases/download/${loadIndex().release}`;

function baseUrl(settings, env = process.env) {
  const pick = [env && env.PIXELPET_CATALOG_URL, settings && settings.catalogUrl].find((u) => typeof u === 'string' && /^(https?|file):\/\//.test(u.trim()));
  return (pick ? pick.trim() : DEFAULT_BASE_URL).replace(/\/+$/, '');
}

const entry = (id, index = loadIndex()) => index.characters.find((c) => c.id === id) || null;
const downloadUrl = (e, settings, env) => `${baseUrl(settings, env)}/${e.file}`;

// 「23.4 MB」
function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// The catalog characters not installed now, as roster entries (core/characters.js shape) with `download`:
// 18+ ones only when `adultOk`. `installed(id)` says whether one is on disk already.
function notInstalled(installed, { adultOk = false, index = loadIndex() } = {}) {
  return index.characters
    .filter((c) => !installed(c.id) && (adultOk || !c.adult))
    .map((c) => ({ id: c.id, base: c.base, name: c.name, kind: c.kind, adult: !!c.adult, author: c.author || '', license: c.license || '', description: c.description || '', outfits: c.outfits || 0, picture: c.picture || null, pixelated: !!c.pixelated, bytes: c.bytes, sizeLabel: sizeLabel(c.bytes), version: c.version || '' }));
}

// The packs of a repo checkout with everything in catalog/ counted as downloaded (and the clips there marked
// installed, core/characters.js hasClips): what tests and PetService's default use. The app itself always
// passes its pack store's packs (src/main/packs.js); catalog/ does not ship.
const REPO_ROOT = path.join(__dirname, '..', '..');
function repoPacks({ catalog = true } = {}) {
  const P = require('./packs');
  const roots = [{ dir: path.join(REPO_ROOT, 'src', 'renderer', 'packs'), source: 'builtin' }];
  const cat = path.join(REPO_ROOT, 'catalog');
  if (catalog && fs.existsSync(cat)) roots.push({ dir: path.join(cat, 'packs'), source: 'download' });
  const r = P.loadPacks(roots);
  const clips = catalog && fs.existsSync(path.join(cat, 'clips')) ? fs.readdirSync(path.join(cat, 'clips')).filter((n) => /-clips$/.test(n)) : [];
  r.packs.clips = new Set(clips);
  return r;
}

module.exports = { INDEX_FILE, MARKER, DEFAULT_BASE_URL, loadIndex, baseUrl, entry, downloadUrl, sizeLabel, notInstalled, repoPacks };
