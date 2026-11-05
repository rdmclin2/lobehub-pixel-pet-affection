'use strict';

// 小游戏 (docs/mini-games.md §2–§7): the game packs on disk and what main does for the game window.
//   userData/games/<id>/          downloaded from 商店 → 小游戏 (core/game-store.js installArchive)
//   catalog/games/<id>/           a checkout's game sources, only with PIXELPET_DEV_GAMES=1 (never in a build)
//   userData/games/.progress/     each game's saved progress: today's quests, lifetime totals, its world state
// The page reads a game's files over game://<id>/<file> (registered in packs.js with the other schemes); only the
// files its manifest names are served.

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { protocol, net } = require('electron');
const GS = require('../core/game-store');
const GQ = require('../core/game-quests');
const GP = require('../core/game-pack');

class GameLibrary {
  constructor({ userDir, devDir = null }) {
    this.userDir = userDir;
    this.roots = [{ dir: userDir, source: 'download' }, ...(devDir ? [{ dir: devDir, source: 'dev' }] : [])];
    this._cache = new Map(); // id → { dir, mtime, manifest, sprites }
  }

  list() { return GS.listInstalled(this.roots); }
  installedIds() { return new Set(this.list().map((g) => g.id)); }
  has(id) { return this.list().some((g) => g.id === id); }

  // the game to open: the one asked for, else the last played, else the first installed
  pick(id, last) {
    const all = this.list();
    return all.find((g) => g.id === id) || all.find((g) => g.id === last) || all[0] || null;
  }

  load(id) {
    const g = this.list().find((x) => x.id === id);
    if (!g) return null;
    const mf = path.join(g.dir, 'manifest.json');
    const mtime = fs.statSync(mf).mtimeMs;
    const c = this._cache.get(id);
    if (c && c.dir === g.dir && c.mtime === mtime) return c;
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const sprites = manifest.sprites ? JSON.parse(fs.readFileSync(path.join(g.dir, manifest.sprites), 'utf8')) : {};
    const out = { id, dir: g.dir, source: g.source, mtime, manifest, sprites };
    this._cache.set(id, out);
    return out;
  }

  // what game:boot hands the page
  boot(id) {
    const g = this.load(id);
    if (!g) return null;
    return { id, name: g.manifest.name, base: `game://${id}/`, manifest: g.manifest, sprites: g.sprites };
  }

  progress(id) {
    const g = this.load(id);
    const p = GS.readProgress(this.userDir, id);
    const day = GQ.dayKey();
    const quests = g ? GQ.view(g.manifest.quests || [], p.quests, day) : [];
    const items = (p.quests && p.quests.items) || {};
    return { quests, items, state: p.state || {} };
  }

  // one event from the page → today's quests; returns the quests that this event finished
  record(id, ev, ctx) {
    const g = this.load(id);
    if (!g || !ev || typeof ev.type !== 'string') return { ok: false, reason: 'invalid' };
    const clean = { type: String(ev.type).slice(0, 20), ...(ev.obj ? { obj: String(ev.obj).slice(0, 64) } : {}), ...(ev.item ? { item: String(ev.item).slice(0, 32) } : {}) };
    const c = { phase: String((ctx && ctx.phase) || ''), weather: String((ctx && ctx.weather) || '') };
    const p = GS.readProgress(this.userDir, id);
    const r = GQ.record(g.manifest.quests || [], p.quests, clean, c);
    // counts towards a quest (浇两次水: the first one), a finished quest, something collected: saved
    if (JSON.stringify(r.progress) !== JSON.stringify(p.quests || null)) GS.writeProgress(this.userDir, id, { ...p, quests: r.progress });
    return { ok: true, completed: r.completed, quests: GQ.view(g.manifest.quests || [], r.progress), items: r.progress.items };
  }

  saveState(id, state) {
    if (!this.has(id) || !state || typeof state !== 'object') return false;
    const json = JSON.stringify(state);
    if (json.length > 64 * 1024) return false;
    const p = GS.readProgress(this.userDir, id);
    GS.writeProgress(this.userDir, id, { ...p, state: JSON.parse(json) });
    return true;
  }

  // game://<id>/<file>
  registerProtocol() {
    protocol.handle('game', (req) => {
      let u;
      try { u = new URL(req.url); } catch { return new Response('bad url', { status: 400 }); }
      const id = u.hostname;
      const file = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      const g = GP.ID_RE.test(id) && GP.FILE_RE.test(file) ? this.load(id) : null;
      if (!g) return new Response('not found', { status: 404 });
      const named = new Set([...Object.values(g.manifest.images || {}), g.manifest.sprites].filter(Boolean));
      if (!named.has(file)) return new Response('not found', { status: 404 });
      return net.fetch(pathToFileURL(path.join(g.dir, file)).toString());
    });
  }
}

module.exports = { GameLibrary };
