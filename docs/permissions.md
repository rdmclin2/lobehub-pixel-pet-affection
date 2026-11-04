# 授权：系统权限与 AI 可读的文件夹（T-5075）

桌宠本身不需要访问任何文件夹。文件权限只和「本机能力」有关，所以没开本机能力的人看不到文件相关的权限。

代码：`src/core/ai-folders.js`（列表与路径检查）、`src/core/responses-client.js`（本机工具）、`src/main/permissions.js`（系统权限）、`src/main/pet-service.js` `_runTurn`（路由）、引导页 `#perms`（`src/renderer`）、设置页卡片 `admin/src/console/pages/Permissions.tsx`。

## 1. 入口

| 入口 | 什么时候出现 | 内容 |
| --- | --- | --- |
| 引导页 → 授权（选角色和唤醒之间） | macOS：总是出现；Linux / Windows：只在勾了本机能力时出现，否则跳过 | macOS：麦克风；勾了本机能力时还有“下载”“桌面”“文稿”各一行，以及 AI 可读的文件夹。其它系统只有文件夹列表。“下一步”和“跳过”都直接去唤醒 |
| 设置 → LobeHub 与本机 → 文件夹与系统权限 | macOS 总是出现（至少有麦克风）；其它系统只在本机能力开着时出现 | 同上，另加“允许运行命令”开关 |

不请求辅助功能、屏幕录制、通知等桌宠用不到的权限。签名改为固定证书（T-3386）后，授权在更新后保留，所以授权页不会在每次更新后重新出现。

## 2. macOS 的系统权限

- **麦克风**：`systemPreferences.getMediaAccessStatus('microphone')` 静默读取状态；点“授权”调 `askForMediaAccess`。拒绝后只能去系统设置：`x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone`。
- **下载 / 桌面 / 文稿**：没有不弹窗就能查状态的 API。没在这里请求过的显示“未授权 / 未知”；点“授权”时读一次这个文件夹，这一次读取会弹出系统询问。读成功 → 已授权，并自动加入 AI 可读的文件夹（之后可以删）；EPERM → 已拒绝，按钮变成“去系统设置”（`…?Privacy_FilesAndFolders`）。请求过的记在 `settings.local.asked`，之后再读不会弹窗，所以每次打开都能静默刷新状态。
- 从列表里删掉文件夹不会撤销系统授权。

## 3. AI 可读的文件夹（`settings.local`）

| 字段 | 含义 |
| --- | --- |
| `folders` | `null` = 不限制；`[]` = 还没有文件夹；否则是绝对路径列表。规范化：展开 `~`、取绝对路径、折叠 `..`、去掉末尾斜杠、去重、去掉被其他条目包含的子目录、最多 50 个 |
| `allowCommands` | 是否提供 `run_command` |
| `asked` | 见上 |

**旧用户迁移**（`PetService._decideLocal`，只做一次）：升级前已经开着本机能力的人保持原样（`folders: null`、`allowCommands: true`），设置页提示“目前不限制”，添加第一个文件夹后开始限制；其他人（包括新用户）从 `folders: []`、`allowCommands: false` 开始。

**本机工具的约束**（方案 B，负责人 2026-11-04 确认）：

| 工具 | 列表生效时 |
| --- | --- |
| `read_file` / `list_directory` | 路径必须在列表内 |
| `write_file` | 路径必须在列表内（新文件按它最近的已存在父目录解析） |
| `run_command` | 只在 `allowCommands` 时提供；工作目录必须在列表内（默认第一个文件夹）。**命令本身不受限制**：shell 命令能 `cd`、写绝对路径，不进沙盒就约束不了，界面写明了这一点 |

- 检查前先 `realpath`，`..` 和指向外面的软链接都逃不出去。被拒绝时工具返回 `Error: path is outside the folders the owner allowed (…)`，模型能读到。
- 工具说明和对话提示里都附上允许的文件夹，模型一开始就不会去碰别的地方。
- 你拖给她、或用“读本机文件”交给她的文件 / 文件夹是你当场指定的：这一轮可以读，不能写。

**`lh connect` 路径**：`lh connect` 没有限制目录的参数，工具在 lh 的 daemon 里执行，桌宠无法约束。所以列表生效时，带工具的回合只走直连（Responses API，工具在应用里执行）。直连不可用（没有 lh 登录）或直连失败时，这一轮不带工具，通过 `lh agent run` 回复；桌宠窗口弹出通知“这次用不了本机工具”（带“去设置”），设置页的卡片里也显示这条提示。`lh connect` daemon 照常启动、照常绑定设备，只是不再把工具派给它。不限制（`null`）的旧用户照旧回落到 `lh connect`。

## 4. 测试

- 单测 `test/ai-folders.test.js`：列表规范化与迁移；`..` / 软链接逃逸、新文件、空列表、不限制、拖入文件只读；命令开关与 cwd；工具列表；路由（直连时工具在范围内执行、列表生效时不回落到 `lh connect`、不限制时照旧）；`permissions.js`（模拟的 macOS 和 Linux）。
- e2e：`xvfb-run -a node e2e/run.js permissions`。A 组用 `PIXELPET_E2E_PLATFORM=darwin` + `PIXELPET_E2E_PERMS`（`permissions.js fakeMac`，JSON：`mic`、`micAnswer`、`folders: { downloads: 'grant' | 'deny', … }`、`home`）模拟 macOS 的状态和回答；“添加文件夹…”用 `debug-next-open` 代替系统选择框。B / C 组是真实平台。其它场景在 `launch()` 里自动点“下一步”通过授权页（`perms: true` 关掉）。截图在 `out/e2e/permissions/`。

## 5. 需要人在 Mac 上确认

Linux 上无法触发真实的 TCC 弹窗，以下几项只能在 macOS 上人工确认：

1. 引导页点麦克风的“授权”弹出系统询问，同意后显示“已授权”。
2. 点“下载”/“桌面”/“文稿”的“授权”弹出“想访问你的‘下载’文件夹”，同意 → 已授权并加入列表；不允许 → 已拒绝。
3. “去系统设置”打开 系统设置 → 隐私与安全性 → 文件与文件夹 / 麦克风 对应的那一页。
4. 重启应用后，请求过的文件夹状态静默刷新，不再弹窗。
5. 用系统选择框添加的文件夹（如外接盘、iCloud 云盘里的目录）她能读到。
