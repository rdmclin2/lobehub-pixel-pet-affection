# 插个嘴（自动插嘴）设计说明 · 初稿

> 代码：`src/core/interject.js`（监听 / 预过滤 / 阈值 / 记录与规则）、`src/core/lh-client.js#decide`（`lh generate decide` 封装）、
> `src/main/pet-service.js`（接线与说话）、`src/main/main.js`（IPC、剪贴板轮询、本机接口）、`src/core/settings.js`（`interject.*`）。
> 测试：`test/interject.test.js`。演示：`node scripts/interject-demo.js`；真机 e2e：`xvfb-run -a node e2e/interject.js`。

她会“听”几处**明确列出的**输入。这些输入不是对她说的：你在她聊天框里打了字还没发、语音输入的转写、外部程序报来的事、
（单独打开时）剪贴板。偶尔她会小声插一句。思路和 LobeHub IM Bot 判断「没 @ 它的群消息要不要回」一样
（`apps/server/src/services/channel/ChannelRoutingService.ts`）：用决策模型 jev 回答一个 boolean 问题，拿到**概率**再按阈值决定，
不让生成模型自己判断。每次判断都留一条记录，主人的反应会沉淀成规则。

## 1. 数据流

```
输入来源 (chatDraft / voice / api / clipboard)
  │ Interjector.input(source, text)      ← 总开关或该来源关闭：直接拒收（不保存、不排程）
  ▼
防抖 debounceSec（连续输入时不断重置；聊天框草稿只保留最新一版）
  │ 主人把消息发出去（chat）→ 丢掉待判断的草稿 / 语音，正在进行的判断 abort
  ▼
本地预过滤 prefilter()          ← 任何一条不过：记一条 stage=prefilter 的记录，不调用 jev
  disabled · source-off · no-pet · sleeping · quiet-hours · busy · too-short · sensitive · duplicate
  · rule（命中 block 规则）· cooldown · pet-just-spoke · hourly-cap · decide-budget
  ▼
lh generate decide -m <interject.model> -q <问题 JSON> --state-file <临时文件>   （超时 timeoutSec，可中止）
  ▼
verdict()：≥ highThreshold → 插嘴；≤ lowThreshold → 不说；中间区间 → 不说（命中 allow 规则才说）
         失败 / 超时 / 拒答 / 输出解析不了 → 一律不说（不回退到生成）
  ▼
插嘴：PetService#_interjectSpeak → 现有 agent run（_runTurn，流式气泡）写一句 ≤20 字碎碎念 → _say(kind='interject')
      （主动行为的每小时 LLM 预算用完 / agent run 失败 → 离线台词 OFFLINE_LINES；只在 jev 已经说“要”之后）
  ▼
记录（interject.json）→ 反馈（mute / like / engaged / ignored）→ 规则（block / allow）→ 回到预过滤与 jev 的 state/criteria
```

`kind: 'interject'` 的台词在聊天记录里算 `proactive`（主动搭话），与饿了、无聊同一类，不出现在“主人发起的对话”里。

## 2. 输入来源与隐私边界

| 来源 | 键 | 默认 | 是什么 | 从哪来 |
| --- | --- | --- | --- | --- |
| 聊天框草稿 | `sources.chatDraft` | 开 | 她自己的聊天框里打了、还没发送的字 | 渲染进程 `#chat-input` 的 `input` 事件 → `interject-draft`（只在总开关和该来源开着时才发） |
| 语音输入 | `sources.voice` | 开 | 语音输入转写出的文字 | `PetService#asrTranscribe` 成功后（自动发送的那句随后到达的聊天会把它丢掉） |
| 外部程序 | `sources.api` | 开 | 本机脚本主动告诉她的内容 | `POST /pixel-pet/observe {"text": "…"}`（对外接口须开启并带令牌，只监听 127.0.0.1） |
| 剪贴板（系统级） | `sources.clipboard` | **关** | 剪贴板里的纯文本 | 主进程每 3 秒 `clipboard.readText()`，只在总开关和它都开着时轮询；开始监听时已有的内容不算 |

边界：

- **只听上表**。没有全局键盘钩子，不读其它窗口的标题或内容，不截屏，麦克风只在你按 🎤 时录。
- 总开关 `interject.enabled` 默认关闭。关闭时 `input()` 直接拒收，待判断的输入和进行中的判断都会清掉。设置窗口和 e2e 都证明了这时 **jev 调用为 0**。
- 系统级来源（剪贴板）有自己的开关，默认关；总开关打开它也不会跟着开。
- 发给 jev 的 state：每条输入截到 200 字，最多 5 条、10 分钟内，整段 ≤ 1500 字。像密码、密钥、验证码、长数字串的输入在预过滤阶段就丢掉（`sensitive`），不发给模型，也不回给她。
- 落盘的记录（`interject.json`）只留 24 字摘要和 64 位哈希（用于去重）。剪贴板来源只记 `[clipboard N 字]`，敏感内容记 `[敏感内容已略去]`。jev 的报错原文不落盘，只记错误码，因为报错里可能夹着输入。
- 传给 `lh` 的 state 走 0600 临时文件（`--state-file`），用完即删，不出现在命令行参数里。
- 插嘴台词走现有 agent run，所以那一小段输入会作为提示词进入她的 LobeHub 话题，和平时聊天一样。

## 3. 判断：问题与阈值

问题只有一个（`buildQuestions`）：

```json
{ "interject": { "type": "boolean",
  "instructions": "A desktop pet companion sits on the owner's screen. The state lists what the owner recently typed or said that was NOT addressed to the pet. Is it appropriate and valuable for the pet to interject ONE short casual remark about it right now, without disturbing the owner?",
  "criteria": {
    "true": "The input shows a feeling, a small win or struggle, or a light topic a caring companion would naturally react to, and one short remark would feel welcome rather than intrusive.[ The owner has welcomed remarks about: …]",
    "false": "The owner is focused or busy, the input is routine, private, unclear or not worth a reaction, the pet spoke recently, or a remark would just be noise.[ The owner asked the pet not to interject about: …]" } } }
```

state（`buildState`）：

```
[时间] 15:32（下午，星期二，工作日）
[宠物] 小芽；醒着；心情 69/100；上次说话：2 分钟前；上次插嘴：从未
[最近的输入]（都不是对宠物说的）
- （聊天框里正在打的字（还没发给她），0 秒前）终于把这个 bug 修好了！累死我了
[主人定下的规则]
- 别插嘴：工作
```

| 概率 p | 结果 | 说明 |
| --- | --- | --- |
| p ≥ `highThreshold`（默认 0.7） | 插嘴 | 与 IM Bot 相同 |
| p ≤ `lowThreshold`（默认 0.3） | 不说 | 与 IM Bot 相同 |
| 中间区间 | **不说**；命中 allow 规则才说 | IM Bot 在这里回退成“全员回答”。宠物的原则是不打扰优先，所以反过来 |
| 失败 / 超时 / 拒答 / 非法概率 | 不说 | 不回退到生成，不重试 |

阈值是策略默认值，不是测出来的准确率，要拿真实记录（`interject.json` 里的 `probability` 和 `feedback`）去校准。
2026-11-03 用产品代码真实调用 jev-1.14.0、没有规则时的几个样本：「终于把这个 bug 修好了！累死我了」0.67，「今天好累啊，一点都不想上班」0.72，
「奶茶店今天买一送一诶！」0.44，「帮我把 ./dist 目录压缩一下再上传」0.17，「SELECT * FROM users…」0.15。
情绪类在阈值附近，指令或代码类明显偏低，同一句话多次调用会有 ±0.1 左右的浮动。

## 4. 不打扰：预过滤与额度

| 项 | 设置 | 默认 |
| --- | --- | --- |
| 两次插嘴的冷却 | `cooldownMin` | 10 分钟（另有：她 60 秒内刚说过话也不插） |
| 每小时最多插嘴 | `maxPerHour` | 3 |
| 每小时最多调用 jev | `maxDecidePerHour` | 20（`proactive.js` 的 `LlmBudget`） |
| 连续输入防抖 | `debounceSec` | 4 秒 |
| 太短不判断 | `minChars` | 6 字 |
| 勿扰时段 | `quietStart`–`quietEnd` | 23–8 点（相同 = 不设） |
| 重复输入 | — | 30 分钟内同一句（规范化后哈希相同）不再判断 |
| 她在睡觉 / 正在回复（busy） | — | 不判断 |
| 插嘴台词的 LLM 调用 | `proactive.maxLlmPerHour` | 与主动搭话共用预算，超出改用离线台词 |

## 5. 记录与规则

### 5.1 判断记录（`<userData>/interject.json` 的 `decisions`，最多 200 条）

```json
{ "id": "d_mw0sdudc1f7e8e", "at": 1793716320000, "source": "chatDraft", "category": "code", "bucket": "afternoon",
  "summary": "终于把这个 bug 修好了！累死我了", "hash": "0e1ff014a9650c59", "chars": 18,
  "stage": "decided", "reason": "confident", "probability": 0.86, "model": "jev-1.14.0", "latencyMs": 36,
  "verdict": "interject", "said": "（小声）嘿嘿，辛苦啦～", "via": "llm",
  "feedback": "mute", "feedbackAt": 1793716380000, "ruleIds": ["r_mw0sf4o0911292"] }
```

- `stage`：`prefilter`（被本地拦下，`reason` 为上面的原因之一）、`decided`（jev 有答案）或 `error`（jev 失败，`reason` 为 `error` / `timeout` / `aborted`，只记 `errorCode`）。
- `verdict`：`interject` / `skip` / `silent`。`reason` 在 `decided` 时取 `confident`、`confident-no`、`uncertain`、`uncertain-allowed`、`refused`、`invalid`、`moment-passed` 或 `speak-failed`。
- `category`：本地关键词分类，取 `code`、`work`、`food`、`play`、`mood` 或 `other`。`bucket` 是时段，取 `morning`、`afternoon`、`evening` 或 `night`。

### 5.2 反馈

| 反馈 | 怎么来 | 结果 |
| --- | --- | --- |
| `mute` | 插嘴后 5 分钟内主人在聊天框说「别打扰 / 别插嘴 / 闭嘴 / 安静点 / 嘘…」（`MUTE_RE`），或 UI 点 🙊（`interject-feedback`） | 立刻生成 block 规则 |
| `like` | UI 点 👍 | 立刻生成 allow 规则 |
| `engaged` | 插嘴后 5 分钟内主人在聊天框接话 | 同一范围累计 2 次（含 like）生成 allow 规则 |
| `ignored` | 插嘴后 10 分钟没有任何反应（心跳 `tick()`） | 同一范围最近 3 次都被忽略时生成 block 规则 |

显式反馈（🙊 / 👍）可以覆盖先记下的隐式反馈；隐式反馈不会覆盖显式反馈。

### 5.3 规则（`interject.json` 的 `rules`，最多 50 条）

```json
{ "id": "r_mw0sf4o0911292", "effect": "block", "category": "code", "origin": "mute",
  "createdAt": 1793716380000, "hits": 1, "note": "别插嘴：写代码 / 技术" }
{ "id": "r_mw0t3kao1d2b49", "effect": "allow", "category": "food", "origin": "like",
  "createdAt": 1793717520000, "hits": 1, "note": "可以插嘴：吃喝" }
{ "id": "r_mw1a2b3c4d5e6f", "effect": "block", "source": "api", "bucket": "night", "origin": "manual",
  "createdAt": 1793720000000, "hits": 0, "note": "别插嘴：来源：外部程序（本机接口 /observe） · 深夜（23–6 点）" }
```

- 匹配：规则写了的字段（`category` / `source` / `bucket`）全部相等才算命中。有分类的输入按分类出规则，`other` 按“来源 + 时段”出规则，避免一条规则拦掉所有输入。
- 同一范围只留一条规则。新的 block 会替换同范围的 allow，反过来也一样。
- 本地生效：block 命中时，预过滤直接拦下，不调用 jev，`hits` 加 1。allow 命中时，中间区间的概率也算“要说”。
- 模型侧生效：最近 10 条规则写进 state 的「主人定下的规则」，同时拼进问题的 `criteria.true` / `criteria.false`。

### 5.4 查看 / 删除接口（供设置窗口的规则页使用，UI 在后续任务）

| 层 | 接口 |
| --- | --- |
| PetService | `interjectRules() → { rules }` · `interjectAddRule(rule) → { ok, rule }` · `interjectDeleteRule(id) → { ok } \| { ok:false, reason:'not-found' }` · `interjectDecisions(limit=50) → { decisions, status }` · `interjectFeedback(decisionId, 'mute'\|'like'\|'engaged'\|'ignored') → { ok, decision, rule }` · `interjectInput(source, text) → { accepted, reason? }` |
| IPC（`ipcMain.handle`） | `interject-rules` · `interject-add-rule {rule}` · `interject-delete-rule {id}` · `interject-decisions {limit}` · `interject-feedback {id, kind}` · `set-interject <patch>`；`interject-draft {text}`（send） |
| preload（`window.pet.interject`） | `rules()` · `addRule(rule)` · `deleteRule(id)` · `decisions(limit)` · `feedback(id, kind)` · `set(patch)` · `draft(text)`；事件 `window.pet.onInterject(cb)`（`{ type: 'decision'\|'feedback'\|'said', decision, rule, decisionId }`） |
| 本机 HTTP | `POST /pixel-pet/observe {"text"}` → 202 `{ok:true, accepted:true}`，或 200 `{ok:true, accepted:false, reason}` |

## 6. 配置（`settings.json` → `interject`）

```json
"interject": {
  "enabled": false,
  "sources": { "chatDraft": true, "voice": true, "api": true, "clipboard": false },
  "cooldownMin": 10, "maxPerHour": 3, "maxDecidePerHour": 20, "debounceSec": 4, "minChars": 6,
  "quietStart": 23, "quietEnd": 8, "highThreshold": 0.7, "lowThreshold": 0.3, "timeoutSec": 10,
  "model": "lobehub/jev-1.14.0"
}
```

- 迁移：旧文件没有 `interject` 时取默认值（关闭）；非法值回到各自的默认值；`sources` 里不认识的键丢掉；`lowThreshold ≥ highThreshold` 时两项都回到默认值；`model` 必须是 `provider/model` 形式（`DECISION_MODEL_RE`）。见 `normalizeInterject`。
- 设置窗口：玩法 → 主动搭话与好感 → 「插个嘴」卡片（由 `settings-schema.js` 生成，改动即时生效）。也可以用 `window.pet.interject.set({ enabled: true, sources: { clipboard: true } })`，只改 `sources` 里的一项时其它来源保持不变。

## 7. 怎么用 / 怎么验证

1. 设置窗口 → 玩法 → 主动搭话与好感 → 打开「插个嘴」，按需调整来源和额度。jev 需要 LobeHub 登录（`lh login`），服务端须配置 TypeSafe 决策模型。
2. 在她的聊天框里打一句、停一下不发送；或者用 🎤 说一句；或者让脚本 `curl -X POST -H "Authorization: Bearer <令牌>" -d '{"text":"build failed"}' http://127.0.0.1:7340/pixel-pet/observe`。
3. 她插嘴后，在聊天框回「别打扰」会沉淀成 block 规则；用 `window.pet.interject.rules()` 查看规则，用 `deleteRule(id)` 删除。
4. 不连 LobeHub 的演示：`node scripts/interject-demo.js`。这里用假 `lh`（`test/fixtures/fake-lh.js`）：`generate decide` 返回脚本写进 `decide.json` 的概率，`agent run` 返回固定台词。脚本会逐步打印 输入 → 预过滤 → 概率与阈值 → 台词 / 不说的原因 → 反馈 → 规则 → 规则拦截。
5. 真机 e2e：`xvfb-run -a node e2e/interject.js`。产物在 `out/e2e/interject/`：截图、视频、`evidence.json`、`chapters.json`。

失败时的降级：没登录、没有 TypeSafe 权限、超时或模型拒答时，她一律不说话。这条记为 `stage: error` 或 `reason: refused`，下一次输入照常判断（计入每小时 jev 预算）。不会改用生成模型去“猜”要不要说。
