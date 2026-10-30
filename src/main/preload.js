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
  spaces: () => ipcRenderer.invoke('spaces'),
  hatch: (speciesId, name, localAbilities, space) => ipcRenderer.invoke('hatch', { speciesId, name, localAbilities, space }),
  act: (kind, food) => ipcRenderer.invoke('act', { kind, food }),
  // Touch a body part: a zone id ('head', 'chest', …) or { x, y } in the sprite's visible box (0..1).
  touch: (target) => ipcRenderer.invoke('touch', target === undefined ? null : target),
  talkTopic: (id) => ipcRenderer.invoke('talk-topic', { id }),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  confirmAge: (adult) => ipcRenderer.invoke('confirm-age', { adult }),
  setAdult: (on) => ipcRenderer.invoke('set-adult', { on }),
  equipOutfit: (id) => ipcRenderer.invoke('equip-outfit', { id }),
  markSeen: (kind) => ipcRenderer.invoke('mark-seen', { kind }),
  unlockAll: () => ipcRenderer.invoke('unlock-all'),
  setAppearance: (id) => ipcRenderer.invoke('set-appearance', { id }),
  setModel: (key) => ipcRenderer.invoke('set-model', { key }),
  refreshModels: () => ipcRenderer.invoke('refresh-models'),
  importPack: () => ipcRenderer.invoke('import-pack'),
  removePack: (id) => ipcRenderer.invoke('remove-pack', { id }),
  openPacksFolder: () => ipcRenderer.send('open-packs-folder'),
  previewPetScale: (scale) => ipcRenderer.invoke('preview-pet-scale', { scale }),
  setPetScale: (scale) => ipcRenderer.invoke('set-pet-scale', { scale }),
  panel: (open) => ipcRenderer.send('panel', !!open),
  chat: (text, images, files) => ipcRenderer.invoke('chat', { text, images, files }),
  // Absolute path of a dropped/pasted File (empty for in-memory data such as screenshots).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  pickImages: () => ipcRenderer.invoke('pick-images'),
  setLocal: (on) => ipcRenderer.invoke('set-local', { on }),
  cancel: () => ipcRenderer.send('cancel'),
  release: (opts) => ipcRenderer.invoke('release', opts),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', { dx, dy }),
  moveTo: (x, y) => ipcRenderer.send('move-to', { x, y }),
  workArea: () => ipcRenderer.invoke('work-area'),
  switchCharacter: (id, name) => ipcRenderer.invoke('switch-character', { id, name }),
  // dsh-pet effects: behaviour switches, visitors (同屏伙伴), pets knocking into each other, local API
  setPrefs: (patch) => ipcRenderer.invoke('set-prefs', patch),
  // 语音 (core/tts.js): synthesise a line in main (keys never come here), stop it, configure the engines
  ttsSynthesize: (text, mood) => ipcRenderer.invoke('tts-synthesize', { text, mood }),
  ttsCancel: () => ipcRenderer.send('tts-cancel'),
  ttsPrewarm: () => ipcRenderer.invoke('tts-prewarm'),
  setTts: (patch) => ipcRenderer.invoke('set-tts', patch),
  ttsClearCache: () => ipcRenderer.invoke('tts-clear-cache'),
  setVisitors: (ids) => ipcRenderer.invoke('set-visitors', { ids }),
  setApi: (opts) => ipcRenderer.invoke('set-api', opts),
  apiStatus: () => ipcRenderer.invoke('api-status'),
  visitorBoot: () => ipcRenderer.invoke('visitor-boot'),
  pose: (p) => ipcRenderer.send('pose', p),
  peers: () => ipcRenderer.invoke('peers'),
  kick: (id, vx, vy) => ipcRenderer.send('kick', { id, vx, vy }),
  apiReply: (id, result) => ipcRenderer.send('api-reply', { id, result }),
  onKicked: on('kicked'),
  onApiCmd: on('api-cmd'),
  onApiStatus: on('api-status'),
  quit: () => ipcRenderer.send('quit'),
  place: (mode) => ipcRenderer.send('place', mode),
  openLog: () => ipcRenderer.send('open-log'),
  debugSet: (patch) => ipcRenderer.invoke('debug-set', patch),
  debugImportPack: (dir) => ipcRenderer.invoke('debug-import-pack', dir),
  debugHeartbeat: () => ipcRenderer.invoke('debug-heartbeat'),
  onUpdate: on('update'),
  onSay: on('say'),
  onThinking: on('thinking'),
  onAffection: on('affection'),
  onSettings: on('settings'),
  onUpdateStatus: on('update-status'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  onHatchStep: on('hatch-step'),
  onLoginPrompt: on('login-prompt'),
});
