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
// male | neutral (pack | meta | default)), data-posture, data-idle, data-reaction, data-hold, data-action (the
// director's action state, T-2829: idle | returning | dance | eat | touch …), data-acts (the procedural eat / play /
// sleep bodies laid on her, T-2831: name:weight), data-layers
// (clip:weight…), data-library (loaded | partial:<n> | none), data-overlays (layer:clip:weight of the holds and
// reactions laid over the base), data-framing (full | half, what the camera frames now), data-cut (half: the
// share of her height shown), data-band (bones | box | pack: what the half-body band was measured from).
// Dancing (docs/vrm-dance.md §7.1): data-dance (the dance id or ''), data-dance-state (off | cueing | in | on |
// paused | out), data-dance-t (the time in the dance, s), data-dance-audio (playing | paused | muted | ducked |
// none | failed), data-dance-drift (ms: the time shown − the music's clock), data-dance-hips (x,z m: her hips
// off centre), data-dance-cam (how much the dance camera pulls back), data-dance-exclusive (1: the dance has
// the whole body).
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
  // the dance controller (renderer/vrm-dance.js) pauses the music while she is out of sight
  const visibility = new Set();
  function onHidden() {
    for (const fn of visibility) try { fn(isHidden()); } catch (e) { console.warn('[vrm] visibility:', e && e.message); }
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
  const Acts = window.PetVrmActs; // T-2831: the bodies of eat / play / sleep (procedural, no clip)
  const Hit = window.PetVrmHit;
  // the posture the user chose per pack (settings.vrmPostures, set by app.js), and the debug clock / seed
  const postures = new Map();
  const debugCtl = { speed: 1, seed: null, yaw: 0 }; // yaw (deg): turned on top of her facing, for the e2e (T-5098: her back)

  // the motion library (vrmlib://, src/main/vrm-library.js): its index, read for each new figure (a bake or a
  // removed library shows on the next model drawn)
  // (T-5084: with where it came from — main answers { missing, source } when there is none — and whether the fetch
  // failed, for the hint shown when a VRM has to fall back to breathing only)
  function loadLibraryIndex() {
    return fetch('vrmlib://index/library.json').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(
      (j) => Object.assign(Lib.cleanIndex(j), { raw: { missing: !!(j && j.missing), source: (j && j.source) || null, entries: Object.keys((j && j.clips) || {}).length } }),
      (e) => Object.assign(Lib.cleanIndex(null), { raw: { missing: true, source: null, entries: 0, error: String((e && e.message) || e) } }),
    );
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
    let libInfo = null; // T-5084: { state, reason, set, sets, wanted, loaded, failed: [{ id, error }], source } — debug() and the hint
    let lifeInfo = null;
    let headBox = null; // T-5092: her drawn head for the touch zone (measureHeadBox)
    let partBoxes = null; // T-5098: every body part as drawn, for the touch zones (measurePartBoxes)
    // T-5092: a model whose humanoid hips bone sits on the floor (Wanderer): where her real hip joints are, so the
    // hips turn about them and the hips travel scales with their height (loadClips sets it; null for other models)
    let hipsRig = null;
    const clipRepairs = { clips: 0, steps: 0, jerkClips: 0, jerkKeys: 0, jerkMaxCutDeg: 0 }; // T-5084: steps in clips' own keys spread at load (loadVrma) // T-5084: the alive layer's offsets of the last frame (debug().life)
    let boneFold = null; // the bones this model lacks and where their turns went (foldMissingBones)
    let animState = 'none'; // none | vrma | failed
    let lookTarget = null;
    let disposed = false;
    let size = { h: 1, minY: 0, cx: 0, cz: 0 };
    // 取景: the half-body band (FR.halfBodyBand, measured once at rest), the mode drawn and the camera glide
    let band = null;
    let framing = startFraming === 'half' ? 'half' : 'full';
    let glide = null; // { from (camera), t0, dur } while switching
    // the dance layer (docs/vrm-dance.md §3): its clips (id → { entry, duration, faceTrack }), whether the
    // camera frames a dance now and how far it pulls back, the debug numbers of the last frame
    const dances = new Map();
    let danceCam = 1;
    let danceView = false;
    let danceInfo = { id: '', state: 'off', t: 0, drift: 0, hips: [0, 0], audio: 'none' };
    let danceRelease = null;
    let lastLoops = null;
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
    // 半身 and sitting: her head comes down with the seat and the seated pose is centred on its whole width
    // (legs out front), so the half-body camera follows her head–hips line (world m; eased; 0 standing)
    let camDy = 0;
    let camDx = 0;
    let restHeadY = null; // the head bone's height in the rest pose (measure())
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
    let actOut = null; // what the eat / play / sleep bodies did this frame ({ air, bones }), T-2831
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
      anim.setRest(restQuats()); // the base to fall back to (T-2829): a dance or a posture always fades back to it
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
    // T-5098: the jerk limit for one-shot reactions and holds (core/vrm-bone-map.js limitAccel): ≤ JERK_MAX °/s³ keeps
    // their spike ≤ 10°/frame@30 at the 9–15 fps a machine without a GPU draws; idles, postures and dances are slow
    // enough or must stay as choreographed
    const JERK_MAX = 90000;
    async function loadVrma(url, own, meta = null) {
      const al = new R.GLTFLoader();
      al.manager.setURLModifier((u) => (u.startsWith(own) || u.startsWith('vrmlib://') || u.startsWith('data:') || u.startsWith('blob:') ? u : 'data:application/octet-stream,'));
      al.register((parser) => new R.VRMAnimationLoaderPlugin(parser));
      const g = await al.loadAsync(url);
      const a = g.userData && g.userData.vrmAnimations && g.userData.vrmAnimations[0];
      if (!a) throw new Error('not a VRM animation');
      foldMissingBones(a);
      const clip = R.createVRMAnimationClip(a, vrm);
      if (hipsRig) rescaleHipsTravel(a, clip);
      // a step in the clip's own keys (a source glitch) would be a snap however it is faded in: spread it (T-5084)
      const BM = window.PetVrmBoneMap;
      if (BM && BM.smoothSteps) {
        let n = 0;
        for (const tr of clip.tracks) if (/\.quaternion$/.test(tr.name) && !/Thumb|Index|Middle|Ring|Little|Toes/.test(tr.name)) n += BM.smoothSteps(tr.times, tr.values);
        if (n) { clipRepairs.clips++; clipRepairs.steps += n; }
        if (BM.limitAccel && meta && (meta.kind === 'reaction' || meta.kind === 'hold')) {
          let keys = 0;
          for (const tr of clip.tracks) {
            if (!/\.quaternion$/.test(tr.name) || /Thumb|Index|Middle|Ring|Little|Toes/.test(tr.name)) continue;
            const r = BM.limitAccel(tr.times, tr.values, { jMax: JERK_MAX });
            if (!r) continue;
            tr.times = r.times;
            tr.values = r.values;
            keys += r.fixed;
            clipRepairs.jerkMaxCutDeg = Math.max(clipRepairs.jerkMaxCutDeg, r.maxCutDeg);
          }
          if (keys) { clipRepairs.jerkClips++; clipRepairs.jerkKeys += keys; }
        }
      }
      return clip;
    }

    // T-5092: the hips of a model whose hips bone is on the floor. three-vrm scales a clip's hips travel by the
    // model's hips height / the clip's: ~0 here, so every bounce and step of a dance was lost, and the hips rotation
    // turned her whole body about her feet (a dance's lean became a fall or a squat). → { pivot (the upper legs'
    // midpoint from the hips bone, in its parent's axes), height (of that point above the hips bone), restY }
    function measureHipsRig() {
      const T = R.THREE;
      const h = vrm.humanoid;
      const BM = window.PetVrmBoneMap;
      const hips = h.getNormalizedBoneNode('hips');
      const l = h.getNormalizedBoneNode('leftUpperLeg');
      const r = h.getNormalizedBoneNode('rightUpperLeg');
      if (!hips || !l || !r || !hips.parent || !BM || !BM.legRig) return null;
      vrm.scene.updateMatrixWorld(true);
      // T-5098: her hips height from her legs (core/vrm-bone-map.js legRig): the leg chain + the ankle over the floor
      const pos = {};
      for (const n of ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot']) { const b = h.getNormalizedBoneNode(n); if (b) pos[n] = b.getWorldPosition(new T.Vector3()).toArray(); }
      const leg = BM.legRig(pos, size ? size.minY : 0);
      if (!leg || !leg.ok) return null;
      const mid = new T.Vector3(...leg.joints);
      const local = hips.parent.worldToLocal(mid.clone()).sub(h.normalizedRestPose.hips.position ? new T.Vector3(...h.normalizedRestPose.hips.position) : hips.position);
      if (!(local.y > 0.2 * leg.height)) return null;
      // the clip's hips travel is scaled to the hip joints' height over the floor (the leg chain), the turn pivots there
      return { pivot: local.toArray(), height: leg.height, restY: h.normalizedRestPose.hips.position[1], leg };
    }
    // the clip's hips travel scaled by her hip joints' height instead (rest + (raw − clip rest) × k, VRM 0.x x / z
    // mirrored like three-vrm does)
    function rescaleHipsTravel(a, clip) {
      const raw = a.humanoidTracks && a.humanoidTracks.translation && a.humanoidTracks.translation.get('hips');
      const node = vrm.humanoid.getNormalizedBoneNode('hips');
      const tr = raw && node && clip.tracks.find((t) => t.name === `${node.name}.position`);
      const u = a.restHipsPosition && a.restHipsPosition.y;
      if (!tr || !(u > 0.05) || tr.values.length !== raw.values.length) return;
      const k = hipsRig.height / u;
      const v0 = metaVersion() === '0';
      for (let i = 0; i < raw.values.length; i++) {
        const c = i % 3;
        const val = c === 1 ? hipsRig.restY + (raw.values[i] - u) * k : raw.values[i] * k;
        tr.values[i] = v0 && c !== 1 ? -val : val;
      }
      hipsRig.rescaled = (hipsRig.rescaled || 0) + 1;
    }
    // every frame (after all rotations): the hips turned about the hip joints, not the bone on the floor
    function pivotHips() {
      if (!hipsRig || !vrm || !vrm.humanoid) return;
      const n = vrm.humanoid.getNormalizedBoneNode('hips');
      if (!n) return;
      const T = R.THREE;
      tmp.pv = tmp.pv || new T.Vector3();
      const p = tmp.pv.fromArray(hipsRig.pivot);
      const rotated = p.clone().applyQuaternion(n.quaternion);
      n.position.add(p.sub(rotated));
    }

    // A model without an optional bone (upperChest, neck, shoulders…) would lose that bone's turn and everything
    // below it with it (three-vrm drops the track): the rotation is carried into the present children first
    // (core/vrm-bone-map.js foldMissing, T-5081). Counted in debug().boneFold.
    function foldMissingBones(a) {
      const BM = window.PetVrmBoneMap;
      const rot = a && a.humanoidTracks && a.humanoidTracks.rotation;
      if (!BM || !rot || !vrm || !vrm.humanoid) return;
      const has = (b) => !!vrm.humanoid.getNormalizedBoneNode(b);
      if ([...rot.keys()].every(has)) return;
      const tracks = {};
      for (const [b, tr] of rot) tracks[b] = { times: Array.from(tr.times), values: Array.from(tr.values) };
      const r = BM.foldMissing(tracks, has);
      for (const b of [...rot.keys()]) if (!r.tracks[b]) rot.delete(b);
      for (const [b, tr] of Object.entries(r.tracks)) rot.set(b, new R.THREE.QuaternionKeyframeTrack(`${b}.quaternion`, tr.times, tr.values));
      boneFold = { ...(boneFold || {}), folded: r.folded, dropped: r.dropped, level: BM.degradeLevel(has) };
    }

    // The library's clips for this style set (the set, female for neutral, any slot a pack override names),
    // and the pack's own idle loop (vrm.idle) as the fallback without a library. Missing clips are skipped:
    // the director falls back (§6.2), nothing here throws.
    async function loadClips(own) {
      index = await loadLibraryIndex();
      // the set itself, else the first set of its fallback chain the library has (core/vrm-library.js loadSets)
      const sets = new Set(Lib.loadSets ? Lib.loadSets(index, style.set) : [style.set, style.set === 'neutral' ? 'female' : null].filter(Boolean));
      // a model whose hips sit on the floor plays standing clips only (core/vrm-bone-map.js allowsClip, T-5081)
      const BM = window.PetVrmBoneMap;
      let rootHips = false;
      if (BM && vrm.humanoid) {
        const head = vrm.humanoid.getRawBoneNode('head');
        const hy = head ? head.getWorldPosition(new R.THREE.Vector3()).y : 1;
        rootHips = BM.rootHips(vrm.humanoid.normalizedRestPose.hips.position[1], hy);
        if (rootHips) boneFold = { ...(boneFold || {}), rootHips: true };
        hipsRig = rootHips ? measureHipsRig() : null;
      }
      // T-5098: retargeted on her leg chain (measureHipsRig), a hips-on-floor model sits and crouches too
      const allowed = (c) => !BM || BM.allowsClip(c, { rootHips, legRig: hipsRig ? hipsRig.leg : null });
      const failed = [];
      const want = Object.values(index.clips).filter((c) => c.file && allowed(c) && (sets.has(c.style) || Object.values(cfg.motions || {}).includes(c.id)));
      // fall back to any set when the style's own set is not baked
      const list = want.length ? want : Object.values(index.clips).filter((c) => c.file && allowed(c));
      await Promise.all(list.map(async (c) => {
        try {
          const clip = await loadVrma(`vrmlib://${c.file}`, own, c);
          if (disposed || !vrm) return;
          anim.add(c.id, clip);
          loaded.add(c.id);
        } catch (e) { failed.push({ id: c.id, error: String((e && e.message) || e).slice(0, 120) }); console.warn(`[vrm] motion ${c.id} off:`, e && e.message); }
      }));
      libState = list.length ? (loaded.size === list.length ? 'loaded' : loaded.size ? `partial:${list.length - loaded.size}` : 'none') : 'none';
      // T-5084: why, in one place — no library at all, an index whose clips do not suit her, clips that failed — in
      // the console and in debug() / figure.libraryInfo() (the pet window shows a hint: renderer/app.js)
      const raw = index.raw || {};
      const reason = loaded.size ? (failed.length ? 'partial' : 'ok') : raw.error ? 'fetch-failed' : !Object.keys(index.clips).length ? (raw.missing ? 'no-library' : 'empty-index') : !list.length ? 'no-clip-for-model' : 'all-failed';
      libInfo = { state: libState, reason, source: raw.source, set: style.set, style: `${style.name} (${style.source})`, sets: [...sets], wanted: list.length, loaded: loaded.size, failed: failed.slice(0, 20), rootHips, legRig: hipsRig ? hipsRig.leg : null };
      if (reason === 'ok') console.log(`[vrm] ${look.packId}: ${loaded.size} motion clips (${[...sets].join('/')} set for style ${style.name}/${style.source})`);
      else console.warn(`[vrm] ${look.packId}: motion library ${reason} — ${loaded.size}/${list.length} clips loaded${failed.length ? `, failed: ${failed.slice(0, 5).map((f) => f.id).join(', ')}` : ''}${raw.error ? ` (${raw.error})` : ''}; ${loaded.size ? 'the rest falls back' : 'she only breathes and looks about (procedural idle)'}`);
      if (cfg.idle) {
        try {
          if (typeof cfg.idle !== 'string' || !cfg.idle.startsWith(own)) throw new Error('an idle animation is loaded from its own pack only');
          anim.add('pack.idle', await loadVrma(cfg.idle, own));
        } catch (e) { console.warn('[vrm] idle animation off:', e && e.message); animState = 'failed'; }
      }
      if (loaded.size || anim.has('pack.idle')) animState = 'vrma';
    }

    // A dance's clip (docs/vrm-dance.md §3.1): loaded when it is first danced, kept apart from the motion
    // library's clips, let go 30 s after the dance ends. entry: core/vrm-dances.js (its file is <id>/dance.vrma).
    async function loadDance(entry) {
      await ready;
      if (!vrm || disposed) throw new Error('no model');
      if (!entry || !/^[a-z0-9-]{1,48}\/dance\.vrma$/.test(entry.file || '')) throw new Error('not a dance');
      const known = dances.get(entry.id);
      if (known && anim.has(`dance:${entry.id}`)) { known.entry = entry; return { duration: known.duration, faceTrack: known.faceTrack }; }
      const clip = await loadVrma(`vrmlib://dance/${entry.file}`, `pack://${look.packId}/`);
      if (!vrm || disposed) throw new Error('no model');
      anim.add(`dance:${entry.id}`, clip);
      // expression tracks (the mixer drives her face from them) are the ones that are not bone rotations / hips
      const faceTrack = clip.tracks.some((tr) => !/\.(quaternion|position)$/.test(tr.name));
      dances.set(entry.id, { entry, duration: clip.duration, faceTrack });
      return { duration: clip.duration, faceTrack };
    }
    // how far the dance camera pulls back so the whole dance stays in the window (§3.6): her reach up and to
    // the side (entry.extent, in hips heights) against the standing 全身 frame, ×1..2
    function danceCamFor(entry) {
      const ext = (entry && entry.extent) || { up: 1, side: 0.8 };
      const H = Math.max(0.1, rest.hipsY - size.minY);
      const visible = size.h / share;
      const aspect = camera ? camera.aspect : 332 / 452;
      // margins: the top 10 %, and the sides 20 % (a hand reaching out also comes towards the camera: bigger)
      const up = (H * (1 + ext.up)) / 0.9 / visible;
      const side = (2 * (ext.side + ((entry && entry.stage && entry.stage.radius) || 0)) * H) / (0.8 * aspect) / visible;
      return clamp(Math.max(1, up, side), 1, 2.5);
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
      // T-5098: a model whose hips bone is on the floor has her hips at the hip joints (hipsW)
      const BM = window.PetVrmBoneMap;
      const hy = y('head');
      legHips = !!(BM && vrm.humanoid && y('leftUpperLeg') !== null && y('rightUpperLeg') !== null && BM.rootHips(vrm.humanoid.normalizedRestPose.hips.position[1], hy || 1));
      rest = { hipsY: (legHips ? hipsW(new T.Vector3()).y : y('hips')) || 1, feetY: feet.length ? Math.min(...feet) : 0 };
    }
    // where her hips are (world, into `target`): the hips bone, or — a model whose hips bone is a root on the floor
    // (core/vrm-bone-map.js rootHips) — the midpoint of her hip joints (T-5098: the seat, the shadow, the floor
    // under a sitting pose and the half-body camera followed a bone that stays on the floor)
    let legHips = false;
    function hipsW(target) {
      const h = vrm.humanoid;
      if (legHips) {
        const l = h.getNormalizedBoneNode('leftUpperLeg');
        const r = h.getNormalizedBoneNode('rightUpperLeg');
        if (l && r) { tmp.hw = tmp.hw || new R.THREE.Vector3(); l.getWorldPosition(target); r.getWorldPosition(tmp.hw); return target.add(tmp.hw).multiplyScalar(0.5); }
      }
      return h.getNormalizedBoneNode('hips').getWorldPosition(target);
    }

    // arms down from the T-pose: what she shows before any clip (and the rest clip's pose). VRM 0.x mirrors x / z
    // (M.restPoseFor): without it a 0.x model raised both arms instead of lowering them (T-2829)
    const metaVersion = () => (vrm && vrm.meta && vrm.meta.metaVersion === '0' ? '0' : '1');
    function restPose() {
      const h = vrm.humanoid;
      if (!h) return;
      for (const n of Life.BONES) { const b = h.getNormalizedBoneNode(n); if (b) b.quaternion.identity(); }
      for (const [name, r] of Object.entries(M.restPoseFor(metaVersion()))) {
        const n = h.getNormalizedBoneNode(name);
        if (n) n.rotation.set(r.x * DEG, r.y * DEG, r.z * DEG);
      }
    }
    // the rest pose as quaternions per bone, for the rest clip (vrm-anim.js setRest)
    function restQuats() {
      const T = R.THREE;
      const out = {};
      const e = new T.Euler();
      const q = new T.Quaternion();
      for (const [name, r] of Object.entries(M.restPoseFor(metaVersion()))) out[name] = q.setFromEuler(e.set(r.x * DEG, r.y * DEG, r.z * DEG)).toArray();
      return out;
    }
    function measure() {
      const T = R.THREE;
      vrm.scene.updateMatrixWorld(true);
      const box = new T.Box3().setFromObject(vrm.scene);
      const head = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('head');
      let top = box.max.y;
      if (head) { const hp = head.getWorldPosition(new T.Vector3()); top = Math.min(box.max.y, hp.y + (hp.y - box.min.y) * 0.35); restHeadY = hp.y - vrm.scene.position.y; }
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
      headBox = measureHeadBox(T);
      partBoxes = measurePartBoxes(T);
      pickData = buildPick();
      bodySample = null;
      const bl = bodyLow();
      if (bl !== null) rest.bodyFloor = bl - vrm.scene.position.y;
    }
    // the lowest point of her body as drawn now (world y): a sample of the skinned vertices that are body, not cloth
    // (pickData labels; ≤ 4000 of them, every n-th) | null
    let bodySample = null;
    function bodyLow() {
      if (!pickData) return null;
      const T = R.THREE;
      if (!bodySample) {
        bodySample = [];
        let total = 0;
        for (const m of pickData.meshes) for (let i = 0; i < m.lab.length; i++) if (m.lab[i] && m.lab[i] !== pickData.P.cloth) total++;
        const step = Math.max(1, Math.floor(total / 4000));
        let k = 0;
        for (const m of pickData.meshes) for (let i = 0; i < m.lab.length; i++) if (m.lab[i] && m.lab[i] !== pickData.P.cloth && (k++ % step) === 0) bodySample.push([m.o, i]);
      }
      if (!bodySample.length) return null;
      const v = tmp.bl || (tmp.bl = new T.Vector3());
      let low = Infinity;
      for (const [o, i] of bodySample) { if (!o.visible) continue; o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld); if (v.y < low) low = v.y; }
      return Number.isFinite(low) ? low : null;
    }

    // T-5098: a click lands on the triangle drawn under it. Every skinned vertex gets the body part of the bone it is
    // mostly skinned to (the same grouping as measurePartBoxes; the head with what hangs from it, a vertex an
    // expression morph moves is her face, spring-bone cloth and hair below the head are `cloth`), at load; a click
    // skins the meshes as drawn this frame and casts the camera ray against their triangles (meshPick). The zone is
    // that part — the pelvis and the top of the thigh split front / back at her hip joints like the boxes —; on cloth
    // (a coat over her butt, a skirt, hair down her back) the boxes underneath decide. The hover hint keeps the boxes.
    let pickData = null;
    const PICK = ['none', 'head', 'face', 'neck', 'chest', 'belly', 'pelvis', 'arm', 'hands', 'thigh', 'shin', 'feet', 'cloth'];
    function buildPick() {
      const h = vrm.humanoid;
      if (!h) return null;
      const P = Object.fromEntries(PICK.map((n, i) => [n, i]));
      const of = new Map();
      const put = (names, l) => { for (const n of names) { const b = h.getRawBoneNode(n); if (b) of.set(b, l); } };
      put(['head', 'leftEye', 'rightEye', 'jaw'], P.head); put(['neck'], P.neck); put(['chest', 'upperChest'], P.chest); put(['spine'], P.belly); put(['hips'], P.pelvis);
      put(['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'], P.arm);
      const fingers = [];
      for (const sd of ['left', 'right']) for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) for (const k of ['Metacarpal', 'Proximal', 'Intermediate', 'Distal']) fingers.push(`${sd}${f}${k}`);
      put(['leftHand', 'rightHand', ...fingers], P.hands); put(['leftUpperLeg', 'rightUpperLeg'], P.thigh); put(['leftLowerLeg', 'rightLowerLeg'], P.shin); put(['leftFoot', 'rightFoot', 'leftToes', 'rightToes'], P.feet);
      const humanoid = new Set();
      for (const n of Object.keys(h.humanBones || {})) { const b = h.getRawBoneNode(n); if (b) humanoid.add(b); }
      const spring = new Set();
      if (vrm.springBoneManager && vrm.springBoneManager.joints) for (const j of vrm.springBoneManager.joints) if (j.bone) spring.add(j.bone);
      const labelOf = (b) => { let viaSpring = false; for (let p = b; p; p = p.parent) { if (spring.has(p)) viaSpring = true; if (humanoid.has(p)) { const l = of.get(p) || 0; return l === P.head ? P.head : viaSpring ? P.cloth : l; } } return 0; };
      const meshes = [];
      vrm.scene.traverse((o) => {
        if (!o.isSkinnedMesh || !o.skeleton || !o.geometry || !o.geometry.attributes.position) return;
        const g = o.geometry;
        const n = g.attributes.position.count;
        const si = g.attributes.skinIndex; const sw = g.attributes.skinWeight;
        if (!si || !sw) return;
        const bl = o.skeleton.bones.map(labelOf);
        const morph = g.morphAttributes && g.morphAttributes.position ? g.morphAttributes.position : [];
        const lab = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          let best = 0; let bw = -1;
          for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
          let l = bl[best] || 0;
          if (l === P.head && morph.length) for (const ma of morph) if (Math.abs(ma.getX(i)) + Math.abs(ma.getY(i)) + Math.abs(ma.getZ(i)) > 1e-5) { l = P.face; break; }
          lab[i] = l;
        }
        // (T-5099) whether an expression moves any of its vertices: the face skin (and the eyes, brows, mouth on it).
        // Only such a mesh can be her face — hair or a hat in front of the brows is her head even inside the face box
        meshes.push({ o, lab, pos: new Float32Array(n * 3), frame: -1, box: null, faceSkin: lab.includes(P.face) });
      });
      // her face: the box of the vertices an expression moves, in the head bone's frame (a click on head skin inside
      // it — a cheek, the nose — is her face; the forehead and the hair above the brows are her head)
      const head = h.getRawBoneNode('head');
      let face = null;
      if (head) {
        const T = R.THREE;
        vrm.scene.updateMatrixWorld(true);
        const inv = head.matrixWorld.clone().invert();
        const v = new T.Vector3();
        const lo = [Infinity, Infinity, Infinity]; const hi = [-Infinity, -Infinity, -Infinity];
        let nf = 0;
        for (const m of meshes) for (let i = 0; i < m.lab.length; i++) {
          if (m.lab[i] !== P.face) continue;
          m.o.getVertexPosition(i, v).applyMatrix4(m.o.matrixWorld).applyMatrix4(inv);
          const a = v.toArray();
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a[k]); hi[k] = Math.max(hi[k], a[k]); }
          nf++;
        }
        if (nf > 20) { const c = lo.map((x, k) => (x + hi[k]) / 2); const r = lo.map((x, k) => ((hi[k] - x) / 2) * 1.1); face = { lo: c.map((x, k) => x - r[k]), hi: c.map((x, k) => x + r[k]), n: nf }; }
      }
      return meshes.length ? { meshes, P, face } : null;
    }
    // a world point inside her face box (pickData.face, carried by the head bone)
    function inFace(p) {
      const f = pickData && pickData.face;
      const head = f && vrm.humanoid.getRawBoneNode('head');
      if (!head) return false;
      const q = head.worldToLocal(new R.THREE.Vector3(...p)).toArray();
      tmp.faceQ = q; // (the last point tested, head-bone frame: the hit's dbg)
      return q.every((x, k) => x >= f.lo[k] && x <= f.hi[k]);
    }
    // the camera ray (origin, unit dir: arrays) against the drawn triangles → { t, point, label } | null
    function meshPick(origin, dir) {
      if (!pickData) return null;
      const T = R.THREE;
      const v = tmp.mp || (tmp.mp = new T.Vector3());
      let best = null;
      for (const m of pickData.meshes) {
        const o = m.o;
        if (!o.visible) continue;
        let hidden = false;
        for (let p = o.parent; p; p = p.parent) if (p.visible === false) hidden = true;
        if (hidden) continue;
        const pos = m.pos;
        const n = m.lab.length;
        if (m.frame !== frameN) {
          let x0 = Infinity; let y0 = Infinity; let z0 = Infinity; let x1 = -Infinity; let y1 = -Infinity; let z1 = -Infinity;
          for (let i = 0; i < n; i++) {
            o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
            pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
            if (v.x < x0) x0 = v.x; if (v.y < y0) y0 = v.y; if (v.z < z0) z0 = v.z; if (v.x > x1) x1 = v.x; if (v.y > y1) y1 = v.y; if (v.z > z1) z1 = v.z;
          }
          m.box = [x0, y0, z0, x1, y1, z1];
          m.frame = frameN;
        }
        // the ray against the mesh's box first (slabs)
        let tmin = 0; let tmax = Infinity;
        for (let a = 0; a < 3; a++) {
          const inv = 1 / (dir[a] || 1e-12);
          let ta = (m.box[a] - origin[a]) * inv; let tb = (m.box[a + 3] - origin[a]) * inv;
          if (ta > tb) { const sw = ta; ta = tb; tb = sw; }
          tmin = Math.max(tmin, ta); tmax = Math.min(tmax, tb);
        }
        if (tmin > tmax || (best && tmin > best.t)) continue;
        const idx = o.geometry.index ? o.geometry.index.array : null;
        const nt = idx ? idx.length / 3 : n / 3;
        const [ox, oy, oz] = origin; const [dx, dy, dz] = dir;
        for (let tr = 0; tr < nt; tr++) {
          const a = idx ? idx[tr * 3] : tr * 3; const b = idx ? idx[tr * 3 + 1] : tr * 3 + 1; const c = idx ? idx[tr * 3 + 2] : tr * 3 + 2;
          const ax = pos[a * 3]; const ay = pos[a * 3 + 1]; const az = pos[a * 3 + 2];
          const e1x = pos[b * 3] - ax; const e1y = pos[b * 3 + 1] - ay; const e1z = pos[b * 3 + 2] - az;
          const e2x = pos[c * 3] - ax; const e2y = pos[c * 3 + 1] - ay; const e2z = pos[c * 3 + 2] - az;
          const px = dy * e2z - dz * e2y; const py = dz * e2x - dx * e2z; const pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (Math.abs(det) < 1e-12) continue;
          const id = 1 / det;
          const sx = ox - ax; const sy = oy - ay; const sz = oz - az;
          const u = (sx * px + sy * py + sz * pz) * id;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y; const qy = sz * e1x - sx * e1z; const qz = sx * e1y - sy * e1x;
          const w = (dx * qx + dy * qy + dz * qz) * id;
          if (w < 0 || u + w > 1) continue;
          const t = (e2x * qx + e2y * qy + e2z * qz) * id;
          if (t <= 0 || (best && t >= best.t)) continue;
          const la = m.lab[a]; const lb = m.lab[b]; const lc = m.lab[c];
          let l = lb === lc ? lb : la;
          if (l === pickData.P.face && la !== pickData.P.face && lb !== pickData.P.face) l = pickData.P.head;
          best = { t, label: PICK[l] || 'none', faceSkin: m.faceSkin };
        }
      }
      if (!best) return null;
      best.point = [origin[0] + dir[0] * best.t, origin[1] + dir[1] * best.t, origin[2] + dir[2] * best.t];
      return best;
    }


    // T-5098: every body part as drawn, for the touch zones (core/vrm-hit.js opts.parts): the vertices skinned to
    // each humanoid bone of Hit.PART_BONES (fingers count as the hand, toes as the foot, a non-humanoid bone between
    // humanoid ones — an MMD twist or 下半身 — as the humanoid bone above it; hair, a skirt, wings, a cape — the
    // spring bones and what hangs from them — are no body part), in the rest pose, boxed in a frame along the bone
    // (limbs: from the joint to the next one; the trunk: her up), 3–97th percentile per axis → ellipsoids kept in
    // the raw bone's frame: { bone: { c, axes, r } } (partShapes carries them) | null
    function measurePartBoxes(T) {
      const h = vrm.humanoid;
      if (!h || !Hit || !Hit.PART_BONES) return null;
      vrm.scene.updateMatrixWorld(true);
      const group = new Map(); // raw node → part bone
      for (const n of Hit.PART_BONES) { const b = h.getRawBoneNode(n); if (b) group.set(b, n); }
      for (const s of ['left', 'right']) {
        for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) for (const k of ['Metacarpal', 'Proximal', 'Intermediate', 'Distal']) { const b = h.getRawBoneNode(`${s}${f}${k}`); if (b) group.set(b, `${s}Hand`); }
        const toes = h.getRawBoneNode(`${s}Toes`);
        if (toes) group.set(toes, `${s}Foot`);
      }
      const humanoid = new Set();
      for (const n of Object.keys(h.humanBones || {})) { const b = h.getRawBoneNode(n); if (b) humanoid.add(b); }
      const spring = new Set();
      if (vrm.springBoneManager && vrm.springBoneManager.joints) for (const j of vrm.springBoneManager.joints) if (j.bone) spring.add(j.bone);
      // a skeleton bone → its part (or null): up to the first humanoid bone, through no spring bone
      const partOf = (b) => { for (let p = b; p; p = p.parent) { if (spring.has(p)) return null; if (humanoid.has(p)) return group.get(p) || null; } return null; };
      const pts = new Map(); // part → [x, y, z, …] world
      const v = new T.Vector3();
      let total = 0;
      vrm.scene.traverse((o) => { if (o.isSkinnedMesh && o.visible && o.geometry && o.geometry.attributes.position) total += o.geometry.attributes.position.count; });
      const step = Math.max(1, Math.floor(total / 150000));
      vrm.scene.traverse((o) => {
        if (!o.isSkinnedMesh || !o.visible || !o.skeleton || !o.geometry) return;
        const g = o.geometry;
        const pos = g.attributes.position;
        const si = g.attributes.skinIndex;
        const sw = g.attributes.skinWeight;
        if (!pos || !si || !sw) return;
        const parts = o.skeleton.bones.map(partOf);
        if (!parts.some(Boolean)) return;
        for (let i = 0; i < pos.count; i += step) {
          let best = 0; let bw = -1;
          for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
          const part = parts[best];
          if (!part) continue;
          o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
          if (!pts.has(part)) pts.set(part, []);
          pts.get(part).push(v.x, v.y, v.z);
        }
      });
      const W = (n) => { const b = h.getRawBoneNode(n); return b ? b.getWorldPosition(new T.Vector3()) : null; };
      const la = W('leftUpperArm');
      const ra = W('rightUpperArm');
      const up = new T.Vector3(0, 1, 0);
      const front = la && ra ? new T.Vector3().crossVectors(la.clone().sub(ra), up).normalize() : new T.Vector3(0, 0, 1);
      const NEXT = { UpperArm: 'LowerArm', LowerArm: 'Hand', Hand: 'MiddleProximal', UpperLeg: 'LowerLeg', LowerLeg: 'Foot', Foot: 'Toes' };
      const pc = (a, q) => a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))];
      const out = {};
      for (const [part, arr] of pts) {
        const n = arr.length / 3;
        if (n < 12) continue;
        const node = h.getRawBoneNode(part);
        if (!node) continue;
        const o0 = node.getWorldPosition(new T.Vector3());
        const m = /^(left|right)(UpperArm|LowerArm|Hand|UpperLeg|LowerLeg|Foot)$/.exec(part);
        let u = up.clone();
        if (m) {
          const nx = W(`${m[1]}${NEXT[m[2]]}`);
          if (nx && nx.distanceTo(o0) > 1e-4) u = nx.clone().sub(o0).normalize();
          else if (m[2] === 'Hand') { const lo = W(`${m[1]}LowerArm`); if (lo) u = o0.clone().sub(lo).normalize(); } else if (m[2] === 'Foot') u = front.clone();
        }
        let f = front.clone().sub(u.clone().multiplyScalar(front.dot(u)));
        if (f.length() < 0.2) f = up.clone().sub(u.clone().multiplyScalar(up.dot(u)));
        f.normalize();
        const w = new T.Vector3().crossVectors(u, f).normalize();
        const axes = [u, f, w];
        const lo = []; const hi = [];
        for (const ax of axes) {
          const proj = new Float64Array(n);
          for (let i = 0; i < n; i++) proj[i] = (arr[i * 3] - o0.x) * ax.x + (arr[i * 3 + 1] - o0.y) * ax.y + (arr[i * 3 + 2] - o0.z) * ax.z;
          proj.sort();
          lo.push(pc(proj, 0.03)); hi.push(pc(proj, 0.97));
        }
        const cw = o0.clone();
        for (let k = 0; k < 3; k++) cw.add(axes[k].clone().multiplyScalar((lo[k] + hi[k]) / 2));
        const r = [0, 1, 2].map((k) => Math.max(0.01, ((hi[k] - lo[k]) / 2) * 1.1));
        const inv = node.matrixWorld.clone().invert();
        const qInv = node.getWorldQuaternion(new T.Quaternion()).invert();
        out[part] = { c: cw.clone().applyMatrix4(inv).toArray(), axes: axes.map((a) => a.clone().applyQuaternion(qInv).toArray()), r, verts: n, world: { c: cw.toArray().map((x) => +x.toFixed(3)), r: r.map((x) => +x.toFixed(3)) } };
      }
      return Object.keys(out).length ? out : null;
    }
    // the part ellipsoids now (world): partBoxes carried by their raw bones as drawn
    function partShapes() {
      if (!partBoxes || !vrm || !vrm.humanoid) return null;
      const T = R.THREE;
      const out = {};
      tmp.pq = tmp.pq || new T.Quaternion();
      tmp.pc = tmp.pc || new T.Vector3();
      tmp.pa = tmp.pa || new T.Vector3();
      for (const [part, b] of Object.entries(partBoxes)) {
        const node = vrm.humanoid.getRawBoneNode(part);
        if (!node) continue;
        node.getWorldQuaternion(tmp.pq);
        out[part] = { c: tmp.pc.fromArray(b.c).applyMatrix4(node.matrixWorld).toArray(), axes: b.axes.map((a) => tmp.pa.fromArray(a).applyQuaternion(tmp.pq).toArray()), r: b.r };
      }
      return out;
    }

    // T-5092: her head as drawn, for the touch zone (core/vrm-hit.js opts.head): the vertices that move with the head
    // bone or its children (skull, face, ears, hair, a hat) in the rest pose, from 1.3 × the neck→head length below
    // the head bone up (hair hanging down her back is not her head), 2–98th percentile per world axis (a stray strand
    // does not stretch it) → an ellipsoid kept in the head bone's frame: { c, axes, r } (head-bone local, for
    // headShape) | null (no head bone, no skinned head: the zone falls back to the sphere on the bone)
    function measureHeadBox(T) {
      const head = vrm.humanoid && vrm.humanoid.getRawBoneNode('head');
      if (!head) return null;
      const neck = vrm.humanoid.getRawBoneNode('neck');
      vrm.scene.updateMatrixWorld(true);
      const hp = head.getWorldPosition(new T.Vector3());
      const dn = neck ? Math.max(0.03, hp.distanceTo(neck.getWorldPosition(new T.Vector3()))) : 0.08;
      const floor = hp.y - 1.3 * dn;
      const under = (o) => { for (let p = o; p; p = p.parent) if (p === head) return true; return false; };
      const xs = []; const ys = []; const zs = [];
      const v = new T.Vector3();
      vrm.scene.traverse((o) => {
        if (!o.isSkinnedMesh || !o.visible || !o.skeleton || !o.geometry) return;
        const g = o.geometry;
        const pos = g.attributes.position;
        const si = g.attributes.skinIndex;
        const sw = g.attributes.skinWeight;
        if (!pos || !si || !sw) return;
        const inHead = o.skeleton.bones.map(under);
        if (!inHead.some(Boolean)) return;
        const step = Math.max(1, Math.floor(pos.count / 60000)); // a dense mesh: every n-th vertex is plenty
        for (let i = 0; i < pos.count; i += step) {
          let best = 0; let bw = -1;
          for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
          if (!inHead[best]) continue;
          o.getVertexPosition(i, v).applyMatrix4(o.matrixWorld);
          if (v.y < floor) continue;
          xs.push(v.x); ys.push(v.y); zs.push(v.z);
        }
      });
      if (xs.length < 20) return null;
      const pc = (a, q) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round(q * (b.length - 1))))]; };
      const lo = [pc(xs, 0.02), pc(ys, 0.02), pc(zs, 0.02)];
      const hi = [pc(xs, 0.98), pc(ys, 0.98), pc(zs, 0.98)];
      const cw = new T.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      // a box's corner sticks out of the ellipsoid through its faces' centres: × 1.1 gets most of the corners in
      const r = [0, 1, 2].map((i) => Math.max(0.02, ((hi[i] - lo[i]) / 2) * 1.1));
      const inv = head.matrixWorld.clone().invert();
      const qInv = head.getWorldQuaternion(new T.Quaternion()).invert();
      const c = cw.clone().applyMatrix4(inv).toArray();
      const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((a) => new T.Vector3(...a).applyQuaternion(qInv).toArray());
      return { c, axes, r, verts: xs.length, world: { c: cw.toArray().map((x) => +x.toFixed(3)), r: r.map((x) => +x.toFixed(3)), headBone: hp.toArray().map((x) => +x.toFixed(3)) } };
    }
    // the head ellipsoid now (world): headBox carried by the head bone as it is drawn
    function headShape() {
      if (!headBox || !vrm || !vrm.humanoid) return null;
      const head = vrm.humanoid.getRawBoneNode('head');
      if (!head) return null;
      const T = R.THREE;
      const q = head.getWorldQuaternion(new T.Quaternion());
      return { c: new T.Vector3(...headBox.c).applyMatrix4(head.matrixWorld).toArray(), axes: headBox.axes.map((a) => new T.Vector3(...a).applyQuaternion(q).toArray()), r: headBox.r };
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
      if (mode === 'dance') return { ...FR.cameraFor({ top: size.minY + size.h, bottom: size.minY }, { fov: camera.fov, share: share / danceCam, mode: 'full' }), x: 0 };
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
      let cam = cameraFor(danceView ? 'dance' : framing);
      if (glide) {
        const t = (performance.now() - glide.t0) / 1000 / (glide.dur || GLIDE_S);
        if (t >= 1) glide = null;
        else cam = FR.blendCamera(glide.from, cam, t);
      }
      camNow = cam;
      const dy = framing === 'half' && !danceView ? camDy : 0;
      const dx = framing === 'half' && !danceView ? camDx : 0;
      camera.position.set(cam.x + dx, cam.y + dy, size.cz + cam.dist);
      camera.near = Math.max(0.01, cam.dist / 20);
      camera.far = cam.dist * 4;
      camera.updateProjectionMatrix();
      camera.lookAt(cam.x + dx, cam.y + dy, size.cz);
      const d = canvas.dataset;
      const shown = danceView ? 'full' : framing; // a dance is framed whole (§3.6), 半身 comes back after it
      if (d.framing !== shown) d.framing = shown;
      const cut = shown === 'half' && band ? band.cut.toFixed(3) : '1';
      if (d.cut !== cut) d.cut = cut;
    }

    // the bones a seated pose may push below the frame, and how far (× hips height) her mesh hangs below each
    const SEAT_PADS = [['hips', 0.2], ['leftUpperLeg', 0.12], ['rightUpperLeg', 0.12], ['leftLowerLeg', 0.09], ['rightLowerLeg', 0.09], ['leftFoot', 0.08], ['rightFoot', 0.08], ['leftToes', 0.05], ['rightToes', 0.05]];
    // feet on the floor whatever the clip does with the hips (sitting on the floor: the seat on it), and a
    // sitting pose centred on its own width — a reclined sit reaches far to one side (§3.6)
    function groundOffset(sit, pose = null) {
      const T = R.THREE;
      tmp.g = tmp.g || new T.Vector3();
      const h = vrm.humanoid;
      const at = (n) => { if (n === 'hips') return hipsW(new T.Vector3()); const b = h.getNormalizedBoneNode(n); return b ? b.getWorldPosition(tmp.g).clone() : null; };
      vrm.scene.updateMatrixWorld(true);
      const sp = vrm.scene.position;
      const pts = ['leftFoot', 'rightFoot', 'leftToes', 'rightToes', 'leftLowerLeg', 'rightLowerLeg', 'hips', 'head', 'leftHand', 'rightHand'].map(at).filter(Boolean);
      const hips = at('hips');
      const low = Math.min(...pts.filter((p, i) => i < 6).map((p) => p.y), hips ? hips.y - rest.hipsY * 0.09 : Infinity) - sp.y;
      const xs = pts.map((p) => p.x - sp.x);
      const x = sit && xs.length ? -(Math.min(...xs) + Math.max(...xs)) / 2 : 0;
      let y = Number.isFinite(low) ? rest.feetY - low : 0;
      // T-5098: crouching or lying, her lowest body vertex (not a bone: a foot on its toes, a knee on the floor) is put
      // on the floor line where it stands standing; cloth and hair on spring bones are no part of it (bodyLow)
      if (!sit && (pose === 'crouch' || pose === 'lay') && rest.bodyFloor !== undefined) { const bl = bodyLow(); if (bl !== null) y = rest.bodyFloor - (bl - sp.y); }
      // sitting, the knees and feet come towards the camera and the seat, thighs and skirt hang below their
      // bones: on the floor line they fell out of the bottom of the canvas (liliya's sit.rest was cut at the
      // waist, T-2684). Lift the seated body until each part's mesh (bone − pad) is above the bottom edge of
      // the view at that part's own depth; a standing figure is framed as before.
      seatLift = 0;
      // Measured against the 全身 camera whatever the framing: in 半身 the bottom edge is her waist, and lifting
      // the seat over it pushed her head out of the top of the frame (T-2729); 半身 follows her head instead (camDy).
      if (sit && camera) {
        const tan = Math.tan((camera.fov * DEG) / 2);
        const margin = (size.h / share) * 0.012;
        const full = cameraFor('full');
        const camZ = size.cz + full.dist;
        let need = -Infinity;
        for (const [n, pad] of SEAT_PADS) {
          const p = at(n);
          if (!p) continue;
          const d = camZ - p.z;
          if (d <= 0) continue;
          const bottom = full.y - d * tan;
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
      const hips = hipsW(tmp.p).clone();
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

    // ---------- the jump meter (T-5084) ----------
    // How far each main bone turned since the drawn frame before (the pose she shows, everything included), as °
    // per frame at 30 fps (the turn × (1/30) / dt, dt the real time since the frame before, ≥ 1/120 s — not the clamped
    // animation step: a frame that comes late shows that much more motion, not a jump; and the frame rate drops to 12 fps when she is calm,
    // vrm-motion.js BUDGET, which must not read as a jump). That is a speed: a fast clip (a hand waving) is fast
    // without any jump. A jump — a snap — is a turn one frame makes that its neighbours do not: `spike` = the
    // frame's turn − the larger of the frames before and after it (per bone, ≥ 0); a smooth motion, however fast,
    // keeps it near 0, a cut puts its whole turn in it. Every change of what plays — the base (idle, posture,
    // dance), a reaction or hold coming in or going, a clip played by hand — opens a window of JUMP_WIN s keeping
    // the largest speed and the largest spike in it (and the bone, and the body-only values without hands / feet,
    // whose clips move fastest), next to the same numbers of the JUMP_WIN s before the change (`before`: the motion
    // the clips had anyway). The spike of a window counts the bones the change moves: every bone for a new base (or
    // a manual clip, a dance), the bones of the masks of the overlays that came or went otherwise (a nod ending moves
    // the head and neck, not the hands an idle clip swings meanwhile). debug().jump; figure.debugCut(id) makes a cut
    // on purpose (the meter's control).
    const JUMP_BONES = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];
    const EXTREMITY = /Hand$|Foot$/;
    const JUMP_WIN = 1.6;
    // T-5092: the bones' angular acceleration limited right before the frame is shown (core/vrm-smooth.js): however
    // many layers change on one frame (a touch: reaction + talk gesture + idle), no bone lurches further than the
    // frames around it by more than PetVrmSmooth.ACCEL (°/frame@30) — the jump meter's spike is bounded by it
    const smoother = window.PetVrmSmooth ? window.PetVrmSmooth.createLimiter() : null;
    // T-5098: the pose as the layers made it, before the limiter — the jump meter measures it too (`raw*`), so a
    // source snap the limiter hides is still counted (the release gate: the raw spike ≤ 10°/frame@30 as well)
    const rawPose = new Map();
    function smoothBones(dt) {
      if (!vrm || !vrm.humanoid) return;
      for (const b of JUMP_BONES) { const n = vrm.humanoid.getNormalizedBoneNode(b); if (n) rawPose.set(b, n.quaternion.toArray()); }
      if (!smoother) return;
      for (const b of JUMP_BONES) {
        const n = vrm.humanoid.getNormalizedBoneNode(b);
        if (!n) continue;
        const q = smoother.step(b, n.quaternion.toArray(), dt);
        n.quaternion.fromArray(q);
      }
    }
    const jm = { masks: new Map(), prev: new Map(), d1: new Map(), d2: new Map(), rprev: new Map(), rd1: new Map(), rd2: new Map(), rawSpikeMax: 0, rawSpikeBone: null, frames: 0, max: 0, maxBone: null, maxAt: 0, spikeMax: 0, spikeBone: null, sig: null, open: [], done: [], recent: [], recentSpike: [], hist: [], t: 0 };
    function jumpSig() {
      if (!plan) return '';
      const ov = (plan.overlays || []).filter((o) => o.weight > 0.02).map((o) => o.id).sort().join('+');
      return `${plan.base ? plan.base.key : 0}|${plan.reactionKey || 0}|${ov}|${plan.manual ? plan.manual.id : ''}|${plan.dance ? plan.dance.state : ''}`;
    }
    const top = (o, k, v, b) => { if (v > o[k]) { o[k] = +v.toFixed(2); o[`${k}Bone`] = b; } };
    function meterJump(dt) {
      if (!vrm || !vrm.humanoid) return;
      jm.t += dt;
      const k30 = (1 / 30) / Math.max(1 / 120, dt);
      // this frame's speeds, and the spikes of the frame before (now that its next frame is known)
      const f = { speed: 0, speedBone: null, body: 0, bodyBone: null, spike: 0, spikeBone: null, bodySpike: 0, bodySpikeBone: null, spikes: {}, rawSpike: 0, rawSpikeBone: null, rawSpikes: {} };
      let any = false;
      // the same spike on the pose before the limiter (rawPose, smoothBones)
      for (const b of JUMP_BONES) {
        const q = rawPose.get(b);
        if (!q) continue;
        const p = jm.rprev.get(b);
        jm.rprev.set(b, q);
        if (!p) continue;
        const d = window.PetVrmSmooth ? window.PetVrmSmooth.angle(p, q) * k30 : 0;
        const d1 = jm.rd1.get(b);
        const d2 = jm.rd2.get(b);
        if (d1 !== undefined && d2 !== undefined) { const sp = d1 - Math.max(d2, d); if (sp > 0) { f.rawSpikes[b] = sp; top(f, 'rawSpike', sp, b); } }
        if (d1 !== undefined) jm.rd2.set(b, d1);
        jm.rd1.set(b, d);
      }
      for (const b of JUMP_BONES) {
        const n = vrm.humanoid.getNormalizedBoneNode(b);
        if (!n) continue;
        const p = jm.prev.get(b);
        if (!p) { jm.prev.set(b, n.quaternion.clone()); continue; }
        any = true;
        const d = ((2 * Math.acos(Math.min(1, Math.abs(p.dot(n.quaternion))))) / DEG) * k30;
        p.copy(n.quaternion);
        top(f, 'speed', d, b);
        if (!EXTREMITY.test(b)) top(f, 'body', d, b);
        const d1 = jm.d1.get(b);
        const d2 = jm.d2.get(b);
        if (d1 !== undefined && d2 !== undefined) {
          const sp = d1 - Math.max(d2, d);
          if (sp > 0) { f.spikes[b] = sp; top(f, 'spike', sp, b); if (!EXTREMITY.test(b)) top(f, 'bodySpike', sp, b); }
        }
        if (d1 !== undefined) jm.d2.set(b, d1);
        jm.d1.set(b, d);
      }
      if (!any) return;
      jm.frames++;
      if (dt > 0.15) jm.late = (jm.late || 0) + 1; // a late frame (the renderer was busy): counted, its turn is over its real time
      if (f.speed > jm.max) { jm.max = f.speed; jm.maxBone = f.speedBone; jm.maxAt = +jm.t.toFixed(3); }
      if (f.spike > jm.spikeMax) { jm.spikeMax = f.spike; jm.spikeBone = f.spikeBone; }
      if (f.rawSpike > jm.rawSpikeMax) { jm.rawSpikeMax = f.rawSpike; jm.rawSpikeBone = f.rawSpikeBone; }
      jm.recent.push(f.speed);
      jm.recentSpike.push(f.spike);
      if (jm.recent.length > 900) { jm.recent.shift(); jm.recentSpike.shift(); }
      jm.hist.push({ t: jm.t, ...f });
      while (jm.hist.length && jm.hist[0].t < jm.t - JUMP_WIN) jm.hist.shift();
      const sig = jumpSig();
      for (const o of (plan && plan.overlays) || []) jm.masks.set(o.id, o.mask || 'upper');
      if (jm.sig !== null && sig !== jm.sig) {
        const [b0, r0, o0, m0, d0] = jm.sig.split('|');
        const [b1, r1, o1, m1, d1] = sig.split('|');
        const what = [b0 !== b1 ? `base→${plan.base ? plan.base.id : 'rest'}` : null, r0 !== r1 ? `reaction→${plan.reaction || 'none'}` : null, o0 !== o1 ? `overlays ${o0 || '-'}→${o1 || '-'}` : null, m0 !== m1 ? `manual ${m0 || '-'}→${m1 || '-'}` : null, d0 !== d1 ? `dance ${d0}→${d1}` : null].filter(Boolean).join('; ') || 'cut (no cross-fade: the control)';
        const before = { speed: 0, body: 0, spike: 0, bodySpike: 0 };
        for (const h of jm.hist.slice(0, -1)) for (const key of Object.keys(before)) before[key] = Math.max(before[key], h[key]);
        for (const key of Object.keys(before)) before[key] = +before[key].toFixed(2);
        // the bones this change moves: all for a base / manual / dance change, else those of the overlays' masks
        let bones = null;
        if (!jm.cut && b0 === b1 && m0 === m1 && d0 === d1) {
          const a = new Set(o0 ? o0.split('+') : []);
          const c = new Set(o1 ? o1.split('+') : []);
          const changed = [...a].filter((x) => !c.has(x)).concat([...c].filter((x) => !a.has(x)));
          const MW = window.PetVrmAnim && window.PetVrmAnim.maskWeight;
          bones = JUMP_BONES.filter((bn) => changed.some((idc) => !MW || MW(jm.masks.get(idc) || 'full', bn) > 0));
        }
        jm.open.push({ at: +jm.t.toFixed(3), what, action: plan.action ? plan.action.state : null, bones: bones ? (bones.length === JUMP_BONES.length ? 'all' : bones.join(',') || 'none') : 'all', set: bones ? new Set(bones) : null, until: jm.t + JUMP_WIN, frames: 0, speed: 0, speedBone: null, body: 0, bodyBone: null, spike: 0, spikeBone: null, bodySpike: 0, bodySpikeBone: null, anySpike: 0, anySpikeBone: null, rawSpike: 0, rawSpikeBone: null, rawAnySpike: 0, rawAnySpikeBone: null, before, first: null });
      }
      jm.sig = sig;
      jm.cut = false;
      for (const o of (plan && plan.overlays) || []) jm.masks.set(o.id, o.mask || 'upper');
      // the spike just computed belongs to the frame before: windows opened on this frame do not take it
      for (const w of jm.open) {
        w.frames++;
        for (const key of ['speed', 'body']) top(w, key, f[key], f[`${key}Bone`]);
        if (w.frames > 1) {
          // the spike on the bones this change moves (spike / bodySpike), and on any bone (anySpike: for the record)
          for (const [bn, sp] of Object.entries(f.spikes)) {
            top(w, 'anySpike', sp, bn);
            if (w.set && !w.set.has(bn)) continue;
            top(w, 'spike', sp, bn);
            if (!EXTREMITY.test(bn)) top(w, 'bodySpike', sp, bn);
          }
          for (const [bn, sp] of Object.entries(f.rawSpikes)) {
            top(w, 'rawAnySpike', sp, bn);
            if (w.set && !w.set.has(bn)) continue;
            top(w, 'rawSpike', sp, bn);
          }
        }
        if (w.frames === 2) w.first = { speed: +f.speed.toFixed(2), bone: f.speedBone };
      }
      while (jm.open.length && jm.open[0].until <= jm.t) { const w = jm.open.shift(); delete w.until; delete w.set; w.max = w.speed; w.bone = w.speedBone; jm.done.push(w); if (jm.done.length > 80) jm.done.shift(); }
    }
    function jumpReport() {
      const q = (arr, k) => { const s = arr.slice().sort((a, b) => a - b); return s.length ? +s[Math.min(s.length - 1, Math.floor(k * s.length))].toFixed(2) : 0; };
      return { unit: 'deg/frame@30fps', t: +jm.t.toFixed(3), frames: jm.frames, max: +jm.max.toFixed(2), maxBone: jm.maxBone, maxAt: jm.maxAt, p50: q(jm.recent, 0.5), p99: q(jm.recent, 0.99), spikeMax: +jm.spikeMax.toFixed(2), spikeBone: jm.spikeBone, rawSpikeMax: +jm.rawSpikeMax.toFixed(2), rawSpikeBone: jm.rawSpikeBone, spikeP99: q(jm.recentSpike, 0.99), lateFrames: jm.late || 0, transitions: jm.done.slice(), open: jm.open.map((w) => ({ ...w, until: undefined, set: undefined })) };
    }
    // the meter's control: the base cut to clip `id` with no cross-fade (what every change did before a fade existed)
    function debugCut(id) {
      if (!anim || !anim.has(id)) return false;
      jm.sig = `${jm.sig}|cut`;
      jm.cut = true;
      return anim.setBase(id, 0);
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
      const realDt = lastRender == null ? 1 / 30 : clamp((now - lastRender) / 1000, 1 / 120, 0.5); // the jump meter's clock
      lastRender = now;
      if (glide) { lastActivity = now; fit(); } else if (frameN % 30 === 0) fit();

      // L0/L1: the director's base clip, cross-faded
      const DP = plan.dance || { on: false, state: 'off' };
      const dIn = input.dance || null;
      if (plan.base && plan.base.key !== lastBaseKey) {
        // an idle clip starts somewhere in its loop at a slightly different pace each time: the same idle
        // never beats on the same clock twice (T-2691)
        const idleClip = plan.idleKind === 'clip' && plan.posture === null;
        // (no clip for it — no motion library, a slot it lacks — is the rest clip, cross-faded: T-2829)
        anim.playBase(plan.base, lastBaseKey < 0 ? 0 : plan.base.fade, plan.base.dance ? { clock: 'external', time: DP.t } : idleClip ? { align: lastBaseKey >= 0, phase: Math.random(), speed: 0.9 + Math.random() * 0.2 } : null);
        // (T-5084: started where its pose is nearest hers — the phase alignment of renderer/vrm-anim.js)
        lastBaseKey = plan.base.key;
      }
      // the dance: its time from the app's clock (the music), every frame (§4.1)
      // (the controller counts its loops: a new count is the dance coming round, blended; any other jump cuts)
      const wrapped = !!(dIn && dIn.loops !== lastLoops && lastLoops !== null);
      lastLoops = dIn ? dIn.loops : null;
      if (DP.on) anim.seekBase(DP.t, { blend: wrapped });
      const danceEntry = DP.id && dances.get(DP.id) ? dances.get(DP.id).entry : null;
      const wantView = DP.on && !!danceEntry;
      if (wantView !== danceView) {
        if (wantView) danceCam = danceCamFor(danceEntry);
        glide = camNow ? { from: { ...camNow }, t0: performance.now(), dur: 0.6 } : null;
        danceView = wantView;
        fit(true);
      }
      // a dance's clip is let go 30 s after it ended (§3.1)
      if (DP.state === 'off' && dances.size && !danceRelease) danceRelease = setTimeout(() => { danceRelease = null; if (!anim || (plan && plan.dance && plan.dance.state !== 'off')) return; for (const id of [...dances.keys()]) if (anim.remove(`dance:${id}`)) dances.delete(id); }, 30000);
      if (DP.state !== 'off' && danceRelease) { clearTimeout(danceRelease); danceRelease = null; }
      const clips = anim.update(dt, plan.overlays); // the base, then the holds (L2) and reactions (L3) over it
      if (!clips) restPose(); // no clip: arms down, absolute every frame (nothing accumulates)
      // eat / play / sleep (T-2831): procedural poses over the clips (core/vrm-acts.js), weighted by the director;
      // under the alive layer, which still breathes and blinks on top
      actOut = Acts && plan.acts && plan.acts.length ? Acts.apply(R.THREE, (n) => vrm.humanoid && vrm.humanoid.getNormalizedBoneNode(n), plan.acts, { set: style.set, amplitude: style.amplitude, sit: plan.actSit, v0: metaVersion() === '0' ? -1 : 1 }) : null;

      // L4: alive
      // 走神 / 瞥视 wait for a still cursor (vrm-life GLANCE_AFTER): while it moves near her she follows it
      const cursorStill = Math.max(0, (now - cursor.lastMove) / 1000);
      const lifeOut = life.step(dt, { ...plan.life, style, velX: vel[0], fingers: clips ? anim.fingers() : false, cursorStill });
      // turning: her head and chest turn ahead of her hips (the director's turnLead, deg)
      const lead = plan.turnLead || 0;
      if (Math.abs(lead) > 0.05) for (const [b, k] of TURN_LEAD) { const o = lifeOut.bones[b] || (lifeOut.bones[b] = { x: 0, y: 0, z: 0 }); o.y += lead * k; }
      // dancing: the dance has its own breath, weight shifts and fingers — the alive layer keeps only the eyes (§3.1)
      if (!plan.life.dance) applyLife(lifeOut.bones);
      // T-5084: what the alive layer laid over the clips this frame (debug().life): breathing, weight shift, gaze, blink
      const lb = lifeOut.bones || {};
      const deg = (o) => (o ? +Math.hypot(o.x || 0, o.y || 0, o.z || 0).toFixed(3) : 0);
      lifeInfo = { on: !plan.life.dance, overClip: !!clips, breath: +(Number(lifeOut.breath) || 0).toFixed(3), chest: deg(lb.chest), upperChest: deg(lb.upperChest), spine: deg(lb.spine), hips: deg(lb.hips), head: deg(lb.head), bones: Object.keys(lb).length, gaze: { x: +lifeOut.gaze.x.toFixed(3), y: +lifeOut.gaze.y.toFixed(3) }, away: !!lifeOut.away, blinks: (lifeInfo ? lifeInfo.blinks : 0) + (lifeOut.blink ? 1 : 0) };

      // the body: on the floor, turned (not mirrored) towards where she faces
      vrm.scene.position.set(base.x, 0, 0);
      vrm.scene.rotation.set(0, base.yaw + (yaw + debugCtl.yaw) * DEG, 0);
      // dancing: one floor for the whole dance (the bake's 5% lowest ankle), so a jump leaves the floor (§3.1)
      const g = DP.on && danceEntry ? { y: -(Number(danceEntry.ground) || 0) * rest.hipsY, x: 0 } : groundOffset(!!(plan.base && plan.base.sit), plan.base ? plan.base.pose : null);
      const gk = frameN === 0 ? 1 : approach(4, dt);
      ground = lerp(ground, g.y, gk);
      shiftX = lerp(shiftX, g.x, gk);
      yaw = plan.facingYaw; // eased by the director (a turn takes ≥ 0.3 s, T-2711)
      floorLift = lerp(floorLift, seatLift, gk);
      // lifted: held up off the floor (her shadow stays down there), she sinks back when put down
      liftK = lerp(liftK, plan.life.lifted ? 1 : 0, approach(plan.life.lifted ? 5 : 7, dt));
      // (a play hop lifts her off the floor too: × her hip height)
      const air = liftK * LIFT_UP * (size.h / share) + (actOut ? actOut.air * rest.hipsY : 0);
      vrm.scene.position.set(base.x + shiftX, base.y + ground + air, 0);
      vrm.scene.rotation.set(0, base.yaw + (yaw + debugCtl.yaw) * DEG, 0);
      placeProps(dt, !!(plan.base && plan.base.sit));
      // 半身: a seated pose brings her head down; the camera follows it (eased like the ground), standing it is 0
      const sitting = !!(plan.base && plan.base.sit) && !plan.life.lifted;
      let dyTarget = 0;
      let dxTarget = 0;
      if (framing === 'half' && !danceView && sitting && restHeadY !== null && band) {
        const hb = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('head');
        const pb = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('hips');
        if (hb && pb) {
          vrm.scene.updateMatrixWorld(true);
          tmp.h = tmp.h || new R.THREE.Vector3();
          const hp = hb.getWorldPosition(tmp.h);
          const hx = hp.x;
          dyTarget = Math.min(0, hp.y - restHeadY);
          const px = hipsW(tmp.h).x;
          dxTarget = (hx + px) / 2 - (band.cx - size.cx); // her upper body now − where the half camera looks standing
        }
      }
      const ck = frameN === 0 ? 1 : approach(4, dt);
      const nextDy = lerp(camDy, dyTarget, ck);
      const nextDx = lerp(camDx, dxTarget, ck);
      const moved = Math.abs(nextDy - camDy) > 1e-5 || Math.abs(nextDx - camDx) > 1e-5;
      camDy = nextDy;
      camDx = nextDx;
      if (moved && camNow && framing === 'half' && !danceView && !glide) {
        camera.position.set(camNow.x + camDx, camNow.y + camDy, camera.position.z);
        camera.lookAt(camNow.x + camDx, camNow.y + camDy, size.cz);
      }

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

      smoothBones(realDt);
      if (clips) pivotHips(); // (the base layer put the hips position back from its memo this frame: nothing adds up)
      meterJump(realDt);
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
      d.action = plan.action ? plan.action.state : '';
      d.manual = plan.manual ? plan.manual.id : ''; // T-5084: a clip played by hand
      d.pose = plan.pose || 'stand';
      // the procedural bodies on now (T-2831): name:weight
      d.acts = (plan.acts || []).map((a) => `${a.name}:${a.w.toFixed(2)}`).join(',');
      d.layers = anim.summary();
      d.overlays = anim.overlays();
      d.library = libState;
      d.anim = animState;
      // the dance (§7.1)
      const hipsW = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode('hips');
      let hips = [0, 0];
      if (hipsW) { tmp.dh = tmp.dh || new R.THREE.Vector3(); hipsW.getWorldPosition(tmp.dh); hips = [+(tmp.dh.x - vrm.scene.position.x).toFixed(3), +(tmp.dh.z - vrm.scene.position.z).toFixed(3)]; }
      const shownT = DP.on && anim.external() ? anim.baseTime() : DP.t;
      const clockT = DP.on && dIn && dIn.playing && !dIn.paused && typeof dIn.clockNow === 'function' ? dIn.clockNow() : null;
      danceInfo = { id: DP.on ? DP.id : '', state: DP.state, t: +(shownT || 0).toFixed(3), drift: clockT === null ? 0 : Math.round(((shownT || 0) - Math.min(clockT, (dances.get(DP.id) || { duration: Infinity }).duration - 1e-3)) * 1000), hips, audio: DP.on && dIn ? dIn.audioState || 'none' : 'none', cam: danceView ? +danceCam.toFixed(3) : 1, request: DP.request || null, duck: DP.duck, exclusive: !!DP.exclusive, faceTrack: !!(dances.get(DP.id) || {}).faceTrack };
      d.dance = danceInfo.id || '';
      d.danceState = DP.state;
      d.danceT = (danceInfo.t || 0).toFixed(1);
      d.danceAudio = danceInfo.audio;
      d.danceDrift = String(danceInfo.drift);
      d.danceHips = `${hips[0].toFixed(2)},${hips[1].toFixed(2)}`;
      d.danceCam = danceInfo.cam.toFixed(2);
      d.danceExclusive = danceInfo.exclusive ? '1' : '0';
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
    const TOUCH_SLOP_PX = [4, 8];
    function zoneAt(cx, cy, opts = {}) {
      if (!vrm || !camera || !vrm.humanoid || !Hit) return { zone: null, pt: null };
      const T = R.THREE;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return { zone: null, pt: null };
      vrm.scene.updateMatrixWorld(true);
      const bones = {};
      const v = new T.Vector3();
      for (const n of Hit.BONES) { const b = vrm.humanoid.getNormalizedBoneNode(n); if (b) bones[n] = b.getWorldPosition(v).toArray(); }
      const ry = vrm.scene.rotation.y;
      const list = Hit.shapes(bones, [Math.sin(ry), 0, Math.cos(ry)], { head: headShape(), parts: partShapes() });
      const nx = ((cx - rect.left) / rect.width) * 2 - 1;
      const ny = -((cy - rect.top) / rect.height) * 2 + 1;
      const p = new T.Vector3(nx, ny, 0.5).unproject(camera);
      const dir = p.sub(camera.position).normalize().toArray();
      let h = Hit.hit(list, camera.position.toArray(), dir);
      // T-5098: a click (opts.precise): the part drawn under it (meshPick), the boxes only under cloth
      let via = 'boxes';
      if (opts.precise) {
        let m = meshPick(camera.position.toArray(), dir);
        // T-5099: touch slop — a click that misses her drawn mesh and every box by a few px (her hand moved on with
        // the idle between seeing it and clicking: the smallest, fastest part) takes the nearest of the rays 4 / 8 px
        // around it, the closest hit on the nearest ring; a click farther off stays a miss
        if (!(m && m.label !== 'none') && !h.zone) {
          const o0 = camera.position.toArray();
          const rayAt = (x, y) => new T.Vector3(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1, 0.5).unproject(camera).sub(camera.position).normalize().toArray();
          for (const r of TOUCH_SLOP_PX) {
            let near = null;
            for (let k = 0; k < 8; k++) {
              const d2 = rayAt(cx + r * Math.cos((k * Math.PI) / 4), cy + r * Math.sin((k * Math.PI) / 4));
              const m2 = meshPick(o0, d2);
              if (m2 && m2.label !== 'none' && (!near || m2.t < near.m.t)) near = { m: m2, d: d2 };
            }
            if (near) { m = near.m; h = Hit.hit(list, o0, near.d); h.slopPx = r; break; }
          }
        }
        if (m && m.label !== 'none') {
          // her hip joints, her front (horizontal), the crotch line and the waist (the spine bone), in world terms
          const pel = list.find((sh) => sh.zone === 'pelvis') || {};
          const j = pel.joints || m.point;
          const f0 = pel.front || [0, 0, 1];
          const fl = Math.hypot(f0[0], f0[2]) || 1;
          const fr = [f0[0] / fl, 0, f0[2] / fl];
          const lat = [fr[2], 0, -fr[0]];
          const p = m.point;
          const below = p[1] < j[1] - (pel.drop || 0);
          const behind = (p[0] - j[0]) * fr[0] + (p[2] - j[2]) * fr[2] < 0;
          const waist = bones.spine ? bones.spine[1] : j[1] + (pel.drop || 0) * 2;
          const lu = bones.leftUpperLeg; const ru = bones.rightUpperLeg;
          const half = lu && ru ? Math.hypot(lu[0] - ru[0], lu[2] - ru[2]) / 2 : 0.08;
          const latMax = Math.max(1.7 * half, (pel.drop || 0.1) / 0.3 * 0.35);
          const inButt = behind && !below && p[1] <= waist && Math.abs((p[0] - j[0]) * lat[0] + (p[2] - j[2]) * lat[2]) < latMax;
          // hair hanging below her neck is cloth too (long hair over her back and butt)
          const neckY = bones.neck ? bones.neck[1] : null;
          const label = m.label === 'head' && neckY !== null && p[1] < neckY ? 'cloth' : m.label;
          const Z = { face: 'face', chest: 'chest', belly: 'belly', hands: 'hands', shin: 'legs', feet: 'feet', arm: h.zone === 'hands' ? 'hands' : null, neck: h.zone === 'face' || h.zone === 'head' ? h.zone : 'chest' };
          let zone = Z[label];
          if (label === 'head' && !m.faceSkin) inFace(p); // (only for the dbg: where in the face box)
          if (label === 'head') zone = m.faceSkin && inFace(p) ? 'face' : pickData.face ? 'head' : h.zone === 'face' ? 'face' : 'head';
          else if (label === 'pelvis') zone = below ? 'legs' : behind ? 'butt' : 'belly';
          else if (label === 'thigh') zone = inButt ? 'butt' : 'legs';
          // (an arm: a pat, except where its sleeve cuff overlaps the hand coming out of it — the boxes' hand rule)
          // on cloth or hair: over her butt it is her butt; elsewhere the boxes underneath decide
          else if (label === 'cloth') zone = inButt ? 'butt' : h.zone;
          h = { ...h, zone: zone === undefined ? h.zone : zone, point: m.point, shape: h.shape || { zone }, mesh: m.label, dbg: { faceQ: label === 'head' && tmp.faceQ ? tmp.faceQ.map((x) => +x.toFixed(3)) : undefined, faceBox: label === 'head' && pickData.face ? { lo: pickData.face.lo.map((x) => +x.toFixed(3)), hi: pickData.face.hi.map((x) => +x.toFixed(3)), n: pickData.face.n } : undefined, below, behind, inButt, j: j.map((x) => +x.toFixed(3)), p: p.map((x) => +x.toFixed(3)), waist: +waist.toFixed(3) } };
          via = `${label === 'cloth' && !inButt ? 'mesh: cloth → boxes' : 'mesh'}${h.slopPx ? ` (slop ${h.slopPx} px)` : ''}`;
        }
      }
      if (!h.zone) return { zone: null, pt: null, miss: !h.shape, via };
      // her box on screen: the shapes projected (centres ± radius)
      const toClient = (w) => { v.fromArray(w).project(camera); return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }; };
      const pxPerM = pxPerMetre(rect.height);
      let box = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (const sh of list) for (const c of sh.a ? [sh.a, sh.b] : [sh.c]) {
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
      return { zone: h.zone, via, mesh: h.mesh, dbg: h.dbg, pt: { x: clamp((cx - box.left) / bw, 0, 1), y: clamp((cy - box.top) / bh, 0, 1), opaque: true, pose: 'vrm', box, mirrored: false, faceRect, world: h.point, framing } };
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
      const shapesNow = Hit.shapes(bones, [Math.sin(ry), 0, Math.cos(ry)], { head: headShape(), parts: partShapes() });
      const toC = (c) => { v.fromArray(c).project(camera); return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height }; };
      for (const sh of shapesNow) {
        if (!sh.zone) continue;
        let c = sh.a ? sh.a.map((x, i) => (x + sh.b[i]) / 2) : sh.c;
        if (sh.zone === 'pelvis') {
          // T-5098: the pelvis is her belly from the front, her butt from behind: its back, half-way out
          const back = Hit.support(sh.axes || [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sh.radii || [sh.r, sh.r, sh.r], sh.front);
          if (!out.butt) out.butt = toC(c.map((x, i) => x - sh.front[i] * back * 0.5));
          continue;
        }
        if (sh.zone === 'thigh') { if (!out.legs) out.legs = toC(c); continue; }
        if (out[sh.zone]) continue;
        if (sh.zone === 'head') c = [c[0], c[1] + sh.r * 0.8, c[2]]; // the top (the front of the sphere is the face)
        out[sh.zone] = toC(c);
      }
      if (out.head) {
        const hd = shapesNow.find((sh) => sh.zone === 'head');
        out.face = toC([hd.c[0] + hd.front[0] * hd.r * 0.5, hd.c[1] - hd.r * 0.35, hd.c[2] + hd.front[2] * hd.r * 0.5]);
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

    // 重置姿势 (T-2830): the director's reset (the same action state machine as stop(), T-2829) plus what only
    // this figure keeps: debug events not read yet. The bone overlays, expressions and the base are all redrawn
    // from the plan every frame, so they fade back with it — nothing is snapped here.
    function resetToIdle(why = 'reset') {
      if (!director) return { reset: false, reason: 'not-ready' };
      injected.length = 0;
      const r = director.reset(why);
      canvas.dataset.reset = String((Number(canvas.dataset.reset) || 0) + (r.reset ? 1 : 0));
      return r;
    }

    // The clips she can play by hand (loaded for her, after the style fallback): [{ id, slot, kind, category, group,
    // label, duration, loop, mask }], grouped by category in the index's order.
    function motionList() {
      const out = [];
      for (const c of Object.values((index && index.clips) || {})) {
        if (!(c.file ? loaded.has(c.id) : c.cycle)) continue;
        out.push({ id: c.id, slot: c.slot, style: c.style, kind: c.kind, category: c.category || (c.kind === 'posture' ? 'posture' : c.kind === 'idle' ? 'idle' : c.kind === 'hold' ? 'talk' : 'reaction'), group: c.group || null, label: c.label, duration: c.duration || null, loop: !!c.loop, mask: c.mask || 'full' });
      }
      const order = Lib.CATEGORIES || [];
      return out.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || String(a.group).localeCompare(String(b.group)) || a.slot.localeCompare(b.slot));
    }

    function fig() {
      return {
        canvas,
        packId: look.packId,
        pause: () => { lastRender = null; },
        director: () => director,
        plan: () => plan,
        setPosture: (p) => { if (director) director.setPosture(p); },
        stopAction: (why) => (director ? director.stop(why) : null),
        resetToIdle: (why) => resetToIdle(why),
        // T-5084: the motion library in this figure, and playing one of its clips by hand (console 试播, POST /motion)
        libraryInfo: () => (libInfo ? { ...libInfo } : null),
        motions: () => motionList(),
        playMotion: (req) => (director ? director.play(req || {}) : { ok: false, reason: 'not-ready' }),
        stopMotion: (why) => (director ? director.stopManual(why || 'stop') : { stopped: false }),
        jump: () => jumpReport(),
        debugCut: (id) => debugCut(id),
        loadDance,
        danceInfo: () => ({ ...danceInfo }),
        zoneAt,
        zoneCenters,
        // T-5098: what the e2e's mesh check needs (e2e/vrm-hit-truth.js): the model, the camera, the canvas
        debugHandles: () => (vrm ? { vrm, camera, canvas, THREE: R.THREE, partBoxes, headBox } : null),
        inject: (e) => { injected.push(e); },
        pose: () => (vrm ? poseSample() : null),
        framePoints,
        debug: () => ({
          loaded: !!vrm, anim: animState, library: libState, clips: [...loaded], boneFold, sets: index ? (Lib.loadSets ? Lib.loadSets(index, style.set) : null) : null, mode: canvas.dataset.mode, frame: frameN, fps: meter.fps(performance.now()), state: canvas.dataset.state, lip: lipMode,
          style: { name: style.name, source: style.source, set: style.set, amplitude: style.amplitude, hipSway: style.hipSway },
          plan: plan && { base: plan.base, posture: plan.posture, postureSource: plan.postureSource, setting: plan.setting, idle: plan.idle, idleKind: plan.idleKind, hold: plan.hold, reaction: plan.reaction, reactionKey: plan.reactionKey, reactionWeight: plan.reactionWeight, overlays: plan.overlays, gaze: plan.gaze, face: plan.face, facingYaw: plan.facingYaw, turnLead: plan.turnLead, walk: plan.walk, talkSegment: plan.talkSegment, talkSegments: plan.talkSegments, action: plan.action, acts: plan.acts, actSit: plan.actSit },
          acts: actOut ? { air: +actOut.air.toFixed(4), bones: actOut.bones } : null,
          vel: [+vel[0].toFixed(1), +vel[1].toFixed(1)], walkSpeed: intent && intent.holds.walkSpeed !== undefined ? +intent.holds.walkSpeed.toFixed(4) : null,
          idleHistory: director ? director.history() : [],
          libraryInfo: libInfo, clipRepairs: { ...clipRepairs }, headBox: headBox ? { verts: headBox.verts, ...headBox.world } : null, partBoxes: partBoxes ? Object.fromEntries(Object.entries(partBoxes).map(([k, b]) => [k, { verts: b.verts, ...b.world }])) : null, hipsRig: hipsRig ? { height: +hipsRig.height.toFixed(3), restY: +hipsRig.restY.toFixed(3), rescaled: hipsRig.rescaled || 0, leg: hipsRig.leg } : null, smooth: smoother ? smoother.stats() : null, life: lifeInfo, jump: jumpReport(), align: anim ? anim.lastAlign() : null,
          manual: plan ? plan.manual : null, manuals: director ? director.manuals() : [], variants: director ? director.variants() : [], poses: director ? director.poses() : [], poseGroup: plan ? plan.pose : null, rest: plan ? plan.rest : null, thinkSegment: plan ? plan.thinkSegment : null,
          reactions: director ? director.reactions() : [],
          overlays: anim ? anim.overlays() : '',
          layers: anim ? anim.summary() : '', weightSum: anim ? anim.weightSum() : 0, ground, seatLift: +seatLift.toFixed(4), camDy: +camDy.toFixed(4), camDx: +camDx.toFixed(4),
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
          dance: { ...danceInfo, clips: [...dances.keys()], weightSum: anim ? +anim.weightSum().toFixed(4) : 0, layers: anim ? anim.summary() : '' },
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
      const hipsP = hipsW(new T.Vector3());
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
      // the upper arms: how far above level each points (deg, + up; −90 hanging), shoulder → elbow in the world
      const arms = {};
      for (const s of ['left', 'right']) {
        const sh = w(`${s}UpperArm`), el = w(`${s}LowerArm`);
        if (!sh || !el) continue;
        const v = el.clone().sub(sh);
        arms[s] = { elev: +(Math.atan2(v.y, Math.hypot(v.x, v.z)) / DEG).toFixed(1) };
        // the hand: how far from the head (× her hip height: the food at her mouth is close) and above the shoulder
        const hd = w(`${s}Hand`), hp = w('head');
        if (hd && hp) Object.assign(arms[s], { toHead: +(hd.distanceTo(hp) / Math.max(0.1, rest.hipsY)).toFixed(3), aboveShoulder: +((hd.y - sh.y) / Math.max(0.1, rest.hipsY)).toFixed(3) });
      }
      // head yaw against the body's facing (the scene's turn)
      const hq = hm.getNormalizedBoneNode('head').getWorldQuaternion(new T.Quaternion());
      const f = new T.Vector3(0, 0, 1).applyQuaternion(hq);
      const headYaw = Math.atan2(f.x, f.z) / DEG - vrm.scene.rotation.y / DEG;
      const hipq = hm.getNormalizedBoneNode('hips').getWorldQuaternion(new T.Quaternion());
      const fh = new T.Vector3(0, 0, 1).applyQuaternion(hipq);
      const hipsYaw = Math.atan2(fh.x, fh.z) / DEG - vrm.scene.rotation.y / DEG;
      const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
      // how far her face is turned down (deg, + = down: asleep the head drops, T-2831); 0.x bones face −Z
      const hd = f.clone();
      if (vrm.meta && vrm.meta.metaVersion === '0') hd.negate();
      const headDown = Math.asin(Math.max(-1, Math.min(1, -hd.y))) / DEG;
      const headY = hm.getNormalizedBoneNode('head').getWorldPosition(new T.Vector3()).y;
      return { q, legs, arms, headYaw: +wrap(headYaw).toFixed(2), hipsYaw: +wrap(hipsYaw).toFixed(2), headDown: +headDown.toFixed(2), headY: +headY.toFixed(4), rootY: +vrm.scene.position.y.toFixed(4) };
    }

    // where her head, hands and feet are in the canvas now (NDC: −1..1 is inside), for the dance framing check
    function framePoints() {
      if (!vrm || !camera) return null;
      const T = R.THREE;
      vrm.scene.updateMatrixWorld(true);
      const out = {};
      for (const n of ['head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot']) {
        const b = vrm.humanoid && vrm.humanoid.getNormalizedBoneNode(n);
        if (!b) continue;
        const p = b.getWorldPosition(new T.Vector3());
        if (n === 'head') p.y += (size.h / 8) * 0.6; // the top of the head, not its bone
        p.project(camera);
        out[n] = [+p.x.toFixed(3), +p.y.toFixed(3)];
      }
      return out;
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
      loadDance,
      plan: () => plan,
      // the user's stop (T-2829): whatever she does fades back to the idle (core/vrm-director.js stop)
      stopAction: (why = 'stop') => (director ? director.stop(why) : null),
      // 重置姿势 (T-2830): back to the idle from anything, faded (core/vrm-director.js reset)
      resetToIdle: (why = 'reset') => resetToIdle(why),
      danceInfo: () => ({ ...danceInfo }),
      // T-5084: the motion library as this figure loaded it (why it fell back, if it did), the clips it can play by
      // hand, playing / stopping one (the director's manual layer), the jump meter
      libraryInfo: () => (libInfo ? { ...libInfo } : null),
      motions: () => motionList(),
      playMotion: (req) => (director ? director.play(req || {}) : { ok: false, reason: 'not-ready' }),
      stopMotion: (why = 'stop') => (director ? director.stopManual(why) : { stopped: false }),
      jump: () => jumpReport(),
      debugCut: (id) => debugCut(id),
      isReady: () => !!(vrm && director && !disposed),
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
    // 重置姿势 (T-2830): every figure back to the idle; what each was doing
    reset: (why = 'reset') => [...figures].map((f) => f.resetToIdle(why)),
    // the user's stop on every figure (T-2829 / T-2831): whatever she does fades back to the idle
    stop: (why = 'stop') => [...figures].map((f) => f.stopAction(why)),
    zoneCenters: () => { const f = [...figures][0]; return f ? f.zoneCenters() : {}; },
    zoneAt: (x, y, o) => { const f = [...figures][0]; return f && f.zoneAt ? f.zoneAt(x, y, o) : null; }, // T-5092: the zone at a client point (e2e); o.precise: as a click (T-5098)
    // T-5098: turn her by deg on top of where she faces (180: her back to the camera), for the e2e; 0 = off
    yaw: (deg) => { debugCtl.yaw = Number(deg) || 0; return debugCtl.yaw; },
    handles: () => { const f = [...figures][0]; return f && f.debugHandles ? f.debugHandles() : null; },
    reactions: () => { const f = [...figures][0]; const d = f && f.director(); return d ? d.reactions() : []; },
    // the action-state transitions (T-2829 plan.action: { t, from, to, why }), newest last — acceptance evidence (T-2832)
    actions: () => { const f = [...figures][0]; const d = f && f.director(); return d && d.actions ? d.actions() : []; },
    // the pose numbers alone (legs, ankles, head / hips yaw), light enough to sample every few ms (T-2711)
    pose: () => { const f = [...figures][0]; return f ? f.pose() : null; },
    framePoints: () => { const f = [...figures][0]; return f ? f.framePoints() : null; },
    // T-5084: the jump meter, the motion library as she loaded it, playing a clip by hand
    jump: () => { const f = [...figures][0]; return f ? f.jump() : null; },
    // the jump meter's control (e2e): a cut to clip `id` with no cross-fade
    cut: (id) => { const f = [...figures][0]; return f && f.debugCut ? f.debugCut(id) : false; },
    library: () => { const f = [...figures][0]; return f ? f.libraryInfo() : null; },
    motions: () => { const f = [...figures][0]; return f ? f.motions() : []; },
    play: (req) => { const f = [...figures][0]; return f ? f.playMotion(req) : { ok: false, reason: 'no-vrm' }; },
    stopMotion: (why) => [...figures].map((f) => f.stopMotion(why)),
    // the dance's clock (renderer/vrm-dance.js): jump to t s, speed up a dance without music (§7.1)
    dance: {
      seek: (t) => (window.PetDance && window.PetDance.current ? window.PetDance.current.seek(t) : false),
      speed: (k) => (window.PetDance && window.PetDance.current ? window.PetDance.current.speed(k) : 1),
    },
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
    hidden: isHidden,
    onVisibility: (fn) => { visibility.add(fn); return () => visibility.delete(fn); },
    debug: () => ({ figures: [...figures].map((f) => f.debug()), stats: { ...stats }, lipAttached: lip.attached, audioContext: lip.ctx ? lip.ctx.state : null, runtime: window.PetVrmRuntime ? window.PetVrmRuntime.versions : null }),
  };
})();
