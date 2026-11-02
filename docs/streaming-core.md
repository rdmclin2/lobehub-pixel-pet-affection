# 流式回复：核心层（`lh-client` / `responses-client`）

分支：`feat/streaming-audit`，接在审查提交 `7862e74`（[`docs/streaming-audit.md`](streaming-audit.md)）之后。本步只改核心层：两个客户端都能把回复**边到边交出去**，最终返回值和错误分类不变。界面（气泡、朗读、内容守卫、梗图）怎么用这些增量不在这一步，`pet-service` 也还没传 `onDelta`，所以应用现在的行为不变。

## 接口

两个客户端的 `run()` 多一个可选参数 `onDelta(textChunk, fullSoFar)`：

- `textChunk`：这次新到的回复正文（不含推理）。
- `fullSoFar`：到目前为止所有 `textChunk` 拼起来的结果（不变式：始终等于各块之和）。
- 带工具的回合里，模型调工具前说的话（如"我看看"）也会流出来；下一轮的第一块以 `\n\n` 开头，避免两段话粘在一起。
- 回合结束时仍然返回 `{ text, topicId, cost }`，`text` 是**权威的最终回复**（与改动前完全相同：`lh` 取最后一个 `stream_end.finalContent`，Responses 取最后一轮的 `output_text`，都 `trim()`）。带工具的回合里 `fullSoFar` 比 `text` 多出前导语，下游应在结束时用 `text` 定稿。
- 回调抛异常不影响回合（吞掉）。
- 不传 `onDelta`：行为与改动前逐字节一致（`lh` 同样的参数；Responses 仍发 `stream: false`）。

## `lh-client.js`

- `runLh` 对子进程 stdout / stderr 调 `setEncoding('utf8')`：原来每个 `Buffer` 单独转字符串，一个中文字被管道切成两半时会变成两个 `U+FFFD`。现在按 UTF-8 流解码。
- `createEventScanner(onEvent)`：增量 JSON 事件扫描器。不管 `lh` 输出的是今天的"整段美化数组"还是将来可能的"每行一个事件"，只要一个顶层 `{…}` 的右括号到了就交出来；字符串里的括号和引号、转义、任意位置的分块都正确处理；对象之间的 `[`、`,`、`]`、日志行忽略，解析失败的片段丢弃。
- `createRunStream(onDelta)`：把事件变成增量——`stream_chunk` 且 `chunkType === 'text'` 的 `content` 交给 `onDelta`；`reasoning` 不交；新的 `stream_start` 出现时（前面已有正文）下一块加 `\n\n`；记下终止事件（`agent_runtime_end` / `error`）。
- `_runAgent(args, timeoutMs, onDelta)`：把扫描器挂在 `runLh` 的 `onStdout` 上。
  - `settleOn` 仍先用 `runEndCode`（数组完整 + 终止事件即结算，不等 CLI 退出前 ~15 s 的 keep-alive）；输出不是数组时（每行一个事件），扫描到终止事件就结算，退出码规则与 `runEndCode` 相同（`terminalCode`，语义未改，见审查 §4.4）。
  - 解析最终结果仍先用 `parseRunEvents(stdout)`；`parseRunEvents` 在整段 JSON 解析失败时退到扫描器（支持每行一个事件），`summarizeRunEvents` 是抽出来的原有汇总逻辑。
  - **回退**：整个回合没有任何 `stream_chunk` 正文（老的 / 不带分块的 `lh`）但拿到了最终回复时，`onDelta(text, text)` 调用一次。
  - 可选参数（`--tool` / `--device`）不认识就去掉重试、`EAUTH` / `ECLI` / `ENOREPLY` / 退出码 / `ETIMEDOUT` / `ECANCELED` 分类，代码路径未改。
- **当前 `lh` 0.0.62 的实际效果**：`--json` 在运行结束时一次性打印整个数组，所以各块在结束那一刻连续交出（等同改动前的一次性行为，不会更慢）。将来 `lh` 若逐个事件输出（审查 §4.3 建议的 NDJSON 选项），同一套代码无需改动即可实时流出——测试里用逐行、按 1 字节切分的伪造 `lh` 验证了这一点。文本模式（无 `--json`）按审查结论不解析。

## `responses-client.js`

- 有 `onDelta` 时请求体 `stream: true`、请求头 `Accept: text/event-stream`。
- `createSseParser(onEvent)`：SSE 解析，`TextDecoder` 流式解码（多字节字符跨块不坏），支持 `\n` / `\r\n` / `\r`（`\r\n` 被切在两块之间也正确）、`:` 注释行、多行 `data:`、最后一块缺空行；非 JSON 的 `data` 忽略。
- `readResponseStream(body, onText)`：读完一次流式响应，还原成与 `stream: false` 相同形状的对象 `{ id, status, output, output_text, usage, error }`，后面的工具轮次逻辑完全复用：
  - `response.output_text.delta` → `onText`；
  - `response.output_item.done` → 按 `output_index` 收集输出项（**工具调用从这里取**：实测 `response.incomplete` 的 `response.output` 是空数组）；
  - `response.completed` / `response.incomplete` / `response.failed` → 结束（读到就停止读取并 `cancel()` 连接）；
  - SSE `error` 事件 → `status: 'failed'` → `EAPI`；`data: [DONE]`（OpenAI 风格结束标记）→ 停止读取，若此前没有终止事件按提前断流处理；
  - 流在终止事件前断开 → `EAPI`（"stream ended before the response was complete"）；网络异常 → `ENET`；取消 / 超时 → `ECANCELED` / `ETIMEDOUT`（与原来相同）；`toolsRan` 照常标注。
  - body 支持 `ReadableStream`（`getReader`，真实 `fetch`）和异步可迭代对象。
- 工具轮次：`function_call` → 本机执行 → 带 `strict_tool_resume` 续一轮，续轮同样 `stream: true`；最多 12 步不变。
- **非流式回退**：服务器即使收到 `stream: true` 仍回 JSON（老服务端、代理），按 `content-type` 判断后走原来的 `res.json()`，并把该轮正文用 `onDelta` 一次交出。

## 测试

`npm test`：466 / 466 通过（改动前 445，新增 21）。新增用例：

| 文件 | 用例 | 驱动方式 |
| --- | --- | --- |
| `test/lh-client.test.js` | 逐行事件实时到达、顺序正确、整字（含 emoji 代理对 🍵）；`fullSoFar` 不变式；结果与非流式相同、推理不外泄 | 伪造 `lh`（`FAKE_LH_STREAM=ndjson`），每 7 字节一写、间隔 4 ms |
| | 每 1 字节切一次仍得到同样的块（JSON、字符串、UTF-8 任意切） | `FAKE_LH_SLICE=1` |
| | 工具前导语 + `\n\n` + 最终段；`text` 只取最后一步；费用累加 | `ndjson-steps` |
| | 今天的 `lh`：整段数组一次写出 → 一次性回退 | `array` |
| | 回放真实样本 `lh-run-json-long.json`（lh 0.0.62）→ 11 个文本块，拼起来等于最终回复 | `fixture:` |
| | 没有 `stream_chunk` 的 `lh` → `onDelta` 恰好调用一次（全文） | 原伪造输出 |
| | 不认识 `--device` → 去掉重试，仍只交一次 | `FAKE_LH_NO_DEVICE_FLAG` |
| | 中途 `error` 事件 → 已交出的块保留、回合失败（`Agent run failed`） | `ndjson-error` |
| | 写到一半不再输出 → `ETIMEDOUT`，之前的块已交出 | `ndjson-hang` |
| | 回调抛异常不影响回合 | |
| | `createEventScanner` 在每个切点切两半都得到 a / b / c（字符串里的 `{\"x\"}`、嵌套、日志行） | 单元 |
| | `parseRunEvents` 读每行一个事件 | 单元 |
| `test/responses-client.test.js` | 真实样本 `responses-sse-long.json` 原始字节每 5 字节切 → 12 个 delta 与样本一致、无 `U+FFFD`、结果 = `output_text.done`；分别用异步迭代 body 和真实 `Response(ReadableStream)` | 样本 |
| | 真实样本 `responses-sse-tool.json`（每 3 字节切）→ "我看看" → 本机执行 `list_directory {path:/tmp}` → 第二轮 `stream:true` + `strict_tool_resume` → `\n\n` + 答案；费用来自 `response.completed` | 样本 + 伪造续轮 |
| | 服务器回 JSON → 老路径、`onDelta` 一次 | 伪造 |
| | 不传 `onDelta` 仍 `stream:false`、无 `Accept` | 伪造（保持性用例，改动前也通过） |
| | `[DONE]` 跟在 `response.completed` 后 → 正常结束 | 伪造 |
| | 中途 `response.failed` / `error` 事件 / 提前断流 / 无终止事件的 `[DONE]` → `EAPI`；body 抛错 → `ENET`；已交出的"你好"保留 | 伪造 |
| | 流还在来时 `cancel()` → `ECANCELED` | 伪造 |
| | `createSseParser`：CRLF、注释、多行 data、非 JSON 块，在每个字节切点切两半都一致 | 单元 |
| | 回调抛异常不影响回合 | 伪造 |

**改动前失败**：把新测试文件放到 `7862e74` 的 `src/` 上跑：46 个用例中 19 个新增用例失败、"不传 `onDelta` 仍 `stream:false`"这条保持性用例通过，原有 26 个全部通过。

## 真实服务验证

`scripts/streaming-live-check.js <agentId>`：对一个临时 agent 依次跑 `LhClient#run`、`ResponsesClient#run`、带本机工具的 `ResponsesClient#run`，都带 `onDelta`，记录每块到达时间。2026-11-01 对 app.lobehub.com（`lh` 0.0.62）实测，跑完已删除临时 agent：

| 路径 | 总耗时 | delta 数 | 第一块 | 最后一块 | 拼接 = 最终 | 乱码 |
| --- | --- | --- | --- | --- | --- | --- |
| `lh agent run --json` | 10109 ms | 7 | 10103 ms | 10104 ms | 是 | 无 |
| Responses `stream:true` | 8109 ms | 7 | **2874 ms** | 4545 ms | 是 | 无 |
| Responses + 本机工具 | 11325 ms | 2 | **2300 ms**（"我看看"） | 7289 ms（`\n\n` + 答案） | 是 | 无 |

即：直连路径第一段字比整段返回早约 5 秒出现；`lh` 路径按预期一次性回退（各块在结束时连续交出）。工具回合真实执行了 `list_directory /tmp/pp-live-dir` 并在续轮流式给出"里面有一个 banana 文件夹、一个「苹果」文件夹和 readme.txt 文件"。

## 留给下一步

- `pet-service._runTurn` 传 `onDelta` 并向 renderer 发增量事件；要让本机能力关闭的回合也走流式，需要按审查 §4.3 让它们也走 Responses（`tools: []`），`lh` 作回退。
- 审查第三节的 #1 内容守卫（对累积文本检查、命中即撤回）、#2 梗图标签尾巴、#5/#6 气泡与朗读增量化、#12 工具前导语是否显示。
