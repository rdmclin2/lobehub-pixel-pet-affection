'use strict';
// 商店 → 小游戏 · 目录与升级 (docs/mini-games.md §7). Which games the store offers, their newest versions and
// what each store row shows. Two sources, the same format (rdmclin2/pixel-pet-mini-games catalog.json):
//   bundled   src/core/game-catalog.json, shipped with the app (scripts/sync-game-catalog.js copies it from the
//             games repository, with the cover pictures) — what the store shows offline
//   remote    the games repository's catalog.json on GitHub, read now and then (src/main/games.js GameIndex) —
//             a game published after this app was built, or a newer version of one, shows up from it
// Per game the higher version wins. A remote entry is only data: its archive is fetched from LobeHub's CDN at
// a path the app builds itself (core/catalog.js downloadUrl: <CDN>/…/<release>/<file>), checked by size and
// sha256, and unpacked by core/game-store.js, which accepts pictures and JSON only.
// Electron-free and DOM-free (main and the tests require() it).
const fs = require('node:fs');
const path = require('node:path');
const GP = require('./game-pack');
const { sizeLabel } = require('./catalog');
const { deriveState } = require('./voice-store');

const BUNDLED_FILE = path.join(__dirname, 'game-catalog.json');
const REMOTE_URL = 'https://raw.githubusercontent.com/rdmclin2/pixel-pet-mini-games/main/catalog.json';
const REPO_URL = 'https://github.com/rdmclin2/pixel-pet-mini-games';
const SHA_RE = /^[0-9a-f]{64}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const FILE_RE = /^[a-z0-9][a-z0-9.-]*\.zip$/;
const RELEASE_RE = /^games-v\d+$/;
// a remote picture / repository link may only point into the games repository
const PICTURE_RE = /^https:\/\/raw\.githubusercontent\.com\/rdmclin2\/pixel-pet-mini-games\/[\w./-]+\.(webp|png)$/;
const REPO_RE = /^https:\/\/github\.com\/rdmclin2\/pixel-pet-mini-games(\/[\w./-]*)?$/;
// a shipped picture: catalog/games/<id>.webp (the cover) or catalog/games/<id>/<file> (a screenshot), under src/renderer
const WALLPAPER_MAX_BYTES = 120 * 1024 * 1024;
const LOCAL_PIC_RE = /^catalog\/games\/[a-z0-9-]+(\/[a-z0-9][a-z0-9._-]*)?\.(webp|png)$/;

// "1.10.0" > "1.9.3"
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
// one entry, cleaned: anything malformed is dropped (null); unknown fields are not carried
function cleanEntry(g, release, { bundled = false } = {}) {
  if (!g || typeof g !== 'object' || g.type !== 'game' || !GP.ID_RE.test(String(g.id))) return null;
  if (!VER_RE.test(String(g.version)) || typeof g.name !== 'string' || !g.name.trim()) return null;
  if (!FILE_RE.test(String(g.file)) || !SHA_RE.test(String(g.sha256)) || !Number.isInteger(g.bytes) || g.bytes <= 0 || g.bytes > 200 * 1024 * 1024) return null;
  // a wallpaper (docs/wallpaper-mode.md §3.3) is at most 120 MB
  if (g.engine === 'wallpaper@1' && g.bytes > WALLPAPER_MAX_BYTES) return null;
  const okPic = (u) => typeof u === 'string' && (bundled ? LOCAL_PIC_RE.test(u) : PICTURE_RE.test(u));
  const picture = okPic(g.picture) ? g.picture : null;
  // 商店详情页的预览截图: [{ url, caption }], at most 8
  const screenshots = (Array.isArray(g.screenshots) ? g.screenshots : []).filter((x) => x && okPic(x.url)).slice(0, 8).map((x) => ({ url: x.url, caption: str(x.caption, 60) }));
  return {
    id: g.id, type: 'game', name: str(g.name, 40), version: g.version, engine: str(g.engine, 20) || 'yard@1',
    minAppVersion: VER_RE.test(String(g.minAppVersion)) ? g.minAppVersion : null,
    description: str(g.description, 400), credit: str(g.credit, 200),
    features: Array.isArray(g.features) ? g.features.filter((f) => typeof f === 'string').slice(0, 8).map((f) => f.slice(0, 40)) : [],
    repo: typeof g.repo === 'string' && REPO_RE.test(g.repo) ? g.repo : REPO_URL,
    changelog: str(g.changelog, 2000), picture, screenshots,
    file: g.file, bytes: g.bytes, sha256: g.sha256, release,
  };
}

function parseIndex(raw, opts = {}) {
  const release = raw && RELEASE_RE.test(String(raw.release)) ? raw.release : 'games-v1';
  const games = (raw && Array.isArray(raw.games) ? raw.games : []).map((g) => cleanEntry(g, release, opts)).filter(Boolean);
  return { schema: 1, release, games };
}

let bundledCache = null;
function loadBundled(file = BUNDLED_FILE) {
  if (file === BUNDLED_FILE && bundledCache) return bundledCache;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = null; }
  const index = parseIndex(raw, { bundled: true });
  if (file === BUNDLED_FILE) bundledCache = index;
  return index;
}

// bundled + remote: per id the higher version; a remote entry of the same version as the bundled one keeps the
// bundled picture (shipped, works offline). `source` says where the entry came from.
function merge(bundled, remote) {
  const out = new Map();
  for (const g of (bundled && bundled.games) || []) out.set(g.id, { ...g, source: 'bundled' });
  for (const g of (remote && remote.games) || []) {
    const b = out.get(g.id);
    if (!b || compareVersions(g.version, b.version) > 0) out.set(g.id, { ...g, source: 'remote', bundledPicture: b ? b.picture : null, bundledScreenshots: b ? b.screenshots : [] });
    // the same version: the shipped entry, with what the repository may have added since (notes, screenshots)
    else if (b && compareVersions(g.version, b.version) === 0) {
      const sameShots = g.screenshots.length === b.screenshots.length && g.screenshots.every((x, i) => x.caption === b.screenshots[i].caption && x.url.split('/').pop() === b.screenshots[i].url.split('/').pop());
      out.set(g.id, { ...b, repo: g.repo || b.repo, changelog: g.changelog || b.changelog, ...(sameShots ? {} : { screenshots: g.screenshots, bundledScreenshots: b.screenshots }) });
    }
  }
  return { games: [...out.values()] };
}

// can this app play it? (an engine it has, a new enough app)
function supported(g, { engines = GP.ENGINES, appVersion = '0.0.0' } = {}) {
  if (!engines.includes(g.engine)) return { ok: false, reason: 'engine' };
  if (g.minAppVersion && compareVersions(appVersion, g.minAppVersion) < 0) return { ok: false, reason: 'app' };
  return { ok: true };
}

const STATE_LABEL = { remote: '未下载', downloading: '下载中', installed: '已下载', update: '有更新', unsupported: '需要更新应用' };

// 商店 → 小游戏 rows. `installed`: id → installed version; `downloads`: CatalogDownloader state() / the last
// catalog-progress per id. States: remote · downloading · installed · update (a newer version is out: 更新) ·
// unsupported (this app cannot play it: 需要先更新应用; a game already installed stays playable).
function storeRows(index, installed = new Map(), downloads = [], ctx = {}) {
  const jobs = new Map(downloads.map((d) => [d.id, d]));
  return index.games.map((g) => {
    const have = installed.get(g.id) || null;
    const ok = supported(g, ctx);
    const newer = !!have && compareVersions(g.version, have) > 0;
    let s = deriveState(!!have && !newer, jobs.get(g.id));
    if (s.state !== 'downloading') {
      if (!ok.ok && (!have || newer)) s = { state: have ? 'installed' : 'unsupported', ...(have ? { updateBlocked: ok.reason } : {}) };
      else if (newer) s = { ...s, state: 'update' };
    }
    return {
      id: g.id, name: g.name, version: g.version, installedVersion: have, engine: g.engine, kind: GP.kindOf(g.engine), minAppVersion: g.minAppVersion,
      description: g.description, credit: g.credit, features: g.features, repo: g.repo, changelog: g.changelog,
      picture: g.picture, bundledPicture: g.bundledPicture || null, source: g.source || 'bundled',
      screenshots: g.screenshots || [], bundledScreenshots: g.bundledScreenshots || [],
      bytes: g.bytes, sizeLabel: sizeLabel(g.bytes), supported: ok.ok, unsupportedReason: ok.ok ? null : ok.reason,
      ...s, stateLabel: STATE_LABEL[s.state],
    };
  });
}

// the installed games that have a newer, playable version: [{ id, from, to, changelog }]
function updates(index, installed, ctx = {}) {
  return index.games.filter((g) => installed.has(g.id) && compareVersions(g.version, installed.get(g.id)) > 0 && supported(g, ctx).ok)
    .map((g) => ({ id: g.id, name: g.name, from: installed.get(g.id), to: g.version, changelog: g.changelog }));
}

module.exports = { WALLPAPER_MAX_BYTES, BUNDLED_FILE, REMOTE_URL, REPO_URL, STATE_LABEL, compareVersions, cleanEntry, parseIndex, loadBundled, merge, supported, storeRows, updates };
