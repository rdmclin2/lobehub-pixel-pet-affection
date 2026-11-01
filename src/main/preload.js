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
  // 聊天记录: conversations the owner started, already filtered in main (list: summaries; get: one with its messages)
  historyList: () => ipcRenderer.invoke('history-list'),
  historyGet: (id) => ipcRenderer.invoke('history-get', { id }),
  // per-character settings: `species` is whose (⋯ → 角色列表 → her page); left out = the current character
  unlockAll: (species) => ipcRenderer.invoke('unlock-all', { species }),
  setAppearance: (id, species) => ipcRenderer.invoke('set-appearance', { id, species }),
  setModel: (key, species) => ipcRenderer.invoke('set-model', { key, species }),
  refreshModels: () => ipcRenderer.invoke('refresh-models'),
  setSystemRole: (text, species) => ipcRenderer.invoke('set-system-role', { text, species }),
  importPack: () => ipcRenderer.invoke('import-pack'),
  removePack: (id) => ipcRenderer.invoke('remove-pack', { id }),
  // her own Live2D model: import (file dialog in main), then its picture drawn here, and her size in the window
  importLive2d: (species) => ipcRenderer.invoke('import-live2d', { species }),
  savePackPreview: (id, dataUrl) => ipcRenderer.invoke('save-pack-preview', { id, dataUrl }),
  setLive2dHeight: (id, height) => ipcRenderer.invoke('set-live2d-height', { id, height }),
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
  // ⋯ → 重新开始: her next line opens a new LobeHub topic; the old one is kept, not deleted
  newTopic: () => ipcRenderer.invoke('new-topic'),
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
  openVoicePacksFolder: () => ipcRenderer.send('open-voicepacks-folder'),
  reloadVoicePacks: () => ipcRenderer.invoke('voicepacks-reload'),
  // 语音输入 (core/asr.js): recognition runs in main (keys and lh never come here). transcribe takes the recorder's
  // bytes (ArrayBuffer / Uint8Array) and its mime type; ms = how long the clip is.
  asr: {
    transcribe: (bytes, mime, ms) => ipcRenderer.invoke('asr-transcribe', { bytes, mime, ms }),
    cancel: () => ipcRenderer.send('asr-cancel'),
    test: (provider) => ipcRenderer.invoke('asr-test', { provider }),
    set: (patch) => ipcRenderer.invoke('set-asr', patch),
    micAccess: () => ipcRenderer.invoke('asr-mic-access'), // 'granted' | 'denied' | 'restricted' (macOS asks once)
  },
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
  debugNextOpen: (p) => ipcRenderer.invoke('debug-next-open', p),
  debugHeartbeat: () => ipcRenderer.invoke('debug-heartbeat'),
  onUpdate: on('update'),
  onSay: on('say'),
  onThinking: on('thinking'),
  // 流式回复: { id, n, kind, turnId, text (shown so far), withheld? } while a reply is written; { id, ok, reason } when it ends
  onChatDelta: on('chat-delta'),
  onChatDone: on('chat-done'),
  onAffection: on('affection'),
  onSettings: on('settings'),
  onUpdateStatus: on('update-status'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  onHatchStep: on('hatch-step'),
  onLoginPrompt: on('login-prompt'),
});
