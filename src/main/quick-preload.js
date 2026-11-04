'use strict';

// 快捷调用面板 (src/main/quick-panel.js): the panel page's whole bridge — it can run one of its rows, report its
// height and ask to close; it hears when it opens, when an update check moves on and when it was closed.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('quick', {
  run: (id) => ipcRenderer.invoke('quick:run', { id }),
  size: (h) => ipcRenderer.send('quick:size', { h }),
  close: (reason) => ipcRenderer.send('quick:close', { reason }),
  onOpen: on('quick:open'),
  onFeedback: on('quick:feedback'),
  onClosed: on('quick:closed'),
});
