'use strict';

// 商店 → 表情包 in the main process (docs/stickers-design.md §5.2 方案 B): the official sticker sets on LobeHub's
// CDN. Which sets there are comes from sticker-catalog.json on the CDN (core/sticker-catalog.js), read when the
// store opens (at most every REFRESH_MS unless asked) and kept in <userData>/stickers/store-cache/index.json, so
// the last good read still counts offline; with neither, the copy shipped with the app.
//
// The covers and previews are fetched into store-cache/<sha256>.<ext>, checked by size and sha256, and served
// as sticker://store/<name> (the settings window's CSP takes no web images). 获取 downloads the set zip with
// src/main/catalog.js CatalogDownloader (its size, sha256, progress as `catalog-progress`, cancel and failure
// texts), then core/stickers.js installStore unpacks it into blobs/ + sets/store-<id>.json for the character
// picked. A set already fetched is only attached to one more character. 移除 drops the set (old chat messages
// keep their pictures: the blobs stay until gc).
//
// Electron is not required here: main passes net.fetch; the tests pass their own fetch.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SC = require('../core/sticker-catalog');
const { CatalogDownloader } = require('./catalog');

const TEXTS = {
  unknown: '商店里没有这组表情包',
  installed: '这组表情包已经获取过了',
  invalid: '下载的表情包文件有问题，已丢弃',
  checksum: '下载的表情包校验没通过（sha256 不符），已丢弃，请重试',
  size: '下载的表情包大小不对，已丢弃，请重试',
};

class StickerStore {
  // `lib`: core/stickers.js StickerLibrary; `fetch(url, opts)`: net.fetch; `emit(channel, payload)`: to every
  // window; `names()`: speciesId → her name; `url`: the index (PIXELPET_STICKER_CATALOG_URL; '' = off: the
  // bundled index only); `base`: a folder holding every file of the release (PIXELPET_STICKER_BASE_URL), else
  // the CDN; `bundled`: the shipped index (tests pass their own).
  constructor({ lib, fetch: fetchFn, emit = () => {}, log = () => {}, names = () => ({}), url = SC.REMOTE_URL, base = null, bundled = null, settings = () => ({}), now = () => Date.now() }) {
    this.lib = lib;
    this.fetch = fetchFn;
    this.emit = emit;
    this.log = log;
    this.names = names;
    this.url = url;
    this.base = base || null;
    this.bundled = bundled;
    this.now = now;
    this.cacheDir = lib.cacheDir;
    this.indexFile = path.join(this.cacheDir, 'index.json');
    this.remote = null; // read now (this run)
    this.cached = null; // the last good read, from disk
    this.checkedAt = 0;
    this.error = null;
    this._inflight = null;
    this.targets = new Map(); // set id → the character a running 获取 is for
    try {
      const c = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      if (c && c.url === this.url) { this.cached = SC.parseRemote(c.index); this.checkedAt = c.checkedAt || 0; }
    } catch { /* first start */ }
    this.downloader = new CatalogDownloader({
      packStore: null, settings, emit, fetch: fetchFn, texts: TEXTS,
      lookup: (id) => this.entry(id),
      isInstalled: () => false, // 获取 again replaces (a newer version) or only attaches: decided in get()
      install: async (e, zipFile) => {
        const r = this.lib.installStore(e, fs.readFileSync(zipFile), this.targets.get(e.id));
        return r.ok ? r : { ok: false, reason: r.reason, text: r.text, errors: r.errors };
      },
      url: (e, file) => SC.fileUrl(e, file, this.base),
    });
  }

  picked() { return SC.pick({ remote: this.remote, cached: this.cached, bundled: this.bundled || SC.loadBundled() }); }
  index() { return this.picked().index; }
  entry(id) { return this.index().sets.find((s) => s.id === id) || null; }

  // Read the CDN's index when the last read is older than `maxAgeMs` (0: now). Never throws.
  async refresh({ maxAgeMs = StickerStore.REFRESH_MS } = {}) {
    if (!this.url) return { ok: false, reason: 'off' };
    if (this.remote && this.now() - this.checkedAt < maxAgeMs) return { ok: true, cached: true };
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const res = await this.fetch(this.url, { signal: ctrl.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const index = SC.parseRemote(await res.text());
        if (!index) throw new Error('the index has no valid sticker sets');
        this.remote = index;
        this.cached = index;
        this.checkedAt = this.now();
        this.error = null;
        fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.writeFileSync(this.indexFile, JSON.stringify({ url: this.url, checkedAt: this.checkedAt, index }));
        return { ok: true };
      } catch (e) {
        this.error = String((e && e.message) || e).slice(0, 200);
        this.log(new Error(`sticker index: ${this.error}`));
        return { ok: false, reason: 'network', text: this.error };
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  _previewName(p) { return `${p.sha256}${path.extname(p.file)}`; }

  // One preview into store-cache/, checked by size and sha256 (a wrong file is never kept). -> its sticker:// URL or null
  async _preview(e, p) {
    const name = this._previewName(p);
    if (this.lib.cachePath(name)) return `sticker://store/${name}`;
    try {
      const res = await this.fetch(SC.fileUrl(e, p.file, this.base));
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== p.bytes || crypto.createHash('sha256').update(buf).digest('hex') !== p.sha256) {
        this.log(new Error(`sticker preview ${e.id}/${p.id}: size or sha256 does not match the index`));
        return null;
      }
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const tmp = path.join(this.cacheDir, `${name}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(this.cacheDir, name));
      return `sticker://store/${name}`;
    } catch {
      return null;
    }
  }

  _coverUrl(e) {
    const p = e.previews.find((x) => x.id === e.cover);
    return p && this.lib.cachePath(this._previewName(p)) ? `sticker://store/${this._previewName(p)}` : null;
  }

  // The shelf: { sets: rows (+ coverUrl), source, url, checkedAt, error, downloads }. `refresh`: read the CDN
  // now. The covers not cached yet are fetched before it answers (a handful of small pictures).
  async state({ refresh = false } = {}) {
    const r = await this.refresh({ maxAgeMs: refresh ? 0 : StickerStore.REFRESH_MS });
    const picked = this.picked();
    await Promise.all(picked.index.sets.map((e) => {
      const p = e.previews.find((x) => x.id === e.cover);
      return p ? this._preview(e, p) : null;
    }));
    const byId = new Map(picked.index.sets.map((e) => [e.id, e]));
    const rows = SC.rows(picked.index, this.lib.storeInstalled(), this.names()).map((row) => ({ ...row, coverUrl: this._coverUrl(byId.get(row.id)) }));
    return {
      ok: true, sets: rows, source: picked.source, url: this.url || null, release: picked.index.release, updatedAt: picked.index.updatedAt || null,
      checkedAt: this.checkedAt || null, error: r.ok || r.reason === 'off' ? null : r.text || this.error, downloads: this.downloader.state(),
    };
  }

  // 详情: the set's row and every sticker's preview (fetched now when missing). -> { ok, set, stickers }
  async detail(id) {
    await this.refresh(); // a detail page opened straight from a link: the index may not be read yet
    const e = this.entry(String(id || ''));
    if (!e) return { ok: false, reason: 'unknown', text: TEXTS.unknown };
    const stickers = await Promise.all(e.previews.map(async (p) => ({ id: p.id, label: p.label, desc: p.desc, url: await this._preview(e, p) })));
    const [row] = SC.rows({ sets: [e] }, this.lib.storeInstalled(), this.names());
    return { ok: true, set: { ...row, coverUrl: this._coverUrl(e) }, stickers };
  }

  // 获取 for `speciesId`: download + install when not fetched yet (or the store has a newer version), else only
  // attach it to her. -> { ok, id, name, attached? } | { ok: false, reason, text }
  async get(id, speciesId) {
    await this.refresh();
    const e = this.entry(String(id || ''));
    if (!e) return { ok: false, reason: 'unknown', text: TEXTS.unknown };
    const have = this.lib.storeInstalled().get(e.id);
    if (have && have.version === e.version) {
      if (have.attached.includes(speciesId)) return { ok: false, reason: 'installed', text: '她已经有这组表情包了' };
      const r = this.lib.attachStore(e.id, speciesId);
      return r.ok ? { ok: true, id: e.id, name: e.name, attachedOnly: true, speciesId } : { ok: false, reason: r.reason, text: r.message };
    }
    if (this.targets.has(e.id)) return { ok: false, reason: 'busy', text: '正在下载中' };
    this.targets.set(e.id, speciesId);
    try {
      const r = await this.downloader.download(e.id);
      return r.ok ? { ...r, speciesId } : r;
    } finally {
      this.targets.delete(e.id);
    }
  }

  cancel(id) { return this.downloader.cancel(String(id || '')); }

  remove(id) {
    const r = this.lib.removeStore(String(id || ''));
    return r.ok ? r : { ok: false, reason: r.reason, text: r.message };
  }
}
StickerStore.REFRESH_MS = 10 * 60 * 1000;

module.exports = { StickerStore, TEXTS };
