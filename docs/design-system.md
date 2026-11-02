# 设计系统（lobe-design · `@lobehub/ui`）

> 配置后台（设置窗口）的视觉与组件基础。方案见 [admin-console-design.md](admin-console-design.md) §4（选型 B：Vite + React 19 + `@lobehub/ui`）。
> 本文是 T1（lobe-design 初始化）+ 设计系统落地的说明；后台窗口挂载（`admin-window.js`、preload、广播）和各设置页不在本期范围内。

## 1. lobe-design 初始化（可追溯到技能仓库流程）

按 [lobehub/lobe-design-skill](https://github.com/lobehub/lobe-design-skill) `@04604bf`（skill 5.9.0）的 `stages/05-init.md` 执行：

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 安装 | `./install.sh --dir <repo>/.agents/skills --copy`（在技能仓库根目录执行） | `.agents/skills/lobe-design/`（5.9.0）；`.claude/skills` 已是指向 `.agents/skills` 的链接 |
| A. 托管块 | `node .agents/skills/lobe-design/scripts/bootstrap.mjs --print --root .` → 去掉 `--print` 写入 | `AGENTS.md` 末尾追加 `<!-- lobe-design:begin … -->` 块（精简 · en），块外零改动；`CLAUDE.md` 是它的软链接 |
| B. Round 1 | `node …/project-scan.mjs --root .` → 写 [`.agents/ux/product.md`](../.agents/ux/product.md) | `平台：desktop`、`copy-profile: consumer`、适用性表、桌宠窗口 `lint-allow`（理由已写） |
| C. Round 2 | 写 [`.agents/ux/components.md`](../.agents/ux/components.md)、[`.agents/ux/lobe-design-rules.md`](../.agents/ux/lobe-design-rules.md) | 原子层 / 薄包装 / 重复 / 业务组件；项目规则 R-01..R-03 |
| 校验 | `bootstrap.mjs --check`、`project-scan.mjs --check`、再跑一次 `bootstrap.mjs` | `OK` / `OK 项目层齐全` / `托管块 unchanged`（幂等） |
| lint | `npm run lint:design`（= `lint-lobe.mjs admin/src`）· `lint-lobe.mjs src/renderer` | 后台 0 FAIL 0 WARN（不豁免任何规则）；桌宠窗口 0 FAIL（`lint-allow` 生效后） |

`test/design-system.test.js` 在 `npm test` 里重跑这两个 `--check` 和 lint，项目层过期或后台出现 FAIL 时测试失败。

## 2. 目录与构建链

```
admin/                       后台源码（TS + React 19 + @lobehub/ui），不进安装包
  index.html                 CSP：default-src 'self'（离线，不连外网）
  vite.config.mjs            base './'，输出到 ../src/admin-ui/
  src/design/                设计系统：tokens.ts · theme.ts · DesignProvider.tsx
  src/preview/               设计系统预览页（#/design/*）
src/admin-ui/                构建产物（.gitignore），被 build.files 的 src/**/* 打进 app.asar
src/renderer/design/         令牌导出（提交入库）：lobe-tokens.css · tokens.json
scripts/build-design-tokens.mjs   从 @lobehub/ui/theme.css 生成上面两份；--check 校验同步
scripts/design-preview.js    Electron 预览窗口；--shots=<dir> 亮 / 暗全页截图
```

| npm script | 作用 |
| --- | --- |
| `build:admin` | `vite build`，产物到 `src/admin-ui/` |
| `prestart` / `prestart:no-sandbox` / `predist:mac` / `predist:win` / `predist:linux` | npm 自动先跑 `build:admin`，所以 `npm start` 和 `release.yml` 的 `npm run dist:*` 不用改 |
| `dev:admin` | Vite 开发服务器 |
| `typecheck:admin` | `tsc -p admin` |
| `design:tokens` | 重新导出 `src/renderer/design/*` |
| `design:preview` | 构建并打开预览窗口 |
| `lint:design` | lobe-design lint（后台源码） |

React、`@lobehub/ui` 等全部在 devDependencies，打包时已进 bundle：安装包的 `node_modules` 不变（运行时依赖仍只有 `electron-updater`）。CI：`release.yml` 用 `npm run dist:*`，`predist:*` 会自动构建后台，工作流不用改。建议（需要有 `workflow` 权限的人提交）：`test.yml` 在 `npm test` 后加 `npm run typecheck:admin` 与 `npm run build:admin`；`update-e2e.yml` 直接调用 `npx electron-builder`，在它之前加一步 `npm run build:admin`（后台窗口接入主进程之前不影响运行）。

## 3. 设计令牌

唯一事实源是 `@lobehub/ui` 的 `cssVar`（lobe-design D-01），亮 / 暗两套值都在 `theme.css` 的 `[data-theme='light'|'dark']` 里，组件样式不按明暗分支（D-08）。`admin/src/design/tokens.ts` 只做一件事：**按角色**列出后台要用的 token（D-02），页面按角色取，不按颜色取。

| 类别 | token（`cssVar.*`） | 亮 / 暗示例 |
| --- | --- | --- |
| 表面 | `colorBgLayout` `colorBgContainer` `colorBgContainerSecondary` `colorBgElevated` `colorBgMask` | 窗口底色 `#f8f8f8` / `#000000` |
| 文字 | `colorText` `colorTextSecondary` `colorTextTertiary` `colorTextQuaternary` `colorTextDescription` | `#1f1f1f` / `#e6e6e6` |
| 边框填充 | `colorBorder` `colorBorderSecondary` `colorFill`…`colorFillQuaternary` | |
| 品牌状态 | `colorPrimary(Hover)` `colorSuccess` `colorWarning` `colorError` `colorInfo` `colorLink` | 主色 `#222222` / `#eeeeee`（LobeHub 默认中性主色） |
| 字体 | `fontFamily`（西文 → 中文 → 回退 → emoji）、`fontFamilyCode` | 不在组件里写 `font-family` |
| 字号 | `fontSizeHeading2` 30 · `fontSizeHeading4` 20 · `fontSizeLG` 16 · `fontSize` 14 · `fontSizeSM` 12（配套 `lineHeight*`） | |
| 间距 | 项目档位 `space`：2 / 4 / 8 / 12 / 16 / 24 / 32（= Flexbox gap 预设），主题 `padding*` 4…32 | 4 px 网格 |
| 圆角 | `borderRadiusXS` 4 · `SM` 6 · `borderRadius` 8 · `LG` 12 | 嵌套：内层 = 外层 − 内边距 |
| 阴影 | `boxShadowTertiary` · `boxShadow` · `boxShadowSecondary` | 不做彩色光晕 |
| 动效 | `motionDurationFast` .1s · `Mid` .2s · `Slow` .3s · `motionEaseOut` · `motionEaseInOut` | 不用弹跳；尊重「减少动态效果」 |
| 控件高度 | `controlHeightSM` 27 · `controlHeight` 36 · `controlHeightLG` 45 | |

**明暗**：`initAppearance()` 用 `setLobeTheme({ appearance })` 写 `<html data-theme>`，跟随 `prefers-color-scheme`（Electron 把 `nativeTheme` 转发过来），`?theme=light|dark` 可固定。方案文档里写的 `ThemeProvider` 在 `@lobehub/ui` 6.x 已移除，这里按 v6 的写法实现。

**桌宠窗口可用的导出**：`src/renderer/design/lobe-tokens.css` 是同一批 58 个 token 的纯 CSS 版（亮色 + 暗色 + `prefers-color-scheme` 兜底，外加 `--pet-space-*`），`tokens.json` 是数据版。两者都在 `build.files` 范围内。桌宠窗口本期**不引用**它（像素风格是否换成 LobeHub 风格由主人确认，见方案 T8）。

## 4. 基础组件

原子组件全部取自 `@lobehub/ui`，不在项目里重写（C-01）。选用规则见 [`.agents/ux/components.md`](../.agents/ux/components.md)。

| 需求 | 组件 |
| --- | --- |
| 按钮 | `Button`（`type="primary"` 每屏一个，`danger`，`loading`，三档尺寸） |
| 输入框 | `Input`、`InputPassword`（Key 只写不显示） |
| 开关 / 滑块 / 下拉 / 分段 | `Switch`、`Slider`、`Select`、`Segmented` |
| 卡片 | `Surface`（dashboard）、`Block`（filled / outlined / borderless） |
| 标签 | `Tag`（状态色 + 预设色阶） |
| 表单项与分组 | `Form` + `useForm`（`@lobehub/ui/form`），`itemsType="group"` `variant="filled"`，与 LobeHub 设置页一致 |
| 分组导航 | `ConsoleShell` + `ConsoleNav`（`@lobehub/ui/dashboard`），hash 路由 |
| Toast / 提示 | `toast.*`（`ToastHost`）、`Alert`、`Tooltip`、`confirmModal`（`ModalHost`） |

`DesignProvider` 是后台唯一的根：`ConfigProvider`（`motion`、zh-CN 资源、`enableCustomFonts={false}`）+ `ModalHost` + `ToastHost`。关闭自定义字体的原因：默认会从 npmmirror 拉 Geist / HarmonyOS / KaTeX 样式，在 CSP 下被拦并报 10 条控制台错误（项目规则 R-01）。

## 5. 预览页

```bash
npm run design:preview                                   # 打开预览窗口（跟随系统明暗）
electron scripts/design-preview.js --theme=dark --page=/design/form
electron scripts/design-preview.js --shots=out/design    # 8 页 × 亮 / 暗 截图 + preview-report.json
xvfb-run -a node e2e/run.js design                       # e2e：导航、开关、下拉、表单、Toast、确认弹窗，亮 / 暗，零外网请求
```

8 页：颜色（亮 / 暗并排）· 字体与字号 · 间距 · 圆角 · 阴影 · 动效 · 按钮与输入 · 卡片 · 标签 · 提示 · 表单项与分组 · Toast 与确认。`--index=dist/linux-unpacked/resources/app.asar/src/admin-ui/index.html` 可以直接检查安装包里的那份。
