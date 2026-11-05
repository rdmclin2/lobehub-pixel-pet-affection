'use strict';
// 像素小院 · 天气系统 (docs/pixel-scene-design.md §6). Each weather is a parameter set: clouds, a particle
// kind (rain lines / snow flakes) and how many per screen (320×200 logical px, whatever the window size), a tint
// laid over the time-of-day light (ambientK added, a colour multiplied), shadow strength and fireflies at night.
// A change of weather fades the old one out and the new one in (intensity 0→1 over FADE_S); particles are added
// and removed gradually, never all at once. 「天气自己变」 picks the next weather from a Markov table.
// Pure and DOM-free (window.SceneWeather in the page, require() in the tests); the random source is injected.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SceneWeather = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const W = 320;
  const H = 200;
  const FADE_S = 3;

  const WEATHERS = {
    clear: { id: 'clear', name: '晴', clouds: { count: 1, speed: 4, day: '#f4f8ff', night: '#5a6680' }, particle: null, count: 0, tint: { color: '#ffffff', k: 0 }, shadowMul: 1, fireflies: 12, lightning: false },
    cloudy: { id: 'cloudy', name: '多云', clouds: { count: 6, speed: 6, day: '#d8dde6', night: '#4a5470' }, particle: null, count: 0, tint: { color: '#c8ccd4', k: 0.1 }, shadowMul: 0.5, fireflies: 6, lightning: false },
    rain: { id: 'rain', name: '小雨', clouds: { count: 8, speed: 8, day: '#8a93a3', night: '#252b38' }, particle: 'rain', count: 160, speed: 180, angle: 12, tint: { color: '#9aa8c0', k: 0.18 }, shadowMul: 0.3, fireflies: 0, lightning: false },
    snow: { id: 'snow', name: '雪', clouds: { count: 5, speed: 4, day: '#e3e8ef', night: '#3a4254' }, particle: 'snow', count: 120, speed: 24, angle: 0, tint: { color: '#dfe8f5', k: 0.06 }, shadowMul: 0.6, fireflies: 0, lightning: false },
    storm: { id: 'storm', name: '雷雨', clouds: { count: 10, speed: 12, day: '#4a505c', night: '#161a22' }, particle: 'rain', count: 260, speed: 260, angle: 20, tint: { color: '#7d8aa3', k: 0.28 }, shadowMul: 0.15, fireflies: 0, lightning: true },
    fog: { id: 'fog', name: '雾', clouds: { count: 0, speed: 3, day: '#dfe6e8', night: '#3c4448' }, particle: null, count: 0, tint: { color: '#dfe6e8', k: 0.05 }, shadowMul: 0.4, fireflies: 2, lightning: false, fog: 0.25 },
  };
  const WEATHER_IDS = Object.keys(WEATHERS);

  // 天气自己变: rows are "from", each row sums to 1 (snow only in Nov–Feb; otherwise its share goes to cloudy)
  const TRANSITIONS = {
    clear: { clear: 0.55, cloudy: 0.3, rain: 0.05, snow: 0.03, storm: 0, fog: 0.07 },
    cloudy: { clear: 0.3, cloudy: 0.35, rain: 0.2, snow: 0.07, storm: 0.03, fog: 0.05 },
    rain: { clear: 0.1, cloudy: 0.4, rain: 0.35, snow: 0, storm: 0.15, fog: 0 },
    snow: { clear: 0.15, cloudy: 0.35, rain: 0, snow: 0.5, storm: 0, fog: 0 },
    storm: { clear: 0, cloudy: 0.3, rain: 0.7, snow: 0, storm: 0, fog: 0 },
    fog: { clear: 0.5, cloudy: 0.4, rain: 0, snow: 0, storm: 0, fog: 0.1 },
  };
  const AUTO_MIN_S = 8 * 60;
  const AUTO_MAX_S = 20 * 60;
  const snowSeason = (month) => month === 10 || month === 11 || month === 0 || month === 1; // Date#getMonth()

  const weatherOf = (id) => WEATHERS[id] || WEATHERS.clear;

  // the probabilities out of `cur` this month
  function transitionRow(cur, { month = 0 } = {}) {
    const row = { ...(TRANSITIONS[cur] || TRANSITIONS.clear) };
    if (!snowSeason(month)) { row.cloudy += row.snow; row.snow = 0; }
    return row;
  }
  // the next weather, from a random number in [0, 1)
  function nextWeather(cur, rnd = Math.random, opts = {}) {
    const row = transitionRow(cur, opts);
    let r = rnd();
    for (const id of WEATHER_IDS) {
      r -= row[id];
      if (r < 0) return id;
    }
    return WEATHER_IDS.filter((id) => row[id] > 0).pop() || 'clear';
  }
  const autoDelay = (rnd = Math.random) => AUTO_MIN_S + (AUTO_MAX_S - AUTO_MIN_S) * rnd();

  const lerp = (a, b, k) => a + (b - a) * k;
  const hex = (c) => { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const mixHex = (a, b, k) => `#${hex(a).map((v, i) => Math.round(lerp(v, hex(b)[i], k)).toString(16).padStart(2, '0')).join('')}`;

  // The weather on screen while `from` fades into `to` (k = to's intensity, 0–1): tint, shadow, fireflies and
  // the cloud / particle targets blended.
  function mixWeather(from, to, k) {
    const a = weatherOf(from);
    const b = weatherOf(to);
    const t = Math.max(0, Math.min(1, k));
    return {
      from: a.id,
      to: b.id,
      k: t,
      tint: { color: mixHex(a.tint.color, b.tint.color, t), k: lerp(a.tint.k, b.tint.k, t) },
      shadowMul: lerp(a.shadowMul, b.shadowMul, t),
      fireflies: Math.round(lerp(a.fireflies, b.fireflies, t)),
      clouds: Math.round(lerp(a.clouds.count, b.clouds.count, t)),
      fog: lerp(a.fog || 0, b.fog || 0, t),
      lightning: b.lightning && t > 0.5,
      // particle targets per kind: the fading one goes down while the new one comes up
      targets: { rain: Math.round((a.particle === 'rain' ? a.count * (1 - t) : 0) + (b.particle === 'rain' ? b.count * t : 0)), snow: Math.round((a.particle === 'snow' ? a.count * (1 - t) : 0) + (b.particle === 'snow' ? b.count * t : 0)) },
      rain: b.particle === 'rain' ? b : a.particle === 'rain' ? a : WEATHERS.rain,
    };
  }
  // how many particles of `weather` at intensity 0–1
  const spawnCount = (id, intensity) => Math.round(weatherOf(id).count * Math.max(0, Math.min(1, intensity)));

  // One particle: { kind, x, y, vx, vy, len|size, phase, splash }. Rain falls slanted left, snow drifts sideways.
  function spawn(kind, rnd, params, top = false) {
    if (kind === 'rain') {
      const sp = params.speed || 180;
      const a = ((params.angle || 12) * Math.PI) / 180;
      return { kind, x: rnd() * (W + 60), y: top ? -10 - rnd() * 40 : rnd() * H, vx: -Math.sin(a) * sp, vy: Math.cos(a) * sp * (0.85 + rnd() * 0.3), len: 4 + Math.floor(rnd() * 3), splash: 0 };
    }
    return { kind, x: rnd() * W, y: top ? -4 - rnd() * 30 : rnd() * H, vx: 0, vy: 18 + rnd() * 12, size: rnd() < 0.3 ? 2 : 1, phase: rnd() * Math.PI * 2, period: 2 + rnd() * 2 };
  }

  // Step every particle by dt seconds. targets: { rain, snow } (how many of each there should be); new ones are
  // added from the top at most `rate` per second, extra ones are dropped when they leave the screen, so a change
  // of weather builds up / clears gradually. Mutates and returns `list`. A raindrop reaching the ground leaves a
  // short splash (30 % of them); snow drifts on a sine.
  function stepParticles(list, dt, { targets = { rain: 0, snow: 0 }, rain = WEATHERS.rain, rate = 120 } = {}, rnd = Math.random) {
    const d = Math.max(0, Math.min(0.25, dt));
    const counts = { rain: 0, snow: 0 };
    for (const p of list) counts[p.kind] = (counts[p.kind] || 0) + 1;
    const out = [];
    for (const p of list) {
      if (p.kind === 'rain') {
        if (p.splash > 0) { p.splash -= d; if (p.splash > 0) out.push(p); else counts.rain--; continue; }
        p.x += p.vx * d;
        p.y += p.vy * d;
        if (p.y > H) {
          if (counts.rain > targets.rain) { counts.rain--; continue; }
          if (rnd() < 0.3) { p.splash = 0.12; p.y = H - 2 - Math.floor(rnd() * 120); out.push(p); continue; }
          Object.assign(p, spawn('rain', rnd, rain, true));
        }
        if (p.x < -10) p.x += W + 60;
        out.push(p);
      } else {
        p.phase += (d * Math.PI * 2) / p.period;
        p.y += p.vy * d;
        p.x += Math.cos(p.phase) * 4 * d * 1.5;
        // snow falls slowly: extra flakes melt away where they are (about 1.5 a second each) instead of
        // lingering for the 8 s it takes them to reach the ground
        if (counts.snow > targets.snow && rnd() < d * 1.5) { counts.snow--; continue; }
        if (p.y > H) {
          if (counts.snow > targets.snow) { counts.snow--; continue; }
          Object.assign(p, spawn('snow', rnd, {}, true));
        }
        if (p.x < 0) p.x += W;
        if (p.x >= W) p.x -= W;
        out.push(p);
      }
    }
    for (const kind of ['rain', 'snow']) {
      const want = targets[kind] || 0;
      const add = Math.min(want - counts[kind], Math.max(1, Math.ceil(rate * d)));
      for (let i = 0; i < add; i++) out.push(spawn(kind, rnd, kind === 'rain' ? rain : {}, false));
    }
    list.length = 0;
    list.push(...out);
    return list;
  }
  const countKinds = (list) => list.reduce((c, p) => { if (!(p.kind === 'rain' && p.splash > 0)) c[p.kind] = (c[p.kind] || 0) + 1; return c; }, { rain: 0, snow: 0 });

  return { W, H, FADE_S, WEATHERS, WEATHER_IDS, TRANSITIONS, AUTO_MIN_S, AUTO_MAX_S, weatherOf, transitionRow, nextWeather, autoDelay, mixWeather, spawnCount, spawn, stepParticles, countKinds };
});
