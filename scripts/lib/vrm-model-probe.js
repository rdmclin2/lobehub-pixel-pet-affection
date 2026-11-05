'use strict';
// Reads the models pack (~/vrm-assets/models/**.vrm) for the bake (T-5081): per model its VRM version, the humanoid
// bones it has, its degrade level and whether its hips sit on the floor — the same rules the renderer applies when it
// loads the library (src/core/vrm-bone-map.js degradeLevel / foldMissing / rootHips / allowsClip) — so library.json
// says which clips every model in the pack can play. Only the glTF JSON chunk is read; nothing of a model is written.
const fs = require('node:fs');
const path = require('node:path');
const BM = require('../../src/core/vrm-bone-map');

// the JSON chunk of a .glb / .vrm
function glbJson(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glTF binary');
  const len = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
  return JSON.parse(buf.slice(20, 20 + len).toString('utf8'));
}

// column-major 4×4 helpers (glTF convention)
function trs(n) {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix.slice();
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

// world-space rest position of every node
function worldPositions(gltf) {
  const nodes = gltf.nodes || [];
  const parent = new Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
  const world = new Array(nodes.length);
  const get = (i) => world[i] || (world[i] = parent[i] < 0 ? trs(nodes[i]) : mul(get(parent[i]), trs(nodes[i])));
  return (i) => { const m = get(i); return [m[12], m[13], m[14]]; };
}

// { version: '0.x' | '1.0', bones: { vrmBone: nodeIndex } } in VRM 1.0 bone names (0.x thumbs renamed)
function humanoidOf(gltf) {
  const ext = gltf.extensions || {};
  if (ext.VRMC_vrm && ext.VRMC_vrm.humanoid) {
    const bones = {};
    for (const [b, v] of Object.entries(ext.VRMC_vrm.humanoid.humanBones || {})) if (v && Number.isInteger(v.node)) bones[b] = v.node;
    return { version: '1.0', bones, meta: ext.VRMC_vrm.meta || {} };
  }
  if (ext.VRM && ext.VRM.humanoid) {
    const bones = {};
    for (const hb of ext.VRM.humanoid.humanBones || []) if (hb && hb.bone && Number.isInteger(hb.node) && hb.node >= 0) bones[BM.VRM0_THUMB[hb.bone] || hb.bone] = hb.node;
    return { version: '0.x', bones, meta: ext.VRM.meta || {} };
  }
  return null;
}

// one model → its probe (or { error })
function probeModel(buf) {
  const gltf = glbJson(buf);
  const h = humanoidOf(gltf);
  if (!h) return { error: 'no VRM humanoid extension' };
  const has = new Set(Object.keys(h.bones));
  const pos = worldPositions(gltf);
  const hipsY = has.has('hips') ? pos(h.bones.hips)[1] : 0;
  const headY = has.has('head') ? pos(h.bones.head)[1] : 1;
  // 0.x models face -Z and three-vrm turns them (rotateVRM0); a height is the same either way
  const missing = BM.VRM_BONES.filter((b) => !has.has(b));
  const missingTrunk = missing.filter((b) => ['chest', 'upperChest', 'neck', 'leftShoulder', 'rightShoulder'].includes(b));
  const missingFingers = missing.filter((b) => /Thumb|Index|Middle|Ring|Little/.test(b));
  return {
    vrm: h.version,
    title: String(h.meta.title || h.meta.name || '').slice(0, 40) || undefined,
    bones: has.size,
    level: BM.degradeLevel(has),
    missingTrunk,
    missingFingers: missingFingers.length,
    missingRequired: BM.VRM_REQUIRED.filter((b) => !has.has(b)),
    hipsY: +hipsY.toFixed(3),
    headY: +headY.toFixed(3),
    rootHips: BM.rootHips(hipsY, headY),
    // T-5098: a hips-on-floor model is retargeted on her leg chain (core/vrm-bone-map.js legRig)
    legRig: BM.rootHips(hipsY, headY) ? BM.legRig(Object.fromEntries(['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'].filter((b) => has.has(b)).map((b) => [b, pos(h.bones[b])])), 0) : undefined,
  };
}

function listModels(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.vrm$/i.test(e.name)) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

// the models pack against the baked clips: { dir, probed, summary, models: { relPath: probe + playable per style } }
function probeModels(modelsDir, clips) {
  const files = listModels(modelsDir);
  const res = { dir: 'models', probed: files.length, summary: { full: 0, 'no-fingers': 0, folded: 0, unusable: 0, rootHips: 0, error: 0 }, models: {} };
  const styles = ['female', 'male', 'neutral'];
  for (const f of files) {
    const rel = path.relative(modelsDir, f).split(path.sep).join('/');
    let p;
    try { p = probeModel(fs.readFileSync(f)); } catch (err) { p = { error: err.message }; }
    if (p.error) { res.summary.error++; res.models[rel] = p; continue; }
    res.summary[p.level]++;
    if (p.rootHips) res.summary.rootHips++;
    if (p.level !== 'unusable') {
      p.playable = {};
      for (const s of styles) p.playable[s] = Object.values(clips).filter((c) => c.style === s && BM.allowsClip(c, { rootHips: p.rootHips, legRig: p.legRig })).length;
    }
    res.models[rel] = p;
  }
  return res;
}

module.exports = { glbJson, humanoidOf, worldPositions, probeModel, probeModels, listModels };
