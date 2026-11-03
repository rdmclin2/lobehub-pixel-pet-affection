'use strict';
// Dancing (docs/vrm-dance.md §3.5, §4): the one place that holds what she dances, its music and its clock.
// The VRM figure (renderer/vrm.js) plays the clip on the dance layer and the director (core/vrm-director.js)
// decides the interruptions; every frame this controller hands the figure a snapshot (snap.dance: id, time,
// running or paused) and reads back what the director asks (plan.dance.request: start | pause | resume | stop)
// and how much the music is ducked.
//
// The clock (§4.1): with music, the dance's time IS the music's — t = audio.currentTime + offset, read every
// frame, never added up from frame intervals (the pet's frame rate goes 12 / 30 / 60 fps and stops when
// hidden), so the motion cannot drift from the music; a stalled stream stops both. Without music (or when it
// fails to play) the clock is the render clock (t += dt), stopped while she is out of sight.
// Volume (§4.2): prefs.danceVolume (0–100, default 60) × the director's duck (talking 30 %, the microphone
// 15 %), eased; prefs.muted mutes the music and the dance goes on (the muted <audio> keeps its time). The
// music is never routed into the lip-sync analyser, so her mouth does not follow it.
// Only a VRM look dances (core/vrm-dances.js cannotDance): anything else gets the reason back.
(function () {
  const Dances = window.PetVrmDances;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const STOP_FADE = 0.4; // s: the music fades out on a stop
  const END_HOLD = 0.3; // s: the last frame held before the dance hands back to the idle
  const TAIL_FADE = 1.0; // s: music longer than the dance fades out when the dance ends
  const DUCK_RATE = 1 / 0.2; // the duck's ramp (≈ 0.2 s)
  const AUDIO_WAIT_MS = 8000;

  // opts: { figure() → the VRM figure on the desk or null, look() → her look (core/packs.js), prefs() → settings.prefs,
  //   body: the element that gets data-dancing }
  function create({ figure, look, prefs, body = null }) {
    let cur = null; // the dance: { id, entry, name, loop, phase: 'cue'|'play'|'end', t, clock, el, audio, paused, fig, duration, faceTrack, speed, endAt }
    let loading = null; // { id, token } while its clip / music load
    let token = 0;
    let last = null;
    let lastNow = null;
    const fading = new Set(); // music elements fading out: { el, from, t0, dur }
    const stats = { played: 0, stopped: 0, ended: 0, loops: 0, lastStop: null, lastError: null };
    const P = () => (typeof prefs === 'function' && prefs()) || {};
    const volume = () => clamp((Number.isFinite(P().danceVolume) ? P().danceVolume : 60) / 100, 0, 1);
    const offset = () => (cur && Number(cur.entry.offset)) || 0;

    function mark() { if (body) { if (cur) body.dataset.dancing = '1'; else delete body.dataset.dancing; } }

    async function list() {
      let index = Dances.cleanDanceIndex(null);
      try { const r = await fetch('vrmlib://dance/library.json'); if (r.ok) index = Dances.cleanDanceIndex(await r.json()); } catch { /* no library: the demo only */ }
      return Dances.listDances(index);
    }

    // the music, ready to play from its start; null when it cannot (missing, not decodable)
    function openAudio(entry) {
      return new Promise((resolve) => {
        const el = new Audio();
        el.preload = 'auto';
        let done = false;
        const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); if (!ok) { el.removeAttribute('src'); el.load(); } resolve(ok ? el : null); };
        const timer = setTimeout(() => finish(false), AUDIO_WAIT_MS);
        el.addEventListener('canplay', () => finish(true), { once: true });
        el.addEventListener('error', () => finish(false), { once: true });
        el.src = `vrmlib://dance/${entry.audio}`;
      });
    }

    // Dance `id` (or the one called `name`; neither: one of the library's, not the last one). → { ok, … } or
    // { ok: false, reason: not-vrm | vrm-not-ready | no-dance | load-failed | cancelled, message? }
    async function play({ id = null, name = null, loop } = {}) {
      const no = Dances.cannotDance(look());
      if (no) return { ok: false, ...no };
      const fig = figure();
      if (!fig || !fig.isReady()) return { ok: false, reason: 'vrm-not-ready', message: '她的 VRM 模型还没载入好，稍等一下再试。' };
      const all = await list();
      const entry = id || name ? Dances.findDance(all, { id, name }) : Dances.pickDance(all, { last });
      if (!entry) return { ok: false, reason: 'no-dance', dances: all.map((d) => d.id) };
      const my = ++token;
      loading = { id: entry.id, token: my };
      let info;
      try { info = await fig.loadDance(entry); } catch (e) {
        if (loading && loading.token === my) loading = null;
        stats.lastError = { id: entry.id, what: 'clip', message: String((e && e.message) || e) };
        return { ok: false, reason: 'load-failed', id: entry.id, message: `《${entry.name}》没能载入，可能文件被删了。` };
      }
      if (my !== token || figure() !== fig) return { ok: false, reason: 'cancelled' };
      const el = entry.audio ? await openAudio(entry) : null;
      if (my !== token || figure() !== fig) { if (el) el.removeAttribute('src'); return { ok: false, reason: 'cancelled' }; }
      loading = null;
      if (entry.audio && !el) stats.lastError = { id: entry.id, what: 'music', message: 'the music did not load' };
      // a dance replacing another: the old music stops at once, the director fades the body from one to the other
      if (cur) stopNow('replaced', 0);
      cur = { id: entry.id, entry, name: entry.name, loop: typeof loop === 'boolean' ? loop : !!entry.loop, phase: 'cue', t: 0, clock: el ? 'audio' : 'render', el, audio: entry.audio ? (el ? 'paused' : 'failed') : 'none', paused: null, fig, duration: info.duration || entry.duration, faceTrack: !!info.faceTrack, speed: 1, endAt: 0, loops: 0, gain: 0, startedAt: performance.now() };
      if (el) { el.volume = 0; el.muted = P().muted === true; }
      last = entry.id;
      stats.played++;
      mark();
      return { ok: true, id: entry.id, name: entry.name, loop: cur.loop, duration: +cur.duration.toFixed(3), music: !!el, audio: cur.audio };
    }

    function fadeOut(el, dur) {
      if (!el) return;
      if (!(dur > 0)) { el.pause(); el.removeAttribute('src'); el.load(); return; }
      fading.add({ el, from: el.volume, t0: performance.now(), dur });
    }
    function stopNow(reason, fade) {
      const c = cur;
      cur = null;
      fadeOut(c.el, fade);
      stats.stopped++;
      stats.lastStop = { id: c.id, reason, t: +c.t.toFixed(2) };
      mark();
      return { ok: true, id: c.id, reason };
    }
    // Stop dancing: the music fades out (immediate: silent at once — a new look, a model unloaded), the body goes
    // back to the idle (the director's fade-out). A dance still loading is cancelled.
    function stop({ immediate = false, reason = 'stop' } = {}) {
      if (loading) { loading = null; token++; if (!cur) return { ok: true, id: null, reason: 'cancelled' }; }
      if (!cur) return { ok: false, reason: 'not-dancing' };
      token++;
      return stopNow(reason, immediate ? 0 : STOP_FADE);
    }

    function startClock() {
      cur.phase = 'play';
      if (cur.el) {
        cur.el.currentTime = Math.max(0, -offset());
        const el = cur.el;
        el.play().then(() => { if (cur && cur.el === el && !cur.paused) cur.audio = 'playing'; }, (e) => {
          // the music would not play (autoplay policy, a device problem): she dances on the render clock
          if (!cur || cur.el !== el) return;
          stats.lastError = { id: cur.id, what: 'play', message: String((e && e.message) || e) };
          cur.clock = 'render';
          cur.audio = 'failed';
          el.removeAttribute('src');
          cur.el = null;
        });
      }
    }
    function pause(why) {
      if (!cur || cur.paused) return;
      cur.paused = why;
      if (cur.el && !cur.el.paused) cur.el.pause();
    }
    function resume() {
      if (!cur || !cur.paused) return;
      cur.paused = null;
      if (cur.el && cur.phase === 'play' && cur.clock === 'audio') cur.el.play().catch(() => {});
    }
    // out of sight: paused, music too (§3.4); back: on again
    if (window.PetVRM && window.PetVRM.onVisibility) window.PetVRM.onVisibility((hidden) => { if (hidden && cur && !cur.paused) pause('hidden'); else if (!hidden && cur && cur.paused === 'hidden') resume(); });

    // The music's time as the dance's (with music), else the render clock's.
    function clockNow() {
      if (!cur) return 0;
      if (cur.clock === 'audio' && cur.el) return Math.max(0, cur.el.currentTime + offset());
      return cur.t;
    }

    // Every frame, before the figure draws: what the director asked last frame, the clock, the music.
    function tick(now) {
      const dt = lastNow === null ? 0 : clamp((now - lastNow) / 1000, 0, 0.25);
      lastNow = now;
      for (const f of fading) {
        const k = (now - f.t0) / 1000 / f.dur;
        if (k >= 1) { f.el.pause(); f.el.removeAttribute('src'); f.el.load(); fading.delete(f); } else f.el.volume = clamp(f.from * (1 - k), 0, 1);
      }
      if (!cur) return;
      const fig = figure();
      // a new look, another model, the figure gone: stop at once, nothing left to dance (§3.4)
      if (!fig || fig !== cur.fig || Dances.cannotDance(look())) { stopNow('look', 0); return; }
      const plan = fig.plan();
      const DP = plan && plan.dance && plan.dance.id === cur.id ? plan.dance : null;
      const req = DP ? DP.request : null;
      if (req === 'stop') { stopNow('interrupted', STOP_FADE); return; }
      if (cur.phase === 'cue' && req === 'start') startClock();
      if (req === 'pause' && !cur.paused) pause('lift');
      if (req === 'resume' && cur.paused === 'lift') resume();
      if ((cur.phase === 'play') && !cur.paused) {
        if (cur.clock === 'audio' && cur.el) {
          // music shorter than the dance: once it ends the render clock carries on from there (§3.3)
          if (cur.el.ended) { cur.clock = 'render'; cur.t = Math.max(cur.t, cur.el.duration + offset()); } else cur.t = Math.max(0, cur.el.currentTime + offset());
        }
        if (cur.clock !== 'audio' || !cur.el) cur.t += dt * cur.speed;
        if (cur.t >= cur.duration) {
          if (cur.loop) {
            // loop: music and motion back to 0 together (the figure blends the seam)
            cur.t = 0;
            cur.loops++;
            stats.loops++;
            if (cur.el) { cur.clock = 'audio'; cur.el.currentTime = Math.max(0, -offset()); if (cur.el.paused) cur.el.play().catch(() => {}); }
          } else {
            cur.t = cur.duration;
            cur.phase = 'end';
            cur.endAt = now;
            if (cur.el && !cur.el.ended) { fadeOut(cur.el, TAIL_FADE); cur.el = null; cur.clock = 'render'; }
          }
        }
      }
      if (cur.phase === 'end' && now - cur.endAt >= END_HOLD * 1000) { stats.ended++; stopNow('end', TAIL_FADE); return; }
      // the music's volume: the setting × the duck, eased; muted is muted
      const duck = DP ? DP.duck || 1 : 1;
      const want = volume() * duck;
      cur.gain += clamp(want - cur.gain, -DUCK_RATE * dt, DUCK_RATE * dt);
      if (cur.phase === 'cue') cur.gain = 0;
      if (cur.el) { cur.el.volume = clamp(cur.gain, 0, 1); cur.el.muted = P().muted === true; }
      cur.ducked = duck < 1;
      cur.audio = !cur.entry.audio ? 'none' : !cur.el ? (cur.audio === 'failed' ? 'failed' : 'none') : cur.el.muted ? 'muted' : cur.paused || cur.el.paused ? 'paused' : cur.ducked ? 'ducked' : 'playing';
    }

    // what the figure is handed every frame (snap.dance), or null
    function snapshot() {
      if (!cur) return null;
      return { id: cur.id, t: cur.t, duration: cur.duration, loop: cur.loop, ready: true, playing: cur.phase !== 'cue', paused: cur.paused, faceTrack: cur.faceTrack, audioState: cur.audio, loops: cur.loops, clockNow };
    }

    // for the API, IPC and e2e
    function state() {
      if (!cur) return loading ? { id: loading.id, state: 'loading' } : null;
      const f = cur.fig && cur.fig.danceInfo ? cur.fig.danceInfo() : {};
      return { id: cur.id, name: cur.name, state: f.state || 'cueing', t: +cur.t.toFixed(2), duration: +cur.duration.toFixed(2), loop: cur.loop, paused: !!cur.paused, pausedBy: cur.paused, music: !!cur.entry.audio, audio: cur.audio, clock: cur.clock, volume: +volume().toFixed(2), gain: +cur.gain.toFixed(3), muted: P().muted === true, ducked: !!cur.ducked, exclusive: !!f.exclusive, drift: f.drift || 0, ...(cur.el ? { media: { t: +cur.el.currentTime.toFixed(3), paused: cur.el.paused, ready: cur.el.readyState, error: cur.el.error ? cur.el.error.code : null, rate: cur.el.playbackRate } } : {}) };
    }

    // debug (§7.1): jump the clock; speed it (the music's playback rate too, so they stay together)
    function seek(t) {
      if (!cur) return false;
      const x = clamp(Number(t) || 0, 0, cur.duration);
      cur.t = x;
      if (cur.el && cur.clock === 'audio') cur.el.currentTime = Math.max(0, x - offset());
      if (cur.phase === 'end') cur.phase = 'play';
      return x;
    }
    function speed(k) {
      if (!cur) return 1;
      cur.speed = clamp(Number(k) || 1, 0.25, 8);
      if (cur.el) cur.el.playbackRate = cur.speed;
      return cur.speed;
    }
    function setLoop(on) { if (!cur) return false; cur.loop = !!on; return cur.loop; }

    const api = { list, play, stop, tick, snapshot, state, seek, speed, setLoop, active: () => !!cur || !!loading, current: () => (cur ? cur.id : null), stats: () => ({ ...stats, fading: fading.size }) };
    return api;
  }

  window.PetDance = { create, current: null };
})();
