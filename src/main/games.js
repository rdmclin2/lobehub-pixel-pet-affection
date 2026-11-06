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
const RP = require('../core/room-play');
const IRP = require('../core/illustrated-room-play');
const IRPack = require('../core/illustrated-room-pack');

class GameLibrary {
  constructor({ userDir, devDir = null }) {
    this.userDir = userDir;
    this.roots = [{ dir: userDir, source: 'download' }, ...[].concat(devDir || []).map((dir) => ({ dir, source: 'dev' }))];
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
    // yard@1: its one sprites index; room@1: { <file>: index } of every room's
    const readSprites = (f) => JSON.parse(fs.readFileSync(path.join(g.dir, f), 'utf8'));
    const sprites = GP.MULTI_INDEX.includes(manifest.engine) ? Object.fromEntries(GP.spriteFiles(manifest).map((f) => [f, readSprites(f)])) : manifest.sprites ? readSprites(manifest.sprites) : {};
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
    // 像素房间: the page keeps only what it chose (the room); her focus, the running round, the last one and the
    // totals are main's (activity() below) and the page cannot write them
    const g = this.load(id);
    // 她的房间: everything is main's (illustratedCommand); the page has nothing of its own to save
    if (g && g.manifest.engine === IRP.ENGINE) return true;
    if (g && g.manifest.engine === 'room@1') {
      const st = this._roomState(p);
      const want = JSON.parse(json);
      if (typeof want.theme === 'string' && this._openTheme(g.manifest, want.theme)) st.theme = want.theme;
      GS.writeProgress(this.userDir, id, { ...p, state: st });
      return true;
    }
    GS.writeProgress(this.userDir, id, { ...p, state: JSON.parse(json) });
    return true;
  }

  // ---- 像素房间 (room@1, docs/her-room-design.md §2–§3) ---------------------------------------------------
  // The page asks; main decides with its own clock and the installed manifest's numbers (core/room-play.js) —
  // nothing the page sends sets how much a round is worth or how long it ran. `pet`: { stats() → { base, energy,
  // mood, fullness }, settle({ energy, mood, fullness }) → stats, quest(title) → affection result }.
  _openTheme(m, id) { return (m.themes || []).find((t) => t.id === id && t.status === 'open') || null; }
  _roomState(p) {
    const s = p && p.state && typeof p.state === 'object' ? p.state : {};
    return { theme: typeof s.theme === 'string' ? s.theme : null, focus: s.focus && typeof s.focus === 'object' ? { ...s.focus } : {}, run: s.run && typeof s.run === 'object' ? { ...s.run } : null, last: s.last || null, totals: s.totals && typeof s.totals === 'object' ? JSON.parse(JSON.stringify(s.totals)) : {}, ...(Number.isFinite(s.scale) ? { scale: s.scale } : {}) };
  }
  _stats(st, pet) {
    const s = pet.stats() || { base: 'dafeiyu', energy: 50, mood: 50, fullness: 50 };
    return { base: s.base, energy: s.energy, mood: s.mood, fullness: s.fullness, focus: Number.isFinite(st.focus[s.base]) ? st.focus[s.base] : RP.FOCUS_START };
  }
  // one settled round → her numbers (pet.json through PetService, focus here), the totals, today's quests
  _book(id, g, p, st, settled, pet, ctx) {
    const before = this._stats(st, pet);
    const { stats, changed } = RP.apply(before, settled.deltas);
    const after = pet.settle({ energy: stats.energy, mood: stats.mood, fullness: stats.fullness }) || stats;
    st.focus[before.base] = stats.focus;
    const tot = (st.totals[before.base] = st.totals[before.base] || {});
    const k = (tot[settled.kind] = tot[settled.kind] || { count: 0, completed: 0, ms: 0 });
    k.count += 1;
    if (settled.complete) k.completed += 1;
    k.ms += settled.elapsed;
    st.last = { kind: settled.kind, theme: settled.theme, complete: settled.complete, fraction: settled.fraction, changed, at: settled.at, ...(settled.recovered ? { recovered: true } : {}) };
    const ev = { type: 'activity-end', kind: settled.kind, theme: settled.theme || '', complete: settled.complete };
    const c = { phase: String((ctx && ctx.phase) || ''), weather: String((ctx && ctx.weather) || '') };
    const r = GQ.record(g.manifest.quests || [], p.quests, ev, c);
    p.quests = r.progress;
    const completed = r.completed.map((q) => ({ id: q.id, title: q.title, affection: (pet.quest(q.title) || {}).affection || null }));
    const defs = RP.defsOf(g.manifest);
    return { ...settled, changed, summary: RP.summary(settled, defs, changed), completed, stats: { ...stats, energy: after.energy, mood: after.mood, fullness: after.fullness } };
  }
  _roomView(g, p, st, pet, now) {
    const defs = RP.defsOf(g.manifest);
    return { stats: this._stats(st, pet), run: st.run ? { ...RP.view(st.run, now, defs), startedAt: st.run.startedAt } : null, last: st.last, theme: st.theme, quests: GQ.view(g.manifest.quests || [], p.quests), totals: st.totals };
  }

  // the game boots: a round left open by an app that went away is settled now (recover), and the room view
  roomBoot(id, pet, { now = Date.now() } = {}) {
    const g = this.load(id);
    if (!g || g.manifest.engine !== 'room@1') return null;
    const p = GS.readProgress(this.userDir, id);
    const st = this._roomState(p);
    let recovered = null;
    if (st.run) {
      const settled = RP.recover(st.run, now, RP.defsOf(g.manifest));
      st.run = null;
      if (settled) recovered = this._book(id, g, p, st, settled, pet, {});
      GS.writeProgress(this.userDir, id, { ...p, state: st });
    }
    return { ...this._roomView(g, p, st, pet, now), recovered };
  }

  // cmd: { cmd: 'start', kind, theme, ctx } · { cmd: 'stop' | 'tick', ctx } · { cmd: 'seen' } (the page is still
  // here: the round's seenAt for recover) · { cmd: 'theme', theme } (switch rooms: the round is settled) ·
  // { cmd: 'state' }; with testMode also { cmd: 'scale', k } (rounds k× as long, e2e)
  activity(id, cmd, pet, { now = Date.now(), testMode = false } = {}) {
    const g = this.load(id);
    if (!g || g.manifest.engine !== 'room@1' || !cmd || typeof cmd.cmd !== 'string') return { ok: false, reason: 'invalid' };
    const defs = RP.defsOf(g.manifest);
    const p = GS.readProgress(this.userDir, id);
    const st = this._roomState(p);
    const ctx = cmd.ctx && typeof cmd.ctx === 'object' ? cmd.ctx : {};
    const save = () => GS.writeProgress(this.userDir, id, { ...p, state: st });
    const out = (extra) => ({ ok: true, ...extra, ...this._roomView(g, p, st, pet, now) });
    const settleRun = () => {
      if (!st.run) return null;
      const s = RP.settle(st.run, now, defs);
      st.run = null;
      return s ? this._book(id, g, p, st, s, pet, ctx) : null;
    };
    switch (cmd.cmd) {
      case 'state': return out({});
      case 'start': {
        const kind = String(cmd.kind || '');
        const theme = String(cmd.theme || st.theme || '');
        if (!this._openTheme(g.manifest, theme)) return { ok: false, reason: 'theme' };
        const stats = this._stats(st, pet);
        const r = RP.start(st.run, kind, now, defs, stats, { theme, scale: testMode && Number.isFinite(st.scale) ? st.scale : 1 });
        if (!r.ok) return { ...r, ...this._roomView(g, p, st, pet, now) };
        if (r.already) return out({ already: true });
        // the round before (switched): booked the same way as a stop
        const settled = st.run ? settleRun() : null;
        st.run = r.run;
        st.theme = theme;
        save();
        return out({ started: kind, settled });
      }
      case 'stop': { const settled = settleRun(); if (settled) save(); return out({ settled }); }
      case 'tick': {
        if (!st.run) return out({ settled: null });
        const s = RP.tick(st.run, now, defs);
        if (!s) return out({ settled: null, early: true });
        st.run = null;
        const settled = this._book(id, g, p, st, s, pet, ctx);
        save();
        return out({ settled });
      }
      case 'seen': if (st.run) { st.run.seenAt = now; save(); } return out({});
      case 'theme': {
        const theme = String(cmd.theme || '');
        if (!this._openTheme(g.manifest, theme)) return { ok: false, reason: 'theme' };
        const settled = settleRun();
        st.theme = theme;
        save();
        return out({ settled });
      }
      case 'scale': {
        if (!testMode) return { ok: false, reason: 'test-only' };
        st.scale = Math.max(0.01, Math.min(1, Number(cmd.k) || 1));
        save();
        return out({ scale: st.scale });
      }
      default: return { ok: false, reason: 'invalid' };
    }
  }

  // the game window closed / the app quits with a round running: settled by how long it ran
  roomClose(id, pet, { now = Date.now() } = {}) {
    const g = this.load(id);
    if (!g || g.manifest.engine !== 'room@1') return null;
    const r = this.activity(id, { cmd: 'stop' }, pet, { now });
    return r && r.settled ? r.settled : null;
  }

  // ---- 她的房间 (illustrated-room@1, docs/illustrated-room.md §3) -------------------------------------------
  // Main is the only authority: a click on the status bar or the picture, a sentence in chat (core/room-intent.js
  // through main.js) and the page's timer all come here; core/illustrated-room-play.js decides, the numbers are
  // booked as 像素房间's (_book), and the page plays what comes back.
  _illView(g, p, st, pet, now) {
    return { ...IRP.view(st, { manifest: g.manifest, now }), stats: this._stats(st, pet), last: st.last, quests: GQ.view(g.manifest.quests || [], p.quests), totals: st.totals };
  }
  _illQuest(g, p, ev, pet) {
    const r = GQ.record(g.manifest.quests || [], p.quests, ev, {});
    p.quests = r.progress;
    return r.completed.map((q) => ({ id: q.id, title: q.title, affection: (pet.quest(q.title) || {}).affection || null }));
  }
  // the game boots: a round left open by an app that went away is settled now (as 像素房间's), and she is where
  // she was (the state, the lamp)
  illustratedBoot(id, pet, { now = Date.now() } = {}) {
    const g = this.load(id);
    if (!g || g.manifest.engine !== IRP.ENGINE) return null;
    const p = GS.readProgress(this.userDir, id);
    const st = IRP.restore(g.manifest, p.state, now);
    if (!st) return null;
    let recovered = null;
    if (st.run) {
      const settled = RP.recover(st.run, now, RP.defsOf(g.manifest));
      st.run = null;
      const room = IRP.roomOf(g.manifest, st.room);
      st.state = room.defaultState;
      st.since = now;
      st.screen = null;
      if (settled) recovered = this._book(id, g, p, st, settled, pet, {});
    }
    GS.writeProgress(this.userDir, id, { ...p, state: st });
    return { ...this._illView(g, p, st, pet, now), recovered };
  }
  // cmd: { cmd: 'set', state?, lamp?, screen?, query?, stop?, next?, from } · { cmd: 'tick' } (the page's timer)
  // · { cmd: 'seen' } · { cmd: 'state' } · { cmd: 'hold' }; with testMode also { cmd: 'scale', k }
  // → { ok, … the room view, path, settled, started, lampChanged, completed, line } | { ok: false, reason, … }
  illustratedCommand(id, cmd, pet, { now = Date.now(), testMode = false } = {}) {
    const g = this.load(id);
    if (!g || g.manifest.engine !== IRP.ENGINE || !cmd || typeof cmd.cmd !== 'string') return { ok: false, reason: 'invalid' };
    const p = GS.readProgress(this.userDir, id);
    const st = IRP.restore(g.manifest, p.state, now);
    if (!st) return { ok: false, reason: 'invalid' };
    const room = IRP.roomOf(g.manifest, st.room);
    const save = (next) => GS.writeProgress(this.userDir, id, { ...p, state: next });
    const out = (next, extra) => ({ ok: true, ...extra, ...this._illView(g, p, next, pet, now) });
    switch (cmd.cmd) {
      case 'state': return out(st, {});
      case 'hold': { const next = IRP.holdClip(st, g.manifest, now); save(next); return out(next, {}); } // a chat turn that changed nothing still talks about the clip on the screen
      case 'seen': if (st.run) { st.run.seenAt = now; save(st); } return out(st, {});
      case 'scale': {
        if (!testMode) return { ok: false, reason: 'test-only' };
        st.scale = Math.max(0.01, Math.min(1, Number(cmd.k) || 1));
        save(st);
        return out(st, { scale: st.scale });
      }
      case 'tick': {
        const r = IRP.tick(st, { manifest: g.manifest, now });
        if (!r) return out(st, { settled: null, early: !!st.run });
        const settled = this._book(id, g, p, r.st, r.settled, pet, {});
        save(r.st);
        return out(r.st, { settled, path: r.path, from: r.from, to: r.to, line: IRP.line(room, 'done') || settled.summary });
      }
      case 'set': {
        const from = ['chat', 'click', 'key', 'hotspot'].includes(cmd.from) ? cmd.from : 'click';
        const c = { state: typeof cmd.state === 'string' ? cmd.state.slice(0, 32) : null, stop: !!cmd.stop, next: !!cmd.next, from };
        if (typeof cmd.lamp === 'boolean') c.lamp = cmd.lamp;
        if (typeof cmd.screen === 'string' && IRPack.CONTENT.includes(cmd.screen)) c.screen = cmd.screen;
        if (typeof cmd.query === 'string' && cmd.query.trim()) c.query = cmd.query.trim().slice(0, 40);
        const stats = this._stats(st, pet);
        const r = IRP.command(st, c, { manifest: g.manifest, now, stats, scale: testMode && Number.isFinite(st.scale) ? st.scale : 1 });
        if (!r.ok && r.reason !== 'tired') return { ...r, st: undefined, ...this._illView(g, p, st, pet, now) };
        const next = r.st;
        const settled = r.ok && r.settled ? this._book(id, g, p, next, r.settled, pet, {}) : null;
        const completed = [];
        if (r.lampChanged) completed.push(...this._illQuest(g, p, { type: 'lamp', to: next.lamp }, pet));
        if (r.ok && from === 'chat' && !r.already) completed.push(...this._illQuest(g, p, { type: 'chat-command' }, pet));
        if (r.ok && r.to !== r.from) completed.push(...this._illQuest(g, p, { type: 'state', kind: IRP.activityOf(room, r.to) || '' }, pet));
        save(next);
        if (!r.ok) return { ok: false, reason: r.reason, need: r.need, have: r.have, kind: r.kind, lampChanged: r.lampChanged, line: IRP.line(room, 'tired'), completed, ...this._illView(g, p, next, pet, now) };
        const act = IRP.activityOf(room, next.state);
        const line = r.to !== r.from ? IRP.line(room, 'ack', act) : r.lampChanged ? IRP.line(room, next.lamp ? 'lampOn' : 'lampOff') : '';
        return out(next, { from: r.from, to: r.to, path: r.path, settled, started: r.started, lampChanged: r.lampChanged, already: r.already, completed, line, via: from });
      }
      default: return { ok: false, reason: 'invalid' };
    }
  }
  // the note for this chat turn's prompt (core/illustrated-room-play.js chatNote); r: what the message did, heard: 'unsure'
  illustratedNote(id, r, { now = Date.now(), heard = null } = {}) {
    const g = this.load(id);
    if (!g || g.manifest.engine !== IRP.ENGINE) return '';
    const st = IRP.restore(g.manifest, GS.readProgress(this.userDir, id).state, now);
    return IRP.chatNote(g.manifest, st, r, { now, heard });
  }
  // the game window closed / the app quits with a round running: settled by how long it ran; she stays where she is
  illustratedClose(id, pet, { now = Date.now() } = {}) {
    const g = this.load(id);
    if (!g || g.manifest.engine !== IRP.ENGINE) return null;
    const p = GS.readProgress(this.userDir, id);
    const st = IRP.restore(g.manifest, p.state, now);
    if (!st || !st.run) return null;
    const s = RP.settle(st.run, now, RP.defsOf(g.manifest));
    st.run = null;
    const settled = s ? this._book(id, g, p, st, s, pet, {}) : null;
    GS.writeProgress(this.userDir, id, { ...p, state: st });
    return settled;
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
      const named = new Set(GP.namedFiles(g.manifest));
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
  // a remote screenshot's cache file: named after the file in the repository, so a new picture is a new file
  shotFile(g, url) { return path.join(this.coverDir, `${g.id}-shot-${path.basename(url)}`); }
  async _fetchTo(url, file) {
    if (fs.existsSync(file)) return;
    try {
      const res = await this.fetch(url);
      if (!res.ok) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) return;
      fs.mkdirSync(this.coverDir, { recursive: true });
      fs.writeFileSync(file, buf);
    } catch { /* not shown */ }
  }
  async _covers() {
    for (const g of this.index().games) {
      if (g.source === 'remote' && g.picture && !g.bundledPicture) await this._fetchTo(g.picture, this.coverFile(g));
      for (const s of g.screenshots || []) if (/^https:/.test(s.url)) await this._fetchTo(s.url, this.shotFile(g, s.url));
    }
  }
  _dataUrl(file) {
    return `data:image/${path.extname(file) === '.png' ? 'png' : 'webp'};base64,${fs.readFileSync(file).toString('base64')}`;
  }
  // 详情页的预览: [{ src, caption }] — shipped ones from src/renderer, remote ones from the cache; one not fetched
  // yet falls back to the shipped screenshot in its place, if there is one
  shots(row) {
    const out = [];
    (row.screenshots || []).forEach((s, i) => {
      if (!/^https:/.test(s.url)) { out.push({ src: `../renderer/${s.url}`, caption: s.caption }); return; }
      const f = this.shotFile(row, s.url);
      if (fs.existsSync(f)) out.push({ src: this._dataUrl(f), caption: s.caption });
      else if (row.bundledScreenshots && row.bundledScreenshots[i]) out.push({ src: `../renderer/${row.bundledScreenshots[i].url}`, caption: s.caption });
    });
    return out;
  }
  // what <img src> the settings window gets: the shipped picture, else the cached remote one, else none
  pictureSrc(row) {
    if (row.source === 'bundled' && row.picture) return `../renderer/${row.picture}`;
    if (row.bundledPicture) return `../renderer/${row.bundledPicture}`;
    if (!row.picture) return null;
    const f = this.coverFile(row);
    return fs.existsSync(f) ? this._dataUrl(f) : null;
  }

  rows(installed, downloads) {
    return GI.storeRows(this.index(), installed, downloads, this.ctx()).map((r) => ({ ...r, pictureSrc: this.pictureSrc(r) }));
  }
  updates(installed) { return GI.updates(this.index(), installed, this.ctx()); }
}
GameIndex.REFRESH_MS = 10 * 60 * 1000;

module.exports = { GameLibrary, GameIndex };
