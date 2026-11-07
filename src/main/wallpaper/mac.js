'use strict';
// 桌面壁纸 · macOS (docs/wallpaper-mode.md §1.2). BrowserWindow({ type: 'desktop' }) sits at kCGDesktopWindowLevel - 1,
// under Finder's desktop icons (kCGDesktopIconWindowLevel), and a desktop-level window never becomes key or main:
// no focus, no keyboard, no mouse. On every Space (setVisibleOnAllWorkspaces), not in full-screen apps' Spaces.
//
// Self-check, a second after entering: JXA reads CGWindowListCopyWindowInfo (the layer is readable without the
// screen-recording permission) and compares our window's kCGWindowLayer with Finder's desktop-icon window. Not below
// it, or 壁纸类型 = 静态: a still picture of her becomes the desktop picture (NSWorkspace setDesktopImageURL), the one
// before is restored on exit. All through `run` (exec.js) — the tests hand in a fake osascript.
//
// NOT VERIFIED ON A REAL MAC (docs §6.2 M1–M3): the level against Finder icons, Spaces / Mission Control / Stage
// Manager, 「点按墙纸显示桌面」, the JXA layer read-out and the NSWorkspace calls. The tests check the commands sent.
const { run: realRun } = require('./exec');

const TITLE = 'pixel-pet-wallpaper';
// kCGDesktopWindowLevel (-2147483623) and kCGDesktopIconWindowLevel (-2147483603): CGWindowLevelForKey on macOS 12–15
const DESKTOP_LEVEL = -2147483623;
const ICON_LEVEL = -2147483603;

// JXA: our windows (owner pid, name starts with TITLE) and Finder's desktop windows, with their layers → JSON
const LAYER_SCRIPT = (pid) => `ObjC.import('CoreGraphics');
var list = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)) || [];
var ours = [], finder = [];
list.forEach(function (w) {
  if (w.kCGWindowOwnerPID === ${Number(pid)} && String(w.kCGWindowName || '').indexOf('${TITLE}') === 0) ours.push({ name: w.kCGWindowName, layer: w.kCGWindowLayer });
  if (w.kCGWindowOwnerName === 'Finder' && w.kCGWindowLayer < 0) finder.push({ layer: w.kCGWindowLayer });
});
JSON.stringify({ ours: ours, finder: finder });`;
// JXA: every screen's desktop picture now → JSON [url…]
const GET_DESKTOP = `ObjC.import('AppKit');
var ws = $.NSWorkspace.sharedWorkspace, out = [];
var screens = $.NSScreen.screens; for (var i = 0; i < screens.count; i++) { var u = ws.desktopImageURLForScreen(screens.objectAtIndex(i)); out.push(u ? u.path.js : null); }
JSON.stringify(out);`;
// JXA: set every screen's picture (one file for all, or one per screen) → 'ok'
const SET_DESKTOP = (files) => `ObjC.import('AppKit');
var ws = $.NSWorkspace.sharedWorkspace, files = ${JSON.stringify(files)};
var screens = $.NSScreen.screens; for (var i = 0; i < screens.count; i++) { var f = files[Math.min(i, files.length - 1)]; if (!f) continue;
  ws.setDesktopImageURLForScreenOptionsError($.NSURL.fileURLWithPath(f), screens.objectAtIndex(i), $({}), null); }
'ok';`;

function createMacBackend({ run = realRun, pid = process.pid, log = () => {} } = {}) {
  let saved = null; // [path…] per screen, before static mode

  async function availability({ mode = 'live' } = {}) {
    return { ok: true, mode: mode === 'static' ? 'static' : 'live', session: 'quartz' };
  }
  function windowOptions(display) {
    const b = display.bounds;
    return { type: 'desktop', x: b.x, y: b.y, width: b.width, height: b.height, frame: false, focusable: false, hasShadow: false, enableLargerThanScreen: true, resizable: false, show: false, backgroundColor: '#000000', title: `${TITLE}-${display.id}` };
  }
  async function attach(win, display) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.setIgnoreMouseEvents(true);
    win.showInactive();
    win.setBounds(display.bounds);
    return { ok: true, layout: 'desktop-level' };
  }
  async function place(win, display) { win.setBounds(display.bounds); return { ok: true }; }
  async function detach() { return { ok: true }; }
  async function status(win) { return { ok: true, attached: !win.isDestroyed() && win.isVisible() }; }

  // → { ok, layer, iconLayer, below } — below Finder's icons (or the documented levels when Finder has none listed)
  async function probe() {
    const r = await run('osascript', ['-l', 'JavaScript', '-e', LAYER_SCRIPT(pid)]);
    if (!r.ok) return { ok: false, reason: 'osascript-failed', err: r.err.slice(0, 200) };
    let j;
    try { j = JSON.parse(r.out.trim()); } catch { return { ok: false, reason: 'bad-output' }; }
    const layer = j.ours && j.ours.length ? Math.max(...j.ours.map((w) => w.layer)) : null;
    const iconLayer = j.finder && j.finder.length ? Math.min(...j.finder.map((w) => w.layer)) : ICON_LEVEL;
    return { ok: layer !== null, layer, iconLayer, desktopLevel: DESKTOP_LEVEL, below: layer !== null && layer < iconLayer, windows: (j.ours || []).length };
  }
  async function selfCheck() {
    const p = await probe();
    // osascript itself unavailable (sandboxed / blocked): trust Electron's documented level, but say so
    if (!p.ok && p.reason === 'osascript-failed') return { ok: true, probe: p, unverified: true };
    return { ok: !!p.below, probe: p, reason: p.below ? null : 'self-check-failed' };
  }

  async function setStatic(png) {
    if (!saved) {
      const g = await run('osascript', ['-l', 'JavaScript', '-e', GET_DESKTOP]);
      try { saved = g.ok ? JSON.parse(g.out.trim()) : []; } catch { saved = []; }
    }
    const r = await run('osascript', ['-l', 'JavaScript', '-e', SET_DESKTOP([png])]);
    return { ok: r.ok, kind: 'nsworkspace', reason: r.ok ? null : 'static-failed' };
  }
  async function restoreStatic() {
    if (!saved) return { ok: true, restored: false };
    const files = saved.filter(Boolean);
    saved = null;
    if (files.length) await run('osascript', ['-l', 'JavaScript', '-e', SET_DESKTOP(files)]);
    return { ok: true, restored: files.length > 0 };
  }

  return { platform: 'darwin', session: 'quartz', availability, windowOptions, attach, place, detach, status, probe, selfCheck, covered: async () => null, otherDesktopWindows: async () => [], setStatic, restoreStatic, on: () => {}, dispose: () => {} };
}

module.exports = { createMacBackend, TITLE, DESKTOP_LEVEL, ICON_LEVEL, LAYER_SCRIPT, SET_DESKTOP, GET_DESKTOP };
