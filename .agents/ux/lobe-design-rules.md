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
