'use strict';
// 她的房间 · 游戏包校验 (engine `illustrated-room@1`, docs/illustrated-room.md §2, design: docs/illustrated-room-design.md §5).
// An illustrated room pack is a flat folder: manifest.json and the pictures it names. Every state of a room is one
// whole illustration (her pose drawn into the room), twice — `off` (the desk lamp off, moonlight) and `lit` (the lamp
// on) — and everything that moves is drawn by the engine over it: the lamp's glow, rain and bokeh in the window,
// the screens' content, her breathing and blinking, the crossfade between states. The numbers (energy, mood …) are
// the same rules as 像素房间 (core/room-play.js): the manifest's top-level `activities`, bounded here.
//
//   manifest.json  { schema: 1, kind: 'game', engine: 'illustrated-room@1', id, name, version, description, credit,
//                    defaultRoom, activities: { sleep|work|phone|music|game|idle: { label, seconds, deltas, needs } },
//                    rooms: [room…], quests: [ … ] }
//   room           { id, character, status: 'open' | 'soon', name, blurb, palette, world: { width, height, background },
//                    lighting: { lamp: { default, at, glow: { r, alpha, color }, rampOn, rampOff, flicker }, grade },
//                    window: { panes: [poly…] | poly, rain, bokeh }, screens: { <id>: { corners, size, glow } },
//                    states: { <key>: state }, defaultState, transition: { seconds }, content, hotspots, intents, lines,
//                    images / frames / sprites (optional atlases) }
//   content        { clips: { fps, swipeEvery, list: [{ id, caption, author, likes, scene | frames: true, pingpong }] },
//                    page: { seconds, templates: [{ id, title, url, image? }] }, player: { tracks: [{ title, artist,
//                    seconds, cover?, lyrics?: [[seconds, line]…] }] }, game }. cover and image name a key of `images`;
//                    `frames.clips` indexes `images.clips` with frames named "<clip id>-<nn>".
//   state          { activity, label, images: { off, lit? }, breath: { rect, amp, period }, blink, screens:
//                    { <screen id>: { content, on, corners? } }, bubble, lampOnEnter, fx, transient, enterVia, zone }
//
// Electron-free and DOM-free (main, the build script and the tests require() it).

const ENGINE = 'illustrated-room@1';
const KINDS = ['sleep', 'work', 'phone', 'music', 'game', 'idle'];
const STATS = ['energy', 'mood', 'focus', 'fullness'];
const CONTENT = ['lock', 'clips', 'page', 'player', 'game', 'chat', 'off'];
const CLIP_SCENES = ['jellyfish', 'rain-window', 'hearts', 'city', 'cat'];
const LIMITS = { rooms: 12, states: 16, screens: 4, hotspots: 12, files: 40, words: 24, wordLen: 12, line: 60, lyrics: 80 };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pt = (p) => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);
const poly = (p) => Array.isArray(p) && p.length >= 3 && p.every(pt);
const inRange = (v, a, b) => num(v) && v >= a && v <= b;
const pair = (p, a, b) => Array.isArray(p) && p.length === 2 && p.every((v) => inRange(v, a, b)) && p[0] <= p[1];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// four corners (top-left, top-right, bottom-right, bottom-left) making a convex quad: every turn the same way
function convexQuad(c) {
  if (!(Array.isArray(c) && c.length === 4 && c.every(pt))) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, d] = [c[i], c[(i + 1) % 4], c[(i + 2) % 4]];
    const z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (!z) return false;
    if (sign && Math.sign(z) !== sign) return false;
    sign = Math.sign(z);
  }
  return true;
}

// the window's panes: `panes` (one polygon per pane) or the design's single `poly`
const panesOf = (w) => (w && Array.isArray(w.panes) ? w.panes : w && w.poly ? [w.poly] : []);
// the pictures a state shows
const imagesOf = (s) => (s && isObj(s.images) ? [s.images.off, s.images.lit].filter((f) => typeof f === 'string') : []);

// → [error…]. `files`: the folder's file names (null: not checked). `sprites`: { <index file>: JSON } of the atlases'
// indexes (null: not checked). `fileRe`: game-pack.js FILE_RE.
function validateIllustratedRoom(m, { files = null, sprites = null, fileRe = /^[a-z0-9][a-z0-9._-]{0,63}\.(webp|png|json)$/ } = {}) {
  const e = [];
  // activities: the numbers, the same bounds as room@1
  const acts = isObj(m.activities) ? m.activities : null;
  if (!acts) e.push('activities is missing');
  else {
    for (const k of Object.keys(acts)) if (!KINDS.includes(k)) e.push(`activities.${k}: not an activity this app knows (${KINDS.join(' ')})`);
    for (const k of KINDS) {
      const a = acts[k];
      if (!isObj(a)) { e.push(`activities.${k} is missing`); continue; }
      if (typeof a.label !== 'string' || !a.label.trim()) e.push(`activities.${k}.label is missing`);
      if (k === 'idle') { if (a.seconds !== undefined && a.seconds !== 0) e.push('activities.idle.seconds must be 0 (发呆 is not timed)'); if (a.deltas && Object.keys(a.deltas).length) e.push('activities.idle cannot move numbers'); continue; }
      if (!(num(a.seconds) && a.seconds >= 5 && a.seconds <= 600)) e.push(`activities.${k}.seconds must be 5–600`);
      if (a.deltas !== undefined) {
        if (!isObj(a.deltas)) e.push(`activities.${k}.deltas must be an object`);
        else for (const [s, v] of Object.entries(a.deltas)) {
          if (!STATS.includes(s)) e.push(`activities.${k}.deltas.${s}: only ${STATS.join(' / ')}`);
          else if (!inRange(v, -40, 40)) e.push(`activities.${k}.deltas.${s} must be −40…40`);
        }
      }
      if (a.needs !== undefined) {
        if (!isObj(a.needs) || Object.keys(a.needs).some((s) => s !== 'energy')) e.push(`activities.${k}.needs: only energy`);
        else if (!inRange(a.needs.energy, 0, 100)) e.push(`activities.${k}.needs.energy must be 0–100`);
      }
    }
  }
  const rooms = Array.isArray(m.rooms) ? m.rooms : null;
  if (!rooms || !rooms.length) return [...e, 'rooms must be a non-empty list'];
  if (rooms.length > LIMITS.rooms) e.push(`at most ${LIMITS.rooms} rooms`);
  const ids = new Set();
  for (const [i, r] of rooms.entries()) {
    const at = `rooms[${i}]${r && r.id ? ` (${r.id})` : ''}`;
    if (!isObj(r)) { e.push(`${at} is not an object`); continue; }
    if (!ID_RE.test(String(r.id || ''))) { e.push(`${at}.id must be 1–32 of a-z 0-9 -`); continue; }
    if (ids.has(r.id)) e.push(`${at}: id twice`);
    ids.add(r.id);
    if (typeof r.character !== 'string' || !r.character) e.push(`${at}.character is missing`);
    if (!['open', 'soon'].includes(r.status)) e.push(`${at}.status must be open / soon`);
    if (typeof r.name !== 'string' || !r.name.trim()) e.push(`${at}.name is missing`);
    if (r.palette !== undefined && !(isObj(r.palette) && Object.values(r.palette).every((c) => COLOR_RE.test(String(c))))) e.push(`${at}.palette: colours are #rrggbb`);
    if (r.status === 'open') e.push(...validateOpenRoom(r, at, { files, sprites, fileRe }));
  }
  const def = rooms.find((r) => r && r.id === m.defaultRoom);
  if (!def || def.status !== 'open') e.push('defaultRoom must be an open room');
  for (const [i, q] of (Array.isArray(m.quests) ? m.quests : []).entries()) {
    if (!q || typeof q.id !== 'string' || typeof q.title !== 'string' || !q.on || typeof q.on.type !== 'string') e.push(`quests[${i}]: id / title / on.type`);
    else if (!['activity-end', 'chat-command', 'lamp', 'state'].includes(q.on.type)) e.push(`quests[${i}] (${q.id}): on.type "${q.on.type}"`);
  }
  if (m.quests !== undefined && !Array.isArray(m.quests)) e.push('quests must be a list');
  return e;
}

function validateOpenRoom(r, at, { files, sprites, fileRe }) {
  const e = [];
  const w = r.world || {};
  if (!(inRange(w.width, 64, 4096) && inRange(w.height, 64, 4096))) { e.push(`${at}.world.width / height must be 64–4096`); return e; }
  const inWorld = (p) => pt(p) && p[0] >= 0 && p[1] >= 0 && p[0] <= w.width && p[1] <= w.height;
  const rectIn = (q) => Array.isArray(q) && q.length === 4 && q.every(num) && q[2] > 0 && q[3] > 0 && inWorld([q[0], q[1]]) && inWorld([q[0] + q[2], q[1] + q[3]]);
  // files: named, allowed, there, prefixed with the room's id
  const named = new Set();
  const file = (f, where) => {
    if (typeof f !== 'string' || !f) { e.push(`${at}.${where} is missing`); return; }
    named.add(f);
    if (!fileRe.test(f)) e.push(`${at}.${where}: file name "${f}" is not allowed`);
    else if (!f.startsWith(`${r.id}-`)) e.push(`${at}.${where}: "${f}" must start with "${r.id}-"`);
    else if (files && !files.includes(f)) e.push(`${at}.${where}: ${f} is missing`);
  };
  for (const k of ['images', 'frames']) if (r[k] !== undefined) {
    if (!isObj(r[k])) e.push(`${at}.${k} must be an object`);
    else for (const [n, f] of Object.entries(r[k])) file(f, `${k}.${n}`);
  }
  if (r.sprites !== undefined) file(r.sprites, 'sprites');
  const spriteIndex = sprites && typeof r.sprites === 'string' ? sprites[r.sprites] || null : null;
  const hasSprite = (n) => !spriteIndex || Object.hasOwn(spriteIndex, n);
  // lighting
  const L = r.lighting || {};
  const lamp = L.lamp;
  if (lamp !== undefined) {
    if (!isObj(lamp)) e.push(`${at}.lighting.lamp must be an object`);
    else {
      if (!inWorld(lamp.at)) e.push(`${at}.lighting.lamp.at must be a point in the world`);
      if (lamp.default !== undefined && typeof lamp.default !== 'boolean') e.push(`${at}.lighting.lamp.default must be true / false`);
      for (const k of ['rampOn', 'rampOff']) if (lamp[k] !== undefined && !inRange(lamp[k], 0, 3)) e.push(`${at}.lighting.lamp.${k} must be 0–3 s`);
      if (lamp.flicker !== undefined && !inRange(lamp.flicker, 0, 0.3)) e.push(`${at}.lighting.lamp.flicker must be 0–0.3`);
      if (lamp.glow !== undefined && !(isObj(lamp.glow) && inRange(lamp.glow.r, 8, 2000) && (lamp.glow.alpha === undefined || inRange(lamp.glow.alpha, 0, 1)) && (lamp.glow.color === undefined || COLOR_RE.test(lamp.glow.color)))) e.push(`${at}.lighting.lamp.glow: r 8–2000, alpha 0–1, color #rrggbb`);
      if (lamp.glow && lamp.glow.sprite && !hasSprite(lamp.glow.sprite)) e.push(`${at}.lighting.lamp.glow: no sprite "${lamp.glow.sprite}"`);
      if (lamp.mask !== undefined) file(lamp.mask, 'lighting.lamp.mask');
    }
  }
  if (L.grade !== undefined) {
    const g = L.grade;
    if (!isObj(g) || (g.saturation !== undefined && !inRange(g.saturation, 0, 2)) || (g.vignette !== undefined && !inRange(g.vignette, 0, 1)) || (g.tint !== undefined && !COLOR_RE.test(g.tint))) e.push(`${at}.lighting.grade: saturation 0–2, vignette 0–1, tint #rrggbb`);
  }
  // the window: panes in the world, rain and bokeh within bounds
  if (r.window !== undefined) {
    const win = r.window;
    const panes = panesOf(win);
    if (!panes.length || !panes.every((p) => poly(p) && p.every(inWorld))) e.push(`${at}.window: panes must be polygons in the world`);
    if (win.rain !== undefined && win.rain !== null) {
      const rn = win.rain;
      if (!isObj(rn) || !inRange(rn.density, 0, 400) || (rn.angle !== undefined && !inRange(rn.angle, -45, 45)) || (rn.speed !== undefined && !pair(rn.speed, 50, 5000)) || (rn.drops !== undefined && !inRange(rn.drops, 0, 120))) e.push(`${at}.window.rain: density 0–400, angle −45…45, speed [a, b] 50–5000, drops 0–120`);
    }
    if (win.bokeh !== undefined && win.bokeh !== null) {
      const b = win.bokeh;
      if (!isObj(b) || !inRange(b.count, 0, 200) || (b.r !== undefined && !pair(b.r, 1, 120)) || (b.period !== undefined && !pair(b.period, 0.5, 30)) || (b.warmRatio !== undefined && !inRange(b.warmRatio, 0, 1))) e.push(`${at}.window.bokeh: count 0–200, r [a, b] 1–120, period [a, b] 0.5–30, warmRatio 0–1`);
      else if (b.spots !== undefined && !(Array.isArray(b.spots) && b.spots.length <= 200 && b.spots.every((q) => Array.isArray(q) && q.length >= 3 && inWorld([q[0], q[1]]) && inRange(q[2], 1, 120)))) e.push(`${at}.window.bokeh.spots: up to 200 [x, y, r, warm?] in the world, r 1–120`);
    }
  }
  // screens
  const screens = isObj(r.screens) ? r.screens : {};
  if (r.screens !== undefined && !isObj(r.screens)) e.push(`${at}.screens must be an object`);
  if (Object.keys(screens).length > LIMITS.screens) e.push(`${at}: at most ${LIMITS.screens} screens`);
  for (const [id, s] of Object.entries(screens)) {
    if (!isObj(s)) { e.push(`${at}.screens.${id} must be an object`); continue; }
    if (s.corners !== undefined && !(convexQuad(s.corners) && s.corners.every(inWorld))) e.push(`${at}.screens.${id}.corners: four points in the world, a convex quad`);
    if (!(Array.isArray(s.size) && s.size.length === 2 && s.size.every((v) => inRange(v, 32, 1280)))) e.push(`${at}.screens.${id}.size must be [w, h], 32–1280`);
    if (s.glow !== undefined && !(isObj(s.glow) && inRange(s.glow.r, 4, 1000) && (s.glow.color === undefined || COLOR_RE.test(s.glow.color)))) e.push(`${at}.screens.${id}.glow: r 4–1000, color #rrggbb`);
  }
  // states
  const states = isObj(r.states) ? r.states : null;
  if (!states) { e.push(`${at}.states is missing`); return e; }
  const keys = Object.keys(states);
  if (keys.length > LIMITS.states) e.push(`${at}: at most ${LIMITS.states} states`);
  const usedContent = new Set();
  for (const [k, s] of Object.entries(states)) {
    const sa = `${at}.states.${k}`;
    if (!ID_RE.test(k)) e.push(`${sa}: key must be a-z 0-9 -`);
    if (!isObj(s)) { e.push(`${sa} must be an object`); continue; }
    if (s.transient) { if (s.activity !== null && s.activity !== undefined) e.push(`${sa}: a transient state has no activity`); }
    else if (!KINDS.includes(s.activity)) e.push(`${sa}.activity must be one of ${KINDS.join(' ')}`);
    if (!isObj(s.images) || typeof s.images.off !== 'string') e.push(`${sa}.images.off is missing`);
    else for (const n of ['off', 'lit']) if (s.images[n] !== undefined) file(s.images[n], `states.${k}.images.${n}`);
    if (s.breath !== undefined && s.breath !== null) {
      const b = s.breath;
      if (!isObj(b) || !rectIn(b.rect) || !inRange(b.amp, 0, 4) || !inRange(b.period, 1, 10)) e.push(`${sa}.breath: rect [x, y, w, h] in the world, amp 0–4, period 1–10`);
    }
    if (s.blink !== undefined && s.blink !== null) {
      const b = s.blink;
      const eyesOk = Array.isArray(b.eyes) && b.eyes.length >= 1 && b.eyes.length <= 2 && b.eyes.every((q) => Array.isArray(q) && q.length === 4 && q.every(num) && inWorld([q[0], q[1]]) && q[2] > 0 && q[3] > 0 && q[2] <= 120 && q[3] <= 120);
      const spriteOk = isObj(b.sprite) && typeof b.sprite.off === 'string' && inWorld(b.at);
      if (!isObj(b) || !(eyesOk || spriteOk)) e.push(`${sa}.blink: eyes [[cx, cy, rx, ry]…] (1–2) or sprite { off, lit } with at`);
      else {
        if (b.every !== undefined && !pair(b.every, 1, 20)) e.push(`${sa}.blink.every must be [a, b] 1–20 s`);
        if (spriteOk) for (const n of [b.sprite.off, b.sprite.lit].filter(Boolean)) if (!hasSprite(n)) e.push(`${sa}.blink: no sprite "${n}"`);
      }
    }
    if (s.bubble !== undefined && !inWorld(s.bubble)) e.push(`${sa}.bubble must be a point in the world`);
    if (s.hold !== undefined && !inRange(s.hold, 0, 5)) e.push(`${sa}.hold must be 0–5 s`);
    if (s.sway !== undefined && !(isObj(s.sway) && inRange(s.sway.amp, 0, 8) && inRange(s.sway.bpm, 20, 200))) e.push(`${sa}.sway: amp 0–8, bpm 20–200`);
    if (s.screens !== undefined) {
      if (!isObj(s.screens)) e.push(`${sa}.screens must be an object`);
      else for (const [sid, sc] of Object.entries(s.screens)) {
        if (!screens[sid]) { e.push(`${sa}.screens.${sid}: no such screen`); continue; }
        if (!isObj(sc) || !CONTENT.includes(sc.content)) { e.push(`${sa}.screens.${sid}.content must be one of ${CONTENT.join(' ')}`); continue; }
        const corners = sc.corners || screens[sid].corners;
        if (sc.corners !== undefined ? !(convexQuad(sc.corners) && sc.corners.every(inWorld)) : !corners) e.push(`${sa}.screens.${sid}.corners: four points in the world, a convex quad (here or on the screen)`);
        usedContent.add(sc.content);
      }
    }
    if (s.fx !== undefined && !(Array.isArray(s.fx) && s.fx.every((f) => isObj(f) && ['emit'].includes(f.type) && inWorld(f.from)))) e.push(`${sa}.fx: [{ type: 'emit', from, … }]`);
    if (s.zone !== undefined && typeof s.zone !== 'string') e.push(`${sa}.zone must be a name`);
    if (s.lines !== undefined && !(isObj(s.lines) && Object.values(s.lines).every((l) => Array.isArray(l) && l.every((t) => typeof t === 'string' && t.length <= LIMITS.line)))) e.push(`${sa}.lines: lists of lines ≤ ${LIMITS.line} characters`);
    if (s.variants !== undefined && !(Array.isArray(s.variants) && s.variants.every((v) => typeof v === 'string'))) e.push(`${sa}.variants must be a list of state keys`);
  }
  // the links between states, once every key is known
  for (const [k, s] of Object.entries(states)) {
    if (!isObj(s)) continue;
    if (s.enterVia !== undefined) {
      const v = states[s.enterVia];
      if (!v || !v.transient) e.push(`${at}.states.${k}.enterVia must be a transient state`);
    }
    for (const v of Array.isArray(s.variants) ? s.variants : []) {
      const vs = states[v];
      if (!vs || vs.transient || vs.activity !== s.activity) e.push(`${at}.states.${k}.variants: "${v}" must be a state of the same activity`);
    }
  }
  if (!states[r.defaultState] || states[r.defaultState].transient) e.push(`${at}.defaultState must be a state that is not transient`);
  for (const k of KINDS) if (!Object.values(states).some((s) => isObj(s) && !s.transient && s.activity === k)) e.push(`${at}: no state for the activity ${k}`);
  if (r.transition !== undefined && !(isObj(r.transition) && inRange(r.transition.seconds, 0.3, 4))) e.push(`${at}.transition.seconds must be 0.3–4`);
  // content: what the screens play
  const C = isObj(r.content) ? r.content : {};
  if (usedContent.has('clips')) {
    const list = C.clips && Array.isArray(C.clips.list) ? C.clips.list : [];
    if (!list.length) e.push(`${at}.content.clips.list: a screen plays clips, so at least one`);
    const frameIndex = sprites && r.frames && r.frames.clips ? sprites[r.frames.clips] || null : null;
    for (const [i, c] of list.entries()) {
      if (!isObj(c) || typeof c.id !== 'string' || !c.id) { e.push(`${at}.content.clips.list[${i}].id is missing`); continue; }
      if (c.scene !== undefined && !CLIP_SCENES.includes(c.scene)) e.push(`${at}.content.clips.list[${i}].scene must be one of ${CLIP_SCENES.join(' ')}`);
      if (c.scene === undefined && c.frames === undefined) e.push(`${at}.content.clips.list[${i}] (${c.id}): scene (drawn by the app) or frames (in the pack)`);
      if (c.frames !== undefined && !(r.frames && r.frames.clips)) e.push(`${at}.content.clips.list[${i}] (${c.id}): frames need frames.clips`);
      if (c.frames !== undefined && frameIndex && !Object.keys(frameIndex).some((f) => f.startsWith(`${c.id}-`) || f === c.id)) e.push(`${at}.content.clips.list[${i}] (${c.id}): no frames named "${c.id}-…" in ${r.frames.clips}`);
      if (c.caption !== undefined && (typeof c.caption !== 'string' || c.caption.length > LIMITS.line)) e.push(`${at}.content.clips.list[${i}].caption ≤ ${LIMITS.line} characters`);
    }
    if (C.clips && C.clips.swipeEvery !== undefined && !pair(C.clips.swipeEvery, 2, 120)) e.push(`${at}.content.clips.swipeEvery must be [a, b] 2–120 s`);
  }
  if (usedContent.has('player')) {
    const tracks = C.player && Array.isArray(C.player.tracks) ? C.player.tracks : [];
    if (!tracks.length) e.push(`${at}.content.player.tracks: a screen plays music, so at least one`);
    for (const [i, t] of tracks.entries()) {
      if (!isObj(t) || typeof t.title !== 'string' || !t.title || !inRange(t.seconds, 10, 1200)) { e.push(`${at}.content.player.tracks[${i}]: title and seconds 10–1200`); continue; }
      if (t.cover !== undefined && !(r.images && r.images[t.cover])) e.push(`${at}.content.player.tracks[${i}].cover: no images.${t.cover}`);
      if (t.lyrics !== undefined && !(Array.isArray(t.lyrics) && t.lyrics.length <= LIMITS.lyrics && t.lyrics.every((l) => Array.isArray(l) && l.length === 2 && inRange(l[0], 0, t.seconds) && typeof l[1] === 'string' && l[1].length <= LIMITS.line))) e.push(`${at}.content.player.tracks[${i}].lyrics: up to ${LIMITS.lyrics} [seconds within the track, line ≤ ${LIMITS.line} characters]`);
    }
  }
  if (usedContent.has('page') && C.page !== undefined) {
    if (!(isObj(C.page) && Array.isArray(C.page.templates) && C.page.templates.every((t) => isObj(t) && typeof t.id === 'string'))) e.push(`${at}.content.page.templates: [{ id, title, … }]`);
    else {
      if (C.page.seconds !== undefined && !inRange(C.page.seconds, 3, 120)) e.push(`${at}.content.page.seconds must be 3–120`);
      for (const [i, t] of C.page.templates.entries()) if (t.image !== undefined && !(r.images && r.images[t.image])) e.push(`${at}.content.page.templates[${i}].image: no images.${t.image}`);
    }
  }
  // hotspots
  const hs = r.hotspots === undefined ? [] : r.hotspots;
  if (!Array.isArray(hs)) e.push(`${at}.hotspots must be a list`);
  else {
    if (hs.length > LIMITS.hotspots) e.push(`${at}: at most ${LIMITS.hotspots} hotspots`);
    for (const [i, h] of hs.entries()) {
      const ha = `${at}.hotspots[${i}]${h && h.id ? ` (${h.id})` : ''}`;
      if (!isObj(h) || typeof h.id !== 'string' || !h.id) { e.push(`${ha}.id is missing`); continue; }
      if (!(poly(h.poly) && h.poly.every(inWorld))) e.push(`${ha}.poly must be a polygon in the world`);
      if (h.toggle !== undefined) { if (h.toggle !== 'lamp') e.push(`${ha}.toggle: only "lamp"`); }
      else if (!states[h.state] || states[h.state].transient) e.push(`${ha}.state must be a state that is not transient`);
    }
  }
  // intents: the words this room also understands (core/room-intent.js has the common ones)
  if (r.intents !== undefined) {
    if (!isObj(r.intents)) e.push(`${at}.intents must be an object`);
    else for (const [k, words] of Object.entries(r.intents)) {
      const list = k === 'screen' ? (isObj(words) ? Object.entries(words) : null) : [[null, words]];
      if (!list) { e.push(`${at}.intents.screen must be { <content>: [word…] }`); continue; }
      if (k !== 'screen' && !(states[k] && !states[k].transient) && !KINDS.includes(k)) e.push(`${at}.intents.${k}: not a state or an activity`);
      for (const [ck, ws] of list) {
        const where = ck ? `intents.screen.${ck}` : `intents.${k}`;
        if (ck && !CONTENT.includes(ck)) e.push(`${at}.${where}: not a screen content`);
        if (!Array.isArray(ws) || ws.length > LIMITS.words || !ws.every((w) => typeof w === 'string' && w.length >= 1 && w.length <= LIMITS.wordLen)) e.push(`${at}.${where}: up to ${LIMITS.words} words, each 1–${LIMITS.wordLen} characters`);
      }
    }
  }
  // lines
  const lineList = (l) => Array.isArray(l) && l.every((t) => typeof t === 'string' && t.length <= LIMITS.line);
  if (r.lines !== undefined) {
    if (!isObj(r.lines)) e.push(`${at}.lines must be an object`);
    else for (const [k, v] of Object.entries(r.lines)) {
      const ok = isObj(v) ? Object.values(v).every(lineList) : lineList(v);
      if (!ok) e.push(`${at}.lines.${k}: lines ≤ ${LIMITS.line} characters`);
    }
  }
  if (files) {
    const own = files.filter((f) => f.startsWith(`${r.id}-`));
    if (own.length > LIMITS.files) e.push(`${at}: at most ${LIMITS.files} files`);
  }
  return e;
}

// every file the manifest names (besides manifest.json)
function namedFiles(m) {
  const out = new Set();
  for (const r of (m && Array.isArray(m.rooms) ? m.rooms : [])) {
    if (!isObj(r) || r.status !== 'open') continue;
    for (const k of ['images', 'frames']) if (isObj(r[k])) for (const f of Object.values(r[k])) if (typeof f === 'string') out.add(f);
    if (typeof r.sprites === 'string') out.add(r.sprites);
    const lamp = r.lighting && r.lighting.lamp;
    if (lamp && typeof lamp.mask === 'string') out.add(lamp.mask);
    for (const s of Object.values(isObj(r.states) ? r.states : {})) for (const f of imagesOf(s)) out.add(f);
  }
  return [...out];
}
// the JSON indexes it names (atlas sprites, frame lists): read by main and handed to the page with the manifest
function spriteFiles(m) {
  const out = new Set();
  for (const r of (m && Array.isArray(m.rooms) ? m.rooms : [])) {
    if (!isObj(r) || r.status !== 'open') continue;
    if (typeof r.sprites === 'string') out.add(r.sprites);
    if (isObj(r.frames)) for (const f of Object.values(r.frames)) if (typeof f === 'string' && f.endsWith('.json')) out.add(f);
  }
  return [...out];
}

module.exports = { ENGINE, KINDS, CONTENT, CLIP_SCENES, LIMITS, validateIllustratedRoom, namedFiles, spriteFiles, convexQuad, panesOf };
