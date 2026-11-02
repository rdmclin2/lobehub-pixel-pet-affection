# 流式回复：主进程与桌宠消息界面

分支 `feat/streaming-audit`，接在核心层（[`streaming-core.md`](streaming-core.md)：`lh-client` / `responses-client` 的 `onDelta`）之后。本步把增量一路送到桌宠的气泡：AI 回复边写边显示（带输入中光标），写完后用最终文本校正；内容守卫、梗图、聊天记录、好感度、朗读仍然只按最终完整回复执行一次。

## 事件协议

```
renderer send()  ── window.pet.chat(text) ──► main ipcMain.handle('chat') ──► PetService.chat()
                                                                                 │ _openStream('chat', turn)  → 本回合唯一 id
                                                                                 │ _runTurn(args, stream)    → client.run({ …, onDelta })
   onDelta(chunk, soFar) ─► content-guard(soFar) ─► memes.streamingText(soFar) ─► emit('chat-delta')
                                                                                 │ （回合结束）
                                       _guard(res.text) → _say(final, …, stream) ─► emit('say', { …, streamId })
                                                                               └─► emit('chat-done', { ok: true, text })
   失败 / 取消：emit('chat-done', { ok: false, reason: 'error' | 'canceled', text: null })，没有 'say'
main.js:  service.on('chat-delta'|'chat-done') → webContents.send(同名频道)
preload:  window.pet.onChatDelta(cb) / window.pet.onChatDone(cb)  （返回取消订阅函数）
```

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `chat-delta` | `{ id, n, kind, turnId, text, withheld?, restart? }` | `text` 是**到目前为止可显示的全文**（不是单个碎片）：去掉了已完成的 `[梗图:id]` 和可能正在写的标签尾巴（`[梗`、`[梗图:th`）。`n` 每条递增。内容守卫命中后只再发一次 `{ text: '', withheld: true }`，此后不再发（直连失败改走 `lh` 时例外：先发 `{ text: '', restart: true }` 清空，再按回退路径重新开始，见 [streaming.md 第六节](streaming.md#六回退行为)） |
| `say` | 原有字段 + `streamId` | 最终台词（守卫后、去标签），`streamId` = 该流的 `id` |
| `chat-done` | `{ id, ok, reason, text, kind, turnId, deltas, withheld }` | 每个流**恰好一次**；成功时在 `say` 之后、`text` = 最终台词；失败 `reason: 'error'`，取消 `reason: 'canceled'` |

**id 语义**：`_openStream` 为每个回合生成新 id（`r<序号><时间>`），聊天 `chat()`、话题 `talkTopic()`、系统事件 / 主动搭话 `_speak()`（`turnId: null`）各自一条流。`PetService` 本身同一时刻只跑一个回合（`busy`），id 用来让渲染端区分：已结束的流的迟到碎片、比已见过的 `n` 更旧的碎片一律丢弃；新 id 出现即开始新的气泡状态。取消请求后（`_cancelRequested`）和流结束后（`closed`）的碎片在主进程就被丢掉。

## 渲染端（`src/renderer/app.js`）

- `onChatDelta`：按 id 建 / 更新 `stream` 状态，`showStream()` 停掉"思考中…"计时器，气泡 `textContent = text`，加 `.streaming`（CSS `::after` 闪烁光标 `▍`），`data-stream = id`；用户没往上翻时滚到底部跟随；嘴动；守卫撤回时显示 `……`。控件在整个流式期间保持隐藏（`body.busy`），Esc / 停止按钮照常可用。
- 最终 `say(…, streamId)`：`endStream(id, true)`，去掉 `.streaming`，`textContent` 换成最终台词（校正：工具前导语、梗图标签、守卫拒绝语都以这里为准），贴梗图、按全文算显示时长；`speak(m)` 朗读最终全文（按句），**流式碎片不朗读**。
- `chat-done` 失败 / 取消：去掉光标，已显示的部分照常定时隐藏；聊天框随后照旧显示"（好吧，不想了。）"或错误台词。
- 非流式台词（比如流式中被摸一下的反应）可以临时占用气泡，下一个碎片会把气泡拿回来。
- 聊天记录面板（`history.js` `PetHistory.live`）：打开的会话里含本回合的用户消息时，在其下插入 `.history-msg.pet.streaming` 行逐步填充；流结束后从 `chat-log` 重绘，所以留下的只是保存的那一条。
- `window.petFx.streamLog()` / `stream()`：e2e 用的显示记录。

## 只按最终回复执行一次的环节

| 环节 | 位置 | 流式期间 | 结束时 |
| --- | --- | --- | --- |
| 内容守卫 | `pet-service.js` `_openStream` / `_guard` | 对**累积全文** `checkReply`，命中即撤回、不再显示（跨块的词也能拦） | `_guard(res.text)` 照旧，`ECONTENT` 只报一次，最终台词为拒绝语 |
| 梗图标签 | `memes.streamingText` / `extractMeme` | 标签与半截标签不显示 | `_say` 用 `extractMeme` 取梗图 |
| 聊天记录 | `_say` → `_logPet` | 不写 | 写一次最终台词；取消 / 出错写空串 + `status` 一次（与改动前相同） |
| 好感度 | `state.chatted` / `_reportAffection` | 不算 | 回合成功后算一次；取消 / 出错不算 |
| 朗读 | renderer `speak(m)`（`onSay`） | 不读 | 最终台词按句读一次 |
| 表情 / 动作 | `say()` 的 `kind`、`talkUntil` | 嘴动（"说话中"） | 按最终台词时长 |

## 验证

- `npm test`：新增 `test/streaming-service.test.js`（9 个）：增量按时间逐步到达且 id 一致、`say` 带 `streamId`、`chat-done` 恰好一次且在 `say` 之后；梗图标签跨块不外露；守卫在累积文本命中即撤回；取消 / 中途出错；工具前导语以最终文本校正；每回合（含主动搭话）独立 id；一次性输出的 `lh` 仍只给一次。
- `xvfb-run -a node e2e/run.js stream`（不耗 token）：伪造 `lh` 读取 `$FAKE_LH_DIR/stream-reply.json`，每个碎片一行事件、间隔 `gapMs` 输出。页面里每 40 ms 采样气泡：
  - S1 气泡在完成前出现部分文本并逐段增长（每个采样都是最终回复的前缀、长度不减），有输入中光标，最终等于完整回复；聊天记录只增加一条完整回复；朗读只在结束后提供一次全文。
  - S2 梗图标签跨块不显示，结束时贴梗图；S3 守卫撤回；S4 Esc 中断；S5 主动搭话也流式、独立 id；S6 聊天记录面板逐步填充后显示保存内容。
  - 截图 `out/e2e/stream/*.png`，运行证据 `stream-log.txt`、`chat-log.json`、`renderer-logs.json`。
- 注意：在 Electron 宿主（如某些 agent 环境）里运行 e2e 时若设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 会以 Node 模式启动导致"Process failed to launch"，需 `env -u ELECTRON_RUN_AS_NODE xvfb-run -a node e2e/run.js stream`。
- 当前 `lh` 0.0.62 的 `--json` 在结束时一次性输出（见核心层文档），所以真实使用中经由 `lh` 的回合仍是"结束时一次显示"；直连 Responses（本机能力开 + direct）的回合是真正的实时流。
