'use strict';
// Live2D 角色包 (kind "live2d" in docs/pet-packs.md): a Cubism 4 model (.model3.json + .moc3 + textures +
// physics) drawn with pixi-live2d-display, acted out by the app.
//
// The model's own physics swings the hair, clothes, arms, ears and tail from the head and body angles;
// this file only decides, every frame, where she looks, how her face is set and how her body moves for
// the state the app is in (src/core/fx.js STATES and touch-<zone> reactions), how fast the window moves
// (being dragged, thrown, walking), and whether she is talking. Model-specific parameter names come
// from the pack (`live2d` in pack.json, see docs/pet-packs.md); the standard Cubism ones
// (ParamAngleX, ParamEyeLOpen, ParamMouthOpenY, …) are used as they are.
//
// The runtime (Cubism Core, PixiJS 6, pixi-live2d-display) is in vendor/live2d and loaded the first
// time a Live2D look is shown.
//
// 取景 (core/framing.js, docs/half-body-mode.md): 全身 draws her head to feet at `live2d.height` of the canvas;
// 半身 scales her up and moves her so the top of her head to her waist fills the canvas, the cut on its bottom
// edge. Where her waist is: pack.json halfBody.waist, else her Head hit area, else her eye line (the drawables
// ParamEyeLOpen moves), else a default share — measured once when the model loads. figure.setFraming() glides
// between the two in GLIDE_S without reloading her.
//
// Debug fields on the canvas (read by e2e): data-frame, data-framing (full | half), data-cut (half: the share of
// her height shown, for touch zones), data-band (pack | hitarea | eyes | default), data-gaze (x,y: where she
// looks, −1..1 each way). figure.debug() has the band, the placement and the gaze.
(function () {
  const FR = window.PetFraming;
  const GLIDE_S = 0.35; // switching 全身 ⇄ 半身: the model glides this long (same as the VRM camera)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const approach = (rate, dt) => 1 - Math.exp(-rate * dt);

  // ---------- the runtime, loaded once on demand ----------
  const VENDOR = ['live2dcubismcore.min.js', 'pixi.min.js', 'unsafe-eval.min.js', 'cubism4.min.js'];
  let runtime = null;
  function loadRuntime() {
    if (!runtime) {
      runtime = VENDOR.reduce((p, f) => p.then(() => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `vendor/live2d/${f}`;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`cannot load ${f}`));
        document.head.appendChild(s);
      })), Promise.resolve());
      runtime.catch(() => { runtime = null; });
    }
    return runtime;
  }

  // ---------- a damped spring (the window's motion → her lean) ----------
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

  // ---------- the cursor (gaze) ----------
  // Inside the window: pointer events; outside it (she sits in a small window): the screen cursor from main,
  // polled a few times a second while a figure is drawn. A pointer event is fresher than the poll for 1.5 s.
  const cursor = {
    pointer: null, movedAt: -Infinity, screen: null,
    get client() { return performance.now() - this.movedAt < 1500 || !this.screen ? this.pointer : this.screen; },
  };
  window.addEventListener('pointermove', (e) => { cursor.pointer = { x: e.clientX, y: e.clientY }; cursor.movedAt = performance.now(); }, { passive: true });
  let polledAt = 0;
  function pollCursor(now) {
    if (now - polledAt < 250 || !window.pet || !window.pet.cursorPoint || document.hidden) return;
    polledAt = now;
    window.pet.cursorPoint().then((pt) => { if (pt && Number.isFinite(pt.x)) cursor.screen = { x: pt.x - window.screenX, y: pt.y - window.screenY }; }, () => {});
  }
  // states that look somewhere of their own (up when thinking, about when looking, shut when asleep)
  const OWN_GAZE = new Set(['think', 'look', 'sleep']);

  // ---------- how each state looks ----------
  // Face: eyes (0 shut .. 1 open), smile (−1 sad .. 1 happy eyes), anger (+ angry, − startled), brow
  // (−1 low .. 1 raised), browTilt (+ worried, − cross), mouth form (−1 frown .. 1 smile), mouth open,
  // and the pack's named faces (`faces`: blush, squint >_<, wide O_O, dizzy, gloom, o, drool, …) 0..1.
  // Body: head angles (deg), arms (+ out from the sides), wave (one arm up), hop height (canvas share),
  // sway, ears (+ up), wag (tail), lean.
  const LOOKS = {
    idle: { eyes: 1, mouth: 0.2, arms: 0, wag: 0.3 },
    look: { eyes: 1, mouth: 0.1, turn: 1, wag: 0.3 },
    happy: { eyes: 1, smile: 1, mouth: 1, open: 0.5, brow: 0.6, arms: 0.6, hop: 1, wag: 1, ears: 1, faces: { blush: 0.5 } },
    pat: { eyes: 0.15, smile: 1, mouth: 1, open: 0.15, brow: 0.3, tilt: 9, nodDown: 6, wag: 0.8, ears: -0.5, faces: { blush: 1 } },
    sad: { eyes: 0.55, smile: -1, mouth: -1, brow: -0.6, browTilt: 1, nodDown: 8, arms: -0.4, wag: 0, ears: -1, faces: { gloom: 0.35 } },
    hungry: { eyes: 0.6, mouth: -0.4, open: 0.25, browTilt: 0.7, wobble: 1, wag: 0.1, ears: -0.6, faces: { drool: 0.6 } },
    sleep: { eyes: 0, mouth: 0.3, nodDown: 14, tilt: 8, slow: 1, wag: 0, ears: -1, arms: -0.3 },
    eat_rice: { eyes: 0.1, smile: 1, mouth: 1, chew: 1, nod: 1, wag: 0.8, ears: 0.5, faces: { blush: 0.4 } },
    eat_cookie: { eyes: 0.1, smile: 1, mouth: 1, chew: 1, nod: 1, wag: 0.8, ears: 0.5, faces: { blush: 0.4 } },
    eat_fruit: { eyes: 0.1, smile: 1, mouth: 1, chew: 1, nod: 1, wag: 0.8, ears: 0.5, faces: { blush: 0.4 } },
    think: { eyes: 1, mouth: -0.2, gazeUp: 1, tilt: -10, browTilt: 0.4, wag: 0.15 },
    talk: { eyes: 1, mouth: 0.5, nod: 0.5, arms: 0.2, wag: 0.4, ears: 0.3 },
    play: { eyes: 1, smile: 1, mouth: 1, open: 0.6, hop: 0.7, sway: 1, arms: 0.8, wag: 1, ears: 1, faces: { blush: 0.4 } },
    hatch: { eyes: 1, mouth: 1, open: 0.3, brow: 0.8, wave: 1, wag: 0.8, ears: 1, pop: 1 },
    evolve: { eyes: 1, smile: 1, mouth: 1, open: 0.8, brow: 1, hop: 1.6, arms: 1, wag: 1, ears: 1, faces: { blush: 0.6 } },
    lifted: { eyes: 1, anger: -1, brow: 1, mouth: -0.2, open: 0.6, arms: 1, wag: 0.6, ears: 1, dangle: 1, faces: { wide: 0.8 } },
    walk: { eyes: 1, mouth: 0.6, stride: 1, wag: 0.5, ears: 0.3 },
  };
  // a touch on a body part (src/core/touch-zones.js), then the mood it put her in
  const TOUCH_LOOKS = {
    head: { eyes: 0.1, smile: 1, mouth: 1, open: 0.1, tilt: 8, nodDown: 7, wag: 0.9, ears: -0.6, faces: { blush: 0.8 } },
    face: { eyes: 1, wink: 1, smile: 0.5, mouth: 1, tilt: -6, wag: 0.6, faces: { blush: 1 } },
    chest: { eyes: 1, anger: -1, brow: 1, mouth: -0.3, open: 0.5, lean: -8, arms: -0.6, ears: 1, wag: 0, faces: { wide: 1, blush: 1 } },
    hands: { eyes: 1, smile: 1, mouth: 1, open: 0.3, wave: 1, wag: 0.8, ears: 0.6, faces: { blush: 0.3 } },
    belly: { eyes: 1, smile: 1, mouth: 1, open: 0.6, wobble: 1, wag: 1, faces: { squint: 1, blush: 0.4 } },
    butt: { eyes: 1, anger: -1, brow: 1, mouth: -0.4, open: 0.6, hop: 1.2, arms: 1, wag: 0, ears: 1, faces: { wide: 1, blush: 0.8 } },
    legs: { eyes: 0.7, mouth: -0.2, browTilt: 0.8, wag: 0.3, faces: { blush: 0.6 } },
    feet: { eyes: 1, smile: 1, mouth: 1, open: 0.7, wobble: 1, hop: 0.4, wag: 1, faces: { squint: 1 } },
    tail: { eyes: 1, anger: -1, brow: 1, mouth: -0.2, open: 0.4, wag: 2.2, ears: 1, faces: { wide: 0.7, blush: 0.3 } },
  };
  const MOOD_LOOKS = {
    angry: { eyes: 1, anger: 1, brow: -0.6, browTilt: -1, mouth: -1, open: 0.2, shake: 1, arms: 0.4, ears: 1, wag: 0, faces: { gloom: 0.3 } },
    annoyed: { eyes: 0.6, anger: 0.5, browTilt: -0.6, mouth: -0.8, wag: 0, ears: -0.3 },
  };
  function lookFor(state, mood) {
    if (state.startsWith('touch-')) return (mood && MOOD_LOOKS[mood]) || TOUCH_LOOKS[state.slice(6)] || LOOKS.pat;
    return LOOKS[state] || LOOKS.idle;
  }
  // Standard parameter ids as models converted from Cubism 2 still name them
  const CUBISM2_IDS = {
    ParamAngleX: 'PARAM_ANGLE_X', ParamAngleY: 'PARAM_ANGLE_Y', ParamAngleZ: 'PARAM_ANGLE_Z',
    ParamBodyAngleX: 'PARAM_BODY_ANGLE_X', ParamBodyAngleY: 'PARAM_BODY_ANGLE_Y', ParamBodyAngleZ: 'PARAM_BODY_ANGLE_Z',
    ParamEyeBallX: 'PARAM_EYE_BALL_X', ParamEyeBallY: 'PARAM_EYE_BALL_Y', ParamEyeLOpen: 'PARAM_EYE_L_OPEN', ParamEyeROpen: 'PARAM_EYE_R_OPEN',
    ParamEyeLSmile: 'PARAM_EYE_L_SMILE', ParamEyeRSmile: 'PARAM_EYE_R_SMILE', ParamBrowLY: 'PARAM_BROW_L_Y', ParamBrowRY: 'PARAM_BROW_R_Y',
    ParamBrowLAngle: 'PARAM_BROW_L_ANGLE', ParamBrowRAngle: 'PARAM_BROW_R_ANGLE', ParamMouthForm: 'PARAM_MOUTH_FORM', ParamMouthOpenY: 'PARAM_MOUTH_OPEN_Y',
    ParamCheek: 'PARAM_CHEEK',
  };
  const SCALARS = ['eyes', 'smile', 'anger', 'brow', 'browTilt', 'mouth', 'open', 'tilt', 'nodDown', 'turn', 'gazeUp', 'arms', 'wave', 'hop', 'sway', 'wobble', 'ears', 'wag', 'lean', 'slow', 'nod', 'chew', 'stride', 'dangle', 'shake', 'wink', 'pop'];
  const REST = { eyes: 1 };

  // ---------- the figure ----------
  // `look` from core/packs.js resolveLook: { model (pack:// URL of the .model3.json), live2d (the pack's
  // parameter map), url (the outfit's picture), halfBody (pack.json, optional) }.
  // `framing`: 'full' | 'half' to start in (core/framing.js resolveFraming); figure.setFraming() changes it live.
  function createFigure(canvas, look, { framing: startFraming = 'full' } = {}) {
    const cfg = look.live2d || {};
    const P = cfg.params || {};
    const faces = { ...(cfg.faces || {}) };
    let app = null;
    let model = null;
    let disposed = false;
    const cur = Object.fromEntries(SCALARS.map((k) => [k, REST[k] || 0]));
    const faceNow = Object.fromEntries(Object.keys(faces).map((k) => [k, 0]));
    const sp = { lean: spring(60, 9, 18), bob: spring(120, 14, 0.2) };
    let lastT = null;
    let stateNow = null;
    let stateAt = 0;
    let popAt = -Infinity;
    let lastWin = null;
    let vel = [0, 0];
    let talkPhase = 0;
    let mouthOpen = 0;
    const blink = { k: 0, next: 1.5, start: -1 };
    // what the frame decided, written into the model around its physics (see `bind`)
    const before = new Map();
    const after = new Map();
    // the id each standard parameter has in this model (its own, the Cubism 2 name, or none: not written)
    const ids = new Map();
    let has = () => true;
    // 取景: her measured extent (model px at rest, y down) and the half-body band; the mode drawn; the glide
    let shape = null; // { content, head, eyes, face (where she looks from), band }
    let framing = startFraming === 'half' ? 'half' : 'full';
    let glide = null; // { from (placement), t0 } while switching
    let gaze = { x: 0, y: 0 };

    const ready = loadRuntime().then(async () => {
      if (disposed) return false;
      const PIXI = window.PIXI;
      app = new PIXI.Application({ view: canvas, width: canvas.width, height: canvas.height, backgroundAlpha: 0, antialias: true, preserveDrawingBuffer: true, autoStart: false, sharedTicker: false });
      app.ticker.stop();
      // the page handles every click on her (core/touch-zones.js); Pixi's own pointer handling is not wanted
      if (app.renderer.plugins.interaction) app.renderer.plugins.interaction.destroy();
      model = await PIXI.live2d.Live2DModel.from(look.model, { autoInteract: false, autoUpdate: false });
      if (disposed) { model.destroy(); return false; }
      const im = model.internalModel;
      im.eyeBlink = undefined; // she blinks on her own clock below (closed-eye faces must stay closed)
      // a model with its own idle motions starts one once its file has loaded; if the figure was disposed by
      // then (her look changed, the import preview) pixi-live2d-display would touch the released motion queue
      const mm = im.motionManager;
      const startMotion = mm && mm._startMotion;
      if (startMotion) mm._startMotion = function (...a) { return this.destroyed ? -1 : startMotion.apply(this, a); };
      const own = new Set(((im.coreModel.getModel && im.coreModel.getModel().parameters) || {}).ids || []);
      if (own.size) has = (id) => own.has(id);
      // a model without a blush expression blushes with its ParamCheek
      if (!faces.blush && (has('ParamCheek') || has('PARAM_CHEEK'))) { faces.blush = { [has('ParamCheek') ? 'ParamCheek' : 'PARAM_CHEEK']: 1 }; faceNow.blush = 0; }
      app.stage.addChild(model);
      try { shape = measure(im); } catch (e) { shape = null; console.warn('live2d: cannot measure the model for 半身', e); }
      bind(im);
      fit(true);
      return true;
    });

    // Our values go in twice a frame: the posture and face before the physics (which swings hair, clothes,
    // arms and ears from them), the arm poses, tail wag and pinned parameters after it.
    function bind(im) {
      const core = im.coreModel;
      im.on('afterMotionUpdate', () => { for (const [id, v] of before) core.setParameterValueById(id, v); });
      im.on('beforeModelUpdate', () => {
        for (const [id, v] of after) {
          if (v.add) core.addParameterValueById(id, v.value);
          else core.setParameterValueById(id, v.value);
        }
      });
    }
    function resolve(id) {
      if (!ids.has(id)) ids.set(id, has(id) ? id : CUBISM2_IDS[id] && has(CUBISM2_IDS[id]) ? CUBISM2_IDS[id] : null);
      return ids.get(id);
    }
    const set = (id, v) => { const r = id && resolve(id); if (r) before.set(r, v); };
    const add = (id, v) => { if (id) after.set(id, { add: true, value: v }); };
    const pin = (id, v) => { if (id) after.set(id, { add: false, value: v }); };

    // Her extent at rest (model px of the .moc canvas, y down): the opaque drawables; the Head hit area if the
    // model has one; the drawables her eye-open parameter moves (shut vs open). -> { content, head, eyes, band, face }
    function measure(im) {
      const core = im.coreModel;
      for (const [id, v] of Object.entries(cfg.pinned || {})) if (has(id)) core.setParameterValueById(id, v);
      core.update();
      const n = core.getDrawableCount();
      const boxOf = (v, b = { top: Infinity, bottom: -Infinity, minX: Infinity, maxX: -Infinity }) => {
        for (let i = 0; i < v.length; i += 2) { b.minX = Math.min(b.minX, v[i]); b.maxX = Math.max(b.maxX, v[i]); b.top = Math.min(b.top, v[i + 1]); b.bottom = Math.max(b.bottom, v[i + 1]); }
        return b;
      };
      const shown = (i) => core.getDrawableOpacity(i) > 0.1 && (!core.getDrawableDynamicFlagIsVisible || core.getDrawableDynamicFlagIsVisible(i));
      const content = { top: Infinity, bottom: -Infinity, minX: Infinity, maxX: -Infinity };
      const rest = [];
      for (let i = 0; i < n; i++) { const v = im.getDrawableVertices(i); rest.push(v); if (shown(i)) boxOf(v, content); }
      if (!Number.isFinite(content.top)) content.top = 0, content.bottom = im.originalHeight, content.minX = 0, content.maxX = im.originalWidth;
      // the Head hit area (named Head / HitAreaHead / 头 …)
      let head = null;
      for (const [name, a] of Object.entries(im.hitAreas || {})) {
        if (!/head|頭|头|atama/i.test(`${name} ${a.id || ''}`) || !(a.index >= 0)) continue;
        const b = im.getDrawableBounds(a.index, {});
        head = { top: b.y, bottom: b.y + b.height, minX: b.x, maxX: b.x + b.width };
        break;
      }
      // the eyes: what moves between eyes open and shut
      let eyes = null;
      const eyeId = resolve('ParamEyeLOpen');
      if (eyeId) {
        const was = core.getParameterValueById(eyeId);
        core.setParameterValueById(eyeId, 0);
        core.update();
        const tol = Math.max(im.originalHeight, 1) * 0.002;
        for (let i = 0; i < n; i++) {
          if (!shown(i)) continue;
          const v = im.getDrawableVertices(i);
          const r = rest[i];
          let moved = false;
          for (let j = 0; j < v.length && !moved; j++) moved = Math.abs(v[j] - r[j]) > tol;
          if (moved) eyes = boxOf(r, eyes || undefined);
        }
        core.setParameterValueById(eyeId, was);
        core.update();
      }
      const band = FR.live2dHalfBand({ content, waist: look.halfBody && look.halfBody.waist, head, eyes });
      // where she looks from: her eye line, else the middle of her head (hit area), else a guess below the top
      const face = eyes ? { x: (eyes.minX + eyes.maxX) / 2, y: (eyes.top + eyes.bottom) / 2 } : head ? { x: (head.minX + head.maxX) / 2, y: (head.top + head.bottom) / 2 } : { x: band.cx, y: content.top + (band.bottom - content.top) * 0.3 };
      canvas.dataset.band = band.source;
      return { content, head, eyes, band, face, original: { w: im.originalWidth, h: im.originalHeight } };
    }

    // a framing → where the model goes (core/framing.js live2dPlacement), with her measured band in model px
    // at scale 1 (the .moc canvas mapped onto the model's own size)
    function placementFor(mode, size) {
      const W = canvas.width;
      const H = canvas.height;
      const share = cfg.height || 0.8;
      if (mode !== 'half' || !shape) return FR.live2dPlacement(null, { W, H, model: size, share, mode: 'full' });
      const kx = size.w / shape.original.w;
      const ky = size.h / shape.original.h;
      const b = shape.band;
      return FR.live2dPlacement({ top: b.top * ky, bottom: b.bottom * ky, cx: b.cx * kx }, { W, H, model: size, share, mode: 'half' });
    }
    function setFraming(mode, { instant = false } = {}) {
      const next = mode === 'half' ? 'half' : 'full';
      if (next === framing) return false;
      framing = next;
      if (!model) return true; // still loading: the first fit() uses it
      glide = instant ? null : { from: { ...base }, t0: performance.now() };
      fit(true);
      return true;
    }

    // her size in the canvas: 全身 as tall as the pixel art draws her, feet on the floor, centred; 半身 the top of
    // her head to her waist filling it (placementFor). While switching, a glide from where she was.
    let res = 0;
    let base = { x: 0, y: 0, s: 1 };
    let size = { w: 1, h: 1 };
    function fit(force = false) {
      if (!model) return;
      const r = canvas.getBoundingClientRect();
      const [W, H] = look.frame ? [look.frame.width, look.frame.height] : [332, 452];
      const k = clamp(((r.height || H) / H) * (window.devicePixelRatio || 1) * 1.25, 1, 4);
      if (Math.abs(k - res) / (res || 1) >= 0.1) {
        res = k;
        canvas.width = Math.round(W * k);
        canvas.height = Math.round(H * k);
        app.renderer.resize(canvas.width, canvas.height);
      }
      if (force || !(size.h > 1)) {
        model.scale.set(1);
        size = { w: model.width, h: model.height };
      }
      let p = placementFor(framing, size);
      if (glide) {
        const t = (performance.now() - glide.t0) / 1000 / GLIDE_S;
        if (t >= 1) glide = null;
        else p = FR.blendPlacement(glide.from, p, t);
      }
      base = p;
      model.scale.set(p.s);
      model.x = p.x;
      model.y = p.y;
      const d = canvas.dataset;
      if (d.framing !== framing) d.framing = framing;
      const cut = framing === 'half' && shape ? shape.band.cut.toFixed(3) : '1';
      if (d.cut !== cut) d.cut = cut;
    }

    // where she looks: toward the cursor from her own eyes (in 半身 they are lower and bigger in the window), as
    // −1..1 of half the canvas each way; mirrored with her when she faces left
    function aim(state, dt, mirror) {
      let g = { x: 0, y: 0 };
      const c = cursor.client;
      if (c && shape && !OWN_GAZE.has(state)) {
        const r = canvas.getBoundingClientRect();
        if (r.width && r.height) {
          const kx = size.w / shape.original.w;
          const ky = size.h / shape.original.h;
          const fx = (base.x + shape.face.x * kx * base.s) / canvas.width;
          const fy = (base.y + shape.face.y * ky * base.s) / canvas.height;
          const ex = mirror < 0 ? r.left + (1 - fx) * r.width : r.left + fx * r.width;
          const ey = r.top + fy * r.height;
          g = { x: clamp(((c.x - ex) / (r.width / 2)) * mirror, -1.5, 1.5), y: clamp((ey - c.y) / (r.height / 2), -1.5, 1.5) };
        }
      }
      const k = approach(6, dt);
      gaze = { x: lerp(gaze.x, g.x, k), y: lerp(gaze.y, g.y, k) };
      return gaze;
    }

    let frameN = 0;
    function draw({ t, state, mood = null, talking = false, win = null, blink: hold = null }) {
      if (!model || disposed) return false;
      if (frameN++ % 30 === 0 || glide) fit();
      pollCursor(performance.now());
      const dt = lastT == null ? 1 / 60 : clamp(t - lastT, 0, 0.05);
      lastT = t;
      if (state !== stateNow) { stateNow = state; stateAt = t; }
      const st = t - stateAt;
      const L = lookFor(state, mood);
      if (L.pop && st < dt * 1.5) popAt = t;

      // the window's motion (screen px/s), in the direction she faces
      if (win) {
        if (lastWin) {
          const k = approach(14, dt);
          vel = [lerp(vel[0], (win[0] - lastWin[0]) / Math.max(dt, 1e-3), k), lerp(vel[1], (win[1] - lastWin[1]) / Math.max(dt, 1e-3), k)];
        }
        lastWin = win;
      }
      const mirror = canvas.closest && canvas.closest('[data-facing="left"]') ? -1 : 1;
      const look2 = aim(state, dt, mirror);
      const gx = clamp(look2.x, -1, 1);
      const gy = clamp(look2.y, -1, 1);
      const swing = clamp((vel[0] * mirror) / 600, -1.6, 1.6);
      const rise = clamp(vel[1] / 900, -1.5, 1.5);

      const kk = approach(7, dt);
      for (const key of SCALARS) cur[key] = lerp(cur[key], L[key] == null ? (REST[key] || 0) : L[key], kk);
      for (const f of Object.keys(faceNow)) faceNow[f] = lerp(faceNow[f], (L.faces && L.faces[f]) || 0, approach(9, dt));

      // blinking every 2–6 s (sometimes twice); held lids for stills and tests
      if (t >= blink.next && blink.start < 0) blink.start = t;
      if (blink.start >= 0) {
        const p = (t - blink.start) / 0.18;
        blink.k = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
        if (p >= 1) { blink.start = -1; blink.k = 0; blink.next = t + (Math.random() < 0.2 ? 0.25 : 2 + Math.random() * 4); }
      }
      const blinkK = hold == null ? blink.k : hold;

      // talking: syllables
      if (talking) talkPhase += dt * (7 + 3 * Math.sin(t * 1.3));
      const talkOpen = talking ? Math.max(0, Math.sin(talkPhase * Math.PI)) * (0.5 + 0.5 * Math.abs(Math.sin(t * 2.1))) : 0;
      const chew = cur.chew * Math.max(0, Math.sin(t * 9)) * 0.7;
      mouthOpen = lerp(mouthOpen, Math.max(cur.open * (0.85 + 0.15 * Math.sin(t * 5)), talkOpen, chew), approach(22, dt));

      // body: hops, sway, a wobble, a shiver of anger, steps; the springy lean into the window's motion
      const hopPh = (t * 1.6) % 1;
      const hop = cur.hop * Math.max(0, Math.sin(hopPh * Math.PI));
      const stepPh = t * Math.PI * 2 * 2;
      const bob = cur.stride * Math.abs(Math.sin(stepPh));
      const lean = sp.lean.step(cur.lean - swing * 12 + (state === 'lifted' ? Math.sin(t * 2.2) * 4 : 0), dt);
      const wobble = cur.wobble * Math.sin(t * 7) * 6;
      const sway = cur.sway * Math.sin(t * 3.2) * 8;
      const shake = cur.shake * Math.sin(t * 38) * 2;
      const pt = t - popAt;
      const pop = pt < 1.2 ? 1 - Math.exp(-pt * 6) * Math.cos(pt * 12) * 0.4 : 1;
      const breathe = Math.sin(t * (cur.slow > 0.5 ? 1.3 : 2.2));
      model.scale.set(base.s * pop * (1 + 0.004 * breathe), base.s * pop * (1 - 0.004 * breathe));
      const lift = (hop * 0.06 + bob * 0.012) * canvas.height;
      model.x = base.x + (model.width * (1 - pop)) / 2 + shake * res;
      model.y = base.y + (model.height * (1 - pop)) - lift + cur.nodDown * 0.15 * res;
      model.angle = clamp(-swing * 4 + wobble * 0.3 + sway * 0.3, -14, 14) * (state === 'lifted' ? 1.6 : 1);

      // head: idle drift, looking about, state tilt and nods; the body follows through the model's physics
      const turn = cur.turn * Math.sin(st * 1.3) * 25;
      const nod = cur.nod * Math.sin(t * (talking ? 5 : 8)) * 5;
      const angleX = Math.sin(t * 0.6) * 4 * (1 - Math.abs(gx) * 0.5) + turn + (talking ? Math.sin(t * 1.7) * 3 : 0) + gx * 18;
      const angleY = -cur.nodDown * 1.2 + cur.gazeUp * 14 + nod - Math.max(0, breathe) * cur.slow * 3 + gy * 12;
      const angleZ = cur.tilt + Math.sin(t * 0.8) * 2 + wobble + sway + lean * 0.6 + (state === 'lifted' ? swing * 8 : 0);
      set('ParamAngleX', clamp(angleX, -30, 30));
      set('ParamAngleY', clamp(angleY, -30, 30));
      set('ParamAngleZ', clamp(angleZ, -30, 30));
      set('ParamBodyAngleX', clamp(angleX * 0.3 + turn * 0.2, -30, 30));
      set('ParamBodyAngleZ', clamp(lean + sway * 0.6 + wobble * 0.5, -30, 30));
      set('ParamEyeBallX', clamp(turn / 25 + Math.sin(t * 0.45) * 0.15 * (1 - Math.abs(gx)) + gx * 0.8, -1, 1));
      set('ParamEyeBallY', clamp(cur.gazeUp * 0.9 - cur.nodDown * 0.02 + gy * 0.7, -1, 1));

      // face
      const open = clamp(cur.eyes * (1 - blinkK), 0, 1);
      set('ParamEyeLOpen', open);
      set('ParamEyeROpen', clamp(open * (1 - cur.wink), 0, 1));
      // one ParamEyeSmile (−1 sad .. 1 happy), else the standard pair (0 .. 1)
      if (has('ParamEyeSmile')) set('ParamEyeSmile', clamp(cur.smile, -1, 1));
      else {
        set('ParamEyeLSmile', clamp(cur.smile, 0, 1));
        set('ParamEyeRSmile', clamp(cur.smile, 0, 1));
      }
      set('ParamEyeAnger', clamp(cur.anger, -1, 1));
      set('ParamBrowLY', clamp(cur.brow, -1, 1));
      set('ParamBrowRY', clamp(cur.brow, -1, 1));
      set('ParamBrowLAngle', clamp(cur.browTilt, -1, 1));
      set('ParamBrowRAngle', clamp(cur.browTilt, -1, 1));
      set('ParamMouthForm', clamp(cur.mouth, -1, 1));
      set('ParamMouthOpenY', clamp(mouthOpen, 0, 1));
      // two faces may share one parameter (squint −1 / wide +1): the stronger one wins
      for (const [name, params] of Object.entries(faces)) {
        for (const [id, v] of Object.entries(params)) {
          const others = Object.entries(faces).filter(([n, p]) => n !== name && id in p).map(([n, p]) => p[id] * faceNow[n]);
          set(id, [v * faceNow[name], ...others].reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0));
        }
      }

      // after the physics: arm poses (+ out), a wave, the arms swinging against the steps; tail wag; ears
      const armSwing = cur.stride * Math.sin(stepPh) * 10;
      const flail = cur.dangle * Math.sin(t * 11) * 8;
      const armOut = cur.arms * (P.armOut || -22);
      add(P.armL, armOut + armSwing + flail);
      // a wave: her arm swings out and back at her side (a model whose arm cannot rise above the shoulder)
      const waveK = cur.wave * (0.55 + 0.45 * Math.sin(t * 7));
      add(P.armR, armOut - armSwing - flail + waveK * (P.armWave || -30));
      add(P.elbowR, waveK * (P.elbowWave || 25));
      const wagF = 3 + 4 * Math.min(cur.wag, 1.4);
      add(P.tail, cur.wag * 14 * Math.sin(t * wagF) + swing * 10);
      add(P.earL, cur.ears * 12 + Math.sin(t * 1.4) * 2 + rise * 10);
      add(P.earR, cur.ears * 12 + Math.sin(t * 1.4 + 0.5) * 2 + rise * 10);
      for (const [id, v] of Object.entries(cfg.pinned || {})) pin(id, v);

      model.update(dt * 1000);
      app.render();
      canvas.dataset.frame = `${state}#${Math.floor(t * 4)}`; // touch hit tests re-read her pixels at most 4× a second
      const gs = `${gaze.x.toFixed(2)},${gaze.y.toFixed(2)}`;
      if (canvas.dataset.gaze !== gs) canvas.dataset.gaze = gs;
      return true;
    }

    return {
      ready,
      draw,
      setFraming,
      framing: () => framing,
      debug: () => ({
        packId: look.packId, loaded: !!model, framing, gliding: !!glide, gaze: { ...gaze },
        band: shape ? { ...shape.band } : null, content: shape ? { ...shape.content } : null, head: shape && shape.head, eyes: shape && shape.eyes, face: shape && shape.face,
        placement: { ...base }, size: { ...size }, original: shape && shape.original, canvas: { w: canvas.width, h: canvas.height },
        params: Object.fromEntries(['ParamEyeLOpen', 'ParamMouthOpenY', 'ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY'].map((id) => [id, before.get(resolve(id))])),
        faces: { ...faceNow },
      }),
      dispose() {
        disposed = true;
        try { if (app) app.destroy(false, { children: true, texture: true, baseTexture: true }); } catch { /* already gone */ }
        app = null;
        model = null;
      },
    };
  }

  window.PetLive2D = { createFigure, loadRuntime, LOOKS, TOUCH_LOOKS };
})();
