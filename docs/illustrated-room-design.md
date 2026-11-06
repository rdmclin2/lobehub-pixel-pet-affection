# 「她的房间」插画版技术方案（engine `illustrated-room@1`）

> 状态：方案（T-11682），还没有实现代码。引擎、美术、聊天驱动、上架和验收由后续任务按本文执行。
> 目标：商店里的新小游戏「她的房间」——日系手绘插画、斜上方俯视、深夜下雨的角色房间。她的每个状态是一整张插画构图（姿势和场景一起画），上面叠台灯光照、雨、窗外光斑、屏幕内容、呼吸眨眼等动效；用户在桌宠的聊天里说「回床上休息吧」「打开电脑刷抖音」，她切到对应状态并回复。
> 原来的像素版（`room@1`，PR #158）改名「像素房间」并保留，玩法和美术不动（§10）。
> 本轮交付大肥鱼一间（蓝色、女仆装、可爱少女风）；包格式支持更多房间和状态。

相关文档：[her-room.md](her-room.md)（像素房间 `room@1`，PR #158 分支）、PR #157 的 `docs/her-room-design.md`（`room@1` 方案）、[mini-games.md](mini-games.md)（商店、游戏窗口、发布）、[vrm-dance.md](vrm-dance.md)「聊天识别的规则」一段（聊天里的本地意图识别，`core/dance-intent.js`）。
不使用设置窗口里的 React 页面形态（已废弃的 PR #151）。

参考素材（LobeHub 文件）：

| 素材 | 文件 |
| --- | --- |
| 参考录屏（2:04，1280×720，60fps） | <https://app.lobehub.com/f/file_8QVTByl2YWNK> |
| 16 帧总览 / 单帧 ref-8 / ref-40 / ref-52 / ref-100 | `file_yYSfZ0npcTx7` / `file_KBgDjiielQos` / `file_0bSZVGogZZc1` / `file_88JLK5fg6rF0` / `file_JztByBW1tQNM` |
| 本文抽帧：整段每 4 秒一帧（带时间码） | <https://app.lobehub.com/f/file_MzSCiIsGYZXN> |
| 本文抽帧：0:00–0:32 每 2 秒 / 1:36–2:04 每 2 秒 | <https://app.lobehub.com/f/file_fkIMRvRZkXy2> / <https://app.lobehub.com/f/file_Z9yN9IkgQ7SN> |
| 本文抽帧：0:40–0:56 每秒（犯懒 → 开灯 → 去书桌） | <https://app.lobehub.com/f/file_xpLfyCFIp8K4> |
| 本文抽帧：0:43–0:45 每 1/6 秒（眨眼、台灯亮起） | <https://app.lobehub.com/f/file_aYh0xszybn1f> |
| 本文抽帧：0:52–0:54.5 每 0.2 秒（床 → 书桌的交叉淡化） | <https://app.lobehub.com/f/file_LXfWTUvAduFg> |

抽帧命令（录屏下载到新建空目录 `$REF` 后）：
`ffmpeg -i $REF/ref.mp4 -vf "fps=1/4,scale=320:-1,drawtext=text='%{pts\:hms}':…,tile=6x6" -frames:v 1 timeline.png`；
细节段用 `-ss 43 -t 2 … fps=6`、`-ss 52 -t 2.5 … fps=5`。

---

## 0. 结论

| 问题 | 决定 |
| --- | --- |
| 引擎 id | **`illustrated-room@1`**（新引擎，和 `room@1` 并列；`room@1` 一行不改）。`room@2` 会暗示替代关系，但两者画法、数据模型完全不同，像素房间要继续可玩，所以不用升主版本号 |
| 游戏 id | 新游戏用 `her-room`，名字「她的房间」；像素版改 id `pixel-room`、名字「像素房间」（§10）。`her-room` 从未进过已发布目录（应用 `canary` 的 `src/core/game-catalog.json` 和游戏仓库 `main` 的 `catalog.json` 都只有 `pixel-yard`），没有存量用户 |
| 画面怎么来 | 每个**状态**一张完整插画（角色姿势和房间一起出图，1920×1080），所有状态共用同一个房间「底版」和镜头，静止部分逐像素对齐；动的东西全部是叠加图层 |
| 光照 | 每个状态两张：`off`（台灯关，月光）和 `lit`（台灯开）。`lit` 由 `off` 图生图编辑得到，再对齐；运行时 `lit` 按台灯亮度 0–1 叠上去，加一层加色混合的暖光晕 |
| 动效 | 雨（窗户遮罩内的雨丝和玻璃水珠）、窗外光斑（加色混合、随机呼吸闪烁）、屏幕（`PerspectiveMesh` 四角透视贴图 + 屏幕溢光）、呼吸（局部 `MeshPlane` 网格形变）、眨眼（差分帧贴片）、状态切换交叉淡化 1.4 秒 |
| 屏幕内容 | 引擎在离屏 `RenderTexture` 里画：短视频（包里的帧序列，竖滑切换）、网页（模板 + 文字）、正在播放的歌（封面、歌名、进度、频谱）、游戏画面；不联网、不播包外的视频 |
| 聊天驱动 | 主进程里加 `core/room-intent.js`（规则识别，和 `dance-intent.js` 同一做法：Responses 直连路径没有工具调用，规则免费且可预测），命中就切状态，并把「你现在在做什么」写进这一轮的提示词，让她的回复和画面一致；规则没命中时，模型可以在回复末尾带 `〔房间:状态〕` 标记由主进程解析（第二阶段） |
| 聊天入口 | 游戏窗口底部一条聊天栏，走和桌面聊天框同一条 `PetService.chat()`（同一个 agent、topic、聊天记录）；设置窗口 → 聊天里和当前桌宠说话时也生效。直接点选：底部状态栏六个按钮 + 画面热点 |
| 数值 | 精力 / 心情等照旧由 main 结算（复用 `room-play.js` 的规则），面板默认收起成标题栏一个小胶囊 |

---

## 1. 参考录屏逐帧拆解

### 1.1 时间线

| 时间 | 画面 | 发生了什么 |
| --- | --- | --- |
| 0:00–0:04 | 聊天窗口（深色主题桌面 IM，非 LobeHub 页面） | 字幕「经过几晚的努力 / 终于给大飞鱼接入了她的房间」。已有对话：用户「回床上休息吧」→ 她「回来了，躺下了」；用户「大肥鱼，能收消息吗」 |
| 0:06–0:12 | 房间：她**坐在床中间**，看镜头，手机在床上亮着；台灯关 | 字幕「现在她悠然躺在床上」「她会拿手机」。0:08 起她**侧趴在床上看手机**（ref-8 / 0:10 / 0:12），手机光照亮她的脸和手。左下角有桌宠小人和台词气泡（「正在想你干活呢，别打扰我」一类），底部还有一行小字状态 |
| 0:14–0:26 | 聊天窗口 | 她「收到了，喊这么大声」；字幕「这里再让她去打开电脑刷抖音」；用户输入「现在去试一下打开电脑刷抖音吧」 |
| 0:28–0:40 | 房间：坐在床上看镜头 → 0:32「看发的什么」再次侧趴看手机（ref-40）→ 0:36 趴着抬头看镜头 → 0:40 坐起 | 同一构图里的三四个姿势；姿势之间是交叉淡化 |
| 0:40–0:43 | 坐在床上，**眼睛半闭、犯懒**（台词「好像有点懒」） | 0:43.3–0:43.7 眨眼（两帧闭眼） |
| 0:44 | **台灯亮起** | 0:44.0→0:44.17 一次跳亮，之后约 0.3 秒稍有起伏后稳定。桌面、台灯罩、墙、书变暖黄，书桌那一侧的地板、椅子被照亮；床和窗户一侧仍是蓝色月光；她的蓝色被暖光边缘轻微照到 |
| 0:44–0:52 | 台灯开，她坐在床上发呆、低头、闭眼 | 同构图下有 3–4 种细微姿态（抬头 / 低头 / 闭眼 / 半闭） |
| 0:52.4–0:54.0 | **交叉淡化**：床上的她渐隐，书桌前背影渐显 | 约 1.4 秒，中段（0:53.2）两个她同时半透明；房间其余部分（被子、窗、台灯）完全不动，说明两张图共用底版 |
| 0:54–1:06 | 书桌前**背对镜头**坐着，笔记本电脑亮着（1:04 ref-100 之前的桌前画面），台灯开 | 笔记本屏幕发冷白光，照亮她的头发轮廓 |
| 1:00–1:04 | 聊天窗口 | 她「开了，抖音在这边放着」「第一条就是有人在骂大肥鱼，说得挺难听」 |
| 1:08–1:18 | 真实桌面上的抖音网页窗口（水母视频、雨夜台灯窗景视频），旁边是房间窗口 | 「屏幕内容」在参考里是**另一个真实窗口**，不是贴在房间里电脑上的；字幕「这是给她自己的抖音账号 / 她天天看大肥鱼相关的」。抖音页面底部有她的 Q 版小人和气泡「正在处理任务呢」 |
| 1:20–1:42 | 聊天窗口 | 用户「现在回床上休息吧，不玩了」 |
| 1:44 | 抖音窗口（爱心视频）+ 房间 | 字幕「抖音停了」 |
| 1:46–1:48 | 书桌前，**台灯关**，只有笔记本屏幕亮着，屏幕光把她和桌面染成冷白 | 屏幕光是独立光源 |
| 1:48–1:50 | 台灯又亮；1:50 她**站起来**，背对镜头站在桌边（看得到鲸鱼尾巴） | 书桌 → 床之间有一个「起身」过渡姿势 |
| 1:52–1:56 | 聊天窗口 | 她「好，我走了，抖音也关了」「你也早点休息呀」一类；字幕「大飞鱼还不忘关心我」 |
| 1:58–2:00 | 房间：坐在床上抬头看镜头；台灯开 | 字幕「继续回她床上待着了」「嘿嘿真可爱」 |
| 2:02–2:04 | 抖音片尾 | — |

### 1.2 按维度拆解

| 维度 | 观察 |
| --- | --- |
| 画风 | 日系手绘插画（干净线稿 + 平涂 / 柔和渐变上色，赛璐璐和厚涂之间），**不是像素画**。角色是 Q 版（约 2.5 头身），房间是写实比例，角色比家具略小 |
| 镜头 | 斜上方约 45° 俯视的三点透视，镜头在房间对角，看向窗户和书桌的墙角。左上是窗户（两扇横窗、窗帘），左中是单人床，右上是书桌、台灯、书架、贴墙纸条，右下是搭着衣服的转椅；地板木纹可见。画面边缘有轻微暗角 |
| 光影 | 主光是**窗外的蓝色月光**，整屋蓝紫色调，高光偏青；台灯关时书桌一侧更暗。**台灯开**：暖黄光以台灯为中心向桌面、墙、书架、地板扩散，有柔和的光晕（bloom），床一侧基本不受影响，形成冷暖对比；**屏幕光**：手机 / 笔记本发冷白光，照亮她的脸、手、头发外轮廓。窗外**下雨**，玻璃上有雨丝和雨点，城市灯光虚化成一颗颗光斑（蓝白、少量暖黄） |
| 生活感物件 | 揉皱的被子（堆在床尾）、两个枕头、床上的手机；书桌上：笔记本电脑、成摞的书、摊开的笔记本和笔、散落的纸、小药瓶 / 杯子；书架上立着的书、墙上贴的纸条和软木板；搭着外套的转椅、墙角的衣架和挂着的衣服；桌下机箱；地上的垃圾桶 |
| 角色与姿势 | 大肥鱼：蓝色长发、呆毛、白色女仆头饰（荷叶边）、深蓝女仆裙 + 白围裙、领口蝴蝶结、侧面的鳍状耳饰、深蓝鲸鱼尾巴。出现的姿势：坐在床中间看镜头；侧趴看手机；趴着抬头；坐着眼睛半闭犯懒；低头发呆；书桌前背对镜头用电脑；桌边站起。不同画面里脸、发型、服装一致 |
| 构图 | 每个姿势都在**同一个房间、同一个镜头**下，她的位置跟着活动变（床上 / 书桌前），房间不动；她的光照跟所在位置一致（床上是月光 + 手机光，书桌前是台灯 + 屏幕光） |
| 动效 | 窗外雨和光斑（光斑缓慢闪烁）；台灯开关（约 0.17 秒跳亮）；手机 / 屏幕的亮光；眨眼（约 0.3 秒闭眼）；姿势之间交叉淡化；画面里几乎没有大位移动画，靠图层细节让画面「活着」 |
| 屏幕内容 | 参考里「刷抖音」是另开一个真实抖音网页窗口（竖屏短视频：水母、雨夜窗景、爱心），房间里笔记本屏幕本身只是亮着。目标要求更进一步：把内容画在房间里的电脑 / 手机屏幕上（§7） |
| 状态过渡 | 状态之间约 1.4 秒交叉淡化（不是走路动画）；有中间姿势（起身站在桌边）；台灯状态独立于活动，可以在任何状态下开关 |
| 聊天驱动 | 用户在聊天里发自然语言指令（「回床上休息吧」「去试一下打开电脑刷抖音吧」「现在回床上休息吧，不玩了」），她**先切状态**，再用一两句话回复（「回来了，躺下了」「开了，抖音在这边放着」），回复里会提到屏幕上看到的内容（「第一条就是有人在骂大肥鱼」） |
| 附加 UI | 房间画面左下角有她的小头像 + 台词气泡、底部一行状态文字；没有数值面板 |

---

## 2. 验收对照清单

后续实现任务按这张表逐条截图 / 录屏对比，每条写「符合 / 部分 / 不符」。编号对应 7 条效果要求（E1–E7）。

| # | 要求 | 参考 | 判据（能看到的） |
| --- | --- | --- | --- |
| R-01 | E1 画风 | 全部房间帧 | 手绘插画，线稿干净、柔和渐变；放大 200% 没有像素块；同一包里所有状态图风格统一 |
| R-02 | E1 镜头 | ref-8、ref-52 | 斜上方俯视，看得到地板、床面、桌面，墙角透视；所有状态镜头一致（静止物件切状态时不跳） |
| R-03 | E2 月光 | ref-8 | 台灯关时整屋蓝紫调，窗户一侧最亮 |
| R-04 | E2 下雨与光斑 | 0:06、0:44 窗户 | 窗玻璃上有雨丝 / 雨点在动；窗外光斑虚化、亮度缓慢起伏；只在窗户范围内 |
| R-05 | E2 台灯 | 0:43–0:45 | 点台灯或说「开灯」：0.2 秒内桌面变暖、出现光晕，床一侧仍偏蓝；关灯回到月光；在任意状态下都能开关 |
| R-06 | E3 生活感 | ref-52 | 画面里同时有：揉皱的被子、成摞的书、搭着衣服的椅子、笔记本电脑、散落的纸、床上的手机，至少 6 种 |
| R-07 | E4 姿势 | 0:08、0:40、0:54、1:50 | 六类活动各有专门构图：睡觉（躺进被子、闭眼）、工作（背对镜头在桌前打字）、看手机（侧趴床上举手机）、听音乐（戴耳机靠着床头轻晃）、打游戏（桌前握手柄或盯着屏幕）、发呆 / 犯懒（坐在床上半闭眼） |
| R-08 | E4 光照融入 | 0:54、1:46 | 她在书桌前时被台灯暖光 / 屏幕冷光照到；在床上时是月光 + 手机光 |
| R-09 | E4 形象一致 | 全部 | 并排对比 6 张状态图：脸、蓝发和呆毛、女仆头饰、裙子和围裙、鲸鱼尾巴一致 |
| R-10 | E5 呼吸 / 眨眼 | 0:43.3 | 静止 10 秒：她每 3–6 秒眨一次眼（闭眼约 0.15 秒），身体有轻微起伏；睡觉时不眨眼、呼吸更慢 |
| R-11 | E5 屏幕亮光 | 0:12、1:46 | 手机 / 电脑亮着时周围有冷白溢光，亮度随画面内容变化 |
| R-12 | E5 过渡 | 0:52.4–0:54 | 切状态时 1–2 秒交叉淡化，没有黑屏、没有闪；房间静止部分不跳 |
| R-13 | E6 屏幕内容 | 1:08–1:16 | 「刷抖音」：电脑或手机屏幕上播竖屏短视频，每 8–15 秒上滑换一条；「上网 / 工作」：屏幕上是网页或文档；「听音乐」：屏幕上是播放器（封面、歌名、进度在走）；内容贴合屏幕四角透视 |
| R-14 | E7 聊天切状态 | 0:14–0:54、1:20–2:00 | 在游戏窗口聊天栏说「打开电脑刷抖音」→ 2 秒内开始切到书桌 + 屏幕播短视频，她回复里提到在刷抖音；说「回床上休息吧」→ 切到床上；回复进聊天记录 |
| R-15 | E7 直接点选 | — | 底部状态栏六个按钮、点画面里的床 / 书桌 / 手机都能切状态；聊天不可用（未登录、离线）时照样能玩 |
| R-16 | E7 数值弱化 | — | 默认看不到数值面板，只有标题栏一个小胶囊；点开才显示精力 / 心情等 |
| R-17 | 附加 UI | ref-8 左下 | 她的台词气泡显示在画面里（回复文字、活动台词） |

---

## 3. 7 条效果要求 → 实现手段

| 要求 | 实现手段 | 章节 |
| --- | --- | --- |
| **E1 画风与透视**：日系手绘、斜上方俯视、有纵深 | 美术：先出一张「空房间底版」（斜俯视、深夜、下雨），之后所有状态图都以底版为输入、用 gpt-image 编辑模式「把角色放进来」，保证镜头和房间一致；风格词固定在 `prompts.json` 的 `style`。引擎不做透视计算，图本身就是透视的；交互区域（热点、屏幕四角、窗户）都按图上的像素坐标写在 manifest 里 | §11、§5 |
| **E2 光影氛围**：月光、雨、光斑、台灯光晕、整屋光照变化 | ① 每个状态两张图 `off` / `lit`，`lit` 用 `alpha = lamp` 叠在 `off` 上（可选 `lightMask` 灰度图限定范围）；② 台灯处一个加色混合（`blendMode: 'add'`）的径向光晕精灵，亮度随 `lamp`；③ 开关动画：0.17 秒升到 1，再 0.3 秒内 ±5% 衰减振荡；④ 窗户多边形遮罩内：雨丝（`Graphics` 线段池，斜向下落）、玻璃水珠（小精灵缓慢下滑）、光斑（加色混合的圆形软精灵，每颗独立正弦闪烁）；⑤ 整屋 `ColorMatrixFilter` 做最终调色（夜里略降饱和度、提蓝） | §4.2、§6.3 |
| **E3 生活感**：被子、书、椅子、电脑、纸 | 画进底版和每张状态图（不做成可拖动物件）；manifest 的 `props` 只给需要动的物件（手机屏幕、电脑屏幕、台灯）。`prompts.json` 底版提示词逐项列出物件清单，验收按 R-06 数 | §11.2 |
| **E4 角色融入场景**：每个状态专门姿势、受光照影响、形象一致 | 每个状态一张完整构图（角色 + 场景一起出图），所以姿势、遮挡（被子盖住腿、椅背挡住身体）、光照（台灯照到她）都是画出来的，不靠运行时合成；`lit` 图里她也被暖光照到。一致性：同一张角色设定图（三视图 + 表情）作为每次编辑的参考图输入（`imageUrls`），提示词固定角色描述段；出图后人工比对 R-09 | §11.3 |
| **E5 活的画面**：雨、光斑、台灯、屏幕光、呼吸眨眼、平滑过渡 | 呼吸：状态图上她胸口到肩膀的矩形区域切成一张子纹理，挂在 `MeshPlane`（8×8 网格）上，顶点按「中心大、边缘 0」的权重做 1–2 像素的周期位移，边缘贴回原图不露缝；眨眼：每个状态给闭眼差分贴片（`blink` 精灵 + 坐标），每 3–6 秒随机显示 120–160 ms，偶尔连眨两次；屏幕光：屏幕外一圈加色混合光晕，亮度跟屏幕内容的平均亮度；过渡：两个状态容器同时在场，`alpha` 1.4 秒 ease-in-out 交叉淡化，雨和光斑图层在最上层不参与淡化（窗户在所有状态里位置相同） | §4、§6 |
| **E6 屏幕内容**：短视频、网页、正在播放的歌 | 每个屏幕是一个 `PerspectiveMesh`，四角坐标来自 manifest；内容先画进离屏 `RenderTexture`（竖屏 360×640 或横屏 640×400），再贴到网格上。内容类型：`clips`（包里的帧序列，竖滑切换，模拟刷短视频）、`page`（网页模板：地址栏、标题、段落、图片卡片，文字可由聊天带入，如搜索词）、`player`（封面、歌名、歌手、进度条、频谱柱）、`game`（帧序列小游戏）、`chat`（她和你的聊天，工作时可选）。全部本地绘制，不联网 | §7 |
| **E7 聊天驱动**：聊天里说话→切状态并回复；直接点选备用；数值弱化 | `core/room-intent.js` 规则识别（主进程，`PetService.chat()` 发请求之前）；命中后 main 通知游戏窗口切状态、结算上一项、开始新一项，并在提示词里加一段「房间」上下文让回复一致；回复进聊天记录并显示在房间气泡里。游戏窗口底部聊天栏走同一个 `chat()`。底部状态栏 + 画面热点直接点选；数值面板收进标题栏胶囊 | §8、§9 |

---

## 4. 引擎架构

### 4.1 文件

| 文件 | 作用 |
| --- | --- |
| `src/core/illustrated-room-pack.js`（新） | `validateIllustratedRoom(m, { files, sprites })`：房间、状态、图层、屏幕、热点、意图词的字段和范围检查；`namedFiles` / `spriteFiles` |
| `src/core/game-pack.js` | `ENGINES = ['yard@1', 'room@1', 'illustrated-room@1']`，按 engine 分派到新校验 |
| `src/core/room-intent.js`（新，UMD） | `matchRoomIntent(text, manifestIntents, ctx)` → `{ state, lamp?, screen?, query? } \| null`，纯函数 |
| `src/core/room-play.js` | 复用：活动开始 / 结算 / 提前结束 / 切换的纯函数；新引擎的状态 `kind` 映射到它的活动（`idle` 不计数值） |
| `src/main/games.js` | `roomCommand(id, cmd)`：来自聊天或点选的状态切换，统一走这里结算并推给页面；`illustratedBoot` |
| `src/main/pet-service.js` | `chat()` 里调 `room-intent`、给提示词加房间上下文、解析回复里的 `〔房间:…〕` 标记；`via: 'game'` 的来源 |
| `src/main/game-preload.js` | 新增 `chat(text)`、`onRoomCommand(cb)`、`onSay(cb)`（她的回复流） |
| `src/renderer/game/engines/illustrated-room.js`（新） | 引擎：图层栈、状态切换、光照、雨、光斑、屏幕、呼吸眨眼、热点、气泡、聊天栏、状态栏、数值胶囊 |
| `src/renderer/game/engines/screen-content.js`（新） | 屏幕内容渲染器（clips / page / player / game / chat），输出 `RenderTexture` |
| `src/renderer/game/engines/illustrated-room.css` | 聊天栏、状态栏、胶囊、气泡 |
| `src/renderer/game/game-boot.js`、`game.html` | 多一个引擎分支，和 `room@1` 一样「读 boot 结果，不是自己的就退出」 |

不改：`engines/room.js`、`room.css`、`room-pack.js` 的规则，`game-window.js`（窗口还是 960×600，可缩放，插画按 16:9 `contain` 适配）。

### 4.2 图层栈（从下到上）

```
stage
└─ world (按窗口 contain 缩放；1920×1080 世界坐标)
   ├─ sceneA  ─┐  当前状态 / 过渡中的上一个状态（交叉淡化时两个同时在场）
   │  ├─ off      状态图，台灯关（Sprite）
   │  ├─ lit      同构图，台灯开（Sprite，alpha = lamp，可选 mask = lightMask）
   │  ├─ breath   她的呼吸网格（MeshPlane，纹理是 off/lit 的子区域，跟 lamp 混合）
   │  ├─ blink    闭眼差分贴片（off / lit 各一张，visible 由眨眼计时器控制）
   │  └─ screens  这个状态里亮着的屏幕（PerspectiveMesh × n，内容见 §7）+ 屏幕溢光（add）
   ├─ sceneB  ─┘
   ├─ window   窗户遮罩（Graphics 多边形 mask）
   │  ├─ bokeh    光斑（add，每颗正弦闪烁，缓慢漂移）
   │  ├─ rain     雨丝（线段池）+ 玻璃水珠（精灵，偶尔下滑留痕）
   │  └─ flash    （可选）远处闪电：整块 window 亮 0.1 秒
   ├─ lampGlow 台灯光晕（add，径向渐变，alpha = lamp × 0.6）
   ├─ ambient  空气里的微尘（add，台灯开时在光锥里更明显）
   ├─ grade    整体调色（ColorMatrixFilter + 暗角 Sprite）
   └─ hotspots 透明的可点区域（床、书桌、手机、台灯、窗户），悬停描边提示
ui (DOM)
   ├─ 标题栏：房间名、数值胶囊（收起）、⌂ 换房间、✕
   ├─ 气泡：她的台词 / 回复（锚点来自状态的 bubble 坐标）
   ├─ 状态栏：睡觉 / 工作 / 看手机 / 听音乐 / 打游戏 / 发呆（当前高亮）+ 台灯开关
   └─ 聊天栏：输入框 + 发送（Enter），显示「她在想…」
```

要点：

- **为什么叠两张图而不是滤镜调色**：台灯光有方向、有遮挡（台灯罩下亮、书挡出阴影、她的头发被照亮），滤镜做不出；`lit` 由画师 / 模型画出来最可信。`lightMask`（可选灰度 webp）用于两张图有细微错位时只在台灯附近混合，远处保留 `off`。
- **对齐**：所有状态共用底版，`off` / `lit` 同构图。美术脚本对齐后检查静止区域的差（§11.4），差太大就重出。
- **雨和光斑放在场景之上**：窗户在所有状态里位置相同，雨不随状态淡化，过渡时窗外是连续的。
- **PixiJS 8 已带的类**：`PerspectiveMesh`、`MeshPlane`、`ColorMatrixFilter`、`DisplacementFilter` 都在 `src/renderer/vendor/pixi/pixi.min.js` 里（已核对）；`blendMode = 'add'` `room@1` 已在用。不引新依赖。

### 4.3 帧预算

960×600 窗口、世界 1920×1080 缩到约 0.5 倍。每帧：2 个状态 × 2 张大图（过渡时）、≤3 个屏幕网格、≤80 颗光斑、≤120 条雨丝、1 个呼吸网格。`RenderTexture` 屏幕内容按 15–30 fps 更新（不必每帧）。目标：Xvfb 软件渲染 ≥30 fps，真机 60 fps；窗口隐藏时（`onHidden`）停 ticker。纹理：状态图加载后保留当前和相邻（点选栏里下一个可能用到的）状态，其余按需加载、过渡完成后释放，显存峰值约 6 张 1920×1080。

---

## 5. 游戏包格式（engine `illustrated-room@1`）

### 5.1 文件

和其它引擎一样：平铺文件夹，只允许 `.webp` / `.png` / `.json`，manifest 没列出的文件拒绝安装；文件名以房间 id 开头。

```
manifest.json                 游戏信息、活动（数值）、房间列表
dafeiyu-sleep-off.webp        每个状态两张：off（台灯关）/ lit（台灯开），1920×1080
dafeiyu-sleep-lit.webp
dafeiyu-work-off.webp  …      （work / phone / music / game / idle / idle-lazy / stand …）
dafeiyu-light-mask.webp       （可选）台灯影响范围的灰度图，全房间共用
dafeiyu-parts.webp            小图集：眨眼贴片、光斑、雨珠、台灯光晕、屏幕外框光
dafeiyu-parts.json            图集索引 { 名字: { x, y, w, h } }
dafeiyu-clips.webp            屏幕短视频帧（竖屏 360×640 帧，横向排列）
dafeiyu-clips.json            帧索引
dafeiyu-media.webp            播放器封面、网页里的图片、游戏画面帧
dafeiyu-media.json
```

上限（校验里写死）：每个房间 ≤ 40 个文件、单个图片 ≤ 4 MB、整包 ≤ 60 MB（目录 `bytes` 上限是 200 MB）；每个房间 ≤ 16 个状态、≤ 4 个屏幕、≤ 12 个热点；最多 12 个房间；manifest ≤ 256 KB。大肥鱼一间预计 8 个状态 × 2 张 × ~350 KB + 素材 ≈ 8 MB。

### 5.2 manifest 示例

完整示例另存为 [`docs/data/illustrated-room-manifest.example.json`](data/illustrated-room-manifest.example.json)（能被 `JSON.parse` 解析，后续实现的校验器用它做第一个通过用例）。结构摘要（坐标都是世界坐标 1920×1080）：

```jsonc
{
  "schema": 1, "kind": "game", "engine": "illustrated-room@1",
  "id": "her-room", "name": "她的房间", "version": "1.0.0",
  "description": "深夜下雨的房间里，她躺在床上刷手机、坐在书桌前用电脑、听歌、打游戏、发呆。在聊天里叫她做什么，她就去做。",
  "credit": "美术：GPT Image（gpt-image-2.5）；玩法与引擎：Pixel Pet Affection",
  "defaultRoom": "dafeiyu",

  // 活动：数值规则所有房间共用（沿用 room@1 的五件事，加 idle）
  "activities": {
    "sleep": { "label": "睡觉", "seconds": 30, "deltas": { "energy": 35, "mood": 6, "focus": 8, "fullness": -4 } },
    "work":  { "label": "工作", "seconds": 30, "deltas": { "focus": 28, "energy": -12, "mood": -5, "fullness": -8 }, "needs": { "energy": 15 } },
    "phone": { "label": "看手机", "seconds": 20, "deltas": { "mood": 14, "focus": -10, "energy": -4 } },
    "music": { "label": "听音乐", "seconds": 25, "deltas": { "mood": 16, "energy": 6, "focus": 6 } },
    "game":  { "label": "打游戏", "seconds": 30, "deltas": { "mood": 22, "energy": -14, "fullness": -8, "focus": -6 }, "needs": { "energy": 15 } },
    "idle":  { "label": "发呆", "seconds": 0 }                 // 不计时、不结算：默认状态
  },

  "rooms": [{
    "id": "dafeiyu", "character": "dafeiyu", "status": "open",
    "name": "鲸鱼女仆的雨夜小屋", "blurb": "深夜、下雨、蓝色月光，台灯一开桌面就暖起来。",
    "palette": { "primary": "#2C4A8A", "accent": "#6FA8E8", "base": "#FFFFFF", "trim": "#E8D6A0" },
    "world": { "width": 1920, "height": 1080, "background": "#0B1430" },
    "lighting": {
      "lamp": { "default": false, "at": [1452, 210], "glow": { "sprite": "lamp-glow", "r": 520, "alpha": 0.6 },
                "mask": "dafeiyu-light-mask.webp", "rampOn": 0.17, "rampOff": 0.25, "flicker": 0.05 },
      "grade": { "saturation": 0.92, "tint": "#9FB8FF", "vignette": 0.35 }
    },
    "window": {
      "poly": [[268, 40], [1010, 0], [1040, 330], [300, 420]],      // 窗玻璃四边形
      "rain": { "density": 110, "angle": 12, "speed": [900, 1400], "drops": 24 },
      "bokeh": { "count": 60, "sprites": ["bokeh-blue", "bokeh-warm"], "warmRatio": 0.15, "r": [6, 22], "period": [2, 6] }
    },
    "sprites": "dafeiyu-parts.json",
    "images": { "parts": "dafeiyu-parts.webp", "clips": "dafeiyu-clips.webp", "media": "dafeiyu-media.webp" },
    "frames": { "clips": "dafeiyu-clips.json", "media": "dafeiyu-media.json" },

    // 屏幕：四角（左上、右上、右下、左下），每个状态决定哪些亮、播什么
    "screens": {
      "laptop": { "corners": [[1500, 520], [1640, 470], [1662, 590], [1522, 646]], "size": [640, 400], "glow": { "r": 180, "color": "#CFE3FF" } },
      "phone":  { "corners": [[880, 690], [948, 668], [968, 760], [900, 784]], "size": [360, 640], "glow": { "r": 120, "color": "#DDE9FF" } }
    },

    // 状态：一张完整构图（off / lit）+ 呼吸、眨眼、屏幕、气泡位置
    "states": {
      "idle": {
        "activity": "idle", "label": "发呆",
        "images": { "off": "dafeiyu-idle-off.webp", "lit": "dafeiyu-idle-lit.webp" },
        "breath": { "rect": [700, 430, 260, 220], "amp": 1.6, "period": 3.8 },
        "blink": { "sprite": { "off": "idle-blink-off", "lit": "idle-blink-lit" }, "at": [776, 452], "every": [3, 6] },
        "screens": { "phone": { "content": "lock", "on": true } },
        "bubble": [820, 360], "variants": ["idle-lazy"]
      },
      "idle-lazy": { "activity": "idle", "label": "犯懒", "images": { "off": "dafeiyu-idle-lazy-off.webp", "lit": "dafeiyu-idle-lazy-lit.webp" },
                     "breath": { "rect": [700, 430, 260, 220], "amp": 1.2, "period": 4.6 }, "blink": { "sprite": { "off": "lazy-blink-off", "lit": "lazy-blink-lit" }, "at": [776, 456], "every": [2, 4] }, "bubble": [820, 360] },
      "sleep": { "activity": "sleep", "label": "睡觉", "images": { "off": "dafeiyu-sleep-off.webp", "lit": "dafeiyu-sleep-lit.webp" },
                 "breath": { "rect": [560, 520, 420, 200], "amp": 2.2, "period": 5.2 }, "blink": null, "lampOnEnter": false,
                 "fx": [{ "type": "emit", "sprites": ["z1", "z2"], "from": [640, 470], "every": 1.6, "rise": 80 }] },
      "phone": { "activity": "phone", "label": "看手机", "images": { "off": "dafeiyu-phone-off.webp", "lit": "dafeiyu-phone-lit.webp" },
                 "breath": { "rect": [620, 560, 320, 180], "amp": 1.4, "period": 3.6 }, "blink": { "sprite": { "off": "phone-blink-off", "lit": "phone-blink-lit" }, "at": [702, 598], "every": [3, 6] },
                 "screens": { "phone": { "content": "clips", "on": true } }, "bubble": [760, 470] },
      "work":  { "activity": "work", "label": "工作", "images": { "off": "dafeiyu-work-off.webp", "lit": "dafeiyu-work-lit.webp" },
                 "breath": { "rect": [1380, 430, 240, 260], "amp": 1.2, "period": 4.0 }, "blink": null,   // 背对镜头，不眨眼
                 "lampOnEnter": true, "screens": { "laptop": { "content": "page", "on": true } }, "bubble": [1300, 300], "enterVia": "stand" },
      "music": { "activity": "music", "label": "听音乐", "images": { "off": "dafeiyu-music-off.webp", "lit": "dafeiyu-music-lit.webp" },
                 "breath": { "rect": [700, 420, 260, 240], "amp": 1.6, "period": 3.4 }, "sway": { "amp": 2.5, "bpm": 84 },
                 "blink": { "sprite": { "off": "music-blink-off", "lit": "music-blink-lit" }, "at": [770, 448], "every": [4, 7] },
                 "screens": { "phone": { "content": "player", "on": true } }, "fx": [{ "type": "emit", "sprites": ["note1", "note2"], "from": [800, 420], "every": 1.2, "rise": 70 }] },
      "game":  { "activity": "game", "label": "打游戏", "images": { "off": "dafeiyu-game-off.webp", "lit": "dafeiyu-game-lit.webp" },
                 "breath": { "rect": [1380, 430, 240, 260], "amp": 1.2, "period": 3.2 }, "blink": null,
                 "screens": { "laptop": { "content": "game", "on": true } }, "bubble": [1300, 300], "enterVia": "stand" },
      "stand": { "activity": null, "transient": true, "label": "起身", "images": { "off": "dafeiyu-stand-off.webp", "lit": "dafeiyu-stand-lit.webp" }, "hold": 0.6 }
    },
    "defaultState": "idle",
    "transition": { "seconds": 1.4, "ease": "inOutSine" },

    // 屏幕内容的数据
    "content": {
      "clips": { "frames": "clip", "fps": 12, "list": [{ "id": "jellyfish", "frames": 24, "caption": "深海里的水母" }, { "id": "rain-window", "frames": 24, "caption": "雨夜窗边的台灯" }], "swipeEvery": [8, 15] },
      "page": { "templates": [{ "id": "doc", "title": "周报.docx", "lines": 14 }, { "id": "search", "title": "搜索", "query": "{query}" }] },
      "player": { "tracks": [{ "title": "雨夜的鲸鱼", "artist": "大肥鱼", "cover": "cover-whale", "seconds": 186 }] },
      "game": { "frames": "game", "fps": 10 }
    },

    // 画面热点：点了切到哪个状态（直接点选入口之一）
    "hotspots": [
      { "id": "bed", "poly": [[240, 560], [980, 470], [1100, 760], [300, 960]], "label": "床", "state": "sleep" },
      { "id": "phone", "poly": [[870, 660], [980, 650], [990, 790], [880, 800]], "label": "手机", "state": "phone" },
      { "id": "desk", "poly": [[1260, 360], [1880, 300], [1900, 700], [1300, 760]], "label": "书桌", "state": "work" },
      { "id": "lamp", "poly": [[1400, 90], [1520, 90], [1530, 300], [1390, 300]], "label": "台灯", "toggle": "lamp" }
    ],

    // 聊天意图：在通用词表之外，这个房间额外认的说法（§8.2）
    "intents": {
      "sleep": ["回床上", "去睡觉", "躺下", "休息吧"],
      "phone": ["看手机", "玩手机", "刷手机"],
      "work":  ["去工作", "写代码", "干活", "打开电脑", "上网", "搜一下"],
      "music": ["听歌", "听音乐", "放首歌"],
      "game":  ["打游戏", "玩游戏", "开一局"],
      "idle":  ["发呆", "歇会", "犯懒", "坐着"],
      "screen": { "clips": ["刷抖音", "刷视频", "短视频"], "page": ["网页", "搜一下", "查一下"], "player": ["放歌", "听歌"] }
    },

    "lines": {
      "enter": ["今晚又在下雨……"],
      "ack": { "sleep": ["回来了，躺下了。"], "work": ["开了，在弄呢。"], "phone": ["在刷呢，别催。"], "music": ["放上了。"], "game": ["来一局！"], "idle": ["……就发会儿呆。"] },
      "lampOn": ["开灯啦。"], "lampOff": ["关了，屋里好蓝。"]
    }
  }],

  "quests": [
    { "id": "sleep-full", "title": "陪她睡一整觉", "on": { "type": "activity-end", "kind": "sleep", "complete": true } },
    { "id": "chat-move", "title": "在聊天里叫她做一件事", "on": { "type": "chat-command" } },
    { "id": "lamp-night", "title": "夜里帮她开一次台灯", "on": { "type": "lamp", "to": true } }
  ]
}
```

### 5.3 校验规则（`validateIllustratedRoom`）

- 公共字段同 `game-pack.js`；`defaultRoom` 是一个 `open` 房间。
- `activities` 的 key ∈ `sleep work phone music game idle`（以后扩展要先改应用）；`seconds` 0 或 5–600；`deltas` 只能是 `energy / mood / focus / fullness`，每项 ±40；`needs` 只能是 `energy`。和 `room@1` 同一套数值上限，结算复用 `room-play.js`。
- `rooms[].states`：至少有 `defaultState` 和每个活动各一个状态（`activity` 指向的活动）；`images.off` 必填，`lit` 可选（没有就只用光晕）；所有图片在文件列表里且以房间 id 开头。`transient` 状态（如 `stand`）不能是 `defaultState`、不能被意图直接选中，只能出现在 `enterVia`。
- 坐标：`rect` / `at` / `bubble` / `corners` / `poly` 都在 `world` 内；`corners` 四点构成凸四边形（叉积同号）；`breath.amp` 0–4，`period` 1–10；`blink.every` 1–20 秒；`transition.seconds` 0.3–4。
- `screens[].content` ∈ `lock clips page player game chat off`；用到 `clips` / `game` 时 `content.*.frames` 在帧索引里存在。
- `hotspots[]`：`state` 指向存在的非 transient 状态，或 `toggle: "lamp"`。
- `intents`：每个 key 是已有状态或 `screen`，每个词 1–12 个字，每个状态 ≤ 24 个词。
- `lines` 每条 ≤ 60 字；`quests.on.type` 新增 `chat-command`、`lamp`。
- `status: "soon"` 的房间只要 `id character status name blurb palette`（和 `room@1` 主题一样用于换房间卡片）。

### 5.4 扩展方式

- **加房间**：`rooms[]` 加一项（例如克洛蒂的「午后的书房」，白天、晴），只动游戏仓库：美术 + manifest，应用不用发版。天气 / 时段先由房间自己决定（`window.rain` 可以不写 = 不下雨；`lighting.grade` 换暖色）。
- **加状态**：在 `states` 里加一项并指向已有 `activity`（例如 `phone-sit`「坐着看手机」作为 `phone` 的变体，放进 `variants`），只动包。引擎在同一活动的变体之间每 20–40 秒随机交叉淡化（参考 0:28–0:52 同构图下的多个姿势）。
- **加活动种类**（如「吃东西」）：要先在应用里加 `KINDS` 和数值规则，应用发版后包写 `minAppVersion`。
- **加屏幕内容类型**：要改应用的 `screen-content.js`，同上。

---

## 6. 状态与过渡

### 6.1 状态机

```
            点选 / 聊天 / 活动结束
idle ──────────────────────────────▶ <state>
  ▲   （书桌类状态之间、床↔书桌经过 stand）      │
  └──────── 活动到时 / 「结束」/ 另一个指令 ◀──┘
```

- 当前状态 = `{ state, since, lamp, screen }`，页面只负责演，**main 是唯一的权威**：点选和聊天都发到 main 的 `roomCommand`，main 用 `room-play.js` 结算上一项、开始下一项，然后推 `game:room-command` 给页面。进度存在 `userData/games/.progress/her-room.json`（`state` 字段带 `engine: "illustrated-room@1"`，读到别的引擎写的旧状态就丢掉，避免开发期 `her-room` 的 `room@1` 存档干扰）。
- 活动到时：结算后回 `idle`（或该活动的「完成」变体），她说一句 `lines.done`。
- 精力不够（`needs`）：不切，气泡说「太累了……先睡会儿吧」；聊天里说的同样处理，并把原因写进提示词让她自己解释。

### 6.2 交叉淡化

- 1.4 秒 `inOutSine`；新状态先加载并解码完再开始（加载中气泡显示「…」，超过 1.5 秒就先切光照不切画面）。
- 床 ↔ 书桌（`enterVia: "stand"`）：`当前 → stand`（淡化 0.8 秒，停 0.6 秒）`→ 目标`（淡化 1.0 秒），对应参考 1:50 的起身。
- 呼吸 / 眨眼计时器在淡化期间暂停；屏幕内容在新状态里从头开始；雨、光斑不受影响。

### 6.3 台灯

- `lamp` 是房间级状态，和活动独立；`lampOnEnter: true` 的状态进入时自动开灯（工作），`false` 的不自动关（睡觉时由用户 / 聊天关，「关灯睡觉」会同时匹配 `sleep` + `lamp: false`）。
- 开：0.17 秒线性升到 1.0，再 0.3 秒阻尼振荡（±5%）后稳定；关：0.25 秒降到 0。`lit.alpha`、`lampGlow.alpha`、`ambient` 微尘同步。点台灯热点、状态栏灯泡按钮、聊天「开灯 / 关灯」都可以。

---

## 7. 屏幕内容

```
content source ─▶ Container（离屏）─▶ RenderTexture（size）─▶ PerspectiveMesh(corners) ─▶ 屏幕溢光（add，亮度 = 内容平均亮度）
```

| 内容 | 怎么画 | 数据来源 |
| --- | --- | --- |
| `clips` 短视频 | 竖屏帧序列按 `fps` 播放；每 8–15 秒（或聊天说「下一个」）上滑 0.35 秒切到下一条；右侧画点赞 / 评论图标和数字，底部一行标题 | 包里的 `dafeiyu-clips.webp`（每条 24 帧 × 360×640 量化到 webp，约 20 条 ≈ 3 MB）；标题来自 `content.clips.list` |
| `page` 网页 / 文档 | 模板：地址栏、标题、若干行文字块（灰条）、一张配图；工作时逐行「打字」，行数随活动进度增长（沿用 `room@1` 的 `screen-type` 思路） | 模板来自 manifest；`{query}` 由聊天带入（「搜一下明天天气」→ 搜索框里写「明天天气」） |
| `player` 正在播放 | 封面、歌名、歌手、进度条（按 `seconds` 走）、20 根频谱柱（伪随机 + 低通） | `content.player.tracks`；应用里有本地音乐库（MiniMax 音乐功能，`feat/t-5088-minimax-music`）落地后，可改读她最近生成 / 播放的歌名（只读标题，不播声音） |
| `game` | 帧序列小游戏画面 | 包里的帧 |
| `chat` | 她和你最近 3 条聊天 | 主进程推来的已有聊天记录（只在工作状态可选） |
| `lock` | 锁屏：时间、日期 | 本机时间 |

- 四角透视：`PerspectiveMesh` 的 `setCorners(x0,y0,…,x3,y3)` 直接用 manifest 的 `corners`；网格细分 10×10，足够消除仿射扭曲。屏幕在图上被手 / 头挡住的部分：给 `screens[].occluder`（可选，一个 parts 图集里的前景贴片），画在网格之上。
- 安全与 CSP：游戏页的 CSP 只允许 `self / data / blob / pack / game`，内容全部本地生成或来自包；不嵌 webview、不播远程视频、不显示网页真实内容。参考里真实抖音窗口的效果用「刷视频」帧序列近似（对照清单 R-13 写明这一点）。

---

## 8. 聊天驱动

### 8.1 链路

```
游戏窗口聊天栏 ──game:chat──┐
桌面聊天框（她在桌面时）───chat────┤
设置 → 聊天（当前桌宠）──chatAs──┘
                                ▼
PetService.chat(text, …, { via })
  1. 房间开着（scene.gameId 对应的包是 illustrated-room@1）→ RoomIntent.matchRoomIntent(text, room.intents, { state, lamp })
  2. 命中 → games.roomCommand(id, { state, lamp, screen, query, from: 'chat' })
       → room-play 结算上一项 / 开始这一项 → 推 game:room-command 给游戏窗口（立刻开始交叉淡化，不等模型）
  3. persona.buildChatPrompt(body, c, t, { room: roomNote }) —— roomNote 例：
       「[房间] 你在自己的房间里。主人刚让你去书桌前打开电脑刷短视频，你已经坐到书桌前了，屏幕上正在放『深海里的水母』。台灯开着，窗外在下雨。用一两句话回应主人，像刚做完这件事。」
  4. _runTurn（和平时同一条 Responses / lh run 链路）→ 回复
  5. 回复末尾的〔房间:xxx〕标记（第二阶段）→ 剥掉标记再显示；xxx 是合法状态就再发一次 roomCommand
  6. _say → 聊天记录；游戏窗口通过 game:say 收到流式文本，显示在房间气泡里
```

- **为什么先切再回复**：参考里她先做事再说「回来了，躺下了」；模型回复要 1–5 秒，先切画面让用户马上看到反馈。模型失败或预算用完时用 `lines.ack.<state>` 兜底，状态照样切。
- **为什么规则而不是工具调用**：`PetService._runTurn` 只有在开了本机能力时才带工具（`_tools()`），直连 Responses 的默认路径 `tools: []`；`dance-intent.js` / `vrm-motion-intent.js` 已经验证规则识别在这个产品里够用、零成本、可预测。工具调用作为以后的选项：本机能力开着时，可以注册一个 `room_set_state` 工具，由 `_tools()` 在房间开着时附加。
- **〔房间:xxx〕标记**（第二阶段，覆盖规则没命中的说法，例如「你看起来好累」→ 她自己决定去睡）：`roomNote` 里告诉模型「如果你决定换一件事做，在回复最后单独写〔房间:sleep|work|phone|music|game|idle〕」，主进程用 `/〔房间:([a-z-]+)〕\s*$/` 解析并剥除；显示和聊天记录里都不留标记。只认 `states` 里的 key。
- **没开房间时**：意图不识别，聊天和平时完全一样。

### 8.2 `room-intent.js` 规则

和 `dance-intent.js` 同结构：

1. 长度 > 60 字 → 不是指令（是聊天）。
2. 否定 / 疑问不算：`不想睡`、`别玩手机了`（`别…了` 算「停止」→ 回 `idle`）、`你睡了吗`（问句，含「吗 / 么 / ？」且没有祈使词）。
3. 祈使词 + 状态词：`(去|回|来|快|先|现在|帮我|你)?…(吧|一下|一会儿)?`；状态词来自通用词表 + `room.intents`。
4. 屏幕词（`刷抖音 / 刷视频 / 网页 / 搜一下X / 放首歌`）决定 `screen`，并推出状态：刷抖音 + 「电脑」→ `work` 状态、屏幕 `clips`（参考「打开电脑刷抖音」）；刷抖音不带「电脑」→ `phone`。
5. 台灯：`开灯 / 把灯打开` → `lamp: true`；`关灯` → `lamp: false`；可以和状态同时命中（「关灯睡觉吧」）。
6. 返回 `{ state, lamp, screen, query, stop }`；测试用参考录屏里的原句：「回床上休息吧」→ sleep，「现在去试一下打开电脑刷抖音吧」→ work + clips，「现在回床上休息吧，不玩了」→ sleep（`不玩了` 不触发否定，因为有更强的「回床上」祈使），「大肥鱼，能收消息吗」→ null。

### 8.3 游戏窗口聊天栏

- 位置：画面底部、状态栏上方，一行输入框，占位「和大肥鱼说点什么…」，Enter 发送；发送中禁用并显示「她在想…」；回复显示在她的气泡里（流式），也写进她的聊天记录（`via: 'game'`）。
- 桥：`game-preload.js` 加 `chat(text)` → main `ipcMain.handle('game:chat')` → `service.chat(text, [], [], { origin: 'user', via: 'game' })`；`busy` 时返回 `busy`，栏上提示「她还在回上一句」。
- 未登录 / 离线：聊天栏显示「登录 LobeHub 后可以在这里和她说话」，状态栏点选照常可用（R-15）。

---

## 9. 直接点选与数值面板

- **状态栏**（底部居中，图标 + 文字）：睡觉 / 工作 / 看手机 / 听音乐 / 打游戏 / 发呆，当前项高亮并显示细进度条；右侧台灯开关。点了走 `roomCommand(from: 'click')`，和聊天同一路径。
- **画面热点**：床、手机、书桌、台灯；悬停描一圈柔光边 + 指针旁小标签「睡觉 · 床」。
- **数值胶囊**：标题栏右侧「⚡72 ♥64」两个数字，点开下拉卡片（四条横条 + 上一件 + 今日小事）；默认收起，活动结算时胶囊数字跳动 1 秒。不再常驻右上角面板。
- 键盘：`1–6` 切状态，`L` 台灯，`/` 聚焦聊天栏，`Esc` 收起卡片。

---

## 10. 像素房间改名

| 位置 | 改成 |
| --- | --- |
| 游戏仓库目录 | `games/her-room/` → `games/pixel-room/`（`art/`、`pack/`、`screenshots/`、`cover.webp` 一起移动，文件内容不变） |
| `games/pixel-room/pack/manifest.json` | `id: "pixel-room"`、`name: "像素房间"`；`engine: "room@1"`、`themes`、`activities`、图片全部不变；`version` 保持 1.0.0（从未发布过） |
| `games/pixel-room/store.json` | 文案里「她的房间」改「像素房间」，`minAppVersion` 不变 |
| `catalog.json`（游戏仓库） | 条目 `id: "pixel-room"`、`name: "像素房间"`、`file: "pixel-room-1.0.0.zip"`、`repo` / `picture` / `screenshots` 路径改 `games/pixel-room/` |
| 应用 `src/core/game-catalog.json`、`src/renderer/catalog/games/` | `node scripts/sync-game-catalog.js` 重新生成 |
| 应用 `docs/her-room.md` | 改名 `docs/pixel-room.md`，标题「像素房间（engine `room@1`）」，`docs/img/her-room/` → `docs/img/pixel-room/` |
| 应用 `test/fixtures/games/her-room/`、`e2e/her-room-accept.js` | 改名 `pixel-room`，断言里的游戏名改「像素房间」；引擎回归 `e2e/mini-room.js` 不变 |
| 游戏仓库 `tools/game-pack.js` 等脚本里写死的 `her-room` 路径 | 跟着改 |

不改：`room@1` 引擎、`room-pack.js` 规则、美术、数值、`.progress` 结构。`her-room` 这个 id 留给插画版。
注意：本方案写作时，应用 `~/develop/pixel-pet-t10801` 和游戏仓库 `~/develop/rdmclin2/pixel-pet-mini-games` 工作区里已经有另一项任务未提交的改名改动（目录已移到 `games/pixel-room/`，目录条目已是 `pixel-room` / 「像素房间」），与本节一致；改名由那项任务交付，本任务没有改动它们。

---

## 11. 美术流程

### 11.1 工具

- 生图：`lh generate image -m gpt-image-2.5-sunburst -p lobehub`（和 `games/her-room/art/prompts.json`、`scripts/generate.sh` 用的同一个模型）。该模型支持 `imageUrls`（参考图 / 编辑模式）、`size`（`2048x1152` 是 16:9）、`quality=high`（`lh generate image-params -m gpt-image-2.5-sunburst -p lobehub` 已核对）。
- `scripts/generate.sh` 扩展：job 可写 `"refs": ["art/ref/dafeiyu-sheet.png", "art/raw/dafeiyu-base-off.png"]`，脚本先 `lh file upload` 拿到 URL，再 `--param imageUrls=[…]`。仍是一次一张、间隔 20 秒。
- 后处理 `scripts/illustrated_post.py`（新）：缩放到 1920×1080、对齐（OpenCV ECC 仿射，参考底版）、静止区域差异检查、导出 webp（q=88）、裁眨眼贴片、生成 `light-mask`。

### 11.2 出图顺序

1. **角色设定图** `dafeiyu-sheet`（2048×2048）：大肥鱼 Q 版三视图（正 / 侧 / 背）+ 4 个表情（睁眼、闭眼、半闭犯懒、笑），蓝色长发、呆毛、白色荷叶边女仆头饰、鳍状耳饰、深蓝女仆裙、白围裙、领口蝴蝶结、深蓝鲸鱼尾巴；以现有角色包（`src/renderer/packs/dafeiyu-pixel`、`docs/img/characters/dafeiyu-desktop.png`）为参考图。人工确认后**冻结**，之后每张都带它。
2. **空房间底版** `dafeiyu-base-off`：斜上方 45° 俯视，深夜下雨，蓝色月光；左上横窗（窗外城市光斑虚化）、左中单人床（揉皱的被子堆在床尾、两个枕头）、右上书桌（合着的笔记本电脑、成摞的书、摊开的笔记本和笔、散落的纸、小药瓶、马克杯、台灯）、书架、墙上贴的纸条和软木板、右下搭着外套的转椅、墙角衣架、桌下机箱、垃圾桶、木地板；**没有人**。
3. **底版开灯** `dafeiyu-base-lit`：输入底版，编辑「只把书桌上的台灯打开：暖黄光照亮桌面、墙、书架和附近地板，床和窗户一侧保持蓝色月光，其它一切不变」。
4. **每个状态的 off 图**：输入 `base-off` + 设定图，编辑「把这个角色放进房间：<姿势>，保持房间、镜头、光照完全不变」。姿势表：

   | 状态 | 姿势提示 |
   | --- | --- |
   | `idle` | 坐在床中间，双手撑床，抬头看镜头，手机放在身边亮着 |
   | `idle-lazy` | 同位置，眼睛半闭、肩膀垂下、头微歪，犯懒 |
   | `sleep` | 侧躺在床上盖着被子，闭眼，尾巴从被子边露出 |
   | `phone` | 侧趴在床上，双手举着手机，手机光照亮脸 |
   | `music` | 靠坐在床头，戴着大耳机，闭眼轻晃，手机放在腿上 |
   | `work` | 背对镜头坐在书桌前的转椅上，打开的笔记本电脑，双手在键盘上（椅子上的外套挪到椅背） |
   | `game` | 背对镜头侧身坐在书桌前，双手握游戏手柄，身体前倾 |
   | `stand` | 背对镜头站在书桌和床之间，一只手扶着椅背，尾巴可见 |

5. **每个状态的 lit 图**：输入该状态的 off 图 + `base-lit`，编辑「按第二张图的台灯光照重新打光，角色也被暖光照到，其它不变」。
6. **眨眼贴片**：输入状态图，编辑「只把她的眼睛改成闭眼，其它像素不变」，后处理只裁出眼睛矩形（差异区域自动检测）。
7. **小素材**：光斑、雨珠、台灯光晕用程序生成（径向渐变），不出图；短视频帧、封面、游戏画面用 gpt-image 单独出（竖屏 1024×1536 → 缩到 360×640）。

### 11.3 角色一致性

- 每次编辑都带同一张冻结的设定图 + 底版两张参考图；提示词里固定一段角色描述（逐字复制）；每张单独出 2 次，挑一致性最好的。
- 检查（`illustrated_post.py --check-character`）：把每张状态图里她的脸部裁出来和设定图并排拼成一张对照图，人工过一遍 R-09；发色用色相直方图比对（蓝发主色相差 > 12° 就重出）。

### 11.4 对齐与验收

- ECC 对齐到底版，静止区域（排除角色和 `lit` 的光照区域）平均像素差 < 4/255 才算通过；不通过的重出，或改用 `light-mask` 只在台灯附近混合。
- `node tools/game-pack.js games/her-room` 校验，`python3 scripts/room_preview.py`（扩展支持新引擎）出每个状态 off/lit 的静态对照图，再到应用里真机看。

---

## 12. 实施拆分（建议的后续任务）

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| A 引擎与包格式 | `illustrated-room-pack.js` + 测试（用 `docs/data/illustrated-room-manifest.example.json`）、`game-pack.js` 分派、`engines/illustrated-room.js` 图层栈、光照、雨、光斑、呼吸眨眼、交叉淡化、热点、状态栏、数值胶囊、最小测试包 + e2e | — |
| B 屏幕内容 | `screen-content.js`：clips / page / player / game / lock，`PerspectiveMesh` 贴图 + 溢光 | A |
| C 聊天驱动 | `room-intent.js` + 测试（参考录屏原句）、`PetService.chat` 接入、`game:chat` / `game:say`、聊天栏、提示词房间上下文；第二阶段〔房间:〕标记 | A |
| D 美术与包 | 设定图、底版、8 个状态 × off/lit、眨眼贴片、短视频帧；`generate.sh` 支持参考图、`illustrated_post.py`；`games/her-room/` 新包、store.json、截图 | A 的格式定稿 |
| E 像素房间改名 | §10（另一项任务已在做） | — |
| F 上架与验收 | build、publish 到 CDN、sync 目录、商店下载 → 开始玩 → 按 §2 对照清单逐条截图 / 带章节录屏 | A–E |

## 13. 风险

| 风险 | 应对 |
| --- | --- |
| 编辑模式改了房间里不该改的东西，状态之间静止部分不对齐 | 对齐 + 差异检查（§11.4）；不过关重出；最坏情况用 `light-mask` / 角色区域遮罩只混合局部 |
| 角色在不同图里走样 | 冻结设定图 + 固定描述 + 每张出 2 次挑选 + 对照图人工审 |
| 包体积（18 张 1920×1080） | webp q=88 约 300–400 KB/张；整包 ≈ 8 MB；按需加载状态图 |
| 规则误识别（聊天里提到「睡觉」不是指令） | 长度、问句、否定过滤；只在房间开着时生效；误切时一句话就能切回 |
| 软件渲染帧率 | 屏幕内容降频更新、窗口隐藏停 ticker、光斑 / 雨数量按 fps 自适应 |
