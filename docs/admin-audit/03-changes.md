# 设置窗口 IA 与交互打磨：落地改动记录（交付物 3）

> 分支 `feat/admin-ia-polish`。按 [`02-plan.md`](02-plan.md) §5 分三个实施包落地；每个包写自己的小节（A / B / C），共享文件的改动在各自小节的「协调」里写明。改动编号 `A01` / `B01` / `C01` 见 02-plan §4、§5。

---

## 实施包 A：导航与全局框架、设置类页面

> T-2821 · 分支 `feat/admin-ia-polish` · 依据 [`02-plan.md`](02-plan.md) §5.2（A00～A25，无 A17）。
> design.lobe.li 引用格式沿用 02-plan §0.3：规则 `https://design.lobe.li/rules/<规则号>`，模型 `https://design.lobe.li/models/M-0x`。
> 每处代码改动的注释里写了改动号与问题号（如 `// A01 (SH-05, X-1)`），提交信息同样列出。

### A.1 改动清单

| 改动 | 问题 | 做了什么（文件） | design.lobe.li 引用 |
| --- | --- | --- | --- |
| A00 共享件 | 支撑全部 | 新建 `admin/src/console/common/index.tsx`：`NoPet`（未唤醒 + 「打开桌宠窗口」）、`LoadFailed`（读取失败 + 重试）、`askAsync`（确认弹窗内执行、失败写在弹窗里、成功才关）、`asResult`、`SavedHint`（内联「已保存」+ 读屏全文）、`useLeaveGuard`（未保存草稿离开前确认）。B / C 包已引用 | K-05 状态与反馈 <https://design.lobe.li/rules/K-05>；C-15 确认弹窗 <https://design.lobe.li/rules/C-15>；C-17 就地编辑 <https://design.lobe.li/rules/C-17>；P-04 离开提醒 <https://design.lobe.li/rules/P-04>；W-04 <https://design.lobe.li/rules/W-04> |
| A00 schema | 支撑全部 | `src/core/settings-schema.js`：RAIL 重排 + `group`；NAV 重分组 / 改名；新页 `interject`、`reset`；`packs` 挂到 `characters`；去掉 `history` / `appearance` 并新增 `REDIRECTS`；PAGES 说明改写 + `summary`；字段搬家（点击音效 → tts、本机能力 → safety、插个嘴 → interject、主题 → about）；`api.enabled` 加 `confirmOn`。**settings.json 键名不变**（单测 `normalizeSettings(null)` 键集合校验通过） | 同下各条 |
| A01 | SH-05 | rail 顺序 小屋 / 角色 / 聊天 / 商店 ─ 玩法 / 设置，中间 `Divider`（`Shell.tsx`）；入口数仍 6 | M-08 认知负荷 <https://design.lobe.li/models/M-08>；M-02 格式塔（邻近）<https://design.lobe.li/models/M-02> |
| A02 | SH-03 | 未知路由显示「没有这个页面」空态 + 回小屋 / 去设置，面包屑写「没有这个页面」，rail 不高亮（`ConsoleApp.tsx` `NotFound`、`Shell.tsx`）；旧路由 `#/history` → `#/chat/<正在陪你的角色>`、`#/appearance` → `#/about` | P-03 对象不存在 ≠ 首页 <https://design.lobe.li/rules/P-03>；K-05 <https://design.lobe.li/rules/K-05>；M-03 #9 <https://design.lobe.li/models/M-03> |
| A03 | SH-04 | 面包屑用 B 包 `roster-model.ts` 的 `resolveCharacter` / `lookName`（与详情页同一套解析），旧 base id 也显示「格萝可 · 像素」 | M-03 #2 <https://design.lobe.li/models/M-03>；W-03 <https://design.lobe.li/rules/W-03> |
| A04 | HUB-02、PG-05、SH-01、SH-02 | 设置分组 声音 / 隐私与安全 / 系统；「成人向与本机能力」同页；「对外接口」「重置与放生」进隐私与安全；「LobeHub 与本机」→「账号与连接」只留账号与空间（「重新开始话题」卡删除，C04 已放到聊天页 ⋯）；角色包挂在「角色」下（rail 高亮停在角色）；聊天记录出组 | P-05 按影响范围分组、高风险单独一区 <https://design.lobe.li/rules/P-05>；M-02 <https://design.lobe.li/models/M-02>；W-03 <https://design.lobe.li/rules/W-03> |
| A05 | HUB-01 | Hub 卡片第二行改为 `summary`（≤ 20 字，不复述标题）+ 真实状态行；聊天记录 / 外观主题 / 「数据目录、系统选项、素材署名」这类非状态行删除；新增插个嘴、成人向 · 本机能力、更新失败等真实状态（`Hub.tsx`） | W-02 标题与说明 <https://design.lobe.li/rules/W-02>；W-07 <https://design.lobe.li/rules/W-07> |
| A06 | HUB-03、INT-01 | 玩法分组「陪伴方式 / 和她一起」→「她怎么陪你 / 和她互动」；「插个嘴」独立入口 `#/interject`（页面组件由 C05 在 `Interject.tsx` 实现，A 负责 schema / 路由） | W-03 <https://design.lobe.li/rules/W-03>；M-03 #2 <https://design.lobe.li/models/M-03>；P-05 <https://design.lobe.li/rules/P-05> |
| A07 | SH-06、PG-06 | 「外观主题」整页取消，主题并入 关于与数据 →「显示」卡；说明改写为「设置窗口和桌宠窗口的气泡、菜单都跟着变；角色本身不变」；rail 底部明暗按钮保留 | P-05 每个功能一张卡 <https://design.lobe.li/rules/P-05>；W-02 <https://design.lobe.li/rules/W-02>；W-07 <https://design.lobe.li/rules/W-07> |
| A08 | HOME-01 | 小屋三个按钮各去一个标签：她的好感 → `/affection`、换装扮 → `/looks`、调模型 → `/model`（新增 T-2 入口）；「换一位陪你」→ 图鉴（`Home.tsx`） | W-07 两个按钮做同一件事 <https://design.lobe.li/rules/W-07>；W-01 动作文案 <https://design.lobe.li/rules/W-01>；P-02 状态进 URL <https://design.lobe.li/rules/P-02> |
| A09 | HOME-02 | 「其他伙伴」（12 张、11 张剪影）→「遇见过的伙伴」：按角色聚合（B 包 `groupRoster`），只列已遇见，最多 4 张 +「去图鉴」 | P-01 第一屏优先级 <https://design.lobe.li/rules/P-01>；P-02 <https://design.lobe.li/rules/P-02>；M-08 <https://design.lobe.li/models/M-08> |
| A10 | HOME-03 | 「今天的陪伴」卡去掉像开关的「开 / 关」Tag，改一句状态（「朗读：Fish Audio」/「静音中」）；移除对外接口卡 | P-05 开关只用于立即生效的二值项 <https://design.lobe.li/rules/P-05>；M-03 #4 <https://design.lobe.li/models/M-03> |
| A11 | HOME-04、TOG-05 | 共享 `NoPet` 落到 小屋（未唤醒）、本机能力（未唤醒）、重置与放生；话题 / 桌面上的她 由 C 包在 `Together.tsx` 引用同一组件 | W-04 引导第一个动作 <https://design.lobe.li/rules/W-04>；M-06 缺能力 A <https://design.lobe.li/models/M-06>；M-03 #10 <https://design.lobe.li/models/M-03> |
| A12 | HUB-04 | 玩法 Hub 宠物状态旁「去桌宠窗口喂她」（`showPet`） | M-06 <https://design.lobe.li/models/M-06>；P-01 只能看不能点 <https://design.lobe.li/rules/P-01> |
| A13 | PG-01 | 朗读与音效：「声音」卡 →「引擎」卡 → **只展开正在用的引擎**（自动时按她的角色解析，并写一句「格萝可用的是 Fish Audio」）→「其他引擎」`Accordion` 默认收起，标题行写各引擎 Key 状态 → 缓存与统计；`SettingsForm` 新增 `cards` 过滤与「整卡字段都被折叠就不画空卡」 | P-05 关闭的功能也铺满配置项 <https://design.lobe.li/rules/P-05>；M-08 <https://design.lobe.li/models/M-08> |
| A14 | PG-02 | 引擎卡「试听」：新增主进程 IPC `admin-tts-test`（`main.js`、`admin-preload.js` `ttsTest`），用固定台词走当前引擎，音频在设置窗口播放，结果写在卡内（「可用 · Fish Audio · 820 ms」或「失败：没有 Key：…」）；语音输入「测试连接」移进「语音输入」卡，结果写在卡内（不再用可关闭 Alert） | P-05 用户在决定：改完是否生效 <https://design.lobe.li/rules/P-05>；M-03 #1 <https://design.lobe.li/models/M-03>；M-06 <https://design.lobe.li/models/M-06> |
| A15 | PG-04 | 版本卡「检查结果」一行：已是最新 + 检查时间 / 发现新版本正在下载 / 需手动下载 / 没能检查 + 原因 +「重试」「打开下载页」/ 开发版不检查；「立即更新」先确认（会重启） | W-05 禁止单独出现「操作失败」<https://design.lobe.li/rules/W-05>；M-03 #9 <https://design.lobe.li/models/M-03>；W-06 <https://design.lobe.li/rules/W-06> |
| A16 | **PG-03（P0）**、PG-07 | 新页 隐私与安全 → 重置与放生：两张卡分别写清删除 / 保留什么；`askAsync` 弹窗内执行，确认按钮进行中，失败把原因写在弹窗里且不关，成功才关并写实际结果（「删除了 N 个 agent；M 个没删掉…」，`pet-service.js` `release` 新增 `failed` 计数）；清空语音缓存同改 | C-15 <https://design.lobe.li/rules/C-15>；W-05 <https://design.lobe.li/rules/W-05>；K-05 <https://design.lobe.li/rules/K-05>；P-05 高风险单独一区 <https://design.lobe.li/rules/P-05> |
| A18 | PG-07、TOG-04 | 关于与数据：显示（主题、硬件加速）→ 数据目录（只留打开数据目录 / 错误日志，删重复的角色包 / 语音包文件夹按钮）→ 素材署名 `Accordion` 默认收起 →「退出应用」（`data-app-quit`，C11 已从桌面上的她移走） | W-07 <https://design.lobe.li/rules/W-07>；P-05 <https://design.lobe.li/rules/P-05>；M-08 <https://design.lobe.li/models/M-08> |
| A19 | PG-08 | 语音包空态：「还没有语音包」+ 放置位置（`<数据目录>/voicepacks`）与格式（manifest.json + 音频）+ 主按钮「打开 voicepacks 文件夹」；「重新读取」按钮 loading，只在调用成功后提示（含新增数），失败 toast 写原因 | W-04 首次使用 <https://design.lobe.li/rules/W-04>；M-06 <https://design.lobe.li/models/M-06> |
| A20 | FORM-01 | 数字项失焦 / 回车即时保存（越界红字「（没有保存）」不提交），页内无「保存」按钮；Key / URL / 文本保留「保存」，草稿未保存时离开（rail、面包屑、任何 hash 变化）弹「放弃未保存的修改？」（放弃修改 / 留在这里） | P-05 未保存修改可见 <https://design.lobe.li/rules/P-05>；P-04 离开提醒 / 草稿 <https://design.lobe.li/rules/P-04> |
| A21 | FORM-02 | 字段说明下不再挂「默认：xx」和「敏感 · 遮罩显示」；默认值只在值不同时出现在「恢复默认」按钮的 Tooltip 里 | C-17 复述的 badge 只是噪音 <https://design.lobe.li/rules/C-17>；W-07 <https://design.lobe.li/rules/W-07> |
| A22 | FORM-03 | 即时项（开关 / 分段 / 下拉 / 滑块 / 数字 / 快捷键 / Key / 成人向 / 本机能力）保存成功不弹 toast，控件旁 1.5s「已保存」（`SavedHint`，带 `aria-live` 读屏全文「已保存：梗图 → 关」）；失败仍 `toast.error`「没能保存「X」」+ 原因 | C-17 <https://design.lobe.li/rules/C-17>；K-05 toast 用稳定 id <https://design.lobe.li/rules/K-05>；M-03 #8 <https://design.lobe.li/models/M-03> |
| A23 | FORM-04 | 开启对外接口先确认（schema `confirmOn`，关闭不确认）；换令牌走 `askAsync`，按返回判断，失败写「旧令牌仍然有效」，成功自动显示新令牌 3 秒；成人向按 main 返回的实际值判断成败；本机能力未唤醒用 `NoPet`、失败写原因 | W-05 <https://design.lobe.li/rules/W-05>；C-15 <https://design.lobe.li/rules/C-15>；P-05 <https://design.lobe.li/rules/P-05>；M-03 #9 <https://design.lobe.li/models/M-03> |
| A24 | FORM-05 | 字段「恢复默认」与「恢复本页默认」都不再弹确认，执行后 toast 带「撤销」（5s，稳定 id） | W-07 确认框保护的是可撤回的操作 → 改为执行后提供撤销 <https://design.lobe.li/rules/W-07>；M-03 #3 <https://design.lobe.li/models/M-03> |
| A25 | FORM-06 | 「点击音效」从 桌宠行为 挪到 朗读与音效 →「声音」卡（只改 schema 的 page / card，settings.json 键 `prefs.clickSound` 不变） | P-05 按影响范围分组 <https://design.lobe.li/rules/P-05>；M-02 <https://design.lobe.li/models/M-02> |

### A.2 偏差与理由

| # | 方案原文 | 实际 | 理由 |
| --- | --- | --- | --- |
| A-D1 | A07 / §1.4：主题、硬件加速放进「设置窗口」卡 | 卡名改为「显示」 | 硬件加速影响的是桌宠窗口的绘制，放在「设置窗口」卡名下是口径错误（W-03 专名与口径一致） |
| A-D2 | S-5：需重启的项弹 `toast.warning`（id `restart`）+「立即重启」 | 不另弹 toast，用 Shell 已有的常驻「X：重启应用后生效 · 立即重启」横幅 + 内联「已保存」 | 横幅本来就在且原地刷新，再弹一条 toast 是同一件事说两遍（W-07） |
| A-D3 | S-7 / C-15：提交期间弹窗不可关闭 | `confirmModal` 的确认按钮会进入 loading，但「取消」不能被禁用；提交中点取消会关窗，请求仍执行，结果仍按 toast 报告 | `@lobehub/ui` `confirmModal` 不提供 cancel 的禁用属性；不自建 Modal 以遵守「原子组件用 @lobehub/ui」。后续若上游支持 `cancelButtonProps` 再补 |
| A-D4 | A19：「导入语音包…」 | 未做（方案 §4 PG-08 已标「部分不做」） | 需要主进程新增文件复制与校验 IPC，不影响 IA；本期做了空态说明 +「打开文件夹」 |
| A-D5 | A06 插个嘴页、A04「重新开始对话」、A18「退出应用」 | 页面组件 / 聊天页 ⋯ 菜单 / 桌面上的她移除退出由 C 包完成；A 负责 schema、路由、关于与数据的退出按钮 | 与 C 包在同一工作区协作，按 02-plan §5.1 文件归属避免两个包改同一函数 |
| A-D6 | A08 三个按钮直达标签 | A 写好链接（`/characters/:id/affection|looks|model`），落到对应标签依赖 B02 的详情路由 | 02-plan §5.1 顺序：A08 依赖 B02 |
| A-D7 | S-6 离开提醒覆盖「rail、面包屑、hash 变化」 | 覆盖窗口内所有 hash 导航；关闭设置窗口本身不拦截 | Electron 窗口关闭走主进程，拦截需改 main 的 close 流程，超出 A 包 |

### A.3 前后截图

（`docs/admin-audit/screenshots/`，改动前 = 基线提交 `1fe0a5e` 的 `e2e/run.js admin` 场景，改动后 = 本包提交后的同一场景）

| 页面 / 改动 | 改动前 | 改动后 |
| --- | --- | --- |
| rail 顺序 + 分隔线、设置 Hub 三组 + summary（A01 / A04 / A05） | `A-before-light-settings.png` · `A-before-dark-settings.png` | `A-after-light-settings.png` · `A-after-dark-settings.png` · `A-after-settings-hub.png` |
| 玩法 Hub：分组改名、插个嘴入口、去桌宠窗口喂她（A06 / A12） | `A-before-light-play.png` · `A-before-dark-play.png` | `A-after-light-play.png` · `A-after-dark-play.png` · `A-after-play-hub.png` |
| 小屋：三按钮、今天的陪伴状态句、遇见过的伙伴（A08 / A09 / A10） | `A-before-light-overview.png` · `A-before-dark-overview.png` | `A-after-light-overview.png` · `A-after-dark-overview.png` · `A-after-overview.png` |
| 朗读与音效：渐进展开、试听、点击音效（A13 / A14 / A21 / A25） | `A-before-light-tts.png` · `A-before-light-behavior.png` | `A-after-light-tts.png` · `A-after-tts.png` · `A-after-light-behavior.png` |
| 关于与数据（含原外观主题页）：显示卡、署名折叠、退出应用（A07 / A18） | `A-before-light-about.png` · `A-before-light-appearance.png` | `A-after-light-about.png` · `A-after-about.png` |
| 成人向与本机能力 / 账号与连接（A04 / A23） | `A-before-light-safety.png` · `A-before-light-connection.png` | `A-after-light-safety.png` · `A-after-safety.png` · `A-after-light-connection.png` |
| 重置与放生（新页，P0 PG-03，A16） | `A-before-light-about.png`（底部危险操作） | `A-after-light-reset.png` · `A-after-reset-dialog.png` · `A-after-reset-done.png` |
| 版本与更新结果条（A15） | `A-before-light-update.png` | `A-after-light-update.png` · `A-after-update.png` |
| 未知路由（A02） | （改动前显示小屋，无图） | `A-after-not-found.png` |
| 未保存草稿离开提醒（A20） | （改动前静默丢弃，无图） | `A-after-leave-guard.png` |
| 主动搭话与好感（数字项无保存按钮，A20） | `A-before-light-proactive.png` | `A-after-light-proactive.png` |
| 对外接口 / 语音输入 / 语音包 / 角色包 | `A-before-light-api.png` · `A-before-light-asr.png` · `A-before-light-voicepacks.png` · `A-before-light-packs.png` | `A-after-light-api.png` · `A-after-light-asr.png` · `A-after-light-voicepacks.png` · `A-after-light-packs.png` |
| 插个嘴（新入口，页面由 C 包实现） | — | `A-after-light-interject.png` |


### A.4 验证命令与结果

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm test` | **757 pass / 0 fail / 1 skipped**（758 项，含新增的 A 包 schema 断言：rail 顺序与分组、NAV 分组、REDIRECTS、summary ≤ 20 字、字段搬家、`confirmOn`） |
| 类型检查 | `npx tsc -p admin` | exit 0 |
| 构建 | `npm run build:admin` | `✓ built`，已更新 `src/admin-ui/`（构建产物被 `.gitignore`，不入库） |
| lobe-design lint | `node .agents/skills/lobe-design/scripts/lint-lobe.mjs` + A 包 10 个改动文件 | **0 FAIL**，1 WARN（`LOBE-MULTI-PRIMARY` Pages.tsx：同一文件里「立即更新」「下载新版本」「打开 voicepacks 文件夹」三个 primary 分属不同页面 / 互斥状态，一屏只出现一个） |
| 改动前 e2e | `unset ELECTRON_RUN_AS_NODE; xvfb-run -a node e2e/run.js admin`（基线 `1fe0a5e`，独立 worktree） | 23/23 PASS，原始输出 `A-before-e2e-admin.txt` |
| 改动后 e2e | 同上（A + B + C 当前代码的隔离副本，避免与其他包同时写 `out/e2e/admin`） | **29/29 PASS**，原始输出 `A-after-e2e-admin.txt`；新增 AIA1～AIA5（导航 / 小屋 / 朗读 / 离开提醒 / 设置页）与 A17 末尾「仅重置本地」真实执行 |
| 改动后 e2e（受 A 影响的其他场景） | `xvfb-run -a node e2e/run.js admincov` / `frontslim`（同一隔离副本） | admincov **13/13 PASS**（B12 改为先展开「其他引擎」再核对字段，A13）；frontslim **19/19 PASS**（F12 本机能力改去 `#/safety`、F14 读检查结果条、F16 / F17 改去 `#/reset`、取消按钮「先不了」）；原始输出 `A-after-e2e-admincov.txt`、`A-after-e2e-frontslim.txt` |

改动后 admin 场景中与 A 包直接相关的断言（摘自 `A-after-e2e-admin.txt`）：

```
PASS  [admin] A3b depth: the rail holds 6 places (4 + 商店 + 聊天); 设置 → a tile → its page → back up; 角色 → a card → her page — rail 小屋 / 角色 / 聊天 / 商店 / 玩法 / 设置; 设置 tiles tts,asr,voicepacks,safety,api,reset,connection,update,about; 玩法 
PASS  [admin] A5 桌宠行为 switches apply at once: 梗图 off → settings.json + the pet window's settings — prefs.memes: settings.json false, pet window false, toast 已保存：梗图
PASS  [admin] A6 主动行为与好感度: out-of-range number is refused in the form; a valid one is saved and applied — 999 → "不能大于 240分钟（没有保存）"; 20 saved; 主动说话 off (dependent fields folded); pet settings proactive={"enabled":false,"speakCooldo
PASS  [admin] A8 对外接口: switching it on generates a token that is shown masked — token masked as ••••••…wxpg (32 chars in settings.json)
PASS  [admin] A10 恢复本页默认 on 桌宠行为 puts petScale / memes back — memes on, petScale 1.25 again (pet window too)
PASS  [admin] AIA1 实施包 A navigation: unknown route → 没有这个页面; old routes redirect; 角色包 keeps 角色 lit; 设置 groups 声音 / 隐私与安全 / 系统 — #/nope → 没有这个页面; #/appearance → /about; #/history → #/chat/grok-classic; #/packs lights 角色; 设置 声音 / 隐私
PASS  [admin] AIA2 小屋: three buttons to three tabs, 今天的陪伴 as status lines (no 开/关 tag, no 对外接口), met friends by character (≤ 4) — chips: #/tts 没有读出来，只显示文字 | #/asr 没开：按住 🎤 不会录音 | #/proactive 只在你找她时说话 | #/visitors 还没有请伙伴来; friends c
PASS  [admin] AIA3 朗读与音效: 声音 card has 点击音效; only the active engine expanded, others folded; 试听 result written in the 引擎 card — active engine fish; fields shown 8; 试听 → 「试听失败：Fish Audio：http-401」
PASS  [admin] AIA4 unsaved draft: leaving 朗读 with an unsaved endpoint asks 放弃未保存的修改？ — 留在这里 keeps it, 放弃修改 leaves — tts.endpoints.fish draft → 留在这里 kept #/tts, 放弃修改 → #/settings
PASS  [admin] AIA5 设置 pages: 成人向与本机能力 holds both switches; 关于与数据 has 显示 + folded 署名 + 退出应用; 检查更新 writes its result; 重置与放生 confirms in a dialog — safety: adult + local; about: theme, quit, no dup folders; update → 「开发版（从源码运行）不检查更新」
PASS  [admin] A17 persisted across a restart: values read back from settings.json; 硬件加速 off takes effect only after the restart — 仅重置本地 → toast 已重置本地 (dialog closed after main answered); after restart: proactive={"enabled":false,"
```

### A.5 提交与协作说明

- 提交：`160a394 ♻️ refactor(admin): 实施包 A——导航与全局框架、设置类页面的 IA 与交互（T-2821）`；本记录、截图与 e2e 增量（admincov B12、frontslim F12～F17）另起一个提交。
- `160a394` 在 amend 时**误带入了实施包 B 当时已暂存的源码**（`pages/Characters.tsx`、`pages/character/*`、`roster-model.ts`、`stage/*`、`useHashPath.ts`、`test/roster-model.test.js`）。这些改动的作者与说明归 B 包（见 B 小节与 `baa4b2f`）；三个包已商定不改写历史。
- 共享文件只提交了 A 的部分：`e2e/run.js`（admin 场景断言、`adminRelease` 改走 `#/reset`、admincov B12 展开「其他引擎」、frontslim F12 / F14 / F16 / F17）、`test/admin-console.test.js`（schema 断言）、`src/core/admin-coverage.js`（隐私与安全 / 关于与数据的落位文案）；`Pages.tsx` 中 `ProactivePage` / `BehaviorPage` 归 C。
- 依赖：A 引用 B 的 `roster-model.ts`（`resolveCharacter` / `lookName` / `groupRoster` / `detailHref`）与 C 的 `InterjectPage`。

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
7. **e2e 里 B 的三处断言被拼错了位置**（第 2 轮发现并修复，`4b119be`）：A / C 在共享工作区按 hunk 暂存提交时，charmigrate M3 的形象读取落进了 M2、admin A12 的收尾落到 A12d 之后、admincov B3 的语音包链接断言落进了标签循环。工作区里一直是正确版本，`4b119be` 只把它提交上去，断言内容不变；修复后上述场景全部通过（B.4）。

### B.3 前后截图（`screenshots/B-*`，1200×820，fake lh，当前角色格萝可）

改动前取自干净的基线 `1fe0a5e`（单独 worktree 重新 `build:admin`），改动后取自 `feat/admin-ia-polish`（A + B + C 都已提交后的 HEAD）；同一个 Playwright 脚本、同一份数据，第 2 轮全部重拍。截图里没有地址栏，**每张图拍摄时的 `location.hash`、选中的标签和主区域文字记在 [`B-screenshots-log.txt`](B-screenshots-log.txt)**，下表「地址」一列即取自该记录。

| 看什么 | 改动前 | 改动后 | 地址（log） |
| --- | --- | --- | --- |
| 图鉴：13 张按形象平铺、多数剪影 → 5 张按角色、彩色、一个动作；计数「已遇见 2 / 13 位」→「已遇见 1 / 5 位角色 · 共 13 套形象」 | `B-before-characters-list-light.png` | `B-after-characters-list-light.png` | `#/characters` |
| 筛选 Live2D | `B-before-characters-filter-live2d.png` | `B-after-characters-filter-live2d.png` | 前 `#/characters`（筛选不进地址）→ 后 `#/characters?kind=live2d` |
| 筛选后进详情再「返回」 | `B-before-characters-filter-after-back.png`（筛选丢失，回到「全部」） | `B-after-characters-filter-after-back.png`（仍是 Live2D） | 前 `#/characters` → 后 `#/characters?kind=live2d` |
| 详情首屏：标签栏 y≈405 → y≈178；新增「形象」区 | `B-before-detail-looks-light.png` | `B-after-detail-looks-light.png`、`B-after-detail-multilook.png` | `#/characters/grok` |
| 好感标签：两条好感条 + 正文里的一键解锁 → 一条（页头）+ 路线图 + 页底危险操作 | `B-before-detail-tab-好感.png` | `B-after-detail-tab-好感.png` | 前 `#/characters/grok`（标签不进地址）→ 后 `#/characters/grok/affection` |
| 点「模型」后刷新 | `B-before-detail-model-after-reload.png`（刷新后回到「装扮」） | `B-after-detail-model-after-reload.png`（仍在「模型」） | 前 `#/characters/grok`，选中「装扮」→ 后 `#/characters/grok/model`，选中「模型」 |
| 深链到好感 | `B-before-detail-affection-deeplink.png`（落在「装扮」） | `B-after-detail-affection-deeplink.png`（落在「好感」） | `#/characters/grok/affection` |
| 「资料」「语音」两个标签 → 「资料与语音」一个标签，语音卡带「管理语音包」按钮（改前「语音」标签另见 `B-before-detail-tab-模型.png` 的标签栏：6 个标签） | `B-before-detail-tab-资料.png` | `B-after-detail-tab-资料与语音.png` | 后 `#/characters/grok/about` |
| 一键解锁：弹窗内确认 → 点「取消」后弹窗关闭、好感仍是「陌生 · 好感 0 / 100」 | — （改前一键解锁在好感标签正文里） | `B-after-danger-unlock-confirm.png`、`B-after-danger-unlock-cancelled.png`、`B-e2e-a12d-danger-unlock-confirm.png` | `#/characters/grok/affection` |
| 页底 | `B-before-detail-bottom.png` | `B-after-detail-bottom.png` | `#/characters/grok` |
| 鼠标悬停在舞台上（截图不含光标）：改前无提示、11 个动作两行平铺、「当前角色」标签 → 改后浮出「摸摸格萝可」提示、6 个动作 +「更多」+「桌面上的她也做」 | `B-before-stage-hover.png` | `B-after-stage-hover.png` | `#/characters/grok`，选中「装扮」 |
| 找不到角色：一行红色 Alert → Empty + 原因 + 两个出口 | `B-before-detail-missing.png` | `B-after-detail-missing.png`、`B-e2e-a12d-missing.png` | `#/characters/nobody` |
| 角色包：17 行平铺、代码 id、面包屑「设置 / 角色包」→ 按角色分组、面包屑「角色图鉴 / 角色包」 | `B-before-packs-light.png` | `B-after-packs-light.png`、`B-e2e-a12d-packs-grouped.png` | `#/packs` |
| 暗色（配色 / 字体 / 基调不变） | `B-before-characters-list-dark.png`、`B-before-detail-dark.png`、`B-before-packs-dark.png` | `B-after-characters-list-dark.png`、`B-after-detail-dark.png`、`B-after-packs-dark.png` | — |

> 对比时注意：左侧 rail 的顺序（改前 小屋 / 角色 / 商店 / 玩法 / 设置 / 聊天 → 改后 小屋 / 角色 / 聊天 / 商店 / 分隔线 / 玩法 / 设置）和角色包页 rail 高亮（「设置」→「角色」）是**实施包 A** 的导航改动，不是 B 的视觉改动。
> `B-e2e-a12d-*` 三张取自 `e2e/run.js admin` 的 A12d 步骤。

### B.4 验证命令与结果

第 2 轮在 `feat/admin-ia-polish` HEAD `4b119be`（A、B、C 都已提交）上全部重跑；原始输出入库在本目录。

| 检查 | 命令 | 结果 | 原始输出 |
| --- | --- | --- | --- |
| 单元测试 | `npm test` | `tests 758 · pass 757 · fail 0 · skipped 1`（含新增 `test/roster-model.test.js` 4 项；`test/admin-console.test.js` 两处读源码的断言改指向 `pages/character/DetailPage.tsx`，断言内容不变） | [`B-npm-test.txt`](B-npm-test.txt) |
| 类型检查 | `npx tsc -p admin --noEmit` | 无输出，exit 0 | [`B-build.txt`](B-build.txt) |
| 构建 | `npm run build:admin`（产出 `src/admin-ui/`，该目录在 `.gitignore` 里、不入库） | `✓ built in 1.25s`，产物 `src/admin-ui/index.html` + `assets/index-LKndBAz8.js` | [`B-build.txt`](B-build.txt) |
| lobe-design lint | `node .agents/skills/lobe-design/scripts/lint-lobe.mjs admin/src/console/pages/Characters.tsx admin/src/console/pages/character admin/src/console/roster-model.ts admin/src/console/stage admin/src/useHashPath.ts` | `RESULT: 0 FAIL, 1 WARN`（12 个文件；WARN 见偏差 5） | [`B-lint-lobe.txt`](B-lint-lobe.txt) |
| e2e admin | `xvfb-run -a node e2e/run.js admin` | **29/29**。B 相关：A3b（整卡链接）、A3c（舞台「更多」）、A11（5 张卡、「正在陪你」、还没见面无剪影）、A12（列表初次见面 / 切换）、**A12d**（深链 + 刷新留在「模型」、点「好感」写 URL、好感只画一次、标签栏 y<260、5 个标签、危险操作弹窗确认后取消、找不到角色两个出口、角色包按角色分组）、A12b / A12c / A13 / A13b / A14 | [`B-e2e.txt`](B-e2e.txt) |
| e2e admincov | `xvfb-run -a node e2e/run.js admincov` | **13/13**（B2 按角色出卡与筛选、B3 5 个标签 + 资料与语音 + 语音包链接） | 同上 |
| e2e wardrobepack / catalogdl / charmigrate | `xvfb-run -a node e2e/run.js <场景>` | **12/12、7/7、7/7**（W0b 大肥鱼一张卡、形象在她页面「形象」里、Live2D 筛选进 URL；catalogdl 提示「N 套形象可以下载」；charmigrate M3 按角色出卡 + 从她页面读形象） | 同上 |

第 1 轮记录的 `admin` 26/29、`admincov` 12/13 是 A 包断言尚未提交时的合并副本结果；A 提交后已全部通过，上表为准。

### B.5 B 的提交

`baa4b2f`（e2e / 单测 hunk）、`b531d90`、`1c4bc5a`、`28f3545`、`31048f5`、`4b119be`（还原被交错暂存打乱的 B 断言，见偏差 7），以及第 2 轮的文档 / 截图提交；B 源码随 A 的 `160a394` 入库（偏差 6）。

---

## 实施包 C：聊天、互动（插个嘴 / 话题 / 桌面上的她）与商店

> 任务 T-2820。范围：02-plan §5.4（C01～C14）。文件：`admin/src/console/pages/Chat.tsx`、`Interject.tsx`、`Together.tsx`、`Store.tsx`，`Pages.tsx` 中的 `ProactivePage` / `BehaviorPage` 两个函数。视觉不变：只用 `@lobehub/ui` 原子（`Empty`、`DropdownMenu`、`Surface`、`Segmented`、`toast`、`Modal` 经 `askAsync`，第 2 轮前为 `confirmModal`）与 `cssVar` 语义 token，没有新颜色、新字体、新间距体系（§6 不动项）。

### C.1 改动清单（改动 → 问题 → design.lobe.li 依据 → 代码位置）

| 改动 | 问题 | 做了什么 | design.lobe.li | 代码 |
| --- | --- | --- | --- | --- |
| C01 | SH-02、CHAT-01、TOG-02 | 「聊天记录」页下线（`HistoryPage` 删除），聊天页就是她的全部历史（桌面的轮次带「桌面」标签，向上「查看更早的消息」）；旧地址 `#/history` 由 A00 的 `schema.redirects` 落到 `#/chat/<正在陪你>`；聊天页空态与会话栏说明统一为「和桌面上是同一段对话」 | W-07「两个按钮做同一件事 → 合并」<https://design.lobe.li/rules/W-07>；W-03 <https://design.lobe.li/rules/W-03>；P-03「面包屑断」<https://design.lobe.li/rules/P-03> | `Together.tsx`（删 `HistoryPage`）、`Chat.tsx` 空态 / 会话栏说明 |
| C02 | CHAT-03 | 会话栏只列已遇见的角色（正在陪你置顶）；底部一行「结识更多（还有 N 位没见过）→」去角色图鉴；没遇见的角色仍可用深链 `#/chat/<id>` 打开，显示「还没见过 + 去见她」 | W-07 <https://design.lobe.li/rules/W-07>；M-08 Hick 定律 <https://design.lobe.li/models/M-08> | `Chat.tsx`（`ordered` 过滤、`data-meet-more`） |
| CHAT-02（B12 词表） | CHAT-02 | 会话栏状态「在桌面」→「正在陪你」，取自 B 包 `roster-model.ts` 的 `STATE_WORD.current` | W-03 <https://design.lobe.li/rules/W-03> | `Chat.tsx` |
| C03 | CHAT-04 | 模型下拉下方固定一句「桌面上也用这个模型」（`data-model-scope`）；换成功后旁边内联 1.5 s「已保存」（`SavedHint`，不弹 toast）；失败 `toast.error`「没能换成 X」+ 原因 +「她继续用原来的模型」 | P-05「不说明影响范围」<https://design.lobe.li/rules/P-05>；C-17 <https://design.lobe.li/rules/C-17>；W-05 <https://design.lobe.li/rules/W-05> | `Chat.tsx`（`changeModel`、页头） |
| C04 | HUB-03、PG-05 | 聊天页头「⋯」菜单：「重新开始对话」（第 2 轮起：任一已遇见的角色都可用，作用于当前打开的这段对话，主进程 `newTopic(speciesId)`）→ `askAsync` 确认，弹窗内执行，执行期间弹窗不可关闭（S-7），成功 toast「下一句会开一个新对话」，失败原因写在弹窗里；「在她的页面设置模型」→ `#/characters/<id>/model`（B02） | W-03 一词一义 <https://design.lobe.li/rules/W-03>；C-15 <https://design.lobe.li/rules/C-15>；M-03 #2 <https://design.lobe.li/models/M-03> | `Chat.tsx`（`restart`、`DropdownMenu`） |
| C05 | INT-01 | 插个嘴独立页 `#/interject`：`InterjectPage`（页头读 `PAGES.interject` + 恢复本页默认 + 表单 + 数据），「主动搭话与好感」只剩主动行为 / 好感度两张卡 | P-05「按影响范围分组」<https://design.lobe.li/rules/P-05>；W-02「页面标题和侧栏入口同名」<https://design.lobe.li/rules/W-02> | `Interject.tsx`（`InterjectPage`）、`Pages.tsx`（`ProactivePage`） |
| C06 | INT-02 | 关闭时只渲染「插个嘴」开关卡（`SettingsForm cards={['插个嘴']}`），两张表不渲染，只留一张「规则与判断记录」说明卡；去掉卡头「默认关闭 / 已打开」标签 | P-05「配置项只在开启后出现」<https://design.lobe.li/rules/P-05>；C-17「复述的 badge 只是噪音」<https://design.lobe.li/rules/C-17> | `Interject.tsx`、`Pages.tsx` |
| C07 | INT-03 | 规则表 / 判断记录各自负责自己的读取：首次读取失败在表格位置显示 `LoadFailed`（原因 +「重试」），不再显示「还没有规则」；刷新失败时保留上次的数据并在卡头写「刷新没成功，下面是上次读到的」；去掉可关闭的页顶 Alert | K-05「失败不是零条」「读失败由数据所在的表面负责」<https://design.lobe.li/rules/K-05>；W-04 区分三种空 <https://design.lobe.li/rules/W-04> | `Interject.tsx`（`load`、`staleNote`） |
| C08 | INT-04 | 「清空记录」「删除规则」走 `askAsync`：确认后在弹窗内执行，按 `ok` 分支；失败原因写在弹窗里、弹窗不关；成功 toast 写实际条数「判断记录已清空：删除了 3 条」。规则启用 / 停用即时生效，成功不弹 toast，失败 `toast.error`「没能停用这条规则」 | C-15 <https://design.lobe.li/rules/C-15>；W-05 <https://design.lobe.li/rules/W-05>；C-17 <https://design.lobe.li/rules/C-17> | `Interject.tsx`（`clear`、`remove`、`toggle`） |
| C09 | TOG-01 | 聊天历史读取失败（IPC 抛错）：消息区显示 `LoadFailed`「没能读取和格萝可的聊天记录」+ 原因 +「重试」，不再一直转圈或画成空对话；「查看更早的消息」失败给 toast，已显示的消息不受影响 | K-05 <https://design.lobe.li/rules/K-05>；W-04 <https://design.lobe.li/rules/W-04> | `Chat.tsx`（`loadLatest`、`loadEarlier`） |
| C10 | TOG-03 | 「聊聊」：不再在请求前弹「开始聊了」；按钮 loading 直到她聊完，结果出来只给一条 toast（成功「格萝可在桌面上聊了「自我介绍」」/ 失败「没能聊「自我介绍」」+ 原因 + 怎么办） | K-05 <https://design.lobe.li/rules/K-05>；M-03 #1 系统状态可见 <https://design.lobe.li/models/M-03> | `Together.tsx`（`talk`） |
| C11 | TOG-04 | 「桌面上的她」= 动作 + 找回桌宠（原「回到右下角」与桌宠行为页「找回桌宠」合一：先 `placePet` 显示并放回右下角，再 `home` 让她停下，被藏起来和走远两种情况都覆盖）；「退出」移出（A18 放到 关于与数据 →「退出应用」`data-app-quit`）；桌宠行为页删掉找回按钮；动作按钮按结果反馈（成功「她：开心」，失败「她没能…」+ 原因），点下后其余动作按钮暂时禁用 | W-07 <https://design.lobe.li/rules/W-07>；P-05 高风险单独一区 <https://design.lobe.li/rules/P-05>；M-03 #4 <https://design.lobe.li/models/M-03> | `Together.tsx`（`DeskPage`）、`Pages.tsx`（`BehaviorPage`） |
| TOG-05（A11 共享件） | TOG-05 | 话题 / 桌面上的她未唤醒时用 A 包共享 `NoPet`（带「打开桌宠窗口」） | W-04 <https://design.lobe.li/rules/W-04> | `Together.tsx` |
| C12 | STORE-01 | 只有一个类别时不渲染 `PageTabs`（出现第二个类别时自动出现）；商店卡片动作保持「查看」（图鉴侧「详情 → 查看」属 B07） | W-07「切换后画面不变的控件 → 删」<https://design.lobe.li/rules/W-07>；W-03 <https://design.lobe.li/rules/W-03> | `Store.tsx`（`StorePage`） |
| C13 | STORE-03 | 筛选写进 `#/store?show=remote|installed`（`useHashQuery` + `replaceHash`，不新增历史记录），返回 / 刷新保持；筛选后为空写「已经全部下载了。」；页头读 `PAGES.store`，不再写死 | P-02「筛选不进 URL」<https://design.lobe.li/rules/P-02>；W-03 <https://design.lobe.li/rules/W-03> | `Store.tsx`（`CharactersShelf`） |
| C14 | STORE-02 | 下载完成只给一条 toast「「X」下载好了」+ 说明「她已经在角色图鉴里，初次见面后就能切换到她」+ 按钮「去见她」→ `detailHref(id, 'looks')`；未唤醒提示改用共享 `NoPet compact` | M-03 #1、#2 <https://design.lobe.li/models/M-03>；W-03 <https://design.lobe.li/rules/W-03> | `Store.tsx`（`Shelf`） |

覆盖：02-plan §5.4 的 C01～C14 全部落地；另按 02-plan 引用了 B12（状态词）与 A11（`NoPet`）。

### C.2 协调：共享文件与跨包依赖

| 文件 | 谁改 | C 包的处理 |
| --- | --- | --- |
| `admin/src/console/common/index.tsx`（`NoPet` / `LoadFailed` / `askAsync` / `asResult` / `SavedHint`） | A00；第 2 轮 C 改 `askAsync` | 第 1 轮 C 只引用。第 2 轮为补齐 S-7「提交期间不可关闭」（C04 / C08 的流程依赖它），C 把 `askAsync` 的实现从 `confirmModal` 换成 `@lobehub/ui` 的声明式 `Modal`（新增 `AskHost` / `AskDialog`），**签名与返回值不变**，A（放生、字段确认）、B（DangerZone）的调用方无需改动；回归见 C.5。 |
| `admin/src/design/DesignProvider.tsx` | 第 2 轮 C | 在 `ModalHost` 旁挂一行 `<AskHost />`（askAsync 的弹窗渲染处），其余不变。 |
| `src/main/pet-service.js`（`newTopic`）、`src/main/main.js`（`new-topic` handler）、`src/main/admin-preload.js`、`admin/src/console/api.ts` | 第 2 轮 C | `newTopic(speciesId?)`：传入已遇见的角色就对她开新话题，不传仍是当前角色（桌宠窗口 `preload.js` 的调用不变）；未遇见 `not-met`、未知 `unknown-character`、忙 `busy`、未领养 `empty`。 |
| `admin/src/console/roster-model.ts`（`STATE_WORD`、`detailHref`） | B01 / B12 | C 只引用。 |
| `admin/src/useHashPath.ts`（`useHashQuery`、`replaceHash`，path 去掉 `?query`） | A / B | C13 直接使用，不改。 |
| `src/core/settings-schema.js`（`#/interject` 的 NAV / PAGES、interject.* 字段移到 `page: 'interject'`、去掉 history、`redirects.history = 'chat'`、PAGES.chat / desk 说明） | A00 / A04 / A06 | 由 A 改。C 提供的文案：`PAGES.desk`「让她在桌面上做个动作；找不到她时把她找回屏幕右下角。」；interject.enabled 说明去掉开头重复的「默认关闭。」（INT-02）。 |
| `admin/src/console/ConsoleApp.tsx`（`case 'interject'` 从 `./pages/Interject` 引入 `InterjectPage`；`#/history` 重定向） | A00 | 由 A 改；C 提供 `InterjectPage`。 |
| `admin/src/console/pages/Pages.tsx` | A（其余页面）/ C（`ProactivePage`、`BehaviorPage`） | C 只改这两个函数（去掉 `InterjectData`、「默认关闭」标签与找回按钮）。「退出应用」按钮（`data-app-quit`）由 A18 放进 `AboutPage`。 |
| `src/core/admin-coverage.js` | C | `UNUSED_OK` 增加 `historyList` / `historyGet`（聊天记录并入聊天页）；`MENU` / `VIA` 中 history、home、quit、new-topic、topics、actions、tray 显示桌宠、set-interject 的位置文案改成新路径。 |
| `test/admin-console.test.js` | A / C | C 只改「every item of the old ⋯ menu」一条：history 改为断言 `REDIRECTS.history === 'chat'`；退出断言 `Pages.tsx` 有 `data-app-quit`；重新开始对话断言在 `Chat.tsx`（第 2 轮：断言传 `activeId`，preload / main 透传 speciesId）。 |
| `test/admin-chat.test.js` | 第 2 轮 C | 新增「重新开始对话 from the chat page (C04): any met character…」：对不在桌面上的已遇见角色开新话题，当前角色不受影响，下一句不带旧上下文；`not-met` / `unknown-character` 被拒。 |
| `e2e/run.js` | A / C | C 改：`history` 场景（H1、H4、H6、H7 改为在聊天页验证，原 H5 详情页并入 H4）、`stream` S6、`frontslim` F7 / F9 / F11 / F18、`admincov` B5（到 `#/desk` 点找回桌宠）、`interject` IJ2 / IJ7（`#/interject`）；新增 `auditc` 场景注册（不在 `all` 里）。 |
| `e2e/chat-ui.js` | C | U1：rail 新顺序（A01）、会话栏只列已遇见 +「结识更多」+「正在陪你」+ 模型影响范围；U14：没遇见的角色走深链。 |
| `e2e/admin-audit-c.js`（新） | C | 前后对照截图与 C01～C14 断言，失败态用主进程替换 IPC handler 注入（`admin-chat-history`、`interject-rules`、`interject-clear-decisions`、`talk-topic`），截完恢复原 handler。第 2 轮新增 `slow` 注入（`new-topic` 晚 2.5 s 应答）断言 S-7，并新增 C04b（对不在桌面上的小G 重新开始对话）。 |
| `admin/src/console/pages/Characters.tsx`（B 拆成 `pages/character/*`） | B | C 不改；C14 在 `Store.tsx` 里用导出的 `CatalogCard` / `useDownloads` 自建下载流程，不改 `useDownloads` 的 toast（图鉴页的下载 toast 由 B 决定是否跟进「去见她」）。 |

### C.3 验证

命令与结果（工作区 `pixel-pet-ia-polish`，`unset ELECTRON_RUN_AS_NODE`）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npx tsc --noEmit -p admin/tsconfig.json` | 0 error |
| admin 构建 | `npm run build:admin` | `✓ built` |
| lobe-design lint | `node .agents/skills/lobe-design/scripts/lint-lobe.mjs admin/src/console/pages/{Chat,Interject,Together,Store,Pages}.tsx` | `0 FAIL, 1 WARN`（WARN 为 `Pages.tsx` A 包区域的 LOBE-MULTI-PRIMARY，01-issues §6 已核对为互斥出现的误报） |
| 单元测试 | `npm test` | 见 C.5（第 2 轮在最终代码上重跑） |
| 前后对照 | `PIXELPET_AUDIT_PHASE=before|after xvfb-run -a node e2e/run.js auditc` | before 12/12 步骤执行（记录缺陷现象）；after 12/12 PASS（断言 C01～C14） |
| 回归 | `xvfb-run -a node e2e/run.js history` / `chatui` / `interject` | 6/6、16/16、10/10 PASS |

before（改动前，提交 `1fe0a5e`）记录到的现象 → after：

| 步骤 | before | after |
| --- | --- | --- |
| 会话栏 | 5 位，4 位「还没见过面」，状态「在桌面」 | 只列已遇见 1 位「正在陪你」+「结识更多（还有 4 位没见过）」，模型下方「桌面上也用这个模型」 |
| 页头 ⋯ | 没有；重新开始话题在 设置 → LobeHub 与本机 | ⋯ → 重新开始对话（确认 → 「下一句会开一个新对话」） |
| 历史读取失败 | 一直转圈（未处理的 Promise 拒绝） | 「没能读取和格萝可的聊天记录」+ 原因 + 重试 |
| `#/history` | 独立的聊天记录页 | 落到聊天页 |
| 插个嘴关闭 | 在「主动搭话与好感」页底，两张表照常铺开（表格数 2） | 独立页，只有开关卡 + 一张说明卡（表格数 0） |
| 规则读取失败 | 「还没有规则」（失败被画成零条） | 表格位置「没能读取沉淀的规则」+ 重试 |
| 清空记录失败 | 弹窗关闭，误报「判断记录已清空」 | 弹窗不关，写「没能清空判断记录：她正在忙…记录没有改动」 |
| 聊聊失败 | 两条矛盾 toast：「她正在忙」+「开始聊「自我介绍」了」 | 一条：「没能聊「自我介绍」」+ 原因 + 怎么办 |
| 商店 | 单项标签栏「角色」；`#/store?show=…` 落到小屋 | 无标签栏；`?show=remote` 读入筛选 |
| 下载完成 | 「下载好了，可以切换到她」（无动作） | 「下载好了」+「去见她」→ `#/characters/grok-classic/looks` |

截图（`docs/admin-audit/screenshots/`，亮色为主，聊天另有暗色）：

- 聊天：`C-before-chat-light.png` → `C-after-chat-light.png`；`C-before-chat-dark.png` → `C-after-chat-dark.png`；`C-before-chat-header.png` → `C-after-chat-more-menu.png`、`C-after-chat-new-topic-confirm.png`、`C-after-chat-new-topic-done.png`；`C-before-chat-history-failed.png` → `C-after-chat-history-failed.png`；`C-before-history-route.png` → `C-after-history-route.png`
- 插个嘴：`C-before-interject-off.png` → `C-after-interject-off.png`；`C-before-interject-on.png` → `C-after-interject-on.png`；`C-before-interject-load-failed.png` → `C-after-interject-load-failed.png`；`C-before-interject-clear-failed.png` → `C-after-interject-clear-failed.png`
- 话题 / 桌面上的她：`C-before-topics-talk-failed.png` → `C-after-topics-talk-failed.png`；`C-before-desk.png` → `C-after-desk.png`；`C-before-behavior.png` → `C-after-behavior.png`；`C-after-about-quit.png`
- 商店：`C-before-store-light.png` → `C-after-store-light.png`、`C-after-store-dark.png`；`C-before-store-filter-url.png` → `C-after-store-filter-url.png`；`C-before-store-download-toast.png` → `C-after-store-download-toast.png`

§6 不动项核对：前后截图对照，配色（`--pet-accent`、语义色）、字体、圆角 / 阴影 / 卡片样式、角色立绘与舞台均未变化；新增元素全部是 `@lobehub/ui` 原子。

### C.4 已知限制

- ~~`askAsync` 提交期间「取消」仍可点~~：第 2 轮已补（见 C.5）。
- ~~「重新开始对话」只能作用于正在陪你的角色~~：第 2 轮已补（见 C.5）。
- 聊天历史 `ok:false`（`empty` 未唤醒 / `unknown-character`）仍按「没有对话」处理，只有 IPC 抛错才显示失败态——这两种 reason 本来就是「没有」而不是「没读出来」。

### C.5 第 2 轮：补齐 S-7 与「重新开始对话」按角色，并在最终代码上重跑

第 1 轮在 C.4 写下的两条未完成项本轮补上（都属于本包的 C04 / C08 流程），另在最终代码（含 A / B 包之后的提交）上重跑全部验证。

| 改动 | 问题 | 做了什么 | design.lobe.li | 代码 |
| --- | --- | --- | --- | --- |
| C04 / C08 补 S-7 | INT-04、HUB-03（02-plan §2 S-7「提交期间不可关闭」） | `askAsync` 改用 `@lobehub/ui` 声明式 `Modal`：确认后「确认」按钮 loading（`confirmLoading`），「取消 / 先不了」禁用（`cancelButtonProps.disabled`），右上 ✕ 隐藏（`closable`），Esc（`keyboard`）与点遮罩（`maskClosable`）都不关；结果出来后恢复：失败把原因写在弹窗里、弹窗不关，成功才关并 toast。签名、返回值、文案不变 | C-15 确认弹窗 <https://design.lobe.li/rules/C-15>；W-05 <https://design.lobe.li/rules/W-05>；M-03 #1 系统状态可见 <https://design.lobe.li/models/M-03> | `common/index.tsx`（`AskDialog` / `AskHost` / `askAsync`）、`design/DesignProvider.tsx`（挂 `AskHost`） |
| C04 按角色 | HUB-03、PG-05 | 「重新开始对话」对任一已遇见的角色可用（作用于当前打开的那段对话），不再对不在桌面上的角色置灰；主进程 `newTopic(speciesId)` 只动这个角色的 topic / epoch，正在陪你的角色不受影响 | W-03 一词一义 <https://design.lobe.li/rules/W-03>；P-03「入口和能力不一致」<https://design.lobe.li/rules/P-03> | `Chat.tsx`（`restart` 传 `activeId`，菜单去掉 disabled）、`pet-service.js`、`main.js`、`admin-preload.js`、`api.ts` |

新增 / 更新的截图（`docs/admin-audit/screenshots/`）：

- `C-after-chat-new-topic-busy.png`：确认后执行中——按钮转圈，「先不了」灰掉，没有 ✕。
- `C-after-chat-new-topic-other-menu.png`、`C-after-chat-new-topic-other-done.png`：会话栏「正在陪你」是格萝可，打开小G 的对话，⋯ →「重新开始对话」可用，确认后 toast「下一句会开一个新对话」。
- 其余 `C-after-*` 在本轮最终代码上重拍（与第 1 轮视觉一致；`C-before-*` 不变，来自改动前提交 `1fe0a5e`）。

本轮验证（工作区 `pixel-pet-ia-polish`，`unset ELECTRON_RUN_AS_NODE`，未跑 live 场景）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元测试 | `npm test` | tests 759，pass 758，fail 0，skipped 1 |
| 类型检查 | `npx tsc --noEmit -p admin/tsconfig.json` | 0 error |
| admin 构建 | `npm run build:admin` | `✓ built` |
| lobe-design lint | `lint-lobe.mjs admin/src/console/common/index.tsx admin/src/console/pages/Chat.tsx admin/src/design/DesignProvider.tsx admin/src/console/api.ts` | `0 FAIL, 0 WARN` |
| 前后对照 | `PIXELPET_AUDIT_PHASE=after xvfb-run -a node e2e/run.js auditc` | 13/13 PASS（C04 增加执行中断言；新增 C04b） |
| 回归（askAsync 的全部调用方 + 本包页面） | `xvfb-run -a node e2e/run.js <s>` | fresh 14/14（放生）、history 6/6（H7 重新开始对话）、frontslim 19/19（F11）、catalogdl 7/7（删除下载）、design 10/10（删除角色包）、admin 29/29、admincov 13/13、chatui 16/16、interject 10/10 |

auditc C04 的原始输出：`执行中：busy=true 先不了disabled=true ✕=false；按 Esc / 点遮罩 / 点先不了之后仍打开=true；成功后关闭=true`。

仍然保留的限制：聊天历史 `ok:false`（`empty` / `unknown-character`）按「没有对话」处理（见 C.4，属于「没有」而非「没读出来」）。图鉴页的下载 toast 是否加「去见她」由 B 包决定（C.2）。
