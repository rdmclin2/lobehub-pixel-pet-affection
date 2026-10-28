'use strict';

const fs = require('node:fs');
const path = require('node:path');

// settings.json: the 18+ confirmation and the adult-content switch (design 7.2, 8.3, 8.4).
// Unlike pet.json it survives releasing the pet.

const AGE_GATE_VERSION = 1; // bump when the confirmation wording changes: everyone is asked again

// How big the pet is drawn on the desktop (高级设置 → 宠物大小). The window grows with it.
const PET_SIZES = [
  { id: 's', label: '小', scale: 0.75 },
  { id: 'm', label: '中', scale: 1 },
  { id: 'l', label: '大', scale: 1.3 },
  { id: 'xl', label: '特大', scale: 1.6 },
];
const DEFAULT_PET_SIZE = 'm';
const petScale = (s) => (PET_SIZES.find((x) => x.id === (s && s.petSize)) || PET_SIZES.find((x) => x.id === DEFAULT_PET_SIZE)).scale;

const DEFAULTS = { ageGateVersion: 0, ageConfirmed: false, ageConfirmedAt: null, adultContent: false, answered: false, petSize: DEFAULT_PET_SIZE };

// Adult content can only be on for a current, confirmed 18+ answer.
function normalizeSettings(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const current = s.ageGateVersion === AGE_GATE_VERSION;
  s.ageConfirmed = current && s.ageConfirmed === true;
  s.answered = current && s.answered === true;
  if (!s.ageConfirmed) s.ageConfirmedAt = null;
  s.adultContent = s.ageConfirmed && s.adultContent === true;
  if (!PET_SIZES.some((x) => x.id === s.petSize)) s.petSize = DEFAULT_PET_SIZE;
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

module.exports = { AGE_GATE_VERSION, PET_SIZES, DEFAULT_PET_SIZE, petScale, normalizeSettings, needsAgeGate, answerAgeGate, setAdultContent, SettingsStore, MemorySettingsStore };
