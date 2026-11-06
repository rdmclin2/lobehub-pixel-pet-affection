'use strict';

// 她的面板 (src/main/pet-panel.js): the panel page's whole bridge — it can press one of its buttons, report its
// height and ask to close; it hears what to show (when it opens and whenever that changes) and when it closed.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('petPanel', {
  act: (act, food) => ipcRenderer.send('pet-panel:act', { act, food }),
  size: (w, h) => ipcRenderer.send('pet-panel:size', { w, h }),
  close: (reason) => ipcRenderer.send('pet-panel:close-self', { reason }),
  onShow: on('pet-panel:show'),
  onClosed: on('pet-panel:closed'),
});
