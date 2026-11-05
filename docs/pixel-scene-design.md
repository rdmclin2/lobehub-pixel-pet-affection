# 像素小院（像素风小游戏场景）· 参考分析与技术方案

> T-5549 · 分支 `feat/pixel-scene`（基于 `origin/canary` 4fcfa6a）· 2026-11-05
> 本文只做方案，不含实现。实现、使用文档和截图 / 录屏由后续任务交付。
> 文中「新增」表示仓库里还没有的文件；没有标注的路径都已在 `canary` 上存在（§8 末尾附核对命令）。

## 0. 一句话

在桌宠旁边新增一个独立的**「像素小院」窗口**：一块俯视 / 斜 45° 的像素庭院（小屋、菜地、池塘、石板路、路灯）。当前角色「回小院」后可以自己逛、走到你点的地方，也可以和物件互动（坐长椅、浇花、开关路灯）。右下角有一张「天色」卡片，可以连续调节时段、选天气，也可以跟随系统时间、让天气自己变。整套画面用 Canvas 2D 按低分辨率像素网格绘制，再整数倍放大。

---

## 1. 参考效果要点拆解

### 1.1 参考来源与获取情况

- 链接：<https://x.com/daniildesigns/status/2117571497665663044>（Daniil Ch. @daniildesigns，2026-11-03）。
- 抓取过程：用网页抓取工具（WebFetch）打开 `x.com` 链接返回 HTTP 402，拿不到内容。改用浏览器 UA 的 `curl` 能拿到 200 的页面外壳，`<title>` 里有帖子原文，但视频是前端脚本加载的，页面里没有。最后用公开的 fxtwitter 镜像接口 `api.fxtwitter.com/daniildesigns/status/2117571497665663044` 拿到了完整的帖子数据和媒体直链：
  - 帖子文字：“Working on my first game. Creating games is actually much more fun than playing them for some reason 🫣”
  - 媒体：一段 12 秒视频（2306×1974，无 alt 文本）。下载 1260×1080 档，每秒抽 1 帧共 12 帧，加上封面图逐帧看过。
- **下面的拆解来自真实视频帧，不是推断。** 视频版权归原作者，素材不进仓库（只作为验收证据附在任务里）。本项目只借鉴构图、分层和交互方式，美术自己画，不复刻原作的地图、建筑和 UI 文案。

### 1.2 视频里能看到的内容（按时间）

| 秒 | 时段 / 天气（面板上的文字） | 画面变化 |
| --- | --- | --- |
| 0–1 | Morning / Clear skies | 偏暖的亮绿，树冠高光明显，树影在地面上斜投 |
| 1–2 | Daytime / Clear skies | 最亮、饱和度最高，池水青蓝 |
| 2–3 | Sunset / Clear skies | 整体压暗、偏黄绿，面板里的太阳图标沉到地平线（只露半圆） |
| 3–5 | Night / Clear skies | 整体蓝绿暗调；屋门口路灯、窗户亮起暖黄光晕；草丛里有萤火虫光点 |
| 5–6 | Night / Cloudy | 画面上方飘过几团深灰像素云（云块本身是不透明的像素图） |
| 6–8 | Night / Gentle rain | 全屏细斜雨线（1 px 宽、3–6 px 长、浅灰半透明），云更多，画面再暗一档 |
| 8–12 | → Night / Clear → Morning → Daytime | 雨停、云散、天亮：时段切换是**平滑过渡**，不是硬切 |

### 1.3 构图

- **斜俯视的一块"浮岛"**：一块方形地块向右下斜放，四周是黑色背景；地块边缘露出泥土 / 岩石的侧壁，右下角有瀑布落下。画面像一个放在桌上的小模型，这一点很适合"桌宠的家"。
- **视觉中心在偏上方**：小屋（红瓦白墙）+ 两间木棚、门前的石板路和两块菜地，周围一圈大树把视线收回中间；左上是石阶，右下是池塘 + 木桥 + 瀑布。
- **UI 浮在画面下方中央**：一张半透明磨砂卡片「A changing sky」，左右两栏（Time of day / Weather），每栏一个大图标（太阳 / 月亮 / 云）、`‹ 名称 ›` 切换、一个开关（Follow the day / Let it change），底部一行说明 “One farm day lasts 24 minutes.”；卡片下方是一条小工具栏（音量 / 缩放 / 天色 / ⋯）。
- 角色很小（约十几像素高，在小屋门口），世界才是主角。

### 1.4 配色

- 白天：草地主色是 3–4 档绿（高光黄绿、主绿、阴影深绿、近黑的墨绿描边），树冠用"块状"高光（亮绿方块叠在主绿上），屋顶是砖红 / 橙红，石板路是米色，水是青绿 / 浅蓝。
- 整个画面用**有限色板**：同一材质只有 3–4 档明度，没有连续渐变；阴影是更深的同色相，不是黑色半透明。
- 时段变化 = 整个色板一起偏移：早晨偏暖黄，白天最饱和，黄昏偏橙黄并压暗，夜晚整体蓝绿、明度降到约 35–45%，只有灯光保持暖黄高亮。
- 面板配色跟着时段走：白天是浅绿磨砂，夜晚是深绿磨砂。

### 1.5 图层（从视频里能分辨出的）

1. 背景（地块外的纯黑 / 深色）
2. 地块侧壁与瀑布（单独动画：瀑布水纹逐帧滚动）
3. 地面（草地、石板路、菜地、池塘：池面有轻微闪烁）
4. 地面上的投影（树影、屋影：随时段改变浓淡）
5. 物件（树、房屋、木棚、篱笆、桥、石阶）：按 y 排序和角色互相遮挡
6. 角色
7. 云（在物件之上，飘动；夜里是深灰）
8. 雨（全屏最上层的粒子）
9. 光照遮罩（夜晚整体压暗 + 灯光 / 窗光"挖亮"的暖色光晕 + 萤火虫）
10. UI（面板、工具栏）

### 1.6 动效

- 时段切换：全画面色调约 0.5–1 s 平滑过渡；面板图标太阳 → 半个太阳 → 月亮。
- 天气：云从一侧慢慢飘入；雨线匀速斜落；切换时粒子逐渐增多，不是一下子铺满。
- 常驻小动画：瀑布水纹、池面闪光、萤火虫明灭漂移（夜晚）、树叶几乎不动（保持安静的氛围）。
- 交互：鼠标在场景上是"手形"光标，面板按钮有按下态。

### 1.7 我们取什么、不取什么

| 取 | 不取 |
| --- | --- |
| 小模型式的浮岛构图、y 排序遮挡、分层 | 原作的具体地图布局、建筑造型、配色数值 |
| 有限色板 + 整体色板随时段偏移 | 原作的 "A changing sky" 文案和卡片样式（我们用 `--lobe-*` 令牌和自己的中文文案） |
| 夜晚灯光挖亮 + 萤火虫、云 / 雨粒子 | 农场玩法（种植、经济）——不在本目标内 |
| "时段 + 天气"两栏卡片、跟随时间 / 自动变化两个开关 | "一天 24 分钟"的加速时钟（列入可选，见 §5.5） |

---

## 2. 挂载方式决策

### 2.1 结论：独立的「像素小院」窗口（`SceneWindow`），角色进场时桌面上的她"回家"

| 方案 | 优点 | 问题 |
| --- | --- | --- |
| **A. 独立场景窗口（选这个）** | 和桌宠窗口完全隔离：不碰 `place()` / `SIZES` / 拖拽抛掷移动窗口的逻辑；可以放大、缩放、有自己的 CSP 与渲染循环；关掉就干净 | 同一个角色在两处出现要处理（见 2.3）；多一个 BrowserWindow 的内存（约 60–90 MB） |
| B. 宠物窗口内"场景模式" | 不新增窗口，角色就是现成的那个 | 宠物窗口是 `transparent` + `alwaysOnTop` 的小窗，大小由 `petScale` 决定，走动 / 抛掷是**移动窗口本身**（`src/renderer/fx.js` `walkPet` 用 `workArea` + `moveBy`），面板 `petPanel.follow` 跟着窗口走，同屏伙伴按窗口碰撞。场景模式下这些都要分支；`src/renderer/app.js` 已有约 2700 行，风险高，回归面大 |
| C. 设置窗口（admin）里的一页 | 有 React 和 `@lobehub/ui` | 设置窗口是"偶尔调一次"的设置管理界面（`.agents/ux/product.md`），不是游戏空间；关设置窗口就没了 |

选 A 的理由：
1. **行为模型不同**：桌面上的她是"窗口在屏幕上移动"，小院里的她是"画布里一个精灵在地图坐标上移动"。硬塞进同一个窗口，两套坐标系会互相干扰；分窗口后各自独立。
2. **仓库里已有同类先例**：`src/main/pet-panel.js`（`PetPanel`：只建一次，之后显示 / 隐藏，页面在 `src/renderer/panel/`）。`SceneWindow` 照这个结构写，main 里只多几行接线。
3. **可测**：e2e 用 Playwright 的 `app.windows()` 找到小院页面，直接截图和取状态，不影响现有宠物窗口相关的 70 多个场景。

### 2.2 窗口参数

- `new BrowserWindow({ width: 960, height: 600, minWidth: 640, minHeight: 400, frame: false, transparent: false, backgroundColor: '#0b0f0c', resizable: true, alwaysOnTop: false, skipTaskbar: false, title: '像素小院' })`，内容是 `src/renderer/scene/scene.html`，preload 是 `src/main/scene-preload.js`（`contextIsolation: true`, `nodeIntegration: false`，与 `preload.js` 一致）。
- 自绘一条细标题栏（拖动区 `-webkit-app-region: drag`、关闭按钮）。窗口大小变化时重算整数缩放（§3.2）。
- 记住上次的位置 / 大小（`scene.bounds`，§7）。

### 2.3 同一个角色不同时出现在两处

- 打开小院：先给宠物窗口发 `scene-enter`（她在桌面上播一下 `happy` + 「我回小院啦」气泡，约 600 ms），然后 `win.hide()`，再显示小院窗口。她的面板（`petPanel`）因为 `hide` 事件自动关闭（`main.js` 已有 `win.on('hide', …petPanel.close)`）。
- 关闭小院（关闭按钮 / `Ctrl/⌘+W` / 托盘再点一次）：先隐藏小院，再 `showPet()`。她回到桌面原位置。
- 小院开着时，**任何需要桌面上的她的入口都先关小院**：托盘「显示桌宠」、语音快捷键 `onVoiceHotkey`、对外接口的 `/say` `/chat` `/anim` 等。实现方式是 `showPet()` 里加一行 `if (scene && scene.visible) scene.close('pet-needed')`，因为这些入口都已经调用 `showPet()`。
- 同屏伙伴（visitors）照常留在桌面上，不进小院（非目标，§9）。
- 主动搭话 / 好感 / 饥饿这些状态在 main 的 `PetService` 里，与窗口无关，小院开着时照常计时。小院里点她 = 摸摸（走同一个 `touch` IPC，好感规则不变）。

### 2.4 入口

| 入口 | 做法 | 理由 |
| --- | --- | --- |
| **托盘菜单**「像素小院」（新增一项，放在「显示桌宠」下面） | `createTray()` 的 `Menu.buildFromTemplate` 加 `{ label: '像素小院', click: () => toggleScene('tray') }` | 托盘是"找回她"的入口（main.js 注释 §5.3），找家也放这里；无托盘的桌面还有下面两条路 |
| **她的面板**（右键她）加一个「回小院」图块 | `src/renderer/panel/panel.html` 的 `.pp-tile` 区加 `data-act="scene"`；`app.js runAct` 加 `else if (act === 'scene') window.pet.openScene('panel')` | 和喂食 / 玩耍 / 睡觉同级，是"和她一起做的事"，离她最近 |
| **宠物窗口聚焦时的快捷键** `Ctrl/⌘ + Shift + H`（Home） | 在 `createWindow()` 的 `before-input-event` 里加，和现有 `Ctrl/⌘+,`、`Ctrl/⌘+Shift+R` 同一写法 | 沿用"不注册全局快捷键、不和别的应用冲突"的现有约定；小院窗口里同一组合键关闭小院 |
| **设置窗口 → 玩法 → 陪伴方式 → 像素小院**（新页 `scene`） | 页头一个「打开小院」主按钮 + 时段 / 天气默认值的表单 | 设置窗口是全部可配置项的总目录（`src/core/admin-coverage.js` 要求每个托盘项和设置都能在设置窗口里找到） |
| 对外接口 `POST /pixel-pet/scene {"open":true}` 与 `{"time":18.5,"weather":"rain"}`（可选） | `src/core/api.js` ROUTES 加一行 | 方便脚本和 e2e 驱动；不做也不影响主流程 |

---

## 3. 渲染方案

### 3.1 技术选型：Canvas 2D，逻辑分辨率 + 离屏图层

- 现有像素 sprite 已经用 Canvas 2D 绘制（`src/renderer/app.js` `drawSprite`：`ctx.drawImage` 从精灵图切帧），`style.css` 第 23 行全局设了 `canvas { image-rendering: pixelated }`。小院也用 Canvas 2D，不引入 WebGL / Pixi（`rig.js` 用 WebGL 是因为要做网格变形，小院不需要；在 xvfb 的软件渲染下 2D 也更稳）。
- **逻辑分辨率固定为 320 × 200 像素**（世界坐标 = 逻辑像素，1 tile = 16 px，地图 20 × 12.5 tile；地块本身 16 × 10 tile 居中，外围是背景和侧壁）。所有图层都画在逻辑尺寸的离屏 canvas 上，最后一次 `drawImage` 整数倍放大到屏幕 canvas。
- 每层绘制时都把坐标取整（`Math.round`），保证像素对齐，不产生亚像素模糊；`ctx.imageSmoothingEnabled = false`。

### 3.2 整数缩放

```
scale = max(1, floor(min(innerWidth * dpr / 320, innerHeight * dpr / 200)))
canvas.width = 320 * scale; canvas.height = 200 * scale   // 物理像素
canvas.style.width = canvas.width / dpr + 'px'             // CSS 像素
居中，四周留黑边（letterbox），黑边与地块外的背景同色，看不出边界
```

- 960×600 的默认窗口在 dpr=1 时 scale=3，dpr=2 时 scale=6。
- 窗口拖到非整数比例时只留黑边，不做非整数缩放（会出现粗细不一的像素）。
- 鼠标坐标换算：`wx = floor((clientX * dpr - offsetX) / scale)`，用于点击目标点、悬停物件高亮。

### 3.3 图层（从下到上）与每层画什么

| # | 图层 | 内容 | 更新频率 | 实现 |
| --- | --- | --- | --- | --- |
| L0 | 天空 / 背景 | 地块外的背景，按时段做 2–3 段**色带**（不是平滑渐变：每段一个色板色 + 4×4 Bayer 抖动过渡），夜晚加几颗闪烁星点 | 时段变化时重画（缓存） | `scene-sky` 离屏 canvas |
| L1 | 远景 | 地块侧壁（泥土 / 岩石 3 档色）、瀑布（4 帧水纹循环，8 fps）、远处树影剪影 | 静态 + 瀑布帧 | 静态部分缓存，瀑布单独 |
| L2 | 地面 | 草地 tile（4 种变体随机铺）、石板路、菜地、池塘（2 帧闪光，2 fps）、花丛 | 静态（缓存）+ 池面帧 | tile 表 + `scene-map.js` 的地图数据 |
| L3 | 投影 | 物件和角色的椭圆 / 形状投影，`globalAlpha` 和偏移方向随时段（太阳角度）变化，雨天、夜晚变淡 | 时段变化时 | 单独离屏层，`multiply` 叠到地面 |
| L4 | 道具 | 小屋、木棚、树、长椅、花坛、路灯、篱笆、桥；**与 L5 一起按"脚点 y"排序**绘制，角色走到树后会被遮住 | 每帧（排序） | 每个物件一张预渲染位图 + 锚点 |
| L5 | 宠物 | 当前角色的缩小精灵（§4.5）；朝向镜像；走路 / 坐下 / 浇水动作 | 每帧 | 和 L4 一起 y 排序 |
| L6 | 天气 | 云团（像素云位图，视差慢飘）、雨线、雪片、雾带、闪电白闪 | 每帧 | 粒子池（§6） |
| L7 | 光照遮罩 | 整体环境色（`multiply`）+ 光源挖亮（`screen` / `lighter` 叠暖色光晕）+ 萤火虫 | 每帧（光源闪烁） | 离屏 `light` canvas，§5.3 |
| L8 | 交互提示 | 悬停物件的 1 px 描边、目标点的小旗、可互动物件头上的「!」 | 每帧 | 逻辑分辨率内绘制 |
| UI | DOM | 「天色」卡片、工具栏、标题栏、气泡 | 事件驱动 | HTML + `--lobe-*` 令牌，不画进 canvas |

- 雨和雪画在光照**之前**：雨线在夜里也会被压暗，更自然；萤火虫和灯光画在光照**之后**或用 `lighter`，保持发亮。
- 帧循环：`requestAnimationFrame`，逻辑更新固定步长 1/30 s（累加器），绘制跟随 rAF；窗口隐藏 / 最小化（`document.hidden`）时停循环。`prefers-reduced-motion` 时粒子数量减半、关闭闪电白闪。

### 3.4 美术资源

- **自己画，代码可生成**：v1 的 tile 和物件放在 `src/renderer/scene/art/`（新增）：一张 16 px 网格的 `tiles.png` 和 `props.png`，配一个 `atlas.json`（`{ "grass0": [x, y, w, h], …, "house": { "box": […], "foot": [x, y] } }`）。画不出来之前，`scene-art.js` 用调色板 + 字符画（每个物件一个字符串数组，一个字符对应一个色板色）在启动时生成同样的 atlas，保证先能跑起来。
- 色板固定为一张 32 色表（`src/core/scene-time.js` 导出 `PALETTE`），所有美术只用色板色，时段调色作用在色板上（§5.3），所以白天 / 夜晚不需要两套图。
- 许可：自绘素材按仓库 `LICENSE` / `NOTICE.md` 署名，不使用参考视频里的任何像素。

---

## 4. 桌宠在场景中的行为

### 4.1 地图与可走区域

`src/core/scene-map.js`（新增，纯函数，可单测）描述地图：

```js
{
  tile: 16, cols: 20, rows: 13,
  walk: [ '....####....', … ],          // 每格一个字符：. 可走  # 不可走  ~ 水  = 桥（可走）
  props: [
    { id: 'house', kind: 'house', tile: [9, 3], foot: [10, 5], solid: [[9,3],[12,5]] },
    { id: 'bench', kind: 'bench', tile: [5, 7], spot: [5, 8], face: 'right', act: 'sit' },
    { id: 'flowers', kind: 'flowerbed', tile: [12, 8], spot: [11, 8], face: 'right', act: 'water' },
    { id: 'lamp', kind: 'lamp', tile: [8, 6], spot: [8, 7], face: 'left', act: 'lamp', light: { r: 28, color: 'lampWarm' } },
    { id: 'pond', kind: 'pond', … , spot: [15, 9], act: 'look' },   // 可选第 4 种：看鱼
  ],
}
```

- 寻路：4 邻接 A*（`findPath(map, from, to)`），16 × 13 的网格每次寻路在 1 ms 以内；路径再做"拐角平滑"（直线可达的中间点去掉），角色沿折线以 **24 px/s**（1.5 tile/s）匀速走。
- 点到不可走的格子：取离点击点最近的可走格（BFS 一圈圈找）。

### 4.2 行为状态机

`src/core/scene-pet.js`（新增，纯逻辑，时间由调用方传入，可单测）：

```
idle ──(4–9 s 随机)──▶ wander（随机挑 3–6 格外的可走格，或 30% 概率挑一个物件去互动）
idle/wander ──(用户点地面 / 拖她放下)──▶ goto(target) ──到达──▶ idle
任意（非 lifted）──(用户点物件)──▶ goto(spot) ──到达、转向 face──▶ interact(act) ──结束──▶ idle
任意 ──(按住她拖动)──▶ lifted ──松手──▶ 落在最近可走格 ──▶ idle（落地播 pat）
任意 ──(点她)──▶ 原地播一次点击反应（core/fx.js pickClickReaction）+ IPC touch
```

- **自主游走**：沿用桌面上"空闲时偶尔走几步"的节奏和开关：设置里「自己走动」（`prefs.roam`）关闭时，小院里也只待着不动，只在用户点了以后才走。间隔、权重参考 `src/core/fx.js` 的 `IDLE_CUES` / `idleDelay`：小院里把 `walk` 权重提高（小院就是给她逛的），`look` / `turn` / `play` 原样保留。
- **点击 / 拖拽目标点移动**：
  - 单击空地：插一面小旗（L8），她走过去，到达后小旗消失。
  - 按住她拖动：她进入 `lifted`（播 `lifted` 动作，跟手），松手后落到最近可走格；这与桌面上的拖拽是同一个手感，但是在画布里，不移动窗口。
  - 拖动空地上的小旗：更新目标点（走到一半也能改）。
- **与场景物件交互（v1 做 3 种，至少 2 种必须完成）**：

| 物件 | 动作 `act` | 她做什么 | 场景反馈 | 用到的现有动作帧 |
| --- | --- | --- | --- | --- |
| 长椅 | `sit` 坐下 | 走到长椅前，转身，坐在长椅上（脚点上移 4 px，画在长椅之上），一直坐到你点别处或 20–40 s 后自己起来 | 夜晚坐着时偶尔冒「💤」并播 `sleep` | `idle`（坐姿用裁掉下半身 + 下移实现，见 4.5）；久坐 → `sleep` |
| 花坛 | `water` 浇花 | 走到花坛边，面朝花坛，播 2.5 s 浇水 | 洒水壶小物件画在她手边；花坛从"蔫"（暗色 tile）变"开"（亮色 + 2 帧花朵摇摆），持续 10 分钟真实时间；雨天自动算"浇过了" | `play`（没有 `play` 回落到 `happy`，按 `Fx.resolveAction`） |
| 路灯 | `lamp` 开关灯 | 走到灯下，抬头，开 / 关 | 灯的光源（L7）开或关，有 150 ms 闪两下的开灯效果；默认"自动"（天黑自动亮），手动开关后保持到下一次天亮 / 天黑切换 | `pat`（像伸手拍一下），回落 `happy` |
| （可选）池塘 | `look` 看鱼 | 站在岸边看水 | 池面泛起 1 圈涟漪 | `look` |

- 交互完成后给 main 发 `scene-act`，`PetService` 记一条"互动"（与喂食 / 玩耍同一个计数，按每日好感上限 `affectionRules.dailyCap` 封顶，不额外开新的好感来源），她偶尔说一句离线台词（复用 `src/core/dialogue.js` 的气泡，台词放在角色文件之外的场景台词表，不调用模型）。

### 4.3 交互输入映射（小院窗口内）

| 输入 | 结果 |
| --- | --- |
| 单击空地 | 走到那里 |
| 单击物件（悬停时描边 + 指针变手形） | 走过去并互动 |
| 单击她 | 点击反应（摸摸，走 `touch` IPC） |
| 按住她拖动 | 拎起 → 放下 |
| 双击她 | 打开桌宠聊天？**不做**（聊天留在桌面上的她，§9） |
| `Esc` | 收起「天色」卡片；再按一次不关窗口 |
| `Ctrl/⌘ + Shift + H` / `Ctrl/⌘ + W` | 关闭小院，她回桌面 |

### 4.4 与 `src/core/fx.js` 状态词表的关系

小院不新增状态名。她在小院里的所有画面都是 `STATES` 里已有的名字：`walk`（走）、`idle`（站 / 坐）、`play`（浇花）、`pat`（开灯）、`look`（看鱼）、`lifted`（被拎起）、`sleep`（坐着睡着）、`happy`（到达 / 互动完）。这样任何角色包都能进小院，不需要美术为小院加新动作。缺的动作按 `Fx.resolveAction(state, has)` 的回落链降级，与桌面上一致。

### 4.5 复用现有宠物帧动画的方式

现有角色的外观（`service.view().look`）有几种 `kind`，处理方式：

| look.kind | 内置 / 例子 | 小院里怎么画 |
| --- | --- | --- |
| `sprites`（5 个内置像素包 `src/renderer/packs/<id>-pixel/`；旧版像素包） | 帧 664×904，`pixelated: false`，4 列 × 9 行，每个状态 2 帧，第 9 行是 4 帧 `walk`（朝右，5 fps）；旧版像素包 83×113 硬像素 | **主路径**。小院 preload 通过新 IPC `scene-boot` 拿到和宠物窗口一样的 `look`（`url`、`frame`、`actions`、`outfits` 已按衣柜解析好）。启动时把精灵图的每一帧**预缩放**成"小院尺寸"：目标高 **40 逻辑 px**（约 2.5 tile），宽按比例；用 2 步缩放（先 `imageSmoothingQuality='high'` 缩到 4×，再缩到 1× 并对 alpha 做 50% 阈值，去掉半透明毛边），结果是硬边像素小人，跟场景画风一致。缓存为一张"迷你精灵图"（`OffscreenCanvas`，4 × 9 × 30×40 px，约 1 MB 以内），之后每帧按 `actions[state]` 的 `row/col/frames/fps` 切帧，和 `app.js drawSprite` 同一套帧选择规则（`floor(t * fps) % frames`） |
| 同上 · 坐下 | — | 没有坐姿帧：用 `idle` 帧，只画到腰线（`halfBody.waist`，内置包 0.52，见 `src/core/framing.js`），整体下移到长椅座面，腿被长椅挡住，看起来就是坐着 |
| 朝向 | — | 画成朝右；朝左时 `ctx.scale(-1, 1)` 镜像；`character.json` 的 `fx.noMirror` 里的状态不镜像（与桌面一致） |
| `pictures` / `rig`（全动态）/ `live2d` / `vrm`、大肥鱼的视频 clips | 下载包 | v1 统一用她的**头像 / 立绘图**（`look.portrait` 或包里的 `avatar.webp`）同样预缩放成 40 px 高的"纸片人"，走路时上下 1 px 的跳动 + 左右镜像（与 `FALLBACK.walk` 的"idle 跳着走"同一思路）。动作状态用头顶 emoji 提示（`Fx.OVERLAY`）。不在小院里跑 WebGL / VRM（§9） |

- 精灵图通过已有的 `pack:` 协议加载（`src/main/packs.js` 注册），小院页面与宠物窗口同源，不复制文件。
- 换装 / 换角色时 main 广播 `settings`/`view`，小院收到后重新预缩放（约 50–150 ms，一次性）。

---

## 5. 时间系统

### 5.1 时间模型

- 场景时间 `t` 是 **0–24 的连续小时数**（浮点，例如 18.5 = 18:30）。
- 两种来源：
  - **跟随系统时间**（开关「跟随时间」，默认开）：`t = 本地时 + 分/60 + 秒/3600`，每 10 s 更新一次（过渡由 5.3 的插值自然平滑）。
  - **手动**：拖动滑块后自动关闭「跟随时间」，`t` 固定在滑块值；再打开开关立即跳回系统时间（1 s 过渡）。
- 四个具名时段（滑块下方的 4 个刻度 chip，点一下跳到该时段的代表时刻）：

| 时段 | 名称 | 区间（小时） | chip 跳转值 | 图标 |
| --- | --- | --- | --- | --- |
| dawn | 黎明 | 4.5 – 7.5 | 6.0 | 半个太阳（升） |
| day | 白天 | 7.5 – 16.5 | 12.0 | 太阳 |
| dusk | 黄昏 | 16.5 – 19.5 | 18.0 | 半个太阳（落） |
| night | 夜晚 | 19.5 – 4.5（跨零点） | 23.0 | 月亮 |

- `phaseOf(t)` 返回名称；与 `src/core/time-context.js` 的九段口语时段（清晨 / 傍晚 …）互不替代：那张表给对话用，这张表给画面用。

### 5.2 关键帧

`src/core/scene-time.js`（新增）定义 6 个关键帧（时刻 → 光照参数），中间连续插值：

| 时刻 | skyTop | skyBottom | ambient（乘色） | ambientK | shadowAlpha | sunAngle | lights |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0:00 | `#0b1426` | `#15233a` | `#3a4f7a` | 0.62 | 0.10 | — | 1 |
| 5:30 | `#2b2d55` | `#c9796b` | `#8a7aa8` | 0.40 | 0.15 | 200° | 0.6 |
| 7:30 | `#7fb8e0` | `#f4d9a6` | `#ffe6c4` | 0.12 | 0.30 | 210° | 0 |
| 12:00 | `#6fb6ff` | `#bfe3ff` | `#ffffff` | 0.00 | 0.35 | 270° | 0 |
| 17:30 | `#ff9a5c` | `#ffd08a` | `#ffb27a` | 0.22 | 0.30 | 330° | 0.2 |
| 19:30 | `#3a2f5c` | `#7a4a6a` | `#6a5a96` | 0.48 | 0.15 | — | 0.9 |

- `ambient` 和 `ambientK`：光照层先用 `ambient` 色以强度 `ambientK` 做 `multiply`（`ambientK=0` 等于不变，白天原色）。
- `lights`：光源（路灯、窗户、萤火虫）的总亮度系数 0–1。路灯在「自动」模式下 `lights > 0.5` 时亮。
- 数值是起点，美术调完后以 `scene-time.js` 为准；单测只断言单调性和边界，不锁具体色值。

### 5.3 插值规则

1. **找区间**：在关键帧环（24 h 循环，23:59 与 0:00 相接）里找 `t` 两侧的 `k0, k1`，`u = (t - k0.t) / (k1.t - k0.t)`（跨零点时 +24 处理）。
2. **缓动**：`u' = smoothstep(u)`（`u²(3−2u)`），关键帧附近停留更久，过渡集中在中段，看起来更像"天慢慢亮"。
3. **颜色插值在线性 RGB 里做**：sRGB → 线性 → `lerp` → sRGB，避免中间色发灰；标量（`ambientK`、`shadowAlpha`、`lights`）直接线性插值。
4. **量化**：插出来的连续色**不直接上屏**。天空色带的两色之间用 4×4 Bayer 抖动混合；`ambient` 乘色在作用到画面之前取 **8 档**量化（`round(k*8)/8`），所以拖动滑块时画面是一档一档变的，保持像素画的"有限色"质感，不会出现平滑的电子感渐变。
5. **过渡时长**：时段 / 天气参数的变化不立刻生效，经过一阶趋近 `cur += (target - cur) * (1 - exp(-dt / 0.6s))`；手动拖滑块时用 0.15 s 让手感跟手，chip 跳转和"跟随时间"重新打开时用 1 s。
6. **光照遮罩合成**（每帧）：
   ```
   light.clear()
   light.fill(ambient, alpha=ambientK)                       // 整体压暗 / 偏色
   for each 光源 s (lamp, window, firefly):                   // 光源亮度 = lights × s.on × 闪烁
     light.globalCompositeOperation = 'destination-out'
     画量化半径的同心圆环（3 圈，半径 r, 0.66r, 0.33r，alpha 0.35/0.6/0.9）  // 挖掉暗色 = 那里恢复原色
   main.globalCompositeOperation = 'multiply'; drawImage(light)
   main.globalCompositeOperation = 'lighter'; 以 s.color 低 alpha 再画一遍光晕 // 暖色溢光
   ```
   光晕用同心环而不是径向渐变，边缘是一圈一圈的像素台阶，这是参考里夜景灯光的样子。
7. **投影**：`shadowAlpha` 控制 L3 的浓淡，`sunAngle` 决定投影方向（每 15° 量化一档），夜晚没有太阳投影，只有灯下的小投影。

### 5.4 「天色」卡片 UI（DOM，`--lobe-*` 令牌）

- 左栏「时段」：大图标、当前时段名 + 时刻（例如「黄昏 · 18:12」）、`‹ ›` 按钮（上 / 下一个时段）、**连续滑块 0–24**（步长 0.25 h，刻度标 4 个时段），开关「跟随时间」。
- 右栏「天气」：大图标、天气名、`‹ ›`、开关「天气自己变」。
- 卡片底部一行说明（例如「跟随时间时，小院和你这里的时间同步」）。
- 卡片可收起成工具栏上的一个按钮；收起状态写进设置（§7）。
- 遵循项目的 lobe-design 约定：桌宠侧原生页面用 `src/renderer/design/lobe-tokens.css` 的令牌，改完跑 `lint-lobe.mjs`；卡片的明暗跟随场景时段（白天浅、夜晚深），而不是跟随系统主题，这一条是场景美术的一部分，实现时在 `.agents/ux/product.md` 的 lint 放行里补一条 `src/renderer/scene/**` 并写明理由。

### 5.5 可选：加速时钟

参考里有 "One farm day lasts 24 minutes"。可选做一个「时间流速」：`1×`（真实）/ `60×`（24 分钟一天）。默认 1×；它只在关闭「跟随时间」时可选。列为 v1 的可选项，不影响验收。

---

## 6. 天气系统

### 6.1 天气列表与参数

`src/core/scene-weather.js`（新增，纯数据 + 纯函数）：

| id | 名称 | 云 | 粒子 | 色调（叠在时段光照之上） | 其他 |
| --- | --- | --- | --- | --- | --- |
| `clear` | 晴 | 0–1 朵白云，慢飘（4 px/s） | 无；夜晚萤火虫 12 只 | 不变 | 投影正常 |
| `cloudy` | 多云 | 4–6 朵，两层视差（3 / 6 px/s），白天浅灰白、夜晚深灰蓝 | 无；夜晚萤火虫 6 只 | `ambientK += 0.10`，饱和度 −15%（乘色偏灰 `#c8ccd4`） | 投影 alpha ×0.5；云影：每朵云在地面投一块慢移的淡影 |
| `rain` | 小雨 | 6–8 朵深灰 | 雨线 **160 根 / 屏**：长 4–6 px、宽 1 px，速度 180 px/s，角度 12°（向左下），颜色 `#a8b8c8` alpha 0.55；落到地面的 30% 产生 2 帧"溅点"（3 px 十字） | `ambientK += 0.18`，偏蓝 `#9aa8c0` | 池面每秒 6 个涟漪；花坛视为已浇水；萤火虫 0 |
| `snow` | 雪 | 4–6 朵浅灰 | 雪片 **120 片 / 屏**：1×1 或 2×2 px，速度 18–30 px/s，水平正弦漂移（振幅 4 px，周期 2–4 s），白 `#f4f8ff` | `ambientK += 0.06`，偏冷 `#dfe8f5` | 地面积雪：10 分钟内逐渐把草地 tile 的高光档换成白色（覆盖层 alpha 0→0.6）；停雪后 10 分钟化掉 |
| `storm`（可选） | 雷雨 | 8–10 朵近黑 | 雨线 260 根，速度 260 px/s，角度 20° | `ambientK += 0.28` | 闪电：每 6–18 s 一次，2 帧全屏白（alpha 0.7 → 0.3，共 120 ms），之后整体亮 1 档 300 ms；`prefers-reduced-motion` 时不闪 |
| `fog`（可选） | 雾 | 无 | 3 条横向雾带（半透明 `#dfe6e8` 的长矩形 + Bayer 抖动边），各自 2–5 px/s 平移 | `ambientK += 0.05`，对比度降低：叠一层 alpha 0.25 的雾色 | 远景（L1）额外叠 0.4 雾色 |

- "粒子数 / 屏"按 320×200 的逻辑分辨率计算，与窗口实际大小无关，所以性能稳定（最多约 300 个粒子 × 每帧 1 个 `fillRect`）。
- 粒子坐标都是逻辑像素，取整后绘制；雨线用 `fillRect` 画成阶梯斜线（逐像素，不用 `lineTo`），保持硬边。

### 6.2 切换与"天气自己变"

- 切换天气时：旧天气的强度 1 → 0、新天气 0 → 1，各用 3 s；粒子生成率 = 基础速率 × 强度，云从画面边缘飘入 / 飘出，不会凭空出现。色调参数按强度在两个天气之间线性混合，再叠加时段光照。
- **天气自己变**（开关，默认关）：每 8–20 分钟（真实时间）按马尔可夫转移表换一次：

| 从 \ 到 | clear | cloudy | rain | snow | storm | fog |
| --- | --- | --- | --- | --- | --- | --- |
| clear | 0.55 | 0.30 | 0.05 | 0.03 | 0 | 0.07 |
| cloudy | 0.30 | 0.35 | 0.20 | 0.07 | 0.03 | 0.05 |
| rain | 0.10 | 0.40 | 0.35 | 0 | 0.15 | 0 |
| snow | 0.15 | 0.35 | 0 | 0.50 | 0 | 0 |
| storm | 0 | 0.30 | 0.70 | 0 | 0 | 0 |
| fog | 0.50 | 0.40 | 0 | 0 | 0 | 0.10 |

  `snow` 只在 11–2 月出现（按系统月份；其他月份把 snow 的概率并入 cloudy），黎明更容易起雾。随机数生成器可注入，方便单测。
- 手动选一个天气会关闭「天气自己变」，与时间滑块关闭「跟随时间」是同一个逻辑。

---

## 7. 设置持久化

### 7.1 结论：接入 `settings.json`（`src/core/settings.js` + `src/core/settings-schema.js`），新增一个 `scene` 分组

理由：
- 这些都是"主人的偏好"，和 `prefs.roam`、`ui.theme` 性质一样，应当跨重启保留，并且能在设置窗口里找到。`test/admin-coverage.test.js`、`test/settings.test.js` 会检查 `normalizeSettings(null)` 的每一个叶子都有 schema 字段（或者列为内部标记），所以**必须**同时改两处，不能自己另存一个文件。
- 走现有通道：设置窗口写 → main 校验（schema `validate`）→ `service.on('settings')` 广播 `settings` → 小院页面 `onSettings` 收到后应用。小院窗口自己改（拖滑块）时调用新的 `scene-set` IPC，main 校验后落盘再广播，设置窗口那边同步显示。

### 7.2 字段

`src/core/settings.js` 新增：

```js
const SCENE = { followClock: true, hour: 12, weather: 'clear', autoWeather: false, panelOpen: true, bounds: null };
const SCENE_WEATHERS = ['clear', 'cloudy', 'rain', 'snow', 'storm', 'fog'];
function normalizeScene(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const hour = Number.isFinite(s.hour) ? ((s.hour % 24) + 24) % 24 : SCENE.hour;
  return {
    followClock: typeof s.followClock === 'boolean' ? s.followClock : SCENE.followClock,
    hour: Math.round(hour * 4) / 4,                       // 15 分钟一档
    weather: SCENE_WEATHERS.includes(s.weather) ? s.weather : SCENE.weather,
    autoWeather: typeof s.autoWeather === 'boolean' ? s.autoWeather : SCENE.autoWeather,
    panelOpen: typeof s.panelOpen === 'boolean' ? s.panelOpen : SCENE.panelOpen,
    bounds: validBounds(s.bounds) ? s.bounds : null,      // { x, y, w, h }，窗口位置
  };
}
// DEFAULTS 加 scene: { ...SCENE }；normalizeSettings 里 s.scene = normalizeScene(s.scene)；module.exports 导出 SCENE / SCENE_WEATHERS / normalizeScene
```

`src/core/settings-schema.js` 新增（新页 `scene`，放在 NAV「陪伴方式」组里，`PAGES` 加 `scene: { title: '像素小院', description: '她的小院：时段、天气，以及打开小院。' }`）：

```js
add('scene.followClock', 'scene', '时段', '跟随时间', 'switch', { desc: '小院的时段跟着这台电脑的时间走。关掉后用下面的时刻。' });
add('scene.hour', 'scene', '时段', '时刻', 'slider', { min: 0, max: 23.75, step: 0.25, format: 'hour', dependsOn: { key: 'scene.followClock', value: false } });
add('scene.weather', 'scene', '天气', '天气', 'segmented', { options: opts([['clear','晴'],['cloudy','多云'],['rain','小雨'],['snow','雪'],['storm','雷雨'],['fog','雾']]) });
add('scene.autoWeather', 'scene', '天气', '天气自己变', 'switch', { desc: '每隔一段时间自己换天气；手动选天气会关掉它。' });
add('scene.panelOpen', 'scene', '时段', '显示天色卡片', 'readonly', { internal: true, desc: '内部标记：小院里收起 / 展开天色卡片时写入。' });
add('scene.bounds', 'scene', '时段', '窗口位置', 'readonly', { internal: true, desc: '内部标记：小院窗口上次的位置和大小。' });
```

- `format: 'hour'` 是新的显示格式（18.5 → 「18:30」），在 `admin/src/console` 的滑块渲染里加一种格式化即可；不想加的话改成 `unit: '点'`。
- `scene.panelOpen` / `scene.bounds` 列进 `src/core/admin-coverage.js` 的 `INTERNAL_SETTINGS`（附原因），与 `petScaleSet` 同一处理。
- `RESTART_KEYS` 不变：全部即时生效。
- 旧 `settings.json` 没有 `scene`：`normalizeScene(undefined)` 给默认值，不需要迁移脚本。

---

## 8. 文件清单、单测与 e2e 规划

### 8.1 新增文件

| 路径 | 作用 |
| --- | --- |
| `src/core/scene-time.js`（新增） | `PALETTE`、`PHASES`、`KEYFRAMES`、`phaseOf(t)`、`clockHour(date)`、`lightAt(t)`（插值 + 量化）、`lerpLinearRGB`、`quantize`。UMD 写法（同 `src/core/fx.js`），renderer `<script>` 和 `node --test` 都能加载 |
| `src/core/scene-weather.js`（新增） | `WEATHERS` 参数表、`mixWeather(a, b, k)`、`nextWeather(cur, rnd, { month, hour })`、`spawnRate(weather, intensity)`、粒子步进 `stepParticles(list, dt, params, rnd)` |
| `src/core/scene-map.js`（新增） | 地图数据、`walkable(x, y)`、`nearestWalkable`、`findPath`（A*）、`smoothPath`、`propAt(x, y)`、`ySortKey` |
| `src/core/scene-pet.js`（新增） | 小院里她的状态机：`createScenePet({ map, rnd, roam })` → `tick(dt)`、`clickGround`、`clickProp`、`pick`/`drop`、`state()`（返回 `{ mode, state, x, y, facing, act }`，`state` 一律是 `core/fx.js STATES` 里的名字） |
| `src/main/scene-window.js`（新增） | `SceneWindow` 类（照 `src/main/pet-panel.js`）：`open(source)`、`close(reason)`、`toggle`、`visible`、记 / 恢复 `bounds`、统计 `opens` / `closes` 供 e2e |
| `src/main/scene-preload.js`（新增） | `window.scene`：`boot()`、`set(patch)`、`act(kind)`、`touch()`、`close()`、`onSettings`、`onView` |
| `src/renderer/scene/scene.html`（新增） | CSP 同 `panel.html`（`default-src 'self'`），加载 `../design/lobe-tokens.css`、`../../core/fx.js`、`../../core/scene-*.js`、`scene-art.js`、`scene.js` |
| `src/renderer/scene/scene.css`（新增） | 标题栏、天色卡片、工具栏（`--lobe-*` 令牌） |
| `src/renderer/scene/scene.js`（新增） | 渲染循环、图层合成、输入换算、精灵预缩放、`window.__scene` 调试接口（e2e 读状态：`{ hour, phase, weather, intensity, pet: {…}, particles, lights, scale }`） |
| `src/renderer/scene/scene-art.js`（新增） | 色板字符画 → tile / 物件 atlas（没有 PNG 时的生成路径） |
| `src/renderer/scene/art/`（新增，可后补） | `tiles.png`、`props.png`、`atlas.json`（自绘） |
| `test/scene-time.test.js`（新增） | 见 8.3 |
| `test/scene-weather.test.js`（新增） | 见 8.3 |
| `test/scene-map.test.js`（新增） | 见 8.3 |
| `test/scene-pet.test.js`（新增） | 见 8.3 |
| `e2e/pixel-scene.js`（新增） | 小院 e2e（照 `e2e/sprite-frame.js` 的模块写法），截图 / 录屏放 `out/e2e/pixel-scene/` |
| `docs/pixel-scene.md`（新增，后续任务写） | 使用说明：入口、操作、时段 / 天气、截图 |

### 8.2 修改文件

| 路径（均已存在） | 改动 |
| --- | --- |
| `src/main/main.js` | `require('./scene-window')`；`createTray()` 加「像素小院」；`createWindow()` 的 `before-input-event` 加 `Ctrl/⌘+Shift+H`；`showPet()` 开头关小院；`wire()` 加 IPC `scene-open` / `scene-close` / `scene-boot` / `scene-set` / `scene-act` / `scene-touch` 和调试用 `debug-scene-status`；`service.on('settings')` 时转发给小院 |
| `src/main/preload.js` | `openScene: (source) => ipcRenderer.invoke('scene-open', { source })` |
| `src/main/admin-preload.js` | 设置窗口的「打开小院」按钮用同一个 `scene-open` |
| `src/core/settings.js` | `SCENE`、`SCENE_WEATHERS`、`normalizeScene`、`DEFAULTS.scene`、导出 |
| `src/core/settings-schema.js` | `scene.*` 字段、NAV「陪伴方式」加 `{ page: 'scene', label: '像素小院', icon: 'Trees' }`、`PAGES.scene` |
| `src/core/admin-coverage.js` | `INTERNAL_SETTINGS` 加 `scene.panelOpen` / `scene.bounds`；`MENU` 加 `'tray:像素小院'`；运行时行为控制表加"像素小院"一行；`PET_ONLY` / `VIA` 里登记新 IPC |
| `src/core/api.js`（可选） | ROUTES 加 `POST /scene` |
| `src/renderer/panel/panel.html`、`src/renderer/panel/panel.js` | 「回小院」图块 `data-act="scene"` |
| `src/renderer/app.js` | `runAct` 加 `scene`；收到 `scene-enter` 时播 `happy` + 气泡 |
| `admin/src/console/ConsoleApp.tsx`、`admin/src/console/pages/Pages.tsx` | `case 'scene'` → `ScenePage`（`Header` + 「打开小院」按钮 + `SettingsForm page="scene"`） |
| `e2e/run.js` | 头部注释加 `scenario "scene"`；`const pixelSceneScenario = () => require('./pixel-scene')({ ROOT, OUT, FAKE_LH, step, launch, openAdminWindow })`；调度行 `if (which === 'scene' \|\| which === 'all') await pixelSceneScenario()();` |
| `test/settings.test.js`、`test/admin-coverage.test.js` | 新字段的默认值、非法值归一、覆盖矩阵通过 |
| `docs/usage.md`、`README.md`、`docs/admin-console-design.md` | 加「像素小院」一节、设置窗口页面清单、覆盖矩阵 §12 重新生成 |
| `.agents/ux/product.md` | lint 放行补 `src/renderer/scene/**` 的场景美术（理由同角色美术） |

### 8.3 单元测试（`npm test`，`node --test "test/*.test.js"`）

- `test/scene-time.test.js`
  - `phaseOf`：4.4 → night，4.5 → dawn，12 → day，18 → dusk，19.5 → night，23.99 / 0 → night（跨零点）。
  - `lightAt`：关键帧时刻精确等于关键帧值；任意 `t` 的 `ambientK ∈ [0,1]`；`t` 与 `t+24` 结果相同；23.9 与 0.1 的差小于阈值（零点连续）；12:00 的 `ambientK` 最小、0:00 最大；量化后 `ambientK*8` 是整数。
  - `clockHour(new Date(2026,10,5,18,30))` = 18.5。
- `test/scene-weather.test.js`
  - 每种天气都有完整参数；`mixWeather(a,b,0)=a`、`(…,1)=b`；`nextWeather` 用固定随机数序列可复现，转移表每行和为 1；`snow` 在 7 月概率为 0；`storm` 不会从 `clear` 直接出现。
  - `stepParticles`：粒子越过底边后回收重生，数量不超过上限；`intensity=0` 时不生成新粒子。
- `test/scene-map.test.js`
  - `findPath` 绕过房屋 / 水面、走桥；目标不可走时 `nearestWalkable` 给出最近格；路径每一步都在可走格上；`smoothPath` 不穿墙。
- `test/scene-pet.test.js`
  - 注入随机数和时钟：`roam=false` 时 60 s 内不自己走；`clickGround` 后 `state()` 依次是 `walk` → 到达后 `idle`；`clickProp('bench')` → 到 spot、`facing` 正确、`act='sit'`；`water` 期间 `state='play'`；`pick`/`drop` 落在可走格；所有输出的 `state` 都在 `require('../src/core/fx').STATES` 里。
- `test/settings.test.js`（改）：`normalizeSettings(null).scene` 等于默认；`hour: 25.1` → 1.0；`weather: 'hail'` → `clear`。

### 8.4 e2e：新 scenario `scene`

`xvfb-run -a node e2e/run.js scene`（shell 里设了 `ELECTRON_RUN_AS_NODE` 时先 `unset`；不进 `live`，不花 token）。`e2e/pixel-scene.js` 按步骤（每步 `step()` 截图）：

1. 启动（fake lh，已孵化的 克洛蒂 · 像素），托盘不可用时走她的面板：右键她 → 「回小院」→ 小院窗口出现、宠物窗口隐藏（`win.isVisible() === false`）。
2. `window.__scene()`：`scale` 是整数、canvas 尺寸 = 320×200×scale；她的迷你精灵已加载（`pet.ready`）。截图：白天晴。
3. 拖动时间滑块到 6 / 12 / 18 / 23（四个时段各一张截图），断言 `phase`，并比较画面平均亮度：day > dawn ≈ dusk > night。
4. 天气依次 晴 / 多云 / 小雨 / 雪（/ 雷雨 / 雾），每个等 3.5 s 截图；断言 `particles` 数量和类型（雨 > 100 根、雪 > 80 片、晴 = 0）。
5. 打开「跟随时间」：`hour` 与系统时间相差 < 0.1；关掉后拖滑块又关掉开关。
6. 单击空地坐标 → 等 `pet.mode` 变回 `idle`，她的格子 = 目标格；拖拽她到另一处松手 → 落在可走格。
7. 点长椅 → `act='sit'`；点花坛 → `state='play'`，花坛变成 `watered`；（夜里）点路灯 → `lights.lamp` 翻转。每个互动一张截图。
8. 重启应用：`scene.hour` / `scene.weather` 保持；设置窗口 → 玩法 → 像素小院页面字段与小院同步（在设置窗口改天气 → 小院 1 s 内跟着变）。
9. `Ctrl/⌘+Shift+H` 关小院 → 宠物窗口重新可见、位置不变。
10. 录一段 20 s 的视频（Playwright `recordVideo`），按时间轴依次是：黎明 → 白天 → 黄昏 → 夜晚开灯 → 下雨 → 下雪 → 她走到长椅坐下。录屏放 `out/e2e/pixel-scene/scene.webm`，供目标验收用。

另外：`node "$LOBE_DESIGN/scripts/lint-lobe.mjs" src/renderer/scene admin/src/console/pages` 无 FAIL；`npm run build:admin` 通过。

### 8.5 路径核对

本文"已存在"的路径在 `feat/pixel-scene`（= `origin/canary` 4fcfa6a）上用下面的命令核对过（输出见任务证据）：

```bash
for f in README.md docs/usage.md docs/pet-packs.md src/main/main.js src/main/preload.js src/main/admin-preload.js \
  src/main/pet-panel.js src/main/packs.js src/renderer/app.js src/renderer/rig.js src/renderer/fx.js src/renderer/style.css \
  src/renderer/panel/panel.html src/renderer/panel/panel.js src/renderer/design/lobe-tokens.css src/renderer/packs/claude-pixel/pack.json \
  src/core/fx.js src/core/framing.js src/core/settings.js src/core/settings-schema.js src/core/admin-coverage.js src/core/api.js \
  src/core/time-context.js src/core/dialogue.js admin/src/console/ConsoleApp.tsx admin/src/console/pages/Pages.tsx \
  e2e/run.js e2e/sprite-frame.js test/settings.test.js test/admin-coverage.test.js docs/admin-console-design.md .agents/ux/product.md; do
  test -e "$f" && echo "OK  $f" || echo "MISSING $f"; done
# 标注「新增」的路径应当都不存在：
for f in src/core/scene-time.js src/core/scene-weather.js src/core/scene-map.js src/core/scene-pet.js src/main/scene-window.js \
  src/main/scene-preload.js src/renderer/scene test/scene-time.test.js test/scene-weather.test.js test/scene-map.test.js \
  test/scene-pet.test.js e2e/pixel-scene.js docs/pixel-scene.md; do test -e "$f" && echo "EXISTS $f" || echo "NEW $f"; done
grep -c "which === 'scene'" e2e/run.js   # 0：scenario 名 scene 未被占用
```

---

## 9. 风险与非目标

### 9.1 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| HD 精灵（664×904、平滑绘制）缩到 40 px 后糊成一团、看不清脸 | 角色辨识度差 | 两步缩放 + alpha 阈值；描 1 px 深色外轮廓；提供 `scene.petHeight` 内部常量（40/48/56 可调），实现时用截图对比定；旧版像素包（83×113 硬像素）效果最好，可作为对照 |
| 两个窗口里出现同一个她，或者她"丢了" | 用户困惑 | §2.3：进小院时隐藏宠物窗口，所有 `showPet()` 入口先关小院；小院窗口崩溃（`render-process-gone`）时 main 兜底 `showPet()`；e2e 第 1、9 步覆盖 |
| xvfb / 软件渲染下帧率低，e2e 截图时机不稳定 | e2e 不稳定 | 逻辑分辨率只有 320×200，合成开销小；`__scene()` 暴露 `intensity`、`transition` 进度，e2e 等过渡结束再截图，不靠固定 sleep |
| 透明窗口 / `alwaysOnTop` 习惯不同 | 小院挡住工作 | 小院是普通不置顶窗口，可最小化；最小化时停止渲染循环 |
| 设置覆盖矩阵、schema 测试因新字段失败 | CI 红 | §7、§8.2 同时改 `settings.js`、`settings-schema.js`、`admin-coverage.js`，单测一起改 |
| 好感被小院互动刷高 | 破坏好感平衡 | 互动走现有的"互动"计数，受 `affectionRules.dailyCap` 约束，不新增好感来源 |
| 雨 / 雷闪对光敏用户不友好 | 可达性 | `prefers-reduced-motion` 下关闪电、粒子减半；闪电默认只在 `storm`（需手动选或自动天气） |
| 美术工作量（tile、物件）超出预期 | 进度 | v1 用 `scene-art.js` 字符画生成，先保证功能和截图；PNG 美术是可替换的资源，不影响代码 |
| 内存：多一个渲染进程 | 低配机 | 只在打开时创建；关闭超过 5 分钟销毁窗口（下次再建） |

### 9.2 非目标（本目标不做）

- 不做农场 / 经营 / 背包 / 存档类玩法；不做多个地图、镜头平移和缩放（地块一屏放下）。
- 不在小院里跑 Live2D、全动态（rig）、VRM 3D 的实时渲染；这些外观在小院里是"纸片人"（§4.5）。
- 同屏伙伴不进小院；小院里不聊天、不语音输入（聊天和语音留在桌面上的她）。
- 不把天气接真实天气 API（不联网，CSP 也禁止外网）；"天气自己变"是本地随机。
- 不复刻参考作品的美术、地图和 UI 文案；不新增角色包动作（不要求美术画坐姿 / 浇水帧）。
- 不改动桌面上的她现有的走动、抛掷、触摸、半身等行为。
