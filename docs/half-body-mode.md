# 半身模式（取景：全身 / 半身）

> 初稿 · VRM 部分。Live2D 的半身取景由单独的任务跟进，用的是同一个设置（见“设置”）。

桌宠默认从头到脚显示（**全身**）。**半身**只显示腰部以上：同一个窗口里角色画得更大，头部和上半身居中，腰部正好落在窗口底边。适合把桌宠放在屏幕角落里聊天、看口型和表情。

## 参考 Airi

读的是 [moeru-ai/airi](https://github.com/moeru-ai/airi)（2026-11-02 的 `main`，提交 `33b12e9`）。VRM 场景在 `packages/stage-ui-three`，Live2D 场景在 `packages/stage-ui-live2d`，两者共用的控制条在 `packages/stage-ui/src/components/scenes/ViewControlSlider.vue`。

**Airi 怎么算 VRM 的相机**（`stage-ui-three/src/components/Model/VRMModel.vue` → `buildSceneBootstrap`）：

- 先算**整个模型的包围盒**（`computeBoundingBox`：遍历可见 mesh，跳过 `VRMC_springBone_collider`），得到 `modelSize`、`modelCenter`。
- 把中心抬高 `modelSize.y / 5`，相机放在 `modelCenter + (size.x/16, size.y/8, −(size.y/3)/tan(fov/2))`，也就是让画面竖向大约装下模型高度的 2/3、偏上，默认 FOV 40°（`stores/camera.ts`）。效果是一个“膝盖以上”的固定构图。
- 人形骨骼只用到 **head**：`getEyePosition` 取 head 骨骼的世界高度作为 `eyeHeight`（视线默认目标）；`headAnchor()` 按“头约占身高 1/14”在 head 骨骼上方放一个锚点给气泡用。neck / chest / hips **没有**参与取景。
- **用户调整**：`stores/view-control.ts` 提供 `x / y / z`（模型偏移，±10 m）、`cameraDistance`（0–10 m）、`cameraFOV`（10–120°）五个滑杆，存在 `localStorage`；桌面版还开了 OrbitControls（拖动旋转 / 滚轮缩放，目标是模型中心）。切换模型时（`ThreeScene.vue`）保留用户调过的相机方向和距离，只把原点换到新模型的中心。
- **Live2D**（`stage-ui-live2d/src/stores/view-control.ts`）：只有 `position.x / y`（相对画面中心的百分比，±500）和 `scale`，同样存 `localStorage`，没有“半身”概念，靠用户自己放大、下移。

**我们采纳的**

- 相机距离按竖直视野反推：`dist = visible / 2 / tan(fov/2)`，只改相机、不缩放模型，所以 SpringBone、视线、口型都不受影响。
- 用 head 骨骼定位头部；把骨骼当作稳定的比例参考（Airi 用它放视线和气泡锚点，我们也用它定头顶和腰线）。
- 切换模型 / 模式时不重建场景，只移动相机（Airi 换模型保留相机方向；我们切取景时相机在 0.35 s 内平滑过去）。

**不采纳的**

- **不用整模包围盒定构图**：桌宠模型常有长发、尾巴、裙摆、举起的手（VRM 0.x 在 canary 上还会举着手，见“已知问题”），包围盒一变构图就跳。我们的半身取景只看骨骼：头顶取“跟着 head 骨骼及其子骨骼动的顶点”的最高点，腰线 = hips 骨骼上方 12% 躯干长度（躯干 = head − hips），左右以 head–hips 连线居中。
- **不开放 x/y/z/距离/FOV 五个自由滑杆，也不开轨道相机**：桌宠窗口很小、透明、能拖动，自由相机很容易把人“调丢”。我们只给一个二选一（全身 / 半身）加已有的“宠物大小”（`petScale`，窗口右下角不动）。需要特殊构图的模型，由形象包在 `pack.json` 里带默认取景。
- 不把设置放 `localStorage`：取景写进 `settings.json`，设置窗口和桌宠窗口共用、重启保留，并且能按角色覆盖。

## 设置

| 位置 | key | 取值 | 说明 |
| --- | --- | --- | --- |
| 设置窗口 → 玩法 → 桌宠行为 → **大小与取景** → 取景 | `prefs.framing` | `full`（默认）/ `half` | 全局默认。改动立即生效。 |
| 设置窗口 → 角色 → 她的页 → 形象包 → **取景** | `framings.<角色 id>` | 跟随 / `full` / `half` | 只对这一位角色生效；“跟随”= 删除这一项。 |
| 形象包 `pack.json` | `framing` | `full` / `half`（可选） | 这个包的默认取景，例如只有上半身的模型写 `"framing": "half"`。 |

优先级：**角色自己的选择 > 形象包默认 > 全局设置**（`src/core/framing.js` → `resolveFraming`）。

- 迁移：旧的 `settings.json` 没有 `prefs.framing`，读成 `full`，看起来和以前一样；非法值也读成 `full`。`framings` 只保留合法角色 id 和 `full`/`half`。
- 目前只有 **VRM** 形象包会真的换取景（相机）；像素 / 图片 / 全动态包保持全身（设置窗口里会提示）。
- 写入路径：设置窗口 `admin-set prefs.framing` → `PetService.setPrefs` → `settings.json` → `settings` 广播；按角色是 `set-framing` → `PetService.setFraming`。桌宠窗口收到新设置后调用 VRM 形象的 `setFraming()`，**不重新加载模型**。

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

## 如何复现

```bash
npm ci
npm test                                   # 含 test/framing.test.js（设置默认值 / 迁移 / 覆盖、取景纯函数、PetService）
npm run build:admin
xvfb-run -a node e2e/run.js vrmframe       # 半身模式端到端（勿跑 all）
```

`vrmframe` 场景：用 `scripts/make-test-vrm.js` 现做一个测试 VRM（写在临时目录，不进仓库）→ 全身截图 → 打开设置窗口 → 桌宠行为 → 取景点「半身」→ 桌宠窗口即时变成半身（检查：窗口位置尺寸不变、腰线在底边、头在上方、水平居中、角色更大、模型没有重建、相机单调滑动）→ 半身下视线跟随、触摸区映射（腿 / 脚点不到）、点击反应、拖起、口型 → 切回「全身」（相机与最初完全一致）→ 角色页单独设「半身」再改回“跟随” → 真实 VRM 各拍一组全身 / 半身 → 重启应用，半身保留。截图在 `out/e2e/vrm/frame-*.png`，逐步记录在 `out/e2e/vrm/frame-evidence.txt`。

真实模型：仓库里没有可再分发的 VRM。`vrmframe` 默认找本机的 `~/art-archive/vrm-test/extracted/model.vrm`（木子惡魔《蓝色小肥鱼Deepseek》，VRM 1.0，禁止再分发，仅本机测试）和 `~/art-archive/airi-vrm-test/AvatarSample_A.vrm`（VRoid 示例，VRM 0.x）；也可以用 `PIXELPET_E2E_REAL_VRM=/path/a.vrm:/path/b.vrm` 指定（必须在仓库外）。没有就跳过这一步。

手动试：`npm start` → 导入一个 VRM（她的页 → 形象包 → 导入 VRM…）→ 设置窗口 → 玩法 → 桌宠行为 → 取景 → 半身。

## 已知问题 / 后续

- canary 上 VRM **0.x** 模型的手臂静止姿势方向反了（举着手），这是 PR #99（VRM 独立交互体系）在修的既有问题，与取景无关；半身取景量头顶时已排除手臂，所以构图不受影响，但举起的手会出画。
- Live2D 的半身取景：同一个 `prefs.framing` / `framings` / `pack.json framing`，由 Live2D 任务实现（`resolveFraming` 的 `SUPPORTED_KINDS` 加上 `live2d`）。
- 没有做自由的缩放 / 偏移微调（见“不采纳的”）；如果确有需要，可以在 `pack.json` 里加每个包的半身腰线比例。
