'use strict';
// T-5092: an offline replay of the VRM motion pipeline — the real director (src/core/vrm-director.js) over a real
// baked library (library.json + its .vrma clips), the clips mixed the way the renderer mixes them (renderer/
// vrm-anim.js: the base cross-fade with its weights summing to 1 and the phase alignment, then the overlays slerped
// in by weight × mask, the reaction's limbs by their own weight; the clips' own steps spread at load like
// renderer/vrm.js loadVrma), then the output limiter (src/core/vrm-smooth.js), and the jump meter of renderer/vrm.js
// (meterJump: °/frame@30, spike = a frame's turn minus the larger of its neighbours', a 1.6 s window after every
// change of base / reaction / overlays). No three.js, no window: it runs in Node (test/vrm-replay.test.js,
// node scripts/vrm-replay.js).
//
// Left out, on purpose: the alive layer (breathing, weight shift — ≤ 4°, slow), the look-at (eyes and a head
// follow) and the procedural acts (eat / play / sleep) — none of them switch on a touch.
//
//   replay({ dir, style: 'female', seconds, frames: 'steady30' | 'xvfb' (9–15 fps, jittered like the T-5089 runs),
//            events: { t: [event…] }, holds: (t) => holds, settle: true|false, limiter: true|false, seed })
//   → { frames, spikeMax, spikeBone, spikeAt, windows: [{ at, what, spike, bone, speed }], plans? }

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../../src/core/vrm-director');
const Lib = require('../../src/core/vrm-library');
const St = require('../../src/core/vrm-style');
const BM = require('../../src/core/vrm-bone-map');
const Sm = require('../../src/core/vrm-smooth');
const W = require('../../src/core/vrma-write');

const JUMP_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];
const JUMP_WIN = 1.6;
const JERK_MAX = 90000; // renderer/vrm.js JERK_MAX (T-5098)
const FLIP_DOT = Math.cos((75 * Math.PI) / 180); // renderer/vrm-anim.js FLIP_DOT (T-5098)
function slerpKeep(a, b, t) {
  const d = Math.max(-1, Math.min(1, W.qdot(a, b)));
  let ka; let kb;
  if (d > 0.9995) { ka = 1 - t; kb = t; } else { const th = Math.acos(d); const s = Math.sin(th); ka = Math.sin((1 - t) * th) / s; kb = Math.sin(t * th) / s; }
  const q = [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb, a[3] * ka + b[3] * kb];
  const n = Math.hypot(...q) || 1;
  return q.map((x) => x / n);
}
const ALIGN_N = 16;
const ALIGN_W = { hips: 2, spine: 1, chest: 1, upperChest: 0.5, neck: 0.5, head: 0.7, leftUpperArm: 1.5, rightUpperArm: 1.5, leftLowerArm: 1, rightLowerArm: 1, leftUpperLeg: 1.5, rightUpperLeg: 1.5, leftLowerLeg: 1, rightLowerLeg: 1 };
const smooth = (k) => { const x = Math.max(0, Math.min(1, k)); return x * x * (3 - 2 * x); };

// the renderer's mask table (renderer/vrm-anim.js maskWeight, LIMB), run as it is
let animMod = null;
function anim() {
  if (animMod) return animMod;
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'vrm-anim.js'), 'utf8'), ctx);
  animMod = ctx.window.PetVrmAnim;
  return animMod;
}

// a .vrma → { duration, tracks: { bone: { times, values: [q…] } } }, steps spread like loadVrma (T-5084)
function readClip(buf, opts = {}) {
  const { tracks } = W.readVrma(buf);
  const out = {};
  let duration = 0;
  for (const [k, tr] of Object.entries(tracks)) {
    const m = /^(.+)\.rotation$/.exec(k);
    if (!m) continue;
    const times = Float32Array.from(tr.times);
    const flat = Float32Array.from(tr.values);
    let T = times; let V = flat;
    if (!/Thumb|Index|Middle|Ring|Little|Toes/.test(m[1])) {
      BM.smoothSteps(times, flat);
      // T-5098: the angular acceleration limited like loadVrma (unless the caller replays the clips as baked)
      // (the renderer's jerk limit on reactions and holds, renderer/vrm.js JERK_MAX; opts.accel: false = as baked,
      // an object = another limit to try)
      const acc = opts.accel === false ? null : opts.accel || (opts.kind === 'reaction' || opts.kind === 'hold' ? { jMax: JERK_MAX } : null);
      const a = !acc ? null : acc.passes ? BM.smoothKeys(times, flat, acc) : BM.limitAccel(times, flat, acc);
      if (a) { T = a.times; V = a.values; }
    }
    const values = [];
    for (let i = 0; i < V.length; i += 4) values.push([V[i], V[i + 1], V[i + 2], V[i + 3]]);
    out[m[1]] = { times: Array.from(T), values };
    duration = Math.max(duration, times[times.length - 1] || 0);
  }
  return { duration, tracks: out };
}
function sampleQ(tr, t) {
  const { times, values } = tr;
  const n = times.length - 1;
  if (t <= times[0]) return values[0];
  if (t >= times[n]) return values[n];
  let lo = 0; let hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= t) lo = m; else hi = m; }
  return Sm.slerp(values[lo], values[hi], (t - times[lo]) / (times[hi] - times[lo] || 1));
}

function loadLibrary(dir, styleSet, opts = {}) {
  const index = Lib.cleanIndex(JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')));
  const sets = new Set(Lib.loadSets(index, styleSet));
  const clips = new Map();
  for (const c of Object.values(index.clips)) {
    if (!c.file || !sets.has(c.style)) continue;
    clips.set(c.id, readClip(fs.readFileSync(path.join(dir, c.file)), { ...opts, kind: c.kind }));
  }
  return { index, clips, loaded: new Set(clips.keys()) };
}

function frameTimes(kind, seconds, rand) {
  const out = [];
  let t = 0;
  while (t < seconds) {
    const dt = kind === 'xvfb' ? 1 / (9 + rand() * 6) : 1 / 30;
    out.push(dt);
    t += dt;
  }
  return out;
}

const libCache = new Map();
function replay(o) {
  const style = St.resolveStyle({ packStyle: { base: o.style || 'female' } });
  const key = `${o.dir}|${style.set}|${JSON.stringify(o.accel === undefined ? null : o.accel)}`;
  if (!libCache.has(key)) libCache.set(key, loadLibrary(o.dir, style.set, { accel: o.accel }));
  const lib = libCache.get(key);
  const A = anim();
  const director = D.createDirector({ style, index: lib.index, loaded: lib.loaded, rand: D.seeded(o.seed || 7), boredAfter: o.boredAfter, settle: o.settle !== false });
  const limiter = o.limiter === false ? null : Sm.createLimiter();
  const rand = D.seeded((o.seed || 7) + 1000);
  const holdsOf = (t) => ({ mood: 'idle', talk: false, think: false, eat: null, walk: false, lift: false, attention: false, facing: 'right', ...(o.holds ? o.holds(t) : {}) });
  const due = Object.entries(o.events || {}).map(([k, v]) => ({ t: Number(k), ev: v, done: false })).sort((a, b) => a.t - b.t);
  let layers = []; // { id, time, w, w0 }
  let fade = null; // { from, dur, to }
  let lastBaseKey = -1;
  let pose = Object.fromEntries(JUMP_BONES.map((b) => [b, [0, 0, 0, 1]]));
  const jm = { prev: new Map(), d1: new Map(), d2: new Map() };
  const sides = new Map();
  let sig = null;
  const windows = [];
  const open = [];
  let spikeMax = 0; let spikeBone = null; let spikeAt = 0;
  const plans = [];
  let t = 0;
  for (const dt of frameTimes(o.frames || 'steady30', o.seconds || 30, rand)) {
    t += dt;
    const events = [];
    for (const x of due) if (!x.done && t >= x.t - 1e-9) { x.done = true; events.push(...x.ev); }
    const plan = director.update(dt, { holds: holdsOf(t), events });
    if (o.keepPlans) plans.push({ t, base: plan.base && plan.base.id, reaction: plan.reaction, overlays: (plan.overlays || []).map((x) => `${x.id}:${x.weight}`).join(','), settling: plan.settling, talkQueued: plan.talkQueued, hold: plan.hold });
    // ---- the base layers (vrm-anim.js setBase / update) ----
    if (plan.base && plan.base.key !== lastBaseKey) {
      const id = plan.base.id && lib.clips.has(plan.base.id) ? plan.base.id : null;
      if (id && !(fade && fade.to.id === id)) {
        let L = layers.find((l) => l.id === id);
        if (!L) {
          const c = lib.clips.get(id);
          let time = 0;
          // phase alignment: the nearest of ALIGN_N candidate times to the pose now (idle clips only)
          if (lastBaseKey >= 0 && plan.idleKind === 'clip' && plan.posture === null && c.duration > 0.2) {
            let bestD = Infinity;
            for (let i = 0; i < ALIGN_N; i++) {
              const tt = ((i + 0.5) / ALIGN_N) * c.duration;
              let dd = 0;
              for (const [b, w] of Object.entries(ALIGN_W)) if (c.tracks[b]) dd += w * (1 - Math.abs(W.qdot(sampleQ(c.tracks[b], tt), pose[b])));
              if (dd < bestD) { bestD = dd; time = tt; }
            }
          }
          L = { id, time, w: 0, loop: true };
          layers.push(L);
        }
        const dur = lastBaseKey < 0 ? 0 : plan.base.fade;
        if (!(dur > 0) || layers.length === 1) { layers = [L]; L.w = 1; fade = { from: t, dur: 0, to: L }; } else { for (const l of layers) l.w0 = l.w; fade = { from: t, dur, to: L }; }
      }
      lastBaseKey = plan.base.key;
    }
    if (fade && layers.length > 1) {
      const k = fade.dur > 0 ? smooth((t - fade.from) / fade.dur) : 1;
      const others = layers.filter((l) => l !== fade.to);
      const sum0 = others.reduce((s, l) => s + (l.w0 || 0), 0) || 1;
      fade.to.w = k + (1 - k) * (fade.to.w0 || 0);
      for (const l of others) l.w = (1 - fade.to.w) * ((l.w0 || 0) / sum0);
      if (k >= 1) { layers = [fade.to]; fade.to.w = 1; }
    }
    for (const l of layers) l.time += dt;
    // three's PropertyMixer: the layers' values accumulated by slerp at w / (W + w)
    const next = {};
    for (const b of JUMP_BONES) {
      let acc = null; let W0 = 0;
      for (const l of layers) {
        const c = lib.clips.get(l.id);
        const tr = c && c.tracks[b];
        if (!tr || !(l.w > 0)) continue;
        const q = sampleQ(tr, c.duration > 0 ? l.time % c.duration : 0);
        acc = acc ? Sm.slerp(acc, q, l.w / (W0 + l.w)) : q;
        W0 += l.w;
      }
      next[b] = acc || pose[b];
    }
    // ---- the overlays (vrm-anim.js applyOverlays) ----
    for (const ov of plan.overlays || []) {
      if (!(ov.weight > 0.0005)) continue;
      const c = lib.clips.get(ov.id);
      if (!c) continue;
      for (const b of JUMP_BONES) {
        const tr = c.tracks[b];
        if (!tr) continue;
        const k = (ov.limb !== undefined && A.LIMB.test(b) ? Math.min(ov.weight, ov.limb) : ov.weight) * A.maskWeight(ov.mask || 'upper', b);
        if (!(k > 0)) continue;
        // (renderer/vrm-anim.js applyOverlays: near 180° the side taken last frame is kept, T-5098)
        let q = sampleQ(tr, Math.max(0, Math.min(c.duration, ov.time || 0)));
        const d = W.qdot(next[b], q);
        const key = `${ov.id}|${b}`;
        const sign = Math.abs(d) < FLIP_DOT && sides.get(key) ? sides.get(key) : d < 0 ? -1 : 1;
        sides.set(key, sign);
        if (sign < 0) q = q.map((x) => -x);
        next[b] = slerpKeep(next[b], q, Math.min(1, k));
      }
    }
    // ---- the limiter, then the jump meter (vrm.js smoothBones / meterJump) ----
    if (limiter) for (const b of JUMP_BONES) next[b] = limiter.step(b, next[b], dt);
    pose = next;
    const k30 = (1 / 30) / Math.max(1 / 120, dt);
    let fSpike = 0; let fBone = null; let fSpeed = 0;
    for (const b of JUMP_BONES) {
      const p = jm.prev.get(b);
      jm.prev.set(b, pose[b]);
      if (!p) continue;
      const d = Sm.angle(p, pose[b]) * k30;
      fSpeed = Math.max(fSpeed, d);
      const d1 = jm.d1.get(b); const d2 = jm.d2.get(b);
      if (d1 !== undefined && d2 !== undefined) { const sp = d1 - Math.max(d2, d); if (sp > fSpike) { fSpike = sp; fBone = b; } }
      if (d1 !== undefined) jm.d2.set(b, d1);
      jm.d1.set(b, d);
    }
    if (fSpike > spikeMax) { spikeMax = fSpike; spikeBone = fBone; spikeAt = t; }
    const s = [plan.base && plan.base.id, plan.reaction || '', (plan.overlays || []).filter((x) => x.weight > 0.0005).map((x) => x.id).join('+')].join('|');
    if (sig !== null && s !== sig) {
      const [b0, r0, o0] = sig.split('|'); const [b1, r1, o1] = s.split('|');
      const w = { at: +t.toFixed(3), what: [b0 !== b1 ? `base→${b1}` : null, r0 !== r1 ? `reaction→${r1 || 'none'}` : null, o0 !== o1 ? `overlays ${o0 || '-'}→${o1 || '-'}` : null].filter(Boolean).join('; '), spike: 0, bone: null, speed: 0, until: t + JUMP_WIN };
      windows.push(w);
      open.push(w);
    }
    sig = s;
    // (the spike computed now belongs to the frame before: it counts for windows open then)
    for (const w of open) if (t - dt <= w.until) { if (fSpike > w.spike) { w.spike = fSpike; w.bone = fBone; } w.speed = Math.max(w.speed, fSpeed); }
    for (let i = open.length - 1; i >= 0; i--) if (t > open[i].until + 0.2) open.splice(i, 1);
  }
  const r2 = (x) => +x.toFixed(2);
  return {
    frames: plans.length || undefined,
    spikeMax: r2(spikeMax), spikeBone, spikeAt: r2(spikeAt),
    windows: windows.map((w) => ({ at: w.at, what: w.what, spike: r2(w.spike), bone: w.bone, speed: r2(w.speed) })),
    limiter: limiter ? limiter.stats() : null,
    plans: o.keepPlans ? plans : undefined,
  };
}

module.exports = { replay, loadLibrary, readClip, JUMP_BONES, JERK_MAX };
