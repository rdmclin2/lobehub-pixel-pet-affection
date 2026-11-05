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
  // ray × ellipsoid (centre c, unit axes [a0, a1, a2], radii [r0, r1, r2]) → distance or null: the ray in the
  // ellipsoid's unit-sphere space (the distance along it is the same t)
  function rayEllipsoid(o, d, c, axes, radii) {
    const oc = sub(o, c);
    const o2 = axes.map((a, i) => dot(oc, a) / radii[i]);
    const d2 = axes.map((a, i) => dot(d, a) / radii[i]);
    const A = dot(d2, d2);
    const B = dot(o2, d2);
    const C = dot(o2, o2) - 1;
    const h = B * B - A * C;
    if (h < 0 || A < 1e-12) return null;
    const t = (-B - Math.sqrt(h)) / A;
    return t >= 0 ? t : ((-B + Math.sqrt(h)) / A >= 0 ? 0 : null);
  }
  // how far an ellipsoid reaches along unit direction u from its centre
  const support = (axes, radii, u) => Math.sqrt(axes.reduce((s, a, i) => s + (dot(a, u) * radii[i]) ** 2, 0));

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
  //
  // T-5092: opts.head = { c, axes, r: [r0, r1, r2] } — her head as she is drawn: the box of the vertices that move
  // with the head bone (skull, face, hair, a hat) measured at load, carried by the head bone (renderer/vrm.js
  // headShape) — becomes the head zone (an ellipsoid) instead of a sphere at a fixed offset above the head bone.
  // And a model whose humanoid hips bone sits on the floor (Wanderer: hips at 0 m, head at 1.39 m) is measured
  // from her real hip joints (the upper legs' midpoint): with the bone on the floor every shape was ~3× too big
  // and the chest capsule covered her face, so a click on the head never reached the head.
  //
  // T-5098: opts.parts = { bone: { c, axes, r } } — every body part as she is drawn: the box of the vertices skinned
  // to that humanoid bone (fingers with the hand, toes with the foot), measured at load in a frame along the bone
  // (renderer/vrm.js measurePartBoxes) and carried by the bone, so each zone has the model's own proportions — a
  // 0.53 m chibi's short round belly, a long-legged VRoid's thin thighs — instead of one fraction of hips → head
  // for everyone (paimon: the butt capsule, 0.19 × that, stood in front of her belly; a leg capsule covered her
  // hanging hand). A part without vertices keeps the capsule on the bones.
  // The pelvis (the hips bone's box) is one shape split by side: its front is her belly, its back her butt, below
  // the hip joints her legs — from the front the butt can never cover the belly.
  const PART_ZONE = {
    hips: 'pelvis', spine: 'belly', chest: 'chest', upperChest: 'chest', neck: null,
    leftUpperArm: null, rightUpperArm: null, leftLowerArm: null, rightLowerArm: null, leftHand: 'hands', rightHand: 'hands',
    leftUpperLeg: 'thigh', rightUpperLeg: 'thigh', leftLowerLeg: 'legs', rightLowerLeg: 'legs', leftFoot: 'feet', rightFoot: 'feet',
  };
  const PART_BONES = Object.keys(PART_ZONE);
  const okBox = (b) => b && Array.isArray(b.c) && Array.isArray(b.axes) && Array.isArray(b.r) && b.r.length === 3 && b.r.every((x) => x > 1e-4);

  function shapes(bones, front = [0, 0, 1], opts = {}) {
    const B = (n) => (Array.isArray(bones[n]) ? bones[n] : null);
    let hips = B('hips');
    const head = B('head');
    if (!hips || !head) return [];
    const lu = B('leftUpperLeg');
    const ru = B('rightUpperLeg');
    const joints = lu && ru ? lerp3(lu, ru, 0.5) : null;
    if (joints) {
      const L = len(sub(head, joints));
      // the hips bone far below the hip joints along the body (≥ 25% of hip-joints → head): the joints are her hips
      if (L > 1e-6 && dot(sub(joints, hips), norm(sub(head, joints))) > 0.25 * L) hips = joints;
    }
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
    front = norm(front);
    const parts = opts.parts || {};
    const part = (n) => (okBox(parts[n]) ? parts[n] : null);
    const out = [];
    const ell = (zone, b, extra) => ({ zone, kind: 'ellipsoid', c: b.c, axes: b.axes, radii: b.r, r: Math.max(...b.r), source: 'mesh', ...extra });
    // the head: the drawn head (opts.head, an ellipsoid), else a sphere a little above the head bone (hair
    // included); the face is its front, lower part
    const hb = opts.head;
    if (okBox(hb)) {
      out.push({ zone: 'head', kind: 'ellipsoid', c: hb.c, axes: hb.axes, radii: hb.r, r: support(hb.axes, hb.r, up), front, up, source: 'mesh' });
    } else {
      const hc = add(head, mul(up, unit * 0.16));
      out.push({ zone: 'head', kind: 'sphere', c: hc, r: unit * 0.24, front, up, source: 'bone' });
    }
    // the trunk, top to bottom
    const thigh = lu && B('leftLowerLeg') ? len(sub(B('leftLowerLeg'), lu)) : unit * 0.8;
    const pelvisInfo = { front, up, joints: joints || hips, drop: thigh * 0.3 };
    for (const n of ['upperChest', 'chest', 'neck']) if (part(n)) out.push(ell(PART_ZONE[n], part(n)));
    if (!part('chest') && !part('upperChest')) out.push({ zone: 'chest', kind: 'capsule', a: lerp3(chest, upper, 0.4), b: lerp3(upper, neck, 0.6), r: unit * 0.17 });
    if (part('spine')) out.push(ell('belly', part('spine'), { front }));
    else out.push({ zone: 'belly', kind: 'capsule', a: lerp3(hips, spine, 0.6), b: lerp3(spine, chest, 0.7), r: unit * 0.155 });
    if (part('hips')) out.push(ell('pelvis', part('hips'), pelvisInfo));
    else out.push({ zone: 'pelvis', kind: 'capsule', a: add(hips, mul(up, -unit * 0.1)), b: lerp3(hips, spine, 0.4), r: unit * 0.17, ...pelvisInfo });
    for (const s of ['left', 'right']) {
      const ua = B(`${s}UpperArm`);
      const lo = B(`${s}LowerArm`);
      const hand = B(`${s}Hand`);
      const tip = B(`${s}MiddleProximal`);
      const P = (n) => part(`${s}${n}`);
      // the hand follows the hand bone: its own vertices' box (fingers included), a little generous (a fingertip
      // or the wrist still counts), else a capsule from the wrist to past the knuckles
      if (P('Hand')) out.push(ell('hands', { ...P('Hand'), r: P('Hand').r.map((x) => x * 1.15) }));
      else if (lo && hand) out.push({ zone: 'hands', kind: 'capsule', a: lerp3(lo, hand, 0.45), b: tip ? add(tip, mul(sub(tip, hand), 0.6)) : add(hand, mul(sub(hand, lo), 0.3)), r: unit * 0.075 });
      // the arms: no zone (a pat), but they hide what is behind them
      if (P('UpperArm')) out.push(ell(null, P('UpperArm')));
      else if (ua && lo) out.push({ zone: null, kind: 'capsule', a: ua, b: lerp3(ua, lo, 0.95), r: unit * 0.065 });
      if (P('LowerArm')) out.push(ell(null, P('LowerArm')));
      const ul = B(`${s}UpperLeg`);
      const ll = B(`${s}LowerLeg`);
      const foot = B(`${s}Foot`);
      const toes = B(`${s}Toes`);
      // the thigh: her legs, but its top at the back is her butt (most models skin the buttocks to the upper legs)
      if (P('UpperLeg')) out.push(ell('thigh', P('UpperLeg'), pelvisInfo));
      else if (ul && ll) out.push({ zone: 'thigh', kind: 'capsule', a: lerp3(ul, ll, 0.15), b: ll, r: unit * 0.1, ...pelvisInfo });
      if (P('LowerLeg')) out.push(ell('legs', P('LowerLeg')));
      else if (ll && foot) out.push({ zone: 'legs', kind: 'capsule', a: ll, b: lerp3(ll, foot, 0.85), r: unit * 0.075 });
      if (P('Foot')) out.push(ell('feet', P('Foot')));
      else if (foot) out.push({ zone: 'feet', kind: 'capsule', a: foot, b: toes ? add(toes, mul(sub(toes, foot), 0.5)) : add(foot, mul(front, unit * 0.12)), r: unit * 0.07 });
    }
    return out;
  }

  // the pelvis by side: behind her (the hit point behind the box's centre, along her front) her butt, in front her
  // belly; below the hip joints (by 0.3 × the thigh) her legs either way. The thigh: legs, except its top (above
  // that line) behind her hip joints — the buttocks
  function pelvisZone(s, point) {
    const front = s.front || [0, 0, 1];
    const up = s.up || [0, 1, 0];
    const below = s.joints && dot(sub(point, s.joints), up) < -(s.drop || 0);
    if (s.zone === 'thigh') return !below && s.joints && dot(sub(point, s.joints), front) < 0 ? 'butt' : 'legs';
    if (below) return 'legs';
    const c = s.c || lerp3(s.a, s.b, 0.5);
    return dot(sub(point, c), front) < 0 ? 'butt' : 'belly';
  }

  // The zone the ray (origin, unit dir) hits first, or { zone: null } when it misses her (or hits an upper arm).
  // → { zone, t, point, shape }
  function hit(list, origin, dir) {
    const d = norm(dir);
    const hits = [];
    for (const s of list) {
      const t = s.kind === 'sphere' ? raySphere(origin, d, s.c, s.r) : s.kind === 'ellipsoid' ? rayEllipsoid(origin, d, s.c, s.axes, s.radii) : rayCapsule(origin, d, s.a, s.b, s.r);
      if (t !== null) hits.push({ t, s });
    }
    if (!hits.length) return { zone: null, t: null, point: null, shape: null };
    hits.sort((a, b) => a.t - b.t);
    const thick = (h) => Math.min(...(h.s.radii || [h.s.r]));
    let best = hits[0];
    // T-5098: the boxes overlap at the skin. An arm (no zone: a sleeve's box) is only in the way where nothing is
    // right behind it: its own hand coming out of it (within the hand's thickness × 2) is the hand, a body part within
    // the arm's own thickness is that part (a hanging forearm's box grazing her butt or thigh)
    if (best.s.zone === null) {
      const next = hits.find((h) => h.s.zone !== null);
      if (next && next.s.zone === 'hands' && next.t - best.t < 2 * thick(next)) best = next;
      else if (next && next.s.zone !== 'hands' && next.t - best.t < thick(best)) best = next;
    }
    // a hand resting on her thigh or belly lies inside the bigger box's skin: when the ray reaches the hand within
    // the hand's own thickness of the first hit, it is the hand
    const hand = hits.find((h) => h.s.zone === 'hands');
    if (best.s.zone !== null && best.s.zone !== 'hands' && hand && hand.t - best.t < thick(hand)) best = hand;
    const point = add(origin, mul(d, best.t));
    let zone = best.s.zone;
    if (zone === 'pelvis' || zone === 'thigh') zone = pelvisZone(best.s, point);
    if (zone === 'head') {
      // the face: the front of the head sphere, from the brows down to the chin, not too far to the sides
      // (an ellipsoid: each direction measured against how far it reaches that way)
      const s0 = best.s;
      const reach = (u) => (s0.kind === 'ellipsoid' ? support(s0.axes, s0.radii, u) : s0.r);
      const rel = sub(point, s0.c);
      const f = dot(rel, s0.front) / reach(s0.front);
      const v = dot(rel, s0.up) / reach(s0.up);
      const lat = sub(rel, add(mul(s0.front, dot(rel, s0.front)), mul(s0.up, dot(rel, s0.up))));
      const side = len(lat) / (len(lat) > 1e-9 ? reach(norm(lat)) : s0.r);
      if (f > 0.35 && v < 0.05 && v > -1 && side < 0.6) zone = 'face';
    }
    return { zone, t: best.t, point, shape: best.s };
  }

  return { BONES, PART_BONES, PART_ZONE, raySphere, rayCapsule, rayEllipsoid, support, shapes, hit, pelvisZone };
});
