'use strict';
// 小游戏 · 天色卡片的大图标 (docs/mini-games.md §5.3): small dithered pixel pictures drawn on a 40×40 canvas in
// 2×2 blocks (a 20×20 grid) — a sun that sinks with the hour (a half sun on the horizon at sunrise / sunset), a
// moon at night, and a cloud with rain, snow, fog or a lightning bolt for the weather. Shading is ordered (Bayer)
// dithering between two tones, like the reference video's icons.
(function () {
  const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
  const G = 20;
  const px = (ctx, x, y, c) => { ctx.fillStyle = c; ctx.fillRect(x * 2, y * 2, 2, 2); };
  const dith = (x, y, v) => v * 16 > BAYER[y & 3][x & 3] + 0.5;

  // a lit sphere: tone by distance from the top-left highlight, dithered between light and shade
  function sphere(ctx, cx, cy, r, light, shade, clipY = G) {
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r * r || y >= clipY) continue;
      const hl = Math.hypot(dx + r * 0.45, dy + r * 0.45) / (r * 1.6);
      px(ctx, x, y, dith(x, y, 1 - hl) ? light : shade);
    }
  }
  function moon(ctx, light, shade) {
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const a = Math.hypot(x + 0.5 - 10, y + 0.5 - 10);
      const b = Math.hypot(x + 0.5 - 13.5, y + 0.5 - 7.5);
      if (a > 6.5 || b < 5.6) continue;
      px(ctx, x, y, dith(x, y, 0.85 - (a / 6.5) * 0.5) ? light : shade);
    }
  }
  function cloud(ctx, oy, light, shade) {
    const puffs = [[7, 9 + oy, 3.6], [11, 7.5 + oy, 4.4], [14.5, 10 + oy, 3.2], [10, 11 + oy, 3.4]];
    for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) {
      const inside = puffs.some(([cx, cy, r]) => Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r);
      if (!inside || y > 12 + oy) continue;
      px(ctx, x, y, dith(x, y, 1 - (y - 3 - oy) / 11) ? light : shade);
    }
  }
  // the dotted horizon under the sun / moon (the video's faint line of dots)
  function horizon(ctx, y, c) { for (let x = 3; x < 17; x += 2) px(ctx, x, y, c); }

  function timeIcon(canvas, grade) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 40, 40);
    const light = '#fbfaf2';
    const shade = 'rgba(214,214,206,0.9)';
    const dots = 'rgba(255,255,255,0.35)';
    if (grade.phase === 'night' || grade.sun < -0.15) {
      moon(ctx, light, shade);
      horizon(ctx, 17, dots);
      return;
    }
    // the sun stands higher the higher it is in the sky; near the horizon only its top shows
    const s = Math.max(-0.2, grade.sun);
    const cy = 15.5 - s * 6.5;
    sphere(ctx, 10, cy, 5.2, light, shade, 17);
    horizon(ctx, 17, dots);
  }

  function weatherIcon(canvas, id) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 40, 40);
    const light = '#fbfaf2';
    const shade = 'rgba(200,204,206,0.9)';
    const dots = 'rgba(255,255,255,0.35)';
    if (id === 'clear') { sphere(ctx, 10, 10, 5.4, light, shade); horizon(ctx, 17, dots); return; }
    cloud(ctx, id === 'cloudy' ? 2 : 0, light, shade);
    if (id === 'rain' || id === 'storm') for (let i = 0; i < 6; i++) { const x = 5 + i * 2; px(ctx, x, 15 + (i & 1), '#cfe3f2'); px(ctx, x - 1, 17 + (i & 1), '#cfe3f2'); }
    if (id === 'storm') [[11, 13], [10, 14], [11, 15], [10, 16], [9, 17]].forEach(([x, y]) => px(ctx, x, y, '#ffe27a'));
    if (id === 'snow') [[5, 15], [9, 16], [13, 15], [7, 18], [11, 18], [15, 17]].forEach(([x, y]) => px(ctx, x, y, '#ffffff'));
    if (id === 'fog') for (const y of [14, 16, 18]) for (let x = 3 + (y % 4); x < 17; x += 1) if ((x + y) % 3) px(ctx, x, y, 'rgba(255,255,255,0.6)');
    if (id === 'cloudy') horizon(ctx, 17, dots);
  }

  window.GameIcons = { timeIcon, weatherIcon };
})();
