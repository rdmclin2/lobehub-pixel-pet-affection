'use strict';

// Affection (好感度) model: pure functions, every one takes `now` (ms) explicitly so it is
// trivially testable. See docs/affection-design.md sections 2, 3 and 7.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

// Relationship stages. `min` is inclusive. `rating: 'adult'` stages keep counting for every
// user, but are shown under their all-ages name (`safeNameZh`) unless adult content is on.
const REL_STAGES = [
  { id: 'stranger', nameZh: '陌生', nameEn: 'Stranger', min: 0, rating: 'all', color: '#9aa0a6' },
  { id: 'familiar', nameZh: '熟悉', nameEn: 'Familiar', min: 15, rating: 'all', color: '#4a90d9' },
  { id: 'close', nameZh: '亲近', nameEn: 'Close', min: 35, rating: 'all', color: '#4fae4e' },
  { id: 'flirty', nameZh: '暧昧', nameEn: 'Flirty', min: 60, rating: 'adult', safeNameZh: '知己', color: '#e86aa6' },
  { id: 'lover', nameZh: '恋人', nameEn: 'Lover', min: 85, rating: 'adult', safeNameZh: '挚友', color: '#e0454f' },
];
const STAGE_IDS = REL_STAGES.map((s) => s.id);
const MAX_AFFECTION = 100;

// Gain per source. `cooldownMs: 'day'` means once per affection day; `dailyMax: null` = unlimited.
const AFFECTION_RULES = {
  greet: { label: '每日首次互动', delta: 3, cooldownMs: 'day', dailyMax: 1 },
  pat: { label: '摸摸', delta: 1, cooldownMs: 2 * MIN, dailyMax: 10 },
  feed: { label: '喂食', delta: 2, cooldownMs: 10 * MIN, dailyMax: 4 },
  feed_full: { label: '硬喂', delta: -1, cooldownMs: 0, dailyMax: null },
  play: { label: '玩耍', delta: 2, cooldownMs: 10 * MIN, dailyMax: 4 },
  chat: { label: '聊天', delta: 1.5, cooldownMs: 1 * MIN, dailyMax: 12 },
  topic: { label: '话题', delta: 2, cooldownMs: 0, dailyMax: 3 }, // plus: each topic scores once a day
  woken: { label: '吵醒', delta: -2, cooldownMs: 0, dailyMax: null },
  sleep: { label: '哄睡（22:00–02:00）', delta: 1, cooldownMs: 'day', dailyMax: 1 },
};
const DAILY_CAP = 12; // positive gain per affection day, all sources together
const DAY_ROLLOVER_HOUR = 4; // the affection day starts at 04:00 local time
const DECAY = { graceMs: 48 * HOUR, stepMs: 12 * HOUR, perStep: 1, maxPerAbsence: 8 };

const round1 = (v) => Math.round(v * 10) / 10;
const clampAff = (v) => Math.max(0, Math.min(MAX_AFFECTION, round1(v)));

function stageForAffection(v) {
  let cur = REL_STAGES[0].id;
  for (const s of REL_STAGES) if (v >= s.min) cur = s.id;
  return cur;
}

const stageIndex = (id) => Math.max(0, STAGE_IDS.indexOf(id));
const getStage = (id) => REL_STAGES[stageIndex(id)];

// The local date the affection counters belong to; the day turns over at 04:00.
function affectionDay(now) {
  const d = new Date(now - DAY_ROLLOVER_HOUR * HOUR);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Fresh affection fields for a new pet (or for one migrated from the growth system).
function initialAffection(now, affection = 0) {
  const v = clampAff(affection);
  const stage = stageForAffection(v);
  return {
    affection: v,
    relStage: stage,
    peakStage: stage,
    affectionDay: affectionDay(now),
    affectionToday: 0,
    dailyCounts: {},
    lastAffectionAt: {},
    topicsToday: [],
    lastDecayAt: now,
    decayAnchor: null,
    decaySteps: 0,
  };
}

function rollDay(pet, now) {
  const day = affectionDay(now);
  if (pet.affectionDay === day) return;
  pet.affectionDay = day;
  pet.affectionToday = 0;
  pet.dailyCounts = {};
  pet.topicsToday = [];
}

function isTuckInWindow(now) {
  const h = new Date(now).getHours();
  return h >= 22 || h < 2;
}

// Mood / hunger modifiers on positive gain (design 2.2).
function modifier(pet, source) {
  let m = 1;
  if (pet.mood < 25) m *= 0.5;
  else if (pet.mood >= 75) m *= 1.2;
  if (pet.hunger >= 75 && (source === 'pat' || source === 'play')) m *= 0.5;
  return m;
}

// Why a positive source scores nothing right now, or null when it may score.
function blockedReason(pet, source, now, { topicId } = {}) {
  const rule = AFFECTION_RULES[source];
  const count = pet.dailyCounts[source] || 0;
  if (rule.dailyMax != null && count >= rule.dailyMax) return 'daily';
  if (source === 'sleep' && !isTuckInWindow(now)) return 'window';
  if (source === 'topic' && topicId && pet.topicsToday.includes(topicId)) return 'topic-today';
  const last = pet.lastAffectionAt[source];
  if (typeof rule.cooldownMs === 'number' && rule.cooldownMs > 0 && last != null) {
    if (now < last || now - last < rule.cooldownMs) return 'cooldown'; // a clock set back counts as cooling down
  }
  if (pet.affectionToday >= DAILY_CAP) return 'cap';
  return null;
}

function setAffection(pet, value) {
  const fromStage = pet.relStage;
  const fromPeak = pet.peakStage;
  pet.affection = clampAff(value);
  pet.relStage = stageForAffection(pet.affection);
  if (stageIndex(pet.relStage) > stageIndex(pet.peakStage)) pet.peakStage = pet.relStage;
  const unlockedStages = STAGE_IDS.slice(stageIndex(fromPeak) + 1, stageIndex(pet.peakStage) + 1);
  return {
    from: fromStage,
    to: pet.relStage,
    stageUp: stageIndex(pet.relStage) > stageIndex(fromStage),
    stageDown: stageIndex(pet.relStage) < stageIndex(fromStage),
    unlockedStages, // stages reached for the first time: their content just unlocked
  };
}

function applyOne(pet, source, now, opts) {
  const rule = AFFECTION_RULES[source];
  if (rule.delta < 0) {
    const before = pet.affection;
    setAffection(pet, pet.affection + rule.delta);
    pet.lastAffectionAt[source] = now;
    return { source, delta: round1(pet.affection - before), blocked: null };
  }
  const blocked = blockedReason(pet, source, now, opts);
  if (blocked) return { source, delta: 0, blocked };
  const want = round1(rule.delta * modifier(pet, source));
  const delta = round1(Math.min(want, DAILY_CAP - pet.affectionToday, MAX_AFFECTION - pet.affection));
  pet.dailyCounts[source] = (pet.dailyCounts[source] || 0) + 1;
  pet.lastAffectionAt[source] = now;
  if (source === 'topic' && opts.topicId) pet.topicsToday.push(opts.topicId);
  pet.affectionToday = round1(pet.affectionToday + Math.max(0, delta));
  pet.affection = clampAff(pet.affection + Math.max(0, delta));
  return { source, delta: Math.max(0, delta), blocked: delta > 0 ? null : 'cap' };
}

// Score one interaction. Mutates `pet` and returns
// { source, delta, blocked, parts, from, to, stageUp, stageDown, unlockedStages, value }.
// `blocked` is why the main source scored nothing: 'cooldown' | 'daily' | 'cap' | 'window' | 'topic-today' | null.
// The first positive interaction of the day also earns the `greet` bonus (it is in `parts`).
function gainAffection(pet, source, now, opts = {}) {
  const rule = AFFECTION_RULES[source];
  if (!rule) throw new Error(`Unknown affection source: ${source}`);
  rollDay(pet, now);
  const fromStage = pet.relStage;
  const fromPeak = pet.peakStage;
  const before = pet.affection;
  const parts = [];
  if (rule.delta > 0 && source !== 'greet' && !(pet.dailyCounts.greet > 0)) {
    const g = applyOne(pet, 'greet', now, opts);
    if (g.delta > 0) parts.push(g);
  }
  const main = applyOne(pet, source, now, opts);
  parts.push(main);
  // Recompute stages once against the starting point so a single call reports one transition.
  pet.relStage = fromStage;
  pet.peakStage = fromPeak;
  const tr = setAffection(pet, pet.affection);
  return { source, delta: round1(pet.affection - before), blocked: main.blocked, parts, value: pet.affection, ...tr };
}

// Gentle offline decay (design 2.4): only after 48 h without interaction, -1 per full 12 h,
// at most -8 per absence, and never below the current stage's threshold (decay never demotes).
function decay(pet, now) {
  const anchor = pet.lastInteractionAt;
  if (pet.decayAnchor !== anchor) {
    pet.decayAnchor = anchor;
    pet.decaySteps = 0;
  }
  const idleMs = now - anchor - DECAY.graceMs;
  if (idleMs < DECAY.stepMs) return 0;
  const steps = Math.min(DECAY.maxPerAbsence, Math.floor(idleMs / DECAY.stepMs));
  const due = steps - pet.decaySteps;
  if (due <= 0) return 0;
  pet.decaySteps = steps;
  const floor = getStage(pet.relStage).min;
  const before = pet.affection;
  pet.affection = clampAff(Math.max(floor, pet.affection - due * DECAY.perStep));
  pet.lastDecayAt = now;
  return round1(before - pet.affection);
}

const adultAllowed = (settings, speciesId) => !!(settings && settings.ageConfirmed && settings.adultContent) && speciesId !== 'dafeiyu';

// Stage name as the user sees it: adult stages read 知己 / 挚友 when adult content is off.
function stageName(stageId, adult) {
  const s = getStage(stageId);
  return s.rating === 'adult' && !adult ? s.safeNameZh : s.nameZh;
}

// Everything the UI needs for the affection bar and the meta line.
function toAffectionProgress(pet, { adult = false } = {}) {
  const idx = stageIndex(pet.relStage);
  const cur = REL_STAGES[idx];
  const next = REL_STAGES[idx + 1] || null;
  const value = Math.floor(pet.affection);
  const base = {
    value,
    raw: pet.affection,
    max: MAX_AFFECTION,
    stage: cur.id,
    stageName: stageName(cur.id, adult),
    peakStage: pet.peakStage,
    color: cur.color,
    today: pet.affectionToday,
    dailyCap: DAILY_CAP,
  };
  if (!next) return { ...base, next: null, nextName: null, need: 0, pct: 100 };
  return {
    ...base,
    next: next.id,
    nextName: stageName(next.id, adult),
    need: Math.max(0, Math.ceil(next.min - pet.affection)),
    pct: Math.max(0, Math.min(100, Math.round(((pet.affection - cur.min) / (next.min - cur.min)) * 100))),
  };
}

module.exports = {
  REL_STAGES,
  STAGE_IDS,
  AFFECTION_RULES,
  DAILY_CAP,
  DECAY,
  MAX_AFFECTION,
  affectionDay,
  initialAffection,
  stageForAffection,
  stageIndex,
  getStage,
  stageName,
  adultAllowed,
  gainAffection,
  decay,
  toAffectionProgress,
};
