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
  ['GET', '/dances', '列出舞蹈（内置示例 + 舞蹈库）：[{ id, name, duration, music, loop… }]；vrm 表示她现在能不能跳'],
  ['POST', '/dance', '让她跳舞（只有 VRM 外观能跳）：{ "id"?: "…", "name"?: "…", "loop"?: true|false }；都不给就随机一支'],
  ['POST', '/dance/stop', '让她停下不跳'],
  ['GET', '/motions', '列出 VRM 角色现在能播的动作片段（动作库，按她的风格回退后）：{ library, motions: [{ id, slot, kind, category, group, label, duration }], manual }'],
  ['POST', '/motion', '让 VRM 角色播一个动作片段：{ "id"?: "idle.v03@female", "slot"?: "react.nod-01", "group"?: "nod|bow|stretch|sit|…", "loop"?: true|false }；姿势/待机片段替换底层，反应片段分层叠加，结束后交叉淡回待机'],
  ['POST', '/motion/stop', '停下手动播放的动作，平滑回到待机'],
  ['POST', '/reset-pose', '重置姿势：不管她在跳舞、吃饭、玩耍、睡觉还是动作卡住，都停下并平滑回到待机（睡着会叫醒，不扣好感）'],
  ['POST', '/observe', '插个嘴：告诉她主人正在做/写的事（不是对她说的），由她判断要不要插一句：{ "text": "…" }（需开启插个嘴和“外部程序”来源）'],
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

// One request → { status, json }. `ctx`: { token, state(), say(text), anim(state, facing), throw(v), chat(text), observe(text),
// dances(), dance({ id, name, loop }), danceStop(), resetPose() }.
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
  // dancing (docs/vrm-dance.md §6.2): 409 not-vrm with the reason for anything but a VRM look, 404 no-dance
  if (route === '/dances') {
    if (!ctx.dances) return fail(404, 'not-found');
    return { status: 200, json: { ok: true, ...(await ctx.dances()) } };
  }
  if (route === '/dance') {
    if (!ctx.dance) return fail(404, 'not-found');
    if (body.id !== undefined && (typeof body.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(body.id))) return fail(400, 'bad-id');
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return fail(400, 'bad-name');
    if (body.loop !== undefined && typeof body.loop !== 'boolean') return fail(400, 'bad-loop');
    const r = await ctx.dance({ id: body.id, name: body.name ? body.name.trim().slice(0, 60) : undefined, loop: body.loop });
    if (r && r.ok) return { status: 200, json: { ok: true, id: r.id, name: r.name, loop: r.loop, duration: r.duration, music: r.music } };
    const reason = (r && r.reason) || 'no-pet';
    const extra = { ...(r && r.message ? { message: r.message } : {}), ...(r && r.kind !== undefined ? { kind: r.kind } : {}), ...(r && r.dances ? { dances: r.dances } : {}) };
    return fail(reason === 'no-dance' ? 404 : reason === 'load-failed' ? 502 : 409, reason, extra);
  }
  if (route === '/dance/stop') {
    if (!ctx.danceStop) return fail(404, 'not-found');
    const r = await ctx.danceStop();
    return r && r.ok ? { status: 200, json: { ok: true, id: r.id } } : r && r.reason === 'not-dancing' ? { status: 200, json: { ok: true, id: null, dancing: false } } : fail(409, (r && r.reason) || 'no-pet');
  }
  // the motion library's clips by hand (T-5084): 409 not-vrm / not-ready, 404 no-clip
  if (route === '/motions') {
    if (!ctx.motions) return fail(404, 'not-found');
    const r = await ctx.motions();
    return r && r.ok ? { status: 200, json: { ok: true, library: r.library || null, motions: r.motions || [], manual: r.manual || null } } : fail(409, (r && r.reason) || 'no-pet');
  }
  if (route === '/motion') {
    if (!ctx.motion) return fail(404, 'not-found');
    const okStr = (v, re) => v === undefined || (typeof v === 'string' && re.test(v));
    if (!okStr(body.id, /^[a-z]+(\.[a-z0-9-]+)+(@(female|male|neutral))?$/)) return fail(400, 'bad-id');
    if (!okStr(body.slot, /^[a-z]+(\.[a-z0-9-]+)+$/)) return fail(400, 'bad-slot');
    if (!okStr(body.group, /^[a-z-]{1,20}$/)) return fail(400, 'bad-group');
    if (body.loop !== undefined && typeof body.loop !== 'boolean') return fail(400, 'bad-loop');
    if (body.hold !== undefined && !(typeof body.hold === 'number' && body.hold > 0 && body.hold <= 600)) return fail(400, 'bad-hold');
    if (!body.id && !body.slot && !body.group) return fail(400, 'no-motion');
    const r = await ctx.motion({ id: body.id, slot: body.slot, group: body.group, loop: body.loop, hold: body.hold });
    if (r && r.ok) return { status: 200, json: { ok: true, id: r.id, slot: r.slot, kind: r.kind, layer: r.layer, label: r.label, duration: r.duration, loop: !!r.loop } };
    const reason = (r && r.reason) || 'no-pet';
    return fail(reason === 'no-clip' ? 404 : 409, reason);
  }
  if (route === '/motion/stop') {
    if (!ctx.motionStop) return fail(404, 'not-found');
    const r = await ctx.motionStop();
    return r && r.ok ? { status: 200, json: { ok: true, stopped: !!r.stopped, id: r.id || null } } : fail(409, (r && r.reason) || 'no-pet');
  }
  if (route === '/reset-pose') {
    if (!ctx.resetPose) return fail(404, 'not-found');
    const r = await ctx.resetPose();
    return r && r.ok ? { status: 200, json: { ok: true, before: r.before || [], cleared: r.cleared || [], woke: !!r.woke } } : fail(409, (r && r.reason) || 'no-pet');
  }
  if (route === '/observe') {
    const text = String(body.text || '').trim().slice(0, 2000);
    if (!text) return fail(400, 'empty');
    if (!ctx.observe) return fail(404, 'not-found');
    const r = ctx.observe(text);
    return r && r.accepted ? { status: 202, json: { ok: true, accepted: true } } : { status: 200, json: { ok: true, accepted: false, reason: (r && r.reason) || 'off' } };
  }
  return fail(404, 'not-found');
}

module.exports = { PREFIX, MAX_BODY, ROUTES, ANIMS, handle, sameToken, throwVelocity };
