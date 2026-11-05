'use strict';
// 商店 → 小游戏 (docs/mini-games.md §7): putting a downloaded game pack in place (a newer version replaces the
// older one) and telling which games, in which versions, are on disk. The rows: core/game-index.js. Electron-free so it can be tested; src/main/catalog.js CatalogDownloader fetches
// the archive and checks its size and sha256 against core/game-index.js, then hands it to installArchive().
//
//   userData/games/<id>/manifest.json   + the pictures it names, at the top level (core/game-pack.js)
//   userData/games/<id>/.catalog.json   the marker: which store entry, version, sha256, when
//
// The disk is the truth, like the voice packs (core/voice-store.js): a game is 已下载 when its folder holds a
// manifest that validateManifest accepts, under its own id. Extra roots (a checkout's catalog/games/, tests) are
// read the same way but never written to or deleted from.
const fs = require('node:fs');
const path = require('node:path');
const GP = require('./game-pack');

const MARKER = '.catalog.json';

const REASON_TEXT = {
  'no-dir': '找不到小游戏文件夹',
  'bad-id': '商店里没有这个小游戏',
  'no-manifest': '下载的小游戏里没有 manifest.json',
  'wrong-id': '下载的小游戏和商店条目对不上',
  'bad-manifest': '下载的小游戏格式不对',
  'stray-file': '下载的小游戏里有多余的文件',
  'write-failed': '写入小游戏文件夹失败',
  'not-found': '这个小游戏没有下载过（可能已经删掉了）',
};
const fail = (reason, errors = []) => ({ ok: false, reason, text: REASON_TEXT[reason] || reason, errors });

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// problems with an unpacked game folder (null = good): a manifest that validates, under `id`, and nothing in the
// folder but it and the files it names (no folders, no links)
function checkFolder(dir, id) {
  const m = readJson(path.join(dir, 'manifest.json'));
  if (!m) return { reason: 'no-manifest', errors: ['manifest.json is missing or not JSON'] };
  if (m.id !== id) return { reason: 'wrong-id', errors: [`manifest id "${m.id}" is not "${id}"`] };
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return { reason: 'no-dir', errors: [e.message] }; }
  // the sprites index: yard@1 has one (its JSON), room@1 one per open room ({ <file>: JSON })
  const read = (f) => (GP.FILE_RE.test(String(f)) && names.includes(f) ? readJson(path.join(dir, f)) : null);
  const sprites = GP.MULTI_INDEX.includes(m.engine) ? Object.fromEntries(GP.spriteFiles(m).map((f) => [f, read(f)]).filter(([, v]) => v)) : m.sprites ? read(m.sprites) : null;
  const errors = GP.validateManifest(m, { files: names, sprites });
  if (errors.length) return { reason: 'bad-manifest', errors };
  const named = new Set(['manifest.json', MARKER, ...GP.namedFiles(m)]);
  for (const name of names) {
    const st = fs.lstatSync(path.join(dir, name));
    if (!st.isFile() || !named.has(name)) return { reason: 'stray-file', errors: [`unexpected ${st.isDirectory() ? 'folder' : 'file'} ${name}`] };
  }
  return null;
}

// every good game folder under the roots: [{ id, name, version, dir, source, manifest }] — the first root that has
// an id wins (userData before a checkout's catalog/games)
function listInstalled(roots) {
  const out = new Map();
  for (const { dir: root, source } of roots) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { continue; }
    for (const name of names) {
      if (out.has(name) || !GP.ID_RE.test(name)) continue;
      const dir = path.join(root, name);
      if (checkFolder(dir, name)) continue;
      const m = readJson(path.join(dir, 'manifest.json'));
      out.set(name, { id: name, name: m.name, version: m.version, description: m.description || '', dir, source, removable: fs.existsSync(path.join(dir, MARKER)) });
    }
  }
  return [...out.values()];
}
const installedIds = (roots) => new Set(listInstalled(roots).map((g) => g.id));
// id → installed version (from its manifest), for 有更新 (core/game-index.js storeRows)
const installedVersions = (roots) => new Map(listInstalled(roots).map((g) => [g.id, g.version]));

// A downloaded archive (sha256 checked already) into `root` as <entry.id>/: unpacked into a hidden folder next to
// it, checked, then renamed into place.
async function installArchive(root, entry, zipFile, { unzip = require('./vrm-import').unzip } = {}) {
  if (!root) return fail('no-dir');
  if (!entry || !GP.ID_RE.test(entry.id)) return fail('bad-id');
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) { return fail('write-failed', [e.message]); }
  const tmp = fs.mkdtempSync(path.join(root, `.${entry.id}-`));
  const dest = path.join(root, entry.id);
  const old = `${dest}.old-${process.pid}-${Date.now()}`;
  let moved = false;
  try {
    try { await unzip(zipFile, tmp); } catch (e) { return fail('bad-manifest', [`unzip: ${String(e.message).slice(0, 200)}`]); }
    const bad = checkFolder(tmp, entry.id);
    if (bad) return fail(bad.reason, bad.errors);
    fs.writeFileSync(path.join(tmp, MARKER), JSON.stringify({ id: entry.id, version: entry.version || '', sha256: entry.sha256, bytes: entry.bytes, installedAt: new Date().toISOString() }, null, 2));
    try {
      if (fs.existsSync(dest)) { fs.renameSync(dest, old); moved = true; }
      fs.renameSync(tmp, dest);
    } catch (e) {
      if (moved && !fs.existsSync(dest)) fs.renameSync(old, dest);
      moved = false;
      return fail('write-failed', [e.message]);
    }
    return { ok: true, id: entry.id };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (moved) fs.rmSync(old, { recursive: true, force: true });
  }
}

// 删除: only a folder the store put there (it carries the marker)
function remove(root, id) {
  if (!root || typeof id !== 'string' || !GP.ID_RE.test(id)) return fail('not-found');
  const dir = path.join(root, id);
  if (!fs.existsSync(path.join(dir, MARKER))) return fail('not-found');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return fail('write-failed', [e.message]); }
  return { ok: true, id };
}

// a game's saved progress (today's quests, lifetime totals): userData/games/.progress/<id>.json — outside the
// game's own folder, so an update or a read-only copy (catalog/games in a checkout) keeps it
const progressFile = (root, id) => path.join(root, '.progress', `${id}.json`);
const readProgress = (root, id) => (GP.ID_RE.test(String(id)) && readJson(progressFile(root, id))) || {};
function writeProgress(root, id, progress) {
  if (!GP.ID_RE.test(String(id))) return;
  const f = progressFile(root, id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(progress));
  fs.renameSync(tmp, f);
}

module.exports = { MARKER, progressFile, REASON_TEXT, checkFolder, listInstalled, installedIds, installArchive, remove, readProgress, writeProgress, installedVersions };
