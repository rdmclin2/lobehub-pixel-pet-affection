'use strict';
// How a VRM model (角色包 kind "vrm") acts out the app: the pure part of src/renderer/vrm.js, kept free of
// three.js and the DOM so it is tested (test/vrm-motion.test.js).
//
// - resolveFace: those preset names → the names the model really has, with pack.json `vrm.expressions`
//   overrides and safe fallbacks (a model without `surprised` gets `oh`, one with nothing gets nothing).
// - overClip: the clip's pose kept under the alive layer's offsets (no T-pose on a held key, no drift).
// - visemesFromSpectrum / syntheticVisemes / smoothVisemes: the aa/ih/ou/ee/oh mouth shapes from the voice.
// - frameMode / shouldRender / FpsMeter: the frame budget (active 30 fps, idle 12 fps, paused when hidden).
// - blink and gaze helpers, the arms-down rest pose, chewing.
// Loaded by the renderer as a <script> (window.PetVrmMotion) and by the tests through require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmMotion = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

  // VRM 1.0 preset expressions (three-vrm uses the same names for 0.x models)
  const PRESETS = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral'];
  const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];
  const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'];

  // ---------- the pixel vocabulary is gone ----------
  // VRM figures no longer turn the shared states (core/fx.js STATES) into procedural moves (hop, spin, dangle,
  // stride… — STATE_LOOKS / TOUCH_LOOKS / MOOD_LOOKS / pose were removed, docs/vrm-motion-system.md §2.3):
  // core/vrm-intent.js turns the app's data into semantic events and core/vrm-director.js decides what she
  // does with clips from the motion library plus the capped alive layer (core/vrm-life.js).
  // States she rests in for minutes or hours (core/pet-state.js currentStatus, and the idle chain's looking
  // about): they do not keep the frame rate up. Every other state is a reaction, a cue or an activity.
  const RESTING = ['idle', 'look', 'happy', 'sad', 'hungry', 'sleep'];
  const isResting = (state) => RESTING.includes(String(state || 'idle'));
  // Arms down from the T-pose (deg, normalized bones): what a model shows before (or without) any clip, so
  // she never stands in a T-pose. Left arm points +X: rolling it −z lowers it; right arm the other way.
  const ARM_DOWN = 72;
  const REST_POSE = { leftUpperArm: { x: 0, y: 0, z: -ARM_DOWN }, rightUpperArm: { x: 0, y: 0, z: ARM_DOWN }, leftLowerArm: { x: 0, y: -8, z: 0 }, rightLowerArm: { x: 0, y: 8, z: 0 } };
  // The rest pose for a model (T-2829): REST_POSE is written in VRM 1.0 / VRMA terms (she faces +Z, her left
  // arm points +X). A 0.x model's normalized bones face −Z (three-vrm's rotateVRM0 turns the whole scene), so
  // her left arm points −X there and the same z = −72° raised both arms ~72° above the T-pose — the "hands up"
  // every 0.x model held without a motion library. A half turn about Y mirrors x and z and keeps y (the same
  // convention as the renderer's alive layer, T-2691). → { bone: { x, y, z } } deg.
  function restPoseFor(metaVersion) {
    const v0 = String(metaVersion) === '0' ? -1 : 1;
    return Object.fromEntries(Object.entries(REST_POSE).map(([b, r]) => [b, { x: r.x * v0 || 0, y: r.y, z: r.z * v0 || 0 }]));
  }

  // ---------- face: preset names → the model's names ----------
  // A preset the model lacks is tried as these, in order; none left → dropped (nothing breaks).
  const FACE_FALLBACK = {
    relaxed: ['happy'],
    happy: ['relaxed'],
    surprised: ['oh', 'aa'],
    angry: ['sad'],
    sad: [],
    neutral: [],
    blinkLeft: ['blink'],
    blinkRight: ['blink'],
    blink: [],
    oh: ['ou', 'aa'],
    ou: ['oh', 'aa'],
    ee: ['ih', 'aa'],
    ih: ['ee', 'aa'],
    aa: ['oh'],
  };
  // The expression name to use for `name` in a model with `has(name)`, or null.
  function expressionFor(name, has) {
    if (has(name)) return name;
    for (const alt of FACE_FALLBACK[name] || []) if (has(alt)) return alt;
    return null;
  }
  // `face` ({ preset: weight }) as { modelName: weight } for a model with `has(name)`. `override`: the pack's
  // name for this state (pack.json vrm.expressions[state]) — it takes the place of the state's strongest
  // emotion, or is added at full weight to a state without one. Two presets on one name: the larger wins.
  function resolveFace(face, has, override = null) {
    const out = {};
    const put = (n, w) => { if (n && w > 0) out[n] = Math.max(out[n] || 0, clamp(w, 0, 1)); };
    let main = null;
    for (const [n, w] of Object.entries(face || {})) if (EMOTIONS.includes(n) && (!main || w > face[main])) main = n;
    for (const [n, w] of Object.entries(face || {})) {
      if (override && n === main) continue;
      put(expressionFor(n, has), w);
    }
    if (override && has(override)) put(override, main ? face[main] : 1);
    else if (override && main) put(expressionFor(main, has), face[main]);
    return out;
  }

  // ---------- blinking ----------
  const BLINK_MS = 180;
  // Seconds until the next blink: 2–6 s, sometimes a quick double blink.
  const nextBlinkIn = (rand = Math.random) => (rand() < 0.2 ? 0.25 : 2 + rand() * 4);
  // The lid weight `elapsed` seconds into a blink: shuts and opens again in BLINK_MS.
  function blinkWeight(elapsed, ms = BLINK_MS) {
    const p = elapsed / (ms / 1000);
    if (!(p >= 0) || p >= 1) return 0;
    return p < 0.5 ? p * 2 : 2 - p * 2;
  }

  // ---------- gaze ----------
  // A screen point (DIP, screen.getCursorScreenPoint) in window coordinates (CSS px).
  const screenToClient = (pt, win) => ({ x: pt.x - win.x, y: pt.y - win.y });
  // A client point against the canvas box: x −1 (left) .. 1 (right), y 1 (top) .. −1 (bottom), like NDC,
  // clamped to ±limit so a cursor far away makes her look to the side, not behind her. Mirrored canvas
  // (facing left) flips x.
  function gazeNdc(client, rect, { mirror = false, limit = 2.5 } = {}) {
    if (!client || !rect || !(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
    let x = ((client.x - rect.left) / rect.width) * 2 - 1;
    const y = 1 - ((client.y - rect.top) / rect.height) * 2;
    if (mirror) x = -x;
    return { x: clamp(x, -limit, limit), y: clamp(y, -limit, limit) };
  }

  // One frame of an idle clip under the app's moves: the bones the app moves (`names`) get the clip's own pose
  // back (`memo`, kept from the last frame; rest = identity before the first), then the mixer runs and the
  // clip's pose is kept again, before the caller lays its offsets on top. Putting back identity instead is not
  // enough: three's AnimationMixer writes a bone only when the clip's value changed since its last write, so on a
  // held key (a flat stretch of the clip — idle_loop.vrma holds its last 0.46 s — or dt 0) the bone stayed at
  // identity, the T-pose. `nodeOf(name)` is the normalized bone node (or null); nodes have a three Quaternion.
  function overClip(memo, nodeOf, names, mixer, dt) {
    for (const name of names) {
      const n = nodeOf(name);
      if (!n) continue;
      const q = memo.get(name);
      if (q) n.quaternion.copy(q); else n.quaternion.identity();
    }
    mixer.update(dt);
    for (const name of names) {
      const n = nodeOf(name);
      if (!n) continue;
      const q = memo.get(name);
      if (q) q.copy(n.quaternion); else memo.set(name, n.quaternion.clone());
    }
  }

  // Chewing while she eats (docs §3.5): the mouth, not a bone — aa 0..0.6 at about 1.4 Hz.
  const chewMouth = (t) => 0.6 * Math.max(0, Math.sin(t * 2 * Math.PI * 1.4));

  // ---------- lip sync: the voice → aa / ih / ou / ee / oh ----------
  const zeroVisemes = () => ({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 });
  // The strongest bin (0..1) between lo and hi Hz of an AnalyserNode byte spectrum: a formant is one peak,
  // so a wide band's average would drown it.
  function band(bins, sampleRate, lo, hi) {
    const hz = sampleRate / 2 / bins.length;
    const a = Math.max(0, Math.ceil(lo / hz));
    const b = Math.min(bins.length - 1, Math.floor(hi / hz));
    let m = 0;
    for (let i = a; i <= b; i++) if (bins[i] > m) m = bins[i];
    return m / 255;
  }
  // Mouth shapes from one spectrum (AnalyserNode.getByteFrequencyData). Loudness opens the mouth; where the
  // energy sits picks the vowel: low (200–700 Hz, a low first formant) rounds it (oh / ou), mid (700–1400,
  // a high first formant) opens it (aa), high (1800–3600, a high second formant) spreads it (ee / ih).
  // Silence (under `floor`) → all 0.
  function visemesFromSpectrum(bins, sampleRate = 48000, { floor = 0.06, gain = 2.6 } = {}) {
    const out = zeroVisemes();
    if (!bins || !bins.length) return out;
    const lo = band(bins, sampleRate, 200, 700);
    const mid = band(bins, sampleRate, 700, 1400);
    const hi = band(bins, sampleRate, 1800, 3600);
    const loud = Math.max(lo, mid, hi * 1.3);
    const open = clamp((loud - floor) * gain, 0, 1);
    if (open <= 0) return out;
    const sum = lo + mid + hi * 1.3 || 1;
    const sL = lo / sum;
    const sM = mid / sum;
    const sH = (hi * 1.3) / sum;
    const raw = { aa: sM, oh: sL * 0.6, ou: sL * 0.4, ee: sH * 0.6, ih: sH * 0.4 };
    // sharpen: the dominant shape leads, the others stay small
    const top = Math.max(...Object.values(raw));
    for (const k of VISEMES) out[k] = clamp(((raw[k] / top) ** 2) * open, 0, 1);
    return out;
  }
  // Without an audio stream (the system voice): a syllable every ~140 ms cycling through the vowels.
  const SYNTH_ORDER = ['aa', 'ih', 'oh', 'ee', 'ou', 'aa', 'oh'];
  function syntheticVisemes(t) {
    const out = zeroVisemes();
    const ph = t * 7;
    const i = Math.floor(ph);
    const env = Math.max(0, Math.sin((ph - i) * Math.PI));
    out[SYNTH_ORDER[((i % SYNTH_ORDER.length) + SYNTH_ORDER.length) % SYNTH_ORDER.length]] = env * (0.55 + 0.35 * Math.abs(Math.sin(t * 2.1)));
    return out;
  }
  // Ease the mouth towards `target`: opens fast (attack), closes a little slower (release); tiny values snap
  // to 0 so a silent mouth is exactly shut.
  function smoothVisemes(cur, target, dt, { attack = 24, release = 14 } = {}) {
    const out = zeroVisemes();
    for (const k of VISEMES) {
      const c = (cur && cur[k]) || 0;
      const g = (target && target[k]) || 0;
      const v = c + (g - c) * approach(g > c ? attack : release, dt);
      out[k] = v < 0.005 ? 0 : v;
    }
    return out;
  }

  // ---------- the frame budget ----------
  // She stays on the desktop for hours: draw at ACTIVE fps while something happens (a state other than
  // idle, talking, being dragged or moving, the cursor over her, a blink), drop to IDLE fps after
  // IDLE_AFTER_MS of nothing, and stop drawing while the window is hidden or minimised.
  const BUDGET = { activeFps: 30, idleFps: 12, idleAfterMs: 6000 };
  // { mode: 'active' | 'idle' | 'paused', fps }. `blinking` lifts an idle frame rate for the blink.
  function frameMode({ now, lastActivity = -Infinity, hidden = false, talking = false, dragging = false, busy = false, blinking = false }, budget = BUDGET) {
    if (hidden) return { mode: 'paused', fps: 0 };
    if (talking || dragging || busy || now - lastActivity < budget.idleAfterMs) return { mode: 'active', fps: budget.activeFps };
    return { mode: 'idle', fps: blinking ? budget.activeFps : budget.idleFps };
  }
  // Is a frame due at `now` (ms) when the last one was drawn at `last`? 1 ms of slack for rAF jitter.
  function shouldRender(now, last, fps) {
    if (!(fps > 0)) return false;
    if (last == null) return true;
    return now - last >= 1000 / fps - 1;
  }
  // Frames drawn in the last second.
  function FpsMeter(windowMs = 1000) {
    const times = [];
    return {
      tick(now) { times.push(now); while (times.length && now - times[0] > windowMs) times.shift(); },
      fps(now) { while (times.length && now - times[0] > windowMs) times.shift(); return times.length; },
    };
  }

  return {
    overClip, PRESETS, EMOTIONS, VISEMES, FACE_FALLBACK, RESTING, isResting, ARM_DOWN, REST_POSE, restPoseFor, expressionFor, resolveFace,
    BLINK_MS, nextBlinkIn, blinkWeight, screenToClient, gazeNdc, chewMouth,
    zeroVisemes, band, visemesFromSpectrum, syntheticVisemes, smoothVisemes, BUDGET, frameMode, shouldRender, FpsMeter,
  };
});
