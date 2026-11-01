# 语音识别（ASR）探针与设计

> 实测日期：2026-11-01（Linux x86_64，8 核 CPU，无 GPU；`lh` 0.0.62；Node v24.21.0；whisper.cpp `482279b`）。
> 本文分两部分：先记录两条通路的**真实命令与输出**（§1、§2），然后给出实现设计（§3 起）。本任务只做探针和设计，不改业务代码。
> 原始日志与探针脚本见 §9。

**结论（一句话）**：两条通路都实测跑通了。
- **LobeHub**：`lh generate asr <file> --provider lobehub --model gpt-4o-mini-transcribe --json` 能用，返回 `{"text": "..."}`，1.7–2.9 秒。webm/opus、wav、mp3 都能识别，中文和英文都正确。**CLI 的默认参数（`openai` / `whisper-1`）不可用**，会报 HTTP 500 并给出空的错误消息，所以 provider 和 model 必须显式传入。
- **本地**：whisper.cpp `whisper-server`（模型 `ggml-base`，开启 `--convert`）可以用 `/inference` 和 OpenAI 兼容的 `/v1/audio/transcriptions` 两种路径，返回 `{"text": "..."}`，热启动后 1.3–3.7 秒。

---

## 1. 实测：LobeHub 现有 ASR（`lh generate asr`）

### 1.1 测试音频

`lh gen tts` 走云端时报 404，不可用，所以测试音频用下面的方式合成：

| 文件 | 来源 | 内容 |
|---|---|---|
| `en.wav` / `en.mp3` / `en.webm` | `espeak-ng -v en` → ffmpeg 转码 | "Hello, I would like to feed my pet a cookie today." |
| `zh.wav` / … | `espeak-ng -v cmn` | 你好，今天我想喂我的宠物吃饼干。（espeak 的中文发音很差，见 1.3） |
| `zh2.wav` / `zh2.mp3` / `zh2.webm` | `edge-tts --voice zh-CN-XiaoxiaoNeural` → ffmpeg | 你好，今天我想喂我的宠物吃饼干。 |
| `silence.wav` | `ffmpeg -f lavfi -i anullsrc` 2 秒 | 静音 |
| `bad.webm` | `echo "not audio"` | 不是音频的字节 |
| `long.wav` | `zh2.wav` 循环 31 次，16 kHz 单声道，3.3 MB | 用来测超过 3 MB 时走上传的分支 |

webm 的编码参数与渲染层 MediaRecorder 的默认输出一致：`ffmpeg -c:a libopus -b:a 32k x.webm`。

### 1.2 CLI 形态（`lh man generate asr`）

```
lh generate asr [options] <audio-file>      # 本地路径或 URL
  --model <model>        STT model (default: "whisper-1")
  --provider <provider>  AI provider (default: "openai")
  --language <lang>      Language code (e.g. en, zh)
  --json                 Output raw JSON
```

CLI 源码（`@lobehub/cli/dist/index.js`）里的实现：小于等于 3 MB（`MAX_INLINE_AUDIO_BYTES`）的文件用 base64 内联，走 tRPC `asr.transcribe.mutate({ audioBase64, fileName, language, mimeType, model, provider })`；超过 3 MB 时先 `uploadLocalFile`，再按 `fileId` 转写，同时在 stderr 打印 `Audio is 3.3MB — uploading before transcription…`。`--json` 原样打印服务端结果；出错时在 stderr 打印 `HH:MM:SS [ERROR] ASR failed: <message>`，并以 exit 1 退出。

### 1.3 成功矩阵（`LOBEHUB_JWT= lh generate asr <f> --provider lobehub --model <m> --language <l> --json`）

| model | 文件 | 输出 `text` | 耗时 |
|---|---|---|---|
| gpt-4o-mini-transcribe | en.wav | Hello, I would like to feed my pet a cookie today. | 2.56 s |
| gpt-4o-mini-transcribe | en.mp3 | Hello, I would like to feed my pet Occic today. | 2.25 s |
| gpt-4o-mini-transcribe | en.webm | Hello, I would like to feed my pet aquatic today. | 1.86 s |
| gpt-4o-mini-transcribe | zh2.wav | 你好,今天我想为我的宠物吃饼干。 | 2.34 s |
| gpt-4o-mini-transcribe | zh2.mp3 | 你好,今天我想为我的宠物吃饼干。 | 1.67 s |
| gpt-4o-mini-transcribe | zh2.webm | 你好,今天我想为我的宠物吃饼干。 | 1.86 s |
| gpt-4o-transcribe | en.wav / en.mp3 | Hello, I would like to feed my pet a cookie today. | 2.46 / 1.87 s |
| gpt-4o-transcribe | en.webm | Hello, I would like to feed my pet Akoki today. | 1.94 s |
| gpt-4o-transcribe | zh2.wav / zh2.mp3 | 你好，今天我想喂我的宠物吃饼干。（完全正确） | 2.25 / 1.84 s |
| gpt-4o-transcribe | zh2.webm | 你好，今天我想为我的宠物吃饼干。 | 1.88 s |
| gpt-4o-mini-transcribe（不传 `--language`） | zh2.webm | 你好,今天我想为我的宠物吃饼干。 | — |

- **返回 JSON 结构只有 `{"text": "..."}`**，不包含 `language`、`segments` 或时长。所以 `lang` 只能取请求时设置的语言，没设置时为 `null`。
- 英文样本里的 "a cookie" 被识别成了 Occic、aquatic 等，原因是 espeak 机器音含糊，不是格式问题：同一个 wav 两个模型都能识别对。espeak 的中文样本（`zh.*`）识别出来是乱码，例如「e3兩萬元有三萬元…」，原因同样在输入音质。换成 edge-tts 的自然人声（`zh2.*`）后中文全部正确。
- **三种格式（webm/opus、wav、mp3）都可以识别**，结果一致。webm/opus 是 MediaRecorder 的原生输出，**不需要转码**。
- 静音 `silence.wav` 返回 `{"text": ""}`，exit 0。
- 超过 3 MB 的 `long.wav`（约 110 秒）走上传分支，10.5 秒返回完整转写（见 1.5）。
- 选型：默认用 **`gpt-4o-mini-transcribe`**（便宜、快，中文有时把「喂」听成「为」）；设置里可以换成 **`gpt-4o-transcribe`**（更准）。

### 1.4 错误形态（原始输出）

```
$ lh generate asr en.wav --json            # 带着本次 agent 运行的 hetero token
16:28:50 [ERROR] ASR failed: hetero-operation tokens are not accepted on this endpoint
exit=1
$ LOBEHUB_JWT= lh generate asr en.wav --json   # CLI 默认 openai/whisper-1
16:28:51 [ERROR] ASR failed:
exit=1                                      # 服务端 HTTP 500，message 为空（用打了日志补丁的 CLI 拷贝看到：
                                            # TRPCClientError {code: INTERNAL_SERVER_ERROR, httpStatus: 500, path: "asr.transcribe"}）
$ LOBEHUB_JWT= lh generate asr en.wav --provider lobehub --model whisper-1 --json
16:28:53 [ERROR] ASR failed: LobeHubModelDeprecated
exit=1
$ LOBEHUB_JWT= lh generate asr en.wav --provider lobehub --model no-such-model --json
16:28:55 [ERROR] ASR failed: LobeHubModelDeprecated
exit=1
$ LOBEHUB_JWT= lh generate asr missing.wav --provider lobehub --model gpt-4o-mini-transcribe --json
16:28:56 [ERROR] File not found: missing.wav
exit=1
$ LOBEHUB_JWT= lh generate asr silence.wav --provider lobehub --model gpt-4o-mini-transcribe --json
{ "text": "" }
exit=0
$ LOBEHUB_JWT= lh generate asr bad.webm --provider lobehub --model gpt-4o-mini-transcribe --json  # 不是音频
16:28:59 [ERROR] ASR failed:               # stdout 为空，stderr 是这一行
exit=1
$ LOBEHUB_JWT=invalid.jwt.token lh generate asr en.wav --provider lobehub --model gpt-4o-mini-transcribe --json
16:29:01 [ERROR] ASR failed: UNAUTHORIZED
exit=1
```

- **401**：stderr 中出现 `UNAUTHORIZED`，表示未登录或 token 无效。
- **404**：本次没有遇到。tRPC 路由 `asr.transcribe` 存在；`lh gen tts` 的 404 走的是另一个端点。
- **未知或下线的模型**：一律报 `LobeHubModelDeprecated`，**没有单独的 "model not found"**。
- **空消息的 500**：可能是 provider 没开（`openai` 在账号里是 `enabled: false`，见 `lh provider list`），也可能是音频无法解码。两种情况从 CLI 输出上区分不了。
- **超时**：本次没有遇到超时，最慢一次正常请求是 10.5 秒（3.3 MB 上传）。超时由桌宠自己的 `runLh(..., { timeoutMs })` 兜底，会得到 `LhError` 且 `code: 'ETIMEDOUT'`。
- 带本次运行的 hetero token 会被拒绝。桌面版正常启动时环境里没有 `LOBEHUB_JWT`，用的是 `lh login` 存下的凭据；在 agent 或 CI 里跑时要设置 `PIXELPET_CLEAR_JWT=1`（`cleanEnv` 会据此清空 `LOBEHUB_JWT`）。

### 1.5 用桌宠的 spawn 方式调用（`src/core/lh-client.js` 的 `runLh` + `cleanEnv`）

探针脚本 `spawn-probe.js`（§9）直接 `require` 本仓库的 `runLh` / `cleanEnv` / `findLh` / `withToolPath`，传入参数 `['generate','asr',file,'--provider','lobehub','--model','gpt-4o-mini-transcribe','--json']`：

```
bin = /usr/bin/lh
{"file":"zh2.webm","code":0,"ms":2338,"parsed":{"text":"你好,今天我想为我的宠物吃饼干。"},"stderr":""}
{"file":"en.webm","code":0,"ms":1859,"parsed":{"text":"Hello, I would like to feed my petal cookie today."},"stderr":""}
{"file":"long.wav","code":0,"ms":10539,"parsed":{"text":"你好,今天我想為我的寵物吃餅乾。你好,…（31 遍）"},"stderr":"Audio is 3.3MB — uploading before transcription…"}
{"file":"bad.webm","code":1,"ms":1633,"parsed":null,"stderr":"16:29:30 [ERROR] ASR failed:"}
```

结论：桌宠可以像现在调用 `lh agent run` 一样调用 `lh generate asr`。stdout 是 JSON，失败时 stdout 为空、exit 1，原因写在 stderr。需要注意，`lh` **只接受文件路径或 URL**，所以主进程要先把录音 Buffer 写成临时文件（见 §3.3）。

---

## 2. 实测：本地 whisper host（whisper.cpp server）

### 2.1 安装与启动（Linux / macOS 相同）

```bash
# 依赖：git、cmake、C++ 编译器；--convert 需要 ffmpeg（webm/opus、mp3 → wav）
git clone --depth 1 https://github.com/ggml-org/whisper.cpp ~/asr-hosts/whisper.cpp
cd ~/asr-hosts/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j8 --target whisper-server          # 本机约 2 分钟
sh ./models/download-ggml-model.sh base                  # → models/ggml-base.bin（148 MB；tiny 约 75 MB）
# 用 whisper.cpp 原生路径 /inference 启动
./build/bin/whisper-server -m models/ggml-base.bin --host 127.0.0.1 --port 8178 --language auto --convert -t 8
# 用 OpenAI 兼容路径启动（推荐给桌宠用）
./build/bin/whisper-server -m models/ggml-base.bin --host 127.0.0.1 --port 8179 --language auto --convert -t 8 \
  --inference-path /v1/audio/transcriptions
```

- 默认端口是 8080，容易和别的服务冲突，所以示例改用了 8178 / 8179。默认只监听 127.0.0.1。
- 模型下载用 `models/download-ggml-model.sh <tiny|base|small|…>`，脚本从 Hugging Face `ggerganov/whisper.cpp` 拉取。macOS 上 `brew install whisper-cpp` 也可以装出 `whisper-server`。
- **不加 `--convert` 时只能处理 wav**。MediaRecorder 产出的 webm/opus 需要这个开关，并且依赖机器上已经装了 ffmpeg。

### 2.2 请求与响应（原始输出）

```
$ curl -s http://127.0.0.1:8178/inference -F file=@zh2.webm -F response_format=json -F language=auto
{"text":"你好,今天我想为我的寵物吃饼干。\n"}
http=200 time=16.522225s        ← 进程启动后的第一次请求（预热）
$ curl -s http://127.0.0.1:8178/inference -F file=@zh2.wav -F response_format=json -F language=auto
{"text":"你好,今天我想为我的寵物吃饼干。\n"}
http=200 time=3.725387s
$ … zh2.mp3 → 同上 3.24 s；en.webm / en.wav / en.mp3 → {"text":" Hello, I would like to feed my pet a cookie to me.\n"} 2.7–3.2 s
$ curl -s http://127.0.0.1:8178/inference -F file=@zh2.webm -F response_format=verbose_json -F language=zh
{"task":"transcribe","language":"chinese","duration":3.50…,"text":"你好,今天我想为我的寵物吃饼干。\n","segments":[…],"detected_language":"chinese",…}
$ curl -s http://127.0.0.1:8178/v1/audio/transcriptions -F file=@en.webm -F model=whisper-1
File Not Found (/v1/audio/transcriptions)
http=404                          ← 默认启动没有 OpenAI 路径
$ curl -s http://127.0.0.1:8178/inference -F file=@bad.webm -F response_format=json
{"error":"FFmpeg conversion failed."}
http=500
$ curl -s http://127.0.0.1:8178/inference -F response_format=json      # 没带文件
Invalid request
http=400
$ curl -s http://127.0.0.1:8178/inference -F file=@silence.wav -F response_format=json
{"text":" [BLANK_AUDIO]\n"}
http=200
$ curl -s --max-time 2 http://127.0.0.1:8179/inference -F file=@en.wav   # host 未启动（当时 8179 未起）
http=000  curl exit=7
# OpenAI 兼容路径（--inference-path /v1/audio/transcriptions）
$ curl -s http://127.0.0.1:8179/v1/audio/transcriptions -H 'Authorization: Bearer sk-local' -F file=@en.webm -F model=whisper-1 -F response_format=json
{"text":" Hello, I would like to feed my pet a cookie to me.\n"}
http=200 time=5.803820s
$ curl -s http://127.0.0.1:8179/v1/audio/transcriptions -H 'Authorization: Bearer sk-local' -F file=@zh2.webm -F model=whisper-1 -F response_format=json
{"text":"你好,今天我想为我的寵物吃饼干。\n"}
http=200 time=2.992591s
```

用主进程会采用的方式复测：Node 24 内置的 `fetch` + `FormData` + `Blob`，`AbortSignal.timeout(20000)`，脚本是 `fetch-probe.js`：

```
{"url":"http://127.0.0.1:8179/v1/audio/transcriptions","status":200,"ms":1350,"body":"{\"text\":\"你好,今天我想为我的寵物吃饼干。\\n\"}"}
{"url":"http://127.0.0.1:8178/inference","status":200,"ms":2420,"body":"{\"text\":\" Hello, I would like to feed my pet a cookie to me.\\n\"}"}
{"url":"http://127.0.0.1:8177/v1/audio/transcriptions","error":"TypeError","cause":"ECONNREFUSED","ms":12}
```

要点：
- 返回的文本**带前导空格和结尾的 `\n`**，需要 `trim()`。静音时返回 `[BLANK_AUDIO]`，应当视为空结果。
- base 模型偶尔会把简体中文转成繁体（例如「寵」），可以在 prompt 字段里传简体提示，或换 small 模型。是否做简繁归一化留给实现阶段决定，设计里只把它作为一个可选的后处理。
- whisper.cpp 会忽略 `Authorization` 头。OpenAI 兼容路径会忽略 `model` 字段，用启动时加载的模型。
- 其他 OpenAI 兼容的 host（speaches / faster-whisper-server、LocalAI、vLLM 等）用的是同一套 `POST /v1/audio/transcriptions` multipart 协议，桌宠的 `openai` 形态可以直接对接这些服务。本次只实测了 whisper.cpp。

---

## 3. 统一 provider 接口（`src/core/asr.js`，仿 `src/core/tts.js`）

### 3.1 形态

```js
// PROVIDERS[id] = { id, label, needsKey, available(ctx), config(set), transcribe(cfg, audio, ctx) -> { text, lang } }
//   audio = { buffer: Buffer, mime: 'audio/webm' | 'audio/wav' | 'audio/mpeg', ms }   // ms：录音时长
//   ctx   = { signal, timeoutMs, key, endpoint, lh, fetch, tmpDir }
//   失败时 throw new AsrError(reason, message)
class AsrError extends Error { constructor(reason, message) { super(message || reason); this.reason = reason; } }
const PROVIDERS = { lobehub: LOBEHUB, local: LOCAL };
```

`AsrError.reason` 取值如下，并据此决定熔断时长：

| reason | 来源 | 熔断（同 tts.js 的 `pauseFor`） |
|---|---|---|
| `unauthorized` | lh stderr 含 `UNAUTHORIZED` / `hetero-operation tokens`；local HTTP 401/403 | 5 分钟（`BREAKER_MS`） |
| `model` | lh stderr 含 `LobeHubModelDeprecated` | 5 分钟 |
| `no-lh` | `LhError` 且 `code === 'ENOENT'` | 5 分钟 |
| `bad-audio` | local HTTP 400 或 `FFmpeg conversion failed`；lh 空消息 500 且录音不足 0.3 秒 | 不熔断，只影响这一次 |
| `server` | lh 空消息的 `ASR failed:`；local HTTP 5xx | 20 秒（`TRANSIENT_PAUSE_MS`） |
| `timeout` | `LhError ETIMEDOUT`；fetch `TimeoutError` | 20 秒 |
| `network` | fetch `ECONNREFUSED` / `ENOTFOUND`（host 没开） | 20 秒 |
| `canceled` | 用户按 Esc 或松手太快 | 不熔断 |
| `empty` | 文本 trim 后为空，或是 `[BLANK_AUDIO]` | 不熔断，提示「没听清」 |
| `too-long` | 录音超过 `maxSeconds` | 不熔断（录音端已截断，一般不会出现） |

### 3.2 `AsrEngine`（主进程）

- `transcribe(settings, audio, { signal })`：先按 §4 的 `provider` 选出链路，`auto` 时为 `[local（已配置 endpoint）, lobehub]`。然后跳过 `health[id].until > now` 的 provider，依次调用。返回 `{ ok: true, text, lang, provider, ms }`，全部失败时返回 `{ ok: false, reason, message }`。
- **超时**：lobehub 用 `20 s + 0.1 × 录音秒数`，上限 60 s（3.3 MB 上传实测 10.5 s）。local 默认 30 s，可在设置里调到 120 s（CPU 推理，预热第一次实测 16.5 s）。
- **熔断**：沿用 tts.js 的 `health = { [id]: { until, reason, at } }` 和 `pauseFor(reason)`。修改设置或 key 时调用 `reset(id)`。
- **并发**：同一时刻只允许一次识别。新的录音会 abort 正在进行的识别（`AbortController` 传给 `runLh({ signal })` 或 `fetch({ signal })`）。
- **日志**：只记 provider、reason、耗时和字节数，**不记录识别出的文本，也不保存音频**。

### 3.3 `lobehub`：调用 lh CLI

```js
const LOBEHUB = {
  id: 'lobehub', label: 'LobeHub 云端识别', needsKey: false,
  available: (ctx) => ctx.online !== false,                       // 用户是否登录要等第一次调用才能知道
  config: (set) => ({ model: set.lobehub.model || 'gpt-4o-mini-transcribe', language: set.language }),
  async transcribe(cfg, audio, { lh, signal, timeoutMs, tmpDir }) {
    const file = path.join(tmpDir, `asr-${process.pid}-${Date.now()}.${extFor(audio.mime)}`); // webm|wav|mp3
    fs.writeFileSync(file, audio.buffer, { mode: 0o600 });
    try {
      const args = ['generate', 'asr', file, '--provider', 'lobehub', '--model', cfg.model, '--json'];
      if (cfg.language !== 'auto') args.push('--language', cfg.language);
      const r = await lh.run(args, { timeoutMs, signal });           // = runLh(bin, args, { env: cleanEnv … })
      if (r.code !== 0) throw lhAsrError(r.stderr);                  // 按 §3.1 的表把 stderr 映射成 reason
      const text = String(JSON.parse(r.stdout).text || '').trim();
      if (!text) throw new AsrError('empty');
      return { text, lang: cfg.language === 'auto' ? null : cfg.language };
    } finally { fs.rmSync(file, { force: true }); }
  },
};
```

- **必须显式传 `--provider lobehub --model …`**，因为 CLI 默认的 `openai/whisper-1` 实测会报 500。
- `LhClient` 里新增一个薄方法 `asr(file, opts)`，复用 `_env()`（workspace 作用域、PATH 修正、`cleanEnv`），和 `lh agent run` 走同一套 spawn 逻辑。
- 临时文件放在 `app.getPath('temp')/pixel-pet-asr/`，权限 0600，在 `finally` 里删除。
- 费用：走 LobeHub Credits 计费。
- **备选的复用方式**（以后服务端模型改名时用）：模型名放在设置里，可以改成 `gpt-4o-transcribe`。如果 LobeHub 账号启用了 `openai` provider 并配了 Key，也可以设成 `--provider openai --model whisper-1`。
- 不同服务端的报错形态不一样，`lhAsrError` 只按关键字匹配，匹配不上时归为 `server`。

### 3.4 `local`：HTTP endpoint

```js
const LOCAL_APIS = ['openai', 'whispercpp'];
const LOCAL = {
  id: 'local', label: '本地识别服务', needsKey: false,                // Key 可选
  available: (ctx) => !!ctx.endpoint,
  config: (set) => ({ api: set.local.api, model: set.local.model || 'whisper-1', language: set.language }),
  async transcribe(cfg, audio, { endpoint, key, fetch, signal }) {
    const base = endpoint.replace(/\/+$/, '');
    const url = cfg.api === 'whispercpp' ? `${base}/inference` : `${base.replace(/\/v1$/, '')}/v1/audio/transcriptions`;
    const form = new FormData();
    form.append('file', new Blob([audio.buffer], { type: audio.mime }), `clip.${extFor(audio.mime)}`);
    form.append('model', cfg.model);
    form.append('response_format', 'verbose_json');                  // whisper.cpp 和 OpenAI 都支持，能拿到 language
    form.append('temperature', '0');
    if (cfg.language !== 'auto') form.append('language', cfg.language);
    const res = await fetch(url, { method: 'POST', body: form, signal,
      headers: key ? { Authorization: `Bearer ${key}` } : {} });
    if (!res.ok) throw new AsrError(res.status === 401 || res.status === 403 ? 'unauthorized' : res.status === 400 ? 'bad-audio' : `http-${res.status}`);
    const j = await res.json().catch(() => { throw new AsrError('server', 'not json'); });
    const text = String(j.text || '').replace(/\[BLANK_AUDIO\]/g, '').trim();
    if (!text) throw new AsrError('empty');
    return { text, lang: normLang(j.language) || (cfg.language !== 'auto' ? cfg.language : null) }; // 'chinese' → 'zh'
  },
};
```

- `openai` 形态对接 whisper.cpp（需要加 `--inference-path /v1/audio/transcriptions`）、speaches、LocalAI、OpenAI 官方等。
- `whispercpp` 形态对接用默认参数启动的 `whisper-server`。
- 设置页提供「测试连接」按钮：用内置的约 1 秒的短音频（随包附带的 `assets/asr-probe.webm`）调一次，显示耗时和返回的文字，同时提醒 whisper.cpp 需要加 `--convert`。

---

## 4. 设置项（`src/core/settings.js`）

在 `DEFAULTS` 里加入 `asr: ASR_DEFAULTS`；`normalizeSettings` 中调用 `s.asr = normalizeAsr(s.asr)`，`normalizeAsr` 写在 `core/asr.js`，与 `normalizeTts` 的做法一致。

```js
const ASR_DEFAULTS = {
  enabled: false,                 // 默认关闭，开启时再请求麦克风权限
  provider: 'lobehub',            // 'lobehub' | 'local' | 'auto'（auto 先试 local，失败再用 lobehub）
  language: 'auto',               // 'auto' | 'zh' | 'en' | 'ja' …（ISO-639-1）
  mode: 'hold',                   // 'hold' 按住说话 | 'toggle' 点一下开始、再点一下停止
  autoSend: false,                // true 时识别完直接发送；false 时填进输入框等用户确认
  maxSeconds: 60,                 // 单次录音上限（opus 32 kbps 下约 240 KB，远小于 lh 内联上限 3 MB）
  lobehub: { model: 'gpt-4o-mini-transcribe' },
  local: { endpoint: '', api: 'openai', model: 'whisper-1', timeoutSec: 30 },
};
```

normalize 规则：
- `provider`、`mode`、`local.api` 都按白名单取值。
- `language` 必须匹配 `/^(auto|[a-z]{2})$/`。
- `maxSeconds` 限制在 5–120。
- `endpoint` 要求是 http(s) URL，复用 tts.js 的 `endpointOk`。
- `model` 必须匹配 `/^[A-Za-z0-9._:-]{1,80}$/`。

本地服务的 **API Key（可选）** 不放进 settings.json，而是存进 `TtsKeyStore`（userData/tts-keys.json，用 safeStorage 加密），id 为 `asrlocal`（满足 `/^[a-z]{2,20}$/`）。渲染层只能看到「是否已设置」。

---

## 5. 渲染层录音方案

1. **入口**：在聊天行 `#chat-row` 的发送按钮左边加一个 🎤 按钮 `#chat-mic`，只在 `asr.enabled` 时显示。快捷键：聊天框打开时，按住 `Ctrl/⌘+Shift+Space` 等同于按住按钮。
2. **采集**：`navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`，然后创建 `new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 })`。如果 `MediaRecorder.isTypeSupported` 返回 false，就退回浏览器默认格式，mime 原样传给主进程。
3. **交互**：
   - `hold` 模式：`pointerdown` 开始录，`pointerup` / `pointerleave` 结束。
   - `toggle` 模式：点一下开始，再点一下结束。
   - 两种模式下 Esc 都会取消；录到 `maxSeconds` 时自动结束。
   - 录音不足 0.4 秒时直接丢弃，提示「按住说话」。
   - 录音时按钮变成红点并显示秒数，宠物进入「在听」姿态（`pose('listen')`，没有这个姿态的形象就保持 idle）。
   - **开始录音时调用 `stopSpeech('listening')`**，停掉她正在播放的 TTS，避免被录进去。
4. **结束**：在 `onstop` 里把 chunks 拼成 Blob，调用 `await blob.arrayBuffer()` 和 `window.pet.asrTranscribe(arrayBuffer, blob.type, ms)`，之后立刻执行 `stream.getTracks().forEach(t => t.stop())` 释放麦克风，让系统的录音指示灯熄灭。
5. **IPC**（preload 新增）：
   ```js
   asrTranscribe: (bytes, mime, ms) => ipcRenderer.invoke('asr-transcribe', { bytes, mime, ms }), // bytes: ArrayBuffer，结构化克隆后主进程用 Buffer.from() 接收
   asrCancel:     () => ipcRenderer.send('asr-cancel'),
   setAsr:        (patch) => ipcRenderer.invoke('set-asr', patch),
   asrTest:       () => ipcRenderer.invoke('asr-test'),
   ```
   主进程的 `ipcMain.handle('asr-transcribe')` 会校验 `bytes.byteLength ≤ 8 MB` 并且 mime 以 `audio/` 开头，然后调用 `AsrEngine.transcribe`。
6. **CSP**：`getUserMedia` 和 MediaRecorder 不受 `connect-src` / `media-src` 限制，现有 CSP 不需要修改，音频也不会从渲染层直接发到网络。

## 6. 识别结果的去向

- `autoSend: false`（默认）：识别出的文字**追加**到 `#chat-input`（输入框不为空时先补一个空格），聚焦并把光标移到末尾。用户可以修改后按 Enter 或点「发送」，走现有的 `send()`，图片和文件附件逻辑不变。
- `autoSend: true`：先把文字填进输入框，再直接调用 `send()`。如果此时 `thinking` 为 true（她还在回上一句），就只填进输入框，并提示「等她说完再发」。
- 失败时用现有的 `say(…, 'error', 'fallback')` 气泡提示：
  - `empty`：（没听清，再说一遍？）
  - `unauthorized`：（语音识别要先登录 LobeHub）
  - `network`：（本地识别服务没开：<endpoint>）
  - `timeout`：（识别超时了）
  - `model`：（识别模型不可用，去 高级设置 → 语音输入 换一个）

  输入框里原有的文字保持不动。
- 本地 HTTP API（`api-server.js`）这次**不提供** ASR 路由，等以后有需要再加。

## 7. 隐私与麦克风权限

- **只在用户按下按钮时录音**。不做常驻监听，也不做唤醒词。设置默认关闭，第一次打开开关时说明音频会去哪里：「LobeHub 模式：录音上传到 LobeHub 云端转写，按 Credits 计费；本地模式：录音只发到你填写的地址」。
- 音频不写进日志，也不长期落盘。lobehub 模式会产生一个临时文件（0600 权限，用完在 `finally` 里删除）；local 模式全程只在内存里。识别出的文字只在进入聊天后，才和普通聊天一样保存到 LobeHub topic。
- **Electron 权限**：在 `app.whenReady` 里给默认 session 设置：
  ```js
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const ours = wc.getURL().startsWith('file://');                   // 只允许本应用页面
    if (permission === 'media') return cb(ours && settings.asr.enabled && (details.mediaTypes || []).every((t) => t === 'audio'));
    cb(false);                                                        // 其他权限一律拒绝
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission !== 'media' || (settings.asr.enabled && wc && wc.getURL().startsWith('file://')));
  ```
  这里只放行音频，不放行摄像头，访客窗口（`?visitor=`）也一并适用。现有代码里还没有设置任何 permission handler，加上之后其他权限变成默认拒绝，需要回归一下通知和剪贴板相关的功能。
- **macOS**：
  - `package.json` 的 `build.mac.extendInfo` 加 `"NSMicrophoneUsageDescription": "按住说话时，桌宠需要使用麦克风把你的话转成文字。"`。没有这个键时，macOS 会直接拒绝或导致崩溃。
  - 开启开关或第一次录音前，先调用 `systemPreferences.getMediaAccessStatus('microphone')`；状态为 `not-determined` 时调用 `await systemPreferences.askForMediaAccess('microphone')`。状态为 `denied` 时引导用户去「系统设置 → 隐私与安全性 → 麦克风」。
  - 当前 `hardenedRuntime: false`；以后如果开启，需要在 entitlements 里加 `com.apple.security.device.audio-input`。
- **Windows**：系统「隐私 → 麦克风 → 允许桌面应用访问」关闭时，`getUserMedia` 会抛出 `NotAllowedError`，提示用户去打开即可。**Linux**：不需要额外处理。
- `NotFoundError`（没有麦克风）和 `NotAllowedError` 在渲染层捕获，转成一句提示，不进入 AsrEngine。

## 8. 实现切分与测试建议（给下游任务）

1. `src/core/asr.js`：PROVIDERS、AsrError、AsrEngine、normalizeAsr、stderr 映射。单元测试用伪造的 lh（`runLh` 注入）和 fetch，覆盖 §1.4 / §2.2 的每一种错误原文、熔断和超时。
2. `settings.js` 和 `TtsKeyStore` 加 `asr` 字段，配套测试。
3. 主进程：添加 IPC、permission handler、mac `extendInfo`。
4. 渲染层：🎤 按钮、MediaRecorder 和设置面板「语音输入」。e2e 可以用 Chromium 的 `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>` 喂入固定音频，跑通「录音 → 识别 → 输入框出现文字」。
5. 文档：在 `docs/usage.md` 加 whisper.cpp 的安装和启动步骤（§2.1），以及 LobeHub 模式的说明。

## 9. 证据与复现

- 测试音频、日志和探针脚本在实测机器上的位置（不入库）：
  - `/tmp/asr-probe/`：`lobehub-matrix.log`、`lobehub-zh2.log`、`lobehub-errors.log`、`spawn-probe.log`、`whispercpp-curl.log`、`whispercpp-oai-curl.log`、`fetch-probe.log`、`whisper-server.log`
  - `/tmp/asr-scripts/`：`spawn-probe.js`、`fetch-probe.js`
- 复现 LobeHub 路径：`LOBEHUB_JWT= lh generate asr <file> --provider lobehub --model gpt-4o-mini-transcribe --language zh --json`（在桌面版里直接 `lh …` 就行，不需要 `LOBEHUB_JWT=`）。
- 复现本地路径：按 §2.1 启动后执行 `curl -s http://127.0.0.1:8179/v1/audio/transcriptions -F file=@clip.webm -F model=whisper-1 -F response_format=json`。

## 10. 实现记录（主进程 ASR 核心）

已落地：`src/core/asr.js`、`LhClient#asr`、`settings.asr`、IPC、`test/asr.test.js`、`scripts/asr-transcribe.js`。与 §3–§5 草案的差异：

- **设置形态**：`provider: lobehub|local|auto` 改为 `engine: lobehub|local|off` + `fallback: boolean`（失败时再试另一个 provider 一次）。旧形态自动迁移（`auto` → `engine: local, fallback: true`）。`local.endpoint` 默认 `http://127.0.0.1:8179`（§2.1 的 OpenAI 兼容启动方式），不再为空；只接受 https，或者指向本机 / 局域网的 http。`mode`、`autoSend` 属于渲染层，留给下游任务。
- **reason**：本地 HTTP 错误统一记为 `http-<status>`（400、404、500 等），不再映射成 `bad-audio` / `server`。新增 `not-configured`（ASR 关闭，或 engine 为 off）。熔断规则：`empty`、`bad-audio`、`canceled`、`http-400/413/415/422` 不熔断；`timeout`、`network`、`server`、`http-5xx/408/429` 暂停 20 秒；其他 reason 暂停 5 分钟。**链路中的最后一个 provider 即使处于熔断期也会尝试**（用户在等结果）。`empty` / `bad-audio` 不会回退到另一个 provider。
- **超时**：lobehub 为 30 s + 每秒录音 0.1 s，上限 60 s（应用内实测一次 3.5 s 的短句用了 18 s，所以基数从 20 s 提高到 30 s）。local 为 `local.timeoutSec`，默认 30 s，可设 5–120 s。
- **连通性测试**：`test()` 发送内置生成的 0.6 秒静音 WAV（`silentWav()`），返回空文本也算通过，因此不需要随包附带音频资源。
- **IPC**（preload）：`window.pet.asr = { transcribe(bytes, mime, ms), cancel(), test(provider?), set(patch) }`。`set` 的 `patch.key` 是本地服务的可选 Key，存进 tts-keys.json（id `asrlocal`），设为 `''` 即删除。设置视图里的 `asrStatus` 只包含是否熔断、熔断原因和 `hasKey`。
- **命令行验证**：`node scripts/asr-transcribe.js <file> --engine local|lobehub [--endpoint …] [--api whispercpp] [--language zh] [--fallback] [--test]` 与 IPC 走同一套代码。在 agent 环境里运行时需要加 `PIXELPET_CLEAR_JWT=1`。
