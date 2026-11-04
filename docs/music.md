# 音乐创作（MiniMax 作曲）

在聊天里对她说「给我写首歌」「来段轻松的纯音乐」，她会自己调用 **`compose_music`** 工具，请 MiniMax 的音乐生成接口写一首。生成的音频保存到本机，歌曲卡片出现在她的回复下面，点 ▶ 就能听。

- 实现：`src/core/music.js`（MiniMax 接口：提交 → 等待 / 轮询 → 下载保存，T-5088）；接入对话的方式见 [music-chat.md](music-chat.md)（T-5090）。
- 冒烟脚本：`scripts/music-smoke.js`（`npm run music:smoke`），见[第 6 节](#6-最小可运行验证冒烟脚本)。

> **先看[第 8 节「已知限制与费用」](#8-已知限制与费用)**：MiniMax 从 2026-08-20 起不再给新用户开通付费音乐接口。新账号的 Key 可以朗读，但调用音乐接口会返回 HTTP 410 / 错误码 2153，这时她会照实告诉你写不成，不会假装写好了。

## 1. 功能说明

| 能力 | 说明 |
| --- | --- |
| 自然语言触发 | 桌宠聊天框，或设置窗口 → 聊天。模型自己判断要不要作曲，不用记命令 |
| 有人声 / 纯音乐 | 有人声：她自己写带 `[Verse]` / `[Chorus]` 段落标签的歌词，或者交给 MiniMax 按描述写词（`lyricsOptimizer`）。纯音乐 / BGM：`instrumental: true` |
| 风格提示 | 流派、情绪、场景、乐器、人声、BPM、大致时长、段落结构，合并进 prompt 发给 MiniMax（接口本身没有时长 / BPM / 结构字段） |
| 等待中的反馈 | 气泡显示「♫ 作曲中…《标题》 0:12 · 通常要 1–3 分钟，Esc 可停止」，每秒更新 |
| 结果 | 音频保存成 `<保存目录>/<yyyyMMdd-HHmmss>-<标题>.<格式>`。她的回复下面有歌曲卡片：▶ / 暂停、时长、格式、用系统播放器打开、在文件夹中显示、文件路径。歌会写进聊天记录（`attachments.music`），设置窗口 → 聊天里也有同一张卡片 |
| 失败 | 工具不抛异常，把原因（中文说明 + 错误码）回传给模型，由她用自己的话告诉你；不保存文件，也不会自动重试 |
| 不需要本机能力 | 作曲不依赖「本机能力」开关。本机能力关着时，这一轮只提供 `compose_music`，不会暴露 `read_file` / `run_command` |

## 2. 安装与配置

### 2.1 前提

1. 按 [usage.md 第一、二节](usage.md#一安装) 安装并启动：`npm install` → `npm start`。不需要额外安装依赖，作曲只用 Node 自带的 `fetch`。
2. **登录 LobeHub**：本机 `lh login`。作曲走直连 Responses API 的工具调用，没登录（或直连刚失败）时这一轮不提供工具，她会说明原因。
3. **一个开通了音乐接口的 MiniMax 账号的 API Key**：国内站 [platform.minimaxi.com](https://platform.minimaxi.com) → 账户管理 → 接口密钥；国际站 [platform.minimax.io](https://platform.minimax.io)。不需要 GroupId。

### 2.2 填 Key（二选一）

| 方式 | 做法 | 说明 |
| --- | --- | --- |
| 设置界面（推荐） | ⚙ 设置 → 设置 → 声音 → **朗读** → MiniMax 卡片 → **API Key** | 和朗读共用一个 Key（MiniMax 的 Key 按账号和站点发放，不分产品）。只写入本机 `tts-keys.json`，界面不回显，也不写进 `settings.json` |
| 环境变量 | 启动前 `export MINIMAX_API_KEY=...`，再 `npm start` | 设置界面没填 Key 时才用它。设置界面里的 Key 优先 |

在设置界面填好后，⚙ 设置 → 设置 → 声音 → **音乐创作** 的入口卡片会显示 `music-3.0 · mp3 · MiniMax Key 已设置`，没填时显示「未设置 MiniMax Key」。这张卡片只看设置界面里有没有 Key：只用环境变量时，卡片仍显示「未设置」，但作曲可以正常用。

### 2.3 设置项（⚙ 设置 → 设置 → 声音 → 音乐创作）

保存在数据目录 `settings.json` 的 `music` 段（数据目录：Linux `~/.config/Pixel Pet Affection/`，macOS `~/Library/Application Support/Pixel Pet Affection/`）。

| 设置项 | 键 | 默认 | 取值 / 说明 |
| --- | --- | --- | --- |
| 让她作曲 | `music.enabled` | 开 | 关掉后不提供工具，她被要求写歌时会说「在设置里关掉了」 |
| 端点 | `music.endpoint` | 空 | 必须是 https，不能带账号密码。留空时依次用：环境变量 `MINIMAX_MUSIC_ENDPOINT` → 「朗读 → MiniMax」的端点 → `https://api.minimax.cn`。国际站账号填 `https://api.minimax.io` |
| 模型 | `music.model` | `music-3.0` | `music-3.0`（推荐）/ `music-2.6` |
| 格式 | `music.format` | `mp3` | `mp3` / `wav` / `pcm`。pcm 在窗口里放不了，只能用系统播放器打开 |
| 采样率 | `music.sampleRate` | 44100 | 16000 / 24000 / 32000 / 44100 Hz |
| 码率 | `music.bitrate` | 256000 | 32 / 64 / 128 / 256 kbps，只对 mp3 有意义 |
| 取回方式 | `music.outputFormat` | `url` | `url`：MiniMax 返回 24 小时有效的链接，马上下载到本地；`hex`：音频直接放在响应里。两种都会存成本地文件 |
| 保存目录 | `music.outputDir` | 空 | 绝对路径，最长 500 字。留空 = `<数据目录>/music/` |
| 超时 | `music.timeoutSec` | 600 | 30–1800 秒，覆盖提交、等待、下载全过程。超时就放弃，并告诉你超时了 |
| 查询间隔 | `music.pollIntervalSec` | 3 | 1–60 秒。接口返回任务 ID 时按这个间隔轮询（现在的官方接口是同步返回，一般用不到） |

环境变量汇总：`MINIMAX_API_KEY`（Key）、`MINIMAX_MUSIC_ENDPOINT`（端点，必须是 https）。

## 3. 工具参数（`compose_music`）

模型调用时传的参数，定义在 `src/core/responses-client.js` 的 `MUSIC_TOOL`，校验在 `src/core/music.js` 的 `buildRequest`。参数不合法时返回 `reason: bad-params`，并说明哪个参数有问题。

| 参数 | 类型 | 必填 | 限制 | 作用（→ MiniMax 字段） |
| --- | --- | --- | --- | --- |
| `prompt` | string | 是 | ≤ 2000 字（加上下面的提示后合计） | 风格 / 流派 / 情绪 / 场景 / 乐器的整体描述 → `prompt` |
| `lyrics` | string | 有人声且不用 `lyricsOptimizer` 时必填 | ≤ 3500 字；行用 `\n` 分隔；段落标签只能用 `[Intro] [Verse] [Pre Chorus] [Chorus] [Interlude] [Bridge] [Outro] [Post Chorus] [Transition] [Break] [Hook] [Build Up] [Inst] [Solo]` | 歌词 → `lyrics` |
| `instrumental` | boolean | — | — | `true` = 纯音乐、没有人声，会忽略歌词 → `is_instrumental` |
| `lyricsOptimizer` | boolean | — | — | `true` = 不给歌词，MiniMax 按 prompt 写词 → `lyrics_optimizer` |
| `title` | string | — | ≤ 60 字 | 标题：用于文件名和卡片显示 |
| `genre` | string | — | ≤ 200 字 | 流派，如 pop、lo-fi、民谣 → 并入 prompt（`Genre: …`） |
| `mood` | string | — | ≤ 200 字 | 情绪，如 轻松、melancholic → `Mood: …` |
| `scene` | string | — | ≤ 200 字 | 场景，如 下雨的夜晚 → `Scene: …` |
| `instruments` | string | — | ≤ 200 字 | 主要乐器 → `Instruments: …` |
| `vocals` | string | — | ≤ 200 字，纯音乐时忽略 | 人声，如 温柔女声 → `Vocals: …` |
| `bpm` | integer | — | 40–240 | 速度提示 → `Tempo: N BPM` |
| `durationSec` | integer | — | 10–360 | 大致时长提示 → `Length: about N seconds`。实际长度由 MiniMax 决定 |
| `structure` | string[] | — | 取值同段落标签，≤ 30 段 | 段落顺序 → `Structure: Intro - Verse - …` |

模型、格式、采样率、码率、取回方式来自设置（第 2.3 节）。直接用模块时也可以按次传入 `model` / `format` / `sampleRate` / `bitrate` / `outputFormat` / `watermark`。

工具返回给模型的是一行 JSON：

```json
{"ok":true,"title":"午后咖啡时光","filePath":"/…/music/20261104-192836-午后咖啡时光.mp3","fileUrl":"file:///…","durationSec":3,"format":"mp3","instrumental":true,"shownToOwner":"the app shows this file with a play button under your reply","warnings":[]}
{"ok":false,"reason":"unavailable","code":2153,"error":"MiniMax 音乐接口已不再向新用户开放，…（错误码 2153）","retry":false}
```

## 4. 调用示例

### 4.1 自然语言（桌宠聊天框或设置窗口 → 聊天）

| 你说 | 她通常会传的参数 |
| --- | --- |
| 来段轻松的纯音乐 | `{ prompt: "Relaxed lo-fi …", instrumental: true, title: "雨夜小憩", mood: "轻松" }` |
| 给我写一首轻快的纯音乐吧，适合下午喝咖啡的时候听 | 实测（真实模型）：`instrumental: true, title: "午后咖啡时光"`，prompt 写的是吉他加钢琴的轻快爵士 |
| 写一首关于夏天的歌，女声 | `{ prompt: "Bright summer city pop …", lyrics: "[Verse]\n蝉鸣落在窗台上\n…\n[Chorus]\n…", title: "夏天的风", vocals: "female" }` |
| 唱首生日歌，歌词你帮我想 | `{ prompt: "…", lyricsOptimizer: true, title: "生日快乐" }` |

不会触发作曲的情况：推荐、搜索已有的歌，或者只是聊音乐；也不会在问候、主动搭话、插嘴、话题里作曲。

### 4.2 脚本

```bash
# 不联网、不需要 Key：走完 提交 → 轮询 → 下载 → 保存
npm run music:smoke -- --mock

# 真实生成（会扣 MiniMax 费用）：默认是一段 ~30 秒的轻松纯音乐
export MINIMAX_API_KEY=...            # 或者设置界面已填（脚本只读环境变量 / ~/.config/pixel-pet/minimax.env / ~/.zshrc / ~/.bashrc）
npm run music:smoke
npm run music:smoke -- --prompt "温柔的城市民谣，夏夜海边" --lyrics "[Verse]\n晚风吹过街角\n[Chorus]\n我们一起唱" --title 晚风
npm run music:smoke -- --lyrics-optimizer --prompt "生日快乐歌，欢快" --title 生日快乐
npm run music:smoke -- --json          # 输出一行 JSON：ok / filePath / durationMs / ffprobe 结果
```

在代码里调用（主进程或 Node 脚本）：

```js
const music = require('./src/core/music');
const r = await music.generateMusic(
  { prompt: 'Relaxed lo-fi piano, rainy evening', instrumental: true, title: '雨夜', durationSec: 60 },
  { settings: { music: { outputDir: '/tmp/songs' } }, key: process.env.MINIMAX_API_KEY, signal, onProgress: (p) => console.log(p.stage) },
);
// r = { filePath, fileUrl, durationMs, meta: { title, model, traceId, format, instrumental, bytes, … } }
// 失败时抛 music.MusicError：e.reason / e.code / e.message（中文）/ e.traceId
```

## 5. 输出位置

- 默认：`<数据目录>/music/`，例如 Linux 是 `~/.config/Pixel Pet Affection/music/20261104-192836-午后咖啡时光.mp3`。改 `music.outputDir` 可以存到别处。
- 文件名：`<年月日>-<时分秒>-<标题>.<格式>`。标题里非字母、非数字的字符换成 `-`；重名时加 `-2`、`-3`。下载时先写 `.part` 文件，写完再改名，所以中途失败不会留下半个文件。
- 歌曲卡片上的「在文件夹中显示」会打开保存目录。窗口只能读、打开保存目录里的 mp3 / wav / pcm，其他路径一律拒绝。
- 冒烟脚本：真实模式保存到 `./out/music-smoke/`，mock 模式保存到临时目录；`--out <dir>` 可以改。

## 6. 最小可运行验证（冒烟脚本）

`scripts/music-smoke.js` 调用的就是桌宠工具用的 `src/core/music.js`。它分三步：`submit` → `wait` → `save`，然后检查文件头（ID3 / MP3 帧 / RIFF WAVE）。装了 `ffprobe` 时，还会读出编码、采样率、声道和时长。

| 命令 | 联网 | 验证内容 | 预期 |
| --- | --- | --- | --- |
| `npm run music:smoke -- --mock` | 否 | 异步路径：提交后拿到 `task_id`，轮询 3 次（Processing → Processing → 完成），下载并保存 | `RESULT: PASS`，退出码 0，打印文件路径 |
| `--mock=sync` | 否 | 同步路径（现在的官方行为）：响应里直接带音频 url，下载并保存 | PASS |
| `--mock=hex` | 否 | 音频以 hex 形式在响应里 | PASS |
| `--mock=error` | 否 | MiniMax 返回 1008（余额不足） | `RESULT: FAIL reason=balance code=1008`，退出码 1 |
| `--mock=timeout` | 否 | 请求一直不返回，1.5 秒后超时 | `RESULT: FAIL reason=timeout`，退出码 1 |
| `npm run music:smoke` | 是 | 真实 MiniMax 生成 | 成功：PASS 加文件路径；失败：打印 reason / 错误码 / trace_id |

`--mock` 的输出示例：

```
music-smoke: mode=mock(async) endpoint=https://mock.minimax.local model=music-3.0 format=mp3 key=mock timeout=600s out=/tmp/music-smoke-kBuEk6
[0.0s] submitting
[0.0s] submitted task=mock-task-1
[0.0s] polling task=mock-task-1 attempt=1 status=pending
[0.2s] polling task=mock-task-1 attempt=2 status=pending
[0.4s] polling task=mock-task-1 attempt=3 status=succeeded
[0.4s] downloading
[0.4s] saved /tmp/music-smoke-kBuEk6/20261104-192527-冒烟测试-mock.mp3
file: 24494 bytes, header mp3, ffprobe mp3 44100 Hz 1 ch 3.03s
RESULT: PASS
```

脚本只打印 Key 的来源和长度，不打印 Key 本身。退出码：0 = 保存成功且文件是音频；1 = 失败（MiniMax 报错、超时等）；2 = 参数用错。

App 内验证（e2e）：

```bash
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js music       # 设置页 M1–M4 + 聊天作曲 C1–C8（假 LobeHub + 假 MiniMax，不花钱）
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js musicchat   # 只跑聊天作曲 C1–C8
# 真实模型（花 LobeHub token，需要 lh login；不在 all 里）：模型自己决定调用 compose_music
env -u ELECTRON_RUN_AS_NODE MUSIC_LIVE_MINIMAX=fake xvfb-run -a node e2e/run.js musiclive   # MiniMax 用本地替身（真实 mp3）
env -u ELECTRON_RUN_AS_NODE MUSIC_LIVE_MINIMAX=real xvfb-run -a node e2e/run.js musiclive   # MiniMax 用真实接口和本机 Key
```

截图、录屏和日志在 `out/e2e/music/`、`out/e2e/music-live-fake/`、`out/e2e/music-live-real/`。`musiclive` 跑完会删掉它创建的 LobeHub agent。

手动验证：`npm start` → 选角色、关掉本机能力、孵化 → 聊天框输入「来段轻松的纯音乐」→ 气泡出现「作曲中…」→ 回复下面出现歌曲卡片 → 点 ▶。

## 7. 失败与错误处理

所有失败都是 `MusicError`，带 `reason`、`code`（MiniMax 的 `base_resp.status_code`，或 `http-<状态码>`）和中文 `message`。在 App 里，这些信息会作为 `ok:false` 回传给模型，她用自己的话转述。`retry: true` 表示可以稍后再试；她不会自动重试，所以不会重复扣费。

| 情况 | reason | 触发条件（错误码） | 她 / 脚本给出的提示 | 处理建议 |
| --- | --- | --- | --- | --- |
| 没有 Key | `no-key` | 设置界面和 `MINIMAX_API_KEY` 都没有 | 这一轮不提供工具，她说「还没有填 MiniMax API Key」；脚本：`no MiniMax key` | 按 2.2 节填 Key |
| 鉴权失败 | `auth` | 1004、2049、HTTP 401 / 403 | 「MiniMax API Key 无效或未授权，请在 设置 → 朗读 → MiniMax 检查 Key」 | 检查 Key 是否完整；国际站的 Key 要把端点改成 `https://api.minimax.io`（国内站 Key 配国际站端点，或者反过来，都会报 2049） |
| 账号未开通音乐 | `unavailable` | 2153（HTTP 410） | 「MiniMax 音乐接口已不再向新用户开放，这个账号用不了…；Key 本身没问题」 | 换一个已开通音乐接口的老付费账号；Key 不用改。见第 8 节 |
| 限流 | `rate-limit` | 1002、1039、1041、1045、2045、2046、2047、2056、2062、HTTP 429 | 「MiniMax 请求太频繁（触发限流），请稍后再试」（`retry: true`） | 等一会儿再说一次；music-3.0 / 2.6 的上限是 120 RPM |
| 余额不足 | `balance` | 1008、2053、2067 | 「MiniMax 账户余额或额度不足」 | 去 MiniMax 控制台充值 |
| 敏感内容 | `sensitive` | 1026、1027、1040、1046 | 「内容涉及敏感信息，MiniMax 拒绝生成，请换个描述或歌词」 | 改写描述或歌词，再请她写一次 |
| 参数不合法 | `bad-params` | 本地校验（缺 prompt、歌词标签不认识、超长、超出范围），或 2013、2014、1042 | 指出是哪个参数，如「歌词里有不认识的段落标签 [Rap]，可用：…」 | 通常是模型传错了参数，再说一次她会改；脚本用户按提示改参数 |
| 模型不可用 | `model` | 2022、2061、2068、2069 | 「这个音乐模型不存在、已下线或当前账号无权使用」 | 在设置里换成 `music-2.6` / `music-3.0` |
| 服务端错误 | `server` | 1000、1001、1024、1033、2064、2066、HTTP 5xx，或响应不是 JSON | 「MiniMax 服务暂时出错 / 处理超时，请稍后重试」（`retry: true`） | 稍后重试 |
| 超时 | `timeout` | 超过 `music.timeoutSec`（默认 600 秒） | 「音乐生成超时，请稍后重试或在设置里调大超时」（`retry: true`） | 调大超时，或稍后再试。这时 MiniMax 可能已经计费 |
| 网络 | `network` | 连不上端点（DNS、断网、代理） | 「连不上 MiniMax：…」（`retry: true`） | 检查网络、代理和端点地址 |
| 下载失败 | `download` | 音频链接下载失败或超过 200 MB | 「下载音频失败（HTTP …）」 | 稍后重试；也可以把取回方式改成 `hex` |
| 保存失败 | `write` | 保存目录不能写 | 「保存音频失败：…」 | 检查 `music.outputDir` 的权限，或者留空用默认目录 |
| 取消 | `aborted` | 生成中按 Esc，或点「停止」 | 这一轮按「已停止」结束，不保存文件 | — |
| 端点不合法 | `bad-endpoint` | 端点不是 https，或者带了账号密码 | 设置页拒绝保存：「地址不合法：必须是 https…」 | 改成 https 地址 |
| 门控 | （不调用） | 设置里关了作曲；本机能力走 `lh connect` 设备；直连不可用 | 她说明为什么这次不能作曲，不会编造文件 | 打开开关，或者执行 `lh login` |

歌已经保存后，如果她的后续回复失败（例如 502），歌曲卡片照样显示，也不会换一条路重新生成，避免重复扣费。详见 [music-chat.md §3](music-chat.md#3-一轮怎样走)。

## 8. 已知限制与费用

- **新用户不能开通（重要）**：MiniMax 官方通知，2026-08-20 起付费音乐接口不再接受新用户，只有已付费的老用户能继续用。2026-11-04 在本机实测：同一个 Key 调朗读（`/v1/t2a_v2`）正常；调 `/v1/music_generation` 时，`api.minimax.cn` 和 `api.minimaxi.com` 都返回 HTTP 410 / 2153 `This Music API is no longer available to new users`，music-3.0 和 music-2.6 都一样。没有这样的老账号时，作曲功能只能用 mock / 本地替身验证。
- **费用**：每成功生成一首，都按 MiniMax 官方价格从你的账户扣费，价格以 MiniMax 控制台 / 价格页为准，本项目不收费。超时或取消时 MiniMax 那边可能已经生成并计费。冒烟脚本的真实模式也会扣费。另外，她每轮对话还会照常消耗 LobeHub 的 Credits。
- **耗时**：一首通常要 1–3 分钟，期间这一轮的对话计时暂停，以作曲超时为准。
- **时长 / BPM / 结构只是提示**：接口没有这些字段，它们写进 prompt，实际长度由 MiniMax 决定。
- **不支持**：翻唱（`music-cover`，需要参考音频）、流式输出、已停用的 `*-free` 模型。
- **链接有效期**：`url` 方式的链接 24 小时有效，App 拿到后马上下载到本地，所以本地文件不受影响。
- **只能用直连**：本机能力走 `lh connect` 设备时（`lh agent run --device`），这条路带不了 function tool，作曲不可用。
- **Key 安全**：Key 只存在本机 `tts-keys.json` 或环境变量里，不写进 `settings.json`、日志或仓库；单测会检查仓库里没有提交真实 Key（`test/music.test.js` 的 no real key is committed）。
