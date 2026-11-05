# 表情包（Sticker）体系设计

> T-6172 · 2026-11-05 · 状态：**定稿待负责人确认**（第 7 节列出要负责人决定的问题）。
> 这份文档是后续实现任务的唯一依据：数据模型（§2）、聊天发送与渲染（§3）、角色表情包管理（§4）、商店与后端（§5）、实施拆分（§6）。
> 行号按 `canary @ 8f5c7cd`（2026-11-05）核对。代码移动后，以文中的函数名为准。

## 0. 结论速览

| 问题 | 结论 |
| --- | --- |
| 单位 | **表情包（sticker）** 是一张图；**表情包集合（sticker set）** 是一组表情包，也是商店上架的单位。每位角色（`speciesId`，和聊天记录、agent 同一个 id）持有一个**有序的集合列表**：她自带的「内置」集合、主人自己的「我的」集合（可增删），以及从商店获取的集合（只读）。 |
| 内置梗图 | 不迁移文件。`src/characters/<id>.json` 的 `memes` 和 `assets/memes/<id>/<id>.webp` 在运行时转换成只读集合 `builtin:<speciesId>`。`[梗图:id]` 标签继续可用，并扩展为可以选择所有已挂到角色上的表情包。 |
| 存储 | `<userData>/stickers/`：图片按 sha256 内容寻址存成 `blobs/<sha>.<ext>`，集合写成 `sets/<setId>.json`，角色挂接关系写在 `bindings.json`。删除一张表情包时，聊天记录里引用它的图片仍然能显示。图片通过新增的 `sticker://` 协议提供给两个窗口。 |
| 格式与限制 | 支持 PNG / WebP / GIF / JPG，按文件内容识别类型（复用 `readImage`/`sniffImage`）。单张最大 2 MB，边长 64–1024 px。每个集合最多 120 张，每位角色最多挂 20 个集合。动图（GIF / 动态 WebP）保留原图。 |
| 聊天入口 | 主入口是设置窗口「聊天」页输入卡片左下角：在「添加图片」旁边加一个 `Smile` 按钮，点开表情包面板（截图所示的界面）。第二期在桌宠聊天框 `#chat-row` 里加同样的按钮。点一张表情包就**直接发送**，作为单独一条消息。 |
| 写入聊天记录 | 消息新增可选字段 `sticker: { ref, set, id, label }`，`text` 可以是空字符串。用户发出的表情包和她回复里附带的表情包都写入，因此刷新、重启后仍能看到。这也修复了现在她回复里的梗图不进聊天记录的问题。 |
| 是否发给 agent | **发给 agent，但只发文字描述**：`［主人发了一个表情包：「超开心」——笑得眯起眼、开心到冒花］`。不上传图片，没有视觉能力的模型也能接住，也不消耗上传配额。 |
| 管理页 | 设置窗口 → 角色 → 她的详情页，新增标签页「表情包」，放在「装扮」之后。用卡片网格展示（和衣柜一致），提供 导入 / 编辑名称与用途 / 删除 / 从商店获取 / 上架。 |
| 商店 | **推荐方案 A：在 LobeHub Market 新增 `sticker-set` 资源类型，桌宠通过 `lh` CLI 访问。** 主人用已经登录的 LobeHub 账号上架，其他用户在 商店 → 表情包 浏览、点赞、获取。方案 A 需要本仓库之外的改动：Market 服务、`@lobehub/market-sdk`、`lh` CLI。官方表情包可以先走现有的 CDN 静态索引（方案 B），但方案 B 不能用于用户上架。 |

## 1. 输入：参考产品与现状

### 1.1 参考产品（kiriyuki.com 表情包工坊）

2026-11-05 用浏览器打开了以下页面：`/showcase?p=大肥鱼`、`/showcase`、`/plaza`。截图作为验收证据上传，没有提交进仓库，因为该站标注「保留一切权利」。

- **按角色组织的集合**：Showcase 首页每个角色一张卡片，卡片上是封面图、张数角标（如 286）、点赞数和更新日期，可以按「最近更新」排序。点进某个角色就是她的表情包集合（「大肥鱼 · 286 / 286 stickers · ♥85 · Updated 2026-10-23」）。
- **集合页网格**：每格是方形图、左上角编号（`16N01`、`EX02`，带 `v2` 这类变体角标）、下方名称（「超开心」「委屈哭哭」「发红包」）和 ♥ 点赞数、下载按钮。顶部有搜索（按编号或描述）、分组（All groups）、排序（Newest first）、随机（Shuffle）、分页（Pages）和多选（Select multiple，用于批量下载）。
- **广场**：有「随机表情包 API」、「表情包知识库（JSON，给 AI 用）」和桌宠接入入口。这说明**每张表情包要带一段给模型读的描述**，模型可以按语义挑选，这和本仓库 `memes[].desc` 的思路一致。

我们只借鉴交互形态：角色维度的集合、方形网格、名称和描述、点赞、获取，以及给模型用的描述。不复制任何素材，也不复刻对方的视觉。

### 1.2 负责人截图（file_RUVTH8U53VKL）

截图是设置窗口的「聊天」页（`admin/src/console/pages/Chat.tsx`）。布局是：左边 rail（小屋 / 角色 / 商店 / 玩法 / 设置 / 聊天），会话栏列出每位角色，右边是消息区（`ChatItem` 气泡、模型名、「桌面」Tag），底部输入卡片的左下角是「添加图片」图标（`ImagePlus`），右下角是「发送」。**表情包面板的入口就放在这个图标旁边**（§3.1）。

### 1.3 现有触点（逐一核对）

| 触点 | 现状 | 和表情包的关系 |
| --- | --- | --- |
| `src/core/memes.js:9` `TAG_RE`；`:15-20` `memeHint`；`:23-32` `extractMeme`；`:37-40` `streamingText`；`:43-47` `randomMeme`；`:49` `memeUrl` | 「梗图」功能：角色 JSON 里静态列出 `memes`，图片在 `src/renderer/assets/memes/<角色>/<id>.webp`。**只有 AI 回复可以附带**（在末尾写 `[梗图:id]`），或者离线台词随机配一张 | 扩展成表情包的「她来发」这一侧（§3.5）；文件变成内置集合（§2.4） |
| `src/core/species.js:24` `MEME_ID_RE`；`:47-55` 校验；`:98` `toSpecies` 带上 `memes`；`:110` 缺图检查 | 角色文件里 `memes: [{id,label,desc}]` | 内置集合的来源，保持不变 |
| `src/characters/dafeiyu.json:93` 等 5 个角色文件 | 每位 4–9 张 | 同上 |
| `src/core/persona.js:7`、`:125` | 每条消息的状态块里，`prefs.memes` 打开时附上 `memeHint` | 改为由 `stickerHint` 列出她所有已挂接的集合（§3.5） |
| `src/core/settings.js:43` `PREFS.memes`；`src/core/settings-schema.js:125`；`admin/src/console/pages/Hub.tsx:65` | 「梗图」开关（碎碎念时偶尔配一张） | 开关文案改为「表情包」，含义不变（只管她会不会主动发） |
| `src/main/pet-service.js:23`、`:46` `MEME_KINDS`；`:321-333` `_say` | `_say` 去掉标签，在 `'say'` 事件里带上 `meme: {id,label,url}`（`:330`），**但 `_logPet` 只记录文字** | 事件和聊天记录都带 `sticker`（§3.2） |
| `src/main/pet-service.js:345-375` `_openStream`、`:357` | 流式输出时隐藏还没写完的标签 | 标签格式扩展后，`OPEN_TAG_RE` 同步修改 |
| `src/main/pet-service.js:387-398` `_logUser`；`:404-413` `_logPet` | 写聊天记录 | 新增可选参数 `sticker` |
| `src/main/pet-service.js:1109` `chat()`；`:1122` 记录用户消息；`:1166` 回复 → `_say` | 桌宠聊天框这一轮（`window.pet.chat`） | 第二期：新增参数 `{ sticker }`（§3.1） |
| `src/main/pet-service.js:1205` `chatCharacters` 预览；`:1211` `chatHistory`；`:1231` `_logAs`；`:1268` `chatAs`；`:1307` 记录用户消息；`:1337` `buildConsoleBody`；`:1379` **`extractMeme` 之后丢掉了梗图**；`:1387` 记录回复 | 设置窗口「聊天」这一轮 | 主入口：`chatAs(id, { text, images, sticker })`；回复里的表情包要保留下来 |
| `src/main/pet-service.js:417-427` `history` / `historySession`；`:425` `pick` 白名单 | 「一起」页的聊天记录 | `pick` 加上 `sticker` |
| `src/main/pet-service.js:1737` `sayExternal` | 本机 HTTP `/say` | 不能发表情包（仍只有文字），见 §3.6 |
| `src/core/chat-log.js:11-15` 消息格式注释；`:17` `MAX_MESSAGES`；`:54` `normalize`；`:78` `userSessions`；`:119` `attachmentLabel`；`:136` `append`；`:149-154` `<userData>/chat-log.json` | `normalize` 要求 `text` 是字符串，预览为空时用附件代替 | 加 `sticker` 字段；预览显示 `［表情包：超开心］` |
| `src/core/admin-chat.js:24` `MAX_IMAGE_BYTES`；`:32` `ATT_RE`；`:46-54` `sniffImage`；`:60-98` `readImage`；`:198-207` `picNote`/`transcript`；`:212-219` `buildConsoleBody`；`:223-256` `ChatImages`；`:259-276` `messageView` | 聊天页的图片校验、存储和视图 | 导入表情包复用 `readImage`；`transcript` 和 `messageView` 加上表情包 |
| `src/main/main.js:56` `userData`；`:75`、`:1338` `chatImages`；`:1305` `new ChatLog`；`:648` `history-get`；`:1112-1155` `admin-chat-*` IPC（`:1119` send，`:1141` 选图） | IPC 和存储目录 | 新增 `admin-stickers-*` IPC，并在 send 里透传 `sticker` |
| `src/main/admin-preload.js:123-124` 聊天记录；`:139-148` `chat:` | 暴露 `window.petAdmin.chat` | 新增 `stickers:` 命名空间，`chat.send` 接受 `sticker` |
| `src/main/preload.js:29-30` | 桌宠窗口 `window.pet` | 第二期：`stickers.list(speciesId)` |
| `src/renderer/app.js:1088-1121` `say()`（`:1098-1106` 气泡旁的 `#meme-sticker`）；`:1746-1774` 聊天框 `send`；`:2821` `onSay` | 桌宠气泡：表情包贴在气泡左上角，显示 6 s + 3 s | 改为读 `m.sticker`（同时兼容 `m.meme`）；第二期聊天框加面板 |
| `src/renderer/index.html:5` CSP；`:129` `#meme-sticker`；`:140-145` `#chat-row` | 同上 | CSP 的 `img-src` 加 `sticker:` |
| `src/renderer/style.css:338-340` `.meme-sticker` | 70 px 贴纸，旋转 -6° | 不变 |
| ~~`src/renderer/history.js`~~ | **已不存在**：聊天记录界面在 T-2765 之后移到设置窗口 `admin/src/console/pages/Together.tsx:109-145`。`docs/chat-history.md` §四 的文件引用已过期 | 在 `Together.tsx:138-145` 的消息行里显示缩略图 |
| `admin/src/console/pages/Chat.tsx:517` `send`；`:637-695` `renderMessage`（`ChatItem`、`aboveMessage` 图片组）；`:908-943` 输入卡片（`:921` `leftAddons` = `ImagePlus`） | 截图里的聊天页 | 面板入口和气泡渲染（§3） |
| `admin/src/console/api.ts:480-481`；`:530-537` `ChatAttachment`；`:539-552` `ChatMessage`；`:665` `HistorySession` | 前端类型 | 加 `sticker` 类型和 `stickers` API |
| `admin/src/console/pages/Characters.tsx:1513-1545` 角色详情 `PageTabs`（装扮 / 好感 / 模型 / 个性化设定 / 语音 / 资料） | 角色详情页 | 新增「表情包」标签页（§4） |
| `admin/src/console/pages/Store.tsx:1-6`、`:17` `CatalogGrid`；`:547-556` 商店 `PageTabs`（角色 / 舞蹈 / 语音包） | 商店 | 新增「表情包」标签页（§5），按 R-05 只加标签页，不加 rail 入口 |
| `src/main/packs.js:21-26` `registerPackScheme`（`registerSchemesAsPrivileged` 只能调用一次）；`:59-66` `PackStore`（`userData/packs`）；`:149-166` `serve()`（`pack://<id>/<file>`，限定在包目录内，并按后缀白名单过滤） | 角色包和 `pack://` 协议 | `sticker://` 注册在同一次调用里；`serve` 照搬路径校验的写法（§2.5） |
| `src/core/catalog.js:9-20`（`CDN_ORIGIN`、Develop Center ops assets）；`src/main/catalog.js:86`（`net.fetch`、sha256 校验） | 商店里官方角色的下载：**索引随应用打包，静态文件放在 CDN** | 方案 B 的现成通道；下载、校验、解包的代码可以复用（§5） |
| `src/core/api.js:20-23`、`:65`、`:81`；`src/main/api-server.js:3`、`:25`（只监听 127.0.0.1） | 本机 HTTP 接口 | 第一期不开放发表情包（§3.6） |
| `src/core/lh-client.js:3-4`（「应用不直接请求 LobeHub API；换后端只需换这个文件」）；`:295` `uploadFile`；`:332` `whoami`；`:348` `login` | 账号与上传全部通过 `lh` CLI | 商店客户端也走 `lh`（§5.2） |

## 2. 数据模型与存储

### 2.1 单张表情包

```jsonc
{
  "id": "s01",                 // 在所属集合内唯一，^[a-z0-9_-]{1,40}$（与 MEME_ID_RE 一致，标签里用的就是它）
  "label": "超开心",            // 必填，≤ 20 字：网格、气泡 alt、聊天记录预览里显示
  "desc": "笑得眯起眼、开心到冒花，被夸或收到好消息时", // 必填，≤ 60 字：给模型看，决定什么时候用它（也用于搜索）
  "blob": "9f2c…e1.webp",      // <sha256>.<ext>：内容寻址，指向 stickers/blobs/
  "mime": "image/webp",
  "bytes": 48213,
  "width": 240, "height": 240,
  "animated": false,           // GIF / 动态 WebP
  "addedAt": 1793876272372
}
```

### 2.2 表情包集合

```jsonc
// <userData>/stickers/sets/<setId>.json
{
  "schema": 1,
  "id": "mine-dafeiyu",        // 见下表
  "kind": "mine",              // builtin | mine | store
  "name": "鱼片的私藏",
  "author": "rdmclin2",        // mine：LobeHub 昵称（whoami）；store：发布者
  "license": "CC BY-NC 4.0",   // 上架时必填
  "description": "≤ 200 字",
  "forSpecies": "dafeiyu",     // 这组图画的是谁（可选，商店里按它分组；只是建议，不限制挂给谁）
  "cover": "s01",
  "stickers": [ /* §2.1，顺序就是网格顺序 */ ],
  "store": null                // kind=store：{ "id": "stk_…", "version": "1.2.0", "sha256": "…", "installedAt": … }；
                               // kind=mine 已上架时：{ "id", "version", "status": "pending|published|rejected" }
}
```

| kind | id | 来源 | 可编辑 |
| --- | --- | --- | --- |
| `builtin` | `builtin:<speciesId>` | 运行时从 `species.memes` 生成（§2.4），**不落盘** | 否；可以隐藏（不挂接） |
| `mine` | `mine-<speciesId>`（每位角色自动有一个）；另外新建的是 `mine-<base36>` | 主人导入的图片 | 是 |
| `store` | `store-<商店 id>` | 从商店获取 | 否（只能整体移除或更新版本） |

### 2.3 角色持有多个集合

```jsonc
// <userData>/stickers/bindings.json
{ "schema": 1, "bindings": { "dafeiyu": ["builtin:dafeiyu", "mine-dafeiyu", "store-stk_8a2f"], "claude": ["builtin:claude", "mine-claude"] } }
```

- 键是 `speciesId`，与 `pet.characters`、聊天记录的 `speciesId` 和 `chatAs(speciesId)` 一致。同一基础角色的不同形象（像素 / Live2D / 18+ 包，`core/characters.js:57` 的 `base`）**共用一套表情包**，因为她们共用一个人设和一段对话。是否按形象分开，见 §7 Q2。
- 没有记录的角色，默认值是 `[builtin:<id>（有的话）, mine-<id>]`，所以老用户升级后什么都不用做。
- 一个集合可以同时挂给多位角色（比如商店里的通用表情包）。数组顺序就是面板里分组的顺序。
- 上限：每位角色最多 20 个集合，每个集合最多 120 张，`mine` 集合合计最多 500 张。超过时导入会被拒绝并给出说明。

### 2.4 内置梗图的迁移和兼容

- **不搬文件，不改角色 JSON。** `StickerLibrary.builtinSet(species)` 把 `species.memes` 映射成 `{ id, label, desc, builtin: "<speciesId>/<id>.webp" }`。图片仍从 `src/renderer/assets/memes/` 读取，由 `sticker://builtin/<speciesId>/<id>.webp` 提供（§2.5）。
- 标签兼容：`[梗图:rice]`（不带集合前缀）解析为**她已挂接集合中第一个有 `rice` 的**，这样旧提示词和旧回复的行为不变。新格式是 `[表情包:<setKey>/<id>]`，`setKey` 是面板分组的短编号（`b`=内置、`m`=我的、`s1…`=商店集合，按挂接顺序生成，只在本轮提示词里有效），这样提示词更短。`TAG_RE` 同时接受 `梗图|表情包|meme|sticker`。
- `prefs.memes`（`settings.js:43`）保留键名，界面文案改成「表情包」。它只控制**她主动发**，主人发不受影响。
- 旧聊天记录没有 `sticker` 字段，保持原样显示（以前她附带的梗图本来也没有记下来）。

### 2.5 文件位置、格式、大小与校验

```
<userData>/stickers/
  bindings.json
  sets/<setId>.json            mine 与 store 集合（builtin 不落盘）
  blobs/<sha256>.<ext>         全部图片，内容寻址，去重
  store-cache/                 商店封面缩略图（可随时清空）
```

| 项 | 规则 | 理由 / 复用 |
| --- | --- | --- |
| 格式 | PNG / WebP / GIF / JPG | 和聊天图片相同：`admin-chat.js:60-98` 的 `readImage`（按内容 `sniffImage` 识别，声明类型和实际不一致时拒绝） |
| 单张大小 | ≤ 2 MB（`MAX_STICKER_BYTES`） | 表情包是小图，聊天图片的上限是 10 MB；参考站单张都在几百 KB 以内 |
| 尺寸 | 边长 64–1024 px，宽高比不超过 4:1 | 解析 PNG IHDR / GIF LSD / WebP VP8X·VP8·VP8L 头得到宽高，不引入图像库（运行时依赖只有 `electron-updater`，见 design-system.md §2） |
| 动图 | 保留原图，帧数不限，但受 2 MB 限制 | 面板和网格里的缩略图用 `<img loading="lazy">`；`prefers-reduced-motion` 打开时只显示首帧（CSS 无法暂停 GIF，所以改用首帧，第二期做） |
| 文件名 | 一律 `<sha256>.<ext>`，原文件名只用来生成默认 `label` | 杜绝路径注入 |
| 导入方式 | 文件对话框多选、拖入、粘贴，以及导入 `.zip`（集合格式见 §5.3） | 文件对话框复用 `admin-chat-pick-images` 的写法（`main.js:1141`） |
| 删除 | 从集合里移除这张；blob **不立即删除**。启动时做 GC：删掉既不被任何集合、也不被 `chat-log.json` 引用的 blob | 保证聊天记录里的表情包在删除后仍然可见 |
| 读图协议 | 新增 `sticker://blob/<sha>.<ext>` 和 `sticker://builtin/<speciesId>/<id>.webp`，在 `packs.js:22` 的同一次 `registerSchemesAsPrivileged` 里注册；handler 照搬 `serve()`（`packs.js:149-166`）：解析后路径必须在目录内、文件名必须匹配 `^[0-9a-f]{64}\.(png|webp|gif|jpg)$`。两个 CSP（`src/renderer/index.html:5`、`admin/index.html:9`）的 `img-src` 加上 `sticker:` | 网格里可能有上百张图，不用 data URL（`ChatImages.dataUrl` 只适合一条消息里的几张图） |

新文件：`src/core/stickers.js`（不依赖 Electron：校验、集合与挂接的读写、内置映射、标签解析、提示词片段、GC 算法，可以直接测试）和 `src/main/stickers.js`（协议、文件对话框、zip 导入导出）。

## 3. 聊天：发送、记录与渲染

### 3.1 面板放在哪里

- **第一期（主入口）：设置窗口 → 聊天。** 在 `Chat.tsx:921` 的 `leftAddons` 里、`ImagePlus` 后面加一个 `ActionIcon icon={Smile} title="表情包"`，点开 `Popover`（placement `topLeft`，宽 360、高 320）：
  - 顶部是 `Segmented` 分组标签，每个挂接的集合一个（显示集合封面和名称），最后加一个「＋」跳到她的 角色 → 表情包 页（`#/characters/<id>?tab=stickers`）。
  - 主体是 5 列方形网格（64 px 格子，`colorFillTertiary` 底，`borderRadius` 8），悬停时 `Tooltip` 显示 `label`。顶部有一个搜索 `Input`（匹配 label 和 desc，和参考站一样）。
  - **点一下就发送**，面板随之关闭。表情包是单独一条消息，不和输入框里的文字合并（这和微信、Telegram 一样：输入框里的草稿保留）。需要她回复时与 `send` 相同：`busy` 时按钮禁用，`!met` 时不显示入口。
  - 空状态：她一张都没有时显示 `Empty`「还没有表情包」，加一个按钮「去添加表情包」。
  - 键盘：`Esc` 关闭；方向键在网格里移动，`Enter` 发送。
- **第二期：桌宠聊天框 `#chat-row`**（`index.html:140-145`）：在 📎 后面加一个 lucide `smile` 图标按钮，打开一个原生 JS 小弹层（样式参照 `.popup`，令牌按 R-04）。数据来自 `window.pet.stickers.list()`，发送走 `window.pet.chat('', [], [], { sticker })`。

### 3.2 写入聊天记录

在 `chat-log.js:11-15` 的消息格式里新增一个可选字段：

```jsonc
{ "id": "m812", "at": 1793876272372, "speciesId": "dafeiyu", "role": "user", "origin": "user", "kind": "chat",
  "via": "console", "turnId": "t…", "text": "",
  "sticker": { "ref": "blob:9f2c…e1.webp", "set": "mine-dafeiyu", "id": "s01", "label": "超开心" } }
// 她回复里带的表情包：role "pet"，text 是去掉标签后的正文，sticker 同样格式；内置的是 "ref": "builtin:dafeiyu/rice.webp"
```

- `ref` 是能够定位文件的唯一信息：blob 按内容寻址，所以集合被删掉也不影响。`label` 冗余存一份，文件丢失时还能显示「［表情包：超开心］」。
- `normalize`（`:54`）原样保留 `sticker`；`userSessions` 的过滤规则**不变**。表情包消息和普通消息一样，只有 `origin: 'user'` 的那一轮会进入聊天记录。
- 预览（`attachmentLabel`，`:119`；`chatCharacters`，`pet-service.js:1205`）：`text` 为空时用 `［表情包：超开心］`。
- 写入位置：
  - `chatAs`（`pet-service.js:1268`）新增参数 `sticker`，由 main 在 IPC 层根据 `{ set, id }` 解析出 `ref` 和 `label`（`resolveSticker(speciesId, set, id)`：只允许她已挂接的集合，防止伪造）。`:1307` 写入用户消息时带上它。`clean` 为空但有 `sticker` 时不再返回 `empty`。
  - 回复：`:1379` 不再丢掉 `extractMeme(...).meme`，而是解析成 `sticker`，在 `:1387` 的 `_logAs` 里一起写入；`chat()` 走 `_say`，所以在 `_say`（`:321-333`）里把 `sticker` 传给 `_logPet`（`:404`，新增参数）。
  - `MAX_MESSAGES`（3000）不变：表情包消息只占一条记录的大小。

### 3.3 渲染

| 位置 | 做法 |
| --- | --- |
| 设置窗口聊天 `renderMessage`（`Chat.tsx:637-695`） | `messageView`（`admin-chat.js:259`）输出 `sticker: { url: 'sticker://…', label, missing }`。**只有表情包的消息**用 `ChatItem` 的 `renderMessage` 插槽，替换掉气泡：`Image` 宽 120、`objectFit="contain"`，透明背景、无边框（表情包不放在气泡里，与主流聊天软件一致），可以 `preview` 放大。**文字加表情包**（她的回复）：表情包放在 `belowMessage` 前，作为单独一行，宽 96。文件丢失时显示 `Tag`「表情包已丢失：超开心」 |
| 设置窗口聊天记录（`Together.tsx:138-145`） | 在文字下方显示 48 px 缩略图，`alt=label` |
| 桌宠气泡（`app.js:1088-1121`） | `'say'` 事件的 `meme` 字段改名为 `sticker: { url, label }`，renderer 同时兼容旧字段一个版本。`#meme-sticker` 的位置和时长不变。主人在设置窗口发表情包时桌面不显示（与 docs/admin-chat.md 的规则一致）；第二期主人在桌宠聊天框发出时，在聊天框上方短暂浮出 1.5 s 作为反馈 |
| 刷新 / 重启 | 三处都从聊天记录重新生成视图，图片来自 `sticker://` 文件，所以和当时一样 |

### 3.4 是否发给 agent，怎么描述

**发给 agent，但只发文字。** 主人发表情包是一句有意义的话（「哈哈」「委屈」），她应该接话。实现上：

- 设置窗口这一轮：`buildConsoleBody`（`admin-chat.js:212`）新增参数 `sticker`，在最后一段写 `［主人发了一个表情包：「超开心」——笑得眯起眼、开心到冒花，被夸或收到好消息时］`；有文字时放在文字之后。桌宠聊天框的 `chat()` 在 `body` 里拼同一句。
- `transcript`（`:202-207`，换话题时带上最近 4 小时的聊天和「问起以前的事」的回忆）里，表情包消息写作 `主人：［表情包：超开心］`。
- **不上传图片。** 原因：(1) 很多角色的模型没有视觉能力（`chatAs` 遇到不支持视觉的模型会直接拒绝发图）；(2) 每张图都要 `lh file upload`，又慢又占配额；(3) 表情包的含义主要就在名称和描述里。是否给有视觉能力的模型附图，见 §7 Q5。
- 亲密度：发表情包按 `textLength = 2` 计算（和只发图片相同，见 `pet-service.js:1164`）。

### 3.5 她来发（扩展现有梗图）

- `memeHint`（`memes.js:15-20`）改为 `stickerHint(sets)`：列出她所有挂接集合的表情包，格式是 `<setKey>/<id>（label：desc）`。提示词长度有上限：总共最多 60 条、约 1500 字，**优先选「我的」集合和商店集合**，超出部分随机抽样，每轮重新抽。理由：模型更可能用主人特意加的那些。
- `extractMeme` 改为 `extractSticker(text, sets)`：先匹配新格式，再匹配旧格式 `[梗图:id]`。`randomMeme`（离线台词）从所有挂接集合里抽。
- 回复里的表情包写入聊天记录（§3.2），桌宠气泡和设置窗口都会显示。

### 3.6 不做的部分（第一期）

- 本机 HTTP `/say`、`/chat`（`api.js:20-23`）不接受表情包：外部脚本不是主人，`origin: 'api'` 也不进入聊天记录，没有显示的地方。
- 不做「收藏别人发的表情包」，因为这里只有主人和她两个人。

## 4. 角色表情包管理（设置窗口）

**位置：** 角色 → 她的详情页 `PageTabs`（`Characters.tsx:1513-1545`），在「装扮」之后插入 `{ label: '表情包', value: 'stickers' }`。理由：表情包和装扮一样是「她」的一部分，按 R-05 放在角色的下一层，不新增 rail 入口；路由 `#/characters/<id>?tab=stickers` 也供聊天面板的「＋」跳转使用。

页面结构（`Surface` 分区，组件全部来自 `@lobehub/ui`）：

1. **集合列表（顶部）**：一行 `Tag` 式的集合切换（`Segmented`），每项显示封面、名称和张数，右侧是 `Dropdown`「添加集合」，选项有「新建我的集合」「导入集合（.zip）」「去商店找表情包」（跳到 `#/store?tab=stickers`）。商店集合项上有「移除」，内置集合项上有「不在聊天里使用」（取消挂接，可以恢复）。
2. **网格（主体）**：与衣柜卡片（`LookTab`）一致，方形卡片 + 名称 + 一行次要文字（desc）。动图右上角有 `Tag size="small"`「动图」。参考站的多选模式也做：`Button`「选择」→ 勾选 → 「删除所选」。
   - 「我的」集合第一格是虚线框的「添加表情包」。点击打开文件对话框（多选），也支持拖入或 Ctrl/⌘+V 粘贴。导入后弹出 `Modal` 逐张确认：名称默认取文件名，**用途描述必填**，提示「她会根据这段话决定什么时候用」。不合格的文件在弹窗里逐条列出原因（「超过 2 MB」「不是图片」「尺寸太小」）。
   - 卡片悬停时显示操作：编辑（同一个 `Modal`）、删除（`confirmModal`，危险样式，`okText`「删除表情包」，`cancelText`「取消」，遵守 R-03）。拖动可以调整顺序。
   - 内置和商店集合只读，卡片上只有「发送给她」和「查看大图」。
3. **页脚**：「上架到商店」（只对「我的」集合可用，见 §5.4），上架后显示 `Tag`「审核中 / 已上架 / 未通过」和商店链接。

空状态和异常：`!met` 的角色也能管理（还没见面也可以先准备表情包）；`prefs.memes` 关闭时顶部显示 `Alert type="info"`「她现在不会主动发表情包（在 设置 → 桌宠行为 打开）；你仍然可以发给她」。

IPC（`admin-preload.js` 新增 `stickers:` 命名空间，main 端统一用 `adminOnly` 包装）：

| 方法 | 作用 |
| --- | --- |
| `stickers.list(speciesId)` | 她挂接的集合和表情包（带 `sticker://` URL） |
| `stickers.pick()` / `stickers.import(setId, files)` | 选择或导入图片，返回 `{ ok, added, rejected[] }` |
| `stickers.update(setId, id, { label, desc })` / `stickers.remove(setId, ids[])` / `stickers.reorder(setId, ids[])` | 编辑 |
| `stickers.createSet(speciesId, name)` / `stickers.bind(speciesId, setIds[])` | 集合与挂接 |
| `stickers.exportSet(setId)` / `stickers.importSet(zip)` | zip 进出（§5.3） |
| `onStickersChanged` | 广播，聊天面板跟着刷新 |

## 5. 商店：上架、浏览、获取

### 5.1 需求拆解

「上架后可被其他用户查看与获取」需要以下能力，**纯本地实现不了**：

1. 一个**跨用户共享的索引**（列表、搜索、点赞数、作者）。
2. 公开可下载的**文件存储**（zip 和封面）。
3. **身份**：谁上架的、谁能下架、谁点了赞。
4. **审核**：用户上传的图片要经过内容安全审核，18+ 内容不能上架（和 docs/compliance-review.md 一致）。
5. 版本更新和下架。

现有的商店（`Store.tsx`、`core/catalog.js`）只有第 2 点。它的索引 `character-catalog.json` **随应用打包**，文件放在 Develop Center 的 CDN 上，由维护者用 `dc` 凭据上传，所以只能发布官方内容。

### 5.2 候选方案

| 方案 | 做法 | 能满足 1–5 吗 | 需要的凭据 / 外部依赖 | 本仓库能独立完成吗 | 评价 |
| --- | --- | --- | --- | --- | --- |
| **A. LobeHub Market 新增资源类型 `sticker-set`**（推荐） | Market 已经有用户发布（`UserPublishService`）、点赞和收藏（`UserLikeService` / `UserFavoriteService`）、审核（`ReviewService`）、上传 zip 发布新版本（技能的 `publishSkillVersion`），以及对象存储加 CDN 分发，全部在公开的 `@lobehub/market-sdk` 里。新增一种和技能同构的资源：元数据 + 一个版本 zip | 都能满足 | 用户：已登录的 LobeHub 账号（桌宠本来就要 `lh login`，`lh-client.js:348`），不需要新凭据。开发：Market 服务、market-sdk 和 `lh` CLI 三处的改动与发布 | **不能**：Market 服务端、SDK、`lh` 子命令都在别的仓库 | 和桌宠现有账号体系一致；不用自己运维存储、审核和账号；以后 LobeHub 本体也能复用表情包 |
| B. 沿用现有 CDN 静态索引（官方集合） | 维护者把集合打包，`dc ops-assets upload` 到 `dc/ops-assets/archives/pixel-pet/stickers-v1/`；`sticker-catalog.json` 随应用发布或远程拉取 | 只满足 2；**用户不能上架** | 维护者的 Develop Center 凭据 | 能，代码只在本仓库，上传需要凭据 | 可以作为「官方表情包」货架先上线；**单独使用不满足需求**，也不能把它包装成用户商店 |
| C. 新建独立服务（例：Cloudflare Worker + D1 + R2） | 自建 `/sets`（列表、详情）、`/sets/:id/versions`（上传）、`/likes`、审核后台 | 都能满足 | 云账号和域名；身份需要接入 LobeHub OIDC（向 LobeHub 校验 `lh` 的令牌），否则就要另建账号体系（如 GitHub OAuth）；内容审核服务；运维和费用 | 服务可以由本项目负责人写，但部署、域名、OIDC client 需要外部开通 | 可控，但要另外承担账号、审核和存储，安全责任也在自己身上。作为 A 不可行时的备选 |
| D. LobeHub 个人文件（`lh file upload`）+ 共享文档当索引 | 文件 id 当下载地址 | 不满足 1、3、4：文件归属个人（`visibility: private`），没有跨用户列表 | 无 | — | 否决 |
| E. GitHub 仓库当索引（类似 lobe-chat-agents 的 PR 上架） | 上架 = 向索引仓库提 PR，CI 生成索引并上传 CDN | 满足 1、2、4；身份是 GitHub 账号 | 用户需要 GitHub 账号；应用内上架需要 GitHub 令牌 | 索引仓库和 CI 需要新建 | 门槛高、不在应用内完成，和「在应用里上架」的预期不符 |

### 5.3 集合 zip 格式（上架和导入导出通用）

```
<set>.zip
├── sticker-set.json   { schema:1, id, name, description, author, license, forSpecies?, cover, stickers:[{id,label,desc,file,width,height,animated}] }
└── stickers/<id>.<ext>
```

校验和 `core/packs.js` 导入角色包时一致：不超过 120 张，单张不超过 2 MB，整包不超过 60 MB（超过 CDN 20 MB 单文件上限时，按 `catalog.js` 的 `parts` 分卷）；每张图都用 `readImage` 重新识别类型；`file` 必须在 `stickers/` 目录内；`license` 必填。安装时计算 sha256，图片进入 `blobs/`，集合写成 `sets/store-<id>.json`。

### 5.4 推荐方案 A 的端到端路径

```
主人 A（设置窗口）                         lh CLI                LobeHub Market               主人 B（设置窗口）
角色 → 表情包 → 上架到商店
  ① 填写名称 / 简介 / 授权 / 适用角色，勾选「我有权发布这些图片」
  ② main 打包 zip（§5.3）─────────────→ lh sticker publish --file x.zip --json
                                          └─ OAuth 身份 ─────→ 新建 / 新版本：存 zip、生成封面、进入审核
  ③ 返回 { id, version, status: pending } ← 显示「审核中」
                                                              审核通过 → status: published
                                                                                     商店 → 表情包
                                          lh sticker list --sort recent --json ←──── ④ 网格：封面、名称、张数、作者、♥
                                          lh sticker view <id> --json        ←──── ⑤ 详情：全部表情包预览
                                          lh sticker download <id>@<ver> -o … ←── ⑥ 「获取」：下载 zip，校验 sha256
                                                                                     ⑦ 解包到 <userData>/stickers，挂给所选角色
                                          lh sticker like <id>               ←──── ⑧ 点赞（可选）
                                                                                     ⑨ 聊天面板里出现这组，可以发送
```

- **本仓库要做的**：`lh-client.js` 新增 `stickerList/stickerView/stickerDownload/stickerPublish/stickerUnpublish/stickerLike`，都调用 `lh … --json`，和现有写法一致；`src/main/sticker-store.js` 负责下载、校验、安装和进度事件，复用 `src/main/catalog.js:74-115` 的进度与失败处理；`Store.tsx` 新增「表情包」标签页（网格加筛选 `Segmented`「全部 / 已获取」+ 搜索 + 排序「最新 / 最多赞」，卡片复用 `CatalogGrid` 的视觉）；角色表情包页加上架表单。
- **e2e**：e2e 已经使用假 `lh`（`test/fixtures/fake-lh.js`，由 `e2e/run.js:32`、`:260` 通过 `LH_BIN` / `FAKE_LH_DIR` 注入）。在假 `lh` 里实现 `sticker` 子命令，数据放在一个临时目录里作为「远端」。A、B 两个 `PIXELPET_DATA_DIR` 依次运行，就能在本仓库里跑通 ①→⑨ 的真实界面流程。**它只是测试替身，不是商店本身**；正式商店以接入真实 Market 为准。
- **需要外部完成的部分**（另外开任务或协调 Market 负责人）：
  1. Market 服务：`sticker-set` 资源（元数据表、版本、zip 存储、封面生成）、列表、搜索、详情、下载地址、点赞，以及接入审核流程（图片内容安全审核和人工复核）。
  2. `@lobehub/market-sdk`：对应的 service 方法。
  3. `lh` CLI：`lh sticker list|view|download|publish|unpublish|like` 子命令。
  4. 运营：举报和下架入口，以及授权声明的文案（「上架即表示你拥有这些图片的发布权」）。
- **在外部改动到位之前**：商店「表情包」标签页显示 `Alert`「表情包商店即将开放」，「上架」按钮禁用并说明原因。官方集合（如果负责人同意，见 §7 Q4）可以先按方案 B 上架。**不允许用硬编码列表或本地假数据冒充商店。**

## 6. 实施拆分（建议的后续任务，按依赖排序）

| # | 任务 | 依赖 | 验收要点 |
| --- | --- | --- | --- |
| S1 | `core/stickers.js` + `main/stickers.js`：存储、协议、内置映射、挂接、GC，以及单元测试 | — | `npm test`；旧存档升级后，内置梗图仍能在桌宠气泡里出现 |
| S2 | 聊天记录字段 + `chatAs`/`chat()`/`_say` 透传 + `messageView`/`transcript`/`buildConsoleBody` | S1 | 单元测试：表情包消息进入 `userSessions`，`api` 来源的不进入；她回复里的表情包被记录下来 |
| S3 | 设置窗口聊天面板 + 渲染 + 聊天记录（Together）缩略图 | S2 | e2e：发送表情包 → 她回复 → 刷新页面 → 重启应用后仍然可见（截图） |
| S4 | 角色 → 表情包 标签页（导入、编辑、删除、排序、多选、zip 导入导出） | S1 | e2e：导入 3 张 → 删 1 张 → 聊天面板里显示 2 张；拒绝原因显示正确 |
| S5 | 商店客户端（lh-client、sticker-store、Store 标签页、上架表单）+ 假 `lh` 的双用户 e2e | S4；真实上线依赖 X1–X3 | e2e：A 上架 → B 浏览 → 获取 → 发送 |
| X1–X3 | Market 资源类型、SDK、`lh sticker` 子命令（仓库外） | 负责人决定 §7 Q1 | 用真实账号跑通 ①→⑨ |
| S6（第二期） | 桌宠聊天框面板、动图首帧、视觉模型附图（如 Q5 同意） | S3 | — |

## 7. 需要负责人决定的问题

1. **Q1 商店后端**：是否同意方案 A（由 Market 新增 `sticker-set`）？需要和 Market 负责人确认排期。如果 Market 不接，是否改走方案 C（独立服务 + LobeHub OIDC），以及由谁出云资源和审核服务？
2. **Q2 粒度**：表情包是按基础角色共享（本文默认，同一个她的像素 / Live2D 形象共用），还是按形象分开？
3. **Q3 跨角色使用**：商店集合有 `forSpecies` 时，是否只允许挂给对应角色？本文默认可以挂给任何角色，`forSpecies` 只用于推荐和分组。
4. **Q4 官方集合**：五位内置角色现有的 4–9 张梗图，是否以官方身份上架到商店（方案 B 或 A 的官方账号）？授权以 NOTICE.md 为准。
5. **Q5 视觉模型**：主人发的表情包，在当前模型有视觉能力时是否也上传图片给模型？本文默认只发文字描述，这样更省、更快，所有模型都可以用。
6. **Q6 审核策略**：先审后发（本文默认）还是先发后审 + 举报？上架内容一律全年龄，是否需要明确禁止 18+ 表情包集合？
