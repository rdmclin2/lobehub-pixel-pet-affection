# 流式回复（Streaming）：机制与验证

桌宠的 AI 回复会**边写边显示**在她的气泡里：第一段字一到就出现，后面的字在同一个气泡里逐步变长（带闪烁的输入光标 `▍`），写完后用最终完整回复校正一次。本文是总览：数据从哪里来、每一层怎么处理、哪些环节仍只按完整回复执行一次、什么时候退回"整段一次显示"，以及怎么验证。

分层细节见：[审查与数据源](streaming-audit.md)（实测样本、选型理由）· [核心层](streaming-core.md)（`lh-client` / `responses-client` 的 `onDelta`）· [主进程与界面](streaming-ui.md)（事件协议、气泡、聊天记录）。

```
LobeHub ──(SSE / lh --json 事件)──► 核心层客户端 onDelta(chunk, fullSoFar)
        ──► PetService._openStream：内容守卫 → 去梗图标签 → emit('chat-delta')
        ──► main.js webContents.send('chat-delta')  ──► preload window.pet.onChatDelta
        ──► renderer onChatDelta → 气泡 textContent = 已显示全文（.streaming 光标）
回合结束 ──► _guard(最终文本) → _say → 'say'{streamId}（气泡校正、梗图、朗读、聊天记录）→ 'chat-done'
```

---

## 一、数据源与事件格式

桌宠的一回合（聊天、话题、问候 / 主动搭话等系统台词）由 `PetService._runTurn`（`src/main/pet-service.js`）选择路径。**原则：只要直连可用，所有回合都走直连 Responses 流式**——因为当前 `lh agent run --json` 要到运行结束才输出事件，只有直连能让气泡逐步变长。

| 回合 | 首选路径 | 请求 | 不可用 / 失败时 |
| --- | --- | --- | --- |
| 本机能力**开**，直连已验证（`localVia === 'direct'`） | 直连 Responses | `tools` = 4 个本机函数工具（`read_file` 等，在应用内执行） | 还没有工具执行过：同一回合改走 `lh connect` 设备（`lh agent run --tool lobe-local-system --device …`）；已有工具执行过：报错，不重跑 |
| 本机能力**开**，经 `lh connect` 设备（直连不可用时才会这样） | `lh agent run --tool … --device …` | — | — |
| 本机能力**关**、问候、主动搭话、话题、初次见面等**不带本机工具的回合** | 直连 Responses（`_directUp()` 为真时） | `tools: []`（`tools_mode: 'exclusive'`，模型拿不到任何工具）、`stream: true`、同一个 `model: agentId`、`previous_response_id: topicId` | 同一回合自动回退 `lh agent run -a <agent> -t <topic> --json`（不带 `--tool` / `--device`），见第六节 |

`_directUp()`：有 `ResponsesClient`，能读到 `lh` 的登录（`LOBEHUB_CLI_API_KEY` 或 `~/.lobehub/credentials.json`），并且最近 5 分钟（`LOCAL_RETRY_MS`）内直连没有失败过。它只看本地文件，不发网络请求。

两条路径的数据源：

| 路径 | 增量来源 | 实时性 |
| --- | --- | --- |
| **直连 Responses**（`src/core/responses-client.js`） | `POST {server}/api/v1/responses`，请求体 `stream: true`、请求头 `Accept: text/event-stream`，返回标准 SSE | **真正实时**：2026-11-01 实测本机能力开 / 关两种情况，第一段字分别在发送后约 6.1 s / 3.5 s 出现，之后每 0.4 s 左右一段 |
| **`lh agent run --json`**（`src/core/lh-client.js`，回退） | `lh` 子进程 stdout 中的 JSON 事件 | 当前 `lh`（0.0.62–0.0.73 均已实测）在 `--json` 下**运行结束时才一次性打印**整个事件数组，所以回退时整段一次出现。将来 `lh` 若逐个事件输出，同一套代码无需改动即可实时流出 |

**同一 topic / 上下文**：Responses 的 response id 就是 LobeHub 的 topic id（`tpc_…`）。直连回合用 `previous_response_id = c.topicId` 继续同一个 topic，返回的 `id` 写回 `c.topicId`；`lh agent run` 用 `-t c.topicId`。所以两条路径交替（例如回退后又回到直连）时一直在同一段聊天历史里：实测本机能力关闭后第 3 回合问"我刚才先后让你描写了哪两个季节的什么时候"，回答"你先让我写了秋天的傍晚，后来又让我写了冬天的清晨。"（第 1 回合是本机能力开时的直连回合）。`lh message list --topic-id` 也能看到三回合都在同一个 topic 里。人格（system role）、模型都在 agent 上，两条路径相同。

**鉴权**：直连用 `lh login` 存下的 token（或 `LOBEHUB_CLI_API_KEY`），过期时先调一次 `lh whoami` 让 CLI 刷新再读。读不到 → `_directUp()` 为假 → 直接走 `lh agent run`，行为与改动前一致。

### 1.1 Responses SSE（主路径）

每个事件是 `event:` + `data:`（JSON）+ 空行。用到的事件：

```
event: response.created            data: {"type":"response.created","response":{"id":"resp_…","status":"in_progress","output":[]}}
event: response.output_text.delta  data: {"type":"response.output_text.delta","item_id":"msg_…","output_index":0,"content_index":0,"delta":"秋天的傍晚，天色是","sequence_number":4}
event: response.output_item.done   data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","name":"list_directory","arguments":"{\"path\":\"/tmp\"}","call_id":"…"}}
event: response.completed          data: {"type":"response.completed","response":{"id":"resp_…","status":"completed","output":[…],"usage":{"cost":0.0012}}}
event: response.incomplete         data: {…"incomplete_details":{"reason":"client_tool_execution"}}   ← 需要本机执行工具
event: response.failed / error     data: {…}                                                         ← 失败
data: [DONE]                                                                                        ← OpenAI 风格结束标记（可选）
```

- 正文增量只取 `response.output_text.delta` 的 `delta` 字段；推理内容不显示。
- 工具调用从 `response.output_item.done` 收集（实测 `response.incomplete` 里的 `response.output` 是空数组）。
- 带工具的回合：模型先说"我看看"（流出）→ `response.incomplete` → 本机执行工具 → 带 `strict_tool_resume` 续一轮（同样 `stream: true`）→ 下一段以 `\n\n` 开头继续流出。最多 12 步。

### 1.2 `lh agent run --json`（回退路径）

stdout 是一个 JSON 数组（将来也可能是每行一个事件），每个元素形如：

```json
{"type":"stream_start","data":{"assistantMessage":{"topicId":"tpc_…"}},"stepIndex":0,"timestamp":…}
{"type":"stream_chunk","data":{"chunkType":"text","content":"我是像素宠物…"},"operationId":"op_…","stepIndex":0,"timestamp":1793546353510}
{"type":"stream_chunk","data":{"chunkType":"reasoning","reasoning":"…"}, …}     ← 不显示
{"type":"stream_end","data":{"finalContent":"…完整回复…"}, …}
{"type":"agent_runtime_end", …}   /   {"type":"error", …}                       ← 终止事件
```

只有 `chunkType === "text"` 的 `content` 是正文增量。真实样本见 `test/fixtures/streaming/`（已脱敏）。

## 二、核心层解析

两个客户端的 `run({ …, onDelta })` 多了同一个可选回调 `onDelta(textChunk, fullSoFar)`：`textChunk` 是新到的正文，`fullSoFar` 是到目前为止的累积全文（不变式：始终等于各块之和）。回合结束仍返回 `{ text, topicId, cost }`，其中 `text` 是**权威最终回复**（与改动前逐字节相同）。回调抛异常被吞掉，不影响回合。不传 `onDelta` 时行为与改动前完全一致（Responses 仍发 `stream: false`）。

| 文件 / 函数 | 作用 |
| --- | --- |
| `responses-client.js` `createSseParser(onEvent)` | SSE 分帧：`TextDecoder` 流式解码（汉字 / emoji 被切在两个网络包之间也不乱码）；支持 `\n` / `\r\n` / `\r`、`:` 注释行、多行 `data:`、末尾缺空行；非 JSON 的 `data` 忽略 |
| `responses-client.js` `readResponseStream(body, onText)` | 读完一次流式响应：`output_text.delta` → `onText`（累积成 `fullSoFar`）；收集 `output_item.done`；读到 `completed` / `incomplete` / `failed` 就停并 `cancel()` 连接；还原成与 `stream:false` 同形的 `{ id, status, output, output_text, usage, error }`，后续工具轮次逻辑完全复用 |
| `lh-client.js` `createEventScanner(onEvent)` | 增量 JSON 扫描：不管是"整段数组"还是"每行一个事件"，一个顶层 `{…}` 闭合就交出；字符串里的括号 / 转义、任意位置切块都正确 |
| `lh-client.js` `createRunStream(onDelta)` | 事件 → 增量：`stream_chunk`(text) 的 `content` 交给 `onDelta`；新 `stream_start` 出现时下一块前加 `\n\n`；记下终止事件 |
| `lh-client.js` `_runAgent(args, timeoutMs, onDelta)` / `runLh` | 扫描器挂在子进程 stdout 上（`setEncoding('utf8')`，按 UTF-8 流解码）；结算、错误分类（`EAUTH` / `ECLI` / `ENOREPLY` / `ETIMEDOUT` / `ECANCELED`）不变 |

## 三、IPC 事件（主进程 → 渲染进程）

`PetService._openStream(kind, turn)` 为每个回合开一条流（新 id `r<序号><时间>`），把 `stream.onDelta` 传给客户端；`main.js` 把服务事件原样转发：`service.on('chat-delta' | 'chat-done') → webContents.send(同名频道)`；`preload.js` 暴露 `window.pet.onChatDelta(cb)` / `window.pet.onChatDone(cb)`（返回取消订阅函数）。方向均为 **main → renderer**；发起仍是原来的 `window.pet.chat(text)`（renderer → main，`ipcMain.handle('chat')`）。

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `chat-delta` | `{ id, n, kind, turnId, text, withheld?, restart? }` | `text` 是**到目前为止可显示的全文**（不是碎片），已去掉完整的 `[梗图:id]` 和正在写的半截标签；`n` 每条递增；内容相同则不发。守卫命中后只再发一次 `{ text: '', withheld: true }`。直连失败、同一回合改走 `lh` 时，如果已显示过内容，发一次 `{ text: '', restart: true }`（同一 id）清空气泡，之后的 `text` 是回退路径的全文 |
| `say` | 原有字段 + `streamId` | 最终台词（守卫后、去标签），`streamId` = 该流的 `id` |
| `chat-done` | `{ id, ok, reason, text, kind, turnId, deltas, withheld }` | 每条流**恰好一次**：成功时在 `say` 之后；失败 `reason:'error'`，Esc / 停止 `reason:'canceled'`（此时没有 `say`） |

聊天（`chat()`）、话题（`talkTopic()`）、问候 / 主动搭话（`_speak()`，`turnId: null`）都各自开流。取消请求后、流结束后的迟到碎片在主进程就被丢弃。

**一次只有一条流**：回合进行中（`busy`）再发消息，`chat()` 返回 `{ ok:false, reason:'busy' }`，界面上输入框等控件隐藏、只留"停止"；这时到期的主动搭话（心跳触发的饥饿 / 无聊等）**直接跳过**，不再说兜底台词——否则它会插进正在流式的气泡、并在聊天记录里夹在用户消息和她的回复之间；下一次心跳会再问。回合结束（或按停止）后即可发下一条，新回合是新的 stream id。

## 四、渲染层增量显示（`src/renderer/app.js`）

- **整段替换而不是追加**：`onChatDelta` 收到的是已显示全文，`showStream()` 直接 `bubble.textContent = text`。这样丢包、乱序都不会让文字重复或错位：渲染端按 `id` 区分流，`n` 不大于已见过的、或属于已结束流的碎片一律忽略。
- **节流策略**：不额外节流。主进程已把"内容没变"的碎片过滤掉，服务端每 0.3–0.5 s 才来一段，一次 `textContent` 赋值的开销可以忽略；也因此不需要 rAF 合并或虚拟化。
- **外观**：第一段字到达时停掉"思考中…"，气泡加 `.streaming`（CSS `::after` 闪烁光标 `▍`）和 `data-stream=id`；用户没往上翻时自动滚到底跟随最新一行；嘴巴动（"说话中"）。控件在整个流式期间保持隐藏（`body.busy`），Esc / 停止按钮照常可用。
- **定稿**：最终 `say(…, streamId)` → `endStream(id, true)` 去掉光标，`textContent` 换成最终台词（工具前导语、梗图标签、守卫拒绝语都以此为准），滚回顶部，贴梗图，按全文计算显示时长。
- **失败 / 取消**：`chat-done ok:false` → 去掉光标，保留已显示部分并照常定时隐藏；聊天框随后照旧显示"（好吧，不想了。）"或错误台词。
- **聊天记录面板**（`history.js` `PetHistory.live`）：打开的会话含本回合的用户消息时，插入 `.history-msg.pet.streaming` 行逐步填充；流结束后从 `chat-log` 重绘，最终只留保存的那一条。
- 调试 / e2e：`window.petFx.streamLog()` 记录每次显示的碎片（`{ev:'delta', id, n, len, text, at}`）和结束（`{ev:'end', ok, reason}`）。

## 五、与内容守卫 / 好感度 / TTS 的关系

原则：**流式只影响"字怎么出现在气泡里"**；所有需要完整回复的环节仍在回合结束后、按最终文本**只执行一次**。一回合的先后顺序（`chat()`）：

1. 用户消息写入聊天记录（`_logUser`），开流（`_openStream`），气泡显示"思考中…"。
2. 每个增量：**内容守卫**先对累积全文 `contentGuard.checkReply(fullSoFar)` 检查（跨块拼出的词也能拦）→ 命中则发一次 `withheld`、气泡显示 `……`、此后不再显示任何碎片；未命中 → `memes.streamingText` 去梗图标签 → `chat-delta`。
3. 回合结束：**好感度** `state.chatted()` 计一次（只在成功时；取消 / 出错不计）→ 内容守卫 `_guard(res.text)` 对最终文本再判一次（命中时 `ECONTENT` 只报一次，最终台词为拒绝语）→ `_say()`：取梗图、写**聊天记录**（一次，最终台词）、发 `say{streamId}` → `chat-done` → `_reportAffection()` 发好感变化（飘心 / 阶段提升）。
4. 渲染端收到 `say` 后才**朗读（TTS）**：`speak(m)` 按句朗读最终全文一次；**流式碎片不朗读**。

| 环节 | 流式期间 | 结束时 |
| --- | --- | --- |
| 内容守卫 | 对累积全文检查，命中即撤回 | `_guard(res.text)`，拒绝语为最终台词 |
| 梗图标签 | 完整 / 半截标签都不显示 | `extractMeme` 取图贴出 |
| 好感度 | 不计 | 成功后计一次 |
| 聊天记录 | 不写（面板里只是临时行） | 写一次最终台词；取消 / 出错写空串 + `status` |
| 朗读（TTS） | 不读 | 最终台词按句读一次 |
| 表情 / 嘴型 | 说话中 | 按最终台词时长 |

## 六、回退行为

| 情况 | 结果 |
| --- | --- |
| 直连不可用（未登录 / 读不到凭据 / 5 分钟内直连失败过 / `responses` 未启用） | 不带工具的回合直接走 `lh agent run`；当前 `lh` 结束时一次性输出，气泡**整段一次出现**（与改动前相同） |
| 不带工具的直连回合失败（HTTP 4xx/5xx、`EAUTH`、网络错误、流提前断开、`ENOREPLY`、服务端要求调用工具等不兼容） | **同一回合**立刻改走 `lh agent run -t <同一 topic>`（无 `--tool`/`--device`）：回复不丢；如果直连已经显示了一部分，先发一条 `chat-delta { text:'', restart:true }`（同一 stream id）把气泡清空，再显示 `lh` 的回复，不会出现两段拼接；`say` / 聊天记录 / 好感 / 朗读仍只在 `_runTurn` 返回后由调用方执行一次。记一条 `error` 日志（"直连流式失败，这次改用 lh agent run"），5 分钟内后续回合直接走 `lh`，之后再试直连 |
| Esc / 超时（`ECANCELED` / `ETIMEDOUT`） | 不回退（与改动前相同）：取消显示"（好吧，不想了。）"，超时显示错误台词 |
| `lh` 输出里没有任何 `stream_chunk` 正文（老版本 `lh`）但有最终回复 | `onDelta(text, text)` 调用一次 → 一条 `chat-delta` → 整段显示 |
| 服务端收到 `stream:true` 仍回 JSON（老服务端 / 代理，按 `content-type` 判断） | 走原来的 `res.json()`，该轮正文用 `onDelta` 一次交出 → 整段显示 |
| 本机能力开的直连回合失败且还没有工具执行过 | 同一回合改走 `lh connect` 设备（`_runTurn` 回退，气泡同样先 restart），提示"直连 LobeHub 失败，这次改用 lh connect" |
| 本机能力开的直连回合失败且已有工具执行过 | 不重跑（避免同一工具执行两次）；已显示的部分保留、光标去掉，随后显示错误台词；聊天记录写 `status:error`，不计好感 |
| 回退的 `lh agent run` 也失败 | 与改动前相同：错误台词，聊天记录写 `status:error` |
| 不传 `onDelta`（例如本机 HTTP 接口等不需要气泡的调用方） | 与改动前逐字节一致：`stream:false`，整段返回 |

**已知边界（LobeHub 侧 topic 里的重复）**：直连请求如果在服务端已经写入用户消息之后才失败（例如流中途断开），回退的 `lh agent run` 会在同一 topic 里再写一条同样的用户消息和它的回复。应用自己的聊天记录（`chat-log.json`）、气泡和朗读只记 / 显示一次；HTTP 错误（服务端在开始生成前拒绝）时不会出现这种情况。

## 七、验证方式

### 7.1 单元测试

```bash
npm test
```

流式相关的测试文件：`test/lh-client.test.js`、`test/responses-client.test.js`（核心层：逐行 / 逐字节切分的伪造 `lh`、真实 SSE 样本按 3–5 字节切分回放、工具续轮、JSON 回退、各类错误）、`test/streaming-service.test.js`（主进程：增量按时间到达且 id 一致、`say` 带 `streamId`、`chat-done` 恰好一次、梗图标签、守卫撤回、取消 / 出错、每回合独立 id、一次性 `lh` 回退）、`test/streaming-fixtures.test.js`（锁定真实样本的结论）、**`test/streaming-direct-turns.test.js`**（路径选择与回退：真实 `ResponsesClient` 对本地伪造 SSE 服务 `test/fixtures/fake-responses-server.js` + 伪造 `lh`）、`test/direct-local.test.js`（本机能力开时的直连 / `lh connect`）。

`streaming-direct-turns.test.js` 覆盖：
- 本机能力关：孵化问候和聊天都发到 Responses（`stream:true`、`tools:[]`、`model` = 她的 agent），第二回合 `previous_response_id` = 第一回合返回的 topic，`lh agent run` 调用 0 次，增量逐段到达，聊天记录各一条，好感照常增加；
- 主动搭话（`_speak('hungry')`）和话题也走直连、同一 topic；
- 读不到登录：走 `lh agent run`（无 `--tool` / `--device`），直连 0 请求；
- 直连 HTTP 502：同一回合改走 `lh agent run -t <直连 topic>`，只有一次 `say`、一次 `chat-done(ok)`、聊天记录一条；5 分钟内不再试直连，之后恢复直连并沿用同一 topic；
- 直连流中途断开：增量序列 `写到 → 写到一半 → ''(restart) → 完整 → 完整的回复`，同一 stream id，最终 `say` 与聊天记录只有 `lh` 的完整回复一次；
- `lh` 打开的 topic 之后由直连用 `previous_response_id` 续用；
- 直连回合中 Esc：取消，不回退；
- 本机能力经设备（无直连登录）：仍是 `lh agent run --tool lobe-local-system --device dev_MAC`。

2026-11-01 在本分支上：**484 / 484 通过**（新增 9 个，含"流式期间到期的主动搭话被跳过"；`direct-local.test.js` 中"本机能力关时走 lh"一条按新行为改为"走直连、`tools:[]`、同一 topic"）。

### 7.2 e2e：`stream` 场景（不耗 token）

```bash
xvfb-run -a node e2e/run.js stream          # 无显示器
node e2e/run.js stream                      # 桌面
# 在 Electron 宿主里（设置了 ELECTRON_RUN_AS_NODE=1）运行时：
env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js stream
```

伪造 `lh` 读 `$FAKE_LH_DIR/stream-reply.json`，每个碎片一行事件、间隔 `gapMs` 输出；页面里每 40 ms 采样一次气泡。覆盖 S1（气泡在完成前出现部分文本并逐段增长，每个采样都是最终回复的前缀、长度不减，有光标，最终等于完整回复，聊天记录只多一条，朗读只在结束后一次）、S2 梗图标签跨块不显示、S3 守卫撤回、S4 Esc 中断、S5 主动搭话也流式且独立 id、S6 聊天记录面板逐步填充；**S7 本机能力关闭也逐步增长**：应用以 `PIXELPET_DIRECT=1`、`LOBEHUB_SERVER=<本地伪造 SSE 服务>`、`LOBEHUB_CLI_API_KEY=<假 key>` 启动（不耗 token），伪造 `lh` 只会一次性输出，所以气泡逐步变长只可能来自直连 SSE；断言 ≥5 个不同的部分文本、每个都是最终回复的前缀、长度不减、首段到完成 ≥2 s，请求体 `stream:true`、`tools:[]`、`previous_response_id` = 问候时打开的 topic，`lh agent run` 调用 0 次，聊天记录 +2、朗读 1 次；**S8 直连 502 回退**：同一回合 `lh agent run -t <同一 topic>` 一次，气泡是 `lh` 的回复，聊天记录 +2（user, pet）。证据在 `out/e2e/stream/`（截图 `s1-*`…`s8-*`、`stream-log.txt`、`stream-direct-log.txt`、`stream-direct-requests.json`、`chat-log.json`、`renderer-logs.json`）和 `out/e2e/results.json`。

### 7.3 真实 `lh` 手动验证

前提：已安装 `@lobehub/cli` 并 `lh login`（`lh whoami` 能显示用户）。会消耗少量 token。

1. `npm install`（首次）后 `npm start` 启动。首次启动选一位角色，**勾选"让它能使用这台电脑"（本机能力）**，起名后唤醒。已有桌宠的话：⋯ 菜单 → “本机能力：…”按钮打开。勾不勾都一样走直连 Responses 流式（只要 `lh` 已登录）；区别只是模型能不能用本机工具。
2. 等她的问候说完（问候本身也是流式的）。
3. 鼠标移到她身上 → 💬 → 输入一个需要较长回答的问题，例如"不要使用任何工具，直接用大约200字描写一下秋天的傍晚。"→ 发送。
4. **预期现象**：
   - 先出现"思考中…"约数秒；
   - 然后同一个气泡里出现第一句（实测约 5 s 时出现 20 多个字），末尾有闪烁的 `▍` 光标，气泡自动滚到最新一行；
   - 之后每 0.3–0.5 s 追加一段，字数持续增加、前面的字不变，嘴巴在动；期间输入框等控件隐藏，"停止"按钮可用（按 Esc 或点停止会立刻停住，保留已显示的部分）；
   - 写完后光标消失，气泡滚回开头显示完整回复（若有梗图此时贴出），开启了朗读的话此时开始按句朗读，好感飘心（如 “+1.5 ♥”，当天首次互动另有加成）也在此时出现；⋯ → 聊天记录里只有这一条完整回复。
5. 再关闭本机能力（⋯ 菜单 → “本机能力：…”）问一个长问题：现象与第 4 步相同，同一气泡逐步变长。
6. 回退对照：`lh logout` 后（或临时把 `~/.lobehub/credentials.json` 改名）再问，回复会在“思考中…”之后**整段一次出现**（`lh agent run` 路径）。

### 7.4 2026-11-01 真实环境实测结果

用真实 `lh`（0.0.73，app.lobehub.com 登录）在 Xvfb 下驱动应用（`PIXELPET_TEST=1` + `PIXELPET_DIRECT=1` 打开直连，`PIXELPET_NO_CONNECT=1`），`LH_BIN` 指向一个记录每次 `lh` 调用（毫秒时间戳 + 参数）再转给真实 `lh` 的包装脚本。创建临时 agent，本机能力**开**问一回合 → 用 `window.pet.setLocal(false)`（与菜单开关同一 IPC）**关闭**本机能力 → 再问两回合；每 40 ms 采样气泡、每次变化截图，录屏，结束后删除 agent。

| 回合 | 发送后第一段字 | 逐步显示（同一气泡、同一 stream id） | 该回合 `lh agent run` 调用 | 最终 |
| --- | --- | --- | --- | --- |
| 1. 本机能力开（直连，带本机工具） | +6.1 s，114 字 | 6 个递增阶段 114 → 141 → 151 → 186 → 224 → 230 字（+6.1 s → +7.7 s），全部是最终回复的前缀，长度不减 | 0 | 230 字 |
| 2. 本机能力**关**（直连，`tools:[]`） | +3.5 s，2 字 | 11 个递增阶段 2 → 34 → 63 → 96 → 119 → 149 → 174 → 195 → 220 → 249 → 269 字（+3.5 s → +7.0 s），全部是前缀，长度不减 | 0 | 269 字 |
| 3. 本机能力关，问前两回合内容 | +4.4 s，3 字 | 3 → 25 字 | 0 | “你先让我写了秋天的傍晚，后来又让我写了冬天的清晨。”——历史连续 |

整个会话的 `lh` 调用记录里没有任何 `agent run`（问候也走了直连）；三回合都在同一个 topic（`lh message list --topic-id` 列出 4 组 user/assistant）。改动前（`b496f9b`），本机能力关时走 `lh --json`：0 个流式采样，35 字回复在 +12.5 s 整段一次出现；`lh agent run --json` 的 stdout 在 12.5 s 时一次写出全部 7 个 `stream_chunk` 事件，确认当前 `lh` 不逐个输出事件——这就是本次把不带工具的回合也改走直连的原因。
