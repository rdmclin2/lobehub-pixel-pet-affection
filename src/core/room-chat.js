'use strict';
// 她的房间 · 聊天驱动 (docs/illustrated-room.md §4). PetService.chat() asks before every message from the owner while
// her room is open. No electron here: main.js hands in what it needs, the tests hand in a real GameLibrary.
const RoomIntent = require('./room-intent');
const IRP = require('./illustrated-room-play');

function createRoomChat({ open, games, pet, push = () => {}, acted = () => {}, testMode = false, now = () => Date.now() }) {
  const run = (id, cmd) => games.illustratedCommand(id, cmd, pet, { testMode, now: now() });
  async function onMessage(text) {
    const g = open();
    if (!g) return '';
    const now0 = run(g.id, { cmd: 'state' });
    if (!now0 || !now0.ok) return '';
    const room = IRP.roomOf(g.manifest, now0.room);
    const intent = RoomIntent.matchRoomIntent(text, room && room.intents, { state: now0.state, screen: Object.values(now0.screens || {})[0] || null });
    if (!intent) {
      push({ ...run(g.id, { cmd: 'hold' }), via: 'chat' }); // she may be asked about this clip: it stays until she has answered
      return games.illustratedNote(g.id, null, { now: now() });
    }
    const r = run(g.id, { cmd: 'set', ...intent, from: 'chat' });
    acted({ game: g.id, type: 'room:chat', obj: String(r.to || intent.state || ''), item: `${intent.lamp === null ? '' : `lamp:${intent.lamp}`}${intent.screen ? ` screen:${intent.screen}` : ''}`, at: now() });
    push({ ...r, via: 'chat', words: String(text).slice(0, 60) });
    return games.illustratedNote(g.id, r, { now: now() });
  }
  return { onMessage };
}

module.exports = { createRoomChat };
