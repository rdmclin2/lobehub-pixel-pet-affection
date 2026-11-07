'use strict';
// 桌面壁纸 · 壁纸包校验 (engine `wallpaper@1`, docs/wallpaper-mode.md §3). A wallpaper pack is a flat folder like
// every game pack: manifest.json (kind 'wallpaper') and the pictures it names — `preview` and every `layers[].image`
// (.webp / .png only). No entry, script, HTML, shader or URL: the app's own engine (src/renderer/wallpaper/) draws it,
// so nothing downloaded is ever run as code. Every number is bounded; a picture's size is read from its file header
// (PNG IHDR / WebP VP8X · VP8 · VP8L) without decoding it, so a hostile header cannot make the app allocate a giant
// texture: one picture ≤ 7680×4320, all layers together ≤ 64 MP, preview ≤ 1920×1080.
//
// validateWallpaper() runs from game-pack.js validateManifest() after the common fields (schema, id, name, version).
// Electron-free and DOM-free (main, the games repository's build script and the tests require() it).

const ENGINE = 'wallpaper@1';
const KIND = 'wallpaper';
const PHASES = ['dawn', 'day', 'dusk', 'night'];
const WEATHERS = ['clear', 'cloudy', 'rain', 'storm', 'snow', 'fog'];
const BLENDS = ['normal', 'add', 'screen', 'multiply'];
const FITS = ['cover', 'contain'];
const IMAGE_RE = /\.(webp|png)$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const LAYER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LIMITS = {
  canvasW: [640, 7680], canvasH: [360, 4320], layers: 16, layerZ: [-100, 100], drift: 200,
  imageW: 7680, imageH: 4320, totalPixels: 64 * 1000 * 1000, previewW: 1920, previewH: 1080,
  petHeight: [16, 800], petSpeed: [1, 400], spots: 16, spotSeconds: 600, fireflies: 40, lights: 32, lightR: [1, 2000],
  fps: [1, 30], name: 40, description: 400, credit: 200,
};
// fields a wallpaper may never carry: they would be a way to run or fetch something
const FORBIDDEN = ['entry', 'main', 'html', 'script', 'scripts', 'shader', 'shaders', 'url', 'urls', 'video', 'iframe'];

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => Number.isInteger(v);
const inRange = (v, [a, b]) => num(v) && v >= a && v <= b;
const pt = (p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);
const poly = (p) => Array.isArray(p) && p.length >= 3 && p.every(pt);
const shape = (s) => poly(s) || (s && num(s.cx) && num(s.cy) && num(s.rx) && num(s.ry) && s.rx > 0 && s.ry > 0);
const phasesOk = (a) => Array.isArray(a) && a.length > 0 && a.every((p) => PHASES.includes(p));

function inPoly(p, x, y) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- picture headers ---------------------------------------------------------------------------------------
// { type, width, height } from the first bytes of a PNG / WebP, or null when it is neither (or truncated)
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG: 8-byte signature, then the IHDR chunk: width / height big-endian at 16 / 20
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' && buf.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP' || buf.length < 30) return null;
  const chunk = buf.toString('latin1', 12, 16);
  // VP8X (extended): 24-bit canvas width-1 / height-1 at 24 / 27
  if (chunk === 'VP8X') return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  // VP8 (lossy): the key frame's start code 9d 01 2a at 23, then 14-bit width / height at 26 / 28
  if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return { type: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  // VP8L (lossless): signature 0x2f at 20, then 14-bit width-1 / height-1 packed from bit 0 of byte 21
  if (chunk === 'VP8L' && buf[20] === 0x2f) {
    const b = buf.readUInt32LE(21);
    return { type: 'webp', width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  return null;
}

// every file the manifest names (besides manifest.json): what game:// serves and what may be in the folder
function namedFiles(m) {
  if (!m || typeof m !== 'object') return [];
  const out = [];
  if (typeof m.preview === 'string') out.push(m.preview);
  for (const l of Array.isArray(m.layers) ? m.layers : []) if (l && typeof l.image === 'string') out.push(l.image);
  return [...new Set(out)];
}
// a wallpaper has no sprites index (she comes from her own character pack)
const spriteFiles = () => [];

// → [error…]. `files`: the names in the folder (when checking one on disk); `dims`: { <file>: { width, height } | null }
// read from the headers (game-store.js checkFolder); `fileRe`: game-pack.js FILE_RE; `anims`: game-pack.js USE_ANIMS.
function validateWallpaper(m, { files = null, dims = null, fileRe = /^[a-z0-9][a-z0-9._-]{0,63}\.(webp|png|json)$/, anims = [] } = {}) {
  const e = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.kind !== KIND) e.push(`kind must be "${KIND}" for ${ENGINE}`);
  for (const k of FORBIDDEN) if (m[k] !== undefined) e.push(`"${k}" is not allowed in a wallpaper (data only)`);
  if (typeof m.name === 'string' && m.name.length > LIMITS.name) e.push(`name is longer than ${LIMITS.name}`);
  if (m.description !== undefined && !(typeof m.description === 'string' && m.description.length <= LIMITS.description)) e.push(`description must be text up to ${LIMITS.description}`);
  if (m.credit !== undefined && !(typeof m.credit === 'string' && m.credit.length <= LIMITS.credit)) e.push(`credit must be text up to ${LIMITS.credit}`);

  // canvas: the design size every coordinate lives in
  const c = m.canvas && typeof m.canvas === 'object' ? m.canvas : null;
  if (!c) e.push('canvas is missing');
  else {
    if (!(int(c.width) && inRange(c.width, LIMITS.canvasW))) e.push(`canvas.width must be an integer ${LIMITS.canvasW.join('–')}`);
    if (!(int(c.height) && inRange(c.height, LIMITS.canvasH))) e.push(`canvas.height must be an integer ${LIMITS.canvasH.join('–')}`);
    if (c.background !== undefined && !COLOR_RE.test(String(c.background))) e.push('canvas.background must be #rrggbb');
    if (c.fit !== undefined && !FITS.includes(c.fit)) e.push(`canvas.fit must be ${FITS.join(' / ')}`);
    if (c.focus !== undefined && !(pt(c.focus) && c.focus.every((v) => v >= 0 && v <= 1))) e.push('canvas.focus must be [0–1, 0–1]');
  }
  const W = c && int(c.width) ? c.width : 0;
  const H = c && int(c.height) ? c.height : 0;
  const inCanvas = (p) => pt(p) && p[0] >= 0 && p[1] >= 0 && p[0] <= W && p[1] <= H;

  // the pictures: allowed names, in the folder, sizes from their headers
  const picture = (f, at) => {
    if (typeof f !== 'string' || !fileRe.test(f) || !IMAGE_RE.test(f)) { e.push(`${at}: file name "${f}" is not allowed (.webp / .png)`); return null; }
    if (files && !files.includes(f)) { e.push(`${at}: ${f} is missing`); return null; }
    if (!dims) return null;
    const d = dims[f];
    if (!d) { e.push(`${at}: ${f} is not a PNG / WebP picture`); return null; }
    return d;
  };
  const pv = picture(m.preview, 'preview');
  if (pv && (pv.width > LIMITS.previewW || pv.height > LIMITS.previewH)) e.push(`preview: ${pv.width}×${pv.height} is larger than ${LIMITS.previewW}×${LIMITS.previewH}`);

  const layers = Array.isArray(m.layers) ? m.layers : null;
  if (!layers || layers.length < 1 || layers.length > LIMITS.layers) e.push(`layers must be a list of 1–${LIMITS.layers}`);
  const ids = new Set();
  const seen = new Set();
  let pixels = 0;
  for (const [i, l] of (layers || []).slice(0, LIMITS.layers).entries()) {
    const at = `layers[${i}]`;
    if (!l || typeof l !== 'object') { e.push(`${at} is not an object`); continue; }
    if (!LAYER_ID_RE.test(String(l.id || ''))) e.push(`${at}: id must be 1–32 of a-z 0-9 -`);
    else if (ids.has(l.id)) e.push(`${at}: id "${l.id}" twice`);
    ids.add(l.id);
    const d = picture(l.image, at);
    if (d) {
      if (d.width > LIMITS.imageW || d.height > LIMITS.imageH) e.push(`${at}: ${l.image} is ${d.width}×${d.height}, larger than ${LIMITS.imageW}×${LIMITS.imageH}`);
      if (!seen.has(l.image)) pixels += d.width * d.height;
      seen.add(l.image);
    }
    if (!(int(l.z) && inRange(l.z, LIMITS.layerZ))) e.push(`${at}: z must be an integer ${LIMITS.layerZ.join('…')}`);
    if (l.drift !== undefined && !(pt(l.drift) && l.drift.every((v) => Math.abs(v) <= LIMITS.drift))) e.push(`${at}: drift must be [x, y] with |v| ≤ ${LIMITS.drift}`);
    if (l.loop !== undefined && typeof l.loop !== 'boolean') e.push(`${at}: loop must be true / false`);
    if (l.opacity !== undefined && !inRange(l.opacity, [0, 1])) e.push(`${at}: opacity must be 0–1`);
    if (l.blend !== undefined && !BLENDS.includes(l.blend)) e.push(`${at}: blend must be ${BLENDS.join(' / ')}`);
    if (l.phases !== undefined && !phasesOk(l.phases)) e.push(`${at}: phases must be some of ${PHASES.join(' ')}`);
  }
  if (pixels > LIMITS.totalPixels) e.push(`layers: ${(pixels / 1e6).toFixed(1)} MP in all, more than ${LIMITS.totalPixels / 1e6} MP`);

  // sky / fx
  if (m.sky !== undefined) {
    const s = m.sky && typeof m.sky === 'object' ? m.sky : null;
    if (!s) e.push('sky must be an object');
    else {
      for (const k of ['phases', 'tint']) if (s[k] !== undefined && typeof s[k] !== 'boolean') e.push(`sky.${k} must be true / false`);
      if (s.weather !== undefined && !(Array.isArray(s.weather) && s.weather.length && s.weather.every((w) => WEATHERS.includes(w)))) e.push(`sky.weather must be some of ${WEATHERS.join(' ')}`);
    }
  }
  if (m.fx !== undefined) {
    const f = m.fx && typeof m.fx === 'object' ? m.fx : null;
    if (!f) e.push('fx must be an object');
    else {
      for (const k of ['rain', 'snow']) if (f[k] !== undefined && typeof f[k] !== 'boolean') e.push(`fx.${k} must be true / false`);
      if (f.fireflies !== undefined && !(int(f.fireflies) && inRange(f.fireflies, [0, LIMITS.fireflies]))) e.push(`fx.fireflies must be 0–${LIMITS.fireflies}`);
      if (f.lights !== undefined) {
        if (!(Array.isArray(f.lights) && f.lights.length <= LIMITS.lights)) e.push(`fx.lights must be a list of at most ${LIMITS.lights}`);
        else f.lights.forEach((l, i) => { if (!(l && inCanvas([l.x, l.y]) && inRange(l.r, LIMITS.lightR) && (l.phases === undefined || phasesOk(l.phases)))) e.push(`fx.lights[${i}] must be { x, y in the canvas, r 1–2000, phases? }`); });
      }
    }
  }

  // her: where she walks, where she starts, the spots she uses
  const p = m.pet && typeof m.pet === 'object' ? m.pet : null;
  if (!p) e.push('pet is missing');
  else {
    if (!inRange(p.height, LIMITS.petHeight)) e.push(`pet.height must be ${LIMITS.petHeight.join('–')}`);
    if (p.speed !== undefined && !inRange(p.speed, LIMITS.petSpeed)) e.push(`pet.speed must be ${LIMITS.petSpeed.join('–')}`);
    if (p.z !== undefined && !(int(p.z) && inRange(p.z, LIMITS.layerZ))) e.push(`pet.z must be an integer ${LIMITS.layerZ.join('…')}`);
    const areaOk = poly(p.area) && p.area.every(inCanvas);
    if (!areaOk) e.push('pet.area must be a polygon of ≥ 3 points inside the canvas');
    if (p.blocked !== undefined && !(Array.isArray(p.blocked) && p.blocked.every(shape))) e.push('pet.blocked must be polygons / ellipses');
    if (!pt(p.spawn)) e.push('pet.spawn must be [x, y]');
    else if (areaOk && !inPoly(p.area, p.spawn[0], p.spawn[1])) e.push('pet.spawn is outside pet.area');
    if (p.spots !== undefined) {
      if (!(Array.isArray(p.spots) && p.spots.length <= LIMITS.spots)) e.push(`pet.spots must be a list of at most ${LIMITS.spots}`);
      else {
        const sids = new Set();
        p.spots.forEach((s, i) => {
          const at = `pet.spots[${i}]`;
          if (!s || typeof s !== 'object' || !LAYER_ID_RE.test(String(s.id || ''))) { e.push(`${at}: id is missing`); return; }
          if (sids.has(s.id)) e.push(`${at}: id "${s.id}" twice`);
          sids.add(s.id);
          if (!pt(s.at) || (areaOk && !inPoly(p.area, s.at[0], s.at[1]))) e.push(`${at} (${s.id}): at must be inside pet.area`);
          if (!anims.includes(s.anim)) e.push(`${at} (${s.id}): anim "${s.anim}" is not one of ${anims.join(' ')}`);
          if (!(Array.isArray(s.seconds) && s.seconds.length === 2 && s.seconds.every(num) && s.seconds[0] > 0 && s.seconds[0] <= s.seconds[1] && s.seconds[1] <= LIMITS.spotSeconds)) e.push(`${at} (${s.id}): seconds must be [min, max], 0 < min ≤ max ≤ ${LIMITS.spotSeconds}`);
          if (s.face !== undefined && !['left', 'right'].includes(s.face)) e.push(`${at} (${s.id}): face must be left / right`);
          if (s.phases !== undefined && !phasesOk(s.phases)) e.push(`${at} (${s.id}): phases must be some of ${PHASES.join(' ')}`);
        });
      }
    }
  }
  if (m.power !== undefined && !(m.power && typeof m.power === 'object' && (m.power.fps === undefined || (int(m.power.fps) && inRange(m.power.fps, LIMITS.fps))))) e.push(`power.fps must be an integer ${LIMITS.fps.join('–')}`);
  return e;
}

// what the engine gets: only the known fields, strings cut, defaults filled in (unknown fields are not carried)
function cleanWallpaper(m) {
  const c = m.canvas || {};
  const p = m.pet || {};
  return {
    id: m.id, name: String(m.name).slice(0, LIMITS.name), version: m.version, engine: ENGINE,
    canvas: { width: c.width, height: c.height, background: COLOR_RE.test(String(c.background)) ? c.background : '#000000', fit: FITS.includes(c.fit) ? c.fit : 'cover', focus: pt(c.focus) ? c.focus.slice() : [0.5, 0.5] },
    preview: m.preview,
    layers: m.layers.map((l) => ({ id: l.id, image: l.image, z: l.z, drift: pt(l.drift) ? l.drift.slice() : null, loop: l.loop === true, opacity: num(l.opacity) ? l.opacity : 1, blend: BLENDS.includes(l.blend) ? l.blend : 'normal', phases: phasesOk(l.phases) ? l.phases.slice() : null })).sort((a, b) => a.z - b.z),
    sky: { phases: !!(m.sky && m.sky.phases), tint: !!(m.sky && m.sky.tint), weather: m.sky && Array.isArray(m.sky.weather) ? m.sky.weather.slice() : ['clear'] },
    fx: { rain: !!(m.fx && m.fx.rain), snow: !!(m.fx && m.fx.snow), fireflies: (m.fx && m.fx.fireflies) || 0, lights: (m.fx && Array.isArray(m.fx.lights) ? m.fx.lights : []).map((l) => ({ x: l.x, y: l.y, r: l.r, phases: phasesOk(l.phases) ? l.phases.slice() : null })) },
    pet: { height: p.height, speed: num(p.speed) ? p.speed : 60, z: int(p.z) ? p.z : 20, spawn: p.spawn.slice(), area: p.area.map((q) => q.slice()), blocked: Array.isArray(p.blocked) ? p.blocked : [], spots: (p.spots || []).map((s) => ({ id: s.id, at: s.at.slice(), anim: s.anim, seconds: s.seconds.slice(), face: s.face || null, phases: phasesOk(s.phases) ? s.phases.slice() : null })) },
    power: { fps: m.power && int(m.power.fps) ? m.power.fps : 30 },
  };
}

module.exports = { ENGINE, KIND, PHASES, WEATHERS, BLENDS, LIMITS, FORBIDDEN, imageSize, namedFiles, spriteFiles, validateWallpaper, cleanWallpaper, inPoly };
