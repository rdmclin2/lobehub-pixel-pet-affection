'use strict';

// 表情包集合 (docs/stickers-design.md §2): every character (speciesId — the same id as her 聊天记录 and agent)
// holds an ordered list of sticker sets: her own built-in memes (`builtin:<speciesId>`, made at run time from
// her character file, read-only, never written to disk) and the owner's own set (`mine-<speciesId>`, pictures
// the owner imported: add several at once, delete). Store sets come later (§5).
//
// On disk, under <userData>/stickers/:
//   sets/<setId>.json      one `mine` set: its stickers in grid order
//   blobs/<sha256>.<ext>   every imported picture, content-addressed (the same picture is stored once)
// A removed sticker leaves its blob behind (a chat message may still show it); gc() drops the blobs nothing
// refers to any more.
//
// No Electron here: the main process (src/main/stickers.js) adds the file dialog and the sticker:// protocol.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA = 1;
const MAX_STICKER_BYTES = 2 * 1024 * 1024;
const MIN_SIDE = 64;
const MAX_SIDE = 1024;
const MAX_RATIO = 4;
const MAX_PER_SET = 120;
const MAX_MINE_TOTAL = 500;
const MAX_LABEL = 20;
const MAX_DESC = 60;
const ID_RE = /^[a-z0-9_-]{1,40}$/; // the same as species.js MEME_ID_RE: the id goes into [梗图:<id>]
const SPECIES_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
const BLOB_RE = /^[0-9a-f]{64}\.(png|webp|gif|jpg)$/;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const bad = (reason, message) => ({ ok: false, reason, message });
const MB = (n) => `${Math.round(n / 1024 / 1024)} MB`;

// ---- what a picture is -----------------------------------------------------------------------------------
// Type by content (a renamed file is still found out), its size from the header, and whether it moves. No
// image library: PNG IHDR, GIF logical screen, WebP VP8X / VP8 / VP8L, JPEG SOFn.
function imageInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    const idat = buf.indexOf('IDAT');
    const actl = buf.indexOf('acTL');
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), animated: actl > 0 && (idat < 0 || actl < idat) };
  }
  if (buf.toString('ascii', 0, 4) === 'GIF8') {
    let frames = 0;
    for (let i = buf.indexOf(Buffer.from([0x21, 0xf9, 0x04])); i >= 0 && frames < 2; i = buf.indexOf(Buffer.from([0x21, 0xf9, 0x04]), i + 3)) frames++;
    return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), animated: frames > 1 };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X' && buf.length >= 30) return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), animated: !!(buf[20] & 0x02) };
    if (kind === 'VP8 ' && buf.length >= 30) return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, animated: false };
    if (kind === 'VP8L' && buf.length >= 25) {
      const b = buf.subarray(21, 25);
      return { mime: 'image/webp', width: 1 + (b[0] | ((b[1] & 0x3f) << 8)), height: 1 + ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)), animated: false };
    }
    return null;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), animated: false };
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// One picture to import: is it a sticker? -> { ok, info } or { ok: false, reason, message } in words the
// management page lists one by one. reason: 'too-large' | 'bad-type' | 'too-small' | 'too-big' | 'bad-ratio'.
function checkImage(buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) return bad('bad-type', '不是图片');
  if (buf.length > MAX_STICKER_BYTES) return bad('too-large', `超过 ${MB(MAX_STICKER_BYTES)}`);
  const info = imageInfo(buf);
  if (!info || !info.width || !info.height) return bad('bad-type', '不是 PNG、JPG、WebP 或 GIF 图片');
  if (Math.min(info.width, info.height) < MIN_SIDE) return bad('too-small', `尺寸太小（${info.width}×${info.height}，边长至少 ${MIN_SIDE} px）`);
  if (Math.max(info.width, info.height) > MAX_SIDE) return bad('too-big', `尺寸太大（${info.width}×${info.height}，边长最多 ${MAX_SIDE} px）`);
  if (Math.max(info.width, info.height) / Math.min(info.width, info.height) > MAX_RATIO) return bad('bad-ratio', `太细长了（宽高比不能超过 ${MAX_RATIO}:1）`);
  return { ok: true, info };
}

// The default label: the file name without its extension, tidied, at most MAX_LABEL characters.
function labelFromName(name) {
  const base = path.basename(String(name || '')).replace(/\.[a-z0-9]{1,5}$/i, '');
  const s = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[_\s]+/g, ' ').trim().slice(0, MAX_LABEL);
  return s || '表情包';
}

const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const blobUrl = (blob) => `sticker://blob/${blob}`;
const builtinUrl = (speciesId, id) => `sticker://builtin/${speciesId}/${id}.webp`;
const mineId = (speciesId) => `mine-${speciesId}`;
const builtinId = (speciesId) => `builtin:${speciesId}`;

// A character's built-in memes as a read-only set (§2.4): the pictures stay in src/renderer/assets/memes/.
function builtinSet(species) {
  const memes = species && Array.isArray(species.memes) ? species.memes : [];
  return {
    id: builtinId(species.id),
    kind: 'builtin',
    name: '内置',
    readOnly: true,
    stickers: memes.map((m) => ({ id: m.id, label: m.label, desc: m.desc, url: builtinUrl(species.id, m.id), builtin: `${species.id}/${m.id}.webp`, animated: false })),
  };
}

class StickerLibrary {
  // `dir`: <userData>/stickers. `now`: for addedAt (tests pass a clock).
  constructor(dir, { now = () => Date.now() } = {}) {
    this.dir = dir;
    this.setsDir = path.join(dir, 'sets');
    this.blobsDir = path.join(dir, 'blobs');
    this.now = now;
  }

  _setFile(setId) { return path.join(this.setsDir, `${setId}.json`); }

  // The owner's set for this character, as stored; an empty one when there is none (or it cannot be read).
  _readMine(speciesId) {
    const empty = { schema: SCHEMA, id: mineId(speciesId), kind: 'mine', name: '我的', forSpecies: speciesId, seq: 0, stickers: [] };
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this._setFile(mineId(speciesId)), 'utf8'));
    } catch {
      return empty;
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.stickers)) return empty;
    const stickers = raw.stickers.filter((s) => s && ID_RE.test(s.id || '') && BLOB_RE.test(s.blob || '') && typeof s.label === 'string');
    return { ...empty, ...raw, id: empty.id, kind: 'mine', seq: Number.isInteger(raw.seq) ? raw.seq : stickers.length, stickers };
  }

  // Written to a temporary file first and renamed into place: a crash mid-write never leaves half a set.
  _writeMine(set) {
    fs.mkdirSync(this.setsDir, { recursive: true });
    const file = this._setFile(set.id);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(set, null, 2));
    fs.renameSync(tmp, file);
  }

  _sticker(s) {
    return { id: s.id, label: s.label, desc: s.desc || '', url: blobUrl(s.blob), blob: s.blob, mime: s.mime, bytes: s.bytes, width: s.width, height: s.height, animated: !!s.animated, addedAt: s.addedAt };
  }

  // Her sets, in panel order: built-in (when her file has memes), then the owner's own.
  // -> { ok, speciesId, sets: [{ id, kind, name, readOnly, stickers: [...] }], limits }
  list(species) {
    if (!species || !SPECIES_RE.test(species.id || '')) return bad('bad-species', '没有这位角色');
    const sets = [];
    const b = builtinSet(species);
    if (b.stickers.length) sets.push(b);
    const mine = this._readMine(species.id);
    sets.push({ id: mine.id, kind: 'mine', name: mine.name, readOnly: false, stickers: mine.stickers.map((s) => this._sticker(s)) });
    return { ok: true, speciesId: species.id, sets, limits: { maxBytes: MAX_STICKER_BYTES, minSide: MIN_SIDE, maxSide: MAX_SIDE, perSet: MAX_PER_SET } };
  }

  // What she may pick from for [梗图:<id>] (core/memes.js): built-in first, then the owner's — every id unique,
  // so an unprefixed tag means one picture. `url`: what the pet window shows (built-in from its own assets).
  catalog(species) {
    if (!species) return [];
    const builtin = (Array.isArray(species.memes) ? species.memes : []).map((m) => ({ id: m.id, label: m.label, desc: m.desc, url: `assets/memes/${species.id}/${m.id}.webp` }));
    if (!SPECIES_RE.test(species.id || '')) return builtin;
    const seen = new Set(builtin.map((m) => m.id));
    const mine = this._readMine(species.id).stickers.filter((s) => !seen.has(s.id)).map((s) => ({ id: s.id, label: s.label, desc: s.desc || s.label, url: blobUrl(s.blob) }));
    return [...builtin, ...mine];
  }

  _totalMine() {
    let n = 0;
    let files = [];
    try { files = fs.readdirSync(this.setsDir); } catch { return 0; }
    for (const f of files) {
      if (!/^mine-.+\.json$/.test(f)) continue;
      try { n += (JSON.parse(fs.readFileSync(path.join(this.setsDir, f), 'utf8')).stickers || []).length; } catch { /* unreadable: counts as empty */ }
    }
    return n;
  }

  // Add pictures to her own set. `files`: [{ buffer, name }] (main reads the paths the dialog picked).
  // Each one is checked on its own: the good ones are added in the order given, the others come back with
  // why. -> { ok, added: [sticker], rejected: [{ name, reason, message }], set }
  add(species, files) {
    if (!species || !SPECIES_RE.test(species.id || '')) return bad('bad-species', '没有这位角色');
    if (!Array.isArray(files) || !files.length) return bad('bad-input', '没有选择图片');
    const set = this._readMine(species.id);
    const taken = new Set([...(species.memes || []).map((m) => m.id), ...set.stickers.map((s) => s.id)]);
    const inSet = new Set(set.stickers.map((s) => s.blob));
    let total = this._totalMine();
    const added = [];
    const rejected = [];
    for (const f of files) {
      const name = path.basename(String((f && f.name) || '图片')).slice(0, 120);
      if (f && f.error) { rejected.push({ name, reason: f.error.reason || 'bad-input', message: f.error.message || '读不了这个文件' }); continue; }
      const c = checkImage(f && f.buffer);
      if (!c.ok) { rejected.push({ name, reason: c.reason, message: c.message }); continue; }
      if (set.stickers.length >= MAX_PER_SET) { rejected.push({ name, reason: 'set-full', message: `这组表情包已经有 ${MAX_PER_SET} 张了` }); continue; }
      if (total >= MAX_MINE_TOTAL) { rejected.push({ name, reason: 'all-full', message: `「我的」表情包合计最多 ${MAX_MINE_TOTAL} 张` }); continue; }
      const ext = EXT[c.info.mime];
      const blob = `${crypto.createHash('sha256').update(f.buffer).digest('hex')}.${ext}`;
      if (inSet.has(blob)) { rejected.push({ name, reason: 'duplicate', message: '这张已经在她的表情包里了' }); continue; }
      fs.mkdirSync(this.blobsDir, { recursive: true });
      const file = path.join(this.blobsDir, blob);
      if (!fs.existsSync(file)) fs.writeFileSync(file, f.buffer);
      let id;
      do id = `u${(++set.seq).toString(36)}`; while (taken.has(id));
      taken.add(id);
      inSet.add(blob);
      const label = cleanText(f.label, MAX_LABEL) || labelFromName(name);
      const s = { id, label, desc: cleanText(f.desc, MAX_DESC), blob, mime: c.info.mime, bytes: f.buffer.length, width: c.info.width, height: c.info.height, animated: !!c.info.animated, addedAt: this.now() };
      set.stickers.push(s);
      added.push(this._sticker(s));
      total++;
    }
    if (added.length) this._writeMine(set);
    return { ok: added.length > 0, ...(added.length ? {} : { reason: 'all-rejected', message: '没有可以添加的图片' }), added, rejected, count: set.stickers.length };
  }

  // Delete stickers from her own set by id. Built-in ones cannot be deleted. The blobs stay until gc().
  remove(species, ids) {
    if (!species || !SPECIES_RE.test(species.id || '')) return bad('bad-species', '没有这位角色');
    const want = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    if (!want.size) return bad('bad-input', '没有选择要删除的表情包');
    const set = this._readMine(species.id);
    const keep = set.stickers.filter((s) => !want.has(s.id));
    const removed = set.stickers.length - keep.length;
    if (!removed) return bad('not-found', '这张表情包已经不在了');
    set.stickers = keep;
    this._writeMine(set);
    return { ok: true, removed, count: keep.length };
  }

  // Rename a sticker or say when she should use it.
  update(species, id, { label, desc } = {}) {
    if (!species || !SPECIES_RE.test(species.id || '')) return bad('bad-species', '没有这位角色');
    const set = this._readMine(species.id);
    const s = set.stickers.find((x) => x.id === String(id));
    if (!s) return bad('not-found', '这张表情包已经不在了');
    if (label !== undefined) {
      const l = cleanText(label, MAX_LABEL);
      if (!l) return bad('bad-label', '名称不能为空');
      s.label = l;
    }
    if (desc !== undefined) s.desc = cleanText(desc, MAX_DESC);
    this._writeMine(set);
    return { ok: true, sticker: this._sticker(s) };
  }

  // The file behind sticker://blob/<name>; null for anything that is not a stored picture's name.
  blobPath(name) {
    if (!BLOB_RE.test(String(name || ''))) return null;
    const file = path.join(this.blobsDir, name);
    return path.dirname(file) === this.blobsDir && fs.existsSync(file) ? file : null;
  }

  // Delete the blobs no set refers to and `keep` (names still shown somewhere, e.g. in 聊天记录) does not
  // list. -> the names deleted.
  gc(keep = []) {
    const used = new Set(keep);
    let files = [];
    try { files = fs.readdirSync(this.setsDir); } catch { /* no sets */ }
    for (const f of files) {
      if (!/\.json$/.test(f)) continue;
      try { for (const s of JSON.parse(fs.readFileSync(path.join(this.setsDir, f), 'utf8')).stickers || []) used.add(s.blob); } catch { return []; } // unreadable set: delete nothing
    }
    const gone = [];
    let blobs = [];
    try { blobs = fs.readdirSync(this.blobsDir); } catch { return gone; }
    for (const b of blobs) {
      if (!BLOB_RE.test(b) || used.has(b)) continue;
      fs.rmSync(path.join(this.blobsDir, b), { force: true });
      gone.push(b);
    }
    return gone;
  }
}

module.exports = {
  StickerLibrary,
  imageInfo,
  checkImage,
  labelFromName,
  builtinSet,
  blobUrl,
  builtinUrl,
  BLOB_RE,
  ID_RE,
  MAX_STICKER_BYTES,
  MIN_SIDE,
  MAX_SIDE,
  MAX_PER_SET,
  MAX_MINE_TOTAL,
};
