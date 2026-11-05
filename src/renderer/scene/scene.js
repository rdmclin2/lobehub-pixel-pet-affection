'use strict';
// 像素小院 · 页面 (docs/pixel-scene-design.md §3–§6, docs/pixel-scene.md). One 320×200 logical canvas ("world")
// is composed every frame, layer by layer — sky / ground + waterfall / shadows / props and her sorted by their
// feet / clouds / rain and snow / the light mask (ambient multiply, lamps and windows cut out of it, warm glow) /
// fireflies / hints — then drawn onto the screen canvas scaled by a whole number (no smoothing), letter-boxed.
// The logic lives in the pure modules: SceneTime (hour → light), SceneWeather (weather params and particles),
// SceneMap (tiles and paths), ScenePet (her state machine). window.__scene() is the e2e's read-out.
(function () {
  const T = window.SceneTime;
  const Wx = window.SceneWeather;
  const M = window.SceneMap;
  const SP = window.ScenePet;
  const Fx = window.PetFx;
  const A = window.SceneArt;
  const LW = 320;
  const LH = 200;
  const STEP = 1 / 30;
  const PET_H = 44; // her height in the yard (logical px)
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const sctx = stage.getContext('2d');
  const world = A.canvas(LW, LH);
  const wctx = world.getContext('2d');
  const lightC = A.canvas(LW, LH);
  const lctx = lightC.getContext('2d');

  const map = M.createMap();
  const art = A.buildArt(map);
  const rnd = Math.random;
  const pet = SP.createScenePet({ map, rnd });

  // ---- state -------------------------------------------------------------------------------------------
  const st = {
    scene: { followClock: true, hour: 12, weather: 'clear', autoWeather: false },
    hour: 12, // what is on screen (approaches the target)
    tau: 0.6,
    weather: { from: 'clear', to: 'clear', k: 1 },
    autoLeft: Wx.autoDelay(rnd),
    particles: [],
    clouds: [],
    fireflies: [],
    lamp: { manual: null, autoWas: null, flicker: 0 },
    flowers: { wateredUntil: 0 },
    ripples: [],
    flag: null,
    hoverProp: null,
    lightning: { next: 6 + rnd() * 12, t: 0 },
    scale: 1, ox: 0, oy: 0, dpr: 1,
    t: 0,
    frames: 0,
    sprite: null, // { ready, kind, frames: { state: [canvas…] }, actions, w, h }
    view: null,
    dragging: null,
    bubbleT: 0,
    lastLight: null,
    lastMix: null,
    roam: true,
  };
  const targetHour = () => (st.scene.followClock ? T.clockHour(new Date()) : st.scene.hour);

  // ---- her sprite: every frame of the actions she uses here, pre-scaled to PET_H with hard edges ---------
  const USED = ['idle', 'walk', 'play', 'pat', 'look', 'lifted', 'sleep', 'happy'];
  function shrink(src, sx, sy, sw, sh, h) {
    const w = Math.max(1, Math.round((sw * h) / sh));
    const big = A.canvas(w * 4, h * 4);
    const b = big.getContext('2d');
    b.imageSmoothingEnabled = true;
    b.imageSmoothingQuality = 'high';
    b.drawImage(src, sx, sy, sw, sh, 0, 0, w * 4, h * 4);
    const out = A.canvas(w, h);
    const o = out.getContext('2d');
    o.imageSmoothingEnabled = true;
    o.imageSmoothingQuality = 'high';
    o.drawImage(big, 0, 0, w, h);
    const img = o.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) d[i + 3] = d[i + 3] >= 128 ? 255 : 0; // alpha threshold: no soft fringe
    o.putImageData(img, 0, 0);
    // a 1 px dark outline keeps her readable on grass
    const ol = A.canvas(w + 2, h + 2);
    const c = ol.getContext('2d');
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3];
    c.fillStyle = 'rgba(28,30,26,0.85)';
    for (let y = -1; y <= h; y++) for (let x = -1; x <= w; x++) if (!at(x, y) && (at(x - 1, y) || at(x + 1, y) || at(x, y - 1) || at(x, y + 1))) c.fillRect(x + 1, y + 1, 1, 1);
    c.drawImage(out, 1, 1);
    return ol;
  }
  // bounding box of the opaque pixels of one frame of the sheet (so a frame with empty margins is not tiny)
  function opaqueBox(src, sx, sy, sw, sh) {
    const k = 8;
    const w = Math.max(1, Math.round(sw / k));
    const h = Math.max(1, Math.round(sh / k));
    const c = A.canvas(w, h);
    const x = c.getContext('2d');
    x.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (d[(yy * w + xx) * 4 + 3] > 40) { x0 = Math.min(x0, xx); y0 = Math.min(y0, yy); x1 = Math.max(x1, xx); y1 = Math.max(y1, yy); }
    if (x1 < 0) return { x: sx, y: sy, w: sw, h: sh };
    return { x: sx + x0 * k, y: sy + y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
  }
  async function loadSprite(look) {
    const token = {};
    st.spriteToken = token;
    try {
      if (!look || !look.url) throw new Error('no art');
      const blob = await fetch(look.url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
      const bmp = await createImageBitmap(blob);
      const sprite = { ready: true, kind: look.kind, url: look.url, packId: look.packId || null, frames: {}, actions: {} };
      if (look.kind === 'sprites' && look.frame && look.actions) {
        const fw = look.frame.width;
        const fh = look.frame.height;
        // one scale for every frame: her standing height (the idle frame's opaque box) becomes PET_H, and every
        // frame is cut at the same rows (her feet stay put from frame to frame)
        const idle = look.actions.idle || Object.values(look.actions)[0];
        const ref = opaqueBox(bmp, idle.col * fw, idle.row * fh, fw, fh);
        const top = Math.max(0, ref.y - idle.row * fh - Math.round(ref.h * 0.15));
        const bottom = Math.min(fh, ref.y - idle.row * fh + ref.h + 8);
        const k = PET_H / ref.h;
        for (const want of USED) {
          const name = Fx.resolveAction(want, (n) => !!look.actions[n]).name;
          const a = look.actions[name] || idle;
          sprite.actions[want] = { name, fps: a.fps || 2, frames: a.frames || 1 };
          sprite.frames[want] = [];
          for (let i = 0; i < (a.frames || 1); i++) sprite.frames[want].push(shrink(bmp, (a.col + i) * fw, a.row * fh + top, fw, bottom - top, Math.round((bottom - top) * k)));
        }
      } else {
        // a picture / Live2D / VRM / full-motion look: her picture as a paper cut-out that hops when she walks
        const box = opaqueBox(bmp, 0, 0, bmp.width, bmp.height);
        const one = shrink(bmp, box.x, box.y, box.w, box.h, PET_H);
        for (const want of USED) { sprite.frames[want] = [one]; sprite.actions[want] = { name: want, fps: 1, frames: 1 }; }
        sprite.paper = true;
      }
      if (bmp.close) bmp.close();
      if (st.spriteToken === token) st.sprite = sprite;
    } catch (e) {
      if (st.spriteToken === token) st.sprite = { ready: true, kind: 'placeholder', frames: {}, actions: {}, error: String(e && e.message) };
    }
  }

  // ---- input: screen px → logical px ------------------------------------------------------------------
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    const scale = Math.max(1, Math.floor(Math.min(W / LW, H / LH)));
    stage.width = LW * scale;
    stage.height = LH * scale;
    stage.style.width = `${stage.width / dpr}px`;
    stage.style.height = `${stage.height / dpr}px`;
    const ox = Math.round((W - stage.width) / 2);
    const oy = Math.round((H - stage.height) / 2);
    stage.style.left = `${ox / dpr}px`;
    stage.style.top = `${oy / dpr}px`;
    Object.assign(st, { scale, ox, oy, dpr });
    sctx.imageSmoothingEnabled = false;
  }
  const toLogical = (cx, cy) => ({ x: Math.floor((cx * st.dpr - st.ox) / st.scale), y: Math.floor((cy * st.dpr - st.oy) / st.scale) });
  const toClient = (x, y) => ({ x: (x * st.scale + st.ox + st.scale / 2) / st.dpr, y: (y * st.scale + st.oy + st.scale / 2) / st.dpr });
  function petBox() {
    const p = pet.state();
    const f = currentFrame(p);
    const w = f ? f.width : 20;
    const h = f ? f.height : PET_H;
    return { x: Math.round(p.drawX - w / 2), y: Math.round(p.drawY - h + 2), w, h };
  }
  const onPet = (l) => { const b = petBox(); return l.x >= b.x + 3 && l.x < b.x + b.w - 3 && l.y >= b.y + 3 && l.y < b.y + b.h; };

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const l = toLogical(e.clientX, e.clientY);
    if (onPet(l)) { st.dragging = { start: l, lifted: false, id: e.pointerId }; stage.setPointerCapture(e.pointerId); }
  });
  stage.addEventListener('pointermove', (e) => {
    const l = toLogical(e.clientX, e.clientY);
    if (st.dragging) {
      if (!st.dragging.lifted && Math.hypot(l.x - st.dragging.start.x, l.y - st.dragging.start.y) > 3) { st.dragging.lifted = true; pet.pick(l.x, l.y + 6); stage.classList.add('dragging'); }
      if (st.dragging.lifted) pet.move(l.x, l.y + 6);
      return;
    }
    const prop = M.propAt(map, l.x, l.y);
    st.hoverProp = prop ? prop.id : null;
    stage.classList.toggle('can-click', !!prop || onPet(l));
  });
  stage.addEventListener('pointerleave', () => { if (!st.dragging) { st.hoverProp = null; stage.classList.remove('can-click'); } });
  stage.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    const l = toLogical(e.clientX, e.clientY);
    const d = st.dragging;
    st.dragging = null;
    stage.classList.remove('dragging');
    if (d && d.lifted) { pet.drop(); return; }
    const prop = M.propAt(map, l.x, l.y);
    // her picture covers the prop she stands at (under the lamp): a click there means the prop, not her
    const atSpot = (q) => { const t = M.tileOf(map, pet.state().x, pet.state().y); return q && q.spot && t[0] === q.spot[0] && t[1] === q.spot[1]; };
    if (d && !atSpot(prop)) { pokePet(); return; }
    if (prop) { const r = pet.clickProp(prop.id); if (r.ok) st.flag = null; return; }
    if (l.x < 0 || l.y < 0 || l.x >= LW || l.y >= LH) return;
    const r = pet.clickGround(l.x, l.y);
    if (r.ok) st.flag = { x: r.target.x, y: r.target.y, t: 0 };
  });
  function pokePet() {
    pet.poke();
    window.scene.touch().then((r) => {
      const line = r && (r.say || r.line || r.text || (r.reply && r.reply.text));
      if (typeof line === 'string' && line) showBubble(line);
    }).catch(() => {});
  }
  function showBubble(text) {
    const b = $('bubble');
    b.textContent = text.slice(0, 80);
    b.classList.remove('hidden');
    st.bubbleT = 3.5;
  }

  // ---- the 天色 card -------------------------------------------------------------------------------------
  const ICONS = {
    sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    rise: '<svg viewBox="0 0 24 24"><path d="M12 2v8"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m8 6 4-4 4 4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>',
    set: '<svg viewBox="0 0 24 24"><path d="M12 10V2"/><path d="m4.93 10.93 1.41 1.41"/><path d="M2 18h2"/><path d="M20 18h2"/><path d="m19.07 10.93-1.41 1.41"/><path d="M22 22H2"/><path d="m16 6-4 4-4-4"/><path d="M16 18a4 4 0 0 0-8 0"/></svg>',
    moon: '<svg viewBox="0 0 24 24"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
    clear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="M2 12h2"/><path d="M20 12h2"/></svg>',
    cloudy: '<svg viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
    rain: '<svg viewBox="0 0 24 24"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/></svg>',
    snow: '<svg viewBox="0 0 24 24"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/></svg>',
    storm: '<svg viewBox="0 0 24 24"><path d="M6 16.326A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 .5 8.973"/><path d="m13 12-3 5h4l-3 5"/></svg>',
    fog: '<svg viewBox="0 0 24 24"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 17H7"/><path d="M17 21H9"/></svg>',
  };
  const PHASE_ICON = { dawn: 'rise', day: 'sun', dusk: 'set', night: 'moon' };
  const slider = $('time-slider');
  let sliding = false;
  const save = (patch) => window.scene.set(patch).then((r) => { if (r && r.ok) applyScene(r.scene); return r; });

  slider.addEventListener('input', () => {
    sliding = true;
    st.scene = { ...st.scene, followClock: false, hour: Number(slider.value) };
    st.tau = 0.15;
    renderCard(true);
  });
  slider.addEventListener('change', () => { sliding = false; save({ followClock: false, hour: Number(slider.value) }); });
  const jump = (h) => { st.tau = 1; st.scene = { ...st.scene, followClock: false, hour: h }; renderCard(true); save({ followClock: false, hour: h }); };
  for (const b of document.querySelectorAll('[data-phase]')) b.addEventListener('click', () => jump(T.phaseInfo(b.dataset.phase).jump));
  $('time-prev').addEventListener('click', () => jump(T.stepPhase(st.scene.followClock ? st.hour : st.scene.hour, -1)));
  $('time-next').addEventListener('click', () => jump(T.stepPhase(st.scene.followClock ? st.hour : st.scene.hour, 1)));
  $('follow-clock').addEventListener('click', () => { const v = !st.scene.followClock; st.tau = 1; st.scene = { ...st.scene, followClock: v }; renderCard(true); save({ followClock: v }); });
  const pickWeather = (id) => { setWeather(id); st.scene = { ...st.scene, weather: id, autoWeather: false }; renderCard(true); save({ weather: id, autoWeather: false }); };
  for (const b of document.querySelectorAll('[data-weather]')) b.addEventListener('click', () => pickWeather(b.dataset.weather));
  const stepWeather = (dir) => { const ids = Wx.WEATHER_IDS; pickWeather(ids[(ids.indexOf(st.scene.weather) + (dir < 0 ? ids.length - 1 : 1)) % ids.length]); };
  $('weather-prev').addEventListener('click', () => stepWeather(-1));
  $('weather-next').addEventListener('click', () => stepWeather(1));
  $('auto-weather').addEventListener('click', () => { const v = !st.scene.autoWeather; st.scene = { ...st.scene, autoWeather: v }; st.autoLeft = Wx.autoDelay(rnd); renderCard(true); save({ autoWeather: v }); });
  const fold = (v) => { $('sky-card').classList.toggle('folded', v); $('btn-fold').setAttribute('aria-expanded', String(!v)); };
  $('btn-fold').addEventListener('click', () => fold(!$('sky-card').classList.contains('folded')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') fold(true);
    // Ctrl/⌘+W, Ctrl/⌘+Shift+H: close the yard (main catches them too, before the page)
    const mod = /Mac/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
    if (mod && !e.altKey && ((e.code === 'KeyW' && !e.shiftKey) || (e.code === 'KeyH' && e.shiftKey))) { e.preventDefault(); window.scene.close('key'); }
  });
  $('btn-close').addEventListener('click', () => window.scene.close('button'));

  let cardSig = '';
  function renderCard(force = false) {
    const shownHour = st.scene.followClock ? targetHour() : st.scene.hour;
    const phase = T.phaseOf(shownHour);
    const info = T.phaseInfo(phase);
    const w = Wx.weatherOf(st.scene.weather);
    const sig = `${phase}|${T.formatHour(shownHour)}|${st.scene.followClock}|${w.id}|${st.scene.autoWeather}|${st.dark}`;
    if (!force && sig === cardSig) return;
    cardSig = sig;
    $('time-name').textContent = `${info.name} · ${T.formatHour(shownHour)}`;
    $('time-icon').innerHTML = ICONS[PHASE_ICON[phase]];
    if (!sliding) slider.value = String(Math.round(shownHour * 4) / 4 % 24);
    for (const b of document.querySelectorAll('[data-phase]')) b.setAttribute('aria-pressed', String(b.dataset.phase === phase));
    $('follow-clock').setAttribute('aria-checked', String(st.scene.followClock));
    $('weather-name').textContent = w.name;
    $('weather-icon').innerHTML = ICONS[w.id];
    for (const b of document.querySelectorAll('[data-weather]')) b.setAttribute('aria-pressed', String(b.dataset.weather === w.id));
    $('auto-weather').setAttribute('aria-checked', String(st.scene.autoWeather));
    $('sky-hint').textContent = st.scene.followClock ? '小院和你这里的时间同步；拖动滑块改成固定时刻。' : '点空地让她走过去，点长椅、花坛、路灯或池塘让她去玩。';
  }

  function setWeather(id) {
    const cur = st.weather;
    if (cur.to === id) return;
    const from = cur.k >= 0.5 ? cur.to : cur.from;
    st.weather = { from, to: id, k: 0 };
  }
  function applyScene(sc) {
    if (!sc) return;
    const before = st.scene;
    st.scene = { ...sc };
    if (before.weather !== sc.weather) setWeather(sc.weather);
    if (before.followClock !== sc.followClock || before.hour !== sc.hour) st.tau = sliding ? 0.15 : 1;
    renderCard(true);
  }

  // ---- update (fixed step) ------------------------------------------------------------------------------
  function update(dt) {
    st.t += dt;
    st.hour = T.approachHour(st.hour, targetHour(), dt, st.tau);
    const w = st.weather;
    if (w.k < 1) w.k = Math.min(1, w.k + dt / Wx.FADE_S);
    if (w.k >= 1) w.from = w.to;
    const light = T.lightAt(st.hour);
    const mix = Wx.mixWeather(w.from, w.to, w.k);
    st.lastLight = light;
    st.lastMix = mix;
    // 天气自己变 (a local random walk; a manual pick switched it off)
    if (st.scene.autoWeather) {
      st.autoLeft -= dt;
      if (st.autoLeft <= 0) {
        st.autoLeft = Wx.autoDelay(rnd);
        const next = Wx.nextWeather(st.scene.weather, rnd, { month: new Date().getMonth() });
        if (next !== st.scene.weather) { setWeather(next); st.scene = { ...st.scene, weather: next }; save({ weather: next }); }
      }
    }
    // rain and snow (fewer with reduced motion)
    const targets = reduced ? { rain: Math.round(mix.targets.rain / 2), snow: Math.round(mix.targets.snow / 2) } : mix.targets;
    Wx.stepParticles(st.particles, dt, { targets, rain: mix.rain }, rnd);
    stepClouds(dt, mix, light);
    stepFireflies(dt, mix, light);
    // lightning (storm only, never with reduced motion)
    if (mix.lightning && !reduced) {
      st.lightning.next -= dt;
      if (st.lightning.next <= 0) { st.lightning.t = 0.12; st.lightning.next = 6 + rnd() * 12; }
    }
    if (st.lightning.t > 0) st.lightning.t -= dt;
    // the lamp: on by itself after dark; a manual switch holds until the next dusk / dawn
    const autoOn = light.lights > 0.5;
    if (st.lamp.autoWas !== null && st.lamp.autoWas !== autoOn) st.lamp.manual = null;
    st.lamp.autoWas = autoOn;
    if (st.lamp.flicker > 0) st.lamp.flicker -= dt;
    // her
    pet.setNight(light.phase === 'night');
    pet.setRoam(st.roam);
    pet.tick(dt);
    for (const e of pet.drain()) onPetEvent(e);
    if (st.flag) { st.flag.t += dt; const p = pet.state(); if (p.mode !== 'goto') st.flag = null; }
    // the pond's rings: rain drops on it, her looking at it
    if (mix.targets.rain > 20 && rnd() < dt * 6 * Math.min(1, mix.targets.rain / 160)) addRipple();
    for (const r of st.ripples) r.t += dt;
    st.ripples = st.ripples.filter((r) => r.t < 1.2);
    if (st.bubbleT > 0) { st.bubbleT -= dt; if (st.bubbleT <= 0) $('bubble').classList.add('hidden'); }
  }
  const lampOn = () => (st.lamp.manual !== null ? st.lamp.manual : !!(st.lastLight && st.lastLight.lights > 0.5));
  const flowersWatered = () => Date.now() < st.flowers.wateredUntil || (st.lastMix && st.lastMix.targets.rain > 40);
  function addRipple(x, y) {
    const water = [];
    for (let r = 0; r < map.rows; r++) for (let c = 0; c < map.cols; c++) if (map.ground[r][c] === '~') water.push([c, r]);
    const [c, r] = water[Math.floor(rnd() * water.length)];
    st.ripples.push({ x: x !== undefined ? x : c * 16 + 3 + Math.floor(rnd() * 10), y: y !== undefined ? y : r * 16 + 3 + Math.floor(rnd() * 10), t: 0 });
  }
  function onPetEvent(e) {
    if (e.type === 'act-fire' && e.act === 'lamp') { st.lamp.manual = !lampOn(); st.lamp.flicker = 0.3; }
    if (e.type === 'act-fire' && e.act === 'water') st.flowers.wateredUntil = Date.now() + 10 * 60 * 1000;
    if (e.type === 'act-start' && e.act === 'look') { addRipple(214, 134); addRipple(222, 140); }
    if (e.type === 'act-done' || (e.type === 'act-start' && e.act === 'sit')) window.scene.act(e.act, e.prop);
  }

  function stepClouds(dt, mix, light) {
    const want = mix.clouds;
    const live = st.clouds.filter((c) => !c.leaving);
    if (live.length < want) st.clouds.push({ x: rnd() * (LW + 40) - 40, y: 4 + rnd() * 40, art: Math.floor(rnd() * art.clouds.length), a: 0, speed: 0.6 + rnd() * 0.8, layer: rnd() < 0.5 ? 0 : 1 });
    else if (live.length > want) live[Math.floor(rnd() * live.length)].leaving = true;
    const speed = Wx.weatherOf(mix.to).clouds.speed;
    for (const c of st.clouds) {
      c.x += speed * c.speed * (c.layer ? 1 : 0.5) * dt;
      if (c.x > LW + 10) c.x = -60;
      c.a = c.leaving ? Math.max(0, c.a - dt / 2) : Math.min(1, c.a + dt / 2);
    }
    st.clouds = st.clouds.filter((c) => !(c.leaving && c.a <= 0));
    st.cloudTone = light.lights > 0.5 ? Wx.weatherOf(mix.to).clouds.night : Wx.weatherOf(mix.to).clouds.day;
  }
  function stepFireflies(dt, mix, light) {
    const want = light.lights > 0.5 ? Math.round(mix.fireflies * light.lights) : 0;
    while (st.fireflies.length < want) st.fireflies.push({ x: 40 + rnd() * 240, y: 24 + rnd() * 140, vx: 0, vy: 0, ph: rnd() * 6.28 });
    if (st.fireflies.length > want) st.fireflies.length = want;
    for (const f of st.fireflies) {
      f.vx += (rnd() - 0.5) * 20 * dt;
      f.vy += (rnd() - 0.5) * 20 * dt;
      f.vx *= 0.96; f.vy *= 0.96;
      f.x = Math.max(34, Math.min(286, f.x + f.vx * dt));
      f.y = Math.max(18, Math.min(170, f.y + f.vy * dt));
      f.ph += dt * 2.4;
    }
  }

  // ---- draw ---------------------------------------------------------------------------------------------
  function currentFrame(p) {
    const s = st.sprite;
    if (!s || !s.frames) return null;
    const list = s.frames[p.state] || s.frames.idle;
    if (!list || !list.length) return null;
    const a = s.actions[p.state] || s.actions.idle || { fps: 2, frames: list.length };
    return list[Math.floor(st.t * a.fps) % list.length];
  }
  const skyCache = { key: '', c: null };
  function drawSky(light) {
    const key = `${light.skyTop}${light.skyBottom}`;
    if (skyCache.key !== key) {
      const c = skyCache.c || A.canvas(LW, LH);
      const x = c.getContext('2d');
      // 3 bands (top, mid, bottom) with a Bayer-dithered seam between them
      const mid = T.lerpLinearRGB(light.skyTop, light.skyBottom, 0.5);
      const bands = [light.skyTop, mid, light.skyBottom];
      const bh = LH / 3;
      for (let y = 0; y < LH; y++) {
        const f = y / bh;
        const i = Math.min(2, Math.floor(f));
        const frac = f - i;
        for (let xx = 0; xx < LW; xx++) {
          const next = Math.min(2, i + 1);
          const use = frac > 0.6 && (frac - 0.6) / 0.4 * 16 > A.BAYER[y & 3][xx & 3] ? next : i;
          x.fillStyle = bands[use];
          x.fillRect(xx, y, 1, 1);
        }
      }
      skyCache.c = c;
      skyCache.key = key;
    }
    wctx.drawImage(skyCache.c, 0, 0);
    // stars at night
    if (light.lights > 0.5) {
      for (let i = 0; i < 40; i++) {
        const x = Math.floor(A.hash(i, 7, 60) * LW);
        const y = Math.floor(A.hash(i, 8, 61) * LH);
        const tw = Math.sin(st.t * (1 + A.hash(i, 9, 62) * 2) + i) > 0.2;
        if (tw) A.R(wctx, x, y, 1, 1, `rgba(255,255,240,${(0.4 + 0.5 * A.hash(i, 3, 63)) * light.lights})`);
      }
    }
  }
  function drawWaterfall() {
    const top = (map.rows - 1) * 16;
    const fr = Math.floor(st.t * 8) % 4;
    for (let x = 208; x < 272; x++) {
      for (let y = top; y < LH; y++) {
        const v = (y + fr * 2 + Math.floor(A.hash(x, 0, 70) * 6)) % 6;
        A.R(wctx, x, y, 1, 1, v < 2 ? A.P.w3 : v < 4 ? A.P.w2 : A.P.w1);
      }
    }
    for (let x = 206; x < 274; x += 3) A.R(wctx, x + (fr % 2), LH - 3, 2, 3, 'rgba(232,248,250,0.8)');
  }
  function drawShimmer() {
    const fr = Math.floor(st.t * 2) % 2;
    for (let i = 0; i < 10; i++) {
      const x = 212 + Math.floor(A.hash(i, fr, 80) * 56);
      const y = 130 + Math.floor(A.hash(i, fr, 81) * 44);
      const [c, r] = M.tileOf(map, x, y);
      if (map.ground[r] && map.ground[r][c] === '~') A.R(wctx, x, y, 2, 1, A.P.w3);
    }
    for (const r of st.ripples) {
      const rad = 1 + Math.floor(r.t * 5);
      const a = 1 - r.t / 1.2;
      wctx.fillStyle = `rgba(200,240,238,${a})`;
      wctx.fillRect(r.x - rad, r.y, 1, 1); wctx.fillRect(r.x + rad, r.y, 1, 1);
      wctx.fillRect(r.x, r.y - Math.ceil(rad / 2), 1, 1); wctx.fillRect(r.x, r.y + Math.ceil(rad / 2), 1, 1);
    }
  }
  function ellipse(ctx, cx, cy, rx, ry, color) {
    ctx.fillStyle = color;
    for (let y = -ry; y <= ry; y++) {
      const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry))));
      ctx.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1);
    }
  }
  function drawShadows(light, mix) {
    const a = light.shadowAlpha * mix.shadowMul;
    const dx = light.sunAngle === null ? 0 : Math.round(-Math.cos((light.sunAngle * Math.PI) / 180) * 5);
    const col = `rgba(10,30,10,${a.toFixed(3)})`;
    for (const p of map.props) {
      if (p.kind === 'tree') ellipse(wctx, p.box[0] + 16 + dx * 2, p.foot - 2, 13, 4, col);
      else if (p.kind === 'house') { wctx.fillStyle = col; wctx.fillRect(p.box[0] + 4 + dx * 2, p.foot - 2, 56, 5); }
      else if (p.kind === 'bench') ellipse(wctx, p.box[0] + 16 + dx, p.foot - 1, 14, 2, col);
      else if (p.kind === 'lamp') ellipse(wctx, p.box[0] + 8 + dx, p.foot - 1, 5, 2, col);
    }
    const s = pet.state();
    if (s.mode !== 'lifted') ellipse(wctx, s.drawX + dx, s.drawY, 7, 2, `rgba(10,30,10,${Math.max(0.12, a).toFixed(3)})`);
    else ellipse(wctx, s.x, Math.min(176, s.y + 14), 6, 2, 'rgba(10,30,10,0.2)');
  }
  function drawProp(p, light) {
    const [x, y] = p.box;
    if (p.kind === 'house') {
      wctx.drawImage(art.house, x, y);
      const lit = light.lights;
      for (const [gx, gy, gw, gh] of A.HOUSE_GLASS) {
        A.R(wctx, x + gx, y + gy, gw, gh, lit > 0.3 ? A.P.winLit : A.P.winDark);
        A.R(wctx, x + gx + gw / 2, y + gy, 1, gh, A.P.d0);
        A.R(wctx, x + gx, y + gy + gh / 2, gw, 1, A.P.d0);
        if (lit <= 0.3) A.R(wctx, x + gx + 1, y + gy + 1, 2, 1, '#6a7aa0');
      }
    } else if (p.kind === 'tree') wctx.drawImage(art.trees[p.id], x, y);
    else if (p.kind === 'bench') wctx.drawImage(art.bench, x, y);
    else if (p.kind === 'flowerbed') { wctx.drawImage(art.bed, x, y); A.drawFlowers(wctx, x, y, flowersWatered(), Math.floor(st.t * 2) % 2); }
    else if (p.kind === 'lamp') {
      wctx.drawImage(art.lamp, x, y);
      const on = lampOn() && !(st.lamp.flicker > 0 && Math.floor(st.lamp.flicker * 20) % 2);
      const [gx, gy, gw, gh] = A.LAMP_GLASS;
      A.R(wctx, x + gx, y + gy, gw, gh, on ? A.P.glassOn : A.P.glassOff);
    }
    if (st.hoverProp === p.id) outline(p);
  }
  function outline(p) {
    const [x, y, w, h] = p.box;
    wctx.fillStyle = 'rgba(255,255,255,0.9)';
    wctx.fillRect(x, y - 1, w, 1); wctx.fillRect(x, y + h, w, 1); wctx.fillRect(x - 1, y, 1, h); wctx.fillRect(x + w, y, 1, h);
  }
  function drawPet() {
    const p = pet.state();
    const f = currentFrame(p);
    const hop = st.sprite && st.sprite.paper && p.state === 'walk' ? (Math.floor(st.t * 6) % 2) : 0;
    const lift = p.mode === 'lifted' ? 6 : 0;
    if (!f) { // nothing to draw her with yet: a small marker where she is
      A.R(wctx, Math.round(p.drawX) - 4, Math.round(p.drawY) - 14, 8, 14, '#f0a060');
      return;
    }
    let h = f.height;
    if (p.sitting) h = Math.round(f.height * 0.62); // sitting: only down to her waist, the bench hides her legs
    const x = Math.round(p.drawX - f.width / 2);
    const y = Math.round(p.drawY - f.height + 2 - hop - lift + (p.sitting ? Math.round(f.height * 0.3) : 0));
    wctx.save();
    if (p.facing === 'left') { wctx.translate(x * 2 + f.width, 0); wctx.scale(-1, 1); }
    wctx.drawImage(f, 0, 0, f.width, h, x, y, f.width, h);
    wctx.restore();
    if (p.state === 'sleep' && Math.floor(st.t) % 2) { A.R(wctx, x + f.width - 2, y - 2, 4, 1, '#ffffff'); A.R(wctx, x + f.width, y - 1, 1, 1, '#ffffff'); A.R(wctx, x + f.width - 2, y, 4, 1, '#ffffff'); }
    if (p.act === 'water' && p.mode === 'interact') { // a watering can and a few drops
      const cx = p.facing === 'left' ? x - 4 : x + f.width;
      A.R(wctx, cx, y + 22, 6, 4, '#5f8fb0'); A.R(wctx, cx + (p.facing === 'left' ? -2 : 6), y + 22, 2, 1, '#5f8fb0');
      const fr = Math.floor(st.t * 8) % 3;
      A.R(wctx, cx + (p.facing === 'left' ? -3 : 8), y + 24 + fr * 2, 1, 1, A.P.w3);
    }
  }
  function drawFlag() {
    if (!st.flag) return;
    const { x, y } = st.flag;
    A.R(wctx, x, y - 10, 1, 10, A.P.d0);
    A.R(wctx, x + 1, y - 10, 5, 3, '#e85a5a');
    A.R(wctx, x - 1, y, 3, 1, 'rgba(0,0,0,0.3)');
  }
  const cloudTint = {};
  function tintedCloud(i, tone) {
    const key = `${i}${tone}`;
    if (!cloudTint[key]) {
      const src = art.clouds[i];
      const c = A.canvas(src.width, src.height);
      const x = c.getContext('2d');
      x.drawImage(src, 0, 0);
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = tone;
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(src, 0, 0);
      cloudTint[key] = c;
    }
    return cloudTint[key];
  }
  function drawCloudsTinted() {
    const tone = st.cloudTone || '#ffffff';
    for (const c of st.clouds.slice().sort((a, b) => a.layer - b.layer)) {
      wctx.globalAlpha = c.a * (c.layer ? 0.95 : 0.8);
      wctx.drawImage(tintedCloud(c.art, tone), Math.round(c.x), Math.round(c.y));
    }
    wctx.globalAlpha = 1;
  }
  function drawParticles() {
    for (const p of st.particles) {
      if (p.kind === 'rain') {
        if (p.splash > 0) { const x = Math.round(p.x); const y = Math.round(p.y); wctx.fillStyle = 'rgba(200,215,230,0.7)'; wctx.fillRect(x - 1, y, 3, 1); wctx.fillRect(x, y - 1, 1, 1); continue; }
        wctx.fillStyle = 'rgba(168,184,200,0.6)';
        // a stair-step slanted line, one pixel at a time (no anti-aliased lineTo)
        const sx = p.vx / p.vy;
        for (let i = 0; i < p.len; i++) wctx.fillRect(Math.round(p.x - sx * i), Math.round(p.y - i), 1, 1);
      } else {
        wctx.fillStyle = '#f4f8ff';
        wctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      }
    }
  }
  const mixWhite = (hex, k) => { const [r, g, b] = T.hexToRgb(hex); return `rgb(${Math.round(255 + (r - 255) * k)},${Math.round(255 + (g - 255) * k)},${Math.round(255 + (b - 255) * k)})`; };
  function lightSources(light) {
    const out = [];
    const L = light.lights;
    const lp = M.propById(map, 'lamp');
    if (lampOn()) out.push({ x: lp.light.x, y: lp.light.y + 8, r: lp.light.r, k: Math.max(0.6, L), color: '255,214,140' });
    if (L > 0.3) for (const [wx, wy] of M.propById(map, 'house').windows) out.push({ x: wx, y: wy, r: 14, k: L, color: '255,200,120' });
    for (const f of st.fireflies) out.push({ x: f.x, y: f.y, r: 5, k: L * (0.5 + 0.5 * Math.sin(f.ph)), color: '220,255,150' });
    return out;
  }
  function drawLight(light, mix) {
    // the ambient multiply (time of day, quantised) and the weather's tint on top of it (also in 8 steps)
    const k = light.ambientK;
    const tk = T.quantize(mix.tint.k);
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, LW, LH);
    if (k > 0 || tk > 0) {
      lctx.fillStyle = mixWhite(light.ambient, k);
      lctx.fillRect(0, 0, LW, LH);
      if (tk > 0) { lctx.globalCompositeOperation = 'multiply'; lctx.fillStyle = mixWhite(mix.tint.color, Math.min(1, tk * 2.5)); lctx.fillRect(0, 0, LW, LH); }
      // light sources cut the darkness out in three stepped rings (pixel-art light, not a smooth gradient)
      lctx.globalCompositeOperation = 'destination-out';
      for (const s of lightSources(light)) {
        for (const [f, a] of [[1, 0.35], [0.66, 0.6], [0.33, 0.9]]) {
          lctx.fillStyle = `rgba(0,0,0,${(a * s.k).toFixed(3)})`;
          ellipse(lctx, s.x, s.y, Math.round(s.r * f), Math.round(s.r * f * 0.7), lctx.fillStyle);
        }
      }
      wctx.globalCompositeOperation = 'multiply';
      wctx.drawImage(lightC, 0, 0);
      wctx.globalCompositeOperation = 'source-over';
    }
    // a warm glow over the lit places
    wctx.globalCompositeOperation = 'lighter';
    for (const s of lightSources(light)) {
      for (const [f, a] of [[1, 0.06], [0.5, 0.1]]) ellipse(wctx, s.x, s.y, Math.max(1, Math.round(s.r * f)), Math.max(1, Math.round(s.r * f * 0.7)), `rgba(${s.color},${(a * s.k).toFixed(3)})`);
    }
    wctx.globalCompositeOperation = 'source-over';
    for (const f of st.fireflies) A.R(wctx, f.x, f.y, 1, 1, `rgba(240,255,170,${(0.5 + 0.5 * Math.sin(f.ph)).toFixed(2)})`);
    // fog bands and the lightning flash
    if (mix.fog > 0) {
      for (let i = 0; i < 3; i++) {
        const y = 40 + i * 50 + Math.round(Math.sin(st.t * 0.2 + i) * 6);
        const x0 = Math.round((st.t * (2 + i) * 2) % 80) - 80;
        for (let yy = 0; yy < 18; yy++) for (let xx = x0; xx < LW; xx += 1) {
          const edge = yy < 3 || yy > 14;
          if (edge && A.BAYER[yy & 3][xx & 3] > 7) continue;
          wctx.fillStyle = `rgba(223,230,232,${mix.fog.toFixed(2)})`;
          wctx.fillRect(xx, y + yy, 1, 1);
        }
      }
    }
    if (st.lightning.t > 0) { wctx.fillStyle = `rgba(255,255,255,${st.lightning.t > 0.06 ? 0.7 : 0.3})`; wctx.fillRect(0, 0, LW, LH); }
  }

  function draw() {
    const light = st.lastLight || T.lightAt(st.hour);
    const mix = st.lastMix || Wx.mixWeather('clear', 'clear', 1);
    wctx.imageSmoothingEnabled = false;
    wctx.globalAlpha = 1;
    wctx.globalCompositeOperation = 'source-over';
    drawSky(light);
    wctx.drawImage(art.ground, 0, 0);
    drawWaterfall();
    drawShimmer();
    drawShadows(light, mix);
    // props and her, sorted by their feet: she walks behind the trees and in front of the bench
    const p = pet.state();
    const items = map.props.filter((x) => x.kind !== 'pond').map((x) => ({ y: x.foot, draw: () => drawProp(x, light) }));
    items.push({ y: p.mode === 'lifted' ? 999 : p.sortY, draw: drawPet });
    items.push({ y: st.flag ? st.flag.y - 0.5 : -1, draw: drawFlag });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    drawCloudsTinted();
    drawParticles();
    drawLight(light, mix);
    // onto the screen: a whole-number scale, no smoothing
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(world, 0, 0, LW, LH, 0, 0, stage.width, stage.height);
    // the card follows the hour: light by day, dark at night
    const dark = light.ambientK >= 0.35;
    if (st.dark !== dark) { st.dark = dark; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }
    // her bubble above her
    if (st.bubbleT > 0) {
      const b = petBox();
      const c = toClient(b.x + b.w / 2, b.y - 2);
      Object.assign($('bubble').style, { left: `${c.x}px`, top: `${c.y}px` });
    }
    st.frames++;
  }

  let last = performance.now();
  let acc = 0;
  function frame(now) {
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    acc += dt;
    while (acc >= STEP) { update(STEP); acc -= STEP; }
    if (st.ready) draw();
    if (st.ready && st.frames % 15 === 0) renderCard();
    requestAnimationFrame(frame);
  }

  // ---- boot ---------------------------------------------------------------------------------------------
  function applyView(v) {
    if (!v) return;
    st.view = v;
    const name = v.pet && v.pet.name;
    $('who').textContent = name ? `${name} 在小院里` : '';
    const look = v.look || null;
    const url = look ? look.url : null;
    if (!st.sprite || st.sprite.url !== url || st.lookKey !== `${look && look.packId}|${url}`) {
      st.lookKey = `${look && look.packId}|${url}`;
      loadSprite(look);
    }
  }
  window.addEventListener('resize', layout);
  layout();
  window.scene.onSettings((m) => { if (m && m.scene) applyScene(m.scene); if (m && typeof m.roam === 'boolean') st.roam = m.roam; });
  window.scene.onView(applyView);
  window.scene.onShown(() => { layout(); last = performance.now(); });
  window.scene.boot().then((b) => {
    if (!b) return;
    st.scene = { ...st.scene, ...b.scene };
    st.weather = { from: b.scene.weather, to: b.scene.weather, k: 1 };
    st.hour = targetHour();
    st.roam = b.roam !== false;
    applyView(b.view);
    // the weather is already there when the yard opens (not built up from nothing)
    const mix = Wx.mixWeather(b.scene.weather, b.scene.weather, 1);
    for (let i = 0; i < 90; i++) Wx.stepParticles(st.particles, 1 / 30, { targets: mix.targets, rain: mix.rain, rate: 2000 }, rnd);
    for (let i = 0; i < mix.clouds; i++) st.clouds.push({ x: rnd() * (LW + 40) - 40, y: 4 + rnd() * 40, art: Math.floor(rnd() * art.clouds.length), a: 1, speed: 0.6 + rnd() * 0.8, layer: i % 2 });
    st.ready = true;
    renderCard(true);
    fold(false); // the card shows once it has the saved time and weather
  });
  requestAnimationFrame(frame);

  // ---- e2e read-out ---------------------------------------------------------------------------------------
  function brightness() {
    const d = wctx.getImageData(0, 0, LW, LH).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4);
  }
  window.__scene = () => {
    const light = st.lastLight || T.lightAt(st.hour);
    const mix = st.lastMix;
    const p = pet.state();
    const b = petBox();
    return {
      ready: !!st.ready, frames: st.frames,
      scale: st.scale, logical: { w: LW, h: LH }, canvas: { w: stage.width, h: stage.height, cssW: stage.style.width, cssH: stage.style.height }, smoothing: sctx.imageSmoothingEnabled,
      layers: ['sky', 'ground', 'waterfall', 'shadows', 'props+pet', 'clouds', 'particles', 'light', 'fireflies'],
      scene: { ...st.scene }, hour: st.hour, target: targetHour(), phase: light.phase,
      light: { ambientK: light.ambientK, lights: light.lights, skyTop: light.skyTop, ambient: light.ambient, shadowAlpha: light.shadowAlpha },
      weather: { ...st.weather, tintK: mix ? mix.tint.k : 0 },
      particles: Wx.countKinds(st.particles), clouds: st.clouds.filter((c) => !c.leaving).length, fireflies: st.fireflies.length,
      lamp: { on: lampOn(), manual: st.lamp.manual }, flowers: { watered: !!flowersWatered() },
      pet: { ...p, ready: !!(st.sprite && st.sprite.ready && st.sprite.kind !== 'placeholder'), kind: st.sprite ? st.sprite.kind : null, url: st.sprite ? st.sprite.url : null, frameH: b.h, frameW: b.w, box: b, error: st.sprite && st.sprite.error },
      brightness: brightness(),
      dark: !!st.dark,
    };
  };
  // logical px → where to click in the window (the e2e clicks the real canvas there)
  window.__sceneToClient = (x, y) => toClient(x, y);
  window.__sceneProps = () => map.props.filter((p) => p.act).map((p) => ({ id: p.id, act: p.act, box: p.box, spot: p.spot }));
})();
