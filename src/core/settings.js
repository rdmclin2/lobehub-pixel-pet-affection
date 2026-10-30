'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TTS_DEFAULTS, normalizeTts } = require('./tts');

// settings.json: the 18+ confirmation and the adult-content switch (design 7.2, 8.3, 8.4).
// Unlike pet.json it survives releasing the pet.

const AGE_GATE_VERSION = 1; // bump when the confirmation wording changes: everyone is asked again

// How big the pet is drawn on the desktop: any scale from 50% to 250% (drag the corner handle, Ctrl/⌘ +
// wheel over the pet, or the slider in 高级设置). The window grows with it. A size nobody picked follows
// the default (petScaleSet is false); files from before that flag saved the old default 100% for everyone,
// so there only a size other than 100% counts as picked.
const PET_SCALE = { min: 0.5, max: 2.5, default: 1.25 };
const OLD_DEFAULT_SCALE = 1;
const clampScale = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return PET_SCALE.default;
  return Math.round(Math.min(PET_SCALE.max, Math.max(PET_SCALE.min, n)) * 100) / 100;
};
const petScale = (s) => clampScale(s && s.petScale);

// Desktop behaviour ported from dsh-pet (高级设置 → 桌宠行为). Defaults follow dsh-pet: the pet walks
// about on its own (short steps; never while the pointer is on it or it is busy; off = dsh-pet's
// "fixed"), memes are on, sound and voice are off (a pet should not start making noise unasked), pets
// on screen together knock into each other, and the local HTTP API is off until switched on.
// 部位触摸 (core/touch-zones.js): a click lands on a body part and she reacts to that part (off = the
// old single pat), with a hint of the part under the pointer while hovering.
const PREFS = { roam: true, clickSound: false, voice: false, memes: true, collide: true, touchZones: true, touchHint: true };
const MAX_VISITORS = 3; // other model-chan on the desktop at the same time (同屏伙伴)
const API = { port: 7340, minPort: 1024, maxPort: 65535 };

const DEFAULTS = { ageGateVersion: 0, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, answered: false, petScale: PET_SCALE.default, appearance: {}, models: {}, prefs: { ...PREFS }, visitors: [], api: { enabled: false, port: API.port, token: '' }, tts: TTS_DEFAULTS };

function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return Object.fromEntries(Object.entries(PREFS).map(([k, d]) => [k, typeof p[k] === 'boolean' ? p[k] : d]));
}

function normalizeApi(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const port = Number.isInteger(a.port) && a.port >= API.minPort && a.port <= API.maxPort ? a.port : API.port;
  const token = typeof a.token === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(a.token) ? a.token : '';
  return { enabled: a.enabled === true && !!token, port, token };
}

// Adult content can only be on for a current, confirmed 18+ answer.
function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = { ...DEFAULTS, ...r };
  const current = s.ageGateVersion === AGE_GATE_VERSION;
  s.ageConfirmed = current && s.ageConfirmed === true;
  s.answered = current && s.answered === true;
  if (!s.ageConfirmed) s.ageConfirmedAt = null;
  s.adultContent = s.ageConfirmed && s.adultContent === true;
  s.petScaleSet = typeof r.petScaleSet === 'boolean' ? r.petScaleSet : typeof r.petScale === 'number' && clampScale(r.petScale) !== OLD_DEFAULT_SCALE;
  s.petScale = s.petScaleSet ? clampScale(s.petScale) : PET_SCALE.default;
  // the pet pack chosen per character ({ dafeiyu: 'dafeiyu-pixel' }); unknown packs fall back when looked up
  const ap = s.appearance && typeof s.appearance === 'object' ? s.appearance : {};
  s.appearance = Object.fromEntries(Object.entries(ap).filter(([k, v]) => /^[a-z]{2,20}$/.test(k) && typeof v === 'string' && /^[a-z0-9][a-z0-9-]{2,39}$/.test(v)));
  // the model chosen per character ({ claude: 'lobehub:claude-sonnet-5-5' }); one she may not use falls back when looked up
  const md = s.models && typeof s.models === 'object' ? s.models : {};
  s.models = Object.fromEntries(Object.entries(md).filter(([k, v]) => /^[a-z]{2,20}$/.test(k) && typeof v === 'string' && /^[a-z0-9-]{2,40}:[A-Za-z0-9._-]{1,80}$/.test(v)));
  s.prefs = normalizePrefs(s.prefs);
  // character ids only (checked against the roster by the caller), no repeats, at most MAX_VISITORS
  s.visitors = [...new Set((Array.isArray(s.visitors) ? s.visitors : []).filter((v) => typeof v === 'string' && /^[a-z][a-z0-9]{1,19}$/.test(v)))].slice(0, MAX_VISITORS);
  s.api = normalizeApi(s.api);
  // 语音: the engine that reads (core/tts.js), the fallback and the endpoints; the keys are in tts-keys.json
  s.tts = normalizeTts(s.tts);
  return s;
}

// No answer yet (or an outdated one): show the age gate before anything else.
const needsAgeGate = (s) => !normalizeSettings(s).answered;

// The user's answer on the age gate. 18+ turns adult content on (it can be switched off later).
function answerAgeGate(s, isAdult, now) {
  return normalizeSettings({ ...s, ageGateVersion: AGE_GATE_VERSION, answered: true, ageConfirmed: !!isAdult, ageConfirmedAt: isAdult ? now : null, adultContent: !!isAdult });
}

// Turning adult content on requires a confirmed 18+ answer; turning it off always works.
function setAdultContent(s, on) {
  const cur = normalizeSettings(s);
  if (on && !cur.ageConfirmed) return { ok: false, reason: 'age-not-confirmed', settings: cur };
  return { ok: true, settings: { ...cur, adultContent: !!on } };
}

class SettingsStore {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  load() {
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return normalizeSettings(null);
    }
  }

  save(s) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalizeSettings(s), null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// For tests and callers without a data directory.
class MemorySettingsStore {
  constructor(initial = null) {
    this.data = initial;
  }
  load() {
    return normalizeSettings(this.data);
  }
  save(s) {
    this.data = normalizeSettings(s);
  }
}

module.exports = { AGE_GATE_VERSION, PET_SCALE, PREFS, MAX_VISITORS, API, normalizePrefs, normalizeApi, clampScale, petScale, normalizeSettings, needsAgeGate, answerAgeGate, setAdultContent, SettingsStore, MemorySettingsStore };
