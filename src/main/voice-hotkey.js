'use strict';

// 快捷键唤起语音对话: the global shortcut in settings.asr.hotkey (core/hotkey.js). Registered at launch,
// registered again whenever the setting changes (the old one is let go first), everything let go on quit.
// Pressing it calls `onTrigger` (main.js: show the pet, then the pet window starts / stops listening).
//
// Electron-free: main.js passes Electron's globalShortcut as `shortcuts`, the tests a fake. The state the
// settings window shows (settingsView().hotkeyStatus):
//   ok        registered and listening
//   disabled  no shortcut (cleared)
//   invalid   not a usable combination (only possible in a hand-edited settings.json; the window refuses it)
//   conflict  taken: by the app itself (code 'reserved', e.g. ⌘/Ctrl+,) or by the system / another app
//             (code 'taken': globalShortcut.register returned false or threw)

const hotkeyLib = require('../core/hotkey');

const TAKEN = '被系统或其他应用占用了，按下时不会唤起她。换一个组合，或关掉占用它的程序后重启桌宠。';

class VoiceHotkey {
  constructor({ shortcuts, onTrigger = () => {}, platform = process.platform, log = () => {} }) {
    this.shortcuts = shortcuts;
    this.onTrigger = onTrigger;
    this.platform = platform;
    this.log = log;
    this.current = ''; // the accelerator registered now ('' = none)
    this.triggers = 0;
    this.lastTrigger = null;
    this._status = this._make('disabled', '');
  }

  _make(state, accelerator, extra = {}) {
    return {
      state,
      accelerator,
      label: hotkeyLib.labelFor(accelerator, this.platform),
      keys: hotkeyLib.toHotkeyKeys(accelerator),
      platform: this.platform,
      ...extra,
    };
  }

  status() {
    return { ...this._status, triggers: this.triggers };
  }

  _register(acc, cb) {
    try {
      return { ok: this.shortcuts.register(acc, cb) === true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  _release() {
    if (!this.current) return;
    try { this.shortcuts.unregister(this.current); } catch (e) { this.log(e); }
    this.current = '';
  }

  // Make `acc` the shortcut (from settings.asr.hotkey). -> status()
  apply(acc) {
    const want = typeof acc === 'string' ? acc.trim() : '';
    if (want && want === this.current && this._status.state === 'ok') return this.status();
    this._release();
    if (!want) {
      this._status = this._make('disabled', '');
      return this.status();
    }
    const c = hotkeyLib.checkHotkey(want, this.platform);
    if (!c.ok) {
      this._status = this._make(c.reason, c.accelerator || want, { code: c.code, message: c.message });
      return this.status();
    }
    const r = this._register(c.accelerator, () => this.trigger('shortcut'));
    if (!r.ok) {
      this._status = this._make('conflict', c.accelerator, { code: 'taken', message: TAKEN, error: r.error });
      if (r.error) this.log(new Error(`voice hotkey ${c.accelerator}: ${r.error}`));
      return this.status();
    }
    this.current = c.accelerator;
    this._status = this._make('ok', c.accelerator);
    return this.status();
  }

  // Would `acc` work? Checked before the settings window saves it: a combination the system or another app
  // holds is refused there, and the shortcut in use stays. Registers it for a moment, then lets it go.
  probe(acc) {
    const want = typeof acc === 'string' ? acc.trim() : '';
    if (!want) return this._make('disabled', '');
    const c = hotkeyLib.checkHotkey(want, this.platform);
    if (!c.ok) return this._make(c.reason, c.accelerator || want, { code: c.code, message: c.message });
    if (c.accelerator === this.current && this._status.state === 'ok') return this._make('ok', c.accelerator);
    const r = this._register(c.accelerator, () => {});
    if (!r.ok) return this._make('conflict', c.accelerator, { code: 'taken', message: TAKEN, error: r.error });
    try { this.shortcuts.unregister(c.accelerator); } catch (e) { this.log(e); }
    return this._make('ok', c.accelerator);
  }

  // The shortcut was pressed (or an e2e run pressed it through debug-voice-hotkey).
  trigger(source = 'shortcut') {
    this.triggers += 1;
    this.lastTrigger = { at: Date.now(), source };
    try {
      this.onTrigger({ accelerator: this.current || this._status.accelerator, label: this._status.label, source, n: this.triggers });
    } catch (e) {
      this.log(e);
    }
  }

  // On quit: every global shortcut of the app goes.
  dispose() {
    try { this.shortcuts.unregisterAll(); } catch (e) { this.log(e); }
    this.current = '';
    this._status = this._make('disabled', '');
  }
}

module.exports = { VoiceHotkey, TAKEN };
