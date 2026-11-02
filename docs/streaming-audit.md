# 流式回复审查：仓库现状、聊天链路与增量数据源

分支：`feat/streaming-audit`（基于 `canary` `26bc0de`，v0.17.0 之后）。本文是"桌宠支持流式输出 AI 回复"的第一步：确认仓库能装能跑，画出聊天回复从模型到气泡的完整链路，列出依赖"完整回复"的下游环节，并用真实的 `lh` 和 LobeHub 服务实测哪里能拿到增量数据。本分支**不改 `src/` 的任何行为**，只加文档、探针脚本、脱敏样本和锁定样本结论的测试，作为后续实现的基础分支。

结论先说：

1. **可运行**：干净 clone → `npm ci` → `npm test` 436/436 通过；非 live 的 e2e 场景 `fresh` 14/14、`busy`（含 `longreply` / `daemon` / `oldlh`）15/15、`history` 7/7、`chatvoice` 5/5，全部通过，没有失败项。
2. **现在的回复是整段到达的**：两条路径都拿完整回复。`lh agent run --json` 由 CLI 在运行结束后一次性打印整个事件数组；直连路径 `responses-client.js` 发的是 `stream: false`。
3. **`lh` 本身有增量数据，但 `--json` 不吐**：服务端确实按 `stream_chunk` 分块推送（样本里一段 517 字的回复有 11 个文本块，跨 2.9 秒），但 `lh` 0.0.62（以及 lobehub 源码里的 0.0.72）在 `--json` 模式下把事件攒到最后才 `console.log`。`lh man agent run` 没有 `--stream` / NDJSON 一类选项。去掉 `--json` 的文本模式会实时写正文，但混着日志行、步骤分隔、工具行，而且**推理内容（reasoning）在非 TTY 下没有任何标记地夹在正文里**，不能可靠解析。
4. **可用的增量数据源**：直连 `POST /api/v1/responses` 带 `stream: true` 返回标准 SSE（`response.output_text.delta` …），已实测：一段约 600 字的回复分 12 个 delta、每 ~300 ms 一个，各 delta 拼起来与 `response.output_text.done` 的全文一致；带本机工具时以 `response.incomplete`（`client_tool_execution`）结束，和现在的非流式驻留协议一致。推荐后续实现以它为主路径，`lh` 路径作为回退（详见第四节）。

## 一、可运行性

环境：Linux x64，Node v24.21.0，`lh` 0.0.62，`xvfb-run`。全新目录 clone（未复用任何旧 checkout）。

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 克隆 | `git clone https://github.com/rdmclin2/lobehub-pixel-pet-affection.git` | 成功，默认分支 `canary`，HEAD `26bc0de 🔀 chore(sync): merge main (af404e4) into canary` |
| 安装 | `npm ci` | 成功（只有 npm 对 `electron-winstaller` install script 的提示，不影响运行） |
| 单测 | `npm test` | `tests 436 / pass 436 / fail 0`，约 80 s |
| e2e | `xvfb-run -a node e2e/run.js fresh` | `14/14 passed` |
| e2e | `xvfb-run -a node e2e/run.js busy` | `15/15 passed`（busy 10 + longreply 1 + daemon 3 + oldlh 1） |
| e2e | `xvfb-run -a node e2e/run.js history` | `7/7 passed` |
| e2e | `xvfb-run -a node e2e/run.js chatvoice` | `5/5 passed` |

选这四个场景是因为它们覆盖聊天回复链路：`fresh`（创建 agent 后第一次 `agent run`、话题）、`busy`（思考中状态、Esc / 停止按钮取消、贴图、拖文件、长回复滚动）、`history`（聊天记录落盘）、`chatvoice`（回复逐句朗读、新消息打断朗读）。`live` 会花 token 创建真实 agent，按 `AGENTS.md` 不跑；真实服务的验证改由第四节的探针完成。

**失败项：无。** 截图和日志在 `out/e2e/`（不入库）。

### 已有功能与未完成部分（与本目标相关）

- `docs/t-1229-runnable-audit.md` 的结论（代码无 TODO/FIXME，`roster` 场景和 Linux 沙盒问题已修）在当前 `canary` 上仍成立；本次 `grep -rn "TODO\|FIXME" src` 为 0。
- `docs/dsh-pet-gap.md` §三：对话（D25）、梗图（D30）、TTS（D31）已实现；**没有任何一项涉及流式**。`docs/tts-voice-research.md` §流式 把"长回复按句切分、逐句请求排队播放"列为 TTS 第二期，现在已经按句朗读（`Voice.sentences`），但依然要等整段回复到达。
- 全仓 `grep -i "stream\|流式"`（`src/`、`docs/`、`README.md`）：除 `lh-client.js` 解析 `stream_start` / `stream_end`、`responses-client.js` 的 `stream: false`、TTS 的 MiniMax `stream: false` 外没有流式相关代码。**流式回复是一项全新能力**，不是做了一半的功能。
- 开放 PR #94（`feat/vrm` → `canary`，VRM 3D 角色）：改 `renderer/app.js`（外观、VRM 渲染、口型跟随音频），不碰聊天链路（`pet-service.chat`、`lh-client`、`responses-client`、`say()` 气泡逻辑）。后续流式实现要改 `app.js` 的 `say()` / `speak()`，与 #94 有文本层面的合并冲突风险，但没有语义冲突；#94 的口型由 TTS 音频驱动，流式朗读后口型照常工作。

## 二、聊天回复链路（现状）

行号以本分支（= `canary` `26bc0de`）为准。

```
renderer  src/renderer/app.js
  send()  :1827  ── Enter / 发送
    stopSpeech('new-message'); window.pet.chat(text, imgs, files)  :1843   ← await 整个回合
                                │ ipcRenderer.invoke('chat')
preload   src/main/preload.js:44  chat: (text, images, files) => invoke('chat', …)
                                │
main      src/main/main.js:292  ipcMain.handle('chat') → saveImages → service.chat(text, paths, filePaths)
                                │
service   src/main/pet-service.js
  chat()  :707   busy=true, emit('thinking', true), _logUser(…)  :718
                 有图片：lh file upload / topic create / message create / add-files
                 prompt = persona.buildChatPrompt(…)
    _runTurn()  :653 ─┬─ 本机能力关 或 localVia≠direct ─→ LhClient.run()            (A)
                      └─ 本机能力开 且 direct ──────────→ ResponsesClient.run()     (B)
                                                         失败且没跑过工具 → 回退 (A)
                 ← { text, topicId, cost }   （完整回复）
    state.chatted()        pet-state.js:205        好感、关系阶段
    _guard(res.text)       :175 → content-guard.checkReply  命中则整段换成拒绝台词
    _say(text,'llm','chat',…,turn)  :189
        memes.extractMeme  memes.js:23   去掉 [梗图:id] 标签，选出梗图
        _logPet            :220 → chat-log.append  聊天记录落盘（chat-log.json）
        emit('say', { text, source, kind, meme, origin, … })
        _save()  → pet.json + emit('update')
    _reportAffection()  :765  emit('affection') / 升阶 → _speak('stage_up')
    finally: busy=false, emit('thinking', false)
                                │ main.js:496-497  service.on('say'|'thinking') → webContents.send
renderer  window.pet.onSay(m) :2697 → say(m.text, …) :1441   气泡 textContent = 整段；按长度定显示时长
                                    → speak(m)          :1522   朗读：Voice.sentences(整段) → 逐句 TTS
          window.pet.onThinking  :2699 → setThinking :1691   "思考中…" 动画，隐藏控件
```

(A) `LhClient.run()` `src/core/lh-client.js:372` → `_runAgent()` `:391` → `runLh()` `:41` 起子进程
`lh agent run -a <agentId> -p <prompt> --json [-t <topicId>] [--tool …] [--device …]`，
`settleOn: runEndCode`（`:412`）在 stdout 里出现完整 JSON 数组和 `agent_runtime_end` 时立刻结算（不等 CLI 退出前 ~15 s 的 keep-alive），再 `parseRunEvents()`（`:428`）取 `stream_end.data.finalContent` 作为回复、`stream_start.data.assistantMessage.topicId` 作为话题、累加 `usage.cost`。`runLh` 已有 `onStdout` 回调参数，但 `_runAgent` 没用它。

(B) `ResponsesClient.run()` `src/core/responses-client.js:187`：`POST {server}/api/v1/responses`，body `{ model: agentId, input, previous_response_id: topicId, stream: false, tools, tools_mode: 'exclusive' }`（`:203`），`await res.json()`（`:208`）。有 `function_call` 就在本机执行工具、带 `strict_tool_resume` 再发一轮（最多 12 步），没有就取 `output_text` 返回。

走同一个 `_runTurn` 的其他入口（同样拿完整回复后一次性 `_say`）：

- 话题面板 `talkTopic()` `pet-service.js:782`（renderer `window.pet.talkTopic`）。
- 系统事件 `_speak(kind)` `:670`：初次见面 `met`、升阶 `stage_up`、心跳主动搭话（`heartbeat()` `:1089`：饿了 / 无聊 / 早晚问候 / `missed`）。
- 本机 HTTP 接口 `POST /pixel-pet/chat`（`src/core/api.js:72`）→ `main.js:538` → `service.chat(text, [], [], { origin: 'api' })`，HTTP 响应里要返回完整 `text`。

## 三、依赖"完整回复"的下游环节

流式化时，每一项都要决定"对增量做什么、对最终全文做什么"。

| # | 环节 | 位置 | 现在怎么用回复 | 流式化的影响 / 需要的处理 |
| --- | --- | --- | --- | --- |
| 1 | 内容守卫 | `content-guard.js:16` `checkReply`；`pet-service.js:175` `_guard` | 对整段跑正则，命中则**整段不显示**，换成拒绝台词 | 最关键的约束：增量一旦上屏就收不回。需要对"已累积文本"逐次检查，命中立刻停止显示并替换气泡；或者按句缓冲、通过才上屏。词可能跨块（"做" + "爱"），必须对累积文本而不是单个 delta 检查。最终全文仍要再查一次 |
| 2 | 梗图标签 | `memes.js:9` `TAG_RE`、`:23` `extractMeme`；`_say` `:192` | 整段去掉 `[梗图:id]`，选第一张 | 标签在末尾、可能被切成 `[梗` + `图:cat]`。增量显示时要把未闭合的 `[` 尾巴先扣住不显示；梗图在最终全文确定后再贴 |
| 3 | 好感度 | `pet-state.js:205` `chatted`；`pet-service.js:743`、`_reportAffection` `:765` | 用**用户**输入长度计分，回复到达后才加分 | 与回复内容无关，只需保持"回合成功后才加分、取消/出错不加分"的时机 |
| 4 | 聊天记录 | `chat-log.js:136` `append`；`_logPet` `pet-service.js:220` | 存守卫与去标签后的最终全文；取消/出错存空串加 `status` | 只在回合结束时写一次最终文本；中途取消要决定存"已显示部分 + canceled"还是空串（建议前者，用户已经看到了） |
| 5 | TTS 分句朗读 | renderer `speak()` `app.js:1522` → `Voice.sentences`（`voice.js:93`）/ `speakable`（`voice.js:33`，去掉 `[..]`、`【..】`）；`showSentences` `:1664`、`markReading` | 拿整段切句，逐句合成排队播放，气泡按句高亮 | 天然适合流式：句子完整一句就入队。但 `showSentences` 要求 `b.textContent === text`（整段），流式时气泡文本在变，需要改成按句追加 span；`MAX_SENTENCES` 等上限按累积计算；朗读不能读到随后被守卫拦下的句子（与 #1 一起设计） |
| 6 | 气泡显示 | `say()` `app.js:1441` | 一次写 `textContent`，按全文长度算 `talkUntil`（嘴动）和自动隐藏时长 | 需要"开始 / 追加 / 结束"三段式：思考动画（`setThinking`）在第一个 delta 到达时让位给气泡；隐藏计时在结束时才开始；`longreply` 的滚动要跟随追加 |
| 7 | 表情 / 动作 | `say()` 里 `kind === 'error'` → `fx.play('sad')`；`talkUntil` 驱动嘴动；`interaction-voice.js:52` `classify` / `moodFor` 用 `kind` | 由 `kind` / `source` 决定，**不解析回复里的表情或动作标签**（全仓除梗图外没有其他回复标签） | 只需要在流式期间保持"说话中"状态；没有额外的标签解析要改 |
| 8 | `busy` / 思考中 / 取消 | `pet-service.js` `busy`、`emit('thinking')`；`cancel()` → `lh.cancel()` / `responses.cancel()`；renderer Esc / 停止按钮 | 回合结束前一直 busy；取消后说"（好吧，不想了。）" | 流式期间仍是 busy（控件隐藏、停止按钮可用）；取消要中止 SSE 读取，已显示的文字留在气泡里 |
| 9 | 话题 id / 费用 | `parseRunEvents`、`ResponsesClient.run` 返回 `topicId`、`cost` | 回合结束时更新 `c.topicId` | SSE 第一个事件 `response.created` 就带 `response.id`（= 话题 id），可以提前拿到；费用在 `response.completed` |
| 10 | 本机 HTTP `/chat` | `api.js:72` | 等完整 `text` 再回 HTTP | 可以继续等最终全文，不必流式 |
| 11 | 系统事件 / 话题回复 | `_speak` `:670`、`talkTopic` `:782` | 同 `chat()` 的完整回复路径 | 同一套增量事件可以复用；第一期可以只做 `chat()` |
| 12 | 工具步骤的前导语 | `responses-client.js` 只在没有 `function_call` 的那一轮取文本 | 带工具的回合里，模型调工具前说的话（如"我看看"）被丢弃 | 流式时这段话会先作为 delta 到达（见样本 `responses-sse-tool.json`），要决定显示还是丢弃 |

## 四、增量数据源：探针与结论

### 4.1 `lh agent run`

`lh man agent run`（0.0.62）的全部选项：`-a/-s/-p/-t`、`--no-auto-start`、`--device`、`--no-headless`、`--json`（"Output full JSON event stream"）、`-v`、`--replay`、`--sse`（"Force SSE stream instead of WebSocket gateway"）、`--timeout`。**没有 `--stream` / `--ndjson` / 按行输出事件的选项。**

探针 `scripts/streaming-probe.js` 用与应用相同的方式（`lh-client.cleanEnv`）起 `lh`，记下每次 stdout 写入距启动的毫秒数。临时 agent（探针结束后已 `lh agent delete`），2026-11-01 对 app.lobehub.com 实跑：

| 样本 | 命令 | stdout 写入次数 | 时间分布 | 结论 |
| --- | --- | --- | --- | --- |
| `lh-run-json.json` | `--json`，四句自我介绍 | 2 | 8394 / 8395 ms（同一次 `console.log`） | 一次性 |
| `lh-run-json-long.json` | `--json`，约 600 字散文 | 2 | 10828 / 10828 ms | 一次性；数组里有 11 个 `stream_chunk`(text)，服务端时间戳跨 2942 ms |
| `lh-run-sse-json.json` | `--sse --json` | 2 | 6081 / 6081 ms | `--sse` 只换传输，输出仍一次性 |
| `lh-run-text.json` | 无 `--json` | 9 | 正文在 5280、5477 ms 两块写出 | 正文实时写出 |
| `lh-run-text-long.json` | 无 `--json`，约 600 字 | 20 | 正文 5711 → 8889 ms 共 13 块，每块约 45 字、间隔约 300 ms | 正文实时写出；比 `--json` 早约 5 秒看到第一段正文 |
| `lh-run-sse-text.json` | `--sse`，无 `--json` | 10 | 推理与正文在同一时刻写出 | **推理"用户要求四句话…"直接接在正文前面，没有分隔** |
| `lh-run-text-forcecolor.json` | `FORCE_COLOR=1`，无 `--json` | 9 | 推理以 `\x1b[2m…\x1b[22m` 包裹，且出现在正文**之后** | 只有强制颜色时推理才可区分；顺序也不保证 |

源码佐证（本机 `/usr/lib/node_modules/@lobehub/cli/dist/index.js` 0.0.62，与 lobehub 仓库 `apps/cli/src/utils/agentStream.ts` 0.0.72 一致）：

```js
// WebSocket 网关路径（默认）
if (msg.type === "agent_event") {
  const agentEvent = msg.event;
  if (streamOpts.json) jsonEvents.push(agentEvent);   // --json：只攒起来
  else renderEvent(agentEvent, ctx, streamOpts);      // 文本模式：实时渲染
  if (agentEvent.type === "agent_runtime_end") { …; printJsonOnce(); settle(outcome); }
}
// printJsonOnce → console.log(JSON.stringify(jsonEvents, null, 2))  ← 结束时才打印
// renderEvent 'stream_chunk':
if (data.chunkType === "text" && data.content) process.stdout.write(data.content);
else if (data.chunkType === "reasoning" && data.reasoning) process.stdout.write(pc.dim(data.reasoning));
```

`--json` 里一个 `stream_chunk` 事件的样子（来自 `lh-run-json.json`，已脱敏）：

```json
{"data":{"chunkType":"text","content":"我是像素宠物流式探测小分身，临时上线陪着你聊天。…"},"operationId":"op_REDACTED1","stepIndex":0,"timestamp":1793546353510,"type":"stream_chunk"}
```

**结论**：`lh` 有增量数据（`stream_chunk`），但当前 CLI 只在文本模式实时输出，而文本模式不是机器可读格式：日志行（`[INFO] Operation…`）、`── Step n ──`、工具行、`✓ Agent finished` 与正文混在同一个 stdout，推理在非 TTY 下没有标记。靠解析文本模式实现流式是脆弱的，不推荐作为主路径。

### 4.2 直连 `/api/v1/responses`（`stream: true`）

探针 `scripts/streaming-probe-responses.js` 发与 `responses-client.js` 相同的请求，只把 `stream: false` 改成 `true`，认证同样来自 `lh login` 存下的凭据（`readCliCredentials`），逐块记录原始 SSE 字节和解析后的事件。

| 样本 | 场景 | 结果 |
| --- | --- | --- |
| `responses-sse.json` | 五句秋天 | `200 text/event-stream`，9 个事件，1 个 delta（短回复一次给完） |
| `responses-sse-long.json` | 约 600 字散文 | 20 个事件；**12 个 `response.output_text.delta`，3654 → 6969 ms，约 300 ms 一个、每个约 50 字**；`output_text.done` 在 11022 ms。即第一段字比非流式早约 7 秒出现 |
| `responses-sse-tool.json` | 提供本机工具（`PROBE_TOOLS=1`），要求先说"我看看"再列目录 | 先 `output_text.delta "我看看"`，再 `output_item.added(function_call list_directory)` → `function_call_arguments.delta/done` → 最后 `response.incomplete`，`incomplete_details.reason = "client_tool_execution"`（探针不执行工具） |

事件序列（`responses-sse-long.json`）：

```
response.created            { response: { id: "tpc_…", status: "in_progress", … } }   ← 话题 id 这里就有
response.in_progress
response.output_item.added  { item: { type: "message", id: "msg_tpc_…_0", … } }
response.content_part.added
response.output_text.delta  { delta: "**秋日贴地飞行**\n\n晨起推开窗…", item_id, output_index, sequence_number }  ×12
response.output_text.done   { text: <全文> }
response.content_part.done
response.output_item.done
response.completed          { response: { id, status: "completed", output: […], usage: {…} } }
```

原始 SSE 片段（`responses-sse-long.json` 的 `reads[*].text`）：

```
event: response.output_text.delta
data: {"content_index":0,"delta":"…","item_id":"msg_REDACTED1","logprobs":[],"output_index":0,"sequence_number":4,"type":"response.output_text.delta"}
```

`test/streaming-fixtures.test.js` 把这些结论锁在样本上：各 delta 拼起来等于 `output_text.done.text`；最后一个事件是 `response.completed`，`response.id` 与第一个事件相同；工具样本以 `response.incomplete` / `client_tool_execution` 结束；`--json` 样本的 stdout 全部同时到达而事件里有多个 `stream_chunk`；`parseRunEvents` 取到的 `finalContent` 等于各文本块之和。

### 4.3 结论与推荐方案

增量数据源存在，目标不需要降低。按优先级：

1. **主路径：直连 Responses SSE**（推荐）。`ResponsesClient.run()` 改为 `stream: true`，读 SSE：`output_text.delta` → 增量回调；`response.completed` → 结束（取 `id`、`usage.cost`、`output`）；`response.incomplete` + `function_call` → 执行本机工具后照旧带 `strict_tool_resume` 续一轮（续轮同样流式）；`response.failed` / HTTP 错误 → 现有错误码。现在只有"本机能力开 + direct"的回合走这条路；要让所有聊天都流式，`_runTurn` 需要在本机能力关闭时也走 Responses（`tools: []`），并保留 `lh agent run` 作为凭据不可读、HTTP 失败、老服务端时的回退。认证、工作区（`X-Workspace-Id`）、话题延续（`previous_response_id` = 话题 id）都已有实现。
2. **`lh` 路径的增量（回退时用）**：
   - 理论上可行但不推荐：文本模式 + `FORCE_COLOR=1`，靠 ANSI dim 区分推理与正文、过滤日志 / 步骤 / 工具行。它依赖终端渲染格式（不是接口契约），推理与正文的先后也不固定（见 `lh-run-text-forcecolor.json`），话题 id、费用、结束原因也只能从 `[INFO] Operation … Topic: …`、`✓ Agent finished · … · $0.0058` 这类给人看的行里抠。回退路径保持整段输出更稳妥。
   - 根本办法：给 `lh agent run` 加一个逐行输出事件的选项（例如 `--json-stream` / NDJSON：每个事件到达时 `console.log(JSON.stringify(event))`），改动只在 `agentStream.ts` 两个分支里。这是 lobehub 开源 CLI 的改动，需要单独提 PR；合入前桌宠用 `lh --help` 探测是否支持（`lh-client.run` 已有"不认识的参数就去掉重试"的机制）。
3. **按事件分块的"伪流式"兜底**：两条路都拿不到增量时，拿到全文后按 `Voice.sentences` 逐句显示（配合逐句朗读），体验上接近流式但不缩短首字时间，只作兜底。

后续实现要同时处理第三节的 #1（内容守卫对累积文本检查、命中即撤回）、#2（梗图标签尾巴）、#5/#6（气泡与朗读的增量化）。

### 4.4 顺带发现

- `runEndCode()`（`lh-client.js:412`）把 `agent_runtime_end.data.reason` 有值就当失败（返回 1），而真实成功运行的 `reason` 是 `"done"`（三个 `--json` 样本都是）。今天无害：`_runAgent` 先看 `parseRunEvents` 拿到文本就返回，不看退出码；但回复为空时会报"Agent run failed (exit 1)"而不是"Agent produced no reply"。不在本任务范围内修改，记录在此。
- `lh agent run` 在打印结果后约 15 s 才退出（样本 `totalMs` 21–25 s，而 `✓ Agent finished` 在 6–10 s），与 `lh-client.js` 注释一致，`settleOn` 已处理。

## 五、样本与脚本

| 路径 | 内容 |
| --- | --- |
| `test/fixtures/streaming/lh-run-text.json`、`lh-run-text-long.json` | `lh agent run`（无 `--json`）每次 stdout 写入的时间与内容 |
| `test/fixtures/streaming/lh-run-sse-text.json`、`lh-run-text-forcecolor.json` | 文本模式下推理与正文混排（非 TTY / 强制颜色） |
| `test/fixtures/streaming/lh-run-json.json`、`lh-run-json-long.json`、`lh-run-sse-json.json` | `--json` 的原始 stdout（整个事件数组）及写入时间 |
| `test/fixtures/streaming/responses-sse.json`、`responses-sse-long.json`、`responses-sse-tool.json` | `/api/v1/responses` `stream:true` 的原始 SSE 读取块（`reads`）和解析后的事件（`events`） |
| `scripts/streaming-probe.js` | `node scripts/streaming-probe.js <out.json> -- agent run -a <agentId> -p "<prompt>" [--json] [--sse]` |
| `scripts/streaming-probe-responses.js` | `node scripts/streaming-probe-responses.js <out.json> <agentId> "<prompt>"`；`PROBE_TOOLS=1` 提供本机工具 |
| `scripts/streaming-redact.js` | `node scripts/streaming-redact.js <in.json> <out.json>`：id 换成 `agt_REDACTED1` 等占位符（同一 id 同一占位符）；`finalState` / `uiMessages` / `llmCalls` / `agentConfig` / `sender` / `tools` 等含账号上下文的字段换成 `[redacted: N bytes]`；`--json` 的数组若分几次写出，先拼成一块再脱敏，每次写入的时间与字节数保留在 `mergedWrites`；流式文本块原样保留 |
| `test/streaming-fixtures.test.js` | 把 4.1 / 4.2 的结论锁在样本上（9 个测试） |

脱敏检查：`grep -l "user_2gmZ\|<邮箱>\|agt_<真实 id>\|tpc_[A-Za-z0-9]\{10,\}\|op_[0-9]\{10\}\|call_00\|Bearer\|accessToken" test/fixtures/streaming/*` 无结果。凭据从不写入样本（探针只在请求头里使用）。

复现：

```bash
npm ci && npm test
xvfb-run -a node e2e/run.js fresh   # 以及 busy / history / chatvoice
lh agent create -t "streaming probe" -s "你是一只桌面宠物，用简短中文回答。"   # 记下 agt_…
PIXELPET_CLEAR_JWT=1 node scripts/streaming-probe.js /tmp/text.json -- agent run -a agt_… -p "写一段大约六百字的秋天散文，分成六段。"
PIXELPET_CLEAR_JWT=1 node scripts/streaming-probe.js /tmp/json.json -- agent run -a agt_… -p "…" --json
node scripts/streaming-probe-responses.js /tmp/sse.json agt_… "写一段大约六百字的秋天散文，分成六段。"
node scripts/streaming-redact.js /tmp/sse.json test/fixtures/streaming/responses-sse-long.json
lh agent delete agt_… --yes
```

（`PIXELPET_CLEAR_JWT=1` 只在从另一个 agent 运行里启动时需要，作用同 `lh-client.cleanEnv`。）
