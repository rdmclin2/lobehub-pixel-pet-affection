'use strict';
// The VRM director (docs/vrm-motion-system.md §2.4, §3): a pure state machine that takes the semantic
// events of core/vrm-intent.js, the style profile (core/vrm-style.js) and the motion library
// (core/vrm-library.js) and decides, frame by frame, what she does: the posture (L0), the idle variant (L1)
// and its schedule, the activity she holds (talk / think / eat / lift / walk), her face, where she looks and
// the parameters of the alive layer (core/vrm-life.js). It never names a bone; the renderer
// (renderer/vrm-anim.js + vrm.js) plays the plan. Clock and random numbers are injected, so tests drive it.
//
// This release (T-2678): postures, idle scheduling, male / female styles, faces and gaze for the events.
// Reaction clips (L3) are left to the reaction layer: a touch shows its face and gaze, no clip yet.
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
    };

    const postureClip = (slot) => Lib.resolve(index, slot, style.set, overrides, usable);
    const setSetting = (p) => { setting = p === 'auto' || Lib.POSTURES.includes(p) ? p : 'auto'; S.idle = null; };
    setSetting(opts.posture || 'auto');

    // the posture she is held in, or null (auto: the idle pool decides)
    function heldPosture(holds) {
      if (holds.mood === 'sleep') return { slot: 'sit.doze', source: 'sleep' };
      if (setting !== 'auto') return { slot: setting, source: 'setting' };
      if (S.t - S.lastEvent >= boredAfter && !holds.attention) return { slot: 'sit.rest', source: 'bored' };
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

    function onEvent(e, holds) {
      S.lastEvent = S.t;
      S.events.push(e);
      if (S.events.length > 20) S.events.shift();
      if (e.type === 'touch') {
        const m = TOUCH_FACE[e.mood] || TOUCH_FACE.happy;
        const face = e.mood === 'happy' && ZONE_FACE[e.zone] ? ZONE_FACE[e.zone] : m.face;
        S.face = face;
        S.faceUntil = S.t + 1.8;
        S.gazeOverride = m.gaze;
        S.gazeUntil = m.gaze ? S.t + 1.5 : -1;
        S.noBlinkUntil = m.noBlink ? S.t + m.noBlink : -1;
      } else if (e.type === 'celebrate') { S.face = { happy: 1 }; S.faceUntil = S.t + 2.5; }
      else if (e.type === 'cue') {
        if (e.name === 'look') S.scanUntil = S.t + 2.6;
        else if (e.name === 'play' || e.name === 'happy') { S.face = { happy: 0.6 }; S.faceUntil = S.t + 1.6; }
      } else if (e.type === 'drag' && e.what !== 'lift') { S.face = { surprised: 0.4 }; S.faceUntil = S.t + 0.8; }
      if (holds.attention) S.lastEvent = S.t;
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

      // the activity she holds, by priority
      const hold = holds.lift ? 'lift' : holds.think ? 'think' : holds.eat ? 'eat' : holds.talk ? 'talk' : holds.walk ? 'walk' : null;

      // face: the mood's, a touch's for a while, the held activity's
      let face = { ...(MOOD_FACE[holds.mood] || {}) };
      if (hold && HOLD_FACE[hold]) face = { ...face, ...HOLD_FACE[hold] };
      if (S.t < S.faceUntil) face = { ...face, ...S.face };
      face = scaleFace(face, style.emotion || 1);

      // gaze: think → up, sleep → down, a touch's look aside, looking about on cue, else the cursor
      let gaze = { mode: 'cursor' };
      if (hold === 'think') gaze = { mode: 'fixed', x: 0.35, y: 1.6 };
      else if (holds.mood === 'sleep') gaze = { mode: 'fixed', x: 0, y: -0.6 };
      else if (S.t < S.gazeUntil && S.gazeOverride) gaze = { mode: 'fixed', ...S.gazeOverride };
      else if (S.t < S.scanUntil) gaze = { mode: 'fixed', x: Math.sin((S.scanUntil - S.t) * 2.4) * 1.4, y: 0.15 };
      else if (hold === 'lift') gaze = { mode: 'fixed', x: 0, y: -0.4 };

      const facing = holds.facing === 'left' ? -1 : 1;
      const micro = I.kind === 'micro' ? MICRO_IDLES[I.slot].life : { sway: 1, lookAway: 1 };
      const standing = !(S.base && S.base.sit) && holds.mood !== 'sleep';
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
        reaction: null,
        face,
        gaze,
        noBlink: S.t < S.noBlinkUntil,
        life: { sleep: holds.mood === 'sleep', sad: holds.mood === 'sad' ? 1 : holds.mood === 'hungry' ? 0.5 : 0, standing, lifted: holds.lift, idle: !hold && S.t >= S.faceUntil, sway: micro.sway, lookAway: micro.lookAway },
        facingYaw: (holds.walk ? 60 : 18) * facing,
        busy: !!hold || S.t < S.faceUntil || S.t < S.scanUntil,
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
    };
  }

  return { IDLE_MIN, IDLE_MAX, BORED_AFTER, FADE, MICRO_IDLES, MOOD_FACE, TOUCH_FACE, createDirector, seeded };
});
