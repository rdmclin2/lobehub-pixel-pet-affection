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

const DEFAULTS = settingsLib.normalizeSettings(null);
const at = (o, key) => key.split('.').reduce((v, p) => (v && typeof v === 'object' ? v[p] : undefined), o);

// Navigation. The window's rail has four places only (RAIL); everything else sits one level down: 角色 →
// her page, 玩法 / 设置 → a hub of tiles → one page per tile (docs/admin-console-design.md §6.3). NAV groups
// are those hub sections; `section` says which rail place a group belongs to.
const RAIL = [
  { key: 'home', label: '小屋', icon: 'House', page: 'overview' },
  { key: 'characters', label: '角色', icon: 'Users', page: 'characters' },
  { key: 'play', label: '玩法', icon: 'Gamepad2', page: 'play' },
  { key: 'settings', label: '设置', icon: 'Settings', page: 'settings' },
];

const NAV = [
  { key: 'home', section: 'home', label: '小屋', items: [{ page: 'overview', label: '小屋', icon: 'House' }] },
  { key: 'characters', section: 'characters', label: '角色', items: [{ page: 'characters', label: '角色图鉴', icon: 'Users' }] },
  {
    key: 'play', section: 'play', label: '陪伴方式', items: [
      { page: 'behavior', label: '桌宠行为', icon: 'PawPrint' },
      { page: 'proactive', label: '主动搭话与好感', icon: 'HeartHandshake' },
      { page: 'visitors', label: '同屏伙伴', icon: 'UsersRound' },
    ],
  },
  {
    key: 'voice', section: 'settings', label: '声音', items: [
      { page: 'tts', label: '朗读', icon: 'Volume2' },
      { page: 'asr', label: '语音输入', icon: 'Mic' },
      { page: 'voicepacks', label: '语音包', icon: 'AudioLines' },
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
  characters: { title: '角色图鉴', description: '遇见过的、还没遇见的她们。点开一位，看她的故事、换形象包、调她的模型和设定。' },
  play: { title: '玩法', description: '她在桌面上怎么陪你：走动、搭话、好感，还有同屏的伙伴。' },
  settings: { title: '设置', description: '声音、资源、连接和系统。' },
  packs: { title: '角色包', description: '内置和导入的角色包（像素 / 图片 / 全动态 / Live2D / VRM）。导入的包可以导出或删除；给某位角色换上，在她的详情页 → 形象包。' },
  visitors: { title: '同屏伙伴', description: '让其他模型娘一起待在桌面上（她们不聊天，只陪玩）。' },
  behavior: { title: '桌宠行为', description: '桌面上的大小、走动、音效、梗图和触摸。改动立即生效。' },
  proactive: { title: '主动搭话与好感', description: '她多久主动说一次话、每小时最多花几次模型调用，以及好感度的每日上限和衰减。改动立即生效。' },
  appearance: { title: '外观主题', description: '设置窗口的亮色 / 暗色主题。桌宠窗口保持像素风格。' },
  tts: { title: '朗读', description: '让她把回复读出来：选择引擎、填写 Key 和端点。Key 只写入，不回显。' },
  asr: { title: '语音输入', description: '按住 🎤 说话，识别成文字发给她。' },
  voicepacks: { title: '语音包', description: '提前录好的台词：命中时直接播放，不用请求引擎。' },
  connection: { title: 'LobeHub 与本机', description: '登录的账号、所在空间和本机能力。' },
  api: { title: '对外接口', description: '在 127.0.0.1 上开放一个 HTTP 接口，让脚本让她说话、做动作。' },
  safety: { title: '内容与安全', description: '18+ 确认与成人向内容。打开成人向内容必须走年龄确认。' },
  update: { title: '版本与更新', description: '当前版本、更新状态，以及手动检查。' },
  about: { title: '数据与关于', description: '数据目录、系统选项、素材署名和危险操作。' },
};

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));
const pct = (v) => `${Math.round(v * 100)}%`;

// type: switch | select | segmented | slider | number | text | url | secret | textarea | readonly
// live: true = applies at once (all settings.json keys but RESTART_KEYS); restart: true = after a restart
const F = [];
const add = (key, page, card, label, type, extra = {}) => F.push({ key, page, card, label, type, store: 'settings', ...extra });

// ---- 桌宠行为 ----------------------------------------------------------------------------------------------
add('petScale', 'behavior', '大小', '宠物大小', 'slider', { desc: '桌面上角色的大小，窗口跟着变，右下角保持不动。', min: settingsLib.PET_SCALE.min, max: settingsLib.PET_SCALE.max, step: 0.05, format: 'percent' });
add('prefs.roam', 'behavior', '动作', '自己走动', 'switch', { desc: '空闲时在屏幕底部走几步；鼠标在她身上或她在忙时不走。' });
add('prefs.clickSound', 'behavior', '动作', '点击音效', 'switch', { desc: '摸她、喂她时发出一声短音效。' });
add('prefs.memes', 'behavior', '动作', '梗图', 'switch', { desc: '碎碎念时偶尔配一张梗图。' });
add('prefs.collide', 'behavior', '动作', '互相碰撞', 'switch', { desc: '有同屏伙伴时，扔出去的桌宠会撞到别人。' });
add('prefs.touchZones', 'behavior', '触摸', '部位触摸', 'switch', { desc: '点到哪个部位，她就对哪个部位做出反应；关闭后点哪里都是普通的摸摸。' });
add('prefs.touchHint', 'behavior', '触摸', '触摸提示', 'switch', { desc: '悬停时提示指针下是哪个部位。', dependsOn: { key: 'prefs.touchZones', value: true } });
add('petScaleSet', 'behavior', '大小', '手动选过大小', 'readonly', { internal: true, desc: '内部标记：选过之后不再跟随默认大小。' });

// ---- 主动行为与好感度 ------------------------------------------------------------------------------------
add('proactive.enabled', 'proactive', '主动行为', '主动说话', 'switch', { desc: '饿了、无聊了、早晚问候时自己开口。关闭后她只在你互动时说话。' });
add('proactive.speakCooldownMin', 'proactive', '主动行为', '主动说话间隔', 'number', { desc: '两次主动说话之间至少隔多久。', unit: '分钟', min: 3, max: 240, step: 1, dependsOn: { key: 'proactive.enabled', value: true } });
add('proactive.boredAfterMin', 'proactive', '主动行为', '多久没理她算无聊', 'number', { desc: '超过这个时间没有互动，她可能会来找你。', unit: '分钟', min: 5, max: 480, step: 5, dependsOn: { key: 'proactive.enabled', value: true } });
add('proactive.hungryAt', 'proactive', '主动行为', '饥饿提醒阈值', 'slider', { desc: '饥饿值到这里时她会喊饿（0–100）。', min: 50, max: 100, step: 1, dependsOn: { key: 'proactive.enabled', value: true } });
add('proactive.maxLlmPerHour', 'proactive', '主动行为', '每小时最多调用模型', 'number', { desc: '主动说话每小时最多花几次模型调用，超出后改用离线台词。0 = 只用离线台词。', unit: '次', min: 0, max: 30, step: 1, dependsOn: { key: 'proactive.enabled', value: true } });
add('affectionRules.dailyCap', 'proactive', '好感度', '每日好感上限', 'number', { desc: '每个好感日（凌晨 4 点分界）最多能涨多少好感。', unit: '点', min: settingsLib.DAILY_CAP_RANGE[0], max: settingsLib.DAILY_CAP_RANGE[1], step: 1 });
add('affectionRules.decay', 'proactive', '好感度', '久未见面时好感衰减', 'switch', { desc: '48 小时没互动后，每 12 小时减 1 点，一次最多减 8 点，不会掉阶段。' });

// ---- 外观主题 ---------------------------------------------------------------------------------------------
add('ui.theme', 'appearance', '设置窗口', '主题', 'segmented', { desc: '设置窗口的明暗。跟随系统时随操作系统切换。', options: opts([['auto', '跟随系统'], ['light', '亮色'], ['dark', '暗色']]) });

// ---- 同屏伙伴 ---------------------------------------------------------------------------------------------
add('visitors', 'visitors', '同屏伙伴', '一起待在桌面上的角色', 'visitors', { desc: `最多 ${settingsLib.MAX_VISITORS} 位，不能选当前角色。`, max: settingsLib.MAX_VISITORS });

// ---- 朗读 -------------------------------------------------------------------------------------------------
add('prefs.voice', 'tts', '朗读', '朗读回复', 'switch', { desc: '她的回复和主动说的话用语音读出来。总开关：关闭时下面的语音都不会响。' });
add('prefs.voiceInteractions', 'tts', '朗读', '互动语音', 'switch', { desc: '摸摸、喂食、拖动时的短台词也读出来（会提前合成）。', dependsOn: { key: 'prefs.voice', value: true } });
add('prefs.voiceMurmurs', 'tts', '朗读', '朗读碎碎念', 'switch', { desc: '她自言自语的碎碎念也读出来。', dependsOn: { key: 'prefs.voice', value: true } });
add('tts.provider', 'tts', '引擎', '朗读引擎', 'select', { desc: '自动 = 用角色自己配好的引擎。', options: opts([['auto', '自动（跟随角色）'], ['fish', 'Fish Audio'], ['minimax', 'MiniMax'], ['elevenlabs', 'ElevenLabs'], ['local', '本地语音服务'], ['system', '系统语音']]) });
add('tts.fallback', 'tts', '引擎', '引擎用不了时', 'segmented', { desc: '选的引擎失败（没 Key、超时、额度用完）时怎么办。', options: opts([['system', '改用系统语音'], ['silent', '不出声']]) });
add('tts.packs', 'tts', '引擎', '使用语音包', 'switch', { desc: '命中录好的台词时直接播放，不请求引擎。' });
add('tts.providerSet', 'tts', '引擎', '手动选过引擎', 'readonly', { internal: true, desc: '内部标记：选过引擎后不再迁移成「自动」。' });
add('tts.endpoints.fish', 'tts', 'Fish Audio', '端点', 'url', { desc: '留空使用官方地址 https://api.fish.audio。必须是 https。', placeholder: 'https://api.fish.audio', validator: 'tts:fish' });
add('tts.endpoints.minimax', 'tts', 'MiniMax', '端点', 'url', { desc: '留空使用官方地址 https://api.minimax.cn。必须是 https。', placeholder: 'https://api.minimax.cn', validator: 'tts:minimax' });
add('tts.endpoints.elevenlabs', 'tts', 'ElevenLabs', '端点', 'url', { desc: '留空使用官方地址 https://api.elevenlabs.io。必须是 https。', placeholder: 'https://api.elevenlabs.io', validator: 'tts:elevenlabs' });
add('tts.elevenlabs.voiceId', 'tts', 'ElevenLabs', '默认音色 ID', 'text', { desc: '角色文件里没配 ElevenLabs 音色时用这个（voice_id）；都没有时不用 ElevenLabs。', placeholder: '21m00Tcm4TlvDq8ikWAM', maxLength: 80 });
add('tts.elevenlabs.modelId', 'tts', 'ElevenLabs', '模型', 'text', { desc: '留空使用 eleven_multilingual_v2；角色文件里配了模型时以角色为准。', placeholder: 'eleven_multilingual_v2', maxLength: 80 });
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
add('asr.lobehub.model', 'asr', 'LobeHub 云端识别', '模型', 'select', { desc: '完整版更准，mini 更快更省。', options: opts([['gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe（快）'], ['gpt-4o-transcribe', 'gpt-4o-transcribe（准）']]) });
add('asr.local.endpoint', 'asr', '本地识别服务', '地址', 'url', { desc: 'https，或本机 / 局域网的 http；不能带查询参数或账号密码。清空恢复默认。', placeholder: asrLib.DEFAULT_ENDPOINT, validator: 'asr' });
add('asr.local.api', 'asr', '本地识别服务', '接口', 'segmented', { desc: 'OpenAI 兼容（/v1/audio/transcriptions）或 whisper.cpp（/inference）。', options: opts([['openai', 'OpenAI 兼容'], ['whispercpp', 'whisper.cpp']]) });
add('asr.local.model', 'asr', '本地识别服务', '模型', 'text', { desc: '字母、数字和 . _ : / -，最多 80 字。', maxLength: 80, pattern: '^[A-Za-z0-9._:/-]{1,80}$' });
add('asr.local.timeoutSec', 'asr', '本地识别服务', '超时', 'number', { desc: 'CPU 推理较慢，首个请求可能要十几秒。', unit: '秒', min: 5, max: 120, step: 5 });

// ---- 对外接口 ---------------------------------------------------------------------------------------------
add('api.enabled', 'api', '对外接口（本机 HTTP）', '开启对外接口', 'switch', { desc: '只监听 127.0.0.1；第一次开启时自动生成令牌。' });
add('api.port', 'api', '对外接口（本机 HTTP）', '端口', 'number', { desc: '1024–65535。', min: settingsLib.API.minPort, max: settingsLib.API.maxPort, step: 1 });
add('api.token', 'api', '对外接口（本机 HTTP）', '令牌', 'token', { desc: '调用接口时放在 Authorization: Bearer 里。默认遮罩，可以复制或换一个。', sensitive: true });

// ---- 内容与安全 -------------------------------------------------------------------------------------------
add('adultContent', 'safety', '成人向内容', '成人向内容', 'adult', { desc: '18+ 外观与服饰。打开前必须确认已满 18 周岁；关闭随时可以。' });
add('answered', 'safety', '年龄确认', '已回答年龄确认', 'readonly', { internal: true });
add('ageConfirmed', 'safety', '年龄确认', '已确认满 18 周岁', 'readonly', { internal: true });
add('ageConfirmedAt', 'safety', '年龄确认', '确认时间', 'readonly', { internal: true, format: 'time' });
add('ageGateVersion', 'safety', '年龄确认', '确认文案版本', 'readonly', { internal: true, desc: `当前版本 ${settingsLib.AGE_GATE_VERSION}；版本不一致时会重新询问。` });

// ---- 数据与关于 / 系统 ------------------------------------------------------------------------------------
add('system.hardwareAcceleration', 'about', '系统', '硬件加速', 'switch', { desc: '用 GPU 绘制桌宠。透明窗口出现黑块或闪烁时可以关掉。', restart: true });

// ---- 按角色（角色详情页） ----------------------------------------------------------------------------------
add('appearance.<id>', 'character', '外观', '形象包', 'perCharacter', { desc: '她穿的角色包。' });
add('models.<id>', 'character', '模型', '模型', 'perCharacter', { desc: '她的 agent 用哪个模型。' });
add('systemRoles.<id>', 'character', '个性化设定', '个性化设定', 'perCharacter', { desc: `加在她 system role 里的你自己的话，最多 ${settingsLib.SYSTEM_ROLE_MAX} 字。`, maxLength: settingsLib.SYSTEM_ROLE_MAX });

// ---- 不在 settings.json 的：密钥、pet.json -----------------------------------------------------------------
const secret = (key, page, card, label, extra = {}) => F.push({ key, page, card, label, type: 'secret', store: 'keys', sensitive: true, ...extra });
secret('keys.fish', 'tts', 'Fish Audio', 'API Key', { desc: '只写入，不回显。保存后显示「已设置」。' });
secret('keys.minimax', 'tts', 'MiniMax', 'API Key', { desc: '只写入，不回显。保存后显示「已设置」。' });
secret('keys.elevenlabs', 'tts', 'ElevenLabs', 'API Key', { desc: '只写入，不回显。保存后显示「已设置」。请求时放在 xi-api-key 头里。' });
secret('keys.local', 'tts', '本地语音服务', 'API Key（可选）', { desc: '本地服务需要鉴权时填写。' });
secret('keys.asrlocal', 'asr', '本地识别服务', 'API Key（可选）', { desc: '本地服务需要鉴权时填写；清除后不再发送。' });
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
    if (['appearance', 'models', 'systemRoles'].includes(p)) out.push(`${p}.<id>`);
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
  pattern: '格式不对',
  'too-long': '太长了',
};

// Check one value for `key` before it is saved. -> { ok, value } (value cleaned) | { ok: false, reason, message }
function validate(key, value) {
  const f = byKey.get(key);
  const no = (reason, extra = '') => ({ ok: false, reason, message: MESSAGES[reason] + extra });
  if (!f || f.store !== 'settings' || f.type === 'perCharacter') return no('unknown');
  if (f.type === 'readonly' || f.type === 'token' || f.type === 'adult') return no('readonly');
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
      const ok = f.validator === 'asr' ? asrLib.endpointOk(v) : endpointOkFor(f.validator.slice(4), v);
      return ok ? { ok: true, value: v } : no('bad-endpoint');
    }
    case 'text': {
      if (typeof value !== 'string') return no('type');
      const v = value.trim();
      if (v.length > f.maxLength) return no('too-long', `（最多 ${f.maxLength} 字）`);
      if (f.pattern && v && !new RegExp(f.pattern).test(v)) return no('pattern');
      return { ok: true, value: v };
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
  if (['proactive', 'affectionRules', 'ui', 'system'].includes(head)) return { setter: 'setSection', section: head, patch: { [parts[1]]: value } };
  return null;
}

// What goes to the window: plain data only.
function describe() {
  return { rail: RAIL, nav: NAV, pages: PAGES, fields: FIELDS, defaults: DEFAULTS, restartKeys: settingsLib.RESTART_KEYS };
}

module.exports = { RAIL, NAV, PAGES, FIELDS, DEFAULTS, field: (k) => byKey.get(k) || null, settingsLeaves, validate, patchFor, describe, at, TTS_ENGINES, FALLBACKS, TTS_LOCAL_APIS };
