# 「她的房间」技术方案（engine `room@1`）

> 状态：方案（T-10799），还没有实现代码。实现、美术、上架和验收由后续任务按本文执行。
> 商店第二款小游戏。和「像素小院」一样，在独立的游戏窗口里用 PixiJS 8 渲染，游戏包只有图片和 JSON，经商店下载、能升级。
> 一款游戏里有多个**房间主题**，五位默认角色各一个。房间里可以做五类活动：**睡觉、工作、看手机、听音乐、打游戏**。每类活动都有可点的家具，进行中能看到她的动作、道具变化、计时和台词，结束后改变她的数值。
> 本轮开放大肥鱼的「鲸鱼女仆的蓝色小屋」：浅蓝和奶白配色，有蕾丝、蝴蝶结和鲸鱼元素，大肥鱼穿招牌女仆装。另外四个主题先标「即将开放」。
> 以后加房间只改游戏仓库里的数据和美术（manifest、图集、背景），应用代码不用动。

相关文档：[mini-games.md](mini-games.md)（像素小院与商店），[affection-design.md](affection-design.md)（好感）。
已废弃的 PR #151（<https://github.com/rdmclin2/lobehub-pixel-pet-affection/pull/151>，分支 `feat/t-6174-room-minigame`，[docs/room.md](https://github.com/rdmclin2/lobehub-pixel-pet-affection/blob/feat/t-6174-room-minigame/docs/room.md)）在设置窗口里用 React 做过一版房间。本方案保留它的这些部分：活动表与结算规则、e2e 断言、主题条目和台词、大肥鱼房间的美术方向。不保留的部分：设置窗口页面、`RoomScene.tsx` 这种 SVG/DOM 叠层画法、`RoomService` 挂在 `pet.json` 上的存档方式。

---

## 0. 总览

| 层 | 像素小院（已有，`yard@1`） | 她的房间（新增，`room@1`） |
| --- | --- | --- |
| 窗口 | `src/main/game-window.js`（960×600，只建一次） | 复用。还是带 `?game=<id>` 重新载入 |
| 页面桥 | `src/main/game-preload.js`：boot / set / event / saveState / touch / close / openStore | 复用，新增一个 `activity(cmd)`（§3.3） |
| 页面 | `src/renderer/game/game.js`（1116 行，全是小院） | 拆成外壳 + 引擎：`game-shell.js` + `engines/yard.js` + `engines/room.js`（§4.1） |
| 包格式与校验 | `src/core/game-pack.js`，`ENGINES = ['yard@1']` | 改成按引擎分派：`validateYard` 和新的 `src/core/room-pack.js` 里的 `validateRoom`，`ENGINES = ['yard@1', 'room@1']`（§1.4） |
| 她的状态机 | `src/core/game-pet.js`（走路、用物件、拎起） | 原样复用：家具就是有 `use` 的物件，地板是可走区域（§3.1） |
| 活动与结算 | — | 新增 `src/core/room-play.js`（纯函数，UMD，main 和页面共用），从 PR #151 的 `core/room.js` 改写，规则改成由包里的数据驱动（§2） |
| 每日小事 | `src/core/game-quests.js` | 复用。`matches` 新增 `kind`、`theme`、`complete` 三个可选条件（§3.4） |
| 天色 | `src/core/game-sky.js` + `settings.scene` | 复用，用于窗外和房间里的调色（§4.6） |
| 进度 | `userData/games/.progress/<id>.json` | 复用：`quests` 不变，`state` 存房间自己的东西（§3.5） |
| 好感 | `PetService.gameQuest()`（来源 `game`，每天最多 3 次） | 复用，不加新来源 |
| 精力、心情、饱腹 | `pet.json` 的 `characters[base]` | 活动结算时由 main 通过新增的 `PetService.roomSettle()` 改写（§3.2） |
| 商店与升级 | `game-index.js` / `game-store.js` / `sync-game-catalog.js` | 原样复用；目录条目写 `engine: "room@1"` 和 `minAppVersion`（§6） |

## 1. 游戏包格式（engine `room@1`）

### 1.1 文件

包是**平铺的文件夹**。`game-store.js` 的 `checkFolder` 不接受子文件夹，也不接受 manifest 没列出的文件，所以按主题 id 给文件名加前缀：

```
her-room/
  manifest.json            游戏、五类活动的默认定义、主题列表、小事、通用台词
  dafeiyu-room.webp        大肥鱼房间的背景：墙、窗、地板、地毯、墙饰（1024×576，不含可点的家具）
  dafeiyu-atlas.webp       大肥鱼房间的图集：家具、道具、粒子
  dafeiyu-sprites.json     图集索引 { 名字: { x, y, w, h } }，格式同小院的 sprites.json
  claude-preview.webp      （可选）即将开放主题的预览图；没有时预览卡用色板和她的立绘
  …
```

文件名还是只能用 `.webp`、`.png`、`.json`（`FILE_RE`），每个主题最多 4 个文件。整个包控制在 6 MB 以内：第一版只有一个 open 主题，预计约 1.2 MB，和小院差不多。

### 1.2 manifest

```jsonc
{
  "schema": 1, "kind": "game", "engine": "room@1",
  "id": "her-room", "name": "她的房间", "version": "1.0.0",
  "description": "每位角色都有一间自己风格的房间……", "credit": "美术：GPT Image（gpt-image-2.5）生成后像素化；玩法与引擎：Pixel Pet Affection",

  "defaultTheme": "dafeiyu",                // 当前陪你的角色没有可以玩的房间时，先打开这间

  // 五类活动的默认定义。kind 固定是这五个，它们各自对应哪些数值由引擎规定（§2.1）。
  // 每个主题可以在 themes[].activities.<kind> 里覆盖台词、时长和画面
  "activities": {
    "sleep": { "label": "睡觉",   "verb": "睡一觉",     "anim": "sleep", "seconds": 30, "deltas": { "energy": 35, "mood": 6, "focus": 8, "fullness": -4 } },
    "work":  { "label": "工作",   "verb": "工作一会儿", "anim": "think", "seconds": 30, "deltas": { "focus": 28, "energy": -12, "mood": -5, "fullness": -8 }, "needs": { "energy": 15 } },
    "phone": { "label": "看手机", "verb": "刷会儿手机", "anim": "look",  "seconds": 20, "deltas": { "mood": 14, "focus": -10, "energy": -4 } },
    "music": { "label": "听音乐", "verb": "听几首歌",   "anim": "happy", "seconds": 25, "deltas": { "mood": 16, "energy": 6, "focus": 6 } },
    "game":  { "label": "打游戏", "verb": "打一局游戏", "anim": "play",  "seconds": 30, "deltas": { "mood": 22, "energy": -14, "fullness": -8, "focus": -6 }, "needs": { "energy": 15 } }
  },

  "themes": [
    {
      "id": "dafeiyu", "character": "dafeiyu", "status": "open",          // open = 可以玩；soon = 即将开放
      "name": "鲸鱼女仆的蓝色小屋",
      "blurb": "浅蓝和奶白的少女房间：蕾丝床幔、蝴蝶结、鲸鱼抱枕。",
      "motifs": ["蕾丝", "蝴蝶结", "鲸鱼"],
      "palette": { "primary": "#2C4A8A", "accent": "#6FA8E8", "base": "#FFFFFF", "trim": "#E8D6A0" },
      "outfit": "daily",                                                   // 房间主人在房间里穿哪套（她像素包 outfits 的 id；daily = 招牌女仆装）

      "world": { "width": 1024, "height": 576, "background": "#BFD9F5" },
      "images": { "room": "dafeiyu-room.webp", "atlas": "dafeiyu-atlas.webp" },
      "sprites": "dafeiyu-sprites.json",
      "petHeight": 150, "spawn": [512, 520], "door": [980, 520],          // 进房间时她从 door 走到 spawn

      // 可走区域：一条地板带，坐标是世界像素；挡路区域是家具的脚下
      "walk": { "cell": 8, "area": [[40, 470], [990, 470], [1010, 568], [20, 568]],
                "blocked": [{ "cx": 170, "cy": 500, "rx": 150, "ry": 30 }] },

      // 家具：精灵（x, y = 脚的位置，也就是精灵底边中点，和小院一样）+ 点击区域 + 标签
      "furniture": [
        { "id": "bed",        "sprite": "bed",        "x": 170, "y": 540, "label": "床", "front": "bed-front" },  // front：她躺进去时，画在她上面的床尾板和床柱
        { "id": "nightstand", "sprite": "nightstand", "x": 330, "y": 520, "label": "手机" },
        { "id": "desk",       "sprite": "desk",       "x": 560, "y": 500, "label": "书桌和电脑" },
        { "id": "record",     "sprite": "record-cabinet", "x": 730, "y": 500, "label": "唱片机" },
        { "id": "tv",         "sprite": "tv-cabinet", "x": 900, "y": 505, "label": "游戏机" },
        { "id": "beanbag",    "sprite": "whale-beanbag", "x": 760, "y": 560, "flat": true,
          "use": { "at": [760, 548], "anim": "sit", "seconds": [8, 16], "label": "坐一会儿" } }   // 不属于五类活动的小物件：和小院一样的 use
      ],

      // 五类活动在这个房间里的画面：在哪件家具、她站哪、朝向、姿势、道具效果（§1.3）。
      // 一个 open 主题必须五类都有；可以覆盖默认的 seconds / deltas 以外的任何字段（数值只能用默认的，§2.1）
      "activities": {
        "sleep": { "at": "bed", "spot": [200, 470], "face": "right", "pose": "tucked",
                   "props": [ { "fx": "dim", "to": 0.55 },
                              { "fx": "layer", "sprite": "quilt", "x": 170, "y": 520, "under": "front" },
                              { "fx": "emit", "sprites": ["z1", "z2"], "from": [230, 380], "every": 1.4, "rise": 60 } ],
                   "lines": { "doing": ["深度睡眠中……勿扰。", "呼……白饭……再来一碗……"], "done": ["咕噜~睡饱了，精神满满！"] } },
        "work":  { "at": "desk", "spot": [560, 520], "face": "left",
                   "props": [ { "fx": "screen-type", "rect": [536, 360, 52, 34], "rows": 5, "color": "primary" },
                              { "fx": "swap", "sprite": "desk-lamp", "to": "desk-lamp-on" } ],
                   "lines": { "doing": ["女仆也要认真工作的。", "写完这段就去摸鱼……不，不摸。"], "done": ["活干完啦，鱼片夸我！"] } },
        "phone": { "at": "nightstand", "spot": [380, 520], "face": "left",
                   "props": [ { "fx": "hide", "sprite": "phone-on-table" },
                              { "fx": "hold", "sprite": "phone-lit", "hand": [0.62, 0.52] },
                              { "fx": "emit", "sprites": ["heart"], "from": "head", "every": 3 } ],
                   "lines": { "doing": ["刷到一条鲸鱼视频，好可爱~", "再看一条……就一条。"], "done": ["手机放下了，眼睛休息一下。"] } },
        "music": { "at": "record", "spot": [700, 530], "face": "right",
                   "props": [ { "fx": "spin", "sprite": "record-disc", "x": 738, "y": 420, "squash": 0.35, "rpm": 33 },
                              { "fx": "emit", "sprites": ["note1", "note2", "note3"], "from": [740, 400], "every": 0.8, "rise": 90 },
                              { "fx": "bob", "target": "pet", "period": 0.9, "amp": 3 } ],
                   "lines": { "doing": ["咕噜噜~这首歌好适合摸鱼。", "唱片转呀转~"], "done": ["听完一整面了，心情超好~"] } },
        "game":  { "at": "tv", "spot": [880, 545], "face": "right",
                   "props": [ { "fx": "frames", "rect": [860, 360, 80, 56], "sprites": ["tv-1", "tv-2", "tv-3", "tv-4"], "fps": 6 },
                              { "fx": "hold", "sprite": "controller", "hand": [0.5, 0.58] },
                              { "fx": "emit", "sprites": ["star"], "from": [900, 350], "every": 1.2 } ],
                   "lines": { "doing": ["冲呀！鲸鱼女仆不会输！", "这一关……让我想想。"], "done": ["赢啦！厉害了我的鲸~"] } }
      },

      // 灯（夜里亮，加法混合）和窗外（§4.6）。房间没有窗户时可以不写 window
      "lights": [ { "x": 512, "y": 60, "r": 90 }, { "x": 540, "y": 330, "r": 50, "on": "work" } ],
      "window": { "rect": [400, 90, 180, 200], "arch": true },

      "lines": { "idle": ["咕噜~鱼片，今天想让我做什么？", "房间收拾得干干净净，女仆的本分~"],
                 "enter": ["欢迎回来，鱼片~"], "tired": ["好累……先睡一会儿再说吧。"],
                 "sky": { "rain": "下雨了……鱼片出门记得带伞。", "night": "夜深了，要不要让我去床上睡一会儿？" } }
    },

    { "id": "claude", "character": "claude", "status": "soon", "name": "午后的书房",
      "blurb": "暖橘色的书房：满墙的书、热红茶和整理到一半的笔记。", "motifs": ["书架", "红茶", "菊纹"],
      "palette": { "primary": "#C4622D", "accent": "#F0B48A", "base": "#FFF8F0", "trim": "#7A3B1C" } },
    { "id": "grok", "character": "grok", "status": "soon", "name": "深夜的古堡房间",
      "blurb": "黑金配色的吸血鬼小房间：烛台、丝绒窗帘和一杯番茄汁。", "motifs": ["烛台", "丝绒", "蝙蝠"],
      "palette": { "primary": "#8E1F33", "accent": "#D4A23A", "base": "#1E1418", "trim": "#F2D27A" } },
    { "id": "gemini", "character": "gemini", "status": "soon", "name": "星星猫窝",
      "blurb": "紫色的星空阁楼：猫爬架、逗猫棒和一扇晒太阳的天窗。", "motifs": ["星星", "猫爬架", "天窗"],
      "palette": { "primary": "#7B5CD6", "accent": "#B9A6F2", "base": "#F6F2FF", "trim": "#FFD166" } },
    { "id": "gpt", "character": "gpt", "status": "soon", "name": "白龙的花园卧室",
      "blurb": "白玫瑰和淡紫色的卧室：清单墙、写诗的小桌和夜里的长聊。", "motifs": ["白玫瑰", "清单墙", "龙鳞"],
      "palette": { "primary": "#8E7FC8", "accent": "#D9D2F2", "base": "#FFFFFF", "trim": "#B8A4E0" } }
  ],

  "items": {},
  "quests": [
    { "id": "sleep-full",  "title": "陪她睡一整觉",       "on": { "type": "activity-end", "kind": "sleep", "complete": true } },
    { "id": "work-full",   "title": "陪她认真工作一轮",   "on": { "type": "activity-end", "kind": "work",  "complete": true } },
    { "id": "phone",       "title": "让她刷会儿手机",     "on": { "type": "activity-end", "kind": "phone" } },
    { "id": "music-full",  "title": "陪她听完一张唱片",   "on": { "type": "activity-end", "kind": "music", "complete": true } },
    { "id": "game-full",   "title": "陪她打完一局游戏",   "on": { "type": "activity-end", "kind": "game",  "complete": true } },
    { "id": "night-sleep", "title": "夜里哄她睡觉",       "on": { "type": "activity-end", "kind": "sleep", "phase": "night" } },
    { "id": "rain-music",  "title": "下雨天一起听歌",     "on": { "type": "activity-end", "kind": "music", "weather": ["rain", "storm"] } },
    { "id": "all-five",    "title": "五件事各做一次",     "on": { "type": "activity-end" }, "count": 5, "distinct": "kind" },
    { "id": "pat",         "title": "摸摸她",             "on": { "type": "touch" }, "count": 3 }
  ],
  "lines": { "touch": ["嘿嘿~", "女仆在呢！", "咕噜？"] }
}
```

说明：
- **坐标**：所有坐标都是这个主题世界里的像素（`world.width × world.height`）。`x, y` 是脚的位置，和小院一样。精灵的位置、点击区域（精灵的不透明像素，或者写 `hit` 多边形）和挡路区域都在包里，页面不写死任何坐标。
- **可选字段**：`soon` 主题只需要 `id / character / status / name / blurb / motifs / palette`，可以再加 `preview` 预览图。把它改成 `open` 时，必须补齐 `world / images / sprites / walk / furniture / activities`。
- **台词回落**：先用主题的 `activities.<kind>.lines`，没有就用 manifest 顶层的 `activities.<kind>.lines`，再没有就用引擎内置的一句（PR #151 的 `LINES`）。
- **小事条件**：`quests[].on` 可以带 `theme`，比如以后要写「在克洛蒂的书房里看书」。`distinct: "kind"` 表示按不同的 kind 计数：同一类活动做几次都只算一次。

### 1.3 道具效果词表

活动的 `props` 只能从下面这张表里选，参数也逐项校验。词表由引擎实现，**新房间组合这些效果就够了，不需要新代码**。要加一种新效果，就得升引擎的小版本：应用里加实现，包在 `store.json` 里写 `minAppVersion`（§6.3）。

| fx | 参数 | 画面 | 用在 |
| --- | --- | --- | --- |
| `dim` | `to`（0.3–1） | 整个房间按「天色 × to」压暗，0.6 秒淡入，结束时淡出 | 睡觉 |
| `layer` | `sprite, x, y, under?` | 活动期间多画一个精灵。`under: "front"` 表示画在家具 `front` 层的下面 | 睡觉的被子 |
| `swap` | `sprite, to` | 一个家具精灵换成另一张（台灯亮、电脑开机） | 工作 |
| `hide` | `sprite` | 活动期间藏起一个精灵 | 手机从床头柜上拿走 |
| `hold` | `sprite, hand: [u, v]` | 精灵跟着她，位置是她帧内的相对坐标（0–1），随朝向镜像 | 手机、手柄 |
| `spin` | `sprite, x, y, squash, rpm` | 平放的圆盘绕中心转，竖直方向压扁 `squash` 倍 | 唱片 |
| `frames` | `rect, sprites[], fps` | 在 `rect` 里循环播放几帧 | 电视画面 |
| `screen-type` | `rect, rows, color` | 屏幕上一行行打出文字条（像素方块，不是字体）；第 n 行打完就是进度 n / rows，正在打的那行有光标闪 | 显示器 |
| `emit` | `sprites[], from: [x, y] \| "head", every, rise?` | 每隔 `every` 秒冒出一个粒子，向上飘 `rise` px 后淡出 | Z、音符、爱心、星星 |
| `bob` | `target: "pet", period, amp` | 她上下轻晃 | 听音乐 |
| `glow` | `x, y, r` | 活动期间多亮一盏灯（加法混合） | 屏幕光 |

设置了「减少动态效果」时，`emit`、`bob`、`spin` 和 `frames` 都停在第一帧，`dim` 不做淡入淡出、直接切过去。

### 1.4 校验（`src/core/room-pack.js` 的 `validateRoom`）

`game-pack.js` 的 `validateManifest` 先检查公共字段（schema、kind、id、version、文件名），再按 `engine` 交给 `validateYard`（原来那段代码，原样搬过去）或 `validateRoom`。`tools/game-pack.js` 也要同步这份代码，这样游戏仓库打包时就按应用的规则校验。`validateRoom` 检查这些：

- `themes` 里至少有一个 `open` 主题；`id` 不重复；`character` 是 `src/characters/` 里的一个 id（校验时作为参数传进来，测试里用默认的五个）；`defaultTheme` 是一个 `open` 主题。
- `palette` 的四个键都是 `#RRGGBB`。`status` 只能是 `open` 或 `soon`。
- `open` 主题：
  - `images.room`、`images.atlas`、`sprites` 文件存在，文件名用主题 id 作前缀。
  - `world` 的宽高在 256–4096 之间。`walk.area` 是多边形，`spawn` 和 `door` 都在可走区域里。
  - 每件家具的精灵都在 `sprites.json` 里，`front` 也是。
  - **五类活动都有**，各自的 `at` 指向一件家具，`spot` 在可走区域里。
  - 每个 `props` 的 `fx` 在词表里、参数合法，用到的精灵都存在。`hold.hand` 在 0–1 之间，`rect` 在世界里。
- 顶层 `activities`：
  - `kind` 只能是五个之一。
  - `seconds` 在 5–600 之间；`deltas` 只能有 `energy / mood / focus / fullness` 四个键，每个值在 −40 到 40 之间；`needs.energy` 在 0–100 之间。
  - `anim` 在 `USE_ANIMS` 里（小院那张表，`sit` 也算）。
- `quests[].on.kind` 是五个之一，`on.theme` 是一个主题 id。
- 整份 manifest 不超过 256 KB，最多 12 个主题。

数值上限是为了安全：下载的包能改写 `pet.json` 里她的精力、心情和饥饿，所以每轮的增减幅度都有上限，结算也只在 main 里算（§3.2）。

## 2. 活动与数值

### 2.1 四个数值

和 PR #151 一样，房间显示四个数值（0–100）。区别是：专注由这个游戏自己保存，不再写进 `pet.json`。

| 名字 | 存在哪 | 说明 |
| --- | --- | --- |
| 精力 | `pet.json` 的 `characters[base].energy` | 就是桌宠原有的精力，`pet-state.js` 让它随时间下降 |
| 心情 | `characters[base].mood` | 桌宠原有的心情，影响好感加成 |
| 饱腹 | `100 − characters[base].hunger` | 桌宠的饥饿值反过来显示，和玩法页一样 |
| 专注 | `.progress/her-room.json` 的 `state.focus[base]` | 这个游戏自己的数值，初始 50，只有房间里的活动会改它 |

一轮做完的效果（默认值，来自 manifest 顶层的 `activities`）：

| 活动 | 家具 | 动作 | 时长 | 精力 | 心情 | 专注 | 饱腹 | 开始条件 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 睡觉 | 床 | `sleep`（躺进被子里） | 30 s | +35 | +6 | +8 | −4 | — |
| 工作 | 书桌和电脑 | `think` | 30 s | −12 | −5 | +28 | −8 | 精力 ≥ 15 |
| 看手机 | 床头柜上的手机 | `look`（手机拿在手里） | 20 s | −4 | +14 | −10 | — | — |
| 听音乐 | 唱片机 | `happy`（轻晃） | 25 s | +6 | +16 | +6 | — | — |
| 打游戏 | 电视和游戏机 | `play`（拿着手柄） | 30 s | −14 | +22 | −6 | −8 | 精力 ≥ 15 |

主题**不能**覆盖 `deltas` 和 `needs`：数值平衡只在顶层定义一次，所有房间一样。这样换一个房间不会刷到更多数值，主题也只能改画面和台词。

### 2.2 结算规则（`src/core/room-play.js`）

纯函数，每个函数都显式传入 `now`。用 UMD 写，main、页面和测试都 `require` 同一份，写法同 `game-quests.js`：

- `start(run, kind, now, defs, stats)` → `{ ok, run, settled }`。如果已经有一件事在做，先结算它，再开始新的。精力不够时返回 `{ ok: false, reason: 'tired', need: 15, have: 10 }`，什么都不改。判断精力时用的是前一件事结算之后的数值。
- `settle(run, now, defs)` → `{ kind, complete, fraction, deltas, at }`：
  - 已过时长 ≥ `seconds` 时算完成，`fraction = 1`。
  - 提前结束时，`fraction` 按做了多久算，四舍五入到 0.01，最少 0.25（`MIN_FRACTION`），所以刚开始就停也算做过一点。
- `apply(stats, deltas, fraction)` → 夹到 0–100 之后的新数值，以及**实际**变化了多少（夹住的那部分不显示）。
- `view(run, now, defs)` → 进度 0–1、剩余秒数，给页面画计时用。

### 2.3 什么时候结算

- **做完一整轮**：页面的计时到点后调用 `activity({ cmd: 'tick' })`。main 用自己的时钟确认真的到点了才结算，不信页面传来的时长。
- **提前结束**（结束按钮、再点一次同一件家具、点地板让她走开、拎起她）：`activity({ cmd: 'stop' })`。
- **切换**到另一件事：`activity({ cmd: 'start', kind })`，main 先结算前一件。
- **切换房间**、**关掉游戏窗口**、**退出应用**：main 在 `GameWindow.onClosed` 和 `before-quit` 里结算正在做的事，按做了多久算。
- **进程崩溃**：没来得及结算的那一件存在进度文件的 `state.run` 里，下次 `game:boot` 时结算。如果当时已经超过一整轮，按完成算，否则按崩溃前最后一次保存时的已过时长算（页面每 5 秒存一次）。

和 PR #151 不同的是：关掉窗口以后，活动**不会**在后台继续计时。理由是游戏关了，她已经回到桌面，不在房间里了。

## 3. 和已有模块的对接

### 3.1 她进到房间里（game-pet、她的外观）

- **打开与关闭**：沿用 `game-window.js`。打开游戏时，桌面上的她隐藏、进到游戏里；关掉后回到原来的位置。托盘、⌂、快捷键和「开始玩」这几个入口都不变；`settings.scene.game` 记录的是上次玩的游戏（`her-room` 或 `pixel-yard`）。
- **谁在房间里**：在房间里的总是**当前陪你的那个角色**（`view.look`），和小院一样。
  - 打开时进她自己的主题（`theme.character === base`，并且是 `open`）。没有的话，进上次选的主题；再没有就进 `defaultTheme`。
  - 她在别人的房间里就是「去做客」：外观不换，活动和数值照常。
  - 房间主人在自己的房间里时，外观换成 `theme.outfit`。大肥鱼的 `daily` 就是招牌女仆装（`dafeiyu-pixel/sheets/daily.webp`）。这需要 main 在 `game:boot` 里多给一份 `looks.owner`：同一个像素包、指定服饰的那份外观。外观的解析走 `PetService` 现有的外观代码，不在页面里拼路径。她的像素包里没有这套服饰时，就用她当前的外观。
- **状态机**：直接用 `createGamePet`，房间也是一个 `GameWorld`：
  - 可走区域是主题的 `walk`，一条地板带，8 px 网格，A* 寻路。
  - 每件活动家具转换成一个 `use` 物件：`at = spot`，`anim` 取活动的动作，`seconds` 设成足够长，结束由 room-play 控制，所以 game-pet 不用改。
  - 她到了以后发 `use-start`，页面这时开始道具效果和计时，并调用 `activity start`。
  - 「自己走动」开着时，她在没有活动的时候会在地板上逛，偶尔坐一下鲸鱼懒人沙发，但**不会自己开始五类活动**：数值只因为你的操作而改变。
- **动作**：都是她像素包里已有的动作，`sleep / think / look / happy / play / idle / walk / lifted / pat`。缺的动作按 `core/fx.js` 的回落链降级，所以没有专门画的角色也能进房间。
- **`pose: "tucked"`**（躺进被子里）：
  - 她不走到床上，到了 `spot` 之后，用 0.4 秒从站着变成横躺：精灵转 −90°，下巴对齐被子 `layer` 的上沿。
  - 遮挡顺序从下到上是：她、被子、床的 `front` 层，所以只露出头、鲸鱼鳍耳和女仆头饰。
  - 结束后反过来，她起身站回 `spot`。
  - 纸片人外观（图片、Live2D、VRM）不躺下，只做 `dim` 和冒 Z。

### 3.2 数值与好感（PetService）

新增一个 IPC `game:activity`（preload 里叫 `game.activity(cmd)`），只接受游戏窗口发来的消息。逻辑都在 `src/main/games.js` 的 `GameLibrary.activity(id, cmd, ctx)` 里：

```
page  ── game.activity({ cmd: 'start', theme: 'dafeiyu', kind: 'sleep' }) ──▶ main
main  ── 用已安装的 manifest 拿 defs（不用页面传来的数值）
      ── RoomPlay.start(progress.state.run, kind, now, defs, stats)
      ── 有被顶掉的前一件 → PetService.roomSettle(deltas) + 写 focus + GameQuests.record('activity-end')
      ── 写 .progress/her-room.json（state.run = { theme, kind, startedAt }）
      ◀─ { ok, run, stats, settled?, completed?: [小事…] }
page  ── tick / stop 同理；main 用自己的时钟算 fraction
```

- `PetService.roomSettle({ energy, mood, fullness })` 只改 `characters[base]` 里这三个数值，夹到 0–100，写 `lastInteractionAt`。它**不**改桌宠的睡眠状态，房间里睡觉不会让桌面上的她「睡着」。然后存盘、推 `update`，所以她的面板和设置窗口马上就能看到新数值。
- **好感**：只有每日小事会加好感，走现有的 `PetService.gameQuest(title)`：来源 `game`，每件 +2，每天最多 3 次，也算进每日好感总上限。PR #151 里「打完一整局按桌宠的玩耍算好感」这一条不保留。原因有两个：一是不让一款游戏占用两个好感来源；二是小院也只通过小事加好感，两款游戏规则一样。
- **点她**：走 `game:touch` → `service.touch('head')`，和小院一样，好感规则不变。点她不会打断正在做的事，她冒一句 `lines.touch`。

### 3.3 页面桥的变化（`game-preload.js`）

| 方法 | 变化 |
| --- | --- |
| `boot()` | 多返回 `room: { looks: { owner }, characters: [{ id, name, avatar }], stats, run }`。`characters` 给切换房间用（§4.3），头像是各自像素包的 `avatar.webp`，走现有的 `pack://` 协议 |
| `activity(cmd)` | **新增**。`cmd` 是 `start / stop / tick / theme`，其中 `theme` 用来切换房间 |
| `event(ev, ctx)` | 不变。房间的 `activity-end` 由 main 在结算时自己记，页面不发，防止重复计数 |
| `saveState(state)` | 不变。房间存 `{ theme, runElapsed }`，main 合并进 `state`，不让页面覆盖 `focus` 和 `run` |
| `onView` | 不变：她的数值在别的地方变了（比如桌面上喂她吃东西），状态卡也跟着更新 |

### 3.4 每日小事（game-quests）

- `GameQuests.record` 不变，只在 `matches` 里多认三个可选条件：`on.kind`、`on.theme`、`on.complete`。事件长这样：`{ type: 'activity-end', kind, theme, obj, complete }`。
- `distinct: "kind"` 需要多存一个计数：`counts[q.id]` 照旧是数字，另外加 `seen[q.id] = [kind…]`。小院的包没有这个字段，行为不变。
- 每天还是挑 3 件。工具栏 ☑ 打开「今日小事」卡片，这部分代码移到 `game-shell.js` 以后由两个引擎共用。

### 3.5 进度文件

`userData/games/.progress/her-room.json`，读写用现有的 `GS.readProgress / writeProgress`：

```jsonc
{
  "quests": { "day": "2026-11-05", "counts": { "sleep-full": 1 }, "seen": { "all-five": ["sleep"] }, "done": ["sleep-full"], "total": 4, "items": {} },
  "state": {
    "theme": "dafeiyu",                                     // 上次选的房间
    "focus": { "dafeiyu": 58 },                             // 每位角色的专注
    "run": { "theme": "dafeiyu", "kind": "work", "startedAt": 1793890000000, "seenAt": 1793890012000 },   // 正在做的事，没有时为 null
    "last": { "kind": "sleep", "complete": true, "fraction": 1, "deltas": { "energy": 35, "mood": 6, "focus": 8, "fullness": -4 }, "at": 1793889990000 },
    "totals": { "dafeiyu": { "sleep": { "count": 3, "completed": 2, "ms": 74000 } } }   // 详情页「你们的进度」用
  }
}
```

更新或删除游戏包都不影响这个文件，和小院一样。

### 3.6 天色

房间读的是同一份 `settings.scene`，所以在小院里调成夜里，房间里也是夜里。每个 open 主题可以写 `window` 和 `lights`（§4.6）。不在房间里做独立的天色卡片，标题栏有一个 ☀ 按钮，点开就是小院的天色卡片，这张卡片的代码也移到 `game-shell.js` 里共用。

## 4. Pixi 里怎么呈现

### 4.1 页面结构

```
src/renderer/game/game.html       外壳：标题栏、卡片、提示、气泡这些 DOM；按 manifest.engine 加载一个引擎脚本
src/renderer/game/game-shell.js   boot、标题栏（名字 / 版本 / 有新版本 · 去更新 / ✕）、今日小事卡、天色卡、提示、气泡、快捷键、__game 调试接口
src/renderer/game/engines/yard.js 现有 game.js 里属于小院的部分，原样搬过来，行为不变（e2e game 的 G1–G14 是回归测试）
src/renderer/game/engines/room.js 新的 room@1 引擎
src/renderer/game/room-fx.js      道具效果词表的实现（§1.3），每个 fx 一个小工厂：create(sprite, params) → { update(dt, progress), destroy() }
```

页面的 CSP 不变：只加载应用自带的脚本，包里只有数据。拆文件不改小院的行为。小院的 e2e 先在拆分 PR 里跑一遍全绿，再做房间引擎。

### 4.2 场景树（`engines/room.js`）

```
view           适配窗口：世界 1024×576 按整数倍或 0.5 倍缩放、居中，留边用主题的 world.background；房间不平移、不缩放
├ graded       ColorMatrixFilter：天色 × 0.5（房间里的调色只用一半强度，同 PR #151 的 INSIDE）× 活动的 dim
│ ├ bg         背景图（墙、窗框、地板、地毯）
│ ├ window     窗外（遮罩是 window.rect）：天色调色用全强度 + 太阳、月亮、云、雨、雪（game-sky 的参数）
│ ├ back       贴墙、她碰不到的装饰（flat 家具）
│ ├ sorted     活动家具和她，按脚的 y 排序（zIndex = y）
│ ├ front      tucked 时画在她上面的层：被子（layer，under: front）→ 床尾（furniture.front）
│ ├ props      道具效果：屏幕、唱片、电视、拿在手里的东西
│ └ outline    悬停描边
├ lights       加法混合：主题的 lights、glow、屏幕光（夜里才明显）
└ particles    Z、音符、爱心、星星（不调色，保持可读）
DOM (shell)    状态卡、活动条、家具标签、气泡、房间选择卡、预览卡、提示
```

精灵统一用最近邻缩放（`scaleMode: 'nearest'`），像素是方的。她的精灵按 `petHeight` 缩放，加一圈深色描边，做法和小院一样。

### 4.3 切换房间

- **入口**：标题栏左边是房间名按钮「鲸鱼女仆的蓝色小屋 ▾」，快捷键 `R`。点开以后，画面下方中央弹出一张磨砂卡片（和天色卡片同一种样式），横排五个条目：
  - 每个条目有她的像素头像、房间名、四色色块，以及状态标签「可以玩」或「即将开放」。
  - 当前房间的条目有高亮边框，`‹ ›` 或方向键切换焦点，回车或点击选择，`Esc` 收起。
  - 没遇见过的角色也显示头像，不用剪影，因为这里展示的是房间。
- **五个条目**（来自 `themes[]`，顺序就是卡片上的排列；完整字段见 §1.2 的 manifest 示例）：

  | # | 主题 id | 房间主人（`character`） | 房间名 | 状态 | 元素 | 色板 primary / accent / base / trim | 点了以后 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 1 | `dafeiyu` | 大肥鱼 | 鲸鱼女仆的蓝色小屋 | `open` 可以玩 | 蕾丝、蝴蝶结、鲸鱼 | `#2C4A8A` `#6FA8E8` `#FFFFFF` `#E8D6A0` | 进入房间 |
  | 2 | `claude` | 克洛蒂 | 午后的书房 | `soon` 即将开放 | 书架、红茶、菊纹 | `#C4622D` `#F0B48A` `#FFF8F0` `#7A3B1C` | 预览卡 |
  | 3 | `grok` | 格萝可 | 深夜的古堡房间 | `soon` 即将开放 | 烛台、丝绒、蝙蝠 | `#8E1F33` `#D4A23A` `#1E1418` `#F2D27A` | 预览卡 |
  | 4 | `gemini` | 杰米 | 星星猫窝 | `soon` 即将开放 | 星星、猫爬架、天窗 | `#7B5CD6` `#B9A6F2` `#F6F2FF` `#FFD166` | 预览卡 |
  | 5 | `gpt` | 吉皮缇 | 白龙的花园卧室 | `soon` 即将开放 | 白玫瑰、清单墙、龙鳞 | `#8E7FC8` `#D9D2F2` `#FFFFFF` `#B8A4E0` | 预览卡 |

- **选 open 主题**：
  1. 先结算正在做的事（§2.3）。
  2. 画面淡出 0.3 秒，加载新主题的图集，再淡入。
  3. 她从 `door` 走到 `spawn`，冒一句 `lines.enter`。
  4. 选择存进 `state.theme`。
  图集按需加载，加载过的缓存起来，所以切回来是瞬间的。
- **选 soon 主题**：不切换画面，在原房间上叠一张预览卡。卡上有：
  - 房间名、简介、元素标签，标签是用 `palette` 画的小色块。
  - 她的立绘：头像放大，最近邻缩放。
  - 大字「即将开放」，和按钮「回到 鲸鱼女仆的蓝色小屋」。
  - 包里有 `preview` 时，卡片背景用这张图；没有就用 `palette` 画四色渐变的像素格子。
  预览卡上不能点家具，也不会报错。
- 每个条目都由 `themes[]` 生成。以后把 `claude` 改成 `open`、补上图，选择器里它自动变成「可以玩」，不用改代码。

### 4.4 五类活动的交互与反馈

**悬停**：
- 家具精灵在 `outline` 层画 2 px 描边，颜色是主题的 `base`，外面再加 1 px 的 `primary`，像小院那样用精灵的 alpha 外扩。
- 指针旁边出现提示「睡觉 · 床」。进行中提示变成「睡觉中 · 再点一次结束」。
- 精力不够时，描边变灰、指针变成禁止，提示写原因：「太累了（精力 10，要 15）· 先让她睡一觉」。

**点击后的流程**（每一步在画面上都能看到）：
1. 地上插一个小蝴蝶结标记，她沿寻路走过去，播 `walk`。
2. 到了以后转身朝 `face`，播活动的 `anim`，`props` 开始：
   - 睡觉：房间压暗，她躺下、盖上被子，冒 Z。
   - 工作：台灯亮起，显示器上一行行打字。
   - 看手机：床头柜上的手机消失、出现在她手里，屏幕亮着，冒爱心。
   - 听音乐：唱片转起来，飘音符，她轻轻晃。
   - 打游戏：电视上播鲸鱼跳金币的小游戏，她拿着手柄，冒星星。
3. **计时与进度**：
   - 画面左下角的活动条：图标、「正在睡觉」、`00:12 / 00:30`、进度条，以及「结束」按钮。
   - 家具上沿的标签变成「睡觉中」，下面有一条细进度条。
   - 工作和打游戏还在道具上显示进度：显示器写到第几行，电视顶上的小进度条。
4. **台词气泡**：开始时说一句 `doing`，之后每 6 秒换一句，做完说 `done`。气泡放在她头的右上方，不挡住标签和屏幕。气泡位置可以在主题里写 `bubble` 覆盖。
5. **数值条**：右上角的「大肥鱼的状态」卡片，四条横条：
   - 精力和饱腹用 `accent` 色，心情用粉色，专注用 `primary` 色。
   - 进行中，会变化的那几条末端有一段斜纹预览，按当前进度显示「这一轮会 +x」。
   - 结算时，横条动画到新值，旁边飘出「+35」「−4」，提示框写「睡觉完成：精力 +35，心情 +6，专注 +8，饱腹 −4」。

**结束与切换**：
- 到点：自动结算，`props` 反向收起（被子掀开、她起身、手机放回床头柜），她回到 idle，0.8 秒后可以接着点。
- 提前结束：点「结束」或者再点一次同一件家具。提示写「睡觉先到这里（做了 40%）：精力 +14 …」。
- 点另一件家具：先结算前一件、收起道具，她再走过去。
- 点地板或拎起她：结束当前的事，按做了多久算，然后照常走过去或被拎起来。
- 切换房间或关掉窗口：按 §2.3 结算。下次打开时，状态卡下面显示「上一件：工作（做了 60%）」。

**完成小事**：提示「完成：陪她睡一整觉 · 好感 +2」，她说一句话，这一套和小院一样，由外壳负责。

### 4.5 调试与测试接口

和小院的 `window.__game()`、`window.__gameTest` 对齐：

- `__game()` 多返回 `room: { theme, themes: [{ id, status }], run: { kind, progress }, stats, props: [{ fx, visible, frame }], pet: { x, y, mode, anim, pose }, hover, labels: [{ id, rect }], bubble: { text, rect } }`。
- `__gameTest` 多几个方法：`openThemes()`、`pickTheme(id)`、`hoverFurniture(id)`、`clickFurniture(id)`、`toScreen(x, y)`、`setRoundScale(k)`（只在测试模式下有效，用来缩短一轮）、`setStats(…)`（只在测试模式下有效，用来把精力压到 10）。

### 4.6 窗外与灯

主题写了 `window.rect` 时，窗外是一个遮罩区域：背景图的那一块再画一遍，套上全强度的天色调色，再画太阳或月亮、云、雨或雪，参数来自 `game-sky.js`，和 PR #151 §5 的效果一样，只是改成用 Pixi 画。`lights` 在黄昏亮一半、夜里全亮。带 `on: "<kind>"` 的灯只在那件事进行中亮。这部分是加分项，不影响五类活动的验收；时间不够时可以放到 1.1.0。

## 5. 大肥鱼房间的美术规格

### 5.1 方向

- **视角**：正面平视的房间剖面，像一个娃娃屋：后墙、左右墙各露一点，地板占画面下面约 20%。不用小院的等距视角，因为五件家具要能一字排开、都看得清，她站在地板上做事。
- **像素**：硬边方像素，每个美术像素在原图上是干净的 4×4 块，不要抗锯齿和模糊。每种材质 3–4 档色。生成后按 0.5 倍盒式缩小到 1024×576，和小院一样像素化。
- **配色**（主色是浅蓝和奶白）：

  | 色 | 用在 |
  | --- | --- |
  | `#6FA8E8` 浅蓝 | 墙面、被子、窗帘 |
  | `#FFFFFF` / 奶白 `#FFF8EC` | 家具、蕾丝、护墙板 |
  | `#2C4A8A` 深蓝 | 蝴蝶结、描边、阴影 |
  | `#E8D6A0` 浅金 | 金属边、相框、灯 |

- **少女元素**：蕾丝床幔和窗帘、海军蓝蝴蝶结（床头、窗帘、被子、柜门）、鲸鱼（抱枕、墙贴、地毯、懒人沙发、电视里的小游戏主角）、贝壳和波点、心形相框、窗外的海。
- **大肥鱼**：不重画角色，用她像素包里的招牌女仆装（`dafeiyu-pixel` 的 `daily`，664×904 一帧，17 个动作）。房间美术里**不画任何人物**。

### 5.2 提示词清单（`games/her-room/art/prompts.json`）

统一风格句（`style`，追加在每条提示词后面）：

> Detailed pixel art for a cozy indie life-sim game, straight-on front view of a room interior like a dollhouse cutaway (no isometric angle, no perspective tilt), crisp hard-edged square pixels (every art pixel is a clean 4x4 block, no anti-aliasing, no blur), limited palette with 3 to 4 shades per material, kawaii girly maid style. Palette: light blue #6FA8E8 and creamy white #FFFFFF as main colors, navy #2C4A8A accents and ribbons, pale gold #E8D6A0 trims. No text, no letters, no UI, no characters, no people, no animals.

| name | size | 提示词要点 | 切成 |
| --- | --- | --- | --- |
| `dafeiyu-room` | 2048×1152 | 空房间背景，**不画五件活动家具**：浅蓝墙面配奶白蕾丝护墙板；中间偏左一扇拱形窗，窗外是海和天，挂奶白蕾丝窗帘、系海军蓝蝴蝶结；墙上贴鲸鱼墙贴，挂贝壳相框和心形镜子；天花板挂贝壳吊灯；奶白木地板上铺浅蓝鲸鱼形地毯。家具的位置（左边是床，中间是书桌，右边是唱片柜和电视柜）留成空墙和空地，地平线平直。不透明，不用品红底 | `dafeiyu-room.webp`（1024×576） |
| `dafeiyu-furniture` | 2048×2048 | 品红 `#FF00FF` 底，3×3 网格里的独立家具，间隔留宽，不画地面和阴影，都是正面视角：① 带蕾丝床幔和蝴蝶结的奶白公主床（床头板高，床尾板单独成一件）② 床尾板和两根床柱（单独一件）③ 床头柜和贝壳台灯，柜面空着 ④ 奶白写字桌、显示器（屏幕全黑）和椅子 ⑤ 带蝴蝶结的矮柜和上面的复古唱片机（不放唱片）⑥ 电视柜和复古电视（屏幕全黑），旁边放游戏机 ⑦ 鲸鱼懒人沙发 ⑧ 台灯亮着的样子（灯罩发光）⑨ 鲸鱼抱枕 | `bed` `bed-front` `nightstand` `desk` `record-cabinet` `tv-cabinet` `whale-beanbag` `desk-lamp-on` `whale-plush` |
| `dafeiyu-props` | 2048×2048 | 品红底，4×4 网格里的小道具：放在桌上的手机（屏幕暗）、手里拿着的手机（屏幕亮着、有一只小鲸鱼）、俯视的黑胶唱片（标签是浅蓝色）、浅蓝被子（奶白蕾丝翻边、海军蓝蝴蝶结、白色波点，宽，只画盖在床垫上的那一段）、游戏手柄、三种音符、两种「Z」字形的像素气泡（**不要写字母**，用两个圆形气泡代替）、一颗爱心、一颗四角星、一杯热可可 | `phone-on-table` `phone-lit` `record-disc` `quilt` `controller` `note1–3` `z1` `z2` `heart` `star` `cocoa` |
| `dafeiyu-screens` | 1536×1024 | 品红底，两行图块。第一行是 4 帧横版小游戏画面：一条小蓝鲸跳起来吃金币，地面向左滚动，16:11 的屏幕比例。第二行是 1 帧显示器桌面背景：浅蓝底，左边一列文件图标 | `tv-1`…`tv-4` `monitor-bg` |
| （可选）`<id>-preview` | 1536×1024 | 即将开放主题的预览图：照该主题的 `blurb` 和 `palette` 画一个空房间。第一版不做 | `<id>-preview.webp` |

按小院的规则生成：`scripts/generate.sh games/her-room [name…]`，一次一张、每张之间停 20 秒、不并行；模型 `gpt-image-2.5-sunburst`，`quality=high`。

- 原图存为无损 WebP，放在 `art/raw/`。
- 一张不合格就只重生成那一张，例如 `generate.sh games/her-room dafeiyu-props`。合格的标准见 §5.4。
- 如果文字 Z 或家具被画进了背景，在提示词后面加一句否定描述再生成，不要手修。

### 5.3 精灵清单（`games/her-room/art/layout.json`）

| 精灵 | 来自 | 约略尺寸（缩小后） | 用途 |
| --- | --- | --- | --- |
| `bed` | furniture ① | 300×260 | 睡觉家具，sorted |
| `bed-front` | furniture ② | 300×140 | 躺下时的前景层 |
| `nightstand` | furniture ③ | 90×110 | 看手机家具 |
| `desk` | furniture ④ | 200×190 | 工作家具 |
| `desk-lamp-on` | furniture ⑧ | 40×60 | `swap` |
| `record-cabinet` | furniture ⑤ | 130×170 | 听音乐家具 |
| `tv-cabinet` | furniture ⑥ | 170×200 | 打游戏家具 |
| `whale-beanbag` | furniture ⑦ | 120×70 | 坐一会儿（flat） |
| `whale-plush` | furniture ⑨ | 50×40 | 床上的装饰 |
| `phone-on-table` / `phone-lit` | props | 14×22 | `hide` / `hold` |
| `record-disc` | props | 48×48 | `spin`（压扁） |
| `quilt` | props | 260×90 | `layer` |
| `controller` | props | 24×16 | `hold` |
| `note1` `note2` `note3` `z1` `z2` `heart` `star` | props | 12–20 | `emit` |
| `cocoa` | props | 16×18 | 床头柜上的装饰 |
| `tv-1`…`tv-4` | screens | 80×56 | `frames` |
| `monitor-bg` | screens | 52×34 | `screen-type` 的底 |

切图沿用 `game_sprites.py`：

```bash
python3 scripts/game_sprites.py find games/her-room/art/raw/dafeiyu-furniture.webp   # 去品红底，把碎片并成精灵，列出框
# 把框和名字写进 layout.json。这里有两处和小院不同：
#   "background" 条目（key: "none"，scale 0.5）输出 dafeiyu-room.webp；
#   "prefix": "dafeiyu-" 输出 dafeiyu-atlas.webp 和 dafeiyu-sprites.json
python3 scripts/game_sprites.py build games/her-room/art/layout.json games/her-room/art/raw games/her-room/pack
```

`game_sprites.py` 要加两处，都向后兼容，小院的 layout 输出逐字节不变：
- 支持 `prefix`，一个游戏可以输出多套图集。
- 支持 `background` 条目，也就是不透明、不扣底的整图缩小。

### 5.4 美术验收

- 品红边：`build` 之后，图集里没有 `#FF00FF` 附近的像素。`game_sprites.py` 已经会检查这一项，改为失败时退出。
- 每件家具缩小后，最短边不小于 40 px，并且在 960×600 的窗口里能一眼认出是什么。
- 她（`petHeight` 150）站在每个 `spot` 上时，不挡住屏幕、唱片和家具标签。e2e R5 会检查。
- 色板：背景主色调用 k-means 取 5 个色，其中至少一个落在 `#6FA8E8` ±12% 以内，并且奶白和白色合计占画面 25% 以上。由 `room-pack` 的美术测试脚本输出，结果只作为提示，不让测试失败。

## 6. 上架、版本与目录同步

### 6.1 顺序

1. **应用先支持 `room@1`**：在主应用仓库实现 §1–§4，发一个应用版本（预计 0.27.0），`GP.ENGINES` 里有 `room@1`。
2. **游戏仓库加 `games/her-room/`**：
   - 目录：`pack/`、`art/`、`cover.webp`、`screenshots/`、`store.json`（玩法要点、截图说明，`"minAppVersion": "0.27.0"`）、`CHANGELOG.md`（`## 1.0.0 · 日期`）。
   - `tools/game-pack.js` 同步成应用里的新版本，打包前就按应用的规则校验 `room@1`。
3. **打包和发布**（在游戏仓库里）：
   ```bash
   node scripts/build.js      # 校验 + out/her-room-1.0.0.zip + 更新 catalog.json（大小、sha256、更新说明、engine room@1、minAppVersion）
   node scripts/publish.js    # 传到 CDN 的 games-v1/，下载回来比对，标记 published
   git commit -am "🔖 her-room 1.0.0" && git push
   ```
4. **应用随附目录**：发版前在主应用仓库跑 `node scripts/sync-game-catalog.js`，把 her-room 的条目、封面和截图写进 `src/core/game-catalog.json` 和 `src/renderer/catalog/games/her-room*`。再跑 `--check`，确认没有差异。

### 6.2 商店里看到什么

- 商店 → 小游戏多一张卡片「她的房间」：封面、版本、一句介绍、下载。点进去是详情页（`#/store/game/her-room`），预览截图用 §7.3 生成的六张。
- 旧版本应用（不认识 `room@1`，或者版本低于 `minAppVersion`）显示「需要更新应用」，不能下载。`game-index.js` 的 `supported()` 已经处理了这种情况。
- 两款游戏都装了时，托盘、⌂ 和快捷键打开上次玩的那款。游戏窗口标题栏现在没有换游戏的入口，本轮在 `game-shell.js` 的标题栏加一个「⇄」，点开列出已下载的游戏（`game:boot` 多返回 `installed: [{ id, name }]`），选一个就带 `?game=<id>` 重新载入。

### 6.3 后续版本

| 改动 | 版本 | 要不要发应用 |
| --- | --- | --- |
| 改台词、数值、小事，换美术 | her-room 补丁版本 1.0.x | 不用 |
| 开放一个新房间（比如 `claude` 从 soon 改成 open，加 3 个文件） | 小版本 1.x.0 | 不用 |
| 新的道具效果，或者新的活动类别 | 引擎小版本：应用加实现，包写 `minAppVersion` | 要 |
| 包格式有不兼容的变化 | `room@2` | 要 |

开放一个新房间的步骤（只改数据）：
1. 照 §5.2 的格式写 `<id>-room / -furniture / -props / -screens` 四条提示词，生成原图。
2. `layout.json` 加一个 `prefix: "<id>-"` 段，build。
3. 在 manifest 里补齐这个主题的 `world / images / sprites / walk / furniture / activities / lines`，`status` 改成 `open`。
4. 跑 `node scripts/build.js`，校验通过后发布。
5. 在应用里打开游戏，用 e2e `room` 的 R3/R5 截图检查位置。

## 7. 测试与验收计划

### 7.1 单测（`npm test`）

| 文件 | 覆盖 |
| --- | --- |
| `test/room-pack.test.js` | 合格的 fixture 能通过；以下每种情况各报一条错：少一类活动、`at` 指向不存在的家具、`spot` 不在地板上、未知的 fx、fx 参数越界、`deltas` 超过 ±40 或用了不认识的键、`seconds` 越界、主题文件名前缀不对、多出来的文件、soon 主题只有基本字段也能通过、`character` 不是默认角色之一、manifest 超过 256 KB。小院的包还是按原来的规则校验 |
| `test/room-play.test.js` | 一整轮的结算和表里一致；提前结束按比例算，最少 0.25；切换时先结算前一件；精力不够时拒绝开始，判断用的是结算后的精力；数值夹到 0–100，只显示实际的变化；`tick` 时间不到不结算；崩溃恢复（`run` 已超过一整轮就按完成算） |
| `test/game-quests.test.js`（补充） | `kind / theme / complete` 三个条件，`distinct: "kind"`，`phase` 和 `weather` 和活动一起用 |
| `test/game-store.test.js`（补充） | 平铺、带前缀的 room 包能安装；有子文件夹的包会被拒绝；更新后进度文件不变 |
| `test/game-index.test.js`（补充） | `room@1` 的条目在旧引擎列表或低于 `minAppVersion` 时显示「需要更新应用」 |
| `test/pet-service-room.test.js` | `roomSettle` 只改三个数值、不让桌宠进入睡眠状态、会推送 `update` |
| fixture | `test/fixtures/games/mini-room/`：一个 open 主题（几张很小的图集）加四个 soon 主题 |

### 7.2 e2e（`node e2e/run.js room`，`e2e/mini-room.js`）

和 `e2e/mini-game.js` 一样，用本地 http 服务当 CDN 和游戏仓库的目录；`setRoundScale` 把一轮缩短到 4 秒。用户是 dafeiyu，用真实鼠标点画布：

| 编号 | 场景 | 断言 |
| --- | --- | --- |
| R1 | 商店 → 小游戏 → 「她的房间」下载 → 开始玩 | 卡片和详情页显示正确；游戏窗口打开、桌宠窗口隐藏；WebGL 在画、帧数在走 |
| R2 | 进房间 | 主题是 dafeiyu；背景和图集加载完成；她用的是 `daily` 那张 sheet；五件活动家具都能点 |
| R3 | 切换房间：打开卡片，依次选五个条目 | 五个条目的状态是 1 个可以玩、4 个即将开放；四张预览卡都显示房间名、色板、头像，控制台没有报错；回到 dafeiyu；`state.theme` 已保存 |
| R4 | 悬停每件家具 | 描边出现（`hover` 是这件家具，outline 层有像素）；提示文字正确 |
| R5 | 五件事各做一整轮 | 她走到 `spot`，`anim` 正确；每个 `props` 的状态正确（被子在床的范围内、她的头在被子上面；显示器写好的行数在增加；唱片在转；电视在换帧；手机在她手里）；活动条和进度在走；气泡有台词；结算提示和数值变化方向符合 §2.1；`pet.json` 和状态卡一致；家具标签不在她身上 |
| R6 | 精力 10 时 | 工作和打游戏的描边是灰的，提示写原因，点了不会开始 |
| R7 | 提前结束和切换 | 做到一半点「结束」，`fraction` 约等于实际做了多久的比例；做一半时点另一件家具，前一件先结算 |
| R8 | 点她、拖她 | 好感规则不变；拖她会结束正在做的事 |
| R9 | 小事 | 完成三件，各 +2 好感，第四件不再加；`all-five` 按不同的 kind 计数 |
| R10 | 天色 | 调到夜里，房间变暗、灯亮起、窗外是月亮；调成小雨，窗外下雨 |
| R11 | 关闭与恢复 | 工作中按 Ctrl+W，按做了多久结算，她回到桌面；再打开，状态卡显示「上一件：工作（做了 x%）」；重启后主题、专注和小事都还在 |
| R12 | 升级 | 游戏仓库发布 1.0.1：出现「有更新」，更新后进度还在（同 G14） |

小院的 `node e2e/run.js game`（G1–G14）在拆分引擎之后要全部通过。

### 7.3 截图与录屏（`node e2e/run.js roomdocs`，`e2e/mini-room-docs.js`）

参照 `e2e/mini-game-docs.js`：Playwright 用真实鼠标点画布，ffmpeg x11grab 录下 Xvfb 屏幕上游戏窗口所在的区域。输出到 `docs/img/her-room/`：

- 截图（WebP）：`room-day`、`room-night`、`hover-bed`、`act-sleep`、`act-work`、`act-phone`、`act-music`、`act-game`、`tired`、`themes`（选择卡）、`soon-claude`（预览卡）、`quests`、`store-remote`、`store-detail`。
  - 其中 6 张复制到游戏仓库的 `games/her-room/screenshots/`，说明文字写在 `store.json`。
  - 输出 `cover.png`，用作商店封面。
- 录屏 `her-room-demo.mp4`：H.264，960×600，25 fps，约 60 秒，带鼠标指针。章节写在 `her-room-demo.chapters.json`，内容依次是：
  1. 进房间
  2. 悬停描边
  3. 睡觉
  4. 工作
  5. 看手机
  6. 听音乐
  7. 打游戏
  8. 太累了
  9. 切换房间和预览
  10. 调到夜里
  11. 关闭，她回到桌面
- 另外输出一个 GIF（400 px 宽、8 fps），截取第 3–7 章。

实现完成后，`docs/her-room.md` 写成和 mini-games.md 一样的用户文档（玩法 + 截图 + 录屏），本文作为设计记录保留。

### 7.4 验收标准（给后续实现任务）

1. 在打包后的应用里，经商店下载「她的房间」并开始玩，游戏在独立窗口里运行，不在设置窗口里。
2. 五类活动都能用鼠标开始，进行中能看到这些反馈：她走过去做动作、道具变化、计时和进度、台词气泡、数值条；能自动结束、提前结束和切换。
3. 能切换房间，五位默认角色各有一个条目；大肥鱼的房间可以玩，另外四个显示「即将开放」的预览。
4. 大肥鱼房间符合 §5：浅蓝和奶白配色，有蕾丝、蝴蝶结和鲸鱼元素，大肥鱼穿女仆装。
5. 单测、`e2e room` 和 `e2e game`（回归）都通过；`roomdocs` 生成了截图和录屏，并放进文档。

## 8. 风险与取舍

| 问题 | 决定 |
| --- | --- |
| 包能改写她的数值，安全吗 | 每类活动的数值只在顶层定义一次，有上限（±40/轮），结算只在 main 里用 main 的时钟算，所以页面没法刷数值。活动不直接加好感，好感只来自小事，每天最多 3 次 |
| game.js 拆分可能弄坏小院 | 先做一个单独的 PR：只拆文件、不改行为，e2e `game` 全绿以后再写房间引擎 |
| 背景图把家具也画进去了 | 背景只画墙和地，家具单独生成，所以可以描边、遮挡、做道具变化。如果 GPT Image 还是画了家具，加否定描述重生成，不手修 |
| 她躺进被子的效果 | 精灵旋转加上被子和床尾两层前景。动作帧还是 `sleep`，不新画躺姿；纸片人外观不躺下 |
| 平视视角和小院的等距视角不一样 | 两款游戏共用的只有外壳、天色和小事，画面是各自引擎的事。房间的一致性靠同一套主题 schema 保证 |
| 其余四个房间什么时候开放 | 本轮只写主题条目（soon）。开放时按 §6.3 只加数据，可以分别发小版本 |
| 关掉游戏后活动不再计时 | 和「她回到桌面」的心智一致，也不需要 main 里一直有个后台计时器 |
| 窗外天色的工作量 | 是加分项，可以放到 1.1.0，不影响五类活动的验收 |
