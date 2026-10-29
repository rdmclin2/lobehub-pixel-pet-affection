'use strict';
// The dsh-pet effects added on top of E1–E14 (docs/dsh-pet-gap.md): roaming, the slingshot, scoring a
// caught pet, landing squash, touch long-press, pets knocking into each other, clip variants, memes,
// reading aloud, the visitor and behaviour settings, and the local HTTP API. Every character gets every
// one of them; only the character file (memes, voice, clips) differs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Fx = require('../src/core/fx');
const memes = require('../src/core/memes');
const Voice = require('../src/core/voice');
const api = require('../src/core/api');
const settingsLib = require('../src/core/settings');
const persona = require('../src/core/persona');
const { SPECIES, SPECIES_IDS, validateCharacter, missingFiles } = require('../src/core/species');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const { ApiServer } = require('../src/main/api-server');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const AREA = { x: 0, y: 0, width: 1280, height: 800 };

// ---- roaming ------------------------------------------------------------------------------------
test('a walk goes 60–240 px the way she faces, turns round at the screen edge, and stays on screen', () => {
  const w = 230;
  const right = Fx.planWalk({ x: 400, w, area: AREA, facing: 'right' }, () => 0);
  assert.deepEqual([right.fromX, right.toX, right.dir, right.facing], [400, 460, 1, 'right']);
  const left = Fx.planWalk({ x: 400, w, area: AREA, facing: 'left' }, () => 0.999);
  assert.equal(left.toX, 400 - 240);
  assert.equal(left.facing, 'left');
  // at the right edge she turns round instead of walking off
  const edge = Fx.planWalk({ x: AREA.width - w - 10, w, area: AREA, facing: 'right' }, () => 0.5);
  assert.equal(edge.facing, 'left');
  assert.ok(edge.toX < edge.fromX);
  // a bigger pet takes bigger steps
  assert.equal(Fx.planWalk({ x: 400, w, area: AREA, facing: 'right', scale: 2 }, () => 0).toX, 520);
  // no room either way: no walk
  assert.equal(Fx.planWalk({ x: 0, w: 1270, area: AREA, facing: 'right' }, () => 0.5), null);
  for (let i = 0; i < 200; i++) {
    const p = Fx.planWalk({ x: Math.random() * (AREA.width - w), w, area: AREA, facing: Math.random() < 0.5 ? 'left' : 'right' });
    if (!p) continue;
    assert.ok(p.toX >= AREA.x + Fx.WALK.margin && p.toX <= AREA.width - w - Fx.WALK.margin, `on screen: ${p.toX}`);
  }
});

test('a walk stands still at the start and the end and moves at a steady pace in between', () => {
  const p = Fx.planWalk({ x: 100, w: 230, area: AREA, facing: 'right' }, () => 0);
  assert.equal(Fx.walkX(p, 0), 100);
  assert.equal(Fx.walkX(p, Fx.WALK.leadMs), 100);
  assert.equal(Fx.walkX(p, p.ms - Fx.WALK.tailMs), 160);
  assert.equal(Fx.walkX(p, p.ms), 160);
  const mid = Fx.walkX(p, Fx.WALK.leadMs + (p.ms - Fx.WALK.leadMs - Fx.WALK.tailMs) / 2);
  assert.equal(mid, 130);
});

test('roaming is on by default and can be switched off; it is a saved preference', () => {
  const s = settingsLib.normalizeSettings(null);
  assert.deepEqual(s.prefs, { roam: true, clickSound: false, voice: false, memes: true, collide: true });
  assert.equal(settingsLib.normalizeSettings({ prefs: { roam: false, voice: 'yes' } }).prefs.roam, false);
  assert.equal(settingsLib.normalizeSettings({ prefs: { voice: 'yes' } }).prefs.voice, false, 'only booleans count');
});

// ---- slingshot, catching, squash, touch ------------------------------------------------------------
test('slingshot: a second press within 300 ms; it flies opposite to the pull, as fast as the pull is long', () => {
  assert.equal(Fx.isSlingshot(null, 1000), false);
  assert.equal(Fx.isSlingshot(800, 1000), true);
  assert.equal(Fx.isSlingshot(600, 1000), false);
  const v = Fx.slingshotVelocity(-90, 0, 150); // pulled 90 px left (60% of a 150 px pet) → anchor speed, to the right
  assert.equal(Math.round(v.vx), Fx.SLING.anchor);
  assert.ok(Math.abs(v.vy) < 1e-9);
  const up = Fx.slingshotVelocity(0, 45, 150); // pulled down → flies up
  assert.ok(up.vy < 0 && Math.abs(up.vx) < 1e-9);
  assert.deepEqual(Fx.slingshotVelocity(3, 4, 150), { vx: 0, vy: 0 }, 'a tiny pull does nothing');
  assert.ok(Math.hypot(...Object.values(Fx.slingshotVelocity(-2000, 0, 150))) <= Fx.PHYSICS.maxSpeed + 1e-6);
});

test('catching a flying pet scores by speed, more for a smaller one; a slow one is a plain click', () => {
  assert.equal(Fx.clickScore(399, 150), 0);
  assert.equal(Fx.clickScore(800, 150), 8);
  assert.equal(Fx.clickScore(800, 75), 16);
  assert.equal(Fx.clickScore(400, 3000), 1, 'at least one point');
});

test('a harder landing squashes flatter', () => {
  assert.equal(Fx.landingSquash(100), 0.8);
  assert.equal(Fx.landingSquash(2000), 0.55);
  assert.ok(Fx.landingSquash(900) < 0.8 && Fx.landingSquash(900) > 0.55);
  const r = Fx.stepThrow({ x: 0, y: 459, w: 230, h: 340, vx: 0, vy: 1200 }, 16, AREA);
  assert.equal(r.hit, 'floor');
  assert.ok(r.impact > 1200, 'the throw step reports how hard it hit the floor');
});

test('touch: a long press held still opens the menu; moving cancels it', () => {
  assert.equal(Fx.isLongPress(499, 0), false);
  assert.equal(Fx.isLongPress(500, 8), true);
  assert.equal(Fx.isLongPress(900, 9), false);
});

// ---- collisions --------------------------------------------------------------------------------
test('a flying pet knocks into another: momentum is kept, the one hit flies off, and an overlap does not bounce twice', () => {
  const fly = { x: 0, y: 0, w: 100, h: 120, vx: 900, vy: 0 };
  const hit = { x: 90, y: 0, w: 100, h: 120, vx: 0, vy: 0 };
  assert.ok(Fx.rectsOverlap(fly, hit));
  assert.equal(Fx.rectsOverlap(fly, { ...hit, x: 101 }), false);
  const c = Fx.collidePets(fly, hit);
  assert.ok(c.hit.vx > 880, `the one hit takes nearly all the speed (${c.hit.vx})`);
  assert.ok(Math.abs(c.fly.vx) < 10);
  const before = fly.w * fly.h * fly.vx;
  const after = fly.w * fly.h * c.fly.vx + hit.w * hit.h * c.hit.vx;
  assert.ok(Math.abs(before - after) < 1e-6, 'momentum is conserved');
  // already moving apart: no second bounce
  assert.equal(Fx.collidePets({ ...fly, vx: c.fly.vx }, { ...hit, vx: c.hit.vx }), null);
  // a heavier pet is pushed less
  const heavy = Fx.collidePets(fly, { ...hit, w: 200, h: 240 });
  assert.ok(heavy.hit.vx < c.hit.vx);
});

// ---- clip variants ---------------------------------------------------------------------------------
test('a state with several clips plays a different one each time', () => {
  const pat = SPECIES.dafeiyu.clips.pat;
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const f = Fx.pickVariant(pat, prev);
    assert.ok(pat.includes(f));
    assert.notEqual(f, prev);
    prev = f;
  }
  assert.equal(Fx.pickVariant('idle.webm', 'idle.webm'), 'idle.webm', 'a single clip is just played');
});

// ---- memes -------------------------------------------------------------------------------------------
test('every character has her own memes on disk; the files are checked when characters load', () => {
  for (const id of SPECIES_IDS) {
    assert.ok(SPECIES[id].memes.length >= 4, id);
    for (const m of SPECIES[id].memes) assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'renderer', memes.memeUrl(id, m.id))), `${id}/${m.id}`);
  }
  const c = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'characters', 'claude.json'), 'utf8'));
  assert.deepEqual(missingFiles(c), []);
  assert.deepEqual(missingFiles({ ...c, memes: [{ id: 'nope', label: 'x', desc: 'y' }] }), ['assets/memes/claude/nope.webp']);
  assert.match(validateCharacter({ ...c, memes: [{ id: 'Bad Id', label: 'x', desc: 'y' }] }).join(), /memes\[0\]/);
  assert.match(validateCharacter({ ...c, memes: [c.memes[0], c.memes[0]] }).join(), /duplicate/);
});

test('a meme tag is stripped from the reply; only a picture she has is shown', () => {
  const sp = SPECIES.grok;
  assert.deepEqual(memes.extractMeme('哈，这个有意思。\n[梗图:interesting]', sp), { text: '哈，这个有意思。', meme: 'interesting' });
  assert.deepEqual(memes.extractMeme('好的[梗图：THATSIT]', sp), { text: '好的', meme: 'thatsit' });
  assert.deepEqual(memes.extractMeme('嗯 [梗图:rice]', sp), { text: '嗯', meme: null }, 'another character’s meme is not hers');
  assert.equal(memes.randomMeme(sp, () => 0.9), null);
  assert.equal(memes.randomMeme(sp, () => 0.1), sp.memes[0].id);
  assert.equal(memes.memeHint({ memes: [] }), '');
  assert.match(memes.memeHint(sp), /\[梗图:编号\].*interesting（哈！有意思/);
});

test('with memes on, every message to the agent lists her memes; off, it does not', () => {
  const pet = { speciesId: 'gemini', affection: 10, hunger: 20, mood: 60, energy: 80, lastInteractionAt: 0, stageHistory: [] };
  const on = persona.buildStateBlock(pet, Date.now(), settingsLib.normalizeSettings(null));
  assert.match(on, /\[梗图\].*peek（让我看看！/);
  const off = persona.buildStateBlock(pet, Date.now(), settingsLib.normalizeSettings({ prefs: { memes: false } }));
  assert.doesNotMatch(off, /梗图/);
});

function service() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fx-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const svc = new PetService({ lh, store: new Store(path.join(dir, 'data')), rnd: () => 0.1 });
  svc.on('error', () => {});
  const said = [];
  svc.on('say', (m) => said.push(m));
  return { svc, said, dir };
}

for (const id of ['dafeiyu', 'claude', 'grok', 'gemini']) {
  test(`${id}: a reply tagged with one of her memes shows the picture, never the tag; offline murmurs get one too`, async () => {
    const { svc, said } = service();
    await svc.hatch({ speciesId: id, name: 'T' });
    const m = SPECIES[id].memes[1];
    const r = await svc.chat(`你好 [梗图:${m.id}]`);
    assert.equal(r.ok, true);
    const last = said[said.length - 1];
    assert.equal(last.text, 'echo: 你好');
    assert.deepEqual(last.meme, { id: m.id, label: m.label, url: `assets/memes/${id}/${m.id}.webp` });
    svc._say(svc._fallback(SPECIES[id], 'hungry'), 'fallback', 'hungry');
    assert.equal(said[said.length - 1].meme.id, SPECIES[id].memes[0].id, 'rnd 0.1: a random meme');
    svc._say('（成人向内容已开启。）', 'fallback', 'settings');
    assert.equal(said[said.length - 1].meme, null, 'app notes never get one');
    svc.setPrefs({ memes: false });
    await svc.chat(`再来 [梗图:${m.id}]`);
    assert.equal(said[said.length - 1].meme, null);
    assert.equal(said[said.length - 1].text, 'echo: 再来', 'the tag is stripped even with memes off');
  });
}

// ---- voice -----------------------------------------------------------------------------------------
test('every character sounds different, and only replies and API lines are read aloud', () => {
  const params = SPECIES_IDS.map((id) => Voice.voiceOf(SPECIES[id]));
  assert.equal(new Set(params.map((v) => `${v.pitch}/${v.rate}`)).size, SPECIES_IDS.length, 'pitch/rate differ per character');
  for (const v of params) assert.equal(v.lang, 'zh-CN');
  assert.equal(Voice.shouldSpeak({ source: 'llm', kind: 'chat' }), true);
  assert.equal(Voice.shouldSpeak({ source: 'llm', kind: 'topic:t1' }), true);
  assert.equal(Voice.shouldSpeak({ source: 'api', kind: 'api' }), true);
  assert.equal(Voice.shouldSpeak({ source: 'llm', kind: 'hungry' }), false, 'automatic murmurs are not read');
  assert.equal(Voice.shouldSpeak({ source: 'fallback', kind: 'chat' }), false);
  assert.equal(Voice.speakable('哈！😀（得意）[梗图:roast] 看 https://x.y 这个'), '哈！ 看 这个');
  assert.ok([...Voice.speakable('很长的一句话。'.repeat(40))].length <= Voice.MAX_CHARS);
  const voices = [{ name: 'Microsoft Huihui', lang: 'zh-CN' }, { name: 'Google 普通话', lang: 'zh-CN' }, { name: 'Samantha', lang: 'en-US' }, { name: 'Mei-Jia', lang: 'zh-TW' }];
  assert.equal(Voice.pickVoice(voices, Voice.voiceOf(SPECIES.claude)).name, 'Microsoft Huihui', 'preferred name');
  assert.equal(Voice.pickVoice(voices, Voice.voiceOf(SPECIES.grok)).name, 'Microsoft Huihui', 'same language');
  assert.equal(Voice.pickVoice([voices[3]], Voice.voiceOf(SPECIES.grok)).name, 'Mei-Jia', 'same base language');
  assert.equal(Voice.pickVoice([voices[2]], Voice.voiceOf(SPECIES.grok)), null, 'no Chinese voice: none');
});

// ---- visitors and settings -------------------------------------------------------------------------
test('visitors: other model-chan only, at most three, never the companion herself', async () => {
  const { svc } = service();
  await svc.hatch({ speciesId: 'claude', name: 'T' });
  assert.deepEqual(svc.setVisitors(['grok', 'claude', 'nobody', 'gemini']).settings.visitors, ['grok', 'gemini']);
  // switching to a visitor sends her home from the visitors
  svc.switchCharacter('grok');
  assert.deepEqual(svc.settings.visitors, ['gemini']);
  assert.deepEqual(settingsLib.normalizeSettings({ visitors: ['a1', 'b1', 'c1', 'd1'] }).visitors, ['a1', 'b1', 'c1']);
});

test('the API is off by default; switching it on makes a token, which can be replaced', () => {
  const { svc } = service();
  assert.deepEqual(svc.settings.api, { enabled: false, port: 7340, token: '' });
  const on = svc.setApi({ enabled: true }).settings.api;
  assert.equal(on.enabled, true);
  assert.match(on.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(svc.setApi({ port: 8123 }).settings.api.token, on.token, 'kept across changes');
  assert.notEqual(svc.setApi({ newToken: true }).settings.api.token, on.token);
  assert.equal(svc.setApi({ port: 80 }).settings.api.port, 7340, 'no privileged ports');
  assert.equal(settingsLib.normalizeSettings({ api: { enabled: true, token: '' } }).api.enabled, false, 'never on without a token');
});

// ---- the local HTTP API ---------------------------------------------------------------------------
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz012345';
function ctx(log) {
  return {
    token: TOKEN,
    state: async () => ({ pet: { name: 'T' }, fx: { state: 'idle' } }),
    say: async (text) => { log.push(['say', text]); return text ? { ok: true } : { ok: false, reason: 'empty' }; },
    anim: async (s, f) => { log.push(['anim', s, f]); return { ok: true }; },
    throw: async (v) => { log.push(['throw', v]); return { ok: true, bounces: 2 }; },
    chat: async (text) => { log.push(['chat', text]); return { ok: true, text: `echo: ${text}` }; },
  };
}
const req = (method, p, body, headers = {}) => ({ method, path: p, body, headers: { host: '127.0.0.1:7340', authorization: `Bearer ${TOKEN}`, ...headers } });

test('API: every call needs the token and a local Host; routes and methods are checked', async () => {
  const log = [];
  assert.equal((await api.handle(req('GET', '/pixel-pet/state', {}, { authorization: '' }), ctx(log))).status, 401);
  assert.equal((await api.handle(req('GET', '/pixel-pet/state', {}, { authorization: 'Bearer wrong' }), ctx(log))).status, 401);
  assert.equal((await api.handle(req('GET', '/pixel-pet/state', {}, { host: 'evil.example:7340' }), ctx(log))).status, 403, 'DNS rebinding');
  assert.equal((await api.handle(req('GET', '/pixel-pet/nope'), ctx(log))).status, 404);
  assert.equal((await api.handle(req('GET', '/pixel-pet/say'), ctx(log))).status, 405);
  const st = await api.handle(req('GET', '/pixel-pet/state'), ctx(log));
  assert.deepEqual(st, { status: 200, json: { ok: true, pet: { name: 'T' }, fx: { state: 'idle' } } });
  assert.deepEqual(log, [], 'nothing ran for a refused call');
});

test('API: say, anim, throw and chat reach the pet; bad input is refused', async () => {
  const log = [];
  assert.equal((await api.handle(req('POST', '/pixel-pet/say', { text: '你好' }), ctx(log))).status, 200);
  assert.equal((await api.handle(req('POST', '/pixel-pet/anim', { state: 'walk', facing: 'left' }), ctx(log))).status, 200);
  assert.equal((await api.handle(req('POST', '/pixel-pet/anim', { state: 'fly' }), ctx(log))).status, 400);
  assert.equal((await api.handle(req('POST', '/pixel-pet/anim', { state: 'lifted' }), ctx(log))).status, 400, 'lifted needs a hand');
  const th = await api.handle(req('POST', '/pixel-pet/throw', { angle: 90, power: 1 }), ctx(log));
  assert.deepEqual(th.json, { ok: true, vx: 0, vy: -1200, bounces: 2 });
  assert.equal((await api.handle(req('POST', '/pixel-pet/throw', { angle: 0, power: 9 }), ctx(log))).status, 400);
  const chat = await api.handle(req('POST', '/pixel-pet/chat', { text: '在吗' }), ctx(log));
  assert.deepEqual(chat.json, { ok: true, text: 'echo: 在吗' });
  assert.deepEqual(log.map((l) => l[0]), ['say', 'anim', 'throw', 'chat']);
  assert.deepEqual(log[1], ['anim', 'walk', 'left']);
});

test('API server: listens on 127.0.0.1 only, answers JSON, and stops', async () => {
  const log = [];
  const c = ctx(log);
  const srv = new ApiServer({ ...c, token: () => TOKEN });
  const port = 17340 + Math.floor(Math.random() * 1000);
  const st = await srv.apply({ enabled: true, port });
  assert.deepEqual(st, { listening: true, port, error: null });
  assert.equal(srv.server.address().address, '127.0.0.1');
  const call = (method, p, body, auth = TOKEN) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', (x) => { d += x; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }));
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
  assert.deepEqual(await call('POST', '/pixel-pet/say', { text: 'hi' }), { status: 200, json: { ok: true } });
  assert.equal((await call('GET', '/pixel-pet/state', null, 'nope')).status, 401);
  const bad = await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/pixel-pet/say', headers: { authorization: `Bearer ${TOKEN}` } }, (res) => resolve(res.statusCode));
    r.end('{not json');
  });
  assert.equal(bad, 400);
  await srv.apply({ enabled: false, port });
  assert.equal(srv.status().listening, false);
  await assert.rejects(call('GET', '/pixel-pet/state'));
});

test('API: sayExternal shows the line (and it is read aloud as an API line)', async () => {
  const { svc, said } = service();
  assert.equal(svc.sayExternal('hi').reason, 'no-pet');
  await svc.hatch({ speciesId: 'gemini', name: 'T' });
  assert.equal(svc.sayExternal('  \n').ok, false);
  assert.equal(svc.sayExternal('外部脚本：该休息啦').ok, true);
  const m = said[said.length - 1];
  assert.deepEqual([m.text, m.source, m.kind], ['外部脚本：该休息啦', 'api', 'api']);
  assert.equal(Voice.shouldSpeak(m), true);
});
