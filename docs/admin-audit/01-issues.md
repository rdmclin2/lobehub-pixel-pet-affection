# 设置窗口（配置后台）信息架构与交互排查清单

> 交付物 1 · 2026-11-03 · 分支 `feat/admin-ia-polish`（基于 `00252f9` v0.22.0）
> 本文只记录问题，不改代码。优化方案（交付物 2）和落地改动（交付物 3）由后续任务完成。

## 0. 范围、方法与引用格式

**范围**：`admin/src/console/**`（构建到 `src/admin-ui/`）的全部页面，以及决定导航结构的 `src/core/settings-schema.js`（`RAIL` / `NAV` / `PAGES` / `FIELDS`）。分两类看：

- **信息架构（IA）**：功能怎么分组、分几层、叫什么、怎么导航、页面怎么排。
- **交互**：关键任务的流程和操作路径，以及各种反馈与状态：加载、空态、错误、保存、确认、撤销。

**方法**（lobe-design 5.9.0，`node .agents/skills/lobe-design/scripts/route.mjs` 把本任务路由到 `pre-launch · macro`：`00-brief → 80-review(audit)`。按任务要求，另外加载了 30-structure 和 40-flow 的检查清单）：

1. 项目层：`.agents/ux/product.md`（用户画像、核心任务、适用性）、`.agents/ux/components.md`、`.agents/ux/lobe-design-rules.md`（R-01～R-05），以及 `docs/admin-console-design.md` §6、§11 和 `docs/admin-chat.md`。
2. 逐个读了 `admin/src/console/` 下的 19 个源文件：Shell、ConsoleApp、store、SettingsForm、fields，`pages/` 下的 Home、Hub、Characters、Chat、Interject、Together、Store、Pages，以及 `stage/` 下的 4 个组件。
3. 真实运行截图：`unset ELECTRON_RUN_AS_NODE; xvfb-run -a node e2e/run.js admin`（各路由亮色 + 主要页面暗色，`out/e2e/admin/`），再用补充截图脚本（同样的启动参数：fake-lh、预装 catalog、唤醒「格萝可」）截了聊天、话题、聊天记录、桌面上的她、角色详情 6 个标签页、页面底部、未知路由、不存在的角色，以及暗色。43 张截图放在 [`screenshots/`](screenshots/)。没有跑 `all` 和 `live`。
4. 自动化扫描（只作前置信息，不算问题条目）：`lint-lobe.mjs admin/src/console` → `RESULT: 0 FAIL, 2 WARN`；`check-detail.mjs admin/src/console` → `RESULT: 0 FAIL, 17 WARN`（见 §5）。

**design.lobe.li 引用格式**：站点是单页应用，规则页路由是 `/rules/:category`。直接打开 `https://design.lobe.li/rules/<规则号>` 会重定向到对应分类，并用 `?rule=<规则号>` 定位到这一条（逻辑来自站点 bundle 里的 `/rules/${slug}?rule=${id}`）。模型页是 `https://design.lobe.li/models/M-0x`。这里引用的规则号与仓库内 skill 的条目一一对应：P-xx 在 `references/admin-archetypes.md`，K-xx 在 `craft.md`，W-xx 在 `copy.md`，C-xx 在 `components.md`，M-xx 在 `models.md`。下文写成「P-05」时，指的就是 <https://design.lobe.li/rules/P-05>。

**严重度**

| 级别 | 含义 |
| --- | --- |
| P0 | 会让用户做出错误判断，或在不可逆操作上误报结果（数据风险） |
| P1 | 明显拖慢或误导 product.md 的某个核心任务：找不到入口、对象口径不一致、状态被画成别的状态 |
| P2 | 一致性、冗余、文案口径类问题，不阻断任务，但积累起来会让窗口「像后台」 |

## 1. 用户使用习惯依据（条目中引用的编号）

摘自 `.agents/ux/product.md`，再加几条通用心智模型：

| 编号 | 依据 | 出处 |
| --- | --- | --- |
| U-1 | 单个主人，本机使用，中文为主 | product.md「用户」 |
| U-2 | 使用频率低（偶尔调一次），但单次改动代价高（API Key、成人向开关、本机能力） | product.md「用户」 |
| U-3 | 没有权限分级：高风险项靠确认与分区，而不是靠角色权限 | product.md「用户」 |
| U-4 | 陪伴向：她（当前角色）是每页的主角，偏游戏化（舞台、图鉴、衣柜、好感路线图），侧栏只放四个入口（例外：聊天、商店） | product.md「产品类型」、R-05 |
| T-1 | 核心任务 1：切换 / 结识角色，查看角色列表（好感、外观、类型） | product.md「核心任务」 |
| T-2 | 核心任务 2：给角色选模型、外观和个性化设定 | 同上 |
| T-3 | 核心任务 3：配置朗读（TTS）与语音输入（ASR）引擎：Key 与端点 | 同上 |
| T-4 | 核心任务 4：调整桌宠行为（漫步、主动搭话、大小） | 同上 |
| T-5 | 核心任务 5：导入 / 删除角色包与语音包 | 同上 |
| T-6 | 核心任务 6：开关对外接口与成人向内容、检查更新 | 同上 |
| G-1 | 通用心智：同一样东西在哪里都叫同一个名字、数出来的数一样（游戏图鉴里一个角色的多套皮肤归在这个角色下面） | Nielsen #4（M-03） |
| G-2 | 通用心智：地址就是位置。返回、刷新、从别处跳进来，回到的都是同一个画面 | Nielsen #3（M-03） |
| G-3 | 通用心智：设置里「拨了开关就生效」，「填了框要点保存」；离开页面不该悄悄丢掉没保存的东西 | P-05 / P-04 |
| G-4 | 通用心智：提示「成功」就真的成功了；读取失败和「什么都没有」是两回事 | Nielsen #1 / #9（M-03）、K-05 |

## 2. 覆盖矩阵（页面 → 文件 → 截图 → 问题）

| 页面 / 模块 | 路由 | 文件 | 截图 | 问题编号 |
| --- | --- | --- | --- | --- |
| Shell 导航 | 全局 rail、面包屑、未知路由 | `admin/src/console/Shell.tsx`、`ConsoleApp.tsx`、`src/core/settings-schema.js` | `shell-unknown-route.png`，以及任一截图左侧的 rail | SH-01～SH-06 |
| Home（小屋） | `#/overview` | `pages/Home.tsx` | `home-light.png`、`home-bottom-light.png`、`home-dark.png` | HOME-01～HOME-04 |
| Hub（玩法 / 设置入口） | `#/play`、`#/settings` | `pages/Hub.tsx` | `hub-play-light.png`、`hub-settings-light.png`（含 dark） | HUB-01～HUB-04 |
| Characters（图鉴 / 详情 / 角色包） | `#/characters`、`#/characters/:id`、`#/packs` | `pages/Characters.tsx` | `characters-list-light.png`、`character-detail-tab-*.png`（6 张）、`character-detail-missing.png`、`pages-packs-light.png` | CHAR-01～CHAR-08 |
| Chat（聊天） | `#/chat/:id` | `pages/Chat.tsx` | `chat-light.png`、`chat-dark.png` | CHAT-01～CHAT-04 |
| Interject（插个嘴） | `#/proactive` 下半页 | `pages/Interject.tsx`（由 `Pages.tsx` 的 `ProactivePage` 挂载） | `interject-proactive-full-light.png`、`interject-tables-off-light.png`、`interject-proactive-dark.png` | INT-01～INT-04 |
| Together（话题 / 聊天记录 / 桌面上的她） | `#/topics`、`#/history`、`#/desk` | `pages/Together.tsx` | `together-topics-light.png`、`together-history-empty-light.png`、`together-desk-light.png` | TOG-01～TOG-05 |
| Store（商店） | `#/store` | `pages/Store.tsx` | `store-light.png`、`store-dark.png` | STORE-01～STORE-03 |
| Pages（各设置页） | `#/tts` `#/asr` `#/voicepacks` `#/connection` `#/api` `#/safety` `#/update` `#/about` `#/appearance` `#/behavior` | `pages/Pages.tsx` | `pages-*.png`（11 张） | PG-01～PG-08 |
| SettingsForm / fields | 所有设置页的表单 | `SettingsForm.tsx`、`fields.tsx` | `settingsform-behavior-*.png`、`interject-proactive-full-light.png`、`pages-tts-full-light.png` | FORM-01～FORM-06 |
| stage 组件 | 舞台、立绘、好感条 | `stage/CharacterStage.tsx`、`SpriteStage.tsx`、`HeartMeter.tsx`、`VrmLicense.tsx` | `home-light.png`、`character-detail-tab-好感.png`、`characters-list-light.png` | STG-01～STG-03 |

一共 **55 条**：P0 1 条、P1 25 条、P2 29 条；IA 27 条、交互 28 条。

## 3. 问题清单

每条的字段依次是：模块 · 文件、类别、严重度、问题（附证据）、习惯依据、design.lobe.li 引用，最后加一句修改方向（只指方向，不在本任务实施）。

### 3.1 Shell 导航

#### SH-01 · 「拿到 / 管理角色」散在四个入口，跳转时 rail 高亮会换位置

- **模块 · 文件**：Shell 导航 · `src/core/settings-schema.js:65`（`packs` 挂在 设置 → 资源与外观）、`admin/src/console/pages/Characters.tsx:291`（图鉴页头「导入角色」→ `navigate('/packs')`）、`Characters.tsx:892`（详情 → 装扮 →「导入新角色」）、`pages/Store.tsx`
- **类别**：IA · **严重度**：P1
- **问题**：拿到和管理角色，有 角色图鉴、商店、设置 → 角色包、角色详情 → 装扮 → 导入新角色 四个入口。在「角色」入口下点「导入角色」，会跳到 `设置 / 角色包`：rail 高亮从「角色」跳到「设置」，面包屑变成「设置 / 角色包」，用户不知道自己在哪儿了。截图：`screenshots/characters-list-light.png`（右上「导入角色」）→ `screenshots/pages-packs-light.png`（面包屑「设置 / 角色包」，rail 高亮在「设置」）。
- **习惯依据**：T-1、T-5（角色的事应该在「角色」里办完）；G-1；U-4（R-05 要求页面挂在所属入口下）。
- **design.lobe.li**：W-03 专名与口径一致 <https://design.lobe.li/rules/W-03>；Nielsen #4 一致与标准 <https://design.lobe.li/models/M-03>；项目层 R-05。
- **方向**：角色包管理收进「角色」入口（图鉴的下一层），设置里不再单列。

#### SH-02 · 「聊天」和「聊天记录」是同一份对话，却两个入口、三种口径

- **模块 · 文件**：Shell 导航 · `settings-schema.js:32`（rail 聊天）、`:52`（玩法 → 和她一起 → 聊天记录）、`:88`（`PAGES.chat`：「和桌宠的对话**互不影响**」）、`:96`（`PAGES.history`：「你主动发起的聊天」）；`pages/Chat.tsx:661`（「一个角色一段对话，和桌面上共用」）、`:779`；`pages/Together.tsx:154-165`
- **类别**：IA · **严重度**：P1
- **问题**：`docs/admin-chat.md` 写明，聊天页和桌面共用同一份聊天记录，但界面上有三种说法：① schema 的聊天说明写「互不影响」（和实现相反）；② 聊天页空态写「聊天记录里也看得到」；③ 聊天记录页的空态只引导「在桌宠窗口点『聊天』」，不提设置窗口里的聊天页（只读历史，不能接着聊）。用户想翻之前聊过什么，会先去「聊天」，也可能去 玩法 →「聊天记录」，两处呈现和能做的事都不同。截图：`screenshots/chat-light.png`、`screenshots/together-history-empty-light.png`。
- **习惯依据**：U-1；G-1（同一个对象同一个名字）。
- **design.lobe.li**：W-03 <https://design.lobe.li/rules/W-03>；W-07「两个按钮做同一件事 → 合并」<https://design.lobe.li/rules/W-07>；Nielsen #2、#4 <https://design.lobe.li/models/M-03>。
- **方向**：「聊天记录」并进聊天页（按角色看历史 + 接着聊），玩法下不再保留；改正 `PAGES.chat` 的说明。

#### SH-03 · 未知路由静默显示「小屋」，面包屑写「小屋 / nope」

- **模块 · 文件**：Shell 导航 · `admin/src/console/ConsoleApp.tsx:60`（`default:` → `OverviewPage`）、`Shell.tsx:158`（`here` 回退成原始路由段）
- **类别**：交互 · **严重度**：P1
- **问题**：桌宠窗口用 `open-admin(route)` 深链跳进设置窗口。路由拼错或过时（页面改名、删掉）时，没有任何提示，直接显示小屋；面包屑出现「小屋 / nope」这种原始字符串。截图：`screenshots/shell-unknown-route.png`。
- **习惯依据**：G-2（链接把我带到哪里，就该是那个画面，不该悄悄换成别的）；U-2（低频使用，用户记不住正确的路径）。
- **design.lobe.li**：K-05 状态与反馈 <https://design.lobe.li/rules/K-05>；P-03「对象不存在 / 无权限 / 加载失败分开」<https://design.lobe.li/rules/P-03>；Nielsen #9 <https://design.lobe.li/models/M-03>。
- **方向**：未知路由显示「没有这个页面」空态，给回小屋和设置的入口。

#### SH-04 · 面包屑末段显示原始 id（「角色图鉴 / grok」）

- **模块 · 文件**：Shell 导航 · `Shell.tsx:158`（`roster.find((c) => c.id === sub)?.name ?? sub`），而 `Characters.tsx:1119` 会把旧链接按 `base` 解析到角色
- **类别**：IA · **严重度**：P2
- **问题**：用旧链接 `#/characters/grok` 打开时，详情页标题是「格萝可 · 像素（xAI）」，面包屑却是「/ grok」：页面和导航对同一个对象各说各的。截图：`screenshots/character-detail-tab-装扮.png` 左上。
- **习惯依据**：G-1。
- **design.lobe.li**：Nielsen #2「用产品的词，不用数据库的词」<https://design.lobe.li/models/M-03>；W-03。
- **方向**：面包屑和详情页用同一套解析规则。

#### SH-05 · rail 把高频的「聊天」排在最后，入口之间也没有分组

- **模块 · 文件**：Shell 导航 · `settings-schema.js:24-33`（`RAIL` 顺序：小屋 / 角色 / 商店 / 玩法 / 设置 / 聊天）
- **类别**：IA · **严重度**：P2
- **问题**：R-05 把「聊天」列为例外，理由是它是「每天用的高频独立任务」，但它排在低频的「设置」后面。6 个入口之间没有任何分隔，「她的世界」（小屋、角色、商店、聊天）和「配置」（玩法、设置）读起来是一串。截图：任一截图左侧 rail（例如 `screenshots/home-light.png`）。
- **习惯依据**：U-4；U-2（设置低频、聊天高频）。
- **design.lobe.li**：M-08 认知负荷 <https://design.lobe.li/models/M-08>；M-02 格式塔原理（邻近与分组）<https://design.lobe.li/models/M-02>。
- **方向**：重排 rail，高频在上、「设置」放最后，必要时加分隔（入口数不变，仍满足 R-05）。

#### SH-06 · 明暗切换有两个入口，「外观主题」整页只有一个字段，却挂着三层重置

- **模块 · 文件**：Shell 导航 · `Shell.tsx:181`（rail 底部 `data-theme-toggle`）、`settings-schema.js:66`、`:98`；`pages/Pages.tsx`（`SimpleSettingsPage`）
- **类别**：IA · **严重度**：P2
- **问题**：rail 底部的按钮已经能切 跟随系统 / 亮 / 暗。设置 → 资源与外观 → 外观主题 又用一整页放同一个字段，页里还有「恢复本页默认」按钮、字段行尾的恢复默认图标和「默认：跟随系统」标签。截图：`screenshots/pages-appearance-light.png`。
- **习惯依据**：U-2（低频设置不该占一个独立页面）。
- **design.lobe.li**：P-05 常见错法「每个功能一张卡、卡里只有一个开关」<https://design.lobe.li/rules/P-05>；W-07 <https://design.lobe.li/rules/W-07>。
- **方向**：外观主题并进其他设置页，或者只保留 rail 上的切换。

### 3.2 Home（小屋）

#### HOME-01 · 「去看看她」和「换装扮」跳到完全相同的地址

- **模块 · 文件**：Home · `admin/src/console/pages/Home.tsx:154`、`:157`（两个按钮都是 `navigate('/characters/${cur.id}')`）；`Characters.tsx:1114`（详情的标签页是组件内的 `useState('looks')`）
- **类别**：交互 · **严重度**：P1
- **问题**：首屏三个按钮里有两个去向完全相同。「换装扮」能落到装扮，只是因为装扮碰巧是默认标签；同理，从首页没办法直达「模型」「个性化设定」（T-2 的两个主要入口）。截图：`screenshots/home-light.png`。
- **习惯依据**：T-2；G-2（按钮名就是目的地）。
- **design.lobe.li**：W-07「两个按钮做同一件事 → 合并」<https://design.lobe.li/rules/W-07>；W-01 动作文案 <https://design.lobe.li/rules/W-01>；P-02「状态进 URL」<https://design.lobe.li/rules/P-02>。
- **方向**：详情标签页进 URL（`#/characters/:id/looks`），首页按钮分别直达对应标签。

#### HOME-02 · 「其他伙伴」平铺 12 张形象卡，其中 11 张是剪影

- **模块 · 文件**：Home · `Home.tsx:184-200`（`others.map` 平铺全部非当前形象）
- **类别**：IA · **严重度**：P1
- **问题**：「其他伙伴」把每种形象当成一位伙伴：大肥鱼 5 张（像素 / Live2D / 全动态 / 旧版像素 / 原版动画）、克洛蒂 2 张……一共 12 张，11 张是灰色剪影加「还没遇见她」，占了首页一半以上的高度。小屋本来定位为「轻量：舞台 + 关系 + 今天的开关」。截图：`screenshots/home-light.png`、`screenshots/home-bottom-light.png`。
- **习惯依据**：U-4（小屋 = 她的舞台，不做卡片墙）；G-1（同一个角色的不同形象应该归在这个角色下面）。
- **design.lobe.li**：P-02「同一个对象展开成多行时按对象收成一行父行」<https://design.lobe.li/rules/P-02>；P-01 第一屏优先级、常见错法「指标等权平铺」<https://design.lobe.li/rules/P-01>；M-08 <https://design.lobe.li/models/M-08>。
- **方向**：按角色（原型）聚合，只展示遇见过的几位和一个「去图鉴」入口。

#### HOME-03 · 「今天的陪伴」卡片带「开 / 关」标签，看着像开关，其实只能跳转

- **模块 · 文件**：Home · `Home.tsx:90-109`（`Chip`）、`:176-180`
- **类别**：交互 · **严重度**：P2
- **问题**：5 张卡片都在名字旁边放「开 / 关」标签，形态像开关，点下去却跳到设置页。「对外接口」（给脚本用的开发者能力）和朗读、主动搭话并列在陪伴首页。截图：`screenshots/home-light.png`「今天的陪伴」行。
- **习惯依据**：U-4；G-3（看起来能拨的，用户会拨）。
- **design.lobe.li**：P-05「开关只用于立即生效的二值项」<https://design.lobe.li/rules/P-05>；Nielsen #4 <https://design.lobe.li/models/M-03>；components.md 里 `HubPage` 的约定「卡片写当前状态一句话，不放开关」。
- **方向**：状态改用一句话说明，不用开关形态的标签；对外接口移出首页。

#### HOME-04 · 未唤醒时，首页只有一条提示，没有下一步

- **模块 · 文件**：Home · `Home.tsx:168`（`Alert`「还没有唤醒桌宠」，没有 action）
- **类别**：交互 · **严重度**：P2
- **问题**：提示让用户「先在桌宠窗口里选一位角色并完成唤醒」，但没有按钮把桌宠窗口叫到前面（`api().showPet()` 只出现在 rail 底部一个没有文字的图标上）。首次使用时，这是一条死路。证据：代码引用（e2e 场景启动时已经唤醒，没有截到这一态）。
- **习惯依据**：U-2（首次或很久才打开一次）；T-1。
- **design.lobe.li**：W-04 空态文案「引导第一个动作」<https://design.lobe.li/rules/W-04>；Nielsen #10 <https://design.lobe.li/models/M-03>。
- **方向**：空态加「打开桌宠窗口」主动作。

### 3.3 Hub（玩法 / 设置入口）

#### HUB-01 · 入口卡片把整段页面说明当正文，状态行常常只是复述说明

- **模块 · 文件**：Hub · `admin/src/console/pages/Hub.tsx:155`（直接渲染 `schema.pages[i.page]?.description`）、`:77`（数据与关于的状态 =「数据目录、系统选项、素材署名」）、`:79`（聊天记录的状态 =「你主动发起的聊天」）
- **类别**：IA · **严重度**：P1
- **问题**：「主动搭话与好感」卡片正文 4 行，「角色包」5 行，卡片高矮不一，扫读时要逐张读完。两张卡的「当前状态」行只是把说明再写一遍。截图：`screenshots/hub-settings-light.png`、`screenshots/hub-play-light.png`。
- **习惯依据**：U-2（低频用户靠扫读找入口）。
- **design.lobe.li**：W-02「说明不复述标题」<https://design.lobe.li/rules/W-02>；W-07 <https://design.lobe.li/rules/W-07>；components.md 里 `HubPage` 的约定「卡片写当前状态一句话」。
- **方向**：卡片只放一句短说明和真实的当前状态；没有状态的卡不显示状态行。

#### HUB-02 · 高风险项分散在 3 组 4 页，没有「高风险单独一区」

- **模块 · 文件**：Hub / 设置 · `settings-schema.js:235`（`localAbilities` 在 连接 → LobeHub 与本机）、`:72`（对外接口在 连接）、`:77`（成人向在 系统 → 内容与安全）、`:79`（放生 / 重置在 系统 → 数据与关于）
- **类别**：IA · **严重度**：P1
- **问题**：product.md 点名的高代价项（本机能力、成人向、对外接口、清除数据）分别在「LobeHub 与本机」「对外接口」「内容与安全」「数据与关于」四个页面。入口名都看不出这里有高风险操作：「数据与关于」里有「放生并删除 agent」，「LobeHub 与本机」里有能读写文件、运行命令的开关。「资源与外观」把角色包（资源）和窗口主题（外观）放在一组。截图：`screenshots/hub-settings-light.png`、`screenshots/pages-connection-light.png`、`screenshots/pages-about-bottom-light.png`。
- **习惯依据**：U-2、U-3（高风险靠分区）；T-6。
- **design.lobe.li**：P-05「按影响范围分组；高风险项单独一区」<https://design.lobe.li/rules/P-05>；M-02 <https://design.lobe.li/models/M-02>。
- **方向**：设置按影响范围重分组（声音 / 连接与账号 / 隐私与安全 / 系统），高风险项集中放到「隐私与安全」。

#### HUB-03 · 「话题」一词两义，玩法下两个分组名区分度低

- **模块 · 文件**：Hub · `settings-schema.js:41-55`（「陪伴方式」「和她一起」）、`:51`（玩法 → 话题：按好感解锁、让她开口）；`pages/Pages.tsx:262-283`（设置 → LobeHub 与本机 →「话题 / 重新开始话题」：LobeHub 会话）
- **类别**：IA · **严重度**：P2
- **问题**：同一个「话题」，在玩法里是「可解锁的聊天主题」，在设置里是「LobeHub 的会话上下文」。「陪伴方式」和「和她一起」两个分组名，看不出差别是什么（一组配置，一组操作）。截图：`screenshots/hub-play-light.png`、`screenshots/pages-connection-light.png`。
- **习惯依据**：G-1；U-1。
- **design.lobe.li**：W-03 <https://design.lobe.li/rules/W-03>；Nielsen #2 <https://design.lobe.li/models/M-03>。
- **方向**：LobeHub 会话改叫「重新开始对话」，挪到聊天页；玩法的分组按「她怎么陪你（设置）」和「和她互动（操作）」命名。

#### HUB-04 · 玩法顶部显示心情 / 饱腹 / 精力，却只能看、不能做

- **模块 · 文件**：Hub · `Hub.tsx:325-360`（`PetStatus`，文案「喂食、陪玩和哄睡在桌宠窗口里进行」）
- **类别**：交互 · **严重度**：P2
- **问题**：「饱腹 70」这类状态驱动的动作是喂食，但玩法页没有这个动作，只说要去桌宠窗口。用户看到数值后的下一步被推到另一个窗口。截图：`screenshots/hub-play-light.png`。
- **习惯依据**：T-4；U-4。
- **design.lobe.li**：P-01 常见错法「只能看不能点」<https://design.lobe.li/rules/P-01>；M-06 福格行为模型（动机有了，缺能力 A）<https://design.lobe.li/models/M-06>。
- **方向**：状态旁边给出对应动作（例如喂食，调用桌宠窗口已有的 IPC），或者不在这里显示数值。

### 3.4 Characters（角色图鉴 / 详情 / 角色包）

#### CHAR-01 · 「角色」的计数在四个地方各不相同（13 / 8 / 17 / 5）

- **模块 · 文件**：Characters · `admin/src/console/pages/Characters.tsx:295`（「已遇见 2 / 13 位」）、`:330`（图鉴网格按形象平铺）；`Characters.tsx:1273`（角色包「共 17 位角色」）；`pages/Store.tsx:43`（「全部 8」）；`pages/Chat.tsx:647`（会话栏按原型，5 位）
- **类别**：IA · **严重度**：P1
- **问题**：同一批角色，图鉴说 13 位，角色包说 17 位（多出成年版 18+），商店说 8 个，聊天列 5 位。图鉴里大肥鱼占 5 张同名卡，11 张是剪影，每张都有「初次见面」。用户分不清「角色」「形象」「角色包」各指什么，也就答不上「我有几位角色」。截图：`screenshots/characters-list-light.png`、`screenshots/pages-packs-light.png`、`screenshots/store-light.png`、`screenshots/chat-light.png`。
- **习惯依据**：T-1（查看角色列表）；G-1（游戏图鉴：一位角色、多套皮肤）。
- **design.lobe.li**：W-03「状态词和数字一致」<https://design.lobe.li/rules/W-03>；P-02 分组 <https://design.lobe.li/rules/P-02>；M-02 <https://design.lobe.li/models/M-02>。
- **方向**：定一个对象模型：角色（原型）→ 形象（皮肤）→ 服饰。图鉴按角色列，形象放进详情的装扮里；全窗口使用同一套计数口径。

#### CHAR-02 · 详情标签页不进 URL，返回、刷新、深链都回到「装扮」

- **模块 · 文件**：Characters · `Characters.tsx:1114`（`useState<DetailTab>('looks')`）、`:1189-1238`
- **类别**：交互 · **严重度**：P1
- **问题**：在「模型」标签改完模型，切去聊天再回来，又回到「装扮」。首页、聊天、桌宠窗口都没办法直接打开「模型」或「个性化设定」。截图：`screenshots/character-detail-tab-模型.png`（地址栏仍是 `#/characters/grok`，见 `data-path`）。
- **习惯依据**：T-2；G-2。
- **design.lobe.li**：P-02「筛选、排序、分页进 URL」<https://design.lobe.li/rules/P-02>；P-03 <https://design.lobe.li/rules/P-03>；Nielsen #3 <https://design.lobe.li/models/M-03>。
- **方向**：路由改成 `#/characters/:id/:tab`。

#### CHAR-03 · 详情首屏被舞台和简介占满，「好感」标签里同一条好感条画了两遍

- **模块 · 文件**：Characters · `Characters.tsx:1188`（标签页上方的 `<HeartMeter c={c} />`）、`:986`（好感标签里又一个 `<HeartMeter c={c} />`）
- **类别**：IA · **严重度**：P1
- **问题**：在 1200×820 的视口里，标签栏在 y≈405，标签内容从首屏底部才开始。切到「好感」，同一屏出现两条一样的好感条（阶段节点、「离『熟悉』还差 15」、「今天 +0 / 上限 12」都重复）。截图：`screenshots/character-detail-tab-好感.png`、`screenshots/character-detail-tab-装扮.png`。
- **习惯依据**：T-2（来详情是为了改装扮 / 模型 / 设定）；U-4。
- **design.lobe.li**：W-07「同一个数在页面上重复出现 → 删」<https://design.lobe.li/rules/W-07>；P-03 第一屏优先级 <https://design.lobe.li/rules/P-03>。
- **方向**：页头只放身份和一条紧凑的好感；完整路线图只放在「好感」标签里。

#### CHAR-04 · 「语音」「资料」两个标签几乎只读，内容和别处重复，还要靠文字路径跨层跳转

- **模块 · 文件**：Characters · `Characters.tsx:1199-1233`、`:1209`（「语音包可以在 设置 → 语音包 里重新读取或替换」，纯文本，没有链接）
- **类别**：IA · **严重度**：P2
- **问题**：「资料」里的模型、形象、角色包，在「模型」「装扮」标签和页头已经出现过。「语音」标签只读，想改要记住「设置 → 语音包」这条路径自己去找。6 个标签里有 2 个是纯信息。截图：`screenshots/character-detail-tab-语音.png`、`screenshots/character-detail-tab-资料.png`。
- **习惯依据**：T-2、T-5；U-2（记不住路径）。
- **design.lobe.li**：Nielsen #6 识别优于回忆 <https://design.lobe.li/models/M-03>；W-07 <https://design.lobe.li/rules/W-07>；M-08 <https://design.lobe.li/models/M-08>。
- **方向**：「语音」「资料」合并成一个标签，语音包给出可点的链接。

#### CHAR-05 · 不可撤销的「一键解锁」和「删除下载」混在普通内容里

- **模块 · 文件**：Characters · `Characters.tsx:1004-1014`（好感标签正文里的「一键解锁」，`danger`）、`:870-881`（装扮 → 角色包卡片里「删除下载」和「授权信息」并排）
- **类别**：交互 · **严重度**：P1
- **问题**：「一键解锁」把好感拉满、不能撤销，就放在关系路线图正下方。「删除下载」和普通的「授权信息」按钮挤在同一行。两处都有确认，但都没有放进统一的危险区。截图：`screenshots/character-detail-tab-好感.png`（右下「一键解锁」）、`screenshots/character-detail-tab-装扮.png`。
- **习惯依据**：U-2、U-3（高风险靠分区）。
- **design.lobe.li**：P-03 常见错法「危险操作和普通操作同色同位」<https://design.lobe.li/rules/P-03>；P-05「高风险项单独一区」<https://design.lobe.li/rules/P-05>；components.md 里的 `DangerZone` 约定。
- **方向**：详情页底部设一个 DangerZone，集中放删除下载、一键解锁、清空设定。

#### CHAR-06 · 角色不存在时只有一条红色提示，没有出路

- **模块 · 文件**：Characters · `Characters.tsx:1130`（`<Alert title={`没有角色「${id}」`} type="error" />`）
- **类别**：交互 · **严重度**：P2
- **问题**：提示只说「没有角色『nobody』」：没说可能的原因（已删除？未下载？），也没有「回角色图鉴」或「去商店」按钮。截图：`screenshots/character-detail-missing.png`。
- **习惯依据**：G-4；U-2。
- **design.lobe.li**：W-05 错误文案（发生了什么 / 为什么 / 怎么办）<https://design.lobe.li/rules/W-05>；P-03 必须有的状态 <https://design.lobe.li/rules/P-03>；Nielsen #9 <https://design.lobe.li/models/M-03>。
- **方向**：换成 `Empty`，写清原因，给两个出口。

#### CHAR-07 · 图鉴筛选不进 URL；卡片同时有两套「进详情」入口，切换按钮的文案随状态变

- **模块 · 文件**：Characters · `Characters.tsx:279`（`useState('all')`）、`:333`（立绘链接）、`:368`（「详情」文字按钮）、`:81-90`（`SwitchButton`：「初次见面」dashed /「切换」default）
- **类别**：交互 · **严重度**：P2
- **问题**：选了「Live2D」筛选，进详情再返回，筛选回到「全部」。每张卡上，点立绘和点「详情」去的是同一个地方。同一个位置的按钮，一会儿是「初次见面」（虚线），一会儿是「切换」（实线），当前角色干脆没有按钮。截图：`screenshots/characters-list-light.png`。
- **习惯依据**：T-1；G-2。
- **design.lobe.li**：P-02 常见错法「筛选不进 URL」「行点击和行内按钮冲突」<https://design.lobe.li/rules/P-02>。
- **方向**：筛选进 query；卡片整张可点，只保留一个动作按钮。

#### CHAR-08 · 「角色包」表把成年版、旧版像素逐行列出，显示原始 id，不按角色分组

- **模块 · 文件**：Characters（`PacksPage`）· `Characters.tsx:1248-1330`
- **类别**：IA · **严重度**：P1
- **问题**：17 行平铺，每行的主列下面是 `claude-adult` 这类代码 id；同一角色的 3～5 个包散在表里（按来源排序）。用户想「删掉大肥鱼的 Live2D」，得自己在表里对名字。截图：`screenshots/pages-packs-light.png`。
- **习惯依据**：T-5；G-1。
- **design.lobe.li**：P-02「列优先级」「分组：同一个对象展开成多行时按对象收成一行父行」<https://design.lobe.li/rules/P-02>；Nielsen #2 <https://design.lobe.li/models/M-03>。
- **方向**：按角色分组成父行，id 收进悬停提示；这张表随 SH-01 一起挪到「角色」下面。

### 3.5 Chat（聊天）

#### CHAT-01 · 聊天和聊天记录的口径冲突（见 SH-02）

- **模块 · 文件**：Chat · `pages/Chat.tsx:779`（空态「在这里说的话，她在桌面上也记得；聊天记录里也看得到」）、`settings-schema.js:88`（「和桌宠的对话互不影响」）
- **类别**：IA · **严重度**：P1
- **问题**：聊天页自己的文案和 schema 里聊天页的说明互相矛盾；它指向的「聊天记录」在另一个入口（玩法 → 和她一起），页面上也没有链接。截图：`screenshots/chat-light.png`。
- **习惯依据**：G-1；U-1。
- **design.lobe.li**：W-03 <https://design.lobe.li/rules/W-03>；Nielsen #4 <https://design.lobe.li/models/M-03>。
- **方向**：随 SH-02 一起合并。

#### CHAT-02 · 同一状态有三种叫法：「在桌面」「当前角色」「正在陪你」；同一角色的名字长短也不一

- **模块 · 文件**：Chat · `Chat.tsx:690`（`在桌面`）；`Characters.tsx`（图鉴 ribbon「当前角色」）；`Home.tsx:140`（「正在陪你」）
- **类别**：IA · **严重度**：P2
- **问题**：会话栏写「格萝可 · 在桌面」，图鉴写「格萝可 · 像素（xAI） · 当前角色」，首页写「正在陪你」：一个状态三种标签，名字也有长短两套。截图：`screenshots/chat-light.png`、`screenshots/characters-list-light.png`、`screenshots/home-light.png`。
- **习惯依据**：G-1；T-1。
- **design.lobe.li**：W-03「同一个对象在侧栏、标题、表格列、toast、确认框里用同一个词」<https://design.lobe.li/rules/W-03>。
- **方向**：统一成一个状态词和一套命名规则。

#### CHAT-03 · 会话栏列出所有原型（包括没见过的），每次聊天都要扫过它们

- **模块 · 文件**：Chat · `Chat.tsx:647-652`（`characters` 为空时，用 roster 的所有 base 补齐）
- **类别**：交互 · **严重度**：P2
- **问题**：5 位里 4 位写着「还没见过面」，点进去是空态加「去见她」。高频的聊天入口被结识类内容占掉大半。截图：`screenshots/chat-light.png`。
- **习惯依据**：U-4（聊天是高频独立任务）；T-1（结识应该在图鉴里完成）。
- **design.lobe.li**：W-07 <https://design.lobe.li/rules/W-07>；M-08 Hick 定律 <https://design.lobe.li/models/M-08>。
- **方向**：只列已遇见的角色，未遇见的收进底部一行「结识更多」。

#### CHAT-04 · 聊天页里换模型会同时改掉桌宠的模型，页面上没有说明影响范围

- **模块 · 文件**：Chat · `Chat.tsx:533`（`changeModel` → `petAdmin.setModel`，和 角色 → 模型 是同一个值）、`:726`（标题下常驻「她记得最近 4 小时……」）
- **类别**：交互 · **严重度**：P2
- **问题**：头部的模型下拉框看起来是「这段聊天用哪个模型」，实际改的是她在所有地方用的模型（`docs/admin-chat.md`：「与 角色 → 她的页面 → 模型 是同一个值」）。而标题下常驻的说明是记忆规则，不是这个影响范围。截图：`screenshots/chat-light.png` 右上。
- **习惯依据**：T-2；U-2（单次改动代价高，要知道会影响什么）。
- **design.lobe.li**：P-05 常见错法「不说明影响范围」<https://design.lobe.li/rules/P-05>；W-02 <https://design.lobe.li/rules/W-02>。
- **方向**：模型下拉旁边写明「桌面上也会用这个模型」，或者在切换后的 toast 里说明。

### 3.6 Interject（插个嘴）

#### INT-01 · 「插个嘴」是独立功能，却埋在「主动搭话与好感」页中段

- **模块 · 文件**：Interject · `settings-schema.js:94`（页面说明一句话列了 3 个主题）；`pages/Pages.tsx:62-71`（`ProactivePage` = 3 张表单卡 + `InterjectData` 两张表）
- **类别**：IA · **严重度**：P1
- **问题**：入口和页名里都没有「插个嘴」；页面混着 主动行为、插个嘴、好感度 三个主题，外加「沉淀的规则」「最近 20 次判断」两张表，一共 5 个区块，页面高约 1670px。截图：`screenshots/interject-proactive-full-light.png`。
- **习惯依据**：T-4；U-2（低频用户靠页名找功能）。
- **design.lobe.li**：P-05「按影响范围分组」<https://design.lobe.li/rules/P-05>；W-02「页面标题和侧栏入口同名」<https://design.lobe.li/rules/W-02>；M-08 <https://design.lobe.li/models/M-08>。
- **方向**：拆成「主动搭话」「插个嘴」「好感规则」三页（或三个标签页）；插个嘴的规则和判断记录只跟它自己走。

#### INT-02 · 插个嘴关闭时，两张表照样铺开；同一个「关」被表达了三次

- **模块 · 文件**：Interject · `Interject.tsx:120-200`（不看 `enabled`，始终渲染两张表）、`Pages.tsx:68`（卡头标签「默认关闭」）、`fields.tsx:645`（字段「默认：关」）
- **类别**：交互 · **严重度**：P1
- **问题**：插个嘴关着时，页面底部仍是两张带空态的表。卡头的「默认关闭」标签、字段里的「默认：关」、开关本身，三处在说同一件事；卡头的标签写的是「默认」，不是「当前」，容易误读。截图：`screenshots/interject-tables-off-light.png`、`screenshots/interject-proactive-full-light.png`。
- **习惯依据**：G-3；U-2。
- **design.lobe.li**：P-05 功能开关「配置项只在开启后出现；不要在关闭时铺出一屏用不上的配置」<https://design.lobe.li/rules/P-05>；C-17「再挂一个复述它的 badge 只是噪音」<https://design.lobe.li/rules/C-17>。
- **方向**：关闭时收起表格，只留一句说明；卡头标签去掉。

#### INT-03 · 首次加载失败时，规则表显示「还没有规则」，失败被画成零条

- **模块 · 文件**：Interject · `Interject.tsx:85`（catch 只设 `error`）、`:159-161`（`dataSource={rules ?? []}`、`loading={rules === null && !error}`、`emptyText`「还没有规则……」）
- **类别**：交互 · **严重度**：P1
- **问题**：第一次读取失败时，`rules` 仍是 `null`，`loading` 变成 false，表格显示空态文案；页面顶部的 Alert 可以关掉，关掉之后只剩假空态，用户会以为确实没有规则。证据：代码引用（e2e 没有注入读取失败；截图 `screenshots/interject-tables-off-light.png` 是同一组件的正常空态，失败态会显示同样的文案）。
- **习惯依据**：G-4。
- **design.lobe.li**：K-05「失败不是零条」「读失败由数据所在的表面负责」<https://design.lobe.li/rules/K-05>；W-04「区分三种空」<https://design.lobe.li/rules/W-04>；Nielsen #9 <https://design.lobe.li/models/M-03>。
- **方向**：没有数据且出错时，表格位置显示失败态和「重试」。

#### INT-04 · 「清空记录」不看结果就报成功

- **模块 · 文件**：Interject · `Interject.tsx:111-116`（`await api().interjectClearDecisions(); toast.success(...)`）
- **类别**：交互 · **严重度**：P2
- **问题**：清空是不可逆的，却没有检查返回值；调用失败也会提示「判断记录已清空」。证据：代码引用。
- **习惯依据**：G-4；U-2。
- **design.lobe.li**：C-15「确认要等这次写入完成才关；失败写在弹窗里」<https://design.lobe.li/rules/C-15>；W-05 <https://design.lobe.li/rules/W-05>。
- **方向**：按 `ok` 分支反馈；确认弹窗等请求完成再关闭。

### 3.7 Together（话题 / 聊天记录 / 桌面上的她）

#### TOG-01 · 聊天记录读取失败时，显示成「还没有你主动发起的聊天」

- **模块 · 文件**：Together · `admin/src/console/pages/Together.tsx:109`（`api().historyList().then(..., () => setList([]))`）
- **类别**：交互 · **严重度**：P1
- **问题**：读取失败直接当成空列表，显示首次使用的引导文案。截图：`screenshots/together-history-empty-light.png`（正常空态；失败时显示的就是这一屏）。
- **习惯依据**：G-4（「什么都没有」和「没读出来」是两回事）。
- **design.lobe.li**：K-05 <https://design.lobe.li/rules/K-05>；W-04 <https://design.lobe.li/rules/W-04>。
- **方向**：单独做失败态，带重试。

#### TOG-02 · 聊天记录详情是页内状态：后退直接离开，面包屑和「返回列表」各指一处

- **模块 · 文件**：Together · `Together.tsx:105`（`useState<HistorySession | null>`）、`:116-125`（「返回列表」按钮）
- **类别**：交互 · **严重度**：P1
- **问题**：打开一段对话后，地址不变；面包屑仍写「玩法 / 聊天记录」，点「玩法」会回到 Hub，而不是列表。没有可分享或回访的地址。证据：代码引用加 `screenshots/together-history-empty-light.png` 里的面包屑结构。
- **习惯依据**：G-2。
- **design.lobe.li**：P-03「不挂在所属列表下（面包屑断）」<https://design.lobe.li/rules/P-03>；Nielsen #3 <https://design.lobe.li/models/M-03>。
- **方向**：随 SH-02 并进聊天页（`#/chat/:id` 已经有地址）。

#### TOG-03 · 「聊聊」先提示开始了，再请求；失败时会出现两条矛盾的 toast

- **模块 · 文件**：Together · `Together.tsx:56-59`（请求前就 `toast.info('…开始聊「…」了')`，失败后再 `toast.error`）
- **类别**：交互 · **严重度**：P2
- **问题**：成功提示出现在结果之前；话题未解锁或桌宠在忙时，用户先看到「开始聊了」，紧接着又是「还没解锁」。证据：代码引用；页面截图 `screenshots/together-topics-light.png`。
- **习惯依据**：G-4。
- **design.lobe.li**：Nielsen #1 系统状态可见 <https://design.lobe.li/models/M-03>；K-05 <https://design.lobe.li/rules/K-05>。
- **方向**：按钮自己显示 loading，等结果出来再给一条 toast。

#### TOG-04 · 「桌面上的她」把动作、回到右下角、退出应用放在一页；「回到右下角」和桌宠行为页重复

- **模块 · 文件**：Together · `Together.tsx:232`（`data-desk-home` → `api().home()`）、`:249`（`data-desk-quit` 退出整个应用）；`pages/Pages.tsx:86`（桌宠行为 → 位置 →「找回桌宠（回到右下角）」→ `api().placePet()`）
- **类别**：IA · **严重度**：P1
- **问题**：退出整个应用这种系统级操作挂在「玩法 → 和她一起」下面。「回到右下角」在两个页面各有一个按钮，文案不同，调用的接口也不同（`home` 与 `placePet`），用户不知道两者有什么区别。截图：`screenshots/together-desk-light.png`、`screenshots/settingsform-behavior-bottom-light.png`。
- **习惯依据**：T-4；U-3（危险操作靠分区）；G-1。
- **design.lobe.li**：W-07「两个按钮做同一件事 → 合并」<https://design.lobe.li/rules/W-07>；P-05 <https://design.lobe.li/rules/P-05>；Nielsen #4 <https://design.lobe.li/models/M-03>。
- **方向**：「退出」移到系统区；「找回桌宠」保留一个；动作并进舞台（见 STG-01）。

#### TOG-05 · 未唤醒时，话题 / 桌面上的她只有一句话，没有下一步

- **模块 · 文件**：Together · `Together.tsx:21-25`（`NoPet`）
- **类别**：交互 · **严重度**：P2
- **问题**：提示「先在桌宠窗口里选一位角色并唤醒她」，但没有按钮。证据：代码引用（e2e 已唤醒，没有截到这一态）。
- **习惯依据**：U-2；T-1。
- **design.lobe.li**：W-04 <https://design.lobe.li/rules/W-04>；Nielsen #10 <https://design.lobe.li/models/M-03>。
- **方向**：和 HOME-04 共用一个「还没唤醒」空态组件，带主动作。

### 3.8 Store（商店）

#### STORE-01 · 只有一个标签的标签栏；同样的动作在不同页面叫「查看」和「详情」

- **模块 · 文件**：Store · `admin/src/console/pages/Store.tsx:84-90`（`PageTabs` 只有「角色」一项）；`Characters.tsx:238`（商店卡片「查看」）、`:368`（图鉴卡片「详情」）
- **类别**：IA · **严重度**：P2
- **问题**：单个标签的标签栏切不到任何东西，只多占一行。同一个动作（打开她的页面），在商店叫「查看」，在图鉴叫「详情」。截图：`screenshots/store-light.png`、`screenshots/characters-list-light.png`。
- **习惯依据**：G-1。
- **design.lobe.li**：W-07「切换后画面不变的控件 → 删」<https://design.lobe.li/rules/W-07>；W-03 <https://design.lobe.li/rules/W-03>。
- **方向**：只有一个类别时不显示标签栏（有第二个类别时再出现）；按钮文案统一。

#### STORE-02 · 商店里是彩色立绘加「已下载」，到了图鉴却是灰色剪影加「未遇见」

- **模块 · 文件**：Store / Characters · `Characters.tsx:333-340`（图鉴的 `silhouette={!c.met && !c.current}`）；`stage/SpriteStage.tsx:217`；`Store.tsx`（`CatalogGrid` 用彩色）
- **类别**：IA · **严重度**：P1
- **问题**：「已拥有（下载）」和「已遇见（起名、结识）」是两套状态，但哪里都没有解释。用户在商店下完一位，回图鉴只看到一个灰色剪影加锁，很容易以为下载失败或没生效。截图：`screenshots/store-light.png`（8 张全是「已下载」，彩色）对比 `screenshots/characters-list-light.png`（同一批形象是剪影）。
- **习惯依据**：T-1、T-5；G-4。
- **design.lobe.li**：W-03「状态词和数字一致」<https://design.lobe.li/rules/W-03>；Nielsen #1、#2 <https://design.lobe.li/models/M-03>。
- **方向**：图鉴里区分「已拥有、还没见面」和「未拥有」，剪影只留给没下载的；下载完成的 toast 给「去见她」。

#### STORE-03 · 商店筛选不进 URL；页头说明和 schema 里是两套文案

- **模块 · 文件**：Store · `Store.tsx:16`（`useState('all')`）、`:81`（页头描述是写死的字符串）vs `settings-schema.js:87`（`PAGES.store.description`）
- **类别**：交互 · **严重度**：P2
- **问题**：选「未下载」后点「查看」再返回，筛选被重置。页头说明「……不需要了可以在她的页面删除下载」和 schema 里「以后还会有声音包等」两套文案并存，其他页面都读 schema，只有这一页例外。截图：`screenshots/store-light.png`。
- **习惯依据**：G-2。
- **design.lobe.li**：P-02 <https://design.lobe.li/rules/P-02>；W-03 <https://design.lobe.li/rules/W-03>。
- **方向**：筛选进 query；页头统一读 schema。

### 3.9 Pages（各设置页）

#### PG-01 · 朗读页一次铺开 4 个引擎的全部配置（13 个字段、11 个保存按钮）

- **模块 · 文件**：Pages · `admin/src/console/pages/Pages.tsx:111-160`（`TtsPage`）、`:135`（四张引擎卡始终渲染）
- **类别**：IA · **严重度**：P1
- **问题**：不管当前选的是哪个引擎（截图里是「自动」，朗读也是关着的），Fish Audio、MiniMax、ElevenLabs、本地语音服务的端点 / Key / 模型 / 音色全部展开（引擎相关 13 个字段、11 个「保存」按钮），页面高 2672px。要配置一个引擎，得在三张无关的卡里找到自己那张。截图：`screenshots/pages-tts-full-light.png`。
- **习惯依据**：T-3；U-2（偶尔来一次，要一眼找到要填的那几项）。
- **design.lobe.li**：P-05 功能开关「关闭的功能也铺满配置项」<https://design.lobe.li/rules/P-05>；M-08「一屏区块数 > 7 → 先分层」<https://design.lobe.li/models/M-08>。
- **方向**：先选引擎，只展开所选引擎的配置；其他引擎收进「其他引擎」折叠区，显示是否已设置 Key。

#### PG-02 · 语音输入有「测试连接」，朗读没有「试听 / 测试」

- **模块 · 文件**：Pages · `Pages.tsx:164-200`（`AsrPage` 的「测试连接」）vs `TtsPage`（只有每个引擎的「可用 / 未设置 Key」标签）
- **类别**：交互 · **严重度**：P1
- **问题**：填完朗读 Key 后，设置窗口里没有办法验证它能不能用，只能回桌宠窗口等她说话；而同类的语音输入页有测试按钮，流程不对称。截图：`screenshots/pages-tts-full-light.png`、`screenshots/pages-asr-light.png`。
- **习惯依据**：T-3；U-2（Key 填错的代价要当场暴露）。
- **design.lobe.li**：P-05「用户在决定：改完是否生效」<https://design.lobe.li/rules/P-05>；Nielsen #1 <https://design.lobe.li/models/M-03>；M-06（缺能力 A）<https://design.lobe.li/models/M-06>。
- **方向**：每张引擎卡加「试听」，结果写在卡里（成功 / 失败原因）。

#### PG-03 · 「放生并删除 agent」「仅重置本地」失败时仍然提示成功（P0）

- **模块 · 文件**：Pages · `Pages.tsx:376-387`（`release`：`ask` 一确认就关闭弹窗，`await api().release(...)` 后不检查 `r.ok`，直接 `toast.success('已放生，删除了 ${r?.deleted ?? 0} 个 agent')`）；`:140-145`（清空语音缓存同样没有失败分支）
- **类别**：交互 · **严重度**：P0
- **问题**：这是窗口里最不可逆的操作（删除本机进度、聊天记录和 LobeHub 里的 agent）。请求还没完成，确认弹窗就关了；请求失败（网络、LobeHub 未登录）时，用户看到的却是「已放生，删除了 0 个 agent」，以为数据已经清掉。截图：`screenshots/pages-about-bottom-light.png`（危险操作区）；失败态是代码引用。
- **习惯依据**：U-2（单次改动代价高）；U-3；G-4。
- **design.lobe.li**：C-15「确认要等这次写入完成才关：进行中显示在按钮上，失败写在弹窗里。不可逆操作提交期间不允许关闭」<https://design.lobe.li/rules/C-15>；W-05 <https://design.lobe.li/rules/W-05>；K-05 <https://design.lobe.li/rules/K-05>。
- **方向**：确认弹窗里执行，带 loading；失败留在弹窗里写原因；成功后写出实际删除的条数。

#### PG-04 · 检查更新失败只写「检查失败」，没有原因和下一步

- **模块 · 文件**：Pages · `Pages.tsx:45`（`error: '检查失败'`）、`:340-350`（按钮只有 loading，结果只体现在「状态」行）
- **类别**：交互 · **严重度**：P2
- **问题**：点完「检查更新」，结果只是「状态」那行文字变了，没有反馈动作；失败时只有四个字。截图：`screenshots/pages-update-light.png`。
- **习惯依据**：T-6；G-4。
- **design.lobe.li**：W-05「禁止单独出现『操作失败』」<https://design.lobe.li/rules/W-05>；Nielsen #9 <https://design.lobe.li/models/M-03>。
- **方向**：失败时给出原因（网络、开发版），并给「重试」或「打开下载页」。

#### PG-05 · 「LobeHub 与本机」一页混放账号、高风险开关和对话操作；「本机能力」卡里只有一个开关

- **模块 · 文件**：Pages · `Pages.tsx:251-288`（`ConnectionPage`）；`settings-schema.js:235`（卡标题和字段都叫「本机能力」）
- **类别**：IA · **严重度**：P2
- **问题**：只读的账号信息、能读写文件和运行命令的高风险开关、「重新开始话题」（对话操作），三件事放在一页；「本机能力」一张卡里只有一个同名开关，卡标题和字段名重复。截图：`screenshots/pages-connection-light.png`。
- **习惯依据**：U-3；T-6。
- **design.lobe.li**：P-05 常见错法「每个功能一张卡、卡里只有一个开关」「高风险项和普通项一个样式」<https://design.lobe.li/rules/P-05>；W-03 <https://design.lobe.li/rules/W-03>。
- **方向**：随 HUB-02 重新分组：本机能力进「隐私与安全」，重新开始对话进聊天页。

#### PG-06 · 「外观主题」的说明和现状不符

- **模块 · 文件**：Pages · `settings-schema.js:98`（「桌宠窗口保持像素风格」）
- **类别**：IA · **严重度**：P2
- **问题**：R-04 之后，桌宠窗口的界面部分（气泡、工具栏、菜单）已经改用 `--lobe-*` 令牌、跟随明暗，说明还停在旧状态，会让用户以为切了主题对桌宠没有影响。截图：`screenshots/pages-appearance-light.png`。
- **习惯依据**：G-1；U-1。
- **design.lobe.li**：W-02「说明讲清这里能做什么」<https://design.lobe.li/rules/W-02>；Nielsen #2 <https://design.lobe.li/models/M-03>。
- **方向**：按实际影响范围改写说明（交给 75-copy）。

#### PG-07 · 「数据与关于」一页四种内容：数据目录、系统选项、很长的素材署名、危险操作

- **模块 · 文件**：Pages · `Pages.tsx:374-440`（`AboutPage`）
- **类别**：IA · **严重度**：P2
- **问题**：4 个「打开文件夹」按钮并排（角色包、语音包文件夹在各自的页面里也有一份），接着是 5 位角色各 2～4 行的素材署名（和角色详情 →「资料」重复），最后才是危险操作，要滚两屏才到。入口名也看不出这里有危险操作。截图：`screenshots/pages-about-light.png`、`screenshots/pages-about-bottom-light.png`。
- **习惯依据**：U-2、U-3。
- **design.lobe.li**：W-07 <https://design.lobe.li/rules/W-07>；P-05 <https://design.lobe.li/rules/P-05>；M-08 <https://design.lobe.li/models/M-08>。
- **方向**：素材署名折叠起来，或者只放在角色详情；危险操作随 HUB-02 进入「隐私与安全」。

#### PG-08 · 语音包页只能「打开文件夹」和「重新读取」，没有空态和下一步

- **模块 · 文件**：Pages · `Pages.tsx:202-250`（`VoicePacksPage`：`Table` 没有设 `emptyText`）
- **类别**：交互 · **严重度**：P2
- **问题**：导入或替换语音包要自己去数据目录放文件，再回来点「重新读取」，页面上没写放到哪里、什么格式；表格为空时显示组件默认的空态。截图：`screenshots/pages-voicepacks-light.png`。
- **习惯依据**：T-5；U-2。
- **design.lobe.li**：W-04「首次使用（引导第一个动作）」<https://design.lobe.li/rules/W-04>；M-06（缺能力 A）<https://design.lobe.li/models/M-06>。
- **方向**：空态写清放置位置和格式；如果主进程支持，提供「导入语音包…」。

### 3.10 SettingsForm / fields

#### FORM-01 · 一页里两种保存方式混用；离开页面时，没保存的草稿静默丢失

- **模块 · 文件**：SettingsForm/fields · `admin/src/console/fields.tsx:1-8`（约定：开关 / 下拉 / 滑块即时保存，数字 / 文本 / URL 是草稿 + 保存）、`:218-291`（`DraftControl`，草稿只存在组件 state 里）、`:287`（只在字段下方写「未保存的修改」）
- **类别**：交互 · **严重度**：P1
- **问题**：「主动搭话与好感」页里，开关和滑块拨了就生效，旁边的数字框却要各自点一次「保存」（这一页 4 个保存按钮）。改了数字没点保存，就去点 rail 或面包屑，草稿会悄悄丢掉：没有页级的未保存提示，也没有离开提醒。截图：`screenshots/interject-proactive-full-light.png`、`screenshots/pages-tts-full-light.png`。
- **习惯依据**：G-3；U-2。
- **design.lobe.li**：P-05「开关看起来已生效其实要另点保存」「未保存修改可见」<https://design.lobe.li/rules/P-05>；P-04「长表单或整页编辑有离开提醒 / 草稿」<https://design.lobe.li/rules/P-04>。
- **方向**：数字类改成失焦或回车即时保存（和开关一致），或者页面底部放统一的保存栏，并在离开前提醒。

#### FORM-02 · 每个字段都挂「默认：xx」标签，再加行尾和页头的恢复按钮，三层重置

- **模块 · 文件**：SettingsForm/fields · `fields.tsx:645`（`默认：{formatValue}` Tag）、`:108-125`（行尾 `ResetButton`）、`:655`（「敏感 · 遮罩显示」）；`SettingsForm.tsx:73`（页头「恢复本页默认」）
- **类别**：IA · **严重度**：P1
- **问题**：每一行下面都有一个灰色的「默认：开」标签（桌宠行为页、朗读页每一行都有），Key 字段又多一个「敏感 · 遮罩显示」，和输入框旁的「已设置 / 未设置」标签并列。说明文字被标签压住，扫读时先看到的是噪音。截图：`screenshots/settingsform-behavior-light.png`、`screenshots/settingsform-behavior-bottom-light.png`、`screenshots/pages-tts-full-light.png`。
- **习惯依据**：U-2（靠扫读找到要改的那一项）。
- **design.lobe.li**：C-17「设置项的状态由值本身表达……再挂一个复述它的 badge 只是噪音」<https://design.lobe.li/rules/C-17>；W-07 <https://design.lobe.li/rules/W-07>。
- **方向**：默认值只在和当前值不同时显示，放进恢复默认按钮的提示里；去掉「敏感」标签。

#### FORM-03 · 每次即时保存都弹一条 toast，连调几项就叠成一串

- **模块 · 文件**：SettingsForm/fields · `fields.tsx:105-106`（`savedToast`）、`:147`（每次 `commit` 成功都调用）
- **类别**：交互 · **严重度**：P1
- **问题**：拨 3 个开关、拖一下滑块，会出现 4 条「已保存：xx → 开」；而控件本身已经显示了新值。真正需要注意的提示（「重启后生效」、保存失败）被淹没在里面。证据：代码引用加 `screenshots/settingsform-behavior-light.png`（这一页全是即时保存的开关和滑块）。
- **习惯依据**：G-3（开关拨了就是生效了）。
- **design.lobe.li**：C-17 <https://design.lobe.li/rules/C-17>；K-05「toast 用稳定的 id 原地刷新」<https://design.lobe.li/rules/K-05>；Nielsen #8 美观极简 <https://design.lobe.li/models/M-03>。
- **方向**：成功时不弹 toast（控件上短暂显示已保存），只为失败和需要重启的项给提示。

#### FORM-04 · 几个写操作不看结果就报成功；本机能力未唤醒时没有出路

- **模块 · 文件**：SettingsForm/fields · `fields.tsx:487-491`（`TokenControl`：`newApiToken()` 后无条件 `toast.success('已换成新的令牌')`）、`:550`（`AdultControl`：`r` 为空时也报成功）、`:565`（`LocalControl`：只有灰字「唤醒桌宠后可用」）
- **类别**：交互 · **严重度**：P2
- **问题**：换令牌会让旧令牌立即失效（确认文案也这么写），失败时却仍然提示「已换成新的令牌」，用户会去改脚本。本机能力没唤醒时，只有一行灰字。证据：代码引用；`screenshots/pages-api-light.png`、`screenshots/pages-connection-light.png`。
- **习惯依据**：G-4；T-6。
- **design.lobe.li**：W-05 <https://design.lobe.li/rules/W-05>；C-15 <https://design.lobe.li/rules/C-15>；Nielsen #9 <https://design.lobe.li/models/M-03>。
- **方向**：所有写操作都按 `ok` 分支反馈；不可用的项说明原因并给出唤醒入口。

#### FORM-05 · 字段级「恢复默认」不确认、不能撤销，页级「恢复本页默认」却要确认

- **模块 · 文件**：SettingsForm/fields · `fields.tsx:108-125`（点一下就保存）vs `SettingsForm.tsx:66-90`（`ask` 确认，列出前后值）
- **类别**：交互 · **严重度**：P2
- **问题**：同一个「恢复默认」动作有两种强度。字段级的按钮是行尾一个 16px 图标，误点之后原值就没了（比如自定义端点），也没有撤销。截图：`screenshots/settingsform-behavior-light.png`。
- **习惯依据**：U-2；G-1。
- **design.lobe.li**：W-07「确认框保护的是可撤回的操作 → 改为执行后提供撤销」<https://design.lobe.li/rules/W-07>；Nielsen #3、#4 <https://design.lobe.li/models/M-03>。
- **方向**：字段级恢复后，toast 里给「撤销」；页级恢复也可以改成执行后撤销。

#### FORM-06 · 声音相关的开关分在两个入口：「静音」在朗读页，「点击音效」在桌宠行为页

- **模块 · 文件**：SettingsForm/fields · schema 字段分页（`settings-schema.js`：`page: 'tts'` 的静音，`page: 'behavior'` 的点击音效）
- **类别**：IA · **严重度**：P2
- **问题**：「静音」说明里写「朗读、互动语音和点击音效都停下」，却放在朗读页第一项；「点击音效」本身在 玩法 → 桌宠行为。想让她安静一点，得去两个入口。截图：`screenshots/pages-tts-full-light.png`（顶部）、`screenshots/settingsform-behavior-bottom-light.png`（点击音效）。
- **习惯依据**：T-3、T-4；G-1。
- **design.lobe.li**：P-05「按影响范围分组」<https://design.lobe.li/rules/P-05>；M-02 <https://design.lobe.li/models/M-02>。
- **方向**：声音类开关集中到一组（静音 → 朗读 / 互动语音 / 音效）。

### 3.11 stage 组件

#### STG-01 · 舞台下面的「动作」和「桌面上的她 → 动作」同名，作用域却不同

- **模块 · 文件**：stage · `admin/src/console/stage/CharacterStage.tsx:241-262`（`data-action-chip`，只在设置窗口的舞台上播放）；`pages/Together.tsx:194-228`（`CUES` → `api().cue()`，让桌宠真的做动作）
- **类别**：IA · **严重度**：P2
- **问题**：首页和详情页的舞台下有 12 个「动作」chip，点了只在设置窗口里预览，桌面上的她不动；「桌面上的她」页也有一排「动作」按钮，点了是她在桌面上做，两组动作的名字和数量也不一致。并列的 12 个选项超过了 7 个的建议上限。截图：`screenshots/home-light.png`（舞台下的「动作」）、`screenshots/together-desk-light.png`。
- **习惯依据**：U-4；G-1。
- **design.lobe.li**：W-03 <https://design.lobe.li/rules/W-03>；M-08「并列选项 > 7 个 → 先分组或收进选择器」<https://design.lobe.li/models/M-08>；Nielsen #4 <https://design.lobe.li/models/M-03>。
- **方向**：合成一组：舞台上预览，加一个「让桌面上的她也做」的开关或按钮，显示常用的几个，其余收起。

#### STG-02 · 「点她」这个签名交互，只靠一行 12px 灰字提示

- **模块 · 文件**：stage · `CharacterStage.tsx:223`（整个舞台是一个 `<button>`，没有悬停提示）、`:212`（当前角色会同时让桌宠播放「开心」）；`Home.tsx:163`（只有首页有这行说明）
- **类别**：交互 · **严重度**：P2
- **问题**：舞台没有 hover 态、光标或提示气泡，角色详情页也没有说明文字。点了会让桌面上的她同时反应，这一点也只有首页那行小字提到。截图：`screenshots/home-light.png`、`screenshots/character-detail-tab-装扮.png`。
- **习惯依据**：U-4（游戏化的签名动作要能被发现）。
- **design.lobe.li**：M-06「缺提示 P：用户根本没看到入口」<https://design.lobe.li/models/M-06>；Nielsen #1 <https://design.lobe.li/models/M-03>。
- **方向**：舞台加 hover 态和提示气泡（「摸摸她」），第一次点击后显示一次说明。

#### STG-03 · 「没遇见」在不同页面有不同的画法，剪影加锁重复表达

- **模块 · 文件**：stage · `SpriteStage.tsx:217`（`silhouette` 滤镜）、`HeartMeter.tsx:80-90`（没遇见时显示锁 +「还没遇见她」）；`Characters.tsx:334-341`（剪影上再叠锁和「未遇见」）
- **类别**：IA · **严重度**：P2
- **问题**：图鉴卡片同时有剪影、锁图标、「未遇见」、HeartMeter 的「还没遇见她」、「初次见面」按钮，五处在说同一件事；聊天侧栏是灰色小剪影加「还没见过面」，商店却是彩色（见 STORE-02）。截图：`screenshots/characters-list-light.png`、`screenshots/chat-light.png`。
- **习惯依据**：G-1。
- **design.lobe.li**：W-03 <https://design.lobe.li/rules/W-03>；W-07（同一个数 / 状态重复出现）<https://design.lobe.li/rules/W-07>；M-02 <https://design.lobe.li/models/M-02>。
- **方向**：只用一种「未遇见」表达（剪影 + 一个标签），其余去掉。

## 4. 主要问题模块与后续落地分配

按影响和问题的集中程度，合成 5 个落地包。每个包都能直接作为交付物 3 的一个落地任务；前 3 个是**主要问题模块**。

| 优先级 | 落地包（建议的任务名） | 主要涉及的文件 | 问题编号 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | **对象模型与导航重构**：角色 / 形象 / 角色包口径统一，聊天与聊天记录合并，rail 重排，路由兜底 | `settings-schema.js`（RAIL / NAV / PAGES）、`Shell.tsx`、`ConsoleApp.tsx`、`Characters.tsx`（图鉴、PacksPage）、`Chat.tsx`、`Together.tsx`（History）、`Store.tsx` | SH-01、SH-02、SH-03、SH-04、SH-05、CHAR-01、CHAR-08、CHAT-01、CHAT-02、CHAT-03、STORE-02、STG-03、TOG-02、HUB-03 | 影响 T-1、T-5 和所有入口；P1 最多。必须先做，其他包的入口都依赖它 |
| 2 | **设置表单的保存与反馈**：统一保存方式、离开提醒、减少 toast 和标签噪音，写操作按结果反馈 | `fields.tsx`、`SettingsForm.tsx`、`Pages.tsx`（release、清缓存、更新）、`Interject.tsx`（清空）、`Together.tsx`（聊聊） | **PG-03（P0）**、FORM-01、FORM-02、FORM-03、FORM-04、FORM-05、PG-04、INT-04、TOG-03 | 唯一的 P0 在这里；影响所有设置页（T-3、T-4、T-6） |
| 3 | **设置分组与高风险分区**：按影响范围重分组，高风险集中，按引擎渐进展开，拆分「主动搭话与好感」 | `settings-schema.js`（NAV / FIELDS 的 page / card）、`Hub.tsx`、`Pages.tsx`（Tts / Connection / About / Appearance）、`Interject.tsx` | HUB-01、HUB-02、PG-01、PG-02、PG-05、PG-06、PG-07、INT-01、INT-02、TOG-04、SH-06、FORM-06、CHAR-05 | 影响 T-3、T-4、T-6 和 U-3 |
| 4 | **小屋与角色详情的层级**：首页按钮直达、详情标签进 URL、好感去重、舞台交互可发现 | `Home.tsx`、`Characters.tsx`（CharacterDetailPage、图鉴卡片）、`stage/CharacterStage.tsx` | HOME-01、HOME-02、HOME-03、CHAR-02、CHAR-03、CHAR-04、CHAR-06、CHAR-07、STG-01、STG-02 | 影响 T-1、T-2 和 U-4 |
| 5 | **列表与页面的状态补齐**：失败 ≠ 空、未唤醒空态带动作、单标签和筛选进 URL | `Interject.tsx`、`Together.tsx`、`Home.tsx`、`Store.tsx`、`Pages.tsx`（语音包）、`Hub.tsx`、`Chat.tsx` | INT-03、TOG-01、TOG-05、HOME-04、STORE-01、STORE-03、PG-08、HUB-04、CHAT-04 | 交给 70-detail 逐项加固 |

各模块的问题数：Characters 8、Pages 8、SettingsForm/fields 6、Shell 6、Together 5、Home 4、Hub 4、Chat 4、Interject 4、Store 3、stage 3，合计 55。

## 5. 自动化扫描（前置信息，不计入问题）

```
$ node .agents/skills/lobe-design/scripts/lint-lobe.mjs admin/src/console
LOBE-DESIGN · LINT   19 file(s)   platform=desktop（product.md）
WARN
  [LOBE-MULTI-PRIMARY] admin/src/console/pages/Characters.tsx:513  3 个 primary
  [LOBE-MULTI-PRIMARY] admin/src/console/pages/Pages.tsx:362  2 个 primary
RESULT: 0 FAIL, 2 WARN

$ node .agents/skills/lobe-design/scripts/check-detail.mjs admin/src/console
LOBE-DESIGN · DETAIL   17 file(s)
  DETAIL-NO-EMPTY × 10、DETAIL-DANGER-NO-CONFIRM × 4、DETAIL-DISABLED-NO-REASON × 1、DETAIL-NO-PENDING × 1、DETAIL-NO-RETRY × 1
RESULT: 0 FAIL, 17 WARN
```

核对过：`Pages.tsx:362` 的两个 primary 互斥出现（`ready` / `manual`），是误报。`Characters.tsx` 的 3 个 primary 分属不同标签页和提示条，同一屏最多同时出现 1～2 个，不单列。`DETAIL-DANGER-NO-CONFIRM` 命中的几处实际都走了 `ask()` 确认；真正的缺陷是确认之后「不看结果就报成功」（PG-03、INT-04、FORM-04）。`DETAIL-NO-EMPTY` 里真正成立的，已经并入 INT-03、TOG-01、PG-08。

## 6. 80-review 结论（audit 模式）

- **截图覆盖**：§2 列出的每个路由都在真实运行（fake-lh、唤醒格萝可）下打开过。缺失的只有三个状态，都已在条目里标明「代码引用」：未唤醒态（HOME-04、TOG-05）、读取失败态（INT-03、TOG-01）、写入失败态（PG-03、FORM-04、INT-04）。
- **阻断项**：「主路径断裂」1 条：PG-03，不可逆操作失败时仍报成功，属于「控件与状态脱节」。「控件与状态脱节」倾向：INT-03 / TOG-01，失败被画成空。
- **回流**（≤ 3 条，按影响排序）：① 对象模型与导航（落地包 1）→ 40-flow；② 保存与反馈（落地包 2）→ 70-detail / C-15；③ 设置分组（落地包 3）→ 40-flow / P-05。
- **视觉约束**：所有条目都只涉及结构、流程和文案口径，不要求改动配色、字体或视觉基调。落地时继续用现有的 `cssVar`、`--pet-accent`，以及 `@lobehub/ui` 的 `Form`、`Surface`、`PageHeader`、`Empty`、`confirmModal`。
