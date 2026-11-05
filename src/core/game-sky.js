'use strict';
// 小游戏 · 天色（时段 + 天气）(docs/mini-games.md §5). The whole picture is colour-graded, not repainted: an hour
// gives a grade (per-channel multiply, saturation, a little lift) taken between keyframes, the weather multiplies
// in its own, and the page turns that into one colour-matrix filter over the world. On top come the lights
// (windows, lamps: 0 by day, 1 at night), fireflies (night only) and the weather's clouds / rain / snow / fog.
// Time either stands where it is set, flows (one game day = DAY_MINUTES real minutes, like the video's
// "One farm day lasts 24 minutes") or follows this computer's clock.
// Pure and DOM-free (window.GameSky in the page, require() in the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameSky = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY_MINUTES = 24;
  const PHASES = [
    { id: 'dawn', name: '清晨', from: 4.5, to: 9, jump: 7 },
    { id: 'day', name: '白天', from: 9, to: 16.5, jump: 12 },
    { id: 'dusk', name: '黄昏', from: 16.5, to: 19.5, jump: 18 },
    { id: 'night', name: '夜晚', from: 19.5, to: 4.5, jump: 23 },
  ];
  const PHASE_IDS = PHASES.map((p) => p.id);
  const WEATHERS = [
    { id: 'clear', name: '晴朗', mul: [1, 1, 1], sat: 1, lift: 0, clouds: 0, rain: 0, snow: 0, fog: 0, flash: 0 },
    { id: 'cloudy', name: '多云', mul: [0.9, 0.92, 0.95], sat: 0.9, lift: 0, clouds: 0.7, rain: 0, snow: 0, fog: 0, flash: 0 },
    { id: 'rain', name: '小雨', mul: [0.78, 0.82, 0.88], sat: 0.8, lift: 0, clouds: 1, rain: 0.6, snow: 0, fog: 0.08, flash: 0 },
    { id: 'storm', name: '雷雨', mul: [0.62, 0.66, 0.76], sat: 0.72, lift: 0, clouds: 1, rain: 1, snow: 0, fog: 0.1, flash: 1 },
    { id: 'snow', name: '下雪', mul: [0.9, 0.96, 1.08], sat: 0.55, lift: 0.1, clouds: 0.8, rain: 0, snow: 0.8, fog: 0.06, flash: 0 },
    { id: 'fog', name: '起雾', mul: [0.94, 0.96, 0.98], sat: 0.75, lift: 0.03, clouds: 0.3, rain: 0, snow: 0, fog: 0.55, flash: 0 },
  ];
  const WEATHER_IDS = WEATHERS.map((w) => w.id);
  // hour → grade. mul: channel multiply (1 = as painted), sat: saturation, lift: added light (fog / snow glare),
  // lights: how lit windows and lamps are, flies: how many fireflies are out, sun: the card icon's sun height
  // (-1 below the horizon … 1 at noon)
  const KEYS = [
    { t: 0, mul: [0.36, 0.48, 0.56], sat: 0.72, lift: 0, lights: 1, flies: 1 },
    { t: 4.5, mul: [0.42, 0.5, 0.6], sat: 0.72, lift: 0, lights: 1, flies: 0.6 },
    { t: 6, mul: [0.86, 0.74, 0.72], sat: 0.85, lift: 0.02, lights: 0.5, flies: 0 },
    { t: 7.5, mul: [1.06, 0.98, 0.8], sat: 1.02, lift: 0.02, lights: 0, flies: 0 },
    { t: 12, mul: [1.02, 1.02, 1], sat: 1.14, lift: 0, lights: 0, flies: 0 },
    { t: 16, mul: [1.03, 0.94, 0.78], sat: 1.04, lift: 0, lights: 0, flies: 0 },
    { t: 18, mul: [0.94, 0.72, 0.44], sat: 0.92, lift: 0, lights: 0.4, flies: 0 },
    { t: 19.5, mul: [0.56, 0.56, 0.7], sat: 0.8, lift: 0, lights: 0.9, flies: 0.4 },
    { t: 21, mul: [0.38, 0.5, 0.58], sat: 0.72, lift: 0, lights: 1, flies: 1 },
  ];

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const lerp = (a, b, u) => a + (b - a) * u;
  const smooth = (u) => { const x = clamp01(u); return x * x * (3 - 2 * x); };
  const wrapHour = (t) => { const n = Number(t); return Number.isFinite(n) ? ((n % 24) + 24) % 24 : 0; };
  const inPhase = (p, h) => (p.from < p.to ? h >= p.from && h < p.to : h >= p.from || h < p.to);
  const phaseOf = (t) => (PHASES.find((p) => inPhase(p, wrapHour(t))) || PHASES[3]).id;
  const phaseName = (id) => (PHASES.find((p) => p.id === id) || PHASES[1]).name;
  const weatherOf = (id) => WEATHERS.find((w) => w.id === id) || WEATHERS[0];
  const clockHour = (d = new Date()) => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  const formatHour = (t) => {
    const m = Math.floor(wrapHour(t) * 60 + 1e-6) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  // ‹ › on the card: the next / previous phase's own hour
  function stepPhase(t, dir) {
    const i = PHASE_IDS.indexOf(phaseOf(t));
    const n = PHASES.length;
    return PHASES[(i + (dir < 0 ? n - 1 : 1)) % n].jump;
  }
  function stepWeather(id, dir) {
    const i = Math.max(0, WEATHER_IDS.indexOf(id));
    const n = WEATHER_IDS.length;
    return WEATHER_IDS[(i + (dir < 0 ? n - 1 : 1)) % n];
  }
  // game hours that pass in `seconds` real seconds while time flows
  const flowHours = (seconds, dayMinutes = DAY_MINUTES) => (seconds / (dayMinutes * 60)) * 24;
  // the shortest way round the clock from a to b (−12 … 12): a phase jump eases the short way
  const hourDelta = (a, b) => { const d = wrapHour(b) - wrapHour(a); return d > 12 ? d - 24 : d < -12 ? d + 24 : d; };

  function keyBracket(h) {
    for (let i = 0; i < KEYS.length; i++) {
      const a = KEYS[i];
      const b = KEYS[(i + 1) % KEYS.length];
      const bt = i + 1 < KEYS.length ? b.t : b.t + 24;
      if (h >= a.t && h < bt) return { a, b, u: (h - a.t) / (bt - a.t) };
    }
    return { a: KEYS[KEYS.length - 1], b: KEYS[0], u: 0 };
  }

  // the grade of an hour alone (clear weather)
  function timeGrade(t) {
    const h = wrapHour(t);
    const { a, b, u: raw } = keyBracket(h);
    const u = smooth(raw);
    const sunU = (h - 6) / 12; // 06:00 rise … 18:00 set
    return {
      hour: h,
      phase: phaseOf(h),
      mul: a.mul.map((v, i) => lerp(v, b.mul[i], u)),
      sat: lerp(a.sat, b.sat, u),
      lift: lerp(a.lift, b.lift, u),
      lights: lerp(a.lights, b.lights, u),
      flies: lerp(a.flies, b.flies, u),
      sun: sunU >= 0 && sunU <= 1 ? Math.sin(sunU * Math.PI) : -Math.min(1, Math.abs(sunU < 0 ? sunU : sunU - 1) * 4),
    };
  }

  // two weathers mixed (k: 0 = all `from`, 1 = all `to`) — a change fades in over FADE_S seconds
  const FADE_S = 3;
  function mixWeather(fromId, toId, k) {
    const A = weatherOf(fromId);
    const B = weatherOf(toId);
    const u = smooth(k);
    const out = { id: u < 0.5 ? A.id : B.id };
    for (const key of ['sat', 'lift', 'clouds', 'rain', 'snow', 'fog', 'flash']) out[key] = lerp(A[key], B[key], u);
    out.mul = A.mul.map((v, i) => lerp(v, B.mul[i], u));
    return out;
  }

  // the final grade: the hour's times the weather's (lights come on earlier when it is dark with rain)
  function grade(t, weather) {
    const g = timeGrade(t);
    const w = weather && weather.mul ? weather : mixWeather('clear', (weather && weather.id) || 'clear', 1);
    const mul = g.mul.map((v, i) => v * w.mul[i]);
    const dim = 1 - (w.mul[0] + w.mul[1] + w.mul[2]) / 3;
    return {
      ...g,
      mul,
      sat: g.sat * w.sat,
      lift: g.lift + w.lift,
      lights: clamp01(g.lights + (g.phase === 'dusk' || g.phase === 'dawn' ? dim * 1.5 : 0)),
      flies: g.flies * (1 - Math.min(1, Math.max(w.rain, w.snow) * 1.7)) * (1 - w.fog * 0.5),
      weather: w,
    };
  }

  // the 4×5 colour matrix (PIXI.ColorMatrixFilter.matrix order) for a grade: saturation around Rec.709 luma,
  // then the channel multiply, then the lift
  function gradeMatrix(g) {
    const s = g.sat;
    const lr = 0.2126 * (1 - s);
    const lg = 0.7152 * (1 - s);
    const lb = 0.0722 * (1 - s);
    const S = [
      [lr + s, lg, lb],
      [lr, lg + s, lb],
      [lr, lg, lb + s],
    ];
    const m = [];
    for (let r = 0; r < 3; r++) m.push(S[r][0] * g.mul[r], S[r][1] * g.mul[r], S[r][2] * g.mul[r], 0, g.lift);
    m.push(0, 0, 0, 1, 0);
    return m;
  }

  // weather that changes by itself: a few minutes each, mostly to a neighbour of the current one
  const NEXT = { clear: ['cloudy', 'cloudy', 'fog'], cloudy: ['clear', 'rain', 'snow', 'clear'], rain: ['cloudy', 'storm', 'cloudy'], storm: ['rain'], snow: ['cloudy', 'clear'], fog: ['clear', 'cloudy'] };
  const AUTO_MIN_S = 180;
  const AUTO_MAX_S = 480;
  const autoDelay = (rnd = Math.random) => AUTO_MIN_S + rnd() * (AUTO_MAX_S - AUTO_MIN_S);
  const nextWeather = (id, rnd = Math.random) => { const opts = NEXT[id] || NEXT.clear; return opts[Math.floor(rnd() * opts.length) % opts.length]; };

  return { DAY_MINUTES, PHASES, PHASE_IDS, WEATHERS, WEATHER_IDS, FADE_S, AUTO_MIN_S, AUTO_MAX_S, wrapHour, phaseOf, phaseName, weatherOf, clockHour, formatHour, stepPhase, stepWeather, flowHours, hourDelta, timeGrade, mixWeather, grade, gradeMatrix, autoDelay, nextWeather };
});
