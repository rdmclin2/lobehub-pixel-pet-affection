'use strict';
// API keys for the voice engines (高级设置 → 语音). Kept apart from settings.json in
// userData/tts-keys.json, encrypted with the system keychain (Electron safeStorage) where there is one;
// without one the file is still only readable by the user (0600). Keys never go to the renderer, the
// log or the repository: the settings view only says whether a key is set.

const fs = require('node:fs');
const path = require('node:path');

const KEY_RE = /^[\x21-\x7e]{8,256}$/; // printable, no spaces

class TtsKeyStore {
  // crypt: { available(), encrypt(str) -> Buffer, decrypt(Buffer) -> str } (Electron safeStorage), or null
  constructor(dir, crypt = null) {
    this.file = dir ? path.join(dir, 'tts-keys.json') : null;
    this.crypt = crypt;
    this.keys = {};
    if (this.file) this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, v] of Object.entries(raw || {})) {
        if (!/^[a-z]{2,20}$/.test(id) || !v) continue;
        const key = v.enc && this.crypt && this.crypt.available() ? this.crypt.decrypt(Buffer.from(v.enc, 'base64')) : v.plain;
        if (typeof key === 'string' && KEY_RE.test(key)) this.keys[id] = key;
      }
    } catch { /* no keys yet, or unreadable: the engines fall back */ }
  }

  _save() {
    if (!this.file) return;
    const enc = !!(this.crypt && this.crypt.available());
    const out = Object.fromEntries(Object.entries(this.keys).map(([id, k]) => [id, enc ? { enc: this.crypt.encrypt(k).toString('base64') } : { plain: k }]));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  encrypted() {
    return !!(this.crypt && this.crypt.available());
  }

  has(id) {
    return !!this.keys[id];
  }

  get(id) {
    return this.keys[id] || '';
  }

  all() {
    return Object.values(this.keys);
  }

  // '' removes the key. Returns false for something that cannot be a key.
  set(id, key) {
    const k = String(key || '').trim();
    if (k && !KEY_RE.test(k)) return false;
    if (k) this.keys[id] = k;
    else delete this.keys[id];
    this._save();
    return true;
  }
}

module.exports = { TtsKeyStore };
