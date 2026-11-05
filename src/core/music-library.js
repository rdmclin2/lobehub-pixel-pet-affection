'use strict';

// 她的音乐库 (T-5088 follow-up, docs/music.md): every song compose_music saved, with who made it. The audio files stay
// where core/music.js wrote them (<userData>/music/ or 设置 → 音乐创作 → 保存目录); this index, <userData>/
// music-library.json, remembers for each one the character who composed it (speciesId: one character per look,
// T-2764), when, in which round, and what was asked (prompt, lyrics, genre, …), so 角色详情 → 音乐 can list hers
// and the windows may still play a song after the save folder was changed.
//
// A song: { id, filePath, title, speciesId, createdAt, durationMs, format, instrumental, provider, model, kind,
//   turnId, request: { prompt, lyrics, genre, mood, scene, instruments, vocals, bpm, durationSec, structure } }
// `kind`: where she made it — 'chat' (the pet window) or 'console' (设置窗口 → 聊天).

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'music-library.json';
const MAX_SONGS = 2000;
const TITLE_MAX = 60;
const REQUEST_TEXT = { prompt: 2000, lyrics: 3500, genre: 80, mood: 80, scene: 120, instruments: 120, vocals: 80 };
const FORMATS = ['mp3', 'wav', 'pcm'];

const EMPTY = () => ({ version: 1, songs: [] });
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);

// What was asked, kept short: only the fields compose_music takes.
function cleanRequest(r) {
  if (!r || typeof r !== 'object') return {};
  const out = {};
  for (const [k, max] of Object.entries(REQUEST_TEXT)) {
    const s = str(r[k], max);
    if (s) out[k] = s;
  }
  if (num(r.bpm) !== null) out.bpm = num(r.bpm);
  if (num(r.durationSec) !== null) out.durationSec = num(r.durationSec);
  if (Array.isArray(r.structure)) {
    const s = r.structure.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, 20)).slice(0, 20);
    if (s.length) out.structure = s;
  }
  return out;
}

function cleanSong(s) {
  if (!s || typeof s !== 'object') return null;
  const id = str(s.id, 200);
  const filePath = typeof s.filePath === 'string' ? s.filePath : '';
  const speciesId = str(s.speciesId, 120);
  if (!id || !filePath || !path.isAbsolute(filePath) || !speciesId) return null;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!FORMATS.includes(ext)) return null;
  return {
    id,
    filePath,
    title: str(s.title, TITLE_MAX),
    speciesId,
    createdAt: num(s.createdAt) || 0,
    durationMs: num(s.durationMs),
    format: FORMATS.includes(s.format) ? s.format : ext,
    instrumental: !!s.instrumental,
    provider: str(s.provider, 40) || null,
    model: str(s.model, 120) || null,
    kind: s.kind === 'console' ? 'console' : 'chat',
    turnId: str(s.turnId, 120) || null,
    request: cleanRequest(s.request),
  };
}

function normalizeLibrary(data) {
  const songs = data && Array.isArray(data.songs) ? data.songs.map(cleanSong).filter(Boolean) : [];
  const seen = new Set();
  const unique = songs.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));
  return { version: 1, songs: unique.slice(-MAX_SONGS) };
}

// A new song (core/music.js generateMusic's result + who / where / what was asked). Its id is the file name, made
// unique within the library. -> { data, song }
function addSong(data, { result, speciesId, kind = 'chat', turnId = null, request = null, now = Date.now() }) {
  const lib = normalizeLibrary(data);
  const meta = (result && result.meta) || {};
  const base = result && result.filePath ? path.basename(result.filePath) : '';
  let id = base;
  for (let i = 2; lib.songs.some((s) => s.id === id); i++) id = `${base}#${i}`;
  const song = cleanSong({
    id,
    filePath: result && result.filePath,
    title: meta.title || (request && request.title) || '',
    speciesId,
    createdAt: now,
    durationMs: result && result.durationMs,
    format: meta.format,
    instrumental: meta.instrumental,
    provider: meta.provider,
    model: meta.model,
    kind,
    turnId,
    request,
  });
  if (!song) return { data: lib, song: null };
  return { data: normalizeLibrary({ songs: [...lib.songs, song] }), song };
}

const songsOf = (data, speciesId) => normalizeLibrary(data).songs.filter((s) => !speciesId || s.speciesId === speciesId).sort((a, b) => b.createdAt - a.createdAt);
const findSong = (data, id) => normalizeLibrary(data).songs.find((s) => s.id === id) || null;

// Only the title changes: the file keeps its name (other places — 聊天记录 — point at it). -> { data, song } | null
function renameSong(data, id, title) {
  const lib = normalizeLibrary(data);
  const t = str(title, TITLE_MAX);
  const i = lib.songs.findIndex((s) => s.id === id);
  if (i < 0 || !t) return null;
  const song = { ...lib.songs[i], title: t };
  lib.songs[i] = song;
  return { data: lib, song };
}

function removeSong(data, id) {
  const lib = normalizeLibrary(data);
  const song = lib.songs.find((s) => s.id === id);
  if (!song) return null;
  return { data: { ...lib, songs: lib.songs.filter((s) => s.id !== id) }, song };
}

class MusicLibraryStore {
  constructor(dir) {
    this.file = path.join(dir, FILE);
    fs.mkdirSync(dir, { recursive: true });
  }
  load() {
    try {
      return normalizeLibrary(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return EMPTY();
    }
  }
  save(data) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeLibrary(data), null, 2));
    fs.renameSync(tmp, this.file);
  }
}

class MemoryMusicLibraryStore {
  constructor(initial = null) {
    this.data = initial;
  }
  load() {
    return normalizeLibrary(this.data);
  }
  save(data) {
    this.data = normalizeLibrary(data);
  }
}

module.exports = { FILE, MAX_SONGS, TITLE_MAX, normalizeLibrary, cleanRequest, addSong, songsOf, findSong, renameSong, removeSong, MusicLibraryStore, MemoryMusicLibraryStore };
