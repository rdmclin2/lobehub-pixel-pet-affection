# 设置窗口 · 聊天 —— 主进程服务与 IPC 契约

后台（设置窗口）左侧栏「聊天」页的后端：与桌宠无关的日常 AI 聊天。渲染进程只通过 `window.petAdmin.chat` 调用；
所有通道都是 `admin-chat-*`，在主进程里用 `adminOnly` 包裹（只有设置窗口能调，测试模式除外）。

| 位置 | 作用 |
| --- | --- |
| `src/core/admin-chat.js` | 与 Electron 无关的聊天模块（会话、持久化、图片校验、上下文拼装、发送 / 流式 / 中止） |
| `src/core/models.js` → `chatModelOptions` | 从模型目录筛出可用聊天模型（复用 `refresh-models` 同一份目录） |
| `src/core/responses-client.js` | LobeHub Responses API 的认证与请求（新增可选 `signal`，只中止这一轮） |
| `src/main/main.js` | 注册 `admin-chat-*` 的 `ipcMain.handle`，推送 `admin-chat-delta` / `admin-chat-done` |
| `src/main/admin-preload.js` | 暴露 `petAdmin.chat` |
| `test/admin-chat.test.js` | 单元测试 |

## 1. 渲染进程 API（`window.petAdmin.chat`）

所有方法返回 Promise；失败不抛异常，而是 `{ ok: false, reason, error|message }`（`error` / `message` 是可直接展示的中文）。

| 方法 | IPC 通道 | 参数 | 返回值 |
| --- | --- | --- | --- |
| `chat.listModels(force?)` | `admin-chat-models` | `force`：`true` 时强制刷新模型目录 | `{ ok, models: Model[], selected: string \| null, error: string \| null }` |
| `chat.setModel(key)` | `admin-chat-set-model` | `key`：`"providerId:modelId"` | `{ ok: true, selected }` ／ `{ ok: false, reason: 'bad-model' \| 'unknown-model', message }` |
| `chat.listSessions()` | `admin-chat-sessions` | — | `{ ok, sessions: SessionSummary[] }`（按 `updatedAt` 倒序） |
| `chat.createSession(title?)` | `admin-chat-create` | `title`：可选，默认「新会话」 | `{ ok, session: SessionSummary }` |
| `chat.getSession(id)` | `admin-chat-get` | 会话 id | `{ ok, session: Session }` ／ `{ ok: false, reason: 'not-found', message }` |
| `chat.deleteSession(id)` | `admin-chat-delete` | 会话 id | `{ ok: true }` ／ `{ ok: false, reason: 'not-found' }`（同时删除该会话的图片；正在回复会先中止） |
| `chat.clearSession(id)` | `admin-chat-clear` | 会话 id | `{ ok, session: Session }`（消息与图片清空，标题恢复「新会话」，id 不变） |
| `chat.pickImages()` | `admin-chat-pick-images` | — | 主进程弹出文件选择框：`{ ok: true, images: PickedImage[], rejected: [{ name, reason, message }] }` ／ `{ ok: false, reason: 'canceled', images: [] }` |
| `chat.send(req)` | `admin-chat-send` | `SendRequest` | 回合结束时 resolve：`SendResult`（流式过程见 `onDelta`） |
| `chat.abort(sessionId?)` | `admin-chat-abort` | 会话 id（省略 = 当前任何一轮） | `{ ok: true, aborted: boolean, sessionId?, messageId? }` |
| `chat.onDelta(cb)` | 事件 `admin-chat-delta` | `cb(DeltaEvent)` | 返回取消订阅函数 |
| `chat.onDone(cb)` | 事件 `admin-chat-done` | `cb(DoneEvent)` | 返回取消订阅函数 |

### 类型

```ts
type Model = { key: string; id: string; providerId: string; label: string; vision: boolean; hosted: boolean };

type SessionSummary = {
  id: string;            // ses_…
  title: string;         // 首条用户消息前 30 字，或「新会话」
  createdAt: number;     // ms
  updatedAt: number;
  model: string | null;  // 最近一轮用的模型 key
  messageCount: number;
  preview: string;       // 最后一条有文字的消息前 60 字
};

type Session = SessionSummary & { messages: Message[]; streaming: boolean };

type Attachment = { id: string; name: string; mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; size: number; url: string | null };
// url 是 data URL，可直接放进 <img src>（设置窗口 CSP 允许 img-src data:）；文件丢失时为 null

type Message = {
  id: string;                         // msg_…
  role: 'user' | 'assistant';
  text: string;
  attachments: Attachment[];          // 只有用户消息会有
  model: string;                      // 这条消息所用模型 key
  createdAt: number;
  status: 'done' | 'error' | 'aborted';
  error?: string;                     // status === 'error' 时的可读错误
};

type ImageInput = { path: string } | { dataUrl: string; name?: string } | string; // 绝对路径或 data URL

type SendRequest = {
  sessionId: string;
  text?: string;          // ≤ 20000 字符
  images?: ImageInput[];  // ≤ 4 张；png/jpg/webp/gif（按文件头识别），每张 ≤ 10 MB
  model?: string;         // 省略 = 上次选择的模型（setModel），再没有就是列表第一个
};

type SendResult =
  | { ok: true; sessionId; userMessage: Message; message: Message; session: SessionSummary }
  | { ok: false; reason: 'aborted'; sessionId; error: '已停止'; userMessage; message /* status 'aborted'，保留已生成的文字 */; session }
  | { ok: false; reason: 'error'; code: 'EAUTH' | 'ENET' | 'ETIMEDOUT' | 'ENOREPLY' | 'EAPI' | 'EUPLOAD' | 'EAGENT' | null; error: string; sessionId; userMessage; message /* status 'error' */; session }
  | { ok: false; reason: 'not-found' | 'empty' | 'too-long' | 'too-many-images' | 'bad-input' | 'bad-type' | 'too-large' | 'not-found' | 'no-model' | 'no-vision' | 'busy'; error: string };
  // 最后一类是发送前就被拒绝：什么都不保存，也不会有 delta / done 事件

type PickedImage = { path: string; name: string; mime: string; size: number; dataUrl: string }; // dataUrl 用于输入区预览；发送时传 { path } 即可

type DeltaEvent = { sessionId: string; messageId: string; delta: string; text: string }; // text = 到目前为止的全文
type DoneEvent  = { sessionId: string; messageId: string; ok: boolean; reason?: 'aborted' | 'error'; error?: string; message: Message };
```

### 典型调用顺序（给 UI）

```js
const { chat } = window.petAdmin;
const { models, selected } = await chat.listModels();
let { sessions } = await chat.listSessions();
const sid = sessions[0]?.id ?? (await chat.createSession()).session.id;
const off = chat.onDelta((d) => { if (d.sessionId === sid) renderStreaming(d.messageId, d.text); });
const picked = await chat.pickImages();                       // 预览：picked.images[i].dataUrl
const r = await chat.send({ sessionId: sid, text: '这张图里是什么？', images: picked.images.map((i) => ({ path: i.path })), model: selected });
if (!r.ok && !r.message) toast(r.error);                       // 发送前被拒绝
// 否则 r.userMessage / r.message 就是要落到列表里的两条消息（失败与中止也会有 assistant 消息，带 status）
// 停止：chat.abort(sid)；刷新 / 切换会话：chat.getSession(id) 读回全部历史与图片
```

`send` 同一时间只允许一轮（所有会话共用一个聊天 agent），第二次调用返回 `reason: 'busy'`。

## 2. 主进程实现要点

### 持久化（`userData/admin-chat/`，经 `core/store.js` 原子写入）

```
index.json                  { version: 1, selectedModel, agent: { id, workspaceId, modelKey }, sessions: SessionSummary[] }
sessions/<sessionId>.json   { id, title, createdAt, updatedAt, model, messages: Message[] (attachments 存 file / remote) }
attachments/<sessionId>/    att_<id>.<png|jpg|webp|gif>
```

用户消息在请求模型之前就写盘，所以失败 / 中止 / 崩溃后历史里仍有它；回复结束（成功、出错或中止）后追加一条 assistant 消息。
会话 id 与附件文件名都按正则校验，渲染进程传来的 id 不能拼出目录外的路径；返回给渲染进程的附件不含磁盘路径与远端 file id。

### 请求怎样到达模型

LobeHub 的 Responses API（`POST {server}/api/v1/responses`，认证同 `ResponsesClient`：`LOBEHUB_CLI_API_KEY` 或 `lh login` 的凭据，`X-Workspace-Id` 跟随桌宠的工作区）运行的是 **agent**：`model` 字段是 agent id，所用 LLM 由 agent 的 model / provider 决定。因此：

1. **专用 agent**：第一次发送时用 `lh agent create` 建一个「Pixel Pet 聊天」agent（id 记在 `index.json`），换模型时 `lh agent edit -m <id> -p <provider>`；工作区变了会重建，agent 在 LobeHub 里被删了也会自动重建一次。
2. **多轮上下文**：实测服务端只读取 input 最后一条消息的文字（多条 message 的数组不会成为上下文），所以每轮由 `buildTurnInput` 把**本会话完整历史**（按时间顺序，出错的回复与空的中止回复除外；超过 60000 字符从最旧的开始省略）写进一条用户消息，再接上当前消息。上下文以本地存储为准，清空 / 删除会话立即生效。
3. **图片**：服务端目前会忽略 `input_image` 内容，所以图片同时走两条路：上传为 LobeHub 文件（`lh file upload`，每张只传一次，file id 缓存在附件上），挂到新话题里的一条用户消息（`lh message create` + `add-files`），本轮以 `previous_response_id` 接着这个话题，模型因此能看到图；同一请求里也按 Responses 规范附上 `{ type: 'input_image', file_id, detail: 'auto' }`。每轮带上本会话最近 6 张图片。
4. **流式与中止**：`stream: true`，`response.output_text.delta` 逐块经 `onDelta` → `admin.send('admin-chat-delta', …)` 推给设置窗口；聊天用自己的 `ResponsesClient` 实例并传入 `AbortController.signal`，`abort` 只停这一轮，不影响桌宠的对话。`tools: []`，聊天不使用本机能力。
5. **错误**：映射成可读中文（登录失效提示运行 `lh login`、连不上、超时、无回复、服务端错误原文、图片上传失败），写在 assistant 消息的 `error` 与 `SendResult.error` 里。

### 模型列表

`listModels` 调用 `PetService#refreshModels`（与 `refresh-models` 同一份缓存目录：`lh provider list` + `lh model list <provider> --type chat --enabled`），用 `models.chatModelOptions` 过滤：只要启用的 chat 模型，去掉只出图的模型（`abilities.imageOutput`）与重复项，LobeHub 托管的排前面，`vision` 来自 `abilities.vision`。上次选择存在 `index.json.selectedModel`；所选模型不支持视觉时，带图发送会返回 `reason: 'no-vision'`。

## 3. 安全边界

- 只有 `admin-chat-*` 通道，桌宠的 `chat` 通道仍不在设置窗口的白名单里（`test/admin-console.test.js`）。
- 渲染进程拿不到任何 token；聊天使用主进程里 LobeHub CLI 的登录。各类 key 仍然只写不读。
- 图片按文件头识别类型（不信任扩展名与 data URL 声明的类型），大小在解码前先检查；`pickImages` 的文件选择框在主进程里打开。

## 4. 验证

- 单元测试：`node --test test/admin-chat.test.js`（会话增删改查与重启恢复、历史顺序与多轮上下文拼装、图片校验、模型列表过滤、真实 `ResponsesClient` 经假 SSE 服务端的流式 / 报错 / 中止、preload 与本文档一致）；`npm test` 全量。
- 端到端：`xvfb-run -a node e2e/run.js adminchat`（假 lh + 假 Responses SSE，不花 token）在真实设置窗口的渲染进程里调用 `petAdmin.chat`，订阅 `onDelta` / `onDone`，覆盖模型、流式、多轮、图片、中止、重启恢复；`adminchat-live` 是同样的步骤对真实 LobeHub（会花少量 token，结束后删除建出的聊天 agent）。截图与日志在 `out/e2e/adminchat*/`，`PIXELPET_E2E_VIDEO=1` 另录视频。
