# 半身模式（取景：全身 / 半身）

> VRM、Live2D 和像素（sprites）三类角色共用同一个取景设置（见“设置”），在同一设置下表现一致：腰部以上、头在上方、水平居中、窗口不变。

桌宠默认从头到脚显示（**全身**）。**半身**只显示腰部以上：同一个窗口里角色画得更大，头部和上半身居中，腰部正好落在窗口底边。适合把桌宠放在屏幕角落里聊天、看口型和表情。

## 参考 Airi

读的是 [moeru-ai/airi](https://github.com/moeru-ai/airi)（2026-11-02 的 `main`，提交 `33b12e9`）。VRM 场景在 `packages/stage-ui-three`，Live2D 场景在 `packages/stage-ui-live2d`，两者共用的控制条在 `packages/stage-ui/src/components/scenes/ViewControlSlider.vue`。

**Airi 怎么算 VRM 的相机**（`stage-ui-three/src/components/Model/VRMModel.vue` → `buildSceneBootstrap`）：

- 先算**整个模型的包围盒**（`computeBoundingBox`：遍历可见 mesh，跳过 `VRMC_springBone_collider`），得到 `modelSize`、`modelCenter`。
- 把中心抬高 `modelSize.y / 5`，相机放在 `modelCenter + (size.x/16, size.y/8, −(size.y/3)/tan(fov/2))`，也就是让画面竖向大约装下模型高度的 2/3、偏上，默认 FOV 40°（`stores/camera.ts`）。效果是一个“膝盖以上”的固定构图。
- 人形骨骼只用到 **head**：`getEyePosition` 取 head 骨骼的世界高度作为 `eyeHeight`（视线默认目标）；`headAnchor()` 按“头约占身高 1/14”在 head 骨骼上方放一个锚点给气泡用。neck / chest / hips **没有**参与取景。
- **用户调整**：`stores/view-control.ts` 提供 `x / y / z`（模型偏移，±10 m）、`cameraDistance`（0–10 m）、`cameraFOV`（10–120°）五个滑杆，存在 `localStorage`；桌面版还开了 OrbitControls（拖动旋转 / 滚轮缩放，目标是模型中心）。切换模型时（`ThreeScene.vue`）保留用户调过的相机方向和距离，只把原点换到新模型的中心。
- **Live2D**（`stage-ui-live2d/src/composables/live2d/fit-model.ts` → `useFitModel`，`components/scenes/live2d/Model.vue` → `setScaleAndPosition`）：模型加载后记下 `initialModelWidth/Height`，锚点设在模型中心（`anchor.set(0.5, 0.5)`）；`scale = min(画布高 / 模型高, 画布宽 / 模型宽) × 2`，也就是**整个模型画布放大到窗口的两倍**，位置 `x = 画布宽 / 2`、`y = 画布高 × startingOffsetY`（桌面版和宽屏网页为 1，窄屏网页 0.75）——模型中心落在窗口底边，于是只看得到“模型画布的上半部分”，这就是 Airi 的默认半身。画布尺寸变化时重新算（可选 200 ms 补间），再叠加用户的 `position.x / y`（相对画面中心的百分比）和 `scale`（`stores/view-control.ts`，存 `localStorage`）。视线用 `model.focus(x, y)` 跟着鼠标。

**我们采纳的**

- 相机距离按竖直视野反推：`dist = visible / 2 / tan(fov/2)`，只改相机、不缩放模型，所以 SpringBone、视线、口型都不受影响。
- 用 head 骨骼定位头部；把骨骼当作稳定的比例参考（Airi 用它放视线和气泡锚点，我们也用它定头顶和腰线）。
- 切换模型 / 模式时不重建场景，只移动相机（Airi 换模型保留相机方向；我们切取景时相机在 0.35 s 内平滑过去）。
- Live2D 同样是“缩放 + 位置偏移、按画布尺寸重新适配”：每次 `fit()` 按当前画布尺寸重新算缩放和偏移，模型本身不动；切换取景时缩放和偏移在 0.35 s 内平滑过去。
- Live2D 视线跟随鼠标（Airi 的 `focus`）：我们从**她眼睛此刻在窗口里的位置**算方向，所以半身下（眼睛更低、更大）照样对准鼠标。

**不采纳的**

- **不用整模包围盒定构图**：桌宠模型常有长发、尾巴、裙摆、举起的手（VRM 0.x 在 canary 上还会举着手，见“已知问题”），包围盒一变构图就跳。我们的半身取景只看骨骼：头顶取“跟着 head 骨骼及其子骨骼动的顶点”的最高点，腰线 = hips 骨骼上方 12% 躯干长度（躯干 = head − hips），左右以 head–hips 连线居中。
- **不开放 x/y/z/距离/FOV 五个自由滑杆，也不开轨道相机**：桌宠窗口很小、透明、能拖动，自由相机很容易把人“调丢”。我们只给一个二选一（全身 / 半身）加已有的“宠物大小”（`petScale`，窗口右下角不动）。需要特殊构图的模型，由形象包在 `pack.json` 里带默认取景。
- Live2D 不用 Airi 的“模型画布 ×2、中心放在底边”当半身：那是按**模型画布**（`.moc3` 的画布，常带大片透明边，角色也未必站在正中）的一半裁，裁到哪里取决于建模时画布留了多少边：大肥鱼碰巧合适（画布中线 2496 px 在她身高的 52% 处，接近腰），但画布下方留白多的模型会裁到胸口，留白少的会露出大腿。我们量的是**实际画出来的图层**（不透明 drawable 的范围）和腰线（见“Live2D 实现”），并且保留全身作为默认。
- 不把设置放 `localStorage`：取景写进 `settings.json`，设置窗口和桌宠窗口共用、重启保留，并且能按角色覆盖。

## 设置

| 位置 | key | 取值 | 说明 |
| --- | --- | --- | --- |
| 设置窗口 → 玩法 → 桌宠行为 → **大小与取景** → 取景 | `prefs.framing` | `full`（默认）/ `half` | 全局默认。改动立即生效。 |
| 设置窗口 → 角色 → 她的页 → 形象包 → **取景** | `framings.<角色 id>` | 跟随 / `full` / `half` | 只对这一位角色生效；“跟随”= 删除这一项。 |
| 形象包 `pack.json` | `framing` | `full` / `half`（可选） | 这个包的默认取景，例如只有上半身的模型写 `"framing": "half"`。 |
| 形象包 `pack.json` | `halfBody.waist` | 0.2–0.9（可选） | 半身裁到哪里：她身高的比例，头顶 0、脚底 1。VRM 写了就代替骨骼推出的腰线；Live2D 写了就不再推断；像素包写了就按它裁，不写用 55%。 |

优先级：**角色自己的选择 > 形象包默认 > 全局设置**（`src/core/framing.js` → `resolveFraming`）。

- 迁移：旧的 `settings.json` 没有 `prefs.framing`，读成 `full`，看起来和以前一样；非法值也读成 `full`。`framings` 只保留合法角色 id 和 `full`/`half`。
- **VRM**（相机）、**Live2D**（模型缩放 + 偏移）和**像素 sprites**（每帧只画上半部分并放大）形象包会真的换取景；图片 / 全动态（rig）包保持全身（设置窗口里会提示）。`resolveFraming` 的 `SUPPORTED_KINDS = ['vrm', 'live2d', 'sprites']`；主进程把 `resolveFraming(...).supported` 作为 `view.characters[].framingSupported` 发给设置窗口，提示不再写死 kind。
- 写入路径：设置窗口 `admin-set prefs.framing` → `PetService.setPrefs` → `settings.json` → `settings` 广播；按角色是 `set-framing` → `PetService.setFraming`。桌宠窗口收到新设置后调用形象的 `setFraming()`（VRM、Live2D 和像素 sprites 同一个接口），**不重新加载模型 / 图集**。

## VRM 实现

代码：`src/core/framing.js`（纯函数，单测覆盖）+ `src/renderer/vrm.js`（`measure()` / `fit()` / `setFraming()`）+ `src/renderer/app.js`（同步设置、触摸映射）。

1. **测量**（模型加载后、放下手臂的静止姿势里，只做一次）：读 `head / neck / upperChest / chest / spine / hips` 的世界坐标；扫描蒙皮到 head 骨骼及其子骨骼的顶点，得到头部的顶 / 左右范围（头发、耳朵、呆毛都算，手臂和道具不算）。
2. **半身带**（`halfBodyBand`）：顶 = 头部顶点最高处（限制在 head 骨骼上方 0.25–3 倍躯干之间）；底 = hips + 0.12 × 躯干（腰）；水平中心 = head 与 hips 的中点。缺 head 或 hips 骨骼时回退到“包围盒上半部分”（`source: 'box'`）；只有 chest 没有 hips 时用 chest 往下推一个估计的 hips。
3. **相机**（`cameraFor`）：
   - 全身：与改动前完全一样（整模高度 / `vrm.height`，脚踩底边）。
   - 半身：半身带填满画布高度，腰线正好在画布底边，头顶留 5% 空气；如果头部太宽（Q 版大头 / 长发），视野放宽到能放下头宽的 85%，但不会比全身还远。
4. **切换**：`setFraming(mode)` 只换目标相机，`fit()` 用 smoothstep 在 0.35 s 内从当前相机滑到新相机（距离、高度单调变化），期间帧率切到活跃档；模型、动画、SpringBone 都不重建，所以没有 T-pose 闪烁。
5. **窗口**：窗口尺寸和位置不变（右下角锚点保持），半身就是“同一个窗口里画得更大”，`petScale` 照常缩放整个窗口。
6. **交互**：
   - 视线（aim）、口型、待机 / 动作片段、拖拽（lifted）、走动都在模型上做，与相机无关，半身下照常。
   - 触摸区（`src/core/touch-zones.js` 的表是按“头到脚”的图写的）：半身时 VRM 画布上带 `data-framing="half"` 和 `data-cut`（显示了她全身高度的多少），`app.js` 用 `toFullBody` 把点击的 y 乘以 `cut`，映射回全身比例。于是头、脸、胸、手、肚子照常；画面最底部是腰 / 臀，**腿和脚在半身下点不到**。

调试字段：VRM 画布 `data-framing`、`data-cut`、`data-band`（`bones` / `box`）；`window.petFx.vrm()` 里有 `framing`、`band`、`camera`、`gliding`；`window.petFx.framing()` 给出当前取景和来源。

## Live2D 实现

代码：`src/core/framing.js`（`live2dHalfBand` / `live2dPlacement` / `blendPlacement` / `waistFromHead`，纯函数，`test/framing-live2d.test.js`）+ `src/renderer/live2d.js`（`measure()` / `fit()` / `setFraming()` / `aim()`）+ `src/renderer/app.js`（和 VRM 共用的 `syncFraming`、触摸映射）。

1. **测量**（模型加载后、第一次画之前，只做一次）：先写上包里的 `pinned` 值（水印开关等），然后
   - 她画出来的范围 `content`：所有不透明（opacity > 0.1）、可见的图层（drawable）顶点的包围盒，单位是 `.moc3` 画布像素（y 向下）。不用模型画布本身的尺寸——那里常有大片透明边；
   - 头：`.model3.json` 的 `HitAreas` 里名字或 id 含 Head / 頭 / 头 的区域（`getDrawableBounds`）；
   - 眼睛：把 `ParamEyeLOpen`（或 Cubism 2 名字 `PARAM_EYE_L_OPEN`）从当前值改成 0，看哪些图层的顶点动了，它们的范围就是眼睛；量完改回去。每个 Cubism 模型都有这个参数，所以第三方模型也能量到。
2. **半身带**（`live2dHalfBand`）：顶 = `content` 的顶（她的头顶 / 呆毛）；腰线按可信度依次取：
   | 来源 `source` | 怎么来 |
   | --- | --- |
   | `pack` | `pack.json` 的 `halfBody.waist`（身高比例，头顶 0、脚底 1） |
   | `hitarea` | Head 区域底边 → 头占身高的比例 h → 腰线 = `0.285 + 0.86·h`（成人头 ≈ 1/7.5 → 0.40；Q 版头 ≈ 1/3 → 0.57），限制在 0.30–0.75 |
   | `eyes` | 眼睛中线离头顶的距离 × 1.5 ≈ 头高（头发让眼睛在头顶到下巴的 2/3 处）→ 同上公式 |
   | `default` | 身高的 55% |
   水平中心取头（Head 区域或眼睛）的中心，不受尾巴、单侧头发影响；都没有就取 `content` 的中心。
   大肥鱼 Live2D：包里写 `waist: 0.52`；不写时眼睛推断得到 0.522（e2e 里导入的无 `pack.json` 副本就是这样），两者几乎一致。
3. **摆放**（`live2dPlacement`，每次 `fit()` 按当前画布尺寸重新算）：
   - 全身：和改动前完全一样（缩放 = 画布高 × `live2d.height` / 模型高，脚在 99.5% 处，水平居中）。
   - 半身：头顶到腰线这一段 = 画布高的 95%（上方留 5% 空气），腰线正好落在画布底边，头部中心水平居中；缩放不会小于全身。
4. **切换**：`setFraming(mode)` 记下当前摆放，`fit()` 在 0.35 s 内用 smoothstep 把缩放和偏移滑到新值（缩放单调变化）；画布、PixiJS 应用、模型、物理都不重建，所以没有空白帧或重新加载。
5. **窗口**：和 VRM 一样不改窗口尺寸和位置（右下角锚点不动），`petScale` 照常缩放整个窗口；半身就是同一个窗口里画得更大。
6. **交互**：
   - 眨眼、口型（说话时 `ParamMouthOpenY`）、表情开关（脸红 / 脸黑…）、状态动作（跳、点头、挥手、拖起时摇晃）、走路都在模型参数和模型位移上做，摆放只是外面一层缩放和偏移，半身下照常；跳起时露出的是腰下面的部分，不会出现空隙。
   - **视线跟随**：窗口里用 pointer 事件，窗口外每 250 ms 问一次主进程的屏幕光标（和 VRM 共用的 `cursor-point`）。方向 = 光标相对**她眼睛在窗口里的位置**（由测量的眼睛 / 头 + 当前摆放算出），换成头部角度（±18° / ±12°）和眼球（±0.8 / ±0.7）；思考、张望、睡觉时用状态自己的视线。全身、半身都是这一套，所以半身下光标在她眼睛高度时她平视，往上时抬头。
   - **触摸区**：Live2D 画布上也带 `data-framing="half"` 和 `data-cut`（= 腰线比例），`app.js` 的 `artPoint` 和 VRM 一样用 `toFullBody` 把点击的 y 映射回全身比例：头、脸、胸、手、肚子照常，**腿和脚在半身下点不到**。
   - **气泡**：气泡在窗口顶部的布局里、角色画布上方，不跟着模型走；半身时头顶留了 5% 空气，e2e 检查气泡底边在她眼睛上方。
7. **第三方模型的回退**：用户导入的模型没有 `pack.json` 里的 `halfBody`，按 Head 区域 → 眼睛 → 55% 推断；测量本身出错（极少见的模型）时 `shape = null`，半身退回全身摆放（控制台警告一行），不会画坏。

调试字段：Live2D 画布 `data-framing`、`data-cut`、`data-band`（`pack` / `hitarea` / `eyes` / `default`）、`data-gaze`；`window.petFx.live2d()` 给出每个 Live2D 形象的 `framing`、`band`、`content`、`eyes`、`head`、`face`、`placement`、`gliding`、`gaze`、`params`（眼、嘴、头部角度）、`faces`。

## 像素（sprites）实现

代码：`src/core/framing.js`（`spriteRef` / `spriteCanvas` / `spriteHalfCrop` / `spriteDrawRects` / `blendRect`，纯函数，`test/framing-sprites.test.js`）+ `src/renderer/app.js`（`lookEl` 的 sprites 分支挂 `petFigure.setFraming`、`drawSprite` 裁切绘制、`spriteRefOf` 参考框测量）。设计和逐帧测量见 [pixel-half-body-plan.md](pixel-half-body-plan.md)。

1. **为什么能做**：像素包的每一帧都是同一个构图（脚底贴帧底、身高约 80% 帧高、水平居中），所以半身就是**整张图集用同一个裁切框**：`drawImage` 的源矩形从“整格”换成“头顶上方一点到腰线”，目标仍是整个画布。
2. **参考框**（每张图集测一次，换服饰 = 换图集再测）：取 `idle / pat / talk / look / sad / think / happy` 里存在的动作的第 0 帧，读不透明像素（alpha ≥ 128，HD 包按 1/4 分辨率读）的包围盒，取头顶、脚底、水平中心的**中位数**（个别画大了的帧不会带偏）。图集读不回像素时把整帧当作她。
3. **腰线**：

   | `data-band` | 来源 |
   | --- | --- |
   | `pack` | `pack.json` 的 `halfBody.waist`（身高比例，头顶 0、脚底 1，0.2–0.9） |
   | `default` | 身高的 55%（`L2D.dflt`；像素图里没有 HitArea / 眼睛参数可推断） |

   15 个内置像素包都写了实测值：HD 的 `*-pixel` / `*-adult` 为 0.50–0.52（裁在交叠双手下沿以下），`*-classic` 为 0.60–0.72（Q 版头大，腰线更低）。
4. **裁切**（`spriteHalfCrop`）：腰线正好落在画布底边；头顶上方留 **8%**（VRM / Live2D 是 5%：像素帧顶端常有举起的手、道具、气泡，8% 时每包只有 1–5% 的帧顶端出框）；裁切框保持帧的宽高比，所以窗口、布局、右下角锚点都不变；以她的重心水平居中；不会比全身小。源矩形严格裁在本格内（`spriteDrawRects`），不会读到图集里相邻的帧。
5. **清晰度**：
   - 平滑高清包（`pixelated: false`，664×904）：画布保持帧尺寸，平滑采样，约放大 2.2 倍。
   - 硬像素包（`pixelated: true`，classic 83×113）：半身时画布换成帧的整数倍（83×113 × 4 = **332×452**，和 VRM / Live2D 画布相同），裁切高度取“画布高 / 整数”，起点取整，最近邻采样：每个源像素正好是 6×6 或 7×7 个画布像素，没有粗细不一的像素块。切回全身时画布恢复成帧尺寸。
6. **切换**：`setFraming(mode)` 只换裁切框；高清包在 0.35 s 内用 smoothstep 从当前框滑到新框（滑动期间帧循环跑满 rAF），硬像素包直接切换（滑动中的非整数倍最近邻会闪）。图集、canvas 元素、动作计时都保留，**不重建 sprite、不重新加载图集**。
   - **上浮帧跟随**（`spriteLift`，T-2770）：个别帧整张人物画高了（素材漂移，脚底离开帧底；例：dafeiyu-pixel 日常 `idle#1` 整体上浮 94 px，gemini-pixel swimsuit / couple_hoodie 的 `idle#0`、grok-pixel yukata 的 `walk`）。同一个裁切框会把这些帧的头顶切掉，idle 每 0.5 s 闪一次。半身时每帧量一次自己的脚底（四分之一分辨率，按格缓存），比参考脚底高出帧高 2% 以上就把裁切框上移同样距离（最多 20%，硬像素包取整），她在画面里保持不动、头部完整；脚底在帧底的帧（含 `lifted`、`hatch`）不动，普通帧之间 1–2 px 的差不跟，不会抖。全身绘制不受影响。画布上 `data-lift` 是这一帧上移的像素数，`data-crop` 仍是站姿帧的裁切框。
7. **交互**：
   - **触摸区**：sprite 画布上带 `data-framing="half"` 和 `data-cut`（= 腰线比例），`artPoint` 和 VRM / Live2D 同一条路径：读画布上已经裁好的画面得到可见包围盒，用 `toFullBody` 把 y 乘以 `cut` 换回全身比例。头、脸、胸、手、肚子照常命中，**腿和脚在半身下点不到**。alpha 缓存键 `data-frame` 加上了取景和裁切（`…#row:col@half:sx,sy,sw`），切换后不会继续用全身的像素。
   - **拎起 / 走路 / 说话 / 睡觉**：都只是换动作帧，裁切框不变；`lifted` 帧里她画得矮一些，半身时在画面里低约 4–9%，头和躯干完整；拎起的摆动（`.pet-body.lifted`）是整个形象一起摆，和取景无关。
   - 卡片、衣柜、孵化页的小图不挂 `setFraming`，一直全身。
8. **调试字段**：sprite 画布 `data-framing`、`data-cut`、`data-band`（`pack` / `default`）、`data-crop`（`sx,sy,sw,sh`，帧内像素）、`data-frame`；`window.petFx.sprite()` 给出 `framing`、`band`、`waist`、`cut`、`ref`、`crop`、`canvas`、`gliding`、`pixelated`。

已知取舍：`hatch#0`（蹲下）半身时只露出发顶，下一帧才“冒出来”（不为它单独换裁切框，避免跳动）；少数举手 / 举物 / 气泡帧顶端被裁掉几十像素的装饰；左右会裁掉张开的手臂和长发；素材本身的大小不一致（如 dafeiyu-pixel bikini 的 `idle#1` 画大了、头顶比站姿高约 120 px，半身下发顶会出框；整帧上浮的帧已由 `spriteLift` 处理）放大后更明显；classic Q 版的腰线（0.66–0.72）落在默认触摸区表的“腿”上沿（触摸区表按 HD 包测量，全身时同样如此）。

## 如何复现

```bash
npm ci
npm test                                   # 含 test/framing.test.js（设置默认值 / 迁移 / 覆盖、取景纯函数、PetService）
npm run build:admin
xvfb-run -a node e2e/run.js vrmframe       # VRM 半身端到端（勿跑 all）
xvfb-run -a node e2e/run.js live2dframe    # Live2D 半身端到端
xvfb-run -a node e2e/run.js spriteframe    # 像素 sprites 半身端到端
```

`spriteframe` 场景（`e2e/sprite-frame.js`）：穿「克洛蒂 · 像素」→ 全身截图 → 设置窗口 → 桌宠行为 → 取景点「半身」→ 桌宠窗口即时半身（检查：窗口不变、同一个画布元素、`data-framing=half`、`data-cut=0.520`、`data-band=pack`、腰线在画布底边、头在上方、裁切框单调滑动）→ 半身下点头部 / 胸口命中、腿 / 脚点不到，拎起、走路、说话 → 切回「全身」（画面和切换前逐像素一致）→ 换「克洛蒂 · 旧版像素」看整数倍像素块 → 角色页单独设「全身」再改回“跟随” → 重启应用，半身保留；再以「大肥鱼 · 像素」（第二个 HD 包）走同样三条取景来源：全局半身、角色页单独半身、`userData/packs` 里一个 `pack.json` 写 `"framing": "half"` 的像素包（全局全身、无角色选择时 `source: pack`，角色页「全身」优先于它），半身下 idle 两帧（含上浮的 `idle#1`）/ pat / lifted / talk 的裁切、头 / 身体点击、图片包与全动态（rig）包在全局半身下保持全身、切回全身逐像素一致、重启保持（截图在 `out/e2e/sprite-frame/dafeiyu/`）。截图在 `out/e2e/sprite-frame/`，逐步记录在 `out/e2e/sprite-frame/evidence.txt`。

`vrmframe` 场景：用 `scripts/make-test-vrm.js` 现做一个测试 VRM（写在临时目录，不进仓库）→ 全身截图 → 打开设置窗口 → 桌宠行为 → 取景点「半身」→ 桌宠窗口即时变成半身（检查：窗口位置尺寸不变、腰线在底边、头在上方、水平居中、角色更大、模型没有重建、相机单调滑动）→ 半身下视线跟随、触摸区映射（腿 / 脚点不到）、点击反应、拖起、口型 → 切回「全身」（相机与最初完全一致）→ 角色页单独设「半身」再改回“跟随” → 真实 VRM 各拍一组全身 / 半身 → 重启应用，半身保留；再以「大肥鱼 · 像素」（第二个 HD 包）走同样三条取景来源：全局半身、角色页单独半身、`userData/packs` 里一个 `pack.json` 写 `"framing": "half"` 的像素包（全局全身、无角色选择时 `source: pack`，角色页「全身」优先于它），半身下 idle 两帧（含上浮的 `idle#1`）/ pat / lifted / talk 的裁切、头 / 身体点击、图片包与全动态（rig）包在全局半身下保持全身、切回全身逐像素一致、重启保持（截图在 `out/e2e/sprite-frame/dafeiyu/`）。截图在 `out/e2e/vrm/frame-*.png`，逐步记录在 `out/e2e/vrm/frame-evidence.txt`。

真实模型：仓库里没有可再分发的 VRM。`vrmframe` 默认找本机的 `~/art-archive/vrm-test/extracted/model.vrm`（木子惡魔《蓝色小肥鱼Deepseek》，VRM 1.0，禁止再分发，仅本机测试）和 `~/art-archive/airi-vrm-test/AvatarSample_A.vrm`（VRoid 示例，VRM 0.x）；也可以用 `PIXELPET_E2E_REAL_VRM=/path/a.vrm:/path/b.vrm` 指定（必须在仓库外）。没有就跳过这一步。

`live2dframe` 场景（`e2e/live2d-frame.js`）：内置「大肥鱼 · Live2D」→ 全身截图 → 设置窗口 → 桌宠行为 → 取景点「半身」→ 桌宠窗口即时半身（检查：窗口不变、腰线在底边、头在上方、居中、画得更大、同一个画布、缩放单调滑动、`data-band=pack`、`data-cut=0.520`）→ 半身下眨眼 / 说话口型 / 开心脸红 / 难过脸黑、视线跟随（左 / 右 / 上）、触摸区映射（腿 / 脚点不到）并真的点头部、拖起、走路、气泡在眼睛上方 → 切回「全身」（摆放与最初完全一致）→ 角色页单独设「半身」再改回“跟随” → 用“导入 Live2D 模型…”导入一个没有 `pack.json` 的模型文件夹，半身走眼睛推断 → 同一设置下换成自制 VRM，也是半身 → 重启应用，半身保留。截图和 GIF 在 `out/e2e/live2d-frame/`，逐步记录在 `out/e2e/live2d-frame/evidence.txt`。

手动试：`npm start` → 设置窗口 → 角色 → 她的详情 → 形象包 → 导入 VRM…（或大肥鱼的「大肥鱼 · Live2D」）→ 点新卡片的「穿上」→ 玩法 → 桌宠行为 → 取景 → 半身。从干净克隆开始的完整步骤见 [usage.md 第十、十一节](usage.md#十一半身模式vrm--live2d)。

## 已知问题 / 后续

- canary 上 VRM **0.x** 模型的手臂静止姿势方向反了（举着手），这是 PR #99（VRM 独立交互体系）在修的既有问题，与取景无关；半身取景量头顶时已排除手臂，所以构图不受影响，但举起的手会出画。
- 没有做自由的缩放 / 偏移微调（见“不采纳的”）；每个包的腰线可以用 `pack.json` 的 `halfBody.waist` 调。
- Live2D 半身时画面左右会裁掉一点张开的手臂和长发（按头和腰线定大小，不为了放下整个宽度而缩小）。
- 触摸区的 x 方向沿用全身比例：半身时画面里可见部分的左右范围（手臂、头发）和全身时不同，左右边缘的部位判断会有少许偏差（VRM 同样如此）。
- 导入的大肥鱼 Live2D 副本没有内置包的 `pinned`，所以会露出模型自带的授权水印图层——这是导入模型的既有行为，按 pet-packs.md 手动加 `pinned` 即可，与取景无关。
