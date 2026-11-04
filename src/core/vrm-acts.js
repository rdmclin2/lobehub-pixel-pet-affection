'use strict';
// The body of 吃饭 / 玩耍 / 睡觉 for a VRM figure (T-2831, docs/vrm-motion-system.md §14): procedural bone poses,
// made here from keyframes and curves, no animation file. The motion library (core/vrm-library.json) has no
// clip for any of the three that moves the body — hold.eat is a still upper-body stand (a nod and the chewing
// mouth were all a meal showed), sleep only has the sit.doze posture (and only with the library baked), play only
// a cue that now and then cheered — and the installed app ships no library at all (§6.2). So without this layer
// eating, playing and sleeping only changed her face.
//
//   eat   the food to her mouth and back: a bite every EAT.period s, the hand(s) held at the mouth, lowered a
//         little while she chews, the head nodding with the chewing. female / neutral: both hands (holding it
//         up), male: the right hand, a bigger lean in.
//   play  a one-shot of PLAY.dur s: little hops with a knee dip between them, swaying side to side, waving —
//         female / neutral both arms up in turn, male the right arm (the left left to the posture), smaller hops.
//   sleep dozing: the head drops (and lolls a little to one side), the back slumps, the shoulders sink, a slow
//         deep breath, now and then a nod-off; standing (no sitting posture) her knees give a little and the arms
//         hang loose — she sinks down (the renderer keeps her feet on the floor). Seated (sit.doze) only the head,
//         neck and back move, so the posture's own arms stay on the seat.
//
// A pose is { abs: { bone: {x, y, z} }, add: { bone: {x, y, z} }, air } — abs: where a bone is turned to (deg,
// normalized bones, VRM 1.0 / VRMA terms: she faces +Z, her left arm points +X), add: an offset on top of the
// pose under it, air: how far the whole body is lifted (× her hip height). The director (core/vrm-director.js)
// decides which act plays and its weight (fades, interruption, stop); apply() lays the weighted acts on the
// bones — the renderer calls it every frame after the clip layers, the tests on a real three skeleton.
// UMD (window.PetVrmActs / require()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmActs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ACTS = ['eat', 'play', 'sleep'];
  // (when each plays, its fades and play's length are the director's: core/vrm-director.js ACT)
  const EAT = { period: 2.4, chewHz: 1.4 };
  const PLAY = { hopHz: 2.0, waveHz: 2.6, swayHz: 1.0, air: 0.05 };
  const SLEEP = { breathHz: 0.16, nodEvery: 7 };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (k) => { const x = clamp(k, 0, 1); return x * x * (3 - 2 * x); };
  const mix = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k });
  const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
  // the left side as the mirror of the right (x stays, y and z turn the other way)
  const mirror = (r) => ({ x: r.x, y: -r.y || 0, z: -r.z || 0 });

  // the right arm with the food at her mouth, and lowered a little while she chews (solved on a human skeleton:
  // the hand ends ~7 cm in front of the mouth, the elbow below and ahead of the shoulder)
  const BITE = { up: v(-50, 50, 80), low: v(0, 140, 0), hand: v(0, 0, -10) };
  const CHEW = { up: v(-38, 42, 78), low: v(0, 118, 0), hand: v(0, 0, -5) };
  // the arm hanging loose a little ahead of her (asleep, standing)
  const LOOSE = { up: v(-10, 0, 80), low: v(0, 18, 0) };

  const isMale = (set) => set === 'male';

  // The pose of act `name` `t` seconds after it began. opts: { set: female | male | neutral, amplitude (the
  // style's, 0.3..1.3), sit (she sits: sleep leaves the arms and legs to the posture) } → { abs, add, air }
  function pose(name, t, { set = 'neutral', amplitude = 1, sit = false } = {}) {
    const abs = {};
    const add = {};
    const put = (b, r) => { const o = add[b] || (add[b] = v()); o.x += r.x; o.y += r.y; o.z += r.z; };
    const amp = clamp(amplitude, 0.3, 1.3);
    let air = 0;
    const male = isMale(set);
    if (name === 'eat') {
      const p = (t % EAT.period) / EAT.period;
      // 0 → 0.3 up to the mouth, the bite until 0.5, down to chewing by 0.75, chewing until the next bite
      const k = p < 0.3 ? smooth(p / 0.3) : p < 0.5 ? 1 : p < 0.75 ? 1 - smooth((p - 0.5) / 0.25) : 0;
      const first = smooth(t / 0.5); // the first lift comes from wherever the arm was (the fade-in)
      const right = { up: mix(CHEW.up, BITE.up, k * first), low: mix(CHEW.low, BITE.low, k * first), hand: mix(CHEW.hand, BITE.hand, k) };
      abs.rightUpperArm = right.up;
      abs.rightLowerArm = right.low;
      abs.rightHand = right.hand;
      if (!male) { abs.leftUpperArm = mirror(right.up); abs.leftLowerArm = mirror(right.low); abs.leftHand = mirror(right.hand); }
      const chew = Math.sin(t * 2 * Math.PI * EAT.chewHz) * (1 - k);
      const lean = (male ? 6 : 4) * amp;
      put('chest', v(lean * 0.6 + k * 2));
      put('neck', v(3 + k * 4));
      put('head', v(4 + k * (male ? 8 : 6) + chew * 3 * amp, 0, male ? 0 : 3 * amp));
    } else if (name === 'play') {
      const ph = t * 2 * Math.PI * PLAY.hopHz;
      const hop = Math.max(0, Math.sin(ph));
      const dip = Math.max(0, -Math.sin(ph));
      const k = (male ? 0.6 : 1) * amp;
      air = PLAY.air * k * hop ** 1.5;
      for (const s of ['left', 'right']) { put(`${s}UpperLeg`, v(-20 * dip * k)); put(`${s}LowerLeg`, v(38 * dip * k)); put(`${s}Foot`, v(-18 * dip * k)); }
      const sway = Math.sin(t * 2 * Math.PI * PLAY.swayHz);
      put('spine', v(0, 0, 5 * sway * k));
      put('chest', v(-4 * hop * k, 0, 3 * sway * k));
      put('head', v(0, 0, -7 * sway * amp));
      const wave = (off) => Math.sin(t * 2 * Math.PI * PLAY.waveHz + off);
      // the right arm up (z −60: above level), the forearm waving side to side; the left the same in turn
      abs.rightUpperArm = v(-10, 0, -58 + 8 * wave(0));
      abs.rightLowerArm = v(0, 10, -18 + 28 * wave(0.6));
      abs.rightHand = v(0, 0, 10 * wave(1.2));
      if (!male) {
        abs.leftUpperArm = mirror(v(-10, 0, -58 + 8 * wave(Math.PI)));
        abs.leftLowerArm = mirror(v(0, 10, -18 + 28 * wave(Math.PI + 0.6)));
        abs.leftHand = mirror(v(0, 0, 10 * wave(Math.PI + 1.2)));
      }
    } else if (name === 'sleep') {
      const breath = Math.sin(t * 2 * Math.PI * SLEEP.breathHz);
      // nodding off: the head sinks over most of the cycle and comes up a little at its end
      const c = (t % SLEEP.nodEvery) / SLEEP.nodEvery;
      const nod = c < 0.85 ? smooth(c / 0.85) : 1 - smooth((c - 0.85) / 0.15);
      const settle = smooth(t / 1.5); // she slumps in over the first second and a half
      const k = (male ? 0.85 : 1) * settle;
      put('spine', v(6 * k + breath * 0.6));
      put('chest', v(7 * k - breath * 2.2));
      put('upperChest', v(3 * k - breath * 1.2));
      put('neck', v(10 * k + nod * 3));
      put('head', v((16 + nod * 9) * k, 0, (male ? 4 : 9) * k));
      put('leftShoulder', v(0, 0, -5 * k + breath * 1.2));
      put('rightShoulder', v(0, 0, 5 * k - breath * 1.2));
      if (!sit) {
        for (const s of ['left', 'right']) { put(`${s}UpperLeg`, v(-16 * k)); put(`${s}LowerLeg`, v(30 * k)); put(`${s}Foot`, v(-14 * k)); }
        abs.rightUpperArm = LOOSE.up;
        abs.rightLowerArm = LOOSE.low;
        abs.leftUpperArm = mirror(LOOSE.up);
        abs.leftLowerArm = mirror(LOOSE.low);
      }
    }
    return { abs, add, air };
  }

  // The acts of one frame (plan.acts: [{ name, w, time }]) on the bones. THREE: three.js; nodeOf(bone) → the
  // normalized bone node or null; opts: { set, amplitude, sit, v0 (−1 for a VRM 0.x model: its normalized bones
  // face −Z, so x and z turn the other way — the alive layer's convention, T-2691) }. abs bones are slerped
  // towards their pose by the act's weight, add offsets multiplied on scaled by it. → { air, bones (the names
  // moved) }
  const scratch = new WeakMap();
  function apply(THREE, nodeOf, acts, opts = {}) {
    let tmp = scratch.get(THREE);
    if (!tmp) { tmp = { e: new THREE.Euler(), q: new THREE.Quaternion() }; scratch.set(THREE, tmp); }
    const D = Math.PI / 180;
    const v0 = opts.v0 === -1 ? -1 : 1;
    let air = 0;
    const moved = new Set();
    for (const a of acts || []) {
      const w = clamp(Number(a.w) || 0, 0, 1);
      if (!(w > 0.0005) || !ACTS.includes(a.name)) continue;
      const P = pose(a.name, a.time || 0, opts);
      for (const [b, r] of Object.entries(P.abs)) {
        const n = nodeOf(b);
        if (!n) continue;
        tmp.e.set(r.x * D * v0, r.y * D, r.z * D * v0);
        n.quaternion.slerp(tmp.q.setFromEuler(tmp.e), w);
        moved.add(b);
      }
      for (const [b, r] of Object.entries(P.add)) {
        const n = nodeOf(b);
        if (!n) continue;
        tmp.e.set(r.x * D * v0 * w, r.y * D * w, r.z * D * v0 * w);
        n.quaternion.multiply(tmp.q.setFromEuler(tmp.e));
        moved.add(b);
      }
      air += P.air * w;
    }
    return { air, bones: [...moved] };
  }

  // the bones an act may turn (the renderer keeps their clip pose from frame to frame, like the alive layer's)
  const BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];

  return { ACTS, EAT, PLAY, SLEEP, BITE, CHEW, LOOSE, BONES, pose, apply, mirror };
});
