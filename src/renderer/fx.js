'use strict';
// The renderer half of the shared effects layer (logic in src/core/fx.js, loaded as window.PetFx).
// One controller drives every character the same way: one-shot states, the weighted idle chain,
// turning (mirroring), walking about, click reactions with a squash, being lifted, the throw with
// gravity and bounces (a harder landing squashes flatter), knocking into other pets on the desktop,
// heart particles, the score for catching a flying pet, and the click sound. app.js decides *what*
// the pet is doing; this decides how it plays out.
(function () {
  const Fx = window.PetFx;
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A short "pop" made with Web Audio (no sound file): click sound, at most once per 100 ms.
  let audioCtx = null;
  let lastPop = 0;
  function pop() {
    const now = performance.now();
    if (now - lastPop < 100) return false;
    lastPop = now;
    try {
      audioCtx = audioCtx || new AudioContext();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(330, t + 0.09);
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.13);
    } catch { /* no audio device: stay silent */ }
    return true;
  }

  function createEffects({ body, floatLayer, api, prefs = () => ({}), hitBox = () => null }) {
    let oneShot = null; // { key, until }
    let facing = 'right';
    let nextIdleAt = performance.now() + Fx.idleDelay();
    let prevIdleCue = null; // the idle chain never repeats a cue back to back
    let lastClick = null;
    let flight = null; // a running throw
    let walk = null; // a running walk
    let lifted = false;
    let lastCueName = null; // what the idle chain, a click or a test cue played last
    const stats = { collisions: 0, kicked: 0, lastScore: 0, lastSquash: 1, lastWalk: null, sounds: 0 };

    const play = (key, ms) => { oneShot = { key, until: performance.now() + ms }; };
    const current = (now = performance.now()) => (oneShot && now < oneShot.until ? oneShot.key : null);

    function squash(amount) {
      if (reduced()) return;
      body.style.setProperty('--sq', String(amount || 0.86));
      body.classList.remove('squash');
      void body.offsetWidth;
      body.classList.add('squash');
    }

    function setFacing(f) {
      facing = f === 'left' ? 'left' : 'right';
    }

    // Report where the character is in the window (and how fast it moves) for collisions.
    function report(vx = 0, vy = 0) {
      if (api.pose) api.pose({ hit: hitBox(), vx, vy });
    }

    // Walk a few steps the way it faces (turning round at the screen edge): the window slides along.
    async function walkPet() {
      if (walk || flight || lifted || !api.workArea) return false;
      const wa = await api.workArea();
      if (!wa) return false;
      const plan = Fx.planWalk({ x: wa.bounds.x, w: wa.bounds.width, area: wa.area, facing, scale: wa.bounds.width / 230 });
      if (!plan) return false;
      setFacing(plan.facing);
      const run = { plan, start: performance.now() };
      walk = run;
      stats.lastWalk = { from: plan.fromX, to: plan.toX, facing: plan.facing };
      await new Promise((resolve) => {
        const step = () => {
          if (walk !== run) return resolve();
          const t = performance.now() - run.start;
          api.moveTo(Fx.walkX(plan, t), wa.bounds.y);
          if (t >= plan.ms) return resolve();
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      if (walk === run) walk = null;
      return true;
    }
    const stopWalk = () => { walk = null; };

    // A cue from the idle chain, a menu or a test: `turn` mirrors the pet, `walk` walks, anything else
    // plays once.
    function cue(name, video) {
      lastCueName = name;
      if (name === 'turn') {
        setFacing(facing === 'left' ? 'right' : 'left');
        squash();
        return;
      }
      if (name === 'walk') {
        walkPet();
        return;
      }
      play(name, Fx.oneShotMs(video, name));
    }

    // Called every frame while nothing else is going on: maybe start the next idle cue.
    function tickIdle(now, idle, video) {
      if (!idle || current(now) || flight || lifted || walk) {
        if (!idle) nextIdleAt = Math.max(nextIdleAt, now + 4000);
        return;
      }
      if (now < nextIdleAt) return;
      prevIdleCue = Fx.nextIdleCue(Math.random, prevIdleCue, { roam: prefs().roam !== false });
      cue(prevIdleCue, video);
      nextIdleAt = now + Fx.idleDelay();
    }

    function clickSound() {
      if (prefs().clickSound && pop()) stats.sounds++;
    }

    // A click on the pet: a random reaction, never the same twice in a row, with a squash.
    function click(video) {
      stopWalk();
      lastClick = Fx.pickClickReaction(Math.random, lastClick);
      lastCueName = lastClick;
      play(lastClick, Fx.oneShotMs(video, lastClick));
      squash();
      clickSound();
      return lastClick;
    }

    // Small hearts bursting from the pet (affection gained).
    function burst(n = 6, char = '♥', cls = 'heart-p') {
      if (!floatLayer) return;
      for (let i = 0; i < n; i++) {
        const el = document.createElement('i');
        el.className = cls;
        el.textContent = char;
        el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 90)}px`);
        el.style.setProperty('--dy', `${-30 - Math.round(Math.random() * 50)}px`);
        el.style.setProperty('--d', `${0.7 + Math.random() * 0.5}s`);
        floatLayer.appendChild(el);
        setTimeout(() => el.remove(), 1400);
      }
    }

    // Caught in mid-air: "+N" and a burst of sparks; returns the score (0 = too slow, a plain click).
    function catchScore() {
      if (!flight) return 0;
      const speed = Math.hypot(flight.body.vx, flight.body.vy);
      const box = hitBox();
      const n = Fx.clickScore(speed, box ? box.w : 150);
      if (!n) return 0;
      stats.lastScore = n;
      if (floatLayer) {
        const el = document.createElement('div');
        el.className = 'score-pop';
        el.textContent = `+${n}`;
        el.title = `${Math.round(speed)} px/s`;
        floatLayer.appendChild(el);
        setTimeout(() => el.remove(), 1600);
      }
      burst(8, '✦', 'spark-p');
      return n;
    }

    // Throw the window with velocity v (px/s): gravity, bounces off the screen edges, rest on the floor.
    // On the way it can knock into other pets on the desktop (with collisions on): both bounce off.
    async function throwPet(v, { onLand } = {}) {
      if (flight) return false;
      stopWalk();
      const wa = await api.workArea();
      if (!wa) return false;
      const run = { body: { x: wa.bounds.x, y: wa.bounds.y, w: wa.bounds.width, h: wa.bounds.height, vx: v.vx, vy: v.vy }, area: wa.area, bounces: 0, hits: [], collisions: 0, maxImpact: 0 };
      flight = run;
      body.classList.add('flying');
      let last = performance.now();
      let peers = [];
      let asking = false;
      const cooldown = new Map(); // peer id -> time of the last knock (no double hits while overlapping)
      await new Promise((resolve) => {
        const step = () => {
          if (flight !== run) return resolve();
          const now = performance.now();
          const r = Fx.stepThrow(run.body, now - last, run.area);
          last = now;
          run.body = r.body;
          api.moveTo(r.body.x, r.body.y);
          report(run.body.vx, run.body.vy);
          if (r.hit) {
            run.bounces++;
            run.hits.push(r.hit);
            if (r.impact) run.maxImpact = Math.max(run.maxImpact, r.impact);
            squash(r.impact ? Fx.landingSquash(r.impact) : undefined);
          }
          // the others' boxes, refreshed without blocking the frame
          if (prefs().collide !== false && api.peers && !asking) {
            asking = true;
            api.peers().then((p) => { peers = p || []; asking = false; }, () => { asking = false; });
          }
          const box = hitBox();
          if (box && prefs().collide !== false) {
            const me = { x: run.body.x + box.x, y: run.body.y + box.y, w: box.w, h: box.h, vx: run.body.vx, vy: run.body.vy };
            for (const p of peers) {
              if (now - (cooldown.get(p.id) || 0) < 300 || !Fx.rectsOverlap(me, p)) continue;
              const c = Fx.collidePets(me, p);
              if (!c) continue;
              cooldown.set(p.id, now);
              run.body = { ...run.body, vx: c.fly.vx, vy: c.fly.vy };
              run.collisions++;
              stats.collisions++;
              run.hits.push('pet');
              squash(0.8);
              api.kick(p.id, c.hit.vx, c.hit.vy);
            }
          }
          if (r.rest || run.bounces > 40) return resolve();
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      body.classList.remove('flying');
      report(0, 0);
      if (run.maxImpact) stats.lastSquash = Fx.landingSquash(run.maxImpact); // the hardest landing of this throw
      const done = { bounces: run.bounces, hits: run.hits, collisions: run.collisions, impact: Math.round(run.maxImpact), x: run.body.x, y: run.body.y };
      if (flight === run) flight = null;
      if (onLand) onLand(done);
      return done;
    }
    const stopThrow = () => { flight = null; body.classList.remove('flying'); report(0, 0); };

    // Knocked by another pet: fly off with the speed it gave us.
    function kicked(v, opts) {
      stats.kicked++;
      stopThrow();
      return throwPet(v, opts);
    }

    // Write the state the pet is in onto the DOM (for CSS, screen readers and the E2E suite).
    function render(state, action, exact, noMirror) {
      const f = Fx.facingFor(facing, state, noMirror);
      if (body.dataset.state !== state) body.dataset.state = state;
      if (body.dataset.action !== action) body.dataset.action = action;
      if (body.dataset.facing !== f) body.dataset.facing = f;
      const ex = exact ? 'yes' : 'no';
      if (body.dataset.exact !== ex) body.dataset.exact = ex;
      body.classList.toggle('lifted', lifted);
    }

    return {
      play,
      current,
      clear: () => { oneShot = null; },
      cue,
      tickIdle,
      click,
      clickSound,
      squash,
      burst,
      catchScore,
      throwPet,
      stopThrow,
      kicked,
      walkPet,
      stopWalk,
      report,
      render,
      setLifted: (v) => { lifted = !!v; if (lifted) stopWalk(); },
      get lifted() { return lifted; },
      get flying() { return !!flight; },
      get walking() { return !!walk; },
      get facing() { return facing; },
      setFacing,
      get lastCue() { return lastCueName; },
      stats,
    };
  }

  window.PetEffects = { createEffects };
})();
