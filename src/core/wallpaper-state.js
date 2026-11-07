'use strict';
// 桌面壁纸 · 她在哪里、窗口怎么跟着显示器走、失败了怎么重试 (docs/wallpaper-mode.md §1.5, §2.2). Pure and Electron-free:
// src/main/wallpaper/host.js does what these decide, the tests check the decisions.
//
//   desktop ──设为壁纸──▶ wallpaper ──叫她出来──▶ out ──回到壁纸 / 5 分钟没理她──▶ wallpaper
//      ▲                     │  ▲                    │
//      └────退出壁纸─────────┘  └──小游戏关闭────── game ◀──打开小游戏──（wallpaper / out 都可以）

const WHERE = ['desktop', 'wallpaper', 'out', 'game'];

// action → the next place and what the host does about it:
//   pet:  'show' | 'hide' | null      her desktop window (main.js createWindow)
//   wall: 'open' | 'close' | 'fade-in' | 'fade-out' | 'pause' | 'resume' | null   the wallpaper windows
const MOVES = {
  enter: { desktop: ['wallpaper', 'hide', 'open'], out: ['wallpaper', 'hide', 'fade-in'], wallpaper: null, game: null },
  recall: { wallpaper: ['out', 'show', 'fade-out'], out: null, desktop: null, game: null },
  return: { out: ['wallpaper', 'hide', 'fade-in'], wallpaper: null, desktop: null, game: null },
  exit: { wallpaper: ['desktop', 'show', 'close'], out: ['desktop', 'show', 'close'], game: ['desktop', null, 'close'], desktop: null },
  'game-open': { wallpaper: ['game', null, 'pause'], out: ['game', null, 'pause'], desktop: null, game: null },
  // a mini game closed: back into the wallpaper (main.js shows her on the desktop otherwise)
  'game-close': { game: ['wallpaper', 'hide', 'resume'], desktop: null, wallpaper: null, out: null },
};

// → { ok, from, where, pet, wall } or { ok: false, reason: 'unknown-action' | 'nothing-to-do' }
function move(where, action) {
  const m = MOVES[action];
  if (!m) return { ok: false, reason: 'unknown-action', from: where, where };
  const to = m[WHERE.includes(where) ? where : 'desktop'];
  if (!to) return { ok: false, reason: 'nothing-to-do', from: where, where };
  return { ok: true, from: where, where: to[0], pet: to[1], wall: to[2] };
}

// ---- displays --------------------------------------------------------------------------------------------
// displays: [{ id, bounds, workArea }] (Electron screen.getAllDisplays()); open: ids with a wallpaper window now;
// mode: 'primary' | 'all'; petDisplay: the display she lives on (null: the primary).
// → { want: [ids], create: [display], close: [ids], place: [display], petDisplay }
function reconcile(displays, open, { mode = 'primary', primaryId = null, petDisplay = null } = {}) {
  const list = Array.isArray(displays) ? displays.filter((d) => d && d.bounds) : [];
  const primary = list.find((d) => d.id === primaryId) || list[0] || null;
  const wantDisplays = mode === 'all' ? list : primary ? [primary] : [];
  const want = wantDisplays.map((d) => d.id);
  const have = new Set((open || []).map(String));
  const create = wantDisplays.filter((d) => !have.has(String(d.id)));
  const close = [...have].filter((id) => !want.map(String).includes(id));
  const place = wantDisplays.filter((d) => have.has(String(d.id)));
  // she stays on her display while it is there (and has a wallpaper); else she moves to the primary
  const pd = petDisplay !== null && want.map(String).includes(String(petDisplay)) ? petDisplay : primary ? primary.id : null;
  return { want, create, close, place, petDisplay: pd };
}

// ---- where she is on the screen vs in the picture ----------------------------------------------------------
// the canvas (design size) laid onto a display's bounds, cover (crop) or contain (bars), around `focus`
// → { scale, x, y } so that screen = (canvas * scale) + (x, y) inside the display (display-relative px)
function fitCanvas(canvas, size, fit = 'cover', focus = [0.5, 0.5]) {
  const sx = size.width / canvas.width;
  const sy = size.height / canvas.height;
  const scale = fit === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  // cover: the overflow is cropped so that the focus point stays as central as it can
  const x = fit === 'contain' ? (size.width - w) / 2 : Math.min(0, Math.max(size.width - w, size.width / 2 - focus[0] * w));
  const y = fit === 'contain' ? (size.height - h) / 2 : Math.min(0, Math.max(size.height - h, size.height / 2 - focus[1] * h));
  return { scale, x, y };
}
// a screen point (absolute) → the canvas point under it
function screenToCanvas(pt, display, canvas, fit, focus) {
  const f = fitCanvas(canvas, display.bounds, fit, focus);
  return [(pt[0] - display.bounds.x - f.x) / f.scale, (pt[1] - display.bounds.y - f.y) / f.scale];
}
// a canvas point → the absolute screen point
function canvasToScreen(pt, display, canvas, fit, focus) {
  const f = fitCanvas(canvas, display.bounds, fit, focus);
  return [Math.round(display.bounds.x + f.x + pt[0] * f.scale), Math.round(display.bounds.y + f.y + pt[1] * f.scale)];
}
// her desktop window when she comes out: its bottom centre at her feet, kept inside the work area
function petWindowAt(feet, size, workArea) {
  const x = Math.round(Math.min(Math.max(feet[0] - size.width / 2, workArea.x), workArea.x + workArea.width - size.width));
  const y = Math.round(Math.min(Math.max(feet[1] - size.height, workArea.y), workArea.y + workArea.height - size.height));
  return { x, y, width: size.width, height: size.height };
}
// the part of the canvas she may walk in on this display: what is visible and not under the taskbar / Dock /
// menu bar (the work area), as a canvas rectangle [x0, y0, x1, y1]
function walkClip(display, canvas, fit, focus) {
  const wa = display.workArea || display.bounds;
  const a = screenToCanvas([wa.x, wa.y], display, canvas, fit, focus);
  const b = screenToCanvas([wa.x + wa.width, wa.y + wa.height], display, canvas, fit, focus);
  return [Math.max(0, a[0]), Math.max(0, a[1]), Math.min(canvas.width, b[0]), Math.min(canvas.height, b[1])];
}

// ---- recovery ------------------------------------------------------------------------------------------
// Explorer restarted / the WorkerW is gone: retry after 0.5 / 1 / 2 / 4 / 8 s, never more than 30 s in all
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];
const RETRY_BUDGET_MS = 30000;
function retryPlan(delays = RETRY_DELAYS, budget = RETRY_BUDGET_MS) {
  const out = [];
  let t = 0;
  for (const d of delays) { if (t + d > budget) break; t += d; out.push(d); }
  return out;
}
// the wallpaper page crashed: reloaded at most `max` times in `windowMs`, then wallpaper mode ends
function crashBudget({ max = 3, windowMs = 10 * 60 * 1000 } = {}) {
  const at = [];
  return {
    // → true: reload it; false: give up
    hit(now = Date.now()) {
      while (at.length && now - at[0] > windowMs) at.shift();
      at.push(now);
      return at.length <= max;
    },
    count: () => at.length,
  };
}
// a simple trailing debounce for display events (500 ms in the host)
function debounce(fn, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let t = null;
  const d = (...a) => { if (t) clearTimer(t); t = setTimer(() => { t = null; fn(...a); }, ms); };
  d.cancel = () => { if (t) clearTimer(t); t = null; };
  return d;
}

// the reasons wallpaper mode can be unavailable / can fail, as the owner reads them (docs/wallpaper-mode.md §3.6)
const REASON_TEXT = {
  'helper-failed': '这台电脑上没法把她放进壁纸：壁纸助手没能启动（可能被安全软件拦下了）。她先留在桌面上。',
  'helper-missing': '这台电脑上没法把她放进壁纸：这个版本没有带上壁纸助手。她先留在桌面上。',
  'helper-tampered': '壁纸助手的文件不完整，请重新安装应用。',
  'no-workerw': '这台电脑上没法把她放进壁纸：没找到桌面背景层（Windows 版本不支持）。她先留在桌面上。',
  'no-wm': '没检测到窗口管理器，壁纸没有地方放。',
  'wayland-unsupported': '这个桌面（Wayland）不允许应用放到壁纸层，也不支持设置静态壁纸。',
  'shell-restarted-failed': '桌面刚刚重启了，她没能回到壁纸里，先回到桌面上了。托盘 → 壁纸 可以再试一次。',
  'self-check-failed': '壁纸没能放到桌面图标下面，先退出了壁纸模式。她先留在桌面上。',
  'crashed': '壁纸页面接连出错，先退出了壁纸模式。她回到桌面上了。',
  'no-pack': '这张壁纸没有下载过（可能已经删掉了）。',
  'no-pet': '先在桌面上领养一位角色。',
  'no-display': '没找到显示器。',
  'unsupported-platform': '这个系统还不支持壁纸模式。',
};
const reasonText = (r) => REASON_TEXT[r] || String(r || '');

module.exports = { WHERE, MOVES, move, reconcile, fitCanvas, screenToCanvas, canvasToScreen, petWindowAt, walkClip, RETRY_DELAYS, RETRY_BUDGET_MS, retryPlan, crashBudget, debounce, REASON_TEXT, reasonText };
