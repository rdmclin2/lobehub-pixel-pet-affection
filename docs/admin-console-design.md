# 配置后台（Admin Console）与 lobe-design 接入方案

> 状态：设计稿（勘察结论 + 实施方案），尚未实现。
> 基线：`main` = `canary` @ `7bae23a`（v0.19.0）。所有行号、默认值都按这个版本的源码读出，没有凭记忆写。
> 范围：只写调研结论和方案。实现拆成后面的任务（§8），本稿不改任何应用代码。
> 实施进度：T1（lobe-design 初始化）与设计系统已落地，见 [design-system.md](design-system.md)。T3–T7 与 T9 的主动行为 / 好感参数已在配置后台落地，见 §10。与本稿的差异：`@lobehub/ui` 6.x 已没有 `ThemeProvider`，明暗改用 `setLobeTheme` + `data-theme`；`ConfigProvider` 需设 `enableCustomFonts={false}` 才不会去 CDN 拉字体。
> 核对：`node scripts/check-admin-console-doc.js` 检查本文是否覆盖 `settings.json` 的全部 key 和设置类 IPC 通道（§9）。

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 配置有多少 | `settings.json` 有 **44 个叶子 key**（`normalizeSettings(null)` 展开得到），分 7 组（§2）；另有 `pet.json` 里每个角色可改的 6 个字段、`tts-keys.json` 的 4 个密钥槽，以及 8 个写死的主动行为 / 好感常量，可以作为后续配置项的候选（§2.5）。 |
| 改了要不要重启 | **全部即时生效，没有一项要重启**。现在的问题在别处：按角色改的设置（`set-model` / `set-system-role` / `unlock-all` / 导入、删除角色包）只把新 view 回给调用它的窗口，不广播。后台单独开一个窗口后，这个缺口必须先补（§5.4）。 |
| 角色列表数据从哪来 | `src/characters/*.json`（5 位）、角色包（内置 17 个 + 用户导入，类型有 sprites / pictures / rig / live2d / vrm）、语音包（内置 5 个 + 用户的）、`pet.json` 的 `characters[id]`（名字、好感、服饰），加上 `settings.appearance/models/systemRoles`。`PetService.view().characters` 已经汇总了其中大部分（§3）。 |
| lobe-design 怎么初始化 | 按 skill v5.9.0 的 `05-init` 流程，把 skill 装进 `.agents/skills/lobe-design`，写入 `AGENTS.md` 托管块，生成 `.agents/ux/product.md`（`平台：desktop`）和 `.agents/ux/components.md`。lint 只管后台的源码；桌宠窗口的像素风格用 `lint-allow` 豁免（§4.2）。 |
| 技术选型 | **后台用 Vite + React 19 + `@lobehub/ui` 6.x（含 `/dashboard`、`/form`）**，桌宠窗口继续用原生 JS。后台源码放 `admin/`，构建产物输出到 `src/admin-ui/`（不进 git），由 `predist:*` / `prestart` 自动构建，所以 `build.files: src/**` 不用改。依赖都放在 devDependencies，安装包里不会多出 `node_modules`（§4.3）。 |
| 挂载方式 | 主进程开一个**独立的单例 `BrowserWindow`**（`openAdmin(section)`），配专用的 `admin-preload.js`，它只暴露设置和角色相关的白名单 API。入口有 4 个：⋯ 菜单 / 右键菜单里的「设置…」、桌宠窗口获得焦点时按 `CmdOrCtrl+,`、macOS 应用菜单「偏好设置…」，以及新增的托盘菜单。同步机制：主进程是唯一的数据源，`settings` 和 `update` 两个事件广播给所有桌宠窗口和后台窗口（§5）。 |
| 界面信息架构 | 照搬 LobeHub `/settings` 的骨架：左侧是分组手风琴导航，右侧每页先放 `SettingHeader`，下面是 `Form itemsType="group" variant="filled"` 的表单卡片，`maxWidth: 1024`，主题跟随系统明暗。一共 6 组 15 页（§6）。 |

## 1. 勘察方法与边界

- 读过的源码：`src/core/settings.js` `store.js` `migrate.js` `models.js` `tts.js` `tts-keys.js` `tts-cache.js` `asr.js` `proactive.js` `affection.js` `voice.js` `voice-pack.js` `content-guard.js` `species.js` `packs.js` `outfits.js` `persona.js` `vrm-import.js` `update.js`，`src/main/main.js` `pet-service.js` `preload.js` `packs.js` `updater.js`，`src/renderer/index.html` `app.js`，`.github/workflows/*.yml`，`package.json`。
- 入口现状：**没有托盘，没有全局快捷键，也没有原生菜单**（`main.js` 只调了 `setMenuBarVisibility(false)`）。所有设置都通过桌宠窗口里的 ⋯ 弹出菜单 `#main-menu` 进入，在桌宠右键或触屏长按时打开的也是这个菜单（`app.js` `openMenuAtPet`）。菜单进入的面板 `#panel` 会把窗口放大到 460×540。
- `#panel` 的面板种类（`renderPanel`）：`advanced`（高级设置）、`characters`（角色列表 → 角色详情页）、`wardrobe`（衣柜）、`topics`（话题）、`history`（聊天记录）。前两个是配置，后三个是玩法和内容，留在桌宠窗口。
- 「编辑入口」一列的写法：`⋯ → 高级设置 → 小节名`，或 `⋯ → 角色列表 → 她的页 → 小节名`。

## 2. 配置项盘点

存储位置有三处：

| 文件（`userData/`） | 写入方 | 说明 |
| --- | --- | --- |
| `settings.json` | `SettingsStore`（`core/settings.js`），每次保存都先过 `normalizeSettings` | 属于主人层面的设置，放生桌宠后仍然保留。**本节的主体**。 |
| `pet.json` | `Store`（`core/store.js`），schema 3（`core/migrate.js`） | 每个角色的进度：`characters[id]`，以及共享字段 `speciesId` `space` `localAbilities`… |
| `tts-keys.json` | `TtsKeyStore`（`core/tts-keys.js`） | 语音和识别服务的 API Key。只能写入，界面只显示「已设置」，不回显内容。 |

主进程对外提供的读取视图是 `PetService.settingsView()`。它等于 `settings` 加上 5 个派生的只读字段：`needsAgeGate`、`petScaleRange`（`PET_SCALE`）、`systemRoleMax`（1000）、`ttsStatus`（各引擎状态、Key 是否已设、缓存条数和字节数、语音包列表）、`asrStatus`。后台读设置时直接用这个视图。

「生效」一列的含义：**即时** = setter 保存后立刻 `emit('settings')`，所有桌宠窗口通过 `onSettings` 重新应用；**即时·仅回调用方** = 只返回 view、不广播（缺口，见 §5.4）。**没有任何一项需要重启。**

### 2.1 模型与连接

| key | 类型 | 默认值 | 取值范围 / 校验 | 当前编辑入口 · IPC | 生效 |
| --- | --- | --- | --- | --- | --- |
| `models.<id>` | `{[characterId]: "provider:model"}` | `{}`（未选时按角色文件的 `models.prefer` 取，再不行取第一个能用的） | 角色 id `^[a-z]{2,20}$`；值 `^[a-z0-9-]{2,40}:[A-Za-z0-9._-]{1,80}$`；只能选 `models.optionsFor(id)` 列出的、这个角色所属厂商的模型（`lobehub` 托管的优先，其次是厂商自己的 provider；不含只出图的模型） | ⋯ → 角色列表 → 她的页 → 模型 · `set-model`（`refresh-models` 刷新模型目录） | 当前角色在后台执行 `lh agent edit -m/-p`；其他角色在下次轮到她说话前应用 · 仅回调用方 |
| `api.enabled` | boolean | `false` | 没有 token 时强制为 `false` | ⋯ → 高级设置 → 对外接口（本机 HTTP） · `set-api` | 即时：`applyApi()` 起停 `127.0.0.1` 上的服务，并广播 `api-status` |
| `api.port` | int | `7340` | 1024–65535，超出范围时回到 7340 | 同上 · `set-api` | 即时（重新监听） |
| `api.token` | string | `''` | `^[A-Za-z0-9_-]{24,64}$`；第一次开启时自动生成，可以「换一个令牌」（`set-api {newToken:true}`） | 同上 · `set-api` / `api-status` | 即时 |

同组还有以下不在 `settings.json` 里的项（后台也要放进来）：

| 项 | 存在 | 类型 / 值 | 入口 · IPC | 备注 |
| --- | --- | --- | --- | --- |
| 本机能力 `localAbilities` | `pet.json`（共享） | boolean，唤醒时默认勾上 | 唤醒页复选框；⋯ → 本机能力：… · `set-local` | 开启前有 `confirm` 二次确认；需要 `lh connect` 或 Responses API 可用。属于高风险项。 |
| LobeHub 空间 `space` | `pet.json`（共享） | `{workspaceId,name}` 或个人空间 | 只在唤醒时选择（`spaces`、`hatch`） | 唤醒后不能再改。后台只展示，同时显示 `whoami`。 |
| 话题 `topicId` | `pet.json` 的 `characters[id]` | string \| null | ⋯ → 重新开始话题 · `new-topic` | 属于动作，不是配置。放进「数据」页。 |

对外接口的运行时回传通道 `api-reply`（桌宠窗口执行完 `api-cmd` 后回结果）不是配置，后台不用。

### 2.2 角色与外观

| key | 类型 | 默认值 | 取值范围 / 校验 | 当前编辑入口 · IPC | 生效 |
| --- | --- | --- | --- | --- | --- |
| `characterModel` | int | 新文件 `2`；没有这个字段的旧文件视为 `1` | T-2764：`2` = 每个形象就是一个独立角色（`core/characters.js`）。旧文件里的 `appearance.<id>`（按角色选的形象包）在启动时由 `core/character-migrate.js` 迁移一次：当前角色 + 所选包 → `pet.json` 的 `characterId`，`framings` / `visitors` 改按角色 id，原值只读保留在 `legacyAppearance` | 只读（内部标记） | 启动时 |
| `framings.<id>` | `{[characterId]: 'full' \| 'half'}` | `{}`（没有这一项 = 跟随角色包 `pack.json` 的 `framing`，再跟随全局 `prefs.framing`） | 只收 `full` / `half`；`auto` 删除这一项（`normalizeFramings`） | 设置窗口 → 角色 → 她的页 → 装扮 → 取景（跟随 / 全身 / 半身） · `set-framing` | 即时：桌宠窗口的 VRM 原地换取景（相机滑过去，不重载模型），见 `docs/half-body-mode.md` |
| `vrmPostures.<id>` | `{[vrmPackId]: posture}` | `{}`（没有这一项 = 自动：待机时 VRM 导演自己换姿势） | 只收 `stand.relaxed` / `stand.confident` / `stand.shy` / `stand.playful` / `sit.rest` / `sit.doze`；`auto` 删除这一项（`normalizeVrmPostures`） | 设置窗口 → 角色 → 她的页 → 装扮 → VRM 姿势（VRM 角色的页面上出现） · `set-vrm-posture` | 即时：桌宠窗口的 VRM 导演换到这个姿势（`docs/vrm-motion-system.md`） |
| `systemRoles.<id>` | `{[characterId]: string}` | `{}` | 经过 `cleanSystemRole`：去掉控制字符，最多 `SYSTEM_ROLE_MAX` = 1000 字；空串会删除这一项 | ⋯ → 角色列表 → 她的页 → 个性化设定（System Role） · `set-system-role` | 当前角色在后台更新 agent 的 system role（personaKey 变了）；其他角色在下次说话前更新 · 仅回调用方 |
| `petScale` | number | `1.25` | `PET_SCALE` 0.5–2.5，两位小数；窗口会按屏幕大小再收一次（`fitScale`） | ⋯ → 高级设置 → 宠物大小（滑块 50–250%，步长 5）；桌面上拖左上角手柄；Ctrl/⌘+滚轮 · `set-pet-scale`（拖动中用 `preview-pet-scale`） | 即时（`resizePet`） |
| `petScaleSet` | boolean | `false` | 内部标记，表示主人是否手动选过大小（选过就不再跟随默认值）。由 `set-pet-scale` 置为 true，「恢复默认」不会清它 | 不直接编辑 | — |
| `visitors` | string[] | `[]` | 角色 id，去重，最多 `MAX_VISITORS` = 3 个，不能是当前角色 | ⋯ → 高级设置 → 同屏伙伴 · `set-visitors` | 即时（`syncVisitors` 开关串门窗口） |

同组还有以下 `pet.json` 字段：

| 项 | 类型 | 入口 · IPC | 备注 |
| --- | --- | --- | --- |
| 当前角色 `speciesId` | 角色 id | ⋯ → 角色列表 → 切换 / 初次见面 · `switch-character` | 第一次见面要起名，并为她新建一个 LobeHub agent |
| 名字 `characters[id].name` | string ≤ 12 | 只在初次见面时填（`switch-character {name}`、唤醒页） | 目前没有改名入口，后台可以考虑补上（§8 T9） |
| 穿着 `characters[id].equippedOutfit` | 服饰 id（`outfits.js` 的 `OUTFITS`） | 衣柜 · `equip-outfit` | 衣柜属于玩法，留在桌宠里；后台角色详情页只读展示 |
| 好感进度 | number 0–100 | ⋯ → 角色列表 → 她的页 → 好感度 · 一键解锁 · `unlock-all` | 把好感拉满、解锁所有阶段，对没见过的角色无效 · 仅回调用方 |
| Live2D 高度 | number | 外观区里的 Live2D 模型 · `set-live2d-height` | 写在角色包的 `pack.json` 里 |

### 2.3 语音（朗读，TTS）

| key | 类型 | 默认值 | 取值范围 / 校验 | 当前编辑入口 · IPC | 生效 |
| --- | --- | --- | --- | --- | --- |
| `prefs.muted` | boolean | `false` | 开着时盖过下面所有朗读开关和 `prefs.clickSound`，但不改它们的值 | 桌宠工具栏喇叭按钮；设置 → 朗读 → 静音 · `set-prefs` | 即时；开启时 `tts.engine.stopAll()`，渲染进程立刻停掉正在读的话 |
| `prefs.voice` | boolean | `false` | — | ⋯ → 高级设置 → 桌宠行为 → 朗读回复 · `set-prefs` | 即时；关闭时 `tts.engine.stopAll()` |
| `prefs.voiceInteractions` | boolean | `true` | 要 `prefs.voice` 开着才起作用 | 同上 → 互动语音 · `set-prefs` | 即时（开启后会预合成 `tts-prewarm`） |
| `prefs.voiceMurmurs` | boolean | `false` | 要 `prefs.voice` 开着才起作用 | 同上 → 朗读碎碎念 · `set-prefs` | 即时 |
| `tts.provider` | enum | `'auto'` | `auto` \| `fish` \| `minimax` \| `elevenlabs` \| `local` \| `system`（`ENGINES`） | ⋯ → 高级设置 → 语音 → 引擎 · `set-tts` | 即时（重置熔断器、停止预热） |
| `tts.providerSet` | boolean | `false` | 内部标记：主人选过引擎。没有这个标记的旧设置迁移成 `auto` | 不直接编辑（`set-tts {provider}` 时置 true） | — |
| `tts.fallback` | enum | `'system'` | `system` \| `silent`（`FALLBACKS`） | 语音 → 用不了时 · `set-tts` | 即时 |
| `tts.packs` | boolean | `true` | — | 语音 → 语音包 · `set-tts` | 即时 |
| `tts.endpoints.fish` | URL string | `''`（为空时用官方地址 `https://api.fish.audio`） | 必须是 https；只有本机调试可以用 http://127.0.0.1 / localhost / [::1]；不能带用户名和密码 | 语音 → Fish Audio → 端点 · `set-tts` | 即时；不合法时 `reason:'bad-endpoint'` |
| `tts.endpoints.minimax` | URL string | `''`（官方 `https://api.minimax.cn`） | 同上 | 语音 → MiniMax → 端点 · `set-tts` | 即时 |
| `tts.endpoints.elevenlabs` | URL string | `''`（官方 `https://api.elevenlabs.io`） | 同上 | 语音 → ElevenLabs → 端点 · `set-tts` | 即时 |
| `tts.endpoints.local` | URL string | `''`（为空时本地引擎不可用） | https，或者本机 / 局域网的 http（10.x、192.168.x、172.16–31.x、*.local） | 语音 → 本地语音服务 → 地址 · `set-tts` | 即时 |
| `tts.local.api` | enum | `'openai'` | `openai`（`/v1/audio/speech`）\| `whale`（`/tts`） | 语音 → 本地语音服务 → 接口 · `set-tts` | 即时 |
| `tts.local.model` | string | `''`（请求时用 `tts-1`） | 去掉首尾空白，最多 80 字 | 语音 → 本地语音服务 → 模型 · `set-tts` | 即时 |
| `tts.local.voice` | string | `''`（请求时用 `default`） | 最多 80 字；角色文件里的 `voice.tts.local.voice` 优先 | 语音 → 本地语音服务 → 音色名 · `set-tts` | 即时 |
| `tts.elevenlabs.voiceId` | string | `''`（没有音色时不用 ElevenLabs） | 从 ElevenLabs Voice Library 复制的 voice_id：去掉首尾空白后为空，或 10–40 位字母和数字（`^[A-Za-z0-9]{10,40}$`，否则 `reason:'pattern'`）；角色文件里的 `voice.tts.elevenlabs.voiceId` 优先 | 语音 → ElevenLabs → 默认音色 ID · `set-tts` | 即时 |
| `tts.elevenlabs.modelId` | enum | `'eleven_multilingual_v2'` | 设置窗口里是下拉：`eleven_multilingual_v2` \| `eleven_flash_v2_5` \| `eleven_turbo_v2_5` \| `eleven_v3`（其它值 `reason:'option'`）；settings.json 里最多 80 字，空串回到默认；角色文件里的 `voice.tts.elevenlabs.model` 优先 | 语音 → ElevenLabs → 模型 · `set-tts` | 即时 |

语音的密钥和操作：

- Key `fish` / `minimax` / `elevenlabs` / `local` 存在 `tts-keys.json` 里，格式是 `^[\x21-\x7e]{8,256}$`。入口是语音 → 各引擎 → Key 保存 / 清除，调用 `set-tts {key:{id,value}}`，格式不对时返回 `bad-key`。Windows / Linux 用 safeStorage 加密，macOS 用权限 0600 的明文文件。
- 动作：`tts-clear-cache`（清空语音缓存）、`open-voicepacks-folder`、`voicepacks-reload`（重新读语音包）。「试听一句」在渲染进程里调 `speak()`，最后走到 `tts-synthesize`。运行时还有 `tts-cancel` 和 `tts-prewarm`，它们不是配置。
- 角色自己的音色（`voice.tts.fish.referenceId`、语速、moodTags…）写在 `src/characters/<id>.json` 里，**界面上不能改**。后台只读展示，同时显示音色的署名。

### 2.4 语音输入（ASR）

| key | 类型 | 默认值 | 取值范围 / 校验 | 当前编辑入口 · IPC | 生效 |
| --- | --- | --- | --- | --- | --- |
| `asr.enabled` | boolean | `false` | — | ⋯ → 高级设置 → 语音输入 → 开启语音输入 · `set-asr` | 即时（聊天框旁边出现 🎤）；关闭时 `asr.cancel()` |
| `asr.engine` | enum | `'lobehub'` | `lobehub` \| `local` \| `off`；旧的 `provider` 字段会被迁移过来 | 语音输入 → 引擎 · `set-asr` | 即时（重置熔断器） |
| `asr.fallback` | boolean | `false` | 选的引擎失败时，改用另一个再试一次 | 语音输入 → 用不了时换另一个引擎 · `set-asr` | 即时 |
| `asr.language` | string | `'auto'` | `^(auto\|[a-z]{2})$`；界面上只列 auto / zh / en / ja / ko / fr / de / es / ru | 语音输入 → 语言 · `set-asr` | 即时 |
| `asr.maxSeconds` | int | `60` | 5–120 | **界面上没有入口**（只在说明文字里显示），只能手改 `settings.json` | 下一次录音时生效 |
| `asr.autoSend` | boolean | `false` | — | 语音输入 → 识别后直接发送 · `set-asr` | 即时 |
| `asr.hotkey` | Electron accelerator string | `'CommandOrControl+Shift+Space'` | `''` = 关闭；至少一个修饰键（只有 Shift 不行）+ 一个已知普通键；不能和应用内快捷键（⌘/Ctrl+, 等）重复；缺省或读不懂时回到默认值（`core/hotkey.js`） | 语音输入 → 快捷键 → 唤起语音对话（HotkeyInput）· `admin-set` | 即时（`main/voice-hotkey.js` 注销旧的再注册新的；被系统或其他应用占用时不保存，`hotkey-taken`） |
| `asr.lobehub.model` | string | `'gpt-4o-mini-transcribe'` | `^[A-Za-z0-9._:/-]{1,80}$`；界面上只给两个选项（mini / 完整版 `gpt-4o-transcribe`） | 语音输入 → LobeHub 云端识别 → 模型 · `set-asr` | 即时 |
| `asr.local.endpoint` | URL string | `'http://127.0.0.1:8179'` | https，或本机 / 局域网的 http；不能带 query、hash 或账号密码；不合法时回到默认值 | 语音输入 → 本地识别服务 → 地址 · `set-asr` | 即时；不合法时 `bad-endpoint` |
| `asr.local.api` | enum | `'openai'` | `openai`（`/v1/audio/transcriptions`）\| `whispercpp`（`/inference`） | 同上 → 接口 · `set-asr` | 即时 |
| `asr.local.model` | string | `'whisper-1'` | 同 `MODEL_RE` | 同上 → 模型 · `set-asr` | 即时 |
| `asr.local.timeoutSec` | int | `30` | 5–120 | **界面上没有入口** | 下一次识别时生效 |

另外：本地识别服务的 Key（`tts-keys.json` 里的 `asrlocal`）通过 `set-asr {key}` 写入，传空串会删除。动作有 `asr-test`（测试连接）和 `asr-mic-access`（macOS 麦克风授权）。运行时的 `asr-transcribe`、`asr-cancel` 不是配置。

### 2.5 桌宠行为、主动行为与好感度

| key | 类型 | 默认值 | 取值范围 / 校验 | 当前编辑入口 · IPC | 生效 |
| --- | --- | --- | --- | --- | --- |
| `prefs.roam` | boolean | `true` | — | ⋯ → 高级设置 → 桌宠行为 → 自己走动 · `set-prefs` | 即时（面板打开时强制不走） |
| `prefs.clickSound` | boolean | `false` | — | 同上 → 点击音效 · `set-prefs` | 即时 |
| `prefs.memes` | boolean | `true` | — | 同上 → 梗图 · `set-prefs` | 即时 |
| `prefs.collide` | boolean | `true` | 只在有同屏伙伴时有意义 | 同上 → 互相碰撞 · `set-prefs` | 即时 |
| `prefs.danceVolume` | number | `60` | 0–100（%），VRM 跳舞时音乐的音量；说话时自动压低，`prefs.muted` 时不出声 | 玩法 → 和她一起 → 舞蹈 → 音乐音量 · `set-prefs` | 即时 |
| `prefs.touchZones` | boolean | `true` | 关闭后点哪里都是普通的摸摸 | 同上 → 部位触摸 · `set-prefs` | 即时 |
| `prefs.touchHint` | boolean | `true` | 要 `prefs.touchZones` 开着才起作用 | 同上 → 触摸提示 · `set-prefs` | 即时 |
| `prefs.framing` | `'full' \| 'half'` | `'full'` | 其它值（含旧文件里没有这一项）都按 `full` 读（`normalizePrefs`）；角色自己的 `framings.<id>` 和角色包的 `framing` 优先 | 设置窗口 → 玩法 → 桌宠行为 → 大小与取景 → 取景 · `admin-set` → `set-prefs` | 即时（目前只对 VRM 生效，见 `docs/half-body-mode.md`） |

`prefs.voice*` 归在 §2.3。主动行为（`core/proactive.js`）和好感度（`core/affection.js`）**目前都没有用户配置项**，参数都是写死的常量，列在这里作为候选（本期不做，见 §8 T10）：

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `proactive.DEFAULTS.speakCooldownMin` | 12 分钟 | 主动说话的冷却时间 |
| `proactive.DEFAULTS.boredAfterMin` | 45 分钟 | 多久没互动算「无聊」 |
| `proactive.DEFAULTS.hungryAt` | 75 | 饥饿阈值 |
| `proactive.DEFAULTS.maxLlmPerHour` | 6 | 每小时最多花几次 LLM 调用（`LlmBudget`） |
| `HEARTBEAT_MS` | 30 秒（测试模式下 2 秒） | `main.js` 心跳间隔 |
| `affection.DAILY_CAP` | 12 | 每个好感日能涨的上限 |
| `affection.DAY_ROLLOVER_HOUR` | 4 | 好感日的分界时刻 |
| `affection.DECAY` | 48 小时宽限，之后每 12 小时减 1，一次缺席最多减 8 | 好感衰减 |

### 2.6 内容与安全

| key | 类型 | 默认值 | 取值范围 / 校验 | 当前编辑入口 · IPC | 生效 |
| --- | --- | --- | --- | --- | --- |
| `ageGateVersion` | int | `0` | 当前版本是 `AGE_GATE_VERSION` = 2；不一致时视为没答过，会重新询问 | 18+ 确认页（首次启动） · `confirm-age` | 即时 |
| `answered` | boolean | `false` | 只有版本一致时才算答过 | 同上 · `confirm-age` | 即时 |
| `ageConfirmed` | boolean | `false` | 只在当前版本下答了「已满 18」时为 true | 同上 · `confirm-age` | 即时 |
| `ageConfirmedAt` | number \| null | `null` | 时间戳；没确认时为 null | 同上（只读展示） | — |
| `adultContent` | boolean | `false` | 要求 `ageConfirmed`；打开**只能**走同一个 18+ 确认，关闭随时可以 | ⋯ → 成人向内容：… · `set-adult`（没确认过时先弹确认页，调 `confirm-age`） | 即时（`_applySettings` 会换下 18+ 服饰和外观） |

内容防线（`core/content-guard.js`）、system role 里的内容红线（`core/persona.js` 的 `CONTENT_RULES`）、VRM 授权限制（不能再分发的模型不能导出，禁止性表现的模型不能用于 18+）都是**写死的规则，不开放配置**。后台「内容与安全」页只展示说明和当前状态。打开成人向内容必须复用现有的确认流程，不能做成一个普通开关（P-05：高风险项单独放一区）。

### 2.7 更新与高级

`settings.json` 里**没有更新相关的 key**。更新行为是写死的（`updater.js`：启动约 20 秒后检查一次，之后每 4 小时一次；后台下载；离开电脑 10 分钟后自动安装；退出时也会安装）。后台只提供动作和状态：

| 项 | 入口 · IPC | 备注 |
| --- | --- | --- |
| 检查更新 | ⋯ → 检查更新；高级设置 → 版本与更新 · `update-check` | 状态通过 `update-status` 推送：idle / checking / latest / downloading / ready / manual / error / disabled |
| 立即更新 | ⋯ → 新版本；同上 · `update-install` | |
| 打开错误日志 | ⋯ → 打开错误日志 · `open-log` | `userData/pixel-pet.log` |
| 打开角色包文件夹 / 语音包文件夹 | `open-packs-folder` / `open-voicepacks-folder` | |
| 仅重置本地 / 放生并删除 agent | ⋯ 菜单 · `release {deleteAgent}` | 危险操作，要二次确认，并且要把会删除哪些东西写清楚 |
| 素材署名 | ⋯ → 素材署名（`alert`） | 改成后台的「关于」页 |

### 2.8 盘点中发现的问题（后续实现要处理）

1. `asr.maxSeconds`、`asr.local.timeoutSec` 有校验，但界面上没有入口 → 后台补上（`InputNumber`，取值 5–120）。
2. 按角色改的 setter（`setModel`、`setSystemRole`、`unlockAll`）都只把新 view 返回给调用方，不会 `emit('update')`（角色包的导入、删除走 `setPacks()`，会 emit，但 `update` 也只发给主桌宠窗口）。现在桌宠窗口是自己调自己，所以没出问题；后台在另一个窗口里调用时，桌宠窗口就收不到变化（§5.4）。
3. `main.js` 的 `send()` 只发给主桌宠窗口，`sendAll()` 只发给 `pets` 这个 Map。如果把后台窗口直接塞进 `pets`，它会参与碰撞和 `peers`，所以要单独维护一个广播集合。
4. 没有托盘，也没有 `CmdOrCtrl+,`。桌宠被拖出屏幕或被盖住时，就找不到设置入口了。
5. 名字 `characters[id].name` 起好之后不能改。
6. 设置面板挤在 460×540 的窗口里，「高级设置」一页叠了 8 节（宠物大小、桌宠行为、语音、语音输入、同屏伙伴、对外接口、版本与更新……），已经超过 M-08 认知负荷的上限（一页超过 7 块就应该分层）。

## 3. 角色列表

### 3.1 数据来源

| 来源 | 内容 | 读法 |
| --- | --- | --- |
| `src/characters/<id>.json` → `core/species.js` `SPECIES` | 5 位角色：dafeiyu、claude、grok、gemini、gpt（按 `order` 排序）。字段有 `id vendor model name nameZh title accent blurb personality catchphrase likes adult outfits art{kind,packs,clips…} voice{…,tts} models{match,providers,prefer} memes credits touch` | 内置、只读；校验在 `validateCharacter` 里。退役的 id（`bubbo` / `embit` / `sprig`）由 `resolveSpeciesId` 映射到现有角色。 |
| 角色包（`core/packs.js` + `src/main/packs.js` 的 `PackStore`） | 内置的放在 `src/renderer/packs/`，共 17 个：每位角色有 `*-pixel` `*-classic` `*-adult`（18+），大肥鱼另外有 `dafeiyu-live2d`（live2d）和 `dafeiyu-live`（rig）。用户导入的放在 `userData/packs/`。`kind` 有 sprites / pictures / rig / live2d / vrm 五种；字段有 `id name author license version description species adult source(builtin\|user) outfits` | `packsFor(packs, speciesId, adultOk)`，以及 `PetService.appearanceView(id)`；VRM 的授权信息看 `vrmView(p)` |
| 导入 | `import-pack`（文件夹或 zip）、`import-live2d`（.model3.json 或 zip，Cubism 3–5）、`import-vrm`（.vrm，带授权确认卡片），对应 `core/vrm-import.js` | 主进程弹出文件对话框，导入完成后 `setPacks()` → `emit('update')` |
| 语音包（`core/voice-pack.js` 的 `VoicePacks`） | 内置的放在 `src/voicepacks/<id>/`，共 5 个，例如 `claude-minimax`：engine minimax，219 句。用户的放在 `userData/voicepacks/<id>/`，同一个角色时覆盖内置的 | `list()` 返回 `{id,name,character,engine,voiceId,credit,lines,builtIn}`，已经包含在 `settingsView().ttsStatus.packs` 里 |
| 进度（`pet.json` 的 `characters[id]`，`core/migrate.js`） | `name agentId topicId affection relStage peakStage equippedOutfit modelApplied …`；没见过的角色没有这一项 | `PetService.view().characters[i].met` |
| 按角色的设置 | `settings.appearance/models/systemRoles[id]` | `view().characters[i].appearance/model/systemRole` |
| 人设（`core/persona.js`） | `buildSystemRole` = 角色文件的 personality + 关系阶段 + 内容红线 + 主人写的个性化设定；`PERSONA_VERSION` = 8 | 后台只读展示「生效中的 system role 摘要」（可选） |
| 服饰（`core/outfits.js`） | 24 套 `OUTFITS`（14 套全年龄、10 套 adult），每套有解锁阶段和分级；`listOutfits` 按她的外观过滤 | 角色详情页只读展示：已解锁几套 / 一共几套、当前穿着 |

`PetService.view().characters` 现在已经为每位角色给出：`id nameZh vendor title accent current met{name,affection,stage,progress} look appearance{packId,options[]} model{loaded,error,options[],current,applied,chosen} systemRole`。后台的角色列表**直接复用这份 view**，不另外拼数据。语音包信息从 `settings.ttsStatus.packs` 里按 `character` 取。

### 3.2 列表展示的字段

| 列 | 取值 | 备注 |
| --- | --- | --- |
| 预览 | `look`：sprites 包取第一帧（按 `frame` 裁剪 `look.url`），pictures / rig / vrm 用预览图，live2d 用 `savePackPreview` 存下的 `preview.png`，大肥鱼的视频片段取 idle 视频的首帧 | 图片都走 `pack://` 协议（特权 scheme，同一个 session 的所有窗口都能用），不复制文件 |
| 名称 | `「名字」nameZh（vendor）` + `title`；没见过的角色只显示 `nameZh` | 和现在 `charName()` 的口径一致 |
| 类型 | 当前外观包的 `kind`（像素 / 图片 / 全动态 / Live2D / VRM / 视频），18+ 包加一个徽标 | 来自 `appearance.options` 里 `packId` 对应的那一项 |
| 来源 | `source`：内置 / 导入；VRM 再加上授权摘要 | |
| 语音包 | `ttsStatus.packs` 里 `character === id` 的那项：名称、引擎、句数、内置还是自定义；没有就显示「--」 | |
| 模型 | `model.current`（label），如果 `applied ≠ current` 就标「待应用」 | |
| 关系 | 没见过显示「未见过」；见过显示「阶段 · 好感 n」，再加一个进度条 | `met.progress` |
| 当前 | `current === true` 时显示「当前角色」标记，并且不能对她点「切换」 | |

### 3.3 可执行的操作

| 操作 | 现有能力 | 位置 |
| --- | --- | --- |
| 切换为当前角色 | `switch-character {id}`（见过的） | 列表行内主操作 |
| 初次见面（起名 + 新建 agent） | `switch-character {id,name}` | 行内，弹出 Modal 起名 |
| 查看详情 | 现有「她的页」：模型、个性化设定、外观、好感度 | 点行打开详情页（P-03 详情页） |
| 切换角色（每种形象都是一位独立角色，T-2764；原「选择外观包」已删除） | `switch-character {id}` | 角色图鉴 / 详情 → 切换 |
| 导入角色包 / Live2D / VRM | `import-pack`、`import-live2d {species}`、`import-vrm {species}`（默认通用设定，`species: "generic"`）、`set-pack-base {id, base}`（导入确认里改成「通用」或某位角色的新形象） | 详情 → 外观，以及「外观资源」页 |
| 删除导入的包 | `remove-pack {id}`（内置包不能删） | 外观资源页，带确认 |
| 导出包 | `export-pack {id}`（不能再分发的 VRM 会被拒绝） | 外观资源页 |
| 调 Live2D 高度 | `set-live2d-height {id,height}` | 详情 → 外观（Live2D 包） |
| 选模型、刷新目录 | `set-model {key,species}`、`refresh-models` | 详情 → 模型 |
| 个性化设定 | `set-system-role {text,species}` | 详情 → 个性化设定 |
| 一键解锁 | `unlock-all {species}` | 详情 → 好感度（只对见过的角色） |
| 语音包：打开文件夹、重新读取 | `open-voicepacks-folder`、`voicepacks-reload` | 详情 → 语音，以及「语音包」页 |
| 删除角色 / 新增角色 | **不支持**（角色定义是内置的 JSON） | 不提供 |

## 4. lobe-design 初始化与技术选型

### 4.1 skill 读到了什么（lobe-design-skill @ `04604bf`，skill 版本 5.9.0）

- 入口是 `skills/lobe-design/SKILL.md`：先用 `route.mjs` 路由，再按 stage 逐个进入（00 brief → 05 init → 10 … → 80 review）。进入一个 stage 时只加载它白名单里的 reference。
- **05-init 的产物**（`stages/05-init.md`、`references/init.md` I-01..I-10）：
  1. `AGENTS.md` 托管块：放在 `<!-- lobe-design:begin … -->` 和 `<!-- lobe-design:end -->` 之间，用 `scripts/bootstrap.mjs` 写入，块外的内容一个字都不改。默认写精简块，语言跟随宿主（本仓库的 `AGENTS.md` 是英文，所以 `lang=en`）。
  2. Round 1 `.agents/ux/product.md`：平台、产品类型、用户、核心任务、适用性表、`copy-profile:` 行，文件头带 init meta（`<!-- lobe-design-init: version=5.9.0 fingerprint=… -->`）。
  3. Round 2 `.agents/ux/components.md`：web / desktop 项目把组件分成三类：薄包装、与 lobe-ui 重复的、业务组件。
  4. 可选：`.agents/ux/lobe-design-rules.md`，放项目自己的规则。
- 在本仓库里跑脚本的实测结果（只读，没有写盘）：
  - `project-scan.mjs --root <pet>` → `平台：desktop` · `框架：electron` · `UI 库：未发现` · `TypeScript：否` · 缺 `.agents/ux/product.md` 和 `components.md` · fingerprint `c97e068df18d`。
  - `route.mjs "为桌宠初始化 lobe-design，然后从零新建一个配置后台…"` → 场景 `bootstrap`（宏观）：`00-brief → 05-init → @selfcheck`。初始化完成后再跑一次，后台本身会路由到 `operate-build`：`00(archetype) → 40 → 30 → 50 → 70 → 75 → 80`。
  - `lint-lobe.mjs src/renderer` → **170 FAIL / 84 WARN**，基本都是像素风格本身（`font-family: "Courier New"`、裸色值 `#2b2233`、3px 描边、非 4 倍数的间距），还有 vendor 目录里的 `pixi.min.js`。
- 硬约束：**C-01（web / desktop）原子组件必须从 `@lobehub/ui` 取**，`LOBE-ANTD-IMPORT`、`LOBE-FORM-ENTRY`、`LOBE-CREATE-STYLES`、`LOBE-FONT-FAMILY`、`LOBE-RAW-COLOR` 都是 FAIL 级别。D-01 的唯一数据源是 `cssVar`，D-08 规定暗色模式由 `data-theme` 驱动、写样式时不分支。P-05 是「配置 / 设置」这类页面的原型：按影响范围分组；开关只用在即时生效的二值项上；需要保存的项用表单加保存按钮；高风险项单独一区。

### 4.2 在本项目里怎么初始化（后续任务 T1 执行）

1. 把 skill 装进仓库，做法和 acceptance skill 一样：`./install.sh --dir <pet>/.agents/skills --copy`，得到 `.agents/skills/lobe-design/`，并把它链接到 `.claude/skills/lobe-design`。这样版本跟着仓库走，CI 和其他 agent 都能读到。
2. `node .agents/skills/lobe-design/scripts/bootstrap.mjs --print --root .` 打印将要写入的内容，人看过之后去掉 `--print` 写入，写进 `AGENTS.md` 末尾。`CLAUDE.md` 目前是 `AGENTS.md` 的副本，不会被脚本改动，所以要手工同步，或者改成一行「见 AGENTS.md」。最后用 `--check` 确认结果幂等。
3. Round 1 写 `.agents/ux/product.md`，要点如下：
   - `平台：desktop`（Electron；后台的渲染进程按 web 规则检查）
   - 产品类型：面向个人的桌面陪伴应用；后台是它的「设置与管理」窗口，不是多人使用的 SaaS 后台
   - 用户：单个主人，本机使用，中文为主；使用频率低（偶尔调一次），但开销很高（API Key、成人向内容、本机能力）
   - 核心任务：切换 / 结识角色 · 给角色选模型、外观和个性化设定 · 配置朗读和语音输入引擎（Key 和端点） · 调整桌宠行为 · 管理角色包和语音包 · 开关对外接口 · 检查更新
   - `copy-profile: consumer`，人称用「你」（沿用现在的界面文案口径）
   - 适用性：P-05 配置页**重点关注**；P-02 列表、P-03 详情用在角色列表；P-01 总览只做轻量版；P-06 到 P-09 **不适用**
   - `lint-allow: LOBE-FONT-FAMILY LOBE-RAW-COLOR LOBE-SPACING-OFFGRID LOBE-LETTER-SPACING LOBE-MOTION-DURATION LOBE-BOUNCE LOBE-GLOW LOBE-EMOJI-ICON LOBE-NULLISH-RENDER src/renderer/**`。理由：桌宠窗口的像素描边、等宽字体和动效就是角色本身的美术，不属于产品界面的视觉体系，所以写明豁免；按 I-10 的要求，项目层违背通用规则时必须写理由
   - `lint-allow: LOBE-SPACING-OFFGRID LOBE-NULLISH-RENDER src/renderer/vendor/**`（第三方压缩代码）
4. Round 2 写 `.agents/ux/components.md`：后台项目里的业务组件（CharacterRow、CharacterPreview、EngineCard、KeyField、DangerZone…）写清楚「什么场景用哪个、要注意什么」；原子组件一律用 `@lobehub/ui`，不在项目里重新实现。
5. `project-scan.mjs --check` 和 `bootstrap.mjs --check` 都通过，初始化才算完成。之后每个 UI 任务都先读 `.agents/ux/` 再进 stage，后台代码改完后跑 `lint-lobe.mjs admin/`，FAIL 必须清零。

### 4.3 选型：原生 JS + CSS 令牌，还是 Vite + React + `@lobehub/ui`

| 维度 | A. 保持原生 JS，只引 CSS 令牌 | **B. 后台引入 Vite + React 19 + `@lobehub/ui`（推荐）** |
| --- | --- | --- |
| 是否符合 lobe-design | `@lobehub/ui` 提供静态的 `es/theme.css`（约 109 KB，`:root, [data-theme='light']` 和 `[data-theme='dark']` 两套 `--lobe-*` 变量，比如 `--lobe-border-radius: 8px`、`--lobe-border-radius-lg: 12px`、`--lobe-control-height: 36px`、`--lobe-color-bg-layout: #f8f8f8 / #000000`、`--lobe-color-bg-container: #ffffff / #0d0d0d`、`--lobe-color-primary: #222222 / #eeeeee`）。颜色和尺寸能对齐，但每个原子组件（Select、Switch、Modal、Form、Table）都得手写，正好踩中 C-01 / C-11 的 `LOBE-REIMPLEMENT-ATOM`，组件交互（键盘操作、焦点、弹层层级）也很难做到和 LobeHub 一致 | 直接用 `ConsoleShell` / `ConsoleNav` / `PageHeader` / `Surface`（`@lobehub/ui/dashboard`）、`Form`（`@lobehub/ui/form`）、`Select` `Switch` `InputPassword` `Slider` `Modal` `toast`，样式写法用 `createStaticStyles` + `cssVar`。和 LobeHub 设置页用的是**同一套组件**（LobeHub 的 `features/Settings` 就是 `Form itemsType="group" variant="filled"`），lint 可以正常管住 |
| 暗色 / 亮色 | 要自己切 `data-theme` 并维护变量 | `ThemeProvider` 加 `appearance="auto"`，配合 Electron `nativeTheme` 跟随系统，写样式时不用分支（D-08） |
| 构建链 | 不需要 | 需要：`admin/`（源码，用 TS）→ `vite build` → `src/admin-ui/`（产物，`.gitignore`）。在 `package.json` 里加 `build:admin`，并让 `prestart`、`predist:mac`、`predist:win`、`predist:linux` 自动调用（npm 会自动执行 pre 钩子）。`release.yml` 里各平台本来就是 `npm ci && npm run dist:*`，**工作流不用改**。`test.yml` 加一步 `npm run build:admin`，保证能编译通过 |
| 打包（`build.files: src/**`） | 不受影响 | 产物在 `src/admin-ui/`，自然被 `src/**/*` 包含，`build.files` **不用改**。React、`@lobehub/ui` 等都放 **devDependencies**，打包进 bundle 后安装包里不会多出 `node_modules`（现在运行时依赖只有 `electron-updater`）。Vite 设 `base: './'`，主进程用 `loadFile('src/admin-ui/index.html')` 加载 |
| 体积 | 几乎为零 | 估计会增加几 MB 的 JS 和 CSS（React、`@lobehub/ui`、`lucide-react`）。相对 Electron 本身可以接受，实现时实测 |
| 离线 / CSP | 不受影响 | 后台的 HTML 用自己的 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`（css-in-js 需要 inline）`; img-src 'self' data: blob: pack:; media-src 'self' blob: pack:; font-src 'self' data:`。`@lobehub/ui` 的 `FontLoader` / `genCdnUrl` 会去 unpkg 或 npmmirror 拉 Geist 字体和 emoji，在 CSP 下这些请求会被拦掉，并退回 `--lobe-font-family` 里的系统字体栈（PingFang SC、Microsoft YaHei…）。实现时**不渲染 `FontLoader`**，也不要用 `FluentEmoji` 的 CDN 模式，e2e 里断言没有外网请求 |
| 测试 | 和现在一样 | Playwright `_electron` 可以拿到多个窗口（`electronApp.windows()`），e2e 新增 `admin` 场景；单元测试照样用 `node --test` 测主进程的 IPC 和广播 |
| 对桌宠窗口的影响 | — | **不碰**。桌宠窗口还是原生 JS 和像素风格；`#panel` 里的「高级设置」「角色列表」在后台上线后改成一个按钮「在设置窗口中打开」（T7），衣柜、话题、聊天记录留在桌宠里 |

**推荐 B**，理由如下：

1. lobe-design 的硬性规则（C-01）要求原子组件来自 `@lobehub/ui`，只有 B 能在 lint 层面持续满足，A 会长期挂着 `REIMPLEMENT-ATOM`。
2. 目标是「与 LobeHub 相通的风格」。B 用的就是 LobeHub 设置页同一套 `Form` / `dashboard` 组件，A 只能做到配色相近。
3. 构建成本很低：npm 的 pre 钩子正好接上现有的 `dist:*` 和 release 工作流，`build.files` 不用改。
4. 隔离性好：后台是独立窗口、独立 bundle，出问题也不影响桌宠主窗口。

**B 的附加约束**：

- `@lobehub/ui@^6.10`（peer 依赖：`react` / `react-dom` ^19、`motion` ^13 或 ^14、`@lobehub/icons` ^6、`@lobehub/fluent-emoji` ^5；`@splinetool/runtime` 不用就不要引入）。图标用 `lucide-react` 配合 `Icon`。
- 不引入 `antd` / `antd-style`（`LOBE-ANTD-IMPORT`）。表单从 `@lobehub/ui/form` 引入。
- 后台的渲染进程只通过 `window.petAdmin` 和主进程通信，不能用 Node。

**令牌在桌宠窗口里的用法（可选，T8）**：桌宠窗口里非角色美术的部分（气泡、⋯ 菜单、toast）如果要和 LobeHub 风格保持一致，可以在构建时把 `@lobehub/ui/theme.css` 复制到 `src/renderer/vendor/lobe-theme.css`，让原生 CSS 引用 `var(--lobe-*)`。这一项要先由主人确认：像素描边是这个应用的辨识度所在，换掉会改变产品气质。

## 5. 挂载方式

### 5.1 窗口

主进程新增 `openAdmin(section?)`，放在 `src/main/admin-window.js`，由 `main.js` 调用：

```js
// 单例：已打开就 show + focus，再跳到 section
adminWin = new BrowserWindow({
  width: 1080, height: 720, minWidth: 860, minHeight: 560,
  title: 'Pixel Pet 设置', show: false,
  frame: true,                    // 普通窗口：有标题栏，可以缩放，会出现在任务栏
  titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f8f8f8', // 与 --lobe-color-bg-layout 一致，避免启动时闪白
  alwaysOnTop: false, transparent: false,
  webPreferences: { preload: path.join(__dirname, 'admin-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
});
adminWin.loadFile(path.join(__dirname, '../admin-ui/index.html'), { hash: section ? `/${section}` : '' });
adminWin.once('ready-to-show', () => adminWin.show());
adminWin.on('closed', () => { adminWin = null; });
```

- 关闭后台窗口不会退出应用（`window-all-closed` 只在所有窗口都关闭时退出，桌宠窗口始终在）。
- 后台窗口**不放进** `pets` 这个 Map，不参与碰撞和 `peers`。
- 路由用 hash（`#/characters/claude`），这样 `openAdmin('characters/claude')` 可以直接打开某个角色的详情页。

### 5.2 preload：`src/main/admin-preload.js` 暴露 `window.petAdmin`

只暴露白名单 API（不暴露 chat、move、debug），通道名沿用现有的 `ipcMain.handle`，不新造：

- 读取：`boot()` → `{ settings: getSettings(), view: service.view(), species, update: updater.state, apiStatus, version }`（新增 `admin-boot`）；`whoami`、`spaces`（只读）、`apiStatus`。
- 写入（复用现有通道）：`set-prefs`、`set-pet-scale`、`set-tts`、`tts-clear-cache`、`voicepacks-reload`、`open-voicepacks-folder`、`set-asr`、`asr-test`、`asr-mic-access`、`set-visitors`、`set-api`、`set-adult`、`confirm-age`、`set-local`、`switch-character`、`set-model`、`refresh-models`、`set-system-role`、`unlock-all`、`import-pack`、`import-live2d`、`import-vrm`、`remove-pack`、`export-pack`、`set-live2d-height`、`save-pack-preview`、`open-packs-folder`、`update-check`、`update-install`、`open-log`、`new-topic`、`release`、`open-link`。
- 订阅：`onSettings`、`onUpdate`（view）、`onUpdateStatus`、`onApiStatus`。
- Key 仍然只能写入：`set-tts {key}` 和 `set-asr {key}` 不返回明文，界面只显示 `ttsStatus.engines[id].hasKey` 或 `asrStatus.local.hasKey`。
- 主进程校验发送方：后台独有的通道（`admin-boot`）只接受 `adminWin.webContents` 发来的请求；现有通道两个窗口都能调。

### 5.3 入口

| 入口 | 做法 | 优先级 |
| --- | --- | --- |
| ⋯ 菜单 / 右键菜单 | `#main-menu` 里新增「设置…」（位置放在第一组），调用 `window.pet.openAdmin()`（新 IPC `open-admin`）。「高级设置」「角色列表」两项保留到 T7 再改成跳转后台（`open-admin {section:'behavior'|'characters'}`） | P0 |
| 快捷键 | 桌宠窗口获得焦点时按 `CmdOrCtrl+,`（在桌宠窗口的 `webContents` 上监听 `before-input-event`，不注册全局快捷键，避免和其他应用冲突） | P0 |
| macOS 应用菜单 | `Menu.setApplicationMenu`：「Pixel Pet → 偏好设置… ⌘,」「退出」。现在 macOS 没有应用菜单，加上后 ⌘Q 和 ⌘, 都能用 | P1 |
| 托盘 | 新增 `Tray`（复用 `build/icon.png` 生成 16 / 32px 模板图），菜单：打开设置 / 显示桌宠（`place('pet')`）/ 检查更新 / 退出。解决桌宠被盖住或拖出屏幕后找不到设置的问题（§2.8-4） | P1 |
| 首次唤醒完成后 | 不自动打开后台，只在气泡里提示一次「⋯ → 设置… 可以打开设置窗口」 | P2 |

### 5.4 实时同步（设置变更广播）

原则：**主进程的 `PetService` 是唯一的数据源**。两个窗口都只调 IPC，不各自缓存可写状态，收到广播后整份替换。

1. 新增 `broadcast(channel, payload)`：发给 `pets` 里所有桌宠窗口，再加上 `adminWin`（如果存在）。
2. `service.on('settings')` 从 `sendAll` 改成 `broadcast`，后台因此也能收到。现在所有 `set-prefs / set-tts / set-asr / set-visitors / set-api / set-pet-scale / set-adult / confirm-age` 都已经 `emit('settings')`。
3. `service.on('update', v => send('update', v))` 改成 `broadcast('update', v)`。
4. **补缺口**：`set-model`、`set-system-role`、`unlock-all`、`switch-character` 在 handler 里拿到 `r.view` 之后执行 `service.emit('update', r.view)`（或者在 `PetService` 里由 setter 自己 emit；后一种更好，单测也能覆盖）。`import-*`、`remove-pack`、`set-live2d-height`、`save-pack-preview` 已经通过 `service.setPacks()` emit 了 `update`（`main.js` 289–303 行），只需要随第 3 步改成广播。
5. 桌宠窗口现有的 `onUpdate` 和 `onSettings` 已经会重绘（`applyArt`、`refreshHud`、`setSettings`），**不用改**。后台窗口订阅同样两个事件，用 store 整份替换。
6. 冲突处理：只有一个主进程，setter 是同步的，所以后写的覆盖先写的。后台表单的「未保存修改」只保存在后台本地；收到广播时，如果用户正在编辑的字段被外部改了，就提示「已在别处修改，已刷新」，不静默覆盖用户正在输入的内容（P-05 要求的「未保存修改可见」）。
7. 测试：单测里用两个假的 webContents，断言 `set-model` 之后两个窗口都收到了 `update`；e2e 在后台切换外观后，断言桌宠窗口的 `#pet-look` 换成了新的包（`data-look`）。

## 6. 界面信息架构（参照 LobeHub）

### 6.1 LobeHub 设置页的做法（`lobehub/src/features/Settings`，源码实读）

- 布局：`Layout` = 左侧 `SideBar`（`NavPanelPortal` → `SideBarLayout`，由 header 面包屑和 body 组成）+ 右侧 `Flexbox` 主区，主区背景是 `cssVar.colorBgContainer`。
- 左侧导航：`Accordion`（`indicatorPlacement="inline"`，默认全部展开）分组。组标题是 `Text fontSize={12} type="secondary" weight={500}`，组内每项是 `NavItem`（lucide 图标加标题，`active` 高亮），整体包在 `SearchSection` 里，支持设置搜索。分组 key 是 Account / General / Subscription / Agent / System / Developer。
- 每页顶部：`SettingHeader`，标题 `Text strong fontSize={24}`，可选 description（secondary），右侧放 extra，下面一条 `Divider`。
- 每页内容：若干 `Form`，`itemsType="group"`、`variant="filled"`、`collapsible={false}`，配合 `FORM_STYLE = { itemMinWidth: 'max(34%, 240px)', style: { maxWidth: 1024, width: '100%' } }`。每个分组是一张卡片：标题，加上若干行「标签 + 说明 / 控件」，标签在左、控件在右。即时生效的开关直接用 `Switch` 的 `loading` 状态。
- 视觉令牌：`--lobe-border-radius` 8 / `-lg` 12，`--lobe-control-height` 36，字体栈是 `--lobe-font-family`（Geist → 系统字体 → 中文字体），主色是近黑色的中性色（亮色 `#222222`，暗色 `#eeeeee`），布局底色亮色 `#f8f8f8`、暗色 `#000000`，卡片底色亮色 `#ffffff`、暗色 `#0d0d0d`。明暗通过 `data-theme` 切换。

### 6.2 后台的骨架

- 外壳用 `ConsoleShell`（品牌：桌宠图标 + 「Pixel Pet 设置」；`storageKey` 记住侧栏折叠状态；Mod+B 切换），侧栏用 `ConsoleNav`（分组，挂 lucide 图标），每页用 `PageHeader`（等价于 LobeHub 的 `SettingHeader`）加 `Form`（group / filled，`FORM_STYLE` 和 LobeHub 一样）。列表页（角色、外观资源）用 `Surface` 包 `Table`（数据已经在本地，不需要 `ProTable`，参见 C-08）或 `List`。
- 主题：`ThemeProvider appearance` 默认 `auto`，主进程通过 `nativeTheme` 把系统明暗传给后台。新增一个可选 key `ui.theme`（`'auto' | 'light' | 'dark'`，默认 `'auto'`），在后台「外观」页修改（T3 实现时写进 `normalizeSettings`，同时更新本文 §2 和核对脚本）。
- 窗口宽度小于 860 时侧栏收成图标轨（`ConsoleShell` 自带这个行为）。

### 6.3 页面清单

| 分组（ConsoleNav） | 页面（路由） | 内容（对应 §2、§3） | 原型 |
| --- | --- | --- | --- |
| 概览 | 总览 `#/overview` | 当前角色卡片（预览、名字、关系进度、模型），状态条（朗读 / 语音输入 / 对外接口 / 更新 / 本机能力是否开启，以及最近一次出错），常用入口 | P-01 轻量版 |
| 角色 | 角色列表 `#/characters` | §3.2 的列，行内操作有「切换 / 初次见面」和「详情」 | P-02 |
| 角色 | 角色详情 `#/characters/:id` | `PageTabs`：概况（关系、服饰解锁、署名）· 模型（`models.<id>`）· 个性化设定（`systemRoles.<id>`）· 外观（`appearance.<id>`、导入、Live2D 高度）· 语音（音色只读、语音包）· 好感度（一键解锁） | P-03 + P-04 |
| 角色 | 外观资源 `#/packs` | 所有角色包的表格，列有名称、角色、类型、来源、18+、授权；操作有导入角色包 / Live2D / VRM、导出、删除（只限导入的）、打开文件夹 | P-02 |
| 角色 | 同屏伙伴 `#/visitors` | `visitors`（最多 3 位，不能选当前角色），加 `prefs.collide` | P-05 |
| 偏好 | 桌宠行为 `#/behavior` | `petScale`（`SliderWithInput` 50–250%，恢复默认），`prefs.framing`（大小与取景卡片，全身 / 半身），`prefs.roam / clickSound / memes / touchZones / touchHint` | P-05 |
| 偏好 | 外观 `#/appearance` | 后台主题 `ui.theme`（新），以后放桌宠窗口的令牌开关（T8） | P-05 |
| 语音 | 朗读 `#/tts` | `prefs.voice`（功能总开关，关闭时下面的配置收起），`prefs.voiceInteractions / voiceMurmurs`，`tts.provider / fallback / packs`；每个引擎一张卡片（Fish、MiniMax、本地），包含 Key（`InputPassword`，只写不显示）、端点、`tts.local.*`；状态（是否设了 Key、最近一次错误、缓存大小），清空缓存，试听 | P-05 |
| 语音 | 语音输入 `#/asr` | `asr.enabled`（总开关），`engine / language / autoSend / fallback`，LobeHub 卡片（`lobehub.model`），本地卡片（`local.endpoint / api / model / timeoutSec`、Key），`maxSeconds`（补上入口），测试连接 | P-05 |
| 语音 | 语音包 `#/voicepacks` | `ttsStatus.packs` 表格（角色、名称、引擎、句数、内置还是自定义、署名），打开文件夹，重新读取（显示读取错误） | P-02 |
| 连接 | LobeHub 与本机 `#/connection` | `whoami`、空间（只读），本机能力（`localAbilities`，高风险项，开启前确认），重新开始话题 | P-05 |
| 连接 | 对外接口 `#/api` | `api.enabled / port / token`（复制、换一个令牌），监听状态，路由说明 | P-05 |
| 系统 | 内容与安全 `#/safety` | 18+ 确认状态（`answered / ageConfirmed / ageConfirmedAt / ageGateVersion`），`adultContent`（打开时走确认流程），内容规则说明（只读） | P-05（高风险区） |
| 系统 | 版本与更新 `#/update` | 当前版本，上次检查时间，状态，检查更新，立即更新，自动更新策略说明 | P-05 |
| 系统 | 数据与关于 `#/about` | 打开日志 / 角色包 / 语音包目录，素材署名，**危险区**（仅重置本地、放生并删除 agent，用 `confirmModal`，写清楚会删除哪些东西） | P-05 + 危险区 |

交互约定（P-05 / C-17）：

- 即时生效的布尔项用 `Switch`。
- 文本、URL、Key 用输入框加「保存」按钮，显示保存中 / 已保存 / 失败三种状态，失败原因复用现有的中文提示（`TTS_REASON`、`ASR_ERR`）。
- 功能总开关关闭时，下面的配置收起，不全部展开。
- 每项都写清楚影响什么，并标出默认值。

## 7. 风险与待确认

| 风险 | 处理 |
| --- | --- |
| `@lobehub/ui` 在 Electron 的 `file://` 和严格 CSP 下的表现（Portal、字体、emoji CDN） | T2 的脚手架阶段先做一个 PoC：`ConsoleShell` + `Form` + `Modal` + `toast` 在 `file://` 下渲染，CSP 控制台零报错，没有外网请求，再开始做页面 |
| 安装包体积变大 | T2 记录产物大小，和 v0.19.0 的 dmg / zip 对比，写进 PR |
| 两个入口并存，造成重复和口径不一致 | T7 上线后，`#panel` 的「高级设置」「角色列表」改成跳转后台，避免两处各自维护 |
| 改变桌宠窗口的视觉 | 本期不改（T8 可选，由主人确认） |
| 新增设置项（`ui.theme`，以后可能还有 proactive 参数） | 每加一个 key 都要同时更新 `normalizeSettings`、本文 §2 和核对脚本，脚本保证文档不会漏 |

## 8. 后续任务拆分

> 每个任务都单独提 PR 到 `canary`。改了用户可见界面的，按 `.agents/acceptance/PROJECT.md` §7 走验收轮。

| # | 任务 | 内容 | 验收要点 | 依赖 |
| --- | --- | --- | --- | --- |
| T1 | lobe-design 初始化 | §4.2 第 1–5 步：仓库内装 skill，写 `AGENTS.md` 托管块，生成 `.agents/ux/product.md`（`平台：desktop`、`copy-profile: consumer`、`lint-allow`）和 `components.md` | `bootstrap.mjs --check` 和 `project-scan.mjs --check` 通过；托管块之外零改动；`lint-lobe.mjs src/renderer` 在 `lint-allow` 生效后 FAIL 为 0 | — |
| T2 | 后台脚手架与构建链 | `admin/`（Vite + React 19 + TS + `@lobehub/ui`），`build:admin` 输出到 `src/admin-ui/`（加进 `.gitignore`），`prestart` 和 `predist:*` 钩子，`test.yml` 加构建步骤，CSP，`ThemeProvider`（跟随系统），`ConsoleShell` 空壳加 15 个路由占位 | `npm run dist:linux` 打出的包里有 `admin-ui/`；`file://` 下零 CSP 报错、零外网请求；记录体积变化 | T1 |
| T3 | 主进程挂载与同步 | `admin-window.js`（单例，`openAdmin(section)`），`admin-preload.js`（白名单），`open-admin` / `admin-boot` IPC，`broadcast()`，按角色的 setter 补发 `emit('update')`，`CmdOrCtrl+,`，⋯ 菜单加「设置…」，`ui.theme` key | 单测：广播同时发到两个窗口，按角色的 setter 也会广播；e2e：从 ⋯ 打开后台，再打开一次仍然只有一个窗口 | T2 |
| T4 | 概览、同屏伙伴、偏好、语音、语音输入、连接、系统页 | §6.3 中除 T5 那 4 页以外的 11 页，覆盖 §2 的全部 key（含补上的 `asr.maxSeconds`、`asr.local.timeoutSec`），Key 只写不显示，高风险项走确认 | 逐项改动后 `settings.json` 和桌宠窗口同时变化（e2e 截图）；`lint-lobe.mjs admin/` FAIL 为 0；亮色和暗色各一组截图 | T3 |
| T5 | 角色列表、角色详情、外观资源、语音包 4 页 | §3 的列和操作；预览渲染（sprite 首帧、pack:// 图片） | e2e：在后台切换角色、换外观、导入 / 删除角色包，桌宠窗口实时变化 | T3 |
| T6 | 托盘与 macOS 应用菜单 | §5.3 的 P1 入口 | 三个平台的打包产物都能从托盘打开设置；macOS 上 ⌘, 和 ⌘Q 可用 | T3 |
| T7 | 桌宠 `#panel` 收敛 | 「高级设置」「角色列表」改成跳转后台（保留衣柜、话题、聊天记录）；更新 `docs/usage.md` 和 e2e 场景 `advanced`、`charpage`、`models`、`packs` | 现有 e2e 场景改写后通过 | T4、T5 |
| T8 | （可选）桌宠窗口使用 LobeHub 令牌 | `lobe-theme.css` 用于气泡、菜单、toast | 主人确认视觉方向后再做 | T2 |
| T9 | （可选）补充功能 | 角色改名，`proactive` 和好感参数开放为高级配置 | 新增 key 同步更新本文和核对脚本 | T4 |
| T10 | lobe-design 走查 | 对后台跑 `80-review`（pre-launch），处理回流 | 评审无阻断项 | T4–T7 |

## 9. 核对方法（文档覆盖 settings.js 的全部 key）

key 列表直接从代码生成，不手写：`scripts/check-admin-console-doc.js` 把 `normalizeSettings(null)` 展开成点号路径（`prefs.roam`、`tts.local.api`……），默认为空的按角色 map 记作 `appearance.<id>` / `models.<id>` / `systemRoles.<id>`；再从 `src/main/main.js` 抽出设置和角色相关的 IPC 通道。只有在本文里用反引号写到的才算覆盖。

```bash
node scripts/check-admin-console-doc.js   # 0 = 全部覆盖；1 = 打印 MISS 清单
```

在 `7bae23a` 上运行的结果见提交说明和任务验收记录：44 个 key、35 个通道全部为 `ok`，输出 `PASS`。

以后新增设置项时，`normalizeSettings` 的默认值会让脚本自动多出这个 key，文档没跟上就会 FAIL，所以本文和代码不会悄悄脱节。也可以把这个脚本加进 `npm test`（可选）。

## 10. 实施结果（配置后台，T3–T7 + T9 部分）

### 10.1 新增的设置项（`settings.json`，都经过 `normalizeSettings`）

| key | 类型 | 默认值 | 取值范围 | 后台位置 | 生效 |
| --- | --- | --- | --- | --- | --- |
| `proactive.enabled` | boolean | `true` | — | 主动行为与好感度 → 主动行为 | 即时：关闭后心跳照常（饥饿、衰减、睡醒），但不再主动开口 |
| `proactive.speakCooldownMin` | int | `12` | 3–240 | 同上 | 即时（下一次心跳的 `nextEvent`） |
| `proactive.boredAfterMin` | int | `45` | 5–480 | 同上 | 即时 |
| `proactive.hungryAt` | int | `75` | 50–100 | 同上 | 即时 |
| `proactive.maxLlmPerHour` | int | `6` | 0–30（0 = 只用离线台词） | 同上 | 即时（`LlmBudget.max`） |
| `affectionRules.dailyCap` | int | `12`（`DAILY_CAP`） | 4–40 | 主动行为与好感度 → 好感度 | 即时（`affection.setRules`） |
| `affectionRules.decay` | boolean | `true` | — | 同上 | 即时；关闭期间这次缺席的步数记为已扣，重新打开不会一次补扣 |
| `ui.theme` | enum | `'auto'` | `auto` \| `light` \| `dark` | 外观主题 | 即时（只影响设置窗口） |
| `interject.enabled` | boolean | `false` | — | 主动搭话与好感 → 插个嘴 · `admin-set` / `set-interject` | 即时；关闭时清掉待判断的输入、中止进行中的判断（`Interjector#cancel`），之后零次决策调用。详见 `docs/interject.md` |
| `interject.sources.chatDraft` | boolean | `true` | — | 同上 → 来源：聊天框草稿 | 即时（桌宠窗口只在开着时才发 `interject-draft`） |
| `interject.sources.voice` | boolean | `true` | — | 同上 → 来源：语音输入 | 即时 |
| `interject.sources.api` | boolean | `true` | — | 同上 → 来源：外部程序（`POST /pixel-pet/observe`） | 即时 |
| `interject.sources.clipboard` | boolean | `false` | 系统级来源，单独开关 | 同上 → 来源：剪贴板 | 即时（主进程开 / 停 3 秒一次的轮询） |
| `interject.cooldownMin` | int | `10` | 1–240 | 同上 | 即时 |
| `interject.maxPerHour` | int | `3` | 0–20 | 同上 | 即时 |
| `interject.maxDecidePerHour` | int | `20` | 0–120 | 同上 | 即时（`LlmBudget.max`） |
| `interject.debounceSec` | int | `4` | 1–60 | 同上 | 下一次输入 |
| `interject.minChars` | int | `6` | 1–200 | 同上 | 即时 |
| `interject.quietStart` / `interject.quietEnd` | int | `23` / `8` | 0–23；相同 = 不设勿扰 | 同上 | 即时 |
| `interject.highThreshold` / `interject.lowThreshold` | number | `0.7` / `0.3` | 0.5–0.99 / 0–0.5；低阈值不小于高阈值时两项都回到默认 | 同上 | 即时 |
| `interject.timeoutSec` | int | `10` | 2–60 | 同上 | 下一次判断 |
| `interject.model` | string | `'lobehub/jev-1.14.0'` | `provider/model`（`DECISION_MODEL_RE`） | 同上 | 下一次判断 |
| `system.hardwareAcceleration` | boolean | `true` | — | 数据与关于 → 系统 | **重启后生效**（`app.disableHardwareAcceleration` 只能在 ready 前调用）；后台显示「重启后生效」标签和「立即重启」横幅（`settingsView().pendingRestart`） |

这几项原来是 §2.5 列出的写死常量；常量本身保留为默认值（`proactive.DEFAULTS`、`affection.DAILY_CAP`）。

### 10.2 主进程

- `src/main/admin-window.js`：`AdminWindow.open(section)` 单例；`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`；再次打开时 show + focus，并把页面 hash 设到目标页（窗口还在加载时等 `did-finish-load` 之后再设，不会丢）。
- `src/main/admin-preload.js`：`window.petAdmin` 白名单（38 个调用，不含 chat / move / debug；第二版加了 `cue`，见 §11）。
- `src/core/settings-schema.js`：全部配置项的页面、分组、控件类型、默认值、范围和校验（`validate`）、对应的 setter（`patchFor`）；`admin-boot` 把它作为纯数据发给后台。单测保证它覆盖 `normalizeSettings(null)` 的每个叶子 key。
- `src/main/admin-settings.js`：`admin-set {key,value}` / `admin-reset {keys}`。先按 schema 校验，再调用原有的 `PetService` setter（`setPrefs` `setTts` `setAsr` `setApi` `setVisitors` `setPetScale`，以及新增的 `setSection`），所以仍然只经过 `core/settings.js` 的 `SettingsStore` 写盘。Key 走 `tts-keys.json`，只回「已设置」。
- `src/core/roster.js`：角色列表行（预览、名称、类型、来源、语音包、模型、关系、当前标记）和外观资源行，由 `view()` 和 `settingsView()` 派生。
- 新 IPC：`open-admin`（桌宠窗口）、`admin-boot`、`admin-state`、`admin-set`、`admin-reset`、`admin-relaunch`、`admin-show-pet`；推送 `admin-state`。后台独有的通道只接受设置窗口的 webContents（测试模式除外）。
- 广播：`src/main/broadcast.js`，`settings` / `api-status` 发给所有桌宠窗口和设置窗口；每次 `update` / `settings` 之后给设置窗口推一份完整的 `admin-state`。导入 / 导出对话框挂在发起请求的窗口上。
- 入口：⋯ 菜单「设置…」（第一项）、桌宠窗口获得焦点时 `CmdOrCtrl+,`、托盘菜单（打开设置… / 显示桌宠 / 检查更新 / 退出）、macOS 应用菜单「偏好设置… ⌘,」。

### 10.3 桌宠窗口 `#panel` 的收敛（T7）

- ⋯ 菜单的「高级设置」去掉，换成「设置…」；整个「高级设置」面板（宠物大小、桌宠行为、语音、语音输入、同屏伙伴、对外接口、版本与更新）从 `app.js` 删除，由设置窗口取代。「检查更新」打开设置窗口的「版本与更新」页；语音输入失败提示里的「去设置」打开设置窗口的「语音输入」页。
- 「角色列表」保留在桌宠里，用来快速切换 / 初次见面；她的页里的「模型」「个性化设定」表单删除，换成当前值摘要和「在设置窗口中编辑 ›」（打开 `#/characters/<id>`）。外观和好感度仍保留：Live2D / VRM 导入后要由桌宠窗口画出预览图（`save-pack-preview`），而好感度属于玩法。
- 衣柜、话题、聊天记录不变。

## 11. 第二版：从「后台」到「她的小屋」（2026-11-02 负责人反馈）

负责人看过第一版后提了两点：

1. **不要把所有菜单项都放进左侧边栏，要有纵深。** 比如「角色」：先是角色列表，点进去才是角色详情，换角色包也在详情里做。
2. **整体太像后台了。** 桌宠是偏感性的场景，需要更 fancy、偏游戏化的设计，能把角色和她的互动效果展示出来。

### 11.1 信息架构：六个入口，其余都在下一层

| 入口（rail） | 第一层 | 第二层 |
| --- | --- | --- |
| 小屋 `#/overview` | 她的舞台 + 关系 + 今天的陪伴 + 其他伙伴 | — |
| 角色 `#/characters` | 角色图鉴（卡片墙，没遇见的是剪影） | 角色详情 `#/characters/:id`：大舞台 + 简介 + 好感；标签页 装扮（默认：衣柜卡片试穿 / 穿上、取景、导入新角色）· 好感（关系路线图）· 模型 · 个性化设定 · 语音 · 资料 |
| 商店 `#/store` | 按类别分标签页，现在只有「角色」：可下载角色的卡片（图片、未下载 / 已下载、大小、下载进度 / 取消、已下载的「查看」），筛选 全部 / 未下载 / 已下载。以后的声音包等加成新的标签页 | — |
| 玩法 `#/play` | 她此刻的状态（心情 / 饱腹 / 精力）+ 入口卡片 | 桌宠行为 · 主动搭话与好感 · 同屏伙伴 |
| 设置 `#/settings` | 入口卡片，按 声音 / 资源与外观 / 连接 / 系统 分组，每张卡写当前状态 | 朗读 · 语音输入 · 语音包 · 角色包 · 外观主题 · LobeHub 与本机 · 对外接口 · 内容与安全 · 版本与更新 · 数据与关于 |

- 数据：`core/settings-schema.js` 新增 `RAIL`（六个入口：小屋 / 角色 / 商店 / 玩法 / 设置 / 聊天；「商店」「聊天」是 R-05 的两个例外），`NAV` 的每组多一个 `section` 指向所属入口；页面路由不变（`#/tts` 等照旧），所以桌宠窗口跳到某页（`open-admin`）不用改。
- 第二层页面左上角有返回路径（`设置 / 朗读`），rail 上所属入口保持高亮。
- 侧栏从 `ConsoleShell` + `ConsoleNav` 换成 80px 的图标 rail（`admin/src/console/Shell.tsx`，原子仍是 `@lobehub/ui` 的 `Icon` / `ActionIcon` / `Button`）；rail 顶部是当前角色的小头像，底部是「把桌宠叫到前面」和明暗切换。

### 11.2 视觉：LobeHub 的底，她的颜色和她的动作

- **她的颜色是房间的光。** 当前角色的 `accent` 作为 `--pet-accent` 染在窗口顶部、舞台和卡片上（`color-mix` 与 `cssVar` 混合，亮 / 暗都由 lobe 令牌托底）；其余仍是 LobeHub 的中性灰阶、圆角和阴影档位。
- **角色会动。** `stage/SpriteStage.tsx` 按角色包的 `actions`（row / col / frames / fps）在 canvas 上逐帧播放，和桌宠窗口一致；离开视口或系统要求减少动效时停在第一帧。为此 `core/roster.js` 的预览带上 `actions`，`core/packs.js` 的 `packsFor` 给每个角色包加 `cover`（卡片的图）。
- **一个签名动作（A-06）：点她。** `stage/CharacterStage.tsx`：点舞台上的她 → 爱心飘起、她说一句（口头禅或喜欢的东西）、播「摸头 / 开心」；如果她就是桌面上的那位，桌宠窗口同时播「开心」（新 IPC `admin-cue`，白名单同对外接口的 `/anim`）。动作按钮可以预览她的每个动作。
- **游戏化的关系。** `stage/HeartMeter.tsx`：爱心沿着染了她颜色的进度条走，关系阶段是路上的节点（`toAffectionProgress` 新增 `stages`），未到的阶段上锁；详情页的「好感」是一条关系路线图。
- **图鉴与衣柜。** 角色图鉴的卡片是会动的立绘，没遇见的显示为剪影 +「未遇见」；她的衣柜是一排服饰卡片（T-2784），点图片在舞台上试穿，满意再穿上。

lobe-design 的取舍记在 `.agents/ux/product.md`（产品类型改为陪伴向、`admin/src/console/stage/**` 的动效时长放行）和 `.agents/ux/lobe-design-rules.md` R-05。

验证：`xvfb-run -a node e2e/run.js admin`（新增 A3b 层级导航、A3c 点她与桌宠联动、A13 试穿再穿上），截图在 `out/e2e/admin/`。

## 12. 覆盖矩阵（自动生成）

目的：确认「配置后台」是完整的——用户能配置的每一项、桌宠运行时的每一种行为控制、桌宠窗口和菜单里能改的每一样东西，在设置窗口里都有地方管，并且写明即时生效还是需要重启。

**怎么核对（不手写清单）**：`src/core/admin-coverage.js` 的 `collect()` 从代码里读出四份清单，`audit()` 逐项对照，`renderMatrix()` 生成下面的表。

1. `settings.json` 的叶子键：`normalizeSettings(null)` 展开（`settingsLeaves()`），每个键必须在 `settings-schema.js` 的 F 列表里有字段；内部标记（`petScaleSet`、`tts.providerSet`、年龄确认的 4 个只读事实）必须同时被 schema 标为 `internal` 并在 `INTERNAL_SETTINGS` 写明原因；`token` / `adult` / `perCharacter` 这类不走通用表单的键必须在 `SPECIAL_SETTINGS` 写明由哪个控件修改；每个可写键要么即时生效、要么在 `RESTART_KEYS` 里（重启生效）。
2. 桌宠窗口的通道：`src/main/preload.js` 里每个 `invoke` / `send` 的通道，要么设置窗口（`src/main/admin-preload.js`）有同一通道，要么在 `VIA` 写明设置窗口用哪个通道做同一件事，要么在 `PET_ONLY` 写明它不是配置（聊天、拖动、首次唤醒、测试钩子……）。
3. 菜单：桌宠窗口 ⋯ 菜单（`index.html` 的 `data-menu`）、托盘菜单和应用菜单（`main.js` 的模板）的每一项，在 `MENU` 写明后台的位置，或者为什么不需要。
4. 运行时行为控制（`RUNTIME`）：走动、大小、触摸、主动搭话、好感、同屏伙伴、朗读、语音包、语音输入、对外接口、更新、安全、角色、角色包、数据目录、窗口主题，每项列出控制它的 schema 键和 `window.petAdmin` 通道，键和通道都必须真实存在。
5. 另外，`window.petAdmin` 的每个方法都必须被某个页面调用（`admin/src` 里的 `api().x`），否则就是「桥接了但没有控件」。不需要调用的写在 `UNUSED_OK`。

任何一项对不上，`node scripts/check-admin-console-doc.js` 打印 `MISS …` 并以 1 退出；下面这一节和 `audit()` 的结果不一致（代码改了、文档没重新生成）也会 FAIL。`test/admin-coverage.test.js` 跑同一个审计，并用「删掉一个字段 / 多一个通道 / 多一个菜单项」验证它真能抓到缺口，所以 `npm test` 就守着这张表。更新本节：`node scripts/check-admin-console-doc.js --write`。

**本次审计发现并补齐的缺口**（canary `5e815e3` 上跑新审计会报出的项）：

| 缺口 | 之前只能在 | 现在在后台 | 生效 |
| --- | --- | --- | --- |
| 服饰（衣柜，`equip-outfit`） | 桌宠窗口 → 衣柜 | 角色详情 → 服饰（当前角色；未解锁的显示解锁条件） | 即时，桌宠窗口立即换装 |
| Live2D 模型大小（`set-live2d-height`，桥接了但没有控件） | 桌宠窗口 → 外观 | 角色详情 → 装扮 → Live2D 模型大小（导入的 Live2D 角色） | 即时，桌宠窗口重绘 |
| 回到右下角（`place`） | ⋯ → 回到右下角、托盘 → 显示桌宠 | 桌宠行为 → 位置 → 找回桌宠（`admin-place-pet`） | 即时 |
| 自动检查更新 | 只有环境变量 `PIXELPET_NO_UPDATE=1` | 版本与更新 → 自动检查更新（新键 `update.autoCheck`，默认开） | 即时：下一次定时检查就按新值 |
| 数据目录位置 | 看不到路径 | 数据与关于 → 数据目录：显示路径、打开数据目录（`open-data-folder`） | — |
| 角色的设定（角色文件里的 persona） | 看不到 | 角色详情 → 设定 → 她的设定（只读）+ 个性化设定 | — |
| 按形象类型看角色 | — | 角色图鉴 → 按形象类型（像素 / 图片 / 全动态 / Live2D / VRM / 有导入包），卡片和详情 → 资料列出每类内置 / 导入包数 | — |

<!-- coverage-matrix:start (generated by `node scripts/check-admin-console-doc.js --write`; do not edit by hand) -->

### 12.1 settings.json：79 个叶子键

| 键 | 页面 | 名称 | 生效 | 说明 |
| --- | --- | --- | --- | --- |
| `ageGateVersion` | safety（内部） | 确认文案版本 | — | 确认文案版本（文案改了就重新询问，只读） |
| `ageConfirmed` | safety（内部） | 已确认满 18 周岁 | — | 是否确认满 18 周岁（同上，只读） |
| `ageConfirmedAt` | safety（内部） | 确认时间 | — | 确认时间（同上，只读） |
| `adultContent` | safety | 成人向内容 | 即时生效 | 内容与安全 → 成人向内容（打开必须先过 18+ 确认：`confirm-age` / `set-adult`） |
| `answered` | safety（内部） | 已回答年龄确认 | — | 年龄确认的答案（由 18+ 确认对话写入，内容与安全页只读显示） |
| `petScale` | behavior | 宠物大小 | 即时生效 |  |
| `models.<id>` | character | 模型 | 即时生效 | 角色详情 → 模型（`set-model` / `refresh-models`） |
| `systemRoles.<id>` | character | 个性化设定 | 即时生效 | 角色详情 → 设定 → 个性化设定（`set-system-role`） |
| `framings.<id>` | character | 取景 | 即时生效 | 角色详情 → 外观 → 取景（跟随全局 / 全身 / 半身：`set-framing`） |
| `prefs.roam` | behavior | 自己走动 | 即时生效 |  |
| `prefs.clickSound` | behavior | 点击音效 | 即时生效 |  |
| `prefs.muted` | tts | 静音 | 即时生效 |  |
| `prefs.voice` | tts | 朗读回复 | 即时生效 |  |
| `prefs.voiceInteractions` | tts | 互动语音 | 即时生效 |  |
| `prefs.voiceMurmurs` | tts | 朗读碎碎念 | 即时生效 |  |
| `prefs.memes` | behavior | 梗图 | 即时生效 |  |
| `prefs.collide` | behavior | 互相碰撞 | 即时生效 |  |
| `prefs.touchZones` | behavior | 部位触摸 | 即时生效 |  |
| `prefs.touchHint` | behavior | 触摸提示 | 即时生效 |  |
| `prefs.framing` | behavior | 取景 | 即时生效 |  |
| `prefs.danceVolume` | dances | 音乐音量 | 即时生效 |  |
| `vrmPostures.<id>` | character | VRM 姿势 | 即时生效 | 角色详情 → 外观 → VRM 姿势（VRM 角色；按角色记住，自动 / 6 种姿势：`set-vrm-posture`） |
| `visitors` | visitors | 一起待在桌面上的角色 | 即时生效 |  |
| `api.enabled` | api | 开启对外接口 | 即时生效 |  |
| `api.port` | api | 端口 | 即时生效 |  |
| `api.token` | api | 令牌 | 即时生效 | 对外接口 → 令牌（遮罩显示、复制、「换一个」：`set-api` newToken） |
| `tts.provider` | tts | 朗读引擎 | 即时生效 |  |
| `tts.providerSet` | tts（内部） | 手动选过引擎 | — | 内部标记：选过朗读引擎后不再迁移成「自动」（由 `tts.provider` 的修改写入） |
| `tts.fallback` | tts | 引擎用不了时 | 即时生效 |  |
| `tts.packs` | tts | 使用语音包 | 即时生效 |  |
| `tts.endpoints.fish` | tts | 端点 | 即时生效 |  |
| `tts.endpoints.minimax` | tts | 端点 | 即时生效 |  |
| `tts.endpoints.elevenlabs` | tts | 端点 | 即时生效 |  |
| `tts.endpoints.local` | tts | 地址 | 即时生效 |  |
| `tts.local.api` | tts | 接口 | 即时生效 |  |
| `tts.local.model` | tts | 模型 | 即时生效 |  |
| `tts.local.voice` | tts | 音色名 | 即时生效 |  |
| `tts.elevenlabs.voiceId` | tts | 默认音色 ID | 即时生效 |  |
| `tts.elevenlabs.modelId` | tts | 模型 | 即时生效 |  |
| `asr.enabled` | asr | 开启语音输入 | 即时生效 |  |
| `asr.engine` | asr | 识别引擎 | 即时生效 |  |
| `asr.fallback` | asr | 用不了时换另一个引擎 | 即时生效 |  |
| `asr.language` | asr | 语言 | 即时生效 |  |
| `asr.maxSeconds` | asr | 单次最长录音 | 即时生效 |  |
| `asr.autoSend` | asr | 识别后直接发送 | 即时生效 |  |
| `asr.hotkey` | asr | 唤起语音对话 | 即时生效 |  |
| `asr.lobehub.model` | asr | 模型 | 即时生效 |  |
| `asr.local.endpoint` | asr | 地址 | 即时生效 |  |
| `asr.local.api` | asr | 接口 | 即时生效 |  |
| `asr.local.model` | asr | 模型 | 即时生效 |  |
| `asr.local.timeoutSec` | asr | 超时 | 即时生效 |  |
| `proactive.enabled` | proactive | 主动说话 | 即时生效 |  |
| `proactive.speakCooldownMin` | proactive | 主动说话间隔 | 即时生效 |  |
| `proactive.boredAfterMin` | proactive | 多久没理她算无聊 | 即时生效 |  |
| `proactive.hungryAt` | proactive | 饥饿提醒阈值 | 即时生效 |  |
| `proactive.maxLlmPerHour` | proactive | 每小时最多调用模型 | 即时生效 |  |
| `interject.enabled` | proactive | 插个嘴 | 即时生效 |  |
| `interject.sources.chatDraft` | proactive | 来源：聊天框草稿 | 即时生效 |  |
| `interject.sources.voice` | proactive | 来源：语音输入 | 即时生效 |  |
| `interject.sources.api` | proactive | 来源：外部程序 | 即时生效 |  |
| `interject.sources.clipboard` | proactive | 来源：剪贴板（系统级） | 即时生效 |  |
| `interject.cooldownMin` | proactive | 两次插嘴至少间隔 | 即时生效 |  |
| `interject.maxPerHour` | proactive | 每小时最多插嘴 | 即时生效 |  |
| `interject.maxDecidePerHour` | proactive | 每小时最多判断 | 即时生效 |  |
| `interject.debounceSec` | proactive | 停顿多久再判断 | 即时生效 |  |
| `interject.minChars` | proactive | 太短不判断 | 即时生效 |  |
| `interject.quietStart` | proactive | 勿扰开始 | 即时生效 |  |
| `interject.quietEnd` | proactive | 勿扰结束 | 即时生效 |  |
| `interject.timeoutSec` | proactive | 判断超时 | 即时生效 |  |
| `interject.highThreshold` | proactive | 插嘴阈值 | 即时生效 |  |
| `interject.lowThreshold` | proactive | 不插嘴阈值 | 即时生效 |  |
| `interject.model` | proactive | 决策模型 | 即时生效 |  |
| `affectionRules.decay` | proactive | 久未见面时好感衰减 | 即时生效 |  |
| `affectionRules.dailyCap` | proactive | 每日好感上限 | 即时生效 |  |
| `ui.theme` | appearance | 主题 | 即时生效 |  |
| `system.hardwareAcceleration` | about | 硬件加速 | 重启后生效 |  |
| `update.autoCheck` | update | 自动检查更新 | 即时生效 |  |
| `petScaleSet` | behavior（内部） | 手动选过大小 | — | 内部标记：动过「宠物大小」后不再跟随默认大小（由 `petScale` 的修改写入） |
| `characterModel` | about（内部） | 角色数据版本 | — | 角色数据版本（T-2764：2 = 每个形象是一个独立角色；旧文件启动时迁移一次，只读） |

### 12.2 运行时行为控制：17 项

| 行为 | 后台位置 | 设置项 | 操作（admin-preload 通道） | 生效 |
| --- | --- | --- | --- | --- |
| 走动 | 玩法 → 桌宠行为 | `prefs.roam` | `admin-place-pet` | 即时生效 |
| 大小 | 玩法 → 桌宠行为 | `petScale` | — | 即时生效 |
| 触摸与音效 | 玩法 → 桌宠行为 | `prefs.touchZones` `prefs.touchHint` `prefs.clickSound` `prefs.memes` `prefs.collide` | — | 即时生效 |
| 舞蹈（VRM） | 玩法 → 和她一起 → 舞蹈 | `prefs.danceVolume` `prefs.muted` | `dance:play` `dance:stop` `dance:loop` `dance-import-pick` `dance-import-extra` `dance-import-commit` `dance-import-cancel` `dance-remove` | 即时生效 |
| 主动搭话 | 玩法 → 主动搭话与好感 | `proactive.enabled` `proactive.speakCooldownMin` `proactive.boredAfterMin` `proactive.hungryAt` `proactive.maxLlmPerHour` | — | 即时生效 |
| 好感 | 玩法 → 主动搭话与好感；角色详情 → 好感 | `affectionRules.dailyCap` `affectionRules.decay` | `unlock-all` | 即时生效 |
| 同屏伙伴 | 玩法 → 同屏伙伴 | `visitors` `prefs.collide` | — | 即时生效 |
| 语音（朗读 / TTS） | 设置 → 朗读 | `prefs.muted` `prefs.voice` `prefs.voiceInteractions` `prefs.voiceMurmurs` `tts.provider` `tts.fallback` `tts.packs` `tts.endpoints.fish` `tts.endpoints.minimax` `tts.endpoints.local` `tts.local.api` `tts.local.model` `tts.local.voice` `keys.fish` `keys.minimax` `keys.local` | `tts-clear-cache` | 即时生效 |
| 语音包 | 设置 → 语音包 | `tts.packs` | `voicepacks-reload` `open-voicepacks-folder` | 即时生效 |
| 语音输入（ASR） | 设置 → 语音输入 | `asr.enabled` `asr.engine` `asr.fallback` `asr.language` `asr.autoSend` `asr.hotkey` `asr.maxSeconds` `asr.lobehub.model` `asr.local.endpoint` `asr.local.api` `asr.local.model` `asr.local.timeoutSec` `keys.asrlocal` | `asr-test` | 即时生效 |
| 对外接口 | 设置 → 对外接口 | `api.enabled` `api.port` `api.token` | `set-api` `api-status` | 即时生效 |
| 更新 | 设置 → 版本与更新 | `update.autoCheck` | `update-check` `update-install` | 即时生效 |
| 安全（成人向 / 本机能力） | 设置 → 内容与安全；LobeHub 与本机 | `adultContent` `localAbilities` | `confirm-age` `set-adult` | 即时生效 |
| 角色（服饰 / 模型 / 设定） | 角色图鉴 → 角色详情 | `models.<id>` `systemRoles.<id>` `framings.<id>` `vrmPostures.<id>` | `switch-character` `equip-outfit` `set-model` `set-system-role` `set-live2d-height` `set-framing` `set-vrm-posture` | 即时生效 |
| 角色包（导入 / 导出 / 删除） | 设置 → 角色包；角色详情 → 外观（导入的包成为新角色） | — | `import-pack` `import-live2d` `import-vrm` `set-pack-base` `export-pack` `remove-pack` `open-packs-folder` | 即时生效 |
| 数据目录与重置 | 设置 → 数据与关于 | `system.hardwareAcceleration` | `open-data-folder` `open-log` `release` `new-topic` `admin-relaunch` | 即时生效（硬件加速需重启） |
| 设置窗口外观 | 设置 → 外观主题 | `ui.theme` | — | 即时生效 |

### 12.3 菜单（原 ⋯ 菜单与工具栏 / 托盘 / 应用菜单）：26 项

桌宠窗口只保留 喂食 / 玩耍 / 睡觉 / 聊天 + ⚙ 设置（T-2718）；`menu:` / `toolbar:` 行是原 ⋯ 菜单和工具栏按钮现在在设置窗口里的位置。

| 菜单项 | 后台对应 |
| --- | --- |
| `menu:update` | 版本与更新 → 状态 / 立即重启更新（有新版本时 ⚙ 出现红点直达） |
| `menu:settings` | 桌宠窗口的 ⚙ 设置 / 右键她 / Ctrl+⌘ + , → 打开设置窗口 |
| `menu:characters` | 角色图鉴（列表 + 详情） |
| `menu:history` | 玩法 → 和她一起 → 聊天记录（`history-list` / `history-get`） |
| `menu:new-topic` | LobeHub 与本机 → 话题 → 重新开始话题 |
| `menu:adult` | 内容与安全 → 成人向内容 |
| `menu:local` | LobeHub 与本机 → 本机能力 |
| `menu:actions` | 玩法 → 和她一起 → 桌面上的她 → 动作；角色详情 → 舞台上的动作按钮（`admin-cue`） |
| `menu:home` | 玩法 → 和她一起 → 桌面上的她 → 回到右下角（`admin-home`）；桌宠行为 → 位置 → 找回桌宠（`admin-place-pet`） |
| `menu:check-update` | 版本与更新 → 检查更新 |
| `menu:release` | 数据与关于 → 危险操作 → 放生并删除 agent |
| `menu:forget` | 数据与关于 → 危险操作 → 仅重置本地 |
| `menu:log` | 数据与关于 → 数据目录 → 打开错误日志 |
| `menu:credits` | 数据与关于 → 素材署名；角色详情 → 资料 |
| `menu:quit` | 玩法 → 和她一起 → 桌面上的她 → 退出（`admin-quit`）；托盘和应用菜单也有 |
| `toolbar:topics` | 玩法 → 和她一起 → 话题（聊聊，`talk-topic`） |
| `toolbar:wardrobe` | 角色 → 她的页 → 装扮 → 衣柜（`equip-outfit`） |
| `tray:打开设置…` | 打开设置窗口 |
| `tray:快捷调用面板…` | 不需要：打开快捷调用面板（T-2849）：面板里的行都是已有操作，不是设置 |
| `tray:显示桌宠` | 桌宠行为 → 位置 → 找回桌宠 |
| `tray:重置姿势` | 不需要：互动操作，不是设置：桌宠工具栏 ↺、Ctrl+⌘+Shift+R、本地 API 同一功能（T-2830） |
| `tray:检查更新` | 版本与更新 → 检查更新 |
| `tray:退出` | 不需要：退出程序 |
| `app:关于 Pixel Pet` | 不需要：系统「关于」面板；版本也在 版本与更新 |
| `app:偏好设置…` | 打开设置窗口（Ctrl/⌘ + ,） |
| `app:退出` | 不需要：退出程序 |

### 12.4 桌宠窗口通道（src/main/preload.js）：111 个

- 设置窗口有同一通道（46）：`whoami` `talk-topic` `confirm-age` `set-adult` `equip-outfit` `mark-seen` `history-list` `history-get` `unlock-all` `set-model` `refresh-models` `set-system-role` `set-framing` `import-pack` `remove-pack` `catalog-download` `catalog-cancel` `catalog-remove` `import-live2d` `import-vrm` `export-pack` `open-link` `set-live2d-height` `open-packs-folder` `new-topic` `release` `switch-character` `set-vrm-posture` `tts-clear-cache` `open-voicepacks-folder` `voicepacks-reload` `asr-test` `interject-rules` `interject-delete-rule` `interject-set-rule` `interject-clear-decisions` `interject-decisions` `set-api` `api-status` `dances:list` `dance:play` `dance:stop` `dance:state` `open-log` `update-install` `update-check`
- 设置窗口用别的通道做同一件事（11）：
  - `get-settings` → `admin-boot` / `admin-state`（整份设置随广播推送）
  - `preview-pet-scale` → `admin-set` petScale（滑块松手即保存；拖动中的预览只在桌宠窗口）
  - `set-pet-scale` → `admin-set` petScale（桌宠行为 → 宠物大小）
  - `set-local` → `admin-set` localAbilities（LobeHub 与本机 → 本机能力）
  - `set-prefs` → `admin-set` prefs.*（桌宠行为 / 朗读）
  - `set-tts` → `admin-set` tts.* 与 keys.*（朗读）
  - `set-asr` → `admin-set` asr.* 与 keys.asrlocal（语音输入）
  - `set-interject` → `admin-set` interject.*（玩法 → 主动搭话与好感 → 插个嘴）
  - `set-visitors` → `admin-set` visitors（同屏伙伴）
  - `place` → `admin-place-pet`（桌宠行为 → 位置 → 找回桌宠）
  - `open-admin` → 这就是打开设置窗口本身
- 不是配置，只在桌宠窗口（54）：
  - `boot`：桌宠窗口启动
  - `spaces`：首次唤醒时选择空间（唤醒后不能改，连接页只读显示）
  - `hatch`：首次唤醒（领养）流程
  - `act`：互动：喂食 / 玩耍 / 睡觉
  - `reset-pose`：互动：重置姿势（桌宠工具栏 ↺ / Ctrl+⌘+Shift+R / 托盘 / 本地 API POST /pixel-pet/reset-pose 同一条路径，T-2830）；是一次性操作，不是设置
  - `touch`：互动：摸摸（部位触摸）
  - `save-pack-preview`：桌宠窗口给 VRM / Live2D 包存一张预览图（图鉴里显示的就是它）
  - `panel`：桌宠窗口的面板展开 / 收起（窗口尺寸）
  - `chat`：聊天
  - `pick-images`：聊天：选图片
  - `cancel`：聊天：停止生成
  - `move-by`：拖动她
  - `move-to`：走动时移动窗口
  - `work-area`：走动时读屏幕边界
  - `cursor-point`：VRM 视线跟随鼠标
  - `vrm-library-info`：VRM 动作库从哪里加载（只读诊断信息，给 e2e 和排查用，不是设置）
  - `tts-synthesize`：朗读一句（播放，不是配置）
  - `tts-cancel`：停止朗读
  - `tts-prewarm`：互动语音预合成
  - `asr-transcribe`：一次语音输入
  - `asr-cancel`：取消语音输入
  - `asr-mic-access`：麦克风权限请求
  - `interject-draft`：插个嘴的输入来源：聊天框里还没发送的草稿（运行时输入，不是配置）
  - `interject-feedback`：插个嘴：主人对一次插嘴的反馈（气泡上的「别插嘴」/「说得好」），沉淀为规则
  - `interject-add-rule`：插个嘴：手动加一条规则（脚本 / 测试用；设置窗口的规则表只启用 / 停用 / 删除）
  - `visitor-boot`：同屏伙伴窗口启动
  - `pose`：扔出去时的碰撞
  - `peers`：同屏伙伴的位置（碰撞）
  - `kick`：碰撞把别人撞开
  - `api-reply`：对外接口请求的回执
  - `quit`：退出程序（托盘 / 应用菜单）
  - `debug-set`：测试钩子（只在 PIXELPET_TEST=1）
  - `debug-expire-models`：测试钩子（测速脚本 e2e/chat-latency.js 让模型目录缓存过期）
  - `debug-import-pack`：测试钩子
  - `debug-next-open`：测试钩子
  - `debug-next-save`：测试钩子
  - `debug-opened-links`：测试钩子
  - `debug-admin`：测试钩子
  - `debug-tray`：测试钩子
  - `debug-tray-click`：测试钩子
  - `debug-tray-popup`：测试钩子（把真实托盘菜单弹出在桌宠窗口上，便于截图）
  - `debug-heartbeat`：测试钩子
  - `debug-interject-flush`：测试钩子（插个嘴：立即判断）
  - `debug-interject-reset-cooldown`：测试钩子（插个嘴：清掉冷却）
  - `debug-interject-input`：测试钩子（插个嘴：喂一条来源输入）
  - `debug-voice-hotkey`：测试钩子：按一次快捷键唤起语音对话（调用注册的处理函数）
  - `debug-voice-hotkey-status`：测试钩子：快捷键注册状态（设置窗口从 settings.hotkeyStatus 读同一份）
  - `debug-mic-access`：测试钩子：模拟系统拒绝麦克风
  - `debug-hide-pet`：测试钩子：先隐藏 / 最小化桌宠，再验证快捷键把她叫出来
  - `quick-open`：互动：右键 / 长按她打开快捷调用面板（T-2849，docs/quick-panel.md）；面板里的行都是已有操作（偏好设置 / 检查更新 / 重置姿势 / 退出 …），不是设置
  - `quick-dismiss`：互动：在桌宠窗口里按下时关闭已打开的快捷调用面板（T-2849），不是设置
  - `debug-quick`：测试钩子：快捷调用面板的状态（显示 / 位置 / 打开关闭次数 / 快捷键注册状态，T-2849）
  - `debug-quick-hotkey`：测试钩子：按一次快捷调用面板的全局快捷键（调用注册的处理函数）
  - `debug-update-state`：测试钩子：把更新状态设为某一状态（下载中 / 已下载），模拟 Linux 上走不到的分支

缺失：无

<!-- coverage-matrix:end -->
