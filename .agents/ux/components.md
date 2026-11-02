<!-- lobe-design-init: version=5.9.0 fingerprint=8ba711fd55db -->
# 组件盘点（lobe-design 05-init · Round 2）

> 平台：desktop（web 规则集）。分类：薄包装 / 与 lobe-ui 重复 / 业务组件。只写「什么场景用哪个 + 注意点」，不写实现。
> `project-scan.mjs` 在本仓库没有发现常见的 `components/`、`features/` 目录；下表按 `admin/src/` 与 `src/renderer/` 人工复核。

## 原子层：一律从 `@lobehub/ui` 取

| 场景 | 用什么 | 注意 |
| --- | --- | --- |
| 窗口骨架、分组导航 | `ConsoleShell` + `ConsoleNav`（`@lobehub/ui/dashboard`） | 路由用 hash（`#/characters/claude`），`renderLink` 输出 `href="#…"` 的锚点 |
| 页面标题 | `PageHeader`（dashboard） | 每页一个；主操作放 `action` |
| 信息卡片 | `Surface`（dashboard）/ `Block` | 不手写边框 + 背景（D-06） |
| 设置表单 | `Form` + `useForm`（**`@lobehub/ui/form`**），`itemsType="group"` `variant="filled"` | 根入口的 `Form` 不带校验（`LOBE-FORM-ENTRY`）；开关字段写 `valueProp: 'checked'` |
| 按钮 / 输入 / 密钥 | `Button` · `Input` · `InputPassword` | 每屏一个 `type="primary"`；Key 只写不回显 |
| 开关 / 滑块 / 下拉 / 分段 | `Switch` · `Slider` · `Select` · `Segmented` | 开关只给即时生效的二值项 |
| 标签、状态 | `Tag`（`color="success|warning|error|processing"` 或预设色） | 角色包类型用预设色阶区分（D-05） |
| 提示 | `Alert` · `Tooltip` | 错误文案说清发生了什么 / 怎么办 |
| 操作反馈 | `toast.*`（全局 `ToastHost` 已挂在 `DesignProvider`） | 不另建通知组件 |
| 高风险确认 | `confirmModal`（`ModalHost` 已挂在 `DesignProvider`，没有它弹窗不会出现） | 危险按钮 `okButtonProps: { danger: true }`，按钮文案「动词 + 对象」 |
| 图标 | `lucide-react` + `Icon` | 不用 emoji 当图标 |

## 薄包装

| 组件 | 场景 | 注意 |
| --- | --- | --- |
| `DesignProvider`（`admin/src/design`） | 后台每个入口的根：`ConfigProvider`（`motion`、`locale="zh-CN"`、`enableCustomFonts={false}`）+ `ModalHost` + `ToastHost` | 优先用上游件；只在这里加全局 provider。关掉自定义字体是因为窗口离线且 CSP 禁止外网 |
| `initAppearance()`（`admin/src/design`） | 启动时把系统明暗写到 `<html data-theme>`（`setLobeTheme`），`?theme=` 可固定 | 样式不读它，只用 `cssVar`（D-08） |
| 设计令牌 `tokens.ts` | 给页面一个「按角色取 token」的名单（表面、文字、填充、状态、字阶、圆角、阴影、动效）和项目间距档位 `space` | 值永远是 `cssVar` 引用；项目自有值用数字或 `--pet-*`，不写 `--lobe-*` |

## 与 lobe-ui 重复

后台（`admin/`）目前没有。桌宠窗口 `src/renderer/` 是原生 JS，不能直接用 React 组件；它的手写控件按下表**对照 lobe-ui 的外观**用 `--lobe-*` 令牌重写（规则 R-04），不要在后台里复刻它们：

| 桌宠窗口控件（选择器） | 对照的 lobe-ui 外观 | 令牌 |
| --- | --- | --- |
| `.btn` / `.btn.primary` / `.icon-btn` | `Button` default / primary / 图标按钮 | `colorBgContainer` `colorBorder` `colorFillTertiary`（hover）`colorPrimary` `borderRadiusSM` `motionDurationMid` |
| `input` `select` `textarea` | `Input` / `Select` / `TextArea` filled | `colorBorder` `borderRadiusSM`，focus 用 `colorFillSecondary` 光圈 |
| `.bubble` `.bubble-tail` | 聊天气泡（`ChatItem` 的消息卡片） | `colorBgElevated` `borderRadiusLG` `boxShadowSecondary` |
| `.chat-row` | `ChatInputArea`：一张卡片里放附件、输入、麦克风、发送 | `colorBgElevated` `borderRadiusLG` `boxShadowSecondary`，发送 = primary |
| `.popup`（⋯ 菜单 / 喂食 / 动作） | `Dropdown` 菜单 | `colorBgElevated` `boxShadow` `borderRadiusLG`，危险项 `colorError` |
| `.unlock-toast` | `toast`（标题 + 正文 + 操作 + 关闭） | `colorBgElevated` `boxShadow` |
| `.bars` `.aff-row` `.meta` | 状态胶囊 + `Progress` 细条 | `colorFillSecondary` 轨道，`colorSuccess` / `colorWarning` / `colorError`（`app.js barColor`）；好感阶段色来自 `core/affection.js` |
| `.panel`、`.adv-section`、`.card`、`.topic`、`.pack-opt`、`.history-*` | 设置页 `Form` 分组卡片、列表项、`Tag` | `colorBgLayout` 页面底，`colorBgContainer` 卡片，`borderRadiusLG`，选中用 `colorPrimary` 描边 |
| `.zone-hint` / `.mic-status` | `Tooltip` | `colorText` 底 + `colorBgContainer` 字 |
| `.stop-btn` | danger `Button`（胶囊） | `colorError` |
| `.vrm-confirm` | `Modal`（遮罩 + 卡片） | `colorBgMask` `boxShadow` |
| 图标（⋯、×、📎、麦克风、状态图标） | `lucide-react` | 内联 lucide 路径 `<svg class="ico">`，`currentColor` 描边 |

验证：`xvfb-run -a node e2e/run.js petui`（亮 / 暗各 14 张截图，`out/e2e/petui/`）。

## 业务组件（后台页面开发时新增，按方案 §6 规划）

| 组件 | 场景 | 注意 |
| --- | --- | --- |
| CharacterRow | 角色列表中的一行：头像 / 首帧、名字、好感、外观类型 | 列表走 P-02；点击进详情，不在行内塞编辑 |
| CharacterPreview | 角色详情顶部的预览（sprite 首帧、`pack://` 图片） | 图片必须有 `alt`；VRM / Live2D 只显示静态封面 |
| EngineCard | 朗读 / 语音输入引擎的一组配置（引擎、端点、Key、测试） | 用 `Form` 分组；连接状态用 `Tag` |
| KeyField | API Key 输入 | `InputPassword`，只写不显示已存值，显示「已设置」状态 |
| DangerZone | 删除角色包、清除数据、成人向开关 | 单独分区放页尾，操作走 `confirmModal` |

## 预览

设计系统预览页：`npm run design:preview`（`#/design/colors` … `#/design/feedback`，亮 / 暗各 8 页）。新增业务组件时先在预览页加一节，再进页面。
