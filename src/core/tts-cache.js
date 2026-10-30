'use strict';
// Synthesised lines on disk (userData/tts-cache/<key>.<ext>), keyed by engine + voice + parameters + text
// (core/tts.js cacheKey), so a line she says again costs nothing and plays at once. index.json keeps
// the least recently used order; past MAX_BYTES the oldest files go.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 50 * 1024 * 1024;
const EXT = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus' };
const KEY_RE = /^[0-9a-f]{64}$/;

class TtsCache {
  constructor(dir, { maxBytes = MAX_BYTES } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.indexFile = path.join(dir, 'index.json');
    fs.mkdirSync(dir, { recursive: true });
    this.index = this._load(); // key -> { file, mime, bytes, used }
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      return Object.fromEntries(Object.entries(raw).filter(([k, v]) => KEY_RE.test(k) && v && typeof v.file === 'string' && fs.existsSync(path.join(this.dir, v.file))));
    } catch {
      return {};
    }
  }

  _save() {
    const tmp = `${this.indexFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.index));
    fs.renameSync(tmp, this.indexFile);
  }

  get(key) {
    const e = KEY_RE.test(key) && this.index[key];
    if (!e) return null;
    try {
      const audio = fs.readFileSync(path.join(this.dir, e.file));
      e.used = Date.now();
      this._save();
      return { audio, mime: e.mime };
    } catch {
      delete this.index[key];
      return null;
    }
  }

  // Whether a line is cached, without touching its place in the LRU order (prewarming asks this a lot).
  has(key) {
    return !!(KEY_RE.test(key) && this.index[key]);
  }

  put(key, audio, mime) {
    if (!KEY_RE.test(key) || !audio || !audio.length || audio.length > this.maxBytes) return;
    const file = `${key}.${EXT[mime] || 'bin'}`;
    try {
      fs.writeFileSync(path.join(this.dir, file), audio);
      this.index[key] = { file, mime, bytes: audio.length, used: Date.now() };
      this._trim();
      this._save();
    } catch { /* a full disk only costs the cache */ }
  }

  size() {
    return Object.values(this.index).reduce((n, e) => n + e.bytes, 0);
  }

  count() {
    return Object.keys(this.index).length;
  }

  clear() {
    for (const e of Object.values(this.index)) fs.rmSync(path.join(this.dir, e.file), { force: true });
    this.index = {};
    this._save();
  }

  _trim() {
    let total = this.size();
    for (const [k, e] of Object.entries(this.index).sort((a, b) => a[1].used - b[1].used)) {
      if (total <= this.maxBytes) break;
      fs.rmSync(path.join(this.dir, e.file), { force: true });
      delete this.index[k];
      total -= e.bytes;
    }
  }
}

module.exports = { TtsCache, MAX_BYTES };
