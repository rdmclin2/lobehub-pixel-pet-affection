'use strict';
// Shared effects layer (共享效果层): everything a companion does on the desktop, for every character.
// Ported from the DeepSeek pet dsh-pet (https://github.com/PC2005-cloud/dsh-pet): its 15 animation
// states, the weighted idle chain (look around / turn / walk / small actions), click reactions, squash on
// click, being lifted, the throw with gravity and bounces, the slingshot, scoring a hit on a flying pet,
// touch long-press, and pets knocking into each other. A character only supplies art for the
// states (video clips or a sprite pack); a state without art falls back along FALLBACK, so a character
// with a single idle frame still runs every effect. Pure and Electron-free: loaded by the renderer as
// a <script> (window.PetFx) and by the tests through require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetFx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // The state vocabulary: the DeepSeek pet's 15 clips plus `lifted` (being dragged) and `walk` (roaming).
  const STATES = ['idle', 'look', 'happy', 'pat', 'sad', 'hungry', 'sleep', 'eat_rice', 'eat_cookie', 'eat_fruit', 'think', 'talk', 'play', 'hatch', 'evolve', 'lifted', 'walk'];

  // Older sprite packs (schema 1) name some actions differently.
  const ALIASES = { pat: ['wave'], happy: ['cheer'], play: ['cheer'], hatch: ['cheer'], evolve: ['cheer'], eat_rice: ['eat'], eat_cookie: ['eat'], eat_fruit: ['eat'] };

  // What to show when a character has no art for a state: the closest state that it may have.
  const FALLBACK = {
    look: 'idle',
    happy: 'idle',
    pat: 'happy',
    sad: 'idle',
    hungry: 'sad',
    sleep: 'idle',
    eat_rice: 'happy',
    eat_cookie: 'eat_rice',
    eat_fruit: 'eat_rice',
    think: 'idle',
    talk: 'idle',
    play: 'happy',
    hatch: 'happy',
    evolve: 'happy',
    lifted: 'pat',
    walk: 'idle', // no walking art (the built-in packs have a step cycle): the idle art hops along (style.css [data-status="walk"])
  };

  // The chain of names tried for `state`, best first; always ends with idle.
  function chain(state) {
    const out = [];
    for (let s = state; s && !out.includes(s); s = FALLBACK[s]) {
      out.push(s);
      for (const a of ALIASES[s] || []) if (!out.includes(a)) out.push(a);
    }
    if (!out.includes('idle')) out.push('idle');
    return out;
  }

  // The art name to play for `state`, given what the character has (`has(name)` → boolean).
  // { name, exact }: exact = the character has its own art for this very state.
  function resolveAction(state, has) {
    const c = chain(STATES.includes(state) ? state : 'idle');
    for (const name of c) if (has(name)) return { name, exact: name === state || (ALIASES[state] || []).includes(name) };
    return { name: 'idle', exact: false };
  }

  // Emoji drawn over a character that has no own art for the state (a sprite or clip draws its own).
  const OVERLAY = { pat: '💕', sleep: '💤', hungry: '🍙?', sad: '💧', think: '💭', happy: '♪', talk: '…', lifted: '❗', walk: '👣', play: '♪', evolve: '✨', hatch: '✨', look: '👀' };
  const FOOD_OVERLAY = { eat_rice: '🍚', eat_cookie: '🍪', eat_fruit: '🍉' };

  // ---- the idle chain (dsh-pet pickers.ts / next-animation.ts) --------------------------------
  // While nothing else is going on, every 12–25 s the pet plays a short cue picked by weight.
  const IDLE_CUES = [
    { cue: 'look', weight: 4 }, // look around
    { cue: 'turn', weight: 3 }, // turn to face the other way (mirrors the character)
    { cue: 'walk', weight: 2 }, // walk a few steps the way it faces (only with roaming on): about 1 cue in 6
    { cue: 'play', weight: 1 }, // a small action of its own
    { cue: 'happy', weight: 1 },
  ];
  const IDLE_GAP = { min: 12000, max: 25000 };
  function idleDelay(rnd = Math.random) {
    return IDLE_GAP.min + Math.floor(rnd() * (IDLE_GAP.max - IDLE_GAP.min));
  }
  function pickWeighted(list, rnd = Math.random) {
    const total = list.reduce((n, x) => n + x.weight, 0);
    let r = rnd() * total;
    for (const x of list) {
      r -= x.weight;
      if (r < 0) return x;
    }
    return list[list.length - 1];
  }
  // The next idle cue; the same cue does not play twice in a row. Without roaming (the setting, like
  // dsh-pet's fixedEnabled) the pet never walks off on its own.
  function nextIdleCue(rnd = Math.random, prev = null, { roam = true } = {}) {
    const list = IDLE_CUES.filter((x) => x.cue !== prev && (roam || x.cue !== 'walk'));
    return pickWeighted(list, rnd).cue;
  }

  // A state's art may come in variants (a list of clips): pick one, not the one that played last.
  function pickVariant(list, prev = null, rnd = Math.random) {
    if (!Array.isArray(list)) return list;
    const pool = list.length > 1 ? list.filter((x) => x !== prev) : list;
    return pool[Math.floor(rnd() * pool.length) % pool.length];
  }

  // ---- roaming (dsh-pet motion.ts planMove, walk.ts) ------------------------------------------
  // A walk goes 60–240 px (at 100% size) the way the pet faces, turning round when that way runs off
  // the screen; the window moves at a steady pace with a short still start and end (lead / tail).
  const WALK = { minDist: 60, maxDist: 240, margin: 8, speed: 70, leadMs: 400, tailMs: 400 };
  function planWalk({ x, w, area, facing = 'right', scale = 1 }, rnd = Math.random) {
    const dist = Math.round((WALK.minDist + rnd() * (WALK.maxDist - WALK.minDist)) * Math.max(0.5, scale));
    const lo = area.x + WALK.margin;
    const hi = area.x + area.width - w - WALK.margin;
    const first = facing === 'left' ? -1 : 1;
    for (const dir of [first, -first]) {
      const toX = x + dir * dist;
      if (toX >= lo && toX <= hi) return { fromX: x, toX, dir, facing: dir < 0 ? 'left' : 'right', ms: WALK.leadMs + Math.round((dist / WALK.speed) * 1000) + WALK.tailMs };
    }
    return null;
  }
  // Where a walk is `t` ms in: still during the lead, a steady pace, still again for the tail.
  function walkX(plan, t) {
    const moveMs = plan.ms - WALK.leadMs - WALK.tailMs;
    const u = Math.min(1, Math.max(0, (t - WALK.leadMs) / Math.max(1, moveMs)));
    return Math.round(plan.fromX + (plan.toX - plan.fromX) * u);
  }

  // ---- clicks (dsh-pet animations.clicks): a random reaction, never the same one twice ---------
  const CLICK_REACTIONS = ['pat', 'happy'];
  function pickClickReaction(rnd = Math.random, prev = null) {
    const list = CLICK_REACTIONS.filter((x) => x !== prev);
    return list[Math.floor(rnd() * list.length) % list.length];
  }

  // How long a one-shot state plays. Video clips are ~10 s long; sprite loops are short.
  const ONE_SHOT_MS = {
    video: { look: 5000, turn: 0, play: 4000, happy: 3000, pat: 3000, sad: 3500, evolve: 3500, hatch: 2800, eat: 3500 },
    sprite: { look: 2500, turn: 0, play: 1800, happy: 1400, pat: 1200, sad: 2200, evolve: 2200, hatch: 1500, eat: 1600 },
  };
  const oneShotMs = (video, key) => (video ? ONE_SHOT_MS.video : ONE_SHOT_MS.sprite)[key] || 1500;

  // Facing: a mirrored character faces left. States listed in `noMirror` (e.g. art with text or a logo)
  // are always drawn unmirrored.
  function facingFor(facing, state, noMirror = []) {
    return noMirror.includes(state) ? 'right' : facing === 'left' ? 'left' : 'right';
  }

  // ---- throwing (dsh-pet shared/physics/throw.ts, release.ts) ---------------------------------
  const PHYSICS = { gravity: 1400, restitution: 0.78, floorFriction: 0.82, airDrag: 0.998, maxSpeed: 2600, minThrow: 450, settleSpeed: 60 };

  // Release velocity (px/s) from recent pointer samples [{ x, y, t }] (screen px, ms), over the last 90 ms.
  function releaseVelocity(samples, now) {
    const recent = samples.filter((s) => now - s.t <= 90);
    if (recent.length < 2) return { vx: 0, vy: 0 };
    const a = recent[0];
    const b = recent[recent.length - 1];
    const dt = Math.max(16, b.t - a.t) / 1000;
    let vx = (b.x - a.x) / dt;
    let vy = (b.y - a.y) / dt;
    const sp = Math.hypot(vx, vy);
    if (sp > PHYSICS.maxSpeed) {
      vx *= PHYSICS.maxSpeed / sp;
      vy *= PHYSICS.maxSpeed / sp;
    }
    return { vx, vy };
  }
  const isThrow = (v) => Math.hypot(v.vx, v.vy) >= PHYSICS.minThrow;

  // ---- slingshot (dsh-pet drag.ts + physics/release.ts) ---------------------------------------
  // Press twice quickly (the second press within doubleMs of the first), pull, let go: the pet flies the
  // opposite way of the pull. The speed only depends on how far it was pulled (a pull of 60% of its own
  // width launches at the anchor speed), not on how fast the hand moved.
  const SLING = { doubleMs: 300, refRatio: 0.6, anchor: 1200, minPull: 20 };
  const isSlingshot = (prevPressAt, now) => prevPressAt != null && now - prevPressAt < SLING.doubleMs;
  function slingshotVelocity(pullX, pullY, width) {
    const dist = Math.hypot(pullX, pullY);
    if (!(width > 0) || dist < SLING.minPull) return { vx: 0, vy: 0 };
    const speed = Math.min(PHYSICS.maxSpeed, (SLING.anchor * dist) / (width * SLING.refRatio));
    return { vx: (-pullX / dist) * speed, vy: (-pullY / dist) * speed };
  }

  // ---- scoring a hit on a flying pet (dsh-pet score.ts) ---------------------------------------
  // Catching it mid-air at 400 px/s or more scores speed/100 points, more for a smaller pet (the target
  // is harder to hit). Slower than that is an ordinary click.
  const SCORE = { minSpeed: 400, perPoint: 100, refWidth: 150 };
  function clickScore(speed, width) {
    if (!(speed >= SCORE.minSpeed) || !(width > 0)) return 0;
    return Math.max(1, Math.round((speed / SCORE.perPoint) * (SCORE.refWidth / width)));
  }

  // ---- landing squash (dsh-pet physics/squash.ts) ---------------------------------------------
  // The harder it lands, the flatter it squashes: impact 300 px/s → 0.8 of its height, 1500+ → 0.55.
  const SQUASH = { soft: 300, hard: 1500, max: 0.55 };
  function landingSquash(impact) {
    const t = Math.min(Math.max((Math.abs(impact) - SQUASH.soft) / (SQUASH.hard - SQUASH.soft), 0), 1);
    return Math.round(Math.min(0.8, 1 - t * (1 - SQUASH.max)) * 100) / 100;
  }

  // ---- touch (dsh-pet touch-press.ts) ---------------------------------------------------------
  // On a touch screen a long press (held still) opens the menu, like a right click with a mouse.
  const LONG_PRESS = { ms: 500, slop: 8 };
  const isLongPress = (heldMs, movedPx) => heldMs >= LONG_PRESS.ms && movedPx <= LONG_PRESS.slop;

  // ---- pets knocking into each other (dsh-pet physics/collide.ts) -----------------------------
  // Bodies are { x, y, w, h, vx, vy } in screen px (the character's own box, not the whole window).
  const rectsOverlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  // A flying pet hits another: a nearly elastic collision (restitution 0.995, mass ∝ area) along the
  // line between their centres; the tangential speed is kept. null when the centres coincide or the two
  // are already moving apart (so overlapping frames do not bounce them again and again).
  const PET_BOUNCE = 0.995;
  function collidePets(fly, hit) {
    const cx = hit.x + hit.w / 2 - (fly.x + fly.w / 2);
    const cy = hit.y + hit.h / 2 - (fly.y + fly.h / 2);
    const dist = Math.hypot(cx, cy);
    if (dist < 1e-6) return null;
    const nx = cx / dist;
    const ny = cy / dist;
    const vrel = (fly.vx - hit.vx) * nx + (fly.vy - hit.vy) * ny;
    if (vrel <= 0) return null;
    const m1 = fly.w * fly.h;
    const m2 = hit.w * hit.h;
    const v1n = fly.vx * nx + fly.vy * ny;
    const v2n = hit.vx * nx + hit.vy * ny;
    const v1n2 = ((m1 - PET_BOUNCE * m2) * v1n + (1 + PET_BOUNCE) * m2 * v2n) / (m1 + m2);
    const v2n2 = ((m2 - PET_BOUNCE * m1) * v2n + (1 + PET_BOUNCE) * m1 * v1n) / (m1 + m2);
    return { fly: capSpeed({ vx: fly.vx + (v1n2 - v1n) * nx, vy: fly.vy + (v1n2 - v1n) * ny }), hit: capSpeed({ vx: hit.vx + (v2n2 - v2n) * nx, vy: hit.vy + (v2n2 - v2n) * ny }) };
  }

  // A window position Electron accepts: setPosition / setBounds only take values V8 holds as int32, so
  // -0 (Math.round of -0.4, e.g. on a display left of the primary one), fractions, NaN and anything past
  // ±2^31 throw "conversion failure" in the main process. null when there is no sensible position.
  const SCREEN_LIMIT = 1e6;
  function screenPx(v) {
    if (!Number.isFinite(v)) return null;
    return Math.max(-SCREEN_LIMIT, Math.min(SCREEN_LIMIT, Math.round(v))) + 0; // + 0 turns -0 into 0
  }
  // A knock never sends a pet faster than a throw can: a chain of knocks between several visitors would
  // otherwise add up speed without bound.
  function capSpeed(v) {
    const sp = Math.hypot(v.vx, v.vy);
    if (!Number.isFinite(sp)) return { vx: 0, vy: 0 };
    return sp > PHYSICS.maxSpeed ? { vx: (v.vx * PHYSICS.maxSpeed) / sp, vy: (v.vy * PHYSICS.maxSpeed) / sp } : v;
  }

  // One physics step for a window-sized body { x, y, w, h, vx, vy } inside `area` { x, y, width, height }
  // (the screen's work area). Returns a new body and what happened: bounced off a wall / the floor,
  // and whether it came to rest on the floor.
  function stepThrow(body, dtMs, area) {
    const dt = Math.min(0.05, dtMs / 1000);
    let { x, y, vx, vy } = body;
    vy += PHYSICS.gravity * dt;
    vx *= PHYSICS.airDrag;
    x += vx * dt;
    y += vy * dt;
    const left = area.x;
    const right = area.x + area.width - body.w;
    const top = area.y;
    const floor = area.y + area.height - body.h;
    let hit = null;
    if (x < left) { x = left; vx = Math.abs(vx) * PHYSICS.restitution; hit = 'wall'; }
    if (x > right) { x = right; vx = -Math.abs(vx) * PHYSICS.restitution; hit = 'wall'; }
    if (y < top) { y = top; vy = Math.abs(vy) * PHYSICS.restitution; hit = 'ceiling'; }
    let rest = false;
    let impact = 0;
    if (y >= floor) {
      y = floor;
      if (vy > 0) {
        if (vy > PHYSICS.settleSpeed * 3) { hit = 'floor'; impact = vy; }
        vy = -vy * PHYSICS.restitution;
      }
      vx *= PHYSICS.floorFriction;
      if (Math.abs(vy) < PHYSICS.settleSpeed * 3 && Math.abs(vx) < PHYSICS.settleSpeed) { vy = 0; vx = 0; rest = true; }
    }
    return { body: { ...body, x, y, vx, vy }, hit, rest, impact };
  }

  // Run a throw to the end (tests, and a cap for the live loop): the path in fixed steps.
  function simulateThrow(body, area, stepMs = 16, maxSteps = 1200) {
    const path = [];
    let b = body;
    for (let i = 0; i < maxSteps; i++) {
      const r = stepThrow(b, stepMs, area);
      b = r.body;
      path.push({ x: b.x, y: b.y, hit: r.hit });
      if (r.rest) return { path, rest: true, body: b };
    }
    return { path, rest: false, body: b };
  }

  return {
    STATES, ALIASES, FALLBACK, chain, resolveAction, OVERLAY, FOOD_OVERLAY, IDLE_CUES, IDLE_GAP, idleDelay, pickWeighted, nextIdleCue, pickVariant,
    WALK, planWalk, walkX, CLICK_REACTIONS, pickClickReaction, ONE_SHOT_MS, oneShotMs, facingFor, PHYSICS, releaseVelocity, isThrow, stepThrow, simulateThrow,
    SLING, isSlingshot, slingshotVelocity, SCORE, clickScore, SQUASH, landingSquash, LONG_PRESS, isLongPress, rectsOverlap, PET_BOUNCE, collidePets, screenPx, capSpeed,
  };
});
