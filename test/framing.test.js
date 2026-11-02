'use strict';
// 取景 (半身模式, docs/half-body-mode.md): the setting (default, migration, per-character / per-pack override),
// its admin-console field, the half-body band from humanoid bones (with the bounding-box fallback), the camera
// for both modes, the glide between them, and touch zones on a half-body picture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FR = require('../src/core/framing');
const settingsLib = require('../src/core/settings');
const schema = require('../src/core/settings-schema');
const P = require('../src/core/packs');
const TZ = require('../src/core/touch-zones');
const { makeTestVrm } = require('../scripts/make-test-vrm');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- the setting ------------------------------------------------------------------------------------------
test('settings: prefs.framing defaults to full; framings is an empty per-character map', () => {
  const d = settingsLib.normalizeSettings(null);
  assert.equal(d.prefs.framing, 'full');
  assert.deepEqual(d.framings, {});
  assert.equal(settingsLib.PREFS.framing, 'full');
});

test('settings migration: a file from before 取景 loads as 全身 and keeps everything else; unknown values → full', () => {
  const old = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'settings-v0.10.0.json'), 'utf8'));
  assert.equal(old.prefs.framing, undefined, 'the fixture predates 取景');
  const s = settingsLib.normalizeSettings(old);
  assert.equal(s.prefs.framing, 'full');
  assert.deepEqual(s.framings, {});
  for (const [k, v] of Object.entries(old.prefs)) assert.equal(s.prefs[k], v, `prefs.${k} kept`);
  assert.deepEqual(s.appearance, old.appearance);
  for (const bad of ['HALF', 'bust', 1, true, null, ['half']]) assert.equal(settingsLib.normalizeSettings({ prefs: { framing: bad } }).prefs.framing, 'full', JSON.stringify(bad));
  assert.equal(settingsLib.normalizeSettings({ prefs: { framing: 'half' } }).prefs.framing, 'half');
  // per character: only real ids and real framings; 'auto' is "no entry"
  assert.deepEqual(settingsLib.normalizeSettings({ framings: { claude: 'half', gpt: 'full', grok: 'auto', gemini: 'x', 'Bad Id': 'half', dafeiyu: 3 } }).framings, { claude: 'half', gpt: 'full' });
  assert.deepEqual(settingsLib.normalizeSettings({ framings: ['half'] }).framings, {});
});

test('settings: 取景 survives a save and a reload (SettingsStore on disk = after a restart)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-framing-'));
  const store = new settingsLib.SettingsStore(dir);
  store.save({ ...store.load(), prefs: { ...store.load().prefs, framing: 'half' }, framings: { dafeiyu: 'full' } });
  const again = new settingsLib.SettingsStore(dir).load();
  assert.equal(again.prefs.framing, 'half');
  assert.deepEqual(again.framings, { dafeiyu: 'full' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).prefs.framing, 'half');
});

test('resolveFraming: her own choice > the pack default > the global setting; only camera looks re-frame', () => {
  const vrm = { kind: 'vrm', packId: 'v' };
  const vrmHalfPack = { kind: 'vrm', packId: 'v', framing: 'half' };
  const pixel = { kind: 'sprites', packId: 'p' };
  const S = (framing, framings = {}) => ({ prefs: { framing }, framings });
  assert.deepEqual(FR.resolveFraming(S('full'), 'dafeiyu', vrm), { mode: 'full', wanted: 'full', source: 'global', supported: true });
  assert.deepEqual(FR.resolveFraming(S('half'), 'dafeiyu', vrm), { mode: 'half', wanted: 'half', source: 'global', supported: true });
  assert.deepEqual(FR.resolveFraming(S('full'), 'dafeiyu', vrmHalfPack), { mode: 'half', wanted: 'half', source: 'pack', supported: true });
  assert.deepEqual(FR.resolveFraming(S('half', { dafeiyu: 'full' }), 'dafeiyu', vrmHalfPack), { mode: 'full', wanted: 'full', source: 'character', supported: true });
  assert.equal(FR.resolveFraming(S('full', { claude: 'half' }), 'dafeiyu', vrm).mode, 'full', 'another character\'s choice is not hers');
  // a pixel pack keeps its full art whatever is asked
  assert.deepEqual(FR.resolveFraming(S('half'), 'claude', pixel), { mode: 'full', wanted: 'half', source: 'global', supported: false });
  // nothing known yet (before the settings arrive / no look)
  assert.equal(FR.resolveFraming(null, null, vrm).mode, 'full');
  assert.equal(FR.resolveFraming(S('half'), 'dafeiyu', null).mode, 'full');
});

test('admin console: 桌宠行为 → 大小与取景 has the 取景 segmented field (live), framings.<id> is per character', () => {
  const f = schema.field('prefs.framing');
  assert.ok(f);
  assert.equal(f.page, 'behavior');
  assert.equal(f.card, '大小与取景');
  assert.equal(f.type, 'segmented');
  assert.deepEqual(f.options.map((o) => [o.value, o.label]), [['full', '全身'], ['half', '半身']]);
  assert.equal(f.default, 'full');
  assert.equal(f.live, true, 'applies at once');
  assert.equal(f.restart, false);
  assert.match(f.desc, /立即生效/);
  assert.equal(schema.field('petScale').card, '大小与取景', 'the size and the framing share one card');
  assert.deepEqual(schema.validate('prefs.framing', 'half'), { ok: true, value: 'half' });
  assert.equal(schema.validate('prefs.framing', 'bust').ok, false);
  assert.deepEqual(schema.patchFor('prefs.framing', 'half'), { setter: 'setPrefs', patch: { framing: 'half' } });
  assert.equal(schema.field('framings.<id>').type, 'perCharacter');
  assert.ok(schema.settingsLeaves().includes('framings.<id>'));
  assert.ok(schema.settingsLeaves().includes('prefs.framing'));
});

test('pack.json framing: an optional default (full | half) carried into the look; anything else is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-framing-pack-'));
  const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const write = (m) => { const dir = path.join(root, m.id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'a.png'), PNG); fs.writeFileSync(path.join(dir, 'model.vrm'), makeTestVrm({ name: 'Bust' })); return dir; };
  const vrmPack = (over) => ({ schema: 2, id: 'bust-vrm', name: 'Bust', species: 'dafeiyu', kind: 'vrm', vrm: { outfits: { daily: 'model.vrm' } }, ...over });
  const ok = P.validatePack(vrmPack({ framing: 'half' }), write(vrmPack({})));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.pack.framing, 'half');
  const packs = new Map([[ok.pack.id, ok.pack]]);
  const look = P.resolveLook(packs, { packId: 'bust-vrm', speciesId: 'dafeiyu', outfitId: 'daily' });
  assert.equal(look.framing, 'half');
  assert.equal(FR.resolveFraming({ prefs: { framing: 'full' } }, 'dafeiyu', look).mode, 'half');
  const none = P.validatePack(vrmPack({ id: 'plain-vrm' }), write(vrmPack({ id: 'plain-vrm' })));
  assert.equal(none.pack.framing, undefined, 'no default: follows the global setting');
  const bad = P.validatePack(vrmPack({ id: 'bad-vrm', framing: 'bust' }), write(vrmPack({ id: 'bad-vrm' })));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /framing must be one of full, half/.test(e)), bad.errors.join('; '));
});

// ---- the half-body band -----------------------------------------------------------------------------------
// scripts/make-test-vrm.js's skeleton at rest: hips 0.45, spine 0.53, chest 0.63, neck 0.75, head 0.80; the
// skull box reaches 0.80 + 0.27 = 1.07, the ahoge a little higher; feet at 0.
const TEST_BONES = { hips: { x: 0, y: 0.45 }, spine: { x: 0, y: 0.53 }, chest: { x: 0, y: 0.63 }, neck: { x: 0, y: 0.75 }, head: { x: 0, y: 0.8 } };
const TEST_BOX = { minX: -0.3, maxX: 0.3, minY: 0, maxY: 1.1 };
// a VRoid-like 1.6 m model: hips 0.92, upperChest 1.22, neck 1.38, head 1.45, hair top 1.62
const TALL_BONES = { hips: { x: 0, y: 0.92 }, spine: { x: 0, y: 1.0 }, chest: { x: 0, y: 1.12 }, upperChest: { x: 0, y: 1.22 }, neck: { x: 0, y: 1.38 }, head: { x: 0, y: 1.45 } };
const TALL_BOX = { minX: -0.8, maxX: 0.8, minY: 0, maxY: 1.62 };

test('halfBodyBand: from the bones — head top to just above the hips, centred on the head–hips line', () => {
  for (const [bones, box] of [[TEST_BONES, TEST_BOX], [TALL_BONES, TALL_BOX]]) {
    const b = FR.halfBodyBand(bones, box);
    const torso = bones.head.y - bones.hips.y;
    assert.equal(b.source, 'bones');
    assert.ok(b.top > bones.head.y && b.top <= box.maxY, `top ${b.top} above the head bone, within the model`);
    assert.ok(near(b.bottom, bones.hips.y + torso * FR.HALF.waist), `the cut at the waist: ${b.bottom}`);
    assert.ok(b.bottom > bones.hips.y && b.bottom < (bones.upperChest || bones.chest).y, 'between the hips and the chest');
    assert.ok(b.cut > 0.3 && b.cut < 0.6, `about half of her is shown: ${b.cut}`);
  }
  // her hair is the top (within reach of the head)
  assert.ok(near(FR.halfBodyBand(TALL_BONES, TALL_BOX).top, 1.62));
  // an antenna / raised prop far above her head does not shrink her: capped at headMax torso above the head bone
  const tall = FR.halfBodyBand(TALL_BONES, { ...TALL_BOX, maxY: 5 });
  assert.ok(near(tall.top, 1.45 + (1.45 - 0.92) * FR.HALF.headMax));
  // raised arms (or a prop) make the box taller than her head: the head's own top (headTop) decides
  const armsUp = FR.halfBodyBand(TALL_BONES, { ...TALL_BOX, maxY: 2.0 }, { head: { top: 1.62, minX: -0.12, maxX: 0.12 } });
  assert.ok(near(armsUp.top, 1.62), `top ${armsUp.top}`);
  assert.ok(near(armsUp.cut, (Math.min(2.0, 1.62 + ((1.62 - armsUp.bottom) * FR.HALF.margin) / (1 - FR.HALF.margin)) - armsUp.bottom) / 2.0));
  assert.ok(near(FR.halfBodyBand(TALL_BONES, TALL_BOX, { head: { top: NaN } }).top, 1.62), 'no headTop: the box');
  // a wide head (chibi hair) widens the view instead of being cropped at the sides
  const wide = FR.halfBodyBand(TALL_BONES, TALL_BOX, { head: { top: 1.62, minX: -0.5, maxX: 0.5 } });
  assert.ok(near(wide.width, 1));
  const cw = FR.cameraFor(wide, { mode: 'half', aspect: 332 / 452 });
  assert.ok(cw.visible * (332 / 452) >= 1 * FR.HALF.fitWidth - 1e-9, 'the head fits sideways');
  assert.ok(near(FR.cameraFor(wide, { mode: 'half', aspect: 332 / 452, maxVisible: 1.0 }).visible, Math.max(1.0, (wide.top - wide.bottom) / (1 - FR.HALF.margin))), 'never wider than the 全身 view');
  assert.ok(near(cw.y - cw.visible / 2, wide.bottom), 'still cut at the waist');
  // the band does not depend on the box's width (wide hair, a tail, a skirt): only on bones and her top
  assert.deepEqual(FR.halfBodyBand(TALL_BONES, { ...TALL_BOX, minX: -3, maxX: 1 }).bottom, FR.halfBodyBand(TALL_BONES, TALL_BOX).bottom);
  // centred on her, not on the box (a tail to one side moves the box, not her)
  assert.equal(FR.halfBodyBand({ ...TALL_BONES, hips: { x: 0.1, y: 0.92 }, head: { x: 0.1, y: 1.45 } }, { ...TALL_BOX, minX: -0.2, maxX: 2 }).cx, 0.1);
});

test('halfBodyBand: no head / hips bones → the top half of the bounding box; chest without hips still works', () => {
  for (const bones of [{}, null, { head: TALL_BONES.head }, { hips: TALL_BONES.hips }, { head: { x: NaN, y: 1 }, hips: TALL_BONES.hips }]) {
    const b = FR.halfBodyBand(bones, TALL_BOX);
    assert.equal(b.source, 'box', JSON.stringify(bones));
    assert.ok(near(b.top, 1.62));
    assert.ok(near(b.bottom, 1.62 - 1.62 * FR.HALF_BOX));
    assert.equal(b.cut, FR.HALF_BOX);
    assert.equal(b.cx, 0);
  }
  const noHips = FR.halfBodyBand({ head: TALL_BONES.head, chest: TALL_BONES.chest }, TALL_BOX);
  assert.equal(noHips.source, 'bones');
  assert.ok(noHips.bottom < TALL_BONES.chest.y);
});

// ---- the camera -------------------------------------------------------------------------------------------
test('cameraFor full: the same camera vrm.js always used (feet on the floor, vrm.height of the canvas)', () => {
  const fov = 22;
  const share = 0.8;
  const minY = 0;
  const h = 1.62;
  const c = FR.cameraFor({ top: minY + h, bottom: minY }, { fov, share, mode: 'full' });
  const visible = h / share;
  assert.ok(near(c.visible, visible));
  assert.ok(near(c.y, minY + visible * (0.5 - 0.005)));
  assert.ok(near(c.dist, visible / 2 / Math.tan((fov * Math.PI) / 180 / 2)));
});

test('cameraFor half: the band fills the canvas — cut on the bottom edge, a little air above her head, bigger than full', () => {
  const band = FR.halfBodyBand(TALL_BONES, TALL_BOX);
  const fov = 22;
  const half = FR.cameraFor(band, { fov, mode: 'half' });
  const full = FR.cameraFor({ top: 1.62, bottom: 0 }, { fov, share: 0.8, mode: 'full' });
  assert.ok(near(half.y - half.visible / 2, band.bottom), 'the canvas bottom edge is the cut');
  const air = (half.y + half.visible / 2 - band.top) / half.visible;
  assert.ok(near(air, FR.HALF.margin), `air above her head: ${air}`);
  assert.ok(half.dist < full.dist / 2, 'the camera comes much closer: she is drawn bigger in the same window');
  // her head is in the upper part of the picture, the cut at the bottom: the composition is head-and-shoulders over the waist
  const headAt = (half.y + half.visible / 2 - TALL_BONES.head.y) / half.visible;
  assert.ok(headAt > 0.15 && headAt < 0.4, `head bone ${headAt} from the top`);
});

test('blendCamera: a smooth glide between the two cameras, exact at both ends, never overshooting', () => {
  const a = { visible: 2, y: 0.8, dist: 5, x: 0 };
  const b = { visible: 0.8, y: 1.3, dist: 2, x: 0.05 };
  assert.deepEqual(FR.blendCamera(a, b, 0), a);
  assert.deepEqual(FR.blendCamera(a, b, 1), b);
  assert.deepEqual(FR.blendCamera(a, b, 2), b);
  let prev = a.dist;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const c = FR.blendCamera(a, b, t);
    assert.ok(c.dist <= prev + 1e-12 && c.dist >= b.dist - 1e-12, `monotonic at ${t}`);
    prev = c.dist;
  }
  // eased: the first and the last step are the smallest (no jump at the start or the end)
  const step = (t0, t1) => FR.blendCamera(a, b, t0).dist - FR.blendCamera(a, b, t1).dist;
  assert.ok(step(0, 0.05) < step(0.45, 0.5));
  assert.ok(step(0.95, 1) < step(0.45, 0.5));
});

// ---- touch zones on the half-body picture -------------------------------------------------------------------
test('toFullBody: a click on the half-body picture lands on the same part of her; legs and feet are out of reach', () => {
  const band = FR.halfBodyBand(TALL_BONES, TALL_BOX);
  const half = { mode: 'half', cut: band.cut };
  const zone = (x, y) => TZ.zoneAt(x, FR.toFullBody({ x, y }, half).y);
  assert.equal(zone(0.5, 0.02), 'head');
  assert.equal(zone(0.5, 0.25), 'face');
  // every y of the half-body picture maps above the cut: never legs or feet
  const seen = new Set();
  for (let y = 0; y <= 1.0001; y += 0.01) for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) { const z = zone(x, Math.min(1, y)); if (z) seen.add(z); }
  assert.ok(!seen.has('legs') && !seen.has('feet'), [...seen].join(','));
  assert.ok(seen.has('chest') && seen.has('belly') && seen.has('hands'), [...seen].join(','));
  // full framing: unchanged
  assert.deepEqual(FR.toFullBody({ x: 0.5, y: 0.9 }, { mode: 'full', cut: 1 }), { x: 0.5, y: 0.9 });
  assert.deepEqual(FR.toFullBody({ x: 0.5, y: 0.9 }, null), { x: 0.5, y: 0.9 });
  assert.equal(TZ.zoneAt(0.5, 0.7), 'legs', 'in full framing the bottom of the picture is her legs');
  assert.notEqual(zone(0.5, 0.97), 'legs', 'in half framing the bottom of the picture is her waist, not her legs');
});

// ---- PetService: the setters the pet window and the settings window use -------------------------------------
test('PetService: 取景 set globally (set-prefs / admin-set) and per character (set-framing), broadcast at once, kept on disk', async () => {
  const { PetService } = require('../src/main/pet-service');
  const { LhClient, cleanEnv } = require('../src/core/lh-client');
  const { Store } = require('../src/core/store');
  const { createAdminSettings } = require('../src/main/admin-settings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-framing-svc-'));
  fs.writeFileSync(path.join(dir, 'loggedin'), '1');
  const lh = new LhClient({ bin: path.join(__dirname, 'fixtures', 'fake-lh.js'), env: { ...cleanEnv(), FAKE_LH_DIR: dir } });
  const data = path.join(dir, 'data');
  const mk = () => { const s = new PetService({ lh, store: new Store(data), settingsStore: new settingsLib.SettingsStore(data), now: () => Date.now(), rnd: () => 0.5 }); s.on('error', () => {}); return s; };
  const svc = mk();
  await svc.hatch({ speciesId: 'dafeiyu', name: '小鱼' });
  const sent = [];
  svc.on('settings', (st) => sent.push(st.prefs.framing + '/' + JSON.stringify(st.framings)));
  // the settings window: 桌宠行为 → 取景 → 半身
  const admin = createAdminSettings({ service: svc });
  const r = await admin.set('prefs.framing', 'half');
  assert.equal(r.ok, true);
  assert.equal(r.value, 'half');
  assert.equal(svc.settings.prefs.framing, 'half');
  assert.equal((await admin.set('prefs.framing', 'bust')).ok, false);
  // the pet window's own set-prefs (booleans as before, the framing string too)
  assert.equal(svc.setPrefs({ framing: 'full', roam: false }).settings.prefs.framing, 'full');
  assert.equal(svc.settings.prefs.roam, false);
  assert.equal(svc.setPrefs({ framing: 'bogus' }).settings.prefs.framing, 'full', 'an invalid value is not saved');
  svc.setPrefs({ framing: 'half' });
  // her page: 取景 for one character
  const f = svc.setFraming('full', 'dafeiyu');
  assert.equal(f.ok, true);
  assert.deepEqual(svc.settings.framings, { dafeiyu: 'full' });
  assert.equal(f.view.characters.find((c) => c.id === 'dafeiyu').framing, 'full');
  assert.equal(f.view.characters.find((c) => c.id === 'claude').framing, 'auto');
  assert.equal(svc.setFraming('half', 'nobody').ok, false);
  assert.equal(svc.setFraming('bust', 'claude').ok, false);
  svc.setFraming('half', 'claude');
  svc.setFraming('auto', 'dafeiyu');
  assert.deepEqual(svc.settings.framings, { claude: 'half' });
  assert.ok(sent.length >= 5, `every change is broadcast to the windows: ${sent.join(' ')}`);
  // a restart: a new service on the same data dir
  const again = mk();
  assert.equal(again.settings.prefs.framing, 'half');
  assert.deepEqual(again.settings.framings, { claude: 'half' });
});
