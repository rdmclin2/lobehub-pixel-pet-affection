'use strict';
// 桌面壁纸 · Linux (docs/wallpaper-mode.md §1.3, §1.4). Two very different desktops:
//
//   X11      BrowserWindow({ type: 'desktop' }) → _NET_WM_WINDOW_TYPE_DESKTOP, which an EWMH window manager keeps
//            below every normal window (probe P1/P2). NOT focusable:false: on X11 Chromium then makes an
//            override-redirect window that no WM manages and that maps on top of everything (probe P8). Clicks go
//            through with setIgnoreMouseEvents(true) (P3) and it never becomes the active window (P4). With no
//            EWMH WM (_NET_SUPPORTING_WM_CHECK missing, P0) nothing keeps it below → unavailable, reason `no-wm`.
//   Wayland  a client cannot put itself in the background layer (no layer-shell in Mutter, none in Electron) →
//            no live wallpaper. GNOME: gsettings picture-uri, KDE: plasma-apply-wallpaperimage — a still picture
//            of her (static mode); anything else: `wayland-unsupported`.
//
// probe(win) reads the real X state of the wallpaper window (xprop / xwininfo): its window type, _NET_WM_STATE,
// override-redirect, where it is in _NET_CLIENT_LIST_STACKING and whether its input shape is empty (click-through)
// — what the e2e asserts on. Every command goes through `run` (exec.js), so the tests hand in a fake X server.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run: realRun } = require('./exec');

const hex = (n) => `0x${Number(n).toString(16)}`;
const ids = (s) => (String(s).match(/0x[0-9a-f]+/gi) || []).map((x) => parseInt(x, 16));
const atoms = (s) => (String(s).split('=')[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
// the window's X input shape, read with XShapeGetRectangles through python3 + ctypes (no build step, no headers): the
// rectangles that take input. Chromium's setIgnoreMouseEvents(true) on X11 shrinks it to one 1×1 rectangle at the
// window's corner (X keeps at least that), so clicks anywhere else fall through to what is below; a window that takes
// input has its full size here. Only the e2e's probe asks (debug-wallpaper), never the normal path.
const SHAPE_PY = [
  'import ctypes, sys',
  'class R(ctypes.Structure): _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short), ("w", ctypes.c_ushort), ("h", ctypes.c_ushort)]',
  "x = ctypes.cdll.LoadLibrary('libX11.so.6'); e = ctypes.cdll.LoadLibrary('libXext.so.6')",
  'x.XOpenDisplay.restype = ctypes.c_void_p; e.XShapeGetRectangles.restype = ctypes.POINTER(R)',
  'e.XShapeGetRectangles.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]',
  'd = x.XOpenDisplay(None); w = int(sys.argv[1], 16)',
  "for k, name in ((0, 'bounding'), (2, 'input')):",
  "    n = ctypes.c_int(); o = ctypes.c_int(); p = e.XShapeGetRectangles(d, w, k, ctypes.byref(n), ctypes.byref(o))",
  "    print(name, ' '.join('%dx%d+%d+%d' % (p[i].w, p[i].h, p[i].x, p[i].y) for i in range(n.value)))",
].join('\n');
// '400x300+0+0 1x1+0+0' → [{ w, h, x, y }…]
const rects = (line) => (String(line || '').match(/\d+x\d+[+-]\d+[+-]\d+/g) || []).map((r) => { const m = r.match(/(\d+)x(\d+)([+-]\d+)([+-]\d+)/); return { w: +m[1], h: +m[2], x: +m[3], y: +m[4] }; });
const xidOf = (win) => { try { return win.getNativeWindowHandle().readUInt32LE(0); } catch { return 0; } };

function createLinuxBackend({ run = realRun, env = process.env, home = os.homedir(), log = () => {} } = {}) {
  const session = env.XDG_SESSION_TYPE === 'wayland' || (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11') ? 'wayland' : 'x11';
  const desktop = String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase();
  let saved = null; // the system wallpaper before static mode set ours: { kind: 'gnome', uri, dark } | { kind: 'kde', image }

  // → { ok, mode: 'live' | 'static', reason?, session, wm, staticKind? }
  async function availability({ mode = 'live' } = {}) {
    if (session === 'wayland') {
      const kind = await staticKind();
      if (!kind) return { ok: false, mode: 'static', reason: 'wayland-unsupported', session };
      return { ok: true, mode: 'static', session, staticKind: kind, forced: true };
    }
    const r = await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']);
    // no xprop on this system: assume a WM and let the self-check after entering decide
    const wm = r.missing ? 'unknown' : /window id/.test(r.out) ? 'ewmh' : 'none';
    if (wm === 'none') return { ok: false, mode: 'live', reason: 'no-wm', session, wm };
    if (mode === 'static') {
      const kind = await staticKind();
      return kind ? { ok: true, mode: 'static', session, wm, staticKind: kind } : { ok: true, mode: 'live', session, wm, note: 'static-unavailable' };
    }
    return { ok: true, mode: 'live', session, wm };
  }

  async function staticKind() {
    if (/kde|plasma/.test(desktop) && !(await run('plasma-apply-wallpaperimage', ['--help'])).missing) return 'kde';
    const g = await run('gsettings', ['get', 'org.gnome.desktop.background', 'picture-uri']);
    if (g.ok) return 'gnome';
    return null;
  }

  // the BrowserWindow for one display (the design's options; see the top for why not focusable:false)
  function windowOptions(display) {
    const b = display.bounds;
    return { type: 'desktop', x: b.x, y: b.y, width: b.width, height: b.height, frame: false, skipTaskbar: true, resizable: false, show: false, backgroundColor: '#000000', hasShadow: false };
  }

  // shown without taking focus, clicks go through, then sized again (openbox makes it 1 px short at first)
  async function attach(win, display) {
    win.setIgnoreMouseEvents(true);
    win.showInactive();
    win.setBounds(display.bounds);
    return { ok: true, layout: 'x11-desktop', xid: hex(xidOf(win)) };
  }
  async function place(win, display) { win.setBounds(display.bounds); return { ok: true }; }
  async function detach() { return { ok: true }; }

  // the real X state of one window
  async function probe(win, { shape: withShape = false } = {}) {
    const xid = xidOf(win);
    if (!xid) return { ok: false, reason: 'no-xid' };
    const [type, state, info, shape, stacking, active] = await Promise.all([
      run('xprop', ['-id', hex(xid), '_NET_WM_WINDOW_TYPE']),
      run('xprop', ['-id', hex(xid), '_NET_WM_STATE']),
      run('xwininfo', ['-id', hex(xid)]),
      withShape ? run('python3', ['-c', SHAPE_PY, hex(xid)]) : Promise.resolve({ ok: false, out: '' }),
      run('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']),
      run('xprop', ['-root', '_NET_ACTIVE_WINDOW']),
    ]);
    if (type.missing) return { ok: false, reason: 'no-xprop', xid: hex(xid) };
    const list = ids(stacking.out);
    const idx = list.indexOf(xid);
    // the input shape's area in px (≤ 1: Chromium's click-through) against the window's own (bounding) area
    const line = (k) => (shape.out.split('\n').find((l) => l.startsWith(`${k} `)) || '').slice(k.length + 1);
    const input = shape.ok ? rects(line('input')) : null;
    const inputArea = input ? input.reduce((a, r) => a + r.w * r.h, 0) : null;
    const windowArea = shape.ok ? rects(line('bounding')).reduce((a, r) => a + r.w * r.h, 0) : null;
    const activeId = ids(active.out)[0] || 0;
    return {
      ok: true,
      xid: hex(xid),
      windowType: atoms(type.out),
      wmState: atoms(state.out),
      overrideRedirect: (info.out.match(/Override Redirect State:\s*(\w+)/) || [])[1] || null,
      mapState: (info.out.match(/Map State:\s*(\w+)/) || [])[1] || null,
      geometry: (info.out.match(/-geometry\s+(\S+)/) || [])[1] || null,
      stacking: { index: idx, of: list.length, bottom: idx === 0, above: idx >= 0 ? list.slice(idx + 1).map(hex) : [] },
      inputShape: input ? input.map((r) => `${r.w}x${r.h}+${r.x}+${r.y}`) : null,
      inputArea,
      windowArea,
      clickThrough: inputArea === null ? null : inputArea <= 1,
      active: hex(activeId),
      isActive: activeId === xid,
    };
  }
  // the self-check after entering: a managed DESKTOP window, not override-redirect (no xprop: trust Electron)
  async function selfCheck(win) {
    const p = await probe(win);
    if (!p.ok) return { ok: p.reason === 'no-xprop', probe: p };
    const ok = p.windowType.includes('_NET_WM_WINDOW_TYPE_DESKTOP') && p.overrideRedirect === 'no';
    return { ok, probe: p, reason: ok ? null : 'self-check-failed' };
  }
  async function status(win) { return { ok: true, attached: !win.isDestroyed() && win.isVisible() }; }

  // other DESKTOP windows (the desktop environment's icons: DING, xfdesktop, pcmanfm, plasmashell) — the order of
  // two DESKTOP windows is the WM's choice, so the first entry warns once (docs §1.3)
  async function otherDesktopWindows(ours = []) {
    const r = await run('xprop', ['-root', '_NET_CLIENT_LIST']);
    if (!r.ok) return [];
    const mine = new Set(ours.map(xidOf));
    const out = [];
    for (const id of ids(r.out)) {
      if (mine.has(id)) continue;
      const t = await run('xprop', ['-id', hex(id), '_NET_WM_WINDOW_TYPE']);
      if (/_NET_WM_WINDOW_TYPE_DESKTOP/.test(t.out)) out.push(hex(id));
    }
    return out;
  }

  // covered: the active window is fullscreen (polled every 3 s by the host while xprop exists)
  async function covered() {
    const a = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW']);
    if (!a.ok) return null;
    const id = ids(a.out)[0];
    if (!id) return false;
    const s = await run('xprop', ['-id', hex(id), '_NET_WM_STATE']);
    return /_NET_WM_STATE_FULLSCREEN/.test(s.out);
  }

  // ---- static wallpaper (Wayland, or 壁纸类型 = 静态) ---------------------------------------------------------
  async function setStatic(png) {
    const kind = await staticKind();
    if (kind === 'kde') {
      if (!saved) saved = { kind, image: readKdeImage() };
      const r = await run('plasma-apply-wallpaperimage', [png]);
      return { ok: r.ok, kind, reason: r.ok ? null : 'static-failed' };
    }
    if (kind === 'gnome') {
      if (!saved) {
        const u = await run('gsettings', ['get', 'org.gnome.desktop.background', 'picture-uri']);
        const d = await run('gsettings', ['get', 'org.gnome.desktop.background', 'picture-uri-dark']);
        saved = { kind, uri: u.ok ? u.out.trim() : null, dark: d.ok ? d.out.trim() : null };
      }
      const uri = `file://${png}`;
      const r = await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', uri]);
      if (saved.dark !== null) await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri-dark', uri]);
      return { ok: r.ok, kind, reason: r.ok ? null : 'static-failed' };
    }
    return { ok: false, reason: session === 'wayland' ? 'wayland-unsupported' : 'static-failed' };
  }
  async function restoreStatic() {
    if (!saved) return { ok: true, restored: false };
    const s = saved;
    saved = null;
    const unq = (v) => String(v || '').replace(/^'(.*)'$/, '$1');
    if (s.kind === 'gnome') {
      if (s.uri) await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri', unq(s.uri)]);
      if (s.dark) await run('gsettings', ['set', 'org.gnome.desktop.background', 'picture-uri-dark', unq(s.dark)]);
    } else if (s.kind === 'kde' && s.image) await run('plasma-apply-wallpaperimage', [s.image]);
    return { ok: true, restored: true, kind: s.kind };
  }
  function readKdeImage() {
    try {
      const t = fs.readFileSync(path.join(home, '.config', 'plasma-org.kde.plasma.desktop-appletsrc'), 'utf8');
      const m = t.match(/^Image=(?:file:\/\/)?(.+)$/m);
      return m ? m[1].trim() : null;
    } catch { return null; }
  }

  return { platform: 'linux', session, availability, windowOptions, attach, place, detach, probe, selfCheck, status, otherDesktopWindows, covered, setStatic, restoreStatic, on: () => {}, dispose: () => {}, _saved: () => saved };
}

module.exports = { createLinuxBackend };
