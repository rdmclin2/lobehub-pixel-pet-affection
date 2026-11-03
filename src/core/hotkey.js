'use strict';

// 快捷键唤起语音对话 (asr.hotkey): the global shortcut that brings the pet up and starts listening.
// Electron-free: parsing, checking and naming accelerators. main.js (src/main/voice-hotkey.js) registers
// it with globalShortcut; the settings window records a combination with @lobehub/ui HotkeyInput, whose
// format ('mod+shift+space') is accepted here too and turned into an Electron accelerator
// ('CommandOrControl+Shift+Space').
//
// The default: ⌘⇧Space on macOS, Ctrl+Shift+Space elsewhere. Not taken by macOS, Windows or GNOME / KDE
// out of the box (⌘Space / Ctrl+Space are the input-source and Spotlight keys, ⌘⌥Space is Finder search);
// apps that use it inside their own window (VS Code: parameter hints) lose it while the pet runs — the
// README says how to pick another one or clear it.
const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';

// modifier spellings (Electron's and HotkeyInput's) -> the Electron name, in Electron's usual order
const MODS = {
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl', mod: 'CommandOrControl',
  command: 'Command', cmd: 'Command',
  control: 'Control', ctrl: 'Control',
  alt: 'Alt', option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super', meta: 'Super',
};
const MOD_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];

// key spellings -> the Electron key code (https://www.electronjs.org/docs/latest/api/accelerator)
const NAMED = {
  space: 'Space', tab: 'Tab', enter: 'Enter', return: 'Enter', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  esc: 'Escape', escape: 'Escape',
  plus: 'Plus', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';', quote: "'", backquote: '`',
  minus: '-', equal: '=', bracketleft: '[', bracketright: ']',
};
const PUNCT = new Set([',', '.', '/', '\\', ';', "'", '`', '-', '=', '[', ']']);

function keyName(k) {
  const low = k.toLowerCase();
  if (/^[a-z]$/.test(low)) return low.toUpperCase();
  if (/^[0-9]$/.test(low)) return low;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(low)) return low.toUpperCase();
  if (NAMED[low]) return NAMED[low];
  if (PUNCT.has(k)) return k;
  return null;
}

const MESSAGES = {
  'no-modifier': '至少要有一个修饰键（Ctrl / ⌘ / Alt / ⌥），单个按键会挡住正常打字',
  'shift-only': '只有 Shift 不够：Shift + 字母会挡住打大写字母，再加一个 Ctrl / ⌘ / Alt',
  'no-key': '只按了修饰键：还需要一个普通键（字母、数字、空格、F1–F24 等）',
  'two-keys': '只能有一个普通键（例如 Ctrl+Shift+Space）',
  'unknown-key': '有按键不认识',
  'too-long': '太长了',
  type: '格式不对',
};

// Any spelling -> { ok: true, accelerator } | { ok: false, reason, message }. '' is not a shortcut (= off).
function parseAccelerator(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'type', message: MESSAGES.type };
  const s = raw.trim();
  if (!s) return { ok: false, reason: 'no-key', message: MESSAGES['no-key'] };
  if (s.length > 80) return { ok: false, reason: 'too-long', message: MESSAGES['too-long'] };
  // a '+' key is written '++' (HotkeyInput) or 'Plus' (Electron)
  const parts = s.replace(/\+\+/g, '+Plus').split('+').map((p) => p.trim());
  const mods = new Set();
  const keys = [];
  for (const p of parts) {
    if (!p) return { ok: false, reason: 'unknown-key', message: MESSAGES['unknown-key'] };
    const m = MODS[p.toLowerCase()];
    if (m) { mods.add(m); continue; }
    const k = keyName(p);
    if (!k) return { ok: false, reason: 'unknown-key', message: `${MESSAGES['unknown-key']}：${p.slice(0, 20)}` };
    if (!keys.includes(k)) keys.push(k);
  }
  if (!keys.length) return { ok: false, reason: 'no-key', message: MESSAGES['no-key'] };
  if (keys.length > 1) return { ok: false, reason: 'two-keys', message: MESSAGES['two-keys'] };
  if (!mods.size) return { ok: false, reason: 'no-modifier', message: MESSAGES['no-modifier'] };
  if (mods.size === 1 && mods.has('Shift')) return { ok: false, reason: 'shift-only', message: MESSAGES['shift-only'] };
  // CommandOrControl already covers Command (macOS) or Control (elsewhere): keep the explicit one out
  return { ok: true, accelerator: [...MOD_ORDER.filter((m) => mods.has(m)), keys[0]].join('+') };
}

// settings.json → asr.hotkey: '' = off; missing (settings from before the shortcut) or unreadable → the default
function normalizeHotkey(raw) {
  if (raw === undefined || raw === null) return DEFAULT_HOTKEY;
  if (typeof raw === 'string' && raw.trim() === '') return '';
  const r = parseAccelerator(raw);
  return r.ok ? r.accelerator : DEFAULT_HOTKEY;
}

// Combinations this app already uses (main.js / the macOS app menu): taken by a global shortcut, they would
// stop working in the app itself. `label` says what they do.
const RESERVED = [
  { accelerator: 'CommandOrControl+,', label: '打开设置' },
  { accelerator: 'CommandOrControl+Q', label: '退出（macOS）' },
  { accelerator: 'CommandOrControl+C', label: '复制' },
  { accelerator: 'CommandOrControl+V', label: '粘贴（聊天框里粘贴图片）' },
  { accelerator: 'CommandOrControl+X', label: '剪切' },
  { accelerator: 'CommandOrControl+A', label: '全选' },
  { accelerator: 'CommandOrControl+Z', label: '撤销' },
  { accelerator: 'CommandOrControl+Shift+Z', label: '重做' },
];

// The same combination for the platform at hand: CommandOrControl is Command on macOS, Control elsewhere.
function expand(acc, platform) {
  const mac = platform === 'darwin';
  return acc.split('+').map((p) => (p === 'CommandOrControl' ? (mac ? 'Command' : 'Control') : p)).sort().join('+');
}

// -> the reserved entry `acc` collides with on `platform`, or null
function reservedConflict(acc, platform = process.platform) {
  const r = parseAccelerator(acc);
  if (!r.ok) return null;
  const mine = expand(r.accelerator, platform);
  return RESERVED.find((x) => expand(x.accelerator, platform) === mine) || null;
}

// Full check before a shortcut is saved: -> { ok, accelerator } | { ok: false, reason: 'invalid' | 'conflict', code, message }
function checkHotkey(raw, platform = process.platform) {
  if (typeof raw === 'string' && raw.trim() === '') return { ok: true, accelerator: '' };
  const r = parseAccelerator(raw);
  if (!r.ok) return { ok: false, reason: 'invalid', code: r.reason, message: r.message };
  const c = reservedConflict(r.accelerator, platform);
  if (c) return { ok: false, reason: 'conflict', code: 'reserved', accelerator: r.accelerator, message: `和应用内的「${c.label}」（${labelFor(c.accelerator, platform)}）冲突，换一个组合` };
  return { ok: true, accelerator: r.accelerator };
}

// What the owner reads: ⌘⇧Space on macOS, Ctrl+Shift+Space elsewhere.
const MAC_SYM = { CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Alt: '⌥', AltGr: '⌥', Shift: '⇧', Super: '⌘' };
const PC_NAME = { CommandOrControl: 'Ctrl', Command: 'Win', Control: 'Ctrl', Alt: 'Alt', AltGr: 'AltGr', Shift: 'Shift', Super: 'Win' };
function labelFor(acc, platform = process.platform) {
  if (!acc) return '';
  const parts = acc.split('+');
  const key = parts.pop();
  if (platform === 'darwin') return `${parts.map((p) => MAC_SYM[p] || p).join('')}${key}`;
  return [...parts.map((p) => PC_NAME[p] || p), key].join('+');
}

// The same shortcut in HotkeyInput's format (react-hotkeys-hook key names), for showing it in the settings window.
const TO_HOTKEY_KEY = { Space: 'space', Tab: 'tab', Enter: 'enter', Backspace: 'backspace', Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Up: 'up', Down: 'down', Left: 'left', Right: 'right', Escape: 'esc', Plus: 'equal', ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash', ';': 'semicolon', "'": 'quote', '`': 'backquote', '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright' };
const TO_HOTKEY_MOD = { CommandOrControl: 'mod', Command: 'meta', Control: 'ctrl', Alt: 'alt', AltGr: 'alt', Shift: 'shift', Super: 'meta' };
function toHotkeyKeys(acc) {
  if (!acc) return '';
  const parts = acc.split('+');
  const key = parts.pop();
  return [...parts.map((p) => TO_HOTKEY_MOD[p] || p.toLowerCase()), TO_HOTKEY_KEY[key] || key.toLowerCase()].join('+');
}

module.exports = { DEFAULT_HOTKEY, RESERVED, MESSAGES, parseAccelerator, normalizeHotkey, reservedConflict, checkHotkey, labelFor, toHotkeyKeys };
