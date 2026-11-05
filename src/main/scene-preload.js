'use strict';

// 像素小院 (src/main/scene-window.js): the yard page's whole bridge. It asks for her look and the yard's settings
// once, saves the time / weather it is set to (main checks and saves them in settings.json, then every window
// hears the new settings), pats her, and closes itself; it hears settings and look changes, and when it is
// shown or hidden.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('scene', {
  boot: () => ipcRenderer.invoke('scene:boot'),
  set: (patch) => ipcRenderer.invoke('scene:set', patch),
  touch: () => ipcRenderer.invoke('scene:touch'),
  act: (act, prop) => ipcRenderer.send('scene:act', { act, prop }),
  close: (reason) => ipcRenderer.send('scene:close', { reason }),
  onSettings: on('scene:settings'),
  onView: on('scene:view'),
  onShown: on('scene:shown'),
  onHidden: on('scene:hidden'),
});
