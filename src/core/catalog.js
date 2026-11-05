'use strict';

// 内置与下载 (docs/characters.md): the app ships five characters, each base's pixel look (src/renderer/packs/
// <base>-pixel). Every other look — 旧版像素, 全动态, Live2D, 成年版, 大肥鱼's 原版动画 — is a character the owner
// downloads first. The index of those (src/core/character-catalog.json, written by scripts/build-character-
// catalog.js) ships with the app: name, kind, size and sha256 per character, so the 角色图鉴 lists them, with a
// picture, before anything is fetched. Electron-free so it can be tested; src/main/catalog.js downloads.
//
// Where the archives are fetched from: PIXELPET_CATALOG_URL (tests, a mirror), else settings.catalogUrl, else
// DEFAULT_BASE_URL: LobeHub's public CDN, where `npm run catalog:upload` puts them through the Develop Center
// (`dc ops-assets upload`, under dc/ops-assets/archives/pixel-pet/<release>/). `<base>/<file>`; file: URLs work too.

const fs = require('node:fs');
const path = require('node:path');

const INDEX_FILE = path.join(__dirname, 'character-catalog.json');
// Develop Center ops assets (S3, public through the CDN): zips may only live under dc/ops-assets/archives/
const CDN_ORIGIN = 'https://chat-cloud.lobeobjects.space';
const UPLOAD_PREFIX_ROOT = 'dc/ops-assets/archives/pixel-pet';
const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
// the marker an installed download carries in its folder: which catalog entry, which archive
const MARKER = '.catalog.json';

let cached = null;
// an archive over the CDN's 20 MB per file is listed as `parts` (<id>-p1.zip …) whose sizes add up to `bytes`
const okParts = (c) => {
  if (!Array.isArray(c.parts)) return { parts: undefined };
  const ok = c.parts.length > 1 && c.parts.every((x) => x && typeof x.file === 'string' && /^[a-z0-9-]+\.zip$/.test(x.file) && Number.isInteger(x.bytes) && x.bytes > 0) && c.parts.reduce((n, x) => n + x.bytes, 0) === c.bytes;
  return { parts: ok ? c.parts.map((x) => ({ file: x.file, bytes: x.bytes })) : undefined };
};
const okEntry = (c) => c && ID_RE.test(c.id) && ['pack', 'clips'].includes(c.type) && typeof c.file === 'string' && /^[a-z0-9-]+\.zip$/.test(c.file) && SHA_RE.test(c.sha256) && Number.isInteger(c.bytes) && c.bytes > 0;
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
function loadIndex(file = INDEX_FILE) {
  if (file === INDEX_FILE && cached) return cached;
  const raw = readJson(file);
  const release = (raw && typeof raw.release === 'string' && raw.release) || 'characters-v1';
  const characters = (raw && Array.isArray(raw.characters) ? raw.characters : []).filter(okEntry).map((c) => ({ ...c, release: typeof c.release === 'string' && c.release ? c.release : release, ...okParts(c) }));
  const index = { schema: (raw && raw.schema) || 1, release, characters };
  if (file === INDEX_FILE) cached = index;
  return index;
}

// 商店 → 角色 / VRM (scripts/build-store-assets.js): the VRM models live in their own index and release
// (src/core/vrm-catalog.json, vrm-v2); everything the app downloads as a character is both indexes together.
const VRM_INDEX_FILE = path.join(__dirname, 'vrm-catalog.json');
let storeCached = null;
function storeIndex({ characters = INDEX_FILE, vrm = VRM_INDEX_FILE } = {}) {
  const useCache = characters === INDEX_FILE && vrm === VRM_INDEX_FILE;
  if (useCache && storeCached) return storeCached;
  const base = loadIndex(characters);
  const v = loadIndex(vrm);
  const seen = new Set(base.characters.map((c) => c.id));
  const index = { schema: base.schema, release: base.release, characters: [...base.characters, ...v.characters.filter((c) => c.kind === 'vrm' && !seen.has(c.id))] };
  if (useCache) storeCached = index;
  return index;
}

// 商店 → 舞蹈 (src/core/dance-catalog.json, dances-v1): one archive per dance (dance.json, dance.vrma, audio,
// cover, readme), installed into the dance library (src/main/vrm-dances.js).
const DANCE_INDEX_FILE = path.join(__dirname, 'dance-catalog.json');
const DANCE_ID_RE = /^dance-[a-z0-9-]{1,42}$/;
let danceCached = null;
function loadDanceIndex(file = DANCE_INDEX_FILE) {
  if (file === DANCE_INDEX_FILE && danceCached) return danceCached;
  const raw = readJson(file);
  const release = (raw && typeof raw.release === 'string' && raw.release) || 'dances-v1';
  const dances = (raw && Array.isArray(raw.dances) ? raw.dances : [])
    .filter((d) => d && DANCE_ID_RE.test(d.id) && d.type === 'dance' && typeof d.file === 'string' && /^[a-z0-9-]+\.zip$/.test(d.file) && SHA_RE.test(d.sha256) && Number.isInteger(d.bytes) && d.bytes > 0)
    .map((d) => ({ ...d, release, ...okParts(d) }));
  const index = { schema: (raw && raw.schema) || 1, release, dances };
  if (file === DANCE_INDEX_FILE) danceCached = index;
  return index;
}
const danceEntry = (id, index = loadDanceIndex()) => index.dances.find((d) => d.id === id) || null;

// 商店 → 语音包 (src/core/voice-catalog.json, voices-v1, written by scripts/build-voice-catalog.js; docs/voice-packs.md
// §6): one archive per 风格语音包 (manifest.json + audio at the top level), to be unpacked into userData/voicepacks/<id>/
// where core/voice-pack.js VoicePacks loads it. `sample.file` is the 试听 line shipped with the app (relative to
// src/renderer/), playable before the archive is fetched.
const VOICE_INDEX_FILE = path.join(__dirname, 'voice-catalog.json');
const VOICE_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
let voiceCached = null;
const okVoice = (v) => v && VOICE_ID_RE.test(v.id) && v.type === 'voice-pack' && typeof v.name === 'string' && typeof v.style === 'string'
  && typeof v.file === 'string' && /^[a-z0-9-]+\.zip$/.test(v.file) && SHA_RE.test(v.sha256) && Number.isInteger(v.bytes) && v.bytes > 0
  && Number.isInteger(v.lines) && v.lines > 0 && v.sample && typeof v.sample.text === 'string' && typeof v.sample.file === 'string';
function loadVoiceIndex(file = VOICE_INDEX_FILE) {
  if (file === VOICE_INDEX_FILE && voiceCached) return voiceCached;
  const raw = readJson(file);
  const release = (raw && typeof raw.release === 'string' && raw.release) || 'voices-v1';
  const voicePacks = (raw && Array.isArray(raw.voicePacks) ? raw.voicePacks : []).filter(okVoice).map((v) => ({ ...v, release, ...okParts(v) }));
  const index = { schema: (raw && raw.schema) || 1, release, voicePacks };
  if (file === VOICE_INDEX_FILE) voiceCached = index;
  return index;
}
const voicePackEntry = (id, index = loadVoiceIndex()) => index.voicePacks.find((v) => v.id === id) || null;
// 商店 → 语音包: every voice pack of the store, each with `installed` (its id is loaded in VoicePacks now).
const voiceRow = (v, installed) => ({ id: v.id, name: v.name, style: v.style, styleLabel: v.styleLabel || v.style, gender: v.gender || null, version: v.version || '', description: v.description || '', credit: v.credit || '', engine: v.engine || '', voiceId: v.voiceId || '', lines: v.lines, seconds: v.seconds || 0, sample: v.sample, bytes: v.bytes, sizeLabel: sizeLabel(v.bytes), installed });
function listVoicePacks(installed, { index = loadVoiceIndex() } = {}) {
  return index.voicePacks.map((v) => voiceRow(v, !!installed(v.id)));
}

const UPLOAD_PREFIX = `${UPLOAD_PREFIX_ROOT}/${loadIndex().release}`;
const DEFAULT_BASE_URL = `${CDN_ORIGIN}/${UPLOAD_PREFIX}`;

function override(settings, env) {
  const pick = [env && env.PIXELPET_CATALOG_URL, settings && settings.catalogUrl].find((u) => typeof u === 'string' && /^(https?|file):\/\//.test(u.trim()));
  return pick ? pick.trim().replace(/\/+$/, '') : null;
}
function baseUrl(settings, env = process.env) {
  return override(settings, env) || DEFAULT_BASE_URL;
}

const entry = (id, index = storeIndex()) => index.characters.find((c) => c.id === id) || null;
// a mirror / test server holds every archive in one folder; the CDN keeps each release under its own prefix
const downloadUrl = (e, settings, env = process.env) => `${override(settings, env) || `${CDN_ORIGIN}/${UPLOAD_PREFIX_ROOT}/${e.release || loadIndex().release}`}/${e.file}`;

// 「23.4 MB」
function sizeLabel(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// The catalog characters not installed now, as roster entries (core/characters.js shape) with `download`:
// 18+ ones only when `adultOk`. `installed(id)` says whether one is on disk already.
const row = (c, installed) => ({ id: c.id, base: c.base, name: c.name, kind: c.kind, adult: !!c.adult, author: c.author || '', license: c.license || '', description: c.description || '', outfits: c.outfits || 0, picture: c.picture || null, pixelated: !!c.pixelated, bytes: c.bytes, sizeLabel: sizeLabel(c.bytes), version: c.version || '', installed, ...(Array.isArray(c.licenseRows) ? { licenseRows: c.licenseRows, redistributable: !!c.redistributable } : {}) });

function notInstalled(installed, { adultOk = false, index = storeIndex() } = {}) {
  return index.characters.filter((c) => !installed(c.id) && (adultOk || !c.adult)).map((c) => row(c, false));
}

// 商店 → 角色: every catalog character (18+ only when `adultOk`), each with `installed`.
function listAll(installed, { adultOk = false, index = storeIndex() } = {}) {
  return index.characters.filter((c) => adultOk || !c.adult).map((c) => row(c, !!installed(c.id)));
}

// 商店 → 舞蹈: every dance of the store, each with `installed` (in the dance library now).
const danceRow = (d, installed) => ({ id: d.id, name: d.name, credit: d.credit || '', description: d.description || '', duration: d.duration, music: !!d.music, face: !!d.face, picture: d.picture || null, bytes: d.bytes, sizeLabel: sizeLabel(d.bytes), installed });
function listDances(installed, { index = loadDanceIndex() } = {}) {
  return index.dances.map((d) => danceRow(d, !!installed(d.id)));
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

module.exports = { VOICE_INDEX_FILE, loadVoiceIndex, voicePackEntry, listVoicePacks, INDEX_FILE, VRM_INDEX_FILE, DANCE_INDEX_FILE, MARKER, CDN_ORIGIN, UPLOAD_PREFIX_ROOT, UPLOAD_PREFIX, DEFAULT_BASE_URL, loadIndex, storeIndex, loadDanceIndex, danceEntry, listDances, baseUrl, entry, downloadUrl, sizeLabel, notInstalled, listAll, repoPacks };
