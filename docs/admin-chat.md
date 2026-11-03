# 设置窗口 · 聊天 —— 按角色组织的对话

后台（设置窗口）左侧栏「聊天」页：和自己的角色聊天。**一个角色就是一个会话**：用的是她自己的 LobeHub agent 和话题（与桌宠同一个），消息记在她的 聊天记录（`core/chat-log.js`）里。在这里说的话，她在桌面上也记得，⋯ → 聊天记录 里也看得到；反过来桌面上的对话也出现在这里。没有「新建会话」和「清空」：她一直在这一个对话里。

渲染进程只通过 `window.petAdmin.chat` 调用；所有通道都是 `admin-chat-*`，在主进程里用 `adminOnly` 包裹（只有设置窗口能调）。

| 位置 | 作用 |
| --- | --- |
| `src/core/admin-chat.js` | 与 Electron 无关的纯逻辑：她的对话（`conversationOf` / `historyPage`）、4 小时上下文（`recentRounds`）、回溯更早记录（`wantsRecall` / `pickRecall`）、提示词正文（`buildConsoleBody`）、图片校验与存放（`readImage` / `ChatImages`）、消息视图（`messageView`）、只留最终答案（`answerOnly`）、可读错误（`readableError`） |
| `src/main/pet-service.js` | `chatAs` / `chatHistory` / `chatCharacters` / `chatAbort`：用她的 agent 和话题跑一轮 |
| `src/main/main.js` | 注册 `admin-chat-*` 的 `ipcMain.handle`，推送 `admin-chat-delta` / `admin-chat-done` / `admin-chat-changed` |
| `src/main/admin-preload.js` | 暴露 `petAdmin.chat` |
| `admin/src/console/pages/Chat.tsx` | 聊天页（`#/chat/<角色 id>`） |
| `test/admin-chat.test.js` | 单元测试 |

## 1. 渲染进程 API（`window.petAdmin.chat`）

所有方法返回 Promise；失败不抛异常，而是 `{ ok: false, reason, error }`（`error` 是可直接展示的中文）。

| 方法 | IPC 通道 | 参数 | 返回值 |
| --- | --- | --- | --- |
| `chat.listCharacters()` | `admin-chat-characters` | — | `{ ok, busy: string \| null, characters: Character[] }`（`busy`：正在回复的角色 id，桌面那边在说话时为 `'desktop'`） |
| `chat.history(speciesId, { before?, limit? })` | `admin-chat-history` | 角色 id；`before`：消息 id（取它之前的一页），`limit` 默认 40 | `{ ok, speciesId, met, streaming, messages: Message[], hasMore, total }`（旧的在前） |
| `chat.pickImages()` | `admin-chat-pick-images` | — | 主进程弹出文件选择框：`{ ok: true, images: PickedImage[], rejected }` ／ `{ ok: false, reason: 'canceled', images: [] }` |
| `chat.send(req)` | `admin-chat-send` | `{ speciesId, text?, images? }` | 这一轮结束时 resolve：`SendResult`（流式过程见 `onDelta`） |
| `chat.abort(speciesId?)` | `admin-chat-abort` | 角色 id（省略 = 聊天页正在进行的那一轮） | `{ ok: true, aborted: boolean }`；只停聊天页自己的一轮 |
| `chat.onDelta(cb)` | 事件 `admin-chat-delta` | `cb({ speciesId, turnId, text, restart? })`，`text` 是到目前为止的全文 | 返回取消订阅函数 |
| `chat.onDone(cb)` | 事件 `admin-chat-done` | `cb({ speciesId, turnId, ok, reason?, error?, message })` | 返回取消订阅函数 |
| `chat.onChanged(cb)` | 事件 `admin-chat-changed` | `cb({ speciesId })`：她的记录变了（这里或桌面上的一轮） | 返回取消订阅函数 |

**模型**不在 `chat` 下：用已有的 `petAdmin.setModel(key, speciesId)`（与 角色 → 她的页面 → 模型 是同一个值 `settings.models[id]`），选项来自 `roster[i].model.options`（只有她所属厂商的模型，`vision` 标出能看图的）。

```ts
type Character = { id: string; name: string; met: boolean; current: boolean; count: number; lastAt: number | null; preview: string };

type Message = {
  id: string; turnId: string | null;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  status: 'done' | 'error' | 'aborted';
  error?: string;
  model: string | null;              // 这条回复所用模型 key（桌面上的旧记录没有）
  via: 'console' | 'desktop';        // 在哪里聊的
  attachments: { id; name; mime; size; url: string | null }[]; // 聊天页发的图片，url 是 data URL
  unsavedImages: number;             // 桌面上发的图片只记了张数
};

type SendResult =
  | { ok: true; speciesId; turnId; userMessage: Message; message: Message }
  | { ok: false; reason: 'aborted' | 'error'; error; speciesId; turnId; userMessage; message }   // 这一轮已记下
  | { ok: false; reason: 'not-met' | 'unknown-character' | 'empty' | 'too-long' | 'too-many-images'
      | 'bad-input' | 'bad-type' | 'too-large' | 'not-found' | 'no-vision' | 'busy'; error };   // 发送前被拒绝，什么都没记
```

## 2. 一轮怎样到达她

1. **她的 agent 和话题**：`chatAs(speciesId)` 用 `pet.characters[speciesId]` 的 `agentId` / `topicId`，不要求她是桌面上的当前角色；没见过面的角色（还没有 agent）返回 `not-met`。人设（system role）与模型在这一轮前按她自己的设置更新（`_ensurePersona` / `_applyModel(c)`），提示词与桌面相同（`persona.buildChatPrompt`，带她的状态块），但不给本机工具（`_runTurn(..., { plain: true })`）。桌面上不出气泡；她是当前角色时桌宠显示「思考中」，好感度按一次聊天计算。
2. **同一时间只有一轮**：与桌面共用 `busy`。桌面在说话时返回 `busy`，聊天页在回复时桌面也要等。
3. **记录**：用户消息在请求之前写进 聊天记录（`origin: 'user'`、`via: 'console'`、图片 `attachments: { images, refs }`），回复（或失败 / 停止）用同一个 `turnId` 写在后面。聊天页的历史就是 `chatLog.userSessions` 过滤后她的全部消息（问候、主动搭话等系统台词不出现，规则与 聊天记录 一致）。
4. **流式**：回复逐块经 `onDelta` 推送；`answerOnly` 去掉模型写进正文的工具调用 / 思考标记，梗图标签也不显示。直连失败改走 `lh agent run` 时推送 `restart: true` 重新开始这一条。

### 上下文：最近 4 小时，问起更早的再去翻

实测 LobeHub 接着同一个话题跑（`previous_response_id` = 话题 id）时会把话题里的历史交给模型。所以模型看到的上下文由**话题**决定：

- **4 小时换话题**：话题开始超过 `CONTEXT_MS`（4 小时）后，下一轮把它放进 `pastTopicIds`（LobeHub 里保留），开一个新话题；新话题的第一轮带上**最近 4 小时**的完整对话轮次（`recentRounds`，最多约 8000 字，从最旧的开始舍弃），标为「【最近 4 小时的聊天（换了新话题，接着聊）】」。话题开始时间记在 `c.topicMeta`；桌面开的或旧版本留下的话题没有记录时，取最近一段没有 4 小时间隔的对话的第一轮作为开始时间。
- **重新开始话题**（桌面 ⋯ → 重新开始）是用户要求的干净开头：之前的内容不带过去（按 `topicEpoch` 区分）。
- **回溯更早的记录**：用户的话里有指向过去或记忆的词（「之前」「以前」「上次」「还记得」「昨天」「聊过 / 说过 / 提过」「remember」…，`wantsRecall`）时，从当前上下文之前的聊天记录里挑出与问题字词重合最多的轮次，加上最近的几轮（`pickRecall`，最多 12 轮 / 约 6000 字），按时间顺序作为「【更早的聊天记录摘录】」随这一轮发出；普通消息不带。

### 图片

主进程按文件头校验（png / jpg / webp / gif，每张 ≤ 10 MB，一次 ≤ 4 张），存到 `userData/admin-chat/images/<角色 id>/att_….<ext>`（`ChatImages`，路径按正则校验，渲染进程拿不到磁盘路径），再上传为 LobeHub 文件、挂到她话题里的一条用户消息上（`lh file upload` → `message create` → `add-files`），模型因此能看到图。读历史时转成 data URL 返回。所选模型的 `abilities.vision` 为 false 时，带图发送返回 `no-vision`，什么都不记。桌面上发的图片当时没有保存，只显示张数。

## 3. 安全边界

- 只有 `admin-chat-*` 通道，桌宠窗口的 `chat` 通道不在设置窗口的白名单里。
- 渲染进程拿不到任何 token；聊天用主进程里 LobeHub CLI 的登录。各类 key 仍然只写不读。

## 4. 聊天页

`admin/src/console/pages/Chat.tsx`，rail 入口「聊天」→ `#/chat/<角色 id>`（不带 id 时打开桌面上的当前角色；地址里有 id，所以刷新后还是她）。

- **角色栏**：每个角色一行（头像、名字、最后一句、时间），见过面的在前；「在桌面」标出当前角色；正在回复的有转圈；没见过面的显示「还没见过面」，点进去有「去见她」。
- **顶栏**：她的头像和名字、消息条数与上下文说明、模型 `Select`（她所属厂商的模型，能看图的带「视觉」标签，切换即 `setModel`，和角色页同步）、刷新模型列表。
- **消息区**：`ChatItem`（Markdown）；一次读最近 40 条，顶部「查看更早的消息」往前翻页且保持阅读位置；桌面上聊的标「桌面」；生成中显示 `LoadingDots` / 逐段文字和「正在回复」；停止的标「已停止」，出错的显示错误和「重试」。贴底时跟随新内容，上翻后不拉回，出现「回到最新消息」。桌面上聊了新的一轮时（`onChanged`）自动刷新。
- **输入卡片**：Enter 发送、Shift+Enter 换行；图片按钮（主进程文件框）、粘贴、拖入，缩略图可放大、可移除；模型看不了图时提示且不发送；回复中发送按钮变「停止」。

## 5. 验证

- 单元测试：`node --test test/admin-chat.test.js`；`npm test` 全量。
- 端到端：`xvfb-run -a node e2e/run.js chatui`（假 lh，不花 token），截图在 `out/e2e/chatui/`；`admin-chat` 另加真实 LobeHub 的几步（会花少量 token）。
