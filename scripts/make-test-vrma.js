'use strict';
// A homemade VRM motion library for tests and the e2e (docs/vrm-motion-system.md §8.2): one small .vrma per
// posture and idle slot of the bake list (src/core/vrm-library.json), for both styles, plus library.json in
// the format scripts/vrm-bake.js writes — made from numbers, no third-party motion. Every clip keys the same
// bones; each posture raises the right arm to its own angle so the e2e can tell them apart (and the male set
// stands with its feet apart), idles sway the body gently and loop.
//
//   node scripts/make-test-vrma.js <out dir>      (or require it: writeTestLibrary(dir))

const fs = require('node:fs');
const path = require('node:path');
const B = require('./lib/vrm-bake-core');
const L = require('../src/core/vrm-library');

const deg = (x, y, z) => {
  // XYZ euler (deg) → quaternion
  const [a, b, c] = [x, y, z].map((v) => (v * Math.PI) / 360);
  const [ca, cb, cc, sa, sb, sc] = [Math.cos(a), Math.cos(b), Math.cos(c), Math.sin(a), Math.sin(b), Math.sin(c)];
  return [sa * cb * cc + ca * sb * sc, ca * sb * cc - sa * cb * sc, ca * cb * sc + sa * sb * cc, ca * cb * cc - sa * sb * sc];
};
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'];
// the right arm's angle per posture (deg up from hanging), so a screenshot or a bone read tells them apart
const ARM = { 'stand.relaxed': 0, 'stand.confident': 20, 'stand.shy': 35, 'stand.playful': 50, 'sit.rest': 65, 'sit.doze': 80 };

function pose(slot, style, t = 0) {
  const sit = slot.startsWith('sit.');
  const wide = style === 'male' ? 4 : 0;
  const sway = slot.startsWith('idle.') ? Math.sin(t * Math.PI) * 4 : 0;
  const raise = ARM[slot] || 0;
  return {
    hips: deg(0, sway, 0),
    spine: deg(sit ? 8 : 0, 0, sway * 0.5),
    chest: deg(0, 0, 0),
    neck: deg(0, 0, 0),
    head: deg(slot === 'stand.shy' ? 12 : 0, 0, slot.startsWith('idle.') ? sway : 0),
    leftUpperArm: deg(0, 0, -70),
    rightUpperArm: deg(0, 0, 70 - raise),
    leftLowerArm: deg(0, -8, 0),
    rightLowerArm: deg(0, 8, 0),
    leftUpperLeg: deg(sit ? -80 : 0, 0, wide),
    rightUpperLeg: deg(sit ? -80 : 0, 0, -wide),
    leftLowerLeg: deg(sit ? 80 : 0, 0, 0),
    rightLowerLeg: deg(sit ? 80 : 0, 0, 0),
  };
}

function clipFor(slot, style, kind) {
  const times = kind === 'idle' ? [0, 0.5, 1, 1.5, 2] : [0, 1];
  const bones = Object.fromEntries(BONES.map((b) => [b, { times, values: times.map((t) => pose(slot, style, t)[b]) }]));
  const sit = slot.startsWith('sit.');
  return { duration: times[times.length - 1], bones, restHipsY: 1, hips: { times, values: times.map(() => [0, sit ? 0.45 : 1, 0]) }, rest: { hips: [0, 1, 0] } };
}

// Writes <dir>/<style>/<slot>.vrma and <dir>/library.json; returns the index.
function writeTestLibrary(dir, { styles = ['female', 'male'] } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'vrm-library.json'), 'utf8'));
  const index = { schema: 1, bakedAt: new Date().toISOString(), generator: 'scripts/make-test-vrma.js', clips: {} };
  for (const [id, e] of Object.entries(manifest.clips)) {
    const { slot, style } = L.parseId(id);
    if (!styles.includes(style) || !['posture', 'idle'].includes(e.kind)) continue;
    const meta = { kind: e.kind, style, label: e.label || slot, ...(e.sit ? { sit: true } : {}), ...(e.loop ? { loop: true } : {}) };
    if (!e.src) { index.clips[id] = { ...meta, cycle: e.cycle, every: e.every }; continue; }
    const c = clipFor(slot, style, e.kind);
    const file = `${style}/${slot}.vrma`;
    fs.mkdirSync(path.join(dir, style), { recursive: true });
    fs.writeFileSync(path.join(dir, file), B.writeVrma(c, { name: id, generator: 'make-test-vrma' }));
    index.clips[id] = { ...meta, file, duration: c.duration, bones: BONES.length };
  }
  fs.writeFileSync(path.join(dir, 'library.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node scripts/make-test-vrma.js <out dir>'); process.exit(1); }
  const idx = writeTestLibrary(path.resolve(out));
  console.log(`wrote ${Object.keys(idx.clips).length} clips to ${path.resolve(out)}`);
}
module.exports = { writeTestLibrary, ARM };
