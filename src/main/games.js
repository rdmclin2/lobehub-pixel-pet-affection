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
const GI = require('../core/game-index');

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
    // which copy of the manifest: an update writes a new file (new inode) — the time alone would not tell, the
    // archives carry one fixed timestamp so they are reproducible
    const st = fs.statSync(mf);
    const mtime = `${st.ino}:${st.size}:${st.mtimeMs}`;
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
    return { id, name: g.manifest.name, version: g.manifest.version, base: `game://${id}/`, manifest: g.manifest, sprites: g.sprites };
  }

  progress(id) {
    const g = this.load(id);
    const p = GS.readProgress(this.userDir, id);
    const day = GQ.dayKey();
    const quests = g ? GQ.view(g.manifest.quests || [], p.quests, day) : [];
    const items = (p.quests && p.quests.items) || {};
    return { quests, items, itemNames: (g && g.manifest.items) || {}, state: p.state || {} };
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

// 商店 → 小游戏 · 目录与升级 (core/game-index.js): the bundled index, merged with the games repository's
// catalog.json, read at most every REFRESH_MS (on start, when the store opens, every 6 h) and kept in
// userData/games/.index.json so the last one read still counts offline. Remote cover pictures are fetched once
// into userData/games/.covers/ and handed to the settings window as data: URLs (its CSP takes no web images).
// PIXELPET_GAME_INDEX_URL points it at another catalog.json (tests, a mirror); '' switches the remote off.
class GameIndex {
  constructor({ userDir, appVersion, fetch: fetchFn, log = () => {}, url = process.env.PIXELPET_GAME_INDEX_URL ?? GI.REMOTE_URL, now = () => Date.now() }) {
    this.userDir = userDir;
    this.appVersion = appVersion;
    this.fetch = fetchFn;
    this.log = log;
    this.url = url;
    this.now = now;
    this.cacheFile = path.join(userDir, '.index.json');
    this.coverDir = path.join(userDir, '.covers');
    this.remote = null;
    this.checkedAt = 0;
    this.error = null;
    this._inflight = null;
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (c && c.url === this.url) { this.remote = GI.parseIndex(c.index); this.checkedAt = c.checkedAt || 0; }
    } catch { /* first start */ }
  }

  index() { return GI.merge(GI.loadBundled(), this.remote); }
  entry(id) { return this.index().games.find((g) => g.id === id) || null; }
  ctx() { return { appVersion: this.appVersion, engines: GP.ENGINES }; }

  // read the remote catalog when the last read is older than `maxAgeMs` (0: now); never throws
  async refresh({ maxAgeMs = GameIndex.REFRESH_MS } = {}) {
    if (!this.url) return { ok: false, reason: 'off' };
    if (this.now() - this.checkedAt < maxAgeMs && this.remote) return { ok: true, cached: true };
    if (this._inflight) return this._inflight;
    this._inflight = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const res = await this.fetch(this.url, { signal: ctrl.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        // only what the games repository marked published (its archive is on the CDN)
        this.remote = GI.parseIndex({ ...raw, games: (raw.games || []).filter((g) => g && g.published) });
        this.checkedAt = this.now();
        this.error = null;
        fs.mkdirSync(this.userDir, { recursive: true });
        fs.writeFileSync(this.cacheFile, JSON.stringify({ url: this.url, checkedAt: this.checkedAt, index: this.remote }));
        await this._covers();
        return { ok: true };
      } catch (e) {
        this.error = String(e.message || e).slice(0, 200);
        this.log(new Error(`game index: ${this.error}`));
        return { ok: false, reason: 'network', text: this.error };
      } finally {
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  coverFile(g) { return path.join(this.coverDir, `${g.id}-${g.version}${path.extname(g.picture || '.webp')}`); }
  async _covers() {
    for (const g of this.index().games) {
      if (g.source !== 'remote' || !g.picture || g.bundledPicture || fs.existsSync(this.coverFile(g))) continue;
      try {
        const res = await this.fetch(g.picture);
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 2 * 1024 * 1024) continue;
        fs.mkdirSync(this.coverDir, { recursive: true });
        fs.writeFileSync(this.coverFile(g), buf);
      } catch { /* the card shows no picture */ }
    }
  }
  // what <img src> the settings window gets: the shipped picture, else the cached remote one, else none
  pictureSrc(row) {
    if (row.source === 'bundled' && row.picture) return `../renderer/${row.picture}`;
    if (row.bundledPicture) return `../renderer/${row.bundledPicture}`;
    if (!row.picture) return null;
    const f = this.coverFile(row);
    if (!fs.existsSync(f)) return null;
    return `data:image/${path.extname(f) === '.png' ? 'png' : 'webp'};base64,${fs.readFileSync(f).toString('base64')}`;
  }

  rows(installed, downloads) {
    return GI.storeRows(this.index(), installed, downloads, this.ctx()).map((r) => ({ ...r, pictureSrc: this.pictureSrc(r) }));
  }
  updates(installed) { return GI.updates(this.index(), installed, this.ctx()); }
}
GameIndex.REFRESH_MS = 10 * 60 * 1000;

module.exports = { GameLibrary, GameIndex };
