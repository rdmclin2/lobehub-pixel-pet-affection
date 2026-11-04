'use strict';

// 快捷调用面板 (T-2849, docs/quick-panel.md): a small menu next to the pet with the everyday actions —
// 关于 / 检查更新… / 偏好设置… / 和她聊天 / 重置姿势 / 隐藏桌宠 / 退出 — laid out like the macOS application
// menu of LobeHub (groups split by lines, an icon on the left, the shortcut on the right, the row under the
// pointer or the arrow keys highlighted). Opened by a right click / long press on her or the global shortcut
// below; main (src/main/quick-panel.js) owns the window, src/renderer/quick/ draws it.
//
// Electron-free: what the panel lists, filtering by typed text, what an update state reads as, and where the
// panel goes on screen. Tested in test/quick-panel.test.js. Loaded by main through require() and by the panel
// page (src/renderer/quick/) as a <script> (window.PetQuick, without core/hotkey.js: the page gets its labels
// from main).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hotkey'));
  else root.PetQuick = factory(null);
})(typeof self !== 'undefined' ? self : this, (hotkeyLib) => {
const PLATFORM = typeof process !== 'undefined' && process.platform ? process.platform : '';

// The global shortcut: ⌘⌥P on macOS, Ctrl+Alt+P elsewhere ("P" for pet). When another app holds it, the
// second one is tried; when both are taken the panel is still one right click away (QuickHotkey.status()).
const QUICK_HOTKEYS = ['CommandOrControl+Alt+P', 'CommandOrControl+Alt+Shift+P'];

// One row. `id` is what main runs (QuickPanel.run); `keys` an accelerator that also works while the panel
// has focus (shown on the right, as in the reference menu); `words` extra words the filter matches.
const ITEMS = {
  about: { label: '关于 Pixel Pet', icon: 'info', words: 'about version 版本 关于' },
  'check-update': { label: '检查更新…', icon: 'refresh', words: 'update check upgrade 更新 升级 新版本' },
  settings: { label: '偏好设置…', icon: 'settings', keys: 'CommandOrControl+,', words: 'settings preferences 设置 配置' },
  chat: { label: '和她聊天', icon: 'chat', words: 'chat talk 聊天 对话 说话' },
  'reset-pose': { label: '重置姿势', icon: 'reset', keys: 'CommandOrControl+Shift+R', words: 'reset pose 重置 姿势' },
  'hide-pet': { label: '隐藏桌宠', icon: 'eye-off', words: 'hide 隐藏' },
  'show-pet': { label: '显示桌宠', icon: 'eye', words: 'show 显示 找回' },
  quit: { label: '退出', icon: 'quit', keys: 'CommandOrControl+Q', words: 'quit exit 退出 关闭' },
};

// What the panel lists, in groups (a line between groups). `ctx`:
//   hasPet     a character is on the desktop (not the hatch screen): 聊天 / 重置姿势 need her
//   petVisible her window is shown (隐藏桌宠) or hidden / minimised (显示桌宠)
//   canReset   her look is a VRM (the only one with a pose to get stuck in, like the ↺ button)
//   version    the running version, shown beside 关于
function buildItems(ctx = {}) {
  const { hasPet = true, petVisible = true, canReset = false, version = '' } = ctx;
  const row = (id, extra = {}) => ({ id, ...ITEMS[id], ...extra });
  const groups = [
    [row('about', version ? { detail: `v${version}` } : {}), row('check-update')],
    [row('settings')],
    [hasPet && petVisible ? row('chat') : null, hasPet && canReset ? row('reset-pose') : null, petVisible ? row('hide-pet') : row('show-pet')],
    [row('quit')],
  ].map((g) => g.filter(Boolean)).filter((g) => g.length);
  const out = [];
  groups.forEach((g, i) => {
    if (i) out.push({ type: 'separator' });
    out.push(...g);
  });
  return out;
}

// Rows matching what was typed: every word of the query must be in the label or the extra words (case and
// spaces ignored). An empty query keeps everything, separators included; a filtered list has no separators.
function filterItems(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items.slice();
  const parts = q.split(/\s+/);
  return items.filter((it) => it.type !== 'separator' && parts.every((p) => `${it.label} ${it.words || ''}`.toLowerCase().replace(/[…\s]/g, ' ').includes(p)));
}

// Keyboard highlight: the next / previous row (wrapping), skipping separators, status blocks and disabled rows. -1 = none.
function moveActive(items, from, step) {
  const ok = (i) => !!(items[i] && items[i].id && !items[i].disabled);
  const n = items.length;
  if (!n) return -1;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (step > 0 ? 0 : n - 1) : (i + step + n) % n;
    if (ok(i)) return i;
  }
  return -1;
}

// The shortcut as the owner reads it: ⌘, on macOS, Ctrl+, elsewhere (core/hotkey.js labelFor).
const keyLabel = (acc, platform = PLATFORM) => (acc && hotkeyLib ? hotkeyLib.labelFor(acc, platform) : '');

// Does a key press in the panel match `acc`? `e`: { key, ctrl, meta, alt, shift } (a keydown, lower-cased key).
function matchesKeys(acc, e, platform = PLATFORM) {
  if (!acc) return false;
  const parts = acc.split('+');
  const key = parts.pop();
  const mac = platform === 'darwin';
  const want = { ctrl: false, meta: false, alt: false, shift: false };
  for (const p of parts) {
    if (p === 'CommandOrControl') want[mac ? 'meta' : 'ctrl'] = true;
    else if (p === 'Control') want.ctrl = true;
    else if (p === 'Command' || p === 'Super') want.meta = true;
    else if (p === 'Alt') want.alt = true;
    else if (p === 'Shift') want.shift = true;
  }
  const k = String(e.key || '').toLowerCase();
  const code = String(e.code || '');
  const keyOk = k === key.toLowerCase() || code === `Key${key.toUpperCase()}`;
  return keyOk && ['ctrl', 'meta', 'alt', 'shift'].every((m) => !!e[m] === want[m]);
}

// ---- 检查更新: what each updater state (src/main/updater.js state.status) reads as ------------------------------
// -> { status, tone, title, detail, action } or null (nothing to say yet). tone: loading | success | info |
// warning | error. action: what the button under it does (QuickPanel.run): install / open-download / retry.
const REASONS = {
  translocated: '我是从“下载”里直接打开的，不能替换自己',
  dmg: '我是从安装盘（DMG）里运行的，不能替换自己',
  'read-only': '我所在的文件夹不能写入，不能替换自己',
  'not-bundle': '当前不是完整的应用包，不能替换自己',
};
function errorText(e) {
  const s = String(e || '').trim();
  if (!s) return '未知原因';
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ENETUNREACH|ECONNREFUSED|ERR_CONNECTION/i.test(s)) return `连不上更新服务器，检查一下网络（${s.slice(0, 60)}）`;
  if (/ETIMEDOUT|timed? ?out/i.test(s)) return `连接更新服务器超时（${s.slice(0, 60)}）`;
  const http = /HTTP (\d{3})/.exec(s);
  if (http) return `更新服务器返回 ${http[1]}`;
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function updateFeedback(state) {
  if (!state || !state.status) return null;
  const v = state.version ? `v${state.version}` : '新版本';
  const cur = state.current ? `v${state.current}` : '';
  switch (state.status) {
    case 'idle': return null;
    case 'checking': return { status: 'checking', tone: 'loading', title: '正在检查更新…', detail: cur ? `当前版本 ${cur}` : '', action: null };
    case 'latest': return { status: 'latest', tone: 'success', title: '已是最新版本', detail: cur ? `当前版本 ${cur}` : '', action: null };
    case 'downloading': return { status: 'downloading', tone: 'info', title: `发现新版本 ${v}`, detail: '正在后台下载，下载好后会提示你立即更新', action: null };
    case 'ready': return { status: 'ready', tone: 'info', title: `新版本 ${v} 已下载好`, detail: '立即更新会重启桌宠（约 2 秒），数据都会保留', action: { id: 'install', label: '立即更新' } };
    case 'manual': return { status: 'manual', tone: 'info', title: `发现新版本 ${v}`, detail: state.error && REASONS[state.error] ? `${REASONS[state.error]}，请到下载页下载安装` : '这个版本需要到下载页下载安装', action: { id: 'open-download', label: '前往下载页' } };
    case 'error': return { status: 'error', tone: 'error', title: '检查更新失败', detail: errorText(state.error), action: { id: 'retry', label: '重试' } };
    case 'disabled': return { status: 'disabled', tone: 'warning', title: '当前版本不检查更新', detail: `开发版（从源码运行）或已关闭更新时不会检查${cur ? `；当前版本 ${cur}` : ''}`, action: null };
    default: return null;
  }
}

// One line for her bubble when the panel was closed before the check finished (QuickPanel → pet window).
function feedbackLine(fb) {
  if (!fb || fb.tone === 'loading') return '';
  const more = fb.action ? `。右键我打开快捷调用面板，点「${fb.action.label}」` : '';
  return `（${fb.title}${fb.detail ? `：${fb.detail}` : ''}${more}。）`;
}

// ---- where the panel goes ------------------------------------------------------------------------------------
// `anchor`: the point it opens at (the right click, or beside the pet), `size`: { w, h }, `area`: the work area of
// the display under the anchor { x, y, width, height }. Like a context menu: down and to the right of the point,
// flipped up / left when there is no room, and always kept `margin` inside the work area (a pet at the screen
// edge still gets a whole panel).
function placePanel({ anchor, size, area, margin = 8 }) {
  const w = Math.min(size.w, area.width - 2 * margin);
  const h = Math.min(size.h, area.height - 2 * margin);
  let x = anchor.x;
  let y = anchor.y;
  if (x + w > area.x + area.width - margin) x = anchor.x - w;
  if (y + h > area.y + area.height - margin) y = anchor.y - h;
  x = Math.max(area.x + margin, Math.min(x, area.x + area.width - margin - w));
  y = Math.max(area.y + margin, Math.min(y, area.y + area.height - margin - h));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

// Opened by the shortcut: beside the pet window (left of her when there is room, else right), level with her
// upper part; with her hidden, in the middle of the display under the pointer.
function hotkeyAnchor({ pet, size, area, cursor }) {
  if (!pet) {
    const c = cursor || { x: area.x + area.width / 2, y: area.y + area.height / 2 };
    return { x: Math.round(c.x - size.w / 2), y: Math.round(c.y - size.h / 2) };
  }
  const left = pet.x - size.w - 4;
  const x = left >= area.x + 8 ? left : pet.x + pet.width + 4;
  return { x, y: pet.y + Math.round(pet.height * 0.25) };
}

return { QUICK_HOTKEYS, ITEMS, buildItems, filterItems, moveActive, keyLabel, matchesKeys, updateFeedback, feedbackLine, errorText, placePanel, hotkeyAnchor };
});
