'use strict';

// 商店 → 语音包 (docs/voice-packs.md §7): putting a downloaded 风格语音包 in place, telling which ones are on disk, and
// what each store row shows. Electron-free so it can be tested; src/main/catalog.js CatalogDownloader fetches the
// archive and checks its size and sha256 against src/core/voice-catalog.json, then hands it to installArchive().
//
//   userData/voicepacks/<id>/manifest.json   + the audio files it names, at the top level
//   userData/voicepacks/<id>/.catalog.json   the marker: which store entry, version, sha256, when
//
// The disk is the truth: a pack is 已下载 when its folder holds a manifest that core/voice-pack.js validateManifest
// accepts, under the id the store knows it by. Nothing about downloads is kept in settings, so a restart, a
// deleted folder or a pack copied in by hand all show as they are.

const fs = require('node:fs');
const path = require('node:path');
const VP = require('./voice-pack');

const MARKER = '.catalog.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

const REASON_TEXT = {
  'no-dir': '找不到语音包文件夹',
  'bad-id': '商店里没有这个语音包',
  'no-manifest': '下载的语音包里没有 manifest.json',
  'wrong-id': '下载的语音包和商店条目对不上',
  'not-style': '下载的不是风格语音包',
  'bad-manifest': '下载的语音包格式不对',
  'stray-file': '下载的语音包里有多余的文件',
  'write-failed': '写入语音包文件夹失败',
  'not-found': '这个语音包没有下载过（可能已经删掉了）',
};
const fail = (reason, errors = []) => ({ ok: false, reason, text: REASON_TEXT[reason] || reason, errors });

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Problems with an unpacked pack folder (empty = good): a style pack whose manifest validates (every audio file
// there), under `id`, holding nothing but the manifest and the files it names (no folders, no links).
function checkFolder(dir, id) {
  const m = readJson(path.join(dir, 'manifest.json'));
  if (!m) return { reason: 'no-manifest', errors: ['manifest.json is missing or not JSON'] };
  if (m.id !== id) return { reason: 'wrong-id', errors: [`manifest id "${m.id}" is not "${id}"`] };
  if (m.kind !== 'style') return { reason: 'not-style', errors: ['kind is not "style"'] };
  const errors = VP.validateManifest(m, dir);
  if (errors.length) return { reason: 'bad-manifest', errors };
  const named = new Set(['manifest.json', MARKER, m.sample.file, ...Object.values(m.lines)]);
  for (const name of fs.readdirSync(dir)) {
    const st = fs.lstatSync(path.join(dir, name));
    if (!st.isFile() || !named.has(name)) return { reason: 'stray-file', errors: [`unexpected ${st.isDirectory() ? 'folder' : 'file'} ${name}`] };
  }
  return null;
}

// The store ids downloaded into `root` (userData/voicepacks): each folder <id>/ with a valid style manifest whose
// id is the folder's name. `ids` (optional): only look at these.
function installedIds(root, ids = null) {
  const out = new Set();
  if (!root) return out;
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name); } catch { return out; }
  for (const name of names) {
    if (!ID_RE.test(name) || (ids && !ids.has(name))) continue;
    const m = readJson(path.join(root, name, 'manifest.json'));
    if (m && m.id === name && m.kind === 'style' && !VP.validateManifest(m, path.join(root, name)).length) out.add(name);
  }
  return out;
}

// A downloaded archive (sha256 checked already) into `root` as <entry.id>/. Unpacked into a hidden folder next to
// it first (VoicePacks skips dot folders), checked, then renamed into place: on any problem nothing is left behind
// and a pack that was there before stays as it was. → { ok, id } | { ok: false, reason, text, errors }
async function installArchive(root, entry, zipFile, { unzip = require('./vrm-import').unzip } = {}) {
  if (!root) return fail('no-dir');
  if (!entry || !ID_RE.test(entry.id)) return fail('bad-id');
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
      if (moved && !fs.existsSync(dest)) fs.renameSync(old, dest); // put the earlier one back
      moved = false;
      return fail('write-failed', [e.message]);
    }
    return { ok: true, id: entry.id };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (moved) fs.rmSync(old, { recursive: true, force: true });
  }
}

// 删除语音包: only a folder the store put there (it carries the marker), so a pack the owner made by hand is never
// deleted from here.
function remove(root, id) {
  if (!root || typeof id !== 'string' || !ID_RE.test(id)) return fail('not-found');
  const dir = path.join(root, id);
  if (!fs.existsSync(path.join(dir, MARKER))) return fail('not-found');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return fail('write-failed', [e.message]); }
  return { ok: true, id };
}

// What a store row shows: 'remote' (未下载) | 'downloading' (下载中, with percent; `installing` while it is being
// unpacked) | 'installed' (已下载). `installed`: on disk now; `progress`: the last `catalog-progress` for it (or a
// CatalogDownloader state() row). A failed or canceled download is 'remote' again, with its text.
function deriveState(installed, progress) {
  const p = progress || null;
  if (p && (p.state === 'downloading' || p.state === 'installing')) {
    const total = Number(p.total) || 0;
    const percent = total ? Math.min(100, Math.floor(((Number(p.received) || 0) / total) * 100)) : 0;
    return { state: 'downloading', percent, installing: p.state === 'installing' };
  }
  if (installed) return { state: 'installed' };
  return { state: 'remote', ...(p && p.state === 'failed' && p.reason !== 'canceled' ? { error: p.text || p.reason } : {}) };
}

const STATE_LABEL = { remote: '未下载', downloading: '下载中', installed: '已下载' };

// 商店 → 语音包 rows: core/catalog.js listVoicePacks with the state each is in now.
function storeRows(rows, downloads = []) {
  const jobs = new Map(downloads.map((d) => [d.id, d]));
  return rows.map((r) => {
    const s = deriveState(r.installed, jobs.get(r.id));
    return { ...r, ...s, stateLabel: STATE_LABEL[s.state] };
  });
}

module.exports = { MARKER, REASON_TEXT, STATE_LABEL, checkFolder, installedIds, installArchive, remove, deriveState, storeRows };
