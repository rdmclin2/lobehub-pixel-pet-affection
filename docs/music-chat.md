# 聊天里作曲：compose_music 接入对话 / 工具调用链路（T-5090）

依赖 T-5088 的 `src/core/music.js`（MiniMax `POST /v1/music_generation`，提交 → 等待 → 下载保存）。本篇只讲它怎样接进桌宠的对话：AI 在什么时候能调用、调用时界面怎样反馈、出错怎样回传。

## 1. 接入点

| 文件 | 作用 |
| --- | --- |
| `src/core/responses-client.js` | `MUSIC_TOOL`（function tool `compose_music`，参数与 `music.buildRequest` 一致）、`createMusicTool()`（执行器：调 music 模块，把结果 / 错误写成给模型的 JSON）、`musicToolOutput()`；`ResponsesClient#run({ extraTools })`：与本机工具并列提供，`long` 工具运行时暂停本轮计时 |
| `src/main/pet-service.js` | `_musicStatus()`（独立门控）、`_musicTool(ctx)`（每轮一个，发 `music` 事件、收集保存的歌）、`_runTurn(..., { music })`、`chat()` / `chatAs()`（提示词、结果随回复下发、写进聊天记录、`toolsRan` 后的兜底）、`musicDir()` |
| `src/core/persona.js` | `MUSIC_HINT`（可作曲时）/ `musicHint()`（不可作曲时说明原因，不许假装写好） |
| `src/core/music.js` | `music.enabled` 开关；`allowInsecureLocal`（仅测试模式允许 `http://127.0.0.1` 假端点） |
| `src/core/settings-schema.js` | 设置 → 音乐创作 → **让她作曲**（`music.enabled`，默认开） |
| `src/main/main.js` | 构造 `PetService({ music: { key: () => keys.get('minimax'), userDataDir } })`；IPC `music-audio` / `music-open`（桌宠窗口）、`admin-chat-music-audio` / `admin-chat-music-open`（设置窗口，`adminOnly`）；只允许音乐保存目录内（realpath 校验）的 mp3 / wav / pcm；`music` 事件转发为 `music-status` / `admin-chat-music` |
| `src/main/preload.js` · `src/main/admin-preload.js` | `pet.onMusicStatus` / `pet.music.{audio,open,reveal}`；`petAdmin.chat.{onMusic,musicAudio,musicOpen,musicReveal}` |
| `src/core/admin-chat.js` | `messageView().music`：聊天页消息带上这一轮的歌 |
| `src/renderer/app.js` · `index.html` · `style.css` | 气泡「作曲中…《标题》 0:12」；回复后气泡下方的歌曲卡片 `#music-dock`（▶ / 暂停、标题、时长、格式、纯音乐、打开、在文件夹中显示、路径） |
| `admin/src/console/pages/MusicCard.tsx` · `Chat.tsx` · `api.ts` | 设置窗口 → 聊天：回复下的 `MusicCard`（`@lobehub/ui` 的 Block / ActionIcon / Progress / Button / CopyButton），进行中的「作曲中…」Tag |

## 2. 门控（与本机能力无关）

`PetService#_musicStatus({ plain })` → `{ on, reason }`，按顺序：

| reason | 条件 | 这一轮 |
| --- | --- | --- |
| `unsupported` | 没有注入 music（单测里的 PetService） | 不提工具，不加提示 |
| `off` | 设置 → 音乐创作 → 让她作曲 关闭（`music.enabled: false`） | 不提工具；提示词告诉她「关掉了」 |
| `no-key` | `keys.minimax`（设置 → 朗读 → MiniMax）和 `MINIMAX_API_KEY` 都没有 | 不提工具；提示「还没有填 MiniMax API Key」 |
| `via-device` | 本机能力开着且走 `lh connect` 设备（`lh agent run --device`） | 这条路带不了 function tool：不提工具，说明原因 |
| `no-direct` | 直连 Responses API 不可用（没有 lh login / 刚失败过） | 走 `lh agent run`（无工具），说明原因 |
| `null`（on） | 以上都不是 | 请求里带 `compose_music`；提示词带 `MUSIC_HINT` |

- 本机能力关着时请求的 `tools` 只有 `compose_music`，`read_file` / `run_command` 等不会因为作曲而暴露；模型若点名本机工具，回 `Error: … not available: local abilities are off`，不执行。
- 设置窗口的聊天（`chatAs`，`plain`）同样可以作曲。
- 桌宠的问候、主动搭话、插个嘴、话题不提供作曲。

## 3. 一轮怎样走

1. 用户说「来段轻松的纯音乐」→ 模型调用 `compose_music({ prompt, instrumental: true, title, mood, … })`。
2. `ResponsesClient#run` 执行：`toolsRan = true`；`long` 工具运行期间**清掉本轮计时器**，结束后重新计满 `timeoutMs`，所以一首歌几分钟也不会把整轮判超时（生成本身受 设置 → 音乐创作 → 超时 限制，默认 600 s）。
3. 执行器调 `music.generateMusic()`，过程发 `music` 事件：`composing`（开始 / 每个阶段）→ `done`（带 `{ id, title, filePath, fileUrl, durationMs, format, instrumental }`）或 `failed`（reason + 中文错误）。
4. 回给模型的 `function_call_output`（一行 JSON）：
   - 成功：`{"ok":true,"title":"雨夜小憩","filePath":"/…/music/20261104-191118-雨夜小憩.mp3","fileUrl":"file:///…","durationSec":3,"format":"mp3","instrumental":true,"shownToOwner":"…","warnings":[]}`
   - 失败：`{"ok":false,"reason":"balance","code":1008,"error":"MiniMax 账户余额或额度不足（错误码 1008）","retry":false}`（`retry` 对限流 / 服务端 / 网络 / 超时为 true）。失败不抛异常，这一轮继续，由她用自己的话说明原因。
5. 回复结束：`say` 事件带 `music: [...]`，聊天记录里她的那条消息带 `attachments.music`；设置窗口的 `messageView().music` 列出。

### toolsRan 与兜底

- 歌已经生成（可能已计费）后，后续任何失败都**不再换路重发**（不会走 `lh agent run` 再生成一次）。
- 若歌已保存而她之后的回答失败（如 502）：仍然把歌展示出来，气泡说「曲子写好了：《…》，点下面就能听～」，聊天记录照常保存，返回 `{ ok: true, partial: true }`。
- Esc / 停止：生成收到 abort（MiniMax 请求被取消），这一轮按「已停止」结束。

## 4. 界面

- **桌宠气泡**：生成中显示「♫ 作曲中…《标题》 0:12」与「通常要 1–3 分钟，Esc 可停止」，每秒走时；之前的开场白保留在上面。完成后是她的回复；歌曲卡片在气泡正下方（`#music-dock`）：▶ 在窗口里播放（`<audio>`，字节经 `music-audio` 取回转成 blob:，CSP `media-src blob:`），「用系统播放器打开」「在文件夹中显示」交给系统，路径单行显示（悬停看全路径，可选中复制）。卡片两分钟后收起（播放中、指针在上面时不收），也可以点 × 收起。
- **设置窗口 → 聊天**：她的回复下面是 `MusicCard`（播放 / 暂停、进度、打开、在文件夹中显示、路径 + 复制）；进行中的那一轮显示「作曲中…《标题》 0:05」Tag。桌面上聊出的歌也在这里出现（标「桌面」）。
- 安全：窗口拿不到任意文件，只能读写音乐保存目录里的 mp3 / wav / pcm；pcm 在窗口里放不了，提示用系统播放器打开。

## 5. 验证

```bash
npm test                                         # 全量单测（含 test/music-tool.test.js 14 例、test/music.test.js）
node --test test/music-tool.test.js              # 工具注册 / 门控 / 执行 / 错误回传 / 计时暂停 / toolsRan / chatAs
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js musicchat   # 只跑聊天作曲 C1–C8
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js music       # 音乐设置页 M1–M4 + 聊天作曲 C1–C8
```

e2e 用 `test/fixtures/fake-responses-server.js`（支持 `calls` 让回合停在 function_call 上）和 `test/fixtures/fake-minimax-music.js`（返回 3 秒的真 mp3 `test/fixtures/music-sample.mp3`），不花 token、不耗 MiniMax 额度；截图与请求记录在 `out/e2e/music/`（`chat-c*.png`、`music-chat-log.txt`、`music-chat-*-requests.json`）。
