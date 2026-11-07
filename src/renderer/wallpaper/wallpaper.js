'use strict';
// 桌面壁纸 · 页面 (docs/wallpaper-mode.md §2.1). Draws one wallpaper@1 pack (core/wallpaper-pack.js) with PixiJS,
// full window, behind the desktop icons (src/main/wallpaper/host.js puts the window there):
//
//   world          the canvas (design size), fitted onto the display (cover / contain around `focus`)
//   ├ graded       the layers by z (drift + loop scroll sideways; phases fade in / out), her at pet.z — under the
//   │              hour's colour matrix (core/game-sky.js) when sky.tint
//   └ glow         additive: fx.lights and fireflies, at dusk / night
//
// Her: core/game-pet.js on the walk grid of core/game-world.js built from pet.area / pet.blocked, cut to the part of
// the picture that is on screen and above the taskbar / Dock (the host's `clip`); pet.spots are the things she uses
// (sit / sleep …). Her frames come from her own character pack, like in the mini games (a picture / Live2D / VRM look
// is a paper cut-out). Main sets the frame rate (wallpaper:power → ticker.maxFPS; 0 = stopped on the last frame),
// fades her out when she is called out and in when she comes back. Nothing here takes input.
// window.__wallpaper() is the e2e's read-out, window.__wallpaperTest its handles.
(async function () {
  const P = window.PIXI;
  const GW = window.GameWorld;
  const GPet = window.GamePet;
  const SKY = window.GameSky;
  const Fx = window.PetFx;
  const rnd = Math.random;
  const st = { ready: false, frames: 0, fps: 0, maxFps: 30, why: 'boot', t: 0, hour: 12, clicks: 0, error: null, pet: { visible: false, alpha: 0, target: 0 }, sprite: null, phase: 'day', lastReport: 0 };
  addEventListener('mousedown', () => { st.clicks += 1; });
  window.__wallpaper = () => ({
    ready: st.ready, frames: st.frames, fps: st.fps, maxFps: st.maxFps, why: st.why, hour: st.hour, phase: st.phase, clicks: st.clicks, error: st.error,
    size: { w: innerWidth, h: innerHeight }, hidden: document.visibilityState === 'hidden',
    layers: layers.map((l) => ({ id: l.def.id, z: l.def.z, alpha: Math.round(l.node.alpha * 100) / 100, x: Math.round(l.node.x) })),
    pet: pet ? { ...pet.state(), visible: st.pet.visible, alpha: Math.round(st.pet.alpha * 100) / 100, kind: st.sprite ? st.sprite.kind : null } : null,
    fit: fitNow, clip: boot && boot.clip,
  });

  const boot = await window.wallpaper.boot();
  const layers = [];
  let pet = null;
  let fitNow = null;
  if (!boot || !boot.wallpaper) { st.error = 'no-boot'; return; }
  const M = boot.wallpaper;
  const C = M.canvas;
  const BASE = boot.base;
  const PET_H = M.pet.height;
  const RES = 2;

  P.TextureSource.defaultOptions.scaleMode = 'nearest';
  const app = new P.Application();
  await app.init({ resizeTo: document.getElementById('stage'), background: C.background, antialias: false, resolution: 1, preference: 'webgl', powerPreference: 'low-power', preserveDrawingBuffer: !!boot.staticShot });
  document.getElementById('stage').appendChild(app.canvas);
  app.ticker.maxFPS = boot.fps || 30;

  const world = new P.Container();
  const graded = new P.Container();
  graded.sortableChildren = true;
  const glow = new P.Container();
  world.addChild(graded, glow);
  app.stage.addChild(world);
  const grade = new P.ColorMatrixFilter();
  if (M.sky.tint) graded.filters = [grade];

  async function loadTexture(url) {
    const blob = await fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status} ${url}`))));
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
    return P.Texture.from(bmp);
  }

  // ---- layers: each picture stretched over the whole canvas; drift + loop: two copies side by side ---------
  const BLEND = { normal: 'normal', add: 'add', screen: 'screen', multiply: 'multiply' };
  try {
    const texs = await Promise.all(M.layers.map((l) => loadTexture(BASE + l.image)));
    M.layers.forEach((def, i) => {
      const node = new P.Container();
      const copies = def.loop && def.drift ? 2 : 1;
      const sprites = [];
      for (let k = 0; k < copies; k++) {
        const s = new P.Sprite(texs[i]);
        s.width = C.width;
        s.height = C.height;
        s.x = k * C.width;
        s.blendMode = BLEND[def.blend] || 'normal';
        node.addChild(s);
        sprites.push(s);
      }
      node.zIndex = def.z;
      node.alpha = def.opacity;
      graded.addChild(node);
      layers.push({ def, node, sprites, ox: 0, oy: 0 });
    });
  } catch (e) {
    st.error = String(e && e.message);
  }

  // ---- her: frames from her pack, like the mini games ------------------------------------------------------
  const USED = ['idle', 'walk', 'play', 'pat', 'look', 'sleep', 'happy', 'think', 'eat'];
  const ACTION_OF = { eat: 'eat_fruit' };
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  function opaqueBox(src, sx, sy, sw, sh) {
    const k = 8;
    const w = Math.max(1, Math.round(sw / k));
    const h = Math.max(1, Math.round(sh / k));
    const c = canvas(w, h);
    const x = c.getContext('2d');
    x.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (d[(yy * w + xx) * 4 + 3] > 40) { x0 = Math.min(x0, xx); y0 = Math.min(y0, yy); x1 = Math.max(x1, xx); y1 = Math.max(y1, yy); }
    if (x1 < 0) return { x: sx, y: sy, w: sw, h: sh };
    return { x: sx + x0 * k, y: sy + y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
  }
  function shrink(src, sx, sy, sw, sh, h, crop = 1) {
    const w = Math.max(1, Math.round((sw * h) / sh));
    const ch = Math.max(1, Math.round(h * crop));
    const out = canvas(w + 4, ch + 4);
    const o = out.getContext('2d');
    o.imageSmoothingQuality = 'high';
    const sil = canvas(w, ch);
    const sx2 = sil.getContext('2d');
    sx2.drawImage(src, sx, sy, sw, sh * crop, 0, 0, w, ch);
    const body = canvas(w, ch);
    body.getContext('2d').drawImage(sil, 0, 0);
    sx2.globalCompositeOperation = 'source-in';
    sx2.fillStyle = 'rgba(20,24,18,0.8)';
    sx2.fillRect(0, 0, w, ch);
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) o.drawImage(sil, 2 + dx, 2 + dy);
    o.drawImage(body, 2, 2);
    return out;
  }
  async function loadSprite(look) {
    const sprite = { kind: 'placeholder', frames: {}, actions: {} };
    try {
      if (!look || !look.url) throw new Error('no art');
      const blob = await fetch(look.url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
      const bmp = await createImageBitmap(blob);
      const H = PET_H * RES;
      const add = (name, canvases, fps) => { sprite.frames[name] = canvases.map((c) => P.Texture.from(c)); sprite.actions[name] = { fps: fps || 2 }; };
      if (look.kind === 'sprites' && look.frame && look.actions) {
        const fw = look.frame.width;
        const fh = look.frame.height;
        const idle = look.actions.idle || Object.values(look.actions)[0];
        const ref = opaqueBox(bmp, idle.col * fw, idle.row * fh, fw, fh);
        const top = Math.max(0, ref.y - idle.row * fh - Math.round(ref.h * 0.12));
        const bottom = Math.min(fh, ref.y - idle.row * fh + ref.h + 6);
        const k = H / ref.h;
        const cut = (a, i, crop) => shrink(bmp, (a.col + i) * fw, a.row * fh + top, fw, bottom - top, Math.round((bottom - top) * k), crop);
        for (const want of USED) {
          const name = Fx.resolveAction(ACTION_OF[want] || want, (n) => !!look.actions[n]).name;
          const a = look.actions[name] || idle;
          add(want, Array.from({ length: a.frames || 1 }, (_, i) => cut(a, i)), a.fps);
        }
        const waist = (look.halfBody && look.halfBody.waist) || 0.55;
        add('sit', Array.from({ length: idle.frames || 1 }, (_, i) => cut(idle, i, waist + 0.06)), idle.fps);
        sprite.kind = 'sprites';
      } else {
        const box = opaqueBox(bmp, 0, 0, bmp.width, bmp.height);
        const one = shrink(bmp, box.x, box.y, box.w, box.h, H);
        for (const want of [...USED, 'sit']) add(want, [one], 1);
        sprite.kind = 'paper';
      }
      if (bmp.close) bmp.close();
    } catch (e) {
      sprite.error = String(e && e.message);
    }
    st.sprite = sprite;
    petSprite.visible = sprite.kind !== 'placeholder';
  }
  const petSprite = new P.Sprite(P.Texture.EMPTY);
  petSprite.anchor.set(0.5, 1);
  petSprite.zIndex = M.pet.z + 0.5;
  petSprite.alpha = 0;
  graded.addChild(petSprite);

  // her walk grid: pet.area, minus what is off screen / under the taskbar (clip), minus pet.blocked
  function makeWorld(clip) {
    const area = clip ? M.pet.area.map(([x, y]) => [Math.min(Math.max(x, clip[0]), clip[2]), Math.min(Math.max(y, clip[1]), clip[3])]) : M.pet.area;
    return GW.createWorld({ width: C.width, height: C.height, walk: { cell: Math.max(8, Math.round(C.width / 240)), area, blocked: M.pet.blocked } });
  }
  const spots = M.pet.spots.map((s) => ({ id: s.id, use: { at: s.at, anim: s.anim, seconds: s.seconds, face: s.face || undefined, phases: s.phases || undefined } }));
  function makePet(at) {
    const w = makeWorld(boot.clip);
    const start = at && GW.walkableAt(w, at[0], at[1]) ? at : at ? (() => { const c = GW.nearestOpen(w, at[0], at[1]); return c ? GW.centerOf(w, c[0], c[1]) : M.pet.spawn; })() : M.pet.spawn;
    pet = GPet.createGamePet({ world: w, objects: spots, rnd, start, speed: M.pet.speed });
  }
  if (boot.pet && boot.pet.visible) { makePet(boot.pet.at); st.pet = { visible: true, alpha: boot.staticShot ? 1 : 0, target: 1 }; }
  await loadSprite(boot.view && boot.view.look);

  // ---- lights and fireflies --------------------------------------------------------------------------------
  const halo = (() => {
    const c = canvas(128, 128);
    const x = c.getContext('2d');
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,214,140,0.9)');
    g.addColorStop(1, 'rgba(255,214,140,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 128, 128);
    return P.Texture.from(c);
  })();
  const lights = M.fx.lights.map((l) => {
    const s = new P.Sprite(halo);
    s.anchor.set(0.5);
    s.width = s.height = l.r * 2;
    s.position.set(l.x, l.y);
    s.blendMode = 'add';
    s.alpha = 0;
    glow.addChild(s);
    return { def: l, s };
  });
  const flies = Array.from({ length: M.fx.fireflies }, () => {
    const s = new P.Sprite(halo);
    s.anchor.set(0.5);
    s.width = s.height = Math.max(6, C.width / 220);
    s.blendMode = 'add';
    s.alpha = 0;
    glow.addChild(s);
    const a = M.pet.area;
    const xs = a.map((p) => p[0]);
    const ys = a.map((p) => p[1]);
    return { s, x: Math.min(...xs) + rnd() * (Math.max(...xs) - Math.min(...xs)), y: Math.min(...ys) - rnd() * C.height * 0.2, ph: rnd() * 6.28 };
  });

  // ---- fit the canvas onto the window ---------------------------------------------------------------------
  function fit() {
    const W = app.screen.width;
    const H = app.screen.height;
    const sx = W / C.width;
    const sy = H / C.height;
    const k = C.fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
    const w = C.width * k;
    const h = C.height * k;
    const x = C.fit === 'contain' ? (W - w) / 2 : Math.min(0, Math.max(W - w, W / 2 - C.focus[0] * w));
    const y = C.fit === 'contain' ? (H - h) / 2 : Math.min(0, Math.max(H - h, H / 2 - C.focus[1] * h));
    world.scale.set(k);
    world.position.set(Math.round(x), Math.round(y));
    fitNow = { scale: Math.round(k * 1000) / 1000, x: Math.round(x), y: Math.round(y), w: W, h: H };
  }
  fit();
  addEventListener('resize', fit);

  // ---- time of day (settings.scene: 对齐本机时间 / 随时间流动 / 时刻) ---------------------------------------
  const scene = { followClock: true, dayFlow: false, hour: 12, weather: 'clear', ...(boot.scene || {}) };
  let forcedHour = null;
  st.hour = scene.followClock ? SKY.clockHour() : scene.hour;
  function hourNow(dt) {
    if (forcedHour !== null) return forcedHour;
    if (scene.followClock) return SKY.clockHour();
    if (scene.dayFlow) return SKY.wrapHour(st.hour + SKY.flowHours(dt));
    return scene.hour;
  }
  const weather = M.sky.weather.includes(scene.weather) ? scene.weather : M.sky.weather[0];

  // ---- the frame ---------------------------------------------------------------------------------------------
  let fpsN = 0;
  let fpsT = 0;
  function frame(dt) {
    st.t += dt;
    st.frames += 1;
    fpsN += 1;
    fpsT += dt;
    if (fpsT >= 1) { st.fps = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; }
    st.hour = hourNow(dt);
    const g = SKY.grade(st.hour, SKY.mixWeather(weather, weather, 1));
    st.phase = g.phase;
    if (M.sky.tint) grade.matrix = SKY.gradeMatrix(g);
    for (const l of layers) {
      const want = l.def.phases ? (l.def.phases.includes(g.phase) ? l.def.opacity : 0) : l.def.opacity;
      l.node.alpha += (want - l.node.alpha) * Math.min(1, dt * 1.5);
      if (l.def.drift) {
        l.ox += l.def.drift[0] * dt;
        l.oy += l.def.drift[1] * dt;
        if (l.def.loop) l.ox = ((l.ox % C.width) + C.width) % C.width;
        l.node.x = l.def.loop ? l.ox - C.width : l.ox;
        l.node.y = l.oy;
      }
    }
    for (const L of lights) L.s.alpha = (L.def.phases ? (L.def.phases.includes(g.phase) ? 1 : 0) : g.lights) * (0.85 + Math.sin(st.t * 3 + L.def.x) * 0.05);
    for (const f of flies) {
      f.ph += dt;
      f.s.position.set(f.x + Math.sin(f.ph * 0.7) * 30, f.y + Math.cos(f.ph * 0.9) * 18);
      f.s.alpha = g.flies * (0.5 + Math.sin(f.ph * 2.1) * 0.5);
    }
    // her
    st.pet.alpha += (st.pet.target - st.pet.alpha) * Math.min(1, dt * 3);
    if (Math.abs(st.pet.target - st.pet.alpha) < 0.01) st.pet.alpha = st.pet.target;
    petSprite.alpha = st.pet.alpha;
    if (pet && st.sprite && st.sprite.frames.idle) {
      if (st.pet.visible) pet.step(dt, { phase: g.phase, roam: true });
      const s = pet.state();
      const anim = s.anim === 'lifted' ? 'idle' : s.anim;
      const frames = st.sprite.frames[anim] || st.sprite.frames.idle;
      const fps = anim === 'walk' ? 5 : (st.sprite.actions[anim] && st.sprite.actions[anim].fps) || 2;
      const fr = frames[Math.floor(st.t * fps) % frames.length];
      if (petSprite.texture !== fr) petSprite.texture = fr;
      const hop = st.sprite.kind === 'paper' && s.mode === 'walk' ? -Math.abs(Math.sin(st.t * 10)) * 3 : 0;
      petSprite.scale.set((s.facing < 0 ? -1 : 1) / RES, 1 / RES);
      petSprite.position.set(Math.round(s.x), Math.round(s.y + hop + (anim === 'sit' ? -PET_H * 0.08 : 0)));
      // where she is, for 叫她出来 (twice a second is plenty)
      if (st.t - st.lastReport > 0.5) { st.lastReport = st.t; window.wallpaper.report({ type: 'pet', at: [Math.round(s.x), Math.round(s.y)] }); }
    }
  }
  app.ticker.add((tk) => frame(Math.min(0.1, tk.deltaMS / 1000)));

  // ---- main's controls -------------------------------------------------------------------------------------
  function setFps(r) {
    st.maxFps = r.fps;
    st.why = r.why;
    if (r.fps <= 0) { app.ticker.stop(); return; }
    app.ticker.maxFPS = r.fps;
    if (!app.ticker.started) { app.ticker.start(); app.render(); }
  }
  window.wallpaper.onPower(setFps);
  window.wallpaper.onPet((p) => {
    if (p.visible) {
      if (!pet || p.at) makePet(p.at || null);
      st.pet.visible = true;
      st.pet.target = 1;
    } else {
      st.pet.visible = false;
      st.pet.target = 0;
    }
  });
  window.wallpaper.onDisplay((d) => { boot.display = d.display; boot.clip = d.clip; const s = pet && pet.state(); if (s) makePet([s.x, s.y]); fit(); });
  window.wallpaper.onView((v) => { const a = boot.view && boot.view.look; const b = v && v.look; boot.view = v; if (b && (!a || a.url !== b.url)) loadSprite(b); });
  window.wallpaper.onSettings((s) => { if (s && s.scene) Object.assign(scene, s.scene); });
  document.addEventListener('visibilitychange', () => window.wallpaper.report({ type: 'visibility', hidden: document.visibilityState === 'hidden' }));
  if (boot.testMode) window.__wallpaperTest = { setHour: (h) => { forcedHour = h; }, goTo: (x, y) => pet && pet.goTo(x, y, 'test'), toScreen: (x, y) => [world.x + x * world.scale.x, world.y + y * world.scale.y] };
  st.ready = true;
  frame(0);
  app.render();
  window.wallpaper.report({ type: 'ready' });
})();
