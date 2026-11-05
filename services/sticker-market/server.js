#!/usr/bin/env node
'use strict';

// 表情包商店 · 社区货架 HTTP service (T-10796; see README.md next to this file).
//
//   GET    /v1/sticker-catalog.json          the published community sets (core/sticker-catalog.js format)
//   GET    /v1/files/<name>                  a published zip or preview (content-addressed, immutable)
//   POST   /v1/sticker-sets[?id=<own id>]    body: a set zip; Oidc-Auth: <LobeHub token>; X-Rights-Confirmed: yes
//   GET    /v1/me/sticker-sets               what the signed-in user put up, with its review state
//   DELETE /v1/sticker-sets/<id>             the owner takes it off the shelf
//   GET    /v1/admin/pending                 Authorization: Bearer <STICKER_MARKET_ADMIN_TOKEN>
//   POST   /v1/admin/sticker-sets/<id>/review  { decision: approve | reject, reason }
//
// Who is calling is asked of LobeHub itself: the token the app's `lh login` holds is sent on to
// <LOBEHUB_SERVER>/trpc/lambda/user.getUserState; its userId owns the set and its name is the author. The service
// never stores the token (only a sha256 of it, for a five-minute cache).
//
// Env: PORT (8790), HOST (127.0.0.1), STICKER_MARKET_DIR (./data), STICKER_MARKET_REVIEW (manual | auto),
// STICKER_MARKET_ADMIN_TOKEN (review endpoints off without it), LOBEHUB_SERVER (https://app.lobehub.com).

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { StickerMarket } = require('./market');

const MAX_BODY = 64 * 1024 * 1024;
const AUTH_TTL_MS = 5 * 60 * 1000;

// LobeHub token -> { id, name } | null (the token is not valid there)
function lobehubVerifier({ server = 'https://app.lobehub.com', fetchFn = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async (token) => {
    if (!token || token.length > 8192) return null;
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const hit = cache.get(key);
    if (hit && now() - hit.at < AUTH_TTL_MS) return hit.user;
    const res = await fetchFn(`${server.replace(/\/$/, '')}/trpc/lambda/user.getUserState`, { headers: { 'Oidc-Auth': token } });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`LobeHub answered HTTP ${res.status}`);
    const d = (await res.json())?.result?.data?.json;
    if (!d || typeof d.userId !== 'string' || !d.userId) return null;
    const user = { id: d.userId, name: String(d.fullName || d.username || d.firstName || 'LobeHub 用户').slice(0, 60) };
    cache.set(key, { at: now(), user });
    return user;
  };
}

function createServer({ market, verify, adminToken = '' }) {
  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Content-Length': buf.length, ...headers });
    res.end(buf);
  };
  const reply = (res, r) => send(res, r.status || (r.ok ? 200 : 400), r);
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  const user = async (req) => {
    const h = req.headers['oidc-auth'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    return h ? verify(String(h)) : null;
  };
  const isAdmin = (req) => {
    if (!adminToken) return false;
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(adminToken);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  let queue = Promise.resolve(); // writes one at a time
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/v1/sticker-catalog.json') return send(res, 200, market.index(), { 'Cache-Control': 'no-store' });
      if (req.method === 'GET' && p.startsWith('/v1/files/')) {
        const file = market.filePath(decodeURIComponent(p.slice('/v1/files/'.length)));
        if (!file) return send(res, 404, { ok: false, reason: 'not-found' });
        return send(res, 200, fs.readFileSync(file), { 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': file.endsWith('.zip') ? 'application/zip' : `image/${path.extname(file).slice(1)}` });
      }
      if (req.method === 'GET' && p === '/v1/health') return send(res, 200, { ok: true, review: market.reviewMode });
      if (req.method === 'POST' && p === '/v1/sticker-sets') {
        const u = await user(req);
        if (!u) return send(res, 401, { ok: false, reason: 'auth', text: '请先登录 LobeHub' });
        const body = await readBody(req);
        return reply(res, await serial(() => market.publish(u, body, { id: url.searchParams.get('id') || null, rightsConfirmed: req.headers['x-rights-confirmed'] === 'yes' })));
      }
      if (req.method === 'GET' && p === '/v1/me/sticker-sets') {
        const u = await user(req);
        if (!u) return send(res, 401, { ok: false, reason: 'auth', text: '请先登录 LobeHub' });
        return reply(res, { ...market.mine(u), user: { name: u.name } });
      }
      const del = /^\/v1\/sticker-sets\/([a-z0-9-]{3,40})$/.exec(p);
      if (req.method === 'DELETE' && del) {
        const u = await user(req);
        if (!u) return send(res, 401, { ok: false, reason: 'auth', text: '请先登录 LobeHub' });
        return reply(res, await serial(() => market.unpublish(u, del[1])));
      }
      if (p.startsWith('/v1/admin/')) {
        if (!isAdmin(req)) return send(res, 403, { ok: false, reason: 'admin' });
        if (req.method === 'GET' && p === '/v1/admin/pending') return send(res, 200, { ok: true, sets: market.pending() });
        const rv = /^\/v1\/admin\/sticker-sets\/([a-z0-9-]{3,40})\/review$/.exec(p);
        if (req.method === 'POST' && rv) {
          let b = {};
          try { b = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { /* empty */ }
          return reply(res, await serial(() => market.review(rv[1], b.decision, b.reason)));
        }
      }
      return send(res, 404, { ok: false, reason: 'not-found' });
    } catch (e) {
      return send(res, e.status || 502, { ok: false, reason: e.status === 413 ? 'too-large' : 'error', text: String((e && e.message) || e).slice(0, 200) });
    }
  });
}

if (require.main === module) {
  const dir = path.resolve(process.env.STICKER_MARKET_DIR || path.join(__dirname, 'data'));
  const market = new StickerMarket({ dir, review: process.env.STICKER_MARKET_REVIEW || 'manual' });
  const server = createServer({ market, verify: lobehubVerifier({ server: process.env.LOBEHUB_SERVER || 'https://app.lobehub.com' }), adminToken: process.env.STICKER_MARKET_ADMIN_TOKEN || '' });
  const port = Number(process.env.PORT || 8790);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`sticker market on http://${host}:${port} (data ${dir}, review ${market.reviewMode})`));
}

module.exports = { createServer, lobehubVerifier };
