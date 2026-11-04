'use strict';

// The dance library on disk (docs/vrm-dance.md §5): <dances dir>/<id>/{dance.vrma, audio.<ext>, cover.<ext>}
// and <dances dir>/library.json (core/vrm-dances.js cleanDanceIndex), served over vrmlib://dance/… by the
// vrmlib:// handler of src/main/vrm-library.js; the built-in demo (core/dance-demo.js) is served from memory
// as vrmlib://dance/demo/{dance.vrma, audio.wav}. Nothing of it is in the repository or the app package.
//
// Where (the same order as the motion library): $PIXELPET_VRM_DANCES_DIR (refused inside the repository),
// else <userData>/vrm-dances once it has a library.json, else — a development run (not packaged, not a test) —
// ~/vrm-assets/baked-dances, the default output of `node scripts/vrm-bake.js --dance …`; else <userData>/vrm-dances.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Dances = require('../core/vrm-dances');

const REPO = path.resolve(__dirname, '..', '..');
const insideRepo = (p) => { const r = path.relative(REPO, path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };
const hasIndex = (d) => { try { return fs.statSync(path.join(d, 'library.json')).isFile(); } catch { return false; } };

// { dir, source: 'env' | 'userData' | 'dev' | 'none', refused? }
function danceDir({ env = process.env, userData, packaged = false, home = os.homedir() } = {}) {
  if (env.PIXELPET_VRM_DANCES_DIR) {
    const d = path.resolve(env.PIXELPET_VRM_DANCES_DIR.replace(/^~(?=$|\/)/, home));
    if (insideRepo(d)) return { dir: null, source: 'none', refused: d };
    return { dir: d, source: 'env' };
  }
  const user = userData ? path.join(userData, 'vrm-dances') : null;
  if (user && hasIndex(user)) return { dir: user, source: 'userData' };
  const dev = path.join(home, 'vrm-assets', 'baked-dances');
  if (!packaged && env.PIXELPET_TEST !== '1' && hasIndex(dev) && !insideRepo(dev)) return { dir: dev, source: 'dev' };
  return { dir: user, source: user ? 'userData' : 'none' };
}

// What a vrmlib://dance/… URL names: { index } (library.json), { demo: 'vrma' | 'wav' }, { file } inside
// `dir`, or null (anything not on the whitelist, or outside the folder after resolving).
function resolveDanceUrl(dir, url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'vrmlib:' || u.hostname !== 'dance') return null;
  let rel;
  try { rel = decodeURIComponent(u.pathname).replace(/^\/+/, ''); } catch { return null; }
  if (rel === 'library.json') return { index: dir ? path.join(dir, 'library.json') : null };
  const m = /^([a-z0-9-]{1,48})\/([^/\\]+)$/.exec(rel);
  if (!m || !Dances.FILE_RE.test(m[2])) return null;
  if (m[1] === Dances.DEMO_ID) return m[2] === 'dance.vrma' ? { demo: 'vrma' } : m[2] === 'audio.wav' ? { demo: 'wav' } : null;
  if (!dir) return null;
  const file = path.resolve(dir, m[1], m[2]);
  if (!file.startsWith(path.resolve(dir) + path.sep)) return null;
  return { file };
}

// The index on disk, cleaned: { index, error } (a missing file is an empty library, not an error).
function readDanceIndex(dir) {
  const f = dir ? path.join(dir, 'library.json') : null;
  if (!f || !fs.existsSync(f)) return { index: Dances.cleanDanceIndex(null), error: null };
  try { return { index: Dances.cleanDanceIndex(JSON.parse(fs.readFileSync(f, 'utf8'))), error: null }; } catch (e) { return { index: Dances.cleanDanceIndex(null), error: e.message }; }
}

// Every dance (the library's and the demo), with the folder they come from (dances:list, the API).
function listDances(where) {
  const { index, error } = readDanceIndex(where && where.dir);
  return { dir: where ? where.dir : null, source: where ? where.source : 'none', ...(where && where.refused ? { refused: where.refused } : {}), ...(error ? { error } : {}), dances: Dances.listDances(index) };
}

const MIME = { vrma: 'model/gltf-binary', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const CORS = { 'access-control-allow-origin': '*' };

// Bytes as a Response, answering a Range request (the <audio> element asks for one) with 206.
function bytesResponse(buf, type, range) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range || ''));
  if (m && (m[1] || m[2])) {
    const size = buf.length;
    let a = m[1] ? Number(m[1]) : size - Number(m[2]);
    let b = m[1] && m[2] ? Number(m[2]) : size - 1;
    a = Math.max(0, a);
    b = Math.min(size - 1, b);
    if (a > b) return new Response('', { status: 416, headers: { ...CORS, 'content-range': `bytes */${size}` } });
    return new Response(buf.subarray(a, b + 1), { status: 206, headers: { ...CORS, 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${a}-${b}/${size}`, 'content-length': String(b - a + 1) } });
  }
  return new Response(buf, { status: 200, headers: { ...CORS, 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(buf.length) } });
}

// The vrmlib://dance/… part of the vrmlib:// handler. → a Response, or null when the URL is not a dance one.
function danceResponse(where, req) {
  let u;
  try { u = new URL(req.url); } catch { return null; }
  if (u.hostname !== 'dance') return null;
  const r = resolveDanceUrl(where && where.dir, req.url);
  if (!r) return new Response('not found', { status: 404 });
  const range = req.headers && typeof req.headers.get === 'function' ? req.headers.get('range') : null;
  if (r.index !== undefined) {
    const { index } = readDanceIndex(where && where.dir);
    return new Response(JSON.stringify(index), { status: 200, headers: { ...CORS, 'content-type': 'application/json' } });
  }
  if (r.demo) {
    const a = require('../core/dance-demo').demoAssets();
    return bytesResponse(r.demo === 'vrma' ? a.vrma : a.wav, r.demo === 'vrma' ? MIME.vrma : MIME.wav, range);
  }
  let buf;
  try { buf = fs.readFileSync(r.file); } catch { return new Response('not found', { status: 404 }); }
  return bytesResponse(buf, MIME[path.extname(r.file).slice(1).toLowerCase()] || 'application/octet-stream', range);
}

module.exports = { danceDir, resolveDanceUrl, readDanceIndex, listDances, danceResponse, bytesResponse, insideRepo };
