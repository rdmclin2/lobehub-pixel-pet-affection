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
- 层级：项目层；e2e `admin` 的 A3 断言 rail 只有 4 个链接、A3b 走一遍层级。
