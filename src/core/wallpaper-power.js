'use strict';
// 桌面壁纸 · 帧率策略 (docs/wallpaper-mode.md §2.4). Every signal main knows about, folded into the one frame cap the
// wallpaper page runs at (Pixi ticker.maxFPS; 0 = ticker stopped, the last frame stays on screen):
//
//   normal                              min(settings.wallpaper.fps, pack.power.fps)          default 30
//   on battery                          min(that, settings.wallpaper.batteryFps)             default 10
//   covered (fullscreen app / page      0 while settings.wallpaper.pauseWhenCovered          (helper `occluded`,
//     hidden / minimised / blurred-     is on                                                 page visibility,
//     and-covered)                                                                            xprop fullscreen)
//   locked / suspended / display off    0
//   she is in a mini game               0
//   she was called out (the pet window  min(normal, OUT_FPS): the wallpaper keeps moving behind the windows, slower
//     is on the desktop)
//   software rendering (no GPU: the     min(that, SOFTWARE_FPS), and the page draws at SOFTWARE_SCALE of the screen's
//     page's WebGL renderer is           pixels (renderPlan) — every pixel is drawn by the CPU there (SwiftShader: a
//     SwiftShader / llvmpipe …)          24 fps wallpaper took ~4 cores, T-13654 D3). A real GPU keeps the full rate
//                                        and resolution; battery / covered / … still apply on top in both cases
//
// Pure: main passes the signals in, the tests pass made-up ones.

const DEFAULT_FPS = 30;
const DEFAULT_BATTERY_FPS = 10;
const OUT_FPS = 15;
const MAX_FPS = 30;
const SOFTWARE_FPS = 10;
const SOFTWARE_SCALE = 0.5;

// the page's WebGL renderer string (WEBGL_debug_renderer_info) → drawn by the CPU? Chromium's SwiftShader (no GPU,
// GPU blocklisted, 硬件加速 off), Mesa llvmpipe / softpipe / lavapipe, Windows' Basic Render Driver, Apple's software
// renderer. Anything else (a real GPU, or a string we cannot read) counts as hardware.
const SOFTWARE_RE = /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render driver/i;
const isSoftwareRenderer = (renderer) => typeof renderer === 'string' && SOFTWARE_RE.test(renderer);

// how the page draws: { software, scale } — scale is the renderer's resolution (1 = every screen pixel)
function renderPlan(renderer) {
  const software = isSoftwareRenderer(renderer);
  return { software, scale: software ? SOFTWARE_SCALE : 1 };
}

const clampFps = (v, d) => (Number.isFinite(v) ? Math.max(0, Math.min(MAX_FPS, Math.round(v))) : d);

// signals: { onBattery, covered: bool | { [displayId]: bool }, locked, suspended, inGame, out, software, displayId }
// prefs:   settings.wallpaper ({ fps, batteryFps, pauseWhenCovered }); pack: the manifest's power ({ fps })
// → { fps, why } — why names the strongest reason (for the e2e and the debug read-out)
function frameRate(signals = {}, prefs = {}, pack = {}) {
  const want = Math.min(clampFps(prefs.fps, DEFAULT_FPS) || DEFAULT_FPS, clampFps(pack && pack.fps, MAX_FPS) || MAX_FPS);
  if (signals.suspended) return { fps: 0, why: 'suspended' };
  if (signals.locked) return { fps: 0, why: 'locked' };
  if (signals.inGame) return { fps: 0, why: 'game' };
  const covered = typeof signals.covered === 'object' && signals.covered !== null
    ? !!signals.covered[String(signals.displayId)]
    : !!signals.covered;
  if (covered && prefs.pauseWhenCovered !== false) return { fps: 0, why: 'covered' };
  let fps = want;
  let why = 'normal';
  if (signals.onBattery) {
    const b = clampFps(prefs.batteryFps, DEFAULT_BATTERY_FPS);
    if (b < fps) { fps = b; why = 'battery'; }
  }
  if (signals.out && OUT_FPS < fps) { fps = OUT_FPS; why = signals.onBattery && why === 'battery' ? why : 'out'; }
  if (signals.software && SOFTWARE_FPS < fps) { fps = SOFTWARE_FPS; why = 'software'; }
  return { fps, why };
}

// one fps per wallpaper window (each display may be covered on its own)
function frameRates(displayIds, signals, prefs, pack) {
  return Object.fromEntries(displayIds.map((id) => [String(id), frameRate({ ...signals, displayId: id }, prefs, pack)]));
}

module.exports = { DEFAULT_FPS, DEFAULT_BATTERY_FPS, OUT_FPS, MAX_FPS, SOFTWARE_FPS, SOFTWARE_SCALE, isSoftwareRenderer, renderPlan, frameRate, frameRates };
