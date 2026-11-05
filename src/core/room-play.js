'use strict';
// 她的房间 · 活动与结算 (docs/her-room-design.md §2). Five activities — 睡觉 / 工作 / 看手机 / 听音乐 / 打游戏 —
// each one round long. A round ends one of three ways, and each one settles into her four numbers:
//   done      the round's time is up (tick): fraction 1
//   stopped   结束, another click on the same furniture, a click on the floor, lifting her, switching rooms,
//             closing the game window: fraction = how much of the round went by (at least MIN_FRACTION)
//   switched  another activity was started: the one before is settled first, the same way as stopped
// A round still open when the app went away (a crash, a kill) is settled the next time the game boots
// (recover): as done when a whole round has gone by since it started, else by the time it last saved.
//
// Her numbers (0–100): 精力 energy, 心情 mood (the pet's own), 饱腹 fullness (100 − her hunger), 专注 focus (this
// game's own, kept in its progress file). How much a round moves them is the manifest's top-level `activities`
// (bounded by core/room-pack.js); a room theme cannot change them.
// Pure and DOM-free; every function takes `now` (ms). window.RoomPlay in the page, require() in main and tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomPlay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const KINDS = ['sleep', 'work', 'phone', 'music', 'game'];
  const STATS = ['energy', 'mood', 'focus', 'fullness'];
  const STAT_LABEL = { energy: '精力', mood: '心情', focus: '专注', fullness: '饱腹' };
  // a round stopped right after it started still counts a little: the owner sees that it did something
  const MIN_FRACTION = 0.25;
  // the page's timer and main's clock may be a frame apart: a tick this close to the end counts as the end
  const TICK_SLACK_MS = 300;
  const FOCUS_START = 50;
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)));
  const num = (v) => typeof v === 'number' && Number.isFinite(v);

  // Lines when neither the room nor the manifest has any (PR #151's)
  const LINES = {
    sleep: { doing: ['呼……呼……', '睡一会儿就好……'], done: ['睡饱了，精神满满！'] },
    work: { doing: ['专心中，别打扰哦。', '这一段马上写完。'], done: ['今天的活干完啦！'] },
    phone: { doing: ['刷到一个好好笑的视频～', '再看一条就放下。'], done: ['好啦，手机放下了。'] },
    music: { doing: ['这首歌好好听～', '跟着节奏晃一晃。'], done: ['听完这张唱片了，心情超好。'] },
    game: { doing: ['冲呀！', '这关有点难……'], done: ['赢啦！再来一局？'] },
    tired: ['好累……先睡一会儿再说吧。'],
  };

  // the five activities' numbers from a room@1 manifest (already validated): { <kind>: { kind, label, verb,
  // anim, seconds, deltas, needs } }
  function defsOf(manifest) {
    const acts = (manifest && manifest.activities) || {};
    const out = {};
    for (const k of KINDS) {
      const a = acts[k] || {};
      const deltas = {};
      for (const s of STATS) if (num(a.deltas && a.deltas[s]) && a.deltas[s]) deltas[s] = Math.max(-40, Math.min(40, a.deltas[s]));
      out[k] = { kind: k, label: String(a.label || k), verb: String(a.verb || a.label || k), anim: a.anim || 'idle', seconds: Math.max(5, Math.min(600, num(a.seconds) ? a.seconds : 30)), deltas, needs: { energy: num(a.needs && a.needs.energy) ? a.needs.energy : 0 } };
    }
    return out;
  }

  const elapsedMs = (run, now) => Math.max(0, now - run.startedAt);
  // the round's length: what main fixed when it started (run.seconds), within the activity's bounds
  const roundS = (run, defs) => {
    const d = defs[run.kind];
    const s = num(run.seconds) && run.seconds > 0 ? run.seconds : d ? d.seconds : 30;
    return Math.max(0.5, Math.min(600, s));
  };
  const scaled = (deltas, f) => Object.fromEntries(Object.entries(deltas || {}).map(([k, v]) => [k, Math.round(v * f)]).filter(([, v]) => v));

  // how a round ends at `now` (or at `asOf`, when what is known is only when it was last seen): → { kind, theme,
  // complete, fraction, seconds, elapsed, deltas (whole round × fraction), at }
  function settle(run, now, defs, { asOf = null } = {}) {
    if (!run || !defs[run.kind]) return null;
    const secs = roundS(run, defs);
    const el = elapsedMs(run, now) / 1000;
    const complete = el >= secs - TICK_SLACK_MS / 1000;
    const counted = asOf !== null && !complete ? Math.max(0, asOf - run.startedAt) / 1000 : el;
    const fraction = complete ? 1 : Math.max(MIN_FRACTION, Math.min(1, Math.round((counted / secs) * 100) / 100));
    return { kind: run.kind, theme: run.theme || null, complete, fraction, seconds: secs, elapsed: Math.round(Math.min(complete ? secs : counted, secs) * 1000), deltas: scaled(defs[run.kind].deltas, fraction), at: now };
  }

  // the numbers after a settlement, each held to 0–100, and what really changed (the part held back is not shown)
  function apply(stats, deltas) {
    const next = { ...stats };
    const changed = {};
    for (const s of STATS) {
      const from = clamp(num(stats && stats[s]) ? stats[s] : s === 'focus' ? FOCUS_START : 50);
      const to = clamp(from + ((deltas && deltas[s]) || 0));
      next[s] = to;
      if (to !== from) changed[s] = to - from;
    }
    return { stats: next, changed };
  }

  // start `kind` at `now`. A round already running is settled first (switched); starting the one already running
  // changes nothing. Too tired (energy, after the round before is settled, below the activity's needs): refused,
  // and nothing changes — the round before goes on.
  // → { ok, run, settled, stats, changed } | { ok: false, reason: 'tired' | 'unknown', need, have }
  function start(run, kind, now, defs, stats, { theme = null, scale = 1 } = {}) {
    const d = defs[kind];
    if (!d) return { ok: false, reason: 'unknown' };
    if (run && run.kind === kind && (!theme || run.theme === theme)) return { ok: true, already: true, run, settled: null, stats, changed: {} };
    const settled = run ? settle(run, now, defs) : null;
    const after = settled ? apply(stats, settled.deltas) : { stats: { ...stats }, changed: {} };
    const have = clamp(num(after.stats.energy) ? after.stats.energy : 0);
    if (d.needs.energy && have < d.needs.energy) return { ok: false, reason: 'tired', need: d.needs.energy, have };
    const seconds = Math.max(0.5, Math.round(d.seconds * (num(scale) && scale > 0 ? Math.min(1, scale) : 1) * 1000) / 1000);
    return { ok: true, run: { theme, kind, startedAt: now, seenAt: now, seconds }, settled, stats: after.stats, changed: after.changed };
  }

  // the page's timer says the round is over: settled only when main's clock agrees. → settlement | null
  function tick(run, now, defs) {
    if (!run) return null;
    return elapsedMs(run, now) >= roundS(run, defs) * 1000 - TICK_SLACK_MS ? settle(run, now, defs) : null;
  }

  // the game boots with a round left open (the app went away without settling it)
  function recover(run, now, defs) {
    if (!run || !defs[run.kind]) return null;
    const seen = num(run.seenAt) ? Math.min(run.seenAt, now) : run.startedAt;
    return { ...settle(run, now, defs, { asOf: seen }), recovered: true };
  }

  // for the page's timer and progress bars: → { kind, progress 0–1, elapsed, left, seconds } | null
  function view(run, now, defs) {
    if (!run || !defs[run.kind]) return null;
    const secs = roundS(run, defs);
    const el = Math.min(secs, elapsedMs(run, now) / 1000);
    return { kind: run.kind, theme: run.theme || null, progress: Math.min(1, el / secs), elapsed: el, left: Math.max(0, secs - el), seconds: secs };
  }

  // what a round would do at `fraction`, as the stats card's preview (the whole round's numbers × it)
  const preview = (kind, defs, fraction = 1) => (defs[kind] ? scaled(defs[kind].deltas, fraction) : {});

  // 睡觉完成：精力 +35，心情 +6 … / 睡觉先到这里（做了 40%）：精力 +14 …
  function summary(settled, defs, changed = settled && settled.deltas) {
    if (!settled) return '';
    const d = defs[settled.kind];
    const parts = STATS.filter((s) => changed && changed[s]).map((s) => `${STAT_LABEL[s]} ${changed[s] > 0 ? '+' : '−'}${Math.abs(changed[s])}`);
    const head = settled.complete ? `${d.label}完成` : `${d.label}先到这里（做了 ${Math.round(settled.fraction * 100)}%）`;
    return parts.length ? `${head}：${parts.join('，')}` : head;
  }

  // a line for `key` ('doing' / 'done' / 'enter' / 'idle' / 'tired' / 'touch' …): the room's, else the
  // manifest's, else the engine's own
  function lines(manifest, theme, kind, key) {
    const pickList = (l) => (Array.isArray(l) && l.length ? l : null);
    if (kind) {
      const t = theme && theme.activities && theme.activities[kind] && theme.activities[kind].lines;
      const m = manifest && manifest.activities && manifest.activities[kind] && manifest.activities[kind].lines;
      return pickList(t && t[key]) || pickList(m && m[key]) || (LINES[kind] && LINES[kind][key]) || [];
    }
    return pickList(theme && theme.lines && theme.lines[key]) || pickList(manifest && manifest.lines && manifest.lines[key]) || LINES[key] || [];
  }

  return { KINDS, STATS, STAT_LABEL, MIN_FRACTION, TICK_SLACK_MS, FOCUS_START, LINES, defsOf, settle, apply, start, tick, recover, view, preview, summary, lines };
});
