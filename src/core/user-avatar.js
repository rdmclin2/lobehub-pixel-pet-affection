'use strict';

// The owner's face in the settings window's chat (T-2839): the avatar of the LobeHub account `lh` is logged in
// with. `lh whoami` gives it as a path on the server (/webapi/user/avatar/<user>/<file>.webp) or a full URL; it is
// fetched here, in main, and handed to the console as a data: URL, so the console's CSP keeps allowing no remote
// images. The last one fetched is kept in <userData>/user-avatar.json with the URL it came from: it is not fetched
// again while the account's avatar URL stays the same, and only that same URL may fall back to it when the server
// cannot be reached (another account's face is never shown). Logged out, lh not runnable, an account without an
// avatar, or one that cannot be fetched and was never cached → null: the console draws the generic person icon.

const fs = require('node:fs');

const MAX_BYTES = 2 * 1024 * 1024;
const TYPE_RE = /^image\/(png|jpe?g|webp|gif|avif)$/;
const DATA_RE = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/;
const TIMEOUT_MS = 10000;

// The absolute URL of `avatar` as `lh whoami` gives it, or null when it is not one we fetch.
function avatarUrl(avatar, server) {
  if (typeof avatar !== 'string' || !avatar.trim()) return null;
  const a = avatar.trim();
  if (/^data:image\//i.test(a)) return a;
  try {
    const u = new URL(a, `${String(server || '').replace(/\/$/, '')}/`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function readCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c && typeof c.src === 'string' && typeof c.dataUrl === 'string' && /^data:image\//.test(c.dataUrl) ? c : null;
  } catch {
    return null;
  }
}

function writeCache(file, c) {
  try {
    fs.writeFileSync(file, JSON.stringify(c));
  } catch { /* a cache only */ }
}

async function download(url, fetchImpl) {
  if (url.startsWith('data:')) {
    const m = DATA_RE.exec(url);
    if (!m || !TYPE_RE.test(m[1].toLowerCase())) return null;
    const bytes = Buffer.from(m[2], 'base64').length;
    return bytes && bytes <= MAX_BYTES ? url : null;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!TYPE_RE.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// { name, avatar } for the console: `avatar` a data: URL or null. `whoami()` is LhClient#whoami (null when logged
// out; throws when lh cannot run); `cacheFile` where the last fetched one is kept.
async function userAvatar({ whoami, server, cacheFile, fetchImpl = globalThis.fetch }) {
  const cached = cacheFile ? readCache(cacheFile) : null;
  let user;
  try {
    user = await whoami();
  } catch {
    return { name: '', avatar: null }; // lh cannot run (not installed …): whose face it would be is unknown
  }
  if (!user) return { name: '', avatar: null }; // logged out (or whoami failed): nobody's face
  const name = user.name || '';
  const url = avatarUrl(user.avatar, server);
  if (!url) return { name, avatar: null }; // no avatar on the account (any more)
  if (cached && cached.src === url) return { name, avatar: cached.dataUrl }; // a new picture gets a new file name
  const dataUrl = await download(url, fetchImpl);
  if (!dataUrl) return { name, avatar: null }; // not reachable, and this picture was never cached
  if (cacheFile) writeCache(cacheFile, { src: url, dataUrl, at: Date.now() });
  return { name, avatar: dataUrl };
}

module.exports = { userAvatar, avatarUrl };
