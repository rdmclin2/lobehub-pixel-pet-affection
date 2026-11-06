'use strict';
// 她的房间 · 引擎 illustrated-room@1 (docs/illustrated-room.md, design: docs/illustrated-room-design.md §4). Plays an
// illustrated room pack (core/illustrated-room-pack.js) in the game window with PixiJS 8. Every state of the room is
// one whole illustration (her pose drawn into the room) in two lightings — `off` (moonlight) and `lit` (the desk
// lamp on); everything that moves is drawn here on top:
//
//   world            the room's world (1920×1080) covering the window
//   ├ scenes         the state on screen; during a crossfade the next one fades in over it (1.4 s)
//   │ └ scene        off (Sprite) · breathOff (MeshPlane: her chest / back, displaced by the breath) · lit (alpha =
//   │                lamp) · breathLit · blink (her eyes closed, procedural lids or the pack's patches) · screens
//   │                (PerspectiveMesh on the four corners, content from screen-content.js) · screen glow (add)
//   ├ window         masked by the window's panes: bokeh (add, each its own slow pulse), rain streaks, drops
//   ├ lampGlow       the lamp's warm halo (add, alpha = lamp × glow.alpha) · dust in its light
//   ├ fx             Z / ♪ rising from her (a state's `fx`)
//   ├ vignette
//   └ hover          the hovered hotspot's outline
//   ui (DOM)         title-bar capsule ⚡ ♥ (her numbers, folded), the 屏幕 card (the screen enlarged), her bubble,
//                    the status bar (六件事, a state's variants such as 犯懒, 台灯) and the chat bar
//
// Main is the only authority (src/main/games.js illustratedCommand): a click, a key, a hotspot or the chat
// (main.js roomChat, core/room-intent.js) sends a command; whatever comes back — or is pushed (game:room) — is
// played. window.__game() is the e2e's read-out, window.__gameTest its handles.
(async function () {
  const boot = await (window.__gameBoot || window.game.boot());
  if (!boot || !boot.game || !boot.game.manifest || boot.game.manifest.engine !== 'illustrated-room@1') return;
  const P = window.PIXI;
  const IRP = window.IllustratedRoomPlay;
  const SC = window.ScreenContent;
  const $ = (id) => document.getElementById(id);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = Math.random;
  const M = boot.game.manifest;
  const BASE = boot.game.base;
  const V0 = boot.room || {};
  const room = IRP.roomOf(M, V0.room);
  const W = room.world.width;
  const H = room.world.height;
  const KINDS = IRP.KINDS;
  const LAMP = (room.lighting && room.lighting.lamp) || null;
  const ICON = {
    sleep: '<path d="M2 18v-6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6"/><path d="M2 14h20"/><path d="M6 10V8a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/>',
    work: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    game: '<rect x="2" y="7" width="20" height="10" rx="4"/><path d="M7 11v2M6 12h2M16 11h.01M18 13h.01"/>',
    idle: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 1.5 4 1.5 4-1.5 4-1.5"/><path d="M9 9.5h.01M15 9.5h.01"/>',
    variant: '<circle cx="12" cy="12" r="9"/><path d="M9 15.5h6"/><path d="M7.5 10h3M13.5 10h3"/>',
    lamp: '<path d="M9 18h6M10 22h4"/><path d="M12 2a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5v1h6v-1c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 2z"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/>',
  };
  const svg = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ''}</svg>`;
  document.body.classList.add('engine-illustrated');
  document.title = M.name;
  $('game-name').textContent = M.name;
  $('who').textContent = room.name || '';
  $('loading').textContent = '正在打开房间…';
  $('stage').setAttribute('aria-label', `${room.name}：点床、手机、书桌让她去做那件事，点台灯开关灯；也可以在下面的聊天栏叫她做什么`);

  // ---- state ---------------------------------------------------------------------------------------------
  const st = {
    view: V0, // the room view from main (core/illustrated-room-play.js view + stats / run / last / quests)
    lamp: 0, lampTarget: V0.lamp ? 1 : 0, lampT: 0, lampFrom: 0, lampAnim: null,
    t: 0, frames: 0, fps: 0,
    scene: null, // the scene on screen (after a crossfade: the new one)
    fades: [], transitions: [], // [{ from, to, seconds, at, bothSeen }]
    path: [], pathBusy: false,
    hover: null, tipText: '',
    bubbleT: 0, bubbleText: '', bubbleStream: null,
    runLocal: null, // { startedAt (performance.now), seconds, elapsed0 }
    ticking: false, seenT: 10,
    statsOpen: false, pipOpen: true, chatBusy: false, chatNote: '',
    events: [], errors: [], lastToast: null, blinks: 0,
  };
  window.addEventListener('error', (e) => { st.errors.push(String(e.message || e)); });
  window.addEventListener('unhandledrejection', (e) => { st.errors.push(String((e.reason && e.reason.message) || e.reason)); });

  // ---- the room's DOM ------------------------------------------------------------------------------------
  // a state's `variants` (犯懒 beside 发呆) get their own button right after the activity's
  const VARIANTS = {};
  for (const s of Object.values(room.states)) if (!s.transient && s.variants) (VARIANTS[s.activity] = VARIANTS[s.activity] || []).push(...s.variants);
  const VARIANT_KEYS = KINDS.flatMap((k) => VARIANTS[k] || []);
  const isVariant = (key) => VARIANT_KEYS.includes(key);
  const ui = document.createElement('div');
  ui.id = 'ir-ui';
  const actBtn = (k) => `<button class="ir-act" data-kind="${k}" title="${(M.activities[k] && M.activities[k].label) || k}（${KINDS.indexOf(k) + 1}）">${svg(k)}<span>${(M.activities[k] && M.activities[k].label) || k}</span><i class="ir-prog"><b></b></i></button>`;
  ui.innerHTML = `
    <section id="ir-pip" class="ir-pip" aria-label="屏幕">
      <div class="ir-pip-head">${svg('screen')}<b id="ir-pip-title">屏幕</b><span class="spacer"></span><button id="ir-pip-close" class="icon-btn" title="收起屏幕" aria-label="收起屏幕"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div>
      <canvas id="ir-pip-canvas" width="117" height="208"></canvas>
      <small id="ir-pip-cap" class="ir-pip-cap"></small>
    </section>
    <section id="ir-stats" class="ir-stats hidden" aria-label="她的状态">
      <ul id="ir-stats-list"></ul>
      <small id="ir-last" class="muted"></small>
      <b class="ir-q-head">今日小事</b>
      <ul id="ir-quests" class="ir-quests"></ul>
    </section>
    <div class="ir-bottom">
      <div id="ir-said" class="ir-said hidden" role="status" aria-live="polite"></div>
      <form id="ir-chat" class="ir-chat" autocomplete="off">
        <input id="ir-chat-input" data-lobe-focus-ring="off" type="text" maxlength="200" placeholder="和她说点什么…（例如「回床上休息吧」「打开电脑刷抖音」）" aria-label="和她说话" />
        <span id="ir-chat-note" class="ir-chat-note"></span>
        <button id="ir-chat-send" class="ir-send" type="submit" title="发送（Enter）" aria-label="发送">${svg('send')}</button>
      </form>
      <nav id="ir-bar" class="ir-bar" aria-label="她在做什么">
        ${KINDS.map((k) => actBtn(k) + (VARIANTS[k] || []).map((v) => `<button class="ir-act ir-variant" data-state="${v}" title="${room.states[v].label}（${KINDS.length + VARIANT_KEYS.indexOf(v) + 1}）">${svg('variant')}<span>${room.states[v].label}</span></button>`).join('')).join('')}
        <span class="ir-sep"></span>
        <button id="ir-lamp" class="ir-act ir-lamp" title="台灯（L）" aria-pressed="false">${svg('lamp')}<span>台灯</span></button>
      </nav>
    </div>`;
  document.body.appendChild(ui);
  const capsule = document.createElement('button');
  capsule.id = 'ir-capsule';
  capsule.className = 'ir-capsule';
  capsule.title = '她的状态（点开看精力、心情和今日小事）';
  capsule.setAttribute('aria-expanded', 'false');
  $('btn-close').before(capsule);

  // ---- Pixi ----------------------------------------------------------------------------------------------
  const app = new P.Application();
  await app.init({ resizeTo: $('stage'), background: room.world.background || '#0b1430', antialias: true, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true, preference: 'webgl', powerPreference: 'low-power' });
  $('stage').appendChild(app.canvas);
  const bitmaps = new Map(); // file → Promise<{ tex, bmp }>
  function load(file) {
    if (!bitmaps.has(file)) {
      bitmaps.set(file, (async () => {
        const blob = await fetch(`${BASE}${file}`).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status} ${file}`))));
        const bmp = await createImageBitmap(blob);
        return { tex: P.Texture.from(bmp), bmp };
      })());
      bitmaps.get(file).catch(() => bitmaps.delete(file));
    }
    return bitmaps.get(file);
  }
  // a soft round light (bokeh, glows): white centre to transparent, drawn once
  function softTexture(n = 128, hard = 0) {
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(hard || 0.25, 'rgba(255,255,255,0.55)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, n, n);
    return P.Texture.from(c);
  }
  const SOFT = softTexture(128);
  const BOKEH = softTexture(64, 0.55);
  function vignetteTexture(k) {
    const c = document.createElement('canvas');
    c.width = 480; c.height = 270;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(240, 135, 60, 240, 135, 290);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, `rgba(4,8,24,${k})`);
    g.fillStyle = gr;
    g.fillRect(0, 0, 480, 270);
    return P.Texture.from(c);
  }

  const world = new P.Container();
  const scenes = new P.Container();
  const grade = new P.ColorMatrixFilter();
  scenes.filters = [grade];
  const windowFx = new P.Container();
  const windowMask = new P.Graphics();
  const bokehLayer = new P.Container();
  const rainG = new P.Graphics();
  const dropsLayer = new P.Container();
  windowFx.addChild(bokehLayer, rainG, dropsLayer);
  windowFx.mask = windowMask;
  const lampGlow = new P.Sprite(SOFT);
  lampGlow.anchor.set(0.5);
  lampGlow.blendMode = 'add';
  const dust = new P.Container();
  const fxLayer = new P.Container();
  const vignette = new P.Sprite(vignetteTexture((room.lighting && room.lighting.grade && room.lighting.grade.vignette) || 0.3));
  vignette.width = W; vignette.height = H;
  const hoverG = new P.Graphics();
  world.addChild(scenes, windowMask, windowFx, lampGlow, dust, fxLayer, vignette, hoverG);
  app.stage.addChild(world);

  // cover the window with the world (a 16:9 room in a 960×600 window loses a little at the sides)
  const fit = { k: 1, x: 0, y: 0 };
  function layout() {
    const w = app.screen.width, h = app.screen.height;
    fit.k = Math.max(w / W, h / H);
    fit.x = (w - W * fit.k) / 2;
    fit.y = (h - H * fit.k) / 2;
    world.scale.set(fit.k);
    world.position.set(fit.x, fit.y);
  }
  const toScreen = (x, y) => [fit.x + x * fit.k, fit.y + y * fit.k];
  const toWorld = (x, y) => [(x - fit.x) / fit.k, (y - fit.y) / fit.k];

  // ---- the window: rain and bokeh, inside the panes --------------------------------------------------------
  const WIN = room.window || null;
  const panes = WIN ? (WIN.panes || (WIN.poly ? [WIN.poly] : [])) : [];
  for (const p of panes) windowMask.poly(p.flat()).fill({ color: 0xffffff });
  const winBox = panes.length ? panes.flat().reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]) : [0, 0, 0, 0];
  const bokeh = [];
  if (WIN && WIN.bokeh && !reduced) {
    const B = WIN.bokeh;
    const [r0, r1] = B.r || [6, 20];
    const [p0, p1] = B.period || [2, 6];
    // the pack's `spots` ([x, y, r, warm?]: where the lights are painted, so they twinkle in place) or random ones
    const spots = Array.isArray(B.spots) ? B.spots : null;
    for (let i = 0; i < (spots ? spots.length : B.count); i++) {
      const s = new P.Sprite(BOKEH);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      const spot = spots && spots[i];
      const warm = spot ? !!spot[3] : rnd() < (B.warmRatio || 0);
      s.tint = warm ? 0xffc98a : [0x9fc8ff, 0xcfe3ff, 0x7fb0ff][i % 3];
      const r = spot ? spot[2] : r0 + rnd() * (r1 - r0);
      s.width = s.height = r * 2;
      if (spot) s.position.set(spot[0], spot[1]);
      else s.position.set(winBox[0] + rnd() * (winBox[2] - winBox[0]), winBox[1] + (winBox[3] - winBox[1]) * (0.25 + rnd() * 0.75));
      bokehLayer.addChild(s);
      bokeh.push({ s, base: 0.25 + rnd() * 0.35, amp: 0.15 + rnd() * 0.3, w: (Math.PI * 2) / (p0 + rnd() * (p1 - p0)), ph: rnd() * 6.28, vx: spot ? 0 : (rnd() - 0.5) * 2 });
    }
  }
  const rain = [];
  const drops = [];
  if (WIN && WIN.rain && !reduced) {
    const RN = WIN.rain;
    const [v0, v1] = RN.speed || [900, 1400];
    const ang = ((RN.angle || 0) * Math.PI) / 180;
    for (let i = 0; i < RN.density; i++) rain.push({ x: winBox[0] + rnd() * (winBox[2] - winBox[0] + 200) - 100, y: winBox[1] + rnd() * (winBox[3] - winBox[1]), v: v0 + rnd() * (v1 - v0), len: 18 + rnd() * 26, a: 0.12 + rnd() * 0.25, ang });
    for (let i = 0; i < (RN.drops || 0); i++) {
      const s = new P.Sprite(SOFT);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      s.tint = 0xcfe3ff;
      const r = 2 + rnd() * 4;
      s.width = r * 2; s.height = r * 2.4;
      s.position.set(winBox[0] + rnd() * (winBox[2] - winBox[0]), winBox[1] + rnd() * (winBox[3] - winBox[1]));
      s.alpha = 0.35 + rnd() * 0.35;
      dropsLayer.addChild(s);
      drops.push({ s, v: 0, wait: rnd() * 6 });
    }
  }
  function stepWindow(dt) {
    for (const b of bokeh) {
      b.s.alpha = Math.max(0, b.base + b.amp * Math.sin(st.t * b.w + b.ph)) * (1 - st.lamp * 0.25);
      b.s.x += b.vx * dt;
    }
    rainG.clear();
    for (const d of rain) {
      d.y += d.v * dt * Math.cos(d.ang);
      d.x += d.v * dt * Math.sin(d.ang);
      if (d.y > winBox[3] + 40) { d.y = winBox[1] - 40 - rnd() * 80; d.x = winBox[0] + rnd() * (winBox[2] - winBox[0] + 200) - 100; }
      rainG.moveTo(d.x, d.y).lineTo(d.x - Math.sin(d.ang) * d.len, d.y - Math.cos(d.ang) * d.len);
    }
    if (rain.length) rainG.stroke({ width: 1.6, color: 0xd6e6ff, alpha: 0.32 });
    for (const d of drops) {
      if (d.wait > 0) { d.wait -= dt; continue; }
      d.v = Math.min(160, d.v + dt * 60);
      d.s.y += d.v * dt;
      if (d.s.y > winBox[3] + 10) { d.s.y = winBox[1] + rnd() * (winBox[3] - winBox[1]) * 0.5; d.s.x = winBox[0] + rnd() * (winBox[2] - winBox[0]); d.v = 0; d.wait = 1 + rnd() * 6; }
    }
  }

  // ---- the lamp: glow, dust, the grade --------------------------------------------------------------------
  const glow = (LAMP && LAMP.glow) || null;
  if (LAMP) {
    lampGlow.position.set(LAMP.at[0], LAMP.at[1]);
    lampGlow.width = lampGlow.height = ((glow && glow.r) || 400) * 2;
    lampGlow.tint = glow && glow.color ? parseInt(glow.color.slice(1), 16) : 0xffc46e;
  } else lampGlow.visible = false;
  const motes = [];
  if (LAMP && !reduced) for (let i = 0; i < 26; i++) {
    const s = new P.Sprite(SOFT);
    s.anchor.set(0.5);
    s.blendMode = 'add';
    s.tint = 0xffe2b0;
    s.width = s.height = 3 + rnd() * 5;
    dust.addChild(s);
    motes.push({ s, x: LAMP.at[0] + (rnd() - 0.5) * 360, y: LAMP.at[1] + rnd() * 340, ph: rnd() * 6.28, sp: 6 + rnd() * 10 });
  }
  const TINT = (() => { const h = (room.lighting && room.lighting.grade && room.lighting.grade.tint) || '#ffffff'; return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; })();
  const SAT = (room.lighting && room.lighting.grade && room.lighting.grade.saturation) || 1;
  let gradeKey = '';
  function applyGrade() {
    // moonlight: a cool tint; with the lamp on it warms towards white (the whole room changes with it)
    const L = st.lamp;
    const mix = (a, b) => a + (b - a) * L * 0.75;
    const t = [mix(TINT[0], 1.04), mix(TINT[1], 0.99), mix(TINT[2], 0.9)];
    const key = t.map((v) => v.toFixed(3)).join(',');
    if (key === gradeKey) return;
    gradeKey = key;
    const s = SAT;
    const lr = 0.2126, lg = 0.7152, lb = 0.0722;
    const m = [
      (lr + (1 - lr) * s) * t[0], lg * (1 - s) * t[0], lb * (1 - s) * t[0], 0, 0,
      lr * (1 - s) * t[1], (lg + (1 - lg) * s) * t[1], lb * (1 - s) * t[1], 0, 0,
      lr * (1 - s) * t[2], lg * (1 - s) * t[2], (lb + (1 - lb) * s) * t[2], 0, 0,
      0, 0, 0, 1, 0,
    ];
    grade.matrix = m;
  }
  // on: up in rampOn (0.17 s), then a small damped flicker for 0.3 s; off: down in rampOff
  function setLampTarget(on) {
    const want = on ? 1 : 0;
    if (want === st.lampTarget && st.lampAnim) return;
    st.lampTarget = want;
    st.lampAnim = { from: st.lamp, to: want, t: 0, ramp: on ? (LAMP && LAMP.rampOn) || 0.17 : (LAMP && LAMP.rampOff) || 0.25 };
    $('ir-lamp').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('ir-lamp').classList.toggle('on', on);
  }
  function stepLamp(dt) {
    const a = st.lampAnim;
    if (a) {
      a.t += dt;
      const flick = (LAMP && LAMP.flicker) || 0.05;
      if (a.t < a.ramp) st.lamp = a.from + (a.to - a.from) * (a.t / a.ramp);
      else if (a.to === 1 && a.t < a.ramp + 0.3) { const k = (a.t - a.ramp) / 0.3; st.lamp = 1 - flick * Math.abs(Math.sin(k * Math.PI * 3)) * (1 - k); }
      else { st.lamp = a.to; st.lampAnim = null; }
    }
    const L = st.lamp;
    lampGlow.alpha = L * ((glow && glow.alpha) || 0.5) * (1 + 0.03 * Math.sin(st.t * 7.3));
    for (const m of motes) {
      m.y -= m.sp * dt * 0.3;
      if (m.y < LAMP.at[1] - 20) m.y = LAMP.at[1] + 340;
      m.s.position.set(m.x + Math.sin(st.t * 0.5 + m.ph) * 14, m.y);
      m.s.alpha = L * (0.25 + 0.25 * Math.sin(st.t * 1.3 + m.ph));
    }
    applyGrade();
    if (st.scene) for (const sc of [st.scene, ...st.fades.map((f) => f.from).filter(Boolean)]) setSceneLamp(sc, L);
  }

  // ---- one scene: a state's illustration with her breath, blink and screens ---------------------------------
  // the colour at a point of a picture (her skin under the eye, for the procedural lids)
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const probeG = probe.getContext('2d', { willReadFrequently: true });
  function colourAt(bmp, x, y) {
    probeG.clearRect(0, 0, 1, 1);
    probeG.drawImage(bmp, (x / W) * bmp.width - 1, (y / H) * bmp.height - 1, 3, 3, 0, 0, 1, 1);
    const d = probeG.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  }
  const rgb = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
  const mixC = (a, b, k) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));

  function breathMesh(tex, rect) {
    const [rx, ry, rw, rh] = rect;
    const sx = tex.width / W, sy = tex.height / H;
    const sub = new P.Texture({ source: tex.source, frame: new P.Rectangle(Math.round(rx * sx), Math.round(ry * sy), Math.round(rw * sx), Math.round(rh * sy)) });
    const mesh = new P.MeshPlane({ texture: sub, verticesX: 9, verticesY: 9 });
    mesh.position.set(rx, ry);
    mesh.scale.set(rw / sub.width, rh / sub.height);
    const buf = mesh.geometry.getBuffer('aPosition');
    return { mesh, buf, base: Float32Array.from(buf.data), k: [1 / mesh.scale.x, 1 / mesh.scale.y], w: sub.width, h: sub.height };
  }
  function stepBreath(b, def, phase, sway) {
    if (!b) return;
    const { buf, base } = b;
    const d = buf.data;
    const n = 9;
    const lift = Math.sin(phase) * def.amp;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const u = i / (n - 1), v = j / (n - 1);
      const wgt = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
      const k = (j * n + i) * 2;
      d[k] = base[k] + ((u - 0.5) * lift * 0.5 + sway * wgt) * b.k[0] * wgt;
      d[k + 1] = base[k + 1] - lift * wgt * b.k[1];
    }
    buf.update();
  }

  // the room's parts atlas (blink patches …): `sprites` is its index { name: { x, y, w, h } }
  let partsLoad = null;
  function partsAtlas() {
    if (!partsLoad) {
      const file = room.images && room.images.parts;
      const index = room.sprites && boot.game.sprites ? boot.game.sprites[room.sprites] : null;
      partsLoad = file && index ? load(file).then((a) => ({ tex: a.tex, index })) : Promise.resolve(null);
    }
    return partsLoad;
  }

  // what the screens show from the pack: { images: { <room.images key>: bitmap }, frames: { clips: index } }
  let contentLoad = null;
  function contentAssets() {
    if (!contentLoad) {
      contentLoad = (async () => {
        const images = {};
        for (const [name, file] of Object.entries(room.images || {})) if (name !== 'parts') images[name] = (await load(file)).bmp;
        const f = room.frames && room.frames.clips;
        return { images, frames: f && boot.game.sprites ? { clips: boot.game.sprites[f] || null } : {} };
      })();
      contentLoad.catch(() => { contentLoad = null; });
    }
    return contentLoad;
  }
  let content = { images: {}, frames: {} };

  async function buildScene(key) {
    content = await contentAssets();
    const def = room.states[key];
    const [off, lit] = await Promise.all([load(def.images.off), def.images.lit ? load(def.images.lit) : Promise.resolve(null)]);
    const c = new P.Container();
    const offS = new P.Sprite(off.tex);
    offS.width = W; offS.height = H;
    c.addChild(offS);
    const sc = { key, def, c, off, lit, offS, litS: null, breath: [], blink: null, screens: [], fx: [], fxT: 0, phase: rnd() * 6, blinkAt: 1 + rnd() * 3, blinkLeft: 0, blinkDouble: false };
    if (def.breath && !reduced) { const b = breathMesh(off.tex, def.breath.rect); c.addChild(b.mesh); sc.breath.push(b); }
    if (lit) {
      sc.litS = new P.Sprite(lit.tex);
      sc.litS.width = W; sc.litS.height = H;
      c.addChild(sc.litS);
      if (def.breath && !reduced) { const b = breathMesh(lit.tex, def.breath.rect); c.addChild(b.mesh); sc.breath.push(b); }
    }
    // her eyes closed: the lids drawn over each eye in the colour of the skin under it (off and lit mixed by the lamp)
    if (def.blink && def.blink.eyes) {
      const g = new P.Graphics();
      g.visible = false;
      const skin = def.blink.eyes.map(([x, y, , ry]) => ({ off: colourAt(off.bmp, x, y + ry * 1.25), lit: lit ? colourAt(lit.bmp, x, y + ry * 1.25) : null }));
      sc.blink = { g, eyes: def.blink.eyes, skin, every: def.blink.every || [3, 6] };
      c.addChild(g);
    } else if (def.blink && def.blink.sprite) {
      // her eyes closed: the pack's patches (cut from the same illustration with only the eyes redrawn), one per lamp
      const atlas = await partsAtlas();
      const patch = (name) => {
        const f = name && atlas && atlas.index[name];
        if (!f) return null;
        const sp = new P.Sprite(new P.Texture({ source: atlas.tex.source, frame: new P.Rectangle(f.x, f.y, f.w, f.h) }));
        sp.position.set(def.blink.at[0], def.blink.at[1]);
        sp.width = f.w; sp.height = f.h;
        return sp;
      };
      const pOff = patch(def.blink.sprite.off), pLit = patch(def.blink.sprite.lit);
      if (pOff) {
        const g = new P.Container();
        g.visible = false;
        g.addChild(pOff);
        if (pLit) g.addChild(pLit);
        sc.blink = { g, pLit, every: def.blink.every || [3, 6] };
        c.addChild(g);
      }
    }
    // screens
    const screens = st.view.state === key && st.view.screens ? st.view.screens : IRP.screensFor(room, key);
    for (const [id, kind] of Object.entries(screens)) sc.screens.push(makeScreen(id, kind, def));
    for (const s of sc.screens) c.addChild(s.mesh, s.glow);
    setSceneLamp(sc, st.lamp);
    return sc;
  }
  function makeScreen(id, kind, def) {
    const S = room.screens[id];
    const corners = (def.screens[id] && def.screens[id].corners) || S.corners;
    const [w, h] = S.size;
    const screen = SC.create(kind, { w, h, room, images: content.images, frames: content.frames, seed: id.length * 31 + kind.length });
    screen.update(0, ctxOfScreen());
    const texture = P.Texture.from(screen.canvas);
    const mesh = new P.PerspectiveMesh({ texture, verticesX: 10, verticesY: 10, x0: corners[0][0], y0: corners[0][1], x1: corners[1][0], y1: corners[1][1], x2: corners[2][0], y2: corners[2][1], x3: corners[3][0], y3: corners[3][1] });
    const g = new P.Sprite(SOFT);
    g.anchor.set(0.5);
    g.blendMode = 'add';
    const cx = corners.reduce((a, p) => a + p[0], 0) / 4, cy = corners.reduce((a, p) => a + p[1], 0) / 4;
    g.position.set(cx, cy);
    g.width = g.height = ((S.glow && S.glow.r) || 120) * 2;
    g.tint = S.glow && S.glow.color ? parseInt(S.glow.color.slice(1), 16) : 0xddeeff;
    return { id, kind, content: screen, texture, mesh, glow: g, corners };
  }
  function rebuildScreens(sc) {
    for (const s of sc.screens) { s.mesh.destroy(); s.glow.destroy(); s.texture.destroy(true); }
    sc.screens = [];
    for (const [id, kind] of Object.entries(st.view.screens || {})) sc.screens.push(makeScreen(id, kind, sc.def));
    for (const s of sc.screens) sc.c.addChild(s.mesh, s.glow);
  }
  function setSceneLamp(sc, L) {
    if (sc.litS) sc.litS.alpha = L;
    if (sc.breath[1]) sc.breath[1].mesh.alpha = L;
  }
  function drawBlink(sc) {
    const b = sc.blink;
    if (!b.eyes) { if (b.pLit) b.pLit.alpha = st.lamp; return; }
    b.g.clear();
    b.eyes.forEach(([x, y, rx, ry], i) => {
      const s = b.skin[i];
      const col = s.lit ? mixC(s.off, s.lit, st.lamp) : s.off;
      b.g.ellipse(x, y + ry * 0.1, rx * 1.12, ry * 1.08).fill({ color: rgb(col) });
      const lash = mixC([40, 34, 90], [70, 40, 50], st.lamp);
      b.g.moveTo(x - rx * 1.05, y + ry * 0.05).quadraticCurveTo(x, y + ry * 0.75, x + rx * 1.05, y + ry * 0.05).stroke({ width: Math.max(2.4, ry * 0.26), color: rgb(lash), cap: 'round' });
    });
  }
  function stepScene(sc, dt, active) {
    const def = sc.def;
    if (def.breath && sc.breath.length) {
      sc.phase += (dt * Math.PI * 2) / def.breath.period;
      const sway = def.sway ? Math.sin((st.t * def.sway.bpm * Math.PI) / 60) * def.sway.amp : 0;
      for (const b of sc.breath) stepBreath(b, def.breath, sc.phase, sway);
    }
    // blink: every 3–6 s, about 0.13 s, now and then twice; paused while a crossfade runs
    if (sc.blink && active && !st.fades.length) {
      if (sc.blinkLeft > 0) {
        sc.blinkLeft -= dt;
        if (sc.blinkLeft <= 0) { sc.blink.g.visible = false; if (sc.blinkDouble) { sc.blinkDouble = false; sc.blinkAt = 0.12; } else { const [a, b] = sc.blink.every; sc.blinkAt = a + rnd() * (b - a); } }
      } else {
        sc.blinkAt -= dt;
        if (sc.blinkAt <= 0) { drawBlink(sc); sc.blink.g.visible = true; sc.blinkLeft = 0.13; sc.blinkDouble = rnd() < 0.2 && !sc.wasDouble; sc.wasDouble = sc.blinkDouble; st.blinks += 1; }
      }
    }
    for (const s of sc.screens) {
      if (s.content.update(dt, ctxOfScreen())) s.texture.source.update();
      const lum = s.content.brightness();
      s.glow.alpha = (s.kind === 'lock' ? 0.18 : 0.28 + lum * 0.45) * (1 - st.lamp * 0.3);
    }
    // Z / ♪ rising from her
    if (active && def.fx && !reduced) for (const f of def.fx) {
      sc.fxT -= dt;
      if (sc.fxT <= 0) {
        sc.fxT = f.every || 1.5;
        const glyph = f.glyph === 'note' ? (rnd() < 0.5 ? '♪' : '♫') : 'Z';
        const t = new P.Text({ text: glyph, style: { fontFamily: 'Noto Sans CJK SC, sans-serif', fontSize: glyph === 'Z' ? 46 : 54, fontWeight: '800', fill: glyph === 'Z' ? '#dbe8ff' : '#ffe9a8', stroke: { color: '#1c2f63', width: 4 } } });
        t.anchor.set(0.5);
        t.position.set(f.from[0] + (rnd() - 0.5) * 30, f.from[1]);
        fxLayer.addChild(t);
        sc.fx.push({ t, age: 0, rise: f.rise || 80, dx: (rnd() - 0.5) * 40 });
      }
    }
    for (const p of sc.fx) {
      p.age += dt;
      p.t.y -= (p.rise / 2.2) * dt;
      p.t.x += (p.dx / 2.2) * dt;
      p.t.alpha = Math.max(0, 1 - p.age / 2.2) * (st.fades.length ? 0.5 : 1);
      p.t.scale.set(0.7 + p.age * 0.2);
    }
    sc.fx = sc.fx.filter((p) => { if (p.age < 2.2) return true; p.t.destroy(); return false; });
  }
  function disposeScene(sc) {
    for (const p of sc.fx) p.t.destroy();
    for (const s of sc.screens) s.texture.destroy(true);
    sc.c.destroy({ children: true });
  }
  const ctxOfScreen = () => ({ progress: runProgress(), query: st.view.query, clip: st.view.clip || 0 });

  // ---- crossfade ---------------------------------------------------------------------------------------------
  const ease = (k) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, k)));
  async function crossfade(key, seconds) {
    const next = await buildScene(key);
    const from = st.scene;
    next.c.alpha = from ? 0 : 1;
    scenes.addChild(next.c);
    st.scene = next;
    if (!from) return;
    const rec = { from: from.key, to: key, seconds, at: Date.now(), both: 0, done: false };
    st.transitions.push(rec);
    if (st.transitions.length > 20) st.transitions.shift();
    await new Promise((resolve) => st.fades.push({ from, to: next, t: 0, seconds, rec, resolve }));
  }
  function stepFades(dt) {
    for (const f of st.fades) {
      f.t += dt;
      const k = ease(f.t / f.seconds);
      f.to.c.alpha = k;
      if (k > 0.3 && k < 0.7) f.rec.both += 1; // frames where both of her were visible (the crossfade's middle)
      if (f.t >= f.seconds) { f.to.c.alpha = 1; f.rec.done = true; disposeScene(f.from); f.resolve(); }
    }
    st.fades = st.fades.filter((f) => f.t < f.seconds);
  }
  // play a path from main: [state…] (床 → 书桌 goes through 起身 when the pack has one)
  async function playPath(path) {
    if (!path || !path.length) return;
    st.path.push(...path);
    if (st.pathBusy) return;
    st.pathBusy = true;
    try {
      while (st.path.length) {
        const key = st.path.shift();
        if (st.scene && st.scene.key === key && !st.path.length) { rebuildScreens(st.scene); continue; }
        const def = room.states[key];
        const total = (room.transition && room.transition.seconds) || 1.4;
        const s = def.transient ? total * 0.6 : st.path.length ? total * 0.6 : total;
        await crossfade(key, reduced ? 0.3 : s);
        if (def.transient) await new Promise((r) => setTimeout(r, (def.hold || 0.6) * 1000));
      }
    } catch (e) { st.errors.push(String(e.message || e)); }
    st.pathBusy = false;
    placeBubble();
  }

  // ---- main's answers ----------------------------------------------------------------------------------------
  function setView(v) {
    if (!v || !v.state) return;
    st.view = { ...st.view, ...v };
    if (v.run) st.runLocal = { at: performance.now(), elapsed0: v.run.elapsed || 0, seconds: v.run.seconds || 1 };
    else st.runLocal = null;
    st.ticking = false;
    renderBar();
    renderStats();
  }
  function runProgress() {
    if (!st.runLocal) return 0;
    const el = st.runLocal.elapsed0 + (performance.now() - st.runLocal.at) / 1000;
    return Math.max(0, Math.min(1, el / st.runLocal.seconds));
  }
  // play what main decided (an answer to a command, or pushed: game:room from the chat)
  async function apply(r, { via = null } = {}) {
    if (!r) return;
    st.events.push({ at: Date.now(), via: via || r.via || null, ok: r.ok, reason: r.reason || null, from: r.from || null, to: r.to || r.state || null, path: r.path || [], lamp: r.lamp, screens: r.screens || null, settled: r.settled ? { kind: r.settled.kind, complete: r.settled.complete, fraction: r.settled.fraction } : null, words: r.words || null });
    if (st.events.length > 80) st.events.shift();
    const prevScreens = JSON.stringify(st.view.screens || {});
    const prevQuery = st.view.query;
    const prevClip = st.view.clip;
    setView(r);
    setLampTarget(!!r.lamp);
    if (r.ok === false && r.reason === 'tired') { say(r.line || '好累……', { hold: 4 }); flashTired(r.kind); }
    if (r.settled && r.settled.summary) toast(r.settled.summary);
    for (const q of r.completed || []) toast(`今日小事完成：${q.title}${q.affection && q.affection.delta ? `（好感 +${q.affection.delta}）` : ''}`);
    if (r.settled) pulseCapsule();
    if (r.ok === false && r.reason === 'tired') return;
    if (r.path && r.path.length) { if (r.line) say(r.line, { hold: 3.5 }); await playPath(r.path); }
    else if (st.scene && (JSON.stringify(r.screens || {}) !== prevScreens || r.query !== prevQuery)) { rebuildScreens(st.scene); if (r.line) say(r.line, { hold: 3 }); }
    else if (r.line) say(r.line, { hold: 3 });
    if (r.clip !== prevClip && st.scene) for (const s of st.scene.screens) if (s.kind === 'clips') s.content.next();
  }
  async function command(cmd) {
    try {
      const r = await window.game.room({ cmd: 'set', ...cmd });
      await apply(r, { via: cmd.from });
      return r;
    } catch (e) { st.errors.push(String(e.message || e)); return null; }
  }
  window.game.onRoom((r) => apply(r, { via: 'chat' }));

  // ---- bubble ------------------------------------------------------------------------------------------------
  function placeBubble() {
    const el = $('bubble');
    const def = st.scene ? st.scene.def : room.states[st.view.state];
    const at = (def && def.bubble) || [W / 2, H / 3];
    const [x, y] = toScreen(at[0], at[1]);
    const r = el.getBoundingClientRect();
    const half = Math.max(60, r.width / 2);
    el.style.left = `${Math.max(half + 8, Math.min(app.screen.width - half - 8, x))}px`;
    el.style.top = `${Math.max(r.height + 44, y)}px`;
  }
  function say(text, { hold = 4 } = {}) {
    if (!text) return;
    const el = $('bubble');
    el.textContent = text;
    el.classList.remove('hidden');
    st.bubbleText = text;
    st.bubbleT = hold + Math.min(6, text.length * 0.08);
    placeBubble();
  }
  // her reply in chat, as it is written (chat-delta) and when it is done (say)
  window.game.onSayDelta((d) => { if (d && d.kind === 'chat' && d.text) { st.bubbleStream = d.id; say(d.text, { hold: 8 }); } });
  window.game.onSay((m) => { if (m && m.kind === 'chat' && m.text) { st.bubbleStream = null; say(m.text, { hold: 8 }); st.lastReply = m.text; if (st.saidT > 0) st.saidT = 10; } });
  window.game.onThinking((on) => { st.thinking = !!on; renderChat(); });

  // ---- status bar, capsule, stats card, 屏幕 card ----------------------------------------------------------
  const STAT_LABEL = { energy: '精力', mood: '心情', focus: '专注', fullness: '饱腹' };
  const STAT_COLOR = { energy: '#ffd36e', mood: '#ff9ab8', focus: '#8fd0ff', fullness: '#b7e48a' };
  function tiredFor(k) {
    const need = M.activities[k] && M.activities[k].needs && M.activities[k].needs.energy;
    const have = st.view.stats ? st.view.stats.energy : 100;
    return need && have < need ? { need, have } : null;
  }
  function renderBar() {
    const act = st.view.activity;
    for (const b of document.querySelectorAll('#ir-bar .ir-act[data-kind]')) {
      const k = b.dataset.kind;
      const on = k === act && !isVariant(st.view.state);
      b.classList.toggle('current', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const t = tiredFor(k);
      b.classList.toggle('tired', !!t && k !== act);
      b.title = t ? `${M.activities[k].label}：太累了（精力 ${t.have}，要 ${t.need}）· 先让她睡一觉` : `${M.activities[k].label}（${KINDS.indexOf(k) + 1}）`;
    }
    for (const b of document.querySelectorAll('#ir-bar .ir-act[data-state]')) {
      const on = b.dataset.state === st.view.state;
      b.classList.toggle('current', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  function renderProgress() {
    const act = st.view.activity;
    const p = runProgress();
    for (const b of document.querySelectorAll('#ir-bar .ir-act[data-kind]')) b.querySelector('.ir-prog b').style.width = b.dataset.kind === act && st.runLocal ? `${Math.round(p * 100)}%` : '0%';
  }
  function renderStats() {
    const s = st.view.stats || {};
    capsule.innerHTML = `<span title="精力">⚡${s.energy ?? '–'}</span><span title="心情">♥${s.mood ?? '–'}</span>`;
    $('ir-stats-list').innerHTML = ['energy', 'mood', 'focus', 'fullness'].map((k) => `<li data-stat="${k}" data-value="${s[k] ?? 0}"><span>${STAT_LABEL[k]}</span><i class="ir-track"><b style="width:${Math.max(0, Math.min(100, s[k] ?? 0))}%;background:${STAT_COLOR[k]}"></b></i><em>${s[k] ?? '–'}</em></li>`).join('');
    const last = st.view.last;
    const lab = (k) => (M.activities[k] && M.activities[k].label) || k;
    $('ir-last').textContent = last ? `上一件：${lab(last.kind)}${last.complete ? '（完成）' : `（做了 ${Math.round((last.fraction || 0) * 100)}%）`}` : '还没做过什么';
    $('ir-quests').innerHTML = (st.view.quests || []).map((q) => `<li class="${q.done ? 'done' : ''}"><i>${q.done ? '✓' : ''}</i>${q.title}</li>`).join('');
  }
  function pulseCapsule() { capsule.classList.remove('pulse'); void capsule.offsetWidth; capsule.classList.add('pulse'); }
  function flashTired(k) { const b = document.querySelector(`#ir-bar .ir-act[data-kind="${k}"]`); if (b) { b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); } }
  function openStats(on) { st.statsOpen = on; $('ir-stats').classList.toggle('hidden', !on); capsule.setAttribute('aria-expanded', on ? 'true' : 'false'); }
  capsule.addEventListener('click', () => openStats(!st.statsOpen));
  const pip = $('ir-pip-canvas');
  const pipG = pip.getContext('2d');
  const SCREEN_NAME = { phone: '手机', laptop: '电脑' };
  const KIND_NAME = { clips: '在刷短视频', page: '网页', player: '正在播放', game: '游戏中', lock: '锁屏', chat: '聊天', off: '关着' };
  function mainScreen() {
    const sc = st.scene;
    if (!sc || !sc.screens.length) return null;
    return sc.screens.find((s) => s.kind !== 'lock') || sc.screens[0];
  }
  let pipKey = '';
  function renderPip() {
    const s = mainScreen();
    $('ir-pip').classList.toggle('hidden', !st.pipOpen || !s);
    // the card sits on the side she is not on: right while she is in bed (left of the picture), left at the desk
    $('ir-pip').classList.toggle('right', IRP.zoneOf(room, st.view.state) !== 'desk');
    if (!s || !st.pipOpen) return;
    const portrait = s.content.canvas.height > s.content.canvas.width;
    const key = `${s.id}:${s.kind}:${portrait}`;
    if (key !== pipKey) {
      pipKey = key;
      pip.width = portrait ? 144 : 320;
      pip.height = portrait ? 256 : 200;
      $('ir-pip').classList.toggle('landscape', !portrait);
    }
    pipG.drawImage(s.content.canvas, 0, 0, pip.width, pip.height);
    const info = s.content.info();
    $('ir-pip-title').textContent = `${SCREEN_NAME[s.id] || '屏幕'} · ${KIND_NAME[s.kind] || ''}`;
    $('ir-pip-cap').textContent = s.kind === 'clips' && info.clip ? info.clip.caption : s.kind === 'player' && info.track ? `《${info.track.title}》 ${info.track.time}` : s.kind === 'page' ? (st.view.query ? `搜索：${st.view.query}` : (info.page && info.page.title) || '') : s.kind === 'game' ? `得分 ${info.score}` : '';
  }
  $('ir-pip-close').addEventListener('click', () => { st.pipOpen = false; renderPip(); });

  // ---- chat bar ---------------------------------------------------------------------------------------------
  function renderChat() {
    const busy = st.chatBusy || st.thinking;
    $('ir-chat-send').disabled = busy;
    $('ir-chat-input').disabled = false;
    $('ir-chat-note').textContent = busy ? '她在想…' : st.chatNote;
    $('ir-chat').classList.toggle('busy', busy);
  }
  $('ir-chat').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('ir-chat-input');
    const text = input.value.trim();
    if (!text || st.chatBusy) return;
    input.value = '';
    // what the owner just said stays above the bar for a while (her answer is in her bubble)
    $('ir-said').textContent = `你：${text}`;
    $('ir-said').classList.remove('hidden');
    st.saidT = 90; // until her answer is in (then a little longer: onSay)
    st.chatBusy = true;
    st.chatNote = '';
    st.lastSent = text;
    renderChat();
    let r = null;
    try { r = await window.game.chat(text); } catch (err) { r = { ok: false, reason: 'error', message: String(err.message || err) }; }
    st.chatBusy = false;
    st.lastChat = r;
    if (r && r.ok === false && st.saidT > 0) st.saidT = 6;
    if (r && r.ok === false) st.chatNote = r.reason === 'busy' ? '她还在回上一句，等一下再说' : r.reason === 'canceled' ? '' : '现在连不上她（没登录或离线）——下面的按钮照样能用';
    renderChat();
  });

  // ---- input: bar, hotspots, keys ------------------------------------------------------------------------------
  for (const b of document.querySelectorAll('#ir-bar .ir-act[data-kind]')) b.addEventListener('click', () => command({ state: b.dataset.kind, from: 'click' }));
  for (const b of document.querySelectorAll('#ir-bar .ir-act[data-state]')) b.addEventListener('click', () => command({ state: b.dataset.state, from: 'click' }));
  $('ir-lamp').addEventListener('click', () => command({ lamp: st.lampTarget !== 1, from: 'click' }));
  $('btn-close').addEventListener('click', () => window.game.close('button'));
  const HOT = room.hotspots || [];
  const inPoly = (x, y, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const hotAt = (sx, sy) => { const [x, y] = toWorld(sx, sy); return HOT.find((h) => inPoly(x, y, h.poly)) || null; };
  const hotLabel = (h) => (h.toggle === 'lamp' ? `${st.lampTarget ? '关灯' : '开灯'} · ${h.label}` : `${(room.states[h.state] && room.states[h.state].label) || h.state} · ${h.label}`);
  function drawHover() {
    hoverG.clear();
    const h = st.hover;
    if (!h) return;
    hoverG.poly(h.poly.flat()).fill({ color: 0xffffff, alpha: 0.05 }).stroke({ width: 4 / fit.k, color: 0xdfeaff, alpha: 0.75, join: 'round' });
  }
  const canvasEl = app.canvas;
  canvasEl.addEventListener('pointermove', (e) => {
    const r = canvasEl.getBoundingClientRect();
    const h = hotAt(e.clientX - r.left, e.clientY - r.top);
    if (h !== st.hover) { st.hover = h; drawHover(); }
    const tip = $('tip');
    if (h) {
      st.tipText = hotLabel(h);
      tip.textContent = st.tipText;
      tip.classList.remove('hidden');
      tip.style.left = `${e.clientX}px`;
      tip.style.top = `${e.clientY}px`;
      canvasEl.style.cursor = 'pointer';
    } else { tip.classList.add('hidden'); st.tipText = ''; canvasEl.style.cursor = 'default'; }
  });
  canvasEl.addEventListener('pointerleave', () => { st.hover = null; drawHover(); $('tip').classList.add('hidden'); });
  canvasEl.addEventListener('click', (e) => {
    const r = canvasEl.getBoundingClientRect();
    const h = hotAt(e.clientX - r.left, e.clientY - r.top);
    if (!h) return;
    if (h.toggle === 'lamp') command({ lamp: st.lampTarget !== 1, from: 'hotspot' });
    else command({ state: h.state, from: 'hotspot' });
  });
  window.addEventListener('keydown', (e) => {
    const typing = document.activeElement && document.activeElement.id === 'ir-chat-input';
    if (e.key === 'Escape') { if (st.statsOpen) openStats(false); else if (typing) document.activeElement.blur(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^[1-6]$/.test(e.key)) { command({ state: KINDS[Number(e.key) - 1], from: 'key' }); e.preventDefault(); }
    else if (/^[7-9]$/.test(e.key) && VARIANT_KEYS[Number(e.key) - 7]) { command({ state: VARIANT_KEYS[Number(e.key) - 7], from: 'key' }); e.preventDefault(); }
    else if (e.key === 'l' || e.key === 'L') command({ lamp: st.lampTarget !== 1, from: 'key' });
    else if (e.key === '/') { $('ir-chat-input').focus(); e.preventDefault(); }
  });

  // ---- toast -------------------------------------------------------------------------------------------------
  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    st.lastToast = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  // ---- the ticker ----------------------------------------------------------------------------------------------
  let fpsAcc = 0, fpsN = 0;
  app.ticker.add((tk) => {
    const dt = Math.min(0.1, tk.deltaMS / 1000);
    st.t += dt;
    st.frames += 1;
    fpsAcc += dt; fpsN += 1;
    if (fpsAcc >= 1) { st.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    stepLamp(dt);
    stepWindow(dt);
    stepFades(dt);
    for (const f of st.fades) stepScene(f.from, dt, false);
    if (st.scene) stepScene(st.scene, dt, true);
    renderPip();
    renderProgress();
    if (st.bubbleT > 0) { st.bubbleT -= dt; if (st.bubbleT <= 0) $('bubble').classList.add('hidden'); }
    if (st.saidT > 0) { st.saidT -= dt; if (st.saidT <= 0) $('ir-said').classList.add('hidden'); }
    // the round's time is up by this page's clock: main settles it when its clock agrees
    if (st.runLocal && runProgress() >= 1 && !st.ticking) {
      st.ticking = true;
      window.game.room({ cmd: 'tick' }).then((r) => { if (r && r.settled) apply(r, { via: 'tick' }); else setTimeout(() => { st.ticking = false; }, 400); }).catch(() => { st.ticking = false; });
    }
    st.seenT -= dt;
    if (st.seenT <= 0) { st.seenT = 10; if (st.runLocal) window.game.room({ cmd: 'seen' }).catch(() => {}); }
  });
  window.game.onHidden(() => { app.ticker.stop(); });
  window.game.onShown(async () => {
    app.ticker.start();
    const r = await window.game.room({ cmd: 'state' });
    if (r && r.ok) { setView(r); setLampTarget(!!r.lamp); if (st.scene && st.scene.key !== r.state) await playPath([r.state]); }
  });
  window.game.onView((v) => { if (v && v.name) $('who').textContent = `${v.name}的房间 · ${room.name}`; });
  window.addEventListener('resize', () => { layout(); placeBubble(); });

  // ---- go ------------------------------------------------------------------------------------------------------
  layout();
  st.lamp = st.lampTarget;
  $('ir-lamp').setAttribute('aria-pressed', st.lampTarget ? 'true' : 'false');
  $('ir-lamp').classList.toggle('on', !!st.lampTarget);
  try {
    await crossfade(V0.state || room.defaultState, 0.01);
  } catch (e) {
    $('loading').textContent = `房间没能打开：${e.message}`;
    st.errors.push(String(e.message));
    return;
  }
  // the pictures the status bar may ask for next are decoded in the background
  for (const s of Object.values(room.states)) { load(s.images.off).catch(() => {}); if (s.images.lit) load(s.images.lit).catch(() => {}); }
  setView(V0);
  renderChat();
  if (boot.view && boot.view.name) $('who').textContent = `${boot.view.name}的房间 · ${room.name}`;
  $('loading').classList.add('hidden');
  if (V0.recovered) setTimeout(() => toast(`${V0.recovered.summary || ''}（上次没结束的，这次打开时结算）`), 600);
  else setTimeout(() => say(IRP.line(room, 'enter'), { hold: 3 }), 500);

  // ---- e2e read-out and handles -----------------------------------------------------------------------------------
  const rectOf = (el) => { if (!el || el.classList.contains('hidden')) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  const centre = (poly) => { const [x, y] = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]); return toScreen(x, y); };
  window.__game = () => {
    const sc = st.scene;
    const b = sc && sc.breath[0];
    return {
      ready: true, engine: 'illustrated-room@1', id: M.id, name: M.name, version: M.version, fps: st.fps, frames: st.frames, renderer: app.renderer.name,
      room: room.id, state: st.view.state, activity: st.view.activity, shown: sc ? sc.key : null,
      lamp: { on: st.lampTarget === 1, level: Math.round(st.lamp * 1000) / 1000, glowAlpha: Math.round(lampGlow.alpha * 1000) / 1000, litAlpha: sc && sc.litS ? Math.round(sc.litS.alpha * 1000) / 1000 : null, grade: grade.matrix.slice(0, 15).filter((_, i) => i % 6 === 0).map((v) => Math.round(v * 1000) / 1000) },
      window: { rain: rain.length, drops: drops.length, bokeh: bokeh.length, bokehAlpha: bokeh.slice(0, 6).map((x) => Math.round(x.s.alpha * 100) / 100), rainY: rain.slice(0, 3).map((d) => Math.round(d.y)) },
      breath: b ? { offset: Math.round((b.buf.data[(4 * 9 + 4) * 2 + 1] - b.base[(4 * 9 + 4) * 2 + 1]) * 100) / 100, phase: Math.round(sc.phase * 100) / 100 } : null,
      blink: { count: st.blinks, closed: !!(sc && sc.blink && sc.blink.g.visible), has: !!(sc && sc.blink), patch: !!(sc && sc.blink && !sc.blink.eyes) },
      screens: sc ? sc.screens.map((s) => ({ id: s.id, kind: s.kind, corners: s.corners, glow: Math.round(s.glow.alpha * 100) / 100, ...s.content.info() })) : [],
      fx: fxLayer.children.map((t) => t.text),
      transitions: st.transitions.map((t) => ({ ...t })), fading: st.fades.length > 0, scenesOnStage: scenes.children.length,
      view: { ...st.view }, run: st.runLocal ? { progress: runProgress(), seconds: st.runLocal.seconds } : null,
      bubble: { text: st.bubbleT > 0 ? st.bubbleText : null, rect: rectOf($('bubble')) },
      bar: [...document.querySelectorAll('#ir-bar .ir-act')].map((x) => ({ kind: x.dataset.kind || x.dataset.state || 'lamp', current: x.classList.contains('current'), tired: x.classList.contains('tired'), pressed: x.getAttribute('aria-pressed') === 'true', rect: rectOf(x), progress: x.querySelector('.ir-prog b') ? parseFloat(x.querySelector('.ir-prog b').style.width) || 0 : null })),
      capsule: { text: capsule.textContent, open: st.statsOpen, rect: rectOf(capsule) }, statsCard: rectOf($('ir-stats')),
      pip: { open: !$('ir-pip').classList.contains('hidden'), title: $('ir-pip-title').textContent, caption: $('ir-pip-cap').textContent, rect: rectOf($('ir-pip')) },
      chat: { said: st.saidT > 0 ? $('ir-said').textContent : null, rect: rectOf($('ir-chat')), input: rectOf($('ir-chat-input')), note: $('ir-chat-note').textContent, busy: st.chatBusy, last: st.lastChat || null, reply: st.lastReply || null },
      hotspots: HOT.map((h) => ({ id: h.id, state: h.state || null, toggle: h.toggle || null, label: h.label, at: centre(h.poly) })),
      hover: st.hover ? st.hover.id : null, tip: st.tipText,
      toast: st.lastToast, events: st.events.slice(-40), errors: st.errors.slice(),
    };
  };
  window.__gameTest = {
    toScreen, toWorld,
    command, setRoundScale: (k) => window.game.room({ cmd: 'scale', k }),
    nextClip: () => { if (st.scene) for (const s of st.scene.screens) if (s.kind === 'clips') s.content.next(); },
    refresh: async () => { const r = await window.game.room({ cmd: 'state' }); setView(r); return r; },
    openStats,
    // the screen's own canvas, as a data URL: the acceptance's close-ups of what the screen shows
    screenPng: (id) => { const s = st.scene && st.scene.screens.find((x) => (id ? x.id === id : x.kind !== 'lock')); return s ? s.content.canvas.toDataURL('image/png') : null; },
    holdBlink: (seconds) => { const sc = st.scene; if (sc && sc.blink) { drawBlink(sc); sc.blink.g.visible = true; sc.blinkLeft = seconds; } },
  };
})();
