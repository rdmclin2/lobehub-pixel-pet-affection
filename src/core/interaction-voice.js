'use strict';
// 互动语音: which lines she says aloud when 朗读 is on, and how fast. Every line reaches the renderer
// as { text, source, kind } (pet-service.js _say, or the renderer itself for 拖拽 / 甩出 / 接住); this
// sorts them into
//   reply       — the agent's replies and topics, lines sent through the local API (always read)
//   milestone   — 初次见面 met, 升级 stage_up, 切换角色 switch (read with 互动语音 on)
//   interaction — 摸摸 / 部位触摸 / 喂食 / 玩耍 / 睡觉 / 拖拽 / 甩出 / 接住 (read with 互动语音 on)
//   murmur      — automatic lines: hungry, bored, greetings, missed, woke (read only with 朗读碎碎念 on)
// and the app's own notes (errors, settings, "busy") are never read.
// SpeechGate keeps rapid clicking from piling lines up: an interaction line is dropped (never queued)
// while another line is still being said, or within MIN_GAP_MS of the last one.
// Loaded by the renderer as a <script> (window.PetInteractionVoice) and by main and the tests through require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetInteractionVoice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_GAP_MS = 1500;
  const TIER = { reply: 2, milestone: 1, interaction: 0, murmur: 0 };
  const MILESTONES = ['met', 'stage_up', 'switch'];
  const ACTS = ['pat', 'feed', 'play', 'sleep'];
  const LOCAL = ['lift', 'throw', 'catch']; // said by the renderer: no line comes from main for these
  const MURMURS = ['hungry', 'bored', 'greet_morning', 'greet_evening', 'missed', 'woke'];

  // Every user interaction that has a voice line, as listed in the README (互动语音).
  const INTERACTIONS = [
    { id: 'pat', label: '摸摸（点她，部位触摸关着或点在部位之间）', kind: 'pat', from: 'act' },
    { id: 'touch', label: '部位触摸（头 / 脸 / 胸 / 手 / 肚子 / 臀 / 腿 / 脚）', kind: 'touch:<zone>', from: 'touch' },
    { id: 'feed', label: '喂食', kind: 'feed', from: 'act' },
    { id: 'play', label: '玩耍', kind: 'play', from: 'act' },
    { id: 'sleep', label: '哄睡', kind: 'sleep', from: 'act' },
    { id: 'lift', label: '拖拽（拎起来）', kind: 'lift', from: 'renderer' },
    { id: 'throw', label: '甩出去', kind: 'throw', from: 'renderer' },
    { id: 'catch', label: '半空接住', kind: 'catch', from: 'renderer' },
    { id: 'met', label: '初次见面（孵化）', kind: 'met', from: 'hatch' },
    { id: 'stage_up', label: '关系升级', kind: 'stage_up', from: 'affection' },
    { id: 'switch', label: '切换角色', kind: 'switch', from: 'switchCharacter' },
  ];

  // Lines for the renderer's own interactions; a character may set her own in `voice.lines`.
  const DEFAULT_LINES = {
    lift: ['哇，被拎起来了！', '放、放我下来啦……'],
    throw: ['呀——飞起来了！', '哇啊啊——！'],
    catch: ['接住啦！', '好险好险。'],
  };

  // The mood her engine reads an interaction line in (core/tts.js moodTags use the pet's status names).
  // A fixed mood per line keeps the synthesised audio, and so the cache, the same every time.
  const MOOD = { pat: 'happy', feed: 'happy', play: 'happy', sleep: 'sleep', lift: 'happy', throw: 'happy', catch: 'happy', met: 'happy', stage_up: 'happy', switch: 'happy' };
  const TOUCH_MOOD = { happy: 'happy', ticklish: 'happy', shy: 'happy', annoyed: 'sad', angry: '' };

  // { cls, tier, interaction } for a line, or null for one that is never read.
  function classify(m) {
    if (!m || typeof m.text !== 'string') return null;
    const kind = m.kind || '';
    const of = (cls, interaction = null) => ({ cls, tier: TIER[cls], interaction });
    if (m.source === 'api' || (m.source === 'llm' && kind === 'chat') || /^topic:/.test(kind)) return of('reply');
    if (m.source !== 'llm' && m.source !== 'fallback') return null;
    if (MILESTONES.includes(kind)) return of('milestone', kind);
    if (ACTS.includes(kind) || LOCAL.includes(kind)) return of('interaction', kind);
    if (/^touch:[a-z]+$/.test(kind)) return of('interaction', 'touch');
    if (MURMURS.includes(kind)) return of('murmur', kind);
    return null;
  }

  // Whether to read `m` with these prefs (settings.prefs): 朗读 off = nothing at all.
  function shouldSpeak(m, prefs) {
    const p = prefs || {};
    if (p.voice !== true) return false;
    const c = classify(m);
    if (!c) return false;
    if (c.cls === 'reply') return true;
    if (c.cls === 'murmur') return p.voiceMurmurs === true;
    return p.voiceInteractions !== false;
  }

  // The mood to synthesise `m` in: its own (a touch reaction), the interaction's, or null (= her status).
  function moodFor(m) {
    if (m && typeof m.voiceMood === 'string') return m.voiceMood;
    const c = classify(m);
    return c && c.interaction && MOOD[c.interaction] !== undefined ? MOOD[c.interaction] : null;
  }
  const touchMood = (reactionMood) => (TOUCH_MOOD[reactionMood] !== undefined ? TOUCH_MOOD[reactionMood] : 'happy');

  // Her lines for a renderer interaction (lift / throw / catch).
  function localLines(species, kind) {
    const own = species && species.voice && typeof species.voice === 'object' && species.voice.lines;
    const l = own && Array.isArray(own[kind]) && own[kind].filter((x) => typeof x === 'string' && x.trim());
    return l && l.length ? l : DEFAULT_LINES[kind] || [];
  }

  // Problems with `voice.lines` in a character file (empty = valid).
  function validateLines(lines) {
    if (lines === undefined) return [];
    if (!lines || typeof lines !== 'object' || Array.isArray(lines)) return [`voice.lines must be an object (${LOCAL.join(', ')})`];
    const errors = [];
    for (const [k, v] of Object.entries(lines)) {
      if (!LOCAL.includes(k)) errors.push(`voice.lines.${k}: unknown interaction (one of ${LOCAL.join(', ')})`);
      else if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' && x.trim() && [...x].length <= 40)) errors.push(`voice.lines.${k} must be a list of short lines (up to 40 characters)`);
    }
    return errors;
  }

  // Decides per line whether it is said now or dropped. `busyTier` is the tier of the line still being
  // synthesised or said (-1: nothing). Replies and milestones always get through (they stop a lower
  // line); a lower line never cuts off a higher one.
  class SpeechGate {
    constructor({ minGapMs = MIN_GAP_MS, now = () => Date.now() } = {}) {
      this.minGapMs = minGapMs;
      this.now = now;
      this.lastLowAt = -Infinity;
      this.stats = { admitted: 0, busy: 0, throttled: 0 };
    }

    admit(c, busyTier = -1) {
      const t = this.now();
      let reason = null;
      if (busyTier > c.tier || (c.tier === 0 && busyTier >= 0)) reason = 'busy';
      else if (c.tier === 0 && t - this.lastLowAt < this.minGapMs) reason = 'throttled';
      if (reason) {
        this.stats[reason]++;
        return { ok: false, reason };
      }
      if (c.tier === 0) this.lastLowAt = t;
      this.stats.admitted++;
      return { ok: true };
    }
  }

  return { MIN_GAP_MS, TIER, INTERACTIONS, MURMURS, LOCAL, DEFAULT_LINES, MOOD, classify, shouldSpeak, moodFor, touchMood, localLines, validateLines, SpeechGate };
});
