'use strict';

// 小游戏 (src/main/game-window.js, docs/mini-games.md §2): the game page's whole bridge. It asks once for the game
// to play (its manifest, sprites index and game:// base), her look, the shared time / weather settings and its
// saved progress; it saves the time / weather it is set to (main checks them with the settings schema, saves
// them and every window hears the new settings), reports what she did (main keeps today's quests and gives
// affection), saves the game's own state (crops, the lamp …), pats her and closes itself.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};
const gameId = new URLSearchParams(location.search).get('game') || '';

contextBridge.exposeInMainWorld('game', {
  boot: () => ipcRenderer.invoke('game:boot', { game: gameId }),
  set: (patch) => ipcRenderer.invoke('game:set', patch),
  touch: () => ipcRenderer.invoke('game:touch'),
  event: (ev, ctx) => ipcRenderer.invoke('game:event', { game: gameId, ev, ctx }),
  // 像素房间 (room@1): { cmd: 'start' | 'stop' | 'tick' | 'seen' | 'theme' | 'state', … } — main settles the round
  activity: (cmd) => ipcRenderer.invoke('game:activity', cmd),
  // 她的房间 (illustrated-room@1): { cmd: 'set' | 'tick' | 'seen' | 'state', … } — main decides (games.js
  // illustratedCommand); chat(text) is her chat (PetService.chat), the reply comes back as onSay / onSayDelta
  room: (cmd) => ipcRenderer.invoke('game:room', cmd),
  chat: (text) => ipcRenderer.invoke('game:chat', { text }),
  onRoom: on('game:room'),
  onSay: on('game:say'),
  onSayDelta: on('game:say-delta'),
  onThinking: on('game:thinking'),
  saveState: (state) => ipcRenderer.send('game:state', { game: gameId, state }),
  close: (reason) => ipcRenderer.send('game:close', { reason }),
  openStore: () => ipcRenderer.send('game:open-store'),
  onUpdate: on('game:update'),
  onSettings: on('game:settings'),
  onView: on('game:view'),
  onShown: on('game:shown'),
  onHidden: on('game:hidden'),
});
