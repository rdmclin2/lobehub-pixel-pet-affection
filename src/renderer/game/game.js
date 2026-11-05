'use strict';
// 小游戏 · 页面 (docs/mini-games.md). Plays one game pack (core/game-pack.js) with PixiJS:
//
//   cam            the camera: pan (drag), zoom (wheel, ＋ －), follows her when ⌖ is on
//   ├ graded       everything painted, under one colour-matrix filter = the hour × the weather (core/game-sky.js)
//   │ ├ terrain    the world picture
//   │ ├ fall       waterfall streaks, pond glints
//   │ ├ shadows    soft shadows under things, stretched and moved with the sun
//   │ ├ flat       flowers, grass, crops: under everything that stands
//   │ ├ sorted     things that stand, and her, ordered by their feet (zIndex = y)
//   │ ├ outline    the hovered thing's outline
//   │ └ sky        clouds
//   └ lights       additive: lit windows, lamp halos, fireflies (unaffected by the grade, so they glow at night)
//   screen         rain, snow, fog, lightning (screen space)
//
// Her state machine is core/game-pet.js on the walk grid of core/game-world.js; what she does turns into events
// for main (window.game.event), which keeps today's quests (core/game-quests.js) and gives affection.
// window.__game() is the e2e's read-out, window.__gameTest the e2e's handles.
(async function () {
  const P = window.PIXI;
  const GW = window.GameWorld;
  const GP = window.GamePet;
  const SKY = window.GameSky;
  const Q = window.GameQuests;
  const Fx = window.PetFx;
  const IC = window.GameIcons;
  const $ = (id) => document.getElementById(id);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = Math.random;

  const boot = await window.game.boot();
  if (!boot || !boot.game) { $('loading').textContent = '没有可以玩的小游戏，去商店 → 小游戏下载一个吧。'; return; }
  const M = boot.game.manifest;
  const SPR = boot.game.sprites;
  const BASE = boot.game.base;
  document.title = M.name;
  $('game-name').textContent = M.name;
  const PET_H = M.petHeight || 56;
  // how much of the world's grade she keeps: 0.55 = at night she is darkened about half as much as the world
  const PET_GRADE = 0.55;
  const RES = 3; // her frames are drawn at 3× her world height (sharp when zoomed in)

  // ---- state ---------------------------------------------------------------------------------------------
  const st = {
    scene: { followClock: false, dayFlow: true, hour: 8, weather: 'clear', autoWeather: false, ...(boot.scene || {}) },
    roam: boot.roam !== false,
    hour: 8, target: 8, ease: false,
    wx: { from: 'clear', to: 'clear', k: 1 }, autoLeft: SKY.autoDelay(rnd),
    saveLeft: 30,
    t: 0, frames: 0, fps: 0,
    zoom: (M.camera && M.camera.zoom) || 1.5, follow: true, camX: 0, camY: 0,
    flag: null, hover: null, drag: null,
    world: Object.assign({ plots: {}, lamp: null, berries: 0, rainT: 0 }, (boot.progress && boot.progress.state) || {}),
    quests: (boot.progress && boot.progress.quests) || [],
    items: (boot.progress && boot.progress.items) || {},
    flash: 0, nextFlash: 4 + rnd() * 8,
    bubbleT: 0, toastT: 0,
    view: boot.view, sprite: null,
    events: [], lastGrade: null,
  };
  st.hour = st.target = st.scene.followClock ? SKY.clockHour() : st.scene.hour;
  st.wx = { from: st.scene.weather, to: st.scene.weather, k: 1 };

  // ---- Pixi ----------------------------------------------------------------------------------------------
  P.TextureSource.defaultOptions.scaleMode = 'nearest';
  const app = new P.Application();
  await app.init({ resizeTo: $('stage'), background: (M.world && M.world.background) || '#06090b', antialias: false, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true, preference: 'webgl', powerPreference: 'low-power' });
  $('stage').appendChild(app.canvas);

  async function loadTexture(url) {
    const blob = await fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status} ${url}`))));
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
    return P.Texture.from(bmp);
  }
  const [terrainTex, atlasTex] = await Promise.all([loadTexture(BASE + M.images.terrain), loadTexture(BASE + M.images.atlas)]);
  const texCache = new Map();
  function tex(name) {
    if (!texCache.has(name)) {
      const b = SPR[name];
      texCache.set(name, b ? new P.Texture({ source: atlasTex.source, frame: new P.Rectangle(b.x, b.y, b.w, b.h) }) : P.Texture.EMPTY);
    }
    return texCache.get(name);
  }

  const cam = new P.Container();
  const graded = new P.Container();
  const grade = new P.ColorMatrixFilter();
  graded.filters = [grade];
  const terrain = new P.Sprite(terrainTex);
  const fall = new P.Graphics();
  const shadows = new P.Container();
  const shadowG = new P.Graphics();
  shadows.addChild(shadowG);
  const flat = new P.Container();
  const sorted = new P.Container();
  sorted.sortableChildren = true;
  const outline = new P.Graphics();
  const skyC = new P.Container();
  graded.addChild(terrain, fall, shadows, flat, sorted, outline, skyC);
  const lights = new P.Container();
  const windowsG = new P.Graphics();
  windowsG.blendMode = 'add';
  const fliesG = new P.Graphics();
  fliesG.blendMode = 'add';
  lights.addChild(windowsG);
  cam.addChild(graded, lights);
  const screen = new P.Container();
  const rainG = new P.Graphics();
  const snowG = new P.Graphics();
  const flashG = new P.Graphics();
  screen.addChild(rainG, snowG, flashG);
  app.stage.addChild(cam, screen);

  // a pixel halo: a radial falloff in 6 hard steps on a 48 px texture, scaled up with nearest — the stepped
  // rings of warm light round windows and lamps in the reference video
  function haloTexture() {
    const n = 48;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const x = c.getContext('2d');
    const img = x.createImageData(n, n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const d = Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) / (n / 2);
      const v = d >= 1 ? 0 : Math.ceil((1 - d) * 6) / 6;
      const k = (j * n + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 255;
      img.data[k + 3] = Math.round(v * v * 255);
    }
    x.putImageData(img, 0, 0);
    return P.Texture.from(c);
  }
  const HALO = haloTexture();

  // fog: soft blobs on a tile, drifting
  function fogTexture() {
    const n = 256;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const x = c.getContext('2d');
    for (let i = 0; i < 18; i++) {
      const cx = Math.random() * n;
      const cy = Math.random() * n;
      const r = 30 + Math.random() * 60;
      for (const [ox, oy] of [[0, 0], [n, 0], [-n, 0], [0, n], [0, -n]]) {
        const g = x.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r);
        g.addColorStop(0, 'rgba(255,255,255,0.5)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g;
        x.fillRect(0, 0, n, n);
      }
    }
    const t = P.Texture.from(c);
    t.source.scaleMode = 'linear';
    return t;
  }
  const fog = new P.TilingSprite({ texture: fogTexture(), width: 100, height: 100 });
  fog.alpha = 0;
  screen.addChildAt(fog, 0);

  // ---- the world ---------------------------------------------------------------------------------------
  const blockedShapes = [...((M.walk && M.walk.blocked) || []), ...M.objects.filter((o) => o.block).map((o) => o.block)];
  const world = GW.createWorld({ width: M.world.width, height: M.world.height, walk: { cell: M.walk.cell, area: M.walk.area, blocked: blockedShapes } });
  const objs = new Map();
  const polyCenter = (p) => [p.reduce((n, q) => n + q[0], 0) / p.length, p.reduce((n, q) => n + q[1], 0) / p.length];

  for (const o of M.objects) {
    const [x, y] = Number.isFinite(o.x) ? [o.x, o.y] : polyCenter(o.hit);
    const ob = { def: o, id: o.id, x, y, sprite: null, glows: [], name: o.name || '' };
    if (o.sprite) {
      const s = new P.Sprite(tex(o.sprite));
      s.anchor.set(0.5, 1);
      s.position.set(x, y);
      if (o.flip) s.scale.x = -1;
      if (o.flat) flat.addChild(s);
      else { s.zIndex = y; sorted.addChild(s); }
      ob.sprite = s;
      // a soft shadow under everything that stands, sized from the sprite
      if (!o.flat) ob.shadow = { x, y, rx: Math.min(90, s.width * 0.42), ry: Math.min(30, s.width * 0.13), h: s.height };
    }
    for (const l of o.lights || []) {
      const g = new P.Sprite(HALO);
      g.anchor.set(0.5);
      g.blendMode = 'add';
      g.position.set(x + l.x, y + l.y);
      g.width = g.height = l.r * 2;
      g.tint = l.lamp ? 0xffd88a : 0xffb85c;
      g.alpha = 0;
      lights.addChild(g);
      ob.glows.push({ sprite: g, def: l });
    }
    if (o.crops) {
      ob.crops = o.crops.spots.map(([cx, cy]) => {
        const c = new P.Sprite(P.Texture.EMPTY);
        c.anchor.set(0.5, 1);
        c.position.set(cx, cy);
        flat.addChild(c);
        return c;
      });
    }
    objs.set(o.id, ob);
  }
  lights.addChild(fliesG);
  const usableDefs = M.objects.filter((o) => o.use).map((o) => ({ id: o.id, use: o.use }));

  // ---- her: the pack's frames, shrunk to PET_H×RES with a soft dark outline ----------------------------
  const USED = ['idle', 'walk', 'play', 'pat', 'look', 'lifted', 'sleep', 'happy', 'think', 'eat'];
  const ACTION_OF = { eat: 'eat_fruit' };
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
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
    o.imageSmoothingEnabled = true;
    o.imageSmoothingQuality = 'high';
    // outline: the silhouette drawn dark, offset round, then her on top
    const sil = canvas(w, ch);
    const sx2 = sil.getContext('2d');
    sx2.imageSmoothingQuality = 'high';
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
    const token = {};
    st.spriteToken = token;
    const sprite = { kind: 'placeholder', frames: {}, actions: {} };
    try {
      if (!look || !look.url) throw new Error('no art');
      const blob = await fetch(look.url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
      const bmp = await createImageBitmap(blob);
      const H = PET_H * RES;
      const add = (name, canvases, fps) => {
        sprite.frames[name] = canvases.map((c) => { const t = P.Texture.from(c); t.source.scaleMode = 'linear'; return t; });
        sprite.actions[name] = { fps: fps || 2 };
      };
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
        // sitting: her top part (to the waist), set on the seat
        const waist = (look.halfBody && look.halfBody.waist) || 0.55;
        add('sit', Array.from({ length: idle.frames || 1 }, (_, i) => cut(idle, i, waist + 0.06)), idle.fps);
        const sl = look.actions.sleep || idle;
        add('sit-sleep', Array.from({ length: sl.frames || 1 }, (_, i) => cut(sl, i, waist + 0.06)), sl.fps);
        sprite.kind = 'sprites';
      } else {
        // a picture / Live2D / VRM look: her picture as a paper cut-out that hops as she walks
        const box = opaqueBox(bmp, 0, 0, bmp.width, bmp.height);
        const one = shrink(bmp, box.x, box.y, box.w, box.h, H);
        for (const want of [...USED, 'sit', 'sit-sleep']) add(want, [one], 1);
        sprite.kind = 'paper';
      }
      if (bmp.close) bmp.close();
    } catch (e) {
      sprite.error = String(e && e.message);
    }
    if (st.spriteToken === token) {
      st.sprite = sprite;
      petSprite.visible = sprite.kind !== 'placeholder';
    }
  }

  const petSprite = new P.Sprite(P.Texture.EMPTY);
  petSprite.anchor.set(0.5, 1);
  petSprite.scale.set(1 / RES);
  sorted.addChild(petSprite);
  const petShadow = new P.Graphics();
  shadows.addChild(petShadow);
  const flagG = new P.Graphics();
  sorted.addChild(flagG);
  const pet = GP.createGamePet({ world, objects: usableDefs, rnd, start: M.spawn, ...(Number.isFinite(M.petSpeed) ? { speed: M.petSpeed } : {}) });
  // she is lit on her own (docs/mini-games.md §4): the world's grade darkens her only PET_GRADE as much. She stays
  // in the graded container (so she sorts with the things round her); this filter on her alone pre-compensates
  // the part of the grade she should not get. At night a faint pool of warm light lies round her feet.
  const petLight = new P.ColorMatrixFilter();
  petSprite.filters = [petLight];
  const petGlow = new P.Sprite(HALO);
  petGlow.anchor.set(0.5);
  petGlow.blendMode = 'add';
  petGlow.tint = 0xffe2b0;
  petGlow.alpha = 0;
  lights.addChildAt(petGlow, 0);
  function lightPet(g) {
    const k = g.mul.map((m) => (m + (1 - m) * (1 - PET_GRADE)) / Math.max(0.05, m));
    const sat = (g.sat + (1 - g.sat) * (1 - PET_GRADE)) / Math.max(0.05, g.sat);
    petLight.matrix = SKY.gradeMatrix({ mul: k, sat, lift: 0 });
    const s = pet.state();
    // a pool of warm light on the ground round her feet (not over her: that would wash her out)
    petGlow.position.set(s.x, s.y - 2);
    petGlow.width = PET_H * 1.5;
    petGlow.height = PET_H * 0.55;
    petGlow.alpha = s.mode === 'lifted' ? 0 : g.lights * 0.3;
  }

  // ---- clouds, fireflies, particles -------------------------------------------------------------------
  const cloudNames = ((M.fx && M.fx.clouds) || []).filter((n) => SPR[n]);
  const clouds = [];
  function addCloud(initial) {
    if (!cloudNames.length) return;
    const s = new P.Sprite(tex(cloudNames[Math.floor(rnd() * cloudNames.length)]));
    s.anchor.set(0.5);
    s.alpha = 0;
    const y = 40 + rnd() * (M.world.height * 0.75);
    const x = initial ? rnd() * M.world.width : -180;
    s.position.set(x, y);
    skyC.addChild(s);
    clouds.push({ s, vx: 6 + rnd() * 6, life: 1, want: 1 });
  }
  const flies = [];
  function addFly() {
    const area = M.walk.area;
    for (let k = 0; k < 20; k++) {
      const x = rnd() * M.world.width;
      const y = rnd() * M.world.height;
      if (GW.inPoly(area, x, y)) { flies.push({ x, y, z: 6 + rnd() * 14, vx: 0, vy: 0, ph: rnd() * 6.28, a: 0, caught: false }); return; }
    }
  }
  for (let i = 0; i < ((M.fx && M.fx.fireflies) || 0); i++) addFly();
  const drops = [];
  const flakes = [];
  const splashes = [];
  const ripples = [];

  // ---- camera ----------------------------------------------------------------------------------------------
  const view = () => ({ w: app.screen.width, h: app.screen.height });
  function clampCam() {
    const { w, h } = view();
    const z = st.zoom;
    const pad = 160;
    const minX = w / z / 2 - pad;
    const maxX = M.world.width - w / z / 2 + pad;
    const minY = h / z / 2 - pad;
    const maxY = M.world.height - h / z / 2 + pad;
    st.camX = minX > maxX ? M.world.width / 2 : Math.max(minX, Math.min(maxX, st.camX));
    st.camY = minY > maxY ? M.world.height / 2 : Math.max(minY, Math.min(maxY, st.camY));
  }
  function applyCam() {
    const { w, h } = view();
    clampCam();
    cam.scale.set(st.zoom);
    cam.position.set(Math.round(w / 2 - st.camX * st.zoom), Math.round(h / 2 - st.camY * st.zoom));
  }
  const toWorld = (sx, sy) => [(sx - cam.position.x) / st.zoom, (sy - cam.position.y) / st.zoom];
  const toScreen = (wx, wy) => [wx * st.zoom + cam.position.x, wy * st.zoom + cam.position.y];
  const start = (M.camera && M.camera.start) || [M.world.width / 2, M.world.height / 2];
  st.camX = start[0];
  st.camY = start[1];
  function setZoom(z, about) {
    const zmin = (M.camera && M.camera.min) || 0.8;
    const zmax = (M.camera && M.camera.max) || 3;
    const nz = Math.max(zmin, Math.min(zmax, z));
    if (about) {
      const [wx, wy] = toWorld(about[0], about[1]);
      st.zoom = nz;
      const { w, h } = view();
      st.camX = wx - (about[0] - w / 2) / nz;
      st.camY = wy - (about[1] - h / 2) / nz;
    } else st.zoom = nz;
    applyCam();
  }

  // ---- talking ---------------------------------------------------------------------------------------------
  const lines = M.lines || {};
  const pick = (key) => { const l = lines[key]; return Array.isArray(l) && l.length ? l[Math.floor(rnd() * l.length)] : null; };
  function say(text, s = 3.2) {
    if (!text) return;
    const b = $('bubble');
    b.textContent = text;
    b.classList.remove('hidden');
    st.bubbleT = s;
    st.lastLine = text;
  }
  function toast(text, s = 3.6) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    st.toastT = s;
  }

  // ---- events → main (quests, affection) --------------------------------------------------------------
  const ctxNow = () => ({ phase: SKY.phaseOf(st.hour), weather: st.wx.to });
  async function report(ev) {
    st.events.push({ ...ev, at: Date.now() });
    if (st.events.length > 80) st.events.shift();
    let r = null;
    try { r = await window.game.event(ev, ctxNow()); } catch { r = null; }
    if (!r || !r.ok) return;
    st.quests = r.quests || st.quests;
    st.items = r.items || st.items;
    for (const q of r.completed || []) {
      const gain = q.affection && q.affection.delta > 0 ? ` · 好感 +${q.affection.delta}` : '';
      toast(`完成：${q.title}${gain}`);
      setTimeout(() => say(pick('quest')), 600);
    }
    renderQuests();
  }
  let saveTimer = null;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.game.saveState(st.world), 400);
  }

  // ---- what using a thing does ----------------------------------------------------------------------------
  const plotOf = (id) => (st.world.plots[id] = st.world.plots[id] || { stage: 0 });
  function plotRipe(id) { const o = objs.get(id); return !!(o && o.crops && plotOf(id).stage >= o.def.crops.stages.length - 1); }
  function useLabel(o) {
    const u = o.def.use;
    if (!u) return '';
    if (u.effect === 'water' && plotRipe(o.id)) return `收菜 · ${o.name}`;
    if (u.effect === 'lamp') return lampLit() ? '关掉路灯' : '点亮路灯';
    return `${u.label || '去看看'}${o.name ? ` · ${o.name}` : ''}`;
  }
  function lampLit() {
    const auto = st.lastGrade ? st.lastGrade.lights > 0.4 : false;
    return st.world.lamp === null || st.world.lamp === undefined ? auto : st.world.lamp;
  }
  function onUseEnd(ev) {
    const o = objs.get(ev.obj);
    if (!o || ev.why !== 'done') return;
    const u = o.def.use;
    const effect = u.effect || 'none';
    if (effect === 'water') {
      if (plotRipe(o.id)) {
        const kind = o.def.crops.kind;
        plotOf(o.id).stage = 0;
        say(pick(`harvest:${kind}`));
        report({ type: 'collect', item: kind, obj: o.id });
      } else {
        plotOf(o.id).stage += 1;
        say(plotRipe(o.id) ? pick('ripe') : pick('water'));
      }
      saveState();
    } else if (effect === 'harvest') {
      const now = Date.now();
      if (st.world.berries && st.world.berries > now) { say(pick('regrow')); return; }
      st.world.berries = now + (u.regrow || 240) * 1000;
      say(pick(`harvest:${u.item}`));
      report({ type: 'collect', item: u.item, obj: o.id });
      saveState();
    } else if (effect === 'lamp') {
      const was = lampLit();
      st.world.lamp = !was;
      st.world.lampPhase = SKY.phaseOf(st.hour);
      st.lampFlicker = 0.5;
      say(pick(was ? 'lamp-off' : 'lamp-on'));
      saveState();
    } else if (effect === 'ripple') {
      say(pick(`use-end:${o.id}`));
    } else {
      say(pick(`use-end:${o.id}`));
    }
    report({ type: 'use-end', obj: o.id });
  }
  function onUseStart(ev) {
    const o = objs.get(ev.obj);
    if (o && o.def.use.effect === 'ripple') for (let i = 0; i < 3; i++) setTimeout(() => addRipple(o), i * 700);
  }
  function addRipple(o) {
    const poly = (M.fx && M.fx.water) || o.def.hit;
    if (!poly) return;
    for (let k = 0; k < 20; k++) {
      const [cx, cy] = polyCenter(poly);
      const x = cx + (rnd() - 0.5) * 120;
      const y = cy + (rnd() - 0.5) * 60;
      if (GW.inPoly(poly, x, y)) { ripples.push({ x, y, t: 0 }); return; }
    }
  }

  // ---- input ---------------------------------------------------------------------------------------------
  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;
  const petBox = () => {
    const s = petSprite;
    const w = Math.abs(s.width);
    const h = s.height;
    return [s.x - w / 2, s.y - h, w, h];
  };
  const inBox = (b, x, y) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
  function objectAt(x, y) {
    let best = null;
    for (const o of objs.values()) {
      if (!o.def.use) continue;
      if (o.def.hit && GW.inPoly(o.def.hit, x, y)) return o;
      if (o.sprite) {
        const s = o.sprite;
        const w = Math.abs(s.width);
        const b = [s.x - w / 2, s.y - s.height, w, s.height];
        if (inBox(b, x, y) && (!best || o.y > best.y)) best = o;
      }
    }
    return best;
  }
  const flyAt = (x, y) => flies.find((f) => !f.caught && f.a > 0.3 && Math.hypot(f.x - x, f.y - f.z - y) < 12);
  function targetAt(sx, sy) {
    const [x, y] = toWorld(sx, sy);
    if (petSprite.visible && inBox(petBox(), x, y)) return { kind: 'pet' };
    const f = flyAt(x, y);
    if (f) return { kind: 'fly', fly: f };
    const o = objectAt(x, y);
    if (o) return { kind: 'obj', obj: o };
    if (GW.walkableAt(world, x, y)) return { kind: 'ground', x, y };
    return { kind: 'none', x, y };
  }
  function clickAt(sx, sy) {
    const t = targetAt(sx, sy);
    if (t.kind === 'pet') {
      if (pet.touch().ok) {
        say(pick('touch'));
        window.game.touch().then((r) => { if (r && r.line) say(r.line); }).catch(() => {});
        report({ type: 'touch' });
      }
    } else if (t.kind === 'fly') {
      t.fly.targeted = true;
      const r = pet.goTo(t.fly.x, t.fly.y + 4, 'fly');
      if (r.ok) { st.flyTarget = t.fly; st.flag = { x: t.fly.x, y: t.fly.y + 4, t: 0 }; }
    } else if (t.kind === 'obj') {
      const r = pet.use(t.obj.id, 'click');
      if (r.ok) st.flag = null;
    } else if (t.kind === 'ground') {
      const r = pet.goTo(t.x, t.y, 'click');
      if (r.ok && r.target) st.flag = { x: r.target[0], y: r.target[1], t: 0 };
    }
    st.flyTarget = t.kind === 'fly' ? t.fly : null;
    return t.kind;
  }

  app.stage.on('pointerdown', (e) => {
    if (e.button === 2) return;
    const t = targetAt(e.global.x, e.global.y);
    st.drag = { x: e.global.x, y: e.global.y, cx: st.camX, cy: st.camY, moved: false, pet: t.kind === 'pet', lifted: false };
  });
  app.stage.on('globalpointermove', (e) => {
    const d = st.drag;
    const gx = e.global.x;
    const gy = e.global.y;
    if (d) {
      const far = Math.hypot(gx - d.x, gy - d.y) > 5;
      if (d.pet && far && !d.lifted) { const r = pet.lift(); d.lifted = r.ok; if (r.ok) say(pick('touch')); }
      if (d.lifted) { const [x, y] = toWorld(gx, gy); pet.moveLifted(x, y + PET_H * 0.6); }
      else if (!d.pet && far) {
        d.moved = true;
        st.follow = false;
        syncFollow();
        st.camX = d.cx - (gx - d.x) / st.zoom;
        st.camY = d.cy - (gy - d.y) / st.zoom;
        $('stage').classList.add('dragging');
      }
      return;
    }
    hoverAt(gx, gy);
  });
  const endDrag = (e) => {
    const d = st.drag;
    st.drag = null;
    $('stage').classList.remove('dragging');
    if (!d) return;
    if (d.lifted) { const [x, y] = toWorld(e.global.x, e.global.y); pet.drop(x, y + PET_H * 0.6); report({ type: 'drop' }); return; }
    if (!d.moved) clickAt(e.global.x, e.global.y);
  };
  app.stage.on('pointerup', endDrag);
  app.stage.on('pointerupoutside', endDrag);
  app.canvas.addEventListener('wheel', (e) => { e.preventDefault(); setZoom(st.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), [e.offsetX, e.offsetY]); }, { passive: false });
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function hoverAt(sx, sy) {
    const t = targetAt(sx, sy);
    st.hover = t.kind === 'obj' ? t.obj : null;
    const tip = $('tip');
    const label = t.kind === 'obj' ? useLabel(t.obj) : t.kind === 'fly' ? '抓萤火虫' : t.kind === 'pet' ? '摸摸 · 按住拖动' : '';
    $('stage').classList.toggle('can-click', t.kind === 'obj' || t.kind === 'fly' || t.kind === 'pet');
    if (label) { tip.textContent = label; tip.style.left = `${sx}px`; tip.style.top = `${sy}px`; tip.classList.remove('hidden'); }
    else tip.classList.add('hidden');
  }
  app.canvas.addEventListener('pointerleave', () => { $('tip').classList.add('hidden'); st.hover = null; });

  // ---- the 天色 card and toolbar ------------------------------------------------------------------------
  function setScene(patch) {
    Object.assign(st.scene, patch);
    window.game.set(patch).catch(() => {});
    renderCard();
  }
  function setHour(h, { ease = true } = {}) {
    st.target = SKY.wrapHour(h);
    st.ease = ease;
    if (!ease) st.hour = st.target;
    setScene({ hour: Math.round(st.target * 4) / 4 % 24, followClock: false });
  }
  function setWeather(id, manual) {
    if (id === st.wx.to) { if (manual && st.scene.autoWeather) setScene({ autoWeather: false }); return; }
    st.wx = { from: st.wx.k >= 0.5 ? st.wx.to : st.wx.from, to: id, k: 0 };
    if (manual) setScene({ weather: id, autoWeather: false });
    else setScene({ weather: id });
    st.autoLeft = SKY.autoDelay(rnd);
    if ((id === 'rain' || id === 'storm') && Object.keys(st.world.plots).length) setTimeout(() => { if (st.wx.to === id) say(pick('rain-water')); }, 2500);
  }
  $('time-prev').addEventListener('click', () => setHour(SKY.stepPhase(st.target, -1)));
  $('time-next').addEventListener('click', () => setHour(SKY.stepPhase(st.target, 1)));
  $('weather-prev').addEventListener('click', () => setWeather(SKY.stepWeather(st.wx.to, -1), true));
  $('weather-next').addEventListener('click', () => setWeather(SKY.stepWeather(st.wx.to, 1), true));
  $('time-slider').addEventListener('input', (e) => { st.target = st.hour = Number(e.target.value); st.ease = false; st.sliding = true; });
  $('time-slider').addEventListener('change', (e) => { st.sliding = false; setHour(Number(e.target.value), { ease: false }); });
  $('day-flow').addEventListener('click', () => setScene({ dayFlow: !st.scene.dayFlow, ...(st.scene.followClock ? { followClock: false } : {}), hour: Math.round(st.hour * 4) / 4 % 24 }));
  $('auto-weather').addEventListener('click', () => { setScene({ autoWeather: !st.scene.autoWeather }); st.autoLeft = SKY.autoDelay(rnd); });
  $('tb-clock').addEventListener('click', () => { const on = !st.scene.followClock; setScene({ followClock: on }); if (on) { st.target = SKY.clockHour(); st.ease = true; } });
  const fold = (id, open) => { $(id).classList.toggle('folded', !open); $(id).classList.toggle('hidden', false); };
  function showCard(which) {
    st.card = which;
    fold('sky-card', which === 'sky');
    fold('quest-card', which === 'quests');
    $('tb-sky').setAttribute('aria-pressed', String(which === 'sky'));
    $('tb-quests').setAttribute('aria-pressed', String(which === 'quests'));
  }
  $('tb-sky').addEventListener('click', () => showCard(st.card === 'sky' ? null : 'sky'));
  $('tb-quests').addEventListener('click', () => showCard(st.card === 'quests' ? null : 'quests'));
  $('sky-close').addEventListener('click', () => showCard(null));
  $('quest-close').addEventListener('click', () => showCard(null));
  $('tb-zoom-in').addEventListener('click', () => setZoom(st.zoom * 1.25));
  $('tb-zoom-out').addEventListener('click', () => setZoom(st.zoom / 1.25));
  function syncFollow() { $('tb-follow').setAttribute('aria-pressed', String(st.follow)); }
  $('tb-follow').addEventListener('click', () => { st.follow = !st.follow; syncFollow(); });
  $('btn-close').addEventListener('click', () => window.game.close('button'));
  window.addEventListener('keydown', (e) => {
    // Ctrl/⌘+W, Ctrl/⌘+Shift+H: main's before-input-event closes the window first; synthetic input lands here
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && ((e.code === 'KeyW' && !e.shiftKey) || (e.code === 'KeyH' && e.shiftKey))) { e.preventDefault(); window.game.close('key'); return; }
    if (e.key === 'Escape') showCard(st.card ? null : 'sky');
    else if (e.key === '+' || e.key === '=') setZoom(st.zoom * 1.25);
    else if (e.key === '-') setZoom(st.zoom / 1.25);
  });

  function renderCard() {
    const g = st.lastGrade || SKY.grade(st.hour, SKY.mixWeather(st.wx.from, st.wx.to, st.wx.k));
    $('time-name').textContent = SKY.phaseName(g.phase);
    $('time-clock').textContent = st.scene.followClock ? `${SKY.formatHour(st.hour)} · 本机时间` : SKY.formatHour(st.hour);
    if (!st.sliding) $('time-slider').value = String(Math.round(st.hour * 4) / 4 % 24);
    $('weather-name').textContent = SKY.weatherOf(st.wx.to).name;
    $('weather-sub').textContent = st.scene.autoWeather ? '会自己变' : ' ';
    $('day-flow').setAttribute('aria-checked', String(!!st.scene.dayFlow && !st.scene.followClock));
    $('auto-weather').setAttribute('aria-checked', String(!!st.scene.autoWeather));
    $('tb-clock').setAttribute('aria-pressed', String(!!st.scene.followClock));
    $('sky-hint').textContent = st.scene.followClock ? '跟着这台电脑的时间。' : st.scene.dayFlow ? `小院的一天是 ${SKY.DAY_MINUTES} 分钟。` : '时间停在这里，拖动滑块或点 ‹ › 换时段。';
    IC.timeIcon($('time-icon'), g);
    IC.weatherIcon($('weather-icon'), st.wx.to);
  }
  function renderQuests() {
    const ul = $('quest-list');
    ul.textContent = '';
    let done = 0;
    for (const q of st.quests) {
      if (q.done) done += 1;
      const li = document.createElement('li');
      li.className = q.done ? 'done' : '';
      li.dataset.quest = q.id;
      li.innerHTML = '<span class="q-check"></span><span class="q-body"><span class="q-title"></span><span class="q-hint"></span></span><span class="q-n"></span><span class="q-reward"></span>';
      li.querySelector('.q-check').textContent = q.done ? '✓' : '';
      li.querySelector('.q-title').textContent = q.title;
      li.querySelector('.q-hint').textContent = q.hint || '';
      li.querySelector('.q-n').textContent = q.count > 1 ? `${q.n}/${q.count}` : '';
      li.querySelector('.q-reward').textContent = '♥ 好感';
      ul.appendChild(li);
    }
    $('quest-sum').textContent = `${done}/${st.quests.length}`;
    const left = st.quests.length - done;
    $('tb-quest-badge').textContent = String(left);
    $('tb-quest-badge').classList.toggle('hidden', !left);
    const names = (M.items) || {};
    const have = Object.entries(st.items || {}).filter(([, n]) => n > 0).map(([k, n]) => `${names[k] || k} ×${n}`);
    $('items').textContent = have.length ? `收集到：${have.join('　')}` : '每天三件小事，完成会加好感（每天最多三次）。';
  }

  // ---- per frame -------------------------------------------------------------------------------------------
  function glassFor(g) {
    // the card's glass: a green tint of the world's light, lighter by day
    const m = (g.mul[0] + g.mul[1] + g.mul[2]) / 3;
    const k = Math.max(0, Math.min(1, (m - 0.4) / 0.6));
    const r = Math.round(28 + 90 * k * g.mul[0]);
    const gg = Math.round(48 + 102 * k * g.mul[1]);
    const b = Math.round(36 + 66 * k * g.mul[2]);
    document.body.style.setProperty('--glass', `rgba(${r}, ${gg}, ${b}, ${0.5 + (1 - k) * 0.12})`);
    document.body.dataset.phase = g.phase;
  }

  function stepTime(dt) {
    const s = st.scene;
    if (s.followClock) { st.target = SKY.clockHour(); st.ease = true; }
    else if (s.dayFlow && !st.sliding) { st.target = SKY.wrapHour(st.target + SKY.flowHours(dt)); if (!st.ease) st.hour = st.target; }
    if (st.ease) {
      const d = SKY.hourDelta(st.hour, st.target);
      if (Math.abs(d) < 0.01) { st.hour = st.target; st.ease = false; }
      else st.hour = SKY.wrapHour(st.hour + d * Math.min(1, dt * 3.2) + Math.sign(d) * Math.min(Math.abs(d), dt * 0.3));
    }
    if (s.dayFlow && !s.followClock) {
      st.saveLeft -= dt;
      if (st.saveLeft <= 0) { st.saveLeft = 30; window.game.set({ hour: Math.round(st.hour * 4) / 4 % 24 }).catch(() => {}); st.scene.hour = Math.round(st.hour * 4) / 4 % 24; }
    }
    // weather
    if (st.wx.k < 1) st.wx.k = Math.min(1, st.wx.k + dt / SKY.FADE_S);
    if (s.autoWeather) { st.autoLeft -= dt; if (st.autoLeft <= 0) setWeather(SKY.nextWeather(st.wx.to, rnd), false); }
  }

  function stepWorld(dt, g) {
    const w = g.weather;
    // a lamp switched by hand stays so until the next dusk / dawn
    const ph = g.phase;
    if (st.world.lamp !== null && st.world.lamp !== undefined && st.world.lampPhase && ph !== st.world.lampPhase && (ph === 'night' || ph === 'day')) { st.world.lamp = null; st.world.lampPhase = null; }
    // rain waters the plots: one growth step per 60 s of rain
    if (w.rain > 0.3) {
      st.world.rainT = (st.world.rainT || 0) + dt;
      if (st.world.rainT > 60) {
        st.world.rainT = 0;
        for (const o of objs.values()) if (o.crops && !plotRipe(o.id)) plotOf(o.id).stage += 1;
        saveState();
      }
    }
    // clouds: as many as the weather wants, drifting right
    const want = Math.round(w.clouds * 7);
    let alive = clouds.filter((c) => c.want).length;
    while (alive < want) { addCloud(true); alive += 1; }
    let extra = alive - want;
    for (const c of clouds) {
      if (extra > 0 && c.want) { c.want = 0; extra -= 1; }
      c.s.x += c.vx * dt;
      c.s.alpha += ((c.want ? 0.95 : 0) - c.s.alpha) * Math.min(1, dt * 0.8);
      if (c.s.x > M.world.width + 200) { c.s.x = -200; c.s.y = 40 + rnd() * M.world.height * 0.75; }
    }
    for (let i = clouds.length - 1; i >= 0; i--) if (!clouds[i].want && clouds[i].s.alpha < 0.02) { clouds[i].s.destroy(); clouds.splice(i, 1); }
  }

  function drawWater(dt) {
    fall.clear();
    const wf = M.fx && M.fx.waterfall;
    if (wf) {
      const [a, b, c, d] = wf;
      for (let i = 0; i < 26; i++) {
        const u = ((i * 0.618) % 1);
        const v = ((st.t * (0.55 + (i % 5) * 0.08) + i * 0.37) % 1);
        const x0 = a[0] + (b[0] - a[0]) * u;
        const y0 = a[1] + (b[1] - a[1]) * u;
        const x1 = d[0] + (c[0] - d[0]) * u;
        const y1 = d[1] + (c[1] - d[1]) * u;
        const x = x0 + (x1 - x0) * v;
        const y = y0 + (y1 - y0) * v;
        fall.rect(Math.round(x), Math.round(y), 2, 6 + (i % 3) * 3).fill({ color: 0xffffff, alpha: 0.55 });
      }
    }
    const water = M.fx && M.fx.water;
    if (water) {
      const [cx, cy] = polyCenter(water);
      for (let i = 0; i < 10; i++) {
        const k = Math.sin(st.t * 1.7 + i * 2.1);
        if (k < 0.6) continue;
        const x = cx + Math.sin(i * 12.9898) * 90;
        const y = cy + Math.cos(i * 78.233) * 40;
        if (GW.inPoly(water, x, y)) fall.rect(Math.round(x), Math.round(y), 4, 2).fill({ color: 0xffffff, alpha: (k - 0.6) * 1.6 });
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.t += dt;
        if (r.t > 2) { ripples.splice(i, 1); continue; }
        fall.ellipse(r.x, r.y, 4 + r.t * 14, 2 + r.t * 6).stroke({ width: 1.2, color: 0xffffff, alpha: 0.6 * (1 - r.t / 2) });
      }
      if (st.wx.to === 'rain' || st.wx.to === 'storm') if (rnd() < dt * 6) addRipple({ def: { hit: water } });
    }
  }

  function drawShadows(g) {
    shadowG.clear();
    const sun = g.sun;
    const strength = Math.max(0.06, Math.min(0.32, 0.08 + Math.max(0, sun) * 0.24)) * (1 - g.weather.clouds * 0.5);
    // the shadow leans away from the sun: morning → right, evening → left
    const lean = (st.hour - 12) / 6;
    for (const o of objs.values()) {
      if (!o.shadow) continue;
      const sh = o.shadow;
      const dx = -lean * sh.rx * 0.5;
      shadowG.ellipse(sh.x + dx, sh.y - sh.ry * 0.35, sh.rx * (1 + Math.abs(lean) * 0.25), sh.ry).fill({ color: 0x0c1a08, alpha: strength });
    }
    petShadow.clear();
    const s = pet.state();
    const r = PET_H * 0.26;
    if (s.mode !== 'lifted') petShadow.ellipse(s.x, s.y - 1, r, r * 0.33).fill({ color: 0x0c1a08, alpha: strength + 0.08 });
    else petShadow.ellipse(s.x, s.y - 1 + PET_H * 0.3, r * 0.8, r * 0.28).fill({ color: 0x0c1a08, alpha: strength });
  }

  function drawLights(dt, g) {
    windowsG.clear();
    const base = g.lights;
    for (const o of objs.values()) {
      for (const gl of o.glows) {
        let k = base;
        if (gl.def.lamp) {
          k = lampLit() ? Math.max(base, 0.85) : 0;
          if (st.lampFlicker > 0) k *= Math.sin(st.lampFlicker * 40) > 0 ? 1 : 0.2;
        }
        const flick = 0.94 + 0.06 * Math.sin(st.t * 7 + gl.def.x);
        gl.sprite.alpha = k * 0.75 * flick;
        if (gl.def.window && k > 0.02) {
          const [wx, wy, ww, wh] = gl.def.window;
          windowsG.rect(o.x + wx, o.y + wy, ww, wh).fill({ color: 0xffc870, alpha: Math.min(1, k * 0.85) });
        }
      }
    }
    if (st.lampFlicker > 0) st.lampFlicker -= dt;
    // fireflies
    fliesG.clear();
    const want = g.flies;
    for (const f of flies) {
      if (f.caught) { f.a = Math.max(0, f.a - dt * 2); if (f.a <= 0 && rnd() < dt * 0.05) { f.caught = false; } continue; }
      f.ph += dt;
      if (!f.targeted) {
        f.vx += (rnd() - 0.5) * dt * 20;
        f.vy += (rnd() - 0.5) * dt * 20;
        f.vx *= 0.96; f.vy *= 0.96;
        const nx = f.x + f.vx * dt;
        const ny = f.y + f.vy * dt;
        if (GW.inPoly(M.walk.area, nx, ny)) { f.x = nx; f.y = ny; } else { f.vx = -f.vx; f.vy = -f.vy; }
      }
      const blink = 0.55 + 0.45 * Math.sin(f.ph * 2.3);
      f.a += ((want > 0.2 ? blink : 0) - f.a) * Math.min(1, dt * 2);
      if (f.a < 0.03) continue;
      const y = f.y - f.z;
      fliesG.circle(f.x, y, 5).fill({ color: 0xc8ff6a, alpha: f.a * 0.18 });
      fliesG.rect(Math.round(f.x) - 1, Math.round(y) - 1, 2, 2).fill({ color: 0xe8ff9a, alpha: f.a });
    }
  }

  function drawWeather(dt, g) {
    const { w, h } = view();
    const W = g.weather;
    // rain: thin slanted lines, light grey; the count follows the weather's strength
    const wantDrops = reduced ? 0 : Math.round(W.rain * 420 * (w * h) / (960 * 600));
    while (drops.length < wantDrops) drops.push({ x: rnd() * (w + 80), y: rnd() * h, v: 520 + rnd() * 260, l: 6 + rnd() * 8 });
    if (drops.length > wantDrops) drops.length = wantDrops;
    rainG.clear();
    const shade = Math.max(0.35, (g.mul[0] + g.mul[1] + g.mul[2]) / 3);
    for (const d of drops) {
      d.y += d.v * dt;
      d.x -= d.v * 0.18 * dt;
      if (d.y > h) {
        if (rnd() < 0.35) splashes.push({ x: d.x, y: h * (0.25 + rnd() * 0.7), t: 0 });
        d.y = -10 - rnd() * 40; d.x = rnd() * (w + 80);
      }
      rainG.moveTo(d.x, d.y).lineTo(d.x + d.l * 0.18, d.y - d.l);
    }
    if (drops.length) rainG.stroke({ width: 1, color: 0xd8e4ee, alpha: 0.42 * shade + 0.1 });
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i];
      s.t += dt;
      if (s.t > 0.25) { splashes.splice(i, 1); continue; }
      rainG.rect(s.x - 2, s.y, 1, 1).rect(s.x + 2, s.y, 1, 1).rect(s.x, s.y - 2, 1, 1).fill({ color: 0xe6eef4, alpha: 0.5 * (1 - s.t / 0.25) });
    }
    // snow: soft dots drifting down, swaying
    const wantFlakes = reduced ? 0 : Math.round(W.snow * 520 * (w * h) / (960 * 600));
    while (flakes.length < wantFlakes) flakes.push({ x: rnd() * w, y: rnd() * h, v: 30 + rnd() * 40, ph: rnd() * 6.28, s: rnd() < 0.35 ? 4 : rnd() < 0.5 ? 3 : 2 });
    if (flakes.length > wantFlakes) flakes.length = wantFlakes;
    snowG.clear();
    for (const f of flakes) {
      f.y += f.v * dt;
      f.ph += dt;
      f.x += Math.sin(f.ph * 1.3) * 12 * dt;
      if (f.y > h) { f.y = -6; f.x = rnd() * w; }
      snowG.rect(Math.round(f.x), Math.round(f.y), f.s, f.s);
    }
    if (flakes.length) snowG.fill({ color: 0xffffff, alpha: 0.92 });
    // fog
    fog.width = w; fog.height = h;
    fog.tilePosition.x += dt * 12;
    fog.tilePosition.y += dt * 2;
    fog.alpha += (W.fog * 0.9 - fog.alpha) * Math.min(1, dt * 1.5);
    // lightning
    flashG.clear();
    if (W.flash > 0.5 && !reduced) {
      st.nextFlash -= dt;
      if (st.nextFlash <= 0) { st.flash = 0.35; st.nextFlash = 5 + rnd() * 10; }
    }
    if (st.flash > 0) {
      st.flash -= dt;
      flashG.rect(0, 0, w, h).fill({ color: 0xe8f0ff, alpha: Math.max(0, st.flash) * (Math.sin(st.flash * 60) > 0 ? 1.4 : 0.6) });
    }
  }

  function drawPet(dt) {
    const s = pet.state();
    const sp = st.sprite;
    if (!sp || !sp.frames.idle) return;
    let anim = s.anim;
    const using = s.using ? objs.get(s.using) : null;
    let yOff = 0;
    if (anim === 'sit') {
      anim = st.lastGrade && st.lastGrade.phase === 'night' ? 'sit-sleep' : 'sit';
      yOff = (using && using.def.use.sitY) || -12;
    }
    const frames = sp.frames[anim] || sp.frames.idle;
    const fps = anim === 'walk' ? 5 : (sp.actions[anim] && sp.actions[anim].fps) || 2;
    const fr = frames[Math.floor(st.t * fps) % frames.length];
    if (petSprite.texture !== fr) petSprite.texture = fr;
    const hop = sp.kind === 'paper' && s.mode === 'walk' ? -Math.abs(Math.sin(st.t * 10)) * 3 : 0;
    const liftY = s.mode === 'lifted' ? -PET_H * 0.6 + Math.sin(st.t * 6) * 1.5 : 0;
    // she faces right as drawn (walk frames are a right-facing side view)
    petSprite.scale.set((s.facing < 0 ? -1 : 1) / RES, 1 / RES);
    petSprite.position.set(Math.round(s.x), Math.round(s.y + yOff + hop + liftY));
    petSprite.zIndex = s.mode === 'lifted' ? 1e6 : s.y + (using ? 1 : 0);
    // things she is behind turn see-through
    const pb = [s.x - PET_H * 0.22, s.y - PET_H, PET_H * 0.44, PET_H];
    for (const o of objs.values()) {
      if (!o.sprite || o.def.flat || o.y <= s.y) { if (o.sprite && o.sprite.alpha !== 1) o.sprite.alpha = Math.min(1, o.sprite.alpha + dt * 3); continue; }
      const sw = Math.abs(o.sprite.width);
      const ob = [o.x - sw / 2, o.y - o.sprite.height, sw, o.sprite.height];
      const over = pb[0] < ob[0] + ob[2] && pb[0] + pb[2] > ob[0] && pb[1] < ob[1] + ob[3] && pb[1] + pb[3] > ob[1] && o.sprite.height > PET_H * 0.8;
      const want = over ? 0.5 : 1;
      o.sprite.alpha += (want - o.sprite.alpha) * Math.min(1, dt * 6);
    }
  }

  function drawOutline() {
    outline.clear();
    const o = st.hover;
    if (!o) return;
    if (o.def.hit) outline.poly(o.def.hit.flat()).stroke({ width: 1.5, color: 0xffffff, alpha: 0.7 });
    else if (o.sprite) {
      const s = o.sprite;
      const w = Math.abs(s.width);
      outline.roundRect(s.x - w / 2 - 2, s.y - s.height - 2, w + 4, s.height + 4, 4).stroke({ width: 1.5, color: 0xffffff, alpha: 0.7 });
    }
  }

  function drawFlag() {
    flagG.clear();
    const f = st.flag;
    if (!f) return;
    const s = pet.state();
    if (s.mode !== 'walk') { st.flag = null; return; }
    f.t += 1 / 60;
    const bob = Math.sin(f.t * 6) * 1.5;
    flagG.zIndex = f.y - 0.5;
    flagG.ellipse(f.x, f.y, 6, 2.5).stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
    flagG.moveTo(f.x, f.y).lineTo(f.x, f.y - 14 + bob).stroke({ width: 1.2, color: 0x3a2a1a, alpha: 1 });
    flagG.poly([f.x, f.y - 14 + bob, f.x + 8, f.y - 11 + bob, f.x, f.y - 8 + bob]).fill({ color: 0xff6b5a });
  }

  function placeBubble() {
    const b = $('bubble');
    if (st.bubbleT <= 0) { b.classList.add('hidden'); return; }
    const s = pet.state();
    const [x, y] = toScreen(s.x, petSprite.y - PET_H - 4);
    b.style.left = `${Math.round(x)}px`;
    b.style.top = `${Math.round(y)}px`;
  }

  function crops() {
    for (const o of objs.values()) {
      if (!o.crops) continue;
      const stage = plotOf(o.id).stage;
      const name = o.def.crops.stages[Math.min(stage, o.def.crops.stages.length - 1)];
      for (const c of o.crops) { const t = name ? tex(name) : P.Texture.EMPTY; if (c.texture !== t) c.texture = t; }
    }
  }

  let fpsN = 0;
  let fpsT = 0;
  let cardT = 0;
  app.ticker.add((tk) => {
    const dt = Math.min(0.1, tk.deltaMS / 1000);
    st.t += dt;
    st.frames += 1;
    fpsN += 1; fpsT += dt;
    if (fpsT >= 1) { st.fps = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; }
    stepTime(dt);
    const g = SKY.grade(st.hour, SKY.mixWeather(st.wx.from, st.wx.to, st.wx.k));
    st.lastGrade = g;
    grade.matrix = SKY.gradeMatrix(g);
    lightPet(g);
    stepWorld(dt, g);
    for (const ev of pet.step(dt, { phase: g.phase, roam: st.roam })) {
      if (ev.type === 'use-end') onUseEnd(ev);
      else if (ev.type === 'use-start') onUseStart(ev);
      else if (ev.type === 'arrive') {
        if (ev.why === 'fly' && st.flyTarget) {
          const f = st.flyTarget;
          st.flyTarget = null;
          f.targeted = false;
          if (Math.hypot(f.x - ev.x, f.y + 4 - ev.y) < 28) { f.caught = true; pet.touch(); say(pick('firefly')); report({ type: 'collect', item: 'firefly' }); }
        } else if (ev.why === 'click' && !ev.obj && rnd() < 0.3) say(pick('arrive'));
      }
    }
    if (st.follow && !st.drag) {
      const s = pet.state();
      st.camX += (s.x - st.camX) * Math.min(1, dt * 1.6);
      // with a card open she is kept in the part of the window above it
      const card = st.card ? $(st.card === 'sky' ? 'sky-card' : 'quest-card').offsetHeight + 64 : 0;
      const want = s.y - PET_H / 2 + (card / 2) / st.zoom;
      st.camY += (want - st.camY) * Math.min(1, dt * 1.6);
    }
    applyCam();
    crops();
    drawWater(dt);
    drawShadows(g);
    drawLights(dt, g);
    drawWeather(dt, g);
    drawPet(dt);
    drawOutline();
    drawFlag();
    if (st.bubbleT > 0) st.bubbleT -= dt;
    placeBubble();
    if (st.toastT > 0) { st.toastT -= dt; if (st.toastT <= 0) $('toast').classList.add('hidden'); }
    cardT -= dt;
    if (cardT <= 0) { cardT = 0.25; renderCard(); glassFor(g); }
  });

  // ---- main → page -------------------------------------------------------------------------------------
  window.game.onSettings((p) => {
    if (!p) return;
    if (p.scene) {
      const prev = st.scene;
      st.scene = { ...st.scene, ...p.scene };
      if (p.scene.weather && p.scene.weather !== st.wx.to) st.wx = { from: st.wx.to, to: p.scene.weather, k: 0 };
      if (!st.scene.followClock && !st.scene.dayFlow && p.scene.hour !== undefined && Math.abs(SKY.hourDelta(p.scene.hour, st.target)) > 0.2 && prev.hour !== p.scene.hour) { st.target = p.scene.hour; st.ease = true; }
    }
    if (typeof p.roam === 'boolean') st.roam = p.roam;
    renderCard();
  });
  window.game.onView((v) => {
    const a = st.view && st.view.look;
    const b = v && v.look;
    st.view = v;
    if (b && (!a || a.url !== b.url)) loadSprite(b);
    $('who').textContent = v && v.name ? `${v.name} 在这里` : '';
  });
  window.game.onHidden(() => { window.game.set({ hour: Math.round(st.hour * 4) / 4 % 24 }).catch(() => {}); window.game.saveState(st.world); });

  // ---- go ----------------------------------------------------------------------------------------------------
  $('who').textContent = st.view && st.view.name ? `${st.view.name} 在这里` : '';
  await loadSprite(st.view && st.view.look);
  renderCard();
  renderQuests();
  showCard('sky');
  syncFollow();
  applyCam();
  $('loading').classList.add('hidden');
  window.addEventListener('beforeunload', () => window.game.saveState(st.world));

  // e2e read-out and handles (docs/mini-games.md §9)
  window.__game = () => {
    const s = pet.state();
    const [sx, sy] = toScreen(s.x, s.y);
    return {
      ready: true, id: M.id, name: M.name, fps: st.fps, frames: st.frames, renderer: app.renderer.name,
      hour: st.hour, target: st.target, phase: SKY.phaseOf(st.hour), scene: { ...st.scene },
      weather: { ...st.wx }, grade: st.lastGrade && { mul: st.lastGrade.mul, sat: st.lastGrade.sat, lights: st.lastGrade.lights, flies: st.lastGrade.flies },
      counts: { drops: drops.length, flakes: flakes.length, clouds: clouds.filter((c) => c.want).length, fliesLit: flies.filter((f) => f.a > 0.2).length, fog: fog.alpha },
      pet: { ...s, screen: [sx, sy], sprite: st.sprite ? st.sprite.kind : null, visible: petSprite.visible, texture: petSprite.texture && petSprite.texture.width },
      camera: { x: st.camX, y: st.camY, zoom: st.zoom, follow: st.follow },
      world: JSON.parse(JSON.stringify(st.world)), lampLit: lampLit(),
      quests: st.quests, items: st.items, events: st.events.slice(-30), line: st.lastLine || null,
      objects: [...objs.values()].filter((o) => o.def.use).map((o) => ({ id: o.id, x: o.x, y: o.y, at: o.def.use.at, screen: toScreen(o.x, o.y - (o.sprite ? o.sprite.height / 2 : 0)), label: useLabel(o) })),
      walkable: GW.walkableCount(world),
      flies: flies.map((f, i) => ({ i, x: f.x, y: f.y - f.z, a: f.a })).filter((f) => f.a > 0.45 && !flies[f.i].caught),
    };
  };
  window.__gameTest = {
    toScreen, toWorld,
    clickWorld: (x, y) => { const [sx, sy] = toScreen(x, y); return clickAt(sx, sy); },
    use: (id) => pet.use(id, 'click'),
    goTo: (x, y) => pet.goTo(x, y, 'click'),
    setHour: (h) => setHour(h, { ease: false }),
    setWeather: (id) => { setWeather(id, true); st.wx.k = 1; },
    look: (x, y, z) => { st.follow = false; syncFollow(); st.camX = x; st.camY = y; if (z) st.zoom = z; applyCam(); },
    follow: (on) => { st.follow = on; syncFollow(); },
    roam: (on) => { st.roam = on; },
    showCard,
    plots: (stage) => { for (const o of objs.values()) if (o.crops) plotOf(o.id).stage = stage; saveState(); },
    resetBerries: () => { st.world.berries = 0; },
  };
})();
