'use strict';
// The renderer half of the shared effects layer (logic in src/core/fx.js, loaded as window.PetFx).
// One controller drives every character the same way: one-shot states, the weighted idle chain,
// turning (mirroring), click reactions with a squash, being lifted, the throw with gravity and bounces,
// and heart particles. app.js decides *what* the pet is doing; this decides how it plays out.
(function () {
  const Fx = window.PetFx;
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function createEffects({ body, floatLayer, api }) {
    let oneShot = null; // { key, until }
    let facing = 'right';
    let nextIdleAt = performance.now() + Fx.idleDelay();
    let prevIdleCue = null; // the idle chain never repeats a cue back to back
    let lastClick = null;
    let flight = null; // a running throw
    let lifted = false;
    let lastCueName = null; // what the idle chain, a click or a test cue played last

    const play = (key, ms) => { oneShot = { key, until: performance.now() + ms }; };
    const current = (now = performance.now()) => (oneShot && now < oneShot.until ? oneShot.key : null);

    function squash() {
      if (reduced()) return;
      body.classList.remove('squash');
      void body.offsetWidth;
      body.classList.add('squash');
    }

    function setFacing(f) {
      facing = f === 'left' ? 'left' : 'right';
    }

    // A cue from the idle chain, a menu or a test: `turn` mirrors the pet, anything else plays once.
    function cue(name, video) {
      lastCueName = name;
      if (name === 'turn') {
        setFacing(facing === 'left' ? 'right' : 'left');
        squash();
        return;
      }
      play(name, Fx.oneShotMs(video, name));
    }

    // Called every frame while nothing else is going on: maybe start the next idle cue.
    function tickIdle(now, idle, video) {
      if (!idle || current(now) || flight || lifted) {
        if (!idle) nextIdleAt = Math.max(nextIdleAt, now + 4000);
        return;
      }
      if (now < nextIdleAt) return;
      prevIdleCue = Fx.nextIdleCue(Math.random, prevIdleCue);
      cue(prevIdleCue, video);
      nextIdleAt = now + Fx.idleDelay();
    }

    // A click on the pet: a random reaction, never the same twice in a row, with a squash.
    function click(video) {
      lastClick = Fx.pickClickReaction(Math.random, lastClick);
      lastCueName = lastClick;
      play(lastClick, Fx.oneShotMs(video, lastClick));
      squash();
      return lastClick;
    }

    // Small hearts bursting from the pet (affection gained).
    function burst(n = 6) {
      if (!floatLayer) return;
      for (let i = 0; i < n; i++) {
        const el = document.createElement('i');
        el.className = 'heart-p';
        el.textContent = '♥';
        el.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 90)}px`);
        el.style.setProperty('--dy', `${-30 - Math.round(Math.random() * 50)}px`);
        el.style.setProperty('--d', `${0.7 + Math.random() * 0.5}s`);
        floatLayer.appendChild(el);
        setTimeout(() => el.remove(), 1400);
      }
    }

    // Throw the window with velocity v (px/s): gravity, bounces off the screen edges, rest on the floor.
    async function throwPet(v, { onLand } = {}) {
      if (flight) return false;
      const wa = await api.workArea();
      if (!wa) return false;
      const run = { body: { x: wa.bounds.x, y: wa.bounds.y, w: wa.bounds.width, h: wa.bounds.height, vx: v.vx, vy: v.vy }, area: wa.area, bounces: 0, hits: [] };
      flight = run;
      body.classList.add('flying');
      let last = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          if (flight !== run) return resolve();
          const now = performance.now();
          const r = Fx.stepThrow(run.body, now - last, run.area);
          last = now;
          run.body = r.body;
          api.moveTo(r.body.x, r.body.y);
          if (r.hit) {
            run.bounces++;
            run.hits.push(r.hit);
            squash();
          }
          if (r.rest || run.bounces > 40) return resolve();
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      body.classList.remove('flying');
      const done = { bounces: run.bounces, hits: run.hits, x: run.body.x, y: run.body.y };
      if (flight === run) flight = null;
      if (onLand) onLand(done);
      return done;
    }
    const stopThrow = () => { flight = null; body.classList.remove('flying'); };

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
      squash,
      burst,
      throwPet,
      stopThrow,
      render,
      setLifted: (v) => { lifted = !!v; },
      get lifted() { return lifted; },
      get flying() { return !!flight; },
      get facing() { return facing; },
      setFacing,
      get lastCue() { return lastCueName; },
    };
  }

  window.PetEffects = { createEffects };
})();
