'use strict';
// 小游戏 · 每日小事 (docs/mini-games.md §6). A game pack lists small things to do with her ("quests"); each real
// day DAILY of them are picked (the same pick all day, from the date), and each one is done when the page reports
// matching events often enough: { type: 'use-end', obj: 'plot-a' } in the right phase / weather, { type:
// 'collect', item: 'firefly' }, { type: 'activity-end', kind: 'sleep', theme, complete } (她的房间) … Done quests give her affection once (main adds it through PetService). Progress
// is a small JSON object kept per game in settings (games.progress[<id>]); a new day starts it over, except the
// lifetime totals (`total`: how many quests ever, `items`: what was ever collected).
// Pure and DOM-free (window.GameQuests in the page, require() in main and the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameQuests = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAILY = 3;
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hash = (str) => { let h = 2166136261; for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

  function fresh(progress, day) {
    const p = progress && typeof progress === 'object' ? progress : {};
    const total = Number.isFinite(p.total) ? p.total : 0;
    const items = p.items && typeof p.items === 'object' ? { ...p.items } : {};
    // seen: for a quest counted by distinct kinds (她的房间「五件事各做一次」), the kinds already counted
    if (p.day === day) return { day, counts: { ...(p.counts || {}) }, done: [...(p.done || [])], total, items, ...(p.seen ? { seen: Object.fromEntries(Object.entries(p.seen).map(([k, v]) => [k, [...v]])) } : {}) };
    return { day, counts: {}, done: [], total, items };
  }

  // today's quests: DAILY of the pack's, picked by the date (a quest marked `always` is always in)
  function todays(quests, day) {
    const list = (quests || []).slice();
    const always = list.filter((q) => q.always);
    const rest = list.filter((q) => !q.always).sort((a, b) => hash(`${day}:${a.id}`) - hash(`${day}:${b.id}`));
    return [...always, ...rest].slice(0, Math.max(DAILY, always.length));
  }

  const matches = (on, ev, ctx) => {
    if (!on || on.type !== ev.type) return false;
    if (on.obj && on.obj !== ev.obj && !(Array.isArray(on.obj) && on.obj.includes(ev.obj))) return false;
    if (on.item && on.item !== ev.item) return false;
    if (on.phase && ![].concat(on.phase).includes(ctx.phase)) return false;
    if (on.weather && ![].concat(on.weather).includes(ctx.weather)) return false;
    // 她的房间 (room@1): which activity, in which room, finished or not
    if (on.kind && ![].concat(on.kind).includes(ev.kind)) return false;
    if (on.theme && ![].concat(on.theme).includes(ev.theme)) return false;
    if (typeof on.complete === 'boolean' && on.complete !== !!ev.complete) return false;
    return true;
  };

  // → { progress, completed: [quest…] }  (progress is a new object; the old one is not touched)
  function record(quests, progress, ev, ctx = {}) {
    const day = ctx.day || dayKey(ctx.date || new Date());
    const p = fresh(progress, day);
    if (ev.type === 'collect' && ev.item) p.items[ev.item] = (p.items[ev.item] || 0) + 1;
    const completed = [];
    for (const q of todays(quests, day)) {
      if (p.done.includes(q.id) || !matches(q.on, ev, ctx)) continue;
      if (q.distinct === 'kind') {
        p.seen = p.seen || {};
        const seen = (p.seen[q.id] = p.seen[q.id] || []);
        if (!ev.kind || seen.includes(ev.kind)) continue;
        seen.push(ev.kind);
      }
      p.counts[q.id] = (p.counts[q.id] || 0) + 1;
      if (p.counts[q.id] >= (q.count || 1)) {
        p.done.push(q.id);
        p.total += 1;
        completed.push(q);
      }
    }
    return { progress: p, completed };
  }

  // what the card shows: today's quests with how far along each is
  function view(quests, progress, day = dayKey()) {
    const p = fresh(progress, day);
    return todays(quests, day).map((q) => ({ id: q.id, title: q.title, hint: q.hint || '', count: q.count || 1, n: Math.min(q.count || 1, p.counts[q.id] || 0), done: p.done.includes(q.id), reward: (q.reward && q.reward.affection) || 0 }));
  }

  return { DAILY, dayKey, fresh, todays, record, view };
});
