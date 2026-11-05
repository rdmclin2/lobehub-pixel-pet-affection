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
  const FADE = { posture: 1.0, sit: 1.2, pose: 1.4, idle: 1.0, cycle: 1.0, first: 0 };
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
  // ---------- the dance layer D (docs/vrm-dance.md §3) ----------
  // A dance takes the whole body: its clip replaces the base (L0/L1), no hold or reaction is laid over it
  // (only hold.lift while she is lifted), the alive layer keeps only the eyes, she faces the camera and looks
  // at you. off → cueing (the base fades to the dance's first frame, fadeIn) → in (asks the app to start the
  // music and the clock) → on ⇄ paused → out (fadeOut back to the idle) → off. The app holds what is danced and
  // the clock (holds.dance); the director only reads it and asks (plan.dance.request: start | pause | resume |
  // stop), so the interruption rules are here and testable (§3.4):
  //   lifted → pause (and hold.lift); put down → resume after resumeAfter s; lifted longer than pauseMax → stop;
  //   a touch → only its face, no reaction; talking → keep dancing, the music ducked to duckTalk (recording:
  //   duckMic); eating (fed) → stop; celebrations and cues → dropped.
  const DANCE = { fadeIn: 0.6, fadeOut: 0.5, resumeAfter: 0.6, pauseMax: 10, duckTalk: 0.3, duckMic: 0.15, touchFace: 1.2, face: { happy: 0.25 } };
  const DANCE_ON = ['cueing', 'in', 'on', 'paused'];

  // ---------- reactions (L3) and holds (L2), docs §3.3 / §5.3 ----------
  // priority: drag:lift > touch > celebrate > think > eat > talk > cue > idle (think and talk at once — a reply
  // streaming in — is talk)
  const PRIORITY = { lift: 6, drop: 5, touch: 5, manual: 5, celebrate: 4, sleep: 1, cue: 0 };
  const HOLD_FULL_IN = 0.4; // T-5098: the shortest fade-in of a full-body hold (s)
  const DEBOUNCE = 0.6; // the same reaction is not started again within this (no twitching on fast clicks)
  const CUT = 0.2; // an interrupted reaction fades out this fast under the new one
  // T-5092: a touch no longer changes three layers on one frame (T-5089: the idle / posture switched, the reaction
  // and a talk gesture came in together — 11–15°/frame spikes on hands, forearms and feet):
  //   base   the idle or posture she is in stays while the touch reaction plays (≤ base s): a regime change it
  //          causes (the bored / rest posture ending, the idle running out) waits for it;
  //   talk   a talk gesture that starts while a touch reaction comes in waits ≤ talk s (or the reaction's clip
  //          end) before it fades in — queued behind the reaction, not stacked on its first frames;
  //   limbs  the reaction's hands, forearms and feet fade in limbFade × slower than the rest of the body.
  const TOUCH_SETTLE = { base: 3, talk: 1.2, limbFade: 1.8 };
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
    'react.yawn': { face: { relaxed: 0.6 }, gaze: { x: 0, y: 0.4 } },
    'react.stretch': { face: { relaxed: 0.5, happy: 0.2 }, gaze: null },
  };
  const HOLD_LOOK = {
    lift: { face: { surprised: 0.8 }, gaze: { x: 0, y: -0.4 } },
    think: { face: { neutral: 0.3 }, gaze: { x: 0.35, y: 1.6 } },
    eat: { face: { happy: 0.7 }, gaze: { x: 0, y: -0.5 } },
    talk: { face: { happy: 0.2 }, gaze: null },
    walk: { face: { happy: 0.25 }, gaze: null },
  };

  // ---------- the action state (T-2829) ----------
  // What she is doing, as one explicit state, every frame: idle ↔ an action (dance, lift, a reaction — touch,
  // celebrate, play, drop —, a hold — eat, think, talk, walk —, sleep) → returning (whatever ended or was
  // stopped still fading out, ≤ the fade) → idle. Derived from the layers each frame, so it cannot drift from
  // them: an action is over exactly when nothing of it is left on her (no dance base, no overlay, no hold).
  // plan.action = { state, since, from, exclusive }; director.actions() the transitions (tests, debug).
  // stop(): the user's "stop" — the dance is asked to stop, the reaction cut (CUT), the waiting celebration,
  // the face and the looking-about dropped; she fades back to the idle. The app's own holds (a meal, sleep, the
  // chat) are the app's to end.
  const REACTION_ACTION = { 'react.cheer': 'celebrate', 'react.greet': 'celebrate', 'react.drop': 'drop', 'react.yawn': 'sleep', 'react.stretch': 'sleep' };
  const ACTIONS = ['idle', 'returning', 'dance', 'lift', 'touch', 'celebrate', 'play', 'drop', 'eat', 'think', 'talk', 'walk', 'sleep', 'manual'];

  // ---------- the body of eat / play / sleep (T-2831, docs §14) ----------
  // The library has no clip that moves her body for these (hold.eat is a still stand, sleep a posture only with the
  // library, play a cue): core/vrm-acts.js makes them procedurally and the renderer lays them over the clips. Here:
  // when each plays and with what weight (plan.acts: [{ name, w, time }]). eat while the app's meal lasts (the eat
  // hold), sleep while she is asleep, play a one-shot of ACT.play.dur s from the 玩耍 button (event `play`). They
  // fade in / out by ACT (no snap), give way to a reaction on top (the weight × 1 − the reaction's), and are
  // interrupted: play by a touch, a drop, a celebration, a lift, a meal, thinking or a dance; eat and sleep by the
  // lift and a dance. stop() ends play, and eat / sleep until the app's meal / sleep ends (the next one plays again).
  const ACT = { eat: { fadeIn: 0.35, fadeOut: 0.45 }, play: { fadeIn: 0.25, fadeOut: 0.45, dur: 3.2, face: { happy: 0.8 } }, sleep: { fadeIn: 1.2, fadeOut: 0.7 } };
  const ACT_NAMES = Object.keys(ACT);

  // ---------- T-5084: variety from the motion library v2, posture bouts, playing a clip by hand ----------
  // Idle rotation: a new idle is none of the last min(IDLE_RECENT, ⌊n/2⌋) ones (8–11 idle clips per style: no idle
  // comes back within ~4 changes, ~1 min). Reactions: a director slot (react.touch-head…) plays one of the clips of
  // its slot and of the index groups below (T-5081 docs/vrm-motion-library.md §2), never the same one twice in a row,
  // a moving clip before a held frame; a clip that would take her out of the pose she is in (a full-body standing
  // clip while she sits) is left out. Talk and think rotate through their groups' clips as segments (TALK.xfade).
  // Falling asleep she yawns, waking up she stretches (upper body over the posture), when the library has those.
  const IDLE_RECENT = 4;
  const REACTION_GROUPS = {
    'react.touch-head': ['nod', 'happy'], 'react.touch-face': ['shy'], 'react.touch-hands': ['clap', 'greet'],
    'react.shy': ['shy'], 'react.angry': ['angry'], 'react.annoyed': ['shake'], 'react.ticklish': ['excited'],
    'react.drop': ['surprised'], 'react.greet': ['greet', 'bow'], 'react.cheer': ['excited', 'jump', 'clap'],
    'react.yawn': ['yawn'], 'react.stretch': ['stretch'],
  };
  const SEGMENT_GROUPS = { talk: 'talk', think: 'think' };
  // Posture bouts (auto only): bored (BORED_AFTER s without anything) she sits, twice as long she lies down (when
  // the library and the model allow it, else she keeps sitting); sad she crouches; and every REST.after s of a calm
  // idle she takes a short rest — sitting or crouching for REST.dur s — then stands up again. Each bout picks one
  // posture of its group (stand / sit / crouch / lay, the index's `group`), not the one of the last bout; every
  // change of posture cross-fades (FADE.pose).
  const REST = { after: [70, 140], dur: [18, 36] };
  const POSE_GROUPS = ['stand', 'sit', 'crouch', 'lay'];
  // playing a clip by hand (console 试播, POST /motion, a chat request): a posture or idle is the base for
  // MANUAL.hold s (posture) or one play of the clip (≥ MANUAL.minIdle s), a reaction / hold an overlay (one-shot, or
  // looped until stopped); a touch, the lift, a dance, stop() / reset() (重置姿势) interrupt it, back to the idle.
  const MANUAL = { hold: 15, minIdle: 6 };

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
    // T-5092 TOUCH_SETTLE (the base held, a talk gesture queued, the limbs slower); settle: false only to replay
    // the T-5089 behaviour (scripts/lib/vrm-replay.js, the before / after comparison)
    const settleOn = opts.settle !== false;
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
      dance: { state: 'off', id: null, since: 0, started: false, liftAt: null, dropAt: null, key: 0, n: 0 }, // the dance layer D
      baseFadeUntil: 0, // the base cross-fade in the renderer lasts until then
      action: { state: 'idle', since: 0, from: null }, // T-2829: what she is doing (ACTIONS)
      actions: [], // transitions, newest last: { t, from, to, why }
      stopAsked: null, // stop(): the dance is asked to stop on the next frame
      resets: [], // T-2830 reset(): { t, was, why }, newest last
      resetWhy: null, // the reset's reason, written on the transitions it causes
      resetAt: -1, // when the last reset was
      acts: Object.fromEntries(ACT_NAMES.map((n) => [n, { w: 0, start: 0, on: false }])), // T-2831: eat / play / sleep
      play: null, // the play one-shot: { start, until, n }
      playN: 0,
      suppress: { eat: false, sleep: false }, // stop(): the app's meal / sleep shown as idle until it ends
      rawHolds: null, // the holds of the last frame, before stop()'s suppression
      // T-5084
      lastVariant: {}, // director reaction slot → the clip id it played last
      variants: [], // reaction clips played, newest last: { t, slot, id }
      lastPose: {}, // posture group → the slot of its last bout
      bout: null, // the posture bout now: { key, clip }
      rest: null, // a rest break: { group, until }
      restAt: null, // when the next rest break may start
      poses: [], // posture changes, newest last: { t, pose, slot, source }
      seg: { think: { cur: null, prev: null, n: 0, last: null } }, // think segments (talk keeps S.talk)
      prevMood: null,
      manual: null, // a clip played by hand: { kind: 'base' | 'overlay', clip, start, until, key, why }
      manualN: 0,
      manuals: [], // { t, id, kind, end?: why }
    };
    const reactionClip = (slot) => Lib.resolve(index, slot, style.set, overrides, usable);

    const postureClip = (slot) => Lib.resolve(index, slot, style.set, overrides, usable);
    const poseOf = (c) => (c && POSE_GROUPS.includes(c.group) ? c.group : c && c.sit ? 'sit' : 'stand');
    const poseNow = () => (S.base && S.base.pose) || 'stand';
    // a clip fits the pose she is in: anything but a full-body clip that starts in another pose
    const fits = (c) => !c || c.mask !== 'full' || (c.enter || 'stand') === poseNow();

    // The clip a reaction slot plays now (REACTION_GROUPS): its own and its groups', loaded, fitting her pose; moving
    // ones first; never the one it played last. null: none (the reaction is then its face and gaze only).
    // (mask: the mask it will be laid over with, when not its own — an upper-body yawn fits a seated pose)
    function reactionVariant(slot, mask = null) {
      const seen = new Set();
      const cands = [];
      const add = (c) => { if (c && !seen.has(c.id) && (mask ? mask !== 'full' || fits(c) : fits(c))) { seen.add(c.id); cands.push(c); } };
      add(reactionClip(slot));
      for (const g of REACTION_GROUPS[slot] || []) for (const c of Lib.variants(index, g, style.set, usable)) if (c.kind === 'reaction') add(c);
      const moving = cands.filter((c) => !c.still && (c.duration || 1) > 1.05);
      const list = moving.length ? moving : cands;
      if (!list.length) return null;
      const last = S.lastVariant[slot];
      const pool = list.length > 1 ? list.filter((c) => c.id !== last) : list;
      const c = pool[Math.floor(rand() * pool.length) % pool.length];
      S.lastVariant[slot] = c.id;
      return c;
    }

    // One posture of `group` for the bout `key` (kept for the whole bout; a new bout avoids the last one's posture).
    function postureVariant(group, key) {
      if (S.bout && S.bout.key === key && S.bout.clip && usable(S.bout.clip)) return S.bout.clip;
      const list = Lib.variants(index, group, style.set, usable).filter((c) => c.kind === 'posture');
      if (!list.length) return null;
      const pool = list.length > 1 ? list.filter((c) => c.slot !== S.lastPose[group]) : list;
      const c = pool[Math.floor(rand() * pool.length) % pool.length];
      S.lastPose[group] = c.slot;
      S.bout = { key, clip: c };
      return c;
    }
    const hasPose = (group) => Lib.variants(index, group, style.set, usable).some((c) => c.kind === 'posture');
    const setSetting = (p) => { setting = p === 'auto' || Lib.POSTURES.includes(p) ? p : 'auto'; S.idle = null; };
    setSetting(opts.posture || 'auto');

    // the posture she is held in, or null (auto: the idle pool decides)
    function heldPosture(holds) {
      if (holds.mood === 'sleep') return { slot: 'sit.doze', source: 'sleep' };
      if (setting !== 'auto') return { slot: setting, source: 'setting' };
      const bout = (group, key, slot, source) => { const c = postureVariant(group, key); return c ? { slot: c.slot, clip: c, source } : slot ? { slot, source } : null; };
      if (S.t - S.lastEvent >= boredAfter && !holds.attention) {
        // bored: she sits down; twice as long, she lies down (T-5084) — the old sit.rest when the library has no group
        if (S.t - S.lastEvent >= boredAfter * 2 && hasPose('lay')) return bout('lay', 'bored:lay', null, 'bored');
        return bout('sit', 'bored:sit', 'sit.rest', 'bored');
      }
      if (S.t < S.shyUntil) return { slot: 'stand.shy', source: 'shy' };
      if (holds.mood === 'sad') return (hasPose('crouch') && bout('crouch', 'mood:sad', null, 'mood')) || { slot: 'stand.shy', source: 'mood' };
      if (holds.mood === 'hungry') return { slot: 'stand.shy', source: 'mood' };
      if (S.rest) return bout(S.rest.group, `rest:${S.rest.n}`, null, 'rest');
      return null;
    }

    // A rest break now and then (REST): only in auto, from a calm idle (nothing held, no reaction, no attention).
    // calm: nothing going on (a break may start); keep: nothing that makes her stand up (a touch, a reaction does not)
    function stepRest(holds, calm, keep) {
      if (S.restAt === null) S.restAt = S.t + between(REST.after[0], REST.after[1]);
      if (S.rest && (S.t >= S.rest.until || !keep || setting !== 'auto')) { S.rest = null; S.restAt = S.t + between(REST.after[0], REST.after[1]); }
      if (!S.rest && calm && setting === 'auto' && S.t >= S.restAt) {
        const groups = ['sit', 'crouch'].filter(hasPose);
        if (!groups.length) { S.restAt = S.t + between(REST.after[0], REST.after[1]); return; }
        const group = holds.mood === 'happy' && groups.includes('sit') ? 'sit' : groups[Math.floor(rand() * groups.length) % groups.length];
        S.rest = { group, until: S.t + between(REST.dur[0], REST.dur[1]), n: (S.rest ? S.rest.n : S.restN || 0) + 1 };
        S.restN = S.rest.n;
      }
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
      // none of the last min(IDLE_RECENT, ⌊n/2⌋) idles again (T-5084; before, only the very last one)
      const k = Math.max(1, Math.min(IDLE_RECENT, Math.floor(list.length / 2)));
      const recent = new Set(S.history.slice(-k));
      let choices = list.length > 1 ? list.filter((c) => !recent.has(c.slot)) : list;
      if (!choices.length) choices = list.filter((c) => c.slot !== S.lastIdle);
      if (!choices.length) choices = list;
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
      const fromDance = !!(S.base && S.base.dance);
      const pose = poseOf(clip);
      // (one crouch / lay for another is a whole-body change too: the same long fade, T-5092)
      const poseChange = S.base && !fromDance && (pose === 'lay' || S.base.pose === 'lay' || pose === 'crouch' || S.base.pose === 'crouch');
      S.base = { id, file: clip ? clip.file || null : null, sit: !!(clip && clip.sit), pose, fade: first ? FADE.first : fromDance ? DANCE.fadeOut : poseChange ? FADE.pose : sitChange ? FADE.sit : fade, key: (S.base ? S.base.key : 0) + 1 };
      if (!first && (pose !== 'stand' || (S.poses.length && S.poses[S.poses.length - 1].pose !== 'stand'))) { S.poses.push({ t: +S.t.toFixed(3), pose, slot: clip ? clip.slot : null, source }); if (S.poses.length > 30) S.poses.shift(); }
      if (fromDance || S.resetWhy) S.baseFadeUntil = S.t + S.base.fade; // a reset (T-2830) from a posture (asleep: sit.doze) fades too
      S.posture = posture;
      S.postureSource = source;
    }

    // ---------- the reaction layer ----------
    // the weight (0..1, before the clip's own weight) of reaction r at time t: its fade-in, its fade-out at
    // the end, or the quick cut when another reaction took over
    function reactWeight(r, t, inScale = 1) {
      const smoothK = (x) => { const k = clamp(x, 0, 1); return k * k * (3 - 2 * k); };
      let w = Math.min(smoothK((t - r.start) / (r.fadeIn * inScale)), smoothK((r.end - t) / r.fadeOut));
      if (r.cutAt !== undefined) w = Math.min(w, r.cutFrom * smoothK(1 - (t - r.cutAt) / CUT));
      return clamp(w, 0, 1);
    }

    // Start reaction `slot` now (a new one cuts the old: it fades out under the new one, no snap). opts:
    // { prio, amp (0..1, e.g. a cue's small cheer: its face, T-5098), hold (s, overrides the clip's), why }
    function startReaction(slot, opts = {}) {
      const cur0 = S.react;
      // the same reaction going on keeps its clip (below); a new one draws its variant (T-5084)
      const clip = opts.clip || (cur0 && cur0.slot === slot && S.t < cur0.end && S.t < cur0.end - cur0.fadeOut ? cur0.clip : reactionVariant(slot));
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
      // a touch, a drop, a celebration ends the play one-shot (a cue's small cheer never starts over it)
      if (S.play && (opts.prio !== undefined ? opts.prio : PRIORITY.touch) > PRIORITY.cue) endPlay();
      // (T-5084: a full-body clip comes in over ≥ 0.4 s — its first frame can be far from her pose, and at the calm
      // 12 fps a 0.25 s fade is two frames)
      const fadeIn = clip ? Math.max(clip.fadeIn || 0.25, clip.mask === 'full' && (opts.mask || 'full') === 'full' ? 0.4 : 0) : 0.2;
      const fadeOut = clip ? clip.fadeOut || 0.5 : 0.5;
      const hold = opts.hold !== undefined ? opts.hold : clip ? (clip.hold || look.hold || 0) : 0;
      const dur = clip ? (clip.still ? 0 : clip.duration || 1) : 0;
      const playEnd = S.t + dur;
      const end = opts.loop && clip ? Infinity : clip ? Math.max(playEnd + hold, S.t + fadeIn) + fadeOut : S.t + NO_CLIP;
      const r = {
        slot, clip: clip || null, prio: opts.prio !== undefined ? opts.prio : PRIORITY.touch, start: S.t, playEnd, end, hold, fadeIn, fadeOut,
        // T-5098: `amp` (a cue's small cheer) no longer scales the body's weight: a full-body clip at 0.6 is a pose
        // 60 % of the way from the idle's to the clip's — the cheer's fists overhead (+60°) over arms hanging (−75°)
        // came out as both arms held level for 1.5 s (Wanderer, T-5097). The clip plays as it is; amp softens the face
        weight: clip ? clamp(clip.weight * (style.amplitude >= 1 ? 1 : 0.85 + 0.15 * style.amplitude), 0, 1) : 0,
        face: opts.amp !== undefined && opts.amp < 1 ? scaleFace((clip && clip.face) || look.face || {}, opts.amp) : (clip && clip.face) || look.face || {}, gaze: (clip && clip.gaze) || look.gaze || null, gazeFor: look.gaze && look.gaze.for,
        noBlink: look.noBlink || 0, key: ++S.reactKey, why: opts.why || null,
        mask: opts.mask || (clip && clip.mask) || 'upper', loop: !!(opts.loop && clip), manual: !!opts.manual,
        // T-5092: a touch holds the base still while its clip plays (≤ TOUCH_SETTLE.base s)
        settleUntil: opts.touch && settleOn ? Math.min(playEnd, S.t + TOUCH_SETTLE.base) : null,
      };
      S.react = r;
      S.reactions.push(slot);
      if (S.reactions.length > 50) S.reactions.shift();
      if (clip) { S.variants.push({ t: +S.t.toFixed(3), slot, id: clip.id }); if (S.variants.length > 50) S.variants.shift(); }
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
      if (DANCE_ON.includes(S.dance.state)) {
        // the whole body is the dance's: a touch shows on her face only; the rest waits or is dropped (§3.4)
        if (e.type === 'touch' && !holds.lift) {
          const tf = e.mood === 'happy' || !TOUCH_FACE[e.mood] ? { face: ZONE_FACE[e.zone] || TOUCH_FACE.happy.face } : TOUCH_FACE[e.mood];
          S.face = { ...(tf.face || tf) };
          S.faceUntil = S.t + DANCE.touchFace;
          S.danceTouch = { zone: e.zone, mood: e.mood, at: S.t };
        }
        return;
      }
      const busy = S.react && S.t < S.react.end ? S.react.prio : -1;
      if (e.type === 'touch') {
        if (holds.lift) return; // held in the air: the lift wins
        const slot = e.mood === 'happy' || !MOOD_REACTION[e.mood] ? ZONE_REACTION[e.zone] || 'react.touch-head' : MOOD_REACTION[e.mood];
        startReaction(slot, { prio: PRIORITY.touch, why: `touch:${e.zone}:${e.mood}`, touch: true });
      } else if (e.type === 'drag') {
        if (e.what !== 'lift' && S.t - S.resetAt < 0.5) return; // a reset let her go (T-2830): no landing reaction
        if (e.what === 'lift') cutReaction(); // the lift hold takes over at once
        else startReaction('react.drop', { prio: PRIORITY.drop, hold: e.what === 'thrown' ? 0.7 : undefined, amp: 1, why: `drag:${e.what}` });
      } else if (e.type === 'celebrate') {
        const slot = e.name === 'hatch' ? 'react.greet' : 'react.cheer';
        if (busy > PRIORITY.celebrate || holds.lift) S.queued = { slot, why: `celebrate:${e.name}` }; // one waits, more are dropped
        else startReaction(slot, { prio: PRIORITY.celebrate, why: `celebrate:${e.name}` });
      } else if (e.type === 'play') {
        // 玩耍 (T-2831): the user's order — a one-shot of hops and waves; held up in the air there is none
        if (holds.lift) return;
        if (S.react) cutReaction();
        S.queued = null;
        S.play = { start: S.t, until: S.t + ACT.play.dur, n: ++S.playN };
      } else if (e.type === 'cue') {
        if (e.name === 'look') S.scanUntil = S.t + 2.6;
        else if (e.name === 'play' || e.name === 'happy') {
          // a hint, not an order: now and then a small cheer, else a smile; never over anything else
          if (busy < 0 && !playing() && !holds.lift && !holds.think && !holds.eat && !holds.talk && rand() < 0.35) startReaction('react.cheer', { prio: PRIORITY.cue, amp: 0.6, why: `cue:${e.name}` });
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
        // (T-5098: a full-body hold comes in over ≥ HOLD_FULL_IN s — hold.lift's 0.2 s was two frames at 9 fps, one of
        // them a lurch of the forearms the limiter had to cap)
        const fade = h.clip ? (on ? Math.max(h.clip.fadeIn || 0, h.clip.mask === 'full' ? HOLD_FULL_IN : 0) : h.clip.fadeOut) : 0.3;
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
      // the fastest speed that can still slow down in time (√(2·accel·|err|)), so a turn never overshoots
      const want = Math.sign(err) * Math.min(WALK.turnRate, Math.abs(err) * WALK.gain, Math.sqrt(2 * WALK.accel * Math.abs(err)) * 0.85);
      const dv = clamp(want - S.yawVel, -WALK.accel * dt, WALK.accel * dt);
      S.yawVel += dv;
      S.yaw += S.yawVel * dt;
      if ((target - S.yaw) * err < 0 || (Math.abs(target - S.yaw) < 0.05 && Math.abs(S.yawVel) < 1)) { S.yaw = target; S.yawVel = 0; }
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
      G.rate += (target - G.rate) * (1 - Math.exp(-(on ? 12 : 5) * dt));
      if (on && !G.on) G.steps++;
      G.on = on;
      G.phase += dt * G.rate;
      return on;
    }

    // the talk hold as segments: the current one (and the one it replaced, fading out) as overlays
    function nextTalk() {
      const T = S.talk;
      const ids = new Set();
      // every talk clip of the style (the index's talk group, T-5081: 9 per style), else the three talk slots
      const group = Lib.variants(index, SEGMENT_GROUPS.talk, style.set, usable).filter((c) => c.kind === 'hold' && !c.still);
      T.segments = (group.length ? group : Lib.TALK_SEGMENTS.map((s) => reactionClip(s))).filter((c) => c && !ids.has(c.id) && ids.add(c.id));
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

    // Thinking (T-5084): the think group's gestures (hand to the chin, a look up…) one after the other over the
    // think hold, cross-faded like the talk segments; without them the hold's own clip (hold.think).
    function thinkOverlays(h, overlays, on) {
      const T = S.seg.think;
      const list = Lib.variants(index, SEGMENT_GROUPS.think, style.set, usable).filter((c) => !c.still && (c.duration || 1) > 1.05 && fits(c));
      if (!list.length) return false;
      if (h.w <= 0) { T.cur = null; T.prev = null; return true; }
      const next = () => { const pool = list.length > 1 ? list.filter((c) => c.id !== T.last) : list; const c = pool[Math.floor(rand() * pool.length) % pool.length]; T.last = c.id; T.n++; return { slot: c.slot, clip: c, start: S.t }; };
      if (!T.cur) T.cur = next();
      const len = (c) => Math.max(1, c.clip.duration || 1);
      if (on && S.t - T.cur.start >= len(T.cur) - TALK.xfade * 0.5) { T.prev = T.cur; T.cur = next(); }
      const w = h.w * h.w * (3 - 2 * h.w);
      const x = clamp((S.t - T.cur.start) / TALK.xfade, 0, 1);
      const k = T.prev ? x * x * (3 - 2 * x) : 1;
      if (T.prev && k >= 1) T.prev = null;
      const b = w * k * (T.cur.clip.weight || 1);
      if (T.prev) overlays.push({ layer: 'hold', slot: T.prev.slot, id: T.prev.clip.id, mask: T.prev.clip.mask, time: clamp(S.t - T.prev.start, 0, len(T.prev)), weight: +clamp((w * (1 - k) * (T.prev.clip.weight || 1)) / Math.max(1e-3, 1 - b), 0, 1).toFixed(4) });
      overlays.push({ layer: 'hold', slot: T.cur.slot, id: T.cur.clip.id, mask: T.cur.clip.mask, time: clamp(S.t - T.cur.start, 0, len(T.cur)), weight: +b.toFixed(4) });
      return true;
    }

    // ---------- playing a clip by hand (MANUAL, T-5084) ----------
    // req: { id (a clip id: idle.v03@female), slot (stand.v02, react.nod-01: resolved for her style), group (nod,
    // stretch…: one of its clips), loop }. → { ok, id, kind, label, duration, loop } | { ok: false, reason }
    function findClip(req) {
      const clips = index.clips || {};
      const ok = (c) => c && usable(c) && (c.file || c.cycle);
      if (req.id && ok(clips[req.id])) return clips[req.id];
      if (req.id && /@/.test(req.id)) { const slot = String(req.id).split('@')[0]; const c = Lib.resolve(index, slot, style.set, overrides, usable); if (ok(c)) return c; }
      const slot = req.slot || (req.id && !/@/.test(req.id) ? req.id : null);
      if (slot) { const c = Lib.resolve(index, slot, style.set, overrides, usable); if (ok(c)) return c; }
      if (req.group) {
        const list = Lib.variants(index, req.group, style.set, usable).filter(ok);
        if (list.length) { const pool = list.length > 1 ? list.filter((c) => c.id !== S.lastVariant[`group:${req.group}`]) : list; const c = pool[Math.floor(rand() * pool.length) % pool.length]; S.lastVariant[`group:${req.group}`] = c.id; return c; }
      }
      return null;
    }
    function play(req = {}) {
      const c = findClip(req || {});
      if (!c) return { ok: false, reason: 'no-clip' };
      if (DANCE_ON.includes(S.dance.state)) return { ok: false, reason: 'dancing' };
      endManual('replaced');
      const key = ++S.manualN;
      const why = `manual:${req.why || 'play'}`;
      if (c.kind === 'posture' || c.kind === 'idle') {
        const len = c.kind === 'posture' ? Number(req.hold) > 0 ? clamp(Number(req.hold), 1, 600) : MANUAL.hold : Math.max(MANUAL.minIdle, c.cycle ? c.every * c.cycle.length : c.duration || 1);
        S.manual = { kind: 'base', clip: c, start: S.t, until: req.loop ? Infinity : S.t + len, key, why };
        S.idle = null;
      } else {
        if (S.react) cutReaction();
        S.queued = null;
        const loop = req.loop !== undefined ? !!req.loop : c.kind === 'hold' && c.loop;
        const r = startReaction(c.slot, { clip: c, prio: PRIORITY.manual, loop, manual: true, why, amp: 1 });
        S.manual = { kind: 'overlay', clip: c, start: S.t, until: r.end, key, why, react: r.key };
      }
      S.lastEvent = S.t;
      S.manuals.push({ t: +S.t.toFixed(3), id: c.id, kind: S.manual.kind, why });
      if (S.manuals.length > 30) S.manuals.shift();
      return { ok: true, id: c.id, slot: c.slot, kind: c.kind, layer: S.manual.kind, label: c.label, duration: c.duration || null, loop: S.manual.until === Infinity };
    }
    function endManual(why) {
      if (!S.manual) return null;
      const m = S.manual;
      S.manual = null;
      if (m.kind === 'overlay' && S.react && S.react.key === m.react) cutReaction();
      const rec = S.manuals.slice().reverse().find((x) => x.id === m.clip.id && !x.end);
      if (rec) rec.end = why;
      return m;
    }
    // the manual clip still on? (its overlay can be cut by a touch, a lift…)
    function stepManual(dance, holds) {
      const m = S.manual;
      if (!m) return;
      if (dance.on) return void endManual('dance');
      if (m.kind === 'overlay') {
        const live = S.react && S.react.key === m.react;
        if (!live) endManual(S.react ? 'interrupted' : 'done');
      } else if (S.t >= m.until) endManual('done');
      else if (holds.lift) endManual('lift');
    }

    // The dance layer this frame (DANCE above): its state, and what the app is asked to do.
    function stepDance(holds) {
      const D = S.dance;
      const h = holds.dance && holds.dance.id ? holds.dance : null;
      let request = null;
      if (h && (!DANCE_ON.includes(D.state) || D.id !== h.id)) {
        // a new dance: the reaction and the holds give way at once, the base fades to its first frame
        Object.assign(D, { state: 'cueing', id: h.id, since: S.t, started: false, liftAt: null, dropAt: null, n: D.n + 1 });
        if (S.react) cutReaction();
        S.queued = null;
        S.base = { id: `dance:${h.id}`, file: null, sit: false, dance: true, clock: 'external', fade: S.base ? DANCE.fadeIn : 0, key: (S.base ? S.base.key : 0) + 1 };
      }
      if (h) {
        if (D.state === 'cueing' && S.t - D.since >= DANCE.fadeIn && h.ready !== false) D.state = 'in';
        if (D.state === 'in') {
          if (h.playing) { D.state = 'on'; D.started = true; } else request = 'start';
        }
        if (D.started) {
          // lifted: paused while held up, back to dancing a moment after being put down; held too long → stop
          if (holds.lift) { if (D.liftAt === null) D.liftAt = S.t; D.dropAt = null; } else if (D.liftAt !== null && D.dropAt === null) D.dropAt = S.t;
          const wantPause = holds.lift || (D.dropAt !== null && S.t - D.dropAt < DANCE.resumeAfter);
          if (!wantPause && D.dropAt !== null) { D.liftAt = null; D.dropAt = null; }
          if (holds.lift && S.t - D.liftAt > DANCE.pauseMax) request = 'stop';
          else if (wantPause) request = h.paused ? null : 'pause';
          else if (h.paused === 'lift') request = 'resume';
          if (holds.eat) request = 'stop'; // fed while dancing: the new order wins
          D.state = wantPause || h.paused ? 'paused' : 'on';
        }
        if (S.stopAsked) request = 'stop'; // stop(): the user's stop, also while it cues in
      } else if (DANCE_ON.includes(D.state)) {
        D.state = 'out';
        D.since = S.t;
      }
      if (D.state === 'out' && S.t - D.since >= DANCE.fadeOut) { D.state = 'off'; D.id = null; }
      if (!h) S.stopAsked = null; // the app let the dance go (or there was none): the stop is done
      const on = DANCE_ON.includes(D.state);
      return {
        state: D.state,
        id: D.id,
        on,
        t: h ? Math.max(0, Number(h.t) || 0) : 0,
        request,
        ready: D.state === 'in',
        duck: on ? (holds.recording ? DANCE.duckMic : holds.talk ? DANCE.duckTalk : 1) : 1,
        exclusive: on,
        n: D.n,
      };
    }

    // The action state this frame (ACTIONS above), from the layers: the strongest thing on her now, else
    // `returning` while anything that ended is still fading out, else idle.
    function actionNow(dance, hold, R, holds) {
      if (dance.on) return 'dance';
      if (hold === 'lift') return 'lift';
      if (R && R.manual) return 'manual';
      if (R) return R.why && /^cue:play/.test(R.why) ? 'play' : REACTION_ACTION[R.slot] || 'touch';
      if (S.manual) return 'manual';
      if (S.acts.play.on) return 'play';
      if (hold) return hold;
      if (holds.mood === 'sleep') return 'sleep';
      const fadingHold = [...S.holds.values()].some((h) => h.w > 0);
      const fadingAct = ACT_NAMES.some((n) => S.acts[n].w > 0);
      if (dance.state === 'out' || S.fading.length || fadingHold || fadingAct || S.t < S.baseFadeUntil) return 'returning';
      return 'idle';
    }
    function stepAction(dance, hold, R, holds) {
      const A = S.action;
      const now = actionNow(dance, hold, R, holds);
      if (now !== A.state) {
        S.actions.push({ t: +S.t.toFixed(3), from: A.state, to: now, ...(S.resetWhy ? { why: S.resetWhy } : {}) });
        if (now === 'idle') S.resetWhy = null;
        if (S.actions.length > 50) S.actions.shift();
        S.action = { state: now, since: S.t, from: A.state };
      }
      return { state: S.action.state, since: +S.action.since.toFixed(3), from: S.action.from, exclusive: now === 'dance' };
    }

    // ---------- eat / play / sleep (ACT, T-2831) ----------
    const playing = () => !!(S.play && S.t < S.play.until);
    function endPlay() { if (S.play && S.play.until > S.t) S.play.until = S.t; }
    // the weights of the three this frame: on / off from the app and the layers above, faded by ACT; a
    // reaction on top takes over (× 1 − its weight). → plan.acts
    function stepActs(dt, hold, holds, dance, rw) {
      const free = !dance.on && !holds.lift;
      if (!free || (hold && hold !== 'talk' && hold !== 'walk')) endPlay(); // thinking, a meal, the lift, a dance
      const want = { eat: free && hold === 'eat', play: free && playing(), sleep: free && holds.mood === 'sleep' && (!hold || hold === 'walk') };
      const out = [];
      for (const n of ACT_NAMES) {
        const a = S.acts[n];
        if (want[n] && a.w <= 0) a.start = n === 'play' ? S.play.start : S.t;
        a.on = want[n];
        a.w = clamp(a.w + (a.on ? 1 : -1) * (dt / Math.max(0.05, a.on ? ACT[n].fadeIn : ACT[n].fadeOut)), 0, 1);
        if (a.w > 0) out.push({ name: n, w: +(a.w * a.w * (3 - 2 * a.w) * (1 - rw)).toFixed(4), time: +(S.t - a.start).toFixed(3) });
      }
      return out;
    }

    // The user's stop (T-2829): whatever she does fades back to the idle. → what was stopped.
    function stop(why = 'stop') {
      const was = S.action.state;
      if (DANCE_ON.includes(S.dance.state)) S.stopAsked = why;
      endManual(why);
      if (S.react) cutReaction();
      S.rest = null;
      S.queued = null;
      S.faceUntil = -1;
      S.scanUntil = -1;
      S.gazeUntil = -1;
      S.noBlinkUntil = -1;
      S.shyUntil = -1;
      // T-2831: play ends; a meal or sleep the app still holds shows as idle until it ends
      endPlay();
      const raw = S.rawHolds || {};
      if (raw.eat) S.suppress.eat = true;
      if (raw.mood === 'sleep') S.suppress.sleep = true;
      return { stopped: was, why };
    }

    // 重置姿势 (T-2830): the user's "back to the idle, whatever she is doing" — stop() (the dance asked to stop, the
    // reaction cut and fading, the waiting celebration, face, glances dropped) plus the flags stop() keeps: the
    // anger of a touch streak, the dance's touch face, the boredom clock (she stands in her idle instead of
    // sitting down to rest). The layers then fade out by their own fades (no snap) and stepAction walks
    // … → returning → idle. The app ends its own holds (the meal, sleep, the lift: renderer/app.js resetPose).
    // Already idle with nothing waiting: nothing changes (no new idle, no cut glance) → { reset: false, noop }.
    function reset(why = 'reset') {
      const was = S.action.state;
      if (was === 'idle' && !S.react && !S.queued && !S.fading.length && !S.manual && !DANCE_ON.includes(S.dance.state)) return { reset: false, noop: true, was, why };
      stop(why);
      S.angryUntil = -1;
      S.danceTouch = null;
      S.face = null;
      S.lastEvent = S.t;
      S.resetWhy = why;
      S.resetAt = S.t;
      S.resets.push({ t: +S.t.toFixed(3), was, why });
      if (S.resets.length > 20) S.resets.shift();
      return { reset: true, noop: false, was, why };
    }

    // One frame: dt (seconds, already sped up), { holds, events } from vrm-intent → the plan.
    function update(dt, { holds, events = [] }) {
      S.t += dt;
      // stop() on a meal / sleep the app still holds: shown as idle until it ends (T-2831)
      S.rawHolds = holds;
      if (!holds.eat) S.suppress.eat = false;
      if (holds.mood !== 'sleep') S.suppress.sleep = false;
      if (S.suppress.eat || S.suppress.sleep) holds = { ...holds, eat: S.suppress.eat ? null : holds.eat, mood: S.suppress.sleep ? 'idle' : holds.mood };
      if (holds.attention) S.lastEvent = S.t;
      const dance = stepDance(holds);
      for (const e of events) onEvent(e, holds);
      stepManual(dance, holds);
      // falling asleep she yawns, waking up she stretches (upper body over the posture; only with those clips)
      if (S.prevMood !== null && (holds.mood === 'sleep') !== (S.prevMood === 'sleep') && !dance.on && !holds.lift && !(S.react && S.t < S.react.end)) {
        const slot = holds.mood === 'sleep' ? 'react.yawn' : 'react.stretch';
        const c = reactionVariant(slot, 'upper');
        if (c) startReaction(slot, { clip: c, prio: PRIORITY.sleep, mask: 'upper', why: holds.mood === 'sleep' ? 'sleep:in' : 'sleep:out' });
      }
      S.prevMood = holds.mood || 'idle';
      // a rest break: only from a calm idle (nothing held, no reaction, nobody busy with her)
      const keep = !dance.on && !holds.lift && !holds.think && !holds.talk && !holds.eat && !holds.walk && !holds.attention && !S.manual && holds.mood !== 'sleep' && holds.mood !== 'sad';
      stepRest(holds, keep && !(S.react && S.t < S.react.end), keep);

      const held = heldPosture(holds);
      const list = pool(held, holds);
      // a change of regime (posture held / released, sit / stand) ends the idle at once — unless a touch reaction
      // is playing: then the base she is in stays until it settles (T-5092 TOUCH_SETTLE.base)
      const regime = held ? `held:${held.slot}` : 'auto';
      const settling = !!(S.base && S.react && S.react.settleUntil !== null && S.react.settleUntil !== undefined && S.t < S.react.settleUntil && !dance.on && !(S.manual && S.manual.kind === 'base'));
      S.settling = settling;
      if (settling && S.idle) {
        // nothing: the base of the frame the touch came in on (an idle is always kept: setSetting / play may clear it)
      } else if (!S.idle || S.t >= S.idle.until || S.idle.regime !== regime || !list.some((c) => c.slot === S.idle.slot)) {
        startIdle(list);
        S.idle.regime = regime;
      }

      // the base clip (a dance holds it: stepDance set it)
      const I = S.idle;
      if (dance.on) {
        // nothing: the dance's clip stays the base
      } else if (settling) {
        // nothing: a touch reaction is playing over the base she was in (T-5092)
      } else if (S.manual && S.manual.kind === 'base') {
        // a clip played by hand (T-5084): a posture is held, an idle plays; cross-faded in and back out
        const c = S.manual.clip;
        if (c.cycle) {
          const cyc = c.cycle.filter((s) => postureClip(s));
          const slot = cyc[Math.floor((S.t - S.manual.start) / c.every) % cyc.length];
          setBase(postureClip(slot), FADE.cycle, slot, 'manual');
        } else setBase(c, c.kind === 'posture' ? FADE.posture : FADE.idle, c.kind === 'posture' ? c.slot : null, 'manual');
      } else if (held) {
        const c = held.clip || postureClip(held.slot) || postureClip('stand.relaxed');
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
      const turn = stepFacing(dt, dance.on ? 0 : (holds.walk ? WALK.yaw : WALK.idleYaw) * facing);
      const walkOn = dance.on ? false : stepGait(dt, holds, turn);

      // the activity she holds, by priority
      // (a reply streaming in keeps the app "thinking" while its words appear: then she talks — T-2711)
      let hold = dance.on ? (holds.lift ? 'lift' : null) : holds.lift ? 'lift' : holds.think && !holds.talk ? 'think' : holds.eat ? 'eat' : holds.talk ? 'talk' : walkOn ? 'walk' : null;
      // a talk gesture starting with a touch waits for the reaction to come in (T-5092 TOUCH_SETTLE.talk); one
      // already showing goes on
      const talkW = S.holds.get('hold.talk') ? S.holds.get('hold.talk').w : 0;
      S.talkQueued = settleOn && hold === 'talk' && talkW <= 0 && !!(S.react && /^touch:/.test(S.react.why || '') && S.t < Math.min(S.react.playEnd, S.react.start + TOUCH_SETTLE.talk));
      if (S.talkQueued) hold = null;
      stepHolds(dt, hold);
      // a cue's small cheer is only for an idle moment: thinking, talking, eating or being lifted ends it (it
      // fades out under the hold; T-2711: one ran on over the thinking pose)
      if (hold && hold !== 'walk' && S.react && S.react.prio === PRIORITY.cue) cutReaction();

      // the reaction: over → gone (a queued celebration next); interrupted ones finish fading
      if (S.react && S.t >= S.react.end) S.react = null;
      if (!S.react && S.queued && !holds.lift) { const q = S.queued; S.queued = null; startReaction(q.slot, { prio: PRIORITY.celebrate, why: q.why }); }
      S.fading = S.fading.filter((r) => reactWeight(r, S.t) > 0.001);
      const R = S.react;
      const rw = R ? reactWeight(R, S.t) : 0;
      const acts = stepActs(dt, hold, holds, dance, rw);

      // the clip overlays, bottom to top: the hold, the fading reactions, the reaction (time in the clip, weight)
      const overlays = [];
      const holdClip = (h) => h.clip && overlays.push({ layer: 'hold', slot: h.slot, id: h.clip.id, mask: h.clip.mask, time: h.clip.still ? 0 : (h.slot === 'hold.walk' ? S.gait.phase : S.t - h.start) % Math.max(0.01, h.clip.duration || 1), weight: +(h.w * h.w * (3 - 2 * h.w) * h.clip.weight).toFixed(4) });
      for (const h of S.holds.values()) if (h.slot === 'hold.talk') talkOverlays(h, overlays, hold === 'talk'); else if (!(h.slot === 'hold.think' && thinkOverlays(h, overlays, hold === 'think'))) holdClip(h);
      // (limb: the weight for the hands, forearms and feet — they fade in TOUCH_SETTLE.limbFade × slower, T-5092)
      const reactClip = (r, layer) => r.clip && overlays.push({ layer, slot: r.slot, id: r.clip.id, mask: r.mask || r.clip.mask, time: r.clip.still ? 0 : r.loop ? (S.t - r.start) % Math.max(0.01, r.clip.duration || 1) : clamp(S.t - r.start, 0, r.clip.duration || 1), weight: +(reactWeight(r, S.t) * r.weight).toFixed(4), ...(settleOn ? { limb: +(reactWeight(r, S.t, TOUCH_SETTLE.limbFade) * r.weight).toFixed(4) } : {}), key: r.key });
      for (const r of S.fading) reactClip(r, 'fading');
      if (R) reactClip(R, 'reaction');
      // dancing: nothing over the dance but the lift (§3.1)
      if (dance.on) for (let i = overlays.length - 1; i >= 0; i--) if (overlays[i].slot !== 'hold.lift') overlays.splice(i, 1);

      // face: the mood's, annoyed for a while after angry, the held activity's, a cue's smile, the reaction's
      let face = { ...(MOOD_FACE[holds.mood] || {}) };
      if (S.t < S.angryUntil && !(R && R.slot === 'react.angry')) face = { ...face, angry: 0.3, sad: 0.1 };
      const hc = hold && S.holds.get(`hold.${hold}`);
      if (hold) face = { ...face, ...((hc && hc.clip && hc.clip.face) || (HOLD_LOOK[hold] || {}).face || HOLD_FACE[hold] || {}) };
      if (S.acts.play.on) face = { ...face, ...ACT.play.face };
      if (S.t < S.faceUntil) face = { ...face, ...S.face };
      if (R && S.t < R.end - R.fadeOut * 0.5) face = { ...face, ...R.face }; // from the first frame (the renderer eases it in)
      if (dance.on) {
        // the dance's own face track when it has one (the mixer drives it), else a light smile; a touch's face over it
        face = holds.dance && holds.dance.faceTrack ? {} : { ...DANCE.face };
        if (hold === 'lift') face = { ...face, ...((HOLD_LOOK.lift || {}).face || {}) };
        if (S.t < S.faceUntil) face = { ...face, ...S.face };
      }
      face = scaleFace(face, style.emotion || 1);

      // gaze: the reaction's (a look aside, at the hand), think → up, sleep → down, looking about on cue,
      // the hold's (lifted: down at the ground), else the cursor
      let gaze = { mode: 'cursor' };
      const holdGaze = hold && ((hc && hc.clip && hc.clip.gaze) || (HOLD_LOOK[hold] || {}).gaze);
      if (R && R.gaze && S.t < (R.gazeFor ? R.start + R.gazeFor : R.end - R.fadeOut * 0.5)) gaze = { mode: 'fixed', kind: 'reaction', x: R.gaze.x, y: R.gaze.y };
      else if (hold === 'think' && holdGaze) gaze = { mode: 'fixed', kind: 'think', x: holdGaze.x, y: holdGaze.y };
      else if (holds.mood === 'sleep') gaze = { mode: 'fixed', kind: 'sleep', x: 0, y: -0.6 };
      else if (S.t < S.scanUntil) gaze = { mode: 'fixed', kind: 'scan', x: Math.sin((S.scanUntil - S.t) * 2.4) * 1.4, y: 0.15 };
      else if (holdGaze) gaze = { mode: 'fixed', kind: 'hold', x: holdGaze.x, y: holdGaze.y };
      // dancing she looks at you (the camera), only her eyes move: the head is the dance's
      if (dance.on) gaze = hold === 'lift' && holdGaze ? { mode: 'fixed', kind: 'hold', x: holdGaze.x, y: holdGaze.y } : { mode: 'fixed', kind: 'dance', x: 0, y: 0.05 };

      const action = stepAction(dance, hold, R, holds);

      const micro = I.kind === 'micro' ? MICRO_IDLES[I.slot].life : { sway: 1, lookAway: 1 };
      const standing = !(S.base && (S.base.sit || (S.base.pose && S.base.pose !== 'stand'))) && holds.mood !== 'sleep';
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
        dance,
        action,
        resets: S.resets.length,
        acts, // T-2831: the procedural eat / play / sleep bodies (core/vrm-acts.js), [{ name, w, time }]
        actSit: !!(S.base && S.base.sit),
        life: { dance: dance.on, sleep: holds.mood === 'sleep', sad: holds.mood === 'sad' ? 1 : holds.mood === 'hungry' ? 0.5 : 0, standing, lifted: holds.lift, idle: !hold && !R && S.t >= S.faceUntil, sway: R ? micro.sway * 0.4 : micro.sway, lookAway: micro.lookAway, landKey: S.landKey, nod: hold === 'eat' ? 1 : 0, talk: talkOn ? +(talkOn.w * talkOn.w * (3 - 2 * talkOn.w)).toFixed(3) : 0, walking: S.gait.on },
        facingYaw: +S.yaw.toFixed(3),
        turnLead: dance.on ? 0 : +clamp((turn.target - S.yaw) * WALK.lead, -WALK.leadMax, WALK.leadMax).toFixed(3),
        walk: { on: S.gait.on, rate: +S.gait.rate.toFixed(3), wanted: +S.gait.wanted.toFixed(3), phase: +S.gait.phase.toFixed(3), target: turn.target, turning: turn.turning },
        manual: S.manual ? { id: S.manual.clip.id, kind: S.manual.kind, left: S.manual.until === Infinity ? null : +Math.max(0, S.manual.until - S.t).toFixed(3) } : null,
        pose: poseNow(),
        rest: S.rest ? { group: S.rest.group, left: +Math.max(0, S.rest.until - S.t).toFixed(3) } : null,
        thinkSegment: S.seg.think.cur ? S.seg.think.cur.slot : null,
        talkSegment: S.talk.cur ? S.talk.cur.slot : null,
        talkSegments: S.talk.n,
        settling: !!S.settling, talkQueued: !!S.talkQueued, // T-5092: a touch holding the base still / a talk gesture waiting for it
        busy: dance.on || dance.state === 'out' || !!hold || !!R || !!S.manual || acts.length > 0 || S.fading.length > 0 || S.t < S.faceUntil || S.t < S.scanUntil || turn.turning,
      };
    }

    return {
      update,
      stop,
      reset,
      play,
      stopManual: (why = 'stop') => { const m = endManual(why); return { stopped: !!m, id: m ? m.clip.id : null }; },
      manuals: () => S.manuals.slice(),
      variants: () => S.variants.slice(),
      poses: () => S.poses.slice(),
      resets: () => S.resets.slice(),
      action: () => ({ ...S.action }),
      actions: () => S.actions.slice(),
      setPosture: setSetting,
      get posture() { return setting; },
      setPackIdle: (v) => { packIdle = !!v; },
      seed: (n) => { rand = seeded(n); },
      state: S,
      history: () => S.history.slice(),
      reactions: () => S.reactions.slice(),
    };
  }

  return { TOUCH_SETTLE, IDLE_RECENT, REACTION_GROUPS, SEGMENT_GROUPS, REST, MANUAL, POSE_GROUPS, ACT, ACTIONS, REACTION_ACTION, DANCE, DANCE_ON, WALK, TALK, IDLE_MIN, IDLE_MAX, BORED_AFTER, FADE, MICRO_IDLES, MOOD_FACE, TOUCH_FACE, PRIORITY, DEBOUNCE, CUT, AFTER, MOOD_REACTION, ZONE_REACTION, REACTION_LOOK, createDirector, seeded };
});
