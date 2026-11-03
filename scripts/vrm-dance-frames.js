'use strict';
// Still frames of a baked dance on a real VRM model, for review (docs/vrm-dance.md §8.1 D1): the app's own vendored
// runtime (src/renderer/vendor/vrm/three-vrm.min.js) loads the model and the .vrma the way the pet window does
// (VRMAnimationLoaderPlugin + createVRMAnimationClip), the mixer is set to each time and the frame drawn into a
// contact sheet. It also measures the pose on the model (hands / feet / knees in world space) so the handedness
// and the legs can be checked in numbers, not only by eye.
//
//   xvfb-run -a electron --no-sandbox scripts/vrm-dance-frames.js --model <file.vrm> --dance <dance.vrma> --out <dir>
//            [--times 0,1.5,3,…] [--count 8] [--size 300x420] [--name label]
//
// Writes <out>/<name>.png (the sheet) and <out>/<name>.json (the measurements). Nothing is written in the repository.

const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('enable-unsafe-swiftshader'); // WebGL under xvfb, like e2e/run.js
app.commandLine.appendSwitch('ignore-gpu-blocklist');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const insideRepo = (p) => { const r = path.relative(ROOT, path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  return out;
}

// runs in the page
function pageMain(opts) {
  /* global PetVrmRuntime */
  const R = PetVrmRuntime;
  const T = R.THREE;
  const [w, h] = opts.size;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = T.SRGBColorSpace;
  const scene = new T.Scene();
  scene.add(new T.AmbientLight(0xffffff, 0.9));
  const sun = new T.DirectionalLight(0xffffff, 1.1);
  sun.position.set(1, 2, 3);
  scene.add(sun);
  // a floor grid made of thin boxes would need more API than the runtime exports: a flat plane with a ring at the origin
  const floor = new T.Mesh(new T.PlaneGeometry(4, 4), new T.MeshBasicMaterial({ color: 0xe8ecf2 }));
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const mark = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.002, 16), new T.MeshBasicMaterial({ color: 0x8090a0 }));
  scene.add(mark);
  const camera = new T.PerspectiveCamera(30, w / h, 0.05, 50);

  return (async () => {
    const loader = new R.GLTFLoader();
    loader.register((p) => new R.VRMLoaderPlugin(p));
    const g = await loader.loadAsync(opts.model);
    const vrm = g.userData.vrm;
    R.VRMUtils.rotateVRM0(vrm);
    scene.add(vrm.scene);
    const al = new R.GLTFLoader();
    al.register((p) => new R.VRMAnimationLoaderPlugin(p));
    const ga = await al.loadAsync(opts.dance);
    const va = ga.userData.vrmAnimations[0];
    const clip = R.createVRMAnimationClip(va, vrm);
    const mixer = new T.AnimationMixer(vrm.scene);
    mixer.clipAction(clip).play();
    const hipsY = vrm.humanoid.normalizedRestPose.hips.position[1];
    camera.position.set(0, hipsY * 1.05, hipsY * 4.6);
    camera.lookAt(0, hipsY * 0.95, 0);
    const times = opts.times.length ? opts.times : Array.from({ length: opts.count }, (_, i) => +((va.duration * (i + 0.5)) / opts.count).toFixed(2));
    const node = (b) => vrm.humanoid.getNormalizedBoneNode(b);
    const wp = (b) => { const n = node(b); if (!n) return null; const v = new T.Vector3(); n.getWorldPosition(v); return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)]; };
    const frames = [];
    const shots = [];
    for (const t of times) {
      mixer.setTime(Math.min(t, va.duration - 1e-3)); // a repeating action wraps to 0 at exactly its duration
      vrm.update(0);
      vrm.scene.updateMatrixWorld(true);
      renderer.render(scene, camera);
      shots.push(canvas.toDataURL('image/png'));
      // the knee from world positions (model-convention free): flexion = angle between thigh and shin; ahead = how far
      // the knee sits in front of the hip–ankle line along the body's forward (left hip → right hip × up), in metres
      const V3 = (b) => { const v = new T.Vector3(); node(b).getWorldPosition(v); return v; };
      const fwd = new T.Vector3().subVectors(V3('leftUpperLeg'), V3('rightUpperLeg')).cross(new T.Vector3(0, 1, 0)).normalize();
      const knee = (s) => {
        const hp = V3(`${s}UpperLeg`); const kp = V3(`${s}LowerLeg`); const ap = V3(`${s}Foot`);
        const th = new T.Vector3().subVectors(kp, hp); const sh = new T.Vector3().subVectors(ap, kp);
        const line = new T.Vector3().subVectors(ap, hp).normalize();
        const off = new T.Vector3().subVectors(kp, hp); off.sub(line.clone().multiplyScalar(off.dot(line)));
        return { flexDeg: +((th.angleTo(sh) * 180) / Math.PI).toFixed(1), aheadM: +off.dot(fwd).toFixed(3) };
      };
      frames.push({ t, hips: wp('hips'), head: wp('head'), leftHand: wp('leftHand'), rightHand: wp('rightHand'), leftFoot: wp('leftFoot'), rightFoot: wp('rightFoot'), knee: { left: knee('left'), right: knee('right') } });
    }
    // the sheet
    const cols = Math.min(times.length, opts.cols || 4);
    const rows = Math.ceil(times.length / cols);
    const sheet = document.createElement('canvas');
    sheet.width = cols * w;
    sheet.height = rows * h;
    const cx = sheet.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, sheet.width, sheet.height);
    for (let i = 0; i < shots.length; i++) {
      const img = new Image();
      img.src = shots[i];
      await img.decode();
      const x = (i % cols) * w;
      const y = Math.floor(i / cols) * h;
      cx.drawImage(img, x, y);
      cx.strokeStyle = '#c8ccd4';
      cx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      cx.fillStyle = '#20242c';
      cx.font = '14px sans-serif';
      cx.fillText(`${opts.label}  t=${times[i].toFixed(2)}s`, x + 8, y + 18);
    }
    return { png: sheet.toDataURL('image/png'), frames, duration: va.duration, hipsY, meta: { vrm: vrm.meta && vrm.meta.metaVersion, expressions: [...va.expressionTracks.preset.keys()], humanoid: va.humanoidTracks.rotation.size } };
  })();
}

async function main() {
  const a = args(process.argv.slice(process.argv.indexOf(__filename) + 1));
  for (const k of ['model', 'dance', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
  const out = path.resolve(a.out);
  if (insideRepo(out)) throw new Error(`refusing to write inside the repository: ${out}`);
  const name = a.name || path.basename(path.dirname(path.resolve(a.dance)));
  const size = String(a.size || '300x420').split('x').map(Number);
  const times = typeof a.times === 'string' ? a.times.split(',').map(Number) : [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrm-dance-frames-'));
  const html = path.join(tmp, 'index.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="${pathToFileURL(path.join(ROOT, 'src', 'renderer', 'vendor', 'vrm', 'three-vrm.min.js')).href}"></script>`);
  const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { webSecurity: false, contextIsolation: true } });
  await win.loadFile(html);
  const opts = { model: pathToFileURL(path.resolve(a.model)).href, dance: pathToFileURL(path.resolve(a.dance)).href, size, times, count: Number(a.count) || 8, cols: Number(a.cols) || 4, label: a.label || name };
  const res = await win.webContents.executeJavaScript(`(async () => { try { return await (${pageMain.toString()})(${JSON.stringify(opts)}); } catch (e) { return { error: String((e && e.stack) || e) }; } })()`);
  if (res.error) throw new Error(`in the page: ${res.error}`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(res.png.split(',')[1], 'base64'));
  const json = { model: path.resolve(a.model), dance: path.resolve(a.dance), duration: res.duration, hipsY: res.hipsY, meta: res.meta, frames: res.frames };
  fs.writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(json, null, 1)}\n`);
  console.log(`wrote ${path.join(out, `${name}.png`)} and .json (${res.frames.length} frames, model hips ${res.hipsY.toFixed(3)} m, VRM ${res.meta.vrm}, ${res.meta.humanoid} rotation tracks bound, expressions [${res.meta.expressions.join(', ')}])`);
  for (const f of res.frames) console.log(`  t=${f.t.toFixed(2)}  hips ${f.hips}  L.hand ${f.leftHand}  R.hand ${f.rightHand}  L.foot ${f.leftFoot}  R.foot ${f.rightFoot}  knee L ${f.knee.left.flexDeg}° (ahead ${f.knee.left.aheadM} m) R ${f.knee.right.flexDeg}° (ahead ${f.knee.right.aheadM} m)`);
}

app.whenReady().then(main).then(() => app.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); app.exit(1); });
