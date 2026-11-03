# 设置窗口 IA 与交互打磨：落地改动记录（交付物 3）

> 分支 `feat/admin-ia-polish`。按 [`02-plan.md`](02-plan.md) §5 分三个实施包落地；每个包写自己的小节（A / B / C），共享文件的改动在各自小节的「协调」里写明。改动编号 `A01` / `B01` / `C01` 见 02-plan §4、§5。

---

## 实施包 B：角色模块（图鉴 / 详情 / 角色包 / 舞台）

> T-2819 · 分支 `feat/admin-ia-polish` · 依据 [`02-plan.md`](02-plan.md) §5.3（B01～B13）与 §1.3 / §1.4 / §2 / F1 / F2 / F5。
> design.lobe.li 引用格式沿用 02-plan §0.3。代码注释与提交信息都写了改动号与问题号（如 `B03 / CHAR-03`）。
> 视觉不变（02-plan §6）：不新增颜色、字体、圆角、阴影；新样式只用 `cssVar.*` 令牌与已有的 `--pet-accent`；原子全部来自 `@lobehub/ui`（`Empty`、`Table`、`Tooltip`、`DropdownMenu`、`Checkbox`、`Surface`、`PageTabs`、`Tag`、`Button`）。

### B.1 改动清单

| 改动 | 内容 | 问题 | design.lobe.li | 代码 |
| --- | --- | --- | --- | --- |
| B01 | 对象模型「角色（base）→ 形象（角色包）→ 服饰」：`groupRoster` 把每套形象一行的 roster 收成每位角色一组；全窗口计数统一「N 位角色 · M 套形象」（`countLabel` / `metCount`）；图鉴**一位角色一张卡**（卡片右上「N 套形象」），她的其他形象在详情 → 装扮 → 新增的「形象」区（`LookPicker`，每套一张小卡，链接到那套的页面）；商店提示改为「还有 N 套形象可以下载」；角色包页标题「5 位角色 · 17 套形象（导入 0 套；含 4 套 18+，没开成人向内容时不在图鉴里）」，解释与图鉴 13 套的差 | CHAR-01 | W-03「状态词和数字一致」<https://design.lobe.li/rules/W-03>；P-02 分组 <https://design.lobe.li/rules/P-02>；M-02 <https://design.lobe.li/models/M-02> | `admin/src/console/roster-model.ts`、`pages/character/RosterPage.tsx`、`DetailPage.tsx`（`LookPicker`）、`PacksPage.tsx` |
| B02 | 详情路由 `#/characters/:id/:tab`（`looks` / `model` / `role` / `affection` / `about`）：深链、刷新、返回都落在原标签；换标签用 `replaceHash`（不增历史记录，「返回」回到来的那一页）；旧标签名 `voice` → `about`、`outfits` → `looks`（`toDetailTab`） | CHAR-02 | P-02「状态进 URL」<https://design.lobe.li/rules/P-02>；P-03 <https://design.lobe.li/rules/P-03>；M-03 #3 <https://design.lobe.li/models/M-03> | `DetailPage.tsx`（`useDetailTab`）、`roster-model.ts`、`admin/src/useHashPath.ts` |
| B03 | 页头压成一行身份（名字 + 类型 + 称号）+ 一行紧凑好感（`HeartMeter compact`，点它去「好感」标签）；口头禅 / 简介 / 喜欢移进「资料与语音」；「好感」标签不再画第二条好感条，只写本标签独有的「离『熟悉』还差 15 · 今天 +0 / 上限 12」和阶段路线图。1200×820 下标签栏 y≈405 → y≈178 | CHAR-03 | W-07「同一个数在页面上重复出现 → 删」<https://design.lobe.li/rules/W-07>；P-03 第一屏优先级 <https://design.lobe.li/rules/P-03> | `DetailPage.tsx`（`Detail`、`AffectionTab`） |
| B04 | 「语音」「资料」合并为「资料与语音」：资料卡（口头禅、简介、喜欢、厂商、角色包、素材署名；删去与「模型」「装扮」重复的模型 / 形象行）+ 语音卡（语音包、音色署名、角色音色）带「管理语音包」按钮 → `#/voicepacks`（不再写「设置 → 语音包」文字路径）；标签 6 → 5 | CHAR-04 | M-03 #6 识别优于回忆 <https://design.lobe.li/models/M-03>；W-07 <https://design.lobe.li/rules/W-07> | `DetailPage.tsx`（`AboutTab`） |
| B05 | 详情页底 `DangerZone`（`Surface`「危险操作」，每项说明在左、danger 按钮在右）：删除下载（只对下载的形象）/ 一键解锁（只对已遇见）/ 清空个性化设定（只在有设定时）；三项都走 A 的共享件 `askAsync`（S-7：弹窗里执行，失败原因写在弹窗里、弹窗不关，成功才关并 toast 实际结果）。「一键解锁」从好感路线图下面、「删除下载」从和「授权信息」并排的位置、「清空」从保存按钮旁移走 | CHAR-05 | P-03「危险操作和普通操作同色同位」<https://design.lobe.li/rules/P-03>；P-05「高风险项单独一区」<https://design.lobe.li/rules/P-05>；C-15 <https://design.lobe.li/rules/C-15> | `pages/character/DangerZone.tsx`、`DetailPage.tsx`（`useDanger`） |
| B06 | 角色不存在：`Empty`「找不到这位角色」+ 原因「没有角色『nobody』：可能删除了她的下载、关掉了成人向内容，或者链接里的名字改过了」+「回角色图鉴」「去商店」 | CHAR-06 | W-05 错误文案 <https://design.lobe.li/rules/W-05>；P-03 必须有的状态 <https://design.lobe.li/rules/P-03>；M-03 #9 <https://design.lobe.li/models/M-03> | `DetailPage.tsx`（`Missing`） |
| B07 | 图鉴筛选写进 `#/characters?kind=live2d`（`useHashQuery` + `replaceHash`，进详情再返回、刷新都保持）；筛选后为空给「没有 X 角色」+「清除筛选」；**整张卡可点**（标题链接的 `::after` 撑满卡片，动作按钮在上层），去掉重复的「详情」按钮；**同一位置只有一个动作按钮**：未拥有「去商店」/ 还没见面「初次见面」/ 已遇见「切换」/ 正在陪你 无按钮，两种按钮同一样式（不再虚线 / 实线交替） | CHAR-07 | P-02「筛选不进 URL」「行点击和行内按钮冲突」<https://design.lobe.li/rules/P-02> | `RosterPage.tsx`、`pages/character/shared.tsx`（`SwitchButton`） |
| B08 | 角色包表按角色分组：父行「大肥鱼 5 套形象（导入 n 套）」，展开为形象子行（形象名、类型、来源、授权、操作），默认全展开；代码 id 收进形象名的 `Tooltip`（「角色包 id：claude-adult · v1」），形象名可点去她的页面；「导入角色…」按钮 loading，成功 toast「已导入『xx』」+「去看看她」并高亮新行；删除 / 删除下载改为 `askAsync`；说明改写为「把角色包文件（.zip / 文件夹）导入，就会成为新角色……」。面包屑「角色图鉴 / 角色包」与 rail 高亮「角色」由 A04 的 schema 完成 | SH-01、CHAR-08 | P-02「列优先级」「按对象收成一行父行」<https://design.lobe.li/rules/P-02>；W-03 <https://design.lobe.li/rules/W-03>；M-03 #2、#4 <https://design.lobe.li/models/M-03> | `pages/character/PacksPage.tsx` |
| B09 | 图鉴四态：**未拥有**（剪影 + 「未拥有」标签 +「去商店」，只给商店里才有、本机一套都没有的角色）/ **还没见面**（彩色立绘 + 一行「还没见面」+「初次见面」）/ **已遇见**（彩色 + 紧凑好感 +「切换」）/ **正在陪你**（ribbon，无按钮）。下载了还没结识的形象不再是灰色剪影加锁；详情舞台也不再给已拥有的形象上剪影 | STORE-02、STG-03 | W-03 <https://design.lobe.li/rules/W-03>；W-07 <https://design.lobe.li/rules/W-07>；M-03 #1、#2 <https://design.lobe.li/models/M-03> | `RosterPage.tsx`、`stage/CharacterStage.tsx`、`stage/SpriteStage.tsx`（`data-silhouette` 供验证） |
| B10 | 舞台动作合一：只显示 6 个常用（待机 / 开心 / 摸头 / 说话 / 思考 / 玩耍），其余收进「更多」`DropdownMenu`；当前角色多一个「桌面上的她也做」勾选，勾上后点动作同时 `api().cue()` 让桌宠也做（不勾仍只是预览，作用域写在控件上） | STG-01 | M-08「并列选项 > 7 个 → 先分组」<https://design.lobe.li/models/M-08>；W-03 <https://design.lobe.li/rules/W-03> | `stage/CharacterStage.tsx` |
| B11 | 舞台 hover 态（上浮 2px + 她的颜色投影，`prefers-reduced-motion` 下关闭）+ `Tooltip`「摸摸格萝可」；第一次点她后显示一次说明（「她感觉到了：桌面上的她也会开心一下……」，`localStorage` 记住只出现一次） | STG-02 | M-06「缺提示 P」<https://design.lobe.li/models/M-06>；M-03 #1 <https://design.lobe.li/models/M-03> | `stage/CharacterStage.tsx` |
| B12 | 状态词表 `STATE_WORD`（正在陪你 / 已遇见 / 还没见面 / 未拥有）：图鉴 ribbon、`SwitchButton`、详情舞台角标、`HeartMeter` 未遇见文案统一（「当前角色」「未遇见」「还没遇见她」全部换掉）；同一状态在一屏只说一次（详情页去掉舞台下第二个「正在陪你」）；命名规则 `lookName`「名字 · 形象」（起过名的用她的名字） | CHAT-02 | W-03「同一个对象在侧栏、标题、表格列、toast、确认框里用同一个词」<https://design.lobe.li/rules/W-03> | `roster-model.ts`、`shared.tsx`、`stage/HeartMeter.tsx`、`DetailPage.tsx` |
| B13 | `resolveCharacter(roster, idOrBase)` 导出：详情页与 Shell 面包屑（A03）共用同一套解析（旧链接 `#/characters/grok` → 格萝可 · 像素） | SH-04 | M-03 #2 <https://design.lobe.li/models/M-03>；W-03 <https://design.lobe.li/rules/W-03> | `roster-model.ts`（Shell 侧由 A03 接入） |
| 拆分 | 1331 行的 `Characters.tsx` 拆为 `pages/character/{shared,RosterPage,DetailPage,PacksPage,DangerZone}.tsx`，`Characters.tsx` 变成 barrel，原有导出（`CatalogGrid`、`KIND_NAME`、`useSwitch` 等）全部保留，ConsoleApp / Store 的 import 不变；衣柜、取景、VRM 姿势、Live2D 大小、导入 Live2D / VRM、模型、个性化设定的逻辑原样搬移 | 支撑 B01–B08 | — | `pages/Characters.tsx`、`pages/character/*` |

### B.2 协调与偏差

**共享文件 / 跨包依赖**

| 文件 | B 做了什么 | 协调 |
| --- | --- | --- |
| `admin/src/useHashPath.ts`（三包共用的路由钩子，不在 A 的文件清单里） | `useHashPath` 返回的 path 去掉 `?query`；新增 `useHashQuery()`、`replaceHash()` | A 的 ConsoleApp 旧路由重定向直接用了 `replaceHash`；C13 的 `#/store?show=` 可用同一对钩子；已告知 A、C |
| `admin/src/console/common/index.tsx`（A00 共享件） | 只引用 `askAsync`（S-7），不修改 | B 早期写过本地版本，A 的共享件落地后改为 `askDanger` 薄封装（只加成功 toast） |
| `Shell.tsx`、`ConsoleApp.tsx`、`settings-schema.js`、`store.tsx`、`fields.tsx` | **未修改** | 面包屑用 `resolveCharacter` / `lookName`（A03）、`#/packs` 挂到「角色」（A04）由 A 完成 |
| `Store.tsx`、`Chat.tsx` | **未修改** | C 继续从 `./Characters` 引 `CatalogGrid`；C14「去见她」可用 `detailHref(id, 'looks')` |
| `e2e/run.js`、`test/admin-console.test.js` | 只改 B 相关断言（按 hunk 提交，见 B.4） | 与 A、C 的 hunk 交错，逐 hunk 暂存 |

**偏差**

1. **旧链接 `#/characters/:id` 不重写成 `/looks`**（02-plan F2 第 3 步写「旧链接 → `/looks`」）：直接按「装扮」渲染，地址不变。理由：桌宠窗口、小屋、聊天、e2e（`[data-path="/characters/<id>"]` 约 30 处）都发这个地址，重写会让 `data-path` 在加载后再跳一次；渲染结果与 `/looks` 相同，深链 / 刷新 / 换标签都写完整地址。
2. **换标签不加历史记录**（`replaceState`）：02-plan 没有规定。选择「返回」回到来的那一页而不是逐个标签后退；刷新仍停在当前标签。
3. **未拥有态在内置数据下不出现**：5 位角色都有内置像素形象，所以当前数据里图鉴 5 张卡都是「已拥有」；「未拥有」分支（剪影 +「去商店」）由 `test/roster-model.test.js` 覆盖，没有真实界面截图。
4. **「NoPet」未换成 A 的共享件**：图鉴的「还没有唤醒桌宠」提示保留 `Alert`，只加了「打开桌宠窗口」按钮（与 NoPet 同一个动作）；A11 的 NoPet 清单里不含图鉴。
5. **lint 剩 1 条 WARN**（`LOBE-MULTI-PRIMARY`，`DetailPage.tsx`）：两个 primary 在不同屏（「找不到这位角色」的「回角色图鉴」与「个性化设定」的「保存」），不会同屏出现。
6. **提交归属**：A 的 `160a394` 在 amend 时把当时共享 index 里 staged 的 B 源码一起提交了（`Characters.tsx`、`pages/character/*`、`roster-model.ts`、`stage/*`、`useHashPath.ts`、`test/roster-model.test.js`）；三个包同时在一个工作区提交，没有重写历史。B 的 e2e / 单测 hunk 在 `baa4b2f`、`b531d90`。A 小节同样记录了这一点。

### B.3 前后截图（`screenshots/B-*`，1200×820，fake lh，当前角色格萝可）

改动前取自干净的 `1fe0a5e`，改动后取自 A + B + C 合并后的工作区（同一脚本、同一数据）。

| 看什么 | 改动前 | 改动后 |
| --- | --- | --- |
| 图鉴：13 张按形象平铺、11 张剪影加锁 → 5 张按角色、彩色、一个动作 | `B-before-characters-list-light.png` | `B-after-characters-list-light.png` |
| 筛选 Live2D → 进详情 → 返回：回到「全部」→ 仍是 `?kind=live2d` | `B-before-characters-filter-after-back.png` | `B-after-characters-filter-live2d.png`、`B-after-characters-filter-after-back.png` |
| 详情首屏：标签栏 y≈405 → y≈178；「形象」区 | `B-before-detail-looks-light.png` | `B-after-detail-looks-light.png`、`B-after-detail-multilook.png` |
| 好感标签：两条好感条 + 正文里的一键解锁 → 一条（页头）+ 路线图 + 页底危险操作 | `B-before-detail-tab-好感.png` | `B-after-detail-tab-好感.png` |
| 刷新后标签：回到「装扮」→ 仍在「模型」 | `B-before-detail-model-after-reload.png` | `B-after-detail-model-after-reload.png` |
| 深链 `#/characters/grok/affection` | `B-before-detail-affection-deeplink.png`（落在装扮） | `B-after-detail-affection-deeplink.png` |
| 资料 + 语音 → 资料与语音（带「管理语音包」） | `B-before-detail-tab-资料.png` | `B-after-detail-tab-资料与语音.png` |
| 一键解锁：弹窗内确认 | — | `B-after-danger-unlock-confirm.png`、`B-e2e-a12d-danger-unlock-confirm.png` |
| 页底 | `B-before-detail-bottom.png` | `B-after-detail-bottom.png` |
| 舞台 hover：无提示 → 「摸摸格萝可」+ 6 个动作 +「更多」+「桌面上的她也做」 | `B-before-stage-hover.png` | `B-after-stage-hover.png` |
| 找不到角色：一条红色 Alert → Empty + 原因 + 两个出口 | `B-before-detail-missing.png` | `B-after-detail-missing.png`、`B-e2e-a12d-missing.png` |
| 角色包：17 行平铺、代码 id、「共 17 位角色」、面包屑「设置」→ 按角色分组、「角色图鉴 / 角色包」 | `B-before-packs-light.png` | `B-after-packs-light.png`、`B-e2e-a12d-packs-grouped.png` |
| 暗色（配色 / 字体 / 基调不变） | `B-before-characters-list-dark.png`、`B-before-detail-dark.png`、`B-before-packs-dark.png` | `B-after-characters-list-dark.png`、`B-after-detail-dark.png`、`B-after-packs-dark.png` |

### B.4 验证命令与结果

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm test` | `tests 758 · pass 757 · fail 0 · skipped 1`（新增 `test/roster-model.test.js` 4 项；`test/admin-console.test.js` 两处读源码的断言改指向 `pages/character/DetailPage.tsx`，断言内容不变）→ [`B-npm-test.txt`](B-npm-test.txt) |
| 类型检查 | `npx tsc -p admin --noEmit` | 无输出（通过） |
| 构建 | `npm run build:admin`（产出 `src/admin-ui/`） | `✓ built in 1.52s` → [`B-build.txt`](B-build.txt) |
| lobe-design lint | `node .agents/skills/lobe-design/scripts/lint-lobe.mjs admin/src/console/pages/Characters.tsx admin/src/console/pages/character admin/src/console/roster-model.ts admin/src/console/stage admin/src/useHashPath.ts` | `RESULT: 0 FAIL, 1 WARN`（WARN 见偏差 5；初版的 `LOBE-OUTLINE-NONE` FAIL 已修）→ [`B-lint-lobe.txt`](B-lint-lobe.txt) |
| e2e admin（A+B+C 合并副本） | `xvfb-run -a node e2e/run.js admin` | 26/29；B 相关步骤全过：A3b（整卡链接）、A3c（「更多」→ 睡觉）、A11（5 张卡、looks `[5,2,2,2,2]`、「5 位角色 · 13 套形象」、「正在陪你」、还没见面无剪影）、A12（列表初次见面 / 切换）、**A12d（新增：深链 + 刷新留在「模型」、点「好感」写 URL、好感只画一次、标签栏 y<260、5 个标签、DangerZone 弹窗确认、找不到角色两个出口、角色包按角色分组）**、A12b/A12c/A13/A13b/A14。失败的 A10、AIA3、A17 是 A 的旧版断言，A 已告知修复后 29/29 → [`B-e2e-admin.txt`](B-e2e-admin.txt) |
| e2e wardrobepack | `xvfb-run -a node e2e/run.js wardrobepack` | 12/12（W0b 改为：大肥鱼一张卡、形象列在她页面「形象」里、Live2D 筛选写进 URL） |
| e2e admincov | `xvfb-run -a node e2e/run.js admincov` | 12/13；B2（按角色出卡、筛选）、B3（5 个标签、资料与语音 + 语音包链接）、B10 通过；B12 失败为 A13 把朗读引擎字段折叠后 DOM 找不到 `tts.endpoints.fish`，属 A，A 正在改该步骤 |
| e2e catalogdl / charmigrate | `xvfb-run -a node e2e/run.js catalogdl` / `charmigrate` | 7/7、7/7（catalogdl 提示改为「8 套形象可以下载」；charmigrate M3 改为按角色出卡 + 从她页面读形象） |

---

