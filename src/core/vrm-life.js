'use strict';
// The "alive" layer of a VRM figure (docs/vrm-motion-system.md §3.2 L4): small procedural motion laid on top
// of whatever the clips pose — breathing, a weight shift from leg to leg, the head never quite still, eye
// saccades and glances away, relaxed fingers, legs hanging under gravity while she is lifted. Everything is
// scaled by the style profile (core/vrm-style.js) and capped: a bone turns at most LIMITS.bone degrees
// (lifted legs LIMITS.liftUpperLeg / LIMITS.liftLowerLeg), so nothing here can hop, spin or flail.
// Stateful but pure (an object with step(dt, ctx)); random numbers injected for tests. UMD
// (window.PetVrmLife / require()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmLife = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LIMITS = { bone: 4, liftUpperLeg: 14, liftLowerLeg: 16, liftHips: 6, landUpperLeg: 4, landLowerLeg: 8, stance: 8, root: 0.02 };
  const LAND = 0.5; // seconds of the knee dip when she is put down
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (k) => { const x = clamp(k, 0, 1); return x * x * (3 - 2 * x); };
  const approach = (rate, dt) => 1 - Math.exp(-rate * dt);
  // breaths per minute: awake 14–18, asleep 10
  const BREATH = { awake: [14, 18], sleep: 10 };
  const SHIFT_EVERY = [6, 14]; // the default; a style may set its own (shiftEvery)
  const SACCADE_EVERY = [0.8, 3];
  const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
  const SEG = { Thumb: ['Proximal', 'Distal'], Index: ['Proximal', 'Intermediate', 'Distal'], Middle: ['Proximal', 'Intermediate', 'Distal'], Ring: ['Proximal', 'Intermediate', 'Distal'], Little: ['Proximal', 'Intermediate', 'Distal'] };
  // The names of every bone the layer may touch (the renderer keeps their clip pose between frames, overClip).
  const BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
    ...['left', 'right'].flatMap((s) => FINGERS.flatMap((f) => SEG[f].map((g) => `${s}${f}${g}`)))];

  function createLife({ rand = Math.random, style = null } = {}) {
    const between = (a, b) => a + (b - a) * rand();
    const st = {
      t: 0,
      breathPh: 0,
      bpm: between(BREATH.awake[0], BREATH.awake[1]),
      shift: { from: 0, to: 0, at: -10, next: between(...((style && style.shiftEvery) || SHIFT_EVERY)) },
      saccade: { x: 0, y: 0, next: between(SACCADE_EVERY[0], SACCADE_EVERY[1]) },
      away: { until: -1, x: 0, y: 0, next: 4 + rand() * 8 },
      lift: { k: 0, swing: 0, v: 0 },
      land: { key: 0, at: -10 },
      sad: 0,
    };

    // ctx: { style (profile), sleep, sad (0..1), standing, lifted, velX (window px/s), fingers (the clip has
    //        finger keys), idle (nothing else going on: glances allowed), landKey (goes up when she is put
    //        down: a short knee dip), nod (0..1: small chewing nods while she eats), talk (0..1: nods while
    //        she talks) }
    // → { bones: { name: { x, y, z } deg }, gaze: { x, y } (NDC offset), away: bool, blink: bool, breath: -1..1 }
    function step(dt, ctx = {}) {
      const P = ctx.style || style || { hipSway: 0.75, headTilt: 3, handPose: 0.38, stanceWidth: 0, breath: { chest: 1, upperChest: 0.5, spine: 0.7, shoulder: 0.45 }, lookAway: 0.09 };
      st.t += dt;
      const t = st.t;
      const out = {};
      const add = (b, x = 0, y = 0, z = 0) => { const o = out[b] || (out[b] = { x: 0, y: 0, z: 0 }); o.x += x; o.y += y; o.z += z; };
      let blink = false;

      // breathing: the rate wanders inside its range; asleep slower and deeper; the chest opens (−x) on the
      // in-breath, the shoulders rise a little
      const target = ctx.sleep ? BREATH.sleep : st.bpm;
      if (rand() < dt * 0.05) st.bpm = between(BREATH.awake[0], BREATH.awake[1]);
      st.breathPh += (2 * Math.PI * target * dt) / 60;
      const b = Math.sin(st.breathPh);
      const amp = (ctx.sleep ? 1.6 : 1) * (1 - 0.15 * (ctx.sad || 0));
      const br = P.breath || {};
      add('chest', -b * (br.chest || 0) * amp);
      add('upperChest', -b * (br.upperChest || 0) * amp);
      add('spine', -b * (br.spine || 0) * amp);
      add('leftShoulder', 0, 0, Math.max(0, b) * (br.shoulder || 0) * amp);
      add('rightShoulder', 0, 0, -Math.max(0, b) * (br.shoulder || 0) * amp);

      // weight from one leg to the other every 6–14 s (the style's shiftEvery; standing only): hips roll, the spine leans back the
      // other way, the legs stay under her
      const sh = st.shift;
      if (t >= sh.at + sh.next) {
        sh.from = sh.from + (sh.to - sh.from) * smooth((t - sh.at) / 1.5);
        sh.to = ctx.standing === false ? 0 : (rand() < 0.5 ? -1 : 1) * between(0.5, 1);
        sh.at = t;
        sh.next = between(...(P.shiftEvery || SHIFT_EVERY));
      }
      const side = (sh.from + (sh.to - sh.from) * smooth((t - sh.at) / 1.5)) * (ctx.standing === false ? 0 : 1);
      const roll = 2 * P.hipSway * side;
      add('hips', 0, 0, roll);
      add('spine', 0, 0, -roll * 0.5);
      add('leftUpperLeg', 0, 0, -roll);
      add('rightUpperLeg', 0, 0, -roll);

      // the head: three slow sines that never line up; bowed a little when sad
      const hk = P.headTilt / 4;
      add('head', Math.sin(t * 2 * Math.PI * 0.13) * hk + 3 * (ctx.sad || 0) * 0.8, Math.sin(t * 2 * Math.PI * 0.31 + 1.3) * hk, Math.sin(t * 2 * Math.PI * 0.47 + 2.1) * hk * 0.8);
      add('neck', 3 * (ctx.sad || 0) * 0.2);
      // eating: small nods with the chewing (the mouth chews at 1.4 Hz, core/vrm-motion.js chewMouth)
      if (ctx.nod) add('head', 2.5 * ctx.nod * Math.max(0, Math.sin(t * 2 * Math.PI * 1.4)));
      // talking: light nods on the phrases, on two beats that never line up (the talk clips do the gestures;
      // T-2711: 说话 = 讲解手势 + 轻点头, unlike thinking, which holds still and looks up)
      if (ctx.talk) add('head', 2.2 * ctx.talk * Math.max(0, Math.sin(t * 2 * Math.PI * 0.9) * 0.7 + Math.sin(t * 2 * Math.PI * 0.37 + 0.8) * 0.5));

      // relaxed fingers when the clip does not pose them
      if (ctx.fingers === false) {
        const c = P.handPose * 4;
        for (const s of ['left', 'right']) for (const f of FINGERS) for (const g of SEG[f]) add(`${s}${f}${g}`, 0, 0, (s === 'left' ? -1 : 1) * c * (f === 'Thumb' ? 0.5 : 1));
      }

      // eyes: a small jump every 0.8–3 s; idle, now and then a look elsewhere for 1–2 s (a blink with it)
      const sc = st.saccade;
      if (t >= sc.next) { sc.x = between(-0.05, 0.05); sc.y = between(-0.04, 0.04); sc.next = t + between(SACCADE_EVERY[0], SACCADE_EVERY[1]); }
      const aw = st.away;
      let away = false;
      if (ctx.idle && t >= aw.next && aw.until < t) {
        if (rand() < (P.lookAway || 0.09) * 4) { aw.until = t + between(1, 2); aw.x = between(0.6, 1.4) * (rand() < 0.5 ? -1 : 1); aw.y = between(-0.5, 0.3); if (rand() < 0.3) blink = true; }
        aw.next = t + between(3, 7);
      }
      if (aw.until >= t && ctx.idle) away = true;

      // the cap on everything so far
      for (const o of Object.values(out)) { o.x = clamp(o.x, -LIMITS.bone, LIMITS.bone); o.y = clamp(o.y, -LIMITS.bone, LIMITS.bone); o.z = clamp(o.z, -LIMITS.bone, LIMITS.bone); }

      // stance: the male set stands with the feet apart (a fixed offset, not motion)
      if (P.stanceWidth && ctx.standing !== false && !ctx.lifted) {
        const w = clamp(P.stanceWidth, -LIMITS.stance, LIMITS.stance) * 0.5;
        add('leftUpperLeg', 0, 0, w);
        add('rightUpperLeg', 0, 0, -w);
      }

      // lifted: the hanging pose itself is baked into hold.lift (legs straight down, toes pointing down,
      // scripts/vrm-bake.js `pose`); here the legs and the body swing behind the window's motion like a damped
      // pendulum (sideways with a horizontal drag, a little forward / back), and while the window is still the
      // feet dangle slowly, one after the other. Knees only ever bend forward (lower leg x ≥ 0), never back.
      const L = st.lift;
      L.k += ((ctx.lifted ? 1 : 0) - L.k) * approach(6, dt);
      // the window moving right (+velX, screen right = her left, +X) leaves the feet behind to the left: −z
      const push = clamp((ctx.velX || 0) / 700, -1, 1);
      L.v += ((push - L.swing) * 40 - L.v * 6) * dt;
      L.swing = clamp(L.swing + L.v * dt, -1, 1);
      if (L.k > 0.001) {
        const k = L.k;
        // how far the legs swing with the drag: the style's liftSwing (the male set's legs are longer and his
        // baked hanging pose stiffer: at 1× they swung half as far as hers, T-2711)
        const sw = L.swing * k * (P.liftSwing || 1);
        const still = 1 - Math.min(1, Math.abs(L.swing) * 2);
        const dangle = Math.sin(t * 2 * Math.PI * 0.55) * 4 * k * (0.4 + 0.6 * still) * (P.liftSwing || 1);
        const hz = clamp(-LIMITS.liftHips * sw, -LIMITS.liftHips, LIMITS.liftHips);
        const hips = out.hips || (out.hips = { x: 0, y: 0, z: 0 });
        hips.z = hips.z * (1 - k) + hz; // the weight shift gives way to the swing
        const sp = out.spine || (out.spine = { x: 0, y: 0, z: 0 });
        sp.z = sp.z * (1 - k) - hz * 0.4;
        for (const s of ['left', 'right']) {
          const ph = s === 'left' ? 1 : -1;
          const o = out[`${s}UpperLeg`] || (out[`${s}UpperLeg`] = { x: 0, y: 0, z: 0 });
          o.x = clamp(o.x * (1 - k) - 5 * sw * (s === 'left' ? 1 : 0.8) + dangle * ph, -LIMITS.liftUpperLeg, LIMITS.liftUpperLeg);
          o.z = clamp(o.z * (1 - k) - 9 * sw, -LIMITS.liftUpperLeg, LIMITS.liftUpperLeg);
          const l = out[`${s}LowerLeg`] || (out[`${s}LowerLeg`] = { x: 0, y: 0, z: 0 });
          l.x = clamp(l.x + (2 + 6 * Math.abs(L.swing)) * k * (s === 'left' ? 1 : 0.85) + Math.max(0, dangle * ph), 0, LIMITS.liftLowerLeg);
        }
      }

      // put down: the knees give a little and come back (≤ 4° / 8°), the feet stay on the floor (the renderer
      // grounds them), so the body sinks a centimetre or two and rises — no hop
      const ld = st.land;
      if (ctx.landKey !== undefined && ctx.landKey !== ld.key) { if (ld.key || ctx.landKey) ld.at = t; ld.key = ctx.landKey; }
      const lt = t - ld.at;
      if (lt >= 0 && lt < LAND && !ctx.lifted) {
        const d = Math.sin((Math.PI * lt) / LAND) * (P.hipSway >= 1 ? 1 : 0.6);
        for (const s of ['left', 'right']) {
          const u = out[`${s}UpperLeg`] || (out[`${s}UpperLeg`] = { x: 0, y: 0, z: 0 });
          u.x = clamp(u.x - LIMITS.landUpperLeg * d, -LIMITS.liftUpperLeg, LIMITS.liftUpperLeg);
          const l = out[`${s}LowerLeg`] || (out[`${s}LowerLeg`] = { x: 0, y: 0, z: 0 });
          l.x = clamp(l.x + LIMITS.landLowerLeg * d, 0, LIMITS.liftLowerLeg);
        }
      }

      return { bones: out, gaze: away ? { x: aw.x, y: aw.y } : { x: sc.x, y: sc.y }, away, blink, breath: b };
    }
    return { step, state: st };
  }

  return { LIMITS, LAND, BREATH, SHIFT_EVERY, BONES, createLife };
});
