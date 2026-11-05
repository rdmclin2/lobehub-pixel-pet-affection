'use strict';
// T-5092: the automatic posture guard over every baked clip (posture / idle / reaction / emote / talk / walk /
// dance, from Mixamo FBX and MMD VMD alike). It reads the clips in VRM normalized terms (rest = T-pose, every
// bone at identity in world-aligned axes, the arm along ±X), runs forward kinematics frame by frame (30 fps) and
// measures each arm against the torso:
//
//   down   the angle between the upper arm and the torso's own down axis (upperChest · −Y): 0° hanging, 90° level
//          with the shoulder, 180° straight up ("上臂与躯干夹角");
//   vert   the same against the world's vertical ("与竖直方向夹角"): a deep bow with the arms hanging is level to
//          the torso but not to the world, a lean back with the arms forward the other way round;
//   elbow  the bend between upper arm and forearm (0° straight);
//   side   how sideways the upper arm points (|arm · torso X|): 1 out to the side, 0 forward / back (reported).
//
// A frame is T-pose-like when BOTH upper arms are near level — vert (the world's vertical, like the live metric) in
// [TPOSE.min, TPOSE.max] = [75°, 115°] —
// with BOTH elbows near straight (< TPOSE.elbow): the arms held out like a T, to the side or in front (the
// standmix2 stretch the T-5089 run flagged). Arms over the head (> 115°) are not level, and a level upper arm with
// the forearm folded back (hands at the head / on the chest, clapping) is not a T. A clip is a hit when such frames
// run for ≥ TPOSE.holdS, unless the index annotates it `armsOut` (a figure that spreads the arms on purpose) — then
// it is reported as allowed, never silently skipped.
//
// The live T-pose metric of e2e/vrm-verify-metrics.js (tposeIntervals: both arms' elevation > −15°, i.e. down
// > 75°, ≥ 0.3 s, outside dance / reaction / hold) reads the same 75°; the guard is stricter on time (0.2 s) and
// also covers reactions and dances. `level` counts the frames with both upper arms > 75° alone, for the record.

const W = require('../../src/core/vrma-write');

const { qmul, qnorm, qrot } = W;
const DEG = 180 / Math.PI;
const TPOSE = { min: 75, max: 115, elbow: 35, holdS: 0.2 };
// T-5098: held stiff with the arms out — both upper arms spread out to the side by ≥ STIFF.deg (the abduction:
// asin |upper arm · torso X|, 0° hanging or reaching forward, 90° straight out sideways; "与竖直方向夹角大" measured
// in her frontal plane, so a sitting pose's hands forward on the knees is not "out") while neither moves more than
// STIFF.speed (°/s, the arm's direction, over a STIFF.win s window) for ≥ STIFF.holdS: penguin_stand (idle.v04@male)
// stood 9 s with both arms out at ~45° like a coat hanger. A posture clip (one held pose, ≤ 1 s) is still by
// nature: it is a hit when its arms are that far out at all (the director holds it for minutes).
// The arm must be held out, not folded: both elbows < STIFF.elbow (hands on the hips, arms crossed or a hand at the
// chin, a seated pose leaning back on its hands bend the elbow 80°+ and are rest poses). Every posture is checked —
// a kneeling crouch holding both arms spread (crouch.v02@male) is the same coat hanger as penguin_stand.
const STIFF = { deg: 35, elbow: 75, speed: 12, win: 0.5, holdS: 2 };
// T-5099: a base pose held with both upper arms raised above level (both > RAISED.vert from hanging, i.e. the
// elevation the runtime T-pose count uses: > −15°), whatever the elbows do — a posture or an idle is her base layer
// for seconds to minutes, so it is a hit on any frame: "Sitting, Arms Raised" (sit.v03, hands behind the head) sat 20 s
// with both upper arms 35–43° above level, motionless. Reactions / emotions / dances lift the arms on purpose: not checked; nor lying poses (group lay).
const RAISED = { vert: 75, kinds: ['posture', 'idle'] };
const KINDS = ['posture', 'idle', 'reaction', 'emotion', 'talk', 'walk', 'dance'];
const CHAIN = {
  left: ['hips', 'spine', 'chest', 'upperChest', 'leftShoulder', 'leftUpperArm'],
  right: ['hips', 'spine', 'chest', 'upperChest', 'rightShoulder', 'rightUpperArm'],
};
const FORE = { left: 'leftLowerArm', right: 'rightLowerArm' };
const TORSO = ['hips', 'spine', 'chest', 'upperChest'];

// a track { times, values: [x,y,z,w][] } sampled at t (slerp between keys, held outside)
function sampleQ(tr, t) {
  if (!tr || !tr.times.length) return [0, 0, 0, 1];
  const { times, values } = tr;
  const n = times.length - 1;
  if (t <= times[0]) return values[0];
  if (t >= times[n]) return values[n];
  let lo = 0; let hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
  return W.qslerp(values[lo], values[hi], (t - times[lo]) / (times[hi] - times[lo] || 1));
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * DEG;

// one frame: { left: { down, elbow, side }, right: { … } }
function armsAt(bones, t) {
  const world = (chain) => chain.reduce((q, b) => qnorm(qmul(q, sampleQ(bones[b], t))), [0, 0, 0, 1]);
  const torso = world(TORSO);
  const down = qrot(torso, [0, -1, 0]);
  const lateral = qrot(torso, [1, 0, 0]);
  const out = {};
  for (const s of ['left', 'right']) {
    const axis = [s === 'left' ? 1 : -1, 0, 0];
    const upperW = world(CHAIN[s]);
    const arm = qrot(upperW, axis);
    const fore = qrot(qnorm(qmul(upperW, sampleQ(bones[FORE[s]], t))), axis);
    const side = Math.abs(dot(arm, lateral));
    out[s] = { down: angle(arm, down), vert: angle(arm, [0, -1, 0]), elbow: angle(arm, fore), side, abd: Math.asin(Math.min(1, side)) * DEG, dir: arm };
  }
  return out;
}

const levelFrame = (a, th = TPOSE) => a.left.down > th.min && a.right.down > th.min;
const near = (x, th) => x >= th.min && x <= th.max;
const tposeFrame = (a, th = TPOSE) => ['left', 'right'].every((s) => near(a[s].vert, th) && a[s].elbow < th.elbow);

// a whole clip at `fps`: frames, T-pose-like frames, the longest run (s) and where it starts, `level` frames; and
// (T-5098) the longest run held stiff with both arms out (STIFF) — `stiffS`, where, how far out
function checkClip(clip, { fps = 30, th = TPOSE, st = STIFF, kind = null, group = null } = {}) {
  const n = Math.max(1, Math.round(clip.duration * fps));
  let run = 0; let best = 0; let bestAt = null; let runFrom = 0; let frames = 0; let level = 0; let both = 0;
  const arms = [];
  for (let i = 0; i <= n; i++) arms.push(armsAt(clip.bones, Math.min(clip.duration, i / fps)));
  // stiff: both arms out, and over the window around each frame neither arm's direction moved faster than st.speed
  const half = Math.max(1, Math.round((st.win * fps) / 2));
  const moved = (s, i) => { const a = arms[Math.max(0, i - half)][s].dir; const b = arms[Math.min(n, i + half)][s].dir; return angle(a, b) / ((Math.min(n, i + half) - Math.max(0, i - half)) / fps || 1); };
  let sRun = 0; let sBest = 0; let sAt = null; let sFrom = 0; let outMax = 0;
  for (let i = 0; i <= n; i++) {
    const a = arms[i];
    const out = Math.min(a.left.abd, a.right.abd);
    const still = n < 2 || (moved('left', i) < st.speed && moved('right', i) < st.speed);
    const held = a.left.elbow < st.elbow && a.right.elbow < st.elbow;
    if (out >= st.deg && held && still) {
      if (!sRun) sFrom = i / fps;
      sRun++;
      if (sRun > sBest) { sBest = sRun; sAt = +sFrom.toFixed(2); }
      outMax = Math.max(outMax, out);
    } else sRun = 0;
  }
  const posture = kind === 'posture';
  const stiffS = posture && sBest ? Infinity : sBest / fps;
  for (let i = 0; i <= n; i++) {
    const t = Math.min(clip.duration, i / fps);
    const a = arms[i];
    both = Math.max(both, Math.min(a.left.down, a.right.down));
    if (levelFrame(a, th)) level++;
    if (tposeFrame(a, th)) {
      frames++;
      if (!run) runFrom = t;
      run++;
      if (run > best) { best = run; bestAt = +runFrom.toFixed(2); }
    } else run = 0;
  }
  const longestS = best / fps;
  const bothVert = Math.max(...arms.map((a) => Math.min(a.left.vert, a.right.vert)));
  // (lying down the arms are level by nature — beside her or over her head: not a raised-arms pose, group lay is not checked)
  const raisedFrames = RAISED.kinds.includes(kind) && group !== 'lay' ? arms.filter((a) => Math.min(a.left.vert, a.right.vert) > RAISED.vert).length : 0;
  return { raisedFrames, raised: raisedFrames > 0, frames: n + 1, bothArmsMaxDeg: +both.toFixed(1), bothArmsVertDeg: +bothVert.toFixed(1), tposeFrames: frames, longestS: +longestS.toFixed(2), at: bestAt, level, suspect: longestS >= th.holdS, stiffS: Number.isFinite(stiffS) ? +stiffS.toFixed(2) : 'held', stiffAt: sAt, stiffOutDeg: +outMax.toFixed(1), stiff: stiffS >= st.holdS };
}

// a .vrma (Buffer) → the clip shape checkClip reads
function clipOfVrma(buf) {
  const { tracks } = W.readVrma(buf);
  const bones = {};
  let duration = 0;
  for (const [k, tr] of Object.entries(tracks)) {
    const m = /^(.+)\.rotation$/.exec(k);
    if (!m) continue;
    const values = [];
    for (let i = 0; i < tr.values.length; i += 4) values.push(tr.values.slice(i, i + 4));
    bones[m[1]] = { times: tr.times, values };
    duration = Math.max(duration, tr.times[tr.times.length - 1] || 0);
  }
  return { duration, bones };
}

// Every clip of a baked library folder (library.json + dances/library.json): [{ id, kind, src, armsOut, …check }]
// and a summary. `armsOut` comes from the library entry (copied from the index at bake time).
function checkLibrary(dir, { fs = require('node:fs'), path = require('node:path') } = {}) {
  const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
  const rows = [];
  for (const [id, c] of Object.entries(lib.clips)) {
    if (!c.file) continue;
    rows.push({ id, kind: c.category || c.kind, src: c.src, armsOut: c.armsOut || null, ...checkClip(clipOfVrma(fs.readFileSync(path.join(dir, c.file))), { kind: c.category || c.kind, group: c.group }) });
  }
  const dfile = path.join(dir, 'dances', 'library.json');
  if (fs.existsSync(dfile)) {
    const d = JSON.parse(fs.readFileSync(dfile, 'utf8'));
    for (const [id, c] of Object.entries(d.dances || {})) {
      rows.push({ id, kind: 'dance', src: c.src && c.src.motion, armsOut: c.armsOut || null, ...checkClip(clipOfVrma(fs.readFileSync(path.join(dir, 'dances', c.file))), { kind: 'dance' }) });
    }
  }
  return summarize(rows);
}

function summarize(rows) {
  const byKind = {};
  for (const r of rows) {
    const k = byKind[r.kind] || (byKind[r.kind] = { clips: 0, vmd: 0, mixamo: 0, frames: 0, levelFrames: 0, hits: 0, allowed: 0 });
    k.clips++;
    if (/\.vmd$/i.test(r.src || '')) k.vmd++; else k.mixamo++;
    k.frames += r.frames;
    k.levelFrames += r.level;
    if (r.suspect && r.armsOut) k.allowed++;
    else if (r.suspect) k.hits++;
    const stiffOk = (x) => x.stiff && x.armsOut && x.armsOut.stiffS >= x.stiffS;
    if (r.stiff && !stiffOk(r)) k.stiff = (k.stiff || 0) + 1;
    if (stiffOk(r)) k.allowed++;
  }
  const hits = rows.filter((r) => r.suspect && !r.armsOut);
  // a dance whose choreography holds the arms out on purpose: annotated armsOut.stiffS (reported, not skipped)
  const stiffAllowed = rows.filter((r) => r.stiff && r.armsOut && r.armsOut.stiffS >= r.stiffS);
  const allowed = rows.filter((r) => r.suspect && r.armsOut);
  const stiff = rows.filter((r) => r.stiff && !stiffAllowed.includes(r));
  const raised = rows.filter((r) => r.raised);
  return { raisedHits: raised.length, raisedList: raised, clips: rows.length, frames: rows.reduce((s, r) => s + r.frames, 0), hits: hits.length, allowed: allowed.length, stiffHits: stiff.length, byKind, hitList: hits, allowedList: allowed, stiffList: stiff, stiffAllowedList: stiffAllowed, rows };
}

// the report lines (scripts/vrm-bake.js --v2 --check prints them)
function formatReport(sum, th = TPOSE) {
  const lines = [`pose guard (T-pose): both upper arms ${th.min}°–${th.max}° from the vertical, with the elbows < ${th.elbow}°, for ≥ ${th.holdS} s @30fps`];
  lines.push(`pose guard (stiff arms out, T-5098): both upper arms spread ≥ ${STIFF.deg}° out to the side (abduction from the vertical, in her frontal plane), elbows < ${STIFF.elbow}°, neither arm moving faster than ${STIFF.speed}°/s (over ${STIFF.win} s), for ≥ ${STIFF.holdS} s; a posture (one held pose) whenever so`);
  lines.push(`  ${sum.clips} clips, ${sum.frames} frames checked`);
  for (const k of KINDS.concat(Object.keys(sum.byKind).filter((x) => !KINDS.includes(x)))) {
    const b = sum.byKind[k];
    if (!b) continue;
    lines.push(`  ${k.padEnd(9)} ${String(b.clips).padStart(3)} clips (vmd ${b.vmd}, mixamo ${b.mixamo}), ${String(b.frames).padStart(6)} frames, both arms >${th.min}°: ${b.levelFrames} frames, T-pose hits ${b.hits}${b.allowed ? `, allowed (armsOut) ${b.allowed}` : ''}, stiff hits ${b.stiff || 0}`);
  }
  for (const r of sum.allowedList) lines.push(`  allowed  ${r.id}: ${r.longestS} s @ ${r.at} s — armsOut: ${r.armsOut}`);
  for (const r of sum.hitList) lines.push(`  HIT      ${r.id} (${r.src}): ${r.tposeFrames} frames, longest ${r.longestS} s @ ${r.at} s`);
  for (const r of sum.stiffAllowedList || []) lines.push(`  allowed  ${r.id}: stiff arms out ${r.stiffS} s @ ${r.stiffAt} s ≤ armsOut.stiffS ${r.armsOut.stiffS} s (${r.armsOut.why})`);
  for (const r of sum.stiffList || []) lines.push(`  STIFF    ${r.id} (${r.src}): both arms out ≥ ${STIFF.deg}° (up to ${r.stiffOutDeg}°) and still for ${r.stiffS} s @ ${r.stiffAt} s`);
  for (const r of sum.raisedList || []) lines.push(`  RAISED   ${r.id} (${r.src}): a ${r.kind} holding both upper arms above level on ${r.raisedFrames}/${r.frames} frames (up to ${r.bothArmsVertDeg}° from hanging)`);
  lines.push(`pose guard: ${sum.hits} T-pose hit${sum.hits === 1 ? '' : 's'}, ${sum.stiffHits || 0} stiff hit${sum.stiffHits === 1 ? '' : 's'}, ${sum.raisedHits || 0} raised-arms base pose${sum.raisedHits === 1 ? '' : 's'} in ${sum.clips} clips${sum.hits || sum.stiffHits || sum.raisedHits ? ' — FAILED' : ''}`);
  return lines;
}

// ---------- MMD → VRM arm check (T-5092) ----------
// An MMD source is checked against the bake by a second, independent forward kinematics in MMD's own terms: the
// raw VMD keys (left-handed axes, no mirror), the reference skeleton's rest offsets (vmd-retarget MMD_REF) and the
// MMD hierarchy 上半身2 → 上半身3 → 肩P → 肩 → 肩C (= 肩P⁻¹) → 腕 → 腕捩 → ひじ → 手捩 → 手首. The upper arm
// (腕→ひじ) and forearm (ひじ→手首) directions, in the frame of 上半身·上半身1, mirrored into our axes, must equal
// the baked clip's (chest · upperChest · shoulder · upperArm [· lowerArm] on the VRM rest offsets). It catches a
// wrong A-pose angle, a lost twist bone, a missed shoulder cancel or a handedness slip: everything the bake's
// arm conversion does, recomputed without its code.
function vmdArmCheck(buf, { step = 2 } = {}) {
  const V = require('../../src/core/vmd');
  const R = require('../../src/core/vmd-retarget');
  const vmd = V.parseVmd(buf);
  const keys = V.groupKeys(vmd.bones, V.boneName);
  const samplers = new Map();
  const raw = (n, f) => { if (!keys.has(n)) return [0, 0, 0, 1]; if (!samplers.has(n)) samplers.set(n, V.boneSampler(keys.get(n))); return samplers.get(n)(f).rot; };
  const { clip } = R.retargetVmd(buf, { face: false, stage: false });
  const fps = clip.fps || 30;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const unit = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const refP = (n) => R.MMD_REF[n].p;
  const last = V.lastFrame(vmd);
  let maxUpper = 0; let maxFore = 0; let at = 0; let n = 0;
  for (let f = 0; f <= last; f += step) {
    const t = f / 30;
    if (t > clip.duration + 1e-6) break;
    for (const [s, j] of [['left', '左'], ['right', '右']]) {
      const chain = ['上半身2', '上半身3', `${j}肩P`, `${j}肩`, `${j}肩C`, `${j}腕`, `${j}腕捩`];
      let q = [0, 0, 0, 1];
      for (const b of chain) q = qnorm(qmul(q, b === `${j}肩C` ? W.qinv(raw(`${j}肩P`, f)) : raw(b, f)));
      const upM = R.toRH(qrot(q, unit(sub(refP(`${j}ひじ`), refP(`${j}腕`)))));
      q = qnorm(qmul(qnorm(qmul(q, raw(`${j}ひじ`, f))), raw(`${j}手捩`, f)));
      const foM = R.toRH(qrot(q, unit(sub(refP(`${j}手首`), refP(`${j}ひじ`)))));
      let v = [0, 0, 0, 1];
      for (const b of ['chest', 'upperChest', `${s}Shoulder`, `${s}UpperArm`]) v = qnorm(qmul(v, sampleQ(clip.bones[b], t)));
      const upV = qrot(v, unit(sub(R.VRM_REST[`${s}LowerArm`], R.VRM_REST[`${s}UpperArm`])));
      v = qnorm(qmul(v, sampleQ(clip.bones[`${s}LowerArm`], t)));
      const foV = qrot(v, unit(sub(R.VRM_REST[`${s}Hand`], R.VRM_REST[`${s}LowerArm`])));
      const eu = angle(upM, upV); const ef = angle(foM, foV);
      if (eu > maxUpper) { maxUpper = eu; at = t; }
      maxFore = Math.max(maxFore, ef);
      n++;
    }
  }
  return { samples: n, fps, maxUpperDeg: +maxUpper.toFixed(2), maxForeDeg: +maxFore.toFixed(2), at: +at.toFixed(2) };
}

module.exports = { RAISED, vmdArmCheck, TPOSE, STIFF, KINDS, armsAt, levelFrame, tposeFrame, checkClip, clipOfVrma, checkLibrary, summarize, formatReport, sampleQ };
