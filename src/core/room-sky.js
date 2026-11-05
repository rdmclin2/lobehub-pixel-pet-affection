'use strict';
// 房间小游戏 · 窗外的天色 (docs/room.md §5): the room uses the same time and weather as 像素小院 (core/game-sky.js,
// settings.scene, shared by every mini game). What is outside the window gets the whole grade; inside, the room
// gets part of it (the lamps are on at night, so the room never goes as dark as the sky), the lamps glow with
// the grade's `lights`, and the sun or the moon crosses the window. She says a line about the weather or the hour.
// Pure and DOM-free (imported by the console page, require() in the tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RoomSky = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // how much of the outside grade reaches the room (0 = none, 1 = as dark as the sky)
  const INSIDE = 0.5;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const wrapHour = (t) => { const n = Number(t); return Number.isFinite(n) ? ((n % 24) + 24) % 24 : 0; };

  // the room's grade: the outside grade moved towards "as painted" (mul 1, sat 1, no lift)
  function inside(g, k = INSIDE) {
    return {
      mul: g.mul.map((v) => 1 + (v - 1) * k),
      sat: 1 + (g.sat - 1) * k,
      lift: g.lift * k,
    };
  }

  const brightness = (g) => (g.mul[0] + g.mul[1] + g.mul[2]) / 3;

  // the sun from 06:00 to 18:00, the moon from 18:00 to 06:00: `u` across the window (0 = left … 1 = right),
  // `up` its height (0 = on the horizon … 1 = at the top of its arc)
  function body(hour) {
    const h = wrapHour(hour);
    const sun = h >= 6 && h < 18;
    const u = sun ? (h - 6) / 12 : (((h - 18) + 24) % 24) / 12;
    return { kind: sun ? 'sun' : 'moon', u, up: Math.sin(u * Math.PI) };
  }

  // the stars: out when the sky is dark, hidden behind clouds and fog
  function stars(g) {
    const w = g.weather || {};
    return clamp01((0.72 - brightness(g)) / 0.3) * (1 - (w.clouds || 0) * 0.85) * (1 - (w.fog || 0));
  }

  // her line about the sky: the weather first (rain, snow …), else the hour (dawn, dusk, night), else none
  function lineFor(lines, phase, weatherId) {
    if (!lines) return null;
    const pick = (v) => (Array.isArray(v) ? v[0] || null : v || null);
    return pick(lines[weatherId]) || pick(lines[phase]) || null;
  }

  // a quarter hour the settings accept (scene.hour: 0 … 23.75, step 0.25)
  const quarter = (t) => (Math.round(wrapHour(t) * 4) / 4) % 24;

  return { INSIDE, inside, brightness, body, stars, lineFor, quarter };
});
