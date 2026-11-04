'use strict';

// 快捷调用面板的全局快捷键 (T-2849): ⌘⌥P / Ctrl+Alt+P, or ⌘⌥⇧P / Ctrl+Alt+Shift+P when the first one is taken
// (core/quick-panel.js QUICK_HOTKEYS). A combination equal to 快捷键唤起语音对话 (asr.hotkey) is skipped, so
// the two never fight. When every candidate is taken (another app, the system) nothing breaks: the state says
// so and the panel is still a right click away.
//
// Electron-free: main.js passes Electron's globalShortcut as `shortcuts`, the tests a fake.
//   ok        registered (`accelerator`, `label`, `fallback`: true when it is not the first choice)
//   conflict  every candidate is taken (`tried`: what was tried and why it failed)

const hotkeyLib = require('../core/hotkey');
const { QUICK_HOTKEYS } = require('../core/quick-panel');

class QuickHotkey {
  constructor({ shortcuts, onTrigger = () => {}, platform = process.platform, log = () => {}, candidates = QUICK_HOTKEYS }) {
    this.shortcuts = shortcuts;
    this.onTrigger = onTrigger;
    this.platform = platform;
    this.log = log;
    this.candidates = candidates;
    this.current = '';
    this.triggers = 0;
    this._status = { state: 'conflict', accelerator: '', label: '', tried: [] };
  }

  status() {
    return { ...this._status, triggers: this.triggers };
  }

  _same(a, b) {
    if (!a || !b) return false;
    const x = hotkeyLib.parseAccelerator(a);
    const y = hotkeyLib.parseAccelerator(b);
    if (!x.ok || !y.ok) return false;
    const norm = (acc) => acc.split('+').map((p) => (p === 'CommandOrControl' ? (this.platform === 'darwin' ? 'Command' : 'Control') : p)).sort().join('+');
    return norm(x.accelerator) === norm(y.accelerator);
  }

  _release() {
    if (!this.current) return;
    try { this.shortcuts.unregister(this.current); } catch (e) { this.log(e); }
    this.current = '';
  }

  // (Re)register, staying clear of `avoid` (the voice shortcut in use). -> status()
  apply({ avoid = [] } = {}) {
    const busy = avoid.filter(Boolean);
    if (this.current && this._status.state === 'ok' && !busy.some((a) => this._same(a, this.current))) return this.status();
    this._release();
    const tried = [];
    for (const [i, acc] of this.candidates.entries()) {
      if (busy.some((a) => this._same(a, acc))) { tried.push({ accelerator: acc, reason: 'voice-hotkey' }); continue; }
      let ok = false;
      let error = null;
      try {
        ok = this.shortcuts.register(acc, () => this.trigger('shortcut')) === true;
      } catch (e) {
        error = String((e && e.message) || e);
      }
      if (ok) {
        this.current = acc;
        this._status = { state: 'ok', accelerator: acc, label: hotkeyLib.labelFor(acc, this.platform), fallback: i > 0, tried };
        return this.status();
      }
      tried.push({ accelerator: acc, reason: error ? 'error' : 'taken', error });
    }
    this._status = { state: 'conflict', accelerator: '', label: '', tried };
    this.log(new Error(`quick panel hotkey: none of ${this.candidates.join(', ')} could be registered`));
    return this.status();
  }

  trigger(source = 'shortcut') {
    this.triggers += 1;
    try {
      this.onTrigger({ source, n: this.triggers });
    } catch (e) {
      this.log(e);
    }
  }

  dispose() {
    this._release();
  }
}

module.exports = { QuickHotkey };
