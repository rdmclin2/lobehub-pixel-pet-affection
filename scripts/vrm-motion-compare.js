'use strict';
// Side-by-side frames of baked library clips on several real VRM models (T-5081, docs/vrm-motion-library.md §7): the
// app's vendored runtime loads every model and clip the way the pet window does (VRMAnimationLoaderPlugin +
// core/vrm-bone-map.js foldMissing + createVRMAnimationClip), each clip is posed at a few times on each model and
// drawn into one sheet (rows: clips, columns: model × time). It also checks every frame in numbers: the feet under the
// floor, a hand inside the torso, a knee bent backwards — the obvious clipping / distortion a review looks for.
//
//   xvfb-run -a electron --no-sandbox scripts/vrm-motion-compare.js --lib ~/vrm-assets/baked-v2 --out <dir>
//            --models a.vrm,b.vrm,c.vrm --clips stand.v01,idle.v02,react.nod-01,… [--times 0.25,0.5,0.8] [--name sheet]
//
// A clip id without @style plays each model's own style set (--styles female,male,…, one per model, default female).

const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const insideRepo = (p) => { const r = path.relative(ROOT, path.resolve(p)); return !r.startsWith('..') && !path.isAbsolute(r); };
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
  return out;
}

function pageMain(opts) {
  /* global PetVrmRuntime, PetVrmBoneMap */
  const R = PetVrmRuntime;
  const T = R.THREE;
  const BM = PetVrmBoneMap;
  const [w, h] = opts.size;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = T.SRGBColorSpace;
  return (async () => {
    const models = [];
    for (const m of opts.models) {
      const loader = new R.GLTFLoader();
      loader.register((p) => new R.VRMLoaderPlugin(p));
      const g = await loader.loadAsync(m.url);
      const vrm = g.userData.vrm;
      R.VRMUtils.rotateVRM0(vrm);
      const scene = new T.Scene();
      scene.add(new T.AmbientLight(0xffffff, 0.9));
      const sun = new T.DirectionalLight(0xffffff, 1.1);
      sun.position.set(1, 2, 3);
      scene.add(sun);
      const floor = new T.Mesh(new T.PlaneGeometry(4, 4), new T.MeshBasicMaterial({ color: 0xe8ecf2 }));
      floor.rotation.x = -Math.PI / 2;
      scene.add(floor);
      scene.add(vrm.scene);
      const has = (b) => !!vrm.humanoid.getNormalizedBoneNode(b);
      vrm.scene.updateMatrixWorld(true);
      const hw = new T.Vector3();
      vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(hw);
      const hd = new T.Vector3();
      vrm.humanoid.getRawBoneNode('head').getWorldPosition(hd);
      const rh = BM.rootHips(vrm.humanoid.normalizedRestPose.hips.position[1], hd.y);
      models.push({ ...m, vrm, scene, has, rootHips: rh, frameH: rh ? hd.y * 0.58 : hw.y, level: `${BM.degradeLevel(has)}${rh ? ' + root-hips' : ''}`, version: vrm.meta && vrm.meta.metaVersion === '0' ? '0.x' : '1.0', hipsY: hw.y, restHipsLocal: vrm.humanoid.normalizedRestPose.hips.position[1] });
    }
    const loadClip = async (url, vrm, has) => {
      const al = new R.GLTFLoader();
      al.register((p) => new R.VRMAnimationLoaderPlugin(p));
      const ga = await al.loadAsync(url);
      const va = ga.userData.vrmAnimations[0];
      let fold = null;
      const rot = va.humanoidTracks.rotation;
      if (![...rot.keys()].every(has)) {
        const tracks = {};
        for (const [b, tr] of rot) tracks[b] = { times: Array.from(tr.times), values: Array.from(tr.values) };
        const r = BM.foldMissing(tracks, has);
        for (const b of [...rot.keys()]) if (!r.tracks[b]) rot.delete(b);
        for (const [b, tr] of Object.entries(r.tracks)) rot.set(b, new T.QuaternionKeyframeTrack(`${b}.quaternion`, tr.times, tr.values));
        fold = { folded: r.folded, dropped: r.dropped };
      }
      return { clip: R.createVRMAnimationClip(va, vrm), duration: va.duration, fold };
    };
    const rows = [];
    for (const c of opts.clips) {
      const row = { id: c.label, cells: [] };
      for (let mi = 0; mi < models.length; mi++) {
        const M = models[mi];
        const url = c.urls[mi];
        const cell = { model: M.name, file: c.files[mi], shots: [], checks: [] };
        try {
          if (!BM.allowsClip(c.meta[mi], { rootHips: M.rootHips })) throw new Error('skipped: root-hips model plays standing clips only');
          const { clip, duration, fold } = await loadClip(url, M.vrm, M.has);
          cell.fold = fold;
          const mixer = new T.AnimationMixer(M.vrm.scene);
          mixer.clipAction(clip).play();
          const node = (b) => M.vrm.humanoid.getNormalizedBoneNode(b);
          const V = (b) => { const v = new T.Vector3(); const n = node(b); if (n) n.getWorldPosition(v); return v; };
          for (const k of opts.times) {
            const t = Math.min(duration * k, duration - 1e-3);
            mixer.setTime(t);
            // spring bones (hair, hoods, skirts) carry over from the last pose: reset them, then let them settle
            if (M.vrm.springBoneManager) { M.vrm.scene.updateMatrixWorld(true); M.vrm.springBoneManager.reset(); }
            for (let k2 = 0; k2 < 20; k2++) { mixer.setTime(t); M.vrm.update(1 / 30); }
            M.vrm.scene.updateMatrixWorld(true);
            // the camera frames the body wherever the clip put it
            const hp = V('hips');
            if (M.rootHips) hp.y += M.frameH; // her hips are on the floor: frame the pelvis instead
            const cam = new T.PerspectiveCamera(30, w / h, 0.05, 50);
            const H = M.frameH;
            const low = hp.y < H * 0.6;
            cam.position.set(hp.x + (low ? H * 1.2 : 0), Math.max(H * 0.9, hp.y + H * 0.15), hp.z + H * (low ? 4.2 : 4.6));
            cam.lookAt(hp.x, low ? Math.max(0.2, hp.y) : H * 0.95, hp.z);
            renderer.render(M.scene, cam);
            cell.shots.push({ t: +t.toFixed(2), png: canvas.toDataURL('image/png') });
            // checks: feet under the floor (cm), a hand inside the torso, a knee bent the wrong way
            const footY = Math.min(V('leftFoot').y, V('rightFoot').y);
            const chest = V(node('upperChest') ? 'upperChest' : 'chest');
            const spine = V('spine');
            const inTorso = (hand) => {
              const p = V(hand);
              // distance from the spine → chest segment
              const ab = new T.Vector3().subVectors(chest, spine);
              const ap = new T.Vector3().subVectors(p, spine);
              const k2 = Math.max(0, Math.min(1, ap.dot(ab) / ab.lengthSq()));
              return p.distanceTo(spine.clone().add(ab.multiplyScalar(k2)));
            };
            const handTorso = Math.min(inTorso('leftHand'), inTorso('rightHand'));
            const knee = (s) => { const a = V(`${s}UpperLeg`); const b = V(`${s}LowerLeg`); const f = V(`${s}Foot`); return ((new T.Vector3().subVectors(b, a).angleTo(new T.Vector3().subVectors(f, b))) * 180) / Math.PI; };
            cell.checks.push({ t: +t.toFixed(2), footBelowCm: +(Math.min(0, footY - 0.0) * -100).toFixed(1), handTorsoCm: +(handTorso * 100).toFixed(1), kneeDeg: [+knee('left').toFixed(0), +knee('right').toFixed(0)] });
          }
          mixer.stopAllAction();
          mixer.uncacheRoot(M.vrm.scene);
          M.vrm.humanoid.resetNormalizedPose();
        } catch (e) { cell.error = String(e && e.message); }
        row.cells.push(cell);
      }
      rows.push(row);
    }
    // the sheet: a header row of model names, then one row per clip
    const cols = models.length * opts.times.length;
    const HEAD = 26;
    const sheet = document.createElement('canvas');
    sheet.width = cols * w;
    sheet.height = HEAD + rows.length * h;
    const cx = sheet.getContext('2d');
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, sheet.width, sheet.height);
    cx.font = 'bold 15px sans-serif';
    models.forEach((M, mi) => { cx.fillStyle = mi % 2 ? '#eef1f6' : '#dfe5ee'; cx.fillRect(mi * opts.times.length * w, 0, opts.times.length * w, HEAD); cx.fillStyle = '#111'; cx.fillText(`${M.name} · VRM ${M.version} · ${M.style} · bones ${M.level}`, mi * opts.times.length * w + 8, 18); });
    for (let ri = 0; ri < rows.length; ri++) {
      const r = rows[ri];
      for (let mi = 0; mi < r.cells.length; mi++) {
        const cell = r.cells[mi];
        for (let ti = 0; ti < opts.times.length; ti++) {
          const x = (mi * opts.times.length + ti) * w;
          const y = HEAD + ri * h;
          const s = cell.shots[ti];
          if (s) { const img = new Image(); img.src = s.png; await img.decode(); cx.drawImage(img, x, y); }
          cx.strokeStyle = '#c8ccd4';
          cx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
          cx.fillStyle = '#20242c';
          cx.font = '13px sans-serif';
          cx.fillText(`${r.id}  t=${s ? s.t : '-'}s`, x + 6, y + 16);
          if (cell.error) { cx.fillStyle = '#c00'; cx.fillText(cell.error.slice(0, 40), x + 6, y + 34); }
        }
      }
    }
    for (const r of rows) for (const c of r.cells) for (const s of c.shots) delete s.png;
    return { png: sheet.toDataURL('image/png'), rows, models: models.map((M) => ({ name: M.name, version: M.version, style: M.style, level: M.level, hipsY: +M.hipsY.toFixed(3), restHipsLocal: +M.restHipsLocal.toFixed(3) })) };
  })();
}

async function main() {
  const a = args(process.argv.slice(process.argv.indexOf(__filename) + 1));
  for (const k of ['lib', 'out', 'models', 'clips']) if (!a[k]) throw new Error(`--${k} is required`);
  const lib = path.resolve(home(a.lib));
  const out = path.resolve(home(a.out));
  if (insideRepo(out)) throw new Error(`refusing to write inside the repository: ${out}`);
  const index = JSON.parse(fs.readFileSync(path.join(lib, 'library.json'), 'utf8'));
  const files = a.models.split(',').map((m) => path.resolve(home(m)));
  const styles = (a.styles || '').split(',').filter(Boolean);
  const names = (a.names || '').split(',').filter(Boolean);
  const models = files.map((f, i) => ({ url: pathToFileURL(f).href, name: names[i] || path.basename(f, '.vrm').slice(0, 18), style: styles[i] || 'female' }));
  const dlib = fs.existsSync(path.join(lib, 'dances', 'library.json')) ? JSON.parse(fs.readFileSync(path.join(lib, 'dances', 'library.json'), 'utf8')) : { dances: {} };
  const clips = a.clips.split(',').map((id) => {
    // dance:<id> — a dance of the dance library (<lib>/dances), the same file on every model
    if (id.startsWith('dance:')) {
      const d = dlib.dances[id.slice(6)];
      if (!d) throw new Error(`no dance ${id} in ${lib}/dances/library.json`);
      const f = path.join('dances', d.file);
      return { label: id, meta: models.map(() => ({ group: 'dance', enter: 'stand', exit: 'stand' })), files: models.map(() => f), urls: models.map(() => pathToFileURL(path.join(lib, f)).href) };
    }
    const filesFor = models.map((m) => {
      const full = id.includes('@') ? id : `${id}@${m.style}`;
      const fallback = index.styleFallback ? index.styleFallback[m.style] : [m.style];
      const slot = full.split('@')[0];
      const hit = index.clips[full] || fallback.map((s) => index.clips[`${slot}@${s}`]).find(Boolean);
      if (!hit || !hit.file) throw new Error(`no clip ${full} in ${lib}/library.json`);
      return hit.file;
    });
    const metas = models.map((m) => { const full = id.includes('@') ? id : `${id}@${m.style}`; const slot = full.split('@')[0]; return index.clips[full] || (index.styleFallback ? index.styleFallback[m.style] : [m.style]).map((s) => index.clips[`${slot}@${s}`]).find(Boolean); });
    return { label: id, meta: metas.map((e) => ({ group: e.group, enter: e.enter, exit: e.exit, sit: e.sit })), files: filesFor, urls: filesFor.map((f) => pathToFileURL(path.join(lib, f)).href) };
  });
  const times = String(a.times || '0.3,0.7').split(',').map(Number);
  const size = String(a.size || '240x340').split('x').map(Number);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vrm-motion-compare-'));
  const html = path.join(tmp, 'index.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="${pathToFileURL(path.join(ROOT, 'src', 'renderer', 'vendor', 'vrm', 'three-vrm.min.js')).href}"></script><script src="${pathToFileURL(path.join(ROOT, 'src', 'core', 'vrm-bone-map.js')).href}"></script>`);
  const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { webSecurity: false, contextIsolation: true } });
  await win.loadFile(html);
  const opts = { models, clips, times, size };
  const res = await win.webContents.executeJavaScript(`(async () => { try { return await (${pageMain.toString()})(${JSON.stringify(opts)}); } catch (e) { return { error: String((e && e.stack) || e) }; } })()`);
  if (res.error) throw new Error(`in the page: ${res.error}`);
  const name = a.name || 'compare';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(res.png.split(',')[1], 'base64'));
  delete res.png;
  fs.writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(res, null, 1)}\n`);
  console.log(`wrote ${path.join(out, `${name}.png`)} (${res.rows.length} clips × ${res.models.length} models)`);
  for (const M of res.models) console.log(`  model ${M.name}: VRM ${M.version}, style ${M.style}, bones ${M.level}, hips ${M.hipsY} m (normalized rest hips y ${M.restHipsLocal})`);
  for (const r of res.rows) {
    for (const c of r.cells) {
      const worst = c.checks.reduce((m, k) => ({ foot: Math.max(m.foot, k.footBelowCm), hand: Math.min(m.hand, k.handTorsoCm), knee: Math.max(m.knee, ...k.kneeDeg) }), { foot: 0, hand: 999, knee: 0 });
      console.log(`  ${r.id.padEnd(18)} ${c.model.padEnd(18)} ${c.error ? `ERROR ${c.error}` : `feet below floor ≤ ${worst.foot} cm, hand–torso ≥ ${worst.hand} cm, knee ≤ ${worst.knee}°${c.fold ? `, folded ${JSON.stringify(c.fold.folded)} dropped ${c.fold.dropped.length}` : ''}`}`);
    }
  }
}

app.whenReady().then(main).then(() => app.exit(0), (e) => { console.error(e && e.stack ? e.stack : e); app.exit(1); });
