'use strict';
// API keys for the voice engines (高级设置 → 语音). Kept apart from settings.json in
// userData/tts-keys.json, encrypted with the system keychain (Electron safeStorage) where main.js passes
// one (Windows / Linux); otherwise — and always on macOS — a file only the user can read (0600). Keys never
// go to the renderer, the log or the repository: the settings view only says whether a key is set.
//
// Why not the keychain on macOS: the app is ad-hoc signed, so every auto-update is a "new" program to the
// keychain and the "Always Allow" grant is lost — the login-password prompt came back after each update.
// Keys saved encrypted by older versions are read once through `legacyDecrypt` (one last prompt) and
// rewritten as 0600; a key the keychain refuses (Deny) is kept as it was and tried again next launch.

const fs = require('node:fs');
const path = require('node:path');

const KEY_RE = /^[\x21-\x7e]{8,256}$/; // printable, no spaces

class TtsKeyStore {
  // crypt: { available(), encrypt(str) -> Buffer, decrypt(Buffer) -> str } (Electron safeStorage), or null
  // legacyDecrypt(Buffer) -> str: reads entries an older version encrypted, when crypt is null
  constructor(dir, crypt = null, { legacyDecrypt = null } = {}) {
    this.file = dir ? path.join(dir, 'tts-keys.json') : null;
    this.crypt = crypt;
    this.legacyDecrypt = legacyDecrypt;
    this.keys = {};
    this.stale = {}; // encrypted entries that could not be read: written back unchanged, never dropped
    if (this.file) this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      let migrated = false;
      for (const [id, v] of Object.entries(raw || {})) {
        if (!/^[a-z]{2,20}$/.test(id) || !v) continue;
        let key = v.plain;
        if (v.enc) {
          const useCrypt = !!(this.crypt && this.crypt.available());
          const decrypt = useCrypt ? this.crypt.decrypt : this.legacyDecrypt;
          try {
            key = decrypt ? decrypt(Buffer.from(v.enc, 'base64')) : null;
          } catch { key = null; }
          if (typeof key === 'string' && KEY_RE.test(key)) migrated = migrated || !useCrypt;
          else { this.stale[id] = { enc: v.enc }; continue; }
        }
        if (typeof key === 'string' && KEY_RE.test(key)) this.keys[id] = key;
      }
      if (migrated) this._save();
    } catch { /* no keys yet, or unreadable: the engines fall back */ }
  }

  _save() {
    if (!this.file) return;
    const enc = !!(this.crypt && this.crypt.available());
    const out = { ...this.stale, ...Object.fromEntries(Object.entries(this.keys).map(([id, k]) => [id, enc ? { enc: this.crypt.encrypt(k).toString('base64') } : { plain: k }])) };
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
    delete this.stale[id];
    this._save();
    return true;
  }
}

module.exports = { TtsKeyStore };
