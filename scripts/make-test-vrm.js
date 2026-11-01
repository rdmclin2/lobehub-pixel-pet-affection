#!/usr/bin/env node
'use strict';

// A small homemade VRM 1.0 model for tests and manual runs: a chibi blue fish-girl made of boxes, with the
// full humanoid skeleton (T-pose), all 18 preset expressions as morph targets (blink, happy, aa…oh, lookX…),
// expression-type look-at, and two SpringBone chains (a tail and an ahoge). No third-party content: every
// vertex is made here, and it is licensed CC0 in its own meta. Written outside the repository by default
// (no .vrm is ever committed: test/vrm.test.js checks).
//
//   node scripts/make-test-vrm.js [out.vrm]        (default: <tmp>/pixelpet-test-fish.vrm)
//   const { makeTestVrm } = require('./scripts/make-test-vrm');  → Buffer  ({ name, omit: ['surprised', …], meta: { allowRedistribution: false, … }, texture: false })

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------- boxes ----------
const FACES = [
  { n: [1, 0, 0], c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { n: [0, 0, 1], c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];
// A mesh from boxes { name, c: centre, s: size }; morph targets are functions (box, vertex) → delta.
function boxesMesh(boxes, morphs = {}) {
  const pos = [];
  const nor = [];
  const idx = [];
  const owner = [];
  for (const b of boxes) {
    for (const f of FACES) {
      const base = pos.length / 3;
      for (const c of f.c) {
        pos.push(b.c[0] + (c[0] * b.s[0]) / 2, b.c[1] + (c[1] * b.s[1]) / 2, b.c[2] + (c[2] * b.s[2]) / 2);
        nor.push(...f.n);
        owner.push(b);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const targets = Object.entries(morphs).map(([name, fn]) => {
    const d = [];
    for (let i = 0; i < owner.length; i++) d.push(...(fn(owner[i], [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]) || [0, 0, 0]));
    return { name, d };
  });
  return { pos, nor, idx, targets };
}

// ---------- an embedded texture ----------
// A tiny solid PNG (node:zlib, no dependencies). Real models carry their textures as images in the GLB's buffer;
// GLTFLoader loads those through blob: URLs, which the renderer page's CSP has to allow (T-2654: a real model
// drew untextured, white, while the texture-less test model looked fine).
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgba)))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', require('node:zlib').deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ---------- the glTF ----------
function makeTestVrm({ name = 'Pixel Pet test fish (homemade)', omit = [], meta = {}, texture = true } = {}) {
  const json = { asset: { version: '2.0', generator: 'pixel-pet scripts/make-test-vrm.js' }, extensionsUsed: ['VRMC_vrm', 'VRMC_springBone'], scene: 0, scenes: [{ nodes: [0] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [] };
  const chunks = [];
  let offset = 0;
  function view(buf, target) {
    const pad = (4 - (offset % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) });
    chunks.push(buf);
    offset += buf.length;
    return json.bufferViews.length - 1;
  }
  function accessor(arr, type, comp) {
    const isIdx = comp === 5125;
    const buf = isIdx ? Buffer.from(new Uint32Array(arr).buffer) : Buffer.from(new Float32Array(arr).buffer);
    const n = type === 'VEC3' ? 3 : 1;
    const a = { bufferView: view(buf, isIdx ? 34963 : 34962), componentType: comp, count: arr.length / n, type };
    if (type === 'VEC3') {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], arr[i + k]); max[k] = Math.max(max[k], arr[i + k]); }
      a.min = min;
      a.max = max;
    }
    json.accessors.push(a);
    return json.accessors.length - 1;
  }
  function material(rgb, nm) {
    json.materials.push({ name: nm, pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: 0.9 }, extensions: { KHR_materials_unlit: {} } });
    return json.materials.length - 1;
  }
  json.extensionsUsed.push('KHR_materials_unlit');
  function mesh(nm, m, mat) {
    const prim = { attributes: { POSITION: accessor(m.pos, 'VEC3', 5126), NORMAL: accessor(m.nor, 'VEC3', 5126) }, indices: accessor(m.idx, 'SCALAR', 5125), material: mat };
    if (m.targets.length) prim.targets = m.targets.map((t) => ({ POSITION: accessor(t.d, 'VEC3', 5126) }));
    json.meshes.push({ name: nm, primitives: [prim], ...(m.targets.length ? { weights: m.targets.map(() => 0), extras: { targetNames: m.targets.map((t) => t.name) } } : {}) });
    return json.meshes.length - 1;
  }
  const nodes = {};
  function node(nm, parent, t, extra = {}) {
    json.nodes.push({ name: nm, translation: t, ...extra });
    const i = json.nodes.length - 1;
    nodes[nm] = i;
    if (parent != null) {
      const p = json.nodes[nodes[parent]];
      (p.children = p.children || []).push(i);
    }
    return i;
  }

  const BLUE = [0.27, 0.48, 0.86];
  const LIGHT = [0.85, 0.92, 1];
  const DARK = [0.08, 0.1, 0.2];
  const PINK = [0.9, 0.35, 0.45];
  const mBlue = material(BLUE, 'body');
  const mLight = material(LIGHT, 'belly');
  if (texture) {
    // a white texture on the belly (white × its colour = the same look), embedded like a real model's
    json.images = [{ name: 'belly', mimeType: 'image/png', bufferView: view(solidPng(4, 4, [255, 255, 255, 255])) }];
    json.samplers = [{ magFilter: 9729, minFilter: 9729 }];
    json.textures = [{ source: 0, sampler: 0 }];
    json.materials[mLight].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  }
  const mDark = material(DARK, 'eyes');
  const mPink = material(PINK, 'mouth');

  // skeleton (metres; T-pose, no rotations; she faces +Z, her left is +X)
  node('root', null, [0, 0, 0]);
  node('hips', 'root', [0, 0.45, 0]);
  node('spine', 'hips', [0, 0.08, 0]);
  node('chest', 'spine', [0, 0.1, 0]);
  node('neck', 'chest', [0, 0.12, 0]);
  node('head', 'neck', [0, 0.05, 0]);
  for (const [side, sx] of [['left', 1], ['right', -1]]) {
    node(`${side}UpperArm`, 'chest', [0.11 * sx, 0.07, 0]);
    node(`${side}LowerArm`, `${side}UpperArm`, [0.13 * sx, 0, 0]);
    node(`${side}Hand`, `${side}LowerArm`, [0.12 * sx, 0, 0]);
    node(`${side}UpperLeg`, 'hips', [0.07 * sx, -0.03, 0]);
    node(`${side}LowerLeg`, `${side}UpperLeg`, [0, -0.19, 0]);
    node(`${side}Foot`, `${side}LowerLeg`, [0, -0.19, 0]);
  }
  node('tail1', 'hips', [0, 0.02, -0.11]);
  node('tail2', 'tail1', [0, -0.02, -0.08]);
  node('tail3', 'tail2', [0, -0.02, -0.08]);
  node('tail4', 'tail3', [0, -0.02, -0.06]);
  node('hair1', 'head', [0, 0.28, 0]);
  node('hair2', 'hair1', [0, 0.06, 0.01]);
  node('hair3', 'hair2', [0, 0.06, 0.02]);
  node('hair4', 'hair3', [0, 0.04, 0.03]);

  // body parts, each a mesh on its bone (no skinning)
  const put = (bone, nm, m, mat) => node(`${nm}_mesh`, bone, [0, 0, 0], { mesh: mesh(nm, m, mat) });
  put('hips', 'pelvis', boxesMesh([{ c: [0, 0.02, 0], s: [0.22, 0.12, 0.17] }]), mBlue);
  put('spine', 'belly', boxesMesh([{ c: [0, 0.05, 0.005], s: [0.2, 0.12, 0.16] }, { c: [0, 0.04, 0.085], s: [0.14, 0.1, 0.01] }]), mLight);
  put('chest', 'torso', boxesMesh([{ c: [0, 0.06, 0], s: [0.21, 0.13, 0.15] }]), mBlue);
  put('head', 'skull', boxesMesh([{ c: [0, 0.13, 0], s: [0.32, 0.28, 0.27] }, { c: [0, 0.29, -0.02], s: [0.12, 0.05, 0.12] }]), mBlue);
  put('head', 'faceplate', boxesMesh([{ c: [0, 0.09, 0.136], s: [0.24, 0.14, 0.004] }]), mLight);
  for (const [side, sx] of [['left', 1], ['right', -1]]) {
    put(`${side}UpperArm`, `${side}_upperarm`, boxesMesh([{ c: [0.065 * sx, 0, 0], s: [0.13, 0.06, 0.06] }]), mBlue);
    put(`${side}LowerArm`, `${side}_forearm`, boxesMesh([{ c: [0.06 * sx, 0, 0], s: [0.12, 0.05, 0.05] }]), mBlue);
    put(`${side}Hand`, `${side}_hand`, boxesMesh([{ c: [0.03 * sx, 0, 0], s: [0.06, 0.06, 0.04] }]), mLight);
    put(`${side}UpperLeg`, `${side}_thigh`, boxesMesh([{ c: [0, -0.095, 0], s: [0.08, 0.19, 0.08] }]), mBlue);
    put(`${side}LowerLeg`, `${side}_shin`, boxesMesh([{ c: [0, -0.095, 0], s: [0.07, 0.19, 0.07] }]), mBlue);
    put(`${side}Foot`, `${side}_foot`, boxesMesh([{ c: [0, -0.01, 0.03], s: [0.08, 0.04, 0.12] }]), mLight);
  }
  put('tail2', 'tail_a', boxesMesh([{ c: [0, -0.01, -0.04], s: [0.08, 0.07, 0.08] }]), mBlue);
  put('tail3', 'tail_b', boxesMesh([{ c: [0, -0.01, -0.04], s: [0.06, 0.05, 0.08] }]), mBlue);
  put('tail4', 'tail_fin', boxesMesh([{ c: [0, 0.02, -0.04], s: [0.16, 0.12, 0.02] }]), mLight);
  put('hair2', 'ahoge_a', boxesMesh([{ c: [0, 0.03, 0], s: [0.025, 0.06, 0.025] }]), mBlue);
  put('hair3', 'ahoge_b', boxesMesh([{ c: [0, 0.03, 0.01], s: [0.02, 0.06, 0.02] }]), mBlue);

  // the eyes: two boxes on the face, with morph targets for blinking, emotions and looking about
  const EY = 0.115;
  const eyes = [{ side: 'L', c: [0.065, EY, 0.142], s: [0.045, 0.06, 0.008] }, { side: 'R', c: [-0.065, EY, 0.142], s: [0.045, 0.06, 0.008] }];
  const shut = (b, v, k = 0.92) => [0, (b.c[1] - v[1]) * k, 0];
  const eyeMorphs = {
    blink: (b, v) => shut(b, v),
    blinkLeft: (b, v) => (b.side === 'L' ? shut(b, v) : null),
    blinkRight: (b, v) => (b.side === 'R' ? shut(b, v) : null),
    happy: (b, v) => [0, v[1] < b.c[1] ? (b.c[1] - v[1]) * 0.85 + 0.008 : -0.012, 0], // ^ ^ arcs
    angry: (b, v) => [0, v[1] > b.c[1] ? (v[0] * (b.side === 'L' ? -1 : 1) > b.c[0] * (b.side === 'L' ? -1 : 1) ? -0.022 : -0.004) : 0, 0],
    sad: (b, v) => [0, v[1] > b.c[1] ? (Math.abs(v[0]) > Math.abs(b.c[0]) ? -0.022 : -0.004) : 0, 0],
    surprised: (b, v) => [(v[0] - b.c[0]) * 0.35, (v[1] - b.c[1]) * 0.45, 0],
    lookUp: () => [0, 0.012, 0],
    lookDown: () => [0, -0.012, 0],
    lookLeft: () => [0.014, 0, 0],
    lookRight: () => [-0.014, 0, 0],
  };
  const eyeMesh = boxesMesh(eyes, eyeMorphs);
  const eyeNode = put('head', 'eyes', eyeMesh, mDark);
  // the mouth: one box, shaped by the vowels
  const MY = 0.045;
  const mouthBox = [{ c: [0, MY, 0.141], s: [0.05, 0.012, 0.008] }];
  const shape = (wx, hy) => (b, v) => [(v[0] - b.c[0]) * wx, (v[1] - b.c[1]) * hy, 0];
  const mouthMorphs = {
    aa: shape(0.4, 4.5),
    ih: shape(0.5, 1.2),
    ou: shape(-0.45, 2.2),
    ee: shape(0.9, 0.8),
    oh: shape(-0.15, 3.5),
    happy: (b, v) => [(v[0] - b.c[0]) * 0.5, Math.abs(v[0] - b.c[0]) > 0.01 ? 0.008 : -0.002, 0],
    sad: (b, v) => [(v[0] - b.c[0]) * 0.2, Math.abs(v[0] - b.c[0]) > 0.01 ? -0.008 : 0.002, 0],
    surprised: shape(-0.3, 3),
  };
  const mouthMesh = boxesMesh(mouthBox, mouthMorphs);
  const mouthNode = put('head', 'mouth', mouthMesh, mPink);
  const eyeT = (n) => eyeMesh.targets.findIndex((t) => t.name === n);
  const mouthT = (n) => mouthMesh.targets.findIndex((t) => t.name === n);
  const binds = (list) => list.map(([nd, i, w]) => ({ node: nd, index: i, weight: w }));
  const preset = {
    blink: { morphTargetBinds: binds([[eyeNode, eyeT('blink'), 1]]), isBinary: false },
    blinkLeft: { morphTargetBinds: binds([[eyeNode, eyeT('blinkLeft'), 1]]) },
    blinkRight: { morphTargetBinds: binds([[eyeNode, eyeT('blinkRight'), 1]]) },
    happy: { morphTargetBinds: binds([[eyeNode, eyeT('happy'), 1], [mouthNode, mouthT('happy'), 1]]), overrideBlink: 'block' },
    angry: { morphTargetBinds: binds([[eyeNode, eyeT('angry'), 1], [mouthNode, mouthT('sad'), 0.6]]), overrideBlink: 'blend' },
    sad: { morphTargetBinds: binds([[eyeNode, eyeT('sad'), 1], [mouthNode, mouthT('sad'), 1]]) },
    relaxed: { morphTargetBinds: binds([[eyeNode, eyeT('happy'), 0.6], [mouthNode, mouthT('happy'), 0.6]]), overrideBlink: 'blend' },
    surprised: { morphTargetBinds: binds([[eyeNode, eyeT('surprised'), 1], [mouthNode, mouthT('surprised'), 1]]), overrideBlink: 'block' },
    aa: { morphTargetBinds: binds([[mouthNode, mouthT('aa'), 1]]) },
    ih: { morphTargetBinds: binds([[mouthNode, mouthT('ih'), 1]]) },
    ou: { morphTargetBinds: binds([[mouthNode, mouthT('ou'), 1]]) },
    ee: { morphTargetBinds: binds([[mouthNode, mouthT('ee'), 1]]) },
    oh: { morphTargetBinds: binds([[mouthNode, mouthT('oh'), 1]]) },
    lookUp: { morphTargetBinds: binds([[eyeNode, eyeT('lookUp'), 1]]) },
    lookDown: { morphTargetBinds: binds([[eyeNode, eyeT('lookDown'), 1]]) },
    lookLeft: { morphTargetBinds: binds([[eyeNode, eyeT('lookLeft'), 1]]) },
    lookRight: { morphTargetBinds: binds([[eyeNode, eyeT('lookRight'), 1]]) },
    neutral: {},
  };

  const HUMAN = ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
  const range = { inputMaxValue: 90, outputScale: 1 };
  json.extensions = {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name, version: '1', authors: ['Pixel Pet (generated test model)'], copyrightInformation: 'CC0, generated by scripts/make-test-vrm.js',
        licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'everyone', allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false,
        commercialUsage: 'corporation', allowPoliticalOrReligiousUsage: false, allowAntisocialOrHateUsage: false, creditNotation: 'unnecessary',
        allowRedistribution: true, modification: 'allowModificationRedistribution', otherLicenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        // `meta`: fields overridden, e.g. a restrictive license to exercise the app's limits (the mesh stays ours)
        ...meta,
      },
      humanoid: { humanBones: Object.fromEntries(HUMAN.map((b) => [b, { node: nodes[b] }])) },
      lookAt: { type: 'expression', offsetFromHeadBone: [0, 0.12, 0.1], rangeMapHorizontalInner: range, rangeMapHorizontalOuter: range, rangeMapVerticalDown: range, rangeMapVerticalUp: range },
      // `omit`: preset expressions left out (tests the renderer's fallbacks for a model that lacks them)
      expressions: { preset: Object.fromEntries(Object.entries(preset).filter(([n]) => !omit.includes(n))) },
    },
    VRMC_springBone: {
      specVersion: '1.0',
      colliders: [],
      colliderGroups: [],
      springs: [
        { name: 'tail', joints: ['tail1', 'tail2', 'tail3', 'tail4'].map((n) => ({ node: nodes[n], hitRadius: 0.02, stiffness: 0.6, gravityPower: 0.3, gravityDir: [0, -1, 0], dragForce: 0.25 })) },
        { name: 'ahoge', joints: ['hair1', 'hair2', 'hair3', 'hair4'].map((n) => ({ node: nodes[n], hitRadius: 0.01, stiffness: 0.9, gravityPower: 0.1, gravityDir: [0, -1, 0], dragForce: 0.3 })) },
      ],
    },
  };

  const bin = Buffer.concat(chunks);
  json.buffers.push({ byteLength: bin.length });
  return glb(json, bin);
}

function glb(json, bin) {
  let j = Buffer.from(JSON.stringify(json), 'utf8');
  if (j.length % 4) j = Buffer.concat([j, Buffer.alloc(4 - (j.length % 4), 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const out = Buffer.alloc(12 + 8 + j.length + 8 + b.length);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(j.length, 12); out.writeUInt32LE(0x4e4f534a, 16); j.copy(out, 20);
  out.writeUInt32LE(b.length, 20 + j.length); out.writeUInt32LE(0x004e4942, 24 + j.length); b.copy(out, 28 + j.length);
  return out;
}

module.exports = { makeTestVrm };

if (require.main === module) {
  const out = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'pixelpet-test-fish.vrm'));
  const repo = path.resolve(__dirname, '..');
  if (!path.relative(repo, out).startsWith('..') && !path.isAbsolute(path.relative(repo, out))) {
    console.error('refusing to write a .vrm inside the repository (none is ever committed)');
    process.exit(1);
  }
  fs.writeFileSync(out, makeTestVrm());
  console.log(out);
}
