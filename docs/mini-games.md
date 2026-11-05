# 小游戏（像素小院）

> 商店里可以下载的小游戏，和她一起玩。第一款是「像素小院」：一座漂在空中的等距像素小院。她在院子里自己逛、做事，你可以调时段和天气，陪她完成每天的小事。
> 引擎是 PixiJS 8（`src/renderer/vendor/pixi/`），美术由 GPT Image（gpt-image-2.5）生成后切图。小游戏包只有图片和配置，下载下来的东西不会被当作代码运行。

![白天 · 晴朗](img/mini-games/day-clear.webp)

| 清晨 · 晴朗（07:00） | 黄昏 · 多云（18:00） |
| --- | --- |
| ![清晨：偏暖的晨光](img/mini-games/dawn-clear.webp) | ![黄昏多云：整体偏橙、压暗，云团飘过](img/mini-games/dusk-cloudy.webp) |
| **夜晚 · 晴朗（23:00）** | **夜晚 · 小雨（23:00）** |
| ![夜晚：蓝绿暗调，窗户、路灯和石灯亮起，萤火虫出来](img/mini-games/night-clear.webp) | ![夜雨：斜雨线、溅点、池面涟漪，灯光挖亮暖色光圈](img/mini-games/night-rain.webp) |
| **雷雨（15:00）** | **下雪（10:00）** |
| ![雷雨：更暗更密的雨，偶尔闪电](img/mini-games/storm.webp) | ![下雪：冷色、去饱和，雪花飘落](img/mini-games/snow.webp) |
| **起雾（08:00）** | **今日小事** |
| ![起雾：雾气缓缓飘过](img/mini-games/fog.webp) | ![今日小事卡片：三件小事、完成打勾、收集到的东西](img/mini-games/quests.webp) |

她在做事：

| 浇菜 | 菜熟了（再点一次收菜） | 坐长椅 | 夜里拍路灯 | 抓萤火虫 |
| --- | --- | --- | --- | --- |
| ![浇菜](img/mini-games/act-water.webp) | ![菜熟了](img/mini-games/act-ripe.webp) | ![坐长椅](img/mini-games/act-bench.webp) | ![拍路灯](img/mini-games/act-lamp.webp) | ![抓萤火虫](img/mini-games/act-firefly.webp) |

商店 → 小游戏（下载前 / 下载后）：

| 未下载 | 已下载 |
| --- | --- |
| ![商店：像素小院未下载](img/mini-games/store-remote.webp) | ![商店：像素小院已下载，可以开始玩](img/mini-games/store-installed.webp) |

### 录屏

[`img/mini-games/mini-game-demo.mp4`](img/mini-games/mini-game-demo.mp4)：H.264，960×600，25 fps，约 55 秒，带鼠标指针，章节时间点见 [`mini-game-demo.chapters.json`](img/mini-games/mini-game-demo.chapters.json)。内容依次是：
1. 她自己逛。
2. 点空地（插一面小旗），她走过去。
3. 点她，她头上冒台词。
4. 点菜地，她去浇水。
5. 拖时间滑块从 09:00 到 22:00，天色转暗，窗户和路灯亮起，萤火虫出来。
6. 用天气 › 依次切到多云、小雨、雷雨、下雪。
7. 夜里点萤火虫，她跑过去扑。
8. 回到清晨。

下面的 GIF 是其中拖时间滑块入夜、依次换天气的约 22 秒（400 px 宽、8 fps）：

![小游戏录屏](img/mini-games/mini-game-demo.gif)

图（WebP）和录屏由 `node e2e/run.js gamedocs` 在真实应用里生成：Playwright 用真实鼠标点画布和卡片，同时用 ffmpeg x11grab 录下 Xvfb 屏幕上游戏窗口所在的区域。

---

## 1. 参考与取舍

参考是 Daniil Ch.（@daniildesigns）2026-11-03 的帖子 <https://x.com/daniildesigns/status/2117571497665663044>。帖子是一段 12 秒的视频，内容是作者在做的第一款游戏：一块斜俯视的浮岛小院，下方中央有一张磨砂的「A changing sky」卡片，可以切时段（Morning / Daytime / Sunset / Night）和天气（Clear skies / Cloudy / Gentle rain）。视频是通过公开的 fxtwitter 镜像接口拿到的，逐帧看过；它的版权归原作者，素材不进仓库。

| 向视频看齐 | 不照搬 |
| --- | --- |
| 小模型式的等距浮岛：草地顶面、土石侧壁、瀑布从边上落下 | 原作的地图布局、建筑造型、配色数值 |
| 画面由密集的像素美术组成，人物很小，世界是主角 | 原作的美术：本项目全部由 GPT Image 重新生成 |
| 时段靠整体调色变化：清晨偏暖，白天最饱和，黄昏偏橙并压暗，夜晚蓝绿暗调、亮度降到约 40% | 「A changing sky」的英文文案（本项目是中文：天色、随时间流动、天气自己变） |
| 夜里窗户和路灯亮起一圈一圈的暖色光晕，草丛里有萤火虫 | — |
| 不透明的像素云飘过；细斜雨线；切换时平滑过渡，不是硬切 | — |
| 下方中央的磨砂卡片分左右两栏，每栏一个抖动像素大图标、`‹ 名称 ›` 和一个开关，底部一行「一天 24 分钟」；卡片下面一条小工具栏 | 工具栏的具体按钮（本项目是：今日小事、跟随她、缩小、放大、天色、对齐本机时间） |

另外加了视频里没有的东西：下雪、雷雨、起雾，她和物件的互动，每日小事和好感。

## 2. 打开与关闭

小游戏在独立窗口里玩（960×600，可以调大小）。打开时桌面上的她隐藏、进到游戏里；关掉后她回到桌面原来的位置。

| 入口 | 操作 |
| --- | --- |
| 商店 | ⚙ 设置 → 商店 → **小游戏** → 下载 → **开始玩** |
| 托盘 | 「小游戏」（再点一次关闭） |
| 她的面板 | 右键她 → 底栏 ⌂ |
| 快捷键 | 桌宠窗口有焦点时按 `Ctrl/⌘ + Shift + H` |

- 托盘、面板 ⌂ 和快捷键打开的是上次玩的游戏（`settings.scene.game`），没有记录时打开第一个已下载的。
- 一个都没下载时，这三个入口会打开 **商店 → 小游戏**。
- 关闭方式：右上角 ✕、`Ctrl/⌘ + W`、再按一次 `Ctrl/⌘ + Shift + H`、托盘再点一次。任何需要桌面上的她的操作也会先关掉游戏，比如托盘「显示桌宠」、语音快捷键。

## 3. 怎么玩

| 操作 | 结果 |
| --- | --- |
| 点空地 | 插一面小旗，她沿寻路走过去（绕开房子、树、池塘和菜地） |
| 点物件（悬停时描白边，指针旁有提示） | 她走过去用它，见下表 |
| 点她 | 开心一下，冒台词；走一次桌宠的「摸摸」（好感规则不变） |
| 按住她拖动 | 拎起，松手落到最近能走的地方 |
| 点萤火虫（夜里） | 她跑过去扑，抓到算收集一只 |
| 拖动画面 / 滚轮 / ＋ － | 平移、缩放；⌖ 让镜头重新跟着她 |
| `Esc` | 收起 / 展开天色卡片 |

| 物件 | 她做什么 | 结果 |
| --- | --- | --- |
| 菜地（两块：卷心菜、胡萝卜） | 拎着水壶浇水（`play`） | 每浇一次长一档，三档就熟了（菜地提示变成「收菜」）；再点一次收下，收集到一颗卷心菜或一根胡萝卜。下雨时每 60 秒自己长一档 |
| 长椅 | 坐 18–36 秒（只露上半身）；夜里会打盹 | — |
| 路灯 | 走过去拍一下（`pat`） | 开 / 关，闪两下；手动的开关保持到下一次天黑或天亮 |
| 浆果丛 | 摘浆果（`eat`） | 收集浆果；4 分钟后才长回来 |
| 池塘 | 站在岸边看（`look`） | 水面泛起涟漪 |
| 水井 / 信箱 | 打一桶水 / 看看信箱 | 一句台词 |

她自己逛的规则：设置里「自己走动」（`prefs.roam`）开着时，她每 3.5–8 秒挑一处 60–260 px 外的空地走过去；有 32% 的概率改去用一个适合当前时段的物件，比如路灯只在黄昏和夜里会去用。

她的画面都来自现有角色包里的动作：`walk`、`idle`、`play`、`pat`、`look`、`lifted`、`sleep`、`happy`、`think`、`eat_fruit`。缺的动作按 `core/fx.js` 的回落链降级，所以内置的像素角色都能进游戏；换角色或换装后，游戏里的她会立即重画。图片、Live2D、VRM 外观在游戏里显示为她的立绘「纸片人」，走路时一跳一跳。

## 4. 天色（时段与天气）

卡片在画面下方中央，像参考视频那样是磨砂玻璃。玻璃的颜色随画面变化：白天浅绿、夜晚深绿，文字一直是浅色。

- **时段**：
  - 大图标是抖动像素画的太阳或月亮，太阳会随时间升高、落到地平线。
  - `‹ ›` 在 清晨 07:00 / 白天 12:00 / 黄昏 18:00 / 夜晚 23:00 之间跳，约 1 秒平滑过渡。
  - 滑块可以在 0:00–23:45 之间连续调，每档 15 分钟。
  - **随时间流动**：一天是 24 分钟，即现实一分钟等于游戏一小时，和视频底部那行「One farm day lasts 24 minutes」一样。
  - 工具栏的 🕘 **对齐本机时间**：游戏时刻等于这台电脑的时间，优先于「随时间流动」。拖滑块或点 ‹ › 会关掉它。
- **天气**：
  - `‹ ›` 在晴朗、多云、小雨、雷雨、下雪、起雾之间切换，3 秒内淡入淡出。
  - **天气自己变**：每 3–8 分钟换一次，多半换成相邻的天气，比如多云之后下雨、雨之后雷雨。
- **画面怎么变**：
  - 整个世界加了一个颜色矩阵滤镜，参数是「时段 × 天气」，包括按通道相乘、饱和度和提亮，在关键帧之间做平滑插值，见 `core/game-sky.js`。
  - 光照层不受这个滤镜影响，用加法混合，所以夜里窗户和灯是真的「亮」的。光晕是 48 px 的阶梯径向贴图，用最近邻放大，形成参考视频里那种一圈一圈的像素光晕。
  - 投影的浓淡跟太阳高度走，方向随时间从右偏到左。
  - 云是 GPT Image 画的不透明像素云，夜里随调色变暗。
  - 雨是 1 px 的斜线加落地溅点和池面涟漪；雪是 2–4 px 的方块，左右摆动；雾是飘动的柔和雾团；雷雨会偶尔闪电。
  - 设置了「减少动态效果」时，不下雨雪、不闪电。

时段和天气保存在 `settings.json` 的 `scene` 里，所有小游戏共用。设置窗口 → 玩法 → 桌宠行为 → 小游戏里有同一组设置。

## 5. 今日小事与好感

每个游戏包列出一组小事（`quests`），每天按日期挑 3 件，一整天都是同一组，见 `core/game-quests.js`。像素小院有 9 件：
- 给菜地浇两次水
- 收一次菜
- 摘一次浆果
- 天黑后点亮路灯
- 下雨天陪她看池塘
- 在长椅上歇一会
- 抓 3 只萤火虫
- 看看信箱
- 去井边打一桶水

有的小事要先调时段或天气，比如把天气调成小雨再去看池塘，这也是玩法的一部分。

- 完成一件弹出「完成：… · 好感 +2」，她说一句话。好感来源是 `game`，每件 +2，**每天最多 3 次**，也算进每日好感总上限，见 `core/affection.js`。
- 工具栏 ☑ 打开「今日小事」卡片：打勾表示完成，`n/m` 是进度，底部列出收集到的东西（累计）。
- 进度存在 `userData/games/.progress/<id>.json`，内容包括今天的计数、累计完成数、收集到的东西，以及游戏里的状态（菜地长到第几档、路灯手动开关、浆果什么时候长回来）。更新或删除游戏包都不会影响它。

## 6. 实现

```
src/core/game-pack.js      小游戏包格式与校验（validateManifest）：数据包、引擎版本、只允许 .webp/.png/.json
src/core/game-store.js     商店 → 小游戏：解压安装（校验后原子替换）、已下载列表、删除、进度文件、商店行状态
src/core/game-world.js     可走区域：多边形 / 椭圆 → 8 px 网格；8 邻 A*（不切角）+ 拉直路径；随机散步点
src/core/game-pet.js       她的状态机：idle → walk → use（物件的动作与时长）→ idle；touch / lift / drop；自己逛
src/core/game-sky.js       天色：时段关键帧调色、天气参数与淡入淡出、颜色矩阵、随时间流动、天气自己变
src/core/game-quests.js    今日小事：按日期挑 3 件、事件匹配（物件 / 收集 / 时段 / 天气）、计数与完成
src/core/catalog.js        game-catalog.json 的读取（loadGameIndex / gameEntry / listGames）
src/core/game-catalog.json 商店里的小游戏（名字、介绍、要点、封面、大小、sha256），随应用发布
src/main/games.js          GameLibrary：已下载的游戏、game://<id>/<file>（只给 manifest 列出的文件）、进度、事件记录
src/main/game-window.js    小游戏窗口（只建一次，之后显示 / 隐藏；换游戏时带 ?game=<id> 重新载入）
src/main/game-preload.js   页面桥：boot / set / event / saveState / touch / close
src/main/main.js           入口（托盘、⌂、快捷键）、game:* IPC、商店 IPC（game-store / -download / -remove / -play）
src/renderer/game/         game.html · game.css · game.js（Pixi 场景、输入、卡片）· game-icons.js（抖动像素图标）
src/renderer/vendor/pixi/  PixiJS 8.22.0 浏览器版 + unsafe-eval 包（页面 CSP 不开 'unsafe-eval'）
admin/src/console/pages/StoreGames.tsx  商店 → 小游戏 标签页
catalog/games/pixel-yard/  像素小院的包源：manifest.json、terrain.webp、atlas.webp、sprites.json
art/pixel-yard/            提示词（prompts.json）、切图排布（layout.json）；GPT Image 原图在 CDN（README.md）
scripts/art/game_sprites.py  原图 → 包里的图片（去品红底、切成精灵、按比例缩放、打图集）
scripts/build-game-packs.js  catalog/games → out/game-catalog/<id>.zip + src/core/game-catalog.json（可复现）
```

**Pixi 场景**（`game.js`）：

```
cam            镜头：拖动平移，滚轮 / ＋ － 缩放，⌖ 跟着她（卡片打开时她保持在卡片上方）
├ graded       画出来的一切，套一个 ColorMatrixFilter（时段 × 天气）
│ ├ terrain    世界图（地形、路、菜地、池塘、瀑布）
│ ├ fall       瀑布水纹、池面闪光、涟漪
│ ├ shadows    物件和她脚下的柔和投影（随太阳变化）
│ ├ flat       花、草、菜苗：在所有站立物件下面
│ ├ sorted     站立的物件和她，按脚的 y 排序（zIndex = y）；她走到物件后面时，挡住她的物件变半透明
│ ├ outline    悬停物件的描边
│ └ sky        云
└ lights       加法混合：窗户、灯的光晕、萤火虫（不受调色影响，所以夜里是亮的）
screen         屏幕空间：雨、雪、雾、闪电
```

**流程**：
1. 页面启动时，从 `game:boot` 一次拿到：游戏的 manifest、精灵索引、`game://` 地址、她的外观、时段和天气、今日小事和游戏状态。
2. 她做完一件事，页面发 `game:event`，例如 `{ type: 'use-end', obj: 'plot-a' }`、`{ type: 'collect', item: 'berry' }`，并带上当时的时段和天气。
3. 主进程用 `GameQuests.record` 算出完成了哪些小事、写进度，对每件完成的小事调 `PetService.gameQuest()` 加好感，把结果回给页面弹提示。
4. 游戏里的状态（菜地、路灯、浆果）用 `game:state` 存到进度文件。

## 7. 小游戏包格式（engine `yard@1`）

```jsonc
{
  "schema": 1, "kind": "game", "engine": "yard@1",
  "id": "pixel-yard", "name": "像素小院", "version": "1.0.0", "description": "…", "credit": "…",
  "world": { "width": 1024, "height": 1024, "background": "#06090b" },
  "images": { "terrain": "terrain.webp", "atlas": "atlas.webp" },   // 只能是 .webp / .png
  "sprites": "sprites.json",                                         // { 名字: { x, y, w, h } }（atlas 里的位置）
  "camera": { "zoom": 1.25, "min": 0.7, "max": 3, "start": [520, 420] },
  "petHeight": 34, "spawn": [470, 300],
  "walk": { "cell": 8, "area": [[x, y]…], "blocked": [多边形 | { "cx", "cy", "rx", "ry" }…] },
  "objects": [
    { "id": "cottage", "sprite": "cottage", "x": 640, "y": 240,      // (x, y) = 脚的位置（精灵底边中点）
      "block": { "cx": 642, "cy": 206, "rx": 84, "ry": 38 },         // 挡住的地
      "lights": [{ "x": -52, "y": -66, "r": 44, "window": [-58, -76, 11, 13] }] },   // 夜里亮的光与窗
    { "id": "plot-a", "hit": [[465, 318]…], "block": […],            // 没有精灵、只有点击区域的物件
      "crops": { "kind": "cabbage", "stages": [null, "cabbage1", "cabbage2", "cabbage3"], "spots": [[x, y]…] },
      "use": { "at": [454, 334], "face": "right", "anim": "play", "seconds": [2.6, 2.6], "effect": "water", "label": "浇水" } },
    { "id": "f1", "sprite": "flowers-red", "x": 248, "y": 404, "flat": true }       // 贴地，不参与遮挡
  ],
  "fx": { "waterfall": [[x, y] ×4], "water": [多边形], "fireflies": 14, "clouds": ["cloud1", …] },
  "items": { "berry": "浆果", … },
  "quests": [{ "id": "water", "title": "给菜地浇两次水", "hint": "…", "on": { "type": "use-end", "obj": ["plot-a", "plot-b"] }, "count": 2 }],
  "lines": { "touch": ["嘿嘿", …], "use-end:bench": […], "harvest:cabbage": […], … }
}
```

- `use.anim` 可选：`idle` `sit` `play` `pat` `look` `happy` `eat` `sleep` `think` `lookAround`。
- `use.effect` 可选：`water`（种菜和收菜）、`harvest`（采集，配 `item` 和 `regrow` 秒数）、`lamp`（开关灯）、`ripple`（涟漪）、`rest`、`none`。
- `use.phases`：只在这些时段会自己去用。
- `quests[].on` 的 `type` 可以是 `use-end`、`collect`、`touch`，可以再加 `obj`、`item`、`phase`、`weather` 作为条件。

**校验**（`validateManifest` 与 `checkFolder`）：
- 文件夹里只能有 manifest 和它列出的文件，有多余的文件或子文件夹就拒绝安装。
- 文件名只允许 `.webp` / `.png` / `.json`，所以下载的包里放不进脚本。
- 引擎必须是这个应用会玩的（目前只有 `yard@1`）。
- 每个精灵名都要在 `sprites.json` 里，每件小事引用的物件都要存在。

新的小游戏如果只是换一个场景，同样的 `yard@1` 就够了：另画一套图，写一个 manifest。需要新玩法时，要在应用里加一个新的引擎版本（比如 `yard@2`）。

## 8. 美术流水线（GPT Image）

```bash
# 1. 生成：每张图一条提示词（art/pixel-yard/prompts.json，带统一的风格句：等距 2:1、硬边方像素、每种材质 3–4 档色、品红底）
lh generate image -m gpt-image-2.5-sunburst -p lobehub --param size=2048x2048 --param quality=high --json "<提示词>"
lh generate download <generationId> <asyncTaskId> -o raw/<name>.png --timeout 900
#    地形一张（黑底）、建筑 3 栋、树 9 棵、道具 16 件、菜园小物 26 件、云 5 朵；原图存成无损 WebP 放在 art/pixel-yard/raw/
#    （不进仓库，源是 CDN 上的 games-v1/pixel-yard-art.zip，取回方法见 art/pixel-yard/README.md）
# 2. 看图里有哪些精灵（去品红底、把相邻碎片并成一个、按位置列出框）
python3 scripts/art/game_sprites.py find art/pixel-yard/raw/props.webp 16
# 3. 切图：art/pixel-yard/layout.json 给每个精灵起名、定框和缩放（盒式缩放、半透明阈值、去品红边、打图集）
python3 scripts/art/game_sprites.py build art/pixel-yard/layout.json art/pixel-yard/raw catalog/games/pixel-yard
# 4. 摆放：catalog/games/pixel-yard/manifest.json 里写每个物件的位置、挡路区域、灯光和互动
```

- 需要 Pillow 和 numpy：`uv venv /tmp/artvenv && VIRTUAL_ENV=/tmp/artvenv uv pip install pillow numpy`。
- 第 3 步由原图重建，结果和包里的图片逐字节一致。
- 生成时一次一张、每张之间停 20 秒，不并行，见 `art/model-chan/README.md` 里关于批量被拒的说明。

## 9. 上架到商店

```bash
node scripts/build-game-packs.js            # catalog/games/* → out/game-catalog/<id>.zip，写 src/core/game-catalog.json
node scripts/build-game-packs.js --check    # 重新打包，和索引逐字节比对（e2e 和单测也会做）
npm run catalog:upload -- --games           # 经 Develop Center 传到 CDN（dc/ops-assets/archives/pixel-pet/games-v1/），再下载回来比对
```

- 应用从 `https://chat-cloud.lobeobjects.space/dc/ops-assets/archives/pixel-pet/games-v1/<id>.zip` 下载，按索引里的大小和 sha256 校验后再安装，见 `src/main/catalog.js` 的 `CatalogDownloader`，和角色、语音包是同一个下载器。
- 测试或镜像可以用 `PIXELPET_CATALOG_URL` 改下载地址。
- 内容变了要改 manifest 的 `version`，并换一个 release（`build-game-packs.js` 的 `RELEASE`）。已发布的文件不会被悄悄替换。
- 商店卡片的封面 `src/renderer/catalog/games/<id>.webp` 随应用发布，由 `gamedocs` 截出。
- 开发时不想下载，可以设 `PIXELPET_DEV_GAMES=1`，直接读 `catalog/games/`。这个目录不会打进安装包。

## 10. 运行与验证

```bash
npm start                                      # 先自动 build:admin；⚙ 设置 → 商店 → 小游戏 → 下载 → 开始玩
PIXELPET_DEV_GAMES=1 npm start                 # 开发：不下载，直接玩 catalog/games 里的包
npm test                                       # 单测：game-world / game-pet / game-sky / game-quests / game-store
unset ELECTRON_RUN_AS_NODE
xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js game       # 真机 e2e（G1–G13，截图在 out/e2e/mini-game/）
xvfb-run -a -s "-screen 0 1280x800x24" node e2e/run.js gamedocs   # 重新生成本文的图、录屏和商店封面
```

e2e `game` 用本地 http 服务当商店的 CDN，提供的是 `build-game-packs.js --check` 打出来的同一个 zip。它按用户的方式走一遍：
- G1：没下载时，托盘打开商店。
- G2：下载。
- G3：开始玩，确认是 WebGL 在画、帧数在走。
- G4：‹ › 走一圈四个时段，测亮度和色调、灯和萤火虫；滑块调到 18:00；随时间流动。
- G5：› 走一圈六种天气。
- G6：她自己逛。
- G7：点地面让她走过去。
- G8：浇三次菜后收菜、坐长椅、夜里拍路灯、摘浆果、抓萤火虫。
- G9：把今天的三件小事做完，每件好感 +2。
- G10：拖她。
- G11：Ctrl+W 关闭，再用 ⌂ 打开。
- G12：重启后时段、天气、菜地、小事都还在。
- G13：在商店删除。

## 11. 已知限制

- 每个物件的挡路区域是手工标的椭圆或多边形，和画面基本对齐，但不是逐像素的，所以她偶尔会贴着树干或房檐走。
- 同屏伙伴不进游戏，留在桌面上。
- 游戏里没有声音。
- 天气是整个世界一起变的，没有局部天气，也没有积雪、积水。
- 目前只有 `yard@1` 一种玩法引擎。不同玩法的游戏要先在应用里加新的引擎版本；下载的包永远不带代码。
- 在 Xvfb 软件渲染（SwiftShader）下大约 40–60 fps；有 GPU 的机器会更流畅。
