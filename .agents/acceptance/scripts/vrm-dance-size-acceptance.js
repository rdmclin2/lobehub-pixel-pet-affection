// VRM dance size acceptance (T-12268): is she as big while dancing as before and after? A real model and the real
// baked dances, imported and played through the real app. Measures the camera (debug().figures[0].camera), the root
// (position, and that nothing scales her), the hips' travel (data-dance-hips) and the pixels she covers on the canvas
// (the alpha bounding box), before the dance, at evenly spaced times in it, and after it — per dance, per framing.
// Run it on two revisions with the same arguments (label before / after): at the same dance time the pose is the same,
// so the ratio of the two bounding boxes is the size change alone.
// Nothing is copied into the repository: the model and the dances must live outside it.
//
// usage: env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s '-screen 0 1280x800x24' node \
//          .agents/acceptance/scripts/vrm-dance-size-acceptance.js <repo> <out dir> --model <model.vrm> \
//          --dances ~/vrm-assets/baked-dances [--motions ~/vrm-assets/baked-v2] [--ids a,b,c] [--samples 24] [--half <id>]
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const argv = process.argv.slice(2);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const home = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const ROOT = path.resolve(argv[0]);
const OUT = path.resolve(argv[1]);
const MODEL = path.resolve(home(opt('model')));
const DANCES = path.resolve(home(opt('dances', '~/vrm-assets/baked-dances')));
const MOTIONS = path.resolve(home(opt('motions', '~/vrm-assets/baked-v2')));
const SAMPLES = Number(opt('samples', 24));
const library = JSON.parse(fs.readFileSync(path.join(DANCES, 'library.json'), 'utf8')).dances;
const IDS = (opt('ids') || Object.keys(library).join(',')).split(',');
const HALF = opt('half');
for (const p of [MODEL, DANCES, MOTIONS]) if (!path.relative(ROOT, p).startsWith('..')) throw new Error(`must live outside the repository: ${p}`);
const { _electron } = require(path.join(ROOT, 'node_modules', 'playwright'));
fs.mkdirSync(OUT, { recursive: true });
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CANVAS = '#pet-look canvas.vrm';

// everything one sample reads, in one page.evaluate so it is one frame's worth
const read = (page) => page.evaluate((sel) => {
  const c = document.querySelector(sel);
  const f = window.PetVRM.debug().figures[0];
  const off = document.createElement('canvas');
  off.width = c.width;
  off.height = c.height;
  const g = off.getContext('2d', { willReadFrequently: true });
  g.drawImage(c, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let minX = Infinity; let maxX = -1; let minY = Infinity; let maxY = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (px[(y * c.width + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const fp = window.PetVRM.director.framePoints();
  const box = maxX < 0 ? null : { w: (maxX - minX + 1) / c.width, h: (maxY - minY + 1) / c.height, top: minY / c.height, bottom: (c.height - 1 - maxY) / c.height, left: minX / c.width, right: (c.width - 1 - maxX) / c.width };
  return { state: c.dataset.danceState, framing: c.dataset.framing, t: Number(c.dataset.danceT), hips: (c.dataset.danceHips || '0,0').split(',').map(Number), camera: f.camera, root: f.root, fp, box };
}, CANVAS);
const png = async (page, file) => {
  const url = await page.evaluate((sel) => document.querySelector(sel).toDataURL('image/png'), CANVAS);
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
};
const quiet = (page) => page.waitForFunction((sel) => { const c = document.querySelector(sel); return c && c.dataset.danceState === 'off' && /^[^,]+:1\.00$/.test(c.dataset.layers || '') && !window.PetVRM.debug().figures[0].gliding; }, CANVAS, { timeout: 30000 });
const inFrame = (s) => Object.entries(s.fp || {}).filter(([, [x, y]]) => Math.abs(x) > 1 || Math.abs(y) > 1).map(([n]) => n);

async function measure(page, id, framing) {
  const tag = `${id}-${framing}`;
  const dir = path.join(OUT, tag);
  fs.mkdirSync(dir, { recursive: true });
  await quiet(page);
  const before = await read(page);
  await png(page, path.join(dir, '1-before.png'));
  const played = await page.evaluate((x) => window.PetDance.current.play({ id: x, loop: true }), id);
  if (!played.ok) throw new Error(`${id}: ${JSON.stringify(played)}`);
  await page.waitForFunction((sel) => document.querySelector(sel).dataset.danceState === 'on', CANVAS, { timeout: 30000 });
  await page.evaluate(() => window.PetDance.current.speed(0.25)); // slow: a sample's pose is the seeked one
  await sleep(1000);
  const duration = played.duration;
  const during = [];
  for (let i = 0; i < SAMPLES; i++) {
    const at = duration * 0.02 + (duration * 0.96 * i) / Math.max(1, SAMPLES - 1);
    await page.evaluate((x) => window.PetDance.current.seek(x), at);
    await sleep(350);
    const s = await read(page);
    during.push({ at: +at.toFixed(2), ...s, out: inFrame(s) });
    if (i === Math.floor(SAMPLES / 2)) await png(page, path.join(dir, '2-during.png'));
    if (inFrame(s).length) await png(page, path.join(dir, `out-${String(i).padStart(2, '0')}.png`)); // a limb past the canvas edge: how bad does it look?
  }
  await page.screenshot({ path: path.join(dir, '2-during-window.png') });
  await page.evaluate(() => window.PetDance.current.stop());
  await quiet(page);
  await sleep(400);
  const after = await read(page);
  await png(page, path.join(dir, '3-after.png'));
  const zs = during.map((s) => s.hips[1]);
  const res = {
    id, name: library[id].name, framing, duration, extent: library[id].extent,
    before: { framing: before.framing, camera: before.camera, root: before.root, box: before.box },
    during: {
      framing: [...new Set(during.map((s) => s.framing))], cameraZ: [...new Set(during.map((s) => +s.camera.z.toFixed(4)))],
      hipsZ: [+Math.min(...zs).toFixed(3), +Math.max(...zs).toFixed(3)], meanBoxH: +(during.reduce((a, s) => a + (s.box ? s.box.h : 0), 0) / during.length).toFixed(3),
      samplesWithPointsOut: during.filter((s) => s.out.length).length, samples: during.length,
      pointsOut: during.reduce((m, s) => { for (const n of s.out) m[n] = (m[n] || 0) + 1; return m; }, {}),
    },
    after: { framing: after.framing, camera: after.camera, root: after.root, box: after.box },
  };
  fs.writeFileSync(path.join(dir, 'samples.json'), `${JSON.stringify({ ...res, samples: during }, null, 1)}\n`);
  console.log(JSON.stringify(res));
  return { ...res, sampleList: during };
}

(async () => {
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 't12268-data-'));
  const fakeLh = fs.mkdtempSync(path.join(os.tmpdir(), 't12268-lh-'));
  fs.writeFileSync(path.join(fakeLh, 'loggedin'), '1');
  fs.writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ ageGateVersion: 2, answered: true, ageConfirmed: true, ageConfirmedAt: Date.now(), adultContent: false, petScale: 1.6, petScaleSet: true }));
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    cwd: ROOT,
    env: { ...cleanEnv, PIXELPET_TEST: '1', PIXELPET_CLEAR_JWT: '1', PIXELPET_DATA_DIR: DATA, PIXELPET_VRM_DANCES_DIR: DANCES, PIXELPET_VRM_MOTIONS_DIR: MOTIONS, LH_BIN: path.join(ROOT, 'test', 'fixtures', 'fake-lh.js'), FAKE_LH_DIR: fakeLh },
  });
  const results = [];
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => d.accept());
    await page.waitForSelector('.char-card', { timeout: 30000 });
    await page.click('.char-card[data-character="dafeiyu-pixel"]');
    await page.fill('#pet-name', '莉莉雅');
    await page.click('#hatch-btn');
    // the permissions step of a new install: skipped as a user can, 下一步 until she is on the desk
    for (let i = 0; i < 40 && await page.locator('#pet-screen.hidden').count(); i++) {
      const next = page.getByText('下一步', { exact: true }).or(page.getByText('完成', { exact: true })).first();
      if (await next.isVisible().catch(() => false)) await next.click().catch(() => {});
      await sleep(500);
    }
    await page.waitForSelector('#pet-screen:not(.hidden)', { timeout: 30000 });
    await page.waitForFunction(() => !document.body.classList.contains('busy'), null, { timeout: 30000 });
    await page.evaluate((x) => window.pet.debugNextOpen(x), MODEL);
    const imp = await page.evaluate(() => window.pet.importVrm('dafeiyu'));
    if (!imp.ok) throw new Error(`import: ${JSON.stringify(imp).slice(0, 300)}`);
    await page.evaluate((x) => window.pet.switchCharacter(x), imp.pack.id);
    await page.waitForFunction((x) => document.getElementById('pet-look').dataset.key.startsWith(`${x}/`), imp.pack.id, { timeout: 30000 });
    await page.waitForFunction((sel) => { const c = document.querySelector(sel); return c && Number(c.dataset.frame) > 3; }, CANVAS, { timeout: 120000 });
    await sleep(2500);
    for (const id of IDS) results.push(await measure(page, id, 'full'));
    if (HALF) {
      await page.evaluate(() => window.pet.setPrefs({ framing: 'half' }));
      await page.waitForFunction((sel) => document.querySelector(sel).dataset.framing === 'half', CANVAS, { timeout: 10000 });
      await sleep(1000);
      results.push(await measure(page, HALF, 'half'));
    }
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(fakeLh, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify({ model: path.basename(MODEL), errors, results }, null, 1)}\n`);
  console.log(`page errors: ${errors.length}`, errors.slice(0, 5));
})().catch((e) => { console.error(e); process.exit(1); });
