# 语音输入（ASR）使用说明

打开语音输入后，聊天框旁边会出现一个 🎤：对着麦克风说一句，识别出的文字会填进输入框（也可以设成识别后直接发给她）。识别有两种方式，可以只用一种，也可以让一种失败时自动换另一种：

| | 方式一：LobeHub 云端识别 | 方式二：本地识别服务（whisper） |
|---|---|---|
| 识别在哪里做 | LobeHub 云端（`lh generate asr`） | 你自己电脑（或局域网电脑）上跑的 whisper 服务 |
| 需要准备 | 装好 `lh` 并登录 | 装一个 whisper 服务并让它一直开着（whisper.cpp / speaches / 其他 OpenAI 兼容服务） |
| 费用 | 按 LobeHub Credits 计费 | 免费，占本机 CPU / 内存 |
| 音频去向 | 上传到 LobeHub 云端 | 只发到你填写的地址，不经过云端 |
| 速度（实测，8 核 CPU 无 GPU） | 一句话约 2–3 秒（应用内最慢一次 18 秒） | whisper.cpp base 模型约 1.3–4 秒；启动后第一句要预热，约 16 秒 |

实现细节、探针原始输出见 [asr-design.md](asr-design.md)。

## 1. 功能说明

- **入口**：悬停宠物 → 💬 打开聊天框，输入框和“发送”之间的 🎤。只在 **高级设置 → 语音输入** 打开后显示。
- **两种按法**：
  - 点一下 🎤 开始，说完再点一下结束；
  - 按住 🎤 说话（按住超过 0.35 秒），松开就结束。
  - 录音时按 **Esc** 取消，这段录音直接丢弃。录满“最长秒数”（默认 60 秒）会自动结束；短于 0.4 秒的提示“太短了”。
- **录音时**：🎤 变成红色的 `■ Ns`，输入框上方显示「🔴 正在听 Ns / 60s」。如果她正在朗读回复，朗读会先停下，免得把她的声音录进去。
- **识别中**：🎤 变成转圈，上方显示「⏳ 识别中…（引擎名）」。
- **结果**：文字**接在**输入框已有内容后面（中间补一个空格），你可以改好再按 Enter 或“发送”。勾选“识别后直接发送”时直接发给她；如果她还在回上一句，就只填进输入框。
- **失败**：右下角弹出「🎤 语音输入没成功」，说明原因；跟设置有关的失败带一个“去设置”按钮。输入框里原来的文字不会被清掉。
- **只在按 🎤 时录音**，不常驻监听，没有唤醒词。

## 2. 打开语音输入（两种方式通用）

1. 悬停宠物 → ⋯ → **高级设置**，往下滚到 **语音输入**。
2. 勾选 **开启语音输入**。
3. **引擎** 选 “LobeHub 云端识别” 或 “本地识别服务（whisper）”（选“关闭”时 🎤 隐藏）。
4. **语言**：自动识别 / 中文 / English / 日本語 / 한국어 / Français / Deutsch / Español / Русский。只说中文时建议选“中文”，识别更稳。
5. 可选：**识别后直接发送**、**用不了时换另一个引擎**（选的引擎出错、超时或连不上时，这一句改用另一个再试一次）。
6. 点 **测试连接**：应用发一段 0.6 秒的静音给引擎（勾了“换另一个引擎”时两个都测），结果显示在按钮下面，例如 `✅ 本地识别服务（whisper）：能用（412 ms）`。静音识别出空文本也算“能用”。
7. 第一次点 🎤 时系统会询问麦克风权限（macOS 弹窗；Windows / Linux 一般不弹），允许即可。

设置保存在 `settings.json` 的 `asr` 段（Linux `~/.config/Pixel Pet Affection/`，macOS `~/Library/Application Support/Pixel Pet Affection/`，Windows `%APPDATA%\Pixel Pet Affection\`），重启后保留。界面上没有的两项可以在应用退出后直接改文件：`asr.maxSeconds`（单次最长录音秒数，5–120，默认 60）、`asr.local.timeoutSec`（本地服务超时秒数，5–120，默认 30）。

### 2.1 配置项一览（必填 / 默认值）

设置界面里的每一项都对应 `settings.json` 的 `asr` 段（默认值见 `src/core/asr.js` 的 `ASR_DEFAULTS`）：

| 适用 | 设置项（`settings.json` 键） | 必填 | 默认值 | 取值 |
|---|---|---|---|---|
| 通用 | 开启语音输入（`asr.enabled`） | 是（要用就得打开） | `false`（关闭） | `true` / `false` |
| 通用 | 引擎（`asr.engine`） | 是 | `lobehub` | `lobehub` 云端识别 / `local` 本地识别服务 / `off` |
| 通用 | 语言（`asr.language`） | 否 | `auto` | `auto` 或 `zh`、`en`、`ja` 等语言代码 |
| 通用 | 用不了时换另一个引擎（`asr.fallback`） | 否 | `false` | 打开后一种失败自动换另一种 |
| 通用 | 识别后直接发送（`asr.autoSend`） | 否 | `false` | 关闭时只填进输入框 |
| 通用 | 单次最长录音秒数（`asr.maxSeconds`，仅文件） | 否 | `60` | 5–120 |
| 方式一 LobeHub | 本机 `lh` 已登录（`lh login`） | **是** | — | 和聊天同一账号，不需要另外的 Key |
| 方式一 LobeHub | 模型（`asr.lobehub.model`） | 否 | `gpt-4o-mini-transcribe` | `gpt-4o-mini-transcribe` / `gpt-4o-transcribe`；provider 固定 `lobehub` |
| 方式二 本地 | 本地 whisper 服务在运行 | **是** | — | whisper.cpp `whisper-server` / speaches / 其他 OpenAI 兼容服务（第 4 节） |
| 方式二 本地 | 地址（`asr.local.endpoint`） | **是**（与服务端口一致） | `http://127.0.0.1:8179` | 本机 / 局域网 `http://`，公网必须 `https://`；清空恢复默认 |
| 方式二 本地 | 接口（`asr.local.api`） | 是 | `openai`（OpenAI 兼容 `/v1/audio/transcriptions`） | `openai` / `whispercpp`（`/inference`） |
| 方式二 本地 | 模型（`asr.local.model`） | 否 | `whisper-1` | whisper.cpp 忽略；speaches 填已下载的模型 id |
| 方式二 本地 | Key | 否 | 空 | 服务要求鉴权时才填，存本机 `tts-keys.json` |
| 方式二 本地 | 超时秒数（`asr.local.timeoutSec`，仅文件） | 否 | `30` | 5–120 |

## 3. 方式一：复用 LobeHub 语音识别

### 3.1 前置条件

- 安装 LobeHub CLI 并登录（和聊天用的是同一个账号）：

  ```bash
  npm install -g @lobehub/cli
  lh login
  lh whoami          # 能看到你的账号即为已登录
  ```

  应用第一次唤醒伙伴时也会引导你登录。语音输入不需要另外的 Key。
- `lh` 版本需要有 `lh generate asr` 子命令（`lh man generate asr` 能看到说明即可）。

### 3.2 使用的 provider / model

应用调用的是：

```bash
lh generate asr <临时录音文件> --provider lobehub --model <模型> [--language zh] --json
```

| 设置里的模型 | 说明 |
|---|---|
| `gpt-4o-mini-transcribe`（默认） | 快、便宜。中文偶尔把同音字听错（实测把“喂”听成“为”） |
| `gpt-4o-transcribe` | 更准，略贵 |

- provider 固定传 `lobehub`（LobeHub 托管）。**`lh` 自己的默认值 `openai / whisper-1` 在 LobeHub 上不可用**（服务端返回空消息的 500），所以应用总是显式传 provider 和 model。
- 录音是 MediaRecorder 的 webm/opus（32 kbps），直接上传，不转码。

### 3.3 限制与费用

- **费用**：按你 LobeHub 账号的 Credits 计费（与聊天同一账户），费用随录音时长增加。不想产生费用就用方式二。
- **时长**：单次最长 `maxSeconds`（默认 60 秒，最多 120 秒）。60 秒 opus 录音约 240 KB，远小于 `lh` 内联上传的 3 MB 上限；超过 3 MB 的文件 `lh` 会先上传再转写。
- **超时**：30 秒 + 每秒录音 0.1 秒，最多 60 秒。
- **需要联网**；离线时请用方式二，或勾选“用不了时换另一个引擎”。
- **返回内容**只有文本（没有分段、时间戳）。选“自动识别”时不知道识别出的语言。
- 登录失效、模型下线等“拒绝”类错误会让 LobeHub 引擎暂停 5 分钟（期间若开了回退会直接走本地）；超时、网络错误只暂停 20 秒。修改设置会立即解除暂停。

### 3.4 自检

```bash
# 在仓库根目录；agent / CI 环境里加 PIXELPET_CLEAR_JWT=1，让 lh 用本机登录而不是运行令牌
node scripts/asr-transcribe.js --engine lobehub --test
node scripts/asr-transcribe.js 某段录音.webm --engine lobehub --language zh
# 或直接用 CLI
lh generate asr 某段录音.webm --provider lobehub --model gpt-4o-mini-transcribe --language zh --json
```

`scripts/asr-transcribe.js` 走的是应用里同一套代码（`src/core/asr.js`）。

## 4. 方式二：本地 whisper 识别服务

应用支持两种接口，在设置的 **接口** 里选：

| 接口 | 请求 | 适用 |
|---|---|---|
| **OpenAI 兼容**（默认） | `POST <地址>/v1/audio/transcriptions`（multipart：`file`、`model`、`language`…） | whisper.cpp 加 `--inference-path /v1/audio/transcriptions` 启动、speaches（faster-whisper-server）、LocalAI、vLLM 等 |
| **whisper.cpp** | `POST <地址>/inference` | 用默认参数启动的 whisper.cpp `whisper-server` |

**地址**规则：本机或局域网可以用 `http://`（如 `http://127.0.0.1:8179`、`http://192.168.1.5:8179`、`http://mybox.local:8179`），公网地址必须是 `https://`。地址可以只写到端口，应用会自动补全路径；写成 `…/v1` 或完整路径也可以。

下面给出两种已在本机实测过的服务，任选其一。

### 4.1 whisper.cpp `whisper-server`（推荐，轻量）

**依赖**：`--convert` 需要 **ffmpeg**（应用上传的是 webm/opus，whisper.cpp 自己只读 wav）。没有 ffmpeg 时服务会返回 `FFmpeg conversion failed`。

#### Linux（从源码编译）

```bash
sudo apt install -y git cmake build-essential ffmpeg          # Debian/Ubuntu；其他发行版装同名包
git clone --depth 1 https://github.com/ggml-org/whisper.cpp ~/asr-hosts/whisper.cpp
cd ~/asr-hosts/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j8 --target whisper-server               # 8 核约 2 分钟
sh ./models/download-ggml-model.sh base                       # → models/ggml-base.bin（约 148 MB）
./build/bin/whisper-server -m models/ggml-base.bin \
  --host 127.0.0.1 --port 8179 --language auto --convert -t 8 \
  --inference-path /v1/audio/transcriptions
```

看到 `whisper server listening at http://127.0.0.1:8179` 即启动成功。`-t` 设为 CPU 核数。

#### macOS

```bash
brew install whisper.cpp ffmpeg          # 旧名 whisper-cpp 也可以
which whisper-server                     # 没有这个命令时，按上面 Linux 的步骤从源码编译（需 Xcode 命令行工具：xcode-select --install）
mkdir -p ~/asr-hosts/models && cd ~/asr-hosts/models
curl -L -o ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
whisper-server -m ~/asr-hosts/models/ggml-base.bin \
  --host 127.0.0.1 --port 8179 --language auto --convert \
  --inference-path /v1/audio/transcriptions
```

Apple Silicon 上 whisper.cpp 默认启用 Metal 加速，比同级 CPU 快很多。

#### Windows 10/11（x64）

1. 在 <https://github.com/ggml-org/whisper.cpp/releases> 最新一个带附件的版本里下载 `whisper-bin-x64.zip`（有 NVIDIA 显卡可选 `whisper-bin-win-cuda-12.4.0-x64.zip`），解压到 `C:\asr\whisper`，里面有 `whisper-server.exe`。
2. 安装 ffmpeg 并确认在 PATH 里：`winget install Gyan.FFmpeg`，新开一个 PowerShell，`ffmpeg -version` 能输出版本即可。
3. 下载模型并启动（PowerShell）：

   ```powershell
   cd C:\asr\whisper
   curl.exe -L -o ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
   .\whisper-server.exe -m ggml-base.bin --host 127.0.0.1 --port 8179 --language auto --convert --inference-path /v1/audio/transcriptions
   ```

4. 首次运行时 Windows 防火墙可能询问，只监听 `127.0.0.1` 时可以不放行。

#### 在桌宠里填写

| 设置项 | 填写 |
|---|---|
| 引擎 | 本地识别服务（whisper） |
| 地址 | `http://127.0.0.1:8179`（与 `--port` 一致） |
| 接口 | OpenAI 兼容（启动时加了 `--inference-path /v1/audio/transcriptions`）；**没加**就选 “whisper.cpp（/inference）” |
| 模型 | 随便填（如 `whisper-1`）：whisper.cpp 用启动时 `-m` 加载的模型，忽略这个字段 |
| Key | 留空 |

点 **保存** → **测试连接**，看到 `✅ 本地识别服务（whisper）：能用（… ms）` 即可。

### 4.2 speaches（faster-whisper，OpenAI 兼容，Docker）

[speaches](https://github.com/speaches-ai/speaches)（原 faster-whisper-server）提供标准的 `/v1/audio/transcriptions`，自带音频解码，不需要另装 ffmpeg。三个平台都用 Docker（macOS / Windows 装 Docker Desktop）：

```bash
docker run -d --name speaches -p 127.0.0.1:8000:8000 \
  -v speaches-hf-cache:/home/ubuntu/.cache/huggingface/hub \
  ghcr.io/speaches-ai/speaches:latest-cpu          # 有 NVIDIA 显卡可用 latest-cuda 并加 --gpus all
curl http://127.0.0.1:8000/health                   # → OK
curl -X POST http://127.0.0.1:8000/v1/models/Systran/faster-whisper-small   # 下载模型（约 480 MB，只需一次）
curl http://127.0.0.1:8000/v1/models                # 列表里出现 Systran/faster-whisper-small
```

Windows PowerShell 里把行尾的 `\` 去掉写成一行，`curl` 写成 `curl.exe`。

在桌宠里填写：

| 设置项 | 填写 |
|---|---|
| 地址 | `http://127.0.0.1:8000` |
| 接口 | OpenAI 兼容 |
| 模型 | `Systran/faster-whisper-small`（**必须**和已下载的模型 id 一致，speaches 按这个字段选模型） |
| Key | 留空（若给 speaches 设了 `API_KEY` 环境变量，就填同一个值） |

其他 OpenAI 兼容服务（LocalAI、vLLM、或任何实现了 `/v1/audio/transcriptions` 的服务）填法相同：地址填到端口，模型填该服务认得的模型名，需要鉴权就填 Key（以 `Authorization: Bearer <Key>` 发送）。Key 只存在本机 `userData/tts-keys.json`（有系统钥匙串时加密），不进 `settings.json`。

### 4.3 模型怎么选

| whisper.cpp 模型（`download-ggml-model.sh <名字>`） | 大小 | 说明 |
|---|---|---|
| `tiny` | 约 75 MB | 最快，中文错字多，只适合试通 |
| `base`（推荐起步） | 约 148 MB | 8 核 CPU 一句话 1.3–4 秒；偶尔输出繁体字（如“寵”） |
| `small` | 约 466 MB | 中文明显更准，CPU 上慢 2–3 倍 |
| `medium` / `large-v3-turbo` | 1.5 GB / 1.6 GB | 适合有 GPU 或 Apple Silicon 的机器 |

speaches 的模型 id 形如 `Systran/faster-whisper-small`、`Systran/faster-whisper-medium`、`deepdml/faster-whisper-large-v3-turbo-ct2`，先用 `POST /v1/models/<id>` 下载再填进设置。

### 4.4 端口

- 默认地址是 `http://127.0.0.1:8179`（应用默认值，对应上面的 whisper.cpp 命令）。whisper.cpp 自己的默认端口是 8080，容易和别的服务冲突，所以示例都显式写了 `--port`。
- **启动前先看端口有没有被占用**：Linux `ss -ltnp | grep 8179`，macOS `lsof -iTCP:8179 -sTCP:LISTEN`，Windows `netstat -ano | findstr 8179`。注意 whisper.cpp 在 Linux / macOS 上用 `SO_REUSEPORT` 监听：**端口已被另一个进程占着时它也照样打印 `listening`、不报错**，请求会随机落到旧进程上（实测）。被占用时换一个端口，比如 `--port 8189`，并把桌宠设置里的地址改成同样的端口；或者先停掉旧进程。其他服务（speaches 等）在端口被占用时会直接报 `Address already in use`。
- 服务放在局域网另一台电脑上时，启动参数用 `--host 0.0.0.0`，桌宠里填 `http://<那台机器的局域网 IP>:8179`。

### 4.5 命令行自检

```bash
# 服务本身（任选一段 wav/webm/mp3 录音）
curl -s http://127.0.0.1:8179/v1/audio/transcriptions -F file=@clip.webm -F model=whisper-1 -F response_format=json
# → {"text":"你好，今天我想喂我的宠物吃饼干。\n"}
# 用应用的识别代码（仓库根目录）
node scripts/asr-transcribe.js --engine local --endpoint http://127.0.0.1:8179 --test
node scripts/asr-transcribe.js clip.webm --engine local --endpoint http://127.0.0.1:8179 --language zh
node scripts/asr-transcribe.js clip.webm --engine local --endpoint http://127.0.0.1:8000 --model Systran/faster-whisper-small
```

## 5. 故障排查

| 现象（提示文字） | 原因 | 处理 |
|---|---|---|
| “没有麦克风权限。” | 系统拒绝了麦克风 | **macOS**：系统设置 → 隐私与安全性 → 麦克风，打开 Pixel Pet Affection，然后重开应用（未签名包被拒后不会再弹窗；可 `tccutil reset Microphone` 后重试）。**Windows**：设置 → 隐私和安全性 → 麦克风，打开“麦克风访问”和“允许桌面应用访问麦克风”。**Linux**：检查 PulseAudio/PipeWire 的输入设备（`pactl list sources short`）。 |
| “没找到麦克风。” | 没有输入设备 | 插上麦克风或在系统声音设置里选好输入设备 |
| 🎤 不出现 | 语音输入没开，或引擎选了“关闭” | 高级设置 → 语音输入：勾选开启、选一个引擎 |
| “连不上本地识别服务：http://…。它开着吗？” | 服务没启动、端口不对、地址写错 | 确认服务进程还在、端口在监听（4.4），`curl` 自检（4.5）；地址与 `--port` 一致 |
| “识别服务返回了错误 404。” | 接口选错：whisper.cpp 没加 `--inference-path` 却选了 OpenAI 兼容 | 接口改选 “whisper.cpp（/inference）”，或加上 `--inference-path /v1/audio/transcriptions` 重启服务 |
| “这段录音没法识别。” / 服务返回 `FFmpeg conversion failed` | whisper.cpp 没加 `--convert` 或机器上没 ffmpeg | 装 ffmpeg，启动参数加 `--convert` |
| “识别服务返回了错误 4xx/5xx。”（speaches） | 模型名不对或没下载 | `curl http://127.0.0.1:8000/v1/models` 看已下载的 id，设置里的模型填一致 |
| “没听清，再说一遍？” | 识别结果为空：没说话、声音太小、只录到噪声（whisper 返回 `[BLANK_AUDIO]`） | 靠近麦克风再说一遍；检查系统输入音量；语言选对（只说中文选“中文”） |
| “太短了，没录到。” | 点按不到 0.4 秒 | 点一下开始、说完再点一下；或按住说话 |
| “识别超时了。” | 本地 CPU 太慢（尤其启动后第一句要预热约 16 秒）/ 云端慢 | 本地：换更小的模型、启动后先用“测试连接”预热一次、把 `asr.local.timeoutSec` 调大；云端：检查网络 |
| “语音识别要先登录 LobeHub。” | `lh` 未登录或登录过期 | 终端 `lh login`，再点“测试连接” |
| “识别模型用不了…” | LobeHub 上该模型下线（`LobeHubModelDeprecated`） | 设置里换另一个模型 |
| “没找到能识别语音的 lh…” | 没装 `lh` 或版本太旧 | `npm install -g @lobehub/cli@latest` |
| “识别服务出错了。” | 服务端失败但没给原因（`lh` 空消息的 500、返回的不是 JSON） | 稍后重试；看下方状态行和日志 |
| 地址保存不上 | 地址不是 https，也不是本机/局域网的 http | 按第 4 节的地址规则改 |
| 识别出繁体字 | whisper base 模型的已知现象 | 换 `small` 模型，或改用 speaches / LobeHub |

**回退（换另一个引擎）**：勾选 **用不了时换另一个引擎** 后，选的引擎遇到连不上、超时、服务端错误、未登录、模型不可用时，这一句会自动改用另一个引擎再试一次（只试一次）。“没听清”和“录音没法识别”不会回退（换引擎也一样听不到）。出错的引擎会被暂时跳过（连不上/超时/服务端错误 20 秒，未登录/模型下线/没装 lh 5 分钟），状态行会显示“暂停中”；改任何语音输入设置会立即解除。

**日志**：应用的错误日志只记引擎、失败原因、耗时和字节数，不记录识别出的文字。

## 6. 隐私说明：音频去哪里

- **什么时候录**：只在你点或按住 🎤 时录音；松开 / 再点 / Esc 后立刻释放麦克风（系统的录音指示灯随即熄灭）。语音输入关闭时，应用拒绝任何麦克风请求；摄像头任何时候都不放行。
- **LobeHub 云端识别**：录音先写到系统临时目录里的一个临时文件（权限 0600，只有你能读），由 `lh` 上传到 LobeHub 云端转写，识别完立即删除。音频的后续处理遵循 LobeHub 的隐私政策。
- **本地识别服务**：录音只在内存里，直接发到你填写的地址，不经过 LobeHub，也不落盘。地址只能是本机 / 局域网的 http 或任意 https，避免误发到公网明文地址。注意：如果你填的是别人的 https 服务，音频就去了那里。
- **不保存**：应用不保存录音，不把音频或识别文字写进日志。识别出的文字只有在你发送后，才和打字聊天一样进入聊天记录（LobeHub topic 与本机聊天记录）。
- **Key**：本地服务的可选 Key 存在本机 `tts-keys.json`（有系统钥匙串时加密），界面只显示“已设置”。

## 7. 验证（开发者）

| 命令 | 内容 |
|---|---|
| `npm test` | 包含 `test/asr.test.js`：两种 provider、每种错误原文到原因的映射、回退、暂停、超时、设置迁移、麦克风权限判断 |
| `xvfb-run -a node e2e/run.js asr` | 真 Electron：Chromium 假麦克风（`--use-file-for-fake-audio-capture`）→ MediaRecorder → mock whisper 服务 → 输入框；覆盖开关、测试连接、点按 / 按住、Esc、太短、失败提示、直接发送、摄像头拒绝、重启后保留。不耗 token |
| `PIXELPET_E2E_WHISPER=http://127.0.0.1:8179 PIXELPET_E2E_ASR_WAV=<语音.wav> xvfb-run -a node e2e/run.js asr` | 额外一步 A8：把假麦克风播放的语音发给真实的 whisper 服务 |
| 再加 `PIXELPET_E2E_ASR_LOBEHUB=1`（agent 里再加 `PIXELPET_CLEAR_JWT=1`） | 额外一步 A8b：把同一段语音发给真实的 LobeHub 云端识别（用本机 `lh` 登录，消耗少量 Credits） |

`PIXELPET_E2E_ASR_EXPECT=<正则>` 可以断言识别结果；截图、录屏和 `asr-log.txt` 在 `out/e2e/asr/`。
