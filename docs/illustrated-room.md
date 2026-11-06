# 她的房间（插画版，engine `illustrated-room@1`）

> T-11696：引擎、包格式校验、状态机、聊天驱动和直接点选。方案见 PR #161 的 `docs/illustrated-room-design.md`（T-11682）。
> 美术用的是 T-11695 探针的小样（3 张插画 × 台灯关 / 开），正式的 8 个状态、商店上架是后续任务。
> 像素版 `room@1` 已在 #158（T-10804）改名「像素房间」（`pixel-room`），这里没动它的玩法和美术，只有测试核对名字。
> 不用设置窗口里的 React 页面（已废弃的 PR #151），房间在独立游戏窗口里（`src/main/game-window.js`）用 PixiJS 8 画。

## 1. 文件

| 文件 | 作用 |
| --- | --- |
| `src/core/illustrated-room-pack.js` | `validateIllustratedRoom`：活动数值（和像素房间同一套上限）、房间、状态、屏幕四角（凸四边形）、窗户、热点、意图词、台词；`namedFiles` / `spriteFiles` |
| `src/core/game-pack.js` | `ENGINES` 加 `illustrated-room@1`，按引擎分派；`MULTI_INDEX`（有多个索引文件的引擎，`games.js` / `game-store.js` 共用） |
| `src/core/room-intent.js`（UMD） | `matchRoomIntent(text, room.intents, ctx)` → `{ state, lamp, screen, query, stop, next }`，纯规则 |
| `src/core/illustrated-room-play.js`（UMD） | 状态机：`restore` / `command` / `tick` / `view` / `path` / `screensFor` / `chatNote`；数值结算复用 `core/room-play.js` |
| `src/main/games.js` | `illustratedBoot` / `illustratedCommand` / `illustratedClose` / `illustratedNote`：main 是唯一权威，页面发来的数值一律不认 |
| `src/main/main.js` | `game:room`（点选 / 计时）、`game:chat`（游戏窗口聊天栏）、`roomChat`（PetService 的 `roomHook`）、把 `say` / `chat-delta` / `thinking` 转给游戏窗口 |
| `src/main/pet-service.js` | `chat()` 和设置窗口的 `chatAs()`（当前桌宠）在发请求前调 `roomHook`；`persona.buildChatPrompt` 的 `room` 一行 |
| `src/renderer/game/engines/illustrated-room.js` + `.css` | 引擎：图层、光照、雨和光斑、呼吸眨眼、交叉淡化、屏幕、热点、状态栏、聊天栏、数值胶囊、「屏幕」卡片 |
| `src/renderer/game/engines/screen-content.js` | 屏幕内容：短视频 / 网页 / 播放器 / 小游戏 / 锁屏，画进离屏 canvas |
| `test/fixtures/games/her-room/` | 小样包（T-11695 探针的 6 张图，缩到 1280×720 webp；世界坐标仍是 1920×1080） |
| `test/illustrated-room.test.js` | manifest 解析、意图映射、状态机、main 侧命令、提示词 |
| `e2e/illustrated-room.js` | `xvfb-run -a node e2e/run.js illustrated`；`PIXELPET_ROOM_LIVE=1` 用真实 LobeHub agent 回复 |

## 2. 图层

```
world（1920×1080 世界坐标，cover 铺满 960×600 窗口）
├ scenes（ColorMatrixFilter：月光冷色调，台灯越亮越偏暖白）
│ └ scene = 一个状态的插画
│   ├ off           台灯关的整张插画（她和房间一起画）
│   ├ breathOff     她胸口 / 后背的矩形切成 9×9 的 MeshPlane，顶点按「中间大、边缘 0」位移（呼吸），听音乐时再加左右轻晃
│   ├ lit           台灯开的同一构图，alpha = 台灯亮度（她也被暖光照到，是画出来的）
│   ├ breathLit
│   ├ blink         闭眼：在每只眼睛上画眼睑（颜色取自眼睛下方的皮肤，off / lit 按台灯亮度混合）
│   └ screens       PerspectiveMesh 贴屏幕四角 + 屏幕溢光（add，亮度跟内容平均亮度）
├ window（窗玻璃多边形遮罩）：光斑（add，每颗独立正弦闪烁、缓慢漂移）、雨丝（线段）、玻璃水珠（下滑）
├ lampGlow          台灯暖光晕（add，alpha = 台灯亮度 × glow.alpha）+ 光里的微尘
├ fx                Z（睡觉）/ ♪（听音乐）从她身上飘起
├ vignette          暗角
└ hover             悬停热点的描边
DOM：标题栏胶囊 ⚡♥、「屏幕」卡片（左下，屏幕内容放大）、她的气泡、你说的话、聊天栏、状态栏（六件事 + 台灯）
```

- **台灯**：开 0.17 秒线性升到 1，再 0.3 秒 ±5% 衰减闪动；关 0.25 秒降到 0。`lit` 插画、光晕、微尘、整屋调色（`lighting.grade.litTint` 写了就调到它：lit 图已经烘好光照的包用，床上的蓝不被调灰）一起跟着亮度走，任何状态下都能开关（状态栏、画面里的台灯、L 键、聊天「开灯 / 关灯」）。工作（`lampOnEnter`）进去时自动开灯。
- **交叉淡化**：新状态的图解码完才开始，新场景放在旧的上面 alpha 0→1，1.4 秒 `inOutSine`；结束后释放旧场景。雨和光斑在场景之上，不参与淡化。包里有 `enterVia: "stand"` 时，床 ↔ 书桌先淡到「起身」停 0.6 秒再淡到目标（小样没有起身图，直接淡化）。
- **眨眼**：每 3–6 秒一次，闭 0.13 秒，20% 连眨两次；淡化期间暂停；睡觉、背对镜头的状态没有眨眼。包里写 `blink.sprite { off, lit }` + `at` 时贴 `images.parts` 图集里的闭眼差分（`lit` 的 alpha = 台灯亮度），写 `blink.eyes` 时是程序画的眼睑。
- **光斑**：`window.bokeh.spots`（`[x, y, r, warm?]`）让光斑在插画画好的灯位上闪烁、不漂移；不写就按 `count` 随机。

## 3. 屏幕内容（`screen-content.js`）

全部本地画，不联网：

| 内容 | 画面 |
| --- | --- |
| `clips` 短视频 | 竖屏动态画面循环（水母、雨夜窗边台灯、比心、凌晨城市、犯困小猫），按 `swipeEvery` 的中值定节奏（或聊天说「下一个」）上滑 0.35 秒换下一条；放哪一条由主进程的时间线决定（`clipNow`），页面照着放，聊天这一轮把当前这条留 60 秒，她的回复和屏幕说的是同一条；点赞 / 评论 / 分享列、作者、标题、原声、进度线。笔记本上是网页版布局：中间竖屏视频，左边菜单，右边评论 |
| `page` | 浏览器：地址栏、标签；`content.page.templates` 轮流显示（`seconds` 一轮）：带 `image` 的是包里真实渲染的长网页、慢慢往下滚，不带的是逐字打出来的「本周工作周报」；聊天说「搜一下 X」时是搜索结果页 |
| `player` | 封面（月下鲸鱼）、歌名、歌手、频谱、进度条和时间（按秒走） |
| `game` | 「鲸鱼跳跳」横版小游戏自己玩，得分在涨 |
| `lock` | 锁屏：本机时间、日期、一条消息 |

小样里手机屏幕只有约 46×50 世界像素，所以同一张 canvas 也画在左下角的「屏幕」卡片里（可以收起），参考录屏里「另开一个抖音窗口」的效果就是它。

## 4. 状态机（main 是唯一权威）

`st = { engine, room, state, lamp, screen, query, clip, since, run, last, focus, totals }`，存在 `userData/games/.progress/<id>.json`。

- 点选、热点、键盘、聊天都走 `illustratedCommand({ cmd: 'set', state | lamp | screen | query | stop | next, from })`；页面只演 main 回来的结果（`path`、`screens`、`lamp`、`line`、`settled`）。
- 状态的 `activity` 是像素房间的五件事之一时，按 `room-play.js` 跑一轮（开始、切换时先结算上一件、到时结算、关窗口按时长结算、进程被杀后重开时补结算）；`idle`（发呆）不计时、不动数值。到时后回到发呆。
- 精力不够（工作 / 打游戏要 15）：不切，气泡说累，聊天里的提示词让她自己解释。
- 读到别的引擎写的存档（开发期 `her-room` 的 `room@1` 存档）直接丢掉。
- 今日小事新增 `chat-command`（在聊天里叫她做事）、`lamp`（`to: true`）。

## 5. 聊天驱动

```
游戏窗口聊天栏 ─ game:chat ─┐
设置 → 聊天（当前桌宠）─────┤→ PetService.chat / chatAs
                             │   1. roomHook(text) → core/room-chat.js onMessage：房间开着时先 matchRoomIntent
                             │   2. 明确的指令（sure）→ 立刻 illustratedCommand(from: 'chat') → game:room 推给游戏窗口，不等模型
                             │   3. 其余的 → lh generate decide（jev，约 1 秒，超时 6 秒）判断要不要切、切到哪、开关灯，再由引擎执行；
                             │      置信度低于 0.6 或选 none 不切；失败或超时什么都不动
                             │   4. 返回提示词的 [房间·真实情况] 一行：这一轮切了没有、现在什么状态、台灯开关和有没有动过、屏幕上放什么、房间时钟
                             │   5. 同一个 agent / topic / 聊天记录跑这一轮 → say / chat-delta → 游戏窗口气泡
                             │   6. roomReplyHook(reply) → onReply：回复里说自己开灯或关灯而画面不是这样，就切台灯
```

规则（`room-intent.js`）：

| 说法（例） | 结果 |
| --- | --- |
| 回床上休息吧 / 去睡觉 / 躺下 / 钻被窝吧 | `sleep` |
| 现在去试一下打开电脑刷抖音吧 / 打开电脑刷抖音 / 用电脑刷视频 | `work` + 屏幕 `clips` |
| 去工作 / 写周报 / 打开电脑 | `work`（屏幕 `page`） |
| 搜一下明天天气 | `work` + `page`，搜索词「明天天气」 |
| 看手机吧 / 看会儿手机吧 / 刷会儿抖音 / 看手机刷视频吧 | `phone`（+ `clips`） |
| 放首歌听听 / 听歌 | `music` + `player` |
| 去打游戏 / 来打会儿游戏吧 / 来一局吧 | `game` |
| 发会儿呆吧 / 歇会吧 | `idle` |
| 开灯 / 把台灯打开；关灯睡觉吧 | `lamp: true`；`sleep` + `lamp: false` |
| 别玩手机了 | `stop`（回发呆） |
| 下一个（正在刷短视频时） | 下一条 |
| 大肥鱼，能收消息吗 / 你睡了吗 / 我不想睡觉 / 我在看手机 / 今天好累啊，工作好多 | 不切（问句、否定、说自己、没有祈使的长句） |

动词和宾语中间的「会儿 / 一会儿」、「一首」查词时去掉（看会儿手机 = 看手机，放一首歌 = 放首歌）。超过 60 字不算指令；多个状态词取最后一个没被否定的（「先别玩游戏了，去睡觉」→ 睡觉）；房间可以在 manifest `intents` 里加自己的说法（和通用词重复时归这个房间说的状态，比如正式包的「犯懒」归 `idle-lazy`）。

词表只负责明确的指令（句子里除了指令词只剩语气词，或带「吧 / 现在 / 去…」）。「工作好累啊」「我累了想睡觉」这种带活动词的闲聊不算明确，交给模型判断。选 `lh generate decide` 而不是回复里的标记，是因为判断发生在回复之前：引擎先执行，回复按执行结果写，拒绝（太累）和失败都不会被她说成做了。

房间时钟（`roomClock`）：房间永远是雨夜，所以手机锁屏和提示词都用房间自己的时钟，23:00–03:59，跟着现实分钟走（现实每 5 小时循环一次）。她聊到时间时按这个说，和画面一致；现实时间只留在状态块里。

## 6. 直接点选与数值

- 底部状态栏：睡觉 / 工作 / 看手机 / 听音乐 / 打游戏 / 发呆（当前高亮，底部细进度条，精力不够时变灰并写原因）+ 状态的 `variants`（紧跟在所属活动后面，如「犯懒」）+ 台灯。
- 画面热点：床 → 睡觉、手机 → 看手机、书桌 → 工作、椅子 → 打游戏、台灯 → 开关；悬停描边 + 「睡觉 · 床」。
- 键盘：1–6 切状态，7–9 切 `variants`，L 台灯，/ 聚焦聊天栏，Esc 收起卡片。
- 数值：默认只有标题栏一个「⚡90 ♥70」胶囊，点开看四条数值、上一件和今日小事；结算时胶囊跳一下。

## 7. 和参考录屏的差距（这一轮）

- `test/fixtures/games/her-room` 的小样只有看手机 / 工作 / 睡觉三张构图。正式包（游戏仓库 `games/her-room/pack`，T-11697）每个状态都有专门的姿势、起身过渡图和眨眼贴片；`PIXELPET_ROOM_PACK=<pack 路径> xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js illustrated` 用它跑全部场景，多一步 I4b（8 个状态 × 台灯关 / 开）。
- 小样的屏幕内容是程序画的循环。正式包用真实素材：`frames.clips` + `images.clips`（视频帧图集）、`player.tracks[].cover` / `lyrics`（封面和带时间的歌词，没有音频）、`page.templates[].image`（真实网页长图）；屏幕卡片放大显示。
- 小样插画里本来就画了雨和光斑，引擎的雨和光斑叠在上面是动的那一层。

## 8. 上架（T-11725）

- 包：`https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/games-v1/her-room-1.0.1.zip`（4374502 字节，sha256 `5c8a8957…`），2026-11-06 由游戏仓库的 `scripts/publish.js her-room` 上传；1.0.0 留在 CDN 上不替换。
- 目录：游戏仓库的 `catalog.json` 已有条目，合并它的 PR 后应用才读得到。应用自带的目录（`src/core/game-catalog.json`、`src/renderer/catalog/games/her-room*`）已用 `sync-game-catalog.js --repo` 同步。
- `minAppVersion` 是 0.28.0：canary 现在是 0.27.0，下一个发版 PR（`🚀 release: v0.28.0`）带上这个引擎。发版时版本号变了要改包。注意 `scripts/release-version.js` 的规则：标题不是 `🚀 release:` 的 feat / fix PR 直接合 main 会发 0.27.1，这种版本上商店显示「需要更新应用」。
- 验收：`PIXELPET_E2E_APP_VERSION=0.28.0 xvfb-run -a -s "-screen 0 1600x1000x24" node e2e/run.js herroomaccept`。真实 CDN、真实 agent（花几轮 token）、真实鼠标、整屏录屏带章节，输出在 `out/e2e/her-room-accept/`。`PIXELPET_E2E_APP_VERSION` 只在测试模式生效，让还没发版的分支通过商店的版本比较。

## 9. 运行

```bash
npm test
xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js illustrated          # 假 lh（回复回显）
PIXELPET_ROOM_LIVE=1 PIXELPET_ROOM_VIDEO=$PWD/out/video/her-room-demo.mp4 \
  xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js illustrated          # 真实 LobeHub agent + 录屏（章节在 .chapters.json）
PIXELPET_DEV_GAMES=1 npm start                                                  # 本地直接玩 test/fixtures/games/her-room
```
