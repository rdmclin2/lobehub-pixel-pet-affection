'use strict';

// Importing and deleting the owner's own dances (docs/vrm-dance.md §5.5), for the settings window's 舞蹈 page.
//
//   inspect(paths)        what was picked (a folder, or files: .vmd + optional music / cover / readme) → a draft the
//                         confirm dialog shows: name, the motion (and the other candidates), music, cover preview,
//                         length, credit and readme excerpt; or { ok: false, reason, message } in plain words
//   addExtra(token, kind, path)   swap in another music / cover file for the draft
//   commit({ token, name, motion, audio, cover })   bake the VMD in a worker (src/main/dance-bake-worker.js), then
//                         write <dances dir>/<id>/{dance.vrma, audio.<ext>, cover.<ext>, readme.txt, src/<vmd>} (into a
//                         temporary folder renamed into place) and add the entry to library.json (temp file + rename)
//   cancel(token)         stop a bake in progress
//   remove(dir, id)       delete an imported dance: its folder and its entry (the built-in demo cannot be deleted)
//
// Nothing here goes near the repository: the dances dir is refused there (src/main/vrm-dances.js danceDir).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VMD = require('../core/vmd');
const Dances = require('../core/vrm-dances');
const { insideRepo } = require('./vrm-dances');

const MB = 1024 * 1024;
const LIMITS = { vmd: 64 * MB, audio: 200 * MB, cover: 10 * MB };
const SESSION_MS = 30 * 60 * 1000;
const COVER_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const sessions = new Map(); // token → { files: Map(path → size), motions: Map(path → { duration, keys }), readme, at }
let baking = null; // { token, worker, cancel() }

const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };
const label = (p) => path.basename(p);
function coverData(p) {
  const s = stat(p);
  if (!s || s.size > LIMITS.cover) return null;
  return `data:${COVER_MIME[Dances.fileExt(p)] || 'image/png'};base64,${fs.readFileSync(p).toString('base64')}`;
}
function readmeText(p) {
  if (!p) return '';
  try {
    const buf = fs.readFileSync(p).subarray(0, 64 * 1024);
    let s = buf.toString('utf8');
    // an old MMD readme is often Shift-JIS: decode it when UTF-8 gives replacement characters
    if (/�/.test(s)) { try { s = new TextDecoder('shift_jis').decode(buf); } catch { /* keep the UTF-8 */ } }
    return s.replace(/^﻿/, '');
  } catch { return ''; }
}

// The picked paths as a listing for core/vrm-dances.js detectDance: a folder (its files, not its subfolders) or files.
function listingOf(paths) {
  const list = (paths || []).filter((p) => typeof p === 'string' && p);
  let folder = null;
  let files = [];
  if (list.length === 1 && stat(list[0]) && stat(list[0]).isDirectory()) {
    folder = list[0];
    files = fs.readdirSync(folder).map((f) => path.join(folder, f)).filter((p) => { const s = stat(p); return s && s.isFile(); });
  } else files = list.filter((p) => { const s = stat(p); return s && s.isFile(); });
  return { folder, files: files.map((p) => ({ path: p, size: stat(p).size })) };
}

function inspect(paths) {
  const { folder, files } = listingOf(paths);
  if (!files.length) return Dances.importError('no-files');
  if (files.some((f) => insideRepo(f.path))) return Dances.importError('no-files');
  let meta = null;
  const metaFile = files.find((f) => path.basename(f.path).toLowerCase() === 'meta.json');
  if (metaFile) { try { meta = JSON.parse(fs.readFileSync(metaFile.path, 'utf8')); } catch { meta = null; } }
  const motions = [];
  const info = new Map();
  for (const f of files.filter((x) => /\.vmd$/i.test(x.path))) {
    if (f.size > LIMITS.vmd) { motions.push({ path: f.path, kind: 'bad', keys: 0 }); continue; }
    try {
      const v = VMD.parseVmd(fs.readFileSync(f.path));
      const kind = VMD.classifyVmd(v);
      motions.push({ path: f.path, kind, keys: v.bones.length });
      if (kind === 'motion') info.set(f.path, { duration: +(VMD.lastFrame(v) / VMD.FPS).toFixed(2), keys: v.bones.length });
    } catch { motions.push({ path: f.path, kind: 'bad', keys: 0 }); }
  }
  const d = Dances.detectDance({ files, meta, motions, folder: folder ? path.basename(folder) : null });
  if (!d.ok) return d;
  if (files.find((f) => f.path === d.motion).size > LIMITS.vmd) return Dances.importError('too-big');
  const token = crypto.randomBytes(12).toString('hex');
  const readme = readmeText(d.readme);
  sessions.set(token, { files: new Map(files.map((f) => [f.path, f.size])), motions: info, readme: d.readme, source: d.source, at: Date.now() });
  for (const [t, s] of sessions) if (Date.now() - s.at > SESSION_MS) sessions.delete(t);
  const audioOk = (p) => p && (sessions.get(token).files.get(p) || 0) <= LIMITS.audio;
  return {
    ok: true, token, source: d.source, name: d.name, folder: folder || null,
    motion: d.motion, motions: [d.motion, ...d.others].map((p) => ({ path: p, label: label(p), ...info.get(p) })),
    duration: (info.get(d.motion) || {}).duration || 0,
    audio: audioOk(d.audio) ? d.audio : null, audios: d.audios.filter(audioOk).map((p) => ({ path: p, label: label(p) })),
    cover: d.cover, covers: d.covers.map((p) => ({ path: p, label: label(p) })), coverData: d.cover ? coverData(d.cover) : null,
    readme: d.readme ? { file: label(d.readme), excerpt: readme.trim().slice(0, 600) } : null,
    credit: Dances.creditOf(readme), warnings: d.warnings,
  };
}

// Another music or cover file for the draft (picked in its own dialog). → { ok, path, label, coverData? } or an error
function addExtra(token, kind, p) {
  const s = sessions.get(token);
  if (!s) return Dances.importError('expired');
  const st = stat(p);
  if (!st || !st.isFile()) return Dances.importError('no-files');
  if (kind === 'audio') {
    if (/\.ncm$/i.test(p)) return Dances.importError('encrypted-audio');
    if (!Dances.AUDIO_EXT.test(p)) return Dances.importError('bad-audio');
    if (st.size > LIMITS.audio) return Dances.importError('too-big');
  } else if (kind === 'cover') {
    if (!Dances.COVER_EXT.test(p)) return Dances.importError('bad-cover');
    if (st.size > LIMITS.cover) return Dances.importError('too-big');
  } else return Dances.importError('no-files');
  s.files.set(p, st.size);
  return { ok: true, path: p, label: label(p), ...(kind === 'cover' ? { coverData: coverData(p) } : {}) };
}

// The bake, in a worker thread (the window stays responsive on a 25 MB VMD); in-process when no worker can start.
function runBake(job, onWorker) {
  return new Promise((resolve) => {
    let Worker;
    try { ({ Worker } = require('node:worker_threads')); } catch { Worker = null; }
    let w = null;
    if (Worker) { try { w = new Worker(path.join(__dirname, 'dance-bake-worker.js'), { workerData: job }); } catch { w = null; } }
    if (!w) {
      try { resolve(require('./dance-bake').bake(job)); } catch (e) { resolve({ ok: false, message: String((e && e.message) || e) }); }
      return;
    }
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    onWorker(() => { finish({ ok: false, canceled: true }); w.terminate(); });
    w.once('message', (m) => { finish(m); w.terminate(); });
    w.once('error', (e) => finish({ ok: false, message: String((e && e.message) || e) }));
    w.once('exit', (code) => finish({ ok: false, message: `worker exited (${code})` }));
  });
}

function readRawIndex(dir) {
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
    if (lib && typeof lib === 'object' && lib.dances && typeof lib.dances === 'object' && !Array.isArray(lib.dances)) return lib;
  } catch { /* none yet, or unreadable: a new library (the old file is kept as library.json.bad) */ }
  return { schema: 1, dances: {} };
}
function writeIndex(dir, lib) {
  const f = path.join(dir, 'library.json');
  if (fs.existsSync(f)) { try { JSON.parse(fs.readFileSync(f, 'utf8')); } catch { fs.copyFileSync(f, `${f}.bad`); } }
  lib.schema = 1;
  fs.writeFileSync(`${f}.tmp`, `${JSON.stringify(lib, null, 2)}\n`);
  fs.renameSync(`${f}.tmp`, f); // never a half-written index
}

async function commit({ token, name, motion, audio = null, cover = null } = {}, dir) {
  if (!dir || insideRepo(dir)) return Dances.importError('no-library');
  const s = sessions.get(token);
  if (!s) return Dances.importError('expired');
  if (baking) return Dances.importError('busy');
  if (!motion || !s.motions.has(motion)) return Dances.importError('no-motion');
  if (audio && (!s.files.has(audio) || !Dances.AUDIO_EXT.test(audio))) return Dances.importError('bad-audio');
  if (cover && (!s.files.has(cover) || !Dances.COVER_EXT.test(cover))) return Dances.importError('bad-cover');
  const title = String(name || '').trim().slice(0, 60) || path.basename(motion).replace(/\.[^.]+$/, '');
  const existing = readRawIndex(dir);
  let id = Dances.danceId(title);
  while (existing.dances[id] || id === Dances.DEMO_ID) id = Dances.danceId(title);
  const t0 = Date.now();
  baking = { token };
  let r;
  try {
    r = await runBake({ vmd: motion, id }, (cancel) => { if (baking) baking.cancel = cancel; });
  } finally { baking = null; }
  if (r && r.canceled) return Dances.importError('canceled');
  if (!r || !r.ok) return Dances.importError('bake-failed', { detail: r && r.message ? String(r.message).slice(0, 200) : undefined });
  const tmp = path.join(dir, `.${id}.tmp`);
  try {
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dance.vrma'), Buffer.from(r.vrma));
    fs.copyFileSync(motion, path.join(tmp, 'src', path.basename(motion)));
    let audioFile = null;
    if (audio) { audioFile = `audio.${Dances.fileExt(audio)}`; fs.copyFileSync(audio, path.join(tmp, audioFile)); }
    let coverFile = null;
    if (cover) { coverFile = `cover.${Dances.fileExt(cover).replace('jpeg', 'jpg')}`; fs.copyFileSync(cover, path.join(tmp, coverFile)); }
    const readme = s.readme ? readmeText(s.readme) : '';
    if (readme) fs.writeFileSync(path.join(tmp, 'readme.txt'), readme);
    const credit = Dances.creditOf(readme);
    const rep = r.report;
    const entry = {
      name: title, file: `${id}/dance.vrma`, ...(audioFile ? { audio: `${id}/${audioFile}` } : {}), ...(coverFile ? { cover: `${id}/${coverFile}` } : {}),
      duration: rep.duration, offset: 0, loop: !audioFile && rep.duration <= Dances.SHORT_LOOP, ...(credit ? { credit } : {}), ...(readme ? { readme: `${id}/readme.txt` } : {}),
      face: !!rep.face, ik: rep.ik, ...(rep.stage ? { stage: rep.stage } : {}), extent: rep.extent, ground: rep.ground,
      source: s.source || 'vmd', src: { motion: path.basename(motion), ...(audio ? { audio: path.basename(audio) } : {}) },
      bakedWith: require('../core/vmd-retarget').BAKED_WITH, importedAt: new Date().toISOString(),
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(tmp, path.join(dir, id));
    const lib = readRawIndex(dir);
    lib.dances[id] = entry;
    writeIndex(dir, lib);
    sessions.delete(token);
    const clean = Dances.cleanDanceIndex(lib).dances[id];
    return { ok: true, id, name: title, ms: Date.now() - t0, dance: Dances.publicEntry(clean) };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    return Dances.importError('write-failed', { detail: String(e.message).slice(0, 200) });
  }
}

function cancel() {
  if (baking && baking.cancel) { baking.cancel(); return { ok: true }; }
  return { ok: false, reason: 'not-importing' };
}

function remove(dir, id) {
  if (!dir || insideRepo(dir)) return Dances.importError('no-library');
  if (typeof id !== 'string' || !Dances.ID_RE.test(id)) return { ok: false, reason: 'not-found', message: '找不到这支舞蹈（可能已经删掉了）。' };
  if (id === Dances.DEMO_ID) return { ok: false, reason: 'builtin', message: '内置示例舞不能删除。' };
  const lib = readRawIndex(dir);
  const folder = path.resolve(dir, id);
  if (!folder.startsWith(path.resolve(dir) + path.sep)) return { ok: false, reason: 'not-found', message: '找不到这支舞蹈（可能已经删掉了）。' };
  const had = !!lib.dances[id] || !!stat(folder);
  if (!had) return { ok: false, reason: 'not-found', message: '找不到这支舞蹈（可能已经删掉了）。' };
  const name = lib.dances[id] && lib.dances[id].name;
  try {
    delete lib.dances[id];
    writeIndex(dir, lib);
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (e) {
    return Dances.importError('write-failed', { detail: String(e.message).slice(0, 200) });
  }
  return { ok: true, id, name: name || id };
}

// 商店 → 舞蹈 (core/catalog.js loadDanceIndex): a downloaded archive (dance.json, dance.vrma, audio.*, cover.*,
// readme.txt; checked against the index's sha256 already) into the library as `<entry.id>/`, under the id the
// store knows it by, so 商店 shows it as 已下载 and 删除舞蹈 frees it for another download.
async function installStore(dir, entry, zipFile, unzipFn = require('../core/vrm-import').unzip) {
  if (!dir || insideRepo(dir)) return { ok: false, reason: 'invalid', errors: ['no dance library'] };
  if (!entry || !Dances.ID_RE.test(entry.id)) return { ok: false, reason: 'invalid', errors: ['bad id'] };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, `.${entry.id}-`));
  try {
    await unzipFn(zipFile, tmp);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(tmp, 'dance.json'), 'utf8')); } catch { meta = null; }
    if (!meta || !stat(path.join(tmp, 'dance.vrma'))) return { ok: false, reason: 'invalid', errors: ['the archive has no dance.json / dance.vrma'] };
    const own = (f, re) => (typeof f === 'string' && re.test(f) && path.basename(f) === f && stat(path.join(tmp, f)) ? f : null);
    const audio = own(meta.audio, Dances.AUDIO_EXT);
    const cover = own(meta.cover, Dances.COVER_EXT);
    const readme = own(meta.readme, /\.txt$/i);
    const id = entry.id;
    const lib = { ...meta, name: entry.name || meta.name, file: `${id}/dance.vrma`, source: 'store', catalog: { sha256: entry.sha256 }, importedAt: new Date().toISOString() };
    delete lib.audio; delete lib.cover; delete lib.readme;
    if (audio) lib.audio = `${id}/${audio}`;
    if (cover) lib.cover = `${id}/${cover}`;
    if (readme) lib.readme = `${id}/${readme}`;
    const clean = Dances.cleanDanceIndex({ dances: { [id]: lib } }).dances[id];
    if (!clean) return { ok: false, reason: 'invalid', errors: ['dance.json is not a dance'] };
    const dest = path.join(dir, id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    const index = readRawIndex(dir);
    index.dances[id] = lib;
    writeIndex(dir, index);
    return { ok: true, id };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// the store dances in the library now (商店 → 舞蹈 已下载)
function installedIds(dir) {
  if (!dir) return new Set();
  return new Set(Object.keys(readRawIndex(dir).dances).filter((id) => stat(path.join(dir, id))));
}

const importing = () => !!baking;

module.exports = { inspect, addExtra, commit, cancel, remove, importing, installStore, installedIds, LIMITS, _sessions: sessions };
