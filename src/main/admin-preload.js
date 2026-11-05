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
  // 文件夹与系统权限 (main/permissions.js, docs/permissions.md): status, 授权 one permission, its System Settings
  // pane, 添加文件夹… (system picker in main), remove one / 允许运行命令
  permStatus: () => ipcRenderer.invoke('perm-status'),
  permRequest: (kind) => ipcRenderer.invoke('perm-request', { kind }),
  permOpenSettings: (kind) => ipcRenderer.invoke('perm-open-settings', { kind }),
  aiFoldersAdd: () => ipcRenderer.invoke('ai-folders-add'),
  aiFoldersSet: (patch) => ipcRenderer.invoke('ai-folders-set', patch),
  // { name, avatar }: the LobeHub account's avatar as a data: URL, or null (T-2839)
  userAvatar: () => ipcRenderer.invoke('user-avatar'),
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
  // VRM 动作库 (T-5084): where the motions come from, link another folder / forget it, and 动作试播
  vrmLibraryInfo: () => ipcRenderer.invoke('vrm-library-info'),
  vrmLibraryPick: () => ipcRenderer.invoke('vrm-library-pick'),
  vrmLibraryUnlink: () => ipcRenderer.invoke('vrm-library-unlink'),
  vrmMotions: () => ipcRenderer.invoke('vrm-motions:list'),
  vrmMotionPlay: (opts) => ipcRenderer.invoke('vrm-motion:play', opts),
  vrmMotionStop: () => ipcRenderer.invoke('vrm-motion:stop'),
  unlockAll: (species) => ipcRenderer.invoke('unlock-all', { species }),
  // 服饰: put on one of a character's unlocked outfits (none = the current one, as the pet window's 衣柜 did)
  equipOutfit: (id, species) => ipcRenderer.invoke('equip-outfit', { id, species }),
  // 角色包: import (file dialog in main), export, remove, folders
  importPack: () => ipcRenderer.invoke('import-pack'),
  importLive2d: (species) => ipcRenderer.invoke('import-live2d', { species }),
  importVrm: (species) => ipcRenderer.invoke('import-vrm', { species }),
  // 导入确认 → 设定: 通用 ("generic") or one of the characters
  setPackBase: (id, base) => ipcRenderer.invoke('set-pack-base', { id, base }),
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
  openVoicePacksFolder: () => ipcRenderer.send('open-voicepacks-folder'),
  reloadVoicePacks: () => ipcRenderer.invoke('voicepacks-reload'),
  // 按角色切换语音包 (main.js set-voice-pack): { characterId, packId: <pack id> | 'auto' } -> { ok, state, settings }
  setVoicePack: (characterId, packId) => ipcRenderer.invoke('set-voice-pack', { characterId, packId }),
  voicePackState: (characterId) => ipcRenderer.invoke('voice-pack-state', { characterId }),
  // 我的语音包 (main.js set-user-voice-pack): a pack id (e.g. generic-male) or 'auto' -> { ok, choice, state, settings }
  setUserVoicePack: (packId) => ipcRenderer.invoke('set-user-voice-pack', { packId }),
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
  // 舞蹈 (docs/vrm-dance.md §6.2): the list, 让她跳 / 停止 / 循环播放 (played by the pet window), 导入舞蹈 (pick →
  // a draft → commit, baked in main) and 删除舞蹈
  dances: () => ipcRenderer.invoke('dances:list'),
  dancePlay: (id, loop) => ipcRenderer.invoke('dance:play', { id, loop }),
  danceStop: () => ipcRenderer.invoke('dance:stop'),
  danceState: () => ipcRenderer.invoke('dance:state'),
  danceLoop: (on) => ipcRenderer.invoke('dance:loop', { on }),
  danceImportPick: (folder) => ipcRenderer.invoke('dance-import-pick', { folder: !!folder }),
  danceImportExtra: (token, kind) => ipcRenderer.invoke('dance-import-extra', { token, kind }),
  danceImportCommit: (draft) => ipcRenderer.invoke('dance-import-commit', draft),
  danceImportCancel: () => ipcRenderer.invoke('dance-import-cancel'),
  danceRemove: (id) => ipcRenderer.invoke('dance-remove', { id }),
  // 商店 → 舞蹈: the store's dances (已下载 or not), download / cancel; progress arrives as `catalog-progress`
  danceStore: () => ipcRenderer.invoke('dance-store'),
  danceDownload: (id) => ipcRenderer.invoke('dance-download', { id }),
  danceDownloadCancel: (id) => ipcRenderer.invoke('dance-download-cancel', { id }),
  // 商店 → 语音包 (core/voice-store.js): the store's style packs with their state, download / cancel / delete;
  // progress arrives as `catalog-progress`
  voiceStore: () => ipcRenderer.invoke('voice-store'),
  voiceDownload: (id) => ipcRenderer.invoke('voice-download', { id }),
  voiceDownloadCancel: (id) => ipcRenderer.invoke('voice-download-cancel', { id }),
  voiceRemove: (id) => ipcRenderer.invoke('voice-remove', { id }),
  // 商店 → 小游戏 (core/game-index.js, core/game-store.js, docs/mini-games.md §7): the store's games, download / update /
  // cancel / delete, and 开始玩 (opens the game window with her in it); progress arrives as `catalog-progress`
  gameStore: (opts) => ipcRenderer.invoke('game-store', { refresh: !!(opts && opts.refresh) }),
  // a newer version of an installed game came out (main read the games repository's catalog)
  onGameUpdates: on('game-updates'),
  gameDetail: (id) => ipcRenderer.invoke('game-detail', { id }),
  gameDownload: (id) => ipcRenderer.invoke('game-download', { id }),
  gameDownloadCancel: (id) => ipcRenderer.invoke('game-download-cancel', { id }),
  gameRemove: (id) => ipcRenderer.invoke('game-remove', { id }),
  gamePlay: (id) => ipcRenderer.invoke('game-play', { id }),
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
  // 角色 → 表情包 (docs/stickers-design.md §4): her sets (built-in + 我的); 添加 opens a file dialog (several
  // pictures), each one checked in main; 删除 / 改名 only her own set.
  stickers: {
    list: (speciesId) => ipcRenderer.invoke('stickers-list', { speciesId }),
    pickAndAdd: (speciesId) => ipcRenderer.invoke('stickers-pick-add', { speciesId }),
    remove: (speciesId, ids) => ipcRenderer.invoke('stickers-remove', { speciesId, ids }),
    update: (speciesId, id, patch = {}) => ipcRenderer.invoke('stickers-update', { speciesId, id, label: patch.label, desc: patch.desc }),
    onChanged: on('stickers-changed'),
  },
  // 商店 → 表情包 (docs/stickers-design.md §5.2 方案 B): the official sets on the CDN; 获取 for a character
  // (progress arrives as `catalog-progress`), cancel, 移除
  stickerStore: {
    list: (opts = {}) => ipcRenderer.invoke('sticker-store', { refresh: !!opts.refresh }),
    detail: (id) => ipcRenderer.invoke('sticker-store-detail', { id }),
    get: (id, speciesId) => ipcRenderer.invoke('sticker-store-get', { id, speciesId }),
    cancel: (id) => ipcRenderer.invoke('sticker-store-cancel', { id }),
    remove: (id) => ipcRenderer.invoke('sticker-store-remove', { id }),
    // 上架到商店 (T-10796): her 「我的」 set to the community shelf; 我上架的 (review state); 下架
    publishInfo: (speciesId) => ipcRenderer.invoke('sticker-publish-info', { speciesId }),
    publish: (speciesId, meta) => ipcRenderer.invoke('sticker-publish', { speciesId, meta }),
    mine: () => ipcRenderer.invoke('sticker-publish-mine'),
    unpublish: (id) => ipcRenderer.invoke('sticker-unpublish', { id }),
  },
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
