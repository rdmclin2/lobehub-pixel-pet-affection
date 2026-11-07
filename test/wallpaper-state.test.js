'use strict';
// 桌面壁纸 · pure decisions (core/wallpaper-power.js, core/wallpaper-state.js): the frame rate from every signal, where
// she is, which windows a display change needs, screen ↔ picture mapping, the retry plan and the crash budget.
const test = require('node:test');
const assert = require('node:assert/strict');
const WPower = require('../src/core/wallpaper-power');
const WS = require('../src/core/wallpaper-state');

const prefs = { fps: 30, batteryFps: 10, pauseWhenCovered: true };

test('frame rate: normal = min(settings, pack); battery → batteryFps; covered / locked / suspended / in a game → 0; called out → 15', () => {
  assert.deepEqual(WPower.frameRate({}, prefs, { fps: 24 }), { fps: 24, why: 'normal' });
  assert.deepEqual(WPower.frameRate({}, { ...prefs, fps: 12 }, { fps: 24 }), { fps: 12, why: 'normal' });
  assert.deepEqual(WPower.frameRate({ onBattery: true }, prefs, { fps: 24 }), { fps: 10, why: 'battery' });
  assert.deepEqual(WPower.frameRate({ covered: true }, prefs, {}), { fps: 0, why: 'covered' });
  assert.deepEqual(WPower.frameRate({ covered: true }, { ...prefs, pauseWhenCovered: false }, {}), { fps: 30, why: 'normal' }, '被挡住时暂停 off: keeps drawing');
  assert.deepEqual(WPower.frameRate({ locked: true, onBattery: true }, prefs, {}), { fps: 0, why: 'locked' });
  assert.deepEqual(WPower.frameRate({ suspended: true }, prefs, {}), { fps: 0, why: 'suspended' });
  assert.deepEqual(WPower.frameRate({ inGame: true }, prefs, {}), { fps: 0, why: 'game' });
  assert.deepEqual(WPower.frameRate({ out: true }, prefs, {}), { fps: 15, why: 'out' });
  assert.deepEqual(WPower.frameRate({ out: true, onBattery: true }, prefs, {}), { fps: 10, why: 'battery' });
  // covered per display (the Windows helper says which monitor)
  const per = WPower.frameRates([1, 2], { covered: { 1: true } }, prefs, {});
  assert.deepEqual(per, { 1: { fps: 0, why: 'covered' }, 2: { fps: 30, why: 'normal' } });
  // nonsense settings fall back to the defaults, never above 30
  assert.equal(WPower.frameRate({}, { fps: 999 }, { fps: 999 }).fps, 30);
});

test('no GPU (T-13654 D3): a software WebGL renderer caps the frame rate at 10 and halves the resolution; battery / covered / game still apply on top; a GPU keeps 24 at full resolution', () => {
  const soft = 'ANGLE (Mesa; llvmpipe (LLVM 20.1.2 256 bits); OpenGL 4.5)';
  for (const r of [soft, 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'Google SwiftShader', 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Apple Software Renderer', 'softpipe', 'lavapipe']) {
    assert.equal(WPower.isSoftwareRenderer(r), true, r);
    assert.deepEqual(WPower.renderPlan(r), { software: true, scale: 0.5 }, r);
  }
  for (const r of ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', 'AMD Radeon RX 6600', '', null, undefined, 42]) {
    assert.equal(WPower.isSoftwareRenderer(r), false, String(r));
    assert.deepEqual(WPower.renderPlan(r), { software: false, scale: 1 }, String(r));
  }
  assert.deepEqual(WPower.frameRate({ software: true }, prefs, { fps: 24 }), { fps: 10, why: 'software' });
  assert.deepEqual(WPower.frameRate({ software: false }, prefs, { fps: 24 }), { fps: 24, why: 'normal' }, 'a GPU: the pack\'s 24');
  assert.deepEqual(WPower.frameRate({ software: true }, { ...prefs, fps: 6 }, { fps: 24 }), { fps: 6, why: 'normal' }, 'a lower 帧率上限 still wins');
  assert.deepEqual(WPower.frameRate({ software: true, onBattery: true }, { ...prefs, batteryFps: 5 }, { fps: 24 }), { fps: 5, why: 'battery' }, 'battery below the software cap');
  assert.deepEqual(WPower.frameRate({ software: true, onBattery: true }, prefs, { fps: 24 }), { fps: 10, why: 'battery' });
  assert.deepEqual(WPower.frameRate({ software: true, covered: true }, prefs, { fps: 24 }), { fps: 0, why: 'covered' });
  assert.deepEqual(WPower.frameRate({ software: true, inGame: true }, prefs, { fps: 24 }), { fps: 0, why: 'game' });
  assert.deepEqual(WPower.frameRate({ software: true, out: true }, prefs, { fps: 24 }), { fps: 10, why: 'software' });
});

test('the wallpaper\'s time of day is the computer clock (T-13654 D4): the mini games\' 24-minute day / fixed hour never reach it; the weather does', () => {
  const games = { followClock: false, dayFlow: true, hour: 8, weather: 'rain', autoWeather: false, game: 'yard' };
  assert.deepEqual(WS.wallpaperScene(games), { followClock: true, dayFlow: false, hour: 8, weather: 'rain' });
  assert.equal(WS.wallpaperScene({ followClock: false, dayFlow: false, hour: 3 }).followClock, true);
  assert.deepEqual(WS.wallpaperScene(null), { followClock: true, dayFlow: false, hour: 12, weather: 'clear' });
});

test('where she is: desktop → wallpaper → out → wallpaper; a game from wallpaper / out comes back into the wallpaper; exit from anywhere', () => {
  assert.deepEqual(WS.move('desktop', 'enter'), { ok: true, from: 'desktop', where: 'wallpaper', pet: 'hide', wall: 'open' });
  assert.deepEqual(WS.move('wallpaper', 'recall'), { ok: true, from: 'wallpaper', where: 'out', pet: 'show', wall: 'fade-out' });
  assert.deepEqual(WS.move('out', 'return'), { ok: true, from: 'out', where: 'wallpaper', pet: 'hide', wall: 'fade-in' });
  assert.equal(WS.move('wallpaper', 'game-open').where, 'game');
  assert.equal(WS.move('out', 'game-open').where, 'game');
  assert.deepEqual(WS.move('game', 'game-close'), { ok: true, from: 'game', where: 'wallpaper', pet: 'hide', wall: 'resume' });
  for (const w of ['wallpaper', 'out', 'game']) assert.equal(WS.move(w, 'exit').where, 'desktop');
  assert.equal(WS.move('desktop', 'recall').ok, false);
  assert.equal(WS.move('desktop', 'game-close').ok, false, 'a game closed without wallpaper mode: main shows her on the desktop');
  assert.equal(WS.move('wallpaper', 'dance').reason, 'unknown-action');
});

const D = (id, x, w = 1920, h = 1080) => ({ id, bounds: { x, y: 0, width: w, height: h }, workArea: { x, y: 0, width: w, height: h - 40 } });

test('reconcile: primary only or every display; added / removed / still there; her display gone → the primary', () => {
  const a = D(1, 0);
  const b = D(2, 1920);
  assert.deepEqual(WS.reconcile([a, b], [], { mode: 'primary', primaryId: 1 }).create.map((d) => d.id), [1]);
  const all = WS.reconcile([a, b], ['1'], { mode: 'all', primaryId: 1, petDisplay: 1 });
  assert.deepEqual(all.create.map((d) => d.id), [2]);
  assert.deepEqual(all.place.map((d) => d.id), [1]);
  assert.deepEqual(all.close, []);
  const unplugged = WS.reconcile([a], ['1', '2'], { mode: 'all', primaryId: 1, petDisplay: 2 });
  assert.deepEqual(unplugged.close, ['2']);
  assert.equal(unplugged.petDisplay, 1, 'she moves to the primary');
  const swapped = WS.reconcile([b], ['1'], { mode: 'primary', primaryId: 2, petDisplay: 1 });
  assert.deepEqual([swapped.create.map((d) => d.id), swapped.close, swapped.petDisplay], [[2], ['1'], 2]);
});

test('screen ↔ picture: cover crops around the focus, contain letterboxes; round trip; her window stays in the work area', () => {
  const canvas = { width: 1280, height: 720 };
  const d = D(1, 0, 1280, 800);
  const f = WS.fitCanvas(canvas, d.bounds, 'cover', [0.5, 0.7]);
  assert.ok(f.scale > 1 && f.x < 0 && f.y === 0, JSON.stringify(f));
  const p = [640, 600];
  const s = WS.canvasToScreen(p, d, canvas, 'cover', [0.5, 0.7]);
  const back = WS.screenToCanvas(s, d, canvas, 'cover', [0.5, 0.7]);
  assert.ok(Math.abs(back[0] - p[0]) < 1 && Math.abs(back[1] - p[1]) < 1, `${back}`);
  const c = WS.fitCanvas(canvas, d.bounds, 'contain');
  assert.ok(c.y > 0 && c.x === 0, 'bars top and bottom');
  // a display at x = 1920: absolute coordinates
  assert.equal(WS.canvasToScreen([0, 0], D(2, 1920, 1280, 720), canvas, 'cover')[0], 1920);
  assert.deepEqual(WS.petWindowAt([5, 790], { width: 200, height: 300 }, d.workArea), { x: 0, y: 460, width: 200, height: 300 });
  const clip = WS.walkClip(d, canvas, 'cover', [0.5, 0.7]);
  assert.ok(clip[3] < 720 && clip[0] > 0, `the taskbar and the cropped sides are cut off: ${clip}`);
});

test('recovery: retries after 0.5 / 1 / 2 / 4 / 8 s, never past 30 s; page crashes: 3 reloads in 10 minutes, then give up', () => {
  assert.deepEqual(WS.retryPlan(), [500, 1000, 2000, 4000, 8000]);
  assert.deepEqual(WS.retryPlan([10000, 10000, 10000, 10000]), [10000, 10000, 10000]);
  const b = WS.crashBudget();
  assert.deepEqual([b.hit(0), b.hit(1000), b.hit(2000), b.hit(3000)], [true, true, true, false]);
  assert.equal(b.hit(11 * 60 * 1000), true, 'the old crashes age out');
});

test('debounce: display events 500 ms apart collapse into one reconcile', () => {
  const timers = [];
  const setTimer = (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return t; };
  const clearTimer = (t) => { t.on = false; };
  let n = 0;
  const d = WS.debounce(() => { n += 1; }, 500, { setTimer, clearTimer });
  d(); d(); d();
  assert.equal(timers.filter((t) => t.on).length, 1);
  timers.filter((t) => t.on).forEach((t) => t.fn());
  assert.equal(n, 1);
});

test('every unavailable reason has the owner-facing words (docs §3.6)', () => {
  for (const r of ['helper-failed', 'helper-tampered', 'no-workerw', 'no-wm', 'wayland-unsupported', 'shell-restarted-failed']) assert.ok(WS.reasonText(r).length > 8, r);
  assert.match(WS.reasonText('no-wm'), /窗口管理器/);
});
