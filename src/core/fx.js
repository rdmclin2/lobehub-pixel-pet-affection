'use strict';
// Shared effects layer (共享效果层): everything a companion does on the desktop, for every character.
// Ported from the DeepSeek pet dsh-pet (https://github.com/PC2005-cloud/dsh-pet): its 15 animation
// states, the weighted idle chain (look around / turn / small actions), click reactions, squash on
// click, being lifted, and the throw with gravity and bounces. A character only supplies art for the
// states (video clips or a sprite pack); a state without art falls back along FALLBACK, so a character
// with a single idle frame still runs every effect. Pure and Electron-free: loaded by the renderer as
// a <script> (window.PetFx) and by the tests through require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetFx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // The state vocabulary: the DeepSeek pet's 15 clips plus `lifted` (being dragged).
  const STATES = ['idle', 'look', 'happy', 'pat', 'sad', 'hungry', 'sleep', 'eat_rice', 'eat_cookie', 'eat_fruit', 'think', 'talk', 'play', 'hatch', 'evolve', 'lifted'];

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
  const OVERLAY = { pat: '💕', sleep: '💤', hungry: '🍙?', sad: '💧', think: '💭', happy: '♪', talk: '…', lifted: '❗', play: '♪', evolve: '✨', hatch: '✨', look: '👀' };
  const FOOD_OVERLAY = { eat_rice: '🍚', eat_cookie: '🍪', eat_fruit: '🍉' };

  // ---- the idle chain (dsh-pet pickers.ts / next-animation.ts) --------------------------------
  // While nothing else is going on, every 12–25 s the pet plays a short cue picked by weight.
  const IDLE_CUES = [
    { cue: 'look', weight: 4 }, // look around
    { cue: 'turn', weight: 3 }, // turn to face the other way (mirrors the character)
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
  // The next idle cue; the same cue does not play twice in a row.
  function nextIdleCue(rnd = Math.random, prev = null) {
    const list = IDLE_CUES.filter((x) => x.cue !== prev);
    return pickWeighted(list, rnd).cue;
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
    if (y >= floor) {
      y = floor;
      if (vy > 0) {
        if (vy > PHYSICS.settleSpeed * 3) hit = 'floor';
        vy = -vy * PHYSICS.restitution;
      }
      vx *= PHYSICS.floorFriction;
      if (Math.abs(vy) < PHYSICS.settleSpeed * 3 && Math.abs(vx) < PHYSICS.settleSpeed) { vy = 0; vx = 0; rest = true; }
    }
    return { body: { ...body, x, y, vx, vy }, hit, rest };
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

  return { STATES, ALIASES, FALLBACK, chain, resolveAction, OVERLAY, FOOD_OVERLAY, IDLE_CUES, IDLE_GAP, idleDelay, pickWeighted, nextIdleCue, CLICK_REACTIONS, pickClickReaction, ONE_SHOT_MS, oneShotMs, facingFor, PHYSICS, releaseVelocity, isThrow, stepThrow, simulateThrow };
});
