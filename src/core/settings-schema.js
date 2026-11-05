'use strict';

// The admin console's (配置后台) description of every setting: which page and card it sits on, the control
// it gets, its default, its range and how a value is checked. Plain data (no functions) goes to the window
// through `admin-boot`, so the console renders its forms from here; `validate` runs in main before anything
// is saved. Defaults are read from normalizeSettings(null), never written twice.
//
// store: 'settings' = settings.json (core/settings.js) · 'keys' = tts-keys.json (write-only secrets)
//        'pet' = pet.json (shared fields) · 'view' = read-only facts shown next to the settings
// Every settings.json leaf is listed (test/admin-schema.test.js checks it against normalizeSettings(null)).

const settingsLib = require('./settings');
const { ENGINES: TTS_ENGINES, FALLBACKS, LOCAL_APIS: TTS_LOCAL_APIS, endpointOkFor } = require('./tts');
const asrLib = require('./asr');
const musicLib = require('./music');
const hotkeyLib = require('./hotkey');

const DEFAULTS = settingsLib.normalizeSettings(null);
const at = (o, key) => key.split('.').reduce((v, p) => (v && typeof v === 'object' ? v[p] : undefined), o);

// Navigation. The window's rail has six places only (RAIL: the four + 商店 and 聊天, .agents/ux R-05 exceptions); everything else sits one level down: 角色 →
// her page, 商店 → a category (角色 now; 声音包 and more later), 玩法 / 设置 → a hub of tiles → one page per
// tile (docs/admin-console-design.md §6.3). NAV groups are those hub sections; `section` says which rail place a
// group belongs to.
const RAIL = [
  { key: 'home', label: '小屋', icon: 'House', page: 'overview' },
  { key: 'characters', label: '角色', icon: 'Users', page: 'characters' },
  // 商店 (docs/characters.md 「内置与下载」): what can be downloaded — characters now, 声音包 etc. later
  { key: 'store', label: '商店', icon: 'Store', page: 'store' },
  { key: 'play', label: '玩法', icon: 'Gamepad2', page: 'play' },
  { key: 'settings', label: '设置', icon: 'Settings', page: 'settings' },
  // 聊天 (T-2765): a daily AI chat of its own (docs/admin-chat.md), not a setting — its own place, one page
  { key: 'chat', label: '聊天', icon: 'MessageCircle', page: 'chat' },
];

const NAV = [
  { key: 'chat', section: 'chat', label: '聊天', items: [{ page: 'chat', label: '聊天', icon: 'MessageCircle' }] },
  { key: 'home', section: 'home', label: '小屋', items: [{ page: 'overview', label: '小屋', icon: 'House' }] },
  { key: 'characters', section: 'characters', label: '角色', items: [{ page: 'characters', label: '角色图鉴', icon: 'Users' }] },
  { key: 'store', section: 'store', label: '商店', items: [{ page: 'store', label: '商店', icon: 'Store' }] },
  {
    key: 'play', section: 'play', label: '陪伴方式', items: [
      { page: 'behavior', label: '桌宠行为', icon: 'PawPrint' },
      { page: 'proactive', label: '主动搭话与好感', icon: 'HeartHandshake' },
      { page: 'visitors', label: '同屏伙伴', icon: 'UsersRound' },
    ],
  },
  // the pet window's old ⋯ menu and its 话题 panel (T-2718): what she can talk about, what you talked
  // about, and the desktop controls (动作 / 回到右下角 / 退出)
  {
    key: 'together', section: 'play', label: '和她一起', items: [
      { page: 'topics', label: '话题', icon: 'MessagesSquare' },
      { page: 'history', label: '聊天记录', icon: 'History' },
      { page: 'desk', label: '桌面上的她', icon: 'Monitor' },
      // VRM dancing (docs/vrm-dance.md §6.2): the dances, 让她跳 / 停止 / 循环播放, 导入舞蹈, 删除舞蹈, the music's volume
      { page: 'dances', label: '舞蹈', icon: 'Music' },
    ],
  },
  {
    key: 'voice', section: 'settings', label: '声音', items: [
      { page: 'tts', label: '朗读', icon: 'Volume2' },
      { page: 'asr', label: '语音输入', icon: 'Mic' },
      { page: 'voicepacks', label: '语音包', icon: 'AudioLines' },
      // 音乐创作 (core/music.js, T-5088 / T-5651): 音乐服务（fal.ai / ElevenLabs / MiniMax）、各服务的端点与模型、格式、保存目录与超时
      { page: 'music', label: '音乐创作', icon: 'Music' },
    ],
  },
  {
    key: 'looks', section: 'settings', label: '资源与外观', items: [
      { page: 'packs', label: '角色包', icon: 'Shirt' },
      { page: 'appearance', label: '外观主题', icon: 'Palette' },
    ],
  },
  {
    key: 'connect', section: 'settings', label: '连接', items: [
      { page: 'connection', label: 'LobeHub 与本机', icon: 'Cloud' },
      { page: 'api', label: '对外接口', icon: 'Webhook' },
    ],
  },
  {
    key: 'system', section: 'settings', label: '系统', items: [
      { page: 'safety', label: '内容与安全', icon: 'ShieldCheck' },
      { page: 'update', label: '版本与更新', icon: 'RefreshCw' },
      { page: 'about', label: '数据与关于', icon: 'Info' },
    ],
  },
];

const PAGES = {
  overview: { title: '小屋', description: '她现在的样子、你们的关系，和今天的陪伴状态。' },
  characters: { title: '角色图鉴', description: '遇见过的、还没遇见的她们。点开一位，看她的故事、给她换衣服、调她的模型和设定。' },
  store: { title: '商店', description: '下载更多内容：现在有角色，以后还会有声音包等。下载好的角色出现在角色图鉴里。' },
  chat: { title: '聊天', description: '和 AI 日常聊天：可以发图片、换模型，会话保存在这台电脑上。和桌宠的对话互不影响。' },
  play: { title: '玩法', description: '她在桌面上怎么陪你：走动、搭话、好感，还有同屏的伙伴。' },
  settings: { title: '设置', description: '声音、资源、连接和系统。' },
  packs: { title: '角色包', description: '每个角色包都是一位独立角色（像素 / 图片 / 全动态 / Live2D / VRM），都在角色图鉴里。导入角色在这里；导入的可以导出或删除。' },
  visitors: { title: '同屏伙伴', description: '让其他模型娘一起待在桌面上（她们不聊天，只陪玩）。' },
  behavior: { title: '桌宠行为', description: '桌面上的大小与取景（全身 / 半身）、走动、音效、梗图和触摸。改动立即生效。' },
  proactive: { title: '主动搭话与好感', description: '她多久主动说一次话、每小时最多花几次模型调用；插个嘴（默认关闭）的来源、额度、阈值和沉淀的规则；以及好感度的每日上限和衰减。改动立即生效。' },
  topics: { title: '话题', description: '按好感度阶段解锁的话题：点「聊聊」，她就在桌面上开口。每个话题每天第一次聊会加好感。' },
  history: { title: '聊天记录', description: '你主动发起的聊天，只保存在这台电脑上；放生后会一起清除。' },
  dances: { title: '舞蹈', description: '让她在桌面上跳舞。只有 VRM 外观可以跳；舞蹈可以从 MMD 动作（.vmd，可带音乐和封面）导入。' },
  desk: { title: '桌面上的她', description: '让她做个动作、回到屏幕右下角，或者退出桌宠。' },
  appearance: { title: '外观主题', description: '设置窗口的亮色 / 暗色主题。桌宠窗口保持像素风格。' },
  tts: { title: '朗读', description: '让她把回复读出来：选择引擎、填写 Key 和端点。Key 只写入，不回显。' },
  asr: { title: '语音输入', description: '按住 🎤 说话，或在任何地方按快捷键直接和她语音对话；识别成文字发给她。' },
  music: { title: '音乐创作', description: '让她写歌：选一个音乐服务并填好它的 Key。默认用 fal.ai 托管的 MiniMax Music；ElevenLabs 的 Key 与「朗读 → ElevenLabs」共用；MiniMax 官方音乐接口已不再向新用户开放，只有已开通的老账号可用。' },
  voicepacks: { title: '语音包', description: '提前录好的台词：命中时直接播放，不用请求引擎。' },
  connection: { title: 'LobeHub 与本机', description: '登录的账号、所在空间和本机能力。' },
  api: { title: '对外接口', description: '在 127.0.0.1 上开放一个 HTTP 接口，让脚本让她说话、做动作。' },
  safety: { title: '内容与安全', description: '18+ 确认与成人向内容。打开成人向内容必须走年龄确认。' },
  update: { title: '版本与更新', description: '当前版本、更新状态、自动更新开关，以及手动检查。新版本在后台下载，离开电脑 10 分钟后或退出时安装。' },
  about: { title: '数据与关于', description: '数据目录、系统选项、素材署名和危险操作。' },
};

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));
const pct = (v) => `${Math.round(v * 100)}%`;

// type: switch | select | segmented | slider | number | text | url | hotkey | secret | textarea | readonly
// live: true = applies at once (all settings.json keys but RESTART_KEYS); restart: true = after a restart
const F = [];
const add = (key, page, card, label, type, extra = {}) => F.push({ key, page, card, label, type, store: 'settings', ...extra });

// ---- 桌宠行为 ----------------------------------------------------------------------------------------------
add('petScale', 'behavior', '大小与取景', '宠物大小', 'slider', { desc: '桌面上角色的大小，窗口跟着变，右下角保持不动。', min: settingsLib.PET_SCALE.min, max: settingsLib.PET_SCALE.max, step: 0.05, format: 'percent' });
add('prefs.framing', 'behavior', '大小与取景', '取景', 'segmented', { desc: '全身：从头到脚；半身：只显示腰部以上，角色画得更大，窗口大小和右下角位置不变。改动立即生效。对 VRM、Live2D 和像素角色生效（图片 / 全动态角色保持全身）；角色详情页可以单独设置，角色包也可以自带默认取景。', options: opts([['full', '全身'], ['half', '半身']]) });
add('prefs.roam', 'behavior', '动作', '自己走动', 'switch', { desc: '空闲时在屏幕底部走几步；鼠标在她身上或她在忙时不走。' });
add('prefs.clickSound', 'behavior', '动作', '点击音效', 'switch', { desc: '摸她、喂她时发出一声短音效。' });
add('prefs.memes', 'behavior', '动作', '梗图', 'switch', { desc: '碎碎念时偶尔配一张梗图。' });
add('prefs.collide', 'behavior', '动作', '互相碰撞', 'switch', { desc: '有同屏伙伴时，扔出去的桌宠会撞到别人。' });
add('prefs.danceVolume', 'dances', '跳舞时', '音乐音量', 'slider', { desc: '跳舞时音乐的音量，跳舞中改动立即生效。她说话时会自动压低；桌宠工具栏静音时不出声，动作照跳。', min: 0, max: 100, step: 5, unit: '%' });
add('prefs.touchZones', 'behavior', '触摸', '部位触摸', 'switch', { desc: '点到哪个部位，她就对哪个部位做出反应；关闭后点哪里都是普通的摸摸。' });
add('prefs.touchHint', 'behavior', '触摸', '触摸提示', 'switch', { desc: '悬停时提示指针下是哪个部位。', dependsOn: { key: 'prefs.touchZones', value: true } });
add('petScaleSet', 'behavior', '大小与取景', '手动选过大小', 'readonly', { internal: true, desc: '内部标记：选过之后不再跟随默认大小。' });

// ---- 主动行为与好感度 ------------------------------------------------------------------------------------
add('proactive.enabled', 'proactive', '主动行为', '主动说话', 'switch', { desc: '饿了、无聊了、早晚问候时自己开口。关闭后她只在你互动时说话。' });
add('proactive.speakCooldownMin', 'proactive', '主动行为', '主动说话间隔', 'number', { desc: '两次主动说话之间至少隔多久。', unit: '分钟', min: 3, max: 240, step: 1, dependsOn: { key: 'proactive.enabled', value: true } });
add('proactive.boredAfterMin', 'proactive', '主动行为', '多久没理她算无聊', 'number', { desc: '超过这个时间没有互动，她可能会来找你。', unit: '分钟', min: 5, max: 480, step: 5, dependsOn: { key: 'proactive.enabled', value: true } });
add('proactive.hungryAt', 'proactive', '主动行为', '饥饿提醒阈值', 'slider', { desc: '饥饿值到这里时她会喊饿（0–100）。', min: 50, max: 100, step: 1, dependsOn: { key: 'proactive.enabled', value: true } });
add('proactive.maxLlmPerHour', 'proactive', '主动行为', '每小时最多调用模型', 'number', { desc: '主动说话每小时最多花几次模型调用，超出后改用离线台词。0 = 只用离线台词。', unit: '次', min: 0, max: 30, step: 1, dependsOn: { key: 'proactive.enabled', value: true } });
// 插个嘴 (core/interject.js, docs/interject.md): off by default; the clipboard has its own switch and stays off
const IJ = { key: 'interject.enabled', value: true };
const IR = settingsLib.INTERJECT_RANGE;
add('interject.enabled', 'proactive', '插个嘴', '插个嘴', 'switch', { desc: '默认关闭。打开后她只听下面列出、并且打开了的来源（不是对她说的话），由 LobeHub 的决策模型（需要登录）判断值不值得插一句碎碎念；拿不准就不说，判断失败也不说。不装键盘钩子、不读其它窗口、不截屏；记录只留每句前 24 个字。' });
add('interject.sources.chatDraft', 'proactive', '插个嘴', '来源：聊天框草稿', 'switch', { desc: '你在她的聊天框里打字、停下来还没发送时。只看这个输入框。', dependsOn: IJ });
add('interject.sources.voice', 'proactive', '插个嘴', '来源：语音输入', 'switch', { desc: '语音输入转写出来的文字。', dependsOn: IJ });
add('interject.sources.api', 'proactive', '插个嘴', '来源：外部程序', 'switch', { desc: '本机脚本通过对外接口 POST /pixel-pet/observe 告诉她的内容（需开启对外接口）。', dependsOn: IJ });
add('interject.sources.clipboard', 'proactive', '插个嘴', '来源：剪贴板（系统级）', 'switch', { desc: '每 3 秒看一次剪贴板里的文字。系统级来源，默认关闭；记录里只留字数，不留内容；像密码、密钥的文字直接跳过。', dependsOn: IJ });
add('interject.cooldownMin', 'proactive', '插个嘴', '两次插嘴至少间隔', 'number', { unit: '分钟', min: IR.cooldownMin[0], max: IR.cooldownMin[1], step: 1, dependsOn: IJ });
add('interject.maxPerHour', 'proactive', '插个嘴', '每小时最多插嘴', 'number', { unit: '次', min: IR.maxPerHour[0], max: IR.maxPerHour[1], step: 1, dependsOn: IJ });
add('interject.maxDecidePerHour', 'proactive', '插个嘴', '每小时最多判断', 'number', { desc: '每小时最多调用几次决策模型；超出后这一小时不再判断。', unit: '次', min: IR.maxDecidePerHour[0], max: IR.maxDecidePerHour[1], step: 1, dependsOn: IJ });
add('interject.debounceSec', 'proactive', '插个嘴', '停顿多久再判断', 'number', { desc: '你连续输入时不判断，停下这么久之后才看。', unit: '秒', min: IR.debounceSec[0], max: IR.debounceSec[1], step: 1, dependsOn: IJ });
add('interject.minChars', 'proactive', '插个嘴', '太短不判断', 'number', { desc: '少于这么多字的输入直接跳过。', unit: '字', min: IR.minChars[0], max: IR.minChars[1], step: 1, dependsOn: IJ });
add('interject.quietStart', 'proactive', '插个嘴', '勿扰开始', 'number', { desc: '勿扰时段内不插嘴；开始和结束相同 = 不设勿扰。', unit: '点', min: 0, max: 23, step: 1, dependsOn: IJ });
add('interject.quietEnd', 'proactive', '插个嘴', '勿扰结束', 'number', { unit: '点', min: 0, max: 23, step: 1, dependsOn: IJ });
add('interject.highThreshold', 'proactive', '插个嘴', '插嘴阈值', 'slider', { desc: '决策模型给出的概率不低于它才插嘴。', min: settingsLib.INTERJECT_THRESHOLD_RANGE.highThreshold[0], max: settingsLib.INTERJECT_THRESHOLD_RANGE.highThreshold[1], step: 0.01, format: 'percent', dependsOn: IJ });
add('interject.lowThreshold', 'proactive', '插个嘴', '不插嘴阈值', 'slider', { desc: '概率不高于它就肯定不说；两个阈值之间默认也不说，除非你点过“可以插嘴”的规则命中。', min: settingsLib.INTERJECT_THRESHOLD_RANGE.lowThreshold[0], max: settingsLib.INTERJECT_THRESHOLD_RANGE.lowThreshold[1], step: 0.01, format: 'percent', dependsOn: IJ });
add('interject.timeoutSec', 'proactive', '插个嘴', '判断超时', 'number', { desc: '超时一律不说话。', unit: '秒', min: IR.timeoutSec[0], max: IR.timeoutSec[1], step: 1, dependsOn: IJ });
add('interject.model', 'proactive', '插个嘴', '决策模型', 'text', { desc: 'provider/model，默认 lobehub/jev-1.14.0。', placeholder: 'lobehub/jev-1.14.0', maxLength: 121, pattern: settingsLib.DECISION_MODEL_RE.source, dependsOn: IJ });
add('affectionRules.dailyCap', 'proactive', '好感度', '每日好感上限', 'number', { desc: '每个好感日（凌晨 4 点分界）最多能涨多少好感。', unit: '点', min: settingsLib.DAILY_CAP_RANGE[0], max: settingsLib.DAILY_CAP_RANGE[1], step: 1 });
add('affectionRules.decay', 'proactive', '好感度', '久未见面时好感衰减', 'switch', { desc: '48 小时没互动后，每 12 小时减 1 点，一次最多减 8 点，不会掉阶段。' });

// ---- 外观主题 ---------------------------------------------------------------------------------------------
add('ui.theme', 'appearance', '设置窗口', '主题', 'segmented', { desc: '设置窗口的明暗。跟随系统时随操作系统切换。', options: opts([['auto', '跟随系统'], ['light', '亮色'], ['dark', '暗色']]) });

// ---- 同屏伙伴 ---------------------------------------------------------------------------------------------
add('visitors', 'visitors', '同屏伙伴', '一起待在桌面上的角色', 'visitors', { desc: `最多 ${settingsLib.MAX_VISITORS} 位，不能选当前角色。`, max: settingsLib.MAX_VISITORS });

// ---- 朗读 -------------------------------------------------------------------------------------------------
add('prefs.muted', 'tts', '朗读', '静音', 'switch', { desc: '一键让她不出声：朗读、互动语音和点击音效都停下，下面的开关保持原样。桌宠工具栏上的喇叭按钮也能切换。' });
add('prefs.voice', 'tts', '朗读', '朗读回复', 'switch', { desc: '她的回复和主动说的话用语音读出来。总开关：关闭时下面的语音都不会响。' });
add('prefs.voiceInteractions', 'tts', '朗读', '互动语音', 'switch', { desc: '摸摸、喂食、拖动时的短台词也读出来（会提前合成）。', dependsOn: { key: 'prefs.voice', value: true } });
add('prefs.voiceMurmurs', 'tts', '朗读', '朗读碎碎念', 'switch', { desc: '她自言自语的碎碎念也读出来。', dependsOn: { key: 'prefs.voice', value: true } });
add('tts.provider', 'tts', '引擎', '朗读引擎', 'select', { desc: '自动 = 用角色自己配好的引擎。', options: opts([['auto', '自动（跟随角色）'], ['fish', 'Fish Audio'], ['minimax', 'MiniMax'], ['elevenlabs', 'ElevenLabs'], ['local', '本地语音服务'], ['system', '系统语音']]) });
add('tts.fallback', 'tts', '引擎', '引擎用不了时', 'segmented', { desc: '选的引擎失败（没 Key、超时、额度用完）时怎么办。', options: opts([['system', '改用系统语音'], ['silent', '不出声']]) });
add('tts.packs', 'tts', '引擎', '使用语音包', 'switch', { desc: '命中录好的台词时直接播放，不请求引擎。' });
add('tts.voicePack', 'voicepacks', '我的语音包', '我的语音包', 'voicePack', { desc: '你自己用的语音包：选一个通用语音包（通用男声 / 通用女声）或任意语音包，所有没有单独指定语音包的角色都用它。自动 = 每个角色用自己的专属语音包，没有时按性别用通用男声 / 女声。切换后下一句就用新的语音包。' });
add('tts.voicePackByCharacter.<id>', 'character', '语音', '语音包', 'perCharacter', { desc: '这个角色用哪个语音包：不使用（全部用引擎朗读）、内置（自动：她的专属语音包；没有时按性别用通用男声 / 女声语音包），或指定一个语音包（商店下载的风格语音包也在这里）。没下载的语音包要先去 商店 → 语音包 下载。切换后下一句就用新的语音包；正在用的语音包被删除时自动回到内置。' });
add('tts.providerSet', 'tts', '引擎', '手动选过引擎', 'readonly', { internal: true, desc: '内部标记：选过引擎后不再迁移成「自动」。' });
add('tts.endpoints.fish', 'tts', 'Fish Audio', '端点', 'url', { desc: '留空使用官方地址 https://api.fish.audio。必须是 https。', placeholder: 'https://api.fish.audio', validator: 'tts:fish' });
add('tts.endpoints.minimax', 'tts', 'MiniMax', '端点', 'url', { desc: '留空使用官方地址 https://api.minimax.cn。必须是 https。', placeholder: 'https://api.minimax.cn', validator: 'tts:minimax' });
add('tts.endpoints.elevenlabs', 'tts', 'ElevenLabs', '端点', 'url', { desc: '留空使用官方地址 https://api.elevenlabs.io。必须是 https。', placeholder: 'https://api.elevenlabs.io', validator: 'tts:elevenlabs' });
add('tts.elevenlabs.voiceId', 'tts', 'ElevenLabs', '默认音色 ID', 'text', { desc: '必填：从 ElevenLabs Voice Library 复制 voice_id（20 位字母和数字）。角色文件里配了 ElevenLabs 音色时以角色为准；两边都没有时不用 ElevenLabs。', placeholder: '21m00Tcm4TlvDq8ikWAM', maxLength: 80, pattern: '^[A-Za-z0-9]{10,40}$' });
add('tts.elevenlabs.modelId', 'tts', 'ElevenLabs', '模型', 'select', { desc: '默认 eleven_multilingual_v2（多语言，最自然）；Flash 延迟最低，Turbo 介于两者之间。角色文件里配了模型时以角色为准。', options: opts([['eleven_multilingual_v2', 'eleven_multilingual_v2（多语言 v2，默认）'], ['eleven_flash_v2_5', 'eleven_flash_v2_5（Flash，低延迟）'], ['eleven_turbo_v2_5', 'eleven_turbo_v2_5（Turbo）'], ['eleven_v3', 'eleven_v3（v3，表现力更强）']]) });
add('tts.endpoints.local', 'tts', '本地语音服务', '地址', 'url', { desc: 'https，或本机 / 局域网的 http。为空时本地引擎不可用。', placeholder: 'http://127.0.0.1:8000', validator: 'tts:local' });
add('tts.local.api', 'tts', '本地语音服务', '接口', 'segmented', { desc: 'OpenAI 兼容（/v1/audio/speech）或 Whale（/tts）。', options: opts([['openai', 'OpenAI 兼容'], ['whale', 'Whale']]) });
add('tts.local.model', 'tts', '本地语音服务', '模型', 'text', { desc: '留空时请求用 tts-1。Whale 接口不用这一项。', placeholder: 'tts-1', maxLength: 80, dependsOn: { key: 'tts.local.api', value: 'openai' } });
add('tts.local.voice', 'tts', '本地语音服务', '音色名', 'text', { desc: '留空时用 default；角色文件里配了音色时以角色为准。Whale 接口不用这一项。', placeholder: 'default', maxLength: 80, dependsOn: { key: 'tts.local.api', value: 'openai' } });

// ---- 语音输入 ---------------------------------------------------------------------------------------------
add('asr.enabled', 'asr', '语音输入', '开启语音输入', 'switch', { desc: '聊天框旁出现 🎤。第一次录音时系统会询问麦克风权限。' });
add('asr.engine', 'asr', '语音输入', '识别引擎', 'segmented', { desc: 'LobeHub 云端识别（用你的 LobeHub 账号）或你自己的本地识别服务。', options: opts([['lobehub', 'LobeHub 云端'], ['local', '本地服务'], ['off', '关闭']]), dependsOn: { key: 'asr.enabled', value: true } });
add('asr.fallback', 'asr', '语音输入', '用不了时换另一个引擎', 'switch', { desc: '选的引擎失败时，改用另一个再试一次。', dependsOn: { key: 'asr.enabled', value: true } });
add('asr.language', 'asr', '语音输入', '语言', 'select', { desc: '自动识别，或固定一种语言（更准）。', options: opts([['auto', '自动'], ['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'], ['ru', '俄语']]), dependsOn: { key: 'asr.enabled', value: true } });
add('asr.autoSend', 'asr', '语音输入', '识别后直接发送', 'switch', { desc: '识别出的文字直接发给她，不在输入框里等你确认。', dependsOn: { key: 'asr.enabled', value: true } });
add('asr.maxSeconds', 'asr', '语音输入', '单次最长录音', 'number', { desc: '录到这个时长自动停止。', unit: '秒', min: 5, max: 120, step: 5, dependsOn: { key: 'asr.enabled', value: true } });
// 快捷键唤起语音对话 (core/hotkey.js, main/voice-hotkey.js): works with 语音输入 off too — she then says how to turn it on
add('asr.hotkey', 'asr', '快捷键', '唤起语音对话', 'hotkey', {
  desc: '在任何地方按下：她出现在桌面上、打开聊天框并开始听；说完再按一次结束并识别。录下组合时至少要有一个 Ctrl / ⌘ / Alt。清空 = 不用快捷键。',
  defaultKeys: hotkeyLib.toHotkeyKeys(hotkeyLib.DEFAULT_HOTKEY),
  reserved: hotkeyLib.RESERVED.map((r) => ({ accelerator: r.accelerator, keys: hotkeyLib.toHotkeyKeys(r.accelerator), label: r.label })),
});
add('asr.lobehub.model', 'asr', 'LobeHub 云端识别', '模型', 'select', { desc: '完整版更准，mini 更快更省。', options: opts([['gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe（快）'], ['gpt-4o-transcribe', 'gpt-4o-transcribe（准）']]) });
add('asr.local.endpoint', 'asr', '本地识别服务', '地址', 'url', { desc: 'https，或本机 / 局域网的 http；不能带查询参数或账号密码。清空恢复默认。', placeholder: asrLib.DEFAULT_ENDPOINT, validator: 'asr' });
add('asr.local.api', 'asr', '本地识别服务', '接口', 'segmented', { desc: 'OpenAI 兼容（/v1/audio/transcriptions）或 whisper.cpp（/inference）。', options: opts([['openai', 'OpenAI 兼容'], ['whispercpp', 'whisper.cpp']]) });
add('asr.local.model', 'asr', '本地识别服务', '模型', 'text', { desc: '字母、数字和 . _ : / -，最多 80 字。', maxLength: 80, pattern: '^[A-Za-z0-9._:/-]{1,80}$' });
add('asr.local.timeoutSec', 'asr', '本地识别服务', '超时', 'number', { desc: 'CPU 推理较慢，首个请求可能要十几秒。', unit: '秒', min: 5, max: 120, step: 5 });

// ---- 音乐创作 (core/music.js, T-5088) ---------------------------------------------------------------------
const M_RANGE = musicLib.RANGE;
add('music.enabled', 'music', '音乐服务', '让她作曲', 'switch', { desc: '开启且所选服务有 Key 时，聊天里说「给我写首歌」「来段轻松的纯音乐」，她会调用作曲工具，歌会出现在她的回复下面，点一下就能听。不需要开启本机能力；每首歌按所选服务的价格计费。' });
add('music.provider', 'music', '音乐服务', '服务', 'segmented', { desc: 'fal.ai：托管的 MiniMax Music，每首约 $0.15，Key 填在下面或用环境变量 FAL_KEY。ElevenLabs：按生成时长约 $0.15/分钟，需付费套餐，Key 与「朗读 → ElevenLabs」共用或用 ELEVENLABS_API_KEY。MiniMax 官方：已不再向新用户开放，Key 与「朗读 → MiniMax」共用或用 MINIMAX_API_KEY。', options: opts(musicLib.PROVIDER_IDS.map((id) => [id, { fal: 'fal.ai', elevenlabs: 'ElevenLabs', minimax: 'MiniMax 官方' }[id]])) });
const ON_FAL = { key: 'music.provider', value: 'fal' };
const ON_EL = { key: 'music.provider', value: 'elevenlabs' };
const ON_MM = { key: 'music.provider', value: 'minimax' };
add('music.fal.model', 'music', 'fal.ai', '模型', 'select', { desc: 'v2.6 是 fal 上最新的 MiniMax Music；v2.5 是上一代。两者都是每首约 $0.15。', options: opts(musicLib.FAL_MODELS.map((m) => [m, m.endsWith('v2.6') ? `${m}（推荐）` : m])), dependsOn: ON_FAL });
add('music.fal.endpoint', 'music', 'fal.ai', '队列端点', 'url', { desc: `留空时用环境变量 FAL_MUSIC_ENDPOINT，最后是 ${musicLib.FAL_DEFAULT_ENDPOINT}。必须是 https。`, placeholder: musicLib.FAL_DEFAULT_ENDPOINT, validator: 'music', dependsOn: ON_FAL });
add('music.elevenlabs.model', 'music', 'ElevenLabs', '模型', 'select', { desc: 'music_v2_5 是最新模型；music_v1 已弃用，将于 2027-01-31 下线。', options: opts(musicLib.ELEVENLABS_MODELS.map((m) => [m, m === 'music_v2_5' ? 'music_v2_5（推荐）' : m === 'music_v1' ? 'music_v1（已弃用）' : m])), dependsOn: ON_EL });
add('music.elevenlabs.outputFormat', 'music', 'ElevenLabs', '音频格式', 'select', { desc: 'ElevenLabs 不用下面「音频」里的格式 / 采样率 / 码率，只用这里；192 kbps 需要较高的套餐。', options: opts([['mp3_44100_128', 'mp3 · 44.1 kHz · 128 kbps'], ['mp3_44100_192', 'mp3 · 44.1 kHz · 192 kbps']]), dependsOn: ON_EL });
add('music.elevenlabs.endpoint', 'music', 'ElevenLabs', '端点', 'url', { desc: `留空时依次用环境变量 ELEVENLABS_MUSIC_ENDPOINT、「朗读 → ElevenLabs」的端点，最后是 ${musicLib.ELEVENLABS_DEFAULT_ENDPOINT}（数据驻留可用 https://api.us.elevenlabs.io 等）。必须是 https。`, placeholder: musicLib.ELEVENLABS_DEFAULT_ENDPOINT, validator: 'music', dependsOn: ON_EL });
add('music.model', 'music', 'MiniMax 官方', '模型', 'select', { desc: 'music-3.0 是官方推荐的最新模型；music-2.6 是上一代。注意：官方音乐接口已不再向新用户开放（HTTP 410 / 错误码 2153）。', options: opts([['music-3.0', 'music-3.0（推荐）'], ['music-2.6', 'music-2.6']]), dependsOn: ON_MM });
add('music.endpoint', 'music', 'MiniMax 官方', '端点', 'url', { desc: `留空时依次用环境变量 MINIMAX_MUSIC_ENDPOINT、「朗读 → MiniMax」的端点，最后是官方地址 ${musicLib.DEFAULT_ENDPOINT}（海外账号用 https://api.minimax.io）。必须是 https。`, placeholder: musicLib.DEFAULT_ENDPOINT, validator: 'music', dependsOn: ON_MM });
add('music.outputFormat', 'music', 'MiniMax 官方', '取回方式', 'segmented', { desc: '链接 = MiniMax 返回 24 小时有效的下载地址，马上下载到本地；hex = 音频直接在回复里。两种都会保存成本地文件。', options: opts([['url', '链接下载'], ['hex', '直接返回（hex）']]), dependsOn: ON_MM });
add('music.format', 'music', '音频', '格式', 'segmented', { desc: 'fal.ai 与 MiniMax 官方用这里的设置（ElevenLabs 用它自己的音频格式）。mp3 体积小；wav / pcm 无损但大很多。', options: opts(musicLib.FORMATS.map((f) => [f, f])) });
add('music.sampleRate', 'music', '音频', '采样率', 'select', { desc: '44100 Hz 是 CD 音质。', options: musicLib.SAMPLE_RATES.map((v) => ({ value: v, label: `${v} Hz` })) });
add('music.bitrate', 'music', '音频', '码率', 'select', { desc: '只对 mp3 有意义；越高越清晰、文件越大。', options: musicLib.BITRATES.map((v) => ({ value: v, label: `${v / 1000} kbps` })) });
add('music.outputDir', 'music', '保存', '保存目录', 'text', { desc: '绝对路径。留空 = 数据目录下的 music/ 文件夹。文件名是「时间-标题.格式」。', placeholder: '留空 = 数据目录/music', maxLength: 500, pattern: '^(/|[A-Za-z]:[\\\\/]|\\\\\\\\).*$' });
add('music.timeoutSec', 'music', '保存', '超时', 'number', { desc: '一首歌通常要一到几分钟；超过这个时间就放弃（fal.ai 上的任务会一并取消）并提示。', unit: '秒', min: M_RANGE.timeoutSec[0], max: M_RANGE.timeoutSec[1], step: 30 });
add('music.pollIntervalSec', 'music', '保存', '查询间隔', 'number', { desc: 'fal.ai 排队 / 生成时每隔多久查一次进度（MiniMax 官方与 ElevenLabs 是一次性返回，用不到）。', unit: '秒', min: M_RANGE.pollIntervalSec[0], max: M_RANGE.pollIntervalSec[1], step: 1 });

// ---- 对外接口 ---------------------------------------------------------------------------------------------
add('api.enabled', 'api', '对外接口（本机 HTTP）', '开启对外接口', 'switch', { desc: '只监听 127.0.0.1；第一次开启时自动生成令牌。' });
add('api.port', 'api', '对外接口（本机 HTTP）', '端口', 'number', { desc: '1024–65535。', min: settingsLib.API.minPort, max: settingsLib.API.maxPort, step: 1 });
add('api.token', 'api', '对外接口（本机 HTTP）', '令牌', 'token', { desc: '调用接口时放在 Authorization: Bearer 里。默认遮罩，可以复制或换一个。', sensitive: true });

// ---- 内容与安全 -------------------------------------------------------------------------------------------
add('adultContent', 'safety', '成人向内容', '成人向内容', 'adult', { desc: '18+ 外观与服饰。打开前必须确认已满 18 周岁；关闭随时可以。' });
add('answered', 'safety', '年龄确认', '已回答年龄确认', 'readonly', { internal: true });
add('ageConfirmed', 'safety', '年龄确认', '已确认满 18 周岁', 'readonly', { internal: true });
add('ageConfirmedAt', 'safety', '年龄确认', '确认时间', 'readonly', { internal: true, format: 'time' });
// T-2764: which character model the file is written under (core/character-migrate.js): 2 = every look is a character
add('characterModel', 'about', '数据', '角色数据版本', 'readonly', { internal: true, desc: `当前版本 ${settingsLib.CHARACTER_MODEL}；旧版数据（一位角色带多套形象）在启动时迁移一次，每套形象成为一位独立角色。` });
add('ageGateVersion', 'safety', '年龄确认', '确认文案版本', 'readonly', { internal: true, desc: `当前版本 ${settingsLib.AGE_GATE_VERSION}；版本不一致时会重新询问。` });

// ---- 数据与关于 / 系统 ------------------------------------------------------------------------------------
add('system.hardwareAcceleration', 'about', '系统', '硬件加速', 'switch', { desc: '用 GPU 绘制桌宠。透明窗口出现黑块或闪烁时可以关掉。', restart: true });

// ---- 版本与更新 -------------------------------------------------------------------------------------------
add('update.autoCheck', 'update', '自动更新', '自动检查更新', 'switch', { desc: '启动约 20 秒后检查一次，之后每 4 小时一次，有新版本就在后台下载。关闭后只在你点「检查更新」时检查；已下载的新版本仍会在退出时安装。' });

// ---- 按角色（角色详情页） ----------------------------------------------------------------------------------
// T-2764: every look is a character of its own (core/characters.js). 取景 / VRM 姿势 are per character (键是角色 id);
// 模型 / 个性化设定 belong to her base persona and are shared by all her characters (键是基础角色 id).
add('models.<id>', 'character', '模型', '模型', 'perCharacter', { desc: '她的 agent 用哪个模型（同一基础角色的各个形象共用）。' });
add('framings.<id>', 'character', '外观', '取景', 'perCharacter', { desc: '这个角色自己的取景：跟随全局（或角色包的默认）/ 全身 / 半身。' });
add('vrmPostures.<id>', 'character', '外观', 'VRM 姿势', 'perCharacter', { desc: '按 VRM 角色记住的姿势（键是角色 id，也就是她的角色包 id）：自动（待机时她自己换姿势）/ 放松站 / 叉腰站 / 害羞站 / 俏皮站 / 坐着 / 靠坐。', options: settingsLib.VRM_POSTURES });
add('systemRoles.<id>', 'character', '个性化设定', '个性化设定', 'perCharacter', { desc: `加在她 system role 里的你自己的话，最多 ${settingsLib.SYSTEM_ROLE_MAX} 字（同一基础角色的各个形象共用）。`, maxLength: settingsLib.SYSTEM_ROLE_MAX });

// ---- 不在 settings.json 的：密钥、pet.json -----------------------------------------------------------------
const secret = (key, page, card, label, extra = {}) => F.push({ key, page, card, label, type: 'secret', store: 'keys', sensitive: true, ...extra });
secret('keys.fish', 'tts', 'Fish Audio', 'API Key', { desc: '只写入，不回显。保存后显示「已设置」。' });
secret('keys.minimax', 'tts', 'MiniMax', 'API Key', { desc: '只写入，不回显。保存后显示「已设置」。' });
secret('keys.elevenlabs', 'tts', 'ElevenLabs', 'API Key', { desc: '只写入，不回显。保存后显示「已设置」。请求时放在 xi-api-key 头里。「音乐创作 → ElevenLabs」也用这个 Key。' });
secret('keys.fal', 'music', 'fal.ai', 'API Key', { desc: '只写入，不回显。保存后显示「已设置」。在 fal.ai/dashboard/keys 创建；也可以用环境变量 FAL_KEY。请求时放在 Authorization: Key … 头里。', dependsOn: { key: 'music.provider', value: 'fal' } });
secret('keys.local', 'tts', '本地语音服务', 'API Key（可选）', { desc: '本地服务需要鉴权时填写。' });
secret('keys.asrlocal', 'asr', '本地识别服务', 'API Key（可选）', { desc: '本地服务需要鉴权时填写；清除后不再发送。' });
// AI 可读的文件夹 (core/ai-folders.js, T-5075): drawn by the connection page's own card (文件夹与系统权限), not the form
add('local.folders', 'connection', '文件夹与系统权限', 'AI 可读的文件夹', 'aiFolders', { custom: true, desc: '她的本机工具只能读写这些文件夹（软链接和 .. 会先解析）。用系统选择框添加，可以删除。' });
add('local.allowCommands', 'connection', '文件夹与系统权限', '允许运行命令', 'aiFolders', { custom: true, desc: '命令的工作目录必须在上面的文件夹里，但命令本身不受文件夹限制，能访问你账号能访问的所有文件。' });
add('local.asked', 'connection', '文件夹与系统权限', '已请求过的系统文件夹', 'readonly', { internal: true });
F.push({ key: 'localAbilities', page: 'connection', card: '本机能力', label: '本机能力', type: 'local', store: 'pet', desc: '允许她在这台电脑上读写文件、运行命令（工具调用）。高风险：开启前会再确认一次。' });

for (const f of F) {
  if (f.store === 'settings' && !f.key.includes('<id>')) {
    f.default = at(DEFAULTS, f.key);
    f.restart = settingsLib.RESTART_KEYS.includes(f.key);
    f.live = !f.restart && f.type !== 'readonly';
  }
}

const FIELDS = Object.freeze(F.map((f) => Object.freeze(f)));
const byKey = new Map(FIELDS.map((f) => [f.key, f]));

// settings.json leaf paths, the per-character maps written as `<map>.<id>` (same as scripts/check-admin-console-doc.js)
function settingsLeaves(obj = DEFAULTS, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (['models', 'systemRoles', 'framings', 'vrmPostures', 'tts.voicePackByCharacter'].includes(p)) out.push(`${p}.<id>`);
    else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) out.push(...settingsLeaves(v, p));
    else out.push(p);
  }
  return out;
}

const MESSAGES = {
  unknown: '没有这个设置项',
  readonly: '这一项只能查看，不能修改',
  type: '值的类型不对',
  range: '超出允许的范围',
  option: '不是可选的值',
  'bad-endpoint': '地址不合法：需要 https（本机或局域网可以用 http），不能带账号密码',
  'bad-endpoint-https': '地址不合法：必须是 https，不能带账号密码',
  pattern: '格式不对',
  'too-long': '太长了',
};

// Check one value for `key` before it is saved. -> { ok, value } (value cleaned) | { ok: false, reason, message }
function validate(key, value) {
  const f = byKey.get(key);
  const no = (reason, extra = '') => ({ ok: false, reason, message: MESSAGES[reason] + extra });
  if (!f || f.store !== 'settings' || f.type === 'perCharacter') return no('unknown');
  if (f.type === 'readonly' || f.type === 'token' || f.type === 'adult' || f.type === 'voicePack') return no('readonly'); // voicePack: set-user-voice-pack
  switch (f.type) {
    case 'switch':
      return typeof value === 'boolean' ? { ok: true, value } : no('type');
    case 'select':
    case 'segmented':
      return f.options.some((o) => o.value === value) ? { ok: true, value } : no('option');
    case 'slider':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return no('type');
      if (n < f.min || n > f.max) return no('range', `（${f.format === 'percent' ? `${pct(f.min)}–${pct(f.max)}` : `${f.min}–${f.max}`}）`);
      if (f.step >= 1 && !Number.isInteger(n)) return no('type', '：需要整数');
      return { ok: true, value: f.step >= 1 ? n : Math.round(n * 100) / 100 };
    }
    case 'url': {
      if (typeof value !== 'string') return no('type');
      const v = value.trim();
      if (!v) return { ok: true, value: '' };
      const ok = f.validator === 'asr' ? asrLib.endpointOk(v) : f.validator === 'music' ? musicLib.endpointOk(v) : endpointOkFor(f.validator.slice(4), v);
      return ok ? { ok: true, value: v } : no(f.validator === 'music' ? 'bad-endpoint-https' : 'bad-endpoint');
    }
    case 'text': {
      if (typeof value !== 'string') return no('type');
      const v = value.trim();
      if (v.length > f.maxLength) return no('too-long', `（最多 ${f.maxLength} 字）`);
      if (f.pattern && v && !new RegExp(f.pattern).test(v)) return no('pattern');
      return { ok: true, value: v };
    }
    case 'hotkey': {
      // '' = off; otherwise a valid accelerator that the app itself does not use (core/hotkey.js checkHotkey)
      if (value !== null && typeof value !== 'string') return no('type');
      const h = hotkeyLib.checkHotkey(value === null ? '' : value);
      return h.ok ? { ok: true, value: h.accelerator } : { ok: false, reason: h.reason === 'conflict' ? 'hotkey-conflict' : 'bad-hotkey', message: h.message };
    }
    case 'visitors':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return no('type');
      if (value.length > f.max) return no('range', `（最多 ${f.max} 位）`);
      return { ok: true, value: [...new Set(value)] };
    default:
      return no('unknown');
  }
}

// The patch for an existing setter (PetService) that sets `key` to `value`: { setter, patch }.
// prefs.* → setPrefs, tts.* → setTts, asr.* → setAsr (applyAsrPatch), api.* → setApi, the console's own
// sections → setSection; petScale and visitors have setters of their own.
function patchFor(key, value) {
  const parts = key.split('.');
  const nest = (ks, v) => ks.reduceRight((acc, k) => ({ [k]: acc }), v);
  const head = parts[0];
  if (key === 'petScale') return { setter: 'setPetScale', patch: value };
  if (key === 'visitors') return { setter: 'setVisitors', patch: value };
  if (head === 'prefs') return { setter: 'setPrefs', patch: { [parts[1]]: value } };
  if (head === 'tts') return { setter: 'setTts', patch: nest(parts.slice(1), value) };
  if (head === 'asr') return { setter: 'setAsr', patch: nest(parts.slice(1), value) };
  if (head === 'api') return { setter: 'setApi', patch: { [parts[1]]: value } };
  if (head === 'interject') return { setter: 'setSection', section: head, patch: nest(parts.slice(1), value) };
  if (head === 'music') return { setter: 'setSection', section: head, patch: nest(parts.slice(1), value) };
  if (['proactive', 'affectionRules', 'ui', 'system', 'update'].includes(head)) return { setter: 'setSection', section: head, patch: { [parts[1]]: value } };
  return null;
}

// What goes to the window: plain data only.
function describe() {
  return { rail: RAIL, nav: NAV, pages: PAGES, fields: FIELDS, defaults: DEFAULTS, restartKeys: settingsLib.RESTART_KEYS };
}

module.exports = { RAIL, NAV, PAGES, FIELDS, DEFAULTS, field: (k) => byKey.get(k) || null, settingsLeaves, validate, patchFor, describe, at, TTS_ENGINES, FALLBACKS, TTS_LOCAL_APIS };
