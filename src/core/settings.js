'use strict';

const fs = require('node:fs');
const path = require('node:path');

// settings.json: the 18+ confirmation and the adult-content switch (design 7.2, 8.3, 8.4).
// Unlike pet.json it survives releasing the pet.

const AGE_GATE_VERSION = 1; // bump when the confirmation wording changes: everyone is asked again

// How big the pet is drawn on the desktop: any scale from 50% to 250% (drag the corner handle, Ctrl/⌘ +
// wheel over the pet, or the slider in 高级设置). The window grows with it.
const PET_SCALE = { min: 0.5, max: 2.5, default: 1 };
const clampScale = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return PET_SCALE.default;
  return Math.round(Math.min(PET_SCALE.max, Math.max(PET_SCALE.min, n)) * 100) / 100;
};
const petScale = (s) => clampScale(s && s.petScale);

const DEFAULTS = { ageGateVersion: 0, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, answered: false, petScale: PET_SCALE.default };

// Adult content can only be on for a current, confirmed 18+ answer.
function normalizeSettings(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const current = s.ageGateVersion === AGE_GATE_VERSION;
  s.ageConfirmed = current && s.ageConfirmed === true;
  s.answered = current && s.answered === true;
  if (!s.ageConfirmed) s.ageConfirmedAt = null;
  s.adultContent = s.ageConfirmed && s.adultContent === true;
  s.petScale = clampScale(s.petScale);
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

module.exports = { AGE_GATE_VERSION, PET_SCALE, clampScale, petScale, normalizeSettings, needsAgeGate, answerAgeGate, setAdultContent, SettingsStore, MemorySettingsStore };
