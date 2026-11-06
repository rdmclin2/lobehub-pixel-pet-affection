'use strict';
// 她的房间 · 聊天驱动 (docs/illustrated-room.md §4). PetService.chat() asks here before every message from the owner while
// her room is open, and tells her reply afterwards:
//   onMessage(text)  a plain order (core/room-intent.js rules) moves her at once; anything else goes to the decision model
//                    (`lh generate decide`, a few cents of a cent, about a second); the engine carries out its answer.
//                    Returns the note for this turn's prompt: what really happened, so her reply is written from that.
//                    The model failed or timed out: nothing moves, and the note says she did not understand.
//   onReply(text)    her finished reply says she switched the lamp: the picture follows (the note tells her not to, but
//                    what she said and what the owner sees must not differ).
// No electron here: main.js hands in what it needs, the tests hand in a real GameLibrary.
const RoomIntent = require('./room-intent');
const IRP = require('./illustrated-room-play');

const DECIDE_TIMEOUT_MS = 6000;
const DECIDE_MAX_CHARS = 120; // a longer message is a conversation, not an order: not worth asking

function createRoomChat({ open, games, pet, decide = null, push = () => {}, acted = () => {}, log = () => {}, testMode = false, now = () => Date.now(), decideTimeoutMs = DECIDE_TIMEOUT_MS }) {
  const run = (id, cmd) => games.illustratedCommand(id, cmd, pet, { testMode, now: now() });
  const record = (g, by, r, intent) => acted({ game: g.id, type: 'room:chat', obj: String((r && r.to) || (intent && intent.state) || ''), by, item: intent ? `${intent.lamp == null ? '' : `lamp:${intent.lamp}`}${intent.screen ? ` screen:${intent.screen}` : ''}` : '', at: now() });

  // the rules were not enough: → { state, lamp } (null: stay), or null when the model could not tell
  async function ask(room, view, text) {
    try {
      const req = RoomIntent.buildDecision(room, view, text);
      // our own clock too: a killed `lh` whose child still holds the pipe must not keep her reply waiting
      let timer;
      const late = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('room decision timed out'), { code: 'ETIMEDOUT' })), decideTimeoutMs); });
      try {
        return RoomIntent.readDecision(await Promise.race([decide({ ...req, timeoutMs: decideTimeoutMs }), late]), room);
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      log(e);
      return null;
    }
  }

  async function onMessage(text, { attachments = 0 } = {}) {
    const g = open();
    if (!g) return '';
    const view = run(g.id, { cmd: 'state' });
    if (!view || !view.ok) return '';
    const room = IRP.roomOf(g.manifest, view.room);
    const words = String(text).slice(0, 60);
    let intent = RoomIntent.matchRoomIntent(text, room && room.intents, { state: view.state, screen: Object.values(view.screens || {})[0] || null });
    let by = 'rule';
    let heard = null;
    if (!intent || intent.sure === false) {
      push({ ...run(g.id, { cmd: 'hold' }), via: 'chat' }); // she may be asked about this clip: it stays until she has answered
      by = 'model';
      const worth = !attachments && String(text).length <= DECIDE_MAX_CHARS;
      const d = worth && decide ? await ask(room, view, text) : null;
      if (worth && !d) heard = 'unsure';
      if (d && (d.state || d.lamp !== null)) {
        // the sentence's other parts the rules did read (搜一下 …) only go with the state they were read for
        const same = intent && intent.state === d.state;
        intent = { state: d.state, lamp: d.lamp === null && intent ? intent.lamp : d.lamp, screen: same ? intent.screen : null, query: same ? intent.query : null, stop: false, next: false };
      } else intent = intent && intent.lamp !== null ? { ...intent, state: null, screen: null, query: null } : null;
    }
    if (!intent) {
      record(g, heard === 'unsure' ? 'failed' : 'none', null, null);
      if (heard) push({ ...run(g.id, { cmd: 'state' }), via: 'chat', heard }); // the chat bar says so, whatever her reply says
      return games.illustratedNote(g.id, null, { now: now(), heard });
    }
    const r = run(g.id, { cmd: 'set', ...intent, from: 'chat' });
    record(g, by, r, intent);
    push({ ...r, via: 'chat', words });
    return games.illustratedNote(g.id, r, { now: now(), heard });
  }

  // her reply is out: when it says the lamp went on or off and it did not, it does now
  function onReply(text) {
    const g = open();
    if (!g) return null;
    const want = RoomIntent.replyLampClaim(text);
    if (want === null) return null;
    const view = run(g.id, { cmd: 'state' });
    if (!view || !view.ok || view.lamp === want) return null;
    const r = run(g.id, { cmd: 'set', lamp: want, from: 'chat' });
    record(g, 'reply', r, { lamp: want, screen: null });
    push({ ...r, via: 'chat', line: '' }); // she has just said it herself
    return r;
  }

  return { onMessage, onReply };
}

module.exports = { createRoomChat, DECIDE_TIMEOUT_MS };
