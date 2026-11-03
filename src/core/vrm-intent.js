'use strict';
// What happened, for a VRM figure (docs/vrm-motion-system.md §2.2): the app's shared data of one frame (a
// read-only snapshot: her needs status, the fx one-shot, lifted / flying, thinking, eating, talking, the
// last touch, facing, the pointer) turned into semantic events and holds. No event says how to move (no hop,
// spin, dangle…): the VRM director decides that. Pure; UMD (window.PetVrmIntent / require()).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PetVrmIntent = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MOODS = ['idle', 'happy', 'sad', 'hungry', 'sleep'];
  const CUES = ['look', 'turn', 'play', 'happy'];
  const CELEBRATIONS = ['hatch', 'evolve'];

  // An old-style call draw({ t, state }) (the picture, tests) as a snapshot: the state is the status or the shot.
  function fromState(state, t = 0) {
    const s = String(state || 'idle');
    const snap = { t, status: 'idle', shot: null };
    if (MOODS.includes(s)) snap.status = s;
    else if (s === 'lifted') snap.lifted = true;
    else if (s === 'think') snap.thinking = true;
    else if (s === 'talk') snap.talking = true;
    else if (s === 'walk') snap.walking = true;
    else if (s.startsWith('eat_')) snap.eating = s.slice(4);
    else snap.shot = s;
    return snap;
  }

  // snap (this frame) + prev (the last frame's snapshot, or null) → { holds, events }
  //   holds: { mood, talk, think, eat, walk, lift, attention, facing, dance (null | { id, t, duration, loop, ready, playing, paused, faceTrack }), recording }
  //   events: [{ type: 'touch', zone, mood, streak } | { type: 'drag', what: 'lift'|'drop'|'thrown' } | { type: 'dance', what: 'start'|'stop', id } |
  //            { type: 'cue', name } | { type: 'celebrate', name } | { type: 'touch', zone: 'pat' }]
  function fromSnapshot(snap, prev = null) {
    const s = snap || {};
    const p = prev || {};
    const lifted = !!(s.lifted || s.flying);
    const wasLifted = !!(p.lifted || p.flying);
    const holds = {
      mood: MOODS.includes(s.status) ? s.status : 'idle',
      talk: !!(s.talking || s.voice),
      think: !!s.thinking,
      eat: s.eating ? String(s.eating) : null,
      walk: !!s.walking,
      lift: lifted,
      attention: !!s.pointerInside,
      facing: s.facing === 'left' ? 'left' : 'right',
      // the dance the app plays (docs/vrm-dance.md §3.5): what, where its clock is, whether it runs; the
      // microphone recording (the music ducks lower then)
      dance: s.dance && s.dance.id ? { id: String(s.dance.id), t: Number(s.dance.t) || 0, duration: Number(s.dance.duration) || 0, loop: !!s.dance.loop, ready: s.dance.ready !== false, playing: !!s.dance.playing, paused: s.dance.paused || null, faceTrack: !!s.dance.faceTrack } : null,
      recording: !!s.recording,
    };
    const events = [];
    const danceId = holds.dance ? holds.dance.id : null;
    const wasDance = p.dance && p.dance.id ? String(p.dance.id) : null;
    if (prev && danceId !== wasDance) { if (wasDance) events.push({ type: 'dance', what: 'stop', id: wasDance }); if (danceId) events.push({ type: 'dance', what: 'start', id: danceId }); }
    if (lifted && !wasLifted) events.push({ type: 'drag', what: 'lift' });
    if (!lifted && wasLifted) events.push({ type: 'drag', what: p.flying ? 'thrown' : 'drop' });
    // a touch on a body part: core/touch-zones.js counted it (n goes up by one each time) and chose the mood
    const tn = s.touch && Number.isFinite(s.touch.n) ? s.touch.n : null;
    const pn = p.touch && Number.isFinite(p.touch.n) ? p.touch.n : null;
    if (tn !== null && tn !== pn && prev) events.push({ type: 'touch', zone: String(s.touch.zone || 'head'), mood: s.touch.mood || 'happy', streak: s.touch.streak || 0 });
    // fx one-shots start on their rising edge
    if (s.shot && s.shot !== p.shot) {
      if (s.shot === 'pat') events.push({ type: 'touch', zone: 'pat', mood: 'happy', streak: 0 });
      else if (CELEBRATIONS.includes(s.shot)) events.push({ type: 'celebrate', name: s.shot });
      else if (CUES.includes(s.shot)) events.push({ type: 'cue', name: s.shot });
    }
    return { holds, events };
  }

  // A one-line summary for the canvas' data-state (e2e / debugging).
  function summary({ holds, events }) {
    const h = [`mood:${holds.mood}`];
    for (const k of ['talk', 'think', 'walk', 'lift', 'attention']) if (holds[k]) h.push(k);
    if (holds.eat) h.push(`eat:${holds.eat}`);
    if (holds.dance) h.push(`dance:${holds.dance.id}`);
    for (const e of events) h.push(e.type === 'touch' ? `touch:${e.zone}` : e.type === 'drag' || e.type === 'dance' ? `${e.type}:${e.what}` : `${e.type}:${e.name}`);
    return h.join(' ');
  }

  return { MOODS, CUES, CELEBRATIONS, fromState, fromSnapshot, summary };
});
