# 角色语音（TTS）选型调研

> 调研日期：2026-10-30。价格、模型名会变，接入前以文中链接的官方页面为准。
> 范围：只做选型和接口建议，不改代码。实现交给下游的 TTS 引擎任务。

**结论（一句话）**：默认用 **Fish Audio 云端 TTS（模型 `s2.1-pro`，开发/个人可用 `s2.1-pro-free`）**，大肥鱼用社区音色 **「蓝色大肥鱼」`fe50cdf3040449298470d58ff0991e1d`**。**MiniMax 系统音色**做备选（需要国内账号和发票、或者 Fish 不可用时）。没有 Key、断网或请求失败时，**降级到现有的系统 Web Speech**（`src/core/voice.js`），也就是现在的行为。想离线又要贴近参考音色，可以选进阶方案 **GPT-SoVITS 本地复刻**，前提是先取得音源作者的许可。

目录

1. [现状基线](#1-现状基线)
2. [参考音色是什么](#2-参考音色是什么)
3. [候选方案对比](#3-候选方案对比)（7 类方案 × 8 个维度）
4. [试听样例](#4-试听样例)
5. [推荐：默认 / 备选 / 降级](#5-推荐默认--备选--降级)
6. [每个角色的音色与参数](#6-每个角色的音色与参数)
7. [需要用户提供的东西](#7-需要用户提供的东西)
8. [下游引擎接口建议](#8-下游引擎接口建议)
9. [合规与授权边界](#9-合规与授权边界)
10. [参考资料](#10-参考资料)

---

## 1. 现状基线

- `src/core/voice.js` 用操作系统自带的语音（Web Speech API `speechSynthesis`，见 [MDN][mdn-speech]）：不联网、免费。它负责：
  - `voiceOf(species)` 读出角色的 `voice` 字段，并把数值夹到合法范围（pitch 0.1–2，rate 0.5–2）；
  - `speakable(text)` 去掉 emoji、`[...]`、括号里的旁白和 URL，最多读 160 字，尽量在句末截断；
  - `shouldSpeak(m)` 只朗读 LLM 回复、话题和本地 API 发来的台词，不读自动嘀咕；
  - `pickVoice()` 先按 `prefer` 里的名字片段挑系统语音，挑不到再按语言挑。
- `src/renderer/app.js` 里的 `speak()` 在渲染进程里直接调 `speechSynthesis.speak()`。开关是 `settings.prefs.voice`，默认关（`src/core/settings.js`）。
- 各角色现在的 `voice` 字段（`src/characters/*.json`）：

| 角色 | 文件 | 现值 |
|---|---|---|
| 大肥鱼 Dafeiyu | `dafeiyu.json` | `{"lang":"zh-CN","pitch":1.35,"rate":1.0,"prefer":["Xiaoyi","Xiaoxiao","Tingting","Meijia"]}` |
| 克洛蒂 Clody | `claude.json` | `{"lang":"zh-CN","pitch":1.0,"rate":0.92,"prefer":["Xiaoxiao","Tingting","Huihui"]}` |
| 杰米 Gemi | `gemini.json` | `{"lang":"zh-CN","pitch":1.25,"rate":1.08,"prefer":["Xiaoxiao","Meijia"]}` |
| 吉皮缇 Gippity | `gpt.json` | `{"lang":"zh-CN","pitch":1.1,"rate":1.0,"prefer":["Xiaoxiao","Tingting"]}` |
| 格萝可 Groko | `grok.json` | `{"lang":"zh-CN","pitch":1.15,"rate":1.12,"prefer":["Xiaoyi","Tingting"]}` |

问题：音色取决于用户机器装了哪些语音。Linux 上常常没有中文语音；Windows 上的 Huihui、macOS 上的 Tingting 是通用播音腔，再怎么调 pitch 也不像“大肥鱼”。所以这一层适合留作**最后一道降级**，不适合做主音色。

## 2. 参考音色是什么

- 用户给的参考视频 [BV1fYpn6SEk9][bili-ref] 是《deepseek 翻唱〈人是猫〉真完整版》，UP 主 **星落落_oi**，页面标注“含AI生成内容”。简介写明：**“音色参考：ssr大肥鱼音色：BV1PPYM6EEUR”**，大肥鱼形象来自 @ZipZipPipe。
- 音色出处 [BV1PPYM6EEUR][bili-voice]《一发入魂！ssr大肥鱼音色！》也是 星落落_oi（[空间][bili-up]）发的。简介写的是“谱乐 AI 超创！……大肥鱼音源关注自动发送”，页面同样标注“含AI生成内容”和“未经作者授权，禁止转载”。
- 由此判断：参考音色是 UP 主用 **谱乐 AI**（国内 AI 音乐平台，支持上传样本训练专属音色，见 [报道][pule-news]）**生成或设计的 AI 音色**，不是某位真人配音演员的声音。音源要关注 UP 主后私信获取，**没有公开授权条款**。
- 这意味着：
  1. 不存在“官方”大肥鱼音色。能直接用的现成模型只有 Fish Audio 社区里别人做的大肥鱼音色，见下表。它们和 星落落_oi 的音源**是否同源无法确认**，只能听感比对。
  2. 想 1:1 复刻参考音色，就得拿到那份音源去做声音复刻（GPT-SoVITS / CosyVoice / MiniMax / 豆包）。这需要 **星落落_oi 的许可**，而且音源只能留在用户本机，不能进仓库（见 §9）。

Fish Audio 上和大肥鱼相关的社区音色（2026-10-30 通过公开接口 `GET https://api.fish.audio/model?title=大肥鱼` 查得，共 39 条，下面列出相关的）：

| reference_id | 名称 | 作者 | 点赞 / 使用次数 | 描述（摘录） |
|---|---|---|---|---|
| [`fe50cdf3040449298470d58ff0991e1d`][fish-dfy] | 蓝色大肥鱼 | 大大大肥鱼 | 37 / 2127 | “充满活力、略带稚气的AI声音”；标签 female, young, character-voice, playful；`train_mode: fast`，2026-10-05 创建 |
| [`c96a76fb39474652a4fbc74b835c47fb`][fish-dfy2] | 蓝色大肥鱼 | — | 0 / 19 | “没心没肺的少女音……水润的‘气泡感’……穿着女仆装、理直气壮”（语言标签为 ja，需要试听中文效果） |
| [`8d981c7140fb44d4987fcf6ab2c89159`][fish-dfy3] | 大肥鱼 | — | 0 / 28 | “充满活力的中性少年音……二次元动漫风格” |

**首选 `fe50cdf3…`**：它是用得最多的一条，描述和标签与参考视频里的稚气、元气少女音一致。官方试听样例在[模型页][fish-dfy]，可以直接在页面上播放比对。

## 3. 候选方案对比

一共对比 7 类：①Fish Audio 云端（含社区音色）②本地开源复刻 GPT-SoVITS ③本地开源复刻 CosyVoice ④云端声音复刻 MiniMax ⑤云端声音复刻 火山引擎豆包 ⑥LobeHub 自带 TTS（`lh gen tts` / `@lobehub/tts`）⑦Edge TTS 免费神经语音。另外把 ⓪现有系统 Web Speech 列在表里作为对照。

| 维度 | ① Fish Audio | ② GPT-SoVITS（本地） | ③ CosyVoice（本地） | ④ MiniMax | ⑤ 火山豆包 | ⑥ LobeHub TTS（`lh gen tts`） | ⑦ Edge TTS | ⓪ 系统 Web Speech（现状） |
|---|---|---|---|---|---|---|---|---|
| **音色贴合度** | ★★★★ 有**现成**社区大肥鱼音色（§2 表），开箱即用；也能用自己的参考音频零样本复刻（`references` 字段）。和参考音源是否同源无法确认 | ★★★★★ 有音源时可以做到最像：5 秒零样本，1 分钟音频微调（[README][gsv]）。**没有现成大肥鱼模型**，得用户自己训练 | ★★★★ 零样本复刻，效果接近 GPT-SoVITS（[README][cosy]）；没有现成模型 | ★★★★ 快速复刻需要上传参考音频；也可以用“音色设计”文字描述生成；**没有现成大肥鱼**，系统音色里有“俏皮萌妹”“少女音色”可以凑合（[音色列表][mm-voices]） | ★★★★ 声音复刻 2.0 需要上传参考音频（[计费][volc-price]）；没有现成大肥鱼 | ★ 只有 OpenAI 的 6 个音色（alloy/echo/fable/onyx/nova/shimmer）加 Edge 音色（[LobeHub 文档][lh-tts-doc]、[lobe-tts][lobe-tts]），**不能复刻** | ★★ `zh-CN-XiaoyiNeural`（Cartoon/Lively）是能找到的最接近的通用卡通女声，**不能复刻**（本机 `edge-tts --list-voices` 实测） | ★ 取决于系统语音，通用播音腔 |
| **中文效果** | 好。s2.1-pro / s2-pro 自动识别语言，支持 80+ 种语言，可以用 `[方括号]` 自然语言写情绪（[模型总览][fish-models]） | 好，中/粤/日/英/韩（[README][gsv]） | 好，9 种语言加 18 种以上方言（[README][cosy]） | 好，国内厂商，中文系统音色多（[音色列表][mm-voices]） | 好，国内厂商，中文主场（[产品页][volc-tts]） | 一般：OpenAI 音色说中文带外国口音；用 Edge 音色时同 ⑦ | 较好，但播音感强，语气词“咕噜~”读得生硬（见 §4 样例） | 差到一般，因系统而异 |
| **延迟** | 官方给 s2-pro 的首包时间（TTFA）是 100ms，`latency: balanced/low` 还能再降（[模型总览][fish-models]、[TTS API][fish-api]）。实际要加跨境网络，估计 0.5–2s。**未实测**（本机没有 Key） | 本地 GPU 很快：RTF 0.014（4090）/ 0.028（4060Ti）；只用 CPU（M4）时 RTF 0.526（[README][gsv]） | 流式首包最低约 150ms（GPU）（[README][cosy]） | 支持流式（`stream: true`）（[T2A API][mm-api]）；国内网络通常 <1s，未实测 | 支持 WebSocket/HTTP 流式（[文档中心][volc-docs]），国内网络通常 <1s，未实测 | 一次 HTTP 往返，非流式；本机实测**接口返回 404，调用失败**（§4） | 本机实测：一句 4.3–4.6 秒的台词，**整条生成用时 1.06–1.41 秒**（含 `uvx` 启动开销，§4） | 约等于 0，本地合成 |
| **费用** | `s2.1-pro` 每百万 UTF-8 字节 $15；**`s2.1-pro-free` 免费**（标明用于开发测试，没有首包时间保障）；按量付费，没有月费（[价格][fish-price]）。一个汉字 3 字节，按每天 100 句 × 30 字算，约 0.27MB/月，**约 $4/月** | 免费（MIT），成本是 GPU 和电费 | 免费（Apache-2.0） | speech-2.8-turbo 每万字符 ¥2，hd 每万字符 ¥3.5，一个汉字算 2 个字符；快速复刻或音色设计每个音色 ¥9.9（[价格][mm-price]）。同样用量**约 ¥36/月**（turbo） | 声音复刻 2.0 和语音合成 2.0 后付费都是每万字符 ¥3，一个汉字算 1 个字符；复刻音色另收槽位费（[计费][volc-price]）。同样用量**约 ¥27/月** | 走 LobeHub 账号的额度（本机调用失败，价格未确认） | 免费（非官方接口，见许可一列） | 免费 |
| **离线可用** | ✗ 必须联网（模型权重 s2-pro 开源，但本地跑需要大显存，不考虑） | ✓ 完全离线 | ✓ 完全离线 | ✗ | ✗ | ✗ | ✗ | ✓ |
| **API / SDK 形态** | REST `POST https://api.fish.audio/v1/tts`，Bearer Key，请求头 `model`，请求体 `text` / `reference_id` / `format` / `latency` / `prosody{speed,volume}` / `temperature` / `top_p`；返回分块（chunked）音频（[TTS API][fish-api]）；另有 WebSocket 实时接口（[WS TTS][fish-ws]）。有官方 Python/JS SDK | 本地 HTTP 服务 `python api_v2.py -a 127.0.0.1 -p 9880`，`GET/POST /tts?text=…&ref_audio_path=…&streaming_mode=true`（[api_v2.py][gsv-api]） | 本地 Python 服务或 gRPC / FastAPI 示例（[README][cosy]） | REST `POST https://api.minimax.cn/v1/t2a_v2`，`voice_setting{voice_id,speed 0.5–2,vol,pitch -12–12,emotion}`，`stream`（[T2A API][mm-api]） | HTTP / WebSocket 双向流式，需要 AppID + Token（[文档中心][volc-docs]） | CLI `lh gen tts <text> --voice --speed --model`（`lh man gen tts`）；npm 包 `@lobehub/tts`（MIT，含 EdgeSpeechTTS / OpenAITTS）（[lobe-tts][lobe-tts]、[API 文档][lobe-tts-edge]） | 非官方 WebSocket 协议；Python 包 `edge-tts`（LGPLv3，[仓库][edge-tts]），Node 端可用 `@lobehub/tts` 的 `EdgeSpeechTTS` | 浏览器 `speechSynthesis` |
| **Electron 集成难度** | **低**：主进程用 Node 自带的 `fetch` 请求，Key 存 `safeStorage`，音频通过 IPC 交给渲染进程播放 | **高**：要打包或让用户自装 Python + PyTorch（几个 GB），还要拉起子进程、做健康检查；没有 GPU 时 CPU 延迟明显 | **高**：同 ②，依赖更重 | 低：和 ① 一样是 REST | 中：鉴权和协议稍复杂（AppID / Token / 集群参数） | 中：依赖用户机器装了 `lh` 并已登录，属于外部依赖，不适合做桌宠的运行时依赖 | 低到中：一个 npm 依赖就能跑，但接口随时可能被微软封 | 已集成 |
| **许可与授权** | 服务条款：默认只限“个人、非商业使用”，付费用户可以商用；公开的 User Submission 授权其他用户访问；禁止冒充他人，鼓励标注 AI 生成（[条款][fish-terms]）。社区音色的**来源由上传者负责**，这里选的是描述为“AI声音”的音色，避开了以真人 UP 主命名的音色 | 代码 MIT（[LICENSE][gsv-lic]）；**参考音频的授权要自己负责**，复刻 星落落_oi 的音源必须先取得许可 | 代码 Apache-2.0（[LICENSE][cosy-lic]）；参考音频授权同 ② | 平台要求复刻音频来源合法、有授权；真人声音受《民法典》第 1023 条保护（[民法典][civil-code]） | 同 ④，复刻前需要上传方承诺有授权 | OpenAI / Edge 音色由平台授权，没有复刻风险 | `edge-tts` 本身是 LGPLv3（[LICENSE][edge-tts-lic]），但它调用的是**未公开的 Edge 朗读接口**，没有微软官方 API 授权；合规的替代是 Azure Speech（[定价][azure-speech]） | 系统自带，无风险 |

**取舍**：

- 能做到“开箱就接近参考音色”的只有 ①，因为它有现成的社区大肥鱼音色，填一个 Key 就能用。
- ②③ 能做到最像，也能离线，但要求用户拿到音源授权、还要有 GPU 和 Python 环境，对桌宠用户门槛太高。只适合做进阶选项。
- ④⑤ 适合国内付款、需要发票的场景，也适合在 ① 不可用时顶上。系统音色合规最干净（没有真人复刻），但不像大肥鱼。
- ⑥ 没有复刻能力，本机实测也调不通，不推荐做运行时引擎。
- ⑦ 免费、零配置，但接口非官方、音色不贴合，只适合当“没 Key 时比系统语音好一点”的可选项，不作为默认。

## 4. 试听样例

同一句台词：**“咕噜~鱼片你来啦~饭呢？就一碗，先养着吧。”**（取自 `dafeiyu.json` 的 `fallback.greet` 和 `fallback.hungry`）

| 方案 | 结果 | 文件（**仓库外**，`/tmp/tts-samples/`；同时作为验收证据上传到 LobeHub 本次验收轮次） |
|---|---|---|
| ⑦ Edge `zh-CN-XiaoyiNeural`，rate +8%，pitch +12Hz（大肥鱼降级参数） | ✓ 生成成功，时长 4.30s，用时 1.32s | `edge_XiaoyiNeural_r+8%_p+12Hz.mp3` |
| ⑦ Edge `zh-CN-XiaoyiNeural`，默认参数 | ✓ 4.63s，用时 1.41s | `edge_XiaoyiNeural_r+0%_p+0Hz.mp3` |
| ⑦ Edge `zh-CN-XiaoxiaoNeural`，默认参数 | ✓ 4.58s，用时 1.06s | `edge_XiaoxiaoNeural_r+0%_p+0Hz.mp3` |
| ⑥ `lh gen tts --voice nova` | ✗ 失败：`[ERROR] TTS failed: 404 <!DOCTYPE html>…`（清掉 `LOBEHUB_JWT` 后重试，结果相同） | 无 |
| ① Fish「蓝色大肥鱼」 | 本机没有 Fish API Key，**没能用同一句台词生成**。下载了模型页公开的官方试听样例做听感参考，仅存本机，不上传、不入库 | `fish_community_fe50cdf3_official_sample.mp3`（仅本机；在线试听请看[模型页][fish-dfy]） |
| ②③ GPT-SoVITS / CosyVoice | 没有取得 星落落_oi 音源的授权，**不生成** | 无 |
| ④⑤ MiniMax / 豆包 | 没有 API Key，没有生成 | 无 |

生成命令（可复现）：

```bash
uvx --from edge-tts edge-tts --voice zh-CN-XiaoyiNeural --rate=+8% --pitch=+12Hz \
  --text "咕噜~鱼片你来啦~饭呢？就一碗，先养着吧。" --write-media /tmp/tts-samples/edge_XiaoyiNeural_r+8%_p+12Hz.mp3
```

听感结论：Edge Xiaoyi 加参数后比系统语音活泼，但“咕噜~”的拖音和撒娇语气仍然是播音腔，和参考视频差距明显。大肥鱼的主音色需要 ① 或复刻方案。

## 5. 推荐：默认 / 备选 / 降级

| 层级 | 方案 | 什么时候用 | 理由（和 §3 的表对应） |
|---|---|---|---|
| **默认** | **Fish Audio**，模型 `s2.1-pro`（个人或开发可以先用 `s2.1-pro-free`），大肥鱼用 `reference_id = fe50cdf3040449298470d58ff0991e1d` | 用户在设置里填了 Fish API Key，而且联网 | 唯一有**现成大肥鱼音色**的方案（贴合度 ★★★★）；REST 接口，Electron 集成难度低；费用约 $4/月，免费档可以起步；支持情绪标签和分块流式 |
| **备选 A** | **MiniMax** `speech-2.8-turbo` + 系统音色（各角色的 voice_id 见 §6）；拿到授权音源后也可以用快速复刻（¥9.9/音色） | 国内付款或需要发票；Fish 被墙、限流或宕机 | 国内低延迟，中文音色多，参数齐全（speed/pitch/vol/emotion）；系统音色没有真人复刻风险 |
| **备选 B（进阶、离线）** | **GPT-SoVITS v2Pro/V5** 本地服务（`127.0.0.1:9880`），用户自备并授权的大肥鱼音源 | 用户取得 星落落_oi 的许可，有 GPU，想离线 | 最贴近参考音色，离线；但门槛高，作为插件式 provider，不随应用打包 |
| **降级** | **系统 Web Speech**（现在的 `voice.js` 路径，沿用各角色现有的 `lang/pitch/rate/prefer`） | ① 没填 Key ② 离线（`navigator.onLine === false`）③ 云端请求超时（建议 4s 没有首包）或返回 4xx/5xx ④ 当月预算用完 | 零依赖、零成本、保证“开了朗读就一定有声音” |
| 可选降级 | Edge TTS（`zh-CN-XiaoyiNeural` 等） | 用户在设置里**主动勾选**“免费在线语音（非官方接口）” | 比系统语音好听；因为接口不是官方的，不默认开启 |

不选 LobeHub TTS 做引擎：它不能复刻，OpenAI 音色说中文有外国口音，本机 `lh gen tts` 返回 404，而且要求用户机器装了并登录 `lh`。

## 6. 每个角色的音色与参数

说明：

- Fish 一列的 `speed` 对应 `prosody.speed`（0.5–2），`volume` 单位是 dB。统一用 `temperature 0.7`、`top_p 0.7`、`latency "balanced"`、`format "mp3"`。
- MiniMax 一列的 `pitch` 取值 -12–12，`vol` 取值 0–10（[T2A API][mm-api]）。
- Edge 一列是可选降级的参数；系统 Web Speech 继续用现有的 `voice` 字段，不改。
- 除大肥鱼以外，Fish 社区音色是按描述和使用量挑的候选（都是 2026-10-30 公开接口查到的），**上线前需要用户试听确认**。挑选时避开了以真人主播命名的音色。

| 角色 | Fish（默认） | MiniMax（备选 A） | Edge（可选降级） | 情绪映射建议 |
|---|---|---|---|---|
| **大肥鱼** 懒洋洋、嘴硬、元气 | `fe50cdf3040449298470d58ff0991e1d`「蓝色大肥鱼」；speed **1.0**，volume **0**；备用 id `c96a76fb39474652a4fbc74b835c47fb` | `qiaopi_mengmei`（俏皮萌妹），speed **1.0**，pitch **+2**，vol **1**，emotion 按情绪选，默认 `happy` | `zh-CN-XiaoyiNeural`，rate `+8%`，pitch `+12Hz` | happy→`[开心地]`；hungry→`[可怜巴巴地]`；sleepy→`[打着哈欠，懒洋洋地]`；bored→`[撒娇地]` |
| **克洛蒂** 安静、温和、书卷气 | `faccba1a8ac54016bcfc02761285e67f`「温柔动听女声」（点赞 1982 / 使用 7.8 万）；speed **0.92**，volume **0** | `Chinese (Mandarin)_Soft_Girl`（柔和少女），speed **0.92**，pitch **0**，emotion `calm` | `zh-CN-XiaoxiaoNeural`，rate `-8%`，pitch `+0Hz` | 默认 `[轻声地]`；被夸时→`[小声害羞地]` |
| **杰米** 活泼、好奇、猫耳 | `dcad479645e444af89338546b8c75b23`「可爱小猫娘」；speed **1.08**，volume **0** | `Chinese (Mandarin)_Crisp_Girl`（清脆少女），speed **1.08**，pitch **+1**，emotion `happy` / `surprised` | `zh-CN-XiaoyiNeural`，rate `+8%`，pitch `+8Hz` | 好奇→`[兴奋地]`；被问住→`[有点得意地]` |
| **吉皮缇** 温柔、耐心、条理 | `23632847285a487d8e0c6ae5bc593c71`「温柔叙事女声」；speed **1.0**，volume **0** | `Chinese (Mandarin)_Warm_Girl`（温暖少女），speed **1.0**，pitch **0**，emotion `calm` | `zh-CN-XiaoxiaoNeural`，rate `+0%`，pitch `+4Hz` | 默认 `[温柔地]` |
| **格萝可** 嘴快、吐槽、夜行 | `8a88ef7d77d748e59879d8994e216e01`「御姐」（“娇俏、戏谑感”）；speed **1.12**，volume **0** | `female-shaonv`（少女音色），speed **1.12**，pitch **-1**，emotion `happy` | `zh-CN-XiaoyiNeural`，rate `+12%`，pitch `+0Hz` | 吐槽→`[坏笑着]`；深夜→`[精神十足地]` |

建议的 `voice` 字段扩展（向后兼容：只多一个 `tts` 对象，现有的 `lang/pitch/rate/prefer` 继续服务系统语音降级）。以大肥鱼为例：

```json
"voice": {
  "lang": "zh-CN", "pitch": 1.35, "rate": 1.0, "prefer": ["Xiaoyi", "Xiaoxiao", "Tingting", "Meijia"],
  "tts": {
    "fish":    { "referenceId": "fe50cdf3040449298470d58ff0991e1d", "model": "s2.1-pro", "speed": 1.0, "volume": 0,
                 "temperature": 0.7, "topP": 0.7, "latency": "balanced",
                 "moodTags": { "happy": "开心地", "hungry": "可怜巴巴地", "sleepy": "打着哈欠，懒洋洋地", "bored": "撒娇地" },
                 "credit": "Fish Audio 社区音色「蓝色大肥鱼」by 大大大肥鱼" },
    "minimax": { "voiceId": "qiaopi_mengmei", "model": "speech-2.8-turbo", "speed": 1.0, "pitch": 2, "vol": 1, "emotion": "happy" },
    "edge":    { "voice": "zh-CN-XiaoyiNeural", "rate": "+8%", "pitch": "+12Hz" }
  }
}
```

注意：`speakable()` 会删掉 `[...]`，所以 Fish 的情绪标签要在 `speakable()` **之后**由 provider 加到句首，不能写进台词原文。

## 7. 需要用户提供的东西

| 项 | 必需？ | 说明 |
|---|---|---|
| **Fish Audio API Key** | 默认方案必需 | 在 [fish.audio][fish-home] 注册后创建 Key；可以先用 `s2.1-pro-free` 免费调试，正式用 `s2.1-pro` 需要预充值（[价格][fish-price]）。商用要付费订阅（[条款][fish-terms]） |
| 确认大肥鱼音色 | 必需 | 在[模型页][fish-dfy]试听 `fe50cdf3…`，和参考视频比对；不满意就换 §2 表里的备用 id |
| MiniMax API Key（国内站） | 备选 A 才需要 | 在 [platform.minimax.cn][mm-price] 开通并实名 |
| **星落落_oi 的音源 + 书面许可** | 只有想 1:1 复刻（备选 B 或云端复刻）时需要 | 关注 UP 主获取音源，并私信确认允许个人桌宠使用。音源只放在本机 `userData`，**不进仓库**，也不分发 |
| GPU / Python 环境 | 只有备选 B 需要 | NVIDIA GPU 推荐；按 [GPT-SoVITS README][gsv] 部署 `api_v2.py` |
| 月度预算上限 | 建议 | 例如 $5/月，超了自动降级到系统语音 |

## 8. 下游引擎接口建议

**分层**：渲染进程只负责“播放”，网络请求和 Key 都放在主进程（`src/main/`），通过 `preload.js` 暴露 `petTTS.synthesize()`。这样 Key 不进渲染进程，也不受页面 CSP 限制。

```js
// src/core/tts/provider.js —— 每个 provider 实现同一接口
/**
 * @typedef {{ text: string, character: string, mood?: string, voice: object }} TTSRequest
 * @typedef {{ audio: ArrayBuffer, mime: 'audio/mpeg'|'audio/wav', provider: string, cached: boolean }} TTSResult
 */
const provider = {
  id: 'fish',                         // 'fish' | 'minimax' | 'gptsovits' | 'edge' | 'system'
  available(settings) {},             // 有没有 Key / 本地服务是否在线 / 是否 online
  async synthesize(req, { signal }) {}, // 返回 TTSResult，或抛 TTSUnavailable / TTSFailed
  async *stream(req, { signal }) {},  // 可选：逐块产出 Uint8Array（Fish 分块 HTTP / WS，MiniMax stream）
};
```

- **选择链**：`settings.prefs.ttsProvider`（默认 `fish`）→ 备选（`minimax`）→ `system`。每个 provider 先检查 `available()`，失败了按链往下走。`system` provider 就是现在的 `speechSynthesis` 逻辑，挪进来继续在渲染进程执行。
- **文本处理**：沿用 `Voice.shouldSpeak()` / `Voice.speakable()`（160 字上限保证单次请求短）。provider 自己再加情绪标签（Fish）或 `emotion`（MiniMax）。
- **缓存**：
  - 缓存键 `sha256(provider | model | voiceId/referenceId | 规范化参数 JSON | 最终文本)`，文件放在 `app.getPath('userData')/tts-cache/<key>.mp3`，加一个索引 JSON 做 LRU，上限建议 50MB。
  - 角色 `fallback.*` 里的固定台词（饿了、无聊、问候）在用户第一次开启朗读时可以**后台预热**。这些台词重复度高，命中缓存后延迟为 0、费用为 0。
  - 换了音色或参数，键自然就变了，不需要手动清缓存。
- **流式**：
  - 第一期：单句 ≤160 字，非流式 + 缓存就够了（Fish 首包官方值 100ms 量级，整句一般 1–2s）。
  - 第二期：长回复按句切分（复用 `speakable` 的句末规则），逐句请求、排队播放；或者用 Fish WebSocket（[WS TTS][fish-ws]）/ MiniMax `stream: true` 把分块写进 `MediaSource`。
  - 新消息来了先 `abort()` 上一句（对应现在的 `speechSynthesis.cancel()`）。
- **回退与超时**：4s 没有首包，或者遇到 401/402/429/5xx，或者 `navigator.onLine === false`，都**当句立即**回退到系统语音，并把这个 provider 熔断 5 分钟，避免每句都等超时。429 按 Fish 文档做指数退避（[价格与限流][fish-price]）。401 在设置页提示“Key 无效”。
- **可观测**：在现有的 `lastSpeech` 记录里加上 `provider`、`cached`、`latencyMs`、`fellBackFrom`，方便 e2e 场景断言和排查。
- **设置项**：`prefs.voice`（总开关，已有）、`prefs.ttsProvider`、Key（用 `safeStorage` 加密）、`prefs.ttsBudgetUsd`、`prefs.allowEdgeTTS`（默认 false）。设置页注明“语音由 AI 合成”，满足 §9 的显式标识要求。

## 9. 合规与授权边界

- **参考音色的性质**：BV1PPYM6EEUR 的“ssr大肥鱼音色”是 UP 主用谱乐 AI 做的 AI 音色（[视频页][bili-voice]），不是真人声线，所以《民法典》第 1023 条“自然人声音参照肖像权保护”（[民法典][civil-code]）的风险较低。但音源本身是 UP 主的作品，页面写着“未经作者授权，禁止转载”。所以：
  - **不要**把音源、复刻出来的模型权重、生成的样例提交到仓库或随应用分发；
  - 复刻它（GPT-SoVITS / CosyVoice / MiniMax / 豆包）前要先取得 UP 主许可，并且只在用户本机使用。
- **Fish 社区音色**：公开模型对平台所有用户开放访问（[条款][fish-terms]）。仓库里只写 `reference_id` 和署名（`credit`），**不下载、不存音频**。免费账号限个人非商业使用，商用要付费订阅。生成内容不得冒充他人，也不得声称是真人录制。
- **国内法规**：《互联网信息服务深度合成管理规定》第 14 条规定编辑人声需要被编辑者单独同意，第 17 条规定合成人声可能造成混淆时要显著标识（[原文][cac-deep]）。《人工智能生成合成内容标识办法》2025-09-01 起施行，第 4 条允许用语音提示或在交互界面加显著提示（[原文][cac-label]）。桌宠作为分发的应用，建议在朗读设置处写明“AI 合成语音”。
- **个人使用的边界**：只在自己电脑上听、不公开传播生成音频、不商用，属于个人使用。一旦录屏发视频、商用或分发音色，就需要分别取得音源作者许可、Fish 付费授权，并加上 AI 标识。
- **本次交付**：仓库里**没有新增任何音频或模型文件**。试听样例都在仓库外（`/tmp/tts-samples/`），Edge 样例作为验收证据上传到 LobeHub，Fish 官方样例只在本机。

## 10. 参考资料

2026-10-30 逐条检查过可访问性：B 站三条链接和 LobeHub 文档会对命令行 `curl` 返回 412 / 403（反爬），用浏览器或 WebFetch 打开正常；其余链接都返回 200。

- [bili-ref] 参考视频 BV1fYpn6SEk9：<https://www.bilibili.com/video/BV1fYpn6SEk9/>
- [bili-voice] 音色出处 BV1PPYM6EEUR「一发入魂！ssr大肥鱼音色！」：<https://www.bilibili.com/video/BV1PPYM6EEUR/>
- [bili-up] UP 主 星落落_oi 空间：<https://space.bilibili.com/30584746/>
- [pule-news] 谱乐 AI 音色克隆能力报道：<https://m.tech.china.com/redian/2025/1229/122025_1789628.html>
- [fish-home] Fish Audio：<https://fish.audio/>
- [fish-dfy] Fish 社区音色「蓝色大肥鱼」：<https://fish.audio/m/fe50cdf3040449298470d58ff0991e1d/>
- [fish-dfy2] Fish 社区音色「蓝色大肥鱼」（备用）：<https://fish.audio/m/c96a76fb39474652a4fbc74b835c47fb/>
- [fish-dfy3] Fish 社区音色「大肥鱼」（备用）：<https://fish.audio/m/8d981c7140fb44d4987fcf6ab2c89159/>
- [fish-models] Fish 模型总览：<https://docs.fish.audio/developer-platform/models-pricing/models-overview>
- [fish-price] Fish 价格与限流：<https://docs.fish.audio/developer-platform/models-pricing/pricing-and-rate-limits>
- [fish-api] Fish TTS API：<https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech>
- [fish-ws] Fish WebSocket TTS：<https://docs.fish.audio/api-reference/endpoint/websocket/tts-live>
- [fish-terms] Fish 服务条款：<https://fish.audio/terms>
- [gsv] GPT-SoVITS：<https://github.com/RVC-Boss/GPT-SoVITS>
- [gsv-api] GPT-SoVITS api_v2.py：<https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py>
- [gsv-lic] GPT-SoVITS LICENSE（MIT）：<https://github.com/RVC-Boss/GPT-SoVITS/blob/main/LICENSE>
- [cosy] CosyVoice：<https://github.com/FunAudioLLM/CosyVoice>
- [cosy-lic] CosyVoice LICENSE（Apache-2.0）：<https://github.com/FunAudioLLM/CosyVoice/blob/main/LICENSE>
- [mm-price] MiniMax 语音价格：<https://platform.minimax.cn/docs/guides/pricing-speech>
- [mm-api] MiniMax T2A HTTP API：<https://platform.minimax.cn/docs/api-reference/speech-t2a-http>
- [mm-voices] MiniMax 系统音色列表：<https://platform.minimax.cn/docs/faq/system-voice-id>
- [volc-tts] 火山引擎语音合成产品页：<https://www.volcengine.com/product/tts>
- [volc-docs] 豆包语音文档中心：<https://www.volcengine.com/docs/6561>
- [volc-price] 豆包语音计费说明：<https://docs.volcengine.com/docs/6561/1359370>
- [lh-tts-doc] LobeHub TTS/STT 使用文档：<https://lobehub.com/docs/usage/agent/tts-stt>
- [lobe-tts] @lobehub/tts：<https://github.com/lobehub/lobe-tts>
- [lobe-tts-edge] @lobehub/tts EdgeSpeechTTS API：<https://tts.lobehub.com/api-reference/edge-speech-tts>
- [edge-tts] edge-tts：<https://github.com/rany2/edge-tts>
- [edge-tts-lic] edge-tts LICENSE（LGPLv3）：<https://github.com/rany2/edge-tts/blob/master/LICENSE>
- [azure-speech] Azure 语音服务定价：<https://azure.microsoft.com/zh-cn/pricing/details/cognitive-services/speech-services/>
- [mdn-speech] MDN SpeechSynthesis：<https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis>
- [civil-code] 《中华人民共和国民法典》（国家法律法规数据库）：<https://flk.npc.gov.cn/detail2.html?ZmY4MDgxODE3MjlkMWVmZTAxNzI5ZDUwYjVjNTAwYmY%3D>
- [cac-deep] 《互联网信息服务深度合成管理规定》：<https://www.cac.gov.cn/2022-12/11/c_1672221949354811.htm>
- [cac-label] 《人工智能生成合成内容标识办法》：<https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm>

[bili-ref]: https://www.bilibili.com/video/BV1fYpn6SEk9/
[bili-voice]: https://www.bilibili.com/video/BV1PPYM6EEUR/
[bili-up]: https://space.bilibili.com/30584746/
[pule-news]: https://m.tech.china.com/redian/2025/1229/122025_1789628.html
[fish-home]: https://fish.audio/
[fish-dfy]: https://fish.audio/m/fe50cdf3040449298470d58ff0991e1d/
[fish-dfy2]: https://fish.audio/m/c96a76fb39474652a4fbc74b835c47fb/
[fish-dfy3]: https://fish.audio/m/8d981c7140fb44d4987fcf6ab2c89159/
[fish-models]: https://docs.fish.audio/developer-platform/models-pricing/models-overview
[fish-price]: https://docs.fish.audio/developer-platform/models-pricing/pricing-and-rate-limits
[fish-api]: https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
[fish-ws]: https://docs.fish.audio/api-reference/endpoint/websocket/tts-live
[fish-terms]: https://fish.audio/terms
[gsv]: https://github.com/RVC-Boss/GPT-SoVITS
[gsv-api]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py
[gsv-lic]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/LICENSE
[cosy]: https://github.com/FunAudioLLM/CosyVoice
[cosy-lic]: https://github.com/FunAudioLLM/CosyVoice/blob/main/LICENSE
[mm-price]: https://platform.minimax.cn/docs/guides/pricing-speech
[mm-api]: https://platform.minimax.cn/docs/api-reference/speech-t2a-http
[mm-voices]: https://platform.minimax.cn/docs/faq/system-voice-id
[volc-tts]: https://www.volcengine.com/product/tts
[volc-docs]: https://www.volcengine.com/docs/6561
[volc-price]: https://docs.volcengine.com/docs/6561/1359370
[lh-tts-doc]: https://lobehub.com/docs/usage/agent/tts-stt
[lobe-tts]: https://github.com/lobehub/lobe-tts
[lobe-tts-edge]: https://tts.lobehub.com/api-reference/edge-speech-tts
[edge-tts]: https://github.com/rany2/edge-tts
[edge-tts-lic]: https://github.com/rany2/edge-tts/blob/master/LICENSE
[azure-speech]: https://azure.microsoft.com/zh-cn/pricing/details/cognitive-services/speech-services/
[mdn-speech]: https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis
[civil-code]: https://flk.npc.gov.cn/detail2.html?ZmY4MDgxODE3MjlkMWVmZTAxNzI5ZDUwYjVjNTAwYmY%3D
[cac-deep]: https://www.cac.gov.cn/2022-12/11/c_1672221949354811.htm
[cac-label]: https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
