'use strict';

// 下载角色 (core/catalog.js): fetch a catalog character's archive, check its size and sha256 against the index
// the app shipped with, and hand it to the pack store to put in place. One download per character at a time;
// progress goes to every window as `catalog-progress` { id, received, total, state }.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, net } = require('electron');
const Catalog = require('../core/catalog');

const REASON_TEXT = {
  unknown: '没有这个可下载的角色',
  installed: '她已经下载好了',
  adult: '18+ 角色需要先确认已满 18 周岁并打开成人向内容',
  busy: '正在下载中',
  network: '下载失败，请检查网络后重试',
  http: '下载地址暂时不可用，请稍后重试',
  size: '下载的文件大小不对，已丢弃，请重试',
  checksum: '下载的文件校验没通过，已丢弃，请重试',
  invalid: '下载的角色文件有问题，已丢弃',
  canceled: '已取消下载',
};

class CatalogDownloader {
  // `packStore`: src/main/packs.js; `settings()`: the current settings (catalogUrl, the 18+ switches);
  // `emit(channel, payload)`: to every window.
  // 商店 → 舞蹈 uses the same downloader with its own index and installer: `lookup(id)` → an index entry,
  // `isInstalled(entry)`, `install(entry, zipFile)` → { ok, reason?, errors? }; the defaults are the characters'.
  constructor({ packStore, settings, emit, lookup = null, isInstalled = null, install = null, texts = null }) {
    this.packStore = packStore;
    this.settings = settings;
    this.emit = emit;
    this.lookup = lookup || ((id) => Catalog.entry(id));
    this.isInstalled = isInstalled || ((e) => this.packStore.installed(e.id));
    this.install = install || ((e, zipFile) => this.packStore.installDownload(e, zipFile));
    this.texts = { ...REASON_TEXT, ...(texts || {}) };
    this.jobs = new Map(); // id → { received, total, controller }
  }

  state() {
    return [...this.jobs.entries()].map(([id, j]) => ({ id, received: j.received, total: j.total, state: 'downloading' }));
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j) return { ok: false, reason: 'unknown' };
    j.controller.abort();
    return { ok: true };
  }

  async download(id) {
    const T = this.texts;
    // `detail`: the installer's own readable reason (core/voice-store.js), after the generic text
    const fail = (reason, extra = {}) => {
      const text = `${T[reason] || reason}${extra.detail ? `：${extra.detail}` : ''}`;
      this.emit('catalog-progress', { id, state: 'failed', reason, text });
      return { ok: false, reason, ...extra, text };
    };
    const e = this.lookup(String(id || ''));
    if (!e) return { ok: false, reason: 'unknown', text: T.unknown };
    if (this.isInstalled(e)) return { ok: false, reason: 'installed', text: T.installed };
    const s = this.settings();
    if (e.adult && !(s.ageConfirmed && s.adultContent)) return { ok: false, reason: 'adult', text: T.adult };
    if (this.jobs.has(e.id)) return { ok: false, reason: 'busy', text: T.busy };
    const controller = new AbortController();
    const job = { received: 0, total: e.bytes, controller };
    this.jobs.set(e.id, job);
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pixelpet-dl-')), e.file);
    let last = 0;
    let out = null;
    const progress = (state) => this.emit('catalog-progress', { id: e.id, received: job.received, total: job.total, state });
    try {
      progress('downloading');
      // one file, or the archive's parts in order (core/catalog.js: the CDN takes at most 20 MB per file)
      const parts = Array.isArray(e.parts) && e.parts.length ? e.parts : [{ file: e.file, bytes: e.bytes }];
      const hash = crypto.createHash('sha256');
      // opened here, synchronously: a stream that opens its file on its own would still be opening it when a
      // failed download (404, network) removes the folder below — ENOENT on a stream nobody listens to any more
      out = fs.createWriteStream(tmp, { fd: fs.openSync(tmp, 'w') });
      for (const part of parts) {
        let res;
        try {
          res = await net.fetch(Catalog.downloadUrl({ ...e, file: part.file }, s), { signal: controller.signal, headers: { 'User-Agent': `PixelPetAffection/${app.getVersion()}` } });
        } catch (err) {
          out.destroy();
          return fail(controller.signal.aborted ? 'canceled' : 'network', { message: err.message });
        }
        if (!res.ok) { out.destroy(); return fail('http', { status: res.status }); }
        try {
          for await (const chunk of res.body) {
            const buf = Buffer.from(chunk);
            job.received += buf.length;
            if (job.received > e.bytes) throw Object.assign(new Error('too large'), { reason: 'size' });
            hash.update(buf);
            if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
            if (Date.now() - last > 150) {
              last = Date.now();
              progress('downloading');
            }
          }
        } catch (err) {
          out.destroy();
          return fail(err.reason || (controller.signal.aborted ? 'canceled' : 'network'), { message: err.message });
        }
      }
      await new Promise((r, j) => out.end((err) => (err ? j(err) : r())));
      if (job.received !== e.bytes) return fail('size');
      if (hash.digest('hex') !== e.sha256) return fail('checksum');
      progress('installing');
      const r = await this.install(e, tmp);
      if (!r.ok) return fail(r.reason === 'builtin' ? 'installed' : 'invalid', { errors: r.errors, ...(r.text ? { detail: r.text } : {}) });
      this.emit('catalog-progress', { id: e.id, received: job.received, total: job.total, state: 'done' });
      return { ok: true, id: e.id, name: e.name };
    } finally {
      this.jobs.delete(e.id);
      if (out && !out.closed) {
        out.destroy();
        await new Promise((r) => out.once('close', r));
      }
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
  }
}

module.exports = { CatalogDownloader, REASON_TEXT };
