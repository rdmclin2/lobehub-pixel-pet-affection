'use strict';

// The local HTTP API (对外接口, after dsh-pet's /dsh-pet-7340 routes): lets another program or script on
// this computer make the pet say something, play an animation, get thrown, chat with its agent, or read
// what it is doing. Off by default. It only listens on 127.0.0.1, and every call needs the token shown in
// 高级设置 (`Authorization: Bearer <token>`), so a web page cannot drive the pet. Pure routing here; the
// HTTP server is src/main/api-server.js.

const crypto = require('node:crypto');
const { STATES } = require('./fx');

const PREFIX = '/pixel-pet';
const MAX_BODY = 16 * 1024;
const LOCAL_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
// what /anim may play: every shared state plus `turn` (mirror)
const ANIMS = [...STATES.filter((s) => s !== 'lifted'), 'turn'];

const ROUTES = [
  ['GET', '/state', '读状态：角色、名字、当前动作、朝向、是否在飞、好感/饥饿/心情/体力、气泡'],
  ['POST', '/say', '让她说一句话（不调用模型）：{ "text": "…" }'],
  ['POST', '/anim', `播一个动作：{ "state": "${ANIMS.join('|')}", "facing"?: "left|right" }`],
  ['POST', '/throw', '把她抛出去：{ "angle": 度（0=向右，90=向上）, "power": 0.2–3 }'],
  ['POST', '/chat', '和她的 agent 聊一句并等回复：{ "text": "…" }（会调用模型）'],
];

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const fail = (status, error, extra = {}) => ({ status, json: { ok: false, error, ...extra } });

// Velocity (px/s) for a throw at `angle` degrees (0 = right, 90 = up) with `power` (1 = 1200 px/s).
function throwVelocity(angle, power) {
  const a = Number(angle);
  const p = Number(power);
  if (!Number.isFinite(a) || !Number.isFinite(p) || p < 0.2 || p > 3) return null;
  const rad = (a * Math.PI) / 180;
  return { vx: Math.round(Math.cos(rad) * 1200 * p), vy: Math.round(-Math.sin(rad) * 1200 * p) };
}

// One request → { status, json }. `ctx`: { token, state(), say(text), anim(state, facing), throw(v), chat(text) }.
async function handle(req, ctx) {
  if (!LOCAL_HOSTS.test(String((req.headers && req.headers.host) || ''))) return fail(403, 'bad-host');
  const auth = String((req.headers && req.headers.authorization) || '');
  if (!sameToken(auth.replace(/^Bearer\s+/i, ''), ctx.token)) return fail(401, 'unauthorized');
  const url = String(req.path || '');
  if (!url.startsWith(`${PREFIX}/`)) return fail(404, 'not-found', { routes: ROUTES.map(([m, r]) => `${m} ${PREFIX}${r}`) });
  const route = url.slice(PREFIX.length).split('?')[0];
  const known = ROUTES.find(([, r]) => r === route);
  if (!known) return fail(404, 'not-found', { routes: ROUTES.map(([m, r]) => `${m} ${PREFIX}${r}`) });
  if (known[0] !== req.method) return fail(405, 'method-not-allowed');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (route === '/state') return { status: 200, json: { ok: true, ...(await ctx.state()) } };
  if (route === '/say') {
    const r = await ctx.say(String(body.text || ''));
    return r.ok ? { status: 200, json: { ok: true } } : fail(r.reason === 'no-pet' ? 409 : 400, r.reason);
  }
  if (route === '/anim') {
    if (!ANIMS.includes(body.state)) return fail(400, 'bad-state', { states: ANIMS });
    if (body.facing !== undefined && !['left', 'right'].includes(body.facing)) return fail(400, 'bad-facing');
    const r = await ctx.anim(body.state, body.facing);
    return r && r.ok ? { status: 200, json: { ok: true, state: body.state } } : fail(409, (r && r.reason) || 'no-pet');
  }
  if (route === '/throw') {
    const v = throwVelocity(body.angle, body.power);
    if (!v) return fail(400, 'bad-throw', { hint: 'angle: number, power: 0.2–3' });
    const r = await ctx.throw(v);
    return r && r.ok ? { status: 200, json: { ok: true, ...v, bounces: r.bounces } } : fail(409, (r && r.reason) || 'no-pet');
  }
  if (route === '/chat') {
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) return fail(400, 'empty');
    const r = await ctx.chat(text);
    return r.ok ? { status: 200, json: { ok: true, text: r.text } } : fail(r.reason === 'busy' ? 409 : 502, r.reason || 'error', r.message ? { message: String(r.message).slice(0, 200) } : {});
  }
  return fail(404, 'not-found');
}

module.exports = { PREFIX, MAX_BODY, ROUTES, ANIMS, handle, sameToken, throwVelocity };
