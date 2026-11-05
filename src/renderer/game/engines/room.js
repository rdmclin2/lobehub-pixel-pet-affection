'use strict';
// 她的房间 · 引擎 room@1 (docs/her-room-design.md §4). Plays a room pack (core/room-pack.js) in the game window
// with PixiJS 8. The title bar, the 天色 / 今日小事 cards, the toolbar, her bubble, the tip and the toast are the
// game window's (game.html); this file adds the room's own DOM — the stats card, the activity bar, the furniture
// labels, the room picker and the 即将开放 preview — and draws the room:
//
//   view           the room's world (theme.world, 1024×576) fitted into the window, centred
//   ├ graded       one colour matrix: the hour × the weather at half strength (indoors) × an activity's `dim`
//   │ ├ bg         the room picture (walls, the window frame, the floor, the rug)
//   │ ├ outside    the sky in the window (full-strength grade): sun / moon, clouds, rain, snow
//   │ ├ back       flat furniture she walks over (the bean bag)
//   │ ├ sorted     the furniture and her, ordered by their feet (zIndex = y); the hovered piece's outline
//   │ ├ front      while she is tucked in: the quilt (layer, under: front), then the bed's front (furniture.front)
//   │ └ props      the props an activity shows: the screen, the record, the TV, what she holds
//   ├ lights       additive: the room's lamps (at night), an activity's glow
//   └ particles    Z bubbles, notes, hearts, stars (not graded, so they stay readable)
//
// Her state machine is core/game-pet.js on the room's floor (core/game-world.js); each activity's furniture is
// a thing she walks to and uses. When she gets there the page asks main to start the round (window.game.activity);
// main settles it with its own clock (core/room-play.js, src/main/games.js) when the page's timer says it is over,
// when it is stopped, switched, or the window closes. window.__game() is the e2e's read-out, __gameTest its handles.
(async function () {
  const boot = await (window.__gameBoot || window.game.boot());
  if (!boot || !boot.game || !boot.game.manifest || boot.game.manifest.engine !== 'room@1') return;
  const P = window.PIXI;
  const GW = window.GameWorld;
  const GPet = window.GamePet;
  const SKY = window.GameSky;
  const RP = window.RoomPlay;
  const Fx = window.PetFx;
  const IC = window.GameIcons;
  const $ = (id) => document.getElementById(id);
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rnd = Math.random;
  const M = boot.game.manifest;
  const SPRITES = boot.game.sprites || {};
  const BASE = boot.game.base;
  const DEFS = RP.defsOf(M);
  const ROOM = boot.room || {};
  const THEMES = M.themes || [];
  const OPEN = THEMES.filter((t) => t.status === 'open');
  const ICON = { sleep: '<path d="M2 18v-6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6"/><path d="M2 14h20"/><path d="M6 10V8a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2"/>', work: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>', music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>', game: '<rect x="2" y="7" width="20" height="10" rx="4"/><path d="M7 11v2M6 12h2M16 11h.01M18 13h.01"/>' };
  const svg = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ''}</svg>`;
  document.body.classList.add('engine-room');
  document.title = M.name;
  $('game-name').textContent = M.name;
  $('loading').textContent = '正在打开房间…';
  $('stage').setAttribute('aria-label', '房间画面：点家具让她去做那件事，点地板让她走过去，点她摸摸，按住拖动');

  // ---- state ---------------------------------------------------------------------------------------------
  const st = {
    scene: { followClock: false, dayFlow: true, hour: 12, weather: 'clear', autoWeather: false, ...(boot.scene || {}) },
    roam: boot.roam !== false,
    hour: 12, target: 12, ease: false, wx: { from: 'clear', to: 'clear', k: 1 }, autoLeft: SKY.autoDelay(rnd), saveLeft: 30,
    t: 0, frames: 0, fps: 0, card: null,
    view: boot.view,
    stats: ROOM.stats || { energy: 50, mood: 50, fullness: 50, focus: 50 },
    last: ROOM.last || null,
    quests: ROOM.quests || (boot.progress && boot.progress.quests) || [],
    theme: null, // the open theme on screen
    run: null, // { kind, fid, t0 (performance.now at its start, on this page), seconds, ticking }
    pending: null, // { kind, fid }: walking there to start it
    fx: [], dim: 1, dimTarget: 1, bob: null, pose: null, poseK: 0,
    hover: null, drag: null, flag: null,
    bubbleT: 0, nextLineT: 0, toastT: 0, lastLine: null,
    picker: { open: false, focus: 0 }, preview: null,
    events: [], errors: [], lastGrade: null, busy: false, cooldown: 0,
  };
  st.hour = st.target = st.scene.followClock ? SKY.clockHour() : st.scene.hour;
  st.wx = { from: st.scene.weather, to: st.scene.weather, k: 1 };
  window.addEventListener('error', (e) => { st.errors.push(String(e.message || e)); });
  window.addEventListener('unhandledrejection', (e) => { st.errors.push(String((e.reason && e.reason.message) || e.reason)); });

  // ---- Pixi ----------------------------------------------------------------------------------------------
  P.TextureSource.defaultOptions.scaleMode = 'nearest';
  const app = new P.Application();
  await app.init({ resizeTo: $('stage'), background: '#0b0f14', antialias: false, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true, preference: 'webgl', powerPreference: 'low-power' });
  $('stage').appendChild(app.canvas);
  async function loadTexture(url) {
    const blob = await fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status} ${url}`))));
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' });
    return P.Texture.from(bmp);
  }
  // a pixel halo (as the yard's): radial falloff in hard steps
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

  const view = new P.Container();
  const graded = new P.Container();
  const grade = new P.ColorMatrixFilter();
  graded.filters = [grade];
  const bg = new P.Sprite(P.Texture.EMPTY);
  const outside = new P.Container();
  const outsideG = new P.Graphics();
  const outsideGrade = new P.ColorMatrixFilter();
  outside.filters = [outsideGrade];
  outside.addChild(outsideG);
  const mullions = new P.Graphics();
  const back = new P.Container();
  const sorted = new P.Container();
  sorted.sortableChildren = true;
  const front = new P.Container();
  const props = new P.Container();
  graded.addChild(bg, outside, mullions, back, sorted, front, props);
  const lights = new P.Container();
  const particles = new P.Container();
  view.addChild(graded, lights, particles);
  app.stage.addChild(view);
  const fade = new P.Graphics();
  app.stage.addChild(fade);

  // ---- her: the pack's frames shrunk with a soft dark outline (as the yard's) --------------------------------
  const RES = 2;
  const USED = ['idle', 'walk', 'play', 'pat', 'look', 'lifted', 'sleep', 'happy', 'think', 'eat'];
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
  function shrink(src, sx, sy, sw, sh, h, pixelated) {
    const w = Math.max(1, Math.round((sw * h) / sh));
    const out = canvas(w + 4, h + 4);
    const o = out.getContext('2d');
    const sil = canvas(w, h);
    const sx2 = sil.getContext('2d');
    sx2.imageSmoothingEnabled = !pixelated;
    sx2.imageSmoothingQuality = 'high';
    sx2.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const body = canvas(w, h);
    body.getContext('2d').drawImage(sil, 0, 0);
    sx2.globalCompositeOperation = 'source-in';
    sx2.fillStyle = 'rgba(28,40,70,0.85)';
    sx2.fillRect(0, 0, w, h);
    for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) o.drawImage(sil, 2 + dx, 2 + dy);
    o.drawImage(body, 2, 2);
    return out;
  }
  const spriteCache = new Map(); // look url@height → sprite
  async function buildSprite(look, petH) {
    const key = `${look && look.url}@${petH}`;
    if (spriteCache.has(key)) return spriteCache.get(key);
    const sprite = { kind: 'placeholder', frames: {}, actions: {}, url: look && look.url, resolved: {} };
    try {
      if (!look || !look.url) throw new Error('no art');
      const blob = await fetch(look.url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))));
      const bmp = await createImageBitmap(blob);
      const H = petH * RES;
      const add = (name, canvases, fps) => { sprite.frames[name] = canvases.map((c) => { const t = P.Texture.from(c); t.source.scaleMode = look.pixelated ? 'nearest' : 'linear'; return t; }); sprite.actions[name] = { fps: fps || 2 }; };
      if (look.kind === 'sprites' && look.frame && look.actions) {
        const fw = look.frame.width;
        const fh = look.frame.height;
        const idle = look.actions.idle || Object.values(look.actions)[0];
        const ref = opaqueBox(bmp, idle.col * fw, idle.row * fh, fw, fh);
        const top = Math.max(0, ref.y - idle.row * fh - Math.round(ref.h * 0.12));
        const bottom = Math.min(fh, ref.y - idle.row * fh + ref.h + 6);
        const k = H / ref.h;
        const cut = (a, i) => shrink(bmp, (a.col + i) * fw, a.row * fh + top, fw, bottom - top, Math.round((bottom - top) * k), look.pixelated);
        for (const want of [...USED, 'sit']) {
          // her pack may not have every action: core/fx.js's fallback chain picks the nearest one she has
          const name = want === 'sit' ? 'idle' : Fx.resolveAction(ACTION_OF[want] || want, (n) => !!look.actions[n]).name;
          sprite.resolved[want] = name;
          const a = look.actions[name] || idle;
          add(want, Array.from({ length: a.frames || 1 }, (_, i) => cut(a, i)), a.fps);
        }
        sprite.kind = 'sprites';
      } else {
        const box = opaqueBox(bmp, 0, 0, bmp.width, bmp.height);
        const one = shrink(bmp, box.x, box.y, box.w, box.h, H, look.pixelated);
        for (const want of [...USED, 'sit']) { add(want, [one], 1); sprite.resolved[want] = 'picture'; }
        sprite.kind = 'paper';
      }
      if (bmp.close) bmp.close();
    } catch (e) {
      sprite.error = String(e && e.message);
    }
    spriteCache.set(key, sprite);
    return sprite;
  }
  // a room picker's avatar: the top of her idle frame (her head), from her pack's daily sheet
  const avatarCache = new Map();
  async function avatarOf(character) {
    if (avatarCache.has(character)) return avatarCache.get(character);
    const c = (ROOM.characters || {})[character];
    let url = null;
    try {
      const look = c && c.look;
      if (look && look.url) {
        const bmp = await createImageBitmap(await fetch(look.url).then((r) => r.blob()));
        let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
        if (look.kind === 'sprites' && look.frame && look.actions) {
          const a = look.actions.idle || Object.values(look.actions)[0];
          const b = opaqueBox(bmp, a.col * look.frame.width, a.row * look.frame.height, look.frame.width, look.frame.height);
          sx = b.x; sy = b.y; sw = b.w; sh = Math.min(b.h, b.w * 1.05);
        }
        const out = canvas(96, 96);
        const o = out.getContext('2d');
        o.imageSmoothingEnabled = !look.pixelated;
        const s = Math.min(96 / sw, 96 / sh);
        o.drawImage(bmp, sx, sy, sw, sh, (96 - sw * s) / 2, 96 - sh * s, sw * s, sh * s);
        url = out.toDataURL();
      }
    } catch { url = null; }
    avatarCache.set(character, url);
    return url;
  }

  // ---- a theme on screen ---------------------------------------------------------------------------------
  const themeCache = new Map(); // id → { bgTex, atlasTex, tex(name) }
  async function themeAssets(t) {
    if (themeCache.has(t.id)) return themeCache.get(t.id);
    const [bgTex, atlasTex] = await Promise.all([loadTexture(BASE + t.images.room), loadTexture(BASE + t.images.atlas)]);
    const index = SPRITES[t.sprites] || {};
    const cache = new Map();
    const tex = (name) => {
      if (!cache.has(name)) { const b = index[name]; cache.set(name, b ? new P.Texture({ source: atlasTex.source, frame: new P.Rectangle(b.x, b.y, b.w, b.h) }) : P.Texture.EMPTY); }
      return cache.get(name);
    };
    const out = { bgTex, atlasTex, tex, index };
    themeCache.set(t.id, out);
    return out;
  }

  let T = null; // { def, A (assets), world, pet, furn: Map(id → { def, sprite, kind, label, outline }), named: Map(sprite name → [Sprite]), petH, lights[] }
  const petSprite = new P.Sprite(P.Texture.EMPTY);
  petSprite.anchor.set(0.5, 1);
  const petFilter = new P.ColorMatrixFilter();
  petSprite.filters = [petFilter];
  let sprite = null;
  const flagG = new P.Graphics();
  const outlineC = new P.Container();
  const lampHalos = [];

  function kindAt(fid) { if (!T) return null; for (const k of RP.KINDS) if (T.def.activities[k] && T.def.activities[k].at === fid) return k; return null; }
  function actOf(kind) {
    const a = (T && T.def.activities[kind]) || {};
    return { ...a, anim: a.anim || DEFS[kind].anim, label: DEFS[kind].label };
  }

  async function enterTheme(t, { walkIn = true } = {}) {
    const A = await themeAssets(t);
    stopFx();
    for (const c of [back, sorted, front, props, lights, particles]) c.removeChildren();
    outlineC.removeChildren();
    lampHalos.length = 0;
    if (outside.mask) { const m = outside.mask; outside.mask = null; m.destroy(); }
    bg.texture = A.bgTex;
    bg.width = t.world.width;
    bg.height = t.world.height;
    app.renderer.background.color = t.world.background || '#BFD9F5';
    const blocked = [...((t.walk && t.walk.blocked) || [])];
    const world = GW.createWorld({ width: t.world.width, height: t.world.height, walk: { cell: t.walk.cell || 8, area: t.walk.area, blocked } });
    const furn = new Map();
    const named = new Map();
    const remember = (name, s) => { if (!named.has(name)) named.set(name, []); named.get(name).push(s); };
    const objects = [];
    for (const f of t.furniture) {
      const s = new P.Sprite(A.tex(f.sprite));
      s.anchor.set(0.5, 1);
      s.position.set(f.x, f.y);
      if (f.flat) back.addChild(s);
      else { s.zIndex = f.y; sorted.addChild(s); }
      remember(f.sprite, s);
      const kind = null;
      furn.set(f.id, { def: f, sprite: s, kind, name: f.label || '' });
    }
    for (const d of t.decor || []) {
      const s = new P.Sprite(A.tex(d.sprite));
      s.anchor.set(0.5, 1);
      s.position.set(d.x, d.y);
      s.zIndex = (d.z !== undefined ? d.z : d.y) + 0.5;
      sorted.addChild(s);
      remember(d.sprite, s);
    }
    T = { def: t, A, world, furn, named, petH: t.petHeight || 150 };
    for (const [fid, f] of furn) {
      f.kind = kindAt(fid);
      if (f.kind) {
        const a = actOf(f.kind);
        // the activity's furniture is a thing she walks to and uses; the round's end is room-play's, not hers
        // (phases: [] — never picked when she wanders by herself: the five are only ever yours to start)
        objects.push({ id: fid, use: { at: a.spot, face: a.face, anim: a.anim, seconds: [86400, 86400], phases: [] } });
      } else if (f.def.use) objects.push({ id: fid, use: { ...f.def.use, seconds: f.def.use.seconds || [8, 16] } });
    }
    for (const l of t.lights || []) {
      const g = new P.Sprite(HALO);
      g.anchor.set(0.5);
      g.blendMode = 'add';
      g.position.set(l.x, l.y);
      g.width = g.height = l.r * 2;
      g.tint = 0xffe2a8;
      g.alpha = 0;
      lights.addChild(g);
      lampHalos.push({ sprite: g, def: l });
    }
    const door = t.door || t.spawn;
    T.pet = GPet.createGamePet({ world, objects, rnd, start: walkIn ? door : t.spawn, speed: 120 });
    sorted.addChild(petSprite, flagG, outlineC);
    // the owner of the room wears what it asks for (theme.outfit): main resolved it (boot.room.looks)
    const owner = (ROOM.looks || {})[t.id];
    const look = owner || (st.view && st.view.look) || null;
    sprite = await buildSprite(look, T.petH);
    T.lookUrl = look && look.url;
    T.owner = !!owner;
    petSprite.visible = sprite.kind !== 'placeholder';
    st.theme = t.id;
    st.hover = null;
    $('room-name').textContent = t.name;
    buildLabels();
    fit();
    if (walkIn && t.spawn) T.pet.goTo(t.spawn[0], t.spawn[1], 'enter');
    renderStats();
  }

  // ---- fitting the room into the window ------------------------------------------------------------------
  function fit() {
    if (!T) return;
    const w = app.screen.width;
    const h = app.screen.height;
    const W = T.def.world.width;
    const H = T.def.world.height;
    const k = Math.min(w / W, h / H);
    view.scale.set(k);
    view.position.set(Math.round((w - W * k) / 2), Math.round((h - H * k) / 2));
  }
  app.renderer.on('resize', () => { fit(); buildLabels(); });
  const toScreen = (x, y) => [x * view.scale.x + view.position.x, y * view.scale.y + view.position.y];
  const toWorld = (sx, sy) => [(sx - view.position.x) / view.scale.x, (sy - view.position.y) / view.scale.y];

  // ---- talking -------------------------------------------------------------------------------------------
  const pickOf = (arr) => (arr && arr.length ? arr[Math.floor(rnd() * arr.length)] : null);
  const line = (kind, key) => pickOf(RP.lines(M, T && T.def, kind, key));
  function say(text, s = 3.6) {
    if (!text) return;
    const b = $('bubble');
    b.textContent = text;
    b.classList.remove('hidden');
    st.bubbleT = s;
    st.lastLine = text;
    st.events.push({ type: 'say', text, at: Date.now() });
  }
  function toast(text, s = 4) {
    const t = $('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    st.toastT = s;
    st.lastToast = text;
    st.events.push({ type: 'toast', text, at: Date.now() });
  }
  const ctxNow = () => ({ phase: SKY.phaseOf(st.hour), weather: st.wx.to });

  // ---- the room's DOM ------------------------------------------------------------------------------------
  const html = (s) => { const d = document.createElement('div'); d.innerHTML = s.trim(); return d.firstChild; };
  const roomBtn = html('<button id="room-btn" class="room-btn" title="换房间（R）" aria-haspopup="dialog" aria-expanded="false"><span id="room-name"></span><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>');
  $('game-name').after(roomBtn);
  document.body.appendChild(html(`<section id="room-stats" class="room-stats" aria-label="她的状态"><b id="stats-title"></b><ul id="stats-list"></ul><small id="stats-last" class="muted"></small></section>`));
  document.body.appendChild(html(`<section id="act-bar" class="act-bar hidden" aria-live="polite"><span id="act-ico" class="act-ico"></span><span class="act-body"><b id="act-name"></b><span class="act-time" id="act-time"></span><i class="act-track"><i id="act-fill"></i></i></span><button id="act-stop" class="act-stop">结束</button></section>`));
  document.body.appendChild(html('<div id="labels" class="labels" aria-hidden="true"></div>'));
  document.body.appendChild(html(`<section id="room-picker" class="card room-picker folded" role="dialog" aria-label="换房间"><div class="card-head"><b>换房间</b><small class="muted">每位角色一间</small><span class="spacer"></span><button id="picker-close" class="icon-btn" title="收起（Esc）" aria-label="收起"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div><div class="picker-row"><button id="picker-prev" class="step-btn" title="上一个" aria-label="上一个"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button><ul id="picker-list" class="picker-list"></ul><button id="picker-next" class="step-btn" title="下一个" aria-label="下一个"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button></div></section>`));
  document.body.appendChild(html(`<section id="room-preview" class="room-preview hidden" role="dialog" aria-label="即将开放"><canvas id="preview-bg" class="preview-bg" width="32" height="18" aria-hidden="true"></canvas><div class="preview-body"><img id="preview-avatar" class="preview-avatar" alt="" /><div class="preview-text"><small id="preview-owner" class="muted"></small><b id="preview-name"></b><p id="preview-blurb"></p><div id="preview-motifs" class="preview-motifs"></div><strong class="preview-soon">即将开放</strong><button id="preview-back" class="preview-back"></button></div></div></section>`));
  const tbRoom = html('<button id="tb-room" class="tool" title="换房间（R）" aria-label="换房间" aria-pressed="false"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg></button>');
  $('tb-quests').after(tbRoom);
  for (const id of ['tb-follow', 'tb-zoom-in', 'tb-zoom-out']) if ($(id)) $(id).classList.add('hidden');

  // the four bars: 精力 and 饱腹 in the room's accent colour, 心情 pink, 专注 its primary (§4.4)
  const BAR_COLOR = () => { const p = (T && T.def.palette) || {}; return { energy: p.accent || '#6FA8E8', mood: '#F08FB0', focus: p.primary || '#2C4A8A', fullness: p.accent || '#6FA8E8' }; };
  function renderStats(changed = null) {
    const name = (st.view && st.view.name) || ((ROOM.characters || {})[st.view && st.view.pet && st.view.pet.speciesId] || {}).name || '她';
    $('stats-title').textContent = `${name}的状态`;
    const ul = $('stats-list');
    const col = BAR_COLOR();
    const prevw = st.run ? RP.preview(st.run.kind, DEFS, Math.max(RP.MIN_FRACTION, runProgress())) : {};
    if (!ul.children.length) for (const s of RP.STATS) {
      const li = document.createElement('li');
      li.dataset.stat = s;
      li.innerHTML = '<span class="s-label"></span><span class="s-track"><i class="s-fill"></i><i class="s-preview"></i></span><span class="s-val"></span><em class="s-delta"></em>';
      li.querySelector('.s-label').textContent = RP.STAT_LABEL[s];
      ul.appendChild(li);
    }
    for (const li of ul.children) {
      const s = li.dataset.stat;
      const v = Math.max(0, Math.min(100, Math.round(st.stats[s] ?? 50)));
      const fill = li.querySelector('.s-fill');
      fill.style.width = `${v}%`;
      fill.style.background = col[s];
      const pv = li.querySelector('.s-preview');
      const d = prevw[s] || 0;
      const to = Math.max(0, Math.min(100, v + d));
      pv.style.left = `${Math.min(v, to)}%`;
      pv.style.width = `${Math.abs(to - v)}%`;
      pv.className = `s-preview${d > 0 ? ' up' : d < 0 ? ' down' : ''}`;
      li.querySelector('.s-val').textContent = String(v);
      li.title = d ? `这一轮会 ${d > 0 ? '+' : '−'}${Math.abs(d)}` : '';
      li.dataset.value = String(v);
      li.dataset.preview = String(d);
      if (changed && changed[s]) {
        const em = li.querySelector('.s-delta');
        em.textContent = `${changed[s] > 0 ? '+' : '−'}${Math.abs(changed[s])}`;
        em.className = `s-delta show ${changed[s] > 0 ? 'up' : 'down'}`;
        clearTimeout(em._t);
        em._t = setTimeout(() => { em.className = 's-delta'; }, 1800);
      }
    }
    const l = st.last;
    $('stats-last').textContent = l && DEFS[l.kind] ? `上一件：${DEFS[l.kind].label}（${l.complete ? '做完了' : `做了 ${Math.round(l.fraction * 100)}%`}）` : '点家具，让她做点事吧';
  }

  // furniture labels: the activity's name on the furniture's top edge; 睡觉中 + a thin progress bar meanwhile
  function buildLabels() {
    const box = $('labels');
    box.textContent = '';
    if (!T) return;
    for (const [fid, f] of T.furn) {
      if (!f.kind) continue;
      const el = document.createElement('span');
      el.className = 'flabel';
      el.dataset.roomLabel = fid;
      el.innerHTML = `${svg(f.kind)}<b></b><i class="fl-track"><i></i></i>`;
      box.appendChild(el);
      f.labelEl = el;
    }
    placeLabels();
  }
  function placeLabels() {
    if (!T) return;
    for (const [, f] of T.furn) {
      if (!f.labelEl) continue;
      const s = f.sprite;
      const [x, y] = toScreen(s.x, s.y - s.height);
      f.labelEl.style.left = `${Math.round(x)}px`;
      f.labelEl.style.top = `${Math.round(y) - 6}px`;
      const running = st.run && st.run.fid === f.def.id;
      f.labelEl.querySelector('b').textContent = running ? `${DEFS[f.kind].label}中` : DEFS[f.kind].label;
      f.labelEl.classList.toggle('running', !!running);
      f.labelEl.classList.toggle('tired', !running && !!tiredFor(f.kind));
      f.labelEl.querySelector('.fl-track i').style.width = running ? `${Math.round(runProgress() * 100)}%` : '0';
    }
  }

  // ---- activities ------------------------------------------------------------------------------------------
  const tiredFor = (kind) => { const n = DEFS[kind].needs.energy; return n && Math.round(st.stats.energy) < n && !(st.run && st.run.kind === kind) ? { need: n, have: Math.round(st.stats.energy) } : null; };
  function runProgress() { if (!st.run) return 0; return Math.min(1, (performance.now() - st.run.t0) / 1000 / st.run.seconds); }
  function fmt(s) { s = Math.max(0, Math.round(s)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }

  async function ask(cmd) {
    let r = null;
    try { r = await window.game.activity(cmd); } catch (e) { r = { ok: false, reason: String(e && e.message) }; }
    if (r && r.stats) st.stats = r.stats;
    if (r && r.quests) st.quests = r.quests;
    if (r && 'last' in r) st.last = r.last;
    st.events.push({ type: `activity:${cmd.cmd}`, kind: cmd.kind || null, ok: !!(r && r.ok), reason: r && r.reason, settled: r && r.settled ? { kind: r.settled.kind, complete: r.settled.complete, fraction: r.settled.fraction, changed: r.settled.changed } : null, at: Date.now() });
    if (st.events.length > 120) st.events.splice(0, st.events.length - 120);
    return r;
  }
  // a settlement came back from main: the numbers move, the toast says what happened, finished 小事 too
  function booked(s) {
    if (!s) return;
    renderStats(s.changed);
    toast(s.summary || RP.summary(s, DEFS, s.changed));
    for (const q of s.completed || []) {
      const gain = q.affection && q.affection.delta > 0 ? ` · 好感 +${q.affection.delta}` : '';
      setTimeout(() => toast(`完成：${q.title}${gain}`), 1500);
    }
    renderQuests();
  }

  // she arrived at the furniture: ask main to start the round; the props and the timer begin when it says yes
  async function beginRun(kind, fid) {
    const r = await ask({ cmd: 'start', kind, theme: st.theme, ctx: ctxNow() });
    if (!r || !r.ok) {
      T.pet.stopUse();
      st.pending = null;
      if (r && r.reason === 'tired') { toast(`太累了（精力 ${r.have}，要 ${r.need}）· 先让她睡一觉`); say(line(null, 'tired')); }
      renderStats();
      return;
    }
    if (r.settled) booked(r.settled);
    const v = r.run || { progress: 0, seconds: DEFS[kind].seconds };
    st.run = { kind, fid, seconds: v.seconds, t0: performance.now() - (v.elapsed || 0) * 1000, ticking: false };
    st.pending = null;
    startFx(kind);
    say(line(kind, 'doing'));
    st.nextLineT = 6;
    showActBar();
    renderStats();
  }
  // the round is over (main settled it): the props fold, she stands up, says her line
  function endRun(settled, { quiet = false } = {}) {
    const kind = st.run && st.run.kind;
    stopFx();
    st.run = null;
    if (T && T.pet.state().mode === 'use') T.pet.stopUse();
    showActBar();
    st.cooldown = 0.8;
    if (settled) {
      booked(settled);
      if (!quiet && settled.complete) say(line(kind, 'done'));
    }
    renderStats();
  }
  async function stopRun() {
    if (!st.run) return null;
    const r = await ask({ cmd: 'stop', ctx: ctxNow() });
    endRun(r && r.settled);
    return r;
  }
  async function tickRun() {
    if (!st.run || st.run.ticking) return;
    st.run.ticking = true;
    const r = await ask({ cmd: 'tick', ctx: ctxNow() });
    if (r && r.settled) endRun(r.settled);
    else if (st.run) { st.run.ticking = false; if (r && r.run) st.run.t0 = performance.now() - r.run.elapsed * 1000; }
  }
  function showActBar() {
    const bar = $('act-bar');
    bar.classList.toggle('hidden', !st.run);
    if (!st.run) return;
    $('act-ico').innerHTML = svg(st.run.kind);
    $('act-name').textContent = `正在${DEFS[st.run.kind].label}`;
    bar.dataset.kind = st.run.kind;
  }
  function stepRun(dt) {
    if (!st.run) return;
    const p = runProgress();
    $('act-time').textContent = `${fmt(p * st.run.seconds)} / ${fmt(st.run.seconds)}`;
    $('act-fill').style.width = `${(p * 100).toFixed(1)}%`;
    st.nextLineT -= dt;
    if (st.nextLineT <= 0 && p < 1) { st.nextLineT = 6; say(line(st.run.kind, 'doing')); }
    if (p >= 1) tickRun();
    st.seenT = (st.seenT || 0) + dt;
    if (st.seenT > 5) { st.seenT = 0; ask({ cmd: 'seen' }); }
  }

  // ---- props (the fx words of core/room-pack.js) -------------------------------------------------------------
  const colorOf = (c) => { const p = (T && T.def.palette) || {}; const v = p[c] || c || '#2C4A8A'; return parseInt(String(v).replace('#', ''), 16); };
  const FX = {
    dim(p) { st.dimTarget = p.to; if (reduced) st.dim = p.to; return { info: () => ({ to: p.to, now: st.dim }), destroy() { st.dimTarget = 1; if (reduced) st.dim = 1; } }; },
    layer(p) {
      const s = new P.Sprite(T.A.tex(p.sprite));
      s.anchor.set(0.5, 1);
      s.position.set(p.x, p.y);
      front.addChildAt(s, 0);
      return { sprite: s, info: () => ({ sprite: p.sprite, rect: [s.x - s.width / 2, s.y - s.height, s.width, s.height] }), destroy() { s.destroy(); } };
    },
    swap(p) {
      const list = T.named.get(p.sprite) || [];
      for (const s of list) s.texture = T.A.tex(p.to);
      return { info: () => ({ sprite: p.sprite, to: p.to, swapped: list.length }), destroy() { for (const s of list) if (!s.destroyed) s.texture = T.A.tex(p.sprite); } };
    },
    hide(p) {
      const list = T.named.get(p.sprite) || [];
      for (const s of list) s.visible = false;
      return { info: () => ({ sprite: p.sprite, hidden: list.filter((s) => !s.visible).length }), destroy() { for (const s of list) if (!s.destroyed) s.visible = true; } };
    },
    hold(p) {
      const s = new P.Sprite(T.A.tex(p.sprite));
      s.anchor.set(0.5);
      props.addChild(s);
      const place = () => {
        const b = petBox();
        const ps = T.pet.state();
        const u = ps.facing < 0 ? 1 - p.hand[0] : p.hand[0];
        s.position.set(b[0] + b[2] * u, b[1] + b[3] * p.hand[1]);
        s.scale.x = ps.facing < 0 ? -1 : 1;
      };
      return { update: place, info: () => { const b = petBox(); return { sprite: p.sprite, at: [s.x, s.y], inHand: s.x >= b[0] && s.x <= b[0] + b[2] && s.y >= b[1] && s.y <= b[1] + b[3] }; }, destroy() { s.destroy(); } };
    },
    spin(p) {
      const c = new P.Container();
      c.position.set(p.x, p.y);
      c.scale.y = p.squash;
      const s = new P.Sprite(T.A.tex(p.sprite));
      s.anchor.set(0.5);
      c.addChild(s);
      props.addChild(c);
      return { update(dt) { if (!reduced) s.rotation += dt * (p.rpm / 60) * Math.PI * 2; }, info: () => ({ sprite: p.sprite, angle: s.rotation }), destroy() { c.destroy({ children: true }); } };
    },
    frames(p) {
      const s = new P.Sprite(T.A.tex(p.sprites[0]));
      s.position.set(p.rect[0], p.rect[1]);
      s.width = p.rect[2];
      s.height = p.rect[3];
      props.addChild(s);
      let t = 0;
      let frame = 0;
      return { update(dt) { if (reduced) return; t += dt; const f = Math.floor(t * p.fps) % p.sprites.length; if (f !== frame) { frame = f; s.texture = T.A.tex(p.sprites[f]); s.width = p.rect[2]; s.height = p.rect[3]; } }, info: () => ({ frame, frames: p.sprites.length, t }), destroy() { s.destroy(); } };
    },
    'screen-type'(p) {
      const [x, y, w, h] = p.rect;
      const c = new P.Container();
      if (p.sprite) { const b = new P.Sprite(T.A.tex(p.sprite)); b.position.set(x, y); b.width = w; b.height = h; c.addChild(b); }
      const g = new P.Graphics();
      c.addChild(g);
      props.addChild(c);
      const col = colorOf(p.color || 'primary');
      let rows = 0;
      let t = 0;
      const pad = Math.max(2, Math.round(h / (p.rows * 3)));
      const rh = Math.max(2, Math.floor((h - pad * 2) / p.rows) - 2);
      const left = x + Math.round(w * 0.22);
      const full = w - (left - x) - pad;
      return {
        update(dt, progress) {
          t += dt;
          g.clear();
          const done = progress * p.rows;
          rows = Math.min(p.rows, Math.floor(done));
          for (let i = 0; i < Math.min(p.rows, Math.ceil(done)); i++) {
            const k = i < rows ? 1 : done - rows;
            const len = Math.max(2, Math.round(full * (0.55 + ((i * 37) % 40) / 100) * k));
            g.rect(left, y + pad + i * (rh + 2), len, rh).fill({ color: col });
            if (i === rows && (reduced || Math.sin(t * 9) > 0)) g.rect(left + len + 1, y + pad + i * (rh + 2), 2, rh).fill({ color: 0xffffff });
          }
        },
        info: () => ({ rows, of: p.rows }),
        destroy() { c.destroy({ children: true }); },
      };
    },
    emit(p) {
      let left = 0.2;
      const live = [];
      return {
        update(dt) {
          if (reduced) return;
          left -= dt;
          if (left <= 0) {
            left = p.every;
            const s = new P.Sprite(T.A.tex(p.sprites[Math.floor(rnd() * p.sprites.length)]));
            s.anchor.set(0.5);
            let from = p.from;
            if (from === 'head') { const b = petBox(); from = [b[0] + b[2] * 0.7, b[1] + 6]; }
            s.position.set(from[0] + (rnd() - 0.5) * 16, from[1]);
            s.scale.set(1.5);
            particles.addChild(s);
            live.push({ s, t: 0, x0: s.x, ph: rnd() * 6 });
          }
          for (let i = live.length - 1; i >= 0; i--) {
            const q = live[i];
            q.t += dt;
            const life = 2.4;
            q.s.y -= ((p.rise || 60) / life) * dt;
            q.s.x = q.x0 + Math.sin(q.t * 2.2 + q.ph) * 6;
            q.s.alpha = q.t < 0.3 ? q.t / 0.3 : Math.max(0, 1 - (q.t - 0.3) / (life - 0.3));
            if (q.t > life) { q.s.destroy(); live.splice(i, 1); }
          }
        },
        info: () => ({ live: live.length }),
        destroy() { for (const q of live) q.s.destroy(); live.length = 0; },
      };
    },
    bob(p) { st.bob = { period: p.period, amp: p.amp }; return { info: () => ({ amp: p.amp }), destroy() { st.bob = null; } }; },
    glow(p) {
      const g = new P.Sprite(HALO);
      g.anchor.set(0.5);
      g.blendMode = 'add';
      g.tint = 0xfff0c0;
      g.position.set(p.x, p.y);
      g.width = g.height = p.r * 2;
      g.alpha = 0;
      lights.addChild(g);
      return { update(dt) { g.alpha = Math.min(0.75, g.alpha + dt * 2); }, info: () => ({ alpha: g.alpha }), destroy() { g.destroy(); } };
    },
  };
  function startFx(kind) {
    stopFx();
    const a = actOf(kind);
    for (const p of a.props || []) {
      try { const f = FX[p.fx](p); st.fx.push({ fx: p.fx, def: p, ...f }); } catch (e) { st.errors.push(`fx ${p.fx}: ${e.message}`); }
    }
    if (a.pose === 'tucked' && sprite && sprite.kind === 'sprites') {
      st.pose = 'tucked';
      st.poseK = 0;
      // she lies under the quilt: under it and under the bed's front
      const quilt = st.fx.find((f) => f.fx === 'layer');
      front.addChildAt(petSprite, 0);
      const f = T.furn.get(a.at);
      if (f && f.def.front) {
        const s = new P.Sprite(T.A.tex(f.def.front));
        s.anchor.set(0.5, 1);
        s.position.set(f.def.x, f.def.y);
        front.addChild(s);
        st.fx.push({ fx: 'front', info: () => ({ sprite: f.def.front }), destroy() { s.destroy(); } });
      }
      void quilt;
    }
  }
  function stopFx() {
    for (const f of st.fx) { try { f.destroy(); } catch { /* gone */ } }
    st.fx = [];
    st.dimTarget = 1;
    st.bob = null;
    if (st.pose) { st.pose = null; if (petSprite.parent !== sorted) sorted.addChild(petSprite); petSprite.rotation = 0; }
  }

  // ---- input -----------------------------------------------------------------------------------------------
  app.stage.eventMode = 'static';
  app.stage.hitArea = app.screen;
  function petBox() {
    const s = T.pet.state();
    const h = T.petH;
    const w = sprite && sprite.frames.idle ? (sprite.frames.idle[0].width / RES) : h * 0.6;
    return [s.x - w / 2, s.y - h, w, h];
  }
  const inBox = (b, x, y) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
  function furnitureAt(x, y) {
    let best = null;
    for (const f of T.furn.values()) {
      if (!f.kind && !f.def.use) continue;
      if (f.def.hit ? GW.inPoly(f.def.hit, x, y) : (() => { const s = f.sprite; return inBox([s.x - s.width / 2, s.y - s.height, s.width, s.height], x, y); })()) {
        if (!best || (f.def.flat ? -1 : f.def.y) > (best.def.flat ? -1 : best.def.y)) best = f;
      }
    }
    return best;
  }
  function targetAt(sx, sy) {
    if (!T || st.preview) return { kind: 'none' };
    const [x, y] = toWorld(sx, sy);
    if (petSprite.visible && !st.pose && inBox(petBox(), x, y)) return { kind: 'pet' };
    const f = furnitureAt(x, y);
    if (f) return { kind: 'furn', f };
    if (GW.walkableAt(T.world, x, y)) return { kind: 'floor', x, y };
    return { kind: 'none', x, y };
  }
  async function clickFurniture(f) {
    if (st.busy) return 'busy';
    const kind = f.kind;
    if (!kind) {
      // a thing that is not one of the five (the bean bag): she goes and sits a while; a round running ends first
      if (st.run) await stopRun();
      const r = T.pet.use(f.def.id, 'click');
      if (r.ok) st.flag = { x: f.def.use.at[0], y: f.def.use.at[1], t: 0 };
      return 'use';
    }
    if (st.run && st.run.kind === kind) { await stopRun(); return 'stopped'; }
    const tired = tiredFor(kind);
    if (tired) { toast(`太累了（精力 ${tired.have}，要 ${tired.need}）· 先让她睡一觉`); say(line(null, 'tired')); st.events.push({ type: 'refused', kind, at: Date.now() }); return 'tired'; }
    st.busy = true;
    try {
      if (st.run) await stopRun();
      const r = T.pet.use(f.def.id, 'click');
      if (r.ok) {
        st.pending = { kind, fid: f.def.id };
        const a = actOf(kind);
        st.flag = { x: a.spot[0], y: a.spot[1], t: 0 };
      }
    } finally { st.busy = false; }
    return 'walk';
  }
  async function clickAt(sx, sy) {
    const t = targetAt(sx, sy);
    if (t.kind === 'pet') {
      if (T.pet.touch().ok) {
        say(line(null, 'touch'));
        window.game.touch().then((r) => { if (r && r.line) say(r.line); }).catch(() => {});
        window.game.event({ type: 'touch' }, ctxNow()).then((r) => { if (r && r.ok) { st.quests = r.quests || st.quests; for (const q of r.completed || []) toast(`完成：${q.title}${q.affection && q.affection.delta > 0 ? ` · 好感 +${q.affection.delta}` : ''}`); renderQuests(); } }).catch(() => {});
        st.events.push({ type: 'touch', at: Date.now() });
      }
    } else if (t.kind === 'furn') {
      return clickFurniture(t.f);
    } else if (t.kind === 'floor') {
      // a click on the floor: whatever she is doing ends (settled by how long it ran), then she walks there
      if (st.run) await stopRun();
      st.pending = null;
      const r = T.pet.goTo(t.x, t.y, 'click');
      if (r.ok && r.target) st.flag = { x: r.target[0], y: r.target[1], t: 0 };
    }
    return t.kind;
  }
  app.stage.on('pointerdown', (e) => {
    if (e.button === 2 || !T) return;
    const t = targetAt(e.global.x, e.global.y);
    st.drag = { x: e.global.x, y: e.global.y, pet: t.kind === 'pet', lifted: false };
  });
  app.stage.on('globalpointermove', (e) => {
    const d = st.drag;
    if (d) {
      if (d.pet && !d.lifted && Math.hypot(e.global.x - d.x, e.global.y - d.y) > 6) {
        const r = T.pet.lift();
        d.lifted = r.ok;
        if (r.ok) {
          st.pending = null;
          say(line(null, 'touch'));
          // lifting her ends what she was doing
          if (st.run) stopRun();
        }
      }
      if (d.lifted) { const [x, y] = toWorld(e.global.x, e.global.y); T.pet.moveLifted(x, y + T.petH * 0.6); }
      return;
    }
    hoverAt(e.global.x, e.global.y);
  });
  const endDrag = (e) => {
    const d = st.drag;
    st.drag = null;
    if (!d || !T) return;
    if (d.lifted) { const [x, y] = toWorld(e.global.x, e.global.y); T.pet.drop(x, y + T.petH * 0.6); st.events.push({ type: 'drop', at: Date.now() }); return; }
    clickAt(e.global.x, e.global.y);
  };
  app.stage.on('pointerup', endDrag);
  app.stage.on('pointerupoutside', endDrag);
  app.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  function tipFor(t) {
    if (t.kind === 'pet') return '摸摸 · 按住拖动';
    if (t.kind !== 'furn') return '';
    const f = t.f;
    if (!f.kind) return `${(f.def.use && f.def.use.label) || '去看看'}${f.name ? ` · ${f.name}` : ''}`;
    const d = DEFS[f.kind];
    if (st.run && st.run.kind === f.kind) return `${d.label}中 · 再点一次结束`;
    const tired = tiredFor(f.kind);
    if (tired) return `太累了（精力 ${tired.have}，要 ${tired.need}）· 先让她睡一觉`;
    return `${d.label} · ${f.name}`;
  }
  function hoverAt(sx, sy) {
    const t = targetAt(sx, sy);
    st.hover = t.kind === 'furn' ? t.f : null;
    const tip = $('tip');
    const label = tipFor(t);
    const tired = t.kind === 'furn' && t.f.kind && tiredFor(t.f.kind);
    $('stage').classList.toggle('can-click', !!label && !tired);
    $('stage').classList.toggle('not-allowed', !!tired);
    if (label) { tip.textContent = label; tip.style.left = `${sx}px`; tip.style.top = `${sy}px`; tip.classList.remove('hidden'); } else tip.classList.add('hidden');
    st.tipText = label;
    drawOutline();
  }
  app.canvas.addEventListener('pointerleave', () => { $('tip').classList.add('hidden'); st.hover = null; drawOutline(); });

  // the hovered piece's outline: its silhouette drawn behind it, 2 px in the room's base colour and 1 px more in
  // its primary — grey when she is too tired for it (§4.4)
  const silFilter = (hex) => { const f = new P.ColorMatrixFilter(); const r = ((hex >> 16) & 255) / 255; const g = ((hex >> 8) & 255) / 255; const b = (hex & 255) / 255; f.matrix = [0, 0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, 1, 0]; return f; };
  function drawOutline() {
    outlineC.removeChildren().forEach((c) => c.destroy());
    const f = st.hover;
    st.outline = null;
    if (!f || !T) return;
    const tired = f.kind && tiredFor(f.kind);
    const pal = T.def.palette || {};
    const rings = tired ? [[3, 0x6b7280], [2, 0xc7ccd3]] : [[3, colorOf('primary')], [2, parseInt(String(pal.base || '#FFFFFF').slice(1), 16)]];
    for (const [d, col] of rings) {
      const filt = silFilter(col);
      for (const [dx, dy] of [[-d, 0], [d, 0], [0, -d], [0, d], [-d, -d], [d, -d], [-d, d], [d, d]]) {
        const s = new P.Sprite(f.sprite.texture);
        s.anchor.set(0.5, 1);
        s.position.set(f.sprite.x + dx, f.sprite.y + dy);
        s.filters = [filt];
        outlineC.addChild(s);
      }
    }
    if (f.def.flat) { back.addChildAt(outlineC, Math.max(0, back.getChildIndex(f.sprite))); } else { if (outlineC.parent !== sorted) sorted.addChild(outlineC); outlineC.zIndex = f.def.y - 0.01; }
    st.outline = { id: f.def.id, tone: tired ? 'tired' : 'ok', sprites: outlineC.children.length };
  }

  // ---- the room picker and the 即将开放 preview --------------------------------------------------------------
  async function renderPicker() {
    const ul = $('picker-list');
    ul.textContent = '';
    THEMES.forEach((t, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<button class="pick" data-theme="${t.id}" data-status="${t.status}"><img class="pick-av" alt="" /><b class="pick-name"></b><span class="swatches">${['primary', 'accent', 'base', 'trim'].map((k) => `<i style="background:${(t.palette || {})[k]}"></i>`).join('')}</span><em class="pick-tag ${t.status}">${t.status === 'open' ? '可以玩' : '即将开放'}</em></button>`;
      const b = li.querySelector('button');
      b.querySelector('.pick-name').textContent = t.name;
      b.title = `${((ROOM.characters || {})[t.character] || {}).name || t.character}的房间 · ${t.blurb || ''}`;
      b.classList.toggle('current', t.id === st.theme);
      b.classList.toggle('focus', i === st.picker.focus);
      b.setAttribute('aria-current', String(t.id === st.theme));
      b.addEventListener('click', () => pickTheme(t.id));
      ul.appendChild(li);
      avatarOf(t.character).then((u) => { if (u) b.querySelector('.pick-av').src = u; });
    });
  }
  function openPicker(open = !st.picker.open) {
    st.picker.open = open;
    if (open) { st.picker.focus = Math.max(0, THEMES.findIndex((t) => t.id === st.theme)); showCard(null); renderPicker(); }
    $('room-picker').classList.toggle('folded', !open);
    roomBtn.setAttribute('aria-expanded', String(open));
    tbRoom.setAttribute('aria-pressed', String(open));
  }
  function movePicker(d) { st.picker.focus = (st.picker.focus + d + THEMES.length) % THEMES.length; renderPicker(); }
  async function pickTheme(id) {
    const t = THEMES.find((x) => x.id === id);
    if (!t) return { ok: false };
    st.events.push({ type: 'pick', theme: id, at: Date.now() });
    if (t.status !== 'open') { openPicker(false); showPreview(t); return { ok: true, preview: true }; }
    closePreview();
    openPicker(false);
    if (t.id === st.theme) return { ok: true, same: true };
    // another room: the round here is settled first, the screen fades, the new room comes in
    const r = await ask({ cmd: 'theme', theme: t.id, ctx: ctxNow() });
    if (st.run) endRun(r && r.settled, { quiet: true });
    else if (r && r.settled) booked(r.settled);
    st.fading = 1;
    await enterTheme(t);
    window.game.saveState({ theme: t.id });
    say(line(null, 'enter'));
    return { ok: true };
  }
  function showPreview(t) {
    const owner = (ROOM.characters || {})[t.character] || {};
    st.preview = t.id;
    $('preview-owner').textContent = `${owner.name || t.character}的房间`;
    $('preview-name').textContent = t.name;
    $('preview-blurb').textContent = t.blurb || '';
    const box = $('preview-motifs');
    box.textContent = '';
    const pal = t.palette || {};
    (t.motifs || []).forEach((m, i) => { const s = document.createElement('span'); s.className = 'motif'; s.innerHTML = '<i></i>'; s.querySelector('i').style.background = pal[['accent', 'primary', 'trim'][i % 3]]; s.append(m); box.appendChild(s); });
    const here = THEMES.find((x) => x.id === st.theme);
    $('preview-back').textContent = `回到 ${here ? here.name : '房间'}`;
    // the background: the preview picture when the pack has one, else the palette as a pixel grid
    const c = $('preview-bg');
    const x = c.getContext('2d');
    const cols = [pal.base, pal.accent, pal.trim, pal.primary].filter(Boolean);
    for (let j = 0; j < c.height; j++) for (let i = 0; i < c.width; i++) { const k = Math.min(cols.length - 1, Math.floor(((j / c.height) * 0.75 + ((i * 7 + j * 3) % 5) / 20) * cols.length)); x.fillStyle = cols[k]; x.fillRect(i, j, 1, 1); }
    c.style.backgroundImage = t.preview ? `url(${BASE}${t.preview})` : '';
    $('preview-avatar').removeAttribute('src');
    avatarOf(t.character).then((u) => { if (u && st.preview === t.id) $('preview-avatar').src = u; });
    $('room-preview').classList.remove('hidden');
    $('room-preview').dataset.theme = t.id;
    $('room-preview').style.setProperty('--pv-primary', pal.primary || '#333');
    $('room-preview').style.setProperty('--pv-accent', pal.accent || '#999');
  }
  function closePreview() { st.preview = null; $('room-preview').classList.add('hidden'); }
  $('preview-back').addEventListener('click', () => { closePreview(); openPicker(false); });
  roomBtn.addEventListener('click', () => openPicker());
  tbRoom.addEventListener('click', () => openPicker());
  $('picker-close').addEventListener('click', () => openPicker(false));
  $('picker-prev').addEventListener('click', () => movePicker(-1));
  $('picker-next').addEventListener('click', () => movePicker(1));
  $('act-stop').addEventListener('click', () => stopRun());

  // ---- the 天色 / 今日小事 cards and the toolbar (the game window's) -------------------------------------------
  function setScene(patch) { Object.assign(st.scene, patch); window.game.set(patch).catch(() => {}); renderCard(); }
  function setHour(h, { ease = true } = {}) { st.target = SKY.wrapHour(h); st.ease = ease; if (!ease) st.hour = st.target; setScene({ hour: Math.round(st.target * 4) / 4 % 24, followClock: false }); }
  function setWeather(id, manual) {
    if (id === st.wx.to) return;
    st.wx = { from: st.wx.k >= 0.5 ? st.wx.to : st.wx.from, to: id, k: 0 };
    setScene(manual ? { weather: id, autoWeather: false } : { weather: id });
    st.autoLeft = SKY.autoDelay(rnd);
    const sky = T && T.def.lines && T.def.lines.sky;
    if (sky && sky[id] && !st.run) setTimeout(() => { if (st.wx.to === id && !st.run) say(sky[id]); }, 1800);
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
    if (which && st.picker.open) openPicker(false);
  }
  $('tb-sky').addEventListener('click', () => showCard(st.card === 'sky' ? null : 'sky'));
  $('tb-quests').addEventListener('click', () => showCard(st.card === 'quests' ? null : 'quests'));
  $('sky-close').addEventListener('click', () => showCard(null));
  $('quest-close').addEventListener('click', () => showCard(null));
  $('btn-close').addEventListener('click', () => window.game.close('button'));
  function showUpdate(u) { const chip = $('update-chip'); st.update = u || null; chip.classList.toggle('hidden', !u); if (u) chip.textContent = `有新版本 v${u.to} · 去更新`; }
  $('update-chip').addEventListener('click', () => window.game.openStore());
  if (window.game.onUpdate) window.game.onUpdate(showUpdate);
  showUpdate(boot.update);
  $('game-version').textContent = boot.game.version ? `v${boot.game.version}` : '';
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && ((e.code === 'KeyW' && !e.shiftKey) || (e.code === 'KeyH' && e.shiftKey))) { e.preventDefault(); window.game.close('key'); return; }
    if (e.key === 'Escape') { if (st.preview) closePreview(); else if (st.picker.open) openPicker(false); else showCard(st.card ? null : 'sky'); return; }
    if (st.picker.open && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { movePicker(e.key === 'ArrowLeft' ? -1 : 1); return; }
    if (st.picker.open && e.key === 'Enter') { e.preventDefault(); pickTheme(THEMES[st.picker.focus].id); return; }
    if ((e.key === 'r' || e.key === 'R') && !mod) openPicker();
  });
  function renderCard() {
    const g = st.lastGrade || SKY.grade(st.hour, SKY.mixWeather(st.wx.from, st.wx.to, st.wx.k));
    $('time-name').textContent = SKY.phaseName(g.phase);
    $('time-clock').textContent = st.scene.followClock ? `${SKY.formatHour(st.hour)} · 本机时间` : SKY.formatHour(st.hour);
    if (!st.sliding) $('time-slider').value = String(Math.round(st.hour * 4) / 4 % 24);
    $('weather-name').textContent = SKY.weatherOf(st.wx.to).name;
    $('weather-sub').textContent = st.scene.autoWeather ? '会自己变' : ' ';
    $('day-flow').setAttribute('aria-checked', String(!!st.scene.dayFlow && !st.scene.followClock));
    $('auto-weather').setAttribute('aria-checked', String(!!st.scene.autoWeather));
    $('tb-clock').setAttribute('aria-pressed', String(!!st.scene.followClock));
    $('sky-hint').textContent = st.scene.followClock ? '跟着这台电脑的时间。' : st.scene.dayFlow ? `和像素小院共用天色，一天是 ${SKY.DAY_MINUTES} 分钟。` : '时间停在这里，拖动滑块或点 ‹ › 换时段。';
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
    $('items').textContent = '每天三件小事，完成会加好感（每天最多三次）。';
  }

  // ---- per frame -----------------------------------------------------------------------------------------------
  function stepTime(dt) {
    const s = st.scene;
    if (s.followClock) { st.target = SKY.clockHour(); st.ease = true; }
    else if (s.dayFlow && !st.sliding) { st.target = SKY.wrapHour(st.target + SKY.flowHours(dt)); if (!st.ease) st.hour = st.target; }
    if (st.ease) {
      const d = SKY.hourDelta(st.hour, st.target);
      if (Math.abs(d) < 0.01) { st.hour = st.target; st.ease = false; } else st.hour = SKY.wrapHour(st.hour + d * Math.min(1, dt * 3.2) + Math.sign(d) * Math.min(Math.abs(d), dt * 0.3));
    }
    if (s.dayFlow && !s.followClock) { st.saveLeft -= dt; if (st.saveLeft <= 0) { st.saveLeft = 30; const h = Math.round(st.hour * 4) / 4 % 24; window.game.set({ hour: h }).catch(() => {}); st.scene.hour = h; } }
    if (st.wx.k < 1) st.wx.k = Math.min(1, st.wx.k + dt / SKY.FADE_S);
    if (s.autoWeather) { st.autoLeft -= dt; if (st.autoLeft <= 0) setWeather(SKY.nextWeather(st.wx.to, rnd), false); }
  }
  // indoors the hour and the weather grade the room at half strength; an activity's dim on top (睡觉)
  function gradeRoom(g, dt) {
    if (st.dim !== st.dimTarget) { const d = st.dimTarget - st.dim; st.dim = Math.abs(d) < 0.01 ? st.dimTarget : st.dim + d * Math.min(1, dt / 0.25); }
    const half = { mul: g.mul.map((m) => (1 - (1 - m) * 0.5) * st.dim), sat: 1 - (1 - g.sat) * 0.5, lift: g.lift * 0.5 };
    grade.matrix = SKY.gradeMatrix(half);
    outsideGrade.matrix = SKY.gradeMatrix(g);
    // her: lit a bit on her own, as in the yard
    const k = half.mul.map((m) => Math.min(1.6, (m + (1 - m) * 0.35) / Math.max(0.05, m)));
    petFilter.matrix = SKY.gradeMatrix({ mul: k, sat: 1, lift: 0 });
    for (const l of lampHalos) {
      const on = l.def.on ? !!(st.run && st.run.kind === l.def.on) : true;
      l.sprite.alpha = on ? (l.def.on ? 0.7 : g.lights * 0.8) * (0.95 + 0.05 * Math.sin(st.t * 5 + l.def.x)) : 0;
    }
    st.half = half;
  }
  // the window: the sky (gradient by the hour), sun or moon, clouds, rain or snow, behind the frame
  const drops = [];
  function drawOutside(g) {
    outsideG.clear();
    mullions.clear();
    const w = T && T.def.window;
    if (!w) return;
    const [x, y, ww, wh] = w.rect;
    const ph = g.phase;
    const top = ph === 'night' ? 0x1b2552 : ph === 'dusk' ? 0xf0a07a : ph === 'dawn' ? 0xf6c6a8 : 0x8ec9ff;
    const bottom = ph === 'night' ? 0x34406e : ph === 'dusk' ? 0xffd2a0 : ph === 'dawn' ? 0xd9ecff : 0xd7efff;
    const arch = w.arch ? ww / 2 : 0;
    const shape = (gg) => { if (w.arch) { gg.moveTo(x, y + arch); gg.arc(x + ww / 2, y + arch, ww / 2, Math.PI, 0); gg.lineTo(x + ww, y + wh); gg.lineTo(x, y + wh); gg.closePath(); } else gg.rect(x, y, ww, wh); };
    const bands = 8;
    for (let i = 0; i < bands; i++) {
      const k = i / (bands - 1);
      const r = Math.round(((top >> 16) & 255) * (1 - k) + ((bottom >> 16) & 255) * k);
      const gr = Math.round(((top >> 8) & 255) * (1 - k) + ((bottom >> 8) & 255) * k);
      const b = Math.round((top & 255) * (1 - k) + (bottom & 255) * k);
      outsideG.rect(x, y + (wh / bands) * i, ww, wh / bands + 1).fill({ color: (r << 16) | (gr << 8) | b });
    }
    // the sea at the bottom
    outsideG.rect(x, y + wh * 0.78, ww, wh * 0.22).fill({ color: ph === 'night' ? 0x22305e : 0x4f8ad0 });
    for (let i = 0; i < 6; i++) outsideG.rect(x + ((i * 37 + st.t * 6) % ww), y + wh * 0.8 + (i % 3) * 8, 12, 2).fill({ color: 0xffffff, alpha: 0.5 });
    const W = g.weather;
    if (ph === 'night') { outsideG.circle(x + ww * 0.72, y + wh * 0.3, 14).fill({ color: 0xfaf4d6 }); for (let i = 0; i < 12; i++) outsideG.rect(x + ((i * 53) % ww), y + 10 + ((i * 29) % (wh * 0.6)), 2, 2).fill({ color: 0xfff8dc, alpha: 0.5 + 0.5 * Math.sin(st.t * 2 + i) }); }
    else if (W.clouds < 0.7) outsideG.circle(x + ww * (ph === 'dusk' ? 0.25 : 0.7), y + wh * (ph === 'day' ? 0.25 : 0.55), 16).fill({ color: ph === 'dusk' ? 0xffc882 : 0xfff6d6 });
    const nc = Math.round(W.clouds * 5);
    for (let i = 0; i < nc; i++) { const cx = x + ((i * 61 + st.t * (6 + i)) % (ww + 60)) - 30; const cy = y + 30 + i * 22; outsideG.ellipse(cx, cy, 26, 9).fill({ color: ph === 'night' ? 0x5a6488 : 0xf4f7fb, alpha: 0.9 }); }
    const want = reduced ? 0 : Math.round(W.rain * 60);
    while (drops.length < want) drops.push({ x: rnd() * ww, y: rnd() * wh, v: 300 + rnd() * 160 });
    if (drops.length > want) drops.length = want;
    for (const d of drops) { d.y += d.v / 60; d.x -= 0.6; if (d.y > wh) { d.y = -8; d.x = rnd() * ww; } if (d.x < 0) d.x += ww; outsideG.rect(x + d.x, y + d.y, 1.5, 8).fill({ color: 0xe2eeff, alpha: 0.75 }); }
    if (W.snow > 0.2 && !reduced) for (let i = 0; i < 30; i++) outsideG.rect(x + ((i * 47 + Math.sin(st.t + i) * 8) % ww + ww) % ww, y + ((i * 31 + st.t * 30) % wh), 3, 3).fill({ color: 0xffffff });
    // the mask is the window's shape, then the frame again on top
    if (!outside.mask) { const m = new P.Graphics(); shape(m); m.fill({ color: 0xffffff }); outside.addChild(m); outside.mask = m; }
    mullions.rect(x + ww / 2 - 2, y, 4, wh).fill({ color: 0xffffff });
    mullions.rect(x, y + wh * 0.52, ww, 4).fill({ color: 0xffffff });
    st.windowSky = { phase: ph, moon: ph === 'night', drops: drops.length, clouds: nc };
  }

  function drawPet(dt) {
    if (!T || !sprite || !sprite.frames.idle) return;
    const s = T.pet.state();
    let anim = s.anim;
    if (st.run && s.mode === 'use') anim = actOf(st.run.kind).anim;
    if (s.mode === 'use' && !st.run && st.pending) anim = 'idle';
    const frames = sprite.frames[anim] || sprite.frames.idle;
    const fps = anim === 'walk' ? 6 : (sprite.actions[anim] && sprite.actions[anim].fps) || 2;
    const fr = frames[Math.floor(st.t * fps) % frames.length];
    if (petSprite.texture !== fr) petSprite.texture = fr;
    st.anim = anim;
    const hop = sprite.kind === 'paper' && s.mode === 'walk' ? -Math.abs(Math.sin(st.t * 10)) * 3 : 0;
    const lift = s.mode === 'lifted' ? -T.petH * 0.6 + Math.sin(st.t * 6) * 1.5 : 0;
    const bob = st.bob && !reduced ? Math.sin((st.t / st.bob.period) * Math.PI * 2) * st.bob.amp : 0;
    petSprite.scale.set((s.facing < 0 ? -1 : 1) / RES, 1 / RES);
    if (st.pose === 'tucked') {
      // lying down under the quilt: turned −90° about her feet, set at the activity's `lie` point
      st.poseK = reduced ? 1 : Math.min(1, st.poseK + dt / 0.4);
      const a = actOf(st.run ? st.run.kind : 'sleep');
      const lie = a.lie || [s.x, s.y];
      petSprite.rotation = -Math.PI / 2 * st.poseK;
      petSprite.scale.set(1 / RES, 1 / RES);
      petSprite.position.set(Math.round(s.x + (lie[0] - s.x) * st.poseK), Math.round(s.y + (lie[1] - s.y) * st.poseK));
    } else {
      petSprite.rotation = 0;
      petSprite.position.set(Math.round(s.x), Math.round(s.y + hop + lift + bob));
      petSprite.zIndex = s.mode === 'lifted' ? 1e6 : s.y + (s.mode === 'use' ? 1 : 0);
    }
  }
  function drawFlag() {
    flagG.clear();
    const f = st.flag;
    if (!f || !T) return;
    if (T.pet.state().mode !== 'walk') { st.flag = null; return; }
    f.t += 1 / 60;
    const bobY = Math.sin(f.t * 6) * 1.5;
    const pal = T.def.palette || {};
    const col = parseInt(String(pal.primary || '#2C4A8A').slice(1), 16);
    flagG.zIndex = f.y - 0.5;
    flagG.ellipse(f.x, f.y, 8, 3).stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
    flagG.moveTo(f.x, f.y).lineTo(f.x, f.y - 16 + bobY).stroke({ width: 2, color: 0xffffff });
    // a little ribbon bow on the marker
    flagG.poly([f.x, f.y - 18 + bobY, f.x - 8, f.y - 23 + bobY, f.x - 8, f.y - 13 + bobY]).fill({ color: col });
    flagG.poly([f.x, f.y - 18 + bobY, f.x + 8, f.y - 23 + bobY, f.x + 8, f.y - 13 + bobY]).fill({ color: col });
    flagG.circle(f.x, f.y - 18 + bobY, 2.5).fill({ color: 0xffffff });
  }
  function placeBubble() {
    const b = $('bubble');
    if (st.bubbleT <= 0 || !T) { b.classList.add('hidden'); return; }
    const box = petBox();
    const a = st.run ? actOf(st.run.kind) : null;
    let x;
    let y;
    if (a && a.bubble) [x, y] = toScreen(a.bubble[0], a.bubble[1]);
    else if (st.pose === 'tucked' && a && a.lie) [x, y] = toScreen(a.lie[0] - T.petH * 0.5, a.lie[1] - 70);
    else [x, y] = toScreen(box[0] + box[2] * 0.8, box[1] - 4);
    b.style.left = `${Math.round(x)}px`;
    b.style.top = `${Math.round(y)}px`;
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
    if (!T) return;
    stepTime(dt);
    const g = SKY.grade(st.hour, SKY.mixWeather(st.wx.from, st.wx.to, st.wx.k));
    st.lastGrade = g;
    gradeRoom(g, dt);
    drawOutside(g);
    if (st.cooldown > 0) st.cooldown -= dt;
    for (const ev of T.pet.step(dt, { phase: g.phase, roam: st.roam && !st.run && !st.pending && !st.preview })) {
      if (ev.type === 'use-start') {
        const f = T.furn.get(ev.obj);
        if (f && f.kind && st.pending && st.pending.fid === ev.obj) beginRun(f.kind, ev.obj);
        else if (f && f.kind) T.pet.stopUse(); // she wandered onto it by herself: the five are only ever yours to start
      } else if (ev.type === 'arrive' && ev.why === 'enter') say(line(null, 'enter'));
    }
    const p = runProgress();
    for (const f of st.fx) if (f.update) f.update(dt, p);
    stepRun(dt);
    drawPet(dt);
    drawFlag();
    placeLabels();
    if (st.bubbleT > 0) st.bubbleT -= dt;
    placeBubble();
    if (st.toastT > 0) { st.toastT -= dt; if (st.toastT <= 0) $('toast').classList.add('hidden'); }
    if (st.fading > 0) { st.fading = Math.max(0, st.fading - dt / 0.3); fade.clear(); fade.rect(0, 0, app.screen.width, app.screen.height).fill({ color: 0x0b0f14, alpha: st.fading }); } else fade.clear();
    cardT -= dt;
    if (cardT <= 0) { cardT = 0.25; renderCard(); if (st.run) renderStats(); document.body.dataset.phase = g.phase; }
  });

  // ---- main → page -----------------------------------------------------------------------------------------
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
  // her numbers changed elsewhere (fed on the desktop …): the stats card follows
  window.game.onView(async (v) => {
    const a = st.view && st.view.look;
    st.view = v;
    if (!v) return;
    const r = await ask({ cmd: 'state' });
    void r;
    renderStats();
    const owner = T && (ROOM.looks || {})[T.def.id];
    if (!owner && v.look && (!a || a.url !== v.look.url) && T) { sprite = await buildSprite(v.look, T.petH); petSprite.visible = sprite.kind !== 'placeholder'; }
    $('who').textContent = v.name ? `${v.name} 在这里` : '';
  });
  // closed: main settled the round (by how long it ran); she is back on the desktop
  window.game.onHidden(() => {
    window.game.set({ hour: Math.round(st.hour * 4) / 4 % 24 }).catch(() => {});
    if (st.run) { stopFx(); st.run = null; showActBar(); if (T && T.pet.state().mode === 'use') T.pet.stopUse(); }
    st.pending = null;
  });
  window.game.onShown(async () => {
    const r = await ask({ cmd: 'state' });
    if (r && r.ok) { renderStats(); renderQuests(); }
  });

  // ---- go ------------------------------------------------------------------------------------------------------
  $('who').textContent = st.view && st.view.name ? `${st.view.name} 在这里` : '';
  // which room: hers when she has an open one, else the last chosen, else the pack's default
  const base = st.view && st.view.pet && st.view.pet.speciesId;
  const first = OPEN.find((t) => t.character === base) || OPEN.find((t) => t.id === ROOM.theme) || OPEN.find((t) => t.id === M.defaultTheme) || OPEN[0];
  try {
    await enterTheme(first);
  } catch (e) {
    $('loading').textContent = `房间没能打开：${e.message}`;
    st.errors.push(String(e.message));
    return;
  }
  window.game.saveState({ theme: st.theme });
  renderCard();
  renderQuests();
  renderStats();
  showCard(null);
  // a round the app left open (it went away without settling): main settled it on boot
  if (ROOM.recovered) setTimeout(() => booked({ ...ROOM.recovered, summary: `${ROOM.recovered.summary || ''}（上次没结束的${DEFS[ROOM.recovered.kind].label}，这次打开时结算）` }), 600);
  $('loading').classList.add('hidden');
  window.addEventListener('beforeunload', () => window.game.saveState({ theme: st.theme }));

  // e2e read-out and handles (docs/her-room-design.md §4.5)
  const rectOf = (el) => { if (!el || el.classList.contains('hidden')) return null; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; };
  window.__game = () => {
    const s = T ? T.pet.state() : null;
    const box = T ? petBox() : null;
    return {
      ready: true, engine: 'room@1', id: M.id, name: M.name, version: M.version, update: st.update || null, fps: st.fps, frames: st.frames, renderer: app.renderer.name,
      hour: st.hour, target: st.target, phase: SKY.phaseOf(st.hour), scene: { ...st.scene }, weather: { ...st.wx },
      grade: st.half ? { mul: st.half.mul, dim: st.dim } : null, windowSky: st.windowSky || null,
      room: {
        theme: st.theme, owner: T ? T.owner : false, lookUrl: T ? T.lookUrl : null,
        themes: THEMES.map((t) => ({ id: t.id, status: t.status, name: t.name, character: t.character })),
        run: st.run ? { kind: st.run.kind, fid: st.run.fid, progress: runProgress(), seconds: st.run.seconds } : null, pending: st.pending,
        stats: { ...st.stats }, last: st.last,
        props: st.fx.map((f) => ({ fx: f.fx, ...(f.info ? f.info() : {}) })),
        pet: s && { boxScreen: (() => { const [a, b] = toScreen(box[0], box[1]); const [c, d] = toScreen(box[0] + box[2], box[1] + box[3]); return [a, b, c - a, d - b]; })(), x: s.x, y: s.y, mode: s.mode, anim: st.anim, resolved: sprite ? sprite.resolved : null, pose: st.pose, rotation: petSprite.rotation, facing: s.facing, using: s.using, goal: s.goal, sprite: sprite ? sprite.kind : null, visible: petSprite.visible, box, screen: toScreen(s.x, s.y), head: toScreen(st.pose === 'tucked' ? petSprite.x - T.petH * 0.85 : s.x, st.pose === 'tucked' ? petSprite.y : s.y - T.petH * 0.85), parent: petSprite.parent === front ? 'front' : 'sorted', walked: s.walked },
        hover: st.outline, tip: st.tipText || '',
        furniture: T ? [...T.furn.values()].filter((f) => f.kind || f.def.use).map((f) => { const sp = f.sprite; const [x0, y0] = toScreen(sp.x - sp.width / 2, sp.y - sp.height); const [x1, y1] = toScreen(sp.x + sp.width / 2, sp.y); return { id: f.def.id, kind: f.kind, sprite: f.def.sprite, rect: [x0, y0, x1 - x0, y1 - y0], world: [sp.x - sp.width / 2, sp.y - sp.height, sp.width, sp.height], click: toScreen(sp.x, sp.y - sp.height * 0.45) }; }) : [],
        labels: T ? [...T.furn.values()].filter((f) => f.labelEl).map((f) => ({ id: f.def.id, text: f.labelEl.querySelector('b').textContent, rect: rectOf(f.labelEl), running: f.labelEl.classList.contains('running'), tired: f.labelEl.classList.contains('tired') })) : [],
        bubble: { text: st.bubbleT > 0 ? $('bubble').textContent : null, rect: rectOf($('bubble')) },
        bar: st.run ? { name: $('act-name').textContent, time: $('act-time').textContent, fill: parseFloat($('act-fill').style.width) || 0 } : null,
        picker: { open: st.picker.open, focus: st.picker.focus, items: [...document.querySelectorAll('#picker-list .pick')].map((b) => ({ id: b.dataset.theme, status: b.dataset.status, tag: b.querySelector('.pick-tag').textContent, name: b.querySelector('.pick-name').textContent, avatar: !!b.querySelector('.pick-av').getAttribute('src'), current: b.classList.contains('current') })) },
        preview: st.preview ? { id: st.preview, name: $('preview-name').textContent, owner: $('preview-owner').textContent, soon: $('room-preview').querySelector('.preview-soon').textContent, motifs: $('preview-motifs').children.length, avatar: !!$('preview-avatar').getAttribute('src'), back: $('preview-back').textContent } : null,
        statsCard: [...document.querySelectorAll('#stats-list li')].map((li) => ({ stat: li.dataset.stat, value: Number(li.dataset.value), preview: Number(li.dataset.preview) })),
        lastText: $('stats-last').textContent, toast: st.lastToast || null,
      },
      quests: st.quests, events: st.events.slice(-60), line: st.lastLine || null, errors: st.errors.slice(),
    };
  };
  window.__gameTest = {
    toScreen, toWorld,
    setRoundScale: (k) => ask({ cmd: 'scale', k }),
    openThemes: () => openPicker(true),
    pickTheme,
    clickFurniture: (id) => clickFurniture(T.furn.get(id)),
    setHour: (h) => setHour(h, { ease: false }),
    setWeather: (id) => { setWeather(id, true); st.wx.k = 1; },
    showCard, roam: (on) => { st.roam = on; },
    refresh: async () => { await ask({ cmd: 'state' }); renderStats(); },
  };
})();
