# VRM 舞蹈功能设计（桌宠）

> 状态：已实现（T-2798 设计 → T-2799–T-2801 实现 → T-2803 端到端验证）；**使用方式见 §9，关键改动清单见 §10**。　分支：`feat/vrm-dance`（基于 `origin/canary` ec46849）
> 范围：只面向 VRM 外观；像素 / 图片 / rig / Live2D 角色不跳舞（入口隐藏或禁用，见 §6）。
> 前置文档：[`docs/vrm-motion-system.md`](vrm-motion-system.md)（下称「动作文档」）——动作分层 L0–L6（§3.1）、素材格式与重定向（§3.7）、素材存放与防泄漏守卫（§6）、调试字段（§7）、分期里把舞蹈列为 P2（§10）。本文是 §10 P2「舞蹈」的展开。
> 参考：[lobe-vidol](https://github.com/lobehub/lobe-vidol)（本机 `~/work/t2688/lobe-vidol`，commit fa50051，Apache-2.0）两年前的舞蹈实现。**只借鉴功能与交互思路，不复制、不改写、不移植它的任何代码**，边界逐项列在 §1.3。
> 素材：`~/vrm-assets/dances/`（5 个 `vidol-dance-*` 包 + 16 个第三方 MMD 舞蹈），**只在本机用户目录使用，不进 git、不进安装包**（§5.6）。

---

## 0. 结论速览

| 决策 | 结论 | 理由（详见对应章节） |
|---|---|---|
| 运行时格式 | VMD 在**导入时**离线烘焙成 `.vrma`，运行时只播 `.vrma` | 与动作文档 §3.7「运行时只认 .vrma」一致；足 IK 一次解完，运行时不跑 CCD；渲染进程不带 VMD 解析器；可单测（§2.1） |
| 烘焙在哪跑 | 纯 JS 模块（无 three），主进程 `worker_threads` 里跑；开发脚本 `scripts/vrm-bake.js` 复用同一模块 | 用户在安装版里导入舞蹈，不能依赖 `npm install three`（现有 FBX 烘焙需要临时装 three，§2.1） |
| 骨架 | 用自建的 MMD 参考骨架解 IK，产物与模型无关；运行时由 `createVRMAnimationClip` 按目标模型 hips 高度缩放 | 一支舞配所有 VRM，换角色不用重烤；21 支素材里 16 支是为 Tda 式初音ミク 做的动作（§2.4） |
| 与动作层 | 新增独占的**舞蹈层 D**：替换 L0/L1 基础层，L2/L3 叠加层全部让位，L4 只留眨眼与视线；进入 0.6 s、退出 0.5 s 交叉淡化（T-2829 由 0.8 s 改为 0.5 s） | 舞蹈是全身动作，任何上半身叠加都会破坏它；复用 `vrm-anim.js` 的「权重和恒为 1」淡化，杜绝 T-pose（§3） |
| 打断 | 拖起 = 暂停、放下后 0.6 s 续跳；点击 = 只出表情；说话 = 继续跳 + 音乐压低；喂食/玩耍/睡觉/换角色 = 停止 | 按「是否必须用到身体」区分（§3.4） |
| 取景 | 窗口不放大；hips 水平「漂移」软限幅（同一偏移施加到双脚 IK 目标）+ 相机按烘焙时量出的伸展范围拉远 | 230×340 的透明窗口一放大就会挡住桌面点击；实测 `センター` 水平偏移最大 0.5–4.2 m（§3.6） |
| 同步 | 有音乐时**音频时钟为主钟**，每帧把动作时间设成 `audio.currentTime + offset`；无音乐用渲染时钟 | 不累积漂移；vidol 用帧间隔推进、音画会漂（§4） |
| 舞蹈库 | `<userData>/vrm-dances/<id>/`，索引 `library.json`，走 `vrmlib://dance/…`；内置示例是仓库自制的原创小舞 + 合成节拍 | 第三方素材一律不入库、不打包；示例舞没有版权问题，也是 e2e 夹具（§5） |
| 入口 | 桌宠工具栏新增「跳舞」图标按钮 → 舞蹈列表浮层；设置窗口 玩法 → 和她一起 → 舞蹈；聊天里说「跳个舞」；本地 API `POST /pixel-pet/dance`。**不加右键菜单** | 右键已定为「打开设置」（T-2718 去掉了桌宠窗口的菜单）；工具栏只有 230 px 宽，用图标按钮（§6） |

---

## 1. vidol 舞蹈功能与交互梳理

阅读范围：`src/libs/VMDAnimation/*`、`src/libs/vrmViewer/{model,viewer}.ts`、`src/libs/emoteController/motionController.ts`、`src/store/dance/*`、`src/store/market/slices/dance.ts`、`src/services/dance.ts`、`src/types/dance.ts`、`src/hooks/useDownloadDance.tsx`、`src/app/chat/CameraMode/{Operation,Settings/DanceList}/*`、`src/features/AgentViewer/ToolBar`、`src/services/chat.ts`。行号均指上述 commit。

### 1.1 它是怎么做的

**A. 解析与重定向（`src/libs/VMDAnimation`）**

| 方面 | vidol 的做法 | 位置 |
|---|---|---|
| 解析 | 第三方库 `mmd-parser` 的 `parseVmd`；给它的 Shift-JIS 解码打补丁，非法字符只告警 | `vmd2vrmanim.ts:5,14-28,224` |
| 时机 | **运行时**：每次播放 fetch VMD → 解析 → 按当前模型生成 `AnimationClip` | `loadVMDAnimation.ts:6-13` |
| 骨骼映射 | 下半身→hips、上半身→spine、上半身2→chest、首/頭/目/肩/腕/ひじ/手首/五指三节/足/ひざ/足首/つま先；`グルーブ`、`腰`、`腕捩/手捩`、`上半身3`、`足D` 系的帧直接丢弃 | `vmd2vrmanim.ts:136-200` |
| 拇指 | `親指０→ThumbProximal`、`親指１→ThumbMetacarpal`，顺序与 VRM 层级相反 | `vmd2vrmanim.ts:147-148` |
| A-pose 补偿 | 固定 30°：上臂右乘绕 Z ±30°，前臂/手/手指两侧共轭；不读源模型实际角度，肩不补偿 | `vmd2vrmanim.ts:220-221,375-419` |
| 手系 | 位置 x 取反，四元数 x、w 取反（≡ y、z 取反，对 X 平面镜像） | `vmd2vrmanim.ts:372-374` |
| 单位 | 位置统一 ×0.1（1 MMD 单位 = 0.1 m），不按模型身高缩放 hips 位移 | `vmd2vrmanim.ts:421` |
| 中心 / 位移 | hips = 全ての親 × (センター + 模型 hips 偏移) × 下半身；**spine 时间线被设成「hips 相对 hips」，恒为单位旋转——上半身的数据实际被覆盖掉了** | `vmd2vrmanim.ts:317-331` |
| 插值 | 不用 VMD 自带贝塞尔曲线，合并时 lerp/slerp，播放时 three 线性插值 | `vmd2vrmanim.ts:449-527` |
| 足 IK | 自写 CCD，**每帧运行时**在原始骨骼上解：足 IK 40 次迭代、每步 ≤ 0.5 rad、膝盖按原始骨骼欧拉 X 限 −180°…0°；趾 IK 3 次；只用目标位置，不用 IK 旋转，忽略 VMD 的 IK 开关帧 | `vrm-ik-handler.ts:110-175`，`motionController.ts:124-130` |
| 表情 | まばたき→blink，あいうえお→aa/ih/ou/ee/oh；ウィンク→blinkRight、ウィンク右→blinkLeft（疑似左右反） | `vmd2vrmanim.ts:95-104,201-210` |
| 镜头 VMD | three 的 `MMDLoader.loadAnimation`；缺 `lookAt(target)`、`target.position` 不缩放、fov 改了不 `updateProjectionMatrix`，实际不可用 | `loadVMDCamera.ts:12-58`，`viewer.ts:405-409,518-531` |
| 其它 | `vrm-model-noise.ts`（±2.5° 随机晃动）、`bvh2vrmanim.binding.ts` 无引用 | — |

**B. 播放与切换（`src/libs/vrmViewer`）**

- 入口 `Viewer.dance(src, audio, camera?)`（`viewer.ts:81-129`）：停旧音乐 → `THREE.AudioLoader` 载音乐（音量 0.5，`onEnded` → 结束）→ 可选镜头 mixer → `playMotionUrl(VMD, src, false)` → 播音乐 → 画布全屏、背景变黑。
- 每次换动作都 `stopMotion` + `uncacheRoot` + 新建 mixer（`motionController.ts:49-77`）：**idle、说话、舞蹈之间全是硬切**；舞蹈 `LoopOnce` 且没 `clampWhenFinished`，动作比音乐短时会露出 rest 姿势。
- 同步：mixer 用 `THREE.Clock` 的帧间隔推进，不读音频时间；`playMotionUrl` 没 await（`model.ts:74-76`），音乐会在 VMD 还没解析完时先响。
- 结束以音乐为准（`onEnded` 或退出全屏 → `handleDanceEnd` → `resetToIdle`，`viewer.ts:131-139,474-491`）；没有暂停 / 继续 / 循环。
- 跳舞期间点身体的互动被屏蔽（`viewer.ts:420`）；AI 语音播完会 `resetToIdle`（`services/chat.ts:352`），说话动作也会替换舞蹈（`model.ts:93`）——**对话会打断舞蹈**，音乐却还在放。

**C. 数据与库管理**

- 条目 `Dance { danceId, name, author, homepage, createAt, src, audio, camera?, cover, thumb, readme, schemaVersion }`（`types/dance.ts`）；素材包里的 `meta.json` 是它的精简版 `{ name, type: "anim", src, audio }`。
- 线上市场索引 `https://vidol-market.lobehub.com/dances/index.json`（`constants/common.ts:3`）→「订阅」= 并行下载封面/音频/动作/镜头存进 IndexedDB（localforage `Cache`，key `dance://id` / `audio://id` / `camera://id`），列表持久化在 `vidol-chat-dance-storage`（`store/dance/index.ts:23-38`，`hooks/useDownloadDance.tsx`）。
- 删除不清 `camera://`，清空不清文件缓存，Object URL 不 revoke；`services/dance.ts` 的 `/api/dance/*` 三个路由在后端并不存在。

**D. 交互流程**

1. 进「相机模式」→ 底部 Operation 栏 Box 图标 → 右侧设置抽屉，五个 Tab（舞蹈 / 动作 / 姿势 / 背景 / 舞台），默认「舞蹈」（`Settings/index.tsx:85,126-158`）。
2. 列表为空：`Empty` + 「舞蹈市场」按钮；市场弹窗（900 px）网格展示封面 + 名字，搜索（快捷键 F），详情面板有 180 px 封面、作者、readme、订阅（分项下载进度）。
3. 已订阅列表（虚拟列表）：48 px 缩略图 + 名字 + 作者；单击只选中，**悬停缩略图出播放遮罩、点遮罩或双击才播放**（`DanceList/Item/index.tsx:145-168,210-227`）；更多菜单「取消订阅」（带确认）。
4. 播放即全屏；Esc 退出全屏或音乐播完结束，或点 AgentViewer 工具栏的停止按钮。**界面上没有「正在播放」标识**（`currentPlayId` 只写不读），不能试听。
5. 「创建舞蹈」表单上传文件后跳 GitHub 新建 issue 投稿。
6. **对话里不能触发跳舞**，没有工具调用。

### 1.2 取舍（我们要什么、不要什么、为什么）

| vidol 的做法 | 我们 | 理由 |
|---|---|---|
| 运行时解析 VMD、运行时 CCD | **改**：导入时烘焙成 `.vrma`，IK 离线解析解 | 桌宠渲染预算有限（idle 降到 12 fps，动作文档 §7）；运行时只认 `.vrma` 是既有约定；离线结果可单测、可复核（§2.1） |
| 固定 30° A-pose | **改**：从参考骨架的 `腕→ひじ` 向量算出实际角度，一套公式覆盖上臂 / 前臂 / 手 / 手指 | 30° 是近似值，MMD 标准模型约 35–40°，误差直接变成手臂抬高 / 穿身 |
| 丢弃 グルーブ、腰、捩骨、上半身3、足D | **改**：グルーブ 并入 hips 位移；腰 并入 hips 旋转；捩骨合并进上 / 前臂；上半身3 并入 upperChest；足D 有帧就叠加 | 实测 21 支里 `グルーブ` 帧数可达 6261（last-surprise）、`腕捩` 普遍有帧，丢掉就少了律动和手腕翻转 |
| spine 被 hips 覆盖、拇指错位一节 | **不沿用**（这是缺陷），单测覆盖 `上半身` 有帧 → spine 非单位、`親指０/１/２` → Metacarpal/Proximal/Distal | — |
| 不用 VMD 贝塞尔 | **改**：按 VMD 每通道（X/Y/Z/旋转）的贝塞尔曲线在 30 fps 上重采样 | 舞蹈的「卡点」就在曲线里；线性插值会把节奏抹平 |
| 1 MMD 单位 = 0.1 m、不按身高缩放 | **改**：位移以参考骨架 hips 高度归一，运行时按目标模型 hips 高度缩放 | 绝对单位只影响「多高的人跳」，归一后对任何身高的模型比例都对（§2.6） |
| 镜头 VMD | **不做** | 桌宠的相机是「把她放进小窗口」的取景，不是 MV 运镜；跟随镜头会让她在 230 px 窗口里忽大忽小、出画（§3.6） |
| 全屏 + 黑底「舞台」 | **不做** | 桌宠是透明窗口，站在用户桌面上跳才是卖点；全屏会盖住用户的工作 |
| 硬切换动作 | **改**：交叉淡化进出（0.6 s / 0.5 s） | 现有动作层已有「权重和恒为 1」的淡化（`vrm-anim.js`），硬切会闪 T-pose |
| 对话打断舞蹈 | **改**：说话时继续跳、音乐压低、嘴型照常 | 桌宠的核心是陪伴聊天，「一说话就停舞」等于两个功能互斥 |
| 点击身体被屏蔽 | **部分沿用**：不播反应动作，但出表情、好感照常计分 | 好感/台词逻辑属于共享层（`touch-zones.js`），动作文档 §2.1 规定不改；用户点了要有回应 |
| 线上市场、订阅、GitHub 投稿 | **不做** | 舞蹈素材几乎都是第三方作品，授权多为「注明作者、个人使用」，我们不分发；渲染进程 CSP 禁外网 |
| IndexedDB 存文件 | **改**：用户数据目录 + 主进程协议 | 与 VRM 模型、动作库一致（`pack://`、`vrmlib://`），可被路径守卫约束、可被备份 |
| 列表：单击选中、悬停/双击才播 | **改**：单击条目直接播放；正在跳的条目有明确状态 | 浮层里「选中」没有用途，多一步就是摩擦（§6） |
| 无「正在播放」标识、无循环、无暂停 | **补齐**：播放中状态、进度、停止、循环 | — |
| 对话不能触发 | **新增**：聊天里说「跳个舞 / 跳《極楽浄土》」本地识别后开跳；API 也能触发 | 桌宠大部分时间被「聊天」驱动 |
| 条目字段（名字、作者、封面、readme、音频、动作） | **沿用思路**，字段重新设计成 `library.json`（§5.3） | readme 里的「请注明动作作者」需要展示出来 |

### 1.3 不照抄的边界

**做法**：参考 vidol 只到「它提供了哪些功能、用户怎么走」这一层。数学全部按公开的 MMD 骨骼语义和四元数换算自己推导，代码在本仓库从零写。实现任务的 PR 里不得出现从 vidol 复制或逐行改写的代码，评审时对照下表检查。

| vidol 模块 | 借鉴的（功能 / 交互思路） | 我们自研 / 重新设计的 | 明确不采用的 |
|---|---|---|---|
| `src/libs/VMDAnimation/vmd2vrmanim.ts`、`vmd2vrmanim.binding.ts`、`loadVMDAnimation.ts` | 「VMD 可以重定向到 VRM humanoid」这一能力；需要处理 A-pose、手系、单位、IK、表情 morph 这几类问题（问题清单） | 自写 VMD 二进制解析（`TextDecoder('shift_jis')`，动作文档 §3.7 已验证）、贝塞尔重采样、骨骼映射表（含捩骨 / グルーブ / 腰 / 上半身3 / 足D）、参考骨架上的 A-pose 角度、Z 平面手系换算、hips 高度归一，输出 `.vrma`（§2） | `mmd-parser` 依赖；它的映射表常量、`IK_OFFSET_INIT` 偏移常量、`fixPositions` 时间线合并逻辑、30° 常量、×0.1 换算、X 平面镜像约定 |
| `src/libs/VMDAnimation/vrm-ik-handler.ts` | 「足 IK 必须解，否则腿不动」 | 离线两骨解析 IK + 膝盖铰链约束 + 脚踝朝向解，遵守 VMD 的 IK 开关帧（§2.5） | 运行时 CCD 求解器、迭代次数 / 步长参数、在原始骨骼上解 IK 的做法 |
| `src/libs/VMDAnimation/loadVMDCamera.ts` | — | — | 镜头 VMD 整体不做（§1.2） |
| `src/libs/VMDAnimation/vrm-model-noise.ts`、`bvh2vrmanim.binding.ts` | — | 活人感已有 L4（`core/vrm-life.js`） | 全部不用 |
| `src/libs/vrmViewer/viewer.ts`（`dance` / `resetToIdle` / `handleDanceEnd`）、`model.ts` | 「一支舞 = 动作 + 音乐（+ 封面）一起播」「以音乐结束为结束」的产品语义；跳舞时屏蔽身体反应动作 | 舞蹈层 D 进入导演状态机，交叉淡化、音频主钟、暂停/续跳、说话时压低音乐、拖起暂停（§3、§4） | 全屏 + 黑底、OrbitControls 切换、`THREE.Audio` + `AudioListener` 挂相机、`THREE.Clock` 推进、每次新建 mixer、语音结束 `resetToIdle` |
| `src/store/dance/*`、`src/store/market/slices/dance.ts` | 「已有舞蹈列表 + 当前播放」两份状态 | 主进程 `src/main/vrm-dances.js` 持有库（文件 + `library.json`），渲染进程只读索引；播放状态在导演里（`plan.dance`）（§5） | zustand + localforage 持久化、IndexedDB 文件缓存、线上索引 `DANCE_INDEX_URL`、订阅/取消订阅模型 |
| `src/services/dance.ts` | — | IPC：`dances:list / import / remove`（§5.5） | `/api/dance/*` HTTP 接口（它本身就不存在）、`downloadGithubDance` |
| `src/types/dance.ts` | 条目应有：名字、作者 / 署名、封面、音频、动作、说明 | `library.json` 条目重新设计：`file / audio / cover / duration / offset / loop / credit / readme / stage / face / bakedWith / src`（§5.3） | `danceId / homepage / thumb / camera / schemaVersion` 这套字段与 `createAt` 命名 |
| `src/app/chat/CameraMode/Settings/DanceList`（`index` / `Item` / `DanceMarketModal`）、`CameraMode/Operation` | 舞蹈列表带封面缩略图和名字；空态引导去「获取舞蹈」；删除要确认 | 入口改成桌宠工具栏图标 + 浮层、设置窗口「舞蹈」页、聊天 / API 触发；单击即播；播放中状态 + 停止 + 循环；导入本地文件替代市场；非 VRM 时的禁用与提示（§6） | 相机模式 → 抽屉 → Tab 的四层路径、悬停遮罩/双击播放、市场弹窗、GitHub 投稿、虚拟列表 |
| `src/services/chat.ts:352`（语音后 `resetToIdle`） | — | 说话不打断舞蹈（§3.4） | 整条做法 |

---

## 2. 运行时格式与 VMD → VRM 重定向

### 2.1 决策：导入时预烘焙成 `.vrma`（不在运行时解析 VMD）

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. 导入时烘焙成 `.vrma`（采用）** | 运行时只认 `.vrma`（动作文档 §3.7），`VRMAnimationLoaderPlugin` + `createVRMAnimationClip` 已在 vendor 里，自动处理 VRM 0.x / 1.0 与 hips 缩放；IK、贝塞尔、位移限幅都离线做完，渲染进程每帧只是 mixer 采样；纯函数可在 Node 单测；一次烘焙，之后每次播放都快 | 导入要等几秒（25 MB 的 last-surprise 估计 3–8 s，放 worker 并显示进度）；改了算法需要重烤（保留源 VMD 副本 + `bakedWith` 版本号，见 §5.3） |
| B. 运行时解析 VMD（vidol 的做法） | 导入即可用 | 渲染进程要带解析器和 IK 求解器；每帧 CCD（两腿 × 40 次迭代）挤占 idle 帧预算；每次播放都要重新解析；与「运行时只认 .vrma」相悖，也绕开了既有的 `.vrma` 校验 |
| C. 运行时解析 + 缓存 | 首播后快 | 兼具 A 的缓存与 B 的复杂度，没有收益 |

**烘焙位置**：现有 `scripts/vrm-bake.js` 读 FBX 要临时安装 `three@0.187.0`（FBXLoader），安装版里没有这个条件。VMD 是简单二进制，解析、重定向、IK、写 `.vrma` 都不需要 three，所以新代码写成纯 JS：

| 新模块 | 内容 |
|---|---|
| `src/core/vmd.js` | VMD 解析（头 30 B + 模型名 20 B；骨骼帧 111 B：名 15 B Shift-JIS、帧号 u32、位置 3×f32、四元数 4×f32、插值 64 B；表情帧 23 B；镜头 61 B；光照、阴影；IK 开关段）+ 贝塞尔求值 + 30 fps 重采样 |
| `src/core/vmd-retarget.js` | 参考骨架、骨骼映射、手系、A-pose、捩骨合并、IK、hips 位移与限幅、表情映射 → `vrm-bake-core` 的 clip 结构 |
| `src/core/vrma-write.js` | 把 `scripts/lib/vrm-bake-core.js` 里与 three 无关的四元数工具和 `writeVrma` / `readVrma` 移到这里（bake-core 改为 re-export），主进程和烘焙脚本共用一份，并加上表情轨道输出（`VRMC_vrm_animation.expressions.preset`） |

主进程导入时在 `worker_threads` 里调用它们；开发时 `scripts/vrm-bake.js --dance <dir>` 走同一函数。

### 2.2 实测素材画像（决定方案细节的依据）

用一次性的只读脚本（`/tmp/vmdscan/scan.js`，不入库）扫描 `~/vrm-assets/dances/**/*.vmd`，节选：

| 舞蹈 | 源模型 | 时长 | 骨骼帧 | 足 IK 帧 | 腿 FK 帧（左足+左ひざ） | 指骨数 | センター 水平最大偏移 | グルーブ 帧 | 表情种类 |
|---|---|---|---|---|---|---|---|---|---|
| vidol-dance-sample 开心摇 | Shenhe | 22.5 s | 2782 | 113 | 81 | 40 | 7.8（≈0.62 m） | 84 | 77 |
| vidol-dance-gokuraku 極楽浄土 | しまかぜ | 218.1 s | 17486 | 1488 | 176 | 40 | 16.3（≈1.3 m） | 1 | 76 |
| vidol-dance-dingdingdangdhang | ZhongLi | 38.7 s | 11381 | 984 | 326 | 40 | 0.0 | 155 | 60 |
| vidol-dance-last-surprise | Tda式初音ミクV4X | 208.7 s | 231808 | 12529 | 6262 | 30 | 51.9（≈4.2 m） | 6261 | 69 |
| vidol-dance-shujiwu 书记舞 | lanruo | 98.5 s | 127135 | **6** | **5485** | 30 | 0.0 | 2767 | 49 |
| TWICE - Like OOH-AHH | Tda式初音ミク | 82.5 s | 12491 | 568 | 291 | 40 | 8.5 | 296 | 63 |
| lupin | サボエレン | 89.6 s | 13235 | 853 | 229 | 40 | 36.7（≈2.9 m） | 1 | 47 |

（单位：MMD 单位；米数按 1 单位 ≈ 0.08 m 估算。）由此得到四个设计约束：

1. **几乎所有舞蹈的腿由足 IK 驱动**，书记舞是例外（已烘成 FK，IK 只有 6 帧）→ 两种都要支持，按 VMD 的 IK 开关段与有没有 IK 帧决定（§2.5）。
2. **水平位移大**（0.5–4.2 m），桌宠窗口只能容纳约 ±0.6 m → 必须限幅（§3.6）。
3. **グルーブ、捩骨、指骨普遍有帧** → 不能丢（§2.3）。
4. **表情 morph 普遍存在**（あいうえお、まばたき、笑い、ウィンク）→ 可选映射（§2.9）。

### 2.3 骨骼映射

VMD 不含骨架，只有「骨名 → 相对 rest 的局部旋转 / 位移」。MMD 骨骼的 rest 朝向都是世界对齐的单位旋转（与 VRM normalized 骨骼一样），所以多数骨骼是「名字对上 + 手系换算」，例外的在表下单列。

| MMD 骨 | VRM humanoid | 处理 |
|---|---|---|
| 全ての親 | （根） | 旋转、位移并入 hips 的世界变换（左乘） |
| センター | hips 位移 | 位移并入 hips；旋转并入 hips 旋转（左乘） |
| グルーブ | hips 位移 | 位移（主要是 y 的律动）叠加到 センター 之后；旋转同上 |
| 腰 | hips 旋转 | 有该骨的动作：旋转并入 hips；`腰キャンセル` 忽略（它在 MMD 里是让腿不跟腰转的补偿骨，我们的 hips 本来就同时带腿） |
| 下半身 | hips 旋转 | `q_hips = q_全ての親 · q_センター · q_グルーブ · q_腰 · q_下半身` |
| 上半身 | spine | MMD 里 上半身 与 下半身 是兄弟（都挂在 センター 下），VRM 的 spine 是 hips 的子：`q_spine = q_下半身⁻¹ · q_上半身` |
| 上半身2 | chest | 直接 |
| 上半身3 | upperChest | 有就直接；模型没有 upperChest 时并入 chest |
| 首 / 頭 | neck / head | 直接 |
| 両目 / 左目 / 右目 | （不映射） | 视线由 lookAt 层负责（动作文档 §3.1），舞蹈时看向用户 |
| 左肩（+左肩P/左肩C） | leftShoulder | 肩P 有帧时左乘并入，肩C 忽略 |
| 左腕 + 左腕捩 | leftUpperArm | 捩骨挂在 腕 和 ひじ 之间，单位 rest：`q_upperArm = q_腕 · q_腕捩`（再做 A-pose 换算，§2.4） |
| 左ひじ + 左手捩 | leftLowerArm | 手捩 挂在 ひじ 和 手首 之间，属于前臂扭转：`q_lowerArm = q_ひじ · q_手捩`。**更正**：动作文档 §3.7 写的「左手首(+左手捩 合并)→leftHand」挂错了骨，以本文为准 |
| 左手首 | leftHand | 直接（A-pose 换算） |
| 左親指０ / １ / ２ | leftThumbMetacarpal / Proximal / Distal | 顺序与层级一致（vidol 错位一节，§1.1） |
| 左人指１ / ２ / ３ | leftIndexProximal / Intermediate / Distal | 中指 → Middle、薬指 → Ring、小指 → Little 同理 |
| 左足 / 左ひざ / 左足首 | leftUpperLeg / leftLowerLeg / leftFoot | FK 帧 + IK 结果（§2.5） |
| 左足D / 左ひざD / 左足首D | 同上 | 有帧时右乘叠加到对应 FK |
| 左つま先 | leftToes | 一般无帧；有就直接 |
| 左足ＩＫ / 左つま先ＩＫ / 左足IK親 | （IK 目标） | 只参与 IK 求解，不输出轨道 |
| 髪 / ﾈｸﾀｲ / スカート / 其它物理骨 | （丢弃） | VRM 用自己的 SpringBone |

右侧同理。名字匹配先做规范化：去掉全角 / 半角差异（`ＩＫ`/`IK`、`０`/`0`）、去掉尾部空白；未识别的骨名计入烘焙报告（`unmapped`），不报错。

### 2.4 A-pose 补偿（参考骨架）

**参考骨架**（`src/core/vmd-retarget.js` 的 `MMD_REF`）：一组 MMD 标准骨骼的 rest 位置常量，比例按 Tda 式初音ミク（21 支素材里 16 支的作者模型，§2.2）在 D1 用素材校准——例如取各舞蹈站立帧（足 IK 偏移 ≈ 0 时腿应伸直）反推 `足→ひざ→足首` 长度。它只用来：(1) 求手臂 A-pose 角，(2) 解腿 IK，(3) 给出 rest hips 高度。

**换算**：MMD 手臂链的 rest 方向是斜向下的 A-pose，VRM normalized 是水平 T-pose。把 MMD 手臂链每根骨看作「T-pose 下再转了 `R` 的 rest」，直接套现有的 `retargetQ(q, R_parent, R_self) = R_parent · q · R_self⁻¹`（`vrm-bake-core.js`，Mixamo 路径同一公式）：

- `R` 对 左腕 / 左ひじ / 左手首 / 左手指 = 绕 z 轴 `−θ_L`（右侧 `+θ_R`），`θ = atan2(Δy, Δx)` 取自参考骨架 `腕→ひじ` 向量（约 35–40°，不写死 30°）；对肩及以上 = 单位。
- 于是：上臂 `q·R⁻¹`（父是肩，`R_parent = I`），前臂 / 手 / 手指 `R·q·R⁻¹`（两侧共轭）。
- 拇指的 rest 还额外朝前下方：`親指` 链的 `R` 用参考骨架 `親指０→親指１` 方向与 VRM 拇指 rest 方向（沿 +x 略偏 +z）之间的旋转，单测覆盖「全零帧 → 拇指保持 VRM rest」。

单测（`test/vmd-retarget.test.js`）：MMD 全零帧 → VRM 手臂停在 `−θ`（自然下垂的 A 字，而不是 T-pose）；`左腕` 绕 z 转 `+θ` → VRM leftUpperArm 为单位（水平）。

### 2.5 足 IK / 腿部

MMD 的规则：足 IK 打开时，`足 / ひざ` 由 IK 决定（FK 帧被覆盖），`足首` 由 `つま先ＩＫ` 决定；关掉时用 FK 帧。VMD 末尾的「IK 开关段」按帧记录每根 IK 骨是否启用（书记舞这类「已烘成 FK」的动作就是关着的）。

每 1/30 s 一帧：

1. **FK 姿态**：参考骨架上算出 hips 世界变换（§2.6，含限幅修正）、`足` 的世界位置。
2. **IK 目标**：`P_ankle = M(足IK親) · (rest_足ＩＫ + Δpos_足ＩＫ)`（手系换算后）；`P_toe` 同理挂在 足ＩＫ 下。
3. **两骨解析 IK**（不是 CCD）：大腿长 `a`、小腿长 `b`、髋到目标 `d = clamp(|P_ankle − P_hip|, |a−b|+ε, a+b−ε)`，余弦定理得膝角；膝盖**只允许绕小腿局部 x 轴向前弯**（铰链，对应 MMD `ひざ` 的 x 轴角度限制），弯曲平面取「髋→目标」与 FK 姿态下膝盖朝向（无 FK 帧时取身体前方）张成的平面。
4. **脚踝**：`足首` 旋转使「足首→つま先」指向 `P_toe`；`足ＩＫ` 自身的旋转帧作为脚掌绕该轴的滚转（vidol 丢掉了这部分）。脚踝相对小腿的偏转夹在 ±60°。
5. 输出 `upperLeg / lowerLeg / foot` 的局部旋转，再走手系换算。

**为什么用解析 IK 而不是 CCD**：两骨 + 铰链膝有闭式解，结果确定、不抖、不依赖迭代次数；MMD 的 CCD 对「够得着的目标」收敛到同一解，差别只在目标够不着时（我们夹到腿伸直）。

**为什么在参考骨架而不是目标模型上解**：在目标模型上解能让脚精确踩在动作作者想要的位置，但每换一个角色就要重烤一遍，且导入时还不知道用户以后会穿哪个模型。参考骨架上解出的是关节角，换到腿长比例不同的模型上，脚的落点会有少量偏差（表现为轻微滑步）——列为风险，D5 可选「按当前模型重烤」（§8）。

### 2.6 左右手系、单位、中心 / 位移

- **手系**：MMD 是左手系，模型面朝 −Z、左侧在 +X；我们的 `.vrma` 沿用现有烘焙产物的约定（glTF / VRM 1.0：右手系、面朝 +Z、左侧在 +X）。换算为对 Z 平面镜像：位置 `(x, y, z) → (x, y, −z)`，四元数 `(x, y, z, w) → (−x, −y, z, w)`。VRM 0.x 模型的翻转交给 `createVRMAnimationClip`（它已经处理）。vidol 是对 X 平面镜像（左右互换后面朝 −Z），那是另一套目标约定，不采用。单测：`左腕` 抬起 → `leftUpperArm` 抬起、手在 +X 侧。
- **单位**：1 MMD 单位记为 0.08 m（标准 158 cm 模型约 20 单位高）。但这个数并不影响结果：`.vrma` 里写入参考骨架的 rest hips 高度（`MMD_REF.下半身.y × 0.08`），`createVRMAnimationClip` 运行时按「目标 hips 高度 / rest hips 高度」缩放全部 hips 位移，所以位移与身高的比例对任何模型都成立；vidol 的固定 ×0.1 不随模型缩放，矮个模型会被「拉着跑」。
- **中心**：hips 位移 = `全ての親` + `センター` + `グルーブ` 的位移合成（各自在父骨空间里，按骨链顺序变换），相对参考骨架 rest hips。位移的水平分量会在 §3.6 做限幅，**同一修正量施加到两只脚的 IK 目标上**再解 IK——否则 hips 被拉回、脚还在原地，腿会被拉直或劈开。

### 2.7 插值与帧率

VMD 帧号按 30 fps；每个骨骼帧带 X / Y / Z / 旋转 4 条三次贝塞尔（控制点 0–127 归一化到 0–1）。烘焙时对每根骨在 `0, 1/30, 2/30…` 求「上一关键帧 → 下一关键帧」之间的曲线值（贝塞尔用二分求参数 t，旋转按曲线进度做 slerp），输出线性关键帧；静止段（连续帧角度差 < 0.05°）去重。体积估算：200 s × 30 fps × 55 骨 × (16 B + 4 B) ≈ 6.6 MB，可接受；超过 120 s 的舞蹈对手指轨道做容差 0.2° 的关键帧精简。

### 2.8 指骨

映射见 §2.3；手指与手同属 A-pose 换算链（§2.4）。VMD 没有手指帧时，烘焙写入「放松弯曲」常量轨道（与 L4 的手指放松同值），保证 `vrm-anim.js` 的「每个片段都给每根骨写值」规则成立（否则淡化时混入 T-pose）。

### 2.9 表情 morph（可选，默认开）

| MMD morph | VRM expression | 说明 |
|---|---|---|
| あ / い / う / え / お | aa / ih / ou / ee / oh | 「跟唱」口型；她在说话时被口型层（L6）覆盖 |
| まばたき | blink | 有这条轨道时，L5 的自动眨眼暂停 |
| ウィンク / ウィンク右 | blinkLeft / blinkRight | MMD 的 `ウィンク` 闭的是**角色左眼**；D1 用 liliya 实机核对左右（vidol 疑似映反） |
| 笑い | happy（×0.6） | 眼睛笑 |
| にこり / にっこり | happy | — |
| 怒り | angry（×0.7） | — |
| 困る | sad（×0.6） | — |
| 其余（真面目、上、下、ω、てへぺろ…） | 不映射 | 计入烘焙报告 |

写成 `.vrma` 的 `VRMC_vrm_animation.expressions.preset` 轨道，运行时 `createVRMAnimationClip` 会绑到模型表情。设置项「跳舞时用舞蹈里的表情」（默认开）关掉时，渲染端不加载表情轨道，改用基线 `happy 0.25` + 自动眨眼。理由：表情让舞蹈「活」起来，但部分 VMD 的表情是为特定模型做的（如 `がに股`），映射失败会怪异，所以给开关。

### 2.10 烘焙输出与校验

- 输出 `.vrma`：节点树为参考骨架换算后的 humanoid rest（与现有 FBX 烘焙相同的 `writeVrma`），rotation 全骨骼 + translation 仅 hips + 可选表情轨道；用 `src/core/vrm.js` 的 `inspectVrmaJson` 校验。
- 同时算出写进索引的度量（§5.3）：`duration`、`extent`（整段里双手 / 头相对 hips 的最大上方与侧向伸展，单位 hips 高度——相机取景用）、`stage.clampHits`（限幅生效帧占比）、`unmapped` 骨名、`ik`（`on` / `fk` / `mixed`）。

### 2.11 D1 实现记录（T-2799）

代码：`src/core/vmd.js`（解析 / 贝塞尔 / 采样 / 写 VMD）、`src/core/vmd-retarget.js`（参考骨架、映射、IK、限幅、表情、报告）、`src/core/vrma-write.js`（从 `scripts/lib/vrm-bake-core.js` 抽出的四元数工具与 `writeVrma` / `readVrma`，bake-core 原样 re-export，并新增表情轨道）、`scripts/vrm-bake.js --dance`、`scripts/vrm-dance-frames.js`（用 vendor 运行时在真实 VRM 上出静帧 + 世界坐标测量，供评审）。测试：`test/vmd.test.js`、`test/vmd-retarget.test.js`。

实现中定下的细节（对上文的补充，不改变结论）：

- **参考骨架**：`MMD_REF` 按约 20 单位高的标准 MMD 模型取值；腿在侧视里取「髋–踝连线上的膝」（rest 腿伸直），否则伸直时 VRM 膝会反折约 6°。A-pose 角由 `腕→ひじ` 算出为 38.35°。
- **hips 原点**：输出的 hips 位移与 rest 节点都减去参考 `下半身` 的 x/z，静止站立 = 正好在原点。
- **IK 模式**：先看 IK 开关段；但「足ＩＫ / 足IK親 从未动过、足 / ひざ 有 FK 帧」判为已烘成 FK（书记舞的 IK 段写着 on，IK 骨只有第 0 帧）。
- **英文骨名**：`vmd.boneName` 先做 NFKC，再把英文骨名折叠到日文标准名：PMX 标准英文名（`center`、`groove`、`upper body2`、`arm_L`、`arm twist_L`、`leg IK_L`、`toe IK_L`、`leg IKP_L`、`fore1_L`、`third1_L`…）以及常见写法（`index/ring/pinky`、`.L` / ` L` / `left_`、mmd_tools 的 `leg_L_D`）；表情同理（`a/i/u/e/o`、`blink`、`wink_R`、`smile`）。分组、IK 开关段、人物/道具判定、重定向都用折叠后的名字，报告 `bones.english` 列出文件里出现的英文名及其对应。
- **追加映射**：`上半身1`（部分模型在 上半身 与 上半身2 之间的一节）右乘并入 spine；`足先EX`（准标准骨架的脚尖）并入 toes。
- **报告**：`bake.json` / `retargetVmd().report` 含 `ikStats`（FK 复核误差、最远目标 / 腿长、伸直占比、膝角范围）、`stage.clampHits`、`extent`、`ground`、`bones.mapped/ignored/unmapped/animated`、`morphs`、`fingers`。

---

## 3. 与现有动作层的关系

### 3.1 舞蹈层 D：独占全身

动作文档 §3.1 的层自下而上是 L0 姿势、L1 idle、L2 持续活动、L3 反应、L4 活人感、L5 表情、L6 口型。舞蹈不是新叠一层，而是**接管基础层**：

| 层 | 跳舞时 | 理由 |
|---|---|---|
| L0 / L1 | 被舞蹈片段替换：导演给出 `plan.base = { id: 'dance:<id>', fade: 0.6, loop, clock }`，`vrm-anim.js` 用现有 `setBase` 交叉淡化 | 复用「权重和恒为 1」的淡化，零 T-pose |
| L2 hold（talk / think / eat / walk / lift） | 不叠加（`plan.overlays = []`）；lift 例外，见 §3.4 | 上半身叠加会把舞蹈手臂拉成讲解手势 |
| L3 reaction | 不播 | 同上 |
| L4 life | 只留：视线微跳（saccade）；关掉：呼吸、重心切换、头部微动、手指放松（片段有手指帧）、拎起腿摆 | 舞蹈本身就有呼吸与重心；叠加会抵消卡点 |
| 朝向 | `facingYaw` 冻结为 0，转身完全由片段的 hips 旋转决定；`turnLead` 归零 | 舞蹈里的转身是编舞 |
| 视线 | lookAt 目标 = 相机（看着用户），头部跟随比例 0（头由片段驱动，只转眼睛） | 让「她在给你跳」 |
| L5 表情 | 有表情轨道 → 用轨道；否则基线 `happy 0.25`；触摸时叠加反应情绪（§3.4） | — |
| L6 口型 | 照常；说话时压过舞蹈的 aa/ih/ou/ee/oh 轨道 | 说话优先 |
| 落地 | `groundOffset` 的坐姿逻辑关闭；全片段用一个常量地面偏移（烘焙时取双脚最低点的 5% 分位），跳跃时允许离地 | 逐帧贴地会把跳跃吃掉 |
| 帧预算 | `frameMode` 的 `busy = true`，保持 active 帧率 | 12 fps 的 idle 帧率下舞蹈会卡 |

**实现挂点**：

- `src/core/vrm-director.js`：新增 `dance` 状态机（`off → cueing → in → on ⇄ paused → out → off`），由新增语义持续量 / 事件驱动：`holds.dance = { id, loop, startedAt }`（来自 app 的舞蹈状态）、`events: dance:start | dance:stop | dance:end`。`PRIORITY` 表新增 `dance`，位于 `drag:lift` 之下、`touch:*` 之上。
- `src/core/vrm-intent.js`：快照新增 `dance`（app 维护的播放状态：id、是否暂停、loop），转成上面的持续量 / 边沿事件；不含任何动作词（保持动作文档 §2.2 的原则）。
- `src/renderer/vrm-anim.js`：`setBase(id, dur, opts)` 增加 `opts.loop: false`（`LoopOnce` + `clampWhenFinished`，末帧定住而不是回 rest——vidol 的缺陷）、`opts.clock: 'external'`（`timeScale = 0`，每帧由 `seekBase(t)` 设 `action.time`，§4.1）；循环换段用同一片段的克隆 action 做 A/B 交叉淡化（three 的 `clipAction` 按 clip+root 唯一）。
- `src/renderer/vrm.js`：舞蹈片段按需加载（`vrmlib://dance/<id>/dance.vrma`，不进 24 个 LRU 动作缓存，单独持有、停舞后 30 s 释放）；舞蹈相机（§3.6）；调试字段（§7.1）。
- `src/renderer/app.js`：只在 `look.kind === 'vrm'` 分支加舞蹈状态与音频（§4），像素路径不动；动作文档 §9.3「明确不改」的文件（`fx.js`、`touch-zones.js`、`pet-state.js`、`rig.js`、`live2d.js`、`renderer/fx.js`）继续不改。

### 3.2 开始

1. 渲染进程拿到 `dance.vrma`（首次 fetch + `createVRMAnimationClip` 约 100–400 ms），**加载完成前不出声、不动**，工具栏按钮显示加载中。
2. `cueing`：基础层 0.6 s 交叉淡化到舞蹈第 0 帧（片段 `time = 0` 定住）；同时相机 0.6 s 过渡到舞蹈取景（§3.6）。
3. `in → on`：淡化完成的那一帧同时开始音乐和动作时钟。理由：先「站到起始姿势」再开拍，避免音乐响了人还在从 idle 往过渡（vidol 是音乐先响）。

### 3.3 结束、停止、循环

- **自然结束**：动作时钟到 `duration`（有音乐时以「动作结束」为准；音乐更长则在动作结束时 1 s 淡出音乐；音乐更短则后面无声跳完）→ 末帧定住 0.3 s → `out`：0.5 s 交叉淡化回导演当前的 idle（无动作库时回到 rest 片段，T-2829） / 姿势调度（idle 片段从随机相位开始，动作文档 T-2691）→ 相机 0.6 s 回到原取景。
- **手动停止**（停止按钮 / Esc / API / 聊天说「别跳了」）：音乐 0.4 s 淡出，动作立即进入 `out`（不等末帧）。
- **循环**：到末尾不进 `out`，音乐与动作同时回到 0；用 A/B 两个 action 在 0.5 s 内从末帧淡到首帧。循环开关在浮层与设置页，默认关（理由：一支三分半的歌循环下去会打扰用户；短的无音乐片段默认开，见 §4.3）。

### 3.4 打断与恢复

| 事件（语义事件，动作文档 §2.2） | 跳舞时的处理 | 恢复 | 理由 |
|---|---|---|---|
| `drag:lift`（拖起）/ 抛飞 | 暂停：动作时钟与音乐同时暂停，0.25 s 淡到 `hold.lift`（原有拎起表现：腿下垂摆动） | 放下（`drag:drop` / 落地）后 0.6 s，从暂停点续跳（0.4 s 淡回，音乐同时续播）；暂停超过 10 s 视为停止 | 被拎起时身体必须响应；放下就续跳最符合「被打断一下」的直觉，长时间不放下说明用户想让她停 |
| `touch:*`（点身体）/ `touch:pat` | 不播反应动作；只叠加该触摸的反应**表情**（attack 0.15 s / release 0.6 s）+ 视线短暂看向触摸点 0.6 s；好感、台词、语音照旧（`touch-zones.js` 不改） | — | 全身被舞蹈占用；但点了要有回应，共享层逻辑不能因 VRM 改变 |
| `talk`（她在说话：聊天回复、触摸台词、主动搭话） | 继续跳；音乐压低到 30%（0.2 s 渐变），说完 0.5 s 渐回；口型层压过舞蹈口型轨道 | 自动 | 陪伴聊天不应与舞蹈互斥（vidol 的反例） |
| `think`（在等 agent 回复） | 继续跳，不压音乐 | — | 思考没有声音，不需要让 |
| 用户发消息 / 语音输入（ASR 录音中） | 录音期间音乐压低到 15%，结束后恢复 | 自动 | 不能让音乐进麦克风 |
| `walk`（漫游） | 跳舞期间 app 不发起漫游（`fx.walkPet` 的调用方在 VRM 跳舞时跳过） | 停舞后照常 | 窗口移动会把舞步拖着走 |
| 喂食 / 玩耍 / 睡觉（工具栏）、API `/anim` | 先停舞（音乐 0.4 s 淡出、动作 `out`），再执行该动作 | — | 这些是用户明确的新指令，且都要用身体 |
| 窗口隐藏 / 最小化（`frameMode` paused） | 暂停（含音乐） | 窗口回来后续跳 | 看不见她时不该继续放歌 |
| 换角色 / 换外观 / 切到非 VRM / 模型卸载 | 立即停止（音乐立即停，不淡出），释放片段 | — | 片段属于当前人形，继续播放没有对象 |
| `celebrate:*`（孵化 / 进化）、`cue:*` | 丢弃 | — | 低于舞蹈优先级（动作文档 §3.3 的优先级表新增 dance） |

### 3.5 状态与数据流

```
入口（工具栏浮层 / 设置页 / 聊天 / API）
   │ window.pet.dance.play(id, {loop}) / IPC 'dance:play'
   ▼
app.js（VRM 分支）：danceState = { id, loop, paused, t0 }，持有 <audio>（§4）
   │ 每帧快照 snap.dance = { id, loop, paused, t: 音频时钟或渲染时钟 }
   ▼
vrm-intent.js → holds.dance / events dance:*
   ▼
vrm-director.js → plan.base = dance:<id>（fade、loop、clock）、overlays = []、life 掩码、face、gaze=camera、camera=dance
   ▼
vrm-anim.js setBase / seekBase(t) → vrm.js 取景、表情、口型 → render
```

app 是唯一持有「当前在跳哪支、是否暂停」的地方（与 `thinking` / `talkUntil` 一样），导演只读快照，所以打断规则可以在导演里纯函数单测。

### 3.6 窗口与取景

**现状**：桌宠窗口 230×340（`src/main/main.js` `SIZES.pet`，可按「大小」缩放）；全身取景下她占画布高度 `vrm.height`（默认 0.8）。以 1.5 m 高的模型算约 180 px/m，画布中心到左右边约 0.63 m。舞蹈的水平位移 0.5–4.2 m、张开双臂约 ±0.75 m，**原样播放必然出画**。

| 方案 | 做法 | 问题 |
|---|---|---|
| A. 临时放大窗口 | 跳舞时窗口扩到约 2.5×，结束还原 | 透明大窗口会挡住其下桌面的点击（需要逐像素穿透，Electron 的 `setIgnoreMouseEvents(true, {forward:true})` 在 Linux 上不转发）；靠近屏幕边时没法往外扩；与「大小」设置、多显示器定位冲突 |
| **B. 窗口不变：限位 + 相机拉远（采用）** | 烘焙时对 hips 水平位移做「漂移软限幅」，运行时相机按片段伸展范围拉远 | 跳得「更原地」、人更小一些 |
| C. 让窗口跟着 hips 移动 | 把 hips 水平位移转成窗口位移 | 窗口移动是系统调用、不均匀（动作文档 T-2711 的实测），跟不上 30 fps 的舞步；还会把窗口带出屏幕 |

**B 的细节**：

1. **漂移软限幅（烘焙时）**：hips 水平位移 `p(t)` 拆成慢漂移 `p̄(t)`（2 s 居中滑动平均）与律动 `p − p̄`；输出 `p' = (p − p̄) + R·tanh(|p̄|/R)·p̄/|p̄|`，`R = 0.15 × hips 高度`（约 0.12 m）；律动分量再整体夹在 `0.35 × hips 高度` 内。修正量 `p' − p` 同时加到两只脚的 IK 目标上（§2.6）。纵向（蹲、跳）不限。转身（hips 旋转）不动。
2. **舞蹈取景（运行时）**：`extent`（§2.10）给出整段里手 / 头相对 hips 的最大上伸与侧伸（hips 高度为单位）；舞蹈相机 = 全身取景，再按 `max(1, 上伸 / 站立头高, 侧伸 / 画布半宽可容纳量)` 拉远，使整段都在画内（她大约缩到画布高度的 0.6–0.7）。半身取景（`data-framing=half`）在跳舞期间临时切到全身，停舞后切回，沿用现有 0.35 s 相机滑动。
3. 设置项「舞台范围」：`原地`（上面的 R）/ `小范围`（R = 0.3 × hips 高度，相机再拉远）——放到 D5，P1 先只做「原地」。

### 3.7 D2 运行时实现记录（T-2800）

代码：`src/core/vrm-dances.js`（索引清洗 `cleanDanceIndex`、列表 / 查找 / 随机、`cannotDance` 非 VRM 原因、内置示例条目）、`src/core/dance-demo.js`（「节拍摇摆」关键帧与合成节拍 WAV）、`src/main/vrm-dances.js`（目录优先级、`vrmlib://dance/…` 白名单与 Range、列表）、`src/main/vrm-library.js`（vrmlib 处理器分派 `dance` 主机）、`src/core/vrm-director.js`（舞蹈层 D 状态机 `DANCE`）、`src/core/vrm-intent.js`（`holds.dance` / `holds.recording`、`dance:start|stop` 事件）、`src/renderer/vrm-anim.js`（外部时钟 `setBase(…, { clock: 'external' })`、`seekBase(t, { blend })`、`remove`）、`src/renderer/vrm.js`（舞蹈片段加载与释放、舞蹈相机、固定地面、调试字段）、`src/renderer/vrm-dance.js`（控制器：音乐、时钟、暂停 / 续跳、压低、静音 / 音量）、`src/renderer/app.js`（接入快照、喂食 / 玩耍 / 睡觉 / `/anim` / Esc 先停舞、跳舞时不发起漫游）、`src/main/main.js` + `preload.js`（IPC `dances:list` / `dance:play` / `dance:stop` / `dance:state`，`window.pet.dance.*`）、`src/core/api.js`（`GET /dances`、`POST /dance`、`POST /dance/stop`、`/state.dance`）、`prefs.danceVolume`（设置 → 桌宠行为 → 动作 → 舞蹈音乐音量）。`scripts/vrm-bake.js --dance` 现在同时复制音乐 / 封面 / readme 并原子写入 `<out>/library.json`，开发机默认 `~/vrm-assets/baked-dances` 即可被应用直接读到。e2e：`xvfb-run -a node e2e/run.js vrmdance`（夹具 `scripts/make-test-dance.js`）。

与上文的出入（均为等效实现，不改结论）：

- **示例舞**由主进程在内存里生成并以 `vrmlib://dance/demo/dance.vrma`、`audio.wav` 提供（`dance-demo.js` → `writeVrma` / WAV），渲染进程与普通舞蹈走同一条加载与音频路径；不落盘、不进仓库文件。
- **音量**用 `<audio>` 元素的 `volume`（设置音量 × 压低系数，0.2 s 斜坡）实现，不接 WebAudio：同样不进口型分析器，且不会因 AudioContext 未启动而静音。
- **循环接缝**：控制器每次回绕计数，渲染端只在计数变化时用 A/B 两个 action 做 0.5 s 淡化；调试 `seek` 是硬切（便于按时间点核对姿势）。
- **舞台限位**：D1 的限幅把慢漂移限在 0.15、律动夹在 0.35 hips 高度内，e2e 按「≤ 0.5 hips 高度且头 / 手 / 脚始终在画布内」断言（§7.3 第 7 步原写的 0.15 只约束慢漂移）。
- 本任务不含：工具栏按钮与浮层、设置页「舞蹈」管理页、导入流程、聊天识别（D3 / D4）。工具栏、浮层、设置页、导入与删除见 §6.4（T-2801）。

### 3.8 运行时舞蹈：对外接口说明（T-2800）

只有 **VRM 外观** 能跳舞。其它外观（像素 / 图片 / Live2D）一律返回 `not-vrm` 与一句说明原因的中文文案，不静默失败。

#### 舞蹈库（主进程 `src/main/vrm-dances.js`）

| 项 | 说明 |
|---|---|
| 目录优先级 | `$PIXELPET_VRM_DANCES_DIR`（位于仓库内则拒绝，`refused`）→ `<userData>/vrm-dances`（有 `library.json` 时）→ 开发运行（非打包、非测试）时 `~/vrm-assets/baked-dances` → `<userData>/vrm-dances` |
| 开发机接入转换产物 | `node scripts/vrm-bake.js --dance ~/vrm-assets/dances/<包或文件夹>`：把 `~/vrm-assets/dances` 里的 VMD 烘焙成 `dance.vrma`，复制音乐 / 封面 / readme，原子写入 `~/vrm-assets/baked-dances/library.json`；应用开发运行时自动读取，或设 `PIXELPET_VRM_DANCES_DIR=<目录>` |
| URL | `vrmlib://dance/library.json`（清洗后的索引；无文件时为空索引）、`vrmlib://dance/<id>/<file>`；`<id>` 匹配 `^[a-z0-9-]{1,48}$`，`<file>` 只允许 `dance.vrma`、`audio.(mp3/wav/ogg/m4a/flac)`、`cover.(jpg/jpeg/png/webp)`；解析后必须以舞蹈目录 + 分隔符开头；支持 Range（206）。内置示例 `demo` 由主进程内存生成 |
| CSP | 桌宠页 `media-src 'self' blob: vrmlib:`（`connect-src` 已含 `vrmlib:`） |
| 索引条目 | `{ id, name, file, audio?, cover?, duration, audioDuration?, offset, loop, credit?, face, ik?, extent{up,side}, stage?, ground, source, bakedWith?, importedAt? }`（`core/vrm-dances.js cleanDanceIndex`） |

#### 主进程 IPC / preload（`window.pet.dance`）

| 调用 | IPC | 返回 |
|---|---|---|
| `window.pet.dance.list()` | `dances:list` | `{ dir, source: env\|userData\|dev\|none, refused?, error?, vrm: bool, reason?, message?, dances: [{ id, name, duration, music, cover, loop, face, builtin, credit? }] }` |
| `window.pet.dance.play({ id?, name?, loop? })` | `dance:play` | `{ ok: true, id, name, loop, duration, music, audio }` 或 `{ ok: false, reason: not-vrm \| vrm-not-ready \| no-dance \| load-failed \| no-pet, message?, kind?, dances? }` |
| `window.pet.dance.stop()` | `dance:stop` | `{ ok: true, id, reason }` 或 `{ ok: false, reason: 'not-dancing' }` |
| `window.pet.dance.state()` | `dance:state` | `null`（没在跳）或下方状态对象 |

状态对象（`renderer/vrm-dance.js state()`）：`{ id, name, state: cueing|in|on|paused|out, t（播放进度，秒）, duration, loop, paused, pausedBy: lift|hidden|null, music, audio: playing|paused|muted|ducked|none|failed, clock: audio|render, volume, gain, muted, ducked, exclusive（是否独占全身）, drift（ms）, media?{ t, paused, ready, error, rate } }`。

#### 本地 HTTP API（`src/core/api.js`，127.0.0.1 + `Authorization: Bearer <token>`）

| 路由 | 请求 | 成功 | 失败 |
|---|---|---|---|
| `GET /pixel-pet/dances` | — | `200 { ok, dir, source, vrm, dances: [...] }` | — |
| `POST /pixel-pet/dance` | `{ "id"?: "…", "name"?: "…", "loop"?: bool }`（都不给则随机一支，避开刚跳过的） | `200 { ok, id, name, loop, duration, music }` | `409 not-vrm { message, kind }`、`404 no-dance { dances }`、`502 load-failed { message }`、`409 vrm-not-ready`、`400 bad-id / bad-name / bad-loop` |
| `POST /pixel-pet/dance/stop` | — | `200 { ok, id }`；没在跳时 `200 { ok, id: null, dancing: false }` | — |
| `GET /pixel-pet/state` | — | 原有字段 + `dance: <状态对象> \| null` | — |

非 VRM 时的文案：`舞蹈只有 VRM 外观可以跳。她现在是像素外观，换成 VRM 模型再来吧。`（`像素` 按外观替换为 `图片` / `Live2D`）。

#### 设置

`prefs.danceVolume`（0–100，默认 60）：设置 → 玩法 → 和她一起 → 舞蹈 → 跳舞时 → 音乐音量（T-2801 起；之前在 桌宠行为 → 动作），或 `window.pet.setPrefs({ danceVolume })`；全局静音 `prefs.muted` 时音乐静音、动作照跳；她说话时音乐压到 30%，录音时 15%。

#### 调试字段（e2e 断言用）

VRM 画布：`data-dance`（id 或空）、`data-dance-state`（off/cueing/in/on/paused/out）、`data-dance-t`（进度 s）、`data-dance-audio`、`data-dance-drift`（ms）、`data-dance-hips`（x,z m）、`data-dance-cam`（相机拉远倍数）、`data-dance-exclusive`（1 = 独占全身）；`#pet-body[data-dancing="1"]`；`window.PetVRM.debug().figures[0].dance`（含 `weightSum`、`layers`、`clips`）；`window.PetVRM.director.dance.seek(t) / speed(k)`；`window.PetVRM.director.framePoints()`；`window.petFx.dance()`（控制器状态 + 计数 `lastStop`）。

---

## 4. 音乐同步、音量与静音

### 4.1 同步：音频时钟为主钟

- 渲染进程用一个 `<audio>`（`src` 为 `vrmlib://dance/<id>/audio.<ext>`），接入现有 `AudioContext` 的一个独立 `GainNode`（**不接**口型分析器 `AnalyserNode`——否则她的嘴会跟着音乐动）。
- 每帧：`t_motion = audio.currentTime − outputLatency + offset`，`offset` 来自索引（默认 0；MMD 舞蹈惯例是动作第 0 帧对齐音频开头）；`vrm-anim` 用 `seekBase(t_motion)` 直接设 `action.time`，**不用帧间隔累加**，所以不会漂。
- 音频缓冲卡顿（`waiting` 事件）时动作跟着停；`seeking` 后立刻跟上。
- 调试字段 `data-dance-drift` = 「实际设给 action 的时间 − 由音频时钟算出的时间」（应恒为 ~0），另记录 `audio.currentTime` 每秒增量与墙钟的偏差，用于发现音频本身的卡顿。

**为什么不用 mixer 自己的时钟再校准**：桌宠的帧率会在 12/30/60 fps 之间切换、窗口隐藏时停帧，帧间隔累加必然漂；音频是用户最敏感的那一端，以它为准最简单。

### 4.2 音量与静音

| 控制 | 行为 |
|---|---|
| 全局「静音」（工具栏静音按钮，`prefs.muted`） | 舞蹈音乐静音，动作照跳；跳舞中切换立即生效 |
| 「朗读」关闭 | 不影响音乐（朗读只管她的说话声） |
| 舞蹈音量（新设置项 `dance.volume`，0–100%，默认 60%） | 设置页滑块；跳舞中改动实时生效 |
| 说话 / 录音时压低 | 见 §3.4（30% / 15%），通过 GainNode 渐变，不改用户设置值 |
| 系统音量 | 不碰 |

理由：沿用已有的全局静音口径（`app.js` 静音按钮的提示「让她不出声」也覆盖音乐），再给音乐一个独立音量，因为舞曲通常比语音响得多。

### 4.3 无音频舞蹈与异常

| 情况 | 处理 |
|---|---|
| 舞蹈本身没有音乐（只导入了 VMD / `.vrma`；Mixamo 短舞蹈循环） | 动作时钟用渲染时钟（`t += dt`，窗口隐藏时停）；时长 ≤ 15 s 的默认循环；列表里标「无音乐」 |
| 音乐文件丢失 / 解码失败 | 退回渲染时钟照跳，提示「音乐没能播放，只跳舞」（一次），`data-dance-audio=failed` |
| 音乐比动作长 / 短 | 以动作为准（§3.3） |
| 不支持的格式（如 `.ncm` 网易云加密格式，`addiction/` 里就有） | 导入时拒绝并说明：「这个音乐文件是加密格式，换成 mp3 / wav / ogg / m4a」 |
| 静音中 | 仍按音频时钟走（`muted` 的 `<audio>` 照常推进），保证取消静音时对得上 |

---

## 5. 舞蹈库

### 5.1 位置

| 内容 | 位置 | 进 git | 进安装包 |
|---|---|---|---|
| 原始素材（VMD / 音频 / 封面 / readme） | `~/vrm-assets/dances/`（开发机）或用户自己的任意目录 | ❌ | ❌ |
| 导入后的舞蹈 | `<userData>/vrm-dances/<id>/`：`dance.vrma`、`audio.<ext>`、`cover.<ext>`、`readme.txt`、`src/<原 VMD 文件>` | ❌ | ❌ |
| 索引 | `<userData>/vrm-dances/library.json` | ❌ | ❌ |
| 内置示例舞（原创） | `src/core/dance-demo.js`：关键帧数据（JSON 结构，几十个关键帧）+ 节拍描述 | ✅（我们自己创作的数据，非第三方） | ✅ |
| 开发覆盖目录 | `$PIXELPET_VRM_DANCES_DIR`（位于仓库内则拒绝，同 `PIXELPET_VRM_MOTIONS_DIR`） | ❌ | ❌ |

**为什么不放进 `vrm-motions/`**：动作库目录是烘焙产物，开发时会指向 `~/vrm-assets/baked` 并被 `vrm-bake.js` 整体重写；舞蹈是用户导入的、要长期保留的数据，生命周期不同。

### 5.2 协议与加载（沿用 `vrmlib://`）

`src/main/vrm-library.js` 的 `resolveUrl` 现在只接受 `female|male|neutral` 下的 `.vrma` 与 `index/library.json`。扩展：

- `vrmlib://dance/library.json` → 舞蹈索引（不存在时回空索引 `{ schema: 1, dances: {} }`，不报 404，同现有做法）；
- `vrmlib://dance/<id>/<file>`，`<id>` 匹配 `^[a-z0-9-]{1,48}$`，`<file>` 只允许 `dance.vrma`、`audio.(mp3|wav|ogg|m4a|flac)`、`cover.(jpg|jpeg|png|webp)`；`path.resolve` 后必须以舞蹈目录 + `path.sep` 开头（与现有前缀检查一致）；
- 音频需要支持 Range 请求（`<audio>` 拖动与时长读取），`net.fetch(file://)` 已带。
- 内置示例舞不走文件：渲染进程直接用 `dance-demo.js` 生成 clip（`id = demo`），节拍由 WebAudio 合成。

渲染进程的 GLTFLoader URL 白名单已放行 `vrmlib://`（`vrm.js` `loadVrma`），无需改 CSP 以外的东西；CSP `media-src` 增加 `vrmlib:`。

### 5.3 索引格式 `library.json`

```jsonc
{
  "schema": 1,
  "dances": {
    "gokuraku-3f2a": {
      "name": "極楽浄土",                       // 来自 meta.json name，导入时可改
      "file": "gokuraku-3f2a/dance.vrma",
      "audio": "gokuraku-3f2a/audio.mp3",       // 无音乐时省略
      "cover": "gokuraku-3f2a/cover.jpg",       // 可省略
      "duration": 218.1,                        // 动作时长（s）
      "audioDuration": 216.4,                   // 可省略
      "offset": 0,                              // 动作相对音乐的偏移（s），设置页可微调
      "loop": false,                            // 默认是否循环（≤ 15 s 且无音乐 → true）
      "credit": "Motion by yurie",              // 从 readme 识别或用户填写；列表与详情里展示
      "readme": "gokuraku-3f2a/readme.txt",     // 原包说明（授权要求），原样保存
      "face": true,                             // 含表情轨道
      "ik": "on",                               // on | fk | mixed（§2.10）
      "stage": { "radius": 0.15, "clampHits": 0.42 },
      "extent": { "up": 1.31, "side": 0.86 },   // hips 高度为单位（§3.6）
      "source": "vidol-pack",                   // vidol-pack | mmd-folder | vmd | vrma
      "src": { "motion": "gokuraku.vmd", "audio": "Gokuraku jodo.mp3", "meta": "meta.json" }, // 原文件名，仅记录
      "bakedWith": "vmd-retarget@1",            // 算法版本；升级后可从 src/ 副本重烤
      "importedAt": "2026-11-03T10:00:00.000Z"
    }
  }
}
```

与素材包结构的对应：vidol 包的 `meta.json { name, type: "anim", src, audio }` → `name`、`src.motion`、`src.audio`；包内 `cover.jpg`（优先）/ `thumb.jpg` → `cover`；`readme.txt` → `readme`（并从中提取 `Motion by …` / `动作作者：…` 填 `credit`）；`package.json`、`README.md` 忽略。`type` 只接受 `anim`（vidol 的唯一取值），其它值提示不支持。校验函数 `cleanDanceIndex` 写在 `src/core/vrm-dances.js`（纯函数，同 `core/vrm-library.js` 的 `cleanIndex`）。

### 5.4 内置示例

第三方舞蹈不能随应用分发，所以「内置」只放我们自己做的：

- **「节拍摇摆」**（`id: demo`，约 16 s，可循环）：在 `src/core/dance-demo.js` 里用人形骨骼关键帧手写（左右摆胯、拍手、抬手比心、转半圈回来），节拍 120 BPM；音乐用 WebAudio 合成的鼓点（底鼓 + 拍手，代码生成，无音频文件）。
- 它的作用：(1) 新用户不导入也能看到功能；(2) 非 VRM 时的提示有具体对象；(3) e2e / 单测的确定性夹具（关键帧已知，便于断言骨骼角度）。
- 不打算把 `~/vrm-assets` 里任何一支舞做成内置，包括 vidol 的 5 个包（它们的 readme 要求注明作者、部分音乐有版权，我们无权再分发）。

### 5.5 用户导入流程

入口：设置窗口 → 舞蹈 →「导入舞蹈…」（§6.3），或把文件夹拖进设置页的舞蹈列表。

1. **选择**：系统对话框可选一个文件夹，或多选文件（`.vmd` / `.vrma` + 可选音频 + 可选图片 + 可选 `.txt`）。
2. **识别**（主进程 `src/main/vrm-dances.js` → `core/vrm-dances.js` 的 `detectDance(listing)`，纯函数可单测）：
   - 有 `meta.json` 且 `type: "anim"` → vidol 包：按 `src` / `audio` 取文件；
   - 否则 MMD 文件夹：动作 VMD = 骨骼帧最多且非镜头的 VMD（镜头 VMD 判据：骨骼帧 0、镜头帧 > 0）；`Chair.vmd` 这类只有 1 根骨的道具动作排除；有多个候选（`Motion_1/Motion_2` 双人、`_L/_R`、分段）时让用户选一个；音频 = 唯一的 mp3/wav/ogg/m4a/flac（多个时选与 VMD 同名或最长的，可改）；封面 = 第一张 jpg/png/webp；readme = `readme*.txt` / `Readme-Rules.txt` 等；
   - 单个 `.vrma`：直接用（检查 `inspectVrmaJson`），不烘焙。
3. **确认页**（模态，§6.3）：名字（可改）、动作文件、音乐（可换 / 去掉）、封面预览、时长、署名与 readme 摘录、一行说明「舞蹈素材只保存在这台电脑上，不会随角色包导出或分享」，按钮「导入舞蹈」/「取消」。
4. **烘焙**：主进程 worker 里解析 + 重定向（§2），进度条（解析 / 解 IK / 写文件），可取消；失败时说明原因（如「这个 VMD 里没有人形骨骼的动作，可能是镜头或道具动作」）。
5. **写入**：`<userData>/vrm-dances/<id>/`（`id` = 名字转 ASCII slug + 4 位随机），复制音频 / 封面 / readme，VMD 副本放 `src/`；原子写 `library.json`（先写临时文件再 rename）。
6. **完成**：列表顶部出现新条目，toast「已导入《極楽浄土》」，带「让她跳」操作。
7. **删除**：条目菜单「删除」→ `confirmModal`（`okText: '删除舞蹈'`、`cancelText: '取消'`，规则 R-03），删目录 + 索引条目；正在跳这支时先停。

开发辅助：`node scripts/vrm-bake.js --dance ~/vrm-assets/dances/vidol-dance-gokuraku [--out <dir>]` 用同一识别 + 烘焙逻辑写到 `$PIXELPET_VRM_DANCES_DIR`（缺省 `~/vrm-assets/baked-dances`），拒绝写到仓库内。

### 5.6 防泄漏守卫（沿用动作文档 §6.4 并扩展）

- `.gitignore`：`*.vmd *.VMD *.vrma` 已有；新增 `*.ncm`、`vrm-dances/`、`baked-dances/`。
- `package.json` `build.files`：已有 `!**/*.vmd`；补 `!**/*.VMD`（现有缺口）、`!**/*.ncm`、`!**/vrm-dances/**`。
- `npm test` 守卫（扩展 `test/vrm-library.test.js`）：`git ls-files` 中不得有 `.vmd/.ncm`；不得有路径含 `dances/` 的音频或图片；`src/core/dance-demo.js` 不得引用任何文件路径；`resolveUrl` 对 `vrmlib://dance/..%2f…`、`vrmlib://dance/x/../../a.mp3`、非白名单文件名、大写绕过返回 null。
- e2e 打包守卫（`e2e/vrm.js` 现有 packaging guard）：扩展到 `.ncm`，并检查 app 包内没有任何与 `~/vrm-assets/dances/` 下文件同名的文件（有素材时）。
- 舞蹈不属于角色包：`packShareable` / 导出角色包时不含舞蹈；设置页明确写「不会随角色包导出」。
- `PIXELPET_VRM_DANCES_DIR` 与烘焙 `--out` 位于仓库内一律拒绝（复用 `vrm-library.js` 的 `insideRepo`）。

---

## 6. 交互设计（按 lobe-design 流程）

### 6.0 流程记录

按 CLAUDE.md：读了 `.agents/ux/product.md`（平台 desktop；桌宠窗口用 `--lobe-*` 令牌；设置窗口用 `@lobehub/ui`；copy-profile consumer，人称「你」）、`.agents/ux/components.md`（`.popup` 对照 `Dropdown`、`.icon-btn` 对照图标按钮、设置页 `Form` / `PageHeader` / `confirmModal` / `toast`）、`.agents/ux/lobe-design-rules.md`（R-03 确认框中文按钮、R-04 桌宠窗口只用令牌 + lucide 内联图标、R-05 rail 只有 4 个入口）。路由：

```
$ node .agents/skills/lobe-design/scripts/route.mjs "为桌宠 VRM 角色设计舞蹈功能的交互：入口（工具栏/设置页/对话或 API 触发）、舞蹈列表、播放/停止/循环、非 VRM 角色时的禁用与提示，产出方案文档"
场景：product-polish（已有产品迭代打磨）　颗粒度：medium
Pipeline：00-brief → 40-flow → 70-detail
```

本任务只产出方案，不改界面代码；实现任务改完代码后按 CLAUDE.md 跑 `node "$LOBE_DESIGN/scripts/lint-lobe.mjs" <改动路径>`，FAIL 全部修掉，并补 50-visual / 80-review。

### 6.1 00 · brief（lite）

- **页面类型**：桌宠窗口的工具栏浮层（主）+ 设置窗口「舞蹈」页（管理）· **主任务**：让她跳一支舞 / 让她停下 · **密度**：浮层紧凑（230 px 宽），设置页常规。
- **使用者**：单个主人，本机；来意是「逗她玩 / 当桌面 BGM」，频率低到中；导入是一次性的高成本操作（找素材、等烘焙）。
- **关键决定**：跳哪一支（需要：名字、封面、时长、有没有音乐）；要不要停 / 循环（需要：正在跳的是哪支、进度）。
- **Kano**：必备 = 列表、播放、停止、非 VRM 时说明原因；期望 = 循环、进度、音量、署名；兴奋 = 聊天里说「跳个舞」她就跳、内置示例舞（点缀，不占浮层主区）。
- **风险**：删除舞蹈不可撤回（确认）；音乐突然响起打扰（默认音量 60%、尊重全局静音）；导入第三方素材的授权（只本机使用的说明 + 展示 readme）。
- **非目标**：舞蹈市场 / 下载、编舞编辑、镜头运镜、双人舞、像素角色跳舞。

### 6.2 40 · flow（规划：L1–L6）

**L1 定位**：舞蹈是 VRM 外观的一种「和她一起」的玩法；入口放在用户本来就会去的地方（桌宠工具栏、设置窗口「和她一起」、聊天），不新增窗口、不新增右键菜单。

**入口候选（Develop：两个互斥方案）**

| | 方案 A：工具栏独立「跳舞」图标按钮 + 浮层（**采用**） | 方案 B：并入「玩耍」按钮（单击仍是玩耍，旁边小箭头展开含「跳舞 ▸」的菜单） |
|---|---|---|
| 发现性（福格 P） | 图标常驻，VRM 外观下一眼可见 | 藏在二级，用户不会去点小箭头 |
| 操作成本（福格 A） | 2 次点击：按钮 → 舞蹈 | 3 次：箭头 → 跳舞 → 舞蹈 |
| 宽度 | 图标按钮 28 px，与静音 / 设置同排，230 px 放得下 | 不增加宽度 |
| 语义 | 「跳舞」与「玩耍」是不同的事（玩耍 = 一次性动作反馈，跳舞 = 一段持续表演 + 音乐） | 混在一起，停止入口更深 |

选 A：主路径最短，停止与循环有固定位置。

**为什么不加右键菜单**：桌宠窗口里右键 / 长按已定为「打开设置」（`app.js` `bindPetPointer` 的 `onMenu`、`contextmenu` 监听，T-2718 去掉了 ⋯ 菜单），重新引入菜单会推翻这条全局约定，并且触屏长按没有对应物。

**L2 信息架构**

*桌宠：跳舞浮层*（`#dance-menu`，样式同 `.popup`，对照 `Dropdown`）

1. 正在跳（仅跳舞时显示）：封面 24 px + 名字 + 进度「1:23 / 3:38」+ 「循环」切换（`aria-pressed`）+ 「停止」按钮。
2. 舞蹈列表：每行 = 封面 32 px（无封面用 lucide `music` 占位）+ 名字（单行省略）+ 右侧时长；无音乐的行在时长前加「无音乐」小字。顺序：最近跳过的在前，内置示例在最后。超过 6 行时列表区内部滚动（最大高度约 6 行），不撑高窗口（M-08）。
3. 底部链接「管理舞蹈…」→ 打开设置窗口 `#/dances`。

*设置窗口：玩法 → 和她一起 → 舞蹈*（`settings-schema.js` 的 `together` 组新增 `{ page: 'dances', label: '舞蹈', icon: 'Music' }`；rail 仍是 4 个入口，规则 R-05）

1. `PageHeader`「舞蹈」，说明一句「让她在桌面上跳舞。只有 VRM 外观可以跳。」，主操作「导入舞蹈」（唯一 primary）。
2. 当前外观提示（`Alert`，仅非 VRM 时）：见 L5。
3. 舞蹈列表（卡片网格，`Surface`）：封面、名字、时长、「无音乐」/「含表情」`Tag`、署名一行；卡片主按钮「让她跳」，更多菜单：详情（readme 全文、原文件名、导入时间、算法版本）、删除。
4. 设置（`Form` 分组「跳舞时」）：音乐音量 `Slider`；默认循环 `Switch`；用舞蹈里的表情 `Switch`；聊天里说「跳舞」时她会跳 `Switch`。
5. 页尾说明：「舞蹈素材只保存在这台电脑上，不会随角色包导出或分享。」

**L3 核心链路**

- 对象状态：舞蹈条目 `导入中 → 可用 → (删除)`；播放 `off → 加载中 → 跳舞中 ⇄ 暂停（被拎起 / 窗口隐藏）→ 结束 → off`。
- 主链路：悬停桌宠 → 工具栏「跳舞」→ 点一支 → 浮层关闭、她开跳，按钮变为激活态 → 再点按钮 → 浮层顶部「停止」。
- 分支：
  - 聊天：你说「跳个舞」/「跳一下極楽浄土」/「来段舞」→ 本地识别（`src/core/dance-intent.js`，正则 + 舞蹈名模糊匹配，不调用模型）→ 有匹配就跳那支，否则随机一支（排除刚跳过的）；消息照常发给 agent，她的回复照常显示 / 朗读（压低音乐）。「别跳了 / 停下」→ 停止。理由：LobeHub Responses 路径不能用工具调用，模型触发不可控；本地识别确定、零成本，开关可关。
  - API（`src/core/api.js` 的 `ROUTES`，本机 127.0.0.1 + token）：`GET /pixel-pet/dances`（列表）、`POST /pixel-pet/dance { "id"?: "…", "name"?: "…", "loop"?: bool }`、`POST /pixel-pet/dance/stop`；`GET /pixel-pet/state` 增加 `dance: { id, name, t, duration, loop, paused } | null`。错误：`409 not-vrm`、`404 no-dance`、`409 busy`（正在导入烘焙）。
  - 设置页「让她跳」→ IPC 到桌宠窗口，与浮层同一个 `dance.play`。
  - Esc：没在思考时停止跳舞（`app.js` 现有 Esc 只取消思考，扩展一个分支）。
- 出口：每条链路都能回到 off；停止总是 0.4 s 内有可见反馈（音乐淡出 + 动作开始回 idle）。

**L4 组件功能**

- 工具栏按钮：VRM 外观时出现；`aria-label="跳舞"`，跳舞中 `aria-pressed="true"`、`title="正在跳《…》，点一下可以停止或换一支"`；加载片段时转圈并禁用。
- 浮层行：单击即播（不做选中态）；正在跳的那行标记「正在跳」；键盘上下选择、Enter 播放、Esc 关闭浮层。
- 设置页卡片：「让她跳」在非 VRM 时禁用（见 L5）；删除走确认。

**L5 状态清单（交 70）**：舞蹈库空（只有示例）/ 索引读取失败 / 片段加载中 / 片段加载失败 / 音乐失败 / 非 VRM 外观 / 18+ 或衣柜规则导致外观变化中 / 导入中 / 导入失败 / 删除正在跳的那支 / 窗口隐藏暂停 / 被拎起暂停。

**L6 验收（Given / When / Then）** 见 §7.3 的 e2e 步骤；完成的定义：§7.3 全部步骤通过 + §7.4 真实素材评审。

**简化（W-07）**：浮层不放音量（音量是低频设置，进设置页）；不做「选中」态；不做试听（点一下就是跳，停止也只要一下）；导入确认页不让用户调 offset（详情里可调，默认 0 对 MMD 惯例已足够）。

### 6.3 70 · detail（状态与边界）

| 维度 | 处理 |
|---|---|
| 非 VRM 外观 | **桌宠工具栏**：不显示「跳舞」按钮——230 px 工具栏里一个永远点不了的按钮只是噪音，像素角色本来就没有舞蹈；**设置页**：顶部 `Alert`（info）「舞蹈只有 VRM 外观可以跳。她现在是像素外观。」+ 操作「去换外观」（跳到 `#/characters/<id>` 的外观）；卡片「让她跳」禁用并带 `Tooltip`「换成 VRM 外观后可以跳」；**聊天 / API**：不跳，她用一句本地台词回应「我现在这个样子跳不了舞……换成 VRM 模型再来吧」（只说一次，10 分钟内不重复），API 回 `409 not-vrm`。 |
| 空态 | 浮层：只有示例舞时，列表下方一行「导入更多舞蹈…」（W-04 给出第一步）；设置页：示例卡片 + 空态说明「把 MMD 舞蹈（.vmd，可带音乐和封面）的文件夹导入进来」+「导入舞蹈」。 |
| 加载 | 片段首次加载：按钮转圈 + 浮层行内转圈，期间不响音乐；> 3 s 显示「准备中…」；导入烘焙：确认页内进度条（解析 / 计算腿部动作 / 写入）+「取消导入」。 |
| 失败 | 片段失败：toast「《…》没能载入，可能文件被删了。到 设置 → 舞蹈 重新导入」，条目标「需要重新导入」；导入失败：确认页内 `Alert`（error）写清原因与出路（W-05）；音乐失败：见 §4.3；索引损坏：当作空库 + 设置页提示「舞蹈列表读取失败，已导入的文件还在 `<路径>`」，不清空文件。 |
| 冲突 | 删除正在跳的那支：先停再删；跳舞中换外观：立即停；导入中再导入：按钮禁用「正在导入上一支」。 |
| 边界输入 | 名字超长单行省略（浮层）/ 两行省略（卡片），`title` 显示全名；日文名照常显示（Shift-JIS 已解码）；100+ 支舞：浮层只列最近 6 支 + 「全部舞蹈…」链接到设置页（设置页卡片网格分页 24 / 页）；文件名含 emoji / 全角符号：`id` 用 slug，原名只记录。 |
| 反馈 | 每个动作都有可见结果：开跳（按钮激活 + 她开始动）、停止（音乐淡出 + 回 idle）、循环（按钮 `aria-pressed` 变化 + 文案「循环播放」）、导入完成（toast + 新卡片置顶）、删除（toast）。 |
| 可访问性 | 按钮有可访问名；浮层 `role="menu"`、行 `role="menuitem"`，键盘可达；进度文字而非只有进度条；「无音乐」用文字不用颜色；焦点环沿用 `.btn` 的令牌样式；`prefers-reduced-motion` 时浮层不做位移动画（舞蹈本身是角色美术，不受影响）。 |
| 一致性 | 术语统一：「舞蹈」（对象）、「跳舞」（动作）、「让她跳」（按钮）、「停止」「循环播放」「导入舞蹈」「删除舞蹈」；不用「播放」「动作文件」「VMD」等技术词（详情里才出现原文件名）。 |
| 响应式 | 桌宠窗口随「大小」缩放：浮层宽度 = 窗口宽 − 16 px，最小 200 px；设置窗口 ≥ 768 px 双列卡片，更窄时单列。 |

### 6.4 界面实现记录（T-2801）

按 CLAUDE.md 走 lobe-design：读了 `.agents/ux/product.md`、`components.md`、`lobe-design-rules.md`；`route.mjs "实现桌宠 VRM 舞蹈交互界面：工具栏跳舞按钮与舞蹈浮层、设置窗口舞蹈页（列表、导入、删除、音量、循环）、非 VRM 时禁用并说明原因"` → `00-brief → 30-structure → 40-flow → 70-detail`（00 / 40 / 70 沿用 §6.1–6.3，30 的组件选择见下表）。`lint-lobe.mjs` 对全部改动路径 0 FAIL（`src/main/main.js` 里两处存量的 `BrowserWindow.backgroundColor` 字面色值按 I-10 在 `product.md` 写了放行理由）。

| 位置 | 实现 | 组件 / 令牌 |
|---|---|---|
| 桌宠工具栏 | `#btn-dance`（lucide `music`，图标按钮）：只有 VRM 外观显示；跳舞中 `aria-pressed="true"`，`title` 写正在跳哪支；片段加载中转圈并禁用。有它时工具栏收紧间距，仍是一行（252 px） | `.icon-btn`，`--lobe-*` 令牌（R-04） |
| 跳舞浮层 `#dance-menu` | `role="menu"`；顶部「正在跳《…》」+ 进度 `0:02 / 0:06`（250 ms 刷新）+ 循环播放（`aria-pressed`）+ 停止；列表行 = 封面 32 px（无封面用 `music` 占位）+ 名字（单行省略）+「无音乐 · 时长」/「正在跳」/「准备中…」；导入的舞蹈按本次会话最近跳过的排前、最多 5 支，示例舞在最后；底部「管理舞蹈… / 导入更多舞蹈… / 全部舞蹈（N）…」→ 设置窗口 `#/dances`；↑↓ 移动焦点、Enter 播放、Esc 只关浮层（不停舞）；加载失败用桌宠窗口的提示条给出原因与「打开舞蹈设置」 | `.popup`（对照 `Dropdown`） |
| 设置窗口 玩法 → 和她一起 → 舞蹈（`#/dances`） | `PageHeader`（主操作「导入舞蹈」= 多选文件，次操作「选文件夹导入」）；非 VRM / 未唤醒时 `Alert`（info）「舞蹈只有 VRM 外观可以跳 · 她现在是像素外观…」+「去换外观」；「正在跳」卡（封面、进度条、音乐音量 `Slider`（与下方「跳舞时 · 音乐音量」同一个 `prefs.danceVolume`）、循环播放 `Switch`、停止）；舞蹈卡片网格（封面、名字两行省略、时长、`Tag`：正在跳 / 内置示例 / 无音乐 / 含表情、署名；「让她跳」/「停止」，非 VRM 时禁用 + `Tooltip`「换成 VRM 外观后可以跳」；删除 `ActionIcon` → `confirmModal`「删除舞蹈 / 取消」，正在跳这支时说明会先停下）；`Form`「跳舞时 · 音乐音量」（`prefs.danceVolume` 从「桌宠行为」移到这里）；页尾「只保存在这台电脑上」+ 舞蹈库位置。「能不能跳」取设置窗口自己的 `view.look.kind`，换外观立即生效 | `@lobehub/ui`：`PageHeader` `Surface` `Alert` `Button` `Tag` `Switch` `Progress` `Tooltip` `ActionIcon` `Slider` `Modal` `Input` `Select` `toast`；样式只用 `cssVar` |
| 导入确认 `Modal` | 名字（可改）、动作（多个候选时 `Select`，带时长）、时长、音乐（`Select` + 「换一个…」+「不带音乐」）、封面预览（「换封面… / 不要封面」）、署名、readme 摘录、警告（还有其他动作、`.ncm` 加密音乐）、「不会随角色包导出或分享」；「导入舞蹈」后显示转换中进度条与「取消导入」；失败在弹窗内 `Alert`（error）写原因与出路 | 同上 |
| 玩法 Hub 卡片 | 状态一句：「她现在是 VRM 外观，可以跳舞 · 音乐音量 60%」/「她现在不是 VRM 外观，跳不了舞」 | `HubPage` |

**导入（主进程 `src/main/dance-import.js`，纯识别在 `src/core/vrm-dances.js detectDance`）**：`dance-import-pick`（系统对话框；e2e 用 `debug-next-open`，多个路径用换行分隔）→ `inspect`：读出文件夹 / 所选文件，逐个 VMD 解析与分类（镜头 / 道具 / 舞蹈），vidol 包按 `meta.json`，否则取骨骼帧最多的舞蹈动作，音乐 = 包内指定 / 与动作同名 / 最大，封面 = `cover.*` / `thumb.*` / 第一张图，readme 解码（UTF-8，失败再试 Shift-JIS）并提取署名 → 草稿（token，30 分钟有效）。`dance-import-commit`：`worker_threads` 里跑 `vmd-retarget.bakeVmd` 并用 `inspectVrmaJson` 校验（起不来 worker 时同进程跑），写进 `<舞蹈库>/.<id>.tmp/` 再 rename 成 `<id>/`（`dance.vrma`、`audio.<ext>`、`cover.<ext>`、`readme.txt`、`src/<原 VMD>`），`library.json` 先写临时文件再 rename；同一时间只允许一支在导入。`dance-import-extra` 换音乐 / 封面（拒绝 `.ncm` 与不支持的格式）；`dance-import-cancel` 终止 worker；`dance-remove` 正在跳这支时先立即停，再删目录与索引（示例舞不能删）。`id` = 名字的 ASCII slug + 4 位十六进制（无 ASCII 时 `dance-xxxx`）。

失败文案（`IMPORT_ERRORS`）：没选到文件 / 没有 .vmd / 只有镜头或道具动作 / VMD 读不出来 / 素材包不是舞蹈 / 加密音乐 / 音乐或封面格式不对 / 文件太大（动作 64 MB、音乐 200 MB、封面 10 MB）/ 动作转换失败 / 舞蹈库位置不可用 / 写文件失败 / 导入已过期 / 正在导入上一支 / 已取消——每条都说清发生了什么、怎么办。

新增 IPC（设置窗口 `window.petAdmin`）：`dances` `dancePlay` `danceStop` `danceState` `danceLoop`（`dance:loop` → 桌宠窗口控制器 `setLoop`）`danceImportPick` `danceImportExtra` `danceImportCommit` `danceImportCancel` `danceRemove`。`dances:list` 的条目多了 `coverUrl`（`vrmlib://dance/<id>/cover.*`；设置窗口与桌宠窗口的 CSP `img-src` 加了 `vrmlib:`）、`importedAt`，列表多了 `importing`。

本任务不含：聊天里说「跳个舞」的本地识别、详情页（readme 全文、offset 微调）、拖文件夹进设置页导入、按舞蹈记住默认循环——留给后续任务。

验证：`npm test`（新增 `test/dance-import.test.js`：识别、失败文案、署名、id、导入→入库→删除、镜头 / 损坏 VMD、拒绝仓库内目录）；e2e `xvfb-run -a node e2e/run.js danceui`（8 步：像素外观禁用 → 导入失败 → 导入确认与入库 → VRM 入口与浮层 → 播放中（浮层 + 设置页）→ 设置页关循环 / 音量 / 停止 → 删除正在跳的舞 → 换回像素；截图 `out/e2e/vrm/danceui-*.png`，录屏 `danceui.webm` 与章节 `danceui-evidence.json`）；回归 `vrmdance`、`admin`、`petui`。

---

## 7. 调试字段与 e2e 验收方案

### 7.1 调试字段

**VRM 画布**（在动作文档 §7 现有字段之外新增，均为字符串）：

| 字段 | 取值 | 用途 |
|---|---|---|
| `data-dance` | 舞蹈 id 或 `''` | 是否在跳、跳哪支 |
| `data-dance-state` | `off` / `cueing` / `in` / `on` / `paused` / `out` | 生命周期断言 |
| `data-dance-t` | 动作时间（s，1 位小数） | 进度、暂停冻结、循环回绕 |
| `data-dance-audio` | `playing` / `paused` / `muted` / `ducked` / `none` / `failed` | 静音、压低、无音乐 |
| `data-dance-drift` | 动作时间 − 音频时钟推算值（ms，整数） | 同步 |
| `data-dance-hips` | hips 水平偏移（m，2 位小数）`x,z` | 限位 |
| `data-dance-cam` | 舞蹈相机相对常规全身取景的拉远倍数 | 取景 |

现有字段在跳舞时的预期：`data-layers` 只有 `dance:<id>:1.00`（淡化期间两项、和为 1）、`data-overlays` 为空（拎起时为 `hold:hold.lift:…`）、`data-reaction` 为空、`data-mode=active`。

**`window.PetVRM.debug().dance`**：`{ id, state, t, duration, loop, paused, audio: { t, volume, muted, gain, ducked }, drift, hips: [x, z], clampHits, extent, cam, faceTrack, ik }`。

**`window.PetVRM.director`**：新增 `dance.seek(t)`（测试跳到某时间点）、`dance.speed(k)`（无音乐时加速时钟）。

**桌宠 DOM**：`#pet-body[data-dancing="1"]`；工具栏按钮 `#btn-dance[aria-pressed]`；浮层 `#dance-menu`。

**主进程**：`dances:list` 的返回带 `dir`（舞蹈目录）与 `source`（`env` / `userData`），e2e 用来断言「文件在 userData、不在仓库」。

### 7.2 单元测试（`npm test`，纯 Node，不需要素材）

| 文件 | 测什么 |
|---|---|
| `test/vmd.test.js` | 测试内构造 VMD 二进制（Shift-JIS 骨名、表情、IK 开关段、空镜头段）→ 解析结果；贝塞尔求值（线性控制点 = 线性；ease-in 中点 < 0.5）；30 fps 重采样；镜头 VMD / 道具 VMD 判据 |
| `test/vmd-retarget.test.js` | 手系：`左腕` 抬起 → `leftUpperArm` 抬起、手在 +X；A-pose：全零帧 → 手臂下垂 θ，`左腕` 转 +θ → 单位；捩骨合并；`上半身` 有帧 → spine 非单位（vidol 的缺陷不复现）；`親指０/１/２` 顺序；センター + グルーブ → hips 位移，按 rest hips 归一；两骨 IK：可达目标误差 < 1 mm、膝只向前弯、不可达时腿伸直；IK 关闭帧用 FK；漂移软限幅：|p̄| 远大于 R 时输出 ≤ R、律动分量保留、脚 IK 目标同步平移（腿长不变）；表情映射；写出的 GLB 过 `inspectVrmaJson` |
| `test/vrm-dances.test.js` | `detectDance`：vidol 包（用 tmp 目录里伪造的 meta.json + 空文件）、MMD 文件夹（含 Camera.vmd、Chair.vmd、两个 Motion 候选）、单 `.vrma`、`.ncm` 拒绝；`cleanDanceIndex` 校验；`resolveUrl` 舞蹈路径与各种穿越；`credit` 从 readme 提取（`Motion by yurie`、`动作作者：妮谷丹`） |
| `test/vrm-director-dance.test.js` | 注入时钟：dance 开始 → base 为舞蹈、overlays 空、life 掩码正确、facingYaw 0；拖起 → paused + hold.lift，放下 0.6 s 后续跳且时间从暂停点继续；拖起 > 10 s → 停止；touch → 只有 face、无 reaction；talk → 仍在跳、`duck` 标志；喂食 → out；结束 → out 后回 idle，任何时刻权重和 = 1；loop → 不进 out |
| `test/dance-intent.test.js` | 「跳个舞」「来段舞」「跳一下节拍摇摆」「跳《極楽浄土》」（按舞蹈名 / 名字中的词 / id 匹配；实现未做简繁转换）、「别跳了」只在跳舞时生效、不误触（「跳过这一步」「心跳」「舞台」「我不想跳舞」） |
| `test/api.test.js`（扩展） | `/dance`、`/dance/stop`、`/dances`、`/state.dance`；错误码 |
| `test/vrm-library.test.js`（扩展） | §5.6 守卫 |

### 7.3 e2e：`xvfb-run -a node e2e/run.js vrmdance`

新场景写在 `e2e/vrm.js`（与 `vrm` / `vrmimport` 同文件），用即时生成的自制 VRM（`scripts/make-test-vrm.js`）和新增的 `scripts/make-test-dance.js`：在测试数据目录外的临时目录生成**自制** VMD（已知关键帧：t=1 s 右臂抬到水平、t=2 s 左臂抬起、t=3 s `センター` x 平移 30 单位、t=4 s 下蹲（足 IK y −3）、带 `あ` 表情帧）+ 6 s 合成 WAV（每秒一声提示音）+ 一张生成的 PNG 封面，不依赖任何第三方素材。步骤（每步截图 `out/e2e/vrmdance/*.png`，全程录屏并按步骤打章节）：

1. **像素外观**：工具栏没有 `#btn-dance`；设置窗口 → 玩法 → 和她一起 → 舞蹈：`Alert` 文案含「只有 VRM 外观」，「让她跳」全部禁用；`POST /pixel-pet/dance` → `409 not-vrm`；聊天「跳个舞」→ 本地台词，`data-dance` 不存在。
2. **导入**：设置页「导入舞蹈」（对话框由测试桩返回临时目录）→ 确认页显示名字 / 时长 6.0 s / 封面 / 音乐 → 「导入舞蹈」→ 新卡片置顶；`dances:list.dir` 在 `PIXELPET_DATA_DIR/vrm-dances` 下，仓库里 `git status --porcelain` 无新增文件。
3. **换上 VRM**：工具栏出现 `#btn-dance`；点开浮层：示例「节拍摇摆」+ 导入的测试舞，键盘 ↓ Enter 可选。
4. **开跳**：点测试舞 → `data-dance-state` 依次出现 `cueing`/`in` → `on`；淡化期间 `data-layers` 两项和为 1；`on` 后只有 `dance:<id>:1.00`，`data-overlays` 空，`data-mode=active`，`data-dance-audio=playing`。
5. **重定向正确性**：`director.dance.seek(1.0)` → `pose.rightUpperArm` 与水平夹角 < 8°；`seek(2.0)` → 左臂同理；`seek(0)` → 双臂下垂角与 θ 差 < 8°（A-pose 补偿）；`seek(4.0)` → 双膝屈曲 > 30°、膝盖朝前（IK）、脚踝高度 < 3 cm（不穿地不悬空）。
6. **同步**：连续 5 s 每 200 ms 采样，`|data-dance-drift| ≤ 40`；`data-dance-t` 与 `audio.currentTime` 差 ≤ 0.05 s。
7. **限位与取景**：t = 3–3.5 s `data-dance-hips` 的 |x| ≤ 0.15 × hips 高度 + 0.01；所有采样帧里头顶与双手的屏幕投影都在画布内；`data-dance-cam` > 1。
8. **静音 / 音量**：点静音 → `data-dance-audio=muted`、`data-dance-t` 仍在增长；取消静音恢复；设置页音量 30% → `debug().dance.audio.gain` ≈ 0.3。
9. **拖起**：拖起 → `paused`、`data-dance-t` 冻结、`data-overlays` 含 `hold.lift`；放下 → ≤ 1.2 s 回到 `on`，`t` 从冻结值继续（差 < 0.2 s）。
10. **点击**：点头 → `data-reaction` 仍为空、`data-expr` 出现该触摸的表情、好感值按 touch-zones 规则变化。
11. **说话**：触发一句内置语音包台词 → 仍 `on`、`data-dance-audio=ducked`、`data-mouth` 非零；说完恢复 `playing`。
12. **结束**：`seek(5.5)` 后自然结束 → `out` → `off` ≤ 1.5 s，`data-idle` 恢复，全程权重和 = 1（无 T-pose 帧）。
13. **循环**：浮层开「循环播放」再跳 → 过了 6 s 未进 `out`，`data-dance-t` 回绕到 < 1。
14. **停止**：Esc → `out` ≤ 0.5 s；API `POST /dance` → 开跳、`GET /state.dance.id` 正确、`POST /dance/stop` → 停。
15. **打断类停止**：跳舞中点「喂食」→ 先 `out` 再进食；跳舞中切回像素外观 → 音频停止、无渲染错误。
16. **示例舞**：「节拍摇摆」开跳，`data-dance-audio=playing`（WebAudio 合成）、关键帧角度符合 `dance-demo.js`。
17. **删除**：设置页删除测试舞（确认框按钮「删除舞蹈」/「取消」）→ 目录被删、浮层不再列出。
18. **守卫**：打包守卫扩展项（§5.6）；页面无渲染错误、控制台无 CSP 报错。
19. 像素回归：`xvfb-run -a node e2e/run.js touch`、`rig`、`live2d`、`vrm` 照旧通过。

### 7.4 真实素材验收（本机，非 CI）

`.agents/acceptance/scripts/vrm-dance-real-acceptance.js <仓库> <输出目录> --dances ~/vrm-assets/dances --model ~/vrm-assets/models/模型文件/莉莉雅/liliya.vrm --male ~/vrm-assets/models/模型文件/vroid.vrm`：

- 拒绝仓库内路径；把 5 个 `vidol-dance-*` 包与 3 支第三方（TWICE、Bon Bon Chocolat、lupin：分别覆盖「普通 IK」「グルーブ 多」「大位移」）走真实导入流程；
- 每支舞按固定时间点截图（liliya / vroid 各一套），录一段 30 s 桌面视频（x11grab）；
- 指标：脚踝在支撑期的滑移（≤ 腿长 15%）、膝角始终 ≥ 0（不反折）、手进躯干胶囊的帧占比（≤ 3%）、hips 限位生效占比、`drift` 最大值、片段加载耗时、导入烘焙耗时（last-surprise 25 MB ≤ 10 s）；
- 输出「舞蹈 → 截图 / 指标」对照表，供人工评审「像在跳舞、卡点、不穿模」。

---

## 8. 分阶段任务与风险

### 8.1 任务拆分

| 阶段 | 内容 | 主要文件 | 完成标准 |
|---|---|---|---|
| **D1 解析与重定向** | `core/vmd.js`、`core/vmd-retarget.js`、`core/vrma-write.js`（从 bake-core 抽出）、参考骨架校准、`scripts/vrm-bake.js --dance` | `src/core/*`、`scripts/vrm-bake.js`、`scripts/lib/vrm-bake-core.js` | §7.2 前两个测试文件全绿；5 个 vidol 包离线烘焙成功，用一个静帧渲染脚本（Node + 现有 vendor 不可用时用 e2e 页面）出关键帧截图供评审 |
| **D2 舞蹈层运行时** | 导演 dance 状态机、intent 快照、`vrm-anim` 外部时钟 / LoopOnce / A-B 循环、`vrm.js` 舞蹈取景与调试字段、`app.js` 音频（主钟、音量、压低、静音）、打断规则、示例舞 `dance-demo.js` | `src/core/vrm-director.js`、`vrm-intent.js`、`src/renderer/vrm-anim.js`、`vrm.js`、`app.js` | `test/vrm-director-dance.test.js` 全绿；e2e 第 4–16 步（以示例舞 + 临时注入的测试舞） |
| **D3 舞蹈库与导入** | `main/vrm-dances.js`（目录、worker 烘焙、IPC、原子写索引）、`vrmlib://dance/…`、`core/vrm-dances.js`（识别、校验）、守卫、设置页「舞蹈」（走 lobe-design：50-visual / 70-detail / lint-lobe / 80-review） | `src/main/*`、`src/core/*`、`admin/src/console/pages/*`、`src/core/settings-schema.js`、`.gitignore`、`package.json` | `test/vrm-dances.test.js` 全绿；e2e 第 1–2、17–18 步；`lint-lobe.mjs` 无 FAIL |
| **D4 入口** | 工具栏按钮与浮层、Esc、聊天识别 `core/dance-intent.js`、API 路由、非 VRM 提示台词 | `src/renderer/index.html`、`app.js`、`style.css`、`src/core/api.js`、`src/main/pet-service.js` | e2e 全部步骤；`petui` 亮暗截图；§7.4 真实素材验收 |
| D5（可选） | 表情映射实机核对与开关默认值；「小范围」舞台；按当前模型重烤（脚步更准）；Mixamo 舞蹈短循环（`mixamo/` 87 段 Dance，走现有 FBX 烘焙）作为「无音乐小舞」 | — | 视评审反馈 |

依赖：D2 依赖 D1 的 `.vrma` 结构（但可先用示例舞开发）；D3 依赖 D1；D4 依赖 D2、D3。D1 与「D2 用示例舞」可并行。

### 8.2 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| 参考骨架与舞蹈作者模型比例不同 | 膝角偏差、轻微滑步 | 参考骨架按 Tda 式初音ミク 比例校准（多数素材）；§7.4 的滑步指标；D5 按模型重烤 |
| A-pose 角、拇指 rest 估计误差 | 手臂整体偏高 / 偏低、拇指扭曲 | 角度从骨架算不写死；全零帧单测；liliya 实机截图评审 |
| VRoid 体型（宽裙、大袖、长发）穿模 | 手进身体、腿穿裙 | 测 §7.4 的穿模占比；必要时烘焙参数 `armOpen`（上臂外展偏移，现有 `offset` 机制） |
| hips 限幅改变编舞（大位移舞看起来「原地踏步」） | 观感 | 只限慢漂移、保留律动；「小范围」舞台；列表详情显示 `clampHits` 让用户知道这支舞位移大 |
| 大 VMD（25 MB、23 万帧）烘焙慢 / 内存高 | 导入卡顿 | worker 线程 + 进度 + 可取消；按骨流式重采样 |
| 输出 `.vrma` 体积（3 分钟 ~6 MB） | 首次加载 100–400 ms | 加载完成前不出声；停舞后 30 s 释放；手指轨道精简 |
| 音频输出延迟因系统不同 | 动作略早于声音 | 用 `AudioContext.outputLatency` 补偿；`offset` 可在详情里微调 |
| 舞曲版权 / 动作授权 | 法律 | 只本机使用；不分发、不进 git / 安装包 / 角色包；展示 readme 署名；守卫测试 |
| 聊天识别误触（「跳过」「舞台」） | 意外开跳 | 关键词需含「跳 + 舞」或明确舞名；否定词表；设置开关；单测反例 |
| 跳舞时 CPU / GPU 占用（持续 active 帧率） | 发热、耗电 | 窗口隐藏即暂停；帧率上限 30 fps（舞蹈素材本身 30 fps） |
| 透明窗口里大动作被画布裁切 | 出画 | 相机按 `extent` 拉远；e2e 第 7 步断言投影在画布内 |

---

## 9. 使用方式（T-2803）

本节写给使用者和接手的开发者：怎么放置 / 导入舞蹈、怎么让她跳和停、本地 API、素材授权、怎么验证。前提：她穿的是 **VRM 外观**（设置窗口 → 角色 → 她 → 装扮 → 导入 VRM… → 穿上；仓库里没有模型，可用 `node scripts/make-test-vrm.js /tmp/test.vrm` 生成一个 CC0 测试模型）。像素 / 图片 / Live2D 外观不跳舞，所有入口都会说明原因（§3.8）。

### 9.1 放置 / 导入舞蹈

| 方式 | 做法 | 落到哪里 |
|---|---|---|
| **设置窗口导入（推荐，安装版就能用）** | 设置窗口 → 玩法 → 和她一起 → **舞蹈** →「导入舞蹈」（多选 `.vmd` + 可选音乐 mp3 / wav / ogg / m4a / flac、封面 jpg / png / webp、readme）或「选文件夹导入」（vidol 舞蹈包按 `meta.json`；MMD 文件夹自动跳过镜头 / 道具 VMD，多个动作时在确认页选）→ 确认页改名 / 换音乐 / 换封面 →「导入舞蹈」→ 转换（worker 线程，可取消）→ 卡片出现 | `<数据目录>/vrm-dances/<id>/`：`dance.vrma`、`audio.<ext>`、`cover.<ext>`、`readme.txt`、`src/<原 VMD>`；索引 `<数据目录>/vrm-dances/library.json`。数据目录 = Electron `userData`（e2e / 多开时为 `$PIXELPET_DATA_DIR`） |
| **开发机批量烘焙** | 把素材放在 `~/vrm-assets/dances/<包或文件夹>`，运行 `node scripts/vrm-bake.js --dance ~/vrm-assets/dances/<包>`（`--out <dir>` 可改输出） | 默认 `~/vrm-assets/baked-dances/`（含 `library.json`）；开发运行（`npm start`，非打包）自动读取；或 `PIXELPET_VRM_DANCES_DIR=<目录> npm start`。输出 / 覆盖目录在仓库内一律拒绝 |
| **内置示例「节拍摇摆」**（`id: demo`） | 无需操作 | 由 `src/core/dance-demo.js` 在内存里生成（自制关键帧 + 合成节拍 WAV），不落盘、不能删 |

导入失败会写明原因与出路，例如：只有镜头 / 道具动作（「这里的 .vmd 只有镜头或道具的动作，没有人形骨骼的舞蹈动作。找到跳舞的那个 .vmd（通常最大）再导入。」）、音乐是加密的 `.ncm`、格式不支持、文件过大（动作 64 MB / 音乐 200 MB / 封面 10 MB）、正在导入上一支等（`src/main/dance-import.js` `IMPORT_ERRORS`）。删除：舞蹈卡片的垃圾桶 →「删除舞蹈」（正在跳这支会先停）。

### 9.2 触发与停止

| 入口 | 开始 | 停止 |
|---|---|---|
| 桌宠工具栏 ♪「跳舞」（仅 VRM 外观显示） | 点开浮层 → 点一支（↑↓ + Enter 也行）；跳舞中按钮为按下态 | 再点开浮层 →「停止」；或在桌宠窗口按 **Esc** |
| 设置窗口 → 舞蹈 | 卡片「让她跳」 | 「正在跳」卡或卡片上的「停止」；同卡可切「循环播放」、调音乐音量 |
| 本地 API | `POST /pixel-pet/dance` | `POST /pixel-pet/dance/stop` |
| 渲染进程 / 自动化 | `window.pet.dance.play({ id, loop })` | `window.pet.dance.stop()` |

跳舞时的打断规则（§3.4）：**拖起她** → 暂停（动作与音乐一起停，叠拎起姿势），放下 0.6 s 后从暂停点续跳；**拖着不放超过 10 s** → 视为不想让她跳了，停止并回到 idle；**点她** → 只有表情回应和原有的触摸台词 / 好感，不打断舞步；**她说话** → 继续跳、音乐压到 30%；**喂食 / 玩耍 / 睡觉 / `/anim`** → 先停舞再执行；**窗口隐藏** → 暂停，显示后续跳；**换外观 / 换到非 VRM** → 立即停止、音乐立即停。自然跳完 → 末帧停 0.3 s → 0.5 s 淡回 idle。

音量：设置窗口 → 舞蹈 →「跳舞时 · 音乐音量」（`prefs.danceVolume`，默认 60）；工具栏静音按钮同时静音舞曲（动作照跳）。

| 聊天框（T-2805） | 说「跳个舞」/「来段舞」/「跳一下节拍摇摆」/「跳《極楽浄土》」：本地规则识别（`src/core/dance-intent.js`，不调用模型），点名的跳那支，没点名的随机一支（避开刚跳过的）；消息照常发给她的 agent | 说「别跳了」/「停下」/「不跳了」（只在跳舞时生效，她还在想上一句时也生效） |

聊天识别的规则：要有「跳 + 舞」或「跳一下 / 跳《」加一支已有舞蹈的名字；「跳过」「跳转」「心跳」「舞台」等不算；「不想跳舞」「我不会跳舞」这类否定不算；超过 60 字的长句当作聊天、不识别。非 VRM 外观说「跳个舞」：不跳，她回一句本地台词「我现在这个样子跳不了舞……换成 VRM 模型再来吧。」（10 分钟内只说一次）。设计里的「聊天触发开关」（§6.2 设置项）未做，识别始终开启。

### 9.3 本地 API

在设置窗口 → 设置 → 连接 → **对外接口** 打开「开启对外接口」（只监听 127.0.0.1，默认端口 7340，首次开启自动生成令牌）。所有请求带 `Authorization: Bearer <令牌>`：

```bash
T=<令牌>; B=http://127.0.0.1:7340/pixel-pet
curl -s -H "Authorization: Bearer $T" $B/dances                                   # 列表 + 当前能不能跳（vrm / reason）
curl -s -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"id":"demo","loop":false}' $B/dance                                     # 开跳；不给 id/name 则随机一支
curl -s -H "Authorization: Bearer $T" $B/state | jq .dance                          # 播放状态（id、state、t、audio…）或 null
curl -s -H "Authorization: Bearer $T" -X POST $B/dance/stop                        # 停止
```

返回与错误码见 §3.8（`409 not-vrm` 带中文 `message` 与 `kind`，`404 no-dance`，`502 load-failed`，`409 vrm-not-ready`，`400 bad-id / bad-name / bad-loop`）。非 VRM 外观时的回复（本任务 e2e 实测）：

```json
{"ok":false,"error":"not-vrm","message":"舞蹈只有 VRM 外观可以跳。她现在是像素外观，换成 VRM 模型再来吧。","kind":"sprites"}
```

### 9.4 素材授权注意事项

- **第三方舞蹈不入库、不打包、不分发**：MMD 动作（VMD）与舞曲通常要求署名、禁止再分发，部分音乐有版权。它们只放在你自己电脑的用户目录（`~/vrm-assets/dances/`、`<数据目录>/vrm-dances/`），不提交到 git、不进安装包、不随角色包导出或分享（设置页和确认页都写明「只保存在这台电脑上」）。
- 导入时原包的 `readme.txt` 原样保存，并提取「Motion by …」/「动作作者：…」作为署名显示在卡片上；使用前请自行阅读原作者的使用规约（是否允许直播 / 录屏 / 商用等）。
- 仓库里唯一的舞蹈是自制的「节拍摇摆」（`src/core/dance-demo.js`，代码生成，无音频文件）和 e2e 夹具（`scripts/make-test-dance.js`，运行时写到临时目录）。
- 守卫：`.gitignore` 忽略 `*.vmd *.VMD *.vrma *.ncm vrm-dances/ baked-dances/`；`package.json` `build.files` 排除 `**/*.vmd`、`**/*.VMD`、`**/*.vrma`、`**/*.ncm`、`**/vrm-dances/**`、`**/baked-dances/**`；`npm test`（`test/vrm-library.test.js`、`test/vrm-dances.test.js`）检查 git 里没有这些文件；`node scripts/check-dance-packaging.js` 用真实的 `electron-builder --linux dir` 打包，在 `src/` 下预先放入诱饵舞蹈素材，确认 `app.asar` 里没有任何 `.vmd / .vrma / .ncm`、舞蹈库目录，以及 `src/voicepacks/` 以外的音频（§9.6）。

### 9.5 验证

```bash
npm test                                        # 单测（含 VMD 解析 / 重定向 / 导演舞蹈层 / 舞蹈库 / 导入 / 守卫）
unset ELECTRON_RUN_AS_NODE                      # 设了它 Electron 起不来
xvfb-run -a node e2e/run.js dance               # 端到端：导入失败 + 成功 → VRM → 列出 → 播放 → 拖拽 / 点击打断 → idle → 再播并停止 → 非 VRM 拒绝
xvfb-run -a node e2e/run.js vrmdance            # 运行时细节：淡入权重、音频同步、重定向角度、限位取景、静音音量、说话压低、隐藏、循环、API
xvfb-run -a node e2e/run.js danceui             # 界面：工具栏浮层、设置页、导入确认、删除
xvfb-run -a node e2e/run.js dancefinal         # 收尾验收（T-2805）：自然播完 / 手动停止后骨骼无残留（对比跳舞前待机）、浮层切换舞蹈、停舞后触摸 / 拖起 / 说话照常、聊天「跳个舞」/「别跳了」、12 次开始 / 停止无报错无资源增长
node scripts/check-dance-packaging.js           # 打包守卫（真实 electron-builder --linux dir，约 10 s）；--no-guard 为反证（应失败）
```

`dance` 场景不消耗 token、不依赖 live：模型、舞蹈、音乐、封面都在测试临时目录里生成，登录走 fake lh。证据输出到 `out/e2e/vrm/`：`dance-*.png`（每步截图）、`dance-frames/f000.png…`（播放中每约 0.2 s 一帧）、`dance-frames.gif`、`dance-contact.png`（帧序列拼图）、`dance.webm`（全程录屏）、`dance-evidence.json`（章节时间点、每步实测值、播放采样）。

### 9.6 打包守卫实测（T-2803）

`scripts/check-dance-packaging.js` 在 `src/renderer/vrm-dances/…`、`src/core/baked-dances/…` 与 `src/` 根放 11 个诱饵（`dance.vrma`、`audio.mp3`、`audio.wav`、`cover.png`、`library.json`、`Motion.vmd`、`.VMD`、`.ncm`、`.vrma`），跑 `electron-builder --linux dir --x64`（与 `dist:*` 同一份 `build.files`），列出 `app.asar` 与 `app.asar.unpacked`，断言：诱饵 0、`.vmd/.vrma/.ncm` 0、`vrm-dances/ baked-dances/` 路径 0、`src/voicepacks/` 以外的音频 0；同时确认舞蹈代码、内置示例 `src/core/dance-demo.js` 和一个同时放入的对照文件 `src/assets-decoy-control.txt` 在包里（证明诱饵确实在打包范围内）。结束后删除诱饵。

`--no-guard` 是反证：用一份去掉所有 `!` 排除规则的配置文件（`--config`；注意 `-c.files=…` 只会追加到 `package.json` 的列表、排除规则仍生效，不能用来做反证）重新打包，检查必须失败。T-2803 实测：

| 运行 | 包内文件 | 诱饵 | `.vmd/.vrma/.ncm` | 舞蹈库路径 | voicepacks 以外的音频 | 结果 |
|---|---|---|---|---|---|---|
| `node scripts/check-dance-packaging.js` | 1636 | 0 | 0 | 0 | 0 | PASS（exit 0） |
| `node scripts/check-dance-packaging.js --no-guard` | 1652 | 13 | 7 | 12 | 3 | FAIL（exit 1） |

## 10. 关键改动清单（文件 → 作用）

| 文件 | 作用 | 任务 |
|---|---|---|
| `src/core/vmd.js` | VMD 二进制读写（Shift-JIS 骨名 / 表情 / IK 开关 / 镜头），贝塞尔插值、重采样、镜头 / 道具判据 | T-2799 |
| `src/core/vmd-retarget.js` | VMD → VRM 人形重定向：骨骼映射（含英文骨名）、A-pose 补偿、捩骨合并、两骨腿 IK、hips 漂移软限幅、表情映射、`bakeVmd` | T-2799 |
| `src/core/vrma-write.js` | 写 `.vrma`（glTF + VRMC_vrm_animation）与 `inspectVrmaJson` 校验（从 bake-core 抽出） | T-2799 |
| `scripts/vrm-bake.js` `--dance`、`scripts/lib/vrm-bake-core.js` | 开发机批量烘焙舞蹈到 `~/vrm-assets/baked-dances`，原子写 `library.json`，拒绝写入仓库 | T-2799 / T-2800 |
| `scripts/vrm-dance-frames.js` | 真实模型上按时间点出静帧拼图 + 姿态数值，供人工评审 | T-2799 |
| `src/core/vrm-dances.js` | 舞蹈索引清洗 `cleanDanceIndex`、列表 / 查找 / 随机、`cannotDance`（非 VRM 原因文案）、导入识别 `detectDance` | T-2800 / T-2801 |
| `src/core/dance-demo.js` | 内置原创示例「节拍摇摆」的关键帧与合成节拍 WAV | T-2800 |
| `src/core/vrm-director.js` | 舞蹈层 D 状态机（cueing / in / on / paused / out），独占全身、拎起暂停 / 超时停止、触摸只出表情、说话 / 录音压低 | T-2800 |
| `src/core/vrm-intent.js` | 快照 → `holds.dance` / `holds.recording`、`dance:start|stop` 事件 | T-2800 |
| `src/renderer/vrm-anim.js` | 外部时钟 `setBase(…, { clock: 'external' })`、`seekBase`、循环 A/B 接缝 | T-2800 |
| `src/renderer/vrm.js` | 舞蹈片段加载 / 释放、舞蹈相机、固定地面、调试字段 `data-dance-*`、`director.dance.seek/speed`、`pose()` / `framePoints()` | T-2800 |
| `src/renderer/vrm-dance.js` | 渲染端控制器：`<audio>` 主钟、音量 / 静音 / 压低、暂停 / 续跳、循环、停止原因统计 | T-2800 |
| `src/renderer/app.js`、`index.html`、`style.css` | 接入快照；工具栏 ♪ 与浮层（列表、正在跳、循环、停止、键盘）；Esc / 喂食 / 玩耍 / 睡觉 / `/anim` 先停舞；跳舞时不漫游 | T-2800 / T-2801 |
| `src/main/vrm-dances.js`、`src/main/vrm-library.js` | 舞蹈目录优先级（env / userData / dev）、`vrmlib://dance/…` 白名单与 Range、列表 | T-2800 |
| `src/main/dance-import.js`、`dance-bake.js`、`dance-bake-worker.js` | 导入：选择 → 识别 → 草稿 → worker 烘焙 → 临时目录 rename 入库；换音乐 / 封面、取消、删除；失败文案 | T-2801 |
| `src/main/main.js`、`preload.js`、`admin-preload.js` | IPC `dances:list` / `dance:play|stop|state|loop`、导入系列；`window.pet.dance.*`、`window.petAdmin.dance*` | T-2800 / T-2801 |
| `src/core/api.js` | `GET /dances`、`POST /dance`、`POST /dance/stop`、`/state.dance` | T-2800 |
| `src/core/settings.js`、`settings-schema.js`、`admin-coverage.js` | `prefs.danceVolume`；设置项归到「舞蹈」页；后台覆盖矩阵 | T-2800 / T-2801 |
| `admin/src/console/pages/Dances.tsx`、`api.ts`、`Hub.tsx`、`ConsoleApp.tsx`、`icons.ts` | 设置窗口「舞蹈」页：非 VRM 说明、正在跳卡、卡片网格、导入确认弹窗、删除确认、音量 | T-2801 |
| `.gitignore`、`package.json` `build.files` | 舞蹈素材不进 git / 安装包 | T-2799 / T-2800 |
| `scripts/check-dance-packaging.js` | 真实打包 + 诱饵素材的打包守卫 | T-2803 |
| `src/core/dance-intent.js`、`src/renderer/app.js` `chatDanceIntent` | 聊天里说「跳个舞」/「别跳了」的本地识别与接线；非 VRM 时的本地台词 | T-2805 |
| `scripts/make-test-dance.js` | e2e 夹具：自制 VMD（已知关键帧）、6 s 提示音 WAV、PNG 封面、`library.json` | T-2800 |
| `e2e/vrm.js` `danceE2e` / `vrmDance` / `danceUi` / `danceFinal`，`e2e/run.js` | e2e 场景 `dance`（端到端）、`vrmdance`（运行时）、`danceui`（界面）、`dancefinal`（收尾验收） | T-2800 / T-2801 / T-2803 / T-2805 |
| `test/vmd.test.js`、`vmd-retarget.test.js`、`vrm-dances.test.js`、`vrm-director-dance.test.js`、`dance-import.test.js`、`dance-intent.test.js` | 单测 | T-2799–T-2805 |
| `docs/vrm-dance.md`、`docs/usage.md`「跳舞」、`README.md` | 设计、接口、使用方式 | T-2798–T-2803 |
| `scripts/build-store-assets.js`、`render-store-thumbs.js`、`upload-store-assets.js` | 商店上架：烘焙 / 打包舞蹈与 VRM、缩略图、上传 CDN 并回下载校验（§11） | 商店 |
| `src/core/dance-catalog.json`、`vrm-catalog.json`、`src/renderer/catalog/{dances,vrm}/` | 商店索引与卡片图（素材本身不进仓库） | 商店 |
| `src/core/catalog.js` | `storeIndex`（角色 + VRM）、`loadDanceIndex` / `danceEntry` / `listDances`、按 release 的下载地址、`parts` | 商店 |
| `src/main/catalog.js` | 下载器可换 `lookup` / `isInstalled` / `install`，分段顺序下载后整体校验 | 商店 |
| `src/main/dance-import.js` `installStore` / `installedIds`、`main.js`、`admin-preload.js` | 商店舞蹈入库、IPC `dance-store` / `dance-download` / `dance-download-cancel` | 商店 |
| `admin/src/console/pages/Store.tsx`、`Characters.tsx`、`stage/VrmLicense.tsx` | 商店「舞蹈」分类、按类型筛选、VRM 卡「授权」弹窗 | 商店 |
| `test/store-assets.test.js`、`e2e/run.js` `storeScenario` | 单测与 e2e `store` | 商店 |
| `src/core/generic.js`、`species.js` `registerGeneric` / `ensureGeneric`、`packs.js` `loadPacks`、`characters.js` | 通用设定：每个通用 VRM 一位独立伙伴；模型不在时存档保留（§12） | 通用设定 |
| `src/main/packs.js` `setBase`、`main.js` `import-vrm` / `set-pack-base`、`admin/…/Characters.tsx` 导入确认「设定」 | 导入 VRM 默认通用，可改成某位角色的新形象 | 通用设定 |
| `test/generic.test.js` | 单测 | 通用设定 |

---

## 11. 商店上架：舞蹈与 VRM 模型

> 范围：把 `~/vrm-assets/dances/`（21 支舞，含 5 个 vidol 舞蹈包）和 `~/vrm-assets/models/`（73 个不同的 VRM 模型）放进设置窗口的「商店」，用户下载后就能用。

### 11.1 上架范围（负责人决定，2026-11-03）

- **舞蹈**：21 支全部上架，**带音乐**。负责人看过各 readme 的条款后决定全部上架：其中多支写明「禁止再分发」（NatsumiSan ×7、ureshiiiiii、Nikisa San），书记舞禁止原样二次配布，几乎所有歌曲都是商业音乐。每张卡写出动作作者（§11.3 `CREDITS`），压缩包里带原 readme。
- **VRM 模型**：73 个全部上架，带授权信息。授权从模型文件读取（`core/vrm.js`），商店卡片显示授权摘要，「授权」弹窗列出完整的 `licenseRows`。只有 6 个模型声明允许再分发；大多数 VRoid Hub 模型的授权是「Other」，按应用的规则判为不允许再分发，卡片如实显示。2 个 R18 模型（`R18-魅魔/`、`muma.vrm`）标为 18+，只在打开成人向内容后列出。
- 所有素材、压缩包和音乐都不进仓库。仓库里只放索引和卡片缩略图（`src/core/dance-catalog.json`、`src/core/vrm-catalog.json`、`src/renderer/catalog/{dances,vrm}/`）。

### 11.2 数据与下载

| 内容 | 索引 | CDN 前缀（`dc/ops-assets/archives/pixel-pet/…`） | 压缩包内容 | 装到 |
|---|---|---|---|---|
| 舞蹈 | `src/core/dance-catalog.json`（release `dances-v1`，id 以 `dance-` 开头） | `dances-v1/` | `dance.json`（库条目字段）、`dance.vrma`、`audio.mp3`、`cover.jpg`、`readme.txt` | `<userData>/vrm-dances/<id>/`，`library.json` 记 `source: "store"` 与 sha256 |
| VRM 角色 | `src/core/vrm-catalog.json`（release `vrm-v2`；与角色索引合并，见 `core/catalog.js` `storeIndex`） | `vrm-v2/` | VRM 角色包（`pack.json`、`models/*.vrm`、`preview.png`），由导入 VRM 的同一流程生成，`species: "generic"`（§12）；索引里的 `base` 是她自己的通用基础角色 id | `<userData>/packs/<id>/`（与其他下载角色相同） |

- 下载沿用 `src/main/catalog.js` 的 `CatalogDownloader`：校验大小和 sha256，失败时丢弃。舞蹈用同一个下载器，换掉 `lookup` / `isInstalled` / `install` 三个函数。进度走同一个 `catalog-progress` 事件。
- **分段**：Develop Center 单个文件最大 20 MB。超过的压缩包按 19 MB 切成 `<id>-p1.zip`、`<id>-p2.zip`…，索引里记在 `parts`。下载时按顺序拼接，最后整体校验 sha256。分段大小之和必须等于 `bytes`，否则这个 `parts` 不被采用。
- IPC：`dance-store`（列表、是否已下载、是否 VRM）、`dance-download`、`dance-download-cancel`；删除复用 `dance-remove`。

### 11.3 构建与上传

```bash
node scripts/build-store-assets.js            # 烘焙 21 支舞 + 打包 73 个 VRM → ~/vrm-assets/store/{dances,vrm}/，写两个索引和缩略图
xvfb-run -a node scripts/render-store-thumbs.js   # 模型没有缩略图时，用应用自带的运行时渲染站姿卡片图
DC_CLI=…/develop-center/packages/cli/dist/index.js DC_TOKEN=… DC_BASE_URL=… node scripts/upload-store-assets.js
```

- 舞蹈用和「导入舞蹈」相同的识别（`dance-import.inspect` → `detectDance`）和烘焙（`bakeVmd`）。wav 转成 192 kbps mp3，`.ncm` 跳过。AOA 的 5 段动作合并成一支（`MERGE`），没有 `meta.json` 的包用 `NAMES` 里的名字。
- 输出目录不能在仓库里。压缩包可复现：文件按名排序，时间戳固定。上传时 `--skip-existing`，内容变了要换 release。
- 上传脚本会从应用实际使用的地址把每个条目下载回来，分段的按顺序拼接，再和索引比对。2026-11-03 首次上传：舞蹈 21/21、VRM 73/73（76 个文件）全部一致。

### 11.4 验证

- 单测 `test/store-assets.test.js`：两个索引合并、各自的 release、地址、`parts` 校验、18+ 过滤、商店卡片带授权行；商店舞蹈入库、`installedIds`、删除后可以再下载。
- e2e `xvfb-run -a node e2e/run.js store`：
  - 商店里有「舞蹈」分类，21 张卡。
  - 像素角色时可以下载，但「让她跳」不可点。
  - VRM 筛选出 71 张全年龄卡片；「授权」弹窗内容正确。
  - 分段包里一段坏了会被 sha256 拒绝；正常下载后能穿上。
  - 在商店点「让她跳」，舞蹈带音乐播放，停止后回到待机。
- 加 `STORE_CDN=1` 就直接从真实 CDN 下载。

## 12. 通用设定：VRM 模型不挂在某位模型娘名下

> 负责人决定（2026-11-03）：VRM 角色用一套「通用」设定，不挂在大肥鱼等模型娘名下。每个模型是一位独立伙伴，好感、名字、聊天记录和 LobeHub 助手各自一份。商店下载的和自己导入的 VRM 默认都用通用设定。新用户的「选择你的模型娘」里没有它，下载或导入 VRM 后才出现。

- **做法**（`src/core/generic.js`）：`pack.json` 里 `species: "generic"`（仅限 `kind: vrm`）。加载角色包时（`core/packs.js` `loadPacks`），每个这样的包都按模板生成一个专属基础角色，并注册进 `SPECIES`（`species.registerGeneric`）：
  - id 为 `vrmx` 加 12 个字母，由包 id 的 sha1 推出。只用字母是为了满足设置里 `models.<base>` / `systemRoles.<base>` 的键名规则。同一个模型重新下载回来，得到的还是同一个 id。
  - 名字和标题取模型名，厂商一栏写「通用」。人设是中性的成年伙伴，用模型自己的名字，不冒充模型原作里的角色。台词是通用的一套，主题色由 id 推出。
  - 现有「按基础角色保存」的数据结构（`pet.characters[base]`、聊天记录、助手、设置）因此不用改，每个模型天然各有一份。
- **模型不在了**：存档里的通用伙伴不会被「退役」或并到别的角色（`resolveSpeciesId` → `ensureGeneric` 注册一个幽灵基础角色）。如果是商店里的模型，名字从商店索引里取，「需要下载」可以把她找回来；角色图鉴不为她显示空卡。她在桌面上陪你时，不能删除她的模型（`catalog-remove` / `remove-pack` 会拒绝，提示先切换到别的角色）。
- **导入 VRM**：设置窗口的「导入 VRM 角色…」默认用通用设定（`import-vrm {species: "generic"}`）。导入确认里可以改成「「大肥鱼」的新形象」等（`set-pack-base`），那样就和那位角色共用人设与好感，像换衣服一样。桌宠窗口的旧接口 `window.pet.importVrm(base)` 仍按传入的角色导入。
- **桌宠窗口**：基础角色的列表变化时（下载或删除了通用 VRM），主进程在下一次 `update` 里附上新的 `speciesList`，渲染进程据此更新。
- **验证**：单测 `test/generic.test.js`（id 规则、两个模型两位伙伴、人设用模型名、不挂在大肥鱼名下、模型删除后存档保留、商店索引的 `base`）；e2e `store` S4（下载后她的基础角色是 `vrmx…`、厂商「通用」、名字是模型名）。

## 附录 A：核对清单（本设计引用的现状）

| 引用 | 现状（本分支 ec46849） |
|---|---|
| 运行时只认 `.vrma`、vendor 有 `VRMAnimationLoaderPlugin` / `createVRMAnimationClip` | 动作文档 §3.7；`src/renderer/vendor/vrm/three-vrm.min.js` |
| `retargetQ`、`writeVrma`、`readVrma`、`trimClip`、`loopClip` 等 | `scripts/lib/vrm-bake-core.js` |
| FBX 烘焙需临时安装 three | `scripts/vrm-bake.js` `threeDir()` |
| `vrmlib://` 只服务 `female|male|neutral` 与 `index/library.json`，拒绝仓库内目录 | `src/main/vrm-library.js` `resolveUrl` / `libraryDir` |
| 基础层交叉淡化权重和恒为 1、叠加层按骨骼 slerp | `src/renderer/vrm-anim.js` `setBase` / `update` / `applyOverlays` |
| 现有调试字段、`PetVRM.debug()`、`director.inject` | `src/renderer/vrm.js` 头注释、`window.PetVRM` |
| 右键 / 长按打开设置，无窗口菜单 | `src/renderer/app.js` `bindPetPointer({ onMenu })`、`contextmenu` 监听 |
| 工具栏：喂食 / 玩耍 / 睡觉 / 聊天 / 静音 / 设置 | `src/renderer/index.html` `#toolbar` |
| 桌宠窗口 230×340 | `src/main/main.js` `SIZES.pet` |
| 设置窗口 rail 4 个入口、「和她一起」组 | `src/core/settings-schema.js` `RAIL` / `NAV` |
| 本地 API 前缀 `/pixel-pet`、`/anim` | `src/core/api.js` `PREFIX` / `ROUTES` |
| 守卫：`.gitignore` 含 `*.vmd *.VMD *.vrma`，`build.files` 含 `!**/*.vmd` 但缺 `!**/*.VMD` | `.gitignore`、`package.json`、`test/vrm-library.test.js` |
| 素材：5 个 `vidol-dance-*` 包结构 `meta.json{name,type,src,audio}` + vmd + 音频 + `cover.jpg`/`thumb.jpg` + `readme.txt` + `package.json` | `~/vrm-assets/dances/vidol-dance-*`（§2.2 扫描） |
