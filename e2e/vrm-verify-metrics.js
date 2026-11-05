'use strict';

// T-5089: the numbers of the multi-model check (e2e/vrm-verify.js), from bone samples of the real app — the same
// functions read the T-5079 diagnosis series (before the fix, PetVRM.debug().figures[0].pose.q every ~110 ms), so
// before and after are measured alike:
//
//   node e2e/vrm-verify-metrics.js <series.json> [from s] [to s]   → the idle metrics of one series (JSON)
//
// A sample is { t (s), q: { bone: [x, y, z, w] }, base, file, idleKind, layers, … }.

const IDLE_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];
const DEG = 180 / Math.PI;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
const unit = (q) => { const L = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / L, q[1] / L, q[2] / L, q[3] / L]; };
// the angle between two orientations (deg). The samples are rounded to 4 decimals: normalised first and through
// atan2 (acos near 1 would turn the rounding into ~1.5° of false motion)
const qAngle = (a0, b0) => {
  const a = unit(a0); const b = unit(b0);
  const d = Math.abs(dot(a, b));
  const c = Math.sqrt(Math.max(0, 1 - d * d));
  return 2 * Math.atan2(c, d) * DEG;
};
const pct = (v, p) => { if (!v.length) return 0; const s = v.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const r2 = (x) => +Number(x).toFixed(2);

// how much of a bone's motion is one frequency: the orientation's angle from its mean pose (a scalar signal),
// detrended, its power spectrum 0.05–5 Hz on a uniform grid; the share of the strongest bin (±1). A held pose
// has no power (null); a single sine near 1; clips layered with breathing and gaze well under 0.5.
function dominantShare(ts, angles) {
  if (ts.length < 16) return null;
  const T = ts[ts.length - 1] - ts[0];
  if (T <= 0) return null;
  const n = Math.min(512, ts.length);
  const grid = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[0] + (T * i) / (n - 1);
    while (j < ts.length - 2 && ts[j + 1] < t) j++;
    const a = (t - ts[j]) / Math.max(1e-6, ts[j + 1] - ts[j]);
    grid.push(angles[j] + (angles[j + 1] - angles[j]) * Math.min(1, Math.max(0, a)));
  }
  const mean = grid.reduce((s, x) => s + x, 0) / n;
  const x = grid.map((v) => v - mean);
  const dtg = T / (n - 1);
  const pw = [];
  for (let k = 1; k < n / 2; k++) {
    const f = k / (n * dtg);
    if (f < 0.05 || f > 5) continue;
    let re = 0; let im = 0;
    for (let i = 0; i < n; i++) { const ph = (2 * Math.PI * k * i) / n; re += x[i] * Math.cos(ph); im -= x[i] * Math.sin(ph); }
    pw.push({ f, p: re * re + im * im });
  }
  const tot = pw.reduce((s, e) => s + e.p, 0);
  if (tot < 1e-6 * n) return null;
  let best = 0;
  for (let i = 0; i < pw.length; i++) if (pw[i].p > pw[best].p) best = i;
  const share = (pw[best].p + (pw[best - 1] ? pw[best - 1].p : 0) + (pw[best + 1] ? pw[best + 1].p : 0)) / tot;
  return { share: r2(share), hz: r2(pw[best].f) };
}

// per bone: angular speed between consecutive samples (deg/s: mean, p50, p95, max), the range of its angle from the
// mean pose (deg), how long it is still (share of steps under 2°/s), the dominant frequency share
function boneStats(samples, bones = IDLE_BONES) {
  const out = {};
  for (const b of bones) {
    const s = samples.filter((x) => x.q && x.q[b]);
    if (s.length < 3) continue;
    const sp = [];
    for (let i = 1; i < s.length; i++) { const dt = s[i].t - s[i - 1].t; if (dt > 0.005 && dt < 0.6) sp.push(qAngle(s[i - 1].q[b], s[i].q[b]) / dt); }
    // the mean orientation: the normalised sum, hemisphere-aligned to the first
    const m = [0, 0, 0, 0];
    for (const x of s) { const q = x.q[b]; const sg = dot(q, s[0].q[b]) < 0 ? -1 : 1; for (let k = 0; k < 4; k++) m[k] += sg * q[k]; }
    const L = Math.hypot(...m) || 1;
    for (let k = 0; k < 4; k++) m[k] /= L;
    const ang = s.map((x) => qAngle(m, x.q[b]));
    const mean = sp.reduce((a, v) => a + v, 0) / (sp.length || 1);
    const sd = Math.sqrt(sp.reduce((a, v) => a + (v - mean) * (v - mean), 0) / (sp.length || 1));
    out[b] = { n: s.length, speedMean: r2(mean), speedSd: r2(sd), speedP50: r2(pct(sp, 0.5)), speedP95: r2(pct(sp, 0.95)), speedMax: r2(sp.length ? Math.max(...sp) : 0), range: r2(Math.max(...ang) - Math.min(...ang)), still: r2(sp.filter((v) => v < 2).length / (sp.length || 1)), dominant: dominantShare(s.map((x) => x.t), ang) };
  }
  return out;
}

// the idle summary of a window of samples
function idleMetrics(samples) {
  const hit = samples.filter((s) => s.file && s.idleKind !== 'micro' && !/^rest\.pose:1/.test(s.layers || ''));
  const bases = [];
  for (const s of samples) if (s.base && bases[bases.length - 1] !== s.base) bases.push(s.base);
  const bones = boneStats(samples);
  const vals = Object.values(bones);
  const moving = vals.filter((b) => b.range >= 1);
  const doms = vals.map((b) => b.dominant && b.dominant.share).filter((x) => typeof x === 'number');
  const KEY9 = ['hips', 'spine', 'chest', 'head', 'neck', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'];
  // how different the poses of the idle clips are: per clip its mean orientation of each bone (samples on that
  // clip), then between consecutive clips the largest bone difference and the mean over the 18 bones (deg)
  const meanQ = (arr, b) => { const m = [0, 0, 0, 0]; const r = arr[0].q[b]; for (const x of arr) { const q = x.q[b]; const sg = dot(q, r) < 0 ? -1 : 1; for (let k = 0; k < 4; k++) m[k] += sg * q[k]; } return m; };
  const segs = [];
  for (const s of samples) { if (!s.file || !s.q) continue; const last = segs[segs.length - 1]; if (last && last.base === s.base) last.s.push(s); else segs.push({ base: s.base, s: [s] }); }
  const poseDelta = [];
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1]; const b = segs[i];
    let mx = 0; let mxB = null; let sum = 0; let n = 0;
    for (const bone of IDLE_BONES) { if (!a.s[0].q[bone] || !b.s[0].q[bone]) continue; const d = qAngle(meanQ(a.s, bone), meanQ(b.s, bone)); sum += d; n++; if (d > mx) { mx = d; mxB = bone; } }
    poseDelta.push({ from: a.base, to: b.base, maxDeg: r2(mx), maxBone: mxB, meanDeg: r2(sum / (n || 1)) });
  }
  return {
    samples: samples.length,
    poseDelta,
    seconds: samples.length ? r2(samples[samples.length - 1].t - samples[0].t) : 0,
    hits: hit.length,
    hitRatio: samples.length ? +(hit.length / samples.length).toFixed(3) : 0,
    distinctClips: [...new Set(samples.filter((s) => s.file).map((s) => s.base))].length,
    clipSequence: bases,
    switches: Math.max(0, bases.length - 1),
    postures: [...new Set(samples.map((s) => s.pose || s.posture).filter(Boolean))],
    bones,
    meanSpeedAll: r2(vals.reduce((a, b) => a + b.speedMean, 0) / (vals.length || 1)),
    movingBones: moving.length,
    stillBones: vals.filter((b) => b.range < 0.5).map((b) => Object.keys(bones).find((k) => bones[k] === b)),
    // the T-5079 number: the 9 key bones' ranges summed
    key9RangeSum: r2(KEY9.reduce((a, b) => a + (bones[b] ? bones[b].range : 0), 0)),
    dominantShareMedian: doms.length ? r2(pct(doms, 0.5)) : null,
    dominantShareMax: doms.length ? r2(Math.max(...doms)) : null,
    singleSineBones: Object.entries(bones).filter(([, b]) => b.dominant && b.dominant.share > 0.8 && b.range >= 1).map(([k]) => k),
  };
}

// arms spread level, read as a T-pose: both upper arms within 15° of horizontal (renderer pose().arms elevation >
// −15°) for ≥ 0.3 s, outside a dance / reaction / hold (a cheer may lift them on purpose) — the base clip it came from
function tposeIntervals(samples, { minS = 0.3, elev = -15 } = {}) {
  const out = [];
  let cur = null;
  const flush = (t) => { if (cur && t - cur.from >= minS) out.push({ from: cur.from, seconds: +(t - cur.from).toFixed(1), base: cur.base, maxElev: +cur.maxElev.toFixed(1) }); cur = null; };
  for (const x of samples) {
    const on = x.arms && x.arms[0] > elev && x.arms[1] > elev && !x.dance && !x.reaction && !x.hold;
    if (on && !cur) cur = { from: x.t, base: x.base, maxElev: -90 };
    if (on) cur.maxElev = Math.max(cur.maxElev, x.arms[0], x.arms[1]);
    if (!on && cur) flush(x.t);
  }
  if (cur && samples.length) flush(samples[samples.length - 1].t);
  return out;
}

// T-5092: the samples (frames of the 100 ms series) with both arms level outside a dance / reaction / hold, however
// short — the "T-pose frames" count (tposeIntervals keeps only runs ≥ 0.3 s)
const tposeSamples = (samples, { elev = -15 } = {}) => samples.filter((x) => x.arms && x.arms[0] > elev && x.arms[1] > elev && !x.dance && !x.reaction && !x.hold).length;


// T-5099: held stiff with the arms out, on the running app (the same definition as the bake guard
// scripts/lib/vrm-pose-guard.js STIFF): both upper arms spread out sideways by ≥ 35° (abduction in her torso's
// frontal plane: asin |upper arm · torso X|), both elbows bent < 75°, and over a 0.5 s window neither arm's direction
// moved faster than 12 °/s; a run of such samples lasting ≥ 2 s is "stiff". From the sampled normalized bone rotations
// (pose().q); a VRM 0.x model's normalized rig is turned 180° about Y, so its quaternions are mapped back to the VRMA
// frame first (x, z negated). Dance samples are counted apart (choreography may hold the arms out on purpose).
const STIFF = { deg: 35, elbow: 75, speed: 12, win: 0.5, holdS: 2 };
const CHAIN = {
  left: ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm'],
  right: ['hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm'],
};
const TORSO = ['hips', 'spine', 'chest', 'upperChest'];
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qrot = (q, v) => { const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]); return [p[0], p[1], p[2]]; };
const vang = (a, b) => { const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((Math.hypot(...a) * Math.hypot(...b)) || 1); return Math.acos(Math.max(-1, Math.min(1, d))) * DEG; };
function armsOfSample(x, v0) {
  const g = (b) => { const q = x.q && x.q[b]; if (!q) return [0, 0, 0, 1]; return unit(v0 ? [-q[0], q[1], -q[2], q[3]] : q); };
  const world = (chain) => chain.reduce((q, b) => unit(qmul(q, g(b))), [0, 0, 0, 1]);
  const lateral = qrot(world(TORSO), [1, 0, 0]);
  const out = {};
  for (const s of ['left', 'right']) {
    const axis = [s === 'left' ? 1 : -1, 0, 0];
    const up = world(CHAIN[s]);
    const arm = qrot(up, axis);
    const fore = qrot(unit(qmul(up, g(`${s}LowerArm`))), axis);
    const side = Math.abs(arm[0] * lateral[0] + arm[1] * lateral[1] + arm[2] * lateral[2]);
    out[s] = { abd: Math.asin(Math.min(1, side)) * DEG, elbow: vang(arm, fore), dir: arm };
  }
  return out;
}
function stiffSplay(samples, { v0 = false, st = STIFF } = {}) {
  const A = samples.map((x) => (x.q ? armsOfSample(x, v0) : null));
  const speed = (i, s) => {
    let a = i; let b = i;
    while (a > 0 && samples[i].t - samples[a - 1].t <= st.win / 2) a--;
    while (b < samples.length - 1 && samples[b + 1].t - samples[i].t <= st.win / 2) b++;
    if (a === b || !A[a] || !A[b]) return Infinity;
    return vang(A[a][s].dir, A[b][s].dir) / ((samples[b].t - samples[a].t) || 1);
  };
  const cand = samples.map((x, i) => {
    const r = A[i];
    if (!r) return false;
    return Math.min(r.left.abd, r.right.abd) >= st.deg && r.left.elbow < st.elbow && r.right.elbow < st.elbow;
  });
  const still = samples.map((x, i) => cand[i] && speed(i, 'left') < st.speed && speed(i, 'right') < st.speed);
  const runs = [];
  const scan = (pick, tag) => {
    let from = -1;
    const close = (end) => { if (from < 0) return; const s0 = samples[from]; const s1 = samples[end]; const dur = s1.t - s0.t + 0.1; if (dur >= st.holdS) runs.push({ tag, from: s0.t, seconds: +dur.toFixed(1), n: end - from + 1, base: s0.base, action: s0.action, dance: s0.dance || '', reaction: s0.reaction || '', hold: s0.hold || '' }); from = -1; };
    for (let i = 0; i < samples.length; i++) { if (pick(i)) { if (from < 0) from = i; } else close(i - 1); }
    close(samples.length - 1);
  };
  scan((i) => still[i] && !samples[i].dance, 'body');
  scan((i) => still[i] && !!samples[i].dance, 'dance');
  const body = runs.filter((r) => r.tag === 'body');
  const absMax = samples.reduce((m, x, i) => (A[i] && !x.dance ? Math.max(m, Math.min(A[i].left.abd, A[i].right.abd)) : m), 0);
  const idleAbd = samples.filter((x, i) => A[i] && x.action === 'idle' && !x.dance && !x.reaction && !x.hold).map((x, i) => x);
  return {
    frames: body.reduce((n, r) => n + r.n, 0), // the samples inside a ≥ 2 s stiff run, outside a dance: must be 0
    runs: body,
    danceRuns: runs.filter((r) => r.tag === 'dance'),
    armsOutSamples: cand.filter((c, i) => c && !samples[i].dance).length, // arms that far out at all (moving or not)
    stillOutSamples: still.filter((c, i) => c && !samples[i].dance).length, // … and still, before the 2 s rule
    bothArmsMaxAbd: +absMax.toFixed(1),
    idleSamples: idleAbd.length,
  };
}

module.exports = { IDLE_BONES, qAngle, boneStats, idleMetrics, dominantShare, tposeIntervals, tposeSamples, stiffSplay, armsOfSample, STIFF };

if (require.main === module) {
  const fs = require('node:fs');
  const [file, from, to] = process.argv.slice(2);
  let s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (s.samples) s = s.samples;
  // the T-5079 series: base is the plan's base as a JSON string ({ id, file, … })
  s = s.map((x) => (typeof x.base === 'string' && x.base.startsWith('{') ? (() => { const b = JSON.parse(x.base); return { ...x, base: b.id, file: b.file }; })() : x));
  if (from !== undefined) s = s.filter((x) => x.t >= Number(from) && (to === undefined || x.t <= Number(to)));
  const m = idleMetrics(s);
  process.stdout.write(`${JSON.stringify(m, null, 2)}\n`);
}
