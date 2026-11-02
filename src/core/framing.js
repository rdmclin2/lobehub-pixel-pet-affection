'use strict';

// 取景模式 (framing): how much of her the desktop pet shows — 'full' (head to feet, the default) or 'half'
// (半身: head to waist, drawn bigger in the same window). docs/half-body-mode.md.
//
// Three places decide it, the most specific first:
//   1. her own choice on her page in the settings window (settings.framings[<character id>]),
//   2. the pack she wears (pack.json `framing`, e.g. a bust-only model that has no legs to show),
//   3. the global setting (settings.prefs.framing, 桌宠行为 → 大小与取景).
// Only looks drawn by a camera can be re-framed (VRM today); the others (pixel sprites, pictures, rigs)
// keep their full art whatever is chosen, and say so (`supported: false`).
//
// The half-body camera band comes from the humanoid bones (head, neck, upperChest / chest, hips), not from
// the whole model's bounding box, so long hair, a tail or a skirt do not move the cut; a model without
// those bones falls back to a share of its bounding box. Pure and three-free: the renderer (vrm.js) hands
// in the bone heights it measured, and the touch hit test (app.js) maps a click on the half-body picture
// back to her full-body proportions (touch-zones.js zones are written for head-to-feet art).
//
// Also loaded by the renderer as a <script> (window.PetFraming).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetFraming = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FRAMINGS = ['full', 'half'];
  const DEFAULT = 'full';
  // kinds whose renderer can re-frame (a camera): others always show their full art
  const SUPPORTED_KINDS = ['vrm'];

  const isFraming = (v) => FRAMINGS.includes(v);
  // a stored value → a framing; anything else (missing, misspelt, an old file) → `dflt`
  const normalizeFraming = (v, dflt = DEFAULT) => (isFraming(v) ? v : dflt);

  // The per-character overrides as stored: { <character id>: 'full' | 'half' }; 'auto' / unknown values dropped
  // (no entry = follow the pack / the global setting).
  function normalizeFramings(raw) {
    const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return Object.fromEntries(Object.entries(m).filter(([k, v]) => /^[a-z]{2,20}$/.test(k) && isFraming(v)));
  }

  // Which framing she is shown in. `settings`: the settings (view) with prefs.framing and framings;
  // `characterId`: who; `look`: what she wears (core/packs.js resolveLook: kind, framing from pack.json).
  // -> { mode ('full' | 'half', what is drawn), wanted (what the settings ask for), source ('character' | 'pack' |
  //      'global'), supported (the look can be re-framed) }
  function resolveFraming(settings, characterId, look) {
    const s = settings && typeof settings === 'object' ? settings : {};
    const own = characterId && s.framings && typeof s.framings === 'object' ? s.framings[characterId] : undefined;
    const pack = look && look.framing;
    let wanted;
    let source;
    if (isFraming(own)) { wanted = own; source = 'character'; } else if (isFraming(pack)) { wanted = pack; source = 'pack'; } else { wanted = normalizeFraming(s.prefs && s.prefs.framing); source = 'global'; }
    const supported = !!look && SUPPORTED_KINDS.includes(look.kind);
    return { mode: supported ? wanted : 'full', wanted, source, supported };
  }

  // ---- the half-body band ---------------------------------------------------------------------------
  // Shares of her torso (head bone height − hips bone height): the top of her head is the top of the model at
  // rest (arms down: her hair), at least `headMin` and at most `headMax` above the head bone (the bone sits at
  // the base of the skull; a chibi head is as tall as her torso, an antenna or a raised prop is cut off);
  // the cut is `waist` above the hips bone (the waist); `margin`: air above her head (share of the canvas).
  const HALF = { headMin: 0.25, headMax: 1.0, waist: 0.12, margin: 0.04 };
  // without the bones: the top HALF_BOX share of the bounding box
  const HALF_BOX = 0.5;

  // The world heights (y, metres) and centre to frame. `bones`: { head, neck, upperChest, chest, spine, hips }
  // → { x, y } (world position; any may be missing); `box`: { minX, maxX, minY, maxY } of the model at rest.
  // -> { top, bottom, cx, source ('bones' | 'box'), cut (share of her full height shown, 0..1, from the top) }
  function halfBodyBand(bones, box) {
    const b = bones || {};
    const ok = (p) => p && Number.isFinite(p.y) && Number.isFinite(p.x);
    const fullH = Math.max(1e-6, box.maxY - box.minY);
    const boxCx = (box.minX + box.maxX) / 2;
    const head = ok(b.head) ? b.head : null;
    const chest = [b.upperChest, b.chest, b.spine].find(ok) || null;
    // hips, else a stand-in below the chest (a model without hips but with a chest and a head)
    const hips = ok(b.hips) ? b.hips : head && chest ? { x: chest.x, y: chest.y - (head.y - chest.y) * 0.8 } : null;
    if (head && hips && head.y - hips.y > fullH * 0.08) {
      const torso = head.y - hips.y;
      const top = Math.max(head.y + torso * HALF.headMin, Math.min(box.maxY, head.y + torso * HALF.headMax));
      const bottom = Math.max(box.minY, hips.y + torso * HALF.waist);
      // the visible box of the half-body picture: from the cut up to her top as drawn (what pokes out above the
      // band, within the air left above her head, is drawn too)
      const drawnTop = Math.min(box.maxY, top + ((top - bottom) * HALF.margin) / (1 - HALF.margin));
      if (top > bottom) return { top, bottom, cx: (head.x + hips.x) / 2, source: 'bones', cut: clamp01((drawnTop - bottom) / fullH) };
    }
    const bottom = box.maxY - fullH * HALF_BOX;
    return { top: box.maxY, bottom, cx: boxCx, source: 'box', cut: HALF_BOX };
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  // Where the camera goes for a band of world heights [bottom, top]. `share`: her share of the canvas height
  // (pack.json vrm.height); `fov`: vertical field of view (degrees); `mode`: 'full' stands her feet on the floor
  // with a sliver of air below; 'half' puts the cut exactly at the canvas' bottom edge (she rises out of it) and
  // leaves `HALF.margin` of air above her head.
  // -> { visible (world height the canvas shows), y (camera height = where it looks), dist (from her) }
  function cameraFor({ top, bottom }, { fov = 22, share = 0.8, mode = 'full' } = {}) {
    const h = Math.max(1e-6, top - bottom);
    const visible = mode === 'half' ? h / (1 - HALF.margin) : h / share;
    const y = mode === 'half' ? bottom + visible / 2 : bottom + visible * (0.5 - 0.005);
    const dist = visible / 2 / Math.tan((fov * Math.PI) / 360);
    return { visible, y, dist };
  }

  // A camera between two (switching modes): eased so the change is a short glide, never a jump.
  // t: 0..1 of the glide.
  function blendCamera(a, b, t) {
    const k = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    const mix = (x, y) => x + (y - x) * k;
    return { visible: mix(a.visible, b.visible), y: mix(a.y, b.y), dist: mix(a.dist, b.dist), x: mix(a.x || 0, b.x || 0) };
  }

  // A touch on the half-body picture, in her full-body proportions: the visible box of the half-body picture
  // spans the top `cut` of her, so y (0..1 down that box) is y·cut of her full height. Parts below the cut
  // (legs, feet; the hips as the cut sits at the waist) cannot be reached.
  function toFullBody(pt, framing) {
    if (!pt || !framing || framing.mode !== 'half' || !(framing.cut > 0)) return pt;
    return { ...pt, y: pt.y * Math.min(1, framing.cut) };
  }

  return { FRAMINGS, DEFAULT, SUPPORTED_KINDS, HALF, HALF_BOX, isFraming, normalizeFraming, normalizeFramings, resolveFraming, halfBodyBand, cameraFor, blendCamera, toFullBody };
});
