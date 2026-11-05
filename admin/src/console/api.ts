/**
 * `window.petAdmin` (src/main/admin-preload.js): the settings window's only way to the main process.
 * Types here mirror what main sends (core/settings-schema.js describe(), core/roster.js, PetService views).
 */

export type FieldType =
  | 'switch'
  | 'select'
  | 'segmented'
  | 'slider'
  | 'number'
  | 'text'
  | 'url'
  | 'hotkey'
  | 'secret'
  | 'token'
  | 'readonly'
  | 'visitors'
  | 'adult'
  | 'local'
  | 'perCharacter'
  /** 我的语音包 (settings.tts.voicePack): set through set-user-voice-pack */
  | 'voicePack';

export interface FieldOption {
  label: string;
  value: string;
}

export interface FieldDef {
  card: string;
  default?: unknown;
  /** hotkey: the default in HotkeyInput's format ('mod+shift+space') */
  defaultKeys?: string;
  dependsOn?: { key: string; value: unknown };
  desc?: string;
  format?: 'percent' | 'time';
  internal?: boolean;
  key: string;
  label: string;
  live?: boolean;
  max?: number;
  maxLength?: number;
  min?: number;
  options?: FieldOption[];
  page: string;
  pattern?: string;
  placeholder?: string;
  /** hotkey: combinations the app itself uses (HotkeyInput format) and what they do */
  reserved?: { accelerator: string; keys: string; label: string }[];
  restart?: boolean;
  sensitive?: boolean;
  step?: number;
  store: 'settings' | 'keys' | 'pet' | 'view';
  type: FieldType;
  unit?: string;
  validator?: string;
}

export interface NavGroupDef {
  items: { icon: string; label: string; page: string }[];
  key: string;
  label: string;
  /** Which rail place the group sits under (`RailDef.key`). */
  section: string;
}

/** The window's four places (小屋 / 角色 / 玩法 / 设置); every other page is one level below one of them. */
export interface RailDef {
  icon: string;
  key: string;
  label: string;
  page: string;
}

export interface Schema {
  defaults: Record<string, any>;
  fields: FieldDef[];
  nav: NavGroupDef[];
  rail: RailDef[];
  pages: Record<string, { description: string; title: string }>;
  restartKeys: string[];
}

/** One action of a sprite sheet: `frames` cells from (row, col), played at `fps`. */
export interface SpriteAction {
  col: number;
  fps: number;
  frames: number;
  row: number;
}

export interface Preview {
  actions?: Record<string, SpriteAction> | null;
  frame?: { height: number; width: number };
  pixelated?: boolean;
  type: 'sprite' | 'image' | 'video';
  url: string;
}

export interface PackOption {
  adult?: boolean;
  author?: string;
  /** Her daily outfit in this pack: a playable sheet, a picture or her clip (null: nothing to show). */
  cover?: Preview | null;
  description?: string;
  height?: number;
  id: string;
  kind: string;
  license?: string;
  name: string;
  outfits?: number;
  source: string;
  version?: string;
  vrm?: any;
}

export interface ModelOption {
  hosted?: boolean;
  key: string;
  label?: string;
  [k: string]: unknown;
}

/**
 * One row per character (T-2764: every look is a character of her own — 「大肥鱼 · 像素」「大肥鱼 · Live2D」 …).
 * `id` is the character id (her pack's id, or `<base>-clips`); `base` the persona (src/characters/<base>.json)
 * whose agent, name, affection (`met`), model and 个性化设定 all of the base's characters share; `pack`, `kind`,
 * `preview` and `outfits` are the character's own.
 */
export interface RosterRow {
  accent: string;
  base: string;
  blurb: string;
  catchphrase: string;
  credits: string[];
  current: boolean;
  displayName: string;
  id: string;
  kind: string | null;
  kindLabel: string;
  /** what sets this look apart in her name: 像素 / Live2D / 成年版（18+）… */
  label: string;
  likes: string[];
  met: null | { affection: number; name: string; progress: any; stage: string };
  model: null | { applied: string | null; chosen?: boolean; current: string | null; loaded: boolean; options: ModelOption[]; pending: boolean };
  /** her character's name, 「大肥鱼 · 像素」 */
  name: string;
  /** her base's name, 大肥鱼 */
  nameZh: string;
  pack: null | { adult: boolean; author?: string; id: string; kind: string; license?: string; name: string; outfits?: number; source: string; vrm?: any };
  preview: Preview | null;
  /** her face for lists and chat bubbles (a built-in character's drawn avatar, pack://…); null: use `preview` */
  avatar: string | null;
  source: string;
  sourceLabel: string;
  systemRole: string;
  title: string;
  vendor: string;
  voice: null | { lang?: string; tts?: any };
  /** the 语音包 in force for her base (main.js voicePackState): label 专属 / 通用·男 / 通用·女; source user | own | generic */
  voicePack: null | VoicePackRef;
  /** the 语音包 picker: her pick ('auto' or a pack id) and what can be picked */
  voicePackPick: VoicePackPick;
  personality: string;
  packKinds: { builtin: number; kind: string; label: string; user: number }[];
  outfits: OutfitRow[] | null;
}

export interface VoicePackRef {
  builtIn: boolean;
  credit: string;
  engine: string;
  engineLabel: string;
  gender: 'female' | 'male' | null;
  id: string;
  kind: 'character' | 'generic' | 'style';
  /** 专属 / 通用·男 / 通用·女 / 风格·可爱 / 「某某 的专属」 */
  label: string;
  lines: number;
  name: string;
  /** downloaded from 商店 → 语音包 */
  store: boolean;
  /** user: picked for her · default: 我的语音包 (settings.tts.voicePack) · own: her own (自动) · generic: 自动回退 to the generic pack of her gender */
  source: 'default' | 'generic' | 'own' | 'user';
  sourceLabel: string;
}

export interface VoicePackOption {
  builtIn: boolean;
  character: string | null;
  gender: 'female' | 'male' | null;
  group: 'generic' | 'other' | 'own' | 'style';
  id: string;
  kind: 'character' | 'generic' | 'style';
  label: string;
  lines: number;
  name: string;
  store: boolean;
  style: string | null;
}

/** a 商店 → 语音包 entry not downloaded yet: listed in the picker, not pickable */
export interface VoicePackRemote {
  gender: 'female' | 'male' | null;
  id: string;
  name: string;
  style: string | null;
  styleLabel: string;
}

export interface VoicePackPick {
  /** 'none' (不使用) · 'auto' (内置) · a pack id */
  choice: string;
  /** 我的语音包 in force ('auto' or a pack id): the default of every character without a pick of her own */
  userChoice: string;
  engineVoice: null | { engine: string; fromPack: boolean; voiceId: string | null };
  gender: 'female' | 'male' | null;
  genderSource: string | null;
  /** a pick whose pack is gone (counts as 自动) */
  missing: string | null;
  notDownloaded: VoicePackRemote[];
  options: VoicePackOption[];
}

export interface UserFace {
  avatar: string | null;
  name: string;
}

export interface OutfitRow {
  condition: string | null;
  desc: string;
  equipped: boolean;
  id: string;
  isNew: boolean;
  label: string;
  locked: boolean;
  preview: Preview | null;
  rating: string | null;
  stageName: string;
}

export interface PackRow {
  adult: boolean;
  author: string;
  exportable: boolean;
  id: string;
  kind: string;
  kindLabel: string;
  license: string;
  name: string;
  outfits: number;
  removable: boolean;
  source: string;
  sourceLabel: string;
  species: string;
  speciesName: string;
  version: string;
}

/** A character in 商店 → 角色: does not ship with the app, can be downloaded (src/core/catalog.js listAll). */
export interface CatalogRow {
  adult: boolean;
  author: string;
  base: string;
  bytes: number;
  description: string;
  id: string;
  kind: string;
  license: string;
  name: string;
  outfits: number;
  /** relative to src/renderer: catalog/<id>.png */
  picture: string | null;
  pixelated: boolean;
  sizeLabel: string;
  version: string;
  /** on this machine now (downloaded) */
  installed: boolean;
  /** a VRM model's license, read from the model file (scripts/build-store-assets.js) */
  licenseRows?: { href?: string; label: string; text: string }[];
  redistributable?: boolean;
}

/** 商店 → 舞蹈 (core/catalog.js listDances) */
export interface StoreDanceRow {
  bytes: number;
  credit: string;
  /** the package's readme, its first lines */
  description: string;
  duration: number;
  face: boolean;
  id: string;
  installed: boolean;
  music: boolean;
  name: string;
  /** relative to src/renderer: catalog/dances/<id>.jpg */
  picture: string | null;
  sizeLabel: string;
}

/** 商店 → 语音包 (core/catalog.js listVoicePacks + core/voice-store.js storeRows) */
export interface StoreVoiceRow {
  bytes: number;
  credit: string;
  description: string;
  engine: string;
  error?: string;
  gender: 'female' | 'male' | null;
  id: string;
  installed: boolean;
  installing?: boolean;
  lines: number;
  name: string;
  percent?: number;
  /** relative to src/renderer: catalog/voices/<id>.ogg (the 试听 line, ships with the app) */
  sample: { file: string; seconds?: number; text: string };
  seconds: number;
  sizeLabel: string;
  state: 'downloading' | 'installed' | 'remote';
  stateLabel: string;
  style: string;
  styleLabel: string;
  version: string;
  voiceId: string;
}

export interface VoiceStoreResult {
  errors?: string[];
  id?: string;
  name?: string;
  ok: boolean;
  reason?: string;
  settings?: any;
  store?: { dir: string; voicePacks: StoreVoiceRow[] };
  text?: string;
}

/** `catalog-progress` (src/main/catalog.js) */
export interface DownloadProgress {
  id: string;
  received?: number;
  reason?: string;
  state: 'downloading' | 'installing' | 'done' | 'failed';
  text?: string;
  total?: number;
}

export interface AdminState {
  apiStatus: any;
  catalog?: CatalogRow[];
  downloads?: DownloadProgress[];
  packs: PackRow[];
  roster: RosterRow[];
  settings: Record<string, any>;
  update: any;
  view: any;
}

export interface BootData extends AdminState {
  dataDir?: string;
  platform: string;
  schema: Schema;
  testMode: boolean;
  version: string;
}

/** 快捷键唤起语音对话 (src/main/voice-hotkey.js status()): settings.hotkeyStatus. */
export interface HotkeyStatus {
  accelerator: string;
  code?: 'reserved' | 'taken' | string;
  keys: string;
  label: string;
  message?: string;
  platform: string;
  state: 'ok' | 'disabled' | 'invalid' | 'conflict';
  triggers?: number;
}

export interface SetResult {
  hasKey?: boolean;
  key: string;
  message?: string;
  ok: boolean;
  pendingRestart?: string[];
  reason?: string;
  restart?: boolean;
  settings?: Record<string, any>;
  value?: unknown;
}

export interface PetAdminApi {
  apiStatus: () => Promise<any>;
  asrTest: (provider?: string) => Promise<any>;
  boot: () => Promise<BootData>;
  checkUpdate: () => Promise<any>;
  confirmAge: (adult: boolean) => Promise<any>;
  cue: (state: string) => Promise<{ ok: boolean; reason?: string }>;
  /** `species`: whose wardrobe (a character id); none = the current character's. */
  equipOutfit: (id: string, species?: string) => Promise<any>;
  exportPack: (id: string) => Promise<any>;
  importLive2d: (species: string) => Promise<any>;
  importPack: () => Promise<any>;
  importVrm: (species: string) => Promise<any>;
  setPackBase: (id: string, base: string) => Promise<{ base?: string | null; generic?: boolean; ok: boolean; reason?: string }>;
  installUpdate: () => Promise<any>;
  newApiToken: () => Promise<any>;
  newTopic: () => Promise<any>;
  onApiStatus: (cb: (st: any) => void) => () => void;
  onState: (cb: (st: AdminState) => void) => () => void;
  onUpdateStatus: (cb: (st: any) => void) => () => void;
  openLink: (url: string) => Promise<any>;
  openDataFolder: () => Promise<any>;
  openLog: () => void;
  openPacksFolder: () => void;
  openVoicePacksFolder: () => void;
  refreshModels: () => Promise<any>;
  relaunch: () => Promise<any>;
  release: (opts: { deleteAgent: boolean }) => Promise<any>;
  reloadVoicePacks: () => Promise<{ errors: string[]; settings: any }>;
  /** 按角色切换语音包 (main.js set-voice-pack): a pack id or 'auto'; saved and in force for her next line */
  setVoicePack: (characterId: string, packId: string) => Promise<{ ok: boolean; reason?: string; settings?: any; state?: any }>;
  voicePackState: (characterId?: string) => Promise<{ ok: boolean; reason?: string; state?: any }>;
  /** 我的语音包 (main.js set-user-voice-pack): a pack id (e.g. generic-male) or 'auto'; saved in settings.tts.voicePack */
  setUserVoicePack: (packId: string) => Promise<{ choice?: string; ok: boolean; reason?: string; settings?: any; state?: any }>;
  removePack: (id: string) => Promise<any>;
  downloadCharacter: (id: string) => Promise<{ id?: string; name?: string; ok: boolean; reason?: string; text?: string }>;
  cancelDownload: (id: string) => Promise<{ ok: boolean }>;
  removeDownload: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  onCatalogProgress: (cb: (p: DownloadProgress) => void) => () => void;
  reset: (keys: string[]) => Promise<{ ok: boolean; results: SetResult[]; settings: any }>;
  set: (key: string, value: unknown) => Promise<SetResult>;
  setAdult: (on: boolean) => Promise<any>;
  setLive2dHeight: (id: string, height: number) => Promise<any>;
  setModel: (key: string, species: string) => Promise<any>;
  setSystemRole: (text: string, species: string) => Promise<any>;
  setFraming: (mode: 'auto' | 'full' | 'half', species: string) => Promise<any>;
  setVrmPosture: (packId: string, posture: string) => Promise<any>;
  /** VRM 动作库 (T-5084, src/main/vrm-library.js): where the motions come from, and 动作试播 in the pet window */
  vrmLibraryInfo: () => Promise<VrmLibraryInfo | null>;
  vrmLibraryPick: () => Promise<{ ok: boolean; reason?: string; status?: VrmLibraryStatus }>;
  vrmLibraryUnlink: () => Promise<{ ok: boolean; reason?: string; status?: VrmLibraryStatus }>;
  vrmMotions: () => Promise<{ library?: VrmFigureLibrary | null; manual?: { id: string; kind: string; left: number | null } | null; motions?: VrmMotionRow[]; ok: boolean; reason?: string }>;
  vrmMotionPlay: (opts: { group?: string; id?: string; loop?: boolean }) => Promise<{ id?: string; label?: string; layer?: string; ok: boolean; reason?: string }>;
  vrmMotionStop: () => Promise<{ id?: string | null; ok: boolean; reason?: string; stopped?: boolean }>;
  placePet: () => Promise<any>;
  showPet: () => void;
  state: () => Promise<AdminState>;
  switchCharacter: (id: string, name?: string) => Promise<any>;
  ttsClearCache: () => Promise<any>;
  unlockAll: (species: string) => Promise<any>;
  interjectClearDecisions: () => Promise<{ ok: boolean }>;
  interjectDecisions: (limit?: number) => Promise<{ decisions: InterjectDecision[]; status: any }>;
  interjectDeleteRule: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  interjectRules: () => Promise<{ rules: InterjectRule[] }>;
  interjectSetRule: (id: string, disabled: boolean) => Promise<{ ok: boolean; reason?: string; rule?: InterjectRule }>;
  onInterject: (cb: (e: { decision: InterjectDecision | null; decisionId: string | null; rule: InterjectRule | null; type: string }) => void) => () => void;
  historyGet: (id: string) => Promise<{ ok: boolean; reason?: string; session?: HistorySession }>;
  historyList: () => Promise<{ sessions: HistorySummary[] }>;
  home: () => Promise<{ ok: boolean; reason?: string }>;
  /** `species`: whose 衣柜 was looked at (a character id); none = the current character's. */
  markSeen: (kind: 'outfit' | 'topic', species?: string) => Promise<{ marked?: number; ok: boolean }>;
  quit: () => Promise<{ ok: boolean }>;
  talkTopic: (id: string) => Promise<any>;
  dances: () => Promise<DanceList>;
  dancePlay: (id: string, loop?: boolean) => Promise<{ id?: string; message?: string; name?: string; ok: boolean; reason?: string }>;
  danceStop: () => Promise<{ ok: boolean; reason?: string }>;
  danceState: () => Promise<DanceState | null>;
  danceLoop: (on: boolean) => Promise<{ loop?: boolean; ok: boolean; reason?: string }>;
  danceImportPick: (folder?: boolean) => Promise<DanceDraft | ImportFail>;
  danceImportExtra: (token: string, kind: 'audio' | 'cover') => Promise<{ coverData?: string; label: string; ok: true; path: string } | ImportFail>;
  danceImportCommit: (draft: { audio: string | null; cover: string | null; motion: string; name: string; token: string }) => Promise<{ dance: DanceRow; id: string; name: string; ok: true } | ImportFail>;
  danceImportCancel: () => Promise<{ ok: boolean }>;
  danceRemove: (id: string) => Promise<{ id?: string; message?: string; name?: string; ok: boolean; reason?: string }>;
  danceStore: () => Promise<{ dances: StoreDanceRow[]; downloads: DownloadProgress[]; vrm: boolean }>;
  danceDownload: (id: string) => Promise<{ id?: string; name?: string; ok: boolean; reason?: string; text?: string }>;
  danceDownloadCancel: (id: string) => Promise<{ ok: boolean }>;
  voiceStore: () => Promise<{ dir: string; voicePacks: StoreVoiceRow[] }>;
  voiceDownload: (id: string) => Promise<VoiceStoreResult>;
  voiceDownloadCancel: (id: string) => Promise<{ ok: boolean }>;
  voiceRemove: (id: string) => Promise<VoiceStoreResult>;
  whoami: () => Promise<any>;
  /** the LobeHub account's avatar as a data: URL (null: none, or not reachable and never cached) — T-2839 */
  userAvatar: () => Promise<UserFace | { ok: false; reason: string }>;
  /** 聊天 (docs/admin-chat.md): talk with a character — her agent, her topic, her 聊天记录. */
  chat: ChatApi;
}

// --- 聊天 (docs/admin-chat.md §1) -------------------------------------------------------------------------
// One conversation per character: her own agent and topic, her 聊天记录. Her model: `setModel(key, species)`.

export interface ChatCharacter {
  count: number;
  current: boolean;
  id: string;
  lastAt: number | null;
  met: boolean;
  name: string;
  preview: string;
}

export interface ChatAttachment {
  id: string;
  mime: string;
  name: string;
  size: number;
  /** data URL; null when the file is gone */
  url: string | null;
}

export interface ChatMessage {
  attachments: ChatAttachment[];
  createdAt: number;
  error?: string;
  id: string;
  model: string | null;
  role: 'user' | 'assistant';
  status: 'done' | 'error' | 'aborted';
  text: string;
  turnId: string | null;
  /** pictures sent on the desktop: only their count was kept */
  unsavedImages: number;
  via: 'console' | 'desktop';
}

export type ChatImageInput = { path: string } | { dataUrl: string; name?: string } | string;

export interface ChatPickedImage {
  dataUrl: string;
  mime: string;
  name: string;
  path: string;
  size: number;
}

export interface ChatHistory {
  hasMore: boolean;
  /** The reply being written so far (when streaming). */
  live?: { text: string; turnId: string } | null;
  messages: ChatMessage[];
  met: boolean;
  ok: boolean;
  reason?: string;
  speciesId: string;
  streaming: boolean;
  total: number;
}

export interface ChatSendResult {
  code?: string | null;
  error?: string;
  message?: ChatMessage;
  ok: boolean;
  reason?: string;
  speciesId?: string;
  turnId?: string;
  userMessage?: ChatMessage;
}

/** One piece of the reply being written (core/chat-live.js): an increment `{ at, append }` or the whole text `{ text }`. */
export interface ChatDelta {
  append?: string;
  at?: number;
  restart?: boolean;
  speciesId: string;
  text?: string;
  turnId: string;
}

export interface ChatDone {
  error?: string;
  message: ChatMessage;
  ok: boolean;
  reason?: 'aborted' | 'error';
  speciesId: string;
  turnId: string;
}

export interface ChatApi {
  abort: (speciesId?: string) => Promise<{ aborted: boolean; ok: boolean }>;
  history: (speciesId: string, opts?: { before?: string; limit?: number }) => Promise<ChatHistory>;
  listCharacters: () => Promise<{ busy: string | null; characters: ChatCharacter[]; ok: boolean }>;
  onChanged: (cb: (d: { speciesId: string | null }) => void) => () => void;
  onDelta: (cb: (d: ChatDelta) => void) => () => void;
  onDone: (cb: (d: ChatDone) => void) => () => void;
  pickImages: () => Promise<{ images: ChatPickedImage[]; ok: boolean; reason?: string; rejected?: { message: string; name: string; reason: string }[] }>;
  send: (req: { images?: ChatImageInput[]; speciesId: string; text?: string }) => Promise<ChatSendResult>;
}

/** 插个嘴 (core/interject.js): a rule settled from the owner's reactions, and one decision record. */
export interface InterjectRule {
  bucket?: string;
  category?: string;
  createdAt: number;
  disabled?: boolean;
  effect: 'allow' | 'block';
  hits: number;
  id: string;
  note: string;
  origin: 'engaged' | 'ignored' | 'like' | 'manual' | 'mute';
  source?: string;
}

export interface InterjectDecision {
  at: number;
  category?: string;
  feedback?: 'engaged' | 'ignored' | 'like' | 'mute' | null;
  id: string;
  probability: number | null;
  reason: string;
  said?: string;
  source: string;
  stage: 'decided' | 'error' | 'prefilter';
  summary: string;
  verdict: 'interject' | 'silent' | 'skip';
}

/** 聊天记录 (PetService.history / historySession): only the conversations the owner started. */
export interface HistorySummary {
  count: number;
  endedAt?: number;
  id: string;
  name: string;
  preview?: string;
  startedAt: number;
}

export interface HistoryMessage {
  at: number;
  attachments?: { files?: string[]; images?: number } | null;
  role: 'user' | 'pet';
  status?: string | null;
  text?: string;
  turnId?: string;
}

export interface HistorySession extends HistorySummary {
  messages: HistoryMessage[];
}

/** 话题 (view.topics, core/dialogue.js listTopics). */
export interface TopicRow {
  condition?: string | null;
  id: string;
  isNew?: boolean;
  label: string;
  locked: boolean;
  rating?: string;
  stage: string;
  stageName: string;
  talkedToday?: boolean;
  unlocked?: boolean;
}

declare global {
  interface Window {
    petAdmin?: PetAdminApi;
  }
}

export const api = (): PetAdminApi => {
  if (!window.petAdmin) throw new Error('设置窗口没有连上桌宠（window.petAdmin 不存在）');
  return window.petAdmin;
};

export const hasBridge = () => !!window.petAdmin;

/** Value at a dotted path ('tts.endpoints.fish'). */
export const at = (obj: any, key: string): any => key.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), obj);

/** Readable failure text for the per-character / pack channels (reasons from PetService and PackStore). */
export const REASON: Record<string, string> = {
  adult: '18+ 外观需要先确认已满 18 周岁并打开成人向内容',
  'not-downloaded': '她还没有下载：先在角色图鉴里下载这个角色',
  busy: '她正在忙（说话或切换中），稍后再试',
  'no-pet': '桌宠还没出现在桌面上',
  'no-window': '桌宠窗口没有打开',
  timeout: '桌宠没有回应',
  canceled: '已取消',
  empty: '还没有唤醒桌宠，先在桌宠窗口里完成唤醒',
  'not-met': '还没见过她：先切换到她并起个名字',
  'bad-state': '没有这个动作',
  'no-redistribution': '这个模型的授权不允许导出',
  'too-long': '太长了',
  unknown: '找不到这一项',
  'not-found': '找不到这一项（可能已经删掉了）',
  'unknown-character': '没有这个角色',
  'unknown-pack': '这个语音包已经不在了，先重新读取语音包',
  locked: '这套服饰还没解锁',
  hidden: '这套服饰需要先打开成人向内容',
  unavailable: '这位角色没有这套服饰',
  'not-vrm': '她现在不是 VRM 外观，没有动作可播',
  'not-ready': '她还在载入，稍后再试',
  'no-clip': '动作库里没有这个动作',
  dancing: '她正在跳舞，等舞停了再试',
  'no-index': '这个文件夹里没有 library.json（选烘焙输出的文件夹，例如 baked-v2）',
  'inside-repo': '动作库不能放在项目仓库里面',
};
export const reasonText = (r: any): string => (r && (r.message || r.text || REASON[r.reason] || (r.errors && r.errors.join('；')) || r.reason)) || '操作没有成功';

/** 舞蹈 (src/main/main.js danceList, docs/vrm-dance.md §3.8): one dance of the list. */
export interface DanceRow {
  builtin: boolean;
  cover: boolean;
  coverUrl: string | null;
  credit?: string;
  duration: number;
  face: boolean;
  id: string;
  importedAt?: string;
  loop: boolean;
  music: boolean;
  name: string;
}

export interface DanceList {
  dances: DanceRow[];
  dir: string | null;
  error?: string;
  importing?: boolean;
  kind?: string | null;
  message?: string;
  reason?: string;
  refused?: string;
  source: string;
  vrm: boolean;
}

/** The pet window's dance controller state (renderer/vrm-dance.js state()); null when she is not dancing. */
export interface DanceState {
  audio: string;
  duration: number;
  id: string;
  loop: boolean;
  music: boolean;
  name: string;
  paused: boolean;
  pausedBy: string | null;
  state: string;
  t: number;
}

export interface ImportFail {
  detail?: string;
  message?: string;
  ok: false;
  reason: string;
}

/** 导入舞蹈: what was picked, for the confirm dialog (src/main/dance-import.js inspect). */
export interface DanceDraft {
  audio: string | null;
  audios: { label: string; path: string }[];
  cover: string | null;
  coverData: string | null;
  covers: { label: string; path: string }[];
  credit: string | null;
  duration: number;
  folder: string | null;
  motion: string;
  motions: { duration?: number; keys?: number; label: string; path: string }[];
  name: string;
  ok: true;
  readme: { excerpt: string; file: string } | null;
  source: string;
  token: string;
  warnings: string[];
}

/** VRM 动作库 (T-5084): what is in the folder the app serves (src/main/vrm-library.js libraryStatus). */
export interface VrmLibraryStatus {
  bakedAt: string | null;
  clips: number;
  dir: string | null;
  error?: string;
  files: number;
  looked?: string[];
  source: 'env' | 'linked' | 'userData' | 'dev' | 'none';
  styles: Record<string, number>;
}
export interface VrmLibraryInfo {
  dir: string | null;
  source: string;
  status?: VrmLibraryStatus;
}
/** How the figure on screen loaded it (renderer/vrm.js libraryInfo). */
export interface VrmFigureLibrary {
  failed: { error: string; id: string }[];
  loaded: number;
  reason: 'ok' | 'partial' | 'no-library' | 'empty-index' | 'fetch-failed' | 'all-failed' | 'no-clip-for-model';
  set: string;
  sets: string[];
  state: string;
  style: string;
  wanted: number;
}
export interface VrmMotionRow {
  category: string;
  duration: number | null;
  group: string | null;
  id: string;
  kind: string;
  label: string;
  loop: boolean;
  mask: string;
  slot: string;
  style: string;
}
