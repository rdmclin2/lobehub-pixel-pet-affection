'use strict';
// 她的音乐库 (core/music-library.js): every song compose_music saved is recorded under the character who made it,
// listed on 角色详情 → 音乐 (newest first, `exists` when the file was removed outside the app), renamed (title only)
// and deleted (with its file); main may still play a library song after 保存目录 changed (isLibrarySong). Real
// ResponsesClient + core/music.js against local stand-ins (no tokens, no quota).
const test = require('node:test');
const assert = require('node:assert/strict');
require('./fixtures/adult-character');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('../src/core/music-library');
const { LhClient, cleanEnv } = require('../src/core/lh-client');
const { ResponsesClient } = require('../src/core/responses-client');
const { Store } = require('../src/core/store');
const { PetService } = require('../src/main/pet-service');
const { startFakeResponses } = require('./fixtures/fake-responses-server');
const { startFakeMiniMaxMusic } = require('./fixtures/fake-minimax-music');

const FAKE = path.join(__dirname, 'fixtures', 'fake-lh.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const result = (filePath, meta = {}) => ({ filePath, fileUrl: `file://${filePath}`, durationMs: 3030, meta: { title: '雨夜小憩', format: 'mp3', instrumental: true, provider: 'fal', model: 'fal-ai/minimax-music/v2.6', ...meta } });

// ---- core ---------------------------------------------------------------------------------------------------
test('addSong: records who made it, when, where and what was asked (short); the id is the file name, made unique', () => {
  const asked = { prompt: 'p'.repeat(3000), lyrics: '[Verse]\n第一句', genre: 'lo-fi', mood: '轻松', bpm: 80.4, durationSec: 60, structure: ['Intro', 'Verse'], title: '雨夜小憩', junk: { x: 1 } };
  const a = lib.addSong(null, { result: result('/m/20261105-1-雨夜小憩.mp3'), speciesId: 'claude', kind: 'console', turnId: 't1', request: asked, now: 1000 });
  assert.deepEqual(
    [a.song.id, a.song.title, a.song.speciesId, a.song.createdAt, a.song.kind, a.song.turnId, a.song.durationMs, a.song.provider, a.song.instrumental],
    ['20261105-1-雨夜小憩.mp3', '雨夜小憩', 'claude', 1000, 'console', 't1', 3030, 'fal', true],
  );
  assert.equal(a.song.request.prompt.length, 2000);
  assert.deepEqual(Object.keys(a.song.request).sort(), ['bpm', 'durationSec', 'genre', 'lyrics', 'mood', 'prompt', 'structure']);
  assert.equal(a.song.request.bpm, 80);
  // the same file name again (another folder): a distinct id
  const b = lib.addSong(a.data, { result: result('/other/20261105-1-雨夜小憩.mp3'), speciesId: 'grok', now: 2000 });
  assert.equal(b.song.id, '20261105-1-雨夜小憩.mp3#2');
  assert.equal(b.song.kind, 'chat');
  // per character, newest first
  assert.deepEqual(lib.songsOf(b.data, 'claude').map((s) => s.id), ['20261105-1-雨夜小憩.mp3']);
  assert.deepEqual(lib.songsOf(b.data).map((s) => s.speciesId), ['grok', 'claude']);
});

test('addSong refuses what is not a song of hers: no file, a relative path, not audio, no character', () => {
  for (const [r, sp] of [[{}, 'claude'], [result('m/a.mp3'), 'claude'], [result('/m/a.txt'), 'claude'], [result('/m/a.mp3'), '']]) {
    const x = lib.addSong(null, { result: r, speciesId: sp });
    assert.equal(x.song, null);
    assert.equal(x.data.songs.length, 0);
  }
});

test('renameSong changes the title only (1–60 chars); removeSong drops the entry; a broken file loads as empty', () => {
  const a = lib.addSong(null, { result: result('/m/a.mp3'), speciesId: 'claude', now: 1 });
  const r = lib.renameSong(a.data, a.song.id, `  ${'新'.repeat(80)}  `);
  assert.equal(r.song.title, '新'.repeat(60));
  assert.equal(r.song.filePath, '/m/a.mp3');
  assert.equal(lib.renameSong(a.data, a.song.id, '   '), null);
  assert.equal(lib.renameSong(a.data, 'nope', 'x'), null);
  const d = lib.removeSong(r.data, a.song.id);
  assert.equal(d.data.songs.length, 0);
  assert.equal(lib.removeSong(d.data, a.song.id), null);
  const dir = tmp('musiclib-');
  fs.writeFileSync(path.join(dir, lib.FILE), '{oops');
  assert.deepEqual(new lib.MusicLibraryStore(dir).load(), { version: 1, songs: [] });
  const st = new lib.MusicLibraryStore(dir);
  st.save(r.data);
  assert.equal(new lib.MusicLibraryStore(dir).load().songs[0].title, '新'.repeat(60));
});

test('the library keeps at most MAX_SONGS (the oldest go first)', () => {
  const songs = Array.from({ length: lib.MAX_SONGS + 2 }, (_, i) => ({ id: `${i}.mp3`, filePath: `/m/${i}.mp3`, speciesId: 'claude', createdAt: i }));
  const data = lib.addSong({ songs }, { result: result('/m/new.mp3'), speciesId: 'claude', now: 99999 }).data;
  assert.equal(data.songs.length, lib.MAX_SONGS);
  assert.equal(data.songs[0].id, '3.mp3');
  assert.equal(data.songs.at(-1).id, 'new.mp3');
});

// ---- PetService -----------------------------------------------------------------------------------------------
const SONG = (title) => ({ prompt: '轻松的 lo-fi，雨夜，钢琴', instrumental: true, title, mood: '轻松' });
// The stand-in model: a turn that offers compose_music gets one call to it (the next title), the step after the
// tool's output gets a short answer; turns without tools (greetings) get a line.
const composer = (titles) => {
  let i = 0;
  return (body) => {
    const answered = Array.isArray(body.input) && body.input.some((x) => x && x.type === 'function_call_output');
    const offered = (body.tools || []).some((x) => x.name === 'compose_music');
    if (offered && !answered) return { calls: [[`c${++i}`, 'compose_music', SONG(titles[(i - 1) % titles.length])]] };
    return { pieces: [answered ? '写好啦' : '你好'] };
  };
};

async function setup(plan) {
  const dir = tmp('petmusiclib-');
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const srv = await startFakeResponses(plan);
  const mm = await startFakeMiniMaxMusic(() => ({}));
  const lh = new LhClient({ bin: FAKE, env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const responses = new ResponsesClient({ lh, env: { LOBEHUB_SERVER: srv.url, LOBEHUB_CLI_API_KEY: 'test-key' }, readCredentials: () => null });
  const musicLibrary = new lib.MusicLibraryStore(path.join(dir, 'data'));
  const svc = new PetService({ lh, responses, music: { key: () => 'mm-test-key', userDataDir: path.join(dir, 'data'), env: { MINIMAX_MUSIC_ENDPOINT: mm.url }, allowInsecureLocal: true }, musicLibrary, store: new Store(path.join(dir, 'data')), now: () => Date.now(), rnd: () => 0.5 });
  svc.settings = { ...svc.settings, music: { ...svc.settings.music, provider: 'minimax', pollIntervalSec: 1 } };
  const changes = [];
  svc.on('music-library', (e) => changes.push(e));
  return { dir, svc, musicLibrary, changes, close: async () => { await srv.close(); await mm.close(); } };
}

test('a song she composes in the pet window goes into HER library (speciesId, kind chat, what was asked); the reply links it', async (t) => {
  const s = await setup(composer(['雨夜小憩']));
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('来段轻松的纯音乐');
  assert.equal(r.ok, true, JSON.stringify(r));
  const v = s.svc.musicLibraryView('testchan');
  assert.equal(v.songs.length, 1);
  const song = v.songs[0];
  assert.deepEqual([song.speciesId, song.kind, song.title, song.exists, song.instrumental, song.request.mood], ['testchan', 'chat', '雨夜小憩', true, true, '轻松']);
  assert.equal(song.filePath, r.music[0].filePath);
  assert.equal(r.music[0].libraryId, song.id);
  assert.equal(s.svc.log.list().filter((m) => m.role === 'pet').at(-1).attachments.music[0].libraryId, song.id);
  assert.deepEqual(s.changes.map((e) => [e.speciesId, e.change]), [['testchan', 'added']]);
  // written to <userData>/music-library.json
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', lib.FILE), 'utf8')).songs.length, 1);
  // another character has none
  assert.equal(s.svc.musicLibraryView('claude').songs.length, 0);
});

test('settings window 聊天 (chatAs): the song is hers too, kind console; two characters keep separate libraries', async (t) => {
  const s = await setup(composer(['她的第一首', '另一位的歌']));
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const a = await s.svc.chatAs('testchan', { text: '写首歌' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal((await s.svc.switchCharacter('claude', { name: '小克' })).ok, true);
  const other = { id: 'claude' };
  const b = await s.svc.chatAs(other.id, { text: '你也写一首' });
  assert.equal(b.ok, true, JSON.stringify(b));
  const mine = s.svc.musicLibraryView('testchan').songs;
  const hers = s.svc.musicLibraryView(other.id).songs;
  assert.deepEqual(mine.map((x) => [x.title, x.kind]), [['她的第一首', 'console']]);
  assert.deepEqual(hers.map((x) => [x.title, x.speciesId]), [['另一位的歌', other.id]]);
  assert.equal(s.svc.musicLibraryView().songs.length, 2);
});

test('rename (title only, the file keeps its name), delete (entry + file), a file removed outside the app shows exists:false', async (t) => {
  const s = await setup(composer(['第1首', '第2首']));
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  await s.svc.chat('写首歌');
  await s.svc.chat('再写一首');
  const [newer, older] = s.svc.musicLibraryView('testchan').songs;
  assert.ok(newer.createdAt >= older.createdAt);

  const rn = s.svc.renameSong({ id: older.id, title: ' 改个名 ' });
  assert.equal(rn.ok, true);
  assert.equal(rn.song.title, '改个名');
  assert.equal(fs.existsSync(older.filePath), true, 'the file is not renamed');
  // 聊天记录 shows the song as it is now: the new title (the line keeps its words)
  const historySongs = () => s.svc.history().sessions.flatMap((x) => s.svc.historySession(x.id).session.messages).flatMap((m) => (m.attachments && m.attachments.music) || []);
  const before = historySongs();
  assert.deepEqual(before.map((m) => [m.title, !!m.missing]).sort(), [['改个名', false], ['第2首', false]]);
  assert.deepEqual(s.svc.renameSong({ id: older.id, title: '' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(s.svc.renameSong({ id: 'nope', title: 'x' }), { ok: false, reason: 'missing' });

  fs.unlinkSync(newer.filePath);
  assert.equal(s.svc.musicLibraryView('testchan').songs.find((x) => x.id === newer.id).exists, false);
  // deleting one whose file is already gone just drops the entry
  assert.deepEqual(s.svc.deleteSong({ id: newer.id }), { ok: true, id: newer.id });
  const del = s.svc.deleteSong({ id: older.id });
  assert.equal(del.ok, true);
  assert.equal(fs.existsSync(older.filePath), false, 'the audio file is deleted');
  assert.equal(s.svc.musicLibraryView('testchan').songs.length, 0);
  assert.deepEqual(s.svc.deleteSong({ id: older.id }), { ok: false, reason: 'missing' });
  // …and missing once the file is gone
  const after = historySongs();
  assert.equal(after.length, 2);
  assert.ok(after.every((m) => m.missing === true));
  assert.deepEqual(s.changes.map((e) => e.change), ['added', 'added', 'renamed', 'deleted', 'deleted']);
});

test('isLibrarySong: a song saved before 保存目录 changed may still be played; any other file may not', async (t) => {
  const s = await setup(composer(['旧目录的歌']));
  t.after(s.close);
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('写首歌');
  const file = r.music[0].filePath;
  const moved = tmp('newmusicdir-');
  s.svc.settings = { ...s.svc.settings, music: { ...s.svc.settings.music, outputDir: moved } };
  assert.equal(s.svc.musicDir(), moved);
  assert.equal(s.svc.isLibrarySong(fs.realpathSync(file)), true);
  const stray = path.join(moved, '..', 'stray.mp3');
  fs.writeFileSync(stray, 'x');
  assert.equal(s.svc.isLibrarySong(fs.realpathSync(stray)), false);
});

test('a library that cannot be written does not cost the song: it is still shown with the reply; an error is reported', async (t) => {
  const s = await setup(composer(['照样能听']));
  t.after(s.close);
  s.svc.songStore = { load: () => ({ songs: [] }), save: () => { throw new Error('disk full'); } };
  const errors = [];
  s.svc.on('error', (e) => errors.push(e));
  await s.svc.hatch({ speciesId: 'testchan', name: 'E' });
  const r = await s.svc.chat('写首歌');
  assert.equal(r.ok, true);
  assert.equal(r.music.length, 1);
  assert.equal(r.music[0].libraryId, undefined);
  assert.ok(errors.some((e) => e.code === 'EMUSICLIB'));
});
