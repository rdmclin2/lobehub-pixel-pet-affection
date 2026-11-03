'use strict';

// The settings window's bridge (docs/admin-console-design.md §5.2): `window.petAdmin`, a whitelist of the
// settings and roster channels, plus 聊天 with a character (`petAdmin.chat`, docs/admin-chat.md: the
// `admin-chat-*` channels only; the pet window's `chat` channel stays out, the console has its own turn).
// No window moving, no debug hooks. Keys are write-only: they go in through `set('keys.<id>', value)` and
// only "has a key" ever comes back; the chat uses the LobeHub CLI login in main and never sees a token.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('petAdmin', {
  // { schema, settings, view, roster, packs, update, apiStatus, version, platform, testMode, dataDir }
  boot: () => ipcRenderer.invoke('admin-boot'),
  state: () => ipcRenderer.invoke('admin-state'),
  // one setting by its schema key ('prefs.roam', 'tts.endpoints.fish', 'keys.fish' …), checked in main
  set: (key, value) => ipcRenderer.invoke('admin-set', { key, value }),
  reset: (keys) => ipcRenderer.invoke('admin-reset', { keys }),
  relaunch: () => ipcRenderer.invoke('admin-relaunch'),
  whoami: () => ipcRenderer.invoke('whoami'),
  apiStatus: () => ipcRenderer.invoke('api-status'),
  newApiToken: () => ipcRenderer.invoke('set-api', { newToken: true }),
  // characters (角色列表 / 角色详情)
  switchCharacter: (id, name) => ipcRenderer.invoke('switch-character', { id, name }),
  setModel: (key, species) => ipcRenderer.invoke('set-model', { key, species }),
  refreshModels: () => ipcRenderer.invoke('refresh-models'),
  setSystemRole: (text, species) => ipcRenderer.invoke('set-system-role', { text, species }),
  setFraming: (mode, species) => ipcRenderer.invoke('set-framing', { mode, species }),
  // VRM 姿势: per VRM pack (settings.vrmPostures), the same channel the pet window's 衣柜 uses
  setVrmPosture: (packId, posture) => ipcRenderer.invoke('set-vrm-posture', { packId, posture }),
  unlockAll: (species) => ipcRenderer.invoke('unlock-all', { species }),
  // 服饰: put on one of a character's unlocked outfits (none = the current one, as the pet window's 衣柜 did)
  equipOutfit: (id, species) => ipcRenderer.invoke('equip-outfit', { id, species }),
  // 角色包: import (file dialog in main), export, remove, folders
  importPack: () => ipcRenderer.invoke('import-pack'),
  importLive2d: (species) => ipcRenderer.invoke('import-live2d', { species }),
  importVrm: (species) => ipcRenderer.invoke('import-vrm', { species }),
  removePack: (id) => ipcRenderer.invoke('remove-pack', { id }),
  // 下载角色: the characters that do not ship with the app (core/catalog.js)
  downloadCharacter: (id) => ipcRenderer.invoke('catalog-download', { id }),
  cancelDownload: (id) => ipcRenderer.invoke('catalog-cancel', { id }),
  removeDownload: (id) => ipcRenderer.invoke('catalog-remove', { id }),
  onCatalogProgress: on('catalog-progress'),
  exportPack: (id) => ipcRenderer.invoke('export-pack', { id }),
  setLive2dHeight: (id, height) => ipcRenderer.invoke('set-live2d-height', { id, height }),
  openPacksFolder: () => ipcRenderer.send('open-packs-folder'),
  // voice
  ttsClearCache: () => ipcRenderer.invoke('tts-clear-cache'),
  // 试听: one fixed line through the chosen engine (A14 / PG-02)
  ttsTest: () => ipcRenderer.invoke('admin-tts-test'),
  openVoicePacksFolder: () => ipcRenderer.send('open-voicepacks-folder'),
  reloadVoicePacks: () => ipcRenderer.invoke('voicepacks-reload'),
  asrTest: (provider) => ipcRenderer.invoke('asr-test', { provider }),
  // content & safety: adult content on only through the 18+ confirmation (confirmAge(true))
  setAdult: (on) => ipcRenderer.invoke('set-adult', { on }),
  confirmAge: (adult) => ipcRenderer.invoke('confirm-age', { adult }),
  // data, update, about
  newTopic: () => ipcRenderer.invoke('new-topic'),
  release: (opts) => ipcRenderer.invoke('release', opts),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  openLog: () => ipcRenderer.send('open-log'),
  openLink: (url) => ipcRenderer.invoke('open-link', { url }),
  showPet: () => ipcRenderer.send('admin-show-pet'),
  // 找回桌宠: show her and put her back in the bottom-right corner (⋯ → 回到右下角)
  placePet: () => ipcRenderer.invoke('admin-place-pet'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  // the pet on the desktop plays one action (happy, pat, play …) — 和她互动 on her stage
  cue: (state) => ipcRenderer.invoke('admin-cue', { state }),
  // the old ⋯ menu (T-2718): 动作 (cue above, plus 'turn'), 回到右下角, 退出; 话题 and 聊天记录 (the same
  // channels the pet window used: a topic is started by the pet, history comes filtered from main)
  home: () => ipcRenderer.invoke('admin-home'),
  quit: () => ipcRenderer.invoke('admin-quit'),
  talkTopic: (id) => ipcRenderer.invoke('talk-topic', { id }),
  markSeen: (kind, species) => ipcRenderer.invoke('mark-seen', { kind, species }),
  historyList: () => ipcRenderer.invoke('history-list'),
  historyGet: (id) => ipcRenderer.invoke('history-get', { id }),
  // 插个嘴 (core/interject.js): the rules her owner's reactions settled and the recent decisions — data, not
  // settings; the same channels the pet window uses. Switch a rule off / on, delete it, clear the records.
  interjectRules: () => ipcRenderer.invoke('interject-rules'),
  interjectDecisions: (limit) => ipcRenderer.invoke('interject-decisions', { limit }),
  interjectSetRule: (id, disabled) => ipcRenderer.invoke('interject-set-rule', { id, disabled }),
  interjectDeleteRule: (id) => ipcRenderer.invoke('interject-delete-rule', { id }),
  interjectClearDecisions: () => ipcRenderer.invoke('interject-clear-decisions'),
  onInterject: on('interject'),
  // pushes: the whole admin state after any change (from either window), update / API status
  onState: on('admin-state'),
  onUpdateStatus: on('update-status'),
  onApiStatus: on('api-status'),
  // 聊天 (docs/admin-chat.md): one conversation per character, her 聊天记录; a reply streams as onDelta events.
  // Her model is chosen with setModel(key, species) above (the same pick as her page → 模型).
  chat: {
    listCharacters: () => ipcRenderer.invoke('admin-chat-characters'),
    history: (speciesId, opts = {}) => ipcRenderer.invoke('admin-chat-history', { speciesId, before: opts.before, limit: opts.limit }),
    pickImages: () => ipcRenderer.invoke('admin-chat-pick-images'),
    send: (req) => ipcRenderer.invoke('admin-chat-send', req),
    abort: (speciesId) => ipcRenderer.invoke('admin-chat-abort', { speciesId }),
    onDelta: on('admin-chat-delta'),
    onDone: on('admin-chat-done'),
    onChanged: on('admin-chat-changed'),
  },
});
