'use strict';
// 她的房间 · 屏幕内容 (docs/illustrated-room.md §5, design §7). What her phone or laptop shows, drawn by the app into
// an offscreen 2D canvas the engine maps onto the screen's four corners (a PerspectiveMesh) and shows enlarged in
// the 屏幕 card. Nothing comes from the network: every kind is drawn here from the manifest's data.
//   clips    短视频: a vertical feed — each clip a looping animated scene (jellyfish, rain-window, hearts, city,
//            cat) or the pack's frames; it swipes up to the next one every 8–15 s (or on 下一个), with the like /
//            comment / share column, the author, the caption and the progress line
//   page     a browser: a document typed line by line as the round goes on, or a search page for 「搜一下 X」
//   player   正在播放: cover, title, artist, the progress bar and time, a spectrum
//   game     鲸鱼跳跳: a little side-scroller playing itself, with its score
//   lock     the lock screen: the time, the date, a notification
// window.ScreenContent.create(kind, opts) → { canvas, kind, update(dt, ctx) → redrawn?, brightness(), next(), info() }
(function (root) {
  const FONT = '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
  const TAU = Math.PI * 2;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  // a seeded random, so a clip looks the same every time it comes round
  const seeded = (seed) => { let a = seed >>> 0 || 1; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; };
  const font = (px, weight = 400) => `${weight} ${px}px ${FONT}`;
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function heart(g, x, y, s) {
    g.beginPath();
    g.moveTo(x, y + s * 0.3);
    g.bezierCurveTo(x, y, x - s * 0.5, y, x - s * 0.5, y + s * 0.3);
    g.bezierCurveTo(x - s * 0.5, y + s * 0.6, x, y + s * 0.8, x, y + s);
    g.bezierCurveTo(x, y + s * 0.8, x + s * 0.5, y + s * 0.6, x + s * 0.5, y + s * 0.3);
    g.bezierCurveTo(x + s * 0.5, y, x, y, x, y + s * 0.3);
    g.closePath();
  }

  // ---- 短视频的画面: each a loop of a few seconds, drawn at (w, h) ---------------------------------------------
  const SCENES = {
    jellyfish(g, w, h, t, rnd) {
      const bg = g.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#0a4a7a'); bg.addColorStop(0.55, '#062a52'); bg.addColorStop(1, '#020c22');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      // light from the surface
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const x = w * (0.15 + i * 0.18) + Math.sin(t * 0.4 + i) * 20;
        const ray = g.createLinearGradient(x, 0, x + 40, h * 0.7);
        ray.addColorStop(0, 'rgba(120,200,255,0.18)'); ray.addColorStop(1, 'rgba(120,200,255,0)');
        g.fillStyle = ray;
        g.beginPath(); g.moveTo(x - 14, 0); g.lineTo(x + 14, 0); g.lineTo(x + 70, h * 0.7); g.lineTo(x + 10, h * 0.7); g.fill();
      }
      const jelly = [[0.35, 0.38, 70, '#ff9ad5', 0], [0.68, 0.56, 48, '#9fe6ff', 1.7], [0.28, 0.72, 34, '#c7a6ff', 3.1]];
      for (const [fx, fy, r, col, ph] of jelly) {
        const pulse = 1 + Math.sin(t * 1.6 + ph) * 0.08;
        const x = w * fx + Math.sin(t * 0.35 + ph) * 18;
        const y = h * fy - ((t * 9 + ph * 30) % 60) * 0 + Math.sin(t * 0.8 + ph) * 14;
        // tentacles
        g.strokeStyle = col; g.globalAlpha = 0.55; g.lineWidth = 2;
        for (let k = 0; k < 7; k++) {
          g.beginPath();
          const x0 = x - r * 0.7 + (k * r * 1.4) / 6;
          g.moveTo(x0, y);
          for (let s = 1; s <= 12; s++) g.lineTo(x0 + Math.sin(t * 2 + k + s * 0.5) * 6, y + s * r * 0.18);
          g.stroke();
        }
        g.globalAlpha = 1;
        const bell = g.createRadialGradient(x, y - r * 0.3, 2, x, y, r * pulse);
        bell.addColorStop(0, 'rgba(255,255,255,0.95)'); bell.addColorStop(0.35, col); bell.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = bell;
        g.beginPath(); g.ellipse(x, y, r * pulse, r * 0.75 / pulse, 0, Math.PI, TAU); g.fill();
        g.beginPath(); g.ellipse(x, y, r * pulse, r * 0.18, 0, 0, Math.PI); g.fill();
      }
      g.fillStyle = 'rgba(200,240,255,0.7)';
      for (let i = 0; i < 40; i++) { const px = (rnd() * w + t * 6) % w; const py = (rnd() * h - t * (8 + i % 5 * 3) + h * 10) % h; g.fillRect(px, py, 1.5, 1.5); }
      g.globalCompositeOperation = 'source-over';
    },
    'rain-window'(g, w, h, t, rnd) {
      g.fillStyle = '#0b1230'; g.fillRect(0, 0, w, h);
      const wx = w * 0.12, wy = h * 0.12, ww = w * 0.76, wh = h * 0.46;
      const sky = g.createLinearGradient(0, wy, 0, wy + wh);
      sky.addColorStop(0, '#1b2f6a'); sky.addColorStop(1, '#2a4aa0');
      g.fillStyle = sky; g.fillRect(wx, wy, ww, wh);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 26; i++) {
        const x = wx + rnd() * ww; const y = wy + wh * 0.35 + rnd() * wh * 0.6; const r = 3 + rnd() * 9;
        const a = 0.35 + 0.35 * Math.sin(t * (0.8 + rnd()) + i);
        const b = g.createRadialGradient(x, y, 0, x, y, r);
        b.addColorStop(0, i % 5 ? `rgba(140,200,255,${a})` : `rgba(255,200,120,${a})`); b.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = b; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      }
      g.strokeStyle = 'rgba(190,220,255,0.45)'; g.lineWidth = 1;
      for (let i = 0; i < 60; i++) { const x = wx + ((rnd() * ww + t * 40) % ww); const y = wy + ((rnd() * wh + t * 260 * (0.7 + rnd() * 0.6)) % wh); g.beginPath(); g.moveTo(x, y); g.lineTo(x - 3, y + 14); g.stroke(); }
      g.globalCompositeOperation = 'source-over';
      g.strokeStyle = '#0a0f24'; g.lineWidth = 8; g.strokeRect(wx, wy, ww, wh);
      g.beginPath(); g.moveTo(wx + ww / 2, wy); g.lineTo(wx + ww / 2, wy + wh); g.stroke();
      // the desk and the lamp
      g.fillStyle = '#3a2416'; g.fillRect(0, h * 0.74, w, h * 0.26);
      const lamp = g.createRadialGradient(w * 0.75, h * 0.68, 4, w * 0.75, h * 0.7, w * 0.6);
      const k = 0.85 + 0.05 * Math.sin(t * 3);
      lamp.addColorStop(0, `rgba(255,210,130,${k})`); lamp.addColorStop(1, 'rgba(255,170,80,0)');
      g.globalCompositeOperation = 'lighter'; g.fillStyle = lamp; g.fillRect(0, h * 0.3, w, h * 0.7); g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#f3e1b8'; g.beginPath(); g.moveTo(w * 0.66, h * 0.62); g.lineTo(w * 0.84, h * 0.62); g.lineTo(w * 0.8, h * 0.55); g.lineTo(w * 0.7, h * 0.55); g.fill();
      g.fillStyle = '#2a1a10'; g.fillRect(w * 0.745, h * 0.62, 6, h * 0.12);
    },
    hearts(g, w, h, t, rnd) {
      const bg = g.createLinearGradient(0, 0, w, h);
      bg.addColorStop(0, '#ffb3d1'); bg.addColorStop(1, '#a6c8ff');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 18; i++) {
        const sp = 30 + rnd() * 50; const x = rnd() * w + Math.sin(t + i) * 12; const y = h - ((t * sp + rnd() * h) % (h + 60));
        g.globalAlpha = 0.5 + rnd() * 0.4; g.fillStyle = i % 3 ? '#ff5d8f' : '#ffffff'; heart(g, x, y, 14 + rnd() * 18); g.fill();
      }
      g.globalAlpha = 1;
      const s = w * 0.42 * (1 + Math.sin(t * 4) * 0.06);
      g.fillStyle = '#ff3f7a'; heart(g, w / 2, h * 0.36 - s * 0.4, s); g.fill();
      g.fillStyle = '#fff'; g.font = font(Math.round(w * 0.09), 800); g.textAlign = 'center'; g.fillText('比心 ♡', w / 2, h * 0.72);
      g.textAlign = 'left';
    },
    city(g, w, h, t, rnd) {
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#05081c'); sky.addColorStop(0.6, '#1a1d4a'); sky.addColorStop(1, '#3b1f4a');
      g.fillStyle = sky; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9; i++) {
        const bw = w * (0.08 + rnd() * 0.1); const bx = (i / 9) * w - 6; const bh = h * (0.25 + rnd() * 0.4);
        g.fillStyle = '#0b0d22'; g.fillRect(bx, h * 0.78 - bh, bw, bh);
        for (let yy = h * 0.78 - bh + 8; yy < h * 0.76; yy += 12) for (let xx = bx + 4; xx < bx + bw - 4; xx += 9) {
          const on = rnd() > 0.45 && Math.sin(t * 0.7 + xx * 0.13 + yy) > -0.7;
          if (on) { g.fillStyle = rnd() > 0.2 ? 'rgba(255,214,140,0.85)' : 'rgba(150,200,255,0.85)'; g.fillRect(xx, yy, 4, 5); }
        }
      }
      g.fillStyle = '#060714'; g.fillRect(0, h * 0.78, w, h * 0.22);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 14; i++) { const lane = i % 2; const x = ((t * (90 + i * 7) + i * 70) % (w + 120)) - 60; const y = h * (0.84 + lane * 0.06); g.fillStyle = lane ? 'rgba(255,80,80,0.8)' : 'rgba(255,240,200,0.9)'; g.fillRect(lane ? w - x : x, y, 26, 2); }
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = '#f6f0c8'; g.beginPath(); g.arc(w * 0.8, h * 0.14, w * 0.06, 0, TAU); g.fill();
    },
    cat(g, w, h, t) {
      g.fillStyle = '#ffe9c9'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#f2c78f'; g.fillRect(0, h * 0.7, w, h * 0.3);
      const cx = w / 2, cy = h * 0.5, r = w * 0.32;
      g.fillStyle = '#f0a35e';
      g.beginPath(); g.moveTo(cx - r * 0.9, cy - r * 0.3); g.lineTo(cx - r * 0.6, cy - r * 1.2); g.lineTo(cx - r * 0.15, cy - r * 0.8); g.fill();
      g.beginPath(); g.moveTo(cx + r * 0.9, cy - r * 0.3); g.lineTo(cx + r * 0.6, cy - r * 1.2); g.lineTo(cx + r * 0.15, cy - r * 0.8); g.fill();
      g.beginPath(); g.ellipse(cx, cy, r, r * 0.85, 0, 0, TAU); g.fill();
      const nod = Math.sin(t * 0.9);
      const open = clamp01(0.5 + nod * 0.6);
      g.fillStyle = '#3a2412';
      for (const ex of [-0.38, 0.38]) { g.beginPath(); g.ellipse(cx + ex * r, cy - r * 0.05, r * 0.12, Math.max(1.5, r * 0.12 * open), 0, 0, TAU); g.fill(); }
      g.fillStyle = '#ff8fa3'; g.beginPath(); g.moveTo(cx - 6, cy + r * 0.18); g.lineTo(cx + 6, cy + r * 0.18); g.lineTo(cx, cy + r * 0.26); g.fill();
      g.strokeStyle = '#3a2412'; g.lineWidth = 2;
      for (const s of [-1, 1]) for (const k of [0, 1]) { g.beginPath(); g.moveTo(cx + s * r * 0.3, cy + r * (0.25 + k * 0.08)); g.lineTo(cx + s * r * 0.85, cy + r * (0.2 + k * 0.14)); g.stroke(); }
      if (open < 0.3) { g.fillStyle = '#7a5a3a'; g.font = font(Math.round(w * 0.08), 700); g.fillText('z', cx + r * 0.9, cy - r * 0.7 - (t * 20) % 30); }
    },
  };

  // ---- 每种内容 ----------------------------------------------------------------------------------------------
  function create(kind, { w = 360, h = 640, room = {}, images = {}, frames = {}, seed = 1 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    const C = room.content || {};
    const st = { t: 0, acc: 0, swipe: 0, swipeFrom: 0, idx: 0, nextSwipe: 0, lum: 0.6, lumT: 0, score: 0, jump: 0, obstacles: [], typed: 0, track: 0, pos: 0 };
    const clips = (C.clips && C.clips.list) || [];
    const swipeEvery = (C.clips && C.clips.swipeEvery) || [8, 15];
    const rnd = Math.random;
    const scheduleSwipe = () => { st.nextSwipe = st.t + swipeEvery[0] + rnd() * (swipeEvery[1] - swipeEvery[0]); };
    scheduleSwipe();
    const FPS = kind === 'clips' || kind === 'game' ? 24 : 12;

    // one clip in a portrait box (w × h): the whole phone screen, or the player column of a laptop's web feed
    function clipBox(i, yOff, w, h) {
      if (!clips.length) return;
      const c = clips[((i % clips.length) + clips.length) % clips.length];
      g.save();
      g.translate(0, yOff);
      g.beginPath(); g.rect(0, 0, w, h); g.clip();
      const f = c.frames !== undefined && frames.clips && images.clips ? Object.entries(frames.clips).filter(([n]) => n.startsWith(`${c.id}-`)).map(([, r]) => r) : null;
      if (f && f.length) { const r = f[Math.floor(st.t * ((C.clips && C.clips.fps) || 12)) % f.length]; g.drawImage(images.clips, r.x, r.y, r.w, r.h, 0, 0, w, h); }
      else (SCENES[c.scene] || SCENES.jellyfish)(g, w, h, st.t, seeded(seed * 97 + i * 13));
      // the feed's chrome
      const shade = g.createLinearGradient(0, h * 0.62, 0, h);
      shade.addColorStop(0, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,0.6)');
      g.fillStyle = shade; g.fillRect(0, h * 0.6, w, h * 0.4);
      g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = font(Math.round(h * 0.026), 500); g.textAlign = 'center';
      g.fillText('关注', w * 0.38, h * 0.06); g.fillStyle = '#fff'; g.font = font(Math.round(h * 0.028), 800); g.fillText('推荐', w * 0.6, h * 0.06);
      g.fillRect(w * 0.6 - 12, h * 0.07, 24, 3);
      // like / comment / share
      const cx = w * 0.88;
      g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, h * 0.5, w * 0.06, 0, TAU); g.fill();
      g.fillStyle = '#6fa8e8'; g.beginPath(); g.arc(cx, h * 0.5, w * 0.05, 0, TAU); g.fill();
      const icons = [['♥', c.likes || '1.2w', '#ff3f6c'], ['…', String(Math.round((i + 3) * 137)), '#fff'], ['↗', '分享', '#fff']];
      icons.forEach(([ic, n, col], k) => {
        const y = h * (0.6 + k * 0.09);
        g.fillStyle = col; g.font = font(Math.round(h * 0.05), 800); g.fillText(ic, cx, y);
        g.fillStyle = '#fff'; g.font = font(Math.round(h * 0.022), 600); g.fillText(n, cx, y + h * 0.03);
      });
      g.textAlign = 'left';
      g.fillStyle = '#fff'; g.font = font(Math.round(h * 0.03), 800); g.fillText(`@${c.author || '大肥鱼'}`, w * 0.05, h * 0.86);
      g.font = font(Math.round(h * 0.027), 500); g.fillText(c.caption || '', w * 0.05, h * 0.905, w * 0.76);
      g.fillStyle = 'rgba(255,255,255,0.8)'; g.font = font(Math.round(h * 0.022), 500); g.fillText(`♪ 原声 - ${c.author || '大肥鱼'}`, w * 0.05, h * 0.945, w * 0.7);
      const loop = 6;
      g.fillStyle = 'rgba(255,255,255,0.3)'; g.fillRect(0, h - 3, w, 3);
      g.fillStyle = '#fff'; g.fillRect(0, h - 3, w * ((st.t % loop) / loop), 3);
      g.restore();
    }
    function drawClips() {
      // a laptop (landscape): the web feed — the vertical video in the middle, the menu and the comments beside it
      const landscape = w > h;
      const bw = landscape ? Math.round((h * 9) / 16) : w;
      const x0 = landscape ? Math.round((w - bw) / 2) : 0;
      if (landscape) {
        g.fillStyle = '#16161e'; g.fillRect(0, 0, w, h);
        g.fillStyle = '#fe2c55'; g.font = font(Math.round(h * 0.05), 900); g.fillText('短视频', w * 0.03, h * 0.09);
        ['推荐', '关注', '朋友', '直播', '放映厅'].forEach((t, k) => { g.fillStyle = k ? 'rgba(255,255,255,0.6)' : '#fff'; g.font = font(Math.round(h * 0.04), k ? 500 : 800); g.fillText(t, w * 0.04, h * (0.2 + k * 0.1)); });
        const c = clips[st.idx % Math.max(1, clips.length)] || {};
        const rx = x0 + bw + w * 0.025;
        g.fillStyle = '#fff'; g.font = font(Math.round(h * 0.04), 800); g.fillText(`评论 ${(st.idx + 3) * 137}`, rx, h * 0.09);
        const comments = [['小鲸鱼', '好治愈啊'], ['雨夜听歌', '这个配乐是什么'], ['夜猫子', '凌晨还在刷的举手'], ['大肥鱼粉丝', `${(c.caption || '').slice(0, 6)}…看了三遍`]];
        comments.forEach(([u, t], k) => {
          const y = h * (0.2 + k * 0.17);
          g.fillStyle = ['#6fa8e8', '#ff9ab8', '#ffd36e', '#b7e48a'][k]; g.beginPath(); g.arc(rx + h * 0.03, y - h * 0.012, h * 0.03, 0, TAU); g.fill();
          g.fillStyle = 'rgba(255,255,255,0.6)'; g.font = font(Math.round(h * 0.03), 500); g.fillText(u, rx + h * 0.08, y - h * 0.02, w - rx - h * 0.1);
          g.fillStyle = '#fff'; g.font = font(Math.round(h * 0.034), 500); g.fillText(t, rx + h * 0.08, y + h * 0.03, w - rx - h * 0.1);
        });
      }
      g.save();
      g.translate(x0, 0);
      if (st.swipe > 0) {
        const k = 1 - Math.pow(1 - clamp01(st.swipe), 3);
        clipBox(st.swipeFrom, -k * h, bw, h);
        clipBox(st.idx, (1 - k) * h, bw, h);
      } else clipBox(st.idx, 0, bw, h);
      g.restore();
    }

    function drawPage(ctx) {
      const query = ctx.query;
      g.fillStyle = '#eef1f6'; g.fillRect(0, 0, w, h);
      // the browser: tabs, address bar
      g.fillStyle = '#d9dee8'; g.fillRect(0, 0, w, h * 0.09);
      g.fillStyle = '#fff'; roundRect(g, w * 0.02, h * 0.02, w * 0.3, h * 0.07, 6); g.fill();
      g.fillStyle = '#334'; g.font = font(Math.round(h * 0.035), 600); g.fillText(query ? `${query} - 搜索` : '周报.docx', w * 0.04, h * 0.068, w * 0.26);
      g.fillStyle = '#fff'; g.fillRect(0, h * 0.09, w, h * 0.08);
      g.fillStyle = '#f1f3f7'; roundRect(g, w * 0.1, h * 0.105, w * 0.8, h * 0.05, 12); g.fill();
      g.fillStyle = '#556'; g.font = font(Math.round(h * 0.03), 500);
      g.fillText(query ? `https://www.so.com/s?q=${query}` : 'https://docs.example.cn/d/weekly-report', w * 0.13, h * 0.14, w * 0.74);
      for (let i = 0; i < 3; i++) { g.fillStyle = ['#ff6058', '#ffbd2e', '#28c940'][i]; g.beginPath(); g.arc(w * (0.93 + i * 0.0) - i * 14, h * 0.045, 4, 0, TAU); g.fill(); }
      const top = h * 0.2;
      if (query) {
        g.fillStyle = '#2b6de8'; g.font = font(Math.round(h * 0.06), 900); g.fillText('搜一搜', w * 0.06, top + h * 0.06);
        g.fillStyle = '#fff'; roundRect(g, w * 0.3, top + h * 0.015, w * 0.62, h * 0.06, 8); g.fill();
        g.strokeStyle = '#2b6de8'; g.lineWidth = 2; g.stroke();
        g.fillStyle = '#222'; g.font = font(Math.round(h * 0.035), 500); g.fillText(query, w * 0.32, top + h * 0.057, w * 0.56);
        const results = [`${query} - 百科`, `${query}是什么体验？- 问答`, `关于「${query}」的最新消息`, `${query}怎么样？看看大家怎么说`, `${query} 相关视频`];
        results.forEach((r, i) => {
          const y = top + h * (0.15 + i * 0.13);
          if (y > h - 20) return;
          g.fillStyle = '#1a0dab'; g.font = font(Math.round(h * 0.036), 700); g.fillText(r, w * 0.06, y, w * 0.88);
          g.fillStyle = '#0b8043'; g.font = font(Math.round(h * 0.026), 400); g.fillText(`www.example${i + 1}.cn › ${encodeURIComponent(query).slice(0, 12)}`, w * 0.06, y + h * 0.035, w * 0.8);
          g.fillStyle = '#c9ced8'; g.fillRect(w * 0.06, y + h * 0.05, w * 0.82, 5); g.fillRect(w * 0.06, y + h * 0.068, w * 0.6, 5);
        });
        return;
      }
      // a document typed as the round goes on
      g.fillStyle = '#fff'; g.fillRect(w * 0.08, top, w * 0.84, h - top);
      g.fillStyle = '#1f2a44'; g.font = font(Math.round(h * 0.05), 900); g.fillText('本周工作周报', w * 0.14, top + h * 0.08);
      const lines = ['1. 整理了书桌上的那摞书，按颜色排好了', '2. 回复了主人的消息（很快！）', '3. 学会了用台灯省电：不用就关', '4. 下雨天的歌单更新了三首', '5. 鲸鱼尾巴的毛衣还差一只袖子', '6. 下周目标：早点睡（尽量）', '7. 给窗外的雨拍了一段视频', '8. 备忘：周末去买新的马克杯'];
      const want = Math.max(1, Math.floor((ctx.progress || 0) * lines.length * 12) + Math.floor(st.t * 6));
      let left = want;
      g.font = font(Math.round(h * 0.034), 500);
      lines.forEach((l, i) => {
        if (left <= 0) return;
        const n = Math.min(l.length, left);
        left -= l.length;
        g.fillStyle = '#334';
        const y = top + h * (0.16 + i * 0.085);
        g.fillText(l.slice(0, n), w * 0.14, y, w * 0.74);
        if (n < l.length && Math.floor(st.t * 2) % 2 === 0) { const tw = g.measureText(l.slice(0, n)).width; g.fillStyle = '#2b6de8'; g.fillRect(w * 0.14 + Math.min(tw, w * 0.74) + 2, y - h * 0.03, 2, h * 0.036); }
      });
    }

    function drawPlayer() {
      const tracks = (C.player && C.player.tracks) || [{ title: '未知歌曲', artist: '', seconds: 180 }];
      const tr = tracks[st.track % tracks.length];
      const bg = g.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#24407e'); bg.addColorStop(1, '#0b1430');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      // the cover: a whale under the moon
      const cs = Math.min(w * 0.72, h * 0.42); const cx = (w - cs) / 2; const cy = h * 0.1;
      const cov = g.createLinearGradient(cx, cy, cx + cs, cy + cs);
      cov.addColorStop(0, '#6fa8e8'); cov.addColorStop(1, '#2c4a8a');
      g.save(); roundRect(g, cx, cy, cs, cs, 14); g.clip();
      g.fillStyle = cov; g.fillRect(cx, cy, cs, cs);
      g.fillStyle = '#fff6d8'; g.beginPath(); g.arc(cx + cs * 0.72, cy + cs * 0.26, cs * 0.1, 0, TAU); g.fill();
      g.fillStyle = '#1c2f63';
      const wy = cy + cs * 0.62 + Math.sin(st.t * 1.4) * 4;
      g.beginPath(); g.ellipse(cx + cs * 0.45, wy, cs * 0.28, cs * 0.13, -0.1, 0, TAU); g.fill();
      g.beginPath(); g.moveTo(cx + cs * 0.18, wy); g.lineTo(cx + cs * 0.05, wy - cs * 0.12); g.lineTo(cx + cs * 0.08, wy + cs * 0.08); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(cx + cs * 0.6, wy - cs * 0.02, cs * 0.018, 0, TAU); g.fill();
      g.restore();
      g.fillStyle = '#fff'; g.font = font(Math.round(h * 0.045), 800); g.textAlign = 'center';
      g.fillText(tr.title, w / 2, h * 0.6, w * 0.9);
      g.fillStyle = 'rgba(255,255,255,0.7)'; g.font = font(Math.round(h * 0.03), 500); g.fillText(tr.artist || '', w / 2, h * 0.645, w * 0.9);
      // spectrum
      const n = 20; const bw = (w * 0.8) / n;
      for (let i = 0; i < n; i++) {
        const v = 0.25 + 0.75 * Math.abs(Math.sin(st.t * (2.1 + (i % 5) * 0.37) + i * 1.3) * Math.sin(st.t * 0.9 + i * 0.4));
        g.fillStyle = `rgba(160,210,255,${0.5 + v * 0.5})`;
        const bh = h * 0.08 * v;
        g.fillRect(w * 0.1 + i * bw + 1, h * 0.75 - bh, bw - 3, bh);
      }
      // progress
      const pos = st.pos % tr.seconds;
      g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(w * 0.1, h * 0.79, w * 0.8, 4);
      g.fillStyle = '#fff'; g.fillRect(w * 0.1, h * 0.79, w * 0.8 * (pos / tr.seconds), 4);
      g.beginPath(); g.arc(w * 0.1 + w * 0.8 * (pos / tr.seconds), h * 0.79 + 2, 6, 0, TAU); g.fill();
      g.font = font(Math.round(h * 0.026), 500); g.fillStyle = 'rgba(255,255,255,0.8)';
      g.textAlign = 'left'; g.fillText(fmt(pos), w * 0.1, h * 0.83);
      g.textAlign = 'right'; g.fillText(fmt(tr.seconds), w * 0.9, h * 0.83);
      g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = font(Math.round(h * 0.06), 800);
      g.fillText('⏮', w * 0.28, h * 0.92); g.fillText('⏸', w * 0.5, h * 0.925); g.fillText('⏭', w * 0.72, h * 0.92);
      g.textAlign = 'left';
    }

    function drawGame() {
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#7ec3ff'); sky.addColorStop(1, '#d9f0ff');
      g.fillStyle = sky; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(255,255,255,0.9)';
      for (let i = 0; i < 4; i++) { const x = (w + 80) - ((st.t * 30 + i * 180) % (w + 160)); g.beginPath(); g.ellipse(x, h * (0.18 + (i % 2) * 0.1), 40, 14, 0, 0, TAU); g.fill(); }
      const ground = h * 0.78;
      g.fillStyle = '#3d8a5a'; g.fillRect(0, ground, w, h - ground);
      g.fillStyle = '#2c6b44';
      for (let x = -((st.t * 160) % 40); x < w; x += 40) g.fillRect(x, ground, 20, 6);
      for (const o of st.obstacles) { g.fillStyle = '#6b5a4a'; g.beginPath(); g.moveTo(o.x, ground); g.lineTo(o.x + 16, ground - o.h); g.lineTo(o.x + 32, ground); g.fill(); }
      const wx = w * 0.22; const wy = ground - 26 - st.jumpY;
      g.fillStyle = '#2c4a8a'; g.beginPath(); g.ellipse(wx, wy, 34, 22, 0, 0, TAU); g.fill();
      g.beginPath(); g.moveTo(wx - 30, wy); g.lineTo(wx - 52, wy - 18 + Math.sin(st.t * 12) * 4); g.lineTo(wx - 48, wy + 12); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(wx + 18, wy - 6, 4, 0, TAU); g.fill();
      g.fillStyle = '#9fd1ff'; g.beginPath(); g.ellipse(wx + 4, wy + 10, 22, 8, 0, 0, Math.PI); g.fill();
      g.fillStyle = '#123'; g.font = font(Math.round(h * 0.07), 900); g.fillText(`${(C.game && C.game.title) || '鲸鱼跳跳'}`, w * 0.04, h * 0.1);
      g.textAlign = 'right'; g.fillText(`得分 ${Math.floor(st.score)}`, w * 0.96, h * 0.1); g.textAlign = 'left';
    }
    function stepGame(dt) {
      st.score += dt * 10;
      st.vy = st.vy || 0; st.jumpY = st.jumpY || 0;
      if (!st.obstacles.length || st.obstacles[st.obstacles.length - 1].x < w - 180 - rnd() * 160) st.obstacles.push({ x: w + 20, h: 20 + rnd() * 26 });
      for (const o of st.obstacles) o.x -= dt * 160;
      st.obstacles = st.obstacles.filter((o) => o.x > -40);
      const near = st.obstacles.find((o) => o.x > w * 0.22 && o.x < w * 0.22 + 70);
      if (near && st.jumpY <= 0.5) st.vy = 330;
      st.vy -= dt * 900; st.jumpY = Math.max(0, st.jumpY + st.vy * dt);
      if (st.jumpY === 0 && st.vy < 0) st.vy = 0;
    }

    function drawLock() {
      const bg = g.createLinearGradient(0, 0, 0, h);
      bg.addColorStop(0, '#2c4a8a'); bg.addColorStop(1, '#0b1430');
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'lighter';
      const sr = seeded(7);
      for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(180,210,255,${0.2 + 0.3 * Math.abs(Math.sin(st.t + i))})`; g.beginPath(); g.arc(sr() * w, sr() * h * 0.6, 1 + sr() * 2, 0, TAU); g.fill(); }
      g.globalCompositeOperation = 'source-over';
      const d = new Date();
      g.fillStyle = '#fff'; g.textAlign = 'center';
      g.font = font(Math.round(h * 0.13), 300); g.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, w / 2, h * 0.24);
      g.font = font(Math.round(h * 0.032), 500); g.fillText(`${d.getMonth() + 1}月${d.getDate()}日 星期${'日一二三四五六'[d.getDay()]}`, w / 2, h * 0.29);
      g.fillStyle = 'rgba(255,255,255,0.85)'; roundRect(g, w * 0.07, h * 0.36, w * 0.86, h * 0.1, 14); g.fill();
      g.fillStyle = '#223'; g.textAlign = 'left'; g.font = font(Math.round(h * 0.026), 800); g.fillText('消息 · 现在', w * 0.12, h * 0.395);
      g.font = font(Math.round(h * 0.028), 500); g.fillText('主人：早点睡呀，晚安～', w * 0.12, h * 0.435, w * 0.76);
      g.textAlign = 'center';
    }

    const draw = (ctx) => {
      g.textAlign = 'left';
      if (kind === 'clips') drawClips();
      else if (kind === 'page') drawPage(ctx);
      else if (kind === 'player') drawPlayer();
      else if (kind === 'game') drawGame();
      else if (kind === 'lock') drawLock();
      else { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); }
    };
    // a cheap mean brightness of what is shown (for the screen's glow): a 4×4 copy every 0.5 s
    const tiny = document.createElement('canvas');
    tiny.width = 4; tiny.height = 4;
    const tg = tiny.getContext('2d', { willReadFrequently: true });
    function measure() {
      tg.drawImage(canvas, 0, 0, 4, 4);
      const d = tg.getImageData(0, 0, 4, 4).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      st.lum = s / 16 / 255;
    }

    let drawn = false;
    return {
      canvas, kind,
      // dt in seconds; ctx: { progress (the round 0–1), query, clip (how many 下一个 so far) }. → redrawn this call
      update(dt, ctx = {}) {
        st.t += dt;
        st.acc += dt;
        if (kind === 'clips') {
          if (Number.isInteger(ctx.clip) && ctx.clip !== st.clipAsked) { if (st.clipAsked !== undefined) this.next(); st.clipAsked = ctx.clip; }
          if (st.swipe > 0) { st.swipe += dt / 0.35; if (st.swipe >= 1) st.swipe = 0; }
          if (st.t >= st.nextSwipe) this.next();
        }
        if (kind === 'player') st.pos += dt;
        if (kind === 'game') stepGame(dt);
        if (drawn && st.acc < 1 / FPS) return false;
        st.acc = 0;
        draw(ctx);
        drawn = true;
        st.lumT -= dt;
        if (st.lumT <= 0) { measure(); st.lumT = 0.5; }
        return true;
      },
      brightness: () => st.lum,
      next() { if (kind !== 'clips' || !clips.length) return; st.swipeFrom = st.idx; st.idx = (st.idx + 1) % clips.length; st.swipe = 0.0001; scheduleSwipe(); },
      info() {
        const clip = clips.length ? clips[st.idx % clips.length] : null;
        const tracks = (C.player && C.player.tracks) || [];
        const tr = tracks.length ? tracks[st.track % tracks.length] : null;
        return { kind, t: st.t, clip: clip ? { id: clip.id, caption: clip.caption, index: st.idx } : null, swiping: st.swipe > 0, track: tr ? { title: tr.title, artist: tr.artist, pos: Math.floor(st.pos % tr.seconds), seconds: tr.seconds, time: `${fmt(st.pos % tr.seconds)} / ${fmt(tr.seconds)}` } : null, score: Math.floor(st.score), lum: st.lum };
      },
    };
  }

  root.ScreenContent = { create, SCENES: Object.keys(SCENES) };
})(typeof self !== 'undefined' ? self : this);
