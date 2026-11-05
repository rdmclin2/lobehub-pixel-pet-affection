'use strict';
// The dance library (docs/vrm-dance.md §5): the index cleaned, the list and lookup, who may dance; where the
// folder is (env > userData > dev, never inside the repository) and what vrmlib://dance/… serves (a whitelist,
// no traversal, Range for the <audio> element); the built-in demo (our own keyframes and beat, valid .vrma);
// the local API's dance routes; and the leak guards (§5.6).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const Dances = require('../src/core/vrm-dances');
const VD = require('../src/main/vrm-dances');
const Demo = require('../src/core/dance-demo');
const V = require('../src/core/vrm');
const api = require('../src/core/api');

const ROOT = path.join(__dirname, '..');
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `pp-dance-${tag}-`));

const GOOD = {
  'gokuraku-3f2a': { name: '極楽浄土', file: 'gokuraku-3f2a/dance.vrma', audio: 'gokuraku-3f2a/audio.mp3', cover: 'gokuraku-3f2a/cover.jpg', duration: 218.1, audioDuration: 216.4, offset: 0, credit: 'Motion by yurie', face: true, ik: 'on', extent: { up: 1.31, side: 0.86 }, stage: { radius: 0.15, clampHits: 0.42 }, ground: -0.01, source: 'vidol-pack', bakedWith: 'vmd-retarget@1', importedAt: '2026-11-03T10:00:00.000Z' },
  'short-loop': { name: 'Short', file: 'short-loop/dance.vrma', duration: 8, importedAt: '2026-11-01T10:00:00.000Z' },
};

test('cleanDanceIndex keeps well-formed entries and drops anything with a path it does not own', () => {
  const raw = {
    schema: 1,
    dances: {
      ...GOOD,
      demo: { name: 'not the builtin', file: 'demo/dance.vrma', duration: 3 }, // the demo id is reserved
      'Upper-Case': { file: 'Upper-Case/dance.vrma', duration: 3 },
      'other-dir': { file: 'gokuraku-3f2a/dance.vrma', duration: 3 }, // another dance's file
      traversal: { file: 'traversal/../../etc/passwd', duration: 3 },
      'bad-file': { file: 'bad-file/dance.vmd', duration: 3 },
      'no-duration': { file: 'no-duration/dance.vrma' },
      'bad-audio': { file: 'bad-audio/dance.vrma', duration: 3, audio: 'bad-audio/song.ncm', cover: '../cover.jpg' },
    },
  };
  const ix = Dances.cleanDanceIndex(raw);
  assert.deepEqual(Object.keys(ix.dances).sort(), ['bad-audio', 'gokuraku-3f2a', 'short-loop']);
  const g = ix.dances['gokuraku-3f2a'];
  assert.equal(g.audio, 'gokuraku-3f2a/audio.mp3');
  assert.equal(g.cover, 'gokuraku-3f2a/cover.jpg');
  assert.equal(g.loop, false, 'a long dance with music does not loop by default');
  assert.deepEqual(g.extent, { up: 1.31, side: 0.86 });
  assert.equal(ix.dances['short-loop'].loop, true, '≤ 15 s without music loops by default (§4.3)');
  assert.equal(ix.dances['bad-audio'].audio, undefined, 'an .ncm is not music it can play');
  assert.equal(ix.dances['bad-audio'].cover, undefined);
  assert.deepEqual(Dances.cleanDanceIndex(null), { schema: 1, dances: {} });
  assert.deepEqual(Dances.cleanDanceIndex({ dances: [1, 2] }), { schema: 1, dances: {} });
});

test('the list: newest import first, the demo last; lookup by id, by name (NFKC, contained), a random pick avoids the last', () => {
  const ix = Dances.cleanDanceIndex({ dances: GOOD });
  const list = Dances.listDances(ix);
  assert.deepEqual(list.map((d) => d.id), ['gokuraku-3f2a', 'short-loop', 'demo']);
  assert.equal(Dances.findDance(list, { id: 'short-loop' }).id, 'short-loop');
  assert.equal(Dances.findDance(list, { id: 'nope' }), null);
  assert.equal(Dances.findDance(list, { name: '極楽浄土' }).id, 'gokuraku-3f2a');
  assert.equal(Dances.findDance(list, { name: '《極楽浄土》' }).id, 'gokuraku-3f2a', 'brackets and spaces are ignored');
  assert.equal(Dances.findDance(list, { name: '节拍' }).id, 'demo');
  assert.equal(Dances.findDance(list, { name: 'xyz' }), null);
  for (let i = 0; i < 20; i++) assert.notEqual(Dances.pickDance(list, { last: 'gokuraku-3f2a', rand: () => i / 20 }).id, 'gokuraku-3f2a');
  assert.equal(Dances.pickDance([Dances.demoEntry()], { last: 'demo' }).id, 'demo', 'only the demo: the demo');
  const pub = Dances.publicEntry(list[0]);
  assert.deepEqual(Object.keys(pub).sort(), ['builtin', 'cover', 'credit', 'duration', 'face', 'id', 'loop', 'music', 'name']);
  assert.ok(!JSON.stringify(pub).includes('/'), 'no paths go out');
});

test('only a VRM look dances; any other look gets not-vrm with a reason that names it', () => {
  assert.equal(Dances.cannotDance({ kind: 'vrm' }), null);
  for (const [kind, label] of [['sprites', '像素'], ['live2d', 'Live2D'], ['pictures', '图片'], ['rig', '像素']]) {
    const r = Dances.cannotDance({ kind });
    assert.equal(r.reason, 'not-vrm');
    assert.equal(r.kind, kind);
    assert.match(r.message, /只有 VRM 外观可以跳/);
    assert.ok(r.message.includes(`${label}外观`), r.message);
  }
  assert.equal(Dances.cannotDance(null).reason, 'not-vrm');
});

test('the dance folder: env, then userData with an index, then ~/vrm-assets/baked-dances on a dev run; never inside the repository', () => {
  const home = tmp('home');
  const user = tmp('user');
  const dev = path.join(home, 'vrm-assets', 'baked-dances');
  assert.deepEqual(VD.danceDir({ env: {}, userData: user, home }), { dir: path.join(user, 'vrm-dances'), source: 'userData' });
  fs.mkdirSync(dev, { recursive: true });
  fs.writeFileSync(path.join(dev, 'library.json'), '{}');
  assert.deepEqual(VD.danceDir({ env: {}, userData: user, home }), { dir: dev, source: 'dev' });
  assert.equal(VD.danceDir({ env: {}, userData: user, home, packaged: true }).source, 'userData', 'not in the installed app');
  assert.equal(VD.danceDir({ env: { PIXELPET_TEST: '1' }, userData: user, home }).source, 'userData', 'not in tests');
  fs.mkdirSync(path.join(user, 'vrm-dances'));
  fs.writeFileSync(path.join(user, 'vrm-dances', 'library.json'), '{}');
  assert.equal(VD.danceDir({ env: {}, userData: user, home }).source, 'userData', 'the user\'s own library wins over the dev one');
  assert.deepEqual(VD.danceDir({ env: { PIXELPET_VRM_DANCES_DIR: '~/x' }, userData: user, home }), { dir: path.join(home, 'x'), source: 'env' });
  const inRepo = VD.danceDir({ env: { PIXELPET_VRM_DANCES_DIR: path.join(ROOT, 'tmp-dances') }, userData: user, home });
  assert.equal(inRepo.dir, null);
  assert.equal(inRepo.refused, path.join(ROOT, 'tmp-dances'));
});

test('vrmlib://dance/…: the index, the whitelisted files of a dance, the demo from memory; traversal and anything else refused', () => {
  const d = tmp('lib');
  assert.deepEqual(VD.resolveDanceUrl(d, 'vrmlib://dance/library.json'), { index: path.join(d, 'library.json') });
  for (const f of ['dance.vrma', 'audio.mp3', 'audio.wav', 'audio.ogg', 'audio.m4a', 'audio.flac', 'cover.jpg', 'cover.png', 'cover.webp']) assert.deepEqual(VD.resolveDanceUrl(d, `vrmlib://dance/abc-1/${f}`), { file: path.join(d, 'abc-1', f) }, f);
  assert.deepEqual(VD.resolveDanceUrl(d, 'vrmlib://dance/demo/dance.vrma'), { demo: 'vrma' });
  assert.deepEqual(VD.resolveDanceUrl(d, 'vrmlib://dance/demo/audio.wav'), { demo: 'wav' });
  assert.deepEqual(VD.resolveDanceUrl(null, 'vrmlib://dance/demo/dance.vrma'), { demo: 'vrma' }, 'the demo needs no folder');
  for (const bad of [
    'vrmlib://dance/x/../../a.mp3', 'vrmlib://dance/..%2f..%2fetc%2fpasswd', 'vrmlib://dance/x/..%2f..%2faudio.mp3', 'vrmlib://dance/x%2f..%2f..%2faudio.mp3',
    'vrmlib://dance/abc/Dance.vrma', 'vrmlib://dance/abc/AUDIO.MP3', 'vrmlib://dance/abc/song.mp3', 'vrmlib://dance/abc/audio.ncm', 'vrmlib://dance/abc/src/x.vmd',
    'vrmlib://dance/abc/readme.txt', 'vrmlib://dance/ABC/dance.vrma', 'vrmlib://dance/abc', 'vrmlib://dance/demo/cover.jpg', 'vrmlib://dance/demo/audio.mp3',
    'vrmlib://dance/%E2%80%AE/dance.vrma', 'vrmlib://dance/abc/dance.vrma%00.txt', 'vrmlib://female/dance.vrma', 'pack://dance/abc/dance.vrma', 'not a url',
  ]) {
    const r = VD.resolveDanceUrl(d, bad);
    assert.ok(r === null || (r.file && r.file.startsWith(d + path.sep) && Dances.FILE_RE.test(path.basename(r.file))), `${bad} → ${JSON.stringify(r)}`);
    if (r && r.file) assert.ok(!/\.\./.test(path.relative(d, r.file)), bad);
  }
  assert.equal(VD.resolveDanceUrl(d, 'vrmlib://dance/abc/Dance.vrma'), null, 'case does not get round the whitelist');
  assert.equal(VD.resolveDanceUrl(null, 'vrmlib://dance/abc/dance.vrma'), null, 'no folder: nothing but the demo');
  // the motion library's resolver does not answer dance URLs
  assert.equal(require('../src/main/vrm-library').resolveUrl(d, 'vrmlib://dance/abc/dance.vrma'), null);
});

test('the dance handler: an empty index when there is none, files with Range (206), 404 outside the whitelist', async () => {
  const d = tmp('serve');
  const where = { dir: d, source: 'env' };
  const req = (url, range) => ({ url, headers: new Headers(range ? { range } : {}) });
  let r = VD.danceResponse(where, req('vrmlib://dance/library.json'));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { schema: 1, dances: {} });
  fs.mkdirSync(path.join(d, 'gokuraku-3f2a'));
  fs.writeFileSync(path.join(d, 'gokuraku-3f2a', 'audio.mp3'), Buffer.from('0123456789'));
  fs.writeFileSync(path.join(d, 'library.json'), JSON.stringify({ schema: 1, dances: GOOD }));
  r = VD.danceResponse(where, req('vrmlib://dance/library.json'));
  assert.deepEqual(Object.keys((await r.json()).dances).sort(), ['gokuraku-3f2a', 'short-loop'], 'cleaned before it is served');
  r = VD.danceResponse(where, req('vrmlib://dance/gokuraku-3f2a/audio.mp3'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/mpeg');
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  r = VD.danceResponse(where, req('vrmlib://dance/gokuraku-3f2a/audio.mp3', 'bytes=2-5'));
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), '2345');
  r = VD.danceResponse(where, req('vrmlib://dance/gokuraku-3f2a/audio.mp3', 'bytes=7-'));
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), '789');
  assert.equal(VD.danceResponse(where, req('vrmlib://dance/gokuraku-3f2a/dance.vrma')).status, 404, 'missing file');
  assert.equal(VD.danceResponse(where, req('vrmlib://dance/gokuraku-3f2a/readme.txt')).status, 404, 'not on the whitelist');
  assert.equal(VD.danceResponse(where, req('vrmlib://female/x.vrma')), null, 'not a dance URL: the motion library answers it');
  r = VD.danceResponse({ dir: null, source: 'none' }, req('vrmlib://dance/demo/dance.vrma'));
  assert.equal(r.status, 200);
  const vrma = Buffer.from(await r.arrayBuffer());
  assert.equal(vrma.toString('latin1', 0, 4), 'glTF');
  r = VD.danceResponse({ dir: null, source: 'none' }, req('vrmlib://dance/demo/audio.wav', 'bytes=0-11'));
  assert.equal(r.status, 206);
  assert.equal(Buffer.from(await r.arrayBuffer()).toString('latin1', 0, 4), 'RIFF');
  // the list main gives (dances:list, GET /dances)
  const l = VD.listDances(where);
  assert.equal(l.dir, d);
  assert.deepEqual(l.dances.map((x) => x.id), ['gokuraku-3f2a', 'short-loop', 'demo']);
  fs.writeFileSync(path.join(d, 'library.json'), '{ broken');
  const broken = VD.listDances(where);
  assert.ok(broken.error, 'a broken index is reported');
  assert.deepEqual(broken.dances.map((x) => x.id), ['demo'], '…and treated as empty (the files stay)');
});

test('the demo dance: a valid .vrma with every reference bone keyed and a face track, a seamless loop, the beat as a 16 s WAV', () => {
  const a = Demo.demoAssets();
  const jl = a.vrma.readUInt32LE(12);
  const check = V.inspectVrmaJson(JSON.parse(a.vrma.subarray(20, 20 + jl).toString('utf8')));
  assert.equal(check.ok, true, check.errors.join('; '));
  assert.deepEqual(check.expressions, ['happy']);
  const clip = Demo.demoClip();
  assert.equal(clip.duration, 16);
  assert.ok(Object.keys(clip.bones).length >= 50, 'every bone keyed: a fade never lets the T-pose through');
  // the loop: the last frame is the first
  const p0 = Demo.demoPoseAt(0);
  const p1 = Demo.demoPoseAt(16 - 1e-9);
  for (const [b, v] of Object.entries(p0.bones)) v.forEach((x, i) => assert.ok(Math.abs(x - p1.bones[b][i]) < 1e-3, `${b} ${v} vs ${p1.bones[b]}`));
  // the choreography as written: arms down in the sway, forward for the clap, up for the heart, a half turn
  assert.equal(Demo.demoPoseAt(2).section, 'A');
  assert.ok(Demo.demoPoseAt(2).bones.leftUpperArm[2] < -60, 'A: arms down');
  assert.ok(Demo.demoPoseAt(5.5).bones.leftUpperArm[1] < -70, 'B: arm forward at a clap');
  assert.ok(Demo.demoPoseAt(10).bones.leftUpperArm[2] > 60, 'C: arms up');
  assert.ok(Math.abs(Demo.demoPoseAt(13.75).bones.hips[1] - 180) < 1, 'D: turned round');
  assert.ok(Math.abs(Demo.demoPoseAt(15.75).bones.hips[1]) < 1, 'D: back');
  // the extent and ground the demo entry carries are the measured ones (the camera frames by them)
  const e = Dances.demoEntry();
  assert.ok(Math.abs(e.extent.up - a.extent.up) < 0.01 && Math.abs(e.extent.side - a.extent.side) < 0.01, `${JSON.stringify(e.extent)} vs ${JSON.stringify(a.extent)}`);
  assert.ok(Math.abs(e.ground - a.ground) < 0.005);
  // the music
  assert.equal(a.wav.toString('latin1', 0, 4), 'RIFF');
  const rate = a.wav.readUInt32LE(24);
  assert.equal((a.wav.length - 44) / 2 / rate, 16);
  // a kick on the first beat: loud near 0, quiet just before the next beat's onset
  const at = (t) => Math.abs(a.wav.readInt16LE(44 + 2 * Math.round(t * rate)));
  let peak = 0;
  for (let t = 0; t < 0.05; t += 1 / rate) peak = Math.max(peak, at(t));
  assert.ok(peak > 10000, `kick ${peak}`);
  // nothing in it reads a file
  const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'dance-demo.js'), 'utf8');
  assert.ok(!/require\(['"](node:)?fs['"]\)|readFileSync|\.(mp3|wav|ogg|vmd|vrma|png|jpg)['"]/.test(src), 'dance-demo.js refers to no file');
});

test('local API: /dances, /dance, /dance/stop, /state.dance and their errors', async () => {
  const calls = [];
  const ctx = (over = {}) => ({
    token: 't0ken-t0ken-t0ken-t0ken-1',
    state: async () => ({ pet: null, dance: { id: 'demo', t: 1.2 } }),
    dances: async () => ({ vrm: true, dances: [{ id: 'demo', name: '节拍摇摆' }] }),
    dance: async (o) => { calls.push(o); return { ok: true, id: o.id || 'demo', name: '节拍摇摆', loop: !!o.loop, duration: 16, music: true }; },
    danceStop: async () => ({ ok: true, id: 'demo' }),
    ...over,
  });
  const req = (method, p, body = {}) => ({ method, path: `/pixel-pet${p}`, headers: { host: '127.0.0.1:7340', authorization: 'Bearer t0ken-t0ken-t0ken-t0ken-1' }, body });
  const routes = api.ROUTES.map(([m, r]) => `${m} ${r}`);
  for (const r of ['GET /dances', 'POST /dance', 'POST /dance/stop']) assert.ok(routes.includes(r), r);
  let r = await api.handle(req('GET', '/dances'), ctx());
  assert.equal(r.status, 200);
  assert.equal(r.json.dances[0].id, 'demo');
  r = await api.handle(req('POST', '/dance', { id: 'demo', loop: true }), ctx());
  assert.deepEqual(r, { status: 200, json: { ok: true, id: 'demo', name: '节拍摇摆', loop: true, duration: 16, music: true } });
  assert.deepEqual(calls.pop(), { id: 'demo', name: undefined, loop: true });
  r = await api.handle(req('POST', '/dance', { name: '  节拍  ' }), ctx());
  assert.equal(calls.pop().name, '节拍');
  for (const [body, err] of [[{ id: '../x' }, 'bad-id'], [{ id: 5 }, 'bad-id'], [{ name: '' }, 'bad-name'], [{ loop: 'yes' }, 'bad-loop']]) {
    r = await api.handle(req('POST', '/dance', body), ctx());
    assert.equal(r.status, 400);
    assert.equal(r.json.error, err);
  }
  r = await api.handle(req('POST', '/dance', {}), ctx({ dance: async () => ({ ok: false, reason: 'not-vrm', kind: 'sprites', message: '舞蹈只有 VRM 外观可以跳。她现在是像素外观，换成 VRM 模型再来吧。' }) }));
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'not-vrm');
  assert.equal(r.json.kind, 'sprites');
  assert.match(r.json.message, /只有 VRM 外观/);
  r = await api.handle(req('POST', '/dance', { id: 'nope' }), ctx({ dance: async () => ({ ok: false, reason: 'no-dance', dances: ['demo'] }) }));
  assert.equal(r.status, 404);
  assert.deepEqual(r.json.dances, ['demo']);
  r = await api.handle(req('POST', '/dance', { id: 'gone' }), ctx({ dance: async () => ({ ok: false, reason: 'load-failed', message: '没能载入' }) }));
  assert.equal(r.status, 502);
  r = await api.handle(req('POST', '/dance/stop'), ctx());
  assert.deepEqual(r.json, { ok: true, id: 'demo' });
  r = await api.handle(req('POST', '/dance/stop'), ctx({ danceStop: async () => ({ ok: false, reason: 'not-dancing' }) }));
  assert.deepEqual(r, { status: 200, json: { ok: true, id: null, dancing: false } });
  assert.equal((await api.handle(req('GET', '/dance'), ctx())).status, 405);
  r = await api.handle(req('GET', '/state'), ctx());
  assert.deepEqual(r.json.dance, { id: 'demo', t: 1.2 });
  assert.equal((await api.handle({ ...req('GET', '/dances'), headers: { host: '127.0.0.1:7340' } }, ctx())).status, 401, 'the token is still needed');
});

test('leak guards (§5.6): no dance material in git or the package, ignored folders, a demo with no file', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n');
  for (const e of ['*.vmd', '*.VMD', '*.vrma', '*.ncm', 'vrm-dances/', 'baked-dances/']) assert.ok(gi.includes(e), `.gitignore ${e}`);
  const files = require('../package.json').build.files;
  for (const e of ['!**/*.vmd', '!**/*.VMD', '!**/*.ncm', '!**/*.vrma', '!**/vrm-dances/**', '!**/baked-dances/**']) assert.ok(files.includes(e), `build.files ${e}`);
  let tracked = [];
  try { tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n'); } catch { return; }
  assert.deepEqual(tracked.filter((f) => /\.(vmd|ncm|vrma)$/i.test(f) && !require('../scripts/vrm-bundle-motions').isBundledMotion(f)), [], 'no motion or encrypted music in git');
  // 商店 → 舞蹈's card pictures (src/renderer/catalog/dances/<id>.jpg, scripts/build-store-assets.js) ship like the
  // character catalog's: small, re-encoded, the covers themselves and the music stay out
  const storePic = (f) => /^src\/renderer\/catalog\/dances\/dance-[a-z0-9-]+\.jpg$/.test(f) && fs.statSync(path.join(ROOT, f)).size < 120 * 1024;
  assert.deepEqual(tracked.filter((f) => /(^|\/)(vrm-)?dances\//i.test(f) && /\.(mp3|wav|ogg|m4a|flac|jpe?g|png|webp)$/i.test(f) && !storePic(f)), [], 'no dance music or covers in git');
});
