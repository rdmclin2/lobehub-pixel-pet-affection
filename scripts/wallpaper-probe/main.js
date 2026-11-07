'use strict';
// 壁纸模式 · Linux X11 可行性探针 (docs/wallpaper-mode.md §6). Not app code: a standalone Electron main that checks,
// on a real X server + window manager, the Linux choices the design makes:
//   P1  BrowserWindow type:'desktop' → _NET_WM_WINDOW_TYPE_DESKTOP on the X window
//   P2  stacking: the wallpaper stays below a normal window, also after it is asked to be raised / activated
//   P3  input: setIgnoreMouseEvents(true) → a click on the wallpaper does not reach it; the normal window still gets its own
//   P4  focus: clicking the wallpaper never makes it the active window (_NET_ACTIVE_WINDOW)
//   P8  why not focusable:false on Linux: Chromium then makes an override-redirect window, the WM never manages it,
//       the DESKTOP type is ignored and it maps on top of everything (recorded, so the design keeps focusable on Linux)
//   P5  frame budget: the page's ticker can be capped (30 → 15 fps) and paused (0 fps) from main
//   P6  display change: screen 'display-metrics-changed' → the wallpaper is re-fitted to the new size
//   P0  no EWMH window manager (_NET_SUPPORTING_WM_CHECK missing) → detected, so the app can refuse wallpaper mode
// Run: xvfb-run -a -s "-screen 0 1280x800x24" sh -c 'openbox & sleep 1; npx electron scripts/wallpaper-probe/main.js'
// Writes out/wallpaper-probe/result.json and screenshots (ImageMagick `import`).
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, screen } = require('electron');

const OUT = path.join(__dirname, '..', '..', 'out', 'wallpaper-probe');
fs.mkdirSync(OUT, { recursive: true });
const R = path.join(__dirname, '..', '..', 'src', 'renderer');
const BG = '../../src/renderer/catalog/games/pixel-yard.webp'; // relative to out/wallpaper-probe/
const PET = '../../src/renderer/packs/claude-pixel/avatar.webp';
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim(); } catch (e) { return `ERR ${e.message.split('\n')[0]}`; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const xid = (w) => w.getNativeWindowHandle().readUInt32LE(0);
const hex = (n) => `0x${n.toString(16)}`;
// what is on screen at (x, y): the root's pixel (ImageMagick), '#rrggbb'
const pixelAt = (x, y) => { const t = sh('import', ['-window', 'root', '-crop', `1x1+${x}+${y}`, 'txt:-']); const m = t.match(/#[0-9A-F]{6}/i); return m ? m[0].toUpperCase() : t; };
const override = (id) => (sh('xwininfo', ['-id', hex(id)]).match(/Override Redirect State: (\w+)/) || [])[1];
const active = () => { const m = sh('xprop', ['-root', '_NET_ACTIVE_WINDOW']).match(/0x[0-9a-f]+/); return m ? parseInt(m[0], 16) : 0; };
const shot = (name) => sh('import', ['-window', 'root', path.join(OUT, `${name}.png`)]);
const log = [];
// ok: true / false, or 'skip' (this X server cannot stage the step; it is a real-machine check)
const step = (id, ok, detail) => { log.push({ id, ok, ...detail }); console.log(`${ok === 'skip' ? 'SKIP' : ok ? 'PASS' : 'FAIL'} ${id} ${JSON.stringify(detail)}`); };
const CAN_RESIZE = process.env.PROBE_XSERVER === 'xvnc'; // Xvfb has one fixed RandR mode

const WALL = `<!doctype html><meta charset=utf-8><style>
html,body{margin:0;height:100%;overflow:hidden;background:#0b0f0c url('${BG}') center/cover}
#pet{position:absolute;width:120px;image-rendering:pixelated;bottom:80px;left:100px}
#hud{position:absolute;left:12px;top:12px;font:14px monospace;color:#fff;background:#0008;padding:6px 10px;border-radius:6px}
</style><img id=pet src='${PET}'><div id=hud>壁纸层 · type:desktop</div><script>
window.__clicks=0; window.__frames=0; window.__fps=30; let last=0, x=100, dir=1;
addEventListener('mousedown',()=>window.__clicks++);
function tick(t){ requestAnimationFrame(tick); if(!window.__fps) return; if(t-last<1000/window.__fps-1) return; last=t; window.__frames++;
  x+=dir*3; if(x>innerWidth-220||x<40) dir*=-1; pet.style.left=x+'px'; pet.style.transform='scaleX('+dir+')';
  hud.textContent='壁纸层 · type:desktop · '+innerWidth+'×'+innerHeight+' · fps cap '+window.__fps+' · clicks '+window.__clicks; }
requestAnimationFrame(tick);
</script>`;
const NORMAL = `<!doctype html><meta charset=utf-8><body style="margin:0;font:16px sans-serif;background:#fff;padding:16px">
<h3 style=margin:0>普通应用窗口</h3><p>壁纸应始终在我下面。</p><p id=c>clicks 0</p>
<script>window.__clicks=0;addEventListener('mousedown',()=>{window.__clicks++;c.textContent='clicks '+window.__clicks})</script>`;

// the pages are written next to the results and loaded with loadFile, so the pictures (file://) load
const page = (name, html) => { const f = path.join(OUT, `${name}.html`); fs.writeFileSync(f, html); return f; };
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const wm = sh('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']);
  const hasWm = /window id/.test(wm);
  step('P0-ewmh-wm', true, { hasWm, raw: wm });
  const d = screen.getPrimaryDisplay();
  // Linux: no focusable:false (see P8); the WM keeps a DESKTOP window unfocused and below
  const wall = new BrowserWindow({ type: 'desktop', x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false, skipTaskbar: true, resizable: false, show: false, backgroundColor: '#0b0f0c', title: 'pixel-pet-wallpaper' });
  await wall.loadFile(page('wall', WALL));
  wall.setIgnoreMouseEvents(true);
  wall.showInactive();
  const normal = new BrowserWindow({ x: 420, y: 220, width: 420, height: 260, title: '普通应用窗口', show: false });
  await normal.loadFile(page('normal', NORMAL));
  normal.show(); normal.focus();
  await wait(1500);
  const W = xid(wall); const N = xid(normal);
  // the WM may reparent; the client window id is what _NET_CLIENT_LIST_STACKING lists
  const type = sh('xprop', ['-id', hex(W), '_NET_WM_WINDOW_TYPE']);
  step('P1-window-type', /_NET_WM_WINDOW_TYPE_DESKTOP/.test(type) && override(W) === 'no', { wall: hex(W), raw: type, overrideRedirect: override(W) });
  if (!hasWm) { fs.writeFileSync(path.join(OUT, 'result-nowm.json'), JSON.stringify({ hasWm, type, overrideRedirect: override(W), meaning: 'no EWMH WM: nothing keeps a DESKTOP window below — the app refuses wallpaper mode (reason no-wm)' }, null, 2)); shot('p0-no-wm'); app.exit(0); return; }

  // the normal window's page is white (#FFFFFF): its centre shows white only when it is above the wallpaper
  const NX = 630; const NY = 400;
  let st = sh('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']);
  let px = pixelAt(NX, NY);
  step('P2a-below-normal', px === '#FFFFFF' && /0x[0-9a-f]+.*0x[0-9a-f]+/.test(st) && st.indexOf(hex(W)) < st.indexOf(hex(N)), { pixelAtNormalCentre: px, netClientListStacking_bottomToTop: st, wall: hex(W), normal: hex(N) });
  shot('p2-wallpaper-below-normal');
  wall.moveTop(); sh('wmctrl', ['-i', '-r', hex(W), '-b', 'add,above']); sh('wmctrl', ['-i', '-a', hex(W)]); sh('xdotool', ['windowraise', String(W)]);
  await wait(800);
  st = sh('xprop', ['-root', '_NET_CLIENT_LIST_STACKING']); px = pixelAt(NX, NY);
  step('P2b-still-below-after-raise', px === '#FFFFFF' && st.indexOf(hex(W)) < st.indexOf(hex(N)), { tried: 'moveTop + wmctrl add,above + wmctrl -a + xdotool windowraise', pixelAtNormalCentre: px, netClientListStacking_bottomToTop: st, activeAfter: hex(active()) });
  shot('p2b-after-raise-attempts');

  // P3/P4: click on the wallpaper (outside the normal window), then inside the normal window
  normal.focus(); await wait(300);
  const before = active();
  sh('xdotool', ['mousemove', '150', '700', 'click', '1']); await wait(500);
  const wc = await wall.webContents.executeJavaScript('window.__clicks');
  const afterWallClick = active();
  sh('xdotool', ['mousemove', '600', '400', 'click', '1']); await wait(500);
  const nc = await normal.webContents.executeJavaScript('window.__clicks');
  shot('p3-after-clicks');
  step('P3-click-through', wc === 0 && nc === 1, { wallpaperClicks: wc, normalClicks: nc });
  step('P4-no-focus-steal', afterWallClick !== W && pixelAt(NX, NY) === '#FFFFFF', { activeBefore: hex(before), activeAfterWallpaperClick: hex(afterWallClick), wall: hex(W) });
  // contrast: with input on, the same click reaches the wallpaper (so P3 is the ignore flag, not luck)
  wall.setIgnoreMouseEvents(false); sh('xdotool', ['mousemove', '150', '700', 'click', '1']); await wait(500);
  const wc2 = await wall.webContents.executeJavaScript('window.__clicks'); wall.setIgnoreMouseEvents(true);
  step('P3b-control-input-on', wc2 >= 1, { wallpaperClicksWithInputOn: wc2, activeAfter: hex(active()) });

  // P5: frame budget
  const frames = async (fps, ms = 2000) => { await wall.webContents.executeJavaScript(`window.__fps=${fps};window.__frames=0`); await wait(ms); return wall.webContents.executeJavaScript('window.__frames'); };
  const f30 = await frames(30); const f15 = await frames(15); const f0 = await frames(0);
  step('P5-frame-budget', f30 > f15 && f15 > 0 && f0 === 0, { framesIn2s: { cap30: f30, cap15: f15, paused: f0 } });
  await wall.webContents.executeJavaScript('window.__fps=30');

  // P8: the same window with focusable:false (what macOS / Windows use) — on X11 it turns override-redirect
  const bad = new BrowserWindow({ type: 'desktop', x: 0, y: 0, width: 900, height: 600, frame: false, focusable: false, skipTaskbar: true, show: false, backgroundColor: '#ff00ff' });
  await bad.loadURL('about:blank'); bad.showInactive(); await wait(800);
  const B = xid(bad); const bpx = pixelAt(NX, NY);
  step('P8-focusable-false-is-override-redirect', override(B) === 'yes' && bpx !== '#FFFFFF', { overrideRedirect: override(B), pixelAtNormalCentre: bpx, meaning: 'not white = the focusable:false desktop window covers the normal window' });
  shot('p8-focusable-false-covers-normal');
  bad.destroy(); await wait(300);

  // P6: resolution change
  if (!CAN_RESIZE) { step('P6-display-change', 'skip', { why: 'Xvfb has a single fixed RandR mode; run with PROBE_XSERVER=xvnc' }); step('P7-multi-monitor', 'skip', { why: 'see the Xvnc run' }); fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ electron: process.versions.electron, wm: sh('wmctrl', ['-m']), steps: log }, null, 2)); app.exit(log.every((x) => x.ok) ? 0 : 1); return; }
  let changed = null;
  screen.on('display-metrics-changed', (_e, disp) => { changed = disp.bounds; wall.setBounds(disp.bounds); });
  const xr = sh('xrandr', ['-s', '1024x768']);  // Xvfb has one fixed mode: run this step on Xvnc (TigerVNC)
  await wait(1500);
  const wb = wall.getBounds();
  step('P6-display-change', !!changed && wb.width === changed.width && wb.height === changed.height, { xrandr: xr || 'ok', event: changed, wallBounds: wb, xwin: sh('xwininfo', ['-id', hex(W)]).split('\n').filter((l) => /Width|Height/.test(l)).map((l) => l.trim()) });
  shot('p6-after-resolution-change');
  sh('xrandr', ['-s', '1280x800']); await wait(1200);
  // P7: a second monitor appears (xrandr --setmonitor splits the screen into two logical monitors)
  let added = 0;
  screen.on('display-added', () => { added++; });
  const sm = [sh('xrandr', ['--setmonitor', 'L', '640/0x800/0+0+0', 'none']), sh('xrandr', ['--setmonitor', 'R', '640/0x800/0+640+0', 'none'])];
  await wait(1500);
  const ds = screen.getAllDisplays().map((x) => x.bounds);
  const per = ds.map((b) => { const w = new BrowserWindow({ type: 'desktop', ...b, frame: false, skipTaskbar: true, show: false, backgroundColor: '#0b0f0c' }); w.loadFile(path.join(OUT, 'wall.html')); w.showInactive(); return w; });
  await wait(1500);
  step('P7-multi-monitor', ds.length === 2 ? true : 'skip', { why: ds.length === 2 ? undefined : 'Chromium reads RandR outputs, not xrandr --setmonitor logical monitors; neither Xvfb (+xinerama) nor Xvnc gives it a second output here → real-machine check', setmonitor: sm, displayAddedEvents: added, displays: ds, perDisplayWallpapers: per.map((w) => w.getBounds()) });
  if (ds.length === 2) { wall.hide(); await wait(500); shot('p7-two-monitors'); }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ electron: process.versions.electron, wm: sh('wmctrl', ['-m']), steps: log }, null, 2));
  app.exit(log.every((x) => x.ok) ? 0 : 1);
});
