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
  | 'perCharacter';

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
  reserved?: { keys: string; label: string }[];
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

export interface RosterRow {
  accent: string;
  blurb: string;
  catchphrase: string;
  credits: string[];
  current: boolean;
  displayName: string;
  id: string;
  kind: string | null;
  kindLabel: string;
  likes: string[];
  met: null | { affection: number; name: string; progress: any; stage: string };
  model: null | { applied: string | null; chosen?: boolean; current: string | null; loaded: boolean; options: ModelOption[]; pending: boolean };
  nameZh: string;
  pack: null | { adult: boolean; author?: string; id: string; kind: string; license?: string; name: string; source: string; vrm?: any };
  packCount: number;
  preview: Preview | null;
  source: string;
  sourceLabel: string;
  systemRole: string;
  title: string;
  vendor: string;
  voice: null | { lang?: string; tts?: any };
  voicePack: null | { builtIn: boolean; credit: string; engine: string; engineLabel: string; id: string; lines: number; name: string };
  personality: string;
  packKinds: { builtin: number; kind: string; label: string; user: number }[];
  outfits: OutfitRow[] | null;
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

export interface AdminState {
  apiStatus: any;
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
  equipOutfit: (id: string) => Promise<any>;
  exportPack: (id: string) => Promise<any>;
  importLive2d: (species: string) => Promise<any>;
  importPack: () => Promise<any>;
  importVrm: (species: string) => Promise<any>;
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
  removePack: (id: string) => Promise<any>;
  reset: (keys: string[]) => Promise<{ ok: boolean; results: SetResult[]; settings: any }>;
  set: (key: string, value: unknown) => Promise<SetResult>;
  setAdult: (on: boolean) => Promise<any>;
  setAppearance: (id: string, species: string) => Promise<any>;
  setLive2dHeight: (id: string, height: number) => Promise<any>;
  setModel: (key: string, species: string) => Promise<any>;
  setSystemRole: (text: string, species: string) => Promise<any>;
  setFraming: (mode: 'auto' | 'full' | 'half', species: string) => Promise<any>;
  setVrmPosture: (packId: string, posture: string) => Promise<any>;
  placePet: () => Promise<any>;
  showPet: () => void;
  state: () => Promise<AdminState>;
  switchCharacter: (id: string, name?: string) => Promise<any>;
  ttsClearCache: () => Promise<any>;
  unlockAll: (species: string) => Promise<any>;
  historyGet: (id: string) => Promise<{ ok: boolean; reason?: string; session?: HistorySession }>;
  historyList: () => Promise<{ sessions: HistorySummary[] }>;
  home: () => Promise<{ ok: boolean; reason?: string }>;
  markSeen: (kind: 'outfit' | 'topic') => Promise<{ marked?: number; ok: boolean }>;
  quit: () => Promise<{ ok: boolean }>;
  talkTopic: (id: string) => Promise<any>;
  whoami: () => Promise<any>;
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
  'unknown-character': '没有这个角色',
  locked: '这套服饰还没解锁',
  hidden: '这套服饰需要先打开成人向内容',
  unavailable: '她现在的形象包没有这套服饰',
};
export const reasonText = (r: any): string => (r && (r.message || r.text || REASON[r.reason] || (r.errors && r.errors.join('；')) || r.reason)) || '操作没有成功';
