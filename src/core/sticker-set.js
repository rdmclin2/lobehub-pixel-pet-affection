'use strict';

// 表情包集合 zip (docs/stickers-design.md §5.3): the one format a set travels in — 商店 → 表情包 downloads it, the
// maintainer's scripts/publish-sticker-set.mjs writes it.
//
//   <set>.zip
//   ├── sticker-set.json   { schema: 1, id, name, description, author, license, version, forSpecies?, cover,
//   │                        stickers: [{ id, label, desc, file, width, height, animated }] }
//   └── stickers/<id>.<ext>
//
// The checks are those of importing a pack (core/packs.js) and of adding a picture (core/stickers.js checkImage):
// at most MAX_PER_SET pictures, each at most 2 MB and checked by its content (a renamed file is found out),
// MAX_SET_BYTES for all of them; every `file` inside stickers/ (no `..`, no absolute path, no link, no folder
// elsewhere, nothing the manifest does not name); `license` and `author` required.
//
// The zip is read here in JS (no unzip binary): every entry's name and declared size is checked before a byte
// is inflated, so a hostile archive (a path out of the folder, a zip bomb, a symlink) is refused, never
// written. Electron-free; the tests and the publish script require() it.

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { checkImage, ID_RE, MAX_STICKER_BYTES, MAX_PER_SET } = require('./stickers');

const SET_SCHEMA = 1;
const MANIFEST = 'sticker-set.json';
const SET_ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const SPECIES_RE = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;
const VER_RE = /^\d+\.\d+\.\d+$/;
const FILE_RE = /^stickers\/([a-z0-9_-]{1,40})\.(png|webp|gif|jpg|jpeg)$/;
const MAX_SET_BYTES = 60 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ENTRIES = MAX_PER_SET + 8;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
// what Finder / Explorer add when someone zips a folder by hand: skipped, never unpacked
const JUNK_RE = /^(__MACOSX\/|.*(^|\/)\.DS_Store$|.*(^|\/)Thumbs\.db$)/;

// what a set put on the community shelf may be licensed under (上架到商店, T-10796): the app's form offers these,
// the sticker market accepts only these
const COMMUNITY_LICENSES = ['CC BY 4.0', 'CC BY-NC 4.0', 'CC BY-NC-SA 4.0', 'CC0 1.0', '仅限个人使用，禁止商用'];

const fail = (reason, errors) => ({ ok: false, reason, errors: Array.isArray(errors) ? errors : [errors] });
const MB = (n) => `${Math.round(n / 1024 / 1024)} MB`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- reading a zip ---------------------------------------------------------------------------------------
// Only what a set needs: stored (0) or deflated (8) entries, no encryption, no zip64, no multi-disk.
// A name is refused when it could land outside the folder it is unpacked into.
function badName(name) {
  if (!name || name.length > 200) return 'empty or too long';
  if (name.includes('\\') || name.includes('\u0000')) return 'has a backslash or NUL';
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) return 'is an absolute path';
  if (name.split('/').some((p) => p === '..' || p === '.')) return 'has a . or .. segment';
  return null;
}

// -> { ok, entries: [{ name, data }] } | { ok: false, reason, errors }
function readZip(buf, { maxEntries = MAX_ENTRIES, maxEntryBytes = MAX_STICKER_BYTES, maxTotal = MAX_SET_BYTES, sizeOf = () => null } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return fail('bad-zip', 'not a zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return fail('bad-zip', 'not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt16LE(eocd + 4) !== 0 || count === 0xffff || cdOffset === 0xffffffff) return fail('bad-zip', 'multi-disk or zip64 archives are not supported');
  if (cdOffset + cdSize > eocd) return fail('bad-zip', 'the central directory is out of range');
  if (count > maxEntries) return fail('too-many', `more than ${maxEntries} files in the zip`);
  const entries = [];
  const seen = new Set();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) return fail('bad-zip', 'broken central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const why = badName(name);
    if (why) return fail('bad-path', `${JSON.stringify(name)} ${why}`);
    if (JUNK_RE.test(name)) continue;
    if (((attrs >>> 16) & 0o170000) === 0o120000) return fail('bad-path', `${name} is a symbolic link`);
    if (name.endsWith('/')) {
      if (name !== 'stickers/') return fail('stray-file', `unexpected folder ${name}`);
      continue;
    }
    if (flags & 0x1) return fail('bad-zip', `${name} is encrypted`);
    if (method !== 0 && method !== 8) return fail('bad-zip', `${name}: compression method ${method} is not supported`);
    if (seen.has(name)) return fail('bad-zip', `${name} is in the zip twice`);
    seen.add(name);
    const limit = sizeOf(name) ?? maxEntryBytes;
    if (usize > limit) return fail('too-large', `${name} is ${MB(usize)} (at most ${MB(limit)})`);
    total += usize;
    if (total > maxTotal) return fail('too-large', `the pictures add up to more than ${MB(maxTotal)}`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return fail('bad-zip', `${name}: broken local header`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) return fail('bad-zip', `${name} is cut off`);
    const raw = buf.subarray(start, start + csize);
    let data;
    try {
      data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) });
    } catch (e) {
      return fail('bad-zip', `${name}: ${String(e.message).slice(0, 120)}`);
    }
    if (data.length !== usize || (zlib.crc32(data) >>> 0) !== crc) return fail('bad-zip', `${name}: size or CRC does not match`);
    entries.push({ name, data });
  }
  return { ok: true, entries };
}

// ---- writing a zip ---------------------------------------------------------------------------------------
// Reproducible: the entries in the order given, a fixed date, deflate level 9 — the same set gives the same
// bytes, so the same sha256 (the catalog's).
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(stored ? 0 : 8, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(stored ? 0 : 8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, body);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- the manifest ----------------------------------------------------------------------------------------
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '').slice(0, max);

// sticker-set.json as written by a maintainer -> { ok, manifest } with every field cleaned | errors
function checkManifest(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('bad-manifest', `${MANIFEST} is not a JSON object`);
  if (raw.schema !== SET_SCHEMA) errors.push(`schema must be ${SET_SCHEMA}`);
  if (!SET_ID_RE.test(String(raw.id || ''))) errors.push('id must be 3–40 characters of a-z, 0-9 and -');
  const name = text(raw.name, 30);
  if (!name) errors.push('name is required');
  const author = text(raw.author, 120);
  if (!author) errors.push('author is required');
  const license = text(raw.license, 120);
  if (!license) errors.push('license is required');
  const version = raw.version === undefined ? '1.0.0' : String(raw.version);
  if (!VER_RE.test(version)) errors.push('version must look like 1.0.0');
  if (raw.forSpecies !== undefined && (!Array.isArray(raw.forSpecies) || raw.forSpecies.some((s) => !SPECIES_RE.test(String(s))))) errors.push('forSpecies must be a list of character ids');
  const list = Array.isArray(raw.stickers) ? raw.stickers : null;
  if (!list || !list.length) errors.push('stickers must list at least one picture');
  else if (list.length > MAX_PER_SET) errors.push(`at most ${MAX_PER_SET} stickers in a set (this one has ${list.length})`);
  const ids = new Set();
  const files = new Set();
  const stickers = [];
  (list || []).slice(0, MAX_PER_SET).forEach((s, i) => {
    const id = s && String(s.id || '');
    if (!s || !ID_RE.test(id)) { errors.push(`stickers[${i}]: id must be 1–40 characters of a-z, 0-9, _ and -`); return; }
    if (ids.has(id)) { errors.push(`stickers[${i}]: duplicate id ${id}`); return; }
    ids.add(id);
    const label = text(s.label, 20);
    if (!label) errors.push(`stickers[${i}] (${id}): label is required`);
    const file = String(s.file || '');
    if (!FILE_RE.test(file)) errors.push(`stickers[${i}] (${id}): file must be stickers/<name>.png|webp|gif|jpg (got ${JSON.stringify(file).slice(0, 80)})`);
    else if (files.has(file)) errors.push(`stickers[${i}] (${id}): ${file} is used twice`);
    files.add(file);
    stickers.push({ id, label, desc: text(s.desc, 60), file });
  });
  const cover = raw.cover === undefined ? (stickers[0] && stickers[0].id) : String(raw.cover);
  if (stickers.length && !ids.has(cover)) errors.push('cover must be the id of one of the stickers');
  if (errors.length) return fail('bad-manifest', errors);
  return {
    ok: true,
    manifest: {
      schema: SET_SCHEMA, id: raw.id, name, description: text(raw.description, 200), author, license, version,
      ...(Array.isArray(raw.forSpecies) && raw.forSpecies.length ? { forSpecies: [...new Set(raw.forSpecies.map(String))] } : {}),
      cover, stickers,
    },
  };
}

// A whole set zip -> { ok, manifest, stickers: [{ id, label, desc, file, buffer, info, sha256 }], bytes }
// | { ok: false, reason, errors }. reason: bad-zip | bad-path | stray-file | too-many | too-large | bad-manifest |
// bad-image | missing-file.
function validateSetZip(buf) {
  const z = readZip(buf, { sizeOf: (name) => (name === MANIFEST ? MAX_MANIFEST_BYTES : null) });
  if (!z.ok) return z;
  const byName = new Map(z.entries.map((e) => [e.name, e.data]));
  const mBuf = byName.get(MANIFEST);
  if (!mBuf) return fail('bad-manifest', `the zip has no ${MANIFEST} at its top level`);
  let raw;
  try { raw = JSON.parse(mBuf.toString('utf8')); } catch (e) { return fail('bad-manifest', `${MANIFEST} is not JSON: ${String(e.message).slice(0, 120)}`); }
  const m = checkManifest(raw);
  if (!m.ok) return m;
  const named = new Set([MANIFEST, ...m.manifest.stickers.map((s) => s.file)]);
  for (const name of byName.keys()) if (!named.has(name)) return fail('stray-file', `${name} is in the zip but not in ${MANIFEST}`);
  const errors = [];
  const stickers = [];
  let bytes = 0;
  for (const s of m.manifest.stickers) {
    const data = byName.get(s.file);
    if (!data) { errors.push(`${s.file} (${s.id}) is missing from the zip`); continue; }
    const c = checkImage(data);
    if (!c.ok) { errors.push(`${s.file} (${s.id}): ${c.message}`); continue; }
    bytes += data.length;
    stickers.push({ ...s, buffer: data, info: c.info, sha256: sha256(data), ext: EXT[c.info.mime] });
  }
  if (errors.length) return fail(errors.some((e) => /missing/.test(e)) ? 'missing-file' : 'bad-image', errors);
  // width / height / animated as the pictures are, not as the manifest says
  const manifest = { ...m.manifest, stickers: stickers.map((s) => ({ id: s.id, label: s.label, desc: s.desc, file: s.file, width: s.info.width, height: s.info.height, animated: !!s.info.animated })) };
  return { ok: true, manifest, stickers, bytes };
}

// Pack a set from its pictures: { manifest (without stickers[].file / sizes), stickers: [{ id, label, desc,
// buffer }] } -> { ok, zip, manifest, stickers } — validated exactly as the app will validate the download.
function packSet(meta, pictures) {
  const files = [];
  const list = [];
  for (const p of pictures) {
    const c = checkImage(p.buffer);
    if (!c.ok) return fail('bad-image', `${p.id}: ${c.message}`);
    const file = `stickers/${p.id}.${EXT[c.info.mime]}`;
    list.push({ id: p.id, label: p.label, desc: p.desc || '', file, width: c.info.width, height: c.info.height, animated: !!c.info.animated });
    files.push({ name: file, data: p.buffer });
  }
  const manifest = { schema: SET_SCHEMA, ...meta, stickers: list };
  const zip = buildZip([{ name: MANIFEST, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) }, ...files]);
  const v = validateSetZip(zip);
  if (!v.ok) return v;
  return { ok: true, zip, manifest: v.manifest, stickers: v.stickers };
}

module.exports = { COMMUNITY_LICENSES, SET_SCHEMA, MANIFEST, SET_ID_RE, FILE_RE, VER_RE, MAX_SET_BYTES, MAX_ENTRIES, readZip, buildZip, checkManifest, validateSetZip, packSet, sha256 };
