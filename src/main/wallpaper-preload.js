'use strict';
// 桌面壁纸 (src/main/wallpaper/host.js, docs/wallpaper-mode.md §2.1): the wallpaper page's whole bridge. It asks once
// for what to draw (the cleaned manifest, the game:// base, her look, the time / weather settings, the display and
// the part of the picture she may walk in), then only listens: the frame rate (wallpaper:power), her coming and
// going (wallpaper:pet), a display change, her look and the settings. It reports that it is ready, whether the
// page is hidden (covered) and where she is in the picture (so 叫她出来 puts her desktop window there).
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('wallpaper', {
  boot: () => ipcRenderer.invoke('wallpaper:boot'),
  report: (msg) => ipcRenderer.send('wallpaper:report', msg),
  onPower: on('wallpaper:power'),
  onPet: on('wallpaper:pet'),
  onDisplay: on('wallpaper:display'),
  onView: on('wallpaper:view'),
  onSettings: on('wallpaper:settings'),
});
