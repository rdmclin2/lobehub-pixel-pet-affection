'use strict';
// 像素小院 · 她在小院里的行为状态机 (docs/pixel-scene-design.md §4.2). Plain logic, the time is passed in
// (tick(dt)), the random source is injected — so the tests drive it frame by frame.
//
//   idle ──(4–9 s, 「自己走动」on)──▶ wander (a walkable tile 3–6 tiles away, or 30 % a prop to use)
//   idle / wander / sit ──(click the ground)──▶ goto(target) ──arrive──▶ idle
//   any but lifted ──(click a prop)──▶ goto(spot) ──arrive, turn──▶ interact(act) ──done──▶ idle
//   any ──(press and drag her)──▶ lifted ──release──▶ the nearest walkable tile ──▶ idle (lands with pat)
//   any ──(click her)──▶ a short reaction where she stands
//
// `state` is always one of core/fx.js STATES (walk, idle, play, pat, look, lifted, sleep, happy), so every
// character pack can come into the yard; missing art falls back along Fx.FALLBACK as on the desktop.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./scene-map'));
  else root.ScenePet = factory(root.SceneMap);
})(typeof self !== 'undefined' ? self : this, function (SceneMap) {
  const SPEED = 24; // px/s: 1.5 tiles a second
  const IDLE_MIN = 4;
  const IDLE_MAX = 9;
  const PROP_CHANCE = 0.3;
  // how long each act lasts (s) and what she shows while doing it
  const ACTS = {
    sit: { state: 'idle', min: 20, max: 40 },
    water: { state: 'play', min: 2.5, max: 2.5 },
    lamp: { state: 'pat', min: 1.2, max: 1.2, at: 0.5 },
    look: { state: 'look', min: 3, max: 3 },
  };
  const SIT_SLEEP_AFTER = 8; // s sitting at night before she dozes off
  const REACT_S = 0.9;
  const LAND_S = 0.6;
  const ARRIVE_S = 0.8;
  const LOOK_CHANCE = 0.25; // an idle pause sometimes has her look around
  const SIT_LIFT = 4; // px: her feet on the bench seat sit this far above the bench's foot line

  function createScenePet({ map = SceneMap.createMap(), rnd = Math.random, roam = true, start = null } = {}) {
    const m = map;
    const at = start || SceneMap.tileCenter(m, 10, 6);
    const s = {
      x: at.x, y: at.y, facing: 'right', mode: 'idle', state: 'idle', act: null, prop: null, sitting: false,
      path: [], target: null, pendingProp: null, timer: IDLE_MIN + (IDLE_MAX - IDLE_MIN) * rnd(), actT: 0, actDur: 0, actFired: false,
      roam: !!roam, night: false, flash: null, flashT: 0, walked: 0,
    };
    const events = [];
    const emit = (e) => { events.push(e); if (events.length > 100) events.shift(); };
    const tileHere = () => SceneMap.tileOf(m, s.x, s.y);
    const idleAgain = (min = IDLE_MIN, max = IDLE_MAX) => {
      s.mode = 'idle'; s.state = 'idle'; s.act = null; s.prop = null; s.sitting = false; s.path = []; s.pendingProp = null;
      s.timer = min + (max - min) * rnd();
    };
    const flash = (state, sec) => { s.flash = state; s.flashT = sec; };

    // walk to tile (c, r): -> true when a path exists
    function walkTo(c, r, mode, prop = null) {
      const from = SceneMap.nearestWalkable(m, ...tileHere());
      const tiles = from && SceneMap.findPath(m, from, [c, r]);
      if (!tiles) return false;
      s.path = SceneMap.smoothPath(m, tiles, { x: s.x, y: s.y }).slice(1);
      s.target = SceneMap.tileCenter(m, c, r);
      s.mode = mode; s.state = 'walk'; s.act = null; s.sitting = false; s.pendingProp = prop; s.prop = null; s.flash = null;
      if (!s.path.length) arrive();
      return true;
    }
    function arrive() {
      s.path = [];
      const prop = s.pendingProp;
      if (prop) {
        const spec = ACTS[prop.act];
        s.mode = 'interact'; s.act = prop.act; s.prop = prop.id; s.pendingProp = null;
        s.facing = prop.face || s.facing;
        s.actT = 0; s.actDur = spec.min + (spec.max - spec.min) * rnd(); s.actFired = false;
        s.state = spec.state; s.sitting = prop.act === 'sit';
        emit({ type: 'act-start', act: prop.act, prop: prop.id });
      } else {
        const wasGoto = s.mode === 'goto';
        idleAgain();
        if (wasGoto) flash('happy', ARRIVE_S);
        emit({ type: 'arrive', goto: wasGoto, x: s.x, y: s.y });
      }
      s.target = null;
    }
    function wander() {
      const props = m.props.filter((p) => p.act && p.spot);
      if (rnd() < PROP_CHANCE && props.length) {
        const p = props[Math.floor(rnd() * props.length) % props.length];
        if (walkTo(p.spot[0], p.spot[1], 'wander', p)) return;
      }
      const [c0, r0] = tileHere();
      for (let i = 0; i < 20; i++) {
        const d = 3 + Math.floor(rnd() * 4);
        const ang = rnd() * Math.PI * 2;
        const c = Math.round(c0 + Math.cos(ang) * d);
        const r = Math.round(r0 + Math.sin(ang) * d);
        if (SceneMap.walkable(m, c, r) && walkTo(c, r, 'wander')) return;
      }
      idleAgain();
    }

    function tick(dt) {
      const d = Math.max(0, Math.min(0.25, Number(dt) || 0));
      if (s.flash) { s.flashT -= d; if (s.flashT <= 0) s.flash = null; }
      switch (s.mode) {
        case 'idle':
          s.timer -= d;
          if (s.timer <= 0) {
            if (s.roam) wander();
            else s.timer = IDLE_MIN + (IDLE_MAX - IDLE_MIN) * rnd();
            if (s.mode === 'idle' && rnd() < LOOK_CHANCE) flash('look', 1.5);
          }
          break;
        case 'wander':
        case 'goto': {
          let left = SPEED * d;
          while (left > 0 && s.path.length) {
            const p = s.path[0];
            const dx = p.x - s.x;
            const dy = p.y - s.y;
            const dist = Math.hypot(dx, dy);
            if (Math.abs(dx) > 0.01) s.facing = dx < 0 ? 'left' : 'right';
            if (dist <= left) { s.x = p.x; s.y = p.y; s.path.shift(); left -= dist; s.walked += dist; } else { s.x += (dx / dist) * left; s.y += (dy / dist) * left; s.walked += left; left = 0; }
          }
          if (!s.path.length) arrive();
          break;
        }
        case 'interact': {
          s.actT += d;
          const spec = ACTS[s.act];
          if (s.act === 'sit') s.state = s.night && s.actT > SIT_SLEEP_AFTER ? 'sleep' : 'idle';
          if (spec.at !== undefined && !s.actFired && s.actT >= spec.at) { s.actFired = true; emit({ type: 'act-fire', act: s.act, prop: s.prop }); }
          if (s.actT >= s.actDur) {
            const done = { type: 'act-done', act: s.act, prop: s.prop };
            if (!s.actFired) { s.actFired = true; if (s.act !== 'sit') emit({ type: 'act-fire', act: s.act, prop: s.prop }); }
            idleAgain();
            flash('happy', ARRIVE_S);
            emit(done);
          }
          break;
        }
        default:
          break;
      }
    }

    // a click on the ground at logical px (x, y): she walks to the nearest walkable tile there
    function clickGround(x, y) {
      if (s.mode === 'lifted') return { ok: false, reason: 'lifted' };
      const t = SceneMap.nearestWalkable(m, ...SceneMap.tileOf(m, x, y));
      if (!t) return { ok: false, reason: 'nowhere' };
      if (!walkTo(t[0], t[1], 'goto')) return { ok: false, reason: 'no-path' };
      return { ok: true, tile: t, target: SceneMap.tileCenter(m, t[0], t[1]) };
    }
    // a click on a prop (by id): she walks to its spot and uses it
    function clickProp(id) {
      if (s.mode === 'lifted') return { ok: false, reason: 'lifted' };
      const p = SceneMap.propById(m, id);
      if (!p || !p.act || !p.spot) return { ok: false, reason: 'not-usable' };
      if (s.mode === 'interact' && s.prop === id) return { ok: true, already: true, act: p.act };
      if (!walkTo(p.spot[0], p.spot[1], 'goto', p)) return { ok: false, reason: 'no-path' };
      return { ok: true, act: p.act, prop: id };
    }
    // clicked her: a short reaction where she stands (sitting she stays seated)
    function poke() {
      if (s.mode === 'lifted') return { ok: false };
      const state = rnd() < 0.5 ? 'happy' : 'pat';
      if (s.mode === 'wander' || s.mode === 'goto') idleAgain();
      flash(state, REACT_S);
      return { ok: true, state };
    }
    // pressed and dragged: she follows the pointer (her feet at the point) until drop()
    function pick(x, y) {
      s.mode = 'lifted'; s.state = 'lifted'; s.act = null; s.prop = null; s.sitting = false; s.path = []; s.pendingProp = null; s.flash = null; s.target = null;
      move(x, y);
      return { ok: true };
    }
    function move(x, y) {
      if (s.mode !== 'lifted') return;
      s.x = Math.max(0, Math.min(m.width, x));
      s.y = Math.max(0, Math.min(m.height, y));
    }
    function drop() {
      if (s.mode !== 'lifted') return { ok: false };
      const t = SceneMap.nearestWalkable(m, ...tileHere()) || [10, 6];
      const c = SceneMap.tileCenter(m, t[0], t[1]);
      if (!SceneMap.walkableAt(m, s.x, s.y)) { s.x = c.x; s.y = c.y; }
      idleAgain();
      flash('pat', LAND_S);
      emit({ type: 'drop', x: s.x, y: s.y, tile: t });
      return { ok: true, tile: t };
    }

    // where she is drawn: on the bench seat while sitting (in front of the bench), else at her feet
    const seat = () => { const p = s.sitting && SceneMap.propById(m, s.prop); return p ? { x: p.box[0] + p.box[2] / 2, y: p.foot - SIT_LIFT, sort: p.foot + 1 } : null; };
    const view = () => ({
      mode: s.mode,
      state: s.flash && s.mode !== 'lifted' && !(s.mode === 'interact') ? s.flash : s.state,
      x: s.x, y: s.y, drawX: seat() ? seat().x : s.x, drawY: seat() ? seat().y : s.y, sortY: seat() ? seat().sort : s.y, facing: s.facing, act: s.act, prop: s.prop, sitting: s.sitting,
      target: s.target ? { ...s.target } : null, path: s.path.length, walked: Math.round(s.walked), roam: s.roam,
    });

    return {
      tick, clickGround, clickProp, poke, pick, move, drop,
      state: view,
      setRoam: (v) => { s.roam = !!v; },
      setNight: (v) => { s.night = !!v; },
      drain: () => events.splice(0, events.length),
      map: m,
    };
  }

  return { SPEED, ACTS, IDLE_MIN, IDLE_MAX, SIT_LIFT, createScenePet };
});
