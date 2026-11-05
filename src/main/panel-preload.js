'use strict';

// 她的面板 (src/main/pet-panel.js): the panel page's whole bridge — it can press one of its buttons, report its
// height, send what was typed in its chat box (and the draft, for 插个嘴) and ask to close; it hears what to
// show (when it opens and whenever that changes), when it closed, and how its 🎤 recording goes (onMic).
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('petPanel', {
  act: (act, food, text) => ipcRenderer.send('pet-panel:act', { act, food, text }),
  chat: (text) => ipcRenderer.send('pet-panel:chat', { text }),
  draft: (text) => ipcRenderer.send('pet-panel:draft', { text }),
  size: (w, h) => ipcRenderer.send('pet-panel:size', { w, h }),
  close: (reason) => ipcRenderer.send('pet-panel:close-self', { reason }),
  onShow: on('pet-panel:show'),
  onClosed: on('pet-panel:closed'),
  onRestore: on('pet-panel:restore'),
  onMic: on('pet-panel:mic'),
});
