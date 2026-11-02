'use strict';
// The VRM director (docs/vrm-motion-system.md §2.4, §3): a pure state machine that takes the semantic
// events of core/vrm-intent.js, the style profile (core/vrm-style.js) and the motion library
// (core/vrm-library.js) and decides, frame by frame, what she does: the posture (L0), the idle variant (L1)
// and its schedule, the activity she holds (talk / think / eat / lift / walk), her face, where she looks and
// the parameters of the alive layer (core/vrm-life.js). It never names a bone; the renderer
// (renderer/vrm-anim.js + vrm.js) plays the plan. Clock and random numbers are injected, so tests drive it.
//
// Postures, idle scheduling and male / female styles (T-2678); the reaction layer (T-2681, §3.3): a touch,
// a drop, a celebration or a cue plays a one-shot reaction (L3: clip + face + gaze) over the base, and
// lift / think / eat / talk hold an activity clip (L2) while they last. The plan lists them as `overlays`
// with the clip time and weight of this frame, so the renderer only samples clips; fades, interruption,
// priority, debounce, a repeated touch extending the reaction and the after-effects of shy / angry are
// decided here, with the injected clock.
// UMD (window.PetVrmDirector / require()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vrm-library'));
  else root.PetVrmDirector = factory(root.PetVrmLibrary);
})(typeof self !== 'undefined' ? self : this, function (Lib) {
  const IDLE_MIN = 8;
  const IDLE_MAX = 20;
  const BORED_AFTER = 180;
  const FADE = { posture: 1.0, sit: 1.2, idle: 1.0, cycle: 1.0, first: 0 };
  // idles that keep the posture she is in (a pinned posture, sad, sitting): the alive layer varies, the
  // clip does not. Used whenever the full-body idle clips would take her out of that posture.
  const MICRO_IDLES = {
    'idle.breathe': { label: '静静呼吸', life: { sway: 0.6, lookAway: 0.5 } },
    'idle.glance': { label: '东张西望', life: { sway: 1, lookAway: 3 } },
    'idle.shift': { label: '换脚站', life: { sway: 1.6, lookAway: 1 } },
  };
  // faces (VRM presets → weight before the style's emotion scale)
  const MOOD_FACE = { idle: {}, happy: { happy: 0.15 }, sad: { sad: 0.35 }, hungry: { sad: 0.2 }, sleep: { blink: 1, relaxed: 0.3 } };
  // a touch until the reaction layer gives it a clip: a face for a while, and where she looks
  const TOUCH_FACE = {
    happy: { face: { relaxed: 0.8, happy: 0.4 }, gaze: null },
    shy: { face: { surprised: 0.4, happy: 0.3, sad: 0.2 }, gaze: { x: -0.7, y: -0.7 } },
    ticklish: { face: { happy: 1 }, gaze: null },
    annoyed: { face: { angry: 0.5, sad: 0.2 }, gaze: { x: 0.8, y: 0 } },
    angry: { face: { angry: 1 }, gaze: null, noBlink: 1.5 },
  };
  const ZONE_FACE = { face: { happy: 0.5, angry: 0.25, blinkRight: 1 }, hands: { happy: 0.8 }, head: { relaxed: 0.8, happy: 0.4 } };
  const HOLD_FACE = { lift: { surprised: 0.8 }, think: { neutral: 0.3 }, eat: { happy: 0.7 }, talk: { happy: 0.2 }, walk: { happy: 0.25 } };

  // ---------- walking about and turning (T-2711, docs §3.6) ----------
  // She faces 18° towards where she looks, and turns to at most WALK.yaw (≤ 60°) while she walks — over
  // ≥ 0.3 s, never a snap: the turn speeds up and slows down (turnRate deg/s at most, accel deg/s²), and her
  // head and chest lead it (turnLead deg, the renderer turns them ahead of the hips). While the window
  // moves she plays the walk cycle (hold.walk, baked in place) at the window's pace: the clip's own speed
  // (clip.speed, hip heights / s) seen side-on (sin of her turn) matched to the window's speed, so the
  // planted foot keeps up with the floor instead of sliding. Turning on the spot she takes small steps
  // (turnStep × the clip's pace); when the window stops the walk fades back to the idle.
  const WALK = { yaw: 50, idleYaw: 18, turnRate: 150, accel: 520, gain: 4, lead: 0.5, leadMax: 22, turnStep: 0.55, minSin: 0.5, maxRate: 1.8, moving: 0.12, turning: 3 };
  // ---------- talk segments (T-2711, docs §5.3) ----------
  // A long reply rotates through the style's talk clips (hold.talk, hold.talk-2, hold.talk-3): each plays
  // once from its start, then the next one (never the same twice in a row) cross-fades in over xfade s.
  const TALK = { xfade: 0.6, nodHz: 0.9 };

  // ---------- reactions (L3) and holds (L2), docs §3.3 / §5.3 ----------
  // priority: drag:lift > touch > celebrate > think > eat > talk > cue > idle
  const PRIORITY = { lift: 6, drop: 5, touch: 5, celebrate: 4, cue: 0 };
  const DEBOUNCE = 0.6; // the same reaction is not started again within this (no twitching on fast clicks)
  const CUT = 0.2; // an interrupted reaction fades out this fast under the new one
  const NO_CLIP = 1.8; // a reaction without a clip (no library): its face and gaze last this long
  const AFTER = { angry: 10, shy: 8 }; // seconds of annoyed face after angry, of the shy posture after shy
  // the touch → the reaction: core/touch-zones.js already chose the mood (zone default, affection tier, the
  // streak: 3 in a row annoyed, 6 angry); the zone only matters while she is happy
  const MOOD_REACTION = { shy: 'react.shy', angry: 'react.angry', annoyed: 'react.annoyed', ticklish: 'react.ticklish' };
  const ZONE_REACTION = { head: 'react.touch-head', pat: 'react.touch-head', face: 'react.touch-face', hands: 'react.touch-hands' };
  // what a reaction looks like without its own face / gaze in the library (and without any clip)
  const REACTION_LOOK = {
    'react.touch-head': { face: { relaxed: 0.8, happy: 0.4 }, gaze: { x: 0, y: 0.9, for: 0.7 }, hold: 1.6 },
    'react.touch-face': { face: { happy: 0.5, angry: 0.25, blinkRight: 1 }, gaze: { x: -0.5, y: 0.1, for: 0.6 }, hold: 1.2 },
    'react.touch-hands': { face: { happy: 0.8 }, gaze: { x: 0, y: -0.5, for: 0.8 } },
    'react.shy': { face: { surprised: 0.5, happy: 0.3, sad: 0.25 }, gaze: { x: -0.7, y: -0.7 }, hold: 1.5 },
    'react.angry': { face: { angry: 1 }, gaze: null, noBlink: 1.5 },
    'react.annoyed': { face: { angry: 0.5, sad: 0.2 }, gaze: { x: 0.8, y: 0 }, hold: 1.2 },
    'react.ticklish': { face: { happy: 1 }, gaze: null },
    'react.drop': { face: { surprised: 0.4 }, gaze: null, hold: 0.35 },
    'react.greet': { face: { happy: 0.8 }, gaze: null },
    'react.cheer': { face: { happy: 1 }, gaze: null },
  };
  const HOLD_LOOK = {
    lift: { face: { surprised: 0.8 }, gaze: { x: 0, y: -0.4 } },
    think: { face: { neutral: 0.3 }, gaze: { x: 0.35, y: 1.6 } },
    eat: { face: { happy: 0.7 }, gaze: { x: 0, y: -0.5 } },
    talk: { face: { happy: 0.2 }, gaze: null },
    walk: { face: { happy: 0.25 }, gaze: null },
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const scaleFace = (f, k) => Object.fromEntries(Object.entries(f || {}).map(([n, w]) => [n, n.startsWith('blink') ? w : clamp(w * k, 0, 1)]));
  // a seeded generator (mulberry32) for tests and the debug seed
  function seeded(n) {
    let a = n >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  // opts: { style (resolved profile), index (cleaned library index), loaded: Set of clip ids whose .vrma
  //   loaded, packIdle: bool (the pack's own vrm.idle clip loaded), overrides (pack vrm.motions),
  //   posture: 'auto' | a posture slot (the user's choice), rand, boredAfter }
  function createDirector(opts = {}) {
    let rand = opts.rand || Math.random;
    const style = opts.style || { set: 'neutral', idleEvery: 15, emotion: 0.9, hipSway: 0.75 };
    const index = opts.index || { clips: {} };
    const loaded = opts.loaded || new Set();
    const overrides = opts.overrides || null;
    const boredAfter = opts.boredAfter || BORED_AFTER;
    let packIdle = !!opts.packIdle;
    let setting = 'auto';
    const usable = (c) => !c.file || loaded.has(c.id);
    const between = (a, b) => a + (b - a) * rand();

    const S = {
      t: 0,
      lastEvent: 0,
      idle: null, // { slot, kind: 'clip'|'cycle'|'micro', clip, until, started }
      lastIdle: null,
      cycleIdx: 0,
      cycleAt: 0,
      base: null, // { id, file, fade, key }
      posture: null,
      postureSource: null,
      faceUntil: -1,
      face: {},
      gazeOverride: null,
      gazeUntil: -1,
      noBlinkUntil: -1,
      scanUntil: -1,
      history: [], // idle slots, newest last (tests, debug)
      events: [],
      react: null, // the reaction playing: { slot, clip, prio, start, playEnd, end, fadeIn, fadeOut, weight, face, gaze, gazeFor, noBlink, key, amp }
      fading: [], // interrupted reactions fading out: { …react, cutAt, cutFrom }
      queued: null, // one celebration waiting for a touch to finish
      holds: new Map(), // hold slot → { slot, clip, start, w }
      reactKey: 0,
      reactions: [], // reaction slots started, newest last (tests, debug)
      angryUntil: -1,
      shyUntil: -1,
      landKey: 0,
      yaw: null, // her facing now (deg, + = to her left), eased towards the target (WALK)
      yawVel: 0,
      gait: { phase: 0, rate: 0, wanted: 0, on: false, steps: 0 }, // the walk cycle's clock
      talk: { cur: null, prev: null, n: 0, last: null, segments: [] }, // the talk segment playing, the one fading out
    };
    const reactionClip = (slot) => Lib.resolve(index, slot, style.set, overrides, usable);

    const postureClip = (slot) => Lib.resolve(index, slot, style.set, overrides, usable);
    const setSetting = (p) => { setting = p === 'auto' || Lib.POSTURES.includes(p) ? p : 'auto'; S.idle = null; };
    setSetting(opts.posture || 'auto');

    // the posture she is held in, or null (auto: the idle pool decides)
    function heldPosture(holds) {
      if (holds.mood === 'sleep') return { slot: 'sit.doze', source: 'sleep' };
      if (setting !== 'auto') return { slot: setting, source: 'setting' };
      if (S.t - S.lastEvent >= boredAfter && !holds.attention) return { slot: 'sit.rest', source: 'bored' };
      if (S.t < S.shyUntil) return { slot: 'stand.shy', source: 'shy' };
      if (holds.mood === 'sad' || holds.mood === 'hungry') return { slot: 'stand.shy', source: 'mood' };
      return null;
    }

    // the idle pool for now: full-body idle clips (and cycles) in auto, micro idles while a posture is held
    function pool(held, holds) {
      if (!held) {
        const list = Lib.slotsOf(index, 'idle', style.set, overrides, usable).filter((c) => Lib.playable(index, c, style.set, overrides, usable));
        if (list.length) return list.map((c) => ({ slot: c.slot, kind: c.cycle ? 'cycle' : 'clip', clip: c, weight: holds.mood === 'happy' && c.slot === 'idle.happy' ? 2 : 1 }));
      }
      return Object.keys(MICRO_IDLES).map((slot) => ({ slot, kind: 'micro', clip: null, weight: slot === 'idle.glance' && style.lookAway > 0.1 ? 1.4 : 1 }));
    }

    function pickIdle(list) {
      const choices = list.length > 1 ? list.filter((c) => c.slot !== S.lastIdle) : list;
      const total = choices.reduce((s, c) => s + c.weight, 0);
      let r = rand() * total;
      for (const c of choices) { r -= c.weight; if (r <= 0) return c; }
      return choices[choices.length - 1];
    }

    // how long an idle lasts: a whole number of loops of its clip, 8–20 s; others around the style's rhythm
    function idleLength(c) {
      if (c.kind === 'clip') {
        const d = c.clip.duration || 1;
        const want = between(style.idleEvery - 4, style.idleEvery + 4);
        let n = Math.max(1, Math.round(want / d));
        while (n * d < IDLE_MIN) n++;
        while (n > 1 && n * d > IDLE_MAX) n--;
        return clamp(n * d, IDLE_MIN, Math.max(IDLE_MIN, Math.min(IDLE_MAX, n * d)));
      }
      if (c.kind === 'cycle') return IDLE_MAX;
      return clamp(between(style.idleEvery - 4, style.idleEvery + 4), IDLE_MIN, IDLE_MAX);
    }

    function startIdle(list) {
      const c = pickIdle(list);
      S.idle = { slot: c.slot, kind: c.kind, clip: c.clip, started: S.t, until: S.t + idleLength(c) };
      S.lastIdle = c.slot;
      S.history.push(c.slot);
      if (S.history.length > 50) S.history.shift();
      if (c.kind === 'cycle') S.cycleAt = S.t;
    }

    function setBase(clip, fade, posture, source) {
      const id = clip ? clip.id : packIdle ? 'pack.idle' : null;
      if (S.base && S.base.id === id) { S.posture = posture; S.postureSource = source; return; }
      const first = !S.base;
      const sitChange = S.base && clip && !!clip.sit !== !!S.base.sit;
      S.base = { id, file: clip ? clip.file || null : null, sit: !!(clip && clip.sit), fade: first ? FADE.first : sitChange ? FADE.sit : fade, key: (S.base ? S.base.key : 0) + 1 };
      S.posture = posture;
      S.postureSource = source;
    }

    // ---------- the reaction layer ----------
    // the weight (0..1, before the clip's own weight) of reaction r at time t: its fade-in, its fade-out at
    // the end, or the quick cut when another reaction took over
    function reactWeight(r, t) {
      const smoothK = (x) => { const k = clamp(x, 0, 1); return k * k * (3 - 2 * k); };
      let w = Math.min(smoothK((t - r.start) / r.fadeIn), smoothK((r.end - t) / r.fadeOut));
      if (r.cutAt !== undefined) w = Math.min(w, r.cutFrom * smoothK(1 - (t - r.cutAt) / CUT));
      return clamp(w, 0, 1);
    }

    // Start reaction `slot` now (a new one cuts the old: it fades out under the new one, no snap). opts:
    // { prio, amp (0..1, e.g. a cue's small cheer), hold (s, overrides the clip's), why }
    function startReaction(slot, opts = {}) {
      const clip = reactionClip(slot);
      const look = REACTION_LOOK[slot] || {};
      const cur = S.react;
      // the same reaction again: within the debounce nothing; while it plays, the same reaction keeps going
      // (she leans into the hand, stays cross) instead of starting over; once it fades out, it starts again
      if (cur && cur.slot === slot && S.t < cur.end) {
        if (S.t - cur.start < DEBOUNCE) return cur;
        if (S.t < cur.end - cur.fadeOut) {
          cur.end = Math.max(cur.end, S.t + (cur.hold || 0.8) + cur.fadeOut);
          cur.extended = (cur.extended || 0) + 1;
          return cur;
        }
      }
      if (cur) cutReaction();
      const fadeIn = clip ? clip.fadeIn : 0.2;
      const fadeOut = clip ? clip.fadeOut : 0.5;
      const hold = opts.hold !== undefined ? opts.hold : clip ? (clip.hold || look.hold || 0) : 0;
      const dur = clip ? (clip.still ? 0 : clip.duration || 1) : 0;
      const playEnd = S.t + dur;
      const end = clip ? Math.max(playEnd + hold, S.t + fadeIn) + fadeOut : S.t + NO_CLIP;
      const r = {
        slot, clip: clip || null, prio: opts.prio || PRIORITY.touch, start: S.t, playEnd, end, hold, fadeIn, fadeOut,
        weight: clip ? clamp(clip.weight * (opts.amp || 1) * (style.amplitude >= 1 ? 1 : 0.85 + 0.15 * style.amplitude), 0, 1) : 0,
        face: (clip && clip.face) || look.face || {}, gaze: (clip && clip.gaze) || look.gaze || null, gazeFor: look.gaze && look.gaze.for,
        noBlink: look.noBlink || 0, key: ++S.reactKey, why: opts.why || null,
      };
      S.react = r;
      S.reactions.push(slot);
      if (S.reactions.length > 50) S.reactions.shift();
      if (slot === 'react.drop') S.landKey++;
      if (slot === 'react.angry') S.angryUntil = r.end + AFTER.angry;
      if (slot === 'react.shy' && setting === 'auto') S.shyUntil = r.end + AFTER.shy;
      if (r.noBlink) S.noBlinkUntil = S.t + r.noBlink;
      return r;
    }
    function cutReaction() {
      const r = S.react;
      if (!r) return;
      S.fading.push({ ...r, cutAt: S.t, cutFrom: reactWeight(r, S.t) });
      S.react = null;
    }

    function onEvent(e, holds) {
      S.lastEvent = S.t;
      S.events.push(e);
      if (S.events.length > 20) S.events.shift();
      const busy = S.react && S.t < S.react.end ? S.react.prio : -1;
      if (e.type === 'touch') {
        if (holds.lift) return; // held in the air: the lift wins
        const slot = e.mood === 'happy' || !MOOD_REACTION[e.mood] ? ZONE_REACTION[e.zone] || 'react.touch-head' : MOOD_REACTION[e.mood];
        startReaction(slot, { prio: PRIORITY.touch, why: `touch:${e.zone}:${e.mood}` });
      } else if (e.type === 'drag') {
        if (e.what === 'lift') cutReaction(); // the lift hold takes over at once
        else startReaction('react.drop', { prio: PRIORITY.drop, hold: e.what === 'thrown' ? 0.7 : undefined, amp: 1, why: `drag:${e.what}` });
      } else if (e.type === 'celebrate') {
        const slot = e.name === 'hatch' ? 'react.greet' : 'react.cheer';
        if (busy > PRIORITY.celebrate || holds.lift) S.queued = { slot, why: `celebrate:${e.name}` }; // one waits, more are dropped
        else startReaction(slot, { prio: PRIORITY.celebrate, why: `celebrate:${e.name}` });
      } else if (e.type === 'cue') {
        if (e.name === 'look') S.scanUntil = S.t + 2.6;
        else if (e.name === 'play' || e.name === 'happy') {
          // a hint, not an order: now and then a small cheer, else a smile; never over anything else
          if (busy < 0 && !holds.lift && !holds.think && !holds.eat && !holds.talk && rand() < 0.35) startReaction('react.cheer', { prio: PRIORITY.cue, amp: 0.6, why: `cue:${e.name}` });
          else { S.face = { happy: 0.6 }; S.faceUntil = S.t + 1.6; }
        }
      }
      if (holds.attention) S.lastEvent = S.t;
    }

    // the activity held (L2): its overlay fades in / out by its own times; one at a time, by priority
    function stepHolds(dt, hold) {
      const slot = hold ? `hold.${hold}` : null;
      if (slot && !S.holds.has(slot)) S.holds.set(slot, { slot, clip: reactionClip(slot), start: S.t, w: 0 });
      for (const [k, h] of S.holds) {
        const on = k === slot;
        const fade = h.clip ? (on ? h.clip.fadeIn : h.clip.fadeOut) : 0.3;
        h.w = clamp(h.w + (on ? 1 : -1) * (dt / Math.max(0.05, fade)), 0, 1);
        if (!on && h.w <= 0) S.holds.delete(k);
      }
    }

    // ---------- facing, the walk cycle, talk segments (T-2711) ----------
    // Turn towards `target` (deg): a speed that follows the remaining angle (gain), capped at turnRate and
    // changed at most accel deg/s² — so every turn eases in and out and takes ≥ 0.3 s for anything visible.
    function stepFacing(dt, target) {
      if (S.yaw === null) S.yaw = target; // the first frame: no turn from nowhere
      const err = target - S.yaw;
      const want = clamp(err * WALK.gain, -WALK.turnRate, WALK.turnRate);
      const dv = clamp(want - S.yawVel, -WALK.accel * dt, WALK.accel * dt);
      S.yawVel += dv;
      S.yaw += S.yawVel * dt;
      if (Math.abs(target - S.yaw) < 0.05 && Math.abs(S.yawVel) < 1) { S.yaw = target; S.yawVel = 0; }
      return { target, turning: Math.abs(target - S.yaw) > WALK.turning };
    }

    // The walk cycle's pace: holds.walkSpeed is how fast the window carries her across the screen (hip heights
    // per second, from the renderer); the clip covers clip.speed hip heights a second along her facing, of
    // which sin(yaw) shows across the screen. → whether the walk plays, and its clock (phase, s of the clip).
    function stepGait(dt, holds, turn) {
      const G = S.gait;
      const clip = holds.walk ? reactionClip('hold.walk') : null;
      const pace = clip && clip.speed > 0 ? clip.speed : 1;
      const across = Math.max(WALK.minSin, Math.abs(Math.sin((S.yaw * Math.PI) / 180)));
      G.wanted = holds.walk ? clamp((Number(holds.walkSpeed) || 0) / (pace * across), 0, WALK.maxRate) : 0;
      const moving = G.wanted > WALK.moving;
      const on = !!(clip && holds.walk && (moving || turn.turning));
      const target = on ? Math.max(G.wanted, turn.turning ? WALK.turnStep : 0) : 0;
      // the pace follows quickly while she walks; when she stops it winds down with the fade-out (no freeze)
      G.rate += (target - G.rate) * (1 - Math.exp(-(on ? 8 : 5) * dt));
      if (on && !G.on) G.steps++;
      G.on = on;
      G.phase += dt * G.rate;
      return on;
    }

    // the talk hold as segments: the current one (and the one it replaced, fading out) as overlays
    function nextTalk() {
      const T = S.talk;
      const ids = new Set();
      T.segments = Lib.TALK_SEGMENTS.map((s) => reactionClip(s)).filter((c) => c && !ids.has(c.id) && ids.add(c.id));
      if (!T.segments.length) return null;
      const pool = T.segments.length > 1 ? T.segments.filter((c) => c.id !== T.last) : T.segments;
      const c = pool[Math.floor(rand() * pool.length) % pool.length];
      T.last = c.id;
      T.n++;
      return { slot: c.slot, clip: c, start: S.t };
    }
    function talkOverlays(h, overlays, on) {
      const T = S.talk;
      if (h.w <= 0) { T.cur = null; T.prev = null; return; }
      if (!T.cur) T.cur = nextTalk();
      if (!T.cur) return;
      const len = (c) => Math.max(1, c.clip.duration || 1);
      // a segment ends: the next one comes in (only while she still talks)
      if (on && S.t - T.cur.start >= len(T.cur) - TALK.xfade * 0.5) {
        const n = nextTalk();
        if (n) { T.prev = T.cur; T.cur = n; }
      }
      const w = h.w * h.w * (3 - 2 * h.w);
      const k = (() => { const x = clamp((S.t - T.cur.start) / TALK.xfade, 0, 1); return T.prev ? x * x * (3 - 2 * x) : 1; })();
      if (T.prev && k >= 1) T.prev = null;
      // sequential slerps: prev at a, then cur at b, so prev keeps w(1−k) and cur w·k of the pose
      const b = w * k * T.cur.clip.weight;
      if (T.prev) {
        const a = clamp((w * (1 - k) * T.prev.clip.weight) / Math.max(1e-3, 1 - b), 0, 1);
        overlays.push({ layer: 'hold', slot: T.prev.slot, id: T.prev.clip.id, mask: T.prev.clip.mask, time: clamp(S.t - T.prev.start, 0, len(T.prev)), weight: +a.toFixed(4) });
      }
      overlays.push({ layer: 'hold', slot: T.cur.slot, id: T.cur.clip.id, mask: T.cur.clip.mask, time: clamp(S.t - T.cur.start, 0, len(T.cur)), weight: +b.toFixed(4) });
    }

    // One frame: dt (seconds, already sped up), { holds, events } from vrm-intent → the plan.
    function update(dt, { holds, events = [] }) {
      S.t += dt;
      if (holds.attention) S.lastEvent = S.t;
      for (const e of events) onEvent(e, holds);

      const held = heldPosture(holds);
      const list = pool(held, holds);
      // a change of regime (posture held / released, sit / stand) ends the idle at once
      const regime = held ? `held:${held.slot}` : 'auto';
      if (!S.idle || S.t >= S.idle.until || S.idle.regime !== regime || !list.some((c) => c.slot === S.idle.slot)) {
        startIdle(list);
        S.idle.regime = regime;
      }

      // the base clip
      const I = S.idle;
      if (held) {
        const c = postureClip(held.slot) || postureClip('stand.relaxed');
        setBase(c, FADE.posture, held.slot, held.source);
      } else if (I.kind === 'clip') {
        setBase(I.clip, FADE.idle, null, 'idle');
      } else if (I.kind === 'cycle') {
        const cyc = I.clip.cycle.filter((s) => postureClip(s));
        if (S.t - S.cycleAt >= I.clip.every) { S.cycleIdx++; S.cycleAt = S.t; }
        const slot = cyc[S.cycleIdx % cyc.length];
        setBase(postureClip(slot), FADE.cycle, slot, 'cycle');
      } else {
        const c = postureClip('stand.relaxed');
        setBase(c, FADE.posture, c ? 'stand.relaxed' : null, 'idle');
      }

      // where she faces, and the walk cycle's pace (before the holds: the walk is on only while she moves)
      const facing = holds.facing === 'left' ? -1 : 1;
      const turn = stepFacing(dt, (holds.walk ? WALK.yaw : WALK.idleYaw) * facing);
      const walkOn = stepGait(dt, holds, turn);

      // the activity she holds, by priority
      const hold = holds.lift ? 'lift' : holds.think ? 'think' : holds.eat ? 'eat' : holds.talk ? 'talk' : walkOn ? 'walk' : null;
      stepHolds(dt, hold);

      // the reaction: over → gone (a queued celebration next); interrupted ones finish fading
      if (S.react && S.t >= S.react.end) S.react = null;
      if (!S.react && S.queued && !holds.lift) { const q = S.queued; S.queued = null; startReaction(q.slot, { prio: PRIORITY.celebrate, why: q.why }); }
      S.fading = S.fading.filter((r) => reactWeight(r, S.t) > 0.001);
      const R = S.react;
      const rw = R ? reactWeight(R, S.t) : 0;

      // the clip overlays, bottom to top: the hold, the fading reactions, the reaction (time in the clip, weight)
      const overlays = [];
      const holdClip = (h) => h.clip && overlays.push({ layer: 'hold', slot: h.slot, id: h.clip.id, mask: h.clip.mask, time: h.clip.still ? 0 : (h.slot === 'hold.walk' ? S.gait.phase : S.t - h.start) % Math.max(0.01, h.clip.duration || 1), weight: +(h.w * h.w * (3 - 2 * h.w) * h.clip.weight).toFixed(4) });
      for (const h of S.holds.values()) if (h.slot === 'hold.talk') talkOverlays(h, overlays, hold === 'talk'); else holdClip(h);
      const reactClip = (r, layer) => r.clip && overlays.push({ layer, slot: r.slot, id: r.clip.id, mask: r.clip.mask, time: r.clip.still ? 0 : clamp(S.t - r.start, 0, r.clip.duration || 1), weight: +(reactWeight(r, S.t) * r.weight).toFixed(4), key: r.key });
      for (const r of S.fading) reactClip(r, 'fading');
      if (R) reactClip(R, 'reaction');

      // face: the mood's, annoyed for a while after angry, the held activity's, a cue's smile, the reaction's
      let face = { ...(MOOD_FACE[holds.mood] || {}) };
      if (S.t < S.angryUntil && !(R && R.slot === 'react.angry')) face = { ...face, angry: 0.3, sad: 0.1 };
      const hc = hold && S.holds.get(`hold.${hold}`);
      if (hold) face = { ...face, ...((hc && hc.clip && hc.clip.face) || (HOLD_LOOK[hold] || {}).face || HOLD_FACE[hold] || {}) };
      if (S.t < S.faceUntil) face = { ...face, ...S.face };
      if (R && S.t < R.end - R.fadeOut * 0.5) face = { ...face, ...R.face }; // from the first frame (the renderer eases it in)
      face = scaleFace(face, style.emotion || 1);

      // gaze: the reaction's (a look aside, at the hand), think → up, sleep → down, looking about on cue,
      // the hold's (lifted: down at the ground), else the cursor
      let gaze = { mode: 'cursor' };
      const holdGaze = hold && ((hc && hc.clip && hc.clip.gaze) || (HOLD_LOOK[hold] || {}).gaze);
      if (R && R.gaze && S.t < (R.gazeFor ? R.start + R.gazeFor : R.end - R.fadeOut * 0.5)) gaze = { mode: 'fixed', x: R.gaze.x, y: R.gaze.y };
      else if (hold === 'think' && holdGaze) gaze = { mode: 'fixed', x: holdGaze.x, y: holdGaze.y };
      else if (holds.mood === 'sleep') gaze = { mode: 'fixed', x: 0, y: -0.6 };
      else if (S.t < S.scanUntil) gaze = { mode: 'fixed', x: Math.sin((S.scanUntil - S.t) * 2.4) * 1.4, y: 0.15 };
      else if (holdGaze) gaze = { mode: 'fixed', x: holdGaze.x, y: holdGaze.y };

      const micro = I.kind === 'micro' ? MICRO_IDLES[I.slot].life : { sway: 1, lookAway: 1 };
      const standing = !(S.base && S.base.sit) && holds.mood !== 'sleep';
      const talkOn = S.holds.get('hold.talk');
      return {
        t: S.t,
        base: S.base && { ...S.base },
        posture: S.posture,
        postureSource: S.postureSource,
        setting,
        idle: I.slot,
        idleKind: I.kind,
        idleLeft: Math.max(0, I.until - S.t),
        hold,
        reaction: R ? R.slot : null,
        reactionKey: R ? R.key : 0,
        reactionWeight: +rw.toFixed(3),
        overlays,
        face,
        gaze,
        noBlink: S.t < S.noBlinkUntil,
        life: { sleep: holds.mood === 'sleep', sad: holds.mood === 'sad' ? 1 : holds.mood === 'hungry' ? 0.5 : 0, standing, lifted: holds.lift, idle: !hold && !R && S.t >= S.faceUntil, sway: R ? micro.sway * 0.4 : micro.sway, lookAway: micro.lookAway, landKey: S.landKey, nod: hold === 'eat' ? 1 : 0, talk: talkOn ? +(talkOn.w * talkOn.w * (3 - 2 * talkOn.w)).toFixed(3) : 0, walking: S.gait.on },
        facingYaw: +S.yaw.toFixed(3),
        turnLead: +clamp((turn.target - S.yaw) * WALK.lead, -WALK.leadMax, WALK.leadMax).toFixed(3),
        walk: { on: S.gait.on, rate: +S.gait.rate.toFixed(3), wanted: +S.gait.wanted.toFixed(3), phase: +S.gait.phase.toFixed(3), target: turn.target, turning: turn.turning },
        talkSegment: S.talk.cur ? S.talk.cur.slot : null,
        talkSegments: S.talk.n,
        busy: !!hold || !!R || S.fading.length > 0 || S.t < S.faceUntil || S.t < S.scanUntil || turn.turning,
      };
    }

    return {
      update,
      setPosture: setSetting,
      get posture() { return setting; },
      setPackIdle: (v) => { packIdle = !!v; },
      seed: (n) => { rand = seeded(n); },
      state: S,
      history: () => S.history.slice(),
      reactions: () => S.reactions.slice(),
    };
  }

  return { WALK, TALK, IDLE_MIN, IDLE_MAX, BORED_AFTER, FADE, MICRO_IDLES, MOOD_FACE, TOUCH_FACE, PRIORITY, DEBOUNCE, CUT, AFTER, MOOD_REACTION, ZONE_REACTION, REACTION_LOOK, createDirector, seeded };
});
