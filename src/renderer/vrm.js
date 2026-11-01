'use strict';
// VRM 角色包 (kind "vrm" in docs/pet-packs.md): a VRM 1.0 / 0.x model drawn with three.js + @pixiv/three-vrm
// in a transparent WebGL canvas, acted out by the app.
//
// This file only draws what the app already decided: the look (core/packs.js resolveLook — which pack,
// which outfit, already through the 18+ / affection / outfit rules) and, every frame, the state, the touch
// mood, whether she is talking and where the window is. It never picks an outfit or a pack itself.
// What each state looks like (expressions, procedural moves), the mouth shapes from the voice and the
// frame budget are pure functions in core/vrm-motion.js (window.PetVrmMotion, unit-tested).
//
// The runtime (vendor/vrm/three-vrm.min.js, built by scripts/build-vrm-vendor.js) is loaded the first time
// a VRM look is shown. The model is fetched over pack://<id>/… only (src/main/packs.js serves files inside
// that pack's folder); any other URL the model refers to is refused.
//
// Debug fields on the canvas (read by e2e): data-frame (frames drawn, counting up), data-fps (drawn in
// the last second), data-mode (active | idle | paused), data-state, data-expr (expression weights),
// data-mouth (aa/ih/ou/ee/oh), data-lip (audio | synthetic | off), data-gaze (x,y), data-springs (joints),
// data-vrm (1.0 | 0.x), data-anim (vrma when the pack's idle animation plays, none, failed).
// window.PetVRM.debug() has the same and more.
(function () {
  const M = window.PetVrmMotion;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const approach = (rate, dt) => 1 - Math.exp(-rate * dt);
  const DEG = Math.PI / 180;

  // ---------- the runtime, loaded once on demand ----------
  let runtime = null;
  function loadRuntime() {
    if (!runtime) {
      runtime = new Promise((resolve, reject) => {
        if (window.PetVrmRuntime) return resolve(window.PetVrmRuntime);
        const s = document.createElement('script');
        s.src = 'vendor/vrm/three-vrm.min.js';
        s.onload = () => (window.PetVrmRuntime ? resolve(window.PetVrmRuntime) : reject(new Error('three-vrm did not load')));
        s.onerror = () => reject(new Error('cannot load three-vrm.min.js'));
        document.head.appendChild(s);
      });
      runtime.catch(() => { runtime = null; });
    }
    return runtime;
  }

  // ---------- the cursor (gaze) ----------
  // Inside the window: pointer events. Outside it (she sits in a small window): the screen cursor from main,
  // polled a few times a second while a figure is shown, turned into window coordinates.
  // A pointer event inside the window is fresher than the last poll, so it wins for POINTER_FRESH_MS.
  const POINTER_FRESH_MS = 1500;
  const cursor = {
    pointer: null, movedAt: -Infinity, screen: null,
    get client() { return performance.now() - this.movedAt < POINTER_FRESH_MS || !this.screen ? this.pointer : this.screen; },
  };
  window.addEventListener('pointermove', (e) => { cursor.pointer = { x: e.clientX, y: e.clientY }; cursor.movedAt = performance.now(); }, { passive: true });
  let cursorTimer = 0;
  function pollCursor() {
    if (!window.pet || !window.pet.cursorPoint || document.hidden) return;
    window.pet.cursorPoint().then((pt) => {
      if (pt && Number.isFinite(pt.x)) cursor.screen = M.screenToClient(pt, { x: window.screenX, y: window.screenY });
    }, () => {});
  }
  // hidden or minimised (the page's visibility, or main telling the window it was hidden / minimised): no
  // drawing; requestAnimationFrame may stop altogether, so every figure is marked paused at once
  let shownByMain = true;
  const isHidden = () => document.hidden || !shownByMain;
  function onHidden() {
    if (!isHidden()) return;
    for (const f of figures) { f.canvas.dataset.mode = 'paused'; f.canvas.dataset.fps = '0'; f.pause(); }
  }
  document.addEventListener('visibilitychange', onHidden);
  if (window.pet && window.pet.onWindowShown) window.pet.onWindowShown((shown) => { shownByMain = !!shown; onHidden(); });

  // ---------- lip sync: the voice being played → an AnalyserNode ----------
  // app.js hands every TTS <audio> it plays to lip.attach() (only while a VRM figure is shown). The element is
  // routed through WebAudio (element → analyser → speakers) only once the AudioContext runs, so a suspended
  // context never mutes her; until then (and for the system voice, which has no stream) the mouth follows
  // a synthetic syllable rhythm.
  const lip = {
    ctx: null,
    analyser: null,
    bins: null,
    el: null,
    src: null,
    attached: 0,
    attach(el) {
      if (!figures.size || !el) return false;
      try {
        if (!this.ctx) {
          this.ctx = new AudioContext();
          this.analyser = this.ctx.createAnalyser();
          this.analyser.fftSize = 1024;
          this.analyser.smoothingTimeConstant = 0.5;
          this.analyser.connect(this.ctx.destination);
          this.bins = new Uint8Array(this.analyser.frequencyBinCount);
        }
        const route = () => {
          if (this.ctx.state !== 'running' || el.dataset.lipRouted) return;
          el.dataset.lipRouted = '1';
          if (this.src) try { this.src.disconnect(); } catch { /* gone */ }
          this.src = this.ctx.createMediaElementSource(el);
          this.src.connect(this.analyser);
          this.el = el;
          this.attached++;
        };
        if (this.ctx.state === 'running') route();
        else this.ctx.resume().then(route, () => {});
        return true;
      } catch (e) {
        console.warn('[vrm] lip sync off:', e && e.message);
        return false;
      }
    },
    // the spectrum of what is playing now, or null
    sample() {
      const el = this.el;
      if (!el || el.paused || el.ended || !this.analyser) return null;
      this.analyser.getByteFrequencyData(this.bins);
      return { bins: this.bins, sampleRate: this.ctx.sampleRate };
    },
  };

  // ---------- figures ----------
  const figures = new Set();
  const stats = { created: 0, disposed: 0, live: 0, lastDispose: null };

  // `look` from core/packs.js resolveLook: { packId, model (pack:// URL of the .vrm), vrm: { height,
  // expressions (state → name overrides), modelExpressions, springBone, meta, license }, url (picture) }.
  function createFigure(canvas, look) {
    const cfg = look.vrm || {};
    const overrides = cfg.expressions || {};
    const share = clamp(Number(cfg.height) || 0.8, 0.3, 1);
    let R = null; // the runtime
    let renderer = null;
    let scene = null;
    let camera = null;
    let vrm = null;
    let mixer = null; // the idle animation (pack vrm.idle), when there is one
    let animState = 'none'; // none | vrma | failed
    let lookTarget = null;
    let disposed = false;
    let size = { h: 1, minY: 0, cx: 0, cz: 0 };
    let base = { y: 0, x: 0, yaw: 0 };
    const has = (n) => !!(vrm && vrm.expressionManager && vrm.expressionManager.getExpression(n));
    const cur = Object.fromEntries(M.MOTIONS.map((k) => [k, 0]));
    const face = {}; // model expression name → current weight
    let mouth = M.zeroVisemes();
    const blink = { start: -1, next: 1.5 };
    const sp = { x: spring(70, 10, 1), roll: spring(60, 9, 18) };
    let stateNow = null;
    let stateAt = 0;
    let lastRender = null;
    let lastActivity = performance.now();
    let lastWin = null;
    let vel = [0, 0];
    let frameN = 0;
    let lipMode = 'off';
    let gaze = { x: 0, y: 0 };
    const meter = M.FpsMeter();
    const mirror = () => (canvas.closest && canvas.closest('[data-facing="left"]') ? -1 : 1);
    const me = fig();
    figures.add(me);
    stats.created++;
    stats.live++;
    if (!cursorTimer) cursorTimer = setInterval(pollCursor, 200);

    const ready = loadRuntime().then(async (rt) => {
      if (disposed) return false;
      R = rt;
      const T = R.THREE;
      if (typeof look.model !== 'string' || !look.model.startsWith(`pack://${look.packId}/`)) throw new Error('a VRM model is loaded from its own pack only');
      renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = T.SRGBColorSpace;
      renderer.setPixelRatio(1);
      scene = new T.Scene();
      camera = new T.PerspectiveCamera(22, canvas.width / canvas.height, 0.05, 50);
      const light = new T.DirectionalLight(0xffffff, Math.PI * 0.9);
      light.position.set(0.6, 1.2, 1.5);
      scene.add(light, new T.AmbientLight(0xffffff, 0.35));
      lookTarget = new T.Object3D();
      scene.add(lookTarget);

      const loader = new R.GLTFLoader();
      // a model may only refer to files of its own pack (and embedded data)
      const own = `pack://${look.packId}/`;
      loader.manager.setURLModifier((u) => (u.startsWith(own) || u.startsWith('data:') || u.startsWith('blob:') ? u : 'data:application/octet-stream,'));
      loader.register((parser) => new R.VRMLoaderPlugin(parser));
      const gltf = await loader.loadAsync(look.model);
      const v = gltf.userData && gltf.userData.vrm;
      if (disposed || !v) {
        R.VRMUtils.deepDispose(gltf.scene);
        if (!v && !disposed) throw new Error('not a VRM model');
        return false;
      }
      R.VRMUtils.removeUnnecessaryVertices(gltf.scene);
      R.VRMUtils.combineSkeletons(gltf.scene);
      R.VRMUtils.rotateVRM0(v); // 0.x models face −Z: turned to face the camera like 1.0
      v.scene.traverse((o) => { o.frustumCulled = false; });
      vrm = v;
      scene.add(vrm.scene);
      if (vrm.lookAt) { vrm.lookAt.target = lookTarget; vrm.lookAt.autoUpdate = true; }
      restPose();
      vrm.update(0);
      measure();
      fit(true);
      await loadIdle(T, own);
      if (disposed) return false;
      canvas.dataset.anim = animState;
      canvas.dataset.vrm = vrm.meta && vrm.meta.metaVersion === '0' ? '0.x' : '1.0';
      canvas.dataset.springs = String(vrm.springBoneManager ? vrm.springBoneManager.joints.size : 0);
      canvas.dataset.frame = '0';
      return true;
    });

    // the pack's idle loop (.vrma, from its own pack only): the clip owns her standing pose, the app's moves
    // go on top (draw). A clip that does not load just leaves her on the procedural pose.
    async function loadIdle(T, own) {
      if (!cfg.idle) return;
      try {
        if (typeof cfg.idle !== 'string' || !cfg.idle.startsWith(own)) throw new Error('an idle animation is loaded from its own pack only');
        const al = new R.GLTFLoader();
        al.manager.setURLModifier((u) => (u.startsWith(own) || u.startsWith('data:') || u.startsWith('blob:') ? u : 'data:application/octet-stream,'));
        al.register((parser) => new R.VRMAnimationLoaderPlugin(parser));
        const g = await al.loadAsync(cfg.idle);
        const anim = g.userData && g.userData.vrmAnimations && g.userData.vrmAnimations[0];
        if (!anim) throw new Error('not a VRM animation');
        if (disposed || !vrm) return;
        const clip = R.createVRMAnimationClip(anim, vrm);
        mixer = new T.AnimationMixer(vrm.scene);
        const action = mixer.clipAction(clip);
        action.setLoop(T.LoopRepeat, Infinity);
        action.play();
        animState = 'vrma';
      } catch (e) {
        console.warn('[vrm] idle animation off:', e && e.message);
        mixer = null;
        animState = 'failed';
      }
    }

    // the clip sets the bones it animates each update; the ones it leaves alone go back to rest here, so the
    // app's offsets never pile up from frame to frame
    const qTmp = {};
    function applyOverClip(bones, dt) {
      const h = vrm.humanoid;
      if (!h) return;
      for (const name of Object.keys(bones)) { const n = h.getNormalizedBoneNode(name); if (n) n.quaternion.identity(); }
      mixer.update(dt);
      const T = R.THREE;
      qTmp.e = qTmp.e || new T.Euler();
      qTmp.q = qTmp.q || new T.Quaternion();
      for (const [name, r] of Object.entries(M.poseOffsets(bones))) {
        const n = h.getNormalizedBoneNode(name);
        if (!n || (!r.x && !r.y && !r.z)) continue;
        qTmp.e.set(r.x * DEG, r.y * DEG, r.z * DEG);
        n.quaternion.multiply(qTmp.q.setFromEuler(qTmp.e));
      }
    }

    // arms down from the T-pose before measuring, so the box is her standing height
    function restPose() {
      const p = M.pose({}, 0, 0, { breathK: { spine: 0, chest: 0, shoulder: 0 } });
      applyBones(p.bones);
    }
    function measure() {
      const T = R.THREE;
      vrm.scene.updateMatrixWorld(true);
      const box = new T.Box3().setFromObject(vrm.scene);
      const head = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('head');
      let top = box.max.y;
      if (head) { const hp = head.getWorldPosition(new T.Vector3()); top = Math.min(box.max.y, hp.y + (hp.y - box.min.y) * 0.35); }
      size = { h: Math.max(0.1, top - box.min.y, box.max.y - box.min.y), minY: box.min.y, cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2 };
      base = { y: 0, x: -size.cx, yaw: vrm.scene.rotation.y };
    }

    // her size in the canvas: `vrm.height` of its height (pack.json), feet on the floor, centred; the canvas
    // resolution follows its size on screen (at most 2× the CSS size)
    let res = 0;
    function fit(force = false) {
      if (!renderer || !vrm) return;
      const r = canvas.getBoundingClientRect();
      const W = 332;
      const H = 452;
      const k = clamp(((r.height || H) / H) * (window.devicePixelRatio || 1), 1, 2);
      if (force || Math.abs(k - res) / (res || 1) >= 0.1) {
        res = k;
        renderer.setSize(Math.round(W * k), Math.round(H * k), false);
      }
      camera.aspect = W / H;
      const visible = size.h / share; // world height the canvas shows
      const dist = visible / 2 / Math.tan((camera.fov * DEG) / 2);
      camera.position.set(0, size.minY + visible * (0.5 - 0.005), size.cz + dist);
      camera.near = Math.max(0.01, dist / 20);
      camera.far = dist * 4;
      camera.updateProjectionMatrix();
      camera.lookAt(0, camera.position.y, size.cz);
    }

    function applyBones(bones) {
      const h = vrm.humanoid;
      if (!h) return;
      for (const [name, r] of Object.entries(bones)) {
        const n = h.getNormalizedBoneNode(name);
        if (n) n.rotation.set(r.x * DEG, r.y * DEG, r.z * DEG);
      }
    }

    // where she looks: the cursor (as a point between her and the screen), up when thinking, ahead otherwise
    const tmp = {};
    function aim(state, dt, t) {
      const T = R.THREE;
      tmp.v = tmp.v || new T.Vector3();
      tmp.d = tmp.d || new T.Vector3();
      const rect = canvas.getBoundingClientRect();
      let g = cursor.client ? M.gazeNdc(cursor.client, rect, { mirror: mirror() < 0 }) : { x: 0, y: 0.1 };
      if (state === 'think') g = { x: 0.3, y: 1.6 };
      else if (state === 'look') g = { x: Math.sin(t * 1.3) * 1.5, y: 0.2 };
      else if (state === 'sleep') g = { x: 0, y: -0.5 };
      const k = approach(8, dt);
      gaze = { x: lerp(gaze.x, g.x, k), y: lerp(gaze.y, g.y, k) };
      // a ray from the camera through the canvas point, cut at halfway between her face and the camera
      tmp.v.set(clamp(gaze.x, -1, 1), clamp(gaze.y, -1, 1), 0.5).unproject(camera);
      tmp.d.copy(tmp.v).sub(camera.position).normalize();
      const zPlane = size.cz + (camera.position.z - size.cz) * 0.5;
      const s = (zPlane - camera.position.z) / (tmp.d.z || -1);
      lookTarget.position.copy(camera.position).addScaledVector(tmp.d, s);
      // beyond the canvas edge: further to the side
      lookTarget.position.x += (gaze.x - clamp(gaze.x, -1, 1)) * size.h * 0.4;
      lookTarget.position.y += (gaze.y - clamp(gaze.y, -1, 1)) * size.h * 0.4;
    }

    function draw({ t, state, mood = null, talking = false, voice = null, win = null, still = false }) {
      if (!vrm || disposed) return false;
      const now = t * 1000;
      if (state !== stateNow) { stateNow = state; stateAt = t; lastActivity = now; }
      const busy = !M.isResting(state);
      if (busy || talking || voice) lastActivity = now;
      if (cursor.movedAt > lastActivity) lastActivity = cursor.movedAt;
      const moving = Math.abs(vel[0]) + Math.abs(vel[1]) > 30;
      if (moving) lastActivity = now;
      const blinking = blink.start >= 0 || t >= blink.next - 0.05;
      const fm = M.frameMode({ now, lastActivity, hidden: isHidden(), talking: talking || !!voice, dragging: state === 'lifted' || moving, busy, blinking });
      if (canvas.dataset.mode !== fm.mode) canvas.dataset.mode = fm.mode;
      if (!still && !M.shouldRender(now, lastRender, fm.fps)) {
        if (fm.mode === 'paused') { lastRender = null; canvas.dataset.fps = '0'; }
        return true;
      }
      const dt = lastRender == null ? 1 / 30 : clamp((now - lastRender) / 1000, 0, 0.1);
      lastRender = now;
      if (frameN % 30 === 0) fit();
      const st = t - stateAt;
      // resting at the low frame rate: her face and posture, without the bouncing
      const L = fm.mode === 'idle' ? M.calm(M.lookFor(state, mood)) : M.lookFor(state, mood);

      // the window's motion (screen px/s), in the direction she faces
      if (win) {
        if (lastWin) {
          const k = approach(14, dt);
          vel = [lerp(vel[0], (win[0] - lastWin[0]) / Math.max(dt, 1e-3), k), lerp(vel[1], (win[1] - lastWin[1]) / Math.max(dt, 1e-3), k)];
        }
        lastWin = win;
      }
      const swing = clamp((vel[0] * mirror()) / 600, -1.6, 1.6);

      // moves ease towards the state's
      const kk = approach(7, dt);
      for (const key of M.MOTIONS) cur[key] = lerp(cur[key], L.motion[key] || 0, kk);

      // body
      const p = M.pose(cur, t, st, { swing, talking: talking || !!voice, ...(mixer ? { breathK: M.NO_BREATH } : {}) });
      if (mixer) applyOverClip(p.bones, dt);
      else applyBones(p.bones);
      const roll = sp.roll.step(p.root.roll, dt);
      // window inertia: she lags behind the window and springs back, so her hair and tail (SpringBone) swing
      const lag = sp.x.step(clamp((-vel[0] * mirror()) / 2500, -0.6, 0.6), dt);
      vrm.scene.position.set(base.x + lag * size.h * 0.12 + p.root.x * size.h, base.y + p.root.lift * size.h, 0);
      vrm.scene.rotation.set(0, base.yaw + p.root.yaw * DEG, roll * DEG);

      // face: the state's expressions (pack overrides, fallbacks), blinking, the mouth
      const target = M.resolveFace(L.face, has, overrides[state] || null);
      if (t >= blink.next && blink.start < 0) blink.start = t;
      let lids = 0;
      if (blink.start >= 0) {
        lids = M.blinkWeight(t - blink.start);
        if (t - blink.start >= M.BLINK_MS / 1000) { blink.start = -1; lids = 0; blink.next = t + M.nextBlinkIn(); }
      }
      const blinkName = M.expressionFor('blink', has);
      if (blinkName && lids > 0) target[blinkName] = Math.max(target[blinkName] || 0, lids);
      if (cur.wink > 0.05) { const w = M.expressionFor('blinkRight', has); if (w) target[w] = Math.max(target[w] || 0, cur.wink); }
      // the mouth: the voice (analyser, else a syllable rhythm), chewing / held open
      let vis = M.zeroVisemes();
      lipMode = 'off';
      if (talking || voice) {
        const s = voice === 'audio' ? lip.sample() : null;
        if (s) { vis = M.visemesFromSpectrum(s.bins, s.sampleRate); lipMode = 'audio'; } else { vis = M.syntheticVisemes(t); lipMode = 'synthetic'; }
      }
      vis.aa = Math.max(vis.aa, M.motionMouth(cur, t));
      mouth = M.smoothVisemes(mouth, vis, dt);
      for (const k of M.VISEMES) { const n = M.expressionFor(k, has); if (n) target[n] = Math.max(target[n] || 0, mouth[k]); }
      const fk = approach(blink.start >= 0 ? 40 : 10, dt);
      for (const n of new Set([...Object.keys(face), ...Object.keys(target)])) {
        const goal = target[n] || 0;
        // the lids and the mouth are set directly (they already move on their own clock)
        const direct = n === blinkName || M.VISEMES.includes(n);
        face[n] = direct ? goal : lerp(face[n] || 0, goal, fk);
        if (face[n] < 0.003) face[n] = 0;
        vrm.expressionManager.setValue(n, face[n]);
      }

      aim(state, dt, t);
      vrm.update(dt); // humanoid, look-at, expressions, SpringBone, constraints
      renderer.render(scene, camera);
      frameN++;
      meter.tick(now);
      const d = canvas.dataset;
      d.frame = String(frameN);
      d.fps = String(meter.fps(now));
      d.state = state;
      d.lip = lipMode;
      d.mouth = M.VISEMES.map((k) => `${k}:${mouth[k].toFixed(2)}`).join(',');
      d.expr = Object.entries(face).filter(([, w]) => w > 0.01).map(([n, w]) => `${n}:${w.toFixed(2)}`).join(',');
      d.gaze = `${gaze.x.toFixed(2)},${gaze.y.toFixed(2)}`;
      return true;
    }

    // the model's textures and how many actually have their image (a blocked blob: fetch leaves them empty)
    function textureMaps() {
      const seen = new Set();
      let loaded = 0;
      if (vrm) vrm.scene.traverse((o) => {
        for (const m of [].concat(o.material || [])) {
          for (const v of [...Object.values(m), ...Object.values(m.uniforms || {}).map((u) => u && u.value)]) {
            if (!v || !v.isTexture || seen.has(v)) continue;
            seen.add(v);
            const img = v.image || (v.source && v.source.data);
            if (img && (img.width || img.naturalWidth) > 0) loaded++;
          }
        }
      });
      return { total: seen.size, loaded };
    }

    function fig() {
      return {
        canvas,
        pause: () => { lastRender = null; },
        debug: () => ({
          loaded: !!vrm, anim: animState, mode: canvas.dataset.mode, frame: frameN, fps: meter.fps(performance.now()), state: stateNow, lip: lipMode,
          face: { ...face }, mouth: { ...mouth }, gaze: { ...gaze }, motion: Object.fromEntries(Object.entries(cur).filter(([, v]) => Math.abs(v) > 0.01)),
          expressions: vrm && vrm.expressionManager ? Object.keys(vrm.expressionManager.expressionMap) : [],
          springJoints: vrm && vrm.springBoneManager ? vrm.springBoneManager.joints.size : 0,
          root: vrm ? { x: vrm.scene.position.x, y: vrm.scene.position.y, yaw: vrm.scene.rotation.y / DEG, roll: vrm.scene.rotation.z / DEG } : null,
          memory: renderer ? { ...renderer.info.memory } : null, packId: look.packId,
          maps: textureMaps(),
        }),
      };
    }

    // a model that does not load (not a renderable VRM, no WebGL): the app shows the picture instead and never
    // draws or disposes this figure, so it lets its own renderer and context go here
    const api = {
      ready: ready.catch((e) => { api.dispose(); throw e; }),
      draw,
      dispose() {
        if (disposed) return;
        disposed = true;
        figures.delete(me);
        stats.live--;
        stats.disposed++;
        const memory = renderer ? { ...renderer.info.memory } : null;
        try {
          if (mixer && vrm) { mixer.stopAllAction(); mixer.uncacheRoot(vrm.scene); }
          mixer = null;
          if (vrm) { scene.remove(vrm.scene); R.VRMUtils.deepDispose(vrm.scene); }
          if (renderer) { renderer.renderLists.dispose(); renderer.dispose(); renderer.forceContextLoss(); }
        } catch (e) { console.warn('[vrm] dispose:', e && e.message); }
        stats.lastDispose = { packId: look.packId, before: memory, after: renderer ? { ...renderer.info.memory } : null };
        vrm = null;
        scene = null;
        renderer = null;
        if (!figures.size && cursorTimer) { clearInterval(cursorTimer); cursorTimer = 0; }
      },
    };
    return api;
  }

  // a damped spring
  function spring(k, damp, lim = Infinity) {
    return {
      x: 0,
      v: 0,
      step(target, dt) {
        if (!Number.isFinite(target)) return this.x;
        this.v += ((target - this.x) * k - this.v * damp) * dt;
        this.x += this.v * dt;
        if (Math.abs(this.x) > lim) { this.x = Math.sign(this.x) * lim; this.v = 0; }
        return this.x;
      },
    };
  }

  // A picture of a model (pack:// URL of the .vrm), drawn once off-screen: the preview the importer saves for
  // lists and the wardrobe. Resolves with a PNG data URL.
  async function picture(model, { height = 0.8 } = {}) {
    const m = /^pack:\/\/([^/]+)\//.exec(String(model || ''));
    if (!m) throw new Error('not a pack model');
    const c = document.createElement('canvas');
    c.width = 332;
    c.height = 452;
    const f = createFigure(c, { kind: 'vrm', packId: m[1], model, vrm: { height } });
    try {
      if ((await f.ready) === false) throw new Error('the model did not load');
      f.draw({ t: performance.now() / 1000, state: 'idle', still: true });
      return c.toDataURL('image/png');
    } finally {
      f.dispose();
    }
  }

  window.PetVRM = {
    createFigure,
    loadRuntime,
    picture,
    lip,
    stats,
    active: () => figures.size > 0,
    debug: () => ({ figures: [...figures].map((f) => f.debug()), stats: { ...stats }, lipAttached: lip.attached, audioContext: lip.ctx ? lip.ctx.state : null, runtime: window.PetVrmRuntime ? window.PetVrmRuntime.versions : null }),
  };
})();
