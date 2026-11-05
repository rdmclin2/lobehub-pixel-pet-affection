'use strict';

// 表情包商店 · 社区货架的服务端 (docs/stickers-design.md §5.2 方案 C, T-10796): where an owner's own sticker set
// goes when they press 上架到商店 in the app, and where every other install reads the community shelf from.
//
//   publish(user, zip, { id?, rightsConfirmed })   a set zip (core/sticker-set.js §5.3) from a signed-in LobeHub
//                                                  user → a new set (or a new version of their own) in review
//   review(id, 'approve' | 'reject', reason)       the maintainer's decision (先审后发, §7 Q6); `auto` approves
//   unpublish(user, id)                            the owner takes it off the shelf
//   index()                                        the published sets, in the format the app's StickerStore
//                                                  reads (core/sticker-catalog.js): one schema for both shelves
//   mine(user)                                     what this user put up, with its review state
//
// The server is the authority on what a published set is: the uploaded zip is validated exactly as the app
// validates a download, then repacked with the id, version and author the server assigns — the author is the
// LobeHub name the token belongs to, never what the zip says. Ids are `u-<owner>-<n>`, so a community set can
// never take the id of an official one. Files are content-addressed: <id>-<ver>.zip and previews/<sha256>.<ext>.
//
// State is one JSON file written atomically (tmp + rename); calls are serialised in-process. Electron-free.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SS = require('../../src/core/sticker-set');
const SC = require('../../src/core/sticker-catalog');

const RELEASE = 'stickers-v1';
const MAX_SETS_PER_USER = 20;
const LICENSES = SS.COMMUNITY_LICENSES;

const err = (status, reason, text) => ({ ok: false, status, reason, text });
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function bumpPatch(v) {
  const [a, b, c] = String(v).split('.').map(Number);
  return `${a}.${b}.${c + 1}`;
}

class StickerMarket {
  // `dir`: where db.json and files/ live. `review`: 'manual' (先审后发, default) | 'auto'. `now`: a clock.
  constructor({ dir, review = 'manual', now = () => Date.now() }) {
    this.dir = dir;
    this.filesDir = path.join(dir, 'files');
    this.dbFile = path.join(dir, 'db.json');
    this.reviewMode = review === 'auto' ? 'auto' : 'manual';
    this.now = now;
    fs.mkdirSync(path.join(this.filesDir, 'previews'), { recursive: true });
    try { this.db = JSON.parse(fs.readFileSync(this.dbFile, 'utf8')); } catch { this.db = null; }
    if (!this.db || typeof this.db !== 'object' || !this.db.sets) this.db = { schema: 1, sets: {}, owners: {} };
  }

  _save() {
    const tmp = `${this.dbFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.dbFile);
  }

  _write(name, buf) {
    const file = path.join(this.filesDir, name);
    if (fs.existsSync(file)) return;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  }

  // A published file by its name (zip or preview); null for anything else.
  filePath(name) {
    const n = String(name || '');
    if (!/^[a-z0-9][a-z0-9-]*\.zip$/.test(n) && !SC.PREVIEW_RE.test(n)) return null;
    const file = path.join(this.filesDir, n);
    return file.startsWith(this.filesDir + path.sep) && fs.existsSync(file) ? file : null;
  }

  // a short stable tag per owner (no LobeHub user id in public ids)
  _ownerTag(userId) {
    const owners = this.db.owners;
    if (!owners[userId]) owners[userId] = { tag: sha(`owner:${userId}`).slice(0, 6), seq: 0 };
    return owners[userId];
  }

  // -> { ok, id, version, status, set } | { ok: false, status, reason, text }
  publish(user, zip, { id = null, rightsConfirmed = false } = {}) {
    if (!user || !user.id) return err(401, 'auth', '请先登录 LobeHub');
    if (!rightsConfirmed) return err(400, 'rights', '需要确认你有权发布这些图片');
    const v = SS.validateSetZip(zip);
    if (!v.ok) return err(400, v.reason, v.errors.slice(0, 5).join('；'));
    if (!LICENSES.includes(v.manifest.license)) return err(400, 'license', `授权方式需要是：${LICENSES.join(' / ')}`);
    let rec = null;
    if (id) {
      rec = this.db.sets[id];
      if (!rec) return err(404, 'unknown', '商店里没有这组表情包');
      if (rec.ownerId !== user.id) return err(403, 'not-owner', '这组表情包不是你上架的，不能更新');
    } else {
      const own = Object.values(this.db.sets).filter((s) => s.ownerId === user.id && !s.removedAt).length;
      if (own >= MAX_SETS_PER_USER) return err(429, 'quota', `每位用户最多上架 ${MAX_SETS_PER_USER} 组表情包`);
      const o = this._ownerTag(user.id);
      o.seq += 1;
      id = `u-${o.tag}-${o.seq}`;
    }
    const last = rec && (rec.pending || rec.published || rec.rejected);
    const version = last ? bumpPatch(last.entry.version) : '1.0.0';
    const meta = {
      id, name: v.manifest.name, description: v.manifest.description, author: user.name, license: v.manifest.license, version,
      ...(v.manifest.forSpecies ? { forSpecies: v.manifest.forSpecies } : {}), cover: v.manifest.cover,
    };
    const packed = SS.packSet(meta, v.stickers.map((s) => ({ id: s.id, label: s.label, desc: s.desc, buffer: s.buffer })));
    if (!packed.ok) return err(400, packed.reason, packed.errors.join('；'));
    const file = `${id}-${version.replace(/\./g, '-')}.zip`;
    const previews = packed.stickers.map((s) => {
      const name = `previews/${s.sha256}.${s.ext}`;
      this._write(name, s.buffer);
      return { id: s.id, label: s.label, desc: s.desc, file: name, bytes: s.buffer.length, sha256: s.sha256 };
    });
    this._write(file, packed.zip);
    const entry = {
      id, type: 'sticker-set', name: packed.manifest.name, description: packed.manifest.description, author: user.name, official: false,
      license: packed.manifest.license, version, forSpecies: packed.manifest.forSpecies || [], count: packed.stickers.length,
      cover: packed.manifest.cover, previews, file, bytes: packed.zip.length, sha256: SS.sha256(packed.zip),
    };
    if (!SC.cleanEntry(entry, RELEASE)) return err(500, 'entry', '服务端生成的目录条目无效');
    const at = this.now();
    rec = rec || { id, ownerId: user.id, createdAt: at, published: null, pending: null, rejected: null, removedAt: null };
    rec.ownerName = user.name;
    rec.pending = { entry, submittedAt: at };
    rec.rejected = null;
    rec.removedAt = null;
    rec.updatedAt = at;
    this.db.sets[id] = rec;
    if (this.reviewMode === 'auto') this._approve(rec, 'auto');
    this._save();
    return { ok: true, status: 201, id, version, state: this._state(rec), set: this._view(rec) };
  }

  _approve(rec, by) {
    rec.published = { ...rec.pending, reviewedAt: this.now(), reviewedBy: by };
    rec.pending = null;
  }

  // the maintainer's decision on the version waiting for review
  review(id, decision, reason = '') {
    const rec = this.db.sets[String(id || '')];
    if (!rec || !rec.pending) return err(404, 'unknown', '没有待审核的这组表情包');
    if (decision === 'approve') this._approve(rec, 'maintainer');
    else if (decision === 'reject') {
      rec.rejected = { ...rec.pending, reviewedAt: this.now(), reason: String(reason || '').slice(0, 200) || '内容不符合上架规则' };
      rec.pending = null;
    } else return err(400, 'decision', 'decision must be approve or reject');
    rec.updatedAt = this.now();
    this._save();
    return { ok: true, status: 200, id: rec.id, state: this._state(rec), set: this._view(rec) };
  }

  unpublish(user, id) {
    const rec = this.db.sets[String(id || '')];
    if (!rec || rec.removedAt) return err(404, 'unknown', '商店里没有这组表情包');
    if (!user || rec.ownerId !== user.id) return err(403, 'not-owner', '只能下架自己上架的表情包');
    rec.removedAt = this.now();
    rec.published = null;
    rec.pending = null;
    rec.updatedAt = rec.removedAt;
    this._save();
    return { ok: true, status: 200, id: rec.id, state: 'removed' };
  }

  _state(rec) {
    if (rec.removedAt) return 'removed';
    if (rec.pending) return 'pending';
    if (rec.published) return 'published';
    if (rec.rejected) return 'rejected';
    return 'removed';
  }

  // what the owner sees: the newest version (waiting, live or turned down) and whether an older one is live
  _view(rec) {
    const cur = rec.pending || rec.published || rec.rejected;
    const e = cur ? cur.entry : null;
    return {
      id: rec.id, state: this._state(rec), name: e ? e.name : '', version: e ? e.version : null, count: e ? e.count : 0,
      license: e ? e.license : '', forSpecies: e ? e.forSpecies : [], author: rec.ownerName,
      liveVersion: rec.published ? rec.published.entry.version : null, rejectReason: rec.rejected ? rec.rejected.reason : null,
      submittedAt: cur ? cur.submittedAt : null, reviewedAt: rec.published ? rec.published.reviewedAt : null, updatedAt: rec.updatedAt,
    };
  }

  mine(user) {
    if (!user || !user.id) return err(401, 'auth', '请先登录 LobeHub');
    const sets = Object.values(this.db.sets).filter((r) => r.ownerId === user.id && !r.removedAt).sort((a, b) => b.updatedAt - a.updatedAt).map((r) => this._view(r));
    return { ok: true, status: 200, sets };
  }

  pending() {
    return Object.values(this.db.sets).filter((r) => r.pending && !r.removedAt).map((r) => ({ ...this._view(r), owner: r.ownerName, previews: r.pending.entry.previews.map((p) => p.file) }));
  }

  // the shelf: every set with a published version, newest first
  index() {
    const live = Object.values(this.db.sets).filter((r) => r.published && !r.removedAt).sort((a, b) => b.published.reviewedAt - a.published.reviewedAt);
    const updatedAt = live.length ? new Date(Math.max(...live.map((r) => r.published.reviewedAt))).toISOString() : new Date(0).toISOString();
    return { schema: 1, release: RELEASE, updatedAt, sets: live.map((r) => r.published.entry) };
  }
}

module.exports = { StickerMarket, LICENSES, MAX_SETS_PER_USER };
