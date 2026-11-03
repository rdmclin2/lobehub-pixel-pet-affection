<!-- lobe-design-init: version=5.9.0 fingerprint=8ba711fd55db -->
# 产品画像（lobe-design 05-init · Round 1）

> 由 lobe-design 05-init 写入（skill 5.9.0）。事实来源：`project-scan.mjs --root .`、README、`docs/admin-console-design.md`。
> 升级 skill 或仓库结构大变（`project-scan.mjs --check` 报指纹过期）后重跑两轮，整份更新本文件。

平台：desktop

- Electron 桌面应用，两类界面：
  - **桌宠窗口**（`src/renderer/`，原生 JS）：围绕角色的界面（对话气泡、状态 / 好感度、工具栏、聊天输入框、⋯ 菜单、Toast、`#panel` 弹层、18+ 确认与选角页）用 `src/renderer/design/lobe-tokens.css` 的 `--lobe-*` 令牌，与配置后台同一套颜色 / 字体 / 圆角 / 阴影 / 动效，亮 / 暗跟随系统；角色本身（像素 / 图片 / rig / Live2D / VRM、爱心与触摸特效）是美术，不属于产品界面视觉体系。
  - **设置窗口 / 配置后台**（`admin/` → 构建到 `src/admin-ui/`，Vite + React 19 + `@lobehub/ui`）：产品界面，完全按 lobe-design 的 web/desktop 规则检查。
- 渲染进程无 Node（`sandbox` + `contextIsolation`），离线运行，CSP 禁止外网（不加载远程字体 / emoji CDN）。

## 产品类型

面向个人的桌面陪伴应用（LobeHub agent 驱动的像素桌宠，成人向 18+ 版本）。配置后台是它的「设置与管理」窗口，**不是**多人使用的 SaaS 后台。

2026-11-02 负责人反馈后定调（第二版）：设置窗口是**陪伴向**的——她（当前角色）是每页的主角，偏游戏化地呈现角色、关系和互动（舞台、图鉴、衣柜、好感路线图），LobeHub 设计语言做底；信息架构有纵深，侧栏只放四个入口（见 `docs/admin-console-design.md` §11、规则 R-05；例外：聊天、商店）。

## 用户

- 单个主人，本机使用，中文为主。
- 使用频率低（偶尔调一次），但单次改动代价高：API Key、成人向内容开关、本机能力（文件、麦克风）。
- 没有权限分级；高风险项靠确认与分区，而不是角色权限。

## 核心任务

1. 切换 / 结识角色，查看角色列表（好感、外观、类型）
2. 给角色选模型、外观和个性化设定
3. 配置朗读（TTS）与语音输入（ASR）引擎：Key 与端点
4. 调整桌宠行为（漫步、主动搭话、大小）
5. 导入 / 删除角色包与语音包
6. 开关对外接口与成人向内容、检查更新

## 适用性

| 条目 | 结论 | 说明 |
| --- | --- | --- |
| P-05 配置 / 设置 | 强调 | 后台主体。按影响范围分组；开关只给即时生效的二值项；需保存的项用表单 + 保存；高风险项单独一区 |
| P-02 列表 / 搜索 / 筛选 | 强调 | 角色列表、角色包、语音包 |
| P-03 详情 / 对象页 | 强调 | 角色详情（模型、外观、设定、好感） |
| P-01 总览看板 | 轻量 | 「小屋」：她的舞台 + 关系 + 今天的开关，不做指标墙 |
| C-01 原子组件取自 `@lobehub/ui` | 强调 | 后台不自建 Button / Select / Switch / Modal；表单从 `@lobehub/ui/form` 取 |
| D-01 / D-08 cssVar 与暗色 | 强调 | 主题跟随系统（Electron `nativeTheme` → `prefers-color-scheme` → `data-theme`），样式不分支 |
| P-06 审批队列、P-07 监控日志、P-08 计费对账、P-09 评测对比 | 不适用 | 单用户本机应用，没有这些业务 |

copy-profile: consumer

- 人称用「你」，沿用桌宠现有界面口径；术语以 README 与 `docs/admin-console-design.md` §2 的设置项名称为准（朗读、语音输入、角色包、语音包、好感）。

## lint 放行（项目层，按路径）

桌宠窗口的界面部分已改用 `--lobe-*` 令牌（规则 R-04）；仍需放行的是角色美术本身：角色特效的裸色值（爱心、闪光、得分、触摸标记、腮红）、角色弹跳 / 摇摆动效、特效 emoji，以及原生 CSS 必须写的 `font-family: var(--lobe-font-family)`。它们不纳入产品界面的视觉体系（理由按 I-10 写明；原则层的可达性要求不放行）。去掉放行后 `src/renderer/style.css` 剩余的 FAIL 都属于这一类。第三方压缩代码同样放行。配置后台 `admin/**` 不放行任何规则。

lint-allow: LOBE-FONT-FAMILY LOBE-RAW-COLOR LOBE-SPACING-OFFGRID LOBE-LETTER-SPACING LOBE-MOTION-DURATION LOBE-BOUNCE LOBE-GLOW LOBE-EMOJI-ICON LOBE-NULLISH-RENDER src/renderer/**
lint-allow: LOBE-SPACING-OFFGRID LOBE-NULLISH-RENDER src/renderer/vendor/**

设置窗口里的角色舞台（`admin/src/console/stage/**`）同属角色美术：爱心飘起（1.4s）和她的光晕漂移（9s，`prefers-reduced-motion` 下停止）是角色的表演，不是界面反馈动效，放行时长检查；界面部分（按钮、卡片悬停）仍按 ≤ 300ms。

lint-allow: LOBE-MOTION-DURATION admin/src/console/stage/**

主进程创建窗口时的 `backgroundColor`（`src/main/main.js`：透明窗口 `#00000000`、e2e 截图用的不透明底色）在页面 CSS 加载之前生效，只能写字面色值，引用不了 `--lobe-*` 令牌；它不是界面样式（2026-11-03，T-2801 跑 lint 时发现的存量项）。

lint-allow: LOBE-RAW-COLOR src/main/main.js
