'use strict';

// The VRM motion library on disk (docs/vrm-motion-system.md §6): the baked .vrma clips and their
// library.json (scripts/vrm-bake.js), served to the renderer over vrmlib://<style>/<file>.vrma and
// vrmlib://index/library.json. The app ships the Mixamo part of it (resources/vrm-motions, the 'builtin' source:
// scripts/vrm-bundle-motions.js); a full bake (MMD motions too) stays outside the repository and the package.
//
// Where (T-5084: the first that has a library.json): $PIXELPET_VRM_MOTIONS_DIR; the folder the user chose in the
// console (设置 → 角色 → VRM 动作库 → 选择文件夹: a pointer in <userData>/vrm-library-link.json, nothing copied);
// <userData>/vrm-motions (`node scripts/vrm-bake.js --v2 --install`); on a development run (not packaged, not a
// test) ~/vrm-assets/baked-v2 (the v2 bake, T-5081), then ~/vrm-assets/baked; then the library that ships with the
// app (<resources>/vrm-motions packaged, resources/vrm-motions in the repository). Nothing found → source 'none' (before
// T-5084 it said 'userData' for a folder that did not exist, which hid that there was no library at all: every
// store VRM then fell back to the procedural idle, T-5079 R1); the pet window and the console say so. A folder
// inside the repository is refused, so baked motions are never committed by accident. The scheme itself is
// registered with pack:// (src/main/packs.js registerPackScheme). vrmlib://dance/… is the dance library
// (src/main/vrm-dances.js, docs/vrm-dance.md §5.2), with its own folder and the same guards.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const dances = require('./vrm-dances');

const REPO = path.resolve(__dirname, '..', '..');
const insideRepo = (p) => { const r = path.relative(REPO, path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };
const hasIndex = (d) => { try { return fs.statSync(path.join(d, 'library.json')).isFile(); } catch { return false; } };
const LINK_FILE = 'vrm-library-link.json';
// The library inside the app: extraResources puts resources/vrm-motions at <app>/resources/vrm-motions
const BUILTIN_DEV = path.join(REPO, 'resources', 'vrm-motions');
// ($PIXELPET_VRM_BUILTIN_DIR stands in for it; set empty, there is none — the e2e of a broken install)
function builtinDir(packaged = false, env = process.env) {
  if (env.PIXELPET_VRM_BUILTIN_DIR !== undefined) return env.PIXELPET_VRM_BUILTIN_DIR ? path.resolve(env.PIXELPET_VRM_BUILTIN_DIR) : null;
  return packaged && process.resourcesPath ? path.join(process.resourcesPath, 'vrm-motions') : BUILTIN_DEV;
}

// The folder the user linked (or null): <userData>/vrm-library-link.json { dir }
function readLink(userData) {
  if (!userData) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(userData, LINK_FILE), 'utf8'));
    return j && typeof j.dir === 'string' && path.isAbsolute(j.dir) ? j.dir : null;
  } catch { return null; }
}
// Link `dir` (null: forget the link). A folder must hold a library.json and be outside the repository; a folder
// holding the bake's output one level down (…/baked-v2) is taken too. → { ok, dir } | { ok: false, reason }
function writeLink(userData, dir) {
  const file = path.join(userData, LINK_FILE);
  if (!dir) { try { fs.rmSync(file, { force: true }); } catch {} return { ok: true, dir: null }; }
  let d = path.resolve(String(dir));
  if (!hasIndex(d) && hasIndex(path.join(d, 'baked-v2'))) d = path.join(d, 'baked-v2');
  if (insideRepo(d)) return { ok: false, reason: 'inside-repo' };
  if (!hasIndex(d)) return { ok: false, reason: 'no-index' };
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dir: d }));
  return { ok: true, dir: d };
}

// The folder to serve, with where it came from: { dir, source: 'env' | 'linked' | 'userData' | 'dev' | 'builtin' | 'none',
// refused?, looked: [folders tried] } (the index is answered even when the folder or its library.json does not
// exist: an empty one; `dir` is then <userData>/vrm-motions, where --install puts one)
function libraryDir({ env = process.env, userData, packaged = false, home = os.homedir(), link, builtin = builtinDir(packaged, env) } = {}) {
  if (env.PIXELPET_VRM_MOTIONS_DIR) {
    const d = path.resolve(env.PIXELPET_VRM_MOTIONS_DIR.replace(/^~(?=$|\/)/, home));
    if (insideRepo(d)) return { dir: null, source: 'none', refused: d };
    return { dir: d, source: 'env' };
  }
  const looked = [];
  const linked = link !== undefined ? link : readLink(userData);
  if (linked) { looked.push(linked); if (hasIndex(linked) && !insideRepo(linked)) return { dir: linked, source: 'linked' }; }
  const user = userData ? path.join(userData, 'vrm-motions') : null;
  if (user) { looked.push(user); if (hasIndex(user)) return { dir: user, source: 'userData' }; }
  if (!packaged && env.PIXELPET_TEST !== '1') {
    for (const dev of [path.join(home, 'vrm-assets', 'baked-v2'), path.join(home, 'vrm-assets', 'baked')]) {
      looked.push(dev);
      if (hasIndex(dev) && !insideRepo(dev)) return { dir: dev, source: 'dev' };
    }
  }
  // the bundled library: the only folder taken from inside the repository (it is the one meant to be there)
  if (builtin) { looked.push(builtin); if (hasIndex(builtin)) return { dir: builtin, source: 'builtin' }; }
  return { dir: user, source: 'none', looked };
}

// What is in the folder now: { clips, files, styles: { female: n, … }, bakedAt, generator, counts, error? }
function libraryStatus(where) {
  const out = { dir: where && where.dir, source: where ? where.source : 'none', clips: 0, files: 0, styles: {}, bakedAt: null, generator: null, counts: null };
  if (where && where.looked) out.looked = where.looked;
  if (where && where.refused) out.refused = where.refused;
  if (!where || !where.dir || !hasIndex(where.dir)) return out;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(where.dir, 'library.json'), 'utf8'));
    const clips = Object.entries((j && j.clips) || {});
    out.clips = clips.length;
    for (const [id, c] of clips) {
      if (!c || typeof c.file !== 'string') continue;
      out.files++;
      const st = id.split('@')[1] || '?';
      out.styles[st] = (out.styles[st] || 0) + 1;
    }
    out.bakedAt = typeof j.bakedAt === 'string' ? j.bakedAt : null;
    out.generator = typeof j.generator === 'string' ? j.generator : j.generator && typeof j.generator === 'object' ? JSON.stringify(j.generator).slice(0, 120) : null;
    out.counts = j.counts && typeof j.counts === 'object' ? j.counts : null;
  } catch (e) { out.error = `library.json: ${e.message}`; }
  return out;
}

// The file a vrmlib:// URL names inside `dir`, or null (not a .vrma / library.json, or outside the folder).
function resolveUrl(dir, url) {
  if (!dir) dir = path.join(os.tmpdir(), 'pixelpet-no-vrm-motions'); // nowhere: only the empty index answers
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'vrmlib:') return null;
  const host = u.hostname;
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const file = host === 'index' ? (rel === 'library.json' ? path.join(dir, 'library.json') : null) : /^(female|male|neutral)$/.test(host) && /\.vrma$/i.test(rel) ? path.resolve(dir, host, rel) : null;
  if (!file || !file.startsWith(path.resolve(dir) + path.sep)) return null;
  return file;
}

// One line in the log for where the motions come from (and, without any, where it looked): the first thing to
// check when a VRM only breathes (T-5079 R1).
function describe(st) {
  if (st.refused) return `[vrm] PIXELPET_VRM_MOTIONS_DIR is inside the repository, not used: ${st.refused}`;
  if (!st.files) return `[vrm] no motion library (looked in: ${(st.looked || [st.dir]).filter(Boolean).join(', ') || '-'}): VRM characters only breathe and look about. The bundled one (resources/vrm-motions) is missing: reinstall, run node scripts/vrm-bundle-motions.js in a checkout, bake one (node scripts/vrm-bake.js --v2 --install) or choose its folder in 设置 → 角色 → VRM 动作库.`;
  return `[vrm] motion library: ${st.source} ${st.dir} — ${st.files} clips (${Object.entries(st.styles).map(([k, v]) => `${k} ${v}`).join(', ')})${st.bakedAt ? `, baked ${st.bakedAt}` : ''}`;
}

function serveVrmLibrary({ protocol, net, app, log = console.log, warn = console.warn }) {
  const userData = app.getPath('userData');
  // `where` is replaced when the user links another folder (relink): the handler always reads the current one
  const where = { dances: null };
  function locate() {
    const link = readLink(userData);
    const w = libraryDir({ userData, packaged: app.isPackaged, link });
    for (const k of ['dir', 'source', 'refused', 'looked']) { if (w[k] === undefined) delete where[k]; else where[k] = w[k]; }
    const danceWhere = dances.danceDir({ userData, packaged: app.isPackaged, link });
    if (danceWhere.refused) warn(`[vrm] PIXELPET_VRM_DANCES_DIR is inside the repository, not used: ${danceWhere.refused}`);
    where.dances = danceWhere;
    const st = libraryStatus(where);
    (st.files ? log : warn)(describe(st));
    return st;
  }
  locate();
  where.status = () => libraryStatus(where);
  // 选择文件夹 / 取消关联 in the console: → { ok, status } | { ok: false, reason }
  where.relink = (dir) => {
    const r = writeLink(userData, dir);
    if (!r.ok) return r;
    return { ok: true, status: locate() };
  };
  protocol.handle('vrmlib', (req) => {
    const dance = dances.danceResponse(where.dances, req);
    if (dance) return dance;
    const file = resolveUrl(where.dir, req.url);
    // no library baked yet (the usual case on a user's machine): an empty index, not an error in the console
    if (file && path.basename(file) === 'library.json' && !fs.existsSync(file)) return new Response(JSON.stringify({ schema: 1, clips: {}, missing: true, source: where.source }), { status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      const headers = new Headers(res.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(res.body, { status: res.status, headers });
    });
  });
  return where;
}

module.exports = { builtinDir, libraryDir, libraryStatus, readLink, writeLink, describe, resolveUrl, serveVrmLibrary, insideRepo, LINK_FILE };
