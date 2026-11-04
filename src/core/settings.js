'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TTS_DEFAULTS, normalizeTts } = require('./tts');
const { ASR_DEFAULTS, normalizeAsr } = require('./asr');
const framingLib = require('./framing');
const hotkeyLib = require('./hotkey');

// a character id (core/characters.js: a pack id or `<base>-clips`), or an old per-persona id (2–20 letters)
const CHARACTER_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const CHARACTER_MODEL = 2;

// settings.json: the 18+ confirmation and the adult-content switch (design 7.2, 8.3, 8.4).
// Unlike pet.json it survives releasing the pet.

const AGE_GATE_VERSION = 2; // bump when the confirmation wording changes: everyone is asked again

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
// 互动语音 (core/interaction-voice.js): with 朗读 on she also says her interaction lines (pat, feed, drag…);
// automatic murmurs are read only when 朗读碎碎念 is switched on as well.
// 取景 (core/framing.js, docs/half-body-mode.md): 'full' (head to feet) or 'half' (半身, head to waist, bigger);
// the one non-switch pref. A character's own choice (settings.framings) and a pack's default go before it.
const PREFS = { roam: true, clickSound: false, muted: false, voice: false, voiceInteractions: true, voiceMurmurs: false, memes: true, collide: true, touchZones: true, touchHint: true, framing: framingLib.DEFAULT, danceVolume: 60 };
const MAX_VISITORS = 3; // other model-chan on the desktop at the same time (同屏伙伴)
const API = { port: 7340, minPort: 1024, maxPort: 65535 };
// 个性化设定 (her page → System Role): the owner's own words added to a character's system role
const SYSTEM_ROLE_MAX = 1000;

// 主动行为 (core/proactive.js nextEvent + LlmBudget): whether she speaks up on her own, and how often.
// The defaults are proactive.DEFAULTS, which these replaced as hard-coded constants (admin console §2.5).
const PROACTIVE = { enabled: true, speakCooldownMin: 12, boredAfterMin: 45, hungryAt: 75, maxLlmPerHour: 6 };
const PROACTIVE_RANGE = { speakCooldownMin: [3, 240], boredAfterMin: [5, 480], hungryAt: [50, 100], maxLlmPerHour: [0, 30] };
// 插个嘴 (core/interject.js, docs/interject.md): she listens to the inputs listed in `sources` (and nothing else)
// and a decision model (jev, `lh generate decide`) judges whether a short remark is worth it. Off by default;
// the system-level source (clipboard) has its own switch and is off even when the feature is switched on.
// Probabilities ≥ highThreshold → she says something; ≤ lowThreshold → silence; in between → silence too,
// unless one of the owner's allow rules matches (不打扰优先). Quiet hours: quietStart..quietEnd (equal = none).
const INTERJECT = {
  enabled: false,
  sources: { chatDraft: true, voice: true, api: true, clipboard: false },
  cooldownMin: 10,
  maxPerHour: 3,
  maxDecidePerHour: 20,
  debounceSec: 4,
  minChars: 6,
  quietStart: 23,
  quietEnd: 8,
  highThreshold: 0.7,
  lowThreshold: 0.3,
  timeoutSec: 10,
  model: 'lobehub/jev-1.14.0',
};
const INTERJECT_SOURCES = Object.keys(INTERJECT.sources);
const INTERJECT_RANGE = { cooldownMin: [1, 240], maxPerHour: [0, 20], maxDecidePerHour: [0, 120], debounceSec: [1, 60], minChars: [1, 200], quietStart: [0, 23], quietEnd: [0, 23], timeoutSec: [2, 60] };
const INTERJECT_THRESHOLD_RANGE = { highThreshold: [0.5, 0.99], lowThreshold: [0, 0.5] };
const DECISION_MODEL_RE = /^[a-z0-9][a-z0-9-]{0,39}\/[A-Za-z0-9._-]{1,80}$/;
// 好感度 rules (core/affection.js): the offline decay switch and the daily gain cap (default DAILY_CAP 12).
const AFFECTION_RULES = { decay: true, dailyCap: 12 };
const DAILY_CAP_RANGE = [4, 40];
// 设置窗口外观: the admin console's light / dark theme ('auto' follows the OS).
const UI = { theme: 'auto' };
const THEMES = ['auto', 'light', 'dark'];
// 系统: GPU acceleration (app.disableHardwareAcceleration must run before the app is ready → takes a restart).
const SYSTEM = { hardwareAcceleration: true };
// 版本与更新: whether the app looks for a new version on its own (at launch, then every 4 hours). Off = only
// 检查更新 (tray, ⋯ menu, settings window) checks. Before this switch it could only be turned off with
// PIXELPET_NO_UPDATE=1; a version already downloaded is still installed on quit.
const UPDATE = { autoCheck: true };
// Keys whose change only applies after the app restarts (the admin console says so and offers 立即重启).
const RESTART_KEYS = ['system.hardwareAcceleration'];

const DEFAULTS = { ageGateVersion: 0, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, answered: false, petScale: PET_SCALE.default, models: {}, systemRoles: {}, framings: {}, prefs: { ...PREFS }, vrmPostures: {}, visitors: [], api: { enabled: false, port: API.port, token: '' }, tts: TTS_DEFAULTS, asr: ASR_DEFAULTS, proactive: { ...PROACTIVE }, interject: { ...INTERJECT, sources: { ...INTERJECT.sources } }, affectionRules: { ...AFFECTION_RULES }, ui: { ...UI }, system: { ...SYSTEM }, update: { ...UPDATE } };

// Migration: files from before 取景 have no prefs.framing (→ 'full', as they always looked); an unknown value → 'full'.
function normalizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const out = Object.fromEntries(Object.entries(PREFS).filter(([, d]) => typeof d === 'boolean').map(([k, d]) => [k, typeof p[k] === 'boolean' ? p[k] : d]));
  out.framing = framingLib.normalizeFraming(p.framing, PREFS.framing);
  // the dance music's volume (docs/vrm-dance.md §4.2), 0–100 %
  out.danceVolume = Number.isFinite(p.danceVolume) ? Math.round(Math.max(0, Math.min(100, p.danceVolume))) : PREFS.danceVolume;
  return out;
}

const VRM_POSTURES = ['auto', 'stand.relaxed', 'stand.confident', 'stand.shy', 'stand.playful', 'sit.rest', 'sit.doze'];
function normalizeVrmPostures(raw) {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(Object.entries(v).filter(([k, p]) => /^[a-z0-9][a-z0-9-]{2,39}$/.test(k) && VRM_POSTURES.includes(p) && p !== 'auto').slice(0, 64));
}

function normalizeApi(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const port = Number.isInteger(a.port) && a.port >= API.minPort && a.port <= API.maxPort ? a.port : API.port;
  const token = typeof a.token === 'string' && /^[A-Za-z0-9_-]{24,64}$/.test(a.token) ? a.token : '';
  return { enabled: a.enabled === true && !!token, port, token };
}

const intIn = (v, [min, max], d) => (Number.isInteger(v) && v >= min && v <= max ? v : d);

function normalizeProactive(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const out = { enabled: typeof p.enabled === 'boolean' ? p.enabled : PROACTIVE.enabled };
  for (const k of Object.keys(PROACTIVE_RANGE)) out[k] = intIn(p[k], PROACTIVE_RANGE[k], PROACTIVE[k]);
  return out;
}

const numIn = (v, [min, max], d) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 100) / 100 : d);

// Files from before 插个嘴 have no `interject` (→ the defaults: off). A low threshold not below the high one
// falls back to both defaults; an unknown source key is dropped.
function normalizeInterject(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const src = p.sources && typeof p.sources === 'object' ? p.sources : {};
  const out = { enabled: typeof p.enabled === 'boolean' ? p.enabled : INTERJECT.enabled };
  out.sources = Object.fromEntries(INTERJECT_SOURCES.map((k) => [k, typeof src[k] === 'boolean' ? src[k] : INTERJECT.sources[k]]));
  for (const k of Object.keys(INTERJECT_RANGE)) out[k] = intIn(p[k], INTERJECT_RANGE[k], INTERJECT[k]);
  for (const k of Object.keys(INTERJECT_THRESHOLD_RANGE)) out[k] = numIn(p[k], INTERJECT_THRESHOLD_RANGE[k], INTERJECT[k]);
  if (out.lowThreshold >= out.highThreshold) Object.assign(out, { highThreshold: INTERJECT.highThreshold, lowThreshold: INTERJECT.lowThreshold });
  out.model = typeof p.model === 'string' && DECISION_MODEL_RE.test(p.model.trim()) ? p.model.trim() : INTERJECT.model;
  return out;
}

function normalizeAffectionRules(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  return { decay: typeof a.decay === 'boolean' ? a.decay : AFFECTION_RULES.decay, dailyCap: intIn(a.dailyCap, DAILY_CAP_RANGE, AFFECTION_RULES.dailyCap) };
}

function normalizeUi(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  return { theme: THEMES.includes(u.theme) ? u.theme : UI.theme };
}

function normalizeSystem(raw) {
  const y = raw && typeof raw === 'object' ? raw : {};
  return { hardwareAcceleration: typeof y.hardwareAcceleration === 'boolean' ? y.hardwareAcceleration : SYSTEM.hardwareAcceleration };
}

function normalizeUpdate(raw) {
  const u = raw && typeof raw === 'object' ? raw : {};
  return { autoCheck: typeof u.autoCheck === 'boolean' ? u.autoCheck : UPDATE.autoCheck };
}

// Owner-written text for a system role: no control characters but line breaks, trimmed, at most SYSTEM_ROLE_MAX.
function cleanSystemRole(v) {
  return String(v || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, SYSTEM_ROLE_MAX).trim();
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
  // 角色模型 (T-2764, core/character-migrate.js): 2 = every look is a character of its own. A file without the
  // mark is from before (it still has `appearance`, the 形象包 chosen per persona) and is migrated once when
  // PetService loads it; a new file (nothing saved yet) starts at 2.
  s.characterModel = Number.isInteger(r.characterModel) ? r.characterModel : raw && typeof raw === 'object' && Object.keys(raw).length ? 1 : CHARACTER_MODEL;
  const lookMap = (v) => Object.fromEntries(Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {}).filter(([k, x]) => /^[a-z]{2,20}$/.test(k) && typeof x === 'string' && CHARACTER_ID_RE.test(x)));
  if (s.characterModel < CHARACTER_MODEL) s.appearance = lookMap(s.appearance); // read by the migration only
  else delete s.appearance;
  // the old choice, kept read-only after the migration (a pet.json restored from before still finds it)
  if (s.legacyAppearance !== undefined) s.legacyAppearance = lookMap(s.legacyAppearance);
  // the model chosen per character ({ claude: 'lobehub:claude-sonnet-5-5' }); one she may not use falls back when looked up
  const md = s.models && typeof s.models === 'object' ? s.models : {};
  s.models = Object.fromEntries(Object.entries(md).filter(([k, v]) => /^[a-z]{2,20}$/.test(k) && typeof v === 'string' && /^[a-z0-9-]{2,40}:[A-Za-z0-9._-]{1,80}$/.test(v)));
  // the 个性化设定 per character ({ claude: '叫我老板' }); empty ones are dropped
  const sr = s.systemRoles && typeof s.systemRoles === 'object' ? s.systemRoles : {};
  s.systemRoles = Object.fromEntries(Object.entries(sr).filter(([k, v]) => /^[a-z]{2,20}$/.test(k) && typeof v === 'string').map(([k, v]) => [k, cleanSystemRole(v)]).filter(([, v]) => v));
  // 取景 per character ({ 'claude-pixel': 'half' }); no entry = follow the pack / the global prefs.framing
  s.framings = framingLib.normalizeFramings(s.framings);
  s.prefs = normalizePrefs(s.prefs);
  // a VRM character's posture (core/vrm-library.js POSTURES, or 'auto' = the VRM director decides): { id: posture }
  // (her character id is her pack's id)
  s.vrmPostures = normalizeVrmPostures(s.vrmPostures);
  // character ids only (checked against the roster by the caller), no repeats, at most MAX_VISITORS
  // (before characterModel 2 they were persona ids: `claude`; they are mapped by the migration)
  s.visitors = [...new Set((Array.isArray(s.visitors) ? s.visitors : []).filter((v) => typeof v === 'string' && CHARACTER_ID_RE.test(v)))].slice(0, MAX_VISITORS);
  s.api = normalizeApi(s.api);
  // 语音: the engine that reads (core/tts.js), the fallback and the endpoints; the keys are in tts-keys.json
  // an engine nobody picked follows the character ('auto'): settings from before 'auto' saved 'fish' regardless
  s.tts = normalizeTts(s.tts && s.tts.providerSet === true ? s.tts : { ...s.tts, provider: 'auto' });
  // 语音输入 (core/asr.js): off by default; engine, fallback, language and the local server. Its optional key is in tts-keys.json
  s.asr = normalizeAsr(s.asr);
  // 快捷键唤起语音对话: a valid Electron accelerator ('' = off); none yet / unreadable → the default (core/hotkey.js)
  s.asr.hotkey = normalizeHotkey(s.asr.hotkey);
  s.proactive = normalizeProactive(s.proactive);
  s.interject = normalizeInterject(s.interject);
  s.affectionRules = normalizeAffectionRules(s.affectionRules);
  s.ui = normalizeUi(s.ui);
  s.system = normalizeSystem(s.system);
  s.update = normalizeUpdate(s.update);
  return s;
}

// 快捷键唤起语音对话 (asr.hotkey). Any spelling (Electron 'CmdOrCtrl+Shift+Space' or the settings window's
// HotkeyInput 'mod+shift+space') -> the Electron accelerator; '' = off. Unreadable / missing -> the default.
const normalizeHotkey = (v) => hotkeyLib.normalizeHotkey(v);
// Before one is saved: at least one modifier (not Shift alone) and exactly one known key, and not a combination
// the app itself uses. -> { ok, accelerator } | { ok: false, reason: 'invalid' | 'conflict', code, message }
const validateHotkey = (v, platform = process.platform) => hotkeyLib.checkHotkey(v, platform);

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

  // A copy of settings.json as it is now, made once (before a migration rewrites it).
  backupOnce(name) {
    const to = path.join(path.dirname(this.file), name);
    try {
      if (fs.existsSync(this.file) && !fs.existsSync(to)) fs.copyFileSync(this.file, to);
    } catch { /* a backup is best effort */ }
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
  backupOnce(name) {
    if (!this.backups) this.backups = {};
    if (this.data && !this.backups[name]) this.backups[name] = JSON.parse(JSON.stringify(this.data));
  }
  save(s) {
    this.data = normalizeSettings(s);
  }
}

module.exports = { CHARACTER_MODEL, CHARACTER_ID_RE, DEFAULT_HOTKEY: hotkeyLib.DEFAULT_HOTKEY, normalizeHotkey, validateHotkey, AGE_GATE_VERSION, PET_SCALE, PREFS, VRM_POSTURES, normalizeVrmPostures, MAX_VISITORS, API, SYSTEM_ROLE_MAX, PROACTIVE, PROACTIVE_RANGE, INTERJECT, INTERJECT_SOURCES, INTERJECT_RANGE, INTERJECT_THRESHOLD_RANGE, DECISION_MODEL_RE, normalizeInterject, AFFECTION_RULES, DAILY_CAP_RANGE, UI, THEMES, SYSTEM, UPDATE, RESTART_KEYS, normalizeUpdate, normalizeProactive, normalizeAffectionRules, normalizeUi, normalizeSystem, cleanSystemRole, normalizePrefs, normalizeApi, clampScale, petScale, normalizeSettings, needsAgeGate, answerAgeGate, setAdultContent, SettingsStore, MemorySettingsStore };
