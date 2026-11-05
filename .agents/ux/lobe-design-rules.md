# 项目层规则（lobe-design-rules）

> 宿主项目的规则文件（I-03）。续编号，删除的编号不复用。不改已安装的 skill。

## R-01 后台窗口离线：不加载远程字体

- 判据：`ConfigProvider` 未设 `enableCustomFonts={false}`，或渲染了 `FontLoader` / CDN 模式的 `FluentEmoji`。
- 原因：设置窗口在 Electron `file://` 下运行，CSP 是 `default-src 'self'`；默认的 `ConfigProvider` 会从 npmmirror 拉 Geist / HarmonyOS / KaTeX 的 CSS，被 CSP 拦下并在控制台报错（2026-11-02 预览页实测 10 条）。
- 层级：lint 候选（可机械识别）；目前由 `scripts/design-preview.js --shots` 的「零外网请求、零控制台错误」检查兜底。

## R-02 颜色 / 尺寸先查 `admin/src/design/tokens.ts`

- 判据：页面里出现 `tokens.ts` 角色表之外的 `cssVar.color*`，先确认是否该补进角色表。
- 原因：tokens.ts 同时生成 `src/renderer/design/lobe-tokens.css`（`npm run design:tokens`），角色表是两边共用的名单。

## R-03 `confirmModal` 必须同时传 `okText` 与 `cancelText`

- 判据：调用 `confirmModal({...})` 时缺 `okText` 或 `cancelText`。
- 原因：`@lobehub/ui@6.10.2` 的 `ConfirmBody` 把默认值写死成英文 `"OK"` / `"Cancel"`，不走 `ConfigProvider` 的 zh-CN 资源（2026-11-02 预览页实测）。`okText` 写「动词 + 对象」（W-01）。
- 层级：lint 候选（可机械识别）；通用性待确认后回流 lobe-ui。

## R-04 桌宠窗口界面只用 `--lobe-*` 令牌，裸色值只留给角色美术

- 判据：`src/renderer/style.css` 里气泡、HUD、按钮、输入框、菜单、Toast、`#panel` 等界面选择器出现裸色值、`Courier New` / 等宽正文字体、3px 描边或硬投影；或在 `src/renderer/*.js` 里给界面写死颜色（`barColor` 用 `var(--lobe-color-*)`）。
- 原因：桌宠窗口与配置后台要是同一套 LobeHub 视觉（颜色 / 字体 / 圆角 / 阴影 / 动效，亮暗跟随系统）；令牌由 `npm run design:tokens` 生成到 `src/renderer/design/lobe-tokens.css`，项目自有值用 `--pet-*`（不重定义 `--lobe-*`）。角色本身（精灵、爱心、闪光、触摸标记）仍按 `product.md` 的 `lint-allow` 放行。
- 图标：用内联 lucide 路径 `<svg class="ico">`（`pointer-events: none`，否则工具栏按 `e.target.dataset` 取动作会失效），不用 emoji 当图标。
- 层级：项目层；`lint-lobe.mjs` 去掉放行后，`style.css` 剩下的 FAIL 应全部是角色美术（2026-11-02：156 → 20）。

## R-05 设置窗口有纵深、以她为主角，不平铺成后台

- 判据：侧栏 / rail 上的入口超过 4 个，或把某个页面直接挂到侧栏而不是放进 小屋 / 角色 / 玩法 / 设置 的下一层；角色相关页面用表格行代替会动的立绘卡片；一页出现多个可点的角色舞台（签名动作只有一个）。
- 原因：负责人 2026-11-02 反馈第一版「所有菜单都在左侧边栏」「太像后台」。桌宠是感性场景：要能看到角色和她的互动（舞台、图鉴、试穿、好感路线图），而配置项在下一层照常用 LobeHub 的 `Form`。
- 做法：rail = `RAIL`（`core/settings-schema.js`）；新页面先决定挂在哪个入口下，加进 `NAV` 对应 `section` 的组；角色画面用 `console/stage/` 的组件。
- 层级：项目层；e2e `admin` 的 A3 断言 rail 只有 6 个链接（4 + 商店 + 聊天）、A3b 走一遍层级。
- 例外（2026-11-03，T-2765）：「聊天」是第五个 rail 入口。理由：负责人的目标明确要求「左侧栏新增可进入的聊天窗口入口」；聊天是高频的独立任务（与 LobeHub 一样一级可达），不是设置项，放进 玩法 / 设置 的下一层会让每天用的功能藏两层。其它新页面仍按上面的做法挂到四个入口下面。聊天页铺满主区域（`Shell` 对 `chat` 不加页宽与内边距），自己的会话栏和消息区各自滚动。
- 例外（2026-11-03，可下载角色）：「商店」是第六个 rail 入口，在「角色」之后。理由：负责人明确要求「需要一个商店，而不是混在角色页面中」，并且以后要上声音包等其它内容——它不属于 角色 / 玩法 / 设置 任何一个，挂到其中一个下面就又混进去了。商店页内按类别分标签页（`admin/src/console/pages/Store.tsx`），新类别加标签页，不再加 rail 入口。除 聊天、商店 外不再加例外。

## R-06 引导 / 授权类页面照 LobeHub Desktop 的 onboarding 做

- 判据：桌宠窗口里的引导步骤（选角色之后的授权等）用居中标题 + 一堆分组卡片 + 状态 Tag 堆出来，而不是 LobeHub Desktop onboarding 的版式。
- 原因：负责人 2026-11-05 看了第一版授权页（T-5075）说「太丑了，参考 LobeHub Cloud Desktop 的 onboarding 页面设计」。参照物是 lobehub `src/features/DesktopOnboarding`（`steps/PermissionsStep.tsx`、`Layout`、`components/OnboardingFooterActions.tsx`）。
- 做法：左对齐头部（Logo 位置放她的立绘）+ 一句说明；一个描边列表，行 = 40px 描边图标框 + 标题 + 12px 次要说明 + 右侧小按钮（整行可点）；状态不用 Tag：已授权整行 `colorFillSecondary` + 绿色对勾，等待时转圈 +「等待授权」，被拒绝时说明变红；底部吸底，左「返回」文字按钮、右「下一步」主按钮；内容最宽 560px。窗口不够高就给这一步加大窗口（`SIZES.perms`），不要让主要内容藏在滚动里。设置窗口里的同类列表用 `@lobehub/ui` 的 `Block` 画同样的行。
- 层级：项目层（桌宠窗口是原生 JS，按令牌手写）。
