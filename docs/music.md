# 音乐创作（可切换服务：fal.ai MiniMax Music / ElevenLabs Music / MiniMax 官方）

在聊天里对她说「给我写首歌」「来段轻松的纯音乐」，她会自己调用 **`compose_music`** 工具，请你在设置里选的音乐服务写一首。生成的音频保存到本机，歌曲卡片出现在她的回复下面，点 ▶ 就能听。

- 实现：`src/core/music.js` 是唯一入口（`generateMusic`），按 `music.provider` 选服务（T-5651）：
  - `src/core/music-fal.js`：**fal.ai 托管的 MiniMax Music（默认）**，走 fal 队列：提交 → 轮询状态 → 取结果 → 下载。
  - `src/core/music-elevenlabs.js`：**ElevenLabs Music**，一次请求直接返回音频文件。
  - `src/core/music-minimax.js`：**MiniMax 官方音乐接口**（T-5088 的直连实现，保留为第三选项）。
  - `src/core/music-common.js`：三者共用的参数校验、错误类型、超时 / 取消、下载与保存。
- 接入对话的方式见 [music-chat.md](music-chat.md)（T-5090）。冒烟脚本：`npm run music:smoke`，见[第 6 节](#6-最小可运行验证冒烟脚本)。

## 0. 为什么要换服务：MiniMax 官方音乐接口对新用户停售

MiniMax 官方通知：2026-08-20 起付费音乐接口不再接受新用户，只有已付费的老用户能继续用。2026-11-04 在本机实测：同一个 Key 调朗读（`/v1/t2a_v2`）正常；调 `/v1/music_generation` 时 `api.minimax.cn` 和 `api.minimaxi.com` 都返回 **HTTP 410 / 错误码 2153** `This Music API is no longer available to new users`（music-3.0 与 music-2.6 都一样）。

所以按负责人的决定（T-5651）：**默认改用 fal.ai 托管的 MiniMax Music**（同一家的模型，fal 按次收费、新账号可开），**ElevenLabs Music 作为第二选择**，**MiniMax 官方直连保留为第三选择**（给仍有音乐权限的老账号）。

## 1. 三个服务对比

| | fal.ai（默认） | ElevenLabs | MiniMax 官方 |
| --- | --- | --- | --- |
| 设置值 `music.provider` | `fal` | `elevenlabs` | `minimax` |
| 模型 | `fal-ai/minimax-music/v2.6`（推荐，fal 上最新的 MiniMax Music）/ `fal-ai/minimax-music/v2.5` | `music_v2_5`（推荐，最新）/ `music_v2` / `music_v1`（已弃用，2027-01-31 下线） | `music-3.0`（推荐）/ `music-2.6` |
| 调用方式 | 异步队列：`POST https://queue.fal.run/<模型>` → 得到 `request_id` → `GET …/requests/<id>/status` 轮询（`IN_QUEUE` / `IN_PROGRESS` / `COMPLETED`）→ `GET …/requests/<id>` 取 `audio.url` → 下载；取消 = `PUT …/requests/<id>/cancel` | 同步：`POST https://api.elevenlabs.io/v1/music?output_format=…`，响应体就是音频文件 | 同步：`POST https://api.minimax.cn/v1/music_generation`，返回音频 url 或 hex |
| 鉴权头 | `Authorization: Key <FAL_KEY>` | `xi-api-key: <key>` | `Authorization: Bearer <key>` |
| Key 从哪来 | 设置 → 音乐创作 → fal.ai → API Key（新增 `keys.fal`），或 `FAL_KEY` | 与「设置 → 朗读 → ElevenLabs」共用（`keys.elevenlabs`），或 `ELEVENLABS_API_KEY` | 与「设置 → 朗读 → MiniMax」共用（`keys.minimax`），或 `MINIMAX_API_KEY` |
| 时长 | 没有字段：写进 prompt 当提示，实际长度由模型决定 | **支持**：`music_length_ms`（3–600 秒；产品页写 3 秒–5 分钟） | 没有字段：写进 prompt 当提示 |
| 歌词 | `lyrics`（≤ 3500 字，段落标签） | 没有歌词字段：作为「Lyrics:」段落写进 prompt，模型会参考但不保证逐字唱 | `lyrics`（≤ 3500 字，段落标签） |
| 纯音乐 | `is_instrumental` | `force_instrumental` | `is_instrumental` |
| 自动写词 | `lyrics_optimizer` | 不给歌词时模型自己写（原生行为） | `lyrics_optimizer` |
| BPM / 结构 / 人声 / 流派等 | 写进 prompt | 写进 prompt | 写进 prompt |
| 音频格式 | 设置里的 格式 / 采样率 / 码率（`audio_setting`：mp3 / wav / pcm） | 自己的 `music.elevenlabs.outputFormat`：`mp3_44100_128` / `mp3_44100_192` | 设置里的 格式 / 采样率 / 码率 |
| 时长显示 | fal 不返回时长：App 从文件头读出（MP3 帧 / WAV 头） | 不返回时长：同左 | 返回 `extra_info.music_duration` |
| 价格（2026-11-05 官方页） | v2.6 / v2.5 都是 **$0.15 / 首** | **$0.15 / 生成分钟**（各套餐含若干分钟；Music API 只对付费套餐开放，商用需 Starter 及以上） | 按 MiniMax 官方价格；新用户已开不了 |
| 新账号能否用 | 能（fal 账户有余额即可） | 能（需要付费套餐） | 不能（410 / 2153） |

> **费用提示**：每成功生成一首就会按所选服务计费，本项目不收费。超时或取消时，服务那边可能已经开始生成并计费（fal 会尽量取消：在队列里的直接移除，正在生成的发出取消信号但可能仍然完成）。冒烟脚本的真实模式也会扣费。她每轮对话还会照常消耗 LobeHub 的 Credits。

查过的官方文档（2026-11-05）：

- fal 模型：<https://fal.ai/models/fal-ai/minimax-music/v2.6/api>（价格 <https://fal.ai/models/fal-ai/minimax-music/v2.6>）、<https://fal.ai/models/fal-ai/minimax-music/v2.5/api>、<https://fal.ai/models/fal-ai/minimax-music/v2/api>、模型列表 <https://fal.ai/explore/text-to-music-apis>
- fal 队列：<https://fal.ai/docs/model-apis/model-endpoints/queue>；fal 错误：<https://fal.ai/docs/model-apis/errors>
- ElevenLabs 接口：<https://elevenlabs.io/docs/api-reference/music/compose>；鉴权：<https://elevenlabs.io/docs/api-reference/authentication>；错误：<https://elevenlabs.io/docs/developers/resources/errors>；能力与套餐：<https://elevenlabs.io/docs/overview/capabilities/music>；价格：<https://elevenlabs.io/pricing/api>
- MiniMax 官方：<https://platform.minimaxi.com/docs/api-reference/music-generation>、错误码 <https://platform.minimaxi.com/docs/api-reference/errorcode>

关于 fal 上的模型版本（如实记录）：fal 的模型列表里有 `minimax-music/v2.6`、`v2.5`、`v2`（$0.03/次）、`v1.5` 和不带版本的旧版。`v2` 的参数不同（prompt 只能 10–300 字、必须给 `lyrics_prompt`、没有纯音乐开关），`v1.5` 和旧版要参考音频，所以只接入 v2.6 / v2.5。fal 上**没有** MiniMax 官方的 `music-3.0`。

## 2. 安装与配置

### 2.1 前提

1. 按 [usage.md 第一、二节](usage.md#一安装) 安装并启动：`npm install` → `npm start`。不需要额外依赖，作曲只用 Node 自带的 `fetch`（不用 `@fal-ai/client` SDK）。
2. **登录 LobeHub**：本机 `lh login`。作曲走直连 Responses API 的工具调用，没登录（或直连刚失败）时这一轮不提供工具，她会说明原因。
3. **所选服务的 API Key**（三选一，默认 fal）：
   - fal.ai：在 <https://fal.ai/dashboard/keys> 创建 Key，账户要有余额（<https://fal.ai/dashboard/billing>）。
   - ElevenLabs：<https://elevenlabs.io/app/settings/api-keys>，需要付费套餐，Key 要有 Music 权限。
   - MiniMax 官方：只有已开通音乐接口的老账号能用。

### 2.2 选服务、填 Key

1. ⚙ 设置 → 设置 → 声音 → **音乐创作** → 「音乐服务」卡片 → **服务**：`fal.ai` / `ElevenLabs` / `MiniMax 官方`（默认 fal.ai）。下面只显示所选服务的卡片。
2. 填 Key：

| 服务 | 设置界面（推荐） | 环境变量 |
| --- | --- | --- |
| fal.ai | 音乐创作 → **fal.ai** 卡片 → API Key（只写入本机 `tts-keys.json` 的 `fal`，不回显，不写进 `settings.json`） | `FAL_KEY` |
| ElevenLabs | 设置 → 声音 → **朗读** → ElevenLabs 卡片 → API Key（与朗读共用） | `ELEVENLABS_API_KEY` |
| MiniMax 官方 | 设置 → 声音 → **朗读** → MiniMax 卡片 → API Key（与朗读共用） | `MINIMAX_API_KEY` |

设置界面里的 Key 优先，没有时才读环境变量。**作曲门控 = 当前所选服务有 Key**：例如选了 fal 但只填了 MiniMax 的 Key，这一轮就不提供作曲工具，她会说「音乐服务选的是 fal.ai，但还没有填它的 API Key（设置 → 音乐创作 → fal.ai，或环境变量 FAL_KEY）」。

「音乐创作」入口卡片显示 `服务 · 模型 · Key 已设置 / 未设置`，例如 `fal.ai · minimax-music/v2.6 · Key 已设置`（环境变量里的 Key 也算）。

### 2.3 设置项（⚙ 设置 → 设置 → 声音 → 音乐创作）

保存在数据目录 `settings.json` 的 `music` 段（数据目录：Linux `~/.config/Pixel Pet Affection/`，macOS `~/Library/Application Support/Pixel Pet Affection/`）。

| 卡片 | 设置项 | 键 | 默认 | 取值 / 说明 |
| --- | --- | --- | --- | --- |
| 音乐服务 | 让她作曲 | `music.enabled` | 开 | 关掉后不提供工具，她被要求写歌时会说「在设置里关掉了」 |
| 音乐服务 | 服务 | `music.provider` | `fal` | `fal` / `elevenlabs` / `minimax` |
| fal.ai | 模型 | `music.fal.model` | `fal-ai/minimax-music/v2.6` | `…/v2.6`（推荐）/ `…/v2.5` |
| fal.ai | 队列端点 | `music.fal.endpoint` | 空 | 必须 https。留空依次用 `FAL_MUSIC_ENDPOINT` → `https://queue.fal.run` |
| fal.ai | API Key | `keys.fal` | — | 只写不回显（`tts-keys.json`） |
| ElevenLabs | 模型 | `music.elevenlabs.model` | `music_v2_5` | `music_v2_5` / `music_v2` / `music_v1`（已弃用） |
| ElevenLabs | 音频格式 | `music.elevenlabs.outputFormat` | `mp3_44100_128` | `mp3_44100_128` / `mp3_44100_192`（192 kbps 需较高套餐） |
| ElevenLabs | 端点 | `music.elevenlabs.endpoint` | 空 | 必须 https。留空依次用 `ELEVENLABS_MUSIC_ENDPOINT` → 「朗读 → ElevenLabs」的端点 → `https://api.elevenlabs.io`（数据驻留可填 `https://api.us.elevenlabs.io` 等） |
| MiniMax 官方 | 模型 | `music.model` | `music-3.0` | `music-3.0` / `music-2.6` |
| MiniMax 官方 | 端点 | `music.endpoint` | 空 | 必须 https。留空依次用 `MINIMAX_MUSIC_ENDPOINT` → 「朗读 → MiniMax」的端点 → `https://api.minimax.cn`（国际站 `https://api.minimax.io`） |
| MiniMax 官方 | 取回方式 | `music.outputFormat` | `url` | `url`（24 小时有效的链接，马上下载）/ `hex` |
| 音频 | 格式 | `music.format` | `mp3` | `mp3` / `wav` / `pcm`（fal 与 MiniMax 用；pcm 窗口里放不了，只能用系统播放器打开） |
| 音频 | 采样率 | `music.sampleRate` | 44100 | 16000 / 24000 / 32000 / 44100 Hz |
| 音频 | 码率 | `music.bitrate` | 256000 | 32 / 64 / 128 / 256 kbps，只对 mp3 有意义 |
| 保存 | 保存目录 | `music.outputDir` | 空 | 绝对路径，最长 500 字。留空 = `<数据目录>/music/` |
| 保存 | 超时 | `music.timeoutSec` | 600 | 30–1800 秒，覆盖提交、排队、生成、下载全过程。超时就放弃（fal 上的任务同时取消）并告诉你 |
| 保存 | 查询间隔 | `music.pollIntervalSec` | 3 | 1–60 秒：fal 队列的状态查询间隔（ElevenLabs / MiniMax 是一次性返回，用不到） |

环境变量汇总：Key `FAL_KEY` / `ELEVENLABS_API_KEY` / `MINIMAX_API_KEY`；端点（必须 https）`FAL_MUSIC_ENDPOINT` / `ELEVENLABS_MUSIC_ENDPOINT` / `MINIMAX_MUSIC_ENDPOINT`。

## 3. 工具参数（`compose_music`）与各服务的映射

工具对模型的定义（`src/core/responses-client.js` 的 `MUSIC_TOOL`）不随服务变化；参数先在 `music-common.js` 的 `parseParams` 统一校验，再由所选服务映射成自己的字段。参数不合法时返回 `reason: bad-params`，说明哪个参数有问题。

| 参数 | 类型 | 限制 | fal.ai（MiniMax Music） | ElevenLabs | MiniMax 官方 |
| --- | --- | --- | --- | --- | --- |
| `prompt` | string，必填 | ≤ 2000 字（加上提示后合计） | `prompt`（fal 要求 ≥ 10 字符，太短会补上 "Original music" 并在 warnings 说明） | `prompt` | `prompt` |
| `lyrics` | string | ≤ 3500 字；段落标签 `[Intro] [Verse] [Pre Chorus] [Chorus] [Interlude] [Bridge] [Outro] [Post Chorus] [Transition] [Break] [Hook] [Build Up] [Inst] [Solo]` | `lyrics` | 写进 prompt（`Lyrics:` 段）**提示** | `lyrics` |
| `instrumental` | boolean | — | `is_instrumental` | `force_instrumental` | `is_instrumental` |
| `lyricsOptimizer` | boolean | — | `lyrics_optimizer` | 原生（不给歌词时模型自己写） | `lyrics_optimizer` |
| `title` | string | ≤ 60 字 | 只用于文件名和卡片 | 同左 | 同左 |
| `genre` / `mood` / `scene` / `instruments` | string | 各 ≤ 200 字 | 写进 prompt | 写进 prompt | 写进 prompt |
| `vocals` | string | ≤ 200 字；纯音乐时忽略（有 warning） | 写进 prompt | 写进 prompt | 写进 prompt |
| `bpm` | integer | 40–240 | prompt **提示** | prompt **提示** | prompt **提示** |
| `durationSec` | integer | 10–360 | prompt **提示**（`Length: about N seconds`） | **`music_length_ms`**（原生） | prompt **提示** |
| `structure` | string[] | 段落标签，≤ 30 段 | prompt **提示** | prompt **提示** | prompt **提示** |

**不会静默丢掉**：每次生成的 `meta.mapping` 记下每个字段是 `native`（原生字段）、`prompt`（写进描述）还是 `ignored`；`meta.unsupported` 列出用户可能在意、但这个服务只当提示的字段（如 fal 上的 `durationSec` / `bpm` / `structure`，ElevenLabs 上的 `lyrics` / `bpm` / `structure`）。工具回传给模型时带上 `unsupported` 和 `unsupportedNote`，工具说明要求她如实告诉你（例如「时长只是参考，fal 上由模型决定」），不能打包票。

工具返回给模型的是一行 JSON：

```json
{"ok":true,"title":"雨夜小憩","filePath":"/…/music/20261105-071200-雨夜小憩.mp3","fileUrl":"file:///…","durationSec":3,"format":"mp3","instrumental":true,"provider":"fal","model":"fal-ai/minimax-music/v2.6","shownToOwner":"the app shows this file with a play button under your reply","warnings":[],"unsupported":[{"field":"durationSec","how":"prompt-hint"},{"field":"structure","how":"prompt-hint"}],"unsupportedNote":"these fields were only a hint in the prompt (prompt-hint) or not sent (ignored) by this music service; do not promise them to the owner"}
{"ok":false,"reason":"balance","code":"http-403","error":"fal.ai 账户余额不足或已被锁定，请到 fal.ai/dashboard/billing 充值后再试（错误码 http-403）","retry":false,"provider":"fal"}
```

## 4. 调用示例

### 4.1 自然语言（桌宠聊天框或设置窗口 → 聊天）

| 你说 | 她通常会传的参数 |
| --- | --- |
| 来段轻松的纯音乐 | `{ prompt: "Relaxed lo-fi …", instrumental: true, title: "雨夜小憩", mood: "轻松" }` |
| 写一首关于夏天的歌，女声 | `{ prompt: "Bright summer city pop …", lyrics: "[Verse]\n蝉鸣落在窗台上\n…\n[Chorus]\n…", title: "夏天的风", vocals: "female" }` |
| 唱首生日歌，歌词你帮我想 | `{ prompt: "…", lyricsOptimizer: true, title: "生日快乐" }` |
| 来一分钟的钢琴曲 | `{ prompt: "Solo piano …", instrumental: true, durationSec: 60 }`（ElevenLabs 会按 60 秒生成；fal / MiniMax 只当提示） |

不会触发作曲的情况：推荐、搜索已有的歌，或者只是聊音乐；也不会在问候、主动搭话、插嘴、话题里作曲。

### 4.2 脚本

```bash
# 不联网、不需要 Key：各服务的本地替身走完整条路
npm run music:smoke -- --mock                          # fal（默认）：提交 → 排队 → 生成中 → 完成 → 取结果 → 下载 → 保存
npm run music:smoke -- --provider=elevenlabs --mock    # ElevenLabs：一次请求返回音频
npm run music:smoke -- --provider=minimax --mock       # MiniMax 官方：task_id → 轮询 → 下载
npm run music:smoke -- --mock=error|auth|timeout|cancel   # 余额不足 / 鉴权失败 / 超时（fal 会 PUT cancel）/ 取消

# 真实生成（会扣费；默认一段 ~30 秒的轻松纯音乐）
export FAL_KEY=...                     # 或 ELEVENLABS_API_KEY / MINIMAX_API_KEY（也读 ~/.config/pixel-pet/minimax.env、~/.zshrc、~/.bashrc 里的 export 行）
npm run music:smoke                                    # fal，约 $0.15
npm run music:smoke -- --provider=elevenlabs           # ElevenLabs，按时长约 $0.15/分钟
npm run music:smoke -- --prompt "温柔的城市民谣，夏夜海边" --lyrics "[Verse]\n晚风吹过街角\n[Chorus]\n我们一起唱" --title 晚风
npm run music:smoke -- --json                          # 输出一行 JSON：ok / provider / filePath / durationMs / unsupported / ffprobe 结果
```

在代码里调用（主进程或 Node 脚本）：

```js
const music = require('./src/core/music');
const r = await music.generateMusic(
  { prompt: 'Relaxed lo-fi piano, rainy evening', instrumental: true, title: '雨夜', durationSec: 60 },
  { settings: { music: { provider: 'fal', outputDir: '/tmp/songs' } }, keys: { fal: process.env.FAL_KEY }, signal, onProgress: (p) => console.log(p.stage) },
);
// r = { filePath, fileUrl, durationMs?, meta: { provider, model, taskId, mapping, unsupported, warnings, … } }
// 失败时抛 music.MusicError：e.reason / e.code / e.retryable / e.provider / e.message（中文）
```

## 5. 输出位置

- 默认：`<数据目录>/music/`，例如 Linux 是 `~/.config/Pixel Pet Affection/music/20261105-071200-雨夜小憩.mp3`。改 `music.outputDir` 可以存到别处。
- 文件名：`<年月日>-<时分秒>-<标题>.<格式>`。标题里非字母、非数字的字符换成 `-`；重名时加 `-2`、`-3`。先写 `.part` 文件，写完再改名，所以中途失败不会留下半个文件。
- 下载音频时**不带 Key**（fal.media / MiniMax 的链接是公开的签名地址）；fal 返回的状态 / 结果 / 取消地址只有和队列端点同一个主机时才使用，否则按 `owner/app` 重新拼，Key 不会发到别的主机。
- 歌曲卡片上的「在文件夹中显示」会打开保存目录。窗口只能读、打开保存目录里的音频，其他路径一律拒绝。

## 6. 最小可运行验证（冒烟脚本）

`scripts/music-smoke.js` 调用的就是桌宠工具用的 `src/core/music.js`：`submit` → `wait` → `save`，然后检查文件头（ID3 / MP3 帧 / RIFF WAVE）；装了 `ffprobe` 时还会读出编码、采样率、声道和时长。

| 命令 | 联网 | 验证内容 | 预期 |
| --- | --- | --- | --- |
| `npm run music:smoke -- --mock` | 否 | fal：提交拿到 `request_id`，轮询 3 次（IN_QUEUE → IN_PROGRESS → COMPLETED），取结果、下载、保存 | `RESULT: PASS`，退出码 0 |
| `--provider=elevenlabs --mock` | 否 | ElevenLabs：一次请求返回 mp3 | PASS |
| `--provider=minimax --mock`（及 `=sync` / `=hex`） | 否 | MiniMax：task_id 轮询 / 同步 url / hex | PASS |
| `--mock=error` | 否 | fal 403 余额不足 / ElevenLabs 402 / MiniMax 1008 | `RESULT: FAIL reason=balance …`，退出码 1 |
| `--mock=auth` | 否 | 鉴权失败 | `reason=auth retryable=false` |
| `--mock=timeout` | 否 | 一直排队（fal）/ 请求不返回，1.5 秒后超时 | `reason=timeout retryable=true`；fal 还会打印 `fal-cancel=CANCELLATION_REQUESTED` |
| `--mock=cancel` | 否 | 1 秒后取消 | `reason=aborted retryable=false`；fal 同样会 PUT cancel |
| `npm run music:smoke [--provider=…]` | 是 | 真实生成（扣费） | 成功：PASS 加文件路径；失败：打印 reason / 错误码 / 是否可重试 |

`--mock`（fal）的输出示例：

```
music-smoke: provider=fal mode=mock(async) endpoint=https://mock.fal.local model=fal-ai/minimax-music/v2.6 format=mp3 key=mock timeout=600s out=/tmp/music-smoke-gYBMhe
[0.0s] submitting
[mock fal] POST /fal-ai/minimax-music/v2.6
[0.0s] submitted task=mock-req-1 queue=1
[0.0s] queued task=mock-req-1 attempt=1 status=IN_QUEUE queue=1
[0.2s] running task=mock-req-1 attempt=2 status=IN_PROGRESS
[0.4s] polling task=mock-req-1 attempt=3 status=COMPLETED
[mock fal] GET /fal-ai/minimax-music/requests/mock-req-1
[0.4s] downloading
[0.4s] saved /tmp/music-smoke-gYBMhe/20261105-070226-冒烟测试-mock.mp3
not native on fal: durationSec(prompt-hint)
file: 24494 bytes, header mp3, ffprobe mp3 44100 Hz 1 ch 3.03s
RESULT: PASS
```

脚本只打印 Key 的来源和长度，不打印 Key 本身。退出码：0 = 保存成功且文件是音频；1 = 失败（服务报错、超时、取消等）；2 = 参数用错。

App 内验证（e2e，假 LobeHub + 三个服务的本地替身，不花钱）：

```bash
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js music       # 设置页 M1–M4（服务切换、fal Key 只写不回显）+ 聊天作曲 C1–C9（fal 默认、fal 403、切到 ElevenLabs / MiniMax）
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js musicchat   # 只跑聊天作曲 C1–C9
# 真实模型（花 LobeHub token，需要 lh login；不在 all 里）：模型自己决定调用 compose_music（T-5091，MiniMax 直连）
env -u ELECTRON_RUN_AS_NODE MUSIC_LIVE_MINIMAX=fake xvfb-run -a node e2e/run.js musiclive
```

单测：`node --test test/music.test.js test/music-tool.test.js`（fetch 全部 mock / 本地替身：fal 与 ElevenLabs 的成功、多次轮询后成功、失败、超时、取消、鉴权错误、余额、限流、内容审核、网络）。截图和日志在 `out/e2e/music/`。

手动验证：`npm start` → 设置 → 音乐创作 选服务并填 Key → 选角色、关掉本机能力、孵化 → 聊天框输入「来段轻松的纯音乐」→ 气泡出现「作曲中…」→ 回复下面出现歌曲卡片 → 点 ▶。

## 7. 失败与错误处理

所有失败都是 `MusicError`：`reason`（种类）、`code`（服务自己的码：fal 的 `error_type` / ElevenLabs 的 `detail.code` / MiniMax 的 `base_resp.status_code`，或 `http-<状态码>`）、`retryable`（稍后重试是否可能成功）、`provider` 和中文 `message`。在 App 里它们作为 `ok:false` 回传给模型（`reason` / `code` / `retry` / `provider` / `error`），她用自己的话转述；她不会自动重试，所以不会重复扣费。

| 情况 | reason | 可重试 | fal.ai | ElevenLabs | MiniMax 官方 | 她 / 脚本给出的提示（节选） |
| --- | --- | --- | --- | --- | --- | --- |
| 没有 Key | `no-key` | 否 | 没有 `keys.fal` / `FAL_KEY` | 没有 `keys.elevenlabs` / `ELEVENLABS_API_KEY` | 没有 `keys.minimax` / `MINIMAX_API_KEY` | 这一轮不提供工具，她说缺哪个服务的 Key、去哪填 |
| 鉴权失败 | `auth` | 否 | HTTP 401；403（非余额原因） | 401 `invalid_api_key` | 1004、2049、HTTP 401/403 | 「fal.ai API Key 无效或未授权，请在 设置 → 音乐创作 → fal.ai 检查 Key，或设置环境变量 FAL_KEY」 |
| 余额 / 额度不足 | `balance` | 否 | 403 `User is locked. Reason: Exhausted balance`、402 | 402 `insufficient_credits` / `payment_required`、401 `quota_exceeded` | 1008、2053、2067 | 「fal.ai 账户余额不足或已被锁定，请到 fal.ai/dashboard/billing 充值后再试」 |
| 套餐 / 账号不可用 | `unavailable` | 否 | — | 403（Music API 只对付费套餐开放） | 2153（HTTP 410，停售） | 「ElevenLabs 拒绝访问：音乐接口只对付费套餐开放…」「MiniMax 音乐接口已不再向新用户开放…可改用 fal.ai 或 ElevenLabs」 |
| 限流 | `rate-limit` | 是 | 429 | 429 `rate_limit_exceeded` / `system_busy` / `concurrent_limit_exceeded` | 1002、1039 等、HTTP 429 | 「请求太频繁（触发限流），请稍后再试」 |
| 内容审核 | `sensitive` | 否 | 422 `content_policy_violation`（提交 / 结果 / 完成状态里） | 400/422 `bad_prompt` / `bad_composition_plan`（带官方的改写建议） | 1026、1027、1040、1046 | 「内容没有通过 fal.ai 的内容审核…」「ElevenLabs 拒绝了这个描述（可能提到了受版权保护的歌手 / 歌曲）；它建议改成：…」 |
| 参数不合法 | `bad-params` | 否 | 本地校验，或 422 其他类型、400 `bad_request` | 本地校验，或 400/422 | 本地校验，或 2013、2014、1042 | 指出是哪个参数 |
| 模型 / 接口不存在 | `model` | 否 | 404 | 404 | 2022、2061、2068、2069 | 「…找不到这个模型，请在设置里换一个」 |
| 生成失败 | `task-failed` | 否 | `COMPLETED` 带 `error`（如 `no_media_generated`） | — | 任务状态失败 | 「fal.ai 这次没有生成出音频，可以换个描述再试」 |
| 服务端错误 | `server` | 是 | 5xx、`internal_server_error`、`downstream_service_error`、`runner_*`（以 `X-Fal-Needs-Retry` 为准） | 5xx | 1000、1024、1033、2064、5xx | 「服务暂时不可用，请稍后重试」 |
| 超时 | `timeout` | 是 | 超过 `music.timeoutSec`（会 PUT cancel）；504 `request_timeout` / `generation_timeout` | 超过 `music.timeoutSec` | 超过 `music.timeoutSec`；1001、2066 | 「音乐生成超时，请稍后重试或在设置里调大超时」 |
| 网络 | `network` | 是 | 连不上 | 连不上 | 连不上 | 「连不上 fal.ai：…」 |
| 取消 | `aborted` | 否 | Esc / 停止：停止轮询并 PUT cancel | Esc / 停止：放弃请求（ElevenLabs 没有取消接口） | Esc / 停止：放弃请求 | 这一轮按「已停止」结束，不保存文件 |
| 下载 / 保存失败 | `download` / `write` | 下载 5xx 可重试 | 音频链接下载失败 | — | 音频链接下载失败 | 「下载音频失败（HTTP …）」「保存音频失败：…」 |
| 端点不合法 | `bad-endpoint` | 否 | 不是 https | 不是 https | 不是 https | 设置页拒绝保存：「地址不合法：必须是 https…」 |
| 门控 | （不调用） | — | 设置里关了作曲；本机能力走 `lh connect` 设备；直连不可用 | 同左 | 同左 | 她说明为什么这次不能作曲，不会编造文件 |

歌已经保存后，如果她的后续回复失败（例如 502），歌曲卡片照样显示，也不会换一条路重新生成，避免重复扣费。详见 [music-chat.md §3](music-chat.md#3-一轮怎样走)。

## 8. 已知限制与费用

- **费用**：fal.ai 约 $0.15 / 首（v2.6、v2.5）；ElevenLabs 约 $0.15 / 生成分钟（需要付费套餐）；MiniMax 官方按其价格（新用户开不了）。以各家价格页为准。超时 / 取消时可能已经计费。
- **耗时**：一首通常要 1–3 分钟（fal 还可能排队），期间这一轮的对话计时暂停，以作曲超时为准。
- **只当提示的字段**：fal 与 MiniMax 没有时长 / BPM / 结构字段；ElevenLabs 没有歌词 / BPM / 结构字段（歌词写进描述）。这些都在 `meta.unsupported` 和工具返回里说明。
- **时长显示**：fal 与 ElevenLabs 不返回时长，App 从 MP3 帧（Xing / VBRI 或 CBR）/ WAV 头读出；读不出时卡片不显示时长。
- **不支持**：ElevenLabs 的 composition plan（分段计划）/ 参考音频 / 微调，fal 上 v2 / v1.5 / 旧版 MiniMax Music，MiniMax 翻唱（`music-cover`）、流式输出。
- **只能用直连**：本机能力走 `lh connect` 设备时（`lh agent run --device`），这条路带不了 function tool，作曲不可用。
- **Key 安全**：Key 只存在本机 `tts-keys.json` 或环境变量里，不写进 `settings.json`、日志或仓库；设置窗口只拿到「是否已设置」（`settingsView().musicStatus`）。单测会检查仓库里没有提交真实 Key（`test/music.test.js`）。
- **真实付费调用**：T-5651 只用 mock / 本地替身验证；本机没有 `FAL_KEY` / `ELEVENLABS_API_KEY`，没有做真实连通性试调，留给下一任务。
