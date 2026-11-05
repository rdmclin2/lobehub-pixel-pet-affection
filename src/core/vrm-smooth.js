'use strict';
// T-5092: the last guard against a snap — an angular-acceleration limit on the bones she shows, after every layer
// (base, holds, reactions, the procedural acts, the alive layer) has written them, right before the frame is drawn.
//
// The jump meter (renderer/vrm.js meterJump, T-5084/T-5089) counts a "spike" on a bone when one frame turns it
// further than both of its neighbours: spike_i = d_i − max(d_{i−1}, d_{i+1}), d in degrees per frame at 30 fps
// (the real frame time normalised). Several layers changing on one frame (a touch: the reaction, a talk gesture,
// the idle) can add up to such a one-frame lurch even though each of them eases in. The limiter lets a bone's
// speed grow by at most `accel` (°/frame@30 per frame) from one frame to the next: d_i ≤ d_{i−1} + accel, so
// spike_i ≤ d_i − d_{i−1} ≤ accel whatever the layers do. Slowing down is never limited (a stop is not a
// spike: the frame before it moved as far), and a bone that lagged catches up at the same bounded rate.
//
// It acts only when a bone would speed up faster than that: a clip's own smooth motion (talk gestures reach
// 30°/frame, but over several frames) passes untouched or nearly so (stats() counts the frames it acted on).
//
// Quaternions are [x, y, z, w] arrays. Pure, no three.js: test/vrm-smooth.test.js runs it in Node, the renderer
// wraps three's quaternions around it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmSmooth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEG = 180 / Math.PI;
  const ACCEL = 8; // °/frame@30 of extra speed per frame (the T-5089 spike threshold is 10)

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b)))) * DEG;
  function slerp(a, b, t) {
    let d = dot(a, b);
    let bb = b;
    if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
    let ka; let kb;
    if (d > 0.9995) { ka = 1 - t; kb = t; } else { const th = Math.acos(Math.min(1, d)); const s = Math.sin(th); ka = Math.sin((1 - t) * th) / s; kb = Math.sin(t * th) / s; }
    const q = [a[0] * ka + bb[0] * kb, a[1] * ka + bb[1] * kb, a[2] * ka + bb[2] * kb, a[3] * ka + bb[3] * kb];
    const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  }

  // createLimiter({ accel }) → { step(bone, q, dt) → q (the shown rotation), reset(), stats() }
  //   dt: the real frame time (s) — the same the jump meter normalises with. A frame longer than maxDt (a hidden
  //   window, a stall) or the first frame of a bone passes as it is and starts the bone over.
  function createLimiter({ accel = ACCEL, maxDt = 0.5 } = {}) {
    const S = new Map(); // bone → { q, v (°/frame@30 last frame) }
    let frames = 0; let acted = 0; let maxCut = 0;
    function step(bone, q, dt) {
      const s = S.get(bone);
      if (!s || !(dt > 0) || dt > maxDt) { S.set(bone, { q: q.slice(), v: 0 }); return q; }
      const k30 = (1 / 30) / Math.max(1 / 120, dt);
      const d = angle(s.q, q) * k30;
      const allow = s.v + accel;
      let out = q;
      let v = d;
      if (d > allow && d > 1e-6) {
        out = slerp(s.q, q, allow / d);
        v = allow;
        acted++;
        maxCut = Math.max(maxCut, angle(out, q));
      }
      frames++;
      s.q = out.slice();
      s.v = v;
      return out;
    }
    return {
      step,
      reset: () => { S.clear(); },
      // how often it acted (bone-frames), and the most it held a bone back (deg)
      stats: () => ({ frames, acted, maxCutDeg: +maxCut.toFixed(2), accel }),
    };
  }

  // the jump meter's spike over a sequence of rotations of one bone (for the tests and the offline replay):
  // [{ q, dt }] → { speeds (°/frame@30), spikes, maxSpike, maxSpeed }
  function spikes(seq) {
    const d = [];
    for (let i = 1; i < seq.length; i++) d.push(angle(seq[i - 1].q, seq[i].q) * ((1 / 30) / Math.max(1 / 120, seq[i].dt)));
    const sp = d.map((x, i) => (i > 0 && i < d.length - 1 ? Math.max(0, x - Math.max(d[i - 1], d[i + 1])) : 0));
    return { speeds: d, spikes: sp, maxSpike: sp.length ? Math.max(...sp) : 0, maxSpeed: d.length ? Math.max(...d) : 0 };
  }

  return { ACCEL, createLimiter, spikes, angle, slerp };
});
