'use strict';

// 取景模式 (framing): how much of her the desktop pet shows — 'full' (head to feet, the default) or 'half'
// (半身: head to waist, drawn bigger in the same window). docs/half-body-mode.md.
//
// Three places decide it, the most specific first:
//   1. her own choice on her page in the settings window (settings.framings[<character id>]),
//   2. the pack she wears (pack.json `framing`, e.g. a bust-only model that has no legs to show),
//   3. the global setting (settings.prefs.framing, 桌宠行为 → 大小与取景).
// Only looks drawn live from a model can be re-framed (VRM: the camera; Live2D: the model's scale and offset);
// the others (pixel sprites, pictures, rigs) keep their full art whatever is chosen, and say so (`supported: false`).
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
  // kinds whose renderer can re-frame (VRM: a camera; Live2D: scale + offset): others always show their full art
  const SUPPORTED_KINDS = ['vrm', 'live2d'];
  // pack.json `halfBody.waist`: where the half-body cut sits, as a share of her height from the top of her head
  // (0) to her soles (1). Optional, for either kind; the renderer measures / infers it otherwise.
  const WAIST_RANGE = [0.2, 0.9];

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
  // Shares of her torso (head bone height − hips bone height): the top of her head is `headTop` (the highest
  // vertex skinned to the head bone or its children: skull, hair, ears — measured by the renderer), else the top
  // of the model at rest; at least `headMin` and at most `headMax` above the head bone (the bone sits at the base
  // of the skull; a chibi head is as tall as her torso, an antenna is cut off). The cut is `waist` above the hips
  // bone (the waist); `margin`: air above her head (share of the canvas).
  // `fitWidth`: the share of her head's width (hair, ears) that must fit sideways (the tips of wide chibi hair may
  // leave the picture rather than shrink her).
  const HALF = { headMin: 0.25, headMax: 3, waist: 0.12, margin: 0.05, fitWidth: 0.85 };
  // without the bones: the top HALF_BOX share of the bounding box
  const HALF_BOX = 0.5;

  // The world heights (y, metres) and centre to frame. `bones`: { head, neck, upperChest, chest, spine, hips }
  // → { x, y } (world position; any may be missing); `box`: { minX, maxX, minY, maxY } of the model at rest;
  // `head`: her head as measured from its own vertices, { top, minX, maxX } (optional — raised arms or a prop make
  // the box taller than her head, this does not; a big chibi head or wide hair must fit the canvas sideways).
  // -> { top, bottom, cx, source ('bones' | 'box'), cut (share of her full height shown, 0..1, from the top) }
  // `waist` (pack.json halfBody.waist, optional): the cut at that share of her height down from the top of the box,
  // instead of the one measured from the hips bone (source then 'pack').
  function halfBodyBand(bones, box, { head: headBox = null, waist = null } = {}) {
    const band = boneBand(bones, box, headBox);
    if (!isWaist(waist)) return band;
    const fullH = Math.max(1e-6, box.maxY - box.minY);
    const bottom = box.maxY - fullH * waist;
    const top = band.source === 'bones' ? Math.max(band.top, bottom + fullH * 0.05) : box.maxY;
    const drawnTop = Math.min(box.maxY, top + ((top - bottom) * HALF.margin) / (1 - HALF.margin));
    return { ...band, top, bottom, source: 'pack', cut: clamp01((drawnTop - bottom) / fullH) };
  }
  const isWaist = (v) => typeof v === 'number' && v >= WAIST_RANGE[0] && v <= WAIST_RANGE[1];
  function boneBand(bones, box, headBox) {
    const headTop = headBox && headBox.top;
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
      const reach = Number.isFinite(headTop) && headTop > head.y ? headTop : box.maxY;
      const top = Math.max(head.y + torso * HALF.headMin, Math.min(reach, box.maxY, head.y + torso * HALF.headMax));
      const bottom = Math.max(box.minY, hips.y + torso * HALF.waist);
      // the visible box of the half-body picture: from the cut up to her top as drawn (what pokes out above the
      // band, within the air left above her head, is drawn too)
      const drawnTop = Math.min(box.maxY, top + ((top - bottom) * HALF.margin) / (1 - HALF.margin));
      const width = headBox && Number.isFinite(headBox.minX) && Number.isFinite(headBox.maxX) ? headBox.maxX - headBox.minX : 0;
      if (top > bottom) return { top, bottom, cx: (head.x + hips.x) / 2, width, source: 'bones', cut: clamp01((drawnTop - bottom) / fullH) };
    }
    const bottom = box.maxY - fullH * HALF_BOX;
    return { top: box.maxY, bottom, cx: boxCx, width: 0, source: 'box', cut: HALF_BOX };
  }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  // Where the camera goes for a band of world heights [bottom, top]. `share`: her share of the canvas height
  // (pack.json vrm.height); `fov`: vertical field of view (degrees); `mode`: 'full' stands her feet on the floor
  // with a sliver of air below; 'half' puts the cut exactly at the canvas' bottom edge (she rises out of it) and
  // leaves `HALF.margin` of air above her head; a head wider than that picture allows (`width` of the band, the
  // canvas `aspect` = width / height) widens the view so HALF.fitWidth of it fits (more air above then), but never
  // beyond `maxVisible` (the 全身 view: 半身 never shows her smaller than 全身 does).
  // -> { visible (world height the canvas shows), y (camera height = where it looks), dist (from her) }
  function cameraFor({ top, bottom, width = 0 }, { fov = 22, share = 0.8, mode = 'full', aspect = 332 / 452, maxVisible = Infinity } = {}) {
    const h = Math.max(1e-6, top - bottom);
    const tight = h / (1 - HALF.margin);
    const visible = mode === 'half' ? Math.max(tight, Math.min(maxVisible, (width * HALF.fitWidth) / aspect)) : h / share;
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


  // ---- Live2D -----------------------------------------------------------------------------------------
  // A Live2D model is a flat picture: no bones, so where her waist is comes from (most trusted first)
  //   'pack'    pack.json halfBody.waist (share of her height, top of head 0 .. soles 1),
  //   'hitarea' the model's own Head hit area (.model3.json HitAreas): her head's height → the waist,
  //   'eyes'    the drawables ParamEyeLOpen moves (every Cubism model has eyes): eye line → head → waist,
  //   'default' L2D.dflt of her height.
  // A head of share h of her height puts the waist at about L2D.k0 + L2D.k1·h (an adult head ≈ 1/7.5 of her
  // height → waist ≈ 0.40; a chibi head ≈ 1/3 → ≈ 0.57), within L2D.min..max. From the top of her hair the eyes
  // are about two thirds of the way down to her chin (hair adds volume on top): head ≈ 1.5 × (eyes − top).
  const L2D = { k0: 0.285, k1: 0.86, min: 0.3, max: 0.75, dflt: 0.55, eyesToHead: 1.5 };
  const waistFromHead = (h) => Math.max(L2D.min, Math.min(L2D.max, L2D.k0 + L2D.k1 * h));

  // `content`: her drawn extent in model pixels (y down): { top, bottom, minX, maxX } (opaque drawables at rest);
  // `waist`: pack.json halfBody.waist; `head`: the Head hit area { top, bottom, minX, maxX }; `eyes`: the eyes'
  // extent { top, bottom, minX, maxX } (model px).
  // -> { top (her head's top), bottom (the cut, model px), cx (centre to frame: her head's, else the content's),
  //      waist (share of her height), source, cut (share of her height shown — touch zones) }
  function live2dHalfBand({ content, waist = null, head = null, eyes = null } = {}) {
    const c = content;
    const H = Math.max(1e-6, c.bottom - c.top);
    const mid = (b) => (b.minX + b.maxX) / 2;
    const fine = (b) => b && [b.top, b.bottom, b.minX, b.maxX].every(Number.isFinite) && b.bottom > b.top;
    let share = null;
    let source = 'default';
    let cx = mid(c);
    if (isWaist(waist)) { share = waist; source = 'pack'; }
    if (fine(head) && head.bottom > c.top && head.bottom - c.top < H * 0.7) {
      if (share == null) { share = waistFromHead((head.bottom - c.top) / H); source = 'hitarea'; }
      cx = mid(head);
    } else if (fine(eyes) && eyes.top > c.top) {
      const eyeY = (eyes.top + eyes.bottom) / 2;
      if (share == null && eyeY - c.top < H * 0.45) { share = waistFromHead((L2D.eyesToHead * (eyeY - c.top)) / H); source = 'eyes'; }
      cx = mid(eyes);
    }
    if (share == null) share = L2D.dflt;
    const bottom = c.top + H * share;
    return { top: c.top, bottom, cx, waist: share, source, cut: clamp01(share) };
  }

  // Where the model goes in the canvas (W × H px) for a framing: { s (scale), x, y (model's top-left) }.
  // `model`: its size at scale 1 (w, h, model px); `share`: her share of the canvas height in 全身 (pack.json
  // live2d.height). 全身 is the old fit exactly: model height × share, feet just above the bottom, centred.
  // 半身: the band (top of her head → the cut) fills the canvas, the cut on its bottom edge, HALF.margin of air
  // above her head, her head centred sideways; never smaller than 全身.
  function live2dPlacement(band, { W, H, model, share = 0.8, mode = 'full' }) {
    const sFull = (H * share) / Math.max(1e-6, model.h);
    const full = { s: sFull, x: (W - model.w * sFull) / 2, y: H * 0.995 - model.h * sFull };
    if (mode !== 'half' || !band) return full;
    const visible = Math.max(1e-6, band.bottom - band.top) / (1 - HALF.margin);
    const s = Math.max(sFull, H / visible);
    return { s, x: W / 2 - band.cx * s, y: H - band.bottom * s };
  }
  // two placements mixed (the switch glides, eased like blendCamera)
  function blendPlacement(a, b, t) {
    const k = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    return { s: a.s + (b.s - a.s) * k, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
  }

  // A touch on the half-body picture, in her full-body proportions: the visible box of the half-body picture
  // spans the top `cut` of her, so y (0..1 down that box) is y·cut of her full height. Parts below the cut
  // (legs, feet; the hips as the cut sits at the waist) cannot be reached.
  function toFullBody(pt, framing) {
    if (!pt || !framing || framing.mode !== 'half' || !(framing.cut > 0)) return pt;
    return { ...pt, y: pt.y * Math.min(1, framing.cut) };
  }

  return { FRAMINGS, DEFAULT, SUPPORTED_KINDS, WAIST_RANGE, HALF, HALF_BOX, L2D, isWaist, waistFromHead, live2dHalfBand, live2dPlacement, blendPlacement, isFraming, normalizeFraming, normalizeFramings, resolveFraming, halfBodyBand, cameraFor, blendCamera, toFullBody };
});
