'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Tiny JSON persistence with atomic writes.
class Store {
  constructor(dir) {
    this.file = path.join(dir, 'pet.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(pet) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pet, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Copy the current save to `name` (e.g. before a schema migration). Only once: an existing
  // backup is never overwritten. Returns true when a backup was written.
  backupOnce(name) {
    const dest = path.join(path.dirname(this.file), name);
    if (fs.existsSync(dest) || !fs.existsSync(this.file)) return false;
    fs.copyFileSync(this.file, dest);
    return true;
  }

  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}

module.exports = { Store };
