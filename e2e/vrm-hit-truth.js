'use strict';

// T-5098: where each body part of the VRM she wears is actually visible, independent of the touch zones
// (core/vrm-hit.js). Runs in the pet window (page.evaluate(visibleParts, opts)): every skinned triangle as drawn
// this frame (skinning and morphs applied: three's getVertexPosition) is rasterised with a depth test into a label
// buffer at `cell` px — the label is the body part of the bone its vertices are mostly skinned to:
//   head bone, eyes, jaw, and anything hanging from the head (hair, a hat) → head; of those, vertices an expression
//   morph moves (eyes, brows, mouth) → face; chest / upperChest → chest; spine → belly; hips → pelvis, split by the
//   triangle's normal: facing her back → butt, else pelvis-front; shoulders and arms → arm; hand and fingers →
//   hands; upper / lower legs → legs; feet and toes → feet; spring bones elsewhere (a skirt, wings, a cape) → acc.
// A second buffer keeps the body alone — no `acc`, no hair hanging below the neck — so a part under her clothes or
// hair (the butt under a coat, a skirt or long hair: what a user clicks on to touch it) is found through them; the
// butt's centre is taken there, where only clothes or hair (not an arm or a hand) cover it. Most models skin the
// buttocks to the upper legs as much as to the hips, so the butt is where it is, not by bone: the body surface
// (hips, the upper legs, the lower trunk) that faces her back, from 0.3 × her thigh below the hip joints up to
// the spine bone, within 1.7 × the hip joints' half-span of her middle.
// For each part the visible centre is its deepest pixel (a chamfer distance transform: the point farthest from the
// part's visible edge), head and face only above the neck (long hair hanging at her waist is not where a pat goes).
// → { cell, size: [w, h], centres: { part: { x, y, depth (px to the edge), px (pixels of it) } }, counts, ms }
function visibleParts(opts) {
  const o = opts || {};
  const cell = o.cell || 2;
  const H = window.PetVRM.director.handles();
  if (!H) return { error: 'no vrm' };
  const { vrm, camera, canvas, THREE: T } = H;
  const t0 = performance.now();
  vrm.scene.updateMatrixWorld(true);
  const rect = canvas.getBoundingClientRect();
  const W = Math.ceil(rect.width / cell);
  const Hh = Math.ceil(rect.height / cell);
  const hum = vrm.humanoid;
  const raw = (n) => hum.getRawBoneNode(n);
  const PART = {};
  const put = (names, label) => { for (const n of names) { const b = raw(n); if (b) PART[b.uuid] = label; } };
  put(['head', 'leftEye', 'rightEye', 'jaw'], 'head');
  put(['neck'], 'neck');
  put(['chest', 'upperChest'], 'chest');
  put(['spine'], 'belly');
  put(['hips'], 'pelvis');
  put(['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'], 'arm');
  const fingers = [];
  for (const s of ['left', 'right']) for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) for (const k of ['Metacarpal', 'Proximal', 'Intermediate', 'Distal']) fingers.push(`${s}${f}${k}`);
  put(['leftHand', 'rightHand', ...fingers], 'hands');
  put(['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'], 'legs');
  put(['leftFoot', 'rightFoot', 'leftToes', 'rightToes'], 'feet');
  const humanoid = new Set(Object.keys(PART));
  for (const n of Object.keys(hum.humanBones || {})) { const b = raw(n); if (b) humanoid.add(b.uuid); }
  const spring = new Set();
  if (vrm.springBoneManager && vrm.springBoneManager.joints) for (const j of vrm.springBoneManager.joints) if (j.bone) spring.add(j.bone.uuid);
  const headNode = raw('head');
  const labelOf = (b) => {
    let viaSpring = false;
    for (let p = b; p; p = p.parent) {
      if (spring.has(p.uuid)) viaSpring = true;
      if (humanoid.has(p.uuid)) {
        const l = PART[p.uuid] || null;
        if (l === 'head') return 'head';
        if (viaSpring) return 'acc';
        return l || 'other';
      }
    }
    return 'other';
  };
  const W3 = (n) => { const b = raw(n); return b ? b.getWorldPosition(new T.Vector3()) : null; };
  const la = W3('leftUpperArm'); const ra = W3('rightUpperArm'); const hd = W3('head'); const nk = W3('neck') || hd;
  const up = hd && nk ? hd.clone().sub(nk).normalize() : new T.Vector3(0, 1, 0);
  const front = new T.Vector3().crossVectors(la.clone().sub(ra), up).normalize();
  const toPx = (v) => { const p = v.clone().project(camera); return [((p.x + 1) / 2) * rect.width / cell, ((1 - p.y) / 2) * rect.height / cell, p.z]; };
  const neckY = toPx(nk)[1];
  const NAMES = ['none', 'head', 'face', 'neck', 'chest', 'belly', 'pelvis-front', 'butt', 'arm', 'hands', 'legs', 'feet', 'acc', 'other'];
  const ID = Object.fromEntries(NAMES.map((n, i) => [n, i]));
  const depth = new Float32Array(W * Hh).fill(Infinity);
  const lab = new Uint8Array(W * Hh);
  const depthB = new Float32Array(W * Hh).fill(Infinity);
  const labB = new Uint8Array(W * Hh);
  const posB = new Float32Array(W * Hh * 3); // the body surface's world position per pixel
  const posV = new Float32Array(W * Hh * 3); // and the visible surface's
  const facV = new Int8Array(W * Hh);
  const facB = new Int8Array(W * Hh); // and which way it faces: −1 her back, 1 her front
  const neckW = nk.y;
  const lu = W3('leftUpperLeg'); const ru = W3('rightUpperLeg'); const ll = W3('leftLowerLeg'); const sp = W3('spine') || W3('hips');
  const jw = lu.clone().add(ru).multiplyScalar(0.5);
  const halfSpan = lu.distanceTo(ru) / 2;
  const crotchY = jw.y - 0.3 * (ll ? lu.distanceTo(ll) : halfSpan * 4);
  const lateral = new T.Vector3().crossVectors(up, front).normalize();
  // within this of her middle: 1.7 × the hip joints' half-span, at least 0.35 × the thigh (Wanderer's MMD hip joints
  // are 10 cm apart, her buttocks wider)
  const latMax = Math.max(1.7 * halfSpan, 0.35 * (ll ? lu.distanceTo(ll) : halfSpan * 4));
  const v = new T.Vector3();
  const e1 = new T.Vector3(); const e2 = new T.Vector3(); const nrm = new T.Vector3();
  let tris = 0;
  vrm.scene.traverse((m) => {
    if (!m.isMesh || !m.visible || !m.geometry || !m.geometry.attributes.position) return;
    for (let p = m.parent; p; p = p.parent) if (p.visible === false) return;
    const g = m.geometry;
    const pos = g.attributes.position;
    const n = pos.count;
    const sx = new Float32Array(n); const sy = new Float32Array(n); const sz = new Float32Array(n);
    const wx = new Float32Array(n * 3);
    const vl = new Uint8Array(n);
    const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight;
    const bones = m.isSkinnedMesh && m.skeleton ? m.skeleton.bones.map(labelOf) : null;
    const morph = g.morphAttributes && g.morphAttributes.position ? g.morphAttributes.position : [];
    for (let i = 0; i < n; i++) {
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
      wx[i * 3] = v.x; wx[i * 3 + 1] = v.y; wx[i * 3 + 2] = v.z;
      const p = toPx(v); sx[i] = p[0]; sy[i] = p[1]; sz[i] = p[2];
      let l = 'other';
      if (bones && si && sw) {
        let best = 0; let bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
        l = bones[best] || 'other';
      } else { for (let p2 = m.parent; p2; p2 = p2.parent) if (p2 === headNode) { l = 'head'; break; } }
      if (l === 'head' && morph.length) {
        for (const ma of morph) { if (Math.abs(ma.getX(i)) + Math.abs(ma.getY(i)) + Math.abs(ma.getZ(i)) > 1e-5) { l = 'face'; break; } }
      }
      vl[i] = ID[l] || ID.other;
    }
    const idx = g.index ? g.index.array : null;
    const nt = idx ? idx.length / 3 : n / 3;
    for (let t = 0; t < nt; t++) {
      const a = idx ? idx[t * 3] : t * 3; const b = idx ? idx[t * 3 + 1] : t * 3 + 1; const c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      if (sz[a] > 1 || sz[b] > 1 || sz[c] > 1 || sz[a] < -1) continue;
      // the label: two vertices agreeing, else the first
      let L = vl[a];
      if (vl[b] === vl[c]) L = vl[b];
      if (L === ID.face && !(vl[a] === ID.face || vl[b] === ID.face)) L = ID.head;
      if (L === ID.pelvis) {
        e1.set(wx[b * 3] - wx[a * 3], wx[b * 3 + 1] - wx[a * 3 + 1], wx[b * 3 + 2] - wx[a * 3 + 2]);
        e2.set(wx[c * 3] - wx[a * 3], wx[c * 3 + 1] - wx[a * 3 + 1], wx[c * 3 + 2] - wx[a * 3 + 2]);
        nrm.crossVectors(e1, e2);
        // which way it faces: away from the pelvis's own centre (a mesh's winding is not to be trusted)
        const cx = (wx[a * 3] + wx[b * 3] + wx[c * 3]) / 3; const cz = (wx[a * 3 + 2] + wx[b * 3 + 2] + wx[c * 3 + 2]) / 3;
        const hp = W3('hips');
        const outward = (cx - hp.x) * front.x + (cz - hp.z) * front.z;
        L = outward < 0 ? ID.butt : ID['pelvis-front'];
      }
      const tcx = (wx[a * 3] + wx[b * 3] + wx[c * 3]) / 3; const tcz = (wx[a * 3 + 2] + wx[b * 3 + 2] + wx[c * 3 + 2]) / 3;
      const tf = (tcx - jw.x) * front.x + (tcz - jw.z) * front.z < 0 ? -1 : 1;
      const cover = L === ID.acc || L === ID.other || (L === ID.head && wx[a * 3 + 1] < neckW && wx[b * 3 + 1] < neckW && wx[c * 3 + 1] < neckW);
      const x0 = Math.max(0, Math.floor(Math.min(sx[a], sx[b], sx[c]))); const x1 = Math.min(W - 1, Math.ceil(Math.max(sx[a], sx[b], sx[c])));
      const y0 = Math.max(0, Math.floor(Math.min(sy[a], sy[b], sy[c]))); const y1 = Math.min(Hh - 1, Math.ceil(Math.max(sy[a], sy[b], sy[c])));
      if (x1 < x0 || y1 < y0) continue;
      const den = (sy[b] - sy[c]) * (sx[a] - sx[c]) + (sx[c] - sx[b]) * (sy[a] - sy[c]);
      if (Math.abs(den) < 1e-9) continue;
      tris++;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5; const py = y + 0.5;
          const w0 = ((sy[b] - sy[c]) * (px - sx[c]) + (sx[c] - sx[b]) * (py - sy[c])) / den;
          const w1 = ((sy[c] - sy[a]) * (px - sx[c]) + (sx[a] - sx[c]) * (py - sy[c])) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * sz[a] + w1 * sz[b] + w2 * sz[c];
          const k = y * W + x;
          if (z < depth[k]) {
            depth[k] = z; lab[k] = L;
            posV[k * 3] = w0 * wx[a * 3] + w1 * wx[b * 3] + w2 * wx[c * 3]; posV[k * 3 + 1] = w0 * wx[a * 3 + 1] + w1 * wx[b * 3 + 1] + w2 * wx[c * 3 + 1]; posV[k * 3 + 2] = w0 * wx[a * 3 + 2] + w1 * wx[b * 3 + 2] + w2 * wx[c * 3 + 2];
            facV[k] = tf;
          }
          if (!cover && z < depthB[k]) {
            depthB[k] = z; labB[k] = L;
            posB[k * 3] = w0 * wx[a * 3] + w1 * wx[b * 3] + w2 * wx[c * 3]; posB[k * 3 + 1] = w0 * wx[a * 3 + 1] + w1 * wx[b * 3 + 1] + w2 * wx[c * 3 + 1]; posB[k * 3 + 2] = w0 * wx[a * 3 + 2] + w1 * wx[b * 3 + 2] + w2 * wx[c * 3 + 2];
            facB[k] = tf;
          }
        }
      }
    }
  });
  const counts = {};
  for (let k = 0; k < lab.length; k++) if (lab[k]) counts[NAMES[lab[k]]] = (counts[NAMES[lab[k]]] || 0) + 1;
  // the deepest pixel of a part (chamfer 3-4 distance to the nearest pixel that is not it)
  function deepest(test) {
    const D = new Float32Array(W * Hh);
    for (let k = 0; k < D.length; k++) D[k] = test(k) ? 1e9 : 0;
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= Hh ? 0 : D[y * W + x]);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) { const k = y * W + x; if (!D[k]) continue; D[k] = Math.min(D[k], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4); }
    for (let y = Hh - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) { const k = y * W + x; if (!D[k]) continue; D[k] = Math.min(D[k], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4); }
    let best = -1; let bk = -1; let n = 0;
    for (let k = 0; k < D.length; k++) { if (D[k] > 0) n++; if (D[k] > best) { best = D[k]; bk = k; } }
    if (best <= 0) return null;
    const x = bk % W; const y = Math.floor(bk / W);
    return { x: +(rect.left + (x + 0.5) * cell).toFixed(1), y: +(rect.top + (y + 0.5) * cell).toFixed(1), depth: +((best / 3) * cell).toFixed(1), px: n };
  }
  const centres = {};
  const want = o.parts || ['head', 'face', 'hands', 'belly', 'legs', 'butt'];
  for (const p of want) {
    const id = ID[p];
    const aboveNeck = p === 'head' || p === 'face';
    if (p === 'butt') {
      const body = new Set([ID.butt, ID['pelvis-front'], ID.legs, ID.belly]);
      const through = new Set([ID.butt, ID['pelvis-front'], ID.legs, ID.belly, ID.acc, ID.other, ID.head]);
      const isButt = (k) => {
        if (!body.has(labB[k]) || facB[k] !== -1 || !through.has(lab[k])) return false;
        const y = posB[k * 3 + 1];
        if (y < crotchY || y > sp.y) return false;
        const dx = (posB[k * 3] - jw.x) * lateral.x + (posB[k * 3 + 2] - jw.z) * lateral.z;
        return Math.abs(dx) < latMax;
      };
      centres[p] = deepest(isButt);
      // a model whose whole lower trunk is cloth on spring bones (Wanderer's coat and shorts): no body skin there at
      // all — the butt is then what is drawn over it: the same band, side and width on the visible surface
      if (!centres[p]) {
        const over = new Set([ID.acc, ID.other, ID.legs, ID.belly, ID.butt, ID['pelvis-front']]);
        centres[p] = deepest((k) => {
          if (!over.has(lab[k]) || facV[k] !== -1) return false;
          const y = posV[k * 3 + 1];
          if (y < crotchY || y > sp.y) return false;
          const dx = (posV[k * 3] - jw.x) * lateral.x + (posV[k * 3 + 2] - jw.z) * lateral.z;
          return Math.abs(dx) < latMax;
        });
        if (centres[p]) centres[p].via = 'cloth (no body skin under it)';
      }
      if (!centres[p]) {
        // why not: how many body pixels pass each test in turn
        const why = { body: 0, back: 0, band: 0, lateral: 0, through: 0 };
        for (let k = 0; k < labB.length; k++) {
          if (!body.has(labB[k])) continue; why.body++;
          if (facB[k] !== -1) continue; why.back++;
          const y = posB[k * 3 + 1]; if (y < crotchY || y > sp.y) continue; why.band++;
          const dx = (posB[k * 3] - jw.x) * lateral.x + (posB[k * 3 + 2] - jw.z) * lateral.z; if (Math.abs(dx) >= latMax) continue; why.lateral++;
          if (through.has(lab[k])) why.through++;
        }
        centres.buttWhy = why;
      }
      if (centres[p]) { const k = Math.floor((centres[p].y - rect.top) / cell) * W + Math.floor((centres[p].x - rect.left) / cell); centres[p].cover = NAMES[lab[k]]; }
    } else centres[p] = deepest((k) => lab[k] === id && (!aboveNeck || Math.floor(k / W) < neckY));
  }
  const countsB = {};
  for (let k = 0; k < labB.length; k++) if (labB[k]) countsB[`${NAMES[labB[k]]}${facB[k] < 0 ? '-back' : ''}`] = (countsB[`${NAMES[labB[k]]}${facB[k] < 0 ? '-back' : ''}`] || 0) + 1;
  return { cell, size: [W, Hh], centres, counts, countsB, band: { crotchY: +crotchY.toFixed(3), waistY: +sp.y.toFixed(3), joints: jw.toArray().map((x) => +x.toFixed(3)) }, tris, ms: Math.round(performance.now() - t0), labelAt: o.labelAt ? o.labelAt.map(([x, y]) => NAMES[lab[Math.floor((y - rect.top) / cell) * W + Math.floor((x - rect.left) / cell)]] || 'none') : undefined };
}

module.exports = { visibleParts };
