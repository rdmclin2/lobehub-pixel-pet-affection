'use strict';
// How a VRM model (角色包 kind "vrm") acts out the app: the pure part of src/renderer/vrm.js, kept free of
// three.js and the DOM so it is tested (test/vrm-motion.test.js).
//
// - STATE_LOOKS / TOUCH_LOOKS / MOOD_LOOKS: every state of the shared effects layer (core/fx.js STATES:
//   idle, pat, lifted, eat_*, play, …) and every touch reaction (touch-<zone>, the angry / annoyed moods of
//   core/touch-zones.js) as VRM preset expressions (`face`) plus procedural moves (`motion`).
// - resolveFace: those preset names → the names the model really has, with pack.json `vrm.expressions`
//   overrides and safe fallbacks (a model without `surprised` gets `oh`, one with nothing gets nothing).
// - pose: the moves as bone rotations (degrees, VRM normalized humanoid bones) and a root offset.
// - visemesFromSpectrum / syntheticVisemes / smoothVisemes: the aa/ih/ou/ee/oh mouth shapes from the voice.
// - frameMode / shouldRender / FpsMeter: the frame budget (active 30 fps, idle 12 fps, paused when hidden).
// - blink, gaze, breathing helpers.
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

  // ---------- states → face + motion ----------
  // face: preset expression → weight 0..1. motion (all 0 when left out):
  //   nod (talking/eating nods), nodDown (head bowed, deg), tilt (head roll, deg), turn (looks about),
  //   gazeUp (eyes up), hop (jumps), sway (side to side), wobble, shake (angry shiver), spin (turns round),
  //   armsOut (+ out from the sides, − tucked in), armsUp (raised), wave (one arm), dangle (lifted: limbs
  //   hang and swing), stride (walking), chew (mouth opens and shuts), open (mouth held open), slump (spine
  //   bends forward), flinch (leans back), lean (deg, + back), slow (sleepy breathing), wink, pop (hatch).
  const STATE_LOOKS = {
    idle: { face: {}, motion: {} },
    look: { face: {}, motion: { turn: 1 } },
    happy: { face: { happy: 0.85 }, motion: { hop: 0.6, armsOut: 0.5 } },
    pat: { face: { relaxed: 0.7, happy: 0.4 }, motion: { nodDown: 9, tilt: 8, armsOut: -0.2 } },
    sad: { face: { sad: 0.9 }, motion: { nodDown: 12, slump: 0.6, armsOut: -0.4 } },
    hungry: { face: { sad: 0.45 }, motion: { open: 0.25, wobble: 0.6, slump: 0.3, armsOut: -0.3 } },
    sleep: { face: { blink: 1, relaxed: 0.3 }, motion: { nodDown: 16, tilt: 9, slow: 1, slump: 0.4, armsOut: -0.3 } },
    eat_rice: { face: { happy: 0.7 }, motion: { chew: 1, nod: 1, armsOut: 0.2 } },
    eat_cookie: { face: { happy: 0.7 }, motion: { chew: 1, nod: 1, armsOut: 0.2 } },
    eat_fruit: { face: { happy: 0.7 }, motion: { chew: 1, nod: 1, armsOut: 0.2 } },
    think: { face: { neutral: 0.3 }, motion: { gazeUp: 1, tilt: -10, armsOut: -0.1 } },
    talk: { face: { happy: 0.2 }, motion: { nod: 0.4, armsOut: 0.15 } },
    play: { face: { happy: 1 }, motion: { hop: 0.8, spin: 1, sway: 0.6, armsOut: 0.8 } },
    hatch: { face: { surprised: 0.8 }, motion: { pop: 1, wave: 1, armsOut: 0.3 } },
    evolve: { face: { happy: 1, surprised: 0.3 }, motion: { hop: 1.4, armsUp: 1 } },
    lifted: { face: { surprised: 0.9 }, motion: { dangle: 1, armsOut: 0.6, open: 0.3 } },
    walk: { face: { happy: 0.25 }, motion: { stride: 1 } },
  };
  // a touch on a body part (core/touch-zones.js ZONES), then the mood it put her in
  const TOUCH_LOOKS = {
    head: { face: { relaxed: 0.8, happy: 0.4 }, motion: { nodDown: 10, tilt: 8 } },
    face: { face: { happy: 0.7, blinkRight: 1 }, motion: { tilt: -7, wink: 1 } },
    chest: { face: { surprised: 1, angry: 0.2 }, motion: { flinch: 1, armsOut: -0.7, open: 0.3 } },
    hands: { face: { happy: 0.8 }, motion: { wave: 1, armsOut: 0.3 } },
    belly: { face: { happy: 1 }, motion: { wobble: 1, slump: 0.3 } },
    butt: { face: { surprised: 1, angry: 0.3 }, motion: { hop: 1.2, armsOut: 0.8, open: 0.4 } },
    legs: { face: { sad: 0.3, surprised: 0.3 }, motion: { nodDown: 6, armsOut: -0.4 } },
    feet: { face: { happy: 1 }, motion: { wobble: 1, hop: 0.4 } },
    tail: { face: { surprised: 0.7 }, motion: { sway: 1, open: 0.2 } },
  };
  const MOOD_LOOKS = {
    angry: { face: { angry: 1 }, motion: { shake: 1, armsOut: 0.4, lean: -4 } },
    annoyed: { face: { angry: 0.5, sad: 0.2 }, motion: { tilt: -5, armsOut: -0.2 } },
  };
  const MOTIONS = ['nod', 'nodDown', 'tilt', 'turn', 'gazeUp', 'hop', 'sway', 'wobble', 'shake', 'spin', 'armsOut', 'armsUp', 'wave', 'dangle', 'stride', 'chew', 'open', 'slump', 'flinch', 'lean', 'slow', 'wink', 'pop'];

  // States she rests in for minutes or hours (core/pet-state.js currentStatus, and the idle chain's looking
  // about): they do not keep the frame rate up. Every other state is a reaction, a cue or an activity.
  const RESTING = ['idle', 'look', 'happy', 'sad', 'hungry', 'sleep'];
  const isResting = (state) => RESTING.includes(String(state || 'idle'));
  // The repeating moves (hops, turns, sways…) a look keeps while she idles at the low frame rate: none — the
  // face and posture stay (a happy face, a bowed head), the bouncing stops, so 12 fps never looks choppy.
  const REPEATING = ['hop', 'sway', 'wobble', 'shake', 'spin', 'stride', 'dangle', 'wave', 'chew', 'nod', 'turn'];
  function calm(look) {
    const motion = { ...look.motion };
    for (const k of REPEATING) delete motion[k];
    return { face: look.face, motion };
  }

  // The look for a state ('touch-head' and the like included), with the touch mood (angry / annoyed) winning.
  function lookFor(state, mood) {
    const s = String(state || 'idle');
    if (s.startsWith('touch-')) return (mood && MOOD_LOOKS[mood]) || TOUCH_LOOKS[s.slice(6)] || STATE_LOOKS.pat;
    return STATE_LOOKS[s] || STATE_LOOKS.idle;
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

  // ---------- breathing ----------
  // Spine and chest pitch (deg) and a shoulder lift for time t; `slow` 0..1 is sleep's deeper, slower breath.
  function breath(t, slow = 0) {
    const f = slow > 0.5 ? 1.3 : 2.2;
    const b = Math.sin(t * f);
    const amp = 1 + slow * 0.8;
    return { spine: b * 0.8 * amp, chest: b * 1.4 * amp, shoulder: Math.max(0, b) * 1.2 * amp, k: b };
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

  // ---------- the body: motion → bone rotations ----------
  // Degrees on the normalized humanoid bones (x pitch + forward, y yaw, z roll), VRM 1.0 axes: the model
  // faces +Z, her left is +X. Arms rest down from the T-pose (upper arms rolled ±ARM_DOWN). `root`: lift
  // (share of her height), x / z offset (share), yaw (deg) and roll (deg) of the whole body.
  const ARM_DOWN = 72;
  function pose(m, t, st, { swing = 0, breathK = null, talking = false } = {}) {
    const g = (k) => m[k] || 0;
    const b = breathK || breath(t, g('slow'));
    const hopPh = (t * 1.6) % 1;
    const hop = g('hop') * Math.max(0, Math.sin(hopPh * Math.PI));
    const stepPh = t * Math.PI * 2 * 2;
    const stride = g('stride');
    const turn = g('turn') * Math.sin(st * 1.3) * 25;
    const nod = g('nod') * Math.sin(t * (talking ? 5 : 8)) * 5;
    const sway = g('sway') * Math.sin(t * 3.2) * 8;
    const wobble = g('wobble') * Math.sin(t * 7) * 6;
    const shake = g('shake') * Math.sin(t * 38) * 2;
    // play: one full turn every 3 s, taking 0.9 s
    const spinPh = (st % 3) / 0.9;
    const spin = g('spin') > 0.05 && spinPh < 1 ? (1 - Math.cos(spinPh * Math.PI)) * 180 * Math.min(1, g('spin')) : 0;
    const dangle = g('dangle');
    const flail = dangle * Math.sin(t * 11) * 14;
    const pend = dangle * Math.sin(t * 2.2) * 6 + swing * 8 * dangle;
    const armOut = g('armsOut') * 30 + g('armsUp') * 70;
    const armSwing = stride * Math.sin(stepPh) * 25;
    const waveK = g('wave') * (0.55 + 0.45 * Math.sin(t * 7));
    const slump = g('slump') * 10;
    const flinch = g('flinch') * 10;
    const R = {
      hips: { x: 0, y: turn * 0.3, z: sway * 0.4 + wobble * 0.4 + pend },
      spine: { x: b.spine + slump * 0.5 - flinch * 0.6 - g('lean') * 0.5, y: turn * 0.2, z: wobble * 0.3 + shake },
      chest: { x: b.chest + slump * 0.5 - flinch * 0.4, y: 0, z: sway * 0.3 },
      neck: { x: g('nodDown') * 0.4 + nod * 0.5, y: turn * 0.25, z: g('tilt') * 0.3 },
      head: { x: g('nodDown') * 0.6 + nod * 0.5 - g('gazeUp') * 10 - flinch * 0.3, y: turn * 0.35, z: g('tilt') * 0.7 + Math.sin(t * 0.8) * 1.5 + wobble * 0.5 },
      // left arm points +X: rolling it −z lowers it; right arm points −X: +z lowers it
      leftUpperArm: { x: armSwing, y: 0, z: -ARM_DOWN + armOut + flail - b.shoulder },
      rightUpperArm: { x: -armSwing, y: 0, z: ARM_DOWN - armOut - flail + b.shoulder - waveK * 95 },
      leftLowerArm: { x: 0, y: -g('armsUp') * 10, z: 0 },
      rightLowerArm: { x: 0, y: waveK * 40, z: -waveK * 30 },
      leftUpperLeg: { x: -stride * Math.sin(stepPh) * 22 + dangle * Math.sin(t * 6) * 18, y: 0, z: dangle * 4 },
      rightUpperLeg: { x: stride * Math.sin(stepPh) * 22 - dangle * Math.sin(t * 6 + 1) * 18, y: 0, z: -dangle * 4 },
      leftLowerLeg: { x: stride * Math.max(0, Math.sin(stepPh)) * 25 + dangle * (12 + Math.sin(t * 6) * 10), y: 0, z: 0 },
      rightLowerLeg: { x: stride * Math.max(0, -Math.sin(stepPh)) * 25 + dangle * (12 + Math.sin(t * 6 + 1) * 10), y: 0, z: 0 },
    };
    const root = {
      lift: hop * 0.08 + stride * Math.abs(Math.sin(stepPh)) * 0.012,
      x: shake * 0.004,
      yaw: spin,
      roll: clamp(-swing * 4 + wobble * 0.3 + sway * 0.3, -14, 14) * (dangle > 0.5 ? 1.6 : 1),
    };
    return { bones: R, root };
  }

  // With an idle animation (pack vrm.idle, a .vrma) the clip owns her standing pose: the app's moves are laid
  // on top as offsets from the rest pose (arms down, nothing moving), so a nod is still a nod and the arms are
  // not lowered twice. Breathing is the clip's then (pass breathK zero to pose()).
  const NO_BREATH = { spine: 0, chest: 0, shoulder: 0 };
  const REST = pose({}, 0, 0, { breathK: NO_BREATH }).bones;
  function poseOffsets(bones) {
    const out = {};
    for (const [name, r] of Object.entries(bones)) {
      const z = REST[name] || { x: 0, y: 0, z: 0 };
      out[name] = { x: r.x - z.x, y: r.y - z.y, z: r.z - z.z };
    }
    return out;
  }

  // The mouth a motion adds (chewing, held open), as aa weight.
  function motionMouth(m, t) {
    const chew = (m.chew || 0) * Math.max(0, Math.sin(t * 9)) * 0.7;
    const open = (m.open || 0) * (0.85 + 0.15 * Math.sin(t * 5));
    return clamp(Math.max(chew, open), 0, 1);
  }

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
    NO_BREATH, poseOffsets, PRESETS, EMOTIONS, VISEMES, STATE_LOOKS, TOUCH_LOOKS, MOOD_LOOKS, MOTIONS, FACE_FALLBACK, RESTING, isResting, REPEATING, calm, lookFor, expressionFor, resolveFace,
    BLINK_MS, nextBlinkIn, blinkWeight, breath, screenToClient, gazeNdc, ARM_DOWN, pose, motionMouth,
    zeroVisemes, band, visemesFromSpectrum, syntheticVisemes, smoothVisemes, BUDGET, frameMode, shouldRender, FpsMeter,
  };
});
