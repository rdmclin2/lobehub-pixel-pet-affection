'use strict';

// The VRM motion library on disk (docs/vrm-motion-system.md §6): the baked .vrma clips and their
// library.json (scripts/vrm-bake.js), served to the renderer over vrmlib://<style>/<file>.vrma and
// vrmlib://index/library.json. Nothing of it is in the repository or the app package (the motions are for
// personal use only).
//
// Where: $PIXELPET_VRM_MOTIONS_DIR, else <userData>/vrm-motions; on a development run (not packaged, not a
// test) with neither present, ~/vrm-assets/baked — the bake's default output. A folder inside the
// repository is refused, so baked motions are never committed by accident. The scheme itself is registered
// with pack:// (src/main/packs.js registerPackScheme).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..', '..');
const insideRepo = (p) => { const r = path.relative(REPO, path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };
const hasIndex = (d) => { try { return fs.statSync(path.join(d, 'library.json')).isFile(); } catch { return false; } };

// The folder to serve, with where it came from: { dir, source: 'env' | 'userData' | 'dev' | 'none', refused? }
// (the index is answered even when the folder or its library.json does not exist: an empty one)
function libraryDir({ env = process.env, userData, packaged = false, home = os.homedir() } = {}) {
  if (env.PIXELPET_VRM_MOTIONS_DIR) {
    const d = path.resolve(env.PIXELPET_VRM_MOTIONS_DIR.replace(/^~(?=$|\/)/, home));
    if (insideRepo(d)) return { dir: null, source: 'none', refused: d };
    return { dir: d, source: 'env' };
  }
  const user = userData ? path.join(userData, 'vrm-motions') : null;
  if (user && hasIndex(user)) return { dir: user, source: 'userData' };
  const dev = path.join(home, 'vrm-assets', 'baked');
  if (!packaged && env.PIXELPET_TEST !== '1' && hasIndex(dev) && !insideRepo(dev)) return { dir: dev, source: 'dev' };
  return { dir: user, source: user ? 'userData' : 'none' };
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

function serveVrmLibrary({ protocol, net, app }) {
  const where = libraryDir({ userData: app.getPath('userData'), packaged: app.isPackaged });
  if (where.refused) console.warn(`[vrm] PIXELPET_VRM_MOTIONS_DIR is inside the repository, not used: ${where.refused}`);
  protocol.handle('vrmlib', (req) => {
    const file = resolveUrl(where.dir, req.url);
    // no library baked yet (the usual case on a user's machine): an empty index, not an error in the console
    if (file && path.basename(file) === 'library.json' && !fs.existsSync(file)) return new Response(JSON.stringify({ schema: 1, clips: {} }), { status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    if (!file || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      const headers = new Headers(res.headers);
      headers.set('access-control-allow-origin', '*');
      return new Response(res.body, { status: res.status, headers });
    });
  });
  return where;
}

module.exports = { libraryDir, resolveUrl, serveVrmLibrary, insideRepo };
