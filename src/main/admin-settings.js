'use strict';

// The admin console's writes (配置后台 → `admin-set` / `admin-reset`): one setting at a time, checked against
// core/settings-schema.js and then handed to the existing PetService setter, so everything still goes through
// core/settings.js (normalizeSettings + SettingsStore) and the setter's own `emit('settings')` broadcast.
// Electron-free: main.js passes the side effects that need the app (resize the pet window, stop speech,
// restart the API server, write a key) as hooks, and the tests pass fakes.

const schema = require('../core/settings-schema');
const { NEURAL } = require('../core/tts');
const { KEY_ID: ASR_KEY_ID } = require('../core/asr');

const KEY_SLOTS = new Set([...NEURAL, ASR_KEY_ID]);
const noop = () => {};

function createAdminSettings({ service, hooks = {} }) {
  const h = { resizePet: (k) => k, afterPrefs: noop, beforeTts: noop, afterApi: async () => {}, setKey: () => true, probeHotkey: () => null, ...hooks };

  const result = (key, r, extra = {}) => {
    const settings = service.settingsView();
    const f = schema.field(key);
    return { ok: r.ok !== false, reason: r.ok === false ? r.reason || 'failed' : undefined, message: r.message, key, value: schema.at(settings, key), restart: !!(f && f.restart), pendingRestart: settings.pendingRestart, settings, ...extra };
  };

  // -> { ok, reason?, message?, key, value (as saved), restart, settings }
  async function set(key, value) {
    const f = schema.field(String(key || ''));
    if (!f) return { ok: false, reason: 'unknown', message: '没有这个设置项', key };
    if (f.store === 'keys') {
      // write-only: the key goes to tts-keys.json (main.js), only "has a key" ever comes back
      const id = f.key.slice('keys.'.length);
      if (!KEY_SLOTS.has(id)) return { ok: false, reason: 'unknown', key };
      const v = typeof value === 'string' ? value.trim() : '';
      if (v && !/^[\x21-\x7e]{8,256}$/.test(v)) return { ok: false, reason: 'bad-key', message: 'Key 格式不对：8–256 个可见 ASCII 字符，不能有空格', key };
      if (!h.setKey(id, v)) return { ok: false, reason: 'bad-key', message: 'Key 没有保存成功', key };
      if (id === ASR_KEY_ID) service.setAsr({});
      else { h.beforeTts(); service.setTts({}); } // a new key: try every engine again; emits `settings`
      return result(key, { ok: true }, { value: undefined, hasKey: !!v });
    }
    if (f.store === 'pet') {
      if (typeof value !== 'boolean') return { ok: false, reason: 'type', message: '值的类型不对', key };
      const r = await service.setLocalAbilities(value);
      return { ...result(key, r), value: !!(service.pet && service.pet.localAbilities), view: r.view || service.view() };
    }
    const v = schema.validate(f.key, value);
    if (!v.ok) return { ...v, key, settings: service.settingsView() };
    const route = schema.patchFor(f.key, v.value);
    let r;
    switch (route.setter) {
      case 'setPetScale':
        r = service.setPetScale(h.resizePet(route.patch));
        break;
      case 'setPrefs':
        r = service.setPrefs(route.patch);
        h.afterPrefs(service.settings.prefs);
        break;
      case 'setTts':
        h.beforeTts();
        r = service.setTts(route.patch);
        break;
      case 'setAsr': {
        if (f.key === 'asr.hotkey' && v.value) {
          // 快捷键: one the system or another app holds is not saved; the shortcut in use stays (main/voice-hotkey.js probe)
          const p = h.probeHotkey(v.value);
          if (p && p.state !== 'ok') return { ok: false, reason: 'hotkey-taken', message: p.message || '这个组合用不了', key: f.key, value: v.value, settings: service.settingsView() };
        }
        r = service.setAsr(route.patch);
        if (r.ok === false) r = { ...r, message: { 'bad-endpoint': schema.validate('asr.local.endpoint', 'x').message, 'bad-model': '模型名格式不对' }[r.reason] || r.message };
        break;
      }
      case 'setApi':
        r = service.setApi(route.patch);
        await h.afterApi();
        break;
      case 'setVisitors':
        r = service.setVisitors(route.patch);
        break;
      case 'setSection':
        r = service.setSection(route.section, route.patch);
        break;
      default:
        return { ok: false, reason: 'unknown', key };
    }
    return result(f.key, r);
  }

  // 恢复默认: every listed key back to its default (keys, tokens and read-only facts are skipped).
  async function reset(keys) {
    const out = [];
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const f = schema.field(String(key || ''));
      if (!f || f.store !== 'settings' || !f.live && !f.restart) { out.push({ key, ok: false, reason: 'not-resettable' }); continue; }
      out.push(await set(f.key, f.default));
    }
    return { ok: out.every((r) => r.ok), results: out.map(({ settings: _s, ...r }) => r), settings: service.settingsView() };
  }

  return { set, reset };
}

module.exports = { createAdminSettings };
