'use strict';
// 小游戏 · 她在场景里 (docs/mini-games.md §4). Her state machine in world px: idle → (roam or a click) walk along
// a GameWorld path → arrive → maybe use a thing (sit on the bench, water the plot …) for a while → idle. A click
// on her is a short react; holding her lifts her and dropping puts her on the nearest walkable point. Each step
// returns events for the page ({ type: 'arrive' | 'use-start' | 'use-end' | 'touch', obj?, use? }), which turns
// them into effects, lines and quest progress. `anim` is which of her pack's actions is shown (idle / walk / …).
// Pure and DOM-free (window.GamePet in the page, require() in the tests).
(function (root, factory) {
  const W = typeof module === 'object' && module.exports ? require('./game-world') : root.GameWorld;
  if (typeof module === 'object' && module.exports) module.exports = factory(W);
  else root.GamePet = factory(W);
})(typeof self !== 'undefined' ? self : this, function (GW) {
  const SPEED = 46; // world px / s
  const IDLE_MIN = 3.5;
  const IDLE_MAX = 8;
  const REACT_S = 1.6;

  // objects: [{ id, use?: { at: [x, y], face?: 'left'|'right', anim, seconds: [min, max], phases?: [...] } }]
  function createGamePet({ world, objects = [], rnd = Math.random, start = null, speed = SPEED } = {}) {
    const usable = objects.filter((o) => o.use && Array.isArray(o.use.at));
    const s0 = start && GW.walkableAt(world, start[0], start[1]) ? start : (() => {
      const c = GW.nearestOpen(world, world.width / 2, world.height / 2);
      return c ? GW.centerOf(world, c[0], c[1]) : [world.width / 2, world.height / 2];
    })();
    const s = {
      x: s0[0], y: s0[1], facing: 1, mode: 'idle', anim: 'idle', path: null, seg: 0, wait: IDLE_MIN + rnd() * (IDLE_MAX - IDLE_MIN),
      goal: null, // { kind: 'spot' | 'use', obj?, why: 'roam' | 'click' }
      using: null, // { obj, use, left }
      react: 0, walked: 0, steps: 0,
    };

    function setPath(path) {
      s.path = path;
      s.seg = 1;
      s.mode = 'walk';
      s.anim = 'walk';
    }
    function walkTo(x, y, goal) {
      if (s.mode === 'lifted') return { ok: false, reason: 'lifted' };
      const path = GW.findPath(world, s.x, s.y, x, y);
      if (!path) return { ok: false, reason: 'no-path' };
      s.using = null;
      s.goal = goal;
      // already there: a one-point walk, so the next step arrives (and starts using the thing) at once
      if (path.length < 2 || GW.pathLength(path) < 2) { setPath([[s.x, s.y], [s.x, s.y]]); return { ok: true, here: true, target: [s.x, s.y] }; }
      setPath(path);
      return { ok: true, target: path[path.length - 1] };
    }

    const goTo = (x, y, why = 'click') => walkTo(x, y, { kind: 'spot', why });
    function use(id, why = 'click') {
      const obj = usable.find((o) => o.id === id);
      if (!obj) return { ok: false, reason: 'not-usable' };
      if (s.using && s.using.obj.id === id) return { ok: true, already: true };
      const r = walkTo(obj.use.at[0], obj.use.at[1], { kind: 'use', obj, why });
      return r.ok ? { ...r, obj: id } : r;
    }

    function startUse(obj, events) {
      const u = obj.use;
      const [a, b] = u.seconds || [3, 3];
      s.using = { obj, use: u, left: a + rnd() * (b - a) };
      s.mode = 'use';
      s.anim = u.anim || 'idle';
      if (u.face === 'left') s.facing = -1;
      else if (u.face === 'right') s.facing = 1;
      events.push({ type: 'use-start', obj: obj.id, use: u });
    }
    function endUse(events, why = 'done') {
      if (!s.using) return;
      events.push({ type: 'use-end', obj: s.using.obj.id, use: s.using.use, why });
      s.using = null;
      s.mode = 'idle';
      s.anim = 'idle';
      s.wait = IDLE_MIN + rnd() * (IDLE_MAX - IDLE_MIN);
    }

    // what she picks when left alone: mostly a stroll, sometimes a thing that suits the hour
    function roam(ctx) {
      const can = usable.filter((o) => !o.use.phases || o.use.phases.includes(ctx.phase));
      if (can.length && rnd() < 0.32) {
        const o = can[Math.floor(rnd() * can.length) % can.length];
        if (use(o.id, 'roam').ok) return;
      }
      const p = GW.randomSpot(world, s.x, s.y, rnd);
      if (p) goTo(p[0], p[1], 'roam');
      else s.wait = IDLE_MIN;
    }

    // ctx: { phase, roam: bool }
    function step(dt, ctx = {}) {
      const events = [];
      if (s.mode === 'lifted') return events;
      if (s.react > 0) {
        s.react -= dt;
        if (s.react <= 0) { s.anim = s.mode === 'use' && s.using ? s.using.use.anim || 'idle' : s.mode === 'walk' ? 'walk' : 'idle'; }
        else return events;
      }
      if (s.mode === 'walk' && s.path) {
        let left = speed * dt;
        while (left > 0 && s.path) {
          const [tx, ty] = s.path[s.seg];
          const dx = tx - s.x;
          const dy = ty - s.y;
          const d = Math.hypot(dx, dy);
          if (Math.abs(dx) > 0.5) s.facing = dx < 0 ? -1 : 1;
          if (d <= left) {
            s.x = tx; s.y = ty; left -= d; s.walked += d;
            s.seg += 1;
            if (s.seg >= s.path.length) {
              s.path = null;
              s.mode = 'idle';
              s.anim = 'idle';
              s.steps += 1;
              const g = s.goal;
              s.goal = null;
              events.push({ type: 'arrive', obj: g && g.obj ? g.obj.id : null, why: g ? g.why : null, x: s.x, y: s.y });
              s.wait = IDLE_MIN + rnd() * (IDLE_MAX - IDLE_MIN);
              if (g && g.kind === 'use') startUse(g.obj, events);
            }
          } else {
            s.x += (dx / d) * left; s.y += (dy / d) * left; s.walked += left;
            left = 0;
          }
        }
        return events;
      }
      if (s.mode === 'use' && s.using) {
        s.using.left -= dt;
        if (s.using.left <= 0) endUse(events);
        return events;
      }
      if (s.mode === 'idle' && ctx.roam !== false) {
        s.wait -= dt;
        if (s.wait <= 0) roam(ctx);
      }
      return events;
    }

    function touch() {
      if (s.mode === 'lifted') return { ok: false, reason: 'lifted' };
      s.react = REACT_S;
      s.anim = 'happy';
      return { ok: true };
    }
    function lift() {
      if (s.mode === 'lifted') return { ok: false };
      const events = [];
      if (s.using) endUse(events, 'lifted');
      s.path = null;
      s.goal = null;
      s.react = 0;
      s.mode = 'lifted';
      s.anim = 'lifted';
      return { ok: true, events };
    }
    function moveLifted(x, y) { if (s.mode === 'lifted') { s.x = x; s.y = y; } }
    function drop(x, y) {
      if (s.mode !== 'lifted') return { ok: false };
      const c = GW.walkableAt(world, x, y) ? null : GW.nearestOpen(world, x, y);
      const p = c ? GW.centerOf(world, c[0], c[1]) : [x, y];
      s.x = p[0]; s.y = p[1];
      s.mode = 'idle';
      s.anim = 'idle';
      s.wait = IDLE_MIN + rnd() * (IDLE_MAX - IDLE_MIN);
      return { ok: true, x: s.x, y: s.y };
    }
    // stop whatever she is using (the page ends a sit when it gets light, etc.)
    function stopUse() { const ev = []; endUse(ev, 'stopped'); return ev; }

    const state = () => ({
      x: s.x, y: s.y, facing: s.facing, mode: s.mode, anim: s.anim,
      using: s.using ? s.using.obj.id : null,
      goal: s.goal ? { kind: s.goal.kind, obj: s.goal.obj ? s.goal.obj.id : null, why: s.goal.why } : null,
      target: s.path ? s.path[s.path.length - 1] : null,
      walked: s.walked, arrivals: s.steps,
    });

    return { step, goTo, use, touch, lift, moveLifted, drop, stopUse, state };
  }

  return { SPEED, IDLE_MIN, IDLE_MAX, REACT_S, createGamePet };
});
