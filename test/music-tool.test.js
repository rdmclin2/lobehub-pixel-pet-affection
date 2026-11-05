'use strict';
// 音乐创作 in the chat (T-5090): the compose_music function tool (core/responses-client.js), its own gate in
// PetService (_musicStatus: 音乐创作 switch + MiniMax key + a direct turn, never 本机能力), what the model reads back,
// the songs in the 'say' line / 聊天记录 / the chat page view, the turn clock stopped while a song is made, and
// toolsRan (a song made once is never made again by a fallback). Real ResponsesClient and core/music.js against
// local stand-ins (test/fixtures/fake-responses-server.js, fake-minimax-music.js): no tokens, no MiniMax quota.
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { ResponsesClient, MUSIC_TOOL, MUSIC_TOOL_NAME, LOCAL_FUNCTION_TOOLS, createMusicTool, musicToolOutput } = require('../src/core/responses-client');
const music = require('../src/core/music');
const persona = require('../src/core/persona');
const adminChat = require('../src/core/admin-chat');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const { startFakeResponses } = require('./fixtures/fake-responses-server');
const { startFakeMiniMaxMusic, SAMPLE } = require('./fixtures/fake-minimax-music');
const { startFakeMusicServices } = require('./fixtures/fake-music-services');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const agentRuns = (dir) => (fs.existsSync(path.join(dir, 'runs.log')) ? fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
const SONG_ARGS = { prompt: '轻松的 lo-fi，雨夜，钢琴', instrumental: true, title: '雨夜小憩', mood: '轻松', durationSec: 60, structure: ['Intro', 'Verse', 'Outro'] };

// ---- the tool ---------------------------------------------------------------------------------------------
test('compose_music: one function tool whose parameters are core/music.js buildRequest\'s, and a description that says when to use it', () => {
  assert.equal(MUSIC_TOOL.name, MUSIC_TOOL_NAME);
  assert.equal(MUSIC_TOOL_NAME, 'compose_music');
  assert.equal(MUSIC_TOOL.type, 'function');
  assert.ok(!LOCAL_FUNCTION_TOOLS.some((t) => t.name === MUSIC_TOOL_NAME), 'not one of the local abilities');
  const props = MUSIC_TOOL.parameters.properties;
  assert.deepEqual(Object.keys(props).sort(), ['bpm', 'durationSec', 'genre', 'instrumental', 'instruments', 'lyrics', 'lyricsOptimizer', 'mood', 'prompt', 'scene', 'structure', 'title', 'vocals']);
  assert.deepEqual(props.structure.items.enum, music.STRUCTURE_TAGS);
  assert.deepEqual([props.bpm.minimum, props.bpm.maximum], music.LIMITS.bpm);
  assert.deepEqual([props.durationSec.minimum, props.durationSec.maximum], music.LIMITS.durationSec);
  assert.deepEqual(MUSIC_TOOL.parameters.required, ['prompt']);
  assert.equal(MUSIC_TOOL.parameters.additionalProperties, false);
  for (const s of ['给我写首歌', '来段轻松的纯音乐', 'instrumental: true', 'lyricsOptimizer', 'once']) assert.ok(MUSIC_TOOL.description.includes(s), s);
  // every argument the model may send is accepted by buildRequest as is
  const r = music.buildRequest({ ...SONG_ARGS, genre: 'lo-fi', scene: '下雨', instruments: 'piano', bpm: 80 });
  assert.equal(r.body.is_instrumental, true);
  assert.match(r.body.prompt, /Genre: lo-fi.*Mood: 轻松.*Tempo: 80 BPM.*Length: about 60 seconds.*Structure: Intro - Verse - Outro/);
  assert.equal(r.title, '雨夜小憩');
});

test('musicToolOutput: the model reads the file path, file:// link, title and length — or the reason, the MiniMax code and whether to retry', () => {
  const ok = JSON.parse(musicToolOutput({ filePath: '/m/20261104-雨夜小憩.mp3', fileUrl: 'file:///m/20261104-%E9%9B%A8.mp3', durationMs: 25364, meta: { title: '雨夜小憩', format: 'mp3', instrumental: true, warnings: [] } }));
  assert.deepEqual({ ok: ok.ok, title: ok.title, filePath: ok.filePath, fileUrl: ok.fileUrl, durationSec: ok.durationSec, format: ok.format, instrumental: ok.instrumental }, { ok: true, title: '雨夜小憩', filePath: '/m/20261104-雨夜小憩.mp3', fileUrl: 'file:///m/20261104-%E9%9B%A8.mp3', durationSec: 25.4, format: 'mp3', instrumental: true });
  const bad = JSON.parse(musicToolOutput(null, new music.MusicError('balance', 'MiniMax 账户余额或额度不足', { code: 1008 })));
  assert.deepEqual(bad, { ok: false, reason: 'balance', code: 1008, error: 'MiniMax 账户余额或额度不足（错误码 1008）', retry: false, provider: null });
  assert.equal(JSON.parse(musicToolOutput(null, new music.MusicError('rate-limit', '太频繁', { code: 1002 }))).retry, true);
});

// ---- ResponsesClient: extraTools ------------------------------------------------------------------------------
function client(plan) {
  return startFakeResponses(plan).then((srv) => ({ srv, c: new ResponsesClient({ lh: { workspaceId: null }, env: { LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'k' }, readCredentials: () => null, runTool: async (name) => { throw new Error(`runTool must not be called (${name})`); } }) }));
}

test('run with only compose_music offered: the request lists it alone (no read_file / run_command), the call runs it and its output goes back strict', async (t) => {
  const { srv, c } = await client((body, n) => (n === 1 ? { pieces: ['好呀，我来写～'], calls: [['call_m1', 'compose_music', SONG_ARGS]], id: 'tpc_M' } : { pieces: ['写好啦：《雨夜小憩》'], id: 'tpc_M' }));
  t.after(() => srv.close());
  const seen = [];
  const tool = createMusicTool({ generate: async (args) => { seen.push(args); return { filePath: '/m/a.mp3', fileUrl: 'file:///m/a.mp3', durationMs: 3030, meta: { title: args.title, format: 'mp3', instrumental: true } }; }, onEvent: (e) => seen.push(e.state) });
  const r = await c.run({ agentId: 'agt', prompt: '来段轻松的纯音乐', tools: [], extraTools: [tool], onDelta: () => {} });
  assert.equal(r.text, '写好啦：《雨夜小憩》');
  assert.deepEqual(srv.requests[0].body.tools.map((x) => x.name), ['compose_music']);
  assert.equal(srv.requests[0].body.tools_mode, 'exclusive');
  assert.deepEqual(seen, ['start', SONG_ARGS, 'done']);
  const resume = srv.requests[1].body;
  assert.equal(resume.previous_response_id, 'tpc_M');
  assert.equal(resume.strict_tool_resume, true);
  const out = JSON.parse(resume.input[0].output);
  assert.equal(resume.input[0].call_id, 'call_m1');
  assert.deepEqual([out.ok, out.filePath, out.fileUrl, out.title, out.durationSec], [true, '/m/a.mp3', 'file:///m/a.mp3', '雨夜小憩', 3]);
});

test('run with local abilities on and music: both kinds of tools listed; a local tool asked for while only music is offered is refused, not run', async (t) => {
  const both = await client(() => ({ pieces: ['嗯'] }));
  t.after(() => both.srv.close());
  await both.c.run({ agentId: 'a', prompt: 'p', tools: ['lobe-local-system'], extraTools: [createMusicTool({ generate: async () => ({}) })] });
  assert.deepEqual(both.srv.requests[0].body.tools.map((x) => x.name), [...LOCAL_FUNCTION_TOOLS.map((x) => x.name), 'compose_music']);
  const only = await client((body, n) => (n === 1 ? { calls: [['c1', 'run_command', { command: 'rm -rf ~' }]] } : { pieces: ['我没有那个工具'] }));
  t.after(() => only.srv.close());
  const r = await only.c.run({ agentId: 'a', prompt: 'p', tools: [], extraTools: [createMusicTool({ generate: async () => ({}) })] });
  assert.equal(r.text, '我没有那个工具');
  assert.match(only.srv.requests[1].body.input[0].output, /^Error: run_command is not available: local abilities are off/);
});

test('a failed generation is answered to the model as ok:false with the reason (the turn goes on); the error is reported to onEvent', async (t) => {
  const { srv, c } = await client((body, n) => (n === 1 ? { calls: [['c1', 'compose_music', SONG_ARGS]] } : { pieces: ['MiniMax 余额不够了，充值后再叫我写～'] }));
  t.after(() => srv.close());
  const events = [];
  const tool = createMusicTool({ generate: async () => { throw new music.MusicError('balance', 'MiniMax 账户余额或额度不足', { code: 1008 }); }, onEvent: (e) => events.push(e.state) });
  const r = await c.run({ agentId: 'a', prompt: 'p', tools: [], extraTools: [tool] });
  assert.equal(r.text, 'MiniMax 余额不够了，充值后再叫我写～');
  assert.deepEqual(events, ['start', 'failed']);
  const out = JSON.parse(srv.requests[1].body.input[0].output);
  assert.deepEqual([out.ok, out.reason, out.code], [false, 'balance', 1008]);
});

test('the turn clock (timeoutMs) stops while compose_music runs: a 600 ms song in a 250 ms turn still finishes; a slow local tool still times out', async (t) => {
  const { srv, c } = await client((body, n) => (n === 1 ? { calls: [['c1', 'compose_music', SONG_ARGS]] } : { pieces: ['好了'] }));
  t.after(() => srv.close());
  const slow = createMusicTool({ generate: () => new Promise((r) => setTimeout(() => r({ filePath: '/m/a.mp3', fileUrl: 'file:///m/a.mp3', meta: {} }), 600)) });
  const t0 = Date.now();
  const r = await c.run({ agentId: 'a', prompt: 'p', timeoutMs: 250, tools: [], extraTools: [slow] });
  assert.equal(r.text, '好了');
  assert.ok(Date.now() - t0 >= 600);
  // control: the same wait in an ordinary local tool is cut off by the turn clock, with toolsRan set
  const local = await startFakeResponses(() => ({ calls: [['c1', 'read_file', { path: '/x' }]] }));
  t.after(() => local.close());
  const lc = new ResponsesClient({ lh: { workspaceId: null }, env: { LOBEHUB_SERVER: local.url, LOBEHUB_CLI_API_KEY: 'k' }, readCredentials: () => null, runTool: (_n, _a, signal) => new Promise((res, rej) => { const tm = setTimeout(() => res('late'), 600); signal.addEventListener('abort', () => { clearTimeout(tm); rej(new Error('aborted')); }); }) });
  await assert.rejects(lc.run({ agentId: 'a', prompt: 'p', timeoutMs: 250, tools: ['lobe-local-system'] }), (e) => e.code === 'ETIMEDOUT' && e.toolsRan === true);
});

test('Esc while composing: the generation gets the abort, the turn ends ECANCELED with toolsRan', async (t) => {
  const { srv, c } = await client(() => ({ calls: [['c1', 'compose_music', SONG_ARGS]] }));
  t.after(() => srv.close());
  let aborted = false;
  const tool = createMusicTool({ generate: (_a, { signal }) => new Promise((_r, rej) => signal.addEventListener('abort', () => { aborted = true; rej(new music.MusicError('aborted', '已取消音乐生成')); })) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(c.run({ agentId: 'a', prompt: 'p', tools: [], extraTools: [tool], signal: ac.signal }), (e) => e.code === 'ECANCELED' && e.toolsRan === true);
  assert.equal(aborted, true);
  assert.equal(srv.requests.length, 1, 'no function_call_output was posted');
});

// ---- PetService: the gate and the whole round -----------------------------------------------------------------
// provider: the music service picked (music.provider). Every service points at a local stand-in (never the real
// hosts): MiniMax → fake-minimax-music, fal / ElevenLabs → fake-music-services. key: what the key store holds for
// every slot (a function slot → key may be given instead).
async function setup({ plan, musicPlan = () => ({}), falPlan = () => ({}), elPlan = () => ({}), provider = 'minimax', available = true, key = 'mm-test-key', musicOn = true, settings = null, pollIntervalSec = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petmusic-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const srv = await startFakeResponses(plan);
  const mm = await startFakeMiniMaxMusic(musicPlan);
  const ms = await startFakeMusicServices({ falPlan, elPlan });
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const responses = new ResponsesClient({ lh, env: available ? { LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'test-key' } : { LOBEHUB_SERVER: srv.url }, readCredentials: () => null });
  const keyFn = typeof key === 'function' ? key : () => key;
  const env = { MINIMAX_MUSIC_ENDPOINT: mm.url, FAL_MUSIC_ENDPOINT: ms.url, ELEVENLABS_MUSIC_ENDPOINT: ms.url };
  const svc = new PetService({ lh, responses, music: musicOn ? { key: keyFn, userDataDir: path.join(dir, 'data'), env, allowInsecureLocal: true } : null, store: new Store(path.join(dir, 'data')), now: () => Date.now(), rnd: () => 0.5 });
  svc.settings = { ...svc.settings, music: { ...svc.settings.music, provider, pollIntervalSec } };
  if (settings) svc.settings = { ...svc.settings, ...settings };
  const errors = [];
  svc.on('error', (e) => errors.push(e));
  const events = [];
  for (const ev of ['say', 'music', 'chat-done']) svc.on(ev, (p) => events.push({ ev, p }));
  return { dir, srv, mm, ms, svc, lh, errors, events, close: async () => { await srv.close(); await mm.close(); await ms.close(); } };
}

test('_musicStatus: its own gate — switch, MiniMax key, a direct turn; local abilities neither needed nor exposed', async (t) => {
  const s = await setup({ plan: () => ({ pieces: ['你好'] }) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  assert.ok(!s.svc.pet.localAbilities);
  assert.deepEqual(s.svc._musicStatus(), { on: true, provider: 'minimax', reason: null }, 'on with local abilities off');
  assert.deepEqual(s.svc._tools(), [], 'and that does not turn the local tools on');
  s.svc.settings = { ...s.svc.settings, music: { ...s.svc.settings.music, enabled: false } };
  assert.deepEqual(s.svc._musicStatus(), { on: false, provider: 'minimax', reason: 'off' });
  s.svc.settings = { ...s.svc.settings, music: { ...s.svc.settings.music, enabled: true } };
  const keyFn = s.svc.music.key;
  s.svc.music.key = () => '';
  assert.deepEqual(s.svc._musicStatus(), { on: false, provider: 'minimax', reason: 'no-key' });
  s.svc.music.env = { MINIMAX_MUSIC_ENDPOINT: s.mm.url, MINIMAX_API_KEY: 'from-env' };
  assert.equal(s.svc._musicStatus().on, true, 'MINIMAX_API_KEY counts as a key');
  s.svc.music.key = keyFn;
  // local abilities through an `lh connect` device: that turn is `lh agent run`, which cannot carry the tool
  Object.assign(s.svc.pet, { localAbilities: true });
  Object.assign(s.svc, { _localOk: true, localVia: 'device', _deviceId: 'dev1' });
  assert.deepEqual(s.svc._musicStatus(), { on: false, provider: 'minimax', reason: 'via-device' });
  assert.deepEqual(s.svc._musicStatus({ plain: true }), { on: true, provider: 'minimax', reason: null }, 'the settings window chat has no local tools: direct, so music is on');
  s.svc.localVia = 'direct';
  assert.deepEqual(s.svc._musicStatus(), { on: true, provider: 'minimax', reason: null });
  s.svc._responsesFailedAt = Date.now();
  s.svc.pet.localAbilities = false;
  assert.deepEqual(s.svc._musicStatus(), { on: false, provider: 'minimax', reason: 'no-direct' }, 'the direct way failed a moment ago');
  const none = new PetService({ lh: s.lh, store: new Store(path.join(s.dir, 'd2')) });
  assert.deepEqual(none._musicStatus(), { on: false, reason: 'unsupported' });
  assert.match(persona.musicHint({ on: true }), /compose_music/);
  assert.match(persona.musicHint({ on: false, reason: 'via-device' }), /不能作曲.*lh connect/);
  assert.equal(persona.musicHint({ on: false, reason: 'unsupported' }), '');
});

test('chat 「来段轻松的纯音乐」 with local abilities off: compose_music runs once against MiniMax, the song is saved, shown with the reply and kept in 聊天记录', async (t) => {
  const s = await setup({
    plan: (body, n) => (n === 1 ? { pieces: ['你好'], id: 'tpc_MUS' } : n === 2 ? { pieces: ['好呀～'], calls: [['call_1', 'compose_music', SONG_ARGS]], id: 'tpc_MUS' } : { pieces: ['写好啦，《雨夜小憩》，点下面就能听～'], id: 'tpc_MUS' }),
    musicPlan: () => ({ delayMs: 50 }),
  });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('来段轻松的纯音乐');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, '写好啦，《雨夜小憩》，点下面就能听～');
  // the request: compose_music alone, the hint in the prompt
  const req = s.srv.requests[1].body;
  assert.deepEqual(req.tools.map((x) => x.name), ['compose_music']);
  assert.match(req.input, /\[作曲\].*compose_music/);
  // MiniMax: once, with the key and the parameters
  assert.equal(s.mm.requests.length, 1);
  assert.equal(s.mm.requests[0].headers.authorization, 'Bearer mm-test-key');
  assert.equal(s.mm.requests[0].body.is_instrumental, true);
  assert.equal(s.mm.requests[0].body.model, 'music-3.0');
  assert.equal(s.mm.downloads, 1);
  // the file: under userData/music, the bytes MiniMax sent
  assert.equal(r.music.length, 1);
  const song = r.music[0];
  assert.equal(path.dirname(song.filePath), path.join(s.dir, 'data', 'music'));
  assert.match(path.basename(song.filePath), /^\d{8}-\d{6}-雨夜小憩\.mp3$/);
  assert.deepEqual(fs.readFileSync(song.filePath), fs.readFileSync(SAMPLE));
  assert.equal(song.fileUrl.startsWith('file://'), true);
  assert.deepEqual([song.title, song.durationMs, song.format, song.instrumental], ['雨夜小憩', 3030, 'mp3', true]);
  assert.equal(s.svc.musicDir(), path.join(s.dir, 'data', 'music'));
  // what the model was told
  const out = JSON.parse(s.srv.requests[2].body.input[0].output);
  assert.deepEqual([out.ok, out.filePath, out.fileUrl, out.title, out.durationSec], [true, song.filePath, song.fileUrl, '雨夜小憩', 3]);
  // the windows: 作曲中… then done, then the line with the song
  const states = s.events.filter((e) => e.ev === 'music').map((e) => e.p.state);
  assert.equal(states[0], 'composing');
  assert.equal(states.at(-1), 'done');
  const said = s.events.filter((e) => e.ev === 'say').at(-1).p;
  assert.equal(said.text, r.text);
  assert.deepEqual(said.music, r.music);
  assert.ok(said.streamId);
  // 聊天记录 keeps it; the chat page's view lists it
  const pet = s.svc.log.list().filter((m) => m.role === 'pet').at(-1);
  assert.deepEqual(pet.attachments.music, r.music);
  assert.deepEqual(adminChat.messageView(pet, null, 'testchan').music, r.music);
  assert.equal(agentRuns(s.dir).length, 0, 'no lh agent run');
});

test('MiniMax refuses (余额不足): no file, the model gets ok:false with the reason and code, she says so; the window gets failed', async (t) => {
  const s = await setup({
    plan: (body, n) => (n === 1 ? { pieces: ['你好'] } : n === 2 ? { calls: [['c1', 'compose_music', SONG_ARGS]] } : { pieces: ['MiniMax 说额度不够了～'] }),
    musicPlan: () => ({ code: 1008, msg: 'insufficient balance' }),
  });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('给我写首歌');
  assert.equal(r.ok, true);
  assert.equal(r.music, undefined);
  const out = JSON.parse(s.srv.requests[2].body.input[0].output);
  assert.deepEqual([out.ok, out.reason, out.code], [false, 'balance', 1008]);
  const failed = s.events.filter((e) => e.ev === 'music' && e.p.state === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].p.error, /余额/);
  assert.equal(fs.existsSync(path.join(s.dir, 'data', 'music')) ? fs.readdirSync(path.join(s.dir, 'data', 'music')).length : 0, 0);
});

test('toolsRan: the song was made, then her answer fails (502) — no second generation, no lh agent run; the song is still shown and kept', async (t) => {
  const s = await setup({ plan: (body, n) => (n === 1 ? { pieces: ['你好'] } : n === 2 ? { calls: [['c1', 'compose_music', SONG_ARGS]] } : { status: 502, body: 'bad gateway' }) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('来段纯音乐');
  assert.equal(r.ok, true);
  assert.equal(r.partial, true);
  assert.equal(s.mm.requests.length, 1, 'made once');
  assert.equal(agentRuns(s.dir).length, 0, 'not sent again through lh agent run');
  assert.match(r.text, /《雨夜小憩》/);
  const said = s.events.filter((e) => e.ev === 'say').at(-1).p;
  assert.equal(said.music.length, 1);
  assert.ok(fs.existsSync(said.music[0].filePath));
  assert.deepEqual(s.svc.log.list().filter((m) => m.role === 'pet').at(-1).attachments.music, said.music);
});

test('not direct (no LobeHub login for the direct way): the turn goes through lh agent run without the tool, and her prompt says why she cannot compose', async (t) => {
  const s = await setup({ plan: () => ({ pieces: ['x'] }), available: false });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('给我写首歌');
  assert.equal(r.ok, true);
  const runs = agentRuns(s.dir);
  const last = runs.at(-1);
  assert.deepEqual(last.tools, []);
  assert.match(last.prompt, /这次不能作曲：现在连不上 LobeHub 直连接口/);
  assert.equal(s.mm.requests.length, 0);
  assert.equal(s.srv.requests.length, 0);
});

test('music off (no key): no tool in the direct request, and the hint tells her to say the key is missing', async (t) => {
  const s = await setup({ plan: () => ({ pieces: ['要先填 MiniMax Key 哦'] }), key: '' });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  await s.svc.chat('给我写首歌');
  const req = s.srv.requests.at(-1).body;
  assert.deepEqual(req.tools, []);
  assert.match(req.input, /这次不能作曲：音乐服务选的是 MiniMax 官方，但还没有填它的 API Key（设置 → 朗读 → MiniMax，或环境变量 MINIMAX_API_KEY）/);
});

test('settings window 聊天 (chatAs, plain): compose_music is offered there too, its events say console, the message carries the song', async (t) => {
  const s = await setup({ plan: (body, n) => (n === 1 ? { pieces: ['你好'] } : n === 2 ? { calls: [['c1', 'compose_music', { ...SONG_ARGS, title: '控制台之歌' }]] } : { pieces: ['写好了'] }) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chatAs('testchan', { text: '写首歌' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(s.srv.requests[1].body.tools.map((x) => x.name), ['compose_music']);
  assert.equal(r.message.attachments.music[0].title, '控制台之歌');
  const ev = s.events.filter((e) => e.ev === 'music');
  assert.ok(ev.length >= 2 && ev.every((e) => e.p.kind === 'console' && e.p.turnId === r.turnId));
});

// ==== T-5651: the same round on fal.ai (default) and ElevenLabs, against local stand-ins =========================
const ROUND = (args) => (body, n) => (n === 1 ? { pieces: ['你好'] } : n === 2 ? { calls: [['c1', 'compose_music', args]] } : { pieces: ['好了～'] });

test('fal (the default service): 「来段轻松的纯音乐」 → compose_music → fal queue submit, polled until COMPLETED, result, download → the song; the model hears provider and the hint-only fields', async (t) => {
  const s = await setup({ provider: 'fal', key: (slot) => (slot === 'fal' ? 'fal-test-key' : ''), plan: ROUND(SONG_ARGS) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  assert.deepEqual(s.svc._musicStatus(), { on: true, provider: 'fal', reason: null });
  const r = await s.svc.chat('来段轻松的纯音乐');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.ms.fal.submits.length, 1);
  const sub = s.ms.fal.submits[0];
  assert.equal(sub.model, 'fal-ai/minimax-music/v2.6');
  assert.equal(sub.headers.authorization, 'Key fal-test-key');
  assert.equal(sub.input.is_instrumental, true);
  assert.match(sub.input.prompt, /Length: about 60 seconds\. Structure: Intro - Verse - Outro$/);
  assert.equal(s.ms.fal.polls, 3, 'IN_QUEUE → IN_PROGRESS → COMPLETED');
  assert.equal(s.ms.downloads, 1);
  assert.equal(s.mm.requests.length, 0, 'MiniMax direct is not called');
  const song = r.music[0];
  assert.equal(path.dirname(song.filePath), path.join(s.dir, 'data', 'music'));
  assert.deepEqual(fs.readFileSync(song.filePath), fs.readFileSync(SAMPLE));
  assert.deepEqual([song.title, song.provider, song.instrumental], ['雨夜小憩', 'fal', true]);
  const out = JSON.parse(s.srv.requests[2].body.input[0].output);
  assert.deepEqual([out.ok, out.provider, out.model, out.filePath], [true, 'fal', 'fal-ai/minimax-music/v2.6', song.filePath]);
  assert.deepEqual(out.unsupported.map((x) => `${x.field}:${x.how}`), ['durationSec:prompt-hint', 'structure:prompt-hint']);
  assert.match(out.unsupportedNote, /do not promise/);
  const stages = s.events.filter((e) => e.ev === 'music').map((e) => e.p.stage || e.p.state);
  assert.ok(stages.includes('queued') && stages.includes('running'), stages.join(','));
});

test('fal refuses (403 exhausted balance): the model gets ok:false, reason balance, provider fal, retry false, readable Chinese; the window gets failed; no file', async (t) => {
  const s = await setup({ provider: 'fal', key: 'fal-test-key', plan: ROUND(SONG_ARGS), falPlan: () => ({ submit: { status: 403, body: { detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' } } }) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('给我写首歌');
  assert.equal(r.ok, true);
  assert.equal(r.music, undefined);
  const out = JSON.parse(s.srv.requests[2].body.input[0].output);
  assert.deepEqual([out.ok, out.reason, out.code, out.retry, out.provider], [false, 'balance', 'http-403', false, 'fal']);
  assert.match(out.error, /fal\.ai 账户余额不足或已被锁定/);
  const failed = s.events.filter((e) => e.ev === 'music' && e.p.state === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].p.reason, 'balance');
});

test('fal content moderation while running (COMPLETED + content_policy_violation): ok:false reason sensitive, retry false', async (t) => {
  const s = await setup({ provider: 'fal', key: 'fal-test-key', plan: ROUND(SONG_ARGS), falPlan: () => ({ statuses: [{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', error: 'flagged', error_type: 'content_policy_violation' }] }) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  await s.svc.chat('给我写首歌');
  const out = JSON.parse(s.srv.requests[2].body.input[0].output);
  assert.deepEqual([out.ok, out.reason, out.code, out.retry], [false, 'sensitive', 'content_policy_violation', false]);
});

test('ElevenLabs: the same tool call becomes POST /v1/music with xi-api-key, music_length_ms and force_instrumental; the song is saved and shown', async (t) => {
  const s = await setup({ provider: 'elevenlabs', key: (slot) => (slot === 'elevenlabs' ? 'el-test-key' : ''), plan: ROUND(SONG_ARGS) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('来段轻松的纯音乐');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.ms.el.requests.length, 1);
  const q = s.ms.el.requests[0];
  assert.equal(q.headers['xi-api-key'], 'el-test-key');
  assert.deepEqual(q.query, { output_format: 'mp3_44100_128' });
  assert.deepEqual([q.body.model_id, q.body.music_length_ms, q.body.force_instrumental], ['music_v2_5', 60000, true]);
  assert.equal(s.ms.fal.submits.length + s.mm.requests.length, 0);
  assert.deepEqual(fs.readFileSync(r.music[0].filePath), fs.readFileSync(SAMPLE));
  const out = JSON.parse(s.srv.requests[2].body.input[0].output);
  assert.deepEqual([out.ok, out.provider], [true, 'elevenlabs']);
  assert.deepEqual(out.unsupported.map((x) => x.field), ['structure'], 'the length went natively; only the structure was a hint');
});

test('ElevenLabs bad key (401 invalid_api_key): ok:false reason auth, not retryable, says where to set the key', async (t) => {
  const s = await setup({ provider: 'elevenlabs', key: 'el-bad-key-000', plan: ROUND(SONG_ARGS), elPlan: () => ({ status: 401, body: { detail: { type: 'authentication_error', code: 'invalid_api_key', message: 'Invalid API key' } } }) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  await s.svc.chat('给我写首歌');
  const out = JSON.parse(s.srv.requests[2].body.input[0].output);
  assert.deepEqual([out.ok, out.reason, out.code, out.retry, out.provider], [false, 'auth', 'invalid_api_key', false, 'elevenlabs']);
  assert.match(out.error, /设置 → 朗读 → ElevenLabs/);
});

test('the gate follows the picked service: fal picked with only a MiniMax key → off (no-key) and her prompt names fal / FAL_KEY; FAL_KEY in the environment turns it on', async (t) => {
  const s = await setup({ provider: 'fal', key: (slot) => (slot === 'minimax' ? 'mm-test-key' : ''), plan: () => ({ pieces: ['要先填 fal 的 Key 哦'] }) });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  assert.deepEqual(s.svc._musicStatus(), { on: false, provider: 'fal', reason: 'no-key' });
  assert.deepEqual(s.svc.musicKeysView(), { provider: 'fal', keys: { fal: false, elevenlabs: false, minimax: true } });
  assert.deepEqual(s.svc.settingsView().musicStatus, s.svc.musicKeysView());
  await s.svc.chat('给我写首歌');
  const req = s.srv.requests.at(-1).body;
  assert.deepEqual(req.tools, []);
  assert.match(req.input, /这次不能作曲：音乐服务选的是 fal\.ai（MiniMax Music），但还没有填它的 API Key（设置 → 音乐创作 → fal\.ai，或环境变量 FAL_KEY）/);
  s.svc.music.env = { ...s.svc.music.env, FAL_KEY: 'fal-env-key-000' };
  assert.equal(s.svc._musicStatus().on, true);
  s.svc.setSection('music', { provider: 'minimax' });
  assert.deepEqual(s.svc._musicStatus(), { on: true, provider: 'minimax', reason: null });
  // a nested patch keeps the other fields of music.fal
  s.svc.setSection('music', { fal: { model: 'fal-ai/minimax-music/v2.5' } });
  assert.deepEqual(s.svc.settings.music.fal, { endpoint: '', model: 'fal-ai/minimax-music/v2.5' });
});

test('Esc while fal is composing: the turn ends ECANCELED, the polling stops and fal gets PUT …/cancel', async (t) => {
  const ms = await startFakeMusicServices({ falPlan: () => ({ statuses: [{ status: 'IN_PROGRESS' }] }) });
  const { srv, c } = await client(() => ({ calls: [['c1', 'compose_music', SONG_ARGS]] }));
  t.after(async () => { await srv.close(); await ms.close(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'falcancel-'));
  const cfg = music.resolveConfig({ settings: { music: { provider: 'fal', pollIntervalSec: 1 } }, key: 'fal-test-key', env: { FAL_MUSIC_ENDPOINT: ms.url }, userDataDir: dir, allowInsecureLocal: true });
  const tool = createMusicTool({ generate: (args, opts) => music.generateMusic(args, { ...opts, config: { ...cfg, pollIntervalMs: 30 } }) });
  const ac = new AbortController();
  const wait = setInterval(() => { if (ms.fal.polls >= 2) { clearInterval(wait); ac.abort(); } }, 10);
  await assert.rejects(c.run({ agentId: 'a', prompt: 'p', tools: [], extraTools: [tool], signal: ac.signal }), (e) => e.code === 'ECANCELED' && e.toolsRan === true);
  for (let i = 0; i < 50 && ms.fal.cancels.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ms.fal.cancels, ['req-1']);
  const polls = ms.fal.polls;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(ms.fal.polls, polls, 'no more polling after the cancel');
});

// T-6168 (after merging canary's AI 可读的文件夹, T-5075): 本机能力 on with a folder limit and 音乐创作 on — one turn
// offers read_file (with the folder hint) and compose_music together, and one model answer calling both runs both:
// the file inside the folder is read, one outside is refused, the song is made and saved, and run_command (commands
// not allowed) is not offered at all.
test('local abilities on + folder limit + music: read_file and compose_music in the same turn; the limit still holds for read_file, the song is saved', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'petmusic-scope-'));
  const allowed = path.join(root, 'allowed');
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(allowed, 'poem.txt'), '萤火虫提着小灯笼');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside the folder');
  const s = await setup({
    plan: (body, n) => (n === 1 ? { pieces: ['你好'], id: 'tpc_MIX' }
      : n === 2 ? { pieces: ['我先看看诗～'], calls: [['call_r1', 'read_file', { path: path.join(allowed, 'poem.txt') }], ['call_r2', 'read_file', { path: path.join(root, 'secret.txt') }], ['call_m1', 'compose_music', { ...SONG_ARGS, title: '萤火' }]], id: 'tpc_MIX' }
        : { pieces: ['诗读到了，歌也写好啦～'], id: 'tpc_MIX' }),
    musicPlan: () => ({ delayMs: 30 }),
    settings: { local: { folders: [allowed], allowCommands: false } },
  });
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  Object.assign(s.svc.pet, { localAbilities: true });
  Object.assign(s.svc, { _localOk: true, localVia: 'direct' });
  assert.ok(s.svc._toolScope() && s.svc._toolScope().folders.includes(allowed), 'the folder limit is in effect');
  assert.deepEqual(s.svc._musicStatus(), { on: true, provider: 'minimax', reason: null }, 'music stays on with local tools direct + folders');
  const r = await s.svc.chat('读一下 allowed/poem.txt，照着它写首歌');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, '诗读到了，歌也写好啦～');
  // one request lists both kinds: the local tools (no run_command: commands are off) and compose_music
  const names = s.srv.requests[1].body.tools.map((x) => x.name);
  assert.ok(names.includes('read_file') && names.includes('compose_music'), names.join(','));
  assert.ok(!names.includes('run_command'), 'run_command is not offered when commands are not allowed');
  assert.match(s.srv.requests[1].body.tools.find((x) => x.name === 'read_file').description, new RegExp(allowed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // the three outputs go back in one follow-up request
  const outs = Object.fromEntries(s.srv.requests[2].body.input.map((o) => [o.call_id, o.output]));
  assert.equal(outs.call_r1, '萤火虫提着小灯笼');
  assert.match(outs.call_r2, /^Error:/, 'outside the folder: refused');
  assert.doesNotMatch(outs.call_r2, /outside the folder$/, 'the secret is not read');
  const song = JSON.parse(outs.call_m1);
  assert.equal(song.ok, true);
  assert.equal(s.mm.requests.length, 1, 'MiniMax once');
  assert.equal(r.music.length, 1);
  assert.equal(r.music[0].filePath, song.filePath);
  assert.deepEqual(fs.readFileSync(song.filePath), fs.readFileSync(SAMPLE));
  assert.ok(!s.svc._toolsDropped, 'the local tools were not dropped');
  assert.equal(agentRuns(s.dir).length, 0, 'no lh agent run');
});
