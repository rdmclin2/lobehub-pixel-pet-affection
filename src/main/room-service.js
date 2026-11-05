'use strict';

// 房间小游戏 (docs/room.md) on top of PetService: which room is shown, and the activities in it, kept in the pet
// save. Electron-free (test/room.test.js drives it with a fake lh). The numbers it moves are her base's entry
// (`pet.characters[base]`: energy, mood, hunger, plus `room.focus`), so the pet window sees the same ones.
const aff = require('../core/affection');
const room = require('../core/room');

class RoomService {
  // `service`: the PetService; `roundMs`: one round of an activity (e2e runs shorten it)
  constructor(service, { roundMs = room.ROUND_MS } = {}) {
    this.svc = service;
    this.roundMs = roundMs > 0 ? roundMs : room.ROUND_MS;
  }

  // The room on screen: the one picked last, else the current character's own.
  themeId() {
    const p = this.svc.pet;
    if (p && room.themeById(p.roomTheme)) return p.roomTheme;
    return room.themeFor(p ? p.speciesId : null).id;
  }

  // Whose numbers the room moves: its character's entry, once she is met (null: not met yet).
  _owner(theme) {
    const p = this.svc.pet;
    return (p && p.characters && p.characters[theme.character]) || null;
  }

  _opts(theme) {
    return { roundMs: this.roundMs, theme };
  }

  // What the console shows (main.js adminState → `room`): the definitions, the room picked, whose it is and her numbers.
  state() {
    const p = this.svc.pet;
    const theme = room.themeById(this.themeId());
    const owner = theme ? this._owner(theme) : null;
    return {
      ...room.catalog(),
      theme: theme.id,
      owner: { character: theme.character, met: !!owner, name: owner ? owner.name : null, current: !!p && p.speciesId === theme.character },
      view: owner && theme.status === 'open' ? room.view(owner, this.svc.now(), { roundMs: this.roundMs }) : null,
    };
  }

  _done(r) {
    this.svc._save(); // saves and pushes the new view (main.js → pushAdmin)
    return { ...r, room: this.state() };
  }

  // 切换房间类型: any theme may be looked at (a 即将开放 one shows its preview); the pick is saved.
  setTheme(id) {
    if (!this.svc.pet) return { ok: false, reason: 'no-pet' };
    if (!room.themeById(id)) return { ok: false, reason: 'bad-theme' };
    this.svc.pet.roomTheme = id;
    return this._done({ ok: true });
  }

  _playable() {
    if (!this.svc.pet) return { error: 'no-pet' };
    const theme = room.themeById(this.themeId());
    if (theme.status !== 'open') return { error: 'soon' };
    const owner = this._owner(theme);
    if (!owner) return { error: 'not-met' };
    return { theme, owner };
  }

  // A whole round of 打游戏 scores like 玩耍 on the desktop (daily-capped there): the room is time with her too.
  _score(owner, settled) {
    if (!settled || !settled.complete || settled.kind !== 'game') return null;
    const r = aff.gainAffection(owner, 'play', this.svc.now());
    if (owner === this.svc._c()) this.svc._reportAffection(r);
    return r;
  }

  // Start an activity (a running one is settled first). -> { ok, reason?, activity, settled, line, room }
  start(kind) {
    const { error, theme, owner } = this._playable();
    if (error) return { ok: false, reason: error, room: this.svc.pet ? this.state() : null };
    const r = room.start(owner, kind, this.svc.now(), this._opts(theme));
    if (r.reason === 'bad-activity') return { ...r, room: this.state() };
    const affection = this._score(owner, r.settled);
    return this._done({ ...r, action: room.ACTIVITIES[kind].action, affection });
  }

  // A round that ran out while the app was closed (重开时已满一轮) is settled at once, as a whole round, for every
  // character with one (each room keeps its own). Called when the app starts (main.js boot), before any window
  // shows her numbers. -> the settled results ([] when there was none).
  settleDue() {
    const p = this.svc.pet;
    if (!p || !p.characters) return [];
    const now = this.svc.now();
    const out = [];
    for (const [id, owner] of Object.entries(p.characters)) {
      const a = owner && owner.room && owner.room.activity;
      if (!a || now - a.startedAt < this.roundMs) continue;
      const theme = room.themeById(id);
      const settled = room.settle(owner, now, this._opts(theme));
      if (!settled) continue;
      this._score(owner, settled);
      out.push({ character: id, ...settled });
    }
    if (out.length) this.svc._save();
    return out;
  }

  // End the running activity: finished (a whole round) or stopped early. -> { ok, settled, room }
  stop() {
    const { error, theme, owner } = this._playable();
    if (error) return { ok: false, reason: error, room: this.svc.pet ? this.state() : null };
    const settled = room.settle(owner, this.svc.now(), this._opts(theme));
    const affection = this._score(owner, settled);
    return this._done({ ok: true, settled, affection });
  }
}

module.exports = { RoomService };
