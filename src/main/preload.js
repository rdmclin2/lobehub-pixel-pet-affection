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
  // `characterId`: who she is (T-2764: one character per look, e.g. dafeiyu-pixel)
  hatch: (characterId, name, localAbilities, space) => ipcRenderer.invoke('hatch', { characterId, name, localAbilities, space }),
  act: (kind, food) => ipcRenderer.invoke('act', { kind, food }),
  // 重置姿势 (T-2830): whatever she does, back to the idle (wakes her if asleep) → { ok, source, before, cleared, figures, woke }
  resetPose: (source) => ipcRenderer.invoke('reset-pose', { source }),
  // 小游戏 (src/main/game-window.js): she goes into the game played last (her desktop window hides meanwhile)
  openScene: (source) => ipcRenderer.invoke('scene-open', { source }),
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
  setModel: (key, species) => ipcRenderer.invoke('set-model', { key, species }),
  refreshModels: () => ipcRenderer.invoke('refresh-models'),
  setSystemRole: (text, species) => ipcRenderer.invoke('set-system-role', { text, species }),
  setFraming: (mode, species) => ipcRenderer.invoke('set-framing', { mode, species }),
  importPack: () => ipcRenderer.invoke('import-pack'),
  removePack: (id) => ipcRenderer.invoke('remove-pack', { id }),
  // 下载角色: the characters that do not ship with the app (core/catalog.js)
  downloadCharacter: (id) => ipcRenderer.invoke('catalog-download', { id }),
  cancelDownload: (id) => ipcRenderer.invoke('catalog-cancel', { id }),
  removeDownload: (id) => ipcRenderer.invoke('catalog-remove', { id }),
  // her own Live2D model: import (file dialog in main), then its picture drawn here, and her size in the window
  importLive2d: (species) => ipcRenderer.invoke('import-live2d', { species }),
  importVrm: (species) => ipcRenderer.invoke('import-vrm', { species }),
  // 导出… (refused in main for a VRM model that may not be redistributed); a license link in the system browser
  exportPack: (id) => ipcRenderer.invoke('export-pack', { id }),
  openLink: (url) => ipcRenderer.invoke('open-link', { url }),
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
  // 授权 (main/permissions.js): system permissions one at a time + the folders her local tools may use
  permStatus: () => ipcRenderer.invoke('perm-status'),
  permRequest: (kind) => ipcRenderer.invoke('perm-request', { kind }),
  permOpenSettings: (kind) => ipcRenderer.invoke('perm-open-settings', { kind }),
  aiFoldersAdd: () => ipcRenderer.invoke('ai-folders-add'),
  aiFoldersSet: (patch) => ipcRenderer.invoke('ai-folders-set', patch),
  cancel: () => ipcRenderer.send('cancel'),
  // ⋯ → 重新开始: her next line opens a new LobeHub topic; the old one is kept, not deleted
  newTopic: () => ipcRenderer.invoke('new-topic'),
  release: (opts) => ipcRenderer.invoke('release', opts),
  moveBy: (dx, dy) => ipcRenderer.send('move-by', { dx, dy }),
  moveTo: (x, y) => ipcRenderer.send('move-to', { x, y }),
  workArea: () => ipcRenderer.invoke('work-area'),
  // the screen cursor (DIP), for a VRM figure's gaze while the cursor is outside her window
  cursorPoint: () => ipcRenderer.invoke('cursor-point'),
  switchCharacter: (id, name) => ipcRenderer.invoke('switch-character', { id, name }),
  // dsh-pet effects: behaviour switches, visitors (同屏伙伴), pets knocking into each other, local API
  setPrefs: (patch) => ipcRenderer.invoke('set-prefs', patch),
  setVrmPosture: (packId, posture) => ipcRenderer.invoke('set-vrm-posture', { packId, posture }),
  vrmLibraryInfo: () => ipcRenderer.invoke('vrm-library-info'),
  // 语音 (core/tts.js): synthesise a line in main (keys never come here), stop it, configure the engines
  ttsSynthesize: (text, mood) => ipcRenderer.invoke('tts-synthesize', { text, mood }),
  ttsCancel: () => ipcRenderer.send('tts-cancel'),
  ttsPrewarm: () => ipcRenderer.invoke('tts-prewarm'),
  setTts: (patch) => ipcRenderer.invoke('set-tts', patch),
  ttsClearCache: () => ipcRenderer.invoke('tts-clear-cache'),
  openVoicePacksFolder: () => ipcRenderer.send('open-voicepacks-folder'),
  reloadVoicePacks: () => ipcRenderer.invoke('voicepacks-reload'),
  // 按角色切换语音包 (main.js set-voice-pack): { characterId, packId: <pack id> | 'auto' } -> { ok, state, settings }
  setVoicePack: (characterId, packId) => ipcRenderer.invoke('set-voice-pack', { characterId, packId }),
  voicePackState: (characterId) => ipcRenderer.invoke('voice-pack-state', { characterId }),
  // 我的语音包 (main.js set-user-voice-pack): a pack id (e.g. generic-male) or 'auto' -> { ok, choice, state, settings }
  setUserVoicePack: (packId) => ipcRenderer.invoke('set-user-voice-pack', { packId }),
  // 语音输入 (core/asr.js): recognition runs in main (keys and lh never come here). transcribe takes the recorder's
  // bytes (ArrayBuffer / Uint8Array) and its mime type; ms = how long the clip is.
  asr: {
    transcribe: (bytes, mime, ms) => ipcRenderer.invoke('asr-transcribe', { bytes, mime, ms }),
    cancel: () => ipcRenderer.send('asr-cancel'),
    test: (provider) => ipcRenderer.invoke('asr-test', { provider }),
    set: (patch) => ipcRenderer.invoke('set-asr', patch),
    micAccess: () => ipcRenderer.invoke('asr-mic-access'), // 'granted' | 'denied' | 'restricted' (macOS asks once)
  },
  // 插个嘴 (core/interject.js): the unsent chat draft (only while 插个嘴 and its 聊天框 source are on), the owner's
  // reaction to a remark ('mute' | 'like'), and the rules / records the settings UI shows
  interject: {
    draft: (text) => ipcRenderer.send('interject-draft', { text }),
    feedback: (id, kind) => ipcRenderer.invoke('interject-feedback', { id, kind }),
    rules: () => ipcRenderer.invoke('interject-rules'),
    addRule: (rule) => ipcRenderer.invoke('interject-add-rule', { rule }),
    deleteRule: (id) => ipcRenderer.invoke('interject-delete-rule', { id }),
    setRule: (id, disabled) => ipcRenderer.invoke('interject-set-rule', { id, disabled }),
    clearDecisions: () => ipcRenderer.invoke('interject-clear-decisions'),
    decisions: (limit) => ipcRenderer.invoke('interject-decisions', { limit }),
    set: (patch) => ipcRenderer.invoke('set-interject', patch),
  },
  onInterject: on('interject'),
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
  // dancing (docs/vrm-dance.md): list → { dir, source, vrm, reason?, dances: [{ id, name, duration, music, loop… }] };
  // play({ id?, name?, loop? }) → { ok, id, name… } | { ok: false, reason: not-vrm | no-dance | load-failed…, message? }
  dance: {
    list: () => ipcRenderer.invoke('dances:list'),
    play: (opts) => ipcRenderer.invoke('dance:play', opts || {}),
    stop: () => ipcRenderer.invoke('dance:stop'),
    state: () => ipcRenderer.invoke('dance:state'),
  },
  onApiStatus: on('api-status'),
  // 她的面板 (src/main/pet-panel.js): its own small window beside her. open / toggle get { source, anchor (her box
  // on the screen), payload (what it shows) } and answer { visible }; update re-draws it while open; onAct hears
  // a button pressed in it ({ act, food? }), onClosed when and why it closed
  panel: {
    open: (p) => ipcRenderer.invoke('pet-panel:open', p),
    toggle: (p) => ipcRenderer.invoke('pet-panel:toggle', p),
    close: (reason) => ipcRenderer.send('pet-panel:close', { reason }),
    update: (payload) => ipcRenderer.send('pet-panel:update', payload),
    onAct: on('panel-act'),
    onClosed: on('panel-closed'),
  },
  quit: () => ipcRenderer.send('quit'),
  place: (mode) => ipcRenderer.send('place', mode),
  openLog: () => ipcRenderer.send('open-log'),
  // 配置后台: the settings window, at a section ('behavior', 'characters/claude' …); single instance
  openAdmin: (section) => ipcRenderer.invoke('open-admin', { section }),
  debugSet: (patch) => ipcRenderer.invoke('debug-set', patch),
  debugExpireModels: () => ipcRenderer.invoke('debug-expire-models'),
  debugImportPack: (dir) => ipcRenderer.invoke('debug-import-pack', dir),
  debugNextOpen: (p) => ipcRenderer.invoke('debug-next-open', p),
  debugNextSave: (p) => ipcRenderer.invoke('debug-next-save', p),
  debugOpenedLinks: () => ipcRenderer.invoke('debug-opened-links'),
  debugAdmin: () => ipcRenderer.invoke('debug-admin'),
  debugTray: () => ipcRenderer.invoke('debug-tray'),
  debugTrayClick: (label) => ipcRenderer.invoke('debug-tray-click', { label }),
  debugTrayPopup: (opts) => ipcRenderer.invoke('debug-tray-popup', opts || {}),
  debugHeartbeat: () => ipcRenderer.invoke('debug-heartbeat'),
  debugInterjectFlush: () => ipcRenderer.invoke('debug-interject-flush'),
  debugInterjectResetCooldown: () => ipcRenderer.invoke('debug-interject-reset-cooldown'),
  debugInterjectInput: (source, text) => ipcRenderer.invoke('debug-interject-input', { source, text }),
  debugVoiceHotkey: () => ipcRenderer.invoke('debug-voice-hotkey'),
  debugVoiceHotkeyStatus: () => ipcRenderer.invoke('debug-voice-hotkey-status'),
  debugMicAccess: (v) => ipcRenderer.invoke('debug-mic-access', v),
  debugPetPanel: () => ipcRenderer.invoke('debug-pet-panel'),
  debugScene: () => ipcRenderer.invoke('debug-scene'),
  debugSceneToggle: (source, game) => ipcRenderer.invoke('debug-scene-toggle', { source, game }),
  debugHidePet: (minimize) => ipcRenderer.invoke('debug-hide-pet', { minimize }),
  // 检查更新… (顶栏菜单 / 托盘): the dialogs it showed, the button the next one answers with, a forced Updater state
  debugUpdateDialogs: () => ipcRenderer.invoke('debug-update-dialogs'),
  debugUpdateAnswer: (id) => ipcRenderer.invoke('debug-update-answer', id),
  debugUpdateState: (patch) => ipcRenderer.invoke('debug-update-state', patch),
  onUpdate: on('update'),
  onWindowShown: on('window-shown'),
  onSay: on('say'),
  onThinking: on('thinking'),
  // 流式回复: { id, n, kind, turnId, text (shown so far), withheld?, restart? } while a reply is written; { id, ok, reason } when it ends
  onChatDelta: on('chat-delta'),
  onChatDone: on('chat-done'),
  onAffection: on('affection'),
  onSettings: on('settings'),
  // 快捷键唤起语音对话 (main/voice-hotkey.js): { accelerator, label, source } — start listening, or stop and recognise
  onVoiceHotkey: on('voice-hotkey'),
  onUpdateStatus: on('update-status'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  checkUpdate: () => ipcRenderer.invoke('update-check'),
  onHatchStep: on('hatch-step'),
  onLoginPrompt: on('login-prompt'),
});
