'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('pet', {
  boot: () => ipcRenderer.invoke('boot'),
  whoami: () => ipcRenderer.invoke('whoami'),
  hatch: (speciesId, name, localAbilities) => ipcRenderer.invoke('hatch', { speciesId, name, localAbilities }),
  act: (kind, food) => ipcRenderer.invoke('act', { kind, food }),
  talkTopic: (id) => ipcRenderer.invoke('talk-topic', { id }),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  confirmAge: (adult) => ipcRenderer.invoke('confirm-age', { adult }),
  setAdult: (on) => ipcRenderer.invoke('set-adult', { on }),
  equipOutfit: (id) => ipcRenderer.invoke('equip-outfit', { id }),
  markSeen: (kind) => ipcRenderer.invoke('mark-seen', { kind }),
  panel: (open) => ipcRenderer.send('panel', !!open),
  chat: (text, images, files) => ipcRenderer.invoke('chat', { text, images, files }),
  // Absolute path of a dropped/pasted File (empty for in-memory data such as screenshots).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  pickImages: () => ipcRenderer.invoke('pick-images'),
  setLocal: (on) => ipcRenderer.invoke('set-local', { on }),
  cancel: () => ipcRenderer.send('cancel'),
  release: (opts) => ipcRenderer.invoke('release', opts),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', { dx, dy }),
  quit: () => ipcRenderer.send('quit'),
  place: (mode) => ipcRenderer.send('place', mode),
  openLog: () => ipcRenderer.send('open-log'),
  debugSet: (patch) => ipcRenderer.invoke('debug-set', patch),
  debugHeartbeat: () => ipcRenderer.invoke('debug-heartbeat'),
  onUpdate: on('update'),
  onSay: on('say'),
  onThinking: on('thinking'),
  onAffection: on('affection'),
  onSettings: on('settings'),
  onHatchStep: on('hatch-step'),
  onLoginPrompt: on('login-prompt'),
});
