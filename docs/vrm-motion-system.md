# VRM 独立交互与动作体系（与像素角色解耦）设计

> 状态：设计稿（T-2677）；姿势系统 + idle 待机 + 男女风格已实现（T-2678，见 §11）　分支：`feat/vrm-motion-system`（基于 `origin/canary` 7bae23a / v0.19.0）
> 本期范围：姿势系统、idle 待机、交互反应、表情层、口型层，并按男性/女性风格区分。**舞蹈本期不做。**
> 素材来源：`~/vrm-assets/`（素材清单 `~/vrm-assets/INVENTORY.md`，前一任务产出）。**所有模型与动作仅限个人使用，不进 git、不进安装包。**
> 参考：[lobe-vidol](https://github.com/lobehub/lobe-vidol) 只借鉴功能思路（姿势库按性别/类别分组、触摸区域 → 按性别的「表情 + 动作 + 台词」列表），**不使用其任何实现代码**；Mixamo 重定向的数学是公开的骨骼空间换算（见 §4.3），由我们自己实现。

---

## 0. 读法与名词

| 名词 | 含义 |
|---|---|
| 共享状态 | `src/core/fx.js` 的 `STATES`（idle/look/happy/pat/sad/hungry/sleep/eat_*/think/talk/play/hatch/evolve/lifted/walk）与 `touch-<zone>`，由 `src/renderer/app.js` 的 `petStatus()` 按优先级算出。像素 / 图片 / rig / live2d 继续用它。 |
| 语义事件（VRM intent） | 本设计新增：从 app 的同一份数据（状态、触摸、拖拽、说话…）提炼出的「发生了什么」，**不含任何动作指令**。只发给 VRM。 |
| VRM 导演（director） | 本设计新增的纯逻辑控制器：收语义事件，按风格（style）和素材库决定此刻的姿势 / 待机 / 反应 / 表情 / 视线。 |
| 素材库（motion library） | 本机用户数据目录里烘焙好的 `.vrma` 片段 + `library.json` 索引。仓库只存不含二进制的元数据。 |
| style | 风格配置：`female` / `male` / `neutral`（可扩展），决定选哪套姿势与动作、幅度、重心、手型。 |
| 素材路径 | 文中所有素材路径均相对 `~/vrm-assets/`（开发机默认的 `$PIXELPET_VRM_ASSETS`），每一条都在 INVENTORY.md 中登记且文件存在（§9 附核对方法与结果）。 |

---

## 1. 现状与问题（为什么要解耦）

现有 VRM 渲染（v0.19.0）把为像素角色设计的状态机原样套到 3D 骨骼上：

1. **状态 → 程序化骨骼动作的硬映射**：`src/core/vrm-motion.js` 的 `STATE_LOOKS` / `TOUCH_LOOKS` / `MOOD_LOOKS` 把每个共享状态翻译成 `hop`、`spin`、`dangle`、`wobble`、`shake`、`stride`、`armsOut`… 再由 `pose()` 换算成骨骼欧拉角。例如：
   - `happy: { hop: 0.6, armsOut: 0.5 }`、`play: { hop: 0.8, spin: 1, sway: 0.6, armsOut: 0.8 }` —— 3D 人形每 3 秒原地转一整圈、根节点上下弹跳；
   - `lifted: { dangle: 1 }` —— 四肢以 11 Hz 正弦乱甩（`flail = dangle * sin(t*11) * 14`）；
   - `butt: { hop: 1.2, armsOut: 0.8 }` —— 被碰到臀部会「蹦起来张开手」，完全是像素小人的夸张语言。
2. **idle 动画只是「垫底」**：`vrm.idle`（一段 `.vrma`）存在时，`applyOverClip` / `poseOffsets` 仍把上面这些程序化偏移叠加在片段上，片段越自然，叠加的跳/转就越违和。
3. **像素式 CSS 动画也作用在 VRM 画布上**：VRM 画布的 class 是 `char sprite rig vrm`，`src/renderer/style.css` 中
   `.char-wrap[data-status="happy"] .char { animation: char-hop … }`、`[data-status="pat"] … char-squish`、`[data-status="sad"] … transform: rotate(-3deg)`、`[data-status="sleep"] … rotate(-4deg)`，以及 `.pet-body.lifted { animation: pet-dangle }`、`.pet-body.squash`、`.pet-body[data-facing="left"] .char { scale: -1 1 }` 全部匹配 VRM 画布 —— 3D 角色被整体压扁、旋转、镜像（镜像会把不对称的发型/饰品左右翻转）。
4. **没有姿势、没有待机变化、没有性别差异**：所有模型共用同一套幅度；待机永远是同一个姿态 + 正弦呼吸。

结论：VRM 需要一条**独立的「事件 → 决策 → 分层播放」管线**，像素路径保持原样。

---

## 2. 解耦边界

### 2.1 不变的部分（行为必须逐字节不变）

| 模块 | 约束 |
|---|---|
| `src/core/fx.js`（STATES、FALLBACK、IDLE_CUES、touch/lift/throw/squash 逻辑） | **不改**。像素/图片/video/rig/live2d 继续用 `petStatus()` 的状态字符串与 `fx.render()`。 |
| `src/core/touch-zones.js`（ZONES、`reactionFor` 的 mood/tier/streak、MOOD_FX、MOOD_DELTA、好感计分） | **不改**。VRM 只*读取*它产出的 `lastTouch {zone, mood, n}` 与 tier。触摸的好感、台词、语音逻辑对所有角色相同。 |
| `src/core/pet-state.js`（status/needs/tick） | **不改**。VRM 只读 `view.status`。 |
| `src/renderer/rig.js`、`src/renderer/live2d.js`、`src/renderer/fx.js`、精灵图 `drawSprite`、`playClip` | **不改**。 |
| `app.js` 的 `petStatus()`、`animatePet()` 对非 VRM 外观的分支、`#char-wrap[data-status]`、`#char-fx` emoji 覆盖 | **不改**（VRM 下 emoji 覆盖仍按 `RIG_OVERLAY` 显示食物/思考/z 气泡，这是 UI 不是骨骼）。 |
| 台词、TTS、好感、成就、服饰/18+ 规则、`pack://` 安全边界 | **不改**。 |

### 2.2 VRM 只接收语义事件

`app.js` 的 `tickRigs()` 对 `look.kind === 'vrm'` 的 figure 不再传 `state` 字符串，而是传一份**只读快照**，由纯函数 `core/vrm-intent.js` 转成语义事件：

```js
// app.js（仅 VRM 分支，示意）
const snap = {
  t: now / 1000,
  status: view.status,                // 'idle' | 'happy' | 'sad' | 'hungry' | 'sleep'（pet-state 的需求状态）
  shot: fx.current(now),              // fx 一次性镜头：'pat' | 'look' | 'turn' | 'play' | 'happy' | 'hatch' | 'evolve' | 'touch-<zone>' | null
  lifted: fx.lifted, flying: fx.flying,
  thinking, eating,                   // app 现有变量
  talking: now < talkUntil, voice: voiceNow(),
  walking: fx.walking,
  touch: lastTouch,                   // { n, zone, mood }（touch-zones.reactionFor 的结果），n 单调递增 → 边沿触发
  facing: $('pet-body').dataset.facing,
  pointerInside,
  win: [window.screenX, window.screenY],
};
r.figure.draw(snap);                  // rig/live2d 仍是 r.figure.draw({ t, state, mood, … })，不变
```

`VrmIntent.fromSnapshot(snap, prev)` → `{ holds, events }`：

| 语义事件 / 持续量 | 来源（共享数据） | 类型 |
|---|---|---|
| `mood:<idle\|happy\|sad\|hungry\|sleep>` | `snap.status` | 持续（基线情绪、姿势偏好） |
| `touch:<zone>`，带 `mood`（happy/ticklish/shy/annoyed/angry）与 `streak` | `snap.touch.n` 变化（`reactionFor` 已算好） | 边沿（一次性） |
| `touch:pat` | `shot === 'pat'`（关闭部位触摸时的普通点击） | 边沿 |
| `drag:lift` / `drag:drop` / `drag:thrown` | `lifted \|\| flying` 的上升沿 / 下降沿（`flying` 期间下降沿 = thrown） | 持续 + 边沿 |
| `talk` | `talking \|\| voice` | 持续 |
| `think` | `thinking` | 持续 |
| `eat:<rice\|cookie\|fruit>` | `eating` | 持续 |
| `walk` | `walking` | 持续 |
| `cue:<look\|turn\|play\|happy>` | `shot` 为 fx 的 idle 线索 | 边沿（**提示**，导演可选择以符合人设的方式回应，不必照做） |
| `celebrate:<hatch\|evolve>` | `shot` | 边沿 |
| `attention:<on\|off>` | `pointerInside` | 持续（光标靠近 → 抬头看人、从坐姿站起） |
| `facing:<left\|right>` | `data-facing` | 持续（VRM 用身体朝向偏转表达，不做镜像） |

关键原则：**事件里没有 hop/spin/dangle 这种「怎么动」的词**；「怎么动」完全由 VRM 导演 + 素材库决定。

### 2.3 去掉强加在 VRM 上的像素式表现

- `style.css` 新增豁免：`.char.vrm { animation: none !important; transform: none !important; scale: none !important; filter: none; }`，以及 `.pet-body[data-kind="vrm"].squash, .pet-body[data-kind="vrm"].lifted, .pet-body[data-kind="vrm"].flying { animation: none; }`（`app.js` 在 `#pet-body` 上写 `data-kind`）。窗口本身的拖拽/抛掷位移（fx 的物理）保留 —— 那是窗口在动，不是骨骼。
- `vrm-motion.js` 删除 `STATE_LOOKS` / `TOUCH_LOOKS` / `MOOD_LOOKS` / `MOTIONS` / `REPEATING` / `calm` / `lookFor` / `pose` / `poseOffsets` / `motionMouth` 中的 hop/spin/dangle/stride/wobble/shake/sway/flinch/pop 等**程序化大动作**；保留并复用经过测试的 `resolveFace`、`FACE_FALLBACK`、眨眼、`gazeNdc`、口型（`visemesFromSpectrum`/`syntheticVisemes`/`smoothVisemes`）、帧预算（`frameMode`/`shouldRender`/`FpsMeter`）、`overClip`（解决 held key 回到 T-pose 的问题，见 §3.2）。
- 程序化只保留**「活人感」微动层**（呼吸、重心、头部微动、手指放松、被拎起时腿的重力下垂），并且有硬上限（单骨骼 ≤ 4°、根位移 ≤ 2 cm，见 §3.3），由单测守住（§8.1）。

### 2.4 管线总览

```
 app.js（共享状态，像素/rig/live2d 照旧）
   │  VRM 分支：只读快照 snap
   ▼
 core/vrm-intent.js      纯函数：snap + prev → { holds, events }            （无 three.js，单测）
   ▼
 core/vrm-director.js    纯状态机：事件 + style + library + rng → Plan       （无 three.js，单测）
   │   Plan = { posture, idle, reaction, hold, face, gaze, life, facingYaw, debug }
   ▼
 renderer/vrm-anim.js    three AnimationMixer 分层：base(lower/upper) · reaction(mask) · hold(mask)
   ▼
 renderer/vrm.js         life 叠加（overClip）→ 表情层 → 口型层 → lookAt → vrm.update → render
```

---

## 3. 动作层架构

### 3.1 分层与优先级

从下到上依次合成（上层覆盖或叠加下层）：

| # | 层 | 内容 | 来源 | 混合方式 |
|---|---|---|---|---|
| L0 | **基础姿势层 posture** | 静态站姿/坐姿（Mixamo 2 帧姿势定格成循环 hold） | 库 `kind: posture` | 全身动作，权重 1；切换姿势 0.8–1.2 s 交叉淡化 |
| L1 | **idle 层** | 待机循环变体（随机调度），替换或叠在 L0 上 | 库 `kind: idle` | 与 L0 交叉淡化（idle 片段本身就是全身站姿循环），或 `mask: upper` 时只替换上半身 |
| L2 | **持续活动层 hold** | 说话手势、思考、吃东西、被拎起、睡觉、走路 | 库 `kind: hold` | 按 mask（upper/arms/full）覆盖 L0/L1 对应骨骼，进入 0.3 s、退出 0.5 s |
| L3 | **反应层 reaction** | 一次性片段（摸头、戳脸、害羞、生气…），播完交叉淡化回 L1/L2 | 库 `kind: reaction` | 按 mask 覆盖，进入 0.2–0.3 s、退出 0.4–0.6 s；可截取 `trim` 区间、`hold` 末帧若干秒 |
| L4 | **活人感微动层 life** | 呼吸、重心微调、头部微动、手指放松、视线跳动、被拎时腿下垂 | 程序化（`core/vrm-life.js`） | mixer 之后**相对叠加**（四元数右乘），幅度有上限 |
| L5 | **表情层 face** | 基线情绪 + 反应情绪 + 眨眼 | `resolveFace` + 导演 | 表情权重 attack/release 缓动 |
| L6 | **口型层 lip** | aa/ih/ou/ee/oh | 现有 lip（音频频谱 / 合成节奏） | 直接写入；与情绪表情冲突时压低情绪的嘴部影响（§3.5） |
| — | 视线 lookAt | 光标 / 触摸点 / 思考向上 / 害羞看旁边 / 生气瞪人 | 导演给目标，`aim()` 实现 | three-vrm lookAt + 头颈跟随（L4） |

**上下半身拆分**：three 的 `PropertyMixer` 对同一骨骼的多个动作按权重归一化混合，直接把「上半身反应」叠在「全身姿势」上会得到 50/50 的平均。因此 `vrm-anim.js` 对每个基础片段生成两个动作：`base.lower`（hips 位移/旋转 + 腿）与 `base.upper`（脊柱以上 + 手臂 + 手指），带 mask 的 L2/L3 只与对应半身做 `crossFadeTo`（例如 upper 反应淡入时，`base.upper` 同步淡出到 0，结束后再淡回），下半身不受影响。mask 取值：`full` / `upper`（spine 起）/ `arms`（shoulder 起 + 手指）/ `head`（neck、head）。

### 3.2 idle 层：调度与「活人感」

**调度器**（`vrm-director.js` 内，注入 rng 以便测试）：

- 每段 idle 持续 `hold` 秒（片段自带时长的整数倍，至少 8 s，至多 20 s），之后从当前 style 的 idle 池按权重随机挑下一段，**不与上一段重复**；姿势循环变体（`idle.posture-cycle`）在 2–3 个站姿间换。
- 情绪偏置：`mood:happy` → 提高 `idle.happy` / `stand.confident` 权重；`mood:sad`/`hungry` → `stand.shy` + 呼吸放慢、头部下垂 3°；`mood:sleep` → `sit.doze` + `idle.sleep`。
- 长时间无人理（`attention:off` 且无事件 ≥ 180 s）→ 过渡到 `sit.rest`（女性可用「坐下」片段，见 §5.3）；光标进入窗口 / 有事件 → 站起（女性用「女の子座り→立ち上がる」，男性 1.0 s 交叉淡化）。
- fx 的 `cue:look` → 不转圈不跳，只是视线扫一圈 + 头跟随；`cue:turn` → 改朝向（身体偏转 ±18°，见 §3.6）；`cue:play` / `cue:happy` → 以小概率触发 `react.cheer`（女性）/ `react.happy-gesture`（男性）的低幅版本（amplitude 0.6），否则仅微笑。

**活人感细节（L4，`core/vrm-life.js`，所有参数随 style 缩放）**：

| 细节 | 规则（默认 female / male） |
|---|---|
| 呼吸 | 14–18 次/分（0.25 Hz ± 抖动）；female 胸式为主（chest 1.2°、upperChest 0.8°、肩 0.6°），male 腹式为主（spine 1.0°、chest 0.8°、肩 0.3°）；sleep 10 次/分、幅度 ×1.6；说话时呼吸相位跟随句间停顿重置 |
| 眨眼 | 现有 `nextBlinkIn`（2–6 s，20% 双眨）；另加：视线跳转 > 15° 时 30% 概率伴随眨眼；反应开始时眨一次；`happy/joy` 表情已闭眼时不叠加眨眼 |
| 视线 | 跟随光标（头部 35%、颈 15% 跟随，滞后 0.25 s）；每 0.8–3 s 一次 ±1.5° 微跳（saccade）；空闲时约 10% 时间看向别处 1–2 s；触摸时先看触摸点再看人；`shy` 看向斜下方；`angry` 盯人不眨 1.5 s |
| 重心微调 | 每 6–14 s 换一次支撑腿：hips 横移 ±1.5 cm（male ±0.8 cm）、hips roll ±2°、spine 反向 roll ±1°，1.5 s 缓动；只在站姿下 |
| 头部微动 | 3 个不可公度正弦叠加（0.13/0.31/0.47 Hz），±1°（male ±0.7°） |
| 手指 | 基础片段无手指关键帧时施加放松弯曲：female 0.3（拇指内收）、male 0.45（虚握） |
| 被拎起（drag:lift） | 腿部受重力下垂：upperLeg 前摆 ≤ 8°、lowerLeg 弯曲 ≤ 12°，随窗口速度做阻尼弹簧摆动（复用现有 `spring`），**不是正弦乱甩**；手臂由 hold 片段决定 |

`overClip` 复用：mixer 对「保持不变的关键帧」不会重写骨骼，叠加量会逐帧累积；现有 `M.overClip(memo, nodeOf, names, mixer, dt)` 已解决该问题（e864228），L4 对它触及的骨骼沿用同一套 memo 机制。

### 3.3 反应层：生命周期与打断

```
           事件 touch:head
 idle ──► [enter 0.25s 淡入] ─► play(trim a..b) ─► [hold 末帧 h 秒] ─► [exit 0.5s 淡出] ─► idle（或之前的 hold，如 talk）
                         ▲ 同区重复触摸：延长 hold（摸头时继续蹭），不重播
                         ▲ 更高优先级事件：以 0.2s 交叉淡化切走
```

- **优先级**：`drag:lift` > `touch:*` > `celebrate:*` > `think` > `eat` > `talk` > `cue:*` > idle。低优先级事件在高优先级动作期间丢弃（cue）或排队（celebrate 最多排 1 个）。
- **同区连摸**：`touch-zones` 已有 streak（3 次 annoyed、6 次 angry）；导演只按其给出的 `mood` 选反应：`happy` 时重复摸头 → 延长「蹭手」，`annoyed` → 换成不耐烦姿态，`angry` → 生气片段。不重复实现计数逻辑。
- **与持续层的关系**：反应 mask 为 `upper` 时，`talk` 的手势暂停、口型继续；`think` 被触摸打断后，若 `thinking` 仍为真，反应结束回到 think。
- **防抖**：同一反应 0.6 s 内不重新触发（避免连点抽搐），同一 idle 不连续两次。
- **回到 idle 的相位**：反应结束时 idle 片段从当前时间继续（不从 0 开始），避免明显「回弹」。

### 3.4 表情层

- **基线情绪**（来自 `mood:*`）：idle 0；happy → `happy 0.15`（若有 relaxed 用 relaxed）；sad → `sad 0.35`；hungry → `sad 0.2`；sleep → `blink 1 + relaxed 0.3`。
- **反应情绪**：每个反应条目自带 `face`（§5.4 表），attack 0.15 s、release 0.6 s，结束后回落到基线。
- 映射到模型实际表情名沿用 `resolveFace`（含 `vrm.expressions` 覆盖与降级：surprised→oh、relaxed→happy、angry→sad…）。liliya 为 VRM 0.x，表情预设 `a, angry, blink, blink_l, blink_r, e, fun, i, joy, neutral, o, sorrow, u`，three-vrm 映射为 happy(joy)/angry/sad(sorrow)/relaxed(fun)/aa/ih/ou/ee/oh/blink…；**没有 surprised** → 走 `oh` 降级。
- style 缩放：male 情绪强度 ×0.8（更克制），female ×1.0。

### 3.5 口型层

- 保持现有实现（音频 AnalyserNode 频谱 → 元音；系统语音 → 合成音节节奏；平滑 attack 24 / release 14）。
- **冲突规则**：说话时，嘴部受影响大的情绪（VRoid 的 `joy`/`fun` 会改变嘴形）上限压到 0.5，眼部情绪不变；元音能量峰值带动头部 ±1.5° 点头（L4），代替原来的 `nod` 正弦。
- `eat:*`：咀嚼由口型层生成（`aa` 0–0.6，约 1.4 Hz），不再驱动骨骼 `chew`。

### 3.6 朝向、落地与取景

- **朝向**：VRM 不做 CSS 镜像；`facing:left/right` → 身体 yaw 偏转 ±18°（0.6 s 缓动）+ 视线同向，走路时 yaw 加大到 ±60°。
- **落地**：切换姿势后计算最低的 foot/toes/hips 世界坐标，平移根节点使其贴地（坐姿时臀部贴地）；相机仍按站姿身高取景（不随姿势缩放，坐下就是变矮）。
- **触摸命中**：本期沿用 `zoneAtClient`；坐/蹲姿下头的位置会变，P1 增加 `figure.zoneRects()`（把 humanoid 骨骼投影到画布得出 head/face/chest/hands/belly/butt/legs/feet 的矩形），`app.js` 的 `zoneAtClient` 在 VRM 外观下优先用它。像素角色的命中逻辑不变。

### 3.7 素材格式与加载 / 重定向方案

**运行时只认一种格式：`.vrma`（VRM Animation）**。理由：vendor 里已有 `VRMAnimationLoaderPlugin` + `createVRMAnimationClip`（three-vrm-animation 3.5.5），它负责把 humanoid 动画套到任意 VRM（含 VRM 0.x 坐标翻转、hips 高度缩放）；渲染进程不用打包 FBX/VMD 解析器；加载快、可缓存；用户也可以直接投放自己的 `.vrma`。

其它格式在**离线烘焙**阶段转成 `.vrma`（`scripts/vrm-bake.js`，Node 运行；像 `scripts/build-vrm-vendor.js` 一样在临时目录安装锁定版本的 `three@0.187.0`，不给应用增加运行时依赖）：

| 源格式 | 数量（清单） | 本期 | 转换方案 |
|---|---|---|---|
| Mixamo FBX（`postures/` 128、`mixamo/` 2051，骨骼 `mixamorig:*`） | 姿势、idle、反应主力 | ✅ P0 | three `FBXLoader.parse()`（**已验证可在 Node 中直接解析**：`mixamo/c9c98a38-b96c-11e4-a802-0aaa78deedf9.fbx` → 65 骨骼、10.000 s、53 轨道；`postures/2278ba9c-6878-472c-b329-a340c0ec29c1.fbx` → 0.033 s、53 轨道）。重定向见下。 |
| VMD（`motions/`，MMD 日文骨骼，30 fps） | 害羞/说话/睡觉/坐下等女性向片段 | ◐ P1 | 自写 VMD 解析（111 B/骨骼帧，`TextDecoder('shift_jis')` **已验证**可读出 `右腕/右ひじ/上半身2/センター…`）+ MMD→VRM 骨骼映射；见下。 |
| BVH（`motions/07_08.bvh`，CMU） | 1 | ❌ | 不用。 |
| PMX / 舞蹈 VMD（`dances/`） | — | ❌ | 本期不做。 |

**Mixamo → VRM 重定向（烘焙时一次性完成）**

1. 骨骼名映射（去掉 `mixamorig` 前缀）：`Hips→hips, Spine→spine, Spine1→chest, Spine2→upperChest, Neck→neck, Head→head, {Left,Right}Shoulder→{l,r}Shoulder, …Arm→…UpperArm, …ForeArm→…LowerArm, …Hand→…Hand, …UpLeg→…UpperLeg, …Leg→…LowerLeg, …Foot→…Foot, …ToeBase→…Toes`，手指 `…HandThumb1/2/3→…ThumbMetacarpal/Proximal/Distal`、`…HandIndex1/2/3→…IndexProximal/Intermediate/Distal`（Middle/Ring/Pinky 同理）。
2. 旋转：Mixamo 骨骼带非单位静止旋转，VRM normalized humanoid 的静止姿态全为单位旋转。对每个关键帧 `q`：`q_vrm = Q_parentWorldRest · q · Q_worldRest⁻¹`（`Q_worldRest` 为该骨骼在 FBX 静止姿态下的世界旋转，`Q_parentWorldRest` 为其父骨骼的），得到「相对 T-pose 的世界对齐旋转」。
3. 位移：只保留 hips 位移；按 `vrmaRestHipsY / mixamoRestHipsY` 归一（`.vrma` 内写入 humanoid 静止 hips 高度，`createVRMAnimationClip` 运行时再按目标模型 hips 高度缩放）。
4. 写出 `.vrma`：glTF 2 二进制，节点树为 VRM humanoid 静止姿态，`extensions.VRMC_vrm_animation.humanoid.humanBones` 指向节点，动画通道为 rotation（全部骨骼）+ translation（仅 hips）。产物用现有 `inspectVrmaJson`（`src/core/vrm.js`）校验。
5. 烘焙参数（来自库条目）：`trim [a,b]`（截取片段）、`loop`（首尾 0.2 s 交叉混合消除跳变）、`mask`（写出时裁掉不需要的骨骼轨道）、`amplitude`（相对 posture 的旋转缩放，slerp(identity→delta, k)）、`mirror`（左右互换，用于镜像变体）。

**VMD → VRM（P1）要点**：骨骼映射 `センター/グルーブ→hips 位移、下半身→hips 旋转（与上半身反向补偿）、上半身→spine、上半身2→chest、首→neck、頭→head、左肩→leftShoulder、左腕(+左腕捩 合并)→leftUpperArm、左ひじ→leftLowerArm、左手首(+左手捩 合并)→leftHand、左親指０/１/２→leftThumb Metacarpal/Proximal/Distal、左人指１/２/３→leftIndex…、左足→leftUpperLeg、左ひざ→leftLowerLeg、左足首→leftFoot`；左手系→右手系（位置 z 取反、四元数 x/y 取反）；MMD 绑定姿态为 A-pose，手臂旋转先乘上 A-pose 偏移（约 ±35°，烘焙时从映射表常量补偿）；单位 1 MMD ≈ 0.08 m。多数 VMD 腿部由 `足ＩＫ` 驱动、FK 腿无关键帧（`talk/xs-talk8-west-negotiate.vmd` 含 `左足ＩＫ/右足ＩＫ`），因此 **VMD 片段一律按 `mask: upper` 使用**，腿部来自当前姿势；需要全身的（坐下/站起）在 P1 实现简单两骨 IK 求解后再开放，未完成前用对应 Mixamo 姿势交叉淡化代替（§5 中已给出降级素材）。

**素材库索引 `library.json`（烘焙产物，放在用户数据目录）**：

```jsonc
{
  "schema": 1,
  "clips": {
    "stand.relaxed@female": { "kind": "posture", "file": "female/stand.relaxed.vrma", "src": "postures/2278ba9c-6878-472c-b329-a340c0ec29c1.fbx", "loop": true },
    "react.touch-head@female": { "kind": "reaction", "file": "female/react.touch-head.vrma", "src": "postures/ba625166-2370-4260-ae47-0c49e3616309.fbx",
      "mask": "upper", "amplitude": 0.55, "hold": 1.6, "fadeIn": 0.25, "fadeOut": 0.5, "face": { "relaxed": 0.8, "happy": 0.4 } }
  }
}
```

仓库里提交的是**烘焙清单** `src/core/vrm-library.json`（同结构，只有 id、kind、style、`src` 相对路径、trim/mask/amplitude/face 等元数据，**不含任何二进制**），烘焙脚本据此从 `$PIXELPET_VRM_ASSETS` 取源文件、写出 `.vrma` 与 `library.json`。

---

## 4. 性别 / 体型风格（style）

### 4.1 风格配置

`core/vrm-style.js` 定义可扩展的风格档案，导演与 life 层只读档案参数：

| 参数 | female | male | neutral（推断不出时） | 作用 |
|---|---|---|---|---|
| `set` | `female` | `male` | `female` 姿势 + `male` 幅度的折中（取库中 `neutral` 条目，缺省回退 female） | 选哪一套姿势/idle/反应 |
| `amplitude` | 1.0 | 0.8 | 0.9 | 反应与手势的整体幅度（烘焙后运行时再缩放） |
| `hipSway` | 1.0（hips roll ±2°、横移 ±1.5 cm） | 0.5（±1°、±0.8 cm） | 0.75 | 重心微调 |
| `stanceWidth` | 0（并腿，膝略内收 2°） | +4°（upperLeg 外展，双脚与肩同宽） | +2° | 站姿重心与脚距（叠加在 posture 上） |
| `handPose` | 放松微弯 0.3，拇指内收，手腕微内旋 5° | 虚握 0.45，手腕中立 | 0.38 | 手部姿态 |
| `headTilt` | 偏头倾向 ±4°（反应时更爱歪头） | ±1.5° | ±3° | 头部表达 |
| `breath` | 胸式（chest 1.2°） | 腹式（spine 1.0°） | 混合 | 呼吸 |
| `emotion` | ×1.0 | ×0.8 | ×0.9 | 表情强度 |
| `idleBias` | 姿势循环更频繁（12 s），更多「看向别处」 | idle 片段更长（18 s），视线更稳 | 15 s | 调度节奏 |

扩展：`pack.json` 可写对象形式 `"style": { "base": "female", "amplitude": 0.7, "hipSway": 0.6 }`（例如「文静少女」「元气少年」），未写的字段继承 base；数值越界按 `VRM_STYLE_LIMITS` 夹住（单测覆盖）。

### 4.2 指定与推断（优先级从高到低）

1. **pack.json 显式指定**：`vrm.style: "female" | "male" | "neutral" | { base, …overrides }`；`vrm.motions`（可选）按 id 覆盖某个槽位用哪个库条目，例如 `{ "react.touch-head": "react.touch-head@male" }`。由 `src/core/packs.js` 校验（未知 style / 未知槽位 → 拒绝并说明）。
2. **导入时写入**：`导入 VRM 模型…` 的确认页增加「动作风格：女性 / 男性 / 中性」选择，默认值来自下面的推断，写进生成的 `pack.json`（`src/core/vrm-import.js` → `vrmManifest({ style })`）。
3. **从 VRM 文件推断**（VRM meta 本身**没有性别字段**，0.x 与 1.0 都没有；仓库中角色/人设也没有性别字段）。`src/core/vrm.js` 的 `inspectVrmJson` 增加 `body` 读数：
   - `bustSpring`：SpringBone（0.x `secondaryAnimation.boneGroups` / 1.0 `VRMC_springBone`）里引用的名称含 bust/breast 的骨骼数；
   - `shoulderHip`：左右 upperArm 间距 ÷ 左右 upperLeg 间距（由 humanoid 骨骼节点平移累加得出）。
   - 规则：`bustSpring > 0 → female`；否则 `shoulderHip ≥ 1.5 → male`；否则 `neutral`。
   - **用清单中的真实模型实测**（脚本只读 GLB JSON 头）：

     | 模型（目录 models/模型文件/） | 角色 | bustSpring | shoulderHip | 推断 |
     |---|---|---|---|---|
     | `莉莉雅/liliya.vrm` | 莉莉雅（女） | 2 | 1.41 | female ✅ |
     | `vroid.vrm` | VRoid 自制男性 | 0（有 `J_Sec_*_Bust` 节点但未挂 SpringBone） | 1.57 | male ✅ |
     | `3025277208146426578.vrm` | Wanderer（男） | 0 | 1.94 | male ✅ |
     | `2565196890795760928.vrm` | Xingqiu（男） | 0 | 2.06 | male ✅ |
     | `3563168348695700700.vrm` | 艾尔海森（男） | 0 | 2.30 | male ✅ |
     | `1040837016792539856.vrm` | Noelle（女） | 10 | 1.32 | female ✅ |
     | `1347496417698417678.vrm` | Raiden Orchid（女） | 10 | 1.36 | female ✅ |

     注意：只看「有没有 Bust 节点」不可靠 —— VRoid 男性模型同样导出 `J_Sec_L_Bust1` 等节点，必须看它是否挂在 SpringBone 上。
4. 都没有 → `neutral`。

---

## 5. 本期动作清单（每项映射到具体素材文件）

> 路径均相对 `~/vrm-assets/`。「F」= female 套，「M」= male 套；neutral 默认取 F 的姿势 + M 的幅度。Mixamo 姿势 FBX 均为 2 帧定格（0.033 s），烘焙为循环 hold。名称来自 INVENTORY.md 的 lobe-vidol 公开元数据（仅元数据）。
>
> **舞蹈本期不做**：本清单不含任何舞蹈条目。`dances/` 整个包（VMD×48 等）、`postures/` 中 Dance 类姿势（INVENTORY 标注为 deferred）、`mixamo/` 中 Motion/*/Dance 片段（INVENTORY 标注为“NO 本期不接入（舞蹈）”）均不引用、不烘焙；舞蹈排在 P2（§10）。

### 5.1 姿势（posture，L0）—— 6 种（P0 至少前 4 种）

| id | 用途 / 触发 | F 素材 | M 素材 |
|---|---|---|---|
| `stand.relaxed` | 默认站姿；eat/talk 的底座 | `postures/2278ba9c-6878-472c-b329-a340c0ec29c1.fbx`（Standing · Arms Down）；备选 `postures/def6e4e1-a5b3-4ba5-b195-71f9dfaa8ab8.fbx`（Arms Down） | `mixamo/c6c4ddd1-3bfa-439d-aabb-bb80d03e4388.fbx`（Standing · Looking Forward）；备选 `mixamo/64a05ff5-38ab-4b26-a925-808769f6b8bf.fbx`（Arms Slightly Spread） |
| `stand.confident` | 开心 / 好感高 / 姿势循环 | `postures/7bf2f079-7884-44dd-ad4f-2cd61f175803.fbx`（Right Hand On Hip）；备选 `postures/dc356979-2ddd-4ab4-a14f-e740db3102a4.fbx`（Left Hand On Hip） | `mixamo/93695678-9ffe-4e41-b775-2f8ca5c7c15d.fbx`（Left Hand On Hip） |
| `stand.shy` | sad / hungry / 害羞余韵 | `postures/ba625166-2370-4260-ae47-0c49e3616309.fbx`（Looking Down To The Right） | `mixamo/08f3514a-0d3b-469d-9f27-57f97d9fcb9b.fbx`（Arms Behind Back） |
| `stand.playful` | 闲适 / `cue:look` / 姿势循环 | `postures/a819c6b5-4aaa-4a17-8c94-a5f70db6d68f.fbx`（Leaning Back, Arms Behind） | `mixamo/e6070070-bfbf-4fb2-87c9-ba85671346a1.fbx`（Right Hand Behind Head） |
| `sit.rest` | 长时间无人理；sad 下沉后 | `postures/9649e88e-b287-4025-a7d3-e890c67bacee.fbx`（Sitting · Arms Holding Right Knee）；备选 `postures/abe202be-9b63-49e8-9617-9c6ab94136de.fbx`（Arms Supporting） | `mixamo/9cf58708-0b86-40ae-bcfe-d211289530f7.fbx`（Sitting · Arms Resting On Knees） |
| `sit.doze` | sleep | `postures/25c19dfb-999a-44dc-9140-b11a6c646226.fbx`（Sitting · Arms Holding Left Knee, Reclining） | `mixamo/14ee62b6-eb89-4753-9544-ea8921e18ed7.fbx`（Sitting · Reclined Looking Downwards） |

P2 备用（不进本期验收）：蹲 `crouch.peek` F `postures/223e0cef-b9c0-4559-a115-6d8d7ca18c12.fbx` / M `mixamo/2f6d96c7-c5a3-4ba4-8ed3-bd9f6b4eb461.fbx`；躺 F `postures/20d24be0-b948-477b-9a24-4b562d83687c.fbx`（桌宠窗口竖长，躺姿取景差，暂不用）。

### 5.2 idle 待机变体（L1）—— 每套 ≥ 3 段

| id | F 素材 | M 素材 | 说明 |
|---|---|---|---|
| `idle.happy` | `mixamo/c9c98a38-b96c-11e4-a802-0aaa78deedf9.fbx`（Standing Happily，10.0 s，loop） | `mixamo/c9ccf37e-b96c-11e4-a802-0aaa78deedf9.fbx`（Happy Idle Variation 1，2.0 s） | 全身循环；mood:happy 时权重 ×2 |
| `idle.variant2` | `motions/model/gal_model_motion_with_legs-2_loop_v01.vmd`（女性向待机 loop，13.0 s，VMD → `mask: upper`，P1）；P0 降级：`motions/` 未就绪时用 `idle.posture-cycle` | `mixamo/c9ccf445-b96c-11e4-a802-0aaa78deedf9.fbx`（Happy Idle Variation 2，2.9 s） | |
| `idle.variant3` | `motions/_TEMP/_motion_basic_pack01/standmix2_modified.vmd`（站立混合待机，36.2 s，取 8–20 s 片段，`mask: upper`，P1） | `motions/tsuna/tsuna_standby.vmd`（1.3 s 待机，`mask: upper`，amplitude 0.7，P1） | |
| `idle.posture-cycle` | 在 `postures/2278ba9c-6878-472c-b329-a340c0ec29c1.fbx`（stand.relaxed）↔ `postures/7bf2f079-7884-44dd-ad4f-2cd61f175803.fbx`（stand.confident）↔ `postures/a819c6b5-4aaa-4a17-8c94-a5f70db6d68f.fbx`（stand.playful）之间 1.0 s 交叉淡化，叠加 L4；每 12 s 换一次 | 在 `mixamo/c6c4ddd1-3bfa-439d-aabb-bb80d03e4388.fbx`（stand.relaxed）↔ `mixamo/93695678-9ffe-4e41-b775-2f8ca5c7c15d.fbx`（stand.confident）↔ `mixamo/e6070070-bfbf-4fb2-87c9-ba85671346a1.fbx`（stand.playful）之间 1.0 s 交叉淡化；每 18 s 换一次、重心幅度 ×0.5 | **P0 即可用**（只依赖姿势 FBX）；保证没有 VMD 时 F/M 都有 ≥ 3 段 idle（happy + posture-cycle 的 2 个以上姿势组合） |
| `idle.sleep` | `motions/sleep/sleep01.vmd`（33.0 s，`mask: upper`，叠在 `sit.doze` 上，P1）；P0 降级：`postures/25c19dfb-999a-44dc-9140-b11a6c646226.fbx`（sit.doze）+ 慢呼吸 | `motions/sleep/sleep01.vmd`（同一片段，amplitude 0.8，叠在 `mixamo/14ee62b6-eb89-4753-9544-ea8921e18ed7.fbx` sit.doze 上，P1）；P0 降级：`mixamo/14ee62b6-eb89-4753-9544-ea8921e18ed7.fbx` + 慢呼吸（腹式） | mood:sleep；VMD 本身无性别风格，男女差异来自底座姿势与幅度 |

### 5.3 交互反应与持续活动（L2/L3）—— ≥ 6 种

| id | 触发（语义事件） | F 素材 | M 素材 | mask / 时序 | 表情（preset → 权重） |
|---|---|---|---|---|---|
| `react.touch-head` 摸头 | `touch:head`（mood happy）、`touch:pat` | `postures/ba625166-2370-4260-ae47-0c49e3616309.fbx`（低头，amplitude 0.55）+ L4 头部朝触摸点微蹭 | `mixamo/670efeec-dabc-492d-a713-a8a28a959249.fbx`（Looking Right，略别过脸，amplitude 0.5） | upper；in 0.25 / hold 1.6（连摸延长）/ out 0.5 | relaxed 0.8, happy 0.4（M ×0.8） |
| `react.touch-face` 戳脸 | `touch:face` | `postures/bf65f0a2-236a-475c-a56e-687d5b07998f.fbx`（Hands On Hips Looking Over Shoulder：鼓脸扭头） | `mixamo/aaba4531-7c08-4d2c-a7a6-8eae3879611d.fbx`（Looking Left） | upper；in 0.2 / hold 1.2 / out 0.5 | happy 0.5, angry 0.25, blinkRight 1（眨一只眼） |
| `react.touch-hands` 牵手 | `touch:hands` | `mixamo/c9c9f343-b96c-11e4-a802-0aaa78deedf9.fbx`（Shaking Hands – Female，trim 0.5–2.8 s） | `mixamo/c9c9f403-b96c-11e4-a802-0aaa78deedf9.fbx`（Shaking Hands – Male，trim 0.5–2.8 s） | upper；in 0.3 / out 0.5 | happy 0.8 |
| `react.shy` 敏感区害羞 | `touch:chest` / `touch:butt` / `touch:legs`，mood `shy`（中高好感） | `motions/cover_chest_v02b.vmd`（护胸，0.5 s 到位后 hold 1.5 s，`mask: arms`，P1）；P0 降级 `postures/ba625166-2370-4260-ae47-0c49e3616309.fbx`（低头）+ 视线移开 | `mixamo/e6070070-bfbf-4fb2-87c9-ba85671346a1.fbx`（手挠后脑勺，hold 1.5 s） | arms/upper；in 0.2 / out 0.6；之后 8 s 内姿势偏向 `stand.shy` | surprised 0.6 → 0.3 后转 happy 0.3 + sad 0.2（羞）；视线看斜下 |
| `react.angry` 生气 | 敏感区 mood `angry`（低好感）或连戳 ≥ 6（streak angry） | `mixamo/c9c98b02-b96c-11e4-a802-0aaa78deedf9.fbx`（Standing Angrily，trim 0–3.5 s） | `mixamo/c9c917a2-b96c-11e4-a802-0aaa78deedf9.fbx`（Angry Forward Gesture，2.2 s）；备选 `mixamo/c9c916ce-b96c-11e4-a802-0aaa78deedf9.fbx`（Quickly Pointing Angrily） | full；in 0.2 / out 0.6；之后 10 s 基线 annoyed | angry 1.0（M 0.8），盯人 1.5 s 不眨 |
| `react.annoyed` 不耐烦 | mood `annoyed`（连摸 3–5 次） | `postures/0aef00f5-ea18-4e7c-a12d-6c92a08a9033.fbx`（Leaning Back, Left Hand On Hip：往后躲） | `mixamo/93695678-9ffe-4e41-b775-2f8ca5c7c15d.fbx`（叉腰）+ 头部转开 | upper；in 0.3 / hold 1.2 / out 0.5 | angry 0.5, sad 0.2 |
| `react.ticklish` 怕痒 | `touch:belly` / `touch:feet` / `touch:tail`，mood `ticklish` | `motions/_TEMP/emote/happy1.vmd`（3.0 s 开心 emote，`mask: upper`，P1）；P0 降级 `mixamo/c9c9941c-b96c-11e4-a802-0aaa78deedf9.fbx`（Super Excited，trim 0–2.5 s，amplitude 0.6） | `mixamo/c9c91ba2-b96c-11e4-a802-0aaa78deedf9.fbx`（Happy Forward Hand Gesture，2.9 s） | upper；in 0.2 / out 0.5 | happy 1.0（M 0.8） |
| `hold.lift` 拖拽提起 | `drag:lift`（持续） | `postures/02854bce-1b74-4b36-bb3f-df58f4a0a345.fbx`（On Knees, Arms Raised：只取上半身「哇」举手） | `mixamo/ede8954e-5272-46c2-b3c5-c701e5ee887c.fbx`（Arms Spread Looking Upwards：只取上半身） | upper（腿由 L4 重力下垂 + 阻尼摆动）；in 0.2 | surprised 0.8 → 1 s 后 0.4 |
| `react.drop` 放下 / 落地 | `drag:drop`（`drag:thrown` 用更重的版本） | `motions/tsuna/tsuna_small_jump.vmd`（取落地段，P1）；P0 降级：`postures/2278ba9c-6878-472c-b329-a340c0ec29c1.fbx`（stand.relaxed）0.35 s 快速淡入 + hips 下沉 2 cm 回弹（L4）；thrown：`motions/hit/h01_何かにぶつかる小.vmd`（P1） | `motions/tsuna/tsuna_small_jump.vmd`（amplitude 0.8，P1）；P0 降级：`mixamo/c6c4ddd1-3bfa-439d-aabb-bb80d03e4388.fbx`（stand.relaxed）0.35 s 淡入 + hips 下沉 1.2 cm；thrown：`motions/hit/h01_何かにぶつかる小.vmd`（P1） | full（VMD 版为 upper）；out 0.4 | surprised 0.4 → 0 |
| `hold.talk` 说话 | `talk`（持续） | `motions/talk/xs-talk8-west-negotiate.vmd`（5.0 s 说话手势，`mask: upper`，amplitude 0.6，P1）；P0：`stand.relaxed` + 口型 + 语音能量点头 | `mixamo/c9c91ba2-b96c-11e4-a802-0aaa78deedf9.fbx`（Happy Forward Hand Gesture，amplitude 0.7，循环）；P1 同 F 的 VMD（amplitude 0.9） | upper；in 0.3 / out 0.5 | 维持基线 + happy 0.2 |
| `hold.think` 思考 | `think`（持续） | `postures/0aef00f5-ea18-4e7c-a12d-6c92a08a9033.fbx`（Leaning Back, Left Hand On Hip）+ 视线右上 + 歪头 6° | `mixamo/670efeec-dabc-492d-a713-a8a28a959249.fbx`（Looking Right）+ 视线右上 | upper；in 0.4 / out 0.5 | neutral 0.3 |
| `react.greet` 打招呼 | `celebrate:hatch`、窗口首次显示、从 sleep 醒来 | `mixamo/c9c7996a-b96c-11e4-a802-0aaa78deedf9.fbx`（Greeting While Standing，5.1 s） | `mixamo/c9c9f57a-b96c-11e4-a802-0aaa78deedf9.fbx`（Quick Informal Bow，2.7 s）；备选 `mixamo/c9c9f4bc-b96c-11e4-a802-0aaa78deedf9.fbx`（Quick Formal Bow） | full；in 0.3 / out 0.6 | happy 0.8 |
| `react.cheer` 开心 | `celebrate:evolve`、`cue:play`/`cue:happy`（小概率、amplitude 0.6） | `mixamo/c9c9941c-b96c-11e4-a802-0aaa78deedf9.fbx`（Super Excited，trim 0–3.0 s） | `mixamo/c9c91ba2-b96c-11e4-a802-0aaa78deedf9.fbx`（Happy Forward Hand Gesture） | full；in 0.25 / out 0.6 | happy 1.0 |
| `react.sad-sink` 失落坐下 | `mood:sad` 持续 > 60 s | `motions/casual/へなへなと座り込む_gumi.vmd`（瘫坐，3.3 s，P1，需腿部 IK）→ `sit.rest`；起身 `motions/casual/女の子座り→立ち上がる_gumi_v01.vmd`；P0：`stand.shy` → `sit.rest` 1.2 s 交叉淡化 | `stand.shy`（`mixamo/08f3514a-0d3b-469d-9f27-57f97d9fcb9b.fbx`）→ `sit.rest`；P1 起身 `motions/casual/OTL→立ち上がり.vmd` | full | sad 0.5 |
| `hold.eat` 吃东西 | `eat:*`（持续） | `stand.relaxed`（`postures/2278ba9c-6878-472c-b329-a340c0ec29c1.fbx`）+ 口型层咀嚼 + 头部小点头 | `stand.relaxed`（`mixamo/c6c4ddd1-3bfa-439d-aabb-bb80d03e4388.fbx`）+ 口型层咀嚼（幅度 ×0.8）+ 头部小点头 | — | happy 0.7 |
| `hold.walk` 走路（P1） | `walk`（持续，漫游开启时） | `motions/walk_n_run/walk_A01_f0-40_s9.85.vmd`（1.3 s 步行循环，需腿部 FK/IK，P1）；P0：保持 `stand.relaxed`、yaw ±60° 朝向行进方向 + 轻微上下 | `mixamo/c9cceeed-b96c-11e4-a802-0aaa78deedf9.fbx`（Happy Walking Forward，1.1 s，去掉根位移原地踏步） | full | happy 0.25 |

**本期验收最小集（P0，只依赖 Mixamo FBX）**：姿势 `stand.relaxed / stand.confident / stand.shy / stand.playful / sit.rest`（5 种）；idle `idle.happy / idle.variant2(M) 或 idle.posture-cycle(F) / idle.posture-cycle`（每套 ≥ 3 段）；反应 `touch-head / touch-face / touch-hands / shy(降级) / angry / annoyed / ticklish(降级) / lift / greet / cheer / talk / think`（≥ 6 种，男女各一套）。VMD 条目（P1）在 VMD 烘焙完成后替换降级素材，无需改导演逻辑。

### 5.4 待预览补充池

INVENTORY §7.2 有 1895 个无名 Mixamo UUID 片段（410 个「中长片段 → idle 循环候选」、1284 个「短片段 → 反应候选」）。P1 提供 `scripts/vrm-bake.js --preview <dir> --model liliya.vrm` 批量把候选渲成缩略 GIF/PNG 网格，人工挑选后写进 `src/core/vrm-library.json`（只写 id 与元数据），以补充 female 的说话/思考/害羞等 Mixamo 片段。

---

## 6. 素材存放与加载

### 6.1 位置

| 内容 | 位置 | 进 git | 进安装包 |
|---|---|---|---|
| 原始素材（FBX/VMD/VRM/zip） | `~/vrm-assets/`（开发机，前一任务下载与盘点） | ❌ | ❌ |
| 烘焙产物 `.vrma` + `library.json` | `<userData>/vrm-motions/{female,male,neutral}/…`（应用用户数据目录；Linux `~/.config/<app>/vrm-motions`） | ❌ | ❌ |
| VRM 模型 | 走现有「导入 VRM 模型…」，复制到 `<userData>/packs/vrm-<角色>-<模型>/models/` | ❌ | ❌ |
| 烘焙清单（元数据） | `src/core/vrm-library.json` | ✅（纯 JSON，无二进制、无模型名以外的版权内容） | ✅（只是索引） |

### 6.2 运行时加载

- 新增协议 `vrmlib://<style>/<file>.vrma`（`src/main/vrm-library.js`，与 `pack://` 同样 `registerSchemesAsPrivileged`），只服务 `<userData>/vrm-motions/`（或开发覆盖目录）下的 `.vrma` / `library.json`，路径必须落在该目录内（`path.resolve` + 前缀检查，同 `src/main/packs.js` 的做法）；CSP `connect-src` 增加 `vrmlib:`；渲染进程的 GLTFLoader URL 白名单对动画加载器放行 `vrmlib://`（模型加载器仍只允许 `pack://<自己的包>/`）。
- 片段懒加载：先加载当前 style 的 posture + idle（< 1 MB 级），反应在首次触发前 2 s 预取（hover 进入窗口时预取触摸类反应），LRU 保留 24 个 clip。
- **无素材库时的降级**：`library.json` 不存在或某条缺失 → 导演改用 `vrm.idle`（包内 `.vrma`，现有功能）或纯 L4 微动 + 表情；不报错、不回退到旧的 hop/spin。e2e 覆盖这条路径。

### 6.3 开发时指向 `~/vrm-assets`

```bash
# 1) 烘焙（读 ~/vrm-assets，写到仓库外）
PIXELPET_VRM_ASSETS=~/vrm-assets node scripts/vrm-bake.js --out ~/vrm-assets/baked
#    缺省 --assets 为 $PIXELPET_VRM_ASSETS，再缺省为 ~/vrm-assets；--out 缺省为 <userData>/vrm-motions
# 2) 运行应用并指向烘焙目录（不复制）
PIXELPET_VRM_MOTIONS_DIR=~/vrm-assets/baked npm start
# 3) 模型：⋯ → 角色列表 → 外观 → 导入 VRM 模型… → ~/vrm-assets/models/模型文件/莉莉雅/liliya.vrm（男性对照 vroid.vrm）
```

`PIXELPET_VRM_MOTIONS_DIR` 若位于仓库目录内，主进程拒绝使用（同 `vrm-real-model-acceptance.js` 对模型路径的规则），防止素材被误提交。

### 6.4 防泄漏守卫

- `.gitignore` 追加：`*.fbx *.FBX *.vmd *.VMD *.bvh *.pmx *.vroid`（`*.vrm/*.vrma` 已有）。
- `package.json` `build.files` 追加 `!**/*.fbx`、`!**/*.vmd`、`!**/*.bvh`、`!**/*.pmx`。
- `npm test` 的守卫测试扩展：`git ls-files` 与 `src/` 中不得出现上述扩展名；`src/core/vrm-library.json` 中的 `src` 必须是相对路径、不得含 `..`、不得指向仓库内。
- e2e `vrm` 现有的「packaging guard」步骤同步扩展到新扩展名。

---

## 7. 运行时接口与调试字段

- `figure.draw(snap)`：VRM 专用快照（§2.2）。为兼容 `picture()` 与旧调用，`draw({ t, state })` 仍可用：`state` 被包装为 `snap.status`/`snap.shot` 交给 intent。
- `figure.zoneRects()`（P1）：投影后的触摸区域矩形。
- 画布调试字段（e2e 读取）：保留 `data-frame/fps/mode/expr/mouth/lip/gaze/vrm/anim`；新增 `data-style`（female/male/neutral + 来源 pack|meta|default）、`data-posture`、`data-idle`、`data-reaction`（当前反应 id 或空）、`data-hold`（talk/think/eat/lift/…）、`data-layers`（各层权重摘要）、`data-library`（loaded/none/partial:<n>）；`data-state` 改为语义事件摘要。
- `window.__pet.vrmDirector`（仅测试/调试）：`speed(k)` 加速调度时钟、`seed(n)` 固定随机数、`plan()` 当前 Plan。

---

## 8. 测试与验收方案

### 8.1 单元测试（`npm test`，纯 Node，不需要素材）

| 文件 | 测什么 |
|---|---|
| `test/vrm-intent.test.js` | 快照 → 事件：`lastTouch.n` 边沿只触发一次；`lifted/flying` 上升沿 → `drag:lift`、下降沿 → `drag:drop`/`drag:thrown`；talk/think/eat/walk 持续量；`cue:*`/`celebrate:*` 来自 `shot`；事件中不出现任何动作词（hop/spin/dangle…）。 |
| `test/vrm-director.test.js` | 注入 rng 与时钟：idle 不连续重复、每段 8–20 s、情绪偏置；反应 enter→play→hold→exit 后回到 idle 且 idle 相位延续；优先级与打断（lift 打断 touch、touch 打断 talk 后恢复 talk）；同区连摸延长而非重播；0.6 s 防抖；mood 由 touch-zones 决定（happy/shy/annoyed/angry/ticklish 各选对条目）；180 s 无人理 → `sit.rest`，attention → 站起；**female 与 male 两套**下 §5 每个槽位都解析到库条目；库为空时降级到 `vrm.idle`/纯微动且不抛错。 |
| `test/vrm-style.test.js` | 推断优先级（pack.json > 导入写入 > meta 推断 > neutral）；`bustSpring>0 → female`、`shoulderHip≥1.5 → male`、否则 neutral（用测试内构造的最小 GLB JSON，覆盖「VRoid 男性有 Bust 节点但无 SpringBone」用例）；对象形式 style 继承与夹值。 |
| `test/vrm-library.test.js` | `src/core/vrm-library.json` 结构校验（kind/mask/trim/face 合法、id 唯一、`src` 为 `postures/`/`mixamo/`/`motions/` 下的相对路径、无 `..`）；每个 style 至少 4 姿势、3 idle、6 反应；若设置了 `PIXELPET_VRM_ASSETS`，额外检查每个 `src` 文件存在（CI 无素材时跳过）。 |
| `test/vrm-bake.test.js` | 重定向数学：静止旋转为单位时 `q_vrm == q`；已知父/子静止旋转时补偿结果正确；Mixamo 骨名映射覆盖 VRM 必需骨骼；VMD 解析（测试内构造 VMD 二进制，含 shift_jis 骨名）；左右手系转换；写出的 GLB 通过 `V.inspectVrmaJson`；trim/loop/mask/amplitude 行为。 |
| `test/vrm-life.test.js` | 微动层上限（单骨 ≤ 4°、根 ≤ 2 cm，lift 腿 ≤ 12°）；呼吸频率随 style/sleep；重心切换间隔 6–14 s；不存在 hop/spin/stride/dangle 等字段（解耦回归）。 |
| `test/vrm-motion.test.js`（改） | 删除对 STATE_LOOKS/pose 的断言；保留 resolveFace、眨眼、gaze、口型、帧预算用例。 |
| `test/packs.test.js`（改） | `vrm.style` / `vrm.motions` 校验与错误文案。 |
| 像素回归守卫（新增于 `test/fx.test.js` / `test/touch-zones.test.js`） | `Fx.STATES`、`Fx.FALLBACK`、`TZ.ZONES`、`MOOD_FX`、`MOOD_DELTA`、`reactionFor` 结果与当前版本快照一致（证明共享层未被改动）。 |

### 8.2 e2e：`xvfb-run -a node e2e/run.js vrm`

现有 `vrm` 场景用即时生成的自制 VRM（`scripts/make-test-vrm.js`）。新增 `scripts/make-test-vrma.js`：在测试数据目录（`PIXELPET_DATA_DIR/vrm-motions/`）即时生成**自制**小 `.vrma` 库（每个槽位一个能区分的简单姿势，比如右臂抬起角度不同），不依赖任何第三方素材。步骤调整为：

1. 导入自制 VRM，画布出现，`data-library=loaded`、`data-style=female (pack)`；
2. idle：`__pet.vrmDirector.speed(20)` 后 `data-idle` 在 ≥ 3 个变体间变化且不连续重复；`data-mode` 照旧会降到 idle 帧率；
3. **解耦证据**：happy/sad/sleep/lifted 期间 VRM 画布 `getComputedStyle(canvas).animationName === 'none'`、`transform === 'none'`、`#pet-body` 无 `pet-dangle`；`debug().motion` 中不含 hop/spin/dangle；
4. 摸头 → `data-reaction=react.touch-head`，表情含 relaxed，≤ 3 s 内回到 `data-reaction=''`、`data-idle` 恢复；
5. 戳脸、点手、点胸（低好感 → `react.angry`；用调试接口抬好感后 → `react.shy`）、连点 3 次 → `react.annoyed`；
6. 拖起 → `data-hold=lift`，松手 → `react.drop` → idle；
7. 说话（内置语音包台词）→ `data-hold=talk` + 口型非零，结束归零；思考 → `data-hold=think`、视线上移；
8. 切换 pack.json `vrm.style: "male"` 重新载入 → `data-style=male`，同一触摸选到 `@male` 条目；
9. 删除 `library.json` → `data-library=none`，仍能绘制、无报错（降级）；
10. 原有步骤（眨眼、视线、18+、切回像素再切回 VRM、打包守卫扩展到 fbx/vmd、无渲染错误）保留。

每步截图存 `OUT/vrm/*.png`，并录制一段 30 s 视频（带章节）。

### 8.3 真实素材验收（本机，非 CI）

`.agents/acceptance/scripts/vrm-motion-real-acceptance.js <仓库> <输出目录> --assets ~/vrm-assets --model ~/vrm-assets/models/模型文件/莉莉雅/liliya.vrm --male ~/vrm-assets/models/模型文件/vroid.vrm`：

- 拒绝位于仓库内的素材/模型路径；
- 烘焙 → 导入 liliya（female 推断）与 vroid.vrm（male 推断）→ 逐个触发 §5 的每个姿势/idle/反应，各截图，并录屏对比男女差异（liliya 的戳脸/害羞 vs vroid 的同一事件）；
- 输出每个条目的「素材路径 → 截图」对照表供人工评审「自然、有活人感」。

### 8.4 像素回归

- `npm test` 全绿（含 §8.1 的共享层快照守卫）；
- `xvfb-run -a node e2e/run.js touch`、`fresh`、`rig`、`live2d`、`dafeiyu`、`art`、`wardrobe` 全部通过，与改动前基线截图比较：像素角色的 `data-status`、`data-action`、emoji 覆盖、squash/dangle CSS 行为不变；
- 代码审查约束：PR diff 中 `src/core/fx.js`、`src/core/touch-zones.js`、`src/core/pet-state.js`、`src/renderer/rig.js`、`src/renderer/live2d.js`、`src/renderer/fx.js` 无改动；`app.js` 的改动只在 `look.kind === 'vrm'` 分支和 `#pet-body[data-kind]`。

---

## 9. 需要改动 / 新增的文件

### 9.1 新增

| 文件 | 内容 |
|---|---|
| `docs/vrm-motion-system.md` | 本文档 |
| `src/core/vrm-intent.js` | 快照 → 语义事件（纯函数，UMD 同 vrm-motion.js） |
| `src/core/vrm-director.js` | VRM 导演状态机：姿势/idle 调度、反应生命周期、优先级、表情与视线目标 |
| `src/core/vrm-style.js` | 风格档案、`pack.json` style 解析、meta 推断规则、夹值 |
| `src/core/vrm-life.js` | 活人感微动层（呼吸、重心、头部微动、手指、视线跳动、拎起腿下垂），带上限 |
| `src/core/vrm-library.js` | 库索引读取/校验、按 style 与槽位解析条目、降级逻辑 |
| `src/core/vrm-library.json` | 烘焙清单（元数据：id、kind、style、`src` 相对路径、trim/mask/amplitude/fade/face） |
| `src/renderer/vrm-anim.js` | three AnimationMixer 分层（base.lower/base.upper、hold、reaction、mask、交叉淡化、LRU） |
| `src/main/vrm-library.js` | `vrmlib://` 协议、库目录解析（userData / `PIXELPET_VRM_MOTIONS_DIR`，拒绝仓库内路径） |
| `scripts/vrm-bake.js` | FBX（P0）/ VMD（P1）→ `.vrma` 烘焙、重定向、`library.json` 生成、`--preview` 候选预览 |
| `scripts/make-test-vrma.js` | 测试用自制 `.vrma` 库生成器 |
| `test/vrm-intent.test.js`、`test/vrm-director.test.js`、`test/vrm-style.test.js`、`test/vrm-library.test.js`、`test/vrm-bake.test.js`、`test/vrm-life.test.js` | §8.1 |
| `.agents/acceptance/scripts/vrm-motion-real-acceptance.js` | §8.3 真实素材验收 |

### 9.2 修改

| 文件 | 改动 |
|---|---|
| `src/core/vrm-motion.js` | 删除 STATE_LOOKS/TOUCH_LOOKS/MOOD_LOOKS/MOTIONS/REPEATING/calm/lookFor/pose/poseOffsets/motionMouth 的程序化大动作；保留表情解析、眨眼、gaze、口型、帧预算、overClip |
| `src/renderer/vrm.js` | `draw(snap)` → intent → director → vrm-anim 分层 → life（overClip）→ 表情/口型 → `aim()` 用导演的视线目标；`loadIdle` 泛化为库加载（`vrm.idle` 作为无库时的降级）；朝向用 yaw；落地；新调试字段；`zoneRects()`（P1） |
| `src/renderer/app.js` | `tickRigs()`：VRM 分支构造快照（§2.2），rig/live2d 不变；`#pet-body` 写 `data-kind`；`zoneAtClient` 的 VRM 分支（P1）；`__pet.vrmDirector` 调试接口 |
| `src/renderer/style.css` | `.char.vrm` 与 `.pet-body[data-kind="vrm"]` 的动画/变换/镜像豁免 |
| `src/renderer/index.html` | 引入 `vrm-intent.js`/`vrm-director.js`/`vrm-style.js`/`vrm-life.js`/`vrm-library.js`/`vrm-anim.js`；CSP `connect-src` 加 `vrmlib:` |
| `src/core/vrm.js` | `inspectVrmJson` 增加 `body: { bustSpring, shoulderHip }` |
| `src/core/packs.js` | 校验 `vrm.style`、`vrm.motions`；`vrmView`/look 透传 `style` |
| `src/core/vrm-import.js` | 导入时写入推断/用户选择的 `style` |
| `src/core/vrm-ui.js` | 导入确认页「动作风格」选项文案 |
| `src/main/main.js` | 注册 `vrmlib://`、读取 `PIXELPET_VRM_MOTIONS_DIR` |
| `src/main/preload.js` | （如需）暴露库状态查询 |
| `.gitignore` | 追加 `*.fbx *.FBX *.vmd *.VMD *.bvh *.pmx *.vroid` |
| `package.json` | `build.files` 追加 `!**/*.fbx`、`!**/*.vmd`、`!**/*.bvh`、`!**/*.pmx` |
| `docs/pet-packs.md` | VRM 章节：`vrm.style`、`vrm.motions`、动作库与开发流程 |
| `e2e/vrm.js` | §8.2 新步骤 |
| `test/vrm-motion.test.js`、`test/packs.test.js`、`test/fx.test.js`、`test/touch-zones.test.js` | §8.1 |

### 9.3 明确不改

`src/core/fx.js`、`src/core/touch-zones.js`、`src/core/pet-state.js`、`src/renderer/rig.js`、`src/renderer/live2d.js`、`src/renderer/fx.js`。

---

## 10. 分期与风险

| 期 | 内容 |
|---|---|
| P0（本期必达） | 解耦（intent/director、CSS 豁免、删除程序化大动作）；Mixamo FBX 烘焙；姿势 5 种、idle 每套 ≥ 3、反应 ≥ 6（男女两套）；life 层；表情/口型；style 推断；`vrmlib://`；单测 + e2e + liliya/vroid 真实验收 |
| P1 | VMD 烘焙（上半身）替换降级素材；腿部 IK 后开放坐下/起身/走路 VMD；`zoneRects()`；候选片段预览器 |
| P2 | 蹲/躺姿势；舞蹈（`dances/`，本期不做） |

| 风险 | 应对 |
|---|---|
| Mixamo 姿势在 VRoid 体型上穿模（叉腰手进身体、坐姿脚穿地） | 烘焙参数 `amplitude` 与每 style 的 `stanceWidth`/手腕补偿；真实验收逐条截图评审；问题条目切换到同类备选素材（§5 已列备选） |
| VMD A-pose/IK 换算误差 | 本期 VMD 只作 P1 上半身；所有 VMD 条目都有 P0 Mixamo 降级 |
| 低帧率 idle 模式（12 fps）下动作显得卡 | idle 帧率只在无事件、无光标、无反应时启用（沿用 `frameMode`）；反应/hold 期间强制 active |
| 素材授权 | 只在本机用户目录使用；仓库与安装包守卫（§6.4）；分享/导出沿用 `packShareable` 的拒绝逻辑 |

---

## 附录 A：素材引用核对

本文所有素材路径（反引号中以 `postures/`、`mixamo/`、`motions/`、`models/` 开头的路径）已用脚本逐条核对：文件在 `~/vrm-assets/` 下存在，且出现在 `~/vrm-assets/INVENTORY.md` 中。核对方法：

```bash
grep -oE '`(postures|mixamo|motions|models)/[^`]+`' docs/vrm-motion-system.md | tr -d '`' | sort -u |
while IFS= read -r p; do
  f=OK; [ -f ~/vrm-assets/"$p" ] || f=MISSING
  i=INV; grep -qF "$p" ~/vrm-assets/INVENTORY.md || i=NOT_IN_INVENTORY
  echo "$f $i $p"
done
```

---

## 11. 实现记录（T-2678：姿势系统、idle 待机、男女风格）

### 11.1 已实现

| 设计项 | 实现 |
|---|---|
| §2.2 语义事件 | `src/core/vrm-intent.js`（`fromSnapshot`/`fromState`/`summary`）；`app.js` 的 `vrmSnapshot()` 只在 VRM 分支构造快照，rig/live2d 仍收 `state` |
| §2.3 去掉像素式表现 | `vrm-motion.js` 删除 STATE_LOOKS/TOUCH_LOOKS/MOOD_LOOKS/MOTIONS/REPEATING/calm/lookFor/pose/poseOffsets/motionMouth/breath；新增 `REST_POSE`（无片段时双臂下垂）、`chewMouth`；`style.css` 对 `.char.vrm` 与 `.pet-body[data-kind="vrm"]` 豁免动画/变换/镜像；`#pet-body[data-kind]` |
| §3.1 L0/L1 分层 | `src/renderer/vrm-anim.js`：base 层交叉淡化，任何时刻权重和 = 1（PropertyMixer 不再混入原始 T-pose），首个片段权重直接 1；L4 触及骨骼走 `overClip` memo（不漂移） |
| §3.2 idle 调度 | `src/core/vrm-director.js`：每段 8–20 s（片段取整数个循环），不连续重复，happy 时 `idle.happy` 权重 ×2，sad/hungry → `stand.shy`，sleep → `sit.doze`，180 s 无人理 → `sit.rest`，光标/事件 → 站起 |
| §3.2 活人感 L4 | `src/core/vrm-life.js`：呼吸（14–18/分，睡 10/分 ×1.6；女胸式、男腹式）、6–14 s 换重心、三正弦头部微动、眼球微跳与偶尔看别处（伴随眨眼）、无手指关键帧时放松手指、被拎起时腿受重力下垂 + 阻尼摆；单骨骼 ≤ 4°，拎起腿 ≤ 8°/12° |
| §3.4/3.5 表情、口型 | 基线情绪 + 事件表情（attack ≈0.15 s / release ≈0.6 s），male ×0.8；说话时 happy/relaxed ≤ 0.5；吃东西由口型层咀嚼 |
| §3.6 朝向、落地 | 身体 yaw ±18°（走路 ±60°），不镜像；每帧把最低的脚/膝/坐骨贴地，坐姿按身体横向范围居中 |
| §3.7 烘焙 | `scripts/vrm-bake.js` + `scripts/lib/vrm-bake-core.js`：Mixamo FBX（three FBXLoader，临时目录安装 three@0.187.0）→ 重定向 `q_vrm = Q_parentWorldRest · q · Q_worldRest⁻¹` → trim/hold/mirror/amplitude/loop/center → `.vrma` + `library.json` |
| §4 风格 | `src/core/vrm-style.js`：三套档案 + `VRM_STYLE_LIMITS`；`pack.json vrm.style`（名称或对象）、`vrm.motions` 由 `packs.js` 校验；未指定时 `inspectVrmJson().body` → `bustSpring>0 → female`、`shoulderHip≥1.5 → male`、否则 neutral（liliya → female，vroid.vrm → male，与 §4.2 实测表一致） |
| 姿势持久化 | `settings.vrmPostures { packId: posture }`（`auto` 不存）；外观页 VRM 卡片“姿势”下拉框 → `set-vrm-posture` IPC；重启后保持 |
| §6 素材加载 | `src/main/vrm-library.js`：`vrmlib://index/library.json`、`vrmlib://<style>/<slot>.vrma`，目录为 `$PIXELPET_VRM_MOTIONS_DIR` → `<userData>/vrm-motions` → 开发运行时 `~/vrm-assets/baked`；仓库内路径拒绝；CSP `connect-src` 加 `vrmlib:`；`.gitignore`/`build.files` 排除 fbx/vmd/bvh/pmx/vroid |
| §7 调试字段 | `data-style/posture/idle/reaction/hold/layers/library`，`data-state` 为语义事件摘要；`window.PetVRM.director`（= `window.__pet.vrmDirector`）：`speed/seed/plan/history/setPosture` |
| §8 测试 | `test/vrm-{intent,director,style,library,life,bake,pack-style}.test.js`；`e2e/vrm.js` 用 `scripts/make-test-vrma.js` 自制动作库；真实素材验收 `.agents/acceptance/scripts/vrm-motion-real-acceptance.js` |

### 11.2 与设计的偏离（及原因）

1. **坐姿素材换成“坐在地上”的姿势**（§5.1）：设计里的 `sit.rest`/`sit.doze`（女 `9649e88e`、`25c19dfb`，男 `14ee62b6`）都是坐椅子的姿势（烘焙后 hips 高度为站姿的 0.55–0.58），桌宠窗口里没有椅子，贴地后整个人悬空坐在空气里。改为：女 `sit.rest` = `postures/5b8c40fa-3e5e-4419-bb08-4e1bb49c4c6a.fbx`（Laying · Legs To Side, Arms Raised，侧坐），女 `sit.doze` = `postures/61c51e24-3e95-4adb-9df7-4c6efb389d78.fbx`（Laying · Legs Crossed, Arms Supporting，后仰坐），男 `sit.doze` = `mixamo/4362690a-8af0-41ac-9a22-33e43a51a6ee.fbx`（Sitting · Reaching Hands Towards Toes，低头坐）；男 `sit.rest`（`9cf58708`）本来就是地面坐姿，不变。
2. **女性 `stand.relaxed` 用设计中的备选 `def6e4e1`**：首选 `2278ba9c` 的 hips 偏转约 63°，默认站姿侧身背对用户；备选正面朝向用户。
3. **女性 `idle.variant2` 的 P0 素材**：设计的 P0 降级是复用 `idle.posture-cycle`，那样女性实际只有 2 段不同待机。改为 Standing Happily 的镜像（`mirror`）、截取 1.5–8.5 s、幅度 0.8，男女各有 3 段不同的待机片段；VMD 版（P1）仍按 §5.2 替换。
4. **固定姿势时的 idle 变体**：全身 idle 片段会把她带离用户选的姿势（或坐姿），因此姿势被固定（用户选择、sleep、sad、无人理坐下）时，idle 调度改在三段“微动变体”`idle.breathe`/`idle.glance`/`idle.shift` 之间切换（同样 8–20 s、不重复），只改变活人感层参数（重心幅度、看别处频率）。
5. **idle 片段居中**（烘焙参数 `center`，idle 默认开）：Mixamo idle 的 hips 平均位置偏离原点 11–14 cm，整段待机都站偏；烘焙时把 hips 的平均水平位置移到原点，摆动保留。
6. **去掉窗口惯性的整体滞后位移**：旧实现让整个人随窗口速度横移最多身高的 7%，超出 §2.3 根位移 ≤ 2 cm 的上限；拖动时的惯性改由腿部阻尼摆与 SpringBone 体现。
7. **`vrmlib://` 与 `pack://` 一起注册**：Electron 的 `registerSchemesAsPrivileged` 只能调用一次，所以在 `src/main/packs.js` 的 `registerPackScheme` 里一并注册，服务逻辑在 `src/main/vrm-library.js`。开发运行（未打包、非测试）时若前两个目录都没有库，回退到 `~/vrm-assets/baked`（任务要求可从 `~/vrm-assets` 读取）。
8. **导入时写入风格**（§4.2 第 2 条）本期未做：导入器生成的 `pack.json` 不写 `style`，运行时从模型推断（`data-style` 显示 `(meta)`）；手写 `vrm.style` 优先。

### 11.3 留给后续任务（不在 T-2678 范围）

L2 持续活动片段（说话手势、思考、被拎起的上半身）、L3 互动反应片段与 upper/lower 拆分、`zoneRects()`、VMD 烘焙（P1）、导入确认页的风格选择。本期触摸/拖拽等事件只驱动表情、视线与活人感层（腿部重力下垂），不播放反应片段，也不再有任何像素式程序化动作。

