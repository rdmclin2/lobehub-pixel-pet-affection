'use strict';
// MMD motion files (.vmd), read without any dependency (docs/vrm-dance.md §2.1, §2.7): the binary layout, the
// Shift-JIS names, the per-channel Bézier curves of the bone keys and a sampler that walks them frame by frame
// at the file's 30 fps. Also a writer (tests and the e2e fixture build their own motions with it) and the
// camera / prop check the dance import uses to pick the dancer's motion out of a folder.
//
// Layout (little endian): header 30 B ("Vocaloid Motion Data 0002"), model name 20 B (10 B in the old
// "Vocaloid Motion Data file" version); then counted sections, each one optional at the end of the file:
//   bone   111 B: name 15 B, frame u32, position 3×f32, rotation quaternion 4×f32 (x y z w), interpolation 64 B
//   morph   23 B: name 15 B, frame u32, weight f32
//   camera  61 B: frame u32, distance f32, position 3×f32, rotation 3×f32, interpolation 24 B, fov u32, ortho u8
//   light   28 B: frame u32, colour 3×f32, direction 3×f32
//   shadow   9 B: frame u32, mode u8, distance f32
//   ik      frame u32, show u8, count u32, count × (name 20 B, enabled u8)
// Positions and rotations stay in MMD's own axes here (left-handed, the model faces −Z); the handedness is
// changed by the retargeting (src/core/vmd-retarget.js).

const FPS = 30;
const HEADER_V2 = 'Vocaloid Motion Data 0002';
const HEADER_V1 = 'Vocaloid Motion Data file';

// ---------- Shift-JIS ----------
let sjisDecoder = null;
const decoder = () => sjisDecoder || (sjisDecoder = new TextDecoder('shift_jis'));
// A fixed-size name field: up to the first NUL, decoded; a multi-byte character cut by the field's end decodes
// to U+FFFD and is dropped.
function decodeName(bytes) {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return decoder().decode(bytes.subarray(0, end)).replace(/�+$/, '').trim();
}
// The encoder is built once from the decoder (JIS X 0208 double-byte range + ASCII + half-width katakana).
let sjisTable = null;
function encodeShiftJis(str) {
  if (!sjisTable) {
    sjisTable = new Map();
    const d = decoder();
    for (let i = 0xa1; i <= 0xdf; i++) sjisTable.set(d.decode(Uint8Array.of(i)), [i]);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue;
        const c = d.decode(Uint8Array.of(lead, trail));
        if (c.length === 1 && c !== '�' && !sjisTable.has(c)) sjisTable.set(c, [lead, trail]);
      }
    }
  }
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else {
      const b = sjisTable.get(ch);
      if (!b) throw new Error(`"${ch}" has no Shift-JIS code`);
      out.push(...b);
    }
  }
  return Buffer.from(out);
}
// Bone and morph names as matched against the tables: full-width letters and digits and half-width katakana
// folded (ＩＫ → IK, ０ → 0, ﾈｸﾀｲ → ネクタイ), spaces trimmed.
const normName = (s) => String(s || '').normalize('NFKC').trim();

// ---------- reading ----------
function parseVmd(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) : input);
  if (buf.length < 30) throw new Error('not a VMD file (too short)');
  const header = buf.subarray(0, 30).toString('latin1').replace(/\0.*$/s, '');
  let version;
  if (header.startsWith(HEADER_V2)) version = 2;
  else if (header.startsWith(HEADER_V1)) version = 1;
  else throw new Error('not a VMD file (unknown header)');
  let o = 30;
  const nameLen = version === 2 ? 20 : 10;
  if (buf.length < o + nameLen) throw new Error('not a VMD file (too short)');
  const modelName = decodeName(buf.subarray(o, o + nameLen));
  o += nameLen;
  const left = () => buf.length - o;
  // a section count, or 0 when the file ends before it (older tools stop after the morphs)
  const count = (size) => {
    if (left() < 4) return 0;
    const n = buf.readUInt32LE(o);
    o += 4;
    if (size && n * size > left()) throw new Error(`VMD truncated: ${n} records of ${size} B do not fit`);
    return n;
  };
  const f32 = (at) => buf.readFloatLE(at);

  const bones = [];
  const nb = count(111);
  for (let i = 0; i < nb; i++, o += 111) {
    bones.push({
      name: decodeName(buf.subarray(o, o + 15)),
      frame: buf.readUInt32LE(o + 15),
      pos: [f32(o + 19), f32(o + 23), f32(o + 27)],
      rot: [f32(o + 31), f32(o + 35), f32(o + 39), f32(o + 43)],
      interp: Uint8Array.from(buf.subarray(o + 47, o + 111)),
    });
  }
  const morphs = [];
  const nm = count(23);
  for (let i = 0; i < nm; i++, o += 23) morphs.push({ name: decodeName(buf.subarray(o, o + 15)), frame: buf.readUInt32LE(o + 15), weight: f32(o + 19) });
  const cameras = [];
  const nc = count(61);
  for (let i = 0; i < nc; i++, o += 61) cameras.push({ frame: buf.readUInt32LE(o), distance: f32(o + 4), pos: [f32(o + 8), f32(o + 12), f32(o + 16)], rot: [f32(o + 20), f32(o + 24), f32(o + 28)], fov: buf.readUInt32LE(o + 56), ortho: buf[o + 60] });
  const nl = count(28);
  const lights = nl;
  o += nl * 28;
  const ns = count(9);
  const shadows = ns;
  o += ns * 9;
  const ik = [];
  const ni = count(0);
  for (let i = 0; i < ni; i++) {
    if (left() < 9) throw new Error('VMD truncated in the IK section');
    const frame = buf.readUInt32LE(o);
    const show = buf[o + 4] !== 0;
    const k = buf.readUInt32LE(o + 5);
    o += 9;
    if (k * 21 > left()) throw new Error('VMD truncated in the IK section');
    const states = {};
    for (let j = 0; j < k; j++, o += 21) states[normName(decodeName(buf.subarray(o, o + 20)))] = buf[o + 20] !== 0;
    ik.push({ frame, show, states });
  }
  return { version, modelName, bones, morphs, cameras, lights, shadows, ik };
}

// The last frame with a bone or morph key (the camera does not count: a dance ends with the dancer).
function lastFrame(vmd) {
  let m = 0;
  for (const k of vmd.bones) if (k.frame > m) m = k.frame;
  for (const k of vmd.morphs) if (k.frame > m) m = k.frame;
  return m;
}

// Keys by (normalised) name, sorted by frame; a second key on the same frame replaces the first.
function groupKeys(keys) {
  const by = new Map();
  for (const k of keys) {
    const n = normName(k.name);
    if (!by.has(n)) by.set(n, []);
    by.get(n).push(k);
  }
  for (const [n, list] of by) {
    list.sort((a, b) => a.frame - b.frame);
    const out = [];
    for (const k of list) { if (out.length && out[out.length - 1].frame === k.frame) out[out.length - 1] = k; else out.push(k); }
    by.set(n, out);
  }
  return by;
}

// What a VMD holds: 'camera' (camera keys, no bones), 'prop' (bones, but not a person's: a chair, a mic stand),
// 'motion' (a dancer) or 'empty'.
const BODY_BONES = new Set(['センター', '上半身', '下半身', '左足IK', '右足IK', '左腕', '右腕', '左足', '右足', '首', '頭', 'グルーブ', '全ての親']);
function classifyVmd(vmd) {
  const names = new Set(vmd.bones.map((k) => normName(k.name)));
  if (!names.size) return vmd.cameras.length ? 'camera' : vmd.morphs.length ? 'motion' : 'empty';
  let body = 0;
  for (const n of names) if (BODY_BONES.has(n)) body++;
  return body >= 2 ? 'motion' : 'prop';
}

// ---------- curves ----------
// A VMD Bézier: P0 (0, 0), P1 (x1, y1), P2 (x2, y2), P3 (1, 1), control points in 0..127. The x is the time
// through the segment, the y how far the value has moved; y at a given x by bisection on the curve parameter.
function bezierY(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x1 === y1 && x2 === y2) return x; // the straight line, the default curve
  const ax = x1 / 127;
  const bx = x2 / 127;
  const ay = y1 / 127;
  const by = y2 / 127;
  const cubic = (p1, p2, t) => { const s = 1 - t; return 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t; };
  let lo = 0;
  let hi = 1;
  let t = x;
  for (let i = 0; i < 30; i++) {
    t = (lo + hi) / 2;
    const v = cubic(ax, bx, t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t; else hi = t;
  }
  return cubic(ay, by, t);
}
// The curve of one channel of a bone key (0 x, 1 y, 2 z, 3 rotation): the key's 64 interpolation bytes start
// with x1 of the four channels, then y1, x2, y2 (the rest repeats them shifted).
const curve = (interp, ch) => [interp[ch], interp[ch + 4], interp[ch + 8], interp[ch + 12]];
const LINEAR_INTERP = (() => { const b = new Uint8Array(64); for (let c = 0; c < 4; c++) { b[c] = 20; b[c + 4] = 20; b[c + 8] = 107; b[c + 12] = 107; } return b; })();

function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  let ka;
  let kb;
  if (d > 0.9995) { ka = 1 - t; kb = t; } else { const th = Math.acos(Math.min(1, d)); const s = Math.sin(th); ka = Math.sin((1 - t) * th) / s; kb = Math.sin(t * th) / s; }
  const q = [a[0] * ka + bb[0] * kb, a[1] * ka + bb[1] * kb, a[2] * ka + bb[2] * kb, a[3] * ka + bb[3] * kb];
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// A sampler over one bone's sorted keys: sample(frame) → { pos, rot } (MMD axes), the curve of the key that
// ends the segment shaping each channel (VMD stores a segment's curve on its second key). Held before the first
// and after the last key. Walks forward with a cursor (bakes sample in order); a backward jump searches again.
function boneSampler(keys) {
  let i = 0;
  const n = keys.length;
  return (frame) => {
    if (!n) return { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
    if (frame <= keys[0].frame) return { pos: keys[0].pos.slice(), rot: keys[0].rot.slice() };
    if (frame >= keys[n - 1].frame) return { pos: keys[n - 1].pos.slice(), rot: keys[n - 1].rot.slice() };
    if (keys[i].frame > frame) i = 0;
    while (i < n - 2 && keys[i + 1].frame <= frame) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const x = (frame - a.frame) / (b.frame - a.frame);
    const ip = b.interp || LINEAR_INTERP;
    const pos = [0, 1, 2].map((c) => { const s = bezierY(...curve(ip, c), x); return a.pos[c] + (b.pos[c] - a.pos[c]) * s; });
    const rot = slerp(a.rot, b.rot, bezierY(...curve(ip, 3), x));
    return { pos, rot };
  };
}
// A morph's weight at a frame (straight lines between keys: VMD morph keys carry no curve).
function morphSampler(keys) {
  let i = 0;
  const n = keys.length;
  return (frame) => {
    if (!n) return 0;
    if (frame <= keys[0].frame) return keys[0].weight;
    if (frame >= keys[n - 1].frame) return keys[n - 1].weight;
    if (keys[i].frame > frame) i = 0;
    while (i < n - 2 && keys[i + 1].frame <= frame) i++;
    const a = keys[i];
    const b = keys[i + 1];
    return a.weight + ((b.weight - a.weight) * (frame - a.frame)) / (b.frame - a.frame);
  };
}
// Whether an IK bone is on at a frame, from the IK section (a step function); undefined when the file never
// says (MMD's default is on).
function ikEnabled(ikFrames, name, frame) {
  const n = normName(name);
  let state;
  for (const k of ikFrames) {
    if (k.frame > frame) break;
    if (Object.prototype.hasOwnProperty.call(k.states, n)) state = k.states[n];
  }
  return state;
}

// ---------- writing (tests, fixtures) ----------
// { modelName, bones: [{ name, frame, pos?, rot?, interp? }], morphs: [{ name, frame, weight }], ik: [{ frame,
// show?, states: { name: bool } }], cameras: [{ frame, ... }] } → Buffer (version 2).
function writeVmd(m = {}) {
  const parts = [];
  const name = (s, len) => { const b = Buffer.alloc(len); encodeShiftJis(s).copy(b, 0, 0, len); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const head = Buffer.alloc(30);
  head.write(HEADER_V2, 'latin1');
  parts.push(head, name(m.modelName || '', 20));
  const bones = m.bones || [];
  parts.push(u32(bones.length));
  for (const k of bones) {
    const b = Buffer.alloc(111);
    name(k.name, 15).copy(b, 0);
    b.writeUInt32LE(k.frame, 15);
    const p = k.pos || [0, 0, 0];
    const r = k.rot || [0, 0, 0, 1];
    p.forEach((v, i) => b.writeFloatLE(v, 19 + i * 4));
    r.forEach((v, i) => b.writeFloatLE(v, 31 + i * 4));
    Buffer.from(k.interp || LINEAR_INTERP).copy(b, 47);
    parts.push(b);
  }
  const morphs = m.morphs || [];
  parts.push(u32(morphs.length));
  for (const k of morphs) { const b = Buffer.alloc(23); name(k.name, 15).copy(b, 0); b.writeUInt32LE(k.frame, 15); b.writeFloatLE(k.weight, 19); parts.push(b); }
  const cams = m.cameras || [];
  parts.push(u32(cams.length));
  for (const c of cams) { const b = Buffer.alloc(61); b.writeUInt32LE(c.frame, 0); b.writeFloatLE(c.distance || -45, 4); b.writeUInt32LE(c.fov || 30, 56); parts.push(b); }
  parts.push(u32(0), u32(0)); // lights, shadows
  const ik = m.ik || [];
  parts.push(u32(ik.length));
  for (const k of ik) {
    const entries = Object.entries(k.states || {});
    const h = Buffer.alloc(9);
    h.writeUInt32LE(k.frame, 0);
    h[4] = k.show === false ? 0 : 1;
    h.writeUInt32LE(entries.length, 5);
    parts.push(h);
    for (const [n, on] of entries) { const b = Buffer.alloc(21); name(n, 20).copy(b, 0); b[20] = on ? 1 : 0; parts.push(b); }
  }
  return Buffer.concat(parts);
}

module.exports = { FPS, parseVmd, lastFrame, groupKeys, classifyVmd, bezierY, curve, boneSampler, morphSampler, ikEnabled, writeVmd, encodeShiftJis, decodeName, normName, LINEAR_INTERP };
