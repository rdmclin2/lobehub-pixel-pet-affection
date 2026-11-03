# 设置窗口 IA 与交互打磨：整体验收报告（T-2824）

> 分支 `feat/admin-ia-polish` · 验收提交 `cb368eb` · 基线 `origin/canary`（merge-base `00252f9`）· 2026-11-03
> 依据：[`.agents/acceptance/PROJECT.md`](../../.agents/acceptance/PROJECT.md) §7 与 acceptance skill；六条检查项来自任务 T-2824 的合同。
> 交付物：[01-issues.md](01-issues.md)（问题清单）· [02-plan.md](02-plan.md)（优化方案）· [03-changes.md](03-changes.md)（落地改动）· 本报告。
> 证据（截图、日志、原始输出）已上传到 LobeHub 验收轮次，链接见 PR 描述；前后对比图在 [`screenshots/acceptance/`](screenshots/acceptance/)。

## 结论一览

| # | 检查项 | 结论 | 主要证据 |
| --- | --- | --- | --- |
| 1 | 01-issues.md 每条问题有模块、习惯依据、design.lobe.li 引用 | **通过** | 55 条问题逐条解析，缺字段 0 条 |
| 2 | 02-plan.md 有重构后 IA 与关键流程 | **通过** | §1 IA 前后对照（rail / 分组树 / 命名 / 页面结构），§3 F1～F10 十条流程 |
| 3 | 每个 P0/P1 在 03-changes.md 有落地改动或不做理由，且可追溯到 design.lobe.li | **通过** | 26 条 P0/P1 全部有改动行，且每行带 design.lobe.li 链接；55 行改动无一缺链接 |
| 4 | 视觉风格未变（前后截图 + diff 无 token / 主题 / 字体值改动） | **通过** | 12 个路由前后计算样式一致；diff 未改 token / 主题 / 字体值，新增硬编码颜色 0 处 |
| 5 | npm test、admin 构建、lint-lobe.mjs 全部通过 | **通过**（lint 有 2 条 WARN，0 FAIL） | 758 通过 / 0 失败 / 1 跳过；构建 EXIT=0；lint `0 FAIL, 2 WARN` |
| 6 | 真实应用中逐场景走查并截图 | **通过**（9 个场景实际执行，117/117 步通过；另有 4 个已退役场景自动跳过，不计入） | 各场景日志 + 18 张截图 |

没有未通过项。补充发现见文末「补充项」。

## 1. 01-issues.md 要素完整性 —— 通过

- 方法：脚本 `check-docs.js` 按 `#### <编号> · <标题>` 切出每条问题，检查 `**模块 · 文件**`、`**习惯依据**`、`**design.lobe.li**`（必须含 `https://design.lobe.li/` 链接）和 `严重度` 四个字段。
- 原始输出：

```
01-issues.md: 55 issues; P0=1 P1=25 P2=29
missing fields: none
```

- 习惯依据编号（U-1～U-4、T-1～T-6、G-1～G-4）在 01-issues.md §1（第 30～49 行）定义，出处为 `.agents/ux/product.md` 与 Nielsen（M-03）。
- 示例（01-issues.md 第 75～82 行，SH-01）：模块 · 文件 = `settings-schema.js:65`、`Characters.tsx:291` 等；习惯依据 = T-1、T-5、G-1、U-4；design.lobe.li = W-03 <https://design.lobe.li/rules/W-03>、M-03 <https://design.lobe.li/models/M-03>。

## 2. 02-plan.md 重构后 IA 与关键流程 —— 通过

- 重构后 IA：§1.1 一级导航前后对照（第 65 行起：小屋 / 角色 / 聊天 / 商店 ─ 分隔线 ─ 玩法 / 设置）、§1.2 分组与层级树状对照（第 80 行）、§1.3 命名对照（第 124 行）、§1.4 每页第一屏（第 149 行）。
- 关键流程：§3（第 184 行起）把任务要求的 (a)～(g) 展开为 F1～F10：切换 / 结识角色、选模型与外观、TTS / ASR Key、桌宠行为、角色包、语音包、对外接口 / 成人向 / 本机能力、检查更新、后台聊天、重置与放生。每条都写了现状路径、优化后路径和加载 / 空态 / 错误 / 保存 / 危险确认五种状态。
- 另有 §2 全局反馈规范、§4 问题 → 改动映射、§5 A / B / C 分包、§6 不动项。

## 3. P0/P1 落地与 design.lobe.li 可追溯 —— 通过

- 方法：脚本 `check-trace.js` 在 03-changes.md 的改动表格行里找每个 P0/P1 编号，并检查该行是否带 design.lobe.li 链接。
- 原始输出（节选）：

```
SH-01: change rows 2 (with design.lobe.li link 2) → A04,B08
SH-03: change rows 1 (with design.lobe.li link 1) → A02
CHAR-02: change rows 1 (with design.lobe.li link 1) → B02
INT-03: change rows 1 (with design.lobe.li link 1) → C07
PG-03: change rows 4 (with design.lobe.li link 1) → A16      ← 唯一 P0
FORM-01: change rows 1 (with design.lobe.li link 1) → A20
...（26 条全部 ≥ 1 行带链接）
change rows total 55; rows without design.lobe.li link: 0
```

- 26 条 P0/P1 全部有实际落地改动，没有「不做」的 P0/P1。部分未做的只有 P2：A-D4「导入语音包…」（PG-08，P2），03-changes.md A.2 写了理由（需要新的主进程 IPC，不影响 IA）；其他偏差（A-D1～A-D8、B.2、C.4）都写了理由。
- 唯一 P0（PG-03「放生 / 仅重置本地失败仍提示成功」）→ A16：`askAsync` 在弹窗内执行，失败写在弹窗里不关，成功才关并写实际结果；依据 C-15、W-05、K-05、P-05。真实应用中由 admin 场景 A16 步骤与 frontslim f16/f17 走过（见 §6）。

## 4. 视觉风格未变 —— 通过

- **diff 检查**（`git diff origin/canary...HEAD`）：
  - token / 主题 / 样式文件：只改了 `admin/src/design/DesignProvider.tsx`，内容是挂载 `<AskHost />`（askAsync 弹窗宿主）和注释，没有改主题、token、字体配置（`enableCustomFonts={false}`、`motion` 未动）。
  - `admin/src` 新增行里的硬编码颜色（`#xxxxxx` / `rgb()`）：**0 处**。
  - 字号：新增行只有 `fontSize={12}`（46 处）、`fontSize={28}`（1 处，角色详情标题，原来也是 28）、`cssVar.fontSizeSM`；删除行同样是 12 和 28。没有引入新的字号档。
  - 新增行里的 `cssVar.colorPrimary` 只用于焦点描边 `outline: 2px solid ${cssVar.colorPrimary}`，canary 上 `Shell.tsx:93`、`Characters.tsx:145` 等已有同样写法。
- **前后截图对比**：同一脚本（`views.js`：fake lh、唤醒格萝可、1200×800）在 base `00252f9` 与 HEAD `cb368eb` 上各截 12 个路由，并读取计算样式。12 个路由的 body 字体栈、字号 14px、文字色 `rgb(31,31,31)`、底色 `rgb(248,248,248)`、标题字体与颜色全部一致（`SAME`）。唯一差异是 `/interject` 标题 32px → 24px：改前这个地址不存在，会落到小屋（正是 SH-03 的问题），所以测到的是小屋标题；改后是正常的二级页标题，和其他设置页一样是 24px。
- 对比图：[`screenshots/acceptance/`](screenshots/acceptance/) 中 `cmp-*.png`（左改前、右改后）：小屋、角色图鉴、角色详情、聊天、设置、关于与数据。配色、字体、卡片、图标和整体基调一致，变化只在结构（rail 顺序与分隔、标签页、按钮、分组）和文案。
- 暗色：admin 场景 A3 dark 步骤在改后代码上渲染 20 个页面、`data-theme=dark` 通过；本次前后对比只截了亮色。

## 5. npm test / admin 构建 / lint-lobe —— 通过

均在 `feat/admin-ia-polish` 工作树、HEAD `cb368eb` 上执行：

| 命令 | 结果 |
| --- | --- |
| `npm run build:admin` | `✓ built in 1.28s`，EXIT=0（只有 vite 的 chunk 体积提示） |
| `npm test` | `tests 759 · pass 758 · fail 0 · skipped 1`，EXIT=0；跳过的是需要 `PIXELPET_VRM_ASSETS` 的 VRM 素材检查，与本次无关 |
| `node .agents/skills/lobe-design/scripts/lint-lobe.mjs <本分支改动的 25 个 admin 文件>` | `RESULT: 0 FAIL, 2 WARN`，EXIT=0 |
| `lint-lobe.mjs admin/src`（全量） | `RESULT: 0 FAIL, 2 WARN`，EXIT=0 |

两条 WARN 都是 `LOBE-MULTI-PRIMARY`：`Pages.tsx:493`（3 个 primary）、`DetailPage.tsx:807`（2 个 primary）。DetailPage 的两个 primary 不同屏出现（03-changes.md B.2 第 5 条已说明）；Pages.tsx 是一个文件里多个设置页各自的主按钮。WARN 不阻断，记为补充项。

## 6. 真实应用逐场景走查 —— 通过

命令均为 `unset ELECTRON_RUN_AS_NODE; xvfb-run -a node e2e/run.js <场景>`（没有跑 `all` / `live`），HEAD `cb368eb`，fake lh。

| 场景 | 结果 | 走过的关键流程（对应 02-plan 流程 / 改动） | 截图（已上传） |
| --- | --- | --- | --- |
| admin | 29/29 通过，EXIT=0 | 设置窗口打开与单实例；亮 / 暗 20 页；未知路由空态（A02 / SH-03）；朗读页只展开在用引擎 + 试听（A13/A14，F3）；草稿离开提醒（A20 / FORM-01）；重置与放生弹窗内执行（A16 / PG-03，F10）；角色包按角色分组（B08，F5）；更新结果行（A15，F8） | `A-after-not-found`、`A-after-reset-dialog`、`A-after-leave-guard`、`A-after-tts`、`a12d-packs-grouped` |
| admincov | 13/13，EXIT=0 | 图鉴按角色一张卡（B01 / CHAR-01，F1）；详情 5 个标签进 URL（B02 / CHAR-02，F2）；桌宠行为 / 主动搭话即时保存 | `b2-characters-all`、`b3-grok-好感` |
| frontslim | 19/19，EXIT=0 | 小屋、桌面上的她 →「找回桌宠」（C11 / TOG-04）、话题、成人向 / 本机能力确认（F7）、放生确认与实际结果（F10）、检查更新 | `f9-admin-home`（文件名沿用旧命名，画面是「桌面上的她」点「找回桌宠」后的 toast）、`f17-admin-release-confirm` |
| titlebar | 4/4，EXIT=0 | macOS 标题栏拖动条下各页面不被遮挡 | `mac-overview` |
| chatui | 16/16，EXIT=0 | 后台聊天（F9 / C01）：只列已遇见角色 +「结识更多」、模型影响范围说明、失败重试、刷新后保留 | `01-chat-character-list`、`11-error-retry` |
| interject | 10/10，EXIT=0 | 插个嘴独立页（C05 / INT-01）；关闭时只有一句说明（C06 / INT-02）；规则与判断记录 | `ij2a-console-off`、`ij7-rules-and-records` |
| wardrobepack | 12/12，EXIT=0 | 图鉴每位角色一张卡、衣柜、穿上（F1 / F2） | `w0b-roster-all` |
| charmigrate | 7/7，EXIT=0 | 旧存档迁移后图鉴 / 衣柜口径一致（CHAR-01） | `m3-roster-after-migration` |
| catalogdl | 7/7，EXIT=0 | 商店下载 → 图鉴出现、「去见她」toast（C14 / STORE-02，F5） | `d2b-store-characters`、`d3d-store-downloaded` |
| charpage / models / packs / advanced | 自动 SKIP（0/0，1 skipped） | 这 4 个场景驱动的是已移除的桌宠内面板（T-2718），脚本声明其覆盖已并入 admin 场景；**不计入走查** | — |

合计：9 个场景实际执行，117/117 步通过。auditc（会改写 `docs/admin-audit/screenshots/C-*`）本次未跑，C 包的前后截图沿用 03-changes.md C.5。

## 补充项（不影响六条结论，如实记录）

1. lint-lobe 2 条 `LOBE-MULTI-PRIMARY` WARN（见 §5），建议后续把 `Pages.tsx` 中多页共用的主按钮再核对一遍「一屏一个主 CTA」。
2. 4 个旧场景（charpage / models / packs / advanced）已退役、只会 SKIP，`PROJECT.md` §2 仍按可运行场景描述它们，项目验收层需要更新。
3. 前后对比只做了亮色；暗色只有改后（admin A3 dark）。
4. 本轮没有安排独立的 acceptance-checker 复核，截图由验收执行者本人逐张查看；最终判定由 LobeHub 验收轮次的独立 verifier 给出。
5. 「未拥有」角色卡（剪影 +「去商店」）在内置数据下不会出现，只有单测覆盖（03-changes.md B.2 第 3 条）。
