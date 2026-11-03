'use strict';
// Where a click lands on a VRM figure (docs/vrm-motion-system.md §3.6, T-2681): the touch zones of
// core/touch-zones.js (head, face, chest, belly, butt, hands, legs, feet) as 3D shapes built on the humanoid
// skeleton of this frame — spheres and capsules around the bones — hit by the camera ray through the click.
// The nearest shape along the ray wins, so a hand held in front of her belly is the hand, and the zones
// follow her pose (bowed head, hand on hip, sitting on the floor), unlike the pixel characters' 2D rectangles.
// Sizes scale with the skeleton (hips → head), so a chibi and a tall model both fit.
// Pure (plain [x, y, z] arrays, no three.js); UMD (window.PetVrmHit / require()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmHit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.sqrt(dot(a, a));
  const norm = (a) => { const l = len(a) || 1; return mul(a, 1 / l); };
  const lerp3 = (a, b, k) => add(a, mul(sub(b, a), k));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // The bones the shapes need (world positions); a model without some of them simply has fewer shapes.
  const BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
    'leftMiddleProximal', 'rightMiddleProximal', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes'];

  // ray (origin o, unit direction d) × sphere (c, r) → distance along the ray or null
  function raySphere(o, d, c, r) {
    const oc = sub(o, c);
    const b = dot(oc, d);
    const cc = dot(oc, oc) - r * r;
    const h = b * b - cc;
    if (h < 0) return null;
    const t = -b - Math.sqrt(h);
    return t >= 0 ? t : (-b + Math.sqrt(h) >= 0 ? 0 : null);
  }
  // ray × capsule (segment a–b, radius r) → distance or null (the cylinder, then the end caps)
  function rayCapsule(o, d, a, b, r) {
    const ba = sub(b, a);
    const oa = sub(o, a);
    const baba = dot(ba, ba);
    const bard = dot(ba, d);
    const baoa = dot(ba, oa);
    const rdoa = dot(d, oa);
    const oaoa = dot(oa, oa);
    const A = baba - bard * bard;
    const B = baba * rdoa - baoa * bard;
    const C = baba * oaoa - baoa * baoa - r * r * baba;
    const h = B * B - A * C;
    if (h >= 0 && A > 1e-12) {
      const t = (-B - Math.sqrt(h)) / A;
      const y = baoa + t * bard;
      if (y > 0 && y < baba && t >= 0) return t;
    }
    const ts = [raySphere(o, d, a, r), raySphere(o, d, b, r)].filter((v) => v !== null);
    return ts.length ? Math.min(...ts) : null;
  }

  // The shapes of this frame from bone positions { name: [x, y, z] } (world). Her facing direction (to tell
  // the face from the back of the head) comes from the skeleton: (right shoulder → left shoulder) × up — a
  // VRM 0.x model turned round by the loader faces the camera all the same; `front` is only the fallback
  // without shoulders. → [{ zone, kind, … }]
  function shapes(bones, front = [0, 0, 1]) {
    const B = (n) => (Array.isArray(bones[n]) ? bones[n] : null);
    const hips = B('hips');
    const head = B('head');
    if (!hips || !head) return [];
    const unit = Math.max(0.05, len(sub(head, hips))); // ≈ 0.5 m on a 1.5 m model
    const neck = B('neck') || lerp3(hips, head, 0.88);
    const spine = B('spine') || lerp3(hips, neck, 0.25);
    const chest = B('chest') || lerp3(hips, neck, 0.5);
    const upper = B('upperChest') || lerp3(chest, neck, 0.5);
    const up = norm(sub(head, neck));
    const la = B('leftUpperArm');
    const ra = B('rightUpperArm');
    const fr = la && ra ? cross(sub(la, ra), up) : null;
    if (fr && len(fr) > 1e-6) front = norm(fr);
    const out = [];
    // the head: a sphere a little above the head bone (hair included); the face is its front, lower part
    const hc = add(head, mul(up, unit * 0.16));
    out.push({ zone: 'head', kind: 'sphere', c: hc, r: unit * 0.24, front: norm(front), up });
    // the trunk, top to bottom
    out.push({ zone: 'chest', kind: 'capsule', a: lerp3(chest, upper, 0.4), b: lerp3(upper, neck, 0.6), r: unit * 0.17 });
    out.push({ zone: 'belly', kind: 'capsule', a: lerp3(hips, spine, 0.6), b: lerp3(spine, chest, 0.7), r: unit * 0.155 });
    out.push({ zone: 'butt', kind: 'capsule', a: add(hips, mul(up, -unit * 0.1)), b: lerp3(hips, spine, 0.4), r: unit * 0.19 });
    for (const s of ['left', 'right']) {
      const ua = B(`${s}UpperArm`);
      const la = B(`${s}LowerArm`);
      const hand = B(`${s}Hand`);
      const tip = B(`${s}MiddleProximal`);
      if (la && hand) out.push({ zone: 'hands', kind: 'capsule', a: lerp3(la, hand, 0.45), b: tip ? add(tip, mul(sub(tip, hand), 0.6)) : add(hand, mul(sub(hand, la), 0.3)), r: unit * 0.075 });
      if (ua && la) out.push({ zone: null, kind: 'capsule', a: ua, b: lerp3(ua, la, 0.95), r: unit * 0.065 }); // the upper arm: no zone (a pat), but it hides what is behind it
      const ul = B(`${s}UpperLeg`);
      const ll = B(`${s}LowerLeg`);
      const foot = B(`${s}Foot`);
      const toes = B(`${s}Toes`);
      if (ul && ll) out.push({ zone: 'legs', kind: 'capsule', a: lerp3(ul, ll, 0.15), b: ll, r: unit * 0.1 });
      if (ll && foot) out.push({ zone: 'legs', kind: 'capsule', a: ll, b: lerp3(ll, foot, 0.85), r: unit * 0.075 });
      if (foot) out.push({ zone: 'feet', kind: 'capsule', a: foot, b: toes ? add(toes, mul(sub(toes, foot), 0.5)) : add(foot, mul(norm(front), unit * 0.12)), r: unit * 0.07 });
    }
    return out;
  }

  // The zone the ray (origin, unit dir) hits first, or { zone: null } when it misses her (or hits an upper arm).
  // → { zone, t, point, shape }
  function hit(list, origin, dir) {
    const d = norm(dir);
    let best = null;
    for (const s of list) {
      const t = s.kind === 'sphere' ? raySphere(origin, d, s.c, s.r) : rayCapsule(origin, d, s.a, s.b, s.r);
      if (t !== null && (!best || t < best.t)) best = { t, s };
    }
    if (!best) return { zone: null, t: null, point: null, shape: null };
    const point = add(origin, mul(d, best.t));
    let zone = best.s.zone;
    if (zone === 'head') {
      // the face: the front of the head sphere, from the brows down to the chin, not too far to the sides
      const rel = sub(point, best.s.c);
      const f = dot(rel, best.s.front) / best.s.r;
      const v = dot(rel, best.s.up) / best.s.r;
      const side = len(sub(rel, add(mul(best.s.front, dot(rel, best.s.front)), mul(best.s.up, dot(rel, best.s.up))))) / best.s.r;
      if (f > 0.35 && v < 0.05 && v > -1 && side < 0.6) zone = 'face';
    }
    return { zone, t: best.t, point, shape: best.s };
  }

  return { BONES, raySphere, rayCapsule, shapes, hit };
});
