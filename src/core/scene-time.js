'use strict';
// 像素小院 · 时间系统 (docs/pixel-scene-design.md §5). Scene time is a continuous hour 0–24 (18.5 = 18:30).
// Six keyframes give the sky, the ambient light (a colour multiplied over the whole picture with strength
// ambientK), the shadow strength, the sun's angle and how bright the lamps are; any hour in between is
// interpolated (smoothstep, colours in linear RGB) and then quantised (ambientK in 8 steps), so dragging the
// slider changes the picture step by step like pixel art, not as a smooth gradient.
// Pure and DOM-free: the scene page loads it as a <script> (window.SceneTime), the tests through require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SceneTime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // The four named phases (chips under the slider; ‹ › step through them). night wraps past midnight.
  const PHASES = [
    { id: 'dawn', name: '黎明', from: 4.5, to: 7.5, jump: 6 },
    { id: 'day', name: '白天', from: 7.5, to: 16.5, jump: 12 },
    { id: 'dusk', name: '黄昏', from: 16.5, to: 19.5, jump: 18 },
    { id: 'night', name: '夜晚', from: 19.5, to: 4.5, jump: 23 },
  ];
  const PHASE_IDS = PHASES.map((p) => p.id);

  // hour -> light. sunAngle null = no sun (no sun shadows). lights 0–1 = lamps / windows / fireflies.
  const KEYFRAMES = [
    { t: 0, skyTop: '#0b1426', skyBottom: '#15233a', ambient: '#3a4f7a', ambientK: 0.62, shadowAlpha: 0.1, sunAngle: null, lights: 1 },
    { t: 5.5, skyTop: '#2b2d55', skyBottom: '#c9796b', ambient: '#8a7aa8', ambientK: 0.4, shadowAlpha: 0.15, sunAngle: 200, lights: 0.6 },
    { t: 7.5, skyTop: '#7fb8e0', skyBottom: '#f4d9a6', ambient: '#ffe6c4', ambientK: 0.12, shadowAlpha: 0.3, sunAngle: 210, lights: 0 },
    { t: 12, skyTop: '#6fb6ff', skyBottom: '#bfe3ff', ambient: '#ffffff', ambientK: 0, shadowAlpha: 0.35, sunAngle: 270, lights: 0 },
    { t: 17.5, skyTop: '#ff9a5c', skyBottom: '#ffd08a', ambient: '#ffb27a', ambientK: 0.22, shadowAlpha: 0.3, sunAngle: 330, lights: 0.2 },
    { t: 19.5, skyTop: '#3a2f5c', skyBottom: '#7a4a6a', ambient: '#6a5a96', ambientK: 0.48, shadowAlpha: 0.15, sunAngle: null, lights: 0.9 },
  ];
  const AMBIENT_STEPS = 8;

  const wrapHour = (t) => {
    const n = Number(t);
    if (!Number.isFinite(n)) return 0;
    return ((n % 24) + 24) % 24;
  };
  const inPhase = (p, t) => (p.from < p.to ? t >= p.from && t < p.to : t >= p.from || t < p.to);
  const phaseOf = (t) => {
    const h = wrapHour(t);
    return (PHASES.find((p) => inPhase(p, h)) || PHASES[3]).id;
  };
  const phaseInfo = (id) => PHASES.find((p) => p.id === id) || null;
  // the local clock as an hour (followClock)
  const clockHour = (d = new Date()) => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  // 18.5 -> '18:30'
  const formatHour = (t) => {
    const m = Math.round(wrapHour(t) * 60) % (24 * 60);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  // ‹ › : the next / previous phase's representative hour
  function stepPhase(t, dir) {
    const i = PHASE_IDS.indexOf(phaseOf(t));
    const n = PHASES.length;
    return PHASES[(i + (dir < 0 ? n - 1 : 1)) % n].jump;
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smoothstep = (u) => { const x = clamp01(u); return x * x * (3 - 2 * x); };
  const lerp = (a, b, u) => a + (b - a) * u;
  const quantize = (v, steps = AMBIENT_STEPS) => Math.round(clamp01(v) * steps) / steps;

  function hexToRgb(hex) {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgbToHex = (rgb) => `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
  const toLinear = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const toSrgb = (l) => { const v = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; return clamp01(v) * 255; };
  // colour interpolation in linear RGB (no grey middle), hex in, hex out
  function lerpLinearRGB(a, b, u) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    return rgbToHex(A.map((c, i) => toSrgb(lerp(toLinear(c), toLinear(B[i]), u))));
  }

  // the two keyframes around `t` on the 24 h ring and how far between them (0–1)
  function bracket(t) {
    const h = wrapHour(t);
    const K = KEYFRAMES;
    for (let i = 0; i < K.length; i++) {
      const a = K[i];
      const b = K[(i + 1) % K.length];
      const bt = i + 1 < K.length ? b.t : b.t + 24;
      if (h >= a.t && h < bt) return { a, b, u: (h - a.t) / (bt - a.t) };
    }
    const a = K[K.length - 1];
    return { a, b: K[0], u: (h - a.t) / (24 - a.t) };
  }

  // hour -> the light of that hour. ambientK is quantised (AMBIENT_STEPS); ambientKRaw is not.
  function lightAt(t) {
    const h = wrapHour(t);
    const { a, b, u: raw } = bracket(h);
    const u = smoothstep(raw);
    const k = lerp(a.ambientK, b.ambientK, u);
    let sunAngle = null;
    if (a.sunAngle !== null && b.sunAngle !== null) sunAngle = Math.round(lerp(a.sunAngle, b.sunAngle, u) / 15) * 15;
    else if (a.sunAngle !== null && u < 0.5) sunAngle = a.sunAngle;
    else if (b.sunAngle !== null && u >= 0.5) sunAngle = b.sunAngle;
    return {
      hour: h,
      phase: phaseOf(h),
      skyTop: lerpLinearRGB(a.skyTop, b.skyTop, u),
      skyBottom: lerpLinearRGB(a.skyBottom, b.skyBottom, u),
      ambient: lerpLinearRGB(a.ambient, b.ambient, u),
      ambientKRaw: k,
      ambientK: quantize(k),
      shadowAlpha: lerp(a.shadowAlpha, b.shadowAlpha, u),
      sunAngle,
      lights: clamp01(lerp(a.lights, b.lights, u)),
    };
  }

  // First-order approach to a target (transitions): cur moves toward target, `tau` seconds time constant.
  const approach = (cur, target, dt, tau) => (tau <= 0 ? target : cur + (target - cur) * (1 - Math.exp(-Math.max(0, dt) / tau)));
  // the same for an hour on the 24 h ring (the short way round, so 23 -> 1 goes through midnight)
  function approachHour(cur, target, dt, tau) {
    let d = wrapHour(target) - wrapHour(cur);
    if (d > 12) d -= 24;
    if (d < -12) d += 24;
    return wrapHour(wrapHour(cur) + approach(0, d, dt, tau));
  }

  return { PHASES, PHASE_IDS, KEYFRAMES, AMBIENT_STEPS, wrapHour, phaseOf, phaseInfo, clockHour, formatHour, stepPhase, smoothstep, quantize, hexToRgb, rgbToHex, lerpLinearRGB, lightAt, approach, approachHour };
});
