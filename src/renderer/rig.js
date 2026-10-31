'use strict';
// 全动态形象 (rig packs, kind "rig" in docs/pet-packs.md): a character cut into layers that are drawn
// as textured grid meshes and bent every frame, the way a Live2D model is, instead of playing frames.
//
// The model (the pack's model.json) is in the drawing's own pixels: `size` [w, h], `parts` (each a
// layer image laid over `box` [x, y, w, h], hung from one deformer, drawn in `z` order), `pivots`
// (where the head turns, the fins hinge, …), `legs` (the skirt's hem, the soles, the gap between the
// legs) and `face` (where the eyes and mouth are, for blinking, talking and expressions).
//
// Every character gets the same skeleton of deformers; a part names the one it hangs from:
//   body   turns and squashes about the soles (breathing, hops, leaning into a throw)
//   skirt  bends the lower body: the hem trails the motion, the legs step under it
//   hair   the long hair: its top follows the head, its ends swing on springs
//   tail   swings about its root and bends toward its tip
//   head   tilts about the neck; headWarp turns the face a little (the features slide, the outline stays)
//   finL, finR, ahoge   hinge on the head and flap on their own springs
// Missing parts are fine (a character with no tail has no tail part). The face's eyes and mouth are
// painted live into one more part (`face`) over the head: lids for blinks and closed eyes, mouths for
// talking and moods, blush.
//
// `draw(frame)` takes what the app knows each frame: the state (src/core/fx.js STATES, or a touch-<zone>
// reaction), whether she is talking, and how fast the window moves (being dragged, thrown, walking),
// which is what makes the hair, skirt, tail and fins swing.
(function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, k) => a + (b - a) * k;
  const approach = (rate, dt) => 1 - Math.exp(-rate * dt); // share of the way to a target covered in dt
  const smooth = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
  const bump = (u) => Math.sin(Math.PI * clamp(u, 0, 1)); // 0 at the edges, 1 in the middle
  const rad = (d) => (d * Math.PI) / 180;

  // ---------- the mesh renderer ----------

  const VS = `
attribute vec2 aPos; attribute vec2 aUv;
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0);
  vUv = aUv;
}`;
  const FS = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
uniform vec4 uTint;
void main() {
  vec4 c = texture2D(uTex, vUv);
  c.rgb = mix(c.rgb, c.rgb * uTint.rgb, uTint.a);
  gl_FragColor = c * uAlpha;
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  // Draws `parts` (from the model, plus the face) through `deformers` into `canvas` (WebGL 1 is enough).
  // pose[deformer] is { a (degrees), sx, sy, tx, ty } for a turn, { fn(x, y, u, v) -> [dx, dy] } for a
  // warp; pose.alpha[part] fades a part.
  function createMesh(canvas, { size, parts, deformers }) {
    // keep the drawing buffer: the page reads her pixels back for touch hit tests and screenshots
    const attrs = { alpha: true, premultipliedAlpha: true, antialias: true, preserveDrawingBuffer: true };
    const gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
    if (!gl) throw new Error('WebGL is not available');
    const chain = (id) => { const out = []; for (let d = id; d; d = deformers[d] && deformers[d].parent) out.push(d); return out; };
    const sources = new Map(); // part id -> image or canvas, to upload again after a lost context
    let prog = null;
    let loc = null;
    let meshes = [];
    let textures = new Map();
    let lost = false;
    let disposed = false;

    function upload(id, src) {
      if (disposed) return;
      sources.set(id, src);
      if (lost) return;
      let t = textures.get(id);
      if (!t) { t = gl.createTexture(); textures.set(id, t); }
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    function build() {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      loc = {};
      for (const n of ['aPos', 'aUv']) loc[n] = gl.getAttribLocation(prog, n);
      for (const n of ['uSize', 'uTex', 'uAlpha', 'uTint']) loc[n] = gl.getUniformLocation(prog, n);
      textures = new Map();
      meshes = parts.map((p) => {
        const [nx, ny] = p.grid || [4, 4];
        const [x, y, w, h] = p.box;
        const n = (nx + 1) * (ny + 1);
        const rest = new Float32Array(n * 2);
        const uv = new Float32Array(n * 2);
        let k = 0;
        for (let j = 0; j <= ny; j++) {
          for (let i = 0; i <= nx; i++) {
            rest[k] = x + (w * i) / nx;
            rest[k + 1] = y + (h * j) / ny;
            uv[k] = i / nx;
            uv[k + 1] = j / ny;
            k += 2;
          }
        }
        const idx = [];
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const a = j * (nx + 1) + i;
            idx.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1);
          }
        }
        const pos = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, pos);
        gl.bufferData(gl.ARRAY_BUFFER, rest.byteLength, gl.DYNAMIC_DRAW);
        const uvb = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, uvb);
        gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
        return { part: p, rest, out: new Float32Array(rest.length), pos, uvb, ib, count: idx.length, chain: chain(p.deformer) };
      });
      for (const [id, src] of sources) upload(id, src);
    }

    // a lost context (GPU reset, sleep) blanks the canvas until it is restored and rebuilt
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { if (disposed) return; lost = false; build(); });
    build();

    // A rest point through its deformers, innermost first.
    function place(ids, pose, x, y) {
      for (const id of ids) {
        const d = deformers[id];
        const s = pose[id];
        if (!d || !s) continue;
        if (d.kind === 'rot') {
          const [px, py] = d.pivot;
          const c = Math.cos(rad(s.a || 0));
          const sn = Math.sin(rad(s.a || 0));
          const lx = (x - px) * (s.sx == null ? 1 : s.sx);
          const ly = (y - py) * (s.sy == null ? 1 : s.sy);
          x = px + (s.tx || 0) + lx * c - ly * sn;
          y = py + (s.ty || 0) + lx * sn + ly * c;
        } else if (s.fn) {
          const [x0, y0, x1, y1] = d.rect;
          const r = s.fn(x, y, clamp((x - x0) / (x1 - x0), 0, 1), clamp((y - y0) / (y1 - y0), 0, 1));
          x += r[0];
          y += r[1];
        }
      }
      return [x, y];
    }

    function render(pose) {
      if (lost || disposed || gl.isContextLost()) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform2f(loc.uSize, size[0], size[1]);
      gl.uniform1i(loc.uTex, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.enableVertexAttribArray(loc.aPos);
      gl.enableVertexAttribArray(loc.aUv);
      const order = meshes.slice().sort((a, b) => a.part.z - b.part.z);
      for (const m of order) {
        const alpha = pose.alpha && pose.alpha[m.part.id] != null ? pose.alpha[m.part.id] : 1;
        const tex = textures.get(m.part.id);
        if (!tex || alpha <= 0.001) continue;
        for (let i = 0; i < m.rest.length; i += 2) {
          const q = place(m.chain, pose, m.rest[i], m.rest[i + 1]);
          m.out[i] = q[0];
          m.out[i + 1] = q[1];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, m.pos);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, m.out);
        gl.vertexAttribPointer(loc.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, m.uvb);
        gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1f(loc.uAlpha, alpha);
        const tint = (pose.tint && pose.tint[m.part.id]) || pose.tintAll || null;
        gl.uniform4f(loc.uTint, ...(tint || [1, 1, 1, 0]));
        gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_SHORT, 0);
      }
    }

    // Frees the GPU side now: Chromium caps live WebGL contexts per page, and a figure that is
    // switched away from would otherwise hold one until garbage collection.
    function dispose() {
      if (disposed) return;
      disposed = true;
      try {
        for (const t of textures.values()) gl.deleteTexture(t);
        for (const m of meshes) { gl.deleteBuffer(m.pos); gl.deleteBuffer(m.uvb); gl.deleteBuffer(m.ib); }
        if (prog) gl.deleteProgram(prog);
      } finally {
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
    }

    return { upload, render, dispose, point: (deformer, pose, x, y) => place(chain(deformer), pose, x, y) };
  }

  // ---------- springs ----------

  // A damped spring toward a moving target; `lim` keeps a hard throw from folding hair over itself.
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
      reset() { this.x = 0; this.v = 0; },
    };
  }

  // ---------- how each state looks ----------
  // eyes: open | happy (^ ^) | closed (asleep) | half | wink | wide | angry
  // mouth: none (as drawn) | smile | grin | open | o | frown | chew | cat | wavy
  // fins: up (+) or drooping (−); wag: how much the tail wags; hop: bounce height; sway: side to side
  const LOOKS = {
    idle: { eyes: 'open', mouth: 'none', fins: 0, wag: 0.3 },
    look: { eyes: 'open', mouth: 'none', fins: 0.2, wag: 0.3, turn: 1 },
    happy: { eyes: 'happy', mouth: 'grin', fins: 0.8, wag: 1, hop: 7, blush: 0.4 },
    pat: { eyes: 'happy', mouth: 'cat', fins: 0.4, wag: 0.8, blush: 0.8, tilt: 7, duck: 3, flap: 0.6 },
    sad: { eyes: 'half', mouth: 'frown', fins: -1, wag: 0, tilt: -3, duck: 3, tear: 1, tailLow: 1, tint: [0.85, 0.88, 1, 0.35] },
    hungry: { eyes: 'half', mouth: 'o', fins: -0.5, wag: 0.1, wobble: 3 },
    sleep: { eyes: 'closed', mouth: 'none', fins: -0.8, wag: 0, tilt: 9, duck: 3, slow: 1, tailLow: 0.6 },
    eat_rice: { eyes: 'happy', mouth: 'chew', fins: 0.5, wag: 0.8, blush: 0.3, nod: 1 },
    eat_cookie: { eyes: 'happy', mouth: 'chew', fins: 0.5, wag: 0.8, blush: 0.3, nod: 1 },
    eat_fruit: { eyes: 'happy', mouth: 'chew', fins: 0.5, wag: 0.8, blush: 0.3, nod: 1 },
    think: { eyes: 'open', mouth: 'wavy', fins: 0.1, wag: 0.15, tilt: -8, gazeUp: 1 },
    talk: { eyes: 'open', mouth: 'none', fins: 0.3, wag: 0.4, nod: 0.4 },
    play: { eyes: 'happy', mouth: 'grin', fins: 0.9, wag: 1, hop: 5, sway: 7, blush: 0.3 },
    hatch: { eyes: 'open', mouth: 'smile', fins: 0.6, wag: 0.8, pop: 1 },
    evolve: { eyes: 'happy', mouth: 'grin', fins: 1, wag: 1, hop: 14, blush: 0.5, flap: 1 },
    lifted: { eyes: 'wide', mouth: 'open', fins: 0.6, wag: 0.6, flap: 1, dangle: 1 },
    walk: { eyes: 'open', mouth: 'smile', fins: 0.2, wag: 0.5, stride: 1 },
  };
  // a touch on a body part (src/core/touch-zones.js), then the mood it put her in
  const TOUCH_LOOKS = {
    head: { eyes: 'happy', mouth: 'cat', fins: 0.3, wag: 0.9, blush: 0.7, tilt: 6, duck: 4 },
    face: { eyes: 'wink', mouth: 'cat', fins: 0.5, wag: 0.6, blush: 1, tilt: -5 },
    chest: { eyes: 'wide', mouth: 'o', fins: 1, wag: 0, blush: 1, lean: -6, flap: 0.8 },
    hands: { eyes: 'happy', mouth: 'smile', fins: 0.6, wag: 0.8, blush: 0.4, hop: 3 },
    belly: { eyes: 'happy', mouth: 'grin', fins: 0.6, wag: 1, wobble: 4, blush: 0.4 },
    butt: { eyes: 'wide', mouth: 'o', fins: 1, wag: 0, blush: 0.9, hop: 8, flap: 1 },
    legs: { eyes: 'half', mouth: 'wavy', fins: 0.2, wag: 0.3, blush: 0.5 },
    feet: { eyes: 'happy', mouth: 'grin', fins: 0.6, wag: 1, wobble: 4, hop: 3 },
    tail: { eyes: 'wide', mouth: 'o', fins: 0.8, wag: 2.2, blush: 0.3 },
  };
  const MOOD_LOOKS = {
    angry: { eyes: 'angry', mouth: 'frown', fins: 1, wag: 0, blush: 0.2, shake: 1 },
    annoyed: { eyes: 'half', mouth: 'frown', fins: -0.3, wag: 0 },
  };
  function lookFor(state, mood) {
    if (state.startsWith('touch-')) return (mood && MOOD_LOOKS[mood]) || TOUCH_LOOKS[state.slice(6)] || LOOKS.pat;
    return LOOKS[state] || LOOKS.idle;
  }

  // ---------- the figure ----------

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // pack:// answers with CORS, so WebGL may read the pixels
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`cannot load ${url}`));
      img.src = url;
    });
  }

  // `look` comes from the main process (core/packs.js resolveLook): { model, base } with `base` the
  // pack:// folder of the outfit's layer images.
  function createFigure(canvas, look) {
    const model = look.model;
    const [W, H] = model.size;
    const PV = model.pivots;
    const face = model.face;
    const legs = model.legs || { hem: H * 0.85, feet: H, split: W / 2 };
    const has = (id) => model.parts.some((p) => p.deformer === id);
    const rectOf = (pred) => {
      const ps = model.parts.filter(pred);
      if (!ps.length) return [0, 0, W, H];
      return [Math.min(...ps.map((p) => p.box[0])), Math.min(...ps.map((p) => p.box[1])), Math.max(...ps.map((p) => p.box[0] + p.box[2])), Math.max(...ps.map((p) => p.box[1] + p.box[3]))];
    };
    const headRect = rectOf((p) => p.deformer === 'head' || p.deformer === 'headWarp');
    const deformers = {
      body: { kind: 'rot', pivot: PV.body || [W / 2, H] },
      skirt: { kind: 'warp', parent: 'body', rect: rectOf((p) => p.deformer === 'skirt') },
      hair: { kind: 'warp', parent: 'body', rect: rectOf((p) => p.deformer === 'hair') },
      tail: { kind: 'rot', parent: 'body', pivot: PV.tail || [W / 2, H / 2] },
      tailBend: { kind: 'warp', parent: 'tail', rect: rectOf((p) => p.deformer === 'tail') },
      head: { kind: 'rot', parent: 'body', pivot: PV.head || PV.neck || [W / 2, H / 3] },
      headWarp: { kind: 'warp', parent: 'head', rect: headRect },
      finL: { kind: 'rot', parent: 'head', pivot: PV.finL || [0, 0] },
      finR: { kind: 'rot', parent: 'head', pivot: PV.finR || [0, 0] },
      ahoge: { kind: 'rot', parent: 'head', pivot: PV.ahoge || [0, 0] },
    };
    // the face's eyes and mouth hang on the turning face; the head's own drawing does too, so the
    // features slide over the outline when she looks aside
    const parts = model.parts.map((p) => ({ ...p, deformer: p.deformer === 'head' ? 'headWarp' : p.deformer === 'tail' ? 'tailBend' : p.deformer }));
    const FACE_RES = 4; // face canvas pixels per drawing pixel: lids and mouths are drawn finer than the art
    if (face) parts.push({ id: 'face', deformer: 'headWarp', z: (Math.max(...model.parts.filter((p) => p.deformer === 'head').map((p) => p.z), 0) || 6) + 0.5, box: face.box, grid: [4, 4] });

    let mesh = null;
    const faceCv = document.createElement('canvas');
    if (face) { faceCv.width = face.box[2] * FACE_RES; faceCv.height = face.box[3] * FACE_RES; }
    const fg = faceCv.getContext('2d');

    const sp = {
      hair: spring(40, 6, 2.2), hairY: spring(45, 7, 1.5), skirt: spring(80, 8, 1.8), tail: spring(30, 4, 40),
      fins: spring(90, 9, 35), ahoge: spring(140, 6, 40), head: spring(70, 10, 18), lean: spring(60, 9, 14),
    };
    const cur = { fins: 0, wag: 0.3, blush: 0, hop: 0, sway: 0, tilt: 0, duck: 0, tear: 0, tailLow: 0, wobble: 0, flap: 0, dangle: 0, stride: 0, turn: 0, slow: 0, nod: 0, lean: 0, pop: 0, gazeUp: 0, shake: 0 };
    let tint = [1, 1, 1, 0];
    let lastT = null;
    let stateNow = null;
    let stateAt = 0;
    let blinkK = 0;
    let lastWin = null;
    let vel = [0, 0];
    let talkPhase = 0;
    let mouthOpen = 0;
    const pose = { alpha: {}, tint: {} };
    // natural blinks: a quick close and open every few seconds, now and then a double blink
    const blink = {
      k: 0,
      next: 1.5,
      start: -1,
      step(t) {
        if (t >= this.next && this.start < 0) this.start = t;
        if (this.start >= 0) {
          const p = (t - this.start) / 0.16;
          this.k = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
          if (p >= 1) { this.start = -1; this.k = 0; this.next = t + (Math.random() < 0.2 ? 0.25 : 2.2 + Math.random() * 3.8); }
        }
      },
    };

    async function load() {
      const imgs = await Promise.all(model.parts.map((p) => loadImage(`${look.base}/${p.id}.png`)));
      return Object.fromEntries(model.parts.map((p, i) => [p.id, imgs[i]]));
    }
    const ready = load().then((imgs) => {
      mesh = createMesh(canvas, { size: [W, H], parts, deformers });
      for (const [id, img] of Object.entries(imgs)) mesh.upload(id, img);
      return true;
    });

    // ---- the face, painted in drawing pixels relative to face.box ----
    const ink = `rgb(${(face && face.ink ? face.ink : [60, 40, 70]).join(',')})`;
    const skin = `rgb(${(face && face.skin ? face.skin : [252, 232, 224]).join(',')})`;
    const F = (x, y) => [(x - face.box[0]) * FACE_RES, (y - face.box[1]) * FACE_RES];
    function cover([x0, y0, x1, y1], share = 1) {
      // skin over the eye from its top down: a closing lid
      // (from just under the lashes: the fringe over the eyes must stay as drawn)
      const [ax, ay] = F(x0 - 0.4, y0 + 0.2);
      const [bx, by] = F(x1 + 0.4, y0 + 0.2 + (y1 - y0 + 0.3) * share);
      fg.fillStyle = skin;
      fg.beginPath();
      fg.ellipse((ax + bx) / 2, ay, (bx - ax) / 2, Math.max(1, by - ay), 0, 0, Math.PI);
      fg.fill();
      return [ax, by, bx];
    }
    function stroke(w = 1.1) { fg.strokeStyle = ink; fg.lineWidth = w * FACE_RES; fg.lineCap = 'round'; fg.lineJoin = 'round'; fg.stroke(); }
    function eye(box, kind, i, t) {
      const [x0, y0, x1, y1] = box;
      const [cx] = F((x0 + x1) / 2, 0);
      const wpx = (x1 - x0) * FACE_RES;
      if (kind === 'open' || kind === 'wide') {
        if (blinkK > 0.02) {
          const [ax, by, bx] = cover(box, blinkK);
          fg.beginPath(); fg.moveTo(ax + 1, by); fg.quadraticCurveTo((ax + bx) / 2, by + FACE_RES * 0.8 * blinkK, bx - 1, by); stroke(1);
        }
        if (kind === 'wide') {
          // a startled glint in each eye
          const [hx, hy] = F(x0 + (x1 - x0) * 0.62, y0 + (y1 - y0) * 0.45);
          fg.fillStyle = 'rgba(255,255,255,.95)';
          fg.beginPath(); fg.arc(hx, hy, FACE_RES * 1.1, 0, Math.PI * 2); fg.fill();
        }
        return;
      }
      if (kind === 'half') {
        const [ax, by, bx] = cover(box, 0.45 + 0.5 * blinkK);
        fg.beginPath(); fg.moveTo(ax + 1, by); fg.lineTo(bx - 1, by); stroke(1.1);
        return;
      }
      if (kind === 'angry') {
        // lids slanting down toward the nose
        const inner = i === 0 ? x1 : x0;
        const outer = i === 0 ? x0 : x1;
        const [ix, iy] = F(inner + (i === 0 ? 0.8 : -0.8), y0 + (y1 - y0) * 0.55);
        const [ox, oy] = F(outer + (i === 0 ? -0.8 : 0.8), y0 - 0.5);
        fg.fillStyle = skin;
        fg.beginPath(); fg.moveTo(ox, oy - FACE_RES * 2); fg.lineTo(ix, oy - FACE_RES * 2); fg.lineTo(ix, iy); fg.lineTo(ox, oy); fg.closePath(); fg.fill();
        fg.beginPath(); fg.moveTo(ox, oy); fg.lineTo(ix, iy); stroke(1.2);
        return;
      }
      // a closed eye: happy arcs up (^), asleep curves down (u); a wink closes the far eye only
      if (kind === 'wink' && i === 0) return eye(box, 'open', i, t);
      const [ax, , bx] = cover(box, 1);
      const mid = F(0, (y0 + y1) / 2)[1];
      fg.beginPath();
      if (kind === 'closed') { fg.moveTo(ax + wpx * 0.12, mid); fg.quadraticCurveTo(cx, mid + FACE_RES * 2.2, bx - wpx * 0.12, mid); }
      else { fg.moveTo(ax + wpx * 0.12, mid + FACE_RES); fg.quadraticCurveTo(cx, mid - FACE_RES * 2.6, bx - wpx * 0.12, mid + FACE_RES); }
      stroke(1.15);
    }
    function mouth(kind, t, open) {
      const [mx, my] = F(face.mouth[0], face.mouth[1]);
      const u = FACE_RES;
      if (kind !== 'none' || open > 0.05) {
        // hide the mouth as drawn under the new one
        fg.fillStyle = skin;
        fg.beginPath(); fg.ellipse(mx, my, u * 3, u * 1.6, 0, 0, Math.PI * 2); fg.fill();
      }
      if (open > 0.05) {
        const h = u * (0.8 + 2.4 * open);
        fg.fillStyle = '#7a2a3a';
        fg.beginPath(); fg.ellipse(mx, my + h * 0.2, u * (1.4 + 0.5 * open), h / 2, 0, 0, Math.PI * 2); fg.fill();
        fg.fillStyle = '#e8838f';
        fg.beginPath(); fg.ellipse(mx, my + h * 0.45, u * (0.9 + 0.3 * open), h * 0.22, 0, 0, Math.PI * 2); fg.fill();
        return;
      }
      fg.beginPath();
      switch (kind) {
        case 'smile': fg.moveTo(mx - u * 1.8, my - u * 0.3); fg.quadraticCurveTo(mx, my + u * 1.4, mx + u * 1.8, my - u * 0.3); stroke(0.8); break;
        case 'grin':
          fg.moveTo(mx - u * 2.2, my - u * 0.6); fg.quadraticCurveTo(mx, my + u * 3, mx + u * 2.2, my - u * 0.6); fg.closePath();
          fg.fillStyle = '#7a2a3a'; fg.fill();
          fg.beginPath(); fg.ellipse(mx, my + u * 1.1, u * 1.1, u * 0.5, 0, 0, Math.PI * 2); fg.fillStyle = '#e8838f'; fg.fill();
          break;
        case 'o': fg.ellipse(mx, my + u * 0.3, u * 0.9, u * 1.1, 0, 0, Math.PI * 2); fg.fillStyle = '#7a2a3a'; fg.fill(); break;
        case 'frown': fg.moveTo(mx - u * 1.6, my + u * 0.8); fg.quadraticCurveTo(mx, my - u * 0.8, mx + u * 1.6, my + u * 0.8); stroke(0.8); break;
        case 'cat':
          fg.moveTo(mx - u * 2, my - u * 0.2); fg.quadraticCurveTo(mx - u, my + u * 1.2, mx, my); fg.quadraticCurveTo(mx + u, my + u * 1.2, mx + u * 2, my - u * 0.2); stroke(0.75); break;
        case 'wavy':
          fg.moveTo(mx - u * 1.8, my); for (let k = 1; k <= 4; k++) fg.lineTo(mx - u * 1.8 + k * u * 0.9, my + (k % 2 ? -0.5 : 0.5) * u); stroke(0.7); break;
        case 'chew': {
          const c = Math.abs(Math.sin(t * 9));
          fg.ellipse(mx, my + u * 0.2, u * (1 + 0.4 * c), u * (0.3 + 0.9 * c), 0, 0, Math.PI * 2); fg.fillStyle = '#7a2a3a'; fg.fill();
          break;
        }
        default: break;
      }
    }
    function blush(a) {
      if (a < 0.02 || !face.blush) return;
      for (const [x, y] of face.blush) {
        const [cx, cy] = F(x, y);
        const r = FACE_RES * 4.5;
        const g = fg.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(255,110,140,${(0.55 * a).toFixed(3)})`);
        g.addColorStop(1, 'rgba(255,110,140,0)');
        fg.fillStyle = g;
        fg.beginPath(); fg.ellipse(cx, cy, r, r * 0.6, 0, 0, Math.PI * 2); fg.fill();
        // three little strokes when she is really flustered
        if (a > 0.7) {
          fg.strokeStyle = `rgba(220,70,100,${((a - 0.7) * 2).toFixed(3)})`; fg.lineWidth = FACE_RES * 0.45;
          for (let k = -1; k <= 1; k++) { fg.beginPath(); fg.moveTo(cx + k * FACE_RES * 1.6 - FACE_RES * 0.5, cy + FACE_RES); fg.lineTo(cx + k * FACE_RES * 1.6 + FACE_RES * 0.5, cy - FACE_RES); fg.stroke(); }
        }
      }
    }
    function tear(a, t) {
      if (a < 0.05) return;
      face.eyes.forEach(([x0, , x1, y1], i) => {
        const [cx, cy] = F(i === 0 ? x0 + 1 : x1 - 1, y1);
        const k = (t * 0.7 + i * 0.5) % 1;
        fg.fillStyle = `rgba(120,190,255,${(0.9 * a * (1 - k)).toFixed(3)})`;
        fg.beginPath(); fg.ellipse(cx, cy + k * FACE_RES * 8, FACE_RES * 0.9, FACE_RES * 1.3, 0, 0, Math.PI * 2); fg.fill();
      });
    }
    function paintFace(L, t, open) {
      fg.setTransform(1, 0, 0, 1, 0, 0);
      fg.clearRect(0, 0, faceCv.width, faceCv.height);
      blush(cur.blush);
      face.eyes.forEach((b, i) => eye(b, L.eyes, i, t));
      tear(cur.tear, t);
      mouth(L.mouth, t, open);
    }

    // canvas pixels per drawing pixel, from the size she is shown at (sharp on a Retina screen)
    let res = 0;
    function fit() {
      const r = canvas.getBoundingClientRect();
      const k = clamp(((r.height || H) / H) * (window.devicePixelRatio || 1) * 1.25, 1, 4);
      if (Math.abs(k - res) / (res || 1) < 0.1) return;
      res = k;
      canvas.width = Math.round(W * k);
      canvas.height = Math.round(H * k);
    }

    let frameN = 0;
    function draw({ t, state, mood = null, talking = false, win = null }) {
      if (!mesh) return false;
      if (frameN++ % 30 === 0) fit();
      const dt = lastT == null ? 1 / 60 : clamp(t - lastT, 0, 0.05);
      lastT = t;
      if (state !== stateNow) { stateNow = state; stateAt = t; }
      const st = t - stateAt; // how long this state has been on
      const L = lookFor(state, mood);
      // window velocity (screen px/s): what flings her hair when she is dragged, thrown or walks
      if (win) {
        if (lastWin) {
          const k = approach(14, dt);
          vel = [lerp(vel[0], (win[0] - lastWin[0]) / Math.max(dt, 1e-3), k), lerp(vel[1], (win[1] - lastWin[1]) / Math.max(dt, 1e-3), k)];
        }
        lastWin = win;
      }
      const mirror = canvas.closest && canvas.closest('[data-facing="left"]') ? -1 : 1; // the CSS mirrors her
      const swing = clamp((vel[0] * mirror) / 600, -1.6, 1.6); // + = moving the way she faces
      const rise = clamp(vel[1] / 900, -1.5, 1.5); // + = falling

      // ease every look parameter toward this state's
      const kk = approach(8, dt);
      for (const key of Object.keys(cur)) cur[key] = lerp(cur[key], L[key] || 0, kk);
      tint = tint.map((v, i) => lerp(v, (L.tint || [1, 1, 1, 0])[i], kk));

      blink.step(t);
      blinkK = blink.k;

      // talking: the mouth opens and closes in syllables
      if (talking) talkPhase += dt * (7 + 3 * Math.sin(t * 1.3));
      const talkOpen = talking ? Math.max(0, Math.sin(talkPhase * Math.PI)) * (0.55 + 0.45 * Math.abs(Math.sin(t * 2.1))) : 0;
      mouthOpen = lerp(mouthOpen, L.mouth === 'open' ? 0.6 + 0.2 * Math.sin(t * 6) : talkOpen, approach(25, dt));

      const breath = Math.sin(t * (cur.slow > 0.5 ? 1.4 : 2.3));
      // hops: a bounce at 1.6 Hz, landing squash
      const hopPh = (t * 1.6) % 1;
      const hop = cur.hop * Math.max(0, Math.sin(hopPh * Math.PI));
      const land = cur.hop > 0.5 ? smooth(0.85, 1, hopPh) * (1 - smooth(0, 0.12, hopPh)) : 0;
      // hatch: she pops in from small with an overshoot
      const pop = cur.pop > 0.05 ? 1 - Math.exp(-st * 6) * Math.cos(st * 12) * 0.5 : 1;
      // walking: two steps a second
      const strideK = cur.stride;
      const stepPh = t * Math.PI * 2 * 2;
      const bob = strideK * Math.abs(Math.sin(stepPh)) * 2.2;

      // body
      const wobble = cur.wobble * Math.sin(t * 7);
      const sway = cur.sway * Math.sin(t * 3.2);
      const shake = cur.shake * Math.sin(t * 40) * 1.2;
      const lean = sp.lean.step(cur.lean - swing * 6, dt);
      pose.body = {
        a: wobble + sway + lean * 0.5 + shake,
        tx: shake * 0.6,
        ty: -hop - bob + cur.duck * 0.2,
        sx: (1 + 0.006 * breath * (1 + cur.slow) + 0.05 * land) * pop,
        sy: (1 - 0.01 * breath * (1 + cur.slow) - 0.07 * land) * pop,
      };

      // head: idle drift, tilt per state, looking about, nodding while talking or eating
      const turn = cur.turn * Math.sin(st * 1.4);
      const nod = cur.nod * Math.sin(t * (talking ? 5 : 8)) * 2;
      let tiltT = Math.sin(t * 0.8) * 1.5 + cur.tilt + turn * 4 + cur.flap * Math.sin(t * 9) * 2;
      if (state === 'lifted') tiltT += swing * 10;
      const tilt = sp.head.step(tiltT, dt);
      pose.head = { a: tilt, ty: cur.duck * 0.6 + nod * 0.5 + (cur.slow > 0.5 ? Math.max(0, breath) * 0.6 : 0) };
      // the face turns: features slide toward the side she looks at, gaze up for thinking
      const fx = turn * 2.4 + (talking ? Math.sin(t * 1.7) * 0.4 : 0);
      const fy = -cur.gazeUp * 1.2 + cur.duck * 0.15;
      pose.headWarp = { fn: (x, y, u, v) => [fx * bump(u) * (0.4 + 0.6 * bump(v)), fy * bump(v) * (0.4 + 0.6 * bump(u))] };

      // springs: hair, skirt and tail trail the motion; fins and ahoge flap
      const tiltVel = (tilt - (pose._tilt || 0)) / Math.max(dt, 1e-3);
      pose._tilt = tilt;
      const air = state === 'lifted' ? 1 : 0;
      const hair = sp.hair.step(-swing * 1.2 - tiltVel * 0.004 - strideK * 0.2 + cur.flap * 0.2 * Math.sin(t * 7), dt);
      const hairY = sp.hairY.step(-air * 0.6 - rise * 0.8 - (hop > 0.5 ? 0.3 : 0), dt);
      const skirt = sp.skirt.step(-swing * 0.9 + sway * 0.04 + wobble * 0.04, dt);
      const neck = deformers.head.pivot;
      pose.hair = {
        fn: (x, y, u, v) => {
          // its top turns with the head, its ends keep to the body and swing on the spring
          const w = 1 - smooth(0.15, 0.55, v);
          const a = rad(tilt) * w;
          const dx = x - neck[0];
          const dy = y - neck[1];
          const wv = Math.pow(v, 1.5);
          return [
            dx * Math.cos(a) - dy * Math.sin(a) - dx + hair * 7 * wv + Math.sin(t * 1.5 + v * 3) * 0.8 * wv,
            dx * Math.sin(a) + dy * Math.cos(a) - dy + hairY * 10 * wv * wv + (pose.head.ty || 0) * w,
          ];
        },
      };
      const hem = legs.hem;
      const feet = legs.feet;
      const skirtTop = hem - (hem - deformers.skirt.rect[1]) * 0.45;
      const stepK = strideK * Math.sin(stepPh);
      const dangle = cur.dangle;
      pose.skirt = {
        fn: (x, y) => {
          // the hem swings; under it each leg steps forward and back (opposite legs), or dangles
          const k = smooth(skirtTop, hem, y);
          let dx = skirt * 5 * k * k + Math.sin(t * 2 + x * 0.05) * 0.3 * k;
          let dy = -hairY * 2 * k * k;
          if (y > hem - 2) {
            const lk = clamp((y - hem) / (feet - hem), 0, 1);
            const side = x < legs.split ? 1 : -1;
            dx += side * stepK * 4 * lk + dangle * Math.sin(t * 6 + side) * 2.5 * lk;
            dy += -Math.max(0, side * stepK) * 3 * lk * lk;
          }
          return [dx, dy];
        },
      };

      const fins = sp.fins.step(cur.fins * 14 - swing * 8 + rise * 10, dt) + cur.flap * 12 * Math.sin(t * 22) + Math.sin(t * 1.4) * 1.5;
      pose.finL = { a: -fins };
      pose.finR = { a: fins };
      const ahoge = sp.ahoge.step(-tiltVel * 0.12 + swing * 18 + rise * 14 + (cur.slow > 0.5 ? 20 : 0) - cur.gazeUp * 10, dt) + Math.sin(t * 2.1) * 3;
      pose.ahoge = { a: ahoge * 0.6 };
      const wagF = 3 + 4 * Math.min(cur.wag, 1.4);
      const tail = sp.tail.step(swing * 16 - cur.tailLow * 14, dt) + cur.wag * 10 * Math.sin(t * wagF) + Math.sin(t * 1.2) * 2;
      pose.tail = { a: tail };
      pose.tailBend = { fn: (x, y, u) => [0, -tail * 0.25 * u * u] };

      pose.tintAll = tint[3] > 0.01 ? tint : null;
      if (face) {
        paintFace(L, t, mouthOpen);
        mesh.upload('face', faceCv);
      }
      mesh.render(pose);
      canvas.dataset.frame = `${state}#${Math.floor(t * 4)}`; // touch hit tests re-read her pixels at most 4× a second
      return true;
    }

    return {
      ready,
      draw,
      dispose() { if (mesh) mesh.dispose(); mesh = null; },
      reset() { for (const s of Object.values(sp)) s.reset(); lastT = null; lastWin = null; vel = [0, 0]; },
    };
  }

  window.PetRig = { createFigure, createMesh, LOOKS, TOUCH_LOOKS };
})();
