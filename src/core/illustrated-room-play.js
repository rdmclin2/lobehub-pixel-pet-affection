'use strict';
// 她的房间 · 状态机 (docs/illustrated-room.md §3, design §6). What she is doing in her room — one state of the room
// (a whole illustration: in bed with her phone, at the desk with the laptop, asleep …), the desk lamp on or off,
// what her screen plays — and how one command (a click on the status bar or the picture, or a sentence in chat,
// core/room-intent.js) changes it. Main is the only authority (src/main/games.js illustratedCommand); the page only
// plays what it is told. The numbers are 像素房间's (core/room-play.js): a state's `activity` is one of its five
// kinds and runs as one round; 发呆 (idle) is not timed and moves nothing.
//
//   st   { engine, room, state, lamp, screen, query, clip, since, run, last, focus, totals }
//
// Pure and DOM-free; every function takes `now` (ms). window.IllustratedRoomPlay in the page, require() in main.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./room-play'));
  else root.IllustratedRoomPlay = factory(root.RoomPlay);
})(typeof self !== 'undefined' ? self : this, function (RoomPlay) {
  const ENGINE = 'illustrated-room@1';
  const KINDS = ['sleep', 'work', 'phone', 'music', 'game', 'idle'];
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  // what she has just done, for her reply (the room note in the prompt) and the ack line when there is no reply
  const DOING = {
    sleep: '回到床上，钻进被子躺下了',
    work: '坐到书桌前，打开了笔记本电脑',
    phone: '趴在床上拿起了手机',
    music: '戴上耳机放起了歌',
    game: '坐到书桌前开了一局游戏',
    idle: '坐在床上，什么也不干，发起了呆',
  };
  const ACK = {
    sleep: ['回来了，躺下了。'],
    work: ['开了，在弄呢。'],
    phone: ['在刷呢，别催。'],
    music: ['放上了，好听。'],
    game: ['来一局！'],
    idle: ['……就发会儿呆。'],
  };

  // the room to play: the one asked for when it is open, else the manifest's default
  function roomOf(manifest, id) {
    const rooms = (manifest && Array.isArray(manifest.rooms) ? manifest.rooms : []).filter((r) => r && r.status === 'open');
    return rooms.find((r) => r.id === id) || rooms.find((r) => r.id === (manifest && manifest.defaultRoom)) || rooms[0] || null;
  }
  const stateOf = (room, key) => (room && isObj(room.states) && isObj(room.states[key]) ? room.states[key] : null);
  const activityOf = (room, key) => { const s = stateOf(room, key); return s ? s.activity || null : null; };

  // a state key or an activity → the state to show: the key itself (not a transient one), else the state named
  // after the activity, else the first state of that activity
  function resolve(room, want) {
    if (!room || typeof want !== 'string' || !want) return null;
    const s = stateOf(room, want);
    if (s && !s.transient) return want;
    if (!KINDS.includes(want)) return null;
    const named = stateOf(room, want);
    if (named && !named.transient && named.activity === want) return want;
    const k = Object.keys(room.states || {}).find((x) => !room.states[x].transient && room.states[x].activity === want);
    return k || null;
  }

  // the states on the way: 床 → 书桌 goes through the target's `enterVia` (起身) when the two are in different zones
  // (state.zone, default: by activity — work / game at the desk, the rest in bed); leaving the desk the same way
  const ZONE = { work: 'desk', game: 'desk' };
  const zoneOf = (room, key) => { const s = stateOf(room, key); return s ? s.zone || ZONE[s.activity] || 'bed' : null; };
  function path(room, from, to) {
    if (!to || from === to) return to ? [to] : [];
    const a = stateOf(room, from);
    const b = stateOf(room, to);
    if (!b) return [];
    if (a && zoneOf(room, from) !== zoneOf(room, to)) {
      const via = b.enterVia || a.enterVia;
      if (via && stateOf(room, via) && stateOf(room, via).transient) return [via, to];
    }
    return [to];
  }

  // what each screen of a state plays: { <screen id>: content } — the state's own, or `screen` (what the owner asked
  // for: 「打开电脑刷抖音」 → clips) on the state's first screen that is on
  function screensFor(room, key, screen = null) {
    const s = stateOf(room, key);
    const out = {};
    if (!s || !isObj(s.screens)) return out;
    let used = false;
    for (const [id, sc] of Object.entries(s.screens)) {
      if (!sc || sc.on === false) continue;
      if (screen && !used && sc.content !== 'lock' && sc.content !== 'off') { out[id] = screen; used = true; } else out[id] = sc.content;
    }
    return out;
  }

  // a saved state (progress file) → a valid one: written by another engine (a 像素房间 save under the same id while
  // the game was in development), a room or state no longer in the manifest → back to the room's default
  function restore(manifest, saved, now) {
    const s = isObj(saved) && saved.engine === ENGINE ? saved : {};
    const room = roomOf(manifest, s.room);
    if (!room) return null;
    const lampDefault = !!(room.lighting && room.lighting.lamp && room.lighting.lamp.default);
    const state = resolve(room, s.state) || room.defaultState;
    return {
      engine: ENGINE,
      room: room.id,
      state,
      lamp: typeof s.lamp === 'boolean' ? s.lamp : lampDefault,
      screen: typeof s.screen === 'string' ? s.screen : null,
      query: typeof s.query === 'string' ? s.query.slice(0, 40) : null,
      clip: Number.isInteger(s.clip) ? s.clip : 0,
      since: Number.isFinite(s.since) ? s.since : now,
      run: isObj(s.run) && s.run.theme === room.id ? { ...s.run } : null,
      last: s.last || null,
      focus: isObj(s.focus) ? { ...s.focus } : {},
      totals: isObj(s.totals) ? JSON.parse(JSON.stringify(s.totals)) : {},
      ...(Number.isFinite(s.scale) ? { scale: s.scale } : {}),
    };
  }

  // one command. cmd: { state?, lamp?, screen?, query?, stop?, next?, from } (from: 'chat' | 'click' | 'key' | 'tick')
  // ctx: { manifest, now, stats (her numbers, for 精力不够), scale (test mode: rounds k× as long) }
  // → { ok: true, st, from, to, path, settled, started, lampChanged, already } |
  //   { ok: false, reason: 'unknown' | 'tired', need, have, st (the lamp still changes) }
  function command(st, cmd, { manifest, now, stats = {}, scale = 1 }) {
    const room = roomOf(manifest, st && st.room);
    if (!room || !st || !isObj(cmd)) return { ok: false, reason: 'invalid' };
    const defs = RoomPlay.defsOf(manifest);
    const next = { ...st, run: st.run ? { ...st.run } : null };
    const lampBefore = !!st.lamp;
    if (typeof cmd.lamp === 'boolean') next.lamp = cmd.lamp;
    let target = st.state;
    if (cmd.stop) target = room.defaultState;
    else if (cmd.state) {
      target = resolve(room, String(cmd.state));
      if (!target) return { ok: false, reason: 'unknown', st: next, lampChanged: next.lamp !== lampBefore };
    }
    const changed = target !== st.state;
    let settled = null;
    let started = null;
    if (changed) {
      const kind = activityOf(room, target);
      if (kind && kind !== 'idle' && defs[kind]) {
        const r = RoomPlay.start(st.run, kind, now, defs, stats, { theme: room.id, scale });
        if (!r.ok) return { ok: false, reason: r.reason, need: r.need, have: r.have, kind, st: next, lampChanged: next.lamp !== lampBefore };
        settled = r.settled || null;
        if (!r.already) { next.run = r.run; started = kind; }
      } else {
        settled = st.run ? RoomPlay.settle(st.run, now, defs) : null;
        next.run = null;
      }
      next.state = target;
      next.since = now;
      if (typeof cmd.lamp !== 'boolean' && stateOf(room, target).lampOnEnter === true) next.lamp = true;
      next.screen = null;
      next.query = null;
      next.clip = 0;
    }
    if (typeof cmd.screen === 'string' && cmd.screen) next.screen = cmd.screen;
    if (typeof cmd.query === 'string' && cmd.query) { next.query = cmd.query.slice(0, 40); if (!cmd.screen) next.screen = 'page'; }
    if (cmd.next) next.clip = (st.clip || 0) + 1;
    const already = !changed && next.screen === st.screen && next.query === st.query && next.lamp === lampBefore && !cmd.next;
    return { ok: true, st: next, from: st.state, to: next.state, path: changed ? path(room, st.state, next.state) : [], settled, started, lampChanged: next.lamp !== lampBefore, already };
  }

  // the page's timer says the round is over: when main's clock agrees it is settled and she goes back to her
  // default state (发呆). → { st, settled, path } | null
  function tick(st, { manifest, now }) {
    const room = roomOf(manifest, st && st.room);
    if (!room || !st || !st.run) return null;
    const s = RoomPlay.tick(st.run, now, RoomPlay.defsOf(manifest));
    if (!s) return null;
    const next = { ...st, run: null, state: room.defaultState, since: now, screen: null, query: null, clip: 0 };
    return { st: next, settled: s, from: st.state, to: next.state, path: path(room, st.state, next.state) };
  }

  // for the page and the prompt: → { state, activity, label, lamp, screens, run (core/room-play view) }
  function view(st, { manifest, now }) {
    const room = roomOf(manifest, st && st.room);
    if (!room || !st) return null;
    const s = stateOf(room, st.state) || {};
    const defs = RoomPlay.defsOf(manifest);
    return { room: room.id, state: st.state, activity: s.activity || null, label: s.label || '', lamp: !!st.lamp, screen: st.screen, query: st.query, clip: st.clip || 0, screens: screensFor(room, st.state, st.screen), since: st.since, run: st.run ? { ...RoomPlay.view(st.run, now, defs), startedAt: st.run.startedAt } : null };
  }

  const pick = (list, rnd = Math.random) => (Array.isArray(list) && list.length ? list[Math.floor(rnd() * list.length) % list.length] : '');
  // a line: the room's lines.<key>[.<sub>], else the engine's own
  function line(room, key, sub = null, rnd = Math.random) {
    const L = (room && room.lines) || {};
    const own = sub ? L[key] && L[key][sub] : L[key];
    if (Array.isArray(own) && own.length) return pick(own, rnd);
    if (key === 'ack' && sub) return pick(ACK[sub], rnd);
    if (key === 'tired') return '好累……先让我睡一会儿吧。';
    if (key === 'lampOn') return '开灯啦。';
    if (key === 'lampOff') return '关了，屋里好蓝。';
    return '';
  }

  // what the screen shows, in words (for her reply)
  function screenWords(room, v) {
    const C = (room && room.content) || {};
    const parts = [];
    for (const [id, c] of Object.entries(v.screens || {})) {
      const where = id === 'laptop' ? '电脑屏幕上' : id === 'phone' ? '手机上' : '屏幕上';
      if (c === 'clips') {
        const list = (C.clips && C.clips.list) || [];
        const clip = list.length ? list[(v.clip || 0) % list.length] : null;
        parts.push(`${where}在刷短视频${clip && clip.caption ? `，现在这条是「${clip.caption}」` : ''}`);
      } else if (c === 'page') parts.push(v.query ? `${where}打开了搜索「${v.query}」的网页` : `${where}开着${(C.page && C.page.templates && C.page.templates[0] && C.page.templates[0].title) || '文档'}`);
      else if (c === 'player') { const t = (C.player && C.player.tracks && C.player.tracks[0]) || null; parts.push(`${where}在放${t ? `《${t.title}》${t.artist ? `（${t.artist}）` : ''}` : '歌'}`); }
      else if (c === 'game') parts.push(`${where}是游戏画面`);
    }
    return parts.join('，');
  }

  // the note that goes into this turn's prompt (persona.buildChatPrompt `room`), so her reply matches the picture
  // r: what command() did for this message (null: nothing was asked, the note only says where she is)
  function chatNote(manifest, st, r, { now = Date.now() } = {}) {
    const room = roomOf(manifest, st && st.room);
    if (!room || !st) return '';
    const v = view(st, { manifest, now });
    const scene = `你在自己的房间「${room.name}」里，${room.blurb ? `${String(room.blurb).replace(/[。.]$/, '')}。` : ''}台灯${v.lamp ? '开着' : '关着'}`;
    const label = (s) => (stateOf(room, s) && stateOf(room, s).label) || s;
    if (r && r.ok === false && r.reason === 'tired') return `[房间] ${scene}。主人刚让你去${label(resolve(room, r.kind) || r.kind)}，但你太累了（精力 ${r.have}，至少要 ${r.need}），没有去，还在${label(st.state)}。用一两句话告诉主人你累了，想先睡一会儿。`;
    const screen = screenWords(room, v);
    if (r && r.ok && !r.already) {
      const did = [];
      if (r.to && r.to !== r.from) did.push((stateOf(room, r.to) && stateOf(room, r.to).doing) || DOING[v.activity] || `开始${label(r.to)}`);
      if (r.lampChanged) did.push(v.lamp ? '把台灯打开了' : '把台灯关了');
      if (!did.length && screen) did.push('换了屏幕上的内容');
      return `[房间] ${scene}。主人刚在聊天里叫你做事，你已经${did.join('，')}${screen ? `；${screen}` : ''}。用一两句话回应主人，像刚做完这件事，可以提一句屏幕上看到的东西。`;
    }
    return `[房间] ${scene}，你正在${label(st.state)}${screen ? `，${screen}` : ''}。`;
  }

  return { ENGINE, KINDS, DOING, ACK, roomOf, stateOf, activityOf, resolve, zoneOf, path, screensFor, restore, command, tick, view, line, screenWords, chatNote };
});
