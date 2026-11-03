'use strict';

// 配置后台覆盖矩阵 (docs/admin-console-design.md §12): is everything the owner can configure or control
// reachable in the settings window? Four lists are checked against the code, never against a copy of it:
//
//   1. settings.json — every leaf of normalizeSettings(null) has a schema field the console renders (or is an
//      internal flag listed in INTERNAL_SETTINGS with why), and says whether it applies at once or after a restart;
//   2. pet-window channels — every channel src/main/preload.js invokes is either one the settings window also
//      has (src/main/admin-preload.js), reached in the console another way (VIA), or listed in PET_ONLY with why
//      it is not a setting (chatting, dragging her, the first hatch, debug hooks …);
//   3. menus — every item of the former ⋯ menu and toolbar (话题 / 衣柜; removed from the pet window in T-2718,
//      which keeps only ⚙), any data-menu item src/renderer/index.html would grow again, and every tray / app
//      menu item (src/main/main.js) has its place in the console (MENU) or a reason it does not need one;
//   4. runtime behaviour controls — the behaviours PetService / main run (走动, 主动搭话, 好感, 同屏伙伴, 语音,
//      ASR, 对外接口, 更新, 安全, 数据目录 …) each name the settings keys and console actions that control them.
//
// audit() takes the parsed sources (scripts/check-admin-console-doc.js reads them; the tests too) and returns
// the matrix rows plus `problems` — empty means nothing is missing. renderMatrix() writes §12 from the rows.

// settings.json leaves that are bookkeeping, not choices: shown read-only (or not at all) with why
const INTERNAL_SETTINGS = {
  petScaleSet: '内部标记：动过「宠物大小」后不再跟随默认大小（由 `petScale` 的修改写入）',
  'tts.providerSet': '内部标记：选过朗读引擎后不再迁移成「自动」（由 `tts.provider` 的修改写入）',
  answered: '年龄确认的答案（由 18+ 确认对话写入，内容与安全页只读显示）',
  ageConfirmed: '是否确认满 18 周岁（同上，只读）',
  ageConfirmedAt: '确认时间（同上，只读）',
  ageGateVersion: '确认文案版本（文案改了就重新询问，只读）',
  characterModel: '角色数据版本（T-2764：2 = 每个形象是一个独立角色；旧文件启动时迁移一次，只读）',
};

// settings.json leaves the generic form does not write, and the console control that does
const SPECIAL_SETTINGS = {
  adultContent: '内容与安全 → 成人向内容（打开必须先过 18+ 确认：`confirm-age` / `set-adult`）',
  'api.token': '对外接口 → 令牌（遮罩显示、复制、「换一个」：`set-api` newToken）',
  'models.<id>': '角色详情 → 模型（`set-model` / `refresh-models`）',
  'systemRoles.<id>': '角色详情 → 设定 → 个性化设定（`set-system-role`）',
  'framings.<id>': '角色详情 → 外观 → 取景（跟随全局 / 全身 / 半身：`set-framing`）',
  'vrmPostures.<id>': '角色详情 → 外观 → VRM 姿势（VRM 角色；按角色记住，自动 / 6 种姿势：`set-vrm-posture`）',
};

// pet-window channels the settings window reaches through a channel of its own (pet → admin)
const VIA = {
  'set-prefs': '`admin-set` prefs.*（桌宠行为 / 朗读）',
  'set-tts': '`admin-set` tts.* 与 keys.*（朗读）',
  'set-asr': '`admin-set` asr.* 与 keys.asrlocal（语音输入）',
  'set-visitors': '`admin-set` visitors（同屏伙伴）',
  'set-api': '`admin-set` api.*（对外接口）；「换一个令牌」用同一通道',
  'set-pet-scale': '`admin-set` petScale（桌宠行为 → 宠物大小）',
  'preview-pet-scale': '`admin-set` petScale（滑块松手即保存；拖动中的预览只在桌宠窗口）',
  'set-local': '`admin-set` localAbilities（LobeHub 与本机 → 本机能力）',
  'get-settings': '`admin-boot` / `admin-state`（整份设置随广播推送）',
  place: '`admin-place-pet`（桌宠行为 → 位置 → 找回桌宠）',
  'open-admin': '这就是打开设置窗口本身',
};

// pet-window channels that are not settings: what they are
const PET_ONLY = {
  boot: '桌宠窗口启动',
  whoami: '登录状态（设置窗口也有同名通道）',
  spaces: '首次唤醒时选择空间（唤醒后不能改，连接页只读显示）',
  hatch: '首次唤醒（领养）流程',
  act: '互动：喂食 / 玩耍 / 睡觉',
  'vrm-library-info': 'VRM 动作库从哪里加载（只读诊断信息，给 e2e 和排查用，不是设置）',
  touch: '互动：摸摸（部位触摸）',
  'talk-topic': '互动：按话题聊天',
  chat: '聊天',
  'pick-images': '聊天：选图片',
  cancel: '聊天：停止生成',
  'mark-seen': '衣柜 / 话题面板的「新」角标',
  'history-list': '聊天记录（查看，不是配置）',
  'history-get': '聊天记录（查看，不是配置）',
  panel: '桌宠窗口的面板展开 / 收起（窗口尺寸）',
  'move-by': '拖动她',
  'move-to': '走动时移动窗口',
  'work-area': '走动时读屏幕边界',
  'cursor-point': 'VRM 视线跟随鼠标',
  pose: '扔出去时的碰撞',
  peers: '同屏伙伴的位置（碰撞）',
  kick: '碰撞把别人撞开',
  'visitor-boot': '同屏伙伴窗口启动',
  'tts-synthesize': '朗读一句（播放，不是配置）',
  'tts-cancel': '停止朗读',
  'tts-prewarm': '互动语音预合成',
  'asr-transcribe': '一次语音输入',
  'asr-cancel': '取消语音输入',
  'asr-mic-access': '麦克风权限请求',
  'api-reply': '对外接口请求的回执',
  'save-pack-preview': '桌宠窗口给 VRM / Live2D 包存一张预览图（图鉴里显示的就是它）',
  quit: '退出程序（托盘 / 应用菜单）',
  'debug-set': '测试钩子（只在 PIXELPET_TEST=1）',
  'debug-import-pack': '测试钩子',
  'debug-next-open': '测试钩子',
  'debug-next-save': '测试钩子',
  'debug-opened-links': '测试钩子',
  'debug-admin': '测试钩子',
  'debug-tray': '测试钩子',
  'debug-tray-click': '测试钩子',
  'debug-heartbeat': '测试钩子',
};

// the former ⋯ menu (menu:) and toolbar buttons (toolbar:) of the pet window, any data-menu item it grows again,
// and tray / app menu items → where the same thing is in the settings window
const MENU = {
  'menu:update': '版本与更新 → 状态 / 立即重启更新（有新版本时 ⚙ 出现红点直达）',
  'menu:settings': '桌宠窗口的 ⚙ 设置 / 右键她 / Ctrl+⌘ + , → 打开设置窗口',
  'menu:characters': '角色图鉴（列表 + 详情）',
  'menu:history': '玩法 → 和她一起 → 聊天记录（`history-list` / `history-get`）',
  'menu:new-topic': 'LobeHub 与本机 → 话题 → 重新开始话题',
  'menu:adult': '内容与安全 → 成人向内容',
  'menu:local': 'LobeHub 与本机 → 本机能力',
  'menu:actions': '玩法 → 和她一起 → 桌面上的她 → 动作；角色详情 → 舞台上的动作按钮（`admin-cue`）',
  'menu:home': '玩法 → 和她一起 → 桌面上的她 → 回到右下角（`admin-home`）；桌宠行为 → 位置 → 找回桌宠（`admin-place-pet`）',
  'menu:check-update': '版本与更新 → 检查更新',
  'menu:release': '数据与关于 → 危险操作 → 放生并删除 agent',
  'menu:forget': '数据与关于 → 危险操作 → 仅重置本地',
  'menu:log': '数据与关于 → 数据目录 → 打开错误日志',
  'menu:credits': '数据与关于 → 素材署名；角色详情 → 资料',
  'menu:quit': '玩法 → 和她一起 → 桌面上的她 → 退出（`admin-quit`）；托盘和应用菜单也有',
  'toolbar:topics': '玩法 → 和她一起 → 话题（聊聊，`talk-topic`）',
  'toolbar:wardrobe': '角色 → 她的页 → 装扮 → 衣柜（`equip-outfit`）',
  'tray:打开设置…': '打开设置窗口',
  'tray:显示桌宠': '桌宠行为 → 位置 → 找回桌宠',
  'tray:检查更新': '版本与更新 → 检查更新',
  'tray:退出': '— 退出程序',
  'app:关于 Pixel Pet': '— 系统「关于」面板；版本也在 版本与更新',
  'app:偏好设置…': '打开设置窗口（Ctrl/⌘ + ,）',
  'app:退出': '— 退出程序',
};

// The runtime behaviours, and what controls each one in the console. keys = schema field keys
// (settings.json, keys.*, localAbilities); actions = admin-preload channels.
const RUNTIME = [
  { id: 'roam', label: '走动', where: '玩法 → 桌宠行为', keys: ['prefs.roam'], actions: ['admin-place-pet'] },
  { id: 'size', label: '大小', where: '玩法 → 桌宠行为', keys: ['petScale'] },
  { id: 'touch', label: '触摸与音效', where: '玩法 → 桌宠行为', keys: ['prefs.touchZones', 'prefs.touchHint', 'prefs.clickSound', 'prefs.memes', 'prefs.collide'] },
  { id: 'proactive', label: '主动搭话', where: '玩法 → 主动搭话与好感', keys: ['proactive.enabled', 'proactive.speakCooldownMin', 'proactive.boredAfterMin', 'proactive.hungryAt', 'proactive.maxLlmPerHour'] },
  { id: 'affection', label: '好感', where: '玩法 → 主动搭话与好感；角色详情 → 好感', keys: ['affectionRules.dailyCap', 'affectionRules.decay'], actions: ['unlock-all'] },
  { id: 'visitors', label: '同屏伙伴', where: '玩法 → 同屏伙伴', keys: ['visitors', 'prefs.collide'] },
  { id: 'tts', label: '语音（朗读 / TTS）', where: '设置 → 朗读', keys: ['prefs.muted', 'prefs.voice', 'prefs.voiceInteractions', 'prefs.voiceMurmurs', 'tts.provider', 'tts.fallback', 'tts.packs', 'tts.endpoints.fish', 'tts.endpoints.minimax', 'tts.endpoints.local', 'tts.local.api', 'tts.local.model', 'tts.local.voice', 'keys.fish', 'keys.minimax', 'keys.local'], actions: ['tts-clear-cache'] },
  { id: 'voicepacks', label: '语音包', where: '设置 → 语音包', keys: ['tts.packs'], actions: ['voicepacks-reload', 'open-voicepacks-folder'] },
  { id: 'asr', label: '语音输入（ASR）', where: '设置 → 语音输入', keys: ['asr.enabled', 'asr.engine', 'asr.fallback', 'asr.language', 'asr.autoSend', 'asr.maxSeconds', 'asr.lobehub.model', 'asr.local.endpoint', 'asr.local.api', 'asr.local.model', 'asr.local.timeoutSec', 'keys.asrlocal'], actions: ['asr-test'] },
  { id: 'api', label: '对外接口', where: '设置 → 对外接口', keys: ['api.enabled', 'api.port', 'api.token'], actions: ['set-api', 'api-status'] },
  { id: 'update', label: '更新', where: '设置 → 版本与更新', keys: ['update.autoCheck'], actions: ['update-check', 'update-install'] },
  { id: 'safety', label: '安全（成人向 / 本机能力）', where: '设置 → 内容与安全；LobeHub 与本机', keys: ['adultContent', 'localAbilities'], actions: ['confirm-age', 'set-adult'] },
  { id: 'character', label: '角色（服饰 / 模型 / 设定）', where: '角色图鉴 → 角色详情', keys: ['models.<id>', 'systemRoles.<id>', 'framings.<id>', 'vrmPostures.<id>'], actions: ['switch-character', 'equip-outfit', 'set-model', 'set-system-role', 'set-live2d-height', 'set-framing', 'set-vrm-posture'] },
  { id: 'packs', label: '角色包（导入 / 导出 / 删除）', where: '设置 → 角色包；角色详情 → 外观（导入的包成为新角色）', actions: ['import-pack', 'import-live2d', 'import-vrm', 'export-pack', 'remove-pack', 'open-packs-folder'] },
  { id: 'data', label: '数据目录与重置', where: '设置 → 数据与关于', keys: ['system.hardwareAcceleration'], actions: ['open-data-folder', 'open-log', 'release', 'new-topic', 'admin-relaunch'] },
  { id: 'theme', label: '设置窗口外观', where: '设置 → 外观主题', keys: ['ui.theme'] },
];

// window.petAdmin methods no page needs to call, and why
const UNUSED_OK = {
  apiStatus: '对外接口状态随 `api-status` 推送（onApiStatus），不必主动拉取',
  openLink: '外链由 setWindowOpenHandler 打开（素材署名、下载页的 <a target=_blank>）',
};

const uniq = (a) => [...new Set(a)];

// inputs: { leaves, fields (schema FIELDS), restartKeys, adminChannels, petChannels, menuItems, trayItems, appItems }
function audit({ leaves, fields, restartKeys = [], adminChannels, petChannels, menuItems = [], trayItems = [], appItems = [], adminMethods = null, consoleCalls = null }) {
  const problems = [];
  // a bridge method no page calls is a control the console does not show (set-live2d-height was one)
  if (adminMethods && consoleCalls) {
    const used = new Set(consoleCalls);
    for (const m of adminMethods) if (!used.has(m) && !UNUSED_OK[m]) problems.push(`window.petAdmin.${m} 没有任何页面调用：设置窗口里没有它的控件`);
  }
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const admin = new Set(adminChannels);

  const settings = leaves.map((key) => {
    const f = byKey.get(key);
    if (!f) {
      problems.push(`settings.json 的 \`${key}\` 在 settings-schema.js 里没有字段`);
      return { key, status: 'MISSING' };
    }
    const apply = restartKeys.includes(key) ? '重启后生效' : '即时生效';
    if (f.internal) {
      if (!INTERNAL_SETTINGS[key]) problems.push(`\`${key}\` 被标成 internal，但 INTERNAL_SETTINGS 没写原因`);
      return { key, status: 'internal', page: f.page, label: f.label, apply: '—', note: INTERNAL_SETTINGS[key] || '' };
    }
    if (INTERNAL_SETTINGS[key]) problems.push(`\`${key}\` 在 INTERNAL_SETTINGS 里，但 schema 没标 internal`);
    if (f.type === 'readonly') problems.push(`\`${key}\` 是用户设置，却是只读字段`);
    if (['token', 'adult', 'perCharacter'].includes(f.type) && !SPECIAL_SETTINGS[key]) problems.push(`\`${key}\`（${f.type}）没写由哪个控件修改`);
    if (f.type === 'switch' || f.type === 'select' || f.type === 'segmented' || f.type === 'slider' || f.type === 'number' || f.type === 'text' || f.type === 'url' || f.type === 'visitors') {
      if (!f.live && !f.restart) problems.push(`\`${key}\` 既不是即时生效也不是重启生效`);
    }
    return { key, status: 'ok', page: f.page, card: f.card, label: f.label, apply, note: SPECIAL_SETTINGS[key] || '' };
  });
  for (const k of Object.keys(INTERNAL_SETTINGS)) if (!leaves.includes(k)) problems.push(`INTERNAL_SETTINGS 的 \`${k}\` 已不在 settings.json 里`);

  const channels = uniq(petChannels).map((ch) => {
    if (admin.has(ch)) return { channel: ch, status: 'admin', note: '设置窗口有同一通道' };
    if (VIA[ch]) return { channel: ch, status: 'via', note: VIA[ch] };
    if (PET_ONLY[ch]) return { channel: ch, status: 'pet-only', note: PET_ONLY[ch] };
    problems.push(`桌宠窗口通道 \`${ch}\` 在设置窗口里没有对应，也没写为什么不需要`);
    return { channel: ch, status: 'MISSING', note: '' };
  });
  for (const [ch, note] of Object.entries(VIA)) {
    const m = note.match(/`([a-z0-9-]+)`/);
    if (m && m[1] !== 'admin-set' && m[1] !== 'admin-boot' && !admin.has(m[1])) problems.push(`VIA 里 \`${ch}\` 指向的 \`${m[1]}\` 不在 admin-preload 里`);
  }

  // the former ⋯ menu / toolbar items stay in the matrix (where each went); a data-menu item the pet window
  // grows again is audited the same way
  const former = Object.keys(MENU).filter((id) => id.startsWith('menu:') || id.startsWith('toolbar:'));
  for (const [id, note] of Object.entries(MENU)) {
    const m = note.match(/`([a-z0-9-]+)`/g) || [];
    for (const ch of m.map((x) => x.slice(1, -1))) if (!admin.has(ch)) problems.push(`菜单项 \`${id}\` 指向的 \`${ch}\` 不在 admin-preload 里`);
  }
  const menu = [...uniq([...former, ...menuItems.map((m) => `menu:${m}`)]), ...trayItems.map((m) => `tray:${m}`), ...appItems.map((m) => `app:${m}`)].map((id) => {
    if (!MENU[id]) {
      problems.push(`菜单项 \`${id}\` 在设置窗口里没有对应，也没写为什么不需要`);
      return { id, status: 'MISSING', note: '' };
    }
    return { id, status: MENU[id].startsWith('—') ? 'n/a' : 'ok', note: MENU[id].replace(/^—\s*/, '') };
  });

  const runtime = RUNTIME.map((r) => {
    const missing = [...(r.keys || []).filter((k) => !byKey.has(k)), ...(r.actions || []).filter((a) => !admin.has(a))];
    if (missing.length) problems.push(`运行时行为「${r.label}」的控制 ${missing.map((m) => `\`${m}\``).join('、')} 不在设置窗口里`);
    const keys = r.keys || [];
    const apply = keys.some((k) => restartKeys.includes(k)) ? '即时生效（硬件加速需重启）' : '即时生效';
    return { ...r, status: missing.length ? 'MISSING' : 'ok', apply };
  });

  return { settings, channels, menu, runtime, problems };
}

// The audit's inputs, read from the sources: settings leaves and fields from the schema, channels from both
// preloads, menu items from the pet window's HTML and main.js's tray / app menu templates.
function collect(root) {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
  const schema = require(path.join(root, 'src', 'core', 'settings-schema.js'));
  const settingsLib = require(path.join(root, 'src', 'core', 'settings.js'));
  const chans = (src) => [...src.matchAll(/ipcRenderer\.(?:invoke|send)\('([a-z0-9-]+)'/g)].map((m) => m[1]);
  const main = read('src', 'main', 'main.js');
  const between = (src, start, end) => {
    const i = src.indexOf(start);
    return i < 0 ? '' : src.slice(i, src.indexOf(end, i));
  };
  const labels = (src) => [...src.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  return {
    leaves: schema.settingsLeaves(),
    fields: schema.FIELDS,
    restartKeys: settingsLib.RESTART_KEYS,
    adminChannels: uniq(chans(read('src', 'main', 'admin-preload.js'))),
    petChannels: uniq(chans(read('src', 'main', 'preload.js'))),
    menuItems: uniq([...read('src', 'renderer', 'index.html').matchAll(/data-menu="([a-z0-9-]+)"/g)].map((m) => m[1])),
    trayItems: labels(between(main, 'trayMenu = Menu.buildFromTemplate([', ']);')),
    appItems: labels(between(main, 'Menu.setApplicationMenu(Menu.buildFromTemplate([', "{ role: 'editMenu' }")),
    // window.petAdmin's methods, and the ones the console's code calls (api().x / a.x)
    adminMethods: [...between(read('src', 'main', 'admin-preload.js'), "exposeInMainWorld('petAdmin'", '});').matchAll(/^\s{2}([a-zA-Z0-9]+):/gm)].map((m) => m[1]),
    consoleCalls: uniq(walk(path.join(root, 'admin', 'src')).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/\b(?:api\(\)|a)\.([a-zA-Z0-9]+)\b/g)].map((m) => m[1]))),
  };
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
  }
}

const cell = (s) => String(s || '').replace(/\|/g, '\\|');

// §12 of docs/admin-console-design.md, from the audit rows (scripts/check-admin-console-doc.js --write puts it in)
function renderMatrix(r) {
  const L = [];
  L.push('<!-- coverage-matrix:start (generated by `node scripts/check-admin-console-doc.js --write`; do not edit by hand) -->');
  L.push('');
  L.push(`### 12.1 settings.json：${r.settings.length} 个叶子键`);
  L.push('');
  L.push('| 键 | 页面 | 名称 | 生效 | 说明 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const s of r.settings) L.push(`| \`${s.key}\` | ${cell(s.status === 'internal' ? `${s.page}（内部）` : s.page)} | ${cell(s.label)} | ${s.apply || ''} | ${cell(s.note)} |`);
  L.push('');
  L.push(`### 12.2 运行时行为控制：${r.runtime.length} 项`);
  L.push('');
  L.push('| 行为 | 后台位置 | 设置项 | 操作（admin-preload 通道） | 生效 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const x of r.runtime) L.push(`| ${x.label} | ${cell(x.where)} | ${(x.keys || []).map((k) => `\`${k}\``).join(' ') || '—'} | ${(x.actions || []).map((k) => `\`${k}\``).join(' ') || '—'} | ${x.apply} |`);
  L.push('');
  L.push(`### 12.3 菜单（原 ⋯ 菜单与工具栏 / 托盘 / 应用菜单）：${r.menu.length} 项`);
  L.push('');
  L.push('桌宠窗口只保留 喂食 / 玩耍 / 睡觉 / 聊天 + ⚙ 设置（T-2718）；`menu:` / `toolbar:` 行是原 ⋯ 菜单和工具栏按钮现在在设置窗口里的位置。');
  L.push('');
  L.push('| 菜单项 | 后台对应 |');
  L.push('| --- | --- |');
  for (const m of r.menu) L.push(`| \`${m.id}\` | ${m.status === 'n/a' ? '不需要：' : ''}${cell(m.note)} |`);
  L.push('');
  const by = (st) => r.channels.filter((c) => c.status === st);
  L.push(`### 12.4 桌宠窗口通道（src/main/preload.js）：${r.channels.length} 个`);
  L.push('');
  L.push(`- 设置窗口有同一通道（${by('admin').length}）：${by('admin').map((c) => `\`${c.channel}\``).join(' ')}`);
  L.push(`- 设置窗口用别的通道做同一件事（${by('via').length}）：`);
  for (const c of by('via')) L.push(`  - \`${c.channel}\` → ${c.note}`);
  L.push(`- 不是配置，只在桌宠窗口（${by('pet-only').length}）：`);
  for (const c of by('pet-only')) L.push(`  - \`${c.channel}\`：${c.note}`);
  L.push('');
  L.push(`缺失：${r.problems.length ? r.problems.length : '无'}`);
  for (const p of r.problems) L.push(`- ${p}`);
  L.push('');
  L.push('<!-- coverage-matrix:end -->');
  return L.join('\n');
}

module.exports = { UNUSED_OK, INTERNAL_SETTINGS, SPECIAL_SETTINGS, VIA, PET_ONLY, MENU, RUNTIME, audit, collect, renderMatrix };
