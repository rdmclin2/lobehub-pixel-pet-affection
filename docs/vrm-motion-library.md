# VRM 动作素材库 v2：索引、骨骼映射与批量烘焙（T-5081）

素材仅限个人使用：仓库里只有**元数据**（`src/core/vrm-motion-index.json`）和脚本；任何 `.vrm/.vrma/.fbx/.vmd/.pmx`、音频都只在仓库外（`~/vrm-assets/…`、`<userData>/…`），`.gitignore`、`package.json build.files` 的排除项和脚本里的 `insideRepo` 守卫都保持不变，`test/vrm-motion-index.test.js` 会检查 `git ls-files` 中没有这些文件。

## 1. 一条命令

```bash
# 0) 只在素材更新后需要：扫描五个包，得到每个片段的运动特征（~60 s，写到 ~/vrm-assets/_scan/）
node scripts/vrm-motion-scan.js
# 1) 重建索引（确定性，可用 --check 校验仓库里的是否最新）
node scripts/vrm-motion-select.js
# 2) 烘焙全部片段 + 舞蹈到 ~/vrm-assets/baked-v2（~26 s），并安装到 <userData>/vrm-motions、<userData>/vrm-dances
node scripts/vrm-bake.js --v2 --install            # 打包版直接可用
# 或者不安装，开发时指向它：
PIXELPET_VRM_MOTIONS_DIR=~/vrm-assets/baked-v2 PIXELPET_VRM_DANCES_DIR=~/vrm-assets/baked-v2/dances npm start
```

**五个输入包**：烘焙开头打印 `inputs`，逐个列出 `~/vrm-assets/{postures,mixamo,motions,dances,models}` 的文件数和被索引引用的数量。前三个包烘成动作片段，`dances` 烘成舞蹈库。`models` 包在烘焙后由 `scripts/lib/vrm-model-probe.js` 逐个读取：只解析 .vrm 的 glTF JSON 块，不写出任何模型数据，得到 VRM 版本（0.x/1.0，0.x 的拇指改为 1.0 命名）、humanoid 骨骼、静止姿势下的髋高和头高。然后套用渲染端同一套规则（`vrm-bone-map.js` 的 `degradeLevel`、`rootHips`、`allowsClip`），把每个模型能播哪些片段写进 `library.json` 的 `models` 段，并在日志里列出降级的模型。本次 75 个模型的结果：full 22、folded 53（缺 upperChest）、unusable 0、hips 在地面 4（只播站姿，88/89/88 个片段）。

`--install` 默认装到 Electron 的 userData（`~/.config/Pixel Pet Affection`、`~/Library/Application Support/Pixel Pet Affection`、`%APPDATA%\Pixel Pet Affection`；设了 `PIXELPET_DATA_DIR` 就用它），也可以用 `--user-data <dir>` 指定。打包版 `src/main/vrm-library.js libraryDir()` 在 `<userData>/vrm-motions/library.json` 存在时直接用它（`source: userData`），舞蹈同理（`src/main/vrm-dances.js danceDir()`）。

## 2. 索引结构（`src/core/vrm-motion-index.json`，schema 2）

- `clips["<slot>@<style>"]`：`kind`（posture/idle/hold/reaction）、`category`（posture/idle/reaction/emotion/talk/walk）、`group`（stand/sit/crouch/lay、idle、greet/bow/nod/shake/think/stretch/yawn/clap/point/look/jump/fidget/hold、happy/angry/sad/surprised/shy/excited、talk、walk/run/turn）、`style`、`pack`、`src`（包内相对路径）、`label`、`duration`、`loop`、`mask`（可混合骨骼掩码 full/upper/arms/head）、`enter`/`exit`（起止姿势 stand/sit/crouch/lay）、`srcStyle`（来源本身的性别标签或 unlabelled）、`by`（base/label/rule/review）、`score`，以及烘焙参数（`trim`、`detrend`、`faceFront`、`fadeIn/fadeOut`…）。
- `duration` 是**实际播放时长**（已扣除 `trim`；姿势和单帧 hold 烘成 1 s 保持帧，记为 1），与烘焙出的 `library.json` 一致；源文件长度另存为 `srcDuration`。
- 一次性的反应/情绪片段最长播放 6 s（`REACT_MAX`）：规则选出、源长超过 6 s 且没有人工 `trim` 的片段，自动截取以动作能量峰值为中心的 6 s 窗口（`trim` + `autoTrim: true`），例如 23.6 s 的 `react.nod-01` → `trim [0, 6]`。单测 `the index: a one-shot reaction / emotion plays at most 6 s…` 检查这两条。
- `dances[id]`：舞蹈（Mixamo 舞蹈 12 支 + dances 包 21 个文件夹各一支），带 `styles`。烘进舞蹈库，走现有的舞蹈播放（`vrmlib://dance/…`）。
- 槽位命名：导演已在用的槽位（`stand.relaxed`、`react.touch-head`、`hold.talk`…，来自 `src/core/vrm-library.json`）原样保留；新增的按组编号：`idle.v03`、`react.nod-02`、`emote.shy-01`、`hold.talk-g04`、`hold.walk-02`、`crouch.v01`。所有 `idle.*` 立即进入导演的 idle 轮换。

## 3. 筛选

1. `scripts/vrm-motion-scan.js`：用烘焙同一套读取器（Mixamo FBX → `fbxToClip`，VMD → `vmd-retarget.retargetVmd`）把 2 301 个源片段转成 VRM 空间，`scripts/lib/vrm-motion-features.js` 做前向运动学，算出时长、髋部位移/速度/高度、躯干倾角、头部俯仰/偏航摆动次数、手离脸/头顶/彼此的距离、挥手摆动、步幅、各肢体角速度、首尾接缝角、起止姿势等。
2. `scripts/lib/vrm-motion-rules.js`：优先级为人工 review > lobe-vidol 标签 / postures 包文件名（`Male Laying Pose (3).fbx`）> 特征规则。排除战斗、武器、摔倒、成人向与辅助数据；motions 包只用 `REVIEW` 里逐个点名的 VMD。
3. `scripts/vrm-motion-select.js`：每个风格每组按配额取（姿势每组 3–5，idle 8，说话 6，其他 3），同性别来源优先、再按分数排；idle 必须起止都是站姿。

## 4. 风格与回退

- 来源风格：标 Female 的服务 female + neutral；标 Male 的服务 male；无标签的三种都服务。基础清单里的 female 片段复制一份作为 neutral。
- 回退顺序（`src/core/vrm-library.js STYLE_FALLBACK`，与索引里的 `styleFallback` 一致）：female → neutral → male；male → neutral → female；neutral → female → male。`loadSets()` 只加载本风格；库里没有本风格时才按顺序借用。因此任何商店 VRM（风格判定为任何一种）都能命中片段。

## 5. 骨骼映射与降级（`src/core/vrm-bone-map.js`）

- Mixamo → VRM：`MIXAMO_TO_VRM`（烘焙核心 `scripts/lib/vrm-bake-core.js` 也从这里取），把关键帧从 Mixamo 骨骼的静止坐标系换到 VRM 归一化骨骼：`q_vrm = Q_parentWorldRest · q · Q_worldRest⁻¹`。手指 15×2 全映射。
- MMD → VRM：`MMD_TO_VRM` 与 `vmd-retarget.js BONE_ROLE` 一致（测试对齐）：捩骨并入上臂/前臂，根链并入 hips，足 IK 解算到腿，A-pose 手臂转 T-pose。
- VRM 0.x / 1.0：烘出的 .vrma 是 1.0 坐标（+Z 朝前）；three-vrm `createVRMAnimationClip` 对 0.x 模型翻转 x/z，并做拇指改名（`VRM0_THUMB` 有记录）。
- 比例：全部是旋转，臂长/腿长不影响；髋部位移由 three-vrm 按“模型髋高 / 片段髋高”缩放，矮模型步子也短。
- **缺骨降级（新增）**：three-vrm 会直接丢掉模型没有的骨骼轨道，这样转动也跟着丢失。`foldMissing()` 在生成 clip 之前把缺失骨骼的旋转左乘进它仍存在的子骨骼（世界旋转保持不变：`P·m·c = P·(m·c)`），叶子（脚趾、指尖）直接丢弃。渲染端 `src/renderer/vrm.js loadVrma()` 对每个片段都会做这一步，结果记录在 `debug().boneFold`。
- **根骨当 hips 的模型（新增）**：部分 MMD 转换模型的 humanoid hips 在地面（Wanderer：hips y=0，头 1.39 m）。站姿片段可以正常播；坐、蹲、躺姿势会绕脚踝翻倒，所以 `allowsClip()` 让这类模型只加载站姿片段（`boneFold.rootHips`）。
- 面朝用户（新增 `faceFrontClip`）：很多 Mixamo 说话/手势片段是侧身 60–90° 录的，烘焙时把髋部平均朝向转回 +Z。

## 6. 烘焙输出（`~/vrm-assets/baked-v2`）

```
library.json              运行时索引（cleanIndex 能读），counts 字段给出每风格每类别的数量
female/ male/ neutral/    <slot>.vrma（每风格约 8 MB）
dances/library.json       舞蹈库（cleanDanceIndex 能读），dances/<id>/dance.vrma (+ audio/cover/readme，仅本机)
```

循环片段（idle/talk/walk）烘焙后会检查首尾接缝角，超过 `LOOP_SEAM_MAX = 2°` 就算失败（返回码 1）。单测会在本机有库时重新读每个 .vrma 复查。

## 7. 验证

- `npm test`：`test/vrm-motion-index.test.js` 覆盖映射表（Mixamo 全骨骼、MMD 与重定向一致、0.x 拇指）、缺骨折叠（世界旋转误差 < 0.01°）、降级判定、索引 schema、每风格每类别数量与必备组、运行时回退、筛选规则（合成特征）、循环接缝、索引可复现、git/打包守卫、安装路径。
- 多模型截图对照：`xvfb-run -a electron --no-sandbox scripts/vrm-motion-compare.js --lib ~/vrm-assets/baked-v2 --out <dir> --models a.vrm,b.vrm --styles female,male --clips idle.v01,react.nod-01`。同时输出逐帧数值检查：脚是否低于地面、手是否进入躯干、膝盖角度。
- 审阅用火柴人拼图：`scripts/vrm-motion-sheet.js`（读取 scan 的 tracks.json）。
