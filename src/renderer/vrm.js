'use strict';
// VRM 角色包 (kind "vrm" in docs/pet-packs.md): a VRM 1.0 / 0.x model drawn with three.js + @pixiv/three-vrm
// in a transparent WebGL canvas, acted out by the app.
//
// This file only draws what the app already decided: the look (core/packs.js resolveLook — which pack,
// which outfit, already through the 18+ / affection / outfit rules) and, every frame, a read-only snapshot of
// the app (her needs status, the fx one-shot, lifted, thinking, eating, talking, the last touch, facing, the
// pointer, the window). It never picks an outfit or a pack itself. VRM has its own motion pipeline, apart
// from the pixel characters' (docs/vrm-motion-system.md): core/vrm-intent.js turns the snapshot into
// semantic events, core/vrm-director.js decides the posture, idle, face and gaze for the model's style
// (core/vrm-style.js) from the motion library (core/vrm-library.js, .vrma clips over vrmlib://),
// renderer/vrm-anim.js plays the clips (AnimationMixer, cross-fades), core/vrm-life.js adds the capped alive
// layer, and core/vrm-motion.js has the face fallbacks, lip sync and frame budget.
//
// The runtime (vendor/vrm/three-vrm.min.js, built by scripts/build-vrm-vendor.js) is loaded the first time
// a VRM look is shown. The model is fetched over pack://<id>/… only (src/main/packs.js serves files inside
// that pack's folder); animations come from the pack or vrmlib://; any other URL is refused.
//
// Debug fields on the canvas (read by e2e): data-frame (frames drawn, counting up), data-fps (drawn in
// the last second), data-mode (active | idle | paused), data-state (the semantic events), data-expr
// (expression weights), data-mouth (aa/ih/ou/ee/oh), data-lip (audio | synthetic | off), data-gaze (x,y),
// data-springs (joints), data-vrm (1.0 | 0.x), data-anim (vrma | none | failed), data-style (female |
// male | neutral (pack | meta | default)), data-posture, data-idle, data-reaction, data-hold, data-layers
// (clip:weight…), data-library (loaded | partial:<n> | none), data-overlays (layer:clip:weight of the holds and
// reactions laid over the base), data-framing (full | half, what the camera frames now), data-cut (half: the
// share of her height shown), data-band (bones | box | pack: what the half-body band was measured from).
// window.PetVRM.debug() has the same and more. figure.zoneAt(x, y) tells
// which touch zone a click hits, on the 3D skeleton (core/vrm-hit.js), for app.js.
(function () {
  const M = window.PetVrmMotion;
  const FR = window.PetFraming;
  const GLIDE_S = 0.35; // switching 全身 ⇄ 半身: the camera glides this long (no jump, the model stays loaded)
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
    pointer: null, movedAt: -Infinity, screen: null, screenRaw: null, screenMovedAt: -Infinity,
    get client() { return performance.now() - this.movedAt < POINTER_FRESH_MS || !this.screen ? this.pointer : this.screen; },
    // when the cursor last moved, inside the window or anywhere on the screen (her own window moving does not count)
    get lastMove() { return Math.max(this.movedAt, this.screenMovedAt); },
  };
  window.addEventListener('pointermove', (e) => { cursor.pointer = { x: e.clientX, y: e.clientY }; cursor.movedAt = performance.now(); }, { passive: true });
  let cursorTimer = 0;
  function pollCursor() {
    if (!window.pet || !window.pet.cursorPoint || document.hidden) return;
    window.pet.cursorPoint().then((pt) => {
      if (!pt || !Number.isFinite(pt.x)) return;
      const was = cursor.screenRaw;
      if (was && Math.hypot(pt.x - was.x, pt.y - was.y) > 2) cursor.screenMovedAt = performance.now();
      cursor.screenRaw = { x: pt.x, y: pt.y };
      cursor.screen = M.screenToClient(pt, { x: window.screenX, y: window.screenY });
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
  const I = window.PetVrmIntent;
  const D = window.PetVrmDirector;
  const S = window.PetVrmStyle;
  const Lib = window.PetVrmLibrary;
  const Life = window.PetVrmLife;
  const Hit = window.PetVrmHit;
  // the posture the user chose per pack (settings.vrmPostures, set by app.js), and the debug clock / seed
  const postures = new Map();
  const debugCtl = { speed: 1, seed: null };

  // the motion library (vrmlib://, src/main/vrm-library.js): its index, read for each new figure (a bake or a
  // removed library shows on the next model drawn)
  function loadLibraryIndex() {
    return fetch('vrmlib://index/library.json').then((r) => (r.ok ? r.json() : null)).then((j) => Lib.cleanIndex(j), () => Lib.cleanIndex(null));
  }

  // `look` from core/packs.js resolveLook: { packId, model (pack:// URL of the .vrm), vrm: { height,
  // expressions (state → name overrides), modelExpressions, springBone, meta, license, idle, style, motions }, url }.
  // `framing`: 'full' | 'half' to start in (core/framing.js resolveFraming); figure.setFraming() changes it live.
  function createFigure(canvas, look, { framing: startFraming = 'full' } = {}) {
    const cfg = look.vrm || {};
    const overrides = cfg.expressions || {};
    const share = clamp(Number(cfg.height) || 0.8, 0.3, 1);
    const style = cfg.style && cfg.style.set ? cfg.style : S.resolveStyle({});
    let R = null; // the runtime
    let renderer = null;
    let scene = null;
    let camera = null;
    let vrm = null;
    let anim = null; // renderer/vrm-anim.js layers
    let director = null;
    let life = null;
    let index = { clips: {} };
    const loaded = new Set();
    let libState = 'none';
    let animState = 'none'; // none | vrma | failed
    let lookTarget = null;
    let disposed = false;
    let size = { h: 1, minY: 0, cx: 0, cz: 0 };
    // 取景: the half-body band (FR.halfBodyBand, measured once at rest), the mode drawn and the camera glide
    let band = null;
    let framing = startFraming === 'half' ? 'half' : 'full';
    let glide = null; // { from (camera), t0 } while switching
    let camNow = null; // the camera fit() placed last: { visible, y, dist, x }
    let base = { y: 0, x: 0, yaw: 0 };
    let rest = { hipsY: 1, feetY: 0 };
    const has = (n) => !!(vrm && vrm.expressionManager && vrm.expressionManager.getExpression(n));
    const face = {}; // model expression name → current weight
    let mouth = M.zeroVisemes();
    const blink = { start: -1, next: 1.5 };
    let lastRender = null;
    let lastActivity = performance.now();
    let lastWin = null;
    let vel = [0, 0];
    let lastWinAt = null; // when lastWin was read (ms): the window's speed is over its own interval
    // the walk pace (T-2711): the window's x when it last stood still, and where / when this stretch of motion
    // began. A walk moves the window at one steady speed, but the OS moves it in uneven steps (now 0 px, then
    // twice as far): the pace is the distance since the motion began over the time since, not frame by frame.
    const pace = { stillX: null, stillAt: 0, x0: null, t0: 0, lastMove: -Infinity };
    const PACE_STOP = 250; // ms without a move: the window has stopped
    let frameN = 0;
    let lipMode = 'off';
    let gaze = { x: 0, y: 0 };
    let gazeSrc = 'none'; // what the eyes follow this frame: cursor | away (a glance) | fixed (the director's) | none
    let ground = 0;
    let seatLift = 0; // how far a seated pose is raised to stay inside the frame (groundOffset)
    let floorLift = 0; // seatLift as the floor follows it (eased like the ground)
    let liftK = 0; // 0..1: how far she is held up in the air while lifted
    let seatK = 0; // 0..1: how much of the seat shows (sitting)
    let props = null; // { shadow, seat } — a soft shadow on the floor and the seat under a sitting pose
    let shiftX = 0;
    let yaw = 0;
    let prevSnap = null;
    let dirT = null;
    let plan = null;
    let intent = null;
    let lastBaseKey = -1;
    const injected = []; // semantic events from window.PetVRM.director.inject (tests, debugging)
    const meter = M.FpsMeter();
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
      props = makeProps(T);
      scene.add(props.shadow, props.seat);
      if (vrm.lookAt) { vrm.lookAt.target = lookTarget; vrm.lookAt.autoUpdate = true; }
      measureRest();
      restPose();
      vrm.update(0);
      measure();
      fit(true);
      anim = window.PetVrmAnim.createAnimLayers(R, vrm, Life.BONES);
      await loadClips(own);
      if (disposed) return false;
      startDirector();
      canvas.dataset.anim = animState;
      canvas.dataset.library = libState;
      canvas.dataset.style = `${style.name} (${style.source})`;
      canvas.dataset.vrm = vrm.meta && vrm.meta.metaVersion === '0' ? '0.x' : '1.0';
      canvas.dataset.springs = String(vrm.springBoneManager ? vrm.springBoneManager.joints.size : 0);
      canvas.dataset.frame = '0';
      return true;
    });

    // A .vrma as a clip for this model. `url` must be in the pack or the motion library.
    async function loadVrma(url, own) {
      const al = new R.GLTFLoader();
      al.manager.setURLModifier((u) => (u.startsWith(own) || u.startsWith('vrmlib://') || u.startsWith('data:') || u.startsWith('blob:') ? u : 'data:application/octet-stream,'));
      al.register((parser) => new R.VRMAnimationLoaderPlugin(parser));
      const g = await al.loadAsync(url);
      const a = g.userData && g.userData.vrmAnimations && g.userData.vrmAnimations[0];
      if (!a) throw new Error('not a VRM animation');
      return R.createVRMAnimationClip(a, vrm);
    }

    // The library's clips for this style set (the set, female for neutral, any slot a pack override names),
    // and the pack's own idle loop (vrm.idle) as the fallback without a library. Missing clips are skipped:
    // the director falls back (§6.2), nothing here throws.
    async function loadClips(own) {
      index = await loadLibraryIndex();
      const sets = new Set([style.set, style.set === 'neutral' ? 'female' : null].filter(Boolean));
      const want = Object.values(index.clips).filter((c) => c.file && (sets.has(c.style) || Object.values(cfg.motions || {}).includes(c.id)));
      // fall back to any set when the style's own set is not baked
      const list = want.length ? want : Object.values(index.clips).filter((c) => c.file);
      await Promise.all(list.map(async (c) => {
        try {
          const clip = await loadVrma(`vrmlib://${c.file}`, own);
          if (disposed || !vrm) return;
          anim.add(c.id, clip);
          loaded.add(c.id);
        } catch (e) { console.warn(`[vrm] motion ${c.id} off:`, e && e.message); }
      }));
      libState = list.length ? (loaded.size === list.length ? 'loaded' : loaded.size ? `partial:${list.length - loaded.size}` : 'none') : 'none';
      if (cfg.idle) {
        try {
          if (typeof cfg.idle !== 'string' || !cfg.idle.startsWith(own)) throw new Error('an idle animation is loaded from its own pack only');
          anim.add('pack.idle', await loadVrma(cfg.idle, own));
        } catch (e) { console.warn('[vrm] idle animation off:', e && e.message); animState = 'failed'; }
      }
      if (loaded.size || anim.has('pack.idle')) animState = 'vrma';
    }

    function startDirector() {
      const rand = debugCtl.seed !== null ? D.seeded(debugCtl.seed) : Math.random;
      director = D.createDirector({ style, index, loaded, overrides: cfg.motions || null, posture: postures.get(look.packId) || 'auto', packIdle: anim.has('pack.idle'), rand });
      life = Life.createLife({ style, rand: Math.random });
    }

    // the T-pose's world heights (hips, feet) before anything moves: where the floor is
    function measureRest() {
      const T = R.THREE;
      vrm.scene.updateMatrixWorld(true);
      const y = (n) => { const b = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode(n); return b ? b.getWorldPosition(new T.Vector3()).y : null; };
      const feet = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes'].map(y).filter((v) => v !== null);
      rest = { hipsY: y('hips') || 1, feetY: feet.length ? Math.min(...feet) : 0 };
    }

    // arms down from the T-pose: what she shows before (or without) any clip
    function restPose() {
      const h = vrm.humanoid;
      if (!h) return;
      for (const n of Life.BONES) { const b = h.getNormalizedBoneNode(n); if (b) b.quaternion.identity(); }
      for (const [name, r] of Object.entries(M.REST_POSE)) {
        const n = h.getNormalizedBoneNode(name);
        if (n) n.rotation.set(r.x * DEG, r.y * DEG, r.z * DEG);
      }
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
      // 半身: the band from the humanoid bones (head, neck, upperChest / chest / spine, hips) in this rest pose,
      // not from the box (hair, a tail or a skirt do not move the cut); a model without them: a share of the box
      const bones = {};
      for (const name of ['head', 'neck', 'upperChest', 'chest', 'spine', 'hips']) {
        const n = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode(name);
        if (n) { const p = n.getWorldPosition(new T.Vector3()); bones[name] = { x: p.x, y: p.y }; }
      }
      band = FR.halfBodyBand(bones, { minX: box.min.x, maxX: box.max.x, minY: box.min.y, maxY: box.max.y }, { head: headExtent(T), waist: look.halfBody && look.halfBody.waist }); // pack.json halfBody.waist overrides the hips
      canvas.dataset.band = band.source;
    }

    // Her head: the top and sides of the vertices that move with the head bone or its children (skull, hair, ears,
    // an ahoge), skinned in the rest pose -> { top, minX, maxX } | null. Raised arms or a held prop make the box
    // taller; this does not.
    function headExtent(T) {
      const head = vrm.humanoid && vrm.humanoid.getRawBoneNode('head');
      if (!head) return null;
      const under = (o) => { for (let p = o; p; p = p.parent) if (p === head) return true; return false; };
      const v = new T.Vector3();
      let top = -Infinity;
      let minX = Infinity;
      let maxX = -Infinity;
      const add = (x, y) => { if (y > top) top = y; if (x < minX) minX = x; if (x > maxX) maxX = x; };
      vrm.scene.traverse((o) => {
        if (!o.isMesh || !o.visible || !o.geometry || !o.geometry.attributes.position) return;
        const g = o.geometry;
        const pos = g.attributes.position;
        if (o.isSkinnedMesh && o.skeleton && g.attributes.skinIndex && g.attributes.skinWeight) {
          const inHead = o.skeleton.bones.map(under);
          if (!inHead.some(Boolean)) return;
          const si = g.attributes.skinIndex;
          const sw = g.attributes.skinWeight;
          for (let i = 0; i < pos.count; i++) {
            let best = 0;
            let bw = -1;
            for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
            if (!inHead[best]) continue;
            o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
            add(v.x, v.y);
          }
        } else if (under(o)) {
          const b = new T.Box3().setFromObject(o);
          add(b.min.x, b.max.y);
          add(b.max.x, b.max.y);
        }
      });
      return Number.isFinite(top) ? { top, minX, maxX } : null;
    }

    // the camera for a framing: 全身 = her whole height at `vrm.height` of the canvas, feet on the floor;
    // 半身 = the band (top of her head to the waist) filling the canvas, the cut on its bottom edge. x: where it
    // looks sideways (the model is moved so her box centre is at 0; 半身 centres on the head–hips line instead).
    function cameraFor(mode) {
      const full = { ...FR.cameraFor({ top: size.minY + size.h, bottom: size.minY }, { fov: camera.fov, share, mode: 'full' }), x: 0 };
      if (mode === 'half' && band) return { ...FR.cameraFor(band, { fov: camera.fov, mode: 'half', aspect: camera.aspect, maxVisible: full.visible }), x: band.cx - size.cx };
      return full;
    }
    function setFraming(mode, { instant = false } = {}) {
      const next = mode === 'half' ? 'half' : 'full';
      if (next === framing) return false;
      framing = next;
      if (!vrm) return true; // still loading: the first fit() uses it
      glide = instant || !camNow ? null : { from: { ...camNow }, t0: performance.now() };
      lastActivity = performance.now(); // draw at the full frame rate while gliding
      fit(true);
      return true;
    }

    // her size in the canvas: `vrm.height` of its height (pack.json), feet on the floor, centred; the canvas
    // resolution follows its size on screen (at most 2× the CSS size). The frame is her standing height:
    // sitting down she is smaller in it, not zoomed (§3.6).
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
      let cam = cameraFor(framing);
      if (glide) {
        const t = (performance.now() - glide.t0) / 1000 / GLIDE_S;
        if (t >= 1) glide = null;
        else cam = FR.blendCamera(glide.from, cam, t);
      }
      camNow = cam;
      camera.position.set(cam.x, cam.y, size.cz + cam.dist);
      camera.near = Math.max(0.01, cam.dist / 20);
      camera.far = cam.dist * 4;
      camera.updateProjectionMatrix();
      camera.lookAt(cam.x, cam.y, size.cz);
      const d = canvas.dataset;
      if (d.framing !== framing) d.framing = framing;
      const cut = framing === 'half' && band ? band.cut.toFixed(3) : '1';
      if (d.cut !== cut) d.cut = cut;
    }

    // the bones a seated pose may push below the frame, and how far (× hips height) her mesh hangs below each
    const SEAT_PADS = [['hips', 0.2], ['leftUpperLeg', 0.12], ['rightUpperLeg', 0.12], ['leftLowerLeg', 0.09], ['rightLowerLeg', 0.09], ['leftFoot', 0.08], ['rightFoot', 0.08], ['leftToes', 0.05], ['rightToes', 0.05]];
    // feet on the floor whatever the clip does with the hips (sitting on the floor: the seat on it), and a
    // sitting pose centred on its own width — a reclined sit reaches far to one side (§3.6)
    function groundOffset(sit) {
      const T = R.THREE;
      tmp.g = tmp.g || new T.Vector3();
      const h = vrm.humanoid;
      const at = (n) => { const b = h.getNormalizedBoneNode(n); return b ? b.getWorldPosition(tmp.g).clone() : null; };
      vrm.scene.updateMatrixWorld(true);
      const sp = vrm.scene.position;
      const pts = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes', 'leftLowerLeg', 'rightLowerLeg', 'hips', 'head', 'leftHand', 'rightHand'].map(at).filter(Boolean);
      const hips = at('hips');
      const low = Math.min(...pts.filter((p, i) => i < 6).map((p) => p.y), hips ? hips.y - rest.hipsY * 0.09 : Infinity) - sp.y;
      const xs = pts.map((p) => p.x - sp.x);
      const x = sit && xs.length ? -(Math.min(...xs) + Math.max(...xs)) / 2 : 0;
      let y = Number.isFinite(low) ? rest.feetY - low : 0;
      // sitting, the knees and feet come towards the camera and the seat, thighs and skirt hang below their
      // bones: on the floor line they fell out of the bottom of the canvas (liliya's sit.rest was cut at the
      // waist, T-2684). Lift the seated body until each part's mesh (bone − pad) is above the bottom edge of
      // the view at that part's own depth; a standing figure is framed as before.
      seatLift = 0;
      if (sit && camera) {
        const tan = Math.tan((camera.fov * DEG) / 2);
        const margin = (size.h / share) * 0.012;
        let need = -Infinity;
        for (const [n, pad] of SEAT_PADS) {
          const p = at(n);
          if (!p) continue;
          const d = camera.position.z - p.z;
          if (d <= 0) continue;
          const bottom = camera.position.y - d * tan;
          need = Math.max(need, bottom + margin - (p.y - sp.y - pad * rest.hipsY));
        }
        if (Number.isFinite(need) && need > y) { seatLift = need - y; y = need; }
      }
      return { y, x: Number.isFinite(x) ? x : 0 };
    }

    // ---------- props: the floor shadow and the seat (T-2691) ----------
    // A soft round shadow on the floor under her (it stays on the floor when she is lifted, smaller and
    // fainter: she hangs above it), and a seat under a sitting pose — a low round pouf from the floor up to
    // under her hips, a flat cushion for a floor sit — so a seated pose never sits on thin air.
    const LIFT_UP = 0.05; // of the canvas height
    function makeProps(T) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
      grad.addColorStop(0, 'rgba(40,36,60,0.55)');
      grad.addColorStop(0.6, 'rgba(40,36,60,0.22)');
      grad.addColorStop(1, 'rgba(40,36,60,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
      const tex = new T.CanvasTexture(c);
      const shadow = new T.Mesh(new T.PlaneGeometry(1, 1), new T.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.8 }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.renderOrder = -1;
      shadow.name = 'vrm-shadow';
      const seat = new T.Mesh(new T.CylinderGeometry(1, 1.06, 1, 40, 1), new T.MeshLambertMaterial({ color: 0xd9b3a3, transparent: true, opacity: 0 }));
      seat.name = 'vrm-seat';
      seat.visible = false;
      return { shadow, seat };
    }
    function placeProps(dt, sit) {
      if (!props || !vrm.humanoid) return;
      const T = R.THREE;
      const h = rest.hipsY;
      vrm.scene.updateMatrixWorld(true);
      tmp.p = tmp.p || new T.Vector3();
      const hips = vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(tmp.p).clone();
      const floor = size.minY + floorLift;
      // the shadow: under her hips, on the floor; lifted, smaller and fainter
      const sh = props.shadow;
      const k = 1 - 0.45 * liftK;
      sh.scale.set(h * 0.62 * k, h * 0.34 * k, 1);
      sh.position.set(hips.x, floor + 0.002, hips.z);
      sh.material.opacity = 0.8 * (1 - 0.5 * liftK);
      // the seat: fades in with the sitting pose, from the floor up to just under the hips
      seatK = lerp(seatK, sit ? 1 : 0, approach(sit ? 3 : 6, dt));
      const seat = props.seat;
      seat.visible = seatK > 0.01;
      if (seat.visible) {
        const top = hips.y - h * 0.1;
        const bottom = Math.min(floor, top - h * 0.04);
        const r = h * 0.26;
        seat.scale.set(r, Math.max(0.01, top - bottom), r * 0.85);
        seat.position.set(hips.x, (top + bottom) / 2, hips.z - h * 0.04);
        seat.material.opacity = seatK;
      }
      seatInfo = { visible: seat.visible, k: +seatK.toFixed(2), top: +(hips.y - h * 0.1).toFixed(3), floor: +floor.toFixed(3), hipsY: +hips.y.toFixed(3), height: seat.visible ? +seat.scale.y.toFixed(3) : 0 };
    }
    let seatInfo = null;

    // how the turn lead is shared out from the chest up (deg of turnLead per bone; head + neck lead most)
    const TURN_LEAD = [['chest', 0.15], ['upperChest', 0.2], ['neck', 0.3], ['head', 0.45]];
    // the alive layer's offsets (deg) on the clip's pose
    function applyLife(bones) {
      const T = R.THREE;
      const h = vrm.humanoid;
      tmp.e = tmp.e || new T.Euler();
      tmp.q = tmp.q || new T.Quaternion();
      // the layer is written in VRM 1.0 / VRMA terms (she faces +Z); a 0.x model's normalized bones face −Z
      // (rotateVRM0 turns the whole scene), so x and z turn the other way there — without this a lifted 0.x
      // model bent its knees backwards (T-2691)
      const v0 = vrm.meta && vrm.meta.metaVersion === '0' ? -1 : 1;
      for (const [name, r] of Object.entries(bones)) {
        const n = h.getNormalizedBoneNode(name);
        if (!n || (!r.x && !r.y && !r.z)) continue;
        tmp.e.set(r.x * DEG * v0, r.y * DEG, r.z * DEG * v0);
        n.quaternion.multiply(tmp.q.setFromEuler(tmp.e));
      }
    }

    // where she looks: the cursor (as a point between her and the screen) with the alive layer's saccades and
    // glances, or the director's fixed target (thinking up, asleep down, a shy look aside…)
    const tmp = {};
    function aim(dt, lifeOut, cursorStill = Infinity) {
      const T = R.THREE;
      tmp.v = tmp.v || new T.Vector3();
      tmp.d = tmp.d || new T.Vector3();
      const rect = canvas.getBoundingClientRect();
      let g;
      // the director's look-about (a 'look' cue) is a glance too: a moving cursor wins over it; a reaction's,
      // a hold's (think, lifted) and sleep's gaze are part of what she does and stay
      const scanYields = plan.gaze.kind === 'scan' && cursorStill < Life.GLANCE_AFTER;
      if (plan.gaze.mode === 'fixed' && !scanYields) { g = { x: plan.gaze.x, y: plan.gaze.y }; gazeSrc = `fixed${plan.gaze.kind ? `:${plan.gaze.kind}` : ''}`; }
      else if (lifeOut.away) { g = lifeOut.gaze; gazeSrc = 'away'; }
      else { g = cursor.client ? M.gazeNdc(cursor.client, rect) : { x: 0, y: 0.1 }; g = { x: g.x + lifeOut.gaze.x, y: g.y + lifeOut.gaze.y }; gazeSrc = cursor.client ? 'cursor' : 'none'; }
      const k = approach(8, dt);
      const before = gaze;
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
      return Math.hypot(gaze.x - before.x, gaze.y - before.y);
    }

    // snap: the app's read-only snapshot (docs §2.2) — or an old-style { t, state } (the picture, the hatch
    // screen), wrapped by core/vrm-intent.js. Every call feeds the director (events are not lost on a frame
    // that is not drawn); drawing follows the frame budget.
    function draw(input) {
      if (!vrm || disposed || !director) return false;
      const t = input.t;
      const snap = input.status === undefined && input.state !== undefined ? { ...I.fromState(input.state, t), voice: input.voice, talking: input.talking || input.state === 'talk', win: input.win } : input;
      const now = t * 1000;
      intent = I.fromSnapshot(snap, prevSnap);
      prevSnap = snap;
      if (injected.length) { intent.events.push(...injected); injected.length = 0; } // the debug interface's events
      // the window's motion (screen px/s), over the time since the last reading (T-2711: it was divided by the
      // time since the last drawn frame, which under-read it whenever frames were skipped)
      const win = snap.win;
      if (win) {
        if (lastWin && lastWinAt !== null && now > lastWinAt) {
          const wdt = clamp((now - lastWinAt) / 1000, 1e-3, 0.25);
          const k = approach(14, wdt);
          vel = [lerp(vel[0], (win[0] - lastWin[0]) / wdt, k), lerp(vel[1], (win[1] - lastWin[1]) / wdt, k)];
        }
        if (lastWin && win[0] !== lastWin[0]) {
          if (pace.x0 === null || now - pace.lastMove > PACE_STOP) { pace.x0 = pace.stillX === null ? lastWin[0] : pace.stillX; pace.t0 = pace.stillX === null ? lastWinAt : pace.stillAt; }
          pace.lastMove = now;
        } else if (!lastWin || now - pace.lastMove > PACE_STOP) { pace.stillX = win[0]; pace.stillAt = now; }
        if (!lastWin || now > lastWinAt) { lastWin = win; lastWinAt = now; }
      }
      // walking about: how fast the window carries her across the screen, in her own hip heights per second
      // (the director matches the walk cycle's pace to it, T-2711)
      if (intent.holds.walk) {
        const rect = canvas.getBoundingClientRect();
        const pxPerM = pxPerMetre(rect.height || 452);
        const moving = win && pace.x0 !== null && now - pace.lastMove <= PACE_STOP;
        const span = moving ? (now - pace.t0) / 1000 : 0;
        const px = span >= 0.08 ? Math.abs(win[0] - pace.x0) / span : 0;
        intent.holds.walkSpeed = px / pxPerM / Math.max(0.1, rest.hipsY);
      }
      const ddt = dirT === null ? 0 : clamp(t - dirT, 0, 0.25);
      dirT = t;
      plan = director.update(ddt * debugCtl.speed, intent);
      const H = intent.holds;
      if (intent.events.length || plan.busy) lastActivity = now;
      if (cursor.movedAt > lastActivity) lastActivity = cursor.movedAt;
      const moving = Math.abs(vel[0]) + Math.abs(vel[1]) > 30;
      if (moving) lastActivity = now;
      const blinking = blink.start >= 0 || t >= blink.next - 0.05;
      const fading = anim && anim.fading();
      const fm = M.frameMode({ now, lastActivity, hidden: isHidden(), talking: H.talk, dragging: H.lift || moving, busy: plan.busy || fading, blinking });
      if (canvas.dataset.mode !== fm.mode) canvas.dataset.mode = fm.mode;
      if (!input.still && !M.shouldRender(now, lastRender, fm.fps)) {
        if (fm.mode === 'paused') { lastRender = null; canvas.dataset.fps = '0'; }
        return true;
      }
      const dt = lastRender == null ? 1 / 30 : clamp((now - lastRender) / 1000, 0, 0.1);
      lastRender = now;
      if (glide) { lastActivity = now; fit(); } else if (frameN % 30 === 0) fit();

      // L0/L1: the director's base clip, cross-faded
      if (plan.base && plan.base.key !== lastBaseKey) {
        // an idle clip starts somewhere in its loop at a slightly different pace each time: the same idle
        // never beats on the same clock twice (T-2691)
        const idleClip = plan.idleKind === 'clip' && plan.posture === null;
        if (plan.base.id && anim.has(plan.base.id)) anim.setBase(plan.base.id, lastBaseKey < 0 ? 0 : plan.base.fade, idleClip ? { phase: Math.random(), speed: 0.9 + Math.random() * 0.2 } : null);
        lastBaseKey = plan.base.key;
      }
      const clips = anim.update(dt, plan.overlays); // the base, then the holds (L2) and reactions (L3) over it
      if (!clips) restPose(); // no clip: arms down, absolute every frame (nothing accumulates)

      // L4: alive
      // 走神 / 瞥视 wait for a still cursor (vrm-life GLANCE_AFTER): while it moves near her she follows it
      const cursorStill = Math.max(0, (now - cursor.lastMove) / 1000);
      const lifeOut = life.step(dt, { ...plan.life, style, velX: vel[0], fingers: clips ? anim.fingers() : false, cursorStill });
      // turning: her head and chest turn ahead of her hips (the director's turnLead, deg)
      const lead = plan.turnLead || 0;
      if (Math.abs(lead) > 0.05) for (const [b, k] of TURN_LEAD) { const o = lifeOut.bones[b] || (lifeOut.bones[b] = { x: 0, y: 0, z: 0 }); o.y += lead * k; }
      applyLife(lifeOut.bones);

      // the body: on the floor, turned (not mirrored) towards where she faces
      vrm.scene.position.set(base.x, 0, 0);
      vrm.scene.rotation.set(0, base.yaw + yaw * DEG, 0);
      const g = groundOffset(!!(plan.base && plan.base.sit));
      const gk = frameN === 0 ? 1 : approach(4, dt);
      ground = lerp(ground, g.y, gk);
      shiftX = lerp(shiftX, g.x, gk);
      yaw = plan.facingYaw; // eased by the director (a turn takes ≥ 0.3 s, T-2711)
      floorLift = lerp(floorLift, seatLift, gk);
      // lifted: held up off the floor (her shadow stays down there), she sinks back when put down
      liftK = lerp(liftK, plan.life.lifted ? 1 : 0, approach(plan.life.lifted ? 5 : 7, dt));
      const air = liftK * LIFT_UP * (size.h / share);
      vrm.scene.position.set(base.x + shiftX, base.y + ground + air, 0);
      vrm.scene.rotation.set(0, base.yaw + yaw * DEG, 0);
      placeProps(dt, !!(plan.base && plan.base.sit));

      // face: the director's (pack overrides, fallbacks), blinking, the mouth
      const target = M.resolveFace(plan.face, has, overrides[input.state] || null);
      const jump = aim(dt, lifeOut, cursorStill);
      if (lifeOut.blink || (jump > 0.5 && Math.random() < 0.3)) blink.next = Math.min(blink.next, t);
      const eyesShut = (plan.face.blink || 0) > 0.8 || (plan.face.happy || 0) > 0.8;
      if (t >= blink.next && blink.start < 0 && !plan.noBlink && !eyesShut) blink.start = t;
      else if (t >= blink.next && (plan.noBlink || eyesShut)) blink.next = t + 0.5;
      let lids = 0;
      if (blink.start >= 0) {
        lids = M.blinkWeight(t - blink.start);
        if (t - blink.start >= M.BLINK_MS / 1000) { blink.start = -1; lids = 0; blink.next = t + M.nextBlinkIn(); }
      }
      const blinkName = M.expressionFor('blink', has);
      if (blinkName && lids > 0) target[blinkName] = Math.max(target[blinkName] || 0, lids);
      // the mouth: the voice (analyser, else a syllable rhythm), chewing while she eats
      let vis = M.zeroVisemes();
      lipMode = 'off';
      if (H.talk) {
        const s = snap.voice === 'audio' ? lip.sample() : null;
        if (s) { vis = M.visemesFromSpectrum(s.bins, s.sampleRate); lipMode = 'audio'; } else { vis = M.syntheticVisemes(t); lipMode = 'synthetic'; }
        // a mouth-heavy emotion gives way to the words (§3.5)
        for (const n of ['happy', 'relaxed']) { const m = M.expressionFor(n, has); if (m && target[m] > 0.5) target[m] = 0.5; }
      } else if (H.eat) vis.aa = M.chewMouth(t);
      mouth = M.smoothVisemes(mouth, vis, dt);
      for (const k of M.VISEMES) { const n = M.expressionFor(k, has); if (n) target[n] = Math.max(target[n] || 0, mouth[k]); }
      for (const n of new Set([...Object.keys(face), ...Object.keys(target)])) {
        const goal = target[n] || 0;
        // the lids and the mouth are set directly (they already move on their own clock); emotions come in
        // fast (~0.15 s) and fade slowly (~0.6 s) (§3.4)
        const direct = (n === blinkName && lids > 0) || M.VISEMES.includes(n);
        face[n] = direct ? goal : lerp(face[n] || 0, goal, approach(goal > (face[n] || 0) ? 14 : 4, dt));
        if (face[n] < 0.003) face[n] = 0;
        vrm.expressionManager.setValue(n, face[n]);
      }

      vrm.update(dt); // humanoid, look-at, expressions, SpringBone, constraints
      renderer.render(scene, camera);
      frameN++;
      meter.tick(now);
      const d = canvas.dataset;
      d.frame = String(frameN);
      d.fps = String(meter.fps(now));
      d.state = I.summary(intent);
      d.lip = lipMode;
      d.mouth = M.VISEMES.map((k) => `${k}:${mouth[k].toFixed(2)}`).join(',');
      d.expr = Object.entries(face).filter(([, w]) => w > 0.01).map(([n, w]) => `${n}:${w.toFixed(2)}`).join(',');
      d.gaze = `${gaze.x.toFixed(2)},${gaze.y.toFixed(2)}`;
      if (d.gazeSrc !== gazeSrc) d.gazeSrc = gazeSrc;
      d.posture = plan.posture || '';
      d.idle = plan.idle || '';
      d.reaction = plan.reaction || '';
      d.hold = plan.hold || '';
      d.layers = anim.summary();
      d.overlays = anim.overlays();
      d.library = libState;
      d.anim = animState;
      return true;
    }

    // world metres → canvas px at her depth, from the camera that draws her now (半身 frames her closer than
    // 全身: the same window travel is fewer of her steps, a hit shape is more px)
    function pxPerMetre(canvasH) {
      const visH = camNow && camNow.visible ? camNow.visible : size.h / share; // the world height the canvas shows
      return canvasH / (visH || 1);
    }

    // The touch zone under client point (cx, cy): the camera ray through it against spheres and capsules on
    // this frame's skeleton (core/vrm-hit.js). → { zone, pt } like app.js zoneAtClient: pt.x / pt.y in her
    // on-screen box (0..1), pt.box (client px), pt.faceRect (the face in the box, for the blush). A miss: nulls.
    function zoneAt(cx, cy) {
      if (!vrm || !camera || !vrm.humanoid || !Hit) return { zone: null, pt: null };
      const T = R.THREE;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return { zone: null, pt: null };
      vrm.scene.updateMatrixWorld(true);
      const bones = {};
      const v = new T.Vector3();
      for (const n of Hit.BONES) { const b = vrm.humanoid.getNormalizedBoneNode(n); if (b) bones[n] = b.getWorldPosition(v).toArray(); }
      const ry = vrm.scene.rotation.y;
      const list = Hit.shapes(bones, [Math.sin(ry), 0, Math.cos(ry)]);
      const nx = ((cx - rect.left) / rect.width) * 2 - 1;
      const ny = -((cy - rect.top) / rect.height) * 2 + 1;
      const p = new T.Vector3(nx, ny, 0.5).unproject(camera);
      const dir = p.sub(camera.position).normalize().toArray();
      const h = Hit.hit(list, camera.position.toArray(), dir);
      if (!h.zone) return { zone: null, pt: null, miss: !h.shape };
      // her box on screen: the shapes projected (centres ± radius)
      const toClient = (w) => { v.fromArray(w).project(camera); return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }; };
      const pxPerM = pxPerMetre(rect.height);
      let box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (const sh of list) for (const c of sh.kind === 'sphere' ? [sh.c] : [sh.a, sh.b]) {
        const q = toClient(c);
        const r = sh.r * pxPerM;
        box = { left: Math.min(box.left, q.x - r), right: Math.max(box.right, q.x + r), top: Math.min(box.top, q.y - r), bottom: Math.max(box.bottom, q.y + r) };
      }
      const bw = box.right - box.left || 1;
      const bh = box.bottom - box.top || 1;
      const head = list.find((sh) => sh.zone === 'head');
      let faceRect = null;
      if (head) {
        const c = toClient(head.c);
        const r = head.r * pxPerM;
        faceRect = [(c.x - r * 0.6 - box.left) / bw, (c.y - r * 0.1 - box.top) / bh, (c.x + r * 0.6 - box.left) / bw, (c.y + r * 0.9 - box.top) / bh].map((k) => clamp(k, 0, 1));
      }
      return { zone: h.zone, pt: { x: clamp((cx - box.left) / bw, 0, 1), y: clamp((cy - box.top) / bh, 0, 1), opaque: true, pose: 'vrm', box, mirrored: false, faceRect, world: h.point, framing } };
    }

    // where each zone's shapes are on screen (client px, the first shape's centre) — for tests and the hint
    function zoneCenters() {
      if (!vrm || !camera || !vrm.humanoid || !Hit) return {};
      const T = R.THREE;
      const rect = canvas.getBoundingClientRect();
      vrm.scene.updateMatrixWorld(true);
      const bones = {};
      const v = new T.Vector3();
      for (const n of Hit.BONES) { const b = vrm.humanoid.getNormalizedBoneNode(n); if (b) bones[n] = b.getWorldPosition(v).toArray(); }
      const ry = vrm.scene.rotation.y;
      const out = {};
      for (const sh of Hit.shapes(bones, [Math.sin(ry), 0, Math.cos(ry)])) {
        if (!sh.zone || out[sh.zone]) continue;
        let c = sh.kind === 'sphere' ? sh.c : sh.a.map((x, i) => (x + sh.b[i]) / 2);
        if (sh.zone === 'head') c = [c[0], c[1] + sh.r * 0.8, c[2]]; // the top (the front of the sphere is the face)
        v.fromArray(c).project(camera);
        out[sh.zone] = { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      }
      if (out.head) {
        const hd = Hit.shapes(bones, [Math.sin(ry), 0, Math.cos(ry)]).find((sh) => sh.zone === 'head');
        v.fromArray([hd.c[0] + hd.front[0] * hd.r * 0.5, hd.c[1] - hd.r * 0.35, hd.c[2] + hd.front[2] * hd.r * 0.5]).project(camera);
        out.face = { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      }
      return out;
    }

    // the model's textures and how many actually have their image (a blocked blob: fetch leaves them empty)
    function textureMaps() {
      const seen = new Set();
      let loadedN = 0;
      if (vrm) vrm.scene.traverse((o) => {
        for (const m of [].concat(o.material || [])) {
          for (const v of [...Object.values(m), ...Object.values(m.uniforms || {}).map((u) => u && u.value)]) {
            if (!v || !v.isTexture || seen.has(v)) continue;
            seen.add(v);
            const img = v.image || (v.source && v.source.data);
            if (img && (img.width || img.naturalWidth) > 0) loadedN++;
          }
        }
      });
      return { total: seen.size, loaded: loadedN };
    }

    function fig() {
      return {
        canvas,
        packId: look.packId,
        pause: () => { lastRender = null; },
        director: () => director,
        plan: () => plan,
        setPosture: (p) => { if (director) director.setPosture(p); },
        zoneAt,
        zoneCenters,
        inject: (e) => { injected.push(e); },
        pose: () => (vrm ? poseSample() : null),
        debug: () => ({
          loaded: !!vrm, anim: animState, library: libState, clips: [...loaded], mode: canvas.dataset.mode, frame: frameN, fps: meter.fps(performance.now()), state: canvas.dataset.state, lip: lipMode,
          style: { name: style.name, source: style.source, set: style.set, amplitude: style.amplitude, hipSway: style.hipSway },
          plan: plan && { base: plan.base, posture: plan.posture, postureSource: plan.postureSource, setting: plan.setting, idle: plan.idle, idleKind: plan.idleKind, hold: plan.hold, reaction: plan.reaction, reactionKey: plan.reactionKey, reactionWeight: plan.reactionWeight, overlays: plan.overlays, gaze: plan.gaze, face: plan.face, facingYaw: plan.facingYaw, turnLead: plan.turnLead, walk: plan.walk, talkSegment: plan.talkSegment, talkSegments: plan.talkSegments },
          vel: [+vel[0].toFixed(1), +vel[1].toFixed(1)], walkSpeed: intent && intent.holds.walkSpeed !== undefined ? +intent.holds.walkSpeed.toFixed(4) : null,
          idleHistory: director ? director.history() : [],
          reactions: director ? director.reactions() : [],
          overlays: anim ? anim.overlays() : '',
          layers: anim ? anim.summary() : '', weightSum: anim ? anim.weightSum() : 0, ground, seatLift: +seatLift.toFixed(4),
          face: { ...face }, mouth: { ...mouth }, gaze: { ...gaze },
          // the pixel vocabulary is gone: no procedural hop / spin / dangle on a VRM (docs §2.3)
          motion: {},
          expressions: vrm && vrm.expressionManager ? Object.keys(vrm.expressionManager.expressionMap) : [],
          springJoints: vrm && vrm.springBoneManager ? vrm.springBoneManager.joints.size : 0,
          root: vrm ? { x: vrm.scene.position.x, y: vrm.scene.position.y, yaw: vrm.scene.rotation.y / DEG, roll: vrm.scene.rotation.z / DEG } : null,
          bones: vrm ? boneSample() : null,
          pose: vrm ? poseSample() : null,
          props: { seat: seatInfo, lift: +liftK.toFixed(3), floorLift: +floorLift.toFixed(4) },
          framing, band: band ? { ...band } : null, gliding: !!glide,
          camera: camera ? { x: camera.position.x, y: camera.position.y, z: camera.position.z, fov: camera.fov } : null, size: { ...size },
          memory: renderer ? { ...renderer.info.memory } : null, packId: look.packId,
          maps: textureMaps(),
        }),
      };
    }
    // the pose in numbers for the acceptance checks (T-2691): every main bone's normalized rotation (quaternion,
    // to measure how far a reaction moves her from the idle), the legs (hips / knee / ankle heights, the knee
    // angle — 0 straight, positive bent forward, negative a knee bent backwards), and how far the head is
    // turned from where her body faces (deg, + = to her left)
    const POSE_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];
    function poseSample() {
      const T = R.THREE;
      const hm = vrm.humanoid;
      vrm.scene.updateMatrixWorld(true);
      const q = {};
      for (const n of POSE_BONES) { const b = hm.getNormalizedBoneNode(n); if (b) q[n] = b.quaternion.toArray().map((v) => +v.toFixed(4)); }
      const w = (n) => { const b = hm.getNormalizedBoneNode(n); return b ? b.getWorldPosition(new T.Vector3()) : null; };
      const legs = {};
      const hipsP = w('hips');
      for (const s of ['left', 'right']) {
        const up = w(`${s}UpperLeg`), kn = w(`${s}LowerLeg`), an = w(`${s}Foot`);
        if (!up || !kn || !an) continue;
        const a = kn.clone().sub(up), b2 = an.clone().sub(kn);
        let ang = a.angleTo(b2) / DEG;
        // which way the knee bends: a knee in front of the hip–ankle line bends the right way (+); behind it,
        // backwards (−). Her front is where the hips face.
        const fwd = new T.Vector3(0, 0, 1).applyQuaternion(hm.getNormalizedBoneNode('hips').getWorldQuaternion(new T.Quaternion()));
        if (vrm.meta && vrm.meta.metaVersion === '0') fwd.negate(); // 0.x normalized bones face −Z
        const mid = up.clone().add(an).multiplyScalar(0.5);
        if (kn.clone().sub(mid).dot(fwd) < -0.003) ang = -ang;
        const to = w(`${s}Toes`);
        // the ankle along her facing (m, + = ahead of the hips: a stride alternates the two) and where it is
        // on screen (client px: with the window's position, how far a planted foot slides, T-2711)
        const face = new T.Vector3(Math.sin(vrm.scene.rotation.y - base.yaw), 0, Math.cos(vrm.scene.rotation.y - base.yaw));
        const sp = an.clone().project(camera);
        const rect = canvas.getBoundingClientRect();
        legs[s] = { knee: +ang.toFixed(1), ankleBelowHips: +(hipsP.y - an.y).toFixed(4), ankleY: +an.y.toFixed(4), kneeY: +kn.y.toFixed(4), toeDrop: to ? +(an.y - to.y).toFixed(4) : null, ankleFwd: +an.clone().sub(hipsP).dot(face).toFixed(4), ankleClientX: +(rect.left + ((sp.x + 1) / 2) * rect.width).toFixed(2) };
      }
      legs.hipsY = +hipsP.y.toFixed(4);
      // head yaw against the body's facing (the scene's turn)
      const hq = hm.getNormalizedBoneNode('head').getWorldQuaternion(new T.Quaternion());
      const f = new T.Vector3(0, 0, 1).applyQuaternion(hq);
      const headYaw = Math.atan2(f.x, f.z) / DEG - vrm.scene.rotation.y / DEG;
      const hipq = hm.getNormalizedBoneNode('hips').getWorldQuaternion(new T.Quaternion());
      const fh = new T.Vector3(0, 0, 1).applyQuaternion(hipq);
      const hipsYaw = Math.atan2(fh.x, fh.z) / DEG - vrm.scene.rotation.y / DEG;
      const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
      return { q, legs, headYaw: +wrap(headYaw).toFixed(2), hipsYaw: +wrap(hipsYaw).toFixed(2), rootY: +vrm.scene.position.y.toFixed(4) };
    }

    // a few bones (deg, normalized) for the e2e's drift / T-pose checks
    function boneSample() {
      const T = R.THREE;
      const e = new T.Euler();
      const out = {};
      for (const n of ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg']) {
        const b = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode(n);
        if (b) { e.setFromQuaternion(b.quaternion); out[n] = [e.x / DEG, e.y / DEG, e.z / DEG].map((v) => +v.toFixed(2)); }
      }
      return out;
    }

    // a model that does not load (not a renderable VRM, no WebGL): the app shows the picture instead and never
    // draws or disposes this figure, so it lets its own renderer and context go here
    const api = {
      ready: ready.catch((e) => { api.dispose(); throw e; }),
      draw,
      zoneAt,
      setFraming,
      framing: () => framing,
      dispose() {
        if (disposed) return;
        disposed = true;
        figures.delete(me);
        stats.live--;
        stats.disposed++;
        const memory = renderer ? { ...renderer.info.memory } : null;
        try {
          if (anim) anim.dispose();
          anim = null;
          if (vrm) { scene.remove(vrm.scene); R.VRMUtils.deepDispose(vrm.scene); }
          if (props) { for (const m of [props.shadow, props.seat]) { scene.remove(m); m.geometry.dispose(); if (m.material.map) m.material.map.dispose(); m.material.dispose(); } props = null; }
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

  // the VRM director for tests and debugging (docs §7): speed up its clock, fix its random numbers, read the
  // plan, pin a posture (app.js persists the user's choice through setPosture)
  const director = {
    speed: (k) => { debugCtl.speed = clamp(Number(k) || 1, 0.1, 100); return debugCtl.speed; },
    seed: (n) => { debugCtl.seed = n == null ? null : Number(n) >>> 0; for (const f of figures) { const d = f.director(); if (d && debugCtl.seed !== null) d.seed(debugCtl.seed); } return debugCtl.seed; },
    plan: () => { const f = [...figures][0]; return f ? f.plan() : null; },
    history: () => { const f = [...figures][0]; const d = f && f.director(); return d ? d.history() : []; },
    setPosture: (packId, p) => { postures.set(packId, p || 'auto'); for (const f of figures) if (f.packId === packId) f.setPosture(p || 'auto'); },
    postures: () => Object.fromEntries(postures),
    // a semantic event as if the app had sent it ({ type: 'celebrate', name: 'evolve' }…), and the zones on screen
    inject: (e) => { for (const f of figures) f.inject(e); return true; },
    zoneCenters: () => { const f = [...figures][0]; return f ? f.zoneCenters() : {}; },
    reactions: () => { const f = [...figures][0]; const d = f && f.director(); return d ? d.reactions() : []; },
    // the pose numbers alone (legs, ankles, head / hips yaw), light enough to sample every few ms (T-2711)
    pose: () => { const f = [...figures][0]; return f ? f.pose() : null; },
  };

  window.__pet = Object.assign(window.__pet || {}, { vrmDirector: director }); // the name docs §7 gives it
  window.PetVRM = {
    director,
    createFigure,
    loadRuntime,
    picture,
    lip,
    stats,
    active: () => figures.size > 0,
    debug: () => ({ figures: [...figures].map((f) => f.debug()), stats: { ...stats }, lipAttached: lip.attached, audioContext: lip.ctx ? lip.ctx.state : null, runtime: window.PetVrmRuntime ? window.PetVrmRuntime.versions : null }),
  };
})();
