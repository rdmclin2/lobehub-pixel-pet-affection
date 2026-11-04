'use strict';

const Fx = window.PetFx;
const Voice = window.PetVoice;
const IVoice = window.PetInteractionVoice;
const $ = (id) => document.getElementById(id);
// Appearance follows the OS like the admin window (admin/src/design/theme.ts): Electron forwards nativeTheme to
// prefers-color-scheme, and <html data-theme> picks the light / dark LobeHub tokens (design/lobe-tokens.css).
// A pinned choice in settings.ui.theme ('light' | 'dark'; anything else = follow the OS) wins, as in the admin window.
const appearance = (() => {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'auto';
  const apply = () => { document.documentElement.dataset.theme = choice === 'light' || choice === 'dark' ? choice : mq.matches ? 'dark' : 'light'; };
  apply();
  mq.addEventListener('change', apply);
  return { set(theme) { choice = theme || 'auto'; apply(); } };
})();
// lucide "mic" (the icon set LobeHub uses) for the idle 语音输入 button, drawn in currentColor by .ico (style.css)
const MIC_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>';
// A visiting model-chan (同屏伙伴) runs this same page in its own small window: index.html?visitor=<id>.
const VISITOR = new URLSearchParams(location.search).get('visitor');
const FOOD_SPRITE = { rice: 'rice', cookie: 'cookie', fruit: 'fruit' };
// 素材署名: every character's credits, from its file (src/characters/<id>.json).
const credits = () => ['角色均为同人形象，不是厂商官方形象；美术仅限非商业使用。', ...info.species.flatMap((sp) => ['', `${sp.title}「${sp.nameZh}」`, ...sp.credits.map((c) => `· ${c}`)])].join('\n');

let info = null; // { species[] (the bases: persona, credits, clips), characters[] (one per look, T-2764), foods, testMode }
let view = null; // latest pet view from main
let selected = null;
let thinking = false;
let arriving = null; // nameZh of a character on her way (her agent is being created), shown instead of 思考中
let eating = null;
let plays = 0; // 玩耍 pressed (and done): a VRM figure plays her play one-shot on each new count (T-2831)
let talkUntil = 0;
let flashUntil = 0;
let revealSpecies = null;
let bubbleTimer = null;
let bubbleHold = false; // pointer over the bubble: keep it open so a long reply can be scrolled and read
let thinkTimer = null;
let attachments = []; // [{ kind:'image', dataUrl, name } | { kind:'path', path, name }] waiting for the next message
let pointerInside = false;
let fx = null; // the shared effects layer (fx.js), created at boot
let dance = null; // VRM dancing (vrm-dance.js, docs/vrm-dance.md): what she dances, its music and clock; created at boot
let settings = null; // latest settings view: { needsAgeGate, ageConfirmed, adultContent, ... }
let gateAfter = null; // what to do once the age gate is answered
let toastTimer = null;
const notedBlocks = new Set(); // "cooldown" / "cap" notes are shown once per launch

// Every settings update also carries the pet size: the character area scales with it (style.css .stage).
function setSettings(st) {
  const wasOn = IVoice.voiceOn(settings && settings.prefs);
  settings = st;
  appearance.set(st && st.ui && st.ui.theme);
  if (wasOn && !IVoice.voiceOn(st && st.prefs)) stopSpeech(st && st.prefs && st.prefs.muted ? 'muted' : 'voice-off'); // 朗读 off / 静音: quiet at once, nothing pending
  syncMute();
  syncPrewarm();
  syncMic(); // 🎤 only while 语音输入 is on
  if (st && st.petScale && !VISITOR) showScale(st.petScale); // a visitor keeps her own small size
  if (window.PetVRM && window.PetVRM.director && view && view.look && view.look.kind === 'vrm') window.PetVRM.director.setPosture(view.look.packId, vrmPostureOf(view.look.packId));
  syncFraming();
}

// 取景 (core/framing.js, docs/half-body-mode.md): 全身 / 半身 for what she wears now — her own choice (her page in
// the settings window), her pack's default, then 桌宠行为 → 取景. A model-drawn look is re-framed in place (VRM: the
// camera glides; Live2D: the model glides to its new scale and offset): it never reloads her or flashes a T-pose.
const PF = window.PetFraming;
// per character (T-2764: each look of hers has her own 取景), keyed by her character id
const framingOf = (look) => PF.resolveFraming(settings, view && view.pet && (view.pet.characterId || view.pet.speciesId), look);
function syncFraming() {
  const slot = document.getElementById('pet-look');
  const el = slot && slot.firstElementChild;
  const f = view && view.look ? framingOf(view.look) : null;
  if (el && el.petFigure && el.petFigure.setFraming && f) el.petFigure.setFraming(f.mode);
  const wrap = document.getElementById('char-wrap');
  if (wrap) wrap.dataset.framing = f ? f.mode : 'full';
}

function showScale(k) {
  document.documentElement.style.setProperty('--pet-scale', String(k));
  $('resize-grip').setAttribute('aria-valuenow', String(Math.round(k * 100)));
}

// ---------- resizing the pet: corner handle, Ctrl/⌘ + wheel ----------
// The window follows (main resizes it around its bottom-right corner); the size is saved on release.
let resizing = null;
let scaleFrame = 0;
function previewScale(k) {
  const r = settings.petScaleRange;
  k = Math.round(Math.min(r.max, Math.max(r.min, k)) * 100) / 100;
  showScale(k);
  if (!scaleFrame) scaleFrame = requestAnimationFrame(async () => {
    scaleFrame = 0;
    const used = await window.pet.previewPetScale(Number(getComputedStyle(document.documentElement).getPropertyValue('--pet-scale')));
    showScale(used);
  });
  return k;
}
async function commitScale(k) {
  const r = await window.pet.setPetScale(k);
  if (r && r.ok) setSettings(r.settings);
}
function bindResize() {
  const grip = $('resize-grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    resizing = { x: e.screenX, y: e.screenY, k: settings.petScale, cur: settings.petScale };
    document.body.classList.add('resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    // up and to the left grows the pet; 190 px of drag (the character's height) doubles it
    const d = (resizing.y - e.screenY + (resizing.x - e.screenX)) / 2;
    resizing.cur = previewScale(resizing.k * (1 + d / 190));
  });
  const end = async () => {
    if (!resizing) return;
    const k = resizing.cur;
    resizing = null;
    document.body.classList.remove('resizing');
    await commitScale(k);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('mousedown', (e) => e.stopPropagation()); // not a window drag
  let wheelTimer = null;
  let wheelK = null;
  $('stage').addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    wheelK = previewScale((wheelK || settings.petScale) * (e.deltaY < 0 ? 1.05 : 1 / 1.05));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { const k = wheelK; wheelK = null; commitScale(k); }, 400);
  }, { passive: false });
}

const speciesOf = (id) => info.species.find((s) => s.id === id);
// a character (one look of a base, T-2764): { id, base, name 「大肥鱼 · 像素」, kind, portrait (her daily look) … }
const characterOf = (id) => (info.characters || []).find((c) => c.id === id);
// How a companion looks comes from its pet pack (`view.look`, see core/packs.js): a picture per outfit, or
// a pixel sprite sheet per outfit with one row of frames per action. Dafeiyu plays her own clips when
// they are picked under 外观 (look: null).
const isVideo = (id) => !!id && !!speciesOf(id) && speciesOf(id).art === 'video' && !(view && view.pet.speciesId === id && view.look);

// ---------- looks: pictures, animated pixel sprites and rigs ----------
const sprites = new Set(); // live sprite canvases: { canvas, look, sheet, k, action() }
const rigs = new Set(); // live figures, 全动态 (rig.js) or Live2D (live2d.js): { canvas, figure, action() }
// a look drawn live every frame instead of from frames: which script draws it
// (VRM: window.PetVRM, the three-vrm renderer; until it is loaded a VRM look shows its picture / placeholder)
const LIVE_KINDS = { rig: () => window.PetRig, live2d: () => window.PetLive2D, vrm: () => window.PetVRM };
const isLive = (look) => !!look && !!LIVE_KINDS[look.kind] && !!LIVE_KINDS[look.kind]();
// A whole HD sheet decodes to about 86 MB (2656×8136), so only the desktop pet draws from the full sheet.
// Smaller looks (cards, the wardrobe, the hatch screen) draw from a half-size copy, and a sheet nothing
// shows any more is let go after a while: the wardrobe would otherwise keep every outfit's sheet decoded.
const sheets = new Map(); // `${k}|${url}` -> { src (ImageBitmap at 1/k, or the Image if that failed), users, timer }
const SHEET_KEEP_MS = 10000; // a sheet shown again soon (the same look redrawn) is not loaded twice
// Decoded as ImageBitmaps, which close() frees at once: an <img> keeps its decoded pixels in Blink's cache.
function loadSheet(url, k) {
  return fetch(url)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`${r.status}`))))
    .then((blob) => createImageBitmap(blob))
    .then((full) => {
      if (k === 1) return full;
      const small = createImageBitmap(full, { resizeWidth: Math.round(full.width / k), resizeHeight: Math.round(full.height / k), resizeQuality: 'high' });
      return small.finally(() => full.close());
    });
}
function useSheet(url, k) {
  const key = `${k}|${url}`;
  let e = sheets.get(key);
  if (!e) {
    e = { src: null, users: 0, timer: 0, ready: null };
    const entry = e;
    e.ready = loadSheet(url, k).then((bmp) => {
      if (sheets.get(key) === entry) entry.src = bmp;
      else bmp.close();
    }, () => {
      const img = new Image(); // cannot be fetched: drawn from the picture itself
      if (url.startsWith('pack:')) img.crossOrigin = 'anonymous'; // pack:// answers with CORS: her pixels stay readable for touch hit tests
      img.src = url;
      entry.src = img;
      return img.decode();
    });
    sheets.set(key, e);
  }
  clearTimeout(e.timer);
  e.users++;
  return e;
}
// Settles when every sheet of `url` in use can be drawn (rejects if one cannot be loaded at all).
const sheetReady = (url) => Promise.all([...sheets].filter(([key]) => key.endsWith(`|${url}`)).map(([, e]) => e.ready));
function dropSheet(url, k) {
  const key = `${k}|${url}`;
  const e = sheets.get(key);
  if (!e || --e.users > 0) return;
  e.timer = setTimeout(() => {
    if (e.users > 0) return;
    sheets.delete(key);
    if (e.src && e.src.close) e.src.close();
    e.src = null;
  }, SHEET_KEEP_MS);
}
// An element showing `look`; `action` (a function) picks the sprite action each frame.
function lookEl(look, { className = 'look', alt = '', action = () => 'idle', speciesId = null } = {}) {
  if (!look) {
    // Dafeiyu's clip is 16:9 with the character small in the middle: crop it like the desktop pet does
    const wrap = document.createElement('div');
    wrap.className = `${className} vlook`;
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    if (speciesId) v.src = `${speciesOf(speciesId).clipDir}/${[].concat(speciesOf(speciesId).clips.idle)[0]}`;
    wrap.appendChild(v);
    return wrap;
  }
  if (isLive(look) && className === 'char') {
    // the desktop pet is drawn live; anywhere else (cards, the wardrobe) her picture stands in
    const c = document.createElement('canvas');
    c.className = `${className} sprite rig ${look.kind}`;
    c.width = look.kind === 'rig' ? look.model.size[0] : 332;
    c.height = look.kind === 'rig' ? look.model.size[1] : 452;
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', alt);
    try {
      if (look.kind === 'vrm' && window.PetVRM && window.PetVRM.director) window.PetVRM.director.setPosture(look.packId, vrmPostureOf(look.packId)); // her saved posture, before she is drawn
      const figure = LIVE_KINDS[look.kind]().createFigure(c, look, { framing: framingOf(look).mode });
      c.petFigure = figure; // syncFraming re-frames it when the settings change
      const r = { canvas: c, figure, action, ok: false, kind: look.kind };
      figure.ready.then((ok) => { if (ok === false) return; r.ok = true; rigs.add(r); }, (e) => rigFailed(c, look, alt, className, e));
    } catch (e) {
      setTimeout(() => rigFailed(c, look, alt, className, e));
    }
    return c;
  }
  if (look.kind === 'sprites') {
    const c = document.createElement('canvas');
    c.className = `${className} sprite${look.pixelated ? ' pixelated' : ''}`;
    // the half-size copy for small looks, only for big smooth frames: pixel art stays block for block
    const k = className !== 'char' && !look.pixelated && look.frame.width >= 400 ? 2 : 1;
    c.width = Math.round(look.frame.width / k);
    c.height = Math.round(look.frame.height / k);
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', alt);
    const s = { canvas: c, look, k, sheet: useSheet(look.url, k), action, start: performance.now(), framing: 'full', glide: null, pet: className === 'char' };
    if (s.pet) {
      // 取景 (core/framing.js, docs/half-body-mode.md): the desktop pet crops each frame to head → waist and draws it
      // bigger in the same canvas box; the same setFraming() as a VRM / Live2D figure (syncFraming calls it). The sheet,
      // the canvas and the action's timing stay: only the part of the frame drawn changes (a short glide for smooth HD
      // art; hard pixel art switches at once, a gliding nearest-neighbour scale would shimmer).
      s.framing = framingOf(look).mode === 'half' ? 'half' : 'full';
      sizeSpriteCanvas(s);
      c.petFigure = {
        setFraming(mode, { instant = false } = {}) {
          const next = mode === 'half' ? 'half' : 'full';
          if (next === s.framing) return false;
          const now = performance.now();
          s.glide = instant || look.pixelated ? null : { from: spriteCrop(s, now), t0: now };
          s.framing = next;
          sizeSpriteCanvas(s);
          drawSprite(s, now);
          return true;
        },
        framing: () => s.framing,
        debug: () => spriteDebug(s),
      };
    }
    sprites.add(s);
    drawSprite(s, performance.now());
    return c;
  }
  if (look.kind === 'vrm') return vrmPictureEl(look, className, alt);
  const img = document.createElement('img');
  if (look.url.startsWith('pack:')) img.crossOrigin = 'anonymous';
  img.className = `${className}${look.pixelated ? ' pixelated' : ''}`;
  img.alt = alt;
  img.draggable = false;
  img.src = look.url;
  return img;
}
// A VRM look not drawn live (lists, the wardrobe, or before the 3D renderer is there): the picture the
// renderer saved for the pack over a "VRM" tile, so a model without a picture yet is still recognisable.
function vrmPictureEl(look, className, alt) {
  const wrap = document.createElement('div');
  wrap.className = `${className} vrm-look${look.locked ? ' locked' : ''}`;
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', alt);
  wrap.innerHTML = '<span class="vrm-badge">VRM</span>';
  if (look.url) {
    const img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.alt = '';
    img.draggable = false;
    img.hidden = true; // shown once it is a real picture: the importer's 1×1 stand-in is not one
    img.addEventListener('load', () => { img.hidden = img.naturalWidth <= 1; });
    img.src = look.url;
    wrap.appendChild(img);
  }
  return wrap;
}
function drawSprite(s, now) {
  const { look, canvas, k } = s;
  const img = s.sheet.src;
  if (!img || (img instanceof HTMLImageElement && (!img.complete || !img.naturalWidth))) return;
  const want = Fx.resolveAction(s.action(), (n) => !!look.actions[n]).name;
  const a = look.actions[want] || look.actions.idle;
  if (s.cur !== want) { s.cur = want; s.start = now; }
  const i = Math.floor(((now - s.start) / 1000) * a.fps) % a.frames;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = !look.pixelated;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const { width: w, height: h } = look.frame;
  const base = s.pet ? spriteCrop(s, now) : null;
  const whole = !base || (base.sx === 0 && base.sy === 0 && base.sw === w && base.sh === h);
  // 半身: a frame drawn floating takes the crop up with her (core/framing.js spriteLift), eased in with the glide
  s.lift = 0;
  if (!whole && s.half && s.sheet.ref) {
    const progress = Math.min(1, Math.max(0, (h - base.sh) / Math.max(1e-6, h - s.half.sh)));
    s.lift = PF.spriteLift(s.sheet.ref, spriteCellBottom(s, a.row, a.col + i), { w, h }, { pixelated: !!look.pixelated }) * progress;
  }
  const crop = s.lift ? { ...base, sy: base.sy - s.lift } : base;
  if (whole) ctx.drawImage(img, ((a.col + i) * w) / k, (a.row * h) / k, w / k, h / k, 0, 0, canvas.width, canvas.height);
  else {
    // 半身: only the crop of this cell, clipped to it (the rest of the sheet is the neighbouring frames)
    const r = PF.spriteDrawRects(crop, { w, h }, { W: canvas.width, H: canvas.height });
    if (r) ctx.drawImage(img, ((a.col + i) * w + r.src.x) / k, (a.row * h + r.src.y) / k, r.src.w / k, r.src.h / k, r.dst.x, r.dst.y, r.dst.w, r.dst.h);
  }
  // which frame is up, and how it is cropped (touch hit tests cache its pixels by this)
  const frame = `${look.url}#${a.row}:${a.col + i}${whole ? '' : `@${s.framing}:${crop.sx | 0},${crop.sy | 0},${crop.sw | 0}`}`;
  if (canvas.dataset.frame !== frame) canvas.dataset.frame = frame;
  if (s.pet) {
    // debug fields (e2e) and what artPoint reads for the touch zones: data-framing / data-cut like a Live2D canvas
    const d = canvas.dataset;
    const half = s.framing === 'half' && s.half;
    if (d.framing !== s.framing) d.framing = s.framing;
    const cut = half ? s.half.cut.toFixed(3) : '1';
    if (d.cut !== cut) d.cut = cut;
    const band = half ? s.half.source : '';
    if (d.band !== band) d.band = band;
    // data-crop: the crop for her standing frames; data-lift: how far it is moved up for this (floating) frame
    const cr = whole ? '' : [base.sx, base.sy, base.sw, base.sh].map((v) => Math.round(v * 10) / 10).join(',');
    if (d.crop !== cr) d.crop = cr;
    const lift = s.lift ? String(Math.round(s.lift * 10) / 10) : '0';
    if (d.lift !== lift) d.lift = lift;
  }
}
// The desktop pet's sprite canvas for its framing (core/framing.js spriteCanvas): hard pixel art in 半身 gets a
// whole-number multiple of the frame, so each source pixel is an even block; otherwise the frame's own size.
function sizeSpriteCanvas(s) {
  const { W, H } = PF.spriteCanvas({ w: s.look.frame.width, h: s.look.frame.height }, { mode: s.framing, pixelated: !!s.look.pixelated });
  if (s.canvas.width !== W) s.canvas.width = W;
  if (s.canvas.height !== H) s.canvas.height = H;
}
const SPRITE_GLIDE_MS = 350; // the switch between 全身 and 半身 (the same as a VRM / Live2D figure)
// The part of the frame drawn now (frame px): the whole frame in 全身, the half-body crop in 半身, eased between
// the two for SPRITE_GLIDE_MS after a switch.
function spriteCrop(s, now) {
  const frame = { w: s.look.frame.width, h: s.look.frame.height };
  let target = PF.spriteFull(frame);
  s.half = null;
  if (s.framing === 'half') {
    const ref = spriteRefOf(s);
    if (ref) {
      s.half = PF.spriteHalfCrop(ref, { frame, waist: s.look.halfBody && s.look.halfBody.waist, canvas: { W: s.canvas.width, H: s.canvas.height }, pixelated: !!s.look.pixelated });
      target = s.half;
    }
  }
  if (!s.glide) return target;
  const t = (now - s.glide.t0) / SPRITE_GLIDE_MS;
  if (t >= 1) { s.glide = null; return target; }
  return PF.blendRect(s.glide.from, target, t);
}
// Her head-to-soles extent in the frames of this sheet (core/framing.js spriteRef), measured once per sheet from
// the opaque pixels of frame 0 of a few standing actions, read at a quarter of the size for big HD frames. A sheet
// that cannot be read back counts as her filling the whole frame. null until the sheet is decoded.
const SPRITE_ALPHA = 128;
function spriteRefOf(s) {
  const e = s.sheet;
  if (e.ref) return e.ref;
  const img = e.src;
  if (!img || (img instanceof HTMLImageElement && (!img.complete || !img.naturalWidth))) return null;
  const { look, k } = s;
  const fw = look.frame.width;
  const fh = look.frame.height;
  const q = fw >= 400 ? 4 / k : 1; // HD: a quarter (166×226 a frame); pixel art: as is
  const cw = Math.max(1, Math.round(fw / k / q));
  const ch = Math.max(1, Math.round(fh / k / q));
  const boxes = [];
  try {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    for (const name of PF.SPRITE.refActions) {
      const a = look.actions[name];
      if (!a) continue;
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(img, (a.col * fw) / k, (a.row * fh) / k, fw / k, fh / k, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;
      let x0 = cw;
      let y0 = ch;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        if (data[(y * cw + x) * 4 + 3] < SPRITE_ALPHA) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const sx = fw / cw;
      const sy = fh / ch;
      if (x1 >= 0) boxes.push({ top: y0 * sy, bottom: (y1 + 1) * sy, minX: x0 * sx, maxX: (x1 + 1) * sx });
    }
  } catch (err) {
    console.warn('[sprite] cannot read the sheet back, framing on the whole frame:', err && err.message);
  }
  e.ref = PF.spriteRef(boxes, { w: fw, h: fh });
  return e.ref;
}
// Her soles in one frame of the sheet (frame px, exclusive): the last row with an opaque pixel, read at the size
// spriteRefOf reads (a quarter for HD art, so a stray 1 px line does not count), once per frame and sheet.
let cellProbe = null;
function spriteCellBottom(s, row, col) {
  const e = s.sheet;
  const key = `${row}:${col}`;
  if (!e.cells) e.cells = new Map();
  if (e.cells.has(key)) return e.cells.get(key);
  const img = e.src;
  const { look, k } = s;
  const fw = look.frame.width;
  const fh = look.frame.height;
  const q = fw >= 400 ? 4 / k : 1;
  const cw = Math.max(1, Math.round(fw / k / q));
  const ch = Math.max(1, Math.round(fh / k / q));
  let bottom = NaN;
  try {
    if (!cellProbe) cellProbe = document.createElement('canvas');
    cellProbe.width = cw;
    cellProbe.height = ch;
    const ctx = cellProbe.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, (col * fw) / k, (row * fh) / k, fw / k, fh / k, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    for (let y = ch - 1; y >= 0 && !Number.isFinite(bottom); y--) for (let x = 0; x < cw; x++) if (data[(y * cw + x) * 4 + 3] >= SPRITE_ALPHA) { bottom = (y + 1) * (fh / ch); break; }
  } catch { /* a sheet that cannot be read back: no lift */ }
  e.cells.set(key, bottom);
  return bottom;
}
// petFx.sprite(): what the desktop pet's sprite canvas draws (e2e)
function spriteDebug(s) {
  return {
    packId: s.look.packId, framing: s.framing, band: s.half ? s.half.source : null, waist: s.half ? s.half.waist : null, cut: s.half ? s.half.cut : 1, scale: s.half ? s.half.scale : 1,
    ref: s.sheet.ref || null, crop: s.canvas.dataset.crop || null, lift: s.lift || 0, canvas: [s.canvas.width, s.canvas.height], gliding: !!s.glide, pixelated: !!s.look.pixelated, action: s.cur || null,
  };
}
// No WebGL (or a layer that would not load): show her picture instead of an empty canvas.
function rigFailed(canvas, look, alt, className, e) {
  console.warn('[rig] falling back to the picture:', e && e.message);
  if (!canvas.isConnected) return;
  const img = document.createElement('img');
  img.crossOrigin = 'anonymous';
  img.className = className;
  img.alt = alt;
  img.draggable = false;
  img.src = look.url;
  canvas.replaceWith(look.kind === 'vrm' ? vrmPictureEl(look, className, alt) : img);
}
// What her voice is doing right now: 'audio' (a TTS clip playing), 'system' (Web Speech) or null. A VRM
// figure moves her mouth with it (lip sync), whatever state she is in (an interaction line is read during pat).
function voiceNow() {
  if (speechAudio && !speechAudio.paused && !speechAudio.ended) return 'audio';
  if (window.speechSynthesis && speechSynthesis.speaking) return 'system';
  return null;
}
// A VRM figure gets a read-only snapshot of the app instead of a state to act out (docs/vrm-motion-system.md
// §2.2): its own director decides what she does. Rig and Live2D figures keep the state.
function vrmSnapshot(now) {
  return {
    t: now / 1000,
    state: petStatus(), // only the key of pack.json vrm.expressions overrides
    status: view.status,
    shot: fx.current(now),
    lifted: fx.lifted,
    flying: fx.flying,
    thinking,
    eating,
    play: plays,
    talking: now < talkUntil,
    voice: voiceNow(),
    walking: fx.walking,
    touch: lastTouch && { n: lastTouch.n, zone: lastTouch.zone, mood: lastTouch.mood, streak: lastTouch.streak },
    facing: $('pet-body').dataset.facing,
    pointerInside,
    win: [window.screenX, window.screenY],
    dance: dance ? dance.snapshot() : null,
    recording: micActive(),
  };
}
// The posture saved for a VRM pack (settings.vrmPostures; 'auto' = her director chooses).
const vrmPostureOf = (packId) => (settings && settings.vrmPostures && settings.vrmPostures[packId]) || 'auto';
function tickRigs(now) {
  for (const r of rigs) {
    if (!r.canvas.isConnected) { r.figure.dispose(); rigs.delete(r); continue; }
    if (r.kind === 'vrm' && r.action === petAction && view) { r.figure.draw(vrmSnapshot(now)); continue; }
    const state = r.action();
    const mood = state.startsWith('touch-') && lastTouch ? lastTouch.mood : null;
    r.figure.draw({ t: now / 1000, state, mood, talking: state === 'talk', voice: voiceNow(), win: [window.screenX, window.screenY] });
  }
}
function tickSprites(now) {
  for (const s of sprites) {
    if (!s.canvas.isConnected) { sprites.delete(s); dropSheet(s.look.url, s.k); continue; }
    drawSprite(s, now);
  }
}
function setLook(slot, look, opts) {
  slot.textContent = '';
  slot.appendChild(lookEl(look, opts));
}

// A video character plays one clip per state (resolved through fx.FALLBACK when it has none).
// A state may have several clips (variants, e.g. Dafeiyu's click reactions): each time it starts, one
// is picked that did not play last time.
function playClip(video, sp, key, loop = true) {
  if (video.dataset.key === key) return;
  video.dataset.key = key;
  video.loop = loop;
  const file = Fx.pickVariant(sp.clips[key], video.dataset.file || null);
  video.dataset.file = file;
  video.src = `${sp.clipDir}/${file}`;
  video.play().catch(() => {});
}
const clipFor = (sp, state) => Fx.resolveAction(state, (n) => !!sp.clips[n]);

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
}

// A character's portrait: its daily look (a sprite plays `state`), or its idle clip.
function portraitEl(sp, className, state = 'idle') {
  return lookEl(sp.portrait, { className, alt: sp.nameZh, action: () => state, speciesId: sp.id });
}

// ---------- 18+ confirmation (design 8.3) ----------
// Shown before anything else on first launch, and again when someone who chose "all ages" wants to turn
// adult content on from the menu. Closing the window without answering keeps adult content off.
function showAgeGate(after) {
  gateAfter = after;
  window.pet.place('onboarding');
  show('age-gate');
}

async function answerAgeGate(adult) {
  const r = await window.pet.confirmAge(adult);
  setSettings(r.settings);
  const after = gateAfter;
  gateAfter = null;
  if (after) after(r);
}

// ---------- onboarding: choose a model-chan ----------
// One card per character (T-2764): every look is a character of her own (「大肥鱼 · 像素」「大肥鱼 · Live2D」…).
// data-species is her base (several cards may share one), data-character who she is.
function buildCards() {
  const wrap = $('cards');
  wrap.innerHTML = '';
  for (const ch of info.characters) {
    const sp = speciesOf(ch.base);
    const card = document.createElement('button');
    card.className = 'char-card';
    card.dataset.species = ch.base;
    card.dataset.character = ch.id;
    card.dataset.kind = ch.kind || '';
    card.setAttribute('role', 'radio');
    card.setAttribute('aria-checked', 'false');
    card.setAttribute('aria-label', `${sp.title}，${ch.name}`);
    card.style.setProperty('--accent', sp.accent);
    card.innerHTML = '<div class="pic"></div><div class="vendor"></div><div class="nm"></div>';
    card.querySelector('.pic').appendChild(lookEl(ch.portrait, { className: 'card-look', alt: ch.name, action: () => 'idle', speciesId: ch.base }));
    card.querySelector('.vendor').textContent = `${sp.vendor} · ${ch.kindLabel || ''}`;
    card.querySelector('.nm').textContent = ch.name;
    card.addEventListener('click', () => selectCard(ch.id));
    wrap.appendChild(card);
  }
}

function selectCard(id) {
  selected = id;
  const ch = characterOf(id);
  const sp = speciesOf(ch.base);
  for (const c of document.querySelectorAll('.char-card')) {
    c.classList.toggle('selected', c.dataset.character === id);
    c.setAttribute('aria-checked', String(c.dataset.character === id));
  }
  const box = $('card-info');
  box.textContent = '';
  const b = document.createElement('b');
  b.textContent = `${sp.title}：`;
  box.appendChild(b);
  box.appendChild(document.createTextNode(sp.blurb));
  $('hatch-btn').disabled = false;
  $('pet-name').placeholder = `给她起个名字（默认 ${sp.nameZh}）`;
}

function showOnboarding() {
  selected = null;
  $('hatch-btn').disabled = true;
  $('card-info').textContent = '点一位看看。';
  $('pet-name').value = '';
  buildCards();
  show('onboarding');
}

// ---------- hatching ----------
const STEP_ORDER = ['checking-login', 'login', 'choose-space', 'creating-agent', 'connecting-device', 'hatching'];

function setStep(step) {
  const idx = STEP_ORDER.indexOf(step);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = STEP_ORDER.indexOf(li.dataset.step);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('active', i === idx);
  });
  $('hatch-look').dataset.progress = String(Math.min(3, Math.max(0, idx > 3 ? 3 : idx)));
}

// Personal space first (the default), then every workspace. Resolves with the chosen space.
function chooseSpace({ workspaces, pinned }) {
  const list = $('space-list');
  list.innerHTML = '';
  const options = [{ workspaceId: null, name: '个人空间', hint: '只有你自己能看到（推荐）' }, ...workspaces.map((w) => ({ workspaceId: w.id, name: w.name, hint: 'workspace' }))];
  options.forEach((o, i) => {
    const row = document.createElement('label');
    row.className = 'space-opt';
    row.innerHTML = '<input type="radio" name="space" /><span class="nm"></span><span class="hint"></span>';
    row.querySelector('input').value = String(i);
    row.querySelector('input').checked = i === 0;
    row.querySelector('.nm').textContent = o.name;
    row.querySelector('.hint').textContent = o.hint;
    list.appendChild(row);
  });
  const note = $('space-note');
  const refreshNote = () => {
    const personal = list.querySelector('input:checked').value === '0';
    note.classList.toggle('hidden', !(personal && pinned));
    if (pinned) note.textContent = `你的 lh 目前默认用 workspace「${pinned.name}」。放进个人空间会运行 lh workspace use --personal，把终端里 lh 的默认空间也切回个人。`;
  };
  list.addEventListener('change', refreshNote);
  refreshNote();
  $('hatching').classList.add('choosing'); // the portrait makes room for the choice
  $('space-box').classList.remove('hidden');
  return new Promise((resolve) => {
    $('space-go').onclick = () => {
      const o = options[Number(list.querySelector('input:checked').value)];
      $('space-box').classList.add('hidden');
      $('hatching').classList.remove('choosing');
      resolve({ workspaceId: o.workspaceId, name: o.name, switchToPersonal: !o.workspaceId && !!pinned });
    };
  });
}

async function startHatch() {
  const chosen = characterOf(selected);
  const species = speciesOf(chosen.base);
  revealSpecies = null;
  // she is asleep (dimmed) while LobeHub is set up, and wakes up when the agent is ready
  setLook($('hatch-look'), chosen.portrait, { className: 'look', alt: chosen.name, action: () => 'sleep', speciesId: species.id });
  $('hatch-look').classList.add('asleep');
  $('hatch-look').classList.remove('hidden');
  $('hatch-look').dataset.progress = '0';
  $('hatch-error').classList.add('hidden');
  $('hatch-retry').classList.add('hidden');
  $('login-box').classList.add('hidden');
  $('space-box').classList.add('hidden');
  $('step-device').classList.toggle('hidden', !$('local-opt').checked);
  $('hatch-title').textContent = '唤醒中……';
  document.querySelectorAll('#steps li').forEach((li) => li.classList.remove('done', 'active'));
  show('hatching');

  const offStep = window.pet.onHatchStep(setStep);
  const offLogin = window.pet.onLoginPrompt(({ url, code, browserFailed }) => {
    $('login-msg').textContent = browserFailed ? '没能自动打开浏览器，已为你打开登录页。请输入验证码：' : '浏览器已打开登录页，请确认验证码：';
    $('login-code').textContent = code || '（见浏览器页面）';
    $('login-url').textContent = url;
    $('login-box').classList.remove('hidden');
  });
  let res = await window.pet.spaces();
  if (res.ok) {
    $('login-box').classList.add('hidden');
    let space = { workspaceId: null, name: '个人空间', switchToPersonal: false };
    // Only ask when there is a choice to make.
    if (res.workspaces.length) {
      setStep('choose-space');
      space = await chooseSpace(res);
    }
    res = await window.pet.hatch(chosen.id, $('pet-name').value, $('local-opt').checked, space);
  }
  offStep();
  offLogin();

  if (!res.ok) {
    $('hatch-title').textContent = '唤醒失败';
    $('hatch-error').textContent = res.error;
    $('hatch-error').classList.remove('hidden');
    $('hatch-retry').classList.remove('hidden');
    return;
  }
  document.querySelectorAll('#steps li').forEach((li) => { li.classList.remove('active'); li.classList.add('done'); });
  $('login-box').classList.add('hidden');
  flashUntil = performance.now() + 700;
  revealSpecies = res.view.pet.speciesId;
  $('hatch-title').textContent = `${res.view.pet.name} 醒来了！`;
  const sp = speciesOf(revealSpecies);
  const her = characterOf(res.view.pet.characterId) || chosen;
  // the wake-up: every character plays its `hatch` state (a clip, or a sprite action)
  $('hatch-look').classList.remove('asleep');
  if (sp.art === 'video' && !her.portrait) {
    $('hatch-look').classList.add('hidden');
    $('hatch-vwrap').classList.remove('hidden');
    $('hatch-video').dataset.key = '';
    playClip($('hatch-video'), sp, clipFor(sp, 'hatch').name, false);
  } else {
    setLook($('hatch-look'), her.portrait, { className: 'look', alt: her.name, action: () => 'hatch' });
  }
  setTimeout(() => {
    enterPet(res.view);
    if (res.localError) setTimeout(() => say(`（没能连上这台电脑，文件功能先关着：${String(res.localError).slice(0, 60)}）`, 'error', 'fallback', res.localError), 600);
    else if (res.localWarning) setTimeout(() => say(`（${res.localWarning}）`, 'error', 'fallback', res.localWarning), 600);
  }, sp.art === 'video' && !her.portrait ? Fx.oneShotMs(true, 'hatch') : Fx.oneShotMs(false, 'hatch') + 600);
}

// ---------- pet ----------
function applyArt() {
  const video = isVideo(view && view.pet.speciesId);
  $('char-wrap').classList.toggle('hidden', video);
  $('vwrap').classList.toggle('hidden', !video);
  if (video) return;
  // (not the framing: a change of 取景 re-frames the figure in place, see syncFraming)
  const key = `${view.look.packId}/${view.outfit}${view.look.live2d ? `@${view.look.live2d.height}` : ''}${view.look.vrm ? `@${view.look.vrm.height}#${view.look.model}~${view.look.vrm.idle || ''}` : ''}`; // a Live2D / VRM model's size is redrawn too
  const slot = $('pet-look');
  $('pet-body').dataset.kind = view.look.kind; // style.css: a VRM is not squashed, dangled or mirrored by CSS
  if (slot.dataset.key !== key) {
    slot.dataset.key = key;
    setLook(slot, view.look, { className: 'char', alt: view.pet.name, action: petAction });
    $('char-wrap').classList.toggle('has-sprites', view.look.kind === 'sprites' || isLive(view.look));
    $('char-wrap').dataset.outfit = view.outfit;
    // a short sparkle so the change of clothes is noticed
    $('char-wrap').classList.remove('changed');
    void $('char-wrap').offsetWidth;
    $('char-wrap').classList.add('changed');
  }
  syncFraming();
}

function enterPet(v) {
  view = v;
  syncPrewarm();
  const p = pendingSpeech;
  pendingSpeech = null;
  if (p && performance.now() - p.at < 15000) speak(p.m);
  revealSpecies = null;
  $('hatch-vwrap').classList.add('hidden');
  $('hatch-look').classList.add('hidden');
  fx.clear();
  fx.stopThrow();
  $('pet-video').dataset.key = '';
  window.pet.place('pet');
  show('pet-screen');
  applyArt();
  refreshHud();
}

function barColor(v, invert) {
  const good = invert ? 100 - v : v;
  // LobeHub semantic colours (design/lobe-tokens.css): they follow the light / dark theme
  return good > 60 ? 'var(--lobe-color-success)' : good > 30 ? 'var(--lobe-color-warning)' : 'var(--lobe-color-error)';
}

function refreshHud() {
  if (!view) return;
  const p = view.pet;
  const set = (id, v, invert) => {
    const el = $(id);
    el.style.setProperty('--v', `${invert ? 100 - v : v}%`);
    el.style.setProperty('--c', barColor(v, invert));
  };
  set('bar-hunger', p.hunger, true);
  set('bar-mood', p.mood, false);
  set('bar-energy', p.energy, false);
  const a = view.affection;
  const prog = a.next ? ` · 距「${a.nextName}」${a.need}` : ' · 已满级';
  // who she is: her character's name (「大肥鱼 · Live2D」, T-2764)
  $('meta').textContent = `${p.name} · ${view.character ? view.character.name : view.species.nameZh} · ${a.stageName} ♥${a.value}${prog}`;
  $('pet-body').style.setProperty('--accent', view.species.accent);
  $('meta').title = `好感 ${a.value} / ${a.max}（今天 +${a.today} / ${a.dailyCap}）${view.space ? ` · 放在：${view.space.name}` : ''}`;
  // 💗 affection: stage name in its colour, the 0..100 bar and the number; the tooltip has the stage progress
  $('aff-stage').textContent = a.stageName;
  $('aff-stage').style.setProperty('--sc', a.color);
  $('bar-affection').style.setProperty('--v', `${a.value}%`);
  $('bar-affection').style.setProperty('--c', a.color);
  $('aff-num').textContent = `♥${a.value}/${a.max}`;
  $('aff-row').title = a.next ? `好感 ${a.value} / ${a.max} · 距「${a.nextName}」还差 ${a.need}（本阶段进度 ${a.pct}%）` : `好感 ${a.value} / ${a.max} · 已满级`;
  $('aff-row').setAttribute('aria-label', $('aff-row').title);
  setSettings(view.settings);
  syncSettingsDot();
}

// The one way into the settings window (配置后台) from the pet: the ⚙ button, a right click or a long press
// on her, and Ctrl/⌘+, (main.js). Everything the old ⋯ menu held lives there now. A dot on ⚙ says there is
// something new waiting in it: an outfit or topic just unlocked, or a new version.
const SETTINGS_SECTION = { update: 'update', outfit: () => `characters/${view.pet.characterId || view.pet.speciesId}`, topic: 'topics' };
function settingsNews() {
  if (updateState && ['ready', 'manual'].includes(updateState.status)) return 'update';
  if (view && view.outfits.some((o) => o.isNew)) return 'outfit';
  if (view && view.topics.some((o) => o.isNew)) return 'topic';
  return null;
}
function syncSettingsDot() {
  const news = settingsNews();
  const b = $('btn-settings');
  b.querySelector('.new-dot').classList.toggle('hidden', !news);
  b.dataset.news = news || '';
  b.title = news === 'update' ? `有新版本 v${updateState.version}：点此打开设置 → 版本与更新（Ctrl/⌘ + ,）` : news ? '设置：有新解锁的内容（Ctrl/⌘ + ,）' : '设置（Ctrl/⌘ + ,；也可以右键或在触屏上长按她）';
}
function openSettings(section) {
  if (thinking) return;
  $('food-menu').classList.add('hidden');
  closeDanceMenu();
  hideToast();
  const news = section === undefined ? settingsNews() : null;
  const s = section !== undefined ? section : news ? SETTINGS_SECTION[news] : undefined;
  window.pet.openAdmin(typeof s === 'function' ? s() : s);
}

// ---------- affection feedback (design 9.3, 9.4) ----------
const BLOCK_NOTES = { cooldown: '刚刚已经很开心了', cap: '今天的好感攒满啦，明天见', daily: '这个今天已经做够啦', 'topic-today': '今天聊过这个了' };

function floatText(text, cls = '') {
  const el = document.createElement('div');
  el.className = `float ${cls}`;
  el.textContent = text;
  $('float-layer').appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

function onAffection(e) {
  if (e.type === 'gain') {
    if (e.delta > 0) { floatText(`+${e.delta} ♥`); fx.burst(Math.min(10, 3 + Math.round(e.delta * 2))); }
    else if (e.delta < 0) floatText(`${e.delta} ♥`, 'minus');
    else if (BLOCK_NOTES[e.blocked] && !notedBlocks.has(e.blocked)) {
      notedBlocks.add(e.blocked);
      floatText(BLOCK_NOTES[e.blocked], 'note');
    }
  } else if (e.type === 'decay') {
    floatText(`${e.delta} ♥（好久不见）`, 'minus');
  } else if (e.type === 'stage-up') {
    flashUntil = performance.now() + 700;
    if (e.view) { view = e.view; applyArt(); refreshHud(); }
    fx.play('evolve', Fx.oneShotMs(isVideo(view.pet.speciesId), 'evolve'));
    fx.burst(12);
    showUnlockToast(e);
  }
}

// A stage-up names everything it unlocked, and stays until closed (or for half a minute). A kind with
// nothing new (e.g. outfits, for a character with only her signature one) is left out.
function showUnlockToast(e) {
  const a = (e.view || view).affection;
  const names = (list) => list.map((x) => `「${x.label}」`).join('、');
  $('unlock-toast').classList.remove('notice');
  $('toast-open').classList.remove('hidden');
  $('toast-title').textContent = `🎉 关系升级：${a.stageName}（♥${a.value}）`;
  const body = $('toast-body');
  body.innerHTML = '';
  for (const [k, list] of [['解锁话题', e.unlocks && e.unlocks.topics], ['解锁服饰', e.unlocks && e.unlocks.outfits]]) {
    if (!list || !list.length) continue;
    const line = document.createElement('div');
    line.innerHTML = '<b></b>';
    line.querySelector('b').textContent = `${k}：`;
    line.appendChild(document.createTextNode(names(list)));
    body.appendChild(line);
  }
  // the wardrobe and the topics live in the settings window: her page (衣柜) and 玩法 → 话题
  const outfits = !!(e.unlocks && e.unlocks.outfits && e.unlocks.outfits.length);
  $('toast-open').dataset.admin = outfits ? `characters/${(e.view || view).pet.characterId || (e.view || view).pet.speciesId}` : 'topics';
  $('toast-open').textContent = outfits ? '去衣柜看看' : '去聊聊新话题';
  $('unlock-toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 30000);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('unlock-toast').classList.add('hidden');
}

// 插个嘴 (core/interject.js): while a remark she made on her own is in the bubble, 别插嘴 / 说得好 sit on top of
// it. A click is the owner's explicit feedback on that decision (mute → a block rule, like → an allow rule).
// The row goes away with the bubble or as soon as anything else is shown there.
let ijDecision = null;
let ijDoneTimer = null;
function showInterjectFeedback(decisionId) {
  const b = $('bubble');
  if (!decisionId || b.classList.contains('hidden') || b.dataset.kind !== 'interject') return;
  ijDecision = decisionId;
  clearTimeout(ijDoneTimer);
  const row = $('ij-feedback');
  row.dataset.decision = decisionId;
  for (const btn of row.querySelectorAll('.ij-btn')) { btn.classList.remove('hidden'); btn.disabled = false; }
  row.querySelector('.ij-done').classList.add('hidden');
  row.classList.remove('hidden');
}
function hideInterjectFeedback() {
  ijDecision = null;
  clearTimeout(ijDoneTimer);
  $('ij-feedback').classList.add('hidden');
}
function bindInterjectFeedback() {
  const row = $('ij-feedback');
  row.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.ij-btn');
    if (!btn || !ijDecision) return;
    const id = ijDecision;
    for (const x of row.querySelectorAll('.ij-btn')) x.disabled = true;
    let r = null;
    try { r = await window.pet.interject.feedback(id, btn.dataset.ij); } catch { /* shown below */ }
    if (ijDecision !== id) return;
    const done = row.querySelector('.ij-done');
    done.textContent = !r || !r.ok ? '没记上，稍后再试' : btn.dataset.ij === 'mute' ? '好，这类话我不插嘴了' : '嘿嘿，记住啦';
    for (const x of row.querySelectorAll('.ij-btn')) x.classList.add('hidden');
    done.classList.remove('hidden');
    row.dataset.result = r && r.ok ? btn.dataset.ij : 'error';
    ijDoneTimer = setTimeout(hideInterjectFeedback, 2500);
  });
  // anything else in the bubble (or the bubble hiding) takes the row away
  new MutationObserver(() => {
    const b = $('bubble');
    if (ijDecision && (b.classList.contains('hidden') || b.dataset.kind !== 'interject' || b.dataset.stream)) hideInterjectFeedback();
  }).observe($('bubble'), { attributes: true, attributeFilter: ['class', 'data-kind', 'data-stream'] });
  window.pet.onInterject((e) => { if (e && e.type === 'said' && !VISITOR) showInterjectFeedback(e.decisionId); });
}

// `streamId`: this line is the final text of the reply that was being written into the bubble (流式回复):
// the bubble is corrected to it and the stream ends here.
function say(text, kind, source, reason, meme = null, streamId = null) {
  const b = $('bubble');
  if (streamId) endStream(streamId, true);
  if (bubbleEndsReading({ text, kind, source })) stopSpeech('bubble'); // the voice follows the bubble: another line there ends the reading
  clearTimeout(bubbleTimer);
  b.classList.remove('thinking', 'streaming');
  delete b.dataset.stream;
  delete b.dataset.streamEnd;
  b.classList.remove('hidden');
  b.textContent = text;
  // a meme picture (core/memes.js): a sticker beside her while the line is shown
  b.dataset.meme = meme ? meme.id : '';
  const st = $('meme-sticker');
  st.classList.toggle('hidden', !meme);
  if (meme) {
    st.src = meme.url;
    st.alt = meme.label;
    st.title = meme.label;
  }
  b.scrollTop = 0;
  b.dataset.kind = kind || '';
  b.dataset.source = source || '';
  b.dataset.reason = reason || '';
  delete b.dataset.speech;
  talkUntil = performance.now() + Math.min(4000, 400 + text.length * 90);
  // work status: a failed turn shows the pet upset for a moment instead of talking
  if (kind === 'error' && fx) { talkUntil = 0; fx.play('sad', Fx.oneShotMs(isVideo(view && view.pet.speciesId), 'sad')); }
  hideBubbleLater(Math.min(45000, 6000 + text.length * 150) + (meme ? 3000 : 0));
}
function hideBubbleLater(ms) {
  const b = $('bubble');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => (bubbleHold || (speaking() && b.dataset.speech === String(lastSpeech.n)) ? hideBubbleLater(3000) : (b.classList.add('hidden'), $('meme-sticker').classList.add('hidden'))), ms);
}

// 流式回复 (docs/streaming-ui.md): main sends the reply while it is written ('chat-delta': the text shown so
// far, guard-checked and with meme tags taken out, pet-service _openStream) and then the final line ('say'
// with streamId) and the end of the stream ('chat-done'). The bubble fills as pieces arrive, with a typing
// caret (.streaming) while she is still writing; the controls stay hidden and Esc / 停止 still work (busy).
// Only the newest stream is shown: pieces of a stream that already ended, or older than the last piece
// seen, are ignored. Reading aloud, the meme picture and 聊天记录 wait for the final line.
let stream = null; // { id, n, kind, turnId, text, withheld, at }
const endedStreams = new Set();
const streamLog = []; // every piece shown and every end, for the e2e runs (window.petFx.streamLog)
function logStream(e) {
  streamLog.push({ ...e, at: Math.round(performance.now()) });
  if (streamLog.length > 500) streamLog.shift();
}
function onChatDelta(d) {
  if (!d || !d.id || endedStreams.has(d.id)) return;
  if (!stream || stream.id !== d.id) {
    stream = { id: d.id, n: 0, kind: d.kind, turnId: d.turnId || null, text: '', withheld: false, at: performance.now() };
    if (bubbleEndsReading({ text: d.text, kind: d.kind, source: 'llm' })) stopSpeech('bubble');
  }
  if (d.n <= stream.n) return;
  Object.assign(stream, { n: d.n, text: d.withheld ? '' : String(d.text || ''), withheld: !!d.withheld });
  logStream({ ev: 'delta', id: d.id, n: d.n, len: [...stream.text].length, text: stream.text, withheld: stream.withheld });
  showStream();
}
function showStream() {
  const b = $('bubble');
  clearInterval(thinkTimer); // 思考中… gives way to her words
  clearTimeout(bubbleTimer);
  const atEnd = b.dataset.stream !== stream.id || b.scrollHeight - b.scrollTop - b.clientHeight < 8;
  b.classList.remove('thinking', 'hidden');
  b.classList.add('streaming');
  b.textContent = stream.withheld ? '……' : stream.text;
  b.dataset.stream = stream.id;
  delete b.dataset.streamEnd;
  b.dataset.kind = stream.kind || '';
  b.dataset.source = 'llm';
  b.dataset.reason = '';
  b.dataset.meme = '';
  delete b.dataset.speech;
  $('meme-sticker').classList.add('hidden');
  if (atEnd) b.scrollTop = b.scrollHeight; // follow the newest line unless the owner scrolled back to read
  talkUntil = performance.now() + 700; // her mouth moves while words keep coming
}
// The stream `id` ended: with its final line (ok) or without one (canceled, failed). Without one the
// bubble keeps what was shown, no longer typing, and hides like any line; the chat box's own answer
// ((好吧，不想了。), the error line) then takes the bubble as before.
function endStream(id, ok, reason = null) {
  if (!id || endedStreams.has(id)) return;
  endedStreams.add(id);
  if (endedStreams.size > 50) endedStreams.delete(endedStreams.values().next().value);
  const s = stream && stream.id === id ? stream : null;
  logStream({ ev: 'end', id, ok, reason, len: s ? [...s.text].length : 0 });
  if (s) stream = null;
  const b = $('bubble');
  if (b.dataset.stream !== id) return;
  b.classList.remove('streaming');
  delete b.dataset.stream;
  if (!ok) {
    b.dataset.streamEnd = reason || 'error';
    hideBubbleLater(Math.min(20000, 4000 + b.textContent.length * 100));
  }
}
function onChatDone(d) {
  if (!d || !d.id) return;
  const turnId = stream && stream.id === d.id ? stream.turnId : d.turnId;
  endStream(d.id, d.ok, d.reason);
}

// Read a line aloud when 朗读 is on: the agent's replies and lines sent through the local API, and with
// 互动语音 her interaction lines too (core/interaction-voice.js; automatic murmurs only with 朗读碎碎念).
// The engine chosen under 高级设置 → 语音 synthesises it in main (core/tts.js) in her own voice; without a
// key, offline, on a timeout or an error the line goes to the system voice (core/voice.js, her own pitch
// and pace) or stays silent. A line is read whole, sentence by sentence in order (Voice.sentences): the
// next sentence is fetched while this one plays, and the bubble marks the one being read. One reading at
// a time: a new line, a new message from the owner, 朗读 switched off or another line in the bubble stops
// it at once — but an interaction line is dropped instead while another line is still being said, or
// within 1.5 s of the last (SpeechGate), so rapid clicks never pile up and never cut a reply short.
const SPEAKING = /^(queued|synthesizing|speaking|playing)$/;
let lastSpeech = null;
let speechSeq = 0;
let speechAudio = null;
let speechWake = null; // ends the sentence being read (a stopped reading never gets its `ended`)
const speechLog = []; // what was read when, for the e2e runs (window.petFx.speechLog)
const speechGate = new IVoice.SpeechGate({ now: () => performance.now() });
const offerLog = []; // every line offered to the voice (said or dropped by the gate), for the e2e runs
const speaking = () => !!(lastSpeech && SPEAKING.test(lastSpeech.status));
// The tier of the line still being synthesised or read (-1: none), for the gate.
const speakingTier = () => (speaking() ? lastSpeech.tier : -1);
// Whether a new line in the bubble ends the reading: not an interaction line the gate would drop anyway.
function bubbleEndsReading(m) {
  if (!speaking()) return false;
  const c = IVoice.classify(m);
  return !(c && c.tier === 0 && settings && IVoice.shouldSpeak(m, settings.prefs));
}
function speechEvent(rec, i, event, extra = {}) {
  speechLog.push({ n: rec.n, i, event, text: i == null ? null : rec.sentences[i].text, at: Math.round(performance.now()), ...extra });
  if (speechLog.length > 300) speechLog.shift();
}
function haltAudio() {
  if (speechAudio) { speechAudio.pause(); URL.revokeObjectURL(speechAudio.src); speechAudio = null; }
  if (window.speechSynthesis) speechSynthesis.cancel();
}
function stopSpeech(why = 'interrupted') {
  speechSeq++;
  const rec = lastSpeech;
  if (rec && SPEAKING.test(rec.status)) {
    rec.status = 'interrupted';
    rec.stoppedBy = why;
    const s = rec.sentences[rec.current];
    if (s && SPEAKING.test(s.status)) s.status = 'interrupted';
    speechEvent(rec, rec.current, 'stop', { why });
  }
  haltAudio();
  window.pet.ttsCancel();
  if (speechWake) { const w = speechWake; speechWake = null; w(); }
  markReading(null);
}
// A line that arrives before her screen is up (初次见面, said while hatching) waits for enterPet().
let pendingSpeech = null;
async function speak(m) {
  if (!settings || !settings.prefs || !IVoice.shouldSpeak(m, settings.prefs)) return;
  if (!view) { pendingSpeech = { m, at: performance.now() }; return; }
  const c = IVoice.classify(m);
  // replies and milestones are read sentence by sentence; an interaction line or a murmur is short and
  // read whole, as it was synthesised ahead (prewarm caches whole lines)
  const parts = c.tier === 0 ? [{ raw: m.text, say: Voice.speakable(m.text) }] : Voice.sentences(m.text);
  const said = parts.filter((p) => p.say);
  if (!said.length) return;
  const g = speechGate.admit(c, speakingTier());
  const offer = { at: Math.round(performance.now()), kind: m.kind, cls: c.cls, interaction: c.interaction, text: said.map((p) => p.say).join(' '), said: g.ok, dropped: g.ok ? null : g.reason, n: null };
  offerLog.push(offer);
  if (offerLog.length > 200) offerLog.shift();
  if (!g.ok) return;
  stopSpeech('new-line');
  const seq = speechSeq;
  offer.n = seq;
  const tts = settings.tts || { provider: 'system', fallback: 'system' };
  const mood = IVoice.moodFor(m);
  const rec = {
    n: seq, at: performance.now(), text: offer.text, sentences: said.map((p, i) => ({ i, text: p.say, status: 'queued', provider: null })), current: 0,
    kind: m.kind, interaction: c.interaction, tier: c.tier, mood: mood === null ? view.status : mood,
    species: m.speciesId || view.pet.speciesId, engine: tts.provider, provider: null, cached: false, latencyMs: 0, fellBackFrom: [], status: 'queued',
  };
  lastSpeech = rec;
  speechEvent(rec, null, 'begin', { sentences: said.length });
  showSentences(rec, m.text, parts);
  let next = synthesize(rec, 0, tts);
  for (let i = 0; i < said.length; i++) {
    if (tts.provider !== 'system' && !/^(playing|speaking)$/.test(rec.status)) rec.status = 'synthesizing';
    const r = await next;
    if (seq !== speechSeq) return;
    if (r.reason === 'interrupted') { rec.status = 'interrupted'; markReading(null); return; } // another window took the engine
    next = i + 1 < said.length ? synthesize(rec, i + 1, tts) : null; // the next sentence is fetched while this one is read
    await readSentence(rec, i, r);
    if (seq !== speechSeq) return;
  }
  rec.status = rec.sentences.every((s) => s.status === 'silent') ? 'silent' : 'done';
  speechEvent(rec, null, 'end', { status: rec.status });
  markReading(null);
}
// The audio for sentence i (or what to do instead: the system voice, silence).
async function synthesize(rec, i, tts) {
  const s = rec.sentences[i];
  if (tts.provider === 'system') return { ok: false, next: 'system', fellBackFrom: [] };
  s.status = 'synthesizing';
  const r = navigator.onLine === false
    ? { ok: false, fallback: tts.fallback, fellBackFrom: [{ provider: tts.provider, reason: 'offline' }] }
    : await window.pet.ttsSynthesize(s.text, rec.mood).catch((e) => ({ ok: false, fallback: tts.fallback, fellBackFrom: [{ provider: tts.provider, reason: `ipc: ${e.message}` }] }));
  if (!r.ok && r.reason !== 'interrupted' && r.next !== 'system' && r.fallback === 'silent') r.silent = true;
  Object.assign(s, { fellBackFrom: r.fellBackFrom || [], latencyMs: r.latencyMs || 0, status: 'queued' });
  return r;
}
// Read one sentence; resolves when it has been read, failed, or the reading was stopped.
function readSentence(rec, i, r) {
  const s = rec.sentences[i];
  rec.current = i;
  Object.assign(rec, { fellBackFrom: r.fellBackFrom || [], latencyMs: r.latencyMs || 0 });
  return new Promise((resolve) => {
    let guard = null;
    const end = (status) => {
      if (speechWake !== resolve) return;
      speechWake = null;
      clearTimeout(guard);
      s.status = status;
      speechEvent(rec, i, 'done', { status });
      resolve();
    };
    speechWake = resolve;
    speechEvent(rec, i, 'start', { provider: r.ok ? r.provider : r.silent ? null : 'system', cached: !!r.cached });
    markReading(rec, i);
    if (r.silent) { Object.assign(rec, { provider: null, status: 'silent' }); s.provider = null; return end('silent'); }
    // a voice that never reports its end (no system voice on this box, a stuck player) does not hold the rest up
    guard = setTimeout(() => end('timeout'), 4000 + [...s.text].length * 600);
    if (r.ok) playAudio(rec, s, r, end);
    else speakSystem(rec, s, end);
  });
}
// 拖拽 / 甩出 / 接住 have no line from main: she says one of hers (voice.lines in her file), in the
// bubble and aloud, only with 朗读 and 互动语音 on, and at most once every few seconds per kind.
const LOCAL_LINE_GAP_MS = 4000;
const localLineAt = {};
function localLine(kind) {
  const p = settings && settings.prefs;
  if (VISITOR || !IVoice.voiceOn(p) || p.voiceInteractions === false || !view || thinking) return;
  const now = performance.now();
  if (now - (localLineAt[kind] || -Infinity) < LOCAL_LINE_GAP_MS) return;
  localLineAt[kind] = now;
  const pool = IVoice.localLines(speciesOf(view.pet.speciesId), kind);
  if (!pool.length) return;
  const text = pool[Math.floor(Math.random() * pool.length)];
  say(text, kind, 'fallback');
  speak({ text, source: 'fallback', kind });
}
// Her common short lines are synthesised ahead (main.js tts-prewarm) whenever what they depend on
// changes: 朗读 / 互动语音 switched on, the engine or its key, her character, her 语音包 or relationship stage.
let prewarmSig = null;
let prewarmTimer = null;
let lastPrewarm = null;
function syncPrewarm() {
  const p = settings && settings.prefs;
  if (!IVoice.voiceOn(p) || p.voiceInteractions === false || !view || !view.pet || VISITOR) { prewarmSig = null; return; }
  const t = settings.tts || {};
  const keys = settings.ttsStatus ? Object.entries(settings.ttsStatus.engines).map(([id, e]) => `${id}:${e.hasKey}:${e.ready}`).join(',') : '';
  // the 语音包 picked for her (set-voice-pack): another pack means other recorded lines and maybe another voice
  const pick = `${(t.voicePackByCharacter || {})[view.pet.speciesId] || 'auto'}/${t.voicePack || 'auto'}`; // hers / 我的语音包
  const sig = [t.provider, t.fallback, JSON.stringify(t.endpoints || {}), JSON.stringify(t.local || {}), keys, view.pet.speciesId, pick, view.pet.relStage, p.touchZones, settings.adultContent].join('|');
  if (sig === prewarmSig) return;
  prewarmSig = sig;
  clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(async () => {
    const t0 = performance.now();
    lastPrewarm = { sig, status: 'running' };
    const r = await window.pet.ttsPrewarm().catch((e) => ({ failed: `ipc: ${e.message}` }));
    if (lastPrewarm && lastPrewarm.sig === sig) lastPrewarm = { sig, status: 'done', ms: Math.round(performance.now() - t0), ...r };
  }, 400);
}
function playAudio(rec, s, r, end) {
  Object.assign(s, { provider: r.provider, cached: r.cached, status: 'playing' });
  Object.assign(rec, { provider: r.provider, voiceId: r.voiceId, model: r.model, cached: r.cached, mime: r.mime, bytes: r.audio.byteLength, status: 'playing' });
  const a = new Audio(URL.createObjectURL(new Blob([r.audio], { type: r.mime })));
  speechAudio = a;
  if (window.PetVRM && window.PetVRM.active()) window.PetVRM.lip.attach(a); // a VRM figure's mouth follows the voice
  a.onplaying = () => { rec.started = s.started = true; talkFor(Number.isFinite(a.duration) ? a.duration * 1000 : 0, s.text); };
  a.onended = () => { if (speechAudio === a) haltAudio(); end('done'); };
  a.onerror = () => end(`error: ${a.error ? a.error.code : '?'}`);
  a.play().catch((e) => end(`error: ${e.name}`));
}
// The last provider of the chain: Web Speech (core/voice.js webSpeech) with her own pitch and pace.
function speakSystem(rec, s, end) {
  rec.provider = s.provider = 'system';
  const env = { speechSynthesis: window.speechSynthesis, SpeechSynthesisUtterance: window.SpeechSynthesisUtterance };
  if (!Voice.webSpeech.available(env)) { rec.status = 'silent'; return end('silent'); }
  const v = Voice.webSpeech.config(speciesOf(rec.species).voice);
  Object.assign(rec, { lang: v.lang, pitch: v.pitch, rate: v.rate, status: 'queued' });
  Object.assign(rec, Voice.webSpeech.speak(s.text, v, env, {
    start: () => { rec.status = s.status = 'speaking'; talkFor(0, s.text); },
    end: () => end('done'),
    error: (e) => end(`error: ${e}`),
  }));
}
// Her mouth moves while a sentence is read.
function talkFor(ms, text) { talkUntil = Math.max(talkUntil, performance.now() + Math.min(30000, ms || [...text].length * 220)); }
// The bubble as sentences while it is read: the reply is still shown whole, the sentence being read is
// marked and scrolled into view. Only when the bubble still shows this reply (say() put it there).
function showSentences(rec, text, parts) {
  const b = $('bubble');
  if (b.classList.contains('hidden') || b.textContent !== text) return;
  b.textContent = '';
  let i = 0;
  for (const p of parts) {
    if (!p.say) { b.appendChild(document.createTextNode(p.raw)); continue; }
    const el = document.createElement('span');
    el.className = 'sentence';
    el.dataset.i = i++;
    el.textContent = p.raw;
    b.appendChild(el);
  }
  b.dataset.speech = rec.n;
}
function markReading(rec, i) {
  const b = $('bubble');
  for (const el of b.querySelectorAll('.sentence.reading')) el.classList.remove('reading');
  if (!rec || b.dataset.speech !== String(rec.n)) return;
  const el = b.querySelector(`.sentence[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('reading');
  const br = b.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (er.top < br.top || er.bottom > br.bottom) b.scrollTop += er.top - br.top - 4;
}

function setThinking(on) {
  thinking = on;
  document.body.classList.toggle('busy', on);
  clearInterval(thinkTimer);
  const b = $('bubble');
  if (on) {
    // nothing but the pet and this bubble while it works; controls come back when it is done
    $('food-menu').classList.add('hidden');
    closeDanceMenu();
    clearTimeout(bubbleTimer);
    $('meme-sticker').classList.add('hidden');
    b.classList.remove('hidden');
    b.classList.add('thinking');
    let n = 0;
    const tick = () => { b.textContent = `${arriving ? `${arriving}正在赶来` : '思考中'}${'.'.repeat((n++ % 3) + 1)}`; };
    tick();
    thinkTimer = setInterval(tick, 450);
  }
  syncHover();
}

// Tell the owner what actually went wrong instead of blaming "the network" for everything.
function errorLine(r) {
  if (r.code === 'ETIMEDOUT') return '（我想了好久也没想出来……LobeHub 现在好像很慢，晚点再说一次？）';
  if (r.code === 'EAUTH') return '（LobeHub 登录好像过期了，需要重新 lh login）';
  if (r.code === 'ECLI') return '（lh 版本和应用对不上，试试 lh update，或升级桌宠）';
  if (r.code === 'ENOENT') return '（找不到 lh 命令，请先 npm install -g @lobehub/cli）';
  if (r.code === 'ENOREPLY') return '（我走神了，没想出要说什么……再说一次？）';
  return `（出错了：${String(r.message || '未知错误').slice(0, 70)}）`;
}

async function doAct(kind, food) {
  if (thinking) return;
  // 喂食 / 玩耍 / 睡觉 are a new order for her body: the dance stops first (docs/vrm-dance.md §3.4)
  if (dance && dance.active()) dance.stop({ reason: kind });
  const r = await window.pet.act(kind, food);
  const video = isVideo(view && view.pet.speciesId);
  if (kind === 'feed' && r.ok) {
    eating = FOOD_SPRITE[food] || 'rice';
    setTimeout(() => { eating = null; }, Fx.oneShotMs(video, 'eat'));
  }
  if (r.ok) {
    if (kind === 'pat') fx.click(video);
    if (kind === 'play') { plays++; fx.play('play', Fx.oneShotMs(video, 'play')); }
  }
}

// ---------- 重置姿势 (T-2830, docs/usage.md) ----------
// The toolbar's ↺ (a VRM look), Ctrl/⌘+Shift+R in her window, 托盘 → 重置姿势 and the local API POST /reset-pose
// all go through main (main.js resetPose: asleep, she wakes up there first), which then asks this window
// (api-cmd 'reset-pose'): the app's own holds end here — the dance stops (its usual fade), the meal and a play /
// cue one-shot are cleared, a stuck lift let go, a walk stopped — and every VRM figure resets its director (the
// T-2829 action states: … → returning → idle, every layer fading out by its own fade). A reply being thought or
// read keeps its pose: that is not stuck. Already idle: nothing changes. → what she was doing, what was ended.
function resetPose(source = 'button') {
  const figs = [...rigs].filter((r) => r.kind === 'vrm' && r.figure.resetToIdle);
  const before = figs.map((r) => { const p = r.figure.plan(); return p && p.action ? p.action.state : null; });
  const cleared = [];
  if (dance && dance.active()) { dance.stop({ reason: 'reset' }); cleared.push('dance'); }
  if (eating) { eating = null; cleared.push('eat'); }
  if (fx.current(performance.now())) { fx.clear(); cleared.push('one-shot'); }
  if (fx.lifted) { fx.setLifted(false); cleared.push('lift'); }
  if (fx.walking) { fx.stopWalk(); cleared.push('walk'); }
  if (talkUntil > performance.now() && !voiceNow()) { talkUntil = 0; cleared.push('talk'); } // a line's lip flap (the bubble stays); a voice playing keeps hers
  const figures = figs.map((r) => r.figure.resetToIdle(`reset:${source}`));
  syncDanceButton();
  lastReset = { at: Date.now(), source, before, cleared, figures };
  return { ok: true, source, before, cleared, figures };
}
let lastReset = null;
// the ↺ button: shown for a VRM look only (the pixel and Live2D looks have no pose to get stuck in)
function syncResetButton() {
  const b = $('btn-reset');
  const show = !!(view && view.look && view.look.kind === 'vrm');
  if (b.classList.contains('hidden') === show) b.classList.toggle('hidden', !show);
}

function buildFoodMenu() {
  const m = $('food-menu');
  m.innerHTML = '';
  for (const [id, f] of Object.entries(info.foods)) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = f.label;
    b.addEventListener('click', () => { m.classList.add('hidden'); doAct('feed', id); });
    m.appendChild(b);
  }
}

// ---------- 跳舞 (docs/vrm-dance.md §6.2 L2 / L4, §6.3) ----------
// The toolbar's 跳舞 button (a VRM look only) and its menu: what she is dancing (progress, 循环播放, 停止), the
// dances (cover, name, length, 无音乐), and a way to the settings window's 舞蹈 page. One click on a row dances it.
const DANCE_ROWS = 6; // more than this: the most recent ones and 全部舞蹈…
const ICO_MUSIC = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
const ICO_STOP = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="5" y="5" rx="2"/></svg>';
const ICO_LOOP = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>';
const danceRecent = []; // ids, most recently danced first (this session)
let danceLoading = null; // the id whose clip / music is loading
let danceMenuTimer = null;
const mmss = (s) => { const t = Math.max(0, Math.round(s || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const canDanceNow = () => !!(view && view.look && view.look.kind === 'vrm');
function danceCover(d, size) {
  const el = document.createElement('span');
  el.className = `dance-cover s${size}`;
  if (d && d.cover) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = `vrmlib://dance/${d.cover}`;
    img.addEventListener('error', () => { el.innerHTML = ICO_MUSIC; }, { once: true });
    el.appendChild(img);
  } else el.innerHTML = ICO_MUSIC;
  return el;
}
function closeDanceMenu() {
  $('dance-menu').classList.add('hidden');
  clearInterval(danceMenuTimer);
  danceMenuTimer = null;
}
async function openDanceMenu() {
  const m = $('dance-menu');
  if (!m.classList.contains('hidden')) return closeDanceMenu();
  $('food-menu').classList.add('hidden');
  m.classList.remove('hidden');
  await renderDanceMenu();
  const first = m.querySelector('[role="menuitem"]:not([disabled])');
  if (first) first.focus({ preventScroll: true });
  clearInterval(danceMenuTimer);
  danceMenuTimer = setInterval(updateDanceNow, 250);
}
async function renderDanceMenu() {
  const m = $('dance-menu');
  const all = dance ? await dance.list() : [];
  const st = dance ? dance.state() : null;
  m.innerHTML = '';
  if (st) {
    const now = document.createElement('div');
    now.className = 'dance-now';
    now.dataset.danceNow = st.id;
    const entry = all.find((d) => d.id === st.id);
    now.appendChild(danceCover(entry, 24));
    const txt = document.createElement('div');
    txt.className = 'dance-now-text';
    txt.innerHTML = '<b></b><small class="dance-progress"></small>';
    txt.querySelector('b').textContent = `正在跳《${st.name}》`;
    txt.title = st.name;
    now.appendChild(txt);
    const loop = document.createElement('button');
    loop.className = 'btn icon-btn dance-loop';
    loop.setAttribute('role', 'menuitemcheckbox');
    loop.setAttribute('aria-label', '循环播放');
    loop.title = '循环播放';
    loop.innerHTML = ICO_LOOP;
    loop.addEventListener('click', () => { const cur = dance.state(); if (cur) dance.setLoop(!cur.loop); updateDanceNow(); });
    const stop = document.createElement('button');
    stop.className = 'btn dance-stop';
    stop.setAttribute('role', 'menuitem');
    stop.innerHTML = `${ICO_STOP}停止`;
    stop.addEventListener('click', () => { dance.stop({ reason: 'menu' }); closeDanceMenu(); syncDanceButton(); });
    now.append(loop, stop);
    m.appendChild(now);
  }
  const own = all.filter((d) => !d.builtin).sort((a, b) => (danceRecent.indexOf(a.id) + 1 || 1e9) - (danceRecent.indexOf(b.id) + 1 || 1e9));
  const rows = [...own.slice(0, DANCE_ROWS - 1), ...all.filter((d) => d.builtin)];
  const list = document.createElement('div');
  list.className = 'dance-list';
  for (const d of rows) {
    const b = document.createElement('button');
    b.className = 'btn dance-row';
    b.setAttribute('role', 'menuitem');
    b.dataset.dance = d.id;
    b.title = d.name;
    b.appendChild(danceCover(d, 32));
    const name = document.createElement('span');
    name.className = 'dance-name';
    name.textContent = d.name;
    const meta = document.createElement('small');
    meta.className = 'dance-meta';
    // with music: ♪ before the length; without: 无音乐 (in words, not only an icon or a colour)
    if (st && st.id === d.id) meta.textContent = '正在跳';
    else if (danceLoading === d.id) meta.textContent = '准备中…';
    else if (d.audio) { meta.innerHTML = `${ICO_MUSIC}<span></span>`; meta.querySelector('span').textContent = mmss(d.duration); meta.setAttribute('aria-label', `有音乐，${mmss(d.duration)}`); meta.title = '有音乐'; }
    else meta.textContent = `无音乐 · ${mmss(d.duration)}`;
    b.append(name, meta);
    if (danceLoading === d.id) b.classList.add('loading');
    b.addEventListener('click', () => startDance(d));
    list.appendChild(b);
  }
  m.appendChild(list);
  const more = document.createElement('button');
  more.className = 'btn dance-more';
  more.setAttribute('role', 'menuitem');
  more.textContent = !own.length ? '导入更多舞蹈…' : own.length > DANCE_ROWS - 1 ? `全部舞蹈（${own.length + 1}）…` : '管理舞蹈…';
  more.addEventListener('click', () => { closeDanceMenu(); openSettings('dances'); });
  m.appendChild(more);
  updateDanceNow();
}
function updateDanceNow() {
  const m = $('dance-menu');
  const st = dance ? dance.state() : null;
  const box = m.querySelector('.dance-now');
  if (!!st !== !!box || (st && box && box.dataset.danceNow !== st.id)) { renderDanceMenu(); return; }
  if (!st) return;
  box.querySelector('.dance-progress').textContent = `${mmss(st.t)} / ${mmss(st.duration)}${st.paused ? ' · 暂停中' : ''}${st.music ? '' : ' · 无音乐'}`;
  const loop = box.querySelector('.dance-loop');
  loop.setAttribute('aria-checked', String(!!st.loop));
  loop.setAttribute('aria-pressed', String(!!st.loop));
  loop.title = st.loop ? '循环播放：开（点一下关闭）' : '循环播放：关（点一下打开）';
}
// 聊天里说「跳个舞」/「跳一下节拍摇摆」/「别跳了」(core/dance-intent.js): recognised locally, never by the model
let danceRefusedAt = 0;
async function chatDanceIntent(text) {
  if (!window.PetDanceIntent || !dance) return;
  const dancing = dance.active();
  const all = canDanceNow() ? await dance.list() : [];
  const m = window.PetDanceIntent.matchDanceIntent(text, all, { dancing });
  if (!m) return;
  if (m.action === 'stop') { dance.stop({ reason: 'chat' }); syncDanceButton(); return; }
  if (!canDanceNow()) {
    // a look that cannot dance: one local line, not again within 10 minutes
    if (Date.now() - danceRefusedAt > 10 * 60 * 1000) { danceRefusedAt = Date.now(); say('我现在这个样子跳不了舞……换成 VRM 模型再来吧。', 'fallback', 'fallback'); }
    return;
  }
  const d = (m.id && all.find((x) => x.id === m.id)) || window.PetDanceIntent.pickOther(all, danceRecent);
  if (d) await startDance(d);
}
async function startDance(d) {
  if (!dance || danceLoading) return;
  danceLoading = d.id;
  syncDanceButton();
  renderDanceMenu();
  let r;
  try { r = await dance.play({ id: d.id }); } finally { danceLoading = null; }
  if (r && r.ok) {
    const i = danceRecent.indexOf(d.id);
    if (i >= 0) danceRecent.splice(i, 1);
    danceRecent.unshift(d.id);
    closeDanceMenu();
  } else if (r && r.reason !== 'cancelled') {
    closeDanceMenu();
    showNotice('没能跳舞', r.reason === 'load-failed' ? `《${d.name}》没能载入，可能文件被删了。到 设置 → 舞蹈 重新导入。` : r.message || '她现在跳不了，稍后再试。', { label: '打开舞蹈设置', admin: 'dances' });
  }
  syncDanceButton();
}
// the button: shown for a VRM look only; pressed while she dances; spinning while a dance loads
function syncDanceButton() {
  const b = $('btn-dance');
  const show = canDanceNow();
  if (b.classList.contains('hidden') === show) b.classList.toggle('hidden', !show);
  if (!show && !$('dance-menu').classList.contains('hidden')) closeDanceMenu();
  const st = dance && dance.active() ? dance.state() : null;
  const pressed = String(!!st);
  if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
  const title = danceLoading ? '正在准备舞蹈…' : st ? `正在跳《${st.name}》，点一下可以停止或换一支` : '跳舞';
  if (b.title !== title) b.title = title;
  b.classList.toggle('loading', !!danceLoading);
  b.disabled = !!danceLoading;
}
function bindDanceMenu() {
  const m = $('dance-menu');
  m.addEventListener('keydown', (e) => {
    const items = [...m.querySelectorAll('[role^="menuitem"]:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length ? items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length] : null;
      if (n) n.focus();
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // Esc closes the menu here; it does not stop the dance
      closeDanceMenu();
      $('btn-dance').focus();
    }
  });
}

function bindPetUi() {
  buildFoodMenu();
  bindDanceMenu();
  $('toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('[data-act]');
    const act = btn && btn.dataset.act;
    if (!act) return;
    if (act !== 'feed') $('food-menu').classList.add('hidden');
    if (act !== 'dance') closeDanceMenu();
    if (act === 'dance') openDanceMenu();
    else if (act === 'feed') $('food-menu').classList.toggle('hidden');
    else if (act === 'play' || act === 'sleep') doAct(act);
    else if (act === 'chat') {
      $('chat-row').classList.toggle('hidden');
      if (!$('chat-row').classList.contains('hidden')) $('chat-input').focus();
    } else if (act === 'settings') openSettings();
    else if (act === 'mute') toggleMute();
    else if (act === 'reset') window.pet.resetPose('button');
    else if (act === 'quit') window.pet.quit();
  });
  const send = async () => {
    const input = $('chat-input');
    const text = input.value.trim();
    // 「别跳了」 while she is still thinking about the last message: the dance part still happens
    if (thinking && text && !attachments.length && window.PetDanceIntent && window.PetDanceIntent.matchDanceIntent(text, [], { dancing: !!(dance && dance.active()) })) { input.value = ''; chatDanceIntent(text); return; }
    if ((!text && attachments.length === 0) || thinking) return;
    const imgs = attachments.filter((a) => a.kind === 'image');
    const files = attachments.filter((a) => a.kind === 'path').map((a) => a.path);
    if (files.length && !(view && view.local && view.local.enabled)) {
      if (!confirm('读本机文件需要先开启“本机能力”（让宠物使用这台电脑）。现在开启吗？')) return;
      const on = await window.pet.setLocal(true);
      if (!on.ok) { say(`（没能开启本机能力：${String(on.message || '未知原因').slice(0, 60)}）`, 'error', 'fallback', on.message); return; }
    }
    stopSpeech('new-message'); // she stops reading the last reply as soon as the owner says something
    if (text && !imgs.length && !files.length) chatDanceIntent(text); // 「跳个舞」/「别跳了」: local, the message still goes to her agent
    attachments = [];
    renderAttachments();
    input.value = '';
    $('chat-send').disabled = true;
    const r = await window.pet.chat(text, imgs, files);
    $('chat-send').disabled = false;
    if (!r.ok && r.reason === 'error') say(errorLine(r), 'error', 'error', r.message);
    if (!r.ok && r.reason === 'local-error') say(`（这台电脑现在连不上，读不了文件：${String(r.message || '').slice(0, 60)}）`, 'error', 'fallback', r.message);
    if (!r.ok && r.reason === 'local-off') say('（要先开启本机能力才能读文件。）', 'error', 'fallback');
    if (!r.ok && r.reason === 'canceled') say('（好吧，不想了。）', 'canceled', 'fallback');
    if (!r.ok && r.reason === 'busy') say('等等，我还在想上一句……', 'busy');
  };
  $('chat-send').addEventListener('click', send);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  // 插个嘴 source 聊天框: the unsent draft goes to main (debounced there) only while 插个嘴 and this source are on.
  // Only this box: nothing typed anywhere else is seen.
  $('chat-input').addEventListener('input', () => {
    const ij = settings && settings.interject;
    if (VISITOR || !ij || !ij.enabled || !ij.sources || !ij.sources.chatDraft) return;
    window.pet.interject.draft($('chat-input').value);
  });

  // ---- pictures: paste (Ctrl/⌘+V), drag in, or the 📎 button; Escape stops a running task
  document.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length || $('pet-screen').classList.contains('hidden') || !pointerInside) return; // hover the pet first
    e.preventDefault();
    if (thinking) return;
    openChat();
    routeFiles(files);
  });
  document.addEventListener('dragover', (e) => { if ([...(e.dataTransfer ? e.dataTransfer.types : [])].includes('Files')) { e.preventDefault(); document.body.classList.add('dragging-file'); } });
  document.addEventListener('dragleave', () => document.body.classList.remove('dragging-file'));
  document.addEventListener('drop', (e) => {
    document.body.classList.remove('dragging-file');
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length || thinking || $('pet-screen').classList.contains('hidden')) return;
    e.preventDefault();
    openChat();
    routeFiles(files);
  });
  $('attach-btn').addEventListener('click', async () => {
    const picked = await window.pet.pickImages();
    for (const img of picked) pushAttachment({ kind: 'image', ...img });
  });
  bindMic();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && thinking) window.pet.cancel(); else if (e.key === 'Escape' && dance && dance.active()) dance.stop({ reason: 'esc' }); });
  $('stop-btn').addEventListener('click', () => { if (thinking) window.pet.cancel(); });
  // 重置姿势 Ctrl/⌘+Shift+R: main catches it first (before-input-event, which also keeps Electron's force reload
  // off it); a key event main did not see (synthetic input) lands here
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyR' || !e.shiftKey || e.altKey || !(navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey)) return;
    e.preventDefault();
    window.pet.resetPose('key');
  });
  bindInterjectFeedback();
  $('bubble').addEventListener('mouseenter', () => { bubbleHold = true; });
  $('bubble').addEventListener('mouseleave', () => { bubbleHold = false; });

  // a right click (or a long press on a touch screen) on her opens the settings window, as ⚙ does: there is
  // no menu in the pet window any more
  bindPetPointer({ onClick: touchAt, onMenu: () => openSettings() });
  bindTouchHint();
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest || !e.target.closest('.pet-hit')) return;
    e.preventDefault();
    openSettings();
  });
}

// Mouse, pen and touch on the pet (pointer events; dsh-pet drag.ts, drag-release.ts, touch-press.ts):
// - a press without moving is a click (`onClick`, given the pointerup event: where it landed);
// - drag it and it is lifted; let go while moving fast and it is thrown (gravity, bounces off the
//   screen edges); let go slowly and it is just put down;
// - press twice quickly, pull and let go: the slingshot launches it the opposite way of the pull;
// - press it while it flies: caught, with a score for a fast one;
// - touch: a long press held still opens the settings window (`onMenu`), like a right click.
function bindPetPointer({ onClick, onMenu }) {
  let drag = null;
  let lastPressAt = null;
  const end = (e, cancel) => {
    const d = drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    drag = null;
    clearTimeout(d.press);
    fx.setLifted(false);
    if (cancel || d.menu) return;
    if (!d.moved) return d.caught ? null : onClick(e);
    if (d.sling) {
      const box = petHitBox();
      const v = Fx.slingshotVelocity(d.x - d.x0, d.y - d.y0, box ? box.w : 150);
      if (Fx.isThrow(v)) { throwPet(v); localLine('throw'); }
      return;
    }
    const v = Fx.releaseVelocity(d.samples, performance.now());
    if (Fx.isThrow(v)) { throwPet(v); localLine('throw'); }
  };
  for (const el of document.querySelectorAll('.pet-hit')) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const now = performance.now();
      const caught = fx.flying ? fx.catchScore() : 0;
      fx.stopThrow();
      fx.stopWalk();
      const sling = !caught && Fx.isSlingshot(lastPressAt, now);
      lastPressAt = now;
      drag = { id: e.pointerId, type: e.pointerType, x0: e.screenX, y0: e.screenY, x: e.screenX, y: e.screenY, moved: false, caught, sling, travel: 0, samples: [{ x: e.screenX, y: e.screenY, t: now }] };
      if (caught) { fx.play('happy', Fx.oneShotMs(isVideo(view && view.pet.speciesId), 'happy')); localLine('catch'); }
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capture */ }
      if (e.pointerType === 'touch') {
        const d = drag;
        d.press = setTimeout(() => {
          if (drag === d && Fx.isLongPress(performance.now() - now, d.travel)) { d.menu = true; drag = null; onMenu(); }
        }, Fx.LONG_PRESS.ms);
      }
    });
  }
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    drag.travel += Math.abs(dx) + Math.abs(dy);
    if (!drag.moved && drag.travel > (drag.type === 'touch' ? Fx.LONG_PRESS.slop : 3)) { drag.moved = true; localLine('lift'); }
    if (drag.moved) {
      clearTimeout(drag.press);
      fx.setLifted(true);
      window.pet.moveBy(dx, dy);
      drag.x = e.screenX;
      drag.y = e.screenY;
      drag.samples.push({ x: e.screenX, y: e.screenY, t: performance.now() });
      if (drag.samples.length > 12) drag.samples.shift();
    }
  });
  window.addEventListener('pointerup', (e) => end(e, false));
  window.addEventListener('pointercancel', (e) => end(e, true));
}

// Behaviour switches for the effects layer.
// fx.js reads prefs through this (and stays as it is for pixel characters): 静音 silences the click sound too
function petPrefs() {
  const p = (settings && settings.prefs) || {};
  return p.muted === true ? { ...p, clickSound: false } : p;
}

// Where the character is drawn in the window (for knocking into other pets): its art, not the whole window.
function petHitBox() {
  const el = isVideo(view && view.pet.speciesId) ? $('vwrap') : $('char-wrap');
  const r = el && el.getBoundingClientRect();
  if (!r || !r.width) return null;
  return { x: Math.round(r.left + r.width * 0.15), y: Math.round(r.top + r.height * 0.1), w: Math.round(r.width * 0.7), h: Math.round(r.height * 0.9) };
}

// ---------- touching a body part (部位触摸, src/core/touch-zones.js) ----------
// A click is mapped onto her art as the core's hit test wants it: x, y in 0..1 of the visible box (the
// bounding box of the opaque pixels of what is drawn right now), plus whether the pixel under the
// pointer is opaque (sheets come over pack:// with CORS, so the page may read them). Works for the
// sprite canvas or picture (object-fit: contain in .char) and for Dafeiyu's clip (cropped by .vwrap),
// mirrored when she faces left, at any pet size.
const TZ = window.PetTouchZones;
const touchOn = () => !settings || !settings.prefs || settings.prefs.touchZones !== false;
const ALPHA_MIN = 24; // a pixel this opaque counts as her
const SAMPLE_W = 320; // a clip frame is read scaled down to this width
const NEAR_PX = 6; // a click this close to her (screen px) still counts: thin parts (a tail) move

// The element her art is drawn in and its source size, or null while nothing is drawn yet.
function artSource() {
  if (isVideo(view && view.pet.speciesId)) {
    const v = $('pet-video');
    return v.videoWidth ? { el: v, w: v.videoWidth, h: v.videoHeight, video: true } : null;
  }
  const el = $('pet-look').firstElementChild;
  if (el && el.tagName === 'CANVAS') return { el, w: el.width, h: el.height, video: false };
  if (el && el.tagName === 'IMG' && el.naturalWidth) return { el, w: el.naturalWidth, h: el.naturalHeight, video: false };
  return null;
}

// The alpha of the drawn frame and its opaque bounding box (source px); null if it cannot be read.
// Kept for the frame on screen, so hovering and clicking read the pixels once per frame.
let alphaCache = { key: null, map: null };
function alphaMap(a) {
  const key = a.video ? `${a.el.currentSrc}@${a.el.currentTime}` : a.el.tagName === 'CANVAS' ? a.el.dataset.frame : a.el.src;
  if (key && alphaCache.key === key) return alphaCache.map;
  const map = readAlpha(a);
  alphaCache = { key, map };
  return map;
}
function readAlpha(a) {
  const k = Math.min(1, SAMPLE_W / a.w);
  const w = Math.max(1, Math.round(a.w * k));
  const h = Math.max(1, Math.round(a.h * k));
  let data;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(a.el, 0, 0, w, h);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // a tainted picture: treat the whole frame as her
  }
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < ALPHA_MIN) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const opaqueAt = (px, py, rSrc) => {
    const cx = Math.floor(px * k);
    const cy = Math.floor(py * k);
    const r = Math.max(1, Math.ceil(rSrc * k));
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= ALPHA_MIN) return true;
    return false;
  };
  return { box: { x0: x0 / k, y0: y0 / k, x1: (x1 + 1) / k, y1: (y1 + 1) / k }, opaqueAt };
}

// Where client point (cx, cy) lands on her art: { x, y, opaque, pose, box } with `box` the visible
// box on screen (client px, for placing the reaction), or null when she is not drawn.
function artPoint(cx, cy) {
  const a = artSource();
  if (!a) return null;
  const r = a.el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const fit = Math.min(r.width / a.w, r.height / a.h); // object-fit: contain, centred
  const ox = r.left + (r.width - a.w * fit) / 2;
  const oy = r.top + (r.height - a.h * fit) / 2;
  const mirrored = $('pet-body').dataset.facing === 'left';
  const px = mirrored ? a.w - (cx - ox) / fit : (cx - ox) / fit;
  const py = (cy - oy) / fit;
  const m = alphaMap(a);
  // a clip from file:// cannot be read back: her box in the frame comes from her file (touch.videoBox)
  const vb = !m && a.video && (speciesOf(view.pet.speciesId).touch || {}).videoBox;
  const b = m ? m.box : vb ? { x0: vb[0] * a.w, y0: vb[1] * a.h, x1: vb[2] * a.w, y1: vb[3] * a.h } : { x0: 0, y0: 0, x1: a.w, y1: a.h };
  const sx = (v) => (mirrored ? ox + (a.w - v) * fit : ox + v * fit);
  const box = { left: Math.min(sx(b.x0), sx(b.x1)), right: Math.max(sx(b.x0), sx(b.x1)), top: oy + b.y0 * fit, bottom: oy + b.y1 * fit };
  const pose = a.video ? 'video' : $('pet-body').dataset.action || null;
  // 半身 (a VRM / Live2D figure or a pixel sprite framed head to waist): the visible box is the top `cut` of her, so the touch zones (written for
  // head-to-feet art) get y in her full-body proportions; legs and feet are below the picture, out of reach
  const half = a.el.dataset && a.el.dataset.framing === 'half' ? { mode: 'half', cut: Number(a.el.dataset.cut) } : null;
  const y = (py - b.y0) / (b.y1 - b.y0);
  return { x: (px - b.x0) / (b.x1 - b.x0), y: half ? PF.toFullBody({ y }, half).y : y, framing: half ? 'half' : 'full', opaque: m ? m.opaqueAt(px, py, NEAR_PX / fit) : true, pose, box, mirrored };
}

// The VRM figure drawn as her look right now, or null.
function vrmFigure() {
  const el = $('pet-look').firstElementChild;
  for (const r of rigs) if (r.kind === 'vrm' && r.canvas === el && r.figure.zoneAt) return r.figure;
  return null;
}
// The body part under client point (cx, cy), or null (off her art, a transparent pixel, no part there).
// A VRM look is hit on its 3D skeleton (renderer/vrm.js zoneAt → core/vrm-hit.js), not the 2D zone table.
function zoneAtClient(cx, cy) {
  const vf = view && view.look && view.look.kind === 'vrm' ? vrmFigure() : null;
  if (vf) return vf.zoneAt(cx, cy);
  const pt = artPoint(cx, cy);
  if (!pt) return { zone: null, pt: null };
  return { zone: TZ.zoneAt(pt.x, pt.y, { character: speciesOf(view.pet.speciesId), pose: pt.pose, opaque: pt.opaque }), pt };
}

// A click on her: touch the part it landed on. With 部位触摸 off, or between parts (a transparent
// pixel, a spot no zone covers), it is the old single pat.
async function touchAt(e) {
  if (thinking || !view) return;
  if (!touchOn() || !e || !Number.isFinite(e.clientX)) return doAct('pat');
  const { zone, pt } = zoneAtClient(e.clientX, e.clientY);
  if (!zone) return doAct('pat');
  const r = await window.pet.touch(zone);
  if (r.ok) showTouch(r, pt, { x: e.clientX, y: e.clientY });
  return r;
}

// Her reaction: the zone's own clip (touch-<zone>) if her art has one, else the pat clip; and that
// part's marks over her (fx.js touchFx: a hand patting her head, a blush, an anger mark, …).
function showTouch(r, pt, at) {
  const video = isVideo(view.pet.speciesId);
  const sp = speciesOf(view.pet.speciesId);
  const has = (n) => (video ? !!sp.clips[n] : !!(view.look && ((view.look.kind === 'sprites' && view.look.actions[n]) || (isLive(view.look) && n.startsWith('touch-')))));
  const clip = has(r.reaction.anim) ? r.reaction.anim : 'pat';
  // client px → px inside #pet-body (the stage is zoomed by the pet size)
  const pb = $('pet-body');
  const pr = pb.getBoundingClientRect();
  const k = pr.width / (pb.offsetWidth || pr.width) || 1;
  const lx = (x) => (x - pr.left) / k;
  const ly = (y) => (y - pr.top) / k;
  const box = { left: lx(pt.box.left), top: ly(pt.box.top), width: (pt.box.right - pt.box.left) / k, height: (pt.box.bottom - pt.box.top) / k, mirrored: pt.mirrored };
  // her face in the box (0..1), for the blush: from her zone table (a chibi's face sits much lower)
  const fz = pt.faceRect ? { rects: [pt.faceRect] } : TZ.zonesFor(sp, pt.pose).find((z) => z.id === 'face'); // a VRM knows where its face is
  if (fz) box.face = fz.rects[0];
  lastTouch = { n: (lastTouch ? lastTouch.n : 0) + 1, zone: r.zone, mood: r.reaction.mood, streak: r.reaction.streak || null, clip, line: r.line };
  fx.touch({ zone: r.zone, mood: r.reaction.mood, clip, ms: video ? 3000 : 1600, box, at: { x: lx(at.x), y: ly(at.y) } });
}
let lastTouch = null;

// Hovering over her with 触摸提示 on: the part under the pointer, named beside it.
function bindTouchHint() {
  const hint = $('zone-hint');
  let pending = null; // the latest pointermove, looked at once per frame
  const clear = () => {
    pending = null;
    hint.classList.add('hidden');
    if ($('pet-body').dataset.hoverZone) $('pet-body').dataset.hoverZone = '';
  };
  const look = () => {
    const e = pending;
    pending = null;
    if (!e) return;
    if (!view || thinking || e.buttons || fx.lifted || fx.flying || !touchOn() || !(settings && settings.prefs && settings.prefs.touchHint)) return clear();
    const { zone } = zoneAtClient(e.clientX, e.clientY);
    if (!zone) return clear();
    $('pet-body').dataset.hoverZone = zone;
    hint.textContent = `👆 ${TZ.ZONES[zone].label}`;
    hint.style.left = `${e.clientX + 12}px`;
    hint.style.top = `${e.clientY + 10}px`;
    hint.classList.remove('hidden');
  };
  for (const el of document.querySelectorAll('.pet-hit')) {
    el.addEventListener('pointermove', (e) => {
      if (!pending) requestAnimationFrame(look);
      pending = { clientX: e.clientX, clientY: e.clientY, buttons: e.buttons };
    });
    el.addEventListener('pointerleave', clear);
    el.addEventListener('pointerdown', clear);
  }
}

// Thrown: in the air it is `lifted`; landing squashes it, then it shakes it off.
function throwPet(v) {
  return fx.throwPet(v, { onLand: () => fx.play('pat', Fx.oneShotMs(isVideo(view && view.pet.speciesId), 'pat')) });
}

// Controls are hidden unless the pointer is over the window (or one is in use).
// The controls exist only while the pointer is over the pet window (and it is not working). Nothing
// keeps them open: moving away hides everything, even an open chat box. The draft text and attached
// files are kept and come back with the next hover.
function syncHover() {
  document.body.classList.toggle('over', pointerInside); // pointer over the window (used by the stop button)
  document.body.classList.toggle('hover', !thinking && (pointerInside || micActive() || voiceHeld())); // listening (or a hotkey call) keeps 🎤 in reach
  if (!pointerInside && !micActive() && !voiceHeld()) {
    if (document.activeElement === $('chat-input')) $('chat-input').blur(); // keystrokes must not go into a hidden box
    $('food-menu').classList.add('hidden');
    closeDanceMenu();
  }
}
function bindHover() {
  const root = document.documentElement;
  const set = (inside) => { if (pointerInside !== inside) { pointerInside = inside; syncHover(); } };
  root.addEventListener('mouseenter', () => set(true));
  root.addEventListener('mouseleave', () => set(false));
  window.addEventListener('mousemove', () => set(true));
  window.addEventListener('blur', () => set(false));
  // dragging a file over the window counts as being on the pet (no mouse events fire during an OS drag)
  document.addEventListener('dragenter', () => set(true));
  document.addEventListener('dragover', () => set(true));
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) set(false); });
}

// ---------- pictures and files to send ----------
const MAX_ATTACH = 10;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function openChat() {
  $('chat-row').classList.remove('hidden');
  syncHover();
  $('chat-input').focus();
}

function pushAttachment(a) {
  if (attachments.length >= MAX_ATTACH) { say(`（一次最多 ${MAX_ATTACH} 个。）`, 'limit', 'fallback'); return; }
  if (a.kind === 'path' && attachments.some((x) => x.path === a.path)) return;
  if (a.kind === 'image' && attachments.filter((x) => x.kind === 'image').length >= MAX_IMAGES) { say(`（图片一次最多 ${MAX_IMAGES} 张。）`, 'limit', 'fallback'); return; }
  attachments.push(a);
  renderAttachments();
}

function addImageFile(file) {
  if (file.size > MAX_IMAGE_BYTES) { say('（这张图太大了，换一张小于 8MB 的吧。）', 'limit', 'fallback'); return; }
  const reader = new FileReader();
  reader.onload = () => pushAttachment({ kind: 'image', dataUrl: reader.result, name: file.name || 'pasted.png' });
  reader.readAsDataURL(file);
}

// A dropped or pasted File that lives on disk is handed over by PATH (nothing is uploaded; the agent
// reads it through the bound device). Data without a path (a screenshot on the clipboard) is an
// image to upload so the model can see it.
function routeFiles(files) {
  for (const f of files) {
    const p = window.pet.pathForFile(f);
    if (p) pushAttachment({ kind: 'path', path: p, name: p.split(/[\\/]/).filter(Boolean).pop() || f.name });
    else if (f.type.startsWith('image/')) addImageFile(f);
  }
}

function renderAttachments() {
  const row = $('attach-row');
  row.innerHTML = '';
  attachments.forEach((a, i) => {
    const chip = document.createElement('div');
    chip.className = a.kind === 'image' ? 'attach-chip' : 'attach-chip file';
    if (a.kind === 'image') chip.style.backgroundImage = `url(${a.dataUrl})`;
    else { chip.title = a.path; chip.innerHTML = `<span class="ico">📄</span><span class="nm"></span>`; chip.querySelector('.nm').textContent = a.name; }
    const x = document.createElement('button');
    x.textContent = '×';
    x.title = '移除';
    x.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
    chip.appendChild(x);
    row.appendChild(chip);
  });
  row.classList.toggle('hidden', attachments.length === 0);
}

// ---------- render loop ----------
// What the pet is doing right now, in the shared state vocabulary (src/core/fx.js STATES), by priority:
// lifted or flying > waking up / stage-up > thinking > eating > a one-shot (click, play, idle cue, error)
// > talking > its needs (idle / happy / sad / hungry / sleep).
const CELEBRATIONS = ['hatch', 'evolve'];
// a rig acts every state out itself, but has no food, thought bubble or z's to draw: those keep their emoji
const RIG_OVERLAY = new Set(['eat_rice', 'eat_cookie', 'eat_fruit', 'think', 'sleep', 'hungry']); // waking up and a stage-up play through, even while it thinks
function petStatus() {
  const now = performance.now();
  if (fx.lifted || fx.flying) return 'lifted';
  const shot = fx.current(now);
  if (shot && CELEBRATIONS.includes(shot)) return shot;
  if (thinking) return 'think';
  // 语音输入 (🎤 or the 快捷键): while you speak she listens — looks at you, nothing else plays over it —
  // and then works out what was said (think)
  if (micListening()) return 'look';
  if (mic.state === 'stopping' || mic.state === 'transcribing') return 'think';
  if (eating) return `eat_${eating}`;
  if (shot) return shot;
  if (fx.walking) return 'walk';
  if (now < talkUntil) return 'talk';
  return view ? view.status : 'idle'; // no pet (just released): the effects layer may still ask once
}
const petAction = () => petStatus();

// Every frame, for every character: pick the state, resolve it against the character's art, play it.
function animatePet() {
  const now = performance.now();
  const sp = speciesOf(view.pet.speciesId);
  const video = isVideo(view.pet.speciesId);
  // no idle cues (walks, turns) while she dances: the window moving would drag the dance along (§3.4)
  fx.tickIdle(now, ['idle', 'happy'].includes(petStatus()) && !pointerInside && !(dance && dance.active()), video);
  const state = petStatus();
  const r = state.startsWith('touch-') ? { name: state, exact: true } : video ? clipFor(sp, state) : view.look && view.look.kind === 'sprites' ? Fx.resolveAction(state, (n) => !!view.look.actions[n]) : isLive(view.look) ? { name: state, exact: !RIG_OVERLAY.has(state) } : { name: state, exact: false };
  if (video) playClip($('pet-video'), sp, r.name);
  const wrap = $('char-wrap');
  if (wrap.dataset.status !== state) wrap.dataset.status = state; // pictures move with CSS (style.css)
  // an emoji over a character that has no own art for the state (a sprite or clip draws its own)
  // listening: an ear over her whatever the art (a clip or a rig has no "listening" of its own), see style.css .listening
  const listening = micListening();
  if (wrap.classList.contains('listening') !== listening) wrap.classList.toggle('listening', listening);
  const fxText = listening ? LISTEN_FX : r.exact ? '' : Fx.FOOD_OVERLAY[state] || Fx.OVERLAY[state] || '';
  if ($('char-fx').textContent !== fxText) $('char-fx').textContent = fxText;
  fx.render(state, r.name, r.exact, sp.fx.noMirror);
  $('pet-body').classList.toggle('flash', now < flashUntil);
  if (now - lastPose > 1000 && !fx.flying) { lastPose = now; fx.report(0, 0); } // where it is, for the others' collisions
}
let lastPose = 0;

// Test and debugging handle: what the pet is doing, and cues to trigger every effect by hand.
// ---------- 语音输入 (recognition runs in main: core/asr.js; docs/asr-design.md §5–7) ----------
// 🎤 next to the chat box, shown while 语音输入 is on. A quick click starts and a second click stops; holding
// it down records until it is let go (按住说话). Esc cancels. MediaRecorder's webm/opus goes to main over IPC
// (window.pet.asr.transcribe); the text lands in the chat box, or is sent at once (识别后直接发送).
const MIC_MIN_MS = 400; // shorter than this is a slip of the finger, not something said
const MIC_HOLD_MS = 350; // held longer than this: 按住说话 (letting go stops); shorter: a click that toggles
const CHAT_PLACEHOLDER = '说点什么，可粘贴图片、拖入文件…';
const ASR_NAME = { lobehub: 'LobeHub 云端识别', local: '本地识别服务（whisper）' };
const ASR_REASON = {
  'too-short': '太短了，没录到。点一下 🎤 开始、说完再点一下；或者按住 🎤 说话。',
  empty: '没听清，再说一遍？',
  unauthorized: '语音识别要先登录 LobeHub。',
  model: '识别模型用不了，去 高级设置 → 语音输入 换一个。',
  'no-lh': '没找到能识别语音的 lh（需要较新的 LobeHub CLI）。',
  network: '连不上本地识别服务',
  timeout: '识别超时了。',
  server: '识别服务出错了。',
  'bad-audio': '这段录音没法识别。',
  'not-configured': '语音输入没开，或者没选识别引擎。',
  'mic-denied': '没有麦克风权限。', // + what to do on this system (MIC_FIX)
  'no-mic': '没找到麦克风。',
  'mic-error': '麦克风打不开',
  canceled: '已取消。',
};
let mic = { state: 'idle', rec: null, stream: null, chunks: [], t0: 0, ms: 0, timer: null, tick: null, pressAt: 0, cancel: false };
let lastAsr = null; // the last outcome (e2e reads it through petFx.lastAsr)
const asrOn = () => !!(settings && settings.asr && settings.asr.enabled && settings.asr.engine !== 'off');
const micActive = () => mic.state !== 'idle';
// she is listening while the microphone is opening or recording (🎤 or the 快捷键)
const micListening = () => mic.state === 'recording' || mic.state === 'starting';
const LISTEN_FX = '👂';

// 麦克风被拒: what to do, for the system she runs on (docs/asr.md §5)
const OS = /mac/i.test(navigator.platform) ? 'mac' : /win/i.test(navigator.platform) ? 'win' : 'linux';
const MIC_FIX = {
  mac: '到 系统设置 → 隐私与安全性 → 麦克风，打开 Pixel Pet Affection，然后重开应用。',
  win: '到 设置 → 隐私和安全性 → 麦克风，打开「麦克风访问」和「允许桌面应用访问麦克风」。',
  linux: '到 系统设置 → 声音 → 输入，选中麦克风并确认没有静音（PipeWire / PulseAudio 可以用 pactl list sources short 查看）；用 Flatpak / Snap 装的，还要在权限设置里允许它使用麦克风。',
};
function asrReasonText(r) {
  if (r.reason === 'mic-denied') return `${ASR_REASON['mic-denied']}${MIC_FIX[OS]}`;
  const base = ASR_REASON[r.reason] || (String(r.reason || '').startsWith('http-') ? `识别服务返回了错误 ${r.reason.slice(5)}。` : `识别失败（${r.reason || '未知原因'}）。`);
  if (r.reason === 'network') return `${base}：${(settings && settings.asr && settings.asr.local.endpoint) || ''}。它开着吗？`;
  if (r.reason === 'mic-error') return `${base}（${String(r.message || '').slice(0, 60)}）。`;
  return base;
}

// The 🎤 button, the status line above the box and the box itself follow mic.state.
function paintMic() {
  const b = $('chat-mic');
  if (!b) return;
  const input = $('chat-input');
  const st = $('mic-status');
  const s = mic.state;
  b.dataset.state = s;
  b.setAttribute('aria-pressed', String(s === 'recording'));
  const sec = s === 'recording' ? Math.floor((performance.now() - mic.t0) / 1000) : 0;
  const max = (settings && settings.asr && settings.asr.maxSeconds) || 60;
  if (s === 'recording') b.textContent = `■ ${sec}s`;
  else if (s === 'idle') b.innerHTML = MIC_ICON;
  else b.innerHTML = '<span class="spin" aria-hidden="true"></span>';
  b.title = s === 'recording' ? '再点一下（或松开）结束，Esc 取消' : s === 'idle' ? '语音输入：点一下开始、再点一下结束；也可以按住说话，松开结束' : '识别中…';
  input.classList.toggle('listening', s === 'recording');
  input.classList.toggle('recognizing', s === 'transcribing' || s === 'stopping');
  input.placeholder = s === 'recording' ? '正在听…' : s === 'transcribing' || s === 'stopping' ? '识别中…' : CHAT_PLACEHOLDER;
  const engine = settings && settings.asr ? ASR_NAME[settings.asr.engine] || '' : '';
  const line = s === 'recording' ? `🔴 正在听 ${sec}s / ${max}s · 再点或松开结束，Esc 取消`
    : s === 'starting' ? '🎤 正在打开麦克风…'
      : s === 'stopping' || s === 'transcribing' ? `⏳ 识别中…（${engine}）` : '';
  st.textContent = line;
  st.dataset.state = s;
  st.classList.toggle('hidden', !line);
  if (voiceCall.on && s !== 'idle') {
    listenBubble(s === 'recording' ? `我在听…\n说完再按 ${voiceCall.label} 结束` : s === 'starting' ? '正在打开麦克风…' : '嗯…让我想想你说了什么', s);
  }
}

// 静音 (toolbar speaker): one switch over everything she sounds — 朗读, 互动语音 and the click sound.
// It is its own pref (prefs.muted), so un-muting brings back exactly what 朗读 / 点击音效 were set to.
function syncMute() {
  const b = $('btn-mute');
  if (!b || !settings || !settings.prefs) return;
  const p = settings.prefs;
  const muted = p.muted === true;
  b.setAttribute('aria-pressed', String(muted));
  b.setAttribute('aria-label', muted ? '取消静音' : '静音');
  b.title = muted ? '已静音：点一下恢复她的声音'
    : p.voice || p.clickSound ? '静音：让她不出声' : '静音（朗读回复和点击音效现在都没开，可在设置里打开）';
}
async function toggleMute() {
  if (!settings || !settings.prefs) return;
  const muted = settings.prefs.muted !== true;
  if (muted) stopSpeech('muted'); // quiet at once, before main answers
  const r = await window.pet.setPrefs({ muted });
  if (r && r.settings) setSettings(r.settings);
}

// Shown or hidden with 语音输入; switching it off mid-recording drops the recording.
function syncMic() {
  const b = $('chat-mic');
  if (!b) return;
  const on = asrOn() && !VISITOR;
  b.classList.toggle('hidden', !on);
  if (!on && micActive()) micStop(true);
}

function micRelease() {
  clearTimeout(mic.timer);
  clearInterval(mic.tick);
  if (mic.stream) for (const t of mic.stream.getTracks()) t.stop(); // the OS's microphone light goes off
  mic.stream = null;
  mic.rec = null;
  mic.chunks = [];
}

async function micStart() {
  if (mic.state !== 'idle' || !asrOn() || thinking) return;
  mic.state = 'starting';
  paintMic();
  syncHover();
  try {
    const access = await window.pet.asr.micAccess();
    if (access !== 'granted') throw Object.assign(new Error(access), { name: 'NotAllowedError' });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (mic.state !== 'starting') { for (const t of stream.getTracks()) t.stop(); return; } // let go / Esc while it opened
    const type = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : {});
    mic.stream = stream;
    mic.rec = rec;
    mic.chunks = [];
    mic.cancel = false;
    rec.ondataavailable = (e) => { if (e.data && e.data.size) mic.chunks.push(e.data); };
    rec.onstop = () => { micDone(rec); };
    rec.start(250);
    mic.t0 = performance.now();
    mic.state = 'recording';
    stopSpeech('listening'); // her own voice must not end up in the recording
    mic.tick = setInterval(paintMic, 250);
    mic.timer = setTimeout(() => micStop(), ((settings.asr && settings.asr.maxSeconds) || 60) * 1000);
    paintMic();
  } catch (e) {
    micRelease();
    mic.state = 'idle';
    paintMic();
    syncHover();
    const n = e && e.name;
    asrFail({ ok: false, reason: n === 'NotAllowedError' || n === 'SecurityError' ? 'mic-denied' : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'no-mic' : 'mic-error', message: String((e && e.message) || e) });
  }
}

// Stop listening: the clip goes to be recognised, or (cancel) is thrown away.
function micStop(cancel = false) {
  if (mic.state === 'starting') { mic.state = 'idle'; paintMic(); syncHover(); endVoiceCall('canceled'); return; }
  if (mic.state !== 'recording') {
    if (cancel && mic.state === 'transcribing') window.pet.asr.cancel();
    return;
  }
  mic.cancel = cancel;
  mic.ms = performance.now() - mic.t0;
  clearTimeout(mic.timer);
  clearInterval(mic.tick);
  mic.state = 'stopping';
  paintMic();
  try { mic.rec.stop(); } catch { micDone(mic.rec); }
}

async function micDone(rec) {
  if (rec && mic.rec !== rec) return;
  const chunks = mic.chunks;
  const mime = (rec && rec.mimeType) || 'audio/webm';
  const ms = Math.round(mic.ms || 0);
  const cancel = mic.cancel;
  micRelease();
  if (cancel) { mic.state = 'idle'; paintMic(); syncHover(); lastAsr = { ok: false, reason: 'canceled', clipMs: ms }; endVoiceCall('canceled'); return; }
  if (ms < MIC_MIN_MS || !chunks.length) { mic.state = 'idle'; paintMic(); syncHover(); asrFail({ ok: false, reason: 'too-short', clipMs: ms }); return; }
  const blob = new Blob(chunks, { type: mime });
  mic.state = 'transcribing';
  paintMic();
  let r;
  try {
    r = await window.pet.asr.transcribe(await blob.arrayBuffer(), mime, ms);
  } catch (e) {
    r = { ok: false, reason: 'server', message: String((e && e.message) || e) };
  }
  mic.state = 'idle';
  paintMic();
  syncHover();
  lastAsr = { ...r, bytes: blob.size, mime, clipMs: ms, at: Date.now() };
  if (!r.ok) { if (r.reason !== 'canceled') asrFail(r); else endVoiceCall('canceled'); return; }
  const input = $('chat-input');
  const cur = input.value.trimEnd();
  input.value = `${cur}${cur && !/\s$/.test(cur) ? ' ' : ''}${r.text}`.slice(0, Number(input.maxLength) > 0 ? Number(input.maxLength) : 400);
  if (!$('chat-row').classList.contains('hidden')) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  if (settings.asr.autoSend) {
    if (thinking) showNotice('🎤 已填进输入框', '她还在回上一句，等她说完再点“发送”。');
    else { lastAsr.sent = true; $('chat-send').click(); }
  }
  endVoiceCall('ok', lastAsr);
}

// What went wrong goes in a toast; what is in the box stays.
function asrFail(r) {
  lastAsr = { ...(lastAsr && lastAsr.at === r.at ? lastAsr : {}), ...r };
  const settingsFix = !/^(too-short|empty|canceled|mic-denied|no-mic)$/.test(r.reason);
  showNotice('🎤 语音输入没成功', asrReasonText(r), settingsFix ? { label: '去设置', admin: 'asr' } : null);
  endVoiceCall('fail', r);
}

// ---------- 快捷键唤起语音对话 (main/voice-hotkey.js → 'voice-hotkey'; docs/asr.md §1.1) ----------
// The global shortcut in 设置 → 语音输入 → 快捷键. Main has already shown and focused this window; here the
// chat box opens and the same recorder as 🎤 starts (micStart); pressed again while she listens it stops
// and the clip is recognised (micStop) — then 识别后直接发送 and the rest work as with 🎤. While a call is on
// the controls stay up without the pointer on her, the bubble says what she is doing, and she looks at you.
const VOICE_HOLD_MS = { hint: 9000, heard: 15000, failed: 9000 };
let voiceCall = { on: false, label: '', until: 0, timer: null, log: [], last: null };
const voiceHeld = () => voiceCall.on || performance.now() < voiceCall.until;
const hotkeyLabel = (p) => (p && p.label) || (settings && settings.hotkeyStatus && settings.hotkeyStatus.label) || '快捷键';
function logVoice(ev, extra = {}) {
  voiceCall.last = ev;
  voiceCall.log.push({ ev, mic: mic.state, at: Date.now(), ...extra });
  if (voiceCall.log.length > 50) voiceCall.log.shift();
}
// keep the controls up for a while after the call (the recognised text waits in the box, a hint is read)
function voiceHold(ms) {
  voiceCall.until = performance.now() + ms;
  clearTimeout(voiceCall.timer);
  voiceCall.timer = setTimeout(() => { voiceCall.until = 0; syncHover(); }, ms + 50);
  syncHover();
}
// the bubble while she listens: no talking mouth, no reading aloud, stays until the call moves on
function listenBubble(text, state) {
  const b = $('bubble');
  if (b.dataset.kind === 'listen' && b.dataset.reason === state && b.textContent === text && !b.classList.contains('hidden')) return;
  clearTimeout(bubbleTimer);
  b.classList.remove('thinking', 'streaming', 'hidden');
  delete b.dataset.stream;
  b.textContent = text;
  b.dataset.kind = 'listen';
  b.dataset.source = 'hotkey';
  b.dataset.reason = state;
  b.dataset.meme = '';
  $('meme-sticker').classList.add('hidden');
  talkUntil = 0;
}
function endVoiceCall(outcome, r = null) {
  if (!voiceCall.on) return;
  voiceCall.on = false;
  document.body.classList.remove('voice-call');
  logVoice(outcome, r ? { reason: r.reason || null, sent: !!r.sent } : {});
  const b = $('bubble');
  if (outcome === 'ok') {
    if (r && r.sent) return; // sent at once (识别后直接发送): her reply takes the bubble
    say(`听到啦～在输入框里，没问题就按 Enter 发给我。`, 'hint', 'hotkey', 'heard');
    voiceHold(VOICE_HOLD_MS.heard);
    $('chat-input').focus();
  } else if (outcome === 'fail') {
    const denied = r && (r.reason === 'mic-denied' || r.reason === 'no-mic' || r.reason === 'mic-error');
    const text = r && r.reason === 'mic-denied' ? '（我听不到你：麦克风权限被拒绝了，办法在下面的提示里。）'
      : denied ? `（我听不到你：${asrReasonText(r)}）`
        : `（${asrReasonText(r)}）`;
    say(text, 'error', 'hotkey', (r && r.reason) || 'failed');
    voiceHold(VOICE_HOLD_MS.failed);
  } else if (b.dataset.kind === 'listen') {
    hideBubbleLater(1200);
  }
}
function onVoiceHotkey(p) {
  logVoice('pressed', { source: (p && p.source) || null });
  if (VISITOR) return;
  if (!view || $('pet-screen').classList.contains('hidden')) {
    showNotice('🎤 还不能语音对话', '先在这个窗口里唤醒你的伙伴，之后按快捷键就能直接和她说话。');
    logVoice('no-pet');
    return;
  }
  if (mic.state === 'recording') { logVoice('stop'); micStop(); return; } // the second press: stop and recognise
  if (mic.state !== 'idle') { logVoice('ignored'); return; } // the microphone is opening / it is being recognised
  const label = hotkeyLabel(p);
  if (!asrOn()) {
    const why = settings && settings.asr && settings.asr.enabled ? '识别引擎选了「关闭」' : '语音输入还没开';
    // short enough for the two lines the bubble has above her; how to turn it on is in the notice below
    say(`（${why}，我听不到你～打开方法在下面的提示里。）`, 'hint', 'hotkey', 'asr-off');
    showNotice('🎤 语音输入还没开', `${why}。在 设置 → 语音输入 打开并选一个识别引擎（LobeHub 云端或本地 whisper），再按 ${label} 就能和她语音对话。`, { label: '去设置', admin: 'asr' });
    voiceHold(VOICE_HOLD_MS.hint);
    logVoice('asr-off');
    return;
  }
  if (thinking) { say('等等，我还在想上一句……', 'busy', 'hotkey', 'busy'); logVoice('busy'); return; }
  voiceCall.on = true;
  voiceCall.label = label;
  document.body.classList.add('voice-call');
  logVoice('start');
  openChat();
  micStart(); // she turns to listen (petStatus → look, the ear over her) for as long as it records
}

// A short notice in the toast box (the one 关系升级 uses): title, one line, optionally a button to a page of
// the settings window (`admin`: its section).
function showNotice(title, text, action = null, ms = 8000) {
  $('unlock-toast').classList.add('notice');
  $('toast-title').textContent = title;
  $('toast-body').textContent = text;
  const open = $('toast-open');
  open.classList.toggle('hidden', !action);
  open.textContent = action ? action.label : '';
  open.dataset.admin = action ? action.admin || '' : '';
  $('unlock-toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}

function bindMic() {
  const b = $('chat-mic');
  b.addEventListener('mousedown', (e) => e.preventDefault()); // the chat box keeps the focus
  b.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (mic.state === 'recording') { mic.pressAt = 0; micStop(); return; } // the second click
    if (mic.state !== 'idle') return;
    try { b.setPointerCapture(e.pointerId); } catch { /* not a real pointer */ }
    mic.pressAt = performance.now();
    micStart();
  });
  const release = () => {
    const held = mic.pressAt && performance.now() - mic.pressAt > MIC_HOLD_MS;
    mic.pressAt = 0;
    if (held) micStop(); // 按住说话: letting go ends it. A quick click keeps listening until the next one.
  };
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  // Enter / Space on the focused button: start, and stop
  b.addEventListener('click', (e) => { if (e.detail !== 0) return; if (mic.state === 'recording') micStop(); else micStart(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && micActive()) { e.stopImmediatePropagation(); micStop(true); } }, true);
  syncMic();
  paintMic();
}

window.petFx = {
  state: () => (view ? { state: petStatus(), listening: $('char-wrap').classList.contains('listening'), fx: $('char-fx').textContent, action: $('pet-body').dataset.action, exact: $('pet-body').dataset.exact === 'yes', facing: $('pet-body').dataset.facing, lastCue: fx.lastCue, flying: fx.flying, species: view.pet.speciesId, video: isVideo(view.pet.speciesId) } : null),
  cue: (name) => fx.cue(name, isVideo(view.pet.speciesId)),
  click: () => doAct('pat'),
  // 部位触摸: what a client point maps to, and the last reaction shown
  touchPoint: (cx, cy) => { const { zone, pt } = zoneAtClient(cx, cy); return pt ? { zone, x: pt.x, y: pt.y, opaque: pt.opaque, pose: pt.pose, mirrored: pt.mirrored, box: pt.box, framing: pt.framing } : null; },
  framing: () => (view && view.look ? framingOf(view.look) : null),
  lastTouch: () => lastTouch,
  throw: (vx, vy) => throwPet({ vx, vy }),
  burst: (n) => fx.burst(n),
  error: () => say('（出错了：测试）', 'error', 'error', 'test'),
  eat: (food) => { eating = food; setTimeout(() => { eating = null; }, 4000); },
  lift: (on) => fx.setLifted(on),
  face: (dir) => fx.setFacing(dir),
  walk: () => fx.walkPet(),
  stats: () => ({ ...fx.stats, walking: fx.walking }),
  hitBox: () => petHitBox(),
  lastSpeech: () => lastSpeech && { ...lastSpeech, fellBackFrom: [...lastSpeech.fellBackFrom], sentences: lastSpeech.sentences.map((s) => ({ ...s })) },
  speechLog: () => speechLog.map((e) => ({ ...e })),
  // 流式回复: the pieces shown and the ends of streams, and the stream being written now
  streamLog: () => streamLog.map((e) => ({ ...e })),
  stream: () => stream && { ...stream },
  audioState: () => (speechAudio ? { paused: speechAudio.paused, currentTime: speechAudio.currentTime, duration: speechAudio.duration, src: speechAudio.src.slice(0, 5) } : null),
  speak: (text) => speak({ text, source: 'api', kind: 'api' }),
  // 互动语音: every line offered to the voice (said or dropped by the gate), and the last prewarm
  offerLog: () => offerLog.map((e) => ({ ...e })),
  speechGate: () => ({ ...speechGate.stats }),
  lastPrewarm: () => lastPrewarm && { ...lastPrewarm },
  lastAsr: () => lastAsr && { ...lastAsr },
  // 快捷键唤起语音对话: whether a call is on, what happened on each press
  voiceCall: () => ({ on: voiceCall.on, held: voiceHeld(), label: voiceCall.label, last: voiceCall.last, log: voiceCall.log.slice(), mic: mic.state }),
  micState: () => mic.state,
  // VRM figures (vrm.js): what each is drawing (mode, fps, face, mouth, gaze…), created / disposed counts
  vrm: () => (window.PetVRM ? window.PetVRM.debug() : null),
  // dancing: the controller's state (id, time, music, gain…) and counters
  dance: () => (dance ? { state: dance.state(), stats: dance.stats() } : null),
  // 重置姿势 (T-2830): the last reset this window carried out
  lastReset: () => lastReset && { ...lastReset },
  // the Live2D figures drawn now: framing, half-body band (and where it came from), placement, gaze
  live2d: () => [...rigs].filter((r) => r.canvas.classList.contains('live2d') && r.figure.debug).map((r) => r.figure.debug()),
  // the desktop pet's pixel sprite: framing, half-body band (pack / default), measured reference, crop, canvas size
  sprite: () => { const el = $('pet-look').firstElementChild; return el && el.petFigure && el.classList.contains('sprite') && !el.classList.contains('rig') ? el.petFigure.debug() : null; },
  // e2e: a few seconds of vowel-like sound played through the TTS path (playAudio), so lip sync runs
  // without a TTS engine; resolves with how the clip ended
  testVoice: (seconds = 2) => new Promise((resolve) => {
    const rec = { sentences: [], fellBackFrom: [] };
    const s = { text: '测试口型', status: 'queued' };
    playAudio(rec, s, { ok: true, provider: 'test', audio: vowelWav(seconds), mime: 'audio/wav', cached: false }, (status) => resolve(status));
  }),
};
// A WAV of `seconds` of vowel-like tones (a voice pitch plus two formant partials, a new vowel every 250 ms
// with a short pause between), for petFx.testVoice.
function vowelWav(seconds) {
  const rate = 22050;
  const n = Math.round(rate * seconds);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  const VOWELS = [[850, 1600], [300, 2600], [350, 800], [500, 2200], [550, 900]]; // a i u e o (F1, F2)
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const [f1, f2] = VOWELS[Math.floor(t / 0.25) % VOWELS.length];
    const ph = (t % 0.25) / 0.25;
    const env = ph < 0.8 ? Math.sin((ph / 0.8) * Math.PI) : 0;
    const x = 0.3 * Math.sin(2 * Math.PI * 180 * t) + 0.35 * Math.sin(2 * Math.PI * f1 * t) + 0.25 * Math.sin(2 * Math.PI * f2 * t);
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x * env)) * 32767 * 0.8, true);
  }
  return buf;
}

// The local HTTP API (src/core/api.js) asks the window to play, throw or report what it is doing.
async function onApiCmd({ id, cmd, args }) {
  let result = { ok: false, reason: 'no-pet' };
  if (view && !$('pet-screen').classList.contains('hidden')) {
    const video = isVideo(view.pet.speciesId);
    if (cmd === 'state') result = { ok: true, fx: window.petFx.state(), bubble: $('bubble').classList.contains('hidden') ? null : $('bubble').textContent, dance: dance ? dance.state() : null };
    // dancing (docs/vrm-dance.md §6.2): a VRM look only; the reason otherwise
    if (cmd === 'dance') result = dance ? await dance.play({ id: args.id || null, name: args.name || null, loop: args.loop }) : { ok: false, reason: 'no-pet' };
    if (cmd === 'dance-stop') result = dance ? dance.stop({ reason: args.immediate ? 'removed' : 'api', immediate: !!args.immediate }) : { ok: false, reason: 'no-pet' };
    if (cmd === 'dance-loop') result = dance && dance.active() ? { ok: true, loop: dance.setLoop(args.on) } : { ok: false, reason: 'not-dancing' };
    if (cmd === 'reset-pose') result = resetPose(args.source);
    if (cmd === 'dance-state') result = { ok: true, dance: dance ? dance.state() : null };
    if (cmd === 'anim') {
      if (thinking) result = { ok: false, reason: 'busy' };
      else {
        if (dance && dance.active()) dance.stop({ reason: 'anim' });
        if (args.facing) fx.setFacing(args.facing);
        fx.cue(args.state, video);
        result = { ok: true };
      }
    }
    // 设置 → 桌面 → 回到右下角: stop flying / walking; main then puts the window back in its corner
    if (cmd === 'home') {
      fx.stopThrow();
      fx.stopWalk();
      result = { ok: true };
    }
    if (cmd === 'throw') {
      const r = await throwPet({ vx: args.vx, vy: args.vy });
      result = r ? { ok: true, bounces: r.bounces } : { ok: false, reason: 'flying' };
    }
  }
  window.pet.apiReply(id, result);
}

const spriteGliding = () => { for (const s of sprites) if (s.glide) return true; return false; }; // a framing glide wants every frame
function frameLoop() {
  if (dance) dance.tick(performance.now()); // before the figure draws: the clock, the music, the director's asks
  if (view && !VISITOR) { syncDanceButton(); syncResetButton(); }
  tickSprites(performance.now());
  tickRigs(performance.now());
  if (!$('hatching').classList.contains('hidden')) {
    $('hatch-look').classList.toggle('flash', performance.now() < flashUntil);
  } else if (view && !$('pet-screen').classList.contains('hidden')) {
    animatePet();
  }
  // ~12 fps keeps the pixel feel and idles cheaply; a rig's springs want every frame
  if (rigs.size || spriteGliding()) requestAnimationFrame(frameLoop);
  else setTimeout(() => requestAnimationFrame(frameLoop), 80);
}

// ---------- updates (src/main/updater.js) ----------
let updateAnnounced = null;
let updateState = null;
function onUpdateStatus(u) {
  updateState = u;
  // 新版本 (the old ⋯ menu's first item): a dot on ⚙, which then opens 设置 → 版本与更新 (立即更新 / 下载新版本)
  if (view) syncSettingsDot();
  if (!view || updateAnnounced === `${u.status}:${u.version}`) return;
  const moveFirst = ['translocated', 'dmg', 'read-only'].includes(u.error);
  if (u.status === 'ready') say(`（新版本 v${u.version} 已经下载好了。你离开电脑一会儿时我会自己重启更新，也可以在 设置 → 版本与更新 里立即更新。）`, 'update', 'fallback');
  else if (u.status === 'manual') say(moveFirst ? `（有新版本 v${u.version}。先把我拖进“应用程序”文件夹再打开，以后就能自动更新了；这次可以在 设置 → 版本与更新 里下载。）` : `（有新版本 v${u.version}，可以在 设置 → 版本与更新 里下载。）`, 'update', 'fallback');
  else return;
  updateAnnounced = `${u.status}:${u.version}`;
}

// ---------- boot ----------
async function main() {
  fx = window.PetEffects.createEffects({ body: $('pet-body'), floatLayer: $('float-layer'), touchLayer: $('touch-fx'), api: window.pet, prefs: petPrefs, hitBox: petHitBox });
  if (window.PetDance) {
    // only the desk pet's own VRM figure dances (not a picture, not the hatch screen)
    dance = window.PetDance.create({ figure: () => (view && view.look && view.look.kind === 'vrm' && !$('pet-screen').classList.contains('hidden') ? vrmFigure() : null), look: () => view && view.look, prefs: () => (settings && settings.prefs) || {}, body: $('pet-body') });
    window.PetDance.current = dance;
  }
  window.pet.onKicked((v) => fx.kicked(v, { onLand: () => fx.play('pat', Fx.oneShotMs(isVideo(view && view.pet.speciesId), 'pat')) }));
  if (VISITOR) return visitorMain();
  info = await window.pet.boot();
  bindPetUi();
  bindResize();
  bindHover();
  $('hatch-btn').addEventListener('click', startHatch);
  $('hatch-retry').addEventListener('click', showOnboarding);
  $('age-yes').addEventListener('click', () => answerAgeGate(true));
  $('age-no').addEventListener('click', () => answerAgeGate(false));
  $('toast-close').addEventListener('click', hideToast);
  // 去衣柜看看 / 去聊聊新话题 / 去设置: the page in the settings window
  $('toast-open').addEventListener('click', () => {
    const { admin } = $('toast-open').dataset;
    hideToast();
    window.pet.openAdmin(admin || undefined);
  });
  window.pet.onUpdate((v) => {
    // 通用设定: main sends the bases again when a generic VRM companion came or went (core/generic.js)
    if (v && Array.isArray(v.speciesList)) { info.species = v.speciesList; delete v.speciesList; }
    view = v;
    syncPrewarm();
    if (v) { applyArt(); refreshHud(); return; }
    // 放生 / 仅重置本地 (设置 → 数据与关于): no pet any more, so back to choosing one
    if (!$('pet-screen').classList.contains('hidden')) { stopSpeech('released'); hideToast(); showOnboarding(); }
  });
  window.pet.onSay((m) => { say(m.text, m.kind, m.source, m.reason, m.meme, m.streamId || null); speak(m); });
  window.pet.onChatDelta(onChatDelta);
  window.pet.onChatDone(onChatDone);
  window.pet.onApiCmd(onApiCmd);
  window.pet.onThinking(setThinking);
  window.pet.onAffection(onAffection);
  window.pet.onSettings((st) => { setSettings(st); });
  window.pet.onVoiceHotkey(onVoiceHotkey);
  window.pet.onUpdateStatus(onUpdateStatus);
  setSettings(info.settings);
  const start = (v) => (v ? enterPet(v) : showOnboarding());
  if (settings.needsAgeGate) showAgeGate((r) => start(r.view));
  else start(info.view);
  if (info.update) onUpdateStatus(info.update);
  requestAnimationFrame(frameLoop);
}

// A visiting model-chan (同屏伙伴): only the character, with every desktop effect (idle chain, walking,
// clicks, dragging, throwing, knocking into the others) and no agent, needs or controls. Hovering shows
// one button that sends her home.
async function visitorMain() {
  document.body.classList.add('visitor');
  const b = await window.pet.visitorBoot();
  if (!b) return;
  info = { species: b.species, characters: [], testMode: b.testMode };
  setSettings(b.settings);
  const sp = speciesOf(b.speciesId);
  // a visitor is a character (T-2764): her own look, her base's persona
  view = { pet: { speciesId: sp.id, characterId: b.characterId, name: sp.nameZh }, look: b.look, outfit: 'daily', status: 'idle' };
  window.pet.onSettings((st) => setSettings(st));
  bindHover();
  bindPetPointer({ onClick: () => { fx.click(isVideo(sp.id)); fx.burst(3); }, onMenu: () => { pointerInside = true; syncHover(); } });
  $('visitor-name').textContent = `${b.name || sp.nameZh}（${sp.vendor}）来串门`;
  $('visitor-close').addEventListener('click', () => window.pet.setVisitors(settings.visitors.filter((v) => v !== b.characterId)));
  show('pet-screen');
  applyArt();
  requestAnimationFrame(frameLoop);
}

main();
